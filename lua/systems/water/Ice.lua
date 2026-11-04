-- lua/systems/water/Ice.lua
--
-- Ice: the ice blaster freezing water into blocks, and the blocks melting,
-- moving and floating.
-- Part of the water system: see lua/systems/WaterSystem.lua.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local Tuning = require("lua.systems.water.Tuning")
local CELL = Tuning.CELL
local QUENCH_AT = Tuning.QUENCH_AT
local STEAM_BURST = Tuning.STEAM_BURST
local LAVA_TUNING = Tuning.LAVA_TUNING
local Shared = require("lua.systems.water.Shared")
local shared = Shared.shared
local Ice = Shared.Ice
local LevelGrid = require("lua.systems.water.LevelGrid")
local cellOf = LevelGrid.cellOf
local inGrid = LevelGrid.inGrid
local isSolid = LevelGrid.isSolid
local blocked = LevelGrid.blocked
local addWater = LevelGrid.addWater
local PlanetGrids = require("lua.systems.water.PlanetGrids")
local planetIndex = PlanetGrids.planetIndex
local planetCellCenter = PlanetGrids.planetCellCenter
local planetCellOf = PlanetGrids.planetCellOf
local planetGridAt = PlanetGrids.planetGridAt
local Effects = require("lua.systems.water.Effects")
local spawnSplash = Effects.spawnSplash
local spawnSteam = Effects.spawnSteam
local Obsidian = require("lua.systems.water.Obsidian")
local removeFrom = Obsidian.removeFrom
local planetTileCells = Obsidian.planetTileCells
local pourLava = Obsidian.pourLava

-- Functions it adds to WaterSystem (copied on in WaterSystem.lua).
local WaterSystem = {}

