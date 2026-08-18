-- lua/entities/Fireball.lua
--
-- Port of js/entities/world/Fireball.js

local state = require("lua.state")
local Vector2 = require("lua.vector2")

local FIREBALL_SPEED = 14
local FIREBALL_LIFE = 70
local TRAIL_SPAWN_CHANCE = 0.9
local TRAIL_PARTICLE_LIFE_MIN = 14
local TRAIL_PARTICLE_LIFE_RANGE = 12
local SPARK_SPAWN_CHANCE = 0.35
local SPARK_LIFE_MIN = 8
local SPARK_LIFE_RANGE = 8
local OFFSCREEN_MARGIN = 400

local Fireball = {}
Fireball.__index = Fireball

local function lerpColor(from, to, t)
  return {
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t,
    from[3] + (to[3] - from[3]) * t,
  }
end

-- Shared baked glow canvas
local fireballCanvas = nil
local function getFireballCanvas()
  if fireballCanvas then return fireballCanvas end

  local size = 14
  local core = 8
  local padding = 24
  local dim = (size + padding) * 2

  local canvas = love.graphics.newCanvas(dim, dim)
  love.graphics.push()
  love.graphics.origin()
  love.graphics.setCanvas(canvas)
  love.graphics.clear(0, 0, 0, 0)

  local cx, cy = dim / 2, dim / 2

  -- Outer glow (approximated with layered circles since LÖVE has no shadowBlur)
  for i = 6, 1, -1 do
    local t = i / 6
    local r = size * (0.6 + t * 0.9)
    local a = 0.12 * (1 - t)
    love.graphics.setColor(1.0, 0.35, 0.0, a)
    love.graphics.circle("fill", cx, cy, r)
  end

  love.graphics.setColor(1.0, 0.7, 0.1, 0.9)
  love.graphics.circle("fill", cx, cy, size)

  love.graphics.setColor(1.0, 0.95, 0.4, 1)
  love.graphics.circle("fill", cx, cy, core)

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.circle("fill", cx, cy, 3)

  love.graphics.setCanvas()
  love.graphics.pop()

  fireballCanvas = canvas
  return canvas
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
  return self
end

function Fireball:isDead()
  return self.life <= 0
end

function Fireball:update()
  local ts = state.timeScale or 1
  self.pos:add(self.vel:clone():multiply(ts))
  self.life = self.life - ts

  -- Trail
  if math.random() < TRAIL_SPAWN_CHANCE * ts then
    local spread = 10
    local maxLife = TRAIL_PARTICLE_LIFE_MIN + math.random() * TRAIL_PARTICLE_LIFE_RANGE
    table.insert(self.trail, {
      x = self.pos.x + (math.random() - 0.5) * spread,
      y = self.pos.y + (math.random() - 0.5) * spread * 0.8,
      life = maxLife,
      maxLife = maxLife,
      size = 3 + math.random() * 6,
    })
  end
  for i = #self.trail, 1, -1 do
    self.trail[i].life = self.trail[i].life - ts
    if self.trail[i].life <= 0 then
      table.remove(self.trail, i)
    end
  end

  -- Sparks
  if math.random() < SPARK_SPAWN_CHANCE * ts then
    local sparkAngle = math.random() * math.pi * 2
    local sparkSpeed = 1 + math.random() * 2.5
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
  -- Trail
  for _, t in ipairs(self.trail) do
    local a = t.life / t.maxLife
    local ts = t.size * a
    local outer = lerpColor({1.0, 0.33, 0.0}, {0.27, 0.27, 0.28}, 1 - a)
    local inner = lerpColor({1.0, 0.80, 0.27}, {0.43, 0.42, 0.44}, 1 - a)

    love.graphics.setColor(outer[1], outer[2], outer[3], a * 0.85)
    love.graphics.circle("fill", t.x, t.y, ts * 1.4)

    love.graphics.setColor(inner[1], inner[2], inner[3], a * 0.85)
    love.graphics.circle("fill", t.x, t.y, ts * 0.75)
  end

  -- Sparks
  for _, s in ipairs(self.sparks) do
    local a = s.life / s.maxLife
    love.graphics.setColor(1.0, 0.88, 0.4, a)
    love.graphics.circle("fill", s.x, s.y, 1.5 * a + 0.5)
  end

  -- Core with live flicker
  local flicker = math.sin(love.timer.getTime() * 20 + self.flickerPhase)
  local scale = 1 + flicker * 0.08
  local alpha = 1 - math.abs(flicker) * 0.1

  local sprite = getFireballCanvas()
  local sw, sh = sprite:getDimensions()

  love.graphics.setColor(1, 1, 1, alpha)
  love.graphics.draw(sprite, self.pos.x, self.pos.y, 0, scale, scale, sw / 2, sh / 2)
  love.graphics.setColor(1, 1, 1, 1)
end

return Fireball