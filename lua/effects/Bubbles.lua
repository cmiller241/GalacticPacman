-- lua/effects/Bubbles.lua
--
-- Shared air-bubble trails for anything underwater (Player.lua, Fish.lua).
-- A bubble rises along a radial line away from its water body's center,
-- so it heads for the surface on any side of a round water planet, and
-- straight up in a pool (see WaterSystem.lua's poolWater). On the way it
-- sways and jiggles side to side, squashes a little, and swells as the
-- pressure drops; at the surface it domes up, then pops with a ripple
-- and a couple of flecks.
--
-- The look (a lit rim on the side facing the surface, a shaded rim
-- opposite, a see-through body, a highlight and a fleck of refracted
-- light, a soft glow, tiny ones drawn as glinting beads, and the
-- dome-then-ripple pop) is adapted from pixelfx's water/bubbles effect
-- (https://github.com/patch-gg/pixelfx), MIT License, Copyright (c) 2026
-- Patch, itself adapted from Sprite Fusion's open-source bubbles, MIT
-- License, Copyright (c) 2026 Hugo Duprez.

local Bubbles = {}

-- Motion. Frequencies are radians per baseline (60fps) frame.
local SWAY_FREQ_MIN, SWAY_FREQ_MAX     = 0.01, 0.03 -- slow side-to-side drift
local SWAY_DISTANCE                    = 7          -- world units at full swing, once fully risen
local WIGGLE_FREQ_MIN, WIGGLE_FREQ_MAX = 0.05, 0.10 -- quicker jiggle, which also drives the squash
local WIGGLE_PER_RADIUS                = 0.45       -- jiggle distance, as a multiple of the bubble's radius
local SWELL                            = 0.45       -- 0.45 = 45% bigger by the time it reaches the surface
local SQUASH                           = 0.12       -- how far out of round the jiggle stretches it
local SMALL_SHARE                      = 0.7        -- share of bubbles in the small half of the size range

-- The pop, in baseline frames.
local POP_DOME_TICKS   = 7  -- domes up through the surface (skipped by small bubbles)
local POP_RIPPLE_TICKS = 12 -- then a ripple spreads along the surface
local POP_DOME_MIN     = 1.4 -- radius below which a bubble skips the dome and flecks

-- Below this radius a bubble is a glinting bead, not a rimmed sphere.
local SMALL_RADIUS = 2

-- Darkest to lightest: the water planet's blues up to foam white.
local SHADE = { 0.22, 0.48, 0.72 }
local RIM   = { 0.48, 0.78, 0.94 }
local BODY  = { 0.72, 0.91, 1.00 }
local LIT   = { 0.88, 0.98, 1.00 }
local WHITE = { 1, 1, 1 }

-- Where the light comes from, in a bubble's own frame (+x points at the
-- surface): a little off-center, like pixelfx's top-left light.
local LIGHT_ANGLE = -0.55
local LX, LY = math.cos(LIGHT_ANGLE), math.sin(LIGHT_ANGLE)

local function setColor(c, a)
  love.graphics.setColor(c[1], c[2], c[3], a)
end

local function lerp(a, b, t)
  return a + (b - a) * t
end

-- 0 at the spawn point, 1 at the surface.
local function progress(b)
  local span = b.targetR - b.startR
  if span <= 0 then return 1 end
  return math.min(1, math.max(0, (b.r - b.startR) / span))
end

-- Adds a bubble to `list`, rising from startR to targetR (distances from
-- the water's center at cx, cy) along `angle`. cfg holds radiusMin/Max
-- (world units, before swelling) and riseMin/Max (world units per
-- baseline frame). Bigger bubbles rise faster, as they do in pixelfx.
function Bubbles.spawn(list, cx, cy, angle, startR, targetR, cfg)
  if startR >= targetR then return end
  local sizeT = math.random() < SMALL_SHARE and math.random() * 0.5 or 0.5 + math.random() * 0.5
  local riseT = 0.65 * sizeT + 0.35 * math.random()
  table.insert(list, {
    centerX = cx,
    centerY = cy,
    angle = angle,
    startR = startR,
    r = startR,
    targetR = targetR,
    radius = lerp(cfg.radiusMin, cfg.radiusMax, sizeT),
    riseSpeed = lerp(cfg.riseMin, cfg.riseMax, riseT),
    swayPhase = math.random() * math.pi * 2,
    swayFreq = lerp(SWAY_FREQ_MIN, SWAY_FREQ_MAX, math.random()),
    wigglePhase = math.random() * math.pi * 2,
    wiggleFreq = lerp(WIGGLE_FREQ_MIN, WIGGLE_FREQ_MAX, math.random()),
    popAge = nil, -- set once it reaches the surface
  })
end

function Bubbles.update(list, ts)
  for i = #list, 1, -1 do
    local b = list[i]
    if b.popAge then
      b.popAge = b.popAge + ts
      if b.popAge >= b.popTicks then table.remove(list, i) end
    else
      b.r = b.r + b.riseSpeed * ts
      b.swayPhase = b.swayPhase + b.swayFreq * ts
      b.wigglePhase = b.wigglePhase + b.wiggleFreq * ts
      if b.r >= b.targetR then
        -- Frozen where it broke the surface (the phases stop advancing).
        b.r = b.targetR
        b.popAge = 0
        b.popRadius = b.radius * (1 + SWELL)
        b.popTicks = (b.popRadius >= POP_DOME_MIN and POP_DOME_TICKS or 0) + POP_RIPPLE_TICKS
      end
    end
  end
end

-- World position: out along the radial line, pushed sideways by the sway
-- and jiggle. Sideways is in world units (not an angle) so it stays the
-- same size in a pool, whose "center" is far below.
local function position(b, k)
  local ox, oy = math.cos(b.angle), math.sin(b.angle)
  local side = math.sin(b.swayPhase) * SWAY_DISTANCE * (0.35 + 0.65 * k)
    + math.sin(b.wigglePhase) * b.radius * WIGGLE_PER_RADIUS * k
  return b.centerX + ox * b.r - oy * side, b.centerY + oy * b.r + ox * side
end

-- One bubble at (x, y), radius rr, squash q, `lit` 0-1 (brighter near
-- the surface). `dir` points at the surface.
local function drawBubble(x, y, dir, rr, q, lit)
  local g = love.graphics
  g.push()
  g.translate(x, y)
  g.rotate(dir)

  -- Soft glow round it.
  setColor(BODY, 0.05 + 0.08 * lit)
  g.circle("fill", 0, 0, rr * 2.2 + 1.5)
  setColor(BODY, 0.06 + 0.10 * lit)
  g.circle("fill", 0, 0, rr * 1.5 + 0.8)

  g.scale(1 - q, 1 + q)

  if rr < SMALL_RADIUS then
    -- A bead: a pale body with a bright glint on the lit side.
    setColor(BODY, 0.45 + 0.25 * lit)
    g.circle("fill", 0, 0, rr)
    setColor(SHADE, 0.5)
    g.circle("fill", -LX * rr * 0.35, -LY * rr * 0.35, rr * 0.45)
    setColor(WHITE, 0.95)
    g.circle("fill", LX * rr * 0.35, LY * rr * 0.35, math.max(0.6, rr * 0.45))
  else
    -- See-through body.
    setColor(BODY, 0.14 + 0.18 * lit)
    g.circle("fill", 0, 0, rr)

    -- Rim: mid blue all round, lit toward the light, shaded away from it.
    local w = math.max(1, rr * 0.2)
    local rimR = rr - w * 0.5
    g.setLineWidth(w)
    setColor(RIM, 0.85)
    g.circle("line", 0, 0, rimR)
    setColor(LIT, 0.95)
    g.arc("line", "open", 0, 0, rimR, LIGHT_ANGLE - 1.15, LIGHT_ANGLE + 1.15)
    setColor(SHADE, 0.85)
    g.arc("line", "open", 0, 0, rimR, LIGHT_ANGLE + math.pi - 0.95, LIGHT_ANGLE + math.pi + 0.95)

    -- Highlight toward the light, a second fleck beside it on bigger
    -- ones, and light refracted through to the far side.
    local hx, hy = LX * rr * 0.45, LY * rr * 0.45
    setColor(WHITE, 1)
    g.circle("fill", hx, hy, math.max(0.7, rr * 0.2))
    if rr >= 2.5 then
      setColor(LIT, 0.9)
      g.circle("fill", hx - LY * rr * 0.32, hy + LX * rr * 0.32, rr * 0.12)
    end
    setColor(LIT, 0.8)
    g.circle("fill", -LX * rr * 0.5, -LY * rr * 0.5, math.max(0.5, rr * 0.13))
  end

  g.pop()
end

-- A popping bubble at the surface point (x, y), `dir` pointing out of
-- the water: first a dome bulging up through the surface, then a
-- flattened ripple spreading along it, with two flecks thrown clear.
local function drawPop(b, x, y, dir)
  local g = love.graphics
  local rr = b.popRadius
  local hasDome = rr >= POP_DOME_MIN
  local age = b.popAge

  g.push()
  g.translate(x, y)
  g.rotate(dir)

  if hasDome and age < POP_DOME_TICKS then
    -- The dome: the half of the bubble above the surface.
    g.setLineWidth(math.max(1, rr * 0.2))
    setColor(LIT, 0.95)
    local pts = {}
    for i = 0, 16 do
      local a = -math.pi / 2 + math.pi * i / 16
      pts[#pts + 1] = math.cos(a) * rr * 0.9
      pts[#pts + 1] = math.sin(a) * rr
    end
    g.line(pts)
    setColor(WHITE, 1)
    g.circle("fill", rr * 0.55, -rr * 0.4, math.max(0.7, rr * 0.2))
  else
    local k = (age - (hasDome and POP_DOME_TICKS or 0)) / POP_RIPPLE_TICKS
    k = math.min(1, math.max(0, k))
    local alpha = math.min(1, 1.2 - k)

    -- The ripple: the underwater half of a ring, squashed flat against
    -- the surface, widening as it fades.
    local w = rr + 1 + k * rr * 1.6
    g.setLineWidth(math.max(1, rr * 0.18) * (1 - 0.5 * k))
    setColor(k < 0.4 and WHITE or BODY, alpha)
    local pts = {}
    local a0, a1 = math.pi / 2 + 0.15, 3 * math.pi / 2 - 0.15
    for i = 0, 18 do
      local a = a0 + (a1 - a0) * i / 18
      pts[#pts + 1] = math.cos(a) * w * 0.3
      pts[#pts + 1] = math.sin(a) * w
    end
    g.line(pts)

    -- Two flecks of spray flying off.
    if hasDome and k < 0.6 then
      local s = rr * 0.5
      local d = math.max(0.6, rr * 0.15)
      setColor(LIT, alpha)
      g.circle("fill", (2 + k * 4) * s, -2 * s, d)
      g.circle("fill", (3 + k * 5) * s, 2 * s, d)
    end
  end

  g.pop()
end

-- Drawn after the water's own fill (see main.lua), so they sit on top
-- of it instead of being muddied underneath.
function Bubbles.draw(list)
  local g = love.graphics
  local lineWidth = g.getLineWidth()
  for _, b in ipairs(list) do
    if b.popAge then
      local x, y = position(b, 1)
      drawPop(b, x, y, b.angle)
    else
      local k = progress(b)
      local x, y = position(b, k)
      local q = SQUASH * math.sin(b.wigglePhase * 2) * math.min(1, b.radius / 2)
      local lit = 0.25 + 0.6 * k + 0.15 * math.sin(b.swayPhase * 3)
      drawBubble(x, y, b.angle, b.radius * (1 + SWELL * k), q, math.max(0, math.min(1, lit)))
    end
  end
  g.setLineWidth(lineWidth)
  g.setColor(1, 1, 1, 1)
end

return Bubbles
