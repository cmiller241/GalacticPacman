// js/systems/TargetLock.js
//
// Candidate-gathering/selection logic for the gamepad hard-lock (R1 =
// next/clockwise, L1 = previous/counter-clockwise, Circle = release —
// see GamePadInput.js and Player.tryLockTargetNext/Previous/clearLockTarget).

import state from '../state.js';
import utils from '../utils.js';
import lua from '../love/lua.js';

const TargetLock = {};

function gatherLockCandidates() {
  const standingOn = (state.player && state.player.onSurface) ? state.player.currentPlanet : null;
  const candidates = [];
  const onScreen = (o) => utils.isOnScreen(o.pos.x, o.pos.y, utils.boundingRadius(o), 0);

  for (const p of state.planetoids) {
    if (p !== standingOn && !p.isPullExempt && onScreen(p)) candidates.push(p);
  }
  for (const a of (state.asteroids ?? [])) {
    if (a !== standingOn && onScreen(a)) candidates.push(a);
  }
  for (const o of (state.ooombas ?? [])) {
    if (o !== standingOn && onScreen(o)) candidates.push(o);
  }
  return candidates;
}

TargetLock.isValidLockTarget = function (obj) {
  if (!obj) return false;
  const stillExists = state.planetoids.includes(obj)
    || (state.asteroids ?? []).includes(obj)
    || (state.ooombas ?? []).includes(obj);
  if (!stillExists) return false;
  if (!utils.isOnScreen(obj.pos.x, obj.pos.y, utils.boundingRadius(obj), 0)) return false;
  if (state.player && state.player.onSurface && state.player.currentPlanet === obj) return false;
  return true;
};

// Smallest angular step AWAY from referenceAngle in `direction` (+1 =
// clockwise on screen, -1 = counter-clockwise).
function pickNearestInDirection(candidates, playerX, playerY, referenceAngle, direction) {
  let best = null, bestDelta = Infinity;
  for (const c of candidates) {
    const angle = Math.atan2(c.pos.y - playerY, c.pos.x - playerX);
    let delta = lua.mod((angle - referenceAngle) * direction, Math.PI * 2);
    if (delta <= 0) delta += Math.PI * 2;
    if (delta < bestDelta) { bestDelta = delta; best = c; }
  }
  return best;
}

function selectInDirection(currentTarget, referenceAngle, originPos, direction) {
  const candidates = gatherLockCandidates().filter((c) => c !== currentTarget);
  if (candidates.length === 0) return currentTarget ?? null;
  return pickNearestInDirection(candidates, originPos.x, originPos.y, referenceAngle, direction);
}

TargetLock.selectNextLockTarget = function (currentTarget, referenceAngle, originPos) {
  return selectInDirection(currentTarget, referenceAngle, originPos, 1);
};

TargetLock.selectPreviousLockTarget = function (currentTarget, referenceAngle, originPos) {
  return selectInDirection(currentTarget, referenceAngle, originPos, -1);
};

export default TargetLock;
