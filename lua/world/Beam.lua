-- lua/world/Beam.lua
--
-- A planted teleporter: a glowing particle beam shooting out from a
-- fixed anchor point, interactable the same way Lever.lua/RobotButler.lua/
-- Fisherman.lua already are (Enter / gamepad Circle, while standing
-- close enough — see :tryInteract/:isPlayerNear) — pressing it sends the
-- player to another Beam's own portal position (see :getPortalPosition),
-- paired up as a simple two-way link by whichever code spawns them (see
-- main.lua's own comment on its current home<->belt pair).
--
-- Visually ported from the old JS game's js/world/BeamPlanetoid.js (the
-- beam itself, and its "particles drift from the base toward the tip,
-- fading as they go" stream) — deliberately WITHOUT the maze/platform
-- "interior" concept that version tied a beam to (this is just a
-- point-to-point teleporter between two ordinary world positions, not an
-- entrance into a separate scene, so none of that machinery is needed
-- here), and WITHOUT that version's separate radial "portal" particle
-- burst at the tip — the teleport moment itself now gets its own
-- feedback from Player:getTeleportPulse's scale/glow blip instead (see
-- that function's own header comment), so the beam itself only ever
-- needs the one steady, ambient stream.
--
-- The beam's own glow also fades smoothly from the planted base to
-- nothing at the tip (a gradient, same as the JS original's own
-- ctx.createLinearGradient) rather than stopping with a hard edge —
-- LÖVE has no direct equivalent to a Canvas2D gradient stroke, so this
-- is approximated with many short segments of linearly decreasing alpha
-- (see drawFadingLine below) instead.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local InteractPrompt = require("lua.ui.InteractPrompt")

local Beam = {}
Beam.__index = Beam

Beam.LENGTH = 140
Beam.WIDTH = 14
Beam.PARTICLE_RADIUS = 3
Beam.DEFAULT_COLOR = { 0.65, 0.25, 1.0 } -- violet — distinct from Lever/Gate's own grays/reds

-- How many short slivers drawFadingLine below splits the beam's own
-- length into — fine enough that the alpha step between adjacent
-- slivers is imperceptible (reads as a smooth gradient), without being
-- excessive given this only ever runs for 2 beams at once right now.
local GRADIENT_SEGMENTS = 24

-- x, y: the beam's own planted/anchor point — same "already resting
-- exactly on a surface" convention Lever.lua's own x/y uses (whoever
-- spawns one is responsible for placing it correctly, same as Lever).
-- angle: which way it shoots, in this engine's own atan2/
-- love.graphics.rotate convention (0 = +x/right, increasing clockwise —
-- see Lever.lua's own matching comment) — away from whatever surface
-- it's planted on. color: {r,g,b} 0-1, used for both the beam's own
-- glow and its particle streams; defaults to Beam.DEFAULT_COLOR.
function Beam.new(x, y, angle, color)
  local self = setmetatable({}, Beam)
  self.pos = Vector2.new(x, y)
  self.angle = angle or -math.pi / 2
  self.color = color or Beam.DEFAULT_COLOR

  -- Which OTHER Beam this one sends the player to — nil until whatever
  -- spawns a pair of these wires them together (see main.lua), in which
  -- case :tryInteract below is simply a no-op rather than erroring.
  self.destination = nil

  self.beamParticles = {}

  self.interactRadius = 120
  self.playerNearby = false

  return self
end

-- The point particles gather at, and where a player arriving HERE (via
-- the other end's own :tryInteract) actually lands — the far tip of the
-- beam, not the planted base, same "portal position" concept
-- BeamPlanetoid.js's own getPortalPosition used.
function Beam:getPortalPosition()
  return Vector2.new(
    self.pos.x + math.cos(self.angle) * Beam.LENGTH,
    self.pos.y + math.sin(self.angle) * Beam.LENGTH)
end

function Beam:isPlayerNear(player)
  if not player then return false end
  local dx, dy = player.pos.x - self.pos.x, player.pos.y - self.pos.y
  return (dx * dx + dy * dy) <= self.interactRadius * self.interactRadius
end

-- Called from InputHandlers.lua (Enter) and GamePadInput.lua (Circle) —
-- both just call this unconditionally on their own press; it's the one
-- place that actually decides whether the player's close enough AND
-- this beam actually goes anywhere. The teleport's own visual cue is
-- entirely Player:getTeleportPulse's own scale/glow blip now (see this
-- file's own header comment) — nothing extra to trigger here beyond the
-- state change itself.
function Beam:tryInteract(player)
  if not self.destination then return end
  if not self:isPlayerNear(player) then return end
  if player.isTeleporting then return end
  player:startTeleport(self, self.destination)
end

function Beam:update()
  local ts = state.timeScale or 1
  self.playerNearby = self:isPlayerNear(state.player)

  -- Ambient beam particles: small motes spawned at the planted base,
  -- drifting along the beam's own length toward the tip with a little
  -- sideways scatter, fading out as their own life runs down (and, since
  -- they travel at roughly constant speed, that's also roughly "the
  -- further toward the tip, the more transparent") — same per-tick
  -- spawn-chance approach BeamPlanetoid.js's own spawnBeamParticles used.
  if math.random() < 0.6 then
    local dirX, dirY = math.cos(self.angle), math.sin(self.angle)
    local sideX, sideY = -dirY, dirX
    local sideAmt = (math.random() - 0.5) * 1.5
    local speed = 2 + math.random() * 2
    table.insert(self.beamParticles, {
      pos = Vector2.new(self.pos.x, self.pos.y),
      vel = Vector2.new(dirX * speed + sideX * sideAmt, dirY * speed + sideY * sideAmt),
      life = 50, maxLife = 50,
    })
  end

  for i = #self.beamParticles, 1, -1 do
    local p = self.beamParticles[i]
    p.pos:addScaled(p.vel, ts)
    p.life = p.life - ts
    if p.life <= 0 then table.remove(self.beamParticles, i) end
  end
end

-- Draws a straight line from (x1,y1) to (x2,y2) as GRADIENT_SEGMENTS
-- short slivers, alpha stepping from baseAlpha (at x1,y1) down to
-- (almost) 0 at (x2,y2) — see this file's own header comment for why
-- (no direct LÖVE equivalent to a Canvas2D gradient stroke).
local function drawFadingLine(x1, y1, x2, y2, width, r, g, b, baseAlpha)
  love.graphics.setLineWidth(width)
  for i = 1, GRADIENT_SEGMENTS do
    local t0 = (i - 1) / GRADIENT_SEGMENTS
    local t1 = i / GRADIENT_SEGMENTS
    -- Alpha at the SEGMENT'S OWN midpoint, not t0 — the very first
    -- sliver (right at the base) then reads at very close to full
    -- baseAlpha instead of a hair dimmer, and the very last sliver fades
    -- most of the way to 0 rather than stopping short of it.
    local midT = (t0 + t1) / 2
    love.graphics.setColor(r, g, b, baseAlpha * (1 - midT))
    love.graphics.line(
      x1 + (x2 - x1) * t0, y1 + (y2 - y1) * t0,
      x1 + (x2 - x1) * t1, y1 + (y2 - y1) * t1)
  end
end

-- LÖVE has no native canvas blur the way BeamPlanetoid.js's own
-- shadowBlur used — faked here with a few progressively wider, dimmer
-- additive-blended passes instead (same "layered soft strokes" trick
-- GlowOrb.lua's own rim uses), under a bright core stroke on top, each
-- one individually faded base-to-tip via drawFadingLine above.
function Beam:draw()
  local dirX, dirY = math.cos(self.angle), math.sin(self.angle)
  local startX, startY = self.pos.x, self.pos.y
  local endX, endY = startX + dirX * Beam.LENGTH, startY + dirY * Beam.LENGTH
  local r, g, b = self.color[1], self.color[2], self.color[3]

  love.graphics.setBlendMode("add")
  for i = 3, 1, -1 do
    drawFadingLine(startX, startY, endX, endY, Beam.WIDTH + i * 10, r, g, b, 0.10 * i)
  end
  drawFadingLine(startX, startY, endX, endY, Beam.WIDTH, r, g, b, 0.9)
  drawFadingLine(startX, startY, endX, endY, 4, 1, 1, 1, 0.8)

  for _, p in ipairs(self.beamParticles) do
    local alpha = p.life / p.maxLife
    love.graphics.setColor(1, 1, 1, alpha)
    love.graphics.circle("fill", p.pos.x, p.pos.y, Beam.PARTICLE_RADIUS)
  end

  love.graphics.setBlendMode("alpha")
  love.graphics.setLineWidth(1)
  love.graphics.setColor(1, 1, 1, 1)
end

local TOOLTIP_GAP_ABOVE = 26

-- World-space "you can interact with this" hint — same convention
-- Lever.lua/RobotButler.lua/Fisherman.lua's own :drawTooltip already
-- use. Not shown while curled into a ball (can't interact at all then —
-- see the input-handler guards) or already mid-teleport, or if this
-- particular beam has no destination wired up yet.
function Beam:drawTooltip()
  if not self.playerNearby then return end
  if not self.destination then return end
  if state.player and (state.player.isBall or state.player.isTeleporting) then return end

  -- Anchored above whichever of the planted base / portal tip sits
  -- higher on screen, not a fixed "above the base by LENGTH" offset —
  -- both of main.lua's current beams point straight up, but this stays
  -- correct regardless of angle for any future one that doesn't.
  local portal = self:getPortalPosition()
  local topX = (portal.y < self.pos.y) and portal.x or self.pos.x
  local topY = math.min(self.pos.y, portal.y)
  InteractPrompt.draw(topX, topY - TOOLTIP_GAP_ABOVE)
end

return Beam
