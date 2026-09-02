-- lua/world/JumpPlatform.lua
--
-- Port of js/world/JumpPlatform.js. A small, fixed, non-rotating platform
-- the player can jump onto and stand on. Reuses the same top-only
-- gravity/landing-window concept as SkyDomePlanetoid (isSkyDome), which
-- GravitySystem.findDominantPlanet, CollisionSystem.tryLandOnPlanet, and
-- Player's pull-target selection already handle generically via that flag
-- plus isRoundedRect — see those modules for the shared logic. This file
-- only needs to supply the shape's own geometry (nearestSurfacePoint,
-- isWithinGravityWindow, arc-length walking) and its own rendering.
--
-- Unlike SkyDomePlanetoid (a simplified top-only deck), JumpPlatform
-- carries the FULL generic rounded-rect surface math from
-- RoundedRectPlanetoid.js (js/world/RoundedRectPlanetoid.js) — clamp to
-- the core rect, push out by cornerRadius — so the player can land/walk
-- on any of its four sides/corners, not just the top.
--
-- Deliberately excluded from pull-beam target selection (isPullExempt) —
-- jump-only, never a valid pull target.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local constants = require("lua.constants")

local JumpPlatform = {}
JumpPlatform.__index = JumpPlatform

----------------------------------------------------------------------
-- Shared tileset quads (platform.png: 3 cols x 2 rows of 32x32 tiles)
----------------------------------------------------------------------

local tileQuadCache = nil -- keyed by "srcX,srcY" -> Quad, built once against state.platformTexture

local function getTileQuad(srcX, srcY)
  local img = state.platformTexture
  if not img then return nil end

  if not tileQuadCache then tileQuadCache = {} end
  local key = srcX .. "," .. srcY
  local quad = tileQuadCache[key]
  if quad then return quad end

  local texW, texH = img:getDimensions()
  quad = love.graphics.newQuad(srcX, srcY, 32, 32, texW, texH)
  tileQuadCache[key] = quad
  return quad
end

----------------------------------------------------------------------
-- Constructor
----------------------------------------------------------------------

function JumpPlatform.new(x, y, width, height, options)
  options = options or {}
  local self = setmetatable({}, JumpPlatform)

  local halfWidth = width / 2
  local halfHeight = height / 2

  self.pos = Vector2.new(x, y)
  self.vel = Vector2.new(0, 0)
  self.halfWidth = halfWidth
  self.halfHeight = halfHeight
  self.cornerRadius = math.min(options.cornerRadius or 0, halfWidth, halfHeight)
  self.color = options.color or { 0.54, 0.54, 0.54, 1 } -- fallback fill if platform.png isn't loaded yet

  self.rotationAngle = 0
  self.rotationSpeed = 0

  self.isImmovable = true
  self.isSkyDome = true     -- reuses SkyDomePlanetoid's top-only gravity/landing/jump-carry gating
  self.isRoundedRect = true
  self.isPullExempt = true  -- excluded from pull-beam target selection
  self.noSunShading = true

  self.radius = math.sqrt(halfWidth * halfWidth + halfHeight * halfHeight)
  self.mass = (2 * halfWidth) * (2 * halfHeight)
  self.influenceRadius = self.radius + (constants.INFLUENCE_PADDING or 200)

  self.gravityWindowHeight = options.gravityWindowHeight or 150

  -- Subtle top-to-bottom darkening over the platform's own body — bottom
  -- slightly darker, fading up to no darkening at the top. Kept low
  -- since it's meant to read as a subtle depth cue, not a visible band.
  self.bottomDarkenAlpha = options.bottomDarkenAlpha or 0.50
  self.bottomDarkenReach = options.bottomDarkenReach or 0.4

  self._segments = self:buildSegments()
  self.darkenMesh = self:buildDarkenMesh()

  return self
end

----------------------------------------------------------------------
-- Local/world frame helpers (rotationAngle is always 0 in practice —
-- nothing in main.lua's update loop ever advances it, same as
-- SkyDomePlanetoid — but this stays generic rather than assuming that)
----------------------------------------------------------------------

function JumpPlatform:worldToLocal(worldX, worldY)
  local dx = worldX - self.pos.x
  local dy = worldY - self.pos.y
  local c, s = math.cos(-self.rotationAngle), math.sin(-self.rotationAngle)
  return dx * c - dy * s, dx * s + dy * c
end

function JumpPlatform:localDirToWorld(lx, ly)
  local c, s = math.cos(self.rotationAngle), math.sin(self.rotationAngle)
  return Vector2.new(lx * c - ly * s, lx * s + ly * c)
end

function JumpPlatform:localPointToWorld(lx, ly)
  local w = self:localDirToWorld(lx, ly)
  w.x = w.x + self.pos.x
  w.y = w.y + self.pos.y
  return w
end

----------------------------------------------------------------------
-- Surface geometry (rounded-rect: clamp to core rect, push out by
-- cornerRadius — one formula for flat edges AND corners)
----------------------------------------------------------------------

function JumpPlatform:nearestSurfacePoint(worldX, worldY)
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

function JumpPlatform:distanceToSurface(worldX, worldY)
  return self:nearestSurfacePoint(worldX, worldY).distance
end

