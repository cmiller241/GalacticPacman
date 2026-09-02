-- lua/entities/Asteroid.lua
--
-- Port of js/entities/world/Asteroid.js
-- Irregular faceted asteroid with simple directional shading.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local constants = require("lua.constants")

local Asteroid = {}
Asteroid.__index = Asteroid

local function randomRange(a, b)
  return a + math.random() * (b - a)
end

function Asteroid.new(x, y, radius)
  local self = setmetatable({}, Asteroid)

  self.pos = Vector2.new(x, y)
  self.radius = radius
  self.mass = radius * radius

  local dir = Vector2.new(math.random() * 2 - 1, math.random() * 2 - 1):normalize()
  self.vel = dir:multiply(constants.PLANET_SPEED)

  self.angularSpeed = (math.random() * 2 - 1) * 0.05
  self.angle = math.random() * math.pi * 2

  -- Base brown color (roughly #A85417)
  self.color = { 0.66, 0.33, 0.09 }

  self.points = self:generatePoints()
  self.interiorPoints = {}

  local numInterior = 2 + math.floor(math.random() * 2) -- 2 or 3
  for i = 1, numInterior do
    table.insert(self.interiorPoints, Vector2.new(
      (math.random() - 0.5) * self.radius * 1.2,
      (math.random() - 0.5) * self.radius * 1.2
    ))
  end

  return self
end

function Asteroid:generatePoints()
  local numSides = 6 + math.floor(math.random() * 6) -- 6–11
  local points = {}
  local angleStep = (2 * math.pi) / numSides

  for i = 0, numSides - 1 do
    local a = i * angleStep + (math.random() - 0.5) * angleStep * 0.5
    local r = self.radius * (0.7 + math.random() * 0.6)
    table.insert(points, Vector2.new(math.cos(a) * r, math.sin(a) * r))
  end

  return points
end

function Asteroid:update()
  local ts = state.timeScale or 1

  -- Drag (same exponential reasoning as the JS version)
  local drag = constants.DRAG or 0.995
  self.vel = self.vel:multiply(drag ^ ts)

  self.pos:add(self.vel:clone():multiply(ts))
  self.angle = self.angle + self.angularSpeed * ts

  -- Bounce off world edges
  if self.pos.x - self.radius < 0 then
    self.pos.x = self.radius
    self.vel.x = -self.vel.x
  end
  if self.pos.x + self.radius > state.sceneWidth then
    self.pos.x = state.sceneWidth - self.radius
    self.vel.x = -self.vel.x
  end
  if self.pos.y - self.radius < 0 then
    self.pos.y = self.radius
    self.vel.y = -self.vel.y
  end
  if self.pos.y + self.radius > state.sceneHeight then
    self.pos.y = state.sceneHeight - self.radius
    self.vel.y = -self.vel.y
  end
end

-- Simple flat-shaded triangle
local function fillTriangle(x0, y0, x1, y1, x2, y2, baseR, baseG, baseB, lightDir, radius)
  -- Edge normal (approximate)
  local ex, ey = x2 - x1, y2 - y1
  local nx, ny = ey, -ex
  local len = math.sqrt(nx * nx + ny * ny)
  if len > 0 then
    nx, ny = nx / len, ny / len
  else
    nx, ny = 0, 1
  end

  local dot = lightDir.x * nx + lightDir.y * ny
  local edgeDist = (math.sqrt(x1*x1 + y1*y1) + math.sqrt(x2*x2 + y2*y2)) / (2 * radius)

  local brightness = 0.30 + math.max(0, dot) * 0.70
  brightness = brightness * (1 - 0.4 * edgeDist) + 0.20

  local r = math.min(1, math.max(0, baseR * brightness))
  local g = math.min(1, math.max(0, baseG * brightness))
  local b = math.min(1, math.max(0, baseB * brightness))

  love.graphics.setColor(r, g, b, 1)
  love.graphics.polygon("fill", x0, y0, x1, y1, x2, y2)
end

function Asteroid:draw()
  love.graphics.push()
  love.graphics.translate(self.pos.x, self.pos.y)
  love.graphics.rotate(self.angle)

  local lightDir = Vector2.new(-0.7, -0.7):normalize()
  local br, bg, bb = self.color[1], self.color[2], self.color[3]

  -- Faceted body
  for i = 1, #self.points do
    local j = (i % #self.points) + 1
    local p1 = self.points[i]
    local p2 = self.points[j]

    -- Connect to each interior point
    for _, ip in ipairs(self.interiorPoints) do
      fillTriangle(p1.x, p1.y, p2.x, p2.y, ip.x, ip.y, br, bg, bb, lightDir, self.radius)
    end

    -- Small mid-edge facet
    local mx = (p1.x + p2.x) * 0.5
    local my = (p1.y + p2.y) * 0.5
    fillTriangle(p1.x, p1.y, mx, my, p2.x, p2.y, br, bg, bb, lightDir, self.radius)
  end

  -- Dark outline
  love.graphics.setColor(0.23, 0.11, 0.03, 1)
  love.graphics.setLineWidth(2)
  local outline = {}
  for _, p in ipairs(self.points) do
    table.insert(outline, p.x)
    table.insert(outline, p.y)
  end
  love.graphics.polygon("line", unpack(outline))

  -- Subtle inner shadow (simple darkening toward the edge)
  love.graphics.setColor(0, 0, 0, 0.22)
  love.graphics.polygon("fill", unpack(outline))

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.setLineWidth(1)
  love.graphics.pop()
end

return Asteroid