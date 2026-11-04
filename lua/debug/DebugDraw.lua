-- lua/debug/DebugDraw.lua
--
-- The debug overlays, drawn in world space from love.draw. Each one
-- checks its own toggle, so love.draw can just call them:
--   C  state.showCollisionDebug  collision shapes
--   A  state.showBeltCellDebug   asteroid-belt cells
--   R  state.showInfluenceRings  gravity reach rings

local state = require("lua.state")
local constants = require("lua.constants")
local utils = require("lua.utils")
local worldGen = require("lua.setup.WorldGen")
local InfluenceRing = require("lua.effects.InfluenceRing")

local DebugDraw = {}

local NONE = {}

-- How strongly each gravity ring shows: brightest for the body pulling
-- on him now, clearly for any other whose reach he's inside, and for the
-- rest fading with how far outside the ring's edge he is.
local INFLUENCE_RING_ALPHA_PULLING = 0.9
local INFLUENCE_RING_ALPHA_INSIDE = 0.5
local INFLUENCE_RING_ALPHA_NEAR = 0.35   -- just outside its reach...
local INFLUENCE_RING_ALPHA_FAR = 0.05    -- ...down to this INFLUENCE_RING_FADE_DISTANCE beyond it
local INFLUENCE_RING_FADE_DISTANCE = 700

local function resetPen()
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.setLineWidth(1)
end

-- R: a ring at the edge of each round gravity source's reach. Only bodies
-- GravitySystem treats as plain circles (influenceRadius, not rounded
-- rects); the dome's and Tiled shapes' reach isn't a circle, so a ring
-- there would be wrong.
function DebugDraw.influenceRings()
  if not state.showInfluenceRings then return end
  local player = state.player
  local pulling = (player.onSurface and player.currentPlanet)
    or (state.gravitySystem and state.gravitySystem:findDominantPlanet(player.pos))
  for _, p in ipairs(state.planetoids) do
    if p.influenceRadius and not p.isRoundedRect
       and utils.isOnScreen(p.pos.x, p.pos.y, p.influenceRadius, 50) then
      local dx, dy = player.pos.x - p.pos.x, player.pos.y - p.pos.y
      local outside = math.sqrt(dx * dx + dy * dy) - p.influenceRadius -- negative: he's within its reach
      local alpha
      if p == pulling then
        alpha = INFLUENCE_RING_ALPHA_PULLING
      elseif outside <= 0 then
        alpha = INFLUENCE_RING_ALPHA_INSIDE
      else
        local t = math.min(1, outside / INFLUENCE_RING_FADE_DISTANCE)
        alpha = INFLUENCE_RING_ALPHA_NEAR + (INFLUENCE_RING_ALPHA_FAR - INFLUENCE_RING_ALPHA_NEAR) * t
      end
      InfluenceRing.draw(p.pos.x, p.pos.y, p.influenceRadius, alpha)
    end
  end
end

-- C: one Tiled level's collision shapes. Ground and ramps red, solid wall
-- blocks blue, wall-climb loops green. Green goes last because wall-climb
-- paths overlap wall blocks in the same tiles, and should stay visible.
function DebugDraw.levelShapes(level)
  if not state.showCollisionDebug then return end
  love.graphics.setLineWidth(4)
  love.graphics.setColor(1, 0, 0, 1)
  for _, shape in ipairs(level.shapes) do
    if not shape.isWallClimb then
      for _, seg in ipairs(shape.segments) do
        love.graphics.line(seg.a.x, seg.a.y, seg.b.x, seg.b.y)
      end
    end
  end
  love.graphics.setColor(0.2, 0.6, 1, 1)
  for _, wall in ipairs(level.walls or NONE) do
    love.graphics.rectangle("line",
      wall.pos.x - wall.halfWidth, wall.pos.y - wall.halfHeight,
      wall.halfWidth * 2, wall.halfHeight * 2)
  end
  love.graphics.setColor(0.2, 1, 0.2, 1)
  for _, shape in ipairs(level.shapes) do
    if shape.isWallClimb then
      for _, seg in ipairs(shape.segments) do
        love.graphics.line(seg.a.x, seg.a.y, seg.b.x, seg.b.y)
      end
    end
  end
  resetPen()
end

