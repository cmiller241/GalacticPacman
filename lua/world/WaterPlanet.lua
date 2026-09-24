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

-- WAVE_AMPLITUDE/WAVE_HUMPS/WAVE_HUMPS_2 are tuned at this reference
-- radius — drawWater scales all three by self.radius/WAVE_REFERENCE_RADIUS
-- before sending them to the shader, rather than sending these raw
-- constants to every instance regardless of its own size. Without that,
-- a much smaller WaterPlanet got the exact same absolute bulge (22
-- units — a huge fraction of a small radius, a subtle one on a big
-- radius) AND the same hump count packed into a much shorter
-- circumference (so each hump's own wavelength, in world units, shrank
-- right along with the radius) — together that read as a spiky gear
-- instead of a gentle wavy shore. Scaling both keeps the wave's
-- relative bulge and relative wavelength consistent across sizes.
local WAVE_REFERENCE_RADIUS = 960
local WAVE_AMPLITUDE = 8     -- world units, how far the edge bulges in/out, AT the reference radius — kept fairly subtle (was 22) so the silhouette reads as "sphere with a wavy coastline" rather than "blob"
local WAVE_HUMPS      = 12   -- wave crests around the full circle (primary layer), AT the reference radius
local WAVE_HUMPS_2    = 19   -- a second, smaller/faster layer on top, avoids a perfectly regular scallop, AT the reference radius
local WAVE_SPEED      = 1.0  -- radians per baseline (60fps) frame's worth of sharedTime — slow drift, not choppy
local EDGE_SOFTNESS   = 3    -- world units of blur across the transparent/opaque boundary
local COLOR_DEEP      = { 0.05, 0.24, 0.52 } -- deeper blue toward the center
local COLOR_SHALLOW   = { 0.30, 0.66, 0.85 } -- lighter, cyan-leaning blue near the wavy edge

-- Caustics: the shifting bright light-net pattern real water casts,
-- approximated as a VORONOI (Worley noise) cell pattern — soft,
-- partially-transparent lines right at the boundary between cells
-- (cracked-mud style), each line varying in brightness cell to cell,
-- with the whole pattern run through a sine-based domain warp so it
-- shimmers/distorts instead of sitting frozen. Replaces an earlier
-- version built from three overlapping sine fields, which read as a
-- smooth plaid ripple rather than these cell-boundary veins.
local CAUSTIC_STRENGTH = .1   -- 0 = none, 1 = fully replaces the base color at a line's brightest point
local CAUSTIC_SCALE    = .005 -- spatial frequency, per world unit — smaller = larger caustic cells
local CAUSTIC_SPEED    = .5   -- how fast the pattern drifts/warps, same sharedTime units as the edge wave
local CAUSTIC_SHARPNESS = 1.4  -- higher = thinner, crisper cell-boundary lines; lower = wider, softer ones
local CAUSTIC_EDGE_WIDTH = 0.16 -- how far (in normalized cell-distance units) the soft boundary glow reaches from the true cell edge
local CAUSTIC_WARP_STRENGTH = 0.4 -- how far (in the same normalized units) the domain warp displaces the sampling point — the "distort the whole pattern" knob
-- Re-maps each pixel's distance from center (before sampling the cell
-- pattern) from screen-space r to the equivalent UNPROJECTED distance
-- on a sphere bulging toward the viewer (radius * asin(r/radius)
-- instead of r itself) — the same perspective foreshortening a texture
-- painted on a real globe shows: cells read as bigger/rounder near the
-- center and compress together near the rim, instead of being evenly
-- spaced across the flat disc. 0 = flat/off (old behavior), 1 = full
-- effect.
local CAUSTIC_BULGE = 1.0
local COLOR_CAUSTIC    = { 0.80, 0.96, 1.0 } -- near-white, faintly cyan highlight color

local BODY_OPACITY = 0.7 -- 1 = fully opaque water; scales the shader's own edge-cutoff alpha

