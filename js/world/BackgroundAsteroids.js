// js/world/BackgroundAsteroids.js
//
// Asteroids far off in the background: dark silhouettes against the
// sky, nebulae and distant stars, each with a faint edge of light on
// the side facing the sun — drifting and slowly tumbling. Scenery only:
// nothing collides with them, and nothing's kept about them.
//
// Where each one is is worked out fresh every frame from the time alone
// (see positionAt): it has a starting spot, a drift and a spin, all
// picked from its own number when the game starts (the same every
// time), and at time t it's simply been drifting at that speed for t
// seconds — wrapped round a big repeating patch of sky (PATCH), the way
// the stars are, so they keep going for ever.
//
// Drawn by Starfield.js in screen space, in front of every star, but
// still behind the whole world itself.

import love from '../love/index.js';
import lua from '../love/lua.js';

const BackgroundAsteroids = {};

const COUNT = 300;
// The repeating patch of sky they drift round, screen pixels: big
// enough that only a handful are on screen at once.
const PATCH = 7000; // (at COUNT 300, about 15 to 30 on screen)
// How far off they are: how fast they slide as the view moves (the
// stars' layers go 0.08 to 0.55, and these are in front of them).
const PARALLAX_MIN = 0.6, PARALLAX_MAX = 0.85;
// Their size, screen pixels across (the further, the smaller).
const SIZE_MIN = 10, SIZE_MAX = 52;
// How fast they drift (screen pixels a second) and tumble (radians a second).
const DRIFT_MIN = 3, DRIFT_MAX = 16;
const SPIN_MAX = 0.25;
// How dark against the sky (0 = the sky's own colour, 1 = black), and
// the light on their sunward edge.
const DARKNESS_FAR = 0.2, DARKNESS_NEAR = 0.5; // the furthest are hazy, barely darker than the sky
const RIM_COLOR = [1.0, 0.82, 0.6];
const RIM_ALPHA_FAR = 0.04, RIM_ALPHA_NEAR = 0.16;
const RIM_WIDTH = 0.08; // of its size

// Their shapes: SHAPES lumpy outlines (shared between them all), each
// made once into a small image with a soft, blurred edge — BLUR of its
// radius either side of the outline — so they look hazy and far off.
const SHAPES = 16;
const SHAPE_IMAGE_SIZE = 96;
const BLUR = 0.55;

let rocks = null;
let depthOrder = null;
let shapes = null;
let startTime = null;

// (For the lit edge: a stencil of just the solid middle of a soft
// image — see draw.)
let solidMiddleShader = null;

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// One lumpy outline as a soft image: white, its alpha 1 inside the
// outline fading to 0 across BLUR either side of it.
function makeShape(rng) {
  const n = 10 + Math.floor(rng.random() * 6);
  const radii = [];
  const phase = rng.random() * 10;
  const squash = 0.7 + 0.3 * rng.random();
  for (let k = 0; k < n; k++) {
    const a = k / n * Math.PI * 2;
    // (Lumpy: a couple of slow bulges, and a little roughness.)
    radii[k] = 0.78 + 0.14 * Math.sin(a * 2 + phase) + 0.08 * Math.sin(a * 3 + phase * 2)
      + (rng.random() - 0.5) * 0.12;
  }
  const S = SHAPE_IMAGE_SIZE;
  // (The outline's average radius in the image: room left for the blur.)
  const R = S / 2 / (1 + BLUR) * 0.92;
  const data = love.image.newImageData(S, S);
  data.mapPixel((x, y) => {
    const dx = x + 0.5 - S / 2, dy = (y + 0.5 - S / 2) / squash;
    const a = lua.mod(Math.atan2(dy, dx), Math.PI * 2);
    const f = a / (Math.PI * 2) * n;
    const k = Math.floor(f);
    const t = f - k;
    const edge = R * (radii[k % n] * (1 - t) + radii[(k + 1) % n] * t);
    const d = Math.sqrt(dx * dx + dy * dy);
    const alpha = 1 - smoothstep(edge * (1 - BLUR), edge * (1 + BLUR), d);
    return [1, 1, 1, alpha];
  });
  const image = love.graphics.newImage(data);
  image.setFilter('linear', 'linear');
  // (unit: how much to scale it by to draw it `size` pixels across.)
  return { image, unit: 2 * R };
}

