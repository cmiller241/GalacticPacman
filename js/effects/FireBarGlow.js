// js/effects/FireBarGlow.js
//
// The fire bars' fireballs lighting up the round planets near them — the
// planet version of TileGlow.js (which does the same for the Tiled
// level's tiles). Planets are balls, not flat tiles, so this lights each
// as one: brightest on the side facing the fireball, fading round toward
// the far side, and falling off with distance.
//
// Each frame (see main.js, which calls these where the planets are drawn):
//   * FireBarGlow.prepare: gathers every on-screen fire bar's fireballs.
//   * FireBarGlow.drawOnto(planet): right after drawing a planet, adds
//     the light of the fireballs within reach over it, through a shader
//     that works out, at each of its pixels, the point of the sphere
//     there and how much each fireball lights it.

import love from '../love/index.js';
import lua from '../love/lua.js';
import state from '../state.js';
import utils from '../utils.js';
import Planetoid from '../world/Planetoid.js';

const FireBarGlow = {};

// ---------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------

const COLOR = [1.00, 0.50, 0.15];
const REACH = 200;          // world units a fireball's light reaches
const INTENSITY = 0.4;      // one fireball's brightness, close up (they add up...)
const MAX_BRIGHTNESS = 0.65; // (...but ease off toward this, so a whole bar can't wash a planet out)
const AMBIENT = 0.12;       // how much light reaches the side turned away (0..1)
const FLICKER = 0.15;
const LIGHT_DEPTH = 1.0;    // how far out in front of a planet the fireballs are, in its radii
const MAX_LIGHTS = 32;      // fireballs per planet, at most (must match the shader)

// ---------------------------------------------------------------------

let lights = []; // this frame's fireballs: [x, y, intensity]

let shader = null;
function getShader() {
  if (shader) return shader;
  shader = love.graphics.newShader(`
    #define MAX_LIGHTS ${MAX_LIGHTS}
    #define LIGHT_DEPTH ${lua.format('%.2f', LIGHT_DEPTH)}

    extern vec3 lights[MAX_LIGHTS];  // x, y from the planet's centre (world units), intensity
    extern int count;
    extern number radius;
    extern number reach;
    extern number ambient;
    extern number maxBrightness;
    extern vec3 tint;

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec2 p = uv * 2.0 - 1.0;
      float r2 = dot(p, p);
      if (r2 > 1.0) return vec4(0.0);
      float edge = 1.0 - smoothstep(0.97, 1.0, sqrt(r2));  // (antialiased)

      // The sphere's surface here, and which way it faces. The fireballs
      // swing past in front of the planets (they're drawn over them), so
      // they're out toward the viewer, level with its front face.
      vec3 n = vec3(p, sqrt(1.0 - r2));
      vec3 surface = n * radius;

      float total = 0.0;
      for (int i = 0; i < MAX_LIGHTS; i++) {
        if (i >= count) break;
        vec3 toLight = vec3(lights[i].xy, radius * LIGHT_DEPTH) - surface;
        float d = length(toLight);
        float fall = clamp(1.0 - d / reach, 0.0, 1.0);
        fall *= fall;
        float facing = max(dot(n, toLight / max(d, 0.001)), 0.0);
        total += lights[i].z * fall * (ambient + (1.0 - ambient) * facing);
      }
      float light = maxBrightness * (1.0 - exp(-total / maxBrightness));
      return vec4(tint * light, edge);
    }
  `);
  return shader;
}

// A 1x1 white pixel: the quad the shader is drawn on, scaled to the planet.
let pixelImage = null;
function getPixel() {
  if (pixelImage) return pixelImage;
  const data = love.image.newImageData(1, 1);
  data.setPixel(0, 0, 1, 1, 1, 1);
  pixelImage = love.graphics.newImage(data);
  return pixelImage;
}

// Gathers this frame's fireballs. Call once per frame, before drawOnto.
FireBarGlow.prepare = function () {
  lights = [];
  const now = love.timer.getTime();
  for (const bar of state.fireBars ?? []) {
    if (utils.isOnScreen(bar.pos.x, bar.pos.y, bar.barLength + REACH, 50)) {
      const positions = bar.getFireballPositions();
      for (let i = 0; i < positions.length; i++) {
        const f = positions[i];
        // (i + 1: the flicker phase matches the 1-based Lua original)
        const flicker = 1 + FLICKER * Math.sin(now * 23 + (i + 1) * 1.7);
        lights.push([f.x, f.y, INTENSITY * flicker]);
      }
    }
  }
};

// The fireballs' light on `planet`. Call right after drawing it. Only
// round planets (anything built on Planetoid.new) — the sky dome, rounded
// rect and Tiled shapes aren't balls.
FireBarGlow.drawOnto = function (planet) {
  if (lights.length === 0 || planet.constructor !== Planetoid) return;
  const px = planet.pos.x, py = planet.pos.y, radius = planet.radius;
  const reachSq = (radius + REACH) * (radius + REACH);
  const near = [];
  for (const l of lights) {
    const dx = l[0] - px, dy = l[1] - py;
    if (dx * dx + dy * dy < reachSq && near.length < MAX_LIGHTS) {
      near.push([dx, dy, l[2]]);
    }
  }
  if (near.length === 0) return;

  const s = getShader();
  s.send('lights', ...near);
  s.send('count', near.length);
  s.send('radius', radius);
  s.send('reach', REACH);
  s.send('ambient', AMBIENT);
  s.send('maxBrightness', MAX_BRIGHTNESS);
  s.send('tint', COLOR);
  love.graphics.push('all');
  love.graphics.setShader(s);
  love.graphics.setBlendMode('add');
  love.graphics.setColor(1, 1, 1, 1);
  love.graphics.draw(getPixel(), px - radius, py - radius, 0, radius * 2, radius * 2);
  love.graphics.pop();
};

export default FireBarGlow;
