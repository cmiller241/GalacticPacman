// js/love/audio.js
//
// love.audio on top of WebAudio. Sounds are decoded up front (see
// love/index.js's preloading), so newSource() is synchronous like LÖVE's.
// Browsers keep audio suspended until the first click/key press; the
// context is resumed on the first input event.

let ctx = null;
let master = null;
let bufferLookup = null;
const playing = new Set();

function getContext() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.connect(ctx.destination);
  }
  return ctx;
}

class Source {
  constructor(buffer, type = 'static') {
    this.buffer = buffer;
    this.sourceType = type;
    this.volume = 1;
    this.pitch = 1;
    this.looping = false;
    this.node = null;
    this.gain = null;
    this.startedAt = 0;
    this.offset = 0;
    this.paused = false;
  }
  type() { return 'Source'; }
  clone() {
    const s = new Source(this.buffer, this.sourceType);
    s.volume = this.volume; s.pitch = this.pitch; s.looping = this.looping;
    return s;
  }
  play() {
    if (this.isPlaying()) return true;
    if (!this.buffer) return false;
    const c = getContext();
    const node = c.createBufferSource();
    node.buffer = this.buffer;
    node.loop = this.looping;
    node.playbackRate.value = this.pitch;
    const gain = c.createGain();
    gain.gain.value = this.volume;
    node.connect(gain);
    gain.connect(master);
    node.onended = () => {
      if (this.node === node) {
        this.node = null;
        if (!this.paused) this.offset = 0;
        playing.delete(this);
      }
    };
    node.start(0, this.offset % this.buffer.duration);
    this.startedAt = c.currentTime - this.offset / this.pitch;
    this.node = node;
    this.gain = gain;
    this.paused = false;
    playing.add(this);
    return true;
  }
  stop() {
    this.paused = false;
    this.offset = 0;
    if (this.node) {
      const n = this.node;
      this.node = null;
      try { n.stop(); } catch (e) { /* already stopped */ }
    }
    playing.delete(this);
  }
  pause() {
    if (!this.node) return;
    this.offset = this.tell();
    this.paused = true;
    const n = this.node;
    this.node = null;
    try { n.stop(); } catch (e) { /* ignore */ }
    playing.delete(this);
  }
  isPlaying() { return !!this.node; }
  tell() {
    if (!this.node) return this.offset;
    const t = (getContext().currentTime - this.startedAt) * this.pitch;
    return this.looping ? t % this.buffer.duration : Math.min(t, this.buffer.duration);
  }
  seek(t) {
    const was = this.isPlaying();
    if (was) { this.stop(); }
    this.offset = t;
    if (was) this.play();
  }
  setVolume(v) { this.volume = v; if (this.gain) this.gain.gain.value = v; }
  getVolume() { return this.volume; }
  setPitch(p) { this.pitch = p; if (this.node) this.node.playbackRate.value = p; }
  getPitch() { return this.pitch; }
  setLooping(l) { this.looping = !!l; if (this.node) this.node.loop = this.looping; }
  isLooping() { return this.looping; }
  getDuration() { return this.buffer ? this.buffer.duration : 0; }
}

const audio = {
  newSource(path, type) {
    const buf = bufferLookup && bufferLookup(path);
    if (!buf) console.warn(`love.audio.newSource: "${path}" was not preloaded`);
    return new Source(buf || null, type);
  },
  setVolume(v) { getContext(); master.gain.value = v; },
  getVolume() { getContext(); return master.gain.value; },
  stop(source) {
    if (source) { source.stop(); return; }
    for (const s of [...playing]) s.stop();
  },
  pause(source) {
    if (source) { source.pause(); return [source]; }
    const list = [...playing];
    for (const s of list) s.pause();
    return list;
  },
  play(sources) {
    if (Array.isArray(sources)) { for (const s of sources) s.play(); return; }
    if (sources) sources.play();
  },
  getActiveSourceCount() { return playing.size; },
  _context: getContext,
  _setBufferLookup(fn) { bufferLookup = fn; },
  _resume() { const c = getContext(); if (c.state === 'suspended') c.resume(); },
};

export default audio;
