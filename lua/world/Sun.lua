-- lua/world/Sun.lua
--
-- Visual sun at the centre of the scene.
-- Smooth radial gradient glow + a flat-filled core disc textured with a
-- plasma shader: layered fractal noise forms a mottled, granular
-- surface (colored by a fixed warm brightness ramp, not a hue-cycling
-- palette) with darker sunspot blotches, all scrolling together to
-- fake axial rotation. Both the glow and the core pulse.
-- No gravity, no collision.

local state = require("lua.state")

local Sun = {}
Sun.__index = Sun

----------------------------------------------------------------------
-- TUNABLES
----------------------------------------------------------------------
local RADIUS              = 800

-- Flat-filled core disc — a solid circle, only blurred/faded right at
-- its own rim, sitting inside the existing gradient glow rather than
-- being built out of stacked gradients itself. Its fill is painted by
-- the plasma shader below rather than a flat color.
local CORE_DIAMETER       = 3500
local CORE_RADIUS         = CORE_DIAMETER / 2
-- A fraction of CORE_RADIUS rather than a fixed pixel count — a flat
-- 50px band used to be only ~1.4% of the core's own diameter, so almost
-- the entire disc was flat-edged texture right up until a razor-thin
-- fade kicked in, reading as a mottled circle pasted onto the glow
-- behind it rather than one continuous object. Wider lets the
-- granulated surface actually dissolve into the corona.
local CORE_EDGE_BLUR_FRAC = 0.16
local CORE_EDGE_BLUR      = CORE_RADIUS * CORE_EDGE_BLUR_FRAC  -- px of soft fade at the core's edge
-- Fraction of the core's own radius that stays fully solid before the
-- blur ring takes over — shared by both the solid disc draw and the
-- ring-fade mesh's own baked geometry so the two always meet exactly,
-- at any pulse phase, with no seam or gap.
local CORE_INNER_FRAC     = 1 - CORE_EDGE_BLUR / CORE_RADIUS

local SUN_INTENSITY       = 16.0

-- Pulse
local PULSE_SPEED         = 3    -- how fast it breathes (higher = faster)
local PULSE_AMOUNT        = 0.045   -- how much the size changes (0.04 = ±4%)
local PULSE_INTENSITY     = 0.12    -- how much the brightness pulses

-- Plasma shader on the core — layered fractal noise (fbm) forming an
-- actual granular, mottled surface (like solar granulation) rather
-- than smooth sine-wave blobs, colored by a small fixed warm ramp
-- (dark red -> orange -> yellow-white) driven by the noise's own
-- brightness instead of a hue-cycling palette — reads as texture
-- variation, not a rainbow strobe, and always stays warm. Granulation
-- AND sunspots share the same horizontal scroll, so the whole surface
-- drifts together — with real texture to track, that's what makes the
-- rotation actually read.
local PLASMA_SCALE         = 7.0    -- spatial frequency of the granulation (higher = smaller cells)
local PLASMA_DETAIL_SCALE  = 2.4    -- extra frequency multiplier for the fine speckle pass
local PLASMA_EVOLVE_SPEED  = 0.05   -- how fast the granulation itself boils/changes shape in place
local PLASMA_SCROLL_SPEED  = -0.12  -- pattern drift speed (negative = drifts left = rotation)

-- self.plasmaTime feeds the shader's noise functions (several fbm/hash
-- octaves deep) as a raw, ever-growing elapsed-seconds value. GPU
-- shaders use 32-bit floats, and once that value climbs into the
-- thousands, its own per-frame increment becomes smaller than what a
-- float32 can represent at that magnitude — the noise starts sampling
-- the wrong grid cells / jittering instead of advancing smoothly,
-- which is what actually caused the granulation's apparent scroll
-- direction to visibly wobble, worse the longer a session ran (directly
-- confirmed: forcing plasmaTime to 6000 at startup made the surface go
-- haywire immediately). Sun:update() wraps plasmaTime with math.fmod
-- every PLASMA_TIME_WRAP seconds so it never climbs anywhere near that
-- danger zone — chosen with a big safety margin below the confirmed-bad
-- 6000 mark. This isn't a perfectly seamless loop (the underlying hash
-- noise isn't periodic, so the instant it wraps, the granulation's exact
-- blob arrangement re-shuffles to a different-but-similar-looking one
-- rather than continuing the same configuration) — but a once-every-few-
-- minutes instant reshuffle of a mottled noise pattern is far less
-- objectionable than a continuously growing, increasingly "silly"-
-- looking swing, and in practice reads as unnoticeable during normal
-- play.
local PLASMA_TIME_WRAP     = 300

