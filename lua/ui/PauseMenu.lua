-- lua/ui/PauseMenu.lua
--
-- The in-game pause menu: Escape on the keyboard or Start (Options, on
-- a PS5 pad) on the controller freezes the game under a gray
-- see-through overlay and offers CONTINUE or EXIT TO TITLE.
--
-- "Freezes" is main.lua's doing — love.update returns early for as long
-- as PauseMenu.isOpen() — and so is what EXIT TO TITLE actually does
-- (PauseMenu.onExitToTitle, set there: the whole world is rebuilt from
-- scratch, so everything the player changed is back as it started).
-- This module is just the menu: which option is selected, how it's
-- drawn, and what each button does to it. Input reaches it from
-- InputHandlers.lua (keys) and GamePadInput.lua (pad), which both stop
-- passing anything to the game itself while it's open.
--
-- Not available on the title screen — there's nothing to pause, and
-- nowhere to exit to.

local state = require("lua.state")

local PauseMenu = {}

local OPTIONS = { "CONTINUE", "EXIT TO TITLE" }
local CONTINUE, EXIT_TO_TITLE = 1, 2

local OVERLAY_COLOR = { 0.32, 0.34, 0.38, 0.62 } -- the gray, see-through wash over the frozen game
local HEADING_FONT_SIZE = 56
local OPTION_FONT_SIZE = 38
local OPTION_SPACING = 74          -- screen px between one option's center and the next
local OPTION_PILL_PAD_X, OPTION_PILL_PAD_Y = 40, 14
local UNSELECTED_ALPHA = 0.5

local selected = CONTINUE
local pausedSources = nil          -- whatever was playing when the menu opened, to resume on CONTINUE

-- Set by main.lua: called (with the menu already closed) when EXIT TO
-- TITLE is chosen.
PauseMenu.onExitToTitle = nil

local fonts = {}
local function getFont(size)
  if not fonts[size] then fonts[size] = love.graphics.newFont(size) end
  return fonts[size]
end

function PauseMenu.isOpen()
  return state.paused == true
end

function PauseMenu.open()
  if state.paused or state.titleScreen then return end
  state.paused = true
  selected = CONTINUE
  -- Sounds already playing stop where they are, and pick up again on
  -- CONTINUE, rather than ringing on over a frozen game.
  pausedSources = love.audio.pause()
end

function PauseMenu.close()
  if not state.paused then return end
  state.paused = false
  if pausedSources and #pausedSources > 0 then
    love.audio.play(pausedSources)
  end
  pausedSources = nil
end

-- delta: -1 = up, 1 = down. Wraps round.
function PauseMenu.move(delta)
  if not state.paused then return end
  selected = ((selected - 1 + delta) % #OPTIONS) + 1
end

function PauseMenu.confirm()
  if not state.paused then return end
  if selected == CONTINUE then
    PauseMenu.close()
    return
  end

  -- EXIT_TO_TITLE: nothing that was playing should carry over into a
  -- fresh game, so the paused sounds are dropped rather than resumed.
  state.paused = false
  pausedSources = nil
  love.audio.stop()
  if PauseMenu.onExitToTitle then PauseMenu.onExitToTitle() end
end

-- key: InputHandlers.lua's own JS-style key name.
function PauseMenu.keypressed(key)
  if key == "ArrowUp" or key == "w" then
    PauseMenu.move(-1)
  elseif key == "ArrowDown" or key == "s" then
    PauseMenu.move(1)
  elseif key == "Enter" or key == " " then
    PauseMenu.confirm()
  elseif key == "escape" then
    PauseMenu.close()
  end
end

-- Call last in love.draw, in screen space.
function PauseMenu.draw()
  if not state.paused then return end
  local screenW, screenH = love.graphics.getWidth(), love.graphics.getHeight()

  love.graphics.setColor(OVERLAY_COLOR)
  love.graphics.rectangle("fill", 0, 0, screenW, screenH)

  local prevFont = love.graphics.getFont()
  local centerX = screenW / 2
  local headingY = screenH * 0.3

  local headingFont = getFont(HEADING_FONT_SIZE)
  love.graphics.setFont(headingFont)
  local heading = "PAUSED"
  local headingX = math.floor(centerX - headingFont:getWidth(heading) / 2)
  love.graphics.setColor(0, 0, 0, 0.6)
  love.graphics.print(heading, headingX + 3, math.floor(headingY) + 3)
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.print(heading, headingX, math.floor(headingY))

  local optionFont = getFont(OPTION_FONT_SIZE)
  love.graphics.setFont(optionFont)
  local firstY = headingY + HEADING_FONT_SIZE + 70
  for i, label in ipairs(OPTIONS) do
    local textW, textH = optionFont:getWidth(label), optionFont:getHeight()
    local centerY = firstY + (i - 1) * OPTION_SPACING
    local textX, textY = math.floor(centerX - textW / 2), math.floor(centerY - textH / 2)

    if i == selected then
      -- The selected option sits in a pill, same look as the other
      -- prompts in the game.
      local pillW, pillH = textW + OPTION_PILL_PAD_X * 2, textH + OPTION_PILL_PAD_Y * 2
      local pillX, pillY = centerX - pillW / 2, centerY - pillH / 2
      love.graphics.setColor(0, 0, 0, 0.6)
      love.graphics.rectangle("fill", pillX, pillY, pillW, pillH, pillH / 2, pillH / 2)
      love.graphics.setColor(1, 1, 1, 0.9)
      love.graphics.setLineWidth(2)
      love.graphics.rectangle("line", pillX, pillY, pillW, pillH, pillH / 2, pillH / 2)
      love.graphics.setLineWidth(1)
      love.graphics.setColor(1, 1, 1, 1)
    else
      love.graphics.setColor(1, 1, 1, UNSELECTED_ALPHA)
    end
    love.graphics.print(label, textX, textY)
  end

  love.graphics.setFont(prevFont)
  love.graphics.setColor(1, 1, 1, 1)
end

return PauseMenu
