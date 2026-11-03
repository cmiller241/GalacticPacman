// js/effects/GrassBlades.js
//
// Little tufts of grass blades poking up out of grassy ground, swaying
// gently. Purely decoration: built once when the level is loaded (see
// js/levels/DomeInterior.js and js/levels/SkyDome.js) and drawn just
// after the ground they grow out of (see drawFrame in main.js), so they
// sit in front of the grass art and behind Bob. Port of
// lua/effects/GrassBlades.lua.
//
// Where they go: along every floor-facing stretch of walkable ground (not
// walls or ceilings), every TUFT_SPACING units there's a TUFT_CHANCE of a
// tuft — but only where the tile art right under that spot is actually
// grass (green), so stone, obsidian and the like stay bare. Each tuft
// takes its colour from that grass. Placement comes from its own random
// generator, seeded from the level, so the tufts are in the same places
// every time (and the game's own random numbers aren't touched).

import love from '../love/index.js';
import utils from '../utils.js';

const GrassBlades = {};

// Placement.
const TUFT_SPACING = 14;        // world units between chances of a tuft along the ground
const TUFT_CHANCE = 0.19;       // the chance at each
const BLADES_MIN = 2, BLADES_MAX = 5;
const TUFT_SPREAD = 9;          // blades sit up to this far either side of the tuft's middle
const MAX_SLOPE_UP = 0.6;       // ground counts as floor if its normal points at least this much up (~53 degrees)
// Blade shape.
const HEIGHT_MIN = 9, HEIGHT_MAX = 24;
const WIDTH_MIN = 2.6, WIDTH_MAX = 4.4;
const LEAN_MAX = 0.35;          // radians a blade leans either way at rest
const CURL = 0.45;              // how much more the tip leans than the middle (a gentle curve)
const ROOT_DEPTH = 3;           // how far below the ground line a blade starts (so it grows out of it)
const PIXEL = 2;                // world units per grass pixel: the tile art's own (32-px tiles drawn 64 wide)
// In front: this share of tufts draws after Bob and the Ooombas (see
// GrassBlades.draw's `front`), a bit shorter so they hide less of him.
const FRONT_CHANCE = 0.3;
const FRONT_HEIGHT_SCALE = 0.75;
const EDGE_SHADE = 0.9;         // a blade's right-hand pixel, where it's 3+ pixels wide
// Sway.
const SWAY_AMOUNT = 0.16;       // radians
const SWAY_SPEED = 1.7;         // radians of sway phase per second
// Colour: the grass under the tuft, a touch lighter, tips lighter still
// (no outline, so they blend into the grass they grow from).
const TIP_TINT = [0.85, 0.95, 0.35];

const TILE_WORLD = 64;
const TILE_SOURCE = 32;
const FLIP_H = 2 ** 31, FLIP_V = 2 ** 30;

function findTileset(tilesets, gid) {
  let best = null;
  for (const ts of tilesets) {
    if (ts.firstgid <= gid && (!best || ts.firstgid > best.firstgid)) best = ts;
  }
  return best;
}

// The colour of the level's art at world (x, y): the front-most tile
// layer with something opaque there. -> [r, g, b] or null
function artColorAt(level, sheet, x, y) {
  const col = Math.floor((x - level.anchorX) / TILE_WORLD);
  const row = Math.floor((y - level.anchorY) / TILE_WORLD);
  if (col < 0 || row < 0 || col >= level.mapWidth || row >= level.mapHeight) return null;
  const u = Math.floor((x - level.anchorX - col * TILE_WORLD) / TILE_WORLD * TILE_SOURCE);
  const v = Math.floor((y - level.anchorY - row * TILE_WORLD) / TILE_WORLD * TILE_SOURCE);
  const [sw, sh] = sheet.getDimensions();
  for (let li = level.tileLayers.length - 1; li >= 0; li--) {
    const raw = level.tileLayers[li].data[row * level.mapWidth + col] ?? 0;
    const gid = raw % 2 ** 29;
    if (gid === 0) continue;
    const ts = findTileset(level.tilesets, gid);
    if (!ts) continue;
    const index = gid - ts.firstgid;
    const columns = ts.columns ?? 9;
    const tu = (Math.floor(raw / FLIP_H) % 2 === 1) ? (TILE_SOURCE - 1 - u) : u;
    const tv = (Math.floor(raw / FLIP_V) % 2 === 1) ? (TILE_SOURCE - 1 - v) : v;
    const sx = (index % columns) * TILE_SOURCE + tu;
    const sy = Math.floor(index / columns) * TILE_SOURCE + tv;
    if (sx >= 0 && sy >= 0 && sx < sw && sy < sh) {
      const [r, g, b, a] = sheet.getPixel(sx, sy);
      if (a > 0.5) return [r, g, b];
    }
  }
  return null;
}

