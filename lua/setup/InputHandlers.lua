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

-- Shared by the Enter key handler and the mousedown handler below —
-- same role and same logic as the original. levelSetup is required
-- LAZILY, inside the function body rather than at the top of the
-- file, specifically so this file can be loaded and tested on its own
-- before lua/setup/levelSetup.lua exists — a top-level require would
-- fail immediately just from loading this file, long before
-- tryRestartOrAdvance is ever actually called.
local function tryRestartOrAdvance()
  if state.gameOver then
    state.score = 0
    state.level = 1
    local levelSetup = require("lua.setup.levelSetup")
    levelSetup.initGame()
    return true
  elseif state.levelComplete then
    state.level = state.level + 1
    local levelSetup = require("lua.setup.levelSetup")
    levelSetup.initGame()
    state.levelComplete = false
    return true
  end
  return false
end

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
    if tryRestartOrAdvance() then return end  -- same early-return as the original
    if button == 1 then
      state.mouseDown = true
      if state.player then state.player:shootFireball() end
    elseif button == 2 then
      if state.player then state.player:trySelectPullTarget() end
    end
  end

  function love.mousereleased(x, y, button, istouch, presses)
    if button == 1 then
      state.mouseDown = false
    elseif button == 2 then
      if state.player then state.player:clearPullTarget() end
    end
  end

  -- ----------------------------
  -- SCROLL WHEEL ZOOM
  -- ----------------------------
  function love.wheelmoved(x, y)
    -- Inverted vs the original's own `e.deltaY > 0 ? -STEP : STEP`
    -- specifically because LÖVE's y sign convention is the opposite
    -- of JS's deltaY — see this file's own header comment.
    local delta = y > 0 and ZOOM_WHEEL_STEP or -ZOOM_WHEEL_STEP
    state.zoom = math.max(state.zoomMin, math.min(state.zoomMax, state.zoom + delta))
    state.zoomTarget = nil
    state.lastWheelTime = love.timer.getTime()
  end

  -- ----------------------------
  -- KEYBOARD
  -- ----------------------------
  function love.keypressed(loveKey, scancode, isrepeat)
    local key = toJsStyleKey(loveKey)
    state.keys[key] = true

    if key == ' ' then
      if state.player and state.player.onSurface and state.player.mode ~= "maze" then
        state.player:jump()
      elseif state.player and state.player.mode ~= "maze" then
        state.player:tryGroundPound()
      end
    end

    if key == 'ArrowDown' and state.player and state.player.mode ~= "maze" then
      -- MazeInterior/BeamPlanetoid/angleDiff aren't ported yet —
      -- required lazily, same reasoning as levelSetup above, so this
      -- branch is the only thing that can't be exercised until they
      -- exist, not the whole file.
      local BeamPlanetoid = require("lua.world.BeamPlanetoid")
      local MazeInterior = require("lua.interiors.MazeInterior")
      local angleDiff = require("lua.utils").angleDiff

      if state.player.onSurface and state.player.currentPlanet and
         getmetatable(state.player.currentPlanet) == BeamPlanetoid then
        local diff = angleDiff(state.player.angle, state.player.currentPlanet.beamAngle)
        if diff < math.pi / 5 then
          local mode = (getmetatable(state.player.currentPlanet.interior) == MazeInterior) and "maze" or "platform"
          state.player:startTeleport(mode)
        end
      end
    end

    if key == 'Enter' then
      tryRestartOrAdvance()
    end
  end

  function love.keyreleased(loveKey, scancode)
    local key = toJsStyleKey(loveKey)
    state.keys[key] = false
  end
end

return {
  attachInputHandlers = attachInputHandlers,
  tryRestartOrAdvance = tryRestartOrAdvance,
}