// Each one's shape and its fixed motion, from its own number.
function build() {
  rocks = [];
  const rng = love.math.newRandomGenerator(4242);
  shapes = [];
  for (let k = 0; k < SHAPES; k++) shapes.push(makeShape(rng));
  solidMiddleShader = love.graphics.newShader(`
    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 px) {
      if (Texel(tex, uv).a < 0.6) discard;
      return vec4(1.0);
    }
  `);
  for (let i = 0; i < COUNT; i++) {
    const depth = rng.random(); // 0 far .. 1 near
    const size = SIZE_MIN + (SIZE_MAX - SIZE_MIN) * depth ** 1.5;
    const heading = rng.random() * Math.PI * 2;
    const drift = DRIFT_MIN + (DRIFT_MAX - DRIFT_MIN) * rng.random() * (0.4 + 0.6 * depth);
    rocks.push({
      shape: shapes[Math.floor(rng.random() * SHAPES)],
      size,
      parallax: PARALLAX_MIN + (PARALLAX_MAX - PARALLAX_MIN) * depth,
      x0: rng.random() * PATCH, y0: rng.random() * PATCH,
      vx: Math.cos(heading) * drift, vy: Math.sin(heading) * drift,
      angle0: rng.random() * Math.PI * 2,
      spin: (rng.random() * 2 - 1) * SPIN_MAX,
      darkness: DARKNESS_FAR + (DARKNESS_NEAR - DARKNESS_FAR) * depth,
      rimAlpha: RIM_ALPHA_FAR + (RIM_ALPHA_NEAR - RIM_ALPHA_FAR) * depth,
    });
  }
  // (Furthest first, so nearer ones pass in front of them.)
  depthOrder = rocks.slice().sort((a, b) => a.parallax - b.parallax);
}

// Where a rock is on screen at time t (seconds) with the camera at
// (camX, camY), within one PATCH — and its angle. Returns [x, y, angle].
function positionAt(rock, t, camX, camY) {
  const x = lua.mod(rock.x0 + rock.vx * t - camX * rock.parallax, PATCH);
  const y = lua.mod(rock.y0 + rock.vy * t - camY * rock.parallax, PATCH);
  return [x, y, rock.angle0 + rock.spin * t];
}

// Draws them. camX/camY: the camera's top-left in the world (as the
// stars use it). sunDirX/Y: which way the sun is from the view, on
// screen (for the lit edge) — or null if it's right there.
//
// Each silhouette darkens whatever's behind it (by its `darkness`)
// rather than painting over it in a colour of its own. Its lit edge is
// a copy of it nudged toward the sun, kept to just the sliver outside
// the silhouette (a stencil), so it never shows through it.
BackgroundAsteroids.draw = function (camX, camY, sunDirX, sunDirY) {
  if (!rocks) build();
  startTime = startTime ?? love.timer.getTime();
  const t = love.timer.getTime() - startTime;
  const screenW = love.graphics.getWidth(), screenH = love.graphics.getHeight();

  love.graphics.push('all');
  for (const rock of depthOrder) {
    const [px, py, angle] = positionAt(rock, t, camX, camY);
    const s = rock.size;
    // (Repeated across the window the way the stars are, starting a
    // whole patch back, so one just past the patch's edge still shows
    // partly in at the window's left or top.)
    for (let y = py - PATCH; y < screenH + s; y += PATCH) {
      for (let x = px - PATCH; x < screenW + s; x += PATCH) {
        if (x > -s && y > -s) {
          const cx = x, cy = y;
          const img = rock.shape.image;
          const k = s / rock.shape.unit;
          const ox = img.getWidth() / 2, oy = img.getHeight() / 2;
          if (sunDirX != null) {
            // (The stencil: just its solid middle, not its soft edge.)
            love.graphics.stencil(() => {
              love.graphics.setShader(solidMiddleShader);
              love.graphics.draw(img, cx, cy, angle, k, k, ox, oy);
              love.graphics.setShader();
            }, 'replace', 1);
            love.graphics.setStencilTest('equal', 0);
            love.graphics.setBlendMode('add');
            love.graphics.setColor(RIM_COLOR[0], RIM_COLOR[1], RIM_COLOR[2], rock.rimAlpha);
            love.graphics.draw(img, cx + sunDirX * s * RIM_WIDTH, cy + sunDirY * s * RIM_WIDTH, angle, k, k, ox, oy);
            love.graphics.setBlendMode('alpha');
            love.graphics.setStencilTest();
          }
          love.graphics.setColor(0, 0, 0, rock.darkness);
          love.graphics.draw(img, cx, cy, angle, k, k, ox, oy);
        }
      }
    }
  }
  love.graphics.pop();
};

export default BackgroundAsteroids;
