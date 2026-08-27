-- lua/world/TiledTerrain.lua
--
-- Loads a Tiled-exported Lua map (e.g. tiled/Level1.lua) into real,
-- walkable collision geometry plus a single baked-once rendering of the
-- whole tile grid.
--
-- Tile roles, derived from GID ranges (see tiled/Grass Tiles.tsx — a
-- 9-column x 2-row, 32px tileset over img/platform.png):
--   local index 0-8 (GIDs 1-9, row 0)  = walkable top (flat or 45° slope)
--   local index 9-17 (GIDs 10-18, row 1) = solid background fill, not walkable
--   GID 0                                = empty
--
-- Slope DIRECTION and steepness are never read off the GID itself —
-- they're derived purely from comparing which grid ROW the walkable-top
-- tile sits in from one column to the next (flat = same row, 45° slope =
-- exactly one row different). This sidesteps ever having to hardcode
-- "GID 7 means sloping which way," which the tileset alone can't answer
-- unambiguously, and keeps working unchanged if more top-tile variants
-- are added later.
--
-- Each shape built here is an OPEN path (a hill has two ends, unlike
-- RoundedRectPlanetoid's closed rectangle loop) — see the isOpenPath
-- flag and Player.lua's own walking code for the "fall off the end"
-- half of this. It's also deliberately NOT isSkyDome: this is meant to
-- be solid ground (collidable from every side), not a jump-through-
-- from-below floating platform.

local state = require("lua.state")
local Vector2 = require("lua.vector2")

local TiledTerrain = {}

----------------------------------------------------------------------
-- Tunables
----------------------------------------------------------------------

local TILE_SOURCE_SIZE = 32  -- px, matches tiled/Grass Tiles.tsx
local TILE_SCALE = 2         -- same 2x convention JumpPlatform.lua already uses
local TILE_WORLD_SIZE = TILE_SOURCE_SIZE * TILE_SCALE  -- 64 world units/tile

-- Matches tiled/Grass Tiles.tsx's own layout (288x64 = 9 cols x 2 rows).
-- Not derivable from the exported map data itself (external tileset
-- references only carry name/firstgid/filename, not their own image
-- dimensions) — would need updating if that tileset's shape changes.
local TILESET_COLUMNS = 9
local TOP_TILE_COUNT = 9 -- local indices [0, TOP_TILE_COUNT) are walkable top; the rest are fill
local FLAT_INDEX_MAX = 4 -- local indices [0, FLAT_INDEX_MAX] are the 5 flat variants

local SLOPE_SPEED_MULTIPLIER = 0.6 -- walking speed while on a 45-degree segment; flat stays 1.0

----------------------------------------------------------------------
-- Tileset GID -> local index
----------------------------------------------------------------------

local function findTileset(tilesets, gid)
  local best = nil
  for _, ts in ipairs(tilesets) do
    if ts.firstgid <= gid and (not best or ts.firstgid > best.firstgid) then
      best = ts
    end
  end
  return best
end

-- Returns "flat", "slopeAscRight", "slopeDescRight", "fill", or "empty".
--
-- The two slope tile pairs are NOT interchangeable — each anchors to a
-- DIFFERENT neighbor, confirmed by walking tiled/Level1.lua's actual
-- placements: local index 6 (GID7, used at columns 41 and 48) is placed
-- so its own row matches its LEFT neighbor's row and steps down one row
-- to the right ("descends going right"); local index 7 (GID8, used at
-- column 48 in a lower layer) is placed so its own row matches its RIGHT
-- neighbor's row and steps down one row to the left ("ascends going
-- right"). Treating both pairs the same way (inferring orientation from
-- which side the neighboring row differs, rather than from the tile's own
-- sub-type) is what shifted one of the two slope directions a full tile
-- off from its actual rendered position — see buildWorldSegments below,
-- which now keys directly off this per-tile classification instead of
-- guessing from row deltas.
local function classifyGid(tilesets, gid)
  if gid == 0 then return "empty" end
  local ts = findTileset(tilesets, gid)
  if not ts then return "empty" end
  local localIndex = gid - ts.firstgid -- 0-based
  if localIndex <= FLAT_INDEX_MAX then return "flat" end
  if localIndex < TOP_TILE_COUNT then
    if localIndex == 5 or localIndex == 7 then return "slopeAscRight" end
    return "slopeDescRight" -- localIndex 6 or 8
  end
  return "fill"
