// js/AudioManager.js
//
// Every sound effect in the game. Each play* method clones its source
// and plays the clone, so the same sound can overlap itself.

import love from './love/index.js';
import state from './state.js';

// Clone this source and play it.
function cloneAndPlay(source) {
  const instance = source.clone();
  const started = instance.play();
  if (!started) console.log('Audio play failed for a cloned source');
  return instance;
}

// Background music, by name. Each file is a seamless loop exported from
// the composer (composer/README.md). volume: loudness at full fade-in.
const MUSIC = {
  skyDome: { path: 'sounds/music/let-all-exalt-navarre-hyperdrive-loop.ogg', volume: 0.45 },
  belt: { path: 'sounds/music/wake-awake-2-battle-march-loop.ogg', volume: 0.45 },
};
const MUSIC_FADE_SECONDS = 1.5;  // how long a fade in/out takes
const MUSIC_SWITCH_DELAY = 0.75; // a new choice has to hold this long before the music changes

// The water blaster's hiss (see updateSpray): a seamless loop.
const SPRAY_PATH = 'sounds/water-spray.wav';
const SPRAY_VOLUME = 0.35;          // while spraying
const SPRAY_SPUTTER_VOLUME = 0.12;  // at the water cap, when it only dribbles
const SPRAY_SPUTTER_PITCH = 0.85;
const SPRAY_FADE_IN = 0.05;         // seconds to full volume
const SPRAY_FADE_OUT = 0.18;        // seconds to silence after letting go

class AudioManager {
  static new() {
    return new AudioManager();
  }

  constructor() {
    this.eatDotIndex = 0;

    this.music = {};
    for (const [name, info] of Object.entries(MUSIC)) {
      const source = love.audio.newSource(info.path, 'stream');
      source.setLooping(true);
      source.setVolume(0);
      this.music[name] = { source, volume: info.volume, level: 0 };
    }
    this.musicWanted = null;  // the track that should be playing (null = none)
    this.musicPending = null; // a different track asked for, not yet held long enough
    this.musicPendingTime = 0;

    this.eatDotAudio0 = love.audio.newSource('sounds/eat_dot_0.wav', 'static');
    this.eatDotAudio1 = love.audio.newSource('sounds/eat_dot_1.wav', 'static');
    this.deathAudio = love.audio.newSource('sounds/death_0.wav', 'static');
    this.jumpAudio = love.audio.newSource('sounds/jump.wav', 'static');
    this.jumpSmallAudio = love.audio.newSource('sounds/jumpsmall.wav', 'static');
    this.bangLarge = love.audio.newSource('sounds/bangLarge.wav', 'static');
    this.bangMedium = love.audio.newSource('sounds/bangMedium.wav', 'static');
    this.bangSmall = love.audio.newSource('sounds/bangSmall.wav', 'static');
    this.goombaStompAudio = love.audio.newSource('sounds/mario-goomba-stomp.mp3', 'static');
    this.fireballAudio = love.audio.newSource('sounds/mario-fireball.mp3', 'static');
    this.groundPoundAudio = love.audio.newSource('sounds/groundpound.wav', 'static');
    // Curling into a ball and back (made by tools/gen-morph-sounds.mjs).
    this.morphBallAudio = love.audio.newSource('sounds/morph-ball.wav', 'static');
    this.morphUnballAudio = love.audio.newSource('sounds/morph-unball.wav', 'static');

    this.sprayAudio = love.audio.newSource(SPRAY_PATH, 'static');
    this.sprayAudio.setLooping(true);
    this.sprayAudio.setVolume(0);
    this.sprayLevel = 0; // current loudness, eased toward the target

    const allSources = [
      this.eatDotAudio0, this.eatDotAudio1, this.deathAudio, this.jumpAudio,
      this.jumpSmallAudio, this.bangLarge, this.bangMedium, this.bangSmall,
      this.goombaStompAudio, this.fireballAudio, this.groundPoundAudio,
      this.morphBallAudio, this.morphUnballAudio,
    ];
    for (const source of allSources) source.setVolume(0.5);

    // Played 30% faster than recorded. Speeding a sound up this way
    // raises its pitch along with it, so it also sounds about four and
    // a half semitones higher.
    this.groundPoundAudio.setPitch(1.3);
  }

