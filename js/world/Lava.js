// js/world/Lava.js
//
// One tile's worth of lava, drawn on its own — now just the effect played
// over a tile of lava turning to obsidian and back (see WaterSystem.js's
// "Lava meeting water: obsidian"; the lava itself is a liquid there,
// flowing like the water). A square tile (Lava.new), or with
// Lava.newOnRing one tile of a Tiled map wrapped round a planet (see
// CrackedPlanetoid.fromTiledMap): a curved slice of a ring, its surface
// following the ring round and its embers rising away from the planet's
// center.
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

// Turning to obsidian (a ring tile water's got to — see harden()) and
// back (a fireball melting it — see melt()). Over HARDEN_SECONDS the
// surface rises flat to the tile's top, the body darkens to glassy
// black with glowing cracks hanging on longest, then fades out over the
// obsidian block baked underneath. Melting plays it backwards.
const HARDEN_SECONDS = 1.2;
const MELT_SECONDS = 0.8;
const COLOR_OBSIDIAN = [0.075, 0.055, 0.11]; // (matching img/obsidian.png)
const COLOR_OBSIDIAN_SHEEN = [0.30, 0.22, 0.45];

const EMBER_SPAWN_CHANCE = 0.35; // per tile, per baseline frame
const EMBER_RISE_SPEED_MIN = 0.6;
const EMBER_RISE_SPEED_MAX = 1.4;
const EMBER_DRIFT = 0.35;
const EMBER_LIFE_MIN = 0.9; // seconds
const EMBER_LIFE_MAX = 1.8; // seconds
const EMBER_RADIUS_MIN = 1.2;
const EMBER_RADIUS_MAX = 2.6;

const RING_PIECE_LENGTH = 10; // world units of arc per straight piece of a ring tile's shape

