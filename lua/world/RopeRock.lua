-- lua/world/RopeRock.lua
--
-- A rock slab hanging from a rope — placed in Tiled as two rectangle
-- objects (see TiledTerrain's ropeSpawns/rockSpawns, paired up in main.lua):
--   Rope  hangs from the top of its rectangle; custom property:
--           holds  (object, or its id) the Rock it holds — required
--   Rock  hangs where it's placed; custom property:
--           solid  (bool) true (the default): solid like a wall tile, and
--                  Bob can stand on top; false: just scenery
--
-- The rock is solid on every side like a wall tile (it's in the level's
-- walls — so fireballs go off against it, Ooombas turn at it, portals
-- stick to it), with a walkable top (a moving surface — see
-- TiledTerrain.newMovingSurface) for Bob to stand on if he can get up
-- there.
--
-- Hanging, it's still — until Bob jumps into it or shoots it: then it
-- rocks back and forth on the rope, away from the hit, the swing slowly
-- dying away. (It stays level as it swings, like a hanging platform —
-- only the rope tilts — so it stays a solid block he can stand on and
-- ride.)
--
-- Shoot the rope itself and it burns where it's hit, briefly, then it's
-- gone — and the rock drops, falling with the dome's gravity until it
-- lands on a ledge, a wall, another rock, or the dome's floor. Bob can
-- Recall it (see lua/systems/Recall.lua — it's one of state.recallables):
-- it rewinds back the way it moved, and carries on from there after.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local TiledTerrain = require("lua.world.TiledTerrain")

local RopeRock = {}
RopeRock.__index = RopeRock

----------------------------------------------------------------------
-- Tunables
----------------------------------------------------------------------

local ROPE_WIDTH = 4
local ROPE_HIT_REACH = 10         -- world units from the rope a fireball's middle can pass and still set it alight
local BURN_TICKS = 60             -- how long the rope burns where it was hit before it's gone (60fps ticks)
local SWING_GRAVITY = 0.4         -- world units/tick^2 — what sets how fast it rocks
local SWING_DAMPING = 0.985       -- per tick: how much of its swing it keeps (lower dies away sooner)
local BUMP_SPEED = 0.025          -- radians/tick of swing Bob jumping into it gives it
local SHOT_SPEED = 0.022          -- ...and a fireball hitting it
local MAX_SWING_DEGREES = 70      -- never swings further than this either side
local FALL_GRAVITY = 0.6          -- world units/tick^2 (unless the dome has its own gravityStrength)
local MAX_FALL_SPEED = 22         -- world units/tick
local COLOR_ROPE = { 0.55, 0.40, 0.22 }
local COLOR_ROPE_DARK = { 0.30, 0.20, 0.10 }
local COLOR_ROPE_CHAR = { 0.12, 0.08, 0.06 } -- round where it's burning
local COLOR_FLAME = { 1.00, 0.55, 0.15 }
local COLOR_FLAME_CORE = { 1.00, 0.90, 0.45 }
local COLOR_ROCK = { 0.46, 0.44, 0.43 }
local COLOR_ROCK_TOP = { 0.62, 0.60, 0.58 }  -- its lit top edge
local COLOR_ROCK_EDGE = { 0.20, 0.19, 0.19 }
local COLOR_ROCK_SPOT = { 0.38, 0.36, 0.35 }
local ROCK_CORNER = 8

----------------------------------------------------------------------

-- rope, rock: their spawns (world space — see TiledTerrain). level: the
-- Tiled level it's in (its walls and shapes — what it's solid among and
-- lands on). dome: whose gravity it falls with and floor it lands on, and
-- jump strength its top shares, like the level's own ledges.
function RopeRock.new(rope, rock, level, dome)
  local self = setmetatable({}, RopeRock)
  self.level = level
  self.dome = dome
  self.gravity = (dome and dome.gravityStrength) or FALL_GRAVITY
  self.top = { x = rope.x + rope.width / 2, y = rope.y }   -- where the rope hangs from
  self.ropeLength = math.max(1, rope.height)
  self.angle, self.angVel = 0, 0                            -- the rope's swing (+ = out to the right)

  -- The rock — pos/vel/halfWidth/halfHeight/radius like a wall tile
  -- (it IS one of the level's walls, and Recall moves it by pos/vel).
  self.halfWidth, self.halfHeight = rock.width / 2, rock.height / 2
  self.pos = Vector2.new(rock.x + self.halfWidth, rock.y + self.halfHeight)
  self.vel = Vector2.new(0, 0)
  self.radius = math.sqrt(self.halfWidth ^ 2 + self.halfHeight ^ 2)
  -- Its middle, from the end of the rope (as placed).
  self.offX = self.pos.x - self.top.x
  self.offY = self.pos.y - (self.top.y + self.ropeLength)
  self.hanging = true
  self.solid = rock.solid

  if self.solid then
    self.wall = { pos = self.pos, halfWidth = self.halfWidth, halfHeight = self.halfHeight, radius = self.radius, isWall = true }
    table.insert(level.walls, self.wall)
    self.surface = TiledTerrain.newMovingSurface(0, 0, 1, 0)
    self.surface.jumpStrength = dome and dome.jumpStrength
    table.insert(state.planetoids, self.surface)
  end
  self:placeSurface()
  return self
end

-- For Recall (see lua/systems/Recall.lua): whether a point's on the rock.
function RopeRock:containsPoint(x, y)
  return math.abs(x - self.pos.x) <= self.halfWidth and math.abs(y - self.pos.y) <= self.halfHeight
end

function RopeRock:placeSurface()
  if not self.surface then return end
  local topY = self.pos.y - self.halfHeight
  self.surface:moveTo(self.pos.x - self.halfWidth, topY, self.pos.x + self.halfWidth, topY)
end

-- The end of the rope, at the current swing.
function RopeRock:ropeEnd()
  return self.top.x + math.sin(self.angle) * self.ropeLength, self.top.y + math.cos(self.angle) * self.ropeLength
end

----------------------------------------------------------------------
-- The rope burning
----------------------------------------------------------------------

-- Distance from (x, y) to the rope, and how far along it (0 = top, 1 = end).
function RopeRock:distanceToRope(x, y)
  local ex, ey = self:ropeEnd()
  local dx, dy = ex - self.top.x, ey - self.top.y
  local t = math.max(0, math.min(1, ((x - self.top.x) * dx + (y - self.top.y) * dy) / (dx * dx + dy * dy)))
  local px, py = self.top.x + dx * t, self.top.y + dy * t
  return math.sqrt((x - px) ^ 2 + (y - py) ^ 2), t
end

-- A fireball's path this frame, in a few steps (it's fast, the rope's thin
-- and the rock's not much thicker): calls hit(t, x, y, f) for the first
-- point along it for which `test` says yes.
local function alongFireballs(ts, test)
  for _, f in ipairs(state.fireballs or {}) do
    for k = 0, 4 do
      local x = f.pos.x + f.vel.x * ts * k / 4
      local y = f.pos.y + f.vel.y * ts * k / 4
      if test(f, x, y) then return f end
    end
  end
  return nil
end

-- Any fireball crossing the rope sets it alight there; any about to go
-- off against the hanging rock sets it rocking, its way.
function RopeRock:checkFireballs(ts)
  if not self.burn and not self.burnedAway then
    local hitT = nil
    alongFireballs(ts, function(f, x, y)
      local d, t = self:distanceToRope(x, y)
      if d <= ROPE_HIT_REACH + (f.radius or 0) then hitT = t; return true end
      return false
    end)
    if hitT then self.burn = { at = hitT, ticks = BURN_TICKS } end
  end
  if self.hanging and self.solid then
    local f = alongFireballs(ts, function(f, x, y)
      local r = f.radius or 0
      return math.abs(x - self.pos.x) <= self.halfWidth + r and math.abs(y - self.pos.y) <= self.halfHeight + r
    end)
    if f then self:push((f.vel.x >= 0 and 1 or -1) * SHOT_SPEED) end
  end
end

-- Where it's burning, as a fraction along the rope (nil if it isn't) —
-- second value always nil (see TileGlow, which lights each flame).
function RopeRock:flameFronts()
  if not self.burn then return nil end
  return self.burn.at, nil
end

function RopeRock:flamePoint(t)
  local ex, ey = self:ropeEnd()
  return self.top.x + (ex - self.top.x) * t, self.top.y + (ey - self.top.y) * t
end

function RopeRock:updateBurn(ts)
  if not self.burn then return end
  self.burn.ticks = self.burn.ticks - ts
  if self.burn.ticks <= 0 then
    -- Burned through: the rope's gone, and the rock with it.
    self.burn = nil
    self.burnedAway = true
    if self.hanging then
      self.hanging = false
      self.vel.x, self.vel.y = 0, 0
    end
  end
end

----------------------------------------------------------------------
-- Rocking
----------------------------------------------------------------------

-- A shove to its swing (radians/tick, + = to the right).
function RopeRock:push(speed)
  self.angVel = self.angVel + speed
end

-- Bob jumping into it from the side or underneath (just touching it,
-- having not been a moment ago — not standing on its top) sets it
-- rocking away from him.
function RopeRock:checkBump()
  local player = state.player
  if not (player and self.solid) then return end
  local onTop = player.onSurface and player.currentPlanet == self.surface
  local dx = player.pos.x - self.pos.x
  local nearX = math.max(0, math.abs(dx) - self.halfWidth)
  local nearY = math.max(0, math.abs(player.pos.y - self.pos.y) - self.halfHeight)
  local touching = not onTop and nearX * nearX + nearY * nearY <= (player.radius + 3) ^ 2
  if touching and not self.bobTouching then
    self:push((dx <= 0 and 1 or -1) * BUMP_SPEED)
  end
  self.bobTouching = touching
end

function RopeRock:updateSwing(ts)
  local steps = math.max(1, math.ceil(ts))
  local dt = ts / steps
  local omega2 = SWING_GRAVITY / self.ropeLength
  for _ = 1, steps do
    self.angVel = (self.angVel - omega2 * math.sin(self.angle) * dt) * SWING_DAMPING ^ dt
    self.angle = self.angle + self.angVel * dt
  end
  local limit = math.rad(MAX_SWING_DEGREES)
  if math.abs(self.angle) > limit then
    self.angle = limit * (self.angle > 0 and 1 or -1)
    self.angVel = 0
  end
  -- The rock hangs off the end of the rope, level.
  local ex, ey = self:ropeEnd()
  self.pos.x, self.pos.y = ex + self.offX, ey + self.offY
end

----------------------------------------------------------------------
-- Falling
----------------------------------------------------------------------

-- The highest thing below the rock's bottom edge that it reaches moving
-- from prevBottom down to newBottom: a ledge (any of the level's walkable
-- surfaces), the top of a wall (another rock included), or the dome's own
-- floor. Nil if nothing.
function RopeRock:floorBetween(prevBottom, newBottom)
  local best = nil
  local deck = self.dome and self.dome.trueSurfaceY and self.dome:trueSurfaceY()
  if deck and deck >= prevBottom - 0.01 and deck <= newBottom + 0.01 then best = deck end
  local xs = { self.pos.x - self.halfWidth + 4, self.pos.x, self.pos.x + self.halfWidth - 4 }
  for _, shape in ipairs(self.level.shapes or {}) do
    if shape.findLandingCrossing then
      for _, x in ipairs(xs) do
        local hit = shape:findLandingCrossing(x, prevBottom, x, newBottom + 0.01)
        if hit and hit.point.y >= prevBottom - 0.01 and hit.point.y <= newBottom + 0.01 then
          if not best or hit.point.y < best then best = hit.point.y end
        end
      end
    end
  end
  for _, w in ipairs(self.level.walls or {}) do
    if w ~= self.wall and w.isWall then
      local wTop = w.pos.y - w.halfHeight
      if math.abs(w.pos.x - self.pos.x) < w.halfWidth + self.halfWidth - 2
          and wTop >= prevBottom - 0.01 and wTop <= newBottom + 0.01 then
        if not best or wTop < best then best = wTop end
      end
    end
  end
  return best
end

function RopeRock:updateFall(ts)
  self.vel.y = math.min(MAX_FALL_SPEED, self.vel.y + self.gravity * ts)
  local prevBottom = self.pos.y + self.halfHeight
  local newBottom = prevBottom + self.vel.y * ts
  local floor = self.vel.y >= 0 and self:floorBetween(prevBottom, newBottom)
  if floor then
    newBottom = floor
    self.vel.y = 0
  end
  self.vel.x = 0
  self.pos.y = newBottom - self.halfHeight
end

----------------------------------------------------------------------

-- Call once a frame, before the player moves (so he's carried along).
function RopeRock:update(ts)
  self:checkFireballs(ts)
  self:updateBurn(ts)

  if self.recalling then
    -- Being rewound (see Recall.lua) moves it itself.
    self.wasRecalling = true
  else
    if self.wasRecalling and self.hanging then
      -- Back from a rewind on its rope: carry on swinging from wherever it
      -- was left (as near as the rope allows), at rest.
      self.angle = math.atan2(self.pos.x - self.offX - self.top.x, self.pos.y - self.offY - self.top.y)
      self.angVel = 0
    end
    self.wasRecalling = false
    if self.hanging then
      self:checkBump()
      self:updateSwing(ts)
    else
      self:updateFall(ts)
    end
  end
  self:placeSurface()
end

----------------------------------------------------------------------
-- Drawing
----------------------------------------------------------------------

local function drawRopeLine(x0, y0, x1, y1, color)
  love.graphics.setLineWidth(ROPE_WIDTH + 2)
  love.graphics.setColor(COLOR_ROPE_DARK)
  love.graphics.line(x0, y0, x1, y1)
  love.graphics.setLineWidth(ROPE_WIDTH)
  love.graphics.setColor(color)
  love.graphics.line(x0, y0, x1, y1)
end

local function drawFlame(x, y)
  local flicker = 1 + 0.25 * math.sin(love.timer.getTime() * 31)
  love.graphics.setColor(COLOR_FLAME[1], COLOR_FLAME[2], COLOR_FLAME[3], 0.35)
  love.graphics.circle("fill", x, y - 4, 13 * flicker)
  love.graphics.setColor(COLOR_FLAME)
  love.graphics.circle("fill", x, y - 2, 7 * flicker)
  love.graphics.setColor(COLOR_FLAME_CORE)
  love.graphics.circle("fill", x, y, 3.5 * flicker)
end

function RopeRock:draw()
  -- The rope (charred round where it's burning).
  if not self.burnedAway then
    local ex, ey = self:ropeEnd()
    drawRopeLine(self.top.x, self.top.y, ex, ey, COLOR_ROPE)
    if self.burn then
      local CHAR = 14 / self.ropeLength -- (14 world units either side)
      local t0, t1 = math.max(0, self.burn.at - CHAR), math.min(1, self.burn.at + CHAR)
      local ax, ay = self:flamePoint(t0)
      local bx, by = self:flamePoint(t1)
      drawRopeLine(ax, ay, bx, by, COLOR_ROPE_CHAR)
      drawFlame(self:flamePoint(self.burn.at))
    end
  end

  -- The rock.
  local x0, y0 = self.pos.x - self.halfWidth, self.pos.y - self.halfHeight
  local w, h = self.halfWidth * 2, self.halfHeight * 2
  love.graphics.setColor(COLOR_ROCK)
  love.graphics.rectangle("fill", x0, y0, w, h, ROCK_CORNER, ROCK_CORNER)
  love.graphics.setColor(COLOR_ROCK_SPOT)
  love.graphics.ellipse("fill", x0 + w * 0.28, y0 + h * 0.6, w * 0.09, h * 0.16)
  love.graphics.ellipse("fill", x0 + w * 0.66, y0 + h * 0.45, w * 0.12, h * 0.2)
  love.graphics.ellipse("fill", x0 + w * 0.85, y0 + h * 0.7, w * 0.05, h * 0.12)
  love.graphics.setColor(COLOR_ROCK_TOP)
  love.graphics.setLineWidth(4)
  love.graphics.line(x0 + ROCK_CORNER, y0 + 2, x0 + w - ROCK_CORNER, y0 + 2)
  love.graphics.setColor(COLOR_ROCK_EDGE)
  love.graphics.setLineWidth(3)
  love.graphics.rectangle("line", x0, y0, w, h, ROCK_CORNER, ROCK_CORNER)

  love.graphics.setLineWidth(1)
  love.graphics.setColor(1, 1, 1, 1)
end

return RopeRock
