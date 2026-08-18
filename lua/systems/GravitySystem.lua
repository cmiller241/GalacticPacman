-- lua/systems/GravitySystem.lua
--
-- Direct translation of js/systems/GravitySystem.js — pure physics
-- math, no rendering at all, so unlike Planetoid.lua (its sibling in
-- this same batch) this one is a straightforward, faithful port with
-- no architectural rework needed. Relies directly on vector2.lua's
-- own mutate/non-mutate distinction, confirmed correct by that file's
-- test suite back when it was written: dominant.pos:subtract(...) and
-- surface.normal:clone() must NOT mutate their operands, while
-- entity.vel:add(...) MUST mutate entity.vel in place — this file
-- gets both right for the same reason vector2.lua's own tests exist.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local constants = require("lua.constants")

local GravitySystem = {}
GravitySystem.__index = GravitySystem

function GravitySystem.new(planetoids)
  local self = setmetatable({}, GravitySystem)
  self.planetoids = planetoids
  return self
end

-- For rect planets, "distance" is measured to the nearest SURFACE
-- point (not the center) — same reasoning as the original's own
-- comment: gravity range/direction near a wide, non-circular shape
-- would feel wrong measured from the center instead.
function GravitySystem:findDominantPlanet(pos)
  local closest = nil
  local minDist = math.huge

  for _, planet in ipairs(self.planetoids) do
    local dist, withinRange

    if planet.isRoundedRect then
      dist = planet:distanceToSurface(pos.x, pos.y)
      if planet.isSkyDome then
        -- isWithinGravityWindow is a COMPLETE proximity test on its
        -- own for this planet type — must NOT also be ANDed with the
        -- generic distanceToSurface < INFLUENCE_PADDING check below.
        -- Same reasoning, same bug this avoids, as the original's own
        -- comment describes.
        withinRange = planet:isWithinGravityWindow(pos.x, pos.y)
      else
        withinRange = dist < constants.INFLUENCE_PADDING
      end
    else
      dist = pos:subtract(planet.pos):length()
      withinRange = dist < planet.influenceRadius
    end

    if withinRange and dist < minDist then
      minDist = dist
      closest = planet
    end
  end

  return closest
end

function GravitySystem:applyTo(entity)
  if entity.onSurface then return end

  local dominant = self:findDominantPlanet(entity.pos)
  if dominant then
    entity.lastInfluencePlanet = dominant

    local dir
    if dominant.isRoundedRect then
      local surface = dominant:nearestSurfacePoint(entity.pos.x, entity.pos.y)
      if surface.distance > 1e-6 then
        dir = Vector2.new(surface.point.x - entity.pos.x, surface.point.y - entity.pos.y):normalize()
      else
        dir = surface.normal:clone():multiply(-1)
      end
    else
      dir = dominant.pos:subtract(entity.pos):normalize()
    end

    local grav = entity.GRAVITY_STRENGTH or constants.GRAVITY_STRENGTH
    if entity.isGroundPounding then
      grav = grav * (entity.GROUND_POUND_GRAV_MULTIPLIER or constants.GROUND_POUND_GRAV_MULTIPLIER)
    end
    entity.vel:add(dir:multiply(grav * state.timeScale))
  end
end

return GravitySystem