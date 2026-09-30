-- lua/entities/Fisherman.lua
--
-- A decorative NPC standing at a fixed spot on the sky dome's own flat
-- deck (see main.lua's own placement, mirroring RobotButler.lua's role
-- but on the opposite/right edge instead) — doesn't walk anywhere, no
-- physics, no collision. Same "purely background flavor" role
-- RobotButler.lua and SpaceShelter.lua already play, with the same
-- Enter/gamepad-Circle interact -> dialogue-textbox pattern
-- RobotButler.lua established.
--
-- Rig: three source images (img/Fisherman-Body.png, -Arms.png,
-- -Head.png), authored and positioned with paperdoll-fisherman.html at
-- bodyScale 0.1 — POSE below is that tool's own logged output, applied
-- with the exact same attach-point formulas the tool mirrors from
-- Player.lua's drawLimb/drawFullBody (see paperdoll-fisherman.html's
-- own header comment). Unlike the astronaut rig, this one's head has
-- its own independent x offset (paperdoll-fisherman.html added that;
-- see its own comment for why) since there's no existing Player.lua
-- convention this needs to match.
--
-- No walk-cycle/aim/surface-orientation logic at all: he always stands
-- upright (orientation locked at 0, matching flat dome ground) and
-- never changes pose except the idle arm/head sway below.

local state = require("lua.state")
local Vector2 = require("lua.vector2")

local Fisherman = {}
Fisherman.__index = Fisherman

local BODY_SCALE = 0.1

-- Logged directly from paperdoll-fisherman.html (see that tool's own
-- "Log current pose" button) — body: y=0 (its own local origin sits at
-- the image's exact vertical center, see :draw's own body block).
local POSE = {
  armsX = 95.59,  armsY = -66.91, armsJointX = 349.32, armsJointY = 1071.05,
  headX = -73.28, headY = -237.01, headPivotFraction = 0.9,
}

-- Idle sway: arms and head rock a few degrees back and forth,
-- independent speeds/phases so the two don't move in perfect lockstep
-- — reads as a little more alive than one shared oscillation would.
local IDLE_ARM_AMPLITUDE  = 5 * math.pi / 180
local IDLE_ARM_SPEED      = 1.1
local IDLE_HEAD_AMPLITUDE = 4 * math.pi / 180
local IDLE_HEAD_SPEED     = 0.8
local IDLE_HEAD_PHASE     = math.pi * 0.4

-- x: world position. groundY: the flat deck surface he stands on
-- (SkyDomePlanetoid:trueSurfaceY()).
function Fisherman.new(x, groundY)
  local self = setmetatable({}, Fisherman)

  local images = state.fishermanImages
  local bodyW, bodyH = 100, 100
  if images and images.body then
    bodyW, bodyH = images.body:getDimensions()
  end

  self.drawWidth = bodyW * BODY_SCALE
  self.drawHeight = bodyH * BODY_SCALE
  self.halfWidth = self.drawWidth / 2
  self.halfHeight = self.drawHeight / 2

  -- Body art's own local origin sits at its vertical CENTER (pose's
  -- body y=0 — see :draw's own body block), so the true ground line is
  -- halfHeight below wherever self.pos itself ends up. Same
  -- center-bottom-anchor convention RobotButler.lua/Ooomba.lua use,
  -- just derived from the rig's own authored pose instead of a fixed
  -- sprite-sheet frame height.
  self.pos = Vector2.new(x, groundY - self.halfHeight)

  -- Desynced start phase so a second fisherman, if one's ever added,
  -- wouldn't sway in exact lockstep with this one.
  self.idleTime = math.random() * 100

  -- Interaction (Enter / gamepad Circle — see InputHandlers.lua and
  -- GamePadInput.lua) and dialogue box, same pattern/timing as
  -- RobotButler.lua's own.
  self.interactRadius = 220
  self.dialogueText = "I love fishing but they just ain't biting!"
  self.playerNearby = false
  self.dialogueActive = false
  self.dialogueTimer = 0
  self.dialogueDurationTicks = 240 -- ~4 seconds at 60fps-baseline

  return self
