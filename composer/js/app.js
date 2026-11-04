'use strict';
// UI wiring for the composer.

const NOTE_LENGTHS = [
  [0.25, '1/16 (sixteenth)'],
  [0.5, '1/8 (eighth)'],
  [0.75, '1/8 dotted'],
  [1, '1/4 (one beat)'],
  [1.5, '1/4 dotted'],
  [2, '1/2 (half)'],
  [3, '1/2 dotted'],
  [4, '1 (whole)'],
  [1 / 3, '1/8 triplet'],
];
const SNAPS = [[1, '1 beat'], [0.5, '1/8'], [0.25, '1/16'], [1 / 3, '1/8 triplet'], [1 / 6, '1/16 triplet'], [0.125, '1/32'], [0, 'Off (free)']];
const ARP_RATES = [[1, '1/4'], [0.5, '1/8'], [1 / 3, '1/8 triplet'], [0.25, '1/16'], [1 / 6, '1/16 triplet'], [0.125, '1/32']];
const ARP_MODES = [['up', 'Up'], ['down', 'Down'], ['updown', 'Up & down'], ['random', 'Random'], ['played', 'As played']];
const ECHO_TIMES = [[0.25, '1/16'], [0.5, '1/8'], [0.75, '1/8 dotted'], [1, '1/4'], [1.5, '1/4 dotted'], [2, '1/2'], [3, '3 beats'], [4, '1 bar (4)']];
const SWEEP_BEATS = [[1, '1 beat'], [2, '2 beats'], [3, '3 beats'], [4, '4 beats'], [6, '6 beats'], [8, '8 beats'], [12, '12 beats'], [16, '16 beats'], [32, '32 beats']];
const AUTOSAVE_KEY = 'asteroidbob.composer.autosave';

const $ = s => document.querySelector(s);

// Tiny DOM builder: h('div', {class: 'x', onclick: fn}, 'text', childEl)
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k in e && k !== 'list') e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : String(c));
  return e;
}

function closestIndex(list, value) {
  let best = 0;
  list.forEach(([v], i) => { if (Math.abs(v - value) < Math.abs(list[best][0] - value)) best = i; });
  return best;
}

function numSelect(list, value, onChange) {
  const s = h('select', {}, list.map(([v, label], i) => h('option', { value: i }, label)));
  s.value = closestIndex(list, value);
  s.addEventListener('change', () => onChange(list[+s.value][0]));
  return s;
}

function slug(s) {
  return (s || 'song').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'song';
}

const cutoffToSlider = c => Math.min(1, Math.max(0, Math.log2(c / 60) / 8.4));
const sliderToCutoff = x => (x >= 0.995 ? 20000 : Math.round(60 * Math.pow(2, x * 8.4)));