-- Red-dominant body: DARK/MID (deep, saturated red-orange) cover most
-- of the disc, WARM is a rarer transition tone, and HOT (yellow) is
-- reserved for genuine noise peaks in the body — see
-- createPlasmaShader's own ramp thresholds below. HOT doubles as the
-- color the shader's rim-glow blend pulls toward near the disc's true
-- edge (see that shader's own rimT), so it stays a clean, distinct
-- yellow rather than something washed-out.
local PLASMA_COLOR_DARK   = {0.48, 0.12, 0.02} -- intergranular lanes / coolest, deep red
local PLASMA_COLOR_MID    = {1.0, 0.32, 0.05}  -- saturated red-orange — the base tone across most of the body
local PLASMA_COLOR_WARM   = {1.0, 0.60, 0.15}  -- orange, transition tone
local PLASMA_COLOR_HOT    = {1.0, 0.90, 0.35}  -- yellow — rare in the noise-driven body, but the dedicated rim-glow color
-- Extra multiplier on top of the pulse's own brightness swing — makes
-- the core disc read as noticeably brighter than the surrounding glow,
-- rather than matching its intensity.
local CORE_BRIGHTNESS     = 1.2

local SPOT_SCALE          = 0.6    -- spatial frequency of the sunspot pattern
local SPOT_THRESHOLD      = 0.2   -- how much of the pattern becomes a spot (higher = fewer spots)
local SPOT_SOFTNESS       = 0.10   -- edge softness of each spot
local SPOT_DARKEN         = 0.9   -- how dark a spot gets (0 = black, 1 = no darkening)

-- The plasma shader's own spatial frequencies (PLASMA_SCALE etc.) are
-- tuned for the sun appearing at roughly this on-screen radius (px, post
-- zoom). uv is normalized by the core's own radius (see the shader's own
-- `uv = (screen_coords - center) / radius`), so the NUMBER of noise
-- cells across the disc stays constant regardless of zoom — meaning at
-- a small on-screen size, the same cell count gets crammed into far
-- fewer actual pixels with no mip-mapping to soften it, reading as
-- aliased static rather than granulation. Sun:draw() scales the
-- frequencies sent to the shader down when the sun is smaller on screen
-- than this, so cells stay roughly a constant SCREEN size instead of a
-- constant count.
local PLASMA_REFERENCE_SCREEN_RADIUS = 500
local PLASMA_MIN_SCALE_FACTOR        = 0.15  -- never fully flatten out at extreme distance — keeps a little texture visible rather than a sudden pop to flat color
----------------------------------------------------------------------

local function createSunGradientMesh(segments)
  segments = segments or 64
  local vertices = {
    {0, 0, 0.5, 0.5, 1, 1, 1, 1},
  }
  for i = 0, segments do
    local angle = (i / segments) * math.pi * 2
    local x = math.cos(angle)
    local y = math.sin(angle)
    table.insert(vertices, {x, y, 0.5 + x*0.5, 0.5 + y*0.5, 1, 1, 1, 0})
  end
  return love.graphics.newMesh(vertices, "fan", "static")
end

-- A thin RING (not a center-to-edge gradient) going from fully opaque at
-- innerFrac*radius to fully transparent at radius — drawn on top of a
-- flat-filled circle of radius innerFrac*radius so the disc itself stays
-- a uniform flat color and only its outer rim actually fades. Built as
-- a triangle strip of alternating inner(alpha=1)/outer(alpha=0) vertex
-- pairs, the standard technique for a radial ring gradient.
local function createRingFadeMesh(innerFrac, segments)
  segments = segments or 96
  local vertices = {}
  for i = 0, segments do
    local angle = (i / segments) * math.pi * 2
    local cx, cy = math.cos(angle), math.sin(angle)
    local ix, iy = cx * innerFrac, cy * innerFrac
    table.insert(vertices, {ix, iy, 0.5 + ix*0.5, 0.5 + iy*0.5, 1, 1, 1, 1})
    table.insert(vertices, {cx, cy, 0.5 + cx*0.5, 0.5 + cy*0.5, 1, 1, 1, 0})
  end
  return love.graphics.newMesh(vertices, "strip", "static")
end

