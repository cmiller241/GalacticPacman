-- lua/setup/worldGen.lua
--
-- Port of js/setup/worldGen.js (scoped to planetoids + coins + asteroids).
-- Cell-based world streaming: only a 3x3 neighborhood around the player
-- stays populated; everything else is generated on approach and culled
-- on departure.

local state = require("lua.state")
local constants = require("lua.constants")
local Planetoid = require("lua.world.Planetoid")
local Asteroid = require("lua.entities.Asteroid")
local Coin = require("lua.entities.Coin")

local worldGen = {}

----------------------------------------------------------------------
-- TUNABLES
----------------------------------------------------------------------
worldGen.CELL_SIZE = 3000
worldGen.GRID_SIZE = 20
worldGen.CENTER_CELL = { col = 10, row = 10 }
worldGen.CELL_CHECK_INTERVAL = 30   -- frames between generate/cull passes

local PLANETOIDS_PER_CELL = 6
local ASTEROIDS_PER_CELL  = 2
local COINS_PER_PLANET_BASE = 4

-- Optional planet color palette
local PLANET_COLORS = {
  { 0.75, 0.78, 0.85, 1 },
  { 0.95, 0.45, 0.40, 1 },
  { 0.45, 0.85, 0.50, 1 },
  { 0.95, 0.85, 0.40, 1 },
  { 0.55, 0.55, 0.70, 1 },
  { 0.80, 0.55, 0.35, 1 },
}

----------------------------------------------------------------------
-- Helpers
----------------------------------------------------------------------

function worldGen.cellCoordFor(worldX, worldY)
  return {
    col = math.floor(worldX / worldGen.CELL_SIZE),
    row = math.floor(worldY / worldGen.CELL_SIZE),
  }
end

function worldGen.cellKey(col, row)
  return col .. "," .. row
end

local function randomColor()
  return PLANET_COLORS[math.random(1, #PLANET_COLORS)]
end

----------------------------------------------------------------------
-- Generation
----------------------------------------------------------------------

local function createPlanetoidsInCell(col, row, count)
  local originX = col * worldGen.CELL_SIZE
  local originY = row * worldGen.CELL_SIZE
  local created = {}

  for i = 1, count do
    local radius = 30 + math.random() * 40
    local x = originX + radius + math.random() * (worldGen.CELL_SIZE - 2 * radius)
    local y = originY + radius + math.random() * (worldGen.CELL_SIZE - 2 * radius)
    local p = Planetoid.new(x, y, radius, randomColor())
    p:createRingCanvas()
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
      -- Spread them around the orbit
      coin.angle = (i / numCoins) * math.pi * 2 + math.random() * 0.2
      coin:updatePosition()
      table.insert(state.coins, coin)
    end
  end
end

local function generateCell(col, row)
  local key = worldGen.cellKey(col, row)
  if state.activeCells[key] then return end
  state.activeCells[key] = true

  local regulars = createPlanetoidsInCell(col, row, PLANETOIDS_PER_CELL)
  createAsteroidsInCell(col, row, ASTEROIDS_PER_CELL)
  createCoinsForPlanetoids(regulars)
end

----------------------------------------------------------------------
-- Culling
----------------------------------------------------------------------

local function cullDistantObjects(activeCellKeys)
  -- Planetoids (skip permanents)
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

  -- Asteroids
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

  -- Coins: tied to parent planet (same rule as JS)
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
end

----------------------------------------------------------------------
-- Main streaming tick
----------------------------------------------------------------------

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

  -- Deactivate cells that fell outside the 3x3
  for key in pairs(state.activeCells) do
    if not activeCellKeys[key] then
      state.activeCells[key] = nil
    end
  end

  cullDistantObjects(activeCellKeys)
end

----------------------------------------------------------------------
-- Bootstrap helpers for love.load / level setup
----------------------------------------------------------------------

function worldGen.initWorldSize()
  state.sceneWidth  = worldGen.CELL_SIZE * worldGen.GRID_SIZE
  state.sceneHeight = worldGen.CELL_SIZE * worldGen.GRID_SIZE
  state.gridSize    = worldGen.GRID_SIZE
  state.activeCells = {}
  state.planetoids  = state.planetoids or {}
  state.asteroids   = state.asteroids or {}
  state.coins       = state.coins or {}
end

-- Generate the player's starting 3x3 immediately (no stagger yet)
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