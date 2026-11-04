-- lua/systems/water/Tuning.lua
--
-- All of the water system's tunable numbers and colors: the simulation,
-- spraying, portals, steam, lava, and the look of water and lava.
-- Part of the water system: see lua/systems/WaterSystem.lua.

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
local CORE_OVERLAY_MAX = 0.85
local CAUSTIC_BULGE = 1.0        -- how much a planetoid's water's caustics bulge like a globe's (0 = flat, 1 = full)
local CAUSTIC_SPEED = 0.6
local CAUSTIC_STRENGTH = 0.3
local COLOR_DROPLET = { 0.70, 0.88, 1.00, 0.95 }

return {
  CELL = CELL,
  STEP_SECONDS = STEP_SECONDS,
  MAX_STEPS_PER_FRAME = MAX_STEPS_PER_FRAME,
  SPREAD = SPREAD,
  SPREAD_PASSES = SPREAD_PASSES,
  MIN_SPREAD = MIN_SPREAD,
  EVAPORATE_PER_SECOND = EVAPORATE_PER_SECOND,
  DRY = DRY,
  SPRAY_PER_SECOND = SPRAY_PER_SECOND,
  SPRAY_SPEED = SPRAY_SPEED,
  SPRAY_SPEED_RANGE = SPRAY_SPEED_RANGE,
  SPRAY_SPREAD = SPRAY_SPREAD,
  DROPLET_VOLUME = DROPLET_VOLUME,
  DROPLET_SECONDS = DROPLET_SECONDS,
  MAX_DROPLETS = MAX_DROPLETS,
  HITS_POOL = HITS_POOL,
  PORTAL_FLOW_PER_SECOND = PORTAL_FLOW_PER_SECOND,
  PORTAL_JET_VOLUME = PORTAL_JET_VOLUME,
  OCEAN_LEVEL_RATE = OCEAN_LEVEL_RATE,
  OCEAN_LEVEL_SLACK = OCEAN_LEVEL_SLACK,
  PORTAL_JET_SPEED = PORTAL_JET_SPEED,
  PORTAL_JET_SPEED_RANGE = PORTAL_JET_SPEED_RANGE,
  PORTAL_JET_SPREAD = PORTAL_JET_SPREAD,
  WATER_CAP = WATER_CAP,
  SPUTTER_FRACTION = SPUTTER_FRACTION,
  OCEAN_SEGMENTS = OCEAN_SEGMENTS,
  OCEAN_MAX_SEGMENTS = OCEAN_MAX_SEGMENTS,
  SPLASH_BITS = SPLASH_BITS,
  SPLASH_SECONDS = SPLASH_SECONDS,
  WATERFALL_SPLASH_PER_SECOND = WATERFALL_SPLASH_PER_SECOND,
  WATERFALL_SPLASH_MIN_FALL = WATERFALL_SPLASH_MIN_FALL,
  WATERFALL_SPLASH = WATERFALL_SPLASH,
  QUENCH_AT = QUENCH_AT,
  BOIL_ON_HIT = BOIL_ON_HIT,
  BOIL_PER_SECOND = BOIL_PER_SECOND,
  HOT_SECONDS = HOT_SECONDS,
  BOIL_REACH_CELLS = BOIL_REACH_CELLS,
  STEAM_BURST = STEAM_BURST,
  STEAM_PER_SECOND = STEAM_PER_SECOND,
  STEAM_SECONDS = STEAM_SECONDS,
  STEAM_RISE = STEAM_RISE,
  STEAM_START_DEPTH = STEAM_START_DEPTH,
  STEAM_SIZE = STEAM_SIZE,
  STEAM_GROWTH = STEAM_GROWTH,
  STEAM_ALPHA = STEAM_ALPHA,
  COLOR_STEAM = COLOR_STEAM,
  LAVA_TUNING = LAVA_TUNING,
  COLOR_SHALLOW = COLOR_SHALLOW,
  COLOR_DEEP = COLOR_DEEP,
  DEEP_AT = DEEP_AT,
  ALPHA_SHALLOW = ALPHA_SHALLOW,
  ALPHA_DEEP = ALPHA_DEEP,
  COLOR_SURFACE = COLOR_SURFACE,
  SURFACE_LINE = SURFACE_LINE,
  SURFACE_FEATHER = SURFACE_FEATHER,
  STREAM_REACH_CELLS = STREAM_REACH_CELLS,
  LIP_THICKNESS = LIP_THICKNESS,
  SURFACE_SLICES = SURFACE_SLICES,
  SURFACE_GLOW = SURFACE_GLOW,
  COLOR_CAUSTIC = COLOR_CAUSTIC,
  CAUSTIC_SCALE = CAUSTIC_SCALE,
  CAUSTIC_GROW_FROM_DEPTH = CAUSTIC_GROW_FROM_DEPTH,
  CAUSTIC_GROW_POWER = CAUSTIC_GROW_POWER,
  CAUSTIC_MAX_GROWTH = CAUSTIC_MAX_GROWTH,
  SPHERE_COLOR_SHALLOW = SPHERE_COLOR_SHALLOW,
  SPHERE_COLOR_DEEP = SPHERE_COLOR_DEEP,
  SPHERE_COLOR_SHADE = SPHERE_COLOR_SHADE,
  SPHERE_SHADE_STRENGTH = SPHERE_SHADE_STRENGTH,
  SPHERE_COLOR_RIM = SPHERE_COLOR_RIM,
  SPHERE_RIM_STRENGTH = SPHERE_RIM_STRENGTH,
  SPHERE_COLOR_REFLECTED = SPHERE_COLOR_REFLECTED,
  SPHERE_REFLECTED_STRENGTH = SPHERE_REFLECTED_STRENGTH,
  CORE_OVERLAY_FROM_DEPTH = CORE_OVERLAY_FROM_DEPTH,
  CORE_OVERLAY_FULL_DEPTH = CORE_OVERLAY_FULL_DEPTH,
  CORE_OVERLAY_MAX = CORE_OVERLAY_MAX,
  CAUSTIC_BULGE = CAUSTIC_BULGE,
  CAUSTIC_SPEED = CAUSTIC_SPEED,
  CAUSTIC_STRENGTH = CAUSTIC_STRENGTH,
  COLOR_DROPLET = COLOR_DROPLET,
}
