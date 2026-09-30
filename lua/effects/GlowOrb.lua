-- lua/effects/GlowOrb.lua
--
-- Shared GPU-shaded "glowing metallic orb" renderer for small, fixed
-- landmark planetoids/objects (Sphere.lua, Spikey.lua) — replaces the
-- flat stencil-clipped shadow/highlight circles those two used to draw
-- by hand with a real per-pixel shader: a pseudo-3D sphere normal (same
-- technique WaterPlanet.lua's own shading uses, and for the same
-- reason — a flat in-plane "direction from center" pinches to a point
-- right at dist=0), a sun-relative dark/light gradient, a bright rim on
-- the lit edge, and a soft outer glow fading out past the body's own
-- true radius. Affordable as a live shader specifically because there
-- are only ever a handful of these on screen — nothing like the
-- hundreds of belt planetoids Planetoid.lua's own baked-canvas cache
-- exists to amortize.

local state = require("lua.state")

local GlowOrb = {}

local shader = nil
local function getShader()
  if shader then return shader end
  shader = love.graphics.newShader([[
    extern vec2 originScreen; // this orb's bounding box top-left corner, in SCREEN pixels, this frame
    extern number zoom;
    extern number boxHalf;    // bounding box half-size, world units — re-centers local coords on the circle
    extern number radius;     // the TRUE body radius, world units
    extern number glowRadius; // world units — how far the soft outer glow reaches past radius
    extern number edgeSoftness; // world units of blur across the body/glow boundary
    extern number glowStrength; // 0..1, max alpha of the glow at its brightest (right at the edge)
    extern number rimStrength;  // 0..1, how strongly the lit-edge rim blends in
    extern vec3 colorDark;   // shaded (away-from-sun) body color
    extern vec3 colorLight;  // lit (facing-sun) body color
    extern vec3 colorRim;    // bright highlight right at the lit edge
    extern vec3 colorGlow;   // soft outer glow color
    extern vec2 sunDir;      // unit vector from this orb's center TOWARD the sun, world space

    vec4 effect(vec4 color, Image tex, vec2 texture_coords, vec2 screen_coords) {
      vec2 local = (screen_coords - originScreen) / zoom - vec2(boxHalf, boxHalf);
      float dist = length(local);

      // Pseudo-3D sphere normal — see WaterPlanet.lua's own comment on
      // why this (not a flat "direction from center") is what avoids a
      // pinwheel/pinch artifact right at the exact center: scaling the
      // in-plane component by (dist/radius), which shrinks smoothly to
      // 0 at dist=0, gives a single well-defined normal (0,0,1) there
      // instead of a direction that sweeps through every angle in an
      // arbitrarily tiny neighborhood.
      float nxy = clamp(dist / radius, 0.0, 1.0);
      vec2 inPlaneDir = dist > 0.0001 ? local / dist : vec2(0.0, 0.0);
      float nz = sqrt(max(0.0, 1.0 - nxy * nxy));
      vec3 normal = vec3(inPlaneDir * nxy, nz);

      // Mild positive Z on the light direction (same as WaterPlanet.lua)
      // so the lit hemisphere covers a visible cap, not a razor crescent.
      vec3 sunDir3 = normalize(vec3(sunDir, 0.5));
      float facing = dot(normal, sunDir3);
      float lightT = smoothstep(-0.3, 0.7, facing);
      vec3 bodyColor = mix(colorDark, colorLight, lightT);

      // Bright rim, sun-facing side only, right at the true edge.
      float rimT = smoothstep(radius * 0.6, radius, dist) * clamp(facing, 0.0, 1.0);
      bodyColor = mix(bodyColor, colorRim, rimT * rimStrength);

      // Single unified alpha: 1.0 through the body's own interior,
      // soft-edged at the true radius, then fading down to 0 by
      // glowRadius — computed without branching so it stays cheap even
      // though this runs on a padded quad well past the visible circle.
      float bodyAlpha = 1.0 - smoothstep(radius - edgeSoftness, radius + edgeSoftness, dist);
      float glowAlpha = (1.0 - smoothstep(radius, glowRadius, dist)) * glowStrength;
      float alpha = max(bodyAlpha, glowAlpha);
      vec3 outColor = mix(colorGlow, bodyColor, bodyAlpha);

      return vec4(outColor, alpha) * color;
    }
  ]])
  return shader
end

-- x, y, radius: world units — the orb's true center/body radius.
-- colors: { dark, light, rim, glow } each an {r,g,b} table (0..1).
-- options (all optional): glowRadiusMult (default 1.6), edgeSoftness
-- (default 2), glowStrength (default 0.5), rimStrength (default 0.6).
function GlowOrb.draw(x, y, radius, colors, options)
  options = options or {}
  local sh = getShader()
  local zoom = state.zoom or 1
  local cam = state.camera or { x = 0, y = 0 }

  local glowRadius = radius * (options.glowRadiusMult or 1.6)
  local boxHalf = glowRadius
  local x0, y0 = x - boxHalf, y - boxHalf
  local size = boxHalf * 2

  love.graphics.setShader(sh)
  sh:send("originScreen", { (x0 - cam.x) * zoom, (y0 - cam.y) * zoom })
  sh:send("zoom", zoom)
  sh:send("boxHalf", boxHalf)
  sh:send("radius", radius)
  sh:send("glowRadius", glowRadius)
  sh:send("edgeSoftness", options.edgeSoftness or 2)
  sh:send("glowStrength", options.glowStrength or 0.5)
  sh:send("rimStrength", options.rimStrength or 0.6)
  sh:send("colorDark", colors.dark)
  sh:send("colorLight", colors.light)
  sh:send("colorRim", colors.rim)
  sh:send("colorGlow", colors.glow)

  -- Same "sun sits at the exact center of the scene" convention
  -- Planetoid.lua/WaterPlanet.lua already use.
  local sunX, sunY = (state.sceneWidth or 0) / 2, (state.sceneHeight or 0) / 2
  local sdx, sdy = sunX - x, sunY - y
  local sd = math.sqrt(sdx * sdx + sdy * sdy)
  if sd < 1 then sd = 1; sdx, sdy = 1, 0 end
  sh:send("sunDir", { sdx / sd, sdy / sd })

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.rectangle("fill", x0, y0, size, size)
  love.graphics.setShader()
  love.graphics.setColor(1, 1, 1, 1)
end

return GlowOrb
