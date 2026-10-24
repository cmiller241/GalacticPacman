// js/world/Lava.js
//
// One hazardous lava tile (see TiledTerrain.js's buildLavaTiles).
// Rendered as one quad with a GLSL shader, rather than the sheet's own
// flat red tile art (skipped when baking TiledTerrain's static canvas) —
// the shader punches a transparent hole above an animated sinusoidal
// surface line near the top of the tile, so what's actually "lava" is
// only the area below that wavy line.
//
// Each tile is its own independent instance — the wave's phase is
// driven by absolute WORLD X, so adjacent tiles line up at their shared
// edge regardless of being separate draws.
//
// Small embers spawn along that same surface line and drift upward.

import love from '../love/index.js';
import state from '../state.js';
import Vector2 from '../vector2.js';

// ---------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------

const WAVE_AMPLITUDE = 4;    // world units, how far the surface bobs up/down
const WAVE_FREQUENCY = 0.05; // radians per world unit along X — higher means more ripples per tile
const WAVE_SPEED = 1.4;      // radians per sharedTime unit
const WAVE_BASE_Y = 16;      // world units down from the tile's own top edge where the surface sits at rest
const EDGE_SOFTNESS = 2.5;   // world units of blur across the transparent/opaque boundary
const GLOW_BAND = 22;        // world units below the surface line the hot glow fades out over
const COLOR_DEEP = [0.45, 0.05, 0.02]; // deep red, the coolest/darkest crust
const COLOR_MID = [0.85, 0.28, 0.03];  // glowing orange, the body's main tone
const COLOR_HOT = [1.0, 0.65, 0.15];   // bright yellow-white, the hottest specks/surface

// Plasma-style mottled texture over the lava's body — same fbm-noise
// recipe as Sun.js's own plasma shader, scaled way down for a 64-unit
// tile. Driven by absolute WORLD position, so the mottling is continuous
// across adjacent tiles too.
const PLASMA_SCALE = 0.05;        // spatial frequency of the coarse noise layer, per world unit
const PLASMA_DETAIL_SCALE = 2.6;  // how much finer the second (speckle) noise layer is
// Both faster than Sun.js's own: a puddle of lava should read as
// actively roiling, a sun as stately and slow.
const PLASMA_EVOLVE_SPEED = 0.18; // how fast the pattern churns in place
const PLASMA_SCROLL_SPEED = 0.06; // horizontal drift on top of the churn

const EMBER_SPAWN_CHANCE = 0.35; // per tile, per baseline frame
const EMBER_RISE_SPEED_MIN = 0.6;
const EMBER_RISE_SPEED_MAX = 1.4;
const EMBER_DRIFT = 0.35;
const EMBER_LIFE_MIN = 0.9; // seconds
const EMBER_LIFE_MAX = 1.8; // seconds
const EMBER_RADIUS_MIN = 1.2;
const EMBER_RADIUS_MAX = 2.6;

function newEmber(x, y) {
  const speed = EMBER_RISE_SPEED_MIN + Math.random() * (EMBER_RISE_SPEED_MAX - EMBER_RISE_SPEED_MIN);
  const lifeSeconds = EMBER_LIFE_MIN + Math.random() * (EMBER_LIFE_MAX - EMBER_LIFE_MIN);
  return {
    x, y,
    vx: (Math.random() * 2 - 1) * EMBER_DRIFT,
    vy: -speed,
    life: 1,
    decayPerSecond: 1 / lifeSeconds,
    radius: EMBER_RADIUS_MIN + Math.random() * (EMBER_RADIUS_MAX - EMBER_RADIUS_MIN),
  };
}

// One compiled instance, shared by every Lava tile. Uses screen_coords
// (converted back to a position local to this tile), not texture_coords.
let lavaShader = null;
function getLavaShader() {
  if (lavaShader) return lavaShader;
  lavaShader = love.graphics.newShader(`
    extern vec2 originScreen; // this tile's own top-left corner, in SCREEN pixels, this frame
    extern number zoom;
    extern number time;
    extern number worldX0;     // this tile's own top-left corner, in WORLD units
    extern number worldY0;
    extern number waveAmplitude;
    extern number waveFrequency;
    extern number waveSpeed;
    extern number waveBaseY;
    extern number edgeSoftness;
    extern number glowBand;
    extern number plasmaScale;
    extern number detailScale;
    extern number evolveSpeed;
    extern number scrollSpeed;
    extern vec3 colorDeep;
    extern vec3 colorMid;
    extern vec3 colorHot;

    // Cheap scramble hash (Dave Hoskins-style).
    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    // Bilinear value noise, smoothed with a Hermite curve.
    float valueNoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      float a = hash(i);
      float b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0));
      float d = hash(i + vec2(1.0, 1.0));
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }

    // Fractal Brownian motion — a few octaves summed into a mottled,
    // multi-scale texture.
    float fbm(vec2 p) {
      float value = 0.0;
      float amp = 0.5;
      for (int i = 0; i < 4; i++) {
        value += amp * valueNoise(p);
        p *= 2.02;
        amp *= 0.55;
      }
      return value;
    }

    vec4 effect(vec4 color, Image tex, vec2 texture_coords, vec2 screen_coords) {
      vec2 localWorld = (screen_coords - originScreen) / zoom; // position within this tile, world units
      float localY = localWorld.y;
      float worldX = worldX0 + localWorld.x;
      float worldY = worldY0 + localWorld.y;

      float wave = sin(worldX * waveFrequency + time * waveSpeed) * waveAmplitude
                 + sin(worldX * waveFrequency * 2.3 - time * waveSpeed * 1.7) * waveAmplitude * 0.35;
      float surfaceY = waveBaseY + wave;

      // Above the line: fully transparent. Below it: opaque lava,
      // blended smoothly across edgeSoftness.
      float alpha = smoothstep(surfaceY - edgeSoftness, surfaceY + edgeSoftness, localY);

      // Plasma-style mottling, continuous across adjacent tiles.
      vec2 gp = vec2(worldX, worldY) * plasmaScale + vec2(time * scrollSpeed, -time * evolveSpeed);
      float grain = fbm(gp);
      float speck = fbm(gp * detailScale + 5.2);
      float v = clamp(grain * 0.7 + speck * 0.3, 0.0, 1.0);

      // Biased hotter the closer a pixel sits to the wave surface.
      float depthBelowSurface = localY - surfaceY;
      float glowBias = clamp(1.0 - depthBelowSurface / glowBand, 0.0, 1.0);
      v = clamp(v * 0.55 + glowBias * 0.6, 0.0, 1.0);

      vec3 lavaColor = mix(colorDeep, colorMid, smoothstep(0.25, 0.55, v));
      lavaColor = mix(lavaColor, colorHot, smoothstep(0.6, 0.9, v));

      return vec4(lavaColor, alpha) * color;
    }
  `);
  return lavaShader;
}

