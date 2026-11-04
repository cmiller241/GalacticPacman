'use strict';
// Standard MIDI File (.mid) reader -> song tracks.
const Midi = (() => {
  function parse(arrayBuffer) {
    const d = new DataView(arrayBuffer);
    let pos = 0;
    const u8 = () => d.getUint8(pos++);
    const u16 = () => { const v = d.getUint16(pos); pos += 2; return v; };
    const u32 = () => { const v = d.getUint32(pos); pos += 4; return v; };
    const str = n => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(u8()); return s; };
    const vlq = () => {
      let v = 0, b;
      do { b = u8(); v = (v << 7) | (b & 0x7f); } while (b & 0x80);
      return v;
    };

    if (str(4) !== 'MThd') throw new Error('Not a MIDI file');
    const hlen = u32();
    const format = u16(), ntrks = u16(), division = u16();
    pos = 8 + hlen;
    if (division & 0x8000) throw new Error('This MIDI file uses SMPTE timing, which is not supported');

    const tempos = [], timeSigs = [];
    let keySig = null;
    const tracks = [];

    for (let ti = 0; ti < ntrks && pos + 8 <= d.byteLength; ti++) {
      const id = str(4), len = u32();
      const end = Math.min(pos + len, d.byteLength);
      if (id !== 'MTrk') { pos = end; ti--; continue; }
      const track = { name: '', notes: [], programs: {} };
      const open = new Map(); // "ch:pitch" -> [{tick, vel}]
      let tick = 0, running = 0;
      while (pos < end) {
        tick += vlq();
        let status = d.getUint8(pos);
        if (status < 0x80) status = running; // running status: reuse the last status byte
        else pos++;
        if (status === 0xff) {
          const type = u8(), mlen = vlq(), mstart = pos;
          if (type === 0x51 && mlen >= 3) tempos.push({ tick, usPerBeat: (d.getUint8(pos) << 16) | (d.getUint8(pos + 1) << 8) | d.getUint8(pos + 2) });
          else if (type === 0x58 && mlen >= 2) timeSigs.push({ tick, num: d.getUint8(pos), den: Math.pow(2, d.getUint8(pos + 1)) });
          else if (type === 0x59 && mlen >= 2 && !keySig) keySig = { sf: d.getInt8(pos), minor: d.getUint8(pos + 1) === 1 };
          else if ((type === 0x03 || type === 0x04) && !track.name) track.name = str(mlen).trim();
          pos = mstart + mlen;
          if (type === 0x2f) break;
        } else if (status === 0xf0 || status === 0xf7) {
          pos += vlq();
        } else {
          running = status;
          const kind = status & 0xf0, ch = status & 0x0f;
          if (kind === 0xc0 || kind === 0xd0) {
            const a = u8();
            if (kind === 0xc0 && track.programs[ch] === undefined) track.programs[ch] = a;
          } else {
            const a = u8(), b = u8();
            if (kind === 0x90 && b > 0) {
              const k = ch + ':' + a;
              if (!open.has(k)) open.set(k, []);
              open.get(k).push({ tick, vel: b });
            } else if (kind === 0x80 || (kind === 0x90 && b === 0)) {
              const st = open.get(ch + ':' + a);
              if (st && st.length) {
                const on = st.shift();
                track.notes.push({ ch, p: a, t0: on.tick, t1: Math.max(tick, on.tick + 1), vel: on.vel });
              }
            }
          }
        }
      }
      // Close any notes that never got a note-off.
      for (const [k, st] of open) for (const on of st) {
        const [ch, p] = k.split(':').map(Number);
        track.notes.push({ ch, p, t0: on.tick, t1: Math.max(tick, on.tick + division), vel: on.vel });
      }
      pos = end;
      tracks.push(track);
    }
    return { format, division, tempos, timeSigs, keySig, tracks };
  }

  // General MIDI program number -> closest instrument here.
  function instrumentFor(program, ch) {
    if (ch === 9) return 'drums';
    if (program === undefined) return 'organ';
    if (program < 8) return 'epiano';
    if (program < 16) return 'bell';
    if (program < 24) return 'organ';
    if (program < 32) return 'pluck';
    if (program < 40) return 'bass';
    if (program >= 52 && program <= 54) return 'choir';
    if (program < 56) return 'strings';
    if (program < 88) return 'lead';
    if (program < 96) return 'pad';
    return 'pad';
  }

  // Turn a parsed MIDI file into song pieces. One track per (MIDI track, channel) that has notes.
  function toSongParts(midi, { quantize = true } = {}) {
    const div = midi.division;
    const q = quantize ? 24 : 480; // 1/24 beat covers 32nd notes and triplets
    const toBeat = t => Math.round((t / div) * q) / q;
    const tempo = midi.tempos.sort((a, b) => a.tick - b.tick)[0];
    const bpm = tempo ? Math.round((60e6 / tempo.usPerBeat) * 10) / 10 : 120;
    const ts = midi.timeSigs.sort((a, b) => a.tick - b.tick)[0];
    const timeSig = ts ? { num: ts.num, den: ts.den } : { num: 4, den: 4 };
    let key = null;
    if (midi.keySig) {
      const majorRoot = (((midi.keySig.sf * 7) % 12) + 12) % 12;
      key = midi.keySig.minor ? { root: (majorRoot + 9) % 12, scale: 'minor' } : { root: majorRoot, scale: 'major' };
    }
    const parts = [];
    let last = 0;
    midi.tracks.forEach((tr, ti) => {
      const byCh = new Map();
      for (const n of tr.notes) {
        if (!byCh.has(n.ch)) byCh.set(n.ch, []);
        byCh.get(n.ch).push(n);
      }
      for (const [ch, list] of byCh) {
        const notes = list.map(n => {
          const s = toBeat(n.t0);
          const d = Math.max(1 / q, toBeat(n.t1) - s);
          last = Math.max(last, s + d);
          return { p: n.p, s, d, v: Math.round((n.vel / 127) * 100) / 100 };
        }).sort((a, b) => a.s - b.s || a.p - b.p);
        let name = tr.name || (ch === 9 ? 'Drums' : 'Track ' + (ti + 1));
        if (byCh.size > 1) name += ' (ch ' + (ch + 1) + ')';
        parts.push({ name, instrument: instrumentFor(tr.programs[ch], ch), notes });
      }
    });
    if (tempo && midi.tempos.length > 1) {
      const distinct = new Set(midi.tempos.map(t => t.usPerBeat));
      if (distinct.size > 1) parts.tempoWarning = true;
    }
    return { bpm, timeSig, key, tracks: parts, lengthBeats: last, tempoWarning: !!parts.tempoWarning };
  }

  return { parse, toSongParts, instrumentFor };
})();
