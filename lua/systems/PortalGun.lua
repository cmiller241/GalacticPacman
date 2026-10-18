-- lua/systems/PortalGun.lua
--
-- Portal mode (one of the modes P cycles through — see WeaponModes.lua): the blaster
-- shoots portals instead of fireballs/pull beams. Left click / L2 makes
-- the red portal, right click / R2 the blue one. A shot is instant
-- (hitscan, like Mari0's portal gun): a ray from the blaster's muzzle
-- along the aim, stopping at the first solid surface it touches, where
-- the portal is placed flat against that surface. Only one portal of
-- each color exists — a new one replaces the old.
--
-- Portals stick to whatever they landed on (a drifting belt planetoid
-- carries its portal along) and vanish if that thing is removed.
-- Nothing travels through them yet.
--
-- Surfaces a shot can land on: every solid planetoid (circles, rounded
-- rects — the pinball planet, Tiled terrain pieces — and the sky dome's
-- glass, floor and base) plus Tiled wall tiles and closed Gates (a
-- portal on a gate goes when the gate moves). Jump-through ledges only
-- count from above: a shot from underneath passes through them. Water bodies are skipped
-- (they aren't solid — the shot lands on the core inside instead).

local state = require("lua.state")
local constants = require("lua.constants")
local SilhouetteGlow = require("lua.effects.SilhouetteGlow")
local Vector2 = require("lua.vector2")

local PortalGun = {}

----------------------------------------------------------------------
-- Tunables
----------------------------------------------------------------------

local MAX_RANGE = 2500          -- world units a shot travels before giving up
local HIT_DISTANCE = 2          -- this close to a surface counts as touching it
local MIN_STEP, MAX_STEP = 1.5, 24 -- ray-march step clamp (MAX_STEP keeps thin/half surfaces from being skipped)
local SHOT_COOLDOWN = 0.2       -- seconds between shots

local PORTAL_HALF_LENGTH = 70   -- along the surface (a little more than Bob is tall, so he fits through)
local PORTAL_SURFACE_OFFSET = 3 -- drawn this far off the surface, so it sits on top of it

local TRACER_LIFE = 0.18        -- seconds the shot's streak stays visible
local PARTICLES_PER_SECOND = 45
local PARTICLE_LIFE_MIN, PARTICLE_LIFE_RANGE = 0.6, 0.6
local PARTICLE_SPEED_MIN, PARTICLE_SPEED_RANGE = 30, 50 -- world units/second, outward from the surface

-- The look: like the transport beams (lua/world/Beam.lua) — light, not a
-- hole. A glowing mouth along the surface (curved round anything round),
-- a curtain of light rising off it and fading out, shafts of light of
-- different lengths shooting out of it and flickering, and motes drifting
-- away — all additive, so overlapping light brightens.
local MOUTH_POINTS = 24         -- segments the mouth's curve is drawn with
local CURTAIN_HEIGHT = 75       -- how far the light curtain rises before fading out
local SHAFT_COUNT = 9
local SHAFT_LENGTH_MIN, SHAFT_LENGTH_RANGE = 55, 120
local SHAFT_WIDTH_MIN, SHAFT_WIDTH_RANGE = 5, 12
local SHAFT_LIFE_MIN, SHAFT_LIFE_RANGE = 0.9, 1.4 -- seconds each shaft lasts before reappearing somewhere else

-- Afterglow on anything that's just come out of a portal: a glow hugging
-- its silhouette in the exit portal's color (SilhouetteGlow, the same
-- effect Bob gets standing near a transport beam), fading out, while it
-- sheds light motes that stay behind where they're dropped (so a fast
-- exit leaves a short trail).
local AFTERGLOW_SECONDS = 0.8
local AFTERGLOW_STRENGTH = 0.9    -- glow brightness right as it comes out
local AFTERGLOW_REACH = 14        -- how far the glow spreads past its outline, world units
local AFTERGLOW_MOTES_PER_SECOND = 40
local AFTERGLOW_MOTE_LIFE_MIN, AFTERGLOW_MOTE_LIFE_RANGE = 0.4, 0.5
local AFTERGLOW_MOTE_SPEED_MIN, AFTERGLOW_MOTE_SPEED_RANGE = 10, 30 -- world units/second, drifting off in any direction

local COLORS = {
  red  = { core = { 1.00, 0.30, 0.22 }, glow = { 1.00, 0.45, 0.25 }, bright = { 1.00, 0.85, 0.75 } },
  blue = { core = { 0.20, 0.55, 1.00 }, glow = { 0.35, 0.70, 1.00 }, bright = { 0.80, 0.92, 1.00 } },
}

----------------------------------------------------------------------
-- Surfaces: each returns distance, nearest point and outward normal
----------------------------------------------------------------------

local function circleSurface(p, x, y)
  local dx, dy = x - p.pos.x, y - p.pos.y
  local len = math.sqrt(dx * dx + dy * dy)
  if len < 1e-6 then dx, dy, len = 0, -1, 1 end
  local nx, ny = dx / len, dy / len
  return len - p.radius, p.pos.x + nx * p.radius, p.pos.y + ny * p.radius, nx, ny
end

local function nearestToSurface(near)
  return near.distance, near.point.x, near.point.y, near.normal.x, near.normal.y
end

-- The dome is three surfaces: glass (upper half of the big ellipse),
-- the walkable floor (a flat line across its width) and the metal base
-- (lower half of the small ellipse). Each half-ellipse only counts on
-- its own side of the anchor line, or the full ellipse's unused half
-- would hang in empty space.
local function domeSurface(d, x, y)
  local best, bx, by, bnx, bny = math.huge, x, y, 0, -1
  local anchorY = d:domeAnchorY()

  local topY = d:trueSurfaceY()
  local minX, maxX = d.pos.x - d.halfWidth, d.pos.x + d.halfWidth
  local fx = math.max(minX, math.min(maxX, x))
  local fd = math.sqrt((x - fx) ^ 2 + (y - topY) ^ 2)
  if fd < best then best, bx, by, bnx, bny = fd, fx, topY, 0, -1 end

  if y <= anchorY then
    local g = d:nearestDomeSurfacePoint(x, y)
    if g.distance < best then best, bx, by, bnx, bny = nearestToSurface(g) end
  else
    local b = d:nearestBaseSurfacePoint(x, y)
    if b.distance < best then best, bx, by, bnx, bny = nearestToSurface(b) end
  end
  return best, bx, by, bnx, bny
end

local function planetoidSurface(p, x, y)
  if p.isSkyDome then return domeSurface(p, x, y) end
  if p.isRoundedRect then return nearestToSurface(p:nearestSurfacePoint(x, y)) end
  return circleSurface(p, x, y)
end

