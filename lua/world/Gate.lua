-- lua/world/Gate.lua
--
-- A vertical sliding barrier spanning the gap between a solid floor
-- tile below and a solid ceiling tile above (see TiledTerrain.lua's own
-- gateSpawns — topY/bottomY are already resolved there via a tile-grid
-- scan for the nearest "wall or top" tile in each direction from the
-- Tiled object's own point). Blocks the player like any other solid
-- wall while closed; opening slides its own BOTTOM edge upward until
-- it's fully retracted flush with the ceiling (closing reverses that),
-- rather than just disappearing outright — reads as sliding into a slot
-- at the ceiling, the same way a real portcullis/sliding door would,
-- with no extra hidden space needed above the visible corridor.
--
-- Deliberately controlled by a single, hardcoded Lever for now (see
-- main.lua's own spawn wiring, lever.gate = gate) — Gate itself has no
-- idea which lever(s) control it; :setOpen(bool) is the only thing
-- anything else needs to call.
--
-- Doubles as BOTH a drawable/updatable entity (see main.lua's own
-- state.gates list) AND a plain collision "wall" record — inserted
-- directly into the level's own `walls` array (see main.lua), so
-- CollisionSystem:handlePlayerWallCollisions picks it up automatically
-- through the exact same pos/halfWidth/halfHeight fields every other
-- wall entry already has (see TiledTerrain.lua's buildWallShapes),
-- just recomputed every frame here as it slides instead of staying
-- fixed forever.

local Vector2 = require("lua.vector2")

local Gate = {}
Gate.__index = Gate

-- How long a full open<->close slide takes to cover the ENTIRE gap
-- (topY to bottomY) — a short gap slides just as fast start-to-finish
-- as a tall one would, proportionally, since this is a per-tick
-- fraction of slideProgress (0..1), not a fixed world-units-per-tick
-- speed.
local SLIDE_SPEED_PER_TICK = 0.02 -- ~50 baseline (60fps) ticks for a full 0->1 slide, well under a second

local COLOR_FRAME = { 0.32, 0.30, 0.28 }
local COLOR_BAR = { 0.55, 0.52, 0.46 }
local BAR_SPACING = 18 -- world units between horizontal cross-bars, cage/portcullis look
local BAR_THICKNESS = 4

-- x: world position of the gate's own center column. topY/bottomY: the
-- CLOSED extent (see TiledTerrain.lua's own gateSpawns). halfWidth: how
-- thick the bar is, left-right.
function Gate.new(x, topY, bottomY, halfWidth)
  local self = setmetatable({}, Gate)

  self.topY = topY
  self.bottomYClosed = bottomY
  self.halfWidth = halfWidth

  -- true = target is fully OPEN (retracted up to topY); false = target
  -- is fully CLOSED (resting at bottomYClosed). :setOpen toggles this;
  -- slideProgress (below) is what actually animates toward it.
  self.isOpen = false

  -- 0 = fully closed (spans topY..bottomYClosed, blocking completely),
  -- 1 = fully open (collapsed to (near) zero height right at topY,
  -- blocking nothing). Animated toward isOpen's own target every
  -- :update() tick.
  self.slideProgress = 0

  -- Collision fields — same shape every other TiledTerrain.lua wall
  -- entry exposes (pos/halfWidth/halfHeight/radius), kept in sync every
  -- frame by :update() below. Inserted directly into the level's own
  -- `walls` array by main.lua, so CollisionSystem needs no changes at
  -- all to already push the player out of a closed/closing gate.
  self.pos = Vector2.new(x, (topY + bottomY) / 2)
  self.halfHeight = (bottomY - topY) / 2
  self.radius = math.sqrt(self.halfWidth * self.halfWidth + self.halfHeight * self.halfHeight)

  return self
end

-- Called by whichever Lever controls this gate (see Lever.lua's own
-- :tryInteract) — just sets the TARGET; :update() does the actual
-- animating toward it every frame.
function Gate:setOpen(isOpen)
  self.isOpen = isOpen
end

function Gate:update(ts)
  local target = self.isOpen and 1 or 0
  if self.slideProgress < target then
    self.slideProgress = math.min(target, self.slideProgress + SLIDE_SPEED_PER_TICK * ts)
  elseif self.slideProgress > target then
    self.slideProgress = math.max(target, self.slideProgress - SLIDE_SPEED_PER_TICK * ts)
  end

  -- Bottom edge rises from bottomYClosed up to topY as slideProgress
  -- goes 0 -> 1 — reads as the bar retracting upward into the ceiling.
  local currentBottomY = self.bottomYClosed - self.slideProgress * (self.bottomYClosed - self.topY)

  -- Floored just above zero rather than allowed to hit it exactly —
  -- CollisionSystem's own circle-vs-box math divides by nothing here,
  -- but a hairline-thin box sitting flush with the (already solid)
  -- ceiling tile above is functionally "not blocking anything" either
  -- way, so there's no real behavior difference, just a defensive
  -- floor against a literal zero-size box.
  self.halfHeight = math.max(0.001, (currentBottomY - self.topY) / 2)
  self.pos.y = (self.topY + currentBottomY) / 2
  self.radius = math.sqrt(self.halfWidth * self.halfWidth + self.halfHeight * self.halfHeight)
end

function Gate:draw()
  if self.halfHeight <= 0.5 then return end -- fully (or near-fully) retracted — nothing left to draw

  local x0 = self.pos.x - self.halfWidth
  local x1 = self.pos.x + self.halfWidth
  local y0 = self.pos.y - self.halfHeight
  local y1 = self.pos.y + self.halfHeight

  love.graphics.setColor(COLOR_FRAME)
  love.graphics.rectangle("fill", x0, y0, x1 - x0, y1 - y0)

  -- Horizontal cross-bars, cage/portcullis texture.
  love.graphics.setColor(COLOR_BAR)
  local y = y0
  while y < y1 do
    love.graphics.rectangle("fill", x0, y - BAR_THICKNESS / 2, x1 - x0, BAR_THICKNESS)
    y = y + BAR_SPACING
  end

  love.graphics.setColor(1, 1, 1, 1)
end

return Gate
