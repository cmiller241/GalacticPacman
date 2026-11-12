// tools/gen-tetris-sounds.mjs
//
// Synthesizes the Tetris planet's sound (see AudioManager.playTetrisClear):
//   sounds/tetris-clear.wav  a row of a quadrant clearing: a quick, bright
//                            rising arpeggio (C, E, G, high C) in soft
//                            square-ish tones, with a shimmer of sparkles
//                            over the top. ~0.6s.
// Run: node tools/gen-tetris-sounds.mjs

import { writeFileSync } from 'node:fs';

const RATE = 44100;
const LENGTH = 0.6;        // seconds
const n = Math.floor(RATE * LENGTH);
const out = new Float32Array(n);

let seed = 7373; // fixed seed so the file comes out the same every run
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;

// The arpeggio: each note's start (seconds) and pitch (Hz).
const NOTES = [
  { at: 0.00, hz: 523.25 },  // C5
  { at: 0.06, hz: 659.25 },  // E5
  { at: 0.12, hz: 783.99 },  // G5
  { at: 0.18, hz: 1046.50 }, // C6
];
// A note: a soft square (a few odd harmonics), a fast attack and a decay.
function note(t, hz, decay) {
  if (t < 0) return 0;
  const p = 2 * Math.PI * hz * t;
  const tone = Math.sin(p) + Math.sin(3 * p) / 3 * 0.6 + Math.sin(5 * p) / 5 * 0.35;
  return tone * Math.min(1, t / 0.004) * Math.exp(-t / decay);
}

// Sparkles: short high pings at random moments, mostly after the last note.
const SPARKLES = [];
for (let k = 0; k < 14; k++) {
  SPARKLES.push({ at: 0.16 + Math.abs(rand()) * 0.35, hz: 2200 + Math.abs(rand()) * 2600, gain: 0.12 + Math.abs(rand()) * 0.12 });
}

for (let i = 0; i < n; i++) {
  const t = i / RATE;
  let s = 0;
  NOTES.forEach((nt, k) => {
    // (The last note rings on longer.)
    s += note(t - nt.at, nt.hz, k === NOTES.length - 1 ? 0.22 : 0.09) * 0.5;
  });
  for (const sp of SPARKLES) {
    const tt = t - sp.at;
    if (tt >= 0 && tt < 0.08) s += Math.sin(2 * Math.PI * sp.hz * tt) * Math.exp(-tt / 0.02) * sp.gain;
  }
  out[i] = s;
}

// Fade both ends to silence.
const edge = Math.floor(RATE * 0.006);
for (let i = 0; i < edge; i++) { out[i] *= i / edge; out[n - 1 - i] *= i / edge; }
let peak = 0;
for (const s of out) peak = Math.max(peak, Math.abs(s));
if (!(peak > 0)) throw new Error('generated sound is silent or invalid (peak = ' + peak + ')');
const gain = 0.7 / peak;

function writeWav(path, samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => buf.writeInt16LE(Math.round(s * gain * 32767), 44 + i * 2));
  writeFileSync(new URL(`../${path}`, import.meta.url), buf);
  console.log(`wrote ${path}`);
}

writeWav('sounds/tetris-clear.wav', out);
