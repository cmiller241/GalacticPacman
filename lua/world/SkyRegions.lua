-- lua/world/SkyRegions.lua
--
-- What makes one part of space look different from another, behind
-- everything (drawn by Starfield.lua, in screen space):
--
--   * The sky's own colour (Starfield's gradient) blends by which side
--     of the sun the view is on — REGION_SKIES: blue to the north,
--     violet to the east, teal to the south, dusty brown to the west —
--     warming toward SUN_SKY near the sun and darkening far out.
--
--   * Scenery far off in the distance (SCENERY): a nebula for each
--     region, a spiral galaxy to the north, and — to the west — a
--     dense band of distant stars crossed by dark dust lanes. Each is
--     pinned to a spot in the world (`at`, relative to the sun) and
--     drawn at a slow `parallax`,
--     so it's centred on screen when the view's right there and slides
--     slowly off as he travels away: different scenery comes into view
--     in each part of the map.
--
-- All the art is placeholder, generated once at startup (see the
-- make* functions below). To use your own instead, put a PNG named
-- after the piece (its `name`, e.g. img/sky/nebula_north.png) in
-- img/sky/: it's used in its place, drawn `width` screen pixels wide
-- with ordinary alpha blending.

local state = require("lua.state")

local SkyRegions = {}

-- The sky's gradient colours ({ top, bottom }) in each direction from
-- the sun; between them, blended by angle.
local REGION_SKIES = {
  north = { { 0.07, 0.12, 0.32 }, { 0.02, 0.04, 0.12 } },
  east  = { { 0.15, 0.07, 0.28 }, { 0.05, 0.02, 0.10 } },
  south = { { 0.04, 0.16, 0.22 }, { 0.01, 0.05, 0.08 } },
  west  = { { 0.15, 0.10, 0.07 }, { 0.05, 0.03, 0.03 } },
}
-- Near the sun the sky warms toward this, fully within SUN_SKY_NEAR of
-- it, not at all past SUN_SKY_FAR.
local SUN_SKY = { { 0.24, 0.13, 0.06 }, { 0.09, 0.04, 0.03 } }
local SUN_SKY_NEAR, SUN_SKY_FAR = 9000, 26000
-- Far out, it darkens — by up to FAR_DARKEN, from FAR_START on to FAR_FULL.
local FAR_DARKEN, FAR_START, FAR_FULL = 0.45, 42000, 60000

-- The scenery. at: where it's pinned, relative to the sun (world
-- units). parallax: how fast it slides as the view moves (screen
-- pixels per world unit) — lower is further away. width: how wide it's
-- drawn, screen pixels (its height follows from its art). angle:
-- radians. alpha: how strong. layer: "far" (behind every star) or
-- "dust" (in front of the far stars, behind the near ones — so it hides
-- the distant stars but not the close ones).
local SCENERY = {
  -- North: a cold blue-violet nebula, and a spiral galaxy.
  { name = "nebula_north", kind = "nebula", at = { 6000, -32000 }, parallax = 0.1, width = 2600, alpha = 0.8,
    colors = { { 0.25, 0.35, 0.9 }, { 0.55, 0.3, 0.85 }, { 0.75, 0.85, 1 } }, seed = 11 },
  { name = "galaxy", kind = "galaxy", at = { -14000, -38000 }, parallax = 0.07, width = 620, alpha = 0.85, angle = 0.5 },
  -- East: a magenta-and-rose nebula.
  { name = "nebula_east", kind = "nebula", at = { 33000, 7000 }, parallax = 0.1, width = 2800, alpha = 0.5,
    colors = { { 0.85, 0.25, 0.6 }, { 1.0, 0.45, 0.35 }, { 1, 0.85, 0.8 } }, seed = 23 },
  -- South: a teal-and-green nebula.
  { name = "nebula_south", kind = "nebula", at = { -5000, 33000 }, parallax = 0.1, width = 2600, alpha = 0.85,
    colors = { { 0.15, 0.7, 0.65 }, { 0.3, 0.85, 0.4 }, { 0.8, 1, 0.9 } }, seed = 37 },
  -- West: a warm glow behind a dense band of distant stars, dark dust
  -- lanes across them both.
  { name = "nebula_west", kind = "nebula", at = { -33000, 4000 }, parallax = 0.1, width = 3000, alpha = 0.6,
    colors = { { 0.85, 0.5, 0.25 }, { 0.7, 0.35, 0.2 }, { 1, 0.9, 0.7 } }, seed = 41 },
  { name = "star_band_west", kind = "starband", at = { -30000, 0 }, parallax = 0.1, width = 3400, alpha = 0.9, angle = -0.35 },
  -- (The first runs right along the star band, splitting it down the
  -- middle; the others cross it and the glow at an angle.)
  { name = "dust_west_1", kind = "dust", layer = "dust", at = { -30000, 400 }, parallax = 0.1, width = 3000, alpha = 1,
    angle = -0.3, seed = 51 },
  { name = "dust_west_2", kind = "dust", layer = "dust", at = { -34000, 9000 }, parallax = 0.11, width = 2600, alpha = 0.9,
    angle = 0.25, seed = 52 },
  { name = "dust_west_3", kind = "dust", layer = "dust", at = { -26000, 6000 }, parallax = 0.11, width = 2200, alpha = 0.9,
    angle = 0.7, seed = 53 },
  { name = "dust_west_4", kind = "dust", layer = "dust", at = { -38000, -9000 }, parallax = 0.11, width = 2400, alpha = 0.85,
    angle = 0.1, seed = 54 },
}