-- Uses screen_coords + a center/radius uniform for its local disc
-- coordinate, NOT texture_coords — love.graphics.circle("fill", ...)
-- doesn't give a pixel shader meaningful per-pixel texture_coords
-- across its interior (it only actually varies for shapes/meshes that
-- explicitly bake real UVs, like coreRingMesh above), so a first
-- attempt using texture_coords rendered the solid disc as one constant
-- flat color while only the ring — which DOES carry real per-vertex
-- UVs — showed any pattern. screen_coords is a genuine per-fragment
-- value regardless of what primitive is being drawn, so it works for
-- both the solid fill and the ring mesh alike; dividing by radius
-- (already scaled by zoom, same recipe as SkyDomePlanetoid's shaders)
-- keeps the pattern's on-screen density constant across zoom levels.
-- Multiplying the final color by the incoming `color` (vertex color *
-- current draw color) is what lets this same shader paint BOTH the
-- solid inner fill (opaque) AND the outer ring mesh (whose baked
-- per-vertex alpha fades to 0) without needing to know which one it's
-- on — it just inherits whatever alpha it's handed.
local function createPlasmaShader()
  return love.graphics.newShader([[
    extern vec2 center;
    extern number radius;
    extern number baseRadius;
    extern number time;
    extern number brightness;
    extern number plasmaScale;
    extern number detailScale;
    extern number evolveSpeed;
    extern number scrollSpeed;
    extern vec3 colorDark;
    extern vec3 colorMid;
    extern vec3 colorWarm;
    extern vec3 colorHot;
    extern number spotScale;
    extern number spotThreshold;
    extern number spotSoftness;
    extern number spotDarken;

    // Cheap scramble hash (Dave Hoskins-style) — good enough for visual
    // noise, not meant to be cryptographic.
    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    // Standard bilinear value noise, smoothed with a Hermite curve so
    // the grid it's sampled from doesn't show through as hard facets.
    float valueNoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      float a = hash(i);
      float b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0));
      float d = hash(i + vec2(1.0, 1.0));
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }

    // Fractal Brownian motion — several octaves of the noise above,
    // each finer and dimmer than the last, summed into the mottled,
    // multi-scale texture actual solar granulation has (as opposed to
    // a single smooth sine blob).
    float fbm(vec2 p) {
      float value = 0.0;
      float amp = 0.5;
      for (int i = 0; i < 5; i++) {
        value += amp * valueNoise(p);
        p *= 2.02;
        amp *= 0.55;
      }
      return value;
    }

    vec4 effect(vec4 color, Image tex, vec2 texture_coords, vec2 screen_coords) {
      // Un-warped radial distance (0 at center, 1 at the disc's true
      // edge), normalized against the TRUE pulsing on-screen radius —
      // the rim glow (see rimT near the bottom) needs to track the
      // actual edge as it breathes in and out.
      vec2 rawUV = (screen_coords - center) / radius;
      float rd = length(rawUV);

      // The noise-sampling coordinate (baseCoord/uv below), by contrast,
      // is normalized against baseRadius — a STABLE reference size that
      // does NOT pulse — rather than reusing rawUV above. Dividing by
      // the true pulsing `radius` here previously rescaled the whole
      // noise field in and out every pulse cycle (radius shrinking made
      // the same screen point sample further out in uv-space and vice
      // versa), which combined with the steady scroll below to look
      // like the pattern rhythmically lurching forward then sliding
      // back instead of drifting smoothly in one direction. Using a
      // fixed baseRadius decouples "the disc's on-screen size
      // breathing" from "where the granulation pattern sits," so only
      // the scroll term still moves it, steadily.

      // No bulge/pinch warp here (removed) — it was the actual source of
      // the granulation appearing to swing back and forth more and more
      // over a session (see git history / prior comment here for the
      // full mechanism: it measured "distance from center" from a
      // coordinate that already had the ever-growing scroll offset baked
      // in, so the warp zone drifted away from the sun's true center the
      // longer a session ran). A version measuring that distance from a
      // stable, un-scrolled coordinate instead fixed the drift, but the
      // warp itself turned out not to be worth keeping either way.
      vec2 uv = (screen_coords - center) / baseRadius;
      uv.x += time * scrollSpeed;

      // Fine granulation — evolves slowly in place so the surface also
      // gently boils rather than just sliding.
      vec2 gp = uv * plasmaScale + vec2(time * evolveSpeed, time * evolveSpeed * 0.6);
      float grain = fbm(gp);

      // A second, higher-frequency pass layers finer speckle on top.
      float speck = fbm(gp * detailScale + 7.3);
      float v = clamp(grain * 0.7 + speck * 0.3, 0.0, 1.0);

      // Fixed warm brightness ramp — dark red -> orange-red -> orange
      // -> yellow-white — driven purely by the noise's own value, never
      // by time, so the surface reads as texture, not a color-cycling
      // strobe. Only ever warm hues, and it never changes globally.
      // DARK/MID (red) cover most of the v range here on purpose — HOT
      // (yellow) is meant to stay rare in the body, showing up only at
      // genuine noise peaks; the rim glow below is what actually makes
      // the disc's edge read as yellow, not this ramp.
      vec3 col = mix(colorDark, colorMid, smoothstep(0.15, 0.45, v));
      col = mix(col, colorWarm, smoothstep(0.45, 0.72, v));
      col = mix(col, colorHot, smoothstep(0.72, 0.95, v));

      // Yellow rim glow — blends toward colorHot (fully, at rd=1 — no
      // partial-opacity cap here) as rd approaches the disc's true edge,
      // starting a bit under halfway in (rd=0.55). The extra pow(..,
      // 0.55) below biases the ramp to reach strong yellow well before
      // the true edge, rather than only the last sliver of it, so the
      // band reads as solidly yellow rather than a thin gradient. This
      // is what actually reads as "a yellow inner glow band," independent
      // of the noise ramp above — the body stays red/orange-dominant,
      // only the outer ring of the disc itself pulls toward yellow.
      float rimT = smoothstep(0.55, 1.0, rd);
      rimT = pow(rimT, 0.55);
      col = mix(col, colorHot, rimT);

      // Sunspots — a coarser, independently-evolving fbm built on the
      // same scrolled uv, so they drift together with the granulation
      // instead of sliding separately from it.
      vec2 sp = uv * spotScale + vec2(time * evolveSpeed * 0.3, 0.0);
      float spotV = fbm(sp);
      float spotMask = smoothstep(spotThreshold - spotSoftness, spotThreshold + spotSoftness, spotV);
      col *= mix(1.0, spotDarken, spotMask);

      col *= brightness;

      return vec4(col, 1.0) * color;
    }
  ]])
