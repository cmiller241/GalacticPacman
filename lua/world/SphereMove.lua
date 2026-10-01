-- lua/world/SphereMove.lua
--
-- Exactly Sphere (lua/world/Sphere.lua) — same body, same metallic
-- GPU-shaded look, same full Planetoid treatment (gravity, landing,
-- pull-beam targeting) — just not sitting still. Built directly on top
-- of Sphere.new rather than duplicating it, so every one of those stays
-- true for free; the only thing added here is an :update() that drives
-- self.pos along a fixed back-and-forth path instead of leaving it
-- alone (Sphere's own isImmovable/vel-zeroing already keeps
-- updatePlanetoidsPhysics from fighting that — see main.lua's own
-- comment on why isImmovable planetoids never move on their own).
--
-- Path: from wherever it's actually placed in Tiled (its own x/y) to its
-- "start" point ONCE, then forever back and forth between "start" and
-- "end" — see this file's own SphereMove.new for exactly which Tiled
-- custom properties (startX/startY/endX/endY/speed) that comes from.

local Vector2 = require("lua.vector2")
local state = require("lua.state")
local Sphere = require("lua.world.Sphere")

local SphereMove = {}

-- Same unit every other patrolling hazard's own "speed" property uses:
-- world units of actual travel per baseline (60fps) tick.
SphereMove.DEFAULT_SPEED = 5

local function sphereMoveUpdate(self)
  local timeScale = state.timeScale or 1
  local toTarget = self.target:subtract(self.pos)
  local dist = toTarget:length()
  local step = self.speed * timeScale

  if dist <= step then
    -- Reached (or would overshoot) this leg's target — snap exactly onto
    -- it rather than overshooting and oscillating around it, then flip
    -- to the OTHER fixed point for the next leg. Comparing self.target
    -- against self.startPoint/self.endPoint by reference (not value) is
    -- deliberate and safe: those two are the only two tables this field
    -- is ever assigned from, created once in SphereMove.new and never
    -- replaced, so "which one is it right now" is just "which one IS
    -- it," no epsilon-comparison needed.
    self.pos.x, self.pos.y = self.target.x, self.target.y
    self.target = (self.target == self.startPoint) and self.endPoint or self.startPoint
  else
    self.pos:addScaled(toTarget:normalize(), step)
  end
end

-- x, y: wherever the object actually sits in Tiled — only used for the
-- very first leg of the path (see this file's own header comment).
-- startX/startY, endX/endY: the two points it patrols between forever
-- after that. radius/speed: same meaning as Sphere's own radius and
-- every other patrolling hazard's own speed (defaults to
-- SphereMove.DEFAULT_SPEED when not given).
function SphereMove.new(x, y, startX, startY, endX, endY, radius, speed)
  local self = Sphere.new(x, y, radius)

  self.startPoint = Vector2.new(startX, startY)
  self.endPoint = Vector2.new(endX, endY)
  self.target = self.startPoint
  self.speed = speed or SphereMove.DEFAULT_SPEED

  self.update = sphereMoveUpdate

  return self
end

return SphereMove