local function wallSurface(w, x, y)
  local minX, maxX = w.pos.x - w.halfWidth, w.pos.x + w.halfWidth
  local minY, maxY = w.pos.y - w.halfHeight, w.pos.y + w.halfHeight
  local cx = math.max(minX, math.min(maxX, x))
  local cy = math.max(minY, math.min(maxY, y))
  local dx, dy = x - cx, y - cy
  local dist = math.sqrt(dx * dx + dy * dy)
  local nx, ny
  if math.abs(dx) >= math.abs(dy) then nx, ny = (dx >= 0 and 1 or -1), 0 else nx, ny = 0, (dy >= 0 and 1 or -1) end
  return dist, cx, cy, nx, ny
end

----------------------------------------------------------------------
-- Raycast
----------------------------------------------------------------------

-- Distance from point (px, py) to the segment a->b.
local function distToSegment(px, py, ax, ay, bx, by)
  local abx, aby = bx - ax, by - ay
  local t = ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby)
  t = math.max(0, math.min(1, t))
  local cx, cy = ax + abx * t, ay + aby * t
  return math.sqrt((px - cx) ^ 2 + (py - cy) ^ 2)
end

-- Only things the ray actually passes near get marched against.
local function gatherCandidates(ox, oy, ex, ey)
  local list = {}
  for _, p in ipairs(state.planetoids or {}) do
    if not p.isWaterPlanet then
      local cx, cy, r = p.pos.x, p.pos.y, nil
      if p.isSkyDome then
        cy = p:domeAnchorY()
        r = math.max(p.domeRadiusX or 0, p.domeRadiusY or 0, p.halfWidth or 0) + 50
      elseif p.isRoundedRect and p.halfWidth then
        r = math.sqrt(p.halfWidth ^ 2 + p.halfHeight ^ 2) + 50
      else
        r = (p.radius or 0) + 50
      end
      if distToSegment(cx, cy, ox, oy, ex, ey) <= r then
        -- Tiled terrain's open-path shapes are one-way ledges: solid
        -- from their walkable side only (Bob jumps up through them).
        table.insert(list, { obj = p, surface = planetoidSurface, oneWay = p.isOpenPath })
      end
    end
  end
  for _, level in ipairs(state.tiledLevels or {}) do
    for _, w in ipairs(level.walls or {}) do
      -- Wall tiles, and Gates (same list) unless retracted all the way:
      -- a shot at a closed gate lands on the gate, not on what's behind it.
      if w.isWall or (w.isGate and w.halfHeight > 1) then
        local r = math.sqrt(w.halfWidth ^ 2 + w.halfHeight ^ 2) + 50
        if distToSegment(w.pos.x, w.pos.y, ox, oy, ex, ey) <= r then
          table.insert(list, { obj = w, surface = wallSurface })
        end
      end
    end
  end
  return list
end

-- First surface along the ray from (ox, oy) in unit direction (dx, dy).
-- Returns a hit { x, y, nx, ny, obj } (normal facing back toward the
-- shooter) or nil, plus how far the ray got.
function PortalGun.raycast(ox, oy, dx, dy, maxRange)
  maxRange = maxRange or MAX_RANGE
  local candidates = gatherCandidates(ox, oy, ox + dx * maxRange, oy + dy * maxRange)
  local traveled = 0
  while traveled <= maxRange do
    local x, y = ox + dx * traveled, oy + dy * traveled
    local nearest, hit = math.huge, nil
    for _, c in ipairs(candidates) do
      local dist, sx, sy, nx, ny = c.surface(c.obj, x, y)
      -- A one-way ledge met from underneath (heading the same way its
      -- walkable side faces) isn't there for the shot: it passes
      -- through and lands on whatever is beyond. From above, it's a floor.
      if c.oneWay and nx * dx + ny * dy >= 0 then dist = math.huge end
      if dist < nearest then
        nearest = dist
        if dist <= HIT_DISTANCE then hit = { x = sx, y = sy, nx = nx, ny = ny, obj = c.obj } end
      end
    end
    if hit then
      -- Face the side the shot came from (open shapes and the inside of
      -- the dome report normals that can point either way).
      if hit.nx * dx + hit.ny * dy > 0 then hit.nx, hit.ny = -hit.nx, -hit.ny end
      return hit, traveled
    end
    traveled = traveled + math.max(MIN_STEP, math.min(MAX_STEP, nearest))
  end
  return nil, maxRange
end

----------------------------------------------------------------------
-- Portals
----------------------------------------------------------------------

-- Stored relative to the thing it's on (in that thing's own turned
-- frame, if it turns), so it rides along when that thing moves.
local function toLocal(obj, x, y, nx, ny)
  local a = obj.rotationAngle or 0
  local c, s = math.cos(-a), math.sin(-a)
  local dx, dy = x - obj.pos.x, y - obj.pos.y
  return dx * c - dy * s, dx * s + dy * c, nx * c - ny * s, nx * s + ny * c
end

local function refreshWorldPlacement(portal)
  local obj = portal.obj
  local a = obj.rotationAngle or 0
  local c, s = math.cos(a), math.sin(a)
  local lx, ly, lnx, lny = portal.localX, portal.localY, portal.localNX, portal.localNY
  portal.x = obj.pos.x + lx * c - ly * s
  portal.y = obj.pos.y + lx * s + ly * c
  portal.nx = lnx * c - lny * s
  portal.ny = lnx * s + lny * c
  -- The mouth's curve, likewise.
  portal.mouth = portal.mouth or {}
  for i, m in ipairs(portal.mouthLocal) do
    local w = portal.mouth[i] or {}
    w.x = obj.pos.x + m.x * c - m.y * s
    w.y = obj.pos.y + m.x * s + m.y * c
    w.nx = m.nx * c - m.ny * s
    w.ny = m.nx * s + m.ny * c
    portal.mouth[i] = w
  end
end

