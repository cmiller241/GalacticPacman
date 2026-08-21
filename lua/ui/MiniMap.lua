-- lua/ui/Minimap.lua
--
-- Port of js/ui/Minimap.js
-- Fixed screen-space overview of the full world grid.

local state = require("lua.state")

local Minimap = {}
Minimap.__index = Minimap

function Minimap.new()
  local self = setmetatable({}, Minimap)

  self.size = 480
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

  -- Optional belt scatter (disabled until CellManifest is ported)
  self.beltDotColor = { 1, 77/255, 77/255, 1 }
  self.beltDotCount = 130
  self._beltDots = nil

  return self
end

function Minimap:getSpecialPlanets()
  local list = {}
  if state.mazePlanet then table.insert(list, state.mazePlanet) end
  if state.platformPlanet then table.insert(list, state.platformPlanet) end
  return list
end

function Minimap:worldToMapPoint(worldX, worldY, x0, y0)
  return {
    x = x0 + (worldX / state.sceneWidth) * self.size,
    y = y0 + (worldY / state.sceneHeight) * self.size,
  }
end

function Minimap:drawGlowDot(x, y, radius, color, glowColor)
  love.graphics.setColor(glowColor)
  love.graphics.circle("fill", x, y, radius * 2.2)

  love.graphics.setColor(color)
  love.graphics.circle("fill", x, y, radius)
end

function Minimap:draw()
  if not state.player or not state.sceneWidth or not state.sceneHeight then
    return
  end

  local screenW = love.graphics.getWidth()
  local screenH = love.graphics.getHeight()

  -- Scale with window: ~25% of width, clamped so it stays usable
  self.size = math.floor(screenW * 0.25)

  local gridSize = state.gridSize or 20
  local x0 = screenW - self.margin - self.size
  local y0 = screenH - self.margin - self.size

  -- Panel background
  love.graphics.setColor(self.backgroundColor)
  love.graphics.rectangle("fill", x0, y0, self.size, self.size)

  -- Grid lines
  love.graphics.setColor(self.gridColor)
  love.graphics.setLineWidth(1)
  for i = 0, gridSize do
    local gx = x0 + (i / gridSize) * self.size
    love.graphics.line(gx, y0, gx, y0 + self.size)

    local gy = y0 + (i / gridSize) * self.size
    love.graphics.line(x0, gy, x0 + self.size, gy)
  end

  -- Sun (scaled by real radius)
  if state.sun then
    local s = self:worldToMapPoint(state.sun.pos.x, state.sun.pos.y, x0, y0)

    -- World radius → map pixels
    local mapRadius = (state.sun.radius / state.sceneWidth) * self.size
    -- Keep it readable: not tiny, not a giant blob
    mapRadius = math.max(4, math.min(mapRadius, self.size * 0.12))

    -- soft glow
    love.graphics.setColor(1.0, 0.55, 0.12, 0.30)
    love.graphics.circle("fill", s.x, s.y, mapRadius * 1.6)

    -- core
    love.graphics.setColor(1.0, 0.85, 0.25, 1)
    love.graphics.circle("fill", s.x, s.y, mapRadius)
  end


  -- Special planetoids (yellow)
  for _, planet in ipairs(self:getSpecialPlanets()) do
    local p = self:worldToMapPoint(planet.pos.x, planet.pos.y, x0, y0)
    self:drawGlowDot(p.x, p.y, self.specialRadius, self.specialColor, self.specialGlowColor)
  end

  -- Player (white, on top)
  local playerMap = self:worldToMapPoint(state.player.pos.x, state.player.pos.y, x0, y0)
  self:drawGlowDot(playerMap.x, playerMap.y, self.playerRadius, self.playerColor, self.playerGlowColor)

  -- Border
  love.graphics.setColor(self.borderColor)
  love.graphics.setLineWidth(1.5)
  love.graphics.rectangle("line", x0, y0, self.size, self.size)

  -- Sci-fi corner brackets
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

  -- Label
  love.graphics.setColor(self.labelColor)
  love.graphics.print("SECTOR MAP", x0 + 8, y0 - 18)

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.setLineWidth(1)
end

return Minimap