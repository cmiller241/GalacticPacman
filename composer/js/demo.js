'use strict';
// Demo songs. Both tunes are public domain.
const Demo = {
  list() {
    return [
      { id: 'amazingGrace', title: 'Amazing Grace — Space Waltz', about: 'NEW BRITAIN (1829). 3/4, dreamy: theremin melody, nebula pad, bell arpeggio.', build: () => Demo.amazingGrace() },
      { id: 'navarre', title: 'Let All Exalt Jehovah\'s Goodness — Hyperdrive', about: 'NAVARRE / RENDEZ À DIEU (Genevan Psalter, 1551). 4/4, driving: rocket lead, star choir, laser bass, pluck arpeggio.', build: () => Demo.navarre() },
      { id: 'fortress', title: 'A Mighty Fortress Is Our God — Boss Battle', about: 'EIN FESTE BURG (Luther, 1529). 152 BPM in C harmonic minor: alarm intro, cathedral organ, choir, double-kick drums, breakdown.', build: () => Demo.fortress() },
      { id: 'lux', title: 'Lead, Kindly Light — Stasis Awakening', about: 'LUX BENIGNA (Dykes, 1865). Slow ambient 3/4: memory-fragment piano, dark drone, distant alarms, sparks and far-off blasts on a wrecked station.', build: () => Demo.leadKindlyLight() },
      { id: 'creatures', title: 'All Creatures of Our God and King — Pine Forest', about: 'LASST UNS ERFREUEN (Cologne, 1623). Lilting 3/4 woodland platformer tune: flute melody, rolling harp, soft strings, hand drums, birdsong; flute duet on the Alleluias.', build: () => Demo.allCreatures() },
      { id: 'wachet', title: 'Wake, Awake, for Night Is Flying — Asteroid Belt Run', about: 'WACHET AUF (Nicolai, 1599). Frenetic 172 BPM drum & bass: acid bass, chiptune arps, plucked melody, laser zaps and a siren breakdown.', build: () => Demo.wakeAwake() },
      { id: 'wachet2', title: 'Wake, Awake 2 — Battle March', about: 'WACHET AUF (Nicolai, 1599) as a militant villain-style march in C minor: brass melody, galloping low ostinato, timpani, military snare, choir finale.', build: () => Demo.wakeAwakeMarch() },
      { id: 'christlag', title: 'Christ Jesus Lay in Death\'s Strong Bands — Triumphal March', about: 'CHRIST LAG IN TODESBANDEN (Walter, 1524; Bach\'s harmony, BWV 277). Triumphant D-Dorian brass march at 112 BPM: galloping low brass, timpani, military snare; the second time through adds choir, crashes and high trumpets.', build: () => Demo.christLag() },
      { id: 'rejoice', title: 'Rejoice, Ye Pure in Heart — Starport Arcade', about: 'MARION (Messiter, 1883). Swung 8-bit shuffle: chiptune lead, NES-style arpeggio chords, bouncing bass, key change the second time through.', build: () => Demo.rejoice() },
    ];
  },

  // "All Creatures of Our God and King" — tune LASST UNS ERFREUEN (Geistliche Kirchengesäng, Cologne, 1623; public domain).
  // Four voices from 23.mid. Its one 7/4 bar is trimmed by a beat so every bar has 3 beats.
  // Pine-forest platform level: wooden flute melody, rolling harp, soft strings, hand drums and birdsong.
  allCreatures() {
    const song = Song.create();
    song.title = 'All Creatures of Our God and King (Pine Forest)';
    song.bpm = 132;
    song.timeSig = { num: 3, den: 4 };
    song.key = { root: 2, scale: 'major' }; // D major
    song.bars = 34;
    song.loop = { enabled: true, start: 0, end: 102 };
    song.master = { volume: 0.85, reverbSeconds: 2.6 };
    song.tracks = [];

    const unpack = str => str.trim().split(/\s+/).map(t => { const [p, s, d] = t.split(',').map(Number); return { p, s, d }; });
    // [pitch, start beat, length] per voice. Beats 0-4 are an intro; the melody's pickup starts on beat 4.
    const S = unpack('62,4,2 62,6,1 64,7,1 66,8,1 62,9,1 66,10,1 67,11,1 69,12,3.75 62,16,2 62,18,1 64,19,1 66,20,1 62,21,1 66,22,1 67,23,1 69,24,3.8333 74,28,1 73,29,0.9167 71,30,1.9167 69,32,2 74,34,1 73,35,1 71,36,1.9167 69,38,2 74,40,1.9167 74,42,1 69,43,1 69,44,1 67,45,1 66,46,1 67,47,1 69,48,3.75 74,52,1.9167 74,54,1 69,55,1 69,56,1 67,57,1 66,58,1 67,59,1 69,60,3.8333 67,64,1 66,65,0.9167 64,66,1.9167 62,68,2 67,70,1 66,71,0.9167 64,72,1.9167 62,74,2 74,76,1 73,77,1 71,78,1.9167 69,80,2 74,82,1 73,83,1 71,84,1.9167 69,86,1.9167 67,88,1 66,89,1 64,90,5.6667 62,96,4');
    const A = unpack('57,4,2 62,7,1 62,8,1 62,10,1 62,11,1 62,12,2 61,14,1.9167 57,18,1 61,19,1 62,20,1 62,22,1 62,23,1 62,24,2.0833 61,26,1.9167 69,28,2.0833 69,30,1 67,31,0.9167 66,32,2 62,34,1 64,35,1 66,36,1 64,37,1 61,38,2 69,40,1 67,41,1 66,42,1 66,43,1 66,44,1 64,45,1 62,46,1 62,47,1 62,48,2 61,50,1.9167 62,52,1 64,53,1 62,54,1 67,55,1 66,56,1 62,57,1 62,58,1 62,59,1 62,60,1 61,61,1 66,62,1 64,63,0.9167 62,64,1.9167 62,66,1 61,67,0.9167 62,70,1.9167 62,72,1 61,73,0.9167 59,74,2 66,76,1 64,77,1 66,78,1 64,79,0.9167 61,80,2 66,82,1 66,83,1 66,84,1 64,85,0.9167 64,86,1.5833 59,87.5,0.9167 59,88,1 62,89,1 62,90,2.0833 61,92,3.8333 57,96,4');
    const T = unpack('54,4,2 54,6,1 55,7,1 57,8,1 54,9,1 59,10,1 59,11,1 57,12,3 57,14,1.75 57,16,1.0833 59,17,0.9167 57,18,1 55,19,1 57,20,1 57,21,1 59,22,1 59,23,1 57,24,2.9167 57,26,1.8333 62,28,2 62,30,2 62,32,2 54,34,1 57,35,1 57,36,1 57,38,2 62,40,1.9167 62,42,1 62,43,1 62,44,1 57,45,1 57,46,1 55,47,1 52,48,2.0833 57,50,1.75 57,52,1.9167 57,54,1 57,55,1 57,56,1 62,57,1 61,58,1 59,59,1 57,60,3.8333 59,64,1.9167 59,66,1 57,67,0.9167 57,68,2 59,70,1.0833 59,72,1.0833 54,74,2 54,76,1 57,77,1 57,78,1.0833 57,80,2 57,82,1 57,83,1 54,84,1.0833 55,85,0.9167 52,86,1.0833 54,87,0.9167 55,88,1 57,89,1 59,90,2.0833 54,96,4');
    const B = unpack('50,4,2 50,6,1 50,7,1 50,8,1 50,9,0.5 49,9.5,0.5 47,10,1 52,11,1 45,12,2 55,15,1 54,16,1.0833 55,17,0.9167 54,18,1 52,19,1 50,20,1 49,21,1 47,22,1 52,23,1 45,24,2.0833 55,27,1 54,28,2 55,30,2 50,32,2 47,34,1 49,35,1 50,36,1 52,37,0.9167 56,37,0.9167 45,38,2 54,40,1 52,41,1 50,42,1 49,43,1 47,44,1 49,45,1 50,46,1 47,47,1 45,48,2.0833 55,51,1 54,52,1 55,53,1 54,54,1 52,55,1 50,56,1 59,57,1 57,58,1 55,59,1 54,60,1 52,61,1 50,62,1 49,63,0.9167 47,64,1 45,65,0.9167 43,66,1.9167 42,68,2 40,70,1.0833 42,71,0.9167 57,71,0.9167 43,72,1.0833 45,73,0.9167 55,73,0.9167 47,74,2 47,76,1 49,77,1 50,78,1.0833 52,79,0.9167 56,79,0.9167 45,80,2 47,82,1 49,83,1 50,84,1.0833 52,85,0.9167 49,86,1.0833 51,87,0.9167 52,88,1 54,89,1 55,90,2.0833 57,92,2.0833 45,94,1.8333 55,94,1.8333 50,96,4');
    for (const n of [...S, ...A, ...T, ...B]) if (n.s >= 96) n.d = 6; // hold the last chord a full 6 beats
    const sounding = (list, t) => list.filter(n => n.s <= t + EPS && n.s + n.d > t + EPS);
    const alleluia = s => (s >= 28 && s < 40) || (s >= 76 && s < 96);

    const mk = opts => { const t = Song.newTrack(song, opts); song.tracks.push(t); return t; };
    const flute = mk({ name: 'Flute', instrument: 'flute', volume: 0.5, fx: { reverb: 0.35, delay: { mix: 0.18, beats: 1.5, feedback: 0.3 } } });
    const flute2 = mk({ name: 'Flute 2', instrument: 'flute', volume: 0.32, pan: 0.25, fx: { reverb: 0.4 } });
    const harp = mk({ name: 'Harp', instrument: 'harp', volume: 0.42, pan: -0.2, fx: { reverb: 0.35 } });
    const strings = mk({ name: 'Strings', instrument: 'strings', volume: 0.16, fx: { reverb: 0.5, filter: { cutoff: 2400, q: 0.7 } } });
    const bass = mk({ name: 'Bass', instrument: 'bass', volume: 0.45, fx: { reverb: 0.1 } });
    const drums = mk({ name: 'Hand Drums', instrument: 'drums', volume: 0.45, fx: { reverb: 0.2 } });
    const birds = mk({ name: 'Birds', instrument: 'bird', volume: 0.25, pan: 0.4, fx: { reverb: 0.5, delay: { mix: 0.2, beats: 0.75, feedback: 0.3 } } });
    const add = (tr, p, s, d, v) => tr.notes.push({ p, s, d, v });

    // Melody on flute, an octave up; a second flute sings the alto line with it on the Alleluias.
    for (const n of S) add(flute, n.p + 12, n.s, n.d * 0.98, 0.75);
    for (const n of A) if (alleluia(n.s)) add(flute2, n.p + 12, n.s, n.d * 0.98, 0.6);

    // Harp: rolling broken chords, two notes per beat, rising and falling across each bar,
    // built from whatever the alto and tenor are singing at that moment.
    const shape = [0, 1, 2, 3, 2, 1];
    for (let b = 3; b < 102 - EPS; b++) {
      const mid = [...new Set(sounding([...A, ...T], b).map(n => n.p))].sort((x, y) => x - y);
      if (!mid.length) continue;
      const pool = [...mid, ...mid.map(p => p + 12)];
      const k = (b % 3) * 2;
      for (let e = 0; e < 2; e++) add(harp, pool[shape[k + e] % pool.length], b + e * 0.5, 0.5, e ? 0.5 : 0.62);
    }

    // Soft sustained strings (alto + tenor) and a low bass note on each bar.
    for (const n of [...A, ...T]) add(strings, n.p, n.s, n.d, 0.45);
    for (let b = 3; b < 102 - EPS; b += 3) {
      const low = sounding(B, b);
      if (low.length) {
        const p = Math.min(...low.map(n => n.p));
        add(bass, p >= 45 ? p - 12 : p, b, 2.9, 0.75);
      }
    }

    // Intro: a harp roll on D major with birdsong; the flute's pickup comes in on beat 4.
    [62, 66, 69, 74, 78].forEach((p, i) => add(harp, p, i * 0.5, 0.5, 0.6));

    // Hand-drum beat: low drum on 1, rim click on 2, tambourine on 3 (and its "and" every other bar).
    for (let b = 3; b < 102 - EPS; b += 3) {
      const bar = b / 3;
      const big = alleluia(b) || alleluia(b + 1);
      add(drums, 41, b, 0.25, 0.5);
      add(drums, 35, b, 0.25, 0.45);
      add(drums, 37, b + 1, 0.25, 0.3);
      add(drums, 54, b + 2, 0.25, 0.25);
      if (bar % 2) add(drums, 54, b + 2.5, 0.25, 0.18);
      if (big) add(drums, 45, b + 1.5, 0.25, 0.35);
    }
    for (const b of [30, 78]) add(drums, 53, b, 0.5, 0.35); // a ride-bell shimmer as the Alleluias begin
    for (const s of [27, 75]) [47, 45, 43, 41].forEach((p, i) => add(drums, p, s + i * 0.25, 0.25, 0.4));

    // Birds chirp now and then (random-looking, but the same every time).
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let t = 0.5; t < 100; t += 3 + rnd() * 6) {
      const base = 88 + Math.floor(rnd() * 10);
      const n = 1 + Math.floor(rnd() * 3);
      for (let i = 0; i < n; i++) add(birds, base + (i % 2 ? 3 : 0), t + i * 0.22, 0.15, 0.5 + rnd() * 0.4);
    }

    for (const tr of song.tracks) tr.notes.sort((a, b) => a.s - b.s || a.p - b.p);
    return song;
  },

  // "Wake, Awake, for Night Is Flying" — tune WACHET AUF, Philipp Nicolai 1599 (public domain).
  // Notes from faithalive_PsH_613.mid, a live performance: its timing was straightened onto a steady beat
  // (each of the hymn's 11 lines ends on an even beat). Melody checked against hymnary.org's incipit.
  // Frenetic asteroid-belt music: drum & bass beat, squelchy acid bass, chiptune arps, laser zaps.
  wakeAwake() {
    const song = Song.create();
    song.title = 'Wake, Awake (Asteroid Belt Run)';
    song.bpm = 172;
    song.timeSig = { num: 4, den: 4 };
    song.key = { root: 0, scale: 'major' }; // C major
    song.bars = 31;
    // 2-bar intro plays once; the loop is the whole hymn plus a 2-bar breakdown.
    song.loop = { enabled: true, start: 8, end: 124 };
    song.master = { volume: 0.85, reverbSeconds: 1.8 };
    song.tracks = [];

    const unpack = str => str.trim().split(/\s+/).map(t => { const [p, s, d] = t.split(',').map(Number); return { p, s, d }; });
    const HYMN = 8;    // the hymn starts after the intro
    const LEN = 108;   // hymn length in beats
    const BREAK = HYMN + LEN; // 2-bar breakdown, then back to the top
    // [pitch, beat, length]: melody, and the other three voices together.
    const S = unpack('60,0,1 64,1,1 67,2,1.5 67,3.5,0.5 67,4,1 67,5,1 69,6,2 67,8,1.5 67,10,1 72,11,1 67,12,1 72,13,0.5 74,13.5,0.5 76,14,1 74,15,1 72,16,1 71,17,1 69,18,1 67,19,2.5 67,22,1 72,23,1 67,24,1 69,25,1 64,26,1 65,27,0.5 64,27.5,0.5 62,28,1 60,29,2 60,32,1 64,33,1 67,34,1.5 67,35.5,0.5 67,36,1 67,37,1 69,38,2 67,40,1.5 67,42,1 72,43,1 67,44,1 72,45,0.5 74,45.5,0.5 76,46,1 74,47,1 72,48,1 71,49,1 69,50,1 67,51,2.5 67,54,1 72,55,1 67,56,1 69,57,1 64,58,1 65,59,0.5 64,59.5,0.5 62,60,1 60,61,2.5 67,64,1 67,65,1.5 65,66.5,0.5 64,67,1 62,68,1 60,69,2.5 67,72,1 67,73,1.5 65,74.5,0.5 64,75,1 62,76,1 60,77,2.5 62,80,1 64,81,1 65,82,2 64,84,1.5 67,86,1 69,87,1 71,88,1 72,89,1 72,90,0.5 74,90.5,0.5 76,91,1 74,92,1 72,93,2 67,96,1 72,97,1 67,98,1 69,99,1 64,100,1 65,101,0.5 64,101.5,0.5 62,102,1 60,103,5').map(n => ({ ...n, s: n.s + HYMN }));
    const H = unpack('52,0,1 55,0,1 48,0,1 60,1,1 55,1,1.5 48,1,1 64,2,1 60,2,1 48,2,0.5 52,2.5,0.5 62,3,1 59,3,1 55,3,1 53,3.5,0.5 60,4,1 64,4,1 55,4,1 52,4,0.5 50,4.5,0.5 62,5,1 48,5,0.5 55,5,1 47,5.5,0.5 64,6,1 60,6,1 48,6,0.5 55,6,1 45,6.5,0.5 62,7,2.5 54,7,1 50,7,1 55,8,1.5 59,8,1.5 43,8,1.5 62,10,1 59,10,1 55,10,1 53,10.5,0.5 67,11,1 60,11,1.5 55,11,0.5 52,11,0.5 53,11.5,0.5 52,12,0.5 55,12,2 50,12.5,0.5 65,12.5,0.5 64,13,0.5 48,13,1 65,13.5,0.5 67,14,1 60,14,1 67,15,1 62,15,1 59,15,0.5 57,15.5,0.5 69,16,1 55,16,0.5 62,16,1 54,16.5,0.5 69,17,0.5 55,17,1 62,17,1.5 67,17.5,1 50,18,1 66,18.5,0.5 57,18.5,0.5 62,19,2.5 43,19,2.5 59,19,2.5 64,22,1 60,22,1 48,22,0.5 55,22,1 46,22.5,0.5 60,23,2 65,23,1 45,23,0.5 47,23.5,0.5 64,24,1 48,24,1 58,24.5,0.5 53,25,0.5 60,25,1 57,25,0.5 55,25.5,0.5 60,26,1 57,26,1 60,27,1 57,27,1 50,27,1 55,27.5,0.5 59,28,1 43,28,1 53,28,1 52,29,2 55,29,2 48,29,2 55,32,1 52,32,1 48,32,2 60,33,1 55,33,1 64,34,1 60,34,1 55,34,0.5 48,34,0.5 52,34.5,0.5 62,35,1 59,35,1 55,35,1 53,35.5,0.5 64,36,1 60,36,1 52,36,0.5 55,36,1 50,36.5,0.5 62,37,1 48,37,0.5 55,37,1 47,37.5,0.5 60,38,1 64,38,1 48,38,0.5 55,38,1 45,38.5,0.5 62,39,2.5 54,39,1 50,39,1 43,40,1.5 55,40,1.5 59,40,1.5 59,42,1 62,42,1 55,42,1 53,42.5,0.5 67,43,1 60,43,1.5 55,43,3 52,43,0.5 53,43.5,0.5 52,44,0.5 50,44.5,0.5 65,44.5,0.5 48,45,1 64,45,0.5 65,45.5,0.5 67,46,1 60,46,1 67,47,1 59,47,0.5 62,47,1 57,47.5,0.5 69,48,1 55,48,0.5 62,48,1 54,48.5,0.5 69,49,0.5 55,49,1 62,49,1 67,49.5,1 50,50,1 66,50.5,0.5 57,50.5,0.5 62,51,2.5 59,51,2.5 43,51,2.5 64,54,1 48,54,0.5 60,54,1 55,54,1 46,54.5,0.5 60,55,2 65,55,1 45,55,0.5 47,55.5,0.5 64,56,1 48,56,1 58,56.5,0.5 65,57,1 57,57,0.5 53,57,0.5 60,57,1 55,57.5,0.5 60,58,2 57,58,1 57,59,1 50,59,1 55,59.5,0.5 43,60,1 59,60,1 53,60,1 55,61,2 48,61,2 52,61,2.5 59,64,1 62,64,1 47,64,1 55,64,2 64,65,1.5 60,65,0.5 48,65,1 59,65.5,0.5 50,66,1 57,66,0.5 59,66.5,0.5 62,66.5,0.5 55,67,0.5 60,67,1 52,67,0.5 57,67.5,0.5 53,67.5,0.5 59,68,1 55,68,0.5 43,68.5,0.5 53,68.5,0.5 52,69,2.5 45,69,2.5 57,69,2.5 59,72,0.5 55,72,1 52,72,1 60,72.5,0.5 62,73,2.5 47,73,0.5 55,73,0.5 57,73.5,0.5 45,73.5,0.5 59,74,1 43,74,1 48,75,0.5 55,75,1 45,75.5,0.5 60,75.5,0.5 60,76,0.5 57,76,0.5 41,76,0.5 43,76.5,0.5 55,76.5,3 59,76.5,0.5 52,77,2.5 48,77,2.5 55,80,1 59,80,1 53,80.5,0.5 60,81,1 55,81,1 52,81,1 60,82,1 50,82,2 57,82,1 53,83,1 59,83,1 60,84,1.5 48,84,1.5 55,84,1.5 64,86,1 60,86,1 64,87,0.5 54,87,1 60,87,1 62,87.5,0.5 56,88,1 59,88,1 62,88,0.5 64,88.5,0.5 57,89,1 64,89,1 64,90,0.5 60,90,1 57,90,1 65,90.5,0.5 67,91,2 60,91,1 52,91,0.5 53,91.5,0.5 55,92,0.5 59,92,1 65,92.5,0.5 64,93,2 57,93,2 45,93,2 64,96,0.5 60,96,2 55,96,1 48,96,0.5 50,96.5,0.5 65,96.5,0.5 67,97,0.5 55,97,1 52,97,0.5 65,97.5,0.5 50,97.5,0.5 60,98,1 55,98,1 52,98,0.5 64,98.5,0.5 48,98.5,0.5 65,99,1 60,99,1 41,99,0.5 43,99.5,0.5 60,100,1 45,100,1 57,100.5,0.5 60,101,1 57,101,1 50,101,1 59,102,1 43,102,1 53,102,1 55,103,3 48,103,3 52,103,3').map(n => ({ ...n, s: n.s + HYMN }));
    for (const n of H) if (n.s + n.d >= HYMN + 105) n.d = BREAK - n.s; // hold the final chord to the end of the hymn
    const sounding = t => H.filter(n => n.s <= t + EPS && n.s + n.d > t + EPS);
    // Line starts (beats into the hymn) — used for crashes and fills.
    const LINES = [0, 10, 22, 32, 42, 54, 64, 72, 80, 86, 96].map(b => b + HYMN);

    const mk = opts => { const t = Song.newTrack(song, opts); song.tracks.push(t); return t; };
    const melody = mk({ name: 'Melody', instrument: 'pluck', volume: 0.5, fx: { reverb: 0.2, delay: { mix: 0.2, beats: 0.75, feedback: 0.3 } } });
    const lead = mk({ name: 'Lead (finale)', instrument: 'lead', volume: 0.38, pan: 0.15, fx: { reverb: 0.25 } });
    const bass = mk({ name: 'Acid Bass', instrument: 'acid', volume: 0.42, fx: { reverb: 0.03, filter: { cutoff: 1800, q: 6, sweepDepth: 0.5, sweepBeats: 8 } } });
    const arp = mk({
      name: 'Chip Arp', instrument: 'chip', volume: 0.16, pan: -0.3,
      fx: { reverb: 0.2, delay: { mix: 0.15, beats: 0.75, feedback: 0.25 }, arp: { on: true, rate: 0.25, mode: 'updown', octaves: 2, gate: 0.6 } },
    });
    const siren = mk({ name: 'Siren', instrument: 'chip', volume: 0.12, pan: 0.4, fx: { reverb: 0.3, filter: { cutoff: 3000, q: 0.7 } } });
    const drums = mk({ name: 'Drums', instrument: 'drums', volume: 0.7, fx: { reverb: 0.08 } });
    const add = (tr, p, s, d, v) => tr.notes.push({ p, s, d, v });
    const D = (p, s, v) => add(drums, p, s, 0.25, v);

    // ---- melody: bouncy pluck an octave up; the lead doubles it from line 7 (the hymn's last section) to the end
    for (const n of S) {
      add(melody, n.p + 12, n.s, Math.min(n.d, 2) * 0.9, 0.8);
      if (n.s >= LINES[6]) add(lead, n.p, n.s, n.d * 0.95, 0.75);
    }

    // ---- chip arp on the hymn's own harmony (an octave up)
    for (const n of H) add(arp, n.p + 12, n.s, n.d, 0.6);

    // ---- acid bass: 16th notes on the lowest note of the harmony, jumping octaves
    const bassAt = b => {
      const low = sounding(b);
      if (!low.length) return null;
      let r = Math.min(...low.map(n => n.p));
      while (r >= 45) r -= 12;
      return r;
    };
    const PATTERN = [0, 0, 12, 0, 0, 12, 0, 7]; // per half bar (8 sixteenths)
    for (let b = HYMN; b < BREAK - EPS; b += 0.25) {
      const r = bassAt(b);
      if (r === null) continue;
      const k = Math.round((b - HYMN) * 4) % 8;
      add(bass, r + PATTERN[k], b, 0.2, k % 2 ? 0.5 : 0.85);
    }

    // ---- drums: drum & bass two-step, in half-bar (2-beat) cycles
    const beat = (s, full) => {
      D(36, s, 0.95);
      D(38, s + 1, 0.85);
      if (full) {
        D(36, s + 1.5, 0.7);
        D(38, s + 0.75, 0.25); // ghost
        D(38, s + 1.75, 0.3);  // ghost
      }
      for (let h = 0; h < 8; h++) D(h === 6 && full ? 46 : 42, s + h * 0.25, h % 2 ? 0.25 : 0.45);
    };
    for (let s = HYMN; s < BREAK - EPS; s += 2) beat(s, true);
    for (const b of LINES.filter((_, i) => i % 3 === 0)) D(49, b, 0.75);
    D(49, LINES[6], 0.8); D(49, LINES[9], 0.8);
    // tom fills leading into the repeat, the last section and the final line
    for (const at of [LINES[3], LINES[6], LINES[9]]) [50, 48, 47, 45, 43, 41, 41, 36].forEach((p, i) => D(p, at - 2 + i * 0.25, 0.7));
    // laser zaps on the off-beats now and then — dodge!
    for (let b = HYMN + 7.5; b < BREAK; b += 16) { D(65, b, 0.7); D(61, b + 0.25, 0.5); }

    // ---- intro (once): bass revs up, hats, a snare roll and a whoosh into the hymn
    for (let b = 0; b < 8 - EPS; b += 0.25) {
      const k = Math.round(b * 4) % 8;
      add(bass, 36 + PATTERN[k], b, 0.2, 0.4 + b * 0.06);
    }
    for (let h = 0; h < 32; h++) D(42, h * 0.25, h % 2 ? 0.2 : 0.4);
    D(36, 0, 0.9); D(36, 2, 0.8); D(36, 4, 0.9); D(36, 5.5, 0.7);
    for (let k = 0; k < 8; k++) D(38, 6 + k * 0.25, 0.3 + k * 0.08);
    D(63, 5, 0.6);
    for (let b = 0; b < 4; b += 0.5) add(siren, b % 1 ? 83 : 84, b, 0.45, 0.5); // B5/C6 alarm warble

    // ---- breakdown (2 bars): half-time stomp, siren, zaps, whoosh back to the top
    for (let b = BREAK; b < BREAK + 8 - EPS; b += 0.25) {
      const k = Math.round((b - BREAK) * 4) % 8;
      add(bass, 36 + PATTERN[k], b, 0.2, 0.75);
    }
    for (const p of [60, 64, 67]) add(arp, p + 12, BREAK, 8, 0.6);
    for (let b = BREAK; b < BREAK + 6; b += 0.5) add(siren, b % 1 ? 83 : 84, b, 0.45, 0.6);
    D(36, BREAK, 1); D(38, BREAK + 2, 0.9); D(36, BREAK + 4, 1); D(38, BREAK + 6, 0.9);
    for (let h = 0; h < 16; h++) D(42, BREAK + h * 0.5, 0.35);
    D(65, BREAK + 1.5, 0.8); D(65, BREAK + 3.5, 0.8); D(65, BREAK + 5.5, 0.8);
    for (let k = 0; k < 8; k++) D(38, BREAK + 6 + k * 0.25, 0.35 + k * 0.08);
    D(63, BREAK + 5, 0.7);

    for (const tr of song.tracks) tr.notes.sort((a, b) => a.s - b.s || a.p - b.p);
    return song;
  },

  // "Wake, Awake" as a militant battle march (in the spirit of a sci-fi villain's march — the music here is
  // all the hymn's own). Tune WACHET AUF, Philipp Nicolai 1599 (public domain); same straightened voices as
  // the Asteroid Belt Run version. Played in C minor: brass melody and chords, galloping low ostinato,
  // timpani, military snare, and a choir for the hymn's last section.
  wakeAwakeMarch() {
    const song = Song.create();
    song.title = 'Wake, Awake 2 (Battle March)';
    song.bpm = 104;
    song.timeSig = { num: 4, den: 4 };
    song.key = { root: 0, scale: 'harmonicMinor' }; // C minor
    song.bars = 33;
    // A 4-bar drum-and-timpani intro plays once; the loop is the hymn plus a 2-bar turnaround.
    song.loop = { enabled: true, start: 16, end: 132 };
    song.master = { volume: 0.85, reverbSeconds: 3 };
    song.tracks = [];

    const unpack = str => str.trim().split(/\s+/).map(t => { const [p, s, d] = t.split(',').map(Number); return { p, s, d }; });
    const HYMN = 16, LEN = 108, TURN = HYMN + LEN;
    const S0 = unpack('60,0,1 64,1,1 67,2,1.5 67,3.5,0.5 67,4,1 67,5,1 69,6,2 67,8,1.5 67,10,1 72,11,1 67,12,1 72,13,0.5 74,13.5,0.5 76,14,1 74,15,1 72,16,1 71,17,1 69,18,1 67,19,2.5 67,22,1 72,23,1 67,24,1 69,25,1 64,26,1 65,27,0.5 64,27.5,0.5 62,28,1 60,29,2 60,32,1 64,33,1 67,34,1.5 67,35.5,0.5 67,36,1 67,37,1 69,38,2 67,40,1.5 67,42,1 72,43,1 67,44,1 72,45,0.5 74,45.5,0.5 76,46,1 74,47,1 72,48,1 71,49,1 69,50,1 67,51,2.5 67,54,1 72,55,1 67,56,1 69,57,1 64,58,1 65,59,0.5 64,59.5,0.5 62,60,1 60,61,2.5 67,64,1 67,65,1.5 65,66.5,0.5 64,67,1 62,68,1 60,69,2.5 67,72,1 67,73,1.5 65,74.5,0.5 64,75,1 62,76,1 60,77,2.5 62,80,1 64,81,1 65,82,2 64,84,1.5 67,86,1 69,87,1 71,88,1 72,89,1 72,90,0.5 74,90.5,0.5 76,91,1 74,92,1 72,93,2 67,96,1 72,97,1 67,98,1 69,99,1 64,100,1 65,101,0.5 64,101.5,0.5 62,102,1 60,103,5');
    const H0 = unpack('52,0,1 55,0,1 48,0,1 60,1,1 55,1,1.5 48,1,1 64,2,1 60,2,1 48,2,0.5 52,2.5,0.5 62,3,1 59,3,1 55,3,1 53,3.5,0.5 60,4,1 64,4,1 55,4,1 52,4,0.5 50,4.5,0.5 62,5,1 48,5,0.5 55,5,1 47,5.5,0.5 64,6,1 60,6,1 48,6,0.5 55,6,1 45,6.5,0.5 62,7,2.5 54,7,1 50,7,1 55,8,1.5 59,8,1.5 43,8,1.5 62,10,1 59,10,1 55,10,1 53,10.5,0.5 67,11,1 60,11,1.5 55,11,0.5 52,11,0.5 53,11.5,0.5 52,12,0.5 55,12,2 50,12.5,0.5 65,12.5,0.5 64,13,0.5 48,13,1 65,13.5,0.5 67,14,1 60,14,1 67,15,1 62,15,1 59,15,0.5 57,15.5,0.5 69,16,1 55,16,0.5 62,16,1 54,16.5,0.5 69,17,0.5 55,17,1 62,17,1.5 67,17.5,1 50,18,1 66,18.5,0.5 57,18.5,0.5 62,19,2.5 43,19,2.5 59,19,2.5 64,22,1 60,22,1 48,22,0.5 55,22,1 46,22.5,0.5 60,23,2 65,23,1 45,23,0.5 47,23.5,0.5 64,24,1 48,24,1 58,24.5,0.5 53,25,0.5 60,25,1 57,25,0.5 55,25.5,0.5 60,26,1 57,26,1 60,27,1 57,27,1 50,27,1 55,27.5,0.5 59,28,1 43,28,1 53,28,1 52,29,2 55,29,2 48,29,2 55,32,1 52,32,1 48,32,2 60,33,1 55,33,1 64,34,1 60,34,1 55,34,0.5 48,34,0.5 52,34.5,0.5 62,35,1 59,35,1 55,35,1 53,35.5,0.5 64,36,1 60,36,1 52,36,0.5 55,36,1 50,36.5,0.5 62,37,1 48,37,0.5 55,37,1 47,37.5,0.5 60,38,1 64,38,1 48,38,0.5 55,38,1 45,38.5,0.5 62,39,2.5 54,39,1 50,39,1 43,40,1.5 55,40,1.5 59,40,1.5 59,42,1 62,42,1 55,42,1 53,42.5,0.5 67,43,1 60,43,1.5 55,43,3 52,43,0.5 53,43.5,0.5 52,44,0.5 50,44.5,0.5 65,44.5,0.5 48,45,1 64,45,0.5 65,45.5,0.5 67,46,1 60,46,1 67,47,1 59,47,0.5 62,47,1 57,47.5,0.5 69,48,1 55,48,0.5 62,48,1 54,48.5,0.5 69,49,0.5 55,49,1 62,49,1 67,49.5,1 50,50,1 66,50.5,0.5 57,50.5,0.5 62,51,2.5 59,51,2.5 43,51,2.5 64,54,1 48,54,0.5 60,54,1 55,54,1 46,54.5,0.5 60,55,2 65,55,1 45,55,0.5 47,55.5,0.5 64,56,1 48,56,1 58,56.5,0.5 65,57,1 57,57,0.5 53,57,0.5 60,57,1 55,57.5,0.5 60,58,2 57,58,1 57,59,1 50,59,1 55,59.5,0.5 43,60,1 59,60,1 53,60,1 55,61,2 48,61,2 52,61,2.5 59,64,1 62,64,1 47,64,1 55,64,2 64,65,1.5 60,65,0.5 48,65,1 59,65.5,0.5 50,66,1 57,66,0.5 59,66.5,0.5 62,66.5,0.5 55,67,0.5 60,67,1 52,67,0.5 57,67.5,0.5 53,67.5,0.5 59,68,1 55,68,0.5 43,68.5,0.5 53,68.5,0.5 52,69,2.5 45,69,2.5 57,69,2.5 59,72,0.5 55,72,1 52,72,1 60,72.5,0.5 62,73,2.5 47,73,0.5 55,73,0.5 57,73.5,0.5 45,73.5,0.5 59,74,1 43,74,1 48,75,0.5 55,75,1 45,75.5,0.5 60,75.5,0.5 60,76,0.5 57,76,0.5 41,76,0.5 43,76.5,0.5 55,76.5,3 59,76.5,0.5 52,77,2.5 48,77,2.5 55,80,1 59,80,1 53,80.5,0.5 60,81,1 55,81,1 52,81,1 60,82,1 50,82,2 57,82,1 53,83,1 59,83,1 60,84,1.5 48,84,1.5 55,84,1.5 64,86,1 60,86,1 64,87,0.5 54,87,1 60,87,1 62,87.5,0.5 56,88,1 59,88,1 62,88,0.5 64,88.5,0.5 57,89,1 64,89,1 64,90,0.5 60,90,1 57,90,1 65,90.5,0.5 67,91,2 60,91,1 52,91,0.5 53,91.5,0.5 55,92,0.5 59,92,1 65,92.5,0.5 64,93,2 57,93,2 45,93,2 64,96,0.5 60,96,2 55,96,1 48,96,0.5 50,96.5,0.5 65,96.5,0.5 67,97,0.5 55,97,1 52,97,0.5 65,97.5,0.5 50,97.5,0.5 60,98,1 55,98,1 52,98,0.5 64,98.5,0.5 48,98.5,0.5 65,99,1 60,99,1 41,99,0.5 43,99.5,0.5 60,100,1 45,100,1 57,100.5,0.5 60,101,1 57,101,1 50,101,1 59,102,1 43,102,1 53,102,1 55,103,3 48,103,3 52,103,3');

    // C major -> C minor, chord-aware: E->E♭, A->A♭ (but A stays natural inside the borrowed D-major
    // chords and D-G-A suspensions), B stays natural (the leading tone) except in the chords built on E.
    const all = [...S0, ...H0];
    const overlapping = n => all.filter(m => m !== n && m.s < n.s + n.d - EPS && m.s + m.d > n.s + EPS);
    const soundingAt = t => all.filter(m => m.s <= t + EPS && m.s + m.d > t + EPS);
    const toMinor = n => {
      const pc = n.p % 12;
      const over = new Set(overlapping(n).map(m => m.p % 12));
      const start = new Set(soundingAt(n.s).map(m => m.p % 12));
      let p = n.p;
      if (pc === 4) p--;
      else if (pc === 9 && !(over.has(6) || (start.has(2) && start.has(7) && !start.has(0)))) p--;
      else if (pc === 11 && start.has(4)) p--;
      return { p, s: n.s + HYMN, d: n.d };
    };
    const S = S0.map(toMinor);
    const H = H0.map(toMinor);
    for (const n of H) if (n.s + n.d >= HYMN + 105) n.d = TURN - n.s; // hold the final chord to the end of the hymn
    S[S.length - 1].d = TURN - S[S.length - 1].s;
    const sounding = t => H.filter(n => n.s <= t + EPS && n.s + n.d > t + EPS);
    const LINES = [0, 10, 22, 32, 42, 54, 64, 72, 80, 86, 96].map(b => b + HYMN);
    const FINALE = LINES[6]; // the hymn's last section

    const mk = opts => { const t = Song.newTrack(song, opts); song.tracks.push(t); return t; };
    const horns = mk({ name: 'Brass Melody', instrument: 'brass', volume: 0.5, fx: { reverb: 0.35 } });
    const section = mk({ name: 'Brass Chords', instrument: 'brass', volume: 0.26, pan: -0.2, fx: { reverb: 0.4, filter: { cutoff: 3500, q: 0.7 } } });
    const strings = mk({ name: 'Strings', instrument: 'strings', volume: 0.2, pan: 0.25, fx: { reverb: 0.45 } });
    const low = mk({ name: 'Low Brass Ostinato', instrument: 'brass', volume: 0.3, fx: { reverb: 0.2, filter: { cutoff: 1600, q: 1 } } });
    const sub = mk({ name: 'Sub', instrument: 'bass', volume: 0.4, fx: { reverb: 0.05 } });
    const choir = mk({ name: 'Choir', instrument: 'choir', volume: 0.36, fx: { reverb: 0.5 } });
    const timp = mk({ name: 'Timpani', instrument: 'timpani', volume: 0.55, fx: { reverb: 0.3 } });
    const drums = mk({ name: 'Snare & Cymbals', instrument: 'drums', volume: 0.55, fx: { reverb: 0.2 } });
    const add = (tr, p, s, d, v) => tr.notes.push({ p, s, d, v });
    const D = (p, s, v) => add(drums, p, s, 0.25, v);

    // ---- the hymn: brass melody (louder in the finale), brass + string chords, choir an octave down in the finale
    for (const n of S) {
      add(horns, n.p, n.s, n.d * 0.95, n.s >= FINALE ? 0.95 : 0.8);
      if (n.s >= FINALE) add(choir, n.p - 12, n.s, n.d, 0.7);
    }
    for (const n of H) {
      if (n.p >= 52) add(section, n.p, n.s, n.d * 0.97, 0.6);
      add(strings, n.p + 12, n.s, n.d, 0.5);
    }

    // ---- the gallop: low brass + sub on the bass note, three-note triplet gallops on beats 1-3, a hit on 4
    const rootAt = b => {
      const ns = sounding(b);
      if (!ns.length) return null;
      let r = Math.min(...ns.map(n => n.p));
      while (r >= 48) r -= 12;
      while (r < 36) r += 12;
      return r;
    };
    const gallop = (r, s, beats, v = 0.8) => {
      for (let b = 0; b < beats; b++) {
        const t = s + b;
        if (b % 4 === 3) { add(low, r, t, 0.5, v); add(sub, r, t, 0.5, v); continue; }
        [0, 1 / 3, 2 / 3].forEach((o, i) => add(low, r, t + o, 0.22, i === 0 ? v : v * 0.6));
        add(sub, r, t, 0.6, v);
      }
    };
    for (let b = HYMN; b < TURN - EPS; b++) {
      const r = rootAt(b);
      if (r !== null) gallop(r, b, 1, b >= FINALE ? 0.9 : 0.8);
    }

    // ---- timpani: the bass note on beat 1 of every bar, and a roll into each line of the hymn
    const timpAt = b => { const r = rootAt(b); return r === null ? null : r + 12 > 55 ? r : r + 12; };
    for (let b = HYMN; b < TURN - EPS; b += 4) { const r = timpAt(b); if (r !== null) add(timp, r, b, 1, 0.8); }
    const roll = (p, end, beats, v0, v1) => {
      const n = Math.round(beats / 0.125);
      for (let i = 0; i < n; i++) add(timp, p, end - beats + i * 0.125, 0.125, v0 + (v1 - v0) * i / n);
    };
    for (const at of LINES.slice(1)) roll(43, at, 1, 0.3, 0.75); // G roll (the dominant) leading into each line

    // ---- military snare: a marching pattern every bar, marching bass drum on 1 and 3, crashes on line starts
    const march = (s, v = 1) => {
      for (const [o, a] of [[0, 0.8], [0.5, 0.35], [0.75, 0.3], [1, 0.7], [2, 0.8], [2.5, 0.35], [2.75, 0.3], [3, 0.7], [3.25, 0.35], [3.5, 0.45], [3.75, 0.55]]) D(38, s + o, a * v);
      D(36, s, 0.85 * v);
      D(36, s + 2, 0.75 * v);
    };
    for (let b = HYMN; b < TURN - EPS; b += 4) march(b, b >= FINALE ? 1.1 : 1);
    for (const at of [LINES[0], LINES[3], LINES[6], LINES[9]]) D(49, at, 0.8);
    for (const at of LINES.slice(1)) for (let k = 0; k < 8; k++) D(38, at - 1 + k * 0.125, 0.3 + k * 0.06); // snare roll into each line

    // ---- intro (once): timpani pounding, snare marching in, then the gallop and brass stabs
    for (let b = 0; b < 16; b++) add(timp, b % 2 ? 43 : 36, b, 1, 0.5 + b * 0.025);
    for (let b = 4; b < 16; b += 4) march(b, 0.6 + b * 0.03);
    gallop(36, 8, 8, 0.75);
    for (const s of [8, 12]) for (const p of [48, 55, 60, 63]) add(section, p, s, 1.5, 0.85);
    for (const p of [48, 55, 60, 63]) add(choir, p, 8, 8, 0.55);
    roll(43, 16, 2, 0.3, 0.85);
    for (let k = 0; k < 16; k++) D(38, 14 + k * 0.125, 0.3 + k * 0.04);

    // ---- turnaround (2 bars): C minor, A♭, G — then the loop marches back in
    for (const [s, r, ch, len] of [[TURN, 36, [60, 63, 67], 4], [TURN + 4, 44, [60, 63, 68], 2], [TURN + 6, 43, [59, 62, 67], 2]]) {
      gallop(r, s, len, 0.85);
      for (const p of ch) { add(section, p, s, len * 0.95, 0.85); add(strings, p + 12, s, len, 0.55); }
      add(timp, r + 12 > 55 ? r : r + 12, s, 1, 0.85);
    }
    march(TURN, 1);
    roll(43, TURN + 8, 2, 0.35, 0.9);
    for (let k = 0; k < 16; k++) D(38, TURN + 6 + k * 0.125, 0.35 + k * 0.04);

    for (const tr of song.tracks) tr.notes.sort((a, b) => a.s - b.s || a.p - b.p);
    return song;
  },

  // "Christ Jesus Lay in Death's Strong Bands" — tune CHRIST LAG IN TODESBANDEN (Johann Walter / Martin Luther,
  // 1524, from the Easter chant Victimae paschali laudes), in J. S. Bach's four-part harmony, BWV 277 (public
  // domain). Voices from the Mutopia Project's BWV 277 MIDI (only the notes are used). The melody starts on a
  // one-beat pickup; it's in D Dorian and ends on a D-major chord.
  // Asteroid-belt music: a triumphant brass march. The hymn plays twice in the loop — brass and drums, strings
  // joining for the repeat; then again with choir, crashes on every line and trumpets an octave up at the end.
  christLag() {
    const song = Song.create();
    song.title = 'Christ Jesus Lay in Death\'s Strong Bands (Triumphal March)';
    song.bpm = 112;
    song.timeSig = { num: 4, den: 4 };
    song.key = { root: 2, scale: 'dorian' }; // D Dorian
    song.bars = 39;
    // A 4-bar intro plays once; the loop is the hymn twice (with a 1-bar fanfare between) plus a 2-bar turnaround.
    song.loop = { enabled: true, start: 16, end: 156 };
    song.master = { volume: 0.85, reverbSeconds: 2.8 };
    song.tracks = [];

    const unpack = str => str.trim().split(/\s+/).map(t => { const [p, s, d] = t.split(',').map(Number); return { p, s, d }; });
    // [pitch, beat, length]. Beat 0 is the pickup; bars start on beats 1, 5, 9, ...
    const S0 = unpack('69,0,1 68,1,1 69,2,0.5 71,2.5,0.5 72,3,1 74,4,1 72,5,1 71,6,1 69,7,1 69,8,1 65,9,1 67,10,1 69,11,1 67,12,0.5 65,12.5,0.5 64,13,0.5 62,13.5,0.5 64,14,1 62,15,1 69,16,1 68,17,1 69,18,0.5 71,18.5,0.5 72,19,1 74,20,1 72,21,1 71,22,1 69,23,1 69,24,1 65,25,1 67,26,1 69,27,1 67,28,0.5 65,28.5,0.5 64,29,0.5 62,29.5,0.5 64,30,1 62,31,1 62,33,0.5 64,33.5,0.5 65,34,1 67,35,1 62,36,0.5 64,36.5,0.5 65,37,1 67,38,1 69,39,1 69,40,1 74,41,1 73,42,1 74,43,1 76,44,0.5 74,44.5,0.5 72,45,1 71,46,1 69,47,1 71,48,1 72,49,1 69,50,0.5 70,50.5,0.5 72,51,1 67,52,1 65,53,1 64,54,1 62,55,2 69,57,1 67,58,1 65,59,1 64,60,1 62,61,3');
    const A0 = unpack('65,0,1 65,1,0.5 64,1.5,1 68,2.5,0.5 69,3,1 71,4,1 71,5,0.5 69,5.5,1 68,6.5,0.5 64,7,1 64,8,1 64,9,0.5 62,9.5,0.5 61,10,0.5 62,10.5,0.5 64,11,1.5 62,12.5,0.5 61,13,0.5 62,13.5,1 61,14.5,0.5 57,15,1 65,16,1 65,17,0.5 64,17.5,1 68,18.5,0.5 69,19,1 71,20,1 71,21,0.5 69,21.5,1 68,22.5,0.5 64,23,1 64,24,1 64,25,0.5 62,25.5,0.5 61,26,0.5 62,26.5,0.5 64,27,1.5 62,28.5,0.5 61,29,0.5 62,29.5,1 61,30.5,0.5 57,31,1 57,33,1 62,34,1 62,35,0.5 60,35.5,0.5 58,36,0.5 60,36.5,0.5 62,37,0.5 57,37.5,0.5 62,38,0.5 60,38.5,0.5 60,39,1 65,40,0.5 67,40.5,0.5 69,41,0.5 70,41.5,0.5 70,42,0.5 69,42.5,0.5 69,43,1 64,44,1 64,45,0.5 65,45.5,1 64,46.5,0.5 64,47,1 65,48,1 65,49,0.5 64,49.5,0.5 65,50,1 65,51,1 64,52,1.5 62,53.5,1 61,54.5,0.5 62,55,2 62,57,1.5 64,58.5,0.5 61,59,0.5 62,59.5,1 61,60.5,0.5 57,61,3');
    const T0 = unpack('62,0,0.5 60,0.5,0.5 59,1,1 60,2,0.5 62,2.5,0.5 64,3,1 65,4,0.5 64,4.5,0.5 64,5,0.5 65,5.5,1 64,6.5,0.25 62,6.75,0.25 61,7,1 57,8,1 57,9,1 58,10,1 57,11,1 57,12,1 57,13,0.5 53,13.5,0.5 55,14,0.5 52,14.5,0.5 53,15,1 62,16,0.5 60,16.5,0.5 59,17,1 60,18,0.5 62,18.5,0.5 64,19,1 65,20,0.5 64,20.5,0.5 64,21,0.5 65,21.5,1 64,22.5,0.25 62,22.75,0.25 61,23,1 57,24,1 57,25,1 58,26,1 57,27,1 57,28,1 57,29,0.5 53,29.5,0.5 55,30,0.5 52,30.5,0.5 53,31,1 53,33,0.5 55,33.5,0.5 57,34,1 55,35,0.5 57,35.5,0.5 58,36,1 57,37,0.5 65,37.5,0.5 65,38,0.5 64,38.5,0.5 65,39,1 60,40,1 53,41,1 55,42,1 62,43,0.5 60,43.5,0.5 59,44,1 59,45,0.5 57,45.5,0.5 57,46,0.5 56,46.5,0.5 60,47,1 62,48,1 55,49,0.5 60,49.5,0.5 60,50,1 60,51,0.5 62,51.5,0.5 64,52,0.5 62,52.5,0.5 61,53,0.5 57,53.5,0.5 58,54,0.5 57,54.5,0.25 55,54.75,0.25 53,55,2 57,57,0.5 60,57.5,0.5 58,58,1 57,59,1 55,60,2 54,62,0.5 52,62.5,0.5 54,63,1');
    const B0 = unpack('50,0,1 50,1,1 48,2,0.5 47,2.5,0.5 45,3,0.5 57,3.5,1 56,4.5,0.5 57,5,0.5 53,5.5,0.5 50,6,0.5 52,6.5,0.5 45,7,1 49,8,1 50,9,0.5 53,9.5,0.5 52,10,0.5 50,10.5,0.5 49,11,0.5 45,11.5,0.5 50,12,1 57,13,1 45,14,1 50,15,1 50,16,1 50,17,1 48,18,0.5 47,18.5,0.5 45,19,0.5 57,19.5,1 56,20.5,0.5 57,21,0.5 53,21.5,0.5 50,22,0.5 52,22.5,0.5 45,23,1 49,24,1 50,25,0.5 53,25.5,0.5 52,26,0.5 50,26.5,0.5 49,27,0.5 45,27.5,0.5 50,28,1 57,29,1 45,30,1 50,31,1 50,33,1.5 48,34.5,0.5 46,35,0.5 45,35.5,0.5 43,36,1 50,37,0.5 48,37.5,0.5 46,38,0.5 48,38.5,0.5 41,39,1 53,40,0.5 52,40.5,0.5 50,41,1 52,42,1 54,43,1 56,44,1 57,45,0.5 53,45.5,0.5 50,46,0.5 52,46.5,0.5 45,47,1 50,48,1 48,49,1 41,50,0.5 43,50.5,0.5 45,51,0.5 46,51.5,0.5 48,52,0.5 46,52.5,0.5 45,53,0.5 41,53.5,0.5 43,54,0.5 45,54.5,0.5 46,55,2 42,57,1 43,58,1 45,59,2 38,61,3');
    // Hold the final D-major chord through the bar's last beat.
    for (const v of [S0, A0, T0, B0]) { const n = v[v.length - 1]; n.d = 65 - n.s; }

    const P1 = 15;           // pass 1 starts here (its pickup is the intro's last beat)
    const P2 = P1 + 68;      // pass 2, after a 1-bar fanfare (pickup on that bar's last beat)
    const TURN = P2 + 65;    // 2-bar turnaround; its last beat is the pickup back into the loop
    const END = TURN + 8;
    const LINES = [0, 8, 16, 24, 33, 40, 48, 57]; // each line's first note (pickup), hymn beats
    const shift = (list, o) => list.map(n => ({ p: n.p, s: n.s + o, d: n.d }));

    const mk = opts => { const t = Song.newTrack(song, opts); song.tracks.push(t); return t; };
    const horns = mk({ name: 'Brass Melody', instrument: 'brass', volume: 0.5, fx: { reverb: 0.35 } });
    const trumpets = mk({ name: 'High Trumpets', instrument: 'brass', volume: 0.3, pan: 0.2, fx: { reverb: 0.45 } });
    const section = mk({ name: 'Brass Chords', instrument: 'brass', volume: 0.26, pan: -0.2, fx: { reverb: 0.4, filter: { cutoff: 3500, q: 0.7 } } });
    const strings = mk({ name: 'Strings', instrument: 'strings', volume: 0.2, pan: 0.25, fx: { reverb: 0.45 } });
    const low = mk({ name: 'Low Brass Gallop', instrument: 'brass', volume: 0.3, fx: { reverb: 0.2, filter: { cutoff: 1600, q: 1 } } });
    const sub = mk({ name: 'Sub (Bach\'s bass)', instrument: 'bass', volume: 0.4, fx: { reverb: 0.05 } });
    const choir = mk({ name: 'Choir', instrument: 'choir', volume: 0.34, fx: { reverb: 0.5 } });
    const timp = mk({ name: 'Timpani', instrument: 'timpani', volume: 0.55, fx: { reverb: 0.3 } });
    const drums = mk({ name: 'Snare & Cymbals', instrument: 'drums', volume: 0.55, fx: { reverb: 0.2 } });
    const add = (tr, p, s, d, v) => tr.notes.push({ p, s, d, v });
    const D = (p, s, v) => add(drums, p, s, 0.25, v);

    // The bass note at beat t (the last one, through the hymn's one rest), into the gallop's octave.
    const bassRoot = (B, t) => {
      let n = null;
      for (const m of B) if (m.s <= t + EPS) n = m;
      if (!n) return null;
      let r = n.p;
      while (r >= 48) r -= 12;
      while (r < 36) r += 12;
      return r;
    };
    // Low brass: a three-note triplet gallop on beats 1-3 of each bar, one hit on 4. withSub: the sub doubles it
    // (outside the hymn — inside it, the sub plays Bach's own bass line instead).
    const gallopBeat = (r, t, v, withSub = false) => {
      const four = ((t - 16) % 4 + 4) % 4 === 3;
      if (four) add(low, r, t, 0.5, v);
      else [0, 1 / 3, 2 / 3].forEach((o, i) => add(low, r, t + o, 0.22, i === 0 ? v : v * 0.6));
      if (withSub) add(sub, r, t, four ? 0.5 : 0.6, v);
    };
    const timpRoot = r => (r + 12 > 55 ? r : r + 12);
    const roll = (p, end, beats, v0, v1) => {
      const n = Math.round(beats / 0.125);
      for (let i = 0; i < n; i++) add(timp, p, end - beats + i * 0.125, 0.125, v0 + (v1 - v0) * i / n);
    };
    const snareRoll = (end, beats, v0, v1) => {
      const n = Math.round(beats / 0.125);
      for (let k = 0; k < n; k++) add(drums, 38, end - beats + k * 0.125, 0.125, v0 + (v1 - v0) * k / n);
    };
    // Military snare: a marching pattern each bar, marching bass drum on 1 and 3.
    const march = (s, v = 1) => {
      for (const [o, a] of [[0, 0.8], [0.5, 0.35], [0.75, 0.3], [1, 0.7], [2, 0.8], [2.5, 0.35], [2.75, 0.3], [3, 0.7], [3.25, 0.35], [3.5, 0.45], [3.75, 0.55]]) D(38, s + o, a * v);
      D(36, s, 0.85 * v);
      D(36, s + 2, 0.75 * v);
    };

    // ---- one pass of the hymn starting at song beat o. big: the second, fuller time through.
    const pass = (o, big) => {
      const S = shift(S0, o), A = shift(A0, o), T = shift(T0, o), B = shift(B0, o);
      const at = h => o + h; // hymn beat -> song beat
      for (const n of S) {
        add(horns, n.p, n.s, n.d * 0.92, big ? 0.95 : 0.82);
        if (big && n.s >= at(48) - EPS) add(trumpets, n.p + 12, n.s, n.d * 0.92, 0.75);
      }
      for (const n of [...A, ...T]) {
        add(section, n.p, n.s, n.d * 0.95, 0.6);
        if (big || n.s >= at(16) - EPS) add(strings, n.p + 12, n.s, n.d, big ? 0.55 : 0.45);
      }
      if (big) for (const n of [...S, ...A, ...T]) add(choir, n.p, n.s, n.d, n === S[S.length - 1] ? 0.75 : 0.6);
      else for (const n of S) if (n.s >= at(57) - EPS) add(choir, n.p, n.s, n.d, 0.6); // choir joins the last line
      for (const n of B) add(sub, n.p >= 50 ? n.p - 12 : n.p, n.s, n.d * 0.9, 0.55);

      // Gallop and marching drums on every beat/bar the hymn covers (its bars start one beat after the pickup).
      const first = at(1), last = at(65);
      for (let t = first; t < last - EPS; t++) {
        const r = bassRoot(B, t);
        if (r !== null) gallopBeat(r, t, big ? 0.9 : 0.8);
      }
      for (let t = first; t < last - EPS; t += 4) {
        march(t, big ? 1.1 : 1);
        const r = bassRoot(B, t);
        if (r !== null) add(timp, timpRoot(r), t, 1, big ? 0.9 : 0.8);
      }
      // Into each line: a timpani roll on A (the dominant) and a snare roll; crashes on the big moments.
      for (const h of LINES.slice(1)) {
        roll(45, at(h), 1, 0.3, 0.75);
        snareRoll(at(h), 1, 0.3, 0.75);
        if (big || h === 33 || h === 57) D(49, at(h) + (h === 33 || h === 57 ? 0 : 1), 0.8);
      }
      D(49, first, 0.85);
      D(57, at(61), 0.9); // the final chord
    };
    pass(P1, false);
    pass(P2, true);

    // ---- intro (once): timpani pounding D and A, the snare marching in, then the gallop and open-fifth brass stabs
    for (let b = 0; b < 15; b++) add(timp, b % 2 ? 45 : 38, b, 1, 0.5 + b * 0.025);
    for (let b = 4; b < 16; b += 4) march(b, 0.6 + b * 0.03);
    for (let t = 8; t < 15; t++) gallopBeat(38, t, 0.75, true);
    for (const s of [8, 12]) for (const p of [50, 57, 62, 69]) add(section, p, s, 1.5, 0.85);
    for (const p of [50, 57, 62]) add(choir, p, 8, 7, 0.5);
    roll(45, 16, 1, 0.3, 0.85);
    snareRoll(16, 1, 0.35, 0.8);

    // ---- fanfare bar between the passes: D-major triplet stabs, then A (the dominant) under the pickup
    const fan = P1 + 65;
    for (const [o, v] of [[0, 0.9], [1 / 3, 0.6], [2 / 3, 0.7], [1, 0.95], [2, 0.9]]) for (const p of [62, 66, 69]) add(section, p, fan + o, o < 1 ? 0.25 : 0.9, v);
    for (const p of [69, 74]) add(horns, p, fan + 1, 1.8, 0.85);
    for (const p of [57, 61, 64]) add(strings, p + 12, fan + 2, 2, 0.5);
    for (let t = fan; t < fan + 4; t++) gallopBeat(t < fan + 2 ? 38 : 45, t, 0.85, true);
    march(fan, 1);
    add(timp, 50, fan, 1, 0.9);
    roll(45, P2 + 1, 2, 0.35, 0.9);

    // ---- turnaround (2 bars): B♭ major, then A major — then the pickup marches back to the top of the loop
    for (const [s, r, ch] of [[TURN, 46, [62, 65, 70]], [TURN + 4, 45, [61, 64, 69]]]) {
      for (let t = s; t < s + 4; t++) gallopBeat(r, t, 0.85, true);
      for (const p of ch) { add(section, p, s, 3.8, 0.85); add(strings, p + 12, s, 4, 0.55); add(choir, p, s, 3, 0.55); }
      add(timp, timpRoot(r), s, 1, 0.85);
      march(s, 1);
    }
    D(49, TURN, 0.85);
    add(horns, 69, END - 1, 0.92, 0.85); // the pickup (the hymn's first note)
    roll(45, END, 2, 0.35, 0.9);
    snareRoll(END, 2, 0.35, 0.95);

    for (const tr of song.tracks) tr.notes.sort((a, b) => a.s - b.s || a.p - b.p);
    return song;
  },

  // "Lead, Kindly Light" — words John Henry Newman 1833, tune LUX BENIGNA by John B. Dykes 1865 (public domain).
  // Four voices from lux_beniga.mid, melody checked against the 1895 Presbyterian Hymnal print (hymn 508).
  // Ambient opening-level music: the hero wakes from stasis on a burning, wrecked station with no memory.
  // First pass plays only fragments of the melody (half-remembered); the second pass remembers all of it.
  leadKindlyLight() {
    const song = Song.create();
    song.title = 'Lead, Kindly Light (Stasis Awakening)';
    song.bpm = 60;
    song.timeSig = { num: 3, den: 4 };
    song.key = { root: 8, scale: 'major' }; // A♭ major
    song.bars = 38;
    // A short intro (heartbeat, drone fading in) plays once; the loop covers both passes of the hymn.
    song.loop = { enabled: true, start: 10.5, end: 112.5 };
    song.master = { volume: 0.8, reverbSeconds: 5 };
    song.tracks = [];

    const unpack = str => str.trim().split(/\s+/).map(t => { const [p, s, d] = t.split(',').map(Number); return { p, s, d }; });
    // [pitch, start beat, length] for each voice; beat 0 is the pickup "Lead, kind-ly".
    const S = unpack('63,0,0.5 68,0.5,0.5 70,1,0.5 72,1.5,0.75 72,2.25,0.25 70,2.5,0.5 68,3,0.5 65,3.5,0.5 68,4,0.5 65,4.5,1 63,5.5,2 68,7.5,1 67,8.5,1 68,9.5,0.8333 70,10.5,1.3333 63,12,0.5 68,12.5,0.5 70,13,0.5 72,13.5,0.75 72,14.25,0.25 70,14.5,0.5 68,15,0.5 65,15.5,0.5 68,16,0.5 65,16.5,1 63,17.5,2 63,19.5,1 68,20.5,1.5 67,22,0.5 67,22.5,1 68,23.5,1.75 70,25.5,1 70,26.5,1 70,27.5,1 70,28.5,2 70,30.5,1 70,31.5,0.5 72,32,0.5 70,32.5,0.5 68,33,0.5 67,33.5,0.5 65,34,0.5 63,34.5,2.8333 72,37.5,1 70,38.5,1 68,39.5,0.8333 68,40.5,1.5 68,42,0.5 67,42.5,0.5 65,43,0.5 63,43.5,1 68,44.5,1.5 67,46,0.5 67,46.5,1 68,47.5,3.75');
    const A = unpack('63,0.5,0.5 63,1,0.5 63,1.5,0.75 60,2.25,0.25 61,2.5,0.5 63,3,0.5 63,3.5,0.5 61,4,0.5 61,4.5,1 63,7.5,1 63,8.5,1 63,9.5,0.5 60,10,0.5 61,10.5,1.3333 63,12.5,0.5 63,13,0.5 63,13.5,0.75 60,14.25,0.25 61,14.5,0.5 63,15,0.5 63,15.5,0.5 61,16,0.5 61,16.5,1 60,17.5,2 60,19.5,1 63,20.5,1.5 63,22,0.5 63,22.5,2.75 63,25.5,1 62,26.5,1 63,27.5,1 65,28.5,2 63,30.5,1 63,31.5,0.5 63,32,0.5 62,32.5,0.8333 62,33.5,0.8333 60,35.5,0.8333 61,36.5,0.8333 60,37.5,1 61,38.5,1 63,39.5,0.5 64,40,0.5 65,40.5,1.5 65,42,0.5 63,42.5,0.5 61,43,0.5 60,43.5,1 63,44.5,1.5 61,46,0.5 61,46.5,1 60,47.5,3.75');
    const T = unpack('60,0,0.5 60,0.5,0.5 61,1,0.5 60,1.5,0.75 56,2.25,0.25 56,2.5,0.5 56,3,0.5 56,3.5,0.5 56,4,0.5 56,4.5,2 60,5.5,1 61,6.5,1 63,7.5,1 61,8.5,1 60,9.5,0.5 56,10,0.5 56,10.5,1 55,11.5,0.5 61,12,0.5 61,12.5,0.5 61,13,0.5 60,13.5,0.75 56,14.25,0.25 56,14.5,0.5 56,15,0.5 56,15.5,0.5 56,16,0.5 56,16.5,3 56,19.5,1 60,20.5,1.5 58,22,0.5 61,22.5,1 60,23.5,1.75 58,25.5,1 56,26.5,1 55,27.5,0.5 60,28,0.5 58,28.5,1 56,29.5,1 55,30.5,1 55,31.5,0.5 55,32,0.5 56,32.5,1 56,33.5,1 55,34.5,1 56,35.5,1 58,36.5,0.8333 56,37.5,1 53,38.5,0.5 55,39,0.5 56,39.5,1 56,40.5,1.5 53,42,0.5 55,42.5,0.5 56,43,0.5 56,43.5,1 60,44.5,1.5 58,46,0.5 58,46.5,1 56,47.5,3.75');
    const B = unpack('56,0,0.5 56,0.5,0.5 56,1,0.5 56,1.5,0.75 44,2.25,0.25 46,2.5,0.5 48,3,0.5 49,3.5,0.5 53,4,0.5 58,6.5,0.8333 60,7.5,1 58,8.5,1 56,9.5,0.8333 51,10.5,1.3333 51,12,0.5 53,12.5,0.5 55,13,0.5 56,13.5,0.75 44,14.25,0.25 46,14.5,0.5 48,15,0.5 49,15.5,0.5 53,16,0.5 44,17.5,0.8333 48,18.5,0.8333 51,19.5,1 51,20.5,1.5 51,22,0.5 51,22.5,1 56,23.5,1.75 55,25.5,1 53,26.5,1 51,27.5,0.8333 50,28.5,1.75 51,30.5,1 46,31.5,0.5 46,32,0.5 46,32.5,1 46,33.5,1 51,34.5,2.75 44,37.5,1 46,38.5,0.8333 48,39.5,1 49,40.5,1.5 49,42,0.5 49,42.5,0.5 49,43,0.5 51,43.5,1.75 51,46.5,1 44,47.5,3.75');
    const HARM = [...A, ...T, ...B];
    const PASS = 51; // 48-beat hymn + one bar of breathing room
    const P1 = 10.5, P2 = P1 + PASS;

    const mk = opts => { const t = Song.newTrack(song, opts); song.tracks.push(t); return t; };
    const memory = mk({ name: 'Memory', instrument: 'epiano', volume: 0.45, pan: -0.1, fx: { reverb: 0.6, delay: { mix: 0.3, beats: 1.5, feedback: 0.45 } } });
    const strings = mk({ name: 'Strings', instrument: 'strings', volume: 0.18, pan: 0.15, fx: { reverb: 0.65, filter: { cutoff: 1800, q: 0.7 } } });
    const pad = mk({ name: 'Pad', instrument: 'pad', volume: 0.3, fx: { reverb: 0.6, filter: { cutoff: 700, q: 1.5, sweepDepth: 0.35, sweepBeats: 24 } } });
    const drone = mk({ name: 'Drone', instrument: 'bass', volume: 0.35, fx: { reverb: 0.2, filter: { cutoff: 300, q: 0.7 } } });
    const alarm = mk({ name: 'Alarm', instrument: 'chip', volume: 0.08, pan: 0.6, fx: { reverb: 0.5, delay: { mix: 0.35, beats: 0.75, feedback: 0.4 }, filter: { cutoff: 900, q: 0.7 } } });
    const fx = mk({ name: 'Wreckage', instrument: 'drums', volume: 0.4, pan: -0.2, fx: { reverb: 0.55, filter: { cutoff: 3000, q: 0.7 } } });
    const add = (tr, p, s, d, v) => tr.notes.push({ p, s, d, v });

    // Pass 1 remembers only some phrases: line 1, the end of line 2, and the last line.
    const remembered = s => s < 12 || (s >= 19.5 && s < 25.5) || s >= 37.5;
    for (const [at, full] of [[P1, false], [P2, true]]) {
      for (const n of S) {
        if (!full && !remembered(n.s)) continue;
        const d = n.s >= 47.5 ? PASS - n.s - 0.5 : n.d; // let the last note ring into the breath bar
        add(memory, n.p, at + n.s, d, full ? 0.7 : 0.55);
        if (full && n.d >= 1) add(strings, n.p - 12, at + n.s, d, 0.5);
      }
      for (const n of HARM) add(pad, n.p, at + n.s, n.s >= 47.5 ? PASS - n.s - 0.5 : n.d, 0.5);
    }

    // Intro: an unresolved A♭sus2 haze and a slow heartbeat as the stasis pod opens.
    for (const p of [44, 51, 58]) add(pad, p, 0, 10.5, 0.5);
    for (let b = 0, i = 0; b < 9; b += 1.25, i++) {
      const v = 0.6 - i * 0.06;
      add(fx, 35, b, 0.25, v);
      add(fx, 35, b + 0.3, 0.25, v * 0.7);
    }

    // Low drone under everything (the station's failing life support). Notes line up with the loop start.
    add(drone, 32, 0, 11, 0.7);
    for (let b = P1; b < 112.5; b += 12) add(drone, 32, b, Math.min(12.5, 112.5 - b), 0.7);

    // A muffled alarm warbles somewhere far away.
    for (const b of [16.5, 40, 67.5, 93]) for (let i = 0; i < 6; i++) add(alarm, i % 2 ? 74 : 75, b + i * 0.5, 0.45, 0.6);

    // Sparks and crackles (random, but the same every time), distant blasts, venting steam.
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let t = 2 + rnd() * 3; t < 111; t += 4 + rnd() * 6) {
      const n = 2 + Math.floor(rnd() * 4);
      let x = t;
      for (let i = 0; i < n && x < 112; i++) {
        add(fx, rnd() < 0.5 ? 42 : 54, x, 0.1, 0.12 + rnd() * 0.25);
        x += 0.08 + rnd() * 0.12;
      }
    }
    for (const b of [26, 55, 80, 104]) {
      add(fx, 35, b, 0.25, 0.55);
      add(fx, 41, b + 0.05, 0.25, 0.45);
      if (b === 55 || b === 104) add(fx, 49, b + 0.1, 0.25, 0.15);
    }
    for (const b of [37, 70, 96]) add(fx, 63, b, 1, 0.22);

    for (const tr of song.tracks) tr.notes.sort((a, b) => a.s - b.s || a.p - b.p);
    return song;
  },

  // "Rejoice, Ye Pure in Heart" — words Edward Plumptre 1865, tune MARION by Arthur Messiter 1883 (public domain).
  // Played twice: first in F, then up a whole step in G with more layers. Eighth notes are swung.
  rejoice() {
    const song = Song.create();
    song.title = 'Rejoice, Ye Pure in Heart (Starport Arcade)';
    song.bpm = 120;
    song.timeSig = { num: 4, den: 4 };
    song.key = { root: 5, scale: 'major' }; // F major (second pass is in G)
    song.bars = 25;
    song.loop = { enabled: true, start: 3, end: 99 };
    song.master = { volume: 0.85, reverbSeconds: 1.6 };
    song.tracks = [];

    // Melody in F: [pitch, beats], starting with the one-beat pickup.
    const MEL = [
      [65, 1],
      [72, 1], [69, 0.5], [67, 0.5], [65, 1], [67, 1], [69, 3], [69, 1],
      [69, 1], [65, 0.5], [67, 0.5], [69, 1], [71, 1], [72, 3], [72, 1],
      [74, 1], [72, 0.5], [70, 0.5], [69, 1], [69, 1], [69, 0.5], [67, 0.5], [66, 0.5], [67, 0.5], [69, 1], [62, 1],
      [67, 1], [69, 1], [70, 1], [69, 1], [67, 3], [72, 1],
      [72, 3], [72, 1], [72, 3], [72, 1], // refrain: "Re-joice! Re-joice!"
      [70, 1], [69, 0.5], [67, 0.5], [69, 1], [67, 1], [65, 3],
    ];
    // Chords by hymn beat (beat 0 = the pickup).
    const CH = [[0, 'C7'], [1, 'C'], [2, 'Am'], [3, 'Dm'], [4, 'C'], [5, 'F'], [8, 'A7'], [9, 'Dm'], [12, 'G7'], [13, 'C'], [16, 'F7'],
      [17, 'Bb'], [19, 'Dsus'], [20, 'D'], [21, 'D'], [24, 'D7'], [25, 'Gm'], [26, 'Dm'], [27, 'Gm7'], [28, 'F'], [29, 'C'],
      [40, 'F7'], [41, 'Bb'], [42, 'F'], [44, 'C7'], [45, 'F']];
    const LEN = 48;
    const VOICE = {
      F: [65, 69, 72], C: [64, 67, 72], Am: [64, 69, 72], Dm: [62, 65, 69], A7: [61, 64, 67], G7: [62, 65, 67, 71],
      F7: [63, 65, 69, 72], Bb: [62, 65, 70], Dsus: [62, 67, 69], D: [62, 66, 69], D7: [60, 62, 66, 69], Gm: [62, 67, 70],
      Gm7: [62, 65, 67, 70], C7: [64, 67, 70, 72],
    };
    const ROOT = { F: 41, C: 48, Am: 45, Dm: 50, A7: 45, G7: 43, F7: 41, Bb: 46, Dsus: 50, D: 50, D7: 50, Gm: 43, Gm7: 43, C7: 48 };

    const mk = opts => { const t = Song.newTrack(song, opts); song.tracks.push(t); return t; };
    const lead = mk({ name: 'Melody', instrument: 'chip', volume: 0.5, fx: { reverb: 0.15, delay: { mix: 0.2, beats: 0.75, feedback: 0.25 } } });
    const chords = mk({ name: 'Chords', instrument: 'chip', volume: 0.2, pan: 0.2, fx: { reverb: 0.2, arp: { on: true, rate: 0.125, mode: 'up', octaves: 1, gate: 0.9 } } });
    const bass = mk({ name: 'Bass', instrument: 'chip', volume: 0.42, fx: { reverb: 0.05, filter: { cutoff: 1400, q: 0.7 } } });
    const bells = mk({ name: 'Bells', instrument: 'bell', volume: 0.35, pan: -0.25, fx: { reverb: 0.4, delay: { mix: 0.2, beats: 0.75, feedback: 0.3 } } });
    const drums = mk({ name: 'Drums', instrument: 'drums', volume: 0.6, fx: { reverb: 0.06 } });
    // Notes are written on a straight grid with a "gate" (how much of the slot sounds); swing is applied at the end.
    const add = (tr, p, s, d, v, g = 1) => tr.notes.push({ p, s, d, v, g });

    const passes = [{ at: 3, up: 0, full: false }, { at: 51, up: 2, full: true }];
    for (const { at, up, full } of passes) {
      // melody (an octave higher on the second pass)
      let t = at;
      for (const [p, d] of MEL) { add(lead, p + up + (full ? 12 : 0), t, d, full ? 0.85 : 0.8, d >= 3 ? 0.95 : 0.8); t += d; }
      // chords, bass, drums
      CH.forEach(([cs, name], i) => {
        const ce = i + 1 < CH.length ? CH[i + 1][0] : LEN;
        const s = at + cs, d = ce - cs, r = ROOT[name] + up;
        for (const p of VOICE[name]) add(chords, p + up, s, d, full ? 0.7 : 0.45);
        if (full) for (let b = 0; b < d - EPS; b += 0.5) add(bass, r + (b % 1 ? 12 : 0), s + b, 0.5, b % 1 ? 0.6 : 0.85, 0.7); // oom-pah
        else for (let b = 0; b < d - EPS; b += 1) add(bass, r + (b % 2 ? 7 : 0), s + b, 1, 0.75, 0.6); // root-fifth
      });
      // call-and-response bells on the refrain (second pass only)
      if (full) {
        for (const [o, p, d] of [[34, 72, 0.5], [34.5, 74, 0.5], [35, 76, 2], [38, 74, 0.5], [38.5, 76, 0.5], [39, 77, 2]]) add(bells, p + up, at + o, d, 0.7);
      }
      // drums for every bar of this pass
      const startBar = Math.floor((at + 1) / 4), endBar = startBar + 12;
      for (let bar = startBar; bar < endBar; bar++) {
        const s = bar * 4;
        if (full) {
          add(drums, 36, s, 0.25, 0.95); add(drums, 36, s + 2, 0.25, 0.9); add(drums, 36, s + 3.5, 0.25, 0.55);
          add(drums, 38, s + 1, 0.25, 0.75); add(drums, 38, s + 3, 0.25, 0.75);
          for (let h = 0; h < 8; h++) add(drums, h === 7 && bar % 2 ? 46 : 42, s + h * 0.5, 0.25, h % 2 ? 0.45 : 0.3);
        } else {
          add(drums, 36, s, 0.25, 0.8); add(drums, 36, s + 2, 0.25, 0.7);
          add(drums, 37, s + 1, 0.25, 0.6); add(drums, 37, s + 3, 0.25, 0.6);
          for (let h = 0; h < 8; h++) add(drums, 42, s + h * 0.5, 0.25, h % 2 ? 0.3 : 0.18);
        }
      }
    }
    // Sparkles: "power-up" sweep into the key change, crash on the big moments, blips on the refrain.
    add(drums, 38, 3, 0.25, 0.5); add(drums, 38, 3.5, 0.25, 0.65); // pickup fill
    add(drums, 63, 49, 2, 0.6);
    for (const b of [4, 52, 84]) add(drums, 49, b, 0.5, 0.6);
    for (const b of [36, 40, 84, 88]) add(drums, 64, b, 0.25, 0.7);

    // Swing: every off-beat 8th note lands two-thirds of the way through the beat.
    const sw = b => { const i = Math.floor(b + EPS); return Math.abs(b - i - 0.5) < EPS ? i + 2 / 3 : b; };
    for (const tr of song.tracks) {
      for (const n of tr.notes) {
        const s = sw(n.s), e = sw(n.s + n.d);
        n.s = s;
        n.d = (e - s) * n.g;
        delete n.g;
      }
      tr.notes.sort((a, b) => a.s - b.s || a.p - b.p);
    }
    return song;
  },

  // Reads simple LilyPond note text, e.g. "c''4 g'8 fis' a,2." -> [{p, s, d}].
  // c' is middle C. Durations: 4 = quarter, 8 = eighth, 2. = dotted half. "s"/"r" are rests.
  lily(str) {
    const PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
    const notes = [];
    let dur = 4, t = 0;
    for (const tok of str.trim().split(/\s+/)) {
      const m = tok.match(/^([a-grs])(is|es)?([',]*)(\d+)?(\.*)$/);
      if (!m) continue;
      if (m[4]) dur = +m[4];
      let beats = 4 / dur;
      if (m[5]) beats *= 1.5;
      if (m[1] !== 's' && m[1] !== 'r') {
        let p = 48 + PC[m[1]] + (m[2] === 'is' ? 1 : m[2] === 'es' ? -1 : 0);
        for (const ch of m[3]) p += ch === "'" ? 12 : -12;
        notes.push({ p, s: t, d: beats });
      }
      t += beats;
    }
    return notes;
  },

  // C major -> C harmonic minor, looking at every chord so the harmony stays clean:
  // E->E♭ and A->A♭ (except inside the borrowed D major / A major chords), G♯->G,
  // and B stays natural (the "evil" leading tone) except in the chords built on E.
  toBossMinor(voices) {
    const all = voices.flat();
    const sounding = t => all.filter(n => n.s <= t + EPS && n.s + n.d > t + EPS);
    return voices.map(v => v.map(n => {
      const pcs = new Set(sounding(n.s).map(x => x.p % 12));
      const pc = n.p % 12, sharpChord = pcs.has(1);
      let p = n.p;
      if (pc === 4 && !sharpChord) p--;
      else if (pc === 9 && !pcs.has(6) && !sharpChord) p--;
      else if (pc === 11 && (pcs.has(4) || pcs.has(8))) p--;
      else if (pc === 8) p--;
      return { ...n, p };
    }));
  },

  // "A Mighty Fortress Is Our God" — EIN FESTE BURG, Martin Luther, c. 1529.
  // The four voices below are the public-domain SATB hymn setting from the Mutopia Project
  // (Mutopia-2008/01/13-1237). The arrangement turns it into boss music.
  fortress() {
    const song = Song.create();
    song.title = 'A Mighty Fortress (Boss Battle)';
    song.bpm = 152;
    song.timeSig = { num: 4, den: 4 };
    song.key = { root: 0, scale: 'harmonicMinor' };
    song.bars = 24;
    // 2-bar intro plays once; the loop starts at the hymn's pickup note and includes the breakdown.
    song.loop = { enabled: true, start: 7, end: 95 };
    song.master = { volume: 0.85, reverbSeconds: 3 };
    song.tracks = [];

    const SOP = "c''4 c'' c'' g'8 a' b'4 c''8 b' a'4 g' c'' b' a' g' a' f'8 e' d'4 c' c'' c'' c'' g'8 a' b'4 c''8 b' a'4 g' c'' b' a' g' a' f'8 e' d'4 c' c' g' a' g' fis' g'2. c'4 g' g' a' b' c''2. b'4 c'' b' a' a' g'2. a'4 a' g' a' f' e'2. c''4 b' a' g' a' f'8 e' d'4 c'";
    const ALT = "e'4 c' e' d' g' e' fis' g' e' e' c' c' c' a b c' e' c' e' d' e' c' d'8 c' b4 c' e' c' c' c' a b c' c' e' e' d' d'8 c' b2. c'4 d' e' c' d' c'2. e'4 e' e' e' d'8 c' b2. c'4 f' e' e' d' b2. c'4 e' c' e' e' a b c'";
    const TEN = "g4 g g b b a d'8 c' b4 a g f e e f g e g g g b g e fis g e g f e e f g8 f e4 e g c' b a g2. e4 g g f f e2. b4 a gis a fis g2. c'4 c' b a a gis2. a4 g a c' c' f g8 f e4";
    const BAS = "c4 e c g d a d g a e f c a, d g, c c e c g e a, d g, a, e f c a, d g, c c c a, b,8 c d4 g,2. c4 b, c f d a,2. gis,4 a, b, c d g,2. f,4 a, c cis d e2. a,4 e f c a, d g, c";
    const H = 7; // the hymn's pickup note lands on beat 7 (end of bar 2)
    const [S, A, T, B] = Demo.toBossMinor([SOP, ALT, TEN, BAS].map(v => Demo.lily(v)))
      .map(v => v.map(n => ({ ...n, s: n.s + H })));
    const HYMN_END = H + 73; // beat 80

    const mk = opts => { const t = Song.newTrack(song, opts); song.tracks.push(t); return t; };
    const lead = mk({ name: 'Melody', instrument: 'lead', volume: 0.62, fx: { reverb: 0.25, delay: { mix: 0.15, beats: 0.5, feedback: 0.25 } } });
    const organ = mk({ name: 'Organ', instrument: 'organ', volume: 0.5, fx: { reverb: 0.45 } });
    const choir = mk({ name: 'Choir', instrument: 'choir', volume: 0.4, fx: { reverb: 0.55 } });
    const bass = mk({ name: 'Bass', instrument: 'acid', volume: 0.45, fx: { reverb: 0.03, filter: { cutoff: 2600, q: 3 } } });
    const sub = mk({ name: 'Sub', instrument: 'bass', volume: 0.5, fx: { reverb: 0 } });
    const arp = mk({
      name: 'Arp', instrument: 'pluck', volume: 0.26, pan: 0.3,
      fx: { reverb: 0.3, filter: { cutoff: 2200, q: 8, sweepDepth: 0.6, sweepBeats: 8 }, arp: { on: true, rate: 0.25, mode: 'updown', octaves: 1, gate: 0.4 } },
    });
    const siren = mk({ name: 'Siren', instrument: 'chip', volume: 0.2, pan: -0.3, fx: { reverb: 0.3, delay: { mix: 0.2, beats: 0.75, feedback: 0.3 } } });
    const drums = mk({ name: 'Drums', instrument: 'drums', volume: 0.8, fx: { reverb: 0.1 } });
    const add = (tr, p, s, d, v) => tr.notes.push({ p, s, d, v });

    // ---- the hymn
    for (const n of S) add(lead, n.p, n.s, n.d * 0.92, 0.9);
    for (const n of [...A, ...T]) add(organ, n.p, n.s, n.d * 0.96, 0.75);
    // Choir chants the melody in unison, like an ominous chant.
    for (const n of S) add(choir, n.p, n.s, n.d, 0.7);
    for (const n of B) {
      add(sub, n.p - 12, n.s, n.d * 0.95, 0.8);
      // Laser bass hammers each bass note as 8th notes.
      for (let b = 0; b < n.d - EPS; b += 0.5) add(bass, n.p, n.s + b, 0.4, b % 1 ? 0.6 : 0.9);
    }
    for (const n of [...A, ...T]) add(arp, n.p + 12, n.s, n.d, 0.6);
    for (const n of B) add(arp, n.p + 24, n.s, n.d, 0.6);

    // ---- intro: tritone alarm siren, low drone, rising toms
    for (let b = 0; b < 6; b += 0.5) add(siren, b % 1 ? 78 : 84, b, 0.45, 0.7); // C6 / F#5
    add(organ, 48, 0, 7, 0.7); add(organ, 55, 0, 7, 0.7); add(organ, 60, 0, 7, 0.7); add(organ, 63, 0, 7, 0.7);
    add(choir, 60, 2, 5, 0.5); add(choir, 63, 2, 5, 0.5); add(choir, 67, 2, 5, 0.5);
    add(sub, 36, 0, 7, 0.9);
    for (let b = 4; b < 7; b += 0.5) add(bass, 48, b, 0.4, 0.5 + (b - 4) * 0.12);

    // ---- breakdown (beats 80-95): Cm, A♭, Fm, G — melody rests, laser stabs, snare roll back into the loop
    const breakChords = [[80, 48, [60, 63, 67]], [84, 44, [60, 63, 68]], [88, 41, [60, 65, 68]], [92, 43, [59, 62, 67]]];
    for (const [s, root, ch] of breakChords) {
      const len = s === 92 ? 3 : 4;
      for (const p of ch) { add(organ, p, s, len, 0.8); add(arp, p + 12, s, len, 0.65); }
      add(sub, root - 12, s, len, 0.9);
      for (let b = 0; b < len - EPS; b += 0.5) add(bass, root, s + b, 0.4, b % 1 ? 0.65 : 0.95);
    }
    add(choir, 67, 88, 7, 0.6); add(choir, 71, 92, 3, 0.7); add(choir, 74, 92, 3, 0.7);
    for (let b = 80; b < 92; b += 1.5) add(siren, b % 3 ? 78 : 84, b, 0.4, 0.5);

    // ---- drums
    const D = (p, s, v) => add(drums, p, s, 0.25, v);
    for (let b = 0; b < 7; b++) D([41, 43, 45, 47, 48, 50, 50][b], b, 0.6 + b * 0.05);
    D(36, 0, 1); D(49, 0, 0.7); D(63, 4, 0.6);
    for (let bar = 2; bar < 24; bar++) {
      const s = bar * 4;
      if (s >= 92) break;
      const intense = s >= 40; // second half of the hymn: double kick
      if (intense) for (let k = 0; k < 16; k++) D(36, s + k * 0.25, k % 2 ? 0.55 : 0.9);
      else { D(36, s, 1); D(36, s + 0.5, 0.6); D(36, s + 2, 0.95); D(36, s + 2.5, 0.6); }
      D(38, s + 1, 0.85); D(38, s + 3, 0.85);
      for (let h = 0; h < 8; h++) D(intense ? 51 : 42, s + h * 0.5, h % 2 ? 0.4 : 0.6);
    }
    for (const b of [8, 24, 40, 56, 72, 80]) D(49, b, 0.8);
    for (const b of [80, 84, 88]) D(65, b, 0.8); // laser stabs
    // snare roll + toms back into the loop
    for (let k = 0; k < 8; k++) D(38, 92 + k * 0.25, 0.4 + k * 0.07);
    [50, 48, 47, 45, 43, 41, 41, 36].forEach((p, i) => D(p, 94 + i * 0.125, 0.8));
    D(63, 92, 0.7);

    for (const tr of song.tracks) tr.notes.sort((a, b) => a.s - b.s || a.p - b.p);
    return song;
  },

  // "Let All Exalt Jehovah's Goodness" is sung to NAVARRE (also called RENDEZ À DIEU),
  // Louis Bourgeois, Genevan Psalter 1551. The melody below is the original tune; each phrase is
  // padded to whole 4/4 bars so it grooves and loops cleanly.
  navarre() {
    const song = Song.create();
    song.title = 'Let All Exalt (NAVARRE Hyperdrive)';
    song.bpm = 126;
    song.timeSig = { num: 4, den: 4 };
    song.key = { root: 7, scale: 'major' }; // G major
    song.bars = 28;
    song.loop = { enabled: true, start: 0, end: 112 };
    song.master = { volume: 0.85, reverbSeconds: 2.6 };
    song.tracks = [];

    // Melody phrases: [pitch, beats]. 62=D4 64=E4 66=F♯4 67=G4 69=A4 71=B4 72=C5 74=D5
    const L1 = [[67, 2], [64, 1], [62, 1], [67, 1], [67, 1], [69, 1], [72, 1], [71, 2], [69, 2]];
    const L2 = [[74, 2], [71, 1], [71, 1], [67, 1], [72, 1], [71, 2], [69, 2], [67, 4]];
    const L4 = [[74, 2], [72, 1], [71, 1], [69, 1], [67, 1], [67, 1], [66, 1], [67, 4]];
    const L5 = [[74, 2], [74, 1], [72, 1], [71, 2], [69, 2], [67, 1], [66, 1], [64, 2], [62, 2]];
    const L6 = [[62, 2], [67, 1], [67, 1], [66, 1], [64, 1], [67, 2], [69, 2], [71, 4]];
    const L7 = [[67, 2], [67, 1], [69, 1], [71, 1], [67, 1], [72, 1], [72, 1], [71, 2], [69, 2]];
    // Chords: [beat within phrase, chord]
    const C1 = [[0, 'G'], [2, 'C'], [4, 'Em'], [6, 'Am'], [8, 'G'], [10, 'D']];
    const C2 = [[0, 'G'], [2, 'Bm'], [4, 'Em'], [5, 'Am'], [6, 'G'], [8, 'D'], [10, 'G']];
    const C4 = [[0, 'G'], [2, 'Am'], [3, 'G'], [4, 'Am'], [5, 'C'], [7, 'D'], [8, 'G']];
    const C5 = [[0, 'G'], [2, 'D'], [3, 'Am'], [4, 'G'], [6, 'D7'], [8, 'Em'], [9, 'D'], [10, 'A'], [12, 'D']];
    const C6 = [[0, 'G'], [3, 'C'], [4, 'D'], [5, 'Em'], [6, 'C'], [8, 'Am'], [10, 'B']];
    const C7 = [[0, 'Em'], [3, 'D'], [4, 'G'], [5, 'C'], [6, 'Am'], [8, 'G'], [10, 'D']];
    const C8 = [[0, 'G'], [2, 'C'], [3, 'G'], [4, 'Am'], [5, 'Em'], [6, 'D'], [8, 'G']];
    // [melody, chords, phrase length in beats]
    const phrases = [[L1, C1, 12], [L2, C2, 16], [L1, C1, 12], [L4, C4, 12], [L5, C5, 16], [L6, C6, 16], [L7, C7, 12], [L4, C8, 16]];

    const chordNotes = {
      G: [55, 59, 62], C: [55, 60, 64], D: [54, 57, 62], Em: [55, 59, 64], Am: [57, 60, 64],
      Bm: [54, 59, 62], D7: [54, 57, 60], A: [57, 61, 64], B: [54, 59, 63],
    };
    const bassRoot = { G: 43, C: 48, D: 50, Em: 40, Am: 45, Bm: 47, D7: 50, A: 45, B: 47 };

    const lead = Song.newTrack(song, {
      name: 'Melody', instrument: 'lead', volume: 0.7,
      fx: { reverb: 0.3, delay: { mix: 0.25, beats: 0.75, feedback: 0.35 } },
    });
    song.tracks.push(lead);
    const choir = Song.newTrack(song, { name: 'Choir', instrument: 'choir', volume: 0.45, fx: { reverb: 0.55 } });
    song.tracks.push(choir);
    const bass = Song.newTrack(song, { name: 'Bass', instrument: 'acid', volume: 0.5, fx: { reverb: 0.05 } });
    song.tracks.push(bass);
    const arp = Song.newTrack(song, {
      name: 'Arp', instrument: 'pluck', volume: 0.32, pan: -0.25,
      fx: {
        reverb: 0.35, delay: { mix: 0.15, beats: 0.75, feedback: 0.3 },
        filter: { cutoff: 3000, q: 4, sweepDepth: 0.5, sweepBeats: 16 },
        arp: { on: true, rate: 0.25, mode: 'up', octaves: 2, gate: 0.5 },
      },
    });
    song.tracks.push(arp);
    const drums = Song.newTrack(song, { name: 'Drums', instrument: 'drums', volume: 0.75, fx: { reverb: 0.12 } });
    song.tracks.push(drums);

    let off = 0;
    phrases.forEach(([mel, chords, len], pi) => {
      let t = off;
      for (const [p, d] of mel) {
        lead.notes.push({ p, s: t, d: d >= 2 ? d * 0.97 : d * 0.9, v: 0.85 });
        t += d;
      }
      chords.forEach(([cs, name], ci) => {
        const ce = ci + 1 < chords.length ? chords[ci + 1][0] : len;
        const s = off + cs, d = ce - cs;
        for (const p of chordNotes[name]) choir.notes.push({ p, s, d, v: 0.65 });
        if (pi >= 2) for (const p of chordNotes[name]) arp.notes.push({ p: p + 12, s, d, v: 0.6 });
        const r = bassRoot[name];
        if (pi < 2) bass.notes.push({ p: r, s, d: d * 0.95, v: 0.75 });
        else for (let b = 0; b < d - EPS; b += 0.5) bass.notes.push({ p: r + (Math.round(b * 2) % 2 ? 12 : 0), s: s + b, d: 0.4, v: Math.round(b * 2) % 2 ? 0.55 : 0.85 });
      });
      off += len;
    });

    // Drums: gentle intro for the first two phrases (bars 1-7), full beat after.
    const D = (p, s, v) => drums.notes.push({ p, s, d: 0.25, v });
    for (let bar = 0; bar < 28; bar++) {
      const s = bar * 4;
      if (bar < 7) {
        D(36, s, 0.7);
        for (let h = 0; h < 8; h++) D(42, s + h * 0.5, h % 2 ? 0.35 : 0.2);
        continue;
      }
      D(36, s, 0.95); D(36, s + 2, 0.9); D(36, s + 2.5, 0.5);
      D(38, s + 1, 0.7); D(38, s + 3, 0.7);
      for (let h = 0; h < 8; h++) D(h === 7 ? 46 : 42, s + h * 0.5, h % 2 ? 0.55 : 0.3);
    }
    for (const b of [0, 7, 13, 17]) D(49, b * 4, 0.6);
    // Tom fill at the end of phrase 4, sweeps into the big moments and back to the loop start.
    [50, 48, 47, 45, 43, 41, 41, 36].forEach((p, i) => D(p, 52 - 2 + i * 0.25, 0.75));
    D(63, 6 * 4 + 2, 0.6);
    D(63, 27 * 4 + 2, 0.6);

    for (const tr of song.tracks) tr.notes.sort((a, b) => a.s - b.s || a.p - b.p);
    return song;
  },

  // "Amazing Grace" (tune NEW BRITAIN, 1829, public domain) as a space waltz.
  amazingGrace() {
    const song = Song.create();
    song.title = 'Amazing Grace (Space Waltz)';
    song.bpm = 92;
    song.timeSig = { num: 3, den: 4 };
    song.key = { root: 7, scale: 'major' }; // G major
    song.bars = 17;
    // The melody starts with a one-beat pickup on beat 3, so the loop runs from there.
    song.loop = { enabled: true, start: 2, end: 50 };
    song.master = { volume: 0.85, reverbSeconds: 3.2 };
    song.tracks = [];

    const D4 = 62, E4 = 64, G4 = 67, A4 = 69, B4 = 71, D5 = 74;
    const melody = [
      [D4, 1],
      [G4, 2], [B4, 0.5], [G4, 0.5], [B4, 2], [A4, 1], [G4, 2], [E4, 1], [D4, 2], [D4, 1],
      [G4, 2], [B4, 0.5], [G4, 0.5], [B4, 2], [A4, 1], [D5, 5], [B4, 1],
      [D5, 2], [B4, 0.5], [G4, 0.5], [B4, 2], [A4, 1], [G4, 2], [E4, 1], [D4, 2], [D4, 1],
      [G4, 2], [B4, 0.5], [G4, 0.5], [B4, 2], [A4, 1], [G4, 5],
    ];
    const lead = Song.newTrack(song, {
      name: 'Melody', instrument: 'theremin', volume: 0.75,
      fx: { reverb: 0.35, delay: { mix: 0.22, beats: 1.5, feedback: 0.35 } },
    });
    let t = 2;
    for (const [p, d] of melody) {
      lead.notes.push({ p, s: t, d: d * 0.97, v: 0.8 });
      t += d;
    }
    song.tracks.push(lead);

    const chords = {
      G: [55, 59, 62], C: [55, 60, 64], D: [54, 57, 62], Em: [55, 59, 64],
    };
    const roots = { G: 43, C: 48, D: 50, Em: 40 };
    const prog = ['G', 'G', 'C', 'G', 'G', 'Em', 'D', 'G', 'G', 'G', 'C', 'G', 'Em', 'D', 'G', 'G'];

    const pad = Song.newTrack(song, {
      name: 'Pad', instrument: 'pad', volume: 0.6,
      fx: { reverb: 0.5, filter: { cutoff: 1400, q: 2, sweepDepth: 0.45, sweepBeats: 12 } },
    });
    song.tracks.push(pad);
    const bass = Song.newTrack(song, { name: 'Bass', instrument: 'bass', volume: 0.7, fx: { reverb: 0.05 } });
    song.tracks.push(bass);
    const arp = Song.newTrack(song, {
      name: 'Arp', instrument: 'bell', volume: 0.35, pan: 0.3,
      fx: { reverb: 0.45, delay: { mix: 0.25, beats: 0.75, feedback: 0.4 }, arp: { on: true, rate: 0.5, mode: 'updown', octaves: 2, gate: 0.7 } },
    });
    song.tracks.push(arp);
    const drums = Song.newTrack(song, { name: 'Drums', instrument: 'drums', volume: 0.7, fx: { reverb: 0.15 } });
    song.tracks.push(drums);

    prog.forEach((c, i) => {
      const s = 3 + i * 3;
      const len = i === prog.length - 1 ? 2 : 3; // last bar is short: the pickup completes it
      for (const p of chords[c]) pad.notes.push({ p, s, d: len, v: 0.7 });
      bass.notes.push({ p: roots[c], s, d: len * 0.95, v: 0.8 });
      if (i >= 4) for (const p of chords[c]) arp.notes.push({ p: p + 12, s, d: len, v: 0.6 });
      // Drums come in at bar 5.
      if (i >= 4) {
        drums.notes.push({ p: 36, s, d: 0.5, v: 0.9 });
        if (i === 4 || i === 12) drums.notes.push({ p: 49, s, d: 0.5, v: 0.6 });
        for (let h = 0; h < len * 2; h++) drums.notes.push({ p: 42, s: s + h * 0.5, d: 0.25, v: h % 2 ? 0.35 : 0.6 });
        if (len === 3) drums.notes.push({ p: 38, s: s + 2, d: 0.5, v: 0.5 });
      }
      if (i === 3 || i === 11) drums.notes.push({ p: 63, s: s + 1, d: 2, v: 0.6 });
    });

    for (const tr of song.tracks) tr.notes.sort((a, b) => a.s - b.s || a.p - b.p);
    return song;
  },
};