-- Spherical shading: darkens the hemisphere facing AWAY from the sun
-- (same "sun is at the exact center of the scene" convention
-- Planetoid:drawSunShading already uses), so the body reads as a lit
-- sphere instead of a flat-shaded disc. Computed per-pixel in the
-- shader itself (see sunDir below) rather than as a separate overlay
-- pass like Planetoid's own version, so it blends naturally with the
-- wavy edge and caustics instead of being clipped to a plain circle.
--
-- This is now the PRIMARY color cue (see the shader's own comment on
-- lightT) — it used to be left at 0 (off), leaving only the radial
-- colorDeep/colorShallow mix below active, which darkened the exact
-- center regardless of which way the sun actually faced. That read as
-- a dark hole punched in the middle rather than a lit sphere, since a
-- real sphere's brightest point isn't necessarily its silhouette's own
-- center.
local SHADE_STRENGTH = 0.9-- 0 = no directional shading, 1 = full bright-side/dark-side range
local COLOR_SHADE    = { 0.02, 0.05, 0.20 } -- dark navy blue, the unlit hemisphere

-- Bright rim: a thin, lighter band right at the wavy shoreline, but only
-- on the sun-facing side — reads as light catching the shallow water at
-- the edge, per the "atmospheric/water rim" suggestion.
local COLOR_RIM     = { 0.55, 0.88, 0.98 } -- pale, near-white icy blue
local RIM_STRENGTH  = 0.5

-- Reflected highlight: the classic sphere-shading complement to the
-- bright rim above — a dimmer lightened band right along the sphere's
-- OWN silhouette edge, but only on the hemisphere already in shadow
-- (past the core shadow, not the lit side) — simulates ambient light
-- bouncing back onto the dark side from the surrounding scene, the same
-- way a traditionally-shaded ball still shows a touch of life along its
-- dark edge instead of going flat black there.
local COLOR_REFLECTED    = { 0.20, 0.38, 0.60 } -- cool, muted blue — brighter than colorShade, dimmer than the lit-side rim
local REFLECTED_STRENGTH = 0.8

