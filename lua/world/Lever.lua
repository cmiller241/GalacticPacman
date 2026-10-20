-- lua/world/Lever.lua
--
-- A ground-mounted pull-lever: a half-circle base plate (flat side
-- resting on the ground) with a handle that pivots between an
-- angled-left ("off"/closed) and angled-right ("on"/open) resting
-- position. Placed on the ground the same way Ooomba is (see main.lua's
-- own spawn loop — the Tiled object's point is raycast straight down
-- onto whatever TerrainShape surface sits below it, landing self.pos
-- exactly on that surface rather than needing pixel-perfect placement
-- in Tiled itself).
--
-- Controls a single Gate, named in Tiled via this Lever object's own
-- "gate" custom property (that Gate object's Tiled id) — resolved to
-- the actual spawned Gate in main.lua, once both lists exist, and
-- stored directly on self.gate. Pulling the lever toggles that gate
-- open/closed.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local InteractPrompt = require("lua.ui.InteractPrompt")

local Lever = {}
Lever.__index = Lever

local BASE_RADIUS = 40
local HANDLE_LENGTH = 46
local HANDLE_KNOB_RADIUS = 8

-- Both measured from straight up (-pi/2, this engine's own atan2/
-- love.graphics.rotate convention: 0 = +x/right, increasing clockwise
-- since y grows downward) — the handle rests at ANGLE_OFF while closed,
-- and swings to ANGLE_ON once pulled.
local ANGLE_UP = -math.pi / 2
local ANGLE_SPREAD = math.pi / 5 -- ~36 degrees either side of straight up
local ANGLE_OFF = ANGLE_UP - ANGLE_SPREAD -- angled left
local ANGLE_ON = ANGLE_UP + ANGLE_SPREAD  -- angled right

local HANDLE_SWING_SPEED = 0.12 -- radians per baseline (60fps) tick

-- Metal, lit from above (see baseMesh): its top and bottom shades.
local COLOR_BASE_TOP = { 0.44, 0.45, 0.48 }
local COLOR_BASE_BOTTOM = { 0.16, 0.16, 0.18 }
local COLOR_OUTLINE = { 0.07, 0.07, 0.08 }
local COLOR_FOOT = { 0.22, 0.22, 0.24 }
local COLOR_SLOT = { 0.05, 0.05, 0.06 }
local COLOR_SHAFT = { 0.62, 0.64, 0.68 }
local COLOR_SHAFT_SHADE = { 0.3, 0.31, 0.34 }
local COLOR_HANDLE = { 0.75, 0.15, 0.12 }
local COLOR_PIVOT = { 0.12, 0.12, 0.13 }
local COLOR_LAMP_OFF = { 1, 0.2, 0.12 }  -- lit while the lever's off
local COLOR_LAMP_ON = { 0.25, 1, 0.35 }  -- lit while it's on

local SLOT_RADIUS = BASE_RADIUS * 0.62  -- the arc slot the handle rides in
local LAMP_RADIUS = 4
-- Where the lamps sit on the dome: low on either side, clear of the
-- handle's whole swing.
local LAMP_DIST = BASE_RADIUS * 0.76
local LAMP_ANGLE_LEFT = math.pi + 0.32
local LAMP_ANGLE_RIGHT = math.pi * 2 - 0.32

-- The dome, as a fan (its centre on the ground line) coloured by height:
-- a vertex colour that's linear in y interpolates to exactly linear in
-- y across each triangle too, so this is an even top-lit gradient.
local baseMesh = nil
local function getBaseMesh()
  if baseMesh then return baseMesh end
  local function shade(t)
    local r = COLOR_BASE_BOTTOM[1] + (COLOR_BASE_TOP[1] - COLOR_BASE_BOTTOM[1]) * t
    local g = COLOR_BASE_BOTTOM[2] + (COLOR_BASE_TOP[2] - COLOR_BASE_BOTTOM[2]) * t
    local b = COLOR_BASE_BOTTOM[3] + (COLOR_BASE_TOP[3] - COLOR_BASE_BOTTOM[3]) * t
    return r, g, b
  end
  local r, g, b = shade(0)
  local verts = { { 0, 0, 0, 0, r, g, b, 1 } }
  local SEGMENTS = 32
  for i = 0, SEGMENTS do
    local a = math.pi + (i / SEGMENTS) * math.pi
    local vy = math.sin(a) * BASE_RADIUS
    r, g, b = shade(-vy / BASE_RADIUS)
    verts[#verts + 1] = { math.cos(a) * BASE_RADIUS, vy, 0, 0, r, g, b, 1 }
  end
  baseMesh = love.graphics.newMesh(verts, "fan", "static")
  return baseMesh
end

-- A red ball knob, shaded as if lit from the upper left.
local function drawKnob(x, y, radius, color)
  love.graphics.setColor(color[1] * 0.45, color[2] * 0.45, color[3] * 0.45, 1)
  love.graphics.circle("fill", x, y, radius + 1)
  love.graphics.setColor(color)
  love.graphics.circle("fill", x - radius * 0.12, y - radius * 0.12, radius * 0.85)
  love.graphics.setColor(math.min(1, color[1] + 0.25), color[2] + 0.2, color[3] + 0.15, 1)
  love.graphics.circle("fill", x - radius * 0.28, y - radius * 0.28, radius * 0.45)
  love.graphics.setColor(1, 1, 1, 0.85)
  love.graphics.circle("fill", x - radius * 0.38, y - radius * 0.4, radius * 0.18)
end

-- A status lamp: lit (with a soft glow round it) or dark glass.
local function drawLamp(x, y, color, lit)
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.circle("fill", x, y, LAMP_RADIUS + 1.5)
  if lit then
    love.graphics.setBlendMode("add")
    for i = 3, 1, -1 do
      love.graphics.setColor(color[1], color[2], color[3], 0.12)
      love.graphics.circle("fill", x, y, LAMP_RADIUS + i * 3)
    end
    love.graphics.setBlendMode("alpha")
    love.graphics.setColor(color)
    love.graphics.circle("fill", x, y, LAMP_RADIUS)
    love.graphics.setColor(1, 1, 1, 0.8)
    love.graphics.circle("fill", x - 1, y - 1, LAMP_RADIUS * 0.4)
  else
    love.graphics.setColor(color[1] * 0.25, color[2] * 0.25, color[3] * 0.25, 1)
    love.graphics.circle("fill", x, y, LAMP_RADIUS)
  end
end

-- x, y: world position of the lever's own ground anchor (the flat
-- base's own center) — same "sits exactly on the ground" convention
-- Ooomba/RobotButler use for their own center-bottom anchor.
function Lever.new(x, y)
  local self = setmetatable({}, Lever)

  self.pos = Vector2.new(x, y)
  -- Which Gate this lever opens/closes, resolved from this Tiled
  -- object's own "gate" custom property — set by main.lua once both
  -- lists exist (see this file's own header comment). self.gateId
  -- (the raw, not-yet-resolved Tiled id) is set alongside self directly
  -- in main.lua's own spawn loop, right after Lever.new returns.
  self.gate = nil
  self.gateId = nil

  -- False = closed/off (handle angled left) — the default resting
  -- state a level should normally start in.
  self.isOn = false
  self.handleAngle = ANGLE_OFF

  self.interactRadius = 140
  self.playerNearby = false

  return self
end

function Lever:isPlayerNear(player)
  if not player then return false end
  local dx, dy = player.pos.x - self.pos.x, player.pos.y - self.pos.y
  return (dx * dx + dy * dy) <= self.interactRadius * self.interactRadius
end

-- Actually flips the lever and whatever Gate it controls — shared by
-- :tryInteract below (the player pulling it directly) and
-- CollisionSystem:handleFireballLeverCollisions (a fireball hitting it
-- from a distance), neither of which needs to duplicate the toggle
-- logic itself.
function Lever:engage()
  self.isOn = not self.isOn
  if self.gate then
    self.gate:setOpen(self.isOn)
  end
end

-- Called from InputHandlers.lua (Enter) and GamePadInput.lua (Circle) —
-- both just call this unconditionally on their own press; it's the one
-- place that actually decides whether the player's close enough to
-- reach it.
function Lever:tryInteract(player)
  if not self:isPlayerNear(player) then return end
  self:engage()
end

function Lever:update()
  local timeScale = state.timeScale or 1
  self.playerNearby = self:isPlayerNear(state.player)

  local target = self.isOn and ANGLE_ON or ANGLE_OFF
  if self.handleAngle < target then
    self.handleAngle = math.min(target, self.handleAngle + HANDLE_SWING_SPEED * timeScale)
  elseif self.handleAngle > target then
    self.handleAngle = math.max(target, self.handleAngle - HANDLE_SWING_SPEED * timeScale)
  end
end

function Lever:draw()
  local x, y = self.pos.x, self.pos.y
  love.graphics.push("all")

  -- Half-dome base, flat side down (resting on the ground) — angle range
  -- pi..2*pi sweeps left -> straight up -> right. Shaded metal, outlined,
  -- with a highlight along its upper-left edge.
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(getBaseMesh(), x, y)
  love.graphics.setLineWidth(1.5)
  love.graphics.setColor(1, 1, 1, 0.22)
  love.graphics.arc("line", "open", x, y, BASE_RADIUS - 3, math.pi * 1.08, math.pi * 1.45)
  love.graphics.setLineWidth(2.5)
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.arc("line", "open", x, y, BASE_RADIUS, math.pi, math.pi * 2)

  -- Foot plate along the ground, bolted down at both ends.
  local footW, footH = BASE_RADIUS + 8, 5
  love.graphics.setColor(COLOR_FOOT)
  love.graphics.rectangle("fill", x - footW, y - footH, footW * 2, footH, 2, 2)
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.setLineWidth(1.5)
  love.graphics.rectangle("line", x - footW, y - footH, footW * 2, footH, 2, 2)
  for side = -1, 1, 2 do
    local bx = x + side * (footW - 4)
    love.graphics.setColor(0.55, 0.56, 0.58, 1)
    love.graphics.circle("fill", bx, y - footH / 2, 1.8)
  end

  -- The slot the handle rides in, end to end of its swing.
  love.graphics.setColor(COLOR_SLOT)
  love.graphics.setLineWidth(6)
  love.graphics.setLineStyle("smooth")
  love.graphics.arc("line", "open", x, y, SLOT_RADIUS, ANGLE_OFF, ANGLE_ON, 16)
  love.graphics.circle("fill", x + math.cos(ANGLE_OFF) * SLOT_RADIUS, y + math.sin(ANGLE_OFF) * SLOT_RADIUS, 3)
  love.graphics.circle("fill", x + math.cos(ANGLE_ON) * SLOT_RADIUS, y + math.sin(ANGLE_ON) * SLOT_RADIUS, 3)

  -- Status lamps: red while off, green while on.
  drawLamp(x + math.cos(LAMP_ANGLE_LEFT) * LAMP_DIST, y + math.sin(LAMP_ANGLE_LEFT) * LAMP_DIST,
    COLOR_LAMP_OFF, not self.isOn)
  drawLamp(x + math.cos(LAMP_ANGLE_RIGHT) * LAMP_DIST, y + math.sin(LAMP_ANGLE_RIGHT) * LAMP_DIST,
    COLOR_LAMP_ON, self.isOn)

  -- Handle, pivoting at the base's own center: a steel shaft (shaded
  -- along one side, lit along the other) ending in a red ball knob.
  local cosA, sinA = math.cos(self.handleAngle), math.sin(self.handleAngle)
  local tipX = x + cosA * HANDLE_LENGTH
  local tipY = y + sinA * HANDLE_LENGTH
  local nx, ny = -sinA, cosA  -- across the shaft
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.setLineWidth(8)
  love.graphics.line(x, y, tipX, tipY)
  love.graphics.setColor(COLOR_SHAFT_SHADE)
  love.graphics.setLineWidth(5)
  love.graphics.line(x, y, tipX, tipY)
  love.graphics.setColor(COLOR_SHAFT)
  love.graphics.setLineWidth(2)
  love.graphics.line(x - nx * 1.2, y - ny * 1.2, tipX - nx * 1.2, tipY - ny * 1.2)
  drawKnob(tipX, tipY, HANDLE_KNOB_RADIUS, COLOR_HANDLE)

  -- Pivot cap: a bolt head.
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.circle("fill", x, y, 8)
  love.graphics.setColor(0.5, 0.51, 0.54, 1)
  love.graphics.circle("fill", x, y, 6)
  love.graphics.setColor(COLOR_PIVOT)
  love.graphics.circle("fill", x, y, 2.5)

  love.graphics.pop()
end

local TOOLTIP_GAP_ABOVE = 26

-- World-space "you can interact with this" hint — same convention
-- RobotButler.lua/Fisherman.lua's own :drawTooltip already use, call
-- from inside the same camera-transformed push() block everything else
-- in the scene draws from. Not shown while curled into a ball
-- (Player.lua's own isBall) — a ball can't pull it at all (see the
-- input-handler guards in InputHandlers.lua/GamePadInput.lua), so
-- advertising the prompt then would just be misleading.
function Lever:drawTooltip()
  if not self.playerNearby then return end
  if state.player and state.player.isBall then return end

  InteractPrompt.draw(self.pos.x, self.pos.y - BASE_RADIUS - TOOLTIP_GAP_ABOVE)
end

return Lever