const isGrass = (c) => c != null && c[1] > 0.3 && c[1] > c[0] * 1.1 && c[1] > c[2] * 1.3;

// One tuft at (px, py) on ground with normal (nx, ny) pointing up out of
// it and tangent (tx, ty), in grass colour [r, g, b].
function makeTuft(rng, px, py, nx, ny, tx, ty, [r, g, b]) {
  const front = rng.random() < FRONT_CHANCE;
  const tuft = { x: px, y: py, nx, ny, tx, ty, front, blades: [] };
  const heightScale = front ? FRONT_HEIGHT_SCALE : 1;
  const count = rng.random(BLADES_MIN, BLADES_MAX);
  for (let k = 0; k < count; k++) {
    const shade = 0.98 + rng.random() * 0.14;
    const tipMix = 0.3 + rng.random() * 0.3;
    const base = [Math.min(1, r * shade), Math.min(1, g * shade), Math.min(1, b * shade)];
    const tip = [r + (TIP_TINT[0] - r) * tipMix, g + (TIP_TINT[1] - g) * tipMix, b + (TIP_TINT[2] - b) * tipMix];
    tuft.blades.push({
      offset: (rng.random() * 2 - 1) * TUFT_SPREAD,
      height: (HEIGHT_MIN + rng.random() * (HEIGHT_MAX - HEIGHT_MIN)) * heightScale,
      width: WIDTH_MIN + rng.random() * (WIDTH_MAX - WIDTH_MIN),
      lean: (rng.random() * 2 - 1) * LEAN_MAX,
      phase: rng.random() * Math.PI * 2,
      // Three bands of colour up the blade, pixel-art style.
      colors: [base, [(base[0] + tip[0]) / 2, (base[1] + tip[1]) / 2, (base[2] + tip[2]) / 2], tip],
    });
  }
  return tuft;
}

// The average colour of an image's grass-green pixels (for ground drawn
// from one grass texture, like the sky dome's deck).
function averageGrass(path) {
  const img = love.image.newImageData(path);
  const [w, h] = img.getDimensions();
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = img.getPixel(x, y);
      if (a > 0.5 && isGrass([r, g, b])) { sr += r; sg += g; sb += b; n++; }
    }
  }
  return n === 0 ? [0.45, 0.7, 0.2] : [sr / n, sg / n, sb / n];
}

// Tufts along a flat stretch of ground from x0 to x1 at height y, in the
// grass colour of the texture at grassPath (the sky dome's deck: see
// SkyDomePlanetoid's grass cap). seed: anything, to vary the placement.
GrassBlades.buildStrip = function (x0, x1, y, grassPath, seed) {
  const color = averageGrass(grassPath);
  const rng = love.math.newRandomGenerator(Math.floor(seed) + 101);
  const tufts = [];
  for (let x = x0 + TUFT_SPACING * 0.5; x <= x1 - TUFT_SPACING * 0.5; x += TUFT_SPACING) {
    if (rng.random() < TUFT_CHANCE) tufts.push(makeTuft(rng, x, y, 0, -1, 1, 0, color));
  }
  return tufts;
};

// The tufts for a level loaded by TiledTerrain.load. sheetPath: its
// tileset image (all of Level1's tilesets share img/platform.png).
GrassBlades.build = function (level, sheetPath) {
  const sheet = love.image.newImageData(sheetPath);
  const rng = love.math.newRandomGenerator(Math.floor(level.anchorX) * 7919 + Math.floor(level.anchorY) + 17);
  const tufts = [];
  for (const shape of level.shapes ?? []) {
    for (const seg of shape.segments ?? []) {
      const n = seg.normal;
      if (!n || n.y > -MAX_SLOPE_UP) continue;
      const ax = seg.a.x, ay = seg.a.y, bx = seg.b.x, by = seg.b.y;
      const len = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
      if (len <= 1) continue;
      const tx = (bx - ax) / len, ty = (by - ay) / len;
      for (let d = TUFT_SPACING * 0.5; d <= len; d += TUFT_SPACING) {
        if (rng.random() >= TUFT_CHANCE) continue;
        const px = ax + tx * d, py = ay + ty * d;
        // The art just inside the ground there.
        const color = artColorAt(level, sheet, px - n.x * 5, py - n.y * 5);
        if (isGrass(color)) tufts.push(makeTuft(rng, px, py, n.x, n.y, tx, ty, color));
      }
    }
  }
  return tufts;
};

// The blade outline being drawn (reused, so drawing allocates nothing).
const polyX = [0, 0, 0, 0, 0], polyY = [0, 0, 0, 0, 0];

