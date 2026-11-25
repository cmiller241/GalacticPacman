// js/AudioManager.js
//
// Sound effects through the Web Audio API. Each sound is fetched and
// decoded ONCE at startup; playing one just starts that already-decoded
// buffer. (The old version cloned an <audio> element for every sound —
// every coin eaten made a new media element that the browser had to load
// and decode on the main thread, which caused hitches on phones.)
//
// Phones only allow sound after the player touches the page, so unlock()
// is called on the first tap/key (see game.js).

import { state } from './state.js';

const SOUNDS = {
  eatDot0: 'sounds/eat_dot_0.wav',
  eatDot1: 'sounds/eat_dot_1.wav',
  death: 'sounds/death_0.wav',
  jump: 'sounds/jump.wav',
  jumpSmall: 'sounds/jumpsmall.wav',
  bangLarge: 'sounds/bangLarge.wav',
  bangMedium: 'sounds/bangMedium.wav',
  bangSmall: 'sounds/bangSmall.wav',
};
const VOLUME = 0.5;
// How long after asking audio to switch on (ms) a sound may still be
// queued for when it does.
const RESUME_GRACE_MS = 400;

export class AudioManager {
  constructor() {
    this.eatDotIndex = 0;
    this.buffers = {};
    const Ctx = window.AudioContext || window.webkitAudioContext;
    // ('interactive': the shortest delay between play() and hearing it.)
    this.context = Ctx ? new Ctx({ latencyHint: 'interactive' }) : null;
    if (!this.context) return;
    this.output = this.context.createGain();
    this.output.gain.value = VOLUME;
    this.output.connect(this.context.destination);
    for (const [name, url] of Object.entries(SOUNDS)) this.load(name, url);
  }

  async load(name, url) {
    try {
      const data = await (await fetch(url)).arrayBuffer();
      // (The callback form works on older Safari too.)
      this.buffers[name] = await new Promise((resolve, reject) =>
        this.context.decodeAudioData(data, resolve, reject));
    } catch (e) {
      console.warn(`Couldn't load sound ${url}:`, e);
    }
  }

  // Call from a touch/click/key handler, BEFORE the game reacts to it (see
  // game.js): browsers keep audio switched off until the player touches
  // the page, and phones switch it off again after an interruption (app
  // switch, screen lock, a call). Switching it back on takes a moment.
  unlock() {
    const ctx = this.context;
    if (!ctx || ctx.state === 'running') return;
    ctx.resume().catch(() => {});
    this.resumeRequestedAt = performance.now();
    // Older iPhones only truly unlock once something actually plays during
    // the touch: a single silent sample does it.
    if (!this.unlockedOnce) {
      this.unlockedOnce = true;
      const silent = ctx.createBufferSource();
      silent.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      silent.connect(ctx.destination);
      silent.start();
    }
  }

  play(name, volume = 1) {
    const ctx = this.context, buffer = this.buffers[name];
    if (!ctx || !buffer) return;
    // While audio is still switching on from the touch that caused this
    // sound, queue it: it plays the moment audio is on. (Otherwise the
    // jump that unlocked the audio would itself be silent.) Sounds asked
    // for while audio is simply off are dropped, not saved up to all blare
    // out at once later.
    if (ctx.state !== 'running' && !(performance.now() - (this.resumeRequestedAt ?? -1e9) < RESUME_GRACE_MS)) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    if (volume >= 1) {
      source.connect(this.output);
    } else {
      const gain = ctx.createGain();
      gain.gain.value = volume;
      source.connect(gain).connect(this.output);
    }
    source.start();
  }

  playEatDot() {
    this.play(this.eatDotIndex === 0 ? 'eatDot0' : 'eatDot1');
    this.eatDotIndex = 1 - this.eatDotIndex; // alternate the two
  }

  playDeath() { this.play('death'); }
  playJump() { this.play('jump'); }
  playJumpSmall() { this.play('jumpSmall'); }

  playBang(size, position) {
    const name = size === 'large' ? 'bangLarge' : size === 'medium' ? 'bangMedium' : size === 'small' ? 'bangSmall' : null;
    if (!name) return;
    const dx = state.player.pos.x - position.x, dy = state.player.pos.y - position.y;
    const vol = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / 800); // fades out over 800 units
    if (vol > 0) this.play(name, vol);
  }

  reset() {
    this.eatDotIndex = 0;
  }
}
