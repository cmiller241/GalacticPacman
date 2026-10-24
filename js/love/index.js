// js/love/index.js
//
// The `love` object the ported game code calls into — the browser
// stand-in for LÖVE 11. Game modules do `import love from '../love/index.js'`
// and then use love.graphics.*, love.timer.*, love.audio.* and so on
// just as the Lua version did. main.js assigns love.load/update/draw and
// the input callbacks, then calls love.boot().
//
// Images and sounds are preloaded before love.load() runs, because
// LÖVE's newImage/newSource are synchronous and the game relies on that.

import graphics, { ImageData } from './graphics.js';
import audio from './audio.js';
import { keyboard, mouse, joystick, pollGamepads, attach } from './input.js';

const images = new Map();   // path -> ImageBitmap
const imagePixels = new Map(); // path -> ImageData (decoded on demand)
const sounds = new Map();   // path -> AudioBuffer
const knownFiles = new Set();

function normalizePath(p) {
  const parts = [];
  for (const part of String(p).replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

// ---------------- timer ----------------
let lastTime = performance.now() / 1000;
let delta = 0;
let fps = 0;
let fpsFrames = 0;
let fpsTime = 0;

const timer = {
  getTime() { return performance.now() / 1000; },
  getDelta() { return delta; },
  getFPS() { return fps; },
  getAverageDelta() { return fps > 0 ? 1 / fps : 0; },
  step() {
    const now = performance.now() / 1000;
    delta = now - lastTime;
    lastTime = now;
    fpsFrames++;
    fpsTime += delta;
    if (fpsTime >= 1) { fps = Math.round(fpsFrames / fpsTime); fpsFrames = 0; fpsTime = 0; }
    return delta;
  },
  sleep() {},
};

// ---------------- image ----------------
function imageDataFromBitmap(bmp) {
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, bmp.width, bmp.height);
  return new ImageData(bmp.width, bmp.height, d.data);
}

const image = {
  // newImageData(w, h) or newImageData(path)
  newImageData(a, b) {
    if (typeof a === 'string') {
      const path = normalizePath(a);
      let d = imagePixels.get(path);
      if (!d) {
        const bmp = images.get(path);
        if (!bmp) throw new Error(`newImageData: "${a}" was not preloaded`);
        d = imageDataFromBitmap(bmp);
        imagePixels.set(path, d);
      }
      // A fresh copy, as LÖVE gives each call its own ImageData.
      return new ImageData(d.width, d.height, new Uint8ClampedArray(d.data));
    }
    return new ImageData(Math.floor(a), Math.floor(b));
  },
};

// ---------------- math ----------------
// A small seedable generator (xorshift128+). Not LÖVE's exact
// algorithm, so a given seed makes a different (but still repeatable)
// sequence than in the LÖVE build.
class RandomGenerator {
  constructor(seed) { this.setSeed(seed ?? Date.now()); }
  type() { return 'RandomGenerator'; }
  setSeed(seed) {
    // splitmix32 to spread the seed's bits over the state
    let s = Math.floor(Number(seed)) >>> 0 ^ Math.floor(Number(seed) / 4294967296) >>> 0;
    const next = () => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.s = [next(), next(), next(), next()];
    if (!(this.s[0] | this.s[1] | this.s[2] | this.s[3])) this.s[0] = 1;
    this.seed = seed;
  }
  getSeed() { return this.seed; }
  nextFloat() {
    // xoshiro128** -> [0, 1)
    const s = this.s;
    const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
    for (let i = 0; i < 4; i++) s[i] >>>= 0;
    return result / 4294967296;
  }
  random(lo, hi) {
    const r = this.nextFloat();
    if (lo === undefined) return r;
    if (hi === undefined) return Math.floor(r * lo) + 1;
    return Math.floor(r * (hi - lo + 1)) + lo;
  }
  randomNormal(stddev = 1, mean = 0) {
    const u = 1 - this.nextFloat(), v = this.nextFloat();
    return mean + stddev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}
function rotl(x, k) { return ((x << k) | (x >>> (32 - k))) >>> 0; }

const globalRng = new RandomGenerator(Date.now());
const loveMath = {
  newRandomGenerator(seed) { return new RandomGenerator(seed); },
  random(lo, hi) { return globalRng.random(lo, hi); },
  randomNormal(sd, mean) { return globalRng.randomNormal(sd, mean); },
  setRandomSeed(s) { globalRng.setSeed(s); },
  // love.math.noise — 1-4 argument Perlin-ish value noise in [0, 1].
  noise(x, y = 0, z = 0) {
    const h = (ix, iy, iz) => {
      let n = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(iz, 2147483647);
      n = Math.imul(n ^ (n >>> 13), 1274126177);
      return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
    };
    const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
    const tx = x - fx, ty = y - fy, tz = z - fz;
    const s = (t) => t * t * (3 - 2 * t);
    const lerp = (a, b, t) => a + (b - a) * t;
    const c = (dx, dy, dz) => h(fx + dx, fy + dy, fz + dz);
    const x00 = lerp(c(0, 0, 0), c(1, 0, 0), s(tx)), x10 = lerp(c(0, 1, 0), c(1, 1, 0), s(tx));
    const x01 = lerp(c(0, 0, 1), c(1, 0, 1), s(tx)), x11 = lerp(c(0, 1, 1), c(1, 1, 1), s(tx));
    return lerp(lerp(x00, x10, s(ty)), lerp(x01, x11, s(ty)), s(tz));
  },
};

// ---------------- window / filesystem / event ----------------
let canvasEl = null;
const windowApi = {
  setTitle(t) { document.title = t; },
  getTitle() { return document.title; },
  maximize() {},
  minimize() {},
  getMode() { return [graphics.getWidth(), graphics.getHeight(), { fullscreen: !!document.fullscreenElement, resizable: true }]; },
  setMode() { return true; },
  getDimensions() { return graphics.getDimensions(); },
  getDPIScale() { return graphics.getDPIScale(); },
  getFullscreen() { return !!document.fullscreenElement; },
  setFullscreen(on) {
    if (on && !document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else if (!on && document.fullscreenElement) document.exitFullscreen?.();
    return true;
  },
  hasFocus() { return document.hasFocus(); },
};

const filesystem = {
  // Only knows about preloaded assets.
  getInfo(path) {
    const p = normalizePath(path);
    return knownFiles.has(p) ? { type: 'file' } : null;
  },
};

const event = {
  quit() { console.log('love.event.quit() — nothing to quit in a browser tab.'); },
};

const system = {
  getOS() { return 'Web'; },
};

// ---------------- the love object ----------------
const love = {
  graphics, audio, keyboard, mouse, joystick, timer, image, math: loveMath,
  window: windowApi, filesystem, event, system,
  // Callbacks — set by the game.
  load: null, update: null, draw: null,
  keypressed: null, keyreleased: null, mousepressed: null, mousereleased: null,
  mousemoved: null, wheelmoved: null, gamepadpressed: null, gamepadreleased: null,
  joystickadded: null, joystickremoved: null, resize: null, focus: null, textinput: null,
  errorhandler: null,
};

async function loadImage(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  const blob = await res.blob();
  return createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

async function loadSound(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  const buf = await res.arrayBuffer();
  return audio._context().decodeAudioData(buf);
}

function showError(err) {
  console.error(err);
  const pre = document.createElement('pre');
  pre.style.cssText = 'position:fixed;inset:0;margin:0;padding:24px;background:#5b8ac7;color:#fff;font:14px monospace;white-space:pre-wrap;overflow:auto;z-index:10';
  pre.textContent = 'Error\n\n' + (err && err.stack ? err.stack : String(err));
  document.body.appendChild(pre);
}

// boot({ canvas, images: [...paths], sounds: [...paths], onProgress })
love.boot = async function boot({ canvas, images: imagePaths = [], sounds: soundPaths = [], onProgress } = {}) {
  canvasEl = canvas;
  // The canvas gets the display's real pixels (devicePixelRatio of them
  // per CSS pixel — more than 1 on a scaled/high-DPI display, and it
  // changes with browser zoom), while the game keeps working in CSS
  // pixels (love.graphics.getWidth etc.). Otherwise the browser would
  // stretch a lower-resolution image over the window and blur it.
  const fit = () => {
    const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    graphics._setScreen(w, h, canvas.width / w);
  };
  try {
    fit();
    graphics._init(canvas);
  } catch (e) { showError(e); return; }

  graphics._setAssetLookup((p) => images.get(normalizePath(p)));
  audio._setBufferLookup((p) => sounds.get(normalizePath(p)));

  // Preload everything in parallel.
  const total = imagePaths.length + soundPaths.length;
  let done = 0;
  const tick = () => { done++; if (onProgress) onProgress(done, total); };
  try {
    await Promise.all([
      ...imagePaths.map(async (p) => {
        const key = normalizePath(p);
        images.set(key, await loadImage(key));
        knownFiles.add(key);
        tick();
      }),
      ...soundPaths.map(async (p) => {
        const key = normalizePath(p);
        try { sounds.set(key, await loadSound(key)); } catch (e) { console.warn(e); }
        knownFiles.add(key);
        tick();
      }),
    ]);
  } catch (e) { showError(e); return; }

  let firstInput = true;
  attach(canvas, love, () => {
    if (firstInput) { firstInput = false; }
    audio._resume();
  });

  window.addEventListener('resize', () => {
    fit();
    graphics._onResize();
    if (love.resize) love.resize(graphics.getWidth(), graphics.getHeight());
  });

  try {
    if (love.load) love.load();
  } catch (e) { showError(e); return; }

  timer.step();
  const frame = () => {
    try {
      pollGamepads(love);
      const dt = timer.step();
      if (love.update) love.update(dt);
      graphics._beginFrame();
      graphics.clear(...graphics.getBackgroundColor());
      if (love.draw) love.draw();
      graphics._present();
    } catch (e) {
      showError(e);
      return; // stop the loop, like LÖVE's error screen
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
};

export default love;