// (ux, uy): which way is up for it — straight up the screen on a flat
// level (the default), away from the planet's center on a ring.
function newEmber(x, y, ux = 0, uy = -1) {
  const speed = EMBER_RISE_SPEED_MIN + Math.random() * (EMBER_RISE_SPEED_MAX - EMBER_RISE_SPEED_MIN);
  const lifeSeconds = EMBER_LIFE_MIN + Math.random() * (EMBER_LIFE_MAX - EMBER_LIFE_MIN);
  const drift = (Math.random() * 2 - 1) * EMBER_DRIFT;
  return {
    x, y,
    vx: -uy * drift + ux * speed,
    vy: ux * drift + uy * speed,
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
    extern number waveFrequency2; // the second, smaller ripple's frequency
    // Ring mode (polar = 1, see Lava.newOnRing): the tile is a slice of
    // a ring round a planet, so "along the surface" is the angle round
    // it and "down" is in toward its center.
    extern number polar;
    extern vec2 centerScreen;  // the planet's center, in SCREEN pixels, this frame
    extern number rotation;    // how far the planet has turned (radians)
    extern number ringOuter;   // the ring's outside radius: the tile's top edge
    // Turning to obsidian: cool 0 (lava) .. 1 (obsidian); overlayAlpha
    // fades the whole thing out at the end, over the baked block.
    extern number cool;
    extern number overlayAlpha;
    extern vec3 colorObsidian;
    extern vec3 colorObsidianSheen;

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
      float localY;    // how far below the tile's top edge, in world units
      float alongX;    // how far along the surface, in world units (drives the wave)
      vec2 noisePos;   // where it is, for the mottling below
      if (polar > 0.5) {
        vec2 d = (screen_coords - centerScreen) / zoom;
        float c = cos(rotation);
        float s = sin(rotation);
        vec2 f = vec2(d.x * c + d.y * s, -d.x * s + d.y * c); // (in the planet's own, unturned frame)
        localY = ringOuter - length(f);
        alongX = atan(f.y, f.x) * ringOuter;
        noisePos = f;
      } else {
        vec2 localWorld = (screen_coords - originScreen) / zoom; // position within this tile, world units
        localY = localWorld.y;
        alongX = worldX0 + localWorld.x;
        noisePos = vec2(alongX, worldY0 + localWorld.y);
      }

      float wave = sin(alongX * waveFrequency + time * waveSpeed) * waveAmplitude
                 + sin(alongX * waveFrequency2 - time * waveSpeed * 1.7) * waveAmplitude * 0.35;
      float surfaceY = waveBaseY + wave;

      // Above the line: fully transparent. Below it: opaque lava,
      // blended smoothly across edgeSoftness.
      float alpha = smoothstep(surfaceY - edgeSoftness, surfaceY + edgeSoftness, localY);

      // Plasma-style mottling, continuous across adjacent tiles.
      vec2 gp = noisePos * plasmaScale + vec2(time * scrollSpeed, -time * evolveSpeed);
      float grain = fbm(gp);
      float speck = fbm(gp * detailScale + 5.2);
      float v = clamp(grain * 0.7 + speck * 0.3, 0.0, 1.0);

      // Biased hotter the closer a pixel sits to the wave surface.
      float depthBelowSurface = localY - surfaceY;
      float glowBias = clamp(1.0 - depthBelowSurface / glowBand, 0.0, 1.0);
      v = clamp(v * 0.55 + glowBias * 0.6, 0.0, 1.0);

      vec3 lavaColor = mix(colorDeep, colorMid, smoothstep(0.25, 0.55, v));
      lavaColor = mix(lavaColor, colorHot, smoothstep(0.6, 0.9, v));

      // Cooling to obsidian: the body goes dark first, glassy where the
      // coarse noise is high; thin cracks (the fine noise's ridges) keep
      // glowing a while longer, then go dark too.
      float bodyHeat = 1.0 - smoothstep(0.0, 0.55, cool);
      float crackHeat = 1.0 - smoothstep(0.3, 0.95, cool);
      float crack = smoothstep(0.80, 0.96, 1.0 - abs(speck * 2.0 - 1.0));
      vec3 rock = mix(colorObsidian, colorObsidianSheen, grain * grain * 0.8);
      vec3 col = mix(rock, lavaColor, bodyHeat);
      col = mix(col, mix(colorMid, colorHot, crackHeat), crack * crackHeat * (1.0 - bodyHeat));

      return vec4(col, alpha * overlayAlpha) * color;
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

    // (Only lava on a planet turns to obsidian — see Lava.newOnRing — but
    // these are read for every tile.)
    this.cool = 0; this.coolDir = 0; this.hardened = false;

    this.embers = [];

    // Immovable/permanent terrain-like hazard, not something to pull
    // toward or hard-lock onto.
    this.isImmovable = true;
    this.isPermanent = true;
    this.isPullExempt = true;
  }

  // One tile of a Tiled map wrapped round a planet (see
  // CrackedPlanetoid.fromTiledMap): the slice of ring from radius rInner
  // to rOuter, angle a0 to a1, in the planet's own unturned frame. It
  // turns with the planet (planet.rotationAngle). filled: there's more
  // lava right on top of it, so it's lava all the way up — no surface,
  // no embers.
  static newOnRing(planet, rInner, rOuter, a0, a1, filled) {
    const self = Object.create(Lava.prototype);
    self.planet = planet;
    self.rInner = rInner; self.rOuter = rOuter;
    self.a0 = a0; self.a1 = a1;
    self.filled = filled;

    // A whole number of waves round the ring, so the surface meets
    // itself where the angle wraps round.
    self.waveFrequency = Math.max(1, Math.floor(rOuter * WAVE_FREQUENCY + 0.5)) / rOuter;
    self.waveFrequency2 = Math.max(1, Math.floor(rOuter * WAVE_FREQUENCY * 2.3 + 0.5)) / rOuter;

    const arc = (a1 - a0) * rOuter;
    const height = rOuter - rInner;
    self.radius = Math.sqrt(arc * arc + height * height) / 2;
    self.pos = new Vector2(0, 0);
    self.placeOnRing();

    // Obsidian (see harden() / melt()): cool runs 0 (lava) .. 1
    // (obsidian), coolDir is which way it's going (1 hardening, -1
    // melting, 0 neither).
    self.cool = 0; self.coolDir = 0; self.hardened = false;

    self.embers = [];
    self.isImmovable = true;
    self.isPermanent = true;
    self.isPullExempt = true;
    return self;
  }

  // Starts it cooling into obsidian. (WaterSystem.js makes the solid
  // block under it — see "Lava meeting water: obsidian" there — and
  // plays this over it as it forms.)
  harden() {
    this.hardened = true;
    this.coolDir = 1;
  }

  // Starts it heating back up out of obsidian (a fireball's hit the block).
  melt() {
    this.hardened = false;
    this.coolDir = -1;
  }

  // All the way to obsidian: nothing of it left to draw (the block's
  // drawn on its own).
  isObsidian() {
    return this.hardened && this.cool >= 1;
  }

  // A point in the planet's own frame, turned with the planet, in world space.
  ringToWorld(fx, fy) {
    const p = this.planet;
    const a = p.rotationAngle || 0;
    const c = Math.cos(a), s = Math.sin(a);
    return [p.pos.x + fx * c - fy * s, p.pos.y + fx * s + fy * c];
  }

  // Keeps pos (the bounding circle's center) on the tile as the planet turns.
  placeOnRing() {
    const am = (this.a0 + this.a1) / 2;
    const rm = (this.rInner + this.rOuter) / 2;
    [this.pos.x, this.pos.y] = this.ringToWorld(Math.cos(am) * rm, Math.sin(am) * rm);
  }

  // Where its glow sits (see TileGlow.js), and how strong (0..1), as
  // [x, y, heat] — or null for none.
  glowPoint() {
    if (this.planet) {
      if (this.filled || this.isObsidian()) return null;
      const am = (this.a0 + this.a1) / 2;
      const r = this.rOuter - (this.rOuter - this.rInner) * 0.3;
      const [x, y] = this.ringToWorld(Math.cos(am) * r, Math.sin(am) * r);
      return [x, y, 1 - this.cool];
    }
    if (this.isObsidian()) return null;
    return [this.x0 + this.size / 2, this.y0 + this.size * 0.3, 1 - this.cool];
  }

  update() {
    const timeScale = state.timeScale ?? 1;

    if (this.coolDir !== 0) {
      const seconds = this.coolDir > 0 ? HARDEN_SECONDS : MELT_SECONDS;
      this.cool = Math.max(0, Math.min(1, this.cool + this.coolDir * timeScale / 60 / seconds));
      if ((this.coolDir > 0 && this.cool >= 1) || (this.coolDir < 0 && this.cool <= 0)) this.coolDir = 0;
    }
    const heat = (1 - this.cool) ** 2; // (fewer embers as it cools)

    if (this.planet) {
      this.placeOnRing();
      if (!this.filled && Math.random() < EMBER_SPAWN_CHANCE * heat * timeScale) {
        const b = this.a0 + Math.random() * (this.a1 - this.a0);
        const r = this.rOuter - WAVE_BASE_Y;
        const [ex, ey] = this.ringToWorld(Math.cos(b) * r, Math.sin(b) * r);
        const up = b + (this.planet.rotationAngle || 0);
        this.embers.push(newEmber(ex, ey, Math.cos(up), Math.sin(up)));
      }
    } else if (Math.random() < EMBER_SPAWN_CHANCE * heat * timeScale) {
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

  // A ring tile's shape, as triangles in the planet's own frame — made
  // once, then drawn turned with the planet.
  ringMesh() {
    if (this.mesh) return this.mesh;
    const { a0, a1, rInner: rIn, rOuter: rOut } = this;
    const pieces = Math.max(2, Math.ceil((a1 - a0) * rOut / RING_PIECE_LENGTH));
    const vertices = [];
    const add = (r, a) => vertices.push([Math.cos(a) * r, Math.sin(a) * r, 0, 0, 1, 1, 1, 1]);
    for (let k = 0; k < pieces; k++) {
      const b0 = a0 + (a1 - a0) * k / pieces;
      const b1 = a0 + (a1 - a0) * (k + 1) / pieces;
      add(rOut, b0); add(rOut, b1); add(rIn, b1);
      add(rOut, b0); add(rIn, b1); add(rIn, b0);
    }
    this.mesh = love.graphics.newMesh(vertices, 'triangles', 'static');
    return this.mesh;
  }

  draw() {
    if (!this.isObsidian()) this.drawBody();

    for (const e of this.embers) {
      const a = Math.max(0, e.life);
      love.graphics.setColor(1, 0.35 + 0.5 * a, 0.05 + 0.25 * a, a);
      love.graphics.circle('fill', e.x, e.y, e.radius);
    }
    love.graphics.setColor(1, 1, 1, 1);
  }

  drawBody() {
    const shader = getLavaShader();
    const zoom = state.zoom ?? 1;
    const cam = state.camera ?? { x: 0, y: 0 };
    const cool = this.cool ?? 0;

    love.graphics.setShader(shader);
    shader.send('zoom', zoom);
    shader.send('time', sharedTime);
    // (Cooling, the surface settles flat and rises to the tile's top.)
    shader.send('waveAmplitude', WAVE_AMPLITUDE * (1 - cool));
    shader.send('waveSpeed', WAVE_SPEED);
    // (A filled tile's surface is far above it, so it's lava all the way up.)
    shader.send('waveBaseY', this.filled ? -1000 : (WAVE_BASE_Y * (1 - cool) - EDGE_SOFTNESS * 2 * cool));
    shader.send('cool', cool);
    // (Hardening, it fades out at the very end over the baked block;
    // melting, the block's already gone, so it stays solid throughout.)
    let fade = 0;
    if (this.hardened) {
      const t = Math.max(0, Math.min(1, (cool - 0.8) / 0.2));
      fade = t * t * (3 - 2 * t);
    }
    shader.send('overlayAlpha', 1 - fade);
    shader.send('colorObsidian', COLOR_OBSIDIAN);
    shader.send('colorObsidianSheen', COLOR_OBSIDIAN_SHEEN);
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
    if (this.planet) {
      const p = this.planet;
      const angle = p.rotationAngle || 0;
      shader.send('polar', 1);
      shader.send('centerScreen', [(p.pos.x - cam.x) * zoom, (p.pos.y - cam.y) * zoom]);
      shader.send('rotation', angle);
      shader.send('ringOuter', this.rOuter);
      shader.send('waveFrequency', this.waveFrequency);
      shader.send('waveFrequency2', this.waveFrequency2);
      love.graphics.draw(this.ringMesh(), p.pos.x, p.pos.y, angle);
    } else {
      shader.send('polar', 0);
      shader.send('originScreen', [(this.x0 - cam.x) * zoom, (this.y0 - cam.y) * zoom]);
      shader.send('worldX0', this.x0);
      shader.send('worldY0', this.y0);
      shader.send('waveFrequency', WAVE_FREQUENCY);
      shader.send('waveFrequency2', WAVE_FREQUENCY * 2.3);
      love.graphics.rectangle('fill', this.x0, this.y0, this.size, this.size);
    }
    love.graphics.setShader();
  }
}

export default Lava;
