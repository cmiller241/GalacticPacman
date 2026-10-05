-- lua/interiors/PinballInterior.lua
--
-- Port-flavored equivalent of js/interiors/PlatformInterior.js's own
-- EXTERIOR overlay half (not the walkable interior-mode scene itself
-- -- that file's own header comment draws the same distinction: this
-- is the semi-transparent "there's a level in here" schematic drawn
-- on the planet from OUTSIDE it, while just flying past, not what
-- renders once/if the player actually goes in). Baked once to an
-- offscreen canvas (a pinball table layout — outer walls, a plunger
-- lane, two bumper clusters, two rows of drop targets, slingshot
-- kickers, and two flippers guarding the drain) and drawn centered on
-- a planetoid's own position, clipped to its silhouette.
--
-- Assumes planetoid.isRoundedRect (see lua/world/RoundedRectPlanetoid.lua)
-- — the PinballPlanet is deliberately a tall rounded rect rather than a
-- plain circle, per explicit request: "we'll be able to put more
-- pinball level into a rectangle than a circle."
--
-- Nothing about actually entering/playing it is wired up yet — see
-- main.lua's own PinballPlanet setup comment. :getPortalPosition()
-- is kept anyway, matching js/interiors/Interior.js's own API
-- contract, so wiring an actual "enter" action up later doesn't need
-- this file touched again.

local Vector2 = require("lua.vector2")

local PinballInterior = {}
PinballInterior.__index = PinballInterior

-- Native size this whole layout is baked/designed at — tall and
-- narrow, matching a real pinball table's own proportions. The
-- planetoid's own halfWidth/halfHeight (set in main.lua) don't have
-- to match this exactly; :draw() scales the baked canvas to fill
-- whatever size the planet actually is (see :scaleFor).
local CANVAS_W, CANVAS_H = 380, 760
local OVERLAY_ALPHA = 0.6
local WALL_THICK = 14

local COLOR_WALL = { 0.72, 0.76, 0.82 }
local COLOR_WALL_RIM = { 0.35, 0.38, 0.44 }
local COLOR_BUMPER = { 0.95, 0.25, 0.25 }
local COLOR_BUMPER_RIM = { 1, 0.85, 0.3 }
local COLOR_TARGET = { 1, 0.75, 0.2 }
local COLOR_FLIPPER = { 0.85, 0.85, 0.9 }
local COLOR_LANE_MARK = { 0.5, 0.9, 1 }
local COLOR_SLINGSHOT = { 0.6, 0.65, 0.72 }

function PinballInterior.new(planetoid)
  local self = setmetatable({}, PinballInterior)
  self.planetoid = planetoid
  self.canvas = nil
  self.portalLocalX, self.portalLocalY = 0, 0
  self:ensureCanvas()
  return self
end

local function drawBumper(cx, cy, r)
  love.graphics.setColor(COLOR_BUMPER)
  love.graphics.circle("fill", cx, cy, r)
  love.graphics.setColor(COLOR_BUMPER_RIM)
  love.graphics.setLineWidth(3)
  love.graphics.circle("line", cx, cy, r)
  love.graphics.circle("fill", cx, cy, r * 0.35)
end

-- length/angle in the flipper's own rest orientation; mirrored flips
-- it left-right so the same shape can guard either side of the drain.
local function drawFlipper(cx, cy, length, angle, mirrored)
  love.graphics.push()
  love.graphics.translate(cx, cy)
  love.graphics.rotate(angle)
  local sx = mirrored and -1 or 1
  love.graphics.setColor(COLOR_FLIPPER)
  love.graphics.polygon("fill",
    0, -8,
    length * sx, -3,
    length * sx, 3,
    0, 8)
  love.graphics.pop()
end

local function drawTargetRow(y, count, spacing, startX)
  love.graphics.setColor(COLOR_TARGET)
  for i = 0, count - 1 do
    love.graphics.rectangle("fill", startX + i * spacing, y, 26, 10)
  end
end