end

local sunMesh = nil
local coreRingMesh = nil
local plasmaShader = nil

function Sun.new(x, y, radius)
  local self = setmetatable({}, Sun)
  self.pos = { x = x, y = y }
  self.radius = radius or RADIUS
  self.pulseTime = 0
  self.plasmaTime = 0

  if not sunMesh then
    sunMesh = createSunGradientMesh(80)
  end
  if not coreRingMesh then
    coreRingMesh = createRingFadeMesh(CORE_INNER_FRAC, 96)
  end
  if not plasmaShader then
    plasmaShader = createPlasmaShader()
  end

  return self
end

function Sun:update()
  -- state.timeScale now already includes real elapsed time (normalized to
  -- a 60fps baseline) as well as the VATS slow-mo multiplier — dividing
  -- back out the baseline recovers real seconds, same as this used to get
  -- from `dt * timeScale` when timeScale was VATS-only. Kept as its own
  -- local rather than switched to reading state.timeScale directly at each
  -- use site so PULSE_SPEED's tuning (real seconds/cycle) stays meaningful.
  local scaledDt = (state.timeScale or 1) / 60

  -- Wrapped with math.fmod rather than left to grow for the Sun's whole
  -- lifetime — see PLASMA_TIME_WRAP's own comment below for why this is
  -- load-bearing, not just tidiness.
  self.pulseTime = math.fmod(self.pulseTime + scaledDt * PULSE_SPEED, math.pi * 2)
  self.plasmaTime = math.fmod(self.plasmaTime + scaledDt, PLASMA_TIME_WRAP)
end

