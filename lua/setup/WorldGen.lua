-- lua/setup/worldGen.lua
--
-- Cell streaming + annular sun belt (2–3 cell radii).
-- Deterministic FireBars on the mid-belt ring; spawned/culled with the 3x3.

local state = require("lua.state")
local constants = require("lua.constants")
local Planetoid = require("lua.world.Planetoid")
local Asteroid = require("lua.entities.Asteroid")
local Coin = require("lua.entities.Coin")
local FireBar = require("lua.world.FireBar")

local worldGen = {}

worldGen.CELL_SIZE = 3000
worldGen.GRID_SIZE = 20
worldGen.CENTER_CELL = { col = 10, row = 10 }
worldGen.CELL_CHECK_INTERVAL = 30

worldGen.BELT_INNER_CELLS = 2
worldGen.BELT_OUTER_CELLS = 3
worldGen.BELT_ORBIT_SPEED = 1.8 * 1.5   -- 2.7

worldGen.FIREBAR_COUNT = 16

local PLANETOIDS_PER_CELL = 6
local BELT_PLANETOIDS_PER_CELL = 36
local ASTEROIDS_PER_CELL  = 2
local COINS_PER_PLANET_BASE = 4

local PLANET_COLORS = {
  { 0.75, 0.78, 0.85, 1 },
  { 0.95, 0.45, 0.40, 1 },
  { 0.45, 0.85, 0.50, 1 },
  { 0.95, 0.85, 0.40, 1 },
  { 0.55, 0.55, 0.70, 1 },
  { 0.80, 0.55, 0.35, 1 },
}

function worldGen.cellCoordFor(worldX, worldY)
  return {
    col = math.floor(worldX / worldGen.CELL_SIZE),
    row = math.floor(worldY / worldGen.CELL_SIZE),
  }
end

function worldGen.cellKey(col, row)
  return col .. "," .. row
end

function worldGen.sunPos()
  local w = state.sceneWidth or (worldGen.CELL_SIZE * worldGen.GRID_SIZE)
  local h = state.sceneHeight or (worldGen.CELL_SIZE * worldGen.GRID_SIZE)
  return w / 2, h / 2
end

function worldGen.sunCell()
  local sx, sy = worldGen.sunPos()
  local col = math.floor(sx / worldGen.CELL_SIZE)
  local row = math.floor(sy / worldGen.CELL_SIZE)
  col = math.max(0, math.min(worldGen.GRID_SIZE - 1, col))
  row = math.max(0, math.min(worldGen.GRID_SIZE - 1, row))
  return col, row
end

function worldGen.beltRadii()
  local inner = worldGen.BELT_INNER_CELLS * worldGen.CELL_SIZE
  local outer = worldGen.BELT_OUTER_CELLS * worldGen.CELL_SIZE
  return inner, outer
end

function worldGen.isInBeltRing(x, y)
  local sx, sy = worldGen.sunPos()
  local dx, dy = x - sx, y - sy
  local d = math.sqrt(dx * dx + dy * dy)
  local inner, outer = worldGen.beltRadii()
  return d > inner and d < outer
end

function worldGen.cellIntersectsBelt(col, row)
  local sx, sy = worldGen.sunPos()
  local inner, outer = worldGen.beltRadii()
  local x0 = col * worldGen.CELL_SIZE
  local y0 = row * worldGen.CELL_SIZE
  local x1 = x0 + worldGen.CELL_SIZE
  local y1 = y0 + worldGen.CELL_SIZE
  local cx = math.max(x0, math.min(sx, x1))
  local cy = math.max(y0, math.min(sy, y1))
  local nearest = math.sqrt((sx - cx) ^ 2 + (sy - cy) ^ 2)
  local corners = {
    { x0, y0 }, { x1, y0 }, { x0, y1 }, { x1, y1 },
  }
  local farthest = 0
  for _, c in ipairs(corners) do
    local d = math.sqrt((c[1] - sx) ^ 2 + (c[2] - sy) ^ 2)
    if d > farthest then farthest = d end
  end
  return nearest < outer and farthest > inner
end

----------------------------------------------------------------------
-- Deterministic FireBar slots on the mid-belt ring
----------------------------------------------------------------------

