-- lua/effects/TileGlow.lua
--
-- Things that glow lighting up the Tiled level's tiles near them —
-- fireballs, explosions, lava, portals, and the blaster's muzzle flash —
-- only on tiles, never on the open background where there are none (the
-- same masking as Bob's and the Ooombas' shadows, see CharacterShadows.lua).
--
-- Each frame (see main.lua, which calls these where the level is drawn):
--   * TileGlow.prepare: a soft round glow for each light, in its color,
--     added up into a screen-sized canvas (black where there's none).
--   * TileGlow.drawOnto(level): the level's own baked canvas drawn over
--     itself, additively, through a shader that adds that light at each
--     of its pixels times how much tile is there — so open background,
--     where it's clear, stays dark.
-- Drawn after the level (and the characters' shadows on it), before the
-- characters themselves, so they aren't washed out by it.

local state = require("lua.state")

local TileGlow = {}

----------------------------------------------------------------------
-- Tunables — each light's color, reach (world units) and brightness
----------------------------------------------------------------------

local FIREBALL = { color = { 1.00, 0.55, 0.18 }, radius = 190, intensity = 0.25, flicker = 0.18 }
local EXPLOSION = { color = { 1.00, 0.62, 0.25 }, radius = 340, intensity = 0.4 } -- fading out over its life
local LAVA = { color = { 1.00, 0.40, 0.10 }, radius = 150, intensity = 0.16, pulse = 0.25 } -- per lava tile (they add up)
local PORTAL = { radius = 210, intensity = 0.35 } -- in each portal's own glow color
local ROPE_FLAME = { color = { 1.00, 0.55, 0.15 }, radius = 120, intensity = 0.3, flicker = 0.25 } -- each front of a burning rope (see RopeRock.lua)
local PORTAL_COLORS = { red = { 1.00, 0.45, 0.25 }, blue = { 0.35, 0.70, 1.00 } }
local MUZZLE_FLASH = { color = { 1.00, 0.75, 0.40 }, radius = 150, intensity = 0.28, seconds = 0.1 }

----------------------------------------------------------------------

local lights = nil   -- the screen-sized canvas the glows are added up in
local anyLight = false

-- A soft round glow: bright in the middle, fading smoothly to nothing at
-- its edge (made once, drawn scaled to each light's reach).
local GLOW_SIZE = 128
local glowImage = nil
local function getGlowImage()
  if glowImage then return glowImage end
  local data = love.image.newImageData(GLOW_SIZE, GLOW_SIZE)
  local half = GLOW_SIZE / 2
  data:mapPixel(function(x, y)
    local d = math.sqrt((x + 0.5 - half) ^ 2 + (y + 0.5 - half) ^ 2) / half
    local v = math.max(0, 1 - d)
    v = v * v * (3 - 2 * v) -- smoothstep, so there's no visible rim
    return 1, 1, 1, v
  end)
  glowImage = love.graphics.newImage(data)
  glowImage:setFilter("linear", "linear")
  return glowImage
end

local shader = nil
local function getShader()
  if shader then return shader end
  shader = love.graphics.newShader([[
    extern Image lights;     // the glows, screen-sized
    extern vec2 lightsSize;  // its size, in pixels
    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      float tile = Texel(tex, uv).a;  // how much tile is here
      vec3 light = Texel(lights, screen / lightsSize).rgb;
      return vec4(light, tile);       // (added on, scaled by the tile)
    }
  ]])
  return shader
end

-- Gathers this frame's lights and draws their glows. Call in world space
-- (inside the camera transform), before drawOnto.
function TileGlow.prepare()
  anyLight = false
  local list = {}
  local function add(x, y, color, radius, intensity)
    if intensity > 0.01 then list[#list + 1] = { x = x, y = y, color = color, radius = radius, intensity = intensity } end
  end
  local now = love.timer.getTime()

  for _, f in ipairs(state.fireballs or {}) do
    local flicker = 1 + FIREBALL.flicker * math.sin(now * 23 + (f.flickerPhase or 0))
    add(f.pos.x, f.pos.y, FIREBALL.color, FIREBALL.radius, FIREBALL.intensity * flicker)
  end
  for _, e in ipairs(state.explosions or {}) do
    if e.startTime and e.duration then
      local t = math.min(1, (now - e.startTime) / e.duration)
      add(e.pos.x, e.pos.y, EXPLOSION.color, EXPLOSION.radius, EXPLOSION.intensity * (1 - t) * (1 - t))
    end
  end
  for _, lava in ipairs(state.lavas or {}) do
    if lava.x0 and lava.size then
      local pulse = 1 + LAVA.pulse * math.sin(now * 1.7 + lava.x0 * 0.01)
      add(lava.x0 + lava.size / 2, lava.y0 + lava.size * 0.3, LAVA.color, LAVA.radius, LAVA.intensity * pulse)
    end
  end
  for color, p in pairs(state.portals or {}) do
    local c = PORTAL_COLORS[color]
    if c and p.x then
      -- (Just out in front of its opening.)
      add(p.x + (p.nx or 0) * 24, p.y + (p.ny or 0) * 24, c, PORTAL.radius, PORTAL.intensity)
    end
  end
  for _, rr in ipairs(state.ropeRocks or {}) do
    -- A burning rope's flames (see RopeRock.lua).
    local up, down = rr:flameFronts()
    for i, t in ipairs({ up or false, down or false }) do
      if t then
        local x, y = rr:flamePoint(t)
        local flicker = 1 + ROPE_FLAME.flicker * math.sin(now * 29 + i * 2.3)
        add(x, y, ROPE_FLAME.color, ROPE_FLAME.radius, ROPE_FLAME.intensity * flicker)
      end
    end
  end
  local player = state.player
  if player and player.lastShotTime and player.getMuzzlePosition then
    local since = now - player.lastShotTime
    if since >= 0 and since < MUZZLE_FLASH.seconds then
      local mx, my = player:getMuzzlePosition()
      add(mx, my, MUZZLE_FLASH.color, MUZZLE_FLASH.radius, MUZZLE_FLASH.intensity * (1 - since / MUZZLE_FLASH.seconds))
    end
  end

  if #list == 0 then return end

  -- (The size of whatever's being drawn to: the screen, or a canvas.)
  local target = love.graphics.getCanvas()
  local w, h
  if target then w, h = target:getDimensions() else w, h = love.graphics.getDimensions() end
  if not lights or lights:getWidth() ~= w or lights:getHeight() ~= h then
    if lights then lights:release() end
    lights = love.graphics.newCanvas(w, h)
  end

  local img = getGlowImage()
  love.graphics.push("all")
  love.graphics.setCanvas(lights)
  love.graphics.clear(0, 0, 0, 1)
  love.graphics.setBlendMode("add")
  for _, l in ipairs(list) do
    local s = l.radius * 2 / GLOW_SIZE
    love.graphics.setColor(l.color[1] * l.intensity, l.color[2] * l.intensity, l.color[3] * l.intensity, 1)
    love.graphics.draw(img, l.x, l.y, 0, s, s, GLOW_SIZE / 2, GLOW_SIZE / 2)
  end
  love.graphics.pop()
  anyLight = true
end

-- The glow on `level`'s tiles. Call right after drawing the level (and
-- its shadows).
function TileGlow.drawOnto(level)
  if not (anyLight and lights and level.canvas) then return end
  local s = getShader()
  local pw, ph = lights:getPixelDimensions()
  s:send("lights", lights)
  s:send("lightsSize", { pw, ph })
  love.graphics.push("all")
  love.graphics.setShader(s)
  love.graphics.setBlendMode("add")
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(level.canvas, level.anchorX, level.anchorY)
  love.graphics.pop()
end

return TileGlow