-- A: red over each cell of the 3x3 around him that's inside the asteroid
-- belt (the cells worldGen.updateActiveCells fills with belt planetoids),
-- and a blue line on every cell edge in view.
function DebugDraw.beltCells()
  if not (state.showBeltCellDebug and state.player) then return end
  local cellSize = worldGen.CELL_SIZE
  local playerCell = worldGen.cellCoordFor(state.player.pos.x, state.player.pos.y)
  love.graphics.setColor(1, 0, 0, 0.35)
  for dRow = -1, 1 do
    for dCol = -1, 1 do
      local col = playerCell.col + dCol
      local row = playerCell.row + dRow
      if worldGen.cellIntersectsBelt(col, row) then
        love.graphics.rectangle("fill", col * cellSize, row * cellSize, cellSize, cellSize)
      end
    end
  end

  local cam = state.camera or { x = 0, y = 0 }
  local visW = state.visibleWidth or 0
  local visH = state.visibleHeight or 0
  local firstCol = math.floor(cam.x / cellSize)
  local lastCol = math.floor((cam.x + visW) / cellSize) + 1
  local firstRow = math.floor(cam.y / cellSize)
  local lastRow = math.floor((cam.y + visH) / cellSize) + 1

  love.graphics.setColor(0.2, 0.6, 1, 0.9)
  love.graphics.setLineWidth(2)
  for col = firstCol, lastCol do
    local x = col * cellSize
    love.graphics.line(x, firstRow * cellSize, x, (lastRow + 1) * cellSize)
  end
  for row = firstRow, lastRow do
    local y = row * cellSize
    love.graphics.line(firstCol * cellSize, y, (lastCol + 1) * cellSize, y)
  end
  resetPen()
end

-- Magenta: the player's capsule (see CollisionSystem:handlePlayerWallCollisions).
-- The bottom circle sits at player.pos; the top one is raised to reach his
-- head. On a wall-climb shape, or as a ball, it's a plain circle.
local function drawPlayerCapsule()
  local player = state.player
  local r = player.radius
  local onWallClimb = player.onSurface and player.currentPlanet and player.currentPlanet.isWallClimb
  local headReach = (not player.isBall and not onWallClimb) and (player.headReach or 0) or 0
  local topY = player.pos.y - math.max(0, headReach - r)
  local bottomY = player.pos.y
  local px = player.pos.x

  love.graphics.setLineWidth(3)
  love.graphics.setColor(1, 0.2, 1, 1)
  love.graphics.circle("line", px, bottomY, r)
  love.graphics.circle("line", px, topY, r)
  if topY < bottomY then
    love.graphics.line(px - r, topY, px - r, bottomY)
    love.graphics.line(px + r, topY, px + r, bottomY)
  end
  resetPen()
end

-- Orange: where his circle first touches each Spikey
-- (see CollisionSystem:handlePlayerSpikeyCollisions).
local function drawSpikeyBounds()
  if not (state.player and state.spikeys) then return end
  local playerRadius = state.player.radius
  love.graphics.setLineWidth(3)
  love.graphics.setColor(1, 0.55, 0, 1)
  for _, sp in ipairs(state.spikeys) do
    if utils.isOnScreen(sp.pos.x, sp.pos.y, sp.radius + playerRadius, 20) then
      love.graphics.circle("line", sp.pos.x, sp.pos.y, sp.radius + playerRadius + constants.SURFACE_TOLERANCE)
    end
  end
  resetPen()
end

-- Cyan: each Ooomba's contact circle (see
-- CollisionSystem:handlePlayerOoombaCollisions; fireballs use it too).
local function drawOoombaBounds()
  if not state.ooombas then return end
  love.graphics.setLineWidth(3)
  love.graphics.setColor(0.2, 0.9, 1, 1)
  for _, o in ipairs(state.ooombas) do
    if utils.isOnScreen(o.pos.x, o.pos.y, o.hitRadius, 20) then
      love.graphics.circle("line", o.pos.x, o.pos.y, o.hitRadius)
    end
  end
  resetPen()
end

-- Yellow: the sky dome's containment (see
-- CollisionSystem:handlePlayerSkyDomeContainment): the two side walls,
-- the deck, and the upper half of the glass ellipse, the only half that
-- is enforced.
local function drawSkyDomeBounds()
  local dome = state.skyDomePlanet
  if not dome then return end
  love.graphics.setLineWidth(3)
  love.graphics.setColor(1, 1, 0.2, 1)

  local deckY = dome:trueSurfaceY()
  local domeTopY = dome:domeAnchorY() - dome.domeRadiusY
  love.graphics.line(dome.pos.x - dome.halfWidth, deckY, dome.pos.x - dome.halfWidth, domeTopY)
  love.graphics.line(dome.pos.x + dome.halfWidth, deckY, dome.pos.x + dome.halfWidth, domeTopY)
  love.graphics.line(dome.pos.x - dome.halfWidth, deckY, dome.pos.x + dome.halfWidth, deckY)

  local cx, cy = dome.pos.x, dome:domeAnchorY()
  local rx, ry = dome.domeRadiusX, dome.domeRadiusY
  local segments = 72
  local points = {}
  for i = 0, segments do
    local t = math.pi + (i / segments) * math.pi
    points[#points + 1] = cx + math.cos(t) * rx
    points[#points + 1] = cy + math.sin(t) * ry
  end
  love.graphics.line(points)
  resetPen()
end

-- C: the player's, Spikeys', Ooombas' and the sky dome's collision shapes.
function DebugDraw.collisionShapes()
  if not state.showCollisionDebug then return end
  drawPlayerCapsule()
  drawSpikeyBounds()
  drawOoombaBounds()
  drawSkyDomeBounds()
end

return DebugDraw
