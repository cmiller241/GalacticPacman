// js/utils.js
//
// Small shared helpers with no better home of their own.

import state from './state.js';

const utils = {};

// True if a circle at (x, y) with the given radius intersects the
// camera's current visible rect, expanded by `margin` world units on
// every side (default 0) so objects don't visibly pop in/out right at
// the screen edge. Used to skip per-frame update/draw work for objects
// that are nowhere near what's actually on screen right now — this
// game can have hundreds of active planetoids/fire bars alive at once
// in the streamed 3x3 cell neighborhood, almost all of them off-screen
// at any given moment.
utils.isOnScreen = function (x, y, radius, margin = 0) {
  const cam = state.camera;
  if (!cam) return true; // camera not set up yet (e.g. the very first frame) — don't cull blind
  const minX = cam.x - radius - margin;
  const maxX = cam.x + (state.visibleWidth ?? 0) + radius + margin;
  const minY = cam.y - radius - margin;
  const maxY = cam.y + (state.visibleHeight ?? 0) + radius + margin;
  return x >= minX && x <= maxX && y >= minY && y <= maxY;
};

// A single bounding-circle radius for anything drawable in this game,
// regardless of which shape convention it actually uses: a plain
// `radius` if it has one (Planetoid, Asteroid, SkyDomePlanetoid, which
// all set this directly even when isRoundedRect), otherwise derived
// from `halfWidth`/`halfHeight` (Ooomba). Used by TargetLock.js
// (viewport/candidate checks) and the lock-on/VATS effects.
utils.boundingRadius = function (obj) {
  if (obj.radius) return obj.radius;
  if (obj.halfWidth && obj.halfHeight) {
    return Math.sqrt(obj.halfWidth * obj.halfWidth + obj.halfHeight * obj.halfHeight);
  }
  return 0;
};

export default utils;
