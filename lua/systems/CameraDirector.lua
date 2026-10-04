-- lua/systems/CameraDirector.lua
--
-- Lets a scripted sequence (see Script.lua) temporarily take the camera
-- away from its normal "always centered on the player" behavior
-- (main.lua's own love.update) — easing to a given world point + zoom,
-- optionally chaining through several such waypoints for a slow pan/
-- tour, then handing control back with one more eased transition onto
-- wherever the player actually is by the time that happens.
--
-- Call CameraDirector.update(ts) once per frame, BEFORE main.lua's own
-- player-centered camera math — it returns true (having already set
-- state.camera/state.zoom itself for this frame) while an override is
-- active, false once there's nothing left to do, so main.lua's own
-- fallback only ever runs when this isn't driving.

local state = require("lua.state")

local CameraDirector = {}

-- How long the final "hand back to the player" transition takes, and
-- what zoom it settles on — a normal gameplay zoom, not whatever level
-- the last scripted beat happened to leave the camera at, so the player
-- doesn't resume control at an unfamiliar zoom.
local DEFAULT_RELEASE_DURATION = 1.5
local RELEASE_ZOOM = 1

local function clampZoom(z)
  local lo, hi = state.zoomMin or 0.1, state.zoomMax or 2.5
  return math.max(lo, math.min(hi, z))
end

local function lerp(a, b, t) return a + (b - a) * t end

-- Smooth ease (slow-fast-slow) — a linear pan reads as mechanical; this
-- reads as a deliberately DIRECTED camera move instead.
local function smoothstep(t)
  return t * t * (3 - 2 * t)
end

-- The view's current center point + zoom, world-space — derived from
-- whichever source is authoritative right now: an in-progress director
-- sequence's own last reached point, or (nothing has run yet this
-- session) state.camera/state.zoom itself, so the very first scripted
-- move eases from wherever the ordinary player-centered camera already
-- was rather than snapping from some arbitrary start point.
local function currentCenter()
  local d = state.cameraDirector
  if d and d.lastX then return d.lastX, d.lastY, d.lastZoom end
  local zoom = state.zoom or 1
  local cam = state.camera or { x = 0, y = 0 }
  local screenW, screenH = love.graphics.getWidth(), love.graphics.getHeight()
  return cam.x + (screenW / zoom) / 2, cam.y + (screenH / zoom) / 2, zoom
end

-- Same camera-rect math main.lua's own player-centered version uses
-- (clamped to the scene bounds), just centered on an arbitrary world
-- point instead of state.player.pos.
local function applyCamera(cx, cy, zoom)
  zoom = clampZoom(zoom)
  local screenW, screenH = love.graphics.getWidth(), love.graphics.getHeight()
  local visibleWidth, visibleHeight = screenW / zoom, screenH / zoom
  local camX, camY = cx - visibleWidth / 2, cy - visibleHeight / 2
  local maxCameraX = (state.sceneWidth or 0) - visibleWidth
  local maxCameraY = (state.sceneHeight or 0) - visibleHeight
  camX = maxCameraX > 0 and math.min(math.max(camX, 0), maxCameraX) or maxCameraX / 2
  camY = maxCameraY > 0 and math.min(math.max(camY, 0), maxCameraY) or maxCameraY / 2
  state.camera = { x = camX, y = camY }
  state.zoom = zoom

  local d = state.cameraDirector
  if d then d.lastX, d.lastY, d.lastZoom = cx, cy, zoom end
end

