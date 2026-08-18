-- lua/world/Starfield.lua
--
-- Simple multi-layer parallax starfield.
-- Draws a deep blue background + several layers of stars that move
-- at different speeds relative to the camera for a nice sense of depth.
-- Stars wrap so the field is effectively infinite.

local Starfield = {}
Starfield.__index = Starfield

-- Nice deep space blue
local BG_COLOR = { 0.015, 0.025, 0.07, 1 }
local STAR_DENSITY = 8

-- Layer definitions: parallax factor + how many stars + size/brightness range
local LAYERS = {
  { parallax = 0.08, count = math.floor(90  * STAR_DENSITY), minSize = 0.6, maxSize = 1.1, alpha = 0.35 },
  { parallax = 0.18, count = math.floor(70  * STAR_DENSITY), minSize = 0.8, maxSize = 1.4, alpha = 0.55 },
  { parallax = 0.35, count = math.floor(50  * STAR_DENSITY), minSize = 1.0, maxSize = 1.8, alpha = 0.75 },
  { parallax = 0.55, count = math.floor(30  * STAR_DENSITY), minSize = 1.2, maxSize = 2.2, alpha = 0.90 },
}

local function randomStar(layer)
  return {
    x = math.random() * 4000 - 500,   -- spread a bit wider than typical view
    y = math.random() * 4000 - 500,
    size = layer.minSize + math.random() * (layer.maxSize - layer.minSize),
    brightness = 0.5 + math.random() * 0.5,
  }
end

function Starfield.new()
  local self = setmetatable({}, Starfield)

  self.layers = {}
  for _, def in ipairs(LAYERS) do
    local stars = {}
    for i = 1, def.count do
      stars[i] = randomStar(def)
    end
    table.insert(self.layers, {
      parallax = def.parallax,
      alpha    = def.alpha,
      stars    = stars,
    })
  end

  return self
end

-- Optional: regenerate stars (e.g. if you want a different random seed)
function Starfield:regenerate()
  for _, layer in ipairs(self.layers) do
    for i, star in ipairs(layer.stars) do
      star.x = math.random() * 4000 - 500
      star.y = math.random() * 4000 - 500
    end
  end
end

function Starfield:draw(camera, visibleWidth, visibleHeight)
  -- Solid deep-blue background
  love.graphics.clear(BG_COLOR[1], BG_COLOR[2], BG_COLOR[3], BG_COLOR[4])

  -- We draw in screen space (after the camera transform has been applied
  -- in love.draw). So we need to convert the camera offset into the
  -- current view's coordinate system.
  local camX = camera and camera.x or 0
  local camY = camera and camera.y or 0

  for _, layer in ipairs(self.layers) do
    local px = camX * layer.parallax
    local py = camY * layer.parallax

    love.graphics.setColor(0.85, 0.9, 1.0, layer.alpha)

    for _, star in ipairs(layer.stars) do
      -- Wrap stars so they stay in a reasonable range around the view
      local sx = star.x - px
      local sy = star.y - py

      -- Simple wrap (keeps stars recycling)
      local wrap = 3000
      sx = sx % wrap
      if sx < 0 then sx = sx + wrap end
      sy = sy % wrap
      if sy < 0 then sy = sy + wrap end

      -- Only draw if roughly on screen (cheap cull)
      if sx > -50 and sx < visibleWidth + 50 and
         sy > -50 and sy < visibleHeight + 50 then
        love.graphics.circle("fill", sx, sy, star.size * star.brightness)
      end
    end
  end

  love.graphics.setColor(1, 1, 1, 1)
end

return Starfield