-- The portal's mouth as MOUTH_POINTS+1 points along the surface, each
-- with the surface's own outward normal there: an arc hugging a round
-- planet, following the surface on anything else curved (the dome's
-- glass, a rounded corner, a slope), and straight on walls and gates.
local function buildMouth(hit)
  local obj = hit.obj
  local tx, ty = -hit.ny, hit.nx
  local points = {}
  local isCircle = not (obj.isWall or obj.isGate or obj.isRoundedRect or obj.isSkyDome) and obj.radius
  if isCircle then
    local cx, cy, R = obj.pos.x, obj.pos.y, obj.radius
    local mid = math.atan2(hit.y - cy, hit.x - cx)
    local half = math.min(PORTAL_HALF_LENGTH / R, math.pi * 0.85) -- the same length, measured round the curve
    -- (Clockwise vs. counter-clockwise, to run the same way as the tangent.)
    local dir = ((-math.sin(mid)) * tx + math.cos(mid) * ty) >= 0 and 1 or -1
    local side = ((hit.x - cx) * hit.nx + (hit.y - cy) * hit.ny) >= 0 and 1 or -1
    for i = 0, MOUTH_POINTS do
      local a = mid + dir * half * (2 * i / MOUTH_POINTS - 1)
      local ox, oy = math.cos(a), math.sin(a)
      table.insert(points, { x = cx + ox * R, y = cy + oy * R, nx = ox * side, ny = oy * side })
    end
  else
    for i = 0, MOUTH_POINTS do
      local t = PORTAL_HALF_LENGTH * (2 * i / MOUTH_POINTS - 1)
      local px, py = hit.x + tx * t, hit.y + ty * t
      local x, y, nx, ny = px, py, hit.nx, hit.ny
      if not (obj.isWall or obj.isGate) then
        -- Dropped onto the actual surface from just in front of it.
        local dist, sx, sy, snx, sny = planetoidSurface(obj, px + hit.nx * 4, py + hit.ny * 4)
        if dist < 40 then
          if snx * hit.nx + sny * hit.ny < 0 then snx, sny = -snx, -sny end
          x, y, nx, ny = sx, sy, snx, sny
        end
      end
      table.insert(points, { x = x, y = y, nx = nx, ny = ny })
    end
  end
  return points
end

local function isStillInWorld(portal)
  local obj = portal.obj
  if obj.isWall then return true end -- Tiled walls live as long as the level
  -- A portal on a gate goes the moment the gate starts sliding.
  if obj.isGate then return obj.slideProgress == portal.gateProgress end
  for _, p in ipairs(state.planetoids or {}) do
    if p == obj then return true end
  end
  return false
end

local function placePortal(color, hit)
  state.portals = state.portals or {}
  local lx, ly, lnx, lny = toLocal(hit.obj, hit.x, hit.y, hit.nx, hit.ny)
  local mouthLocal = {}
  for _, m in ipairs(buildMouth(hit)) do
    local mx, my, mnx, mny = toLocal(hit.obj, m.x, m.y, m.nx, m.ny)
    table.insert(mouthLocal, { x = mx, y = my, nx = mnx, ny = mny })
  end
  local portal = {
    color = color, obj = hit.obj,
    localX = lx, localY = ly, localNX = lnx, localNY = lny,
    mouthLocal = mouthLocal,
    particles = {}, particleBudget = 0, age = 0, shafts = {},
    gateProgress = hit.obj.isGate and hit.obj.slideProgress or nil, -- see isStillInWorld
  }
  refreshWorldPlacement(portal)
  state.portals[color] = portal -- replaces any earlier portal of this color
end

-- color: "red" or "blue".
function PortalGun.fire(player, color)
  if not player or (player.mode ~= "space" and player.mode ~= "platform") then return end
  if player.isBall or player.isTeleporting or player.isDying or state.vatsActive then return end

  local now = love.timer.getTime()
  if now - (PortalGun.lastShotTime or 0) < SHOT_COOLDOWN then return end
  PortalGun.lastShotTime = now

  local angle = (player.aimWorldAngle or 0) + (player.blasterAngleOffset or 0)
  local dx, dy = math.cos(angle), math.sin(angle)
  local ox, oy = player:getMuzzlePosition()
  local hit, traveled = PortalGun.raycast(ox, oy, dx, dy)

  state.portalTracers = state.portalTracers or {}
  table.insert(state.portalTracers, {
    color = color, x1 = ox, y1 = oy,
    x2 = hit and hit.x or ox + dx * traveled, y2 = hit and hit.y or oy + dy * traveled,
    life = TRACER_LIFE, missed = not hit,
  })
  if hit then placePortal(color, hit) end
end

----------------------------------------------------------------------
-- Going through
----------------------------------------------------------------------
--
-- With both portals up, Bob goes in one and comes out the other, Portal
-- style. The portal is a hole in its surface: standing on a floor portal
-- drops him in, and moving into any portal (falling onto it, running or
-- jumping into a wall or ceiling one) takes him in too.
--
-- While he's passing through he follows a fixed path (normal movement,
-- gravity and collision are off — see main.lua) and is drawn twice: the
-- part of him still in front of the entry portal, and the part already
-- through, coming out of the exit portal. The two portals are linked by
-- a rotation, so what goes in one face-first comes out the other the
-- same way: floor to floor brings him out upside down, floor to ceiling
-- brings him out feet first. He comes out as fast as he went in
-- (stepping onto a floor portal counts as a small fall), so he pops back
-- out the other side.

local ENTER_REACH = 4             -- how far past touching (world units) still counts as at the portal
local ENTER_MIN_INWARD_SPEED = 0.5 -- slower than this into a portal isn't "going in" (unless standing on it)
local ENTER_STEP_SPEED = 4        -- world units/frame he starts at when he steps onto a floor portal
local TRANSIT_MIN_SPEED = 2       -- never slower than this inside, so he always makes it through
local TRANSIT_MAX_SPEED = 25
local HEAD_DRAW_PAD = 10          -- his drawn helmet reaches this far past player.headReach (which is trimmed short — see Player.new)
local EXIT_UPRIGHT_RATE = 0.12    -- fraction of the way back to upright he turns each frame after coming out
local CENTERING_SPEED = 6         -- world units/frame he slides toward the portal's middle on the way in

local function tangentOf(portal) return -portal.ny, portal.nx end

local function otherPortal(color)
  local portals = state.portals
  if not portals then return nil end
  return portals[color == "red" and "blue" or "red"]
end

-- Where a point given relative to `from` (along its tangent, out along
-- its normal) ends up at `to`: both flipped, so the link is a rotation
-- (never a mirror image).
local function mapPoint(from, to, along, out)
  local ttx, tty = tangentOf(to)
  return to.x - ttx * along - to.nx * out, to.y - tty * along - to.ny * out
end

-- The rotation that carries anything through from `from` to `to`.
local function linkRotation(from, to)
  return math.atan2(to.ny, to.nx) - math.atan2(from.ny, from.nx) + math.pi
end

-- Where a point on the entry side of a trip (world x, y) shows up on the
-- exit side — the same carry-over the emerging half is drawn with.
local function carryThrough(tr, x, y)
  local from = tr.from
  local tx, ty = tangentOf(from)
  local rx, ry = x - from.x, y - from.y
  return mapPoint(from, tr.to, rx * tx + ry * ty, rx * from.nx + ry * from.ny)
end

local function rotate(x, y, a)
  local c, s = math.cos(a), math.sin(a)
  return x * c - y * s, x * s + y * c
end

