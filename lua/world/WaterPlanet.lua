-- lua/world/WaterPlanet.lua
--
-- A landmark planetoid whose entire surface is meant to eventually be
-- water (swimming comes later — see the player's own comment on this).
-- For now it's a completely ordinary Planetoid (same gravity, landing,
-- and walking-around behavior every other planet already has — see
-- lua/world/Planetoid.lua) with one difference: its :draw() is
-- overridden on the INSTANCE (not the shared Planetoid class) to render
-- a shader-drawn circle whose EDGE wobbles sinusoidally instead of a
-- perfectly round body.
--
-- The wave is purely cosmetic. self.radius (what GravitySystem and
-- CollisionSystem actually use for landing/walking/gravity) never
-- changes — the shader just paints some pixels near the true boundary
-- transparent or opaque based on the wave, the same "rectangle + alpha
-- cutout" technique lua/world/Lava.lua already uses for its own wavy
-- surface line. The one real difference from Lava's version: a lava
-- tile's wave runs along worldX (a straight line), so sin(worldX * freq)
-- is enough. A planet's edge is a circle, so the wave has to run along
-- ANGLE around the center instead — sin(angle * humps + time), where
-- "humps" is how many wave crests fit around the full circle.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local Planetoid = require("lua.world.Planetoid")

local WaterPlanet = {}

----------------------------------------------------------------------
-- Tunables
----------------------------------------------------------------------

local WAVE_AMPLITUDE = 22    -- world units, how far the edge bulges in/out
local WAVE_HUMPS      = 12   -- wave crests around the full circle (primary layer)
local WAVE_HUMPS_2    = 19   -- a second, smaller/faster layer on top, avoids a perfectly regular scallop
local WAVE_SPEED      = 1.0  -- radians per baseline (60fps) frame's worth of sharedTime — slow drift, not choppy
local EDGE_SOFTNESS   = 3    -- world units of blur across the transparent/opaque boundary
local COLOR_DEEP      = { 0.05, 0.24, 0.52 } -- deeper blue toward the center
local COLOR_SHALLOW   = { 0.30, 0.66, 0.85 } -- lighter, cyan-leaning blue near the wavy edge

-- Caustics: the shifting bright light-net pattern real water casts,
-- approximated here (rather than a true light-refraction sim) as three
-- overlapping sine fields at different angles/speeds, averaged and then
-- raised to a power so only their overlapping PEAKS stay bright — that
-- power is what turns smooth sine ripples into the thin bright veins
-- caustics actually look like, instead of a soft plaid pattern.
local CAUSTIC_STRENGTH = .3   -- 0 = none, 1 = fully replaces the base color at a peak
local CAUSTIC_SCALE    = .005 -- spatial frequency, per world unit — smaller = larger caustic cells
local CAUSTIC_SPEED    = .5   -- how fast the pattern drifts, same sharedTime units as the edge wave
local CAUSTIC_SHARPNESS = 1.0  -- higher = thinner, brighter veins with more dark space between them
local COLOR_CAUSTIC    = { 0.80, 0.96, 1.0 } -- near-white, faintly cyan highlight color

local BODY_OPACITY = 0.8 -- 1 = fully opaque water; scales the shader's own edge-cutoff alpha

-- Spherical shading: darkens the hemisphere facing AWAY from the sun
-- (same "sun is at the exact center of the scene" convention
-- Planetoid:drawSunShading already uses), so the body reads as a lit
-- sphere instead of a flat-shaded disc. Computed per-pixel in the
-- shader itself (see sunDir below) rather than as a separate overlay
-- pass like Planetoid's own version, so it blends naturally with the
-- wavy edge and caustics instead of being clipped to a plain circle.
local SHADE_STRENGTH = 0 -- 0 = no shading, 1 = fully replaces color with colorShade at the darkest point
local COLOR_SHADE    = { 0.02, 0.05, 0.20 } -- dark navy blue

-- Hard core: a perfectly ordinary solid Planetoid nested at the water
-- body's own center (see WaterPlanet.new), sized as a fraction of the
-- water body's own radius. Gives gravity a real, physical place to stop
-- — a falling player used to overshoot back and forth across the exact
-- center point every frame (radial gravity pulling toward a single
-- coordinate has no natural rest state there), which read as rapid
-- flickering between "one side" and the other. A solid body with actual
-- onSurface landing (the same code every other planet already uses)
-- fixes that outright instead of needing a code-side velocity clamp.
local CORE_FRACTION = 1 / 8
local CORE_COLOR    = { 0.42, 0.30, 0.20 } -- brown

----------------------------------------------------------------------
-- Shader — one compiled instance, shared by every WaterPlanet
----------------------------------------------------------------------

