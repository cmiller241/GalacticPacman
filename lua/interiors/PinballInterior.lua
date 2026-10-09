-- lua/interiors/PinballInterior.lua
--
-- Started as a port-flavored equivalent of
-- js/interiors/PlatformInterior.js's own EXTERIOR overlay half (the
-- "there's a level in here" art drawn on the planet from outside it,
-- see that file's own header comment) — but unlike MazeInterior/
-- PlatformInterior, this one never needed a separate walkable "you
-- stepped inside, here's a whole different scene" mode: the player
-- just curls into a ball (see :onEnter, triggered by main.lua's own
-- entry beam) and plays directly ON this same table, from the same
-- exterior camera/view everything else in the game already uses. So
-- this file is now BOTH the overlay art AND the actual pinball
-- gameplay — see the "Ball physics" section further down
-- (:onEnter/:updateBall/:triggerJumpAction/:exitBall).
--
-- The table shape (outer boundary + three obstacle walls) and every
-- bumper/flipper/plunger below were traced directly over the real
-- reference image (img/pinball.png) using pinball-editor.html and
-- pasted in verbatim — not hand-guessed. All of it is defined once as
-- NORMALIZED points in [-1, 1] (local to the planet, centered on it,
-- independent of its actual halfWidth/halfHeight) so resizing the
-- planet later just works — :draw() applies
-- love.graphics.scale(halfWidth, halfHeight) and draws these points
-- directly; collision/physics math instead converts them to real
-- WORLD-space points (see toWorldXY/toWorldPoly/toLocalXY) since a
-- circle test and velocity math need real distances, which that scale
-- would distort if it weren't uniform (see its own comment on why it
-- actually is, here).
--
-- :getPortalPosition() matches js/interiors/Interior.js's own API
-- contract, pointing at the plunger — both the "ball enters here" spot
-- the entry beam targets and where :exitBall sends him back out after
-- draining.
--
-- Assumes planetoid.isRoundedRect (see lua/world/RoundedRectPlanetoid.lua).

local Vector2 = require("lua.vector2")

local PinballInterior = {}
PinballInterior.__index = PinballInterior

local COLOR_TABLE = { 0.93, 0.95, 0.98, 0.88 } -- the reference image's WHITE (open/passable)
local COLOR_WALL = { 0.06, 0.06, 0.08, 1 }     -- the reference image's BLACK (solid)
local COLOR_BUMPER = { 0.95, 0.25, 0.30, 1 }
local COLOR_BUMPER_RING = { 1.00, 0.85, 0.30, 1 }
local COLOR_FLIPPER = { 0.10, 0.10, 0.92, 1 }
local COLOR_PLUNGER = { 0.55, 0.58, 0.65, 1 }

----------------------------------------------------------------------
-- Shape data — exported from pinball-editor.html. Normalized local
-- space, x/y in [-1, 1], origin at the planet's own center, +y down
-- (screen convention) — see that tool's own export comment.
----------------------------------------------------------------------

