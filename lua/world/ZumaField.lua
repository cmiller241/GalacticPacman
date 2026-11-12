-- lua/world/ZumaField.lua
--
-- The Zuma planet's game (see lua/levels/ZumaPlanet.lua; it's the game
-- of the planet's control room, lua/interiors/ControlRoom.lua).
--
-- Taking the controls puts a cannon on the planet's surface, a colored
-- ball poking out of its mouth. Left and Right turn the planet, which
-- aims the cannon; the jump button fires the ball straight out.
--
-- Out in space a black hole forms, and a train of colored balls rolls
-- out of it along a path that spirals in round the planet (drawn
-- faintly, brightening and reddening toward the planet). If the train's
-- front ball reaches the planet, the game's lost.
--
-- A shot that hits the train is pushed into it right there. If that
-- makes MATCH or more touching balls of one color, they all pop. A gap
-- left behind closes up (the part of the train in front of it rolls back
-- to meet the part behind), and if the balls meeting there make a match
-- too, they pop as well — a chain. Clear every ball the black hole sends (TOTAL_BALLS)
-- and the game's won.
--
-- The cannon only ever loads colors still in the train, and the next
-- one's shown on its base.
--
-- The train's balls each have a distance along the path (s), front
-- first: self.balls[1] is nearest the planet. Only the back of the train
-- is pushed along (the black hole pushes it out); a ball touching the
-- one behind it is pushed along too. Ahead of a gap, the balls roll
-- back toward it instead.

local state = require("lua.state")
local CameraShake = require("lua.effects.CameraShake")

local ZumaField = {}
ZumaField.__index = ZumaField

----------------------------------------------------------------------
-- Tunables
----------------------------------------------------------------------

local BALL_RADIUS = 56
local GAP = BALL_RADIUS * 2      -- one ball to the next, along the path
local TOUCH = GAP + 0.5          -- (two balls closer than this are touching)
local COLORS = {
  { 0.95, 0.30, 0.32 }, -- red
  { 1.00, 0.84, 0.22 }, -- yellow
  { 0.35, 0.85, 0.40 }, -- green
  { 0.32, 0.56, 1.00 }, -- blue
}
local TOTAL_BALLS = 40           -- how many the black hole sends out
local SAME_COLOR_CHANCE = 0.35   -- how likely a new ball is the color of the one before it
local MATCH = 3                  -- touching balls of a color that pop

-- The path: where it starts (how far from the planet's middle — the
-- black hole's there), how many times it winds round, and how finely it's
-- traced. It ends touching the planet.
local PATH_START = 1400
local PATH_TURNS = 1.6
local PATH_POINTS = 700

-- The train's speed along the path (world units a second): rushing out
-- at first (till INTRO_BALLS are out), then its steady crawl, and how
-- fast the part in front of a gap rolls back to close it.
local INTRO_SPEED = 600
local INTRO_BALLS = 10
local BASE_SPEED = 105
local ROLLBACK_SPEED = 450
local DRAW_EASE = 0.35           -- how quickly a ball pushed along slides to its place (per tick)

-- The cannon: its barrel's length and width (before CANNON_SCALE: it's
-- drawn that much bigger, to fit the balls), how fast shots fly (world
-- units a second) and how soon it can fire again (seconds).
local CANNON_SCALE = 2
local BARREL_LENGTH = 88
local BARREL_WIDTH = 44
local SHOT_SPEED = 1700
local SHOT_COOLDOWN = 0.22
local INSERT_TIME = 0.1          -- seconds a shot takes to settle into the train
-- The planet's turn: top speed (radians a second), and how quickly it
-- gets up to it and back down (fraction of the way per tick).
local SPIN_SPEED = 1.7
local SPIN_EASE = 0.25

-- The black hole: its size, and how long it takes to form (and collapse).
local HOLE_RADIUS = 220
local HOLE_FORM_TIME = 1.6
-- The shader's drawing: the event horizon's radius, and the square it's
-- drawn on (half its size), each as a fraction of the hole's size.
local HORIZON_SIZE = 0.55
local HOLE_BOX = 2.6
-- The end of a game: how long the balls take to pop and the hole to
-- collapse before he's let go of the controls, and how long the banner
-- stays up.
local OVER_TIME = 1.8
local BANNER_TIME = 4
local POP_TIME = 0.35

local COLOR_OUTLINE = { 0.04, 0.04, 0.08 }
local COLOR_BRONZE = { 0.80, 0.60, 0.28 }
local COLOR_BRONZE_DARK = { 0.52, 0.36, 0.16 }
local COLOR_BRONZE_LIGHT = { 0.98, 0.82, 0.48 }

----------------------------------------------------------------------
-- Building
----------------------------------------------------------------------

