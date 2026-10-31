'use strict';
// Song data model, save format and undo history.
//
// Times are in beats (quarter notes). A note is { p: midiPitch, s: startBeat, d: lengthBeats, v: velocity 0..1 }.
const Song = (() => {
  const COLORS = ['#ff6b9a', '#5ce1e6', '#ffd166', '#9b8cff', '#7ae582', '#ff9f43', '#4da3ff', '#f78fb3', '#c4f135', '#e0a3ff'];

  function defaultFx() {
    return {
      reverb: 0.25,
      delay: { mix: 0, beats: 0.75, feedback: 0.35 },
      filter: { cutoff: 20000, q: 0.7, sweepDepth: 0, sweepBeats: 8 },
      arp: { on: false, rate: 0.25, mode: 'up', octaves: 1, gate: 0.8 },
    };
  }

  function uniqueId(song) {
    const used = new Set(song.tracks.map(t => t.id));
    let i = song.tracks.length + 1;
    while (used.has('t' + i)) i++;
    return 't' + i;
  }

  function newTrack(song, opts = {}) {
    const n = song.tracks.length;
    const t = {
      id: uniqueId(song),
      name: 'Track ' + (n + 1),
      color: COLORS[n % COLORS.length],
      instrument: 'organ',
      volume: 0.8,
      pan: 0,
      mute: false,
      solo: false,
      fx: defaultFx(),
      notes: [],
    };
    Object.assign(t, opts);
    if (opts.fx) t.fx = mergeDeep(defaultFx(), opts.fx);
    return t;
  }

  function create() {
    const song = {
      format: 'asteroidbob-song',
      version: 1,
      title: 'Untitled Hymn',
      bpm: 100,
      timeSig: { num: 4, den: 4 },
      key: { root: 0, scale: 'major' },
      bars: 16,
      loop: { enabled: false, start: 0, end: 16 },
      master: { volume: 0.8, reverbSeconds: 2.5 },
      tracks: [],
    };
    song.tracks.push(newTrack(song, { name: 'Melody', instrument: 'organ' }));
    return song;
  }

  function beatsPerBar(song) {
    return (song.timeSig.num * 4) / song.timeSig.den;
  }

  function lengthBeats(song) {
    return song.bars * beatsPerBar(song);
  }

  function lastNoteEnd(song) {
    let end = 0;
    for (const t of song.tracks) for (const n of t.notes) end = Math.max(end, n.s + n.d);
    return end;
  }

  function mergeDeep(base, extra) {
    if (!extra || typeof extra !== 'object') return base;
    for (const k of Object.keys(extra)) {
      const v = extra[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') mergeDeep(base[k], v);
      else if (v !== undefined) base[k] = v;
    }
    return base;
  }

  function num(v, def, min, max) {
    v = Number(v);
    if (!isFinite(v)) v = def;
    return Math.min(max, Math.max(min, v));
  }

  // Fill in anything missing so older/hand-edited files still load.
  function normalize(raw) {
    const song = create();
    song.tracks = [];
    if (!raw || typeof raw !== 'object') throw new Error('Not a song file');
    song.title = String(raw.title || 'Untitled Hymn');
    song.bpm = num(raw.bpm, 100, 20, 400);
    if (raw.timeSig) song.timeSig = { num: num(raw.timeSig.num, 4, 1, 32) | 0, den: [1, 2, 4, 8, 16, 32].includes(raw.timeSig.den) ? raw.timeSig.den : 4 };
    if (raw.key) song.key = { root: num(raw.key.root, 0, 0, 11) | 0, scale: Music.SCALES[raw.key.scale] ? raw.key.scale : 'major' };
    song.bars = num(raw.bars, 16, 1, 2000) | 0;
    if (raw.loop) song.loop = { enabled: !!raw.loop.enabled, start: num(raw.loop.start, 0, 0, 1e6), end: num(raw.loop.end, 16, 0, 1e6) };
    if (raw.master) song.master = { volume: num(raw.master.volume, 0.8, 0, 2), reverbSeconds: num(raw.master.reverbSeconds, 2.5, 0.2, 10) };
    for (const rt of raw.tracks || []) {
      const t = newTrack(song, {
        name: String(rt.name || 'Track'),
        color: rt.color || undefined,
        instrument: rt.instrument || 'organ',
        volume: num(rt.volume, 0.8, 0, 2),
        pan: num(rt.pan, 0, -1, 1),
        mute: !!rt.mute,
        solo: !!rt.solo,
        fx: rt.fx || {},
      });
      if (!t.color) t.color = COLORS[song.tracks.length % COLORS.length];
      if (rt.id && !song.tracks.some(o => o.id === rt.id)) t.id = String(rt.id);
      t.notes = (rt.notes || [])
        .map(n => ({ p: num(n.p, 60, 0, 127) | 0, s: num(n.s, 0, 0, 1e6), d: num(n.d, 1, 1 / 64, 1e6), v: num(n.v, 0.8, 0.05, 1) }))
        .sort((a, b) => a.s - b.s || a.p - b.p);
      song.tracks.push(t);
    }
    if (!song.tracks.length) song.tracks.push(newTrack(song, { name: 'Melody' }));
    return song;
  }

  function round(v) {
    return typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v;
  }

  // Pretty JSON, but each note on a single line so files stay readable and diff nicely.
  function serialize(song) {
    const json = JSON.stringify(song, (k, v) => round(v), 2);
    return json.replace(/\{\s+"p": [^{}]*?\}/g, m => m.replace(/\s+/g, ' ').replace('{ ', '{').replace(' }', '}'));
  }

  return { COLORS, defaultFx, newTrack, create, beatsPerBar, lengthBeats, lastNoteEnd, normalize, serialize, mergeDeep };
})();

// Undo/redo by snapshots. Rapid changes with the same key (e.g. dragging a slider) merge into one step.
class History {
  constructor(limit = 200) {
    this.limit = limit;
    this.reset(null);
  }
  reset(song) {
    this.undoStack = [];
    this.redoStack = [];
    this.current = song ? JSON.stringify(song) : null;
    this.lastKey = null;
    this.lastTime = 0;
  }
  commit(song, key) {
    const s = JSON.stringify(song);
    if (s === this.current) return false;
    const now = performance.now();
    if (!(key && key === this.lastKey && now - this.lastTime < 800)) {
      this.undoStack.push(this.current);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }
    this.current = s;
    this.redoStack = [];
    this.lastKey = key || null;
    this.lastTime = now;
    return true;
  }
  undo() {
    if (!this.undoStack.length) return null;
    this.redoStack.push(this.current);
    this.current = this.undoStack.pop();
    this.lastKey = null;
    return JSON.parse(this.current);
  }
  redo() {
    if (!this.redoStack.length) return null;
    this.undoStack.push(this.current);
    this.current = this.redoStack.pop();
    this.lastKey = null;
    return JSON.parse(this.current);
  }
}
