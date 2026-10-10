-- lua/effects/MetalGradient.lua
--
-- The chrome-style gradient that gets MULTIPLIED over things meant to
-- look like polished metal — the title-screen logo (TitleScreen.lua)
-- and metallic Spheres (GlowOrb.lua, via Sphere.lua). One gradient,
-- defined here, so everything metal in the game is the same metal.
--
-- It's the classic chrome look, read from one end to the other: cool
-- sky tones, brightening to white, a hard dark "horizon" line just past
-- the middle, then warm tones beyond it. Handed out as a 1-pixel-wide
-- image strip for a shader to sample by position (0 at the top of the
-- strip, 1 at the bottom).

local MetalGradient = {}

MetalGradient.STOPS = {
  -- { position (0 = sky end, 1 = ground end), r, g, b }
  { 0.00, 0.62, 0.74, 0.95 },
  { 0.30, 0.90, 0.95, 1.00 },
  { 0.47, 1.00, 1.00, 1.00 },
  { 0.52, 0.30, 0.33, 0.44 }, -- the horizon line
  { 0.62, 0.62, 0.58, 0.60 },
  { 0.84, 1.00, 0.92, 0.76 },
  { 1.00, 0.72, 0.60, 0.50 },
}

local STRIP_HEIGHT = 256
local image = nil

-- The gradient as a 1 x 256 image, linear-filtered. Built once.
function MetalGradient.getImage()
  if image then return image end
  local stops = MetalGradient.STOPS
  local data = love.image.newImageData(1, STRIP_HEIGHT)
  for y = 0, STRIP_HEIGHT - 1 do
    local t = y / (STRIP_HEIGHT - 1)
    local a, b = stops[1], stops[#stops]
    for i = 1, #stops - 1 do
      if t >= stops[i][1] and t <= stops[i + 1][1] then
        a, b = stops[i], stops[i + 1]
        break
      end
    end
    local span = math.max(1e-6, b[1] - a[1])
    local k = math.max(0, math.min(1, (t - a[1]) / span))
    data:setPixel(0, y, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k, a[4] + (b[4] - a[4]) * k, 1)
  end
  image = love.graphics.newImage(data)
  image:setFilter("linear", "linear")
  return image
end

return MetalGradient
