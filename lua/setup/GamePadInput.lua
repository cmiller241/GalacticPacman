-- lua/setup/gamepadInput.lua
--
-- Direct translation of js/setup/gamepadInput.js. Called from
-- love.update(dt), once per frame — same polling architecture as the
-- original, and for the same reason the original's own comment gives:
-- sticks have no "moved" event in either the browser Gamepad API or
-- LÖVE's own love.joystick module, so the only way to know CURRENT
-- stick position is to ask fresh every frame. (LÖVE does have
-- love.gamepadpressed/love.gamepadreleased event callbacks, unlike
-- the raw browser Gamepad API — but since sticks force polling
-- regardless, and the original's whole edge-detection design
-- [lastXPressed etc.] is already built around comparing this-frame
-- vs last-frame state, polling everything uniformly here is the more
-- faithful port, not a workaround.)
--
-- Real API differences worth knowing, all confirmed before writing
-- this rather than assumed:
--
--   Triggers (L2/R2) are ANALOG AXES in LÖVE ("triggerleft"/
--   "triggerright", read via getGamepadAxis, values roughly 0 to 1),
--   NOT buttons with a .pressed boolean the way the browser Gamepad
--   API exposes them. TRIGGER_PRESS_THRESHOLD below is what turns
--   that analog value into the same press/release boolean the
--   original's R2 (fire) and L2 (pull) logic needs — tune this
--   constant against your actual DualSense if the trigger feels like
--   it engages too early or too late; I can't test the physical feel
--   myself.
--
--   Button NAMES, not indices — LÖVE's a/b/x/y are named after their
--   XBOX POSITIONS (LÖVE's own docs: "correspond as closely as
--   possible to the layout of a standard Xbox 360 controller"), the
--   same Xbox-position-not-label convention the original's own BUTTON_*
--   comment already warns about for the browser API's numeric indices.
--   Mapped here by POSITION, matching the original's own reasoning
--   exactly: a=bottom=Cross, b=right=Circle, x=left=Square, y=top=
--   Triangle, leftshoulder=L1, rightshoulder=R1, dpup/dpdown=D-pad.
--
--   DualSense support: SDL (which LÖVE is built on) added explicit
--   DualSense recognition in version 2.0.14 (Dec 2020) — confirmed via
--   SDL's own release notes, not assumed — and LÖVE 11.x bundles SDL
--   well past that point, so the buttons/sticks/triggers this file
--   actually needs should work correctly out of the box. Peripheral
--   features (LED color, adaptive trigger rumble, the touchpad, the
--   mic button) have had a rockier history across SDL versions, but
--   none of those are used here.
--
--   Only the FIRST connected, gamepad-recognized joystick is used —
--   same "no multiplayer/selection concept" reasoning as the
--   original. love.joystick.getJoysticks() doesn't leave null gaps
--   for disconnected slots the way the browser's sparse gamepads
--   array can, so this is a plain array scan, not a `.find(g => g)`.
--
--   Date.now() (milliseconds) becomes love.timer.getTime() (seconds)
--   here too, same as inputHandlers.lua — and specifically the SAME
--   clock, so state.lastGamepadInputTime (set here) and
--   state.lastMouseMoveTime (set in inputHandlers.lua) stay directly
--   comparable, which state.gamepadIsActiveDevice's own comparison
--   below depends on.

local state = require("lua.state")
local inputHandlers = require("lua.setup.inputHandlers")
local tryRestartOrAdvance = inputHandlers.tryRestartOrAdvance

-- Positional mapping — see this file's own header comment for why
-- these specific names correspond to these specific PS buttons.
local BUTTON_X_CROSS = "a"
local BUTTON_CIRCLE = "b"
local BUTTON_SQUARE = "x"
local BUTTON_TRIANGLE = "y"
local BUTTON_R1 = "rightshoulder"
local BUTTON_L1 = "leftshoulder"
local BUTTON_DPAD_UP = "dpup"
local BUTTON_DPAD_DOWN = "dpdown"

local ALL_FACE_AND_SHOULDER_BUTTONS = {
  BUTTON_X_CROSS, BUTTON_CIRCLE, BUTTON_SQUARE, BUTTON_TRIANGLE,
  BUTTON_R1, BUTTON_L1, BUTTON_DPAD_UP, BUTTON_DPAD_DOWN, "dpleft", "dpright",
}

local STICK_DEADZONE = 0.2      -- ignore small stick drift near center, on both sticks
local TRIGGER_PRESS_THRESHOLD = 0.5  -- analog trigger value counted as "pressed" — tune against real hardware feel

-- Tracked across frames so buttons can be edge-triggered (fires once
-- per press, not once per frame held) — same reasoning and same
-- variable-per-button structure as the original.
local lastXPressed = false
local lastL2Pressed = false
local lastR1Pressed = false
local lastL1Pressed = false
local lastCirclePressed = false
local lastTrianglePressed = false

-- Tracked so the stick/d-pad can clear state.keys[...] on release
-- WITHOUT ever clearing a flag the keyboard itself set — same
-- bookkeeping and same reasoning as the original.
local gamepadHeldLeft = false
local gamepadHeldRight = false
local gamepadHeldZoomIn = false
local gamepadHeldZoomOut = false

local function maybeAutoEnterVats()
  if state.vatsAutoEnterOnLock and not state.vatsActive and state.player and state.player.mode == "space" then
    state.vatsActive = true
  end
end

local function pollGamepad(dt)
  local joysticks = love.joystick.getJoysticks()
  local gp = nil
  for _, joystick in ipairs(joysticks) do
    if joystick:isGamepad() then
      gp = joystick
      break
    end
  end

  if not gp then
    state.gamepadAimActive = false
    state.gamepadFireHeld = false
    state.gamepadRunHeld = false
    state.gamepadIsActiveDevice = false
    return
  end

  -- On the GAME OVER / level-complete screens, X is the ONLY thing
  -- this function should do — same early-return, same reasoning as
  -- the original.
  if state.gameOver or state.levelComplete then
    local xPressed = gp:isGamepadDown(BUTTON_X_CROSS)
    if xPressed and not lastXPressed then
      tryRestartOrAdvance()
    end
    lastXPressed = xPressed
    return
  end

  -- --- Left stick: walk left/right ---
  local leftX = gp:getGamepadAxis("leftx") or 0
  if leftX < -STICK_DEADZONE then
    state.keys['ArrowLeft'] = true
    gamepadHeldLeft = true
    if gamepadHeldRight then state.keys['ArrowRight'] = false; gamepadHeldRight = false end
  elseif leftX > STICK_DEADZONE then
    state.keys['ArrowRight'] = true
    gamepadHeldRight = true
    if gamepadHeldLeft then state.keys['ArrowLeft'] = false; gamepadHeldLeft = false end
  else
    if gamepadHeldLeft then state.keys['ArrowLeft'] = false; gamepadHeldLeft = false end
    if gamepadHeldRight then state.keys['ArrowRight'] = false; gamepadHeldRight = false end
  end

  -- --- D-pad up/down: zoom in/out ---
  local dpadUpPressed = gp:isGamepadDown(BUTTON_DPAD_UP)
  local dpadDownPressed = gp:isGamepadDown(BUTTON_DPAD_DOWN)
  if dpadUpPressed then
    state.keys['+'] = true
    gamepadHeldZoomIn = true
  elseif gamepadHeldZoomIn then
    state.keys['+'] = false
    gamepadHeldZoomIn = false
  end
  if dpadDownPressed then
    state.keys['-'] = true
    gamepadHeldZoomOut = true
  elseif gamepadHeldZoomOut then
    state.keys['-'] = false
    gamepadHeldZoomOut = false
  end

  -- --- X (Cross): jump / wall jump / ground pound ---
  -- Player:jump() itself branches on grounded-launch vs. wall-jump kick
  -- (see Player.lua) — routed here together the same way InputHandlers.lua
  -- routes the keyboard Space key, since both are "this button performs a
  -- jump," as opposed to the ground-pound fallback for mid-air with
  -- nothing to jump off of.
  local xPressed = gp:isGamepadDown(BUTTON_X_CROSS)
  if xPressed and not lastXPressed and state.player and state.player.mode ~= "maze" and not state.introLocked then
    if state.player.onSurface or state.player.touchingWall then state.player:jump()
    else state.player:tryGroundPound() end
  end
  lastXPressed = xPressed

  -- --- R2: fire ---
  -- Analog trigger, thresholded — see this file's own header comment.
  state.gamepadFireHeld = (gp:getGamepadAxis("triggerright") or 0) > TRIGGER_PRESS_THRESHOLD

  -- --- Triangle: toggle V.A.T.S. ---
  local trianglePressed = gp:isGamepadDown(BUTTON_TRIANGLE)
  if state.player and state.player.mode == "space" then
    if trianglePressed and not lastTrianglePressed then
      state.vatsActive = not state.vatsActive
    end
  elseif state.vatsActive then
    state.vatsActive = false
  end
  lastTrianglePressed = trianglePressed

  -- --- Square: run ---
  state.gamepadRunHeld = gp:isGamepadDown(BUTTON_SQUARE)

  -- --- R1: hard lock, next --- / --- L1: hard lock, previous ---
  local r1Pressed = gp:isGamepadDown(BUTTON_R1)
  if r1Pressed and not lastR1Pressed and state.player then
    maybeAutoEnterVats()
    state.player:tryLockTargetNext()
  end
  lastR1Pressed = r1Pressed

  local l1Pressed = gp:isGamepadDown(BUTTON_L1)
  if l1Pressed and not lastL1Pressed and state.player then
    maybeAutoEnterVats()
    state.player:tryLockTargetPrevious()
  end
  lastL1Pressed = l1Pressed

  -- --- Circle: release lock, and end V.A.T.S. ---
  local circlePressed = gp:isGamepadDown(BUTTON_CIRCLE)
  if circlePressed and not lastCirclePressed and state.player then
    state.player:clearLockTarget()
    state.vatsActive = false
  end
  lastCirclePressed = circlePressed

  -- --- L2: pull beam ---
  -- Analog trigger, thresholded — same reasoning as R2 above.
  local l2Pressed = (gp:getGamepadAxis("triggerleft") or 0) > TRIGGER_PRESS_THRESHOLD
  if state.player then
    if l2Pressed and not lastL2Pressed then
      state.player:trySelectPullTarget(state.player.lockedTarget or state.player.aimTargetObject)
    elseif not l2Pressed and lastL2Pressed then
      state.player:clearPullTarget()
    end
  end
  lastL2Pressed = l2Pressed

  -- --- Right stick: aim (or, while in V.A.T.S., drives VatsCursor.lua's
  -- own on-screen cursor instead — see that file) ---
  local rightX = gp:getGamepadAxis("rightx") or 0
  local rightY = gp:getGamepadAxis("righty") or 0
  local rightMag = math.sqrt(rightX * rightX + rightY * rightY)
  if rightMag > STICK_DEADZONE then
    state.gamepadAimActive = true
    state.gamepadAimX = rightX / rightMag
    state.gamepadAimY = rightY / rightMag
    -- Raw (NOT unit-normalized) deflection, deadzone applied but actual
    -- push distance preserved — gamepadAimX/Y above throw that away on
    -- purpose (a fixed-length aim ray only cares about direction), but
    -- VatsCursor.lua's cursor wants proportional speed: a light nudge
    -- should crawl, a full push should move at full speed.
    state.gamepadRightStickX = rightX
    state.gamepadRightStickY = rightY
  else
    state.gamepadAimActive = false
    state.gamepadRightStickX = 0
    state.gamepadRightStickY = 0
  end

  -- --- Tracks whether the gamepad is the player's CURRENTLY
  -- preferred input device ---
  local anyButtonPressed = gp:isGamepadDown(ALL_FACE_AND_SHOULDER_BUTTONS)
    or (gp:getGamepadAxis("triggerleft") or 0) > TRIGGER_PRESS_THRESHOLD
    or (gp:getGamepadAxis("triggerright") or 0) > TRIGGER_PRESS_THRESHOLD
  local anyStickActive = math.abs(leftX) > STICK_DEADZONE or rightMag > STICK_DEADZONE
  if anyButtonPressed or anyStickActive then
    state.lastGamepadInputTime = love.timer.getTime()
  end
  state.gamepadIsActiveDevice = (state.lastGamepadInputTime or 0) > (state.lastMouseMoveTime or 0)
end

return {
  pollGamepad = pollGamepad
}