local waterShader = nil
local function getWaterShader()
  if waterShader then return waterShader end
  waterShader = love.graphics.newShader([[
    extern vec2 originScreen; // this planet's bounding box top-left corner, in SCREEN pixels, this frame
    extern number zoom;
    extern number time;
    extern number boxHalf;    // bounding box half-size, world units — only used to re-center local coords on the circle
    extern number radius;     // the TRUE collision radius, world units — the wave's baseline and depth-shading reference
    extern number waveAmplitude;
    extern number waveHumps;
    extern number waveHumps2;
    extern number waveSpeed;
    extern number edgeSoftness;
    extern vec3 colorDeep;
    extern vec3 colorShallow;
    extern number causticStrength;
    extern number causticScale;
    extern number causticSpeed;
    extern number causticSharpness;
    extern vec3 colorCaustic;
    extern number bodyOpacity;
    extern vec2 sunDir;       // unit vector from this planet's center TOWARD the sun, world space
    extern number shadeStrength;
    extern vec3 colorShade;

    // Three sine fields at different angles/speeds/scales, averaged.
    // Where all three happen to peak together the average approaches
    // 1.0; everywhere else it's lower — raising that to causticSharpness
    // crushes the in-between areas toward 0 and keeps only those
    // overlapping peaks bright, which is what turns smooth ripples into
    // the thin bright veins real caustics have.
    float caustics(vec2 p, float t) {
      float a = sin(p.x * 1.0 + p.y * 0.6 + t);
      float b = sin(p.x * -0.7 + p.y * 1.3 - t * 0.8);
      float c = sin(p.x * 1.4 - p.y * 0.9 + t * 1.2);
      float v = (a + b + c) / 3.0;
      return pow(clamp(v, 0.0, 1.0), causticSharpness);
    }

    vec4 effect(vec4 color, Image tex, vec2 texture_coords, vec2 screen_coords) {
      vec2 local = (screen_coords - originScreen) / zoom - vec2(boxHalf, boxHalf);
      float dist = length(local);
      float angle = atan(local.y, local.x);

      float wave = sin(angle * waveHumps + time * waveSpeed) * waveAmplitude
                 + sin(angle * waveHumps2 - time * waveSpeed * 1.6) * waveAmplitude * 0.4;
      float edgeR = radius + wave;

      // Inside edgeR: opaque water. Outside: transparent. Blended
      // smoothly across edgeSoftness instead of a hard pixel edge.
      float alpha = (1.0 - smoothstep(edgeR - edgeSoftness, edgeR + edgeSoftness, dist)) * bodyOpacity;

      // Simple depth cue: deeper/darker blue toward the center,
      // lighter toward the wavy shoreline — no motion of its own, just
      // a plain radial mix, kept deliberately simple for now.
      float depthT = clamp(dist / radius, 0.0, 1.0);
      vec3 waterColor = mix(colorDeep, colorShallow, depthT);

      // Spherical shading: darker on the hemisphere facing away from
      // the sun. facing is 1 where this pixel's own direction from
      // center points straight at the sun, -1 straight away from it —
      // smoothstep turns that into a soft terminator band instead of a
      // hard half-and-half split.
      vec2 dirFromCenter = local / max(dist, 1.0);
      float facing = dot(dirFromCenter, sunDir);
      float shadeT = smoothstep(-0.5, 0.6, -facing) * shadeStrength;
      waterColor = mix(waterColor, colorShade, shadeT);

      // Caustics driven by "local" (world units relative to the
      // planet's own center) rather than screen_coords, so the pattern
      // is anchored to the water's surface and drifts smoothly with
      // time regardless of camera pan/zoom.
      float c = caustics(local * causticScale, time * causticSpeed);
      waterColor = mix(waterColor, colorCaustic, c * causticStrength);

      return vec4(waterColor, alpha) * color;
    }
  ]])
  return waterShader
end

----------------------------------------------------------------------
-- Shared wave clock — one value read by every WaterPlanet's shader
-- (only one exists right now, but this matches Lava.lua's own
-- shared-clock convention for the same reason: advancing it from
-- :draw() itself would tie its speed to how many are on screen).
-- Advanced explicitly once per frame via WaterPlanet.updateSharedClock()
-- (called from main.lua, alongside Lava.updateSharedClock()).
----------------------------------------------------------------------

local sharedTime = 0

function WaterPlanet.updateSharedClock()
  local timeScale = state.timeScale or 1
  sharedTime = sharedTime + (1 / 60) * timeScale
end

----------------------------------------------------------------------
-- Instance draw override
----------------------------------------------------------------------

