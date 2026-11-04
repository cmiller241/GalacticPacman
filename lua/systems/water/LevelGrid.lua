-- lua/systems/water/LevelGrid.lua
--
-- The Tiled level's water grid: laying it out, its cells, and stepping
-- its water and lava.
-- Part of the water system: see lua/systems/WaterSystem.lua.

local state = require("lua.state")
local Tuning = require("lua.systems.water.Tuning")
local CELL = Tuning.CELL
local DRY = Tuning.DRY
local BOIL_REACH_CELLS = Tuning.BOIL_REACH_CELLS
local Shared = require("lua.systems.water.Shared")
local shared = Shared.shared
local Scratch = Shared.Scratch
local WATER = Shared.WATER

-- Functions it adds to WaterSystem (copied on in WaterSystem.lua).
local WaterSystem = {}

----------------------------------------------------------------------
-- The grid
----------------------------------------------------------------------

-- Lays the water grid over a Tiled level (see TiledTerrain.load). Water
-- follows the tiles' roles the way Bob does:
--   * "wall" tiles are solid on every side — every cell whose middle is
--     inside one is solid.
--   * Walkable surfaces ("top" tiles' tops, slopes included) are one-way,
--     like they are for Bob: a one-cell-thick floor layer just under the
--     surface that only stops water crossing it from its open side (from
--     above, or into a slope from the side it faces). From the side or
--     from below, water goes straight in — and on through the tile, which
--     is open beneath its surface.
--   * "fill" tiles (backdrop dirt) don't stop water at all.
-- Steep faces and ceilings aren't floors, so they don't stop it either.
-- The map's bottom edge sits on the dome's floor, so below it is solid
-- too; past its left and right edges water just runs away.
function WaterSystem.init(level)
  local width = (level.pos.x - level.anchorX) * 2
  local height = (level.pos.y - level.anchorY) * 2
  local cols, rows = math.ceil(width / CELL), math.ceil(height / CELL)
  local g = {
    x0 = level.anchorX, y0 = level.anchorY, cols = cols, rows = rows, solid = {}, floor = {}, water = {}, lava = {},
    level = level,
  }
  local function inside(c, r) return c >= 0 and c < cols and r >= 0 and r < rows end

  -- Wall tiles: every cell whose middle is inside one. (And the solid
  -- cells of its ball-tunnel pieces — see TiledTerrain.lua.)
  local walls = {}
  for _, w in ipairs(level.walls or {}) do walls[#walls + 1] = w end
  for _, w in ipairs(level.waterSolids or {}) do walls[#walls + 1] = w end
  for _, w in ipairs(walls) do
    if w.isWall then
      local c0 = math.ceil((w.pos.x - w.halfWidth - g.x0) / CELL - 0.5)
      local c1 = math.floor((w.pos.x + w.halfWidth - g.x0) / CELL - 0.5)
      local r0 = math.ceil((w.pos.y - w.halfHeight - g.y0) / CELL - 0.5)
      local r1 = math.floor((w.pos.y + w.halfHeight - g.y0) / CELL - 0.5)
      for r = r0, r1 do for c = c0, c1 do
        if inside(c, r) then g.solid[r * cols + c + 1] = true end
      end end
    end
  end

  -- Floors: each walkable surface walked along in half-cell steps,
  -- marking the cell just behind it (with the surface's normal, so we
  -- know which side is open — see crossesFloor). Sampled at the MIDDLE of
  -- each step, never the segment's own ends: an end sitting exactly on a
  -- cell boundary (where a ledge's top meets a pit's wall, say) would
  -- otherwise mark the open cell on the far side of it.
  for _, shape in ipairs(level.shapes or {}) do
    for _, s in ipairs(shape.segments or {}) do
      if s.normal.y < -0.3 and not s.isWallFace then
        local len = math.sqrt((s.b.x - s.a.x) ^ 2 + (s.b.y - s.a.y) ^ 2)
        local steps = math.max(1, math.ceil(len / (CELL * 0.5)))
        for k = 0, steps - 1 do
          local t = (k + 0.5) / steps
          -- Nudged a hair behind the surface, so a surface lying exactly
          -- on a cell boundary marks the cell under it.
          local x = s.a.x + (s.b.x - s.a.x) * t - s.normal.x * 0.5
          local y = s.a.y + (s.b.y - s.a.y) * t - s.normal.y * 0.5
          local c, r = math.floor((x - g.x0) / CELL), math.floor((y - g.y0) / CELL)
          if inside(c, r) then
            local i = r * cols + c + 1
            local list = g.floor[i]
            if not list then list = {}; g.floor[i] = list end
            local known = false
            for _, n in ipairs(list) do if n == s.normal then known = true end end
            if not known then list[#list + 1] = s.normal end
          end
        end
      end
    end
  end

  -- Slopes, for drawing (see drawPools): to the grid a slope is a
  -- staircase of cells, so water running down one would be drawn as a
  -- flat little sheet on each step. Each open cell sitting on a sloped
  -- floor remembers that floor's actual line, so the water there can be
  -- drawn lying along it instead.
  g.slope = {}
  local function taken(c, r)
    local i = r * cols + c + 1
    return g.solid[i] or g.floor[i]
  end
  for _, shape in ipairs(level.shapes or {}) do
    for _, s in ipairs(shape.segments or {}) do
      local dx = s.b.x - s.a.x
      if s.normal.y < -0.3 and not s.isWallFace and math.abs(s.normal.x) > 0.05 and math.abs(dx) > 1 then
        local line = {
          ax = s.a.x, ay = s.a.y, k = (s.b.y - s.a.y) / dx,
          xMin = math.min(s.a.x, s.b.x), xMax = math.max(s.a.x, s.b.x),
        }
        local c0 = math.floor((line.xMin - g.x0) / CELL)
        local c1 = math.floor((line.xMax - g.x0) / CELL)
        for c = c0, c1 do
          local xc = math.max(line.xMin, math.min(line.xMax, g.x0 + (c + 0.5) * CELL))
          local y = line.ay + (xc - line.ax) * line.k
          -- From the cell the floor runs through, up to the first open one.
          local r = math.floor((y + 0.5 - g.y0) / CELL)
          for _ = 1, 3 do
            if inside(c, r) and taken(c, r) then r = r - 1 end
          end
          if inside(c, r) and not taken(c, r) then
            g.slope[r * cols + c + 1] = line
          end
        end
      end
    end
  end

  -- The map's lava tiles (see TiledTerrain.lua's lavaTiles): the lava
  -- starts out in them, a cell short of the top (where its surface used
  -- to sit), or right to the top under more lava.
  local lavaAt = {}
  for _, t in ipairs(level.lavaTiles or {}) do lavaAt[t.x0 .. "," .. t.y0] = true end
  for _, t in ipairs(level.lavaTiles or {}) do
    local full = lavaAt[t.x0 .. "," .. (t.y0 - t.size)]
    local c0 = math.floor((t.x0 - g.x0) / CELL + 0.5)
    local r0 = math.floor((t.y0 - g.y0) / CELL + 0.5)
    local n = math.floor(t.size / CELL + 0.5)
    for r = full and r0 or r0 + 1, r0 + n - 1 do
      for c = c0, c0 + n - 1 do
        local i = r * cols + c + 1
        if inside(c, r) and not g.solid[i] then g.lava[i] = 1 end
      end
    end
  end

  shared.grid = g
end

local function cellOf(x, y)
  return math.floor((x - shared.grid.x0) / CELL), math.floor((y - shared.grid.y0) / CELL)
end

local function inGrid(c, r)
  return c >= 0 and c < shared.grid.cols and r >= 0 and r < shared.grid.rows
end

-- Closed gates (see Gate.lua) hold water back too, while they're closed.
local function gateCovers(c, r)
  -- (Called for nearly every neighbor the water looks at: no `or {}`
  -- table made each time when there are no gates.)
  local gates = state.gates
  if not gates then return false end
  local x, y = shared.grid.x0 + (c + 0.5) * CELL, shared.grid.y0 + (r + 0.5) * CELL
  for _, gate in ipairs(gates) do
    if gate.halfHeight > 1 and math.abs(x - gate.pos.x) <= gate.halfWidth
        and math.abs(y - gate.pos.y) <= gate.halfHeight then
      return true
    end
  end
  return false
end

local function isSolid(c, r)
  if r >= shared.grid.rows then return true end            -- the dome floor
  if c < 0 or c >= shared.grid.cols or r < 0 then return false end
  return shared.grid.solid[r * shared.grid.cols + c + 1] or gateCovers(c, r)
end

-- Whether water at (c, r) can't move (dc, dr) cells over: into something
-- solid, or into a floor cell from the floor's open side — against its
-- normal (down onto a ledge's top, or into a slope from the side it
-- faces). Sideways into a flat floor, or up through one, it can.
local function blocked(c, r, dc, dr)
  local nc, nr = c + dc, r + dr
  if isSolid(nc, nr) then return true end
  if nc < 0 or nc >= shared.grid.cols or nr < 0 then return false end
  local floors = shared.grid.floor[nr * shared.grid.cols + nc + 1]
  if floors then
    for _, n in ipairs(floors) do
      if n.x * dc + n.y * dr < -0.1 then return true end
    end
  end
  return false
end

-- (key: which liquid — "water", the default, or "lava".)
local function addWater(c, r, amount, key)
  if amount <= 0 or not inGrid(c, r) then return end
  local i = r * shared.grid.cols + c + 1
  local liquid = shared.grid[key or "water"]
  liquid[i] = (liquid[i] or 0) + amount
end

-- Water `w` in level cell i (column c, row r) spreading sideways along
-- whatever it's resting on (ground, or full water) — toward lower
-- neighbors, evening out into a flat surface. Returns what's left in it.
-- (liquid: WATER or LAVA — which table, and how runny.)
local function spreadSideways(i, w, c, r, liquid)
  local cols, water = shared.grid.cols, shared.grid[liquid.key]
  local resting = blocked(c, r, 0, 1) or (water[i + cols] or 0) >= 0.99
  if resting and w > liquid.minSpread then
    for k = 1, 2 do
      local dc = ((k == 1) == shared.grid.flip) and -1 or 1
      local nc = c + dc
      if nc < 0 or nc >= cols then
        w = w - w * liquid.spread -- off the map's edge: it runs away
      elseif not blocked(c, r, dc, 0) then
        local n = i + dc
        local wn = water[n] or 0
        if wn < w then
          local f = (w - wn) * liquid.spread
          water[n] = wn + f
          w = w - f
        end
      end
    end
  end
  return w
end

-- One step of the water (or lava: liquid, default WATER) moving: bottom
-- rows first, so each bit of it moves once per step — then passes - 1
-- more passes of it just spreading sideways.
local function stepWater(dt, liquid)
  liquid = liquid or WATER
  local cols, water = shared.grid.cols, shared.grid[liquid.key]
  -- Bottom rows first: sorted lowest index first, then walked from the
  -- end. (The plain sort, with no comparison function of our own, is
  -- far faster than one that calls back into Lua for every comparison.)
  local list, count = Scratch.collectCells(water)
  table.sort(list)
  shared.grid.flip = not shared.grid.flip -- which side spreads first, alternated so it doesn't lean one way

  for k = count, 1, -1 do
    local i = list[k]
    local w = water[i]
    if w then
      local r = math.floor((i - 1) / cols)
      local c = (i - 1) - r * cols

      -- Overfull (a droplet landed on a full cell): the extra goes up.
      if w > 1 and r > 0 and not blocked(c, r, 0, -1) then
        water[i - cols] = (water[i - cols] or 0) + (w - 1)
        w = 1
      end

      -- Falls into the cell below, as much as fits.
      if not blocked(c, r, 0, 1) then
        local below = water[i + cols] or 0
        local f = math.min(w, 1 - below)
        if f > 0 then
          water[i + cols] = below + f
          w = w - f
        end
      end

      w = spreadSideways(i, w, c, r, liquid)

      -- Evaporates from the surface (nothing on top of it).
      if r == 0 or not water[i - cols] then
        w = w - liquid.evaporate * dt
      end

      if w < DRY then water[i] = nil else water[i] = w end
    end
  end

  for _ = 2, liquid.passes do
    shared.grid.flip = not shared.grid.flip
    -- (Any order: only falling needs the bottom rows first.)
    list, count = Scratch.collectCells(water)
    for k = 1, count do
      local i = list[k]
      local w = water[i]
      if w then
        local r = math.floor((i - 1) / cols)
        w = spreadSideways(i, w, (i - 1) - r * cols, r, liquid)
        if w < DRY then water[i] = nil else water[i] = w end
      end
    end
  end
end

-- The water line over grid cell (c, r), if it's wet: up its column
-- through the water to the top.
local function surfaceAt(c, r)
  local water, cols = shared.grid.water, shared.grid.cols
  local i = r * cols + c + 1
  if not water[i] then return nil end
  while r > 0 and water[i - cols] do i, r = i - cols, r - 1 end
  return shared.grid.y0 + (r + 1) * CELL - math.min(1, water[i]) * CELL
end

-- Boils `amount` (cells' worth) off the surface of the water round grid
-- cell (c, r) — shared between the surface cells (nothing on top of them)
-- within BOIL_REACH_CELLS, a little higher up too, since the surface can
-- be above where a fireball got to. Returns where the surface is there
-- (for the steam), or nil once there's no water left round it.
local function boilGrid(c, r, amount)
  local water, cols = shared.grid.water, shared.grid.cols
  local cells = {}
  for dr = -BOIL_REACH_CELLS - 2, BOIL_REACH_CELLS do
    for dc = -BOIL_REACH_CELLS, BOIL_REACH_CELLS do
      local nc, nr = c + dc, r + dr
      if inGrid(nc, nr) then
        local i = nr * cols + nc + 1
        if water[i] and (nr == 0 or not water[i - cols]) then cells[#cells + 1] = { i = i, c = nc, r = nr } end
      end
    end
  end
  if #cells == 0 then return nil end
  local share = amount / #cells
  for _, cell in ipairs(cells) do
    local w = water[cell.i] - share
    if w < DRY then water[cell.i] = nil else water[cell.i] = w end
  end
  local pick = cells[math.random(#cells)]
  return shared.grid.x0 + (pick.c + math.random()) * CELL, surfaceAt(pick.c, pick.r) or (shared.grid.y0 + (pick.r + 1) * CELL)
end

return {
  cellOf = cellOf,
  inGrid = inGrid,
  isSolid = isSolid,
  blocked = blocked,
  addWater = addWater,
  stepWater = stepWater,
  surfaceAt = surfaceAt,
  boilGrid = boilGrid,
  api = WaterSystem,
}
