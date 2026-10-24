-- lua/systems/Recall.lua
--
-- Recall mode (one of the modes P cycles through — see WeaponModes.lua),
-- after Tears of the Kingdom's: right click / R2 on a planetoid and it
-- rewinds back along the path it's taken over the last 30 seconds.
--
-- Recording: every RECORD_SECONDS of game time, every planetoid that's
-- moved since its last sample records where it is (and its velocity, its
-- spin if it has one, and a moving Sphere's next patrol point). The last
-- MAX_SAMPLES are kept, in flat number arrays per planetoid used as a
-- ring (hundreds of planetoids x 300 samples — a table per sample would
-- be a lot of garbage).
--
-- Rewinding: the samples play back newest to oldest, a sample's worth at
-- a time, between REWIND_MIN_SECONDS (a little history) and
-- REWIND_MAX_SECONDS (the full 30 seconds), lerping between them. While
-- it's rewinding nothing else moves it — its own drift, the belt's orbit,
-- a moving Sphere's patrol, collisions (main.lua skips anything with
-- .recalling set) — and it can't be stopped: whatever's in its way is
-- pushed aside, and carried along at its speed. At the end it carries on
-- from that moment with the velocity (and spin, and patrol leg) it had
-- then, its history starting over. Recalling it again mid-rewind stops it
-- there.
--
-- It's drawn blinking yellow while it rewinds, with a faint dotted line
-- along the rest of its path; in Recall mode a planetoid with something
-- to rewind gets a thin yellow ring when it's aimed at.

local state = require("lua.state")

local Recall = {}

----------------------------------------------------------------------
-- Tunables
----------------------------------------------------------------------

local RECORD_SECONDS = 0.1        -- game time between samples
local MAX_SAMPLES = 300           -- 30 seconds' worth
local MOVED_AT_LEAST = 0.5        -- world units since its last sample to count as having moved
local REWIND_MIN_SECONDS = 2      -- how long a rewind takes, for a little history...
local REWIND_MAX_SECONDS = 4      -- ...up to the full MAX_SAMPLES
local GAMEPAD_AIM_REACH = 2500    -- how far along the aim R2 looks for a planetoid (with no locked target)

local COLOR = { 1.0, 0.86, 0.25 }
local BLINK_PER_SECOND = 2.5      -- full blinks a second
local OVERLAY_ALPHA_MIN = 0.18
local OVERLAY_ALPHA_MAX = 0.55
local RING_WIDTH = 3
local PATH_DOT_SPACING = 18       -- world units between the path's dots
local PATH_ALPHA = 0.45

----------------------------------------------------------------------
-- State
----------------------------------------------------------------------

-- planetoid -> its history: { xs, ys, vxs, vys, rots, targets, head, count }
-- (head: index of the newest sample). Weak keys, so a culled planetoid's
-- history goes with it.
local histories = setmetatable({}, { __mode = "k" })
local recordClock = 0
-- planetoid -> its rewind under way: { path = {x, y, vx, vy, rot, target per point}, t, duration, lastX, lastY }
local rewinds = setmetatable({}, { __mode = "k" })
local age = 0

function Recall.reset()
  histories = setmetatable({}, { __mode = "k" })
  rewinds = setmetatable({}, { __mode = "k" })
  recordClock = 0
end

----------------------------------------------------------------------
-- Recording
----------------------------------------------------------------------

local function record(p)
  local h = histories[p]
  if not h then
    h = { xs = {}, ys = {}, vxs = {}, vys = {}, rots = {}, targets = {}, head = 0, count = 0 }
    histories[p] = h
  end
  if h.count > 0 then
    local dx, dy = p.pos.x - h.xs[h.head], p.pos.y - h.ys[h.head]
    if dx * dx + dy * dy < MOVED_AT_LEAST * MOVED_AT_LEAST then return end
  end
  local i = h.head % MAX_SAMPLES + 1
  h.head = i
  h.count = math.min(h.count + 1, MAX_SAMPLES)
  h.xs[i], h.ys[i] = p.pos.x, p.pos.y
  h.vxs[i], h.vys[i] = p.vel and p.vel.x or 0, p.vel and p.vel.y or 0
  h.rots[i] = p.rotationAngle or false
  h.targets[i] = p.target or false
