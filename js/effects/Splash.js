// js/effects/Splash.js
//
// Shared watery particle-burst spawner for crossing a WaterPlanet's own
// surface — used by Player.js (entering/leaving submergedIn) and
// Fish.js (leaving the water on a jump, landing back in it). Same
// "one shared module, several callers" precedent as DustPuff.js, just
// with a simpler single fan-shaped burst instead of that one's
// clover-blob particles (droplets read fine as plain circles).

import state from '../state.js';
import Vector2 from '../vector2.js';
import Particle from '../entities/Particle.js';

const Splash = {};

const SPLASH_PARTICLE_COUNT = 30;
const SPLASH_CONE_ANGLE = Math.PI * 0.9; // full angular width droplets scatter across, centered on outwardDir
const SPLASH_SPEED_MIN = 5;
const SPLASH_SPEED_MAX = 12;
const SPLASH_LIFE_MIN = 22;
const SPLASH_LIFE_MAX = 40;
const SPLASH_RADIUS_MIN = 3;
const SPLASH_RADIUS_MAX = 7;
const SPLASH_DRAG = 0.92; // slightly less than before (0.90) so the now-faster droplets still carry out to their bigger radius before drag eats their speed
// Each droplet's color is randomized between these two — matches
// WaterPlanet.js's own shallow-water color at one end and a near-white
// foam highlight at the other, so the splash reads as the same water
// rather than an unrelated effect color.
const SPLASH_COLOR_DEEP = [0.30, 0.66, 0.85];
const SPLASH_COLOR_LIGHT = [0.85, 0.97, 1.0];

// pos: world-space crossing point (where the surface was broken).
// outwardDir: Vector2, unit length, pointing away from the water body's
// own center — droplets fan out around this direction rather than in
// every direction, since a real splash sprays away from the surface,
// not back into the water.
// count: optional, defaults to SPLASH_PARTICLE_COUNT.
// opts: optional tweaks for a different kind of splash (all default to
// the burst above): coneAngle, speedScale, lifeScale, radiusScale, and
// lightMin (0-1: how far toward SPLASH_COLOR_LIGHT the darkest droplet
// is — 0 the full range, 1 all foam-white). See WaterSystem.js's
// waterfall splashes.
Splash.spawn = function (pos, outwardDir, count, opts) {
  count = count ?? SPLASH_PARTICLE_COUNT;
  opts = opts ?? {};
  const cone = opts.coneAngle ?? SPLASH_CONE_ANGLE;
  const speedScale = opts.speedScale ?? 1, lifeScale = opts.lifeScale ?? 1;
  const radiusScale = opts.radiusScale ?? 1, lightMin = opts.lightMin ?? 0;
  const baseAngle = Math.atan2(outwardDir.y, outwardDir.x);

  for (let n = 0; n < count; n++) {
    const angle = baseAngle + (Math.random() - 0.5) * cone;
    const speed = (SPLASH_SPEED_MIN + Math.random() * (SPLASH_SPEED_MAX - SPLASH_SPEED_MIN)) * speedScale;
    const vel = new Vector2(Math.cos(angle) * speed, Math.sin(angle) * speed);
    const life = (SPLASH_LIFE_MIN + Math.random() * (SPLASH_LIFE_MAX - SPLASH_LIFE_MIN)) * lifeScale;

    const particle = Particle.new(pos, vel, life);
    const mixT = lightMin + Math.random() * (1 - lightMin);
    particle.color = [
      SPLASH_COLOR_DEEP[0] + (SPLASH_COLOR_LIGHT[0] - SPLASH_COLOR_DEEP[0]) * mixT,
      SPLASH_COLOR_DEEP[1] + (SPLASH_COLOR_LIGHT[1] - SPLASH_COLOR_DEEP[1]) * mixT,
      SPLASH_COLOR_DEEP[2] + (SPLASH_COLOR_LIGHT[2] - SPLASH_COLOR_DEEP[2]) * mixT,
    ];
    particle.radius = (SPLASH_RADIUS_MIN + Math.random() * (SPLASH_RADIUS_MAX - SPLASH_RADIUS_MIN)) * radiusScale;
    particle.drag = SPLASH_DRAG;
    state.particles.push(particle);
  }
};

export default Splash;