function JumpPlatform:containsPoint(worldX, worldY)
  local lx, ly = self:worldToLocal(worldX, worldY)
  local coreHW = self.halfWidth - self.cornerRadius
  local coreHH = self.halfHeight - self.cornerRadius
  local cr = self.cornerRadius
  local cx = math.max(-coreHW, math.min(coreHW, lx))
  local cy = math.max(-coreHH, math.min(coreHH, ly))
  local dx, dy = lx - cx, ly - cy
  return (dx * dx + dy * dy) <= cr * cr
end

-- Same shape as SkyDomePlanetoid's — a rectangular capture zone directly
-- above the platform's own top surface, nothing outside it.
function JumpPlatform:isWithinGravityWindow(worldX, worldY)
  local withinX = worldX >= self.pos.x - self.halfWidth and worldX <= self.pos.x + self.halfWidth
  local topY = self.pos.y - self.halfHeight
  local withinY = worldY <= topY and worldY >= topY - self.gravityWindowHeight
  return withinX and withinY
end

----------------------------------------------------------------------
-- Arc-length perimeter walking (right edge -> BR corner -> bottom edge
-- -> BL corner -> left edge -> TL corner -> top edge -> TR corner)
----------------------------------------------------------------------

function JumpPlatform:buildSegments()
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

function JumpPlatform:getPerimeter()
  local total = 0
  for _, seg in ipairs(self._segments) do total = total + seg.length end
  return total
end

function JumpPlatform:pointAtLocalArcPosition(s)
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

function JumpPlatform:arcPositionForLocalPoint(lx, ly)
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

  -- Inside the core rect (shouldn't happen for a landing query) —
  -- fall back to nearest edge.
  local distR, distL, distB, distT = coreHW - lx, lx + coreHW, coreHH - ly, ly + coreHH
  local minH, minV = math.min(distR, distL), math.min(distB, distT)
  if minH < minV then
    if distR < distL then return ly + coreHH end
    return cumBL + (coreHH - ly)
  end
  if distB < distT then return cumBR + (coreHW - lx) end
  return cumTL + (lx + coreHW)
end

function JumpPlatform:arcPositionForWorldPoint(worldX, worldY)
  local lx, ly = self:worldToLocal(worldX, worldY)
  return self:arcPositionForLocalPoint(lx, ly)
end

function JumpPlatform:worldPointAtArcPosition(s, pushDistance)
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

----------------------------------------------------------------------
-- Drawing — platform.png's 6-tile, 96x64 tileset (three 32x32 tiles per
-- row: left edge / center / right edge; row 0 = grass top, row 1 =
-- reused for every row beneath it), scaled 2x (64 world units/tile).
----------------------------------------------------------------------

function JumpPlatform:buildDarkenMesh()
  local w, h = self.halfWidth * 2, self.halfHeight * 2
  local fadeStart = h * (1 - self.bottomDarkenReach)
  local a = self.bottomDarkenAlpha
  local vertices = {
    { 0, fadeStart, 0, 0, 0, 0, 0, 0 },
    { w, fadeStart, 0, 0, 0, 0, 0, 0 },
    { w, h, 0, 0, 0, 0, 0, a },
    { 0, h, 0, 0, 0, 0, 0, a },
  }
  return love.graphics.newMesh(vertices, "fan", "static")
end

function JumpPlatform:draw()
  local topLeftX = self.pos.x - self.halfWidth
  local topY = self.pos.y - self.halfHeight
  local w, h = self.halfWidth * 2, self.halfHeight * 2
  local platformImg = state.platformTexture

  if not platformImg then
    love.graphics.setColor(self.color[1], self.color[2], self.color[3], self.color[4] or 1)
    love.graphics.rectangle("fill", topLeftX, topY, w, h, self.cornerRadius, self.cornerRadius)
    love.graphics.setColor(1, 1, 1, 1)
    return
  end

  love.graphics.stencil(function()
    love.graphics.rectangle("fill", topLeftX, topY, w, h, self.cornerRadius, self.cornerRadius)
  end, "replace", 1)
  love.graphics.setStencilTest("greater", 0)

  local scale = 2
  local tile = 32 * scale
  local cols = math.max(1, math.floor(w / tile + 0.5))
  local rows = math.max(1, math.floor(h / tile + 0.5))

  love.graphics.setColor(1, 1, 1, 1)
  for r = 0, rows - 1 do
    local srcY = (r == 0) and 0 or 32
    for c = 0, cols - 1 do
      local srcX
      if cols == 1 then
        srcX = 32 -- no single tile is both edges at once — center is the least-wrong fallback
      elseif c == 0 then
        srcX = 0
      elseif c == cols - 1 then
        srcX = 64
      else
        srcX = 32
      end
      local quad = getTileQuad(srcX, srcY)
      if quad then
        love.graphics.draw(platformImg, quad, topLeftX + c * tile, topY + r * tile, 0, scale, scale)
      end
    end
  end

  if self.darkenMesh then
    love.graphics.setColor(1, 1, 1, 1) -- vertex colors already carry black @ alpha; draw color stays neutral
    love.graphics.draw(self.darkenMesh, topLeftX, topY)
  end

  love.graphics.setStencilTest()
  love.graphics.setColor(1, 1, 1, 1)
end

-- Suppresses any inherited-style influence ring — same reasoning as
-- SkyDomePlanetoid: misleading for anything whose gravity only works in
-- a small window above it, not a ring all around it. Nothing here ever
-- builds one, so this is a no-op kept only so generic callers that
-- probe for it (none currently do) find a safe method.
function JumpPlatform:createRingCanvas() end

return JumpPlatform
