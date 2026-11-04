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
local GlowOrb = require("lua.effects.GlowOrb")

local Sphere = {}

Sphere.DEFAULT_RADIUS = 30
Sphere.COLOR = { 0.6, 0.63, 0.67, 1 }

-- GPU-shaded metallic look (see lua/effects/GlowOrb.lua) — a cool,
-- silvery gradient with a soft blue-white ambient glow, replacing the
-- old flat stencil-circle shadow/highlight/specular hack.
local ORB_COLORS = {
  dark = { 0.22, 0.24, 0.28 },
  light = { 0.78, 0.81, 0.86 },
  rim = { 0.92, 0.95, 1.0 },
  glow = { 0.55, 0.70, 0.95 },
}

-- With the same soft sun-side highlight every ordinary planetoid has,
-- read straight from Planetoid's own settings so the two always match —
-- change it there and Spheres follow.
--
-- And with the chrome gradient multiplied over it (see GlowOrb.lua's
-- own metal block and lua/effects/MetalGradient.lua) — the same metal
-- as the title-screen logo, wrapped round the ball. METAL_OPACITY is
-- how strongly: 0 none, 1 the full gradient.
Sphere.METAL_OPACITY = 0.5

local function drawMetallic(self)
  GlowOrb.draw(self.pos.x, self.pos.y, self.radius, ORB_COLORS, {
    metalOpacity = Sphere.METAL_OPACITY,
    highlightAlpha = Planetoid.HIGHLIGHT_ALPHA,
    highlightSize = Planetoid.HIGHLIGHT_SIZE,
    highlightOffset = Planetoid.HIGHLIGHT_OFFSET,
  })
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
