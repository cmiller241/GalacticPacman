-- lua/world/Sphere.lua
--
-- A small, fixed metallic ball — a lightweight landmark planetoid, not a
-- drifting field body. Built on top of Planetoid.new() the same way
-- WaterPlanet.lua is (isImmovable + isPermanent + a plain vel of zero,
-- plus a custom :draw override), so it gets exactly the same gravity /
-- landing / pull-beam eligibility as every other entry in
-- state.planetoids for free — Player:trySelectPullTarget and
-- CollisionSystem:tryLandOnPlanet only ever care about pos/radius/
-- isPullExempt/isRoundedRect, none of which this changes.
--
-- Placed via Tiled's Object Layer (tiled/Level1.lua, class = "Sphere") —
-- see TiledTerrain.lua's sphereSpawns and main.lua's own spawn loop. The
-- object's x/y IS the sphere's center, unlike ooombaSpawns (which get
-- raycast down onto whatever terrain sits below them).

local Planetoid = require("lua.world.Planetoid")
local Vector2 = require("lua.vector2")

local Sphere = {}

Sphere.DEFAULT_RADIUS = 30
Sphere.COLOR = { 0.6, 0.63, 0.67, 1 }

local RIM_COLOR = { 0.18, 0.19, 0.22, 1 }
local SHADOW_COLOR = { 0, 0, 0, 0.35 }
local HIGHLIGHT_COLOR = { 1, 1, 1, 0.55 }
local SPECULAR_COLOR = { 1, 1, 1, 0.9 }

-- Flat, per-frame shading (a handful of circles inside a stencil clip) —
-- no baked canvas the way Planetoid's own ensureBodyCanvas needs, since
-- this is small and there are only ever a few of them, unlike the
-- hundreds of belt planetoids that pattern exists to amortize.
local function drawMetallic(self)
  local x, y, r = self.pos.x, self.pos.y, self.radius

  love.graphics.stencil(function()
    love.graphics.circle("fill", x, y, r)
  end, "replace", 1)
  love.graphics.setStencilTest("greater", 0)

  love.graphics.setColor(self.color)
  love.graphics.circle("fill", x, y, r)

  -- Shadowed side, away from the light (upper-left).
  love.graphics.setColor(SHADOW_COLOR)
  love.graphics.circle("fill", x + r * 0.4, y + r * 0.4, r * 0.9)

  -- Broad soft highlight toward the light.
  love.graphics.setColor(HIGHLIGHT_COLOR)
  love.graphics.circle("fill", x - r * 0.35, y - r * 0.35, r * 0.45)

  -- Tight specular point.
  love.graphics.setColor(SPECULAR_COLOR)
  love.graphics.circle("fill", x - r * 0.45, y - r * 0.45, r * 0.15)

  love.graphics.setStencilTest()

  love.graphics.setColor(RIM_COLOR)
  love.graphics.setLineWidth(math.max(1, r * 0.15))
  love.graphics.circle("line", x, y, r)

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.setLineWidth(1)
end

-- x, y: world position of the sphere's CENTER.
function Sphere.new(x, y, radius)
  local self = Planetoid.new(x, y, radius or Sphere.DEFAULT_RADIUS, Sphere.COLOR)

  -- Fixed landmark, not a drifting field planetoid — same
  -- isImmovable/isPermanent/vel-zeroing convention WaterPlanet.lua uses
  -- for "this doesn't wander" (see main.lua's updatePlanetoidsPhysics).
  self.isImmovable = true
  self.isPermanent = true
  self.vel = Vector2.new(0, 0)

  -- A quarter of Planetoid's own default influenceRadius (radius +
  -- constants.INFLUENCE_PADDING) — that padding is tuned for the much
  -- bigger belt/water planets sharing it, and read as a wildly oversized
  -- gravity well around a small landmark this size. Overridden per-
  -- instance here rather than touching INFLUENCE_PADDING itself, which
  -- every other Planetoid-based body still relies on unchanged.
  self.influenceRadius = self.influenceRadius / 4

  self.draw = drawMetallic

  return self
end

return Sphere
