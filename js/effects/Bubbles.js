// js/effects/Bubbles.js
//
// Shared air-bubble trails for anything underwater (Player.js, Fish.js).
// A bubble rises along a radial line away from its water body's center,
// so it heads for the surface on any side of a round water planet, and
// straight up in a pool (see WaterSystem.js's poolWater). On the way it
// sways and jiggles side to side, squashes a little, and swells as the
// pressure drops; at the surface it domes up, then pops with a ripple
// and a couple of flecks.
//
// The look (a lit rim on the side facing the surface, a shaded rim
// opposite, a see-through body, a highlight and a fleck of refracted
// light, a soft glow, tiny ones drawn as glinting beads, and the
// dome-then-ripple pop) is adapted from pixelfx's water/bubbles effect
// (https://github.com/patch-gg/pixelfx), MIT License, Copyright (c) 2026
// Patch, itself adapted from Sprite Fusion's open-source bubbles, MIT
// License, Copyright (c) 2026 Hugo Duprez.

import love from '../love/index.js';

const Bubbles = {};

// Motion. Frequencies are radians per baseline (60fps) frame.
const SWAY_FREQ_MIN = 0.01, SWAY_FREQ_MAX = 0.03;     // slow side-to-side drift
const SWAY_DISTANCE = 7;                              // world units at full swing, once fully risen
const WIGGLE_FREQ_MIN = 0.05, WIGGLE_FREQ_MAX = 0.10; // quicker jiggle, which also drives the squash
const WIGGLE_PER_RADIUS = 0.45;                       // jiggle distance, as a multiple of the bubble's radius
const SWELL = 0.45;                                   // 0.45 = 45% bigger by the time it reaches the surface
const SQUASH = 0.12;                                  // how far out of round the jiggle stretches it
const SMALL_SHARE = 0.7;                              // share of bubbles in the small half of the size range

// The pop, in baseline frames.
const POP_DOME_TICKS = 7;   // domes up through the surface (skipped by small bubbles)
const POP_RIPPLE_TICKS = 12; // then a ripple spreads along the surface
const POP_DOME_MIN = 1.4;   // radius below which a bubble skips the dome and flecks

// Below this radius a bubble is a glinting bead, not a rimmed sphere.
const SMALL_RADIUS = 2;

// Darkest to lightest: the water planet's blues up to foam white.
const SHADE = [0.22, 0.48, 0.72];
const RIM = [0.48, 0.78, 0.94];
const BODY = [0.72, 0.91, 1.00];
const LIT = [0.88, 0.98, 1.00];
const WHITE = [1, 1, 1];

// Where the light comes from, in a bubble's own frame (+x points at the
// surface): a little off-center, like pixelfx's top-left light.
const LIGHT_ANGLE = -0.55;
const LX = Math.cos(LIGHT_ANGLE), LY = Math.sin(LIGHT_ANGLE);

function setColor(c, a) {
  love.graphics.setColor(c[0], c[1], c[2], a);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// 0 at the spawn point, 1 at the surface.
function progress(b) {
  const span = b.targetR - b.startR;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (b.r - b.startR) / span));
}

// Adds a bubble to `list`, rising from startR to targetR (distances from
// the water's center at cx, cy) along `angle`. cfg holds radiusMin/Max
// (world units, before swelling) and riseMin/Max (world units per
// baseline frame). Bigger bubbles rise faster, as they do in pixelfx.
Bubbles.spawn = function (list, cx, cy, angle, startR, targetR, cfg) {
  if (startR >= targetR) return;
  const sizeT = Math.random() < SMALL_SHARE ? Math.random() * 0.5 : 0.5 + Math.random() * 0.5;
  const riseT = 0.65 * sizeT + 0.35 * Math.random();
  list.push({
    centerX: cx,
    centerY: cy,
    angle,
    startR,
    r: startR,
    targetR,
    radius: lerp(cfg.radiusMin, cfg.radiusMax, sizeT),
    riseSpeed: lerp(cfg.riseMin, cfg.riseMax, riseT),
    swayPhase: Math.random() * Math.PI * 2,
    swayFreq: lerp(SWAY_FREQ_MIN, SWAY_FREQ_MAX, Math.random()),
    wigglePhase: Math.random() * Math.PI * 2,
    wiggleFreq: lerp(WIGGLE_FREQ_MIN, WIGGLE_FREQ_MAX, Math.random()),
    popAge: null, // set once it reaches the surface
  });
};

