-- lua/entities/ElementPiece.lua
--
-- A piece of an element the astronaut mines by shooting things apart:
--   rubinium     what the red prisms are made of (see lua/world/Prism.lua)
--                — a handful are thrown out when a cluster of them is
--                shot apart (see main.lua's own breakPrismCluster).
--   asteroidium  what asteroids are made of — left when he shoots an
--                asteroid too small to break into smaller ones, and
--                sometimes by a bigger one instead of breaking (see
--                main.lua's own breakAsteroid).
-- Each piece tumbles outward for a moment, then turns and flies to him
-- on its own, wherever he is — as if pulled in by a tractor beam, though
-- there isn't one — and is added to state.elements when it reaches him.
--
-- Each is a six-sided gem, no two quite the same shape: its corners are
-- spread unevenly round it and sit at slightly different distances from
-- its middle, so its sides come out different lengths, but only a
-- little (see CORNER_ANGLE_JITTER / CORNER_DISTANCE_RANGE).

local Vector2 = require("lua.vector2")

local ElementPiece = {}
ElementPiece.__index = ElementPiece

local CORNER_ANGLE_JITTER = math.rad(11)   -- how far each corner may sit either way from an even 60 degrees apart
local CORNER_DISTANCE_RANGE = { 0.82, 1.15 } -- each corner's distance from the middle, as a fraction of the radius
local SPIN_RANGE = { 2, 6 }                -- radians per second it tumbles, either way
local GLOW_ALPHA = 0.22                    -- the soft light round it
local GLOW_SIZE = 2.2                      -- how far that reaches, in radii

-- What differs from one element to the next. Each range is { least, most }.
--   radius          world units, middle to corner, before the per-corner variation above
--   Thrown out of whatever broke, slowing as it goes...
--   burstSpeed      world units per second
--   burstDrag       how quickly that speed dies away (per second)
--   driftSeconds    ...for this long, before it starts toward him
--   ...then toward the astronaut, faster and faster.
--   homingStartSpeed    world units per second
--   homingAcceleration  world units per second, per second
--   homingMaxSpeed
--   homingTurnRate  how sharply it swings round to face him (per second; higher is sharper)
--   Colors: a cut gem — its six faces alternately faceLight and
--   faceDark, an outline, a bright spark in the middle, and a soft glow.
ElementPiece.ELEMENTS = {
  rubinium = {
    radius = { 8, 11 },
    burstSpeed = { 140, 320 }, burstDrag = 3.0, driftSeconds = { 0.35, 0.7 },
    homingStartSpeed = 120, homingAcceleration = 1500, homingMaxSpeed = 1400, homingTurnRate = 7,
    -- The prisms' own red.
    faceLight = { 1.0, 0.36, 0.32 }, faceDark = { 0.72, 0.10, 0.12 }, outline = { 0.30, 0.0, 0.03 },
    spark = { 1.0, 0.86, 0.8 }, glow = { 1.0, 0.52, 0.48 },
  },
  asteroidium = {
    radius = { 7, 10 },
    burstSpeed = { 60, 140 }, burstDrag = 2.5, driftSeconds = { 0.5, 0.9 },
    -- Slow: it drifts over to him rather than racing. Still quicker
    -- than he walks, so it does arrive.
    homingStartSpeed = 40, homingAcceleration = 160, homingMaxSpeed = 420, homingTurnRate = 4,
    -- The asteroids' own brown (see Asteroid.lua's self.color and its outline).
    faceLight = { 0.80, 0.44, 0.15 }, faceDark = { 0.50, 0.24, 0.06 }, outline = { 0.23, 0.11, 0.03 },
    spark = { 1.0, 0.86, 0.6 }, glow = { 0.95, 0.60, 0.25 },
  },
}

local function randomIn(range)
  return range[1] + math.random() * (range[2] - range[1])
end

-- elementName: a key of ElementPiece.ELEMENTS (and the name it's counted
-- under in state.elements). x, y: where it appears. dirX, dirY: roughly
-- the way it's thrown (it's given a random speed and knocked a little
-- off that line).
function ElementPiece.new(elementName, x, y, dirX, dirY)
  local self = setmetatable({}, ElementPiece)
  local element = ElementPiece.ELEMENTS[elementName]
  self.elementName = elementName
  self.element = element
  self.pos = Vector2.new(x, y)

  local angle = math.atan2(dirY, dirX) + (math.random() * 2 - 1) * 0.6
  local speed = randomIn(element.burstSpeed)
  self.vel = Vector2.new(math.cos(angle) * speed, math.sin(angle) * speed)

  self.radius = randomIn(element.radius)
  self.rotation = math.random() * math.pi * 2
  self.spin = randomIn(SPIN_RANGE) * (math.random() < 0.5 and -1 or 1)
  self.driftTime = randomIn(element.driftSeconds)
  self.homingSpeed = element.homingStartSpeed
  self.collected = false

  -- Its corners, round its own middle, unturned: { x1, y1, x2, y2, ... }.
  self.corners = {}
  for i = 0, 5 do
    local a = i * math.pi / 3 + (math.random() * 2 - 1) * CORNER_ANGLE_JITTER
    local d = self.radius * randomIn(CORNER_DISTANCE_RANGE)
    table.insert(self.corners, math.cos(a) * d)
    table.insert(self.corners, math.sin(a) * d)
  end

  return self
