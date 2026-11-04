-- lua/systems/water/PlanetGrids.lua
--
-- Water on a dirt planet: a grid of the planet's own, bent round it.
-- Part of the water system: see lua/systems/WaterSystem.lua.

local Tuning = require("lua.systems.water.Tuning")
local CELL = Tuning.CELL
local DRY = Tuning.DRY
local BOIL_REACH_CELLS = Tuning.BOIL_REACH_CELLS
local Shared = require("lua.systems.water.Shared")
local shared = Shared.shared
local Scratch = Shared.Scratch
local WATER = Shared.WATER

----------------------------------------------------------------------
-- Water on a dirt planet (CrackedPlanetoid.lua — one built from a Tiled
-- map, say)
----------------------------------------------------------------------
--
-- The same water as on the level, on a grid of its own bent round the
-- planet: columns going round it, rows going in toward its center, each
-- cell CELL deep (a 64-unit tile is 4 rows) and PLANET_CELLS_PER_TILE
-- across a tile. "Down" is toward the center, so water falls inward,
-- spreads round along whatever it's resting on, runs down slopes and
-- curves a cell at a time, gathers in pits, caves and tunnels, and
-- evaporates off the top — the same rules stepWater uses, the grid
-- wrapping all the way round. A few rows of open air above the surface
-- (PLANET_ROWS_ABOVE) let it puddle on top too. Solid is whatever the
-- planet itself says is solid at a cell's middle, so its shaped tiles
-- hold water exactly where their art is; when a shot blows dirt out
-- (see CrackedPlanetoid:takeHit's dirtChanges), the cells there open up.
--
-- When the planet's gravity is switched to straight down or up the
-- screen (see CrackedPlanetoid:cycleGravity), the water moves onto a
-- second layout of the grid: flat, square cells over the whole planet,
-- rows running the way gravity pulls (row 0 the highest), so pools lie
-- level across the screen. Water that runs off its edges, or falls
-- past its bottom, is gone into space. Switching back moves it back
-- (see convertPlanetGrid). Both layouts measure a cell's height the
-- same way — its distance "up" (out from the center, or up the
-- screen) — so the rest of the code here works on either.
--
-- A turning planet (see CrackedPlanetoid:toggleSpin — either way) takes the round
-- layout round with it, water and all — its cells stay put on the dirt.
-- The flat layout stays put, so its cells are looked at again as the
-- dirt turns through them (FLAT_SWEEP_ROWS rows a frame), and water in
-- a cell the dirt turns into is pushed up out of it.

local PLANET_CELLS_PER_TILE = 4  -- across a tile, round the planet
local PLANET_ROWS_ABOVE = 4      -- rows of open air over its surface, for water lying on top
local PLANET_GRID_MAKE_DISTANCE = 3000 -- how near its surface he has to come for its grid to be made
local FLAT_SWEEP_ROWS = 16       -- rows of a turning planet's flat layout looked at again each frame
local TWO_PI = math.pi * 2

-- Keyed by planet (weakly, like oceans).
local function planetGridsReset()
  shared.planetGrids = setmetatable({}, { __mode = "k" })
end

-- Local point (planet-relative) at column position f (a fraction of
-- columns: c + 0.5 is column c's middle) and height h.
local function planetPoint(g, f, h)
  if g.flat then return -g.top + f * CELL, -g.s * h end
  local a = g.a0 + g.planet.rotationAngle + f * g.dA
  return math.cos(a) * h, math.sin(a) * h
end

-- "Up" (a unit vector) at local point (lx, ly).
local function planetUp(g, lx, ly)
  if g.flat then return 0, -g.s end
  local r = math.sqrt(lx * lx + ly * ly)
  if r < 1e-6 then return 0, -1 end
  return lx / r, ly / r
end

-- How wide a column is at height h.
local function planetColWidth(g, h)
  if g.flat then return CELL end
  return g.dA * math.max(h, 1)
end

-- Column c, wrapped round the planet — or, on the flat layout, nil off
-- its edges.
local function planetCol(g, c)
  if g.flat then
    if c < 0 or c >= g.cols then return nil end
    return c
  end
  return c % g.cols
end

-- Cell (c, r)'s index in the grid, or nil if it's outside it.
local function planetIndex(g, c, r)
  if r < 0 or r >= g.rows then return nil end
  c = planetCol(g, c)
  if not c then return nil end
  return r * g.cols + c + 1
end

local function planetCellCenter(g, c, r)
  return planetPoint(g, c + 0.5, g.top - (r + 0.5) * CELL)
end

-- Works out whether each cell of the grid (or just those in column range
-- c0..c1, rows r0..r1) is solid, from the planet.
local function refreshPlanetSolid(g, c0, c1, r0, r1)
  local p = g.planet
  local reach2 = (p.radius + CELL) ^ 2
  for r = math.max(0, r0), math.min(g.rows - 1, r1) do
    for k = c0, c1 do
      local c = planetCol(g, k)
      if c then
        local x, y = planetCellCenter(g, c, r)
        local i = r * g.cols + c + 1
        g.solid[i] = (x * x + y * y < reach2 and p:solidAtLocal(x, y)) or nil
        -- (Dirt's come into it — turned into it: the water's, and the
        -- lava's, pushed up.)
        for _, liquid in ipairs(g.solid[i] and { g.water, g.lava } or {}) do
          local w = liquid[i]
          if w then
            liquid[i] = nil
            local up = i - g.cols
            if r > 0 and not g.solid[up] then liquid[up] = (liquid[up] or 0) + w end
          end
        end
      end
    end
  end
end

-- Lays grid g out for gravity mode `mode`: round the planet ("core"),
-- or flat ("down", "up"). Empty, and solid worked out afresh.
local function layOutPlanetGrid(g, mode)
  local p = g.planet
  local top = p.radius + PLANET_ROWS_ABOVE * CELL
  g.mode, g.top, g.solid, g.water, g.lava = mode, top, {}, {}, {}
  if mode == "down" or mode == "up" then
    local n = math.ceil(2 * top / CELL)
    g.flat, g.s = true, (mode == "up") and -1 or 1
    g.cols, g.rows = n, n
    g.a0, g.dA = nil, nil
  else
    local ring = p.rings[1]
    g.flat, g.s = false, nil
    g.cols = ring.count * PLANET_CELLS_PER_TILE
    g.rows = math.ceil((top - p.coreRadius) / CELL)
    g.a0, g.dA = ring.offset, TWO_PI / g.cols
  end
  refreshPlanetSolid(g, 0, g.cols - 1, 0, g.rows - 1)
  g.solidAngle, g.sweepRow, g.sweepLeft = p.rotationAngle, 0, 0
end

-- The flat layout of a turning planet: a few more of its rows looked at
-- again (see above), round and round for as long as it's turning, and
-- once all the way through after it stops.
local function sweepTurningPlanetGrid(g)
  if not g.flat then return end
  local a = g.planet.rotationAngle
  if a ~= g.solidAngle then g.solidAngle, g.sweepLeft = a, g.rows end
  if g.sweepLeft <= 0 then return end
  local n = math.min(FLAT_SWEEP_ROWS, g.sweepLeft)
  for k = 0, n - 1 do
    local r = (g.sweepRow + k) % g.rows
    refreshPlanetSolid(g, 0, g.cols - 1, r, r)
  end
  g.sweepRow = (g.sweepRow + n) % g.rows
  g.sweepLeft = g.sweepLeft - n
end

local function newPlanetGrid(p)
  local g = { planet = p, flip = false, changesSeen = #(p.dirtChanges or {}) }
  layOutPlanetGrid(g, "core")
  local cols, top = g.cols, g.top

  -- Every open cell whose middle is in ring `ringIndex`'s tile j filled
  -- with `liquid` — all but its top row, if skipTop.
  local function fillTile(ringIndex, j, liquid, skipTop)
    local wring = p.rings[ringIndex]
    local ta0 = wring.offset + (j - 1) * wring.step
    local c0 = math.floor((ta0 - g.a0) / g.dA) - 1
    local c1 = math.floor((ta0 + wring.step - g.a0) / g.dA) + 1
    local r0 = math.floor((top - wring.outer) / CELL)
    local r1 = math.floor((top - wring.inner) / CELL)
    for r = math.max(0, r0), math.min(g.rows - 1, r1) do
      local rr = top - (r + 0.5) * CELL
      if rr >= wring.inner and rr < wring.outer and not (skipTop and rr >= wring.outer - CELL) then
        for k = c0, c1 do
          local c = k % cols
          local u = ((g.a0 + (c + 0.5) * g.dA - ta0) % TWO_PI) / wring.step
          local i = r * cols + c + 1
          if u < 1 and not g.solid[i] then liquid[i] = 1 end
        end
      end
    end
  end

  -- The map's water tiles (see CrackedPlanetoid.fromTiledMap) start out
  -- full; its lava tiles a cell short of the top (where its surface used
  -- to sit), or right to the top under more lava.
  for _, wt in ipairs(p.waterTiles or {}) do fillTile(wt.ring, wt.j, g.water, false) end
  for _, lt in ipairs(p.lavaTiles or {}) do fillTile(lt.ring, lt.j, g.lava, not lt.full) end
  return g
end

-- Which cell (column, row) world point (x, y) is in, and its height (see
-- above). Rows run from 0 at the top of the grid; round the planet, one
-- past the bottom is the core, one above the top is open space. (The
-- column can be off the flat layout's edges: see planetIndex.)
local function planetCellOf(g, x, y)
  local lx, ly = x - g.planet.pos.x, y - g.planet.pos.y
  if g.flat then
    local h = -g.s * ly
    return math.floor((lx + g.top) / CELL), math.floor((g.top - h) / CELL), h
  end
  local rr = math.sqrt(lx * lx + ly * ly)
  local c = math.floor(((math.atan2(ly, lx) - g.a0 - g.planet.rotationAngle) % TWO_PI) / g.dA) % g.cols
  return c, math.floor((g.top - rr) / CELL), rr
end

-- Dirt that's been blown out since the grid last looked (see
-- CrackedPlanetoid:takeHit): its cells opened up.
local function catchUpPlanetGrid(g)
  local changes = g.planet.dirtChanges
  if not changes then return end
  for k = g.changesSeen + 1, #changes do
    local ch = changes[k]
    local ring = g.planet.rings[ch.ring]
    local a0 = ring.offset + (ch.j - 1) * ring.step
    if g.flat then
      -- (Round the clod's corners and the middle of its outside.)
      local px, py = g.planet.pos.x, g.planet.pos.y
      local turn = g.planet.rotationAngle
      local c0, c1, r0, r1 = math.huge, -math.huge, math.huge, -math.huge
      for _, a in ipairs({ a0, a0 + ring.step / 2, a0 + ring.step }) do
        for _, rr in ipairs({ ring.inner, ring.outer }) do
          local c, r = planetCellOf(g, px + math.cos(a + turn) * rr, py + math.sin(a + turn) * rr)
          c0, c1, r0, r1 = math.min(c0, c), math.max(c1, c), math.min(r0, r), math.max(r1, r)
        end
      end
      refreshPlanetSolid(g, c0 - 1, c1 + 1, r0 - 1, r1 + 1)
    else
      local c0 = math.floor((a0 - g.a0) / g.dA) - 1
      local c1 = math.floor((a0 + ring.step - g.a0) / g.dA) + 1
      local r0 = math.floor((g.top - ring.outer) / CELL) - 1
      local r1 = math.floor((g.top - ring.inner) / CELL) + 1
      refreshPlanetSolid(g, c0, c1, r0, r1)
    end
  end
  g.changesSeen = #changes
end

local function planetSolid(g, c, r)
  if g.flat then
    local i = planetIndex(g, c, r)
    return i ~= nil and g.solid[i] == true
  end
  if r >= g.rows then return true end -- (the core)
  if r < 0 then return false end
  return g.solid[r * g.cols + (c % g.cols) + 1] == true
end

-- (key: which liquid — "water", the default, or "lava".)
local function addPlanetWater(g, c, r, amount, key)
  if amount <= 0 then return end
  local i = planetIndex(g, c, r)
  if not i then return end
  local liquid = g[key or "water"]
  liquid[i] = (liquid[i] or 0) + amount
end

-- The planet's gravity has been switched (see
-- CrackedPlanetoid:cycleGravity): grid g laid out the new way, its water
-- moved over — each cell's water into whichever new cell its middle is
-- in, the same amount of water (by area). Where that's solid (the two
-- layouts' cells don't line up), into the open cell over it.
local function convertPlanetGrid(g, mode)
  local old = {
    planet = g.planet, flat = g.flat, s = g.s, top = g.top, cols = g.cols, a0 = g.a0, dA = g.dA,
    water = g.water, lava = g.lava,
  }
  layOutPlanetGrid(g, mode)
  local px, py = g.planet.pos.x, g.planet.pos.y
  -- (The lava moved over the same way.)
  for _, key in ipairs({ "water", "lava" }) do
    for i, w in pairs(old[key]) do
      local r = math.floor((i - 1) / old.cols)
      local c = (i - 1) - r * old.cols
      local h = old.top - (r + 0.5) * CELL
      local lx, ly = planetPoint(old, c + 0.5, h)
      local nc, nr, nh = planetCellOf(g, px + lx, py + ly)
      local amount = w * planetColWidth(old, h) / planetColWidth(g, nh)
      for _ = 1, 3 do
        if not planetSolid(g, nc, nr) then break end
        nr = nr - 1
      end
      local ni = planetIndex(g, nc, nr)
      if ni and not planetSolid(g, nc, nr) and amount > 0 then g[key][ni] = (g[key][ni] or 0) + amount end
    end
  end
end

-- The planet grid point (x, y) is in, if any: within its top row of any
-- planet that has one.
local function planetGridAt(x, y)
  for _, g in pairs(shared.planetGrids) do
    local dx, dy = x - g.planet.pos.x, y - g.planet.pos.y
    if dx * dx + dy * dy < g.top * g.top then return g end
  end
  return nil
end

-- Water `w` in planet grid g's cell i (column c, row r) spreading round
-- along whatever it's resting on — spreadSideways, for a planet's grid
-- (the columns wrapping all the way round; off the flat layout's edges,
-- it runs away). Returns what's left in it.
local function spreadPlanetSideways(g, i, w, c, r, liquid)
  local cols, water = g.cols, g[liquid.key]
  local resting = planetSolid(g, c, r + 1) or (water[i + cols] or 0) >= 0.99
  if resting and w > liquid.minSpread then
    for k = 1, 2 do
      local dc = ((k == 1) == g.flip) and -1 or 1
      local nc = planetCol(g, c + dc)
      if not nc then
        w = w - w * liquid.spread
      elseif not planetSolid(g, nc, r) then
        local n = r * cols + nc + 1
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

-- One step of a planet's water (or lava: liquid, default WATER) moving —
-- stepWater's rules, with "down" toward the center (or down the flat
-- layout's rows) and the columns wrapping all the way round.
local function stepPlanetWater(g, dt, liquid)
  liquid = liquid or WATER
  local cols, water = g.cols, g[liquid.key]
  -- (Lowest rows first: see stepWater.)
  local list, count = Scratch.collectCells(water)
  table.sort(list)
  g.flip = not g.flip

  for k = count, 1, -1 do
    local i = list[k]
    local w = water[i]
    if w then
      local r = math.floor((i - 1) / cols)
      local c = (i - 1) - r * cols

      if w > 1 and r > 0 and not planetSolid(g, c, r - 1) then
        water[i - cols] = (water[i - cols] or 0) + (w - 1)
        w = 1
      end

      if g.flat and r == g.rows - 1 then
        w = 0 -- (falling out of the bottom of the grid: gone into space)
      elseif not planetSolid(g, c, r + 1) then
        local below = water[i + cols] or 0
        local f = math.min(w, 1 - below)
        if f > 0 then
          water[i + cols] = below + f
          w = w - f
        end
      end

      w = spreadPlanetSideways(g, i, w, c, r, liquid)

      if r == 0 or not water[i - cols] then
        w = w - liquid.evaporate * dt
      end

      if w < DRY then water[i] = nil else water[i] = w end
    end
  end

  for _ = 2, liquid.passes do
    g.flip = not g.flip
    -- (Any order: only falling needs the bottom rows first.)
    list, count = Scratch.collectCells(water)
    for k = 1, count do
      local i = list[k]
      local w = water[i]
      if w then
        local r = math.floor((i - 1) / cols)
        w = spreadPlanetSideways(g, i, w, (i - 1) - r * cols, r, liquid)
        if w < DRY then water[i] = nil else water[i] = w end
      end
    end
  end
end

-- How high the water's surface is over cell (c, r), if it's wet: up its
-- column through the water to the top.
local function planetSurfaceAt(g, c, r)
  local water, cols = g.water, g.cols
  local i = r * cols + c + 1
  if not water[i] then return nil end
  while r > 0 and water[i - cols] do i, r = i - cols, r - 1 end
  return g.top - (r + 1) * CELL + math.min(1, water[i]) * CELL
end

-- Boils `amount` off the surface round cell (c, r) (the same as
-- boilGrid, for a planet's grid). Returns a point on the surface there
-- and which way is up from it, or nil once there's no water left round it.
local function boilPlanetGrid(g, c, r, amount)
  local water, cols = g.water, g.cols
  local cells = {}
  for dr = -BOIL_REACH_CELLS - 2, BOIL_REACH_CELLS do
    for dc = -BOIL_REACH_CELLS, BOIL_REACH_CELLS do
      local nc, nr = planetCol(g, c + dc), r + dr
      if nc and nr >= 0 and nr < g.rows then
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
  local h = planetSurfaceAt(g, pick.c, pick.r) or (g.top - (pick.r + 1) * CELL)
  local lx, ly = planetPoint(g, pick.c + math.random(), h)
  local ux, uy = planetUp(g, lx, ly)
  return g.planet.pos.x + lx, g.planet.pos.y + ly, ux, uy
end

return {
  PLANET_GRID_MAKE_DISTANCE = PLANET_GRID_MAKE_DISTANCE,
  planetGridsReset = planetGridsReset,
  planetPoint = planetPoint,
  planetUp = planetUp,
  planetColWidth = planetColWidth,
  planetCol = planetCol,
  planetIndex = planetIndex,
  planetCellCenter = planetCellCenter,
  sweepTurningPlanetGrid = sweepTurningPlanetGrid,
  newPlanetGrid = newPlanetGrid,
  planetCellOf = planetCellOf,
  catchUpPlanetGrid = catchUpPlanetGrid,
  planetSolid = planetSolid,
  addPlanetWater = addPlanetWater,
  convertPlanetGrid = convertPlanetGrid,
  planetGridAt = planetGridAt,
  stepPlanetWater = stepPlanetWater,
  planetSurfaceAt = planetSurfaceAt,
  boilPlanetGrid = boilPlanetGrid,
}
