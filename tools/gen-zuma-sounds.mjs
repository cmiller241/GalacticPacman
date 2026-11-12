// tools/gen-zuma-sounds.mjs
//
// Synthesizes the Zuma planet's sounds (see AudioManager.playZumaPop and
// playZumaShoot):
//   sounds/zuma-pop.wav    balls clearing: a bubbly "bloop" sliding up in
//                          pitch, with a tiny click on the front. ~0.16s.
//   sounds/zuma-shoot.wav  the cannon firing: a soft low "thoomp" with a
//                          puff of air. ~0.2s.
// Run: node tools/gen-zuma-sounds.mjs

import { writeFileSync } from 'node:fs';

const RATE = 44100;
let seed = 2626; // fixed seed so the files come out the same every run
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
const lowPass = (hz) => 1 - Math.exp(-2 * Math.PI * hz / RATE);

function finish(out, edgeSeconds = 0.004) {
  const n = out.length;
  const edge = Math.floor(RATE * edgeSeconds);
  for (let i = 0; i < edge; i++) { out[i] *= i / edge; out[n - 1 - i] *= i / edge; }
  let peak = 0;
  for (const s of out) peak = Math.max(peak, Math.abs(s));
  if (!(peak > 0)) throw new Error('generated sound is silent or invalid (peak = ' + peak + ')');
  return 0.7 / peak;
}

function writeWav(path, samples, gain) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => buf.writeInt16LE(Math.round(s * gain * 32767), 44 + i * 2));
  writeFileSync(new URL(`../${path}`, import.meta.url), buf);
  console.log(`wrote ${path}`);
}

// The pop: a sine sliding from 320Hz up to 1100Hz, its second harmonic
// for a rounder "bloop", decaying fast; a short bright click at the front.
{
  const n = Math.floor(RATE * 0.16);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const freq = 320 + 780 * (1 - Math.exp(-t / 0.035));
    phase += 2 * Math.PI * freq / RATE;
    const env = Math.min(1, t / 0.003) * Math.exp(-t / 0.045);
    const tone = (Math.sin(phase) + 0.35 * Math.sin(2 * phase)) * env;
    const click = rand() * Math.exp(-t / 0.0025) * 0.5;
    out[i] = tone + click;
  }
  writeWav('sounds/zuma-pop.wav', out, finish(out));
}

// The shot: a low sine dropping from 170Hz to 55Hz, and a puff of
// muffled noise.
{
  const n = Math.floor(RATE * 0.2);
  const out = new Float32Array(n);
  let phase = 0, puff = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const freq = 55 + 115 * Math.exp(-t / 0.03);
    phase += 2 * Math.PI * freq / RATE;
    const thump = Math.sin(phase) * Math.min(1, t / 0.002) * Math.exp(-t / 0.06);
    puff += (rand() - puff) * lowPass(1400);
    const air = puff * 2.2 * Math.min(1, t / 0.004) * Math.exp(-t / 0.035);
    out[i] = thump + air;
  }
  writeWav('sounds/zuma-shoot.wav', out, finish(out));
}