local OUTER_BOUNDARY = {
  { 0.899, 0.784 }, { 0.898, 0.679 }, { 0.896, 0.51 }, { 0.896, 0.316 },
  { 0.897, 0.101 }, { 0.898, -0.156 }, { 0.895, -0.342 }, { 0.896, -0.55 },
  { 0.895, -0.648 }, { 0.892, -0.664 }, { 0.886, -0.678 }, { 0.878, -0.692 },
  { 0.869, -0.708 }, { 0.862, -0.722 }, { 0.85, -0.736 }, { 0.839, -0.749 },
  { 0.827, -0.761 }, { 0.815, -0.771 }, { 0.8, -0.785 }, { 0.785, -0.796 },
  { 0.771, -0.806 }, { 0.754, -0.814 }, { 0.74, -0.822 }, { 0.719, -0.831 },
  { 0.697, -0.841 }, { 0.67, -0.852 }, { 0.645, -0.859 }, { 0.617, -0.867 },
  { 0.587, -0.876 }, { 0.555, -0.884 }, { 0.527, -0.891 }, { 0.5, -0.893 },
  { 0.479, -0.896 }, { 0.448, -0.898 }, { -0.464, -0.899 }, { -0.513, -0.895 },
  { -0.543, -0.894 }, { -0.571, -0.889 }, { -0.608, -0.885 }, { -0.649, -0.875 },
  { -0.688, -0.867 }, { -0.723, -0.853 }, { -0.759, -0.84 }, { -0.78, -0.828 },
  { -0.798, -0.817 }, { -0.815, -0.805 }, { -0.836, -0.791 }, { -0.852, -0.777 },
  { -0.864, -0.768 }, { -0.877, -0.754 }, { -0.895, -0.733 }, { -0.907, -0.711 },
  { -0.918, -0.694 }, { -0.926, -0.675 }, { -0.929, -0.646 }, { -0.928, -0.599 },
  { -0.922, -0.576 }, { -0.91, -0.545 }, { -0.896, -0.522 }, { -0.88, -0.496 },
  { -0.861, -0.467 }, { -0.84, -0.44 }, { -0.825, -0.416 }, { -0.803, -0.384 },
  { -0.778, -0.354 }, { -0.748, -0.312 }, { -0.748, 0.147 }, { -0.947, 0.249 },
  { -0.948, 0.563 }, { -0.184, 0.944 }, { -0.183, 1.013 }, { -0.04, 1.016 },
  { -0.04, 0.945 }, { 0.703, 0.574 }, { 0.702, 0.238 }, { 0.527, 0.145 },
  { 0.625, 0.094 }, { 0.623, -0.574 }, { 0.616, -0.592 }, { 0.611, -0.605 },
  { 0.605, -0.614 }, { 0.595, -0.625 }, { 0.588, -0.633 }, { 0.578, -0.642 },
  { 0.566, -0.65 }, { 0.552, -0.658 }, { 0.538, -0.664 }, { 0.522, -0.67 },
  { 0.504, -0.675 }, { 0.485, -0.678 }, { 0.466, -0.68 }, { 0.432, -0.681 },
  { 0.401, -0.679 }, { 0.38, -0.676 }, { 0.364, -0.672 }, { 0.344, -0.664 },
  { 0.331, -0.657 }, { 0.307, -0.643 }, { 0.291, -0.63 }, { 0.277, -0.616 },
  { 0.181, -0.617 }, { 0.181, -0.708 }, { 0.379, -0.808 }, { 0.426, -0.807 },
  { 0.455, -0.804 }, { 0.474, -0.802 }, { 0.49, -0.799 }, { 0.508, -0.795 },
  { 0.523, -0.79 }, { 0.537, -0.787 }, { 0.551, -0.782 }, { 0.568, -0.776 },
  { 0.584, -0.769 }, { 0.6, -0.761 }, { 0.619, -0.751 }, { 0.638, -0.74 },
  { 0.658, -0.725 }, { 0.669, -0.716 }, { 0.685, -0.704 }, { 0.698, -0.692 },
  { 0.711, -0.679 }, { 0.722, -0.665 }, { 0.733, -0.65 }, { 0.739, -0.641 },
  { 0.744, -0.631 }, { 0.749, -0.618 }, { 0.754, -0.605 }, { 0.756, -0.593 },
  { 0.756, 0.784 },
}

local OBSTACLE_1 = {
  { -0.567, -0.52 }, { -0.377, -0.617 }, { -0.377, -0.709 }, { -0.559, -0.799 },
  { -0.608, -0.788 }, { -0.647, -0.774 }, { -0.676, -0.759 }, { -0.7, -0.743 },
  { -0.724, -0.721 }, { -0.743, -0.698 }, { -0.76, -0.674 }, { -0.769, -0.648 },
  { -0.774, -0.618 }, { -0.774, -0.592 }, { -0.766, -0.566 }, { -0.752, -0.537 },
  { -0.732, -0.507 }, { -0.711, -0.48 }, { -0.687, -0.456 }, { -0.654, -0.427 },
  { -0.598, -0.426 }, { -0.567, -0.456 },
}

local OBSTACLE_2 = {
  { 0.51, 0.29 }, { 0.539, 0.289 }, { 0.539, 0.459 },
  { 0.329, 0.564 }, { 0.313, 0.55 }, { 0.509, 0.452 },
}

local OBSTACLE_3 = {
  { -0.573, 0.564 }, { -0.56, 0.551 }, { -0.753, 0.45 },
  { -0.754, 0.291 }, { -0.783, 0.29 }, { -0.784, 0.459 },
}

-- radius normalized against the image's own half-WIDTH (see
-- pinball-editor.html's own export comment).
local BUMPERS = {
  { x = -0.403, y = -0.244, radius = 0.1 },
  { x = -0.091, y = -0.41, radius = 0.1 },
  { x = 0.282, y = -0.239, radius = 0.1 },
}

-- angle/length describe each flipper's REST position (as placed in the
-- editor), length normalized against the image's own half-WIDTH.
-- mirrored is purely cosmetic bookkeeping from the editor (left/right
-- sprite-flip intent) and isn't read here. swingDir is this file's own
-- addition: +1 or -1, which way (in degrees) the flipper's angle moves
-- when FIRED (see :triggerFlippers/:updateFlippers) — worked out by
-- hand from each flipper's own rest angle and which side of the table
-- its pivot sits on (left flipper's tip swings UP by decreasing its
-- angle; right flipper's by increasing it — mirror images of each
-- other, same as real pinball flippers).
local FLIPPERS = {
  { x = -0.534, y = 0.555, angle = 5.2, length = 0.277, mirrored = false, swingDir = -1 },
  { x = 0.327, y = 0.553, angle = 173.3, length = 0.311, mirrored = false, swingDir = 1 },
}

local PLUNGERS = {
  { x = 0.83, y = 0.78, angle = -89.7, length = 0.245 },
}

----------------------------------------------------------------------
-- Polygon math — generic, not specific to this table's own shape.
----------------------------------------------------------------------

local function flatten(poly)
  local flat = {}
  for _, pt in ipairs(poly) do
    table.insert(flat, pt[1])
    table.insert(flat, pt[2])
  end
  return flat
end

