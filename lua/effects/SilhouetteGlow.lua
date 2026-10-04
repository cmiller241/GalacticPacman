-- lua/effects/SilhouetteGlow.lua
--
-- A shader-drawn glow that hugs a drawable thing's own ACTUAL silhouette
-- (its real rendered shape — limbs, helmet, whatever — not just a plain
-- circle centered on it). Built in two passes: first renders the
-- subject into a small offscreen canvas
-- (capturing its exact alpha shape, at the same world position/zoom it
-- would normally draw at), then draws that canvas back through a
-- dilate-and-fade shader — sampling several rings of nearby pixels and
-- taking the nearest silhouette hit — tinted a single color, UNDER
-- wherever the caller draws the real thing afterward.
--
-- Currently used by Player.lua for the "standing near a Beam.lua
-- teleporter" highlight (see Player:draw) — kept generic (takes a plain
-- draw callback, not anything Player-specific) in case something else
-- ever wants the same "glow around my real shape" treatment.

local state = require("lua.state")

local SilhouetteGlow = {}

local shader = nil
local function getShader()
  if shader then return shader end
  shader = love.graphics.newShader([[
    extern vec2 texelSize;     // 1/canvas width, 1/canvas height
    extern number glowRadiusPx; // how far the glow reaches past the silhouette, SCREEN pixels
    extern vec3 glowColor;
    extern number strength;    // 0..1 overall max alpha

    // Cheap deterministic pseudo-random hash — used below to jitter each
    // pixel's own sample ring radii/angles by a different tiny amount,
    // so the finite set of sample rings don't line up into visible hard
    // bands (see the big comment below).
    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    vec4 effect(vec4 color, Image tex, vec2 texture_coords, vec2 screen_coords) {
      float originalAlpha = Texel(tex, texture_coords).a;

      // How close is the nearest opaque (silhouette) texel — not a true
      // blur, just several rings of samples at increasing radius, each
      // contributing a smoothstep falloff based on ITS OWN exact radius
      // (not a per-ring index), so the falloff curve itself is
      // continuous. Any finite ring count still technically quantizes
      // WHERE the samples land, though — without jitter, that showed up
      // as visible hard bands (adjacent pixels landing in the same ring
      // all getting the exact same falloff value). Offsetting every
      // pixel's own ring radii/angle by a per-pixel pseudo-random amount
      // (angleJitter/radiusJitter below) scatters that quantization into
      // fine high-frequency noise instead of a few coherent rings —
      // noise reads as a smooth, slightly grainy glow; coherent bands
      // read as stripes.
      float angleJitter = hash(screen_coords) * 6.28318530718;
      float radiusJitter = hash(screen_coords * 1.37);

      float best = 0.0;
      const int RINGS = 8;
      const int SAMPLES = 14;
      for (int r = 1; r <= RINGS; r++) {
        float ringT = (float(r) - radiusJitter) / float(RINGS);
        float radius = glowRadiusPx * ringT;
        float falloff = 1.0 - smoothstep(0.0, glowRadiusPx, radius);
        for (int s = 0; s < SAMPLES; s++) {
          float angle = (float(s) / float(SAMPLES)) * 6.28318530718 + angleJitter;
          vec2 offset = vec2(cos(angle), sin(angle)) * radius;
          float a = Texel(tex, texture_coords + offset * texelSize).a;
          best = max(best, a * falloff);
        }
      }

      // Only visible OUTSIDE the real silhouette — inside it, the real
      // (fully opaque) sprite draws on top afterward anyway, but this
      // keeps the glow pass itself from tinting him.
      float glowAlpha = best * strength * (1.0 - originalAlpha);
      return vec4(glowColor, glowAlpha) * color;
    }
  ]])
  return shader
end

local cachedCanvas = nil
local function getCanvas(size)
  if cachedCanvas and cachedCanvas:getWidth() >= size and cachedCanvas:getHeight() >= size then
    return cachedCanvas
  end
  cachedCanvas = love.graphics.newCanvas(size, size)
  return cachedCanvas
end

-- worldX, worldY: the subject's own world-space anchor — drawFn is
-- responsible for drawing itself relative to this exactly as it
-- normally would in the main scene (same "reads its own self.pos"
-- convention every other draw() in this codebase already follows).
-- boundWorldRadius: a generous upper bound on how far the subject's own
-- silhouette can reach from worldX/worldY (include limbs/extremities —
-- better to pad too much than clip something). glowWorldRadius: how far
-- PAST that silhouette the glow itself reaches. color: {r,g,b} 0..1.
-- strength: 0..1 overall intensity (this already no-ops at/below 0, so
-- callers don't need to skip the call themselves). drawFn: zero-arg
-- function that draws the subject.
function SilhouetteGlow.draw(worldX, worldY, boundWorldRadius, glowWorldRadius, color, strength, drawFn)
  if not strength or strength <= 0 then return end
  local zoom = state.zoom or 1
  local cam = state.camera or { x = 0, y = 0 }

  local halfPx = math.ceil((boundWorldRadius + glowWorldRadius) * zoom)
  if halfPx < 2 then return end
  local size = halfPx * 2

  local maskCanvas = getCanvas(size)

  -- Pass 1: render the subject's real silhouette into the (cleared)
  -- canvas, centered in it, at the SAME zoom the main scene uses so
  -- proportions match — love.graphics.origin() here resets to identity
  -- rather than inheriting the ambient camera transform already active
  -- when this is called (mid-scene-draw), and the push/pop around it
  -- restores that camera transform afterward for everything that
  -- follows, this function's own pass 2 included.
  local prevCanvas = love.graphics.getCanvas()
  love.graphics.push()
  love.graphics.setCanvas(maskCanvas)
  love.graphics.clear(0, 0, 0, 0)
  love.graphics.origin()
  love.graphics.translate(halfPx, halfPx)
  love.graphics.scale(zoom, zoom)
  love.graphics.translate(-worldX, -worldY)
  drawFn()
  love.graphics.setCanvas(prevCanvas)
  love.graphics.pop()

  -- Pass 2: composite that canvas back at the subject's own current
  -- screen position through the dilate/fade shader above — also at
  -- identity transform, since the canvas is already rendered in final
  -- screen-pixel space (no further camera scaling needed, just a plain
  -- pixel-aligned placement).
  local screenX = (worldX - cam.x) * zoom
  local screenY = (worldY - cam.y) * zoom

  love.graphics.push()
  love.graphics.origin()
  local sh = getShader()
  love.graphics.setShader(sh)
  sh:send("texelSize", { 1 / size, 1 / size })
  sh:send("glowRadiusPx", glowWorldRadius * zoom)
  sh:send("glowColor", color)
  sh:send("strength", strength)
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(maskCanvas, screenX - halfPx, screenY - halfPx)
  love.graphics.setShader()
  love.graphics.pop()
  love.graphics.setColor(1, 1, 1, 1)
end

return SilhouetteGlow
