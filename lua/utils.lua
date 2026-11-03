-- lua/utils.lua
--
-- Small shared helpers with no better home of their own.

local state = require("lua.state")

local utils = {}

-- True if a circle at (x, y) with the given radius intersects the
-- camera's current visible rect, expanded by `margin` world units on
-- every side (default 0) so objects don't visibly pop in/out right at
-- the screen edge. Used to skip per-frame update/draw work for objects
-- that are nowhere near what's actually on screen right now — this
-- game can have hundreds of active planetoids/fire bars alive at once
-- in the streamed 3x3 cell neighborhood (BELT_PLANETOIDS_PER_CELL=36
-- alone), almost all of them off-screen at any given moment.
function utils.isOnScreen(x, y, radius, margin)
  local cam = state.camera
  if not cam then return true end -- camera not set up yet (e.g. the very first frame) — don't cull blind
  margin = margin or 0
  local minX = cam.x - radius - margin
  local maxX = cam.x + (state.visibleWidth or 0) + radius + margin
  local minY = cam.y - radius - margin
  local maxY = cam.y + (state.visibleHeight or 0) + radius + margin
  return x >= minX and x <= maxX and y >= minY and y <= maxY
end

-- A single bounding-circle radius for anything drawable in this game,
-- regardless of which shape convention it actually uses: a plain
-- `radius` if it has one (Planetoid, Asteroid, SkyDomePlanetoid, which
-- all set this directly even when isRoundedRect), otherwise derived
-- from `halfWidth`/`halfHeight` (Ooomba, which has neither `radius`
-- nor isRoundedRect but does have those two). Used by TargetLock.lua
-- (viewport/candidate checks) and the lock-on/VATS effects, mirroring
-- js/systems/Raycast.js's getBoundingRadius but generalized to cover
-- Ooomba too, since that one Lua-only entity has no JS equivalent with
-- a matching shape.
function utils.boundingRadius(obj)
  if obj.radius then return obj.radius end
  if obj.halfWidth and obj.halfHeight then
    return math.sqrt(obj.halfWidth * obj.halfWidth + obj.halfHeight * obj.halfHeight)
  end
  return 0
end

-- Removing many items from a list with table.remove in a loop moves
-- every item after each one down a place — slow for a long list with a
-- lot going at once (water droplets, particles, culled planetoids). These
-- two do it in a single pass instead, keeping the rest in their order.

-- Removes every item of `list` that's a key of `gone` (gone[item] = true).
-- For loops that update a list's items and note the finished ones as
-- they go, then remove them all at the end:
--
--   local gone
--   for i = #list, 1, -1 do
--     if finished(list[i]) then gone = gone or {}; gone[list[i]] = true end
--   end
--   if gone then utils.removeMarked(list, gone) end
function utils.removeMarked(list, gone)
  local n, kept = #list, 0
  for i = 1, n do
    local item = list[i]
    if not gone[item] then
      kept = kept + 1
      list[kept] = item
    end
  end
  for i = n, kept + 1, -1 do list[i] = nil end
end

-- Removes every item of `list` that `test(item)` is true for. (test is
-- called on each item once, front to back, and mustn't add to the list.)
function utils.removeWhere(list, test)
  local n, kept = #list, 0
  for i = 1, n do
    local item = list[i]
    if not test(item) then
      kept = kept + 1
      list[kept] = item
    end
  end
  for i = n, kept + 1, -1 do list[i] = nil end
end

return utils
