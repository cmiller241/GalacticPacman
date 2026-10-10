-- lua/effects/GroundPoundBurst.lua
--
-- What a ground pound looks like when it lands (see Player.lua's own
-- ground-pound bookkeeping in Player:update): a circle outline that
-- expands out from the point of contact and fades, plus a ring of dust
-- thrown outward from that same point.
--
-- The circle goes in state.explosions — it has the same update/isDead/
-- draw shape Explosion.lua does, so main.lua's existing loops over that
-- list drive it with no extra wiring (same arrangement as
-- StompBurst.lua's own ring). The dust is DustPuff.lua's.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local DustPuff = require("lua.effects.DustPuff")

local RING_DURATION = 0.45     -- seconds, wall-clock like Explosion.lua
local RING_START_RADIUS = 12
local RING_END_RADIUS = 105
local RING_START_ALPHA = 0.9
local RING_START_WIDTH = 5     -- line width at the start; thins to 1 as it spreads
local RING_COLOR = { 1, 1, 1 }

local DUST_COUNT = 22
-- World units per baseline frame, straight out from the point of
-- contact. Dust slows quickly (DustPuff's own drag), covering about ten
-- times its starting speed in total — so this is roughly 45 to 95 units
-- of travel, out to near where the ring ends up.
local DUST_SPEED = { 4.5, 9.5 }

local GroundPoundBurst = {}

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
  local eased = 1 - (1 - t) ^ 3 -- bursts out fast, settles as it reaches full size
  local radius = RING_START_RADIUS + (RING_END_RADIUS - RING_START_RADIUS) * eased

  love.graphics.setColor(RING_COLOR[1], RING_COLOR[2], RING_COLOR[3], RING_START_ALPHA * (1 - t))
  love.graphics.setLineWidth(1 + (RING_START_WIDTH - 1) * (1 - t))
  love.graphics.circle("line", self.x, self.y, radius)

  love.graphics.setLineWidth(1)
  love.graphics.setColor(1, 1, 1, 1)
end

-- x, y: the point of contact (where he hits the ground). up: unit
-- vector pointing away from the ground there — straight up the screen
-- if omitted.
function GroundPoundBurst.spawn(x, y, up)
  up = up or Vector2.new(0, -1)

  state.explosions = state.explosions or {}
  table.insert(state.explosions, setmetatable({ x = x, y = y, startTime = love.timer.getTime() }, Ring))

  DustPuff.spawnRadial(Vector2.new(x, y), up, DUST_COUNT, DUST_SPEED[1], DUST_SPEED[2])
end

return GroundPoundBurst
