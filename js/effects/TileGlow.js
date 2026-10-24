// js/effects/TileGlow.js
//
// Things that glow lighting up the Tiled level's tiles near them —
// fireballs, explosions, lava, portals, and the blaster's muzzle flash —
// only on tiles, never on the open background where there are none (the
// same masking as Bob's and the Ooombas' shadows, see CharacterShadows.js).
//
// Each frame (see main.js, which calls these where the level is drawn):
//   * TileGlow.prepare: a soft round glow for each light, in its color,
//     added up into a screen-sized canvas (black where there's none).
//   * TileGlow.drawOnto(level): the level's own baked canvas drawn over
//     itself, additively, through a shader that adds that light at each
//     of its pixels times how much tile is there — so open background,
//     where it's clear, stays dark.
// Drawn after the level (and the characters' shadows on it), before the
// characters themselves, so they aren't washed out by it.

import love from '../love/index.js';
import state from '../state.js';

const TileGlow = {};

// ---------------------------------------------------------------------
// Tunables — each light's color, reach (world units) and brightness
// ---------------------------------------------------------------------

const FIREBALL = { color: [1.00, 0.55, 0.18], radius: 190, intensity: 0.25, flicker: 0.18 };
const EXPLOSION = { color: [1.00, 0.62, 0.25], radius: 340, intensity: 0.4 }; // fading out over its life
const LAVA = { color: [1.00, 0.40, 0.10], radius: 150, intensity: 0.16, pulse: 0.25 }; // per lava tile (they add up)
const PORTAL = { radius: 210, intensity: 0.35 }; // in each portal's own glow color
const ROPE_FLAME = { color: [1.00, 0.55, 0.15], radius: 120, intensity: 0.3, flicker: 0.25 }; // each front of a burning rope (see RopeRock.js)
const PORTAL_COLORS = { red: [1.00, 0.45, 0.25], blue: [0.35, 0.70, 1.00] };
const MUZZLE_FLASH = { color: [1.00, 0.75, 0.40], radius: 150, intensity: 0.28, seconds: 0.1 };

// ---------------------------------------------------------------------

let lights = null; // the screen-sized canvas the glows are added up in
let anyLight = false;

// A soft round glow: bright in the middle, fading smoothly to nothing at
// its edge (made once, drawn scaled to each light's reach).
const GLOW_SIZE = 128;
let glowImage = null;
function getGlowImage() {
  if (glowImage) return glowImage;
  const data = love.image.newImageData(GLOW_SIZE, GLOW_SIZE);
  const half = GLOW_SIZE / 2;
  data.mapPixel((x, y) => {
    const d = Math.sqrt((x + 0.5 - half) ** 2 + (y + 0.5 - half) ** 2) / half;
    let v = Math.max(0, 1 - d);
    v = v * v * (3 - 2 * v); // smoothstep, so there's no visible rim
    return [1, 1, 1, v];
  });
  glowImage = love.graphics.newImage(data);
  glowImage.setFilter('linear', 'linear');
  return glowImage;
}

let shader = null;
function getShader() {
  if (shader) return shader;
  shader = love.graphics.newShader(`
    extern Image lights;     // the glows, screen-sized
    extern vec2 lightsSize;  // its size, in pixels
    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      float tile = Texel(tex, uv).a;  // how much tile is here
      vec3 light = Texel(lights, screen / lightsSize).rgb;
      return vec4(light, tile);       // (added on, scaled by the tile)
    }
  `);
  return shader;
}

