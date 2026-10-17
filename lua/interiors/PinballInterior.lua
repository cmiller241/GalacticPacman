-- lua/interiors/PinballInterior.lua
--
-- The pinball table laid over the pinball planet's face, built from a
-- Tiled map (tiled/Pinball-Level2.lua) instead of hand-traced polygons.
-- The player plays it as a ball from the ordinary exterior camera: he
-- arrives resting on the plunger (see :onEnter, called by main.lua's own
-- entry beam), the jump button fires the plunger or the flippers (see
-- :triggerJumpAction), and draining out the bottom ends the session.
--
-- Walls: every tile's solid area comes from lua/world/PinballCurveTiles.lua
-- (generated alongside the curve reference sheet by
-- tiled/gen-pinball-curves.js), never from the tile ART — so redrawing the
-- sheet changes nothing about collision as long as tiles stay in place.
-- Each non-empty tile becomes one small polygon (its 64x64 box clipped by
-- that tile's line or arc), and the ball collides against the polygons of
-- the few cells it overlaps.
--
-- Objects (Tiled object layer, point objects, matched on Class):
--   Plunger                       ball rests on top of it; launches up the lane
--   Bumper                        optional "radius" property, Tiled pixels
--   Flipper-Left / Flipper-Right  point = pivot; optional "length" property,
--                                 Tiled pixels (default: sized from the
--                                 opposite flipper at the same height so
--                                 the tips leave a ball-sized gap)
--
-- Assumes the planet never rotates (main.lua sets rotationAngle = 0 and
-- rotationSpeed = 0): everything here is plain world space anchored at the
-- planet's own top-left corner.

local Vector2 = require("lua.vector2")
local CurveTiles = require("lua.world.PinballCurveTiles")
local Planetoid = require("lua.world.Planetoid")

local PinballInterior = {}
PinballInterior.__index = PinballInterior

----------------------------------------------------------------------
-- Tunables
----------------------------------------------------------------------

local TILE_SOURCE_SIZE = 32
local TILE_SCALE = 2 -- same 64-world-units-per-tile convention TiledTerrain.lua uses
local TILE_WORLD_SIZE = TILE_SOURCE_SIZE * TILE_SCALE

local GRAVITY_ACCEL = 0.15        -- world units/tick^2
-- true: gravity always pulls straight down the SCREEN, whichever way the
-- planet has turned, so a turning table tips the ball around. false: it
-- always pulls toward the table's own bottom (the drain), at any angle.
local GRAVITY_ALWAYS_SCREEN_DOWN = true
local MAX_BALL_SPEED = 46         -- world units/tick
local WALL_RESTITUTION = 0.5      -- speed kept bouncing off a wall (tangential speed is always kept, so he rides curves)
local PLUNGER_LAUNCH_SPEED = 44   -- enough to clear the ~4900-unit lane under GRAVITY_ACCEL with speed left over for the top curve
local BUMPER_RADIUS_PX = 48       -- Tiled pixels, when the object has no "radius" property
local BUMPER_KICK_SPEED = 24

local FLIPPER_REST_DEGREES = 28   -- below horizontal, pointing in toward the middle of the table
local FLIPPER_SWING_DEGREES = 56
local FLIPPER_SWING_UP_TICKS = 5
local FLIPPER_SWING_HOLD_TICKS = 12 -- minimum time up after a tap; holding jump keeps them up longer
local FLIPPER_SWING_DOWN_TICKS = 12
local FLIPPER_SIZE_SCALE = 0.8    -- length and thickness, relative to the original size
local FLIPPER_RADIUS = 16 * FLIPPER_SIZE_SCALE -- world units — the capsule's own half-thickness
local FLIPPER_RESTITUTION = 0.4
local FLIPPER_TIP_GAP_BALLS = 1.6 -- gap between paired flipper tips at rest, in ball diameters
local FLIPPER_DEFAULT_LENGTH = 200
local FLIPPER_PAIR_MAX_DY_PX = 64 -- how far apart two flippers' pivots can sit vertically and still count as a pair
local FLIPPER_SNAP_REACH_PX = 40  -- how far (Tiled pixels) a pivot may be from its guide wall's end and still snap onto it

local PLUNGER_WIDTH_PX = 64       -- Tiled pixels — the full width of the lane
local PLUNGER_HEIGHT_PX = 28
local PLUNGER_CATCH_DISTANCE = 10 -- world units above the plunger's top that still count as "resting on it"

-- Kept well under the ball's own radius (~24) and the flipper's own
-- thickness, so a fast ball or a swinging flipper can't skip past a
-- wall between collision checks.
local BALL_SUBSTEP_DISTANCE = 4
local ARC_VERTEX_SPACING = 6      -- world units between vertices along a curved wall

local COLOR_TABLE = { 0.09, 0.09, 0.12, 1 }
local COLOR_BUMPER = { 0.95, 0.25, 0.30, 1 }
local COLOR_BUMPER_STRIPE = { 0.96, 0.96, 0.96, 1 } -- the rim, behind COLOR_BUMPER's triangles
local COLOR_BUMPER_CAP = { 0.96, 0.96, 0.96, 1 }    -- center, normally
local COLOR_BUMPER_CAP_LIT = { 1.00, 0.85, 0.20, 1 } -- center, blinking after a hit
local COLOR_BUMPER_OUTLINE = { 0.12, 0.10, 0.14, 1 }
local BUMPER_TRIANGLES = 8        -- red triangles around the rim, each pointing out to the bumper's edge
local BUMPER_FLASH_TICKS = 24     -- how long the cap blinks after a hit
local BUMPER_BLINK_TICKS = 4      -- length of each on/off half of the blink
local BUMPER_BAKE_SCALE = 2       -- supersampling for the baked face, same as planetoid bodies
local BUMPER_BAKE_PADDING = 2     -- world units of transparent margin round the baked face
local BUMPER_SHADING_MIX = 0.55   -- how strongly the planetoid sun shading shows on bumpers (1 = full, like planetoids)
local COLOR_FLIPPER = { 0.25, 0.45, 0.95, 1 }
local COLOR_PLUNGER = { 0.55, 0.58, 0.65, 1 }

----------------------------------------------------------------------
-- Tile geometry -> collision polygons
----------------------------------------------------------------------

-- Tiled stores flips in the top three bits of each gid.
local FLIP_H, FLIP_V, FLIP_D = 0x80000000, 0x40000000, 0x20000000

local function splitGid(gid)
  local h = gid >= FLIP_H; if h then gid = gid - FLIP_H end
  local v = gid >= FLIP_V; if v then gid = gid - FLIP_V end
  local d = gid >= FLIP_D; if d then gid = gid - FLIP_D end
  return gid, h, v, d
end

-- The 2x2 matrix a flipped tile applies to tile-centered coordinates:
-- Tiled transposes first (diagonal flip), then mirrors.
local function flipMatrix(h, v, d)
  local a, b, c, dd = 1, 0, 0, 1
  if d then a, b, c, dd = 0, 1, 1, 0 end
  if h then a, b = -a, -b end
  if v then c, dd = -c, -dd end
  return a, b, c, dd
end

-- Whether tile-local point (x, y) is solid, and where segment a->b
-- crosses the surface, for one PinballCurveTiles entry.
local function surfaceFor(geom)
  if geom.kind == "line" then
    local function side(x, y) return (x - geom.x1) * geom.nx + (y - geom.y1) * geom.ny end
    return {
      inside = function(x, y) return side(x, y) < 0 end,
      cross = function(ax, ay, bx, by)
        local da, db = side(ax, ay), side(bx, by)
        local t = da / (da - db)
        return ax + (bx - ax) * t, ay + (by - ay) * t
      end,
    }
  end
  local cx, cy, r = geom.cx, geom.cy, geom.r
  local wantInside = geom.solid == "inside"
  return {
    isArc = true,
    inside = function(x, y)
      local inDisc = (x - cx) ^ 2 + (y - cy) ^ 2 < r * r
      return inDisc == wantInside
    end,
    cross = function(ax, ay, bx, by)
      local dx, dy = bx - ax, by - ay
      local fx, fy = ax - cx, ay - cy
      local A = dx * dx + dy * dy
      local B = 2 * (fx * dx + fy * dy)
      local C = fx * fx + fy * fy - r * r
      local disc = math.sqrt(math.max(0, B * B - 4 * A * C))
      local t = (-B - disc) / (2 * A)
      if t < -1e-6 or t > 1 + 1e-6 then t = (-B + disc) / (2 * A) end
      t = math.max(0, math.min(1, t))
      return ax + dx * t, ay + dy * t
    end,
  }
end

-- Clips the tile's 32x32 box to its solid side (tile-local source
-- pixels). Arcs get extra vertices between where the boundary leaves the
-- box edge and where it rejoins it, following the circle.
local function tileSolidPolygon(geom)
  local S = TILE_SOURCE_SIZE
  if geom.kind == "solid" then
    return { { 0, 0 }, { S, 0 }, { S, S }, { 0, S } }
  end
  local surf = surfaceFor(geom)
  local box = { { 0, 0 }, { S, 0 }, { S, S }, { 0, S } }

  -- Start the walk from a solid corner so an exit is always followed by
  -- its matching entry within the same pass.
  local start = nil
  for i, p in ipairs(box) do
    if surf.inside(p[1], p[2]) then start = i; break end
  end
  if not start then return nil end

  local out = {}
  local exitX, exitY = nil, nil
  for k = 0, 3 do
    local a = box[(start + k - 1) % 4 + 1]
    local b = box[(start + k) % 4 + 1]
    local aIn, bIn = surf.inside(a[1], a[2]), surf.inside(b[1], b[2])
    if aIn then table.insert(out, { a[1], a[2] }) end
    if aIn and not bIn then
      exitX, exitY = surf.cross(a[1], a[2], b[1], b[2])
      table.insert(out, { exitX, exitY })
    elseif bIn and not aIn then
      local enterX, enterY = surf.cross(a[1], a[2], b[1], b[2])
      if surf.isArc and exitX then
        local a0 = math.atan2(exitY - geom.cy, exitX - geom.cx)
        local a1 = math.atan2(enterY - geom.cy, enterX - geom.cx)
        local delta = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
        local steps = math.ceil(math.abs(delta) * geom.r * TILE_SCALE / ARC_VERTEX_SPACING)
        for i = 1, steps - 1 do
          local ang = a0 + delta * i / steps
          table.insert(out, { geom.cx + geom.r * math.cos(ang), geom.cy + geom.r * math.sin(ang) })
        end
      end
      table.insert(out, { enterX, enterY })
    end
  end
  if #out < 3 then return nil end
  return out
