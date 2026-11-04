// js/effects/InfluenceRing.js
//
// A planetoid's dashed influence-radius ring — a visual debug aid
// showing how far a planetoid's gravity actually reaches, toggled with
// 'R' (see InputHandlers.js).
//
// Each ring's dashes are built once into a mesh (short chords round the
// circle, LINE_WIDTH thick) and drawn in one call, turned by the march
// angle. Drawing every dash as its own line cost several milliseconds a
// frame in the busy belt.

import love from '../love/index.js';

const InfluenceRing = {};

const DASH_LENGTH = 10;
const GAP_LENGTH = 5;
const LINE_WIDTH = 3;
const COLOR = [173 / 255, 216 / 255, 230 / 255];
// Marching ants: how fast the dashes travel round the ring (world units
// per second, along the line — so big and small rings march at the same
// visible pace). Positive goes clockwise on screen; 0 stands still.
const MARCH_SPEED = 20;

// Meshes by radius (to the nearest quarter unit). Belt planetoids come
// and go with their own radii, so the cache is emptied once it's big.
const MAX_CACHED = 400;
let meshes = new Map();

function ringMesh(radius, segmentCount, angleStep, dashAngle) {
  const key = Math.floor(radius * 4 + 0.5);
  let mesh = meshes.get(key);
  if (mesh) return mesh;
  if (meshes.size >= MAX_CACHED) {
    for (const m of meshes.values()) m.release();
    meshes = new Map();
  }
  const half = LINE_WIDTH / 2;
  const verts = [];
  for (let i = 0; i < segmentCount; i++) {
    const a0 = i * angleStep;
    const a1 = a0 + dashAngle;
    const x0 = Math.cos(a0) * radius, y0 = Math.sin(a0) * radius;
    const x1 = Math.cos(a1) * radius, y1 = Math.sin(a1) * radius;
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy);
    const nx = -dy / len * half, ny = dx / len * half;
    verts.push(
      [x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny],
      [x0 + nx, y0 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny],
    );
  }
  mesh = love.graphics.newMesh(verts, 'triangles', 'static');
  meshes.set(key, mesh);
  return mesh;
}

// alpha: how strongly to draw it — decided by the caller (see the ring
// pass in main.js's love.draw) from how much this body's gravity
// matters to the player right now, rather than drawing every ring on
// screen at full strength.
InfluenceRing.draw = function (x, y, radius, alpha) {
  if (radius <= 0 || alpha <= 0) return;

  const period = DASH_LENGTH + GAP_LENGTH;
  const circumference = 2 * Math.PI * radius;
  // Whole number of dash+gap periods around the circle, so the pattern
  // joins up cleanly instead of leaving one oddly-sized dash where it
  // wraps back to the start.
  const segmentCount = Math.max(1, Math.floor(circumference / period));
  const angleStep = (2 * Math.PI) / segmentCount;
  const dashAngle = angleStep * (DASH_LENGTH / period);
  // How far the pattern has marched round by now (one period's worth of
  // travel moves it on by exactly one dash+gap, so it loops seamlessly).
  const march = ((love.timer.getTime() * MARCH_SPEED) % period) / period * angleStep;

  love.graphics.setColor(COLOR[0], COLOR[1], COLOR[2], alpha);
  love.graphics.draw(ringMesh(radius, segmentCount, angleStep, dashAngle), x, y, march);
  love.graphics.setColor(1, 1, 1, 1);
};

export default InfluenceRing;
