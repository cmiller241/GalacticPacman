// js/world/SkyRegions.js
//
// What makes one part of space look different from another, behind
// everything (drawn by Starfield.js, in screen space):
//
//   * The sky's own colour (Starfield's gradient) blends by which side
//     of the sun the view is on — REGION_SKIES: blue to the north,
//     violet to the east, teal to the south, dusty brown to the west —
//     warming toward SUN_SKY near the sun and darkening far out.
//
//   * Scenery far off in the distance (SCENERY): a nebula for each
//     region, a spiral galaxy to the north, and — to the west — a dense
//     band of distant stars crossed by dark dust lanes. Each is pinned
//     to a spot in the world (`at`, relative to the sun) and drawn at a
//     slow `parallax`, so different scenery comes into view in each part
//     of the map.
//
// All the art is placeholder, generated once at startup (see the make*
// functions below). To use your own instead, put a PNG named after the
// piece (its `name`, e.g. img/sky/nebula_north.png) in img/sky/ (and in
// the asset list in js/assetList.js): it's used in its place, drawn
// `width` screen pixels wide with ordinary alpha blending.

import love from '../love/index.js';
import state from '../state.js';
import WorldGen from '../setup/WorldGen.js';

const SkyRegions = {};

// The sky's gradient colours ([top, bottom]) in each direction from the
// sun; between them, blended by angle.
const REGION_SKIES = {
  north: [[0.07, 0.12, 0.32], [0.02, 0.04, 0.12]],
  east: [[0.15, 0.07, 0.28], [0.05, 0.02, 0.10]],
  south: [[0.04, 0.16, 0.22], [0.01, 0.05, 0.08]],
  west: [[0.15, 0.10, 0.07], [0.05, 0.03, 0.03]],
};
// Near the sun the sky warms toward this, fully within SUN_SKY_NEAR of
// it, not at all past SUN_SKY_FAR.
const SUN_SKY = [[0.24, 0.13, 0.06], [0.09, 0.04, 0.03]];
const SUN_SKY_NEAR = 9000, SUN_SKY_FAR = 26000;
// Far out, it darkens — by up to FAR_DARKEN, from FAR_START on to FAR_FULL.
const FAR_DARKEN = 0.45, FAR_START = 42000, FAR_FULL = 60000;

// The scenery. at: where it's pinned, relative to the sun (world
// units). parallax: how fast it slides as the view moves — lower is
// further away. width: how wide it's drawn, screen pixels. angle:
// radians. alpha: how strong. layer: "far" (behind every star) or
// "dust" (in front of the far stars, behind the near ones).
const SCENERY = [
  // North: a cold blue-violet nebula, and a spiral galaxy.
  { name: 'nebula_north', kind: 'nebula', at: [6000, -32000], parallax: 0.1, width: 2600, alpha: 0.8,
    colors: [[0.25, 0.35, 0.9], [0.55, 0.3, 0.85], [0.75, 0.85, 1]], seed: 11 },
  { name: 'galaxy', kind: 'galaxy', at: [-14000, -38000], parallax: 0.07, width: 620, alpha: 0.85, angle: 0.5 },
  // East: a magenta-and-rose nebula.
  { name: 'nebula_east', kind: 'nebula', at: [33000, 7000], parallax: 0.1, width: 2800, alpha: 0.5,
    colors: [[0.85, 0.25, 0.6], [1.0, 0.45, 0.35], [1, 0.85, 0.8]], seed: 23 },
  // South: a teal-and-green nebula.
  { name: 'nebula_south', kind: 'nebula', at: [-5000, 33000], parallax: 0.1, width: 2600, alpha: 0.85,
    colors: [[0.15, 0.7, 0.65], [0.3, 0.85, 0.4], [0.8, 1, 0.9]], seed: 37 },
  // West: a warm glow behind a dense band of distant stars, dark dust
  // lanes across them both.
  { name: 'nebula_west', kind: 'nebula', at: [-33000, 4000], parallax: 0.1, width: 3000, alpha: 0.6,
    colors: [[0.85, 0.5, 0.25], [0.7, 0.35, 0.2], [1, 0.9, 0.7]], seed: 41 },
  { name: 'star_band_west', kind: 'starband', at: [-30000, 0], parallax: 0.1, width: 3400, alpha: 0.9, angle: -0.35 },
  // (The first runs right along the star band, splitting it down the
  // middle; the others cross it and the glow at an angle.)
  { name: 'dust_west_1', kind: 'dust', layer: 'dust', at: [-30000, 400], parallax: 0.1, width: 3000, alpha: 1, angle: -0.3, seed: 51 },
  { name: 'dust_west_2', kind: 'dust', layer: 'dust', at: [-34000, 9000], parallax: 0.11, width: 2600, alpha: 0.9, angle: 0.25, seed: 52 },
  { name: 'dust_west_3', kind: 'dust', layer: 'dust', at: [-26000, 6000], parallax: 0.11, width: 2200, alpha: 0.9, angle: 0.7, seed: 53 },
  { name: 'dust_west_4', kind: 'dust', layer: 'dust', at: [-38000, -9000], parallax: 0.11, width: 2400, alpha: 0.85, angle: 0.1, seed: 54 },
];

