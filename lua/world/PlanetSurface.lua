-- lua/world/PlanetSurface.lua
--
-- The surface interface every body in state.planetoids provides, so
-- code dealing with "the planet he's on, or near" can ask it directly
-- instead of checking what kind of planet it is:
--
--   planet:upAt(x, y)               unit Vector2 — "up" for something at
--                                   (x, y): which way it stands, and
--                                   which way it jumps off
--   planet:gravityDirAt(x, y)       unit Vector2 — which way gravity pulls
--                                   a free body at (x, y)
--   planet:distanceToSurface(x, y)  how far (x, y) is from the surface
--   planet:gravityDistance(x, y)    the distance GravitySystem ranks
--                                   competing gravity sources by — or nil
--                                   when (x, y) is outside this body's
--                                   gravity altogether
--
-- Implemented by Planetoid (every round body: belt planetoids, spheres,
-- water planets, the mining planet, ...), RoundedRectPlanetoid,
-- SkyDomePlanetoid, CrackedPlanetoid and TiledTerrain's
-- TerrainShape. The functions below are the implementations several of
-- those classes share.

local Vector2 = require("lua.vector2")
local constants = require("lua.constants")

local PlanetSurface = {}

-- Flat-sided bodies (a rounded rectangle, the dome's deck, Tiled
-- terrain) pull toward the nearest point of their surface while you're
-- away from it — and, once you're on it, straight in along its normal
-- (for the dome's deck that's straight down: platform gravity).
function PlanetSurface.gravityTowardSurface(self, x, y)
  local surface = self:nearestSurfacePoint(x, y)
  if surface.distance > 1e-6 then
    return Vector2.new(surface.point.x - x, surface.point.y - y):normalize()
  end
  return surface.normal:clone():multiply(-1)
end

-- "Up" is the surface's own normal at the nearest point.
function PlanetSurface.upFromNormal(self, x, y)
  return self:nearestSurfacePoint(x, y).normal:clone()
end

-- "Up" is straight up the screen, whatever the surface's shape.
function PlanetSurface.upStraight()
  return Vector2.new(0, -1)
end

-- Gravity that reaches INFLUENCE_PADDING out from the surface.
function PlanetSurface.gravityDistanceFromSurface(self, x, y)
  local dist = self:distanceToSurface(x, y)
  if dist < (constants.INFLUENCE_PADDING or 200) then return dist end
  return nil
end

-- Gravity only inside the body's own gravity window (the sky dome's
-- bubble — see SkyDomePlanetoid:isWithinGravityWindow), however high in
-- it you are.
function PlanetSurface.gravityDistanceInWindow(self, x, y)
  local dist = self:distanceToSurface(x, y)
  if self:isWithinGravityWindow(x, y) then return dist end
  return nil
end

return PlanetSurface