-- Gravity just in front of a portal (where a traveler's middle is as it
-- passes through, `offset` out from the surface), worked out exactly the
-- way GravitySystem:applyTo pulls things in the air: direction and
-- strength of the dominant body there. Returns the pull as a vector
-- (direction times strength).
local function gravityAt(portal, offset, influence)
  local x, y = portal.x + portal.nx * offset, portal.y + portal.ny * offset
  local gs = state.gravitySystem
  local dominant = gs and gs:findDominantPlanet(Vector2.new(x, y), influence)
  if not dominant then return Vector2.new(0, 0) end
  local dx, dy
  if dominant.isRoundedRect and dominant.nearestSurfacePoint then
    local surface = dominant:nearestSurfacePoint(x, y)
    if surface.distance > 1e-6 then
      dx, dy = surface.point.x - x, surface.point.y - y
    else
      dx, dy = -surface.normal.x, -surface.normal.y
    end
  else
    dx, dy = dominant.pos.x - x, dominant.pos.y - y
  end
  local len = math.sqrt(dx * dx + dy * dy)
  if len < 1e-6 then return Vector2.new(0, 0) end
  local strength = dominant.gravityStrength or constants.GRAVITY_STRENGTH
  return Vector2.new(dx / len * strength, dy / len * strength)
end

----------------------------------------------------------------------
-- A trip through (shared by Bob and the Ooombas)
----------------------------------------------------------------------

-- Starts a trip from portal `color` for anything passing through.
-- along/out: where its middle is relative to the entry portal. speed:
-- how fast it's moving in. down: its "down" going in. trail: how far its
-- middle goes past the entry portal before the last of it is through.
-- offset/influence: for the gravity along the way (see gravityAt).
local function beginTrip(color, along, out, speed, alongSpeed, down, trail, offset, influence)
  local from, to = state.portals[color], otherPortal(color)
  return {
    from = from, to = to, along = along, out = out,
    speed = math.min(TRANSIT_MAX_SPEED, math.max(ENTER_STEP_SPEED, speed)),
    alongSpeed = alongSpeed, down = down, trail = trail,
    entryGravity = gravityAt(from, offset, influence),
    exitGravity = gravityAt(to, offset, influence),
  }
end

-- One frame along the trip. Gravity keeps acting the whole way, on
-- whichever side the traveler's middle is: pulling it in while that's
-- still in front of the entry portal, and (for a floor exit) slowing it
-- as it climbs out of the exit one. So it comes out exactly as fast as a
-- real fall would allow — a step onto a floor portal only just pops it
-- out the far side — and a fall between two floor portals keeps going,
-- Portal style. It's also slid in from the portal's ends far enough that
-- all of it (halfWidth across) fits through the opening. Returns its
-- position on the entry side, and whether it's all the way through.
local function advanceTrip(tr, ts, halfWidth)
  local g, axisX, axisY
  if tr.out > 0 then
    g, axisX, axisY = tr.entryGravity, -tr.from.nx, -tr.from.ny -- moving into the entry portal
  else
    g, axisX, axisY = tr.exitGravity, tr.to.nx, tr.to.ny        -- moving out of the exit portal
  end
  tr.speed = tr.speed + (g.x * axisX + g.y * axisY) * ts
  tr.speed = math.max(TRANSIT_MIN_SPEED, math.min(TRANSIT_MAX_SPEED, tr.speed))
  tr.out = tr.out - tr.speed * ts
  local fit = math.max(0, PORTAL_HALF_LENGTH - halfWidth)
  local target = math.max(-fit, math.min(fit, tr.along))
  tr.along = tr.along + math.max(-CENTERING_SPEED * ts, math.min(CENTERING_SPEED * ts, target - tr.along))

  local from = tr.from
  local tx, ty = tangentOf(from)
  return from.x + tx * tr.along + from.nx * tr.out, from.y + ty * tr.along + from.ny * tr.out,
    tr.out <= -tr.trail
end

-- The afterglow (see AFTERGLOW_SECONDS) in a portal's color, at full
-- strength: started as something sets off through toward that portal
-- (it glows while it's coming out of it, then fades once it's all the
-- way out), and topped up again on the way out. One still fading from an
-- earlier trip just changes color, keeping its trail of motes.
local function startAfterglow(thing, portal)
  local glow = thing.portalGlow or { moteBudget = 0, motes = {} }
  glow.color = COLORS[portal.color].glow
  glow.timer = AFTERGLOW_SECONDS
  thing.portalGlow = glow
end

-- Out of the exit portal: position, velocity (moving out of it, with
-- whatever sideways speed it went in with) and its new "down".
local function finishTrip(tr)
  local from, to = tr.from, tr.to
  local x, y = mapPoint(from, to, tr.along, tr.out)
  local ttx, tty = tangentOf(to)
  local vx = to.nx * tr.speed - ttx * tr.alongSpeed
  local vy = to.ny * tr.speed - tty * tr.alongSpeed
  local dx, dy = rotate(tr.down.x, tr.down.y, linkRotation(from, to))
  return x, y, vx, vy, Vector2.new(dx, dy)
end

-- How far his body reaches from his middle in direction (dx, dy), given
-- his "down": his feet are his collision circle's radius below his
-- middle, but his head is a good deal further above it (player.headReach,
-- the same height his ceiling collision uses). So jumping up into a
-- ceiling portal, his head gets there long before his middle would.
local function bodyReach(player, down, dx, dy, headPad)
  local r = player.radius
  local head = math.max(r, (player.isBall and r or (player.headReach or r)) + (headPad or 0))
  local upward = math.max(0, -(down.x * dx + down.y * dy)) -- how much (dx, dy) points toward his head
  return r + (head - r) * upward
end

local function canTravel(player)
  return not (player.inPinball or player.isTeleporting or player.isDying or player.morphState
    or state.titleScreen or state.introLocked)
end

