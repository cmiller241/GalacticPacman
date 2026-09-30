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
local Lava = require("lua.world.Lava")

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

-- Returns "flat", "riseRight", "riseLeft", "wall", "lava", "rampRight",
-- "rampLeft", "fill", or "empty", straight from that tile's own
-- `role`/`slope` properties. Untagged or unrecognized-role tiles
-- default to "fill" (matches the sheet's own convention — undecorated
-- background dirt needs no explicit tagging).
--
-- rampRight/rampLeft are deliberately NOT isTopRole (see below) — they
-- never go through the ordinary per-column walkable-top scan at all.
-- That scan can only ever describe one floor height per column (a
-- hill/ramp profile), which caps any chain it builds at 45 degrees of
-- average rise; a ramp tile whose own art curves all the way from flat
-- ground to a vertical wall face needs more than that. See
-- buildRampClimbShape below, which builds an explicit hand-computed
-- path for these instead.
local function classifyGid(tileProps, gid)
  if gid == 0 then return "empty" end
  local props = tileProps[gid]
  local role = props and props.role
  if role == "wall" then return "wall" end
  if role == "lava" then return "lava" end
  if role == "top" then
    local slope = props.slope
    if slope == "riseLeft" or slope == "riseRight" then return slope end
    -- rampRight/rampLeft are authored as role="top" + slope="rampRight"/
    -- "rampLeft" — the same convention as the ordinary riseLeft/riseRight
    -- 45-degree slopes, not a distinct role of their own. isTopRole
    -- below deliberately does NOT recognize these two return values, so
    -- they still never enter the ordinary per-column scan despite role
    -- being "top" — see buildRampClimbShape for why they need their own
    -- shape builder instead.
    if slope == "rampRight" or slope == "rampLeft" then return slope end
    -- ceilingLeft/ceilingRight: a second curve capping a wall-climb
    -- shape's wall stack, continuing PAST vertical into a ceiling
    -- instead of stopping at a 45-degree slope — see
    -- buildRampClimbShape's own comment on the cap-curve branch. Same
    -- "not isTopRole" treatment as rampRight/rampLeft: never enters
    -- the ordinary per-column scan.
    if slope == "ceilingLeft" or slope == "ceilingRight" then return slope end
    -- crestRight/crestLeft and archRight/archLeft: the CONVEX counterpart
    -- of rampRight/rampLeft and ceilingLeft/ceilingRight — a flat TOP
    -- curving down into a wall (crest), and that wall curving further
    -- into an underside/ceiling belly (arch), like walking over and
    -- around the outside of a rounded block instead of through the
    -- inside of a tube. Same "not isTopRole" treatment — see
    -- buildConvexClimbShape.
    if slope == "crestRight" or slope == "crestLeft" then return slope end
    if slope == "archRight" or slope == "archLeft" then return slope end
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
    -- isWallFace segments (see buildRampClimbShape) are never a valid
    -- landing target — jumping straight at the wall and getting
    -- swept-crossing "caught" on it here is exactly what let a player
    -- run up the wall without ever going through the ramp, bypassing
    -- the ramp/curve entry point (and Player.lua's own isWallFace
    -- detach check) entirely. The wall's own separate WallShape (see
    -- buildWallShapes) still pushes the player out and enables an
    -- ordinary wall-jump for this exact same physical surface — this
    -- only blocks TerrainShape's own "walk up it" attachment via a
    -- direct jump; walking onto it continuously from the ramp (which
    -- never calls findLandingCrossing at all — see Player.lua's
    -- move()) is completely unaffected.
    if not seg.isWallFace then
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
    -- forceUprightJump shapes (ordinary hills/ramps) push straight up,
    -- never along the segment's own (possibly diagonal) normal — this
    -- surface forces the player upright regardless of slope (see
    -- Player:visualDownDirection), so the resting offset has to match
    -- or the player's CENTER jumps sideways by a chunk of pushDistance
    -- the instant a walk crosses from a flat segment (normal straight
    -- up) onto a 45-degree one (normal diagonal) or back. Since the
    -- camera tracks player.pos directly with no smoothing, that jump
    -- reads as a camera jolt.
    --
    -- Shapes with forceUprightJump = false (see buildRampClimbShape)
    -- push along the segment's TRUE normal instead — required for
    -- those specifically, since a shape whose orientation is meant to
    -- rotate with the surface (running up a wall, sideways-on) needs
    -- its resting offset to point sideways there too, not straight up
    -- into empty air.
    local pushDir = self.forceUprightJump and Vector2.new(0, -1) or normal
    point = point:clone():add(pushDir:multiply(pushDistance))
  end
  return { point = point, normal = normal }
end

