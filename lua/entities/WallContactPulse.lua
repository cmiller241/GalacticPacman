-- lua/entities/WallContactPulse.lua
--
-- A small, subtle expanding-and-fading ring — visual feedback for a wall
-- jump's kick-off point. Same "expanding fading ring" idea
-- Explosion.lua's own shockwave uses, just much smaller, quicker, and
-- more subdued: no core flash, no particle burst (Player.lua's own dust
-- puff already covers that role for a wall jump), just the ring.

local Vector2 = require("lua.vector2")

local PULSE_DURATION = 0.25 -- seconds
local PULSE_MAX_RADIUS = 22
local PULSE_MAX_ALPHA = 0.5 -- capped well under full opacity to read as subtle, not flashy

local WallContactPulse = {}
WallContactPulse.__index = WallContactPulse

function WallContactPulse.new(x, y)
  local self = setmetatable({}, WallContactPulse)
  self.pos = Vector2.new(x, y)
  self.startTime = love.timer.getTime()
  return self
end

function WallContactPulse:isDead()
  return love.timer.getTime() - self.startTime >= PULSE_DURATION
end

-- Purely time-driven; nothing to simulate beyond the elapsed clock read
-- in :draw()/:isDead(), same as Explosion.lua's own no-op update().
function WallContactPulse:update() end

function WallContactPulse:draw()
  local t = math.min((love.timer.getTime() - self.startTime) / PULSE_DURATION, 1)
  local eased = 1 - (1 - t) ^ 2 -- quick expand, settles near the end

  love.graphics.setColor(1, 1, 1, (1 - t) * PULSE_MAX_ALPHA)
  love.graphics.setLineWidth(2)
  love.graphics.circle("line", self.pos.x, self.pos.y, eased * PULSE_MAX_RADIUS)
  love.graphics.setLineWidth(1)
  love.graphics.setColor(1, 1, 1, 1)
end

return WallContactPulse