-- Light shafts: soft sunbeams that appear to shine in from the
-- sun-facing shoreline and fan inward through the shallows, fading out
-- with "depth" (distance past the entry point, measured along the
-- sun's own direction) well before reaching the dark hemisphere.
-- Modeled as parallel stripes running ACROSS the sun's direction,
-- skewed by a small multiple of how far along the light's own travel
-- direction a pixel sits — that skew is what makes the beams fan out
-- from a point rather than staying perfectly parallel bars, closer to
-- how a real light source's rays actually spread.
local COLOR_SHAFT     = { 0.92, 0.93, 0.78 } -- soft warm near-white, reads as sunlight rather than more of the water's own blue
local SHAFT_STRENGTH  = 0.0
local SHAFT_FREQUENCY = 0.018 -- per world unit — controls how close together the beams are
local SHAFT_FAN       = 0.012 -- how much the beams skew/spread apart with depth
local SHAFT_SPEED     = 0.3   -- drift speed, same sharedTime units as the edge wave
local SHAFT_SHARPNESS = 3.0   -- higher = thinner, more defined beams with darker gaps between them
-- Sway + flicker: real light shafts don't just drift sideways as a
-- rigid pattern (all SHAFT_SPEED gives on its own) — ripples on the
-- actual water surface above refract the sunlight unevenly, so the
-- beams visibly waver in shape AND pulse in brightness over time. Sway
-- bends the beam PATH itself (a slow sideways offset that varies with
-- depth into the water); flicker is a separate, independently-timed
-- brightness pulse layered on top of the beam pattern — together
-- that's what actually reads as shimmering rather than sliding.
local SHAFT_SWAY_AMOUNT      = 45   -- world units, how far the beam path bends side to side
local SHAFT_SWAY_FREQUENCY   = 0.004 -- per world unit of depth — how quickly the sway varies along a beam's own length
local SHAFT_SWAY_SPEED       = 0.6
local SHAFT_FLICKER_STRENGTH = 0.2  -- 0 = steady brightness, 1 = flickers all the way down to fully dark at its dimmest
local SHAFT_FLICKER_FREQUENCY = 0.5
local SHAFT_FLICKER_SPEED     = 1.3

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
    extern number causticEdgeWidth;
    extern number causticWarpStrength;
    extern number causticBulge;
    extern vec3 colorCaustic;
    extern number bodyOpacity;
    extern vec2 sunDir;       // unit vector from this planet's center TOWARD the sun, world space
    extern number shadeStrength;
    extern vec3 colorShade;
    extern vec3 colorRim;
    extern number rimStrength;
    extern vec3 colorReflected;
    extern number reflectedStrength;
    extern vec3 colorShaft;
    extern number shaftStrength;
    extern number shaftFrequency;
    extern number shaftFan;
    extern number shaftSpeed;
    extern number shaftSharpness;
    extern number shaftSwayAmount;
    extern number shaftSwayFrequency;
    extern number shaftSwaySpeed;
    extern number shaftFlickerStrength;
    extern number shaftFlickerFrequency;
    extern number shaftFlickerSpeed;

    // Pseudo-random 2D hash — no built-in noise in LOVE's shader dialect,
    // so this is the standard sin/dot/fract trick: cheap, and plenty
    // random-looking for per-cell jitter/brightness at this scale.
    vec2 hash2(vec2 p) {
      p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
      return fract(sin(p) * 43758.5453123);
    }

    // Voronoi (Worley noise): scatters one random point per unit grid
    // cell, then for a query point p finds the distance to the NEAREST
    // scattered point (f1) and the SECOND nearest (f2). (f2 - f1) is
    // ~0 exactly on the boundary between two cells (both points are
    // equally close there) and grows quickly moving into either cell's
    // interior — exactly the "thin line right at the cell wall, nothing
    // in the middle" shape cracked-mud/caustic-net boundaries have.
    // cellBrightness is a second, independent random value per cell so
    // neighboring boundary lines don't all glow at the same intensity.
    vec3 voronoi(vec2 p) {
      vec2 ip = floor(p);
      vec2 fp = fract(p);
      float f1 = 8.0;
      float f2 = 8.0;
      vec2 closestCell = vec2(0.0);
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec2 neighbor = vec2(float(x), float(y));
          vec2 cellId = ip + neighbor;
          vec2 jitter = hash2(cellId);
          vec2 pointPos = neighbor + jitter - fp;
          float d = dot(pointPos, pointPos);
          if (d < f1) {
            f2 = f1;
            f1 = d;
            closestCell = cellId;
          } else if (d < f2) {
            f2 = d;
          }
        }
      }
      float cellBrightness = hash2(closestCell + 19.7).x;
      return vec3(sqrt(f1), sqrt(f2), cellBrightness);
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

      // Spherical shading is the PRIMARY color cue: bright on the
      // hemisphere facing the sun, dark on the far side. Uses a
      // PSEUDO-3D sphere normal (the flat disc treated as a ball
      // bulging toward the viewer, via nz below) rather than a flat
      // in-plane "direction from center" — an earlier version used
      // dirFromCenter = local/dist directly, which is a real 2D unit
      // vector pointing in whatever angular direction that pixel
      // happens to sit at, RIGHT UP TO the exact center. That meant
      // within just a few pixels of dead-center, every possible angle
      // (and therefore the whole dark-to-light range) was represented,
      // which is what produced the visible pinwheel/pinch seam
      // converging to a point right at the middle. Scaling the in-plane
      // component by (dist/radius) — which shrinks smoothly to 0 at the
      // center — kills that discontinuity: at dist=0 the normal is
      // simply (0,0,1), straight at the viewer, the same regardless of
      // angle, so there's nothing left to pinch.
      float nxy = clamp(dist / radius, 0.0, 1.0);
      vec2 inPlaneDir = dist > 0.0001 ? local / dist : vec2(0.0, 0.0);
      float nz = sqrt(max(0.0, 1.0 - nxy * nxy));
      vec3 normal = vec3(inPlaneDir * nxy, nz);

      // sunDir is a 2D unit vector in the picture plane; giving it a
      // mild positive Z (light coming a bit from the viewer's own side,
      // not edge-on) is what makes the lit hemisphere actually cover a
      // visible cap of the sphere instead of a razor-thin crescent.
      vec3 sunDir3 = normalize(vec3(sunDir, 0.5));
      float facing = dot(normal, sunDir3);
      float lightT = smoothstep(-0.3, 0.7, facing);
      vec3 waterColor = mix(colorShade, colorShallow, mix(1.0 - shadeStrength, 1.0, lightT));

      // A much subtler depth cue layered on top — the true center reads
      // a little deeper/darker than the shore, but only a small nudge
      // now (mixed in at 45% at most) rather than being the only cue.
      float depthT = clamp(dist / radius, 0.0, 1.0);
      waterColor = mix(colorDeep, waterColor, mix(0.55, 1.0, depthT));

      // Bright rim: a thin, lighter band right at the wavy shoreline,
      // but only on the sun-facing side — light catching the shallows.
      float rimT = smoothstep(radius * 0.6, radius, dist) * clamp(facing, 0.0, 1.0);
      waterColor = mix(waterColor, colorRim, rimT * rimStrength);

      // Reflected highlight: same edge band, but on the DARK side
      // instead — (1.0 - lightT) is ~1 only once facing has crossed
      // well past the terminator into shadow, so this only shows up
      // past the core shadow, right along the unlit hemisphere's own
      // silhouette, never bleeding into the lit side the rim above
      // already covers.
      float reflectedT = smoothstep(radius * 0.65, radius, dist) * (1.0 - lightT);
      waterColor = mix(waterColor, colorReflected, reflectedT * reflectedStrength);

      // Light shafts: parallel stripes running ACROSS the sun's own
      // direction (shaftAxis, its perpendicular), skewed by a small
      // multiple of alongLight so they fan out from the entry point
      // rather than staying perfectly parallel bars — see
      // SHAFT_STRENGTH's own comment for the full reasoning.
      // alongLight is -radius right at the sun-facing edge (where light
      // "enters") and +radius at the far edge, so shaftDepthT/shaftFade
      // below turn that into a fade that's brightest at the entry point
      // and gone well before the dark hemisphere; shaftLit keeps it off
      // the dark side entirely regardless (the same lightT-derived
      // terminator the rim/reflected-highlight above already use).
      vec2 shaftAxis = vec2(-sunDir.y, sunDir.x);
      float alongLight = dot(local, -sunDir);
      float acrossLight = dot(local, shaftAxis);

      // Sway: bends the beam path with a slow offset that varies along
      // the beam's own depth (alongLight), rather than the whole
      // pattern just sliding sideways as one rigid set of straight bars.
      float sway = sin(alongLight * shaftSwayFrequency + time * shaftSwaySpeed) * shaftSwayAmount;
      float shaftRaw = sin((acrossLight + sway) * shaftFrequency + alongLight * shaftFan + time * shaftSpeed);
      float shaftPattern = pow(clamp(shaftRaw * 0.5 + 0.5, 0.0, 1.0), shaftSharpness);

      // Flicker: an independently-timed brightness pulse layered on top
      // of the beam pattern itself — this, not the sway or the slow
      // drift above, is what actually reads as "twinkling."
      float flickerRaw = sin(acrossLight * shaftFlickerFrequency + alongLight * shaftFlickerFrequency * 1.7 + time * shaftFlickerSpeed);
      float flicker = mix(1.0, 0.5 + 0.5 * flickerRaw, shaftFlickerStrength);

      float shaftDepthT = clamp((alongLight + radius) / (radius * 1.1), 0.0, 1.0);
      float shaftFade = 1.0 - smoothstep(0.0, 0.6, shaftDepthT);
      float shaftLit = smoothstep(-0.1, 0.5, facing);
      float shaftT = shaftPattern * shaftFade * shaftLit * flicker;
      waterColor = mix(waterColor, colorShaft, shaftT * shaftStrength);

      // Caustics driven by "local" (world units relative to the
      // planet's own center) rather than screen_coords, so the pattern
      // is anchored to the water's surface and drifts smoothly with
      // time regardless of camera pan/zoom.
      //
      // Before scaling into cell-space, distance from center is
      // re-mapped from flat screen-space r to the unprojected distance
      // on a sphere bulging toward the viewer — see CAUSTIC_BULGE's own
      // comment for why (radius*asin(r/radius) instead of r itself).
      // theta approaches pi/2 right at the true edge, where bulgeDist's
      // own rate of change against r blows up (infinitely dense cells
      // exactly on the silhouette) — clamping the asin input just shy
      // of 1.0 avoids that degenerate limit; it doesn't matter visually
      // since that sliver is already fading to transparent via the edge
      // wave's own softness.
      float distRatio = clamp(dist / radius, 0.0, 0.98);
      float bulgeDist = radius * asin(distRatio);
      float sampleDist = mix(dist, bulgeDist, causticBulge);
      vec2 bulgeLocal = dist > 0.0001 ? (local / dist) * sampleDist : local;

      vec2 causticP = bulgeLocal * causticScale;
      // Domain warp: displaces the sampling point with a slow sine
      // field before it ever reaches the Voronoi lookup, so the cell
      // pattern itself seems to ripple/distort over time instead of
      // being a frozen crack pattern that only drifts in a straight
      // line.
      causticP += vec2(
        sin(causticP.y * 2.4 + time * causticSpeed),
        cos(causticP.x * 2.4 - time * causticSpeed * 0.8)
      ) * causticWarpStrength;

      vec3 vr = voronoi(causticP);
      float edgeDist = vr.y - vr.x; // ~0 right on a cell boundary, grows into either cell's interior
      // Soft, partially-transparent boundary line: peaks at the exact
      // edge, fades out over causticEdgeWidth, then causticSharpness
      // reshapes that falloff into a thinner/crisper or wider/softer
      // line without changing where it's centered.
      float edge = pow(1.0 - smoothstep(0.0, causticEdgeWidth, edgeDist), causticSharpness);
      float lineAlpha = edge * mix(0.35, 1.0, vr.z); // vr.z = this cell's own random brightness
      waterColor = mix(waterColor, colorCaustic, lineAlpha * causticStrength);

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
-- Wave shape — shared by the shader draw AND the opaque backdrop
-- polygon below, so their two edges can never drift apart. Scales the
-- wave's bulge and hump counts by this instance's own radius relative
-- to WAVE_REFERENCE_RADIUS — see that constant's own comment for why.
-- Hump counts are rounded to whole numbers (and floored at 1) rather
-- than sent as a fractional scale: both the shader and the polygon
-- sample angle over a full -pi..pi range, and a non-integer hump count
-- means sin(angle*humps) doesn't land on the same value at both ends
-- of that range — a visible seam right where the wave wraps around,
-- instead of a smoothly closed loop.
----------------------------------------------------------------------