// ---------------------------------------------------------------------
// Placeholder art, generated once
// ---------------------------------------------------------------------

// A soft round dot (white, fading out to the edge) — what all of it's
// painted with.
let softDot = null;
function getSoftDot() {
  if (softDot) return softDot;
  const size = 64;
  const data = love.image.newImageData(size, size);
  data.mapPixel((x, y) => {
    const dx = (x + 0.5) / size * 2 - 1, dy = (y + 0.5) / size * 2 - 1;
    const d = Math.min(1, dx * dx + dy * dy);
    const a = (1 - d) ** 2;
    return [1, 1, 1, a];
  });
  softDot = love.graphics.newImage(data);
  softDot.setFilter('linear', 'linear');
  return softDot;
}

function dot(x, y, radius, r, g, b, a, sx) {
  const img = getSoftDot();
  love.graphics.setColor(r, g, b, a);
  const s = radius * 2 / img.getWidth();
  love.graphics.draw(img, x, y, 0, s * (sx ?? 1), s, img.getWidth() / 2, img.getHeight() / 2);
}

function gauss(rng) {
  // (Roughly normal, mean 0, spread about 1.)
  return (rng.random() + rng.random() + rng.random() + rng.random() - 2) * 1.2;
}

// A cloud of glowing gas: a few winding chains of soft blobs in its
// colours, bunched toward the middle (so its edges fade to nothing),
// with a few brighter knots. Drawn additively (it's light).
function makeNebula(spec) {
  const size = 512;
  const canvas = love.graphics.newCanvas(size, size);
  const rng = love.math.newRandomGenerator(spec.seed ?? 1);
  const [c1, c2, c3] = spec.colors;
  love.graphics.setCanvas(canvas);
  love.graphics.clear(0, 0, 0, 0);
  love.graphics.setBlendMode('add');
  for (let chain = 0; chain < 4; chain++) {
    let x = size / 2 + gauss(rng) * 50, y = size / 2 + gauss(rng) * 50;
    let heading = rng.random() * Math.PI * 2;
    for (let step = 0; step < 110; step++) {
      heading += (rng.random() - 0.5) * 0.9;
      x += Math.cos(heading) * 9;
      y += Math.sin(heading) * 9;
      // (Pulled back toward the middle, so it stays well inside.)
      x += (size / 2 - x) * 0.04;
      y += (size / 2 - y) * 0.04;
      const fromMiddle = Math.sqrt((x - size / 2) ** 2 + (y - size / 2) ** 2) / (size / 2);
      const fade = Math.max(0, 1 - fromMiddle) ** 1.5;
      const t = rng.random();
      const r = c1[0] + (c2[0] - c1[0]) * t;
      const g = c1[1] + (c2[1] - c1[1]) * t;
      const b = c1[2] + (c2[2] - c1[2]) * t;
      // (Many big faint dabs blend into a smooth cloud; none reaches the
      // canvas's edge, which would show as a straight line.)
      const radius = Math.min(60 + rng.random() * 90, size / 2 * (1 - fromMiddle) - 2);
      if (radius > 4) dot(x, y, radius, r, g, b, (0.025 + rng.random() * 0.035) * fade);
    }
  }
  for (let k = 0; k < 8; k++) {
    const x = size / 2 + gauss(rng) * 50, y = size / 2 + gauss(rng) * 50;
    dot(x, y, 3 + rng.random() * 6, c3[0], c3[1], c3[2], 0.18);
  }
  love.graphics.setBlendMode('alpha');
  love.graphics.setCanvas();
  return { image: canvas, blend: 'add' };
}