function Sun:draw()
  local x, y = self.pos.x, self.pos.y

  -- Smooth pulse value between -1 and 1
  local pulse = math.sin(self.pulseTime)
  local radiusScale = 1 + pulse * PULSE_AMOUNT
  local intensityScale = 1 + pulse * PULSE_INTENSITY

  local r = self.radius * radiusScale
  local intensity = SUN_INTENSITY * intensityScale

  -- Soft outer corona — deep, saturated red, wide and faint.
  love.graphics.setColor(1.0, 0.18, 0.02, 0.22 * intensity)
  love.graphics.draw(sunMesh, x, y, 0, r * 2.1, r * 2.1)

  -- Mid glow — denser and more saturated red-orange than the outer haze,
  -- so the glow reads as a distinct vivid band instead of one smooth
  -- fade straight from core color to background.
  love.graphics.setColor(1.0, 0.30, 0.04, 0.40 * intensity)
  love.graphics.draw(sunMesh, x, y, 0, r * 1.55, r * 1.55)

  -- Inner glow — tighter still, warming toward the core's own yellow,
  -- and more opaque than either layer outside it. Gives a visible
  -- saturated red/orange ring right around the disc, between it and the
  -- softer glow further out, rather than the core just blending
  -- straight into one gradient.
  love.graphics.setColor(1.0, 0.42, 0.07, 0.55 * intensity)
  love.graphics.draw(sunMesh, x, y, 0, r * 1.15, r * 1.15)

  local coreR = CORE_RADIUS * radiusScale
  local zoom = state.zoom or 1
  local cam = state.camera or { x = 0, y = 0 }

  -- Flat core disc — a solid circle (CORE_DIAMETER px across) painted by
  -- the plasma shader, not another stacked gradient. Only the outer
  -- CORE_EDGE_BLUR px actually fade, via the ring mesh on top of the
  -- solid fill; the two share CORE_INNER_FRAC so they always meet with
  -- no seam. Pulses in size with the rest of the sun (coreR) and
  -- brightens slightly at the pulse peak, on top of its own flat
  -- CORE_BRIGHTNESS boost so it reads brighter than the surrounding glow.
  love.graphics.setShader(plasmaShader)
  plasmaShader:send("center", { (x - cam.x) * zoom, (y - cam.y) * zoom })
  plasmaShader:send("radius", coreR * zoom)
  -- Stable, non-pulsing counterpart to "radius" above — see the
  -- shader's own comment on baseRadius for why the noise pattern needs
  -- this instead of the true (breathing) radius to avoid a rhythmic
  -- forward/back wobble synced to the pulse.
  plasmaShader:send("baseRadius", CORE_RADIUS * zoom)
  plasmaShader:send("time", self.plasmaTime)
  plasmaShader:send("brightness", intensityScale * CORE_BRIGHTNESS)

  -- Scales the noise frequencies down when the sun's on-screen size is
  -- smaller than PLASMA_REFERENCE_SCREEN_RADIUS — see that constant's
  -- own comment above for why (keeps the granulation from aliasing into
  -- visual static once its cell count is packed into too few screen
  -- pixels at low zoom / far camera distance).
  --
  -- Uses CORE_RADIUS (stable), NOT coreR (the pulsing one) — coreR here
  -- previously made sizeFactor, and therefore plasmaScale/spotScale
  -- below, breathe in sync with the pulse every cycle. Since that
  -- frequency multiplies directly against the already-scrolled uv
  -- coordinate, a small RELATIVE wobble in frequency produced a growing
  -- ABSOLUTE positional swing the further the scroll had already
  -- drifted — this was the actual, precisely pulse-synced cause of the
  -- granulation appearing to lurch backward on every pulse, worse over
  -- time as the scroll term it was multiplying against grew. Matching
  -- baseRadius's own stability here removes that coupling entirely.
  local screenRadius = math.max(1, CORE_RADIUS * zoom)
  local sizeFactor = math.max(PLASMA_MIN_SCALE_FACTOR, math.min(1, screenRadius / PLASMA_REFERENCE_SCREEN_RADIUS))
  plasmaShader:send("plasmaScale", PLASMA_SCALE * sizeFactor)
  plasmaShader:send("detailScale", PLASMA_DETAIL_SCALE)
  plasmaShader:send("evolveSpeed", PLASMA_EVOLVE_SPEED)
  plasmaShader:send("scrollSpeed", PLASMA_SCROLL_SPEED)
  plasmaShader:send("colorDark", PLASMA_COLOR_DARK)
  plasmaShader:send("colorMid", PLASMA_COLOR_MID)
  plasmaShader:send("colorWarm", PLASMA_COLOR_WARM)
  plasmaShader:send("colorHot", PLASMA_COLOR_HOT)
  plasmaShader:send("spotScale", SPOT_SCALE * math.max(sizeFactor, 0.5))
  plasmaShader:send("spotThreshold", SPOT_THRESHOLD)
  plasmaShader:send("spotSoftness", SPOT_SOFTNESS)
  plasmaShader:send("spotDarken", SPOT_DARKEN)

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.circle("fill", x, y, coreR * CORE_INNER_FRAC)
  love.graphics.draw(coreRingMesh, x, y, 0, coreR, coreR)

  love.graphics.setShader()
  love.graphics.setColor(1, 1, 1, 1)
end

return Sun
