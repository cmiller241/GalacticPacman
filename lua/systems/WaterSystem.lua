-- lua/systems/WaterSystem.lua
--
-- Water mode (see WeaponModes.lua): left click / R2 sprays water from the
-- blaster's muzzle.
--
-- Spray is DROPLETS: little projectiles arcing under gravity. Where one
-- lands decides what happens to it:
--
--   On the Tiled level (inside the dome) it becomes water on a fine grid
--   of CELL-sized cells laid over the level, each holding some amount of
--   water (0 = dry, 1 = full). Every step, a cell's water falls into the
--   cell below if there's room, spreads sideways along whatever it's
--   resting on, and evaporates slowly from the top. That's what makes it
--   run off ledges, trickle down slopes, gather in the low spots and fill
--   pits up — and spill over the lip into the next one when a pit's full —
--   the more you spray. (Water held per cell rather than as walking
--   particles, so it can pile up without particles having to stack on
--   each other; the same idea Terraria's water uses.)
--
--   On a dirt planet (CrackedPlanetoid.lua — one built from a Tiled map,
--   say) it's the same water on a grid of the planet's own, bent round
--   it, with "down" toward its center (see "Water on a dirt planet").
--
--   Anywhere else (a round planet, open space) it just splashes and is
--   gone — there's no "down" for water to collect in on a round planet.
--
-- Bob swims in pools deep enough to cover his middle (see submergedAt and
-- Player.lua's submergedIn).

local state = require("lua.state")
local constants = require("lua.constants")
local Vector2 = require("lua.vector2")
local PortalGun = require("lua.systems.PortalGun")
local Splash = require("lua.effects.Splash")
local Lava = require("lua.world.Lava")

local WaterSystem = {}

----------------------------------------------------------------------
-- Tunables
----------------------------------------------------------------------

local CELL = 16                   -- world units per water cell (a Tiled tile is 64: 4x4 cells)
local STEP_SECONDS = 1 / 60       -- water moves in fixed steps...
local MAX_STEPS_PER_FRAME = 3     -- ...at most this many per frame (after a stutter)
local SPREAD = 0.25               -- share of the difference moved to a lower sideways neighbor each pass
-- Sideways passes each step: water falls a cell a step, but spreads this
-- many times a step — so what lands (under a waterfall, say) runs out
-- across the floor and finds its level quickly, like water, instead of
-- heaping up and oozing outward like gel. (Falling stays a cell a step.)
local SPREAD_PASSES = 4
local MIN_SPREAD = 0.02           -- thinner than this, it stays put as a damp patch instead of spreading forever
local EVAPORATE_PER_SECOND = 0.006 -- off each pool's surface; a pool one cell (16 units) deep lasts ~3 minutes
local DRY = 0.002                 -- less than this left in a cell and it's dry

local SPRAY_PER_SECOND = 240
local SPRAY_SPEED, SPRAY_SPEED_RANGE = 10, 3 -- world units/frame out of the muzzle
local SPRAY_SPREAD = 0.08         -- radians either side of the aim
local DROPLET_VOLUME = 0.1/3        -- how much of a cell each droplet fills
local DROPLET_SECONDS = 3         -- one that hasn't landed by then just evaporates
local MAX_DROPLETS = 1200
local HITS_POOL = 0.5             -- a droplet flying into a cell at least this full lands in that pool

-- Water and portals (see drainIntoPortals): water resting against a
-- portal's opening (any portal but a ceiling one — water doesn't flow up)
-- drains into it at up to this rate, and comes out of the other portal
-- as a jet of bigger droplets.
local PORTAL_FLOW_PER_SECOND = 12 -- cells' worth of water one portal can take in per second
local PORTAL_JET_VOLUME = 0.25    -- water in each droplet of the jet
-- A planetoid's water flowing through a portal (see drainOceansIntoPortals):
-- cells' worth a second per world unit deeper it is over this portal
-- than over the other (up to PORTAL_FLOW_PER_SECOND), stopping once
-- they're within OCEAN_LEVEL_SLACK of level.
local OCEAN_LEVEL_RATE = 0.6
local OCEAN_LEVEL_SLACK = 0.5
local PORTAL_JET_SPEED, PORTAL_JET_SPEED_RANGE = 4, 2 -- world units/frame out of the exit portal
local PORTAL_JET_SPREAD = 0.15    -- radians either side

-- All the water there can be at once — on the level, on planets, and
-- still in the air — in cells' worth. At the cap the blaster just
-- sputters (a thin dribble carrying no water) until some evaporates or
-- runs off. Keeps things from getting out of hand, and the water
-- simulation's cost bounded.
local WATER_CAP = 1500
local SPUTTER_FRACTION = 0.15     -- share of the usual spray rate it dribbles at, once at the cap

-- Water on round planetoids (see addToOcean): an even layer all the way
-- round, drawn as a ring this many segments around.
local OCEAN_SEGMENTS = 72
local OCEAN_MAX_SEGMENTS = 720     -- (more for a bigger one, up to this — see drawOceans)

local SPLASH_BITS = 4
local SPLASH_SECONDS = 0.35

-- Where a waterfall lands (on the ground or a pool below): a steady spray
-- of the same droplets Bob and the fish throw up leaving the water (see
-- Splash.lua) — this many a second for a full-width fall, fewer for a
-- thin trickle. Only for falls at least WATERFALL_SPLASH_MIN_FALL high.
local WATERFALL_SPLASH_PER_SECOND = 220
local WATERFALL_SPLASH_MIN_FALL = 24
-- Its droplets, next to Bob's/the fish's (see Splash.spawn's opts):
-- slower and shorter-lived (staying close round where it hits), in a
-- narrower fan, smaller, and mostly foam-white.
local WATERFALL_SPLASH = {
  coneAngle = math.pi * 0.6,
  speedScale = 0.35,
  lifeScale = 0.6,
  radiusScale = 0.35,
  lightMin = 0.7,
}

-- A fireball hitting water (see WaterSystem.quenchFireball): it goes out
-- in a burst of steam, boiling BOIL_ON_HIT cells' worth off the surface
-- round where it hit at once, and leaving the spot hot — boiling off
-- BOIL_PER_SECOND more (and steaming) for HOT_SECONDS, tailing off.
local QUENCH_AT = 0.25            -- a cell at least this full counts as water to a fireball
local BOIL_ON_HIT = 0.6
local BOIL_PER_SECOND = 1.2
local HOT_SECONDS = 2.5
local BOIL_REACH_CELLS = 3        -- how far round the spot it boils water off
local STEAM_BURST = 50            -- puffs in the burst when it hits
local STEAM_PER_SECOND = 22       -- puffs a second off a hot spot, at first
local STEAM_SECONDS = 5         -- how long a puff lasts
local STEAM_RISE = 1.1            -- how fast a puff rises (per 60fps tick)
local STEAM_START_DEPTH = 12      -- how far below the surface a puff starts (up to), rising out of the water
local STEAM_SIZE = 2              -- a puff's starting radius...
local STEAM_GROWTH = 14           -- ...and how much it grows over its life
local STEAM_ALPHA = 0.32
local COLOR_STEAM = { 0.92, 0.95, 1.00 }

-- Lava (see "Lava" below): a second liquid on the same grids, moving by
-- the same rules as the water — falling, running down slopes, spreading
-- out along what it's resting on, filling pits — but thick and slow.
-- (One table rather than separate locals: LuaJIT allows a file only 200.)
local LAVA_TUNING = {
  STEP_EVERY = 4,        -- it moves one step for every this many of the water's
  SPREAD = 0.2,          -- (water: SPREAD)
  SPREAD_PASSES = 1,     -- (water: SPREAD_PASSES — lava oozes out rather than racing to level)
  MIN_SPREAD = 0.35,     -- thinner than this it stays put, so it lies in a thick layer instead of filming out
  RIPPLE = 0.4,          -- its surface moves this much as much as water's
  TOUCH = 0.05,          -- this much lava, or water, in a cell counts as touching the other (see obsidian)
  BOIL = 0.4,            -- cells' worth of water boiled off at once when they meet
  PORTAL_FLOW = 4,       -- cells' worth a second one portal takes in (water: PORTAL_FLOW_PER_SECOND)
  TILE_CELLS = 4,        -- cells across a Tiled tile (64 world units) — obsidian forms a tile at a time
  -- Its look (see getLavaShader) — the same churning plasma as Lava.lua's.
  COLOR_DEEP = { 0.45, 0.05, 0.02 },
  COLOR_MID = { 0.85, 0.28, 0.03 },
  COLOR_HOT = { 1.0, 0.65, 0.15 },
  GLOW_BAND = 22,        -- world units under the surface it's hottest over
  PLASMA_SCALE = 0.05,
  PLASMA_DETAIL = 2.6,
  EVOLVE_SPEED = 0.18,
  SCROLL_SPEED = 0.06,
  POUR_SPEED = 1.2,      -- how fast the pattern runs down a falling stream
  -- Embers off its surface (as Lava.lua's): chance a frame for each cell of surface
  EMBER_CHANCE = 0.05,   -- (less over a thin layer: see updateLavaEmbers)
  EMBER_RISE_MIN = 0.6, EMBER_RISE_MAX = 1.4,
  EMBER_DRIFT = 0.35,
  EMBER_LIFE_MIN = 0.9, EMBER_LIFE_MAX = 1.8, -- seconds
  EMBER_RADIUS_MIN = 1.2, EMBER_RADIUS_MAX = 2.6,
}

-- The look (see getWaterShader): shallow water near the surface fading
-- to deep water further down, a drifting caustic net of light (the same
-- kind the water planet has) that's brightest near the surface, a bright
-- line and soft glow along the surface, and streaks rushing down falling
-- streams.
local COLOR_SHALLOW = { 0.30, 0.66, 1.00 }
local COLOR_DEEP = { 0.08, 0.26, 0.62 }
local DEEP_AT = 140               -- world units below the surface where it's fully "deep"
local ALPHA_SHALLOW, ALPHA_DEEP = 0.50, 0.82
local COLOR_SURFACE = { 0.82, 0.94, 1.00 }
local SURFACE_LINE = 8            -- world units thick: a bright core, fading softly into the water
local SURFACE_FEATHER = 2.5       -- world units above the surface the edge fades out over (no hard pixel edge)
local STREAM_REACH_CELLS = 8      -- how far a falling stream is drawn down through dry space to meet what's below
local LIP_THICKNESS = 6           -- world units thick: the water pouring over a ledge's edge into a waterfall
local SURFACE_SLICES = 4          -- strips each cell's surface is drawn in (for a smooth curve)
local SURFACE_GLOW = 16           -- how far the glow under the surface reaches
local COLOR_CAUSTIC = { 0.75, 0.92, 1.00 }
local CAUSTIC_SCALE = 34          -- world units across one caustic cell...
local CAUSTIC_GROW_FROM_DEPTH = 60 -- ...in a planetoid's water layer up to this deep; deeper ones' cells grow (see causticScaleFor)...
local CAUSTIC_GROW_POWER = 0.5    -- ...with the square root of how many times deeper it is...
local CAUSTIC_MAX_GROWTH = 5      -- ...up to this many times bigger
-- A planetoid's water layer is shaded as a sphere lit by the sun instead
-- of by depth (see the shader's sphereShading) — the water planets' old
-- look: lit side to shaded side, a little deeper toward the middle, a
-- bright rim on the sun side's edge, a reflected highlight on the edge
-- furthest from the sun.
local SPHERE_COLOR_SHALLOW = { 0.30, 0.66, 0.85 }   -- the lit side
local SPHERE_COLOR_DEEP = { 0.05, 0.24, 0.52 }      -- toward the middle
local SPHERE_COLOR_SHADE = { 0.02, 0.05, 0.20 }     -- the side away from the sun
local SPHERE_SHADE_STRENGTH = 0.9                   -- 0 = no lit/shaded difference, 1 = the full range
local SPHERE_COLOR_RIM = { 0.55, 0.88, 0.98 }
local SPHERE_RIM_STRENGTH = 0.5
local SPHERE_COLOR_REFLECTED = { 0.20, 0.38, 0.60 }
local SPHERE_REFLECTED_STRENGTH = 0.8
-- The planetoid under a water layer: overlaid with the water (its color
-- and caustics) more strongly the deeper the water is over it — none at
-- all under CORE_OVERLAY_FROM_DEPTH, rising to CORE_OVERLAY_MAX (a
-- fraction of the water's own opacity there) by CORE_OVERLAY_FULL_DEPTH.
local CORE_OVERLAY_FROM_DEPTH = 20
local CORE_OVERLAY_FULL_DEPTH = 400
local CORE_OVERLAY_MAX = 0.85 -- (about what the old water planets showed through)
local CAUSTIC_BULGE = 1.0        -- how much a planetoid's water's caustics bulge like a globe's (0 = flat, 1 = full)
local CAUSTIC_SPEED = 0.6
local CAUSTIC_STRENGTH = 0.3
local COLOR_DROPLET = { 0.70, 0.88, 1.00, 0.95 }

----------------------------------------------------------------------
-- State
----------------------------------------------------------------------

local grid = nil          -- see WaterSystem.init
local droplets = {}
local splashes = {}
local waterfallLandings = {} -- this frame's, from drawPools: { x, y, half, flow }
local steam = {}          -- puffs: { x, y, vx, vy, life, maxLife }
local hotSpots = {}       -- where fireballs went out: { x, y, c, r (grid) or planet, life, steamBudget }
local sprayBudget = 0
local isSpraying = false
local totalWater = 0      -- everywhere, as of this frame (see WATER_CAP)
-- Water layers on round planetoids, keyed by the planetoid (weakly, so a
-- culled planetoid takes its water with it): { volume = cells' worth,
-- water = what it is to Bob swimming in it — see submergedAt }.
local oceans = setmetatable({}, { __mode = "k" })
local stepClock = 0
local lavaStepCount = 0   -- (see LAVA_TUNING.STEP_EVERY)
local lavaEmbers = {}     -- { x, y, vx, vy, life, decay, radius }
local obsidians = {}      -- obsidian blocks lava's turned into (see "Lava meeting water")
-- Ice (see "Ice", further down): its blocks, and its own clock. (One table
-- for all of it: see LAVA_TUNING on the 200-local limit.)
local Ice = { blocks = {}, frame = 0 }
local age = 0
local meshes, meshSizes = {}, {} -- the pools' mesh for each liquid (see drawPools)

-- How each liquid moves (see stepWater): which of a grid's tables it's
-- kept in, and its rules.
local WATER = { key = "water", spread = SPREAD, passes = SPREAD_PASSES, minSpread = MIN_SPREAD, evaporate = EVAPORATE_PER_SECOND }
local LAVA = { key = "lava", spread = LAVA_TUNING.SPREAD, passes = LAVA_TUNING.SPREAD_PASSES, minSpread = LAVA_TUNING.MIN_SPREAD, evaporate = 0 }

-- What a pool is to Bob while he's in one (Player.submergedIn). His swim
-- code treats water as round, like a water planet: it pushes him away
-- from the water's `pos` and lets his bubbles rise out to its `radius`.
-- So this one's pos is kept far straight below him ("away" is then
-- straight up, and his swimming steers plain left/right) and its radius
-- reaches from there up to the pool's surface (see submergedAt).
local poolWater = { isPool = true, pos = Vector2.new(0, 0), radius = 0 }

-- (Defined with the dirt planets' water, further down.)
local planetGridsReset

function WaterSystem.reset()
  grid = nil
  droplets, splashes, waterfallLandings = {}, {}, {}
  steam, hotSpots = {}, {}
  lavaEmbers, obsidians, lavaStepCount = {}, {}, 0
  Ice.blocks, Ice.frame = {}, 0
  sprayBudget, stepClock = 0, 0
  isSpraying = false
  totalWater = 0
  oceans = setmetatable({}, { __mode = "k" })
  planetGridsReset()
end

----------------------------------------------------------------------
-- Water on planetoids
----------------------------------------------------------------------
--
-- Spray landing on a planetoid Bob can walk all the way round — a round
-- one, or a rounded rectangle (RoundedRectPlanetoid.lua) — adds to an
-- even layer of water all the way round it, thickening as more lands.
-- (Not a water planet's water body — those are water already — nor the
-- dome or the level's terrain.) It moves with its planetoid, slowly
-- evaporates from its outer surface like a pool does, and Bob can swim in
-- it (like a little water planet). It's kept with the planetoid, so when
-- that's culled, its water goes too.

-- Whether planetoid `p` can have a layer of water round it.
local function holdsWater(p)
  if not (p and p.pos) or p.isSkyDome or p.isWaterPlanet or p.isOpenPath or p.isWall or p.isGate then
    return false
  end
  if p.isRoundedRect then return p.pointAtLocalArcPosition ~= nil and p.cornerRadius ~= nil end
  return p.radius ~= nil
end

-- How far round planetoid p's own surface is.
local function perimeterOf(p)
  if p.isRoundedRect then return p:getPerimeter() end
  return 2 * math.pi * p.radius
end

-- How deep a layer `volume` (in cells' worth — CELL x CELL each) makes
-- round planetoid p: an even layer `depth` thick round any convex outline
-- of perimeter P holds P * depth + pi * depth^2 (the straight parts' strips
-- plus the corners' wedges, which add up to a full circle) — solved for
-- depth. (For a round one, the ring from radius R out to R + depth.)
local function depthOf(p, volume)
  local P = perimeterOf(p)
  return (math.sqrt(P * P + 4 * math.pi * volume * CELL * CELL) - P) / (2 * math.pi)
end

-- How far (x, y) is from planetoid p's own surface — negative inside it —
-- and the outward normal there.
local function surfaceDistance(p, x, y)
  if p.isRoundedRect then
    -- (Its core rectangle, pushed out by the corner radius.)
    local lx, ly = p:worldToLocal(x, y)
    local cr = p.cornerRadius
    local qx, qy = math.abs(lx) - (p.halfWidth - cr), math.abs(ly) - (p.halfHeight - cr)
    local d, nx, ny
    if qx > 0 and qy > 0 then
      local len = math.sqrt(qx * qx + qy * qy)
      d, nx, ny = len - cr, qx / len, qy / len
    elseif qx > qy then
      d, nx, ny = qx - cr, 1, 0
    else
      d, nx, ny = qy - cr, 0, 1
    end
    if lx < 0 then nx = -nx end
    if ly < 0 then ny = -ny end
    local n = p:localDirToWorld(nx, ny)
    return d, n.x, n.y
  end
  local dx, dy = x - p.pos.x, y - p.pos.y
  local dist = math.sqrt(dx * dx + dy * dy)
  if dist < 1e-6 then return -p.radius, 0, -1 end
  return dist - p.radius, dx / dist, dy / dist
end

local function addToOcean(p, amount)
  local o = oceans[p]
  if not o then
    o = { volume = 0, water = { isPool = true, pos = p.pos, radius = p.radius } }
    oceans[p] = o
  end
  o.volume = o.volume + amount
end

-- A planetoid that starts out under water (see WaterPlanet.lua): a layer
-- of water round core planetoid `core` out to `outerRadius`, the same as
-- any other planetoid's water from then on — swum in, drained through
-- portals, boiled by fireballs, leveled with other planetoids' — except
-- that it doesn't evaporate away on its own, and as much of it as it
-- started with doesn't count against WATER_CAP (it isn't sprayed water).
-- `marker`, if given, has its .radius kept at the water's surface (the
-- water body the fish swim in — see Fish.lua).
function WaterSystem.addNaturalOcean(core, outerRadius, marker)
  local volume = math.pi * (outerRadius * outerRadius - core.radius * core.radius) / (CELL * CELL)
  addToOcean(core, volume)
  local o = oceans[core]
  o.natural = (o.natural or 0) + volume
  o.marker = marker
  if marker then marker.radius = outerRadius end
end

-- Drops oceans whose planetoid has been culled (no longer in the world).
local function forgetCulledOceans()
  if not next(oceans) then return end
  local alive = {}
  for _, p in ipairs(state.planetoids or {}) do alive[p] = true end
  for p in pairs(oceans) do
    if not alive[p] then oceans[p] = nil end
  end
end

----------------------------------------------------------------------
-- The grid
----------------------------------------------------------------------

-- Lays the water grid over a Tiled level (see TiledTerrain.load). Water
-- follows the tiles' roles the way Bob does:
--   * "wall" tiles are solid on every side — every cell whose middle is
--     inside one is solid.
--   * Walkable surfaces ("top" tiles' tops, slopes included) are one-way,
--     like they are for Bob: a one-cell-thick floor layer just under the
--     surface that only stops water crossing it from its open side (from
--     above, or into a slope from the side it faces). From the side or
--     from below, water goes straight in — and on through the tile, which
--     is open beneath its surface.
--   * "fill" tiles (backdrop dirt) don't stop water at all.
-- Steep faces and ceilings aren't floors, so they don't stop it either.
-- The map's bottom edge sits on the dome's floor, so below it is solid
-- too; past its left and right edges water just runs away.
function WaterSystem.init(level)
  local width = (level.pos.x - level.anchorX) * 2
  local height = (level.pos.y - level.anchorY) * 2
  local cols, rows = math.ceil(width / CELL), math.ceil(height / CELL)
  local g = {
    x0 = level.anchorX, y0 = level.anchorY, cols = cols, rows = rows, solid = {}, floor = {}, water = {}, lava = {},
    level = level,
  }
  local function inside(c, r) return c >= 0 and c < cols and r >= 0 and r < rows end

  -- Wall tiles: every cell whose middle is inside one. (And the solid
  -- cells of its ball-tunnel pieces — see TiledTerrain.lua.)
  local walls = {}
  for _, w in ipairs(level.walls or {}) do walls[#walls + 1] = w end
  for _, w in ipairs(level.waterSolids or {}) do walls[#walls + 1] = w end
  for _, w in ipairs(walls) do
    if w.isWall then
      local c0 = math.ceil((w.pos.x - w.halfWidth - g.x0) / CELL - 0.5)
      local c1 = math.floor((w.pos.x + w.halfWidth - g.x0) / CELL - 0.5)
      local r0 = math.ceil((w.pos.y - w.halfHeight - g.y0) / CELL - 0.5)
      local r1 = math.floor((w.pos.y + w.halfHeight - g.y0) / CELL - 0.5)
      for r = r0, r1 do for c = c0, c1 do
        if inside(c, r) then g.solid[r * cols + c + 1] = true end
      end end
    end
  end

  -- Floors: each walkable surface walked along in half-cell steps,
  -- marking the cell just behind it (with the surface's normal, so we
  -- know which side is open — see crossesFloor). Sampled at the MIDDLE of
  -- each step, never the segment's own ends: an end sitting exactly on a
  -- cell boundary (where a ledge's top meets a pit's wall, say) would
  -- otherwise mark the open cell on the far side of it.
  for _, shape in ipairs(level.shapes or {}) do
    for _, s in ipairs(shape.segments or {}) do
      if s.normal.y < -0.3 and not s.isWallFace then
        local len = math.sqrt((s.b.x - s.a.x) ^ 2 + (s.b.y - s.a.y) ^ 2)
        local steps = math.max(1, math.ceil(len / (CELL * 0.5)))
        for k = 0, steps - 1 do
          local t = (k + 0.5) / steps
          -- Nudged a hair behind the surface, so a surface lying exactly
          -- on a cell boundary marks the cell under it.
          local x = s.a.x + (s.b.x - s.a.x) * t - s.normal.x * 0.5
          local y = s.a.y + (s.b.y - s.a.y) * t - s.normal.y * 0.5
          local c, r = math.floor((x - g.x0) / CELL), math.floor((y - g.y0) / CELL)
          if inside(c, r) then
            local i = r * cols + c + 1
            local list = g.floor[i]
            if not list then list = {}; g.floor[i] = list end
            local known = false
            for _, n in ipairs(list) do if n == s.normal then known = true end end
            if not known then list[#list + 1] = s.normal end
          end
        end
      end
    end
  end

  -- Slopes, for drawing (see drawPools): to the grid a slope is a
  -- staircase of cells, so water running down one would be drawn as a
  -- flat little sheet on each step. Each open cell sitting on a sloped
  -- floor remembers that floor's actual line, so the water there can be
  -- drawn lying along it instead.
  g.slope = {}
  local function taken(c, r)
    local i = r * cols + c + 1
    return g.solid[i] or g.floor[i]
  end
  for _, shape in ipairs(level.shapes or {}) do
    for _, s in ipairs(shape.segments or {}) do
      local dx = s.b.x - s.a.x
      if s.normal.y < -0.3 and not s.isWallFace and math.abs(s.normal.x) > 0.05 and math.abs(dx) > 1 then
        local line = {
          ax = s.a.x, ay = s.a.y, k = (s.b.y - s.a.y) / dx,
          xMin = math.min(s.a.x, s.b.x), xMax = math.max(s.a.x, s.b.x),
        }
        local c0 = math.floor((line.xMin - g.x0) / CELL)
        local c1 = math.floor((line.xMax - g.x0) / CELL)
        for c = c0, c1 do
          local xc = math.max(line.xMin, math.min(line.xMax, g.x0 + (c + 0.5) * CELL))
          local y = line.ay + (xc - line.ax) * line.k
          -- From the cell the floor runs through, up to the first open one.
          local r = math.floor((y + 0.5 - g.y0) / CELL)
          for _ = 1, 3 do
            if inside(c, r) and taken(c, r) then r = r - 1 end
          end
          if inside(c, r) and not taken(c, r) then
            g.slope[r * cols + c + 1] = line
          end
        end
      end
    end
  end

  -- The map's lava tiles (see TiledTerrain.lua's lavaTiles): the lava
  -- starts out in them, a cell short of the top (where its surface used
  -- to sit), or right to the top under more lava.
  local lavaAt = {}
  for _, t in ipairs(level.lavaTiles or {}) do lavaAt[t.x0 .. "," .. t.y0] = true end
  for _, t in ipairs(level.lavaTiles or {}) do
    local full = lavaAt[t.x0 .. "," .. (t.y0 - t.size)]
    local c0 = math.floor((t.x0 - g.x0) / CELL + 0.5)
    local r0 = math.floor((t.y0 - g.y0) / CELL + 0.5)
    local n = math.floor(t.size / CELL + 0.5)
    for r = full and r0 or r0 + 1, r0 + n - 1 do
      for c = c0, c0 + n - 1 do
        local i = r * cols + c + 1
        if inside(c, r) and not g.solid[i] then g.lava[i] = 1 end
      end
    end
  end

  grid = g
end

local function cellOf(x, y)
  return math.floor((x - grid.x0) / CELL), math.floor((y - grid.y0) / CELL)
end

local function inGrid(c, r)
  return c >= 0 and c < grid.cols and r >= 0 and r < grid.rows
end

-- Closed gates (see Gate.lua) hold water back too, while they're closed.
local function gateCovers(c, r)
  local x, y = grid.x0 + (c + 0.5) * CELL, grid.y0 + (r + 0.5) * CELL
  for _, gate in ipairs(state.gates or {}) do
    if gate.halfHeight > 1 and math.abs(x - gate.pos.x) <= gate.halfWidth
        and math.abs(y - gate.pos.y) <= gate.halfHeight then
      return true
    end
  end
  return false
end

local function isSolid(c, r)
  if r >= grid.rows then return true end            -- the dome floor
  if c < 0 or c >= grid.cols or r < 0 then return false end
  return grid.solid[r * grid.cols + c + 1] or gateCovers(c, r)
end

-- Whether water at (c, r) can't move (dc, dr) cells over: into something
-- solid, or into a floor cell from the floor's open side — against its
-- normal (down onto a ledge's top, or into a slope from the side it
-- faces). Sideways into a flat floor, or up through one, it can.
local function blocked(c, r, dc, dr)
  local nc, nr = c + dc, r + dr
  if isSolid(nc, nr) then return true end
  if nc < 0 or nc >= grid.cols or nr < 0 then return false end
  local floors = grid.floor[nr * grid.cols + nc + 1]
  if floors then
    for _, n in ipairs(floors) do
      if n.x * dc + n.y * dr < -0.1 then return true end
    end
  end
  return false
end

-- (key: which liquid — "water", the default, or "lava".)
local function addWater(c, r, amount, key)
  if amount <= 0 or not inGrid(c, r) then return end
  local i = r * grid.cols + c + 1
  local liquid = grid[key or "water"]
  liquid[i] = (liquid[i] or 0) + amount
end

-- Water `w` in level cell i (column c, row r) spreading sideways along
-- whatever it's resting on (ground, or full water) — toward lower
-- neighbors, evening out into a flat surface. Returns what's left in it.
-- (liquid: WATER or LAVA — which table, and how runny.)
local function spreadSideways(i, w, c, r, liquid)
  local cols, water = grid.cols, grid[liquid.key]
  local resting = blocked(c, r, 0, 1) or (water[i + cols] or 0) >= 0.99
  if resting and w > liquid.minSpread then
    for k = 1, 2 do
      local dc = ((k == 1) == grid.flip) and -1 or 1
      local nc = c + dc
      if nc < 0 or nc >= cols then
        w = w - w * liquid.spread -- off the map's edge: it runs away
      elseif not blocked(c, r, dc, 0) then
        local n = i + dc
        local wn = water[n] or 0
        if wn < w then
          local f = (w - wn) * liquid.spread
          water[n] = wn + f
          w = w - f
        end
      end
    end
  end
  return w
end

-- One step of the water (or lava: liquid, default WATER) moving: bottom
-- rows first, so each bit of it moves once per step — then passes - 1
-- more passes of it just spreading sideways.
local function stepWater(dt, liquid)
  liquid = liquid or WATER
  local cols, water = grid.cols, grid[liquid.key]
  local list = {}
  for i in pairs(water) do list[#list + 1] = i end
  table.sort(list, function(a, b) return a > b end)
  grid.flip = not grid.flip -- which side spreads first, alternated so it doesn't lean one way

  for _, i in ipairs(list) do
    local w = water[i]
    if w then
      local r = math.floor((i - 1) / cols)
      local c = (i - 1) - r * cols

      -- Overfull (a droplet landed on a full cell): the extra goes up.
      if w > 1 and r > 0 and not blocked(c, r, 0, -1) then
        water[i - cols] = (water[i - cols] or 0) + (w - 1)
        w = 1
      end

      -- Falls into the cell below, as much as fits.
      if not blocked(c, r, 0, 1) then
        local below = water[i + cols] or 0
        local f = math.min(w, 1 - below)
        if f > 0 then
          water[i + cols] = below + f
          w = w - f
        end
      end

      w = spreadSideways(i, w, c, r, liquid)

      -- Evaporates from the surface (nothing on top of it).
      if r == 0 or not water[i - cols] then
        w = w - liquid.evaporate * dt
      end

      if w < DRY then water[i] = nil else water[i] = w end
    end
  end

  for _ = 2, liquid.passes do
    grid.flip = not grid.flip
    -- (Any order: only falling needs the bottom rows first.)
    list = {}
    for i in pairs(water) do list[#list + 1] = i end
    for _, i in ipairs(list) do
      local w = water[i]
      if w then
        local r = math.floor((i - 1) / cols)
        w = spreadSideways(i, w, (i - 1) - r * cols, r, liquid)
        if w < DRY then water[i] = nil else water[i] = w end
      end
    end
  end
end


----------------------------------------------------------------------
-- Water on a dirt planet (CrackedPlanetoid.lua — one built from a Tiled
-- map, say)
----------------------------------------------------------------------
--
-- The same water as on the level, on a grid of its own bent round the
-- planet: columns going round it, rows going in toward its center, each
-- cell CELL deep (a 64-unit tile is 4 rows) and PLANET_CELLS_PER_TILE
-- across a tile. "Down" is toward the center, so water falls inward,
-- spreads round along whatever it's resting on, runs down slopes and
-- curves a cell at a time, gathers in pits, caves and tunnels, and
-- evaporates off the top — the same rules stepWater uses, the grid
-- wrapping all the way round. A few rows of open air above the surface
-- (PLANET_ROWS_ABOVE) let it puddle on top too. Solid is whatever the
-- planet itself says is solid at a cell's middle, so its shaped tiles
-- hold water exactly where their art is; when a shot blows dirt out
-- (see CrackedPlanetoid:takeHit's dirtChanges), the cells there open up.
--
-- When the planet's gravity is switched to straight down or up the
-- screen (see CrackedPlanetoid:cycleGravity), the water moves onto a
-- second layout of the grid: flat, square cells over the whole planet,
-- rows running the way gravity pulls (row 0 the highest), so pools lie
-- level across the screen. Water that runs off its edges, or falls
-- past its bottom, is gone into space. Switching back moves it back
-- (see convertPlanetGrid). Both layouts measure a cell's height the
-- same way — its distance "up" (out from the center, or up the
-- screen) — so the rest of the code here works on either.
--
-- A turning planet (see CrackedPlanetoid:toggleSpin — either way) takes the round
-- layout round with it, water and all — its cells stay put on the dirt.
-- The flat layout stays put, so its cells are looked at again as the
-- dirt turns through them (FLAT_SWEEP_ROWS rows a frame), and water in
-- a cell the dirt turns into is pushed up out of it.

local PLANET_CELLS_PER_TILE = 4  -- across a tile, round the planet
local PLANET_ROWS_ABOVE = 4      -- rows of open air over its surface, for water lying on top
local PLANET_GRID_MAKE_DISTANCE = 3000 -- how near its surface he has to come for its grid to be made
local FLAT_SWEEP_ROWS = 16       -- rows of a turning planet's flat layout looked at again each frame
local TWO_PI = math.pi * 2

-- Keyed by planet (weakly, like oceans).
local planetGrids = setmetatable({}, { __mode = "k" })
planetGridsReset = function()
  planetGrids = setmetatable({}, { __mode = "k" })
end

-- Local point (planet-relative) at column position f (a fraction of
-- columns: c + 0.5 is column c's middle) and height h.
local function planetPoint(g, f, h)
  if g.flat then return -g.top + f * CELL, -g.s * h end
  local a = g.a0 + g.planet.rotationAngle + f * g.dA
  return math.cos(a) * h, math.sin(a) * h
end

-- "Up" (a unit vector) at local point (lx, ly).
local function planetUp(g, lx, ly)
  if g.flat then return 0, -g.s end
  local r = math.sqrt(lx * lx + ly * ly)
  if r < 1e-6 then return 0, -1 end
  return lx / r, ly / r
end

-- How wide a column is at height h.
local function planetColWidth(g, h)
  if g.flat then return CELL end
  return g.dA * math.max(h, 1)
end

-- Column c, wrapped round the planet — or, on the flat layout, nil off
-- its edges.
local function planetCol(g, c)
  if g.flat then
    if c < 0 or c >= g.cols then return nil end
    return c
  end
  return c % g.cols
end

-- Cell (c, r)'s index in the grid, or nil if it's outside it.
local function planetIndex(g, c, r)
  if r < 0 or r >= g.rows then return nil end
  c = planetCol(g, c)
  if not c then return nil end
  return r * g.cols + c + 1
end

local function planetCellCenter(g, c, r)
  return planetPoint(g, c + 0.5, g.top - (r + 0.5) * CELL)
end

-- Works out whether each cell of the grid (or just those in column range
-- c0..c1, rows r0..r1) is solid, from the planet.
local function refreshPlanetSolid(g, c0, c1, r0, r1)
  local p = g.planet
  local reach2 = (p.radius + CELL) ^ 2
  for r = math.max(0, r0), math.min(g.rows - 1, r1) do
    for k = c0, c1 do
      local c = planetCol(g, k)
      if c then
        local x, y = planetCellCenter(g, c, r)
        local i = r * g.cols + c + 1
        g.solid[i] = (x * x + y * y < reach2 and p:solidAtLocal(x, y)) or nil
        -- (Dirt's come into it — turned into it: the water's, and the
        -- lava's, pushed up.)
        for _, liquid in ipairs(g.solid[i] and { g.water, g.lava } or {}) do
          local w = liquid[i]
          if w then
            liquid[i] = nil
            local up = i - g.cols
            if r > 0 and not g.solid[up] then liquid[up] = (liquid[up] or 0) + w end
          end
        end
      end
    end
  end
end

-- Lays grid g out for gravity mode `mode`: round the planet ("core"),
-- or flat ("down", "up"). Empty, and solid worked out afresh.
local function layOutPlanetGrid(g, mode)
  local p = g.planet
  local top = p.radius + PLANET_ROWS_ABOVE * CELL
  g.mode, g.top, g.solid, g.water, g.lava = mode, top, {}, {}, {}
  if mode == "down" or mode == "up" then
    local n = math.ceil(2 * top / CELL)
    g.flat, g.s = true, (mode == "up") and -1 or 1
    g.cols, g.rows = n, n
    g.a0, g.dA = nil, nil
  else
    local ring = p.rings[1]
    g.flat, g.s = false, nil
    g.cols = ring.count * PLANET_CELLS_PER_TILE
    g.rows = math.ceil((top - p.coreRadius) / CELL)
    g.a0, g.dA = ring.offset, TWO_PI / g.cols
  end
  refreshPlanetSolid(g, 0, g.cols - 1, 0, g.rows - 1)
  g.solidAngle, g.sweepRow, g.sweepLeft = p.rotationAngle, 0, 0
end

-- The flat layout of a turning planet: a few more of its rows looked at
-- again (see above), round and round for as long as it's turning, and
-- once all the way through after it stops.
local function sweepTurningPlanetGrid(g)
  if not g.flat then return end
  local a = g.planet.rotationAngle
  if a ~= g.solidAngle then g.solidAngle, g.sweepLeft = a, g.rows end
  if g.sweepLeft <= 0 then return end
  local n = math.min(FLAT_SWEEP_ROWS, g.sweepLeft)
  for k = 0, n - 1 do
    local r = (g.sweepRow + k) % g.rows
    refreshPlanetSolid(g, 0, g.cols - 1, r, r)
  end
  g.sweepRow = (g.sweepRow + n) % g.rows
  g.sweepLeft = g.sweepLeft - n
end

local function newPlanetGrid(p)
  local g = { planet = p, flip = false, changesSeen = #(p.dirtChanges or {}) }
  layOutPlanetGrid(g, "core")
  local cols, top = g.cols, g.top

  -- Every open cell whose middle is in ring `ringIndex`'s tile j filled
  -- with `liquid` — all but its top row, if skipTop.
  local function fillTile(ringIndex, j, liquid, skipTop)
    local wring = p.rings[ringIndex]
    local ta0 = wring.offset + (j - 1) * wring.step
    local c0 = math.floor((ta0 - g.a0) / g.dA) - 1
    local c1 = math.floor((ta0 + wring.step - g.a0) / g.dA) + 1
    local r0 = math.floor((top - wring.outer) / CELL)
    local r1 = math.floor((top - wring.inner) / CELL)
    for r = math.max(0, r0), math.min(g.rows - 1, r1) do
      local rr = top - (r + 0.5) * CELL
      if rr >= wring.inner and rr < wring.outer and not (skipTop and rr >= wring.outer - CELL) then
        for k = c0, c1 do
          local c = k % cols
          local u = ((g.a0 + (c + 0.5) * g.dA - ta0) % TWO_PI) / wring.step
          local i = r * cols + c + 1
          if u < 1 and not g.solid[i] then liquid[i] = 1 end
        end
      end
    end
  end

  -- The map's water tiles (see CrackedPlanetoid.fromTiledMap) start out
  -- full; its lava tiles a cell short of the top (where its surface used
  -- to sit), or right to the top under more lava.
  for _, wt in ipairs(p.waterTiles or {}) do fillTile(wt.ring, wt.j, g.water, false) end
  for _, lt in ipairs(p.lavaTiles or {}) do fillTile(lt.ring, lt.j, g.lava, not lt.full) end
  return g
end

-- Which cell (column, row) world point (x, y) is in, and its height (see
-- above). Rows run from 0 at the top of the grid; round the planet, one
-- past the bottom is the core, one above the top is open space. (The
-- column can be off the flat layout's edges: see planetIndex.)
local function planetCellOf(g, x, y)
  local lx, ly = x - g.planet.pos.x, y - g.planet.pos.y
  if g.flat then
    local h = -g.s * ly
    return math.floor((lx + g.top) / CELL), math.floor((g.top - h) / CELL), h
  end
  local rr = math.sqrt(lx * lx + ly * ly)
  local c = math.floor(((math.atan2(ly, lx) - g.a0 - g.planet.rotationAngle) % TWO_PI) / g.dA) % g.cols
  return c, math.floor((g.top - rr) / CELL), rr
end

-- Dirt that's been blown out since the grid last looked (see
-- CrackedPlanetoid:takeHit): its cells opened up.
local function catchUpPlanetGrid(g)
  local changes = g.planet.dirtChanges
  if not changes then return end
  for k = g.changesSeen + 1, #changes do
    local ch = changes[k]
    local ring = g.planet.rings[ch.ring]
    local a0 = ring.offset + (ch.j - 1) * ring.step
    if g.flat then
      -- (Round the clod's corners and the middle of its outside.)
      local px, py = g.planet.pos.x, g.planet.pos.y
      local turn = g.planet.rotationAngle
      local c0, c1, r0, r1 = math.huge, -math.huge, math.huge, -math.huge
      for _, a in ipairs({ a0, a0 + ring.step / 2, a0 + ring.step }) do
        for _, rr in ipairs({ ring.inner, ring.outer }) do
          local c, r = planetCellOf(g, px + math.cos(a + turn) * rr, py + math.sin(a + turn) * rr)
          c0, c1, r0, r1 = math.min(c0, c), math.max(c1, c), math.min(r0, r), math.max(r1, r)
        end
      end
      refreshPlanetSolid(g, c0 - 1, c1 + 1, r0 - 1, r1 + 1)
    else
      local c0 = math.floor((a0 - g.a0) / g.dA) - 1
      local c1 = math.floor((a0 + ring.step - g.a0) / g.dA) + 1
      local r0 = math.floor((g.top - ring.outer) / CELL) - 1
      local r1 = math.floor((g.top - ring.inner) / CELL) + 1
      refreshPlanetSolid(g, c0, c1, r0, r1)
    end
  end
  g.changesSeen = #changes
end

local function planetSolid(g, c, r)
  if g.flat then
    local i = planetIndex(g, c, r)
    return i ~= nil and g.solid[i] == true
  end
  if r >= g.rows then return true end -- (the core)
  if r < 0 then return false end
  return g.solid[r * g.cols + (c % g.cols) + 1] == true
end

-- (key: which liquid — "water", the default, or "lava".)
local function addPlanetWater(g, c, r, amount, key)
  if amount <= 0 then return end
  local i = planetIndex(g, c, r)
  if not i then return end
  local liquid = g[key or "water"]
  liquid[i] = (liquid[i] or 0) + amount
end

-- The planet's gravity has been switched (see
-- CrackedPlanetoid:cycleGravity): grid g laid out the new way, its water
-- moved over — each cell's water into whichever new cell its middle is
-- in, the same amount of water (by area). Where that's solid (the two
-- layouts' cells don't line up), into the open cell over it.
local function convertPlanetGrid(g, mode)
  local old = {
    planet = g.planet, flat = g.flat, s = g.s, top = g.top, cols = g.cols, a0 = g.a0, dA = g.dA,
    water = g.water, lava = g.lava,
  }
  layOutPlanetGrid(g, mode)
  local px, py = g.planet.pos.x, g.planet.pos.y
  -- (The lava moved over the same way.)
  for _, key in ipairs({ "water", "lava" }) do
    for i, w in pairs(old[key]) do
      local r = math.floor((i - 1) / old.cols)
      local c = (i - 1) - r * old.cols
      local h = old.top - (r + 0.5) * CELL
      local lx, ly = planetPoint(old, c + 0.5, h)
      local nc, nr, nh = planetCellOf(g, px + lx, py + ly)
      local amount = w * planetColWidth(old, h) / planetColWidth(g, nh)
      for _ = 1, 3 do
        if not planetSolid(g, nc, nr) then break end
        nr = nr - 1
      end
      local ni = planetIndex(g, nc, nr)
      if ni and not planetSolid(g, nc, nr) and amount > 0 then g[key][ni] = (g[key][ni] or 0) + amount end
    end
  end
end

-- The planet grid point (x, y) is in, if any: within its top row of any
-- planet that has one.
local function planetGridAt(x, y)
  for _, g in pairs(planetGrids) do
    local dx, dy = x - g.planet.pos.x, y - g.planet.pos.y
    if dx * dx + dy * dy < g.top * g.top then return g end
  end
  return nil
end

-- Water `w` in planet grid g's cell i (column c, row r) spreading round
-- along whatever it's resting on — spreadSideways, for a planet's grid
-- (the columns wrapping all the way round; off the flat layout's edges,
-- it runs away). Returns what's left in it.
local function spreadPlanetSideways(g, i, w, c, r, liquid)
  local cols, water = g.cols, g[liquid.key]
  local resting = planetSolid(g, c, r + 1) or (water[i + cols] or 0) >= 0.99
  if resting and w > liquid.minSpread then
    for k = 1, 2 do
      local dc = ((k == 1) == g.flip) and -1 or 1
      local nc = planetCol(g, c + dc)
      if not nc then
        w = w - w * liquid.spread
      elseif not planetSolid(g, nc, r) then
        local n = r * cols + nc + 1
        local wn = water[n] or 0
        if wn < w then
          local f = (w - wn) * liquid.spread
          water[n] = wn + f
          w = w - f
        end
      end
    end
  end
  return w
end

-- One step of a planet's water (or lava: liquid, default WATER) moving —
-- stepWater's rules, with "down" toward the center (or down the flat
-- layout's rows) and the columns wrapping all the way round.
local function stepPlanetWater(g, dt, liquid)
  liquid = liquid or WATER
  local cols, water = g.cols, g[liquid.key]
  local list = {}
  for i in pairs(water) do list[#list + 1] = i end
  table.sort(list, function(a, b) return a > b end) -- (lowest rows first)
  g.flip = not g.flip

  for _, i in ipairs(list) do
    local w = water[i]
    if w then
      local r = math.floor((i - 1) / cols)
      local c = (i - 1) - r * cols

      if w > 1 and r > 0 and not planetSolid(g, c, r - 1) then
        water[i - cols] = (water[i - cols] or 0) + (w - 1)
        w = 1
      end

      if g.flat and r == g.rows - 1 then
        w = 0 -- (falling out of the bottom of the grid: gone into space)
      elseif not planetSolid(g, c, r + 1) then
        local below = water[i + cols] or 0
        local f = math.min(w, 1 - below)
        if f > 0 then
          water[i + cols] = below + f
          w = w - f
        end
      end

      w = spreadPlanetSideways(g, i, w, c, r, liquid)

      if r == 0 or not water[i - cols] then
        w = w - liquid.evaporate * dt
      end

      if w < DRY then water[i] = nil else water[i] = w end
    end
  end

  for _ = 2, liquid.passes do
    g.flip = not g.flip
    -- (Any order: only falling needs the bottom rows first.)
    list = {}
    for i in pairs(water) do list[#list + 1] = i end
    for _, i in ipairs(list) do
      local w = water[i]
      if w then
        local r = math.floor((i - 1) / cols)
        w = spreadPlanetSideways(g, i, w, (i - 1) - r * cols, r, liquid)
        if w < DRY then water[i] = nil else water[i] = w end
      end
    end
  end
end

-- How high the water's surface is over cell (c, r), if it's wet: up its
-- column through the water to the top.
local function planetSurfaceAt(g, c, r)
  local water, cols = g.water, g.cols
  local i = r * cols + c + 1
  if not water[i] then return nil end
  while r > 0 and water[i - cols] do i, r = i - cols, r - 1 end
  return g.top - (r + 1) * CELL + math.min(1, water[i]) * CELL
end

-- Boils `amount` off the surface round cell (c, r) (the same as
-- boilGrid, for a planet's grid). Returns a point on the surface there
-- and which way is up from it, or nil once there's no water left round it.
local function boilPlanetGrid(g, c, r, amount)
  local water, cols = g.water, g.cols
  local cells = {}
  for dr = -BOIL_REACH_CELLS - 2, BOIL_REACH_CELLS do
    for dc = -BOIL_REACH_CELLS, BOIL_REACH_CELLS do
      local nc, nr = planetCol(g, c + dc), r + dr
      if nc and nr >= 0 and nr < g.rows then
        local i = nr * cols + nc + 1
        if water[i] and (nr == 0 or not water[i - cols]) then cells[#cells + 1] = { i = i, c = nc, r = nr } end
      end
    end
  end
  if #cells == 0 then return nil end
  local share = amount / #cells
  for _, cell in ipairs(cells) do
    local w = water[cell.i] - share
    if w < DRY then water[cell.i] = nil else water[cell.i] = w end
  end
  local pick = cells[math.random(#cells)]
  local h = planetSurfaceAt(g, pick.c, pick.r) or (g.top - (pick.r + 1) * CELL)
  local lx, ly = planetPoint(g, pick.c + math.random(), h)
  local ux, uy = planetUp(g, lx, ly)
  return g.planet.pos.x + lx, g.planet.pos.y + ly, ux, uy
end

----------------------------------------------------------------------
-- Swimming
----------------------------------------------------------------------

-- Whether the point (x, y) is in water — real water, not just a damp
-- film on the floor (see Player:tryGroundPound).
function WaterSystem.wetAt(x, y)
  local pg = planetGridAt(x, y)
  if pg then
    local c, r, rr = planetCellOf(pg, x, y)
    local i = planetIndex(pg, c, r)
    if not i then return false end
    local w = pg.water[i]
    if r > 0 and pg.water[i - pg.cols] then return true end
    return w ~= nil and w >= 0.3 and rr < pg.top - (r + 1) * CELL + w * CELL
  end
  if not grid then return false end
  local c, r = cellOf(x, y)
  if not inGrid(c, r) then return false end
  local i = r * grid.cols + c + 1
  local w = grid.water[i]
  if r > 0 and grid.water[i - grid.cols] then return true end
  return w ~= nil and w >= 0.3 and y > grid.y0 + (r + 1) * CELL - w * CELL
end

-- The pool Bob's middle is under, if any (see Player.lua's submergedIn).
-- That includes a planetoid's water layer: round, it's like a little water
-- planet — centered on the planetoid — so it's handed to his swim code
-- the same way one is. Round a rounded rectangle, it's handed over as a
-- huge round one centered far down past the nearest bit of surface (the
-- same trick as a pool, below), so its surface there is near enough flat.
function WaterSystem.submergedAt(player)
  local x, y = player.pos.x, player.pos.y
  for p, o in pairs(oceans) do
    local depth = depthOf(p, o.volume)
    local d, nx, ny = surfaceDistance(p, x, y)
    if d < depth then
      if p.isRoundedRect then
        local far = 100000
        o.farPos = o.farPos or Vector2.new(0, 0)
        o.farPos.x, o.farPos.y = x - nx * (d + far), y - ny * (d + far)
        o.water.pos, o.water.radius = o.farPos, far + depth
      else
        o.water.pos, o.water.radius = p.pos, p.radius + depth
      end
      return o.water
    end
  end
  -- A dirt planet's water: the same trick, with "straight up" being
  -- straight out from the planet's center (or up the screen, or down
  -- it, with its gravity switched).
  local pg = planetGridAt(x, y)
  if pg then
    local c, r, rr = planetCellOf(pg, x, y)
    local i = planetIndex(pg, c, r)
    if not i then return nil end
    local w = pg.water[i]
    local covered = (r > 0 and pg.water[i - pg.cols]) or (w and rr < pg.top - (r + 1) * CELL + w * CELL)
    if not covered then return nil end
    local surfaceR = planetSurfaceAt(pg, c, r) or rr
    local ux, uy = planetUp(pg, x - pg.planet.pos.x, y - pg.planet.pos.y)
    local far = 100000
    poolWater.pos.x, poolWater.pos.y = x - ux * far, y - uy * far
    poolWater.radius = far + (surfaceR - rr)
    return poolWater
  end

  if not grid then return nil end
  local c, r = cellOf(x, y)
  if not inGrid(c, r) then return nil end
  local i = r * grid.cols + c + 1
  local w = grid.water[i]
  local covered = (r > 0 and grid.water[i - grid.cols])
    or (w and y > grid.y0 + (r + 1) * CELL - w * CELL)
  if not covered then return nil end
  -- The surface above him: up the column while there's water.
  local top = r
  while top > 0 and grid.water[(top - 1) * grid.cols + c + 1] do top = top - 1 end
  local surfaceY = grid.y0 + (top + 1) * CELL - math.min(1, grid.water[top * grid.cols + c + 1] or 1) * CELL
  poolWater.pos.x, poolWater.pos.y = x, y + 100000
  -- Like a water planet's radius: center to surface. (His bubbles rise
  -- from him out to this, i.e. straight up to the pool's surface.)
  poolWater.radius = poolWater.pos.y - surfaceY
  return poolWater
end

----------------------------------------------------------------------
-- Spraying and droplets
----------------------------------------------------------------------

local function canSpray(player)
  return player and (player.mode == "space" or player.mode == "platform")
    and not (player.isBall or player.isTeleporting or player.isDying or player.inPinball
      or player.portalTransit or state.vatsActive or state.introLocked or state.titleScreen)
end

-- (lava: lava splashing, drawn hot instead of watery.)
local function spawnSplash(x, y, upX, upY, lava)
  for _ = 1, SPLASH_BITS do
    local a = math.atan2(upY, upX) + (math.random() * 2 - 1) * 1.1
    local speed = 1.5 + math.random() * 2.5
    table.insert(splashes, {
      x = x, y = y, vx = math.cos(a) * speed, vy = math.sin(a) * speed,
      gx = -upX * 0.3, gy = -upY * 0.3,
      life = SPLASH_SECONDS, size = 1 + math.random() * 1.5, lava = lava,
    })
  end
end

-- Which way gravity pulls a droplet: straight down on the level (the
-- dome's gravity); toward whatever it was sprayed near, anywhere else.
local function gravityOn(d)
  if grid then
    local c, r = cellOf(d.x, d.y)
    if inGrid(c, r) then
      local dome = state.skyDomePlanet
      return 0, (dome and dome.gravityStrength) or constants.GRAVITY_STRENGTH
    end
  end
  local p = d.planet
  if not p then return 0, 0 end
  local s = p.gravityStrength or constants.GRAVITY_STRENGTH
  if p.isSkyDome or p.forceUprightJump then return 0, s end
  if p.isRoundedRect and not p.isCrackedPlanet then -- (a dirt planet pulls its own way: below)
    local n = p:nearestSurfacePoint(d.x, d.y).normal
    return -n.x * s, -n.y * s
  end
  if p.gravityDirAt then
    local dir = p:gravityDirAt(d.x, d.y)
    return dir.x * s, dir.y * s
  end
  local dx, dy = p.pos.x - d.x, p.pos.y - d.y
  local len = math.sqrt(dx * dx + dy * dy)
  if len < 1e-6 then return 0, 0 end
  return dx / len * s, dy / len * s
end

local function spray(player, dt)
  -- At the cap: a thin dribble that carries no water.
  local empty = totalWater >= WATER_CAP
  sprayBudget = sprayBudget + SPRAY_PER_SECOND * (empty and SPUTTER_FRACTION or 1) * dt
  local ox, oy = player:getMuzzlePosition()
  local aim = (player.aimWorldAngle or 0) + (player.blasterAngleOffset or 0)
  -- What the spray falls toward: what he's on, or what's pulling him —
  -- for a water planet's water body (see WaterPlanet.lua), the planetoid
  -- under the water, so it joins that water.
  local sprayPlanet = player.onSurface and player.currentPlanet or player.lastInfluencePlanet
  if sprayPlanet and sprayPlanet.isWaterPlanet and sprayPlanet.core then sprayPlanet = sprayPlanet.core end
  while sprayBudget >= 1 do
    sprayBudget = sprayBudget - 1
    -- (Checked per droplet too, so one long frame can't spray past it.)
    empty = empty or totalWater >= WATER_CAP
    if #droplets < MAX_DROPLETS then
      local a = aim + (math.random() * 2 - 1) * SPRAY_SPREAD * (empty and 2 or 1)
      local speed = (SPRAY_SPEED + math.random() * SPRAY_SPEED_RANGE) * (empty and 0.4 or 1)
      local vx, vy = math.cos(a) * speed + player.vel.x, math.sin(a) * speed + player.vel.y
      -- One step back: the droplet update right after this (same frame,
      -- before drawing) brings it out of the muzzle itself, not a step
      -- beyond it.
      local ts = state.timeScale or 1
      table.insert(droplets, {
        x = ox - vx * ts, y = oy - vy * ts,
        vx = vx, vy = vy,
        life = DROPLET_SECONDS,
        volume = empty and 0 or DROPLET_VOLUME,
        planet = sprayPlanet,
      })
      if not empty then totalWater = totalWater + DROPLET_VOLUME end
    end
  end
end

-- Moves a droplet; true once it's landed (or gone).
local spawnSteam -- (defined with the steam, further down)

local function updateDroplet(d, ts, dt)
  d.life = d.life - dt
  if d.life <= 0 then return true end
  local gx, gy = gravityOn(d)
  d.vx, d.vy = d.vx + gx * ts, d.vy + gy * ts
  local px, py = d.x, d.y
  d.x, d.y = d.x + d.vx * ts, d.y + d.vy * ts

  -- Into a portal: straight out of the other one (before anything can
  -- see it hit the surface the portal's on), pulled from then on by
  -- whatever's at the far side.
  local nx, ny, nvx, nvy, to = PortalGun.passPoint(d.x, d.y, d.vx, d.vy, 3, ts)
  if nx then
    d.x, d.y, d.vx, d.vy = nx, ny, nvx, nvy
    if not (to.obj.isWall or to.obj.isGate) then d.planet = to.obj end
    return false
  end

  local volume = d.volume or DROPLET_VOLUME
  -- (A droplet of lava — out of a portal lava's run into, see
  -- drainIntoPortals — lands as lava. Either kind lands in a pool of
  -- either: water and lava meeting that way turn to obsidian.)
  local key = d.lava and "lava" or "water"

  -- Onto a dirt planet's water grid: the same landing as on the level's
  -- (below), in its own cells.
  local pg = planetGridAt(d.x, d.y)
  if pg then
    local dist = math.sqrt((d.x - px) ^ 2 + (d.y - py) ^ 2)
    local steps = math.max(1, math.ceil(dist / (CELL * 0.5)))
    local lastC, lastR = planetCellOf(pg, px, py)
    for s = 1, steps do
      local x, y = px + (d.x - px) * s / steps, py + (d.y - py) * s / steps
      local c, r = planetCellOf(pg, x, y)
      if planetSolid(pg, c, r) then
        if not planetSolid(pg, lastC, lastR) then addPlanetWater(pg, lastC, lastR, volume, key) end
        local speed = math.max(1e-6, math.sqrt(d.vx * d.vx + d.vy * d.vy))
        spawnSplash(x, y, -d.vx / speed, -d.vy / speed, d.lava)
        return true
      end
      local i = planetIndex(pg, c, r)
      if i and (pg.water[i] or 0) + (pg.lava[i] or 0) >= HITS_POOL then
        addPlanetWater(pg, c, r, volume, key)
        local ux, uy = planetUp(pg, x - pg.planet.pos.x, y - pg.planet.pos.y)
        spawnSplash(x, y, ux, uy, d.lava)
        return true
      end
      lastC, lastR = c, r
    end
    return false
  end

  if grid then
    -- Along this frame's path in short steps: the first solid cell it
    -- reaches, it lands in the open cell just before it; the first pool
    -- it reaches, it lands in that.
    local dist = math.sqrt((d.x - px) ^ 2 + (d.y - py) ^ 2)
    local steps = math.max(1, math.ceil(dist / (CELL * 0.5)))
    local lastC, lastR = cellOf(px, py)
    -- Below the level counts as its floor — except on the way to a round
    -- planetoid out there.
    local floorBelow = not holdsWater(d.planet)
    for s = 1, steps do
      local x, y = px + (d.x - px) * s / steps, py + (d.y - py) * s / steps
      local c, r = cellOf(x, y)
      if inGrid(c, r) or (floorBelow and r >= grid.rows) then
        local speed = math.sqrt(d.vx * d.vx + d.vy * d.vy)
        -- (A floor stops it only coming from its open side — see blocked.)
        if isSolid(c, r) or ((c ~= lastC or r ~= lastR) and blocked(lastC, lastR, c - lastC, r - lastR)) then
          if not isSolid(lastC, lastR) then addWater(lastC, lastR, volume, key) end
          spawnSplash(x, y, -d.vx / speed, -d.vy / speed, d.lava)
          return true
        end
        local i = r * grid.cols + c + 1
        if (grid.water[i] or 0) + (grid.lava[i] or 0) >= HITS_POOL then
          addWater(c, r, volume, key)
          spawnSplash(x, y, 0, -1, d.lava)
          return true
        end
      end
      lastC, lastR = c, r
    end
  end

  -- On a planetoid that holds water (the grid's bounds can take in
  -- planetoids that aren't part of the level): it joins the layer of
  -- water round it (see addToOcean) — reaching that layer's surface, or
  -- the planetoid itself if it has none yet.
  local p = d.planet
  if grid then
    local c, r = cellOf(d.x, d.y)
    if inGrid(c, r) and not holdsWater(p) then return false end
  end
  if holdsWater(p) then
    local o = oceans[p]
    local depth = o and depthOf(p, o.volume) or 0
    local sd, nx, ny = surfaceDistance(p, d.x, d.y)
    if sd < depth + 2 then
      if d.lava then
        -- (Lava into a planetoid's water goes out in a puff of steam;
        -- onto a bare one, it splashes and is gone.)
        if depth > 0 then
          for _ = 1, 4 do spawnSteam(d.x, d.y, nx, ny, 0.8) end
        else
          spawnSplash(d.x, d.y, nx, ny, true)
        end
        return true
      end
      if volume > 0 then addToOcean(p, volume) end
      spawnSplash(d.x, d.y, nx, ny)
      return true
    end
    return false
  end

  -- Anywhere else off the level: it splashes on whatever it was sprayed
  -- near and is gone.
  if p and not p.isSkyDome and not p.forceUprightJump then
    local dist
    if p.isRoundedRect then
      dist = p:nearestSurfacePoint(d.x, d.y).distance
    else
      dist = math.sqrt((d.x - p.pos.x) ^ 2 + (d.y - p.pos.y) ^ 2) - p.radius
    end
    if dist < 3 then
      local gx2, gy2 = gravityOn(d)
      local g = math.sqrt(gx2 * gx2 + gy2 * gy2)
      if g > 0 then spawnSplash(d.x, d.y, -gx2 / g, -gy2 / g, d.lava) end
      return true
    end
  end
  return false
end

-- Water on the level resting against a portal's opening drains into it
-- (spread across the cells just in front of the opening, up to
-- PORTAL_FLOW_PER_SECOND), and comes out of the other portal as a jet of
-- droplets — which then fly, fall and pool wherever they land, like any
-- other spray. Not into a ceiling portal: water doesn't flow up.
-- (The same for a dirt planet's water — see "Water on a dirt planet" —
-- on whichever grid the water just in front of a portal is in: there,
-- a ceiling portal is one facing in toward the planet's center.)
-- Lava goes through the same way, more slowly (LAVA_TUNING.PORTAL_FLOW),
-- as a jet of lava droplets that land as lava.
local portalDrained = {} -- (keyed by portal color and liquid: "redwater", "bluelava", ...)
local portalTakenIn = {} -- (all-time totals of water, per portal color: see WaterSystem.debugPortalFlow)
local function drainIntoPortals(dt)
  local portals = state.portals
  if not (portals and portals.red and portals.blue) then return end
  for _, color in ipairs({ "red", "blue" }) do
    local p = portals[color]
    if p.mouth then
      -- The open cells just in front of its opening, on the level's grid
      -- or a planet's, each with the grid it's in — left out wherever the
      -- opening faces down (nothing flows up into it).
      local seen, mouthCells = {}, {}
      for _, m in ipairs(p.mouth) do
        local x, y = m.x + m.nx * CELL * 0.5, m.y + m.ny * CELL * 0.5
        local pg = planetGridAt(x, y)
        local g, i
        if pg then
          local c, r = planetCellOf(pg, x, y)
          local ux, uy = planetUp(pg, x - pg.planet.pos.x, y - pg.planet.pos.y)
          local facingDown = -(m.nx * ux + m.ny * uy) > 0.3
          local k = planetIndex(pg, c, r)
          if k and not planetSolid(pg, c, r) and not facingDown then g, i = pg, k end
        elseif grid and m.ny < 0.3 then
          local c, r = cellOf(x, y)
          if inGrid(c, r) and not isSolid(c, r) then g, i = grid, r * grid.cols + c + 1 end
        end
        if g then
          seen[g] = seen[g] or {}
          if not seen[g][i] then
            seen[g][i] = true
            mouthCells[#mouthCells + 1] = { g = g, i = i, x = x, y = y }
          end
        end
      end

      for _, liquid in ipairs({ WATER, LAVA }) do
        local slot = color .. liquid.key
        local flow = liquid == LAVA and LAVA_TUNING.PORTAL_FLOW or PORTAL_FLOW_PER_SECOND
        local share = #mouthCells > 0 and flow * dt / #mouthCells or 0
        local wet = {}
        for _, mc in ipairs(mouthCells) do
          local store = mc.g[liquid.key]
          local w = store[mc.i]
          if w then
            local f = math.min(w, share)
            w = w - f
            store[mc.i] = (w >= DRY) and w or nil
            portalDrained[slot] = (portalDrained[slot] or 0) + f
            if liquid == WATER then portalTakenIn[color] = (portalTakenIn[color] or 0) + f end
            wet[#wet + 1] = mc
          end
        end

        -- Out of the other portal, a droplet per PORTAL_JET_VOLUME taken in.
        while (portalDrained[slot] or 0) >= PORTAL_JET_VOLUME and #wet > 0 and #droplets < MAX_DROPLETS do
          portalDrained[slot] = portalDrained[slot] - PORTAL_JET_VOLUME
          local at = wet[math.random(#wet)]
          local a = math.atan2(-p.ny, -p.nx) + (math.random() * 2 - 1) * PORTAL_JET_SPREAD
          local speed = PORTAL_JET_SPEED + math.random() * PORTAL_JET_SPEED_RANGE
          local x, y, vx, vy, to = PortalGun.throughPortal(p, at.x, at.y, math.cos(a) * speed, math.sin(a) * speed, 4)
          if x then
            -- Water out onto a round planetoid: straight into its water
            -- (see drainOceansIntoPortals), the jet just for show.
            local intoOcean = liquid == WATER and holdsWater(to.obj)
            if intoOcean then addToOcean(to.obj, PORTAL_JET_VOLUME) end
            table.insert(droplets, {
              x = x, y = y, vx = vx, vy = vy, life = DROPLET_SECONDS,
              volume = intoOcean and 0 or PORTAL_JET_VOLUME,
              planet = not (to.obj.isWall or to.obj.isGate) and to.obj or nil,
              lava = liquid == LAVA or nil,
            })
          end
        end
        if #wet == 0 then portalDrained[slot] = 0 end
      end
    end
  end
end

-- A planetoid's water layer (see addToOcean) flowing into a portal under
-- it, and out of the other portal as a jet — which joins whatever's over
-- there: the other planetoid's water, a pool on the level, ... It flows
-- faster the deeper the water over this portal is than over the other
-- one (none over there: zero), so two planetoids' water linked by
-- portals levels out, each at the same depth over its portal; a deeper
-- far side flows back this way instead (on its own turn).
local oceanDrained = {}
local function drainOceansIntoPortals(dt)
  local portals = state.portals
  if not (portals and portals.red and portals.blue) then return end
  for _, color in ipairs({ "red", "blue" }) do
    local p = portals[color]
    local other = portals[color == "red" and "blue" or "red"]
    local o = oceans[p.obj]
    if o and p.x then
      local here = depthOf(p.obj, o.volume)
      local there = 0
      local far = oceans[other.obj]
      if far then there = depthOf(other.obj, far.volume) end
      local diff = here - there
      if diff > OCEAN_LEVEL_SLACK then
        local f = math.min(PORTAL_FLOW_PER_SECOND, diff * OCEAN_LEVEL_RATE) * dt
        f = math.min(f, o.volume)
        o.volume = o.volume - f
        -- Onto another round planetoid: straight into its water (a jet
        -- out of the portal on top of one would only fall back into it).
        local intoOcean = holdsWater(other.obj)
        if intoOcean then addToOcean(other.obj, f) end
        oceanDrained[color] = (oceanDrained[color] or 0) + f

        -- Out of the other portal, a droplet per PORTAL_JET_VOLUME taken
        -- in (into this one along the mouth, straight out of the other) —
        -- just for show if the water's already gone into a planetoid's.
        while oceanDrained[color] >= PORTAL_JET_VOLUME and #droplets < MAX_DROPLETS do
          oceanDrained[color] = oceanDrained[color] - PORTAL_JET_VOLUME
          local m = p.mouth and p.mouth[math.random(#p.mouth)] or { x = p.x, y = p.y, nx = p.nx, ny = p.ny }
          local a = math.atan2(-m.ny, -m.nx) + (math.random() * 2 - 1) * PORTAL_JET_SPREAD
          local speed = PORTAL_JET_SPEED + math.random() * PORTAL_JET_SPEED_RANGE
          local x, y, vx, vy, to = PortalGun.throughPortal(p, m.x + m.nx * 2, m.y + m.ny * 2,
            math.cos(a) * speed, math.sin(a) * speed, 4)
          if x then
            table.insert(droplets, {
              x = x, y = y, vx = vx, vy = vy, life = DROPLET_SECONDS,
              volume = intoOcean and 0 or PORTAL_JET_VOLUME,
              planet = not (to.obj.isWall or to.obj.isGate) and to.obj or nil,
            })
          end
        end
      end
    end
  end
end

----------------------------------------------------------------------
-- Update / draw
----------------------------------------------------------------------

-- dt: real seconds.
----------------------------------------------------------------------
-- Fireballs and steam
----------------------------------------------------------------------

-- A puff of steam off the surface at (x, y), rising away from the water
-- (up: which way that is), within `spread` radians of it. It starts a
-- little below the surface, so it's seen coming up out of the water.
spawnSteam = function(x, y, upX, upY, spread)
  local a = math.atan2(upY, upX) + (math.random() * 2 - 1) * (spread or 0.6)
  local speed = STEAM_RISE * (0.5 + math.random())
  local life = STEAM_SECONDS * (0.7 + math.random() * 0.6)
  local depth = STEAM_START_DEPTH * (0.3 + math.random() * 0.7)
  x, y = x - upX * depth, y - upY * depth
  steam[#steam + 1] = {
    x = x + (math.random() * 2 - 1) * 6, y = y + (math.random() * 2 - 1) * 3,
    vx = math.cos(a) * speed, vy = math.sin(a) * speed, life = life, maxLife = life,
  }
end

-- The water line over grid cell (c, r), if it's wet: up its column
-- through the water to the top.
local function surfaceAt(c, r)
  local water, cols = grid.water, grid.cols
  local i = r * cols + c + 1
  if not water[i] then return nil end
  while r > 0 and water[i - cols] do i, r = i - cols, r - 1 end
  return grid.y0 + (r + 1) * CELL - math.min(1, water[i]) * CELL
end

-- Boils `amount` (cells' worth) off the surface of the water round grid
-- cell (c, r) — shared between the surface cells (nothing on top of them)
-- within BOIL_REACH_CELLS, a little higher up too, since the surface can
-- be above where a fireball got to. Returns where the surface is there
-- (for the steam), or nil once there's no water left round it.
local function boilGrid(c, r, amount)
  local water, cols = grid.water, grid.cols
  local cells = {}
  for dr = -BOIL_REACH_CELLS - 2, BOIL_REACH_CELLS do
    for dc = -BOIL_REACH_CELLS, BOIL_REACH_CELLS do
      local nc, nr = c + dc, r + dr
      if inGrid(nc, nr) then
        local i = nr * cols + nc + 1
        if water[i] and (nr == 0 or not water[i - cols]) then cells[#cells + 1] = { i = i, c = nc, r = nr } end
      end
    end
  end
  if #cells == 0 then return nil end
  local share = amount / #cells
  for _, cell in ipairs(cells) do
    local w = water[cell.i] - share
    if w < DRY then water[cell.i] = nil else water[cell.i] = w end
  end
  local pick = cells[math.random(#cells)]
  return grid.x0 + (pick.c + math.random()) * CELL, surfaceAt(pick.c, pick.r) or (grid.y0 + (pick.r + 1) * CELL)
end

-- Whether fireball `f` has hit water this frame (anywhere along the path
-- it's just moved, so a fast one can't skip over a thin pool). If it has,
-- it goes out: a burst of steam, BOIL_ON_HIT boiled off at once, and a
-- hot spot left there (see WaterSystem.update). The caller removes it.
function WaterSystem.quenchFireball(f)
  local ts = state.timeScale or 1

  -- A planet's water layer (see addToOcean).
  for p, o in pairs(oceans) do
    local depth = depthOf(p, o.volume)
    local d, nx, ny = surfaceDistance(p, f.pos.x, f.pos.y)
    if d < depth then
      o.volume = math.max(0, o.volume - BOIL_ON_HIT)
      -- (Where the water's surface is, out from where it went in.)
      local sx, sy = f.pos.x + nx * (depth - d), f.pos.y + ny * (depth - d)
      for _ = 1, STEAM_BURST do spawnSteam(sx, sy, nx, ny, 1.0) end
      hotSpots[#hotSpots + 1] = {
        planet = p, ox = sx - p.pos.x, oy = sy - p.pos.y, life = HOT_SECONDS, steamBudget = 0,
      }
      return true
    end
  end

  -- A dirt planet's water.
  do
    local x1, y1 = f.pos.x, f.pos.y
    local x0, y0 = x1 - f.vel.x * ts, y1 - f.vel.y * ts
    local dist = math.sqrt((x1 - x0) ^ 2 + (y1 - y0) ^ 2)
    local steps = math.max(1, math.ceil(dist / (CELL * 0.5)))
    for s = 0, steps do
      local x, y = x0 + (x1 - x0) * s / steps, y0 + (y1 - y0) * s / steps
      local pg = planetGridAt(x, y)
      if pg then
        local c, r = planetCellOf(pg, x, y)
        local i = planetIndex(pg, c, r)
        if i and (pg.water[i] or 0) >= QUENCH_AT then
          local sx, sy, upX, upY = boilPlanetGrid(pg, c, r, BOIL_ON_HIT)
          if sx then for _ = 1, STEAM_BURST do spawnSteam(sx, sy, upX, upY, 1.0) end end
          hotSpots[#hotSpots + 1] = { pg = pg, c = c, r = r, life = HOT_SECONDS, steamBudget = 0 }
          return true
        end
      end
    end
  end

  -- The pools and streams on the level.
  if grid then
    local x1, y1 = f.pos.x, f.pos.y
    local x0, y0 = x1 - f.vel.x * ts, y1 - f.vel.y * ts
    local dist = math.sqrt((x1 - x0) ^ 2 + (y1 - y0) ^ 2)
    local steps = math.max(1, math.ceil(dist / (CELL * 0.5)))
    for s = 0, steps do
      local x, y = x0 + (x1 - x0) * s / steps, y0 + (y1 - y0) * s / steps
      local c, r = cellOf(x, y)
      if inGrid(c, r) and (grid.water[r * grid.cols + c + 1] or 0) >= QUENCH_AT then
        local surface = surfaceAt(c, r) or y
        boilGrid(c, r, BOIL_ON_HIT)
        for _ = 1, STEAM_BURST do spawnSteam(x, surface, 0, -1, 1.0) end
        hotSpots[#hotSpots + 1] = { c = c, r = r, life = HOT_SECONDS, steamBudget = 0 }
        return true
      end
    end
  end
  return false
end

----------------------------------------------------------------------
-- Lava meeting water: obsidian
----------------------------------------------------------------------
--
-- Wherever lava touches water (in the same cell, or the one beside, above
-- or below it), the whole tile the lava's in turns to an obsidian block,
-- the way Terraria's does: the lava there soaks into the block (and is
-- kept, for if it melts), the water there is pushed up out of it, and the
-- water where they met boils off in a burst of steam, a hot spot left
-- steaming a while. The block is solid ground — on the level a wall (in
-- level.walls, so Bob walks on it and bumps his head on it, fireballs hit
-- it, and the water and lava treat it as solid), on a dirt planet a clod
-- (see CrackedPlanetoid:setObsidian). Lava.lua's cooling effect plays
-- over it as it forms. A fireball melts it (see WaterSystem.meltObsidian,
-- and CrackedPlanetoid:takeHit's obsidianHits): the melting effect plays,
-- the block still solid, then it's lava again — the lava it soaked up,
-- free to run.
--
-- obsidians holds one entry per block:
--   kind = "level": tc, tr (its tile), x0, y0, size, cells (the grid
--     cells it made solid), wall (its entry in level.walls);
--   kind = "planet": g (the planet's grid), planet, ring, j (its tile);
-- and lava (cells' worth it soaked up), overlay (the Lava.lua effect
-- playing over it, while one is), melting.

local NEIGHBORS = { { 0, 0 }, { -1, 0 }, { 1, 0 }, { 0, -1 }, { 0, 1 } }

local getObsidianImage
do
  local image = nil
  getObsidianImage = function()
    if not image then
      image = love.graphics.newImage("img/obsidian.png")
      image:setFilter("nearest", "nearest")
    end
    return image
  end
end

local function removeFrom(list, item)
  for k = #list, 1, -1 do
    if list[k] == item then
      table.remove(list, k)
      return
    end
  end
end

-- A Lava.lua effect over block `entry`, drawn with the other lava (see
-- main.lua's state.lavas).
local function newOverlay(entry)
  local ov
  if entry.kind == "level" then
    ov = Lava.new(entry.x0, entry.y0, entry.size)
  else
    local ring = entry.planet.rings[entry.ring]
    local a0 = ring.offset + (entry.j - 1) * ring.step
    ov = Lava.newOnRing(entry.planet, ring.inner, ring.outer, a0, a0 + ring.step, false)
  end
  state.lavas = state.lavas or {}
  table.insert(state.lavas, ov)
  return ov
end

-- Steam off the water where it met the lava — water cell (wc, wr) of
-- planet grid pg, or of the level's grid if pg is nil — boiling some of
-- it off, and a hot spot left there. (fx, fy): where it puffs from
-- instead, and (ux, uy) which way's up there, if there's no water left
-- to come off.
local function steamWhereMet(pg, wc, wr, fx, fy, ux, uy)
  local sx, sy, upX, upY
  if pg then
    sx, sy, upX, upY = boilPlanetGrid(pg, wc, wr, LAVA_TUNING.BOIL)
  else
    sx, sy = boilGrid(wc, wr, LAVA_TUNING.BOIL)
    upX, upY = 0, -1
  end
  if not sx then sx, sy, upX, upY = fx, fy, ux, uy end
  for _ = 1, STEAM_BURST do spawnSteam(sx, sy, upX, upY, 1.0) end
  hotSpots[#hotSpots + 1] = { pg = pg, c = wc, r = wr, life = HOT_SECONDS, steamBudget = 0 }
end

-- The level's tile (tc, tr) turned to obsidian, where lava in it met
-- water in cell (wc, wr).
local function hardenLevelTile(tc, tr, wc, wr)
  local g = grid
  local cols, size = g.cols, LAVA_TUNING.TILE_CELLS * CELL
  local x0, y0 = g.x0 + tc * size, g.y0 + tr * size
  local r0 = tr * LAVA_TUNING.TILE_CELLS
  local soaked, cells = 0, {}
  for r = r0, r0 + LAVA_TUNING.TILE_CELLS - 1 do
    for c = tc * LAVA_TUNING.TILE_CELLS, tc * LAVA_TUNING.TILE_CELLS + LAVA_TUNING.TILE_CELLS - 1 do
      local i = r * cols + c + 1
      if inGrid(c, r) and not g.solid[i] then
        soaked = soaked + (g.lava[i] or 0)
        g.lava[i] = nil
        local w = g.water[i]
        if w then
          -- (Pushed up out of it, into the cell just over the block.)
          g.water[i] = nil
          if r0 > 0 and not isSolid(c, r0 - 1) then addWater(c, r0 - 1, w) end
        end
        g.solid[i] = true
        cells[#cells + 1] = i
      end
    end
  end

  local wall = {
    pos = Vector2.new(x0 + size / 2, y0 + size / 2),
    halfWidth = size / 2, halfHeight = size / 2,
    radius = size * 0.7071067811865476,
    isWall = true,
  }
  table.insert(g.level.walls, wall)
  Ice.addTop(wall) -- (a walkable top — see Ice.addTop)
  local entry = {
    kind = "level", tc = tc, tr = tr, x0 = x0, y0 = y0, size = size, cells = cells, wall = wall, lava = soaked,
  }
  wall.obsidian = entry
  entry.overlay = newOverlay(entry)
  entry.overlay:harden()
  obsidians[#obsidians + 1] = entry

  -- If he's in it, he's lifted out on top of it.
  local p = state.player
  if p then
    local qx = math.max(x0, math.min(p.pos.x, x0 + size))
    local qy = math.max(y0, math.min(p.pos.y, y0 + size))
    if (p.pos.x - qx) ^ 2 + (p.pos.y - qy) ^ 2 < p.radius * p.radius then
      p.pos.y = y0 - p.radius - 1
    end
  end

  steamWhereMet(nil, wc, wr, x0 + size / 2, y0, 0, -1)
end

-- The cells of planet grid g whose middles are in ring i's tile j (on
-- whichever layout it has), as { i, r } — deepest first.
local function planetTileCells(g, i, j)
  local p = g.planet
  local ring = p.rings[i]
  local a = ring.offset + (j - 0.5) * ring.step + p.rotationAngle
  local c0, r0 = planetCellOf(g, p.pos.x + math.cos(a) * ring.mid, p.pos.y + math.sin(a) * ring.mid)
  local list = {}
  local reach = LAVA_TUNING.TILE_CELLS + 2
  for r = r0 - reach, r0 + reach do
    for k = c0 - reach, c0 + reach do
      local idx = planetIndex(g, k, r)
      if idx then
        local c = (idx - 1) - r * g.cols
        local ti, tj = p:tileAtLocal(planetCellCenter(g, c, r))
        if ti == i and tj == j then list[#list + 1] = { i = idx, r = r } end
      end
    end
  end
  table.sort(list, function(a1, b1) return a1.r > b1.r end)
  return list
end

-- Planet grid g's planet's tile (ring i, tile j) turned to obsidian,
-- where lava in it met water in cell (wc, wr).
local function hardenPlanetTile(g, i, j, wc, wr)
  local p = g.planet
  local soaked = 0
  for _, cell in ipairs(planetTileCells(g, i, j)) do
    soaked = soaked + (g.lava[cell.i] or 0)
    g.lava[cell.i] = nil
  end
  -- (Its water's pushed up out of it once the grid sees the block — see
  -- catchUpPlanetGrid.)
  p:setObsidian(i, j, true)
  local entry = { kind = "planet", g = g, planet = p, ring = i, j = j, lava = soaked }
  entry.overlay = newOverlay(entry)
  entry.overlay:harden()
  obsidians[#obsidians + 1] = entry

  local ring = p.rings[i]
  local a = ring.offset + (j - 0.5) * ring.step + p.rotationAngle
  local ux, uy = math.cos(a), math.sin(a)
  steamWhereMet(g, wc, wr, p.pos.x + ux * ring.outer, p.pos.y + uy * ring.outer, ux, uy)
end

-- Lava touching water anywhere on the level: the tile each such bit of
-- lava is in turns to obsidian.
local function quenchLevelLava()
  local g = grid
  local cols, lava, water = g.cols, g.lava, g.water
  if not next(lava) or not next(water) then return end
  local hits = {}
  for i, l in pairs(lava) do
    if l >= LAVA_TUNING.TOUCH then
      local r = math.floor((i - 1) / cols)
      local c = (i - 1) - r * cols
      for _, d in ipairs(NEIGHBORS) do
        local nc, nr = c + d[1], r + d[2]
        if inGrid(nc, nr) and (water[nr * cols + nc + 1] or 0) >= LAVA_TUNING.TOUCH then
          hits[#hits + 1] = { i = i, c = c, r = r, wc = nc, wr = nr }
          break
        end
      end
    end
  end
  for _, h in ipairs(hits) do
    if lava[h.i] then -- (not soaked into a block made just now)
      hardenLevelTile(math.floor(h.c / LAVA_TUNING.TILE_CELLS), math.floor(h.r / LAVA_TUNING.TILE_CELLS), h.wc, h.wr)
    end
  end
end

-- The same on planet grid g.
local function quenchPlanetLava(g)
  local cols, lava, water, p = g.cols, g.lava, g.water, g.planet
  if not next(lava) or not next(water) then return end
  local hits = {}
  for i, l in pairs(lava) do
    if l >= LAVA_TUNING.TOUCH then
      local r = math.floor((i - 1) / cols)
      local c = (i - 1) - r * cols
      for _, d in ipairs(NEIGHBORS) do
        local ni = planetIndex(g, c + d[1], r + d[2])
        if ni and (water[ni] or 0) >= LAVA_TUNING.TOUCH then
          hits[#hits + 1] = { i = i, c = c, r = r, wc = (ni - 1) % cols, wr = r + d[2] }
          break
        end
      end
    end
  end
  for _, h in ipairs(hits) do
    if lava[h.i] then
      local ti, tj = p:tileAtLocal(planetCellCenter(g, h.c, h.r))
      if ti and not p.rings[ti].clods[tj] then
        hardenPlanetTile(g, ti, tj, h.wc, h.wr)
      else
        -- (Lava up over the planet's tiles, or not yet out of one that's
        -- just gone solid: there's no tile for a block, so it just goes
        -- out in a puff of steam.)
        lava[h.i] = nil
        local lx, ly = planetCellCenter(g, h.c, h.r)
        local ux, uy = planetUp(g, lx, ly)
        steamWhereMet(g, h.wc, h.wr, p.pos.x + lx, p.pos.y + ly, ux, uy)
      end
    end
  end
end

-- Starts block `entry` melting (see above).
local function startMelt(entry)
  if entry.melting then return end
  entry.melting = true
  local ov = entry.overlay
  if not ov then
    ov = newOverlay(entry)
    ov.hardened, ov.cool = true, 1
    entry.overlay = ov
  end
  ov:melt()
end

-- A fireball's hit a wall on the level (wall: its entry in level.walls —
-- see main.lua's fireball passes): an obsidian block starts melting back
-- into lava; an ice block (or an Ooomba's ice cube) melts into water
-- (see "Ice"). Any other wall, it does nothing.
function WaterSystem.fireHitsWall(wall)
  if not wall then return end
  if wall.obsidian then startMelt(wall.obsidian) end
  if wall.ice then Ice.melt(wall.ice) end
end
WaterSystem.meltObsidian = WaterSystem.fireHitsWall

-- `amount` cells' worth of lava poured into `cells` ({ i, r }, deepest
-- first) of liquid table `lava`: each row filled before the one over it.
local function pourLava(lava, cells, amount)
  local k = 1
  while k <= #cells and amount > 0 do
    local r, n = cells[k].r, 0
    while cells[k + n] and cells[k + n].r == r do n = n + 1 end
    local each = math.min(1, amount / n)
    for m = k, k + n - 1 do lava[cells[m].i] = (lava[cells[m].i] or 0) + each end
    amount = amount - each * n
    k = k + n
  end
end

-- Block `entry`'s finished melting: it's lava again — the lava it soaked
-- up, poured back into its cells, free to run.
local function finishMelt(entry)
  if entry.kind == "level" then
    local g = grid
    if not g then return end
    local cells = {}
    for _, i in ipairs(entry.cells) do
      g.solid[i] = nil
      cells[#cells + 1] = { i = i, r = math.floor((i - 1) / g.cols) }
    end
    removeFrom(g.level.walls, entry.wall)
    Ice.removeTop(entry.wall)
    table.sort(cells, function(a1, b1) return a1.r > b1.r end)
    pourLava(g.lava, cells, entry.lava)
  else
    entry.planet:setObsidian(entry.ring, entry.j, false)
    pourLava(entry.g.lava, planetTileCells(entry.g, entry.ring, entry.j), entry.lava)
  end
end

-- The blocks' effects playing out: one done forming leaves the block on
-- its own; one done melting is lava again. And blocks on a planet a
-- fireball's hit (see CrackedPlanetoid:takeHit) start melting — obsidian
-- back into lava, ice into water (see "Ice").
local function updateObsidians()
  for _, g in pairs(planetGrids) do
    local hitList = g.planet.blockHits
    if hitList then
      for _, h in ipairs(hitList) do
        for _, e in ipairs(obsidians) do
          if e.planet == g.planet and e.ring == h.ring and e.j == h.j then startMelt(e) end
        end
        for k = #Ice.blocks, 1, -1 do
          local e = Ice.blocks[k]
          if e and e.planet == g.planet and e.ring == h.ring and e.j == h.j then Ice.melt(e) end
        end
      end
      g.planet.blockHits = nil
    end
  end

  for k = #obsidians, 1, -1 do
    local e = obsidians[k]
    local ov = e.overlay
    if ov then
      if e.melting then
        if ov.coolDir == 0 and ov.cool <= 0 then
          removeFrom(state.lavas or {}, ov)
          e.overlay = nil
          finishMelt(e)
          table.remove(obsidians, k)
        end
      elseif ov.cool >= 1 then
        removeFrom(state.lavas or {}, ov)
        e.overlay = nil
      end
    end
  end
end

-- Every cell of the lava's surface (lava with none on top of it) near
-- the screen: fn(x, y, upX, upY, c, r, g, amount) — its point on the surface,
-- which way is up there, its cell (g: its planet grid, or nil for
-- the level's), and how much lava's in it.
local function forEachLavaSurface(fn)
  local cam = state.camera
  if not cam then return end
  local m = CELL * 8
  local vx0, vy0 = cam.x - m, cam.y - m
  local vx1, vy1 = cam.x + (state.visibleWidth or 0) + m, cam.y + (state.visibleHeight or 0) + m
  if grid then
    local cols, lava = grid.cols, grid.lava
    for i, l in pairs(lava) do
      if not lava[i - cols] then
        local r = math.floor((i - 1) / cols)
        local c = (i - 1) - r * cols
        local x = grid.x0 + (c + 0.5) * CELL
        local y = grid.y0 + (r + 1) * CELL - math.min(1, l) * CELL
        if x > vx0 and x < vx1 and y > vy0 and y < vy1 then fn(x, y, 0, -1, c, r, nil, l) end
      end
    end
  end
  for _, g in pairs(planetGrids) do
    local cols, lava = g.cols, g.lava
    local px, py = g.planet.pos.x, g.planet.pos.y
    for i, l in pairs(lava) do
      if not lava[i - cols] then
        local r = math.floor((i - 1) / cols)
        local c = (i - 1) - r * cols
        local lx, ly = planetPoint(g, c + 0.5, g.top - (r + 1) * CELL + math.min(1, l) * CELL)
        local x, y = px + lx, py + ly
        if x > vx0 and x < vx1 and y > vy0 and y < vy1 then
          local ux, uy = planetUp(g, lx, ly)
          fn(x, y, ux, uy, c, r, g, l)
        end
      end
    end
  end
end

-- Embers off the lava's surface (as Lava.lua's own), drifting up and
-- fading.
local function updateLavaEmbers()
  local ts = state.timeScale or 1
  forEachLavaSurface(function(x, y, ux, uy, _, _, _, amount)
    if math.random() < LAVA_TUNING.EMBER_CHANCE * math.min(1, amount) * ts then
      local speed = LAVA_TUNING.EMBER_RISE_MIN + math.random() * (LAVA_TUNING.EMBER_RISE_MAX - LAVA_TUNING.EMBER_RISE_MIN)
      local drift = (math.random() * 2 - 1) * LAVA_TUNING.EMBER_DRIFT
      local along = (math.random() - 0.5) * CELL
      local life = LAVA_TUNING.EMBER_LIFE_MIN + math.random() * (LAVA_TUNING.EMBER_LIFE_MAX - LAVA_TUNING.EMBER_LIFE_MIN)
      lavaEmbers[#lavaEmbers + 1] = {
        x = x - uy * along, y = y + ux * along,
        vx = -uy * drift + ux * speed, vy = ux * drift + uy * speed,
        life = 1, decay = 1 / life,
        radius = LAVA_TUNING.EMBER_RADIUS_MIN + math.random() * (LAVA_TUNING.EMBER_RADIUS_MAX - LAVA_TUNING.EMBER_RADIUS_MIN),
      }
    end
  end)
  for k = #lavaEmbers, 1, -1 do
    local e = lavaEmbers[k]
    e.x, e.y = e.x + e.vx * ts, e.y + e.vy * ts
    e.life = e.life - e.decay * ts / 60
    if e.life <= 0 then table.remove(lavaEmbers, k) end
  end
end

-- Where the lava glows (see TileGlow.lua): fn(x, y) once for each tile's
-- worth of its surface near the screen.
function WaterSystem.forEachLavaGlow(fn)
  local buckets = {}
  forEachLavaSurface(function(x, y, _, _, c, r, g)
    local byGrid = buckets[g or "level"]
    if not byGrid then
      byGrid = {}
      buckets[g or "level"] = byGrid
    end
    local key = math.floor(c / LAVA_TUNING.TILE_CELLS) * 100000 + math.floor(r / LAVA_TUNING.TILE_CELLS)
    local b = byGrid[key]
    if not b then
      b = { x = 0, y = 0, n = 0 }
      byGrid[key] = b
    end
    b.x, b.y, b.n = b.x + x, b.y + y, b.n + 1
  end)
  for _, byGrid in pairs(buckets) do
    for _, b in pairs(byGrid) do fn(b.x / b.n, b.y / b.n) end
  end
end

----------------------------------------------------------------------
-- Ice
----------------------------------------------------------------------
--
-- The ice blaster's bolts (see lua/entities/IceBolt.lua and
-- WaterSystem.iceBoltHit):
--   * into water: a block of ice a tile across (Ice.TUNING.SIZE cells)
--     freezes there, out of the water round where it hit — the water's
--     kept, for when it melts. On the level it's a wall (in level.walls,
--     so Bob bumps into it and fireballs hit it, and the water flows
--     round it) with a walkable top (Ice.addTop), and it's slippery (see
--     Player:move). On a dirt planet it's an ice tile (see
--     CrackedPlanetoid:setBlock).
--   * into lava: the bolt turns to water there (Ice.TUNING.LAVA_WATER),
--     so the lava turns to obsidian (see "Lava meeting water").
--   * into an Ooomba: it's frozen in an ice cube (Ice.encase) — stock
--     still and harmless, and on the level's terrain, a block to stand on.
-- Ice floats: a block sunk in water rises a cell at a time (the water
-- flowing in under it) until it's riding at the surface, a quarter of it
-- out; with nothing at all under it, it drops. (On a dirt planet, a whole tile at a time — its tiles are a
-- ring deep.) A fireball melts it — and lava meeting it does too — into a
-- splash of water and steam (Ice.melt): a frozen Ooomba's freed, and walks
-- on.
--
-- Ice.blocks holds one entry per block:
--   kind = "level": c0, r0 (its top-left cell), x0, y0, size, wall;
--   kind = "planet": g (the planet's grid), planet, ring, j (its tile);
--   kind = "ooomba": o (the frozen Ooomba), size, and on the level a wall;
-- and water (cells' worth it'll melt back into).

Ice.TUNING = {
  SIZE = 4,              -- cells across a block (a tile)
  MIN_WATER = 1.0,       -- cells' worth of water it takes to freeze a block
  LAVA_WATER = 1.5,      -- cells' worth of water a bolt turns to in lava
  LEVEL_STEP = 4,        -- frames between a level block's floating/sinking steps (a cell each)
  PLANET_STEP = 30,      -- ...and a planet's ice tile's (a whole tile each)
  CUBE_MARGIN = 16,      -- world units an Ooomba's cube is bigger than it
  CUBE_WATER = 2,        -- cells' worth of water a melted cube leaves
  ALPHA = 0.92,          -- how solid ice looks (its art's own see-through on top)
}

do
  local image = nil
  Ice.getImage = function()
    if not image then
      image = love.graphics.newImage("img/ice.png")
      image:setFilter("nearest", "nearest")
    end
    return image
  end
end

function Ice.iceBurst(x, y, n)
  require("lua.entities.IceBolt").burst(x, y, n)
end

-- A walkable top for a block on the level (obsidian, ice, or an
-- Ooomba's cube): a moving surface along its top (see
-- TiledTerrain.newMovingSurface — RopeRock's rock has one the same way),
-- so he stands and walks on it rather than just bumping into it. An ice
-- one is slippery (isIce — see Player:move).
function Ice.addTop(wall)
  local TiledTerrain = require("lua.world.TiledTerrain")
  local top = wall.pos.y - wall.halfHeight
  local s = TiledTerrain.newMovingSurface(wall.pos.x - wall.halfWidth, top, wall.pos.x + wall.halfWidth, top)
  s.jumpStrength = state.skyDomePlanet and state.skyDomePlanet.jumpStrength
  s.blockWall = wall -- (a fireball hitting its top melts the block — see main.lua)
  s.isIce = wall.ice ~= nil
  wall.surface = s
  state.planetoids = state.planetoids or {}
  table.insert(state.planetoids, s)
end

function Ice.placeTop(wall)
  if not wall.surface then return end
  local top = wall.pos.y - wall.halfHeight
  wall.surface:moveTo(wall.pos.x - wall.halfWidth, top, wall.pos.x + wall.halfWidth, top)
end

function Ice.removeTop(wall)
  local s = wall.surface
  if not s then return end
  removeFrom(state.planetoids or {}, s)
  local p = state.player
  if p and p.currentPlanet == s then
    p.onSurface = false
    p.currentPlanet = nil
  end
  wall.surface = nil
end

-- If he's in the box (x0, y0)-(x1, y1), he's lifted out on top of it.
function Ice.liftPlayerOutOf(x0, y0, x1, y1)
  local p = state.player
  if not p then return end
  local qx = math.max(x0, math.min(p.pos.x, x1))
  local qy = math.max(y0, math.min(p.pos.y, y1))
  if (p.pos.x - qx) ^ 2 + (p.pos.y - qy) ^ 2 < p.radius * p.radius then p.pos.y = y0 - p.radius - 1 end
end

-- A level block's wall, from its cells.
function Ice.levelBlockWall(e)
  local half = e.size / 2
  return {
    pos = Vector2.new(e.x0 + half, e.y0 + half), halfWidth = half, halfHeight = half,
    radius = e.size * 0.7071067811865476, isWall = true,
  }
end

-- Water at level cell (c, r) froze: a block out of the water round it.
-- Which rows: the four-row band through (c, r), in its tile's columns,
-- that's all open (no wall, floor or other block in it) and holds the
-- most water. Returns whether one froze.
function Ice.freezeLevel(hc, hr)
  local g = grid
  local S, cols = Ice.TUNING.SIZE, grid.cols
  local c0 = math.floor(hc / S) * S
  local bestR, bestWater = nil, 0
  for r0 = hr - (S - 1), hr do
    local ok, w = true, 0
    for r = r0, r0 + S - 1 do
      for c = c0, c0 + S - 1 do
        local i = r * cols + c + 1
        if not inGrid(c, r) or isSolid(c, r) or g.floor[i] or (g.lava[i] or 0) > 0 then ok = false end
        w = w + (g.water[i] or 0)
      end
    end
    if ok and w > bestWater then bestR, bestWater = r0, w end
  end
  if not bestR or bestWater < Ice.TUNING.MIN_WATER then return false end

  for r = bestR, bestR + S - 1 do
    for c = c0, c0 + S - 1 do
      local i = r * cols + c + 1
      g.water[i] = nil
      g.solid[i] = true
    end
  end
  local e = {
    kind = "level", c0 = c0, r0 = bestR, x0 = g.x0 + c0 * CELL, y0 = g.y0 + bestR * CELL, size = S * CELL,
    water = bestWater,
  }
  e.wall = Ice.levelBlockWall(e)
  e.wall.ice = e
  table.insert(g.level.walls, e.wall)
  Ice.addTop(e.wall)
  Ice.blocks[#Ice.blocks + 1] = e
  Ice.liftPlayerOutOf(e.x0, e.y0, e.x0 + e.size, e.y0 + e.size)
  Ice.iceBurst(e.x0 + e.size / 2, e.y0 + e.size / 2, 18)
  return true
end

-- Water at planet grid g's cell (c, r) froze: the tile it's in turns to
-- ice, out of the water in it. Returns whether it did.
function Ice.freezePlanet(g, c, r)
  local p = g.planet
  local i, j = p:tileAtLocal(planetCellCenter(g, c, r))
  if not i or p.rings[i].clods[j] then return false end
  local cells = planetTileCells(g, i, j)
  local w = 0
  for _, cell in ipairs(cells) do
    if (g.lava[cell.i] or 0) > 0 then return false end
    w = w + (g.water[cell.i] or 0)
  end
  if w < Ice.TUNING.MIN_WATER then return false end
  for _, cell in ipairs(cells) do g.water[cell.i] = nil end
  p:setBlock(i, j, "ice")
  Ice.blocks[#Ice.blocks + 1] = { kind = "planet", g = g, planet = p, ring = i, j = j, water = w }
  local lx, ly = planetCellCenter(g, c, r)
  Ice.iceBurst(p.pos.x + lx, p.pos.y + ly, 18)
  return true
end

-- An Ooomba frozen in an ice cube (see above).
function Ice.encase(o)
  if o.iceBlock or o.isSquashing then return end
  local size = math.max(o.drawWidth, o.drawHeight) + Ice.TUNING.CUBE_MARGIN
  local e = { kind = "ooomba", o = o, size = size, water = Ice.TUNING.CUBE_WATER }
  o.iceBlock = e
  o.frozen = true
  -- Its middle where the Ooomba's is, its bottom on the ground under it.
  local feetX, feetY = o.pos.x - o.up.x * o.halfHeight, o.pos.y - o.up.y * o.halfHeight
  e.cx, e.cy = feetX + o.up.x * size / 2, feetY + o.up.y * size / 2
  -- On the level's terrain (not a round planetoid, not flying), it's a
  -- solid block to stand on.
  local level = state.tiledLevels and state.tiledLevels[1]
  if level and not o.planet and not o.airborne and not o.portalTransit then
    e.cx, e.cy = feetX, feetY - size / 2 + 2
    e.x0, e.y0 = e.cx - size / 2, e.cy - size / 2
    e.level = level
    e.wall = Ice.levelBlockWall(e)
    e.wall.ice = e
    table.insert(level.walls, e.wall)
    Ice.addTop(e.wall)
    Ice.liftPlayerOutOf(e.x0, e.y0, e.x0 + size, e.y0 + size)
  end
  Ice.blocks[#Ice.blocks + 1] = e
  Ice.iceBurst(e.cx, e.cy, 24)
end

-- Block e melts (see above): a splash of water — what it froze from — and
-- steam.
function Ice.melt(e)
  removeFrom(Ice.blocks, e)
  local cx, cy, upX, upY
  if e.kind == "level" then
    local g, S = grid, Ice.TUNING.SIZE
    local cells = {}
    for r = e.r0 + S - 1, e.r0, -1 do
      for c = e.c0, e.c0 + S - 1 do
        local i = r * g.cols + c + 1
        g.solid[i] = nil
        cells[#cells + 1] = { i = i, r = r }
      end
    end
    pourLava(g.water, cells, e.water)
    cx, cy, upX, upY = e.x0 + e.size / 2, e.y0, 0, -1
  elseif e.kind == "planet" then
    e.planet:setBlock(e.ring, e.j, nil)
    pourLava(e.g.water, planetTileCells(e.g, e.ring, e.j), e.water)
    local ring = e.planet.rings[e.ring]
    local a = ring.offset + (e.j - 0.5) * ring.step + e.planet.rotationAngle
    upX, upY = math.cos(a), math.sin(a)
    cx, cy = e.planet.pos.x + upX * ring.mid, e.planet.pos.y + upY * ring.mid
  else
    local o = e.o
    o.frozen, o.iceBlock = false, nil
    cx, cy, upX, upY = e.cx, e.cy, o.up.x, o.up.y
    -- (Its water, onto the level's grid if it's on the level.)
    if grid and e.level then
      local c, r = cellOf(cx, e.cy + e.size / 2 - CELL / 2)
      for dc = -1, 1 do
        if inGrid(c + dc, r) and not isSolid(c + dc, r) then addWater(c + dc, r, e.water / 3) end
      end
    end
  end
  if e.wall then
    removeFrom((e.level or (grid and grid.level) or {}).walls or {}, e.wall)
    Ice.removeTop(e.wall)
  end
  for _ = 1, math.floor(STEAM_BURST * 0.6) do spawnSteam(cx, cy, upX, upY, 1.0) end
  for _ = 1, 3 do spawnSplash(cx + (math.random() - 0.5) * 30, cy, upX, upY) end
  Ice.iceBurst(cx, cy, 10)
end

-- A fireball (or anything hot) at f.pos: an Ooomba's ice cube it's
-- touching melts (the level's blocks are walls, so main.lua's fireball-
-- vs-wall pass finds those). Returns whether it melted one.
function WaterSystem.fireHitsIce(f)
  for k = #Ice.blocks, 1, -1 do
    local e = Ice.blocks[k]
    if e.kind == "ooomba" then
      local half = e.size / 2 + f.radius
      if math.abs(f.pos.x - e.cx) < half and math.abs(f.pos.y - e.cy) < half then
        Ice.melt(e)
        return true
      end
    end
  end
  return false
end

-- Whether lava's touching level block e (in a cell round its edge).
function Ice.lavaRoundLevelBlock(e)
  local g, S = grid, Ice.TUNING.SIZE
  for r = e.r0 - 1, e.r0 + S do
    for c = e.c0 - 1, e.c0 + S do
      if inGrid(c, r) and (g.lava[r * g.cols + c + 1] or 0) >= LAVA_TUNING.TOUCH then return true end
    end
  end
  return false
end

-- Level block e moved a cell (dir: -1 up, 1 down): the row it moves into
-- swaps with the row it leaves — whatever water (or lava) was there goes
-- to the other side of it.
function Ice.moveLevelBlock(e, dir)
  local g, S = grid, Ice.TUNING.SIZE
  local into = dir < 0 and e.r0 - 1 or e.r0 + S
  local leave = dir < 0 and e.r0 + S - 1 or e.r0
  for c = e.c0, e.c0 + S - 1 do
    local i, k = into * g.cols + c + 1, leave * g.cols + c + 1
    g.water[k], g.water[i] = g.water[i], nil
    g.lava[k], g.lava[i] = g.lava[i], nil
    g.solid[i], g.solid[k] = true, nil
  end
  e.r0 = e.r0 + dir
  e.y0 = e.y0 + dir * CELL
  e.wall.pos.y = e.wall.pos.y + dir * CELL
  Ice.placeTop(e.wall)
  -- (Rising into him from below, he's lifted along.)
  if dir < 0 then Ice.liftPlayerOutOf(e.x0, e.y0, e.x0 + e.size, e.y0 + e.size) end
end

-- A level block floating or sinking a step (see above).
function Ice.stepLevelBlock(e)
  local g, S = grid, Ice.TUNING.SIZE
  if Ice.lavaRoundLevelBlock(e) then
    Ice.melt(e)
    return
  end
  local bottom = e.r0 + S - 1
  local restsBelow, waterBelow = false, 0
  for c = e.c0, e.c0 + S - 1 do
    if blocked(c, bottom, 0, 1) then restsBelow = true end
    if inGrid(c, bottom + 1) then waterBelow = waterBelow + (g.water[(bottom + 1) * g.cols + c + 1] or 0) end
  end
  if not restsBelow and waterBelow < 1 then
    Ice.moveLevelBlock(e, 1) -- (nothing to hold it up: it drops)
  else
    -- Sunk in water, it floats up (the water it rises out of flowing in
    -- under it — see moveLevelBlock), even off the bottom of a pool.
    local roofed, waterAbove = false, 0
    for c = e.c0, e.c0 + S - 1 do
      if e.r0 <= 0 or blocked(c, e.r0, 0, -1) then roofed = true end
      if e.r0 > 0 then waterAbove = waterAbove + (g.water[(e.r0 - 1) * g.cols + c + 1] or 0) end
    end
    -- (Sunk: water over it, or up its sides to its top row.)
    local function sideWet(c) return inGrid(c, e.r0) and (g.water[e.r0 * g.cols + c + 1] or 0) >= 0.5 end
    local sunk = waterAbove > 0.05 or sideWet(e.c0 - 1) or sideWet(e.c0 + S)
    if not roofed and sunk then Ice.moveLevelBlock(e, -1) end
  end
end

-- Planet ice tile e: how much water's in tile (ring ti, tile tj) — or
-- nil if it's solid (dirt, a block, or past the rings).
function Ice.planetTileWater(e, ti, tj)
  local p = e.planet
  if ti < 1 or ti > #p.rings then return nil end
  tj = (tj - 1) % p.rings[ti].count + 1
  if p.rings[ti].clods[tj] then return nil end
  local w, lava = 0, 0
  for _, cell in ipairs(planetTileCells(e.g, ti, tj)) do
    w = w + (e.g.water[cell.i] or 0)
    lava = lava + (e.g.lava[cell.i] or 0)
  end
  return w, lava
end

-- Planet ice tile e moved to ring ti (the next one in or out): the water
-- (and lava) in that tile goes into the one it leaves.
function Ice.movePlanetBlock(e, ti)
  local g, p = e.g, e.planet
  local water, lava = 0, 0
  for _, cell in ipairs(planetTileCells(g, ti, e.j)) do
    water = water + (g.water[cell.i] or 0)
    lava = lava + (g.lava[cell.i] or 0)
    g.water[cell.i], g.lava[cell.i] = nil, nil
  end
  p:setBlock(e.ring, e.j, nil)
  p:setBlock(ti, e.j, "ice")
  local cells = planetTileCells(g, e.ring, e.j)
  pourLava(g.water, cells, water)
  pourLava(g.lava, cells, lava)
  e.ring = ti
end

-- A planet's ice tile floating or sinking a tile (see above).
function Ice.stepPlanetBlock(e)
  local i, j = e.ring, e.j
  -- Lava next to it (in, out, or either side) melts it.
  for _, n in ipairs({ { i - 1, j }, { i + 1, j }, { i, j - 1 }, { i, j + 1 } }) do
    local _, lava = Ice.planetTileWater(e, n[1], n[2])
    if lava and lava >= LAVA_TUNING.TOUCH then
      Ice.melt(e)
      return
    end
  end
  local below = i > 1 and Ice.planetTileWater(e, i - 1, j) or nil
  if below and below < 2 then
    Ice.movePlanetBlock(e, i - 1)
  elseif i < #e.planet.rings then
    -- (Sunk in water, it floats up — even off the bottom of a pool.)
    local above = Ice.planetTileWater(e, i + 1, j)
    local left, right = Ice.planetTileWater(e, i, j - 1), Ice.planetTileWater(e, i, j + 1)
    local sunk = (above and above > 0.5) or (left or 0) >= 12 or (right or 0) >= 12
    if above and sunk then Ice.movePlanetBlock(e, i + 1) end
  end
end

-- Each frame (see WaterSystem.update): the blocks floating and sinking,
-- each at its own pace.
function Ice.update()
  if #Ice.blocks == 0 then return end
  local before = Ice.frame
  Ice.frame = Ice.frame + (state.timeScale or 1)
  local function due(every) return math.floor(Ice.frame / every) > math.floor(before / every) end
  local levelDue, planetDue = due(Ice.TUNING.LEVEL_STEP), due(Ice.TUNING.PLANET_STEP)
  for k = #Ice.blocks, 1, -1 do
    local e = Ice.blocks[k]
    if e then
      if e.kind == "level" and levelDue and grid then
        Ice.stepLevelBlock(e)
      elseif e.kind == "planet" and planetDue and planetGrids[e.planet] == e.g then
        Ice.stepPlanetBlock(e)
      elseif e.kind == "ooomba" and e.o.isSquashing then
        Ice.melt(e)
      end
    end
  end
end

-- Ice bolt b (see lua/entities/IceBolt.lua) reaching water or lava this
-- frame (anywhere along the path it's just moved): water freezes into a
-- block (see above), lava gets water poured into it (so it turns to
-- obsidian). Returns whether it did — the bolt's spent either way, if it
-- reached either (the caller removes it).
function WaterSystem.iceBoltHit(b)
  local ts = state.timeScale or 1
  local x1, y1 = b.pos.x, b.pos.y
  local x0, y0 = x1 - b.vel.x * ts, y1 - b.vel.y * ts
  local dist = math.sqrt((x1 - x0) ^ 2 + (y1 - y0) ^ 2)
  local steps = math.max(1, math.ceil(dist / (CELL * 0.5)))
  for s = 0, steps do
    local x, y = x0 + (x1 - x0) * s / steps, y0 + (y1 - y0) * s / steps
    local pg = planetGridAt(x, y)
    if pg then
      local c, r = planetCellOf(pg, x, y)
      local i = planetIndex(pg, c, r)
      if i and (pg.lava[i] or 0) >= LAVA_TUNING.TOUCH then
        pg.water[i] = (pg.water[i] or 0) + Ice.TUNING.LAVA_WATER
        return true
      end
      if i and (pg.water[i] or 0) >= QUENCH_AT then
        Ice.freezePlanet(pg, c, r)
        return true
      end
    elseif grid then
      local c, r = cellOf(x, y)
      if inGrid(c, r) then
        local i = r * grid.cols + c + 1
        if (grid.lava[i] or 0) >= LAVA_TUNING.TOUCH then
          addWater(c, r, Ice.TUNING.LAVA_WATER)
          return true
        end
        if (grid.water[i] or 0) >= QUENCH_AT then
          Ice.freezeLevel(c, r)
          return true
        end
      end
    end
  end
  return false
end

-- Ooomba o frozen solid (an ice bolt's hit it — see main.lua).
function WaterSystem.encaseOoomba(o)
  Ice.encase(o)
end

-- An Ooomba's ice cube, drawn over it (see main.lua's Ooomba drawing).
function WaterSystem.drawIceCube(e)
  local image = Ice.getImage()
  local angle = (e.wall or not e.o) and 0 or math.atan2(e.o.up.x, -e.o.up.y)
  love.graphics.setColor(1, 1, 1, Ice.TUNING.ALPHA * 0.85)
  love.graphics.draw(image, e.cx, e.cy, angle, e.size / image:getWidth(), e.size / image:getHeight(),
    image:getWidth() / 2, image:getHeight() / 2)
  love.graphics.setColor(1, 1, 1, 1)
end

-- The ice blocks on the level (a dirt planet's are part of its own picture;
-- an Ooomba's cube is drawn with it).
function Ice.drawLevel()
  local image = nil
  for _, e in ipairs(Ice.blocks) do
    if e.kind == "level" then
      image = image or Ice.getImage()
      love.graphics.setColor(1, 1, 1, Ice.TUNING.ALPHA)
      love.graphics.draw(image, e.x0, e.y0, 0, e.size / image:getWidth(), e.size / image:getHeight())
    end
  end
  love.graphics.setColor(1, 1, 1, 1)
end

-- For debugging/tests: the ice blocks.
function WaterSystem.debugIce()
  return Ice.blocks
end

-- Hot spots boiling water off (and steaming), tailing off as they cool;
-- the steam rising and fading.
local function updateSteam(dt)
  local ts = state.timeScale or 1
  local gameDt = ts / 60 -- (timeScale is in 60fps ticks)

  for i = #hotSpots, 1, -1 do
    local h = hotSpots[i]
    local heat = h.life / HOT_SECONDS
    local amount = BOIL_PER_SECOND * heat * gameDt
    local sx, sy, upX, upY
    local o = h.planet and oceans[h.planet]
    if h.planet then
      if o then
        o.volume = math.max(0, o.volume - amount)
        local depth = depthOf(h.planet, o.volume)
        -- The water's surface near the spot (spread a little round it;
        -- the spot moves with the planetoid, and sinks as it boils off).
        local qx = h.planet.pos.x + h.ox + (math.random() * 2 - 1) * 20
        local qy = h.planet.pos.y + h.oy + (math.random() * 2 - 1) * 20
        local d
        d, upX, upY = surfaceDistance(h.planet, qx, qy)
        sx, sy = qx + upX * (depth - d), qy + upY * (depth - d)
      end
    elseif h.pg then
      sx, sy, upX, upY = boilPlanetGrid(h.pg, h.c, h.r, amount)
    elseif grid then
      sx, sy = boilGrid(h.c, h.r, amount)
      upX, upY = 0, -1
    end
    h.steamBudget = h.steamBudget + STEAM_PER_SECOND * heat * gameDt
    while h.steamBudget >= 1 do
      h.steamBudget = h.steamBudget - 1
      if sx then spawnSteam(sx, sy, upX, upY, 0.4) end
    end
    h.life = h.life - gameDt
    if h.life <= 0 or not sx then table.remove(hotSpots, i) end
  end

  for i = #steam, 1, -1 do
    local s = steam[i]
    s.life = s.life - gameDt
    if s.life <= 0 then
      table.remove(steam, i)
    else
      s.vx = s.vx + (math.random() - 0.5) * 0.06 * ts -- (drifting a little)
      s.x, s.y = s.x + s.vx * ts, s.y + s.vy * ts
    end
  end
end

local function drawSteam()
  for _, s in ipairs(steam) do
    local t = 1 - s.life / s.maxLife
    local alpha = STEAM_ALPHA * (1 - t) * math.min(1, 0.5 + t * 6) -- (seen from the start, still under the water)
    love.graphics.setColor(COLOR_STEAM[1], COLOR_STEAM[2], COLOR_STEAM[3], alpha)
    love.graphics.circle("fill", s.x, s.y, STEAM_SIZE + STEAM_GROWTH * t)
  end
  love.graphics.setColor(1, 1, 1, 1)
end

function WaterSystem.update(dt)
  age = age + dt
  local ts = state.timeScale or 1
  local player = state.player

  -- Planet water: forgotten with its culled planetoid, and evaporating
  -- from its outer surface at the same rate per length of surface a pool
  -- does (EVAPORATE_PER_SECOND per CELL of surface).
  forgetCulledOceans()
  for p, o in pairs(oceans) do
    local surfaceLength = perimeterOf(p) + 2 * math.pi * depthOf(p, o.volume) -- (round its outer surface)
    if not o.natural then
      o.volume = o.volume - EVAPORATE_PER_SECOND * (surfaceLength / CELL) * dt * ts
    end
    if o.volume <= 0.05 then
      oceans[p] = nil
      if o.marker then o.marker.radius = p.radius end
    end
  end

  -- All the water there is right now (see WATER_CAP).
  -- Dirt planets' water grids: one for each dirt planet he's anywhere
  -- near (made the first time he is), caught up with any dirt blown out.
  if player then
    for _, p in ipairs(state.planetoids or {}) do
      if p.isCrackedPlanet and p.rings and p.rings[1] and not planetGrids[p] then
        local dx, dy = player.pos.x - p.pos.x, player.pos.y - p.pos.y
        local near = p.radius + PLANET_GRID_MAKE_DISTANCE
        if dx * dx + dy * dy < near * near then planetGrids[p] = newPlanetGrid(p) end
      end
    end
  end
  for _, g in pairs(planetGrids) do
    -- (Its gravity switched — see convertPlanetGrid. The fireballs' hot
    -- spots there are forgotten: their cells have moved.)
    local mode = g.planet.gravityMode or "core"
    if g.mode ~= mode then
      convertPlanetGrid(g, mode)
      for k = #hotSpots, 1, -1 do
        if hotSpots[k].pg == g then table.remove(hotSpots, k) end
      end
    end
    catchUpPlanetGrid(g)
    sweepTurningPlanetGrid(g)
  end

  totalWater = 0
  if grid then for _, w in pairs(grid.water) do totalWater = totalWater + w end end
  for _, g in pairs(planetGrids) do for _, w in pairs(g.water) do totalWater = totalWater + w end end
  -- (Less the water planets' own water — see addNaturalOcean.)
  for _, o in pairs(oceans) do totalWater = totalWater + o.volume - (o.natural or 0) end
  for _, d in ipairs(droplets) do
    if not d.lava then totalWater = totalWater + (d.volume or DROPLET_VOLUME) end -- (lava's not water)
  end

  local sprayHeld = state.waterMode and (love.mouse.isDown(1) or state.gamepadSprayHeld)
  isSpraying = sprayHeld and canSpray(player) or false
  if isSpraying then
    spray(player, dt * ts)
  else
    sprayBudget = 0
  end

  for i = #droplets, 1, -1 do
    if updateDroplet(droplets[i], ts, dt) then table.remove(droplets, i) end
  end
  updateSteam(dt)

  -- Waterfalls splashing where they land (found while drawing last frame).
  if state.particles then
    local up = Vector2.new(0, -1)
    for _, l in ipairs(waterfallLandings) do
      local expected = WATERFALL_SPLASH_PER_SECOND * l.flow * dt * ts
      local n = math.floor(expected) + (math.random() < expected % 1 and 1 or 0)
      for _ = 1, n do
        Splash.spawn(Vector2.new(l.x + (math.random() * 2 - 1) * l.half, l.y), up, 1, WATERFALL_SPLASH)
      end
    end
  end

  for i = #splashes, 1, -1 do
    local s = splashes[i]
    s.life = s.life - dt
    if s.life <= 0 then
      table.remove(splashes, i)
    else
      s.vx, s.vy = s.vx + s.gx * ts, s.vy + s.gy * ts
      s.x, s.y = s.x + s.vx * ts, s.y + s.vy * ts
    end
  end

  if grid or next(planetGrids) then
    stepClock = stepClock + dt * ts
    local steps = 0
    while stepClock >= STEP_SECONDS and steps < MAX_STEPS_PER_FRAME do
      if grid then stepWater(STEP_SECONDS) end
      for _, g in pairs(planetGrids) do stepPlanetWater(g, STEP_SECONDS) end
      -- (The lava, more slowly — see LAVA_TUNING.STEP_EVERY.)
      lavaStepCount = lavaStepCount + 1
      if lavaStepCount >= LAVA_TUNING.STEP_EVERY then
        lavaStepCount = 0
        if grid then stepWater(STEP_SECONDS, LAVA) end
        for _, g in pairs(planetGrids) do stepPlanetWater(g, STEP_SECONDS, LAVA) end
      end
      stepClock = stepClock - STEP_SECONDS
      steps = steps + 1
    end
    if stepClock > STEP_SECONDS then stepClock = 0 end
  end
  -- Lava and water meeting (see "Lava meeting water: obsidian").
  if grid then quenchLevelLava() end
  for _, g in pairs(planetGrids) do quenchPlanetLava(g) end
  updateObsidians()
  Ice.update()
  updateLavaEmbers()
  if grid or next(planetGrids) then drainIntoPortals(dt * ts) end
  drainOceansIntoPortals(dt * ts)

  -- Water bodies following their water's surface (see addNaturalOcean).
  for p, o in pairs(oceans) do
    if o.marker then o.marker.radius = p.radius + depthOf(p, o.volume) end
  end
end

-- The pool shader. Each vertex carries, in its texture coordinates, how
-- far below its pool's surface it is (u, world units) and whether it's
-- part of a falling stream (v = 1); the shader also gets each pixel's
-- world position, so the caustics and streaks stay put in the world as
-- the camera moves.
local waterShader = nil
local function getWaterShader()
  if waterShader then return waterShader end
  waterShader = love.graphics.newShader([[
    varying vec2 worldPos;

    #ifdef VERTEX
    vec4 position(mat4 transform_projection, vec4 vertex_position) {
      worldPos = vertex_position.xy;
      return transform_projection * vertex_position;
    }
    #endif

    #ifdef PIXEL
    extern number time;
    extern vec3 colorShallow;
    extern vec3 colorDeep;
    extern number deepAt;
    extern number alphaShallow;
    extern number alphaDeep;
    extern vec3 colorSurface;
    extern number surfaceLine;
    extern number surfaceFeather;
    extern number surfaceGlow;
    extern vec3 colorCaustic;
    extern number causticScale;
    extern number causticSpeed;
    extern number causticStrength;
    extern vec2 bulgeCenter;      // a planetoid's water layer: its planetoid's center...
    extern number bulgeRadius;    // ...and the water's outer radius...
    extern number causticBulge;   // ...and how much its caustics bulge like a globe's (0 for pools)
    extern number sphereShading;  // 1: lit as a sphere by the sun (a planetoid's water), 0: the depth gradient (pools)
    extern vec2 sunDir;           // unit vector from the planetoid toward the sun
    extern vec3 sphereShallow;
    extern vec3 sphereDeep;
    extern vec3 sphereShade;
    extern number sphereShadeStrength;
    extern vec3 sphereRim;
    extern number sphereRimStrength;
    extern vec3 sphereReflected;
    extern number sphereReflectedStrength;

    // Pseudo-random 2D hash (no built-in noise in LOVE's shader dialect).
    vec2 hash2(vec2 p) {
      p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
      return fract(sin(p) * 43758.5453123);
    }

    // Voronoi: distance to the nearest and second-nearest scattered point
    // (one per grid cell, drifting with time). Where they're about equal
    // is a cell boundary — the bright thread of a caustic net.
    vec2 voronoi(vec2 p, float t) {
      vec2 ip = floor(p);
      vec2 fp = fract(p);
      float f1 = 8.0;
      float f2 = 8.0;
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec2 neighbor = vec2(float(x), float(y));
          vec2 h = hash2(ip + neighbor);
          vec2 pt = neighbor + 0.5 + 0.4 * sin(t + 6.2831 * h) - fp;
          float d = length(pt);
          if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
        }
      }
      return vec2(f1, f2);
    }

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      float depth = uv.x;

      // A falling stream: bright streaks rushing down it.
      if (uv.y > 0.5) {
        float streak = 0.5 + 0.5 * sin(worldPos.y * 0.18 - time * 14.0 + worldPos.x * 0.9);
        vec3 c = mix(colorShallow, colorSurface, 0.3 + 0.45 * streak);
        return vec4(c, 0.55 + 0.3 * streak);
      }

      // Shallow to deep, more see-through near the top.
      float t = clamp(depth / deepAt, 0.0, 1.0);
      vec3 c = mix(colorShallow, colorDeep, t);
      float a = mix(alphaShallow, alphaDeep, t);

      // A planetoid's water, instead: shaded as a sphere lit by the sun
      // (as the water planets were) — each point's normal on a sphere
      // the size of the water bulging toward the viewer, bright facing
      // the sun and falling off into shade away from it, a little deeper
      // toward the middle, a bright rim along the sun side's edge, and a
      // dimmer reflected highlight along the edge furthest from the sun
      // (light bouncing back onto the dark side, the way a shaded ball
      // never goes flat black there).
      if (sphereShading > 0.0) {
        vec2 fromCenter = worldPos - bulgeCenter;
        float dist = length(fromCenter);
        float nxy = clamp(dist / bulgeRadius, 0.0, 1.0);
        vec2 inPlane = dist > 0.0001 ? fromCenter / dist : vec2(0.0);
        vec3 normal = vec3(inPlane * nxy, sqrt(max(0.0, 1.0 - nxy * nxy)));
        float facing = dot(normal, normalize(vec3(sunDir, 0.5)));
        float lightT = smoothstep(-0.3, 0.7, facing);
        vec3 s = mix(sphereShade, sphereShallow, mix(1.0 - sphereShadeStrength, 1.0, lightT));
        s = mix(sphereDeep, s, mix(0.55, 1.0, nxy));
        float rimT = smoothstep(0.6, 1.0, nxy) * clamp(facing, 0.0, 1.0);
        s = mix(s, sphereRim, rimT * sphereRimStrength);
        float reflectedT = smoothstep(0.65, 1.0, nxy) * (1.0 - lightT);
        s = mix(s, sphereReflected, reflectedT * sphereReflectedStrength);
        c = mix(c, s, sphereShading);
      }

      // The caustic net: gently warped so its threads wobble, strongest
      // near the surface and fading away with depth.
      // On a planetoid's water: sampled as if painted on a globe bulging
      // toward the viewer — distance from the center re-mapped from r to
      // radius * asin(r / radius), so the cells read bigger and rounder
      // in the middle and crowd together toward the rim. (The asin input
      // is held just shy of 1, where the cells would get infinitely
      // dense right on the silhouette.)
      vec2 cp = worldPos;
      if (causticBulge > 0.0) {
        vec2 fromCenter = worldPos - bulgeCenter;
        float dist = length(fromCenter);
        float onGlobe = bulgeRadius * asin(clamp(dist / bulgeRadius, 0.0, 0.98));
        if (dist > 0.0001) cp = bulgeCenter + fromCenter / dist * mix(dist, onGlobe, causticBulge);
      }
      vec2 p = cp / causticScale;
      p += 0.25 * vec2(sin(p.y * 1.7 + time * 0.9), cos(p.x * 1.3 - time * 0.7));
      vec2 v = voronoi(p, time * causticSpeed);
      float thread = 1.0 - smoothstep(0.0, 0.06, v.y - v.x);
      c += colorCaustic * thread * causticStrength * (1.0 - t * 0.85);

      // Above the surface (the feathered strip on top): the line fading
      // out to nothing, for a soft edge.
      if (depth < 0.0) {
        float fade = smoothstep(-surfaceFeather, 0.0, depth);
        return vec4(colorSurface, 0.85 * fade) * color;
      }

      // Along the surface: a bright band — solid through its top part,
      // then fading softly down into the water — and a wider soft glow
      // just under it.
      float line = 1.0 - smoothstep(surfaceLine * 0.3, surfaceLine, depth);
      float glow = 1.0 - smoothstep(0.0, surfaceGlow, depth);
      c += colorSurface * glow * 0.18;
      c = mix(c, colorSurface, line * 0.75);
      a = max(a, line * 0.85);

      return vec4(c, a) * color;
    }
    #endif
  ]])
  return waterShader
end

-- The water on the level, as one mesh drawn through the pool shader
-- above: a block per resting wet cell (from its rippling top surface
-- down, or full height deep in a pool), and a narrow stream down the
-- middle of each cell where water is falling.
local useWaterShader, useLavaShader

-- `verts` drawn through `liquid`'s shader (the water's or the lava's), in
-- the mesh kept for `slot`.
local function drawLiquidMesh(slot, verts, liquid)
  local m = meshes[slot]
  if not m or meshSizes[slot] < #verts then
    meshSizes[slot] = math.max(#verts, (meshSizes[slot] or 0) * 2, 600)
    m = love.graphics.newMesh(meshSizes[slot], "triangles", "stream")
    meshes[slot] = m
  end
  m:setVertices(verts)
  m:setDrawRange(1, #verts)
  if liquid == LAVA then useLavaShader() else useWaterShader() end
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(m)
  love.graphics.setShader()
end

-- (liquid: WATER or LAVA — the lava's drawn the same way, through its
-- own shader, its surface moving less.)
local function drawPools(liquid)
  local cam = state.camera
  if not cam then return end
  local vx0, vy0 = cam.x - CELL, cam.y - CELL
  local vx1, vy1 = cam.x + (state.visibleWidth or 0) + CELL, cam.y + (state.visibleHeight or 0) + CELL
  local cols, water = grid.cols, grid[liquid.key]
  local rippleScale = liquid == LAVA and LAVA_TUNING.RIPPLE or 1
  local verts = {}
  if liquid == WATER then waterfallLandings = {} end

  -- depth0/depth1: how far below the surface its top/bottom edges are
  -- (0 at the surface); stream: 1 for a falling stream.
  local function quad(x0, yTop0, x1, yTop1, yBottom0, yBottom1, depthTop, depthBottom, stream)
    local v1 = { x0, yTop0, depthTop, stream, 1, 1, 1, 1 }
    local v2 = { x1, yTop1, depthTop, stream, 1, 1, 1, 1 }
    local v3 = { x1, yBottom1, depthBottom, stream, 1, 1, 1, 1 }
    local v4 = { x0, yBottom0, depthBottom, stream, 1, 1, 1, 1 }
    verts[#verts + 1] = v1; verts[#verts + 1] = v2; verts[#verts + 1] = v3
    verts[#verts + 1] = v1; verts[#verts + 1] = v3; verts[#verts + 1] = v4
  end
  -- Two overlapping waves, so the surface moves less mechanically.
  local function ripple(x)
    return (math.sin(age * 2.2 + x * 0.045) * 1.3 + math.sin(age * 3.7 - x * 0.11) * 0.6) * rippleScale
  end

  -- The water resting in each column, drawn as one stack: everything in
  -- it from its floor up, packed down — so a surface sloping gently
  -- across the rows (water still flowing along, its edge a run of part-
  -- full cells on top of full ones) is drawn at its real, smooth height
  -- instead of stepping row to row, with no stray streams in it. A stack
  -- takes in at most two part-full cells over its full ones, each holding
  -- less than the one under it; anything above that is still falling
  -- (a waterfall pouring into a pool, say), drawn as a stream.
  -- stackSurface[i]: the stack's surface, for every cell in it;
  -- stackTotal[i]: how many cells' worth it holds; stackFloor[i]: its
  -- bottom cell, which draws the whole stack (in one piece, so its
  -- surface can sit at any height without being cut off at a cell edge).
  local stackSurface, stackTotal, stackFloor = {}, {}, {}
  local capped, capDepth = {}, {} -- (by a stack's floor cell: see below)
  for i in pairs(water) do
    local r = math.floor((i - 1) / cols)
    local c = (i - 1) - r * cols
    if blocked(c, r, 0, 1) then -- the bottom of a stack
      local members, total, partials, below = {}, 0, 0, math.huge
      local j, jr = i, r
      while jr >= 0 and water[j] do
        local w = math.min(1, water[j])
        if w < 0.99 then
          if partials == 2 or w >= below then break end
          partials = partials + 1
        end
        members[#members + 1] = j
        total = total + w
        below = w
        j, jr = j - cols, jr - 1
      end
      local surface = grid.y0 + (r + 1) * CELL - math.max(2, total * CELL)
      for _, m in ipairs(members) do
        stackSurface[m] = surface
        stackTotal[m] = total
        stackFloor[m] = i
      end
      -- Full right up to something solid over it (under an ice block,
      -- say): it has no surface of its own — see capDepth below.
      local topRow = r - #members + 1
      if total >= #members - 0.01 and topRow > 0 and isSolid(c, topRow - 1) then capped[i] = topRow end
    end
  end
  -- A capped stack's depth below the open water's surface beside it (the
  -- nearest column either side that isn't capped, reaching up past its
  -- top), so it's shaded on down from there instead of starting fresh
  -- under the cap. Its top's flat against the cap: no ripple, no
  -- surface line.
  for i, topRow in pairs(capped) do
    local r = math.floor((i - 1) / cols)
    local c = (i - 1) - r * cols
    for d = 1, 8 do
      local found
      for _, nc in ipairs({ c - d, c + d }) do
        local n = r * cols + nc + 1
        if nc >= 0 and nc < cols and stackFloor[n] and not capped[stackFloor[n]] and stackSurface[n] < stackSurface[i] then
          found = stackSurface[n]
          break
        end
      end
      if found then
        capDepth[i] = stackSurface[i] - found
        break
      end
    end
  end

  -- Not part of a stack: still falling.
  local function isFalling(i)
    return not stackSurface[i]
  end

  -- Slopes (see WaterSystem.init): the floor's actual height at x under a
  -- cell on one, and how thick a sheet of water running down it is.
  local slope = grid.slope
  local function slopeY(line, x)
    x = math.max(line.xMin, math.min(line.xMax, x))
    return line.ay + (x - line.ax) * line.k
  end
  local function sheetThickness(w)
    return math.max(3, math.min(1, w) * CELL)
  end
  -- The water in the next cell along the slope (beside, a row up or a row
  -- down), if any — so neighboring bits of the sheet meet at one thickness.
  local function slopeNeighbor(c, r, dc)
    local nc = c + dc
    if nc < 0 or nc >= cols then return nil end
    for dr = -1, 1 do
      local nr = r + dr
      if nr >= 0 and nr < grid.rows then
        local j = nr * cols + nc + 1
        if slope[j] and stackTotal[j] then return stackTotal[j] end
      end
    end
    return nil
  end
  -- The surface of the pool a resting cell belongs to.
  local function surfaceY(i)
    return stackSurface[i]
  end

  for i, w in pairs(water) do
    local r = math.floor((i - 1) / cols)
    local c = (i - 1) - r * cols
    local x0 = grid.x0 + c * CELL
    local yTopCell = grid.y0 + r * CELL
    -- (A stack's other cells are drawn along with its floor cell, which
    -- reaches up to the stack's surface.)
    local drawn = not stackFloor[i] or stackFloor[i] == i
    local reachTop = stackSurface[i] and math.min(yTopCell, stackSurface[i] - CELL) or yTopCell
    if drawn and x0 < vx1 and x0 + CELL > vx0 and reachTop < vy1 and yTopCell + CELL > vy0 then
      local x1 = x0 + CELL
      local bottom = yTopCell + CELL
      -- A little water just settling onto a pool: landed (or got pushed
      -- up) into the cell above the surface, with nothing falling above
      -- it — it merges into the pool next step. Drawn as a stream it would
      -- flash as a stray one-cell line sticking up out of the surface, so
      -- it isn't drawn at all. (A real waterfall always has more falling
      -- water above, so it still reaches down to the pool.)
      local settling = isFalling(i, c, r)
        and not water[i - cols] and not water[i - 2 * cols]
        and water[i + cols] and not isFalling(i + cols, c, r + 1)
      -- Stepping down a slope: water running off one of its stair-steps
      -- onto the next, a cell or two down. The sheet drawn along the slope
      -- already covers it, so it isn't drawn as a little waterfall. (A real
      -- waterfall onto a slope has more falling water above.)
      local stepping = isFalling(i, c, r) and not water[i - 2 * cols]
        and (slope[i + cols] or slope[i + 2 * cols])
      if settling or stepping then
        -- (nothing)
      elseif isFalling(i, c, r) then
        -- Falling (open space below, not yet resting on anything): a
        -- narrow, unbroken stream down the middle of the column — wider
        -- the more water is falling. A light trickle falls as separate
        -- little parcels (wet, dry, wet down the column); reaching over a
        -- dry cell right below closes those gaps into one stream.
        local half = CELL * math.min(1, 0.25 + w * 2.5) / 2
        local mid = x0 + CELL / 2
        -- Down through any dry space below (between parcels of a trickle,
        -- or the last stretch to the ground) until it meets the ground, a
        -- pool's surface, or more falling water — so it always reaches.
        local streamBottom = bottom
        local j, jr, gap = i + cols, r + 1, 0
        while gap < STREAM_REACH_CELLS and jr < grid.rows and not water[j] and not blocked(c, jr - 1, 0, 1) do
          j, jr, gap = j + cols, jr + 1, gap + 1
          streamBottom = streamBottom + CELL
        end
        if water[j] and jr < grid.rows and not isFalling(j, c, jr) then
          streamBottom = math.max(streamBottom, surfaceY(j, jr)) -- into the pool's surface
        end

        -- Pouring over an edge: resting water right beside it (the sheet
        -- on top of a ledge it's spilling off). The stream starts at that
        -- water's surface, and a short lip of water runs from the ledge's
        -- edge over to the stream — so the pour is one piece with the
        -- water it comes from, not a separate stream beside it.
        local streamTop = yTopCell
        local function sourceSurface(dc)
          local nc = c + dc
          if nc < 0 or nc >= cols then return nil end
          local n = i + dc
          if water[n] and not isFalling(n, nc, r) then return surfaceY(n, r) end
          if r > 0 and water[n - cols] and not isFalling(n - cols, nc, r - 1) then
            return surfaceY(n - cols, r - 1)
          end
          return nil
        end
        local srcLeft, srcRight = sourceSurface(-1), sourceSurface(1)
        local src, side = srcLeft, -1
        if srcRight and (not srcLeft or srcRight < srcLeft) then src, side = srcRight, 1 end
        if src then
          streamTop = src -- (not its cell's top, which can stick up above a thin sheet)
          local edgeX = side < 0 and x0 or x1
          local lipTop = src + ripple(edgeX)
          if side < 0 then
            quad(edgeX, lipTop, mid, src + 2, lipTop + LIP_THICKNESS, src + 2 + LIP_THICKNESS, 0, 0, 1)
          else
            quad(mid, src + 2, edgeX, lipTop, src + 2 + LIP_THICKNESS, lipTop + LIP_THICKNESS, 0, 0, 1)
          end
        end
        quad(mid - half, streamTop, mid + half, streamTop, streamBottom, streamBottom, 0, 0, 1)

        -- The bottom of a waterfall, landing on the ground or a pool: it
        -- splashes there (see WaterSystem.update), if it's fallen far
        -- enough — up the column through the rest of the falling water.
        if blocked(c, jr - 1, 0, 1) or (water[j] and not isFalling(j)) then
          local fallTop, k = streamTop, i - cols
          for _ = 1, 32 do
            if not (water[k] and isFalling(k)) then break end
            fallTop, k = fallTop - CELL, k - cols
          end
          if liquid == WATER and streamBottom - fallTop >= WATERFALL_SPLASH_MIN_FALL then
            waterfallLandings[#waterfallLandings + 1] = { x = mid, y = streamBottom, half = half, flow = math.min(1, w * 4) }
          end
        end
      else
        local surface = surfaceY(i, r)
        local line = slope[i]
        -- Where its bottom is at x: the cell's bottom, or on a slope, the
        -- slope itself (down into the stair-step under the cell).
        local function bottomAt(x)
          return line and math.max(bottom, slopeY(line, x)) or bottom
        end
        if line and stackTotal[i] < 0.99 then
          -- A thin sheet on a slope: lying along it, at a thickness easing
          -- into the next bits of the sheet up and down the slope.
          local t = sheetThickness(stackTotal[i])
          local wl, wr = slopeNeighbor(c, r, -1), slopeNeighbor(c, r, 1)
          local tl = (t + (wl and sheetThickness(wl) or t * 0.5)) / 2
          local tr = (t + (wr and sheetThickness(wr) or t * 0.5)) / 2
          local function thicknessAt(f)
            if f < 0.5 then return tl + (t - tl) * f * 2 end
            return t + (tr - t) * (f - 0.5) * 2
          end
          for s = 0, SURFACE_SLICES - 1 do
            local fa, fb = s / SURFACE_SLICES, (s + 1) / SURFACE_SLICES
            local xa, xb = x0 + CELL * fa, x0 + CELL * fb
            local ba, bb = slopeY(line, xa), slopeY(line, xb)
            local tha, thb = thicknessAt(fa), thicknessAt(fb)
            local ta = ba - tha + ripple(xa) * 0.3
            local tb = bb - thb + ripple(xb) * 0.3
            quad(xa, ta, xb, tb, ba, bb, 0, (tha + thb) / 2, 0)
            quad(xa, ta - SURFACE_FEATHER, xb, tb - SURFACE_FEATHER, ta, tb, -SURFACE_FEATHER, 0, 0)
          end
        else
          -- The stack: from its rippling surface down to its floor, in thin
          -- slices whose height eases toward the neighboring columns'
          -- water line (so the surface curves smoothly instead of stepping
          -- column to column).
          -- The neighbor's water line: the stack in the column beside this
          -- one, found by its cell beside this one or — where the surface
          -- slopes across a row boundary — the one beside and below or
          -- above it. Nothing there: stay level.
          local function neighborSurface(dc)
            local nc = c + dc
            if nc < 0 or nc >= cols then return surface end
            local j = i + dc
            local s = surfaceY(j) or surfaceY(j + cols) or surfaceY(j - cols)
            if not s or math.abs(s - surface) > CELL * 1.5 then return surface end
            -- (Nor toward a capped neighbor's — or, capped, any — "surface":
            -- see capDepth.)
            local nf = stackFloor[j] or stackFloor[j + cols] or stackFloor[j - cols]
            if (nf and capped[nf]) or capped[stackFloor[i]] then return surface end
            return s
          end
          local left, right = neighborSurface(-1), neighborSurface(1)
          local cap = capped[stackFloor[i]] and (capDepth[stackFloor[i]] or 0)
          local rippleHere = cap and function() return 0 end or ripple
          local function heightAt(f) -- f: 0..1 across the cell
            local h
            if f < 0.5 then
              local k = 0.5 + f -- from the left neighbor's middle (0) to this one's (1)
              h = left + (surface - left) * (0.5 - 0.5 * math.cos(math.pi * k))
            else
              local k = f - 0.5
              h = surface + (right - surface) * (0.5 - 0.5 * math.cos(math.pi * k))
            end
            return h
          end
          for s = 0, SURFACE_SLICES - 1 do
            local fa, fb = s / SURFACE_SLICES, (s + 1) / SURFACE_SLICES
            local xa, xb = x0 + CELL * fa, x0 + CELL * fb
            local ha, hb = heightAt(fa), heightAt(fb)
            local ta = math.min(ha + rippleHere(xa), bottom - 1)
            local tb = math.min(hb + rippleHere(xb), bottom - 1)
            local ba, bb = bottomAt(xa), bottomAt(xb)
            local d0 = cap or 0
            quad(xa, ta, xb, tb, ba, bb, d0, d0 + (ba + bb) / 2 - (ha + hb) / 2, 0)
            -- A thin strip just above the surface (negative depth) that the
            -- shader fades out, so the top edge is soft rather than a hard
            -- pixel line. (Not under a cap: there's no surface there.)
            if not cap then
              quad(xa, ta - SURFACE_FEATHER, xb, tb - SURFACE_FEATHER, ta, tb, -SURFACE_FEATHER, 0, 0)
            end
          end
        end
      end
    end
  end

  if #verts == 0 then return end
  drawLiquidMesh(liquid.key, verts, liquid)
end

-- Turns on the water shader with every setting from the tunables above
-- (shared by the pools and the planets' water layers).
useWaterShader = function()
  local shader = getWaterShader()
  shader:send("time", age)
  shader:send("colorShallow", COLOR_SHALLOW)
  shader:send("colorDeep", COLOR_DEEP)
  shader:send("deepAt", DEEP_AT)
  shader:send("alphaShallow", ALPHA_SHALLOW)
  shader:send("alphaDeep", ALPHA_DEEP)
  shader:send("colorSurface", COLOR_SURFACE)
  shader:send("surfaceLine", SURFACE_LINE)
  shader:send("surfaceFeather", SURFACE_FEATHER)
  shader:send("surfaceGlow", SURFACE_GLOW)
  shader:send("colorCaustic", COLOR_CAUSTIC)
  shader:send("causticScale", CAUSTIC_SCALE)
  shader:send("bulgeCenter", { 0, 0 })
  shader:send("bulgeRadius", 1)
  shader:send("causticBulge", 0) -- (flat, for the pools — see drawOceans)
  shader:send("sphereShading", 0) -- (likewise)
  shader:send("sunDir", { 1, 0 })
  shader:send("sphereShallow", SPHERE_COLOR_SHALLOW)
  shader:send("sphereDeep", SPHERE_COLOR_DEEP)
  shader:send("sphereShade", SPHERE_COLOR_SHADE)
  shader:send("sphereShadeStrength", SPHERE_SHADE_STRENGTH)
  shader:send("sphereRim", SPHERE_COLOR_RIM)
  shader:send("sphereRimStrength", SPHERE_RIM_STRENGTH)
  shader:send("sphereReflected", SPHERE_COLOR_REFLECTED)
  shader:send("sphereReflectedStrength", SPHERE_REFLECTED_STRENGTH)
  shader:send("causticSpeed", CAUSTIC_SPEED)
  shader:send("causticStrength", CAUSTIC_STRENGTH)
  love.graphics.setShader(shader)
end

-- The lava's shader: the same shapes as the water's (each vertex's
-- texture coordinates carry how far below the surface it is, and whether
-- it's a falling stream), filled with Lava.lua's churning plasma —
-- hottest along the surface, darker and crustier deeper down, solid
-- rather than see-through, and pouring down a falling stream.
local getLavaShader
do
local lavaShader = nil -- (kept inside this do-block: see LAVA_TUNING on the 200-local limit)
getLavaShader = function()
  if lavaShader then return lavaShader end
  lavaShader = love.graphics.newShader([[
    varying vec2 worldPos;

    #ifdef VERTEX
    vec4 position(mat4 transform_projection, vec4 vertex_position) {
      worldPos = vertex_position.xy;
      return transform_projection * vertex_position;
    }
    #endif

    #ifdef PIXEL
    extern number time;
    extern vec3 colorDeep;
    extern vec3 colorMid;
    extern vec3 colorHot;
    extern number glowBand;
    extern number plasmaScale;
    extern number detailScale;
    extern number evolveSpeed;
    extern number scrollSpeed;
    extern number pourSpeed;
    extern number surfaceFeather;

    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    float valueNoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      float a = hash(i);
      float b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0));
      float d = hash(i + vec2(1.0, 1.0));
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }
    float fbm(vec2 p) {
      float value = 0.0;
      float amp = 0.5;
      for (int i = 0; i < 4; i++) {
        value += amp * valueNoise(p);
        p *= 2.02;
        amp *= 0.55;
      }
      return value;
    }

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      float depth = uv.x;
      bool falling = uv.y > 0.5;
      // (Falling, the pattern pours down the stream instead of churning in place.)
      vec2 gp = worldPos * plasmaScale + (falling ? vec2(0.0, -time * pourSpeed)
                                                  : vec2(time * scrollSpeed, -time * evolveSpeed));
      float grain = fbm(gp);
      float speck = fbm(gp * detailScale + 5.2);
      float v = clamp(grain * 0.7 + speck * 0.3, 0.0, 1.0);
      float glowBias = falling ? 0.5 : clamp(1.0 - depth / glowBand, 0.0, 1.0);
      v = clamp(v * 0.55 + glowBias * 0.6, 0.0, 1.0);
      vec3 c = mix(colorDeep, colorMid, smoothstep(0.25, 0.55, v));
      c = mix(c, colorHot, smoothstep(0.6, 0.9, v));
      // (The strip over the surface fades out, for a soft edge.)
      float a = depth < 0.0 ? smoothstep(-surfaceFeather, 0.0, depth) : 1.0;
      return vec4(c, a) * color;
    }
    #endif
  ]])
  return lavaShader
end
end

useLavaShader = function()
  local shader = getLavaShader()
  shader:send("time", age)
  shader:send("colorDeep", LAVA_TUNING.COLOR_DEEP)
  shader:send("colorMid", LAVA_TUNING.COLOR_MID)
  shader:send("colorHot", LAVA_TUNING.COLOR_HOT)
  shader:send("glowBand", LAVA_TUNING.GLOW_BAND)
  shader:send("plasmaScale", LAVA_TUNING.PLASMA_SCALE)
  shader:send("detailScale", LAVA_TUNING.PLASMA_DETAIL)
  shader:send("evolveSpeed", LAVA_TUNING.EVOLVE_SPEED)
  shader:send("scrollSpeed", LAVA_TUNING.SCROLL_SPEED)
  shader:send("pourSpeed", LAVA_TUNING.POUR_SPEED)
  shader:send("surfaceFeather", SURFACE_FEATHER)
  love.graphics.setShader(shader)
end

-- How big the caustic net's cells are in a layer of water this deep:
-- CAUSTIC_SCALE for a sprayed layer (up to CAUSTIC_GROW_FROM_DEPTH deep),
-- growing for deeper ones — a water planet's are several times bigger.
local function causticScaleFor(depth)
  local grow = math.max(1, depth / CAUSTIC_GROW_FROM_DEPTH) ^ CAUSTIC_GROW_POWER
  return CAUSTIC_SCALE * math.min(CAUSTIC_MAX_GROWTH, grow)
end

-- Round planetoid p's own surface, as points (each with its outward
-- normal and how far round it is, for the ripple) close enough together
-- for the water's surface `depth` out from it to curve smoothly — a
-- circle's, or a rounded rectangle's edges and corners (its corners'
-- share more of them, since the water's surface round a corner is
-- longer than the corner itself).
local function outlineOf(p, depth)
  local points = {}
  if p.isRoundedRect then
    local cr, along = p.cornerRadius, 0
    local function add(lx, ly, nx, ny)
      local w = p:localPointToWorld(lx, ly)
      local n = p:localDirToWorld(nx, ny)
      points[#points + 1] = { x = w.x, y = w.y, nx = n.x, ny = n.y, s = along }
    end
    for _, seg in ipairs(p._segments) do
      if seg.type == "edge" then
        local steps = math.max(1, math.ceil(seg.length / 10))
        for k = 0, steps - 1 do
          local t = seg.length * k / steps
          add(seg.start.x + seg.dir.x * t, seg.start.y + seg.dir.y * t, seg.normal.x, seg.normal.y)
          along = along + seg.length / steps
        end
      else
        local arc = (cr + depth) * math.pi / 2
        local steps = math.max(2, math.ceil(arc / 10))
        for k = 0, steps - 1 do
          local a = seg.startAngle + (math.pi / 2) * k / steps
          local c, s = math.cos(a), math.sin(a)
          add(seg.center.x + c * cr, seg.center.y + s * cr, c, s)
          along = along + arc / steps
        end
      end
      if #points > OCEAN_MAX_SEGMENTS then break end
    end
  else
    local R, outer = p.radius, p.radius + depth
    -- Enough for the ripple round a big one too (a water planet's is
    -- thousands of units round).
    local n = math.max(OCEAN_SEGMENTS, math.min(OCEAN_MAX_SEGMENTS, math.floor(2 * math.pi * outer / 10)))
    for k = 0, n - 1 do
      local a = k / n * math.pi * 2
      local c, s = math.cos(a), math.sin(a)
      points[#points + 1] = { x = p.pos.x + c * R, y = p.pos.y + s * R, nx = c, ny = s, s = a * outer }
    end
  end
  return points
end

-- The water layers round planetoids (see addToOcean), through the same
-- shader as the pools: a band from the planetoid's surface out to the
-- water's rippling surface (depth measured in from there), plus a thin
-- feathered strip just outside it for a soft edge. Each drawn on its own,
-- with caustics sized for how deep it is (see causticScaleFor); a round
-- one's lit as a sphere, with caustics bulging like a globe's.
local oceanMesh, oceanMeshSize = nil, 0
local function drawOceans()
  local cam = state.camera
  if not cam or not next(oceans) then return end
  local vx0, vy0 = cam.x, cam.y
  local vx1, vy1 = cam.x + (state.visibleWidth or 0), cam.y + (state.visibleHeight or 0)
  local shaderOn = false
  for p, o in pairs(oceans) do
    local depth = depthOf(p, o.volume)
    local reach = p.radius + depth + SURFACE_FEATHER + 6
    if p.pos.x + reach > vx0 and p.pos.x - reach < vx1 and p.pos.y + reach > vy0 and p.pos.y - reach < vy1 then
      local verts = {}
      local function vert(x, y, d, alpha) verts[#verts + 1] = { x, y, d, 0, 1, 1, 1, alpha or 1 } end
      local cx, cy = p.pos.x, p.pos.y
      local outline = outlineOf(p, depth)
      local n = #outline
      local function top(q)
        local rip = math.sin(age * 2.2 + q.s * 0.045) * 1.3 + math.sin(age * 3.7 - q.s * 0.11) * 0.6
        local h = math.max(1, depth + rip)
        return q.x + q.nx * h, q.y + q.ny * h, q.x + q.nx * (h + SURFACE_FEATHER), q.y + q.ny * (h + SURFACE_FEATHER)
      end
      for k = 1, n do
        local a, b = outline[k], outline[k % n + 1]
        local ax, ay, afx, afy = top(a)
        local bx, by, bfx, bfy = top(b)
        -- Body: planetoid surface (deepest) out to the water's surface.
        vert(a.x, a.y, depth); vert(b.x, b.y, depth); vert(bx, by, 0)
        vert(a.x, a.y, depth); vert(bx, by, 0); vert(ax, ay, 0)
        -- Feathered edge just outside the surface.
        vert(ax, ay, 0); vert(bx, by, 0); vert(bfx, bfy, -SURFACE_FEATHER)
        vert(ax, ay, 0); vert(bfx, bfy, -SURFACE_FEATHER); vert(afx, afy, -SURFACE_FEATHER)
      end

      -- Over the planetoid itself: the water seen through to it, faded by
      -- how deep the water is — not at all under a sliver, more and more
      -- (color, caustics and all) as it deepens (see CORE_OVERLAY_*).
      local overlay = math.min(1, math.max(0, (depth - CORE_OVERLAY_FROM_DEPTH)
        / (CORE_OVERLAY_FULL_DEPTH - CORE_OVERLAY_FROM_DEPTH))) * CORE_OVERLAY_MAX
      if overlay > 0 then
        for k = 1, n do
          local a, b = outline[k], outline[k % n + 1]
          vert(cx, cy, depth, overlay); vert(a.x, a.y, depth, overlay); vert(b.x, b.y, depth, overlay)
        end
      end

      if not oceanMesh or oceanMeshSize < #verts then
        oceanMeshSize = math.max(#verts, oceanMeshSize * 2, 600)
        oceanMesh = love.graphics.newMesh(oceanMeshSize, "triangles", "stream")
      end
      oceanMesh:setVertices(verts)
      oceanMesh:setDrawRange(1, #verts)
      if not shaderOn then
        useWaterShader()
        love.graphics.setColor(1, 1, 1, 1)
        shaderOn = true
      end
      local shader = getWaterShader()
      shader:send("causticScale", causticScaleFor(depth))
      if p.isRoundedRect then
        -- (Not a sphere: the plain depth gradient, flat caustics.)
        shader:send("causticBulge", 0)
        shader:send("sphereShading", 0)
      else
        shader:send("bulgeCenter", { cx, cy })
        shader:send("bulgeRadius", p.radius + depth)
        shader:send("causticBulge", CAUSTIC_BULGE)
        -- Lit as a sphere by the sun (the same "sun at the exact center
        -- of the scene" convention the planetoids' own shading uses).
        local sdx, sdy = (state.sceneWidth or 0) / 2 - cx, (state.sceneHeight or 0) / 2 - cy
        local sd = math.sqrt(sdx * sdx + sdy * sdy)
        if sd < 1 then sdx, sdy, sd = 1, 0, 1 end
        shader:send("sphereShading", 1)
        shader:send("sunDir", { sdx / sd, sdy / sd })
      end
      love.graphics.draw(oceanMesh)
    end
  end
  if shaderOn then love.graphics.setShader() end
end

-- In world space (inside the camera transform). Drawn after Bob, so
-- he looks like he's in the water when he's swimming.
-- A dirt planet's water (see "Water on a dirt planet"), through the same
-- shader and the same way as the pools (see drawPools — the same rules,
-- on the planet's grid: "down" toward its center, or down the flat
-- layout's rows; a column's height measured up from there):
--   - each column's resting water drawn as one stack from its floor up,
--     taking in up to two part-full cells over its full ones, at its real
--     height, so a pool's edge or a gently sloping surface doesn't step
--     row to row or throw up stray streams;
--   - a little water just settling onto a pool, or spilling a cell or
--     two down a step onto water below, not drawn at all (it's part of
--     the pool by next step; drawn as a stream it'd stick up out of the
--     surface as a one-cell spike);
--   - the surface in thin slices easing toward the columns either side
--     and rippling, so it curves rather than stepping column to column;
--   - and falling water as a narrow stream down the middle of its column,
--     reaching down through any dry gap to whatever it's falling onto.
-- Only what's on screen. (Positions are in columns, f — c + 0.5 is
-- column c's middle — and heights, h: see planetPoint.)
-- (liquid: WATER or LAVA, as drawPools.)
local function drawPlanetWater(g, liquid)
  local cam = state.camera
  if not cam then return end
  local margin = CELL * 4
  local vx0, vy0 = cam.x - margin, cam.y - margin
  local vx1, vy1 = cam.x + (state.visibleWidth or 0) + margin, cam.y + (state.visibleHeight or 0) + margin
  local px, py = g.planet.pos.x, g.planet.pos.y
  local cols, water, rows = g.cols, g[liquid.key], g.rows
  local rippleScale = liquid == LAVA and LAVA_TUNING.RIPPLE or 1
  local verts = {}

  -- How high row r's bottom edge is.
  local function cellBottom(r) return g.top - (r + 1) * CELL end
  -- A strip from column position f0 to f1: hTop0/hTop1 the height of its
  -- top edge at each end, hBottom0/hBottom1 its bottom's; depthTop/
  -- depthBottom how far below the surface those edges are; stream 1 for
  -- falling water.
  local function quad(f0, hTop0, f1, hTop1, hBottom0, hBottom1, depthTop, depthBottom, stream)
    local x1, y1 = planetPoint(g, f0, hTop0)
    local x2, y2 = planetPoint(g, f1, hTop1)
    local x3, y3 = planetPoint(g, f1, hBottom1)
    local x4, y4 = planetPoint(g, f0, hBottom0)
    local v1 = { px + x1, py + y1, depthTop, stream, 1, 1, 1, 1 }
    local v2 = { px + x2, py + y2, depthTop, stream, 1, 1, 1, 1 }
    local v3 = { px + x3, py + y3, depthBottom, stream, 1, 1, 1, 1 }
    local v4 = { px + x4, py + y4, depthBottom, stream, 1, 1, 1, 1 }
    verts[#verts + 1] = v1; verts[#verts + 1] = v2; verts[#verts + 1] = v3
    verts[#verts + 1] = v1; verts[#verts + 1] = v3; verts[#verts + 1] = v4
  end
  -- Where the ground under resting water in cell row r really is, at
  -- column position f: on the flat layout, its square cells don't follow
  -- the planet's curved ground, so found between the middles of the cell
  -- and the one under it (round the planet, the cell's own bottom).
  local planet = g.planet
  local function floorAt(f, r)
    local bottom = cellBottom(r)
    if not g.flat then return bottom end
    local lo, hi = bottom - CELL * 0.5, bottom + CELL * 0.5
    if planet:solidAtLocal(planetPoint(g, f, hi)) then return hi end
    if not planet:solidAtLocal(planetPoint(g, f, lo)) then return lo end
    for _ = 1, 5 do
      local mid = (lo + hi) / 2
      if planet:solidAtLocal(planetPoint(g, f, mid)) then lo = mid else hi = mid end
    end
    return (lo + hi) / 2
  end
  -- (The same two waves as the pools', by distance along the surface.)
  local function ripple(f, h)
    local s = g.flat and f * CELL or (g.a0 + f * g.dA) * h
    return (math.sin(age * 2.2 + s * 0.045) * 1.3 + math.sin(age * 3.7 - s * 0.11) * 0.6) * rippleScale
  end

  -- The stacks (see drawPools): stackSurface[i] its surface's height,
  -- for every cell in it; stackFloor[i] its bottom cell, which draws it.
  local stackSurface, stackFloor = {}, {}
  local capped, capDepth = {}, {} -- (by a stack's floor cell: see drawPools')
  for i in pairs(water) do
    local r = math.floor((i - 1) / cols)
    local c = (i - 1) - r * cols
    if planetSolid(g, c, r + 1) then
      local members, total, partials, below = {}, 0, 0, math.huge
      local j, jr = i, r
      while jr >= 0 and water[j] do
        local w = math.min(1, water[j])
        if w < 0.99 then
          if partials == 2 or w >= below then break end
          partials = partials + 1
        end
        members[#members + 1] = j
        total = total + w
        below = w
        j, jr = j - cols, jr - 1
      end
      local surface = cellBottom(r) + math.max(2, total * CELL)
      for _, m in ipairs(members) do
        stackSurface[m] = surface
        stackFloor[m] = i
      end
      -- (Full up to something solid over it — an ice tile, say: see drawPools'.)
      local topRow = r - #members + 1
      if total >= #members - 0.01 and topRow > 0 and planetSolid(g, c, topRow - 1) then capped[i] = topRow end
    end
  end
  for i in pairs(capped) do
    local r = math.floor((i - 1) / cols)
    local c = (i - 1) - r * cols
    for d = 1, 8 do
      local found
      for _, k in ipairs({ c - d, c + d }) do
        local nc = planetCol(g, k)
        local n = nc and r * cols + nc + 1
        if n and stackFloor[n] and not capped[stackFloor[n]] and stackSurface[n] > stackSurface[i] then
          found = stackSurface[n]
          break
        end
      end
      if found then
        capDepth[i] = found - stackSurface[i]
        break
      end
    end
  end
  local function isFalling(i) return not stackSurface[i] end
  -- The resting water's surface in column c at about row r: that cell's
  -- stack, or the one just above or below it.
  local function surfaceNear(c, r)
    local cc = planetCol(g, c)
    if not cc then return nil end
    for _, rr in ipairs({ r, r + 1, r - 1 }) do
      if rr >= 0 and rr < rows then
        local s = stackSurface[rr * cols + cc + 1]
        if s then return s end
      end
    end
    return nil
  end

  for i, w in pairs(water) do
    local r = math.floor((i - 1) / cols)
    local c = (i - 1) - r * cols
    local drawn = not stackFloor[i] or stackFloor[i] == i
    local fm = c + 0.5
    local rMid = g.top - (r + 0.5) * CELL
    local x, y = planetPoint(g, fm, rMid)
    x, y = px + x, py + y
    if drawn and x > vx0 and x < vx1 and y > vy0 and y < vy1 then
      local f0, f1 = c, c + 1
      local rTop, rBottom = g.top - r * CELL, cellBottom(r)

      -- Settling onto a pool, or stepping a cell or two down onto water
      -- below: not drawn (see above). A real waterfall always has more
      -- falling water above it, so it still is.
      local quiet = false
      if isFalling(i) and not water[i - 2 * cols] then
        local b1, b2 = i + cols, i + 2 * cols
        if (water[b1] and not isFalling(b1)) or (not water[b1] and water[b2] and not isFalling(b2)) then
          quiet = not water[i - cols] or not isFalling(i - cols)
        end
      end

      if quiet then
        -- (nothing)
      elseif isFalling(i) then
        local half = CELL * math.min(1, 0.25 + w * 2.5) / 2 / planetColWidth(g, rMid)
        local streamBottom = rBottom
        local j, jr, gap = i + cols, r + 1, 0
        while gap < STREAM_REACH_CELLS and jr < rows and not water[j] and not planetSolid(g, c, jr) do
          j, jr, gap = j + cols, jr + 1, gap + 1
          streamBottom = streamBottom - CELL
        end
        if water[j] and not isFalling(j) then streamBottom = math.min(streamBottom, stackSurface[j]) end

        -- Pouring over an edge (see drawPools): resting water right beside
        -- it, the sheet on the ledge it's spilling off. The stream starts
        -- at that water's surface, and a short lip of water runs from the
        -- ledge's edge over to the stream, so the pour is one piece with
        -- the water it comes from instead of a separate stream beside it.
        local streamTop = rTop
        local function sourceSurface(dc)
          local nc = planetCol(g, c + dc)
          if not nc then return nil end
          local n = r * cols + nc + 1
          if water[n] and not isFalling(n) then return stackSurface[n] end
          if r > 0 and water[n - cols] and not isFalling(n - cols) then return stackSurface[n - cols] end
          return nil
        end
        local srcBefore, srcAfter = sourceSurface(-1), sourceSurface(1)
        local src, side = srcBefore, -1
        if srcAfter and (not srcBefore or srcAfter > srcBefore) then src, side = srcAfter, 1 end
        if src then
          streamTop = src
          local edgeF = side < 0 and f0 or f1
          local lipTop = src + ripple(edgeF, src)
          if side < 0 then
            quad(edgeF, lipTop, fm, src - 2, lipTop - LIP_THICKNESS, src - 2 - LIP_THICKNESS, 0, 0, 1)
          else
            quad(fm, src - 2, edgeF, lipTop, src - 2 - LIP_THICKNESS, lipTop - LIP_THICKNESS, 0, 0, 1)
          end
        end
        quad(fm - half, streamTop, fm + half, streamTop, streamBottom, streamBottom, 0, 0, 1)
      else
        local surface = stackSurface[i]
        local cap = capped[stackFloor[i]] and (capDepth[stackFloor[i]] or 0)
        local function neighborSurface(dc)
          local s = surfaceNear(c + dc, r)
          if not s or math.abs(s - surface) > CELL * 1.5 or cap then return surface end
          return s
        end
        local left, right = neighborSurface(-1), neighborSurface(1)
        local function heightAt(f) -- f: 0..1 across the cell
          if f < 0.5 then
            local k = 0.5 + f
            return left + (surface - left) * (0.5 - 0.5 * math.cos(math.pi * k))
          end
          local k = f - 0.5
          return surface + (right - surface) * (0.5 - 0.5 * math.cos(math.pi * k))
        end
        -- (Its bottom on the ground under it: see floorAt.)
        local floorRow = math.floor((stackFloor[i] - 1) / cols)
        local fl = {}
        for s = 0, SURFACE_SLICES do
          fl[s] = (floorRow == r) and floorAt(c + s / SURFACE_SLICES, r) or rBottom
        end
        for s = 0, SURFACE_SLICES - 1 do
          local fa, fb = s / SURFACE_SLICES, (s + 1) / SURFACE_SLICES
          local ba, bb = fl[s], fl[s + 1]
          local ha, hb = heightAt(fa), heightAt(fb)
          local ta = math.max(ha + (cap and 0 or ripple(c + fa, surface)), ba + 1)
          local tb = math.max(hb + (cap and 0 or ripple(c + fb, surface)), bb + 1)
          local d0 = cap or 0
          quad(c + fa, ta, c + fb, tb, ba, bb, d0, d0 + (ha + hb) / 2 - (ba + bb) / 2, 0)
          -- (A strip over the top, for the surface's soft edge — not under a cap.)
          if not cap then
            quad(c + fa, ta + SURFACE_FEATHER, c + fb, tb + SURFACE_FEATHER, ta, tb, -SURFACE_FEATHER, 0, 0)
          end
        end
      end
    end
  end
  if #verts == 0 then return end
  drawLiquidMesh("planet-" .. liquid.key, verts, liquid)
end

-- The obsidian blocks on the level (see "Lava meeting water"). (A dirt
-- planet's are part of its own picture.)
local function drawLevelObsidian()
  local image = nil
  for _, e in ipairs(obsidians) do
    if e.kind == "level" then
      image = image or getObsidianImage()
      love.graphics.setColor(1, 1, 1, 1)
      love.graphics.draw(image, e.x0, e.y0, 0, e.size / image:getWidth(), e.size / image:getHeight())
    end
  end
end

local function drawLavaEmbers()
  for _, e in ipairs(lavaEmbers) do
    local a = math.max(0, e.life)
    love.graphics.setColor(1, 0.35 + 0.5 * a, 0.05 + 0.25 * a, a)
    love.graphics.circle("fill", e.x, e.y, e.radius)
  end
end

function WaterSystem.draw()
  drawLevelObsidian()
  if grid then drawPools(WATER) end
  for _, g in pairs(planetGrids) do drawPlanetWater(g, WATER) end
  -- The ice blocks, in the water (see "Ice").
  Ice.drawLevel()
  -- The lava, over the water (and, like it, over Bob: he's in it).
  if grid and next(grid.lava) then drawPools(LAVA) end
  for _, g in pairs(planetGrids) do
    if next(g.lava) then drawPlanetWater(g, LAVA) end
  end
  drawLavaEmbers()

  love.graphics.setLineWidth(2.5)
  for _, d in ipairs(droplets) do
    local speed = math.sqrt(d.vx * d.vx + d.vy * d.vy)
    local tail = math.min(10, speed * 0.8) / math.max(speed, 0.001)
    -- (A lava droplet — out of a portal: see drainIntoPortals — hot,
    -- trailing darker; bigger, as lava's jets are thicker.)
    local head = d.lava and LAVA_TUNING.COLOR_HOT or COLOR_DROPLET
    local trail = d.lava and LAVA_TUNING.COLOR_MID or COLOR_DROPLET
    love.graphics.setColor(trail[1], trail[2], trail[3], d.lava and 0.9 or COLOR_DROPLET[4] * 0.6)
    love.graphics.line(d.x - d.vx * tail, d.y - d.vy * tail, d.x, d.y)
    love.graphics.setColor(head[1], head[2], head[3], d.lava and 1 or COLOR_DROPLET[4])
    love.graphics.circle("fill", d.x, d.y, d.lava and 3 or 2.2)
  end
  love.graphics.setLineWidth(1)
  for _, s in ipairs(splashes) do
    local c = s.lava and LAVA_TUNING.COLOR_HOT or COLOR_DROPLET
    love.graphics.setColor(c[1], c[2], c[3], s.life / SPLASH_SECONDS)
    love.graphics.circle("fill", s.x, s.y, s.size)
  end
  love.graphics.setColor(1, 1, 1, 1)
end

-- Whether Bob's spraying right now (see Player:isUsingBlaster).
-- The planetoids' water layers (see addToOcean), and steam over all the
-- water. Drawn later than WaterSystem.draw — after the fish as well as
-- Bob (see main.lua), so both read as under the water.
function WaterSystem.drawOceans()
  drawOceans()
  drawSteam()
end

function WaterSystem.isSpraying()
  return isSpraying
end

-- All the water there is (on the level, on planets, in the air), as of
-- this frame, and the most there can be — in cells' worth.
function WaterSystem.totalWater()
  return math.max(0, totalWater)
end

function WaterSystem.waterCap()
  return WATER_CAP
end

-- For debugging/tests: how much water is on planetoid `p`, if any.
function WaterSystem.debugOcean(p)
  return oceans[p] and oceans[p].volume or 0
end

-- For debugging/tests: planet p's water grid, if it has one (see "Water on
-- a dirt planet"), and its cell lookup and solid test.
function WaterSystem.debugPlanetGrid(p)
  return planetGrids[p], planetCellOf, planetSolid, CELL
end

-- For debugging/tests: how much resting water each portal has taken in
-- (cells' worth, all-time): { red = ..., blue = ... }.
function WaterSystem.debugPortalFlow()
  return portalTakenIn
end

-- For debugging/tests: the grid and its solid test (read-only use).
function WaterSystem.debugGrid()
  return grid, isSolid, CELL
end

-- For debugging/tests: the obsidian blocks (see "Lava meeting water").
function WaterSystem.debugObsidians()
  return obsidians
end

return WaterSystem
