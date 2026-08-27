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

return utils
