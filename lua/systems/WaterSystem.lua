-- lua/systems/WaterSystem.lua
--
-- Water mode (see WeaponModes.lua): right click / R2 sprays water from the
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

local WaterSystem = {}

----------------------------------------------------------------------
-- Tunables
----------------------------------------------------------------------

local CELL = 16                   -- world units per water cell (a Tiled tile is 64: 4x4 cells)
local STEP_SECONDS = 1 / 60       -- water moves in fixed steps...
local MAX_STEPS_PER_FRAME = 3     -- ...at most this many per frame (after a stutter)
local SPREAD = 0.25               -- share of the difference moved to a lower sideways neighbor each step
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
local age = 0
local mesh, meshSize = nil, 0

-- What a pool is to Bob while he's in one (Player.submergedIn). His swim
-- code treats water as round, like a water planet: it pushes him away
-- from the water's `pos` and lets his bubbles rise out to its `radius`.
-- So this one's pos is kept far straight below him ("away" is then
-- straight up, and his swimming steers plain left/right) and its radius
-- reaches from there up to the pool's surface (see submergedAt).
local poolWater = { isPool = true, pos = Vector2.new(0, 0), radius = 0 }

function WaterSystem.reset()
  grid = nil
  droplets, splashes, waterfallLandings = {}, {}, {}
  steam, hotSpots = {}, {}
  sprayBudget, stepClock = 0, 0
  isSpraying = false
  totalWater = 0
  oceans = setmetatable({}, { __mode = "k" })
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
  local g = { x0 = level.anchorX, y0 = level.anchorY, cols = cols, rows = rows, solid = {}, floor = {}, water = {} }
  local function inside(c, r) return c >= 0 and c < cols and r >= 0 and r < rows end

  -- Wall tiles: every cell whose middle is inside one.
  for _, w in ipairs(level.walls or {}) do
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

local function addWater(c, r, amount)
  if amount <= 0 or not inGrid(c, r) then return end
  local i = r * grid.cols + c + 1
  grid.water[i] = (grid.water[i] or 0) + amount
end

-- One step of the water moving: bottom rows first, so each bit of water
-- moves once per step.
local function stepWater(dt)
  local cols, water = grid.cols, grid.water
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

      -- Spreads sideways along whatever it's resting on (ground, or full
      -- water) — toward lower neighbors, evening out into a flat surface.
      local resting = blocked(c, r, 0, 1) or (water[i + cols] or 0) >= 0.99
      if resting and w > MIN_SPREAD then
        for k = 1, 2 do
          local dc = ((k == 1) == grid.flip) and -1 or 1
          local nc = c + dc
          if nc < 0 or nc >= cols then
            w = w - w * SPREAD -- off the map's edge: it runs away
          elseif not blocked(c, r, dc, 0) then
            local n = i + dc
            local wn = water[n] or 0
            if wn < w then
              local f = (w - wn) * SPREAD
              water[n] = wn + f
              w = w - f
            end
          end
        end
      end

      -- Evaporates from the surface (nothing on top of it).
      if r == 0 or not water[i - cols] then
        w = w - EVAPORATE_PER_SECOND * dt
      end

      if w < DRY then water[i] = nil else water[i] = w end
    end
  end
end

----------------------------------------------------------------------
-- Swimming
----------------------------------------------------------------------

-- Whether the point (x, y) is in water — real water, not just a damp
-- film on the floor (see Player:tryGroundPound).
function WaterSystem.wetAt(x, y)
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

