'use strict';
// Audio engine: live playback (with looping) and offline rendering to audio buffers.
//
// Signal path per track:
//   notes -> input -> filter (with sweep LFO) -> pan -> volume -> master
//                                                       volume -> reverb send -> reverb -> master
//                                                       volume -> echo send -> delay (feedback) -> master
//   master -> compressor -> speakers / file
const EPS = 1e-6;

class Engine {
  constructor() {
    this.ctx = null;
    this.song = null;
    this.graph = null;
    this.previewGraph = null;
    this.playing = false;
    this.timer = null;
    this.cache = new Map();
    this.anchors = [];
    this.finishedAt = null;
  }

  setSong(song) {
    this.song = song;
    this.invalidate();
    if (this.previewGraph) {
      Engine.disposeGraph(this.ctx, this.previewGraph);
      this.previewGraph = null;
    }
    this.updateParams();
  }

  invalidate() {
    this.cache.clear();
  }

  ensureCtx() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  // ---------------------------------------------------------------- graph

  static impulse(ctx, seconds) {
    const sr = ctx.sampleRate, len = Math.max(1, Math.floor(sr * seconds));
    const b = ctx.createBuffer(2, len, sr);
    let seed = 987654321;
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const n = seed / 0x3fffffff - 1;
        d[i] = n * Math.pow(1 - i / len, 3.2);
      }
    }
    return b;
  }

  static buildGraph(ctx, song, t0) {
    const master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 10;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    master.connect(comp);
    comp.connect(ctx.destination);
    const reverb = ctx.createConvolver();
    reverb.buffer = Engine.impulse(ctx, song.master.reverbSeconds);
    reverb.connect(master);
    const graph = { master, comp, reverb, reverbSeconds: song.master.reverbSeconds, tracks: new Map(), t0 };
    for (const tr of song.tracks) Engine.trackNode(ctx, graph, tr, song);
    Engine.applyParams(ctx, graph, song, false);
    return graph;
  }

  static trackNode(ctx, graph, track, song) {
    let n = graph.tracks.get(track.id);
    if (n) return n;
    const input = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    Instruments.kRate(filter);
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.connect(lfoGain).connect(filter.detune);
    lfo.start(graph.t0);
    const pan = ctx.createStereoPanner();
    const vol = ctx.createGain();
    const revSend = ctx.createGain();
    const dlySend = ctx.createGain();
    const delay = ctx.createDelay(4);
    const dlyTone = ctx.createBiquadFilter();
    dlyTone.type = 'lowpass';
    dlyTone.frequency.value = 3500;
    const fb = ctx.createGain();

    input.connect(filter);
    filter.connect(pan);
    pan.connect(vol);
    vol.connect(graph.master);
    vol.connect(revSend);
    revSend.connect(graph.reverb);
    vol.connect(dlySend);
    dlySend.connect(delay);
    delay.connect(dlyTone);
    dlyTone.connect(fb);
    fb.connect(delay);
    dlyTone.connect(graph.master);

    n = { input, filter, lfo, lfoGain, pan, vol, revSend, dlySend, delay, fb };
    graph.tracks.set(track.id, n);
    Engine.applyTrack(ctx, n, track, song, song.tracks.some(t => t.solo), false);
    return n;
  }

  static setParam(ctx, param, value, smooth) {
    if (smooth) param.setTargetAtTime(value, ctx.currentTime, 0.015);
    else param.value = value;
  }

  static applyTrack(ctx, n, track, song, anySolo, smooth) {
    const fx = track.fx, spb = 60 / song.bpm;
    const audible = !track.mute && (!anySolo || track.solo);
    const S = (p, v) => Engine.setParam(ctx, p, v, smooth);
    S(n.vol.gain, audible ? track.volume : 0);
    S(n.pan.pan, track.pan);
    S(n.revSend.gain, fx.reverb);
    S(n.dlySend.gain, fx.delay.mix);
    S(n.delay.delayTime, Math.min(3.9, Math.max(0.01, fx.delay.beats * spb)));
    S(n.fb.gain, Math.min(0.9, fx.delay.feedback));
    S(n.filter.frequency, fx.filter.cutoff);
    S(n.filter.Q, fx.filter.q);
    S(n.lfoGain.gain, fx.filter.sweepDepth * 2400);
    S(n.lfo.frequency, song.bpm / 60 / Math.max(0.25, fx.filter.sweepBeats));
  }

  static applyParams(ctx, graph, song, smooth) {
    const anySolo = song.tracks.some(t => t.solo);
    for (const t of song.tracks) {
      const n = graph.tracks.get(t.id);
      if (n) Engine.applyTrack(ctx, n, t, song, anySolo, smooth);
    }
    // Tracks that were deleted go silent.
    for (const [id, n] of graph.tracks) if (!song.tracks.some(t => t.id === id)) Engine.setParam(ctx, n.vol.gain, 0, smooth);
    Engine.setParam(ctx, graph.master.gain, song.master.volume, smooth);
    if (graph.reverbSeconds !== song.master.reverbSeconds) {
      graph.reverb.buffer = Engine.impulse(ctx, song.master.reverbSeconds);
      graph.reverbSeconds = song.master.reverbSeconds;
    }
  }

  static disposeGraph(ctx, graph) {
    if (!ctx || !graph) return;
    graph.master.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
    setTimeout(() => {
      try {
        graph.comp.disconnect();
        for (const n of graph.tracks.values()) {
          n.lfo.stop();
          n.vol.disconnect();
          n.fb.disconnect();
        }
      } catch (e) { /* already gone */ }
    }, 250);
  }

  updateParams() {
    if (!this.ctx || !this.song) return;
    if (this.graph) Engine.applyParams(this.ctx, this.graph, this.song, true);
    if (this.previewGraph) Engine.applyParams(this.ctx, this.previewGraph, this.song, true);
  }

  // ---------------------------------------------------------------- notes

  // Notes as they will actually play (the arpeggiator turns held chords into note runs).
  static expandTrack(track) {
    const notes = track.notes.slice().sort((a, b) => a.s - b.s || a.p - b.p);
    const arp = track.fx.arp;
    const inst = Instruments.get(track.instrument);
    if (!arp.on || inst.drums || !notes.length) return notes;

    const step = Math.max(1 / 48, arp.rate);
    let first = Infinity, last = 0;
    for (const n of notes) {
      first = Math.min(first, n.s);
      last = Math.max(last, n.s + n.d);
    }
    const out = [];
    let prevKey = '', k = 0;
    for (let i = Math.floor(first / step + EPS); i * step < last - EPS; i++) {
      const t = i * step;
      const active = notes.filter(n => n.s <= t + EPS && n.s + n.d > t + EPS);
      if (!active.length) { prevKey = ''; continue; }
      const key = active.map(n => n.p).sort((a, b) => a - b).join(',');
      if (key !== prevKey) { k = 0; prevKey = key; }

      const base = arp.mode === 'played' ? active.slice().sort((a, b) => a.s - b.s || a.p - b.p) : active.slice().sort((a, b) => a.p - b.p);
      let pool = [];
      for (let o = 0; o < Math.max(1, arp.octaves); o++) for (const n of base) pool.push({ p: n.p + 12 * o, v: n.v, end: n.s + n.d });
      if (arp.mode === 'down') pool.reverse();
      else if (arp.mode === 'updown' && pool.length > 2) pool = pool.concat(pool.slice(1, -1).reverse());

      let idx;
      if (arp.mode === 'random') {
        let h = (i * 2654435761) >>> 0;
        h ^= h >>> 13;
        idx = h % pool.length;
      } else idx = k % pool.length;
      const pick = pool[idx];
      out.push({ p: Math.min(127, pick.p), s: t, d: Math.min(step * arp.gate, pick.end - t), v: pick.v });
      k++;
    }
    return out;
  }

  expanded(track) {
    let e = this.cache.get(track.id);
    if (!e) {
      e = Engine.expandTrack(track);
      this.cache.set(track.id, e);
    }
    return e;
  }

  scheduleRange(ctx, graph, song, b0, b1, tAtB0, spb) {
    for (const track of song.tracks) {
      const inst = Instruments.get(track.instrument);
      const node = Engine.trackNode(ctx, graph, track, song);
      for (const n of this.expanded(track)) {
        if (n.s < b0 - EPS) continue;
        if (n.s >= b1 - EPS) break;
        const t = tAtB0 + (n.s - b0) * spb;
        Instruments.play(ctx, node.input, inst, t, n.p, n.d * spb, n.v);
      }
    }
  }

  // ---------------------------------------------------------------- live playback

  play(fromBeat) {
    const ctx = this.ensureCtx();
    this.stop();
    this.graph = Engine.buildGraph(ctx, this.song, ctx.currentTime);
    const t0 = ctx.currentTime + 0.08;
    this.cursorBeat = fromBeat;
    this.cursorTime = t0;
    this.spb = 60 / this.song.bpm;
    this.anchors = [{ time: t0, beat: fromBeat, spb: this.spb }];
    this.finishedAt = null;
    this.playing = true;
    this.timer = setInterval(() => this.tick(), 25);
    this.tick();
  }

  tick() {
    if (!this.playing) return;
    const ctx = this.ctx, song = this.song;
    const spb = 60 / song.bpm;
    if (spb !== this.spb) {
      // Tempo changed while playing.
      this.spb = spb;
      this.anchors.push({ time: this.cursorTime, beat: this.cursorBeat, spb });
    }
    if (this.finishedAt !== null) return;
    const end = Song.lengthBeats(song);
    const loop = song.loop;
    const ahead = ctx.currentTime + 0.2;
    let guard = 0;
    while (this.cursorTime < ahead && guard++ < 1000) {
      const loopOn = loop.enabled && loop.end > loop.start && this.cursorBeat < loop.end - EPS;
      const limit = loopOn ? loop.end : end;
      const chunkEnd = Math.min(this.cursorBeat + 0.5, limit);
      if (chunkEnd > this.cursorBeat) {
        this.scheduleRange(ctx, this.graph, song, this.cursorBeat, chunkEnd, this.cursorTime, spb);
        this.cursorTime += (chunkEnd - this.cursorBeat) * spb;
        this.cursorBeat = chunkEnd;
      }
      if (this.cursorBeat >= limit - EPS) {
        if (loopOn) {
          this.cursorBeat = loop.start;
          this.anchors.push({ time: this.cursorTime, beat: loop.start, spb });
          if (this.anchors.length > 50) this.anchors.splice(0, this.anchors.length - 50);
        } else {
          this.finishedAt = this.cursorTime;
          break;
        }
      }
    }
  }

  currentBeat() {
    if (!this.playing) return null;
    const now = this.ctx.currentTime;
    let a = this.anchors[0];
    for (const x of this.anchors) if (x.time <= now) a = x;
    return a.beat + Math.max(0, now - a.time) / a.spb;
  }

  isFinished() {
    return this.playing && this.finishedAt !== null && this.ctx.currentTime > this.finishedAt;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.graph) Engine.disposeGraph(this.ctx, this.graph);
    this.graph = null;
    this.playing = false;
  }

  preview(track, p, dur = 0.35) {
    if (!track) return;
    const ctx = this.ensureCtx();
    let graph = this.playing ? this.graph : this.previewGraph;
    if (!graph) graph = this.previewGraph = Engine.buildGraph(ctx, this.song, ctx.currentTime);
    const node = Engine.trackNode(ctx, graph, track, this.song);
    Instruments.play(ctx, node.input, Instruments.get(track.instrument), ctx.currentTime + 0.01, p, dur, 0.8);
  }

  // ---------------------------------------------------------------- offline render

  // opts: { range: 'song' | 'loop', tail: seconds, sampleRate, normalize }
  // Loop renders wrap their tail (reverb/echo) back onto the start, so the file loops seamlessly.
  async render(song, opts = {}) {
    const sr = opts.sampleRate || 44100;
    const spb = 60 / song.bpm;
    const isLoop = opts.range === 'loop';
    let b0 = 0, b1 = Song.lengthBeats(song);
    if (isLoop) {
      b0 = song.loop.start;
      b1 = song.loop.end;
      if (!(b1 > b0)) throw new Error('Set a loop region first (drag along the ruler at the top).');
    }
    const body = (b1 - b0) * spb;
    const tail = isLoop ? 8 : (opts.tail ?? 3);
    const frames = Math.ceil((body + tail) * sr);
    const ctx = new OfflineAudioContext(2, frames, sr);
    const graph = Engine.buildGraph(ctx, song, 0);
    this.invalidate();
    // Create notes a little before they're needed (pausing the render to do it), like live playback.
    // Creating every note up front makes big songs render extremely slowly.
    const step = 2; // beats per chunk
    const chunks = Math.ceil((b1 - b0) / step - EPS);
    if (typeof ctx.suspend !== 'function') this.scheduleRange(ctx, graph, song, b0, b1, 0, spb);
    else {
      this.scheduleRange(ctx, graph, song, b0, Math.min(b1, b0 + step), 0, spb);
      let lastAt = 0;
      for (let k = 1; k < chunks; k++) {
        const cb0 = b0 + k * step, cb1 = Math.min(b1, cb0 + step);
        // suspend() times snap to 128-frame blocks; keep them distinct and ahead of the notes.
        const at = Math.max(lastAt + 256 / sr, Math.floor(((cb0 - b0) * spb - 0.25) * sr / 128) * 128 / sr);
        lastAt = at;
        ctx.suspend(at).then(() => {
          this.scheduleRange(ctx, graph, song, cb0, cb1, (cb0 - b0) * spb, spb);
          ctx.resume();
        });
      }
    }
    const buf = await ctx.startRendering();

    let channels = [buf.getChannelData(0), buf.getChannelData(1)];
    if (isLoop) {
      const L = Math.round(body * sr);
      channels = channels.map(d => {
        const out = new Float32Array(L);
        for (let i = 0; i < d.length; i++) out[i % L] += d[i];
        return out;
      });
    }
    let peak = 0;
    for (const d of channels) for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
    if (opts.normalize && peak > 0) {
      const g = 0.89 / peak; // about -1 dB
      for (const d of channels) for (let i = 0; i < d.length; i++) d[i] *= g;
    }
    return { channels, sampleRate: sr, peak, seconds: channels[0].length / sr };
  }
}
