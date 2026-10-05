-- lua/world/Sign.lua
--
-- A ground-mounted signpost: a short post topped with a wooden plank.
-- Placed on the ground the same way Lever/Crank are (see main.lua's
-- own spawn loop — the Tiled object's point is raycast straight down
-- onto whatever TerrainShape surface sits below it, landing self.pos
-- exactly on that surface rather than needing pixel-perfect placement
-- in Tiled itself). self.pos.x is the sign's own horizontal center —
-- the post rises straight up from it, so the plank sits directly
-- above self.pos.x regardless of post/plank size.
--
-- Reading it shows its own "message" Tiled custom property, split on
-- "|" into however many separate messages the level designer wrote
-- (one sign can have several unrelated things to say) — each message
-- is independently word-wrapped/paginated the same way RobotButler/
-- Fisherman's own single dialogueText already is. Pressing Enter/
-- Circle pages through the CURRENT message first, then — once that
-- one's own pages are exhausted — moves on to the next message, then
-- closes once every message has been shown.
--
-- Dialogue box rendering/pagination is shared with every other NPC —
-- see lua/ui/DialogueBox.lua.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local DialogueBox = require("lua.ui.DialogueBox")

local Sign = {}
Sign.__index = Sign

local POST_WIDTH = 8
local POST_HEIGHT = 50
local PLANK_WIDTH = 74
local PLANK_HEIGHT = 46

local COLOR_POST = { 0.42, 0.3, 0.2 }
local COLOR_PLANK = { 0.55, 0.4, 0.26 }
local COLOR_PLANK_RIM = { 0.3, 0.2, 0.12 }
local COLOR_PLANK_LINE = { 0.3, 0.2, 0.12, 0.6 }

-- Splits the raw "message" Tiled custom property on "|" into however
-- many separate messages it names, trimming stray whitespace around
-- each (easy to pick up typing in Tiled's own property editor) and
-- always returning at least one (possibly empty) entry so callers
-- never have to special-case a sign with no messages at all.
local function splitMessages(raw)
  local messages = {}
  if raw and raw ~= "" then
    for piece in (raw .. "|"):gmatch("(.-)|") do
      table.insert(messages, piece:match("^%s*(.-)%s*$"))
    end
  end
  if #messages == 0 then messages = { "" } end
  return messages
end

-- x, y: world position of the sign's own ground anchor (where the
-- post meets the ground) — same "sits exactly on the ground"
-- convention Ooomba/Lever/Crank use for their own center-bottom
-- anchor. rawMessage: the Tiled object's own "message" custom
-- property, pipe-delimited (see splitMessages above).
function Sign.new(x, y, rawMessage)
  local self = setmetatable({}, Sign)

  self.pos = Vector2.new(x, y)
  self.plankCenterY = y - POST_HEIGHT - PLANK_HEIGHT / 2

  self.messages = splitMessages(rawMessage)
  self.messageIndex = 1

  self.interactRadius = 140
  self.playerNearby = false

  self.dialogueActive = false
  self.dialoguePages = nil
  self.dialoguePageIndex = 1

  return self
end

function Sign:isPlayerNear(player)
  if not player then return false end
  local dx, dy = player.pos.x - self.pos.x, player.pos.y - self.pos.y
  return (dx * dx + dy * dy) <= self.interactRadius * self.interactRadius
end

