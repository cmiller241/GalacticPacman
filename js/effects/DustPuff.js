// js/effects/DustPuff.js
//
// Shared dusty tan/beige particle-puff spawner. Footstep dust while
// walking, the bigger burst on a wall-jump kick-off, and RobotButler.js's
// own walking dust all come from here, so the color/radius/drag/growRate
// tuning only needs to live in one place regardless of who's walking.

import state from '../state.js';
import Particle from '../entities/Particle.js';

const DustPuff = {};

// h in degrees [0,360), s/l in [0,1] -> [r, g, b] in [0,1].
function hslToRgb(h, s, l) {
  if (s === 0) return [l, l, l];
  const hueToRgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? (l * (1 + s)) : (l + s - l * s);
  const p = 2 * l - q;
  const hNorm = h / 360;
  return [hueToRgb(p, q, hNorm + 1 / 3), hueToRgb(p, q, hNorm), hueToRgb(p, q, hNorm - 1 / 3)];
}

// Three overlapping sub-circles per particle instead of one plain
// circle — a fused clover-shaped blob (think three coins pressed
// together), not a uniform dot. Spaced evenly around the center
// (120 degrees apart) at a small, consistent distance so they always
// fuse into one clumped shape rather than sometimes drifting apart into
// three separate dots — the only per-puff randomness is an overall
// rotation (baseAngle) plus a little jitter, so a "bunch of them" reads
// as the same recognizable shape rotated differently, not a different
// shape each time. Positions/sizes are FRACTIONS of the particle's own
// radius (see Particle.js's own blobs comment), generated once per
// particle and reused every frame, so the cluster stays fused to itself
// as the particle drifts and grows rather than reshuffling frame to frame.
function randomBlobs() {
  const baseAngle = Math.random() * Math.PI * 2;
  const blobs = [];
  for (let i = 0; i <= 2; i++) {
    blobs.push({
      angle: baseAngle + i * (2 * Math.PI / 3) + (Math.random() - 0.5) * 0.4,
      distFrac: 0.26 + Math.random() * 0.12,
      radiusFrac: 0.62 + Math.random() * 0.28,
    });
  }
  return blobs;
}

// Spawns one puff of `count` particles, all starting at the same point
// and scattering outward from there. Parameters:
//
//   pos             Vector2 — world-space spawn point for every particle
//                   in this puff (e.g. a character's feet, or the exact
//                   spot a wall-jump kicked off from).
//
//   intoSurfaceDir  Vector2, unit length — points INTO whatever surface
//                   is being kicked off of: straight down (0,1) for an
//                   ordinary footstep, or the wall's own inward normal
//                   for a wall-jump kick. Particles drift AWAY from this
//                   (i.e. along its negation) — out of the surface and
//                   into open space, not through it.
//
//   sideDir         Vector2, unit length, perpendicular to
//                   intoSurfaceDir — the "along the surface" direction
//                   used to scatter particles sideways.
//
//   count           How many particles this one call spawns.
//
//   sideSpreadScale How far particles can scatter sideways, in world
//                   units/60fps-tick — each particle's own sideways
//                   speed is randomized between -sideSpreadScale/2 and
//                   +sideSpreadScale/2 along sideDir.
//
//   driftMin,       The range each particle's OUTWARD (away from the
//   driftMax        surface) drift speed is randomized within, in world
//                   units/60fps-tick. A gentle footstep uses a small
//                   range (a soft drift up), a wall-jump kick uses a
//                   bigger one (a sharper burst outward).
DustPuff.spawn = function (pos, intoSurfaceDir, sideDir, count, sideSpreadScale, driftMin, driftMax) {
  for (let n = 0; n < count; n++) {
    const sideSpread = (Math.random() - 0.5) * sideSpreadScale;
    const driftSpeed = driftMin + Math.random() * (driftMax - driftMin);
    const vel = sideDir.clone().multiply(sideSpread).add(intoSurfaceDir.clone().multiply(-driftSpeed));

    const particle = Particle.new(pos, vel, 22 + Math.random() * 14);
    particle.color = hslToRgb(35 + Math.random() * 15, (30 + Math.random() * 15) / 100, (55 + Math.random() * 15) / 100); // dusty tan/beige
    particle.radius = 2 + Math.random() * 1.5;
    particle.drag = 0.9;      // slows down rather than drifting at constant speed forever, like real dust settling
    particle.growRate = 0.06; // gently expands over its life, like a puff dispersing rather than staying a fixed-size dot
    particle.blobs = randomBlobs();
    state.particles.push(particle);
  }
};

// Dust thrown straight OUTWARD from a single point, like the spokes of
// a wheel — for an impact (a ground pound), as opposed to
// DustPuff.spawn's soft drift up off a footstep. The particles are
// spread evenly round the half-circle on the open side of the surface
// (so none are sent down into the ground itself), each flying directly
// away from `pos`.
//
//   pos                 Vector2 — the point of impact.
//   awayDir             Vector2, unit length — pointing AWAY from the
//                       surface (straight up, on flat ground).
//   count               how many particles.
//   speedMin, speedMax  range each particle's outward speed is
//                       randomized within, world units/60fps-tick.
DustPuff.spawnRadial = function (pos, awayDir, count, speedMin, speedMax) {
  const sideDir = awayDir.clone();
  sideDir.x = -awayDir.y;
  sideDir.y = awayDir.x;

  for (let i = 1; i <= count; i++) {
    // Evenly fanned from one side of the ground round to the other,
    // with a little jitter so it isn't a perfectly regular starburst.
    const angle = ((i - 0.5) / count) * Math.PI + (Math.random() - 0.5) * 0.25;
    const speed = speedMin + Math.random() * (speedMax - speedMin);
    const vel = sideDir.clone().multiply(Math.cos(angle) * speed)
      .add(awayDir.clone().multiply(Math.sin(angle) * speed));

    const particle = Particle.new(pos, vel, 26 + Math.random() * 16);
    particle.color = hslToRgb(35 + Math.random() * 15, (30 + Math.random() * 15) / 100, (55 + Math.random() * 15) / 100); // same dusty tan/beige as spawn
    particle.radius = 2.5 + Math.random() * 2;
    particle.drag = 0.9;
    particle.growRate = 0.09;
    particle.blobs = randomBlobs();
    state.particles.push(particle);
  }
};

export default DustPuff;
