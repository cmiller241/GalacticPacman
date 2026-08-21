-- lua/world/Sun.lua
--
-- Visual sun at the centre of the scene.
-- Smooth radial gradient (no banding) + erupting flame particles
-- that start in the core and travel outward.
-- Now with a soft pulse.
-- No gravity, no collision.

local Sun = {}
Sun.__index = Sun

----------------------------------------------------------------------
-- TUNABLES
----------------------------------------------------------------------
local RADIUS              = 800

local PARTICLE_COUNT      = 50
local PARTICLE_INTERVAL   = 0.005
local PARTICLE_LIFE_MIN   = 22
local PARTICLE_LIFE_MAX   = 100
local PARTICLE_SIZE_MIN   = 2.2
local PARTICLE_SIZE_MAX   = 6.5
local PARTICLE_SPEED      = 3.4

local SUN_INTENSITY       = 16.0

-- Particle color over lifetime
local PARTICLE_START_COLOR = {1.0, 0.95, 0.70}
local PARTICLE_END_COLOR   = {1.0, 0.45, 0.25}

-- Particle alpha over lifetime
local PARTICLE_START_ALPHA = 0.3
local PARTICLE_END_ALPHA   = 0.0

-- Pulse
local PULSE_SPEED         = 3    -- how fast it breathes (higher = faster)
local PULSE_AMOUNT        = 0.045   -- how much the size changes (0.04 = ±4%)
local PULSE_INTENSITY     = 0.12    -- how much the brightness pulses
----------------------------------------------------------------------

local function randomRange(a, b)
  return a + math.random() * (b - a)
end

local function createSunGradientMesh(segments)
  segments = segments or 64
  local vertices = {
    {0, 0, 0.5, 0.5, 1, 1, 1, 1},
  }
  for i = 0, segments do
    local angle = (i / segments) * math.pi * 2
    local x = math.cos(angle)
    local y = math.sin(angle)
    table.insert(vertices, {x, y, 0.5 + x*0.5, 0.5 + y*0.5, 1, 1, 1, 0})
  end
  return love.graphics.newMesh(vertices, "fan", "static")
end

local sunMesh = nil

function Sun.new(x, y, radius)
  local self = setmetatable({}, Sun)
  self.pos = { x = x, y = y }
  self.radius = radius or RADIUS
  self.particles = {}
  self.emitTimer = 0
  self.pulseTime = 0

  if not sunMesh then
    sunMesh = createSunGradientMesh(80)
  end

  return self
end

function Sun:spawnParticle()
  local angle = randomRange(0, math.pi * 2)
  local outwardSpeed = randomRange(1.8, 4.2) * PARTICLE_SPEED

  local p = {
    x = self.pos.x + randomRange(-8, 8),
    y = self.pos.y + randomRange(-8, 8),
    vx = math.cos(angle) * outwardSpeed,
    vy = math.sin(angle) * outwardSpeed,
    life = randomRange(PARTICLE_LIFE_MIN, PARTICLE_LIFE_MAX),
    maxLife = 0,
    radius = randomRange(PARTICLE_SIZE_MIN, PARTICLE_SIZE_MAX),
    grow = randomRange(0.06, 0.16),
  }
  p.maxLife = p.life
  table.insert(self.particles, p)
end

function Sun:update(dt)
  local timeScale = (state and state.timeScale) or 1
  local scaledDt = dt * timeScale

  -- Pulse timer
  self.pulseTime = self.pulseTime + scaledDt * PULSE_SPEED

  -- Emit new particles
  self.emitTimer = self.emitTimer - scaledDt
  if self.emitTimer <= 0 then
    for i = 1, PARTICLE_COUNT do
      self:spawnParticle()
    end
    self.emitTimer = PARTICLE_INTERVAL * randomRange(0.6, 1.2)
  end

  -- Update existing particles
  for i = #self.particles, 1, -1 do
    local p = self.particles[i]

    p.x = p.x + p.vx * scaledDt * 60
    p.y = p.y + p.vy * scaledDt * 60

    p.vx = p.vx * (0.97 ^ timeScale)
    p.vy = p.vy * (0.97 ^ timeScale)

    p.radius = p.radius + p.grow * scaledDt * 60
    p.life = p.life - scaledDt * 60

    if p.life <= 0 or p.radius > 14 then
      table.remove(self.particles, i)
    end
  end
end

function Sun:draw()
  local x, y = self.pos.x, self.pos.y

  -- Smooth pulse value between -1 and 1
  local pulse = math.sin(self.pulseTime)
  local radiusScale = 1 + pulse * PULSE_AMOUNT
  local intensityScale = 1 + pulse * PULSE_INTENSITY

  local r = self.radius * radiusScale
  local intensity = SUN_INTENSITY * intensityScale

  -- Soft corona
  love.graphics.setColor(1.0, 0.35, 0.05, 0.22 * intensity)
  love.graphics.draw(sunMesh, x, y, 0, r * 2.1, r * 2.1)

  -- Mid glow
  love.graphics.setColor(1.0, 0.55, 0.12, 0.35 * intensity)
  love.graphics.draw(sunMesh, x, y, 0, r * 1.35, r * 1.35)

  -- Main body
  love.graphics.setColor(1.0, 0.78, 0.25, 0.9 * intensity)
  love.graphics.draw(sunMesh, x, y, 0, r * 0.95, r * 0.95)

  -- Hot core
  love.graphics.setColor(1.0, 0.93, 0.55, 1.0 * intensity)
  love.graphics.draw(sunMesh, x, y, 0, r * 0.55, r * 0.55)

  -- Brightest centre
  love.graphics.setColor(1.0, 0.98, 0.85, 1.0 * intensity)
  love.graphics.draw(sunMesh, x, y, 0, r * 0.25, r * 0.25)

  -- Flame particles
  for _, p in ipairs(self.particles) do
    local t = 1 - (p.life / p.maxLife)

    local pr = PARTICLE_START_COLOR[1] + (PARTICLE_END_COLOR[1] - PARTICLE_START_COLOR[1]) * t
    local pg = PARTICLE_START_COLOR[2] + (PARTICLE_END_COLOR[2] - PARTICLE_START_COLOR[2]) * t
    local pb = PARTICLE_START_COLOR[3] + (PARTICLE_END_COLOR[3] - PARTICLE_START_COLOR[3]) * t
    local alpha = PARTICLE_START_ALPHA + (PARTICLE_END_ALPHA - PARTICLE_START_ALPHA) * t

    love.graphics.setColor(pr, pg, pb, alpha)
    love.graphics.circle("fill", p.x, p.y, p.radius)
  end

  love.graphics.setColor(1, 1, 1, 1)
end

return Sun