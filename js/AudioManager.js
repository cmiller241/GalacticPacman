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

class AudioManager {
  static new() {
    return new AudioManager();
  }

  constructor() {
    this.eatDotIndex = 0;

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

    const allSources = [
      this.eatDotAudio0, this.eatDotAudio1, this.deathAudio, this.jumpAudio,
      this.jumpSmallAudio, this.bangLarge, this.bangMedium, this.bangSmall,
      this.goombaStompAudio, this.fireballAudio, this.groundPoundAudio,
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

  playDeath() { cloneAndPlay(this.deathAudio); }
  playJump() { cloneAndPlay(this.jumpAudio); }
  playJumpSmall() { cloneAndPlay(this.jumpSmallAudio); }
  playGoombaStomp() { cloneAndPlay(this.goombaStompAudio); }
  playFireball() { cloneAndPlay(this.fireballAudio); }

  // The slam of a ground pound landing (see Player.js's own ground-pound
  // bookkeeping in Player.update).
  playGroundPound() { cloneAndPlay(this.groundPoundAudio); }

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

  reset() {
    this.eatDotIndex = 0;
  }
}

export default AudioManager;
