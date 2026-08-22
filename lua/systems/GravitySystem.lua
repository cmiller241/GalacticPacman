-- lua/systems/GravitySystem.lua
--
-- Direct translation of js/systems/GravitySystem.js — pure physics
-- math, no rendering. Dominant-planet selection + directional gravity.
--
-- SkyDome:
--   - Range is isWithinGravityWindow only (NOT also ANDed with
--     INFLUENCE_PADDING — that would silently cap gravity to ~200 units
--     regardless of dome size).
--   - Direction comes from nearestSurfacePoint → the grass deck, so
--     gravity reads as traditional platform "down," not radial-to-center.

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

-- For rect / sky-dome planets, "distance" is measured to the nearest
-- SURFACE point (not the center). For SkyDome that surface is the grass
-- deck. Circle planets still use center distance vs influenceRadius.
function GravitySystem:findDominantPlanet(pos)
  local closest = nil
  local minDist = math.huge

  for _, planet in ipairs(self.planetoids) do
    local dist, withinRange

    if planet.isRoundedRect then
      if planet.distanceToSurface then
        dist = planet:distanceToSurface(pos.x, pos.y)
      elseif planet.nearestSurfacePoint then
        dist = planet:nearestSurfacePoint(pos.x, pos.y).distance
      else
        dist = pos:subtract(planet.pos):length()
      end

      if planet.isSkyDome then
        -- Complete proximity test on its own — do NOT also require
        -- dist < INFLUENCE_PADDING (that would re-impose a ~200-unit
        -- cap and break high jumps inside a wide dome).
        withinRange = planet.isWithinGravityWindow
          and planet:isWithinGravityWindow(pos.x, pos.y)
          or false
      else
        withinRange = dist < (constants.INFLUENCE_PADDING or 200)
      end
    else
      dist = pos:subtract(planet.pos):length()
      withinRange = dist < (planet.influenceRadius or (planet.radius + (constants.INFLUENCE_PADDING or 200)))
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
  if not dominant then return end

  entity.lastInfluencePlanet = dominant

  local dir
  if dominant.isRoundedRect and dominant.nearestSurfacePoint then
    local surface = dominant:nearestSurfacePoint(entity.pos.x, entity.pos.y)
    -- Toward the deck point while airborne; once nearly on it, use
    -- "down" along the surface normal (SkyDome normal is (0,-1), so
    -- -normal is (0,1) — traditional platform gravity).
    if surface.distance > 1e-6 then
      dir = Vector2.new(
        surface.point.x - entity.pos.x,
        surface.point.y - entity.pos.y
      ):normalize()
    else
      dir = surface.normal:clone():multiply(-1)
    end
  else
    dir = dominant.pos:subtract(entity.pos):normalize()
  end

  local grav = entity.GRAVITY_STRENGTH or constants.GRAVITY_STRENGTH or 0.35
  if entity.isGroundPounding then
    grav = grav * (entity.GROUND_POUND_GRAV_MULTIPLIER
      or constants.GROUND_POUND_GRAV_MULTIPLIER
      or 3)
  end

  entity.vel:add(dir:multiply(grav * (state.timeScale or 1)))
end

return GravitySystem