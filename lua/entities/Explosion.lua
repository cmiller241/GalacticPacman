-- lua/entities/Explosion.lua
--
-- Port of js/entities/world/Explosion.js
-- Expanding fading ring + a quick bright core flash + a fiery particle
-- burst. Purely time-driven — nothing to simulate beyond the elapsed
-- clock read in :draw()/:isDead(), same as the original.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local Particle = require("lua.entities.Particle")

local EXPLOSION_DURATION = 0.4 -- seconds (400ms in the original)
local RING_MAX_RADIUS = 70
local FLASH_RADIUS = 30
local FLASH_FRACTION = 0.3     -- flash burns out over the first 30% of the duration
local PARTICLE_COUNT = 40

local Explosion = {}
Explosion.__index = Explosion

-- Shared radial-gradient flash mesh (bright warm-white center fading to
-- transparent orange at the edge) — baked once, reused by every
-- explosion via love.graphics.draw(mesh, x, y, 0, radius, radius),
-- same "bake once, draw many" idea as the original's own shared,
-- lazily-built flashTexture. A fan mesh can only interpolate
-- center->edge, so this approximates the original's 3-stop canvas
-- gradient with 2 stops — close enough for something this small
-- (60px across) and this short-lived (only visible for the first 30%
-- of a 400ms explosion).
local flashMesh = nil
local function getFlashMesh()
  if flashMesh then return flashMesh end
  local segments = 32
  local vertices = {
    { 0, 0, 0.5, 0.5, 1, 1, 220 / 255, 1 },
  }
  for i = 0, segments do
    local angle = (i / segments) * math.pi * 2
    local x, y = math.cos(angle), math.sin(angle)
    table.insert(vertices, { x, y, 0.5 + x * 0.5, 0.5 + y * 0.5, 1, 100 / 255, 20 / 255, 0 })
  end
  flashMesh = love.graphics.newMesh(vertices, "fan", "static")
  return flashMesh
end

local function randomRange(a, b)
  return a + math.random() * (b - a)
end

-- Small local hue->rgb helper (full saturation, 50% lightness, matching
-- the original's hsl(hue, 100%, 50%)) — same role as FireBar.lua's own
-- hslaApprox. Not shared: this project doesn't have a shared
-- lua/utils.lua yet, so each file that needs this keeps its own copy,
-- matching that existing precedent.
local function hueToRgb(hue)
  local h = (hue % 360) / 360
  local function hue2rgb(p, q, t)
    if t < 0 then t = t + 1 end
    if t > 1 then t = t - 1 end
    if t < 1 / 6 then return p + (q - p) * 6 * t end
    if t < 1 / 2 then return q end
    if t < 2 / 3 then return p + (q - p) * (2 / 3 - t) * 6 end
    return p
  end
  -- l=0.5, s=1 fixed throughout, so q/p reduce to fixed constants:
  -- q = l + s - l*s = 0.5 + 1 - 0.5 = 1.0, p = 2*l - q = 0.0
  return hue2rgb(0, 1, h + 1 / 3), hue2rgb(0, 1, h), hue2rgb(0, 1, h - 1 / 3)
end

-- Fiery particle burst — reuses the shared Particle system (see
-- lua/entities/Particle.lua) rather than inventing a new particle
-- style, same role as the original's createDeathParticles(pos, count).
local function spawnFieryParticles(pos, count)
  for _ = 1, count do
    local angle = math.random() * math.pi * 2
    local speed = randomRange(3, 9)
    local vel = Vector2.new(math.cos(angle) * speed, math.sin(angle) * speed)
    local particle = Particle.new(pos, vel)
    local r, g, b = hueToRgb(randomRange(20, 80)) -- fiery oranges/yellows
    particle.color = { r, g, b }
    table.insert(state.particles, particle)
  end
end

function Explosion.new(x, y)
  local self = setmetatable({}, Explosion)
  self.pos = Vector2.new(x, y)
  self.startTime = love.timer.getTime()
  self.duration = EXPLOSION_DURATION
  spawnFieryParticles(self.pos, PARTICLE_COUNT)
  return self
end

function Explosion:isDead()
  return love.timer.getTime() - self.startTime >= self.duration
end

function Explosion:update()
  -- Purely time-driven; nothing to simulate beyond the elapsed clock
  -- read in :draw()/:isDead().
end

function Explosion:draw()
  local t = math.min((love.timer.getTime() - self.startTime) / self.duration, 1)
  local eased = 1 - (1 - t) ^ 3 -- fast expand, settles near the end

  -- Expanding, fading shockwave ring
  love.graphics.setColor(1, 204 / 255, 102 / 255, 1 - t)
  love.graphics.setLineWidth(4 * (1 - t) + 1)
  love.graphics.circle("line", self.pos.x, self.pos.y, eased * RING_MAX_RADIUS)

  -- Bright core flash, burns out quickly. Explosions are short-lived
  -- and infrequent, so this is cheap enough even though it's not baked
  -- per-instance (only the shared mesh geometry is baked).
  local flashT = math.min(t / FLASH_FRACTION, 1)
  if flashT < 1 then
    love.graphics.setColor(1, 1, 1, 1 - flashT)
    love.graphics.draw(getFlashMesh(), self.pos.x, self.pos.y, 0, FLASH_RADIUS, FLASH_RADIUS)
  end

  love.graphics.setLineWidth(1)
  love.graphics.setColor(1, 1, 1, 1)
end

return Explosion