local function signedArea(poly)
  local area = 0
  local n = #poly
  for i = 1, n do
    local a = poly[i]
    local b = poly[(i % n) + 1]
    area = area + (a[1] * b[2] - b[1] * a[2])
  end
  return area / 2
end

-- Fills a possibly-concave, possibly-thin-necked simple polygon
-- robustly via a stencil-based nonzero-winding fan fill, instead of
-- love.graphics.polygon's own built-in ear-clipping triangulation.
-- OUTER_BOUNDARY has a genuinely thin (~0.08-0.18 normalized units
-- wide) channel carved into it for the plunger lane — too narrow for
-- ear-clipping to triangulate cleanly, which is what produced the
-- garbled/spiky fill there (and an EARLIER attempt at this same
-- stencil idea, using the "invert" stencil action, broke the fill
-- completely — its exact value/bitmask behavior wasn't something to
-- guess at twice, so this version avoids it entirely in favor of only
-- "increment"/"decrement", whose clamped behavior is unambiguous).
--
-- Technique: fan out from the polygon's own first vertex to every
-- edge. Each fan triangle is trivially convex on its own — no
-- triangulation of the WHOLE shape is ever needed — and any triangles
-- that double back over already-covered area (inevitable when fanning
-- a concave shape from one corner) are resolved via the standard
-- nonzero winding rule: CCW triangles increment the stencil buffer,
-- CW triangles decrement it, and any pixel left nonzero afterward was
-- "inside" an odd-signed number of net windings — exactly the
-- polygon's own true interior, for any simple (non-self-intersecting)
-- polygon, regardless of how thin or concave it is.
--
-- The stencil buffer can't hold negative values (decrement clamps at
-- 0), so this only stays correct if every interior pixel's TRUE net
-- winding is POSITIVE — which requires the polygon to be wound
-- consistently CCW. signedArea below checks that and reverses the
-- point order first if it's actually CW, so the increment pass always
-- has already built up enough headroom before the decrement pass runs.
local function fillPolygonEvenOdd(poly, color)
  if #poly < 3 then return end

  local ordered = poly
  if signedArea(poly) < 0 then
    ordered = {}
    for i = #poly, 1, -1 do table.insert(ordered, poly[i]) end
  end
  local ax, ay = ordered[1][1], ordered[1][2]

  love.graphics.stencil(function()
    for i = 2, #ordered - 1 do
      local bx, by = ordered[i][1], ordered[i][2]
      local cx, cy = ordered[i + 1][1], ordered[i + 1][2]
      local cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
      if cross > 0 then
        love.graphics.polygon("fill", ax, ay, bx, by, cx, cy)
      end
    end
  end, "increment", 1, false)

  love.graphics.stencil(function()
    for i = 2, #ordered - 1 do
      local bx, by = ordered[i][1], ordered[i][2]
      local cx, cy = ordered[i + 1][1], ordered[i + 1][2]
      local cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
      if cross < 0 then
        love.graphics.polygon("fill", ax, ay, bx, by, cx, cy)
      end
    end
  end, "decrement", 1, true)

  love.graphics.setStencilTest("notequal", 0)
  love.graphics.setColor(color)
  love.graphics.rectangle("fill", -1.5, -1.5, 3, 3)
  love.graphics.setStencilTest()
end

-- Standard ray-casting point-in-polygon test.
local function pointInPolygon(poly, px, py)
  local inside = false
  local n = #poly
  local j = n
  for i = 1, n do
    local xi, yi = poly[i][1], poly[i][2]
    local xj, yj = poly[j][1], poly[j][2]
    if ((yi > py) ~= (yj > py)) and
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi) then
      inside = not inside
    end
    j = i
  end
  return inside
end

-- Closest point on the polygon's own boundary to (px, py), the
-- distance to it, and that edge's OUTWARD normal.
--
-- "Outward" used to be picked per-edge by testing which of an edge's
-- two perpendiculars points away from the polygon's own CENTROID — but
-- that centroid was just a plain average of all the vertices, not a
-- true area centroid, and for a highly concave shape like
-- OUTER_BOUNDARY (the thin plunger-lane channel, the notches) that
-- average can land on the WRONG side of an edge deep in a concave
-- region. The normal there came out backwards, and a ball bounced
-- the WRONG way instead of being pushed back out — exactly "goes
-- straight through the wall" from the player's side, and nothing to
-- do with speed/substep size at all.
--
-- Fixed by using the polygon's own OVERALL winding (signedArea, the
-- same thing fillPolygonEvenOdd already normalizes against) instead: a
-- single, globally-consistent "rotate the edge direction 90°" rule is
-- correct for every edge of ANY simple polygon — convex or concave —
-- once you know which way it winds, with no per-edge guessing needed.
-- (Verified by hand against a plain CW-on-screen square: edge dir
-- (1,0) with POSITIVE signedArea needs normal (0,-1) — i.e.
-- (dy,-dx)*sign(area) — not the other perpendicular.)
local function closestPointOnPolygon(poly, px, py)
  local orientSign = signedArea(poly) >= 0 and 1 or -1
  local bestDist, bestX, bestY, bestNX, bestNY = math.huge, 0, 0, 0, -1
  local n = #poly
  for i = 1, n do
    local a = poly[i]
    local b = poly[(i % n) + 1]
    local abx, aby = b[1] - a[1], b[2] - a[2]
    local len2 = abx * abx + aby * aby
    local t = 0
    if len2 > 1e-9 then
      t = ((px - a[1]) * abx + (py - a[2]) * aby) / len2
      t = math.max(0, math.min(1, t))
    end
    local ex, ey = a[1] + abx * t, a[2] + aby * t
    local dx, dy = px - ex, py - ey
    local dist = math.sqrt(dx * dx + dy * dy)
    if dist < bestDist then
      local len = math.sqrt(len2)
      local nx, ny = 0, -1
      if len > 1e-9 then
        nx, ny = (aby / len) * orientSign, (-abx / len) * orientSign
      end
      bestDist, bestX, bestY, bestNX, bestNY = dist, ex, ey, nx, ny
    end
  end
  return bestX, bestY, bestDist, bestNX, bestNY
