-- lua/effects/StompBurst.lua
--
-- The "squashed it flat" punctuation for stomping an Ooomba (see
-- Ooomba.lua's own :updateSquash and main.lua's own Ooomba pass): a
-- burst of particles kicked up from under the player's feet, plus a
-- ring that expands a little while fading out.
--
-- The ring goes in state.explosions — it has the same update/isDead/
-- draw shape Explosion.lua does, so main.lua's existing loops over that
-- list drive it with no extra wiring. Particles are ordinary shared
-- Particle.lua ones in state.particles.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local Particle = require("lua.entities.Particle")
local DustPuff = require("lua.effects.DustPuff")

local RING_DURATION = 0.4      -- seconds, wall-clock like Explosion.lua
local RING_START_RADIUS = 14
local RING_END_RADIUS = 62
local RING_START_ALPHA = 0.85
local RING_COLOR = { 1, 0.96, 0.8 }

local SPARK_COUNT = 16
local DUST_COUNT = 10

local StompBurst = {}

local Ring = {}
Ring.__index = Ring

function Ring:isDead()
  return love.timer.getTime() - self.startTime >= RING_DURATION
end

function Ring:update()
  -- Purely time-driven, same as Explosion.lua.
end

function Ring:draw()
  local t = math.min((love.timer.getTime() - self.startTime) / RING_DURATION, 1)
  local eased = 1 - (1 - t) ^ 2 -- quick at first, easing off as it spreads
  local radius = RING_START_RADIUS + (RING_END_RADIUS - RING_START_RADIUS) * eased
  local alpha = RING_START_ALPHA * (1 - t)

  love.graphics.setColor(RING_COLOR[1], RING_COLOR[2], RING_COLOR[3], alpha * 0.25)
  love.graphics.circle("fill", self.x, self.y, radius)
  love.graphics.setColor(RING_COLOR[1], RING_COLOR[2], RING_COLOR[3], alpha)
  love.graphics.setLineWidth(3 * (1 - t) + 1)
  love.graphics.circle("line", self.x, self.y, radius)

  love.graphics.setLineWidth(1)
  love.graphics.setColor(1, 1, 1, 1)
end

-- x, y: world position of the player's feet (ground level) at the
-- moment the Ooomba went flat.
function StompBurst.spawn(x, y)
  local pos = Vector2.new(x, y)

  -- Bright sparks fanned out over the upper half only — sideways and
  -- up, never down into the ground he's standing on.
  for _ = 1, SPARK_COUNT do
    local angle = -math.random() * math.pi
    local speed = 2.5 + math.random() * 5
    local particle = Particle.new(pos, Vector2.new(math.cos(angle) * speed, math.sin(angle) * speed * 0.7), 20 + math.random() * 14)
    particle.color = { 1, 0.85 + math.random() * 0.15, 0.45 + math.random() * 0.35 }
    particle.radius = 2 + math.random() * 2
    particle.drag = 0.9
    table.insert(state.particles, particle)
  end

  -- Plus a wide, low skirt of the usual footstep dust.
  DustPuff.spawn(pos, Vector2.new(0, 1), Vector2.new(1, 0), DUST_COUNT, 9, 0.3, 1.8)

  state.explosions = state.explosions or {}
  table.insert(state.explosions, setmetatable({ x = x, y = y, startTime = love.timer.getTime() }, Ring))
end

return StompBurst
