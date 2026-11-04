-- lua/world/CrackedPlanetoid.lua
--
-- A round planetoid made of dirt: rings of dirt clods packed round a
-- cracked, glowing core. Fireballs blow clods out, Terraria-style: every
-- clod a shot's blast square touches is gone, so holes come out square
-- and stepped. Nothing collapses — shoot sideways from the bottom of a
-- hole and you dig a cave, with its roof left standing over you. The
-- core itself can't be broken.
--
-- Clods: ring i (1 = innermost) runs from coreRadius + (i-1) *
-- CLOD_HEIGHT out to CLOD_HEIGHT further, split into as many clods as
-- fit at about CLOD_LENGTH each, every other ring shifted by half a
-- clod. Each is a slice of a ring (an "annular sector").
--
-- Collision is against the clods themselves, so caves, overhangs and
-- floating bits all work: nearestSurfacePoint finds the nearest point
-- on any solid clod (or the core), and the player gets his own
-- collision and walking here (:collidePlayer while airborne,
-- :walkPlayer while standing) — lands on floors, bumps his head on
-- ceilings, stops at walls and ledges (he jumps up them, the same as on
-- the sky dome's Tiled levels), and walks off edges.
--
-- To the rest of the game it's a non-round surface, like
-- RoundedRectPlanetoid (isRoundedRect), so gravity's reach, pull
-- targeting, fireball hits and so on go through nearestSurfacePoint /
-- distanceToSurface / containsPoint, never through .radius. (.radius is
-- the planet's full radius, which is also the furthest out it can ever
-- reach, so it's still a correct bounding circle.) isCrackedPlanet asks
-- for the things that treat it as round: gravity pulls toward its
-- center, the player stands upright to its center and jumps straight
-- out from it, and its lock-on and pull-beam outlines are circles.
--
-- It can also be built from a Tiled map (CrackedPlanetoid.fromTiledMap):
-- the map wraps round the planet, its top row the outermost ring and
-- its bottom row sitting on the core, with every row the map's full
-- width (so tiles get narrower the deeper they are). Each tile is drawn
-- with its own art from the map's tileset, at TILED_SCALE times its
-- size in the map — the same 2x the sky dome's Tiled levels use (see
-- TiledTerrain.lua's TILE_SCALE), so a 32px tile is 64 world units.
-- Any tile is solid, 0 is open — tunnels and caves are just 0s in the map.
-- A map's tiles can't be blown out by fireballs, unless the tileset gives
-- a tile a `breakable` property set to true. A tile whose `role` is
-- "water" isn't dirt at all: it's open, and starts out full of water
-- (see self.waterTiles, and WaterSystem.lua's "Water on a dirt planet").
-- (Even "fill" tiles, which on the sky dome's levels are only decoration:
-- this is solid ground you dig into.) Shaped tiles — the tileset's own
-- `slope` property, the same tiles the sky dome's levels use — are solid
-- only where their art is: riseRight/riseLeft below their 45-degree
-- diagonal (he walks up and down those), rampRight/rampLeft below a
-- concave quarter-circle that curves up into a wall, crestRight/
-- crestLeft inside a convex one that curves over from a flat top down
-- into a wall, and their undersides: ceilingLeft/ceilingRight (concave,
-- a wall curving on up into a ceiling) and archLeft/archRight (convex, a
-- wall curving under into the underside of an overhang). Running (the
-- run button held), he runs all of them Sonic-style, the same as the
-- sky dome's wall climbs (see :walkPlayer): a ramp's curve up onto the
-- wall above it, up the wall, over a crest onto the top or round a
-- ceiling cap onto the ceiling, upside down along it, round an arch
-- onto an overhang's underside — and the same the other way.
--
-- Doesn't spin or drift (always immovable), so its local frame is just
-- world space offset by pos.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local constants = require("lua.constants")
local Planetoid = require("lua.world.Planetoid")
local PlanetSurface = require("lua.world.PlanetSurface")
local Particle = require("lua.entities.Particle")
local CameraShake = require("lua.effects.CameraShake")

local CrackedPlanetoid = {}
CrackedPlanetoid.__index = CrackedPlanetoid

local TWO_PI = math.pi * 2

-- Clods, in world units: how thick each ring is, and about how long
-- each clod is along its ring (each ring rounds this to fit a whole
-- number of clods). (A Tiled map's own tile size is used instead for a
-- planet built from one.)
local CLOD_HEIGHT = 32
local CLOD_LENGTH = 44

-- The outline samples round the planet the halo and the caves' back
-- wall are drawn from (see :rebuildSilhouette).
local SILHOUETTE_SAMPLES = 512
-- (A planet built from a Tiled map gets at least this many per column,
-- so the outline follows its slopes.)
local SILHOUETTE_SAMPLES_PER_COLUMN = 8

-- How big a Tiled map's tiles are in the world, as a multiple of their
-- size in the map (see fromTiledMap).
local TILED_SCALE = 2

-- Walking (see :walkPlayer): how far below him the ground can drop away
-- while he still stays on it — only enough to keep him on it as he goes
-- round (anything more is an edge, and he walks off it and falls).
local GROUND_SNAP = 6
-- How steep a slope he walks up and down: how far he can rise or drop
-- for each unit he walks (1 = 45 degrees; a little over, so 45-degree
-- slope tiles are always walkable, and a sheer ledge never is).
local SLOPE_CLIMB = 1.25

-- Wall-running (see :walkPlayer). The tile shapes he can run onto a wall
-- from, or over the top of one, at a run...
local CURVE_SHAPES = {
  rampRight = true, rampLeft = true, crestRight = true, crestLeft = true,
  ceilingRight = true, ceilingLeft = true, archRight = true, archLeft = true,
}
-- ...how much the surface may turn under him in one step on one of
-- them (as a cosine — anything sharper is a corner, not a curve)...
local CLIMB_MAX_TURN_COS = math.cos(math.rad(35))
-- ...and anywhere else (a wall's face is straight, so only a hair —
-- what's left over where a curve's outline meets it; a plain sharp
-- corner turns far more than this, and stops him or throws him off).
local CLIMB_STRAIGHT_TURN_COS = math.cos(math.rad(9))
-- He's back on level ground, and walks normally again, once the ground
-- under him is this close to flat (as a cosine).
local LEVEL_DOT = 0.95
-- How many straight pieces a curved tile's outline is made of.
local CURVE_SEGMENTS = 12
-- How steep a surface can be (as the cosine of its angle from straight
-- up) and still count as floor he lands on, rather than a wall he
-- slides down or a ceiling he bumps.
local FLOOR_DOT = 0.55
-- How near (beyond his own radius) solid ground has to be under him for
-- him to still be standing on it.
local GROUND_SLACK = 3
-- How far he's lifted straight out, at most, if he's ended up sunk a
-- little into the ground (see :settlePlayer).
local SETTLE_MAX = 4

-- A shot's blast: a square, lined up with the way the shot was going,
-- starting at the point it hit. Every clod any part of it overlaps is
-- blown out. BLAST_REACH is how far in from the hit point it goes,
-- BLAST_HALF_WIDTH how far either side of the shot's line. It's laid
-- out along the planet's rings rather than in a straight line, so a
-- shot fired level along the ground digs a level tunnel instead of one
-- that drifts up toward the surface the further it goes.
local BLAST_REACH = 50
local BLAST_HALF_WIDTH = 26
local BLAST_SAMPLE_STEP = 6 -- how finely the square is sampled for overlapping clods
-- A shot this close to level with the ground (or to straight down or
-- up), as the sine of its angle off it, digs exactly level (or exactly
-- straight). A fireball flies straight while the ground curves away
-- under it, so one fired level along a tunnel is slightly off level by
-- the time it hits; without this, tunnels would creep up a ring.
local BLAST_SNAP = 0.38

-- The core's cracks (glowing, seen wherever the dirt is gone).
local CORE_CRACKS = 9
local CRACK_STEP = 12

-- Thrown-off dirt clumps.
local MAX_CHUNKS_PER_HIT = 40
local CHUNK_GRAVITY = 0.09   -- per frame, toward the planet's center
-- Turning (N clockwise, M counter-clockwise — see :toggleSpin): one
-- turn in this many seconds.
local SPIN_SECONDS_PER_TURN = 120
local CHUNK_BOUNCE = 0.3     -- fraction of its speed into the ground it keeps, bounced back out
local CHUNK_FRICTION = 0.7   -- sideways speed kept on each bounce
local CHUNK_LIFE_MIN = 110
local CHUNK_LIFE_RANGE = 80
local CHUNK_FADE = 30        -- frames at the end of its life it fades out over
local DUST_PER_CLOD = 2

local HIT_SHAKE_STRENGTH = 6
local HIT_SHAKE_SECONDS = 0.18

-- The baked body canvas's resolution, as a multiple of world units
-- (same 2x Planetoid.lua uses).
local BAKE_SCALE = 2
local GLOW_LAYERS = 18 -- the halo's layers (see :bake)

-- The look. Dirt's own color is the planet's `color`; these are the
-- rest of it.
local SEAM_ALPHA = 0.16        -- the faint line between two clods
local EDGE_ALPHA = 0.5         -- the darker rim wherever a clod faces open air
local BACK_WALL_SHADE = 0.32   -- how dark a dug-out cave's back wall is, as a fraction of the dirt's color
local CORE_TINT = { 0.7, 0.42, 0.34 }
local CRACK_DARK = { 0.06, 0.03, 0.02, 0.95 }
local CRACK_GLOW = { 1.0, 0.55, 0.18, 0.95 }

local function normalizeAngle(a)
  return a % TWO_PI -- (Lua's % is floored: always 0..2pi here)
end

-- The setup both ways of building one share, before its rings are
-- filled in.
local function newPlanet(x, y, coreRadius, radius, clodHeight, color)
  local self = setmetatable({}, CrackedPlanetoid)
  self.clodHeight = clodHeight
  self.pos = Vector2.new(x, y)
  self.coreRadius = coreRadius
  self.radius = radius
  self.mass = radius * radius
  self.influenceRadius = radius + constants.INFLUENCE_PADDING
  self.color = color or { 0.52, 0.36, 0.24, 1 }
  self.vel = Vector2.new(0, 0)

  self.isImmovable = true
  self.isPermanent = true
  self.isSpawnExclusion = true
  self.isSpikey = false
  self.isRoundedRect = true
  self.isCrackedPlanet = true
  -- CollisionSystem:handleImmovableCollisions reads this for every
  -- isRoundedRect immovable (only to compare against, for the sky
  -- dome's own top), so it has to be a number.
  self.halfHeight = radius
  self.rings = {}
  -- Which way things fall here (G switches it — see :cycleGravity):
  -- "core" (toward the center), "down" or "up" (straight down or up
  -- the screen, the same everywhere round the planet).
  self.gravityMode = "core"
  -- How far it's turned (radians, clockwise — see :toggleSpin), and
  -- which way it's turning (spinDir: 1 clockwise, -1 counter-clockwise,
  -- 0 not at all). Everything about the dirt is kept as it was
  -- made, unturned (its "frame"): the queries below turn the point
  -- asked about into that frame (see toFrame), and drawing turns the
  -- picture. (PortalGun reads rotationAngle too, so portals on it turn
  -- with it.)
  self.rotationAngle = 0
  self.spinDir = 0
  return self
end

-- ...and the rest, once they are.
local function finishPlanet(self)
  self.silhouette = {}
  self.silhouetteSamples = self.silhouetteSamples or SILHOUETTE_SAMPLES
  self.dirX, self.dirY = {}, {}
  for k = 1, self.silhouetteSamples do
    local a = (k - 1) / self.silhouetteSamples * TWO_PI
    self.dirX[k], self.dirY[k] = math.cos(a), math.sin(a)
  end

  self.coreCracks = {}
  self:seedCoreCracks()
  self.chunks = {}

  self.coreMesh = nil
  self.backWallMesh = nil
  self.glowMeshes = {}
  self.bodyCanvas = nil
  self.bodyCanvasPadding = Planetoid.SHADOW_PADDING
  self.needsBake = true
  self.eclipseMesh = nil

  self:rebuildSilhouette()
  return self
end

-- x, y: world center. coreRadius: the unbreakable core's radius.
-- layers: how many rings of clods round it. color: {r,g,b,a} 0..1, the
-- dirt's color.
function CrackedPlanetoid.new(x, y, coreRadius, layers, color)
  local self = newPlanet(x, y, coreRadius, coreRadius + layers * CLOD_HEIGHT, CLOD_HEIGHT, color)
  for i = 1, layers do
    local inner = coreRadius + (i - 1) * CLOD_HEIGHT
    local mid = inner + CLOD_HEIGHT / 2
    local count = math.max(6, math.floor(TWO_PI * mid / CLOD_LENGTH + 0.5))
    local step = TWO_PI / count
    local ring = {
      inner = inner, outer = inner + CLOD_HEIGHT, mid = mid,
      count = count, step = step,
      offset = (i % 2 == 0) and step / 2 or 0, -- every other ring shifted half a clod
      clods = {},
    }
    for j = 1, count do ring.clods[j] = self:newClod() end
    self.rings[i] = ring
  end
  return finishPlanet(self)
end

-- The radius a planet built from Tiled map `map` will have: the map's
-- full width, at its world size, round the outside.
function CrackedPlanetoid.tiledMapRadius(map)
  return map.width * map.tilewidth * TILED_SCALE / TWO_PI
end

-- Tiled stores a tile flipped or turned by setting the top three bits
-- of its number; this is the number without them. (The very top one is
-- "flipped left to right".)
local TILED_GID_MASK = 2 ^ 29
local TILED_FLIP_X = 2 ^ 31

-- The shaped tiles, each as the outline of its solid part across the
-- tile — u from 0 at its left edge to 1 at its right (in the map), v
-- from 0 at its bottom to 1 at its top — and how high that solid part
-- reaches at each u. (TiledTerrain.lua's own conventions for the same
-- tiles: a ramp's quarter-circle is centered on its top corner on the
-- ledge side, a crest's on its bottom corner on the wall side, a ceiling
-- cap's on its bottom corner on the ceiling side, an arch's on its top
-- corner on the underside's side.)
local function quarterArc(cu, cv, fromAngle, toAngle)
  local points = {}
  for s = 0, CURVE_SEGMENTS do
    local t = fromAngle + (toAngle - fromAngle) * s / CURVE_SEGMENTS
    points[#points + 1] = { cu + math.cos(t), cv + math.sin(t) }
  end
  return points
end
local function withCorners(before, arc, after)
  local points = {}
  for _, p in ipairs(before) do points[#points + 1] = p end
  for _, p in ipairs(arc) do points[#points + 1] = p end
  for _, p in ipairs(after) do points[#points + 1] = p end
  return points
end
local HALF_PI = math.pi / 2
local SHAPED_TILES = {
  riseRight = { outline = { { 0, 0 }, { 1, 0 }, { 1, 1 } }, top = function(u) return u end },
  riseLeft = { outline = { { 0, 0 }, { 1, 0 }, { 0, 1 } }, top = function(u) return 1 - u end },
  rampRight = { -- floor at its bottom-left, curving up to a wall at its right
    outline = withCorners({ { 0, 0 }, { 1, 0 } }, quarterArc(0, 1, 0, -HALF_PI), {}),
    top = function(u) return 1 - math.sqrt(math.max(0, 1 - u * u)) end,
  },
  rampLeft = {
    outline = withCorners({ { 0, 0 } }, quarterArc(1, 1, -HALF_PI, -math.pi), {}),
    top = function(u) return 1 - math.sqrt(math.max(0, 1 - (1 - u) ^ 2)) end,
  },
  crestRight = { -- flat top at its left, curving down to a wall at its right
    outline = withCorners({ { 0, 0 } }, quarterArc(0, 0, 0, HALF_PI), {}),
    top = function(u) return math.sqrt(math.max(0, 1 - u * u)) end,
  },
  crestLeft = {
    outline = withCorners({ { 1, 0 } }, quarterArc(1, 0, HALF_PI, math.pi), {}),
    top = function(u) return math.sqrt(math.max(0, 1 - (1 - u) ^ 2)) end,
  },
  -- The undersides. (All four reach the tile's top all the way across,
  -- so `top` is 1.)
  ceilingLeft = { -- a wall at its right curving up into a ceiling running left
    outline = withCorners({ { 1, 0 }, { 1, 1 } }, quarterArc(0, 0, HALF_PI, 0), {}),
    top = function() return 1 end,
  },
  ceilingRight = {
    outline = withCorners({ { 0, 0 }, { 0, 1 } }, quarterArc(1, 0, HALF_PI, math.pi), {}),
    top = function() return 1 end,
  },
  archRight = { -- a wall at its left curving under into an underside running right
    outline = withCorners({ { 1, 1 } }, quarterArc(1, 1, math.pi, 1.5 * math.pi), {}),
    top = function() return 1 end,
  },
  archLeft = {
    outline = withCorners({ { 0, 1 } }, quarterArc(0, 1, -HALF_PI, 0), {}),
    top = function() return 1 end,
  },
}

-- Ball tunnels: the tiles that go round the curves above, one tile
-- inside or outside them, so a tunnel one tile high (just enough for him
-- curled up as a ball — see Player's standing-room rule and
-- :standingRoomAt) keeps its height all the way round a bend.
--
--   *Inner (4): a solid tile with one corner rounded off (half a tile's
--   radius), for the INSIDE of the bend round a ramp or ceiling cap —
--   the tile diagonally inside the curve:
--     rampRightInner    up and to the left of a rampRight
--     rampLeftInner     up and to the right of a rampLeft
--     ceilingLeftInner  down and to the left of a ceilingLeft
--     ceilingRightInner down and to the right of a ceilingRight
--
--   *Outer1/2/3 (12): the big curve (two tiles' radius) round the
--   OUTSIDE of a crest or arch — three tiles each, going round from its
--   flat side to its wall side:
--     crestRightOuter1 above the crest, 2 above and to the right, 3 to its right
--     crestLeftOuter1  above the crest, 2 above and to the left,  3 to its left
--     archRightOuter1  below the arch,  2 below and to the left,  3 to its left
--     archLeftOuter1   below the arch,  2 below and to the right, 3 to its right
--
-- Each is built from one base piece (rampRightInner, crestRightOuter*),
-- mirrored left-right and/or top-bottom.
do
  local function arc(cu, cv, r, from, to, out)
    for s = 0, CURVE_SEGMENTS do
      local t = from + (to - from) * s / CURVE_SEGMENTS
      out[#out + 1] = { cu + math.cos(t) * r, cv + math.sin(t) * r }
    end
    return out
  end
  local function mirrored(points, flipU, flipV)
    local out = {}
    for k, p in ipairs(points) do
      out[k] = { flipU and 1 - p[1] or p[1], flipV and 1 - p[2] or p[2] }
    end
    return out
  end
  local function pointIn(points, u, v)
    local inside, n = false, #points
    local j = n
    for i = 1, n do
      local a, b = points[i], points[j]
      if (a[2] > v) ~= (b[2] > v) and u < (b[1] - a[1]) * (v - a[2]) / (b[2] - a[2]) + a[1] then
        inside = not inside
      end
      j = i
    end
    return inside
  end
  -- How high the solid reaches in column u (nil: none in that column).
  local function topOf(points)
    return function(u)
      u = math.min(0.999, math.max(0.001, u))
      for k = 64, 0, -1 do
        if pointIn(points, u, k / 64) then return k / 64 end
      end
      return nil
    end
  end
  local function add(name, points)
    SHAPED_TILES[name] = { outline = points, top = topOf(points), tunnel = true }
  end

  local R3 = math.sqrt(3) - 1 -- where a two-tile circle crosses a tile edge
  -- Base pieces: the corner up-left of a rampRight, and the outside of a
  -- crestRight (a circle of radius 2 round the crest's own center).
  local inner = arc(0.5, 0.5, 0.5, -HALF_PI, 0, { { 0, 0 } })
  inner[#inner + 1] = { 1, 1 }
  inner[#inner + 1] = { 0, 1 }
  local outer = {
    arc(0, -1, 2, HALF_PI, math.pi / 3, {}),                 -- 1: above the crest
    arc(-1, -1, 2, math.pi / 3, math.pi / 6, {}),            -- 2: above and beside
    arc(-1, 0, 2, math.pi / 6, 0, {}),                       -- 3: beside its wall
  }
  outer[1][#outer[1] + 1] = { 1, 1 }
  for _, p in ipairs({ { 1, 0 }, { 1, 1 }, { 0, 1 } }) do outer[2][#outer[2] + 1] = p end
  outer[3][#outer[3] + 1] = { 1, 1 }
  assert(math.abs(outer[1][#outer[1] - 1][2] - R3) < 1e-6)

  add("rampRightInner", inner)
  add("rampLeftInner", mirrored(inner, true, false))
  add("ceilingLeftInner", mirrored(inner, false, true))
  add("ceilingRightInner", mirrored(inner, true, true))
  for k = 1, 3 do
    add("crestRightOuter" .. k, outer[k])
    add("crestLeftOuter" .. k, mirrored(outer[k], true, false))
    add("archRightOuter" .. k, mirrored(outer[k], true, true))
    add("archLeftOuter" .. k, mirrored(outer[k], false, true))
    -- (Round on the tunnel's side, like a ramp: he runs them Sonic-style.)
    CURVE_SHAPES["crestRightOuter" .. k] = true
    CURVE_SHAPES["crestLeftOuter" .. k] = true
    CURVE_SHAPES["archRightOuter" .. k] = true
    CURVE_SHAPES["archLeftOuter" .. k] = true
  end
  for _, name in ipairs({ "rampRightInner", "rampLeftInner", "ceilingLeftInner", "ceilingRightInner" }) do
    CURVE_SHAPES[name] = true
  end
end

-- (Shared with lua/world/TiledTerrain.lua: the sky dome's levels use the
-- same ball-tunnel tile shapes.)
CrackedPlanetoid.SHAPED_TILES = SHAPED_TILES

-- A shaped tile's outline, bent round onto clod j of ring `ring`, as
-- local points { x1, y1, x2, y2, ... }. (Straight between its points,
-- though the tile's own edges curve with the ring — at a Tiled planet's
-- size, the difference is under a pixel.)
local function shapeOutline(ring, j, shape)
  local a0 = ring.offset + (j - 1) * ring.step
  local points = {}
  for _, p in ipairs(SHAPED_TILES[shape].outline) do
    local a = a0 + p[1] * ring.step
    local r = ring.inner + p[2] * (ring.outer - ring.inner)
    points[#points + 1] = math.cos(a) * r
    points[#points + 1] = math.sin(a) * r
  end
  return points
end

-- Which of the map's tilesets tile number `gid` comes from: the one with
-- the highest firstgid that's still no higher than it.
local function tilesetForGid(tilesets, gid)
  local best
  for _, ts in ipairs(tilesets) do
    if ts.firstgid <= gid and (not best or ts.firstgid > best.firstgid) then best = ts end
  end
  return best
end

-- x, y: world center. map: a Tiled map exported to Lua (require
-- "tiled.Level2", say); its first tile layer is wrapped round the planet,
-- column 0 starting at the very top and the columns going clockwise, so
-- the map reads left to right walking right across the top. The planet's
-- size comes from the map: its full width round the outside (see
-- CrackedPlanetoid.tiledMapRadius), its rows deep, and whatever's left
-- inside them is the core. color: {r,g,b,a}, for the back wall of dug-out
-- caves and the dirt thrown off.
function CrackedPlanetoid.fromTiledMap(x, y, map, color)
  local layer
  for _, l in ipairs(map.layers) do
    if l.type == "tilelayer" then layer = l; break end
  end
  assert(layer, "CrackedPlanetoid.fromTiledMap: the map has no tile layer")
  local w, h = layer.width, layer.height
  local tileH = map.tileheight * TILED_SCALE
  local radius = CrackedPlanetoid.tiledMapRadius(map)
  local coreRadius = radius - h * tileH
  assert(coreRadius > tileH, "CrackedPlanetoid.fromTiledMap: the map is too deep for how wide it is "
    .. "(its rows would reach past the center) - make it wider or shallower")

  local self = newPlanet(x, y, coreRadius, radius, tileH, color)
  self.isTiled = true
  self.silhouetteSamples = math.max(SILHOUETTE_SAMPLES, w * SILHOUETTE_SAMPLES_PER_COLUMN)
  self:loadTilesets(map.tilesets)

  -- Each tile number's shape (see SHAPED_TILES; nil for a whole tile),
  -- from its tileset's own `slope` property, and whether a fireball can
  -- blow it out: only if its tileset gives it a `breakable` property set
  -- to true — a map's tiles are solid ground that stays put otherwise.
  -- (And its role: "water" and "lava" tiles aren't dirt — see below.)
  -- (And whether a ground pound breaks it: a `poundable` property set to
  -- true — see :poundBreak.)
  local shapeOfGid, breakableGid, roleGid, poundableGid = {}, {}, {}, {}
  local function shapeFor(gid)
    if shapeOfGid[gid] == nil then
      local shape, breakable, role, poundable = false, false, false, false
      local ts = tilesetForGid(map.tilesets, gid)
      for _, tile in ipairs(ts and ts.tiles or {}) do
        if tile.id == gid - ts.firstgid then
          local props = tile.properties or {}
          if SHAPED_TILES[props.slope] then shape = props.slope end
          breakable = props.breakable == true or props.breakable == "true"
          poundable = props.poundable == true or props.poundable == "true"
          role = props.role or false
        end
      end
      shapeOfGid[gid], breakableGid[gid], roleGid[gid], poundableGid[gid] = shape, breakable, role, poundable
    end
    return shapeOfGid[gid] or nil, breakableGid[gid], roleGid[gid], poundableGid[gid]
  end

  -- Where the map's water tiles are: { ring = i, j = j } each — open
  -- space, filled with water when the planet's water grid is made.
  self.waterTiles = {}
  -- And its lava tiles, the same way: open space, filled with lava when
  -- the grid's made (it flows like the water — see WaterSystem.lua), as
  -- { ring, j, full (more lava on top of it) }.
  local lavaAt = {} -- [i][j] = true
  local lavaTiles = {}

  local step = TWO_PI / w
  for i = 1, h do
    local row = h - i -- (the map's own row, from 0 at its top: the top row is the outermost ring)
    local inner = coreRadius + (i - 1) * tileH
    local ring = {
      inner = inner, outer = inner + tileH, mid = inner + tileH / 2,
      count = w, step = step, offset = -math.pi / 2,
      clods = {},
    }
    for j = 1, w do
      local raw = layer.data[row * w + j] or 0
      local gid = raw % TILED_GID_MASK
      if gid ~= 0 then
        local flipX = math.floor(raw / TILED_FLIP_X) % 2 == 1
        local shape, breakable, role, poundable = shapeFor(gid)
        if role == "water" then
          self.waterTiles[#self.waterTiles + 1] = { ring = i, j = j }
        elseif role == "lava" then
          lavaAt[i] = lavaAt[i] or {}
          lavaAt[i][j] = true
          lavaTiles[#lavaTiles + 1] = { ring = i, j = j }
        else
          -- (A shaped tile flipped left to right faces the other way.)
          if shape and flipX then
            shape = shape:find("Right") and (shape:gsub("Right", "Left")) or (shape:gsub("Left", "Right"))
          end
          ring.clods[j] = { gid = gid, shade = 1, shape = shape, flipX = flipX, breakable = breakable, poundable = poundable }
          if shape then ring.clods[j].outline = shapeOutline(ring, j, shape) end
        end
      end
    end
    self.rings[i] = ring
  end

  -- (Every ring of a map has the same number of tiles, so the tile on
  -- top of tile j is tile j of the next ring out: full, if it's lava too.)
  for _, t in ipairs(lavaTiles) do
    t.full = lavaAt[t.ring + 1] and lavaAt[t.ring + 1][t.j] or false
  end
  self.lavaTiles = lavaTiles

  -- Things placed on the map's object layers (an Ooomba, say — see
  -- main.lua, which spawns them): each { class, lx, ly, properties },
  -- where it was placed, wrapped round the planet the same way as the
  -- tiles — in the planet's own frame, from its center. (Across the map
  -- is round the planet from its top, clockwise; down the map is in
  -- toward the core.)
  self.objectSpawns = {}
  local mapPixelsAround = w * map.tilewidth
  for _, l in ipairs(map.layers) do
    if l.type == "objectgroup" then
      for _, obj in ipairs(l.objects or {}) do
        local a = -math.pi / 2 + (obj.x / mapPixelsAround) * TWO_PI
        local r = radius - (obj.y / map.tileheight) * tileH
        self.objectSpawns[#self.objectSpawns + 1] = {
          class = obj.class or obj.type, lx = math.cos(a) * r, ly = math.sin(a) * r, properties = obj.properties or {},
        }
      end
    end
  end
  return finishPlanet(self)
end

-- The map's tilesets: where each one's tiles are in its image, and the
-- image itself (each loaded once, however many tilesets share it; its
-- path is written relative to tiled/, where the map lives).
function CrackedPlanetoid:loadTilesets(tilesets)
  self.tilesets = {}
  local images = {}
  for _, ts in ipairs(tilesets) do
    local entry = {
      firstgid = ts.firstgid, columns = ts.columns,
      tileW = ts.tilewidth, tileH = ts.tileheight,
      imageW = ts.imagewidth, imageH = ts.imageheight,
    }
    if love.graphics and ts.image then
      local path = ts.image
      if path:sub(1, 3) == "../" then path = path:sub(4) else path = "tiled/" .. path end
      if not images[path] then
        images[path] = love.graphics.newImage(path)
        images[path]:setFilter("nearest", "nearest")
      end
      entry.image = images[path]
      entry.imageW, entry.imageH = entry.image:getWidth(), entry.image:getHeight()
    end
    self.tilesets[#self.tilesets + 1] = entry
  end
end

-- A clod's own look, picked once: a slightly different shade from its
-- neighbors, and a few pebbles (each { along, out, size, light }: where
-- it sits across and up the clod, 0..1, its radius, and whether it's a
-- light or a dark one).
function CrackedPlanetoid:newClod()
  local pebbles = {}
  for p = 1, 2 + math.floor(math.random() * 3) do
    pebbles[p] = {
      along = 0.15 + math.random() * 0.7, out = 0.2 + math.random() * 0.6,
      size = 1.5 + math.random() * 2.5, light = math.random() < 0.4,
    }
  end
  return { shade = 0.9 + math.random() * 0.16, pebbles = pebbles, lump = math.random() * TWO_PI, breakable = true }
end

------------------------------------------------------------------
-- Clods
------------------------------------------------------------------

-- Whether local point (lx, ly) is inside outline { x1, y1, ... } (the
-- usual even-odd crossing count — it works for the ramps' hollowed-out
-- outlines as well as the rest).
local function insideOutline(outline, lx, ly)
  local inside = false
  local n = #outline
  local jx, jy = outline[n - 1], outline[n]
  for k = 1, n, 2 do
    local ix, iy = outline[k], outline[k + 1]
    if (iy > ly) ~= (jy > ly) and lx < (jx - ix) * (ly - iy) / (jy - iy) + ix then
      inside = not inside
    end
    jx, jy = ix, iy
  end
  return inside
end

-- A local point (world-aligned, from the planet's center) turned into
-- the planet's own frame, and back (see newPlanet's rotationAngle).
local function toFrame(self, lx, ly)
  local a = self.rotationAngle
  if a == 0 then return lx, ly end
  local c, s = math.cos(a), math.sin(a)
  return lx * c + ly * s, -lx * s + ly * c
end

local function fromFrame(self, fx, fy)
  local a = self.rotationAngle
  if a == 0 then return fx, fy end
  local c, s = math.cos(a), math.sin(a)
  return fx * c - fy * s, fx * s + fy * c
end

-- Which clod of ring `ring` covers angle a.
local function clodIndexAt(ring, a)
  return math.floor(normalizeAngle(a - ring.offset) / ring.step) % ring.count + 1
end

-- Clod j of ring `ring`'s angles: start, end.
local function clodAngles(ring, j)
  local a0 = ring.offset + (j - 1) * ring.step
  return a0, a0 + ring.step
end

-- The clod (ring index, clod index) at local point (lx, ly), or nil.
function CrackedPlanetoid:clodAtLocal(lx, ly)
  lx, ly = toFrame(self, lx, ly)
  local r = math.sqrt(lx * lx + ly * ly)
  if r < self.coreRadius or r >= self.radius then return nil end
  local i = math.floor((r - self.coreRadius) / self.clodHeight) + 1
  local ring = self.rings[i]
  if not ring then return nil end
  local a = math.atan2(ly, lx)
  local j = clodIndexAt(ring, a)
  local clod = ring.clods[j]
  if not clod then return nil end
  if clod.outline and not insideOutline(clod.outline, lx, ly) then
    return nil -- (outside a shaped tile's solid part: open)
  end
  return i, j
end

-- How high a shaped tile's solid part reaches at angle a, as a fraction
-- of the tile's height.
function CrackedPlanetoid:shapeTopFraction(ring, j, shape, a)
  local a0 = clodAngles(ring, j)
  local u = normalizeAngle(a - a0) / ring.step
  if u > 1 then u = 1 end
  return SHAPED_TILES[shape].top(u)
end

-- How far out ring i's solid reaches at angle a: its outside, a slope's
-- diagonal, or nil where it's open.
function CrackedPlanetoid:solidTopInRing(i, a)
  local ring = self.rings[i]
  local j = clodIndexAt(ring, a)
  local clod = ring.clods[j]
  if not clod then return nil end
  if clod.shape then
    -- (nil: this column of a ball-tunnel piece is all open.)
    local top = self:shapeTopFraction(ring, j, clod.shape, a)
    return top and ring.inner + top * (ring.outer - ring.inner)
  end
  return ring.outer
end

-- Whether ring i has solid at angle a (ring 0 is the core: always).
function CrackedPlanetoid:solidInRing(i, a)
  if i < 1 then return true end
  local ring = self.rings[i]
  if not ring then return false end
  return ring.clods[clodIndexAt(ring, a)] ~= nil
end

function CrackedPlanetoid:solidAtLocal(lx, ly)
  local r2 = lx * lx + ly * ly
  if r2 < self.coreRadius * self.coreRadius then return true end
  return self:clodAtLocal(lx, ly) ~= nil
end

-- At each sample angle, how far out the dirt reaches (its outermost
-- clod there, caves underneath or not): the outline the halo hugs and
-- the caves' back wall fills.
function CrackedPlanetoid:rebuildSilhouette()
  local n = self.silhouetteSamples
  for k = 1, n do
    local a = (k - 1) / n * TWO_PI
    local h = self.coreRadius
    for i = #self.rings, 1, -1 do
      local top = self:solidTopInRing(i, a)
      if top then h = top; break end
    end
    self.silhouette[k] = h
  end
  self.needsBake = true
end

-- How far out the dirt reaches at angle a.
function CrackedPlanetoid:silhouetteAt(a)
  local n = self.silhouetteSamples
  local k = math.floor(normalizeAngle(a) / TWO_PI * n) % n + 1
  return self.silhouette[k]
end

------------------------------------------------------------------
-- Surface geometry: the nearest point on the solid dirt (clods and
-- core) to a point.
------------------------------------------------------------------

-- The nearest point on clod j of ring `ring` (a ring slice) to local
-- point (lx, ly), whose own polar coordinates are (r, a): its x, y,
-- squared distance — or `true` if the point's inside it.
local function nearestOnClod(ring, j, lx, ly, r, a)
  local a0 = clodAngles(ring, j)
  local delta = normalizeAngle(a - a0)
  if delta <= ring.step then
    -- Within its angles: straight in or out to its inner or outer arc.
    if r < ring.inner then
      local s = ring.inner / r
      return lx * s, ly * s, (ring.inner - r) ^ 2
    elseif r > ring.outer then
      local s = ring.outer / r
      return lx * s, ly * s, (r - ring.outer) ^ 2
    end
    return true
  end
  -- Off to one side: the nearer of its two straight edges.
  local edge = (delta - ring.step < TWO_PI - delta) and (a0 + ring.step) or a0
  local ux, uy = math.cos(edge), math.sin(edge)
  local t = lx * ux + ly * uy
  if t < ring.inner then t = ring.inner elseif t > ring.outer then t = ring.outer end
  local qx, qy = ux * t, uy * t
  return qx, qy, (lx - qx) ^ 2 + (ly - qy) ^ 2
end

-- The nearest point on segment (ax, ay)-(bx, by) to (px, py): x, y,
-- squared distance.
local function nearestOnSegment(ax, ay, bx, by, px, py)
  local dx, dy = bx - ax, by - ay
  local len2 = dx * dx + dy * dy
  local t = 0
  if len2 > 1e-12 then
    t = ((px - ax) * dx + (py - ay) * dy) / len2
    if t < 0 then t = 0 elseif t > 1 then t = 1 end
  end
  local qx, qy = ax + dx * t, ay + dy * t
  return qx, qy, (px - qx) ^ 2 + (py - qy) ^ 2
end

-- The same as nearestOnClod, for a shaped tile: the nearest point on
-- its outline (see shapeOutline) — or `true` if the point's inside it.
local function nearestOnOutline(outline, lx, ly)
  if insideOutline(outline, lx, ly) then return true end
  local n = #outline
  local bx, by, bd = nil, nil, math.huge
  for k = 1, n, 2 do
    local k2 = (k + 1) % n + 1
    local qx, qy, d = nearestOnSegment(outline[k], outline[k + 1], outline[k2], outline[k2 + 1], lx, ly)
    if d < bd then bx, by, bd = qx, qy, d end
  end
  return bx, by, bd
end

-- The nearest point on solid dirt to local point (lx, ly), looking no
-- further than `reach` past where it already is (anything further only
-- comes in as the core's own edge): x, y, squared distance, whether the
-- point is inside the dirt (then the rest is meaningless), and the clod
-- that nearest point is on (nil for the core). (Point and answer in the
-- planet's own frame: see :nearestSolidLocal.)
local function nearestSolidInFrame(self, lx, ly, reach)
  local r = math.sqrt(lx * lx + ly * ly)
  if r < self.coreRadius then return 0, 0, 0, true, nil end
  local a = math.atan2(ly, lx)
  local bestX, bestY, bestD2, bestClod
  if r > 1e-9 then
    local s = self.coreRadius / r
    bestX, bestY, bestD2 = lx * s, ly * s, (r - self.coreRadius) ^ 2
  else
    bestX, bestY, bestD2 = self.coreRadius, 0, self.coreRadius ^ 2
  end

  for _, ring in ipairs(self.rings) do
    if ring.inner - reach <= r and r <= ring.outer + reach then
      local halfSpan = reach / math.max(ring.inner, 1) + ring.step
      local n = math.min(ring.count, math.ceil(2 * halfSpan / ring.step) + 1)
      local j = clodIndexAt(ring, a - halfSpan)
      for _ = 1, n do
        local clod = ring.clods[j]
        if clod then
          local qx, qy, d2
          if clod.outline then
            qx, qy, d2 = nearestOnOutline(clod.outline, lx, ly)
          else
            qx, qy, d2 = nearestOnClod(ring, j, lx, ly, r, a)
          end
          if qx == true then return 0, 0, 0, true, clod end
          if d2 < bestD2 then bestX, bestY, bestD2, bestClod = qx, qy, d2, clod end
        end
        j = j % ring.count + 1
      end
    end
  end
  return bestX, bestY, bestD2, false, bestClod
end

function CrackedPlanetoid:nearestSolidLocal(lx, ly, reach)
  local fx, fy = toFrame(self, lx, ly)
  local qx, qy, d2, inside, clod = nearestSolidInFrame(self, fx, fy, reach)
  if inside then return 0, 0, 0, true, clod end
  qx, qy = fromFrame(self, qx, qy)
  return qx, qy, d2, false, clod
end

-- How much room there is round local point (lx, ly): its distance to
-- the nearest solid dirt (0 inside it), looking about `reach` round.
function CrackedPlanetoid:clearanceLocal(lx, ly, reach)
  local _, _, d2, inside = self:nearestSolidLocal(lx, ly, reach)
  if inside then return 0 end
  return math.sqrt(d2)
end

-- From a point inside the dirt: the first open spot straight out from
-- the center (the top of whatever it's buried in).
function CrackedPlanetoid:escapeOutward(lx, ly)
  local r = math.sqrt(lx * lx + ly * ly)
  local ux, uy = 1, 0
  if r > 1e-9 then ux, uy = lx / r, ly / r end
  local a = math.atan2(uy, ux) - self.rotationAngle -- (in its own frame)
  local top = self.coreRadius
  for i = 1, #self.rings do
    local ring = self.rings[i]
    if ring.outer > r then
      top = math.max(top, ring.inner)
      if not self:solidInRing(i, a) then break end
      top = ring.outer
    end
  end
  return ux * top, uy * top, ux, uy
end

function CrackedPlanetoid:nearestSurfacePoint(worldX, worldY)
  local lx, ly = worldX - self.pos.x, worldY - self.pos.y
  local r = math.sqrt(lx * lx + ly * ly)
  local reach = math.max(0, r - self.radius) + 96
  local qx, qy, d2, inside = self:nearestSolidLocal(lx, ly, reach)
  if inside then
    local ex, ey, ux, uy = self:escapeOutward(lx, ly)
    return {
      point = Vector2.new(self.pos.x + ex, self.pos.y + ey),
      normal = Vector2.new(ux, uy),
      distance = 0,
    }
  end
  local d = math.sqrt(d2)
  local nx, ny
  if d > 1e-6 then
    nx, ny = (lx - qx) / d, (ly - qy) / d
  else
    nx, ny = (r > 1e-9) and lx / r or 1, (r > 1e-9) and ly / r or 0
  end
  return {
    point = Vector2.new(self.pos.x + qx, self.pos.y + qy),
    normal = Vector2.new(nx, ny),
    distance = d,
  }
end

-- 0 inside the dirt. Gravity asks this of every planet for every falling
-- thing, every frame, so anything well clear of the planet gets a cheap
-- answer from its center instead (anything further than
-- INFLUENCE_PADDING is out of its reach either way).
function CrackedPlanetoid:distanceToSurface(worldX, worldY)
  local lx, ly = worldX - self.pos.x, worldY - self.pos.y
  local far = math.sqrt(lx * lx + ly * ly) - self.radius
  if far > constants.INFLUENCE_PADDING + 50 then return far end
  return self:clearanceLocal(lx, ly, math.max(0, far) + 96)
end

function CrackedPlanetoid:containsPoint(worldX, worldY)
  return self:solidAtLocal(worldX - self.pos.x, worldY - self.pos.y)
end

-- The isRoundedRect "position along the surface" methods, for anything
-- generic that asks (a cannon dropping him here, say). He doesn't walk
-- by them here (see :walkPlayer), so they're just an angle round the
-- planet's outline, as a distance at its full radius.
function CrackedPlanetoid:getPerimeter()
  return TWO_PI * self.radius
end

function CrackedPlanetoid:arcPositionForWorldPoint(worldX, worldY)
  return normalizeAngle(math.atan2(worldY - self.pos.y, worldX - self.pos.x)) * self.radius
end

function CrackedPlanetoid:worldPointAtArcPosition(s, pushDistance)
  local a = s / self.radius
  local ux, uy = math.cos(a), math.sin(a)
  local r = self:silhouetteAt(a - self.rotationAngle) + (pushDistance or 0)
  return { point = Vector2.new(self.pos.x + ux * r, self.pos.y + uy * r), normal = Vector2.new(ux, uy) }
end

------------------------------------------------------------------
-- The player
------------------------------------------------------------------

-- While he's running along a wall (see :walkPlayer), the surface he's
-- on: player.climbNormal (its outward normal, local), player.climbPlanet
-- (this planet) and player.climbDir (which way he's running: 1
-- clockwise, -1 the other way), and player.climbCurved (whether that
-- surface was a curve tile's, last step). All nil the rest of the time.
local function stopClimbing(player)
  player.climbNormal, player.climbPlanet, player.climbDir, player.climbCurved = nil, nil, nil, nil
end

------------------------------------------------------------------
-- Gravity modes
------------------------------------------------------------------

CrackedPlanetoid.GRAVITY_MODES = { "core", "down", "up" }
CrackedPlanetoid.GRAVITY_LABELS = { core = "Core", down = "Down", up = "Up" }

-- "Up" at local point (lx, ly), as a unit vector: straight out from the
-- center (core), or straight up or down the screen.
function CrackedPlanetoid:upAtLocal(lx, ly)
  local mode = self.gravityMode
  if mode == "down" then return 0, -1 end
  if mode == "up" then return 0, 1 end
  local r = math.sqrt(lx * lx + ly * ly)
  if r < 1e-6 then return 0, -1 end
  return lx / r, ly / r
end

-- The same, at a world point, as a Vector2.
-- The planet surface interface (see lua/world/PlanetSurface.lua). "Up"
-- here is away from this planet's gravity, which can be switched (see
-- :cycleGravity) — not off whichever brick edge is nearest: its bricky
-- ground is all steps, so things stay upright to the way it pulls.
function CrackedPlanetoid:upAt(wx, wy)
  local ux, uy = self:upAtLocal(wx - self.pos.x, wy - self.pos.y)
  return Vector2.new(ux, uy)
end

-- Which way gravity pulls at a world point (a unit Vector2).
function CrackedPlanetoid:gravityDirAt(wx, wy)
  local ux, uy = self:upAtLocal(wx - self.pos.x, wy - self.pos.y)
  return Vector2.new(-ux, -uy)
end

CrackedPlanetoid.gravityDistance = PlanetSurface.gravityDistanceFromSurface

-- Core -> Down -> Up -> Core. If he's standing on this planet, he lets
-- go of it, to fall the new way.
function CrackedPlanetoid:cycleGravity()
  local modes = CrackedPlanetoid.GRAVITY_MODES
  local k = 1
  for i, m in ipairs(modes) do if m == self.gravityMode then k = i end end
  self.gravityMode = modes[k % #modes + 1]
  local player = state.player
  if player and player.currentPlanet == self then
    player.climbNormal, player.climbPlanet, player.climbDir, player.climbCurved = nil, nil, nil, nil
    player.onSurface = false
    player.currentPlanet = nil
    player.lastInfluencePlanet = self
    player.vel = Vector2.new(0, 0)
  end
  return self.gravityMode
end

-- How close to straight up (see :upAtLocal) local normal (nx, ny) is at
-- local point (lx, ly) (1 = a level floor, 0 = a wall, -1 = a ceiling).
local function upness(self, nx, ny, lx, ly)
  local ux, uy = self:upAtLocal(lx, ly)
  return nx * ux + ny * uy
end

-- Off the surface he was running along: airborne, carrying `vx, vy`.
local function leaveSurface(self, player, vx, vy)
  stopClimbing(player)
  player.onSurface = false
  player.currentPlanet = nil
  player.lastInfluencePlanet = self
  player.vel = Vector2.new(vx, vy)
end

local function blocked(player)
  player.isWalking = false
  player.groundMoveSpeedX = 0
end

-- Standing room. Standing up, he's taller than his round body (his
-- radius): a head circle sits on top of it, reaching about 78 units
-- above his feet. A ball-tunnel is one tile — 64 units — high, so he
-- only gets into one curled up as a ball (about 48 units), and can't
-- uncurl inside it (see Player:exitBallMode). Checked when he walks or
-- runs somewhere new (only if he has room where he is now, so he's never
-- stuck), and pushed out of ceilings in the air (see :collidePlayer).
local HEAD_OFFSET = 26   -- the head circle's center, above his own center
local HEAD_RADIUS = 22

-- Whether a standing head over local point (lx, ly), "up" being
-- (ux, uy), is clear of the dirt.
function CrackedPlanetoid:headFreeLocal(lx, ly, ux, uy)
  return self:clearanceLocal(lx + ux * HEAD_OFFSET, ly + uy * HEAD_OFFSET, HEAD_RADIUS + 8) >= HEAD_RADIUS - 0.5
end

-- Whether he has room to stand up where he is (curled up now — see
-- Player:exitBallMode): his full-size body, feet where the ball's
-- bottom is, and his head on top.
function CrackedPlanetoid:standingRoomAt(player)
  local lx, ly = player.pos.x - self.pos.x, player.pos.y - self.pos.y
  local ux, uy = self:upAtLocal(lx, ly)
  if player.climbNormal and player.climbPlanet == self then ux, uy = player.climbNormal.x, player.climbNormal.y end
  local full = player.baseRadius or player.radius
  local rise = player.onSurface and math.max(0, full - player.radius) or 0
  local cx, cy = lx + ux * rise, ly + uy * rise
  return self:clearanceLocal(cx, cy, full + 8) >= full - 0.5 and self:headFreeLocal(cx, cy, ux, uy)
end

-- Airborne: pushes him out of any dirt he's run into — off walls, down
-- from ceilings (losing the speed he had into them) — and lands him on
-- anything floor-like he comes down on. Called from
-- CollisionSystem:tryLandOnPlanet in place of its own landing; returns
-- whether he landed.
function CrackedPlanetoid:collidePlayer(player)
  local pr = player.radius
  local lx, ly = player.pos.x - self.pos.x, player.pos.y - self.pos.y
  if lx * lx + ly * ly > (self.radius + pr + 10) ^ 2 then return false end

  local landed = false
  for _ = 1, 3 do
    local qx, qy, d2, inside = self:nearestSolidLocal(lx, ly, pr + 8)
    if inside then
      -- Buried (dirt can't appear round him, so only by being thrown in
      -- hard): out on top of it.
      local ex, ey, ux, uy = self:escapeOutward(lx, ly)
      lx, ly = ex + ux * pr, ey + uy * pr
      landed = true
      break
    end
    local d = math.sqrt(d2)
    if d >= pr or d < 1e-6 then break end
    local nx, ny = (lx - qx) / d, (ly - qy) / d
    lx, ly = lx + nx * (pr - d), ly + ny * (pr - d)

    local into = player.vel.x * nx + player.vel.y * ny
    if upness(self, nx, ny, lx, ly) > FLOOR_DOT and into <= 0.5 then
      landed = true
    elseif into < 0 then
      player.vel.x = player.vel.x - nx * into
      player.vel.y = player.vel.y - ny * into
    end
  end

  -- Standing (not a ball), his head too: out from under a ceiling or a
  -- tunnel's mouth he doesn't fit into, losing the speed he had into it.
  if not player.isBall then
    local ux, uy = self:upAtLocal(lx, ly)
    for _ = 1, 2 do
      local hx, hy = lx + ux * HEAD_OFFSET, ly + uy * HEAD_OFFSET
      local qx, qy, d2, inside = self:nearestSolidLocal(hx, hy, HEAD_RADIUS + 8)
      if inside then break end
      local d = math.sqrt(d2)
      if d >= HEAD_RADIUS or d < 1e-6 then break end
      local nx, ny = (hx - qx) / d, (hy - qy) / d
      lx, ly = lx + nx * (HEAD_RADIUS - d), ly + ny * (HEAD_RADIUS - d)
      local into = player.vel.x * nx + player.vel.y * ny
      if into < 0 then
        player.vel.x = player.vel.x - nx * into
        player.vel.y = player.vel.y - ny * into
      end
    end
  end

  player.pos.x, player.pos.y = self.pos.x + lx, self.pos.y + ly
  if landed then
    stopClimbing(player)
    self:settlePlayer(player)
    player.onSurface = true
    player.currentPlanet = self
    player.lastInfluencePlanet = self
    player.surfaceArcPos = self:arcPositionForWorldPoint(player.pos.x, player.pos.y)
    player.vel = Vector2.new(0, 0)
    player.isGroundPounding = false
  end
  return landed
end

-- Standing: walks him `ds` (world units, + is clockwise on screen) round
-- the planet, along the ground he's on — up and down slopes as steep as
-- SLOPE_CLIMB. Stops at anything steeper in his way — a wall, or a ledge
-- even one tile high (he jumps up those) — and walks off an edge and
-- falls. Called from Player:move in place of its own surface walking.
--
-- Running (the run button, or rolled up as a ball), he can also run
-- walls, the way the sky dome's wall climbs work: once he's on a ramp or
-- crest tile's curve (CURVE_SHAPES), he follows the surface itself (see
-- :runAlongSurface) — up the curve onto the wall above it, up the wall,
-- over a crest onto the top, or the same the other way — until he's on
-- level ground again. On a wall or ceiling, stopping, letting go of run
-- or turning back peels him off it.
function CrackedPlanetoid:walkPlayer(player, ds)
  local running = state.gamepadRunHeld or player.isBall
  if player.climbPlanet ~= self then stopClimbing(player) end

  if player.climbNormal then
    local lx, ly = player.pos.x - self.pos.x, player.pos.y - self.pos.y
    local n = player.climbNormal
    local dir = (ds > 0 and 1) or (ds < 0 and -1) or 0
    local steep = upness(self, n.x, n.y, lx, ly) < FLOOR_DOT
    if steep and (dir == 0 or not running or (player.climbDir and dir ~= player.climbDir)) then
      local push = player.wallClimbDetachPush or 3
      leaveSurface(self, player, n.x * push, n.y * push)
      return
    end
    if dir == 0 then return end
    if running then
      player.climbDir = dir
      self:runAlongSurface(player, ds)
      return
    end
    stopClimbing(player) -- (stopped running somewhere floor-like: walks normally)
  end

  if ds == 0 then return end
  self:settlePlayer(player)
  local pr = player.radius
  local lx, ly = player.pos.x - self.pos.x, player.pos.y - self.pos.y
  local r = math.sqrt(lx * lx + ly * ly)
  if r < 1e-6 then return end

  -- Running onto a ramp's or crest's curve: from here, he follows it.
  if running then
    local qx, qy, d2, inside, clod = self:nearestSolidLocal(lx, ly, pr + 8)
    local d = math.sqrt(d2)
    if not inside and clod and CURVE_SHAPES[clod.shape] and d < pr + GROUND_SNAP and d > 1e-6 then
      player.climbNormal = { x = (lx - qx) / d, y = (ly - qy) / d }
      player.climbPlanet = self
      player.climbDir = ds > 0 and 1 or -1
      player.climbCurved = true
      self:runAlongSurface(player, ds)
      return
    end
  end

  local climb = math.abs(ds) * SLOPE_CLIMB + 1
  local reach = pr + GROUND_SNAP + climb + 8
  -- Standing, his head has to fit too (see :headFreeLocal) — as long as
  -- it does where he is now (so he's never stuck somewhere low).
  local checkHead = not player.isBall and self:headFreeLocal(lx, ly, self:upAtLocal(lx, ly))
  local function free(x, y)
    if self:clearanceLocal(x, y, reach) < pr - 0.5 then return false end
    if checkHead then return self:headFreeLocal(x, y, self:upAtLocal(x, y)) end
    return true
  end

  -- Round the planet at the same height first (or, when gravity's
  -- straight down or up the screen, straight along it).
  local ux, uy, nx, ny
  if self.gravityMode == "down" or self.gravityMode == "up" then
    ux, uy = self:upAtLocal(lx, ly)
    nx, ny = lx - uy * ds, ly + ux * ds
  else
    local a = math.atan2(ly, lx) + ds / r
    ux, uy = math.cos(a), math.sin(a)
    nx, ny = ux * r, uy * r
  end

  if not free(nx, ny) then
    -- Something's in the way: up it, if it's a slope he can walk up (by
    -- as little as gets him clear) — otherwise he stays put.
    local lifted, h = false, 0.5
    while h <= climb do
      if free(nx + ux * h, ny + uy * h) then
        nx, ny, lifted = nx + ux * h, ny + uy * h, true
        break
      end
      h = h + 0.5
    end
    if not lifted then
      blocked(player)
      return
    end
  end

  -- Down onto the ground: in 4-unit steps to find it, then halved in
  -- to rest right on it.
  local step, drop, found = 4, 0, false
  while drop < GROUND_SNAP + climb do
    if not free(nx - ux * (drop + step), ny - uy * (drop + step)) then found = true; break end
    drop = drop + step
  end
  if found then
    local lo, hi = drop, drop + step
    for _ = 1, 5 do
      local mid = (lo + hi) / 2
      if free(nx - ux * mid, ny - uy * mid) then lo = mid else hi = mid end
    end
    nx, ny = nx - ux * lo, ny - uy * lo
    player.pos.x, player.pos.y = self.pos.x + nx, self.pos.y + ny
  else
    -- Walked off an edge: on he goes, falling, carrying his pace.
    player.pos.x, player.pos.y = self.pos.x + nx, self.pos.y + ny
    local carry = ds * (player.edgeFallCarryFraction or 0.5)
    leaveSurface(self, player, -uy * carry, ux * carry)
  end
end

-- Wall-running: moves him `ds` along the surface he's on (its tangent,
-- the way he's running), then back onto it — pressed against it along
-- its own normal, whichever way that points. A curve tile's surface may
-- turn under him (up to CLIMB_MAX_TURN_COS a step), and so may the step
-- where he comes off one onto what it leads to (the wall a ramp curves
-- up into, the top a crest curves over onto — he's touching that
-- corner while his feet are still on the curve); anywhere else it may
-- barely turn at all, so a plain sharp corner either stops him (one he'd
-- run into) or throws him off it (one he'd run over the edge of). Back on
-- level ground, he walks normally again.
function CrackedPlanetoid:runAlongSurface(player, ds)
  local pr = player.radius
  local lx, ly = player.pos.x - self.pos.x, player.pos.y - self.pos.y
  local n = player.climbNormal
  -- (Clockwise along a surface with outward normal n is (-n.y, n.x) —
  -- on level ground, the same way walking right goes.)
  local tx, ty = -n.y, n.x
  local cx, cy = lx + tx * ds, ly + ty * ds
  local qx, qy, d2, inside, clod = self:nearestSolidLocal(cx, cy, pr + math.abs(ds) * 2 + 16)
  if inside then blocked(player); return end
  local d = math.sqrt(d2)

  local function launch()
    player.pos.x, player.pos.y = self.pos.x + cx, self.pos.y + cy
    leaveSurface(self, player, tx * ds, ty * ds)
  end
  if d > pr + math.abs(ds) + GROUND_SNAP or d < 1e-6 then launch(); return end

  local mx, my = (cx - qx) / d, (cy - qy) / d
  local turn = mx * n.x + my * n.y
  local curved = clod and CURVE_SHAPES[clod.shape]
  local mayTurn = curved or player.climbCurved
  -- (Turning INTO a curve — a ramp or a ceiling cap — he can take any
  -- bend: deep down, where the tiles are narrower, a curve can be
  -- tighter than he is wide, and he touches both its ends at once.)
  local intoCurve = mayTurn and d <= pr
  if turn < (mayTurn and CLIMB_MAX_TURN_COS or CLIMB_STRAIGHT_TURN_COS) and not intoCurve then
    -- A corner, not a curve.
    if d > pr then launch() else blocked(player) end
    return
  end

  -- Onto the surface, pressed against it — and pushed out of anything
  -- else he's now touching too (both sides of a curve tighter than he
  -- is wide), the way a ball rolls through a tight corner.
  local px, py = qx + mx * pr, qy + my * pr
  for _ = 1, 4 do
    local q2x, q2y, e2, inside2 = self:nearestSolidLocal(px, py, pr + 8)
    if inside2 then blocked(player); return end
    local e = math.sqrt(e2)
    if e >= pr - 0.25 or e < 1e-6 then break end
    px, py = px + (px - q2x) / e * (pr - e), py + (py - q2y) / e * (pr - e)
  end
  if self:clearanceLocal(px, py, pr + 8) < pr - 0.5 then blocked(player); return end
  -- Standing, his head has to fit there too (see :headFreeLocal), if it
  -- does where he is now.
  if not player.isBall and self:headFreeLocal(lx, ly, n.x, n.y) and not self:headFreeLocal(px, py, mx, my) then
    blocked(player); return
  end
  -- (And it has to have got him somewhere: wedged, he stays put.)
  local progress = ((px - lx) * tx + (py - ly) * ty) * (ds > 0 and 1 or -1)
  if progress < 0.05 * math.abs(ds) then blocked(player); return end
  -- The surface he's on now is whatever's nearest him there.
  do
    local fx, fy, f2, _, fclod = self:nearestSolidLocal(px, py, pr + 8)
    local f = math.sqrt(f2)
    if f > 1e-6 then mx, my = (px - fx) / f, (py - fy) / f end
    curved = fclod and CURVE_SHAPES[fclod.shape]
  end
  player.pos.x, player.pos.y = self.pos.x + px, self.pos.y + py
  player.climbNormal = { x = mx, y = my }
  player.climbCurved = curved
  if not curved and upness(self, mx, my, px, py) > LEVEL_DOT then stopClimbing(player) end
end

-- If he's sunk a fraction into the ground (pushed out of it to within a
-- hair, then nudged back by something else), lifts him straight out —
-- off the wall he's running along, if he is — until he's clear;
-- otherwise walking would take the ground he's standing in for a wall,
-- and stop him dead.
function CrackedPlanetoid:settlePlayer(player)
  local pr = player.radius
  local lx, ly = player.pos.x - self.pos.x, player.pos.y - self.pos.y
  local ux, uy = self:upAtLocal(lx, ly)
  if player.climbNormal and player.climbPlanet == self then ux, uy = player.climbNormal.x, player.climbNormal.y end
  local lift = 0
  while lift < SETTLE_MAX and self:clearanceLocal(lx + ux * lift, ly + uy * lift, pr + 8) < pr - 0.25 do
    lift = lift + 0.25
  end
  if lift > 0 and lift < SETTLE_MAX then
    player.pos.x, player.pos.y = self.pos.x + lx + ux * lift, self.pos.y + ly + uy * lift
  end
end

-- The dirt just changed: if he's standing on this planet (or running
-- along one of its walls) and the ground under him is gone, he falls.
function CrackedPlanetoid:refitPlayer()
  local player = state.player
  if not (player and player.onSurface and player.currentPlanet == self) then return end
  local lx, ly = player.pos.x - self.pos.x, player.pos.y - self.pos.y
  local ux, uy = self:upAtLocal(lx, ly)
  if player.climbNormal and player.climbPlanet == self then ux, uy = player.climbNormal.x, player.climbNormal.y end
  local below = GROUND_SLACK + constants.SURFACE_TOLERANCE
  if self:clearanceLocal(lx - ux * below, ly - uy * below, player.radius + 8) >= player.radius - 0.5 then
    leaveSurface(self, player, 0, 0)
  end
end

------------------------------------------------------------------
-- Obsidian
------------------------------------------------------------------

-- Whether the ground right under him is an ice tile (see :setBlock):
-- he slides on it (see Player:move).
function CrackedPlanetoid:iceUnder(player)
  local lx, ly = player.pos.x - self.pos.x, player.pos.y - self.pos.y
  local ux, uy = self:upAtLocal(lx, ly)
  if player.climbNormal and player.climbPlanet == self then ux, uy = player.climbNormal.x, player.climbNormal.y end
  local d = player.radius + 6
  local i, j = self:clodAtLocal(lx - ux * d, ly - uy * d)
  return i ~= nil and self.rings[i].clods[j].ice == true
end

-- The ground under a point (fx, fy) in its own frame (see objectSpawns):
-- how far out from the center its top is, straight down from there
-- toward the center — or nil if there's nothing under it but the core.
function CrackedPlanetoid:floorBelow(fx, fy)
  local r = math.sqrt(fx * fx + fy * fy)
  if r < 1e-6 then return nil end
  local ux, uy = fx / r, fy / r
  local a = self.rotationAngle
  local c, s = math.cos(a), math.sin(a)
  local function solid(rr)
    local x, y = ux * rr, uy * rr
    return self:solidAtLocal(x * c - y * s, x * s + y * c)
  end
  -- (Out of anything it's buried in first, then down to the ground.)
  while r < self.radius and solid(r) do r = r + 2 end
  while r > self.coreRadius do
    if solid(r - 1) then return r end
    r = r - 2
  end
  return self.coreRadius
end

-- A path for something to walk round the planet along ground whose top is
-- radius R out (an Ooomba — see Ooomba.newOnCrackedPlanet), in the same
-- shape as a TerrainShape (getPerimeter, worldPointAtArcPosition), arc
-- position s going clockwise round from the planet's own angle 0 (in its
-- frame — it turns with the planet). canWalkTo says whether the next
-- step's clear: ground under its leading edge, and nothing in the way of
-- its body — so it turns round at a wall, a drop or a gap, the way one on
-- the level turns at the end of its ledge.
function CrackedPlanetoid:floorPath(R)
  local planet = self
  local function solidAt(angle, r)
    local a = angle + planet.rotationAngle
    return planet:solidAtLocal(math.cos(a) * r, math.sin(a) * r)
  end
  return {
    crackedPlanet = self,
    isLoop = true,
    radius = R,
    getPerimeter = function() return TWO_PI * R end,
    worldPointAtArcPosition = function(_, s, offset)
      local a = s / R + planet.rotationAngle
      local nx, ny = math.cos(a), math.sin(a)
      return {
        point = Vector2.new(planet.pos.x + nx * (R + offset), planet.pos.y + ny * (R + offset)),
        normal = Vector2.new(nx, ny),
      }
    end,
    canWalkTo = function(_, s, dir, halfWidth, halfHeight)
      local lead = s / R + dir * halfWidth / R
      return solidAt(lead, R - 4) and not solidAt(lead, R + 4) and not solidAt(lead, R + halfHeight)
        and not solidAt(lead, R + halfHeight * 1.8)
    end,
  }
end

-- Which tile (ring index, tile index) local point (lx, ly) is in —
-- whether there's anything in it or not — or nil if it's outside the
-- rings (in the core, or past the outermost ring).
function CrackedPlanetoid:tileAtLocal(lx, ly)
  lx, ly = toFrame(self, lx, ly)
  local r = math.sqrt(lx * lx + ly * ly)
  if r < self.coreRadius or r >= self.radius then return nil end
  local i = math.floor((r - self.coreRadius) / self.clodHeight) + 1
  local ring = self.rings[i]
  if not ring then return nil end
  return i, clodIndexAt(ring, math.atan2(ly, lx))
end

-- Ring i's tile j made an obsidian block (on), or the block taken away
-- (not on). Lava meeting water makes them, and a fireball melts them
-- back — see WaterSystem.lua's "Lava meeting water: obsidian", which
-- plays Lava.lua's effect over it each way. A block is ordinary solid
-- ground: walked on, bumped into from below, like any other tile.
function CrackedPlanetoid:setObsidian(i, j, on)
  self:setBlock(i, j, on and "obsidian" or nil)
end

-- Ring i's tile j made a block of `kind` — "obsidian" (see :setObsidian)
-- or "ice" (an ice block — see WaterSystem.lua's "Ice": slippery to walk
-- on, see :iceUnder) — or, with kind nil, the block taken away.
function CrackedPlanetoid:setBlock(i, j, kind)
  local on = kind ~= nil
  local ring = self.rings[i]
  ring.clods[j] = on and { obsidian = kind == "obsidian", ice = kind == "ice", shade = 1, breakable = false } or nil
  -- (For the water and lava on it: the cells there fill in, or open up
  -- — see WaterSystem.lua's catchUpPlanetGrid.)
  self.dirtChanges = self.dirtChanges or {}
  self.dirtChanges[#self.dirtChanges + 1] = { ring = i, j = j }
  self:rebuildSilhouette()

  -- Made while he's in it: he's lifted out on top of it.
  local player = state.player
  if on and player then
    local a0, a1 = clodAngles(ring, j)
    local fx, fy = toFrame(self, player.pos.x - self.pos.x, player.pos.y - self.pos.y)
    local r = math.sqrt(fx * fx + fy * fy)
    local pr = player.radius
    if r > 1e-6 and r < ring.outer + pr and r > ring.inner - pr then
      local a = math.atan2(fy, fx)
      local slack = pr / r -- (his radius, as an angle)
      local da = normalizeAngle(a - a0 + slack)
      if da < a1 - a0 + 2 * slack then
        local out = ring.outer + pr + 1
        local wx, wy = fromFrame(self, math.cos(a) * out, math.sin(a) * out)
        player.pos.x, player.pos.y = self.pos.x + wx, self.pos.y + wy
      end
    end
  end
  self:refitPlayer()
end

------------------------------------------------------------------
-- The core's cracks
------------------------------------------------------------------

-- Grows one crack from local (x, y) heading `angle`, wandering a little
-- each step, sometimes splitting off a thinner branch.
function CrackedPlanetoid:growCrack(x, y, angle, length, width, branchesLeft)
  local points = { x, y }
  local steps = math.max(2, math.floor(length / CRACK_STEP))
  local cx, cy, a = x, y, angle
  for _ = 1, steps do
    a = a + (math.random() - 0.5) * 0.8
    local step = CRACK_STEP * (0.7 + math.random() * 0.6)
    cx, cy = cx + math.cos(a) * step, cy + math.sin(a) * step
    points[#points + 1] = cx
    points[#points + 1] = cy
    if branchesLeft > 0 and math.random() < 0.15 then
      local side = math.random() < 0.5 and -1 or 1
      self:growCrack(cx, cy, a + side * (0.5 + math.random() * 0.7),
        length * (0.3 + math.random() * 0.3), width * 0.6, branchesLeft - 1)
    end
  end
  table.insert(self.coreCracks, { points = points, width = width })
end

function CrackedPlanetoid:seedCoreCracks()
  local r = self.coreRadius
  for _ = 1, CORE_CRACKS do
    local a = math.random() * TWO_PI
    local inward = a + math.pi + (math.random() - 0.5) * 0.9
    self:growCrack(math.cos(a) * r * 1.02, math.sin(a) * r * 1.02, inward,
      r * (0.5 + math.random() * 0.5), 3 + math.random() * 2, 2)
  end
end

------------------------------------------------------------------
-- Getting hit
------------------------------------------------------------------

-- A fireball hit the dirt at world (x, y), going (vx, vy): blow out
-- every clod the blast square in front of it touches and throw them off
-- as clumps. Works from any side — from inside a hole or a cave just as
-- well as from above. Called from main.lua's fireball-vs-planetoid
-- pass. With no velocity it blasts straight down toward the center.
function CrackedPlanetoid:takeHit(worldX, worldY, vx, vy)
  local hx, hy = worldX - self.pos.x, worldY - self.pos.y
  local dx, dy = vx or 0, vy or 0
  local len = math.sqrt(dx * dx + dy * dy)
  if len < 1e-6 then
    dx, dy, len = -hx, -hy, math.sqrt(hx * hx + hy * hy)
    if len < 1e-6 then return end
  end
  dx, dy = dx / len, dy / len

  -- The shot's direction split into out-from-the-center and
  -- round-the-planet parts at the hit point; the square is stepped out
  -- in those (as height and as distance round the ring) from there.
  local hr = math.sqrt(hx * hx + hy * hy)
  if hr < 1e-6 then return end
  local ha = math.atan2(hy, hx)
  local rx, ry = hx / hr, hy / hr
  local dOut, dRound = dx * rx + dy * ry, dx * -ry + dy * rx
  if math.abs(dOut) < BLAST_SNAP then
    dOut, dRound = 0, dRound < 0 and -1 or 1
  elseif math.abs(dRound) < BLAST_SNAP then
    dOut, dRound = dOut < 0 and -1 or 1, 0
  end
  local sOut, sRound = -dRound, dOut -- sideways across the shot

  -- (Obsidian it reaches isn't blown out: it starts melting back into
  -- lava; ice melts into water — listed in blockHits for WaterSystem.lua
  -- to see to; see its "Lava meeting water: obsidian" and "Ice".)
  local removed = {}
  local along = 0
  while along <= BLAST_REACH do
    local across = -BLAST_HALF_WIDTH
    while across <= BLAST_HALF_WIDTH do
      local pr = hr + dOut * along + sOut * across
      local pa = ha + (dRound * along + sRound * across) / hr
      local i, j = self:clodAtLocal(math.cos(pa) * pr, math.sin(pa) * pr)
      local clod = i and self.rings[i].clods[j]
      if clod and (clod.obsidian or clod.ice) then
        self.blockHits = self.blockHits or {}
        self.blockHits[#self.blockHits + 1] = { ring = i, j = j }
      elseif clod and clod.breakable then -- (see fromTiledMap: a map's tiles mostly aren't)
        removed[#removed + 1] = { ring = i, j = j, clod = clod }
        self.rings[i].clods[j] = nil
      end
      across = across + BLAST_SAMPLE_STEP
    end
    along = along + BLAST_SAMPLE_STEP
  end
  if #removed == 0 then return end

  -- (For the water on it — see WaterSystem.lua's "Water on a dirt
  -- planet": every clod gone, so the cells there open up.)
  self.dirtChanges = self.dirtChanges or {}
  for _, e in ipairs(removed) do self.dirtChanges[#self.dirtChanges + 1] = { ring = e.ring, j = e.j } end

  self:rebuildSilhouette()
  self:spawnDebris(removed)
  CameraShake.start(HIT_SHAKE_STRENGTH, HIT_SHAKE_SECONDS)
  self:refitPlayer()
end

-- A ground pound landed on him at `player` (see Player:update's landing
-- check): the poundable tiles (see fromTiledMap) right under his feet
-- break — one layer of them, as wide as he is (tiles here are narrower
-- than him, so that's two or three: just enough of a hole for him to
-- drop through) — bursting into rock pieces that fly up and out round
-- him, and he drops into the hole. Returns whether any broke.
local POUND_PIECES = 10            -- rock pieces per broken tile
local POUND_DUST = 6               -- dust puffs per broken tile
local POUND_COLOR = { 0.76, 0.66, 0.44 } -- the cracked tile's khaki
local POUND_SHAKE_STRENGTH = 7
local POUND_SHAKE_SECONDS = 0.2
local POUND_SAMPLES = 9            -- points checked across his width
function CrackedPlanetoid:poundBreak(player)
  local lx, ly = player.pos.x - self.pos.x, player.pos.y - self.pos.y
  local ux, uy = self:upAtLocal(lx, ly)
  local tx, ty = -uy, ux
  local d = player.radius + 6
  local half = player.radius + 4 -- (his full width and a little: any tile he could be resting on)
  local broken, seen = {}, {}
  for k = 0, POUND_SAMPLES - 1 do
    local off = -half + 2 * half * k / (POUND_SAMPLES - 1)
    local i, j = self:clodAtLocal(lx - ux * d + tx * off, ly - uy * d + ty * off)
    local clod = i and self.rings[i].clods[j]
    if clod and clod.poundable and not seen[i * 100000 + j] then
      seen[i * 100000 + j] = true
      broken[#broken + 1] = { i = i, j = j }
    end
  end
  if #broken == 0 then return false end

  self.dirtChanges = self.dirtChanges or {}
  for _, b in ipairs(broken) do
    self.rings[b.i].clods[b.j] = nil
    self.dirtChanges[#self.dirtChanges + 1] = { ring = b.i, j = b.j }
  end
  self:rebuildSilhouette()
  for _, b in ipairs(broken) do self:spawnPoundDebris(b.i, b.j) end

  CameraShake.start(POUND_SHAKE_STRENGTH, POUND_SHAKE_SECONDS)
  -- The ground under him's gone: he falls.
  self:refitPlayer()
  return true
end

-- One pounded tile's rock pieces and dust (see :poundBreak).
function CrackedPlanetoid:spawnPoundDebris(i, j)
  -- Pieces: from all over the broken tile, thrown up and out to both
  -- sides of him (some higher, some lower), tumbling, then falling back
  -- and bouncing (see :update).
  local ring = self.rings[i]
  local a0, a1 = clodAngles(ring, j)
  local rot = self.rotationAngle
  local tileW = (a1 - a0) * ring.mid
  for n = 1, POUND_PIECES do
    local a = a0 + math.random() * (a1 - a0) + rot
    local r = ring.inner + math.random() * (ring.outer - ring.inner)
    local nx, ny = math.cos(a), math.sin(a)       -- out from the center here
    local tx, ty = -ny, nx                        -- round the planet
    local side = (n % 2 == 0) and 1 or -1
    local out = 3 + math.random() * 5
    local round = side * (1.5 + math.random() * 4.5)
    local size = self.clodHeight * (0.06 + math.random() * 0.1)
    local sides = 5 + math.floor(math.random() * 3)
    local shape = {}
    for k = 1, sides do
      local ang = (k - 1) / sides * TWO_PI + (math.random() - 0.5) * 0.5
      local rr = size * (0.6 + math.random() * 0.4)
      shape[#shape + 1] = math.cos(ang) * rr
      shape[#shape + 1] = math.sin(ang) * rr
    end
    local life = CHUNK_LIFE_MIN * 0.6 + math.random() * CHUNK_LIFE_RANGE * 0.6
    local shade = 0.8 + math.random() * 0.35
    table.insert(self.chunks, {
      x = self.pos.x + nx * r, y = self.pos.y + ny * r,
      vx = nx * out + tx * round, vy = ny * out + ty * round,
      angle = math.random() * TWO_PI, spin = (math.random() - 0.5) * 0.4,
      size = size, shape = shape, life = life, maxLife = life, shade = shade,
      color = POUND_COLOR,
    })
  end

  -- Dust, puffing out of the hole.
  if state.particles then
    local a = (a0 + a1) / 2 + rot
    local nx, ny = math.cos(a), math.sin(a)
    local tx, ty = -ny, nx
    local cx, cy = self.pos.x + nx * ring.outer, self.pos.y + ny * ring.outer
    for _ = 1, POUND_DUST do
      local along = (math.random() - 0.5) * tileW
      local speed = 0.8 + math.random() * 2.2
      local spread = (math.random() - 0.5) * 2.4
      local px, py = nx + tx * spread, ny + ty * spread
      local plen = math.sqrt(px * px + py * py)
      local p = Particle.new(Vector2.new(cx + tx * along, cy + ty * along),
        Vector2.new(px / plen * speed, py / plen * speed), 30 + math.random() * 25)
      p.color = { POUND_COLOR[1] * 0.9, POUND_COLOR[2] * 0.88, POUND_COLOR[3] * 0.85 }
      p.radius = 4 + math.random() * 6
      p.growRate = 0.25
      p.drag = 0.94
      table.insert(state.particles, p)
    end
  end
end

-- Each blown-out clod flies off as a clump about half its size, with a
-- puff of dust.
function CrackedPlanetoid:spawnDebris(removed)
  local c = self.color
  for n, entry in ipairs(removed) do
    local ring = self.rings[entry.ring]
    local a0, a1 = clodAngles(ring, entry.j)
    local a = (a0 + a1) / 2 + self.rotationAngle
    local ux, uy = math.cos(a), math.sin(a)
    local tx, ty = -uy, ux
    local x, y = self.pos.x + ux * ring.mid, self.pos.y + uy * ring.mid
    local shade = entry.clod.shade

    if n <= MAX_CHUNKS_PER_HIT then
      local size = self.clodHeight * (0.22 + math.random() * 0.12)
      local sides = 6 + math.floor(math.random() * 3)
      local shape = {}
      for k = 1, sides do
        local ang = (k - 1) / sides * TWO_PI + (math.random() - 0.5) * 0.4
        local rr = size * (0.7 + math.random() * 0.3)
        shape[#shape + 1] = math.cos(ang) * rr
        shape[#shape + 1] = math.sin(ang) * rr
      end
      local out = 2 + math.random() * 3.5
      local side = (math.random() - 0.5) * 3
      local life = CHUNK_LIFE_MIN + math.random() * CHUNK_LIFE_RANGE
      table.insert(self.chunks, {
        x = x, y = y, vx = ux * out + tx * side, vy = uy * out + ty * side,
        angle = math.random() * TWO_PI, spin = (math.random() - 0.5) * 0.25,
        size = size, shape = shape, life = life, maxLife = life, shade = shade,
      })
    end

    if state.particles then
      for _ = 1, DUST_PER_CLOD do
        local speed = 0.6 + math.random() * 1.8
        local spread = (math.random() - 0.5) * 1.8
        local px, py = ux + tx * spread, uy + ty * spread
        local plen = math.sqrt(px * px + py * py)
        local p = Particle.new(Vector2.new(x, y), Vector2.new(px / plen * speed, py / plen * speed),
          30 + math.random() * 25)
        p.color = { c[1] * 0.85, c[2] * 0.8, c[3] * 0.75 }
        p.radius = 4 + math.random() * 5
        p.growRate = 0.25
        p.drag = 0.94
        table.insert(state.particles, p)
      end
    end
  end
end

------------------------------------------------------------------
-- Update: turning, if it is; the thrown-off clumps fly, fall back,
-- bounce and fade.
------------------------------------------------------------------

-- Starts it turning `dir` (1 clockwise, -1 counter-clockwise) — or, if
-- it's already turning that way, stops it. Returns which way it's
-- turning now.
function CrackedPlanetoid:toggleSpin(dir)
  self.spinDir = (self.spinDir == dir) and 0 or dir
  return self.spinDir
end

CrackedPlanetoid.SPIN_LABELS = { [0] = "Off", [1] = "Clockwise", [-1] = "Counter-clockwise" }

-- It's just turned `d` radians: if he's standing on it, he goes round
-- with it — unless, with its gravity straight down or up the screen,
-- the ground under him has tipped too steep to stand on: then he slides
-- off, carrying the ground's speed.
function CrackedPlanetoid:carryPlayer(d)
  local player = state.player
  if not (player and player.onSurface and player.currentPlanet == self) then return end
  local c, s = math.cos(d), math.sin(d)
  local lx, ly = player.pos.x - self.pos.x, player.pos.y - self.pos.y
  lx, ly = lx * c - ly * s, lx * s + ly * c
  player.pos.x, player.pos.y = self.pos.x + lx, self.pos.y + ly
  local n = player.climbNormal
  if n and player.climbPlanet == self then
    player.climbNormal = { x = n.x * c - n.y * s, y = n.x * s + n.y * c }
    return
  end
  local pr = player.radius
  local qx, qy, d2, inside = self:nearestSolidLocal(lx, ly, pr + GROUND_SNAP + 8)
  if inside or d2 < 1e-12 then return end
  local dist = math.sqrt(d2)
  if dist > pr + GROUND_SNAP then return end
  local nx, ny = (lx - qx) / dist, (ly - qy) / dist
  if upness(self, nx, ny, lx, ly) < FLOOR_DOT then
    leaveSurface(self, player, -ly * d, lx * d)
  end
end

function CrackedPlanetoid:update()
  local ts = state.timeScale or 1
  if self.spinDir ~= 0 then
    local d = TWO_PI / (SPIN_SECONDS_PER_TURN * 60) * ts * self.spinDir
    self.rotationAngle = self.rotationAngle + d
    self:carryPlayer(d)
  end
  local chunks = self.chunks
  for i = #chunks, 1, -1 do
    local c = chunks[i]
    local lx, ly = c.x - self.pos.x, c.y - self.pos.y
    local dist = math.sqrt(lx * lx + ly * ly)
    if dist > 1e-6 then
      local ux, uy = self:upAtLocal(lx, ly)
      c.vx = c.vx - ux * CHUNK_GRAVITY * ts
      c.vy = c.vy - uy * CHUNK_GRAVITY * ts
    end
    local nxp, nyp = lx + c.vx * ts, ly + c.vy * ts
    if self:solidAtLocal(nxp, nyp) then
      -- Hit dirt: stays where it was and bounces off it.
      local qx, qy, d2, inside = self:nearestSolidLocal(lx, ly, c.size + 20)
      local nx, ny
      local d = math.sqrt(d2)
      if inside or d < 1e-6 then
        nx, ny = lx / math.max(dist, 1e-6), ly / math.max(dist, 1e-6)
      else
        nx, ny = (lx - qx) / d, (ly - qy) / d
      end
      local into = c.vx * nx + c.vy * ny
      if into < 0 then
        local tx, ty = c.vx - into * nx, c.vy - into * ny
        c.vx = tx * CHUNK_FRICTION - into * CHUNK_BOUNCE * nx
        c.vy = ty * CHUNK_FRICTION - into * CHUNK_BOUNCE * ny
      end
      c.spin = c.spin * 0.7
    else
      c.x, c.y = self.pos.x + nxp, self.pos.y + nyp
    end
    c.angle = c.angle + c.spin * ts
    c.life = c.life - ts
    if c.life <= 0 then table.remove(chunks, i) end
  end
end

------------------------------------------------------------------
-- Drawing
------------------------------------------------------------------

-- A fan of triangles from the center out to `count` points round a
-- circle, each radiusOf(index) out, textured with the shared
-- planetTexture the way Planetoid.lua lays it.
local function fanVertices(count, radiusOf, texSize, color)
  local vertices = { { 0, 0, 0.5, 0.5, color[1], color[2], color[3], 1 } }
  for k = 0, count do
    local a = k / count * TWO_PI
    local r = radiusOf(k % count + 1)
    local x, y = math.cos(a) * r, math.sin(a) * r
    vertices[#vertices + 1] = { x, y, 0.5 + x / texSize, 0.5 + y / texSize, color[1], color[2], color[3], 1 }
  end
  return vertices
end

-- A fan mesh kept in self[field] (or self[field][index]), created the
-- first time and refilled after that.
function CrackedPlanetoid:setMesh(field, index, vertices)
  local holder = index and self[field] or self
  local key = index or field
  local mesh = holder[key]
  if not mesh then
    mesh = love.graphics.newMesh(vertices, "fan", "dynamic")
    holder[key] = mesh
  else
    mesh:setVertices(vertices)
  end
  return mesh
end

-- One ring slice (from radius rIn to rOut, angle a0 to a1) filled, as a
-- strip of four-sided pieces short enough to look curved.
local function fillSector(rIn, rOut, a0, a1)
  local segs = math.max(2, math.ceil((a1 - a0) * rOut / 10))
  for s = 0, segs - 1 do
    local b0 = a0 + (a1 - a0) * s / segs
    local b1 = a0 + (a1 - a0) * (s + 1) / segs
    local c0, s0, c1, s1 = math.cos(b0), math.sin(b0), math.cos(b1), math.sin(b1)
    love.graphics.polygon("fill",
      c0 * rIn, s0 * rIn, c1 * rIn, s1 * rIn, c1 * rOut, s1 * rOut, c0 * rOut, s0 * rOut)
  end
end

-- An arc at radius r from angle a0 to a1, as a line, drawn only where
-- show(angle) says (nil: all of it) — for a clod edge that's open air
-- along only part of its length.
local function arcLine(r, a0, a1, show)
  local segs = math.max(2, math.ceil((a1 - a0) * r / 6))
  local points = {}
  local function flush()
    if #points >= 4 then love.graphics.line(points) end
    points = {}
  end
  for s = 0, segs - 1 do
    local b0 = a0 + (a1 - a0) * s / segs
    local b1 = a0 + (a1 - a0) * (s + 1) / segs
    if not show or show((b0 + b1) / 2) then
      if #points == 0 then
        points[1], points[2] = math.cos(b0) * r, math.sin(b0) * r
      end
      points[#points + 1] = math.cos(b1) * r
      points[#points + 1] = math.sin(b1) * r
    else
      flush()
    end
  end
  flush()
end

local function radialLine(a, rIn, rOut)
  local c, s = math.cos(a), math.sin(a)
  love.graphics.line(c * rIn, s * rIn, c * rOut, s * rOut)
end

-- Bakes the planet into its own canvas: the soft blue halo (the same
-- layered glow Planetoid.lua bakes, but following the dirt's outline),
-- the cracked core, the dark back wall of any caves, and every clod
-- still there. Redone after every hit.
function CrackedPlanetoid:bake()
  if not state.planetTexture then return end
  local r = self.radius
  local padding = self.bodyCanvasPadding
  local size = math.ceil((r + padding) * 2 * BAKE_SCALE)
  if not self.bodyCanvas then
    self.bodyCanvas = love.graphics.newCanvas(size, size)
    self.bodyCanvas:setFilter("linear", "linear")
  end
  local texSize = r * 2 * 2.5
  local white = { 1, 1, 1 }
  local c = self.color

  love.graphics.push("all")
  love.graphics.origin()
  love.graphics.setCanvas({ self.bodyCanvas, stencil = true })
  love.graphics.clear(0, 0, 0, 0)
  love.graphics.setBlendMode("alpha")
  love.graphics.translate((r + padding) * BAKE_SCALE, (r + padding) * BAKE_SCALE)
  love.graphics.scale(BAKE_SCALE, BAKE_SCALE)

  -- The outline, as a fan: everything inside it is dirt or dug-out cave.
  local outline = self:setMesh("backWallMesh", nil,
    fanVertices(self.silhouetteSamples, function(k) return self.silhouette[k] end, texSize, white))

  -- Halo, outside the outline only (not glowing up the inside of a cave).
  love.graphics.stencil(function() love.graphics.draw(outline) end, "replace", 1)
  love.graphics.setStencilTest("equal", 0)
  local sc = Planetoid.SHADOW_COLOR
  for i = GLOW_LAYERS, 1, -1 do
    local t = i / GLOW_LAYERS
    local falloff = (1 - t) * (1 - t)
    local grow = padding * t
    local mesh = self:setMesh("glowMeshes", i,
      fanVertices(self.silhouetteSamples, function(k) return self.silhouette[k] + grow end, texSize, white))
    love.graphics.setColor(sc[1], sc[2], sc[3], sc[4] * falloff * 0.85)
    love.graphics.draw(mesh)
  end
  love.graphics.setStencilTest()

  -- Caves' back wall: dark dirt, under everything that's still there.
  love.graphics.setColor(c[1] * BACK_WALL_SHADE, c[2] * BACK_WALL_SHADE, c[3] * BACK_WALL_SHADE, 1)
  love.graphics.draw(outline)

  -- The core: the shared rocky texture, tinted dark and hot, with
  -- glowing cracks through it.
  local core = self:setMesh("coreMesh", nil,
    fanVertices(96, function() return self.coreRadius end, texSize, CORE_TINT))
  core:setTexture(state.planetTexture)
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(core)
  love.graphics.stencil(function() love.graphics.draw(core) end, "replace", 1)
  love.graphics.setStencilTest("greater", 0)
  love.graphics.setLineJoin("bevel")
  for _, crack in ipairs(self.coreCracks) do
    love.graphics.setColor(CRACK_DARK)
    love.graphics.setLineWidth(crack.width + 2)
    love.graphics.line(crack.points)
  end
  love.graphics.setBlendMode("add")
  for _, crack in ipairs(self.coreCracks) do
    love.graphics.setColor(CRACK_GLOW)
    love.graphics.setLineWidth(math.max(1, crack.width * 0.55))
    love.graphics.line(crack.points)
  end
  love.graphics.setBlendMode("alpha")
  love.graphics.setStencilTest()

  -- A Tiled map's tiles, each with its own art...
  if self.isTiled then self:drawTiles() end

  -- ...or the clods: dirt, a soft lighter lump in the middle, a few pebbles.
  for _, ring in ipairs(self.isTiled and {} or self.rings) do
    for j = 1, ring.count do
      local clod = ring.clods[j]
      if clod then
        local a0, a1 = clodAngles(ring, j)
        local s = clod.shade
        love.graphics.setColor(c[1] * s, c[2] * s, c[3] * s, 1)
        fillSector(ring.inner, ring.outer, a0, a1)

        local am = (a0 + a1) / 2
        local arcLen = ring.step * ring.mid
        love.graphics.push()
        love.graphics.translate(math.cos(am) * ring.mid, math.sin(am) * ring.mid)
        love.graphics.rotate(am + math.pi / 2)
        love.graphics.setColor(1, 0.92, 0.78, 0.07)
        love.graphics.ellipse("fill", math.cos(clod.lump) * 2, math.sin(clod.lump) * 2,
          arcLen * 0.38, self.clodHeight * 0.34)
        love.graphics.pop()

        for _, p in ipairs(clod.pebbles) do
          local pa = a0 + ring.step * p.along
          local pr = ring.inner + self.clodHeight * p.out
          if p.light then
            love.graphics.setColor(1, 0.9, 0.75, 0.16)
          else
            love.graphics.setColor(0.1, 0.06, 0.03, 0.22)
          end
          love.graphics.circle("fill", math.cos(pa) * pr, math.sin(pa) * pr, p.size)
        end
      end
    end
  end

  -- Their edges: a faint seam between two clods, a darker rim wherever
  -- one faces open air (a hole, a cave, space). (Not round a slope tile:
  -- its open side is its diagonal, which its own art already edges.)
  for i, ring in ipairs(self.rings) do
    for j = 1, ring.count do
      if ring.clods[j] and not ring.clods[j].shape then
        local a0, a1 = clodAngles(ring, j)
        local function openAbove(a) return not self:solidInRing(i + 1, a) end
        local function openBelow(a) return not self:solidInRing(i - 1, a) end
        local function solidAbove(a) return self:solidInRing(i + 1, a) end
        local prevOpen = not ring.clods[(j - 2) % ring.count + 1]
        local nextOpen = not ring.clods[j % ring.count + 1]

        -- (Each seam once: a clod draws the one along its top and the one
        -- on its clockwise side. None between a Tiled map's tiles: their
        -- art lines up on its own.)
        if not self.isTiled then
          love.graphics.setLineWidth(1)
          love.graphics.setColor(0.08, 0.05, 0.03, SEAM_ALPHA)
          if i < #self.rings then arcLine(ring.outer, a0, a1, solidAbove) end
          if not nextOpen then radialLine(a1, ring.inner, ring.outer) end
        end

        love.graphics.setLineWidth(2)
        love.graphics.setColor(0.07, 0.04, 0.02, EDGE_ALPHA)
        arcLine(ring.outer - 1, a0, a1, openAbove)
        arcLine(ring.inner + 1, a0, a1, openBelow)
        if prevOpen then radialLine(a0 + 1 / ring.mid, ring.inner, ring.outer) end
        if nextOpen then radialLine(a1 - 1 / ring.mid, ring.inner, ring.outer) end
      end
    end
  end

  love.graphics.pop()
  self.needsBake = false
end

-- Every tile of a Tiled-map planet, as one mesh per tileset image: each
-- tile its own slice of its ring, bent round in a few pieces, with its
-- art from its tileset (its top edge on the ring's outside, mirrored if
-- it's flipped in the map). Rebuilt with every bake.
local TILE_PIECES = 3
-- The obsidian and ice blocks' art (see :setBlock), each loaded the first
-- time one's drawn.
local blockImages = {}
local function getBlockImage(clod)
  local path = clod.obsidian and "img/obsidian.png" or clod.ice and "img/ice.png" or nil
  if not path then return nil end
  if not blockImages[path] then
    blockImages[path] = love.graphics.newImage(path)
    blockImages[path]:setFilter("nearest", "nearest")
  end
  return blockImages[path]
end

function CrackedPlanetoid:drawTiles()
  local verticesByImage, images = {}, {}
  for _, ring in ipairs(self.rings) do
    for j = 1, ring.count do
      local clod = ring.clods[j]
      local block = clod and getBlockImage(clod)
      local ts = clod and not block and tilesetForGid(self.tilesets, clod.gid)
      local image = block or (ts and ts.image)
      if image then
        local vertices = verticesByImage[image]
        if not vertices then
          vertices = {}
          verticesByImage[image] = vertices
          images[#images + 1] = image
        end
        local function add(r, a, u, v)
          vertices[#vertices + 1] = { math.cos(a) * r, math.sin(a) * r, u, v, 1, 1, 1, 1 }
        end
        local u0, v0, u1, v1
        if block then
          u0, v0, u1, v1 = 0, 0, 1, 1
        else
          -- (Half a texel in from each tile's edges, so nothing bleeds in
          -- from its neighbors in the tileset image.)
          local padU, padV = 0.5 / ts.imageW, 0.5 / ts.imageH
          local id = clod.gid - ts.firstgid
          u0 = (id % ts.columns) * ts.tileW / ts.imageW + padU
          v0 = math.floor(id / ts.columns) * ts.tileH / ts.imageH + padV
          u1 = u0 + ts.tileW / ts.imageW - 2 * padU
          v1 = v0 + ts.tileH / ts.imageH - 2 * padV
          if clod.flipX then u0, u1 = u1, u0 end
        end
        local a0, a1 = clodAngles(ring, j)
        for p = 0, TILE_PIECES - 1 do
          local t0, t1 = p / TILE_PIECES, (p + 1) / TILE_PIECES
          local b0, b1 = a0 + (a1 - a0) * t0, a0 + (a1 - a0) * t1
          local ua, ub = u0 + (u1 - u0) * t0, u0 + (u1 - u0) * t1
          add(ring.outer, b0, ua, v0); add(ring.outer, b1, ub, v0); add(ring.inner, b1, ub, v1)
          add(ring.outer, b0, ua, v0); add(ring.inner, b1, ub, v1); add(ring.inner, b0, ua, v1)
        end
      end
    end
  end
  for _, mesh in ipairs(self.tileMeshes or {}) do mesh:release() end
  self.tileMeshes = {}
  love.graphics.setColor(1, 1, 1, 1)
  for _, image in ipairs(images) do
    local mesh = love.graphics.newMesh(verticesByImage[image], "triangles", "static")
    mesh:setTexture(image)
    love.graphics.draw(mesh)
    self.tileMeshes[#self.tileMeshes + 1] = mesh
  end
end

function CrackedPlanetoid:draw()
  Planetoid.drawEclipseShadow(self)

  if self.needsBake then self:bake() end

  local r = self.radius
  if self.bodyCanvas then
    local padding = self.bodyCanvasPadding
    local shader = Planetoid.applySunShadingAt(self.pos.x, self.pos.y, r, padding)
    -- (Drawn turned: so the sun's side stays put, its direction turned
    -- back the other way, into the picture's own frame.)
    local angle = self.rotationAngle
    if shader and angle ~= 0 then
      local sunX, sunY = state.sceneWidth / 2 - self.pos.x, state.sceneHeight / 2 - self.pos.y
      local len = math.sqrt(sunX * sunX + sunY * sunY)
      local fx, fy = toFrame(self, sunX / len, sunY / len)
      shader:send("lightDir", { fx, fy })
    end
    love.graphics.setColor(1, 1, 1, 1)
    local half = (r + padding) * BAKE_SCALE
    love.graphics.draw(self.bodyCanvas, self.pos.x, self.pos.y,
      angle, 1 / BAKE_SCALE, 1 / BAKE_SCALE, half, half)
    if shader then love.graphics.setShader() end
  else
    love.graphics.setColor(self.color[1], self.color[2], self.color[3], 1)
    love.graphics.circle("fill", self.pos.x, self.pos.y, r)
  end

  self:drawChunks()
  love.graphics.setColor(1, 1, 1, 1)
end

function CrackedPlanetoid:drawChunks()
  for _, chunk in ipairs(self.chunks) do
    local c = chunk.color or self.color -- (rock from a pounded tile has its own colour)
    local alpha = math.min(1, chunk.life / CHUNK_FADE)
    local s = chunk.shade
    love.graphics.push()
    love.graphics.translate(chunk.x, chunk.y)
    love.graphics.rotate(chunk.angle)
    love.graphics.setColor(c[1] * s, c[2] * s, c[3] * s, alpha)
    love.graphics.polygon("fill", chunk.shape)
    love.graphics.setLineWidth(1.2)
    love.graphics.setColor(0.08, 0.05, 0.03, alpha * 0.6)
    love.graphics.polygon("line", chunk.shape)
    love.graphics.pop()
  end
end

return CrackedPlanetoid
