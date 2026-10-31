-- lua/effects/TransporterEffect.lua
--
-- The Beam.lua teleport's look: a sci-fi "transporter" shimmer. On the
-- way out, a column of twinkling sparkles fills his silhouette and drifts
-- upward, with white streaks shooting up from his feet, while his body
-- flares with light and fades away, leaving only
-- the sparkles, which then fade too. Arriving is the same thing played
-- backward. (Player.lua decides the timing — see Player:getTransporterState.)
--
-- Three pieces:
--   TransporterEffect.curves(t)  — how faded/glowing/sparkly he is at
--     progress t (0 = fully here, 1 = fully gone).
--   TransporterEffect.drawFaded(...) — draws him see-through and/or
--     lit up. His rig sets its own solid colors on every part, so a plain
--     setColor alpha can't fade him; instead he's drawn into an offscreen
--     canvas first (same trick as SilhouetteGlow.lua) and that canvas is
--     drawn back faded, plus a second, additive copy filled with light.
--   TransporterEffect.drawSparkles(...) — the shimmering motes.

local state = require("lua.state")

local TransporterEffect = {}

local function smoothstep(a, b, x)
  local t = math.max(0, math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
end

-- t: 0 = fully materialized, 1 = fully gone.
-- Returns bodyAlpha (how visible his body is), glow (how strongly it's
-- flooded with light) and sparkle (how strong the shimmer is), each 0..1.
function TransporterEffect.curves(t)
  local sparkle = smoothstep(0, 0.25, t) * (1 - smoothstep(0.75, 1, t))
  local glow = 0.45 * smoothstep(0.1, 0.45, t) * (1 - smoothstep(0.45, 0.8, t))
  local bodyAlpha = 1 - smoothstep(0.3, 0.75, t)
  return bodyAlpha, glow, sparkle
end

-- Fills a silhouette with flat color (its own alpha decides where).
local fillShader = nil
local function getFillShader()
  if fillShader then return fillShader end
  fillShader = love.graphics.newShader([[
    vec4 effect(vec4 color, Image tex, vec2 texture_coords, vec2 screen_coords) {
      float a = Texel(tex, texture_coords).a;
      return vec4(color.rgb * a * color.a, 0.0);
    }
  ]])
  return fillShader
end

local cachedCanvas = nil
local function getCanvas(size)
  if cachedCanvas and cachedCanvas:getWidth() >= size and cachedCanvas:getHeight() >= size then
    return cachedCanvas
  end
  cachedCanvas = love.graphics.newCanvas(size, size)
  return cachedCanvas
end

-- worldX, worldY: the subject's anchor (drawFn draws itself relative to
-- it, as it normally would). boundWorldRadius: generous reach of the
-- subject from that point. bodyAlpha, glow: 0..1 (see curves). color:
-- {r,g,b} of the glow. drawFn: draws the subject.
function TransporterEffect.drawFaded(worldX, worldY, boundWorldRadius, bodyAlpha, glow, color, drawFn)
  if bodyAlpha <= 0 and glow <= 0 then return end
  local zoom = state.zoom or 1
  local cam = state.camera or { x = 0, y = 0 }
  local halfPx = math.ceil(boundWorldRadius * zoom)
  if halfPx < 2 then return end
  local size = halfPx * 2
  local canvas = getCanvas(size)

  -- Pass 1: render him into the cleared canvas at the scene's zoom.
  local prevCanvas = love.graphics.getCanvas()
  local stencilMode, stencilValue = love.graphics.getStencilTest()
  love.graphics.setStencilTest()
  love.graphics.push()
  love.graphics.setCanvas(canvas)
  love.graphics.clear(0, 0, 0, 0)
  love.graphics.origin()
  love.graphics.translate(halfPx, halfPx)
  love.graphics.scale(zoom, zoom)
  love.graphics.translate(-worldX, -worldY)
  drawFn()
  love.graphics.setShader()
  love.graphics.setCanvas(prevCanvas)
  love.graphics.pop()
  if stencilMode ~= "always" then love.graphics.setStencilTest(stencilMode, stencilValue) end

  -- Pass 2: draw it back where he stands — faded, then lit.
  local screenX = (worldX - cam.x) * zoom - halfPx
  local screenY = (worldY - cam.y) * zoom - halfPx
  love.graphics.push()
  love.graphics.origin()
  if bodyAlpha > 0 then
    love.graphics.setBlendMode("alpha", "premultiplied")
    love.graphics.setColor(bodyAlpha, bodyAlpha, bodyAlpha, bodyAlpha)
    love.graphics.draw(canvas, screenX, screenY)
  end
  if glow > 0 then
    love.graphics.setShader(getFillShader())
    love.graphics.setBlendMode("add", "premultiplied")
    love.graphics.setColor(color[1], color[2], color[3], glow)
    love.graphics.draw(canvas, screenX, screenY)
    love.graphics.setShader()
  end
  love.graphics.setBlendMode("alpha")
  love.graphics.pop()
  love.graphics.setColor(1, 1, 1, 1)
