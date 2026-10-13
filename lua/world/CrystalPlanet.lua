-- lua/world/CrystalPlanet.lua
--
-- A planetoid that's a ball of glass — the same glass the prisms
-- growing out of it are made of (see lua/world/Prism.lua), but cyan
-- where they are red — the mining planet. Built on top of
-- Planetoid.new() with a custom :draw override, so gravity, landing and
-- the pull beam all treat it like any other entry in state.planetoids.
--
-- And it MOVES like any other: it drifts (the slow random drift
-- Planetoid.new gives everything), bounces off other planetoids, and is
-- shoved along by a ground pound (see CollisionSystem.lua's own
-- tryLandOnPlanet — anything not isImmovable is). It's only isPermanent,
-- so it's never cleared away with the cell it happens to drift out of.
--
-- Its colors are its own (see LIT_COLOR and the values after it), but
-- how strong its lights are is Prism.lua's, read from there so the two
-- stay the same glass — change them there and this follows. Unlike a
-- prism it is NOT see-through: the prisms' sunken feet are hidden
-- behind it.

local state = require("lua.state")
local Planetoid = require("lua.world.Planetoid")
local Prism = require("lua.world.Prism")

local CrystalPlanet = {}

-- The two ends of the cyan it's painted in — the side turned squarely
-- toward the sun, and the side turned squarely away — and the color of
-- its lights. A little darker than the prisms' own red.
CrystalPlanet.LIT_COLOR = { 0.14, 0.60, 0.66 }
CrystalPlanet.SHADOW_COLOR = { 0.0, 0.17, 0.25 }
CrystalPlanet.GLINT_COLOR = { 0.8, 1.0, 1.0 }

-- It turns on the spot, carrying whatever stands on it round with it:
-- the prisms (see Prism:placement) and the astronaut (see
-- updateRotation below). Radians per baseline (60fps) frame — positive
-- is clockwise on screen, 0 stops it. 0.004 is one full turn in about
-- 26 seconds.
CrystalPlanet.ROTATION_SPEED = 0.004

CrystalPlanet.OUTLINE_WIDTH = 2.5    -- world units, the dark line round its edge (like the prisms' own outlines)
CrystalPlanet.SHEEN_SPACING = 1.1    -- from one pair of sheen bands to the next, in radii
CrystalPlanet.FAR_GLOW_STRENGTH = 0.3 -- the light that gathers inside a glass ball on the side AWAY from the sun
CrystalPlanet.SPARKLE_STRENGTH = 0.7 -- the small bright spot where the sun itself reflects

-- Drawn on a plain square (uv 0..1 across it) a little bigger than the
-- ball. In the shader, q is the pixel's position in radii from the
-- center, so the ball is everywhere length(q) < 1.
local BOX_SCALE = 1.06 -- the square's half-size, in radii

-- The same lights a prism has, bent round a ball:
--   shade    lit cyan on the side facing the sun, shadow cyan on the far
--            side — from a pseudo-3D sphere normal (see GlowOrb.lua's
--            own comment on that), not a flat left/right split.
--   rim      light along the edge, all the way round.
--   sheen    the prisms' own wide-and-thin pair of slanted bands, curved
--            to follow the ball. These are the one thing on it that
--            TURNS with it (`rotation`) — everything else is light
--            from the sun, which stays where the sun is.
--   far glow, sparkle   see the values above.
--   outline  the edge darkened to a deep shade of the body, as the
--            prisms' outlines are.
local shader = nil
local function getShader()
  if shader then return shader end
  shader = love.graphics.newShader([[
    extern float boxScale;
    extern float edgeSoftness;   // in radii: the blur across the ball's own edge
    extern float outlineWidth;   // in radii
    extern vec2 sunDir;          // unit vector from the ball's center toward the sun
    extern vec3 litColor;
    extern vec3 shadowColor;
    extern vec3 glintColor;
    extern float outlineBrightness;
    extern float rimStrength;
    extern float sheenStrength;
    extern float sheenSpacing;
    extern float sheenSlant;
    extern float farGlowStrength;
    extern float sparkleStrength;
    extern float rotation;       // radians the ball has turned

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec2 q = (uv - vec2(0.5)) * 2.0 * boxScale;
      float dist = length(q);
      float d = min(dist, 1.0);
      float nz = sqrt(1.0 - d * d);
      vec3 normal = vec3(dist > 0.0001 ? q / dist * d : vec2(0.0), nz);

      float facing = dot(normal, normalize(vec3(sunDir, 0.5)));
      float lit = smoothstep(-0.4, 0.8, facing);
      vec3 body = mix(shadowColor, litColor, lit);

      float rim = d * d * d * d;

      // The pixel's position on the ball as it was before it turned.
      float cosR = cos(rotation), sinR = sin(rotation);
      vec2 turned = vec2(q.x * cosR + q.y * sinR, q.y * cosR - q.x * sinR);
      float along = fract((turned.x + turned.y * sheenSlant + 0.35 * d * d) / sheenSpacing + 0.2);
      float sheen = smoothstep(0.0, 0.03, along) * (1.0 - smoothstep(0.12, 0.15, along))
        + 0.6 * smoothstep(0.20, 0.215, along) * (1.0 - smoothstep(0.235, 0.25, along));
      sheen *= nz; // fading out toward the edge, where the surface turns away

      // A crescent just inside the edge, opposite the sun.
      float away = clamp(dot(q, -sunDir), 0.0, 1.0);
      float farGlow = smoothstep(0.45, 0.95, d) * away * away;

      float s = clamp(1.0 - length(q - sunDir * 0.5) / 0.28, 0.0, 1.0);
      float sparkle = s * s;

      float glint = (rim * rimStrength + sheen * sheenStrength) * (0.35 + 0.65 * lit)
        + farGlow * farGlowStrength + sparkle * sparkleStrength;

      float outline = smoothstep(1.0 - outlineWidth - edgeSoftness, 1.0 - outlineWidth + edgeSoftness, dist);
      vec3 rgb = (body + glintColor * glint) * mix(1.0, outlineBrightness, outline);

      float alpha = 1.0 - smoothstep(1.0 - edgeSoftness, 1.0 + edgeSoftness, dist);
      return vec4(rgb, alpha) * color;
    }
  ]])
  return shader