local function fireBarSlots()
  if worldGen._fireBarSlots then return worldGen._fireBarSlots end
  local inner, outer = worldGen.beltRadii()
  local r = (inner + outer) * 0.5
  local sx, sy = worldGen.sunPos()
  local slots = {}
  for i = 0, worldGen.FIREBAR_COUNT - 1 do
    local ang = (i / worldGen.FIREBAR_COUNT) * math.pi * 2
    local x = sx + math.cos(ang) * r
    local y = sy + math.sin(ang) * r
    local cell = worldGen.cellCoordFor(x, y)
    table.insert(slots, {
      id = i,
      x = x,
      y = y,
      startAngle = ang + math.pi / 2,
      col = cell.col,
      row = cell.row,
      key = worldGen.cellKey(cell.col, cell.row),
    })
  end
  worldGen._fireBarSlots = slots
  return slots
end

local function generateFireBarsForCell(col, row)
  state.fireBars = state.fireBars or {}
  state.activeFireBarIds = state.activeFireBarIds or {}
  local key = worldGen.cellKey(col, row)
  for _, slot in ipairs(fireBarSlots()) do
    if slot.key == key and not state.activeFireBarIds[slot.id] then
      local bar = FireBar.new(slot.x, slot.y, {
        barLength = 420,
        numFireballs = 10,
        startAngle = slot.startAngle,
        rotationSpeed = 0.05,
      })
      bar.fireBarId = slot.id
      bar.isPermanent = false
      table.insert(state.fireBars, bar)
      state.activeFireBarIds[slot.id] = true
    end
  end
end