// Gathers this frame's lights and draws their glows. Call in world space
// (inside the camera transform), before drawOnto.
TileGlow.prepare = function () {
  anyLight = false;
  const list = [];
  const add = (x, y, color, radius, intensity) => {
    if (intensity > 0.01) list.push({ x, y, color, radius, intensity });
  };
  const now = love.timer.getTime();

  for (const f of state.fireballs ?? []) {
    const flicker = 1 + FIREBALL.flicker * Math.sin(now * 23 + (f.flickerPhase ?? 0));
    add(f.pos.x, f.pos.y, FIREBALL.color, FIREBALL.radius, FIREBALL.intensity * flicker);
  }
  for (const e of state.explosions ?? []) {
    if (e.startTime != null && e.duration != null) {
      const t = Math.min(1, (now - e.startTime) / e.duration);
      add(e.pos.x, e.pos.y, EXPLOSION.color, EXPLOSION.radius, EXPLOSION.intensity * (1 - t) * (1 - t));
    }
  }
  for (const lava of state.lavas ?? []) {
    if (lava.x0 != null && lava.size != null) {
      const pulse = 1 + LAVA.pulse * Math.sin(now * 1.7 + lava.x0 * 0.01);
      add(lava.x0 + lava.size / 2, lava.y0 + lava.size * 0.3, LAVA.color, LAVA.radius, LAVA.intensity * pulse);
    }
  }
  for (const [color, p] of Object.entries(state.portals ?? {})) {
    const c = PORTAL_COLORS[color];
    if (c && p && p.x != null) {
      // (Just out in front of its opening.)
      add(p.x + (p.nx ?? 0) * 24, p.y + (p.ny ?? 0) * 24, c, PORTAL.radius, PORTAL.intensity);
    }
  }
  for (const rr of state.ropeRocks ?? []) {
    // A burning rope's flames (see RopeRock.js).
    const [up, down] = rr.flameFronts();
    const fronts = [up ?? false, down ?? false];
    for (let i = 0; i < fronts.length; i++) {
      const t = fronts[i];
      if (t !== false && t !== null) {
        const [x, y] = rr.flamePoint(t);
        const flicker = 1 + ROPE_FLAME.flicker * Math.sin(now * 29 + (i + 1) * 2.3);
        add(x, y, ROPE_FLAME.color, ROPE_FLAME.radius, ROPE_FLAME.intensity * flicker);
      }
    }
  }
  const player = state.player;
  if (player && player.lastShotTime != null && player.getMuzzlePosition) {
    const since = now - player.lastShotTime;
    if (since >= 0 && since < MUZZLE_FLASH.seconds) {
      const [mx, my] = player.getMuzzlePosition();
      add(mx, my, MUZZLE_FLASH.color, MUZZLE_FLASH.radius, MUZZLE_FLASH.intensity * (1 - since / MUZZLE_FLASH.seconds));
    }
  }

  if (list.length === 0) return;

  // (The size of whatever's being drawn to: the screen, or a canvas.)
  const target = love.graphics.getCanvas();
  let w, h;
  if (target) [w, h] = target.getDimensions(); else [w, h] = love.graphics.getDimensions();
  if (!lights || lights.getWidth() !== w || lights.getHeight() !== h) {
    if (lights) lights.release();
    lights = love.graphics.newCanvas(w, h);
  }

  const img = getGlowImage();
  love.graphics.push('all');
  love.graphics.setCanvas(lights);
  love.graphics.clear(0, 0, 0, 1);
  love.graphics.setBlendMode('add');
  for (const l of list) {
    const s = l.radius * 2 / GLOW_SIZE;
    love.graphics.setColor(l.color[0] * l.intensity, l.color[1] * l.intensity, l.color[2] * l.intensity, 1);
    love.graphics.draw(img, l.x, l.y, 0, s, s, GLOW_SIZE / 2, GLOW_SIZE / 2);
  }
  love.graphics.pop();
  anyLight = true;
};

// The glow on `level`'s tiles. Call right after drawing the level (and
// its shadows).
TileGlow.drawOnto = function (level) {
  if (!(anyLight && lights && level.canvas)) return;
  const s = getShader();
  const [pw, ph] = lights.getPixelDimensions();
  s.send('lights', lights);
  s.send('lightsSize', [pw, ph]);
  love.graphics.push('all');
  love.graphics.setShader(s);
  love.graphics.setBlendMode('add');
  love.graphics.setColor(1, 1, 1, 1);
  love.graphics.draw(level.canvas, level.anchorX, level.anchorY);
  love.graphics.pop();
};

export default TileGlow;