local function beginNextLeg()
  local d = state.cameraDirector
  if not d then return end
  local nextWaypoint = table.remove(d.queue, 1)
  if not nextWaypoint then
    if d.mode == "release" then
      state.cameraDirector = nil -- fully hands back to main.lua's own fallback from here on
      return
    elseif d.loop and d.waypoints and #d.waypoints > 0 then
      -- Refill the queue from the ORIGINAL waypoint list and keep going
      -- rather than holding — used for a beat whose camera tour should
      -- keep repeating for as long as its line of dialogue is up,
      -- stopping only once the player actually presses on (see
      -- RobotButler.lua's own beat.cameraLoop).
      for i = 1, #d.waypoints do d.queue[i] = d.waypoints[i] end
      nextWaypoint = table.remove(d.queue, 1)
    else
      d.leg = nil -- holds the last reached view indefinitely until .run/.release is called again
      return
    end
  end
  d.leg = {
    startX = d.lastX, startY = d.lastY, startZoom = d.lastZoom,
    targetX = nextWaypoint.x, targetY = nextWaypoint.y, targetZoom = nextWaypoint.zoom or d.lastZoom,
    duration = nextWaypoint.duration or 2,
    elapsed = 0,
  }
end

-- waypoints: a list of {x=, y=, zoom=, duration=} (duration in seconds,
-- defaults to 2) — a single-entry list is just "ease to this view," more
-- than one chains into a slow pan/tour, each leg starting exactly where
-- the previous one ended. Supersedes whatever the director was already
-- doing, if anything, picking up smoothly from its current view rather
-- than popping.
--
-- opts.loop = true repeats the whole waypoint list indefinitely instead
-- of holding on the last one once reached — for a beat whose camera
-- tour should keep going for as long as its dialogue is up, only
-- stopping once the caller explicitly moves on (another .run or a
-- .release call — see RobotButler.lua's own beat.cameraLoop).
function CameraDirector.run(waypoints, opts)
  if not waypoints or #waypoints == 0 then return end
  local startX, startY, startZoom = currentCenter()
  local queue = {}
  for i = 1, #waypoints do queue[i] = waypoints[i] end
  state.cameraDirector = {
    mode = "run",
    queue = queue,
    waypoints = waypoints,
    loop = opts and opts.loop,
    lastX = startX, lastY = startY, lastZoom = startZoom,
  }
  beginNextLeg()
end

-- Eases back onto wherever the player is RIGHT NOW over `duration`
-- seconds (default DEFAULT_RELEASE_DURATION), settling at RELEASE_ZOOM,
-- then fully releases the camera back to main.lua's own normal
-- per-frame player-centered computation.
function CameraDirector.release(duration)
  local startX, startY, startZoom = currentCenter()
  local player = state.player
  local targetX = player and player.pos.x or startX
  local targetY = player and player.pos.y or startY
  state.cameraDirector = {
    mode = "release",
    queue = {},
    lastX = startX, lastY = startY, lastZoom = startZoom,
    leg = {
      startX = startX, startY = startY, startZoom = startZoom,
      targetX = targetX, targetY = targetY, targetZoom = RELEASE_ZOOM,
      duration = duration or DEFAULT_RELEASE_DURATION,
      elapsed = 0,
    },
  }
end

function CameraDirector.isActive()
  return state.cameraDirector ~= nil
end

-- Call once per frame, BEFORE main.lua's own player-centered camera
-- math. Returns true (having already set state.camera/state.zoom
-- itself) while directing; false once there's nothing to do, so the
-- normal fallback only ever runs when this isn't.
function CameraDirector.update(ts)
  local d = state.cameraDirector
  if not d then return false end

  if d.leg then
    local leg = d.leg
    leg.elapsed = leg.elapsed + (ts or 1) / 60
    local t = leg.duration > 0 and math.min(1, leg.elapsed / leg.duration) or 1
    local e = smoothstep(t)
    applyCamera(
      lerp(leg.startX, leg.targetX, e),
      lerp(leg.startY, leg.targetY, e),
      lerp(leg.startZoom, leg.targetZoom, e))
    if t >= 1 then
      beginNextLeg()
    end
  else
    -- Holding at the last reached view (a "run" sequence with no more
    -- queued legs, not yet released) — re-applied every frame rather
    -- than left untouched, since main.lua's own fallback is skipped
    -- entirely while this returns true, and nothing else would
    -- otherwise keep state.camera/zoom from going stale (e.g. across a
    -- window resize) during the hold.
    applyCamera(d.lastX, d.lastY, d.lastZoom)
  end

  return true
end

return CameraDirector