end

-- Converts a NORMALIZED local point/polygon to real world-space —
-- scale by halfWidth/halfHeight, THEN rotate/translate, same order as
-- every other rotating rounded-rect body in this codebase (see
-- Mirror.lua/PullBeam.lua's own local-to-world math). Written as plain
-- numbers in/out (not Vector2/table-of-tables) so it works for both a
-- single point and a whole polygon via the callers below.
local function toWorldXY(p, lx, ly)
  local angle = p.rotationAngle or 0
  local cosA, sinA = math.cos(angle), math.sin(angle)
  local wx, wy = lx * p.halfWidth, ly * p.halfHeight
  return p.pos.x + wx * cosA - wy * sinA, p.pos.y + wx * sinA + wy * cosA
end

local function toWorldPoly(poly, p)
  local world = {}
  for _, pt in ipairs(poly) do
    local wx, wy = toWorldXY(p, pt[1], pt[2])
    table.insert(world, { wx, wy })
  end
  return world
end

-- Inverse of toWorldXY: a real world point -> normalized local
-- coordinates. Used by :updateBall to find the ball's own position in
-- the table's own [-1,1] space (e.g. to detect the drain — see
-- DRAIN_LOCAL_* below).
local function toLocalXY(p, wx, wy)
  local angle = p.rotationAngle or 0
  local cosA, sinA = math.cos(angle), math.sin(angle)
  local dx, dy = wx - p.pos.x, wy - p.pos.y
  local lx = dx * cosA + dy * sinA
  local ly = -dx * sinA + dy * cosA
  return lx / p.halfWidth, ly / p.halfHeight
end

----------------------------------------------------------------------
-- Ball physics — gravity, wall/obstacle/bumper/flipper bounce, the
-- plunger launch, and the drain. Nothing here runs unless
-- Player.inPinball is set (see main.lua's own pinball-beam setup and
-- :onEnter below) — normal gameplay never touches any of it.
----------------------------------------------------------------------

local GRAVITY_ACCEL = 0.25        -- world units/tick^2, "down the table" (local +y)
local MAX_BALL_SPEED = 20         -- world units/tick — clamps bounce/kick stacking from runaway
local WALL_RESTITUTION = 0.55     -- how much speed survives bouncing off the boundary/an obstacle
local BUMPER_KICK_SPEED = 20      -- fixed outward "pop" speed on bumper contact, regardless of incoming speed
local FLIPPER_COLLISION_HALF_WIDTH = 0.045 -- normalized — how thick the flipper's own collision capsule is
local FLIPPER_SWING_DEGREES = 55
local FLIPPER_SWING_UP_TICKS = 6    -- ~0.1s @60fps
local FLIPPER_SWING_HOLD_TICKS = 10 -- ~0.17s
local FLIPPER_SWING_DOWN_TICKS = 14 -- ~0.23s easing back to rest
local FLIPPER_HIT_SPEED = 26        -- kick imparted to the ball if struck WHILE actively swinging up/holding
local PLUNGER_LAUNCH_SPEED = 30
-- OUTER_BOUNDARY's own authored shape has no actual gap at the bottom
-- (it closes to a single point between the flippers), so the drain is
-- carved out procedurally instead of being real geometry: within this
-- band — centered under the flippers, below DRAIN_LOCAL_Y — the outer
-- boundary simply stops holding the ball in at all.
local DRAIN_LOCAL_HALF_WIDTH = 0.22
local DRAIN_LOCAL_Y = 0.80
local DRAIN_EXIT_LOCAL_Y = 1.05 -- past this, he's considered fully drained — see :exitBall

