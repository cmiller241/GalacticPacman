// js/systems/TargetLock.js
import { state } from '../state.js';
import { isInViewport } from './Raycast.js';

// Candidate pool for lock-on: planetoids (including permanent
// structures — the dome, maze entrance, etc.) and asteroids, plus
// goombas. SpaceGhosts (state.enemies) and fire bars (state.fireBars)
// are deliberately excluded for now — fire bars are fixed hazards, not
// really "targets," and enemies are left out per an explicit decision
// to keep the first version of this scoped down; easy to add either
// later if wanted. Whatever the player is CURRENTLY standing on is
// also excluded — locking onto the ground under his own feet doesn't
// make sense as a target.
function gatherLockCandidates() {
  const standingOn = (state.player && state.player.onSurface) ? state.player.currentPlanet : null;
  return [...state.planetoids, ...state.asteroids, ...state.goombas]
    .filter(c => c !== standingOn)
    .filter(isInViewport);
}

// Still valid to remain locked onto: the object hasn't been destroyed
// (still present in whichever array it came from), hasn't scrolled out
// of the viewport, and isn't the planet the player has since landed on
// (e.g. after a successful pull toward it — stepping onto something
// locked should release the lock, the same way it was never offered as
// a candidate in the first place while already standing on it). Checked
// every frame by Player.js's computeLeftArmAimAngle, which clears
// this.lockedTarget the moment this returns false, falling back to the
// normal aim priority chain.
export function isValidLockTarget(obj) {
  if (!obj) return false;
  const stillExists = state.planetoids.includes(obj) || state.asteroids.includes(obj) || state.goombas.includes(obj);
  if (!stillExists) return false;
  if (!isInViewport(obj)) return false;
  if (state.player && state.player.onSurface && state.player.currentPlanet === obj) return false;
  return true;
}

// Picks whichever candidate is the smallest angular step AWAY from
// referenceAngle in the given direction (+1 = clockwise, -1 =
// counter-clockwise) — shared by selectNextLockTarget and
// selectPreviousLockTarget below, which are otherwise identical except
// for which direction they sweep.
//
// Canvas/world space here is Y-DOWN, which flips the usual math
// convention: INCREASING an atan2 angle is a CLOCKWISE sweep on
// screen, not counterclockwise (visualize rotating from "pointing
// right," angle 0, toward "pointing right-and-down," a small positive
// angle — that reads as sweeping clockwise, same direction a clock's
// hands move from 3 toward 4-5 o'clock). So "next clockwise" is simply
// "smallest angle strictly greater than referenceAngle," and "next
// counter-clockwise" is the mirror of that — "smallest angle strictly
// LESS than referenceAngle" — both wrapping around the full circle
// when nothing qualifies directly on that side.
function pickNearestInDirection(candidates, playerPos, referenceAngle, direction) {
  let best = null;
  let bestDelta = Infinity;
  for (const c of candidates) {
    const angle = Math.atan2(c.pos.y - playerPos.y, c.pos.x - playerPos.x);
    // How far AWAY from referenceAngle, in the given direction, to
    // reach this candidate's angle, normalized to (0, 2π] — excludes
    // exactly 0 deliberately (a delta of 0 gets pushed all the way to
    // 2π instead), so a candidate sitting essentially at
    // referenceAngle itself is only ever picked as an actual last
    // resort, not preferentially re-selected over things that are
    // genuinely further along the sweep.
    let delta = ((angle - referenceAngle) * direction) % (Math.PI * 2);
    if (delta <= 0) delta += Math.PI * 2;
    if (delta < bestDelta) {
      bestDelta = delta;
      best = c;
    }
  }
  return best;
}

// currentTarget (if any) is excluded from the candidate pool in both
// functions below, so repeated presses actually advance through the
// group instead of being able to re-select the same object
// immediately; if it turns out to be the ONLY thing in the viewport,
// currentTarget is returned again rather than releasing the lock just
// because there's nothing else nearby.

// Next candidate CLOCKWISE from referenceAngle (R1) — i.e., whichever
// candidate the blaster would sweep across first if it kept rotating
// clockwise starting from referenceAngle.
export function selectNextLockTarget(currentTarget, referenceAngle, playerPos) {
  const candidates = gatherLockCandidates().filter(c => c !== currentTarget);
  if (candidates.length === 0) {
    return currentTarget || null;
  }
  return pickNearestInDirection(candidates, playerPos, referenceAngle, 1);
}

// Next candidate COUNTER-clockwise from referenceAngle (L1) — the
// mirror of selectNextLockTarget above. In the common case of a
// single R1 press followed by a single L1 press with nothing having
// changed in between, this naturally lands back on whatever was
// locked before the R1 press — R1's "nearest clockwise neighbor" and
// L1's "nearest counter-clockwise neighbor" are symmetric by
// construction, so it reads as a genuine undo, not just "some other
// direction."
export function selectPreviousLockTarget(currentTarget, referenceAngle, playerPos) {
  const candidates = gatherLockCandidates().filter(c => c !== currentTarget);
  if (candidates.length === 0) {
    return currentTarget || null;
  }
  return pickNearestInDirection(candidates, playerPos, referenceAngle, -1);
}