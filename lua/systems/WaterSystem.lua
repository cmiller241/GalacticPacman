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

--
-- The parts are in lua/systems/water/:
--   Tuning.lua       every tunable number and color
--   Shared.lua       the state the parts share (shared), and scratch buffers
--   Oceans.lua       water layers on round planetoids
--   LevelGrid.lua    the Tiled level's water grid and its stepping
--   PlanetGrids.lua  water on dirt planets
--   Effects.lua      splashes and steam
--   Obsidian.lua     lava meeting water
--   Ice.lua          the ice blaster's blocks
--   Rendering.lua    drawing water and lava
-- This file has spraying, droplets, portals, fireballs going out,
-- the per-frame update and the public functions.

local state = require("lua.state")
local constants = require("lua.constants")
local Vector2 = require("lua.vector2")
local PortalGun = require("lua.systems.PortalGun")
local Splash = require("lua.effects.Splash")
local Tuning = require("lua.systems.water.Tuning")
local CELL = Tuning.CELL
local STEP_SECONDS = Tuning.STEP_SECONDS
local MAX_STEPS_PER_FRAME = Tuning.MAX_STEPS_PER_FRAME
local EVAPORATE_PER_SECOND = Tuning.EVAPORATE_PER_SECOND
local DRY = Tuning.DRY
local SPRAY_PER_SECOND = Tuning.SPRAY_PER_SECOND
local SPRAY_SPEED = Tuning.SPRAY_SPEED
local SPRAY_SPEED_RANGE = Tuning.SPRAY_SPEED_RANGE
local SPRAY_SPREAD = Tuning.SPRAY_SPREAD
local DROPLET_VOLUME = Tuning.DROPLET_VOLUME
local DROPLET_SECONDS = Tuning.DROPLET_SECONDS
local MAX_DROPLETS = Tuning.MAX_DROPLETS
local HITS_POOL = Tuning.HITS_POOL
local PORTAL_FLOW_PER_SECOND = Tuning.PORTAL_FLOW_PER_SECOND
local PORTAL_JET_VOLUME = Tuning.PORTAL_JET_VOLUME
local OCEAN_LEVEL_RATE = Tuning.OCEAN_LEVEL_RATE
local OCEAN_LEVEL_SLACK = Tuning.OCEAN_LEVEL_SLACK
local PORTAL_JET_SPEED = Tuning.PORTAL_JET_SPEED
local PORTAL_JET_SPEED_RANGE = Tuning.PORTAL_JET_SPEED_RANGE
local PORTAL_JET_SPREAD = Tuning.PORTAL_JET_SPREAD
local WATER_CAP = Tuning.WATER_CAP
local SPUTTER_FRACTION = Tuning.SPUTTER_FRACTION
local WATERFALL_SPLASH_PER_SECOND = Tuning.WATERFALL_SPLASH_PER_SECOND
local WATERFALL_SPLASH = Tuning.WATERFALL_SPLASH
local QUENCH_AT = Tuning.QUENCH_AT
local BOIL_ON_HIT = Tuning.BOIL_ON_HIT
local HOT_SECONDS = Tuning.HOT_SECONDS
local STEAM_BURST = Tuning.STEAM_BURST
local LAVA_TUNING = Tuning.LAVA_TUNING
local Shared = require("lua.systems.water.Shared")
local shared = Shared.shared
local Ice = Shared.Ice
local Scratch = Shared.Scratch
local WATER = Shared.WATER
local LAVA = Shared.LAVA
local Oceans = require("lua.systems.water.Oceans")
local holdsWater = Oceans.holdsWater
local perimeterOf = Oceans.perimeterOf
local depthOf = Oceans.depthOf
local surfaceDistance = Oceans.surfaceDistance
local addToOcean = Oceans.addToOcean
local forgetCulledOceans = Oceans.forgetCulledOceans
local LevelGrid = require("lua.systems.water.LevelGrid")
local cellOf = LevelGrid.cellOf
local inGrid = LevelGrid.inGrid
local isSolid = LevelGrid.isSolid
local blocked = LevelGrid.blocked
local addWater = LevelGrid.addWater
local stepWater = LevelGrid.stepWater
local surfaceAt = LevelGrid.surfaceAt
local boilGrid = LevelGrid.boilGrid
local PlanetGrids = require("lua.systems.water.PlanetGrids")
local PLANET_GRID_MAKE_DISTANCE = PlanetGrids.PLANET_GRID_MAKE_DISTANCE
local planetGridsReset = PlanetGrids.planetGridsReset
local planetUp = PlanetGrids.planetUp
local planetIndex = PlanetGrids.planetIndex
local sweepTurningPlanetGrid = PlanetGrids.sweepTurningPlanetGrid
local newPlanetGrid = PlanetGrids.newPlanetGrid
local planetCellOf = PlanetGrids.planetCellOf
local catchUpPlanetGrid = PlanetGrids.catchUpPlanetGrid
local planetSolid = PlanetGrids.planetSolid
local addPlanetWater = PlanetGrids.addPlanetWater
local convertPlanetGrid = PlanetGrids.convertPlanetGrid
local planetGridAt = PlanetGrids.planetGridAt
local stepPlanetWater = PlanetGrids.stepPlanetWater
local planetSurfaceAt = PlanetGrids.planetSurfaceAt
local boilPlanetGrid = PlanetGrids.boilPlanetGrid
local Effects = require("lua.systems.water.Effects")
local spawnSplash = Effects.spawnSplash
local spawnSteam = Effects.spawnSteam
local updateSteam = Effects.updateSteam
local Obsidian = require("lua.systems.water.Obsidian")
local quenchLevelLava = Obsidian.quenchLevelLava
local quenchPlanetLava = Obsidian.quenchPlanetLava
local updateObsidians = Obsidian.updateObsidians
local updateLavaEmbers = Obsidian.updateLavaEmbers

