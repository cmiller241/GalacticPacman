-- lua/effects/BibleShrine.lua
--
-- The Bible in the middle of Bob's ship (see lua/interiors/ShipInterior.lua
-- and docs/Plot.md): an open Bible hovering in a beam of light over a
-- pedestal. A shader draws the light (a soft halo with slowly turning
-- rays, and the beam with shimmering streaks running up it). Little
-- motes of light circle the book, weaving up and down as they go, and a
-- few more drift up the beam.
--
-- BibleShrine.draw(x, floorY, ceilingY, t): x is the pedestal's middle,
-- floorY the floor it stands on and ceilingY the underside of the floor
-- above (where the beam ends), all in world space; t is the time.

local state = require("lua.state")

local BibleShrine = {}

----------------------------------------------------------------------
-- Tunables (world units)
----------------------------------------------------------------------

local PEDESTAL_HEIGHT = 52
local HOVER = 52               -- how far above the pedestal the book floats
local BOB_HEIGHT = 4           -- how far it bobs up and down
local BOB_SPEED = 1.6
local SWAY = 0.05              -- how far it tilts (radians) as it bobs

-- The book: its cover's size, and how thick it is (how far the back
-- cover sits behind the front).
local BOOK_W, BOOK_H = 40, 52
local BOOK_DEPTH = 7

local HALO_RADIUS = 52
local LIGHT_BOX = 130          -- half the size of the square the light is drawn on
local BEAM_HALF_WIDTH = 34

-- Motes circling the book: how many, how wide the circle, how far each
-- weaves up and down.
local ORBIT_MOTES = 14
local ORBIT_RADIUS = 50
local ORBIT_TILT = 0.28        -- how flat the circle looks (it's seen nearly edge-on)
local WEAVE = 14
-- Motes drifting up the beam.
local BEAM_MOTES = 6

local COLOR_OUTLINE = { 0.04, 0.04, 0.08, 1 }
local COLOR_METAL = { 0.36, 0.39, 0.50, 1 }
local COLOR_METAL_LIGHT = { 0.52, 0.56, 0.68, 1 }
local COLOR_GOLD = { 0.95, 0.75, 0.32, 1 }
local COLOR_COVER = { 0.42, 0.10, 0.09, 1 }
local COLOR_COVER_DARK = { 0.26, 0.06, 0.06, 1 }
local COLOR_PAGE = { 1.00, 0.96, 0.84, 1 }
local COLOR_PAGE_LINE = { 0.80, 0.68, 0.45, 1 }
local COLOR_RIBBON = { 0.80, 0.12, 0.14, 1 }

----------------------------------------------------------------------
-- The light (shader)
----------------------------------------------------------------------

local shader = nil
local function getShader()
  if shader then return shader end
  shader = love.graphics.newShader([[
    extern vec2 originScreen;   // the square's top-left corner, in screen pixels
    extern number zoom;
    extern number boxHalf;      // half the square's size (world units); the book is in its middle
    extern number time;
    extern number haloRadius;
    extern number beamHalfWidth;
    extern number beamTop;      // where the beam starts and ends, relative to the book (y down)
    extern number beamBottom;

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec2 p = (screen - originScreen) / zoom - vec2(boxHalf, boxHalf);
      float d = length(p);

      // The halo: a bright core, a wider soft glow that breathes, and
      // rays turning slowly round it (two sets, turning opposite ways).
      float halo = exp(-d * d / (haloRadius * haloRadius)) * (0.85 + 0.15 * sin(time * 2.0));
      float core = exp(-d * d / (0.2 * haloRadius * haloRadius));
      float a = atan(p.y, p.x);
      float rays = pow(0.5 + 0.5 * sin(a * 7.0 + time * 0.5), 6.0) * 0.6
                 + pow(0.5 + 0.5 * sin(a * 11.0 - time * 0.8), 8.0) * 0.4;
      rays *= exp(-d / (haloRadius * 1.2)) * smoothstep(haloRadius * 0.2, haloRadius * 0.6, d);

      // The beam: soft-edged across, fading in at the top, with streaks
      // running up it.
      float across = abs(p.x) / beamHalfWidth;
      float beam = 1.0 - smoothstep(0.25, 1.0, across);
      beam *= smoothstep(beamTop, beamTop + 30.0, p.y) * (1.0 - smoothstep(beamBottom - 4.0, beamBottom, p.y));
      beam *= 0.7 + 0.3 * sin(p.x * 0.3 + time * 1.1) * sin(p.y * 0.07 + time * 3.0);

      float light = halo * 0.55 + core * 0.6 + rays * 0.5 + beam * 0.45;
      // (Nothing at the square's edges.)
      light *= 1.0 - smoothstep(boxHalf * 0.8, boxHalf, max(abs(p.x), abs(p.y)));

      vec3 gold = vec3(1.0, 0.80, 0.42);
      vec3 white = vec3(1.0, 0.98, 0.90);
      vec3 col = mix(gold, white, clamp(core + beam * 0.6, 0.0, 1.0));
      return vec4(col, clamp(light, 0.0, 1.0)) * color;
    }
  ]])
  return shader
