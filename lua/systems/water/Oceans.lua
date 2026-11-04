-- lua/systems/water/Oceans.lua
--
-- Water layers on round planetoids (and rounded rectangles).
-- Part of the water system: see lua/systems/WaterSystem.lua.

local state = require("lua.state")
local Tuning = require("lua.systems.water.Tuning")
local CELL = Tuning.CELL
local Shared = require("lua.systems.water.Shared")
local shared = Shared.shared

-- Functions it adds to WaterSystem (copied on in WaterSystem.lua).
local WaterSystem = {}

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
  local o = shared.oceans[p]
  if not o then
    o = { volume = 0, water = { isPool = true, pos = p.pos, radius = p.radius } }
    shared.oceans[p] = o
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
  local o = shared.oceans[core]
  o.natural = (o.natural or 0) + volume
  o.marker = marker
  if marker then marker.radius = outerRadius end
end

-- Drops oceans whose planetoid has been culled (no longer in the world).
local function forgetCulledOceans()
  if not next(shared.oceans) then return end
  local alive = {}
  for _, p in ipairs(state.planetoids or {}) do alive[p] = true end
  for p in pairs(shared.oceans) do
    if not alive[p] then shared.oceans[p] = nil end
  end
end

return {
  holdsWater = holdsWater,
  perimeterOf = perimeterOf,
  depthOf = depthOf,
  surfaceDistance = surfaceDistance,
  addToOcean = addToOcean,
  forgetCulledOceans = forgetCulledOceans,
  api = WaterSystem,
}
