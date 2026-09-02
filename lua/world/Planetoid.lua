-- lua/world/Planetoid.lua

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local constants = require("lua.constants")

local Planetoid = {}

Planetoid.VERSION = "textured-body-with-sun-shading-6"
print("[Planetoid.lua] loaded, VERSION = " .. Planetoid.VERSION)
Planetoid.__index = Planetoid

-- Original glow (restored)
Planetoid.SHADOW_BLUR = 200
Planetoid.SHADOW_PADDING = 45
Planetoid.SHADOW_COLOR = { 173/255, 216/255, 255/255, 0.2 }

Planetoid.SUN_OVERLAY_DIAMETER = 200
Planetoid.SUN_MIN_ALPHA = 0.15
Planetoid.SUN_MAX_ALPHA = 0.95
Planetoid.SUN_MAX_DARKNESS = 0.18

local sunOverlayCanvas = nil

local function createRadialGradientMesh(segments)
  segments = segments or 48
  local vertices = {
    { 0, 0, 0.5, 0.5, 1, 1, 1, 1 },
  }
  for i = 0, segments do
    local angle = (i / segments) * math.pi * 2
    local x, y = math.cos(angle), math.sin(angle)
    table.insert(vertices, { x, y, 0.5 + x * 0.5, 0.5 + y * 0.5, 0, 0, 0, 1 })
  end
  return love.graphics.newMesh(vertices, "fan", "static")
end

local radialGradientMesh = nil

local function getSunOverlayCanvas()
  if sunOverlayCanvas then return sunOverlayCanvas end
  if not radialGradientMesh then radialGradientMesh = createRadialGradientMesh() end

  local d = Planetoid.SUN_OVERLAY_DIAMETER
  local r = d / 2
  local offset = -r * 0.5

  local canvas = love.graphics.newCanvas(d, d)
  love.graphics.push()
  love.graphics.origin()
  love.graphics.setCanvas({ canvas, stencil = true })
  love.graphics.clear(0, 0, 0, 0)
  love.graphics.setBlendMode("alpha")

  love.graphics.stencil(function()
    love.graphics.circle("fill", r, r, r)
  end, "replace", 1)
  love.graphics.setStencilTest("greater", 0)

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(radialGradientMesh, r, r + offset, 0, r * 1.6, r * 1.6)

  love.graphics.setStencilTest()
  love.graphics.setCanvas()
  love.graphics.pop()

  sunOverlayCanvas = canvas
  return sunOverlayCanvas
end

function Planetoid.new(x, y, radius, color)
  local self = setmetatable({}, Planetoid)
  self.pos = Vector2.new(x, y)
  self.radius = radius
  self.mass = radius * radius
  self.influenceRadius = radius + constants.INFLUENCE_PADDING
  self.color = color
  local direction = Vector2.new(math.random() * 2 - 1, math.random() * 2 - 1):normalize()
  self.vel = direction:multiply(constants.PLANET_SPEED)
  self.cachedAlpha = 0.3
  self.lastAlphaUpdate = 0
  self.isSpikey = false
  self.bodyCanvas = nil
  self.bodyCanvasPadding = 0
  self.ringCanvas = nil
  self.interiorType = nil
  self.eclipseMesh = nil
  return self
end

function Planetoid:createRingCanvas()
  local r = self.influenceRadius
  local dashLen, gapLen = 10, 5
  local cycleLen = dashLen + gapLen
  local circumference = 2 * math.pi * r
  local segments = math.max(64, math.floor(circumference / 4))

  local canvas = love.graphics.newCanvas(r * 2, r * 2)
  love.graphics.push()
  love.graphics.origin()
  love.graphics.setCanvas(canvas)
  love.graphics.clear(0, 0, 0, 0)
  love.graphics.setColor(173/255, 216/255, 230/255, 1)
  love.graphics.setLineWidth(3)

  for i = 0, segments - 1 do
    local t0 = i / segments
    local t1 = (i + 1) / segments
    local arcPos = t0 * circumference
    if (arcPos % cycleLen) < dashLen then
      local a0 = t0 * math.pi * 2
      local a1 = t1 * math.pi * 2
      local x0, y0 = r + r * math.cos(a0), r + r * math.sin(a0)
      local x1, y1 = r + r * math.cos(a1), r + r * math.sin(a1)
      love.graphics.line(x0, y0, x1, y1)
    end
  end

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.setCanvas()
  love.graphics.pop()
  self.ringCanvas = canvas