local function computeWaveShape(self)
  local sizeScale = self.radius / WAVE_REFERENCE_RADIUS
  return {
    sizeScale = sizeScale,
    waveAmplitude = WAVE_AMPLITUDE * sizeScale,
    waveHumps = math.max(1, math.floor(WAVE_HUMPS * sizeScale + 0.5)),
    waveHumps2 = math.max(1, math.floor(WAVE_HUMPS_2 * sizeScale + 0.5)),
  }
end

-- angle: radians. Returns the true wavy edge radius at that angle, at
-- the CURRENT shared clock — same formula the shader's own "wave"
-- computation uses (see getWaterShader's effect() function), kept in
-- exact sync deliberately so the backdrop polygon below traces the
-- same silhouette the shader cuts its alpha to.
local function waveEdgeRadius(self, shape, angle)
  local wave = math.sin(angle * shape.waveHumps + sharedTime * WAVE_SPEED) * shape.waveAmplitude
             + math.sin(angle * shape.waveHumps2 - sharedTime * WAVE_SPEED * 1.6) * shape.waveAmplitude * 0.4
  return self.radius + wave
end

----------------------------------------------------------------------
-- Opaque backdrop — an ordinary filled polygon (no shader, no
-- per-pixel cost) tracing the SAME wavy silhouette as the translucent
-- shader pass below, drawn BEFORE the core/player/fish so they layer
-- normally on top of it. Exists so BODY_OPACITY on the translucent
-- pass can be turned down without making the water look "ghostly" —
-- without this, lowering that opacity let the raw starfield bleed
-- through equally in empty water and over the player/fish/core alike,
-- since there was nothing opaque underneath any of it to begin with.
-- With this backdrop in place, only the translucent shader's own
-- shading/caustics/wave detail varies with BODY_OPACITY; the water
-- never stops reading as solid.
----------------------------------------------------------------------

local BACKDROP_SEGMENTS = 96 -- angle samples around the circle — comfortably more than 2x WAVE_HUMPS_2 (19) so the polygon traces the scalloped edge smoothly instead of faceting
local BACKDROP_COLOR = { 0.10, 0.30, 0.55 } -- a plain mid-tone blue; doesn't need to match the shader's own shading exactly since that detailed pass always draws on top of this

local function drawWaterBackdrop(self)
  local shape = computeWaveShape(self)
  local points = {}
  for i = 0, BACKDROP_SEGMENTS - 1 do
    local angle = (i / BACKDROP_SEGMENTS) * math.pi * 2 - math.pi
    local r = waveEdgeRadius(self, shape, angle)
    points[#points + 1] = self.pos.x + math.cos(angle) * r
    points[#points + 1] = self.pos.y + math.sin(angle) * r
  end
  love.graphics.setColor(BACKDROP_COLOR[1], BACKDROP_COLOR[2], BACKDROP_COLOR[3], 1)
  love.graphics.polygon("fill", points)
  love.graphics.setColor(1, 1, 1, 1)
end

----------------------------------------------------------------------
-- Instance draw override
----------------------------------------------------------------------

local function drawWater(self)
  local shader = getWaterShader()
  local zoom = state.zoom or 1
  local cam = state.camera or { x = 0, y = 0 }

  local shape = computeWaveShape(self)
  local sizeScale, waveAmplitude, waveHumps, waveHumps2 =
    shape.sizeScale, shape.waveAmplitude, shape.waveHumps, shape.waveHumps2

  -- CAUSTIC_SCALE (cell frequency per world unit) is tuned against
  -- WAVE_REFERENCE_RADIUS, same as the wave numbers above — inverted,
  -- though: a SMALLER water body needs a HIGHER frequency (bigger
  -- causticScale) so its caustic cells stay the same size RELATIVE to
  -- its own radius, instead of every instance getting the exact same
  -- absolute world-unit cell size regardless of how big it actually is.
  -- At self.radius == WAVE_REFERENCE_RADIUS this reduces to exactly
  -- CAUSTIC_SCALE unchanged (the size the pattern was tuned to look
  -- best at).
  local causticScale = CAUSTIC_SCALE / sizeScale

  -- Padded bounding box so the wave's own crest (which pokes outward
  -- past self.radius) never gets clipped by the rectangle it's drawn
  -- into.
  local pad = waveAmplitude + EDGE_SOFTNESS + 2
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
  shader:send("waveAmplitude", waveAmplitude)
  shader:send("waveHumps", waveHumps)
  shader:send("waveHumps2", waveHumps2)
  shader:send("waveSpeed", WAVE_SPEED)
  shader:send("edgeSoftness", EDGE_SOFTNESS)
  shader:send("colorDeep", COLOR_DEEP)
  shader:send("colorShallow", COLOR_SHALLOW)
  shader:send("causticStrength", CAUSTIC_STRENGTH)
  shader:send("causticScale", causticScale)
  shader:send("causticSpeed", CAUSTIC_SPEED)
  shader:send("causticSharpness", CAUSTIC_SHARPNESS)
  shader:send("causticEdgeWidth", CAUSTIC_EDGE_WIDTH)
  shader:send("causticWarpStrength", CAUSTIC_WARP_STRENGTH)
  shader:send("causticBulge", CAUSTIC_BULGE)
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
  shader:send("colorRim", COLOR_RIM)
  shader:send("rimStrength", RIM_STRENGTH)
  shader:send("colorReflected", COLOR_REFLECTED)
  shader:send("reflectedStrength", REFLECTED_STRENGTH)
  shader:send("colorShaft", COLOR_SHAFT)
  shader:send("shaftStrength", SHAFT_STRENGTH)
  shader:send("shaftFrequency", SHAFT_FREQUENCY)
  shader:send("shaftFan", SHAFT_FAN)
  shader:send("shaftSpeed", SHAFT_SPEED)
  shader:send("shaftSharpness", SHAFT_SHARPNESS)
  shader:send("shaftSwayAmount", SHAFT_SWAY_AMOUNT)
  shader:send("shaftSwayFrequency", SHAFT_SWAY_FREQUENCY)
  shader:send("shaftSwaySpeed", SHAFT_SWAY_SPEED)
  shader:send("shaftFlickerStrength", SHAFT_FLICKER_STRENGTH)
  shader:send("shaftFlickerFrequency", SHAFT_FLICKER_FREQUENCY)
  shader:send("shaftFlickerSpeed", SHAFT_FLICKER_SPEED)

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
  -- Called separately, once, BEFORE the core/player/fish draw — see
  -- drawWaterBackdrop's own comment for why this needs to be its own
  -- draw call rather than folded into :draw() (which runs a second
  -- time, AFTER them, for the translucent overlay).
  planet.drawBackdrop = drawWaterBackdrop

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

  -- Lets code that only holds a reference to the SHELL (e.g. a Fish
  -- that lands in a water body other than the one it launched from,
  -- see Fish.lua's own updateJump) find its matching core without
  -- needing a separate lookup table — there's no other way to get from
  -- one to the other otherwise, since core itself carries no
  -- isWaterPlanet flag or back-reference of its own.
  planet.core = core

  return planet, core
end

return WaterPlanet
