-- lua/ui/Conversation.lua
--
-- A conversation in the textbox that can ask the player to choose.
-- It's a list of beats, each one of:
--
--   { text = "..." }
--       a line of text (paged if it's too long for the box); the
--       interact button moves on
--
--   { choice = "Should he read it?", options = {
--       { label = "Read it", beats = { ...what follows... } },
--       { label = "Don't read it" },   -- (no beats: the talk ends)
--   } }
--       a question with options side by side; Left/Right (or Up/Down)
--       moves the cursor and the interact button picks one, which
--       carries on with that option's own beats
--
-- The owner (lua/interiors/ShipInterior.lua's Bible, for one) starts it,
-- passes on the interact button (:press) and the arrows (:move), and
-- draws it with the HUD (:draw). The box itself is lua/ui/DialogueBox.lua.

local DialogueBox = require("lua.ui.DialogueBox")

local Conversation = {}
Conversation.__index = Conversation

function Conversation.new(beats)
  return setmetatable({
    beats = beats,
    queue = nil,   -- the beats being gone through now
    index = 0,
    pages = nil,   -- the current text beat, paged to fit the box
    page = 1,
    selected = 1,  -- the option the cursor's on (choice beats)
    active = false,
  }, Conversation)
end

function Conversation:isActive()
  return self.active
end

-- The beat showing now (nil once it's over).
function Conversation:current()
  return self.active and self.queue[self.index] or nil
end

-- Moves on to the next beat in the queue, or ends it after the last.
function Conversation:nextBeat()
  self.index = self.index + 1
  local beat = self.queue[self.index]
  if not beat then
    self:stop()
    return
  end
  self.page = 1
  self.selected = 1
  self.pages = beat.text and DialogueBox.paginateForBox(beat.text) or nil
end

function Conversation:start()
  self.active = true
  self.queue = self.beats
  self.index = 0
  self:nextBeat()
end

function Conversation:stop()
  self.active = false
  self.queue, self.pages = nil, nil
  self.index = 0
end

-- The interact button: picks the option under the cursor, or turns the
-- page, or moves on to the next beat.
function Conversation:press()
  local beat = self:current()
  if not beat then return end
  if beat.choice then
    local option = beat.options[self.selected]
    self.queue = option.beats or {}
    self.index = 0
    self:nextBeat()
  elseif self.page < #self.pages then
    self.page = self.page + 1
  else
    self:nextBeat()
  end
end

-- An arrow (dir -1 or 1): moves the cursor, wrapping round, while a
-- question is up.
function Conversation:move(dir)
  local beat = self:current()
  if not (beat and beat.choice) then return end
  local n = #beat.options
  self.selected = (self.selected - 1 + dir) % n + 1
end

-- Screen-space, with the HUD (see WorldObjects.drawDialogues).
function Conversation:draw()
  local beat = self:current()
  if not beat then return end
  if beat.choice then
    local labels = {}
    for i, option in ipairs(beat.options) do labels[i] = option.label end
    DialogueBox.drawChoice(beat.choice, labels, self.selected)
  else
    local hasMore = self.page < #self.pages or self.index < #self.queue
    DialogueBox.draw(self.pages[self.page], hasMore)
  end
end

return Conversation