-- excludeWallFace: skip the wall-face segment (see buildRampClimbShape)
-- when picking the nearest one. Only passed true from the LANDING path
-- (CollisionSystem:tryLandOnPlanet) — findLandingCrossing already
-- refuses to land ON the wall face itself, but without this, this
-- function's own separate nearest-segment search (used right after, to
-- turn that landing point into an arc position) could still resolve to
-- it anyway: near a corner like a ceiling cap, the wall face sits
-- geometrically close to the cap-arc/ceiling segments a player actually
-- lands on, so "nearest segment" and "the segment they landed on" can
-- disagree. Left false for the OTHER caller (CollisionSystem's
-- wall-push resync, every frame the player is shoved by touching a
-- WallShape) — that one fires legitimately while genuinely walking the
-- wall face itself, and needs to keep resolving to it.
function TerrainShape:arcPositionForWorldPoint(worldX, worldY, excludeWallFace)
  local traveled = 0
  local bestArc, bestDistSq = 0, math.huge
  for _, seg in ipairs(self.segments) do
    if not (excludeWallFace and seg.isWallFace) then
      local t, px, py = projectOntoSegment(seg, worldX, worldY)
      local ddx, ddy = worldX - px, worldY - py
      local distSq = ddx * ddx + ddy * ddy
      if distSq < bestDistSq then
        bestDistSq = distSq
        bestArc = traveled + t * seg.length
      end
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
  -- Wall-climb shapes (see buildRampClimbShape) are exempt entirely —
  -- every segment past the initial curve is steep by design (that's
  -- the whole point), so the ordinary uphill penalty below would slow
  -- the player down through practically the whole feature. This is
  -- meant to run at full, Sonic-style speed instead — see also
  -- Player.lua's own isWallClimb check, which detaches the player from
  -- these shapes entirely rather than just slowing them down further
  -- once they stop actively climbing.
  if self.isWallClimb then return 1.0 end

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
-- claimedCells (optional): a set of row*width+col keys to skip entirely
-- — used so tiles already absorbed into a ramp-climb shape (see
-- buildRampClimbShape) aren't ALSO picked up here as their own,
-- separate ordinary shape. Without this, a ramp's slope tile and the
-- flat ledge past it would exist as TWO overlapping shapes covering
-- the same physical space, and walking from the ramp-climb shape onto
-- the ordinary one they overlap with would hit the exact "fall off an
-- open path's end, briefly airborne, then re-land" sequence that
-- reads as a hop — the same mechanism a real gap between two
-- genuinely separate shapes triggers on purpose, just here from a
-- seam that shouldn't exist at all.
local function computeTopPointsByColumn(layer, tileProps, width, height, claimedCells)
  local pointsByColumn = {}
  for col = 0, width - 1 do
    local rows = {}
    for row = 0, height - 1 do
      local gid = layer.data[row * width + col + 1] -- Lua 1-based, row-major
      if gid ~= 0 and not (claimedCells and claimedCells[row * width + col]) then
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
-- point; a chain that finds no match ends and is kept. This lets several
-- stacked layers (a plateau, a shelf below it, a staircase below that)
-- all run concurrently as independent shapes instead of only ever
-- tracking the topmost one. Result: a list of vertex runs, each a list of
-- {col, row, kind} points, same shape buildWorldSegments expects (kind
-- carried straight through unchanged — it's per-tile, not derived from
-- chain adjacency).
--
-- A length-1 chain (an isolated top tile with no same-row neighbor
-- within one column on either side — e.g. a single-tile-wide pillar) is
-- kept too, not discarded: buildWorldSegments turns even one vertex into
-- a real segment (that tile's own left edge to its own right edge), so a
-- length-1 chain is a perfectly good tiny platform, not a degenerate
-- one. An earlier version discarded these (`#chain > 1`), which silently
-- left standalone single-column tops (like a thin wall pillar's cap)
-- with a solid WallShape body but NO walkable TerrainShape on top at
-- all — the player could never actually land there: CollisionSystem's
-- WallShape push-out (a plain circle-vs-rect resolution, not a "landing"
-- that sets onSurface) was all that ever touched them, so onSurface
-- stayed false and the airborne wall-slide branch kept running instead,
-- which read as the player gliding in place on top of the pillar rather
-- than standing on it.
-- A one-row height change only bridges into the SAME chain when it's an
-- authored 45-degree slope tile (riseLeft/riseRight) on at least one side.
-- Two "flat" (or "wall") tops that happen to sit one row apart — e.g. a
-- raised curb tile beside a sunken lava-floor tile, with no ramp art
-- between them — must NOT auto-connect: doing so used to splice in a
-- sheer vertical segment (the flat tile's own edge at its row, immediately
-- followed by the neighboring flat tile's edge one row off) that the
-- ordinary red walkable path then treated as a climbable "side" of the
-- curb. Real slopes are always explicitly tiled in this project (rampLeft/
-- Right, riseLeft/Right, crestLeft/Right, archLeft/Right all get their own
-- tile), so requiring an explicit rise tile to justify a delta of 1 here
-- doesn't cost any intentional terrain.
local function isRiseKind(kind)
  return kind == "riseLeft" or kind == "riseRight"
end

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
          local connects = delta == 0 or (delta == 1 and (isRiseKind(last.kind) or isRiseKind(entry.kind)))
          if connects and (not bestDelta or delta < bestDelta) then
            bestDelta = delta
            best = entry
          end
        end
      end
      if best then
        usedRow[best.row] = true
        table.insert(chain, { col = col, row = best.row, kind = best.kind })
        table.insert(newOpenChains, chain)
      else
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
    table.insert(runs, chain)
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
-- Ramp-to-wall climbs (rampRight/rampLeft)
----------------------------------------------------------------------
-- See classifyGid's own comment for why these need a shape builder of
-- their own instead of just being more "top" tiles: the ordinary
-- per-column scan above can only ever describe one floor height per
-- column (a hill/ramp profile), capping any chain it produces at 45
-- degrees of average rise — nowhere near enough for a curve that ends
-- up fully vertical. This builds one explicit, hand-computed path per
-- authored ramp tile instead: a quarter-circle arc exactly inscribed
-- in that ONE tile's own 64x64 box (matching the tile's own art,
-- confirmed against how it's actually drawn — see buildRampClimbShape
-- below for exactly which corner the arc centers on), continuing
-- straight up whatever "wall"-role stack sits directly above it, then
-- picking up one ordinary 45-degree slope tile if one caps that stack.
-- Past that point, flat ledge tiles are picked up by the ordinary scan
-- above just fine on their own — the hand-off is seamless because
-- flat ground's own normal (straight up) is identical whether this
-- shape or the ordinary ("forceUprightJump") one computed it.
--
-- forceUprightJump is explicitly turned OFF on these shapes (unlike
-- every ordinary TerrainShape) — see Player:visualDownDirection and
-- TerrainShape:worldPointAtArcPosition, both of which branch on it —
-- so orientation and the walking push-offset both follow the path's
-- true local normal instead of staying locked vertical: upright on
-- the flat approach, rotating through the curve, fully sideways
-- climbing the wall, tilting back through the slope, and upright
-- again the instant it reaches flat ground — all as a direct
-- consequence of the geometry, no special-cased snap anywhere.
--
-- The "wall"-role tiles this climbs are completely unaffected by any
-- of this — buildWallShapes still turns them into their own solid
-- rects exactly as it always has, so jumping into one from the side
-- and wall-jumping off it keeps working independently of this
-- walkable path sharing the same physical space.
----------------------------------------------------------------------

local RAMP_ARC_SEGMENTS = 10 -- straight segments approximating the quarter-circle — fine enough that the rotation (see above) reads as a smooth sweep, not a visible facet

-- Builds the full climb path for one ramp tile at (col, row). dir = 1
-- for rampRight (ledge below-left, wall above-right, path runs overall
-- left-to-right), dir = -1 for rampLeft (mirrored: ledge below-right,
-- wall above-left, path runs overall right-to-left).
--
-- The arc is centered on whichever corner of the tile's own box sits
-- on the curve's "inside" (open-air) side — top-left for rampRight,
-- top-right for rampLeft — sweeping from the tangent-HORIZONTAL point
-- (matching the flat ledge below) to the tangent-VERTICAL point
-- (matching the wall above). Its normal is derived straight from the
-- true circle center (always points TOWARD it — that's the open-air
-- side, verified directly against the geometry: the corner the arc
-- centers on is exactly the corner left empty in the tile's own art).
-- That "toward center" rule is direction-agnostic, so unlike the
-- straight wall/slope segments past the arc it needs no `dir`
-- adjustment of its own.
--
-- The straight portions (wall, and the one slope tile if present)
-- reuse the same rotate-the-tangent convention every other
-- TerrainShape segment uses (buildWorldSegments) — but mirrored by
-- `dir`, since walking rampLeft's path traverses each tile's own
-- left/right edges in the OPPOSITE order the ordinary left-to-right
-- column scan assumes, and rotating a reversed tangent by the
-- standard formula gives the reversed (wrong-side) normal unless that
-- reversal is compensated for here.
-- Returns shape, claimedCells — claimedCells is a set (row*width+col ->
-- true) of every tile this shape absorbed (wall stack, slope, and the
-- flat ledge run past it), for the caller to exclude from
-- computeTopPointsByColumn. See that function's own comment for why:
-- without this, a tile like the slope (unconditionally picked up by
-- the ordinary column scan, no exposure check the way "wall" gets)
-- would end up covered by TWO overlapping shapes, and the seam between
-- them reads as a hop.
-- Mirrors buildRampClimbShape's own "wall curving into a ceiling" cap
-- (see that function's own capRole=="ceilingLeft"/"ceilingRight" branch,
-- and buildConvexClimbShape's own arch-cap branch) turned upside down.
-- Called when a ceiling-backing run STOPS and finds a ceilingLeft/
-- ceilingRight tile one row below (see that run's own "belowGid" check)
-- that isn't already owned by some other independently-anchored ramp
-- shape. Previously the run just assumed one must exist elsewhere and
-- set continuesAtKey hoping to find it via capOwnerByKey — fine for the
-- classic "two ramps meet mid-ceiling" case, but wrong when what's
-- actually there is a ceiling dipping down into a walled archway with no
-- separate ramp anchoring it at all: nothing would ever own that key, and
-- the path would just dead-end.
--
-- This instead treats that ceilingLeft/ceilingRight tile as a genuine END
-- cap in its own right: curves DOWN off of it into a wall descending in
-- the adjacent column (wallCol = capCol + dir — exactly the relationship
-- buildRampClimbShape's own START cap uses, just discovered here instead
-- of searched for), and if that wall bottoms out onto an archLeft/
-- archRight tile, curves into that arch and starts a fresh underside run
-- past it — continuing in the SAME direction the ceiling run was already
-- traveling (this is a bridge continuing the same journey forward, unlike
-- buildConvexClimbShape's own underside run, which doubles back under a
-- single free-standing block since there's nothing beyond it to reach).
--
-- Returns nil if there's no wall-into-arch structure there at all (the
-- ordinary two-ramps-meet-directly case, where the caller's own existing
-- continuesAtKey fallback still applies unchanged) — or a table
-- describing the new points to append plus enough bookkeeping for the
-- caller to classify the new segments and know where to look for a
-- further link onward (continuesAtKey, same meaning as everywhere else in
-- this file).
--
-- startPoint: the run's own last point before it stopped — already
-- sitting exactly on this cap tile's own near corner (see the caller).
-- capRow/capCol: the ceilingLeft/ceilingRight tile's own grid position.
-- capRole: its own slope string, deciding which side the wall descends on
-- (mirrors how it decides which side a START cap's wall climbs up on).
local function tryDescendCeilingCapToArch(layer, tileProps, width, height, anchorX, anchorY, capRow, capCol, capRole, startPoint)
  local T = TILE_WORLD_SIZE
  local dirCap = (capRole == "ceilingLeft" and 1) or (capRole == "ceilingRight" and -1)
  if not dirCap then return nil end

  local wallCol = capCol + dirCap
  if wallCol < 0 or wallCol >= width then return nil end

  -- Same edge convention buildRampClimbShape's own wallEdgeX uses: the
  -- side of the wall column facing back toward the cap tile (and thus
  -- the open ceiling territory the run just came from).
  local wallEdgeX = anchorX + (dirCap > 0 and wallCol or (wallCol + 1)) * T

  -- Scan DOWNWARD (mirrors buildRampClimbShape's own upward wall search)
  -- for contiguous "wall"-role tiles starting one row below the cap.
  -- Left at capRow (a zero-height wall) when none are found — same
  -- "wall stack is entirely optional" tolerance buildConvexClimbShape's
  -- own arch-cap check already has.
  local wallBottomRow = capRow
  do
    local r = capRow + 1
    while r < height do
      local gid = layer.data[r * width + wallCol + 1]
      if gid == 0 or classifyGid(tileProps, gid) ~= "wall" then break end
      wallBottomRow = r
      r = r + 1
    end
  end

  local archRow = wallBottomRow + 1
  local archCol = wallCol
  if archRow >= height then return nil end
  local archGid = layer.data[archRow * width + archCol + 1]
  local archRole = archGid ~= 0 and classifyGid(tileProps, archGid) or "empty"
  if archRole ~= "archLeft" and archRole ~= "archRight" then return nil end

  local claimed = {}
  local newPoints = {}

  -- First arc: ceiling cap's own corner (startPoint, already sitting
  -- exactly on it) curving down to the wall's own top tangent point.
  -- Center sits directly below startPoint, one tile down — a fresh
  -- derivation (this arc runs the opposite way from buildRampClimbShape's
  -- own cap arc, ceiling into wall rather than wall into ceiling), but
  -- confirmed against the tile corners it has to land on exactly the same
  -- way that function's own header comment confirms its own arcs.
  local center1 = Vector2.new(startPoint.x, anchorY + (capRow + 1) * T)
  -- "Start" markers below all follow the same convention capArcStart/
  -- ceilingRunStart use in buildRampClimbShape itself: the index of the
  -- point BEFORE the new range begins (here, since startPoint lives in
  -- the CALLER's own points array, not in newPoints, that's simply
  -- newPoints' current length, with no adjustment) — not the first new
  -- point's own index.
  local arc1Start = #newPoints
  for i = 1, RAMP_ARC_SEGMENTS do
    local t = i / RAMP_ARC_SEGMENTS
    local theta = -math.pi / 2 + dirCap * (math.pi / 2) * t
    table.insert(newPoints, Vector2.new(center1.x + T * math.cos(theta), center1.y + T * math.sin(theta)))
  end
  local arc1End = #newPoints

  -- Wall segment (may end up zero-length, when the arch cap sits
  -- directly beneath the ceiling cap with no plain wall tile between —
  -- harmless, the segment built from it later just has zero length).
  for r = capRow + 1, wallBottomRow do
    claimed[r * width + wallCol] = true
  end
  local wallSegIndex = #newPoints
  table.insert(newPoints, Vector2.new(wallEdgeX, anchorY + (wallBottomRow + 1) * T))

  -- Second arc: wall's own bottom tangent curving into the arch tile's
  -- own underside tangent. NOT the same construction as the first arc:
  -- arc1 enters with a HORIZONTAL tangent (the ceiling run), so its
  -- center sits directly below the entry point (same x, offset in y).
  -- This arc enters with a VERTICAL tangent instead (the wall segment
  -- just above it), so the center has to be offset the OTHER way — same
  -- y as the entry point, offset by T in x — or the "radius perpendicular
  -- to tangent" relationship a circle needs doesn't hold at all.
  --
  -- It's also convex rather than concave: the wall material genuinely
  -- fills the block sitting between the two walls at this row (confirmed
  -- against the real tile data — both wall columns carry a "wall" tile at
  -- the same row here), so the center sits ON the material side, at the
  -- corner shared between this archLeft/archRight tile and its mirror
  -- image on the far side of the notch, and the curve bulges AWAY from
  -- it — hugging the visible grass edge instead of cutting a chord
  -- straight through the middle of it.
  local entry2 = newPoints[#newPoints]
  local center2 = Vector2.new(entry2.x + dirCap * T, entry2.y)
  local entryTheta2 = dirCap > 0 and math.pi or 0
  local arc2Start = #newPoints
  for i = 1, RAMP_ARC_SEGMENTS do
    local t = i / RAMP_ARC_SEGMENTS
    local theta = entryTheta2 - dirCap * (math.pi / 2) * t
    table.insert(newPoints, Vector2.new(center2.x + T * math.cos(theta), center2.y + T * math.sin(theta)))
  end
  local arc2End = #newPoints
  claimed[archRow * width + archCol] = true

  -- Underside run: stops the instant it isn't "wall"-backed anymore
  -- (exactly like every other absorption run in this file), checking for
  -- a same-row archLeft/archRight partner to hand off to via
  -- continuesAtKey the same way buildConvexClimbShape's own underside run
  -- already does — that partner is normally the mirror-image descent of
  -- whichever OTHER ceiling run is coming from the far side of this same
  -- archway, landing on the immediately adjacent arch tile.
  local runStart = #newPoints
  local continuesAtKey = nil
  local fc = archCol + dirCap
  while fc >= 0 and fc < width do
    local fgid = layer.data[archRow * width + fc + 1]
    if fgid == 0 or classifyGid(tileProps, fgid) ~= "wall" then
      if fgid ~= 0 then
        local hitRole = classifyGid(tileProps, fgid)
        if hitRole == "archLeft" or hitRole == "archRight" then
          continuesAtKey = archRow * width + fc
        end
      end
      break
    end
    claimed[archRow * width + fc] = true
    local edgeCol = dirCap > 0 and (fc + 1) or fc
    table.insert(newPoints, Vector2.new(anchorX + edgeCol * T, anchorY + (archRow + 1) * T))
    fc = fc + dirCap
  end
  return {
    points = newPoints,
    center1 = center1, arc1Start = arc1Start, arc1End = arc1End,
    wallSegIndex = wallSegIndex,
    center2 = center2, arc2Start = arc2Start, arc2End = arc2End,
    runStart = runStart,
    claimed = claimed,
    ownCapTileKey2 = archRow * width + archCol,
    continuesAtKey = continuesAtKey,
    dirCap = dirCap,
  }
end

local function buildRampClimbShape(layer, tileProps, width, height, anchorX, anchorY, col, row, dir)
  local T = TILE_WORLD_SIZE
  local x0 = anchorX + col * T
  local y0 = anchorY + row * T
  local claimedCells = {}

  local centerX = dir > 0 and x0 or (x0 + T)
  local centerY = y0
  local center = Vector2.new(centerX, centerY)

  local thetaLedge = math.pi / 2
  local thetaWall = dir > 0 and 0 or math.pi

  local points = {}
  for i = 0, RAMP_ARC_SEGMENTS do
    local t = i / RAMP_ARC_SEGMENTS
    local theta = thetaLedge + (thetaWall - thetaLedge) * t
    table.insert(points, Vector2.new(centerX + T * math.cos(theta), centerY + T * math.sin(theta)))
  end
  local arcSegmentCount = #points - 1

  -- Wall column: directly above-right (rampRight) or above-left
  -- (rampLeft) of the ramp tile, per this feature's own authoring
  -- convention (see this file's header comment / classifyGid). Walks
  -- upward counting contiguous "wall"-role tiles to find where the
  -- stack actually ends.
  local wallCol = dir > 0 and (col + 1) or (col - 1)
  local wallTopRow = nil
  do
    local r = row - 1
    while r >= 0 do
      local gid = layer.data[r * width + wallCol + 1]
      if gid == 0 or classifyGid(tileProps, gid) ~= "wall" then break end
      wallTopRow = r
      claimedCells[r * width + wallCol] = true
      r = r - 1
    end
  end

  local wallSegIndex = nil
  -- Set only when this shape's own ceiling run dips down into a wall and
  -- an archLeft/archRight cap (see tryDescendCeilingCapToArch below) —
  -- the second, symmetric set of the same bookkeeping ceilingRunStart's
  -- own cap arc gets, just one bend further along the path.
  local descentCenter1, descentArc1Start, descentArc1End = nil, nil, nil
  local descentWallSegIndex = nil
  local descentCenter2, descentArc2Start, descentArc2End = nil, nil, nil
  local descentRunStart = nil
  local descentDirCap = nil
  local secondaryCapTileKey = nil
  -- Set only when a ceilingLeft/ceilingRight cap is found below — a
  -- SECOND arc, with its own center, distinct from the base arc above.
  local capCenter, capArcStart, capArcEnd = nil, nil, nil
  -- Set only alongside a ceiling cap too — the point index the flat-run
  -- absorption starts inserting from, when (and only when) that run is
  -- the ceiling's own solid backing (absorbRole == "wall") rather than
  -- an ordinary ground-level ledge (absorbRole == "flat"). Segments from
  -- here to the end of the shape, PLUS the cap arc itself, are "the
  -- ceiling" for Player.lua's own isCeiling detach check below.
  local ceilingRunStart = nil
  -- This shape's OWN cap tile position (row*width+col), set only when a
  -- ceilingLeft/ceilingRight cap was actually built above. Exposed on
  -- the finished shape so linkAndMergeWallClimbShapes (below) can look
  -- up "which shape owns the cap tile at this grid position" when some
  -- OTHER shape's ceiling run runs straight into it.
  local ownCapTileKey = nil
  -- Set only when this shape's OWN ceiling-backing absorption run (see
  -- below) stops because it ran straight into ANOTHER wall-climb
  -- shape's cap tile, rather than a genuine gap or unrelated feature —
  -- i.e. two ramps authored to form one continuous loop, meeting
  -- mid-ceiling (see linkAndMergeWallClimbShapes). Grid position
  -- (row*width+col) of that OTHER shape's own cap tile.
  local continuesAtKey = nil

  if wallTopRow then
    local wallEdgeX = dir > 0 and (anchorX + wallCol * T) or (anchorX + (wallCol + 1) * T)
    table.insert(points, Vector2.new(wallEdgeX, anchorY + wallTopRow * T))
    -- The segment this point just closed off (from the arc's own last
    -- point to here) is THE wall face — exactly one segment, however
    -- many tiles tall the stack actually is. Recorded now, by index,
    -- rather than inferred later from steepness — the slope segment
    -- right after this is ALSO steep (nonzero tangent.y), and detach
    -- (see Player.lua's own isWallFace check) needs to apply to the
    -- wall specifically, not the curve or the slope.
    wallSegIndex = #points - 1

    -- Where the run that follows (absorbed below) starts from:
    -- directly above the wall stack, same column, ONE row up, unless a
    -- slope or ceiling cap is found (handled just below, which
    -- overrides these to wherever that cap's own "continuing" edge
    -- lands instead).
    local flatCol, flatRow = wallCol, wallTopRow - 1
    local absorbRole = "flat"  -- what the run's tiles need to classify as; "wall" once past a ceiling cap
    local absorbDir = dir      -- which way the run continues; flips (-dir) past a ceiling cap

    -- One ordinary 45-degree slope tile (same column as the wall stack,
    -- wallCol), OR a ceilingLeft/ceilingRight cap (one column BACK
    -- toward the base ramp instead — wallCol - dir — matching how the
    -- ramp tile itself sits diagonally off its own wall rather than
    -- stacked on it).
    local capRow = wallTopRow - 1
    local capCol = wallCol - dir
    if capRow >= 0 then
      local slopeGid = layer.data[capRow * width + wallCol + 1]
      local slopeRole = slopeGid ~= 0 and classifyGid(tileProps, slopeGid) or "empty"
      local ceilGid = layer.data[capRow * width + capCol + 1]
      local ceilRole = ceilGid ~= 0 and classifyGid(tileProps, ceilGid) or "empty"
      local capRole = (slopeRole == "riseLeft" or slopeRole == "riseRight") and slopeRole or ceilRole

      if capRole == "riseLeft" or capRole == "riseRight" then
        -- Reuses the exact same left/right-edge convention
        -- buildWorldSegments uses for riseLeft/riseRight, so it
        -- behaves identically to any other slope tile in the map. A
        -- slope tile's "high" edge lands at ITS OWN row (not the row
        -- above — a 45 tile's art reaches the same height as the row
        -- it's drawn in on one side), in the NEXT column over, which
        -- is where the run below actually starts from in this branch.
        claimedCells[capRow * width + wallCol] = true
        local leftRow, rightRow
        if capRole == "riseLeft" then
          leftRow, rightRow = capRow, capRow + 1
        else
          leftRow, rightRow = capRow + 1, capRow
        end
        local leftPt = Vector2.new(anchorX + wallCol * T, anchorY + leftRow * T)
        local rightPt = Vector2.new(anchorX + (wallCol + 1) * T, anchorY + rightRow * T)
        if dir > 0 then
          table.insert(points, leftPt)
          table.insert(points, rightPt)
          flatCol, flatRow = wallCol + 1, rightRow
        else
          table.insert(points, rightPt)
          table.insert(points, leftPt)
          flatCol, flatRow = wallCol, leftRow
        end

      elseif capRole == "ceilingLeft" or capRole == "ceilingRight" then
        -- Continues the wall PAST vertical into a ceiling, instead of
        -- stopping at a 45-degree slope. Unlike the base arc, this
        -- curve's center is NOT one of the cap tile's own four corners
        -- — a quarter-circle that (a) starts EXACTLY at the wall's own
        -- established climbing point (wallEdgeX, set above, already
        -- fixed) with a vertical tangent there, and (b) has the same
        -- open-air side the wall already does, only works out to a
        -- center one full tile-width off to the side, in the direction
        -- the ceiling continues (opposite `dir` — a wall climbed via
        -- rampRight naturally continues into a ceiling running back
        -- to the left, i.e. "ceilingLeft"). That center, and both ends
        -- of this arc, land exactly on this cap tile's (capCol, capRow)
        -- own corners — see the run absorption below, which starts
        -- from the far corner.
        claimedCells[capRow * width + capCol] = true
        ownCapTileKey = capRow * width + capCol
        local ccx = wallEdgeX - dir * T
        local ccy = anchorY + wallTopRow * T
        capCenter = Vector2.new(ccx, ccy)
        capArcStart = #points
        -- Continues sweeping in the SAME angular direction the base arc
        -- above was already sweeping (thetaLedge -> thetaWall) — another
        -- quarter turn past thetaWall. That sweep is -pi/2 (decreasing)
        -- for rampRight/ceilingLeft (dir>0) but +pi/2 (increasing) for
        -- rampLeft/ceilingRight (dir<0), so this has to mirror by dir
        -- the same way the base arc's own thetaWall does — a hardcoded
        -- -pi/2 here only ever swept the right way for one of the two.
        for i = 1, RAMP_ARC_SEGMENTS do
          local t = i / RAMP_ARC_SEGMENTS
          local theta = thetaWall + (thetaWall - thetaLedge) * t
          table.insert(points, Vector2.new(ccx + T * math.cos(theta), ccy + T * math.sin(theta)))
        end
        capArcEnd = #points

        -- The ceiling material is ABOVE the walkway line now, not
        -- below it — the run's own row is one above where the curve
        -- landed, and it's tagged "wall" (this project's usual
        -- solid-on-every-side role — see classifyGid), not "flat".
        -- Continues opposite the original climb direction, starting
        -- one column past the cap tile itself (capCol - dir).
        flatCol, flatRow = capCol - dir, capRow - 1
        absorbRole = "wall"
        absorbDir = -dir
      end
    end

    -- Absorb the run that follows, all the way to its TRUE end (a gap,
    -- wall, or other feature) — not just a tile or two. This shape
    -- needs to BE the complete continuation for that stretch, so
    -- nothing is left over for the ordinary scan to pick up separately
    -- (which would just relocate the seam a few tiles down instead of
    -- removing it). Same absorption loop for the ordinary ground-flat
    -- case and the ceiling case above — only which role counts as
    -- "still going" (absorbRole), which way it continues (absorbDir),
    -- and which edge of the checked row the line actually sits on
    -- differ: "flat" ground is walked ON TOP of (line at the row's own
    -- top edge, flatRow * T), while "wall" ceiling material is walked
    -- UNDER (line at the row's bottom edge, (flatRow+1) * T — the same
    -- edge the cap arc's own last point already landed on).
    if flatRow >= 0 then
      local rowEdge = (absorbRole == "wall") and (flatRow + 1) or flatRow
      if absorbRole == "wall" then ceilingRunStart = #points end
      local fc = flatCol
      while fc >= 0 and fc < width do
        local fgid = layer.data[flatRow * width + fc + 1]
        if fgid == 0 or classifyGid(tileProps, fgid) ~= absorbRole then
          -- Ceiling backing (never the ordinary ground-level "flat" run)
          -- stopping here because the tile directly BELOW this scan row
          -- is another cap tile means this shape's own ceiling run has
          -- reached exactly where a second wall-climb shape's cap
          -- begins — the two were authored to meet here and continue as
          -- one loop. Recording that cap's grid position lets
          -- linkAndMergeWallClimbShapes stitch the two shapes into a
          -- single continuous path afterward, once every shape in the
          -- level exists to look up.
          --
          -- Checks BOTH cap families, not just this shape's own
          -- (ceilingLeft/ceilingRight) — a flat ceiling run doesn't care
          -- whether the wall on the far side of the cap it reaches goes
          -- UP (another concave shape) or DOWN (a convex
          -- buildConvexClimbShape one, archLeft/archRight): both
          -- present the exact same "normal points down, now curve
          -- toward a wall" orientation where a plain run reaches them,
          -- so either is a valid splice point.
          --
          -- The two families sit on DIFFERENT rows relative to this
          -- scan, though, and checking only one misses the other: a
          -- concave cap (ceilingLeft/ceilingRight) sits ONE ROW BELOW
          -- its own backing (this shape's own convention, hence
          -- flatRow+1 below), but a convex cap (archLeft/archRight)
          -- sits at the SAME row as its own backing (see
          -- buildConvexClimbShape's own header comment) — so it shows
          -- up as the tile THIS run just broke on (fgid itself), not a
          -- neighbor row.
          if absorbRole == "wall" then
            if fgid ~= 0 then
              local sameRowRole = classifyGid(tileProps, fgid)
              if sameRowRole == "archLeft" or sameRowRole == "archRight" then
                continuesAtKey = flatRow * width + fc
              end
            end
            if not continuesAtKey then
              local belowGid = layer.data[(flatRow + 1) * width + fc + 1]
              if belowGid and belowGid ~= 0 then
                local belowRole = classifyGid(tileProps, belowGid)
                if belowRole == "ceilingLeft" or belowRole == "ceilingRight" then
                  -- Found a ceilingLeft/ceilingRight tile one row below —
                  -- rather than just hoping some OTHER independently-
                  -- anchored ramp shape already owns it (the only case
                  -- this used to handle), first try treating IT as a
                  -- genuine end cap of THIS shape: curving down into a
                  -- wall and, if one's there, an archLeft/archRight cap
                  -- beyond it (see tryDescendCeilingCapToArch's own header
                  -- comment for why a ceiling can't otherwise dip into an
                  -- archway without a separate crestLeft/crestRight tile
                  -- to anchor it). Falls back to the old behavior
                  -- (continuesAtKey pointing at this tile, hoping
                  -- capOwnerByKey resolves it) when there's genuinely no
                  -- wall/arch there — the ordinary two-ramps-meet-
                  -- directly case this function has always supported.
                  local descentCapRow = flatRow + 1
                  local descent = tryDescendCeilingCapToArch(
                    layer, tileProps, width, height, anchorX, anchorY,
                    descentCapRow, fc, belowRole, points[#points])
                  if descent then
                    local baseIndex = #points
                    for _, p in ipairs(descent.points) do
                      table.insert(points, p)
                    end
                    descentCenter1 = descent.center1
                    descentArc1Start = baseIndex + descent.arc1Start
                    descentArc1End = baseIndex + descent.arc1End
                    descentWallSegIndex = baseIndex + descent.wallSegIndex
                    descentCenter2 = descent.center2
                    descentArc2Start = baseIndex + descent.arc2Start
                    descentArc2End = baseIndex + descent.arc2End
                    descentRunStart = descent.runStart and (baseIndex + descent.runStart) or nil
                    descentDirCap = descent.dirCap
                    for key in pairs(descent.claimed) do claimedCells[key] = true end
                    secondaryCapTileKey = descent.ownCapTileKey2
                    continuesAtKey = descent.continuesAtKey
                  else
                    continuesAtKey = (flatRow + 1) * width + fc
                  end
                end
              end
            end
          end
          break
        end
        claimedCells[flatRow * width + fc] = true
        local edgeCol = absorbDir > 0 and (fc + 1) or fc
        table.insert(points, Vector2.new(anchorX + edgeCol * T, anchorY + rowEdge * T))
        fc = fc + absorbDir
      end
    end
  end

  if #points < 2 then return nil end

  local segments = {}
  for i = 1, #points - 1 do
    local a, b = points[i], points[i + 1]
    local tangent = b:subtract(a):normalize()
    local normal
    local isDescentArc1 = descentArc1Start and i >= descentArc1Start and i < descentArc1End
    local isDescentArc2 = descentArc2Start and i >= descentArc2Start and i < descentArc2End
    if i <= arcSegmentCount then
      local mid = (a + b) * 0.5
      normal = center:subtract(mid):normalize()
    elseif capArcStart and i >= capArcStart and i < capArcEnd then
      local mid = (a + b) * 0.5
      normal = capCenter:subtract(mid):normalize()
    elseif isDescentArc1 then
      local mid = (a + b) * 0.5
      normal = descentCenter1:subtract(mid):normalize()
    elseif isDescentArc2 then
      -- Convex, unlike every other arc in this file — see
      -- tryDescendCeilingCapToArch's own comment on descentCenter2: the
      -- center sits on the material side here, so the normal points AWAY
      -- from it instead of toward it.
      local mid = (a + b) * 0.5
      normal = mid:subtract(descentCenter2):normalize()
    elseif i == descentWallSegIndex then
      -- Away from the solid wall column: wallCol = capCol + descentDirCap
      -- (see tryDescendCeilingCapToArch), so the material sits on the
      -- descentDirCap side and the open-air/climbable normal points the
      -- opposite way — the vertical-mirror counterpart of the ordinary
      -- ascending wallSegIndex segment's own -dir normal.
      normal = Vector2.new(-descentDirCap, 0)
    elseif descentRunStart and i >= descentRunStart then
      -- Underside run past the arch: material's above, open air's below,
      -- regardless of which way the run travels (same reasoning
      -- buildConvexClimbShape's own underside run uses).
      normal = Vector2.new(0, 1)
    else
      normal = Vector2.new(dir * tangent.y, -dir * tangent.x)
    end
    local isCapArc = capArcStart and i >= capArcStart and i < capArcEnd
    local isCeilingRun = ceilingRunStart and i >= ceilingRunStart
    table.insert(segments, {
      a = a, b = b, tangent = tangent, normal = normal,
      length = b:subtract(a):length(),
      isWallFace = (i == wallSegIndex) or (i == descentWallSegIndex),
      -- The ceiling cap arc (the ceilingLeft/ceilingRight tile itself)
      -- AND the flat run past it (the ceiling's own solid backing) —
      -- see Player.lua's own isCeiling check, which detaches on a stop
      -- OR a reversal here (unlike the wall face, which only detaches
      -- on a reversal — standing still on a WALL is fine, standing on
      -- open ceiling with nothing but a curve holding you up isn't).
      -- The descent arcs/run (dipping into an archway mid-shape) are the
      -- same kind of "nothing but a curve holding you up" overhead
      -- surface, so they're tagged isCeiling too.
      isCeiling = isCapArc or isCeilingRun or isDescentArc1 or isDescentArc2
        or (descentRunStart and i >= descentRunStart),
    })
  end

  local shape = newShape(segments)
  shape.forceUprightJump = false
  -- See linkAndMergeWallClimbShapes below: ownCapTileKey lets another
  -- shape's ceiling run find and merge into THIS one; continuesAtKey is
  -- the reverse — set when THIS shape's own ceiling run ran into some
  -- other shape's cap. ceilingRunStartSegment marks where this shape's
  -- own absorbed ceiling backing begins (in segment-index terms, same
  -- convention isCeilingRun above already uses) — the part that gets
  -- discarded, not duplicated, when this shape is merged in as the
  -- "other" side of a seam (its own backing run would just retrace
  -- ground the first shape's run already covered from the far end).
  shape.ownCapTileKey = ownCapTileKey
  shape.continuesAtKey = continuesAtKey
  shape.ceilingRunStartSegment = ceilingRunStart
  -- Set only when this shape's own ceiling run dipped down into a wall
  -- and an archLeft/archRight cap mid-shape (see
  -- tryDescendCeilingCapToArch) — a second position this same shape can
  -- be found by (linkAndMergeWallClimbShapes registers both), and a
  -- marker telling mergeWallClimbShapes that this shape's own absorbed
  -- run (everything from ceilingRunStartSegment onward) is genuinely new
  -- geometry a merge partner needs to keep, not a redundant retrace of
  -- ground the OTHER side of the merge already covered the way a plain
  -- ceiling run meeting another ramp's cap directly would be.
  shape.secondaryCapTileKey = secondaryCapTileKey
  shape.hasDescent = secondaryCapTileKey ~= nil
  -- Marks this as a ramp-climb shape for every other system that needs
  -- to treat it differently from ordinary terrain: getArcSpeedMultiplier
  -- (no uphill penalty — this is meant to run at full speed), main.lua's
  -- Ooomba-spawning loop (skipped — see that file's own comment), and
  -- Player.lua's own move() (detaches the player if they're not
  -- actively climbing, Sonic-loop style, instead of leaving them glued
  -- to a wall regardless of input).
  shape.isWallClimb = true
  -- Arc length increases in the direction the path was swept above,
  -- which is always "toward the wall" — but which PHYSICAL key drives
  -- that depends on which side the wall is on. rampRight's wall sits to
  -- the right of its ground entry, so increasing arc length already
  -- means moving right — matching ds>0 (ArrowRight) with no help
  -- needed. rampLeft is the mirror image: its wall sits to the LEFT of
  -- its ground entry, so increasing arc length there means moving
  -- LEFT — the opposite of what ds>0 (ArrowRight) means everywhere
  -- else. Player.lua flips ds for this shape specifically so that
  -- "the key that visually walks you into the ramp" is always the one
  -- that climbs it, regardless of which way the ramp faces.
  shape.controlsReversed = dir < 0
  return shape, claimedCells
end

----------------------------------------------------------------------
-- Convex wall-climbs (crestRight/crestLeft + archRight/archLeft) — the
-- outside-of-a-rounded-block counterpart to buildRampClimbShape's own
-- inside-of-a-tube shapes above.
----------------------------------------------------------------------

-- Builds a convex wall-climb shape: a flat TOP curving DOWN into a wall
-- (crestRight/crestLeft), optionally a straight run of that wall, then
-- optionally a second curve into an underside/ceiling belly
-- (archRight/archLeft) the player walks upside-down along — like
-- walking over and around the OUTSIDE of a rounded block, rather than
-- through the INSIDE of a tube the way buildRampClimbShape's own
-- concave shapes work.
--
-- This mirrors buildRampClimbShape closely, but several things differ
-- because that's genuinely how the actual authored tile art places
-- these pieces — confirmed directly against tiled/Level1.lua's own
-- crestRight/archLeft placement (row 38/39, same column), not guessed:
--
--   - The wall continues in the SAME column as the crest tile itself,
--     not an adjacent one (concave's ramp wall sits in col+dir; this
--     one is straight down in `col`).
--   - The arch cap tile, if any, is ALSO in that same column, directly
--     below wherever the wall stack ends — not offset sideways the way
--     concave's ceiling cap is.
--   - A wall stack is entirely OPTIONAL: the arch cap can sit directly
--     beneath the crest tile with zero plain wall tiles between them
--     (that's exactly how the level's own tiles are laid out), so the
--     cap check can't be nested inside "only if a wall tile was found"
--     the way concave's is — it always runs, using whichever row comes
--     right after the wall search (found or not).
--
-- Every arc's normal points AWAY from its own center instead of toward
-- it (buildRampClimbShape's concave arcs have center on the OPEN-air
-- side; here center sits on the material side, and the player walks
-- the outside of the curve) — that's the entire concave/convex
-- difference in one sentence; everything else follows from it.
--
-- dir = 1 for crestRight (wall descends to the right of the flat top),
-- dir = -1 for crestLeft (mirrored).
local function buildConvexClimbShape(layer, tileProps, width, height, anchorX, anchorY, col, row, dir)
  local T = TILE_WORLD_SIZE
  local x0 = anchorX + col * T
  local y0 = anchorY + row * T
  local claimedCells = {}

  -- Base arc, inscribed in the crest tile's own box: center on the
  -- BOTTOM corner nearest the wall side (the corner a rounded-off sharp
  -- corner would have pivoted around), sweeping from the flat-top
  -- tangent point (normal straight up) to the wall tangent point
  -- (normal straight out sideways) — a quarter turn either way
  -- depending on dir.
  local centerX = dir > 0 and x0 or (x0 + T)
  local centerY = y0 + T
  local center = Vector2.new(centerX, centerY)

  local thetaLedge = -math.pi / 2
  local thetaWall = dir > 0 and 0 or -math.pi

  local points = {}
  for i = 0, RAMP_ARC_SEGMENTS do
    local t = i / RAMP_ARC_SEGMENTS
    local theta = thetaLedge + (thetaWall - thetaLedge) * t
    table.insert(points, Vector2.new(centerX + T * math.cos(theta), centerY + T * math.sin(theta)))
  end
  local arcSegmentCount = #points - 1

  -- Wall stack: straight down the SAME column as the crest tile (see
  -- this function's own header comment), starting one row below it.
  -- Wholly optional — see below, the cap check runs either way.
  local wallCol = col
  local wallEdgeX = dir > 0 and (x0 + T) or x0
  local wallBottomRow = nil
  do
    local r = row + 1
    while r < height do
      local gid = layer.data[r * width + wallCol + 1]
      if gid == 0 or classifyGid(tileProps, gid) ~= "wall" then break end
      wallBottomRow = r
      claimedCells[r * width + wallCol] = true
      r = r + 1
    end
  end

  local wallSegIndex = nil
  if wallBottomRow then
    table.insert(points, Vector2.new(wallEdgeX, anchorY + (wallBottomRow + 1) * T))
    wallSegIndex = #points - 1
  end

  -- Arch cap: directly below wherever the wall search stopped (right
  -- after the last wall tile, or right after the crest tile itself if
  -- there was no wall at all) — same column throughout.
  local capRow = wallBottomRow and (wallBottomRow + 1) or (row + 1)
  local capCol = col

  local capCenter, capArcStart, capArcEnd = nil, nil, nil
  local ceilingRunStart = nil
  local ownCapTileKey = nil
  local continuesAtKey = nil

  if capRow < height then
    local capGid = layer.data[capRow * width + capCol + 1]
    local capRole = capGid ~= 0 and classifyGid(tileProps, capGid) or "empty"

    if capRole == "archRight" or capRole == "archLeft" then
      claimedCells[capRow * width + capCol] = true
      ownCapTileKey = capRow * width + capCol

      -- Second arc, its own center — continues sweeping in the SAME
      -- angular direction the base arc was already sweeping, another
      -- quarter turn past thetaWall, exactly like buildRampClimbShape's
      -- own ceiling cap does. Lands, at its far end, on this arch
      -- tile's own bottom corner.
      local ccx = wallEdgeX - dir * T
      local ccy = anchorY + capRow * T
      capCenter = Vector2.new(ccx, ccy)
      capArcStart = #points
      for i = 1, RAMP_ARC_SEGMENTS do
        local t = i / RAMP_ARC_SEGMENTS
        local theta = thetaWall + (thetaWall - thetaLedge) * t
        table.insert(points, Vector2.new(ccx + T * math.cos(theta), ccy + T * math.sin(theta)))
      end
      capArcEnd = #points

      -- Underside backing: continues sideways AWAY from the crest's own
      -- climb direction, same row the arch tile itself sits in (unlike
      -- buildRampClimbShape's own ceiling run, which continues one row
      -- ABOVE its cap — the arch cap's own arc ends at ITS OWN bottom
      -- edge, not its top edge, so the matching backing row is the cap's
      -- own row, not the row above it).
      local flatRow = capRow
      local flatCol = capCol - dir
      local absorbDir = -dir
      ceilingRunStart = #points

      local fc = flatCol
      while fc >= 0 and fc < width do
        local fgid = layer.data[flatRow * width + fc + 1]
        if fgid == 0 or classifyGid(tileProps, fgid) ~= "wall" then
          -- Same idea as buildRampClimbShape's own continuesAtKey: if
          -- this run stopped because it ran straight into ANOTHER
          -- shape's own cap, record where, so linkAndMergeWallClimbShapes
          -- can stitch the two together once every shape in the level
          -- exists to look up. Checks BOTH cap families (see
          -- buildRampClimbShape's own matching comment) — the neighbor
          -- on the other end of this underside run might belong to
          -- another convex piece (archLeft/archRight) or an ordinary
          -- CONCAVE one (ceilingLeft/ceilingRight): both present the
          -- same "normal points down" orientation this run is already
          -- walking in, so either is a valid splice point.
          --
          -- The two families sit on DIFFERENT rows relative to this
          -- scan, though: THIS shape's own convex cap sits at the SAME
          -- row as its backing, so another convex cap shows up as the
          -- tile this run just broke on (fgid itself) — but a concave
          -- cap (ceilingLeft/ceilingRight) sits ONE ROW BELOW its own
          -- backing (buildRampClimbShape's own convention), so it shows
          -- up one row further down from here instead.
          if fgid ~= 0 then
            local hitRole = classifyGid(tileProps, fgid)
            if hitRole == "archRight" or hitRole == "archLeft" then
              continuesAtKey = flatRow * width + fc
            end
          end
          if not continuesAtKey then
            local belowGid = layer.data[(flatRow + 1) * width + fc + 1]
            if belowGid and belowGid ~= 0 then
              local belowRole = classifyGid(tileProps, belowGid)
              if belowRole == "ceilingLeft" or belowRole == "ceilingRight" then
                continuesAtKey = (flatRow + 1) * width + fc
              end
            end
          end
          break
        end
        claimedCells[flatRow * width + fc] = true
        local edgeCol = absorbDir > 0 and (fc + 1) or fc
        table.insert(points, Vector2.new(anchorX + edgeCol * T, anchorY + (flatRow + 1) * T))
        fc = fc + absorbDir
      end
    end
  end

  if #points < 2 then return nil end

  local segments = {}
  for i = 1, #points - 1 do
    local a, b = points[i], points[i + 1]
    local tangent = b:subtract(a):normalize()
    local normal
    if i <= arcSegmentCount then
      -- Convex: normal points AWAY from center (the material side),
      -- not toward it — the one formula flip that makes this the
      -- outside of a curve instead of the inside.
      local mid = (a + b) * 0.5
      normal = mid:subtract(center):normalize()
    elseif capArcStart and i >= capArcStart and i < capArcEnd then
      local mid = (a + b) * 0.5
      normal = mid:subtract(capCenter):normalize()
    else
      -- Straight segments (wall face, underside backing run): this
      -- formula needs no convex/concave adjustment — it already gives
      -- the correct outward normal for a wall descending on either
      -- side, same as buildRampClimbShape's own straight segments use.
      normal = Vector2.new(dir * tangent.y, -dir * tangent.x)
    end
    local isCapArc = capArcStart and i >= capArcStart and i < capArcEnd
    local isCeilingRun = ceilingRunStart and i >= ceilingRunStart
    table.insert(segments, {
      a = a, b = b, tangent = tangent, normal = normal,
      length = b:subtract(a):length(),
      isWallFace = (i == wallSegIndex),
      isCeiling = isCapArc or isCeilingRun,
    })
  end

  local shape = newShape(segments)
  shape.forceUprightJump = false
  shape.ownCapTileKey = ownCapTileKey
  shape.continuesAtKey = continuesAtKey
  shape.ceilingRunStartSegment = ceilingRunStart
  shape.isWallClimb = true
  shape.controlsReversed = dir < 0
  return shape, claimedCells
end

-- Two ramps authored to meet mid-ceiling (e.g. a rampRight climb capped
-- with ceilingLeft, whose own ceiling run stops exactly where a rampLeft
-- climb's ceilingRight cap begins — see buildRampClimbShape's own
-- continuesAtKey/ownCapTileKey comments) are, up to this point, still two
-- separate TerrainShape objects with a hard edge between them: reaching
-- the end of one's own arc length is an ordinary isOpenPath boundary,
-- which Player:move() falls off of. That's fine for a genuine dead end,
-- but wrong here — the two were drawn as one continuous loop, and gravity
-- can't carry a falling player INTO a ceiling the way it can a floor (see
-- Player.lua's own move(), the isOpenPath edge-carry comment), so a player
-- who reaches this particular kind of "edge" would just fall every time,
-- regardless of direction, instead of continuing onto the second wall the
-- art clearly promises.
--
-- Fixes that by literally splicing the two shapes into one before the
-- player ever sees either: shapeA keeps its own segments as-is, and
-- shapeB's own PRE-absorption segments (its base arc, wall, and cap arc —
-- everything up to but not including its own ceiling backing run) are
-- appended in REVERSE. Reversed, because shapeB's own arc length runs
-- ground-to-ceiling, the opposite direction shapeA is arriving from.
-- shapeB's own absorption run itself is deliberately dropped, not
-- reversed-and-kept: both shapes' ceiling runs independently absorb
-- toward each other's cap along the SAME backing row (that's how
-- shapeA's own run found shapeB's cap tile to link to in the first
-- place), so shapeB's run just retraces ground shapeA's own run already
-- covered from the far end — appending it too would double back over the
-- whole ceiling a second time instead of continuing through the wall.
local function mergeWallClimbShapes(shapeA, shapeB)
  -- shapeB.hasDescent means its own absorbed run doesn't just retrace
  -- ground shapeA's own run already covered — partway through, it turned
  -- a corner (dipped down into a wall and an archLeft/archRight cap, see
  -- tryDescendCeilingCapToArch) and is now genuinely new geometry the
  -- merge needs to keep, all the way to its own far end, not just up to
  -- ceilingRunStartSegment.
  local cut = shapeB.hasDescent and (#shapeB.segments + 1)
    or shapeB.ceilingRunStartSegment or (#shapeB.segments + 1)
  for i = cut - 1, 1, -1 do
    local seg = shapeB.segments[i]
    table.insert(shapeA.segments, {
      a = seg.b,
      b = seg.a,
      tangent = seg.tangent:clone():multiply(-1),
      normal = seg.normal,
      length = seg.length,
      isWallFace = seg.isWallFace,
      isCeiling = seg.isCeiling,
    })
  end
  shapeA.totalLength = 0
  for _, seg in ipairs(shapeA.segments) do
    shapeA.totalLength = shapeA.totalLength + seg.length
  end
end

-- Runs after every individual ramp-climb shape already exists (a shape's
-- own continuesAtKey may point at a cap tile belonging to a shape built
-- LATER in the raster scan, so this can't happen inline during that scan)
-- — looks up, for each shape whose ceiling run ran into another shape's
-- cap, that owning shape, and merges them (see mergeWallClimbShapes).
-- Loops until a full pass makes no further merges, so a shape freshly
-- extended by one merge is still eligible to be found (as either side)
-- by another — genuinely exercised now by chains longer than a single
-- pair (e.g. a wall/ceiling/wall climb, arched across to a second
-- wall/ceiling/wall climb, all one continuous loop), which is also why
-- shapeB's own continuesAtKey and cap-tile ownership both get carried
-- forward onto shapeA below after each merge, not just discarded —
-- earlier versions of this function only ever handled a single pair
-- correctly.
local function linkAndMergeWallClimbShapes(shapes)
  local capOwnerByKey = {}
  for _, shape in ipairs(shapes) do
    if shape.ownCapTileKey then capOwnerByKey[shape.ownCapTileKey] = shape end
    -- secondaryCapTileKey: this same shape's OWN dip into a wall+arch
    -- (see tryDescendCeilingCapToArch) lands on a second tile position —
    -- typically the immediately adjacent archLeft/archRight tile another
    -- shape's own mirror-image dip lands on from the far side of the same
    -- archway — findable the same way ownCapTileKey already is.
    if shape.secondaryCapTileKey then capOwnerByKey[shape.secondaryCapTileKey] = shape end
  end

  local absorbed = {}
  local mergedAny = true
  while mergedAny do
    mergedAny = false
    for _, shapeA in ipairs(shapes) do
      if not absorbed[shapeA] and shapeA.continuesAtKey then
        local shapeB = capOwnerByKey[shapeA.continuesAtKey]
        if shapeB and shapeB ~= shapeA and not absorbed[shapeB] then
          mergeWallClimbShapes(shapeA, shapeB)
          absorbed[shapeB] = true

          -- Redirect anything that still thinks shapeB owns its own cap
          -- tile to shapeA instead: shapeB's geometry now physically
          -- lives inside shapeA (see mergeWallClimbShapes), so a THIRD
          -- shape further down the path whose own continuesAtKey points
          -- at that same tile position needs to resolve to whichever
          -- shape is actually still there, not the now-absorbed one —
          -- capOwnerByKey was only ever built once, up front, and never
          -- updated as merges happen, so without this a chain longer
          -- than two shapes could never find its way past the first
          -- splice: it would look up shapeB, see it's already absorbed,
          -- and give up rather than continuing on to shapeA.
          if shapeB.ownCapTileKey then
            capOwnerByKey[shapeB.ownCapTileKey] = shapeA
          end
          if shapeB.secondaryCapTileKey then
            capOwnerByKey[shapeB.secondaryCapTileKey] = shapeA
          end

          -- Carry shapeB's own continuation forward instead of just
          -- clearing shapeA's — shapeB may ITSELF have been mid-chain
          -- (its own ceiling/underside run reaching into a THIRD
          -- shape's cap, e.g. an arch bridging to another wall-climb
          -- further along), and unconditionally clearing this after
          -- absorbing shapeB silently dropped that on the floor,
          -- capping every chain at a single pair no matter how many
          -- more pieces the level actually drew. When shapeB had no
          -- further continuation of its own, shapeB.continuesAtKey is
          -- already nil, so this still ends the chain there exactly
          -- like the old unconditional nil did.
          shapeA.continuesAtKey = shapeB.continuesAtKey

          mergedAny = true
        end
      end
    end
  end

  local result = {}
  for _, shape in ipairs(shapes) do
    if not absorbed[shape] then table.insert(result, shape) end
  end
  return result
end

-- Returns shapes, claimedCells — claimedCells merges every individual
-- shape's own claimed set (see buildRampClimbShape), for
-- TiledTerrain.load to pass into computeTopPointsByColumn.
local function buildRampShapes(layer, tileProps, width, height, anchorX, anchorY)
  local shapes = {}
  local claimedCells = {}
  for row = 0, height - 1 do
    for col = 0, width - 1 do
      local gid = layer.data[row * width + col + 1]
      if gid ~= 0 then
        local role = classifyGid(tileProps, gid)
        local dir = (role == "rampRight" and 1) or (role == "rampLeft" and -1) or nil
        local convexDir = (role == "crestRight" and 1) or (role == "crestLeft" and -1) or nil
        if dir then
          local shape, shapeClaimed = buildRampClimbShape(layer, tileProps, width, height, anchorX, anchorY, col, row, dir)
          if shape then
            table.insert(shapes, shape)
            for key in pairs(shapeClaimed) do claimedCells[key] = true end
          end
        elseif convexDir then
          local shape, shapeClaimed = buildConvexClimbShape(layer, tileProps, width, height, anchorX, anchorY, col, row, convexDir)
          if shape then
            table.insert(shapes, shape)
            for key in pairs(shapeClaimed) do claimedCells[key] = true end
          end
        end
      end
    end
  end
  shapes = linkAndMergeWallClimbShapes(shapes)
  return shapes, claimedCells
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
-- Lava — see lua/world/Lava.lua for the actual entity (shader-drawn
-- wavy surface + rising embers). One instance per lava-role tile, NOT
-- merged into multi-tile strips — Lava.lua's own wave is driven by
-- absolute world X, so independently-drawn adjacent tiles already line
-- up with each other at their shared edge with no seam; merging them
-- into wider quads would just be unneeded bookkeeping for no visual
-- difference.
----------------------------------------------------------------------

local function buildLavaTiles(layer, tileProps, width, height, anchorX, anchorY)
  local lavas = {}
  for row = 0, height - 1 do
    for col = 0, width - 1 do
      local gid = layer.data[row * width + col + 1]
      if gid ~= 0 and classifyGid(tileProps, gid) == "lava" then
        local x0 = anchorX + col * TILE_WORLD_SIZE
        local y0 = anchorY + row * TILE_WORLD_SIZE
        table.insert(lavas, Lava.new(x0, y0, TILE_WORLD_SIZE))
      end
    end
  end
  return lavas
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

  -- Ramp-to-wall climbs (rampRight/rampLeft) — built BEFORE the
  -- ordinary column scan below, so its own claimed cells (see
  -- buildRampShapes/buildRampClimbShape) can be excluded from that
  -- scan rather than being picked up twice.
  local rampShapes, rampClaimedCells = buildRampShapes(layer, tileProps, width, height, anchorX, anchorY)

  -- Collision: derive shapes from the walkable-top height profile.
  local pointsByColumn = computeTopPointsByColumn(layer, tileProps, width, height, rampClaimedCells)
  local runs = buildVertexRuns(pointsByColumn, width)
  local shapes = {}
  for _, run in ipairs(runs) do
    local segments = buildWorldSegments(run, anchorX, anchorY)
    if #segments > 0 then
      table.insert(shapes, newShape(segments))
    end
  end

  -- Appended into the same `shapes` list as the ordinary ones above,
  -- since the result is a perfectly normal TerrainShape as far as
  -- every other system (main.lua's state.planetoids, collision,
  -- drawing) is concerned — see buildRampClimbShape's own comment on
  -- shape.isWallClimb for the few places that DO need to tell it apart
  -- from ordinary terrain.
  for _, shape in ipairs(rampShapes) do
    table.insert(shapes, shape)
  end

  -- Collision: solid walls, entirely separate from the walkable shapes
  -- above — see WallShape's own comment for why these are plain rects
  -- rather than TerrainShape instances.
  local walls = buildWallShapes(layer, tileProps, width, height, anchorX, anchorY)

  -- Lava tiles — see buildLavaTiles above and lua/world/Lava.lua for
  -- the shader-drawn entity itself.
  local lavas = buildLavaTiles(layer, tileProps, width, height, anchorX, anchorY)

  -- Entity spawn points authored via Tiled's own Object Layer (see
  -- tiled/Level1.lua's "objectgroup" layer) — each object's Class field
  -- says what kind of entity it is, matched against main.lua's own spawn
  -- loops. Object x/y come out of Tiled in the tileset's own unscaled
  -- pixel space (tilewidth=32, same raw units as every gid/row/col
  -- computation above), so they need the same TILE_SCALE applied as the
  -- tile grid to land in world space alongside anchorX/anchorY.
  local ooombaSpawns = {}
  -- "Sphere" objects (see lua/world/Sphere.lua): unlike ooombaSpawns,
  -- these are never raycast onto terrain below them — the object's own
  -- x/y IS the sphere's center, since it's a freestanding gravity/landing
  -- body in open space, not something that needs to rest on a surface.
  local sphereSpawns = {}
  -- "Spikey" objects (see lua/world/Spikey.lua): same
  -- point-placement convention as sphereSpawns above — the object's own
  -- x/y IS the planetoid's center, no raycasting onto terrain below it.
  local spikeySpawns = {}
  -- "Spikey-Vertical" objects (see lua/world/SpikeyVertical.lua): same
  -- hazard, but patrols up and down within a shaft instead of sitting
  -- still. topY/bottomY are the WALL half of its patrol bounds —
  -- resolved right here via the same tile-grid scan Gate uses just
  -- below, for the same reason (needs the raw layer.data/tileProps this
  -- function has in scope). The OTHER half — clamping those bounds
  -- against any nearby static Spikey sitting in the same shaft — needs
  -- to happen in main.lua instead, once every Spikey has actually been
  -- spawned (this function only knows about the tile grid, not other
  -- entity spawns).
  local spikeyVerticalSpawns = {}
  -- "Lever" objects (see lua/world/Lever.lua): placed on the ground,
  -- same "loosely placed, snapped down onto whatever's actually below
  -- it" convention as ooombaSpawns — the raycast itself happens in
  -- main.lua's own spawn loop (it needs `terrainLevel.shapes`, which
  -- isn't fully assembled yet at this point in this function), so this
  -- is just the raw spawn point, exactly like ooombaSpawns.
  local leverSpawns = {}
  -- "Gate" objects (see lua/world/Gate.lua): a vertical barrier that
  -- spans from the nearest wall/top tile BELOW the object's own point
  -- up to the nearest wall/top tile ABOVE it — resolved right here via
  -- a plain tile-grid scan (rather than in main.lua, like Lever above)
  -- since that scan needs the raw layer.data/tileProps/classifyGid this
  -- function already has in scope, not anything from the assembled
  -- shapes/walls lists.
  local gateSpawns = {}
  local GATE_HALF_WIDTH = 16 -- world units — a thin vertical bar, not a full tile-wide wall

  -- Scans column `col` outward from `startRow` in direction `dRow`
  -- (+1 = downward/floor search, -1 = upward/ceiling search) for the
  -- nearest tile classified as "wall" or a walkable "top" (isTopRole —
  -- see that function's own comment: a wall tile's TOP counts as solid
  -- ground too, exactly the "wall or top tile" the Gate is meant to
  -- reach). Returns that tile's own row, or nil if the scan runs off
  -- the map edge without finding one.
  local function findSolidRow(col, startRow, dRow)
    local r = startRow
    while r >= 0 and r < height do
      local gid = layer.data[r * width + col + 1]
      if gid ~= 0 and isTopRole(classifyGid(tileProps, gid)) then
        return r
      end
      r = r + dRow
    end
    return nil
  end

  for _, l in ipairs(mapData.layers) do
    if l.type == "objectgroup" then
      for _, obj in ipairs(l.objects or {}) do
        if obj.class == "Ooomba" then
          table.insert(ooombaSpawns, {
            x = anchorX + obj.x * TILE_SCALE,
            y = anchorY + obj.y * TILE_SCALE,
          })
        elseif obj.class == "Sphere" then
          table.insert(sphereSpawns, {
            x = anchorX + obj.x * TILE_SCALE,
            y = anchorY + obj.y * TILE_SCALE,
          })
        elseif obj.class == "Spikey" then
          table.insert(spikeySpawns, {
            x = anchorX + obj.x * TILE_SCALE,
            y = anchorY + obj.y * TILE_SCALE,
          })
        elseif obj.class == "Lever" then
          table.insert(leverSpawns, {
            x = anchorX + obj.x * TILE_SCALE,
            y = anchorY + obj.y * TILE_SCALE,
          })
        elseif obj.class == "Gate" then
          -- obj.x/y are in the RAW, unscaled tile-pixel space (same as
          -- every gid/row/col computation in this file) — dividing by
          -- TILE_SOURCE_SIZE (not TILE_WORLD_SIZE) is what actually
          -- lands on the right row/col here, matching how classifyGid's
          -- own callers index layer.data elsewhere in this file.
          local col = math.floor(obj.x / TILE_SOURCE_SIZE)
          local row = math.floor(obj.y / TILE_SOURCE_SIZE)
          local topRow = findSolidRow(col, row, -1)
          local bottomRow = findSolidRow(col, row, 1)
          if topRow and bottomRow and bottomRow > topRow then
            table.insert(gateSpawns, {
              x = anchorX + (col + 0.5) * TILE_WORLD_SIZE,
              topY = anchorY + (topRow + 1) * TILE_WORLD_SIZE,
              bottomY = anchorY + bottomRow * TILE_WORLD_SIZE,
              halfWidth = GATE_HALF_WIDTH,
            })
          else
            -- Silent failure otherwise (no gate spawned at all) is
            -- exactly the kind of thing a level designer could spend a
            -- long time confused about — e.g. nudging the object's
            -- point a bit and having it land ON a wall/top tile instead
            -- of the open space between two of them collapses topRow
            -- and bottomRow onto the same tile (or leaves one/both nil
            -- if the scan runs off the map edge without finding solid
            -- ground at all), and this print is the only signal that
            -- happened.
            print(string.format(
              "TiledTerrain: Gate object at tile (col=%d, row=%d) failed to resolve a gate (topRow=%s, bottomRow=%s) — no gate spawned here.",
              col, row, tostring(topRow), tostring(bottomRow)))
          end
        elseif obj.class == "Spikey-Vertical" then
          -- col/row (for the wall scan below) DO need the tile-grid
          -- conversion Gate uses (obj.x/y are in the RAW, unscaled
          -- tile-pixel space) — but the entity's own world x is kept at
          -- its EXACT raw position, same convention ordinary Spikey
          -- uses just above, NOT snapped to the tile column's own
          -- center the way Gate's x is. Gate genuinely needs that snap
          -- (a wall should sit centered in its corridor tile) — a
          -- Spikey-Vertical is just a circular hazard like any other
          -- Spikey, and snapping it introduced a visible horizontal
          -- offset from a stationary Spikey placed at the exact same x
          -- in Tiled, since the two would then use different position
          -- math for what was supposed to be an identical value.
          --
          -- Only the WALL half of the patrol bounds is resolved here —
          -- topY/bottomY are left nil whenever findSolidRow doesn't
          -- find one in that direction, rather than failing the whole
          -- spawn outright: a shaft can just as validly be bounded by a
          -- nearby static Spikey instead of a wall (see this file's own
          -- spikeyVerticalSpawns comment), and this function has no way
          -- to know about other entity spawns — main.lua's own spawn
          -- wiring is what actually falls back to that, and it's the
          -- only place that can tell whether BOTH kinds of bound ended
          -- up missing on a given side.
          local col = math.floor(obj.x / TILE_SOURCE_SIZE)
          local row = math.floor(obj.y / TILE_SOURCE_SIZE)
          local topRow = findSolidRow(col, row, -1)
          local bottomRow = findSolidRow(col, row, 1)
          table.insert(spikeyVerticalSpawns, {
            x = anchorX + obj.x * TILE_SCALE,
            y = anchorY + obj.y * TILE_SCALE,
            topY = topRow and (anchorY + (topRow + 1) * TILE_WORLD_SIZE) or nil,
            bottomY = bottomRow and (anchorY + bottomRow * TILE_WORLD_SIZE) or nil,
            -- Optional per-object override — set in Tiled via a custom
            -- Float property named "speed" on this point; nil (falling
            -- back to SpikeyVertical.DEFAULT_SPEED) when not set.
            speed = obj.properties and obj.properties.speed,
          })
        end
      end
    end
  end

  -- Rendering: bake the ENTIRE grid (fill tiles included — rendering
  -- doesn't care about the walkable/fill/wall distinction, only collision
  -- does) to one canvas, once. Lava tiles are the one exception: skipped
  -- here entirely, since Lava.lua draws its own animated shader quad
  -- over that same area every frame instead — baking the sheet's own
  -- flat tile art underneath would just sit there uselessly (visible
  -- only through the shader's transparent-above-the-wave cutout, where
  -- it isn't wanted either).
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
        if gid ~= 0 and classifyGid(tileProps, gid) ~= "lava" then
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
    lavas = lavas,
    ooombaSpawns = ooombaSpawns,
    sphereSpawns = sphereSpawns,
    spikeySpawns = spikeySpawns,
    leverSpawns = leverSpawns,
    gateSpawns = gateSpawns,
    spikeyVerticalSpawns = spikeyVerticalSpawns,
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
