#!/usr/bin/env node
// Converts WAV files exported from the composer into game-ready OGG (and MP3) files using ffmpeg.
//
//   node composer/tools/convert-music.cjs                      -> converts every .wav in composer/exports/
//   node composer/tools/convert-music.cjs path/to/song.wav     -> converts just that file
//   options:  --out <dir>   output folder (default: sounds/music)
//             --no-mp3      only make .ogg
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
let outDir = path.join(root, 'sounds', 'music');
let mp3 = true;
const inputs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') outDir = path.resolve(args[++i]);
  else if (args[i] === '--no-mp3') mp3 = false;
  else inputs.push(path.resolve(args[i]));
}
if (!inputs.length) {
  const dir = path.join(root, 'composer', 'exports');
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (/\.wav$/i.test(f)) inputs.push(path.join(dir, f));
}
if (!inputs.length) {
  console.log('No WAV files given and none found in composer/exports/.');
  console.log('Usage: node composer/tools/convert-music.cjs my-song.wav');
  process.exit(1);
}

const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
if (probe.error) {
  console.error('ffmpeg was not found. Install it with:  winget install Gyan.FFmpeg   (then open a new terminal)');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
let failed = 0;
for (const input of inputs) {
  const base = path.basename(input).replace(/\.wav$/i, '');
  const jobs = [['ogg', ['-c:a', 'libvorbis', '-q:a', '5']]];
  if (mp3) jobs.push(['mp3', ['-c:a', 'libmp3lame', '-q:a', '2']]);
  for (const [ext, codec] of jobs) {
    const out = path.join(outDir, base + '.' + ext);
    const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, ...codec, out], { encoding: 'utf8' });
    if (r.status === 0) {
      const kb = Math.round(fs.statSync(out).size / 1024);
      console.log(`✓ ${path.relative(root, out)}  (${kb} KB)`);
    } else {
      failed++;
      console.error(`✗ ${base}.${ext}: ${r.stderr || r.error}`);
    }
  }
}
process.exit(failed ? 1 : 0);