end

local function drawLight(bx, by, floorTop, ceilingY, t)
  local sh = getShader()
  local zoom = state.zoom or 1
  local cam = state.camera or { x = 0, y = 0 }
  local x0, y0 = bx - LIGHT_BOX, by - LIGHT_BOX
  love.graphics.setShader(sh)
  sh:send("originScreen", { (x0 - cam.x) * zoom, (y0 - cam.y) * zoom })
  sh:send("zoom", zoom)
  sh:send("boxHalf", LIGHT_BOX)
  sh:send("time", t)
  sh:send("haloRadius", HALO_RADIUS)
  sh:send("beamHalfWidth", BEAM_HALF_WIDTH)
  sh:send("beamTop", ceilingY - by)
  sh:send("beamBottom", floorTop - by)
  love.graphics.setBlendMode("add")
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.rectangle("fill", x0, y0, LIGHT_BOX * 2, LIGHT_BOX * 2)
  love.graphics.setBlendMode("alpha")
  love.graphics.setShader()
end

----------------------------------------------------------------------
-- The pedestal and the book
----------------------------------------------------------------------

local function drawPedestal(x, floorY, t)
  local top = floorY - PEDESTAL_HEIGHT
  -- Outline, then the base, the column and the top plate.
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.rectangle("fill", x - 40, floorY - 14, 80, 14, 4, 4)
  love.graphics.polygon("fill", x - 22, floorY - 10, x + 22, floorY - 10, x + 17, top + 6, x - 17, top + 6)
  love.graphics.rectangle("fill", x - 36, top - 4, 72, 14, 5, 5)

  love.graphics.setColor(COLOR_METAL)
  love.graphics.rectangle("fill", x - 36, floorY - 11, 72, 9, 3, 3)
  love.graphics.polygon("fill", x - 18, floorY - 10, x + 18, floorY - 10, x + 13, top + 6, x - 13, top + 6)
  love.graphics.setColor(COLOR_METAL_LIGHT)
  love.graphics.polygon("fill", x - 18, floorY - 10, x - 9, floorY - 10, x - 6, top + 6, x - 13, top + 6)
  love.graphics.rectangle("fill", x - 32, top - 1, 64, 8, 3, 3)

  -- Gold trim, and the light it gives off on top.
  love.graphics.setColor(COLOR_GOLD)
  love.graphics.rectangle("fill", x - 36, floorY - 13, 72, 3, 1, 1)
  love.graphics.rectangle("fill", x - 32, top + 5, 64, 2)
  local pulse = 0.75 + 0.25 * math.sin(t * 2)
  love.graphics.setColor(1, 0.92, 0.65, pulse)
  love.graphics.ellipse("fill", x, top - 1, 24, 4)
end

-- The closed Bible, its middle at (0, 0) (drawn already moved and
-- tilted): standing up with its cover toward us, a gold cross on it.
-- Behind the cover, the back cover and the pages' edges show a little
-- to the right and below, so it looks like a book and not a card.
local function drawBook(t)
  local g = love.graphics
  local hw, hh = BOOK_W / 2, BOOK_H / 2

  -- The ribbon, hanging out of the bottom and swaying.
  local swing = math.sin(t * 1.3) * 2
  g.setColor(COLOR_RIBBON)
  g.setLineWidth(3)
  g.line(hw - 6, hh, hw - 6 + swing * 0.5, hh + 5, hw - 6 + swing, hh + 10)

  -- The back cover, then the pages' edges (with lines along them).
  local bx, by = BOOK_DEPTH, BOOK_DEPTH * 0.6
  g.setColor(COLOR_OUTLINE)
  g.rectangle("fill", -hw - 3 + bx, -hh - 3 + by, BOOK_W + 6, BOOK_H + 6, 5, 5)
  g.setColor(COLOR_COVER_DARK)
  g.rectangle("fill", -hw + bx, -hh + by, BOOK_W, BOOK_H, 3, 3)
  g.setColor(COLOR_PAGE)
  g.rectangle("fill", -hw + bx * 0.5 + 2, -hh + by * 0.5 + 2, BOOK_W - 3, BOOK_H - 3)
  g.setColor(COLOR_PAGE_LINE)
  g.setLineWidth(1)
  for k = 1, 3 do
    local f = k / 4
    g.line(hw + bx * f, -hh + 3 + by * f, hw + bx * f, hh - 1 + by * f)
    g.line(-hw + 4 + bx * f, hh + by * f, hw + bx * f, hh + by * f)
  end

  -- The front cover: leather, a darker spine down its left side, a
  -- gold border, and a soft sheen across its top.
  g.setColor(COLOR_OUTLINE)
  g.rectangle("fill", -hw - 3, -hh - 3, BOOK_W + 6, BOOK_H + 6, 5, 5)
  g.setColor(COLOR_COVER)
  g.rectangle("fill", -hw, -hh, BOOK_W, BOOK_H, 3, 3)
  g.setColor(COLOR_COVER_DARK)
  g.rectangle("fill", -hw, -hh, 6, BOOK_H, 3, 3)
  g.setColor(COLOR_GOLD)
  g.setLineWidth(1.5)
  g.rectangle("line", -hw + 9, -hh + 4, BOOK_W - 13, BOOK_H - 8, 2, 2)
  g.setColor(1, 1, 1, 0.08)
  g.polygon("fill", -hw + 6, -hh, hw, -hh, hw, -hh + 10, -hw + 6, -hh + 22)

  -- The cross: outlined, then gold, then glowing (brightening and
  -- dimming, with a soft larger glow round it).
  local cx = 2.5 -- (the middle of the cover, past the spine)
  local function cross(grow)
    g.rectangle("fill", cx - 3 - grow, -16 - grow, 6 + grow * 2, 32 + grow * 2, 1, 1)
    g.rectangle("fill", cx - 11 - grow, -8 - grow, 22 + grow * 2, 6 + grow * 2, 1, 1)
  end
  g.setColor(COLOR_OUTLINE)
  cross(1.5)
  g.setColor(COLOR_GOLD)
  cross(0)
  g.setColor(1, 0.95, 0.75, 1)
  g.rectangle("fill", cx - 3, -16, 2, 32)
  g.rectangle("fill", cx - 11, -8, 22, 2)

  g.setBlendMode("add")
  local glow = 0.5 + 0.5 * math.sin(t * 2.4)
  g.setColor(1, 0.85, 0.5, 0.10 + 0.08 * glow)
  cross(5)
  g.setColor(1, 0.85, 0.5, 0.18 + 0.12 * glow)
  cross(2.5)
  g.setColor(1, 0.95, 0.8, 0.25 + 0.25 * glow)
  cross(0)
  g.setBlendMode("alpha")
