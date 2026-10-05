-- lua/world/Mirror.lua
--
-- A freestanding mirror pane: a framed rectangle that pivots in place
-- around its own center, cranked by whichever Crank object(s) in
-- Tiled name it via their own "Mirror" custom property (see
-- Crank.lua/TiledTerrain.lua's crankSpawns and main.lua's own spawn
-- wiring). Angle convention, both in Tiled's "Angle" custom property
-- and here, is plain degrees/radians in this engine's own
-- love.graphics.rotate sense (clockwise, since y grows downward): 0 =
-- horizontal, 90 = vertical.
--
-- Point-placement, same convention as Sphere/Spikey — the object's own
-- x/y IS the mirror's own pivot, no raycasting onto terrain below it
-- (a mirror can just as easily hang in open space as sit on the
-- ground).

local state = require("lua.state")
local Vector2 = require("lua.vector2")

local Mirror = {}
Mirror.__index = Mirror

local MIRROR_LENGTH = 90
local MIRROR_THICKNESS = 10
local SWING_SPEED = 0.12 -- radians per baseline (60fps) tick

local COLOR_FRAME = { 0.3, 0.32, 0.35 }
local COLOR_GLASS = { 0.75, 0.85, 0.95, 0.9 }
local COLOR_GLASS_SHINE = { 1, 1, 1, 0.5 }

-- x, y: world position of the mirror's own pivot. angleDegrees: its
-- starting angle (Tiled's own "Angle" custom property) — 0 =
-- horizontal, 90 = vertical.
function Mirror.new(x, y, angleDegrees)
  local self = setmetatable({}, Mirror)

  self.pos = Vector2.new(x, y)
  local angle = math.rad(angleDegrees or 0)
  self.angle = angle
  self.targetAngle = angle

  -- Exposed so CollisionSystem:handleFireballMirrorCollisions can test
  -- against this mirror's own rotated extent without reaching into
  -- this file's local constants.
  self.halfLength = MIRROR_LENGTH / 2
  self.halfThickness = MIRROR_THICKNESS / 2

  return self
end

-- Called by Crank.lua on each interact press — bumps the mirror's
-- target angle by stepRadians (the exact same step the crank's own
-- handle turns), eased into place over the following frames (see
-- :update) rather than snapping.
function Mirror:crank(stepRadians)
  self.targetAngle = self.targetAngle + stepRadians
end

function Mirror:update()
  local timeScale = state.timeScale or 1
  if self.angle < self.targetAngle then
    self.angle = math.min(self.targetAngle, self.angle + SWING_SPEED * timeScale)
  elseif self.angle > self.targetAngle then
    self.angle = math.max(self.targetAngle, self.angle - SWING_SPEED * timeScale)
  end
end

function Mirror:draw()
  love.graphics.push()
  love.graphics.translate(self.pos.x, self.pos.y)
  love.graphics.rotate(self.angle)

  -- Frame, then an inset "glass" pane with a thin highlight line down
  -- its middle — simple enough to read clearly at a glance, same
  -- "plain shapes, no art asset" approach as Lever/Crank.
  love.graphics.setColor(COLOR_FRAME)
  love.graphics.rectangle("fill", -MIRROR_LENGTH / 2, -MIRROR_THICKNESS / 2, MIRROR_LENGTH, MIRROR_THICKNESS, 3, 3)

  love.graphics.setColor(COLOR_GLASS)
  love.graphics.rectangle("fill",
    -MIRROR_LENGTH / 2 + 3, -MIRROR_THICKNESS / 2 + 3,
    MIRROR_LENGTH - 6, MIRROR_THICKNESS - 6)

  love.graphics.setColor(COLOR_GLASS_SHINE)
  love.graphics.setLineWidth(2)
  love.graphics.line(-MIRROR_LENGTH / 2 + 6, -1, MIRROR_LENGTH / 2 - 6, -1)

  love.graphics.setLineWidth(1)
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.pop()
end

return Mirror
