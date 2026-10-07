-- lua/interiors/PinballInterior.lua
--
-- Port-flavored equivalent of js/interiors/PlatformInterior.js's own
-- EXTERIOR overlay half (not the walkable interior-mode scene itself
-- -- that file's own header comment draws the same distinction: this
-- is the "there's a level in here" art drawn on the planet from
-- OUTSIDE it, while just flying past, not what renders once/if the
-- player actually goes in).
--
-- The table shape (outer boundary + three obstacle walls) and every
-- bumper/flipper/plunger below were traced directly over the real
-- reference image (img/pinball.png) using pinball-editor.html and
-- pasted in verbatim — not hand-guessed this time. All of it is
-- defined once as NORMALIZED points in [-1, 1] (local to the planet,
-- centered on it, independent of its actual halfWidth/halfHeight) so
-- resizing the planet later just works — :draw() applies
-- love.graphics.scale(halfWidth, halfHeight) and draws these points
-- directly; collision math instead converts them to real WORLD-space
-- points (see toWorldPoly/toWorldPoint) since a circle test needs real
-- distances, which that scale would distort if it weren't uniform
-- (see its own comment on why it actually is, here).
--
-- Real collision is implemented for the outer boundary, the obstacle
-- walls, and the bumpers (see :resolveCircleCollision) — generic
-- enough for any future ball-like circle to be kept inside the table,
-- pushed out of each wall, and bounced off a bumper. Flippers/plungers are
-- drawn but NOT collidable yet — actually swinging a flipper or firing
-- a plunger needs real gameplay logic (an input, a swing/pull
-- animation) that doesn't exist yet, same as there being no ball/enter
-- action at all. See main.lua's own PinballPlanet setup comment.
-- :getPortalPosition() matches js/interiors/Interior.js's own API
-- contract, pointing at the first plunger (the real "ball enters here"
-- point) for whenever an actual "enter" action exists to aim at it.
--
-- Assumes planetoid.isRoundedRect (see lua/world/RoundedRectPlanetoid.lua).

local Vector2 = require("lua.vector2")

local PinballInterior = {}
PinballInterior.__index = PinballInterior

local COLOR_TABLE = { 0.93, 0.95, 0.98, 0.88 } -- the reference image's WHITE (open/passable)
local COLOR_WALL = { 0.06, 0.06, 0.08, 1 }     -- the reference image's BLACK (solid)
local COLOR_BUMPER = { 0.95, 0.25, 0.30, 1 }
local COLOR_BUMPER_RING = { 1.00, 0.85, 0.30, 1 }
local COLOR_FLIPPER = { 0.85, 0.85, 0.92, 1 }
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
-- mirrored is reserved for whenever actual flipper gameplay exists (to
-- know which input/swing-direction drives which flipper) — it doesn't
-- affect anything in this file yet.
local FLIPPERS = {
  { x = -0.534, y = 0.555, angle = 5.2, length = 0.277, mirrored = false },
  { x = 0.327, y = 0.553, angle = 173.3, length = 0.311, mirrored = false },
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

local function polygonCentroid(poly)
  local sx, sy = 0, 0
  for _, pt in ipairs(poly) do sx, sy = sx + pt[1], sy + pt[2] end
  return sx / #poly, sy / #poly
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
-- distance to it, and that edge's OUTWARD normal — "outward" picked by
-- testing which of an edge's two perpendiculars points away from the
-- polygon's own centroid, so this works regardless of the polygon's
-- own winding order.
local function closestPointOnPolygon(poly, px, py)
  local cx, cy = polygonCentroid(poly)
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
      if len > 1e-9 then nx, ny = -aby / len, abx / len end
      if nx * (cx - ex) + ny * (cy - ey) > 0 then
        nx, ny = -nx, -ny
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
  love.graphics.polygon("fill", paddlePoints(f.x, f.y, f.angle, f.length, FLIPPER_WIDTH_PIVOT, FLIPPER_WIDTH_TIP))
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
-- the (possibly adjusted) world position. Not called by anything yet
-- (no ball exists) — see this file's own header comment. Flippers/
-- plungers are deliberately NOT collidable here yet.
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
