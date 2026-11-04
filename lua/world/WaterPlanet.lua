-- lua/world/WaterPlanet.lua
--
-- A water planet is an ordinary planetoid with a layer of water round it,
-- the same as the water spraying builds on any planetoid. WaterSystem
-- simulates and draws the water (see lua/systems/water/).

local Vector2 = require("lua.vector2")
local Planetoid = require("lua.world.Planetoid")
local WaterSystem = require("lua.systems.WaterSystem")

local WaterPlanet = {}

local COLOR_SHALLOW = { 0.30, 0.66, 0.85 }

-- Hard core: a perfectly ordinary solid Planetoid nested at the water
-- body's own center, sized as a fraction of the water body's own radius.
-- Gives gravity a real, physical place to stop: radial gravity toward a
-- single point has no rest state there, so a falling player would
-- overshoot back and forth across the center every frame. A solid body
-- with ordinary onSurface landing settles him without needing a velocity
-- clamp.
local CORE_FRACTION = 1 / 8
local CORE_COLOR    = { 0.42, 0.30, 0.20 } -- brown

-- x, y: world position of the planet's center. radius: how far out its
-- water reaches.
--
-- A water planet is an ordinary planetoid (the core — solid, landed and
-- walked on like any other) with a layer of water round it out to
-- `radius` — the very same kind of water layer spraying water on any
-- round planetoid builds (see WaterSystem.addNaturalOcean): swum in,
-- drained through a portal, boiled by a fireball, leveled with another
-- planetoid's water, drawn by WaterSystem.
--
-- Also returned: an invisible marker for the water body (isWaterPlanet,
-- never solid, never drawn — see CollisionSystem:tryLandOnPlanet), which
-- is what the fish swim in and jump between (Fish.lua), Bob swims in
-- (Player.lua), and whose gravity holds both. WaterSystem keeps its
-- radius at the water's actual surface, so a
-- drained water planet shrinks for them too.
function WaterPlanet.new(x, y, radius)
  local planet = Planetoid.new(x, y, radius, COLOR_SHALLOW)

  -- A fixed landmark, not a drifting field planetoid — isImmovable
  -- makes updatePlanetoidsPhysics (main.lua) zero its velocity and skip
  -- moving it every frame, same convention SkyDomePlanetoid/Lava use
  -- for "this doesn't wander."
  planet.isImmovable = true
  planet.isPermanent = true
  planet.vel = Vector2.new(0, 0)

  -- Marker CollisionSystem/Player.lua/Fish.lua key off of: the water body
  -- is never solid (see CollisionSystem:tryLandOnPlanet's own
  -- isWaterPlanet check) — a player just sinks straight through it, with
  -- its radius purely "how far out counts as submerged," not a landing
  -- surface. Its influenceRadius (gravity's reach, from Planetoid.new)
  -- stays where it was set from the full radius, even as the water drains.
  planet.isWaterPlanet = true
  planet.draw = function() end -- (WaterSystem draws the water)

  -- The hard core (see CORE_FRACTION's own comment above) is a
  -- completely ordinary, unmodified Planetoid, so it lands/walks exactly
  -- like any other planet in the game via the existing generic collision
  -- code — and takes portals, and holds water, like any other.
  local core = Planetoid.new(x, y, radius * CORE_FRACTION, CORE_COLOR)
  core.isImmovable = true
  core.isPermanent = true
  core.vel = Vector2.new(0, 0)

  -- Lets code that only holds a reference to the water body (e.g. a Fish
  -- that lands in a water body other than the one it launched from, see
  -- Fish.lua's own updateJump; spraying while swimming, see
  -- WaterSystem's spray) find its matching core.
  planet.core = core

  WaterSystem.addNaturalOcean(core, radius, planet)

  return planet, core
end

return WaterPlanet
