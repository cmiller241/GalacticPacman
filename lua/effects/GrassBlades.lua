-- lua/effects/GrassBlades.lua
--
-- Little tufts of grass blades poking up out of a Tiled level's grassy
-- ground, swaying gently. Purely decoration: built once when the level is
-- loaded (see lua/levels/DomeInterior.lua) and drawn just after the
-- level's tiles (see love.draw), so they sit in front of the grass art
-- and behind Bob.
--
-- Where they go: along every floor-facing stretch of the level's walkable
-- ground (not walls or ceilings), every TUFT_SPACING units there's a
-- TUFT_CHANCE of a tuft — but only where the tile art right under that
-- spot is actually grass (green), so stone, obsidian and the like stay
-- bare. Each tuft takes its colour from that grass. Placement comes from
-- its own random generator, seeded from the level, so the tufts are in
-- the same places every time (and the game's own random numbers aren't
-- touched).

local utils = require("lua.utils")

local GrassBlades = {}

-- Placement.
local TUFT_SPACING = 14        -- world units between chances of a tuft along the ground
local TUFT_CHANCE = 0.19       -- the chance at each
local BLADES_MIN, BLADES_MAX = 2, 5
local TUFT_SPREAD = 9          -- blades sit up to this far either side of the tuft's middle
local MAX_SLOPE_UP = 0.6       -- ground counts as floor if its normal points at least this much up (~53 degrees)
-- Blade shape.
local HEIGHT_MIN, HEIGHT_MAX = 9, 24
local WIDTH_MIN, WIDTH_MAX = 2.6, 4.4
local LEAN_MAX = 0.35          -- radians a blade leans either way at rest
local CURL = 0.45              -- how much more the tip leans than the middle (a gentle curve)
local ROOT_DEPTH = 3           -- how far below the ground line a blade starts (so it grows out of it)
local PIXEL = 2                -- world units per grass pixel: the tile art's own (32-px tiles drawn 64 wide)
-- In front: this share of tufts draws after Bob and the Ooombas (see
-- GrassBlades.draw's `front`), a bit shorter so they hide less of him.
local FRONT_CHANCE = 0.3
local FRONT_HEIGHT_SCALE = 0.75
local EDGE_SHADE = 0.9         -- a blade's right-hand pixel, where it's 3+ pixels wide
-- Sway.
local SWAY_AMOUNT = 0.16       -- radians
local SWAY_SPEED = 1.7         -- radians of sway phase per second
-- Colour: the grass under the tuft, a touch lighter, tips lighter still
-- (no outline, so they blend into the grass they grow from).
local TIP_TINT = { 0.85, 0.95, 0.35 }

local TILE_WORLD = 64
local TILE_SOURCE = 32
local FLIP_H, FLIP_V = 2 ^ 31, 2 ^ 30

local function findTileset(tilesets, gid)
  local best = nil
  for _, ts in ipairs(tilesets) do
    if ts.firstgid <= gid and (not best or ts.firstgid > best.firstgid) then best = ts end
  end
  return best
end

-- The colour of the level's art at world (x, y): the front-most tile
-- layer with something opaque there. Returns r, g, b, or nil.
local function artColorAt(level, sheet, x, y)
  local col = math.floor((x - level.anchorX) / TILE_WORLD)
  local row = math.floor((y - level.anchorY) / TILE_WORLD)
  if col < 0 or row < 0 or col >= level.mapWidth or row >= level.mapHeight then return nil end
  local u = math.floor((x - level.anchorX - col * TILE_WORLD) / TILE_WORLD * TILE_SOURCE)
  local v = math.floor((y - level.anchorY - row * TILE_WORLD) / TILE_WORLD * TILE_SOURCE)
  local sw, sh = sheet:getDimensions()
  for li = #level.tileLayers, 1, -1 do
    local raw = level.tileLayers[li].data[row * level.mapWidth + col + 1] or 0
    local gid = raw % 2 ^ 29
    if gid ~= 0 then
      local ts = findTileset(level.tilesets, gid)
      if ts then
        local index = gid - ts.firstgid
        local columns = ts.columns or 9
        local tu = (math.floor(raw / FLIP_H) % 2 == 1) and (TILE_SOURCE - 1 - u) or u
        local tv = (math.floor(raw / FLIP_V) % 2 == 1) and (TILE_SOURCE - 1 - v) or v
        local sx = (index % columns) * TILE_SOURCE + tu
        local sy = math.floor(index / columns) * TILE_SOURCE + tv
        if sx >= 0 and sy >= 0 and sx < sw and sy < sh then
          local r, g, b, a = sheet:getPixel(sx, sy)
          if a > 0.5 then return r, g, b end
        end
      end
    end
  end
  return nil
end

local function isGrass(r, g, b)
  return r and g > 0.3 and g > r * 1.1 and g > b * 1.3
end

-- One tuft at (px, py) on ground with normal (nx, ny) pointing up out of
-- it and tangent (tx, ty), in grass colour (r, g, b).
local function makeTuft(rng, px, py, nx, ny, tx, ty, r, g, b)
  local front = rng:random() < FRONT_CHANCE
  local tuft = { x = px, y = py, nx = nx, ny = ny, tx = tx, ty = ty, front = front, blades = {} }
  local heightScale = front and FRONT_HEIGHT_SCALE or 1
  for _ = 1, rng:random(BLADES_MIN, BLADES_MAX) do
    local shade = 0.98 + rng:random() * 0.14
    local tipMix = 0.3 + rng:random() * 0.3
    local base = { math.min(1, r * shade), math.min(1, g * shade), math.min(1, b * shade) }
    local tip = { r + (TIP_TINT[1] - r) * tipMix, g + (TIP_TINT[2] - g) * tipMix, b + (TIP_TINT[3] - b) * tipMix }
    table.insert(tuft.blades, {
      offset = (rng:random() * 2 - 1) * TUFT_SPREAD,
      height = (HEIGHT_MIN + rng:random() * (HEIGHT_MAX - HEIGHT_MIN)) * heightScale,
      width = WIDTH_MIN + rng:random() * (WIDTH_MAX - WIDTH_MIN),
      lean = (rng:random() * 2 - 1) * LEAN_MAX,
      phase = rng:random() * math.pi * 2,
      -- Three bands of colour up the blade, pixel-art style.
      colors = { base, { (base[1] + tip[1]) / 2, (base[2] + tip[2]) / 2, (base[3] + tip[3]) / 2 }, tip },
    })
  end
  return tuft
end

-- The average colour of an image's grass-green pixels (for ground drawn
-- from one grass texture, like the sky dome's deck).
local function averageGrass(path)
  local img = love.image.newImageData(path)
  local w, h = img:getDimensions()
  local sr, sg, sb, n = 0, 0, 0, 0
  for y = 0, h - 1 do
    for x = 0, w - 1 do
      local r, g, b, a = img:getPixel(x, y)
      if a > 0.5 and isGrass(r, g, b) then sr, sg, sb, n = sr + r, sg + g, sb + b, n + 1 end
    end
  end
  if n == 0 then return 0.45, 0.7, 0.2 end
  return sr / n, sg / n, sb / n
end

-- Tufts along a flat stretch of ground from x0 to x1 at height y, in the
-- grass colour of the texture at grassPath (the sky dome's deck: see
-- SkyDomePlanetoid's grass cap). seed: anything, to vary the placement.
function GrassBlades.buildStrip(x0, x1, y, grassPath, seed)
  local r, g, b = averageGrass(grassPath)
  local rng = love.math.newRandomGenerator(math.floor(seed) + 101)
  local tufts = {}
  for x = x0 + TUFT_SPACING * 0.5, x1 - TUFT_SPACING * 0.5, TUFT_SPACING do
    if rng:random() < TUFT_CHANCE then
      table.insert(tufts, makeTuft(rng, x, y, 0, -1, 1, 0, r, g, b))
    end
  end
  return tufts
end

-- The tufts for a level loaded by TiledTerrain.load. sheetPath: its
-- tileset image (all of Level1's tilesets share img/platform.png).
function GrassBlades.build(level, sheetPath)
  local sheet = love.image.newImageData(sheetPath)
  local rng = love.math.newRandomGenerator(math.floor(level.anchorX) * 7919 + math.floor(level.anchorY) + 17)
  local tufts = {}
  for _, shape in ipairs(level.shapes or {}) do
    for _, seg in ipairs(shape.segments or {}) do
      local n = seg.normal
      if n and n.y <= -MAX_SLOPE_UP then
        local ax, ay, bx, by = seg.a.x, seg.a.y, seg.b.x, seg.b.y
        local len = math.sqrt((bx - ax) ^ 2 + (by - ay) ^ 2)
        if len > 1 then
          local tx, ty = (bx - ax) / len, (by - ay) / len
          for d = TUFT_SPACING * 0.5, len, TUFT_SPACING do
            if rng:random() < TUFT_CHANCE then
              local px, py = ax + tx * d, ay + ty * d
              -- The art just inside the ground there.
              local r, g, b = artColorAt(level, sheet, px - n.x * 5, py - n.y * 5)
              if isGrass(r, g, b) then
                table.insert(tufts, makeTuft(rng, px, py, n.x, n.y, tx, ty, r, g, b))
              end
            end
          end
        end
      end
    end
  end
  return tufts
end

-- The blade outline being drawn (reused, so drawing allocates nothing).
local polyX, polyY = {}, {}

-- Where the row y = yc crosses the blade outline: leftmost, rightmost x.
local function spanAt(yc)
  local lo, hi = math.huge, -math.huge
  for i = 1, 5 do
    local j = i % 5 + 1
    local y1, y2 = polyY[i], polyY[j]
    if (y1 <= yc and y2 > yc) or (y2 <= yc and y1 > yc) then
      local x = polyX[i] + (yc - y1) / (y2 - y1) * (polyX[j] - polyX[i])
      if x < lo then lo = x end
      if x > hi then hi = x end
    end
  end
  return lo, hi
end

-- Fills the blade outline in polyX/polyY as square PIXEL-sized cells on
-- the world grid, row by row: so it looks drawn in the same chunky
-- pixels as the tile art rather than as smooth shapes (and steps from
-- pixel to pixel as it sways). Root (bx, by), up the blade (dx, dy),
-- length h.
local function fillPixels(colors, bx, by, dx, dy, h)
  local ymin, ymax = math.huge, -math.huge
  for i = 1, 5 do
    if polyY[i] < ymin then ymin = polyY[i] end
    if polyY[i] > ymax then ymax = polyY[i] end
  end
  for row = math.floor(ymin / PIXEL), math.floor(ymax / PIXEL) do
    local yc = (row + 0.5) * PIXEL
    local lo, hi = spanAt(yc)
    if lo <= hi then
      local c0, c1 = math.floor(lo / PIXEL), math.floor(hi / PIXEL)
      -- How far up the blade this row is: picks its colour band.
      local f = (((lo + hi) * 0.5 - bx) * dx + (yc - by) * dy) / h
      local c = colors[f < 0.45 and 1 or (f < 0.75 and 2 or 3)]
      love.graphics.setColor(c[1], c[2], c[3], 1)
      if c1 - c0 >= 2 then
        love.graphics.rectangle("fill", c0 * PIXEL, row * PIXEL, (c1 - c0) * PIXEL, PIXEL)
        love.graphics.setColor(c[1] * EDGE_SHADE, c[2] * EDGE_SHADE, c[3] * EDGE_SHADE, 1)
        love.graphics.rectangle("fill", c1 * PIXEL, row * PIXEL, PIXEL, PIXEL)
      else
        love.graphics.rectangle("fill", c0 * PIXEL, row * PIXEL, (c1 - c0 + 1) * PIXEL, PIXEL)
      end
    end
  end
end

-- Draws a list of tufts (a level's or the dome deck's grassBlades), the
-- ones on screen. front: false/nil draws the ones behind the characters
-- (call in world space right after the ground they grow out of); true
-- draws the ones in front (call after Bob and the Ooombas).
function GrassBlades.draw(tufts, front)
  if not tufts then return end
  front = front or false
  local t = love.timer.getTime()
  for _, tuft in ipairs(tufts) do
    if tuft.front == front and utils.isOnScreen(tuft.x, tuft.y, HEIGHT_MAX + TUFT_SPREAD, 10) then
      local ux, uy = tuft.nx, tuft.ny -- (the ground's normal points up out of it: a blade's "up")
      for _, blade in ipairs(tuft.blades) do
        local sway = math.sin(t * SWAY_SPEED + blade.phase + tuft.x * 0.013) * SWAY_AMOUNT
        local a1 = blade.lean + sway
        local a2 = a1 * (1 + CURL) + sway * 0.5
        -- Directions: "up" (the normal) turned by a1 (middle) and a2 (tip).
        local c1, s1 = math.cos(a1), math.sin(a1)
        local c2, s2 = math.cos(a2), math.sin(a2)
        local d1x, d1y = ux * c1 - uy * s1, ux * s1 + uy * c1
        local d2x, d2y = ux * c2 - uy * s2, ux * s2 + uy * c2
        -- Root, just below the ground line.
        local bx = tuft.x + tuft.tx * blade.offset - ux * ROOT_DEPTH
        local by = tuft.y + tuft.ty * blade.offset - uy * ROOT_DEPTH
        local h, w = blade.height + ROOT_DEPTH, blade.width * 0.5
        local mx, my = bx + d1x * h * 0.55, by + d1y * h * 0.55
        local ex, ey = mx + d2x * h * 0.45, my + d2y * h * 0.45
        local px, py = -d1y, d1x -- (across the blade)
        local mw = w * 0.6
        polyX[1], polyY[1] = bx - px * w, by - py * w
        polyX[2], polyY[2] = mx - px * mw, my - py * mw
        polyX[3], polyY[3] = ex, ey
        polyX[4], polyY[4] = mx + px * mw, my + py * mw
        polyX[5], polyY[5] = bx + px * w, by + py * w
        fillPixels(blade.colors, bx, by, d1x, d1y, h)
      end
    end
  end
  love.graphics.setColor(1, 1, 1, 1)
end

return GrassBlades