-- Called once a frame after he's moved but BEFORE collision: starts a
-- trip through if he's at a portal and going into it. (Before, so that
-- landing on a floor portal hasn't already stopped his fall.)
function PortalGun.tryEnter(player)
  if player.portalTransit or not canTravel(player) then return end
  local portals = state.portals
  if not (portals and portals.red and portals.blue) then return end

  for _, color in ipairs({ "red", "blue" }) do
    local from = portals[color]
    local tx, ty = tangentOf(from)
    local rx, ry = player.pos.x - from.x, player.pos.y - from.y
    local out = rx * from.nx + ry * from.ny
    local along = rx * tx + ry * ty
    local r = player.radius
    local down = player:visualDownDirection(player.currentPlanet)
    -- Whichever part of him leads into it has to reach it: feet into a
    -- floor portal, head into a ceiling one, his side into a wall one.
    local lead = bodyReach(player, down, -from.nx, -from.ny)
    -- Anywhere along the portal counts (he's slid to the middle on the
    -- way in — see updateTransit), so a portal shot from the blaster,
    -- which sits out at the end of his arm, still catches him jumping
    -- straight up into it.
    if math.abs(along) <= PORTAL_HALF_LENGTH and out <= lead + ENTER_REACH and out > -r * 0.5 then
      local inward = -(player.vel.x * from.nx + player.vel.y * from.ny)
      -- Standing on it: only a portal under his feet, not one in a wall
      -- he happens to be standing beside.
      local underFeet = player.onSurface and -(down.x * from.nx + down.y * from.ny) > 0.7
      if inward > ENTER_MIN_INWARD_SPEED or underFeet then
        player.portalTransit = beginTrip(color, along, out, inward,
          player.vel.x * tx + player.vel.y * ty, down,
          bodyReach(player, down, from.nx, from.ny, HEAD_DRAW_PAD), -- until his trailing end is through
          r, player.lastInfluencePlanet)
        player.portalDown = down -- held for the trip
        startAfterglow(player, player.portalTransit.to) -- glowing while he comes out the far side
        player.onSurface = false
        player.currentPlanet = nil
        player.isGroundPounding = false
        return
      end
    end
  end
end

-- In place of normal movement/gravity/collision while he's in transit.
function PortalGun.updateTransit(player, ts)
  local tr = player.portalTransit
  player.prevPos = player.pos:clone()
  player.onSurface = false
  player.currentPlanet = nil

  -- His position on the entry side (drawn there, clipped at the portal).
  local x, y, through = advanceTrip(tr, ts, player.radius * 0.6)
  player.pos.x, player.pos.y = x, y
  player.vel.x, player.vel.y = 0, 0
  -- The camera follows whichever side most of him is on.
  if tr.out < 0 then
    tr.cameraX, tr.cameraY = mapPoint(tr.from, tr.to, tr.along, tr.out)
  else
    tr.cameraX, tr.cameraY = x, y
  end

  if through then
    local vx, vy, down
    player.pos.x, player.pos.y, vx, vy, down = finishTrip(tr)
    player.vel.x, player.vel.y = vx, vy
    player.prevPos = player.pos:clone()
    player.portalDown = down -- eases back upright (see PortalGun.update)
    startAfterglow(player, tr.to) -- fades from here, now he's all the way out
    player.portalTransit = nil
  end
end

-- After coming out (possibly upside down), he turns back to his natural
-- "down" over a moment instead of snapping to it.
local function easeUpright(player)
  if not player.portalDown or player.portalTransit then return end
  local held = player.portalDown
  player.portalDown = nil
  local natural = player:visualDownDirection(player.onSurface and player.currentPlanet or player.lastInfluencePlanet)
  if player.onSurface then return end -- landed: straight to normal
  local a, b = math.atan2(held.y, held.x), math.atan2(natural.y, natural.x)
  local diff = (b - a + math.pi) % (2 * math.pi) - math.pi
  if math.abs(diff) < 0.02 then return end
  local next = a + diff * EXIT_UPRIGHT_RATE * state.timeScale
  player.portalDown = Vector2.new(math.cos(next), math.sin(next))
end

-- Fireballs go through too: one touching a portal while heading into it
-- comes straight out of the other, just in front of it, its direction
-- turned the same way Bob's would be. Called right after fireballs move
-- and before their collision checks, so the portal's surface never gets
-- the chance to stop one.
function PortalGun.passFireballs(fireballs, ts)
  for _, f in ipairs(fireballs) do
    local x, y, vx, vy = PortalGun.passPoint(f.pos.x, f.pos.y, f.vel.x, f.vel.y, f.radius, ts)
    if x then f.pos.x, f.pos.y, f.vel.x, f.vel.y = x, y, vx, vy end
  end
end

-- Carries something at (x, y) moving at (vx, vy) through portal `from`
-- and out of the other one: where it comes out (`clearance` out in front
-- of the exit) and its new velocity, turned the same way Bob's would be,
-- plus the exit portal. Nil if there's no other portal.
function PortalGun.throughPortal(from, x, y, vx, vy, clearance)
  local to = otherPortal(from.color)
  if not to then return nil end
  local tx, ty = tangentOf(from)
  local along = (x - from.x) * tx + (y - from.y) * ty
  local ox, oy = mapPoint(from, to, along, -(clearance or 2))
  local nvx, nvy = rotate(vx, vy, linkRotation(from, to))
  return ox, oy, nvx, nvy, to
end

-- For anything small flying about (fireballs, water droplets — radius:
-- how big it is): if it's touching a portal, within its opening, heading
-- into it, it comes straight out of the other one (see throughPortal).
-- Returns its new position and velocity and the exit portal, or nil if it
-- didn't go through. Call right after it moves and before anything checks
-- it against the surface the portal is on.
function PortalGun.passPoint(x, y, vx, vy, radius, ts)
  local portals = state.portals
  if not (portals and portals.red and portals.blue) then return nil end
  for _, color in ipairs({ "red", "blue" }) do
    local from = portals[color]
    local tx, ty = tangentOf(from)
    local rx, ry = x - from.x, y - from.y
    local out = rx * from.nx + ry * from.ny
    local along = rx * tx + ry * ty
    local inward = -(vx * from.nx + vy * from.ny)
    local outBefore = out + inward * ts -- where it was a frame ago
    if inward > 0 and out <= radius and outBefore > -radius
        and math.abs(along) <= PORTAL_HALF_LENGTH - radius then
      return PortalGun.throughPortal(from, x, y, vx, vy, radius + 2)
    end
  end
  return nil
end

-- A half-plane in front of a portal's surface, for clipping.
local function stencilFrontOf(portal)
  local tx, ty = tangentOf(portal)
  local L = 20000
  love.graphics.polygon("fill",
    portal.x - tx * L, portal.y - ty * L,
    portal.x + tx * L, portal.y + ty * L,
    portal.x + tx * L + portal.nx * L, portal.y + ty * L + portal.ny * L,
    portal.x - tx * L + portal.nx * L, portal.y - ty * L + portal.ny * L)
end

