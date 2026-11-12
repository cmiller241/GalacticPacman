-- lua/effects/ShipHull.lua
--
-- The outside of Bob's spaceship (see lua/levels/Spaceship.lua) as
-- metal, drawn as one quad through a shader:
--
--   * a shallow dome, lit from wherever the sun is (brighter on that
--     side, darker away from it, with a sharp shine where it catches the
--     light);
--   * chrome: the same reflection gradient the metal spheres and the
--     title logo use (lua/effects/MetalGradient.lua), bent round the dome;
--   * brushed: fine streaks running round the hull;
--   * plating: the outer band split into panels by seams, with rivets
--     either side of each seam, and a bevelled rim.
--
-- The postmark rings, the route and the window are painted on top of
-- this by Spaceship.lua.

local state = require("lua.state")
local MetalGradient = require("lua.effects.MetalGradient")

local ShipHull = {}

-- The plating: how many panels round the outer band, and where the band
-- starts (as a fraction of the radius).
local PANELS = 16
local BAND_START = 0.84
-- How strongly the chrome reflection shows (0 = plain painted metal).
local CHROME = 0.75

local shader = nil
local function getShader()
  if shader then return shader end
  shader = love.graphics.newShader([[
    extern vec2 sunDir;        // unit vector toward the sun (world space, y down)
    extern Image metalGradient;
    extern vec3 tint;          // the paint under the metal
    extern number chrome;      // 0..1, how much of the chrome reflection shows
    extern number panels;      // panels round the outer band
    extern number bandStart;   // where the outer band starts, in radii
    extern number pixel;       // one screen pixel, in radii (for smooth edges)

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                 mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }

    // A rivet at p (in radii) of radius r: 0 outside it; inside, a little
    // dome lit from the sun's side (returns how bright, 0.55 to 1.45, and
    // how much of the pixel it covers, in .y).
    vec2 rivet(vec2 q, vec2 p, float r, vec2 sun) {
      vec2 off = q - p;
      float cover = 1.0 - smoothstep(r - pixel, r + pixel, length(off));
      float lit = dot(off / r, sun);
      return vec2(1.0 + 0.45 * clamp(lit, -1.0, 1.0), cover);
    }

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec2 q = uv * 2.0 - 1.0;             // -1..1 across the hull
      float d = length(q);
      float alpha = 1.0 - smoothstep(1.0 - pixel, 1.0 + pixel, d);
      if (alpha <= 0.0) return vec4(0.0);
      vec2 dir = d > 0.0001 ? q / d : vec2(0.0);
      float ang = atan(q.y, q.x);

      // A shallow dome: tilted toward the rim, flat in the middle.
      vec3 n = normalize(vec3(q * 0.85, sqrt(max(0.0, 1.0 - 0.72 * d * d))));
      vec3 light = normalize(vec3(sunDir, 0.7));
      float diffuse = clamp(dot(n, light), 0.0, 1.0);
      float shine = pow(clamp(dot(reflect(-light, n), vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 60.0);

      // Painted metal, lit, with the chrome reflection over it.
      vec3 c = tint * (0.45 + 0.85 * diffuse);
      float reflectY = 2.0 * n.z * n.y;
      vec3 metal = Texel(metalGradient, vec2(0.5, 0.5 + 0.5 * reflectY)).rgb;
      c *= mix(vec3(1.0), metal * 1.25, chrome);

      // Brushed: fine streaks running round the hull.
      float brush = noise(vec2(d * 420.0, ang * 1.5)) * 0.6 + noise(vec2(d * 1300.0, ang * 4.0)) * 0.4;
      c *= 0.9 + 0.2 * brush;

      // Plating, in the outer band: seams between panels, a seam round
      // the inside of the band, and rivets either side of each seam.
      float inBand = smoothstep(bandStart - pixel, bandStart + pixel, d);
      float a = (ang / 6.2831853 + 0.5) * panels;
      float across = min(fract(a), 1.0 - fract(a)) * 6.2831853 * d / panels; // distance to the nearest seam, in radii
      float seam = (1.0 - smoothstep(0.004, 0.004 + 2.0 * pixel, across)) * inBand;
      seam = max(seam, 1.0 - smoothstep(0.004, 0.004 + 2.0 * pixel, abs(d - bandStart)));
      c *= 1.0 - 0.6 * seam;
      // (A thin catch of light just to one side of each seam.)
      float lip = (1.0 - smoothstep(0.0, 2.0 * pixel, abs(across - 0.009))) * inBand * (1.0 - seam);
      c += vec3(0.25) * lip * diffuse;

      float side = fract(a) < 0.5 ? 0.13 : 0.87;
      float rivetAng = ((floor(a) + side) / panels - 0.5) * 6.2831853;
      vec2 rdir = vec2(cos(rivetAng), sin(rivetAng));
      for (int k = 0; k < 2; k++) {
        float rr = k == 0 ? bandStart + 0.035 : 0.955;
        vec2 rv = rivet(q, rdir * rr, 0.013, sunDir) * inBand;
        c = mix(c, c * rv.x, rv.y);
      }

      // The rim: bevelled, darker, catching the light on the sun's side.
      float bevel = smoothstep(0.955, 0.975, d);
      c = mix(c, c * (0.55 + 0.9 * clamp(dot(dir, sunDir), 0.0, 1.0)), bevel);

      c += vec3(1.0, 0.98, 0.94) * shine * 0.85;
      return vec4(c * alpha, alpha) * color.a;
    }
  ]])
  return shader
end

-- A 1x1 white pixel: the quad the shader is drawn on.
local pixelImage = nil
local function getPixel()
  if pixelImage then return pixelImage end
  local data = love.image.newImageData(1, 1)
  data:setPixel(0, 0, 1, 1, 1, 1)
  pixelImage = love.graphics.newImage(data)
  return pixelImage
end

-- The hull at (x, y), `radius` world units, painted `tint` ({r, g, b}).
function ShipHull.draw(x, y, radius, tint)
  local s = getShader()
  local toSunX, toSunY = (state.sceneWidth or 0) / 2 - x, (state.sceneHeight or 0) / 2 - y
  local dist = math.sqrt(toSunX * toSunX + toSunY * toSunY)
  if dist < 1 then toSunX, toSunY, dist = 0, -1, 1 end
  s:send("sunDir", { toSunX / dist, toSunY / dist })
  s:send("metalGradient", MetalGradient.getImage())
  s:send("tint", { tint[1], tint[2], tint[3] })
  s:send("chrome", CHROME)
  s:send("panels", PANELS)
  s:send("bandStart", BAND_START)
  s:send("pixel", 1 / (radius * (state.zoom or 1)))
  love.graphics.push("all")
  love.graphics.setShader(s)
  love.graphics.setBlendMode("alpha", "premultiplied")
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(getPixel(), x - radius, y - radius, 0, radius * 2, radius * 2)
  love.graphics.pop()
end

return ShipHull
