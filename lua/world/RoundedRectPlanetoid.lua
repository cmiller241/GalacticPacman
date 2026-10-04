-- lua/world/RoundedRectPlanetoid.lua
--
-- Port of js/world/RoundedRectPlanetoid.js — a rounded-rectangle
-- planetoid the player can land on and walk all the way AROUND (every
-- edge and corner, not just the top), pull-target, and bounce off of
-- like any ordinary circular Planetoid.
--
-- The core surface math below (worldToLocal/nearestSurfacePoint/
-- buildSegments/arc-length walking) is the SAME formula
-- lua/world/JumpPlatform.lua already carries (see that file's own
-- header comment — it was ported from this exact JS source first,
-- for a one-sided jump pad) — kept as its own local copy here rather
-- than factored into a shared module, matching how this codebase
-- generally prefers a self-contained file per entity over an early
-- shared-geometry abstraction. What's different from JumpPlatform:
-- this one does NOT set isSkyDome (gravity/landing work from every
-- side, not just a window above the top), isPullExempt (it's a normal
-- pull target), or noSunShading (it gets the same live directional
-- shading every other planetoid gets, adapted to a rounded-rect
-- silhouette — see :drawSunShading).
--
-- Drifts and spins like any other field planetoid by default (self.vel,
-- self.rotationAngle/rotationSpeed) — whoever spawns a "this one stays
-- put" instance (main.lua's own dome-adjacent landmark, for example)
-- overrides isImmovable/isPermanent afterward, same convention
-- Sphere.lua's own fixed instances already use rather than this
-- constructor forcing it.
--
-- No influence-ring drawing (JS's own ringCanvas) — main.lua's generic
-- ring debug pass already excludes every isRoundedRect planet outright
-- (a circular ring would misrepresent a rectangular influence shape),
-- and both existing isRoundedRect classes here (SkyDomePlanetoid,
-- JumpPlatform) already settled on simply not drawing one rather than
-- building a rounded-rect-shaped replacement — this follows that same
-- established call instead of reopening it.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local constants = require("lua.constants")
local Planetoid = require("lua.world.Planetoid")

local RoundedRectPlanetoid = {}
RoundedRectPlanetoid.__index = RoundedRectPlanetoid

-- x, y: world center. halfWidth/halfHeight: half-extents of the core
-- box (before rounding). cornerRadius: clamped to never exceed either
-- half-extent, same guard the JS original uses. color: {r,g,b,a} 0..1,
-- multiplied against the shared rocky planetTexture the same way every
-- other Planetoid-family body tints it.
function RoundedRectPlanetoid.new(x, y, halfWidth, halfHeight, cornerRadius, color)
  local self = setmetatable({}, RoundedRectPlanetoid)

  self.pos = Vector2.new(x, y)
  self.halfWidth = halfWidth
  self.halfHeight = halfHeight
  self.cornerRadius = math.min(cornerRadius or 0, halfWidth, halfHeight)
  self.color = color or { 0.62, 0.58, 0.5, 1 }

  -- Bounding-circle radius — NOT the true surface distance anywhere
  -- except the four corners (see :nearestSurfacePoint for the real
  -- thing) — used only where other systems already expect a plain
  -- circular .radius: scene-edge bounce (main.lua's own
  -- updatePlanetoidsPhysics) and CollisionSystem:handleElasticCollisions'
  -- planet-vs-planet bouncing. This planet genuinely participates in
  -- that momentum-conserving bounce; it's just bouncing off this
  -- circular approximation rather than the exact rounded-rect
  -- silhouette there — same tradeoff the JS original's own header
  -- comment describes. Gravity/landing/walking/pull-targeting all use
  -- :nearestSurfacePoint/the arc-position methods below instead, never
  -- this.
  self.radius = math.sqrt(halfWidth * halfWidth + halfHeight * halfHeight)
  self.mass = (2 * halfWidth) * (2 * halfHeight)
  self.influenceRadius = self.radius + constants.INFLUENCE_PADDING

  local direction = Vector2.new(math.random() * 2 - 1, math.random() * 2 - 1):normalize()
  self.vel = direction:multiply(constants.PLANET_SPEED)

  -- Slow spin — the player/coins riding the surface stay glued to it as
  -- it turns, same as they already stay glued to a drifting circular
  -- planet: every surface query below goes through worldToLocal/
  -- localDirToWorld, which read self.rotationAngle fresh every call, so
  -- nothing about "currently attached to this surface" needs special-
  -- casing for the spin. Advanced each frame by :update() — see its own
  -- comment.
  self.rotationAngle = math.random() * math.pi * 2
  self.rotationSpeed = 0.0006

  self.isSpikey = false
  self.isRoundedRect = true

  self.bodyCanvas = nil
  self.bodyCanvasPadding = 0
  self.bodyCanvasScale = 2
  self.eclipseMesh = nil
  self.sunShadingMesh = nil

  self._segments = self:buildSegments()

  return self
end

------------------------------------------------------------------
-- Local/world frame helpers
------------------------------------------------------------------

function RoundedRectPlanetoid:worldToLocal(worldX, worldY)
  local dx, dy = worldX - self.pos.x, worldY - self.pos.y
  local c, s = math.cos(-self.rotationAngle), math.sin(-self.rotationAngle)
  return dx * c - dy * s, dx * s + dy * c
end

function RoundedRectPlanetoid:localDirToWorld(lx, ly)
  local c, s = math.cos(self.rotationAngle), math.sin(self.rotationAngle)
  return Vector2.new(lx * c - ly * s, lx * s + ly * c)
end

function RoundedRectPlanetoid:localPointToWorld(lx, ly)
  local w = self:localDirToWorld(lx, ly)
  w.x = w.x + self.pos.x
  w.y = w.y + self.pos.y
  return w
end

------------------------------------------------------------------
-- Surface geometry (rounded-rect: clamp to the core rect, push out by
-- cornerRadius — one formula for flat edges AND corners)
------------------------------------------------------------------

function RoundedRectPlanetoid:nearestSurfacePoint(worldX, worldY)
  local lx, ly = self:worldToLocal(worldX, worldY)
  local coreHW = self.halfWidth - self.cornerRadius
  local coreHH = self.halfHeight - self.cornerRadius
  local cr = self.cornerRadius

  local cx = math.max(-coreHW, math.min(coreHW, lx))
  local cy = math.max(-coreHH, math.min(coreHH, ly))
  local dx, dy = lx - cx, ly - cy
  local len = math.sqrt(dx * dx + dy * dy)

  if len < 1e-6 then
    local distV, distH = coreHW - math.abs(lx), coreHH - math.abs(ly)
    if distV < distH then
      dx, dy = (lx >= 0 and 1 or -1), 0
    else
      dx, dy = 0, (ly >= 0 and 1 or -1)
    end
    len = 1
  end
  dx, dy = dx / len, dy / len

  local sx, sy = cx + dx * cr, cy + dy * cr
  local distance = math.sqrt((lx - sx) ^ 2 + (ly - sy) ^ 2)

  return {
    point = self:localPointToWorld(sx, sy),
    normal = self:localDirToWorld(dx, dy),
    distance = distance,
  }
end

function RoundedRectPlanetoid:distanceToSurface(worldX, worldY)
  return self:nearestSurfacePoint(worldX, worldY).distance
end

-- Used for right-click/R1 "pull star" target selection
-- (Player:trySelectPullTarget) — same formula as nearestSurfacePoint's
-- own clamp-then-check, just a boolean instead of the full result.
function RoundedRectPlanetoid:containsPoint(worldX, worldY)
  local lx, ly = self:worldToLocal(worldX, worldY)
  local coreHW = self.halfWidth - self.cornerRadius
  local coreHH = self.halfHeight - self.cornerRadius
  local cr = self.cornerRadius
  local cx = math.max(-coreHW, math.min(coreHW, lx))
  local cy = math.max(-coreHH, math.min(coreHH, ly))
  local dx, dy = lx - cx, ly - cy
  return (dx * dx + dy * dy) <= cr * cr
end

------------------------------------------------------------------
-- Arc-length perimeter walking (right edge -> BR corner -> bottom edge
-- -> BL corner -> left edge -> TL corner -> top edge -> TR corner) —
-- this is what lets the player/coins walk all the way around the shape
-- with the same single-scalar "position on the surface" a circle gets
-- for free from its own angle.
------------------------------------------------------------------

function RoundedRectPlanetoid:buildSegments()
  local coreHW = self.halfWidth - self.cornerRadius
  local coreHH = self.halfHeight - self.cornerRadius
  local hw, hh, cr = self.halfWidth, self.halfHeight, self.cornerRadius
  return {
    { type = "edge", length = 2 * coreHH, start = { x = hw, y = -coreHH }, dir = { x = 0, y = 1 }, normal = { x = 1, y = 0 } },
    { type = "corner", length = (math.pi / 2) * cr, center = { x = coreHW, y = coreHH }, startAngle = 0 },
    { type = "edge", length = 2 * coreHW, start = { x = coreHW, y = hh }, dir = { x = -1, y = 0 }, normal = { x = 0, y = 1 } },
    { type = "corner", length = (math.pi / 2) * cr, center = { x = -coreHW, y = coreHH }, startAngle = math.pi / 2 },
    { type = "edge", length = 2 * coreHH, start = { x = -hw, y = coreHH }, dir = { x = 0, y = -1 }, normal = { x = -1, y = 0 } },
    { type = "corner", length = (math.pi / 2) * cr, center = { x = -coreHW, y = -coreHH }, startAngle = math.pi },
    { type = "edge", length = 2 * coreHW, start = { x = -coreHW, y = -hh }, dir = { x = 1, y = 0 }, normal = { x = 0, y = -1 } },
    { type = "corner", length = (math.pi / 2) * cr, center = { x = coreHW, y = -coreHH }, startAngle = 3 * math.pi / 2 },
  }
end

function RoundedRectPlanetoid:getPerimeter()
  local total = 0
  for _, seg in ipairs(self._segments) do total = total + seg.length end
  return total
end

function RoundedRectPlanetoid:pointAtLocalArcPosition(s)
  local perimeter = self:getPerimeter()
  local remaining = ((s % perimeter) + perimeter) % perimeter
  for _, seg in ipairs(self._segments) do
    if remaining <= seg.length then
      if seg.type == "edge" then
        return {
          point = { x = seg.start.x + seg.dir.x * remaining, y = seg.start.y + seg.dir.y * remaining },
          tangent = seg.dir,
          normal = seg.normal,
        }
      end
      local angle = seg.startAngle + remaining / self.cornerRadius
      local c, s2 = math.cos(angle), math.sin(angle)
      return {
        point = { x = seg.center.x + self.cornerRadius * c, y = seg.center.y + self.cornerRadius * s2 },
        tangent = { x = -s2, y = c },
        normal = { x = c, y = s2 },
      }
    end
    remaining = remaining - seg.length
  end
  local seg = self._segments[1]
  return { point = seg.start, tangent = seg.dir, normal = seg.normal }
end

-- Inverse: given a LOCAL point already on/near the boundary, returns the
-- arc-length s that produced it — used when the player lands, to
-- initialize their walk position from wherever they touched down.
function RoundedRectPlanetoid:arcPositionForLocalPoint(lx, ly)
  local coreHW = self.halfWidth - self.cornerRadius
  local coreHH = self.halfHeight - self.cornerRadius
  local cr = self.cornerRadius
  local cumRightEdge = 2 * coreHH
  local cumBR = cumRightEdge + (math.pi / 2) * cr
  local cumBottomEdge = cumBR + 2 * coreHW
  local cumBL = cumBottomEdge + (math.pi / 2) * cr
  local cumLeftEdge = cumBL + 2 * coreHH
  local cumTL = cumLeftEdge + (math.pi / 2) * cr
  local cumTopEdge = cumTL + 2 * coreHW
  local function norm(a) return ((a % (2 * math.pi)) + 2 * math.pi) % (2 * math.pi) end

  if lx >= coreHW and ly >= coreHH then
    return cumRightEdge + norm(math.atan2(ly - coreHH, lx - coreHW)) * cr
  end
  if lx <= -coreHW and ly >= coreHH then
    return cumBottomEdge + (norm(math.atan2(ly - coreHH, lx + coreHW)) - math.pi / 2) * cr
  end
  if lx <= -coreHW and ly <= -coreHH then
    return cumLeftEdge + (norm(math.atan2(ly + coreHH, lx + coreHW)) - math.pi) * cr
  end
  if lx >= coreHW and ly <= -coreHH then
    return cumTopEdge + (norm(math.atan2(ly + coreHH, lx - coreHW)) - 3 * math.pi / 2) * cr
  end
  if lx > coreHW then return ly + coreHH end
  if ly > coreHH then return cumBR + (coreHW - lx) end
  if lx < -coreHW then return cumBL + (coreHH - ly) end
  if ly < -coreHH then return cumTL + (lx + coreHW) end

  -- Inside the core rect (shouldn't happen for a landing query) — fall
  -- back to the nearest edge.
  local distR, distL, distB, distT = coreHW - lx, lx + coreHW, coreHH - ly, ly + coreHH
  local minH, minV = math.min(distR, distL), math.min(distB, distT)
  if minH < minV then
    if distR < distL then return ly + coreHH end
    return cumBL + (coreHH - ly)
  end
  if distB < distT then return cumBR + (coreHW - lx) end
  return cumTL + (lx + coreHW)
end

function RoundedRectPlanetoid:arcPositionForWorldPoint(worldX, worldY)
  local lx, ly = self:worldToLocal(worldX, worldY)
  return self:arcPositionForLocalPoint(lx, ly)
end

-- World-space wrapper: returns { point: Vector2 (world, pushed outward
-- by pushDistance), normal: Vector2 (world, unit) }. Player uses
-- pushDistance=player.radius, Coin uses its own orbitOffset — same
-- parameterization, different offset (see Coin.lua's own isRoundedRect
-- branch).
function RoundedRectPlanetoid:worldPointAtArcPosition(s, pushDistance)
  pushDistance = pushDistance or 0
  local local_ = self:pointAtLocalArcPosition(s)
  local normal = self:localDirToWorld(local_.normal.x, local_.normal.y)
  local surfacePoint = self:localPointToWorld(local_.point.x, local_.point.y)
  local point = surfacePoint
  if pushDistance ~= 0 then
    point = surfacePoint:clone():add(normal:clone():multiply(pushDistance))
  end
  return { point = point, normal = normal }
end

------------------------------------------------------------------
-- Update (spin only — position drift, if not overridden to immovable,
-- is handled generically by main.lua's own updatePlanetoidsPhysics the
-- same as every other planet's self.vel already is)
------------------------------------------------------------------

function RoundedRectPlanetoid:update()
  local ts = state.timeScale or 1
  self.rotationAngle = self.rotationAngle + self.rotationSpeed * ts
end

------------------------------------------------------------------
-- Drawing
------------------------------------------------------------------

-- Bakes the body ONCE (cached on self.bodyCanvas, not shared across
-- instances the way circular Planetoid's own cache is — there are only
-- ever a handful of these, not hundreds, so a per-instance bake is
-- plenty): a soft glow border (same layered-falloff technique
-- Planetoid.lua's own ensureBodyCanvas uses for its circular glow, just
-- drawn as successively padded rounded rects instead of circles), then
-- the shared rocky planetTexture tiled and tinted by self.color, clipped
-- to the rounded-rect shape. Baked at 2x resolution (bodyCanvasScale)
-- for a crisper glow edge, same convention the circular version uses.
function RoundedRectPlanetoid:ensureBodyCanvas()
  if self.bodyCanvas then return end
  if not state.planetTexture then return end

  local padding = Planetoid.SHADOW_PADDING
  self.bodyCanvasPadding = padding
  local scale = self.bodyCanvasScale
  local w, h = self.halfWidth * 2, self.halfHeight * 2
  local cr = self.cornerRadius * scale
  local canvasW, canvasH = (w + padding * 2) * scale, (h + padding * 2) * scale
  local originX, originY = padding * scale, padding * scale

  local canvas = love.graphics.newCanvas(canvasW, canvasH)
  canvas:setFilter("linear", "linear")

  love.graphics.push()
  love.graphics.origin()
  love.graphics.setCanvas({ canvas, stencil = true })
  love.graphics.clear(0, 0, 0, 0)
  love.graphics.setBlendMode("alpha")

  local GLOW_LAYERS = 18
  for i = GLOW_LAYERS, 1, -1 do
    local t = i / GLOW_LAYERS
    local pad = padding * scale * t
    local falloff = (1 - t) * (1 - t)
    local alpha = Planetoid.SHADOW_COLOR[4] * falloff * 0.85
    love.graphics.setColor(Planetoid.SHADOW_COLOR[1], Planetoid.SHADOW_COLOR[2], Planetoid.SHADOW_COLOR[3], alpha)
    love.graphics.rectangle("fill",
      originX - pad, originY - pad, w * scale + pad * 2, h * scale + pad * 2,
      cr + pad, cr + pad)
  end

  love.graphics.stencil(function()
    love.graphics.rectangle("fill", originX, originY, w * scale, h * scale, cr, cr)
  end, "replace", 1)
  love.graphics.setStencilTest("greater", 0)

  local tiles = 2.5
  local texW, texH = state.planetTexture:getDimensions()
  local texSize = math.max(w, h) * scale * tiles
  love.graphics.setColor(self.color[1], self.color[2], self.color[3], self.color[4] or 1)
  love.graphics.draw(state.planetTexture,
    originX + w * scale / 2, originY + h * scale / 2, 0,
    texSize / texW, texSize / texH, texW / 2, texH / 2)

  love.graphics.setStencilTest()
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.setCanvas()
  love.graphics.pop()

  self.bodyCanvas = canvas
end

function RoundedRectPlanetoid:draw()
  -- Shadow first (behind everything) — borrows circular Planetoid's own
  -- method directly (same "pass self as the receiver" trick
  -- SpikeyVertical.draw = Spikey.draw already uses elsewhere in this
  -- codebase): it only ever reads self.pos/self.radius/self.eclipseMesh,
  -- all of which this class has too, so the exact same soft trapezoidal
  -- shadow every circular planet gets just works here unmodified.
  Planetoid.drawEclipseShadow(self)

  self:ensureBodyCanvas()

  love.graphics.push()
  love.graphics.translate(self.pos.x, self.pos.y)
  love.graphics.rotate(self.rotationAngle)

  if self.bodyCanvas then
    local padding = self.bodyCanvasPadding or 0
    local invScale = 1 / self.bodyCanvasScale
    love.graphics.setColor(1, 1, 1, 1)
    love.graphics.draw(
      self.bodyCanvas,
      -(self.halfWidth + padding), -(self.halfHeight + padding),
      0, invScale, invScale)
  else
    love.graphics.setColor(self.color[1], self.color[2], self.color[3], self.color[4] or 1)
    love.graphics.rectangle("fill", -self.halfWidth, -self.halfHeight,
      self.halfWidth * 2, self.halfHeight * 2, self.cornerRadius, self.cornerRadius)
    love.graphics.setColor(1, 1, 1, 1)
  end

  love.graphics.pop()

  self:drawSunShading()
end

-- Live directional shading, recomputed every frame (not baked — the
-- target direction shifts continuously as this planet drifts/spins and
-- the sun's own relative angle changes, cheap enough for the handful of
-- these that exist). Two passes, same split circular Planetoid's own
-- :drawSunShading uses: a directional gradient (dark at the point
-- opposite the sun, unchanged toward it) blended "multiply", then a
-- flat overall-darkness fill on top. LÖVE has no direct gradient-fill
-- primitive the way Canvas2D's createLinearGradient (what the JS
-- original actually uses here) does, so the gradient is a vertex-
-- colored quad mesh instead — same "dynamic mesh, rewritten via
-- setVertices every frame" technique circular Planetoid's own
-- eclipseMesh already uses, oriented along the local direction to the
-- sun and clipped to the rounded-rect via stencil.
function RoundedRectPlanetoid:drawSunShading()
  local sunX, sunY = (state.sceneWidth or 0) / 2, (state.sceneHeight or 0) / 2
  local toSunX, toSunY = sunX - self.pos.x, sunY - self.pos.y
  local distToSun = math.sqrt(toSunX * toSunX + toSunY * toSunY)
  local worldAngleToSun = math.atan2(toSunY, toSunX)
  -- Subtracting rotationAngle keeps the gradient pointed at the true
  -- sun regardless of this planet's own current spin, same reasoning
  -- the JS original's own localAngle has.
  local localAngle = worldAngleToSun - self.rotationAngle
  local hx, hy = math.cos(localAngle), math.sin(localAngle)

  local maxDist = math.sqrt((state.sceneWidth or 0) ^ 2 + (state.sceneHeight or 0) ^ 2) / 2
  local distT = maxDist > 0 and math.min(distToSun / maxDist, 1) or 0
  local overlayAlpha = Planetoid.SUN_MIN_ALPHA + distT * (Planetoid.SUN_MAX_ALPHA - Planetoid.SUN_MIN_ALPHA)

  local w, h = self.halfWidth * 2, self.halfHeight * 2
  local extent = math.max(self.halfWidth, self.halfHeight) * 1.3

  love.graphics.push()
  love.graphics.translate(self.pos.x, self.pos.y)
  love.graphics.rotate(self.rotationAngle)

  love.graphics.stencil(function()
    love.graphics.rectangle("fill", -self.halfWidth, -self.halfHeight, w, h, self.cornerRadius, self.cornerRadius)
  end, "replace", 1)
  love.graphics.setStencilTest("greater", 0)

  -- A big quad straddling the shape, long axis along the sun direction,
  -- generously oversized (extent) so it fully covers the stencil region
  -- regardless of this rect's own aspect ratio or current spin. Premultiplied
  -- alpha (all four channels carrying overlayAlpha at the "dark" end, matching
  -- circular Planetoid's own setColor(shadowAlpha,shadowAlpha,shadowAlpha,
  -- shadowAlpha) convention for this exact blend mode) — black stays
  -- black regardless, white fades toward "no darkening" as overlayAlpha
  -- shrinks with distance from the sun.
  local px, py = -hy, hx
  local vertices = {
    { -hx * extent + px * extent, -hy * extent + py * extent, 0, 0, 0, 0, 0, overlayAlpha },
    { -hx * extent - px * extent, -hy * extent - py * extent, 0, 0, 0, 0, 0, overlayAlpha },
    {  hx * extent - px * extent,  hy * extent - py * extent, 0, 0, overlayAlpha, overlayAlpha, overlayAlpha, overlayAlpha },
    {  hx * extent + px * extent,  hy * extent + py * extent, 0, 0, overlayAlpha, overlayAlpha, overlayAlpha, overlayAlpha },
  }
  if not self.sunShadingMesh then
    self.sunShadingMesh = love.graphics.newMesh(vertices, "fan", "dynamic")
  else
    self.sunShadingMesh:setVertices(vertices)
  end

  love.graphics.setBlendMode("multiply", "premultiplied")
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(self.sunShadingMesh)

  local overallDarkness = Planetoid.SUN_MAX_DARKNESS * distT
  if overallDarkness > 0 then
    love.graphics.setBlendMode("alpha")
    love.graphics.setColor(0, 0, 0, overallDarkness)
    love.graphics.rectangle("fill", -self.halfWidth, -self.halfHeight, w, h, self.cornerRadius, self.cornerRadius)
  end

  love.graphics.setBlendMode("alpha")
  love.graphics.setStencilTest()
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.pop()
end

return RoundedRectPlanetoid
