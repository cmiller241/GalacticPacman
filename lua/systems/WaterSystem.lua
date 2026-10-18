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

local SPRAY_PER_SECOND = 80
local SPRAY_SPEED, SPRAY_SPEED_RANGE = 10, 3 -- world units/frame out of the muzzle
local SPRAY_SPREAD = 0.08         -- radians either side of the aim
local DROPLET_VOLUME = 0.1        -- how much of a cell each droplet fills
local DROPLET_SECONDS = 3         -- one that hasn't landed by then just evaporates
local MAX_DROPLETS = 400
local HITS_POOL = 0.5             -- a droplet flying into a cell at least this full lands in that pool

-- Water and portals (see drainIntoPortals): water resting against a
-- portal's opening (any portal but a ceiling one — water doesn't flow up)
-- drains into it at up to this rate, and comes out of the other portal
-- as a jet of bigger droplets.
local PORTAL_FLOW_PER_SECOND = 12 -- cells' worth of water one portal can take in per second
local PORTAL_JET_VOLUME = 0.25    -- water in each droplet of the jet
local PORTAL_JET_SPEED, PORTAL_JET_SPEED_RANGE = 4, 2 -- world units/frame out of the exit portal
local PORTAL_JET_SPREAD = 0.15    -- radians either side

local SPLASH_BITS = 4
local SPLASH_SECONDS = 0.35

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
local SURFACE_SLICES = 4          -- strips each cell's surface is drawn in (for a smooth curve)
local SURFACE_GLOW = 16           -- how far the glow under the surface reaches
local COLOR_CAUSTIC = { 0.75, 0.92, 1.00 }
local CAUSTIC_SCALE = 34          -- world units across one caustic cell
local CAUSTIC_SPEED = 0.6
local CAUSTIC_STRENGTH = 0.3
local COLOR_DROPLET = { 0.70, 0.88, 1.00, 0.95 }

----------------------------------------------------------------------
-- State
----------------------------------------------------------------------

local grid = nil          -- see WaterSystem.init
local droplets = {}
local splashes = {}
local sprayBudget = 0
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
  droplets, splashes = {}, {}
  sprayBudget, stepClock = 0, 0
end

----------------------------------------------------------------------
-- The grid
----------------------------------------------------------------------

-- Lays the water grid over a Tiled level (see TiledTerrain.load). Water
-- follows the same collision Bob does — where he could walk, it can flow
-- (the level's dirt "fill" tiles are often just backdrop he walks in front
-- of, so they don't count). Solid cells, which water can't go into: wall
-- tiles, and a tile-thick layer behind every terrain surface he collides
-- with — floors (slopes as steps), the faces he runs up, and ceilings — on
-- its solid side, so water can't slip through a surface. Ledges stay one
-- tile thick with open space under them. The map's bottom edge sits on
-- the dome's floor, so below it is solid too; past its left and right
-- edges water just runs away.
function WaterSystem.init(level)
  local width = (level.pos.x - level.anchorX) * 2
  local height = (level.pos.y - level.anchorY) * 2
  local cols, rows = math.ceil(width / CELL), math.ceil(height / CELL)
  local g = { x0 = level.anchorX, y0 = level.anchorY, cols = cols, rows = rows, solid = {}, water = {} }
  local function mark(c, r)
    if c >= 0 and c < cols and r >= 0 and r < rows then g.solid[r * cols + c + 1] = true end
  end

  -- Wall tiles: every cell whose middle is inside one.
  for _, w in ipairs(level.walls or {}) do
    if w.isWall then
      local c0 = math.ceil((w.pos.x - w.halfWidth - g.x0) / CELL - 0.5)
      local c1 = math.floor((w.pos.x + w.halfWidth - g.x0) / CELL - 0.5)
      local r0 = math.ceil((w.pos.y - w.halfHeight - g.y0) / CELL - 0.5)
      local r1 = math.floor((w.pos.y + w.halfHeight - g.y0) / CELL - 0.5)
      for r = r0, r1 do for c = c0, c1 do mark(c, r) end end
    end
  end

  -- Terrain surfaces: walked along in half-cell steps, marking the cell
  -- each point is in and a tile's thickness of cells behind it (away
  -- from the open side its normal points to). Sampled at the MIDDLE of
  -- each step, never the segment's own ends: an end sitting exactly on a
  -- cell boundary (where a ledge's top meets a pit's wall, say) would
  -- otherwise mark the open cell on the far side of it.
  local THICKNESS_CELLS = 4
  for _, shape in ipairs(level.shapes or {}) do
    for _, s in ipairs(shape.segments or {}) do
      local len = math.sqrt((s.b.x - s.a.x) ^ 2 + (s.b.y - s.a.y) ^ 2)
      local steps = math.max(1, math.ceil(len / (CELL * 0.5)))
      for k = 0, steps - 1 do
        local t = (k + 0.5) / steps
        local x = s.a.x + (s.b.x - s.a.x) * t
        local y = s.a.y + (s.b.y - s.a.y) * t
        for d = 0, THICKNESS_CELLS - 1 do
          -- Nudged a hair behind the surface first, so a surface lying
          -- exactly on a cell boundary marks the cell behind it.
          local px, py = x - s.normal.x * (0.5 + d * CELL), y - s.normal.y * (0.5 + d * CELL)
          mark(math.floor((px - g.x0) / CELL), math.floor((py - g.y0) / CELL))
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

