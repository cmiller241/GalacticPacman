-- lua/entities/Particle.lua
--
-- Port of js/entities/Particle.js
-- A single simple physics particle (position + velocity + fading
-- life), used for debris/death/explosion bursts. js/utils.js's
-- createParticles/createDeathParticles helpers that build batches of
-- these are ported inline wherever they're needed (see
-- lua/entities/Explosion.lua) rather than as a shared module, since
-- this project doesn't have a shared lua/utils.lua yet.

local state = require("lua.state")

local Particle = {}
Particle.__index = Particle

function Particle.new(pos, vel, life)
  life = life or 40
  local self = setmetatable({}, Particle)
  self.pos = pos:clone()
  self.vel = vel
  self.life = life
  self.maxLife = life
  -- Plain {r, g, b} (0-1), not a CSS color string — LÖVE has no CSS
  -- color parsing, unlike the original's fillStyle string. Defaults to
  -- the original's hardcoded yellow.
  self.color = { 1, 1, 0 }
  self.radius = 2
  -- Both default to "no effect," matching the original: 1 = constant
  -- velocity forever, 0 = constant size.
  self.drag = 1
  self.growRate = 0
  return self
end

function Particle:update()
  local timeScale = state.timeScale or 1
  self.pos:addScaled(self.vel, timeScale)
  self.vel:scale(self.drag ^ timeScale)
  self.radius = self.radius + self.growRate * timeScale
  self.life = self.life - timeScale
end

function Particle:draw()
  if self.life <= 0 then return end
  love.graphics.setColor(self.color[1], self.color[2], self.color[3], self.life / self.maxLife)
  love.graphics.circle("fill", self.pos.x, self.pos.y, self.radius)
  love.graphics.setColor(1, 1, 1, 1)
end

return Particle
