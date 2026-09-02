-- lua/entities/Coin.lua
--
-- Port of js/entities/world/Coin.js
-- Coins orbit a planet and can be collected by the player.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local constants = require("lua.constants")

local Coin = {}
Coin.__index = Coin

local COIN_RADIUS = constants.COIN_RADIUS or 12
local COIN_ORBIT_OFFSET = constants.COIN_ORBIT_OFFSET or 28

function Coin.new(planet)
  local self = setmetatable({}, Coin)

  self.planet = planet
  self.radius = COIN_RADIUS
  self.orbitRadius = planet.radius + COIN_ORBIT_OFFSET
  self.orbitOffset = COIN_ORBIT_OFFSET

  self.angularSpeed = (math.random() - 0.5) * 0.04
  self.angle = math.random() * math.pi * 2

  -- For rounded-rect planets (arc-length walk)
  self.arcPos = 0
  self.arcSpeed = (math.random() - 0.5) * 2
  if planet.isRoundedRect and planet.getPerimeter then
    self.arcPos = math.random() * planet:getPerimeter()
  end

  self.pos = Vector2.new(0, 0)
  self:updatePosition()

  return self
end

function Coin:updatePosition()
  local planet = self.planet
  if planet.isRoundedRect and planet.worldPointAtArcPosition then
    local world = planet:worldPointAtArcPosition(self.arcPos, self.orbitOffset)
    self.pos.x = world.point.x
    self.pos.y = world.point.y
  else
    self.pos.x = planet.pos.x + math.cos(self.angle) * self.orbitRadius
    self.pos.y = planet.pos.y + math.sin(self.angle) * self.orbitRadius
  end
end

function Coin:update()
  local ts = state.timeScale or 1
  if self.planet.isRoundedRect then
    self.arcPos = self.arcPos + self.arcSpeed * ts
  else
    self.angle = self.angle + self.angularSpeed * ts
  end
  self:updatePosition()
end

function Coin:draw()
  local x, y = self.pos.x, self.pos.y
  local r = self.radius

  -- Gold body
  love.graphics.setColor(1.0, 0.84, 0.0, 1)
  love.graphics.circle("fill", x, y, r)

  -- Darker gold rim
  love.graphics.setColor(0.72, 0.53, 0.04, 0.8)
  love.graphics.setLineWidth(2)
  love.graphics.circle("line", x, y, r)

  -- Spinning highlight
  local spin = love.timer.getTime() * 10
  love.graphics.push()
  love.graphics.translate(x, y)
  love.graphics.rotate(spin)
  love.graphics.setColor(1, 1, 1, 0.8)
  love.graphics.circle("fill", -r * 0.4, -r * 0.4, r * 0.4)
  love.graphics.pop()

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.setLineWidth(1)
end

return Coin