local function addWater(c, r, amount)
  if not inGrid(c, r) then return end
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
      if w > 1 and r > 0 and not isSolid(c, r - 1) then
        water[i - cols] = (water[i - cols] or 0) + (w - 1)
        w = 1
      end

      -- Falls into the cell below, as much as fits.
      if not isSolid(c, r + 1) then
        local below = water[i + cols] or 0
        local f = math.min(w, 1 - below)
        if f > 0 then
          water[i + cols] = below + f
          w = w - f
        end
      end

      -- Spreads sideways along whatever it's resting on (ground, or full
      -- water) — toward lower neighbors, evening out into a flat surface.
      local resting = isSolid(c, r + 1) or (water[i + cols] or 0) >= 0.99
      if resting and w > MIN_SPREAD then
        for k = 1, 2 do
          local dc = ((k == 1) == grid.flip) and -1 or 1
          local nc = c + dc
          if nc < 0 or nc >= cols then
            w = w - w * SPREAD -- off the map's edge: it runs away
          elseif not isSolid(nc, r) then
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
function WaterSystem.submergedAt(player)
  if not grid then return nil end
  local x, y = player.pos.x, player.pos.y
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
  sprayBudget = sprayBudget + SPRAY_PER_SECOND * dt
  local ox, oy = player:getMuzzlePosition()
  local aim = (player.aimWorldAngle or 0) + (player.blasterAngleOffset or 0)
  while sprayBudget >= 1 do
    sprayBudget = sprayBudget - 1
    if #droplets < MAX_DROPLETS then
      local a = aim + (math.random() * 2 - 1) * SPRAY_SPREAD
      local speed = SPRAY_SPEED + math.random() * SPRAY_SPEED_RANGE
      table.insert(droplets, {
        x = ox, y = oy,
        vx = math.cos(a) * speed + player.vel.x, vy = math.sin(a) * speed + player.vel.y,
        life = DROPLET_SECONDS,
        planet = player.onSurface and player.currentPlanet or player.lastInfluencePlanet,
      })
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
    for s = 1, steps do
      local x, y = px + (d.x - px) * s / steps, py + (d.y - py) * s / steps
      local c, r = cellOf(x, y)
      if inGrid(c, r) or r >= grid.rows then
        local speed = math.sqrt(d.vx * d.vx + d.vy * d.vy)
        if isSolid(c, r) then
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
    local c, r = cellOf(d.x, d.y)
    if inGrid(c, r) then return false end
  end

  -- Off the level: it splashes on whatever it was sprayed near and is gone.
  local p = d.planet
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
          table.insert(droplets, {
            x = x, y = y, vx = vx, vy = vy, life = DROPLET_SECONDS, volume = PORTAL_JET_VOLUME,
            planet = not (to.obj.isWall or to.obj.isGate) and to.obj or nil,
          })
        end
      end
      if #wet == 0 then portalDrained[color] = 0 end
    end
  end
end

----------------------------------------------------------------------
-- Update / draw
----------------------------------------------------------------------

