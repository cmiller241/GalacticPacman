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
local CORE_EDGE_BLUR      = 50     -- px of soft fade at the core's edge
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

-- Same bulge/pinch recipe SkyDomePlanetoid uses on its foreground hex
-- grid (see lua/world/SkyDomePlanetoid.lua's getBulgeShader) — pulls
-- the noise-sampling coordinate toward the center before it's used, so
-- the flat granulation reads as if it's wrapped around a sphere rather
-- than painted on a flat disc. Applied to the coordinate itself here
-- (there's no baked texture to warp the lookup of — the plasma is
-- generated directly from the coordinate), so both the granulation and
-- the sunspots inherit the same curvature automatically.
local PLASMA_BULGE_STRENGTH = 0.6
local PLASMA_BULGE_RADIUS   = 2.0

-- Shifted more yellow (higher green relative to red) and brighter
-- across the board than a "realistic" sun ramp would be — deliberately
-- more yellow, not fully yellow: DARK/MID stay orange-red-leaning so
-- there's still contrast, HOT leans distinctly yellow rather than
-- yellow-white.
local PLASMA_COLOR_DARK   = {0.55, 0.18, 0.02} -- intergranular lanes / coolest
local PLASMA_COLOR_MID    = {1.0, 0.45, 0.08}  -- orange-red
local PLASMA_COLOR_WARM   = {1.0, 0.72, 0.22}  -- orange-yellow
local PLASMA_COLOR_HOT    = {1.0, 0.92, 0.35}  -- brightest granules, distinctly yellow
-- Extra multiplier on top of the pulse's own brightness swing — makes
-- the core disc read as noticeably brighter than the surrounding glow,
-- rather than matching its intensity.
local CORE_BRIGHTNESS     = 1.2

local SPOT_SCALE          = 0.6    -- spatial frequency of the sunspot pattern
local SPOT_THRESHOLD      = 0.2   -- how much of the pattern becomes a spot (higher = fewer spots)
local SPOT_SOFTNESS       = 0.10   -- edge softness of each spot
local SPOT_DARKEN         = 0.9   -- how dark a spot gets (0 = black, 1 = no darkening)
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
    extern number time;
    extern number brightness;
    extern number plasmaScale;
    extern number detailScale;
    extern number evolveSpeed;
    extern number scrollSpeed;
    extern number bulgeStrength;
    extern number bulgeRadius;
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
      vec2 uv = (screen_coords - center) / radius;
      uv.x += time * scrollSpeed;

      // Bulge/pinch toward the center, same recipe (and reasoning) as
      // SkyDomePlanetoid's foreground hex-grid warp — pulls this
      // coordinate inward more as it approaches bulgeRadius, so the
      // flat noise field below reads as if it's wrapped around a
      // sphere rather than painted on a flat disc. Applied once, here,
      // so granulation AND sunspots both inherit the same curvature.
      float bd = length(uv);
      if (bd < bulgeRadius && bd > 0.0001) {
        float bt = 1.0 - (bd / bulgeRadius);
        bt = bt * bt * (3.0 - 2.0 * bt);
        uv /= (1.0 + bulgeStrength * bt);
      }

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
      vec3 col = mix(colorDark, colorMid, smoothstep(0.15, 0.45, v));
      col = mix(col, colorWarm, smoothstep(0.4, 0.7, v));
      col = mix(col, colorHot, smoothstep(0.68, 0.95, v));

      // Sunspots — a coarser, independently-evolving fbm built on the
      // same bulged/scrolled uv, so they rotate and curve coherently
      // with the granulation instead of drifting separately from it.
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

  self.pulseTime = self.pulseTime + scaledDt * PULSE_SPEED
  self.plasmaTime = self.plasmaTime + scaledDt
end

function Sun:draw()
  local x, y = self.pos.x, self.pos.y

  -- Smooth pulse value between -1 and 1
  local pulse = math.sin(self.pulseTime)
  local radiusScale = 1 + pulse * PULSE_AMOUNT
  local intensityScale = 1 + pulse * PULSE_INTENSITY

  local r = self.radius * radiusScale
  local intensity = SUN_INTENSITY * intensityScale

  -- Soft corona
  love.graphics.setColor(1.0, 0.35, 0.05, 0.22 * intensity)
  love.graphics.draw(sunMesh, x, y, 0, r * 2.1, r * 2.1)

  -- Mid glow
  love.graphics.setColor(1.0, 0.55, 0.12, 0.35 * intensity)
  love.graphics.draw(sunMesh, x, y, 0, r * 1.35, r * 1.35)

  -- Flat core disc — a solid circle (CORE_DIAMETER px across) painted by
  -- the plasma shader, not another stacked gradient. Only the outer
  -- CORE_EDGE_BLUR px actually fade, via the ring mesh on top of the
  -- solid fill; the two share CORE_INNER_FRAC so they always meet with
  -- no seam. Pulses in size with the rest of the sun (coreR) and
  -- brightens slightly at the pulse peak, on top of its own flat
  -- CORE_BRIGHTNESS boost so it reads brighter than the surrounding glow.
  local coreR = CORE_RADIUS * radiusScale

  local zoom = state.zoom or 1
  local cam = state.camera or { x = 0, y = 0 }

  love.graphics.setShader(plasmaShader)
  plasmaShader:send("center", { (x - cam.x) * zoom, (y - cam.y) * zoom })
  plasmaShader:send("radius", coreR * zoom)
  plasmaShader:send("time", self.plasmaTime)
  plasmaShader:send("brightness", intensityScale * CORE_BRIGHTNESS)
  plasmaShader:send("plasmaScale", PLASMA_SCALE)
  plasmaShader:send("detailScale", PLASMA_DETAIL_SCALE)
  plasmaShader:send("evolveSpeed", PLASMA_EVOLVE_SPEED)
  plasmaShader:send("scrollSpeed", PLASMA_SCROLL_SPEED)
  plasmaShader:send("bulgeStrength", PLASMA_BULGE_STRENGTH)
  plasmaShader:send("bulgeRadius", PLASMA_BULGE_RADIUS)
  plasmaShader:send("colorDark", PLASMA_COLOR_DARK)
  plasmaShader:send("colorMid", PLASMA_COLOR_MID)
  plasmaShader:send("colorWarm", PLASMA_COLOR_WARM)
  plasmaShader:send("colorHot", PLASMA_COLOR_HOT)
  plasmaShader:send("spotScale", SPOT_SCALE)
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
