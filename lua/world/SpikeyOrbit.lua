-- lua/world/SpikeyOrbit.lua
--
-- Exactly like Spikey (lua/world/Spikey.lua) — same gray/dark core,
-- off-white spinning spikes, same lethal/solid/wall-jumpable contact
-- behavior (added to the same state.spikeys list, so
-- CollisionSystem:handlePlayerSpikeyCollisions treats it identically —
-- no changes needed there at all) — except it orbits clockwise around
-- another entity (its own "orbit" Tiled property, resolved to an actual
-- spawned object by main.lua's own spawn wiring) instead of sitting
-- still or patrolling a straight shaft the way SpikeyVertical does.
--
-- The orbit radius and starting angle are both derived ONCE, at spawn
-- time, from wherever the level designer actually placed the object in
-- Tiled relative to the thing it orbits — there's no separate "radius"
-- property to keep in sync by hand; moving the point in Tiled and
-- reloading the level just works.

local Vector2 = require("lua.vector2")
local state = require("lua.state")
local Spikey = require("lua.world.Spikey")

local SpikeyOrbit = {}
SpikeyOrbit.__index = SpikeyOrbit

-- Default when the Tiled object carries no "speed" custom property of
-- its own — same meaning as SpikeyVertical.DEFAULT_SPEED (world units of
-- actual travel per baseline tick), just converted to an angular rate
-- internally (see SpikeyOrbit.new) instead of applied straight to a
-- single axis, so the two hazards' own "speed" properties stay
-- consistent with each other despite moving in different shapes.
SpikeyOrbit.DEFAULT_SPEED = 1.2

-- x, y: this object's own spawn position (used only to derive the orbit
-- radius/starting angle below — not stored or referred back to again).
-- center: the actual entity being orbited (anything exposing a live
-- .pos, e.g. a Sphere — see main.lua's own spawn wiring, which resolves
-- the Tiled "orbit" property's id reference to this). radius: same
-- meaning as Spikey's own (this body's OWN collision size, unrelated to
-- the orbit's radius). speed (optional): tangential world units per
-- baseline tick, same unit SpikeyVertical's own speed property uses;
-- defaults to DEFAULT_SPEED when the object has none.
function SpikeyOrbit.new(x, y, center, radius, speed)
  local self = setmetatable({}, SpikeyOrbit)
  self.center = center
  self.radius = radius or Spikey.DEFAULT_RADIUS

  local dx, dy = x - center.pos.x, y - center.pos.y
  self.orbitRadius = math.sqrt(dx * dx + dy * dy)
  -- This engine's own atan2/love.graphics.rotate convention (see
  -- Lever.lua's own comment on the exact same thing): 0 = +x/right,
  -- increasing clockwise, since y grows downward on screen.
  self.orbitAngle = math.atan2(dy, dx)

  local tangentialSpeed = speed or SpikeyOrbit.DEFAULT_SPEED
  -- Degenerate only if someone places the object exactly on top of what
  -- it's meant to orbit — holds still rather than dividing by zero.
  self.angularSpeed = (self.orbitRadius > 0) and (tangentialSpeed / self.orbitRadius) or 0

  self.pos = Vector2.new(x, y)
  return self
end

-- Duck-typed: main.lua's own per-frame loop only calls :update() on
-- state.spikeys entries that actually have one (see SpikeyVertical's own
-- matching comment).
function SpikeyOrbit:update()
  local timeScale = state.timeScale or 1
  self.orbitAngle = self.orbitAngle + self.angularSpeed * timeScale
  self.pos.x = self.center.pos.x + self.orbitRadius * math.cos(self.orbitAngle)
  self.pos.y = self.center.pos.y + self.orbitRadius * math.sin(self.orbitAngle)
end

-- Identical visuals to a plain Spikey — borrowed directly rather than
-- duplicated, same reasoning as SpikeyVertical's own matching comment.
SpikeyOrbit.draw = Spikey.draw

return SpikeyOrbit