-- Pushes the ball out of worldPoly and reflects its velocity, treating
-- the polygon either as a CONTAINER (asContainer = true: the ball must
-- stay INSIDE — used for the outer boundary) or as SOLID (asContainer
-- = false: the ball must stay OUTSIDE — used for an obstacle wall).
-- closestPointOnPolygon's own normal always points OUTWARD (away from
-- the polygon's interior) regardless of which case this is, so the two
-- branches below differ only in which side of that normal counts as
-- "the ball is in trouble" and which way the reflected velocity goes.
local function bouncePlayerOffPolygon(worldPoly, player, restitution, asContainer)
  local x, y, r = player.pos.x, player.pos.y, player.radius
  local ex, ey, dist, nx, ny = closestPointOnPolygon(worldPoly, x, y)
  local inside = pointInPolygon(worldPoly, x, y)

  if asContainer then
    if not inside then
      player.pos.x, player.pos.y = ex - nx * r, ey - ny * r
    elseif dist < r then
      player.pos.x = player.pos.x - nx * (r - dist)
      player.pos.y = player.pos.y - ny * (r - dist)
    else
      return
    end
    local into = player.vel.x * nx + player.vel.y * ny
    if into > 0 then
      player.vel.x = player.vel.x - (1 + restitution) * into * nx
      player.vel.y = player.vel.y - (1 + restitution) * into * ny
    end
  else
    if not (inside or dist < r) then return end
    player.pos.x, player.pos.y = ex + nx * r, ey + ny * r
    local into = player.vel.x * nx + player.vel.y * ny
    if into < 0 then
      player.vel.x = player.vel.x - (1 + restitution) * into * nx
      player.vel.y = player.vel.y - (1 + restitution) * into * ny
    end
  end
end

-- Bumpers always give a fixed "pop" kick rather than a plain
-- reflection — same as a real pop bumper, which adds energy rather
-- than just redirecting whatever the ball already had.
local function bouncePlayerOffBumper(b, p, player)
  local bx, by = toWorldXY(p, b.x, b.y)
  local dx, dy = player.pos.x - bx, player.pos.y - by
  local dist = math.sqrt(dx * dx + dy * dy)
  local minDist = (b.radius * p.halfWidth) + player.radius
  if dist >= minDist then return end
  local nx, ny
  if dist > 1e-4 then nx, ny = dx / dist, dy / dist else nx, ny = 0, -1 end
  player.pos.x, player.pos.y = bx + nx * minDist, by + ny * minDist
  player.vel.x, player.vel.y = nx * BUMPER_KICK_SPEED, ny * BUMPER_KICK_SPEED
end

-- The flipper's own CURRENT world-space pivot/tip segment — reads
-- f.currentAngle (set every frame by :updateFlippers) rather than its
-- authored rest angle, so this tracks the live swinging paddle, not
-- just its resting pose.
local function flipperWorldSegment(f, p)
  local ax, ay = toWorldXY(p, f.x, f.y)
  local rad = math.rad(f.currentAngle or f.angle)
  local tlx = f.x + math.cos(rad) * f.length
  local tly = f.y + math.sin(rad) * f.length
  local bx, by = toWorldXY(p, tlx, tly)
  return ax, ay, bx, by
end

-- Ordinary passive bounce when idle, a strong directed kick (same
-- "pop" feel as a bumper) when actively firing — f.swinging is true
-- only during the rising/held part of the swing (see
-- :updateFlippers), not the ease-back-down tail, so a ball resting on
-- a flipper that's already retracting just gets an ordinary bounce.
local function bouncePlayerOffFlipper(f, p, player)
  local ax, ay, bx, by = flipperWorldSegment(f, p)
  local abx, aby = bx - ax, by - ay
  local len2 = abx * abx + aby * aby
  local t = 0
  if len2 > 1e-9 then
    t = ((player.pos.x - ax) * abx + (player.pos.y - ay) * aby) / len2
    t = math.max(0, math.min(1, t))
  end
  local ex, ey = ax + abx * t, ay + aby * t
  local dx, dy = player.pos.x - ex, player.pos.y - ey
  local dist = math.sqrt(dx * dx + dy * dy)
  local collisionRadius = (FLIPPER_COLLISION_HALF_WIDTH * p.halfWidth) + player.radius
  if dist >= collisionRadius then return end

  local nx, ny
  if dist > 1e-4 then nx, ny = dx / dist, dy / dist else nx, ny = 0, -1 end
  player.pos.x, player.pos.y = ex + nx * collisionRadius, ey + ny * collisionRadius

  if f.swinging then
    player.vel.x, player.vel.y = nx * FLIPPER_HIT_SPEED, ny * FLIPPER_HIT_SPEED
  else
    local into = player.vel.x * nx + player.vel.y * ny
    if into < 0 then
      player.vel.x = player.vel.x - (1 + WALL_RESTITUTION) * into * nx
      player.vel.y = player.vel.y - (1 + WALL_RESTITUTION) * into * ny
    end
  end
end

----------------------------------------------------------------------
-- Drawing helpers for bumpers/flippers/plungers — plain filled shapes,
-- no stroked outlines: a love.graphics.setLineWidth here would be
-- interpreted in LOCAL (pre-scale) units same as everything else drawn
-- inside :draw's own scale(halfWidth, halfHeight) block, which — at
-- this planet's actual size — would render many hundreds of pixels
-- thick. Filled shapes have no such problem.
----------------------------------------------------------------------

local BUMPER_RING_FRACTION = 0.55 -- inner ring radius, as a fraction of the bumper's own radius