end

local function signedArea(poly)
  local area = 0
  for i = 1, #poly do
    local a, b = poly[i], poly[i % #poly + 1]
    area = area + (a[1] * b[2] - b[1] * a[2])
  end
  return area / 2
end

-- Polygon in world space plus its winding sign (for outward normals)
-- and bounding box (for a cheap reject).
local function finishPolygon(points)
  local poly = { points = points, orient = signedArea(points) >= 0 and 1 or -1 }
  local minX, minY, maxX, maxY = math.huge, math.huge, -math.huge, -math.huge
  for _, p in ipairs(points) do
    minX, maxX = math.min(minX, p[1]), math.max(maxX, p[1])
    minY, maxY = math.min(minY, p[2]), math.max(maxY, p[2])
  end
  poly.minX, poly.minY, poly.maxX, poly.maxY = minX, minY, maxX, maxY
  return poly
end

local function pointInPolygon(points, px, py)
  local inside = false
  local j = #points
  for i = 1, #points do
    local xi, yi = points[i][1], points[i][2]
    local xj, yj = points[j][1], points[j][2]
    if ((yi > py) ~= (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi) + xi) then
      inside = not inside
    end
    j = i
  end
  return inside
end

-- Closest boundary point, distance to it, and that edge's outward normal.
local function closestPointOnPolygon(poly, px, py)
  local points = poly.points
  local bestDist, bestX, bestY, bestNX, bestNY = math.huge, 0, 0, 0, -1
  for i = 1, #points do
    local a, b = points[i], points[i % #points + 1]
    local abx, aby = b[1] - a[1], b[2] - a[2]
    local len2 = abx * abx + aby * aby
    local t = 0
    if len2 > 1e-9 then
      t = math.max(0, math.min(1, ((px - a[1]) * abx + (py - a[2]) * aby) / len2))
    end
    local ex, ey = a[1] + abx * t, a[2] + aby * t
    local dist = math.sqrt((px - ex) ^ 2 + (py - ey) ^ 2)
    if dist < bestDist then
      local len = math.sqrt(len2)
      local nx, ny = 0, -1
      if len > 1e-9 then nx, ny = (aby / len) * poly.orient, (-abx / len) * poly.orient end
      bestDist, bestX, bestY, bestNX, bestNY = dist, ex, ey, nx, ny
    end
  end
  return bestX, bestY, bestDist, bestNX, bestNY
end

-- Pushes the ball out of a solid polygon and reflects the velocity
-- component going into it. Uses the direction from the closest point to
-- the ball's center as the normal whenever the center is outside — on a
-- curve that's the true radial direction, which is what lets him roll
-- smoothly around it instead of catching on each short edge. Returns
-- the contact normal when it touched (for the rolling spin), else nil.
local function bounceOffPolygon(poly, player)
  local x, y, r = player.pos.x, player.pos.y, player.radius
  if x + r < poly.minX or x - r > poly.maxX or y + r < poly.minY or y - r > poly.maxY then return end
  local ex, ey, dist, nx, ny = closestPointOnPolygon(poly, x, y)
  if pointInPolygon(poly.points, x, y) then
    player.pos.x, player.pos.y = ex + nx * r, ey + ny * r
  elseif dist < r then
    if dist > 1e-6 then nx, ny = (x - ex) / dist, (y - ey) / dist end
    player.pos.x, player.pos.y = ex + nx * r, ey + ny * r
  else
    return
  end
  local into = player.vel.x * nx + player.vel.y * ny
  if into < 0 then
    player.vel.x = player.vel.x - (1 + WALL_RESTITUTION) * into * nx
    player.vel.y = player.vel.y - (1 + WALL_RESTITUTION) * into * ny
  end
  return nx, ny
end

----------------------------------------------------------------------
-- Construction
----------------------------------------------------------------------

-- "../img/foo.png" relative to tiled/ -> "img/foo.png".
local function resolveMapPath(relative)
  local parts = {}
  for part in ("tiled/" .. relative):gmatch("[^/]+") do
    if part == ".." then table.remove(parts) elseif part ~= "." then table.insert(parts, part) end
  end
  return table.concat(parts, "/")
end

function PinballInterior.new(planetoid, mapData)
  local self = setmetatable({}, PinballInterior)
  self.planetoid = planetoid
  self.mapWidth, self.mapHeight = mapData.width, mapData.height
  self.anchorX = planetoid.pos.x - mapData.width * TILE_WORLD_SIZE / 2
  self.anchorY = planetoid.pos.y - mapData.height * TILE_WORLD_SIZE / 2

  -- Optional map properties, for tables with a longer plunger lane
  -- (tiled/Pinball-Level2.lua is twice as tall, so it launches harder).
  local mapProps = mapData.properties or {}
  self.plungerLaunchSpeed = tonumber(mapProps.plungerSpeed) or PLUNGER_LAUNCH_SPEED
  self.maxBallSpeed = tonumber(mapProps.maxBallSpeed) or MAX_BALL_SPEED

  local layer, tileset = nil, mapData.tilesets[1]
  for _, l in ipairs(mapData.layers) do
    if l.type == "tilelayer" then layer = l; break end
  end
  assert(layer and tileset, "PinballInterior: map needs a tile layer and a tileset")

  self:buildTiles(layer, tileset)
  self:buildObjects(mapData)
  return self
end

function PinballInterior:buildTiles(layer, tileset)
  local W, H = self.mapWidth, self.mapHeight
  local S = TILE_SOURCE_SIZE
  local half = S / 2
  local columns = tileset.columns or CurveTiles.columns
  self.cellPolys = {}

  local image = love.graphics.newImage(resolveMapPath(tileset.image))
  image:setFilter("nearest", "nearest")
  self.batch = love.graphics.newSpriteBatch(image, W * H, "static")
  local imgW, imgH = image:getDimensions()
  local quads = {}
  local missing = {}

  for row = 0, H - 1 do
    for col = 0, W - 1 do
      local rawGid = layer.data[row * W + col + 1]
      if rawGid and rawGid ~= 0 then
        local gid, fh, fv, fd = splitGid(rawGid)
        local id = gid - tileset.firstgid
        local a, b, c, d = flipMatrix(fh, fv, fd)
        local tileX = self.anchorX + col * TILE_WORLD_SIZE
        local tileY = self.anchorY + row * TILE_WORLD_SIZE

        -- Art. LÖVE's draw applies scale then rotation, so a transposed
        -- tile (anti-diagonal matrix) becomes a 90-degree turn plus a
        -- mirrored axis.
        if not quads[id] then
          quads[id] = love.graphics.newQuad((id % columns) * S, math.floor(id / columns) * S, S, S, imgW, imgH)
        end
        local rot, sx, sy
        if b == 0 then rot, sx, sy = 0, a, d else rot, sx, sy = math.pi / 2, c, -b end
        self.batch:add(quads[id], tileX + TILE_WORLD_SIZE / 2, tileY + TILE_WORLD_SIZE / 2,
          rot, sx * TILE_SCALE, sy * TILE_SCALE, half, half)

        -- Collision.
        local geom = CurveTiles.tiles[id]
        if geom then
          local localPoly = tileSolidPolygon(geom)
          if localPoly then
            local points = {}
            for _, p in ipairs(localPoly) do
              local ux, uy = p[1] - half, p[2] - half
              local fx, fy = a * ux + b * uy + half, c * ux + d * uy + half
              table.insert(points, { tileX + fx * TILE_SCALE, tileY + fy * TILE_SCALE })
            end
            self.cellPolys[row * W + col] = finishPolygon(points)
          end
        elseif not missing[id] then
          missing[id] = true
          print(string.format("PinballInterior: tile id %d has no entry in PinballCurveTiles.lua — treated as empty (no collision).", id))
        end
      end
    end
  end
end

function PinballInterior:buildObjects(mapData)
  self.bumpers, self.flippers, self.plunger = {}, {}, nil
  local ax, ay = self.anchorX, self.anchorY

  for _, l in ipairs(mapData.layers) do
    if l.type == "objectgroup" then
      for _, obj in ipairs(l.objects or {}) do
        local props = obj.properties or {}
        local wx, wy = ax + obj.x * TILE_SCALE, ay + obj.y * TILE_SCALE
        if obj.class == "Bumper" then
          table.insert(self.bumpers, {
            x = wx, y = wy,
            radius = (tonumber(props.radius) or BUMPER_RADIUS_PX) * TILE_SCALE,
          })
        elseif obj.class == "Flipper-Left" or obj.class == "Flipper-Right" then
          local isLeft = obj.class == "Flipper-Left"
          local rest = math.rad(isLeft and FLIPPER_REST_DEGREES or (180 - FLIPPER_REST_DEGREES))
          table.insert(self.flippers, {
            x = wx, y = wy, isLeft = isLeft,
            restAngle = rest,
            swingDir = isLeft and -1 or 1,
            length = tonumber(props.length) and tonumber(props.length) * TILE_SCALE or nil,
            angle = rest, angularVel = 0,
          })
        elseif obj.class == "Plunger" then
          local w, h = PLUNGER_WIDTH_PX * TILE_SCALE, PLUNGER_HEIGHT_PX * TILE_SCALE
          local points = {
            { wx - w / 2, wy }, { wx + w / 2, wy }, { wx + w / 2, wy + h }, { wx - w / 2, wy + h },
          }
          self.plunger = { x = wx, y = wy, width = w, height = h, poly = finishPolygon(points) }
        end
      end
    end
  end

  -- Snap each pivot onto the end of the guide wall beside it, so the
  -- guide rolls straight onto the flipper. A pivot left even a little
  -- away from the wall leaves a notch between the two that the ball can
  -- settle into, and the pivot is the one part of the flipper that never
  -- moves, so nothing could ever flip it back out.
  local snapReach = FLIPPER_SNAP_REACH_PX * TILE_SCALE
  for _, f in ipairs(self.flippers) do
    local side = f.isLeft and 1 or -1 -- the guide is on the left of a left flipper
    local endX, endY = nil, nil
    for _, poly in pairs(self.cellPolys) do
      for _, p in ipairs(poly.points) do
        local dx, dy = (f.x - p[1]) * side, f.y - p[2]
        if dx >= 0 and dx <= snapReach and math.abs(dy) <= snapReach then
          -- The guide's end is the point nearest the flipper sideways,
          -- and the highest of those (the wall below it shares its x).
          if not endX or dx < (f.x - endX) * side - 1e-6
              or (math.abs(dx - (f.x - endX) * side) <= 1e-6 and p[2] < endY) then
            endX, endY = p[1], p[2]
          end
        end
      end
    end
    if endX then
      f.x, f.y = endX + side * FLIPPER_RADIUS, endY + FLIPPER_RADIUS
    end
  end

  -- Size each flipper without a "length" from its partner on the other
  -- side at about the same height, leaving a ball-and-a-bit gap between
  -- the two tips at rest.
  local ballDiameter = 2 * (30 * 0.792) -- Player's own ball radius (PLAYER_RADIUS * BALL_RADIUS_MULTIPLIER)
  for _, f in ipairs(self.flippers) do
    if not f.length then
      local best = nil
      for _, g in ipairs(self.flippers) do
        if g.isLeft ~= f.isLeft and math.abs(g.y - f.y) <= FLIPPER_PAIR_MAX_DY_PX * TILE_SCALE then
          if not best or math.abs(g.x - f.x) < math.abs(best.x - f.x) then best = g end
        end
      end
      if best then
        local span = math.abs(best.x - f.x) - ballDiameter * FLIPPER_TIP_GAP_BALLS - 2 * FLIPPER_RADIUS
        f.length = math.max(FLIPPER_RADIUS * 2, span / (2 * math.cos(math.rad(FLIPPER_REST_DEGREES))))
      else
        f.length = FLIPPER_DEFAULT_LENGTH
      end
    end
  end

  -- Shrunk after pairing, so the pivots stay where they snapped and the
  -- tips just end shorter (the gap between them widens accordingly).
  for _, f in ipairs(self.flippers) do
    f.length = f.length * FLIPPER_SIZE_SCALE
  end
end

----------------------------------------------------------------------
-- Session
----------------------------------------------------------------------

-- Everything on the table (walls, objects, the ball's physics) lives in
-- TABLE space: world space as it would be with the planet unrotated.
-- When the planet turns (planetoid.rotationAngle), these convert between
-- that and true world space, turning about the planet's center.
function PinballInterior:rotationAngle()
  return self.planetoid.rotationAngle or 0
end

-- angle: optional, defaults to the planet's current rotation.
function PinballInterior:tableToWorld(x, y, angle)
  local a = angle or self:rotationAngle()
  if a == 0 then return x, y end
  local cx, cy = self.planetoid.pos.x, self.planetoid.pos.y
  local c, s = math.cos(a), math.sin(a)
  local dx, dy = x - cx, y - cy
  return cx + dx * c - dy * s, cy + dx * s + dy * c
end

function PinballInterior:worldToTable(x, y, angle)
  local a = angle or self:rotationAngle()
  if a == 0 then return x, y end
  local cx, cy = self.planetoid.pos.x, self.planetoid.pos.y
  local c, s = math.cos(-a), math.sin(-a)
  local dx, dy = x - cx, y - cy
  return cx + dx * c - dy * s, cy + dx * s + dy * c
end

local function rotateVector(x, y, a)
  local c, s = math.cos(a), math.sin(a)
  return x * c - y * s, x * s + y * c
end

-- Where the beam drops him: resting on top of the plunger.
function PinballInterior:getPortalPosition()
  local pl = self.plunger
  local ballRadius = 30 * 0.792
  if not pl then
    return Vector2.new(self.planetoid.pos.x, self.planetoid.pos.y)
  end
  return Vector2.new(self:tableToWorld(pl.x, pl.y - ballRadius - 1))
end

function PinballInterior:onEnter(player)
  player:forceBallMode()
  player.inPinball = self
  player.vel.x, player.vel.y = 0, 0
  player.ballSpin = 0
  self.ballAngle = self:rotationAngle()
  local pl = self.plunger
  if pl then
    player.pos.x, player.pos.y = self:tableToWorld(pl.x, pl.y - player.radius - 1)
  end
  player.prevPos = player.pos:clone()
  for _, f in ipairs(self.flippers) do
    f.swingTimer, f.angle, f.angularVel = nil, f.restAngle, 0
  end
end

-- Draining ends the session: he stands back up on top of the planet,
-- next to the entry beam (self.exitPosition, set by main.lua), or at
-- the top-middle if nothing set one.
function PinballInterior:exitBall(player)
  player.inPinball = nil
  player.vel.x, player.vel.y = 0, 0
  if player.isBall then player:exitBallMode() end
  local p = self.planetoid
  local exitX = self.exitPosition and self.exitPosition.x or p.pos.x
  -- The planet's top (its own top, wherever that's turned to).
  player.pos.x, player.pos.y = self:tableToWorld(exitX, p.pos.y - p.halfHeight - player.radius - 2)
  player.prevPos = player.pos:clone()
end

local function flipperSwingAmount(t)
  local up, hold, down = FLIPPER_SWING_UP_TICKS, FLIPPER_SWING_HOLD_TICKS, FLIPPER_SWING_DOWN_TICKS
  if t < up then return t / up end
  if t < up + hold then return 1 end
  if t < up + hold + down then return 1 - (t - up - hold) / down end
  return nil
end

function PinballInterior:updateFlippers(ts)
  for _, f in ipairs(self.flippers) do
    local previous = f.angle
    local amount = 0
    if f.swingTimer then
      f.swingTimer = f.swingTimer + ts
      -- Held: parked at the end of the hold phase (still fully up), so
      -- letting go drops them straight away; a quick tap still gets the
      -- full minimum hold.
      if self.flippersHeld then
        f.swingTimer = math.min(f.swingTimer, FLIPPER_SWING_UP_TICKS + FLIPPER_SWING_HOLD_TICKS)
      end
      amount = flipperSwingAmount(f.swingTimer)
      if not amount then f.swingTimer, amount = nil, 0 end
    end
    f.angle = f.restAngle + f.swingDir * math.rad(FLIPPER_SWING_DEGREES) * amount
    f.angularVel = ts > 0 and (f.angle - previous) / ts or 0
  end
end

function PinballInterior:triggerFlippers()
  for _, f in ipairs(self.flippers) do
    -- Re-pressing mid-swing keeps it up rather than restarting from rest.
    if f.swingTimer and f.swingTimer > FLIPPER_SWING_UP_TICKS then
      f.swingTimer = FLIPPER_SWING_UP_TICKS
    else
      f.swingTimer = f.swingTimer or 0
    end
  end
end

function PinballInterior:isBallOnPlunger(player)
  local pl = self.plunger
  if not pl then return false end
  local px, py = self:worldToTable(player.pos.x, player.pos.y)
  local gap = pl.y - (py + player.radius)
  return math.abs(px - pl.x) < pl.width / 2 + player.radius
    and gap > -player.radius and gap < PLUNGER_CATCH_DISTANCE
end

-- Jump: launches the plunger while he's sitting on it (including after
-- rolling back down the lane), otherwise flips both flippers.
function PinballInterior:triggerJumpAction(player)
  if self:isBallOnPlunger(player) then
    -- Straight up the lane, in world space wherever the table's turned to.
    player.vel.x, player.vel.y = rotateVector(0, -self.plungerLaunchSpeed, self:rotationAngle())
    self.plunger.kickTimer = 8
  else
    self:triggerFlippers()
  end
end

----------------------------------------------------------------------
-- Ball physics
----------------------------------------------------------------------

local function bounceOffBumper(b, player)
  local dx, dy = player.pos.x - b.x, player.pos.y - b.y
  local dist = math.sqrt(dx * dx + dy * dy)
  local minDist = b.radius + player.radius
  if dist >= minDist then return end
  local nx, ny = 0, -1
  if dist > 1e-4 then nx, ny = dx / dist, dy / dist end
  player.pos.x, player.pos.y = b.x + nx * minDist, b.y + ny * minDist
  player.vel.x, player.vel.y = nx * BUMPER_KICK_SPEED, ny * BUMPER_KICK_SPEED
  b.flashTimer = BUMPER_FLASH_TICKS
end

-- Capsule collision against the flipper's current pivot->tip segment,
-- bouncing relative to the flipper surface's own velocity at the
-- contact point — the tip moves fastest, so hits near it fly furthest.
local function bounceOffFlipper(f, player)
  local tipX = f.x + math.cos(f.angle) * f.length
  local tipY = f.y + math.sin(f.angle) * f.length
  local abx, aby = tipX - f.x, tipY - f.y
  local t = ((player.pos.x - f.x) * abx + (player.pos.y - f.y) * aby) / (abx * abx + aby * aby)
  t = math.max(0, math.min(1, t))
  local ex, ey = f.x + abx * t, f.y + aby * t
  local dx, dy = player.pos.x - ex, player.pos.y - ey
  local dist = math.sqrt(dx * dx + dy * dy)
  local minDist = FLIPPER_RADIUS + player.radius
  if dist >= minDist then return end

  local nx, ny = 0, -1
  if dist > 1e-4 then nx, ny = dx / dist, dy / dist end
  player.pos.x, player.pos.y = ex + nx * minDist, ey + ny * minDist

  local rx, ry = ex - f.x, ey - f.y
  local surfVX, surfVY = -ry * f.angularVel, rx * f.angularVel
  local into = (player.vel.x - surfVX) * nx + (player.vel.y - surfVY) * ny
  if into < 0 then
    player.vel.x = player.vel.x - (1 + FLIPPER_RESTITUTION) * into * nx
    player.vel.y = player.vel.y - (1 + FLIPPER_RESTITUTION) * into * ny
  end
  return nx, ny
end

-- Replaces normal gravity and planet collision entirely while
-- player.inPinball is set (see main.lua's own update loop).
-- jumpHeld: whether the jump button is down right now — keeps raised
-- flippers up, as in real pinball.
--
-- The ball is moved into table space for the physics and back out after,
-- so a turning planet carries the ball round with it (gravity: see
-- GRAVITY_ALWAYS_SCREEN_DOWN).
function PinballInterior:updateBall(player, ts, jumpHeld)
  local a = self:rotationAngle()
  -- In with the angle he was put OUT with last frame (not the planet's
  -- new one), so he rides along as the table turns instead of the walls
  -- sweeping into him.
  local from = self.ballAngle or a
  player.pos.x, player.pos.y = self:worldToTable(player.pos.x, player.pos.y, from)
  player.vel.x, player.vel.y = rotateVector(player.vel.x, player.vel.y, -from)
  self:updateBallInTable(player, ts, jumpHeld)
  -- Draining (exitBall) already put him in world space, on the planet's top.
  if player.inPinball == self then
    player.pos.x, player.pos.y = self:tableToWorld(player.pos.x, player.pos.y, a)
    player.vel.x, player.vel.y = rotateVector(player.vel.x, player.vel.y, a)
    self.ballAngle = a
  end
end

function PinballInterior:updateBallInTable(player, ts, jumpHeld)
  self.flippersHeld = jumpHeld
  -- (Physics runs in table space: screen-down is rotated into it.)
  local gx, gy = 0, GRAVITY_ACCEL
  if GRAVITY_ALWAYS_SCREEN_DOWN then gx, gy = rotateVector(0, GRAVITY_ACCEL, -(self.ballAngle or self:rotationAngle())) end
  player.vel.x = player.vel.x + gx * ts
  player.vel.y = player.vel.y + gy * ts

  local speed = math.sqrt(player.vel.x * player.vel.x + player.vel.y * player.vel.y)
  if speed > self.maxBallSpeed then
    local scale = self.maxBallSpeed / speed
    player.vel.x, player.vel.y = player.vel.x * scale, player.vel.y * scale
    speed = self.maxBallSpeed
  end

  -- Substep count covers whichever moves further this frame: the ball,
  -- or the fastest flipper tip (a flipper swinging up must not jump
  -- over the ball between checks either).
  local fastest = speed
  for _, f in ipairs(self.flippers) do
    if f.swingTimer then
      fastest = math.max(fastest, f.length * math.rad(FLIPPER_SWING_DEGREES) / FLIPPER_SWING_UP_TICKS)
    end
  end
  local steps = math.max(1, math.ceil(fastest * ts / BALL_SUBSTEP_DISTANCE))
  local stepTs = ts / steps

  local W, H = self.mapWidth, self.mapHeight
  local mapRight = self.anchorX + W * TILE_WORLD_SIZE
  local mapBottom = self.anchorY + H * TILE_WORLD_SIZE

  for _ = 1, steps do
    self:updateFlippers(stepTs)
    player.pos.x = player.pos.x + player.vel.x * stepTs
    player.pos.y = player.pos.y + player.vel.y * stepTs
    local contactNX, contactNY = nil, nil

    -- Out the drain (the gap in the bottom row), or anywhere else off
    -- the table — the latter only through a collision bug, but ending
    -- the session beats leaving him lost inside the planet.
    if player.pos.y - player.radius > mapBottom or player.pos.y < self.anchorY
        or player.pos.x < self.anchorX or player.pos.x > mapRight then
      self:exitBall(player)
      return
    end

    local r = player.radius
    local c0 = math.max(0, math.floor((player.pos.x - r - self.anchorX) / TILE_WORLD_SIZE))
    local c1 = math.min(W - 1, math.floor((player.pos.x + r - self.anchorX) / TILE_WORLD_SIZE))
    local r0 = math.max(0, math.floor((player.pos.y - r - self.anchorY) / TILE_WORLD_SIZE))
    local r1 = math.min(H - 1, math.floor((player.pos.y + r - self.anchorY) / TILE_WORLD_SIZE))
    for row = r0, r1 do
      for col = c0, c1 do
        local poly = self.cellPolys[row * W + col]
        if poly then
          local nx, ny = bounceOffPolygon(poly, player)
          if nx then contactNX, contactNY = nx, ny end
        end
      end
    end

    if self.plunger then
      local nx, ny = bounceOffPolygon(self.plunger.poly, player)
      if nx then contactNX, contactNY = nx, ny end
    end
    for _, b in ipairs(self.bumpers) do bounceOffBumper(b, player) end
    for _, f in ipairs(self.flippers) do
      local nx, ny = bounceOffFlipper(f, player)
      if nx then contactNX, contactNY = nx, ny end
    end

    -- Rolling: while touching something he rolls without slipping
    -- (spin = speed along the surface / radius, clockwise when the
    -- surface is below him and he moves right); in the air he keeps
    -- whatever spin he left the last surface with.
    if contactNX then
      player.ballSpin = (contactNX * player.vel.y - contactNY * player.vel.x) / player.radius
    end
    player.ballRollAngle = ((player.ballRollAngle or 0) + (player.ballSpin or 0) * stepTs) % (2 * math.pi)
  end

  for _, b in ipairs(self.bumpers) do
    if b.flashTimer then b.flashTimer = b.flashTimer > ts and b.flashTimer - ts or nil end
  end
  if self.plunger and self.plunger.kickTimer then
    self.plunger.kickTimer = self.plunger.kickTimer > ts and self.plunger.kickTimer - ts or nil
  end
end

----------------------------------------------------------------------
-- Drawing
----------------------------------------------------------------------

-- One bumper's face, centered at (cx, cy), radius r — everything kept
-- inside r so the sun shading (which stops at r) covers all of it.
local function drawBumperFace(cx, cy, r, lit)
  -- Rim: white, with red triangles standing on the cap and narrowing to
  -- a point right at the bumper's outer edge — a sunburst.
  love.graphics.setColor(COLOR_BUMPER_STRIPE)
  love.graphics.circle("fill", cx, cy, r)

  -- Dark outlines round the rim and the cap, so the white cap still
  -- reads as its own shape against the white rim.
  love.graphics.setColor(COLOR_BUMPER_OUTLINE)
  love.graphics.setLineWidth(r * 0.06)
  love.graphics.circle("line", cx, cy, r * 0.97)

  -- Drawn after the outer outline so each point reaches the true edge.
  -- Bases sit just under the cap's own outline (drawn next), side by side.
  local step = 2 * math.pi / BUMPER_TRIANGLES
  local baseR = r * 0.58
  love.graphics.setColor(COLOR_BUMPER)
  for i = 0, BUMPER_TRIANGLES - 1 do
    local mid = (i + 0.5) * step
    local a0, a1 = mid - step / 2, mid + step / 2
    love.graphics.polygon("fill",
      cx + math.cos(a0) * baseR, cy + math.sin(a0) * baseR,
      cx + math.cos(mid) * r, cy + math.sin(mid) * r,
      cx + math.cos(a1) * baseR, cy + math.sin(a1) * baseR)
  end

  love.graphics.setColor(COLOR_BUMPER_OUTLINE)
  love.graphics.circle("fill", cx, cy, r * 0.61)

  love.graphics.setColor(lit and COLOR_BUMPER_CAP_LIT or COLOR_BUMPER_CAP)
  love.graphics.circle("fill", cx, cy, r * 0.55)
end

-- Bakes a bumper's face into an image the way planetoid bodies are
-- (supersampled, with a little transparent margin for a smooth edge),
-- so it can go through the same sun-shading shader. One pair (normal
-- and lit cap) per bumper size, shared by every bumper that size.
local bumperFaceCache = {}
local function getBumperFace(r)
  if bumperFaceCache[r] then return bumperFaceCache[r] end
  local size = math.ceil((r + BUMPER_BAKE_PADDING) * 2 * BUMPER_BAKE_SCALE)
  local half = size / (2 * BUMPER_BAKE_SCALE) -- canvas half-width, in world units
  local function bake(lit)
    local canvas = love.graphics.newCanvas(size, size)
    canvas:setFilter("linear", "linear")
    love.graphics.push("all")
    love.graphics.origin()
    love.graphics.setCanvas(canvas)
    love.graphics.clear(0, 0, 0, 0)
    love.graphics.scale(BUMPER_BAKE_SCALE)
    drawBumperFace(half, half, r, lit)
    love.graphics.pop()
    return canvas
  end
  local face = { normal = bake(false), lit = bake(true), half = half }
  bumperFaceCache[r] = face
  return face
end

function PinballInterior:draw()
  local ax, ay = self.anchorX, self.anchorY
  local w, h = self.mapWidth * TILE_WORLD_SIZE, self.mapHeight * TILE_WORLD_SIZE

  -- Everything below is drawn in table space, turned with the planet.
  local cx, cy = self.planetoid.pos.x, self.planetoid.pos.y
  love.graphics.push()
  love.graphics.translate(cx, cy)
  love.graphics.rotate(self:rotationAngle())
  love.graphics.translate(-cx, -cy)

  love.graphics.setColor(COLOR_TABLE)
  love.graphics.rectangle("fill", ax, ay, w, h)
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(self.batch)

  for _, b in ipairs(self.bumpers) do
    -- The pop (slightly bigger) only for the first few ticks of a hit;
    -- the cap keeps blinking for the rest of BUMPER_FLASH_TICKS.
    local elapsed = b.flashTimer and (BUMPER_FLASH_TICKS - b.flashTimer) or nil
    local grow = (elapsed and elapsed < 6) and 1.15 or 1
    local lit = elapsed and math.floor(elapsed / BUMPER_BLINK_TICKS) % 2 == 0

    -- Baked face, drawn through the planetoids' own sun shading (lit
    -- side, dark side, highlight) — see Planetoid.applySunShadingAt.
    b.face = b.face or getBumperFace(b.radius)
    local face = b.face
    local canvas = lit and face.lit or face.normal
    local r = b.radius * grow
    local shader = Planetoid.applySunShadingAt(b.x, b.y, r, (face.half - b.radius) * grow, BUMPER_SHADING_MIX)
    local s = grow / BUMPER_BAKE_SCALE
    love.graphics.setColor(1, 1, 1, 1)
    love.graphics.draw(canvas, b.x, b.y, 0, s, s, canvas:getWidth() / 2, canvas:getHeight() / 2)
    if shader then love.graphics.setShader() end
  end

  local pl = self.plunger
  if pl then
    -- Pops up briefly when fired, purely visual.
    local lift = pl.kickTimer and -pl.height * 0.5 or 0
    love.graphics.setColor(COLOR_PLUNGER)
    love.graphics.rectangle("fill", pl.x - pl.width / 2, pl.y + lift, pl.width, pl.height)
  end

  love.graphics.setColor(COLOR_FLIPPER)
  for _, f in ipairs(self.flippers) do
    local cosA, sinA = math.cos(f.angle), math.sin(f.angle)
    local tipX, tipY = f.x + cosA * f.length, f.y + sinA * f.length
    local nx, ny = -sinA, cosA
    local rp, rt = FLIPPER_RADIUS, FLIPPER_RADIUS * 0.6
    love.graphics.polygon("fill",
      f.x + nx * rp, f.y + ny * rp, tipX + nx * rt, tipY + ny * rt,
      tipX - nx * rt, tipY - ny * rt, f.x - nx * rp, f.y - ny * rp)
    love.graphics.circle("fill", f.x, f.y, rp)
    love.graphics.circle("fill", tipX, tipY, rt)
  end

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.pop()
end

return PinballInterior
