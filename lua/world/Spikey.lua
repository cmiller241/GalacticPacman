-- lua/world/Spikey.lua
--
-- A gray, metallic hazard ringed with rotating off-white spikes that
-- kills the player on contact. Deliberately NOT a planet/planetoid —
-- it doesn't live in state.planetoids at all, so it has no gravity, no
-- onSurface landing/orbital walking around it, and isn't even
-- pull-targetable (TargetLock/GravitySystem never see it). It's just a
-- solid, impassable obstacle: CollisionSystem:handlePlayerSpikeyCollisions
-- stops the player at its boundary from any approach angle and sets
-- touchingWall/wallContactNormal exactly like an ordinary TiledTerrain
-- wall does, so the EXISTING wall-jump code in Player:jump() is what
-- lets him "jump off of it" — no separate escape mechanism needed.
--
-- Stationary (no drifting/orbiting) — placed via Tiled's Object Layer
-- (tiled/Level1.lua, class = "Spikey") — see TiledTerrain.lua's
-- spikeySpawns and main.lua's own spawn loop, the same point-placement
-- convention Sphere.lua uses. Only the spike RING itself still spins
-- slowly — a purely decorative flourish, unrelated to the body's own
-- (fixed) position.

local Vector2 = require("lua.vector2")
local state = require("lua.state")
local GlowOrb = require("lua.effects.GlowOrb")

local Spikey = {}
Spikey.__index = Spikey

-- The core reads as a small, dark nucleus with a much longer ring of
-- spikes reaching out from it (15+18=33 total reach), not a big body
-- with a small texture detail on top — the spikes are the dangerous/
-- menacing part, not the core.
Spikey.DEFAULT_RADIUS = 15

-- GPU-shaded body (see lua/effects/GlowOrb.lua) — noticeably DARKER
-- than Sphere.lua's own silvery colors, so the core itself reads as a
-- dim, dangerous nucleus rather than a friendly landmark, and a warm
-- reddish glow (instead of Sphere's cool blue-white) reinforces
-- "hazard" specifically.
local ORB_COLORS = {
  dark = { 0.05, 0.05, 0.06 },
  light = { 0.28, 0.26, 0.26 },
  rim = { 0.55, 0.42, 0.4 },
  glow = { 0.55, 0.18, 0.15 },
}

local SPIKE_COLOR = { 0.94, 0.93, 0.90, 1 } -- bright off-white, standing out sharply against the dark core
local SPIKE_HEIGHT = 18
local SPIKE_SPACING = 6
-- Radians per baseline (60fps) frame's worth of shared time — same
-- units/scaling convention WaterPlanet.lua's own WAVE_SPEED uses.
local SPIKE_ROTATION_SPEED = 0.02

----------------------------------------------------------------------
-- Shared spin clock — one value read by every Spikey's own :draw(),
-- same "advance explicitly once per frame from main.lua" convention
-- WaterPlanet.lua/Lava.lua already use for their own shared clocks
-- (see main.lua's own updateSharedClock calls), rather than each
-- instance needing its own :update() wired up just to advance a
-- private timer — nothing else about a stationary landmark like this
-- one ever needs per-instance updating.
----------------------------------------------------------------------

local sharedSpin = 0

function Spikey.updateSharedClock()
  local timeScale = state.timeScale or 1
  sharedSpin = sharedSpin + SPIKE_ROTATION_SPEED * timeScale
end

-- A ring of thin triangles, base resting on the body's own circle, tip
-- poking out SPIKE_HEIGHT further. numSpikes is derived from the
-- body's own circumference (SPIKE_SPACING apart) rather than a fixed
-- count, so a bigger Spikey gets proportionally more spikes instead of
-- the same handful stretched thin around a larger circle.
local function drawSpikes(x, y, radius, rotation)
  local numSpikes = math.max(3, math.floor(2 * math.pi * radius / SPIKE_SPACING))
  local angleStep = 2 * math.pi / numSpikes
  local halfBaseAngle = angleStep / 2

  love.graphics.setColor(SPIKE_COLOR)
  for i = 0, numSpikes - 1 do
    local angle = i * angleStep + rotation
    local leftAngle = angle - halfBaseAngle
    local rightAngle = angle + halfBaseAngle
    local baseLeftX, baseLeftY = x + math.cos(leftAngle) * radius, y + math.sin(leftAngle) * radius
    local baseRightX, baseRightY = x + math.cos(rightAngle) * radius, y + math.sin(rightAngle) * radius
    local tipX, tipY = x + math.cos(angle) * (radius + SPIKE_HEIGHT), y + math.sin(angle) * (radius + SPIKE_HEIGHT)
    love.graphics.polygon("fill", baseLeftX, baseLeftY, tipX, tipY, baseRightX, baseRightY)
  end
end

-- x, y: world position of the hazard's CENTER. radius: collision +
-- visual body radius (spikes extend SPIKE_HEIGHT further out).
function Spikey.new(x, y, radius)
  local self = setmetatable({}, Spikey)
  self.pos = Vector2.new(x, y)
  self.radius = radius or Spikey.DEFAULT_RADIUS
  return self
end

function Spikey:draw()
  GlowOrb.draw(self.pos.x, self.pos.y, self.radius, ORB_COLORS, {
    glowRadiusMult = 1.3,
    glowStrength = 0.4,
    rimStrength = 0.35,
  })
  drawSpikes(self.pos.x, self.pos.y, self.radius, sharedSpin)
  love.graphics.setColor(1, 1, 1, 1)
end

return Spikey
