-- lua/ui/PauseMenu.lua
--
-- The in-game pause menu: Escape on the keyboard or Start (Options, on
-- a PS5 pad) on the controller freezes the game under a gray
-- see-through overlay and offers CONTINUE, EXIT TO TITLE or EXIT GAME
-- (which closes the game entirely).
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
--
-- It can also show a list of choices instead (PauseMenu.openList — e.g.
-- the T key's debug teleport list, see main.lua): the same freeze, look
-- and controls, with a title of its own; choosing one closes the menu
-- and calls back with it.

local state = require("lua.state")

local PauseMenu = {}

local OPTIONS = { "CONTINUE", "EXIT TO TITLE", "EXIT GAME" }
local CONTINUE, EXIT_TO_TITLE, EXIT_GAME = 1, 2, 3

-- The list page, while one's showing (see PauseMenu.openList):
-- { title, options = { { label, enabled }, ... }, onChoose }.
local list = nil
local LIST_OPTION_FONT_SIZE = 30
local LIST_OPTION_SPACING = 54
local LIST_DISABLED_ALPHA = 0.22
local HINT_FONT_SIZE = 20

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
-- Set by main.lua: called when T is pressed in the game (see
-- InputHandlers.lua), to open its teleport list.
PauseMenu.onTeleportKey = nil

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
  list = nil
  selected = CONTINUE
  -- Sounds already playing stop where they are, and pick up again on
  -- CONTINUE, rather than ringing on over a frozen game.
  pausedSources = love.audio.pause()
end

-- Pauses with a list of choices showing instead of the usual options.
-- options: { { label = "...", enabled = true/false }, ... } (disabled
-- ones are shown dimmed and skipped over). initial: which to start on.
-- onChoose(index) is called once the menu has closed again.
function PauseMenu.openList(title, options, onChoose, initial)
  if state.titleScreen or #options == 0 then return end
  if not state.paused then
    state.paused = true
    pausedSources = love.audio.pause()
  end
  list = { title = title, options = options, onChoose = onChoose }
  selected = 1
  if initial and options[initial] and options[initial].enabled then
    selected = initial
  elseif not options[1].enabled then
    PauseMenu.move(1)
  end
end

function PauseMenu.isListOpen()
  return state.paused == true and list ~= nil
end

function PauseMenu.close()
  if not state.paused then return end
  state.paused = false
  list = nil
  if pausedSources and #pausedSources > 0 then
    love.audio.play(pausedSources)
  end
  pausedSources = nil
end

-- delta: -1 = up, 1 = down. Wraps round, skipping a list's disabled options.
function PauseMenu.move(delta)
  if not state.paused then return end
  local options = list and list.options or OPTIONS
  local n = #options
  local at = selected
  for _ = 1, n do
    at = ((at - 1 + delta) % n) + 1
    if not list or options[at].enabled then
      selected = at
      return
    end
  end
end

function PauseMenu.confirm()
  if not state.paused then return end
  if list then
    local option = list.options[selected]
    if not (option and option.enabled) then return end
    local onChoose = list.onChoose
    PauseMenu.close()
    if onChoose then onChoose(selected) end
    return
  end
  if selected == CONTINUE then
    PauseMenu.close()
    return
  end

  if selected == EXIT_GAME then
    -- Closes the window. love.quit (see main.lua) still runs, so anything
    -- that saves on the way out (e.g. a clip mid-recording) still does.
    love.event.quit()
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
  if list then
    -- (Any arrow cycles through a list; X picks, like the pad's Cross; T,
    -- which opened it, closes it again.)
    if key == "ArrowUp" or key == "ArrowLeft" or key == "w" or key == "a" then
      PauseMenu.move(-1)
    elseif key == "ArrowDown" or key == "ArrowRight" or key == "s" or key == "d" then
      PauseMenu.move(1)
    elseif key == "Enter" or key == " " or key == "x" then
      PauseMenu.confirm()
    elseif key == "escape" or key == "t" then
      PauseMenu.close()
    end
    return
  end
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
  -- (A list starts higher up, with smaller, closer options, to fit more.)
  local headingY = screenH * (list and 0.14 or 0.3)
  local optionFontSize = list and LIST_OPTION_FONT_SIZE or OPTION_FONT_SIZE
  local optionSpacing = list and LIST_OPTION_SPACING or OPTION_SPACING

  local headingFont = getFont(HEADING_FONT_SIZE)
  love.graphics.setFont(headingFont)
  local heading = list and list.title or "PAUSED"
  local headingX = math.floor(centerX - headingFont:getWidth(heading) / 2)
  love.graphics.setColor(0, 0, 0, 0.6)
  love.graphics.print(heading, headingX + 3, math.floor(headingY) + 3)
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.print(heading, headingX, math.floor(headingY))

  local optionFont = getFont(optionFontSize)
  love.graphics.setFont(optionFont)
  local firstY = headingY + HEADING_FONT_SIZE + (list and 50 or 70)
  local options = list and list.options or OPTIONS
  for i, option in ipairs(options) do
    local label = list and option.label or option
    local enabled = not list or option.enabled
    if not enabled then label = label .. "  (OFF)" end
    local textW, textH = optionFont:getWidth(label), optionFont:getHeight()
    local centerY = firstY + (i - 1) * optionSpacing
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
      love.graphics.setColor(1, 1, 1, enabled and UNSELECTED_ALPHA or LIST_DISABLED_ALPHA)
    end
    love.graphics.print(label, textX, textY)
  end

  if list then
    local hintFont = getFont(HINT_FONT_SIZE)
    love.graphics.setFont(hintFont)
    local hint = "Arrows / left stick: choose     Enter, Space or X: go     T or Esc: cancel"
    local hintY = firstY + #options * optionSpacing + 10
    love.graphics.setColor(1, 1, 1, 0.75)
    love.graphics.print(hint, math.floor(centerX - hintFont:getWidth(hint) / 2), math.floor(hintY))
  end

  love.graphics.setFont(prevFont)
  love.graphics.setColor(1, 1, 1, 1)
end

return PauseMenu
