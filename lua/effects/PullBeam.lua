-- lua/effects/PullBeam.lua
--
-- Port of js/effects/PullBeam.js
-- Draws the light-blue pull beam + electric strands + target outline
-- while the player is actively pulling toward a planet.

local state = require("lua.state")

local BEAM_GLOW_WIDTH   = 13
local BEAM_CORE_WIDTH   = 4
local OUTLINE_GLOW_WIDTH = 9
local OUTLINE_CORE_WIDTH = 3
local OUTLINE_PADDING   = 8

local WAVE_AMPLITUDE      = 5
local WAVE_FREQUENCY      = 0.05
local WAVE_FREQUENCY_2    = 0.065
local WAVE_SPEED          = 12          -- radians per second (was 0.012 per ms)
local WAVE_SAMPLE_SPACING = 8
local WAVE_GLOW_WIDTH     = 4
local WAVE_CORE_WIDTH     = 1.5

local function buildWavePoints(originX, originY, dirX, dirY, perpX, perpY, beamLength, frequency, phaseOffset, now)
  local points = {}
  local numSamples = math.max(2, math.floor(beamLength / WAVE_SAMPLE_SPACING))
  for i = 0, numSamples do
    local s = (i / numSamples) * beamLength
    local wave = WAVE_AMPLITUDE * math.sin(s * frequency - now * WAVE_SPEED + phaseOffset)
    table.insert(points, {
      x = originX + dirX * s + perpX * wave,
      y = originY + dirY * s + perpY * wave,
    })
  end
  return points
end

local function strokePolyline(points, width, r, g, b, a)
  if #points < 2 then return end
  love.graphics.setLineWidth(width)
  love.graphics.setColor(r, g, b, a)
  for i = 1, #points - 1 do
    local p1 = points[i]
    local p2 = points[i + 1]
    love.graphics.line(p1.x, p1.y, p2.x, p2.y)
  end
end

local function drawPullIndicator()
  local player = state.player
  if not player or not player.pullTarget or player.mode ~= "space" then
    return
  end

  local target = player.pullTarget
  local now = love.timer.getTime()
  local pulse = (math.sin(now * 6) + 1) / 2   -- ~0..1 breathing

  local originX = (player.aimShoulderPos and player.aimShoulderPos.x) or player.pos.x
  local originY = (player.aimShoulderPos and player.aimShoulderPos.y) or player.pos.y

  local dx = target.pos.x - originX
  local dy = target.pos.y - originY
  local beamLength = math.sqrt(dx * dx + dy * dy)

  -- Straight beam
  love.graphics.setLineWidth(BEAM_GLOW_WIDTH)
  love.graphics.setColor(120/255, 210/255, 255/255, 0.35 * (0.4 + pulse * 0.3))
  love.graphics.line(originX, originY, target.pos.x, target.pos.y)

  love.graphics.setLineWidth(BEAM_CORE_WIDTH)
  love.graphics.setColor(120/255, 210/255, 255/255, 0.7 + pulse * 0.3)
  love.graphics.line(originX, originY, target.pos.x, target.pos.y)

  -- Electric wave strands
  if beamLength > 1e-3 then
    local dirX, dirY = dx / beamLength, dy / beamLength
    local perpX, perpY = -dirY, dirX

    local strand1 = buildWavePoints(originX, originY, dirX, dirY, perpX, perpY, beamLength, WAVE_FREQUENCY, 0, now)
    local strand2 = buildWavePoints(originX, originY, dirX, dirY, perpX, perpY, beamLength, WAVE_FREQUENCY_2, math.pi, now)

    local glowA = 0.4 * (0.3 + pulse * 0.25)
    strokePolyline(strand1, WAVE_GLOW_WIDTH, 215/255, 246/255, 255/255, glowA)
    strokePolyline(strand2, WAVE_GLOW_WIDTH, 215/255, 246/255, 255/255, glowA)

    local coreA = 0.6 + pulse * 0.3
    strokePolyline(strand1, WAVE_CORE_WIDTH, 215/255, 246/255, 255/255, coreA)
    strokePolyline(strand2, WAVE_CORE_WIDTH, 215/255, 246/255, 255/255, coreA)
  end

  -- Outline around the target
  if target.isRoundedRect then
    -- Simple fallback: still draw a circle-ish outline for now
    love.graphics.setLineWidth(OUTLINE_GLOW_WIDTH)
    love.graphics.setColor(120/255, 210/255, 255/255, 0.3 * (0.4 + pulse * 0.4))
    love.graphics.circle("line", target.pos.x, target.pos.y, (target.halfWidth or target.radius) + OUTLINE_PADDING)

    love.graphics.setLineWidth(OUTLINE_CORE_WIDTH)
    love.graphics.setColor(120/255, 210/255, 255/255, 0.7 + pulse * 0.3)
    love.graphics.circle("line", target.pos.x, target.pos.y, (target.halfWidth or target.radius) + OUTLINE_PADDING)
  else
    love.graphics.setLineWidth(OUTLINE_GLOW_WIDTH)
    love.graphics.setColor(120/255, 210/255, 255/255, 0.3 * (0.4 + pulse * 0.4))
    love.graphics.circle("line", target.pos.x, target.pos.y, target.radius + OUTLINE_PADDING)

    love.graphics.setLineWidth(OUTLINE_CORE_WIDTH)
    love.graphics.setColor(120/255, 210/255, 255/255, 0.7 + pulse * 0.3)
    love.graphics.circle("line", target.pos.x, target.pos.y, target.radius + OUTLINE_PADDING)
  end

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.setLineWidth(1)
end

return {
  draw = drawPullIndicator,
}