local function drawBumper(b)
  love.graphics.setColor(COLOR_BUMPER)
  love.graphics.circle("fill", b.x, b.y, b.radius)
  love.graphics.setColor(COLOR_BUMPER_RING)
  love.graphics.circle("fill", b.x, b.y, b.radius * BUMPER_RING_FRACTION)
end

local FLIPPER_WIDTH_PIVOT = 0.055
local FLIPPER_WIDTH_TIP = 0.022
local PLUNGER_WIDTH = 0.035

-- Builds a tapered paddle polygon (pivot -> tip), as a flat
-- {x1,y1,x2,y2,...} list ready for love.graphics.polygon — wide at the
-- pivot end, narrow at the tip, the same general silhouette a real
-- pinball flipper has. widthTip == widthPivot instead gives a plain
-- uniform rod (used for plungers, below).
local function paddlePoints(x, y, angleDeg, length, widthPivot, widthTip)
  local rad = math.rad(angleDeg)
  local dx, dy = math.cos(rad), math.sin(rad)
  local nx, ny = -dy, dx
  local tipX, tipY = x + dx * length, y + dy * length
  return {
    x + nx * widthPivot / 2, y + ny * widthPivot / 2,
    tipX + nx * widthTip / 2, tipY + ny * widthTip / 2,
    tipX - nx * widthTip / 2, tipY - ny * widthTip / 2,
    x - nx * widthPivot / 2, y - ny * widthPivot / 2,
  }
end

local function drawFlipper(f)
  love.graphics.setColor(COLOR_FLIPPER)
  love.graphics.polygon("fill", paddlePoints(f.x, f.y, f.currentAngle or f.angle, f.length, FLIPPER_WIDTH_PIVOT, FLIPPER_WIDTH_TIP))
end

local function drawPlunger(pl)
  love.graphics.setColor(COLOR_PLUNGER)
  love.graphics.polygon("fill", paddlePoints(pl.x, pl.y, pl.angle, pl.length, PLUNGER_WIDTH, PLUNGER_WIDTH))
end

----------------------------------------------------------------------

function PinballInterior.new(planetoid)
  local self = setmetatable({}, PinballInterior)
  self.planetoid = planetoid
  self.obstacles = { OBSTACLE_1, OBSTACLE_2, OBSTACLE_3 }
  return self
end

function PinballInterior:getPortalPosition()
  local pl = PLUNGERS[1]
  local lx, ly = pl and pl.x or 0, pl and pl.y or 0.9
  local wx, wy = toWorldXY(self.planetoid, lx, ly)
  return Vector2.new(wx, wy)
end

-- Keeps a circle (worldX, worldY, radius) inside the outer boundary,
-- outside every obstacle wall, and outside every bumper — returning
-- the (possibly adjusted) world position. A plain reposition-only
-- utility (no velocity/bounce) — :updateBall below is what the actual
-- player-ball uses instead, since a real pinball needs bounce/kick,
-- not just "don't overlap."
function PinballInterior:resolveCircleCollision(worldX, worldY, radius)
  local p = self.planetoid
  local x, y = worldX, worldY

  local outer = toWorldPoly(OUTER_BOUNDARY, p)
  local ex, ey, dist, nx, ny = closestPointOnPolygon(outer, x, y)
  if not pointInPolygon(outer, x, y) then
    -- nx/ny point OUTWARD (away from the boundary's own interior) —
    -- subtracting pulls the circle back INSIDE, to rest exactly
    -- `radius` away from the edge it crossed.
    x, y = ex - nx * radius, ey - ny * radius
  elseif dist < radius then
    x, y = x - nx * (radius - dist), y - ny * (radius - dist)
  end

  for _, localPoly in ipairs(self.obstacles) do
    local worldPoly = toWorldPoly(localPoly, p)
    local ox, oy, odist, onx, ony = closestPointOnPolygon(worldPoly, x, y)
    if pointInPolygon(worldPoly, x, y) or odist < radius then
      x, y = ox + onx * radius, oy + ony * radius
    end
  end

  for _, b in ipairs(BUMPERS) do
    local bx, by = toWorldXY(p, b.x, b.y)
    local dx, dy = x - bx, y - by
    local bdist = math.sqrt(dx * dx + dy * dy)
    -- b.radius scales uniformly in world space here: PinballPlanet's
    -- own halfWidth:halfHeight ratio is kept matching the reference
    -- image's own aspect ratio (see main.lua's own PinballPlanet
    -- setup), so world distances scale the same in both axes even
    -- though :draw's own scale(halfWidth, halfHeight) call is
    -- technically non-uniform.
    local minDist = (b.radius * p.halfWidth) + radius
    if bdist < minDist then
      if bdist > 1e-4 then
        x, y = bx + (dx / bdist) * minDist, by + (dy / bdist) * minDist
      else
        x, y = bx + minDist, by
      end
    end
  end

  return x, y
end

