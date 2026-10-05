-- lua/world/Crank.lua
--
-- A ground-mounted crank wheel: a short post topped with a circular
-- dial and a handle on its rim. Placed on the ground the same way
-- Lever.lua is (see main.lua's own spawn loop — the Tiled object's
-- point is raycast straight down onto whatever TerrainShape surface
-- sits below it, landing self.pos exactly on that surface rather than
-- needing pixel-perfect placement in Tiled itself). self.pos.x is the
-- wheel's own horizontal center — the post rises straight up from it,
-- so the wheel (and its handle's pivot) sit directly above self.pos.x
-- regardless of post/wheel size.
--
-- Each interact press gives it one crank: the handle sweeps CRANK_STEP
-- radians further around (always the same direction — a crank doesn't
-- wind back), easing into place rather than snapping. If this crank
-- names a Mirror via its own Tiled "Mirror" custom property (resolved
-- to self.mirror by main.lua's own spawn wiring, from
-- TiledTerrain.lua's crankSpawns/mirrorId), that Mirror is cranked by
-- the exact same step at the same time — see lua/world/Mirror.lua.
-- self.turns counts completed full rotations of the HANDLE — not used
-- for anything yet, but there if a future effect wants it.

local state = require("lua.state")
local Vector2 = require("lua.vector2")

local Crank = {}
Crank.__index = Crank

local POST_WIDTH = 10
local POST_HEIGHT = 34
local WHEEL_RADIUS = 26
local SPOKE_COUNT = 4
local HANDLE_LENGTH = 16 -- sticks out past the wheel's own rim
local HANDLE_KNOB_RADIUS = 7

local CRANK_STEP = math.pi / 18 -- 10 degrees per interact press
local HANDLE_SWING_SPEED = 0.2 -- radians per baseline (60fps) tick

local COLOR_POST = { 0.3, 0.31, 0.33 }
local COLOR_WHEEL = { 0.25, 0.26, 0.28 }
local COLOR_WHEEL_RIM = { 0.55, 0.57, 0.6 }
local COLOR_HANDLE = { 0.75, 0.15, 0.12 }
local COLOR_PIVOT = { 0.12, 0.12, 0.13 }

-- x, y: world position of the crank's own ground anchor (where the
-- post meets the ground) — same "sits exactly on the ground"
-- convention Ooomba/Lever/RobotButler use for their own center-bottom
-- anchor.
function Crank.new(x, y)
  local self = setmetatable({}, Crank)

  self.pos = Vector2.new(x, y)
  self.wheelCenterY = y - POST_HEIGHT - WHEEL_RADIUS

  self.angle = 0
  self.targetAngle = 0
  self.turns = 0

  -- Set by TiledTerrain.lua's own crankSpawns (the Crank object's
  -- "Mirror" custom property in Tiled, if any) — which Mirror object's
  -- id this crank is meant to drive. self.mirrorId is the raw,
  -- not-yet-resolved Tiled id; self.mirror (set by main.lua's own spawn
  -- wiring, right after both this crank and every Mirror have spawned)
  -- is the actual Mirror instance :tryInteract below cranks alongside
  -- the handle itself.
  self.mirrorId = nil
  self.mirror = nil

  self.interactRadius = 140
  self.playerNearby = false

  return self
end

function Crank:isPlayerNear(player)
  if not player then return false end
  local dx, dy = player.pos.x - self.pos.x, player.pos.y - self.pos.y
  return (dx * dx + dy * dy) <= self.interactRadius * self.interactRadius
end

-- Called from InputHandlers.lua (Enter) and GamePadInput.lua (Circle) —
-- both just call this unconditionally on their own press; it's the one
-- place that actually decides whether the player's close enough to
-- reach it.
function Crank:tryInteract(player)
  if not self:isPlayerNear(player) then return end
  self.targetAngle = self.targetAngle + CRANK_STEP
  if self.mirror then
    self.mirror:crank(CRANK_STEP)
  end
end

function Crank:update()
  local timeScale = state.timeScale or 1
  self.playerNearby = self:isPlayerNear(state.player)

  if self.angle < self.targetAngle then
    self.angle = math.min(self.targetAngle, self.angle + HANDLE_SWING_SPEED * timeScale)
  end

  self.turns = math.floor(self.angle / (math.pi * 2))
