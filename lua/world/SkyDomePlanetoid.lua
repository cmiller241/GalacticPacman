-- lua/world/SkyDomePlanetoid.lua
--
-- Port of js/world/SkyDomePlanetoid.js
-- Upper-half glass dome (radial shader + specular highlight),
-- lower-half metal base, flat grass platform, scrolling hex grids.
-- Foreground hexes are larger, bulged, and host subtle force-field flashes
-- snapped to the SAME scrolled FG lattice as the outlines.

local state = require("lua.state")
local Vector2 = require("lua.vector2")

local SkyDomePlanetoid = {}
SkyDomePlanetoid.__index = SkyDomePlanetoid

----------------------------------------------------------------------
-- Glass radial shader (+ specular highlight)
----------------------------------------------------------------------

local glassShader = nil

local function getGlassShader()
  if glassShader then return glassShader end

  glassShader = love.graphics.newShader([[
    extern vec2 center;
    extern vec2 radii;
    extern vec4 colorInner;
    extern vec4 colorOuter;
    extern vec2 highlightCenter;
    extern number highlightRadius;
    extern number highlightStrength;

    vec4 effect(vec4 color, Image tex, vec2 texture_coords, vec2 screen_coords) {
      vec2 p = (screen_coords - center) / radii;
      float d = length(p);

      float t = smoothstep(0.10, 1.0, d);
      vec4 outColor = mix(colorInner, colorOuter, t);

      float hd = length(p - highlightCenter);
      float h = 1.0 - smoothstep(0.0, highlightRadius, hd);
      h = h * h;
      outColor.rgb += vec3(h * highlightStrength);
      outColor.a = min(1.0, outColor.a + h * highlightStrength * 0.35);

      if (d > 1.0) outColor.a = 0.0;
      return outColor;
    }
  ]])

  return glassShader
end

local function setGlassUniforms(self, cx, cy)
  local shader = getGlassShader()
  local zoom = state.zoom or 1
  local cam = state.camera or { x = 0, y = 0 }

  shader:send("center", { (cx - cam.x) * zoom, (cy - cam.y) * zoom })
  shader:send("radii", { self.domeRadiusX * zoom, self.domeRadiusY * zoom })
  shader:send("colorInner", { 0.85, 0.95, 1.0, 0.50 })
  shader:send("colorOuter", { 0.30, 0.60, 0.95, 0.16 })
  shader:send("highlightCenter", { -0.32, -0.48 })
  shader:send("highlightRadius", 0.55)
  shader:send("highlightStrength", 0.40)
end

----------------------------------------------------------------------
-- Foreground bulge shader
----------------------------------------------------------------------

local bulgeShader = nil

local function getBulgeShader()
  if bulgeShader then return bulgeShader end

  bulgeShader = love.graphics.newShader([[
    extern vec2 center;
    extern vec2 radii;
    extern number strength;
    extern number radius;
    extern vec2 texSize;

    vec4 effect(vec4 color, Image tex, vec2 texture_coords, vec2 screen_coords) {
      vec2 pixel = texture_coords * texSize;
      vec2 p = (pixel - center) / radii;
      float d = length(p);

      if (d < radius && d > 0.0001) {
        float t = 1.0 - (d / radius);
        t = t * t * (3.0 - 2.0 * t);
        p /= (1.0 + strength * t);
      }

      vec2 warpedPixel = center + p * radii;
      vec2 warpedUV = warpedPixel / texSize;

      if (warpedUV.x < 0.0 || warpedUV.x > 1.0 || warpedUV.y < 0.0 || warpedUV.y > 1.0) {
        return vec4(0.0);
      }
      if (length((warpedPixel - center) / radii) > 1.02) {
        return vec4(0.0);
      }

      return Texel(tex, warpedUV) * color;
    }
  ]])

  return bulgeShader
end

----------------------------------------------------------------------
-- Geometry helpers
----------------------------------------------------------------------