end

-- Same pseudo-random hash every frame, so each sparkle keeps its own
-- lane, speed and twinkle rate.
local function hash(i, k)
  local x = math.sin(i * 12.9898 + k * 78.233) * 43758.5453
  return x - math.floor(x)
end

local SPARKLE_COUNT = 64
local STREAK_COUNT = 12

-- cx, cy: middle of his body. upX, upY: which way is "up" for him (unit
-- vector). height, width: size of the column, world units. intensity:
-- 0..1. color: {r,g,b}. time: seconds (real time, so it shimmers at the
-- same speed even in V.A.T.S. slow motion).
function TransporterEffect.drawSparkles(cx, cy, upX, upY, height, width, intensity, color, time)
  if intensity <= 0 then return end
  local rightX, rightY = -upY, upX
  local cr, cg, cb = color[1], color[2], color[3]
  local wr, wg, wb = cr + (1 - cr) * 0.7, cg + (1 - cg) * 0.7, cb + (1 - cb) * 0.7

  love.graphics.setBlendMode("add")

  -- White streaks of light shooting up from his feet, fading as they rise.
  local feetX, feetY = cx - upX * height * 0.5, cy - upY * height * 0.5
  love.graphics.setLineWidth(1.2)
  for i = 1, STREAK_COUNT do
    local across = (hash(i, 11) * 2 - 1) * width * 0.45
    local progress = (hash(i, 12) + time * (0.9 + hash(i, 13) * 0.8)) % 1 -- 0 = at his feet, 1 = top
    local len = height * (0.18 + hash(i, 14) * 0.17)
    local a = intensity * (1 - progress) * (0.5 + 0.5 * hash(i, 15))
    local tail = progress * height
    local head = math.min(height, tail + len)
    local bx, by = feetX + rightX * across, feetY + rightY * across
    love.graphics.setColor(1, 1, 1, a)
    love.graphics.line(bx + upX * tail, by + upY * tail, bx + upX * head, by + upY * head)
  end
  love.graphics.setLineWidth(1)

  for i = 1, SPARKLE_COUNT do
    local u = hash(i, 1) + hash(i, 2) - 1                -- -1..1, bunched toward the middle
    local speed = 0.25 + hash(i, 3) * 0.5                -- column-heights per second, drifting up
    local v = (hash(i, 4) + time * speed) % 1            -- 0 = feet, 1 = head
    local tw = math.sin(time * (5 + hash(i, 5) * 9) + hash(i, 6) * 6.2832)
    tw = tw > 0 and tw * tw * tw or 0
    local a = intensity * tw * (0.5 + 0.5 * hash(i, 7)) * math.sqrt(math.sin(v * math.pi))
    if a > 0.02 then
      local along = (v - 0.5) * height
      local across = u * width * 0.5
      local px = cx + upX * along + rightX * across
      local py = cy + upY * along + rightY * across
      local s = 0.7 + hash(i, 8) * 1.3
      love.graphics.setColor(cr, cg, cb, a * 0.25)
      love.graphics.circle("fill", px, py, s * 2.2)
      love.graphics.setColor(wr, wg, wb, a)
      love.graphics.circle("fill", px, py, s)
    end
  end

  love.graphics.setBlendMode("alpha")
  love.graphics.setColor(1, 1, 1, 1)
end

return TransporterEffect
