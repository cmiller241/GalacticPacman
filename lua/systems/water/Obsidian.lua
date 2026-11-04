-- lua/systems/water/Obsidian.lua
--
-- Lava meeting water: obsidian blocks, melting them, lava embers and glow.
-- Part of the water system: see lua/systems/WaterSystem.lua.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local Lava = require("lua.world.Lava")
local Tuning = require("lua.systems.water.Tuning")
local CELL = Tuning.CELL
local HOT_SECONDS = Tuning.HOT_SECONDS
local STEAM_BURST = Tuning.STEAM_BURST
local LAVA_TUNING = Tuning.LAVA_TUNING
local Shared = require("lua.systems.water.Shared")
local shared = Shared.shared
local Ice = Shared.Ice
local Scratch = Shared.Scratch
local LevelGrid = require("lua.systems.water.LevelGrid")
local inGrid = LevelGrid.inGrid
local isSolid = LevelGrid.isSolid
local addWater = LevelGrid.addWater
local boilGrid = LevelGrid.boilGrid
local PlanetGrids = require("lua.systems.water.PlanetGrids")
local planetPoint = PlanetGrids.planetPoint
local planetUp = PlanetGrids.planetUp
local planetIndex = PlanetGrids.planetIndex
local planetCellCenter = PlanetGrids.planetCellCenter
local planetCellOf = PlanetGrids.planetCellOf
local boilPlanetGrid = PlanetGrids.boilPlanetGrid
local Effects = require("lua.systems.water.Effects")
local spawnSteam = Effects.spawnSteam

-- Functions it adds to WaterSystem (copied on in WaterSystem.lua).
local WaterSystem = {}

