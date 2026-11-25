// js/render/InfluenceRing.js
//
// A planetoid's dashed influence-radius ring, done the way the main game
// does it (js/effects/InfluenceRing.js): each ring's dashes are built
// ONCE into a cached shape (a Path2D of thin quads round the circle) and
// filled in one call, turned by a slow "marching" angle. Stroking with
// setLineDash instead re-dashed every circle every frame, and cost about
// half of each frame.

const DASH_LENGTH = 10;
const GAP_LENGTH = 5;
const LINE_WIDTH = 3;
// How fast the dashes travel round the ring (world units per second,
// along the line). 0 stands still.
const MARCH_SPEED = 20;

// Shapes by radius (to the nearest quarter unit).
const cache = new Map();

function ringShape(radius) {
  const key = Math.round(radius * 4);
  let shape = cache.get(key);
  if (shape) return shape;

  const period = DASH_LENGTH + GAP_LENGTH;
  // Whole number of dash+gap periods, so the pattern joins up cleanly.
  const segmentCount = Math.max(1, Math.floor((2 * Math.PI * radius) / period));
  const angleStep = (2 * Math.PI) / segmentCount;
  const dashAngle = angleStep * (DASH_LENGTH / period);
  const inner = radius - LINE_WIDTH / 2, outer = radius + LINE_WIDTH / 2;

  const path = new Path2D();
  for (let i = 0; i < segmentCount; i++) {
    const a0 = i * angleStep, a1 = a0 + dashAngle;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    path.moveTo(c0 * outer, s0 * outer);
    path.lineTo(c1 * outer, s1 * outer);
    path.lineTo(c1 * inner, s1 * inner);
    path.lineTo(c0 * inner, s0 * inner);
    path.closePath();
  }
  shape = { path, angleStep, period };
  cache.set(key, shape);
  return shape;
}

export function drawInfluenceRing(ctx, x, y, radius, alpha) {
  if (radius <= 0 || alpha <= 0.01) return;
  const { path, angleStep, period } = ringShape(radius);
  const march = (((performance.now() / 1000) * MARCH_SPEED) % period) / period * angleStep;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(march);
  ctx.fillStyle = `rgba(173,216,230,${alpha})`;
  ctx.fill(path);
  ctx.restore();
}