end

-- How many samples of history planetoid `p` has (for debugging/tests).
function Recall.historyLength(p)
  return histories[p] and histories[p].count or 0
end

-- Whether it's rewinding right now.
function Recall.isRecalling(p)
  return rewinds[p] ~= nil
end

-- Whether planetoid `p` has anything to rewind.
function Recall.canRecall(p)
  local h = histories[p]
  return h ~= nil and h.count >= 2 and not rewinds[p]
end

----------------------------------------------------------------------
-- Choosing a planetoid
----------------------------------------------------------------------

-- Everything Recall can rewind: the planetoids, and anything else that's
-- asked to be (state.recallables — e.g. a rock let fall from its rope, see
-- lua/world/RopeRock.lua: pos, vel, radius, and containsPoint for aiming).
-- (And the belt outposts' missiles in flight — see
-- lua/world/MissileOutpost.lua: recalled, one flies back to the cannon
-- that fired it.)
local targets = {}
local function recallTargets()
  local extra = state.recallables
  local missiles = state.missiles
  if (not extra or #extra == 0) and (not missiles or #missiles == 0) then return state.planetoids or {} end
  for i = #targets, 1, -1 do targets[i] = nil end
  for _, p in ipairs(state.planetoids or {}) do targets[#targets + 1] = p end
  for _, p in ipairs(extra or {}) do targets[#targets + 1] = p end
  for _, p in ipairs(missiles or {}) do targets[#targets + 1] = p end
  return targets
end

-- Its outline, `pad` out — round, or a rectangle if it's one.
local function outline(p, mode, pad)
  if p.halfWidth and p.halfHeight and not p.isRoundedRect then
    love.graphics.rectangle(mode, p.pos.x - p.halfWidth - pad, p.pos.y - p.halfHeight - pad,
      (p.halfWidth + pad) * 2, (p.halfHeight + pad) * 2, 6, 6)
  else
    love.graphics.circle(mode, p.pos.x, p.pos.y, p.radius + pad)
  end
end

local function isCandidate(p)
  return p and p.pos and p.radius and not p.isSkyDome and not p.isOpenPath
end

-- What the player's aiming Recall at: with the mouse, the planetoid
-- under the cursor; on a gamepad, the locked target, or else the first
-- planetoid along his aim.
local function aimedPlanetoid(player)
  if state.gamepadIsActiveDevice then
    if player.lockedTarget and isCandidate(player.lockedTarget) then return player.lockedTarget end
    local ox = player.aimShoulderPos and player.aimShoulderPos.x or player.pos.x
    local oy = player.aimShoulderPos and player.aimShoulderPos.y or player.pos.y
    local a = (player.aimWorldAngle or 0) + (player.blasterAngleOffset or 0)
    local dx, dy = math.cos(a), math.sin(a)
    local best, bestT = nil, GAMEPAD_AIM_REACH
    for _, p in ipairs(recallTargets()) do
      if isCandidate(p) and p ~= player.currentPlanet then
        -- Where the aim ray first meets its circle, if it does.
        local fx, fy = p.pos.x - ox, p.pos.y - oy
        local along = fx * dx + fy * dy
        local offSq = fx * fx + fy * fy - along * along
        local rSq = p.radius * p.radius
        if along > 0 and offSq <= rSq then
          local t = along - math.sqrt(rSq - offSq)
          if t < bestT then best, bestT = p, t end
        end
      end
    end
    return best
  end

  local cam = state.camera or { x = 0, y = 0 }
  local zoom = state.zoom or 1
  local mouse = state.mouse
  if not mouse then return nil end
  local wx, wy = mouse.x / zoom + cam.x, mouse.y / zoom + cam.y
  -- (The smallest one the cursor's on, so a little planetoid in front of
  -- a big one can still be picked.)
  local best, bestR = nil, math.huge
  for _, p in ipairs(recallTargets()) do
    if isCandidate(p) then
      local hit
      if p.containsPoint then
        hit = p:containsPoint(wx, wy)
      else
        local dx, dy = wx - p.pos.x, wy - p.pos.y
        hit = dx * dx + dy * dy <= p.radius * p.radius
      end
      if hit and p.radius < bestR then best, bestR = p, p.radius end
    end
  end
  return best
end

----------------------------------------------------------------------
-- Rewinding
----------------------------------------------------------------------

local function finish(p, point)
  rewinds[p] = nil
  p.recalling = nil
  if p.vel then p.vel.x, p.vel.y = point.vx, point.vy end
  if point.rot and p.rotationAngle then p.rotationAngle = point.rot end
  if point.target and p.target then p.target = point.target end
  histories[p] = nil -- its history starts over from here
end

-- Starts (or, clicked again mid-rewind, stops) a recall on whatever the
-- player's aiming at. Returns true if it did something.
function Recall.activate(player)
  if not player then return false end
  local p = aimedPlanetoid(player)
  if not p then return false end

  local r = rewinds[p]
  if r then
    finish(p, r.path[math.min(#r.path, math.floor(r.t / r.duration * (#r.path - 1)) + 1)])
    return true
  end
  if not Recall.canRecall(p) then return false end

  -- Its path: from where it is now back through its samples, newest first.
  local h = histories[p]
  local path = { {
    x = p.pos.x, y = p.pos.y, vx = p.vel and p.vel.x or 0, vy = p.vel and p.vel.y or 0,
    rot = p.rotationAngle or false, target = p.target or false,
  } }
  for k = 0, h.count - 1 do
    local i = (h.head - 1 - k) % MAX_SAMPLES + 1
    path[#path + 1] = {
      x = h.xs[i], y = h.ys[i], vx = h.vxs[i], vy = h.vys[i], rot = h.rots[i], target = h.targets[i],
    }
  end

  local duration = REWIND_MIN_SECONDS + (REWIND_MAX_SECONDS - REWIND_MIN_SECONDS) * (h.count / MAX_SAMPLES)
  rewinds[p] = { path = path, t = 0, duration = duration, lastX = p.pos.x, lastY = p.pos.y }
  p.recalling = true
  if p.vel then p.vel.x, p.vel.y = 0, 0 end
  return true
end

-- Anything (other planetoids, asteroids) overlapping a rewinding planetoid
-- is pushed out of its way, and made to move away at least as fast as it
-- is (mvx, mvy: its movement this frame, in per-tick units like .vel).
local function shove(p, list, mvx, mvy)
  for _, o in ipairs(list or {}) do
    if o ~= p and o.pos and o.radius and not o.isImmovable and not o.recalling and o.vel then
      local dx, dy = o.pos.x - p.pos.x, o.pos.y - p.pos.y
      local sumR = p.radius + o.radius
      local distSq = dx * dx + dy * dy
      if distSq < sumR * sumR then
        local dist = math.sqrt(distSq)
        local nx, ny
        if dist > 1e-6 then nx, ny = dx / dist, dy / dist else nx, ny = 0, -1 end
        local overlap = sumR - dist
        o.pos.x, o.pos.y = o.pos.x + nx * overlap, o.pos.y + ny * overlap
        local pushN = mvx * nx + mvy * ny
        local oN = o.vel.x * nx + o.vel.y * ny
        if oN < pushN then
          o.vel.x, o.vel.y = o.vel.x + nx * (pushN - oN), o.vel.y + ny * (pushN - oN)
        end
      end
    end
  end
end

-- Call once a frame, after the planetoids' own movement (main.lua's
-- updatePlanetoidsPhysics) and before the player's, so he's carried
-- along on one that's rewinding.
function Recall.update(dt)
  local ts = state.timeScale or 1
  local gameDt = ts / 60 -- (timeScale is in 60fps ticks)
  age = age + dt

  for p, r in pairs(rewinds) do
    r.t = r.t + gameDt
    local n = #r.path
    local u = math.min(1, r.t / r.duration) * (n - 1)
    local k = math.floor(u)
    local a, b = r.path[k + 1], r.path[math.min(n, k + 2)]
    local f = u - k
    p.pos.x = a.x + (b.x - a.x) * f
    p.pos.y = a.y + (b.y - a.y) * f
    if a.rot and b.rot and p.rotationAngle then
      -- (The short way round.)
      local d = math.atan2(math.sin(b.rot - a.rot), math.cos(b.rot - a.rot))
      p.rotationAngle = a.rot + d * f
    end
    local mvx, mvy = 0, 0
    if ts > 0 then mvx, mvy = (p.pos.x - r.lastX) / ts, (p.pos.y - r.lastY) / ts end
    r.lastX, r.lastY = p.pos.x, p.pos.y
    shove(p, state.planetoids, mvx, mvy)
    shove(p, state.asteroids, mvx, mvy)
    if r.t >= r.duration then finish(p, r.path[n]) end
  end

  recordClock = recordClock + gameDt
  if recordClock >= RECORD_SECONDS then
    recordClock = recordClock % RECORD_SECONDS
    for _, p in ipairs(recallTargets()) do
      if p.pos and not p.recalling then record(p) end
    end
  end
end

----------------------------------------------------------------------
-- Drawing
----------------------------------------------------------------------

-- In world space, over the planetoids.
function Recall.draw()
  local blink = 0.5 + 0.5 * math.sin(age * BLINK_PER_SECOND * math.pi * 2)

  for p, r in pairs(rewinds) do
    -- The rest of its path, as a faint dotted line.
    local n = #r.path
    local u = math.min(1, r.t / r.duration) * (n - 1)
    local k = math.floor(u)
    love.graphics.setColor(COLOR[1], COLOR[2], COLOR[3], PATH_ALPHA)
    local carry = 0
    local px, py = p.pos.x, p.pos.y
    for j = k + 2, n do
      local q = r.path[j]
      local dx, dy = q.x - px, q.y - py
      local len = math.sqrt(dx * dx + dy * dy)
      local s = PATH_DOT_SPACING - carry
      while s <= len do
        love.graphics.circle("fill", px + dx * s / len, py + dy * s / len, 2)
        s = s + PATH_DOT_SPACING
      end
      carry = len - (s - PATH_DOT_SPACING)
      px, py = q.x, q.y
    end

    -- The blinking yellow overlay and ring.
    love.graphics.setColor(COLOR[1], COLOR[2], COLOR[3], OVERLAY_ALPHA_MIN + (OVERLAY_ALPHA_MAX - OVERLAY_ALPHA_MIN) * blink)
    outline(p, "fill", 0)
    love.graphics.setLineWidth(RING_WIDTH)
    love.graphics.setColor(COLOR[1], COLOR[2], COLOR[3], 0.6 + 0.4 * blink)
    outline(p, "line", RING_WIDTH / 2)
  end

  -- In Recall mode: a thin ring round what's aimed at, if it can be recalled.
  if state.recallMode and state.player then
    local p = aimedPlanetoid(state.player)
    if p and Recall.canRecall(p) then
      love.graphics.setLineWidth(2)
      love.graphics.setColor(COLOR[1], COLOR[2], COLOR[3], 0.7)
      outline(p, "line", 4)
    end
  end

  love.graphics.setLineWidth(1)
  love.graphics.setColor(1, 1, 1, 1)
end

return Recall
