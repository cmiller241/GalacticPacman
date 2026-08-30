-- lua/world/SkyDomePlanetoid.lua
--
-- Port of js/world/SkyDomePlanetoid.js
-- Upper-half glass dome (radial shader + specular highlight),
-- lower-half metal base, flat grass platform, scrolling hex grids.
-- Foreground hexes are larger, bulged, and host subtle force-field flashes.
--
-- Physics: isRoundedRect + isSkyDome. Landing / walking / gravity use the
-- grass deck (trueSurfaceY). Pull targets should aim at the deck, not the
-- ellipse center. Dome shell is visual + shield only.

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
-- Metal base shader: #6A6A70 at the deck, fade to dark at the keel
----------------------------------------------------------------------

local metalShader = nil

local function getMetalShader()
  if metalShader then return metalShader end

  metalShader = love.graphics.newShader([[
    extern vec2 center;
    extern vec2 radii;
    extern vec4 colorTop;
    extern vec4 colorBottom;
    extern vec4 colorHighlight;

    vec4 effect(vec4 color, Image tex, vec2 texture_coords, vec2 screen_coords) {
      vec2 p = (screen_coords - center) / radii;
      float d = length(p);
      if (d > 1.0 || p.y < -0.02) return vec4(0.0);

      // 0 at the deck line, 1 at the bottom of the hull
      float depth = clamp(p.y, 0.0, 1.0);
      float t = smoothstep(0.0, 1.0, depth);
      t = t * t * (3.0 - 2.0 * t);

      vec4 outColor = mix(colorTop, colorBottom, t);

      // Soft rim / bevel near the ellipse edge
      float rim = smoothstep(0.72, 1.0, d);
      outColor.rgb = mix(outColor.rgb, colorBottom.rgb * 0.55, rim * 0.65);

      // Cool highlight band just under the deck
      float band = 1.0 - smoothstep(0.0, 0.22, depth);
      outColor.rgb = mix(outColor.rgb, colorHighlight.rgb, band * 0.22);

      outColor.a = 1.0;
      return outColor;
    }
  ]])

  return metalShader
end

local function setMetalUniforms(self, cx, cy, rx, ry)
  local shader = getMetalShader()
  local zoom = state.zoom or 1
  local cam = state.camera or { x = 0, y = 0 }

  shader:send("center", { (cx - cam.x) * zoom, (cy - cam.y) * zoom })
  shader:send("radii", { rx * zoom, ry * zoom })
  -- #6A6A70
  shader:send("colorTop", { 106/255, 106/255, 112/255, 1 })
  shader:send("colorBottom", { 0.07, 0.07, 0.08, 1 })
  shader:send("colorHighlight", { 180/255, 184/255, 196/255, 1 })
end

----------------------------------------------------------------------
-- Foreground bulge shader
----------------------------------------------------------------------

local bulgeShader = nil