end

local function isTopRole(role)
  return role == "flat" or role == "slopeAscRight" or role == "slopeDescRight"
end

----------------------------------------------------------------------
-- Shared baked quads (one 9x2 grid, reused by every loaded level)
----------------------------------------------------------------------

local tileQuadCache = nil

local function getTileQuadForLocalIndex(img, localIndex)
  if not tileQuadCache then tileQuadCache = {} end
  local quad = tileQuadCache[localIndex]
  if quad then return quad end
  local col = localIndex % TILESET_COLUMNS
  local row = math.floor(localIndex / TILESET_COLUMNS)
  local fullW, fullH = img:getDimensions()
  quad = love.graphics.newQuad(
    col * TILE_SOURCE_SIZE, row * TILE_SOURCE_SIZE,
    TILE_SOURCE_SIZE, TILE_SOURCE_SIZE, fullW, fullH
  )
  tileQuadCache[localIndex] = quad
  return quad
end

----------------------------------------------------------------------
-- TerrainShape — one open, walkable run of flat/slope segments
----------------------------------------------------------------------

local TerrainShape = {}
TerrainShape.__index = TerrainShape

-- Projects (worldX, worldY) onto segment [seg.a, seg.b], clamped to the
-- segment's own extent. Shared by nearestSurfacePoint (which wants the
-- point/normal/distance) and arcPositionForWorldPoint (which wants how
-- far along the segment that clamped point is).
local function projectOntoSegment(seg, worldX, worldY)
  local dx, dy = seg.b.x - seg.a.x, seg.b.y - seg.a.y
  local lenSq = dx * dx + dy * dy
  local t = 0
  if lenSq > 1e-9 then
    t = ((worldX - seg.a.x) * dx + (worldY - seg.a.y) * dy) / lenSq
    t = math.max(0, math.min(1, t))
  end
  local px, py = seg.a.x + dx * t, seg.a.y + dy * t
  local ddx, ddy = worldX - px, worldY - py
  return t, px, py, math.sqrt(ddx * ddx + ddy * ddy)
end

function TerrainShape:nearestSurfacePoint(worldX, worldY)
  local best = nil
  for _, seg in ipairs(self.segments) do
    local _, px, py, dist = projectOntoSegment(seg, worldX, worldY)
    if not best or dist < best.distance then
      best = { point = Vector2.new(px, py), normal = seg.normal, distance = dist }
    end
  end
  return best
end

function TerrainShape:distanceToSurface(worldX, worldY)
  return self:nearestSurfacePoint(worldX, worldY).distance
end