end

function Planetoid:ensureBodyCanvas()
  if self.bodyCanvas then return end
  if not state.planetTexture then return end

  local r = self.radius
  local padding = Planetoid.SHADOW_PADDING
  self.bodyCanvasPadding = padding

  local scale = 2
  local size = (r * 2 + padding * 2) * scale
  local cx, cy = (r + padding) * scale, (r + padding) * scale
  local bakeR = r * scale
  local bakePadding = padding * scale

  local finalCanvas = love.graphics.newCanvas(size, size)
  finalCanvas:setFilter("linear", "linear")

  love.graphics.push()
  love.graphics.origin()
  love.graphics.setCanvas({ finalCanvas, stencil = true })
  love.graphics.clear(0, 0, 0, 0)
  love.graphics.setBlendMode("alpha")

local GLOW_LAYERS = 18
for i = GLOW_LAYERS, 1, -1 do
local t = i / GLOW_LAYERS
local glowR = bakeR + bakePadding * t

-- Quadratic falloff = much softer / more blurred look
local falloff = (1 - t) * (1 - t)
local glowAlpha = Planetoid.SHADOW_COLOR[4] * falloff * 0.85

love.graphics.setColor(
    Planetoid.SHADOW_COLOR[1],
    Planetoid.SHADOW_COLOR[2],
    Planetoid.SHADOW_COLOR[3],
    glowAlpha
)
love.graphics.circle("fill", cx, cy, glowR)
end

  love.graphics.stencil(function()
    love.graphics.circle("fill", cx, cy, bakeR)
  end, "replace", 1)
  love.graphics.setStencilTest("greater", 0)

  local tiles = 2.5
  local texW, texH = state.planetTexture:getDimensions()
  local texSize = bakeR * 2 * tiles
  love.graphics.setColor(self.color[1], self.color[2], self.color[3], self.color[4] or 1)
  love.graphics.draw(state.planetTexture, cx, cy, 0, texSize / texW, texSize / texH, texW / 2, texH / 2)

  love.graphics.setStencilTest()
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.setCanvas()
  love.graphics.pop()

  self.bodyCanvas = finalCanvas
end

function Planetoid:updateCachedAlpha()
  local now = love.timer.getTime() * 1000
  if now - self.lastAlphaUpdate > 500 then
    local dist = self.pos:subtract(state.player.pos):length()
    self.cachedAlpha = math.max(0.01, 0.3 - (dist / 1000) * 0.65)
    self.lastAlphaUpdate = now
  end
end

function Planetoid:draw()
  -- Shadow first (behind everything)
  self:drawEclipseShadow()

  self:ensureBodyCanvas()

  if self.bodyCanvas then
    local padding = self.bodyCanvasPadding or 0
    love.graphics.setColor(1, 1, 1, 1)
    love.graphics.draw(
      self.bodyCanvas,
      self.pos.x - self.radius - padding,
      self.pos.y - self.radius - padding,
      0,
      0.5, 0.5
    )
  else
    love.graphics.setColor(1, 0, 0, 1)
    love.graphics.circle("fill", self.pos.x, self.pos.y, self.radius)
    love.graphics.setColor(1, 1, 1, 1)
  end

  self:drawSunShading()
end