local IcePart = require("lua.systems.water.Ice")

local Rendering = require("lua.systems.water.Rendering")

local WaterSystem = {}

-- The functions the parts add to WaterSystem.
for _, part in ipairs({ Oceans, LevelGrid, Obsidian, IcePart, Rendering }) do
  for name, fn in pairs(part.api) do
    assert(WaterSystem[name] == nil, "WaterSystem." .. name .. " is defined twice")
    WaterSystem[name] = fn
  end
end

----------------------------------------------------------------------
-- State
----------------------------------------------------------------------

-- (The state the parts share is in water/Shared.lua's shared table.)
local sprayBudget = 0
local isSpraying = false
local totalWater = 0      -- everywhere, as of this frame (see WATER_CAP)
local stepClock = 0
local lavaStepCount = 0   -- (see LAVA_TUNING.STEP_EVERY)

-- What a pool is to Bob while he's in one (Player.submergedIn). His swim
-- code treats water as round, like a water planet: it pushes him away
-- from the water's `pos` and lets his bubbles rise out to its `radius`.
-- So this one's pos is kept far straight below him ("away" is then
-- straight up, and his swimming steers plain left/right) and its radius
-- reaches from there up to the pool's surface (see submergedAt).
local poolWater = { isPool = true, pos = Vector2.new(0, 0), radius = 0 }

function WaterSystem.reset()
  shared.grid = nil
  shared.droplets, shared.splashes, shared.waterfallLandings = {}, {}, {}
  shared.steam, shared.hotSpots = {}, {}
  shared.lavaEmbers, shared.obsidians, lavaStepCount = {}, {}, 0
  Ice.blocks, Ice.frame = {}, 0
  sprayBudget, stepClock = 0, 0
  isSpraying = false
  totalWater = 0
  shared.oceans = setmetatable({}, { __mode = "k" })
  planetGridsReset()
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
  if not shared.grid then return false end
  local c, r = cellOf(x, y)
  if not inGrid(c, r) then return false end
  local i = r * shared.grid.cols + c + 1
  local w = shared.grid.water[i]
  if r > 0 and shared.grid.water[i - shared.grid.cols] then return true end
  return w ~= nil and w >= 0.3 and y > shared.grid.y0 + (r + 1) * CELL - w * CELL
end

-- The pool Bob's middle is under, if any (see Player.lua's submergedIn).
-- That includes a planetoid's water layer: round, it's like a little water
-- planet — centered on the planetoid — so it's handed to his swim code
-- the same way one is. Round a rounded rectangle, it's handed over as a
-- huge round one centered far down past the nearest bit of surface (the
-- same trick as a pool, below), so its surface there is near enough flat.
function WaterSystem.submergedAt(player)
  local x, y = player.pos.x, player.pos.y
  for p, o in pairs(shared.oceans) do
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

  if not shared.grid then return nil end
  local c, r = cellOf(x, y)
  if not inGrid(c, r) then return nil end
  local i = r * shared.grid.cols + c + 1
  local w = shared.grid.water[i]
  local covered = (r > 0 and shared.grid.water[i - shared.grid.cols])
    or (w and y > shared.grid.y0 + (r + 1) * CELL - w * CELL)
  if not covered then return nil end
  -- The surface above him: up the column while there's water.
  local top = r
  while top > 0 and shared.grid.water[(top - 1) * shared.grid.cols + c + 1] do top = top - 1 end
  local surfaceY = shared.grid.y0 + (top + 1) * CELL - math.min(1, shared.grid.water[top * shared.grid.cols + c + 1] or 1) * CELL
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