-- Landing check for open-path terrain: a segment only counts as a landing
-- candidate when the player's movement THIS FRAME actually crossed it —
-- was on the outward (walkable) side of the segment a moment ago, and is
-- at/through it now — while genuinely positioned over the segment's own
-- span (no clamping to endpoints). This is the same swept test ordinary
-- platformer tile collision uses ("was above last frame, at-or-below now"),
-- and it's what makes both jump-through-from-below and walking off the end
-- just work with no timers or tuned distance tolerances: approaching from
-- below never satisfies "was on the outward side," and once the player is
-- horizontally past a segment's true endpoint, no segment's span contains
-- them, so nothing lands. Used only by CollisionSystem:tryLandOnPlanet;
-- every other caller (orientation, gravity direction while airborne, etc.)
-- still wants the always-clamped nearestSurfacePoint.
function TerrainShape:findLandingCrossing(prevX, prevY, curX, curY)
  local best = nil
  for _, seg in ipairs(self.segments) do
    local dx, dy = seg.b.x - seg.a.x, seg.b.y - seg.a.y
    local lenSq = dx * dx + dy * dy
    if lenSq > 1e-9 then
      local nx, ny = seg.normal.x, seg.normal.y
      local prevSigned = (prevX - seg.a.x) * nx + (prevY - seg.a.y) * ny
      local curSigned = (curX - seg.a.x) * nx + (curY - seg.a.y) * ny
      if prevSigned >= 0 and curSigned <= prevSigned then
        local t = ((curX - seg.a.x) * dx + (curY - seg.a.y) * dy) / lenSq
        if t >= 0 and t <= 1 then
          local px, py = seg.a.x + dx * t, seg.a.y + dy * t
          local ddx, ddy = curX - px, curY - py
          local dist = math.sqrt(ddx * ddx + ddy * ddy)
          if not best or dist < best.distance then
            best = { point = Vector2.new(px, py), normal = seg.normal, distance = dist }
          end
        end
      end
    end
  end
  return best
end

function TerrainShape:containsPoint(worldX, worldY)
  return self:distanceToSurface(worldX, worldY) < 1
end

-- No-op: TerrainShape instances live in state.planetoids (needed for the
-- generic physics/collision/gravity code to find them), and that list's
-- own draw loop calls :draw() on every entry unconditionally — but the
-- actual visuals are handled once for the whole level by Level:draw()
-- below (the single baked canvas), not per-shape. Same "provide the
-- no-op so the generic loop doesn't crash" precedent SkyDomePlanetoid
-- uses for methods that genuinely don't apply to it.
function TerrainShape:draw() end

function TerrainShape:getPerimeter()
  return self.totalLength
end