const App = {
  init() {
    this.engine = new Engine();
    this.history = new History();
    this.noteLen = 1;
    this.velocity = 0.8;
    this.snap = 0.5;
    this.tool = 'draw';
    this.playPos = 0;
    this.clipboard = null;
    this.fileHandle = null;
    this.roll = new PianoRoll($('#roll'), this);

    let song = null;
    try {
      const s = localStorage.getItem(AUTOSAVE_KEY);
      if (s) song = Song.normalize(JSON.parse(s));
    } catch (e) { song = null; }
    if (!song) song = Demo.amazingGrace();

    this.buildStaticUI();
    this.setSong(song, { resetHistory: true });
    this.bindKeys();
    const loop = () => { this.frame(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    if (location.hash === '#selftest') this.selfTest();
  },

  // ------------------------------------------------------------ state
  currentTrack() {
    return this.song.tracks.find(t => t.id === this.trackId) || this.song.tracks[0] || null;
  },

  setSong(song, { resetHistory = true, keepTrack = false } = {}) {
    this.song = song;
    this.engine.setSong(song);
    if (!keepTrack || !song.tracks.some(t => t.id === this.trackId)) this.trackId = song.tracks[0] ? song.tracks[0].id : null;
    this.roll.selection = new Set();
    if (resetHistory) {
      this.history.reset(song);
      this.roll.centerOnTrack();
    }
    this.refreshAll();
    if (resetHistory) this.autosave();
  },

  selectTrack(id) {
    if (id === this.trackId) return;
    this.trackId = id;
    this.roll.selection = new Set();
    for (const row of document.querySelectorAll('#trackList .track')) row.classList.toggle('selected', row.dataset.id === id);
    this.renderInspector();
    this.onSelectionChanged();
    const t = this.currentTrack();
    if (t && t.notes.length) {
      // Only jump if this track's notes are off screen.
      const mid = t.notes.reduce((a, n) => a + n.p, 0) / t.notes.length;
      const y = this.roll.yOf(mid);
      if (y < this.roll.RULERH || y > this.roll.h) this.roll.centerOnTrack();
    } else this.roll.centerOnTrack();
    this.roll.dirty = true;
  },

  // Call during a drag: redraw + let the engine hear the change, without an undo step.
  markDirty() {
    this.engine.invalidate();
    this.roll.dirty = true;
  },

  // Call after any finished edit: makes an undo step and autosaves.
  changed(key) {
    const song = this.song;
    const end = Song.lastNoteEnd(song);
    const bpb = Song.beatsPerBar(song);
    if (end > Song.lengthBeats(song) + EPS) {
      song.bars = Math.ceil(end / bpb - EPS);
      this.renderTopbar();
    }
    this.engine.invalidate();
    this.engine.updateParams();
    this.roll.dirty = true;
    if (this.history.commit(song, key)) this.autosave();
    this.renderStatus();
  },

  autosave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(this.song)); } catch (e) { /* storage unavailable */ }
    }, 300);
  },

  undo() {
    const s = this.history.undo();
    if (s) { this.setSong(Song.normalize(s), { resetHistory: false, keepTrack: true }); this.autosave(); this.toast('Undo'); }
  },
  redo() {
    const s = this.history.redo();
    if (s) { this.setSong(Song.normalize(s), { resetHistory: false, keepTrack: true }); this.autosave(); this.toast('Redo'); }
  },

  refreshAll() {
    this.renderTopbar();
    this.renderTracks();
    this.renderInspector();
    this.renderSongPanel();
    this.onSelectionChanged();
    this.renderStatus();
    this.roll.clampScroll();
    this.roll.dirty = true;
  },

  // ------------------------------------------------------------ static UI
  buildStaticUI() {
    const keyRoot = $('#keyRoot');
    Music.ROOTS.forEach((n, i) => keyRoot.append(h('option', { value: i }, n)));
    const keyScale = $('#keyScale');
    for (const [id, s] of Object.entries(Music.SCALES)) keyScale.append(h('option', { value: id }, s.name));
    const tsNum = $('#tsNum');
    for (let i = 1; i <= 16; i++) tsNum.append(h('option', { value: i }, i));
    const tsDen = $('#tsDen');
    for (const d of [2, 4, 8, 16]) tsDen.append(h('option', { value: d }, d));

    const noteLen = $('#noteLen');
    NOTE_LENGTHS.forEach(([v, l], i) => noteLen.append(h('option', { value: i }, (i < 9 ? `[${i + 1}] ` : '') + l)));
    noteLen.value = closestIndex(NOTE_LENGTHS, this.noteLen);
    noteLen.addEventListener('change', () => { this.noteLen = NOTE_LENGTHS[+noteLen.value][0]; this.roll.dirty = true; });
    const snap = $('#snap');
    SNAPS.forEach(([v, l], i) => snap.append(h('option', { value: i }, l)));
    snap.value = closestIndex(SNAPS, this.snap);
    snap.addEventListener('change', () => { this.snap = SNAPS[+snap.value][0]; this.roll.dirty = true; });

    $('#songTitle').addEventListener('input', e => { this.song.title = e.target.value; document.title = this.song.title + ' – Composer'; this.changed('title'); });
    $('#bpm').addEventListener('change', e => { this.song.bpm = Math.max(20, Math.min(400, +e.target.value || 100)); e.target.value = this.song.bpm; this.changed('bpm'); });
    $('#bars').addEventListener('change', e => { this.song.bars = Math.max(1, Math.min(2000, Math.round(+e.target.value || 16))); this.changed('bars'); this.renderTopbar(); });
    tsNum.addEventListener('change', () => { this.song.timeSig.num = +tsNum.value; this.changed(); });
    tsDen.addEventListener('change', () => { this.song.timeSig.den = +tsDen.value; this.changed(); });
    keyRoot.addEventListener('change', () => { this.song.key.root = +keyRoot.value; this.changed(); });
    keyScale.addEventListener('change', () => { this.song.key.scale = keyScale.value; this.changed(); });
    $('#highlightScale').addEventListener('change', e => { this.roll.highlightScale = e.target.checked; this.roll.dirty = true; });

    $('#btnPlay').addEventListener('click', () => this.togglePlay());
    $('#btnHome').addEventListener('click', () => this.setPlayPos(0));
    $('#btnLoop').addEventListener('click', () => this.toggleLoop());
    for (const tool of ['draw', 'select', 'erase']) $('#tool-' + tool).addEventListener('click', () => this.setTool(tool));
    $('#zoomIn').addEventListener('click', () => this.roll.zoomAt(this.roll.KEYW + 40, 1.3));
    $('#zoomOut').addEventListener('click', () => this.roll.zoomAt(this.roll.KEYW + 40, 1 / 1.3));

    $('#btnNew').addEventListener('click', () => this.newSong());
    $('#btnOpen').addEventListener('click', () => this.openSong());
    $('#btnSave').addEventListener('click', () => this.saveSong(false));
    $('#btnSaveAs').addEventListener('click', () => this.saveSong(true));
    $('#btnMidi').addEventListener('click', () => $('#fileMidi').click());
    $('#btnExport').addEventListener('click', () => this.exportDialog());
    $('#btnDemo').addEventListener('click', () => this.demoDialog());
    $('#btnHelp').addEventListener('click', () => this.helpDialog());
    $('#addTrack').addEventListener('click', () => this.addTrack());

    $('#fileOpen').addEventListener('change', async e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) this.loadSongText(await f.text(), f.name);
    });
    $('#fileMidi').addEventListener('change', async e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) this.importMidi(await f.arrayBuffer(), f.name);
    });

    // Drag & drop .mid or .json onto the window.
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', async e => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (!f) return;
      if (/\.midi?$/i.test(f.name)) this.importMidi(await f.arrayBuffer(), f.name);
      else if (/\.json$/i.test(f.name)) this.loadSongText(await f.text(), f.name);
    });

    // Buttons shouldn't keep keyboard focus (Space would click them again).
    document.addEventListener('click', e => { if (e.target.closest('button')) e.target.closest('button').blur(); });

    this.buildTransformPanel();
  },

  buildTransformPanel() {
    const box = $('#transform');
    const scope = h('select', { id: 'tfScope' },
      h('option', { value: 'selection' }, 'Selected notes'),
      h('option', { value: 'track' }, 'This whole track'),
      h('option', { value: 'all' }, 'Every track'));
    const btn = (label, op, title) => h('button', { onclick: () => this.transform(op), title }, label);
    box.append(
      h('h3', {}, 'Change notes'),
      h('div', { class: 'row' }, h('label', {}, 'Apply to'), scope),
      h('div', { class: 'btns' },
        btn('−Oct', 'down12', 'Down one octave (Shift+↓)'), btn('−1', 'down1', 'Down a half step (↓)'),
        btn('+1', 'up1', 'Up a half step (↑)'), btn('+Oct', 'up12', 'Up one octave (Shift+↑)')),
      h('div', { class: 'btns' },
        btn('Major → Minor', 'minor', 'Lower the 3rd, 6th and 7th notes of the key. Makes a hymn sound darker.'),
        btn('Minor → Major', 'major', 'Raise the 3rd, 6th and 7th notes of the key.')),
      h('div', { class: 'btns' },
        btn('Half speed', 'half', 'Stretch notes to twice as long'),
        btn('Double speed', 'double', 'Squeeze notes to half as long'),
        btn('Quantize', 'quantize', 'Snap note starts and lengths to the Snap grid')),
      h('div', { class: 'btns' },
        btn('Louder', 'louder', 'Raise note velocity'), btn('Softer', 'softer', 'Lower note velocity'),
        btn('Legato', 'legato', 'Stretch each note until the next one starts (smooth, hymn-like)')),
      h('h3', {}, 'Selection'),
      h('div', { class: 'btns' },
        h('button', { onclick: () => this.selectAll(), title: 'Ctrl+A' }, 'Select all'),
        h('button', { onclick: () => this.selectLine('top'), title: 'Select the highest note at each moment — usually the melody of a hymn' }, 'Top line'),
        h('button', { onclick: () => this.selectLine('bottom'), title: 'Select the lowest note at each moment — usually the bass part' }, 'Bottom line')),
      h('div', { class: 'btns' },
        h('button', { onclick: () => this.selectionToNewTrack(false), title: 'Move the selected notes onto their own track' }, 'Move → new track'),
        h('button', { onclick: () => this.selectionToNewTrack(true), title: 'Copy the selected notes onto a new track' }, 'Copy → new track')),
      h('div', { id: 'selInfo' }),
    );
  },

  renderTopbar() {
    const s = this.song;
    if (document.activeElement !== $('#songTitle')) $('#songTitle').value = s.title;
    document.title = s.title + ' – Composer';
    $('#bpm').value = s.bpm;
    $('#bars').value = s.bars;
    $('#tsNum').value = s.timeSig.num;
    $('#tsDen').value = s.timeSig.den;
    $('#keyRoot').value = s.key.root;
    $('#keyScale').value = s.key.scale;
    $('#btnLoop').classList.toggle('on', s.loop.enabled);
    for (const tool of ['draw', 'select', 'erase']) $('#tool-' + tool).classList.toggle('on', this.tool === tool);
  },

  renderTracks() {
    const box = $('#trackList');
    box.innerHTML = '';
    for (const t of this.song.tracks) {
      const inst = Instruments.get(t.instrument);
      const row = h('div', { 'data-id': t.id, class: 'track' + (t.id === this.trackId ? ' selected' : ''), style: `--c:${t.color}`, onmousedown: () => this.selectTrack(t.id) },
        h('span', {
          class: 'swatch', title: 'Change color',
          onclick: e => {
            e.stopPropagation();
            const i = Song.COLORS.indexOf(t.color);
            t.color = Song.COLORS[(i + 1) % Song.COLORS.length];
            this.changed();
            this.renderTracks();
          },
        }),
        h('span', { class: 'ticon', title: inst.name }, inst.icon),
        h('input', {
          class: 'tname', value: t.name,
          oninput: e => { t.name = e.target.value; this.changed('name:' + t.id); this.roll.dirty = true; },
        }),
        h('button', { class: 'ms' + (t.mute ? ' on mute' : ''), title: 'Mute', onclick: e => { e.stopPropagation(); t.mute = !t.mute; this.changed(); this.renderTracks(); } }, 'M'),
        h('button', { class: 'ms' + (t.solo ? ' on solo' : ''), title: 'Solo (only hear this track)', onclick: e => { e.stopPropagation(); t.solo = !t.solo; this.changed(); this.renderTracks(); } }, 'S'),
      );
      box.append(row);
    }
  },

  slider(label, value, min, max, step, fmt, onInput, key) {
    const val = h('span', { class: 'val' }, fmt(value));
    const input = h('input', { type: 'range', min, max, step, value });
    input.addEventListener('input', () => {
      const v = +input.value;
      val.textContent = fmt(v);
      onInput(v);
      this.changed(key);
    });
    return h('div', { class: 'row' }, h('label', {}, label), input, val);
  },

  row(label, control, hint) {
    return h('div', { class: 'row' + (hint ? ' hinted' : ''), title: hint || '' }, h('label', {}, label), control);
  },

  renderInspector() {
    const box = $('#inspector');
    box.innerHTML = '';
    const t = this.currentTrack();
    if (!t) return;
    const fx = t.fx;
    const pct = v => Math.round(v * 100) + '%';
    const k = name => t.id + ':' + name;

    const inst = h('select');
    const cats = [...new Set(Instruments.list.map(i => i.category))];
    for (const c of cats) {
      inst.append(h('optgroup', { label: c }, Instruments.list.filter(i => i.category === c).map(i => h('option', { value: i.id }, `${i.icon}  ${i.name}`))));
    }
    inst.value = t.instrument;
    inst.addEventListener('change', () => {
      const wasDrums = Instruments.get(t.instrument).drums;
      t.instrument = inst.value;
      this.changed();
      this.renderTracks();
      if (wasDrums !== !!Instruments.get(t.instrument).drums) this.roll.centerOnTrack();
      this.engine.preview(t, Instruments.get(t.instrument).drums ? 38 : 60, 0.5);
    });

    box.append(
      h('h3', {}, 'Track sound'),
      this.row('Instrument', inst),
      this.slider('Volume', t.volume, 0, 1.5, 0.01, pct, v => { t.volume = v; }, k('vol')),
      this.slider('Pan', t.pan, -1, 1, 0.01, v => (Math.abs(v) < 0.02 ? 'Center' : (v < 0 ? 'L ' : 'R ') + Math.round(Math.abs(v) * 100)), v => { t.pan = v; }, k('pan')),
      h('h4', {}, '🌠 Space effects'),
      this.slider('Reverb', fx.reverb, 0, 1, 0.01, pct, v => { fx.reverb = v; }, k('rev')),
      this.slider('Echo', fx.delay.mix, 0, 0.8, 0.01, pct, v => { fx.delay.mix = v; }, k('dly')),
      this.row('Echo time', numSelect(ECHO_TIMES, fx.delay.beats, v => { fx.delay.beats = v; this.changed(); })),
      this.slider('Echo repeats', fx.delay.feedback, 0, 0.9, 0.01, pct, v => { fx.delay.feedback = v; }, k('fb')),
      this.slider('Brightness', cutoffToSlider(fx.filter.cutoff), 0, 1, 0.001, v => { const c = sliderToCutoff(v); return c >= 20000 ? 'Open' : c >= 1000 ? (c / 1000).toFixed(1) + 'k' : c + ' Hz'; }, v => { fx.filter.cutoff = sliderToCutoff(v); }, k('cut')),
      this.slider('Resonance', fx.filter.q, 0.5, 18, 0.1, v => v.toFixed(1), v => { fx.filter.q = v; }, k('q')),
      this.slider('Sweep', fx.filter.sweepDepth, 0, 1, 0.01, v => (v === 0 ? 'Off' : pct(v)), v => { fx.filter.sweepDepth = v; }, k('sweep')),
      this.row('Sweep length', numSelect(SWEEP_BEATS, fx.filter.sweepBeats, v => { fx.filter.sweepBeats = v; this.changed(); }), 'How long one wah-sweep of the filter takes. Lower Brightness first so the sweep is audible.'),
      h('h4', {}, '🌀 Arpeggiator', h('span', { class: 'hint' }, ' — turns held chords into fast note runs')),
      this.row('On', h('input', { type: 'checkbox', checked: fx.arp.on, onchange: e => { fx.arp.on = e.target.checked; this.changed(); } })),
      this.row('Speed', numSelect(ARP_RATES, fx.arp.rate, v => { fx.arp.rate = v; this.changed(); })),
      this.row('Pattern', (() => {
        const s = h('select', {}, ARP_MODES.map(([v, l]) => h('option', { value: v }, l)));
        s.value = fx.arp.mode;
        s.addEventListener('change', () => { fx.arp.mode = s.value; this.changed(); });
        return s;
      })()),
      this.row('Octaves', numSelect([[1, '1'], [2, '2'], [3, '3']], fx.arp.octaves, v => { fx.arp.octaves = v; this.changed(); })),
      this.slider('Note length', fx.arp.gate, 0.1, 1, 0.01, pct, v => { fx.arp.gate = v; }, k('gate')),
      h('div', { class: 'btns' },
        h('button', { onclick: () => this.moveTrack(-1), title: 'Move track up' }, '▲'),
        h('button', { onclick: () => this.moveTrack(1), title: 'Move track down' }, '▼'),
        h('button', { onclick: () => this.duplicateTrack() }, 'Duplicate'),
        h('button', { class: 'danger', onclick: () => this.deleteTrack() }, 'Delete track')),
    );
  },

  renderSongPanel() {
    const box = $('#songPanel');
    box.innerHTML = '';
    const m = this.song.master;
    box.append(
      h('h3', {}, 'Song'),
      this.slider('Master volume', m.volume, 0, 1.5, 0.01, v => Math.round(v * 100) + '%', v => { m.volume = v; }, 'mvol'),
      this.slider('Reverb size', m.reverbSeconds, 0.3, 8, 0.1, v => v.toFixed(1) + ' s', v => { m.reverbSeconds = v; }, 'rsize'),
      this.row('Follow playhead', h('input', { type: 'checkbox', checked: this.roll.follow, onchange: e => { this.roll.follow = e.target.checked; } })),
    );
  },

  onSelectionChanged() {
    const box = $('#selInfo');
    if (!box) return;
    box.innerHTML = '';
    const sel = [...this.roll.selection];
    if (!sel.length) {
      box.append(h('p', { class: 'hint' }, 'Nothing selected. Drag on empty space with the Select tool (or Ctrl+drag) to select notes.'));
    } else {
      const avg = sel.reduce((a, n) => a + n.v, 0) / sel.length;
      box.append(
        h('p', { class: 'hint' }, `${sel.length} note${sel.length > 1 ? 's' : ''} selected`),
        this.slider('Velocity', avg, 0.05, 1, 0.01, v => Math.round(v * 100) + '%', v => { for (const n of sel) n.v = v; this.velocity = v; this.roll.dirty = true; }, 'vel'),
      );
    }
    this.renderStatus();
  },

  renderStatus() {
    const r = this.roll, s = this.song;
    if (!s) return;
    const parts = [];
    const bpb = Song.beatsPerBar(s), unit = 4 / s.timeSig.den;
    const pos = b => `bar ${Math.floor(b / bpb + EPS) + 1}, beat ${Math.floor((b % bpb) / unit + EPS) + 1}`;
    if (r.mouse.inside && r.mouse.x > r.KEYW && r.mouse.y > r.RULERH) {
      const p = r.pitchAt(r.mouse.y);
      parts.push(`${r.label(p)} · ${pos(Math.max(0, r.beatAt(r.mouse.x)))}`);
    }
    const t = this.currentTrack();
    if (t) parts.push(`${t.name}: ${t.notes.length} notes`);
    if (r.selection.size) parts.push(`${r.selection.size} selected`);
    const hints = {
      draw: 'Click to add a note · drag to make it longer · drag a note to move · drag its right edge to resize · right-click deletes',
      select: 'Drag a box to select · Shift adds · drag selected notes to move · Alt+drag copies',
      erase: 'Click or drag over notes to delete them',
    };
    parts.push(hints[this.tool]);
    $('#status').textContent = parts.join('   |   ');
  },

  // ------------------------------------------------------------ frame loop & transport
  frame() {
    const e = this.engine;
    if (e.playing) {
      if (e.isFinished()) this.stop();
      else {
        const b = e.currentBeat();
        this.roll.playBeat = b;
        this.roll.followPlayhead();
        this.roll.dirty = true;
        const s = this.song, bpb = Song.beatsPerBar(s), unit = 4 / s.timeSig.den;
        $('#clock').textContent = `${Math.floor(b / bpb + EPS) + 1}.${Math.floor((b % bpb) / unit + EPS) + 1}`;
      }
    }
    if (this.roll.dirty) this.roll.draw();
  },

  togglePlay() {
    if (this.engine.playing) this.stop();
    else this.play();
  },

  play() {
    if (this.playPos >= Song.lengthBeats(this.song)) this.playPos = 0;
    this.engine.play(this.playPos);
    $('#btnPlay').textContent = '■';
    $('#btnPlay').classList.add('on');
  },

  stop() {
    this.engine.stop();
    this.roll.playBeat = null;
    this.roll.dirty = true;
    $('#btnPlay').textContent = '▶';
    $('#btnPlay').classList.remove('on');
    $('#clock').textContent = '';
  },

  setPlayPos(b) {
    this.playPos = Math.max(0, b);
    if (this.engine.playing) this.engine.play(this.playPos);
    if (b === 0) { this.roll.scrollX = 0; this.roll.clampScroll(); }
    this.roll.dirty = true;
  },

  toggleLoop() {
    const L = this.song.loop;
    if (!L.enabled && !(L.end > L.start)) {
      L.start = 0;
      L.end = Song.lengthBeats(this.song);
    }
    L.enabled = !L.enabled;
    this.changed();
    this.renderTopbar();
    this.toast(L.enabled ? 'Loop on — drag along the ruler to change the loop region' : 'Loop off');
  },

  setTool(tool) {
    this.tool = tool;
    this.renderTopbar();
    this.renderStatus();
    this.roll.dirty = true;
  },

  // ------------------------------------------------------------ tracks
  addTrack() {
    const order = ['pad', 'bass', 'bell', 'lead', 'strings', 'drums', 'choir', 'pluck'];
    const used = new Set(this.song.tracks.map(t => t.instrument));
    const instrument = order.find(i => !used.has(i)) || 'organ';
    const name = Instruments.get(instrument).name.split(' ').pop();
    const t = Song.newTrack(this.song, { name, instrument });
    this.song.tracks.push(t);
    this.changed();
    this.trackId = t.id;
    this.refreshAll();
    this.roll.centerOnTrack();
  },

  duplicateTrack() {
    const t = this.currentTrack();
    if (!t) return;
    const c = JSON.parse(JSON.stringify(t));
    const n = Song.newTrack(this.song, { name: t.name + ' copy', instrument: c.instrument, volume: c.volume, pan: c.pan, fx: c.fx });
    n.notes = c.notes;
    this.song.tracks.splice(this.song.tracks.indexOf(t) + 1, 0, n);
    this.trackId = n.id;
    this.changed();
    this.refreshAll();
  },

  deleteTrack() {
    const t = this.currentTrack();
    if (!t) return;
    if (t.notes.length && !confirm(`Delete track "${t.name}" and its ${t.notes.length} notes? (You can undo with Ctrl+Z.)`)) return;
    const i = this.song.tracks.indexOf(t);
    this.song.tracks.splice(i, 1);
    if (!this.song.tracks.length) this.song.tracks.push(Song.newTrack(this.song, { name: 'Melody' }));
    this.trackId = this.song.tracks[Math.max(0, i - 1)].id;
    this.roll.selection = new Set();
    this.changed();
    this.refreshAll();
  },

  moveTrack(dir) {
    const tr = this.song.tracks, t = this.currentTrack();
    const i = tr.indexOf(t), j = i + dir;
    if (j < 0 || j >= tr.length) return;
    [tr[i], tr[j]] = [tr[j], tr[i]];
    this.changed();
    this.renderTracks();
  },

  // ------------------------------------------------------------ editing
  selectedNotes() {
    return [...this.roll.selection];
  },

  setSelection(notes) {
    this.roll.selection = new Set(notes);
    this.roll.selectionChanged();
  },

  selectAll() {
    const t = this.currentTrack();
    if (t) this.setSelection(t.notes);
  },

  // Highest (or lowest) note at each moment of the current track: pulls the melody/bass out of a 4-part hymn.
  selectLine(which) {
    const t = this.currentTrack();
    if (!t) return;
    const pick = t.notes.filter(n => !t.notes.some(m => m !== n &&
      (which === 'top' ? m.p > n.p : m.p < n.p) &&
      m.s < n.s + n.d - EPS && m.s + m.d > n.s + EPS &&
      // only count notes that overlap most of this one
      Math.min(m.s + m.d, n.s + n.d) - Math.max(m.s, n.s) >= Math.min(n.d, m.d) * 0.5));
    this.setSelection(pick);
    this.toast(`Selected ${pick.length} ${which === 'top' ? 'top' : 'bottom'} notes`);
  },

  selectionToNewTrack(copy) {
    const t = this.currentTrack();
    const sel = this.selectedNotes();
    if (!t || !sel.length) return this.toast('Select some notes first');
    const n = Song.newTrack(this.song, { name: t.name + (copy ? ' copy' : ' part'), instrument: t.instrument });
    n.notes = sel.map(x => ({ ...x })).sort((a, b) => a.s - b.s || a.p - b.p);
    if (!copy) {
      const kill = new Set(sel);
      t.notes = t.notes.filter(x => !kill.has(x));
    }
    this.song.tracks.splice(this.song.tracks.indexOf(t) + 1, 0, n);
    this.trackId = n.id;
    this.roll.selection = new Set();
    this.changed();
    this.refreshAll();
    this.toast(`${copy ? 'Copied' : 'Moved'} ${sel.length} notes to "${n.name}"`);
  },

  deleteSelection() {
    const t = this.currentTrack();
    const sel = new Set(this.selectedNotes());
    if (!t || !sel.size) return;
    t.notes = t.notes.filter(n => !sel.has(n));
    this.setSelection([]);
    this.changed();
  },

  copySelection(cut) {
    const sel = this.selectedNotes();
    if (!sel.length) return;
    const min = Math.min(...sel.map(n => n.s));
    this.clipboard = sel.map(n => ({ ...n, s: n.s - min }));
    if (cut) this.deleteSelection();
    this.toast(`${cut ? 'Cut' : 'Copied'} ${sel.length} notes`);
  },

  paste() {
    const t = this.currentTrack();
    if (!t || !this.clipboard) return;
    const notes = this.clipboard.map(n => ({ ...n, s: n.s + this.playPos }));
    t.notes.push(...notes);
    t.notes.sort((a, b) => a.s - b.s || a.p - b.p);
    this.setSelection(notes);
    this.changed();
    this.toast('Pasted at the green start marker');
  },

  duplicateSelection() {
    const t = this.currentTrack();
    const sel = this.selectedNotes();
    if (!t || !sel.length) return;
    const min = Math.min(...sel.map(n => n.s)), max = Math.max(...sel.map(n => n.s + n.d));
    const step = this.roll.snapStep;
    const off = Math.ceil((max - min) / step - EPS) * step;
    const notes = sel.map(n => ({ ...n, s: n.s + off }));
    t.notes.push(...notes);
    t.notes.sort((a, b) => a.s - b.s || a.p - b.p);
    this.setSelection(notes);
    this.changed();
  },

  nudge(dBeats, dPitch) {
    const sel = this.selectedNotes();
    if (!sel.length) return;
    const minS = Math.min(...sel.map(n => n.s));
    dBeats = Math.max(dBeats, -minS);
    for (const n of sel) {
      n.s += dBeats;
      n.p = Math.max(0, Math.min(127, n.p + dPitch));
    }
    if (dPitch && sel.length) this.engine.preview(this.currentTrack(), sel[0].p, 0.2);
    this.currentTrack().notes.sort((a, b) => a.s - b.s || a.p - b.p);
    this.changed('nudge');
  },

  transform(op) {
    const scope = $('#tfScope').value;
    const song = this.song, root = song.key.root;
    const pitchOp = ['up1', 'down1', 'up12', 'down12', 'minor', 'major'].includes(op);
    let groups = [];
    if (scope === 'selection') {
      const sel = this.selectedNotes();
      if (!sel.length) return this.toast('No notes selected — choose "This whole track" or select some notes');
      groups = [{ track: this.currentTrack(), notes: sel }];
    } else if (scope === 'track') {
      const t = this.currentTrack();
      groups = [{ track: t, notes: t.notes }];
    } else groups = song.tracks.map(t => ({ track: t, notes: t.notes }));
    if (pitchOp) groups = groups.filter(g => !Instruments.get(g.track.instrument).drums);

    const shift = { up1: 1, down1: -1, up12: 12, down12: -12 }[op];
    let count = 0;
    for (const { track, notes } of groups) {
      const minS = scope === 'selection' ? Math.min(...notes.map(n => n.s)) : 0;
      for (const n of notes) {
        count++;
        if (shift) n.p = Math.max(0, Math.min(127, n.p + shift));
        else if (op === 'minor') n.p = Music.majorToMinor(n.p, root);
        else if (op === 'major') n.p = Music.minorToMajor(n.p, root);
        else if (op === 'half' || op === 'double') {
          const f = op === 'half' ? 2 : 0.5;
          n.s = minS + (n.s - minS) * f;
          n.d *= f;
        } else if (op === 'quantize') {
          n.s = this.roll.snapRound(n.s);
          n.d = Math.max(this.roll.snapStep, this.roll.snapRound(n.d));
        } else if (op === 'louder') n.v = Math.min(1, n.v + 0.1);
        else if (op === 'softer') n.v = Math.max(0.05, n.v - 0.1);
      }
      if (op === 'legato') {
        const sorted = notes.slice().sort((a, b) => a.s - b.s);
        const starts = [...new Set(sorted.map(n => n.s))];
        for (const n of sorted) {
          const next = starts.find(s => s > n.s + EPS);
          if (next !== undefined) n.d = next - n.s;
        }
      }
      track.notes.sort((a, b) => a.s - b.s || a.p - b.p);
    }
    if (scope === 'all') {
      if (op === 'minor' && song.key.scale === 'major') song.key.scale = 'minor';
      if (op === 'major' && song.key.scale === 'minor') song.key.scale = 'major';
      if (op === 'half' || op === 'double') {
        const f = op === 'half' ? 2 : 0.5;
        song.loop.start *= f;
        song.loop.end *= f;
        song.bars = Math.max(1, Math.ceil(song.bars * f));
      }
    }
    this.changed();
    this.renderTopbar();
    this.roll.dirty = true;
    this.toast(`Changed ${count} notes`);
  },

  // ------------------------------------------------------------ keyboard
  bindKeys() {
    window.addEventListener('keydown', e => {
      const tag = e.target.tagName;
      const typing = (tag === 'INPUT' && !['range', 'checkbox'].includes(e.target.type)) || tag === 'TEXTAREA' || tag === 'SELECT';
      if (!$('#modal').hidden) {
        if (e.key === 'Escape') this.closeModal();
        return;
      }
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (ctrl && k === 's') { e.preventDefault(); this.saveSong(e.shiftKey); return; }
      if (typing) return;
      let handled = true;
      if (k === ' ') this.togglePlay();
      else if (ctrl && k === 'z' && !e.shiftKey) this.undo();
      else if ((ctrl && k === 'y') || (ctrl && k === 'z' && e.shiftKey)) this.redo();
      else if (ctrl && k === 'a') this.selectAll();
      else if (ctrl && k === 'c') this.copySelection(false);
      else if (ctrl && k === 'x') this.copySelection(true);
      else if (ctrl && k === 'v') this.paste();
      else if (ctrl && k === 'd') this.duplicateSelection();
      else if (ctrl && k === 'o') this.openSong();
      else if (ctrl) handled = false;
      else if (k === 'delete' || k === 'backspace') this.deleteSelection();
      else if (k === 'home') this.setPlayPos(0);
      else if (k === 'l') this.toggleLoop();
      else if (k === 'd') this.setTool('draw');
      else if (k === 's') this.setTool('select');
      else if (k === 'e') this.setTool('erase');
      else if (k === 'escape') this.setSelection([]);
      else if (k === 'arrowup') this.nudge(0, e.shiftKey ? 12 : 1);
      else if (k === 'arrowdown') this.nudge(0, e.shiftKey ? -12 : -1);
      else if (k === 'arrowright') this.nudge(e.shiftKey ? Song.beatsPerBar(this.song) : this.roll.snapStep, 0);
      else if (k === 'arrowleft') this.nudge(-(e.shiftKey ? Song.beatsPerBar(this.song) : this.roll.snapStep), 0);
      else if (/^[1-9]$/.test(k)) {
        const i = +k - 1;
        if (NOTE_LENGTHS[i]) {
          this.noteLen = NOTE_LENGTHS[i][0];
          $('#noteLen').value = i;
          this.roll.dirty = true;
        }
      } else if (k === '=' || k === '+') this.roll.zoomAt(this.roll.KEYW + 40, 1.3);
      else if (k === '-') this.roll.zoomAt(this.roll.KEYW + 40, 1 / 1.3);
      else handled = false;
      if (handled) e.preventDefault();
    });
  },

  // ------------------------------------------------------------ files
  newSong() {
    if (!confirm('Start a new empty song? (Save your current one first if you want to keep it.)')) return;
    this.stop();
    this.fileHandle = null;
    this.setSong(Song.create());
  },

  async openSong() {
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({ types: [{ description: 'Song file', accept: { 'application/json': ['.json'] } }] });
        const file = await handle.getFile();
        if (this.loadSongText(await file.text(), file.name)) this.fileHandle = handle;
      } catch (e) {
        if (e.name !== 'AbortError') this.toast('Could not open: ' + e.message);
      }
    } else $('#fileOpen').click();
  },

  loadSongText(text, name) {
    try {
      const raw = JSON.parse(text);
      const song = Song.normalize(raw);
      this.stop();
      this.fileHandle = null;
      this.setSong(song);
      this.toast('Opened ' + name);
      return true;
    } catch (e) {
      alert('That file could not be opened as a song:\n' + e.message);
      return false;
    }
  },

  async saveSong(saveAs) {
    const text = Song.serialize(this.song);
    const name = slug(this.song.title) + '.song.json';
    try {
      if (this.fileHandle && !saveAs) {
        const w = await this.fileHandle.createWritable();
        await w.write(text);
        await w.close();
        this.toast('Saved ' + this.fileHandle.name);
        return;
      }
      const handle = await this.saveBlob(new Blob([text], { type: 'application/json' }), name, 'Song file', 'application/json', '.json');
      if (handle) this.fileHandle = handle;
    } catch (e) {
      if (e.name !== 'AbortError') alert('Save failed: ' + e.message);
    }
  },

  // Uses the "Save as" dialog when the browser has one (Chrome/Edge), otherwise a normal download.
  async saveBlob(blob, name, description, mime, ext) {
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description, accept: { [mime]: [ext] } }] });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      this.toast('Saved ' + handle.name);
      return handle;
    }
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    this.toast('Downloaded ' + name);
    return null;
  },

  importMidi(buf, name) {
    let parts;
    try {
      parts = Midi.toSongParts(Midi.parse(buf), { quantize: true });
    } catch (e) {
      alert('Could not read that MIDI file:\n' + e.message);
      return;
    }
    const total = parts.tracks.reduce((a, t) => a + t.notes.length, 0);
    if (!total) return alert('That MIDI file has no notes in it.');
    const body = h('div', {},
      h('p', {}, `"${name}": ${parts.tracks.length} part${parts.tracks.length > 1 ? 's' : ''}, ${total} notes, ${parts.bpm} BPM, ${parts.timeSig.num}/${parts.timeSig.den} time.`),
      parts.tempoWarning ? h('p', { class: 'hint' }, 'This file changes tempo partway through. Only the first tempo is used.') : null,
      h('ul', { class: 'midiParts' }, parts.tracks.map(t => h('li', {}, `${Instruments.get(t.instrument).icon} ${t.name} — ${t.notes.length} notes`))),
      h('p', { class: 'hint' }, 'Tip: hymn MIDI files often put all four voices on one track. Use "Top line" then "Move → new track" to pull out the melody.'),
    );
    const build = replace => {
      const song = replace ? Song.create() : this.song;
      if (replace) {
        song.tracks = [];
        song.title = name.replace(/\.midi?$/i, '');
        song.bpm = parts.bpm;
        song.timeSig = parts.timeSig;
        if (parts.key) song.key = parts.key;
      }
      let first = null;
      for (const p of parts.tracks) {
        const t = Song.newTrack(song, { name: p.name, instrument: p.instrument });
        t.notes = p.notes;
        song.tracks.push(t);
        first = first || t;
      }
      song.bars = Math.max(replace ? 1 : song.bars, Math.ceil(Song.lastNoteEnd(song) / Song.beatsPerBar(song) - EPS));
      if (replace) {
        song.loop = { enabled: false, start: 0, end: Song.lengthBeats(song) };
        this.stop();
        this.fileHandle = null;
        this.setSong(song);
      } else {
        this.trackId = first.id;
        this.changed();
        this.refreshAll();
        this.roll.centerOnTrack();
      }
      this.closeModal();
      this.toast(`Imported ${total} notes`);
    };
    this.showModal('Import MIDI', body, [
      { label: 'Replace current song', primary: true, onclick: () => build(true) },
      { label: 'Add as new tracks', onclick: () => build(false) },
      { label: 'Cancel', onclick: () => this.closeModal() },
    ]);
  },

  exportDialog() {
    const L = this.song.loop;
    const hasLoop = L.end > L.start;
    const rangeSel = h('select', {},
      h('option', { value: 'song' }, 'Whole song (with reverb tail at the end)'),
      h('option', { value: 'loop', disabled: !hasLoop }, 'Loop region only — seamless game loop'));
    rangeSel.value = hasLoop && L.enabled ? 'loop' : 'song';
    const rate = h('select', {}, h('option', { value: 44100 }, '44100 Hz'), h('option', { value: 48000 }, '48000 Hz'));
    const norm = h('input', { type: 'checkbox', checked: true });
    const msg = h('p', { class: 'hint' });
    const body = h('div', {},
      this.row('Range', rangeSel),
      this.row('Sample rate', rate),
      this.row('Normalize volume', norm),
      h('p', { class: 'hint' },
        'This saves a .wav file. To make the smaller .ogg / .mp3 files the game should use, run ',
        h('code', {}, 'node composer/tools/convert-music.cjs your-file.wav'),
        ' (see composer/README.md).'),
      msg,
    );
    this.showModal('Export audio', body, [
      {
        label: 'Render & save WAV', primary: true, onclick: async btn => {
          btn.disabled = true;
          msg.textContent = 'Rendering…';
          try {
            const range = rangeSel.value;
            const res = await this.engine.render(this.song, { range, sampleRate: +rate.value, normalize: norm.checked });
            const wav = Wav.encode(res.channels, res.sampleRate);
            const name = slug(this.song.title) + (range === 'loop' ? '-loop' : '') + '.wav';
            msg.textContent = `Rendered ${res.seconds.toFixed(1)} s.`;
            await this.saveBlob(new Blob([wav], { type: 'audio/wav' }), name, 'WAV audio', 'audio/wav', '.wav');
            this.closeModal();
          } catch (e) {
            if (e.name !== 'AbortError') msg.textContent = 'Export failed: ' + e.message;
          }
          btn.disabled = false;
        },
      },
      { label: 'Cancel', onclick: () => this.closeModal() },
    ]);
  },

  demoDialog() {
    const body = h('div', {},
      h('p', { class: 'hint' }, 'Loading a demo replaces the current song. Save first if you want to keep it.'),
      Demo.list().map(d => h('div', { class: 'demoItem' },
        h('div', {}, h('b', {}, d.title), h('div', { class: 'hint' }, d.about)),
        h('button', {
          class: 'primary', onclick: () => {
            this.stop();
            this.fileHandle = null;
            this.setSong(d.build());
            this.closeModal();
            this.toast('Loaded ' + d.title + ' — press Space to play');
          },
        }, 'Load'))),
    );
    this.showModal('Demo songs', body, [{ label: 'Cancel', onclick: () => this.closeModal() }]);
  },

  helpDialog() {
    const rows = [
      ['Space', 'Play / stop'], ['Click ruler', 'Set the start point (green marker)'], ['Drag on ruler', 'Set the loop region (yellow)'],
      ['L', 'Loop on / off'], ['Home', 'Back to the beginning'], ['D / S / E', 'Draw, Select, Erase tools'],
      ['1 – 9', 'Choose note length'], ['Right-click', 'Delete a note'], ['Shift+click', 'Add a note to the selection'],
      ['Ctrl+drag', 'Box-select (in Draw tool)'], ['Alt+drag a note', 'Copy it'], ['↑ / ↓', 'Move selected notes up/down a half step'],
      ['Shift+↑ / ↓', 'Move an octave'], ['← / →', 'Move selected notes by the snap amount (Shift: a whole bar)'],
      ['Ctrl+C / X / V', 'Copy / cut / paste (pastes at the green marker)'], ['Ctrl+D', 'Duplicate selection right after itself'],
      ['Ctrl+Z / Ctrl+Y', 'Undo / redo'], ['Ctrl+S', 'Save song (Ctrl+Shift+S: Save as)'], ['Delete', 'Delete selected notes'],
      ['Mouse wheel', 'Scroll up/down (Shift: left/right)'], ['Ctrl+wheel', 'Zoom in/out (Ctrl+Shift+wheel: taller rows)'],
      ['Click the keyboard', 'Hear that note'],
    ];
    const body = h('div', {},
      h('p', {}, 'Each row is a note: higher row = higher pitch. Longer bar = note held longer. Rows with a green tick on the keyboard are in the song\'s key, so they\'ll sound "right". Black-key rows are sharps (♯) and flats (♭).'),
      h('table', { class: 'keys' }, rows.map(([k, d]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, d)))),
      h('p', { class: 'hint' }, 'Your work is autosaved in this browser, but use Save to keep a .song.json file you can edit later.'),
    );
    this.showModal('How to use the composer', body, [{ label: 'Got it', primary: true, onclick: () => this.closeModal() }]);
  },

  // ------------------------------------------------------------ modal & toast
  showModal(title, body, buttons) {
    const m = $('#modal');
    const box = m.querySelector('.box');
    box.innerHTML = '';
    const btns = h('div', { class: 'modalBtns' });
    for (const b of buttons) {
      const el = h('button', { class: b.primary ? 'primary' : '' }, b.label);
      el.addEventListener('click', () => b.onclick(el));
      btns.append(el);
    }
    box.append(h('h2', {}, title), body, btns);
    m.hidden = false;
  },

  closeModal() {
    $('#modal').hidden = true;
  },

  toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  },

  // ------------------------------------------------------------ self test (open index.html#selftest)
  async selfTest() {
    const out = [];
    const log = s => { out.push(s); console.log('[selftest] ' + s); };
    try {
      for (const d of Demo.list()) {
        const s = d.build();
        const t0 = performance.now();
        const r = await new Engine().render(s, { range: 'loop', normalize: false });
        const expected = (s.loop.end - s.loop.start) * 60 / s.bpm;
        log(`${d.id} loop ${r.seconds.toFixed(3)}s (expected ${expected.toFixed(3)}) peak=${r.peak.toFixed(3)} finite=${r.channels.every(c => c.every(Number.isFinite))} took ${((performance.now() - t0) / 1000).toFixed(1)}s`);
      }
      const song = Demo.amazingGrace();
      const ids = new Set(song.tracks.map(t => t.id));
      log(`demo tracks=${song.tracks.length} uniqueIds=${ids.size}`);
      const arp = Engine.expandTrack(song.tracks.find(t => t.fx.arp.on));
      log(`arp expanded notes=${arp.length}`);
      const eng = new Engine();
      const a = await eng.render(song, { range: 'song', normalize: false });
      const finite = a.channels.every(d => d.every(Number.isFinite));
      log(`song render ${a.seconds.toFixed(2)}s peak=${a.peak.toFixed(3)} finite=${finite}`);
      const b = await eng.render(song, { range: 'loop', normalize: true });
      const expected = (song.loop.end - song.loop.start) * 60 / song.bpm;
      log(`loop render ${b.seconds.toFixed(3)}s (expected ${expected.toFixed(3)}) peak=${b.peak.toFixed(3)}`);
      const wav = Wav.encode(b.channels, b.sampleRate);
      log(`wav bytes=${wav.byteLength}`);
      // Minimal MIDI: format 0, 96 ppq, 120bpm, 3/4, two notes.
      const bytes = [
        0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96,
        0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 34,
        0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
        0x00, 0xff, 0x58, 0x04, 0x03, 0x02, 0x18, 0x08,
        0x00, 0x90, 60, 100,
        0x60, 0x80, 60, 0,
        0x00, 0x90, 64, 90,
        0x30, 64, 0,
        0x00, 0xff, 0x2f, 0x00,
      ];
      const parts = Midi.toSongParts(Midi.parse(new Uint8Array(bytes).buffer));
      log(`midi bpm=${parts.bpm} ts=${parts.timeSig.num}/${parts.timeSig.den} notes=${JSON.stringify(parts.tracks[0].notes)}`);
      for (const inst of Instruments.list) {
        const ctx = new OfflineAudioContext(1, 22050, 22050);
        Instruments.play(ctx, ctx.destination, inst, 0, inst.drums ? 38 : 60, 0.4, 0.8);
        const r = await ctx.startRendering();
        let pk = 0;
        for (const x of r.getChannelData(0)) pk = Math.max(pk, Math.abs(x));
        log(`inst ${inst.id} peak=${pk.toFixed(3)}`);
      }
      this.roll.draw();
      log('DONE OK');
    } catch (e) {
      log('FAIL ' + e.stack);
    }
    const pre = h('pre', { id: 'selftest' }, out.join('\n'));
    document.body.append(pre);
  },
};

window.addEventListener('DOMContentLoaded', () => App.init());
