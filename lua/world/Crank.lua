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
local InteractPrompt = require("lua.ui.InteractPrompt")

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

local COLOR_POST_EDGE = { 0.15, 0.15, 0.17 }   -- the post's shaded sides...
local COLOR_POST_LIGHT = { 0.5, 0.51, 0.54 }   -- ...and its lit middle (a cylinder)
local COLOR_OUTLINE = { 0.07, 0.07, 0.08 }
local COLOR_FOOT = { 0.22, 0.22, 0.24 }
local COLOR_WHEEL_FACE = { 0.1, 0.1, 0.11 }    -- the dark recess behind the spokes
local COLOR_RIM = { 0.42, 0.43, 0.46 }
local COLOR_RIM_LIGHT = { 0.7, 0.72, 0.75 }
local COLOR_SPOKE = { 0.36, 0.37, 0.4 }
local COLOR_HANDLE = { 0.75, 0.15, 0.12 }
local COLOR_PIVOT = { 0.12, 0.12, 0.13 }

local GRIP_COUNT = 12  -- grip bumps round the rim, turning with it

-- The post, as a mesh: shaded at both sides, lit down the middle, so it
-- reads as a round pillar. Drawn from its top-centre.
local postMesh = nil
local function getPostMesh(height)
  if postMesh then return postMesh end
  local w = POST_WIDTH / 2
  local e, l = COLOR_POST_EDGE, COLOR_POST_LIGHT
  postMesh = love.graphics.newMesh({
    { -w, 0, 0, 0, e[1], e[2], e[3], 1 },
    { -w * 0.2, 0, 0, 0, l[1], l[2], l[3], 1 },
    { w, 0, 0, 0, e[1], e[2], e[3], 1 },
    { w, height, 0, 0, e[1], e[2], e[3], 1 },
    { -w * 0.2, height, 0, 0, l[1], l[2], l[3], 1 },
    { -w, height, 0, 0, e[1], e[2], e[3], 1 },
  }, "triangles", "static")
  postMesh:setVertexMap(1, 2, 6,  2, 5, 6,  2, 3, 5,  3, 4, 5)
  return postMesh
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
  love.graphics.push("all")
  love.graphics.setLineStyle("smooth")

  -- Post connecting the wheel down to the ground anchor: a round pillar,
  -- with a collar where it meets a bolted foot plate.
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.rectangle("fill", x - POST_WIDTH / 2 - 1.5, wheelY, POST_WIDTH + 3, groundY - wheelY)
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(getPostMesh(groundY - wheelY), x, wheelY)
  local footW, footH = POST_WIDTH * 1.8, 6
  love.graphics.setColor(COLOR_FOOT)
  love.graphics.polygon("fill", x - footW, groundY, x + footW, groundY,
    x + footW * 0.6, groundY - footH, x - footW * 0.6, groundY - footH)
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.setLineWidth(1.5)
  love.graphics.polygon("line", x - footW, groundY, x + footW, groundY,
    x + footW * 0.6, groundY - footH, x - footW * 0.6, groundY - footH)
  love.graphics.setColor(1, 1, 1, 0.15)
  love.graphics.line(x - footW * 0.6, groundY - footH + 1, x + footW * 0.6, groundY - footH + 1)
  for side = -1, 1, 2 do
    love.graphics.setColor(0.55, 0.56, 0.58, 1)
    love.graphics.circle("fill", x + side * footW * 0.72, groundY - footH * 0.4, 1.6)
  end

  -- Wheel: a hand wheel — a dark recess behind thick spokes, a heavy
  -- rim with grip bumps (both turning with the handle, so the rotation
  -- reads), lit from the upper left.
  local rimW = 5
  local innerR = WHEEL_RADIUS - rimW / 2
  love.graphics.setColor(COLOR_WHEEL_FACE)
  love.graphics.circle("fill", x, wheelY, innerR)

  for i = 0, SPOKE_COUNT - 1 do
    local a = self.angle + (i / SPOKE_COUNT) * math.pi * 2
    local sx = x + math.cos(a) * innerR
    local sy = wheelY + math.sin(a) * innerR
    love.graphics.setColor(COLOR_OUTLINE)
    love.graphics.setLineWidth(6)
    love.graphics.line(x, wheelY, sx, sy)
    love.graphics.setColor(COLOR_SPOKE)
    love.graphics.setLineWidth(3.5)
    love.graphics.line(x, wheelY, sx, sy)
  end

  for i = 0, GRIP_COUNT - 1 do
    local a = self.angle + (i + 0.5) / GRIP_COUNT * math.pi * 2
    love.graphics.setColor(COLOR_OUTLINE)
    love.graphics.circle("fill", x + math.cos(a) * WHEEL_RADIUS, wheelY + math.sin(a) * WHEEL_RADIUS, 3.6)
    love.graphics.setColor(COLOR_RIM)
    love.graphics.circle("fill", x + math.cos(a) * WHEEL_RADIUS, wheelY + math.sin(a) * WHEEL_RADIUS, 2.4)
  end
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.setLineWidth(rimW + 3)
  love.graphics.circle("line", x, wheelY, WHEEL_RADIUS, 40)
  love.graphics.setColor(COLOR_RIM)
  love.graphics.setLineWidth(rimW)
  love.graphics.circle("line", x, wheelY, WHEEL_RADIUS, 40)
  -- The light catching its upper left (fixed: the light doesn't turn).
  love.graphics.setColor(COLOR_RIM_LIGHT)
  love.graphics.setLineWidth(1.5)
  love.graphics.arc("line", "open", x, wheelY, WHEEL_RADIUS - 0.5, math.pi * 1.05, math.pi * 1.55, 16)

  -- Hub: a boss with a bolt in it.
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.circle("fill", x, wheelY, 8)
  love.graphics.setColor(COLOR_RIM)
  love.graphics.circle("fill", x, wheelY, 6.5)
  love.graphics.setColor(COLOR_RIM_LIGHT)
  love.graphics.circle("fill", x - 1.2, wheelY - 1.2, 3.5)
  love.graphics.setColor(COLOR_PIVOT)
  love.graphics.circle("fill", x, wheelY, 2)

  -- Handle, mounted on the wheel's rim, sticking out a bit past it —
  -- what a player would actually grab to turn it: a steel arm ending in
  -- a red ball knob.
  local cosA, sinA = math.cos(self.angle), math.sin(self.angle)
  local rimX = x + cosA * WHEEL_RADIUS
  local rimY = wheelY + sinA * WHEEL_RADIUS
  local tipX = x + cosA * (WHEEL_RADIUS + HANDLE_LENGTH)
  local tipY = wheelY + sinA * (WHEEL_RADIUS + HANDLE_LENGTH)
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.setLineWidth(7)
  love.graphics.line(rimX, rimY, tipX, tipY)
  love.graphics.setColor(COLOR_SPOKE)
  love.graphics.setLineWidth(4)
  love.graphics.line(rimX, rimY, tipX, tipY)
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.circle("fill", rimX, rimY, 4)
  love.graphics.setColor(COLOR_RIM_LIGHT)
  love.graphics.circle("fill", rimX, rimY, 2.5)
  drawKnob(tipX, tipY, HANDLE_KNOB_RADIUS, COLOR_HANDLE)

  love.graphics.pop()
end

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

  InteractPrompt.draw(self.pos.x, self.wheelCenterY - WHEEL_RADIUS - TOOLTIP_GAP_ABOVE)
end

return Crank
