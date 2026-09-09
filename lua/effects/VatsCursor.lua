-- lua/effects/VatsCursor.lua
--
-- While V.A.T.S. is active, the right stick drives a free-roaming
-- on-screen cursor (a red X, fixed to the screen, not the world) instead
-- of the ordinary fixed-length aim ray it drives the rest of the time
-- (see GamePadInput.lua's own comment on gamepadRightStickX/Y). Landing
-- the cursor on a planet makes it the actual lock (player.lockedTarget) —
-- the same one L1/R1 cycling and LockOutline.lua's ring already revolve
-- around — so there's a single source of truth for "what's highlighted"
-- and "what L2 pulls toward" rather than a separate cosmetic hover layer
-- that visually agrees with the lock but functionally ignores it.

local state = require("lua.state")

-- Px/second at full stick deflection. Deliberately NOT scaled by
-- state.timeScale (V.A.T.S.'s own slow-mo) — this cursor is a UI layer
-- riding on TOP of the slowdown, not part of the slowed simulation
-- itself. A cursor that crawled at the same crawl as the slowed-down
-- world would defeat V.A.T.S.'s whole point: carefully aiming WHILE
-- everything else is slow, not slowly aiming too.
local CURSOR_SPEED = 900
local CURSOR_SIZE = 14
local CURSOR_THICKNESS = 3
local CURSOR_COLOR = { 1, 0.15, 0.15, 1 }

local VatsCursor = {}

-- Tracked so entering V.A.T.S. always starts the cursor fresh at screen
-- center, rather than picking up wherever a PREVIOUS V.A.T.S. session
-- left it — a stale off-center position would be confusing to resume
-- from, and this makes every activation feel the same.
local wasActive = false

-- The hover target as of LAST frame — see update()'s own use below.
-- Locking only fires the moment the cursor ARRIVES on a (different)
-- planet, not on every single frame it merely continues resting there;
-- without that distinction, resting the cursor anywhere would silently
-- fight L1/R1 forever afterward, re-snapping the lock straight back the
-- instant a shoulder-button press tried to change it to something else.
local lastHoverTarget = nil

local function findHoverTarget(worldX, worldY)
  -- Whatever the player is currently standing on is excluded, matching
  -- TargetLock.lua's own gatherLockCandidates rule — locking onto (and
  -- pull-beaming toward) the ground under your own feet doesn't make
  -- sense as a target there, and shouldn't here either.
  local standingOn = (state.player and state.player.onSurface) and state.player.currentPlanet or nil

  local best, bestDistSq = nil, math.huge
  for _, planet in ipairs(state.planetoids) do
    if planet ~= standingOn and not planet.isPullExempt then
      local hit
      if planet.containsPoint then
        hit = planet:containsPoint(worldX, worldY)
      else
        local dx, dy = worldX - planet.pos.x, worldY - planet.pos.y
        local r = planet.radius or 0
        hit = (dx * dx + dy * dy) <= r * r
      end
      if hit then
        local dx, dy = worldX - planet.pos.x, worldY - planet.pos.y
        local distSq = dx * dx + dy * dy
        if distSq < bestDistSq then
          bestDistSq = distSq
          best = planet
        end
      end
    end
  end
  return best
end

-- Called once per frame from main.lua's love.update, with the REAL
-- (unscaled) frame dt — see CURSOR_SPEED's own comment for why real time,
-- not state.timeScale, drives this.
function VatsCursor.update(dt)
  if not state.vatsActive then
    wasActive = false
    lastHoverTarget = nil
    return
  end

  local screenW, screenH = love.graphics.getWidth(), love.graphics.getHeight()

  if not wasActive then
    state.vatsCursorX = screenW / 2
    state.vatsCursorY = screenH / 2
    wasActive = true
  end

  local dx = state.gamepadRightStickX or 0
  local dy = state.gamepadRightStickY or 0
  state.vatsCursorX = math.max(0, math.min(screenW, state.vatsCursorX + dx * CURSOR_SPEED * dt))
  state.vatsCursorY = math.max(0, math.min(screenH, state.vatsCursorY + dy * CURSOR_SPEED * dt))

  local cam = state.camera or { x = 0, y = 0 }
  local zoom = state.zoom or 1
  local worldX = state.vatsCursorX / zoom + cam.x
  local worldY = state.vatsCursorY / zoom + cam.y
  local hoverTarget = findHoverTarget(worldX, worldY)

  -- Edge-triggered: only on actually ARRIVING at a new planet, not every
  -- frame the cursor happens to still be sitting on one — see
  -- lastHoverTarget's own comment above for why that distinction matters.
  -- Landing on empty space never clears an existing lock (moving the
  -- cursor off to nowhere shouldn't lose your target); only landing on a
  -- DIFFERENT planet replaces it.
  if hoverTarget and hoverTarget ~= lastHoverTarget and state.player then
    state.player.lockedTarget = hoverTarget
  end
  lastHoverTarget = hoverTarget
end

-- Screen-space: call AFTER the camera transform is popped (see
-- main.lua's love.draw, alongside the minimap/HUD text) so the cursor
-- stays fixed on screen like an actual mouse cursor instead of panning
-- and zooming with the world underneath it.
function VatsCursor.drawReticle()
  if not state.vatsActive or not state.vatsCursorX then return end
  local x, y = state.vatsCursorX, state.vatsCursorY

  love.graphics.setLineWidth(CURSOR_THICKNESS)
  love.graphics.setColor(CURSOR_COLOR[1], CURSOR_COLOR[2], CURSOR_COLOR[3], CURSOR_COLOR[4])
  love.graphics.line(x - CURSOR_SIZE, y - CURSOR_SIZE, x + CURSOR_SIZE, y + CURSOR_SIZE)
  love.graphics.line(x - CURSOR_SIZE, y + CURSOR_SIZE, x + CURSOR_SIZE, y - CURSOR_SIZE)
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.setLineWidth(1)
end

return VatsCursor