-- Bakes the pinball-table schematic once (same "bake once, draw many"
-- precedent as every other baked-canvas body in this codebase) — cheap
-- to call every :draw(), since it no-ops once self.canvas exists.
function PinballInterior:ensureCanvas()
  if self.canvas then return end
  local canvas = love.graphics.newCanvas(CANVAS_W, CANVAS_H)
  love.graphics.push()
  love.graphics.origin()
  love.graphics.setCanvas(canvas)
  love.graphics.clear(0, 0, 0, 0)

  local laneX = CANVAS_W - 56

  -- Outer walls + the plunger lane's own dividing wall.
  love.graphics.setColor(COLOR_WALL)
  love.graphics.rectangle("fill", 0, 0, CANVAS_W, WALL_THICK)                             -- top
  love.graphics.rectangle("fill", 0, 0, WALL_THICK, CANVAS_H)                             -- left
  love.graphics.rectangle("fill", CANVAS_W - WALL_THICK, 0, WALL_THICK, CANVAS_H)         -- right
  love.graphics.rectangle("fill", laneX - WALL_THICK / 2, 60, WALL_THICK, CANVAS_H - 160) -- lane divider
  love.graphics.setColor(COLOR_WALL_RIM)
  love.graphics.setLineWidth(2)
  love.graphics.rectangle("line", WALL_THICK, WALL_THICK, CANVAS_W - WALL_THICK * 2, CANVAS_H - WALL_THICK)

  -- Lane kicker chevrons, pointing up the plunger lane — more of them
  -- than the old square layout had, now that there's a full extra
  -- stretch of lane length to fill.
  love.graphics.setColor(COLOR_LANE_MARK)
  for i = 0, 7 do
    local y = CANVAS_H - 100 - i * 70
    local x = laneX + 28
    love.graphics.line(x - 9, y + 7, x, y, x + 9, y + 7)
  end

  -- Upper bumper triangle.
  drawBumper(CANVAS_W * 0.33, CANVAS_H * 0.16, 22)
  drawBumper(CANVAS_W * 0.52, CANVAS_H * 0.11, 22)
  drawBumper(CANVAS_W * 0.42, CANVAS_H * 0.24, 22)

  drawTargetRow(CANVAS_H * 0.32, 4, 42, CANVAS_W * 0.18)

  -- A second, lone bumper further down the table — extra content the
  -- taller rectangular layout has room for that the old circular one
  -- didn't.
  drawBumper(CANVAS_W * 0.38, CANVAS_H * 0.48, 24)

  drawTargetRow(CANVAS_H * 0.58, 4, 42, CANVAS_W * 0.18)

  -- Slingshot kickers — the classic angled walls funneling the ball
  -- down toward each flipper.
  love.graphics.setColor(COLOR_SLINGSHOT)
  love.graphics.setLineWidth(10)
  love.graphics.line(CANVAS_W * 0.20, CANVAS_H * 0.78, CANVAS_W * 0.34, CANVAS_H * 0.86)
  love.graphics.line(CANVAS_W * 0.62, CANVAS_H * 0.86, CANVAS_W * 0.76, CANVAS_H * 0.78)

  -- Flippers guarding the drain at the very bottom.
  drawFlipper(CANVAS_W * 0.38, CANVAS_H - 55, 48, 0.35, false)
  drawFlipper(CANVAS_W * 0.60, CANVAS_H - 55, 48, -0.35 + math.pi, true)

  love.graphics.setCanvas()
  love.graphics.pop()
  love.graphics.setColor(1, 1, 1, 1)

  self.canvas = canvas
  -- Launch point (bottom of the plunger lane) — matches
  -- js/interiors/Interior.js's own getPortalPosition() contract: one
  -- fixed world point an "enter" action would aim the player at.
  self.portalLocalX = laneX + 28
  self.portalLocalY = CANVAS_H - 30
end

-- Independent X/Y scale so the baked (fixed-aspect) canvas fills
-- whatever actual halfWidth/halfHeight the planetoid has, even if
-- that's not exactly CANVAS_W:CANVAS_H's own proportions.
function PinballInterior:scaleFor()
  local p = self.planetoid
  return (p.halfWidth * 2) / CANVAS_W, (p.halfHeight * 2) / CANVAS_H
end

-- Rotates a point in the planet's own local space (origin at its
-- center) by its current rotationAngle and offsets it to world space
-- — same convention PullBeam.lua/LockOutline.lua/Mirror.lua already
-- use for rounded-rect/rotating bodies.
local function localToWorld(p, localX, localY)
  local angle = p.rotationAngle or 0
  local cosA, sinA = math.cos(angle), math.sin(angle)
  return p.pos.x + localX * cosA - localY * sinA,
         p.pos.y + localX * sinA + localY * cosA
end

function PinballInterior:getPortalPosition()
  local p = self.planetoid
  local scaleX, scaleY = self:scaleFor()
  local localX = (self.portalLocalX - CANVAS_W / 2) * scaleX
  local localY = (self.portalLocalY - CANVAS_H / 2) * scaleY
  local x, y = localToWorld(p, localX, localY)
  return Vector2.new(x, y)
end

-- Call from inside the same camera-transformed push() block every
-- other world object draws from. Clipped to the planet's own rounded-
-- rect silhouette — the baked canvas is a plain rectangle corner to
-- corner, and without this it would visibly poke out past the rounded
-- corners underneath it.
function PinballInterior:draw()
  self:ensureCanvas()
  local p = self.planetoid
  local scaleX, scaleY = self:scaleFor()

  love.graphics.push()
  love.graphics.translate(p.pos.x, p.pos.y)
  love.graphics.rotate(p.rotationAngle or 0)

  love.graphics.stencil(function()
    love.graphics.rectangle("fill", -p.halfWidth, -p.halfHeight, p.halfWidth * 2, p.halfHeight * 2, p.cornerRadius, p.cornerRadius)
  end, "replace", 1)
  love.graphics.setStencilTest("greater", 0)

  love.graphics.setColor(1, 1, 1, OVERLAY_ALPHA)
  love.graphics.draw(self.canvas, -p.halfWidth, -p.halfHeight, 0, scaleX, scaleY)
  love.graphics.setColor(1, 1, 1, 1)

  love.graphics.setStencilTest()
  love.graphics.pop()

  -- Pulsing launch-point glow, same idea as PlatformInterior.js's own
  -- portal dot — a visual hint something lives here, even with no
  -- actual "enter" action wired to it yet.
  local portal = self:getPortalPosition()
  local pulse = (math.sin(love.timer.getTime() * 3) + 1) / 2
  local r = (8 + pulse * 3) * math.min(scaleX, scaleY)
  love.graphics.setColor(0.2, 1, 0.3, 0.5 + pulse * 0.3)
  love.graphics.circle("fill", portal.x, portal.y, r * 2)
  love.graphics.setColor(0.2, 1, 0.3, 0.85)
  love.graphics.circle("fill", portal.x, portal.y, r)
  love.graphics.setColor(1, 1, 1, 1)
end

return PinballInterior
