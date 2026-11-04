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

// Removing many items from an array with splice in a loop moves every
// item after each one down a place — slow for a long list with a lot
// going at once (water droplets, particles, culled planetoids). These two
// do it in a single pass instead, keeping the rest in their order.

// Removes every item of `list` that's in the Set `gone`. For loops that
// update a list's items and note the finished ones as they go, then
// remove them all at the end:
//
//   let gone = null;
//   for (let i = list.length - 1; i >= 0; i--) {
//     if (finished(list[i])) (gone ??= new Set()).add(list[i]);
//   }
//   if (gone) utils.removeMarked(list, gone);
utils.removeMarked = function (list, gone) {
  let kept = 0;
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!gone.has(item)) list[kept++] = item;
  }
  list.length = kept;
};

// Removes every item of `list` that `test(item)` is true for. (test is
// called on each item once, front to back, and mustn't add to the list.)
utils.removeWhere = function (list, test) {
  const n = list.length;
  let kept = 0;
  for (let i = 0; i < n; i++) {
    const item = list[i];
    if (!test(item)) list[kept++] = item;
  }
  list.length = kept;
};

export default utils;
