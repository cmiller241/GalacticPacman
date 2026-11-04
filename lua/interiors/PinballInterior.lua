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
--   Drop                          drop target: point = where it stands
--                                 against a wall; it lines itself up with
--                                 that wall (on an incline, it leans with
--                                 it). Knocked down by a solid hit; the
--                                 whole bank down scores a bonus and they
--                                 all pop back up. Optional "length",
--                                 Tiled pixels.
--   Rollover                      rollover: the ball rolls over it (it
--                                 doesn't bounce off) and lights it; all
--                                 of them lit scores a bonus and resets
--                                 them.
--
-- Scoring goes to state.score (the HUD's), with a little "+points" pop-up.
--
-- Assumes the planet never rotates (main.lua sets rotationAngle = 0 and
-- rotationSpeed = 0): everything here is plain world space anchored at the
-- planet's own top-left corner.

local state = require("lua.state")
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

-- Drop targets.
local DROP_LENGTH_PX = 44         -- Tiled pixels, along the wall (when the object has no "length" property)
local DROP_THICKNESS_PX = 10      -- Tiled pixels, out from the wall
local DROP_WALL_REACH_PX = 48     -- how far (Tiled pixels) its point may be from the wall it lines up with
local DROP_HIT_SPEED = 3          -- world units/tick the ball must be moving into it to knock it down
local DROP_POINTS = 500
local DROP_BANK_BONUS = 5000      -- the whole bank knocked down
local DROP_RESET_TICKS = 90       -- how long a fully knocked-down bank stays down before popping back up
local DROP_FLASH_TICKS = 18       -- how long a target flashes as it goes down
local COLOR_DROP = { 0.98, 0.62, 0.12, 1 }
local COLOR_DROP_STRIPE = { 1.00, 0.95, 0.80, 1 }
local COLOR_DROP_EDGE = { 0.35, 0.16, 0.04, 1 }
local COLOR_DROP_SLOT = { 0.03, 0.03, 0.05, 1 } -- the slot a knocked-down target has sunk into

-- Rollovers.
local ROLLOVER_REACH_PX = 22      -- Tiled pixels from its point the ball's center must come to roll over it
local ROLLOVER_SLOT_WIDTH_PX = 12
local ROLLOVER_SLOT_LENGTH_PX = 34
local ROLLOVER_LIGHT_OFFSET_PX = 30 -- how far above the slot its light sits
local ROLLOVER_LIGHT_RADIUS_PX = 8
local ROLLOVER_POINTS = 250
local ROLLOVER_ALL_BONUS = 2500   -- every rollover lit
local ROLLOVER_CELEBRATE_TICKS = 70 -- how long they all flash once every one is lit, before resetting
local COLOR_ROLLOVER_SLOT = { 0.03, 0.03, 0.05, 1 }
local COLOR_ROLLOVER_WIRE = { 0.80, 0.82, 0.88, 1 }
local COLOR_ROLLOVER_OFF = { 0.35, 0.22, 0.05, 1 }
local COLOR_ROLLOVER_ON = { 1.00, 0.80, 0.20, 1 }

-- Points pop-ups.
local POPUP_TICKS = 50
local POPUP_RISE = 1.2            -- world units/tick
local COLOR_POPUP = { 1.00, 0.95, 0.55 }

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

  local layer = nil
  for _, l in ipairs(mapData.layers) do
    if l.type == "tilelayer" then layer = l; break end
  end
  assert(layer and mapData.tilesets[1], "PinballInterior: map needs a tile layer and a tileset")

  self:buildTiles(layer, mapData.tilesets)
  self:buildObjects(mapData)
  return self
end

-- tilesets: the map's. Every one of them is the same curve sheet — the
-- map's own embedded copy (the one with the image) and any external .tsx
-- reference to it (tiled/Pinball.tsx) — so a tile's place on the sheet is
-- just its gid less its own tileset's firstgid, whichever one it's from.
function PinballInterior:buildTiles(layer, tilesets)
  local W, H = self.mapWidth, self.mapHeight
  local S = TILE_SOURCE_SIZE
  local half = S / 2
  local tileset = tilesets[1]
  for _, ts in ipairs(tilesets) do
    if ts.image then tileset = ts; break end
  end
  local columns = tileset.columns or CurveTiles.columns
  -- The tileset a gid belongs to: the one with the highest firstgid not past it.
  local function firstgidOf(gid)
    local best = tileset.firstgid
    for _, ts in ipairs(tilesets) do
      if ts.firstgid <= gid and ts.firstgid > best then best = ts.firstgid end
    end
    return best
  end
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
        local id = gid - firstgidOf(gid)
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
  self.drops, self.rollovers, self.popups = {}, {}, {}
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
        elseif obj.class == "Drop" then
          table.insert(self.drops, {
            x = wx, y = wy, up = true,
            length = (tonumber(props.length) or DROP_LENGTH_PX) * TILE_SCALE,
          })
        elseif obj.class == "Rollover" then
          table.insert(self.rollovers, { x = wx, y = wy, lit = false })
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

  -- Each drop target stands with its back against the wall nearest its
  -- point, its face along that wall — so against an incline it leans with
  -- the incline instead of standing square. (No wall in reach: square,
  -- facing up.)
  local reach = DROP_WALL_REACH_PX * TILE_SCALE
  local thick = DROP_THICKNESS_PX * TILE_SCALE
  -- (Only a wall's open face counts: each tile's polygon also has edges
  -- against its solid neighbors, with no open space in front of them.)
  local function solidAt(x, y)
    local col = math.floor((x - ax) / TILE_WORLD_SIZE)
    local row = math.floor((y - ay) / TILE_WORLD_SIZE)
    if col < 0 or row < 0 or col >= self.mapWidth or row >= self.mapHeight then return true end
    local poly = self.cellPolys[row * self.mapWidth + col]
    return poly ~= nil and pointInPolygon(poly.points, x, y)
  end
  for _, d in ipairs(self.drops) do
    local bestDist, bx, by, bnx, bny = reach, d.x, d.y + thick / 2, 0, -1
    for _, poly in pairs(self.cellPolys) do
      if d.x + reach >= poly.minX and d.x - reach <= poly.maxX and d.y + reach >= poly.minY and d.y - reach <= poly.maxY then
        local pts = poly.points
        for i = 1, #pts do
          local a, b = pts[i], pts[i % #pts + 1]
          local abx, aby = b[1] - a[1], b[2] - a[2]
          local len = math.sqrt(abx * abx + aby * aby)
          if len > 1e-6 then
            local nx, ny = (aby / len) * poly.orient, (-abx / len) * poly.orient
            local mx, my = (a[1] + b[1]) / 2, (a[2] + b[2]) / 2
            if not solidAt(mx + nx * 2, my + ny * 2) then
              local t = math.max(0, math.min(1, ((d.x - a[1]) * abx + (d.y - a[2]) * aby) / (len * len)))
              local ex, ey = a[1] + abx * t, a[2] + aby * t
              local dist = math.sqrt((d.x - ex) ^ 2 + (d.y - ey) ^ 2)
              if dist < bestDist then bestDist, bx, by, bnx, bny = dist, ex, ey, nx, ny end
            end
          end
        end
      end
    end
    -- Along the wall (tangent) and out from it (normal), and its corners.
    local tx, ty = -bny, bnx
    local hl = d.length / 2
    d.nx, d.ny, d.tx, d.ty = bnx, bny, tx, ty
    d.cx, d.cy = bx + bnx * thick / 2, by + bny * thick / 2
    d.corners = {
      { bx - tx * hl, by - ty * hl },
      { bx + tx * hl, by + ty * hl },
      { bx + tx * hl + bnx * thick, by + ty * hl + bny * thick },
      { bx - tx * hl + bnx * thick, by - ty * hl + bny * thick },
    }
    d.poly = finishPolygon(d.corners)
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
    for _, d in ipairs(self.drops) do
      if d.up then
        local vx, vy = player.vel.x, player.vel.y
        local nx, ny = bounceOffPolygon(d.poly, player)
        if nx then
          contactNX, contactNY = nx, ny
          if -(vx * nx + vy * ny) >= DROP_HIT_SPEED then self:knockDown(d) end
        end
      end
    end
    self:checkRollovers(player)

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
  self:updateTargets(player, ts)
end

----------------------------------------------------------------------
-- Drop targets, rollovers, scoring
----------------------------------------------------------------------

-- Points to the HUD's score, with a pop-up where they were scored.
function PinballInterior:score(points, x, y)
  state.score = (state.score or 0) + points
  table.insert(self.popups, { text = "+" .. points, x = x, y = y, life = POPUP_TICKS })
end

function PinballInterior:knockDown(d)
  d.up = false
  d.flashTimer = DROP_FLASH_TICKS
  self:score(DROP_POINTS, d.cx, d.cy)
  for _, other in ipairs(self.drops) do
    if other.up then return end
  end
  -- The whole bank's down.
  local first = self.drops[1]
  self:score(DROP_BANK_BONUS, first.cx + first.nx * 60, first.cy + first.ny * 60)
  self.dropResetTimer = DROP_RESET_TICKS
end

-- Rolling over one (coming within reach of it, not already over it) lights it.
function PinballInterior:checkRollovers(player)
  if self.rolloverCelebrate then return end
  local reach = ROLLOVER_REACH_PX * TILE_SCALE
  for _, ro in ipairs(self.rollovers) do
    local over = (player.pos.x - ro.x) ^ 2 + (player.pos.y - ro.y) ^ 2 <= reach * reach
    if over and not ro.ballOver then
      ro.flashTimer = DROP_FLASH_TICKS
      if not ro.lit then
        ro.lit = true
        self:score(ROLLOVER_POINTS, ro.x, ro.y)
        local all = true
        for _, other in ipairs(self.rollovers) do all = all and other.lit end
        if all then
          self:score(ROLLOVER_ALL_BONUS, ro.x, ro.y - 80)
          self.rolloverCelebrate = ROLLOVER_CELEBRATE_TICKS
        end
      end
    end
    ro.ballOver = over
  end
end

function PinballInterior:updateTargets(player, ts)
  for _, d in ipairs(self.drops) do
    if d.flashTimer then d.flashTimer = d.flashTimer > ts and d.flashTimer - ts or nil end
  end
  for _, ro in ipairs(self.rollovers) do
    if ro.flashTimer then ro.flashTimer = ro.flashTimer > ts and ro.flashTimer - ts or nil end
  end

  -- A knocked-down bank pops back up — once the ball's clear of all of it.
  if self.dropResetTimer then
    self.dropResetTimer = self.dropResetTimer - ts
    if self.dropResetTimer <= 0 then
      local clear = true
      for _, d in ipairs(self.drops) do
        local ex, ey, dist = closestPointOnPolygon(d.poly, player.pos.x, player.pos.y)
        if dist < player.radius + 4 or pointInPolygon(d.poly.points, player.pos.x, player.pos.y) then clear = false end
      end
      if clear then
        for _, d in ipairs(self.drops) do d.up = true; d.flashTimer = DROP_FLASH_TICKS end
        self.dropResetTimer = nil
      end
    end
  end

  -- Every rollover lit: they flash together a while, then all go out.
  if self.rolloverCelebrate then
    self.rolloverCelebrate = self.rolloverCelebrate - ts
    if self.rolloverCelebrate <= 0 then
      for _, ro in ipairs(self.rollovers) do ro.lit = false end
      self.rolloverCelebrate = nil
    end
  end

  for i = #self.popups, 1, -1 do
    local p = self.popups[i]
    p.life = p.life - ts
    p.y = p.y - POPUP_RISE * ts
    if p.life <= 0 then table.remove(self.popups, i) end
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

-- One bumper, centred on (x, y): its baked face, drawn through the
-- planetoids' own sun shading (lit side, dark side, highlight) — see
-- Planetoid.applySunShadingAt. hitTicks: ticks since it was last hit,
-- or nil — it pops (a little bigger) for the first few ticks of a hit,
-- and its cap blinks for BUMPER_FLASH_TICKS. Shared with the bumpers
-- out in space along the cannon's route (see lua/world/Cannon.lua).
function PinballInterior.drawBumper(x, y, radius, hitTicks)
  local hit = hitTicks and hitTicks < BUMPER_FLASH_TICKS
  local grow = (hit and hitTicks < 6) and 1.15 or 1
  local lit = hit and math.floor(hitTicks / BUMPER_BLINK_TICKS) % 2 == 0
  local face = getBumperFace(radius)
  local canvas = lit and face.lit or face.normal
  local r = radius * grow
  local shader = Planetoid.applySunShadingAt(x, y, r, (face.half - radius) * grow, BUMPER_SHADING_MIX)
  local s = grow / BUMPER_BAKE_SCALE
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(canvas, x, y, 0, s, s, canvas:getWidth() / 2, canvas:getHeight() / 2)
  if shader then love.graphics.setShader() end
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

  self:drawRollovers()
  self:drawDrops()

  for _, b in ipairs(self.bumpers) do
    local elapsed = b.flashTimer and (BUMPER_FLASH_TICKS - b.flashTimer) or nil
    PinballInterior.drawBumper(b.x, b.y, b.radius, elapsed)
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

  self:drawPopups()

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.pop()
end

-- A slot with a wire across it where the ball rolls over, and a light
-- above it: dim until rolled over, then lit; all of them flashing together
-- once every one is lit.
function PinballInterior:drawRollovers()
  local w, l = ROLLOVER_SLOT_WIDTH_PX * TILE_SCALE, ROLLOVER_SLOT_LENGTH_PX * TILE_SCALE
  local lightR = ROLLOVER_LIGHT_RADIUS_PX * TILE_SCALE
  local blinkOn = self.rolloverCelebrate and math.floor(self.rolloverCelebrate / 6) % 2 == 0
  for _, ro in ipairs(self.rollovers) do
    love.graphics.setColor(COLOR_ROLLOVER_SLOT)
    love.graphics.rectangle("fill", ro.x - w / 2, ro.y - l / 2, w, l, w / 2, w / 2)
    love.graphics.setColor(COLOR_ROLLOVER_WIRE)
    love.graphics.setLineWidth(3)
    love.graphics.line(ro.x - w * 0.3, ro.y, ro.x + w * 0.3, ro.y)

    local on = (ro.lit and not self.rolloverCelebrate) or blinkOn or ro.flashTimer
    local lx, ly = ro.x, ro.y - l / 2 - ROLLOVER_LIGHT_OFFSET_PX * TILE_SCALE + lightR
    if on then
      love.graphics.setColor(COLOR_ROLLOVER_ON[1], COLOR_ROLLOVER_ON[2], COLOR_ROLLOVER_ON[3], 0.25)
      love.graphics.circle("fill", lx, ly, lightR * 1.9)
    end
    love.graphics.setColor(on and COLOR_ROLLOVER_ON or COLOR_ROLLOVER_OFF)
    love.graphics.circle("fill", lx, ly, lightR)
    love.graphics.setColor(COLOR_ROLLOVER_SLOT)
    love.graphics.setLineWidth(2)
    love.graphics.circle("line", lx, ly, lightR)
  end
  love.graphics.setLineWidth(1)
end

-- Standing: an orange target lined up with its wall (leaning with an
-- incline), with a light stripe along its face; flashing as it goes down
-- or pops back up. Knocked down: just the dark slot it sank into.
function PinballInterior:drawDrops()
  for _, d in ipairs(self.drops) do
    local c = d.corners
    local flash = d.flashTimer and math.floor(d.flashTimer / 3) % 2 == 0
    if d.up then
      love.graphics.setColor(flash and COLOR_DROP_STRIPE or COLOR_DROP)
      love.graphics.polygon("fill", c[1][1], c[1][2], c[2][1], c[2][2], c[3][1], c[3][2], c[4][1], c[4][2])
      -- The stripe, along the face (the side away from the wall).
      local inset = 0.3
      local function along(p, q, t) return p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t end
      local ax, ay = along(c[4], c[1], inset)
      local bx, by = along(c[3], c[2], inset)
      local s = 0.15
      local ax2, ay2 = ax + (bx - ax) * s, ay + (by - ay) * s
      local bx2, by2 = bx - (bx - ax) * s, by - (by - ay) * s
      love.graphics.setColor(COLOR_DROP_STRIPE)
      love.graphics.setLineWidth(3)
      love.graphics.line(ax2, ay2, bx2, by2)
      love.graphics.setColor(COLOR_DROP_EDGE)
      love.graphics.setLineWidth(2)
      love.graphics.polygon("line", c[1][1], c[1][2], c[2][1], c[2][2], c[3][1], c[3][2], c[4][1], c[4][2])
    else
      -- (A sliver of the target's footprint, against the wall.)
      local t = 0.3
      local function toward(p, q) return p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t end
      local x3, y3 = toward(c[2], c[3])
      local x4, y4 = toward(c[1], c[4])
      love.graphics.setColor(flash and COLOR_DROP or COLOR_DROP_SLOT)
      love.graphics.polygon("fill", c[1][1], c[1][2], c[2][1], c[2][2], x3, y3, x4, y4)
    end
  end
  love.graphics.setLineWidth(1)
end

function PinballInterior:drawPopups()
  local font = love.graphics.getFont()
  local scale = 3
  for _, p in ipairs(self.popups) do
    local alpha = math.min(1, p.life / (POPUP_TICKS * 0.4))
    local w = font:getWidth(p.text) * scale
    love.graphics.setColor(0, 0, 0, alpha * 0.6)
    love.graphics.print(p.text, p.x - w / 2 + 2, p.y + 2, 0, scale, scale)
    love.graphics.setColor(COLOR_POPUP[1], COLOR_POPUP[2], COLOR_POPUP[3], alpha)
    love.graphics.print(p.text, p.x - w / 2, p.y, 0, scale, scale)
  end
end

return PinballInterior
