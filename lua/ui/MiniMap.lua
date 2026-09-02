-- lua/ui/Minimap.lua
--
-- Screen-space overview of the full world grid.
-- Belt marker is a static thick circular annulus around the sun,
-- not a box and not live planetoid positions.

local state = require("lua.state")

local Minimap = {}
Minimap.__index = Minimap

function Minimap.new()
  local self = setmetatable({}, Minimap)

  self.size = 240
  self.sizeFraction = 0.20
  self.margin = 20

  self.backgroundColor = { 6/255, 14/255, 24/255, 0.72 }
  self.gridColor       = { 80/255, 200/255, 255/255, 0.18 }
  self.borderColor     = { 100/255, 220/255, 255/255, 0.85 }
  self.cornerColor     = { 140/255, 230/255, 255/255, 1 }
  self.labelColor      = { 150/255, 230/255, 255/255, 0.85 }

  self.playerColor     = { 1, 1, 1, 1 }
  self.playerGlowColor = { 1, 1, 1, 0.35 }
  self.playerRadius    = 5

  self.specialColor     = { 1, 210/255, 63/255, 1 }
  self.specialGlowColor = { 1, 210/255, 63/255, 0.5 }
  self.specialRadius    = 3

  self.sunColor     = { 1, 0.75, 0.2, 1 }
  self.sunGlowColor = { 1, 0.55, 0.1, 0.45 }

  self.beltDotColor = { 1, 77/255, 77/255, 0.78 }
  self.beltDotCount = 220
  self._beltDots = nil

  return self
end

function Minimap:refreshSize()
  local w = love.graphics.getWidth()
  self.size = math.max(120, math.floor(w * (self.sizeFraction or 0.25)))
end

function Minimap:getSpecialPlanets()
  local list = {}
  if state.mazePlanet then table.insert(list, state.mazePlanet) end
  if state.platformPlanet then table.insert(list, state.platformPlanet) end
  if state.skyDomePlanet then table.insert(list, state.skyDomePlanet) end
  return list
end

function Minimap:worldToMapPoint(worldX, worldY, x0, y0)
  local sw = state.sceneWidth or 1
  local sh = state.sceneHeight or 1
  return {
    x = x0 + (worldX / sw) * self.size,
    y = y0 + (worldY / sh) * self.size,
  }
end

function Minimap:drawGlowDot(x, y, radius, color, glowColor)
  love.graphics.setColor(glowColor)
  love.graphics.circle("fill", x, y, radius * 2.2)
  love.graphics.setColor(color)
  love.graphics.circle("fill", x, y, radius)
end

function Minimap:ensureBeltDots()
  if self._beltDots then return end

  local worldGen = require("lua.setup.worldGen")
  local cellSize = worldGen.CELL_SIZE or 3000
  local rMin = (worldGen.BELT_INNER_CELLS or 2) * cellSize
  local rMax = (worldGen.BELT_OUTER_CELLS or 3) * cellSize
  local sunX = (state.sceneWidth or cellSize * 20) / 2
  local sunY = (state.sceneHeight or cellSize * 20) / 2

  local dots = {}
  local rng = love.math.newRandomGenerator(20260821)
  local n = self.beltDotCount or 220

  for _ = 1, n do
    local ang = rng:random() * math.pi * 2
    -- Uniform in annulus area: r = sqrt(u * (R2^2 - R1^2) + R1^2)
    local u = rng:random()
    local r = math.sqrt(u * (rMax * rMax - rMin * rMin) + rMin * rMin)
    table.insert(dots, {
      x = sunX + math.cos(ang) * r,
      y = sunY + math.sin(ang) * r,
    })
  end

  self._beltDots = dots
end

function Minimap:draw()
  self:refreshSize()
  self:ensureBeltDots()

  local winW = love.graphics.getWidth()
  local winH = love.graphics.getHeight()
  local x0 = winW - self.size - self.margin
  local y0 = winH - self.size - self.margin

  love.graphics.setColor(self.backgroundColor)
  love.graphics.rectangle("fill", x0, y0, self.size, self.size)

  local gridSize = (state.gridSize or 20)
  local cellPx = self.size / gridSize
  love.graphics.setColor(self.gridColor)
  love.graphics.setLineWidth(1)
  for i = 1, gridSize - 1 do
    local t = x0 + i * cellPx
    love.graphics.line(t, y0, t, y0 + self.size)
    local u = y0 + i * cellPx
    love.graphics.line(x0, u, x0 + self.size, u)
  end

  love.graphics.setColor(self.beltDotColor)
  for _, d in ipairs(self._beltDots) do
    local m = self:worldToMapPoint(d.x, d.y, x0, y0)
    love.graphics.circle("fill", m.x, m.y, 1.15)
  end

  if state.sun and state.sun.pos then
    local sunMap = self:worldToMapPoint(state.sun.pos.x, state.sun.pos.y, x0, y0)
    local sunR = 6
    if state.sun.radius and state.sceneWidth then
      sunR = math.max(4, (state.sun.radius / state.sceneWidth) * self.size)
      sunR = math.min(sunR, self.size * 0.08)
    end
    self:drawGlowDot(sunMap.x, sunMap.y, sunR, self.sunColor, self.sunGlowColor)
  end

  for _, planet in ipairs(self:getSpecialPlanets()) do
    if planet and planet.pos then
      local p = self:worldToMapPoint(planet.pos.x, planet.pos.y, x0, y0)
      self:drawGlowDot(p.x, p.y, self.specialRadius, self.specialColor, self.specialGlowColor)
    end
  end

  if state.player and state.player.pos then
    local playerMap = self:worldToMapPoint(state.player.pos.x, state.player.pos.y, x0, y0)
    self:drawGlowDot(playerMap.x, playerMap.y, self.playerRadius, self.playerColor, self.playerGlowColor)
  end

  love.graphics.setColor(self.borderColor)
  love.graphics.setLineWidth(1.5)
  love.graphics.rectangle("line", x0, y0, self.size, self.size)

  local bracket = math.min(20, self.size * 0.12)
  love.graphics.setColor(self.cornerColor)
  love.graphics.setLineWidth(2)

  local corners = {
    { x0, y0, 1, 1 },
    { x0 + self.size, y0, -1, 1 },
    { x0, y0 + self.size, 1, -1 },
    { x0 + self.size, y0 + self.size, -1, -1 },
  }
  for _, c in ipairs(corners) do
    local cx, cy, dx, dy = c[1], c[2], c[3], c[4]
    love.graphics.line(cx, cy + bracket * dy, cx, cy)
    love.graphics.line(cx, cy, cx + bracket * dx, cy)
  end

  love.graphics.setColor(self.labelColor)
  love.graphics.print("SECTOR MAP", x0 + 8, y0 - 18)

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.setLineWidth(1)
end

return Minimap