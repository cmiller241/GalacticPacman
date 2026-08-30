-- lua/systems/TargetLock.lua
--
-- Port of js/systems/TargetLock.js.
-- Candidate-gathering/selection logic for the gamepad hard-lock (R1 =
-- next/clockwise, L1 = previous/counter-clockwise, Circle = release —
-- see GamePadInput.lua and Player:tryLockTargetNext/Previous/
-- clearLockTarget).

local state = require("lua.state")
local utils = require("lua.utils")

local TargetLock = {}

-- Candidate pool for lock-on: planetoids (including permanent
-- structures like the sky dome) and asteroids, plus ooombas.
-- isPullExempt objects (TiledTerrain's walkable shapes, JumpPlatform)
-- are excluded — they're terrain, not really "targets," the same
-- reasoning that already excludes them from pull-beam selection (see
-- Player:trySelectPullTarget). Whatever the player is CURRENTLY
-- standing on is also excluded — locking onto the ground under his
-- own feet doesn't make sense as a target. SpaceGhosts/fire bars are
-- deliberately left out too, matching the original's own scoped-down
-- first version.
local function gatherLockCandidates()
  local standingOn = (state.player and state.player.onSurface) and state.player.currentPlanet or nil
  local candidates = {}

  for _, p in ipairs(state.planetoids) do
    if p ~= standingOn and not p.isPullExempt
       and utils.isOnScreen(p.pos.x, p.pos.y, utils.boundingRadius(p), 0) then
      table.insert(candidates, p)
    end
  end

  if state.asteroids then
    for _, a in ipairs(state.asteroids) do
      if a ~= standingOn and utils.isOnScreen(a.pos.x, a.pos.y, utils.boundingRadius(a), 0) then
        table.insert(candidates, a)
      end
    end
  end

  if state.ooombas then
    for _, o in ipairs(state.ooombas) do
      if o ~= standingOn and utils.isOnScreen(o.pos.x, o.pos.y, utils.boundingRadius(o), 0) then
        table.insert(candidates, o)
      end
    end
  end

  return candidates
end

-- Still valid to remain locked onto: the object hasn't been destroyed
-- (still present in whichever array it came from), hasn't scrolled out
-- of the viewport, and isn't the planet the player has since landed on
-- (e.g. after a successful pull toward it). Checked every frame by
-- Player:computeLeftArmAimAngle, which clears lockedTarget the moment
-- this returns false, falling back to the normal aim priority chain.
function TargetLock.isValidLockTarget(obj)
  if not obj then return false end

  local stillExists = false
  for _, p in ipairs(state.planetoids) do
    if p == obj then stillExists = true; break end
  end
  if not stillExists and state.asteroids then
    for _, a in ipairs(state.asteroids) do
      if a == obj then stillExists = true; break end
    end
  end
  if not stillExists and state.ooombas then
    for _, o in ipairs(state.ooombas) do
      if o == obj then stillExists = true; break end
    end
  end
  if not stillExists then return false end

  if not utils.isOnScreen(obj.pos.x, obj.pos.y, utils.boundingRadius(obj), 0) then return false end
  if state.player and state.player.onSurface and state.player.currentPlanet == obj then return false end
  return true
end

-- Picks whichever candidate is the smallest angular step AWAY from
-- referenceAngle in the given direction (+1 = clockwise, -1 =
-- counter-clockwise) — shared by selectNextLockTarget and
-- selectPreviousLockTarget below, which are otherwise identical except
-- for which direction they sweep.
--
-- Canvas/world space here is Y-DOWN, same as the original, which flips
-- the usual math convention: INCREASING an atan2 angle is a CLOCKWISE
-- sweep on screen, not counter-clockwise. So "next clockwise" is
-- simply "smallest angle strictly greater than referenceAngle," and
-- "next counter-clockwise" is the mirror of that.
--
-- Lua's `%` is a floor-modulo (always same sign as the divisor, so the
-- raw result already lands in [0, 2*pi) regardless of the dividend's
-- sign) — unlike JS's `%`, which can come back negative and needs its
-- own explicit fixup for that. The `delta <= 0` fixup below is still
-- needed here, just for a narrower reason: pushing an exact-zero delta
-- (a candidate sitting essentially at referenceAngle itself) out to a
-- full 2*pi turn, so it's only ever picked as a genuine last resort.
local function pickNearestInDirection(candidates, playerX, playerY, referenceAngle, direction)
  local best, bestDelta = nil, math.huge
  for _, c in ipairs(candidates) do
    local angle = math.atan2(c.pos.y - playerY, c.pos.x - playerX)
    local delta = ((angle - referenceAngle) * direction) % (math.pi * 2)
    if delta <= 0 then delta = delta + math.pi * 2 end
    if delta < bestDelta then
      bestDelta = delta
      best = c
    end
  end
  return best
end

-- currentTarget (if any) is excluded from the candidate pool, so
-- repeated presses actually advance through the group instead of
-- re-selecting the same object immediately; if it turns out to be the
-- ONLY thing in the viewport, currentTarget is returned again rather
-- than releasing the lock just because there's nothing else nearby.
local function selectInDirection(currentTarget, referenceAngle, originPos, direction)
  local candidates = {}
  for _, c in ipairs(gatherLockCandidates()) do
    if c ~= currentTarget then table.insert(candidates, c) end
  end
  if #candidates == 0 then
    return currentTarget or nil
  end
  return pickNearestInDirection(candidates, originPos.x, originPos.y, referenceAngle, direction)
end

-- Next candidate CLOCKWISE from referenceAngle (R1).
function TargetLock.selectNextLockTarget(currentTarget, referenceAngle, originPos)
  return selectInDirection(currentTarget, referenceAngle, originPos, 1)
end

-- Next candidate COUNTER-clockwise from referenceAngle (L1) — the
-- mirror of selectNextLockTarget above. In the common case of a single
-- R1 press followed by a single L1 press with nothing having changed
-- in between, this naturally lands back on whatever was locked before
-- the R1 press, reading as a genuine undo.
function TargetLock.selectPreviousLockTarget(currentTarget, referenceAngle, originPos)
  return selectInDirection(currentTarget, referenceAngle, originPos, -1)
end

return TargetLock