-- Draws anything that's mid-trip (or not: then just draws it), split
-- across the two portals.
-- glowBound/glowShape: for the afterglow on the part coming out (see
-- drawAfterglowUnder) — how far its shape reaches, and a function drawing
-- just its shape.
local function drawSplit(thing, tr, glowBound, glowShape)
  if not tr then
    thing:draw()
    return
  end
  local from, to = tr.from, tr.to
  local rot = linkRotation(from, to)
  local function carried(drawFn)
    love.graphics.push()
    love.graphics.translate(to.x, to.y)
    love.graphics.rotate(rot)
    love.graphics.translate(-from.x, -from.y)
    drawFn()
    love.graphics.pop()
  end

  -- The part still in front of the entry portal.
  love.graphics.stencil(function() stencilFrontOf(from) end, "replace", 1)
  love.graphics.setStencilTest("greater", 0)
  thing:draw()

  -- The part already through: the same drawing, carried over to the exit
  -- portal by the rotation that links them — already glowing in the exit
  -- portal's color as it comes out (clipped to the open side, like it).
  love.graphics.stencil(function() stencilFrontOf(to) end, "replace", 1)
  local glow = thing.portalGlow
  if glow and glowShape then
    local gx, gy = carryThrough(tr, thing.pos.x, thing.pos.y)
    local t = glow.timer / AFTERGLOW_SECONDS
    SilhouetteGlow.draw(gx, gy, glowBound, AFTERGLOW_REACH, glow.color, AFTERGLOW_STRENGTH * t * t,
      function() carried(glowShape) end)
  end
  carried(function() thing:draw() end)
  love.graphics.setStencilTest()
end

-- The afterglow: the silhouette glow under the thing (drawn before it),
-- and its motes (drawn after, over it).
local function drawAfterglowUnder(thing, x, y, bound, drawShape)
  local glow = thing.portalGlow
  if not glow or glow.timer <= 0 or thing.portalTransit then return end
  local t = glow.timer / AFTERGLOW_SECONDS
  SilhouetteGlow.draw(x, y, bound, AFTERGLOW_REACH, glow.color, AFTERGLOW_STRENGTH * t * t, drawShape)
end

local function drawAfterglowMotes(thing)
  local glow = thing.portalGlow
  if not glow then return end
  local r, g, b = glow.color[1], glow.color[2], glow.color[3]
  love.graphics.setBlendMode("add")
  for _, m in ipairs(glow.motes) do
    local t = m.life / m.maxLife
    love.graphics.setColor(1, 1, 1, t * 0.8)
    love.graphics.circle("fill", m.x, m.y, m.size * (0.5 + t * 0.5))
    love.graphics.setColor(r, g, b, t * 0.35)
    love.graphics.circle("fill", m.x, m.y, m.size * 2.2)
  end
  love.graphics.setBlendMode("alpha")
  love.graphics.setColor(1, 1, 1, 1)
end

-- Draws Bob: split across the two portals while he's going through, with
-- an afterglow once he's out.
function PortalGun.drawPlayer(player)
  local bound, shape = player.radius * 4, function() player:drawRig() end
  if player.portalTransit then
    drawSplit(player, player.portalTransit, bound, shape)
  else
    drawAfterglowUnder(player, player.pos.x, player.pos.y, bound, shape)
    player:draw()
  end
  drawAfterglowMotes(player)
end

