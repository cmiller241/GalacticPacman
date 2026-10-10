-- lua/setup/worldGen.lua
--
-- Cell streaming + annular sun belt (2–3 cell radii).
-- Deterministic FireBars spread across the belt's radial width; spawned/culled with the 3x3.

local state = require("lua.state")
local constants = require("lua.constants")
local Planetoid = require("lua.world.Planetoid")
local Asteroid = require("lua.entities.Asteroid")
local Coin = require("lua.entities.Coin")
local FireBar = require("lua.world.FireBar")
local utils = require("lua.utils")

local worldGen = {}

worldGen.CELL_SIZE = 3000
worldGen.GRID_SIZE = 20
worldGen.CENTER_CELL = { col = 10, row = 10 }
worldGen.CELL_CHECK_INTERVAL = 30

worldGen.BELT_INNER_CELLS = 2
worldGen.BELT_OUTER_CELLS = 3
worldGen.BELT_ORBIT_SPEED = 1.8 * 1.5   -- 2.7

-- Ongoing belt "drip" spawning: the one-time establish burst in
-- generateCell() (see BELT_PLANETOIDS_PER_CELL below) only fills a
-- cell once, the first time it activates. Planetoids in it orbit the
-- sun and drift out over time; if the player just sits in one 3x3
-- window, that cell never gets topped up again (generateCell won't
-- re-fire for a cell that's still active) and the belt visibly empties
-- out from under them. worldGen.updateBeltSpawning() (called on its
-- own cadence from main.lua) fixes this with a steady drip: spawn a
-- planetoid upstream (counter-clockwise) of the player, pushed back
-- along the belt ring until it's confirmed off-screen, so it drifts
-- into view over the following seconds instead of popping in.
worldGen.BELT_SPAWN_INTERVAL = 6        -- frames between drip checks (~0.1s @60fps)
worldGen.BELT_MAX_TOTAL_PLANETOIDS = 500
-- Whether the burst of planetoids a belt cell gets when it's first
-- generated (generateCell) counts against BELT_MAX_TOTAL_PLANETOIDS
-- too, not just the drip. true: a new region only adds as many as the
-- cap still has room for, so the belt genuinely tops out at the cap.
-- false: the old behavior — every new belt cell adds its full
-- BELT_PLANETOIDS_PER_CELL regardless, which let the belt climb to
-- 700-900 planetoids after a minute or so of moving around it.
worldGen.BELT_CELL_BURST_RESPECTS_CAP = true
local BELT_SPAWN_ARC_SPACING = 300      -- target arc-length (world units) between consecutive drip spawns
local BELT_DRIFT_RADIUS_MIN = 28
local BELT_DRIFT_RADIUS_MAX = 64
local BELT_HIDE_MARGIN = 350            -- extra buffer beyond the camera's exact edge before a pushed-back spawn counts as "hidden"
local BELT_HIDE_STEP = 150              -- arc-length (world units) each upstream push-back iteration moves
local BELT_HIDE_MAX_STEPS = 35          -- safety cap -- 35*150 = 5250 units of push. Must stay well under BELT_CULL_RADIUS_CELLS*CELL_SIZE below, or a freshly hidden spawn gets deleted the instant after being created
local BELT_EXTRA_STAGGER_FRAC = 0.4     -- extra randomized push (fraction of CELL_SIZE) on top of "just barely hidden", so arrivals stagger instead of all crossing into view in lockstep

-- How far (in cell-widths, straight-line distance from the player) a
-- belt planetoid is allowed to drift before it's culled. Belt
-- planetoids are culled by DISTANCE, not by grid-cell membership like
-- every other object (see cullDistantObjects) -- a cell-based cull
-- would delete a freshly hidden drip spawn on the very next pass,
-- since it was deliberately pushed to a cell outside the active 3x3.
-- Must stay comfortably larger than the maximum possible spawn
-- distance from the player: an establish-burst spawn can land up to
-- ~2.12 cells away (3x3 half-diagonal), and a drip spawn's hide
-- push-back adds up to ~2.15 more cells on top of that -- 4 cells
-- leaves ample margin on both.
worldGen.BELT_CULL_RADIUS_CELLS = 3

worldGen.FIREBAR_COUNT = 36      -- spread across the belt's radial width
worldGen.FIREBAR_EDGE_COUNT = 10 -- extra, hugging the inner/outer edges specifically

local PLANETOIDS_PER_CELL = 6
local BELT_PLANETOIDS_PER_CELL = 36
local ASTEROIDS_PER_CELL  = 2
local COINS_PER_PLANET_BASE = 4

-- Belt planetoids are dense (up to BELT_MAX_TOTAL_PLANETOIDS=500 of them
-- alive at once) and every coin is its own per-frame Coin:update() call
-- -- the old radius-scaled density formula (same as regular planets,
-- just halved) meant a large, steady coin population out there for no
-- real gameplay reason. A small random count instead -- some belt
-- planetoids bare, none with more than BELT_COIN_MAX -- cuts that
-- per-frame population substantially. Shared by both belt coin spawn
-- sites below (the cell-generation burst and the ongoing drip spawn)
-- so the range only needs tuning in one place.
local BELT_COIN_MAX = 2
local function randomBeltCoinCount()
  return math.random(0, BELT_COIN_MAX)
end

local PLANET_COLORS = {
  { 0.75, 0.78, 0.85, 1 },
  { 0.95, 0.45, 0.40, 1 },
  { 0.45, 0.85, 0.50, 1 },
  { 0.95, 0.85, 0.40, 1 },
  { 0.55, 0.55, 0.70, 1 },
  { 0.80, 0.55, 0.35, 1 },
}

-- The reference point cell streaming (generation, culling, and the
-- belt drip spawn) centers on. Ordinarily this IS wherever the player
-- is — state.camera is always player-centered during normal play (see
-- main.lua's own per-frame camera computation) — but while
-- RobotButler.lua's intro script is panning the camera off on a tour
-- (CameraDirector.lua) with the player himself standing still back in
-- the dome, state.camera follows the TOUR instead. Reading the current
-- camera center here rather than state.player.pos directly means the
-- world actually finishes generating/culling around wherever the
-- player is currently being SHOWN, not just wherever they physically
-- are — so a scripted pan over the belt or any other streamed area
-- doesn't reveal empty space that nothing has spawned into yet.
function worldGen.streamFocus()
  local cam = state.camera
  if not cam then
    if not state.player then return nil, nil end
    return state.player.pos.x, state.player.pos.y
  end
  local cx = cam.x + (state.visibleWidth or 0) / 2
  local cy = cam.y + (state.visibleHeight or 0) / 2
  return cx, cy
end

function worldGen.cellCoordFor(worldX, worldY)
  return {
    col = math.floor(worldX / worldGen.CELL_SIZE),
    row = math.floor(worldY / worldGen.CELL_SIZE),
  }
end

function worldGen.cellKey(col, row)
  return col .. "," .. row
end

function worldGen.sunPos()
  local w = state.sceneWidth or (worldGen.CELL_SIZE * worldGen.GRID_SIZE)
  local h = state.sceneHeight or (worldGen.CELL_SIZE * worldGen.GRID_SIZE)
  return w / 2, h / 2
end

function worldGen.sunCell()
  local sx, sy = worldGen.sunPos()
  local col = math.floor(sx / worldGen.CELL_SIZE)
  local row = math.floor(sy / worldGen.CELL_SIZE)
  col = math.max(0, math.min(worldGen.GRID_SIZE - 1, col))
  row = math.max(0, math.min(worldGen.GRID_SIZE - 1, row))
  return col, row
end

function worldGen.beltRadii()
  local inner = worldGen.BELT_INNER_CELLS * worldGen.CELL_SIZE
  local outer = worldGen.BELT_OUTER_CELLS * worldGen.CELL_SIZE
  return inner, outer
end

function worldGen.isInBeltRing(x, y)
  local sx, sy = worldGen.sunPos()
  local dx, dy = x - sx, y - sy
  local d = math.sqrt(dx * dx + dy * dy)
  local inner, outer = worldGen.beltRadii()
  return d > inner and d < outer
end

function worldGen.cellIntersectsBelt(col, row)
  local sx, sy = worldGen.sunPos()
  local inner, outer = worldGen.beltRadii()
  local x0 = col * worldGen.CELL_SIZE
  local y0 = row * worldGen.CELL_SIZE
  local x1 = x0 + worldGen.CELL_SIZE
  local y1 = y0 + worldGen.CELL_SIZE
  local cx = math.max(x0, math.min(sx, x1))
  local cy = math.max(y0, math.min(sy, y1))
  local nearest = math.sqrt((sx - cx) ^ 2 + (sy - cy) ^ 2)
  local corners = {
    { x0, y0 }, { x1, y0 }, { x0, y1 }, { x1, y1 },
  }
  local farthest = 0
  for _, c in ipairs(corners) do
    local d = math.sqrt((c[1] - sx) ^ 2 + (c[2] - sy) ^ 2)
    if d > farthest then farthest = d end
  end
  return nearest < outer and farthest > inner
end

----------------------------------------------------------------------
-- Deterministic FireBar slots, spread across the belt's radial width
----------------------------------------------------------------------

local FIREBAR_RADIAL_JITTER = 0.75 -- fraction of the belt's half-width each "spread" slot can be pushed toward either edge
local FIREBAR_EDGE_MARGIN = 0.08   -- fraction of the belt's full width the edge-hugging slots sit inside the true inner/outer boundary
local FIREBAR_EDGE_JITTER = 0.3    -- small extra scatter for the edge-hugging slots, as a fraction of their own margin — avoids a perfectly uniform ring

local function fireBarSlots()
  if worldGen._fireBarSlots then return worldGen._fireBarSlots end
  local inner, outer = worldGen.beltRadii()
  local width = outer - inner
  local midR = (inner + outer) * 0.5
  local halfSpan = width * 0.5
  local sx, sy = worldGen.sunPos()
  local slots = {}
  local nextId = 0

  local function addSlot(ang, r)
    local x = sx + math.cos(ang) * r
    local y = sy + math.sin(ang) * r
    local cell = worldGen.cellCoordFor(x, y)
    table.insert(slots, {
      id = nextId,
      x = x,
      y = y,
      startAngle = ang + math.pi / 2,
      col = cell.col,
      row = cell.row,
      key = worldGen.cellKey(cell.col, cell.row),
    })
    nextId = nextId + 1
  end

  -- Spread radially across most of the belt's width instead of sitting
  -- exactly on the mid-belt ring every time — every fire bar used to
  -- sit at the exact midpoint radius, so a planetoid riding near the
  -- belt's inner or outer edge would almost never cross paths with
  -- one. Computed once and cached in worldGen._fireBarSlots, so this
  -- stays a fixed, stable layout for the whole session rather than
  -- reshuffling.
  for i = 0, worldGen.FIREBAR_COUNT - 1 do
    local ang = (i / worldGen.FIREBAR_COUNT) * math.pi * 2
    local radialJitter = (math.random() * 2 - 1) * FIREBAR_RADIAL_JITTER
    addSlot(ang, midR + radialJitter * halfSpan)
  end

  -- Extra edge-hugging bars, on top of the spread set above — half
  -- sitting just inside the inner boundary, half just inside the outer
  -- boundary, so riding right along either rim of the belt (where even
  -- the widest spread above rarely reaches) still crosses one.
  -- Staggered by half an angular step against the spread set so they
  -- don't cluster at the exact same angles.
  local innerCount = math.floor(worldGen.FIREBAR_EDGE_COUNT / 2)
  local outerCount = worldGen.FIREBAR_EDGE_COUNT - innerCount
  local edgeMargin = FIREBAR_EDGE_MARGIN * width
  local angleStagger = math.pi / worldGen.FIREBAR_COUNT

  for i = 0, innerCount - 1 do
    local ang = angleStagger + (i / innerCount) * math.pi * 2
    local jitter = (math.random() * 2 - 1) * FIREBAR_EDGE_JITTER * edgeMargin
    addSlot(ang, inner + edgeMargin + jitter)
  end
  for i = 0, outerCount - 1 do
    local ang = angleStagger + (i / outerCount) * math.pi * 2
    local jitter = (math.random() * 2 - 1) * FIREBAR_EDGE_JITTER * edgeMargin
    addSlot(ang, outer - edgeMargin + jitter)
  end

  worldGen._fireBarSlots = slots
  return slots
end

local function generateFireBarsForCell(col, row)
  state.fireBars = state.fireBars or {}
  state.activeFireBarIds = state.activeFireBarIds or {}
  local key = worldGen.cellKey(col, row)
  for _, slot in ipairs(fireBarSlots()) do
    if slot.key == key and not state.activeFireBarIds[slot.id] then
      local bar = FireBar.new(slot.x, slot.y, {
        barLength = 420,
        numFireballs = 10,
        startAngle = slot.startAngle,
        rotationSpeed = 0.05,
      })
      bar.fireBarId = slot.id
      bar.isPermanent = false
      table.insert(state.fireBars, bar)
      state.activeFireBarIds[slot.id] = true
    end
  end
end

local function randomColor()
  return PLANET_COLORS[math.random(1, #PLANET_COLORS)]
end

-- Snaps a randomly generated planetoid radius to a multiple of
-- RADIUS_STEP within [min, max] — there's no gameplay reason for two
-- planetoids to differ by a single pixel, and continuous radii meant
-- almost every planetoid needed its own unique baked body texture (see
-- Planetoid.lua's ensureBodyCanvas). Since color already only ever comes
-- from the fixed PLANET_COLORS swatch list, quantizing radius too means
-- the (color, radius) pairs actually seen across the whole field/belt
-- collapse to a small, fixed set — that shared body-canvas cache can
-- then reuse one bake across every planetoid with a matching pair
-- instead of baking one per instance.
local RADIUS_STEP = 5
local function randomQuantizedRadius(min, max, step)
  step = step or RADIUS_STEP
  local steps = math.floor((max - min) / step)
  return min + math.random(0, steps) * step
end

-- A belt planetoid is never GENERATED with less than this much clear
-- space (surface to surface) between it and any other planetoid — both
-- generation paths enforce it: the burst when a cell is first generated
-- (createPlanetoidsInCell) and the ongoing drip (spawnDriftingBeltPlanetoid).
-- A spot that can't satisfy it after BELT_PLACEMENT_ATTEMPTS tries is
-- simply skipped, rather than placed too close anyway.
local BELT_PLANETOID_MIN_GAP = 20
local BELT_PLACEMENT_ATTEMPTS = 30
local beltPlanetoidTooClose -- defined further down, next to the cell-generation code that first needed it

local function applyBeltOrbit(planet)
  planet.isBeltPlanetoid = true
  local sunX, sunY = worldGen.sunPos()
  local dx = planet.pos.x - sunX
  local dy = planet.pos.y - sunY
  local dist = math.sqrt(dx * dx + dy * dy)
  if dist < 1 then dist = 1 end
  planet.vel.x = (-dy / dist) * worldGen.BELT_ORBIT_SPEED
  planet.vel.y = ( dx / dist) * worldGen.BELT_ORBIT_SPEED
  planet.beltOrbitRadius = dist
end

----------------------------------------------------------------------
-- Ongoing belt drip -- see worldGen.BELT_SPAWN_INTERVAL comment above
----------------------------------------------------------------------

-- Starting at angle `theta` (radians, standard atan2 convention) and
-- fixed radius `r` from the sun, walks backwards along the belt ring
-- (opposite the orbit's direction of motion -- see applyBeltOrbit's
-- velocity formula, whose tangent is the direction of INCREASING
-- theta) until the resulting point is confirmed off-screen, then adds
-- a little extra randomized push so arrivals stagger over time.
-- Stepping in angle rather than a straight world-space line keeps the
-- point exactly on the ring throughout, which a fixed-direction linear
-- push-back can't do at these radii (thousands of units) without
-- drifting noticeably off the ring.
local function pushUpstreamUntilHidden(theta, r, radius)
  local sunX, sunY = worldGen.sunPos()
  local x = sunX + math.cos(theta) * r
  local y = sunY + math.sin(theta) * r
  local steps = 0
  while utils.isOnScreen(x, y, radius, BELT_HIDE_MARGIN) and steps < BELT_HIDE_MAX_STEPS do
    theta = theta - (BELT_HIDE_STEP / r)
    x = sunX + math.cos(theta) * r
    y = sunY + math.sin(theta) * r
    steps = steps + 1
  end

  local extra = math.random() * worldGen.CELL_SIZE * BELT_EXTRA_STAGGER_FRAC
  theta = theta - (extra / r)
  x = sunX + math.cos(theta) * r
  y = sunY + math.sin(theta) * r
  return x, y
end

-- Radius is sampled uniformly across the belt's FULL width, not
-- jittered around the player's own current distance from the sun.
-- An earlier version jittered around the player's (clamped) distance,
-- which looked fine once the player was actually inside the ring --
-- but the moment they approached from outside it (e.g. coming from
-- the sky dome, well inside the inner edge), that clamp pinned every
-- spawn's reference radius to the same boundary value, and jitter
-- alone couldn't spread them back out: any offset that undershot the
-- clamp just got clamped straight back to it. The result was a dense
-- streak of planetoids piled up right on the inner (or outer) edge,
-- tracking the player's angular position, with the belt's middle left
-- empty until the player was fully inside it. Sampling the full width
-- has no boundary to pile up against.
--
-- "Uniform across the full width" means uniform in r itself here, which
-- is subtly wrong for uniform-DENSITY coverage of an annulus: a thin
-- ring near the outer edge covers far more actual area (circumference
-- scales with r) than an equally-thin ring near the inner edge, so
-- sampling r with equal probability per unit radius packs more
-- planetoids per unit AREA near the inner edge than the outer one --
-- exactly the "everything congregates near the min radius" pileup.
-- Sampling r^2 uniformly instead (then sqrt) weights larger radii
-- proportionally to how much more area they actually cover, giving a
-- spatially even scatter across the whole belt's width.
local function spawnDriftingBeltPlanetoid(refTheta)
  local inner, outer = worldGen.beltRadii()
  local rInner, rOuter = inner + 10, outer - 10
  local radius = randomQuantizedRadius(BELT_DRIFT_RADIUS_MIN, BELT_DRIFT_RADIUS_MAX)

  -- Each try re-rolls both the ring radius and (inside
  -- pushUpstreamUntilHidden) how far upstream it lands, until one comes
  -- up with BELT_PLANETOID_MIN_GAP clear of every other planetoid. If
  -- none does, this spawn is skipped — the drip runs again in a moment.
  local x, y
  local placed = false
  for _ = 1, BELT_PLACEMENT_ATTEMPTS do
    local r = math.sqrt(rInner * rInner + math.random() * (rOuter * rOuter - rInner * rInner))
    x, y = pushUpstreamUntilHidden(refTheta, r, radius)
    if not beltPlanetoidTooClose(x, y, radius) then
      placed = true
      break
    end
  end
  if not placed then return nil end

  local p = Planetoid.new(x, y, radius, randomColor())
  applyBeltOrbit(p)
  table.insert(state.planetoids, p)

  local numCoins = randomBeltCoinCount()
  for i = 1, numCoins do
    local coin = Coin.new(p)
    coin.angle = (i / numCoins) * math.pi * 2 + math.random() * 0.2
    if coin.updatePosition then coin:updatePosition() end
    table.insert(state.coins, coin)
  end

  return p
end

local function countBeltPlanetoids()
  local count = 0
  for _, p in ipairs(state.planetoids) do
    if p.isBeltPlanetoid then count = count + 1 end
  end
  return count
end

-- Same 3x3 neighborhood updateActiveCells() streams, checked directly
-- from the live streaming focus (see worldGen.streamFocus) so the drip
-- can start the instant it's near belt territory rather than waiting
-- on activeCells.
local function focusNearBelt(fx, fy)
  local focusCell = worldGen.cellCoordFor(fx, fy)
  for dRow = -1, 1 do
    for dCol = -1, 1 do
      if worldGen.cellIntersectsBelt(focusCell.col + dCol, focusCell.row + dRow) then
        return true
      end
    end
  end
  return false
end

local lastFocusBeltTheta = nil

-- Called on its own cadence (worldGen.BELT_SPAWN_INTERVAL, from
-- main.lua) rather than piggybacking on updateActiveCells -- the drip
-- needs to run much more often than the cell-generation pass to read
-- as a steady trickle instead of periodic bursts.
function worldGen.updateBeltSpawning()
  local fx, fy = worldGen.streamFocus()
  if not fx or not focusNearBelt(fx, fy) then
    lastFocusBeltTheta = nil
    return
  end

  local sunX, sunY = worldGen.sunPos()
  local dx = fx - sunX
  local dy = fy - sunY
  local dist = math.sqrt(dx * dx + dy * dy)
  if dist < 1 then dist = 1 end
  local theta = math.atan2(dy, dx)

  local inner, outer = worldGen.beltRadii()
  -- Only used below to pace HOW MANY planetoids to spawn (arc length =
  -- angle * radius) -- clamping here is fine for that estimate even
  -- when the player is outside the ring. Deliberately NOT passed to
  -- spawnDriftingBeltPlanetoid as a target radius; see that function's
  -- comment for why.
  local pacingR = math.max(inner + 10, math.min(outer - 10, dist))

  -- Pace the spawn count by how far the streaming focus has actually
  -- traveled around the ring since the last check (arc length = angle
  -- * radius) rather than by elapsed time alone -- sweeping through
  -- the belt fast (on foot, or via a scripted camera pan) would
  -- otherwise outrun a purely time-based trickle and see it thin out,
  -- same reasoning as the distance-paced drip in the diagonal-corridor
  -- belt (js/world/CellManifest.js).
  local spawnsNeeded = 1
  if lastFocusBeltTheta ~= nil then
    local d = theta - lastFocusBeltTheta
    while d > math.pi do d = d - 2 * math.pi end
    while d < -math.pi do d = d + 2 * math.pi end
    local arcMoved = math.abs(d) * pacingR
    spawnsNeeded = math.max(1, math.ceil(arcMoved / BELT_SPAWN_ARC_SPACING))
  end
  lastFocusBeltTheta = theta

  local total = countBeltPlanetoids()
  for _ = 1, spawnsNeeded do
    if total >= worldGen.BELT_MAX_TOTAL_PLANETOIDS then break end
    if not spawnDriftingBeltPlanetoid(theta) then break end -- no clear spot right now; try again next check
    total = total + 1
  end
end

local SKYDOME_SPAWN_MARGIN = 200 -- extra clearance kept beyond the dome's own silhouette

-- A generous bounding-circle exclusion zone around the sky dome's
-- WHOLE structure (dome + narrower base) — deliberately not
-- shape-precise the way actual collision response needs to be (see
-- CollisionSystem.lua's handleImmovableCollisions /
-- handlePlanetAsteroidCollisions for that); a little extra empty space
-- kept clear around the dome is harmless, whereas under-covering it is
-- the actual bug (things spawning inside/near it). Shared by
-- isNearSkyDome (steers individual spawn POINTS away from the dome)
-- and worldGen.cellIntersectsSkyDome below (skips generateCell
-- entirely for any CELL the dome overlaps) — returns nil if there's no
-- dome yet.
local function skyDomeExclusionCircle()
  local dome = state.skyDomePlanet
  if not dome then return nil end
  local cy = dome.domeAnchorY and dome:domeAnchorY() or dome.pos.y
  local exclR = math.max(dome.domeRadiusX or 0, dome.domeRadiusY or 0, dome.halfWidth or 0)
    + (dome.baseRadiusY or 0) + SKYDOME_SPAWN_MARGIN
  return dome.pos.x, cy, exclR
end

local function isNearSkyDome(x, y)
  local cx, cy, exclR = skyDomeExclusionCircle()
  if not cx then return false end
  local dx, dy = x - cx, y - cy
  return dx * dx + dy * dy < exclR * exclR
end

-- True if the given cell's own bounds come within the dome's
-- exclusion circle at all — used to skip normal generateCell content
-- for that cell ENTIRELY (not just steer individual spawn points away
-- from it), since the dome's exterior footprint straddles more than
-- one cell (it's centered near a cell boundary, not centered inside a
-- single cell) and the player's own starting position sits inside the
-- dome's interior, right where the 3x3 streaming window first
-- activates — without this, cells that are mostly-but-not-entirely
-- covered by the point-level exclusion above would still spawn
-- ordinary planetoids/asteroids/fire bars in whatever fraction of
-- their area falls outside that radius, visibly cluttering the area
-- right around the dome the player starts next to.
function worldGen.cellIntersectsSkyDome(col, row)
  local cx, cy, exclR = skyDomeExclusionCircle()
  if not cx then return false end
  local x0 = col * worldGen.CELL_SIZE
  local y0 = row * worldGen.CELL_SIZE
  local x1 = x0 + worldGen.CELL_SIZE
  local y1 = y0 + worldGen.CELL_SIZE
  local nearestX = math.max(x0, math.min(cx, x1))
  local nearestY = math.max(y0, math.min(cy, y1))
  local dx, dy = cx - nearestX, cy - nearestY
  return dx * dx + dy * dy < exclR * exclR
end

-- Same "skip generateCell entirely for any REGULAR cell this landmark's
-- own footprint touches" pattern as the sky dome exclusion above
-- (worldGen.cellIntersectsSkyDome), generalized to however many
-- WaterPlanets exist rather than a single named landmark. WaterPlanets
-- are created directly in main.lua as permanent Planetoids OUTSIDE the
-- normal per-cell spawn system, so WorldGen has no built-in knowledge
-- of where they are otherwise — this just scans state.planetoids for
-- the isWaterPlanet flag every time a cell activates (cheap: only runs
-- once per cell, on activation, against a short list of permanent
-- landmarks, not every frame). Unlike the dome exclusion, this isn't
-- about visual clutter (a regular planetoid spawned under the water
-- wouldn't even be visible) — it's plain FPS: every extra planetoid is
-- another gravity source, another per-frame shading/collision check,
-- and another baked-canvas draw call for something the player could
-- never actually reach under a water body's own wavy silhouette anyway.
local WATER_SPAWN_MARGIN = 150 -- extra clearance kept beyond the water body's own true radius

function worldGen.cellIntersectsWaterPlanet(col, row)
  if not state.planetoids then return false end
  local x0 = col * worldGen.CELL_SIZE
  local y0 = row * worldGen.CELL_SIZE
  local x1 = x0 + worldGen.CELL_SIZE
  local y1 = y0 + worldGen.CELL_SIZE
  for _, p in ipairs(state.planetoids) do
    if p.isWaterPlanet then
      local exclR = p.radius + WATER_SPAWN_MARGIN
      local nearestX = math.max(x0, math.min(p.pos.x, x1))
      local nearestY = math.max(y0, math.min(p.pos.y, y1))
      local dx, dy = p.pos.x - nearestX, p.pos.y - nearestY
      if dx * dx + dy * dy < exclR * exclR then
        return true
      end
    end
  end
  return false
end

local function randomPointInCell(col, row, radius)
  local originX = col * worldGen.CELL_SIZE
  local originY = row * worldGen.CELL_SIZE
  local x, y
  for _ = 1, 20 do
    x = originX + radius + math.random() * (worldGen.CELL_SIZE - 2 * radius)
    y = originY + radius + math.random() * (worldGen.CELL_SIZE - 2 * radius)
    if not isNearSkyDome(x, y) then
      return x, y
    end
  end
  -- Every attempt landed inside the dome's exclusion zone — only
  -- realistically possible for a cell almost entirely covered by it.
  -- Falls back to the last attempt rather than looping forever, same
  -- tradeoff as beltPlanetoidTooClose's own retry loop below.
  return x, y
end

-- Plain rejection sampling: pick (x,y) uniformly in the cell's own
-- rectangle, keep it only if it's genuinely inside the belt annulus too
-- -- every accepted point is trivially inside the cell, by construction.
--
-- An earlier version of this function tried to be clever when a cell
-- only clips a thin sliver of the ring (its farthest corner barely past
-- the inner radius, say): it sampled a valid RADIUS directly from the
-- band the cell can reach, but kept the ANGLE from an independently
-- random point in the rectangle. That decoupling was wrong -- measured
-- with a Monte Carlo check against the actual thin-sliver cell next to
-- the dome, ~70% of the resulting points landed OUTSIDE that cell's own
-- rectangle entirely (a point sampled near the cell's NEAR corner, then
-- pushed out to a radius only valid near the FAR corner, walks into
-- neighboring territory). That's a worse bug than the one it replaced:
-- planetoids weren't stacking anymore, but most of them weren't
-- landing anywhere near where they were supposed to either.
--
-- The actual fix for the original stacking bug is just a much higher
-- retry budget: measured against that same real sliver cell, a random
-- rectangle point has roughly an 8.7% chance of landing in the belt
-- annulus, so 40 tries (the old count) had a ~2.7% chance of exhausting
-- -- rare, but landing on the SAME fixed fallback point every time it
-- did happen is what let multiple planetoids in one 36-planetoid batch
-- pile on each other. 200 tries drops that exhaustion chance to roughly
-- 1 in 10^8, and generation only runs once per cell activation, so the
-- extra tries cost nothing that matters.
local function randomPointInCellBelt(col, row, radius)
  local x0, y0 = col * worldGen.CELL_SIZE, row * worldGen.CELL_SIZE
  for _ = 1, 200 do
    local x = x0 + radius + math.random() * (worldGen.CELL_SIZE - 2 * radius)
    local y = y0 + radius + math.random() * (worldGen.CELL_SIZE - 2 * radius)
    if worldGen.isInBeltRing(x, y) and not isNearSkyDome(x, y) then
      return x, y
    end
  end

  -- Only reached if 200 tries in a row missed the annulus or landed
  -- near the sky dome -- shouldn't happen for any cell generateCell has
  -- already confirmed intersects the belt (see cellIntersectsBelt), but
  -- re-rolls a fresh point and just clamps ITS radius onto the nearest
  -- belt boundary rather than using one fixed coordinate every time --
  -- keeps this from ever becoming a new shared stacking point the way
  -- the old fallback was.
  local sx, sy = worldGen.sunPos()
  local inner, outer = worldGen.beltRadii()
  local x = x0 + radius + math.random() * (worldGen.CELL_SIZE - 2 * radius)
  local y = y0 + radius + math.random() * (worldGen.CELL_SIZE - 2 * radius)
  local dx, dy = x - sx, y - sy
  local d = math.sqrt(dx * dx + dy * dy)
  if d < 1 then d = 1; dx, dy = 1, 0 end
  local clampedD = math.max(inner + radius, math.min(outer - radius, d))
  return sx + (dx / d) * clampedD, sy + (dy / d) * clampedD
end

-- Checked against every ROUND planetoid, not just other belt ones — the
-- belt-edge landing planet (see main.lua's own beam setup) and any
-- regular planetoid that happens to sit near the ring count too.
-- Rounded-rect ones (the sky dome and friends) are left out: their own
-- `radius` is a loose bounding circle, and randomPointInCellBelt already
-- steers clear of the dome by its real footprint. Cheap enough to call
-- per placement attempt: a few hundred distance checks, only on a spawn.
function beltPlanetoidTooClose(x, y, radius)
  for _, p in ipairs(state.planetoids) do
    if p.radius and not p.isRoundedRect then
      local dx, dy = p.pos.x - x, p.pos.y - y
      local minDist = p.radius + radius + BELT_PLANETOID_MIN_GAP
      if dx * dx + dy * dy < minDist * minDist then
        return true
      end
    end
  end
  return false
end

local function createPlanetoidsInCell(col, row, count, belt)
  local created = {}
  for i = 1, count do
    local radius = belt and randomQuantizedRadius(28, 64) or randomQuantizedRadius(30, 70)
    local x, y
    local placed = true
    if belt then
      -- Retries until it finds a spot BELT_PLANETOID_MIN_GAP clear of
      -- every other planetoid (including ones from earlier in this same
      -- batch — they're inserted into state.planetoids immediately
      -- below, so beltPlanetoidTooClose sees them too). If none turns
      -- up, this one planetoid is left out — a packed cell ends up a
      -- planetoid or two short rather than with two crammed together.
      placed = false
      for _ = 1, BELT_PLACEMENT_ATTEMPTS do
        x, y = randomPointInCellBelt(col, row, radius)
        if not beltPlanetoidTooClose(x, y, radius) then
          placed = true
          break
        end
      end
    else
      x, y = randomPointInCell(col, row, radius)
    end
    if placed then
      local p = Planetoid.new(x, y, radius, randomColor())
      if belt then
        applyBeltOrbit(p)
      end
      table.insert(state.planetoids, p)
      table.insert(created, p)
    end
  end
  return created
end

local function createAsteroidsInCell(col, row, count)
  for i = 1, count do
    local radius = 16 + math.random() * 30
    local x, y = randomPointInCell(col, row, radius) -- also steers clear of the sky dome, see isNearSkyDome
    table.insert(state.asteroids, Asteroid.new(x, y, radius))
  end
end

local function createCoinsForPlanetoids(planetoids)
  for _, planet in ipairs(planetoids) do
    local numCoins
    if planet.isBeltPlanetoid then
      numCoins = randomBeltCoinCount()
    else
      numCoins = COINS_PER_PLANET_BASE + math.floor(planet.radius / 10)
    end
    for i = 1, numCoins do
      local coin = Coin.new(planet)
      coin.angle = (i / numCoins) * math.pi * 2 + math.random() * 0.2
      if coin.updatePosition then
        coin:updatePosition()
      end
      table.insert(state.coins, coin)
    end
  end
end

local function generateCell(col, row)
  local key = worldGen.cellKey(col, row)
  if state.activeCells[key] then return end
  state.activeCells[key] = true

  local belt = worldGen.cellIntersectsBelt(col, row)

  -- The dome's exterior footprint straddles more than one cell (see
  -- worldGen.cellIntersectsSkyDome) — a REGULAR cell touched at all by
  -- it is left completely empty rather than generating its usual
  -- planetoids/asteroids/fire bars, so nothing clutters the area right
  -- around where the player starts. Belt cells are exempt from this:
  -- belt planetoids orbit out in open space rather than sitting on the
  -- ground near the dome's own silhouette, so there's no clutter to
  -- avoid — and skipping them left the belt permanently empty in a
  -- one-cell-wide band immediately next to the dome, only ever filled
  -- in by slow drift/drip from neighboring, non-excluded cells instead
  -- of its own burst. randomPointInCellBelt still steers individual
  -- points clear of the dome's own footprint (see its isNearSkyDome
  -- check), so this doesn't risk planetoids landing ON the dome art.
  --
  -- Same exemption/reasoning extends to worldGen.cellIntersectsWaterPlanet
  -- (see its own comment) — any regular cell a WaterPlanet's own
  -- footprint touches is likewise left empty, purely to keep the extra
  -- gravity/collision/draw overhead of planetoids the player could
  -- never actually reach off the frame budget.
  if not belt and (worldGen.cellIntersectsSkyDome(col, row) or worldGen.cellIntersectsWaterPlanet(col, row)) then return end

  local planetCount = belt and BELT_PLANETOIDS_PER_CELL or PLANETOIDS_PER_CELL
  if belt and worldGen.BELT_CELL_BURST_RESPECTS_CAP then
    -- See BELT_CELL_BURST_RESPECTS_CAP's own comment.
    local room = worldGen.BELT_MAX_TOTAL_PLANETOIDS - countBeltPlanetoids()
    planetCount = math.max(0, math.min(planetCount, room))
  end
  local regulars = createPlanetoidsInCell(col, row, planetCount, belt)

  if not belt then
    createAsteroidsInCell(col, row, ASTEROIDS_PER_CELL)
  end

  createCoinsForPlanetoids(regulars)
  generateFireBarsForCell(col, row)
end

local function cullDistantObjects(activeCellKeys, focusX, focusY)
  local beltCullRadius = worldGen.BELT_CULL_RADIUS_CELLS * worldGen.CELL_SIZE

  for i = #state.planetoids, 1, -1 do
    local p = state.planetoids[i]
    if not p.isPermanent then
      if p.isBeltPlanetoid then
        -- Distance-based, not cell-based -- see BELT_CULL_RADIUS_CELLS
        -- comment above for why cell membership doesn't work here.
        if focusX then
          local dx, dy = p.pos.x - focusX, p.pos.y - focusY
          if dx * dx + dy * dy > beltCullRadius * beltCullRadius then
            table.remove(state.planetoids, i)
          end
        end
      else
        local cell = worldGen.cellCoordFor(p.pos.x, p.pos.y)
        local key = worldGen.cellKey(cell.col, cell.row)
        if not activeCellKeys[key] then
          table.remove(state.planetoids, i)
        end
      end
    end
  end

  local survivingPlanetoids = {}
  for _, p in ipairs(state.planetoids) do
    survivingPlanetoids[p] = true
  end

  if state.asteroids then
    for i = #state.asteroids, 1, -1 do
      local a = state.asteroids[i]
      local cell = worldGen.cellCoordFor(a.pos.x, a.pos.y)
      local key = worldGen.cellKey(cell.col, cell.row)
      if not activeCellKeys[key] then
        table.remove(state.asteroids, i)
      end
    end
  end

  if state.coins then
    for i = #state.coins, 1, -1 do
      local c = state.coins[i]
      if not c.planet or not survivingPlanetoids[c.planet] then
        table.remove(state.coins, i)
      elseif not c.planet.isBeltPlanetoid then
        -- Belt-planetoid coins are covered by survivingPlanetoids
        -- above -- their planet already went through the distance
        -- based cull, not this cell-based one.
        local cell = worldGen.cellCoordFor(c.planet.pos.x, c.planet.pos.y)
        local key = worldGen.cellKey(cell.col, cell.row)
        if not activeCellKeys[key] then
          table.remove(state.coins, i)
        end
      end
    end
  end

  if state.fireBars then
    state.activeFireBarIds = state.activeFireBarIds or {}
    for i = #state.fireBars, 1, -1 do
      local bar = state.fireBars[i]
      local cell = worldGen.cellCoordFor(bar.pos.x, bar.pos.y)
      local key = worldGen.cellKey(cell.col, cell.row)
      if not activeCellKeys[key] then
        if bar.fireBarId then
          state.activeFireBarIds[bar.fireBarId] = nil
        end
        table.remove(state.fireBars, i)
      end
    end
  end
end

function worldGen.updateActiveCells()
  local fx, fy = worldGen.streamFocus()
  if not fx then return end

  local focusCell = worldGen.cellCoordFor(fx, fy)
  local activeCellKeys = {}

  for dRow = -1, 1 do
    for dCol = -1, 1 do
      local col = focusCell.col + dCol
      local row = focusCell.row + dRow
      if col >= 0 and col < worldGen.GRID_SIZE and row >= 0 and row < worldGen.GRID_SIZE then
        local key = worldGen.cellKey(col, row)
        activeCellKeys[key] = true
        generateCell(col, row)
      end
    end
  end

  for key in pairs(state.activeCells) do
    if not activeCellKeys[key] then
      state.activeCells[key] = nil
    end
  end

  cullDistantObjects(activeCellKeys, fx, fy)
end

function worldGen.initWorldSize()
  state.sceneWidth  = worldGen.CELL_SIZE * worldGen.GRID_SIZE
  state.sceneHeight = worldGen.CELL_SIZE * worldGen.GRID_SIZE
  state.gridSize    = worldGen.GRID_SIZE
  state.activeCells = {}
  state.planetoids  = state.planetoids or {}
  state.asteroids   = state.asteroids or {}
  state.coins       = state.coins or {}
  state.fireBars    = state.fireBars or {}
  state.activeFireBarIds = {}
  worldGen._fireBarSlots = nil
end

function worldGen.generateStartingNeighborhood(centerCol, centerRow)
  centerCol = centerCol or worldGen.CENTER_CELL.col
  centerRow = centerRow or worldGen.CENTER_CELL.row

  for dRow = -1, 1 do
    for dCol = -1, 1 do
      local col = centerCol + dCol
      local row = centerRow + dRow
      if col >= 0 and col < worldGen.GRID_SIZE and row >= 0 and row < worldGen.GRID_SIZE then
        generateCell(col, row)
      end
    end
  end
end

return worldGen