// A dense band of distant stars, glowing faintly warm between them.
// Drawn additively.
function makeStarBand() {
  // (Big enough that its stars stay fine points drawn at full size.)
  const w = 2048, h = 768;
  const canvas = love.graphics.newCanvas(w, h);
  const rng = love.math.newRandomGenerator(77);
  love.graphics.setCanvas(canvas);
  love.graphics.clear(0, 0, 0, 0);
  love.graphics.setBlendMode('add');
  // The glow.
  for (let k = 0; k < 90; k++) {
    const x = w / 2 + gauss(rng) * w * 0.15;
    const y = h / 2 + gauss(rng) * h * 0.08;
    dot(x, y, 120 + rng.random() * 140, 1, 0.82, 0.6, 0.03);
  }
  // The stars: thickest along the middle of the band, most of them faint.
  for (let k = 0; k < 7000; k++) {
    const x = w / 2 + gauss(rng) * w * 0.18;
    const y = h / 2 + gauss(rng) * h * 0.1;
    const warm = rng.random();
    love.graphics.setColor(1, 0.85 + 0.15 * warm, 0.75 + 0.25 * warm, 0.15 + rng.random() ** 3 * 0.75);
    love.graphics.points(x, y);
  }
  love.graphics.setBlendMode('alpha');
  love.graphics.setCanvas();
  return { image: canvas, blend: 'add' };
}

// A dark lane of dust: winding filaments of dark blobs, thickest along
// the middle, tapering to nothing at the ends. Drawn over what's behind
// it (hiding it), not as light.
function makeDust(spec) {
  const w = 512, h = 192;
  const canvas = love.graphics.newCanvas(w, h);
  const rng = love.math.newRandomGenerator(spec.seed ?? 1);
  love.graphics.setCanvas(canvas);
  love.graphics.clear(0, 0, 0, 0);
  love.graphics.setBlendMode('alpha');
  for (let strand = 1; strand <= 4; strand++) {
    let y = h / 2 + (strand - 2.5) * 16 + gauss(rng) * 6;
    let x = 20;
    let drift = (rng.random() - 0.5) * 0.6;
    while (x < w - 20) {
      drift += (rng.random() - 0.5) * 0.35;
      drift = Math.max(-0.8, Math.min(0.8, drift));
      y += drift * 6 + (h / 2 - y) * 0.03;
      const along = x / w;
      const taper = Math.sin(along * Math.PI) ** 1.2;
      // (Kept off the canvas's edges, which would show as straight lines.)
      const radius = Math.min((14 + rng.random() * 30) * (0.5 + 0.5 * taper), y - 2, h - y - 2, x - 2, w - x - 2);
      if (radius > 2) dot(x, y, radius, 0.03, 0.02, 0.015, 0.22 * taper);
      x += 5 + rng.random() * 5;
    }
  }
  love.graphics.setCanvas();
  return { image: canvas, blend: 'alpha', premultiplied: true };
}

// A spiral galaxy: a bright core, and two arms of soft light winding out
// from it. Drawn additively.
function makeGalaxy() {
  const size = 256;
  const canvas = love.graphics.newCanvas(size, size);
  const rng = love.math.newRandomGenerator(5);
  const c = size / 2;
  love.graphics.setCanvas(canvas);
  love.graphics.clear(0, 0, 0, 0);
  love.graphics.setBlendMode('add');
  for (let arm = 0; arm <= 1; arm++) {
    for (let i = 1; i <= 260; i++) {
      const t = i / 260;
      const a = arm * Math.PI + t * Math.PI * 3.2;
      const r = 6 + t * 105;
      const x = c + Math.cos(a) * r + gauss(rng) * (3 + t * 9);
      const y = c + Math.sin(a) * r * 0.55 + gauss(rng) * (3 + t * 6);
      dot(x, y, 4 + rng.random() * 8, 0.75, 0.82, 1, 0.16 * (1 - t * 0.6));
    }
  }
  dot(c, c, 34, 1, 0.92, 0.75, 0.6, 1.4);
  dot(c, c, 12, 1, 1, 0.95, 0.9, 1.3);
  love.graphics.setBlendMode('alpha');
  love.graphics.setCanvas();
  return { image: canvas, blend: 'add' };
}

const MAKERS = {
  nebula: makeNebula, starband: makeStarBand, dust: makeDust, galaxy: makeGalaxy,
};