end

----------------------------------------------------------------------
-- The motes
----------------------------------------------------------------------

-- One mote of light: a soft dot (three circles, added on), size s.
local function drawMote(x, y, s, alpha)
  love.graphics.setColor(1, 0.80, 0.42, 0.14 * alpha)
  love.graphics.circle("fill", x, y, 7 * s)
  love.graphics.setColor(1, 0.88, 0.60, 0.35 * alpha)
  love.graphics.circle("fill", x, y, 3.6 * s)
  love.graphics.setColor(1, 1, 0.95, alpha)
  love.graphics.circle("fill", x, y, 1.7 * s)
end

-- The circling motes on one side of the book: behind it (front false)
-- or in front of it. Each goes round at its own speed and distance,
-- weaving up and down as it goes.
local function drawOrbitMotes(bx, by, t, front)
  love.graphics.setBlendMode("add")
  for i = 1, ORBIT_MOTES do
    local speed = 0.55 + 0.3 * ((i * 0.618) % 1)
    local a = t * speed + i / ORBIT_MOTES * math.pi * 2
    local depth = math.sin(a)  -- 1 nearest us, -1 farthest
    if (depth >= 0) == front then
      local r = ORBIT_RADIUS + 10 * math.sin(i * 1.7)
      local x = bx + math.cos(a) * r
      local y = by + depth * r * ORBIT_TILT + math.sin(t * 1.9 + i * 1.3) * WEAVE
      local s = 0.8 + 0.25 * depth
      local twinkle = 0.75 + 0.25 * math.sin(t * 5 + i * 2.1)
      drawMote(x, y, s, (0.65 + 0.35 * depth) * twinkle)
    end
  end
  love.graphics.setBlendMode("alpha")
end

-- Motes drifting up the beam from the pedestal to the ceiling, weaving
-- side to side, fading in and out at the ends.
local function drawBeamMotes(x, floorTop, ceilingY, t)
  love.graphics.setBlendMode("add")
  local height = floorTop - ceilingY
  for i = 1, BEAM_MOTES do
    local f = (t * 0.22 + i / BEAM_MOTES) % 1
    local y = floorTop - f * height
    local mx = x + math.sin(t * 2.2 + i * 2.4) * (BEAM_HALF_WIDTH * 0.45)
    local fade = math.sin(f * math.pi)
    drawMote(mx, y, 0.6, fade * 0.8)
  end
  love.graphics.setBlendMode("alpha")
end

----------------------------------------------------------------------
-- Drawing
----------------------------------------------------------------------

function BibleShrine.draw(x, floorY, ceilingY, t)
  local floorTop = floorY - PEDESTAL_HEIGHT
  local bob = math.sin(t * BOB_SPEED)
  local bx, by = x, floorTop - HOVER + bob * BOB_HEIGHT

  drawLight(bx, by, floorTop, ceilingY, t)
  drawPedestal(x, floorY, t)
  drawBeamMotes(x, floorTop, ceilingY, t)
  drawOrbitMotes(bx, by, t, false)

  love.graphics.push()
  love.graphics.translate(bx, by)
  love.graphics.rotate(math.cos(t * BOB_SPEED) * SWAY)
  drawBook(t)
  love.graphics.pop()

  drawOrbitMotes(bx, by, t, true)
  love.graphics.setColor(1, 1, 1, 1)
end

return BibleShrine
