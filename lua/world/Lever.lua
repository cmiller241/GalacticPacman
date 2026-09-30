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
-- Controls a single Gate for now (self.gate, wired directly in
-- main.lua right after both are spawned) — pulling it toggles that
-- gate open/closed. A more general many-levers-to-many-gates linking
-- system can replace this one direct reference later without changing
-- anything else about how the lever itself works.

local state = require("lua.state")
local Vector2 = require("lua.vector2")

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

local COLOR_BASE = { 0.25, 0.26, 0.28 }
local COLOR_BASE_RIM = { 0.45, 0.47, 0.5 }
local COLOR_HANDLE = { 0.75, 0.15, 0.12 }
local COLOR_PIVOT = { 0.12, 0.12, 0.13 }

-- x, y: world position of the lever's own ground anchor (the flat
-- base's own center) — same "sits exactly on the ground" convention
-- Ooomba/RobotButler use for their own center-bottom anchor.
function Lever.new(x, y)
  local self = setmetatable({}, Lever)

  self.pos = Vector2.new(x, y)
  -- Which Gate this lever opens/closes — set directly by main.lua for
  -- now (see this file's own header comment).
  self.gate = nil

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

-- Called from InputHandlers.lua (Enter) and GamePadInput.lua (Circle) —
-- both just call this unconditionally on their own press; it's the one
-- place that actually decides whether the player's close enough to
-- reach it.
function Lever:tryInteract(player)
  if not self:isPlayerNear(player) then return end
  self.isOn = not self.isOn
  if self.gate then
    self.gate:setOpen(self.isOn)
  end
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

  -- Half-circle base plate, flat side down (resting on the ground) —
  -- angle range pi..2*pi sweeps left -> straight up -> right. A 180
  -- degree "pie" slice is identical to a plain half-disc here (its own
  -- two straight edges lie flush along the flat diameter line), so the
  -- default fill arctype needs no special-casing.
  love.graphics.setColor(COLOR_BASE)
  love.graphics.arc("fill", x, y, BASE_RADIUS, math.pi, math.pi * 2)
  love.graphics.setColor(COLOR_BASE_RIM)
  love.graphics.setLineWidth(2)
  love.graphics.arc("line", "open", x, y, BASE_RADIUS, math.pi, math.pi * 2)
  love.graphics.line(x - BASE_RADIUS, y, x + BASE_RADIUS, y)

  -- Handle, pivoting at the base's own center.
  local tipX = x + math.cos(self.handleAngle) * HANDLE_LENGTH
  local tipY = y + math.sin(self.handleAngle) * HANDLE_LENGTH
  love.graphics.setColor(COLOR_HANDLE)
  love.graphics.setLineWidth(8)
  love.graphics.line(x, y, tipX, tipY)
  love.graphics.circle("fill", tipX, tipY, HANDLE_KNOB_RADIUS)

  love.graphics.setColor(COLOR_PIVOT)
  love.graphics.circle("fill", x, y, 6)

  love.graphics.setLineWidth(1)
  love.graphics.setColor(1, 1, 1, 1)
end

local TOOLTIP_TEXT = "Press ENTER / Circle to pull"
local TOOLTIP_PAD_X, TOOLTIP_PAD_Y = 12, 8
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

  local font = love.graphics.getFont()
  local textW = font:getWidth(TOOLTIP_TEXT)
  local textH = font:getHeight()
  local pillW = textW + TOOLTIP_PAD_X * 2
  local pillH = textH + TOOLTIP_PAD_Y * 2

  local bob = math.sin(love.timer.getTime() * 3) * 4
  local pillX = self.pos.x - pillW / 2
  local pillY = self.pos.y - BASE_RADIUS - TOOLTIP_GAP_ABOVE - pillH + bob

  love.graphics.setColor(0, 0, 0, 0.6)
  love.graphics.rectangle("fill", pillX, pillY, pillW, pillH, pillH / 2, pillH / 2)
  love.graphics.setColor(1, 1, 1, 0.9)
  love.graphics.rectangle("line", pillX, pillY, pillW, pillH, pillH / 2, pillH / 2)
  love.graphics.print(TOOLTIP_TEXT, pillX + TOOLTIP_PAD_X, pillY + TOOLTIP_PAD_Y)
  love.graphics.setColor(1, 1, 1, 1)
end

return Lever