-- Which way gravity pulls a droplet: straight down on the level (the
-- dome's gravity); toward whatever it was sprayed near, anywhere else.
local function gravityOn(d)
  if shared.grid then
    local c, r = cellOf(d.x, d.y)
    if inGrid(c, r) then
      local dome = state.skyDomePlanet
      return 0, (dome and dome.gravityStrength) or constants.GRAVITY_STRENGTH
    end
  end
  local p = d.planet
  if not p then return 0, 0 end
  local s = p.gravityStrength or constants.GRAVITY_STRENGTH
  -- Straight "down" for wherever it is: opposite the planet's own "up"
  -- (see lua/world/PlanetSurface.lua) — so on the dome's deck and Tiled
  -- ground it falls straight down the screen, and onto the nearest face
  -- of a rounded rectangle.
  local up = p:upAt(d.x, d.y)
  return -up.x * s, -up.y * s
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
    if #shared.droplets < MAX_DROPLETS then
      local a = aim + (math.random() * 2 - 1) * SPRAY_SPREAD * (empty and 2 or 1)
      local speed = (SPRAY_SPEED + math.random() * SPRAY_SPEED_RANGE) * (empty and 0.4 or 1)
      local vx, vy = math.cos(a) * speed + player.vel.x, math.sin(a) * speed + player.vel.y
      -- One step back: the droplet update right after this (same frame,
      -- before drawing) brings it out of the muzzle itself, not a step
      -- beyond it.
      local ts = state.timeScale or 1
      table.insert(shared.droplets, {
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

  if shared.grid then
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
      if inGrid(c, r) or (floorBelow and r >= shared.grid.rows) then
        local speed = math.sqrt(d.vx * d.vx + d.vy * d.vy)
        -- (A floor stops it only coming from its open side — see blocked.)
        if isSolid(c, r) or ((c ~= lastC or r ~= lastR) and blocked(lastC, lastR, c - lastC, r - lastR)) then
          if not isSolid(lastC, lastR) then addWater(lastC, lastR, volume, key) end
          spawnSplash(x, y, -d.vx / speed, -d.vy / speed, d.lava)
          return true
        end
        local i = r * shared.grid.cols + c + 1
        if (shared.grid.water[i] or 0) + (shared.grid.lava[i] or 0) >= HITS_POOL then
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
  if shared.grid then
    local c, r = cellOf(d.x, d.y)
    if inGrid(c, r) and not holdsWater(p) then return false end
  end
  if holdsWater(p) then
    local o = shared.oceans[p]
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
        elseif shared.grid and m.ny < 0.3 then
          local c, r = cellOf(x, y)
          if inGrid(c, r) and not isSolid(c, r) then g, i = shared.grid, r * shared.grid.cols + c + 1 end
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
        while (portalDrained[slot] or 0) >= PORTAL_JET_VOLUME and #wet > 0 and #shared.droplets < MAX_DROPLETS do
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
            table.insert(shared.droplets, {
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
    local o = shared.oceans[p.obj]
    if o and p.x then
      local here = depthOf(p.obj, o.volume)
      local there = 0
      local far = shared.oceans[other.obj]
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
        while oceanDrained[color] >= PORTAL_JET_VOLUME and #shared.droplets < MAX_DROPLETS do
          oceanDrained[color] = oceanDrained[color] - PORTAL_JET_VOLUME
          local m = p.mouth and p.mouth[math.random(#p.mouth)] or { x = p.x, y = p.y, nx = p.nx, ny = p.ny }
          local a = math.atan2(-m.ny, -m.nx) + (math.random() * 2 - 1) * PORTAL_JET_SPREAD
          local speed = PORTAL_JET_SPEED + math.random() * PORTAL_JET_SPEED_RANGE
          local x, y, vx, vy, to = PortalGun.throughPortal(p, m.x + m.nx * 2, m.y + m.ny * 2,
            math.cos(a) * speed, math.sin(a) * speed, 4)
          if x then
            table.insert(shared.droplets, {
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

-- Whether fireball `f` has hit water this frame (anywhere along the path
-- it's just moved, so a fast one can't skip over a thin pool). If it has,
-- it goes out: a burst of steam, BOIL_ON_HIT boiled off at once, and a
-- hot spot left there (see WaterSystem.update). The caller removes it.
function WaterSystem.quenchFireball(f)
  local ts = state.timeScale or 1

  -- A planet's water layer (see addToOcean).
  for p, o in pairs(shared.oceans) do
    local depth = depthOf(p, o.volume)
    local d, nx, ny = surfaceDistance(p, f.pos.x, f.pos.y)
    if d < depth then
      o.volume = math.max(0, o.volume - BOIL_ON_HIT)
      -- (Where the water's surface is, out from where it went in.)
      local sx, sy = f.pos.x + nx * (depth - d), f.pos.y + ny * (depth - d)
      for _ = 1, STEAM_BURST do spawnSteam(sx, sy, nx, ny, 1.0) end
      shared.hotSpots[#shared.hotSpots + 1] = {
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
          shared.hotSpots[#shared.hotSpots + 1] = { pg = pg, c = c, r = r, life = HOT_SECONDS, steamBudget = 0 }
          return true
        end
      end
    end
  end

  -- The pools and streams on the level.
  if shared.grid then
    local x1, y1 = f.pos.x, f.pos.y
    local x0, y0 = x1 - f.vel.x * ts, y1 - f.vel.y * ts
    local dist = math.sqrt((x1 - x0) ^ 2 + (y1 - y0) ^ 2)
    local steps = math.max(1, math.ceil(dist / (CELL * 0.5)))
    for s = 0, steps do
      local x, y = x0 + (x1 - x0) * s / steps, y0 + (y1 - y0) * s / steps
      local c, r = cellOf(x, y)
      if inGrid(c, r) and (shared.grid.water[r * shared.grid.cols + c + 1] or 0) >= QUENCH_AT then
        local surface = surfaceAt(c, r) or y
        boilGrid(c, r, BOIL_ON_HIT)
        for _ = 1, STEAM_BURST do spawnSteam(x, surface, 0, -1, 1.0) end
        shared.hotSpots[#shared.hotSpots + 1] = { c = c, r = r, life = HOT_SECONDS, steamBudget = 0 }
        return true
      end
    end
  end
  return false
end

function WaterSystem.update(dt)
  shared.age = shared.age + dt
  local ts = state.timeScale or 1
  local player = state.player

  -- Planet water: forgotten with its culled planetoid, and evaporating
  -- from its outer surface at the same rate per length of surface a pool
  -- does (EVAPORATE_PER_SECOND per CELL of surface).
  forgetCulledOceans()
  for p, o in pairs(shared.oceans) do
    local surfaceLength = perimeterOf(p) + 2 * math.pi * depthOf(p, o.volume) -- (round its outer surface)
    if not o.natural then
      o.volume = o.volume - EVAPORATE_PER_SECOND * (surfaceLength / CELL) * dt * ts
    end
    if o.volume <= 0.05 then
      shared.oceans[p] = nil
      if o.marker then o.marker.radius = p.radius end
    end
  end

  -- All the water there is right now (see WATER_CAP).
  -- Dirt planets' water grids: one for each dirt planet he's anywhere
  -- near (made the first time he is), caught up with any dirt blown out.
  if player then
    for _, p in ipairs(state.planetoids or {}) do
      if p.isCrackedPlanet and p.rings and p.rings[1] and not shared.planetGrids[p] then
        local dx, dy = player.pos.x - p.pos.x, player.pos.y - p.pos.y
        local near = p.radius + PLANET_GRID_MAKE_DISTANCE
        if dx * dx + dy * dy < near * near then shared.planetGrids[p] = newPlanetGrid(p) end
      end
    end
  end
  for _, g in pairs(shared.planetGrids) do
    -- (Its gravity switched — see convertPlanetGrid. The fireballs' hot
    -- spots there are forgotten: their cells have moved.)
    local mode = g.planet.gravityMode or "core"
    if g.mode ~= mode then
      convertPlanetGrid(g, mode)
      for k = #shared.hotSpots, 1, -1 do
        if shared.hotSpots[k].pg == g then table.remove(shared.hotSpots, k) end
      end
    end
    catchUpPlanetGrid(g)
    sweepTurningPlanetGrid(g)
  end

  totalWater = 0
  if shared.grid then for _, w in pairs(shared.grid.water) do totalWater = totalWater + w end end
  for _, g in pairs(shared.planetGrids) do for _, w in pairs(g.water) do totalWater = totalWater + w end end
  -- (Less the water planets' own water — see addNaturalOcean.)
  for _, o in pairs(shared.oceans) do totalWater = totalWater + o.volume - (o.natural or 0) end
  for _, d in ipairs(shared.droplets) do
    if not d.lava then totalWater = totalWater + (d.volume or DROPLET_VOLUME) end -- (lava's not water)
  end

  local sprayHeld = state.waterMode and (love.mouse.isDown(1) or state.gamepadSprayHeld)
  isSpraying = sprayHeld and canSpray(player) or false
  if isSpraying then
    spray(player, dt * ts)
  else
    sprayBudget = 0
  end

  local gone
  for i = #shared.droplets, 1, -1 do
    local d = shared.droplets[i]
    if updateDroplet(d, ts, dt) then gone = gone or {}; gone[d] = true end
  end
  if gone then Scratch.removeMarked(shared.droplets, gone) end
  updateSteam(dt)

  -- Waterfalls splashing where they land (found while drawing last frame).
  if state.particles then
    local up = Vector2.new(0, -1)
    for _, l in ipairs(shared.waterfallLandings) do
      local expected = WATERFALL_SPLASH_PER_SECOND * l.flow * dt * ts
      local n = math.floor(expected) + (math.random() < expected % 1 and 1 or 0)
      for _ = 1, n do
        Splash.spawn(Vector2.new(l.x + (math.random() * 2 - 1) * l.half, l.y), up, 1, WATERFALL_SPLASH)
      end
    end
  end

  gone = nil
  for i = #shared.splashes, 1, -1 do
    local s = shared.splashes[i]
    s.life = s.life - dt
    if s.life <= 0 then
      gone = gone or {}
      gone[s] = true
    else
      s.vx, s.vy = s.vx + s.gx * ts, s.vy + s.gy * ts
      s.x, s.y = s.x + s.vx * ts, s.y + s.vy * ts
    end
  end
  if gone then Scratch.removeMarked(shared.splashes, gone) end

  if shared.grid or next(shared.planetGrids) then
    stepClock = stepClock + dt * ts
    local steps = 0
    while stepClock >= STEP_SECONDS and steps < MAX_STEPS_PER_FRAME do
      if shared.grid then stepWater(STEP_SECONDS) end
      for _, g in pairs(shared.planetGrids) do stepPlanetWater(g, STEP_SECONDS) end
      -- (The lava, more slowly — see LAVA_TUNING.STEP_EVERY.)
      lavaStepCount = lavaStepCount + 1
      if lavaStepCount >= LAVA_TUNING.STEP_EVERY then
        lavaStepCount = 0
        if shared.grid then stepWater(STEP_SECONDS, LAVA) end
        for _, g in pairs(shared.planetGrids) do stepPlanetWater(g, STEP_SECONDS, LAVA) end
      end
      stepClock = stepClock - STEP_SECONDS
      steps = steps + 1
    end
    if stepClock > STEP_SECONDS then stepClock = 0 end
  end
  -- Lava and water meeting (see "Lava meeting water: obsidian").
  if shared.grid then quenchLevelLava() end
  for _, g in pairs(shared.planetGrids) do quenchPlanetLava(g) end
  updateObsidians()
  Ice.update()
  updateLavaEmbers()
  if shared.grid or next(shared.planetGrids) then drainIntoPortals(dt * ts) end
  drainOceansIntoPortals(dt * ts)

  -- Water bodies following their water's surface (see addNaturalOcean).
  for p, o in pairs(shared.oceans) do
    if o.marker then o.marker.radius = p.radius + depthOf(p, o.volume) end
  end
end

-- Whether Bob's spraying right now (see Player:isUsingBlaster).
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
  return shared.oceans[p] and shared.oceans[p].volume or 0
end

-- For debugging/tests: planet p's water grid, if it has one (see "Water on
-- a dirt planet"), and its cell lookup and solid test.
function WaterSystem.debugPlanetGrid(p)
  return shared.planetGrids[p], planetCellOf, planetSolid, CELL
end

-- For debugging/tests: how much resting water each portal has taken in
-- (cells' worth, all-time): { red = ..., blue = ... }.
function WaterSystem.debugPortalFlow()
  return portalTakenIn
end

-- For debugging/tests: the grid and its solid test (read-only use).
function WaterSystem.debugGrid()
  return shared.grid, isSolid, CELL
end

-- For debugging/tests: the obsidian blocks (see "Lava meeting water").
function WaterSystem.debugObsidians()
  return shared.obsidians
end


return WaterSystem
