-- lua/world/FireBar.lua
--
-- Port of js/world/FireBar.js
-- Immovable pivot block + rotating double-sided fireball bar + embers.
-- Collision: block is solid (isImmovable + radius). Fireballs are
-- hazard-only via getFireballPositions() (CollisionSystem already
-- has handlePlayerFireBarCollisions).

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local utils = require("lua.utils")
local Flame = require("lua.effects.Flame")

----------------------------------------------------------------------
-- Ember (decorative only)
----------------------------------------------------------------------

local FireEmber = {}
FireEmber.__index = FireEmber

function FireEmber.new(x, y)
  local self = setmetatable({}, FireEmber)
  self.x = x
  self.y = y
  local angle = math.random() * math.pi * 2
  local speed = 0.3 + math.random() * 0.6
  self.vx = math.cos(angle) * speed
  self.vy = math.sin(angle) * speed - 0.35
  self.life = 1
  self.decay = 0.025 + math.random() * 0.03
  self.radius = 1.3 + math.random() * 2
  self.hue = 18 + math.random() * 30
  return self
end

function FireEmber:update(timeScale)
  self.x = self.x + self.vx * timeScale
  self.y = self.y + self.vy * timeScale
  self.vx = self.vx * (0.97 ^ timeScale)
  self.vy = self.vy * (0.97 ^ timeScale)
  self.life = self.life - self.decay * timeScale
end

----------------------------------------------------------------------
-- FireBar
----------------------------------------------------------------------

local FireBar = {}
FireBar.__index = FireBar

