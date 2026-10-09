-- lua/ui/InteractPrompt.lua
--
-- The floating world-space "Press [button] to <verb>" pill shown above
-- anything the player can interact with (Sign, Lever, Crank, Beam,
-- RobotButler, Fisherman) — the one shared implementation of what used
-- to be six near-identical copies, one per :drawTooltip.
--
-- The button is an inline pixel-art icon rather than text, and WHICH
-- icon follows whatever the player touched most recently: the Circle
-- button (img/prompt_circle.png) after gamepad input, the Enter key
-- (img/prompt_enter.png) after keyboard or mouse input. Both are loaded
-- in assetLoading.lua as state.promptIcons.
--
-- Call from inside the same camera-transformed push() block everything
-- else in the scene draws from (see main.lua's love.draw).

local state = require("lua.state")

local InteractPrompt = {}

local PAD_X, PAD_Y = 12, 8
local ICON_HEIGHT = 24 -- world units tall every icon is drawn, whatever its source size: 2x for the 12px pixel-art ones (same as the tiles and img/sign.png), scaled down for a high-res one like the Circle button
local ICON_GAP = 6   -- world units between the icon and the text on either side of it
local BOB_SPEED, BOB_HEIGHT = 3, 4

-- Only used if an icon failed to load — the prompt still reads, as text.
local FALLBACK_LABEL = { gamepad = "Circle", keyboard = "ENTER" }

-- True when the gamepad is what the player used most recently. All
-- three timestamps are love.timer.getTime() values: lastGamepadInputTime
-- from GamePadInput.lua (any button, trigger or stick), the other two
-- from InputHandlers.lua (mouse movement; key presses, clicks and the
-- wheel). No gamepad input ever means keyboard.
function InteractPrompt.usingGamepad()
  local gamepadTime = state.lastGamepadInputTime
  if not gamepadTime then return false end
  local keyboardMouseTime = math.max(state.lastMouseMoveTime or 0, state.lastKeyboardMouseInputTime or 0)
  return gamepadTime > keyboardMouseTime
end

-- centerX: world x the pill is centered on. bottomY: world y of the
-- pill's own bottom edge at rest (it bobs gently around that). verb:
-- what the button does here — "talk", "pull", ... — or nil for a pill
-- holding just the button icon, no words (what most callers use).
function InteractPrompt.draw(centerX, bottomY, verb)
  local device = InteractPrompt.usingGamepad() and "gamepad" or "keyboard"
  local icon = state.promptIcons and state.promptIcons[device]
  local iconOnly = icon and not verb

  local font = love.graphics.getFont()
  local before, after = "Press", verb and ("to " .. verb) or ""
  if iconOnly then
    before = ""
  elseif not icon then
    before = before .. " " .. FALLBACK_LABEL[device]
  end

  local textH = font:getHeight()
  local beforeW, afterW = font:getWidth(before), font:getWidth(after)
  local iconW, iconH, iconScale = 0, 0, 1
  if icon then
    iconScale = ICON_HEIGHT / icon:getHeight()
    iconW, iconH = icon:getWidth() * iconScale, ICON_HEIGHT
  end
  -- The gap either side of the icon only exists to separate it from
  -- words; with no words it sits directly inside the pill's padding.
  local iconGap = iconOnly and 0 or ICON_GAP
  local middleW = icon and (iconGap + iconW + iconGap) or (after ~= "" and font:getWidth(" ") or 0)

  local pillW = beforeW + middleW + afterW + PAD_X * 2
  local pillH = textH + PAD_Y * 2

  local bob = math.sin(love.timer.getTime() * BOB_SPEED) * BOB_HEIGHT
  local pillX = centerX - pillW / 2
  local pillY = bottomY - pillH + bob

  love.graphics.setColor(0, 0, 0, 0.6)
  love.graphics.rectangle("fill", pillX, pillY, pillW, pillH, pillH / 2, pillH / 2)
  love.graphics.setColor(1, 1, 1, 0.9)
  love.graphics.rectangle("line", pillX, pillY, pillW, pillH, pillH / 2, pillH / 2)

  local x = pillX + PAD_X
  love.graphics.print(before, x, pillY + PAD_Y)
  x = x + beforeW
  if icon then
    -- Vertically centered on the pill, not the text line — the icon is
    -- taller than the text and uses some of the pill's own padding.
    love.graphics.setColor(1, 1, 1, 1)
    love.graphics.draw(icon, x + iconGap, pillY + (pillH - iconH) / 2, 0, iconScale, iconScale)
    love.graphics.setColor(1, 1, 1, 0.9)
  end
  x = x + middleW
  love.graphics.print(after, x, pillY + PAD_Y)

  love.graphics.setColor(1, 1, 1, 1)
end

return InteractPrompt
