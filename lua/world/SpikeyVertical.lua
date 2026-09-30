-- lua/world/SpikeyVertical.lua
--
-- Exactly like Spikey (lua/world/Spikey.lua) — same gray/dark core,
-- off-white spinning spikes, same lethal/solid/wall-jumpable contact
-- behavior (added to the same state.spikeys list, so
-- CollisionSystem:handlePlayerSpikeyCollisions treats it identically —
-- no changes needed there at all) — except it patrols up and down
-- within a shaft, reversing direction the instant it reaches whatever
-- blocks it on either end (a solid wall/floor tile, or another Spikey
-- sitting in its path), forever.
--
-- topY/bottomY (the full patrol range) are resolved ONCE, at spawn
-- time — see TiledTerrain.lua's own tile-grid scan for the wall half,
-- and main.lua's own spawn wiring for the "clamped further by any
-- nearby static Spikey" half. This does NOT re-check for obstacles
-- every frame the way the player's own collision does — it just
-- bounces between the two bounds it was given at spawn.

local Vector2 = require("lua.vector2")
local state = require("lua.state")
local Spikey = require("lua.world.Spikey")

local SpikeyVertical = {}
SpikeyVertical.__index = SpikeyVertical

-- Default when the Tiled object carries no "speed" custom property of
-- its own (see SpikeyVertical.new's own comment) — world units per
-- baseline (60fps) tick.
SpikeyVertical.DEFAULT_SPEED = 1.2

-- x: world column (fixed — this only ever moves vertically). topY/
-- bottomY: the full patrol range, already resolved against walls/other
-- Spikeys by the time this is called (see this file's own header
-- comment). radius: same meaning as Spikey's own. speed (optional):
-- world units per baseline tick — set per-object in Tiled via a custom
-- Float property named "speed" on the Spikey-Vertical point (see
-- TiledTerrain.lua's own spikeyVerticalSpawns parsing, which reads it
-- and passes it through here); defaults to DEFAULT_SPEED when the
-- object has none.
function SpikeyVertical.new(x, topY, bottomY, radius, speed)
  local self = setmetatable({}, SpikeyVertical)
  self.pos = Vector2.new(x, topY)
  self.radius = radius or Spikey.DEFAULT_RADIUS
  self.topY = topY
  self.bottomY = bottomY
  self.speed = speed or SpikeyVertical.DEFAULT_SPEED
  -- Starts at the top of its own range and heads down first — an
  -- arbitrary but deterministic starting phase, same "which end it
  -- begins at doesn't really matter" reasoning RobotButler's own patrol
  -- start uses.
  self.direction = 1 -- 1 = moving down (toward bottomY), -1 = moving up (toward topY)
  return self
end

-- Duck-typed: main.lua's own per-frame loop only calls :update() on
-- state.spikeys entries that actually have one (a plain Spikey has
-- none, and stays perfectly still without needing a no-op stub here).
function SpikeyVertical:update()
  local timeScale = state.timeScale or 1
  local dy = self.direction * self.speed * timeScale
  local desiredY = self.pos.y + dy
  if desiredY > self.bottomY then
    desiredY = self.bottomY
    self.direction = -1
  elseif desiredY < self.topY then
    desiredY = self.topY
    self.direction = 1
  end
  self.pos.y = desiredY
end

-- Identical visuals to a plain Spikey — borrowed directly rather than
-- duplicated, since that function only ever touches self.pos/
-- self.radius, both of which this object has too (including the same
-- shared spin clock — see Spikey.updateSharedClock, already called
-- once per frame from main.lua regardless of which kind of Spikey is
-- actually on screen).
SpikeyVertical.draw = Spikey.draw

return SpikeyVertical