-- dt: real seconds.
function WaterSystem.update(dt)
  age = age + dt
  local ts = state.timeScale or 1
  local player = state.player

  local sprayHeld = state.waterMode and (love.mouse.isDown(2) or state.gamepadSprayHeld)
  if sprayHeld and canSpray(player) then
    spray(player, dt * ts)
  else
    sprayBudget = 0
  end

  for i = #droplets, 1, -1 do
    if updateDroplet(droplets[i], ts, dt) then table.remove(droplets, i) end
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

      // The caustic net: gently warped so its threads wobble, strongest
      // near the surface and fading away with depth.
      vec2 p = worldPos / causticScale;
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
local function drawPools()
  local cam = state.camera
  if not cam then return end
  local vx0, vy0 = cam.x - CELL, cam.y - CELL
  local vx1, vy1 = cam.x + (state.visibleWidth or 0) + CELL, cam.y + (state.visibleHeight or 0) + CELL
  local cols, water = grid.cols, grid.water
  local verts = {}

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

  local function isFalling(i, c, r)
    return not isSolid(c, r + 1) and (water[i + cols] or 0) < 0.99
  end
  -- Where the surface of the pool a resting cell belongs to is: up its
  -- column through full cells to the topmost one's water line.
  local surfaceMemo = {}
  local function surfaceY(i, r)
    if surfaceMemo[i] then return surfaceMemo[i] end
    local w = water[i]
    local y
    if w >= 0.99 and r > 0 and water[i - cols] and not isFalling(i - cols, (i - 1 - cols) % cols, r - 1) then
      y = surfaceY(i - cols, r - 1)
    else
      y = grid.y0 + (r + 1) * CELL - math.max(2, math.min(1, w) * CELL)
    end
    surfaceMemo[i] = y
    return y
  end

  for i, w in pairs(water) do
    local r = math.floor((i - 1) / cols)
    local c = (i - 1) - r * cols
    local x0 = grid.x0 + c * CELL
    local yTopCell = grid.y0 + r * CELL
    if x0 < vx1 and x0 + CELL > vx0 and yTopCell < vy1 and yTopCell + CELL > vy0 then
      local x1 = x0 + CELL
      local bottom = yTopCell + CELL
      if isFalling(i, c, r) then
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
        while gap < STREAM_REACH_CELLS and jr < grid.rows and not water[j] and not isSolid(c, jr) do
          j, jr, gap = j + cols, jr + 1, gap + 1
          streamBottom = streamBottom + CELL
        end
        if water[j] and jr < grid.rows and not isFalling(j, c, jr) then
          streamBottom = math.max(streamBottom, surfaceY(j, jr)) -- into the pool's surface
        end
        quad(mid - half, yTopCell, mid + half, yTopCell, streamBottom, streamBottom, 0, 0, 1)
      else
        local surface = surfaceY(i, r)
        if surface < yTopCell - 0.5 then
          -- Deep in a pool (more water on top): a full block.
          quad(x0, yTopCell, x1, yTopCell, bottom, bottom, yTopCell - surface, bottom - surface, 0)
        else
          -- The pool's top: from the rippling surface down, in thin
          -- slices whose height eases toward the neighboring cells' water
          -- line (so the surface curves smoothly instead of stepping cell
          -- to cell).
          -- The neighbor's water line: in the cell beside this one, or —
          -- where the surface slopes across a row boundary — the one
          -- beside and below it. (Its surface may also sit a row up, if
          -- the cell beside is full.) Nothing there: stay level.
          local function neighborSurface(dc)
            local nc = c + dc
            if nc < 0 or nc >= cols then return surface end
            local j = i + dc
            local jr = r
            if not water[j] and r + 1 < grid.rows and water[j + cols] then j, jr = j + cols, r + 1 end
            if not water[j] or isFalling(j, nc, jr) then return surface end
            local s = surfaceY(j, jr)
            if math.abs(s - surface) > CELL * 1.5 then return surface end
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
            quad(xa, ta, xb, tb, bottom, bottom, 0, bottom - (ha + hb) / 2, 0)
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
  shader:send("causticSpeed", CAUSTIC_SPEED)
  shader:send("causticStrength", CAUSTIC_STRENGTH)
  love.graphics.setShader(shader)
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(mesh)
  love.graphics.setShader()
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

-- For debugging/tests: total water on the level, in cells' worth.
function WaterSystem.totalWater()
  local sum = 0
  if grid then for _, w in pairs(grid.water) do sum = sum + w end end
  return sum
end

-- For debugging/tests: the grid and its solid test (read-only use).
function WaterSystem.debugGrid()
  return grid, isSolid, CELL
end

return WaterSystem
