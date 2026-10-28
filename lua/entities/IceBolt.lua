-- lua/entities/IceBolt.lua
--
-- The ice blaster's shot (see WeaponModes.lua's "ice" mode and
-- Player:shootIceBolt): a glinting shard of ice flying straight, leaving
-- a trail of frost. What it does when it hits something is main.lua's
-- and WaterSystem.lua's business (see WaterSystem.iceBoltHit): water it
-- reaches freezes into an ice block, lava it reaches turns to water (and
-- so to obsidian), an Ooomba it reaches is frozen in an ice cube, and
-- anything else it just shatters on (IceBolt.burst).
--
-- Shaped like a Fireball (pos, vel, radius, life), so the same portal
-- and collision passes work on it.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local Particle = require("lua.entities.Particle")

local IceBolt = {}
IceBolt.__index = IceBolt

local SPEED = 13
local LIFE = 60                 -- frames (60fps ticks)
local RADIUS = 7                -- what it hits with
local SHARD_LENGTH = 15         -- the drawn shard, nose to tail
local SHARD_WIDTH = 6
local FROST_PER_FRAME = 0.8     -- chance a frame of a frost mote left behind
local FROST_LIFE_MIN, FROST_LIFE_RANGE = 14, 12
local OFFSCREEN_MARGIN = 400

local COLOR_CORE = { 0.92, 0.99, 1.0 }
local COLOR_EDGE = { 0.45, 0.78, 1.0 }
local COLOR_FROST = { 0.78, 0.93, 1.0 }

function IceBolt.new(x, y, angle)
  local self = setmetatable({}, IceBolt)
  self.vel = Vector2.new(math.cos(angle), math.sin(angle)):multiply(SPEED)
  -- One step back, so the same frame's update brings it exactly to the
  -- muzzle before it's first drawn (see Fireball.new).
  local ts = state.timeScale or 1
  self.pos = Vector2.new(x - self.vel.x * ts, y - self.vel.y * ts)
  self.life = LIFE
  self.radius = RADIUS
  self.frost = {}
  self.spin = math.random() * math.pi * 2
  return self
end

function IceBolt:isDead()
  return self.life <= 0
end

function IceBolt:update()
  local ts = state.timeScale or 1
  self.pos:addScaled(self.vel, ts)
  self.life = self.life - ts
  self.spin = self.spin + 0.25 * ts

  if math.random() < FROST_PER_FRAME * ts then
    local life = FROST_LIFE_MIN + math.random() * FROST_LIFE_RANGE
    table.insert(self.frost, {
      x = self.pos.x + (math.random() - 0.5) * 6, y = self.pos.y + (math.random() - 0.5) * 6,
      vx = self.vel.x * 0.05 + (math.random() - 0.5) * 0.5, vy = self.vel.y * 0.05 + (math.random() - 0.5) * 0.5,
      life = life, maxLife = life, size = 1 + math.random() * 1.6,
    })
  end
  for i = #self.frost, 1, -1 do
    local f = self.frost[i]
    f.x, f.y = f.x + f.vx * ts, f.y + f.vy * ts
    f.life = f.life - ts
    if f.life <= 0 then table.remove(self.frost, i) end
  end

  if self.pos.x < -OFFSCREEN_MARGIN or self.pos.x > (state.sceneWidth or math.huge) + OFFSCREEN_MARGIN
     or self.pos.y < -OFFSCREEN_MARGIN or self.pos.y > (state.sceneHeight or math.huge) + OFFSCREEN_MARGIN then
    self.life = 0
  end
end

-- A puff of frost and ice chips at (x, y): where a shot shattered, or
-- something froze or thawed.
function IceBolt.burst(x, y, count)
  if not state.particles then return end
  for _ = 1, count or 12 do
    local a = math.random() * math.pi * 2
    local speed = 0.8 + math.random() * 2.6
    local p = Particle.new(Vector2.new(x, y), Vector2.new(math.cos(a) * speed, math.sin(a) * speed), 18 + math.random() * 18)
    p.color = { COLOR_FROST[1], COLOR_FROST[2], COLOR_FROST[3] }
    p.radius = 1.5 + math.random() * 2.5
    p.drag = 0.93
    table.insert(state.particles, p)
  end
end

function IceBolt:draw()
  for _, f in ipairs(self.frost) do
    local a = f.life / f.maxLife
    love.graphics.setColor(COLOR_FROST[1], COLOR_FROST[2], COLOR_FROST[3], 0.7 * a)
    love.graphics.circle("fill", f.x, f.y, f.size)
  end

  -- A soft cold glow, then the shard: a long diamond along its flight,
  -- pale at its heart, bluer at its edges, glinting as it turns.
  love.graphics.setColor(COLOR_EDGE[1], COLOR_EDGE[2], COLOR_EDGE[3], 0.25)
  love.graphics.circle("fill", self.pos.x, self.pos.y, self.radius * 2.2)
  local dir = math.atan2(self.vel.y, self.vel.x)
  local glint = 0.5 + 0.5 * math.sin(self.spin)
  love.graphics.push()
  love.graphics.translate(self.pos.x, self.pos.y)
  love.graphics.rotate(dir)
  local L, Wd = SHARD_LENGTH, SHARD_WIDTH * (0.7 + 0.3 * glint)
  love.graphics.setColor(COLOR_EDGE[1], COLOR_EDGE[2], COLOR_EDGE[3], 0.95)
  love.graphics.polygon("fill", L * 0.6, 0, 0, -Wd / 2, -L * 0.4, 0, 0, Wd / 2)
  love.graphics.setColor(COLOR_CORE[1], COLOR_CORE[2], COLOR_CORE[3], 1)
  love.graphics.polygon("fill", L * 0.5, 0, 0, -Wd / 4, -L * 0.25, 0, 0, Wd / 4)
  love.graphics.pop()
  love.graphics.setColor(1, 1, 1, 1)
end

return IceBolt
