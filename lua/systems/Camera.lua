-- lua/systems/Camera.lua
--
-- The game camera: where it looks (state.camera — the world point at the
-- screen's top-left) and how far it's zoomed in (state.zoom), plus
-- state.visibleWidth/visibleHeight, how much of the world fits on screen.
--
-- Zoom comes from, in order of who wins: a scripted camera move
-- (lua/systems/CameraDirector.lua, which takes over completely while it
-- runs), the +/- keys and mouse wheel, Zoom-Window areas of the Tiled
-- level, and a cannon shot (zoomed all the way out for the journey). The
-- camera follows the player, gliding over after a trip through a portal.

local state = require("lua.state")
local CameraDirector = require("lua.systems.CameraDirector")

local Camera = {}

Camera.ZOOM_MIN = 0.6
Camera.ZOOM_MAX = 2.5
local ZOOM_MIN, ZOOM_MAX = Camera.ZOOM_MIN, Camera.ZOOM_MAX
local ZOOM_STEP_PER_FRAME = 0.02
-- Zoom easing (zoom windows, cannon shots): fraction of the remaining
-- distance to the target zoom covered each frame, and how close counts
-- as "arrived".
local ZOOM_WINDOW_EASE_PER_FRAME = 0.03
local ZOOM_WINDOW_SNAP = 0.002

-- Camera glide after a trip through a portal. How fast it closes the gap
-- depends on how far apart the two portals are: a very slow, gentle ease
-- between portals close together, quicker between far-apart ones (so he
-- isn't off screen for long). The rate scales evenly from MIN (portals
-- touching) to MAX (FAR_DISTANCE apart or more). Rough feel: 1 covers 90%
-- of the gap in ~2.3s, 2 in ~1.2s, 8 in ~0.3s. SETTLED: how close counts
-- as caught up.
local PORTAL_CAMERA_GLIDE_RATE_MIN = 1
local PORTAL_CAMERA_GLIDE_RATE_MAX = 8
local PORTAL_CAMERA_GLIDE_FAR_DISTANCE = 2500
local PORTAL_CAMERA_SETTLED = 1

-- Back to a new game's camera: no position yet, zoom 1, nothing easing.
function Camera.reset()
  state.camera = nil
  state.zoom = 1
  state.zoomMax = ZOOM_MAX
  state.zoomMin = ZOOM_MIN
  state.zoomTarget = nil
  state.activeZoomWindow, state.zoomWindowReturn = nil, nil
  state.cannonZoomFlying, state.cannonZoomReturn = nil, nil
  state.portalCameraGlide = nil
end

-- Centered on the player, straight away (no easing). love.load calls
-- this once the player exists: a draw can come before the first update,
-- and worldGen streams the world around the camera (see
-- worldGen.streamFocus), which must not be last game's.
function Camera.pointAtPlayer()
  state.visibleWidth = love.graphics.getWidth() / state.zoom
  state.visibleHeight = love.graphics.getHeight() / state.zoom
  state.camera = {
    x = state.player.pos.x - state.visibleWidth / 2,
    y = state.player.pos.y - state.visibleHeight / 2,
  }
end

-- Once a frame, at the end of love.update, after everything has moved.
function Camera.update(dt)
  -- Manual zoom input is ignored while CameraDirector.lua is actively
  -- directing (a scripted sequence — see RobotButler.lua's own intro
  -- script) — fighting a scripted camera move with +/- would just look
  -- broken, and it releases control back on its own once the sequence
  -- ends anyway.
  if not CameraDirector.isActive() then
    if state.keys['+'] or state.keys['='] then
      state.zoom = math.min(ZOOM_MAX, state.zoom + ZOOM_STEP_PER_FRAME)
      state.zoomTarget = nil
    end
    if state.keys['-'] or state.keys['_'] then
      state.zoom = math.max(ZOOM_MIN, state.zoom - ZOOM_STEP_PER_FRAME)
      state.zoomTarget = nil
    end
  end

  -- Zoom-Window pass: walking into one of state.zoomWindows eases the
  -- camera to that window's own zoom; walking back out eases it back to
  -- whatever zoom the player had on the way in. Only the enter/exit
  -- EDGES set state.zoomTarget, so any manual zoom input (which clears
  -- it — see just above, and InputHandlers.lua's own wheel handler)
  -- simply wins until the player next crosses a window boundary.
  local insideWindow = nil
  local px, py = state.player.pos.x, state.player.pos.y
  for _, w in ipairs(state.zoomWindows or {}) do
    if px >= w.x and px <= w.x + w.width and py >= w.y and py <= w.y + w.height then
      insideWindow = w
      break
    end
  end
  if insideWindow ~= state.activeZoomWindow then
    local previous = state.activeZoomWindow
    if insideWindow then
      -- Stepping straight from one window into another keeps the
      -- ORIGINAL pre-window zoom as the one to return to.
      if not previous then
        state.zoomWindowReturn = state.zoomTarget or state.zoom
      end
      state.zoomTarget = insideWindow.zoom
    elseif state.zoomWindowReturn then
      -- Skipped if the player re-zoomed by hand while inside — their
      -- own choice shouldn't be undone just for walking out.
      if state.zoomTarget == previous.zoom or math.abs(state.zoom - previous.zoom) < ZOOM_WINDOW_SNAP then
        state.zoomTarget = state.zoomWindowReturn
      end
      state.zoomWindowReturn = nil
    end
    state.activeZoomWindow = insideWindow
  end

  -- A cannon shot (see lua/world/Cannon.lua): the moment he's fired,
  -- ease all the way out (ZOOM_MIN) for the whole journey — and once
  -- it's over (he's crashed into the target, or anything else ended it),
  -- ease back to the zoom he had before. Same easing as the zoom
  -- windows above, so a manual zoom mid-flight wins the same way.
  local cannonFlying = state.player.cannonFlight ~= nil
  if cannonFlying ~= (state.cannonZoomFlying or false) then
    if cannonFlying then
      state.cannonZoomReturn = state.zoomTarget or state.zoom
      state.zoomTarget = ZOOM_MIN
    elseif state.cannonZoomReturn then
      state.zoomTarget = state.cannonZoomReturn
      state.cannonZoomReturn = nil
    end
    state.cannonZoomFlying = cannonFlying
  end

  -- Safety net: CameraDirector may zoom out past the player's own
  -- ZOOM_MIN during a script (see its SCRIPT_ZOOM_MIN) and normally
  -- hands back at a regular zoom — but if it ever lets go while still
  -- further out than the player is allowed, ease back in to the limit
  -- rather than leaving him stuck there.
  if not CameraDirector.isActive() and not state.zoomTarget and state.zoom < ZOOM_MIN then
    state.zoomTarget = ZOOM_MIN
  end

  if state.zoomTarget and not CameraDirector.isActive() then
    local target = math.min(ZOOM_MAX, math.max(ZOOM_MIN, state.zoomTarget))
    state.zoom = state.zoom + (target - state.zoom) * ZOOM_WINDOW_EASE_PER_FRAME
    if math.abs(target - state.zoom) < ZOOM_WINDOW_SNAP then
      state.zoom = target
      state.zoomTarget = nil
    end
  end

  -- CameraDirector.update already sets state.camera/state.zoom itself
  -- (and returns true) while a scripted sequence is driving — the
  -- ordinary player-centered computation below only runs when it isn't,
  -- so the handoff between the two is a single smooth eased transition
  -- (CameraDirector.release), never a one-frame pop between two
  -- independently-computed camera positions.
  if not CameraDirector.update(state.timeScale) then
    local zoom = state.zoom
    local visibleWidth = love.graphics.getWidth() / zoom
    local visibleHeight = love.graphics.getHeight() / zoom
    -- Mid-portal, whichever side most of him is on (see PortalGun.updateTransit).
    local transit = state.player.portalTransit
    local focusX = transit and transit.cameraX or state.player.pos.x
    local focusY = transit and transit.cameraY or state.player.pos.y
    -- A trip through a portal glides the camera over to him instead of
    -- cutting: from where it was when he went in, it closes a fixed share
    -- of the remaining gap each moment (quick at first, settling in at
    -- the end — how quick depends on how far apart the portals are, see
    -- PORTAL_CAMERA_GLIDE_RATE_MIN/MAX), then hands back to following him
    -- exactly once it's caught up.
    if transit and not state.portalCameraGlide then
      local prev = state.camera
      state.portalCameraGlide = prev
        and { x = prev.x + visibleWidth / 2, y = prev.y + visibleHeight / 2 }
        or { x = focusX, y = focusY }
    end
    local glide = state.portalCameraGlide
    if glide and transit then
      -- Paced by how far apart the portals of this trip are.
      local apart = math.sqrt((transit.to.x - transit.from.x) ^ 2 + (transit.to.y - transit.from.y) ^ 2)
      local t = math.min(1, apart / PORTAL_CAMERA_GLIDE_FAR_DISTANCE)
      glide.rate = PORTAL_CAMERA_GLIDE_RATE_MIN + (PORTAL_CAMERA_GLIDE_RATE_MAX - PORTAL_CAMERA_GLIDE_RATE_MIN) * t
    end
    if glide then
      -- (Frame time capped, so one slow frame can't turn into a jump.)
      local catchUp = 1 - math.exp(-(glide.rate or PORTAL_CAMERA_GLIDE_RATE_MAX) * math.min(dt, 1 / 30))
      glide.x = glide.x + (focusX - glide.x) * catchUp
      glide.y = glide.y + (focusY - glide.y) * catchUp
      if not transit and (focusX - glide.x) ^ 2 + (focusY - glide.y) ^ 2 < PORTAL_CAMERA_SETTLED ^ 2 then
        state.portalCameraGlide = nil
      else
        focusX, focusY = glide.x, glide.y
      end
    end
    local camera = {
      x = focusX - visibleWidth / 2,
      y = focusY - visibleHeight / 2,
    }
    local maxCameraX = state.sceneWidth - visibleWidth
    local maxCameraY = state.sceneHeight - visibleHeight
    camera.x = maxCameraX > 0 and math.min(math.max(camera.x, 0), maxCameraX) or maxCameraX / 2
    camera.y = maxCameraY > 0 and math.min(math.max(camera.y, 0), maxCameraY) or maxCameraY / 2
    state.camera = camera
  end

  -- Kept up to date regardless of which of the two paths above actually
  -- drove state.camera/state.zoom this frame — other systems (VatsOverlay.lua,
  -- etc.) read these directly and need them correct either way.
  state.visibleWidth = love.graphics.getWidth() / state.zoom
  state.visibleHeight = love.graphics.getHeight() / state.zoom
end

return Camera