-- Internal: which segment covers arc-length s (clamped, not wrapped —
-- this is an open path), and the world point at that exact spot.
function TerrainShape:segmentAtArcPosition(s)
  local clamped = math.max(0, math.min(self.totalLength, s))
  local remaining = clamped
  for i, seg in ipairs(self.segments) do
    if remaining <= seg.length or i == #self.segments then
      local t = seg.length > 0 and (remaining / seg.length) or 0
      t = math.max(0, math.min(1, t))
      local px = seg.a.x + (seg.b.x - seg.a.x) * t
      local py = seg.a.y + (seg.b.y - seg.a.y) * t
      return seg, Vector2.new(px, py)
    end
    remaining = remaining - seg.length
  end
  local seg = self.segments[#self.segments]
  return seg, seg.b:clone()
end

function TerrainShape:worldPointAtArcPosition(s, pushDistance)
  pushDistance = pushDistance or 0
  local seg, point = self:segmentAtArcPosition(s)
  local normal = seg.normal
  if pushDistance ~= 0 then
    point = point:clone():add(normal:clone():multiply(pushDistance))
  end
  return { point = point, normal = normal }
end

function TerrainShape:arcPositionForWorldPoint(worldX, worldY)
  local traveled = 0
  local bestArc, bestDistSq = 0, math.huge
  for _, seg in ipairs(self.segments) do
    local t, px, py = projectOntoSegment(seg, worldX, worldY)
    local ddx, ddy = worldX - px, worldY - py
    local distSq = ddx * ddx + ddy * ddy
    if distSq < bestDistSq then
      bestDistSq = distSq
      bestArc = traveled + t * seg.length
    end
    traveled = traveled + seg.length
  end
  return bestArc
end

-- Walking-speed hook Player.lua looks for (duck-typed — see
-- lua/entities/Player.lua's generic isRoundedRect walking branch).
-- Steepness is binary here since every slope in this system is exactly
-- 45 degrees by construction: a segment either has a horizontal tangent
-- (flat) or it doesn't (slope).
function TerrainShape:getArcSpeedMultiplier(s)
  local seg = self:segmentAtArcPosition(s)
  if math.abs(seg.tangent.y) > 0.01 then
    return SLOPE_SPEED_MULTIPLIER
  end
  return 1.0
end

----------------------------------------------------------------------
-- Building shapes from the tile grid
----------------------------------------------------------------------

-- Returns an array indexed [0, width-1], each entry a list of every row
-- (0-based tile row, smaller = higher up) classified "top" in that column,
-- top-to-bottom. A single column can legitimately hold more than one —
-- e.g. a floating plateau directly above a lower staircase step, which is
-- exactly how tiled/Level1.lua is built (confirmed by walking its actual
-- data: columns 30-34 each carry three separate top tiles at rows 14, 22,
-- and 29). A naive "first hit wins" height profile would silently discard
-- every layer but the topmost, making the staircase underneath completely
-- uncollidable even though it renders fine — see buildVertexRuns below for
-- how multiple simultaneous layers are threaded into separate shapes.
local function computeTopPointsByColumn(layer, tilesets, width, height)
  local pointsByColumn = {}
  for col = 0, width - 1 do
    local rows = {}
    for row = 0, height - 1 do
      local gid = layer.data[row * width + col + 1] -- Lua 1-based, row-major
      if gid ~= 0 then
        local role = classifyGid(tilesets, gid)
        if isTopRole(role) then
          table.insert(rows, { row = row, kind = role })
        end
      end
    end
    pointsByColumn[col] = rows
  end
  return pointsByColumn
end

-- Threads each column's top points into shapes: a list of open chains is
-- carried left-to-right, each chain extended by whichever point in the
-- next column is within one row (flat or 45-degree step) of its own last
-- point; a chain that finds no match ends (and is kept if it has more
-- than one point); any leftover points start new chains. This lets
-- several stacked layers (a plateau, a shelf below it, a staircase below
-- that) all run concurrently as independent shapes instead of only ever
-- tracking the topmost one. Result: a list of vertex runs, each a list of
-- {col, row, kind} points, same shape buildWorldSegments expects (kind
-- carried straight through unchanged — it's per-tile, not derived from
-- chain adjacency).
local function buildVertexRuns(pointsByColumn, width)
  local runs = {}
  local openChains = {}
  for col = 0, width - 1 do
    local entries = pointsByColumn[col] or {}
    local usedRow = {}
    local newOpenChains = {}

    for _, chain in ipairs(openChains) do
      local last = chain[#chain]
      local best, bestDelta = nil, nil
      for _, entry in ipairs(entries) do
        if not usedRow[entry.row] then
          local delta = math.abs(entry.row - last.row)
          if delta <= 1 and (not bestDelta or delta < bestDelta) then
            bestDelta = delta
            best = entry
          end
        end
      end
      if best then
        usedRow[best.row] = true
        table.insert(chain, { col = col, row = best.row, kind = best.kind })
        table.insert(newOpenChains, chain)
      elseif #chain > 1 then
        table.insert(runs, chain)
      end
    end

    for _, entry in ipairs(entries) do
      if not usedRow[entry.row] then
        table.insert(newOpenChains, { { col = col, row = entry.row, kind = entry.kind } })
      end
    end

    openChains = newOpenChains
  end

  for _, chain in ipairs(openChains) do
    if #chain > 1 then table.insert(runs, chain) end
  end
  return runs
end

-- Coalesces a vertex run into straight segments (flat runs and 45-degree
-- runs collapse to one segment each, not one per tile), in WORLD space.
--
-- Each column contributes its own LEFT and RIGHT tile edges rather than a
-- single point at its center — a flat tile's left and right edges are
-- both at its own row, tracing a plain horizontal line; a slope tile's
-- two edges sit at DIFFERENT rows (one tile's own row, the other one row
-- off), exactly which edge is which determined by its `kind`
-- (slopeAscRight / slopeDescRight, set in classifyGid — the two slope tile
-- pairs anchor to opposite neighbors and are not interchangeable, see its
-- comment). Consecutive columns' shared edge always lines up exactly, so
-- the duplicate point is simply dropped, leaving a minimal, pixel-accurate
-- polyline with no separate "extend the outer ends" step needed — the
-- first and last points are already true tile edges.
local function buildWorldSegments(vertices, anchorX, anchorY)
  local function worldXY(col, row)
    return anchorX + col * TILE_WORLD_SIZE, anchorY + row * TILE_WORLD_SIZE
  end

  local points = {}
  local function addPoint(x, y)
    local last = points[#points]
    if not last or last.x ~= x or last.y ~= y then
      table.insert(points, { x = x, y = y })
    end
  end

  for _, v in ipairs(vertices) do
    local leftRow, rightRow
    if v.kind == "slopeDescRight" then
      leftRow, rightRow = v.row, v.row + 1
    elseif v.kind == "slopeAscRight" then
      leftRow, rightRow = v.row + 1, v.row
    else
      leftRow, rightRow = v.row, v.row
    end
    local lx, ly = worldXY(v.col, leftRow)
    addPoint(lx, ly)
    local rx, ry = worldXY(v.col + 1, rightRow)
    addPoint(rx, ry)
  end

  local segments = {}
  local segStart = 1
  for i = 2, #points do
    local prevDx, prevDy = points[i].x - points[i - 1].x, points[i].y - points[i - 1].y
    local nextDx = (i < #points) and (points[i + 1].x - points[i].x) or nil
    local nextDy = (i < #points) and (points[i + 1].y - points[i].y) or nil
    local sameDir = nextDx ~= nil and prevDx == nextDx and prevDy == nextDy
    if not sameDir then
      local a = Vector2.new(points[segStart].x, points[segStart].y)
      local b = Vector2.new(points[i].x, points[i].y)
      local tangent = b:subtract(a):normalize()
      -- rotate tangent -90 degrees for the outward (upward-facing) normal —
      -- matches RoundedRectPlanetoid's own edge convention (dir=(1,0) -> normal=(0,-1))
      local normal = Vector2.new(tangent.y, -tangent.x):normalize()
      table.insert(segments, {
        a = a, b = b, tangent = tangent, normal = normal,
        length = b:subtract(a):length(),
      })
      segStart = i
    end
  end
  return segments
end

local function newShape(segments)
  local self = setmetatable({}, TerrainShape)
  self.segments = segments
  self.totalLength = 0
  for _, seg in ipairs(segments) do self.totalLength = self.totalLength + seg.length end

  self.isRoundedRect = true
  self.isImmovable = true
  self.isPermanent = true
  self.isPullExempt = true
  self.isOpenPath = true
  self.forceUprightJump = true
  self.vel = Vector2.new(0, 0)
  self.mass = 1e9

  -- Bounding circle + halfHeight, for generic code that expects every
  -- planetoid-like object to have these (e.g. utils.isOnScreen culling,
  -- and CollisionSystem:handleImmovableCollisions, which unconditionally
  -- computes `im.pos.y - im.halfHeight` for ANY isRoundedRect immovable
  -- before checking whether nearestDomeSurfacePoint/nearestBaseSurfacePoint
  -- even exist — omitting halfHeight would crash that call, not just
  -- silently skip a branch).
  local minX, maxX, minY, maxY = math.huge, -math.huge, math.huge, -math.huge
  for _, seg in ipairs(segments) do
    for _, p in ipairs({ seg.a, seg.b }) do
      minX = math.min(minX, p.x); maxX = math.max(maxX, p.x)
      minY = math.min(minY, p.y); maxY = math.max(maxY, p.y)
    end
  end
  local cx, cy = (minX + maxX) / 2, (minY + maxY) / 2
  self.pos = Vector2.new(cx, cy)
  self.halfHeight = math.max(1, (maxY - minY) / 2)
  local radius = 0
  for _, seg in ipairs(segments) do
    for _, p in ipairs({ seg.a, seg.b }) do
      radius = math.max(radius, p:subtract(self.pos):length())
    end
  end
  self.radius = math.max(1, radius)

  return self
end

----------------------------------------------------------------------
-- Whole-level renderer — baked ONCE to a single canvas, never rebuilt
-- per frame (see SkyDomePlanetoid's own foreground-hex-grid history for
-- exactly why a per-frame rebuild of something static is worth avoiding).
----------------------------------------------------------------------

local Level = {}
Level.__index = Level

function Level:draw()
  if not self.canvas then return end
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(self.canvas, self.anchorX, self.anchorY)
end

----------------------------------------------------------------------
-- Public API
----------------------------------------------------------------------

-- mapData: the table returned by require()-ing a Tiled Lua export.
-- anchorX/anchorY: world position of the map's own (0,0) (top-left) corner.
function TiledTerrain.load(mapData, anchorX, anchorY)
  local layer = nil
  for _, l in ipairs(mapData.layers) do
    if l.type == "tilelayer" then layer = l; break end
  end
  assert(layer, "TiledTerrain.load: no tilelayer found in map data")

  local width, height = mapData.width, mapData.height
  local tilesets = mapData.tilesets

  -- Collision: derive shapes from the walkable-top height profile.
  local pointsByColumn = computeTopPointsByColumn(layer, tilesets, width, height)
  local runs = buildVertexRuns(pointsByColumn, width)
  local shapes = {}
  for _, run in ipairs(runs) do
    local segments = buildWorldSegments(run, anchorX, anchorY)
    if #segments > 0 then
      table.insert(shapes, newShape(segments))
    end
  end

  -- Rendering: bake the ENTIRE grid (fill tiles included — rendering
  -- doesn't care about the walkable/fill distinction, only collision does)
  -- to one canvas, once.
  local canvas = nil
  local img = state.platformTexture
  if img then
    canvas = love.graphics.newCanvas(width * TILE_WORLD_SIZE, height * TILE_WORLD_SIZE)
    love.graphics.push()
    love.graphics.origin()
    love.graphics.setCanvas(canvas)
    love.graphics.clear(0, 0, 0, 0)
    love.graphics.setColor(1, 1, 1, 1)
    for row = 0, height - 1 do
      for col = 0, width - 1 do
        local gid = layer.data[row * width + col + 1]
        if gid ~= 0 then
          local ts = findTileset(tilesets, gid)
          if ts then
            local localIndex = gid - ts.firstgid
            local quad = getTileQuadForLocalIndex(img, localIndex)
            love.graphics.draw(img, quad, col * TILE_WORLD_SIZE, row * TILE_WORLD_SIZE, 0, TILE_SCALE, TILE_SCALE)
          end
        end
      end
    end
    love.graphics.setCanvas()
    love.graphics.pop()
    love.graphics.setColor(1, 1, 1, 1)
  end

  local mapWorldWidth = width * TILE_WORLD_SIZE
  local mapWorldHeight = height * TILE_WORLD_SIZE

  local level = setmetatable({
    shapes = shapes,
    canvas = canvas,
    anchorX = anchorX,
    anchorY = anchorY,
    -- Bounding center/radius, same convention every other drawable in
    -- this codebase exposes, so callers can viewport-cull this draw
    -- call the same way (see utils.isOnScreen).
    pos = Vector2.new(anchorX + mapWorldWidth / 2, anchorY + mapWorldHeight / 2),
    radius = math.sqrt(mapWorldWidth * mapWorldWidth + mapWorldHeight * mapWorldHeight) / 2,
  }, Level)

  return level
end

return TiledTerrain
