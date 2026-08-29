-- lua/world/TiledTerrain.lua
--
-- Loads a Tiled-exported Lua map (e.g. tiled/Level1.lua) into real
-- collision geometry (walkable top surfaces AND solid walls) plus a
-- single baked-once rendering of the whole tile grid.
--
-- Tile roles come from CUSTOM PROPERTIES authored per-tile in Tiled
-- (tiled/Grass Tiles.tsx), not from GID/index ranges. An earlier version
-- of this loader inferred role and slope direction from where a tile sat
-- in the sheet — that broke silently the moment the two slope tile pairs
-- turned out to anchor to opposite neighbors (confirmed only by testing),
-- and would break again the same way for any future tile whose meaning
-- doesn't happen to match the assumed ordinal convention. Explicit
-- properties don't have that failure mode: adding a new tile is just
-- "draw it, tag it," no code changes required.
--
-- Expected properties, set per-tile in the tileset (see buildTilePropertyLookup):
--   role  = "top" (walkable — stand on it, land on it, jump through from
--           below), "wall" (solid on every side — see WallShape below),
--           or "fill" (pure decoration, no collision). Untagged tiles
--           default to "fill".
--   slope = "flat", "riseLeft", or "riseRight" — only meaningful when
--           role == "top".
--
-- IMPORTANT: this requires the tileset to be EMBEDDED in the map (Tiled:
-- right-click the tileset in the Tilesets panel -> "Embed Tileset in
-- Map"). An external tileset reference (just name/firstgid/filename) never
-- carries tile properties into the map's own Lua export — see
-- buildTilePropertyLookup's assertion if this hasn't been done.
--
-- Each walkable shape built here is an OPEN path (a hill has two ends,
-- unlike RoundedRectPlanetoid's closed rectangle loop) — see the
-- isOpenPath flag and Player.lua's own walking code for the "fall off the
-- end" half of this. It's also deliberately NOT isSkyDome: jump-through-
-- from-below is handled by CollisionSystem's own swept crossing test
-- instead (TerrainShape:findLandingCrossing), not the SkyDome gravity-
-- window model.

local state = require("lua.state")
local Vector2 = require("lua.vector2")

local TiledTerrain = {}

----------------------------------------------------------------------
-- Tunables
----------------------------------------------------------------------

local TILE_SOURCE_SIZE = 32  -- px, matches tiled/Grass Tiles.tsx
local TILE_SCALE = 2         -- same 2x convention JumpPlatform.lua already uses
local TILE_WORLD_SIZE = TILE_SOURCE_SIZE * TILE_SCALE  -- 64 world units/tile

-- Fallback only — used if the embedded tileset def doesn't carry its own
-- `columns` field for some reason. Normally read straight off the
-- tileset data (see getTileQuadForLocalIndex), which stays correct
-- automatically as the sheet grows (it went from 2 rows to 5 without any
-- code change needed here).
local DEFAULT_TILESET_COLUMNS = 9

local SLOPE_UPHILL_MULTIPLIER = 0.6   -- walking speed climbing a 45-degree segment; flat stays 1.0
local SLOPE_DOWNHILL_MULTIPLIER = 1.4 -- walking speed descending a 45-degree segment

----------------------------------------------------------------------
-- Tileset GID -> role/slope, read from Tiled custom properties
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

-- Tiled's Lua exporter emits a tile's custom properties as a flat
-- { name = value } table. Defensively also accept the array-of-
-- {name=,value=} shape (the JSON exporter's convention) in case a
-- different Tiled version ever produces that instead — cheap to support,
-- and fails loudly either way if neither shape is present (see the
-- assertion in buildTilePropertyLookup) rather than silently guessing.
local function readTileProperties(rawProperties)
  if not rawProperties then return {} end
  if rawProperties.role ~= nil or rawProperties.slope ~= nil then
    return rawProperties
  end
  local out = {}
  for _, entry in ipairs(rawProperties) do
    if entry.name then out[entry.name] = entry.value end
  end
  return out
end

-- Builds a gid -> {role=, slope=} lookup from every tileset's embedded
-- `tiles` array. Asserts loudly if a tileset has none — the near-certain
-- cause is the tileset still being an external reference (just
-- name/firstgid/filename) instead of embedded in the map, which silently
-- carries no properties at all rather than an obviously-wrong value, so
-- this is the one place worth failing hard instead of falling back to a
-- guess.
local function buildTilePropertyLookup(tilesets)
  local byGid = {}
  local anyTiles = false
  for _, ts in ipairs(tilesets) do
    if ts.tiles then
      anyTiles = true
      for _, tileDef in ipairs(ts.tiles) do
        byGid[ts.firstgid + tileDef.id] = readTileProperties(tileDef.properties)
      end
    end
  end
  assert(anyTiles, "TiledTerrain.load: no embedded tile properties found — " ..
    "the tileset must be embedded in the map (Tiled: right-click it in the " ..
    "Tilesets panel -> \"Embed Tileset in Map\", then re-export)")
  return byGid
end

-- Returns "flat", "riseRight", "riseLeft", "wall", "fill", or "empty",
-- straight from that tile's own `role`/`slope` properties. Untagged or
-- unrecognized-role tiles default to "fill" (matches the sheet's own
-- convention — undecorated background dirt needs no explicit tagging).
local function classifyGid(tileProps, gid)
  if gid == 0 then return "empty" end
  local props = tileProps[gid]
  local role = props and props.role
  if role == "wall" then return "wall" end
  if role == "top" then
    local slope = props.slope
    if slope == "riseLeft" or slope == "riseRight" then return slope end
    return "flat"
  end
  return "fill"
end

-- "wall" counts as walkable-top too, in addition to getting its own
-- solid WallShape AABB elsewhere (see buildWallShapes) — a wall tile is
-- solid rock: its vertical face blocks horizontal passage and is what a
-- wall jump kicks off of, but its TOP is ordinary ground, exactly like a
-- real cliff. Without this, a wall tile sitting flush against a walkable
-- ledge (same row, adjacent column — the ordinary way to draw a cliff at
-- the end of a plateau) would cut the walkable chain off one column short
-- of where the ground actually ends, and a player or Ooomba walking to
-- that true edge would clip the wall's AABB from above/the side instead
-- of just standing on it like the rest of the ledge — confirmed against
-- tiled/Level1.lua's own col17/row14 wall tile, placed exactly this way
-- at the left end of the main plateau.
local function isTopRole(role)
  return role == "flat" or role == "riseRight" or role == "riseLeft" or role == "wall"
end

----------------------------------------------------------------------
-- Shared baked quads (reused by every loaded level). Keyed only by
-- localIndex, not by which tileset it came from — fine as long as this
-- project uses a single tileset (true today); a second tileset with a
-- different column count sharing a localIndex would need this cache
-- keyed by (tileset, localIndex) instead.
----------------------------------------------------------------------

local tileQuadCache = nil

local function getTileQuadForLocalIndex(img, localIndex, columns)
  if not tileQuadCache then tileQuadCache = {} end
  local quad = tileQuadCache[localIndex]
  if quad then return quad end
  local col = localIndex % columns
  local row = math.floor(localIndex / columns)
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
    -- Always straight up, never along the segment's own (possibly
    -- diagonal) normal — this surface forces the player upright
    -- regardless of slope (see Player:visualDownDirection), so the
    -- resting offset has to match or the player's CENTER jumps sideways
    -- by a chunk of pushDistance the instant a walk crosses from a flat
    -- segment (normal straight up) onto a 45-degree one (normal
    -- diagonal) or back. Since the camera tracks player.pos directly
    -- with no smoothing, that jump reads as a camera jolt.
    point = point:clone():add(Vector2.new(0, -pushDistance))
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

-- Walking-speed hook Player.lua and Ooomba.lua look for (duck-typed —
-- see Player.lua's generic isRoundedRect walking branch). Steepness is
-- binary here since every slope in this system is exactly 45 degrees by
-- construction: a segment either has a horizontal tangent (flat) or it
-- doesn't (slope).
--
-- `direction` is the caller's own signed arc-length step for this update
-- (ds for the player, ±1 for an Ooomba) — needed to tell uphill from
-- downhill, which a segment's steepness alone can't: the same sloped
-- segment is downhill walking one way along it and uphill walking the
-- other. tangent always points toward increasing arc position; its sign
-- says whether that direction climbs (tangent.y < 0, since y decreases
-- upward) or descends (tangent.y > 0). direction * tangent.y is
-- therefore positive when walking WITH that descent (downhill) and
-- negative when walking AGAINST it (uphill).
function TerrainShape:getArcSpeedMultiplier(s, direction)
  local seg = self:segmentAtArcPosition(s)
  if math.abs(seg.tangent.y) <= 0.01 then
    return 1.0
  end
  direction = direction or 1
  if direction * seg.tangent.y > 0 then
    return SLOPE_DOWNHILL_MULTIPLIER
  end
  return SLOPE_UPHILL_MULTIPLIER
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
--
-- WALL tiles get one extra check the others don't: only the TOPMOST
-- EXPOSED wall tile of a stack counts (recorded only if the cell
-- directly above it is empty). Wall tiles are routinely stacked many
-- tiles deep to fill a cliff's solid body (confirmed against
-- tiled/Level1.lua: column 14 is 8 wall tiles stacked solid, rows 14-21,
-- no gaps) — without this check, every one of those buried tiles was
-- ALSO recorded as its own walkable "floor," physically nonsensical
-- (nothing can stand where solid rock is directly overhead), and worse,
-- a buried wall tile several rows down could end up just one row away
-- from an unrelated neighboring column's real shelf, letting the
-- chain-builder connect them into a single shape with a genuine vertical
-- jump in it — since a wall-kind vertex always draws its edges flat at
-- its OWN row (see buildWorldSegments) regardless of what row it's
-- chained from, that jump became a literal straight-up segment, walked
-- via the same arc-length system as everything else, which is what made
-- a character look like they were climbing a ladder up the tile.
--
-- Flat/slope tiles do NOT get this check, deliberately — they're only
-- ever drawn one layer deep by design (a single cap over fill), so a
-- non-empty cell above one is never a sign of being buried under more
-- walkable surface; it's just ordinary terrain, like the decorative
-- overhang tiles some ledges in tiled/Level1.lua actually have directly
-- above them. Applying the wall-only check to these too briefly made
-- every such ledge silently vanish from collision despite still
-- rendering fine.
local function computeTopPointsByColumn(layer, tileProps, width, height)
  local pointsByColumn = {}
  for col = 0, width - 1 do
    local rows = {}
    for row = 0, height - 1 do
      local gid = layer.data[row * width + col + 1] -- Lua 1-based, row-major
      if gid ~= 0 then
        local role = classifyGid(tileProps, gid)
        if isTopRole(role) then
          -- Exposure check applies ONLY to "wall" — the one role that
          -- gets stacked many tiles deep. Flat/slope tiles are recorded
          -- unconditionally: they're always a single cap layer by design,
          -- so a non-empty cell directly above one is never a sign of
          -- being buried under more walkable surface — it's ordinary
          -- terrain like a decorative overhang tile (a real case in
          -- tiled/Level1.lua: some ledges have a fill tile immediately
          -- above them), and excluding those wrongly made real, walkable
          -- ledges disappear from collision entirely.
          if role ~= "wall" then
            table.insert(rows, { row = row, kind = role })
          else
            local aboveGid = row > 0 and layer.data[(row - 1) * width + col + 1] or 0
            if aboveGid == 0 then
              table.insert(rows, { row = row, kind = role })
            end
          end
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
-- off), exactly which edge is which determined by its `kind` (the tile's
-- own `slope` property — "riseLeft" and "riseRight" tiles anchor to
-- opposite neighbors and are not interchangeable). Consecutive columns'
-- shared edge always lines up exactly, so
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
    if v.kind == "riseLeft" then
      leftRow, rightRow = v.row, v.row + 1
    elseif v.kind == "riseRight" then
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
-- WallShape — a solid axis-aligned rectangle, blocking the player from
-- every side. Unlike TerrainShape (a one-way "stand on top of me"
-- surface with its own arc-length walking API), a wall has no surface to
-- walk along — it's plain circle-vs-rectangle collision, handled
-- entirely in CollisionSystem:handlePlayerWallCollisions. Just a plain
-- table (pos/halfWidth/halfHeight/radius), not a TerrainShape.
----------------------------------------------------------------------

-- Scans each row for horizontal runs of "wall"-role tiles and merges each
-- run into one wide rectangle (same "don't emit one collider per tile"
-- reasoning TerrainShape's own segment coalescing uses). Runs are NOT
-- merged vertically across rows — a tall wall becomes a stack of
-- full-width rectangles rather than one tall one — which is a deliberate
-- simplicity trade, not a correctness issue: a stack of rectangles
-- collides identically to one tall rectangle.
local function buildWallShapes(layer, tileProps, width, height, anchorX, anchorY)
  local walls = {}

  local function addWallRun(row, startCol, endCol)
    local x0 = anchorX + startCol * TILE_WORLD_SIZE
    local x1 = anchorX + (endCol + 1) * TILE_WORLD_SIZE
    local y0 = anchorY + row * TILE_WORLD_SIZE
    local y1 = anchorY + (row + 1) * TILE_WORLD_SIZE
    local halfWidth, halfHeight = (x1 - x0) / 2, (y1 - y0) / 2
    table.insert(walls, {
      pos = Vector2.new((x0 + x1) / 2, (y0 + y1) / 2),
      halfWidth = halfWidth,
      halfHeight = halfHeight,
      radius = math.sqrt(halfWidth * halfWidth + halfHeight * halfHeight),
      isWall = true,
    })
  end

  for row = 0, height - 1 do
    local runStartCol = nil
    for col = 0, width - 1 do
      local gid = layer.data[row * width + col + 1]
      local isWallTile = gid ~= 0 and classifyGid(tileProps, gid) == "wall"
      if isWallTile and not runStartCol then
        runStartCol = col
      elseif not isWallTile and runStartCol then
        addWallRun(row, runStartCol, col - 1)
        runStartCol = nil
      end
    end
    if runStartCol then addWallRun(row, runStartCol, width - 1) end
  end

  return walls
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
  local tileProps = buildTilePropertyLookup(tilesets)

  -- Collision: derive shapes from the walkable-top height profile.
  local pointsByColumn = computeTopPointsByColumn(layer, tileProps, width, height)
  local runs = buildVertexRuns(pointsByColumn, width)
  local shapes = {}
  for _, run in ipairs(runs) do
    local segments = buildWorldSegments(run, anchorX, anchorY)
    if #segments > 0 then
      table.insert(shapes, newShape(segments))
    end
  end

  -- Collision: solid walls, entirely separate from the walkable shapes
  -- above — see WallShape's own comment for why these are plain rects
  -- rather than TerrainShape instances.
  local walls = buildWallShapes(layer, tileProps, width, height, anchorX, anchorY)

  -- Rendering: bake the ENTIRE grid (fill tiles included — rendering
  -- doesn't care about the walkable/fill/wall distinction, only collision
  -- does) to one canvas, once.
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
            local columns = ts.columns or DEFAULT_TILESET_COLUMNS
            local quad = getTileQuadForLocalIndex(img, localIndex, columns)
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
    walls = walls,
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