-- Drops player into the table, already a ball, resting exactly at the
-- plunger — called from the pinball planet's own entry beam (see
-- main.lua's own setup, via Player:updateTeleport's destination.onArrive
-- hook). Resets per-session state (which flipper/plunger state
-- survives a previous visit) so each entry starts clean.
function PinballInterior:onEnter(player)
  player:forceBallMode()
  player.inPinball = self
  player.vel.x, player.vel.y = 0, 0
  local portal = self:getPortalPosition()
  player.pos.x, player.pos.y = portal.x, portal.y
  player.prevPos = player.pos:clone()
  self.ballLaunched = false
  for _, f in ipairs(FLIPPERS) do
    f.currentAngle = f.angle
    f.swingTimer = nil
    f.swinging = false
  end
end

-- Falling into the drain (see DRAIN_LOCAL_* above) ends the session:
-- hands control back to the ordinary gravity/collision systems (by
-- clearing player.inPinball — see main.lua's own update loop) and pops
-- him back out at the plunger, un-morphed. Same spot he came in at —
-- simplest "where do you end up after draining" answer, short of a
-- dedicated exit position nothing has asked for yet.
function PinballInterior:exitBall(player)
  player.inPinball = nil
  player.vel.x, player.vel.y = 0, 0
  if player.isBall then
    player:exitBallMode()
  end
  local portal = self:getPortalPosition()
  player.pos.x, player.pos.y = portal.x, portal.y
  player.prevPos = player.pos:clone()
end

-- Advances each flipper's own currentAngle through a simple triangle-
-- wave swing (rise -> brief hold -> ease back to rest) once triggered
-- (see :triggerFlippers) — f.swinging is true for the rise+hold
-- portion only, which :updateBall's own bouncePlayerOffFlipper reads
-- to decide "actively firing" (a strong kick) vs. "idle/retracting"
-- (a plain passive bounce).
function PinballInterior:updateFlippers(ts)
  for _, f in ipairs(FLIPPERS) do
    if f.swingTimer then
      f.swingTimer = f.swingTimer + ts
      local t = f.swingTimer
      local upT, holdT, downT = FLIPPER_SWING_UP_TICKS, FLIPPER_SWING_HOLD_TICKS, FLIPPER_SWING_DOWN_TICKS
      local amt
      if t < upT then
        amt = t / upT
        f.swinging = true
      elseif t < upT + holdT then
        amt = 1
        f.swinging = true
      elseif t < upT + holdT + downT then
        amt = 1 - (t - upT - holdT) / downT
        f.swinging = false
      else
        amt = 0
        f.swinging = false
        f.swingTimer = nil
      end
      f.currentAngle = f.angle + f.swingDir * FLIPPER_SWING_DEGREES * amt
    else
      f.currentAngle = f.angle
      f.swinging = false
    end
  end
end

-- Fires both flippers at once — a single-button simplification (one
-- press flips both paddles together) rather than independent left/
-- right control, per explicit request to keep this approachable.
function PinballInterior:triggerFlippers()
  for _, f in ipairs(FLIPPERS) do
    f.swingTimer = f.swingTimer or 0
  end
end

-- Launches the ball up the lane in the plunger's own authored facing
-- direction (pl.angle — the direction the editor's rotation handle was
-- actually dragged to, which already points "up the lane" since
-- that's where a plunger would push the ball) — converted from local
-- direction to world the same way every other local->world conversion
-- in this file is (direction only, not a point, so no translation).
function PinballInterior:launchPlunger(player)
  local pl = PLUNGERS[1]
  if not pl then return end
  local p = self.planetoid
  local originX, originY = toWorldXY(p, pl.x, pl.y)
  local rad = math.rad(pl.angle)
  local tipX, tipY = toWorldXY(p, pl.x + math.cos(rad), pl.y + math.sin(rad))
  local dx, dy = tipX - originX, tipY - originY
  local len = math.sqrt(dx * dx + dy * dy)
  if len > 1e-6 then dx, dy = dx / len, dy / len end
  player.vel.x, player.vel.y = dx * PLUNGER_LAUNCH_SPEED, dy * PLUNGER_LAUNCH_SPEED
end

-- The pinball planet's own jump-button handler (see InputHandlers.lua/
-- GamePadInput.lua, routed here instead of an ordinary jump/ground-
-- pound whenever Player.inPinball is set): springs the plunger while
-- the ball hasn't been launched yet this visit, otherwise fires the
-- flippers — one button, contextual, same simplification
-- :triggerFlippers' own comment explains.
function PinballInterior:triggerJumpAction(player)
  if not self.ballLaunched then
    self:launchPlunger(player)
    self.ballLaunched = true
  else
    self:triggerFlippers()
  end
end

-- How far the ball is allowed to travel in a single collision check —
-- kept comfortably smaller than the thinnest thing it can hit (a
-- flipper/bumper's own collision width, ~20-45 world units at this
-- planet's current size). Without this, a single frame's full-speed
-- move (up to MAX_BALL_SPEED units) could land past a thin collider
-- entirely before :updateBall ever checks against it — the classic
-- "fast object tunnels through a thin wall" bug a plain discrete
-- (non-swept) collision check always has at high enough speed. Fixed
-- here by taking several smaller hops per frame instead of one big
-- one, with a full collision pass after each. Tightened from an
-- original 10 — cheap to do (still well under a hundred extra edge
-- checks a frame for a single ball) and removes any remaining doubt
-- once the real bug (closestPointOnPolygon's old centroid-based
-- normal, see its own comment) is what was actually causing most of
-- the "goes straight through" reports.
local BALL_SUBSTEP_DISTANCE = 4

-- If the ball ever ends up this far outside the table's own [-1,1]
-- local space, in ANY direction — not just past the real drain — reset
-- it back to the plunger rather than leaving it stuck or lost
-- somewhere nonsensical. Deliberately generous/separate from the
-- intentional drain (DRAIN_EXIT_LOCAL_Y below, the narrow gap under
-- the flippers): this is a safety net for falling/punching through
-- OTHER geometry (a bug, not the intended drain), per explicit request
-- to make broken collision easy to recover from while testing.
local RESET_LOCAL_MARGIN = 1.3

-- The player-ball's own full per-frame physics while Player.inPinball
-- is set (see main.lua's own update loop, which calls this INSTEAD OF
-- normal gravity/planet-collision entirely): gravity down the table,
-- then — in however many smaller substeps this frame's own speed
-- needs (see BALL_SUBSTEP_DISTANCE) — the drain/reset check and a
-- bounce pass against the boundary/obstacles/bumpers/flippers.
function PinballInterior:updateBall(player, ts)
  local p = self.planetoid

  -- "Down the table," in world space — the table's own local +y
  -- direction, rotated the same way every local DIRECTION (not point)
  -- converts to world elsewhere in this file.
  local angle = p.rotationAngle or 0
  local gx, gy = -math.sin(angle), math.cos(angle)
  player.vel.x = player.vel.x + gx * GRAVITY_ACCEL * ts
  player.vel.y = player.vel.y + gy * GRAVITY_ACCEL * ts

  local speed = math.sqrt(player.vel.x * player.vel.x + player.vel.y * player.vel.y)
  if speed > MAX_BALL_SPEED then
    local scale = MAX_BALL_SPEED / speed
    player.vel.x, player.vel.y = player.vel.x * scale, player.vel.y * scale
    speed = MAX_BALL_SPEED
  end

  self:updateFlippers(ts)

  -- Computed ONCE per frame, not per substep — the table itself is
  -- immovable (fixed rotationAngle), so these don't change mid-frame;
  -- recomputing a 130-point polygon several times a frame for nothing
  -- would be pure waste.
  local outerWorld = toWorldPoly(OUTER_BOUNDARY, p)
  local obstacleWorlds = {}
  for i, obstacle in ipairs(self.obstacles) do
    obstacleWorlds[i] = toWorldPoly(obstacle, p)
  end

  local moveDist = speed * ts
  local steps = math.max(1, math.ceil(moveDist / BALL_SUBSTEP_DISTANCE))
  local stepTs = ts / steps

  for _ = 1, steps do
    player.pos.x = player.pos.x + player.vel.x * stepTs
    player.pos.y = player.pos.y + player.vel.y * stepTs

    local lx, ly = toLocalXY(p, player.pos.x, player.pos.y)
    if ly > DRAIN_EXIT_LOCAL_Y or math.abs(lx) > RESET_LOCAL_MARGIN or math.abs(ly) > RESET_LOCAL_MARGIN then
      self:exitBall(player)
      return
    end
    local inDrainGap = math.abs(lx) < DRAIN_LOCAL_HALF_WIDTH and ly > DRAIN_LOCAL_Y

    if not inDrainGap then
      bouncePlayerOffPolygon(outerWorld, player, WALL_RESTITUTION, true)
    end

    for _, worldPoly in ipairs(obstacleWorlds) do
      bouncePlayerOffPolygon(worldPoly, player, WALL_RESTITUTION, false)
    end

    for _, b in ipairs(BUMPERS) do
      bouncePlayerOffBumper(b, p, player)
    end

    for _, f in ipairs(FLIPPERS) do
      bouncePlayerOffFlipper(f, p, player)
    end
  end
end

-- Call from inside the same camera-transformed push() block every
-- other world object draws from. Wall fills go through
-- fillPolygonEvenOdd (see its own comment) rather than a plain
-- love.graphics.polygon("fill", ...) — the outer boundary's own
-- plunger-lane channel is too thin for ear-clipping triangulation to
-- handle cleanly.
function PinballInterior:draw()
  local p = self.planetoid

  love.graphics.push()
  love.graphics.translate(p.pos.x, p.pos.y)
  love.graphics.rotate(p.rotationAngle or 0)
  love.graphics.scale(p.halfWidth, p.halfHeight)

  fillPolygonEvenOdd(OUTER_BOUNDARY, COLOR_TABLE)

  for _, obstacle in ipairs(self.obstacles) do
    fillPolygonEvenOdd(obstacle, COLOR_WALL)
  end

  for _, b in ipairs(BUMPERS) do drawBumper(b) end
  for _, pl in ipairs(PLUNGERS) do drawPlunger(pl) end
  for _, f in ipairs(FLIPPERS) do drawFlipper(f) end

  love.graphics.pop()
  love.graphics.setColor(1, 1, 1, 1)
end

return PinballInterior
