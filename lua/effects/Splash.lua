-- lua/effects/Splash.lua
--
-- Shared watery particle-burst spawner for crossing a WaterPlanet's own
-- surface — used by Player.lua (entering/leaving submergedIn) and
-- Fish.lua (leaving the water on a jump, landing back in it). Same
-- "one shared module, several callers" precedent as DustPuff.lua, just
-- with a simpler single fan-shaped burst instead of that one's
-- clover-blob particles (droplets read fine as plain circles).

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local Particle = require("lua.entities.Particle")

local Splash = {}

local SPLASH_PARTICLE_COUNT = 30
local SPLASH_CONE_ANGLE     = math.pi * 0.9 -- full angular width droplets scatter across, centered on outwardDir
local SPLASH_SPEED_MIN      = 5
local SPLASH_SPEED_MAX      = 12
local SPLASH_LIFE_MIN       = 22
local SPLASH_LIFE_MAX       = 40
local SPLASH_RADIUS_MIN     = 3
local SPLASH_RADIUS_MAX     = 7
local SPLASH_DRAG           = 0.92 -- slightly less than before (0.90) so the now-faster droplets still carry out to their bigger radius before drag eats their speed
-- Each droplet's color is randomized between these two — matches
-- WaterPlanet.lua's own shallow-water color at one end and a near-white
-- foam highlight at the other, so the splash reads as the same water
-- rather than an unrelated effect color.
local SPLASH_COLOR_DEEP  = { 0.30, 0.66, 0.85 }
local SPLASH_COLOR_LIGHT = { 0.85, 0.97, 1.0 }

-- pos: world-space crossing point (where the surface was broken).
-- outwardDir: Vector2, unit length, pointing away from the water body's
-- own center — droplets fan out around this direction rather than in
-- every direction, since a real splash sprays away from the surface,
-- not back into the water.
-- count: optional, defaults to SPLASH_PARTICLE_COUNT.
function Splash.spawn(pos, outwardDir, count)
  count = count or SPLASH_PARTICLE_COUNT
  local baseAngle = math.atan2(outwardDir.y, outwardDir.x)

  for _ = 1, count do
    local angle = baseAngle + (math.random() - 0.5) * SPLASH_CONE_ANGLE
    local speed = SPLASH_SPEED_MIN + math.random() * (SPLASH_SPEED_MAX - SPLASH_SPEED_MIN)
    local vel = Vector2.new(math.cos(angle) * speed, math.sin(angle) * speed)
    local life = SPLASH_LIFE_MIN + math.random() * (SPLASH_LIFE_MAX - SPLASH_LIFE_MIN)

    local particle = Particle.new(pos, vel, life)
    local mixT = math.random()
    particle.color = {
      SPLASH_COLOR_DEEP[1] + (SPLASH_COLOR_LIGHT[1] - SPLASH_COLOR_DEEP[1]) * mixT,
      SPLASH_COLOR_DEEP[2] + (SPLASH_COLOR_LIGHT[2] - SPLASH_COLOR_DEEP[2]) * mixT,
      SPLASH_COLOR_DEEP[3] + (SPLASH_COLOR_LIGHT[3] - SPLASH_COLOR_DEEP[3]) * mixT,
    }
    particle.radius = SPLASH_RADIUS_MIN + math.random() * (SPLASH_RADIUS_MAX - SPLASH_RADIUS_MIN)
    particle.drag = SPLASH_DRAG
    table.insert(state.particles, particle)
  end
end

return Splash