end

-- dt: seconds. Marks itself collected once it reaches the player (the
-- caller counts it and removes it — see main.lua).
function ElementPiece:update(dt, player)
  local element = self.element
  self.rotation = self.rotation + self.spin * dt

  if self.driftTime > 0 then
    self.driftTime = self.driftTime - dt
    local keep = math.max(0, 1 - element.burstDrag * dt)
    self.vel.x, self.vel.y = self.vel.x * keep, self.vel.y * keep
  elseif player then
    local dx, dy = player.pos.x - self.pos.x, player.pos.y - self.pos.y
    local dist = math.sqrt(dx * dx + dy * dy)
    if dist > 0.001 then
      self.homingSpeed = math.min(element.homingMaxSpeed, self.homingSpeed + element.homingAcceleration * dt)
      local turn = math.min(1, element.homingTurnRate * dt)
      self.vel.x = self.vel.x + (dx / dist * self.homingSpeed - self.vel.x) * turn
      self.vel.y = self.vel.y + (dy / dist * self.homingSpeed - self.vel.y) * turn
    end
  end

  self.pos.x = self.pos.x + self.vel.x * dt
  self.pos.y = self.pos.y + self.vel.y * dt

  if player and self.driftTime <= 0 then
    local dx, dy = player.pos.x - self.pos.x, player.pos.y - self.pos.y
    local reach = (player.radius or 0) + self.radius
    if dx * dx + dy * dy <= reach * reach then
      self.collected = true
    end
  end
end

function ElementPiece:draw()
  local element = self.element
  love.graphics.push()
  love.graphics.translate(self.pos.x, self.pos.y)

  -- Not turned with the gem — it's the same all the way round.
  local glow = element.glow
  love.graphics.setBlendMode("add", "alphamultiply")
  for i = 3, 1, -1 do
    love.graphics.setColor(glow[1], glow[2], glow[3], GLOW_ALPHA / i)
    love.graphics.circle("fill", 0, 0, self.radius * (1 + (GLOW_SIZE - 1) * i / 3))
  end
  love.graphics.setBlendMode("alpha")

  love.graphics.rotate(self.rotation)

  -- Six faces, each a triangle from the middle to one side.
  local c = self.corners
  for i = 0, 5 do
    local a, b = i * 2 + 1, ((i + 1) % 6) * 2 + 1
    local color = (i % 2 == 0) and element.faceLight or element.faceDark
    love.graphics.setColor(color[1], color[2], color[3], 1)
    love.graphics.polygon("fill", 0, 0, c[a], c[a + 1], c[b], c[b + 1])
  end

  local outline = element.outline
  love.graphics.setColor(outline[1], outline[2], outline[3], 1)
  love.graphics.setLineWidth(1.5)
  love.graphics.polygon("line", c)
  love.graphics.setLineWidth(1)

  local spark = element.spark
  love.graphics.setColor(spark[1], spark[2], spark[3], 0.9)
  love.graphics.circle("fill", 0, 0, self.radius * 0.18)

  love.graphics.pop()
  love.graphics.setColor(1, 1, 1, 1)
end

return ElementPiece