end

function Crank:draw()
  local x, groundY = self.pos.x, self.pos.y
  local wheelY = self.wheelCenterY

  -- Post connecting the wheel down to the ground anchor.
  love.graphics.setColor(COLOR_POST)
  love.graphics.rectangle("fill", x - POST_WIDTH / 2, wheelY, POST_WIDTH, groundY - wheelY)

  -- Wheel: a plain disc with a few spokes so the rotation actually
  -- reads, plus a rim outline.
  love.graphics.setColor(COLOR_WHEEL)
  love.graphics.circle("fill", x, wheelY, WHEEL_RADIUS)
  love.graphics.setColor(COLOR_WHEEL_RIM)
  love.graphics.setLineWidth(2)
  love.graphics.circle("line", x, wheelY, WHEEL_RADIUS)
  for i = 0, SPOKE_COUNT - 1 do
    local a = self.angle + (i / SPOKE_COUNT) * math.pi * 2
    local sx = x + math.cos(a) * WHEEL_RADIUS
    local sy = wheelY + math.sin(a) * WHEEL_RADIUS
    love.graphics.line(x, wheelY, sx, sy)
  end

  -- Handle, mounted on the wheel's rim, sticking out a bit past it —
  -- what a player would actually grab to turn it.
  local rimX = x + math.cos(self.angle) * WHEEL_RADIUS
  local rimY = wheelY + math.sin(self.angle) * WHEEL_RADIUS
  local tipX = x + math.cos(self.angle) * (WHEEL_RADIUS + HANDLE_LENGTH)
  local tipY = wheelY + math.sin(self.angle) * (WHEEL_RADIUS + HANDLE_LENGTH)
  love.graphics.setColor(COLOR_HANDLE)
  love.graphics.setLineWidth(6)
  love.graphics.line(rimX, rimY, tipX, tipY)
  love.graphics.circle("fill", tipX, tipY, HANDLE_KNOB_RADIUS)

  love.graphics.setColor(COLOR_PIVOT)
  love.graphics.circle("fill", x, wheelY, 6)

  love.graphics.setLineWidth(1)
  love.graphics.setColor(1, 1, 1, 1)
end

local TOOLTIP_TEXT = "Press ENTER / Circle to crank"
local TOOLTIP_PAD_X, TOOLTIP_PAD_Y = 12, 8
local TOOLTIP_GAP_ABOVE = 26

-- World-space "you can interact with this" hint — same convention
-- Lever.lua/RobotButler.lua's own :drawTooltip already use, call from
-- inside the same camera-transformed push() block everything else in
-- the scene draws from. Not shown while curled into a ball (Player.lua's
-- own isBall) — a ball can't crank it at all (see the input-handler
-- guards in InputHandlers.lua/GamePadInput.lua), so advertising the
-- prompt then would just be misleading.
function Crank:drawTooltip()
  if not self.playerNearby then return end
  if state.player and state.player.isBall then return end

  local font = love.graphics.getFont()
  local textW = font:getWidth(TOOLTIP_TEXT)
  local textH = font:getHeight()
  local pillW = textW + TOOLTIP_PAD_X * 2
  local pillH = textH + TOOLTIP_PAD_Y * 2

  local bob = math.sin(love.timer.getTime() * 3) * 4
  local pillX = self.pos.x - pillW / 2
  local pillY = self.wheelCenterY - WHEEL_RADIUS - TOOLTIP_GAP_ABOVE - pillH + bob

  love.graphics.setColor(0, 0, 0, 0.6)
  love.graphics.rectangle("fill", pillX, pillY, pillW, pillH, pillH / 2, pillH / 2)
  love.graphics.setColor(1, 1, 1, 0.9)
  love.graphics.rectangle("line", pillX, pillY, pillW, pillH, pillH / 2, pillH / 2)
  love.graphics.print(TOOLTIP_TEXT, pillX + TOOLTIP_PAD_X, pillY + TOOLTIP_PAD_Y)
  love.graphics.setColor(1, 1, 1, 1)
end

return Crank
