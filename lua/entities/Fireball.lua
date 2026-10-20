-- lua/entities/Fireball.lua
--
-- Port of js/entities/world/Fireball.js

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local Flame = require("lua.effects.Flame")

local FIREBALL_SPEED = 14
local FIREBALL_LIFE = 70
local TRAIL_SPAWN_CHANCE = 0.9
local TRAIL_PUFFS_PER_FRAME = 3
local TRAIL_PARTICLE_LIFE_MIN = 14
local TRAIL_PARTICLE_LIFE_RANGE = 12
local SPARK_SPAWN_CHANCE = 0.35
local SPARK_LIFE_MIN = 8
local SPARK_LIFE_RANGE = 8
local OFFSCREEN_MARGIN = 400

local Fireball = {}
Fireball.__index = Fireball

-- The look (see Fireball:draw): a shader flame for the head (the same
-- one as the fire bars', lua/effects/Flame.lua) with a long comet tail,
-- a heat glow round it, a trail of fire puffs that cool into drifting
-- smoke, and sparks streaking off behind.
local FLAME_RADIUS = 11         -- the drawn head (its hit radius is self.radius)
local FLAME_STRETCH = 3.2       -- its comet tail, in head radii
local PUFF_FIRE_FRACTION = 0.4  -- the first part of a puff's life it's fire; smoke after
local PUFF_GROWTH = 1.8         -- how much bigger a puff gets over its life

-- A soft round white glow, fading smoothly to nothing at its edge.
local GLOW_SIZE = 64
local glowImage = nil
local function getGlow()
  if glowImage then return glowImage end
  local data = love.image.newImageData(GLOW_SIZE, GLOW_SIZE)
  local half = GLOW_SIZE / 2
  data:mapPixel(function(x, y)
    local d = math.sqrt((x + 0.5 - half) ^ 2 + (y + 0.5 - half) ^ 2) / half
    local v = math.max(0, 1 - d)
    return 1, 1, 1, v * v
  end)
  glowImage = love.graphics.newImage(data)
  glowImage:setFilter("linear", "linear")
  return glowImage
end

local function drawGlow(x, y, diameter)
  love.graphics.draw(getGlow(), x, y, 0, diameter / GLOW_SIZE, diameter / GLOW_SIZE, GLOW_SIZE / 2, GLOW_SIZE / 2)
end

-- Fire's colour as it cools: t = 1 white-yellow, 0.5 orange, 0 deep red.
local function fireColor(t)
  if t > 0.5 then
    local k = (t - 0.5) * 2
    return 1, 0.55 + 0.4 * k, 0.12 + 0.45 * k
  end
  local k = t * 2
  return 0.75 + 0.25 * k, 0.12 + 0.43 * k, 0.03 + 0.09 * k
end

function Fireball.new(x, y, angle)
  local self = setmetatable({}, Fireball)
  self.pos = Vector2.new(x, y)
  self.vel = Vector2.new(math.cos(angle), math.sin(angle)):multiply(FIREBALL_SPEED)
  self.life = FIREBALL_LIFE
  self.trail = {}
  self.sparks = {}
  self.radius = 8
  self.flickerPhase = math.random() * math.pi * 2
  -- Seconds of flame animation, in game time (so V.A.T.S. slow-mo slows
  -- the fire too); a random start so two shots don't churn in step.
  self.flameTime = math.random() * 100
  return self
end

function Fireball:isDead()
  return self.life <= 0
end

function Fireball:update()
  local ts = state.timeScale or 1
  self.pos:addScaled(self.vel, ts)
  self.life = self.life - ts
  self.flameTime = self.flameTime + ts / 60

  -- Trail: puffs left behind (drifting on a little, the way it was
  -- going), fire at first, then smoke.
  -- (Several a frame, spread back along the step it just took, so the
  -- trail stays unbroken at its speed.)
  for _ = 1, TRAIL_PUFFS_PER_FRAME do
    if math.random() < TRAIL_SPAWN_CHANCE * ts then
      local spread = 8
      local back = math.random() * ts
      local maxLife = TRAIL_PARTICLE_LIFE_MIN + math.random() * TRAIL_PARTICLE_LIFE_RANGE
      table.insert(self.trail, {
        x = self.pos.x - self.vel.x * back + (math.random() - 0.5) * spread,
        y = self.pos.y - self.vel.y * back + (math.random() - 0.5) * spread,
        vx = self.vel.x * 0.08 + (math.random() - 0.5) * 0.6,
        vy = self.vel.y * 0.08 + (math.random() - 0.5) * 0.6,
        life = maxLife,
        maxLife = maxLife,
        size = 4 + math.random() * 5,
      })
    end
  end
  for i = #self.trail, 1, -1 do
    local t = self.trail[i]
    t.x = t.x + t.vx * ts
    t.y = t.y + t.vy * ts
    t.vx = t.vx * (0.94 ^ ts)
    t.vy = t.vy * (0.94 ^ ts)
    t.life = t.life - ts
    if t.life <= 0 then
      table.remove(self.trail, i)
    end
  end

  -- Sparks, thrown off mostly backward.
  if math.random() < SPARK_SPAWN_CHANCE * ts then
    local sparkAngle = math.atan2(self.vel.y, self.vel.x) + math.pi + (math.random() - 0.5) * 1.8
    local sparkSpeed = 1.5 + math.random() * 3
    local maxLife = SPARK_LIFE_MIN + math.random() * SPARK_LIFE_RANGE
    table.insert(self.sparks, {
      x = self.pos.x,
      y = self.pos.y,
      vx = math.cos(sparkAngle) * sparkSpeed,
      vy = math.sin(sparkAngle) * sparkSpeed,
      life = maxLife,
      maxLife = maxLife,
    })
  end
  for i = #self.sparks, 1, -1 do
    local s = self.sparks[i]
    s.x = s.x + s.vx * ts
    s.y = s.y + s.vy * ts
    s.life = s.life - ts
    if s.life <= 0 then
      table.remove(self.sparks, i)
    end
  end

  -- Cull off-screen
  if self.pos.x < -OFFSCREEN_MARGIN or self.pos.x > state.sceneWidth + OFFSCREEN_MARGIN
     or self.pos.y < -OFFSCREEN_MARGIN or self.pos.y > state.sceneHeight + OFFSCREEN_MARGIN then
    self.life = 0
  end
end

function Fireball:draw()
  love.graphics.push("all")

  -- Smoke: the older puffs, grey, growing as they fade.
  for _, t in ipairs(self.trail) do
    local life = t.life / t.maxLife
    if life < PUFF_FIRE_FRACTION + 0.1 then
      local k = math.min(1, life / PUFF_FIRE_FRACTION)  -- 1 just turned to smoke .. 0 gone
      local size = t.size * (1 + PUFF_GROWTH * (1 - life))
      love.graphics.setColor(0.32, 0.3, 0.3, 0.3 * k)
      drawGlow(t.x, t.y, size * 2.6)
    end
  end

  -- Fire: the younger puffs, glowing, cooling from yellow to red.
  love.graphics.setBlendMode("add")
  for _, t in ipairs(self.trail) do
    local life = t.life / t.maxLife
    if life > PUFF_FIRE_FRACTION then
      local heat = (life - PUFF_FIRE_FRACTION) / (1 - PUFF_FIRE_FRACTION)
      local size = t.size * (1 + PUFF_GROWTH * (1 - life))
      local r, g, b = fireColor(heat)
      love.graphics.setColor(r, g, b, 0.6 * heat)
      drawGlow(t.x, t.y, size * 2.8)
    end
  end

  -- Sparks: short bright streaks along the way they're flying.
  love.graphics.setLineWidth(1.5)
  for _, s in ipairs(self.sparks) do
    local a = s.life / s.maxLife
    local r, g, b = fireColor(0.4 + 0.6 * a)
    love.graphics.setColor(r, g, b, a)
    love.graphics.line(s.x, s.y, s.x - s.vx * 2.5, s.y - s.vy * 2.5)
  end

  -- Heat glow round the head, flickering.
  local flicker = math.sin(self.flameTime * 20 + self.flickerPhase)
  love.graphics.setColor(1, 0.45, 0.1, 0.45 + 0.1 * flicker)
  drawGlow(self.pos.x, self.pos.y, FLAME_RADIUS * 6)
  love.graphics.pop()

  -- The head: a shader flame, its tail streaming back behind it.
  local dirAngle = math.atan2(self.vel.y, self.vel.x)
  Flame.draw(self.pos.x, self.pos.y, FLAME_RADIUS * (1 + flicker * 0.05), dirAngle,
    FLAME_STRETCH, self.flameTime, self.flickerPhase * 10)
end

return Fireball