end

-- The plain square the shader is drawn on: a single white pixel,
-- stretched to size.
local pixel = nil
local function getPixel()
  if pixel then return pixel end
  local data = love.image.newImageData(1, 1)
  data:setPixel(0, 0, 1, 1, 1, 1)
  pixel = love.graphics.newImage(data)
  pixel:setFilter("linear", "linear")
  return pixel
end

local function drawCrystal(self)
  Planetoid.drawEclipseShadow(self)

  local sunX, sunY = 1, 0
  local sun = state.sun
  if sun and sun.pos then
    local dx, dy = sun.pos.x - self.pos.x, sun.pos.y - self.pos.y
    local dist = math.sqrt(dx * dx + dy * dy)
    if dist > 0 then sunX, sunY = dx / dist, dy / dist end
  end

  local r = self.radius
  local sh = getShader()
  sh:send("boxScale", BOX_SCALE)
  sh:send("edgeSoftness", 1 / (r * (state.zoom or 1))) -- about a screen pixel either side
  sh:send("outlineWidth", CrystalPlanet.OUTLINE_WIDTH / r)
  sh:send("sunDir", { sunX, sunY })
  sh:send("litColor", CrystalPlanet.LIT_COLOR)
  sh:send("shadowColor", CrystalPlanet.SHADOW_COLOR)
  sh:send("glintColor", CrystalPlanet.GLINT_COLOR)
  sh:send("outlineBrightness", Prism.OUTLINE_BRIGHTNESS)
  sh:send("rimStrength", Prism.RIM_STRENGTH)
  sh:send("sheenStrength", Prism.SHEEN_STRENGTH)
  sh:send("sheenSpacing", CrystalPlanet.SHEEN_SPACING)
  sh:send("sheenSlant", Prism.SHEEN_SLANT)
  sh:send("farGlowStrength", CrystalPlanet.FAR_GLOW_STRENGTH)
  sh:send("sparkleStrength", CrystalPlanet.SPARKLE_STRENGTH)
  sh:send("rotation", self.rotationAngle)

  local half = r * BOX_SCALE
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.setShader(sh)
  love.graphics.draw(getPixel(), self.pos.x - half, self.pos.y - half, 0, half * 2, half * 2)
  love.graphics.setShader()
end

-- Turns it by one frame's worth (ts: the frame's time scale, 1 at
-- 60fps), and the astronaut with it if he's standing on it: his place
-- on a round planetoid is just an angle round it (Player.lua's own
-- self.angle — his position is worked out from that every frame, in
-- Player:move), so carrying him is a matter of moving that angle on by
-- the same amount. In the air he isn't carried; it turns under him.
-- Call before Player:move.
local function updateRotation(self, ts)
  local turn = self.rotationSpeed * ts
  if turn == 0 then return end
  self.rotationAngle = math.fmod(self.rotationAngle + turn, math.pi * 2)

  local player = state.player
  if player and player.onSurface and player.currentPlanet == self then
    player.angle = player.angle + turn
  end
end

-- x, y: world position of its CENTER.
function CrystalPlanet.new(x, y, radius)
  local self = Planetoid.new(x, y, radius, CrystalPlanet.LIT_COLOR)

  -- Not isImmovable, and its drift (self.vel, from Planetoid.new) is
  -- left as it is — see this file's own header.
  self.isPermanent = true

  -- Same names RoundedRectPlanetoid.lua uses for its own spin.
  self.rotationAngle = 0
  self.rotationSpeed = CrystalPlanet.ROTATION_SPEED

  self.draw = drawCrystal
  self.updateRotation = updateRotation

  return self
end

return CrystalPlanet
