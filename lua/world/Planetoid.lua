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
-- The soft halo round every planetoid: a pale blue. (Was the lighter,
-- weaker { 173, 216, 255 } at 0.2, which read as a grey-white haze
-- rather than as blue.)
Planetoid.SHADOW_COLOR = { 120/255, 185/255, 255/255, 0.26 }

Planetoid.SUN_OVERLAY_DIAMETER = 200
Planetoid.SUN_MIN_ALPHA = 0.15
Planetoid.SUN_MAX_ALPHA = 0.95
Planetoid.SUN_MAX_DARKNESS = 0.18

-- Overall brightness knobs (see getSunShadingShader and ensureBodyCanvas).
-- SUN_LIT_BRIGHTNESS: how much of its own color the sun-facing side of
-- a planetoid keeps (1 = all of it). SUN_OVERALL_DARKEN: strength of a
-- flat darkening over the whole planetoid, lit side included (0 = none;
-- this was 0.40). BODY_BRIGHTEN: how much the body's own texture is
-- lifted when it's baked, as an extra fraction of itself added on top
-- (0 = the texture as-is, which is a fairly dark image to begin with).
-- The highlight on the sun-facing side — a soft bright spot,
-- the thing that makes a shaded disc read as a sphere. All three are
-- fractions: how bright it is at its center, how big it is relative to
-- the planetoid's radius, and how far out from the center (toward the
-- sun) it sits, also relative to the radius. HIGHLIGHT_ALPHA = 0 turns
-- it off.
Planetoid.HIGHLIGHT_ALPHA = 0.22
Planetoid.HIGHLIGHT_SIZE = 0.55
Planetoid.HIGHLIGHT_OFFSET = 0.48

Planetoid.SUN_LIT_BRIGHTNESS = 1.0
Planetoid.SUN_OVERALL_DARKEN = 0.08
Planetoid.BODY_BRIGHTEN = 0.18

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

-- Sun shading, applied by a shader AS the body canvas is drawn (see
-- Planetoid:draw) rather than as separate shapes laid over it
-- afterward. For each pixel of the canvas it works out where that pixel
-- is on the planetoid (q: 0 at the center, length 1 at the body's own
-- edge) and from that:
--   - the lit-side/dark-side gradient, MULTIPLIED onto the body's color
--     — centered half a radius toward the sun and running out over 1.6
--     radii, at SUN_LIT_BRIGHTNESS;
--   - the flat SUN_OVERALL_DARKEN, scaled by how close the sun is;
--   - the soft HIGHLIGHT, added on the sun-facing side.
-- Only the body is touched (length(q) <= 1) — the halo outside it is
-- passed straight through.
--
-- This replaced a version that clipped those effects to the body with
-- a stencil circle drawn on screen. That circle and the body's own
-- baked edge were two different polygons rasterized at two different
-- resolutions, and never lined up pixel for pixel: wherever the body
-- poked out past the stencil a pixel or two stayed unshaded (bright
-- specks along the dark side's rim), and wherever the stencil poked
-- out past the body the shading landed on the halo instead (dark
-- specks along the lit side's rim). Here the edge the shading stops at
-- is computed from the very same canvas coordinates the body's edge
-- sits at, so the two cannot disagree — and it's blended across the
-- rim pixel (fwidth) in proportion to how much of that pixel is body.
local sunShadingShader = nil
local function getSunShadingShader()
  if sunShadingShader then return sunShadingShader end
  sunShadingShader = love.graphics.newShader([[
    extern vec2 lightDir;        // unit vector on screen, toward the sun
    extern float bodyFraction;   // the body's radius as a fraction of half the canvas (the rest is halo padding)
    extern float sunStrength;    // 0..1, how close the sun is
    extern float litBrightness;
    extern float overallDarken;
    extern float highlightAlpha;
    extern float highlightSize;
    extern float highlightOffset;

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec4 texel = Texel(tex, uv) * color;

      vec2 q = (uv - vec2(0.5)) * 2.0 / bodyFraction;
      float dist = length(q);
      float edge = max(fwidth(dist), 1e-5);
      float body = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, dist);
      if (body <= 0.0) return texel;

      float lit = clamp(1.0 - length(q - lightDir * 0.5) / 1.6, 0.0, 1.0) * litBrightness;
      float shade = lit * (1.0 - sunStrength * overallDarken);

      float h = clamp(1.0 - length(q - lightDir * highlightOffset) / highlightSize, 0.0, 1.0);
      h = h * h * highlightAlpha;

      vec3 shaded = texel.rgb * shade + vec3(1.0, 0.98, 0.92) * h * texel.a;
      return vec4(mix(texel.rgb, shaded, body), texel.a);
    }
  ]])
  return sunShadingShader
end

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
  self.interiorType = nil
  self.eclipseMesh = nil
  return self
end

-- Baking a body canvas (glow layers + stencil + tiled texture draw, at
-- 2x supersampling) is real GPU/CPU work that's actually rendered every
-- frame afterward. Left uncapped, a single frame where many
-- never-before-seen planetoids all become visible at once (e.g.
-- scrolling into a freshly generated belt cell, up to 36 planetoids)
-- bakes all of them synchronously in that one love.draw() call, which
-- is exactly the kind of one-frame stall that reads as an intermittent
-- FPS drop. Capping how many NEW bakes happen per frame spreads that
-- burst across a handful of frames instead — draw()'s existing
-- fallback (a plain red circle) covers the gap until a planet's own
-- turn comes up, same as it already did while waiting on
-- state.planetTexture to load. Planetoid.beginFrame() resets the
-- counter once per frame, from love.draw() in main.lua.
Planetoid.MAX_BODY_CANVAS_BAKES_PER_FRAME = 3
local bodyCanvasBakesThisFrame = 0