function Planetoid:drawSunShading()
  local sunX = state.sceneWidth / 2
  local sunY = state.sceneHeight / 2
  local toSunX = sunX - self.pos.x
  local toSunY = sunY - self.pos.y
  local distToSun = math.sqrt(toSunX * toSunX + toSunY * toSunY)

  local maxDist = math.sqrt(state.sceneWidth * state.sceneWidth + state.sceneHeight * state.sceneHeight) / 2
  local distT = math.min(distToSun / maxDist, 1)

  local overlay = getSunOverlayCanvas()
  local d = self.radius * 2
  local ow, oh = overlay:getDimensions()
  local angleToSun = math.atan2(toSunY, toSunX)
  local overlayRotation = angleToSun + math.pi / 2

  local shadeRadius = self.radius

  love.graphics.stencil(function()
    love.graphics.circle("fill", self.pos.x, self.pos.y, shadeRadius)
  end, "replace", 1)
  love.graphics.setStencilTest("greater", 0)

  local strength = 1 - distT

  if strength > 0.01 then
    local shadowAlpha = 0.2 + strength * 0.75
    love.graphics.setBlendMode("multiply", "premultiplied")
    love.graphics.setColor(shadowAlpha, shadowAlpha, shadowAlpha, shadowAlpha)
    love.graphics.draw(overlay, self.pos.x, self.pos.y, overlayRotation, d / ow, d / oh, ow / 2, oh / 2)

    love.graphics.setBlendMode("alpha")
    love.graphics.setColor(0, 0, 0, strength * 0.40)
    love.graphics.circle("fill", self.pos.x, self.pos.y, shadeRadius)
  end

  love.graphics.setBlendMode("alpha")
  love.graphics.setStencilTest()
  love.graphics.setColor(1, 1, 1, 1)
end

-- Soft widening trapezoidal shadow (single mesh, fades to nothing)
function Planetoid:drawEclipseShadow()
  local sunX = state.sceneWidth / 2
  local sunY = state.sceneHeight / 2
  local dx = self.pos.x - sunX
  local dy = self.pos.y - sunY
  local dist = math.sqrt(dx * dx + dy * dy)
  if dist < 1 then return end

  local maxShadowDist = 1400
  local proximity = 1 - math.min(dist / maxShadowDist, 1)
  if proximity < 0.05 then return end

  local invLen = 1 / dist
  local dirX = dx * invLen          -- away from the sun
  local dirY = dy * invLen
  local perpX = -dirY
  local perpY =  dirX

  local shadowStrength = proximity * 0.55
  local shadowLength   = self.radius * (5.0 + proximity * 7.0)

  -- Short base (near the planet) ≈ diameter of the planet
  local nearHalfWidth = self.radius
  -- Long base (far end) – wider
  local farHalfWidth  = self.radius * 2.8

  -- Near edge sits just behind the planet
  local nearDist = 0
  local farDist  = nearDist + shadowLength

  -- Four corners
  local n1x = self.pos.x + dirX * nearDist + perpX * nearHalfWidth
  local n1y = self.pos.y + dirY * nearDist + perpY * nearHalfWidth
  local n2x = self.pos.x + dirX * nearDist - perpX * nearHalfWidth
  local n2y = self.pos.y + dirY * nearDist - perpY * nearHalfWidth

  local f1x = self.pos.x + dirX * farDist + perpX * farHalfWidth
  local f1y = self.pos.y + dirY * farDist + perpY * farHalfWidth
  local f2x = self.pos.x + dirX * farDist - perpX * farHalfWidth
  local f2y = self.pos.y + dirY * farDist - perpY * farHalfWidth

  -- Single mesh with vertex colors so it fades to transparent
  -- Order: near1, near2, far2, far1
  local vertices = {
    {n1x, n1y, 0, 0, 0, 0, 0, shadowStrength}, -- near, opaque
    {n2x, n2y, 0, 0, 0, 0, 0, shadowStrength}, -- near, opaque
    {f2x, f2y, 0, 0, 0, 0, 0, 0},              -- far, transparent
    {f1x, f1y, 0, 0, 0, 0, 0, 0},              -- far, transparent
  }

  -- Reused across frames (created once, rewritten in place via
  -- setVertices) instead of newMesh()+release() every frame — this
  -- shadow's shape genuinely changes every frame (direction to the
  -- sun, proximity-driven length/strength all shift as the planet
  -- moves), but allocating and freeing a whole GPU mesh object every
  -- frame, for every planet close enough to the sun to show one, was
  -- needless GPU churn. "dynamic" usage tells LÖVE to expect frequent
  -- CPU-side rewrites like this, unlike the "static" usage above.
  if not self.eclipseMesh then
    self.eclipseMesh = love.graphics.newMesh(vertices, "fan", "dynamic")
  else
    self.eclipseMesh:setVertices(vertices)
  end

  love.graphics.setBlendMode("alpha")
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(self.eclipseMesh)

  love.graphics.setColor(1, 1, 1, 1)
end

Planetoid._getSunOverlayCanvasForDiagnostics = getSunOverlayCanvas

return Planetoid