function ZumaField.new(planet)
  return setmetatable({
    planet = planet,
    angle = 0,         -- how far the planet's turned (radians, clockwise)
    spin = 0,          -- how fast it's turning now (radians a second)
    phase = "idle",    -- "idle", "forming" (the hole), "playing", "over"
    path = nil,        -- the path's points, { x, y, s } (s: distance along it)
    pathLength = 0,
    pathFade = 0,      -- how much the path shows (fades in and out)
    holeSize = 0,      -- the black hole's radius now (grows and shrinks)
    balls = {},        -- the train, front first: { color, s, drawS, fly }
    spawned = 0,
    shots = {},
    cooldown = 0,
    current = nil,     -- the color in the cannon, and the one after it
    nextColor = nil,
    cannonShow = 0,    -- the cannon popping up (0 to 1) and down
    recoil = 0,
    chain = 0,
    pops = {},         -- balls bursting: { x, y, color, t }
    over = nil,        -- { kind = "lost" or "won", timer, popTimer }
    banner = nil,      -- { title, sub, color, timer }
    finished = false,  -- (see ControlRoom:updateGame)
  }, ZumaField)
end

----------------------------------------------------------------------
-- The path
----------------------------------------------------------------------

-- A spiral from PATH_START out, in round the planet PATH_TURNS times, to
-- the planet's surface, starting from a random side.
function ZumaField:buildPath()
  local planet = self.planet
  local cx, cy = planet.pos.x, planet.pos.y
  local endR = planet.radius + BALL_RADIUS
  local a0 = math.random() * math.pi * 2
  local points, total = {}, 0
  local px, py
  for i = 0, PATH_POINTS do
    local t = i / PATH_POINTS
    local r = endR + (PATH_START - endR) * (1 - t)
    local a = a0 + t * PATH_TURNS * math.pi * 2
    local x, y = cx + math.cos(a) * r, cy + math.sin(a) * r
    if px then total = total + math.sqrt((x - px) ^ 2 + (y - py) ^ 2) end
    points[#points + 1] = { x = x, y = y, s = total }
    px, py = x, y
  end
  self.path, self.pathLength = points, total
end

-- Where on the path distance s is, and which way it runs there (a unit
-- vector toward the planet end).
function ZumaField:pathAt(s)
  local points = self.path
  s = math.max(0, math.min(self.pathLength, s))
  local lo, hi = 1, #points
  while hi - lo > 1 do
    local mid = math.floor((lo + hi) / 2)
    if points[mid].s <= s then lo = mid else hi = mid end
  end
  local a, b = points[lo], points[hi]
  local len = b.s - a.s
  local f = len > 0 and (s - a.s) / len or 0
  local dx, dy = b.x - a.x, b.y - a.y
  local d = math.sqrt(dx * dx + dy * dy)
  if d < 1e-6 then d = 1 end
  return a.x + dx * f, a.y + dy * f, dx / d, dy / d
end

----------------------------------------------------------------------
-- Colors
----------------------------------------------------------------------

-- Whether a color's still in the train.
function ZumaField:colorInTrain(color)
  for _, b in ipairs(self.balls) do
    if b.color == color then return true end
  end
  return false
end

-- A color for the cannon: one still in the train (any, if it's empty).
function ZumaField:pickColor()
  local present = {}
  for k = 1, #COLORS do
    if self:colorInTrain(k) then present[#present + 1] = k end
  end
  if #present == 0 then return math.random(#COLORS) end
  return present[math.random(#present)]
end

----------------------------------------------------------------------
-- The train
----------------------------------------------------------------------

-- New balls out of the black hole, while there's room at the back: each
-- right behind the last one out, or at the hole itself if the back of
-- the train's been cleared away from it (so they always come out of the
-- hole, one at a time, never appearing all along the empty path).
function ZumaField:spawnBalls()
  while self.spawned < TOTAL_BALLS do
    local tail = self.balls[#self.balls]
    if tail and tail.s < GAP then return end
    local s = (tail and tail.s < GAP * 2) and (tail.s - GAP) or 0
    local color = (tail and math.random() < SAME_COLOR_CHANCE) and tail.color or math.random(#COLORS)
    table.insert(self.balls, { color = color, s = s, drawS = s })
    self.spawned = self.spawned + 1
  end
end

-- The run of touching same-colored balls around ball i: its first and
-- last index.
function ZumaField:runAround(i)
  local balls = self.balls
  local color = balls[i].color
  local lo, hi = i, i
  while lo > 1 and balls[lo - 1].color == color and balls[lo - 1].s - balls[lo].s <= TOUCH do lo = lo - 1 end
  while hi < #balls and balls[hi + 1].color == color and balls[hi].s - balls[hi + 1].s <= TOUCH do hi = hi + 1 end
  return lo, hi
end

-- Pops the run round ball i if it's MATCH or more. chained: whether a
-- gap closing set it off (else a shot did). Returns whether it popped.
function ZumaField:tryMatch(i, chained)
  local lo, hi = self:runAround(i)
  if hi - lo + 1 < MATCH then return false end
  self.chain = chained and self.chain + 1 or 1
  for k = hi, lo, -1 do
    local b = self.balls[k]
    local x, y = self:pathAt(b.drawS)
    table.insert(self.pops, { x = x, y = y, color = b.color, t = 0 })
    table.remove(self.balls, k)
  end
  local audio = state.audioManager
  if audio then audio:playZumaPop(self.chain) end
  return true
end

-- The train rolls on: the back of it pushed along, everything it touches
-- pushed ahead of it. In front of a gap, the balls roll back toward it
-- (never past touching the balls behind). Where a gap has just closed and
-- the balls meeting match, they pop (a chain).
function ZumaField:moveTrain(dt)
  local balls = self.balls
  local n = #balls
  if n == 0 then return end
  local open = {}
  for i = 1, n - 1 do open[i] = balls[i].s - balls[i + 1].s > TOUCH end
  local speed = self.spawned < INTRO_BALLS and INTRO_SPEED or BASE_SPEED
  balls[n].s = balls[n].s + speed * dt
  for i = n - 1, 1, -1 do
    local least = balls[i + 1].s + GAP
    if balls[i].s < least then balls[i].s = least end
  end
  -- (Each part of the train in front of a gap, from the back forward: it
  -- rolls back as one, as far as it can this frame.)
  local i = n - 1
  while i >= 1 do
    if balls[i].s - balls[i + 1].s > TOUCH then
      local first = i
      while first > 1 and balls[first - 1].s - balls[first].s <= TOUCH do first = first - 1 end
      local back = math.min(ROLLBACK_SPEED * dt, balls[i].s - (balls[i + 1].s + GAP))
      for k = first, i do balls[k].s = balls[k].s - back end
      i = first - 1
    else
      i = i - 1
    end
  end
  for i = 1, n - 1 do
    if open[i] and balls[i].s - balls[i + 1].s <= TOUCH and balls[i].color == balls[i + 1].color then
      self:tryMatch(i, true)
      return -- (one at a time: the train's changed)
    end
  end
end

----------------------------------------------------------------------
-- The cannon and its shots
----------------------------------------------------------------------

-- Which way the cannon points (out from the planet): it sits on top of
-- the planet as it was at the start, and turns with it.
function ZumaField:cannonAngle()
  return self.angle - math.pi / 2
end

-- The jump button: fires the ball in the cannon, then loads the next.
function ZumaField:fire()
  if self.phase ~= "playing" or self.cooldown > 0 then return end
  local planet = self.planet
  local a = self:cannonAngle()
  local dx, dy = math.cos(a), math.sin(a)
  local r = planet.radius + BARREL_LENGTH * CANNON_SCALE
  table.insert(self.shots, {
    x = planet.pos.x + dx * r, y = planet.pos.y + dy * r,
    vx = dx * SHOT_SPEED, vy = dy * SHOT_SPEED,
    color = self.current,
  })
  self.current, self.nextColor = self.nextColor, self:pickColor()
  self.cooldown = SHOT_COOLDOWN
  self.recoil = 1
  local audio = state.audioManager
  if audio then audio:playZumaShoot() end
end

-- A shot's hit ball i: it's pushed into the train beside it (ahead of it
-- or behind, whichever side it hit), the balls ahead pushed along to make
-- room, and anything it matches pops.
function ZumaField:insertShot(shot, i)
  local balls = self.balls
  local b = balls[i]
  local bx, by, tx, ty = self:pathAt(b.s)
  local ahead = (shot.x - bx) * tx + (shot.y - by) * ty > 0
  local k, s
  if ahead then k, s = i, b.s + GAP else k, s = i + 1, b.s end
  table.insert(balls, k, { color = shot.color, s = s, drawS = s, fly = { x = shot.x, y = shot.y, t = 0 } })
  for j = k - 1, 1, -1 do
    local least = balls[j + 1].s + GAP
    if balls[j].s < least then balls[j].s = least else break end
  end
  self:tryMatch(k, false)
end

function ZumaField:updateShots(dt)
  local planet = self.planet
  local balls = self.balls
  -- (Where every ball is now, for hitting.)
  local bx, by = {}, {}
  for i, b in ipairs(balls) do bx[i], by[i] = self:pathAt(b.s) end
  local reach = PATH_START + 300
  for k = #self.shots, 1, -1 do
    local shot = self.shots[k]
    local dist = math.sqrt((shot.vx * dt) ^ 2 + (shot.vy * dt) ^ 2)
    local steps = math.max(1, math.ceil(dist / (BALL_RADIUS * 0.5)))
    local hit = nil
    for _ = 1, steps do
      shot.x, shot.y = shot.x + shot.vx * dt / steps, shot.y + shot.vy * dt / steps
      for i = 1, #balls do
        if (shot.x - bx[i]) ^ 2 + (shot.y - by[i]) ^ 2 < GAP * GAP then hit = i break end
      end
      if hit then break end
    end
    if hit then
      table.remove(self.shots, k)
      self:insertShot(shot, hit)
      return -- (the train's changed; other shots carry on next frame)
    end
    local dx, dy = shot.x - planet.pos.x, shot.y - planet.pos.y
    if dx * dx + dy * dy > reach * reach then table.remove(self.shots, k) end
  end
end

----------------------------------------------------------------------
-- Starting and ending
----------------------------------------------------------------------

-- He's taken the controls: a new game. The black hole starts forming; the
-- train comes out once it has.
function ZumaField:start()
  self:buildPath()
  self.balls, self.shots, self.spawned = {}, {}, 0
  self.phase = "forming"
  self.over, self.banner, self.finished = nil, nil, false
  self.chain = 0
  self.current, self.nextColor = math.random(#COLORS), math.random(#COLORS)
end

-- Every ball still in the train pops (the game's been stopped).
function ZumaField:popAll()
  for _, b in ipairs(self.balls) do
    local x, y = self:pathAt(b.drawS)
    table.insert(self.pops, { x = x, y = y, color = b.color, t = 0 })
  end
  self.balls, self.shots = {}, {}
end

-- He's let go mid-game: it's over. Everything pops and the hole collapses.
function ZumaField:stop()
  if self.phase == "idle" then return end
  self:popAll()
  if #self.pops > 0 then
    local audio = state.audioManager
    if audio then audio:playZumaPop(1) end
  end
  self.phase = "idle"
  self.over = nil
end

-- The game's ended on its own: lost (the train reached the planet) or won
-- (every ball cleared).
function ZumaField:finish(kind)
  self.phase = "over"
  self.over = { kind = kind, timer = 0, popTimer = 0 }
  self.shots = {}
  local audio = state.audioManager
  if kind == "lost" then
    self.banner = { title = "THE BALLS REACHED THE PLANET!", sub = "Press ENTER at the panel to try again",
      color = { 1, 0.45, 0.4 }, timer = BANNER_TIME }
    CameraShake.start(18, 0.6)
    if audio then audio:playDeath() end
  else
    self.banner = { title = "CLEARED!", sub = "The black hole collapses",
      color = { 1, 0.86, 0.4 }, timer = BANNER_TIME }
    if audio then audio:playTetrisClear(4) end
  end
end

----------------------------------------------------------------------
-- Every frame
----------------------------------------------------------------------

function ZumaField:update(dt, ts, playing, steer)
  local active = self.phase == "forming" or self.phase == "playing"

  -- The planet's turn (only while there's a cannon to aim).
  local want = (playing and active) and (steer or 0) * SPIN_SPEED or 0
  self.spin = self.spin + (want - self.spin) * math.min(1, SPIN_EASE * ts)
  if math.abs(self.spin) < 0.001 and want == 0 then self.spin = 0 end
  self.angle = self.angle + self.spin * dt

  -- What fades and grows: the path, the hole, the cannon.
  local showing = active or (self.phase == "over" and self.over.timer < OVER_TIME * 0.6)
  self.pathFade = math.max(0, math.min(1, self.pathFade + (showing and 1 or -1) * dt * 1.5))
  local holeRate = HOLE_RADIUS / HOLE_FORM_TIME
  if showing then
    self.holeSize = math.min(HOLE_RADIUS, self.holeSize + holeRate * dt)
  else
    self.holeSize = math.max(0, self.holeSize - holeRate * 2 * dt)
  end
  self.cannonShow = math.max(0, math.min(1, self.cannonShow + ((active and playing) and 1 or -1) * dt * 4))
  self.recoil = math.max(0, self.recoil - dt * 6)
  self.cooldown = math.max(0, self.cooldown - dt)

  -- Balls bursting, and sliding into their places.
  for k = #self.pops, 1, -1 do
    local p = self.pops[k]
    p.t = p.t + dt
    if p.t >= POP_TIME then table.remove(self.pops, k) end
  end
  local ease = math.min(1, DRAW_EASE * ts)
  for _, b in ipairs(self.balls) do
    b.drawS = b.drawS + (b.s - b.drawS) * ease
    if b.fly then
      b.fly.t = b.fly.t + dt
      if b.fly.t >= INSERT_TIME then b.fly = nil end
    end
  end
  if self.banner then
    self.banner.timer = self.banner.timer - dt
    if self.banner.timer <= 0 then self.banner = nil end
  end

  if self.phase == "forming" then
    if self.holeSize >= HOLE_RADIUS then self.phase = "playing" end
  elseif self.phase == "playing" then
    self:spawnBalls()
    self:moveTrain(dt)
    self:updateShots(dt)
    -- (The cannon only ever holds colors still in the train.)
    if #self.balls > 0 then
      if not self:colorInTrain(self.current) then self.current = self:pickColor() end
      if not self:colorInTrain(self.nextColor) then self.nextColor = self:pickColor() end
    end
    local front = self.balls[1]
    if front and front.s >= self.pathLength then
      self:finish("lost")
    elseif self.spawned >= TOTAL_BALLS and #self.balls == 0 then
      self:finish("won")
    end
  elseif self.phase == "over" then
    local over = self.over
    over.timer = over.timer + dt
    -- (Lost: the train pops, front first.)
    over.popTimer = over.popTimer - dt
    while #self.balls > 0 and over.popTimer <= 0 do
      over.popTimer = over.popTimer + 0.03
      local b = table.remove(self.balls, 1)
      local x, y = self:pathAt(b.drawS)
      table.insert(self.pops, { x = x, y = y, color = b.color, t = 0 })
    end
    if over.timer >= OVER_TIME then
      self.balls = {}
      self.phase = "idle"
      self.over = nil
      self.finished = true
    end
  end
end

-- How far round the planet its game reaches (the path, the black hole and
-- its glow): what drifting planetoids are kept out of (see ZumaPlanet.lua).
ZumaField.REACH = PATH_START + HOLE_RADIUS * 1.4

-- The jump button at the controls: fires.
function ZumaField:onJump() self:fire() end

-- How far out the camera frames, at the controls: the whole path, and the hole.
function ZumaField:cameraReach()
  return PATH_START + HOLE_RADIUS * 0.6
end

----------------------------------------------------------------------
-- Drawing
----------------------------------------------------------------------

-- One ball, shaded like a planet by the sun: lit on the sun's side and
-- dark on the far side, a glare (the sun's reflection) toward it, and
-- reflected light round the edge farthest from it; a dark edge, and a
-- band showing it roll (roll: how far it's rolled, in radians; nil for
-- none). Drawn by a shader (made the first time it's needed), on a
-- square round it — in whatever transform is current (the cannon's, say):
-- it works out where that puts the ball on the screen. sunDirX/Y: set
-- each frame (see ZumaField:draw).
local ballShader = nil
local sunDirX, sunDirY = 1, 0
local function getBallShader()
  if ballShader then return ballShader end
  ballShader = love.graphics.newShader([[
    extern vec2 center;        // the ball's middle, in screen pixels
    extern number radius;      // its radius, in screen pixels
    extern vec3 baseColor;
    extern vec2 sunDir;        // unit vector toward the sun (screen space, y down)
    extern number roll;        // how far it's rolled (radians): turns the band round it
    extern number rollAmount;  // 0: no band (a shot in flight, the cannon's balls)

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec2 p = (screen - center) / radius;
      float d = length(p);
      float px = 1.0 / radius;
      float edge = 1.0 + 2.5 * px;                    // a dark edge 2.5 pixels wide
      float body = 1.0 - smoothstep(1.0 - px, 1.0 + px, d);
      float alpha = 1.0 - smoothstep(edge - px, edge + px, d);
      vec2 out2 = p / max(d, 0.0001);                 // out from the middle, flat
      float dd = min(d, 1.0);
      vec3 n = vec3(out2 * dd, sqrt(max(0.0, 1.0 - dd * dd)));  // the sphere's normal
      vec3 light = normalize(vec3(sunDir, 0.55));

      // Shading: lit on the sun's side, dark on the far side.
      float lit = max(dot(n, light), 0.0);
      vec3 col = baseColor * (0.28 + 0.85 * lit);
      // The band it rolls round on.
      vec2 axis = vec2(cos(roll), sin(roll));
      float band = (1.0 - smoothstep(0.10, 0.18, abs(dot(p, vec2(-axis.y, axis.x))))) * rollAmount;
      col = mix(col, col * 1.25 + 0.08, band * 0.35);
      // The glare: the sun's reflection, a bright spot toward it.
      vec3 bounce = reflect(-light, n);
      col += vec3(1.0) * pow(max(bounce.z, 0.0), 28.0) * 0.85;
      // Reflected light round the edge farthest from the sun.
      float rim = pow(1.0 - n.z, 2.5) * max(dot(out2, -sunDir), 0.0);
      col += (baseColor * 0.6 + vec3(0.25, 0.30, 0.40)) * rim * 0.75;

      vec3 rgb = mix(vec3(0.04, 0.04, 0.08), col, body);
      return vec4(rgb, alpha) * color;
    }
]])
  return ballShader
end

local function drawBall(x, y, r, color, roll, alpha)
  local sx, sy = love.graphics.transformPoint(x, y)
  local ex, ey = love.graphics.transformPoint(x + r, y)
  local radius = math.sqrt((ex - sx) ^ 2 + (ey - sy) ^ 2)
  if radius < 0.5 then return end
  local sh = getBallShader()
  love.graphics.setShader(sh)
  sh:send("center", { sx, sy })
  sh:send("radius", radius)
  sh:send("baseColor", { color[1], color[2], color[3] })
  sh:send("sunDir", { sunDirX, sunDirY })
  sh:send("roll", roll or 0)
  sh:send("rollAmount", roll and 1 or 0)
  love.graphics.setColor(1, 1, 1, alpha or 1)
  local pad = r * 1.1 + 4
  love.graphics.rectangle("fill", x - pad, y - pad, pad * 2, pad * 2)
  love.graphics.setShader()
end

-- Marks round the planet's edge, turning with it, so its turn shows.
local function drawSurfaceMarks(planet, angle)
  local r = planet.radius
  love.graphics.setLineWidth(3)
  for k = 0, 23 do
    local a = angle + k / 24 * math.pi * 2
    local c, s = math.cos(a), math.sin(a)
    love.graphics.setColor(1, 1, 1, k % 6 == 0 and 0.25 or 0.1)
    love.graphics.line(planet.pos.x + c * (r - 16), planet.pos.y + s * (r - 16), planet.pos.x + c * (r - 3), planet.pos.y + s * (r - 3))
  end
end

-- The path: faint where it starts, brighter and redder toward the planet.
-- The stretch still ahead of the train glows more (and pulses) the nearer
-- the front ball is to the end. A red ring marks the end.
function ZumaField:drawPath(t)
  local points, fade = self.path, self.pathFade
  local n = #points
  local front = self.balls[1]
  local danger = front and front.s / self.pathLength or 0
  local warn = math.max(0, (danger - 0.5) * 2)
  local pulse = 0.5 + 0.5 * math.sin(t * 7)
  local CHUNK = 14
  love.graphics.setLineWidth(20)
  for i = 1, n - 1, CHUNK do
    local j = math.min(n, i + CHUNK)
    local f = points[i].s / self.pathLength
    local ahead = front and points[i].s > front.s
    local r, g, b = 0.85 + 0.15 * f, 0.85 - 0.6 * f, 1.0 - 0.8 * f
    local alpha = (0.08 + 0.22 * f) * fade
    if ahead then alpha = alpha + warn * (0.25 + 0.35 * pulse) * fade end
    love.graphics.setColor(r, g, b, alpha)
    local line = {}
    for k = i, j do line[#line + 1] = points[k].x; line[#line + 1] = points[k].y end
    love.graphics.line(line)
  end
  local last = points[n]
  love.graphics.setColor(1, 0.25, 0.2, (0.4 + 0.4 * pulse * (0.3 + warn)) * fade)
  love.graphics.setLineWidth(8)
  love.graphics.circle("line", last.x, last.y, BALL_RADIUS + 12)
end

-- The black hole, drawn by a shader (made the first time it's needed): a
-- black event horizon, a white-hot ring of light hugging it, a disk of
-- matter swirling in (orange-hot near the middle, cooling to purple
-- further out, wound tighter the closer it is, with spiral arms), and a
-- soft purple glow round it all.
local holeShader = nil
local function getHoleShader()
  if holeShader then return holeShader end
  holeShader = love.graphics.newShader([[
    extern vec2 originScreen;  // the square's top-left corner, in screen pixels
    extern number zoom;
    extern number boxHalf;     // half the square's size (world units); the hole's in its middle
    extern number horizon;     // the event horizon's radius (world units)
    extern number time;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                 mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }
    float fbm(vec2 p) {
      return 0.5 * noise(p) + 0.3 * noise(p * 2.1 + 3.7) + 0.2 * noise(p * 4.3 + 9.1);
    }

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec2 p = (screen - originScreen) / zoom - vec2(boxHalf, boxHalf);
      float d = length(p) / horizon;          // 1 at the event horizon
      float a = atan(p.y, p.x);

      // The accretion disk: matter swirling in, wound tighter the closer it
      // is (the twist), turbulent (noise in the twisted frame, so it has no
      // seam), with spiral arms; brightest just outside the horizon.
      float twist = time * 1.4 + 2.2 / (d + 0.25);
      vec2 q = vec2(cos(twist) * p.x - sin(twist) * p.y, sin(twist) * p.x + cos(twist) * p.y) / horizon;
      float turbulence = fbm(q * 2.4 + vec2(time * 0.3, 0.0));
      float arms = 0.5 + 0.5 * sin(a * 3.0 + 5.0 * log(max(d, 0.01)) - time * 2.5);
      float disk = smoothstep(0.98, 1.2, d) * (1.0 - smoothstep(1.35, 2.9, d));
      float matter = disk * (0.35 + 0.65 * arms) * (0.45 + 0.9 * turbulence);
      vec3 hot = vec3(1.0, 0.62, 0.25);
      vec3 cool = vec3(0.55, 0.25, 0.95);
      vec3 matterColor = mix(cool, hot, 1.0 - smoothstep(1.1, 2.4, d));

      // The photon ring: a thin white-hot circle hugging the horizon, and a
      // soft purple glow fading out round everything.
      float ring = exp(-pow((d - 1.03) / 0.045, 2.0));
      float glow = exp(-max(d - 1.0, 0.0) * 1.5) * 0.35;

      vec3 light = matterColor * matter * 1.6 + vec3(1.0, 0.92, 0.8) * ring * 1.4 + vec3(0.5, 0.25, 0.9) * glow;
      float lit = clamp(matter + ring + glow, 0.0, 1.0);
      // Inside the horizon: black.
      float dark = 1.0 - smoothstep(0.94, 1.0, d);
      float alpha = max(dark, lit);
      vec3 rgb = light * (1.0 - dark) / max(alpha, 0.001);
      // (Nothing at the square's edges.)
      alpha *= 1.0 - smoothstep(boxHalf * 0.8, boxHalf, length(p));
      return vec4(min(rgb, vec3(1.0)), alpha) * color;
    }
]])
  return holeShader
end

function ZumaField:drawHole(t)
  local size = self.holeSize
  if size <= 0.5 or not self.path then return end
  local p = self.path[1]
  local sh = getHoleShader()
  local zoom = state.zoom or 1
  local cam = state.camera or { x = 0, y = 0 }
  local half = size * HOLE_BOX
  local x0, y0 = p.x - half, p.y - half
  love.graphics.setShader(sh)
  sh:send("originScreen", { (x0 - cam.x) * zoom, (y0 - cam.y) * zoom })
  sh:send("zoom", zoom)
  sh:send("boxHalf", half)
  sh:send("horizon", size * HORIZON_SIZE)
  sh:send("time", t % 600) -- (kept small: shaders lose precision on big numbers)
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.rectangle("fill", x0, y0, half * 2, half * 2)
  love.graphics.setShader()
end

-- The cannon on the planet's surface, pointing out: a bronze dome with a
-- barrel, the loaded ball half out of its mouth, and the next color on
-- the dome. It pops up out of the planet when the game starts.
function ZumaField:drawCannon()
  local show = self.cannonShow
  if show <= 0.01 then return end
  local planet = self.planet
  love.graphics.push()
  love.graphics.translate(planet.pos.x, planet.pos.y)
  love.graphics.rotate(self:cannonAngle() + math.pi / 2)
  love.graphics.translate(0, -planet.radius)
  love.graphics.scale(show * CANNON_SCALE, show * CANNON_SCALE)
  -- (Here: the surface at 0, 0, out from the planet is up the screen,
  -- everything CANNON_SCALE times bigger.)
  local kick = self.recoil * 10
  local mouth = -BARREL_LENGTH + kick
  local hw = BARREL_WIDTH / 2

  if self.current and self.phase ~= "idle" then
    drawBall(0, mouth, BALL_RADIUS / CANNON_SCALE, COLORS[self.current])
  end
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.rectangle("fill", -hw - 3, mouth - 3, BARREL_WIDTH + 6, BARREL_LENGTH - kick + 3, 4, 4)
  love.graphics.setColor(COLOR_BRONZE)
  love.graphics.rectangle("fill", -hw, mouth, BARREL_WIDTH, BARREL_LENGTH - kick, 3, 3)
  love.graphics.setColor(COLOR_BRONZE_LIGHT)
  love.graphics.rectangle("fill", -hw + 4, mouth + 2, 6, BARREL_LENGTH - kick - 4, 2, 2)
  love.graphics.setColor(COLOR_BRONZE_DARK)
  for k = 1, 2 do love.graphics.rectangle("fill", -hw, mouth + 18 + (k - 1) * 28, BARREL_WIDTH, 6) end
  -- The rim round the mouth.
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.rectangle("fill", -hw - 6, mouth - 2, BARREL_WIDTH + 12, 12, 3, 3)
  love.graphics.setColor(COLOR_BRONZE_LIGHT)
  love.graphics.rectangle("fill", -hw - 3, mouth + 1, BARREL_WIDTH + 6, 6, 2, 2)
  -- The dome.
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.arc("fill", "pie", 0, 6, 54, math.pi, math.pi * 2, 24)
  love.graphics.setColor(COLOR_BRONZE)
  love.graphics.arc("fill", "pie", 0, 6, 50, math.pi, math.pi * 2, 24)
  love.graphics.setColor(COLOR_BRONZE_LIGHT)
  love.graphics.arc("fill", "pie", 0, 6, 50, math.pi * 1.15, math.pi * 1.4, 10)
  if self.nextColor and self.phase ~= "idle" then
    drawBall(0, -18, 12, COLORS[self.nextColor])
  end
  love.graphics.pop()

  -- A faint aiming line, straight out.
  if self.phase == "playing" then
    local a = self:cannonAngle()
    local c, s = math.cos(a), math.sin(a)
    love.graphics.setColor(1, 1, 1, 0.18)
    for k = 0, 9 do
      local d = planet.radius + BARREL_LENGTH * CANNON_SCALE + 70 + k * 60
      love.graphics.circle("fill", planet.pos.x + c * d, planet.pos.y + s * d, 6)
    end
  end
end

-- World space: the planet's marks, the path, the hole, the train, the
-- shots, the bursts and the cannon.
function ZumaField:draw()
  local t = love.timer.getTime()
  -- (Which way the sun is — the middle of the world, as the planets have
  -- it. It's so far off it's the same way for every ball.)
  local planet = self.planet
  local tx, ty = (state.sceneWidth or 0) / 2 - planet.pos.x, (state.sceneHeight or 0) / 2 - planet.pos.y
  local len = math.sqrt(tx * tx + ty * ty)
  if len > 1 then sunDirX, sunDirY = tx / len, ty / len end
  drawSurfaceMarks(self.planet, self.angle)
  if self.path and self.pathFade > 0 then self:drawPath(t) end
  self:drawHole(t)

  for _, b in ipairs(self.balls) do
    local x, y = self:pathAt(b.drawS)
    if b.fly then
      local f = b.fly.t / INSERT_TIME
      x, y = b.fly.x + (x - b.fly.x) * f, b.fly.y + (y - b.fly.y) * f
    end
    -- (Coming out of the hole: growing to full size over its first ball's width.)
    local r = BALL_RADIUS * math.min(1, math.max(0.15, b.drawS / GAP))
    drawBall(x, y, r, COLORS[b.color], b.drawS / BALL_RADIUS)
  end
  for _, shot in ipairs(self.shots) do
    drawBall(shot.x, shot.y, BALL_RADIUS, COLORS[shot.color])
  end
  for _, p in ipairs(self.pops) do
    local f = p.t / POP_TIME
    local c = COLORS[p.color]
    drawBall(p.x, p.y, BALL_RADIUS * (1 + f * 0.6), { c[1] + (1 - c[1]) * f, c[2] + (1 - c[2]) * f, c[3] + (1 - c[3]) * f }, nil, 1 - f)
    love.graphics.setColor(1, 1, 1, 0.8 * (1 - f))
    love.graphics.setLineWidth(3)
    love.graphics.circle("line", p.x, p.y, BALL_RADIUS * (1 + f * 1.4))
  end
  self:drawCannon()
  love.graphics.setColor(1, 1, 1, 1)
end

local hudFont, bannerFont = nil, nil

-- Screen space: how many balls are left (at the controls), and the
-- win/lose banner.
function ZumaField:drawHud(playing)
  hudFont = hudFont or love.graphics.newFont(18)
  bannerFont = bannerFont or love.graphics.newFont(40)
  local prevFont = love.graphics.getFont()
  local screenW, screenH = love.graphics.getWidth(), love.graphics.getHeight()

  if playing and (self.phase == "forming" or self.phase == "playing") then
    local left = TOTAL_BALLS - self.spawned + #self.balls
    local w, h = 170, 64
    local x0, y0 = screenW - 20 - w, 20
    love.graphics.setColor(0.04, 0.03, 0.08, 0.7)
    love.graphics.rectangle("fill", x0, y0, w, h, 12, 12)
    love.graphics.setColor(1, 1, 1, 0.3)
    love.graphics.setLineWidth(2)
    love.graphics.rectangle("line", x0, y0, w, h, 12, 12)
    love.graphics.setFont(hudFont)
    love.graphics.setColor(1, 1, 1, 0.85)
    love.graphics.printf("BALLS LEFT", x0, y0 + 8, w, "center")
    love.graphics.setColor(1, 0.86, 0.4, 1)
    love.graphics.printf(tostring(left), x0, y0 + 32, w, "center")
  end

  local banner = self.banner
  if banner then
    local alpha = math.min(1, banner.timer / 0.5)
    local y = screenH * 0.22
    love.graphics.setFont(bannerFont)
    love.graphics.setColor(0, 0, 0, 0.6 * alpha)
    love.graphics.printf(banner.title, 3, y + 3, screenW, "center")
    love.graphics.setColor(banner.color[1], banner.color[2], banner.color[3], alpha)
    love.graphics.printf(banner.title, 0, y, screenW, "center")
    love.graphics.setFont(hudFont)
    love.graphics.setColor(1, 1, 1, 0.85 * alpha)
    love.graphics.printf(banner.sub, 0, y + 56, screenW, "center")
  end

  love.graphics.setFont(prevFont)
  love.graphics.setColor(1, 1, 1, 1)
end

return ZumaField