----------------------------------------------------------------------
-- Lava meeting water: obsidian
----------------------------------------------------------------------
--
-- Wherever lava touches water (in the same cell, or the one beside, above
-- or below it), the whole tile the lava's in turns to an obsidian block,
-- the way Terraria's does: the lava there soaks into the block (and is
-- kept, for if it melts), the water there is pushed up out of it, and the
-- water where they met boils off in a burst of steam, a hot spot left
-- steaming a while. The block is solid ground — on the level a wall (in
-- level.walls, so Bob walks on it and bumps his head on it, fireballs hit
-- it, and the water and lava treat it as solid), on a dirt planet a clod
-- (see CrackedPlanetoid:setObsidian). Lava.lua's cooling effect plays
-- over it as it forms. A fireball melts it (see WaterSystem.meltObsidian,
-- and CrackedPlanetoid:takeHit's obsidianHits): the melting effect plays,
-- the block still solid, then it's lava again — the lava it soaked up,
-- free to run.
--
-- obsidians holds one entry per block:
--   kind = "level": tc, tr (its tile), x0, y0, size, cells (the grid
--     cells it made solid), wall (its entry in level.walls);
--   kind = "planet": g (the planet's grid), planet, ring, j (its tile);
-- and lava (cells' worth it soaked up), overlay (the Lava.lua effect
-- playing over it, while one is), melting.

local NEIGHBORS = { { 0, 0 }, { -1, 0 }, { 1, 0 }, { 0, -1 }, { 0, 1 } }

local getObsidianImage
do
  local image = nil
  getObsidianImage = function()
    if not image then
      image = love.graphics.newImage("img/obsidian.png")
      image:setFilter("nearest", "nearest")
    end
    return image
  end
end

local function removeFrom(list, item)
  for k = #list, 1, -1 do
    if list[k] == item then
      table.remove(list, k)
      return
    end
  end
end

-- A Lava.lua effect over block `entry`, drawn with the other lava (see
-- main.lua's state.lavas).
local function newOverlay(entry)
  local ov
  if entry.kind == "level" then
    ov = Lava.new(entry.x0, entry.y0, entry.size)
  else
    local ring = entry.planet.rings[entry.ring]
    local a0 = ring.offset + (entry.j - 1) * ring.step
    ov = Lava.newOnRing(entry.planet, ring.inner, ring.outer, a0, a0 + ring.step, false)
  end
  state.lavas = state.lavas or {}
  table.insert(state.lavas, ov)
  return ov
end

-- Steam off the water where it met the lava — water cell (wc, wr) of
-- planet grid pg, or of the level's grid if pg is nil — boiling some of
-- it off, and a hot spot left there. (fx, fy): where it puffs from
-- instead, and (ux, uy) which way's up there, if there's no water left
-- to come off.
local function steamWhereMet(pg, wc, wr, fx, fy, ux, uy)
  local sx, sy, upX, upY
  if pg then
    sx, sy, upX, upY = boilPlanetGrid(pg, wc, wr, LAVA_TUNING.BOIL)
  else
    sx, sy = boilGrid(wc, wr, LAVA_TUNING.BOIL)
    upX, upY = 0, -1
  end
  if not sx then sx, sy, upX, upY = fx, fy, ux, uy end
  for _ = 1, STEAM_BURST do spawnSteam(sx, sy, upX, upY, 1.0) end
  shared.hotSpots[#shared.hotSpots + 1] = { pg = pg, c = wc, r = wr, life = HOT_SECONDS, steamBudget = 0 }
end

-- The level's tile (tc, tr) turned to obsidian, where lava in it met
-- water in cell (wc, wr).
local function hardenLevelTile(tc, tr, wc, wr)
  local g = shared.grid
  local cols, size = g.cols, LAVA_TUNING.TILE_CELLS * CELL
  local x0, y0 = g.x0 + tc * size, g.y0 + tr * size
  local r0 = tr * LAVA_TUNING.TILE_CELLS
  local soaked, cells = 0, {}
  for r = r0, r0 + LAVA_TUNING.TILE_CELLS - 1 do
    for c = tc * LAVA_TUNING.TILE_CELLS, tc * LAVA_TUNING.TILE_CELLS + LAVA_TUNING.TILE_CELLS - 1 do
      local i = r * cols + c + 1
      if inGrid(c, r) and not g.solid[i] then
        soaked = soaked + (g.lava[i] or 0)
        g.lava[i] = nil
        local w = g.water[i]
        if w then
          -- (Pushed up out of it, into the cell just over the block.)
          g.water[i] = nil
          if r0 > 0 and not isSolid(c, r0 - 1) then addWater(c, r0 - 1, w) end
        end
        g.solid[i] = true
        cells[#cells + 1] = i
      end
    end
  end

  local wall = {
    pos = Vector2.new(x0 + size / 2, y0 + size / 2),
    halfWidth = size / 2, halfHeight = size / 2,
    radius = size * 0.7071067811865476,
    isWall = true,
  }
  table.insert(g.level.walls, wall)
  Ice.addTop(wall) -- (a walkable top — see Ice.addTop)
  local entry = {
    kind = "level", tc = tc, tr = tr, x0 = x0, y0 = y0, size = size, cells = cells, wall = wall, lava = soaked,
  }
  wall.obsidian = entry
  entry.overlay = newOverlay(entry)
  entry.overlay:harden()
  shared.obsidians[#shared.obsidians + 1] = entry

  -- If he's in it, he's lifted out on top of it.
  local p = state.player
  if p then
    local qx = math.max(x0, math.min(p.pos.x, x0 + size))
    local qy = math.max(y0, math.min(p.pos.y, y0 + size))
    if (p.pos.x - qx) ^ 2 + (p.pos.y - qy) ^ 2 < p.radius * p.radius then
      p.pos.y = y0 - p.radius - 1
    end
  end

  steamWhereMet(nil, wc, wr, x0 + size / 2, y0, 0, -1)
end

-- The cells of planet grid g whose middles are in ring i's tile j (on
-- whichever layout it has), as { i, r } — deepest first.
local function planetTileCells(g, i, j)
  local p = g.planet
  local ring = p.rings[i]
  local a = ring.offset + (j - 0.5) * ring.step + p.rotationAngle
  local c0, r0 = planetCellOf(g, p.pos.x + math.cos(a) * ring.mid, p.pos.y + math.sin(a) * ring.mid)
  local list = {}
  local reach = LAVA_TUNING.TILE_CELLS + 2
  for r = r0 - reach, r0 + reach do
    for k = c0 - reach, c0 + reach do
      local idx = planetIndex(g, k, r)
      if idx then
        local c = (idx - 1) - r * g.cols
        local ti, tj = p:tileAtLocal(planetCellCenter(g, c, r))
        if ti == i and tj == j then list[#list + 1] = { i = idx, r = r } end
      end
    end
  end
  table.sort(list, function(a1, b1) return a1.r > b1.r end)
  return list
end

-- Planet grid g's planet's tile (ring i, tile j) turned to obsidian,
-- where lava in it met water in cell (wc, wr).
local function hardenPlanetTile(g, i, j, wc, wr)
  local p = g.planet
  local soaked = 0
  for _, cell in ipairs(planetTileCells(g, i, j)) do
    soaked = soaked + (g.lava[cell.i] or 0)
    g.lava[cell.i] = nil
  end
  -- (Its water's pushed up out of it once the grid sees the block — see
  -- catchUpPlanetGrid.)
  p:setObsidian(i, j, true)
  local entry = { kind = "planet", g = g, planet = p, ring = i, j = j, lava = soaked }
  entry.overlay = newOverlay(entry)
  entry.overlay:harden()
  shared.obsidians[#shared.obsidians + 1] = entry

  local ring = p.rings[i]
  local a = ring.offset + (j - 0.5) * ring.step + p.rotationAngle
  local ux, uy = math.cos(a), math.sin(a)
  steamWhereMet(g, wc, wr, p.pos.x + ux * ring.outer, p.pos.y + uy * ring.outer, ux, uy)
end

-- Lava touching water anywhere on the level: the tile each such bit of
-- lava is in turns to obsidian.
local function quenchLevelLava()
  local g = shared.grid
  local cols, lava, water = g.cols, g.lava, g.water
  if not next(lava) or not next(water) then return end
  local hits = {}
  for i, l in pairs(lava) do
    if l >= LAVA_TUNING.TOUCH then
      local r = math.floor((i - 1) / cols)
      local c = (i - 1) - r * cols
      for _, d in ipairs(NEIGHBORS) do
        local nc, nr = c + d[1], r + d[2]
        if inGrid(nc, nr) and (water[nr * cols + nc + 1] or 0) >= LAVA_TUNING.TOUCH then
          hits[#hits + 1] = { i = i, c = c, r = r, wc = nc, wr = nr }
          break
        end
      end
    end
  end
  for _, h in ipairs(hits) do
    if lava[h.i] then -- (not soaked into a block made just now)
      hardenLevelTile(math.floor(h.c / LAVA_TUNING.TILE_CELLS), math.floor(h.r / LAVA_TUNING.TILE_CELLS), h.wc, h.wr)
    end
  end
end

-- The same on planet grid g.
local function quenchPlanetLava(g)
  local cols, lava, water, p = g.cols, g.lava, g.water, g.planet
  if not next(lava) or not next(water) then return end
  local hits = {}
  for i, l in pairs(lava) do
    if l >= LAVA_TUNING.TOUCH then
      local r = math.floor((i - 1) / cols)
      local c = (i - 1) - r * cols
      for _, d in ipairs(NEIGHBORS) do
        local ni = planetIndex(g, c + d[1], r + d[2])
        if ni and (water[ni] or 0) >= LAVA_TUNING.TOUCH then
          hits[#hits + 1] = { i = i, c = c, r = r, wc = (ni - 1) % cols, wr = r + d[2] }
          break
        end
      end
    end
  end
  for _, h in ipairs(hits) do
    if lava[h.i] then
      local ti, tj = p:tileAtLocal(planetCellCenter(g, h.c, h.r))
      if ti and not p.rings[ti].clods[tj] then
        hardenPlanetTile(g, ti, tj, h.wc, h.wr)
      else
        -- (Lava up over the planet's tiles, or not yet out of one that's
        -- just gone solid: there's no tile for a block, so it just goes
        -- out in a puff of steam.)
        lava[h.i] = nil
        local lx, ly = planetCellCenter(g, h.c, h.r)
        local ux, uy = planetUp(g, lx, ly)
        steamWhereMet(g, h.wc, h.wr, p.pos.x + lx, p.pos.y + ly, ux, uy)
      end
    end
  end
end

-- Starts block `entry` melting (see above).
local function startMelt(entry)
  if entry.melting then return end
  entry.melting = true
  local ov = entry.overlay
  if not ov then
    ov = newOverlay(entry)
    ov.hardened, ov.cool = true, 1
    entry.overlay = ov
  end
  ov:melt()
end

-- A fireball's hit a wall on the level (wall: its entry in level.walls —
-- see main.lua's fireball passes): an obsidian block starts melting back
-- into lava; an ice block (or an Ooomba's ice cube) melts into water
-- (see "Ice"). Any other wall, it does nothing.
function WaterSystem.fireHitsWall(wall)
  if not wall then return end
  if wall.obsidian then startMelt(wall.obsidian) end
  if wall.ice then Ice.melt(wall.ice) end
end
WaterSystem.meltObsidian = WaterSystem.fireHitsWall

-- `amount` cells' worth of lava poured into `cells` ({ i, r }, deepest
-- first) of liquid table `lava`: each row filled before the one over it.
local function pourLava(lava, cells, amount)
  local k = 1
  while k <= #cells and amount > 0 do
    local r, n = cells[k].r, 0
    while cells[k + n] and cells[k + n].r == r do n = n + 1 end
    local each = math.min(1, amount / n)
    for m = k, k + n - 1 do lava[cells[m].i] = (lava[cells[m].i] or 0) + each end
    amount = amount - each * n
    k = k + n
  end
end

-- Block `entry`'s finished melting: it's lava again — the lava it soaked
-- up, poured back into its cells, free to run.
local function finishMelt(entry)
  if entry.kind == "level" then
    local g = shared.grid
    if not g then return end
    local cells = {}
    for _, i in ipairs(entry.cells) do
      g.solid[i] = nil
      cells[#cells + 1] = { i = i, r = math.floor((i - 1) / g.cols) }
    end
    removeFrom(g.level.walls, entry.wall)
    Ice.removeTop(entry.wall)
    table.sort(cells, function(a1, b1) return a1.r > b1.r end)
    pourLava(g.lava, cells, entry.lava)
  else
    entry.planet:setObsidian(entry.ring, entry.j, false)
    pourLava(entry.g.lava, planetTileCells(entry.g, entry.ring, entry.j), entry.lava)
  end
end

-- The blocks' effects playing out: one done forming leaves the block on
-- its own; one done melting is lava again. And blocks on a planet a
-- fireball's hit (see CrackedPlanetoid:takeHit) start melting — obsidian
-- back into lava, ice into water (see "Ice").
local function updateObsidians()
  for _, g in pairs(shared.planetGrids) do
    local hitList = g.planet.blockHits
    if hitList then
      for _, h in ipairs(hitList) do
        for _, e in ipairs(shared.obsidians) do
          if e.planet == g.planet and e.ring == h.ring and e.j == h.j then startMelt(e) end
        end
        for k = #Ice.blocks, 1, -1 do
          local e = Ice.blocks[k]
          if e and e.planet == g.planet and e.ring == h.ring and e.j == h.j then Ice.melt(e) end
        end
      end
      g.planet.blockHits = nil
    end
  end

  for k = #shared.obsidians, 1, -1 do
    local e = shared.obsidians[k]
    local ov = e.overlay
    if ov then
      if e.melting then
        if ov.coolDir == 0 and ov.cool <= 0 then
          removeFrom(state.lavas or {}, ov)
          e.overlay = nil
          finishMelt(e)
          table.remove(shared.obsidians, k)
        end
      elseif ov.cool >= 1 then
        removeFrom(state.lavas or {}, ov)
        e.overlay = nil
      end
    end
  end
end

-- Every cell of the lava's surface (lava with none on top of it) near
-- the screen: fn(x, y, upX, upY, c, r, g, amount) — its point on the surface,
-- which way is up there, its cell (g: its planet grid, or nil for
-- the level's), and how much lava's in it.
local function forEachLavaSurface(fn)
  local cam = state.camera
  if not cam then return end
  local m = CELL * 8
  local vx0, vy0 = cam.x - m, cam.y - m
  local vx1, vy1 = cam.x + (state.visibleWidth or 0) + m, cam.y + (state.visibleHeight or 0) + m
  if shared.grid then
    local cols, lava = shared.grid.cols, shared.grid.lava
    for i, l in pairs(lava) do
      if not lava[i - cols] then
        local r = math.floor((i - 1) / cols)
        local c = (i - 1) - r * cols
        local x = shared.grid.x0 + (c + 0.5) * CELL
        local y = shared.grid.y0 + (r + 1) * CELL - math.min(1, l) * CELL
        if x > vx0 and x < vx1 and y > vy0 and y < vy1 then fn(x, y, 0, -1, c, r, nil, l) end
      end
    end
  end
  for _, g in pairs(shared.planetGrids) do
    local cols, lava = g.cols, g.lava
    local px, py = g.planet.pos.x, g.planet.pos.y
    for i, l in pairs(lava) do
      if not lava[i - cols] then
        local r = math.floor((i - 1) / cols)
        local c = (i - 1) - r * cols
        local lx, ly = planetPoint(g, c + 0.5, g.top - (r + 1) * CELL + math.min(1, l) * CELL)
        local x, y = px + lx, py + ly
        if x > vx0 and x < vx1 and y > vy0 and y < vy1 then
          local ux, uy = planetUp(g, lx, ly)
          fn(x, y, ux, uy, c, r, g, l)
        end
      end
    end
  end
end

-- Embers off the lava's surface (as Lava.lua's own), drifting up and
-- fading.
local function updateLavaEmbers()
  local ts = state.timeScale or 1
  forEachLavaSurface(function(x, y, ux, uy, _, _, _, amount)
    if math.random() < LAVA_TUNING.EMBER_CHANCE * math.min(1, amount) * ts then
      local speed = LAVA_TUNING.EMBER_RISE_MIN + math.random() * (LAVA_TUNING.EMBER_RISE_MAX - LAVA_TUNING.EMBER_RISE_MIN)
      local drift = (math.random() * 2 - 1) * LAVA_TUNING.EMBER_DRIFT
      local along = (math.random() - 0.5) * CELL
      local life = LAVA_TUNING.EMBER_LIFE_MIN + math.random() * (LAVA_TUNING.EMBER_LIFE_MAX - LAVA_TUNING.EMBER_LIFE_MIN)
      shared.lavaEmbers[#shared.lavaEmbers + 1] = {
        x = x - uy * along, y = y + ux * along,
        vx = -uy * drift + ux * speed, vy = ux * drift + uy * speed,
        life = 1, decay = 1 / life,
        radius = LAVA_TUNING.EMBER_RADIUS_MIN + math.random() * (LAVA_TUNING.EMBER_RADIUS_MAX - LAVA_TUNING.EMBER_RADIUS_MIN),
      }
    end
  end)
  local gone
  for k = #shared.lavaEmbers, 1, -1 do
    local e = shared.lavaEmbers[k]
    e.x, e.y = e.x + e.vx * ts, e.y + e.vy * ts
    e.life = e.life - e.decay * ts / 60
    if e.life <= 0 then gone = gone or {}; gone[e] = true end
  end
  if gone then Scratch.removeMarked(shared.lavaEmbers, gone) end
end

-- Where the lava glows (see TileGlow.lua): fn(x, y) once for each tile's
-- worth of its surface near the screen.
function WaterSystem.forEachLavaGlow(fn)
  local buckets = {}
  forEachLavaSurface(function(x, y, _, _, c, r, g)
    local byGrid = buckets[g or "level"]
    if not byGrid then
      byGrid = {}
      buckets[g or "level"] = byGrid
    end
    local key = math.floor(c / LAVA_TUNING.TILE_CELLS) * 100000 + math.floor(r / LAVA_TUNING.TILE_CELLS)
    local b = byGrid[key]
    if not b then
      b = { x = 0, y = 0, n = 0 }
      byGrid[key] = b
    end
    b.x, b.y, b.n = b.x + x, b.y + y, b.n + 1
  end)
  for _, byGrid in pairs(buckets) do
    for _, b in pairs(byGrid) do fn(b.x / b.n, b.y / b.n) end
  end
end

return {
  getObsidianImage = getObsidianImage,
  removeFrom = removeFrom,
  planetTileCells = planetTileCells,
  quenchLevelLava = quenchLevelLava,
  quenchPlanetLava = quenchPlanetLava,
  pourLava = pourLava,
  updateObsidians = updateObsidians,
  updateLavaEmbers = updateLavaEmbers,
  api = WaterSystem,
}
