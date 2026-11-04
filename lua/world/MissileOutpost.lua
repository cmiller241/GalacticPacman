-- lua/world/MissileOutpost.lua
--
-- Missile outposts: small planets just past the asteroid belt's outer edge,
-- each with a
-- missile cannon on it and an Ooomba to fire it.
--
-- The Ooomba (an ordinary one — lethal to touch, can be stomped or
-- shot, see Ooomba.lua — given a "brain" here that steers it instead of
-- its usual patrol) just stands about at its post, round from the
-- cannon. Once the player comes near (TRIGGER_RANGE of the planet), it
-- walks briskly over to the cannon and mans it: the barrel swings round
-- to follow him, and every FIRE_SECONDS it fires a homing missile at
-- him. If he gets well away (LOSE_RANGE) and stays away a while, it
-- wanders back to its post. Kill the Ooomba and its cannon falls silent.
--
-- The missiles: blinking red, trailing smoke, turning (at most
-- MISSILE_TURN a frame) to keep chasing him — fast, but not so nimble
-- he can't dodge one. They blow up on him (killing him), on any
-- planetoid or asteroid they run into, on a fireball (he can shoot them
-- down), or after MISSILE_SECONDS on their own.
--
-- Made by MissileOutpost.createAll (main.lua), updated and drawn by
-- MissileOutpost.updateAll / drawCannons / drawMissiles.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local Planetoid = require("lua.world.Planetoid")
local Ooomba = require("lua.entities.Ooomba")
local Explosion = require("lua.entities.Explosion")
local utils = require("lua.utils")
local CameraShake = require("lua.effects.CameraShake")

local MissileOutpost = {}
MissileOutpost.__index = MissileOutpost

----------------------------------------------------------------------
-- Tunables
----------------------------------------------------------------------

-- Where they are: just past the belt's outer edge (OUTPOST_GAP beyond it,
-- from the edge to the planet's surface), at these angles round the sun
-- (degrees; 0 = straight right, increasing clockwise) — kept clear of the
-- tall pinball planet, which stands just past the belt straight left of it.
local OUTPOST_ANGLES = { 70, 140, 285 }
local OUTPOST_GAP = 500
local PLANET_RADIUS = 230
local PLANET_COLOR = { 0.62, 0.42, 0.4, 1 } -- a rusty, unfriendly red-grey
-- How far round the planet the Ooomba's post is from the cannon (radians).
local POST_OFFSET = 1.7
-- Where it stands to man the cannon: just behind it (radians round).
local MANNING_OFFSET = 0.3

local TRIGGER_RANGE = 1800  -- he's this near the planet's middle: the Ooomba heads for the cannon
local LOSE_RANGE = 2700     -- he's this far: it gives up after LOSE_SECONDS...
local LOSE_SECONDS = 4      -- ...and wanders back to its post
local BRISK_SPEED = 3.4     -- the Ooomba's walk to the cannon (an ordinary one patrols at 1.4)
local STROLL_SPEED = 1.2    -- its walk back to its post
local FIRE_SECONDS = 3.2    -- between missiles, while it's manning the cannon
local FIRST_SHOT_SECONDS = 0.8 -- from reaching the cannon to its first shot
local MAX_MISSILES = 2      -- in the air at once, per cannon

