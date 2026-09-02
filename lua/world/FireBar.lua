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

function FireBar:draw()
  local x, y = self.pos.x, self.pos.y
  local r = self.blockRadius

  -- Block first (fireballs pass in front)
  love.graphics.setColor(43/255, 43/255, 43/255, 1)
  love.graphics.rectangle("fill", x - r, y - r, r * 2, r * 2)
  love.graphics.setColor(17/255, 17/255, 17/255, 1)
  love.graphics.setLineWidth(3)
  love.graphics.rectangle("line", x - r, y - r, r * 2, r * 2)

  local now = love.timer.getTime()
  local fireballs = self:getFireballPositions()
  for i, f in ipairs(fireballs) do
    local flicker = 0.85 + math.sin(now * 12 + i * 1.7) * 0.15
    local radius = f.radius * flicker

    -- Soft outer glow (layered circles; no Canvas gradient)
    love.graphics.setColor(1, 140/255, 40/255, 0.18)
    love.graphics.circle("fill", f.x, f.y, radius * 2.2)
    love.graphics.setColor(1, 80/255, 20/255, 0.10)
    love.graphics.circle("fill", f.x, f.y, radius * 1.6)

    -- Flame body
    love.graphics.setColor(1, 85/255, 34/255, 0.85)
    love.graphics.circle("fill", f.x, f.y, radius)
    love.graphics.setColor(1, 176/255, 46/255, 0.95)
    love.graphics.circle("fill", f.x, f.y, radius * 0.62)
    love.graphics.setColor(1, 242/255, 192/255, 1)
    love.graphics.circle("fill", f.x, f.y, radius * 0.28)
  end

  for _, e in ipairs(self.embers) do
    local a = math.max(0, e.life)
    local er, eg, eb = hslaApprox(e.hue, 1, 0.6, a)
    love.graphics.setColor(er, eg, eb, a)
    love.graphics.circle("fill", e.x, e.y, e.radius)
  end

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.setLineWidth(1)
end

return FireBar