----------------------------------------------------------------------
-- Ooombas
----------------------------------------------------------------------
--
-- Ooombas go through too (see lua/entities/Ooomba.lua for their side:
-- falling once they're out, and landing on whatever they hit). One that
-- walks onto a floor portal drops in; one flying into any portal goes in.

-- How far an Ooomba's body reaches from its middle toward (dx, dy): a
-- box halfWidth across and halfHeight tall, standing along its `up`.
local function ooombaReach(o, dx, dy)
  local ux, uy = o.up.x, o.up.y
  return math.abs(dx * ux + dy * uy) * o.halfHeight + math.abs(dx * -uy + dy * ux) * o.halfWidth
end

-- walking: it's on a surface (a floor portal under its feet takes it in).
-- Returns true if it went in.
function PortalGun.tryEnterOoomba(o, walking)
  if o.portalTransit or o.isSquashing then return false end
  local portals = state.portals
  if not (portals and portals.red and portals.blue) then return false end
  for _, color in ipairs({ "red", "blue" }) do
    local from = portals[color]
    local tx, ty = tangentOf(from)
    local rx, ry = o.pos.x - from.x, o.pos.y - from.y
    local out = rx * from.nx + ry * from.ny
    local along = rx * tx + ry * ty
    local reach = ooombaReach(o, from.nx, from.ny)
    if math.abs(along) <= PORTAL_HALF_LENGTH and out <= reach + ENTER_REACH and out > -reach * 0.5 then
      local inward = -(o.vel.x * from.nx + o.vel.y * from.ny)
      local underFeet = walking and (o.up.x * from.nx + o.up.y * from.ny) > 0.7
      if inward > ENTER_MIN_INWARD_SPEED or underFeet then
        o.portalTransit = beginTrip(color, along, out, inward, o.vel.x * tx + o.vel.y * ty,
          Vector2.new(-o.up.x, -o.up.y), reach, o.halfHeight, o.lastInfluencePlanet)
        startAfterglow(o, o.portalTransit.to) -- glowing while it comes out the far side
        return true
      end
    end
  end
  return false
end

-- One frame of an Ooomba's trip. Returns true the frame it comes out.
function PortalGun.updateOoombaTrip(o, ts)
  local tr = o.portalTransit
  local x, y, through = advanceTrip(tr, ts, o.halfWidth * 0.8)
  o.pos = Vector2.new(x, y)
  if not through then return false end
  local vx, vy, down
  o.pos.x, o.pos.y, vx, vy, down = finishTrip(tr)
  o.vel = Vector2.new(vx, vy)
  o.up = Vector2.new(-down.x, -down.y)
  startAfterglow(o, tr.to) -- fades from here, now it's all the way out
  o.portalTransit = nil
  return true
end

function PortalGun.drawOoomba(o)
  local bound, shape = math.max(o.halfWidth, o.halfHeight) * 1.6, function() o:draw() end
  if o.portalTransit then
    drawSplit(o, o.portalTransit, bound, shape)
  else
    drawAfterglowUnder(o, o.pos.x, o.pos.y, bound, shape)
    o:draw()
  end
  drawAfterglowMotes(o)
end

-- The same surface tests the portal shots use, for landing Ooombas:
-- distance, nearest point and normal (see planetoidSurface/wallSurface).
PortalGun.surfaceOf = planetoidSurface
PortalGun.wallSurfaceOf = wallSurface


----------------------------------------------------------------------
-- Update / draw
----------------------------------------------------------------------

-- An afterglow: held at full while its thing is still on the way through
-- (see startAfterglow), counting down once it's out, and shedding motes
-- around its middle (cx, cy), within `spread`, the whole time — mid-trip
-- only off the part already out of the exit portal (`exitPortal`: none
-- spawn behind its surface). The motes it's already dropped drift and
-- fade on their own. Gone once both are done.
local function updateAfterglow(thing, cx, cy, spread, dt, exitPortal)
  local glow = thing.portalGlow
  if not glow then return end
  if thing.portalTransit then
    glow.timer = AFTERGLOW_SECONDS
  else
    glow.timer = glow.timer - dt
  end
  if glow.timer > 0 then
    glow.moteBudget = glow.moteBudget + AFTERGLOW_MOTES_PER_SECOND * (glow.timer / AFTERGLOW_SECONDS) * dt
    while glow.moteBudget >= 1 do
      glow.moteBudget = glow.moteBudget - 1
      local a, r = math.random() * math.pi * 2, math.sqrt(math.random()) * spread
      local x, y = cx + math.cos(a) * r, cy + math.sin(a) * r
      if not exitPortal or (x - exitPortal.x) * exitPortal.nx + (y - exitPortal.y) * exitPortal.ny > 0 then
        local da = math.random() * math.pi * 2
        local speed = AFTERGLOW_MOTE_SPEED_MIN + math.random() * AFTERGLOW_MOTE_SPEED_RANGE
        local life = AFTERGLOW_MOTE_LIFE_MIN + math.random() * AFTERGLOW_MOTE_LIFE_RANGE
        table.insert(glow.motes, {
          x = x, y = y,
          vx = math.cos(da) * speed, vy = math.sin(da) * speed,
          life = life, maxLife = life, size = 1.2 + math.random() * 1.6,
        })
      end
    end
  end
  for i = #glow.motes, 1, -1 do
    local m = glow.motes[i]
    m.life = m.life - dt
    if m.life <= 0 then
      table.remove(glow.motes, i)
    else
      m.x, m.y = m.x + m.vx * dt, m.y + m.vy * dt
    end
  end
  if glow.timer <= 0 and #glow.motes == 0 then thing.portalGlow = nil end
end

-- dt: real seconds (particles and the shimmer run in real time).
function PortalGun.update(dt)
  local player = state.player
  if player then
    easeUpright(player)
    -- His middle sits a bit above his collision circle (toward his helmet).
    local down = player:visualDownDirection(player.onSurface and player.currentPlanet or player.lastInfluencePlanet)
    local lift = ((player.headReach or player.radius) - player.radius) / 2
    local cx, cy = player.pos.x - down.x * lift, player.pos.y - down.y * lift
    -- Mid-trip, the copy of him coming out of the exit portal.
    local tr = player.portalTransit
    if tr then cx, cy = carryThrough(tr, cx, cy) end
    updateAfterglow(player, cx, cy, player.radius * 1.1, dt, tr and tr.to)
  end
  for _, o in ipairs(state.ooombas or {}) do
    local tr = o.portalTransit
    local cx, cy = o.pos.x, o.pos.y
    if tr then cx, cy = carryThrough(tr, cx, cy) end
    updateAfterglow(o, cx, cy, math.min(o.halfWidth, o.halfHeight), dt, tr and tr.to)
  end

  for color, portal in pairs(state.portals or {}) do
    if not isStillInWorld(portal) then
      state.portals[color] = nil
    else
      refreshWorldPlacement(portal)
      portal.age = portal.age + dt

      -- Motes drift off the mouth, each straight out from the surface
      -- where it starts (so they fan out from a curved one).
      portal.particleBudget = portal.particleBudget + PARTICLES_PER_SECOND * dt
      while portal.particleBudget >= 1 do
        portal.particleBudget = portal.particleBudget - 1
        local m = PortalGun.mouthAt(portal, 0.05 + math.random() * 0.9)
        local tx, ty = -m.ny, m.nx
        local speed = PARTICLE_SPEED_MIN + math.random() * PARTICLE_SPEED_RANGE
        local spread = (math.random() * 2 - 1) * 0.25
        local life = PARTICLE_LIFE_MIN + math.random() * PARTICLE_LIFE_RANGE
        table.insert(portal.particles, {
          -- Kept relative to the portal so they move with it.
          ox = m.x - portal.x + m.nx * PORTAL_SURFACE_OFFSET,
          oy = m.y - portal.y + m.ny * PORTAL_SURFACE_OFFSET,
          vx = (m.nx + tx * spread) * speed, vy = (m.ny + ty * spread) * speed,
          life = life, maxLife = life, size = 1.2 + math.random() * 1.8,
        })
      end

      -- Shafts of light: each fades in and out over its own life, then
      -- comes back somewhere else along the mouth, longer or shorter.
      for i = 1, SHAFT_COUNT do
        local sh = portal.shafts[i]
        if not sh or sh.life <= 0 then
          local life = SHAFT_LIFE_MIN + math.random() * SHAFT_LIFE_RANGE
          sh = {
            u = 0.08 + math.random() * 0.84, -- where along the mouth
            length = SHAFT_LENGTH_MIN + math.random() * SHAFT_LENGTH_RANGE,
            width = SHAFT_WIDTH_MIN + math.random() * SHAFT_WIDTH_RANGE,
            white = math.random() * 0.6,     -- how far from the portal's color toward white
            phase = math.random() * math.pi * 2, flicker = 6 + math.random() * 8,
            -- The first set starts partway through, so they don't all pulse together.
            life = sh and life or life * math.random(), maxLife = life,
          }
          portal.shafts[i] = sh
        end
        sh.life = sh.life - dt
      end
      for i = #portal.particles, 1, -1 do
        local p = portal.particles[i]
        p.life = p.life - dt
        if p.life <= 0 then
          table.remove(portal.particles, i)
        else
          p.ox, p.oy = p.ox + p.vx * dt, p.oy + p.vy * dt
        end
      end
    end
  end

  local tracers = state.portalTracers or {}
  for i = #tracers, 1, -1 do
    tracers[i].life = tracers[i].life - dt
    if tracers[i].life <= 0 then table.remove(tracers, i) end
  end
end

-- A point partway along the mouth (u: 0 at one end, 1 at the other),
-- with the surface's outward normal there.
function PortalGun.mouthAt(portal, u)
  local mouth = portal.mouth
  local f = math.max(0, math.min(1, u)) * (#mouth - 1)
  local i = math.min(#mouth - 1, math.floor(f))
  local a, b, t = mouth[i + 1], mouth[i + 2], f - i
  local nx, ny = a.nx + (b.nx - a.nx) * t, a.ny + (b.ny - a.ny) * t
  local len = math.sqrt(nx * nx + ny * ny)
  return { x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, nx = nx / len, ny = ny / len }
end

-- How bright the light is toward the mouth's ends (u: 0..1) — full in
-- the middle, easing off to nothing at either end.
local function endFade(u)
  local d = math.abs(u * 2 - 1)
  return 1 - d * d * d
end

-- Light rising off the mouth: a strip from the mouth out to `height`
-- along each point's normal, `alpha` at the mouth fading to nothing at
-- the top (and toward the ends) — one mesh per portal, reused.
local function drawCurtain(portal, key, height, r, g, b, alpha)
  local verts = {}
  local n = #portal.mouth
  for i, m in ipairs(portal.mouth) do
    local u = (i - 1) / (n - 1)
    local e = endFade(u)
    local h = height * (0.55 + 0.45 * e)
    local bx, by = m.x + m.nx * PORTAL_SURFACE_OFFSET, m.y + m.ny * PORTAL_SURFACE_OFFSET
    table.insert(verts, { bx, by, 0, 0, r, g, b, alpha * e })
    table.insert(verts, { bx + m.nx * h, by + m.ny * h, 0, 0, r, g, b, 0 })
  end
  portal[key] = portal[key] or love.graphics.newMesh(#verts, "strip", "stream")
  portal[key]:setVertices(verts)
  love.graphics.draw(portal[key])
end

-- How thick the mouth is partway along it (u: 0..1): full in the middle,
-- narrowing to a point at either end, like a lens — round through the
-- middle, sharpening toward the tips.
local function mouthTaper(u)
  local d = u * 2 - 1
  return (1 - d * d) ^ 0.75
end

-- One glowing band along the mouth, `width` thick at the middle and
-- tapering to nothing at the ends (see mouthTaper), centered just off the
-- surface and following its curve — one mesh per band, reused.
local function drawMouthBand(portal, key, width, r, g, b, alpha)
  local verts = {}
  local n = #portal.mouth
  for i, m in ipairs(portal.mouth) do
    local half = width / 2 * mouthTaper((i - 1) / (n - 1))
    local cx, cy = m.x + m.nx * PORTAL_SURFACE_OFFSET, m.y + m.ny * PORTAL_SURFACE_OFFSET
    table.insert(verts, { cx + m.nx * half, cy + m.ny * half, 0, 0, r, g, b, alpha })
    table.insert(verts, { cx - m.nx * half, cy - m.ny * half, 0, 0, r, g, b, alpha })
  end
  portal[key] = portal[key] or love.graphics.newMesh(#verts, "strip", "stream")
  portal[key]:setVertices(verts)
  love.graphics.draw(portal[key])
end

local function drawPortal(portal)
  local col = COLORS[portal.color]
  local shimmer = 0.85 + 0.15 * math.sin(portal.age * 5)
  local gr, gg, gb = col.glow[1], col.glow[2], col.glow[3]

  love.graphics.setBlendMode("add")
  love.graphics.setColor(1, 1, 1, 1)

  -- A tall soft curtain of the portal's color, then a short hot one
  -- close to the mouth.
  drawCurtain(portal, "curtainMesh", CURTAIN_HEIGHT, gr, gg, gb, 0.42 * shimmer)
  drawCurtain(portal, "coreMesh", CURTAIN_HEIGHT * 0.3, col.bright[1], col.bright[2], col.bright[3], 0.55 * shimmer)

  -- Shafts of light: each a narrowing ray, bright at the mouth, fading to
  -- nothing at its tip, flickering as it goes.
  local verts = {}
  for _, sh in ipairs(portal.shafts) do
    local m = PortalGun.mouthAt(portal, sh.u)
    local tx, ty = -m.ny, m.nx
    local lifeT = 1 - math.max(0, sh.life) / sh.maxLife
    local alpha = math.sin(lifeT * math.pi) * (0.7 + 0.3 * math.sin(portal.age * sh.flicker + sh.phase))
      * endFade(sh.u) * 0.55
    local r = gr + (1 - gr) * sh.white
    local g = gg + (1 - gg) * sh.white
    local b = gb + (1 - gb) * sh.white
    local bx, by = m.x + m.nx * PORTAL_SURFACE_OFFSET, m.y + m.ny * PORTAL_SURFACE_OFFSET
    local w0, w1 = sh.width / 2, sh.width * 0.2
    local ex, ey = bx + m.nx * sh.length, by + m.ny * sh.length
    local b1 = { bx - tx * w0, by - ty * w0, 0, 0, r, g, b, alpha }
    local b2 = { bx + tx * w0, by + ty * w0, 0, 0, r, g, b, alpha }
    local t1 = { ex - tx * w1, ey - ty * w1, 0, 0, r, g, b, 0 }
    local t2 = { ex + tx * w1, ey + ty * w1, 0, 0, r, g, b, 0 }
    for _, v in ipairs({ b1, b2, t2, b1, t2, t1 }) do table.insert(verts, v) end
  end
  if #verts > 0 then
    if not portal.shaftMesh or portal.shaftMeshSize ~= #verts then
      portal.shaftMesh, portal.shaftMeshSize = love.graphics.newMesh(#verts, "triangles", "stream"), #verts
    end
    portal.shaftMesh:setVertices(verts)
    love.graphics.draw(portal.shaftMesh)
  end

  -- The mouth itself: layered glowing bands along the surface (curved
  -- with it), the portal's color going to a white-hot core — each one
  -- thickest in the middle and tapering to a point at both ends.
  love.graphics.setColor(1, 1, 1, 1)
  drawMouthBand(portal, "band1", 24, gr, gg, gb, 0.10 * shimmer)
  drawMouthBand(portal, "band2", 14, gr, gg, gb, 0.20 * shimmer)
  drawMouthBand(portal, "band3", 8, gr, gg, gb, 0.60 * shimmer)
  drawMouthBand(portal, "band4", 3.5, 1, 1, 1, 0.95)

  -- Motes drifting away, white like the beams' and fading as they go.
  for _, p in ipairs(portal.particles) do
    local t = p.life / p.maxLife
    love.graphics.setColor(1, 1, 1, t * 0.85)
    love.graphics.circle("fill", portal.x + p.ox, portal.y + p.oy, p.size * (0.5 + t * 0.5))
    love.graphics.setColor(gr, gg, gb, t * 0.35)
    love.graphics.circle("fill", portal.x + p.ox, portal.y + p.oy, p.size * 2.2)
  end
  love.graphics.setBlendMode("alpha")
end

-- In world space (inside the camera transform).
function PortalGun.draw()
  for _, tr in ipairs(state.portalTracers or {}) do
    local col = COLORS[tr.color]
    local t = tr.life / TRACER_LIFE
    love.graphics.setBlendMode("add")
    love.graphics.setLineWidth(tr.missed and 2 or 3)
    love.graphics.setColor(col.glow[1], col.glow[2], col.glow[3], t * (tr.missed and 0.4 or 0.8))
    love.graphics.line(tr.x1, tr.y1, tr.x2, tr.y2)
    love.graphics.setLineWidth(1)
    love.graphics.setBlendMode("alpha")
  end
  for _, color in ipairs({ "red", "blue" }) do
    local portal = state.portals and state.portals[color]
    if portal then drawPortal(portal) end
  end
  love.graphics.setColor(1, 1, 1, 1)
end

return PortalGun
