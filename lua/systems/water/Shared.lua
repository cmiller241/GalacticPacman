-- lua/systems/water/Shared.lua
--
-- State and helpers shared by the water system's parts.
--
-- shared holds the state that WaterSystem.reset replaces (so the parts read it
-- as shared.<name>, never keeping their own copy):
--   shared.grid               the Tiled level's water grid (see LevelGrid.lua), or nil
--   shared.planetGrids        dirt planets' grids, keyed weakly by planet (see PlanetGrids.lua)
--   shared.oceans             water layers on round planetoids, keyed weakly (see Oceans.lua)
--   shared.droplets           spray in flight
--   shared.splashes           splash bits
--   shared.waterfallLandings  this frame's, from drawPools: { x, y, half, flow }
--   shared.steam              puffs: { x, y, vx, vy, life, maxLife }
--   shared.hotSpots           where fireballs went out: { x, y, c, r (grid) or planet, life, steamBudget }
--   shared.lavaEmbers         { x, y, vx, vy, life, decay, radius }
--   shared.obsidians          obsidian blocks lava's turned into (see Obsidian.lua)
--   shared.age                seconds since the game started (for the shaders)
-- Part of the water system: see lua/systems/WaterSystem.lua.

local Tuning = require("lua.systems.water.Tuning")
local SPREAD = Tuning.SPREAD
local SPREAD_PASSES = Tuning.SPREAD_PASSES
local MIN_SPREAD = Tuning.MIN_SPREAD
local EVAPORATE_PER_SECOND = Tuning.EVAPORATE_PER_SECOND
local LAVA_TUNING = Tuning.LAVA_TUNING

local shared = {
  grid = nil,
  planetGrids = setmetatable({}, { __mode = "k" }),
  oceans = setmetatable({}, { __mode = "k" }),
  droplets = {},
  splashes = {},
  waterfallLandings = {},
  steam = {},
  hotSpots = {},
  lavaEmbers = {},
  obsidians = {},
  age = 0,
}

-- Ice (see Ice.lua): its blocks, and its own clock.
local Ice = { blocks = {}, frame = 0 }

-- Scratch space reused every frame, so the water's busiest loops don't
-- make fresh tables each time: the wet-cell list stepWater walks, and
-- the vertices the pools and oceans are drawn from — only the first
-- vertCount of `verts` are this draw's (the rest are kept for reuse).
-- (One table for all of it: see LAVA_TUNING on the 200-local limit.)
local Scratch = { cells = {}, verts = {}, vertCount = 0 }

-- Removes the finished droplets, splashes, puffs and embers from their
-- lists in one pass (see utils.removeMarked).
Scratch.removeMarked = require("lua.utils").removeMarked

-- Every key of `water` (a liquid's cells), in Scratch.cells; returns
-- the list and how many.
function Scratch.collectCells(water)
  local list, n = Scratch.cells, 0
  for i in pairs(water) do
    n = n + 1
    list[n] = i
  end
  for k = #list, n + 1, -1 do list[k] = nil end
  return list, n
end

function Scratch.resetVerts()
  Scratch.vertCount = 0
end

-- One vertex: position, texture coordinates (u, v), and alpha.
function Scratch.vert(x, y, u, v, alpha)
  local n = Scratch.vertCount + 1
  Scratch.vertCount = n
  local t = Scratch.verts[n]
  if t then
    t[1], t[2], t[3], t[4], t[8] = x, y, u, v, alpha
  else
    Scratch.verts[n] = { x, y, u, v, 1, 1, 1, alpha }
  end
end

-- Two triangles over the corners 1-2-3-4 (top edge 1->2, bottom edge
-- 4->3): depthTop/depthBottom are their u, stream their v.
function Scratch.quad(x1, y1, x2, y2, x3, y3, x4, y4, depthTop, depthBottom, stream)
  local vert = Scratch.vert
  vert(x1, y1, depthTop, stream, 1); vert(x2, y2, depthTop, stream, 1); vert(x3, y3, depthBottom, stream, 1)
  vert(x1, y1, depthTop, stream, 1); vert(x3, y3, depthBottom, stream, 1); vert(x4, y4, depthBottom, stream, 1)
end

-- How each liquid moves (see stepWater): which of a grid's tables it's
-- kept in, and its rules.
local WATER = { key = "water", spread = SPREAD, passes = SPREAD_PASSES, minSpread = MIN_SPREAD, evaporate = EVAPORATE_PER_SECOND }
local LAVA = { key = "lava", spread = LAVA_TUNING.SPREAD, passes = LAVA_TUNING.SPREAD_PASSES, minSpread = LAVA_TUNING.MIN_SPREAD, evaporate = 0 }

return {
  shared = shared,
  Ice = Ice,
  Scratch = Scratch,
  WATER = WATER,
  LAVA = LAVA,
}
