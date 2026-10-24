-- lua/world/BackgroundAsteroids.lua
--
-- Asteroids far off in the background: dark silhouettes against the
-- sky, nebulae and distant stars, each with a faint edge of light on
-- the side facing the sun — drifting and slowly tumbling. Scenery only:
-- nothing collides with them, and nothing's kept about them.
--
-- Where each one is is worked out fresh every frame from the time alone
-- (see positionAt): it has a starting spot, a drift and a spin, all
-- picked from its own number when the game starts (the same every
-- time), and at time t it's simply been drifting at that speed for t
-- seconds — wrapped round a big repeating patch of sky (PATCH), the way
-- the stars are, so they keep going for ever. No coordinates stored or
-- updated, ever.
--
-- Drawn by Starfield.lua in screen space, in front of every star (and
-- sliding faster than any of them as the view moves, as nearer things
-- do), but still behind the whole world itself.

local BackgroundAsteroids = {}

local COUNT = 300
-- The repeating patch of sky they drift round, screen pixels: big
-- enough that only a handful are on screen at once.
local PATCH = 7000 -- (at COUNT 300, about 15 to 30 on screen)
-- How far off they are: how fast they slide as the view moves (screen
-- pixels per world unit — the stars' layers go 0.08 to 0.55, and these
-- are in front of them, so faster).
local PARALLAX_MIN, PARALLAX_MAX = 0.6, 0.85
-- Their size, screen pixels across (the further, the smaller).
local SIZE_MIN, SIZE_MAX = 10, 52
-- How fast they drift (screen pixels a second) and tumble (radians a second).
local DRIFT_MIN, DRIFT_MAX = 3, 16
local SPIN_MAX = 0.25
-- How dark against the sky (0 = the sky's own colour, 1 = black), and
-- the light on their sunward edge.
local DARKNESS_FAR, DARKNESS_NEAR = 0.2, 0.5 -- the furthest are hazy, barely darker than the sky
local RIM_COLOR = { 1.0, 0.82, 0.6 }
local RIM_ALPHA_FAR, RIM_ALPHA_NEAR = 0.04, 0.16
local RIM_WIDTH = 0.08 -- of its size

-- Their shapes: SHAPES lumpy outlines (shared between them all, each
-- drawn at its own size and angle), each made once into a small image
-- with a soft, blurred edge — BLUR of its radius either side of the
-- outline — so they look hazy and far off.
local SHAPES = 16
local SHAPE_IMAGE_SIZE = 96
local BLUR = 0.55

local rocks = nil
local shapes = nil
local startTime = nil

-- (For the lit edge: a stencil of just the solid middle of a soft
-- image — see draw.)
local solidMiddleShader = nil

local function smoothstep(a, b, x)
  local t = math.max(0, math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
end

-- One lumpy outline as a soft image: white, its alpha 1 inside the
-- outline fading to 0 across BLUR either side of it.
local function makeShape(rng)
  local n = 10 + math.floor(rng:random() * 6)
  local radii = {}
  local phase = rng:random() * 10
  local squash = 0.7 + 0.3 * rng:random()
  for k = 1, n do
    local a = (k - 1) / n * math.pi * 2
    -- (Lumpy: a couple of slow bulges, and a little roughness.)
    radii[k] = (0.78 + 0.14 * math.sin(a * 2 + phase) + 0.08 * math.sin(a * 3 + phase * 2)
      + (rng:random() - 0.5) * 0.12)
  end
  local S = SHAPE_IMAGE_SIZE
  -- (The outline's average radius in the image: room left round it for
  -- the blur.)
  local R = S / 2 / (1 + BLUR) * 0.92
  local data = love.image.newImageData(S, S)
  data:mapPixel(function(x, y)
    local dx, dy = x + 0.5 - S / 2, (y + 0.5 - S / 2) / squash
    local a = math.atan2(dy, dx) % (math.pi * 2)
    local f = a / (math.pi * 2) * n
    local k = math.floor(f)
    local t = f - k
    local edge = R * (radii[k % n + 1] * (1 - t) + radii[(k + 1) % n + 1] * t)
    local d = math.sqrt(dx * dx + dy * dy)
    local alpha = 1 - smoothstep(edge * (1 - BLUR), edge * (1 + BLUR), d)
    return 1, 1, 1, alpha
  end)
  local image = love.graphics.newImage(data)
  image:setFilter("linear", "linear")
  -- (How much to scale it by to draw it `size` pixels across.)
  return { image = image, unit = 2 * R }
end

-- Each one's shape and its fixed motion, from its own number.
local function build()
  rocks = {}
  local rng = love.math.newRandomGenerator(4242)
  shapes = {}
  for k = 1, SHAPES do shapes[k] = makeShape(rng) end
  solidMiddleShader = love.graphics.newShader([[
    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 px) {
      if (Texel(tex, uv).a < 0.6) discard;
      return vec4(1.0);
    }
  ]])
  for i = 1, COUNT do
    local depth = rng:random() -- 0 far .. 1 near
    local size = SIZE_MIN + (SIZE_MAX - SIZE_MIN) * depth ^ 1.5
    local heading = rng:random() * math.pi * 2
    local drift = DRIFT_MIN + (DRIFT_MAX - DRIFT_MIN) * rng:random() * (0.4 + 0.6 * depth)
    rocks[i] = {
      shape = shapes[math.floor(rng:random() * SHAPES) + 1],
      size = size,
      parallax = PARALLAX_MIN + (PARALLAX_MAX - PARALLAX_MIN) * depth,
      x0 = rng:random() * PATCH, y0 = rng:random() * PATCH,
      vx = math.cos(heading) * drift, vy = math.sin(heading) * drift,
      angle0 = rng:random() * math.pi * 2,
      spin = (rng:random() * 2 - 1) * SPIN_MAX,
      darkness = DARKNESS_FAR + (DARKNESS_NEAR - DARKNESS_FAR) * depth,
      rimAlpha = RIM_ALPHA_FAR + (RIM_ALPHA_NEAR - RIM_ALPHA_FAR) * depth,
    }
  end
  rocks.depthOrder = {}
  for i = 1, COUNT do rocks.depthOrder[i] = rocks[i] end
  -- (Furthest first, so nearer ones pass in front of them.)
  table.sort(rocks.depthOrder, function(a, b) return a.parallax < b.parallax end)
end

-- Where rock `rock` is on screen at time t (seconds) with the camera at
-- (camX, camY), within one PATCH — and its angle. Nothing but arithmetic
-- on its fixed numbers.
local function positionAt(rock, t, camX, camY)
  local x = (rock.x0 + rock.vx * t - camX * rock.parallax) % PATCH
  local y = (rock.y0 + rock.vy * t - camY * rock.parallax) % PATCH
  return x, y, rock.angle0 + rock.spin * t
end

-- Draws them. camX/camY: the camera's top-left in the world (as the
-- stars use it). sunDirX/Y: which way the sun is from the view, on
-- screen (for the lit edge) — or nil if it's right there.
--
-- Each silhouette darkens whatever's behind it (by its `darkness`)
-- rather than painting over it in a colour of its own: against a bright
-- nebula or the star band it stands out dark, against bare sky it's
-- only faintly there — like real rock in front of them. Its lit edge is
-- a copy of it nudged toward the sun, kept to just the sliver outside
-- the silhouette (a stencil), so it never shows through it.
function BackgroundAsteroids.draw(camX, camY, sunDirX, sunDirY)
  if not rocks then build() end
  startTime = startTime or love.timer.getTime()
  local t = love.timer.getTime() - startTime
  local screenW, screenH = love.graphics.getWidth(), love.graphics.getHeight()

  love.graphics.push("all")
  for _, rock in ipairs(rocks.depthOrder) do
    local px, py, angle = positionAt(rock, t, camX, camY)
    local s = rock.size
    -- (Repeated across the window the way the stars are, should it ever
    -- be wider or taller than one PATCH.)
    -- (Starting a whole patch back, so one just past the patch's edge
    -- still shows partly in at the window's left or top.)
    local y = py - PATCH
    while y < screenH + s do
      local x = px - PATCH
      while x < screenW + s do
        if x > -s and y > -s then
          local cx, cy = x, y
          local img = rock.shape.image
          local k = s / rock.shape.unit
          local ox, oy = img:getWidth() / 2, img:getHeight() / 2
          if sunDirX then
            -- (The stencil: just its solid middle, not its soft edge.)
            love.graphics.stencil(function()
              love.graphics.setShader(solidMiddleShader)
              love.graphics.draw(img, cx, cy, angle, k, k, ox, oy)
              love.graphics.setShader()
            end, "replace", 1)
            love.graphics.setStencilTest("equal", 0)
            love.graphics.setBlendMode("add")
            love.graphics.setColor(RIM_COLOR[1], RIM_COLOR[2], RIM_COLOR[3], rock.rimAlpha)
            love.graphics.draw(img, cx + sunDirX * s * RIM_WIDTH, cy + sunDirY * s * RIM_WIDTH, angle, k, k, ox, oy)
            love.graphics.setBlendMode("alpha")
            love.graphics.setStencilTest()
          end
          love.graphics.setColor(0, 0, 0, rock.darkness)
          love.graphics.draw(img, cx, cy, angle, k, k, ox, oy)
        end
        x = x + PATCH
      end
      y = y + PATCH
    end
  end
  love.graphics.pop()
end

return BackgroundAsteroids