local function parseRGBA(str, default)
  if type(str) == "table" then return str end
  if type(str) ~= "string" then return default end
  local r, g, b, a = str:match("(%d+)%s*,%s*(%d+)%s*,%s*(%d+)%s*,?%s*([%d%.]*)")
  if not r then return default end
  return {
    tonumber(r) / 255,
    tonumber(g) / 255,
    tonumber(b) / 255,
    (a ~= "" and tonumber(a)) or 1,
  }
end

local function ellipseArcPoints(cx, cy, rx, ry, a0, a1, segments)
  segments = segments or 64
  local pts = {}
  for i = 0, segments do
    local t = a0 + (a1 - a0) * (i / segments)
    pts[#pts + 1] = cx + math.cos(t) * rx
    pts[#pts + 1] = cy + math.sin(t) * ry
  end
  return pts
end

local function upperArc(cx, cy, rx, ry, segments)
  return ellipseArcPoints(cx, cy, rx, ry, math.pi, math.pi * 2, segments or 72)
end

local function lowerArc(cx, cy, rx, ry, segments)
  return ellipseArcPoints(cx, cy, rx, ry, 0, math.pi, segments or 72)
end

local function closedHalf(cx, cy, rx, ry, upper, segments)
  local pts = upper and upperArc(cx, cy, rx, ry, segments) or lowerArc(cx, cy, rx, ry, segments)
  pts[#pts + 1] = upper and (cx + rx) or (cx - rx)
  pts[#pts + 1] = cy
  pts[#pts + 1] = upper and (cx - rx) or (cx + rx)
  pts[#pts + 1] = cy
  return pts
end

local function fillHexagon(cx, cy, size)
  local pts = {}
  for i = 0, 5 do
    local angle = (math.pi / 3) * i - math.pi / 6
    pts[#pts + 1] = cx + size * math.cos(angle)
    pts[#pts + 1] = cy + size * math.sin(angle)
  end
  love.graphics.polygon("fill", pts)
end

local function strokeHexagon(cx, cy, size)
  local pts = {}
  for i = 0, 5 do
    local angle = (math.pi / 3) * i - math.pi / 6
    pts[#pts + 1] = cx + size * math.cos(angle)
    pts[#pts + 1] = cy + size * math.sin(angle)
  end
  love.graphics.polygon("line", pts)
end

----------------------------------------------------------------------
-- Constructor
----------------------------------------------------------------------

function SkyDomePlanetoid.new(x, y, options)
  options = options or {}
  local self = setmetatable({}, SkyDomePlanetoid)

  local halfWidth   = options.halfWidth or 2000
  local halfHeight  = options.halfHeight or 32
  local grassHeight = options.grassHeight or 32

  self.pos = Vector2.new(x, y)
  self.vel = Vector2.new(0, 0)
  self.halfWidth   = halfWidth
  self.halfHeight  = halfHeight + grassHeight
  self.grassHeight = grassHeight
  self.cornerRadius = options.cornerRadius or 0
  self.color = options.color or { 0.36, 0.54, 0.29, 1 }
  self.radius = halfWidth

  self.rotationAngle = 0
  self.rotationSpeed = 0

  self.isImmovable  = true
  self.isPermanent  = true
  self.isSkyDome    = true
  self.noSunShading = true

  self.domeRadiusX = options.domeRadiusX or halfWidth
  self.domeRadiusY = options.domeRadiusY or halfWidth
  self.baseRadiusY = options.baseRadiusY or (self.domeRadiusY / 6)

  self.baseGlowColor      = parseRGBA(options.baseGlowColor, { 180/255, 210/255, 255/255, 1 })
  self.baseLineColor      = parseRGBA(options.baseLineColor, { 10/255, 10/255, 12/255, 1 })
  self.baseHighlightColor = parseRGBA(options.baseHighlightColor, { 210/255, 220/255, 235/255, 1 })
  self.baseHorizontalLineCount = options.baseHorizontalLineCount or 3
  self.baseSeamCount = options.baseSeamCount or 6
  self.baseSeamConvergence = options.baseSeamConvergence or 0.35

  self.domeFillColor = options.domeFillColor or { 130/255, 196/255, 255/255, 0.9 }
  self.domeRimColor  = options.domeRimColor  or { 75/255, 150/255, 225/255, 0.85 }
  self.domeOutlineColor = options.domeOutlineColor or { 1, 1, 1, 1 }
  self.domeOutlineWidth = options.domeOutlineWidth or 3
  self.domeBottomFade = options.domeBottomFade or 0.45

  self.domeGlowColor = parseRGBA(options.domeGlowColor, { 1, 1, 1, 1 })
  self.domeGlowReach = options.domeGlowReach or 30
  self.domeGlowIntensity = options.domeGlowIntensity or 1
  self.domeInnerGlowReach = options.domeInnerGlowReach or 40

  self.domeHexSize = options.domeHexSize or 60
  self.domeHexColor = parseRGBA(options.domeHexColor, { 1, 1, 1, 1 })
  self.domeHexOpacity = options.domeHexOpacity or 0.12
  self.domeHexScrollSpeed = options.domeHexScrollSpeed or 0.006
  self.domeHexLineWidth = options.domeHexLineWidth or 1

  self.domeForegroundHexSize = options.domeForegroundHexSize or (self.domeHexSize * 1.85)
  self.domeForegroundHexOpacity = options.domeForegroundHexOpacity or math.min(1, self.domeHexOpacity * 2.6)
  self.domeForegroundHexScrollSpeed = options.domeForegroundHexScrollSpeed or -0.01
  self.domeForegroundHexLineWidth = options.domeForegroundHexLineWidth or 1.5
  self.domeForegroundTintOpacity = options.domeForegroundTintOpacity or 1.0
  self.domeForegroundOutlineOpacity = options.domeForegroundOutlineOpacity or 0.2
  self.domeForegroundZoomReference = options.domeForegroundZoomReference or 1.0
  self.domeForegroundZoomFloor = options.domeForegroundZoomFloor or 0

  self.domeBulgeStrength = options.domeBulgeStrength or 0.55
  self.domeBulgeRadius = options.domeBulgeRadius or 2.0

  self.hexFlashes = {}
  self.hexFlashTimer = 0
  self.hexFlashInterval = options.hexFlashInterval or 0.35
  self.hexFlashLife = options.hexFlashLife or 0.50
  self.hexFlashAlpha = options.hexFlashAlpha or 0.18
  self.hexFlashCount = options.hexFlashCount or 4

  self.hexGridCanvas = nil
  self.hexGridForegroundCanvas = nil
  self.hexGridTileW, self.hexGridTileH = 0, 0
  self.hexGridForegroundTileW, self.hexGridForegroundTileH = 0, 0
  self.fgHexLayer = nil

  -- Exact lattice periods (NOT ceil) so flashes and outlines share one grid
  self.fgHexWidth = 0
  self.fgHexHeightStep = 0

  self.lastImpactTime = 0
  self.shieldRipples = {}
  self.shieldSparks = {}

  self:createOffscreen()
  return self
end

----------------------------------------------------------------------
-- Geometry
----------------------------------------------------------------------

function SkyDomePlanetoid:trueSurfaceY()
  return self.pos.y - self.halfHeight
end

function SkyDomePlanetoid:domeAnchorY()
  return self:trueSurfaceY() + self.grassHeight
end

function SkyDomePlanetoid:isWithinGravityWindow(worldX, worldY)
  if worldY > self:trueSurfaceY() then return false end
  local nx = (worldX - self.pos.x) / self.domeRadiusX
  local ny = (worldY - self:domeAnchorY()) / self.domeRadiusY
  return (nx * nx + ny * ny) <= 1
end

function SkyDomePlanetoid:nearestEllipseSurfacePoint(centerX, centerY, radiusX, radiusY, worldX, worldY, fallbackDirY)
  local lx = worldX - centerX
  local ly = worldY - centerY
  local nx = lx / radiusX
  local ny = ly / radiusY
  local nDist = math.sqrt(nx * nx + ny * ny)

  local blx, bly
  if nDist < 1e-6 then
    blx = 0
    bly = fallbackDirY * radiusY
  else
    blx = (nx / nDist) * radiusX
    bly = (ny / nDist) * radiusY
  end

  local boundaryX = centerX + blx
  local boundaryY = centerY + bly
  local normal = Vector2.new(blx / (radiusX * radiusX), bly / (radiusY * radiusY)):normalize()
  local dx = worldX - boundaryX
  local dy = worldY - boundaryY

  return {
    point = Vector2.new(boundaryX, boundaryY),
    normal = normal,
    distance = math.sqrt(dx * dx + dy * dy),
  }
end

function SkyDomePlanetoid:nearestDomeSurfacePoint(worldX, worldY)
  return self:nearestEllipseSurfacePoint(
    self.pos.x, self:domeAnchorY(),
    self.domeRadiusX, self.domeRadiusY,
    worldX, worldY, -1
  )
end

function SkyDomePlanetoid:nearestBaseSurfacePoint(worldX, worldY)
  return self:nearestEllipseSurfacePoint(
    self.pos.x, self:domeAnchorY(),
    self.halfWidth, self.baseRadiusY,
    worldX, worldY, 1
  )
end

function SkyDomePlanetoid:nearestSurfacePoint(worldX, worldY)
  local topY = self:trueSurfaceY()
  local minX = self.pos.x - self.halfWidth
  local maxX = self.pos.x + self.halfWidth
  local clampedX = math.max(minX, math.min(maxX, worldX))
  return {
    point = Vector2.new(clampedX, topY),
    normal = Vector2.new(0, -1),
    distance = math.abs(worldY - topY),
  }
end

----------------------------------------------------------------------
-- Shield impact FX
----------------------------------------------------------------------

function SkyDomePlanetoid:triggerShieldImpact(worldX, worldY, intensity)
  intensity = intensity or 1
  self.lastImpactTime = love.timer.getTime() * 1000
  table.insert(self.shieldRipples, {
    x = worldX, y = worldY,
    spawnTime = self.lastImpactTime,
    intensity = intensity,
  })

  local sparkCount = math.floor(4 + intensity * 6 + 0.5)
  for _ = 1, sparkCount do
    local angle = math.random() * math.pi * 2
    local speed = 0.06 + math.random() * 0.12
    table.insert(self.shieldSparks, {
      x = worldX, y = worldY,
      vx = math.cos(angle) * speed,
      vy = math.sin(angle) * speed,
      spawnTime = self.lastImpactTime,
    })
  end
end

----------------------------------------------------------------------
-- FG lattice (shared by outlines + flashes)
----------------------------------------------------------------------

function SkyDomePlanetoid:fgHexMetrics()
  local hexSize = self.domeForegroundHexSize
  local hexWidth = self.fgHexWidth
  local hexHeightStep = self.fgHexHeightStep
  if hexWidth <= 0 or hexHeightStep <= 0 then
    hexWidth = math.sqrt(3) * hexSize
    hexHeightStep = hexSize * 1.5
  end
  return hexSize, hexWidth, hexHeightStep
end

function SkyDomePlanetoid:fgScroll()
  local _, hexWidth = self:fgHexMetrics()
  if hexWidth <= 0 then return 0 end
  local nowMs = love.timer.getTime() * 1000
  return ((nowMs * self.domeForegroundHexScrollSpeed) % hexWidth + hexWidth) % hexWidth
end

local function fgLatticePos(col, row, scroll, hexWidth, hexHeightStep)
  local rowOffset = (row % 2 ~= 0) and (hexWidth * 0.5) or 0
  local x = -scroll + col * hexWidth + rowOffset
  local y = row * hexHeightStep
  return x, y
end

----------------------------------------------------------------------
-- Flashes
----------------------------------------------------------------------

function SkyDomePlanetoid:updateHexFlashes(dt)
  self.hexFlashTimer = self.hexFlashTimer - dt
  if self.hexFlashTimer <= 0 then
    self.hexFlashTimer = self.hexFlashInterval * (0.6 + math.random() * 0.8)

    local hexSize, hexWidth, hexHeightStep = self:fgHexMetrics()
    local scroll = self:fgScroll()
    local rx = self.domeRadiusX
    local ry = self.domeRadiusY
    local cw = self.fgHexLayer and self.fgHexLayer:getWidth() or (rx * 2)
    local ch = self.fgHexLayer and self.fgHexLayer:getHeight() or ry

    for _ = 1, self.hexFlashCount do
      local ang = math.pi + math.random() * math.pi
      local rad = math.sqrt(math.random()) * 0.85
      local canvasX = rx + math.cos(ang) * rx * rad
      local canvasY = ch + math.sin(ang) * ry * rad -- upper half: sin <= 0

      local row = math.floor(canvasY / hexHeightStep + 0.5)
      local rowOffset = (row % 2 ~= 0) and (hexWidth * 0.5) or 0
      local col = math.floor((canvasX - rowOffset + scroll) / hexWidth + 0.5)

      local cellX, cellY = fgLatticePos(col, row, scroll, hexWidth, hexHeightStep)

      -- Very permissive on-canvas check (visibility first)
      if cellY >= -hexHeightStep and cellY <= ch + hexHeightStep
         and cellX >= -hexWidth and cellX <= cw + hexWidth then
        table.insert(self.hexFlashes, {
          col = col,
          row = row,
          born = love.timer.getTime(),
          life = self.hexFlashLife,
        })
      end
    end
  end

  local now = love.timer.getTime()
  for i = #self.hexFlashes, 1, -1 do
    if now - self.hexFlashes[i].born > self.hexFlashes[i].life then
      table.remove(self.hexFlashes, i)
    end
  end
end

----------------------------------------------------------------------
-- Hex bake
----------------------------------------------------------------------

function SkyDomePlanetoid:bakeHexGridTile(hexSize, opacity, lineWidth)
  local hexWidth = math.sqrt(3) * hexSize
  local hexHeightStep = hexSize * 1.5
  -- Canvas needs integer pixels, but lattice period stays exact hexWidth/hexHeightStep
  local tileW = math.max(1, math.ceil(hexWidth))
  local tileH = math.max(1, math.ceil(hexHeightStep * 2))

  local canvas = love.graphics.newCanvas(tileW, tileH)
  love.graphics.push()
  love.graphics.origin()
  love.graphics.setCanvas(canvas)
  love.graphics.clear(0, 0, 0, 0)

  love.graphics.setLineWidth(lineWidth or 1)
  love.graphics.setColor(
    self.domeHexColor[1], self.domeHexColor[2], self.domeHexColor[3], opacity
  )

  for row = -1, 2 do
    local y = row * hexHeightStep
    local rowOffset = (row % 2 ~= 0) and (hexWidth * 0.5) or 0
    for col = -1, 2 do
      local x = col * hexWidth + rowOffset
      strokeHexagon(x, y, hexSize)
    end
  end

  love.graphics.setCanvas()
  love.graphics.pop()
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.setLineWidth(1)

  return canvas, tileW, tileH, hexWidth, hexHeightStep
end

function SkyDomePlanetoid:createOffscreen()
  self.hexGridCanvas, self.hexGridTileW, self.hexGridTileH =
    self:bakeHexGridTile(self.domeHexSize, self.domeHexOpacity, self.domeHexLineWidth)

  local fwTile, fhTile, fgHexWidth, fgHexHeightStep
  self.hexGridForegroundCanvas, fwTile, fhTile, fgHexWidth, fgHexHeightStep =
    self:bakeHexGridTile(
      self.domeForegroundHexSize,
      self.domeForegroundHexOpacity,
      self.domeForegroundHexLineWidth
    )
  self.hexGridForegroundTileW = fwTile
  self.hexGridForegroundTileH = fhTile
  self.fgHexWidth = fgHexWidth
  self.fgHexHeightStep = fgHexHeightStep

  local fw = math.max(2, math.ceil(self.domeRadiusX * 2))
  local fh = math.max(2, math.ceil(self.domeRadiusY))
  self.fgHexLayer = love.graphics.newCanvas(fw, fh)
end

function SkyDomePlanetoid:rebuildForegroundHexLayer()
  if not self.fgHexLayer or not self.hexGridForegroundCanvas then return end

  local hexSize, hexWidth, hexHeightStep = self:fgHexMetrics()
  local scroll = self:fgScroll()
  local cw, ch = self.fgHexLayer:getDimensions()
  local tile = self.hexGridForegroundCanvas

  love.graphics.push()
  love.graphics.origin()
  love.graphics.setCanvas(self.fgHexLayer)
  love.graphics.clear(0, 0, 0, 0)

  -- Step by EXACT lattice periods (same as flash math)
  love.graphics.setColor(1, 1, 1, 1)
  for y = -hexHeightStep * 2, ch + hexHeightStep * 2, hexHeightStep * 2 do
    for x = -scroll - hexWidth, cw + hexWidth, hexWidth do
      love.graphics.draw(tile, x, y)
    end
  end

  if #self.hexFlashes > 0 then
    local now = love.timer.getTime()
    love.graphics.setBlendMode("add")
    for _, f in ipairs(self.hexFlashes) do
      local t = (now - f.born) / f.life
      if t < 1 then
        local fade = 1 - t
        local a = self.hexFlashAlpha * fade * fade
        local x, y = fgLatticePos(f.col, f.row, scroll, hexWidth, hexHeightStep)
        love.graphics.setColor(1, 1, 1, a)
        fillHexagon(x, y, hexSize * 0.92)
      end
    end
    love.graphics.setBlendMode("alpha")
  end

  love.graphics.setCanvas()
  love.graphics.pop()
  love.graphics.setColor(1, 1, 1, 1)
end

----------------------------------------------------------------------
-- Drawing
----------------------------------------------------------------------

function SkyDomePlanetoid:drawDome()
  local cx = self.pos.x
  local cy = self:domeAnchorY()
  local rx, ry = self.domeRadiusX, self.domeRadiusY
  local glass = closedHalf(cx, cy, rx, ry, true)

  local shader = getGlassShader()
  setGlassUniforms(self, cx, cy)

  love.graphics.setShader(shader)
  love.graphics.stencil(function()
    love.graphics.polygon("fill", glass)
  end, "replace", 1)
  love.graphics.setStencilTest("greater", 0)
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.rectangle("fill", cx - rx, cy - ry, rx * 2, ry)
  love.graphics.setStencilTest()
  love.graphics.setShader()

  love.graphics.stencil(function()
    love.graphics.polygon("fill", glass)
  end, "replace", 1)
  love.graphics.setStencilTest("greater", 0)
  for i = 1, 5 do
    local t = i / 5
    love.graphics.setColor(0.05, 0.10, 0.18, self.domeBottomFade * 0.08 * t)
    love.graphics.polygon("fill", closedHalf(cx, cy, rx, ry * (0.15 + 0.35 * t), true))
  end
  love.graphics.setStencilTest()

  if self.hexGridCanvas then
    love.graphics.stencil(function()
      love.graphics.polygon("fill", glass)
    end, "replace", 1)
    love.graphics.setStencilTest("greater", 0)

    local tileW, tileH = self.hexGridTileW, self.hexGridTileH
    local now = love.timer.getTime() * 1000
    local scroll = ((now * self.domeHexScrollSpeed) % tileW + tileW) % tileW
    local boxX, boxY = cx - rx, cy - ry

    love.graphics.setColor(1, 1, 1, 0.75)
    for y = boxY - tileH, cy, tileH do
      for x = boxX - scroll - tileW, boxX + rx * 2 + tileW, tileW do
        love.graphics.draw(self.hexGridCanvas, x, y)
      end
    end
    love.graphics.setStencilTest()
  end

  local arc = upperArc(cx, cy, rx, ry)
  local reach = self.domeGlowReach
  for i = 4, 1, -1 do
    local t = i / 4
    love.graphics.setLineWidth(self.domeOutlineWidth + reach * t)
    love.graphics.setColor(1, 1, 1, 0.035 * (1 - t * 0.5) * self.domeGlowIntensity)
    love.graphics.line(arc)
  end

  love.graphics.setLineWidth(self.domeOutlineWidth)
  love.graphics.setColor(1, 1, 1, 0.75)
  love.graphics.line(arc)

  love.graphics.setLineWidth(1)
  love.graphics.setColor(1, 1, 1, 1)

  self:drawShieldImpactEffects(cx, cy)
end

function SkyDomePlanetoid:drawMetalBase()
  local cx = self.pos.x
  local cy = self:domeAnchorY()
  local rx, ry = self.halfWidth, self.baseRadiusY

  local bands = {
    { 1.00, { 0.52, 0.52, 0.56, 0.95 } },
    { 0.82, { 0.32, 0.32, 0.35, 0.95 } },
    { 0.60, { 0.16, 0.16, 0.18, 0.95 } },
    { 0.36, { 0.06, 0.06, 0.07, 0.95 } },
    { 0.16, { 0.02, 0.02, 0.025, 0.95 } },
  }
  for _, band in ipairs(bands) do
    local s, c = band[1], band[2]
    love.graphics.setColor(c[1], c[2], c[3], c[4])
    love.graphics.polygon("fill", closedHalf(cx, cy, rx, ry * s, false))
  end

  love.graphics.setColor(self.baseGlowColor[1], self.baseGlowColor[2], self.baseGlowColor[3], 0.10)
  love.graphics.setLineWidth(math.max(2, ry * 0.22))
  love.graphics.line(lowerArc(cx, cy, rx * 0.98, ry * 0.9))

  love.graphics.setLineWidth(1.5)
  for i = 1, self.baseHorizontalLineCount do
    local t = i / (self.baseHorizontalLineCount + 1)
    local y = cy + ry * t
    local halfSpan = rx * math.sqrt(math.max(0, 1 - t * t))
    love.graphics.setColor(0.85, 0.90, 0.95, 0.08)
    love.graphics.line(cx - halfSpan, y - 1.5, cx + halfSpan, y - 1.5)
    love.graphics.setColor(0.02, 0.02, 0.03, 0.35)
    love.graphics.line(cx - halfSpan, y, cx + halfSpan, y)
  end

  for i = 1, self.baseSeamCount - 1 do
    local t = i / self.baseSeamCount
    local startX = cx - rx + t * (rx * 2)
    local endX = cx + (startX - cx) * (1 - self.baseSeamConvergence)
    love.graphics.setColor(0.02, 0.02, 0.03, 0.28)
    love.graphics.line(startX, cy, endX, cy + ry)
  end

  love.graphics.setColor(0.10, 0.10, 0.11, 0.9)
  love.graphics.setLineWidth(1.5)
  love.graphics.line(lowerArc(cx, cy, rx, ry))
  love.graphics.line(cx - rx, cy, cx + rx, cy)

  love.graphics.setLineWidth(1)
  love.graphics.setColor(1, 1, 1, 1)
end

function SkyDomePlanetoid:drawGrassCap()
  local topY = self:trueSurfaceY()
  local fullW = self.halfWidth * 2
  local startX = self.pos.x - self.halfWidth
  local h = self.grassHeight

  if state.grassTexture then
    local img = state.grassTexture
    local scale = 2
    local tileW = 32 * scale
    love.graphics.setColor(1, 1, 1, 1)
    for x = 0, fullW, tileW do
      love.graphics.draw(img, startX + x, topY, 0, scale, h / img:getHeight())
    end
  else
    love.graphics.setColor(0.36, 0.55, 0.28, 1)
    love.graphics.rectangle("fill", startX, topY, fullW, h)
  end

  love.graphics.setColor(1, 1, 1, 1)
end

function SkyDomePlanetoid:drawShieldImpactEffects(cx, cy)
  local now = love.timer.getTime() * 1000
  local rx, ry = self.domeRadiusX, self.domeRadiusY

  local PULSE_DURATION_MS = 350
  local pulseElapsed = now - self.lastImpactTime
  if pulseElapsed < PULSE_DURATION_MS then
    local t = 1 - pulseElapsed / PULSE_DURATION_MS
    love.graphics.setColor(1, 1, 1, t * 0.45)
    love.graphics.polygon("fill", closedHalf(cx, cy, rx, ry, true))
  end

  local RIPPLE_DURATION_MS = 400
  for i = #self.shieldRipples, 1, -1 do
    local r = self.shieldRipples[i]
    local age = now - r.spawnTime
    if age > RIPPLE_DURATION_MS then
      table.remove(self.shieldRipples, i)
    else
      local t = age / RIPPLE_DURATION_MS
      local radius = (10 + r.intensity * 15) * (0.3 + t * 0.7)
      love.graphics.setColor(210/255, 240/255, 255/255, (1 - t) * 0.8)
      love.graphics.setLineWidth(2.5)
      love.graphics.circle("line", r.x, r.y, radius)
    end
  end

  local SPARK_DURATION_MS = 500
  for i = #self.shieldSparks, 1, -1 do
    local s = self.shieldSparks[i]
    local age = now - s.spawnTime
    if age > SPARK_DURATION_MS then
      table.remove(self.shieldSparks, i)
    else
      local x = s.x + s.vx * age
      local y = s.y + s.vy * age
      love.graphics.setColor(220/255, 240/255, 255/255, 1 - age / SPARK_DURATION_MS)
      love.graphics.circle("fill", x, y, 2)
    end
  end

  love.graphics.setLineWidth(1)
  love.graphics.setColor(1, 1, 1, 1)
end

function SkyDomePlanetoid:drawForegroundGlass()
  local zoom = state.zoom or 1
  local zoomMin = state.zoomMin or 0.5
  local zoomRef = self.domeForegroundZoomReference
  local zoomT = zoomRef > zoomMin and (zoom - zoomMin) / (zoomRef - zoomMin) or 0
  local clampedT = math.max(0, math.min(1, zoomT))
  local zoomFactor = self.domeForegroundZoomFloor + (1 - self.domeForegroundZoomFloor) * (1 - clampedT)
  if zoomFactor <= 0.001 then return end

  local cx = self.pos.x
  local cy = self:domeAnchorY()
  local rx, ry = self.domeRadiusX, self.domeRadiusY
  local glass = closedHalf(cx, cy, rx, ry, true)

  local c = self.domeFillColor
  love.graphics.setColor(c[1], c[2], c[3], (c[4] or 1) * self.domeForegroundTintOpacity * zoomFactor * 0.22)
  love.graphics.polygon("fill", glass)

  if self.fgHexLayer and self.hexGridForegroundCanvas then
    self:rebuildForegroundHexLayer()

    love.graphics.stencil(function()
      love.graphics.polygon("fill", glass)
    end, "replace", 1)
    love.graphics.setStencilTest("greater", 0)

    local shader = getBulgeShader()
    local cw, ch = self.fgHexLayer:getDimensions()
    shader:send("center", { cw * 0.5, ch })
    shader:send("radii", { rx, ry })
    shader:send("strength", self.domeBulgeStrength)
    shader:send("radius", self.domeBulgeRadius)
    shader:send("texSize", { cw, ch })

    love.graphics.setShader(shader)
    love.graphics.setColor(1, 1, 1, zoomFactor * 0.95)
    love.graphics.draw(self.fgHexLayer, cx - rx, cy - ry)
    love.graphics.setShader()

    love.graphics.setStencilTest()
  end

  love.graphics.setColor(
    self.domeOutlineColor[1], self.domeOutlineColor[2], self.domeOutlineColor[3],
    self.domeForegroundOutlineOpacity * zoomFactor
  )
  love.graphics.setLineWidth(self.domeOutlineWidth)
  love.graphics.line(upperArc(cx, cy, rx, ry))

  love.graphics.setLineWidth(1)
  love.graphics.setColor(1, 1, 1, 1)
end

function SkyDomePlanetoid:draw()
  self:drawDome()
  self:drawMetalBase()
  self:drawGrassCap()
end

function SkyDomePlanetoid:createRingCanvas() end
function SkyDomePlanetoid:drawSunShading() end
function SkyDomePlanetoid:drawEclipseShadow() end

return SkyDomePlanetoid