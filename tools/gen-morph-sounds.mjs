// tools/gen-morph-sounds.mjs
//
// Synthesizes the morph-ball sounds (see AudioManager.playMorphBall /
// playMorphUnball):
//   sounds/morph-ball.wav    curling up: a short mechanical "shhh" that
//                            drops in pitch, ending in a soft "thunk" as
//                            the ball locks shut. ~0.27s, the same as the
//                            curl animation (BALL_MORPH_SEGMENT_TICKS * 2).
//   sounds/morph-unball.wav  standing back up: the same sound, backwards.
// Run: node tools/gen-morph-sounds.mjs

import { writeFileSync } from 'node:fs';

const RATE = 44100;
const LENGTH = 0.27;      // seconds
const THUNK_AT = 0.19;    // when the ball "locks"
const n = Math.floor(RATE * LENGTH);
const out = new Float32Array(n);

let seed = 4242; // fixed seed so the files come out the same every run
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
const lowPass = (hz) => 1 - Math.exp(-2 * Math.PI * hz / RATE);

let sweepPhase = 0, thunkPhase = 0;
let nA = 0, nB = 0, tA = 0;

for (let i = 0; i < n; i++) {
  const t = i / RATE;

  // The "shhh": noise that gets more muffled as it goes, and a buzzy
  // tone sliding from 520Hz down to 160Hz, both swelling up then cut off
  // by the thunk.
  let swoosh = 0;
  if (t < THUNK_AT + 0.01) {
    const k = Math.min(1, t / THUNK_AT);                      // 0 → 1 across the sweep
    const env = Math.sin(k * Math.PI * 0.5) ** 2              // swell in
      * (t > THUNK_AT ? 1 - (t - THUNK_AT) / 0.01 : 1);       // quick cut at the thunk
    const muffle = lowPass(3000 - 2200 * k);
    nA += (rand() - nA) * muffle;
    nB += (nA - nB) * muffle;
    const freq = 160 + 360 * (1 - k) ** 1.5;
    sweepPhase += 2 * Math.PI * freq / RATE;
    const tone = Math.tanh(Math.sin(sweepPhase) * 2.5) * 0.35; // a bit buzzy, like a servo
    swoosh = (nB * 2.2 + tone) * env * 0.6;
  }

  // The "thunk": a low knock that drops in pitch, plus a tiny muffled tap.
  let thunk = 0;
  if (t >= THUNK_AT) {
    const tt = t - THUNK_AT;
    const freq = 60 + 110 * Math.exp(-tt / 0.012);
    thunkPhase += 2 * Math.PI * freq / RATE;
    tA += (rand() - tA) * lowPass(900);
    const attack = Math.min(1, tt / 0.002);
    thunk = (Math.sin(thunkPhase) * Math.exp(-tt / 0.03) + tA * 3 * Math.exp(-tt / 0.008)) * attack;
  }

  out[i] = swoosh + thunk;
}

// Fade both ends to silence (the backwards copy starts where this ends).
const edge = Math.floor(RATE * 0.008);
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

writeWav('sounds/morph-ball.wav', out);
writeWav('sounds/morph-unball.wav', Float32Array.from(out).reverse());