function Planetoid.beginFrame()
  bodyCanvasBakesThisFrame = 0
end

-- Shared across every planetoid with a matching (color, radius) pair —
-- keyed on self.color BY REFERENCE (relies on callers reusing the same
-- color table for "the same color," e.g. WorldGen.lua's randomColor()
-- always returning one of its fixed PLANET_COLORS entries, never a
-- fresh table) nested under self.radius. Since color already only ever
-- comes from that small fixed swatch list, and WorldGen.lua's
-- randomQuantizedRadius snaps generated radii to 5px steps instead of
-- a continuous range, the number of DISTINCT (color, radius) pairs that
-- ever actually occur is small and bounded — once every combination in
-- play has been baked once, every further planetoid that becomes
-- visible for the first time is a free cache hit here instead of a new
-- bake, well below MAX_BODY_CANVAS_BAKES_PER_FRAME's own per-frame cap.
local sharedBodyCanvasCache = {}

function Planetoid:ensureBodyCanvas()
  if self.bodyCanvas then return end
  if not state.planetTexture then return end

  self.bodyCanvasPadding = Planetoid.SHADOW_PADDING

  local colorCache = sharedBodyCanvasCache[self.color]
  local cachedCanvas = colorCache and colorCache[self.radius]
  if cachedCanvas then
    self.bodyCanvas = cachedCanvas
    return
  end

  if bodyCanvasBakesThisFrame >= Planetoid.MAX_BODY_CANVAS_BAKES_PER_FRAME then return end
  bodyCanvasBakesThisFrame = bodyCanvasBakesThisFrame + 1

  local r = self.radius
  local padding = Planetoid.SHADOW_PADDING

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

  -- A second, additive pass of the same tinted texture lifts the whole
  -- body by BODY_BRIGHTEN — same colors and detail, just brighter (a
  -- plain tint can only ever darken a texture, never brighten it).
  if Planetoid.BODY_BRIGHTEN > 0 then
    local lift = Planetoid.BODY_BRIGHTEN
    love.graphics.setBlendMode("add", "alphamultiply")
    love.graphics.setColor(self.color[1], self.color[2], self.color[3], lift)
    love.graphics.draw(state.planetTexture, cx, cy, 0, texSize / texW, texSize / texH, texW / 2, texH / 2)
    love.graphics.setBlendMode("alpha")
  end

  love.graphics.setStencilTest()
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.setCanvas()
  love.graphics.pop()

  self.bodyCanvas = finalCanvas

  colorCache = sharedBodyCanvasCache[self.color]
  if not colorCache then
    colorCache = {}
    sharedBodyCanvasCache[self.color] = colorCache
  end
  colorCache[self.radius] = finalCanvas
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
    local shader = self:applySunShading(padding)
    love.graphics.setColor(1, 1, 1, 1)
    love.graphics.draw(
      self.bodyCanvas,
      self.pos.x - self.radius - padding,
      self.pos.y - self.radius - padding,
      0,
      0.5, 0.5
    )
    if shader then love.graphics.setShader() end
  else
    love.graphics.setColor(1, 0, 0, 1)
    love.graphics.circle("fill", self.pos.x, self.pos.y, self.radius)
    love.graphics.setColor(1, 1, 1, 1)
  end
end

-- Turns the sun-shading shader (see getSunShadingShader) on for the
-- body canvas about to be drawn, set up for where the sun is from this
-- planetoid. Returns the shader so the caller can turn it back off, or
-- nil if this one is too far from the sun to be shaded at all.
function Planetoid:applySunShading(padding)
  local sunX = state.sceneWidth / 2
  local sunY = state.sceneHeight / 2
  local toSunX = sunX - self.pos.x
  local toSunY = sunY - self.pos.y
  local distToSun = math.sqrt(toSunX * toSunX + toSunY * toSunY)

  local maxDist = math.sqrt(state.sceneWidth * state.sceneWidth + state.sceneHeight * state.sceneHeight) / 2
  local strength = 1 - math.min(distToSun / maxDist, 1)
  if strength <= 0.01 or distToSun < 1 then return nil end

  local shader = getSunShadingShader()
  shader:send("lightDir", { toSunX / distToSun, toSunY / distToSun })
  shader:send("bodyFraction", self.radius / (self.radius + padding))
  shader:send("sunStrength", strength)
  shader:send("litBrightness", Planetoid.SUN_LIT_BRIGHTNESS)
  shader:send("overallDarken", Planetoid.SUN_OVERALL_DARKEN)
  shader:send("highlightAlpha", Planetoid.HIGHLIGHT_ALPHA)
  shader:send("highlightSize", Planetoid.HIGHLIGHT_SIZE)
  shader:send("highlightOffset", Planetoid.HIGHLIGHT_OFFSET)
  love.graphics.setShader(shader)
  return shader
end

-- Soft widening trapezoidal shadow (single mesh, fades to nothing)
function Planetoid:drawEclipseShadow()
  local sunX = state.sceneWidth / 2
  local sunY = state.sceneHeight / 2
  local dx = self.pos.x - sunX
  local dy = self.pos.y - sunY
  local dist = math.sqrt(dx * dx + dy * dy)
  if dist < 1 then return end

  -- The sun's own visible glow (see Sun.lua's corona layer, drawn out to
  -- roughly self.radius*2.1 — about 4100 units at its actual configured
  -- radius of 1920) reaches much farther than this used to account for.
  -- At 1400, only planetoids nearly touching the sun's own core disc
  -- ever got a shadow at all; widened to cover the full corona so
  -- anything visibly sitting in the sun's outer glow gets one too,
  -- fading out toward the edge of that glow via `proximity` below same
  -- as before.
  local maxShadowDist = 4000
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