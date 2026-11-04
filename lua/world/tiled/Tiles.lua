-- lua/world/tiled/Tiles.lua
--
-- Tile sizes, each tile's role and slope (read from the tileset's custom
-- properties), and the quads its images are drawn from.
-- Part of the Tiled level loader: see lua/world/TiledTerrain.lua.

----------------------------------------------------------------------
-- Tunables
----------------------------------------------------------------------

local TILE_SOURCE_SIZE = 32  -- px, matches tiled/Grass Tiles.tsx
local TILE_SCALE = 2         -- each source pixel drawn 2x2
local TILE_WORLD_SIZE = TILE_SOURCE_SIZE * TILE_SCALE  -- 64 world units/tile

-- Fallback only — used if the embedded tileset def doesn't carry its own
-- `columns` field for some reason. Normally read straight off the
-- tileset data (see getTileQuadForLocalIndex), which stays correct
-- automatically as the sheet grows (it went from 2 rows to 5 without any
-- code change needed here).
local DEFAULT_TILESET_COLUMNS = 9

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
    -- Ball-tunnel pieces (see CrackedPlanetoid.lua's SHAPED_TILES):
    --   * an *Inner corner is the tunnel's wall and ceiling (or floor) at
    --     a bend: a "wall" — solid, with a walkable top — so the curve
    --     he rolls round (buildRampClimbShape) runs up its face and over
    --     it like any other wall. (Its rounded corner is only art: a
    --     square corner is what that path goes round.)
    --   * an *Outer1/2/3 arc is the outside of a bend round a crest or
    --     arch: mostly open tunnel, solid only out past its curve — so
    --     no top here (it'd be an invisible ledge in the middle of the
    --     tunnel); it's solid in its exact shape (see buildTunnelSolids).
    if slope and slope:find("Inner$") then return "wall" end
    if slope and slope:find("Outer%d$") then return "fill" end
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

return {
  TILE_SOURCE_SIZE = TILE_SOURCE_SIZE,
  TILE_SCALE = TILE_SCALE,
  TILE_WORLD_SIZE = TILE_WORLD_SIZE,
  DEFAULT_TILESET_COLUMNS = DEFAULT_TILESET_COLUMNS,
  findTileset = findTileset,
  buildTilePropertyLookup = buildTilePropertyLookup,
  classifyGid = classifyGid,
  isTopRole = isTopRole,
  getTileQuadForLocalIndex = getTileQuadForLocalIndex,
}