-- Paginates whichever message self.messageIndex currently points at
-- and opens the dialogue box on its first page — shared by :tryInteract
-- (starting fresh) and itself again (moving on to the NEXT message
-- once the current one's own pages run out).
function Sign:showCurrentMessage()
  self.dialogueActive = true
  self.dialoguePageIndex = 1
  self.dialoguePages = DialogueBox.paginateForBox(self.messages[self.messageIndex])
end

-- Called from InputHandlers.lua (Enter) and GamePadInput.lua (Circle) —
-- both just call this unconditionally on their own press; it's the one
-- place that actually decides whether the player's close enough to
-- reach it.
function Sign:tryInteract(player)
  if self.dialogueActive then
    if self.dialoguePageIndex < #self.dialoguePages then
      self.dialoguePageIndex = self.dialoguePageIndex + 1
      return
    end
    if self.messageIndex < #self.messages then
      self.messageIndex = self.messageIndex + 1
      self:showCurrentMessage()
    else
      self.dialogueActive = false
      self.dialoguePages = nil
      self.dialoguePageIndex = 1
      self.messageIndex = 1 -- next read starts over from the first message
    end
    return
  end

  if not self:isPlayerNear(player) then return end
  self:showCurrentMessage()
end

function Sign:update()
  self.playerNearby = self:isPlayerNear(state.player)

  -- Safety net only, not the normal way out: the player's own movement
  -- is frozen for the whole conversation (see state.dialogueActive in
  -- main.lua/Player.lua), so this shouldn't normally be reachable —
  -- but if he somehow ends up out of range anyway, don't leave the
  -- conversation stuck open forever.
  if self.dialogueActive and not self.playerNearby then
    self.dialogueActive = false
    self.dialoguePages = nil
    self.dialoguePageIndex = 1
    self.messageIndex = 1
  end
end

function Sign:draw()
  local x, groundY = self.pos.x, self.pos.y
  local plankY = self.plankCenterY

  love.graphics.setColor(COLOR_POST)
  love.graphics.rectangle("fill", x - POST_WIDTH / 2, plankY + PLANK_HEIGHT / 2, POST_WIDTH, groundY - (plankY + PLANK_HEIGHT / 2))

  love.graphics.setColor(COLOR_PLANK)
  love.graphics.rectangle("fill", x - PLANK_WIDTH / 2, plankY - PLANK_HEIGHT / 2, PLANK_WIDTH, PLANK_HEIGHT, 4, 4)
  love.graphics.setColor(COLOR_PLANK_RIM)
  love.graphics.setLineWidth(2)
  love.graphics.rectangle("line", x - PLANK_WIDTH / 2, plankY - PLANK_HEIGHT / 2, PLANK_WIDTH, PLANK_HEIGHT, 4, 4)

  -- A few short lines suggesting writing, purely decorative.
  love.graphics.setColor(COLOR_PLANK_LINE)
  love.graphics.setLineWidth(3)
  for i = -1, 1 do
    local lineY = plankY + i * (PLANK_HEIGHT / 4)
    love.graphics.line(x - PLANK_WIDTH / 2 + 10, lineY, x + PLANK_WIDTH / 2 - 10, lineY)
  end

  love.graphics.setLineWidth(1)
  love.graphics.setColor(1, 1, 1, 1)
end

local TOOLTIP_TEXT = "Press ENTER / Circle to read"
local TOOLTIP_PAD_X, TOOLTIP_PAD_Y = 12, 8
local TOOLTIP_GAP_ABOVE = 26

-- World-space "you can interact with this" hint — same convention
-- Lever.lua/Crank.lua's own :drawTooltip already use, call from inside
-- the same camera-transformed push() block everything else in the
-- scene draws from. Not shown while curled into a ball (Player.lua's
-- own isBall) — a ball can't read it at all (see the input-handler
-- guards in InputHandlers.lua/GamePadInput.lua), so advertising the
-- prompt then would just be misleading.
function Sign:drawTooltip()
  if not self.playerNearby or self.dialogueActive then return end
  if state.player and state.player.isBall then return end

  local font = love.graphics.getFont()
  local textW = font:getWidth(TOOLTIP_TEXT)
  local textH = font:getHeight()
  local pillW = textW + TOOLTIP_PAD_X * 2
  local pillH = textH + TOOLTIP_PAD_Y * 2

  local bob = math.sin(love.timer.getTime() * 3) * 4
  local pillX = self.pos.x - pillW / 2
  local pillY = self.plankCenterY - PLANK_HEIGHT / 2 - TOOLTIP_GAP_ABOVE - pillH + bob

  love.graphics.setColor(0, 0, 0, 0.6)
  love.graphics.rectangle("fill", pillX, pillY, pillW, pillH, pillH / 2, pillH / 2)
  love.graphics.setColor(1, 1, 1, 0.9)
  love.graphics.rectangle("line", pillX, pillY, pillW, pillH, pillH / 2, pillH / 2)
  love.graphics.print(TOOLTIP_TEXT, pillX + TOOLTIP_PAD_X, pillY + TOOLTIP_PAD_Y)
  love.graphics.setColor(1, 1, 1, 1)
end

-- Screen-space dialogue box — call AFTER the camera transform is
-- popped (see main.lua's love.draw, alongside the minimap/HUD/VatsCursor
-- reticle), so it stays fixed relative to the WINDOW rather than the
-- world underneath it, matching how a dialogue box behaves in basically
-- every game that has one. Rendering itself (box art, text, the "more"
-- corner indicator) is shared — see lua/ui/DialogueBox.lua. hasMore is
-- true whenever pressing on would advance to another page OR another
-- message — i.e. whenever this ISN'T the very last page of the very
-- last message.
function Sign:drawDialogue()
  if not self.dialogueActive then return end
  local pageText = (self.dialoguePages and self.dialoguePages[self.dialoguePageIndex]) or ""
  local hasMorePages = self.dialoguePages and self.dialoguePageIndex < #self.dialoguePages
  local hasMoreMessages = self.messageIndex < #self.messages
  DialogueBox.draw(pageText, hasMorePages or hasMoreMessages)
end

return Sign