function FireBar.new(x, y, options)
  options = options or {}
  local self = setmetatable({}, FireBar)

  self.pos = Vector2.new(x, y)
  self.isImmovable = true

  self.blockRadius = options.blockRadius or 25

  -- Deliberately SMALLER than blockRadius, and only used for the
  -- generic immovable-vs-movable push in
  -- CollisionSystem:handleImmovableCollisions (planetoids/asteroids
  -- vs. the bar's pivot) — NOT the drawn block size or the player's
  -- lethal-touch radius, both of which still use blockRadius directly.
  -- Aliasing this straight to blockRadius (25) meant a planetoid got
  -- shoved out to (its own radius + 25) and settled exactly there;
  -- with several differently-sized planetoids drifting through over
  -- time, that produced a visible clump/ring sitting right at the
  -- bar's edge. Shrinking just the collision radius means a planetoid
  -- has to get much closer before being pushed out at all. Shrunk
  -- further still (2 -> 0.5): belt planetoids drifting near a bar's
  -- pivot were still visibly pooling around it even at 2 -- the
  -- smaller the overlap window, the less often the elastic bounce
  -- here fights BeltOrbitSystem's own sun-centered restore force for
  -- control of a passing planetoid.
  self.radius = options.collisionRadius or 0.5

  self.barLength = options.barLength or 500
  self.numFireballs = options.numFireballs or 10
  self.fireballRadius = options.fireballRadius or 15
  self.rotationSpeed = options.rotationSpeed or 0.05
  self.angle = options.startAngle or 0
  self.emberSpawnChance = options.emberSpawnChance or 0.15
  self.embers = {}
  -- Seconds of flame animation (see draw), advanced by update with the
  -- game's own time scale, so VATS slow-mo slows the fire too. Random
  -- start so neighbouring bars don't flicker in step.
  self.flameTime = math.random() * 100

  return self
end

function FireBar:getFireballPositions()
  local positions = {}
  local dirX = math.cos(self.angle)
  local dirY = math.sin(self.angle)
  for i = 1, self.numFireballs do
    local dist = (i / self.numFireballs) * self.barLength
    positions[#positions + 1] = {
      x = self.pos.x + dirX * dist,
      y = self.pos.y + dirY * dist,
      radius = self.fireballRadius,
    }
    positions[#positions + 1] = {
      x = self.pos.x - dirX * dist,
      y = self.pos.y - dirY * dist,
      radius = self.fireballRadius,
    }
  end
  return positions
end

function FireBar:update()
  local timeScale = state.timeScale or 1
  self.angle = self.angle + self.rotationSpeed * timeScale
  self.flameTime = self.flameTime + timeScale / 60

  -- Ember spawning (getFireballPositions() plus a per-fireball roll,
  -- numFireballs*2 positions) is skipped entirely while this bar is
  -- off-screen — purely decorative, so there's nothing to preserve by
  -- keeping it running unseen. Existing embers still decay/get culled
  -- below regardless, so the list doesn't grow unbounded while a bar
  -- is off-screen and then never shrinks back once it's visible again.
  if utils.isOnScreen(self.pos.x, self.pos.y, self.barLength + self.fireballRadius, 100) then
    local fireballs = self:getFireballPositions()
    for _, f in ipairs(fireballs) do
      if math.random() < self.emberSpawnChance * timeScale then
        table.insert(self.embers, FireEmber.new(f.x, f.y))
      end
    end
  end

  for i = #self.embers, 1, -1 do
    self.embers[i]:update(timeScale)
    if self.embers[i].life <= 0 then
      table.remove(self.embers, i)
    end
  end
end

local function hslaApprox(hue, sat, light, alpha)
  -- hue in degrees (JS hsla), sat/light 0–1
  local h = (hue % 360) / 360
  local s = sat
  local l = light
  local function hue2rgb(p, q, t)
    if t < 0 then t = t + 1 end
    if t > 1 then t = t - 1 end
    if t < 1/6 then return p + (q - p) * 6 * t end
    if t < 1/2 then return q end
    if t < 2/3 then return p + (q - p) * (2/3 - t) * 6 end
    return p
  end
  local r, g, b
  if s == 0 then
    r, g, b = l, l, l
  else
    local q = l < 0.5 and l * (1 + s) or l + s - l * s
    local p = 2 * l - q
    r = hue2rgb(p, q, h + 1/3)
    g = hue2rgb(p, q, h)
    b = hue2rgb(p, q, h - 1/3)
  end
  return r, g, b, alpha
end

----------------------------------------------------------------------
-- Drawing resources (built once, shared by every bar)
----------------------------------------------------------------------

-- A soft round white glow, fading to nothing at its edge — tinted and
-- drawn additively for the hub's heat and the embers' halos.
local glowImage = nil
local function getGlow()
  if glowImage then return glowImage end
  local size = 64
  local data = love.image.newImageData(size, size)
  data:mapPixel(function(px, py)
    local dx = (px + 0.5) / size * 2 - 1
    local dy = (py + 0.5) / size * 2 - 1
    local t = math.max(0, 1 - math.sqrt(dx * dx + dy * dy))
    return 1, 1, 1, t * t
  end)
  glowImage = love.graphics.newImage(data)
  -- (The game's default filter is "nearest", for its pixel art — this
  -- one's scaled up a lot and needs to stay smooth.)
  glowImage:setFilter("linear", "linear")
  return glowImage
end

local function drawGlow(img, x, y, diameter)
  local w = img:getWidth()
  love.graphics.draw(img, x, y, 0, diameter / w, diameter / w, w / 2, w / 2)
end

-- The pivot block's face: lit from above, darker toward the bottom.
local function makeBlockMesh(r)
  return love.graphics.newMesh({
    { -r, -r, 0, 0, 0.36, 0.35, 0.34, 1 },
    {  r, -r, 1, 0, 0.30, 0.29, 0.28, 1 },
    {  r,  r, 1, 1, 0.11, 0.10, 0.10, 1 },
    { -r,  r, 0, 1, 0.15, 0.14, 0.13, 1 },
  }, "fan", "static")
end

local MAX_TAIL = 2.0       -- extra tail length (in radii) at full swing speed
local TAIL_SPEED = 12      -- swing speed (world units per frame) for that full tail

function FireBar:draw()
  local x, y = self.pos.x, self.pos.y
  local r = self.blockRadius
  local t = self.flameTime
  local glow = getGlow()

  love.graphics.push("all")

  -- Block first (fireballs pass in front): a riveted metal block with a
  -- red-hot socket in the middle that the arms spin out of.
  if not self.blockMesh then self.blockMesh = makeBlockMesh(r) end
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(self.blockMesh, x, y)
  love.graphics.setLineWidth(1.5)
  love.graphics.setColor(1, 1, 1, 0.14)
  love.graphics.line(x - r + 3, y + r - 4, x - r + 3, y - r + 3, x + r - 4, y - r + 3)
  love.graphics.setLineWidth(3)
  love.graphics.setColor(0.07, 0.07, 0.07, 1)
  love.graphics.rectangle("line", x - r, y - r, r * 2, r * 2, 3, 3)
  for sy = -1, 1, 2 do
    for sx = -1, 1, 2 do
      local rx, ry = x + sx * r * 0.68, y + sy * r * 0.68
      love.graphics.setColor(0.06, 0.06, 0.06, 1)
      love.graphics.circle("fill", rx, ry + 0.8, r * 0.11)
      love.graphics.setColor(0.45, 0.44, 0.42, 1)
      love.graphics.circle("fill", rx, ry, r * 0.09)
    end
  end

  local pulse = 0.85 + 0.15 * math.sin(t * 5)
  love.graphics.setColor(0.05, 0.03, 0.02, 1)
  love.graphics.circle("fill", x, y, r * 0.5)
  love.graphics.setBlendMode("add")
  love.graphics.setColor(1, 0.4, 0.08, 0.6 * pulse)
  drawGlow(glow, x, y, r * 2.6)
  love.graphics.setColor(1, 0.7, 0.3, pulse)
  love.graphics.circle("fill", x, y, r * 0.3)
  love.graphics.setBlendMode("alpha")
  -- The axle, turning with the arms.
  local ax, ay = math.cos(self.angle) * r * 0.42, math.sin(self.angle) * r * 0.42
  love.graphics.setColor(0.08, 0.05, 0.04, 1)
  love.graphics.setLineWidth(4)
  love.graphics.line(x - ax, y - ay, x + ax, y + ay)

  -- Fireballs (see lua/effects/Flame.lua).
  local omega = self.rotationSpeed
  for i, f in ipairs(self:getFireballPositions()) do
    local radius = f.radius * (0.93 + math.sin(t * 12 + i * 1.7) * 0.07)
    -- Swinging round the pivot: velocity is omega x offset.
    local ox, oy = f.x - x, f.y - y
    local vx, vy = -omega * oy, omega * ox
    local speed = math.sqrt(vx * vx + vy * vy)
    local dirAngle = speed > 0.01 and math.atan2(vy, vx) or -math.pi / 2
    local stretch = 1 + math.min(speed / TAIL_SPEED, 1) * MAX_TAIL
    Flame.draw(f.x, f.y, radius, dirAngle, stretch, t, i * 3.17)
  end

  -- Embers: glowing sparks, cooling from bright yellow to dull red.
  love.graphics.setBlendMode("add")
  for _, e in ipairs(self.embers) do
    local a = math.max(0, e.life)
    local er, eg, eb = hslaApprox(e.hue, 1, 0.35 + 0.4 * a, a)
    love.graphics.setColor(er, eg, eb, a * 0.5)
    drawGlow(glow, e.x, e.y, e.radius * 7)
    love.graphics.setColor(er, eg, eb, a)
    love.graphics.circle("fill", e.x, e.y, e.radius * 0.8)
  end

  love.graphics.pop()
end

return FireBar