----------------------------------------------------------------------
-- Ice
----------------------------------------------------------------------
--
-- The ice blaster's bolts (see lua/entities/IceBolt.lua and
-- WaterSystem.iceBoltHit):
--   * into water: a block of ice a tile across (Ice.TUNING.SIZE cells)
--     freezes there, out of the water round where it hit — the water's
--     kept, for when it melts. On the level it's a wall (in level.walls,
--     so Bob bumps into it and fireballs hit it, and the water flows
--     round it) with a walkable top (Ice.addTop), and it's slippery (see
--     Player:move). On a dirt planet it's an ice tile (see
--     CrackedPlanetoid:setBlock).
--   * into lava: the bolt turns to water there (Ice.TUNING.LAVA_WATER),
--     so the lava turns to obsidian (see "Lava meeting water").
--   * into an Ooomba: it's frozen in an ice cube (Ice.encase) — stock
--     still and harmless, and on the level's terrain, a block to stand on.
-- Ice floats: a block sunk in water rises a cell at a time (the water
-- flowing in under it) until it's riding at the surface, a quarter of it
-- out; with nothing at all under it, it drops. (On a dirt planet, a whole tile at a time — its tiles are a
-- ring deep.) A fireball melts it — and lava meeting it does too — into a
-- splash of water and steam (Ice.melt): a frozen Ooomba's freed, and walks
-- on.
--
-- Ice.blocks holds one entry per block:
--   kind = "level": c0, r0 (its top-left cell), x0, y0, size, wall;
--   kind = "planet": g (the planet's grid), planet, ring, j (its tile);
--   kind = "ooomba": o (the frozen Ooomba), size, and on the level a wall;
-- and water (cells' worth it'll melt back into).

Ice.TUNING = {
  SIZE = 4,              -- cells across a block (a tile)
  MIN_WATER = 1.0,       -- cells' worth of water it takes to freeze a block
  LAVA_WATER = 1.5,      -- cells' worth of water a bolt turns to in lava
  LEVEL_STEP = 4,        -- frames between a level block's floating/sinking steps (a cell each)
  PLANET_STEP = 30,      -- ...and a planet's ice tile's (a whole tile each)
  CUBE_MARGIN = 16,      -- world units an Ooomba's cube is bigger than it
  CUBE_WATER = 2,        -- cells' worth of water a melted cube leaves
  ALPHA = 0.92,          -- how solid ice looks (its art's own see-through on top)
}

do
  local image = nil
  Ice.getImage = function()
    if not image then
      image = love.graphics.newImage("img/ice.png")
      image:setFilter("nearest", "nearest")
    end
    return image
  end
end

function Ice.iceBurst(x, y, n)
  require("lua.entities.IceBolt").burst(x, y, n)
end

-- A walkable top for a block on the level (obsidian, ice, or an
-- Ooomba's cube): a moving surface along its top (see
-- TiledTerrain.newMovingSurface — RopeRock's rock has one the same way),
-- so he stands and walks on it rather than just bumping into it. An ice
-- one is slippery (isIce — see Player:move).
function Ice.addTop(wall)
  local TiledTerrain = require("lua.world.TiledTerrain")
  local top = wall.pos.y - wall.halfHeight
  local s = TiledTerrain.newMovingSurface(wall.pos.x - wall.halfWidth, top, wall.pos.x + wall.halfWidth, top)
  s.jumpStrength = state.skyDomePlanet and state.skyDomePlanet.jumpStrength
  s.blockWall = wall -- (a fireball hitting its top melts the block — see lua/systems/Projectiles.lua)
  s.isIce = wall.ice ~= nil
  wall.surface = s
  state.planetoids = state.planetoids or {}
  table.insert(state.planetoids, s)
end

function Ice.placeTop(wall)
  if not wall.surface then return end
  local top = wall.pos.y - wall.halfHeight
  wall.surface:moveTo(wall.pos.x - wall.halfWidth, top, wall.pos.x + wall.halfWidth, top)
end

function Ice.removeTop(wall)
  local s = wall.surface
  if not s then return end
  removeFrom(state.planetoids or {}, s)
  local p = state.player
  if p and p.currentPlanet == s then
    p.onSurface = false
    p.currentPlanet = nil
  end
  wall.surface = nil
end

-- If he's in the box (x0, y0)-(x1, y1), he's lifted out on top of it.
function Ice.liftPlayerOutOf(x0, y0, x1, y1)
  local p = state.player
  if not p then return end
  local qx = math.max(x0, math.min(p.pos.x, x1))
  local qy = math.max(y0, math.min(p.pos.y, y1))
  if (p.pos.x - qx) ^ 2 + (p.pos.y - qy) ^ 2 < p.radius * p.radius then p.pos.y = y0 - p.radius - 1 end
end

-- A level block's wall, from its cells.
function Ice.levelBlockWall(e)
  local half = e.size / 2
  return {
    pos = Vector2.new(e.x0 + half, e.y0 + half), halfWidth = half, halfHeight = half,
    radius = e.size * 0.7071067811865476, isWall = true,
  }
end

-- Water at level cell (c, r) froze: a block out of the water round it.
-- Which rows: the four-row band through (c, r), in its tile's columns,
-- that's all open (no wall, floor or other block in it) and holds the
-- most water. Returns whether one froze.
function Ice.freezeLevel(hc, hr)
  local g = shared.grid
  local S, cols = Ice.TUNING.SIZE, shared.grid.cols
  local c0 = math.floor(hc / S) * S
  local bestR, bestWater = nil, 0
  for r0 = hr - (S - 1), hr do
    local ok, w = true, 0
    for r = r0, r0 + S - 1 do
      for c = c0, c0 + S - 1 do
        local i = r * cols + c + 1
        if not inGrid(c, r) or isSolid(c, r) or g.floor[i] or (g.lava[i] or 0) > 0 then ok = false end
        w = w + (g.water[i] or 0)
      end
    end
    if ok and w > bestWater then bestR, bestWater = r0, w end
  end
  if not bestR or bestWater < Ice.TUNING.MIN_WATER then return false end

  for r = bestR, bestR + S - 1 do
    for c = c0, c0 + S - 1 do
      local i = r * cols + c + 1
      g.water[i] = nil
      g.solid[i] = true
    end
  end
  local e = {
    kind = "level", c0 = c0, r0 = bestR, x0 = g.x0 + c0 * CELL, y0 = g.y0 + bestR * CELL, size = S * CELL,
    water = bestWater,
  }
  e.wall = Ice.levelBlockWall(e)
  e.wall.ice = e
  table.insert(g.level.walls, e.wall)
  Ice.addTop(e.wall)
  Ice.blocks[#Ice.blocks + 1] = e
  Ice.liftPlayerOutOf(e.x0, e.y0, e.x0 + e.size, e.y0 + e.size)
  Ice.iceBurst(e.x0 + e.size / 2, e.y0 + e.size / 2, 18)
  return true
end

-- Water at planet grid g's cell (c, r) froze: the tile it's in turns to
-- ice, out of the water in it. Returns whether it did.
function Ice.freezePlanet(g, c, r)
  local p = g.planet
  local i, j = p:tileAtLocal(planetCellCenter(g, c, r))
  if not i or p.rings[i].clods[j] then return false end
  local cells = planetTileCells(g, i, j)
  local w = 0
  for _, cell in ipairs(cells) do
    if (g.lava[cell.i] or 0) > 0 then return false end
    w = w + (g.water[cell.i] or 0)
  end
  if w < Ice.TUNING.MIN_WATER then return false end
  for _, cell in ipairs(cells) do g.water[cell.i] = nil end
  p:setBlock(i, j, "ice")
  Ice.blocks[#Ice.blocks + 1] = { kind = "planet", g = g, planet = p, ring = i, j = j, water = w }
  local lx, ly = planetCellCenter(g, c, r)
  Ice.iceBurst(p.pos.x + lx, p.pos.y + ly, 18)
  return true
end

-- An Ooomba frozen in an ice cube (see above).
function Ice.encase(o)
  if o.iceBlock or o.isSquashing then return end
  local size = math.max(o.drawWidth, o.drawHeight) + Ice.TUNING.CUBE_MARGIN
  local e = { kind = "ooomba", o = o, size = size, water = Ice.TUNING.CUBE_WATER }
  o.iceBlock = e
  o.frozen = true
  -- Its middle where the Ooomba's is, its bottom on the ground under it.
  local feetX, feetY = o.pos.x - o.up.x * o.halfHeight, o.pos.y - o.up.y * o.halfHeight
  e.cx, e.cy = feetX + o.up.x * size / 2, feetY + o.up.y * size / 2
  -- On the level's terrain (not a round planetoid, not flying), it's a
  -- solid block to stand on.
  local level = state.tiledLevels and state.tiledLevels[1]
  if level and not o.planet and not o.airborne and not o.portalTransit then
    e.cx, e.cy = feetX, feetY - size / 2 + 2
    e.x0, e.y0 = e.cx - size / 2, e.cy - size / 2
    e.level = level
    e.wall = Ice.levelBlockWall(e)
    e.wall.ice = e
    table.insert(level.walls, e.wall)
    Ice.addTop(e.wall)
    Ice.liftPlayerOutOf(e.x0, e.y0, e.x0 + size, e.y0 + size)
  end
  Ice.blocks[#Ice.blocks + 1] = e
  Ice.iceBurst(e.cx, e.cy, 24)
end

-- Block e melts (see above): a splash of water — what it froze from — and
-- steam.
function Ice.melt(e)
  removeFrom(Ice.blocks, e)
  local cx, cy, upX, upY
  if e.kind == "level" then
    local g, S = shared.grid, Ice.TUNING.SIZE
    local cells = {}
    for r = e.r0 + S - 1, e.r0, -1 do
      for c = e.c0, e.c0 + S - 1 do
        local i = r * g.cols + c + 1
        g.solid[i] = nil
        cells[#cells + 1] = { i = i, r = r }
      end
    end
    pourLava(g.water, cells, e.water)
    cx, cy, upX, upY = e.x0 + e.size / 2, e.y0, 0, -1
  elseif e.kind == "planet" then
    e.planet:setBlock(e.ring, e.j, nil)
    pourLava(e.g.water, planetTileCells(e.g, e.ring, e.j), e.water)
    local ring = e.planet.rings[e.ring]
    local a = ring.offset + (e.j - 0.5) * ring.step + e.planet.rotationAngle
    upX, upY = math.cos(a), math.sin(a)
    cx, cy = e.planet.pos.x + upX * ring.mid, e.planet.pos.y + upY * ring.mid
  else
    local o = e.o
    o.frozen, o.iceBlock = false, nil
    cx, cy, upX, upY = e.cx, e.cy, o.up.x, o.up.y
    -- (Its water, onto the level's grid if it's on the level.)
    if shared.grid and e.level then
      local c, r = cellOf(cx, e.cy + e.size / 2 - CELL / 2)
      for dc = -1, 1 do
        if inGrid(c + dc, r) and not isSolid(c + dc, r) then addWater(c + dc, r, e.water / 3) end
      end
    end
  end
  if e.wall then
    removeFrom((e.level or (shared.grid and shared.grid.level) or {}).walls or {}, e.wall)
    Ice.removeTop(e.wall)
  end
  for _ = 1, math.floor(STEAM_BURST * 0.6) do spawnSteam(cx, cy, upX, upY, 1.0) end
  for _ = 1, 3 do spawnSplash(cx + (math.random() - 0.5) * 30, cy, upX, upY) end
  Ice.iceBurst(cx, cy, 10)
end

-- A fireball (or anything hot) at f.pos: an Ooomba's ice cube it's
-- touching melts (the level's blocks are walls, so main.lua's fireball-
-- vs-wall pass finds those). Returns whether it melted one.
function WaterSystem.fireHitsIce(f)
  for k = #Ice.blocks, 1, -1 do
    local e = Ice.blocks[k]
    if e.kind == "ooomba" then
      local half = e.size / 2 + f.radius
      if math.abs(f.pos.x - e.cx) < half and math.abs(f.pos.y - e.cy) < half then
        Ice.melt(e)
        return true
      end
    end
  end
  return false
end

-- Whether lava's touching level block e (in a cell round its edge).
function Ice.lavaRoundLevelBlock(e)
  local g, S = shared.grid, Ice.TUNING.SIZE
  for r = e.r0 - 1, e.r0 + S do
    for c = e.c0 - 1, e.c0 + S do
      if inGrid(c, r) and (g.lava[r * g.cols + c + 1] or 0) >= LAVA_TUNING.TOUCH then return true end
    end
  end
  return false
end

-- Level block e moved a cell (dir: -1 up, 1 down): the row it moves into
-- swaps with the row it leaves — whatever water (or lava) was there goes
-- to the other side of it.
function Ice.moveLevelBlock(e, dir)
  local g, S = shared.grid, Ice.TUNING.SIZE
  local into = dir < 0 and e.r0 - 1 or e.r0 + S
  local leave = dir < 0 and e.r0 + S - 1 or e.r0
  for c = e.c0, e.c0 + S - 1 do
    local i, k = into * g.cols + c + 1, leave * g.cols + c + 1
    g.water[k], g.water[i] = g.water[i], nil
    g.lava[k], g.lava[i] = g.lava[i], nil
    g.solid[i], g.solid[k] = true, nil
  end
  e.r0 = e.r0 + dir
  e.y0 = e.y0 + dir * CELL
  e.wall.pos.y = e.wall.pos.y + dir * CELL
  Ice.placeTop(e.wall)
  -- (Rising into him from below, he's lifted along.)
  if dir < 0 then Ice.liftPlayerOutOf(e.x0, e.y0, e.x0 + e.size, e.y0 + e.size) end
end

-- A level block floating or sinking a step (see above).
function Ice.stepLevelBlock(e)
  local g, S = shared.grid, Ice.TUNING.SIZE
  if Ice.lavaRoundLevelBlock(e) then
    Ice.melt(e)
    return
  end
  local bottom = e.r0 + S - 1
  local restsBelow, waterBelow = false, 0
  for c = e.c0, e.c0 + S - 1 do
    if blocked(c, bottom, 0, 1) then restsBelow = true end
    if inGrid(c, bottom + 1) then waterBelow = waterBelow + (g.water[(bottom + 1) * g.cols + c + 1] or 0) end
  end
  if not restsBelow and waterBelow < 1 then
    Ice.moveLevelBlock(e, 1) -- (nothing to hold it up: it drops)
  else
    -- Sunk in water, it floats up (the water it rises out of flowing in
    -- under it — see moveLevelBlock), even off the bottom of a pool.
    local roofed, waterAbove = false, 0
    for c = e.c0, e.c0 + S - 1 do
      if e.r0 <= 0 or blocked(c, e.r0, 0, -1) then roofed = true end
      if e.r0 > 0 then waterAbove = waterAbove + (g.water[(e.r0 - 1) * g.cols + c + 1] or 0) end
    end
    -- (Sunk: water over it, or up its sides to its top row.)
    local function sideWet(c) return inGrid(c, e.r0) and (g.water[e.r0 * g.cols + c + 1] or 0) >= 0.5 end
    local sunk = waterAbove > 0.05 or sideWet(e.c0 - 1) or sideWet(e.c0 + S)
    if not roofed and sunk then Ice.moveLevelBlock(e, -1) end
  end
end

-- Planet ice tile e: how much water's in tile (ring ti, tile tj) — or
-- nil if it's solid (dirt, a block, or past the rings).
function Ice.planetTileWater(e, ti, tj)
  local p = e.planet
  if ti < 1 or ti > #p.rings then return nil end
  tj = (tj - 1) % p.rings[ti].count + 1
  if p.rings[ti].clods[tj] then return nil end
  local w, lava = 0, 0
  for _, cell in ipairs(planetTileCells(e.g, ti, tj)) do
    w = w + (e.g.water[cell.i] or 0)
    lava = lava + (e.g.lava[cell.i] or 0)
  end
  return w, lava
end

-- Planet ice tile e moved to ring ti (the next one in or out): the water
-- (and lava) in that tile goes into the one it leaves.
function Ice.movePlanetBlock(e, ti)
  local g, p = e.g, e.planet
  local water, lava = 0, 0
  for _, cell in ipairs(planetTileCells(g, ti, e.j)) do
    water = water + (g.water[cell.i] or 0)
    lava = lava + (g.lava[cell.i] or 0)
    g.water[cell.i], g.lava[cell.i] = nil, nil
  end
  p:setBlock(e.ring, e.j, nil)
  p:setBlock(ti, e.j, "ice")
  local cells = planetTileCells(g, e.ring, e.j)
  pourLava(g.water, cells, water)
  pourLava(g.lava, cells, lava)
  e.ring = ti
end

-- A planet's ice tile floating or sinking a tile (see above).
function Ice.stepPlanetBlock(e)
  local i, j = e.ring, e.j
  -- Lava next to it (in, out, or either side) melts it.
  for _, n in ipairs({ { i - 1, j }, { i + 1, j }, { i, j - 1 }, { i, j + 1 } }) do
    local _, lava = Ice.planetTileWater(e, n[1], n[2])
    if lava and lava >= LAVA_TUNING.TOUCH then
      Ice.melt(e)
      return
    end
  end
  local below = i > 1 and Ice.planetTileWater(e, i - 1, j) or nil
  if below and below < 2 then
    Ice.movePlanetBlock(e, i - 1)
  elseif i < #e.planet.rings then
    -- (Sunk in water, it floats up — even off the bottom of a pool.)
    local above = Ice.planetTileWater(e, i + 1, j)
    local left, right = Ice.planetTileWater(e, i, j - 1), Ice.planetTileWater(e, i, j + 1)
    local sunk = (above and above > 0.5) or (left or 0) >= 12 or (right or 0) >= 12
    if above and sunk then Ice.movePlanetBlock(e, i + 1) end
  end
end

-- Each frame (see WaterSystem.update): the blocks floating and sinking,
-- each at its own pace.
function Ice.update()
  if #Ice.blocks == 0 then return end
  local before = Ice.frame
  Ice.frame = Ice.frame + (state.timeScale or 1)
  local function due(every) return math.floor(Ice.frame / every) > math.floor(before / every) end
  local levelDue, planetDue = due(Ice.TUNING.LEVEL_STEP), due(Ice.TUNING.PLANET_STEP)
  for k = #Ice.blocks, 1, -1 do
    local e = Ice.blocks[k]
    if e then
      if e.kind == "level" and levelDue and shared.grid then
        Ice.stepLevelBlock(e)
      elseif e.kind == "planet" and planetDue and shared.planetGrids[e.planet] == e.g then
        Ice.stepPlanetBlock(e)
      elseif e.kind == "ooomba" and e.o.isSquashing then
        Ice.melt(e)
      end
    end
  end
end

-- Ice bolt b (see lua/entities/IceBolt.lua) reaching water or lava this
-- frame (anywhere along the path it's just moved): water freezes into a
-- block (see above), lava gets water poured into it (so it turns to
-- obsidian). Returns whether it did — the bolt's spent either way, if it
-- reached either (the caller removes it).
function WaterSystem.iceBoltHit(b)
  local ts = state.timeScale or 1
  local x1, y1 = b.pos.x, b.pos.y
  local x0, y0 = x1 - b.vel.x * ts, y1 - b.vel.y * ts
  local dist = math.sqrt((x1 - x0) ^ 2 + (y1 - y0) ^ 2)
  local steps = math.max(1, math.ceil(dist / (CELL * 0.5)))
  for s = 0, steps do
    local x, y = x0 + (x1 - x0) * s / steps, y0 + (y1 - y0) * s / steps
    local pg = planetGridAt(x, y)
    if pg then
      local c, r = planetCellOf(pg, x, y)
      local i = planetIndex(pg, c, r)
      if i and (pg.lava[i] or 0) >= LAVA_TUNING.TOUCH then
        pg.water[i] = (pg.water[i] or 0) + Ice.TUNING.LAVA_WATER
        return true
      end
      if i and (pg.water[i] or 0) >= QUENCH_AT then
        Ice.freezePlanet(pg, c, r)
        return true
      end
    elseif shared.grid then
      local c, r = cellOf(x, y)
      if inGrid(c, r) then
        local i = r * shared.grid.cols + c + 1
        if (shared.grid.lava[i] or 0) >= LAVA_TUNING.TOUCH then
          addWater(c, r, Ice.TUNING.LAVA_WATER)
          return true
        end
        if (shared.grid.water[i] or 0) >= QUENCH_AT then
          Ice.freezeLevel(c, r)
          return true
        end
      end
    end
  end
  return false
end

-- Ooomba o frozen solid (an ice bolt's hit it — see lua/systems/Projectiles.lua).
function WaterSystem.encaseOoomba(o)
  Ice.encase(o)
end

-- An Ooomba's ice cube, drawn over it (see main.lua's Ooomba drawing).
function WaterSystem.drawIceCube(e)
  local image = Ice.getImage()
  local angle = (e.wall or not e.o) and 0 or math.atan2(e.o.up.x, -e.o.up.y)
  love.graphics.setColor(1, 1, 1, Ice.TUNING.ALPHA * 0.85)
  love.graphics.draw(image, e.cx, e.cy, angle, e.size / image:getWidth(), e.size / image:getHeight(),
    image:getWidth() / 2, image:getHeight() / 2)
  love.graphics.setColor(1, 1, 1, 1)
end

-- The ice blocks on the level (a dirt planet's are part of its own picture;
-- an Ooomba's cube is drawn with it).
function Ice.drawLevel()
  local image = nil
  for _, e in ipairs(Ice.blocks) do
    if e.kind == "level" then
      image = image or Ice.getImage()
      love.graphics.setColor(1, 1, 1, Ice.TUNING.ALPHA)
      love.graphics.draw(image, e.x0, e.y0, 0, e.size / image:getWidth(), e.size / image:getHeight())
    end
  end
  love.graphics.setColor(1, 1, 1, 1)
end

-- For debugging/tests: the ice blocks.
function WaterSystem.debugIce()
  return Ice.blocks
end

return {
  api = WaterSystem,
}
