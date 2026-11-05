-- lua/setup/inputHandlers.lua
--
-- Direct translation of js/setup/inputHandlers.js, restructured
-- around LÖVE's own callback model rather than DOM event listeners.
-- attachInputHandlers() still exists as an explicit function, called
-- once from main.lua's love.load() — same "wire everything up once at
-- startup" role as the original — but what it DOES is assign LÖVE's
-- own global love.mousemoved/mousepressed/mousereleased/wheelmoved
-- callbacks, rather than calling addEventListener. Kept as an
-- explicit function (not side-effecting on require) so this stays
-- testable the same way every other file this session has been:
-- require it, call attachInputHandlers(), then actually invoke the
-- resulting love.* callbacks and assert on what happened.
--
-- Several real API differences worth knowing before reading further:
--
--   Mouse coordinates: LÖVE's love.mousemoved(x, y, ...) already gives
--   window-relative pixel coordinates directly — no
--   getBoundingClientRect() equivalent needed, since there's no page
--   layout to account for in a native window.
--
--   Mouse buttons: confirmed directly against LÖVE's own docs — 1 is
--   left/primary, 2 is right/secondary, 3 is middle. NOT 0-indexed
--   like JS's e.button (0=left, 2=right).
--
--   Wheel scroll sign: love.wheelmoved(x, y)'s y is the OPPOSITE sign
--   convention from JS's e.deltaY — positive y means scrolled UP in
--   LÖVE, positive deltaY means scrolled DOWN (toward the user) in
--   JS. The zoom-direction check below is inverted from the original
--   specifically because of this, not by mistake.
--
--   No contextmenu prevention needed — LÖVE is a native window, there
--   is no browser right-click context menu to suppress in the first
--   place.
--
--   Key names: LÖVE uses "left"/"right"/"down"/"up" (not
--   "ArrowLeft" etc.) and "return" (not "Enter") — confirmed directly.
--   The spacebar is genuinely ambiguous across LÖVE versions in the
--   documentation itself — some show "space", others show a literal
--   " " — so both are checked below rather than betting on one.
--
--   Date.now() (milliseconds since epoch) becomes love.timer.getTime()
--   (seconds since an arbitrary starting point, NOT epoch-based) —
--   fine here since every one of these timestamps is only ever used
--   for RELATIVE elapsed-time comparisons, never an absolute date, but
--   worth knowing the UNITS differ (seconds, not milliseconds) for
--   whenever Player.js's own mouseIdle computation gets ported.
--
-- state.keys itself stores JS-style key names ('ArrowLeft', ' ',
-- 'Enter'), not LÖVE's own ("left", "space", "return") — translated
-- via KEY_NAME_MAP below. This isn't the most "native" LÖVE choice,
-- but js/setup/gamepadInput.js already directly sets
-- state.keys['ArrowLeft']/['+']/['-'] etc., and Player.js (not yet
-- ported) almost certainly checks these same JS-style names too —
-- keeping ONE consistent naming scheme across every input source,
-- regardless of which one actually wrote it, avoids every future
-- ported file needing its own translation layer.
local KEY_NAME_MAP = {
  up = 'ArrowUp',
  down = 'ArrowDown',
  left = 'ArrowLeft',
  right = 'ArrowRight',
  space = ' ',
  [' '] = ' ',       -- older LÖVE versions' own spacebar constant
  ['return'] = 'Enter',
}

local function toJsStyleKey(loveKey)
  return KEY_NAME_MAP[loveKey] or loveKey
end

local state = require("lua.state")
local TitleScreen = require("lua.ui.TitleScreen")
local PauseMenu = require("lua.ui.PauseMenu")
local PortalGun = require("lua.systems.PortalGun")
local WeaponModes = require("lua.systems.WeaponModes")
local Recall = require("lua.systems.Recall")
local WorldObjects = require("lua.systems.WorldObjects")
local ClipRecorder = require("lua.systems.ClipRecorder")
local Profiler = require("lua.debug.Profiler")

local ZOOM_WHEEL_STEP = 0.08  -- per scroll "click", same as the original