----------------------------------------------------------------------
-- Placeholder art, generated once
----------------------------------------------------------------------

-- A soft round dot (white, fading out to the edge) — what all of it's
-- painted with.
local softDot
local function getSoftDot()
  if softDot then return softDot end
  local size = 64
  local data = love.image.newImageData(size, size)
  data:mapPixel(function(x, y)
    local dx, dy = (x + 0.5) / size * 2 - 1, (y + 0.5) / size * 2 - 1
    local d = math.min(1, dx * dx + dy * dy)
    local a = (1 - d) ^ 2
    return 1, 1, 1, a
  end)
  softDot = love.graphics.newImage(data)
  softDot:setFilter("linear", "linear")
  return softDot
end

local function dot(x, y, radius, r, g, b, a, sx)
  local img = getSoftDot()
  love.graphics.setColor(r, g, b, a)
  local s = radius * 2 / img:getWidth()
  love.graphics.draw(img, x, y, 0, s * (sx or 1), s, img:getWidth() / 2, img:getHeight() / 2)
end

local function gauss(rng)
  -- (Roughly normal, mean 0, spread about 1.)
  return (rng:random() + rng:random() + rng:random() + rng:random() - 2) * 1.2
end

-- A cloud of glowing gas: a few winding chains of soft blobs in its
-- colours, bunched toward the middle (so its edges fade to nothing),
-- with a few brighter knots. Drawn additively (it's light).
local function makeNebula(spec)
  local size = 512
  local canvas = love.graphics.newCanvas(size, size)
  local rng = love.math.newRandomGenerator(spec.seed or 1)
  local c1, c2, c3 = spec.colors[1], spec.colors[2], spec.colors[3]
  love.graphics.setCanvas(canvas)
  love.graphics.clear(0, 0, 0, 0)
  love.graphics.setBlendMode("add")
  for _ = 1, 4 do
    local x, y = size / 2 + gauss(rng) * 50, size / 2 + gauss(rng) * 50
    local heading = rng:random() * math.pi * 2
    for _ = 1, 110 do
      heading = heading + (rng:random() - 0.5) * 0.9
      x = x + math.cos(heading) * 9
      y = y + math.sin(heading) * 9
      -- (Pulled back toward the middle, so it stays well inside.)
      x = x + (size / 2 - x) * 0.04
      y = y + (size / 2 - y) * 0.04
      local fromMiddle = math.sqrt((x - size / 2) ^ 2 + (y - size / 2) ^ 2) / (size / 2)
      local fade = math.max(0, 1 - fromMiddle) ^ 1.5
      local t = rng:random()
      local r = c1[1] + (c2[1] - c1[1]) * t
      local g = c1[2] + (c2[2] - c1[2]) * t
      local b = c1[3] + (c2[3] - c1[3]) * t
      -- (Many big faint dabs blend into a smooth cloud; and none reaches
      -- the canvas's edge, which would show as a straight line.)
      local radius = math.min(60 + rng:random() * 90, size / 2 * (1 - fromMiddle) - 2)
      if radius > 4 then
        dot(x, y, radius, r, g, b, (0.025 + rng:random() * 0.035) * fade)
      end
    end
  end
  for _ = 1, 8 do
    local x, y = size / 2 + gauss(rng) * 50, size / 2 + gauss(rng) * 50
    dot(x, y, 3 + rng:random() * 6, c3[1], c3[2], c3[3], 0.18)
  end
  love.graphics.setBlendMode("alpha")
  love.graphics.setCanvas()
  return { image = canvas, blend = "add" }
end

-- A dense band of distant stars, glowing faintly warm between them.
-- Drawn additively.
local function makeStarBand()
  -- (Big enough that its stars stay fine points drawn at full size —
  -- a smaller canvas blown up turns them into big soft dots.)
  local w, h = 2048, 768
  local canvas = love.graphics.newCanvas(w, h)
  local rng = love.math.newRandomGenerator(77)
  love.graphics.setCanvas(canvas)
  love.graphics.clear(0, 0, 0, 0)
  love.graphics.setBlendMode("add")
  -- The glow.
  for _ = 1, 90 do
    local x = w / 2 + gauss(rng) * w * 0.15
    local y = h / 2 + gauss(rng) * h * 0.08
    dot(x, y, 120 + rng:random() * 140, 1, 0.82, 0.6, 0.03)
  end
  -- The stars: thickest along the middle of the band, most of them faint.
  for _ = 1, 7000 do
    local x = w / 2 + gauss(rng) * w * 0.18
    local y = h / 2 + gauss(rng) * h * 0.1
    local warm = rng:random()
    love.graphics.setColor(1, 0.85 + 0.15 * warm, 0.75 + 0.25 * warm, 0.15 + rng:random() ^ 3 * 0.75)
    love.graphics.points(x, y)
  end
  love.graphics.setBlendMode("alpha")
  love.graphics.setCanvas()
  return { image = canvas, blend = "add" }
end

-- A dark lane of dust: winding filaments of dark blobs, thickest along
-- the middle, tapering to nothing at the ends. Drawn over what's behind
-- it (hiding it), not as light.
local function makeDust(spec)
  local w, h = 512, 192
  local canvas = love.graphics.newCanvas(w, h)
  local rng = love.math.newRandomGenerator(spec.seed or 1)
  love.graphics.setCanvas(canvas)
  love.graphics.clear(0, 0, 0, 0)
  love.graphics.setBlendMode("alpha")
  for strand = 1, 4 do
    local y = h / 2 + (strand - 2.5) * 16 + gauss(rng) * 6
    local x = 20
    local drift = (rng:random() - 0.5) * 0.6
    while x < w - 20 do
      drift = drift + (rng:random() - 0.5) * 0.35
      drift = math.max(-0.8, math.min(0.8, drift))
      y = y + drift * 6 + (h / 2 - y) * 0.03
      local along = x / w
      local taper = math.sin(along * math.pi) ^ 1.2
      -- (Kept off the canvas's edges, which would show as straight lines.)
      local radius = math.min((14 + rng:random() * 30) * (0.5 + 0.5 * taper), y - 2, h - y - 2, x - 2, w - x - 2)
      if radius > 2 then dot(x, y, radius, 0.03, 0.02, 0.015, 0.22 * taper) end
      x = x + 5 + rng:random() * 5
    end
  end
  love.graphics.setCanvas()
  return { image = canvas, blend = "alpha", premultiplied = true }
end

-- A spiral galaxy: a bright core, and two arms of soft light winding out
-- from it. Drawn additively.
local function makeGalaxy()
  local size = 256
  local canvas = love.graphics.newCanvas(size, size)
  local rng = love.math.newRandomGenerator(5)
  local c = size / 2
  love.graphics.setCanvas(canvas)
  love.graphics.clear(0, 0, 0, 0)
  love.graphics.setBlendMode("add")
  for arm = 0, 1 do
    for i = 1, 260 do
      local t = i / 260
      local a = arm * math.pi + t * math.pi * 3.2
      local r = 6 + t * 105
      local x = c + math.cos(a) * r + gauss(rng) * (3 + t * 9)
      local y = c + math.sin(a) * r * 0.55 + gauss(rng) * (3 + t * 6)
      dot(x, y, 4 + rng:random() * 8, 0.75, 0.82, 1, 0.16 * (1 - t * 0.6))
    end
  end
  dot(c, c, 34, 1, 0.92, 0.75, 0.6, 1.4)
  dot(c, c, 12, 1, 1, 0.95, 0.9, 1.3)
  love.graphics.setBlendMode("alpha")
  love.graphics.setCanvas()
  return { image = canvas, blend = "add" }
end

local MAKERS = {
  nebula = makeNebula, starband = makeStarBand, dust = makeDust,
  galaxy = makeGalaxy,
}

-- Each piece's art: a PNG from img/sky/ if there is one, otherwise its
-- placeholder.
local art = nil
local function getArt()
  if art then return art end
  art = {}
  love.graphics.push("all")
  love.graphics.origin()
  for _, spec in ipairs(SCENERY) do
    local path = "img/sky/" .. spec.name .. ".png"
    if love.filesystem.getInfo(path) then
      local image = love.graphics.newImage(path)
      image:setFilter("linear", "linear")
      art[spec] = { image = image, blend = "alpha" }
    else
      art[spec] = MAKERS[spec.kind](spec)
      art[spec].image:setFilter("linear", "linear")
    end
  end
  love.graphics.pop()
  return art
end

----------------------------------------------------------------------
-- Drawing
----------------------------------------------------------------------

function SkyRegions.sunPos()
  if state.sun and state.sun.pos then return state.sun.pos.x, state.sun.pos.y end
  return require("lua.setup.WorldGen").sunPos()
end

local function lerp3(a, b, t)
  return { a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t }
end

local function smoothstep(a, b, x)
  local t = math.max(0, math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
end

-- The sky's gradient colours right now (top, bottom), for the view
-- centred at (vx, vy) in the world.
function SkyRegions.skyColors(vx, vy)
  local sx, sy = SkyRegions.sunPos()
  local dx, dy = vx - sx, vy - sy
  local dist = math.sqrt(dx * dx + dy * dy)
  local ux, uy = 0, -1
  if dist > 1 then ux, uy = dx / dist, dy / dist end
  -- (Each direction's share: how much the view's that way from the sun.)
  local weights = {
    north = math.max(0, -uy) ^ 2, east = math.max(0, ux) ^ 2,
    south = math.max(0, uy) ^ 2, west = math.max(0, -ux) ^ 2,
  }
  local total = weights.north + weights.east + weights.south + weights.west
  local top, bottom = { 0, 0, 0 }, { 0, 0, 0 }
  for region, w in pairs(weights) do
    local sky = REGION_SKIES[region]
    for i = 1, 3 do
      top[i] = top[i] + sky[1][i] * w / total
      bottom[i] = bottom[i] + sky[2][i] * w / total
    end
  end
  local warm = 1 - smoothstep(SUN_SKY_NEAR, SUN_SKY_FAR, dist)
  top, bottom = lerp3(top, SUN_SKY[1], warm), lerp3(bottom, SUN_SKY[2], warm)
  local dim = 1 - FAR_DARKEN * smoothstep(FAR_START, FAR_FULL, dist)
  for i = 1, 3 do top[i], bottom[i] = top[i] * dim, bottom[i] * dim end
  return top, bottom
end

-- Draws the scenery in `layer` ("far" or "dust"), for the view centred
-- at (vx, vy) in the world. Screen space.
function SkyRegions.draw(layer, vx, vy)
  local pieces = getArt()
  local sx, sy = SkyRegions.sunPos()
  local screenW, screenH = love.graphics.getWidth(), love.graphics.getHeight()
  love.graphics.push("all")
  for _, spec in ipairs(SCENERY) do
    if (spec.layer or "far") == layer then
      local piece = pieces[spec]
      local img = piece.image
      local scale = spec.width / img:getWidth()
      local halfDiag = math.sqrt(img:getWidth() ^ 2 + img:getHeight() ^ 2) * scale / 2
      local x = screenW / 2 + (sx + spec.at[1] - vx) * spec.parallax
      local y = screenH / 2 + (sy + spec.at[2] - vy) * spec.parallax
      if x > -halfDiag and x < screenW + halfDiag and y > -halfDiag and y < screenH + halfDiag then
        if piece.blend == "add" then
          -- (Its light was already weighted by each dab's own strength
          -- as it was painted — so it's added as it is, not dimmed again
          -- by the canvas's leftover alpha.)
          love.graphics.setBlendMode("add", "premultiplied")
          love.graphics.setColor(spec.alpha, spec.alpha, spec.alpha, 1)
        elseif piece.premultiplied then
          love.graphics.setBlendMode("alpha", "premultiplied")
          love.graphics.setColor(spec.alpha, spec.alpha, spec.alpha, spec.alpha)
        else
          love.graphics.setBlendMode("alpha")
          love.graphics.setColor(1, 1, 1, spec.alpha)
        end
        love.graphics.draw(img, x, y, spec.angle or 0, scale, scale, img:getWidth() / 2, img:getHeight() / 2)
      end
    end
  end
  love.graphics.pop()
end

return SkyRegions