Bubbles.update = function (list, ts) {
  for (let i = list.length - 1; i >= 0; i--) {
    const b = list[i];
    if (b.popAge !== null) {
      b.popAge += ts;
      if (b.popAge >= b.popTicks) list.splice(i, 1);
    } else {
      b.r += b.riseSpeed * ts;
      b.swayPhase += b.swayFreq * ts;
      b.wigglePhase += b.wiggleFreq * ts;
      if (b.r >= b.targetR) {
        // Frozen where it broke the surface (the phases stop advancing).
        b.r = b.targetR;
        b.popAge = 0;
        b.popRadius = b.radius * (1 + SWELL);
        b.popTicks = (b.popRadius >= POP_DOME_MIN ? POP_DOME_TICKS : 0) + POP_RIPPLE_TICKS;
      }
    }
  }
};

// World position: out along the radial line, pushed sideways by the sway
// and jiggle. Sideways is in world units (not an angle) so it stays the
// same size in a pool, whose "center" is far below.
function position(b, k) {
  const ox = Math.cos(b.angle), oy = Math.sin(b.angle);
  const side = Math.sin(b.swayPhase) * SWAY_DISTANCE * (0.35 + 0.65 * k)
    + Math.sin(b.wigglePhase) * b.radius * WIGGLE_PER_RADIUS * k;
  return [b.centerX + ox * b.r - oy * side, b.centerY + oy * b.r + ox * side];
}

// One bubble at (x, y), radius rr, squash q, `lit` 0-1 (brighter near
// the surface). `dir` points at the surface.
function drawBubble(x, y, dir, rr, q, lit) {
  const g = love.graphics;
  g.push();
  g.translate(x, y);
  g.rotate(dir);

  // Soft glow round it.
  setColor(BODY, 0.05 + 0.08 * lit);
  g.circle('fill', 0, 0, rr * 2.2 + 1.5);
  setColor(BODY, 0.06 + 0.10 * lit);
  g.circle('fill', 0, 0, rr * 1.5 + 0.8);

  g.scale(1 - q, 1 + q);

  if (rr < SMALL_RADIUS) {
    // A bead: a pale body with a bright glint on the lit side.
    setColor(BODY, 0.45 + 0.25 * lit);
    g.circle('fill', 0, 0, rr);
    setColor(SHADE, 0.5);
    g.circle('fill', -LX * rr * 0.35, -LY * rr * 0.35, rr * 0.45);
    setColor(WHITE, 0.95);
    g.circle('fill', LX * rr * 0.35, LY * rr * 0.35, Math.max(0.6, rr * 0.45));
  } else {
    // See-through body.
    setColor(BODY, 0.14 + 0.18 * lit);
    g.circle('fill', 0, 0, rr);

    // Rim: mid blue all round, lit toward the light, shaded away from it.
    const w = Math.max(1, rr * 0.2);
    const rimR = rr - w * 0.5;
    g.setLineWidth(w);
    setColor(RIM, 0.85);
    g.circle('line', 0, 0, rimR);
    setColor(LIT, 0.95);
    g.arc('line', 'open', 0, 0, rimR, LIGHT_ANGLE - 1.15, LIGHT_ANGLE + 1.15);
    setColor(SHADE, 0.85);
    g.arc('line', 'open', 0, 0, rimR, LIGHT_ANGLE + Math.PI - 0.95, LIGHT_ANGLE + Math.PI + 0.95);

    // Highlight toward the light, a second fleck beside it on bigger
    // ones, and light refracted through to the far side.
    const hx = LX * rr * 0.45, hy = LY * rr * 0.45;
    setColor(WHITE, 1);
    g.circle('fill', hx, hy, Math.max(0.7, rr * 0.2));
    if (rr >= 2.5) {
      setColor(LIT, 0.9);
      g.circle('fill', hx - LY * rr * 0.32, hy + LX * rr * 0.32, rr * 0.12);
    }
    setColor(LIT, 0.8);
    g.circle('fill', -LX * rr * 0.5, -LY * rr * 0.5, Math.max(0.5, rr * 0.13));
  }

  g.pop();
}