// Shared wave clock — ONE value read by every Lava tile's shader (a
// per-tile random phase made the wave jump at every tile edge). Advanced
// once per frame via Lava.updateSharedClock() from main.js — not inside
// update(), which runs once PER TILE.
let sharedTime = 0;

class Lava {
  // x, y: world position of this tile's own top-left corner.
  // tileWorldSize: world units per tile (TiledTerrain.TILE_WORLD_SIZE).
  static new(x, y, tileWorldSize) {
    return new Lava(x, y, tileWorldSize);
  }

  static updateSharedClock() {
    const timeScale = state.timeScale ?? 1;
    // Frame-normalized units, so V.A.T.S. slows the wave down too.
    sharedTime += (1 / 60) * timeScale;
  }

  constructor(x, y, tileWorldSize) {
    this.x0 = x;
    this.y0 = y;
    this.size = tileWorldSize;

    // Bounding-circle center/radius (see utils.isOnScreen).
    this.pos = new Vector2(x + this.size / 2, y + this.size / 2);
    this.radius = this.size * 0.7071067811865476; // half-diagonal of a square tile

    this.embers = [];

    // Immovable/permanent terrain-like hazard, not something to pull
    // toward or hard-lock onto.
    this.isImmovable = true;
    this.isPermanent = true;
    this.isPullExempt = true;
  }

  update() {
    const timeScale = state.timeScale ?? 1;

    if (Math.random() < EMBER_SPAWN_CHANCE * timeScale) {
      const ex = this.x0 + Math.random() * this.size;
      const ey = this.y0 + WAVE_BASE_Y;
      this.embers.push(newEmber(ex, ey));
    }

    for (let i = this.embers.length - 1; i >= 0; i--) {
      const e = this.embers[i];
      e.x += e.vx * timeScale;
      e.y += e.vy * timeScale;
      e.life -= e.decayPerSecond * (timeScale / 60);
      if (e.life <= 0) this.embers.splice(i, 1);
    }
  }

  draw() {
    const shader = getLavaShader();
    const zoom = state.zoom ?? 1;
    const cam = state.camera ?? { x: 0, y: 0 };

    love.graphics.setShader(shader);
    shader.send('originScreen', [(this.x0 - cam.x) * zoom, (this.y0 - cam.y) * zoom]);
    shader.send('zoom', zoom);
    shader.send('time', sharedTime);
    shader.send('worldX0', this.x0);
    shader.send('worldY0', this.y0);
    shader.send('waveAmplitude', WAVE_AMPLITUDE);
    shader.send('waveFrequency', WAVE_FREQUENCY);
    shader.send('waveSpeed', WAVE_SPEED);
    shader.send('waveBaseY', WAVE_BASE_Y);
    shader.send('edgeSoftness', EDGE_SOFTNESS);
    shader.send('glowBand', GLOW_BAND);
    shader.send('plasmaScale', PLASMA_SCALE);
    shader.send('detailScale', PLASMA_DETAIL_SCALE);
    shader.send('evolveSpeed', PLASMA_EVOLVE_SPEED);
    shader.send('scrollSpeed', PLASMA_SCROLL_SPEED);
    shader.send('colorDeep', COLOR_DEEP);
    shader.send('colorMid', COLOR_MID);
    shader.send('colorHot', COLOR_HOT);

    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.rectangle('fill', this.x0, this.y0, this.size, this.size);
    love.graphics.setShader();

    for (const e of this.embers) {
      const a = Math.max(0, e.life);
      love.graphics.setColor(1, 0.35 + 0.5 * a, 0.05 + 0.25 * a, a);
      love.graphics.circle('fill', e.x, e.y, e.radius);
    }
    love.graphics.setColor(1, 1, 1, 1);
  }
}

export default Lava;
