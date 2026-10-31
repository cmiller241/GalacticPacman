'use strict';
// The piano roll: a canvas grid where higher rows are higher notes and longer bars are longer notes.
class PianoRoll {
  constructor(canvas, app) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.app = app;
    this.KEYW = 78;
    this.RULERH = 30;
    this.minP = 21; // A0
    this.maxP = 108; // C8
    this.rowH = 16;
    this.beatW = 64;
    this.scrollX = 0;
    this.scrollY = 0;
    this.selection = new Set();
    this.drag = null;
    this.dirty = true;
    this.highlightScale = true;
    this.follow = true;
    this.playBeat = null;
    this.mouse = { x: -1, y: -1, inside: false };

    canvas.addEventListener('mousedown', e => this.onDown(e));
    window.addEventListener('mousemove', e => this.onMove(e));
    window.addEventListener('mouseup', e => this.onUp(e));
    canvas.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('mouseleave', () => { this.mouse.inside = false; this.dirty = true; this.app.renderStatus(); });
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
  }

  get song() { return this.app.song; }
  get track() { return this.app.currentTrack(); }
  get isDrums() { return this.track && Instruments.get(this.track.instrument).drums; }
  get snapStep() { return this.app.snap || 1 / 48; }

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = Math.max(200, Math.floor(r.width));
    this.h = Math.max(150, Math.floor(r.height));
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.clampScroll();
    this.dirty = true;
  }

  // ------------------------------------------------------------ coordinates
  xOf(b) { return this.KEYW + b * this.beatW - this.scrollX; }
  beatAt(x) { return (x - this.KEYW + this.scrollX) / this.beatW; }
  yOf(p) { return this.RULERH + (this.maxP - p) * this.rowH - this.scrollY; }
  pitchAt(y) { return this.maxP - Math.floor((y - this.RULERH + this.scrollY) / this.rowH); }
  snapRound(b) { const s = this.snapStep; return Math.round(b / s + EPS) * s; }
  snapFloor(b) { const s = this.snapStep; return Math.floor(b / s + EPS) * s; }
  clampP(p) { return Math.max(this.minP, Math.min(this.maxP, p)); }

  clampScroll() {
    const gridH = this.h - this.RULERH, gridW = this.w - this.KEYW;
    const totalH = (this.maxP - this.minP + 1) * this.rowH;
    this.scrollY = Math.max(0, Math.min(this.scrollY, totalH - gridH));
    const len = this.song ? Song.lengthBeats(this.song) + 8 : 64;
    this.scrollX = Math.max(0, Math.min(this.scrollX, len * this.beatW - gridW));
  }

  centerOnPitch(p) {
    this.scrollY = (this.maxP - p) * this.rowH - (this.h - this.RULERH) / 2;
    this.clampScroll();
    this.dirty = true;
  }

  centerOnTrack() {
    const t = this.track;
    if (t && t.notes.length) {
      let lo = 127, hi = 0;
      for (const n of t.notes) { lo = Math.min(lo, n.p); hi = Math.max(hi, n.p); }
      this.centerOnPitch(Math.round((lo + hi) / 2));
    } else this.centerOnPitch(this.isDrums ? 44 : 64);
  }

  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  noteAt(x, y) {
    const t = this.track;
    if (!t) return null;
    const b = this.beatAt(x), p = this.pitchAt(y);
    for (let i = t.notes.length - 1; i >= 0; i--) {
      const n = t.notes[i];
      if (n.p === p && b >= n.s && b < n.s + n.d) return n;
    }
    return null;
  }

  label(p) {
    if (this.isDrums) return Music.drumName(p) || Music.noteName(p, this.song.key);
    return Music.noteName(p, this.song.key);
  }

  selectionChanged() {
    this.dirty = true;
    this.app.onSelectionChanged();
  }

  // ------------------------------------------------------------ mouse
  onDown(e) {
    const { x, y } = this.local(e);
    const song = this.song, track = this.track;
    this.canvas.focus();
    if (y < this.RULERH && x > this.KEYW) {
      const b = Math.max(0, this.beatAt(x));
      const L = song.loop;
      const near = bb => Math.abs(this.xOf(bb) - x) < 7;
      let edge = null;
      if (L.enabled && near(L.start)) edge = 'start';
      else if (L.enabled && near(L.end)) edge = 'end';
      this.drag = { type: 'ruler', x0: x, b0: this.snapRound(b), edge, moved: false };
      return;
    }
    if (x < this.KEYW && y > this.RULERH) {
      const p = this.clampP(this.pitchAt(y));
      this.drag = { type: 'keys', p };
      this.app.engine.preview(track, p);
      return;
    }
    if (!track || y < this.RULERH) return;

    const b = Math.max(0, this.beatAt(x));
    const p = this.clampP(this.pitchAt(y));
    const hit = this.noteAt(x, y);

    if (e.button === 2 || this.app.tool === 'erase') {
      this.drag = { type: 'erase' };
      if (hit) this.removeNotes([hit]);
      return;
    }
    if (hit) {
      if (e.shiftKey) {
        if (this.selection.has(hit)) this.selection.delete(hit);
        else this.selection.add(hit);
        this.selectionChanged();
        return;
      }
      if (!this.selection.has(hit)) {
        this.selection = new Set([hit]);
        this.selectionChanged();
      }
      if (e.altKey) {
        // Alt-drag duplicates the selection.
        const copies = [...this.selection].map(n => ({ ...n }));
        track.notes.push(...copies);
        const anchor = copies[[...this.selection].indexOf(hit)];
        this.selection = new Set(copies);
        this.startMove(anchor, b, p);
        this.selectionChanged();
        return;
      }
      const rightEdge = this.xOf(hit.s + hit.d);
      if (x > rightEdge - 7 && rightEdge - this.xOf(hit.s) > 10) {
        this.drag = { type: 'resize', anchor: hit, orig: new Map([...this.selection].map(n => [n, n.d])) };
      } else {
        this.startMove(hit, b, p);
      }
      this.app.engine.preview(track, hit.p);
      return;
    }
    if (this.app.tool === 'select' || e.ctrlKey || e.metaKey || e.shiftKey) {
      this.drag = { type: 'marquee', x0: x, y0: y, x1: x, y1: y, base: e.shiftKey ? new Set(this.selection) : new Set() };
      return;
    }
    // Draw a new note.
    const n = { p, s: this.snapFloor(b), d: this.app.noteLen, v: this.app.velocity };
    track.notes.push(n);
    this.selection = new Set([n]);
    this.selectionChanged();
    this.drag = { type: 'new', note: n, x0: x, moved: false };
    this.app.engine.preview(track, p, Instruments.get(track.instrument).drums ? 0.2 : Math.min(1, n.d * 60 / song.bpm));
    this.app.markDirty();
  }

  startMove(anchor, b, p) {
    this.drag = {
      type: 'move', anchor, b0: b, p0: p, lastP: anchor.p,
      orig: new Map([...this.selection].map(n => [n, { s: n.s, p: n.p }])),
    };
  }

  removeNotes(list) {
    const t = this.track;
    const kill = new Set(list);
    t.notes = t.notes.filter(n => !kill.has(n));
    for (const n of list) this.selection.delete(n);
    this.app.markDirty();
    this.selectionChanged();
  }

  onMove(e) {
    const { x, y } = this.local(e);
    this.mouse = { x, y, inside: x >= 0 && y >= 0 && x < this.w && y < this.h };
    const d = this.drag;
    if (!d) {
      if (this.mouse.inside) this.updateCursor(x, y);
      this.dirty = true;
      this.app.renderStatus();
      return;
    }
    const b = Math.max(0, this.beatAt(x));
    const p = this.clampP(this.pitchAt(y));
    const song = this.song;
    switch (d.type) {
      case 'ruler': {
        if (Math.abs(x - d.x0) > 4) d.moved = true;
        if (!d.moved) break;
        const sb = this.snapRound(b);
        const L = song.loop;
        if (d.edge === 'start') L.start = Math.min(sb, L.end - this.snapStep);
        else if (d.edge === 'end') L.end = Math.max(sb, L.start + this.snapStep);
        else {
          L.start = Math.min(d.b0, sb);
          L.end = Math.max(d.b0, sb);
          L.enabled = L.end > L.start;
        }
        L.start = Math.max(0, L.start);
        this.app.renderTopbar();
        break;
      }
      case 'keys':
        if (p !== d.p) {
          d.p = p;
          this.app.engine.preview(this.track, p);
        }
        break;
      case 'erase': {
        const hit = this.noteAt(x, y);
        if (hit) this.removeNotes([hit]);
        break;
      }
      case 'move': {
        const o = d.orig.get(d.anchor);
        let dS = this.snapRound(o.s + (b - d.b0)) - o.s;
        let dP = p - d.p0;
        let minS = Infinity, minP = 127, maxP = 0;
        for (const v of d.orig.values()) { minS = Math.min(minS, v.s); minP = Math.min(minP, v.p); maxP = Math.max(maxP, v.p); }
        dS = Math.max(dS, -minS);
        dP = Math.max(this.minP - minP, Math.min(this.maxP - maxP, dP));
        for (const [n, v] of d.orig) { n.s = v.s + dS; n.p = v.p + dP; }
        if (d.anchor.p !== d.lastP) {
          d.lastP = d.anchor.p;
          this.app.engine.preview(this.track, d.anchor.p, 0.25);
        }
        this.app.markDirty();
        break;
      }
      case 'resize': {
        const a = d.anchor;
        const minLen = this.snapStep;
        const newEnd = Math.max(a.s + minLen, this.snapRound(b));
        const delta = newEnd - (a.s + d.orig.get(a));
        for (const [n, od] of d.orig) n.d = Math.max(minLen, od + delta);
        this.app.markDirty();
        break;
      }
      case 'new': {
        if (Math.abs(x - d.x0) > 4) d.moved = true;
        if (d.moved) {
          const n = d.note;
          n.d = Math.max(this.snapStep, this.snapRound(b) - n.s);
          this.app.markDirty();
        }
        break;
      }
      case 'marquee': {
        d.x1 = x; d.y1 = y;
        const b0 = this.beatAt(Math.min(d.x0, x)), b1 = this.beatAt(Math.max(d.x0, x));
        const pTop = this.pitchAt(Math.min(d.y0, y)), pBot = this.pitchAt(Math.max(d.y0, y));
        const sel = new Set(d.base);
        for (const n of this.track.notes) {
          if (n.p <= pTop && n.p >= pBot && n.s < b1 && n.s + n.d > b0) sel.add(n);
        }
        this.selection = sel;
        this.selectionChanged();
        break;
      }
    }
    this.dirty = true;
    this.app.renderStatus();
  }

  onUp(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.type === 'ruler' && !d.moved) {
      this.app.setPlayPos(d.b0);
    } else if (d.type === 'ruler') {
      this.app.changed('loop');
      this.app.renderTopbar();
    } else if (d.type !== 'keys' && d.type !== 'marquee') {
      this.track.notes.sort((a, b) => a.s - b.s || a.p - b.p);
      this.app.changed();
    }
    this.dirty = true;
  }

  updateCursor(x, y) {
    let c = 'default';
    if (y < this.RULERH) c = 'pointer';
    else if (x < this.KEYW) c = 'pointer';
    else {
      const hit = this.noteAt(x, y);
      if (this.app.tool === 'erase') c = 'not-allowed';
      else if (hit) {
        const re = this.xOf(hit.s + hit.d);
        c = x > re - 7 && re - this.xOf(hit.s) > 10 ? 'ew-resize' : 'move';
      } else c = this.app.tool === 'draw' ? 'crosshair' : 'default';
    }
    this.canvas.style.cursor = c;
  }

  onWheel(e) {
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : 1;
    const dx = e.deltaX * k, dy = e.deltaY * k;
    const { x, y } = this.local(e);
    if (e.ctrlKey || e.metaKey) {
      const f = dy < 0 ? 1.15 : 1 / 1.15;
      if (e.shiftKey) {
        const p = this.pitchAt(y);
        const offset = y - this.yOf(p);
        this.rowH = Math.max(8, Math.min(40, this.rowH * f));
        this.scrollY += this.yOf(p) + offset - y;
      } else this.zoomAt(x, f);
    } else if (e.shiftKey) {
      this.scrollX += dy || dx;
    } else {
      this.scrollX += dx;
      this.scrollY += dy;
    }
    this.clampScroll();
    this.dirty = true;
  }

  zoomAt(x, f) {
    const b = this.beatAt(x);
    this.beatW = Math.max(8, Math.min(400, this.beatW * f));
    this.scrollX = b * this.beatW - (x - this.KEYW);
    this.clampScroll();
    this.dirty = true;
  }

  followPlayhead() {
    if (!this.follow || this.playBeat === null || this.drag) return;
    const x = this.xOf(this.playBeat);
    if (x > this.w - 40 || x < this.KEYW) {
      this.scrollX = this.playBeat * this.beatW - 40;
      this.clampScroll();
    }
  }

  // ------------------------------------------------------------ drawing
  draw() {
    this.dirty = false;
    const g = this.g, W = this.w, H = this.h, song = this.song, track = this.track;
    const K = this.KEYW, R = this.RULERH;
    if (!song) return;
    const key = song.key;
    const bpb = Song.beatsPerBar(song);
    const unit = 4 / song.timeSig.den; // beat line spacing (quarter notes)
    const songEnd = Song.lengthBeats(song);
    const drums = this.isDrums;

    g.fillStyle = '#0b0d1a';
    g.fillRect(0, 0, W, H);

    // ---- rows
    const pTop = Math.min(this.maxP, this.pitchAt(R));
    const pBot = Math.max(this.minP, this.pitchAt(H));
    g.save();
    g.beginPath();
    g.rect(K, R, W - K, H - R);
    g.clip();
    for (let p = pTop; p >= pBot; p--) {
      const y = this.yOf(p);
      let c;
      if (drums) c = Music.drumName(p) ? '#171b33' : '#0e1124';
      else {
        const black = Music.isBlack(p);
        const inS = Music.inScale(p, key);
        if (this.highlightScale) {
          c = inS ? (black ? '#1a1f3d' : '#1c2142') : '#0d1022';
          if (((p - key.root) % 12 + 12) % 12 === 0) c = '#24294f';
        } else c = black ? '#121530' : '#1a1e3b';
      }
      g.fillStyle = c;
      g.fillRect(K, y, W - K, this.rowH);
      g.fillStyle = p % 12 === 0 ? '#2e3463' : '#141731';
      g.fillRect(K, y + this.rowH - 1, W - K, 1);
    }

    // ---- past the end of the song
    const xEnd = this.xOf(songEnd);
    if (xEnd < W) {
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(Math.max(K, xEnd), R, W, H);
    }

    // ---- loop region
    const L = song.loop;
    if (L.enabled && L.end > L.start) {
      g.fillStyle = 'rgba(255, 209, 102, 0.05)';
      g.fillRect(this.xOf(L.start), R, (L.end - L.start) * this.beatW, H);
    }

    // ---- vertical lines
    const b0 = Math.max(0, this.beatAt(K)), b1 = this.beatAt(W);
    const snap = this.snapStep;
    if (snap * this.beatW >= 6) {
      g.fillStyle = 'rgba(255,255,255,0.035)';
      for (let i = Math.floor(b0 / snap); i * snap <= b1; i++) g.fillRect(Math.round(this.xOf(i * snap)), R, 1, H);
    }
    g.fillStyle = 'rgba(255,255,255,0.08)';
    for (let i = Math.floor(b0 / unit); i * unit <= b1; i++) g.fillRect(Math.round(this.xOf(i * unit)), R, 1, H);
    g.fillStyle = 'rgba(160,170,255,0.3)';
    for (let i = Math.floor(b0 / bpb); i * bpb <= b1; i++) g.fillRect(Math.round(this.xOf(i * bpb)), R, 1, H);

    // ---- ghost notes from other tracks
    for (const t of song.tracks) {
      if (t === track) continue;
      g.fillStyle = t.color;
      g.globalAlpha = t.mute ? 0.08 : 0.22;
      for (const n of t.notes) {
        if (n.s > b1 || n.s + n.d < b0 || n.p > pTop || n.p < pBot) continue;
        g.fillRect(this.xOf(n.s), this.yOf(n.p) + 2, Math.max(2, n.d * this.beatW - 1), this.rowH - 4);
      }
    }
    g.globalAlpha = 1;

    // ---- this track's notes
    if (track) {
      const inst = Instruments.get(track.instrument);
      g.font = `${Math.min(12, this.rowH - 4)}px system-ui, sans-serif`;
      g.textBaseline = 'middle';
      for (const n of track.notes) {
        if (n.s > b1 || n.s + n.d < b0 || n.p > pTop || n.p < pBot) continue;
        const x = this.xOf(n.s), y = this.yOf(n.p);
        const w = Math.max(3, n.d * this.beatW - 1), h = this.rowH - 1;
        const sel = this.selection.has(n);
        g.globalAlpha = 0.45 + 0.55 * n.v;
        g.fillStyle = track.color;
        this.roundRect(x, y + 0.5, w, h - 1, Math.min(4, h / 3));
        g.fill();
        g.globalAlpha = 1;
        // velocity bar along the bottom
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(x + 1, y + h - 3, (w - 2) * n.v, 2);
        if (sel) {
          g.strokeStyle = '#ffffff';
          g.lineWidth = 2;
          this.roundRect(x, y + 0.5, w, h - 1, Math.min(4, h / 3));
          g.stroke();
        }
        if (this.rowH >= 12 && w > 16) {
          g.save();
          g.beginPath();
          g.rect(x, y, w - 2, h);
          g.clip();
          g.fillStyle = '#0b0d1a';
          let tx = x + 3;
          if (w > 30) {
            g.fillText(inst.icon, tx, y + h / 2);
            tx += this.rowH;
          }
          if (w > 44) g.fillText(this.label(n.p), tx, y + h / 2 + 0.5);
          g.restore();
        }
      }
    }

    // ---- marquee
    const d = this.drag;
    if (d && d.type === 'marquee') {
      g.strokeStyle = '#9fd3ff';
      g.setLineDash([4, 3]);
      g.lineWidth = 1;
      g.strokeRect(Math.min(d.x0, d.x1) + 0.5, Math.min(d.y0, d.y1) + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      g.setLineDash([]);
      g.fillStyle = 'rgba(159,211,255,0.08)';
      g.fillRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    }

    // ---- hover ghost (where a click would put a note)
    if (!d && this.mouse.inside && this.mouse.x > K && this.mouse.y > R && this.app.tool === 'draw' && track && !this.noteAt(this.mouse.x, this.mouse.y)) {
      const hb = this.snapFloor(Math.max(0, this.beatAt(this.mouse.x)));
      const hp = this.pitchAt(this.mouse.y);
      g.strokeStyle = track.color;
      g.globalAlpha = 0.6;
      g.lineWidth = 1;
      g.strokeRect(this.xOf(hb) + 0.5, this.yOf(hp) + 0.5, this.app.noteLen * this.beatW - 1, this.rowH - 1);
      g.globalAlpha = 1;
    }

    // ---- play start marker & playhead
    const xs = this.xOf(this.app.playPos);
    g.strokeStyle = '#7ae582';
    g.setLineDash([3, 4]);
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(Math.round(xs) + 0.5, R);
    g.lineTo(Math.round(xs) + 0.5, H);
    g.stroke();
    g.setLineDash([]);
    if (this.playBeat !== null) {
      const xp = this.xOf(this.playBeat);
      g.fillStyle = '#ffffff';
      g.fillRect(Math.round(xp), R, 2, H);
    }
    g.restore();

    // ---- keyboard
    g.save();
    g.beginPath();
    g.rect(0, R, K, H - R);
    g.clip();
    g.font = `${Math.min(11, this.rowH - 3)}px system-ui, sans-serif`;
    g.textBaseline = 'middle';
    for (let p = pTop; p >= pBot; p--) {
      const y = this.yOf(p);
      const hover = this.mouse.inside && this.mouse.x < K && this.pitchAt(this.mouse.y) === p;
      if (drums) {
        g.fillStyle = hover ? '#3a4280' : Music.drumName(p) ? '#262b52' : '#15182e';
        g.fillRect(0, y, K, this.rowH - 1);
        if (this.rowH >= 10) {
          g.fillStyle = Music.drumName(p) ? '#e8eaff' : '#5a5f88';
          g.fillText(Music.drumName(p) || Music.noteName(p, key), 6, y + this.rowH / 2);
        }
        continue;
      }
      const black = Music.isBlack(p);
      g.fillStyle = black ? (hover ? '#555c99' : '#20233d') : (hover ? '#c9d0ff' : '#e8eaf6');
      g.fillRect(0, y, black ? K * 0.62 : K, this.rowH - (black ? 0 : 1));
      if (black) {
        g.fillStyle = '#e8eaf6';
        g.fillRect(K * 0.62, y, K * 0.38, this.rowH - 1);
      }
      const isC = p % 12 === 0;
      if (this.rowH >= 13 || isC) {
        g.fillStyle = black ? '#c8ccf0' : isC ? '#1b1f4a' : '#555a80';
        if (isC) g.font = `bold ${Math.min(11, this.rowH - 3)}px system-ui, sans-serif`;
        g.fillText(Music.noteName(p, key), 5, y + this.rowH / 2);
        if (isC) g.font = `${Math.min(11, this.rowH - 3)}px system-ui, sans-serif`;
      }
      if (this.highlightScale && Music.inScale(p, key)) {
        g.fillStyle = 'rgba(122,229,130,0.85)';
        g.fillRect(K - 4, y + 2, 3, this.rowH - 5);
      }
    }
    g.restore();

    // ---- ruler
    g.fillStyle = '#14172c';
    g.fillRect(K, 0, W - K, R);
    if (L.enabled && L.end > L.start) {
      const x0 = this.xOf(L.start), x1 = this.xOf(L.end);
      g.fillStyle = 'rgba(255, 209, 102, 0.35)';
      g.fillRect(x0, R - 10, x1 - x0, 10);
      g.fillStyle = '#ffd166';
      g.fillRect(x0 - 1, R - 14, 3, 14);
      g.fillRect(x1 - 1, R - 14, 3, 14);
    }
    g.font = '11px system-ui, sans-serif';
    g.textBaseline = 'top';
    const barPx = bpb * this.beatW;
    const every = barPx < 28 ? Math.ceil(28 / barPx) : 1;
    for (let i = Math.floor(b0 / bpb); i * bpb <= b1; i++) {
      const x = this.xOf(i * bpb);
      g.fillStyle = 'rgba(160,170,255,0.5)';
      g.fillRect(Math.round(x), 0, 1, R);
      if (i % every === 0 && x >= K - 1) {
        g.fillStyle = '#aab0e0';
        g.fillText(String(i + 1), x + 4, 4);
      }
    }
    if (this.beatW * unit >= 18) {
      g.fillStyle = 'rgba(160,170,255,0.25)';
      for (let i = Math.floor(b0 / unit); i * unit <= b1; i++) g.fillRect(Math.round(this.xOf(i * unit)), R - 6, 1, 6);
    }
    // play markers on ruler
    g.fillStyle = '#7ae582';
    g.beginPath();
    g.moveTo(xs - 5, 0); g.lineTo(xs + 5, 0); g.lineTo(xs, 8);
    g.fill();
    if (this.playBeat !== null) {
      const xp = this.xOf(this.playBeat);
      g.fillStyle = '#fff';
      g.beginPath();
      g.moveTo(xp - 5, R - 8); g.lineTo(xp + 6, R - 8); g.lineTo(xp + 1, R);
      g.fill();
    }
    g.fillStyle = '#0b0d1a';
    g.fillRect(K - 1, 0, 1, H);
    g.fillRect(0, R - 1, W, 1);

    // ---- corner
    g.fillStyle = '#1b1f38';
    g.fillRect(0, 0, K, R);
    g.fillStyle = track ? track.color : '#888';
    g.font = 'bold 11px system-ui, sans-serif';
    g.textBaseline = 'middle';
    const tname = track ? track.name : '';
    g.fillText(tname.length > 11 ? tname.slice(0, 10) + '…' : tname, 6, R / 2);
  }

  roundRect(x, y, w, h, r) {
    const g = this.g;
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
}