local function spawnSplash(x, y, upX, upY)
  for _ = 1, SPLASH_BITS do
    local a = math.atan2(upY, upX) + (math.random() * 2 - 1) * 1.1
    local speed = 1.5 + math.random() * 2.5
    table.insert(splashes, {
      x = x, y = y, vx = math.cos(a) * speed, vy = math.sin(a) * speed,
      gx = -upX * 0.3, gy = -upY * 0.3,
      life = SPLASH_SECONDS, size = 1 + math.random() * 1.5,
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
  if p.isRoundedRect then
    local n = p:nearestSurfacePoint(d.x, d.y).normal
    return -n.x * s, -n.y * s
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
      table.insert(droplets, {
        x = ox, y = oy,
        vx = math.cos(a) * speed + player.vel.x, vy = math.sin(a) * speed + player.vel.y,
        life = DROPLET_SECONDS,
        volume = empty and 0 or DROPLET_VOLUME,
        planet = sprayPlanet,
      })
      if not empty then totalWater = totalWater + DROPLET_VOLUME end
    end
  end
end

-- Moves a droplet; true once it's landed (or gone).
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
          if not isSolid(lastC, lastR) then addWater(lastC, lastR, volume) end
          spawnSplash(x, y, -d.vx / speed, -d.vy / speed)
          return true
        end
        if (grid.water[r * grid.cols + c + 1] or 0) >= HITS_POOL then
          addWater(c, r, volume)
          spawnSplash(x, y, 0, -1)
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
      if g > 0 then spawnSplash(d.x, d.y, -gx2 / g, -gy2 / g) end
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
local portalDrained = {}
local function drainIntoPortals(dt)
  local portals = state.portals
  if not (portals and portals.red and portals.blue) then return end
  for _, color in ipairs({ "red", "blue" }) do
    local p = portals[color]
    if p.ny < 0.3 and p.mouth then
      -- The open cells just in front of its opening.
      local cells, order = {}, {}
      for _, m in ipairs(p.mouth) do
        local x, y = m.x + m.nx * CELL * 0.5, m.y + m.ny * CELL * 0.5
        local c, r = cellOf(x, y)
        if inGrid(c, r) and not isSolid(c, r) then
          local i = r * grid.cols + c + 1
          if not cells[i] then
            cells[i] = { x = x, y = y }
            order[#order + 1] = i
          end
        end
      end

      local share = #order > 0 and PORTAL_FLOW_PER_SECOND * dt / #order or 0
      local wet = {}
      for _, i in ipairs(order) do
        local w = grid.water[i]
        if w then
          local f = math.min(w, share)
          w = w - f
          grid.water[i] = (w >= DRY) and w or nil
          portalDrained[color] = (portalDrained[color] or 0) + f
          wet[#wet + 1] = cells[i]
        end
      end

      -- Out of the other portal, a droplet per PORTAL_JET_VOLUME taken in.
      while (portalDrained[color] or 0) >= PORTAL_JET_VOLUME and #wet > 0 and #droplets < MAX_DROPLETS do
        portalDrained[color] = portalDrained[color] - PORTAL_JET_VOLUME
        local at = wet[math.random(#wet)]
        local a = math.atan2(-p.ny, -p.nx) + (math.random() * 2 - 1) * PORTAL_JET_SPREAD
        local speed = PORTAL_JET_SPEED + math.random() * PORTAL_JET_SPEED_RANGE
        local x, y, vx, vy, to = PortalGun.throughPortal(p, at.x, at.y, math.cos(a) * speed, math.sin(a) * speed, 4)
        if x then
          -- Out onto a round planetoid: straight into its water (see
          -- drainOceansIntoPortals), the jet just for show.
          local intoOcean = holdsWater(to.obj)
          if intoOcean then addToOcean(to.obj, PORTAL_JET_VOLUME) end
          table.insert(droplets, {
            x = x, y = y, vx = vx, vy = vy, life = DROPLET_SECONDS,
            volume = intoOcean and 0 or PORTAL_JET_VOLUME,
            planet = not (to.obj.isWall or to.obj.isGate) and to.obj or nil,
          })
        end
      end
      if #wet == 0 then portalDrained[color] = 0 end
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
local function spawnSteam(x, y, upX, upY, spread)
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
  totalWater = 0
  if grid then for _, w in pairs(grid.water) do totalWater = totalWater + w end end
  -- (Less the water planets' own water — see addNaturalOcean.)
  for _, o in pairs(oceans) do totalWater = totalWater + o.volume - (o.natural or 0) end
  for _, d in ipairs(droplets) do totalWater = totalWater + (d.volume or DROPLET_VOLUME) end

  local sprayHeld = state.waterMode and (love.mouse.isDown(2) or state.gamepadSprayHeld)
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

  if grid then
    stepClock = stepClock + dt * ts
    local steps = 0
    while stepClock >= STEP_SECONDS and steps < MAX_STEPS_PER_FRAME do
      stepWater(STEP_SECONDS)
      stepClock = stepClock - STEP_SECONDS
      steps = steps + 1
    end
    if stepClock > STEP_SECONDS then stepClock = 0 end
    drainIntoPortals(dt * ts)
  end
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
local useWaterShader
local function drawPools()
  local cam = state.camera
  if not cam then return end
  local vx0, vy0 = cam.x - CELL, cam.y - CELL
  local vx1, vy1 = cam.x + (state.visibleWidth or 0) + CELL, cam.y + (state.visibleHeight or 0) + CELL
  local cols, water = grid.cols, grid.water
  local verts = {}
  waterfallLandings = {}

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
    return math.sin(age * 2.2 + x * 0.045) * 1.3 + math.sin(age * 3.7 - x * 0.11) * 0.6
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
          if streamBottom - fallTop >= WATERFALL_SPLASH_MIN_FALL then
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
            return s
          end
          local left, right = neighborSurface(-1), neighborSurface(1)
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
            local ta = math.min(ha + ripple(xa), bottom - 1)
            local tb = math.min(hb + ripple(xb), bottom - 1)
            local ba, bb = bottomAt(xa), bottomAt(xb)
            quad(xa, ta, xb, tb, ba, bb, 0, (ba + bb) / 2 - (ha + hb) / 2, 0)
            -- A thin strip just above the surface (negative depth) that the
            -- shader fades out, so the top edge is soft rather than a hard
            -- pixel line.
            quad(xa, ta - SURFACE_FEATHER, xb, tb - SURFACE_FEATHER, ta, tb, -SURFACE_FEATHER, 0, 0)
          end
        end
      end
    end
  end

  if #verts == 0 then return end
  if not mesh or meshSize < #verts then
    meshSize = math.max(#verts, meshSize * 2, 600)
    mesh = love.graphics.newMesh(meshSize, "triangles", "stream")
  end
  mesh:setVertices(verts)
  mesh:setDrawRange(1, #verts)
  useWaterShader()
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(mesh)
  love.graphics.setShader()
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
function WaterSystem.draw()
  if grid then drawPools() end

  love.graphics.setLineWidth(2.5)
  for _, d in ipairs(droplets) do
    local speed = math.sqrt(d.vx * d.vx + d.vy * d.vy)
    local tail = math.min(10, speed * 0.8) / math.max(speed, 0.001)
    love.graphics.setColor(COLOR_DROPLET[1], COLOR_DROPLET[2], COLOR_DROPLET[3], COLOR_DROPLET[4] * 0.6)
    love.graphics.line(d.x - d.vx * tail, d.y - d.vy * tail, d.x, d.y)
    love.graphics.setColor(COLOR_DROPLET)
    love.graphics.circle("fill", d.x, d.y, 2.2)
  end
  love.graphics.setLineWidth(1)
  for _, s in ipairs(splashes) do
    love.graphics.setColor(COLOR_DROPLET[1], COLOR_DROPLET[2], COLOR_DROPLET[3], s.life / SPLASH_SECONDS)
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

-- For debugging/tests: the grid and its solid test (read-only use).
function WaterSystem.debugGrid()
  return grid, isSolid, CELL
end

return WaterSystem