local function attachInputHandlers()
  -- ----------------------------
  -- MOUSE TRACKING (for blaster aiming)
  -- ----------------------------
  state.mouse = { x = love.graphics.getWidth() / 2, y = love.graphics.getHeight() / 2 }
  state.lastMouseMoveTime = love.timer.getTime()

  function love.mousemoved(x, y, dx, dy, istouch)
    state.mouse.x = x
    state.mouse.y = y
    state.lastMouseMoveTime = love.timer.getTime()
  end

  -- ----------------------------
  -- CLICK HANDLING
  -- ----------------------------
  state.mouseDown = false

  function love.mousepressed(x, y, button, istouch, presses)
    -- Clicks, the wheel and key presses all count as "using keyboard/
    -- mouse" for InteractPrompt.lua's own button icon.
    state.lastKeyboardMouseInputTime = love.timer.getTime()
    if state.titleScreen then return end -- no shooting/pulling on the title screen
    if PauseMenu.isOpen() then return end -- ...or while paused
    -- ...or riding a cannon (see Player:isCannonRiding): no shooting,
    -- pulling, portals or recall at all.
    if state.player and state.player:isCannonRiding() then return end
    -- Portal: left click red portal, right click blue.
    if state.portalMode then
      if button == 1 then PortalGun.fire(state.player, "red")
      elseif button == 2 then PortalGun.fire(state.player, "blue") end
      return
    end
    -- Every other blaster fires with the left button only (see
    -- lua/systems/WeaponModes.lua).
    if button ~= 1 or not state.player then return end
    if state.fireballMode or state.iceMode then
      -- Fired in love.update, after he's moved this frame (same spot as
      -- R2), so the shot leaves from where the muzzle is drawn.
      state.mouseDown = true
      state.mouseFirePending = true
    elseif state.pullBeamMode then
      state.player:trySelectPullTarget()
    elseif state.recallMode then
      Recall.activate(state.player)
    end
    -- Water: spraying is held, so it's read each frame instead (see
    -- WaterSystem.update).
  end

  function love.mousereleased(x, y, button, istouch, presses)
    if button == 1 then
      state.mouseDown = false
      -- Not in V.A.T.S. — same rule as letting go of L2 (see
      -- GamePadInput.lua's own L2 handling).
      if state.player and not state.vatsActive then state.player:clearPullTarget() end
    end
  end

  -- ----------------------------
  -- SCROLL WHEEL ZOOM
  -- ----------------------------
  function love.wheelmoved(x, y)
    if state.titleScreen then return end -- no zooming on the title screen
    if PauseMenu.isOpen() then return end -- ...or while paused
    -- Inverted vs the original's own `e.deltaY > 0 ? -STEP : STEP`
    -- specifically because LÖVE's y sign convention is the opposite
    -- of JS's deltaY — see this file's own header comment.
    local delta = y > 0 and ZOOM_WHEEL_STEP or -ZOOM_WHEEL_STEP
    state.zoom = math.max(state.zoomMin, math.min(state.zoomMax, state.zoom + delta))
    state.zoomTarget = nil
    state.lastWheelTime = love.timer.getTime()
    state.lastKeyboardMouseInputTime = state.lastWheelTime
  end

  -- ----------------------------
  -- KEYBOARD
  -- ----------------------------
  function love.keypressed(loveKey, scancode, isrepeat)
    local key = toJsStyleKey(loveKey)
    state.lastKeyboardMouseInputTime = love.timer.getTime()

    -- F3: the frame-time profiler (see lua/debug/Profiler.lua). Works
    -- everywhere, like F11 below.
    if key == 'f3' and not isrepeat then Profiler.toggle() end

    -- F11: borderless fullscreen <-> maximized window. Works everywhere,
    -- even on the title screen and in the pause menu.
    if key == 'f11' and not isrepeat then
      if love.window.getFullscreen() then
        love.window.setFullscreen(false)
        love.window.maximize()
      else
        love.window.setFullscreen(true, "desktop")
      end
      return
    end

    -- Title screen (see lua/ui/TitleScreen.lua): Enter, Space or X
    -- starts the game and no other key does anything — checked before
    -- state.keys is even set, so held keys (zoom, movement) can't act
    -- on the scene underneath either.
    if state.titleScreen then
      if not isrepeat and (key == 'Enter' or key == ' ' or key == 'x') then
        TitleScreen.requestStart()
      end
      return
    end

    -- Pause menu (see lua/ui/PauseMenu.lua): while it's open every key
    -- goes to the menu and none to the game; otherwise Escape opens it.
    if PauseMenu.isOpen() then
      if not isrepeat then PauseMenu.keypressed(key) end
      return
    end
    if key == 'escape' and not isrepeat then
      PauseMenu.open()
      return
    end
    -- T: the debug teleport list (see main.lua's own PauseMenu.onTeleportKey).
    if key == 't' and not isrepeat and PauseMenu.onTeleportKey then
      PauseMenu.onTeleportKey()
      return
    end

    -- Start/stop recording a trailer clip (see lua/systems/ClipRecorder.lua).
    if key == 'p' and not isrepeat then
      ClipRecorder.toggle()
      return
    end

    state.keys[key] = true

    -- Riding a cannon (see Player:isCannonRiding), he does nothing at
    -- all — no jumping, curling or uncurling, interacting or switching
    -- weapons. Only what isn't him: zooming the camera (read as held
    -- keys, each frame, in main.lua) and the debug toggles below.
    local riding = state.player and state.player:isCannonRiding()

    if key == ' ' and not riding then
      if state.player and state.player.inInterior then
        -- Inside a planet (the pinball table, the maze), the interior
        -- decides: the plunger/flippers, or nothing (see each one's
        -- triggerJumpAction).
        state.player.inInterior:triggerJumpAction(state.player)
      elseif state.player and not state.introLocked then
        -- A jump (grounded launch, wall-jump kick, or swim stroke) when
        -- there's something to jump off — or, in mid-air, coyote time,
        -- a buffered jump, or the ground pound. Player:pressJump decides.
        state.player:pressJump()
      end
    end

    -- Morph ball: ArrowDown curls up, ArrowUp stands back up (see
    -- Player:enterBallMode/exitBallMode; inside a planet he stays a ball).
    if key == 'ArrowDown' and not isrepeat and not riding and state.player and not state.introLocked then
      state.player:enterBallMode()
    end
    if key == 'ArrowUp' and not isrepeat and not riding and state.player then
      state.player:exitBallMode()
    end

    -- Interact: NPCs, levers, cranks, signs, beams (see
    -- lua/systems/WorldObjects.lua's WorldObjects.interact).
    if key == 'Enter' and not riding then
      WorldObjects.interact(state.player)
    end

    if key == 'c' and not isrepeat then
      state.showCollisionDebug = not state.showCollisionDebug
    end

    -- Turns the dirt planet he's on or near: N clockwise, M
    -- counter-clockwise; the same key again stops it (see
    -- CrackedPlanetoid:toggleSpin).
    if (key == 'n' or key == 'm') and not isrepeat and state.player then
      local p = state.player.currentPlanet or state.player.lastInfluencePlanet
      if p and p.toggleSpin then p:toggleSpin(key == 'n' and 1 or -1) end
    end

    if key == 'a' and not isrepeat then
      state.showBeltCellDebug = not state.showBeltCellDebug
    end

    if key == 'r' and not isrepeat then
      state.showInfluenceRings = not state.showInfluenceRings
    end

    -- Cycles what the blaster's buttons do: Blaster (fire + pull beam),
    -- Portal, Water (see lua/systems/WeaponModes.lua).
    if key == 'tab' and not isrepeat and not riding then
      WeaponModes.cycle(1)
    end

    -- Switches the gravity of the dirt planet he's on or near: toward
    -- its core, straight down, straight up (see
    -- CrackedPlanetoid:cycleGravity).
    if key == 'g' and not isrepeat and state.player then
      local p = state.player.currentPlanet or state.player.lastInfluencePlanet
      if p and p.cycleGravity then p:cycleGravity() end
    end
  end

  function love.keyreleased(loveKey, scancode)
    local key = toJsStyleKey(loveKey)
    state.keys[key] = false
  end
end

return {
  attachInputHandlers = attachInputHandlers,
}