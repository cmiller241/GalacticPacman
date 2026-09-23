-- lua/effects/InfluenceRing.lua
--
-- Port of js/world/Planetoid.js's dashed influence-radius ring (see that
-- file's own ringCanvas/createRingCanvas) — a visual debug aid showing
-- how far a planetoid's gravity actually reaches, toggled with 'R' (see
-- InputHandlers.lua). The JS version baked the dashed stroke into an
-- offscreen canvas once per planet and blitted it every frame; LÖVE has
-- no dashed-line primitive to bake in the first place (love.graphics.line
-- only ever draws solid segments), so this draws the dashes directly as
-- short chords around the circle instead — cheap enough not to need
-- baking, since it only ever runs for on-screen planetoids while the
-- toggle is on (same cost class as the existing collision-debug overlay).

local InfluenceRing = {}

local DASH_LENGTH = 10
local GAP_LENGTH = 5
local LINE_WIDTH = 3
local COLOR = { 173 / 255, 216 / 255, 230 / 255 }

-- alpha: same per-planet cachedAlpha the JS version blended the baked
-- ring in with (see Planetoid:updateCachedAlpha) — fades the ring out
-- for planets far from the player instead of cluttering the whole
-- screen with them at full strength.
function InfluenceRing.draw(x, y, radius, alpha)
  if radius <= 0 or alpha <= 0 then return end

  local period = DASH_LENGTH + GAP_LENGTH
  local circumference = 2 * math.pi * radius
  -- Whole number of dash+gap periods around the circle, so the pattern
  -- joins up cleanly instead of leaving one oddly-sized dash where it
  -- wraps back to the start.
  local segmentCount = math.max(1, math.floor(circumference / period))
  local angleStep = (2 * math.pi) / segmentCount
  local dashAngle = angleStep * (DASH_LENGTH / period)

  love.graphics.setColor(COLOR[1], COLOR[2], COLOR[3], alpha)
  love.graphics.setLineWidth(LINE_WIDTH)
  for i = 0, segmentCount - 1 do
    local a0 = i * angleStep
    local a1 = a0 + dashAngle
    love.graphics.line(
      x + math.cos(a0) * radius, y + math.sin(a0) * radius,
      x + math.cos(a1) * radius, y + math.sin(a1) * radius
    )
  end

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.setLineWidth(1)
end

return InfluenceRing