local MISSILE_SPEED = 7.5   -- world units per (60fps) frame
local MISSILE_LAUNCH_SPEED = 4 -- leaving the barrel, before it gets going
local MISSILE_ACCEL = 0.25  -- per frame, up to MISSILE_SPEED
local MISSILE_TURN = 0.045  -- radians per frame it can turn toward him
local MISSILE_SECONDS = 7   -- how long one lasts before it blows up anyway
local MISSILE_SCALE = 3.6   -- how big they're drawn (1: the original small ones)
local MISSILE_RADIUS = 34   -- what counts as it touching something
local MISSILE_ARMING_SECONDS = 0.35 -- it can't hit its own planet this soon after launch
local MISSILE_RECALL_AIM_RADIUS = 46 -- how near the cursor has to be to aim Recall at one (a little bigger than the missile, it's moving)
local RECALL_TURN_RATE = 0.25 -- while recalled: how fast it turns to face the way it's being taken (fraction per frame)

-- A recalled missile reaching the cannon that fired it (see updateMissile):
-- how near counts, the cannon's blast, and the Ooomba caught in it if it's
-- within GUNNER_BLAST_REACH of the cannon.
local CANNON_HIT_REACH = 90
local CANNON_BLAST_SHAKE = 26
local GUNNER_BLAST_REACH = 170

local BARREL_LENGTH = 54
local BARREL_WIDTH = 16
local BASE_RADIUS = 30
local AIM_RATE = 0.08 -- how fast the barrel swings round to follow him (fraction per frame)

----------------------------------------------------------------------
-- Making them
----------------------------------------------------------------------

-- Every outpost, just outside the belt. Each one's planet goes into
-- state.planetoids and its Ooomba into state.ooombas (so it's landed
-- on, drawn and fought exactly like any other). Any that would sit too
-- near a landmark (any permanent planetoid) is skipped, with a warning.
function MissileOutpost.createAll(sunX, sunY, beltInner, beltOuter)
  local outposts = {}
  state.ooombas = state.ooombas or {}
  state.missiles = {}
  local orbit = beltOuter + OUTPOST_GAP + PLANET_RADIUS
  for _, deg in ipairs(OUTPOST_ANGLES) do
    local a = math.rad(deg)
    local x, y = sunX + math.cos(a) * orbit, sunY + math.sin(a) * orbit
    local clear = true
    for _, p in ipairs(state.planetoids or {}) do
      if p.isPermanent and p.pos then
        -- (How far from its outline: its circle, or — for anything
        -- flat, like the tall pinball planet — its box.)
        local gap
        if p.halfWidth then
          local ox = math.max(0, math.abs(x - p.pos.x) - p.halfWidth)
          local oy = math.max(0, math.abs(y - p.pos.y) - (p.halfHeight or p.halfWidth))
          gap = math.sqrt(ox * ox + oy * oy)
        else
          gap = math.sqrt((p.pos.x - x) ^ 2 + (p.pos.y - y) ^ 2) - (p.radius or 0)
        end
        if gap < PLANET_RADIUS + 600 then clear = false end
      end
    end
    if clear then
      outposts[#outposts + 1] = MissileOutpost.new(x, y, sunX, sunY)
    else
      print(string.format("MissileOutpost.lua: no room for the outpost at %d degrees round the belt — skipped.", deg))
    end
  end
  return outposts
end

function MissileOutpost.new(x, y, sunX, sunY)
  local self = setmetatable({}, MissileOutpost)
  local planet = Planetoid.new(x, y, PLANET_RADIUS, PLANET_COLOR)
  planet.isImmovable = true
  planet.isPermanent = true
  planet.vel = Vector2.new(0, 0)
  table.insert(state.planetoids, planet)
  self.planet = planet

  -- The cannon sits on the side facing out of the belt, away from the
  -- sun (so it isn't hidden in the thick of it); the Ooomba's post is a
  -- good way round from there.
  self.cannonAngle = math.atan2(y - sunY, x - sunX)
  self.postAngle = self.cannonAngle + POST_OFFSET
  self.manningAngle = self.cannonAngle + MANNING_OFFSET
  self.aim = self.cannonAngle -- where the barrel's pointing right now
  self.flash = 0              -- the muzzle flash, fading

  local gunner = Ooomba.newOnPlanet(planet, self.postAngle, { direction = -1 })
  gunner.speed = 0
  gunner.brain = function(o) self:think(o) end
  table.insert(state.ooombas, gunner)
  self.gunner = gunner

  self.mode = "idle"       -- idle (at its post), toCannon, manning, returning
  self.fireTimer = 0
  self.awayTimer = 0
  return self
end

----------------------------------------------------------------------
-- The Ooomba's brain
----------------------------------------------------------------------

local function angleDiff(a, b)
  return (b - a + math.pi) % (2 * math.pi) - math.pi
end

-- Where the Ooomba is round its planet (radians).
local function gunnerAngle(self, o)
  return o.surfaceArcPos / self.planet.radius
end

-- Walks it toward `targetAngle` at `speed`; returns true once it's there.
local function walkTo(self, o, targetAngle, speed)
  local d = angleDiff(gunnerAngle(self, o), targetAngle)
  local step = speed * (state.timeScale or 1) / self.planet.radius
  if math.abs(d) <= step then
    o.surfaceArcPos = (targetAngle % (2 * math.pi)) * self.planet.radius
    o.speed = 0
    return true
  end
  o.direction = d > 0 and 1 or -1
  o.speed = speed
  o.walkCycleSpeed = 0.12 * speed / 1.4
  return false
end

-- Called by the Ooomba itself each frame (see Ooomba:update's brain):
-- sets where it's walking and how fast.
function MissileOutpost:think(o)
  if self.mode == "idle" or self.mode == "manning" then
    o.speed = 0
    o.walkCycleSpeed = 0
    o.walkCyclePhase = 0
    -- (Facing him, standing there.)
    local player = state.player
    if player then
      local px, py = player.pos.x - o.pos.x, player.pos.y - o.pos.y
      local side = px * -o.up.y + py * o.up.x
      o.direction = side > 0 and 1 or -1
    end
  elseif self.mode == "toCannon" then
    if walkTo(self, o, self.manningAngle, BRISK_SPEED) then
      self.mode = "manning"
      self.fireTimer = FIRST_SHOT_SECONDS
    end
  elseif self.mode == "returning" then
    if walkTo(self, o, self.postAngle, STROLL_SPEED) then self.mode = "idle" end
  end
end

----------------------------------------------------------------------
-- Updating
----------------------------------------------------------------------

local function explode(m)
  m.dead = true
  state.explosions = state.explosions or {}
  table.insert(state.explosions, Explosion.new(m.pos.x, m.pos.y))
  if state.audioManager then state.audioManager:playBang("medium", Vector2.new(m.pos.x, m.pos.y)) end
end

-- The barrel's tip, where missiles leave from.
function MissileOutpost:muzzle()
  local p = self.planet
  local bx = p.pos.x + math.cos(self.cannonAngle) * (p.radius + BASE_RADIUS * 0.6)
  local by = p.pos.y + math.sin(self.cannonAngle) * (p.radius + BASE_RADIUS * 0.6)
  return bx + math.cos(self.aim) * BARREL_LENGTH, by + math.sin(self.aim) * BARREL_LENGTH, bx, by
end

function MissileOutpost:fire()
  local mx, my = self:muzzle()
  table.insert(state.missiles, {
    owner = self,
    pos = Vector2.new(mx, my),
    heading = self.aim,
    speed = MISSILE_LAUNCH_SPEED,
    age = 0,
    trail = {},
    -- (For Recall, which records and rewinds anything with a position,
    -- velocity and radius — see lua/systems/Recall.lua. The radius is
    -- also how near the cursor has to be to aim Recall at it.)
    vel = Vector2.new(math.cos(self.aim) * MISSILE_LAUNCH_SPEED, math.sin(self.aim) * MISSILE_LAUNCH_SPEED),
    radius = MISSILE_RECALL_AIM_RADIUS,
  })
  self.flash = 1
  if state.audioManager then state.audioManager:playBang("small", Vector2.new(mx, my)) end
end

-- Its own missile, recalled back into it (see updateMissile): the cannon
-- goes up in a big blast — several explosions round it, the screen
-- shaking — and is a wreck from then on, firing no more. Its Ooomba goes
-- with it, if it's within GUNNER_BLAST_REACH (manning it, or walking up).
function MissileOutpost:destroyCannon()
  if self.destroyed then return end
  self.destroyed = true
  self.flash = 0
  self.smokeTimer = 0
  local _, _, bx, by = self:muzzle()
  state.explosions = state.explosions or {}
  table.insert(state.explosions, Explosion.new(bx, by))
  for k = 1, 4 do
    local a = math.random() * math.pi * 2
    local r = 25 + math.random() * 45
    table.insert(state.explosions, Explosion.new(bx + math.cos(a) * r, by + math.sin(a) * r))
  end
  CameraShake.start(CANNON_BLAST_SHAKE, 0.45)
  if state.audioManager then state.audioManager:playBang("large", Vector2.new(bx, by)) end

  local g = self.gunner
  if g and (g.pos.x - bx) ^ 2 + (g.pos.y - by) ^ 2 < GUNNER_BLAST_REACH * GUNNER_BLAST_REACH then
    for i = #(state.ooombas or {}), 1, -1 do
      if state.ooombas[i] == g then table.remove(state.ooombas, i) end
    end
    table.insert(state.explosions, Explosion.new(g.pos.x, g.pos.y))
    self.gunner = nil
  end
end

function MissileOutpost:update(player, dt)
  -- Its Ooomba's gone (stomped or shot): the cannon's silent.
  if self.gunner then
    local alive = false
    for _, o in ipairs(state.ooombas or {}) do if o == self.gunner then alive = true break end end
    if not alive then self.gunner = nil end
  end
  self.flash = math.max(0, self.flash - dt * 5)

  -- Blown up (see :destroyCannon): nothing more to do but smoke — and
  -- its Ooomba, if it lived, just stands there.
  if self.destroyed then
    self.smokeTimer = (self.smokeTimer or 0) + dt
    self.mode = "idle"
    return
  end

  local dist = math.huge
  if player and not player.isDying then
    dist = math.sqrt((player.pos.x - self.planet.pos.x) ^ 2 + (player.pos.y - self.planet.pos.y) ^ 2)
  end

  -- The barrel follows him while it's manned; otherwise eases back to
  -- pointing straight out.
  local wantAim = self.cannonAngle
  if self.gunner and self.mode == "manning" and dist < LOSE_RANGE then
    local bx, by = select(3, self:muzzle())
    wantAim = math.atan2(player.pos.y - by, player.pos.x - bx)
    -- (Never down into its own planet.)
    local off = angleDiff(self.cannonAngle, wantAim)
    wantAim = self.cannonAngle + math.max(-1.35, math.min(1.35, off))
  end
  self.aim = self.aim + angleDiff(self.aim, wantAim) * math.min(1, AIM_RATE * (state.timeScale or 1))

  if not self.gunner then return end

  if self.mode == "idle" or self.mode == "returning" then
    if dist < TRIGGER_RANGE then self.mode = "toCannon" end
  elseif self.mode == "manning" or self.mode == "toCannon" then
    if dist > LOSE_RANGE then
      self.awayTimer = self.awayTimer + dt
      if self.awayTimer > LOSE_SECONDS then
        self.mode, self.awayTimer = "returning", 0
      end
    else
      self.awayTimer = 0
    end
  end

  if self.mode == "manning" and dist < LOSE_RANGE then
    self.fireTimer = self.fireTimer - dt
    local live = 0
    for _, m in ipairs(state.missiles) do if m.owner == self and not m.dead then live = live + 1 end end
    if self.fireTimer <= 0 and live < MAX_MISSILES then
      self:fire()
      self.fireTimer = FIRE_SECONDS
    end
  end
end

local function updateMissile(m, player, ts, dt)
  -- Recalled (see lua/systems/Recall.lua): Recall's moving it back along
  -- the way it came (nose first) — nothing of its own (no homing,
  -- no running out, no hurting him) until that's over. Reaching the
  -- cannon that fired it, it blows the cannon up (see :destroyCannon).
  local owner = m.owner
  local function atItsCannon()
    if owner.destroyed then return false end
    local _, _, bx, by = owner:muzzle()
    return (m.pos.x - bx) ^ 2 + (m.pos.y - by) ^ 2 < CANNON_HIT_REACH * CANNON_HIT_REACH
  end
  if m.recalling then
    m.wasRecalled = true
    -- (Nose first the way it's being taken — back toward the cannon —
    -- turning smoothly round to face wherever Recall's moving it.)
    if m.recallLastX then
      local dx, dy = m.pos.x - m.recallLastX, m.pos.y - m.recallLastY
      if dx * dx + dy * dy > 0.01 then
        local want = math.atan2(dy, dx)
        m.heading = m.heading + angleDiff(m.heading, want) * math.min(1, RECALL_TURN_RATE * ts)
      end
    end
    m.recallLastX, m.recallLastY = m.pos.x, m.pos.y
    -- (Its old smoke still fades away.)
    for i = #m.trail, 1, -1 do
      m.trail[i].age = m.trail[i].age + dt
      if m.trail[i].age > 0.6 then table.remove(m.trail, i) end
    end
    if atItsCannon() then
      owner:destroyCannon()
      explode(m)
    end
    return
  end
  if m.wasRecalled then
    -- The rewind's over: all the way back (at the cannon), or stopped
    -- partway (recalled again) — then it just carries on after him.
    m.wasRecalled = nil
    m.recallLastX, m.recallLastY = nil, nil
    if atItsCannon() then
      owner:destroyCannon()
      explode(m)
      return
    end
  end

  m.age = m.age + dt
  if m.age > MISSILE_SECONDS then explode(m) return end

  -- Turning toward him (at most MISSILE_TURN), and speeding up.
  if player and not player.isDying then
    local want = math.atan2(player.pos.y - m.pos.y, player.pos.x - m.pos.x)
    local d = angleDiff(m.heading, want)
    local turn = MISSILE_TURN * ts
    m.heading = m.heading + math.max(-turn, math.min(turn, d))
  end
  m.speed = math.min(MISSILE_SPEED, m.speed + MISSILE_ACCEL * ts)
  m.pos.x = m.pos.x + math.cos(m.heading) * m.speed * ts
  m.pos.y = m.pos.y + math.sin(m.heading) * m.speed * ts
  m.vel.x, m.vel.y = math.cos(m.heading) * m.speed, math.sin(m.heading) * m.speed

  -- Smoke behind it.
  local back = 14 * MISSILE_SCALE
  table.insert(m.trail, 1, { x = m.pos.x - math.cos(m.heading) * back, y = m.pos.y - math.sin(m.heading) * back, age = 0 })
  for i = #m.trail, 1, -1 do
    m.trail[i].age = m.trail[i].age + dt
    if m.trail[i].age > 0.6 then table.remove(m.trail, i) end
  end

  -- Him.
  if player and not player.isDying then
    local r = MISSILE_RADIUS + player.radius
    if (player.pos.x - m.pos.x) ^ 2 + (player.pos.y - m.pos.y) ^ 2 < r * r then
      player:startDeath()
      explode(m)
      return
    end
  end
  -- A fireball (shot down).
  for i = #(state.fireballs or {}), 1, -1 do
    local f = state.fireballs[i]
    local r = MISSILE_RADIUS + (f.radius or 8) + 4
    if (f.pos.x - m.pos.x) ^ 2 + (f.pos.y - m.pos.y) ^ 2 < r * r then
      table.remove(state.fireballs, i)
      explode(m)
      return
    end
  end
  -- Anything solid it runs into.
  for _, p in ipairs(state.planetoids or {}) do
    if p.pos and not p.isWaterPlanet and not (p == m.owner.planet and m.age < MISSILE_ARMING_SECONDS) then
      local hit
      if p.isRoundedRect and p.containsPoint then
        hit = p:containsPoint(m.pos.x, m.pos.y)
      elseif p.radius then
        local r = p.radius + MISSILE_RADIUS
        local dx, dy = p.pos.x - m.pos.x, p.pos.y - m.pos.y
        hit = dx * dx + dy * dy < r * r
      end
      if hit then explode(m) return end
    end
  end
  for _, a in ipairs(state.asteroids or {}) do
    local r = (a.radius or 0) + MISSILE_RADIUS
    if (a.pos.x - m.pos.x) ^ 2 + (a.pos.y - m.pos.y) ^ 2 < r * r then explode(m) return end
  end
end

-- While the title screen's playing (its own autopilot roams the belt
-- and might stomp or shoot one): any outpost that's lost its Ooomba
-- gets a fresh one back at its post, so they're all manned when the game
-- starts. (No missiles meanwhile — see main.lua.)
function MissileOutpost.restock(outposts)
  for _, self in ipairs(outposts or {}) do
    local alive = false
    for _, o in ipairs(state.ooombas or {}) do if o == self.gunner then alive = true break end end
    if not alive then
      local gunner = Ooomba.newOnPlanet(self.planet, self.postAngle, { direction = -1 })
      gunner.speed = 0
      gunner.brain = function(o) self:think(o) end
      state.ooombas = state.ooombas or {}
      table.insert(state.ooombas, gunner)
      self.gunner = gunner
      self.mode = "idle"
    end
  end
end

-- Every outpost and missile, once a frame.
function MissileOutpost.updateAll(outposts, player)
  local ts = state.timeScale or 1
  local dt = ts / 60
  for _, o in ipairs(outposts or {}) do o:update(player, dt) end
  local missiles = state.missiles or {}
  for i = #missiles, 1, -1 do
    local m = missiles[i]
    if not m.dead then updateMissile(m, player, ts, dt) end
    if m.dead then table.remove(missiles, i) end
  end
end

----------------------------------------------------------------------
-- Drawing
----------------------------------------------------------------------

-- The cannons: a squat dark turret on the surface, a red band round it,
-- and its barrel — turning to follow him while it's manned.
function MissileOutpost.drawCannons(outposts)
  for _, self in ipairs(outposts or {}) do
    local p = self.planet
    if self.destroyed and utils.isOnScreen(p.pos.x, p.pos.y, p.radius + 300, 50) then
      MissileOutpost.drawWreck(self)
    elseif utils.isOnScreen(p.pos.x, p.pos.y, p.radius + 120, 50) then
      local mx, my, bx, by = self:muzzle()
      local ca, sa = math.cos(self.cannonAngle), math.sin(self.cannonAngle)
      local sx, sy = p.pos.x + ca * p.radius, p.pos.y + sa * p.radius
      love.graphics.push("all")
      -- The barrel.
      love.graphics.setColor(0.08, 0.08, 0.1, 1)
      love.graphics.setLineWidth(BARREL_WIDTH + 5)
      love.graphics.line(bx, by, mx, my)
      love.graphics.setColor(0.42, 0.44, 0.5, 1)
      love.graphics.setLineWidth(BARREL_WIDTH)
      love.graphics.line(bx, by, mx, my)
      love.graphics.setColor(0.62, 0.64, 0.7, 1)
      love.graphics.setLineWidth(4)
      local nx, ny = -math.sin(self.aim) * 3, math.cos(self.aim) * 3
      love.graphics.line(bx - nx, by - ny, mx - nx, my - ny)
      -- (Its mouth, and the flash when it fires.)
      love.graphics.setColor(0.05, 0.05, 0.06, 1)
      love.graphics.circle("fill", mx, my, BARREL_WIDTH * 0.45)
      if self.flash > 0 then
        love.graphics.setBlendMode("add")
        love.graphics.setColor(1, 0.6, 0.25, self.flash)
        love.graphics.circle("fill", mx, my, 18 + 22 * self.flash)
        love.graphics.setBlendMode("alpha")
      end
      -- The turret: a dome on the surface, with a red band.
      local rot = self.cannonAngle + math.pi / 2
      love.graphics.translate(sx, sy)
      love.graphics.rotate(rot)
      love.graphics.setColor(0.08, 0.08, 0.1, 1)
      love.graphics.arc("fill", 0, 4, BASE_RADIUS + 3, math.pi, 2 * math.pi, 24)
      love.graphics.setColor(0.36, 0.37, 0.42, 1)
      love.graphics.arc("fill", 0, 4, BASE_RADIUS, math.pi, 2 * math.pi, 24)
      love.graphics.setColor(0.75, 0.16, 0.14, 1)
      love.graphics.rectangle("fill", -BASE_RADIUS * 0.95, -8, BASE_RADIUS * 1.9, 6)
      love.graphics.setColor(0.6, 0.62, 0.68, 1)
      love.graphics.arc("fill", -6, -6, BASE_RADIUS * 0.45, math.pi * 1.1, math.pi * 1.6, 12)
      love.graphics.pop()
    end
  end
end

-- A blown-up cannon (see :destroyCannon): its turret charred black and
-- split, a short twisted stub of barrel left, an ember glowing in the
-- wreck, and smoke curling up off it for good.
function MissileOutpost.drawWreck(self)
  local p = self.planet
  local ca, sa = math.cos(self.cannonAngle), math.sin(self.cannonAngle)
  local sx, sy = p.pos.x + ca * p.radius, p.pos.y + sa * p.radius
  local t = self.smokeTimer or 0
  love.graphics.push("all")
  -- Smoke, rising straight out from the surface and spreading as it goes.
  for k = 0, 9 do
    local life = ((t * 0.35 + k / 10) % 1)
    local rise = 20 + life * 220
    local drift = math.sin(k * 2.3 + t * 0.8) * 30 * life
    local x = sx + ca * rise - sa * drift
    local y = sy + sa * rise + ca * drift
    love.graphics.setColor(0.22, 0.21, 0.22, 0.45 * (1 - life))
    love.graphics.circle("fill", x, y, 12 + 30 * life)
  end
  love.graphics.translate(sx, sy)
  love.graphics.rotate(self.cannonAngle + math.pi / 2)
  -- The charred, split turret.
  love.graphics.setColor(0.06, 0.06, 0.07, 1)
  love.graphics.arc("fill", 0, 4, BASE_RADIUS + 3, math.pi, 2 * math.pi, 24)
  love.graphics.setColor(0.17, 0.16, 0.16, 1)
  love.graphics.arc("fill", 0, 4, BASE_RADIUS, math.pi, 2 * math.pi, 24)
  love.graphics.setColor(0.06, 0.06, 0.07, 1)
  love.graphics.polygon("fill", -4, 4, 6, -BASE_RADIUS + 4, 10, -BASE_RADIUS + 2, 2, 4)
  -- What's left of the barrel: a short stub, bent off to one side.
  love.graphics.setLineWidth(BARREL_WIDTH * 0.8)
  love.graphics.setColor(0.12, 0.12, 0.13, 1)
  love.graphics.line(-6, -BASE_RADIUS * 0.5, -16, -BASE_RADIUS - 14, -30, -BASE_RADIUS - 20)
  -- An ember still glowing in it.
  local glow = 0.55 + 0.45 * math.sin(t * 7) * math.sin(t * 2.3)
  love.graphics.setBlendMode("add")
  love.graphics.setColor(1, 0.4, 0.1, 0.35 * glow)
  love.graphics.circle("fill", 4, -8, 16)
  love.graphics.setColor(1, 0.65, 0.2, 0.8 * glow)
  love.graphics.circle("fill", 4, -8, 4)
  love.graphics.pop()
end

-- The missiles: a smoke trail, a dark body with fins, and a red light
-- on its nose blinking — faster the longer it's been flying, and faster
-- still once it's close to him.
function MissileOutpost.drawMissiles()
  local player = state.player
  for _, m in ipairs(state.missiles or {}) do
    if utils.isOnScreen(m.pos.x, m.pos.y, 200, 50) then
      love.graphics.push("all")
      -- Smoke.
      for i = #m.trail, 1, -1 do
        local t = m.trail[i]
        local k = t.age / 0.6
        love.graphics.setColor(0.7, 0.7, 0.72, 0.35 * (1 - k))
        love.graphics.circle("fill", t.x, t.y, (4 + 10 * k) * MISSILE_SCALE)
      end
      -- Its exhaust flame.
      love.graphics.translate(m.pos.x, m.pos.y)
      love.graphics.rotate(m.heading)
      love.graphics.scale(MISSILE_SCALE)
      love.graphics.setBlendMode("add")
      -- (No flame while it's being recalled — it's not flying itself.)
      local flick = m.recalling and 0 or (0.8 + 0.4 * math.random())
      love.graphics.setColor(1, 0.55, 0.15, 0.85)
      love.graphics.polygon("fill", -14, -5, -14, 5, -14 - 16 * flick, 0)
      love.graphics.setColor(1, 0.9, 0.5, 0.9)
      love.graphics.polygon("fill", -14, -2.5, -14, 2.5, -14 - 8 * flick, 0)
      love.graphics.setBlendMode("alpha")
      -- Its body and fins.
      love.graphics.setColor(0.08, 0.08, 0.1, 1)
      love.graphics.polygon("fill", -16, -10, -8, -6, -8, 6, -16, 10)
      love.graphics.rectangle("fill", -15, -6.5, 26, 13, 5, 5)
      love.graphics.setColor(0.55, 0.57, 0.62, 1)
      love.graphics.rectangle("fill", -13, -4.5, 22, 9, 4, 4)
      love.graphics.setColor(0.75, 0.16, 0.14, 1)
      love.graphics.rectangle("fill", -6, -4.5, 4, 9)
      love.graphics.setColor(0.75, 0.77, 0.82, 1)
      love.graphics.rectangle("fill", -12, -3.5, 18, 2.5, 1, 1)
      -- The blinking light.
      local rate = 3 + 6 * (m.age / MISSILE_SECONDS)
      if player then
        local d = math.sqrt((player.pos.x - m.pos.x) ^ 2 + (player.pos.y - m.pos.y) ^ 2)
        if d < 500 then rate = rate + 8 * (1 - d / 500) end
      end
      m.blinkPhase = (m.blinkPhase or 0) + rate * (love.timer.getDelta())
      local on = (m.blinkPhase % 1) < 0.5
      if on then
        love.graphics.setBlendMode("add")
        love.graphics.setColor(1, 0.15, 0.1, 0.35)
        love.graphics.circle("fill", 11, 0, 16)
        love.graphics.setColor(1, 0.2, 0.15, 0.6)
        love.graphics.circle("fill", 11, 0, 8)
        love.graphics.setBlendMode("alpha")
        love.graphics.setColor(1, 0.55, 0.5, 1)
      else
        love.graphics.setColor(0.35, 0.05, 0.05, 1)
      end
      love.graphics.circle("fill", 11, 0, 4)
      love.graphics.pop()
    end
  end
end

return MissileOutpost