end

function Fisherman:isPlayerNear(player)
  if not player then return false end
  local dx, dy = player.pos.x - self.pos.x, player.pos.y - self.pos.y
  return (dx * dx + dy * dy) <= self.interactRadius * self.interactRadius
end

-- Called from InputHandlers.lua (Enter) and GamePadInput.lua (Circle) —
-- both just call this unconditionally on their own press; it's the one
-- place that actually decides whether he's close enough to talk.
function Fisherman:tryInteract(player)
  if not self:isPlayerNear(player) then return end
  self.dialogueActive = true
  self.dialogueTimer = self.dialogueDurationTicks
end

function Fisherman:update()
  local timeScale = state.timeScale or 1
  self.idleTime = self.idleTime + timeScale / 60

  self.playerNearby = self:isPlayerNear(state.player)
  if self.dialogueActive then
    -- Walking out of range dismisses it immediately, same as running
    -- out the clock does — no point leaving a reply hanging on screen
    -- once he's no longer even in earshot.
    if not self.playerNearby then
      self.dialogueActive = false
    else
      self.dialogueTimer = self.dialogueTimer - timeScale
      if self.dialogueTimer <= 0 then
        self.dialogueActive = false
      end
    end
  end
end

------------------------------------------------------------------
-- Drawing
------------------------------------------------------------------