// A popping bubble at the surface point (x, y), `dir` pointing out of
// the water: first a dome bulging up through the surface, then a
// flattened ripple spreading along it, with two flecks thrown clear.
function drawPop(b, x, y, dir) {
  const g = love.graphics;
  const rr = b.popRadius;
  const hasDome = rr >= POP_DOME_MIN;
  const age = b.popAge;

  g.push();
  g.translate(x, y);
  g.rotate(dir);

  if (hasDome && age < POP_DOME_TICKS) {
    // The dome: the half of the bubble above the surface.
    g.setLineWidth(Math.max(1, rr * 0.2));
    setColor(LIT, 0.95);
    const pts = [];
    for (let i = 0; i <= 16; i++) {
      const a = -Math.PI / 2 + Math.PI * i / 16;
      pts.push(Math.cos(a) * rr * 0.9, Math.sin(a) * rr);
    }
    g.line(pts);
    setColor(WHITE, 1);
    g.circle('fill', rr * 0.55, -rr * 0.4, Math.max(0.7, rr * 0.2));
  } else {
    let k = (age - (hasDome ? POP_DOME_TICKS : 0)) / POP_RIPPLE_TICKS;
    k = Math.min(1, Math.max(0, k));
    const alpha = Math.min(1, 1.2 - k);

    // The ripple: the underwater half of a ring, squashed flat against
    // the surface, widening as it fades.
    const w = rr + 1 + k * rr * 1.6;
    g.setLineWidth(Math.max(1, rr * 0.18) * (1 - 0.5 * k));
    setColor(k < 0.4 ? WHITE : BODY, alpha);
    const pts = [];
    const a0 = Math.PI / 2 + 0.15, a1 = 3 * Math.PI / 2 - 0.15;
    for (let i = 0; i <= 18; i++) {
      const a = a0 + (a1 - a0) * i / 18;
      pts.push(Math.cos(a) * w * 0.3, Math.sin(a) * w);
    }
    g.line(pts);

    // Two flecks of spray flying off.
    if (hasDome && k < 0.6) {
      const s = rr * 0.5;
      const d = Math.max(0.6, rr * 0.15);
      setColor(LIT, alpha);
      g.circle('fill', (2 + k * 4) * s, -2 * s, d);
      g.circle('fill', (3 + k * 5) * s, 2 * s, d);
    }
  }

  g.pop();
}

// Drawn after the water's own fill (see main.js), so they sit on top of
// it instead of being muddied underneath.
Bubbles.draw = function (list) {
  const g = love.graphics;
  const lineWidth = g.getLineWidth();
  for (const b of list) {
    if (b.popAge !== null) {
      const [x, y] = position(b, 1);
      drawPop(b, x, y, b.angle);
    } else {
      const k = progress(b);
      const [x, y] = position(b, k);
      const q = SQUASH * Math.sin(b.wigglePhase * 2) * Math.min(1, b.radius / 2);
      const lit = 0.25 + 0.6 * k + 0.15 * Math.sin(b.swayPhase * 3);
      drawBubble(x, y, b.angle, b.radius * (1 + SWELL * k), q, Math.max(0, Math.min(1, lit)));
    }
  }
  g.setLineWidth(lineWidth);
  g.setColor(1, 1, 1, 1);
};

export default Bubbles;
