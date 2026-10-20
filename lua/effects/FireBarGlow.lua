-- lua/effects/FireBarGlow.lua
--
-- The fire bars' fireballs lighting up the round planets near them — the
-- planet version of TileGlow.lua (which does the same for the Tiled
-- level's tiles). Planets are balls, not flat tiles, so this lights each
-- as one: brightest on the side facing the fireball, fading round toward
-- the far side, and falling off with distance.
--
-- Each frame (see main.lua, which calls these where the planets are drawn):
--   * FireBarGlow.prepare: gathers every on-screen fire bar's fireballs.
--   * FireBarGlow.drawOnto(planet): right after drawing a planet, adds
--     the light of the fireballs within reach over it, through a shader
--     that works out, at each of its pixels, the point of the sphere
--     there and how much each fireball lights it.

local state = require("lua.state")
local utils = require("lua.utils")
local Planetoid = require("lua.world.Planetoid")

local FireBarGlow = {}

----------------------------------------------------------------------
-- Tunables
----------------------------------------------------------------------

local COLOR = { 1.00, 0.50, 0.15 }
local REACH = 200        -- world units a fireball's light reaches
local INTENSITY = 0.4    -- one fireball's brightness, close up (they add up...)
local MAX_BRIGHTNESS = 0.65 -- (...but ease off toward this, so a whole bar can't wash a planet out)
local AMBIENT = 0.12     -- how much light reaches the side turned away (0..1)
local FLICKER = 0.15
local LIGHT_DEPTH = 1.0  -- how far out in front of a planet the fireballs are, in its radii
local MAX_LIGHTS = 32    -- fireballs per planet, at most (must match the shader)

----------------------------------------------------------------------

local lights = {}  -- this frame's fireballs: { x, y, intensity }

local shader = nil
local function getShader()
  if shader then return shader end
  shader = love.graphics.newShader([[
    #define MAX_LIGHTS ]] .. MAX_LIGHTS .. [[

    #define LIGHT_DEPTH ]] .. string.format("%.2f", LIGHT_DEPTH) .. [[

    extern vec3 lights[MAX_LIGHTS];  // x, y from the planet's centre (world units), intensity
    extern int count;
    extern number radius;
    extern number reach;
    extern number ambient;
    extern number maxBrightness;
    extern vec3 tint;

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec2 p = uv * 2.0 - 1.0;
      float r2 = dot(p, p);
      if (r2 > 1.0) return vec4(0.0);
      float edge = 1.0 - smoothstep(0.97, 1.0, sqrt(r2));  // (antialiased)

      // The sphere's surface here, and which way it faces. The fireballs
      // swing past in front of the planets (they're drawn over them), so
      // they're out toward the viewer, level with its front face.
      vec3 n = vec3(p, sqrt(1.0 - r2));
      vec3 surface = n * radius;

      float total = 0.0;
      for (int i = 0; i < MAX_LIGHTS; i++) {
        if (i >= count) break;
        vec3 toLight = vec3(lights[i].xy, radius * LIGHT_DEPTH) - surface;
        float d = length(toLight);
        float fall = clamp(1.0 - d / reach, 0.0, 1.0);
        fall *= fall;
        float facing = max(dot(n, toLight / max(d, 0.001)), 0.0);
        total += lights[i].z * fall * (ambient + (1.0 - ambient) * facing);
      }
      float light = maxBrightness * (1.0 - exp(-total / maxBrightness));
      return vec4(tint * light, edge);
    }
  ]])
  return shader
end

-- A 1x1 white pixel: the quad the shader is drawn on, scaled to the planet.
local pixelImage = nil
local function getPixel()
  if pixelImage then return pixelImage end
  local data = love.image.newImageData(1, 1)
  data:setPixel(0, 0, 1, 1, 1, 1)
  pixelImage = love.graphics.newImage(data)
  return pixelImage
end

-- Gathers this frame's fireballs. Call once per frame, before drawOnto.
function FireBarGlow.prepare()
  lights = {}
  local now = love.timer.getTime()
  for _, bar in ipairs(state.fireBars or {}) do
    if utils.isOnScreen(bar.pos.x, bar.pos.y, bar.barLength + REACH, 50) then
      for i, f in ipairs(bar:getFireballPositions()) do
        local flicker = 1 + FLICKER * math.sin(now * 23 + i * 1.7)
        lights[#lights + 1] = { f.x, f.y, INTENSITY * flicker }
      end
    end
  end
end

-- The fireballs' light on `planet`. Call right after drawing it. Only
-- round planets (anything built on Planetoid.new) — the sky dome, rounded
-- rect and Tiled shapes aren't balls.
function FireBarGlow.drawOnto(planet)
  if #lights == 0 or getmetatable(planet) ~= Planetoid then return end
  local px, py, radius = planet.pos.x, planet.pos.y, planet.radius
  local reachSq = (radius + REACH) * (radius + REACH)
  local near = {}
  for _, l in ipairs(lights) do
    local dx, dy = l[1] - px, l[2] - py
    if dx * dx + dy * dy < reachSq and #near < MAX_LIGHTS then
      near[#near + 1] = { dx, dy, l[3] }
    end
  end
  if #near == 0 then return end

  local s = getShader()
  s:send("lights", unpack(near))
  s:send("count", #near)
  s:send("radius", radius)
  s:send("reach", REACH)
  s:send("ambient", AMBIENT)
  s:send("maxBrightness", MAX_BRIGHTNESS)
  s:send("tint", COLOR)
  love.graphics.push("all")
  love.graphics.setShader(s)
  love.graphics.setBlendMode("add")
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(getPixel(), px - radius, py - radius, 0, radius * 2, radius * 2)
  love.graphics.pop()
end

return FireBarGlow