-- Same drawLimb formula Player.lua's own rig uses (see
-- paperdoll-fisherman.html's own header comment mirroring it): an
-- (x,y) attach offset (already in world units here, unrotated — this
-- rig never turns, unlike Player's orientation-driven one), then the
-- image's own (jointX,jointY) pixel lands at that attach point, then
-- an independent angle on top for the idle sway.
local function drawLimb(img, offsetX, offsetY, jointX, jointY, angle, scale, originPos)
  if not img then return end
  love.graphics.push()
  love.graphics.translate(originPos.x + offsetX * scale, originPos.y + offsetY * scale)
  love.graphics.rotate(angle)
  love.graphics.draw(img, -jointX * scale, -jointY * scale, 0, scale, scale)
  love.graphics.pop()
end

function Fisherman:draw()
  local images = state.fishermanImages
  if not images then return end

  local scale = BODY_SCALE
  local originPos = self.pos

  local armAngle = math.sin(self.idleTime * IDLE_ARM_SPEED) * IDLE_ARM_AMPLITUDE
  local headAngle = math.sin(self.idleTime * IDLE_HEAD_SPEED + IDLE_HEAD_PHASE) * IDLE_HEAD_AMPLITUDE

  -- Draw order (back to front): body, arms, head — straight from
  -- paperdoll-fisherman.html's own logged z-order.
  if images.body then
    local w, h = images.body:getDimensions()
    love.graphics.push()
    love.graphics.translate(originPos.x, originPos.y)
    love.graphics.draw(images.body, -w * scale / 2, -h * scale / 2, 0, scale, scale)
    love.graphics.pop()
  end

  drawLimb(images.arms, POSE.armsX, POSE.armsY, POSE.armsJointX, POSE.armsJointY, armAngle, scale, originPos)

  if images.head then
    local w, h = images.head:getDimensions()
    local pivotY = h * scale * POSE.headPivotFraction
    love.graphics.push()
    love.graphics.translate(originPos.x + POSE.headX * scale, originPos.y + POSE.headY * scale)
    love.graphics.rotate(headAngle)
    love.graphics.draw(images.head, -w * scale / 2, -pivotY, 0, scale, scale)
    love.graphics.pop()
  end
end

------------------------------------------------------------------
-- Tooltip / dialogue — same look and behavior as RobotButler.lua's own
-- (shared textbox art, same layout math), kept as its own copy rather
-- than a shared module since RobotButler.lua's version wasn't factored
-- out into one either.
------------------------------------------------------------------

local TOOLTIP_TEXT = "Press ENTER / Circle to talk"
local TOOLTIP_PAD_X, TOOLTIP_PAD_Y = 12, 8
local TOOLTIP_GAP_ABOVE_HEAD = 26

function Fisherman:drawTooltip()
  if not self.playerNearby or self.dialogueActive then return end

  local font = love.graphics.getFont()
  local textW = font:getWidth(TOOLTIP_TEXT)
  local textH = font:getHeight()
  local pillW = textW + TOOLTIP_PAD_X * 2
  local pillH = textH + TOOLTIP_PAD_Y * 2

  local bob = math.sin(love.timer.getTime() * 3) * 4
  local pillX = self.pos.x - pillW / 2
  local pillY = self.pos.y - self.halfHeight - TOOLTIP_GAP_ABOVE_HEAD - pillH + bob

  love.graphics.setColor(0, 0, 0, 0.6)
  love.graphics.rectangle("fill", pillX, pillY, pillW, pillH, pillH / 2, pillH / 2)
  love.graphics.setColor(1, 1, 1, 0.9)
  love.graphics.rectangle("line", pillX, pillY, pillW, pillH, pillH / 2, pillH / 2)
  love.graphics.print(TOOLTIP_TEXT, pillX + TOOLTIP_PAD_X, pillY + TOOLTIP_PAD_Y)
  love.graphics.setColor(1, 1, 1, 1)
end

local TEXTBOX_SOURCE_W, TEXTBOX_SOURCE_H = 1410, 227
local TEXTBOX_WIDTH_MARGIN = 20
local TEXTBOX_BOTTOM_MARGIN = 20
local TEXTBOX_TEXT_PAD_X = 60
local TEXTBOX_TEXT_PAD_Y = 33
local TEXTBOX_SHADOW_OFFSET = 2

local dialogueFont = nil
local function ensureDialogueFont()
  if not dialogueFont then
    dialogueFont = love.graphics.newFont(30)
  end
  return dialogueFont
end

-- Screen-space dialogue box — call AFTER the camera transform is
-- popped, same call-site convention as RobotButler.lua's own (see
-- main.lua's love.draw).
function Fisherman:drawDialogue()
  if not self.dialogueActive then return end
  local img = state.textboxTexture
  if not img then return end

  local screenW, screenH = love.graphics.getWidth(), love.graphics.getHeight()

  local rightEdge = screenW - TEXTBOX_WIDTH_MARGIN
  if state.minimap then
    state.minimap:refreshSize()
    local mapLeftEdge = screenW - state.minimap.size - state.minimap.margin
    rightEdge = math.min(rightEdge, mapLeftEdge - TEXTBOX_WIDTH_MARGIN)
  end

  local boxX = TEXTBOX_WIDTH_MARGIN
  local boxW = rightEdge - boxX
  local boxH = boxW * (TEXTBOX_SOURCE_H / TEXTBOX_SOURCE_W)
  local boxY = screenH - TEXTBOX_BOTTOM_MARGIN - boxH

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(img, boxX, boxY, 0, boxW / TEXTBOX_SOURCE_W, boxH / TEXTBOX_SOURCE_H)

  local prevFont = love.graphics.getFont()
  love.graphics.setFont(ensureDialogueFont())

  local textX = boxX + TEXTBOX_TEXT_PAD_X
  local textY = boxY + TEXTBOX_TEXT_PAD_Y
  local textLimit = boxW - TEXTBOX_TEXT_PAD_X * 2

  love.graphics.setColor(0, 0, 0, 0.65)
  love.graphics.printf(self.dialogueText, textX + TEXTBOX_SHADOW_OFFSET, textY + TEXTBOX_SHADOW_OFFSET, textLimit, "left")

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.printf(self.dialogueText, textX, textY, textLimit, "left")

  love.graphics.setFont(prevFont)
end

return Fisherman
