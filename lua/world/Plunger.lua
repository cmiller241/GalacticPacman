-- lua/world/Plunger.lua
--
-- A pinball plunger on the ground, mounted against a wall: Bob runs into
-- its striker, keeps pushing to load the spring, and when he lets go of
-- the direction he was pushing, it snaps back and fires him the other way
-- — a launch boost (see Player:move's launchBoost): for a couple of
-- seconds he's driven on, much faster than he can run. Curled up as a
-- ball that carries him right through a ball tunnel (Level1's, say);
-- standing, he's fired just as hard, but a tunnel's mouth stops him (see
-- TiledTerrain.lua's headroom).
--
-- Placed in Tiled as an object of class "RightPlunger" (mounted on the
-- left of its tile, fires right) or "LeftPlunger" (the mirror image),
-- on the tile it sits in — see TiledTerrain.lua's plungerSpawns.
--
-- Drawn: a steel backplate bolted to the wall, with three charge lights;
-- a coiled spring on a rod; and a red striker with a black rubber face.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local Particle = require("lua.entities.Particle")
local CameraShake = require("lua.effects.CameraShake")

local Plunger = {}
Plunger.__index = Plunger

local T = 64                     -- a tile, in world units
local PLATE_W = 10               -- the backplate's thickness
local HEAD_W = 14                -- the striker's thickness
local REST_FACE = 60             -- the striker's face, from the wall, at rest
local MAX_COMPRESS = 32          -- how far it can be pushed back
local COMPRESS_RATE = 1.4        -- units per frame he pushes it back
local MIN_FIRE = 5               -- less than this and it just relaxes, no launch
local BOOST_MAX = 4.5            -- speed multiplier at a full charge...
local BOOST_FRAMES = 150         -- ...lasting this long (60fps frames), easing back to normal
local SNAP_FRAMES = 40           -- the striker's wobble after firing

function Plunger.new(x, y, dir)
  local self = setmetatable({}, Plunger)
  self.x, self.y = x, y        -- its tile's top-left corner
  self.dir = dir or 1          -- 1: mounted on the left, fires right
  self.compress = 0
  self.snap = 0                -- frames left of the wobble after firing
  self.snapFrom = 0
  self.wasPushing = false
  self.charge = 0              -- 0..1, for the lights
  -- Bounding center/radius, for on-screen culling like everything else.
  self.pos = Vector2.new(x + T / 2, y + T / 2)
  self.radius = T
  return self
end

-- The striker's face, as distance from the wall, right now.
function Plunger:faceOffset()
  local off = REST_FACE - self.compress
  if self.snap > 0 then
    -- A springy wobble round the rest position after firing.
    local t = 1 - self.snap / SNAP_FRAMES
    off = REST_FACE + math.sin(t * math.pi * 5) * (1 - t) * 10
  end
  return off
end

-- In world space: where the face is (an x), and which way it pushes.
function Plunger:faceX()
  local wallX = self.dir > 0 and self.x or (self.x + T)
  return wallX + self.dir * self:faceOffset()
end

local function resync(player)
  local planet = player.currentPlanet
  if player.onSurface and planet and type(planet.arcPositionForWorldPoint) == "function" then
    player.surfaceArcPos = planet:arcPositionForWorldPoint(player.pos.x, player.pos.y)
  end
end

local function puff(x, y, dir)
  if not state.particles then return end
  for _ = 1, 10 do
    local speed = 1 + math.random() * 3
    local a = (dir > 0 and 0 or math.pi) + (math.random() - 0.5) * 1.4 - 0.3
    local p = Particle.new(Vector2.new(x, y), Vector2.new(math.cos(a) * speed, math.sin(a) * speed - 0.5),
      22 + math.random() * 18)
    p.color = { 0.85, 0.82, 0.74 }
    p.radius = 3 + math.random() * 4
    p.growRate = 0.2
    p.drag = 0.92
    table.insert(state.particles, p)
  end
end

function Plunger:update(player, ts)
  ts = ts or 1
  if self.snap > 0 then self.snap = math.max(0, self.snap - ts) end
  if not player or player.isDying or player.isTeleporting then return end

  local face = self:faceX()
  local r = player.radius
  -- Is he level with it, on its pushing side, touching (or past) its face?
  local midY = self.y + T / 2
  local level = math.abs(player.pos.y - midY) < T / 2 + r * 0.4
  local side = (player.pos.x - face) * self.dir -- how far in front of the face his center is
  local touching = level and side < r + 1.5 and side > -T
  local pushKey = self.dir > 0 and "ArrowLeft" or "ArrowRight"
  local pushing = touching and player.onSurface and state.keys[pushKey] and self.snap <= 0

  if pushing then
    self.compress = math.min(MAX_COMPRESS, self.compress + COMPRESS_RATE * ts)
  elseif self.compress > 0 then
    if self.wasPushing and touching and player.onSurface and self.compress >= MIN_FIRE then
      -- Let go: fire.
      local charge = self.compress / MAX_COMPRESS
      local mult = 1 + (BOOST_MAX - 1) * charge
      local frames = 40 + BOOST_FRAMES * charge
      player.launchBoost = { dir = self.dir, mult = mult, mult0 = mult, time = frames, time0 = frames }
      player.facingDirection = self.dir
      self.snapFrom = self.compress
      self.compress = 0
      self.snap = SNAP_FRAMES
      puff(face, self.y + T - 6, self.dir)
      CameraShake.start(3 + 4 * charge, 0.15)
      if state.audioManager then state.audioManager:playJump() end
    else
      -- Backed off (or jumped away) without letting go: it just relaxes.
      self.compress = math.max(0, self.compress - 4 * ts)
    end
  end
  self.wasPushing = pushing
  self.charge = self.compress / MAX_COMPRESS

  -- The striker is solid: he can't get past its face.
  face = self:faceX()
  side = (player.pos.x - face) * self.dir
  if level and side < r and side > -T then
    player.pos.x = face + self.dir * r
    if player.vel.x * self.dir < 0 then player.vel.x = 0 end
    resync(player)
  end
end

----------------------------------------------------------------------
-- Drawing (in its own frame: x across from the wall, y down from the
-- tile's top; mirrored for a LeftPlunger)
----------------------------------------------------------------------

local function steel(k, a) love.graphics.setColor(0.62 * k, 0.66 * k, 0.72 * k, a or 1) end

function Plunger:draw()
  local floorY = T -- (the tile's bottom: the ground it stands on)
  local midY = floorY - 30
  local face = self:faceOffset()
  local headX = face - HEAD_W

  love.graphics.push("all")
  love.graphics.translate(self.dir > 0 and self.x or (self.x + T), self.y)
  love.graphics.scale(self.dir, 1)
  love.graphics.setLineJoin("bevel")
  love.graphics.setLineStyle("smooth")

  -- A rail along the ground.
  love.graphics.setColor(0.16, 0.17, 0.2, 1)
  love.graphics.rectangle("fill", 0, floorY - 5, T - 2, 5, 2, 2)
  steel(0.8)
  love.graphics.rectangle("fill", 0, floorY - 5, T - 2, 1.5)

  -- Backplate, bolted to the wall.
  love.graphics.setColor(0.13, 0.14, 0.17, 1)
  love.graphics.rectangle("fill", -1, floorY - 58, PLATE_W + 3, 56, 3, 3)
  love.graphics.setColor(0.27, 0.29, 0.34, 1)
  love.graphics.rectangle("fill", 0, floorY - 57, PLATE_W, 54, 2, 2)
  steel(1.15)
  love.graphics.rectangle("fill", 1, floorY - 56, 2, 52)
  for _, by in ipairs({ floorY - 52, floorY - 8 }) do
    love.graphics.setColor(0.1, 0.1, 0.12, 1)
    love.graphics.circle("fill", PLATE_W / 2, by, 2.6, 10)
    steel(1.3)
    love.graphics.circle("fill", PLATE_W / 2 - 0.6, by - 0.6, 1.4, 8)
  end
  -- Charge lights: yellow, orange, red, lighting up as it's pushed back.
  local lights = { { 1, 0.85, 0.2 }, { 1, 0.55, 0.12 }, { 1, 0.2, 0.12 } }
  for i, c in ipairs(lights) do
    local ly = floorY - 42 + (i - 1) * 9
    local lit = math.max(0, math.min(1, self.charge * 3 - (i - 1)))
    love.graphics.setColor(0.08, 0.08, 0.1, 1)
    love.graphics.circle("fill", PLATE_W / 2, ly, 3.2, 12)
    love.graphics.setColor(c[1] * (0.25 + 0.75 * lit), c[2] * (0.25 + 0.75 * lit), c[3] * (0.25 + 0.75 * lit), 1)
    love.graphics.circle("fill", PLATE_W / 2, ly, 2.4, 12)
    if lit > 0 then
      love.graphics.setBlendMode("add")
      love.graphics.setColor(c[1], c[2], c[3], 0.35 * lit)
      love.graphics.circle("fill", PLATE_W / 2, ly, 6, 16)
      love.graphics.setBlendMode("alpha")
    end
  end

  -- The rod, through the spring.
  love.graphics.setColor(0.12, 0.12, 0.14, 1)
  love.graphics.setLineWidth(5)
  love.graphics.line(PLATE_W, midY, headX + 2, midY)
  steel(1.1)
  love.graphics.setLineWidth(2)
  love.graphics.line(PLATE_W, midY - 1, headX + 2, midY - 1)

  -- The spring: coils squeezed between the plate and the striker.
  local x0, x1 = PLATE_W + 1, headX - 1
  local coils = 7
  local amp = 13
  local pts = {}
  local steps = coils * 8
  for i = 0, steps do
    local t = i / steps
    pts[#pts + 1] = x0 + (x1 - x0) * t
    pts[#pts + 1] = midY + math.sin(t * coils * math.pi * 2) * amp
  end
  love.graphics.setColor(0.1, 0.1, 0.12, 1)
  love.graphics.setLineWidth(5)
  love.graphics.line(pts)
  steel(1.05)
  love.graphics.setLineWidth(3)
  love.graphics.line(pts)
  -- (a glint along the coils' tops)
  love.graphics.setColor(1, 1, 1, 0.55)
  love.graphics.setLineWidth(1)
  for i = 0, coils - 1 do
    local t = (i + 0.25) / coils
    local cx = x0 + (x1 - x0) * t
    love.graphics.line(cx - 1, midY - amp + 1, cx + 1, midY - amp + 2)
  end

  -- The striker: a red block with a black rubber face.
  local top, h = floorY - 52, 44
  if self.charge > 0 then
    love.graphics.setBlendMode("add")
    love.graphics.setColor(1, 0.4 + 0.3 * (1 - self.charge), 0.15, 0.25 * self.charge)
    love.graphics.circle("fill", face, midY, 26 + 6 * self.charge, 24)
    love.graphics.setBlendMode("alpha")
  end
  love.graphics.setColor(0.25, 0.04, 0.04, 1)
  love.graphics.rectangle("fill", headX - 1, top - 1, HEAD_W + 2, h + 2, 4, 4)
  love.graphics.setColor(0.82, 0.16, 0.13, 1)
  love.graphics.rectangle("fill", headX, top, HEAD_W - 4, h, 3, 3)
  love.graphics.setColor(1, 0.5, 0.42, 1)
  love.graphics.rectangle("fill", headX + 2, top + 3, 3, h - 6, 1.5, 1.5)
  love.graphics.setColor(0.55, 0.08, 0.07, 1)
  love.graphics.rectangle("fill", headX + HEAD_W - 8, top + 2, 2, h - 4)
  -- rubber face
  love.graphics.setColor(0.07, 0.07, 0.08, 1)
  love.graphics.rectangle("fill", face - 4, top + 1, 4, h - 2, 2, 2)
  love.graphics.setColor(0.3, 0.3, 0.33, 1)
  love.graphics.rectangle("fill", face - 3, top + 4, 1, h - 8)

  love.graphics.pop()
end

return Plunger