local function randomColor()
  return PLANET_COLORS[math.random(1, #PLANET_COLORS)]
end

local function applyBeltOrbit(planet)
  planet.isBeltPlanetoid = true
  local sunX, sunY = worldGen.sunPos()
  local dx = planet.pos.x - sunX
  local dy = planet.pos.y - sunY
  local dist = math.sqrt(dx * dx + dy * dy)
  if dist < 1 then dist = 1 end
  planet.vel.x = (-dy / dist) * worldGen.BELT_ORBIT_SPEED
  planet.vel.y = ( dx / dist) * worldGen.BELT_ORBIT_SPEED
  planet.beltOrbitRadius = dist
end

local function randomPointInCell(col, row, radius)
  local originX = col * worldGen.CELL_SIZE
  local originY = row * worldGen.CELL_SIZE
  local x = originX + radius + math.random() * (worldGen.CELL_SIZE - 2 * radius)
  local y = originY + radius + math.random() * (worldGen.CELL_SIZE - 2 * radius)
  return x, y
end

local function randomPointInCellBelt(col, row, radius)
  local inner, outer = worldGen.beltRadii()
  for _ = 1, 40 do
    local x, y = randomPointInCell(col, row, radius)
    if worldGen.isInBeltRing(x, y) then
      return x, y
    end
  end
  local sx, sy = worldGen.sunPos()
  local cx = (col + 0.5) * worldGen.CELL_SIZE
  local cy = (row + 0.5) * worldGen.CELL_SIZE
  local dx, dy = cx - sx, cy - sy
  local d = math.sqrt(dx * dx + dy * dy)
  if d < 1 then d = 1; dx, dy = 1, 0 end
  local r = (inner + outer) * 0.5
  return sx + (dx / d) * r, sy + (dy / d) * r
end

local function createPlanetoidsInCell(col, row, count, belt)
  local created = {}
  for i = 1, count do
    local radius = belt and (28 + math.random() * 36) or (30 + math.random() * 40)
    local x, y
    if belt then
      x, y = randomPointInCellBelt(col, row, radius)
    else
      x, y = randomPointInCell(col, row, radius)
    end
    local p = Planetoid.new(x, y, radius, randomColor())
    p:createRingCanvas()
    if belt then
      applyBeltOrbit(p)
    end
    table.insert(state.planetoids, p)
    table.insert(created, p)
  end
  return created
end

local function createAsteroidsInCell(col, row, count)
  local originX = col * worldGen.CELL_SIZE
  local originY = row * worldGen.CELL_SIZE
  for i = 1, count do
    local radius = 16 + math.random() * 30
    local x = originX + radius + math.random() * (worldGen.CELL_SIZE - 2 * radius)
    local y = originY + radius + math.random() * (worldGen.CELL_SIZE - 2 * radius)
    table.insert(state.asteroids, Asteroid.new(x, y, radius))
  end
end

local function createCoinsForPlanetoids(planetoids)
  for _, planet in ipairs(planetoids) do
    local numCoins = COINS_PER_PLANET_BASE + math.floor(planet.radius / 10)
    for i = 1, numCoins do
      local coin = Coin.new(planet)
      coin.angle = (i / numCoins) * math.pi * 2 + math.random() * 0.2
      if coin.updatePosition then
        coin:updatePosition()
      end
      table.insert(state.coins, coin)
    end
  end
end

local function generateCell(col, row)
  local key = worldGen.cellKey(col, row)
  if state.activeCells[key] then return end
  state.activeCells[key] = true

  local belt = worldGen.cellIntersectsBelt(col, row)
  local planetCount = belt and BELT_PLANETOIDS_PER_CELL or PLANETOIDS_PER_CELL
  local regulars = createPlanetoidsInCell(col, row, planetCount, belt)

  if not belt then
    createAsteroidsInCell(col, row, ASTEROIDS_PER_CELL)
  end

  createCoinsForPlanetoids(regulars)
  generateFireBarsForCell(col, row)
end

local function cullDistantObjects(activeCellKeys)
  for i = #state.planetoids, 1, -1 do
    local p = state.planetoids[i]
    if not p.isPermanent then
      local cell = worldGen.cellCoordFor(p.pos.x, p.pos.y)
      local key = worldGen.cellKey(cell.col, cell.row)
      if not activeCellKeys[key] then
        table.remove(state.planetoids, i)
      end
    end
  end

  local survivingPlanetoids = {}
  for _, p in ipairs(state.planetoids) do
    survivingPlanetoids[p] = true
  end

  if state.asteroids then
    for i = #state.asteroids, 1, -1 do
      local a = state.asteroids[i]
      local cell = worldGen.cellCoordFor(a.pos.x, a.pos.y)
      local key = worldGen.cellKey(cell.col, cell.row)
      if not activeCellKeys[key] then
        table.remove(state.asteroids, i)
      end
    end
  end

  if state.coins then
    for i = #state.coins, 1, -1 do
      local c = state.coins[i]
      if not c.planet or not survivingPlanetoids[c.planet] then
        table.remove(state.coins, i)
      else
        local cell = worldGen.cellCoordFor(c.planet.pos.x, c.planet.pos.y)
        local key = worldGen.cellKey(cell.col, cell.row)
        if not activeCellKeys[key] then
          table.remove(state.coins, i)
        end
      end
    end
  end

  if state.fireBars then
    state.activeFireBarIds = state.activeFireBarIds or {}
    for i = #state.fireBars, 1, -1 do
      local bar = state.fireBars[i]
      local cell = worldGen.cellCoordFor(bar.pos.x, bar.pos.y)
      local key = worldGen.cellKey(cell.col, cell.row)
      if not activeCellKeys[key] then
        if bar.fireBarId then
          state.activeFireBarIds[bar.fireBarId] = nil
        end
        table.remove(state.fireBars, i)
      end
    end
  end
end

function worldGen.updateActiveCells()
  if not state.player then return end

  local playerCell = worldGen.cellCoordFor(state.player.pos.x, state.player.pos.y)
  local activeCellKeys = {}

  for dRow = -1, 1 do
    for dCol = -1, 1 do
      local col = playerCell.col + dCol
      local row = playerCell.row + dRow
      if col >= 0 and col < worldGen.GRID_SIZE and row >= 0 and row < worldGen.GRID_SIZE then
        local key = worldGen.cellKey(col, row)
        activeCellKeys[key] = true
        generateCell(col, row)
      end
    end
  end

  for key in pairs(state.activeCells) do
    if not activeCellKeys[key] then
      state.activeCells[key] = nil
    end
  end

  cullDistantObjects(activeCellKeys)
end

function worldGen.initWorldSize()
  state.sceneWidth  = worldGen.CELL_SIZE * worldGen.GRID_SIZE
  state.sceneHeight = worldGen.CELL_SIZE * worldGen.GRID_SIZE
  state.gridSize    = worldGen.GRID_SIZE
  state.activeCells = {}
  state.planetoids  = state.planetoids or {}
  state.asteroids   = state.asteroids or {}
  state.coins       = state.coins or {}
  state.fireBars    = state.fireBars or {}
  state.activeFireBarIds = {}
  worldGen._fireBarSlots = nil
end

function worldGen.generateStartingNeighborhood(centerCol, centerRow)
  centerCol = centerCol or worldGen.CENTER_CELL.col
  centerRow = centerRow or worldGen.CENTER_CELL.row

  for dRow = -1, 1 do
    for dCol = -1, 1 do
      local col = centerCol + dCol
      local row = centerRow + dRow
      if col >= 0 and col < worldGen.GRID_SIZE and row >= 0 and row < worldGen.GRID_SIZE then
        generateCell(col, row)
      end
    end
  end
end

return worldGen