// Each piece's art: a PNG from img/sky/ if there is one, otherwise its
// placeholder.
let art = null;
function getArt() {
  if (art) return art;
  art = new Map();
  love.graphics.push('all');
  love.graphics.origin();
  for (const spec of SCENERY) {
    const path = 'img/sky/' + spec.name + '.png';
    if (love.filesystem.getInfo(path)) {
      const image = love.graphics.newImage(path);
      image.setFilter('linear', 'linear');
      art.set(spec, { image, blend: 'alpha' });
    } else {
      const piece = MAKERS[spec.kind](spec);
      piece.image.setFilter('linear', 'linear');
      art.set(spec, piece);
    }
  }
  love.graphics.pop();
  return art;
}

// ---------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------

// Returns [x, y].
SkyRegions.sunPos = function () {
  if (state.sun && state.sun.pos) return [state.sun.pos.x, state.sun.pos.y];
  return WorldGen.sunPos();
};

function lerp3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// The sky's gradient colours right now, [top, bottom], for the view
// centred at (vx, vy) in the world.
SkyRegions.skyColors = function (vx, vy) {
  const [sx, sy] = SkyRegions.sunPos();
  const dx = vx - sx, dy = vy - sy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  let ux = 0, uy = -1;
  if (dist > 1) { ux = dx / dist; uy = dy / dist; }
  // (Each direction's share: how much the view's that way from the sun.)
  const weights = {
    north: Math.max(0, -uy) ** 2, east: Math.max(0, ux) ** 2,
    south: Math.max(0, uy) ** 2, west: Math.max(0, -ux) ** 2,
  };
  const total = weights.north + weights.east + weights.south + weights.west;
  let top = [0, 0, 0], bottom = [0, 0, 0];
  for (const [region, w] of Object.entries(weights)) {
    const sky = REGION_SKIES[region];
    for (let i = 0; i < 3; i++) {
      top[i] += sky[0][i] * w / total;
      bottom[i] += sky[1][i] * w / total;
    }
  }
  const warm = 1 - smoothstep(SUN_SKY_NEAR, SUN_SKY_FAR, dist);
  top = lerp3(top, SUN_SKY[0], warm);
  bottom = lerp3(bottom, SUN_SKY[1], warm);
  const dim = 1 - FAR_DARKEN * smoothstep(FAR_START, FAR_FULL, dist);
  for (let i = 0; i < 3; i++) { top[i] *= dim; bottom[i] *= dim; }
  return [top, bottom];
};

// Draws the scenery in `layer` ("far" or "dust"), for the view centred
// at (vx, vy) in the world. Screen space.
SkyRegions.draw = function (layer, vx, vy) {
  const pieces = getArt();
  const [sx, sy] = SkyRegions.sunPos();
  const screenW = love.graphics.getWidth(), screenH = love.graphics.getHeight();
  love.graphics.push('all');
  for (const spec of SCENERY) {
    if ((spec.layer ?? 'far') === layer) {
      const piece = pieces.get(spec);
      const img = piece.image;
      const scale = spec.width / img.getWidth();
      const halfDiag = Math.sqrt(img.getWidth() ** 2 + img.getHeight() ** 2) * scale / 2;
      const x = screenW / 2 + (sx + spec.at[0] - vx) * spec.parallax;
      const y = screenH / 2 + (sy + spec.at[1] - vy) * spec.parallax;
      if (x > -halfDiag && x < screenW + halfDiag && y > -halfDiag && y < screenH + halfDiag) {
        if (piece.blend === 'add') {
          // (Its light was already weighted by each dab's own strength as
          // it was painted — so it's added as it is, not dimmed again by
          // the canvas's leftover alpha.)
          love.graphics.setBlendMode('add', 'premultiplied');
          love.graphics.setColor(spec.alpha, spec.alpha, spec.alpha, 1);
        } else if (piece.premultiplied) {
          love.graphics.setBlendMode('alpha', 'premultiplied');
          love.graphics.setColor(spec.alpha, spec.alpha, spec.alpha, spec.alpha);
        } else {
          love.graphics.setBlendMode('alpha');
          love.graphics.setColor(1, 1, 1, spec.alpha);
        }
        love.graphics.draw(img, x, y, spec.angle ?? 0, scale, scale, img.getWidth() / 2, img.getHeight() / 2);
      }
    }
  }
  love.graphics.pop();
};

export default SkyRegions;