local function drawWater(self)
  local shader = getWaterShader()
  local zoom = state.zoom or 1
  local cam = state.camera or { x = 0, y = 0 }

  -- Padded bounding box so the wave's own crest (which pokes outward
  -- past self.radius) never gets clipped by the rectangle it's drawn
  -- into.
  local pad = WAVE_AMPLITUDE + EDGE_SOFTNESS + 2
  local boxHalf = self.radius + pad
  local x0 = self.pos.x - boxHalf
  local y0 = self.pos.y - boxHalf
  local size = boxHalf * 2

  love.graphics.setShader(shader)
  shader:send("originScreen", { (x0 - cam.x) * zoom, (y0 - cam.y) * zoom })
  shader:send("zoom", zoom)
  shader:send("time", sharedTime)
  shader:send("boxHalf", boxHalf)
  shader:send("radius", self.radius)
  shader:send("waveAmplitude", WAVE_AMPLITUDE)
  shader:send("waveHumps", WAVE_HUMPS)
  shader:send("waveHumps2", WAVE_HUMPS_2)
  shader:send("waveSpeed", WAVE_SPEED)
  shader:send("edgeSoftness", EDGE_SOFTNESS)
  shader:send("colorDeep", COLOR_DEEP)
  shader:send("colorShallow", COLOR_SHALLOW)
  shader:send("causticStrength", CAUSTIC_STRENGTH)
  shader:send("causticScale", CAUSTIC_SCALE)
  shader:send("causticSpeed", CAUSTIC_SPEED)
  shader:send("causticSharpness", CAUSTIC_SHARPNESS)
  shader:send("colorCaustic", COLOR_CAUSTIC)
  shader:send("bodyOpacity", BODY_OPACITY)

  -- Same "sun sits at the exact center of the scene" convention
  -- Planetoid:drawSunShading already uses, rather than depending on
  -- state.sun existing.
  local sunX, sunY = (state.sceneWidth or 0) / 2, (state.sceneHeight or 0) / 2
  local sdx, sdy = sunX - self.pos.x, sunY - self.pos.y
  local sd = math.sqrt(sdx * sdx + sdy * sdy)
  if sd < 1 then sd = 1; sdx, sdy = 1, 0 end
  shader:send("sunDir", { sdx / sd, sdy / sd })
  shader:send("shadeStrength", SHADE_STRENGTH)
  shader:send("colorShade", COLOR_SHADE)

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.rectangle("fill", x0, y0, size, size)
  love.graphics.setShader()
  love.graphics.setColor(1, 1, 1, 1)
end

----------------------------------------------------------------------
-- Public API
----------------------------------------------------------------------

-- x, y: world position of the planet's center. radius: TRUE collision
-- radius (gravity/landing/walking) — same one the wavy edge wobbles
-- around visually.
function WaterPlanet.new(x, y, radius)
  local planet = Planetoid.new(x, y, radius, COLOR_SHALLOW)

  -- A fixed landmark, not a drifting field planetoid — isImmovable
  -- makes updatePlanetoidsPhysics (main.lua) zero its velocity and skip
  -- moving it every frame, same convention SkyDomePlanetoid/Lava use
  -- for "this doesn't wander."
  planet.isImmovable = true
  planet.isPermanent = true
  planet.vel = Vector2.new(0, 0)

  -- Marker CollisionSystem/Player.lua key off of: the water body is
  -- never solid (see CollisionSystem:tryLandOnPlanet's own isWaterPlanet
  -- check) — a player just sinks straight through it, with self.radius
  -- here purely defining "where the wavy visual edge sits" and "how far
  -- out counts as submerged," not a landing surface.
  planet.isWaterPlanet = true

  -- Instance-level override: Lua's normal table lookup finds this
  -- directly on `planet` before ever consulting Planetoid's own
  -- __index, so every other Planetoid method (gravity/physics fields,
  -- etc.) still works unchanged — only :draw() is different.
  planet.draw = drawWater

  -- The hard core (see CORE_FRACTION's own comment above) is a
  -- completely ordinary, unmodified Planetoid — no isWaterPlanet flag,
  -- no draw/update overrides — so it lands/walks exactly like any other
  -- planet in the game via the existing generic collision code, with no
  -- new mechanics needed for "solid ground at the bottom of the water."
  -- Drawn in the normal planetoid pass (not excluded like the water
  -- shell), so the shell's own second, after-the-player draw pass
  -- naturally paints translucent water on top of it — reads as a solid
  -- seabed dimly visible through the water above it.
  local core = Planetoid.new(x, y, radius * CORE_FRACTION, CORE_COLOR)
  core.isImmovable = true
  core.isPermanent = true
  core.vel = Vector2.new(0, 0)

  return planet, core
end

return WaterPlanet