-- Warps in FIXED box-pixel space (independent of scroll — center/radii
-- always describe the same physical spot on the dome), then converts
-- the warped position into the small repeating tile's own UV space and
-- adds the scroll offset there, as the very last step before sampling.
-- tex is expected to have wrap="repeat": warpedUV routinely exceeds
-- [0,1] (the whole point — that's what makes one small baked tile
-- cover the dome's full box without ever re-rendering it), and the GPU
-- sampler tiles it automatically. See drawForegroundGlass's own
-- comment for why this replaced a per-frame full-canvas rebuild.
--
-- Also carries a ripple distortion — the Love2D port of the JS
-- version's looping PixiJS ShockwaveFilter pair on the foreground
-- container (see js/world/SkyDomePlanetoid.js's shockwaveFilter/
-- shockwaveFilter2). Rather than a literal expanding ring that has to
-- be manually reset every ~2 seconds (Pixi's own approach), this uses
-- a plain standing sine wave in radial distance-from-center MINUS
-- time: since sin() is already periodic, the "rings" travel outward
-- forever with no reset bookkeeping needed, and it's one extra radial
-- displacement folded into the SAME warp pass the bulge already does
-- (no second shader/render pass, unlike Pixi's separate filter).
local function getBulgeShader()
  if bulgeShader then return bulgeShader end

  bulgeShader = love.graphics.newShader([[
    extern vec2 center;
    extern vec2 radii;
    extern number strength;
    extern number radius;
    extern vec2 tileSize;
    extern number scroll;
    extern vec2 rippleCenter1;
    extern vec2 rippleCenter2;
    extern number rippleAmplitude;
    extern number rippleWidth;
    extern number rippleSpeed;
    extern number rippleMaxRadius;
    extern number rippleTime;

    // One ring-shaped band of displacement, expanding outward from
    // ringCenter (a radius that grows over time, wrapping via mod()
    // once past rippleMaxRadius — set a bit beyond the dome's own edge,
    // ~1.0 in this normalized space, so the ring fully exits before the
    // next one starts, with no visible pop at the wrap). "dist" is how
    // far p is from the ring's CURRENT radius; the Gaussian envelope
    // confines the effect to a narrow band around it, and the sin()
    // inside that band gives one small raised crest next to one small
    // trough — reading as an actual ripple ring, not a flat bulge donut.
    // phaseOffset stands one ring's own clock apart from another's, so
    // two calls sharing the same rippleTime can still be out of sync
    // with each other.
    vec2 ringDisplacement(vec2 p, vec2 ringCenter, float phaseOffset) {
      vec2 fromCenter = p - ringCenter;
      float d = length(fromCenter);
      if (d <= 0.0001) return vec2(0.0);
      vec2 dir = fromCenter / d;
      float ringRadius = mod(rippleTime * rippleSpeed + phaseOffset, rippleMaxRadius);
      float dist = d - ringRadius;
      float envelope = exp(-(dist * dist) / (2.0 * rippleWidth * rippleWidth));
      float ripple = sin(dist / rippleWidth * 3.14159265) * envelope;
      return dir * ripple;
    }

    vec4 effect(vec4 color, Image tex, vec2 texture_coords, vec2 screen_coords) {
      vec2 pixel = texture_coords * tileSize;
      vec2 p = (pixel - center) / radii;
      float d = length(p);

      if (d < radius && d > 0.0001) {
        float t = 1.0 - (d / radius);
        t = t * t * (3.0 - 2.0 * t);
        p /= (1.0 + strength * t);
      }

      // Two independent ripple SOURCES (not one center emitting two
      // concentric rings) — same idea as the JS version's two
      // ShockwaveFilters, each with its own center point on the dome.
      // Phase-offset from each other too (half a period apart), so
      // even where their rings cross paths they don't stay permanently
      // in lockstep.
      vec2 disp = ringDisplacement(p, rippleCenter1, 0.0)
                + ringDisplacement(p, rippleCenter2, rippleMaxRadius * 0.5);
      p += disp * rippleAmplitude;

      vec2 warpedPixel = center + p * radii;

      if (length((warpedPixel - center) / radii) > 1.02) {
        return vec4(0.0);
      }

      vec2 warpedUV = (warpedPixel + vec2(scroll, 0.0)) / tileSize;
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

local function strokeHexagon(cx, cy, size)
  local pts = {}
  for i = 0, 5 do
    local angle = (math.pi / 3) * i - math.pi / 6
    pts[#pts + 1] = cx + size * math.cos(angle)
    pts[#pts + 1] = cy + size * math.sin(angle)
  end
  love.graphics.polygon("line", pts)
end

-- Quadratic bezier seam: deck → bowed toward center → keel (not all the way in)
local function curvedSeamPoints(cx, cy, rx, ry, startX, endX, segments)
  segments = segments or 18
  -- Bow AWAY from center mid-hull, then ease in at the keel
  local ctrlX = startX + (startX - cx) * 0.05
  local ctrlY = cy + ry * 0.48
  local pts = {}
  for i = 0, segments do
    local s = i / segments
    local omt = 1 - s
    local x = omt * omt * startX + 2 * omt * s * ctrlX + s * s * endX
    local y = omt * omt * cy + 2 * omt * s * ctrlY + s * s * (cy + ry)
    pts[#pts + 1] = x
    pts[#pts + 1] = y
  end
  return pts
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

  self.radius = math.sqrt(halfWidth * halfWidth + (halfHeight + grassHeight) * (halfHeight + grassHeight))

  self.rotationAngle = 0
  self.rotationSpeed = 0

  self.isImmovable   = true
  self.isPermanent   = true
  self.isSkyDome     = true
  self.isRoundedRect = true
  self.noSunShading  = true

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
  self.domeHexColor = parseRGBA(options.domeHexColor, { 0, 0, 0, 1 })
  self.domeHexOpacity = options.domeHexOpacity or 0.12
  self.domeHexScrollSpeed = options.domeHexScrollSpeed or 0.006
  self.domeHexLineWidth = options.domeHexLineWidth or 1

  self.domeForegroundHexSize = options.domeForegroundHexSize or (self.domeHexSize * 1.5)
  self.domeForegroundHexOpacity = options.domeForegroundHexOpacity or math.min(1, self.domeHexOpacity * 0.5)
  self.domeForegroundHexScrollSpeed = options.domeForegroundHexScrollSpeed or -0.01
  self.domeForegroundHexLineWidth = options.domeForegroundHexLineWidth or 2.5
  self.domeForegroundTintOpacity = options.domeForegroundTintOpacity or 2.0
  self.domeForegroundOutlineOpacity = options.domeForegroundOutlineOpacity or 0.2
  self.domeForegroundZoomReference = options.domeForegroundZoomReference or 1.0
  self.domeForegroundZoomFloor = options.domeForegroundZoomFloor or 0

  self.domeBulgeStrength = options.domeBulgeStrength or 0.55
  self.domeBulgeRadius = options.domeBulgeRadius or 2.0

  -- Subtle forcefield ripple — a single ring-shaped band of distortion
  -- expanding outward from the dome's own center, looping — see
  -- getBulgeShader's own comment for how this maps to the JS version's
  -- looping ShockwaveFilter pair. All distances are in the bulge
  -- shader's own normalized (radii-divided) space, where the dome's
  -- own edge sits at ~1.0.
  self.domeForegroundRippleAmplitude = options.domeForegroundRippleAmplitude or 0.01  -- how far a pixel gets displaced at the ring's peak
  self.domeForegroundRippleWidth = options.domeForegroundRippleWidth or 0.05         -- how wide (radially) the ring band is
  self.domeForegroundRippleSpeed = options.domeForegroundRippleSpeed or 0.3          -- how fast the ring's own radius grows, per second
  self.domeForegroundRippleMaxRadius = options.domeForegroundRippleMaxRadius or 1.3  -- radius the ring wraps back to 0 at — past the dome's own edge (~1.0), so it fully exits before restarting

  -- Two independent ripple SOURCES, not two concentric rings sharing
  -- the dome's own center — matches the JS version's two
  -- ShockwaveFilters, each with its own off-center point. Each {x, y}
  -- is an offset from the dome's true center, in the same normalized
  -- space as everything above (edge is ~1.0 away).
  self.domeForegroundRippleCenter1 = options.domeForegroundRippleCenter1 or { -0.3, -0.2 }
  self.domeForegroundRippleCenter2 = options.domeForegroundRippleCenter2 or { 0.3, -0.2 }

  self.hexGridCanvas = nil
  self.hexGridForegroundCanvas = nil
  self.hexGridTileW, self.hexGridTileH = 0, 0
  self.hexGridForegroundTileW, self.hexGridForegroundTileH = 0, 0
  self.fgQuad = nil

  self.lastImpactTime = 0
  self.shieldRipples = {}
  self.shieldSparks = {}

  self:createOffscreen()
  return self
end

----------------------------------------------------------------------
-- Geometry / physics
----------------------------------------------------------------------

function SkyDomePlanetoid:trueSurfaceY()
  return self.pos.y - self.halfHeight
end

function SkyDomePlanetoid:domeAnchorY()
  return self:trueSurfaceY() + self.grassHeight
end

function SkyDomePlanetoid:getPullAnchor()
  return self.pos.x, self:trueSurfaceY()
end

function SkyDomePlanetoid:isWithinGravityWindow(worldX, worldY)
  if worldY > self:trueSurfaceY() then return false end
  local nx = (worldX - self.pos.x) / self.domeRadiusX
  local ny = (worldY - self:domeAnchorY()) / self.domeRadiusY
  return (nx * nx + ny * ny) <= 1
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

function SkyDomePlanetoid:distanceToSurface(worldX, worldY)
  return self:nearestSurfacePoint(worldX, worldY).distance
end

function SkyDomePlanetoid:containsPoint(worldX, worldY)
  if self:isWithinGravityWindow(worldX, worldY) then
    return true
  end
  local topY = self:trueSurfaceY()
  local minX = self.pos.x - self.halfWidth
  local maxX = self.pos.x + self.halfWidth
  return worldX >= minX and worldX <= maxX
     and worldY >= topY - 4
     and worldY <= topY + self.grassHeight + 8
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

function SkyDomePlanetoid:getPerimeter()
  return self.halfWidth * 2
end

function SkyDomePlanetoid:arcPositionForWorldPoint(worldX, worldY)
  local minX = self.pos.x - self.halfWidth
  local maxX = self.pos.x + self.halfWidth
  local x = math.max(minX, math.min(maxX, worldX))
  return x - minX
end

function SkyDomePlanetoid:worldPointAtArcPosition(s, pushDistance)
  pushDistance = pushDistance or 0
  local perimeter = self:getPerimeter()
  if perimeter <= 0 then
    return {
      point = Vector2.new(self.pos.x, self:trueSurfaceY() - pushDistance),
      normal = Vector2.new(0, -1),
    }
  end
  s = ((s % perimeter) + perimeter) % perimeter
  local x = (self.pos.x - self.halfWidth) + s
  local y = self:trueSurfaceY() - pushDistance
  return {
    point = Vector2.new(x, y),
    normal = Vector2.new(0, -1),
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
-- FG lattice scroll
----------------------------------------------------------------------

-- Modded by the tile's own actual pixel width (not the fractional
-- geometric hexWidth) — this now has to line up EXACTLY with the GPU's
-- own repeat period (see getBulgeShader), where a mismatch would show
-- as a slow drift/seam instead of a clean tile-to-tile wrap.
function SkyDomePlanetoid:fgScroll()
  local tileW = self.hexGridForegroundTileW
  if not tileW or tileW <= 0 then return 0 end
  local nowMs = love.timer.getTime() * 1000
  return ((nowMs * self.domeForegroundHexScrollSpeed) % tileW + tileW) % tileW
end

----------------------------------------------------------------------
-- Hex bake
----------------------------------------------------------------------

function SkyDomePlanetoid:bakeHexGridTile(hexSize, opacity, lineWidth)
  local hexWidth = math.sqrt(3) * hexSize
  local hexHeightStep = hexSize * 1.5
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
    local rowOffset = (row % 2 ~= 0) and (hexWidth / 2) or 0
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

  local fwTile, fhTile
  self.hexGridForegroundCanvas, fwTile, fhTile =
    self:bakeHexGridTile(
      self.domeForegroundHexSize,
      self.domeForegroundHexOpacity,
      self.domeForegroundHexLineWidth
    )
  self.hexGridForegroundTileW = fwTile
  self.hexGridForegroundTileH = fhTile

  -- Lets the bulge shader (getBulgeShader) sample this one small baked
  -- tile as an infinitely repeating texture instead of needing a
  -- dome-sized canvas pre-tiled onto it every frame — see
  -- drawForegroundGlass's own comment for the full reasoning.
  self.hexGridForegroundCanvas:setWrap("repeat", "repeat")

  -- A single quad covering the dome's full box (domeRadiusX*2 x
  -- domeRadiusY), expressed in the tile's own repeat units — built
  -- once here and never touched again: unlike the old rebuilt-every-
  -- frame canvas, nothing about this quad's own geometry depends on
  -- scroll (that's applied in the shader instead, see getBulgeShader),
  -- and the dome's size never changes after construction.
  self.fgQuad = love.graphics.newQuad(
    0, 0, self.domeRadiusX * 2, self.domeRadiusY,
    self.hexGridForegroundTileW, self.hexGridForegroundTileH
  )
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
  local hull = closedHalf(cx, cy, rx, ry, false)

  local shader = getMetalShader()
  setMetalUniforms(self, cx, cy, rx, ry)

  love.graphics.setShader(shader)
  love.graphics.stencil(function()
    love.graphics.polygon("fill", hull)
  end, "replace", 1)
  love.graphics.setStencilTest("greater", 0)
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.rectangle("fill", cx - rx, cy, rx * 2, ry)
  love.graphics.setStencilTest()
  love.graphics.setShader()

  -- Deck lip matches grass.png metal (#6A6A70)
  love.graphics.setColor(106/255, 106/255, 112/255, 1)
  love.graphics.setLineWidth(3)
  love.graphics.line(cx - rx, cy, cx + rx, cy)

  -- Soft underside rim
  love.graphics.setColor(self.baseGlowColor[1], self.baseGlowColor[2], self.baseGlowColor[3], 0.08)
  love.graphics.setLineWidth(math.max(2, ry * 0.18))
  love.graphics.line(lowerArc(cx, cy, rx * 0.98, ry * 0.92))

  -- Horizontal plate seams (ellipse chords)
  love.graphics.setLineWidth(1.25)
  for i = 1, self.baseHorizontalLineCount do
    local t = i / (self.baseHorizontalLineCount + 1)
    local y = cy + ry * t
    local halfSpan = rx * math.sqrt(math.max(0, 1 - t * t))
    love.graphics.setColor(0.82, 0.84, 0.88, 0.06)
    love.graphics.line(cx - halfSpan, y - 1.2, cx + halfSpan, y - 1.2)
    love.graphics.setColor(0.04, 0.04, 0.05, 0.28)
    love.graphics.line(cx - halfSpan, y, cx + halfSpan, y)
  end

  -- Vertical panel seams: curve inward, stop short of center
  for i = 1, self.baseSeamCount - 1 do
    local t = i / self.baseSeamCount
    local startX = cx - rx + t * (rx * 2)
    local endX = cx + (startX - cx) * (1 - self.baseSeamConvergence)
    local pts = curvedSeamPoints(cx, cy, rx, ry, startX, endX, 20)
    love.graphics.setColor(0.03, 0.03, 0.035, 0.38)
    love.graphics.setLineWidth(1.6)
    love.graphics.line(pts)
    love.graphics.setColor(0.78, 0.80, 0.84, 0.07)
    love.graphics.setLineWidth(1)
    -- slight highlight offset
    local hi = {}
    for n = 1, #pts, 2 do
      hi[#hi + 1] = pts[n] + 1.2
      hi[#hi + 1] = pts[n + 1]
    end
    love.graphics.line(hi)
  end

  love.graphics.setColor(0.10, 0.10, 0.12, 0.85)
  love.graphics.setLineWidth(1.5)
  love.graphics.line(lowerArc(cx, cy, rx, ry))

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

  -- Samples hexGridForegroundCanvas — one small baked tile, set to
  -- wrap="repeat" — directly through the bulge shader via self.fgQuad,
  -- a fixed quad covering the dome's whole box in the tile's own
  -- repeat units (both built once in createOffscreen). This used to
  -- rebuild a dome-sized canvas from scratch (~184 tile draws plus a
  -- full render-target switch) every single frame just to re-tile the
  -- SAME small pattern at a slightly different scroll offset; now the
  -- GPU's own texture sampler handles the repeat, and only the scroll
  -- uniform changes frame to frame — no canvas rebuild at all anymore.
  if self.hexGridForegroundCanvas then
    love.graphics.stencil(function()
      love.graphics.polygon("fill", glass)
    end, "replace", 1)
    love.graphics.setStencilTest("greater", 0)

    local shader = getBulgeShader()
    shader:send("center", { self.domeRadiusX, self.domeRadiusY })
    shader:send("radii", { rx, ry })
    shader:send("strength", self.domeBulgeStrength)
    shader:send("radius", self.domeBulgeRadius)
    shader:send("tileSize", { self.hexGridForegroundTileW, self.hexGridForegroundTileH })
    shader:send("scroll", self:fgScroll())
    shader:send("rippleCenter1", self.domeForegroundRippleCenter1)
    shader:send("rippleCenter2", self.domeForegroundRippleCenter2)
    shader:send("rippleAmplitude", self.domeForegroundRippleAmplitude)
    shader:send("rippleWidth", self.domeForegroundRippleWidth)
    shader:send("rippleSpeed", self.domeForegroundRippleSpeed)
    shader:send("rippleMaxRadius", self.domeForegroundRippleMaxRadius)
    shader:send("rippleTime", love.timer.getTime())

    love.graphics.setShader(shader)
    love.graphics.setColor(1, 1, 1, zoomFactor * 0.95)
    love.graphics.draw(self.hexGridForegroundCanvas, self.fgQuad, cx - rx, cy - ry)
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