  playEatDot() {
    const source = this.eatDotIndex === 0 ? this.eatDotAudio0 : this.eatDotAudio1;
    this.eatDotIndex = 1 - this.eatDotIndex; // toggles between 0 and 1
    cloneAndPlay(source);
  }

  // Call every frame: the water blaster's hiss, looping while Bob sprays
  // (see WaterSystem.isSpraying) and fading out when he stops. sputtering:
  // he's at the water cap, so it's only a dribble — quieter and lower.
  updateSpray(spraying, sputtering, dt) {
    let target = 0;
    if (spraying) target = sputtering ? SPRAY_SPUTTER_VOLUME : SPRAY_VOLUME;
    if (this.sprayLevel < target) {
      this.sprayLevel = Math.min(target, this.sprayLevel + SPRAY_VOLUME * dt / SPRAY_FADE_IN);
    } else if (this.sprayLevel > target) {
      this.sprayLevel = Math.max(target, this.sprayLevel - SPRAY_VOLUME * dt / SPRAY_FADE_OUT);
    }
    const source = this.sprayAudio;
    if (this.sprayLevel > 0) {
      source.setVolume(this.sprayLevel);
      source.setPitch(sputtering ? SPRAY_SPUTTER_PITCH : 1);
      if (!source.isPlaying()) source.play();
    } else if (source.isPlaying()) {
      source.stop();
    }
  }

  playDeath() { cloneAndPlay(this.deathAudio); }
  playJump() { cloneAndPlay(this.jumpAudio); }
  playJumpSmall() { cloneAndPlay(this.jumpSmallAudio); }
  playGoombaStomp() { cloneAndPlay(this.goombaStompAudio); }
  playFireball() { cloneAndPlay(this.fireballAudio); }

  // The slam of a ground pound landing (see Player.js's own ground-pound
  // bookkeeping in Player.update).
  playGroundPound() { cloneAndPlay(this.groundPoundAudio); }

  // Curling into a ball, and standing back up (Player.enterBallMode /
  // exitBallMode).
  playMorphBall() { cloneAndPlay(this.morphBallAudio); }
  playMorphUnball() { cloneAndPlay(this.morphUnballAudio); }

  playBang(size, position) {
    let audioSource;
    if (size === 'large') audioSource = this.bangLarge;
    else if (size === 'medium') audioSource = this.bangMedium;
    else if (size === 'small') audioSource = this.bangSmall;
    else return;

    // subtract() returns a NEW Vector2 — it doesn't touch the player's position.
    const dist = state.player.pos.subtract(position).length();
    const vol = 0.5 * Math.max(0, 1 - dist / 800); // fades out over 800 units
    if (vol <= 0) return;

    const instance = audioSource.clone();
    instance.setVolume(vol);
    const started = instance.play();
    if (!started) console.log('Audio play failed for playBang');
  }

  // Call every frame with the name of the music that should be playing
  // (a key of MUSIC above, or null for none). Tracks fade in and out
  // rather than cutting, and a change only happens once it's been asked
  // for steadily for MUSIC_SWITCH_DELAY.
  updateMusic(name, dt) {
    name = name ?? null;
    if (name === this.musicWanted) {
      this.musicPending = null;
      this.musicPendingTime = 0;
    } else {
      if (name !== this.musicPending) {
        this.musicPending = name;
        this.musicPendingTime = 0;
      }
      this.musicPendingTime += dt;
      if (this.musicPendingTime >= MUSIC_SWITCH_DELAY) {
        this.musicWanted = name;
        this.musicPending = null;
        this.musicPendingTime = 0;
      }
    }

    const step = dt / MUSIC_FADE_SECONDS;
    for (const [trackName, m] of Object.entries(this.music)) {
      const target = trackName === this.musicWanted ? 1 : 0;
      if (m.level < target) m.level = Math.min(target, m.level + step);
      else if (m.level > target) m.level = Math.max(target, m.level - step);
      const playing = m.source.isPlaying();
      if (target === 1 && !playing) m.source.play();
      else if (target === 0 && !playing) m.level = 0; // already stopped (e.g. EXIT TO TITLE)
      if (m.level > 0) m.source.setVolume(m.volume * m.level);
      else if (playing) m.source.stop(); // fully faded out: next time it starts from the top
    }
  }

  reset() {
    this.eatDotIndex = 0;
  }
}

export default AudioManager;