// Where the row y = yc crosses the blade outline: [leftmost, rightmost] x.
// (Written into spanOut.)
const spanOut = [0, 0];
function spanAt(yc) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 5; i++) {
    const j = (i + 1) % 5;
    const y1 = polyY[i], y2 = polyY[j];
    if ((y1 <= yc && y2 > yc) || (y2 <= yc && y1 > yc)) {
      const x = polyX[i] + (yc - y1) / (y2 - y1) * (polyX[j] - polyX[i]);
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
  }
  spanOut[0] = lo; spanOut[1] = hi;
}

// Fills the blade outline in polyX/polyY as square PIXEL-sized cells on
// the world grid, row by row: so it looks drawn in the same chunky
// pixels as the tile art rather than as smooth shapes (and steps from
// pixel to pixel as it sways). Root (bx, by), up the blade (dx, dy),
// length h.
function fillPixels(g, colors, bx, by, dx, dy, h) {
  let ymin = Infinity, ymax = -Infinity;
  for (let i = 0; i < 5; i++) {
    if (polyY[i] < ymin) ymin = polyY[i];
    if (polyY[i] > ymax) ymax = polyY[i];
  }
  for (let row = Math.floor(ymin / PIXEL); row <= Math.floor(ymax / PIXEL); row++) {
    const yc = (row + 0.5) * PIXEL;
    spanAt(yc);
    const lo = spanOut[0], hi = spanOut[1];
    if (lo > hi) continue;
    const c0 = Math.floor(lo / PIXEL), c1 = Math.floor(hi / PIXEL);
    // How far up the blade this row is: picks its colour band.
    const f = (((lo + hi) * 0.5 - bx) * dx + (yc - by) * dy) / h;
    const c = colors[f < 0.45 ? 0 : (f < 0.75 ? 1 : 2)];
    g.setColor(c[0], c[1], c[2], 1);
    if (c1 - c0 >= 2) {
      g.rectangle('fill', c0 * PIXEL, row * PIXEL, (c1 - c0) * PIXEL, PIXEL);
      g.setColor(c[0] * EDGE_SHADE, c[1] * EDGE_SHADE, c[2] * EDGE_SHADE, 1);
      g.rectangle('fill', c1 * PIXEL, row * PIXEL, PIXEL, PIXEL);
    } else {
      g.rectangle('fill', c0 * PIXEL, row * PIXEL, (c1 - c0 + 1) * PIXEL, PIXEL);
    }
  }
}

// Draws a list of tufts (a level's or the dome deck's grassBlades), the
// ones on screen. front: false/undefined draws the ones behind the
// characters (call in world space right after the ground they grow out
// of); true draws the ones in front (call after Bob and the Ooombas).
GrassBlades.draw = function (tufts, front = false) {
  if (!tufts) return;
  const g = love.graphics;
  const t = love.timer.getTime();
  for (const tuft of tufts) {
    if (tuft.front !== front) continue;
    if (!utils.isOnScreen(tuft.x, tuft.y, HEIGHT_MAX + TUFT_SPREAD, 10)) continue;
    const ux = tuft.nx, uy = tuft.ny; // (the ground's normal points up out of it: a blade's "up")
    for (const blade of tuft.blades) {
      const sway = Math.sin(t * SWAY_SPEED + blade.phase + tuft.x * 0.013) * SWAY_AMOUNT;
      const a1 = blade.lean + sway;
      const a2 = a1 * (1 + CURL) + sway * 0.5;
      // Directions: "up" (the normal) turned by a1 (middle) and a2 (tip).
      const c1 = Math.cos(a1), s1 = Math.sin(a1);
      const c2 = Math.cos(a2), s2 = Math.sin(a2);
      const d1x = ux * c1 - uy * s1, d1y = ux * s1 + uy * c1;
      const d2x = ux * c2 - uy * s2, d2y = ux * s2 + uy * c2;
      // Root, just below the ground line.
      const bx = tuft.x + tuft.tx * blade.offset - ux * ROOT_DEPTH;
      const by = tuft.y + tuft.ty * blade.offset - uy * ROOT_DEPTH;
      const h = blade.height + ROOT_DEPTH, w = blade.width * 0.5;
      const mx = bx + d1x * h * 0.55, my = by + d1y * h * 0.55;
      const ex = mx + d2x * h * 0.45, ey = my + d2y * h * 0.45;
      const px = -d1y, py = d1x; // (across the blade)
      const mw = w * 0.6;
      polyX[0] = bx - px * w; polyY[0] = by - py * w;
      polyX[1] = mx - px * mw; polyY[1] = my - py * mw;
      polyX[2] = ex; polyY[2] = ey;
      polyX[3] = mx + px * mw; polyY[3] = my + py * mw;
      polyX[4] = bx + px * w; polyY[4] = by + py * w;
      fillPixels(g, blade.colors, bx, by, d1x, d1y, h);
    }
  }
  g.setColor(1, 1, 1, 1);
};

export default GrassBlades;
