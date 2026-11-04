'use strict';
// Synthesized instruments. Everything is generated with Web Audio oscillators and noise,
// so there are no sample files and no licensing to worry about.
//
// Each instrument's play(v, f, dur, vel, p) builds its sound into Voice `v` (whose output is v.amp)
// and returns the time when the sound has fully stopped.
const Instruments = (() => {
  const noiseCache = new WeakMap();
  const pulseCache = new WeakMap();

  function noiseBuffer(ctx) {
    let b = noiseCache.get(ctx);
    if (!b) {
      const len = ctx.sampleRate * 2;
      b = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = b.getChannelData(0);
      let seed = 1234567;
      for (let i = 0; i < len; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        d[i] = seed / 0x3fffffff - 1;
      }
      noiseCache.set(ctx, b);
    }
    return b;
  }

  // 25% pulse wave, the classic chiptune sound.
  function pulseWave(ctx) {
    let w = pulseCache.get(ctx);
    if (!w) {
      const N = 48, duty = 0.25;
      const real = new Float32Array(N), imag = new Float32Array(N);
      for (let n = 1; n < N; n++) real[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty);
      w = ctx.createPeriodicWave(real, imag);
      pulseCache.set(ctx, w);
    }
    return w;
  }

  // Filter settings that change over time are normally recalculated every sample, which is expensive.
  // Updating them once per 128-sample block sounds the same and costs far less.
  function kRate(filter) {
    for (const p of [filter.frequency, filter.detune, filter.Q]) {
      try { p.automationRate = 'k-rate'; } catch (e) { /* older browsers */ }
    }
  }

  class Voice {
    constructor(ctx, out, t) {
      this.ctx = ctx;
      this.t = t;
      this.sources = [];
      this.nodes = [];
      this.amp = ctx.createGain();
      this.amp.gain.value = 0;
      this.amp.connect(out);
    }
    osc(type, f, detune = 0) {
      const o = this.ctx.createOscillator();
      if (type === 'pulse') o.setPeriodicWave(pulseWave(this.ctx));
      else o.type = type;
      o.frequency.setValueAtTime(f, this.t);
      if (detune) o.detune.setValueAtTime(detune, this.t);
      o.start(this.t);
      this.sources.push(o);
      this.nodes.push(o);
      return o;
    }
    noise() {
      const s = this.ctx.createBufferSource();
      s.buffer = noiseBuffer(this.ctx);
      s.loop = true;
      s.start(this.t, (this.t * 7.31) % 1.5);
      this.sources.push(s);
      this.nodes.push(s);
      return s;
    }
    gain(v) {
      const g = this.ctx.createGain();
      g.gain.value = v;
      this.nodes.push(g);
      return g;
    }
    filter(type, f, q = 0.7) {
      const b = this.ctx.createBiquadFilter();
      b.type = type;
      b.frequency.setValueAtTime(f, this.t);
      b.Q.value = q;
      kRate(b);
      this.nodes.push(b);
      return b;
    }
    // Wobble the given AudioParams (usually oscillator detune, in cents).
    lfo(rate, depth, targets, delay = 0) {
      const l = this.osc('sine', rate);
      const g = this.ctx.createGain();
      this.nodes.push(g);
      if (delay > 0) {
        g.gain.setValueAtTime(0, this.t);
        g.gain.linearRampToValueAtTime(depth, this.t + delay);
      } else g.gain.value = depth;
      l.connect(g);
      for (const t of targets) g.connect(t);
      return l;
    }
    // Attack / decay / sustain / release on the voice volume. Returns stop time.
    adsr(dur, peak, a, d, s, r) {
      const g = this.amp.gain, t = this.t;
      g.setValueAtTime(0, t);
      g.linearRampToValueAtTime(peak, t + a);
      g.setTargetAtTime(peak * s, t + a, Math.max(d, 0.001) / 3);
      const rel = t + Math.max(dur, a);
      g.setTargetAtTime(0, rel, Math.max(r, 0.005) / 3);
      return this.end(rel + r * 1.6 + 0.05);
    }
    // Percussive hit: instant attack then exponential-ish decay.
    perc(param, peak, tau, at = this.t, attack = 0.002) {
      param.setValueAtTime(0, at);
      param.linearRampToValueAtTime(peak, at + attack);
      param.setTargetAtTime(0, at + attack, tau);
    }
    // Stop every source at `time`, then unplug the whole voice so the browser stops processing it.
    end(time) {
      for (const s of this.sources) s.stop(time);
      const last = this.sources[0];
      if (last) {
        last.onended = () => {
          this.amp.disconnect();
          for (const n of this.nodes) n.disconnect();
          this.nodes = this.sources = null;
        };
      }
      return time;
    }
  }

  const vol = vel => 0.3 + 0.7 * vel;

  const list = [];
  function def(id, name, icon, category, play, extra = {}) {
    list.push(Object.assign({ id, name, icon, category, play }, extra));
  }

  // ---------------- melodic instruments ----------------

  // One oscillator playing a pre-built "pipe organ" waveform (organ stops at 16', 8', 4', 2 2/3', 2', 1 1/3', 1').
  // Same sound as stacking seven sine waves, at a fraction of the CPU cost.
  const organCache = new WeakMap();
  function organWave(ctx) {
    let w = organCache.get(ctx);
    if (!w) {
      // Fundamental is an octave below the note, so the 16' stop is harmonic 1.
      const real = new Float32Array(17), imag = new Float32Array(17);
      for (const [h, a] of [[1, 0.35], [2, 1], [4, 0.55], [6, 0.3], [8, 0.25], [12, 0.12], [16, 0.1]]) imag[h] = a;
      w = ctx.createPeriodicWave(real, imag, { disableNormalization: true });
      organCache.set(ctx, w);
    }
    return w;
  }

  def('organ', 'Church Organ', '⛪', 'Classic', (v, f, dur, vel) => {
    const o = v.osc('sine', f / 2);
    o.setPeriodicWave(organWave(v.ctx));
    v.lfo(5.8, 5, [o.detune]);
    o.connect(v.amp);
    return v.adsr(dur, 0.1 * vol(vel), 0.03, 0.2, 0.9, 0.12);
  });

  def('epiano', 'Star Piano', '🎹', 'Classic', (v, f, dur, vel) => {
    const car = v.osc('sine', f);
    const mod = v.osc('sine', f);
    const idx = v.gain(0);
    idx.gain.setValueAtTime(f * 2.2 * vol(vel), v.t);
    idx.gain.setTargetAtTime(f * 0.15, v.t, 0.35);
    mod.connect(idx).connect(car.frequency);
    car.connect(v.amp);
    const ding = v.osc('sine', f * 4);
    const dg = v.gain(0);
    v.perc(dg.gain, 0.12, 0.08);
    ding.connect(dg).connect(v.amp);
    const g = v.amp.gain, t = v.t, peak = 0.25 * vol(vel);
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(peak, t + 0.004);
    g.setTargetAtTime(peak * 0.25, t + 0.004, 0.9);
    g.setTargetAtTime(0, t + dur, 0.12);
    return v.end(t + dur + 0.6);
  });

  // Wooden mallet: fundamental plus the bright 4th harmonic that real marimba bars have. Rings out on its own.
  def('marimba', 'Moon Marimba', '🥢', 'Classic', (v, f, dur, vel) => {
    const o = v.osc('sine', f);
    o.connect(v.amp);
    const hi = v.osc('sine', f * 4);
    const hg = v.gain(0);
    v.perc(hg.gain, 0.3 * vol(vel), 0.04);
    hi.connect(hg).connect(v.amp);
    const ring = Math.max(0.12, Math.min(0.45, 60 / f)); // low notes ring longer
    const g = v.amp.gain, t = v.t;
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(0.32 * vol(vel), t + 0.003);
    g.setTargetAtTime(0, t + 0.003, ring);
    g.setTargetAtTime(0, t + Math.max(dur, ring * 2), 0.05);
    return v.end(t + Math.min(Math.max(dur, ring * 2), ring * 6) + 0.3);
  });

  // Wooden flute: soft triangle tone, a breath of filtered noise at the start, gentle delayed vibrato.
  def('flute', 'Forest Flute', '🎋', 'Classic', (v, f, dur, vel) => {
    const o = v.osc('triangle', f);
    o.connect(v.gain(0.9)).connect(v.amp);
    const o2 = v.osc('sine', f * 2);
    o2.connect(v.gain(0.12)).connect(v.amp);
    const breath = v.gain(0);
    breath.gain.setValueAtTime(0, v.t);
    breath.gain.linearRampToValueAtTime(0.1 * vol(vel), v.t + 0.03);
    breath.gain.setTargetAtTime(0.025 * vol(vel), v.t + 0.03, 0.08);
    v.noise().connect(v.filter('bandpass', Math.min(f * 2, 8000), 2)).connect(breath).connect(v.amp);
    v.lfo(5, 12, [o.detune, o2.detune], 0.35);
    return v.adsr(dur, 0.2 * vol(vel), 0.05, 0.2, 0.85, 0.12);
  });

  // Plucked harp string: rings out on its own, bright at first then mellow.
  def('harp', 'Star Harp', '🎼', 'Classic', (v, f, dur, vel) => {
    const mix = v.gain(1);
    v.osc('triangle', f).connect(mix);
    const h2 = v.osc('sine', f * 2), g2 = v.gain(0);
    v.perc(g2.gain, 0.4, 0.25);
    h2.connect(g2).connect(mix);
    const h3 = v.osc('sine', f * 3), g3 = v.gain(0);
    v.perc(g3.gain, 0.2, 0.08);
    h3.connect(g3).connect(mix);
    mix.connect(v.amp);
    const ring = Math.max(0.3, Math.min(1.2, 200 / f));
    const g = v.amp.gain, t = v.t;
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(0.22 * vol(vel), t + 0.004);
    g.setTargetAtTime(0, t + 0.004, ring);
    return v.end(t + Math.min(ring * 3.5, 2.5));
  });

  // Little chirp: a quick swoop with a fast trill. Use high notes (C6 and up).
  def('bird', 'Space Bird', '🐦', 'Space', (v, f, dur, vel) => {
    const o = v.osc('sine', f);
    o.frequency.setValueAtTime(f * 0.8, v.t);
    o.frequency.exponentialRampToValueAtTime(f * 1.25, v.t + 0.07);
    o.frequency.exponentialRampToValueAtTime(f, v.t + 0.14);
    v.lfo(28, 150, [o.detune]);
    o.connect(v.amp);
    const len = Math.min(Math.max(dur, 0.08), 0.4);
    const g = v.amp.gain, t = v.t;
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(0.12 * vol(vel), t + 0.01);
    g.setTargetAtTime(0, t + len, 0.03);
    return v.end(t + len + 0.2);
  });

  // Brass: two sawtooths with a filter that blooms open at the start of each note (the "blat" of a horn).
  // Louder notes open brighter.
  def('brass', 'War Brass', '🎺', 'Classic', (v, f, dur, vel) => {
    const lp = v.filter('lowpass', f * 1.2, 1.5);
    lp.frequency.linearRampToValueAtTime(Math.min(f * (4 + 6 * vel), 9000), v.t + 0.08);
    lp.frequency.setTargetAtTime(Math.min(f * 3.5, 7000), v.t + 0.08, 0.3);
    const a = v.osc('sawtooth', f);
    const b = v.osc('sawtooth', f, -6);
    a.connect(lp);
    b.connect(v.gain(0.7)).connect(lp);
    v.lfo(5, 8, [a.detune, b.detune], 0.4);
    lp.connect(v.amp);
    return v.adsr(dur, 0.09 * vol(vel), 0.04, 0.25, 0.8, 0.15);
  });

  // Timpani: tuned kettle drum — a booming pitched thud with a soft mallet hit. Rings on its own.
  def('timpani', 'Timpani', '🪘', 'Drums', (v, f, dur, vel) => {
    const o = v.osc('sine', f * 1.02);
    o.frequency.exponentialRampToValueAtTime(f, v.t + 0.08);
    o.connect(v.amp);
    const o2 = v.osc('sine', f * 1.5), g2 = v.gain(0);
    v.perc(g2.gain, 0.25, 0.3);
    o2.connect(g2).connect(v.amp);
    const ng = v.gain(0);
    v.perc(ng.gain, 0.25 * vol(vel), 0.03);
    v.noise().connect(v.filter('lowpass', 600, 0.7)).connect(ng).connect(v.amp);
    const g = v.amp.gain, t = v.t;
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(0.5 * vol(vel), t + 0.004);
    g.setTargetAtTime(0, t + 0.004, 0.55);
    return v.end(t + 2.5);
  });

  def('strings', 'Cosmic Strings', '🎻', 'Classic', (v, f, dur, vel) => {
    const lp = v.filter('lowpass', Math.min(f * 8, 5000), 0.6);
    const dets = [];
    for (const d of [-14, -5, 5, 14]) {
      const o = v.osc('sawtooth', f, d);
      o.connect(lp);
      dets.push(o.detune);
    }
    v.lfo(5.4, 9, dets, 0.5);
    lp.connect(v.amp);
    return v.adsr(dur, 0.06 * vol(vel), 0.18, 0.4, 0.9, 0.5);
  });

  def('choir', 'Star Choir', '👼', 'Classic', (v, f, dur, vel) => {
    const src = v.gain(1);
    const o = v.osc('sawtooth', f);
    o.connect(src);
    v.lfo(5, 14, [o.detune], 0.35);
    // Formant filters roughly shape an "aah" vowel.
    for (const [ff, q, a] of [[650, 4, 1], [1100, 5, 0.65]]) {
      src.connect(v.filter('bandpass', ff, q)).connect(v.gain(a)).connect(v.amp);
    }
    return v.adsr(dur, 0.6 * vol(vel), 0.3, 0.5, 0.9, 0.7);
  });

  def('pad', 'Nebula Pad', '🌌', 'Space', (v, f, dur, vel) => {
    const lp = v.filter('lowpass', 300, 1.2);
    lp.frequency.setTargetAtTime(Math.min(f * 6, 3500), v.t, 0.5);
    for (const d of [-12, 0, 12]) v.osc('sawtooth', f, d).connect(lp);
    v.osc('sine', f / 2).connect(v.gain(0.6)).connect(lp);
    lp.connect(v.amp);
    return v.adsr(dur, 0.08 * vol(vel), 0.6, 1, 0.85, 1.4);
  });

  def('bell', 'Crystal Bell', '🔔', 'Space', (v, f, dur, vel) => {
    const car = v.osc('sine', f);
    const mod = v.osc('sine', f * 3.5);
    const idx = v.gain(0);
    idx.gain.setValueAtTime(f * 3 * vol(vel), v.t);
    idx.gain.setTargetAtTime(f * 0.1, v.t, 0.4);
    mod.connect(idx).connect(car.frequency);
    car.connect(v.amp);
    v.osc('sine', f * 2.01).connect(v.gain(0.25)).connect(v.amp);
    const g = v.amp.gain, t = v.t, peak = 0.2 * vol(vel);
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(peak, t + 0.002);
    g.setTargetAtTime(0, t + 0.002, 0.8);
    g.setTargetAtTime(0, t + Math.max(dur, 0.25), 0.25);
    return v.end(t + Math.max(dur, 0.25) + 1.2);
  });

  def('pluck', 'Orbit Pluck', '🪐', 'Space', (v, f, dur, vel) => {
    const lp = v.filter('lowpass', Math.min(f * 10, 9000), 4);
    lp.frequency.setTargetAtTime(Math.max(f * 1.5, 200), v.t, 0.09);
    v.osc('sawtooth', f).connect(lp);
    v.osc('square', f, 7).connect(v.gain(0.4)).connect(lp);
    lp.connect(v.amp);
    const g = v.amp.gain, t = v.t, peak = 0.14 * vol(vel);
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(peak, t + 0.003);
    g.setTargetAtTime(0, t + 0.003, 0.3);
    g.setTargetAtTime(0, t + dur, 0.05);
    return v.end(t + Math.min(dur, 2) + 0.4);
  });

  def('lead', 'Rocket Lead', '🚀', 'Space', (v, f, dur, vel) => {
    const lp = v.filter('lowpass', Math.min(f * 7, 6000), 2);
    const a = v.osc('square', f);
    const b = v.osc('sawtooth', f, 8);
    a.connect(v.gain(0.6)).connect(lp);
    b.connect(lp);
    v.lfo(5.5, 18, [a.detune, b.detune], 0.25);
    lp.connect(v.amp);
    return v.adsr(dur, 0.07 * vol(vel), 0.012, 0.2, 0.75, 0.15);
  });

  def('theremin', 'Theremin', '🛸', 'Space', (v, f, dur, vel) => {
    const o = v.osc('sine', f);
    const o2 = v.osc('triangle', f * 2);
    o2.connect(v.gain(0.12)).connect(v.amp);
    o.connect(v.amp);
    v.lfo(6.2, 28, [o.detune, o2.detune], 0.15);
    return v.adsr(dur, 0.22 * vol(vel), 0.12, 0.3, 0.9, 0.3);
  });

  def('chip', 'Retro Chip', '👾', 'Space', (v, f, dur, vel) => {
    v.osc('pulse', f).connect(v.amp);
    return v.adsr(dur, 0.11 * vol(vel), 0.002, 0.1, 0.6, 0.04);
  });

  def('zap', 'Laser Zap', '🔫', 'Space', (v, f, dur, vel) => {
    const len = Math.min(Math.max(dur, 0.08), 0.35);
    const o = v.osc('sawtooth', f * 4);
    o.frequency.exponentialRampToValueAtTime(f * 0.5, v.t + len);
    const lp = v.filter('lowpass', Math.min(f * 10, 9000), 3);
    o.connect(lp).connect(v.amp);
    v.perc(v.amp.gain, 0.12 * vol(vel), len / 2.5);
    return v.end(v.t + len * 3);
  });

  def('bass', 'Sub Bass', '🔊', 'Bass', (v, f, dur, vel) => {
    const lp = v.filter('lowpass', 380, 1);
    v.osc('sine', f).connect(v.gain(1)).connect(v.amp);
    v.osc('square', f).connect(v.gain(0.25)).connect(lp);
    lp.connect(v.amp);
    return v.adsr(dur, 0.3 * vol(vel), 0.008, 0.3, 0.8, 0.1);
  });

  def('acid', 'Laser Bass', '⚡', 'Bass', (v, f, dur, vel) => {
    const lp = v.filter('lowpass', Math.min(f * 14, 8000), 12);
    lp.frequency.setTargetAtTime(Math.max(f * 1.5, 120), v.t, 0.12);
    v.osc('sawtooth', f).connect(lp);
    lp.connect(v.amp);
    return v.adsr(dur, 0.11 * vol(vel), 0.004, 0.2, 0.7, 0.08);
  });

  // ---------------- drums ----------------
  // Each row (pitch) on a drum track is a different hit. Note length is ignored.

  function kick(v, peak, start = 150) {
    const o = v.osc('sine', start);
    o.frequency.exponentialRampToValueAtTime(42, v.t + 0.15);
    o.connect(v.amp);
    v.perc(v.amp.gain, peak, 0.13);
    const click = v.noise();
    const cg = v.gain(0);
    v.perc(cg.gain, peak * 0.3, 0.004);
    click.connect(v.filter('lowpass', 3000)).connect(cg).connect(v.amp);
    return v.end(v.t + 0.8);
  }

  function noiseHit(v, type, f, q, peak, tau, len) {
    v.noise().connect(v.filter(type, f, q)).connect(v.amp);
    v.perc(v.amp.gain, peak, tau);
    return v.end(v.t + len);
  }

  function tom(v, peak, f) {
    const o = v.osc('sine', f);
    o.frequency.exponentialRampToValueAtTime(f * 0.7, v.t + 0.2);
    o.connect(v.amp);
    v.perc(v.amp.gain, peak, 0.18);
    return v.end(v.t + 1);
  }

  function zapHit(v, peak, f, len) {
    const o = v.osc('square', f * 3);
    o.frequency.exponentialRampToValueAtTime(f * 0.4, v.t + len);
    o.connect(v.filter('lowpass', 4000, 2)).connect(v.amp);
    v.perc(v.amp.gain, peak * 0.4, len / 3);
    return v.end(v.t + len * 2);
  }

  def('drums', 'Drum Kit', '🥁', 'Drums', (v, f, dur, vel, p) => {
    const pk = vol(vel);
    switch (p) {
      case 35: return kick(v, 0.9 * pk, 110);
      case 36: return kick(v, 0.9 * pk);
      case 37: {
        v.osc('sine', 1700).connect(v.amp);
        v.perc(v.amp.gain, 0.3 * pk, 0.012);
        return v.end(v.t + 0.15);
      }
      case 38: case 40: {
        const tone = v.osc('triangle', 190);
        tone.frequency.exponentialRampToValueAtTime(150, v.t + 0.08);
        const tg = v.gain(0);
        v.perc(tg.gain, 0.5, 0.05);
        tone.connect(tg).connect(v.amp);
        v.noise().connect(v.filter('highpass', p === 38 ? 1500 : 2500)).connect(v.amp);
        v.perc(v.amp.gain, 0.45 * pk, 0.07);
        return v.end(v.t + 0.5);
      }
      case 39: {
        v.noise().connect(v.filter('bandpass', 1400, 2)).connect(v.amp);
        const g = v.amp.gain, t = v.t, a = 0.7 * pk;
        g.setValueAtTime(a, t); g.setTargetAtTime(0, t, 0.004);
        g.setValueAtTime(a, t + 0.012); g.setTargetAtTime(0, t + 0.012, 0.004);
        g.setValueAtTime(a, t + 0.024); g.setTargetAtTime(0, t + 0.024, 0.09);
        return v.end(t + 0.6);
      }
      case 42: return noiseHit(v, 'highpass', 7500, 1, 0.25 * pk, 0.022, 0.2);
      case 44: return noiseHit(v, 'highpass', 7000, 1, 0.2 * pk, 0.035, 0.25);
      case 46: return noiseHit(v, 'highpass', 6500, 1, 0.22 * pk, 0.17, 1);
      case 49: case 57: case 52: return noiseHit(v, 'highpass', 4000, 0.8, 0.25 * pk, 0.7, 3.5);
      case 55: return noiseHit(v, 'highpass', 5500, 0.8, 0.22 * pk, 0.3, 1.8);
      case 51: case 53: return noiseHit(v, 'bandpass', 9000, 1.5, 0.3 * pk, p === 53 ? 0.5 : 0.3, 2);
      case 54: return noiseHit(v, 'highpass', 8500, 2, 0.25 * pk, 0.07, 0.5);
      case 41: return tom(v, 0.7 * pk, 85);
      case 43: return tom(v, 0.7 * pk, 100);
      case 45: return tom(v, 0.7 * pk, 125);
      case 47: return tom(v, 0.7 * pk, 145);
      case 48: return tom(v, 0.7 * pk, 170);
      case 50: return tom(v, 0.7 * pk, 200);
      case 56: {
        const bp = v.filter('bandpass', 800, 3);
        v.osc('square', 540).connect(bp);
        v.osc('square', 800).connect(bp);
        bp.connect(v.amp);
        v.perc(v.amp.gain, 0.25 * pk, 0.1);
        return v.end(v.t + 0.6);
      }
      case 63: { // warp: rising noise sweep
        const bp = v.filter('bandpass', 300, 6);
        bp.frequency.exponentialRampToValueAtTime(6000, v.t + 0.6);
        v.noise().connect(bp).connect(v.amp);
        const g = v.amp.gain;
        g.setValueAtTime(0, v.t);
        g.linearRampToValueAtTime(0.5 * pk, v.t + 0.55);
        g.setTargetAtTime(0, v.t + 0.55, 0.05);
        return v.end(v.t + 0.9);
      }
      case 65: return zapHit(v, pk, 1200, 0.4);
      default: return zapHit(v, pk, Math.min(f, 2000), 0.18);
    }
  }, { drums: true });

  const byId = new Map(list.map(i => [i.id, i]));

  function get(id) {
    return byId.get(id) || byId.get('organ');
  }

  function play(ctx, out, inst, t, p, dur, vel) {
    const v = new Voice(ctx, out, t);
    return inst.play(v, Music.freq(p), Math.max(dur, 0.03), vel, p);
  }

  return { list, get, play, noiseBuffer, kRate };
})();
