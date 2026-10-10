-- lua/world/Starfield.lua
--
-- Simple multi-layer parallax starfield.
-- Draws a deep blue background + several layers of stars that move
-- at different speeds relative to the camera for a nice sense of depth.
-- Stars wrap so the field is effectively infinite.

local Starfield = {}
Starfield.__index = Starfield

-- Vertical background gradient: a clearly-visible dark navy blue at the
-- top of the screen, fading to a darker (near-black) shade at the
-- bottom. The old flat BG_COLOR (0.015, 0.025, 0.07) was so dim it read
-- as plain black rather than navy — TOP_COLOR below is brightened up
-- enough to actually register as blue.
-- Brightened a step from { 0.06, 0.09, 0.22 } / { 0.01, 0.015, 0.04 } —
-- on a darker display the bottom half read as flat black.
local TOP_COLOR = { 0.09, 0.13, 0.30, 1 }
local BOTTOM_COLOR = { 0.03, 0.045, 0.11, 1 }
local GRADIENT_STRIPS = 48 -- horizontal bands approximating the gradient — plenty smooth at this scale, no shader needed
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

-- Screen-space vertical gradient, top (TOP_COLOR) to bottom
-- (BOTTOM_COLOR) — drawn as a stack of thin solid strips rather than a
-- shader/mesh, which is plenty smooth at GRADIENT_STRIPS' resolution
-- for a slow background fade and keeps this file dependency-free.
-- Strips overlap by 1px (stripH + 1) so there's no visible seam line
-- between them.
local function drawBackgroundGradient()
  local w = love.graphics.getWidth()
  local h = love.graphics.getHeight()
  local stripH = h / GRADIENT_STRIPS

  for i = 0, GRADIENT_STRIPS - 1 do
    local t = i / (GRADIENT_STRIPS - 1)
    love.graphics.setColor(
      TOP_COLOR[1] + (BOTTOM_COLOR[1] - TOP_COLOR[1]) * t,
      TOP_COLOR[2] + (BOTTOM_COLOR[2] - TOP_COLOR[2]) * t,
      TOP_COLOR[3] + (BOTTOM_COLOR[3] - TOP_COLOR[3]) * t,
      1
    )
    love.graphics.rectangle("fill", 0, i * stripH, w, stripH + 1)
  end

  love.graphics.setColor(1, 1, 1, 1)
end

function Starfield:draw(camera, visibleWidth, visibleHeight)
  drawBackgroundGradient()

  -- We draw in screen space (after the camera transform has been applied
  -- in love.draw). So we need to convert the camera offset into the
  -- current view's coordinate system.
  local camX = camera and camera.x or 0
  local camY = camera and camera.y or 0

  -- Stars are drawn in SCREEN pixels (this runs before love.draw applies
  -- the camera's own scale), so what has to be covered is the window
  -- itself — not visibleWidth/visibleHeight, which are the window's size
  -- in WORLD units (window / zoom). Culling against those is what left
  -- the right and bottom of the window starless whenever the camera was
  -- zoomed in past 1: at zoom 1.4 they're only 71% of the window.
  local screenW, screenH = love.graphics.getWidth(), love.graphics.getHeight()
  local wrap = 3000

  for _, layer in ipairs(self.layers) do
    local px = camX * layer.parallax
    local py = camY * layer.parallax

    love.graphics.setColor(0.85, 0.9, 1.0, layer.alpha)

    for _, star in ipairs(layer.stars) do
      -- Wrap stars so they stay in a reasonable range around the view
      local sx = star.x - px
      local sy = star.y - py

      -- Simple wrap (keeps stars recycling)
      sx = sx % wrap
      sy = sy % wrap

      -- The pattern repeats every `wrap` pixels, so it's tiled across
      -- however much window there is — a window wider or taller than
      -- one repeat (a 4K display) gets further copies rather than the
      -- stars simply stopping at 3000px. On an ordinary window each
      -- loop runs once, for stars inside it, and not at all otherwise.
      local radius = star.size * star.brightness
      local y = sy
      while y < screenH + 50 do
        local x = sx
        while x < screenW + 50 do
          love.graphics.circle("fill", x, y, radius)
          x = x + wrap
        end
        y = y + wrap
      end
    end
  end

  love.graphics.setColor(1, 1, 1, 1)
end

return Starfield