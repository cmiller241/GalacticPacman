-- lua/world/Cannon.lua
--
-- A cannon mounted on a planet's surface, aimed at another planet far
-- across the map. Bob curls into a ball and jumps into its mouth; it
-- swallows him, swings round to aim, charges, and fires him off — no
-- gravity, drag or steering on the way (see Cannon.updateFlight) — and
-- he crashes into the target like a giant ground pound.
--
-- Not straight there, though, unless it's given no corners: the route
-- is a chain of corner points between the cannon and the target, and at
-- each corner a curved metal rail floats in space (a circular arc
-- joining the two straight legs either side of it). He flies straight
-- down each leg, hits the rail, rides round it at full speed, and comes
-- off its end lined up exactly with the next leg — so, barring anything
-- in the way, he always ends up in the target. The rails are solid only
-- to a cannon shot; anything else passes through them.
--
-- Anything in the way stops him (with the same crash), like any other
-- flight; main.lua keeps a lane along every leg clear of random spawns
-- (see worldGen.isInClearLane) so normally nothing is.
--
-- The sequence (self.state):
--   idle       barrel pointing straight out, waiting for him
--   loading    he's swallowed: slides down the barrel to the breech
--   aiming     the barrel swings round to the target
--   charging   it trembles, the mouth glows, an aiming line shows
--   cooldown   fired — the recoil, smoke and sparks play out
--   returning  the barrel swings back to straight out, then it's idle
--
-- While he's in it, player.inCannon is this cannon: he's held at the
-- breech (hidden — see Player:draw), with no movement, gravity or
-- collision of his own (see main.lua). In flight, player.cannonFlight is
-- set instead (see Cannon.updateFlight).

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local GroundPoundBurst = require("lua.effects.GroundPoundBurst")
local CameraShake = require("lua.effects.CameraShake")
local TiledTerrain = require("lua.world.TiledTerrain")
local PinballInterior = require("lua.interiors.PinballInterior")
local Coin = require("lua.entities.Coin")
local constants = require("lua.constants")
local utils = require("lua.utils")

local Cannon = {}
Cannon.__index = Cannon

----------------------------------------------------------------------
-- Tunables
----------------------------------------------------------------------

-- Shape, world units. The barrel pivots PIVOT_HEIGHT above the surface,
-- and reaches BARREL_LENGTH past that to its mouth (BARREL_BACK behind).
local BASE_HALF_WIDTH = 36
local BASE_TOP_HALF_WIDTH = 20
local PIVOT_HEIGHT = 34
local BARREL_LENGTH = 80
local BARREL_BACK = 24
local BARREL_HALF_WIDTH = 15    -- at the breech; it tapers a little toward the mouth
local MUZZLE_HALF_WIDTH = 18    -- the flared lip round the mouth

local CAPTURE_RADIUS = 34       -- the size of the "in here" rings pulsing round the mouth

-- Timings, seconds (game time — V.A.T.S. slow-mo slows them too).
local LOAD_SECONDS = 0.35
local AIM_SECONDS = 1.4
local CHARGE_SECONDS = 0.8
local COOLDOWN_SECONDS = 1.2
local RETURN_SECONDS = 1.0
local RECOIL_SECONDS = 0.45
local RECOIL_DISTANCE = 16

-- The shot, world units per 60fps tick: LAUNCH_SPEED down the straight
-- stretches — right up to slamming into the target (see crashLanding) —
-- but easing down to RAIL_SPEED on a rail, so the curves and loops can
-- be seen, and back up again once he's off it. How quickly, as a rate
-- per second: RAIL_BRAKE when he hits a rail (quick), LINE_BOOST when
-- he leaves one (a bit gentler, so he's seen to pick up speed).
local LAUNCH_SPEED = 110
local RAIL_SPEED = 45
local RAIL_BRAKE = 10
local LINE_BOOST = 4
-- The crash: ground pound bursts (see GroundPoundBurst.lua), a big one
-- and a smaller one inside it, this many times a pound's own size.
local CRASH_BURST_SCALE = 2.4
local CRASH_INNER_BURST_SCALE = 1.2
-- ...and the screen shaking with it (see CameraShake.lua): how far it
-- throws the view (screen pixels), and how long it takes to die away.
local CRASH_SHAKE_STRENGTH = 50
local CRASH_SHAKE_SECONDS = 0.8

local AIM_LINE_LENGTH = 900     -- the dotted aiming line, while charging
local TRAIL_LENGTH = 14         -- positions kept for the streak behind him in flight

-- The rails. TURN_RADIUS: how wide a curve he rides round each corner
-- (world units; tightened automatically where the legs either side are
-- too short for it). The rail itself sits RAIL_GAP outside his path
-- (about his ball's radius — he rolls along its inside), RAIL_WIDTH
-- thick, and runs RAIL_OVERHANG radians past each end of the curve he
-- actually rides, so he's seen meeting it and leaving it.
local TURN_RADIUS = 900
-- Loop-the-loops (a corner's `loops` — see buildRoute): each ring's
-- radius (unless the corner gives its own loopRadius), the straight run
-- between one ring and the next, and between the last ring and the
-- corner's curve.
local LOOP_RADIUS = 550
local LOOP_SPACING = 500
local LOOP_LEAD = 600
-- How far a loop's straight track runs on past where he joins and leaves
-- its ring, either way along the leg — the floor through the bottom of
-- a Sonic loop, so it's clear he comes in along a track, round, and back
-- out along it (see drawRails). Kept under half of LOOP_SPACING plus the
-- ring's radius, so two loops' tails don't meet.
local LOOP_TAIL = 200

-- Bumpers (a corner's `bumper` — see makeBumper): the same red-and-
-- white pinball bumper as the pinball table's (see PinballInterior),
-- out in space and bigger. BUMPER_RADIUS unless the corner gives its own
-- bumperRadius; BALL_CONTACT, how far from its surface his middle is
-- when he hits it (about his ball's radius); BUMPER_SPEED, how fast it
-- throws him off — always the same, slower than full speed, so a run of
-- bumpers close together plays out at a pace that can be followed
-- instead of compounding into a blur (he speeds back up to full speed
-- after, the way he does after a rail).
local BUMPER_RADIUS = 105
local BALL_CONTACT = 24
local BUMPER_SPEED = 75
local BUMPER_SHAKE_STRENGTH = 14
local BUMPER_SHAKE_SECONDS = 0.25
local BUMPER_RING_SECONDS = 0.4  -- the ring flying off it when he hits

-- Coins down the straight stretches between the rails (see placeCoins)
-- — off for now (true puts them back): how far apart, and how far
-- they're kept from a stretch's ends (from the cannon's mouth, from
-- each rail, and from the target's surface).
local ROUTE_COINS = false
local COIN_SPACING = 220
local COIN_END_MARGIN = 160
local COIN_POP_SECONDS = 0.3    -- the little pop where one was collected
local RAIL_GAP = 26
local RAIL_WIDTH = 22
local RAIL_OVERHANG = 0.1
local RAIL_SEGMENTS_PER_RADIAN = 40
local RAIL_GLOW_SECONDS = 1.6   -- how long a rail stays lit up after he's ridden it
local CHEVRON_SPACING = 90      -- world units between the arrows along a rail

local COLOR_RAIL_GLOW = { 0.45, 0.9, 1.0 }

local COLOR_OUTLINE = { 0.06, 0.06, 0.08 }
local COLOR_STEEL_LIGHT = { 0.62, 0.66, 0.74 }
local COLOR_STEEL = { 0.34, 0.37, 0.44 }
local COLOR_STEEL_DARK = { 0.14, 0.15, 0.19 }
local COLOR_BRASS = { 0.82, 0.63, 0.3 }
local COLOR_BRASS_LIGHT = { 1.0, 0.88, 0.55 }
local COLOR_HINT = { 0.45, 0.9, 1.0 }
local COLOR_FIRE = { 1.0, 0.6, 0.2 }

----------------------------------------------------------------------

local function smoothstep(t)
  t = math.max(0, math.min(1, t))
  return t * t * (3 - 2 * t)
end

-- From a toward b by t, the short way round.
local function lerpAngle(a, b, t)
  local d = (b - a + math.pi) % (math.pi * 2) - math.pi
  return a + d * t
end

-- planet: what it's mounted on. mountAngle: where on it (radians, from
-- its centre — -pi/2 is the top). target: the planet it fires at.
-- corners (optional): { {x, y}, ... } — the points the route turns at,
-- in order, each one getting a rail (see buildRoute). None: straight at
-- the target. A corner can also have:
--   loops       that many loop-the-loops, one after another, on the leg
--               leading into it (each its own ring — see buildRoute)
--   radius      its own curve's radius, instead of TURN_RADIUS
--   loopRadius  its loops' radius, instead of LOOP_RADIUS
--   bumper      true: a pinball bumper there instead of a curved rail —
--               he bounces off it (see makeBumper)
--   bumperRadius  its bumper's radius, instead of BUMPER_RADIUS
function Cannon.new(planet, mountAngle, target, corners)
  local self = setmetatable({}, Cannon)
  self.planet = planet
  self.mountAngle = mountAngle
  self.target = target
  self.restAngle = mountAngle       -- the barrel, at rest, points straight out
  self.barrelAngle = mountAngle
  self.state = "idle"
  self.timer = 0
  self.time = 0
  self.firedAt = nil                -- self.time it last fired (for the recoil)
  self.particles = {}
  self.railParticles = {}           -- sparks off the rails, wherever they are
  self:buildRoute(corners or {})

  -- The mouth is a ledge (see placeLedge): a one-way surface across it,
  -- like the Tiled levels' own ledges — he jumps up through it from
  -- below, and lands on it from above. On his feet he just stands on top
  -- of the cannon; as a ball, landing on it is dropping into the hole
  -- (see update). So he has to get above the mouth and come down into
  -- it — it can't swallow him on his way up past it.
  self.ledge = TiledTerrain.newMovingSurface(0, 0, 1, 0)
  self:placeLedge()
  table.insert(state.planetoids, self.ledge)
  return self
end

-- The ledge: across the mouth, laid so its "up" side faces out of the
-- barrel, and LEDGE_HALF_WIDTH either side of the middle — wider than
-- the lip itself, so coming down anywhere on the rim counts (a ball
-- carries a little sideways drift into its jump). Only there while the
-- cannon's waiting for him, barrel at rest; otherwise it's put well out
-- of the way — not left across the mouth for him to "land" on the
-- moment he's fired out of it.
local LEDGE_HALF_WIDTH = MUZZLE_HALF_WIDTH + 20
local LEDGE_PARKED = -100000

function Cannon:placeLedge()
  if self.state ~= "idle" then
    self.ledge:moveTo(LEDGE_PARKED, LEDGE_PARKED, LEDGE_PARKED + 1, LEDGE_PARKED)
    return
  end
  local mx, my = self:muzzle()
  local dx, dy = math.cos(self.barrelAngle), math.sin(self.barrelAngle)
  local tx, ty = -dy, dx
  self.ledge:moveTo(mx - tx * LEDGE_HALF_WIDTH, my - ty * LEDGE_HALF_WIDTH,
    mx + tx * LEDGE_HALF_WIDTH, my + ty * LEDGE_HALF_WIDTH)
end

-- A rail: a circular arc he rides, from `entry` (heading inX, inY),
-- `radius` round, turning toward `sign`'s side (+1 / -1), through
-- `sweep` radians. Its centre is a radius in from the entry, toward the
-- side it turns; phi0 is where the entry sits round that centre. ring:
-- whether it's a whole loop-the-loop (drawn as a complete ring).
local function makeRail(entry, inX, inY, radius, sign, sweep, ring)
  local ccx, ccy = entry[1] + sign * radius * -inY, entry[2] + sign * radius * inX
  local rail = {
    cx = ccx, cy = ccy, radius = radius,
    phi0 = math.atan2(entry[2] - ccy, entry[1] - ccx), sign = sign, sweep = sweep,
    loops = ring and 1 or 0,
    length = radius * sweep,
    entry = entry, inDir = { inX, inY },
    glowAt = nil,             -- the cannon's time he last rode it (it glows for a while)
  }
  local phi = rail.phi0 + sign * sweep
  local c, s = math.cos(phi), math.sin(phi)
  rail.exit = { ccx + c * radius, ccy + s * radius }
  rail.outDir = { -s * sign, c * sign }
  return rail
end

-- A bumper at corner `at`: where he flies in along (inX, inY), it
-- should bounce him straight off along (outX, outY). A round bumper
-- bounces him like a mirror where he hits it — so it's placed with its
-- surface, right at the corner, facing exactly between the way he comes
-- in and the way he should go out (its normal there points along
-- out - in): he meets it with his middle on the corner, and comes off
-- it straight down the next leg. Its centre's behind that point, a
-- radius (and his own) further on.
local function makeBumper(at, inX, inY, outX, outY, radius)
  local nx, ny = outX - inX, outY - inY
  local len = math.sqrt(nx * nx + ny * ny)
  if len < 1e-6 then nx, ny = -inX, -inY else nx, ny = nx / len, ny / len end
  local back = radius + BALL_CONTACT
  return {
    x = at[1] - nx * back, y = at[2] - ny * back, radius = radius,
    at = { at[1], at[2] }, normal = { nx, ny },
    inDir = { inX, inY }, outDir = { outX, outY },
    hitAt = nil,              -- the cannon's time he last hit it
  }
end

-- The route: the corner points (the pivot first, the target's middle
-- last, with `corners` in between) — self.points — and from them, the
-- whole path he flies, in order, as self.pieces: straight lines, and the
-- rails' arcs between them.
--
-- At each corner, a curve: the circular arc of radius TURN_RADIUS that
-- meets the legs either side exactly tangent (a fillet). It starts `t`
-- short of the corner along the leg coming in and ends `t` past it along
-- the leg going out, t = radius * tan(turn / 2); riding it turns him
-- through exactly the angle between the two legs, so he leaves it
-- already headed straight down the next one.
--
-- A corner's `loops`: that many Sonic-style loop-the-loops, one after
-- another, along the leg coming into it, before its curve. Each is its
-- own ring, sitting on the leg (touching its line, on the side the
-- corner turns toward), LOOP_SPACING apart: he rides once right round
-- it — which brings him back to where he joined it, headed the same
-- way — and carries on straight down the leg to the next.
--
-- A corner's `bumper`: instead of a curve, a pinball bumper just past
-- the corner (see makeBumper). The leg runs right up to the corner, he
-- bounces off it there, and the next leg starts from the same point.
--
-- self.pieces[i]  { kind = "line", from, to, dir }, { kind = "arc", rail }
--                 or { kind = "bounce", bumper }
-- self.bumpers    every bumper, for drawing
-- self.rails      every rail (curves and loops), for drawing — each with
--                 its centre cx/cy, radius, where it starts round that
--                 centre (phi0), which way it goes round (sign), how far
--                 (sweep, radians), its length, its ends (entry/exit) and
--                 the directions in and out.
function Cannon:buildRoute(corners)
  local px, py = self:pivot()
  local points = { { px, py } }
  for _, c in ipairs(corners) do
    points[#points + 1] = { c[1], c[2], loops = c.loops, radius = c.radius, loopRadius = c.loopRadius,
      bumper = c.bumper, bumperRadius = c.bumperRadius }
  end
  points[#points + 1] = { self.target.pos.x, self.target.pos.y }
  self.points = points

  local function dirBetween(a, b)
    local dx, dy = b[1] - a[1], b[2] - a[2]
    local len = math.sqrt(dx * dx + dy * dy)
    return dx / len, dy / len, len
  end

  -- The curve at each corner (keyed by its index in points) — or, for a
  -- `bumper` corner, its bumper (see makeBumper).
  local turns, bumpers = {}, {}
  self.bumpers = {}
  for i = 2, #points - 1 do
    local inX, inY, lenIn = dirBetween(points[i - 1], points[i])
    local outX, outY, lenOut = dirBetween(points[i], points[i + 1])
    local turn = math.acos(math.max(-1, math.min(1, inX * outX + inY * outY)))
    local sign = (inX * outY - inY * outX) >= 0 and 1 or -1
    if points[i].bumper then
      bumpers[i] = makeBumper(points[i], inX, inY, outX, outY, points[i].bumperRadius or BUMPER_RADIUS)
      bumpers[i].sign = sign
      self.bumpers[#self.bumpers + 1] = bumpers[i]
    else
      -- (Tighter where the legs either side are too short for the full
      -- radius — each curve may use at most 45% of either leg.)
      local radius = points[i].radius or TURN_RADIUS
      local maxT = 0.45 * math.min(lenIn, lenOut)
      if radius * math.tan(turn / 2) > maxT then radius = maxT / math.tan(turn / 2) end
      local t = radius * math.tan(turn / 2)
      local entry = { points[i][1] - inX * t, points[i][2] - inY * t }
      turns[i] = makeRail(entry, inX, inY, radius, sign, turn, false)
    end
  end

  self.pieces, self.rails = {}, {}
  local cursor = points[1]
  for i = 2, #points do
    local turn, bumper = turns[i], bumpers[i]
    -- (A bumper's leg runs right up to the corner itself — that's where
    -- he meets it.)
    local legEnd = turn and turn.entry or points[i]
    local dx, dy, len = dirBetween(cursor, legEnd)

    -- The loops on this leg, if its corner has any: the last one
    -- LOOP_LEAD clear of the corner's curve, the others back from it.
    local loops = points[i].loops or 0
    if loops > 0 then
      local loopR = points[i].loopRadius or LOOP_RADIUS
      local gap = loopR * 2 + LOOP_SPACING
      local lead = loopR + LOOP_LEAD
      local fits = math.floor((len - lead - loopR - LOOP_LEAD) / gap) + 1
      if fits < loops then
        print(string.format("Cannon.lua: only room for %d of the %d loops on the leg into corner %d — make that leg longer.",
          math.max(0, fits), loops, i - 1))
        loops = math.max(0, fits)
      end
      local side = (turn and turn.sign) or (bumper and bumper.sign) or 1
      for k = 1, loops do
        local back = lead + (loops - k) * gap
        local touch = { legEnd[1] - dx * back, legEnd[2] - dy * back }
        self.pieces[#self.pieces + 1] = { kind = "line", from = cursor, to = touch, dir = { dx, dy } }
        local ring = makeRail(touch, dx, dy, loopR, side, math.pi * 2, true)
        ring.tail = LOOP_TAIL
        self.pieces[#self.pieces + 1] = { kind = "arc", rail = ring }
        self.rails[#self.rails + 1] = ring
        cursor = touch
      end
    end

    self.pieces[#self.pieces + 1] = { kind = "line", from = cursor, to = legEnd, dir = { dx, dy } }
    if turn then
      self.pieces[#self.pieces + 1] = { kind = "arc", rail = turn }
      self.rails[#self.rails + 1] = turn
      cursor = turn.exit
    elseif bumper then
      self.pieces[#self.pieces + 1] = { kind = "bounce", bumper = bumper }
      cursor = points[i]
    end
  end

  self:placeCoins()
end

-- Coins strung down every straight stretch of the route, COIN_SPACING
-- apart — clear of the cannon's mouth, of every rail, and of the
-- target's surface. Drawn like any other coin (Coin.lua), but they're
-- the cannon's own: not tied to a planet, and collected along the whole
-- distance he covers each frame, since at full speed he passes several
-- between one frame and the next (see updateCoins). They all come back
-- each time it fires.
function Cannon:placeCoins()
  self.coins, self.coinPops = {}, {}
  if not ROUTE_COINS then return end
  for i, piece in ipairs(self.pieces) do
    if piece.kind == "line" then
      local len = math.sqrt((piece.to[1] - piece.from[1]) ^ 2 + (piece.to[2] - piece.from[2]) ^ 2)
      local startAt = COIN_END_MARGIN + (i == 1 and BARREL_LENGTH or 0)
      local endAt = len - COIN_END_MARGIN - (i == #self.pieces and self.target.radius or 0)
      if endAt > startAt then
        -- (Centred in the room there is, so the gaps at both ends match.)
        local count = math.floor((endAt - startAt) / COIN_SPACING) + 1
        local first = startAt + ((endAt - startAt) - (count - 1) * COIN_SPACING) / 2
        for k = 0, count - 1 do
          local d = first + k * COIN_SPACING
          local coin = setmetatable({
            pos = Vector2.new(piece.from[1] + piece.dir[1] * d, piece.from[2] + piece.dir[2] * d),
            radius = constants.COIN_RADIUS or 12,
          }, Coin)
          self.coins[#self.coins + 1] = coin
        end
      end
    end
  end
end

-- Once a frame (see update): any coin on the stretch he's covered since
-- last frame (prevPos to pos — a straight line, near enough even round
-- a rail at this speed) and within reach of it, he's collected.
function Cannon:updateCoins(player, dt)
  for i = #self.coinPops, 1, -1 do
    local pop = self.coinPops[i]
    pop.t = pop.t + dt
    if pop.t >= COIN_POP_SECONDS then table.remove(self.coinPops, i) end
  end
  if not player or player.inCannon or player.isDying then return end
  local ax, ay = (player.prevPos or player.pos).x, (player.prevPos or player.pos).y
  local bx, by = player.pos.x, player.pos.y
  local dx, dy = bx - ax, by - ay
  local lenSq = dx * dx + dy * dy
  for _, coin in ipairs(self.coins) do
    if not coin.collected then
      local cx, cy = coin.pos.x, coin.pos.y
      local t = lenSq > 0 and math.max(0, math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / lenSq)) or 0
      local reach = player.radius + coin.radius
      if (cx - (ax + dx * t)) ^ 2 + (cy - (ay + dy * t)) ^ 2 <= reach * reach then
        coin.collected = true
        state.score = (state.score or 0) + 1
        self.coinPops[#self.coinPops + 1] = { x = cx, y = cy, t = 0 }
        if state.audioManager then state.audioManager:playEatDot() end
      end
    end
  end
end

-- A point round rail `rail`, `s` world units along the curve he rides,
-- `out` units further out from its centre than his path; and the
-- direction of travel there.
local function railPoint(rail, s, out)
  local phi = rail.phi0 + rail.sign * s / rail.radius
  local r = rail.radius + (out or 0)
  local c, sn = math.cos(phi), math.sin(phi)
  return rail.cx + c * r, rail.cy + sn * r, -sn * rail.sign, c * rail.sign
end

function Cannon:pivot()
  local c, s = math.cos(self.mountAngle), math.sin(self.mountAngle)
  local d = self.planet.radius + PIVOT_HEIGHT
  return self.planet.pos.x + c * d, self.planet.pos.y + s * d
end

-- Where the barrel has to point: down the route's first leg (at the
-- first rail, or straight at the target's middle if there are none).
function Cannon:aimAngle()
  local dir = self.pieces[1].dir
  return math.atan2(dir[2], dir[1])
end

-- How far the barrel's kicked back right now.
function Cannon:recoilOffset()
  if not self.firedAt then return 0 end
  local t = (self.time - self.firedAt) / RECOIL_SECONDS
  if t >= 1 then return 0 end
  -- Straight back, then easing forward again.
  return RECOIL_DISTANCE * (t < 0.15 and t / 0.15 or (1 - smoothstep((t - 0.15) / 0.85)))
end

function Cannon:muzzle()
  local px, py = self:pivot()
  local d = BARREL_LENGTH - self:recoilOffset()
  return px + math.cos(self.barrelAngle) * d, py + math.sin(self.barrelAngle) * d
end

-- Where he's held while inside.
function Cannon:breech()
  local px, py = self:pivot()
  local d = -BARREL_BACK * 0.3
  return px + math.cos(self.barrelAngle) * d, py + math.sin(self.barrelAngle) * d
end

----------------------------------------------------------------------
-- Particles
----------------------------------------------------------------------

local function addParticle(self, p)
  self.particles[#self.particles + 1] = p
end

function Cannon:puff(x, y, dirAngle, count, speed, kind)
  for _ = 1, count do
    local a = dirAngle + (math.random() - 0.5) * (kind == "spark" and 0.9 or 1.4)
    local v = speed * (0.4 + math.random() * 0.8)
    local life = kind == "spark" and (0.25 + math.random() * 0.35) or (0.7 + math.random() * 0.8)
    addParticle(self, {
      kind = kind, x = x, y = y,
      vx = math.cos(a) * v, vy = math.sin(a) * v,
      life = life, maxLife = life,
      size = kind == "spark" and 1.6 or (8 + math.random() * 10),
    })
  end
end

local function updateParticleList(list, dt)
  for i = #list, 1, -1 do
    local p = list[i]
    p.life = p.life - dt
    if p.life <= 0 then
      table.remove(list, i)
    else
      p.x = p.x + p.vx * dt
      p.y = p.y + p.vy * dt
      local drag = p.kind == "smoke" and 2.2 or 1.2
      p.vx = p.vx * math.exp(-drag * dt)
      p.vy = p.vy * math.exp(-drag * dt)
    end
  end
end

function Cannon:updateParticles(dt)
  updateParticleList(self.particles, dt)
  updateParticleList(self.railParticles, dt)
end

----------------------------------------------------------------------
-- The sequence
----------------------------------------------------------------------

function Cannon:capture(player)
  player.inCannon = self
  player.cannonFlight = nil
  player.pullTarget = nil
  player.onSurface = false
  player.currentPlanet = nil
  player.lastInfluencePlanet = self.planet
  player.isGroundPounding = false
  player.vel.x, player.vel.y = 0, 0
  self.captureFrom = Vector2.new(player.pos.x, player.pos.y)
  self.state, self.timer = "loading", 0
  local mx, my = self:muzzle()
  self:puff(mx, my, self.barrelAngle, 6, 60, "smoke")
  if state.audioManager then state.audioManager:playJumpSmall() end
end

function Cannon:launch(player)
  -- Exactly down the first leg (the barrel's aimed along it — and the
  -- leg starts at the pivot, so the mouth is on it too).
  local dirX, dirY = self.pieces[1].dir[1], self.pieces[1].dir[2]
  local mx, my = self:muzzle()
  player.inCannon = nil
  player.pos.x = mx + dirX * (player.radius + 2)
  player.pos.y = my + dirY * (player.radius + 2)
  -- (Re-anchored, so this frame's swept collision checks don't see him
  -- "travel" all the way from the breech.)
  player.prevPos = player.pos:clone()
  player.vel.x, player.vel.y = dirX * LAUNCH_SPEED, dirY * LAUNCH_SPEED
  -- piece: which piece of the route he's on (see buildRoute); railS: on
  -- a rail, how far round it; speed: how fast he's going right now —
  -- see Cannon.updateFlight.
  player.cannonFlight = { cannon = self, target = self.target, piece = 1, railS = 0, speed = LAUNCH_SPEED, trail = {} }

  -- Every coin down the route back, for this run.
  for _, coin in ipairs(self.coins) do coin.collected = false end

  self.firedAt = self.time
  self.state, self.timer = "cooldown", 0
  self.flashTimer = 0.18
  self:puff(mx, my, self.barrelAngle, 16, 260, "smoke")
  self:puff(mx, my, self.barrelAngle, 26, 900, "spark")
  if state.audioManager then state.audioManager:playBang("large", Vector2.new(mx, my)) end
end

function Cannon:update(player, ts)
  local dt = ts / 60
  self.time = self.time + dt
  self.timer = self.timer + dt
  if self.flashTimer then
    self.flashTimer = self.flashTimer - dt
    if self.flashTimer <= 0 then self.flashTimer = nil end
  end
  self:updateParticles(dt)

  local holding = self.state == "loading" or self.state == "aiming" or self.state == "charging"
  if holding and (not player or player.inCannon ~= self) then
    -- Lost him (he died or respawned in the meantime): back to rest.
    self.state, self.timer = "returning", 0
    self.returnFrom = self.barrelAngle
    holding = false
  end

  if self.state == "idle" then
    -- In he goes once he's come down onto the mouth as a ball (or curled
    -- up while standing on it) — see the ledge in Cannon.new.
    if player and player.isBall and not player.morphState and not player.inCannon
        and player.onSurface and player.currentPlanet == self.ledge
        and not player.isDying and not player.isTeleporting and not player.portalTransit then
      self:capture(player)
      holding = true
    end
  elseif self.state == "loading" then
    if self.timer >= LOAD_SECONDS then self.state, self.timer = "aiming", 0 end
  elseif self.state == "aiming" then
    local t = smoothstep(self.timer / AIM_SECONDS)
    self.barrelAngle = lerpAngle(self.restAngle, self:aimAngle(), t)
    if self.timer >= AIM_SECONDS then
      self.barrelAngle = self:aimAngle()
      self.state, self.timer = "charging", 0
    end
  elseif self.state == "charging" then
    local mx, my = self:muzzle()
    if math.random() < 0.5 then self:puff(mx, my, self.barrelAngle, 1, 120, "spark") end
    if self.timer >= CHARGE_SECONDS then
      self:launch(player)
      holding = false
    end
  elseif self.state == "cooldown" then
    if self.timer >= COOLDOWN_SECONDS then
      self.state, self.timer = "returning", 0
      self.returnFrom = self.barrelAngle
    end
  elseif self.state == "returning" then
    self.barrelAngle = lerpAngle(self.returnFrom or self.restAngle, self.restAngle, smoothstep(self.timer / RETURN_SECONDS))
    if self.timer >= RETURN_SECONDS then
      self.barrelAngle = self.restAngle
      self.state, self.timer = "idle", 0
    end
  end

  self:placeLedge()

  -- Holding him: slid down from where he went in to the breech, and kept
  -- there as the barrel turns.
  if holding and player then
    local bx, by = self:breech()
    if self.state == "loading" and self.captureFrom then
      local t = smoothstep(self.timer / LOAD_SECONDS)
      bx = self.captureFrom.x + (bx - self.captureFrom.x) * t
      by = self.captureFrom.y + (by - self.captureFrom.y) * t
    end
    player.pos.x, player.pos.y = bx, by
    player.prevPos = player.pos:clone()
    player.vel.x, player.vel.y = 0, 0
  end
end

----------------------------------------------------------------------
-- The flight
----------------------------------------------------------------------

-- Slamming into whatever he's just landed on, at the end of a shot: the
-- ground pound's own burst (ring and dust), bigger, with a second one
-- inside it, the screen shaking, and its thud with a bang under it.
local function crashLanding(player)
  local planet = player.currentPlanet
  local ux, uy = 0, -1
  if planet and not planet.isRoundedRect then
    local dx, dy = player.pos.x - planet.pos.x, player.pos.y - planet.pos.y
    local d = math.sqrt(dx * dx + dy * dy)
    if d > 0 then ux, uy = dx / d, dy / d end
  elseif planet and planet.nearestSurfacePoint then
    local n = planet:nearestSurfacePoint(player.pos.x, player.pos.y).normal
    ux, uy = n.x, n.y
  end
  local x, y = player.pos.x - ux * player.radius, player.pos.y - uy * player.radius
  local up = Vector2.new(ux, uy)
  GroundPoundBurst.spawn(x, y, up, CRASH_BURST_SCALE)
  GroundPoundBurst.spawn(x, y, up, CRASH_INNER_BURST_SCALE)
  CameraShake.start(CRASH_SHAKE_STRENGTH, CRASH_SHAKE_SECONDS)
  if state.audioManager then
    state.audioManager:playGroundPound()
    state.audioManager:playBang("medium", Vector2.new(x, y))
  end
end

-- Grinding round a rail: sparks thrown off where he meets it, trailing
-- back behind him and out.
local function railSparks(cannon, rail, s, player, riding)
  local cx, cy, dx, dy = railPoint(rail, s, player.radius)
  for _ = 1, 3 do
    local back = 0.15 + math.random() * 0.35
    local outward = (math.random() - 0.3) * 0.6
    local ox, oy = (cx - rail.cx) / rail.radius, (cy - rail.cy) / rail.radius
    local speed = riding * 60 * back
    local life = 0.2 + math.random() * 0.3
    cannon.railParticles[#cannon.railParticles + 1] = {
      kind = "spark", x = cx, y = cy,
      vx = -dx * speed + ox * speed * outward, vy = -dy * speed + oy * speed * outward,
      life = life, maxLife = life, size = 1.4 + math.random(),
    }
  end
end

-- He's just bounced off `bumper`: it pops and blinks (see drawRails),
-- throws off a ring and a burst of sparks from where he hit it, the
-- screen jolts, and it goes boing.
function Cannon:hitBumper(bumper)
  bumper.hitAt = self.time
  local x, y = bumper.at[1], bumper.at[2]
  local nx, ny = bumper.normal[1], bumper.normal[2]
  local base = math.atan2(ny, nx)
  for _ = 1, 22 do
    local a = base + (math.random() - 0.5) * 2.4
    local speed = 500 + math.random() * 900
    local life = 0.25 + math.random() * 0.35
    self.railParticles[#self.railParticles + 1] = {
      kind = "spark", x = x, y = y, vx = math.cos(a) * speed, vy = math.sin(a) * speed,
      life = life, maxLife = life, size = 1.6 + math.random() * 1.4,
    }
  end
  CameraShake.start(BUMPER_SHAKE_STRENGTH, BUMPER_SHAKE_SECONDS)
  if state.audioManager then state.audioManager:playGoombaStomp() end
end

-- Puts him `s` world units round rail `rail`, moving along it at `speed`.
local function placeOnRail(player, rail, s, speed)
  local x, y, dx, dy = railPoint(rail, s, 0)
  player.pos.x, player.pos.y = x, y
  player.vel.x, player.vel.y = dx * speed, dy * speed
end

-- Once a tick, after the player's own update (which has already moved
-- him on by his velocity):
--   * on a straight leg: once he's reached the rail at its end, he's on
--     it (carrying on round it by however far past its start he got);
--   * on a rail: he's carried on round it (looping the loop, if it's a
--     loop), slowing to RAIL_SPEED — and once he's past its end, off it,
--     straight down the next leg, speeding back up to LAUNCH_SPEED;
--   * on the last leg: straight into the target at full speed, crashing
--     the moment he reaches its surface.
-- Keeps the streak behind him too. The flight's over the moment he
-- lands on something (the target, or anything in the way): he crashes
-- into it (see crashLanding). Also over, quietly, if anything else
-- takes charge of him first: the pull beam, a portal, dying, a teleport.
function Cannon.updateFlight(player, ts)
  local flight = player and player.cannonFlight
  if not flight then return end
  if player.onSurface then
    crashLanding(player)
    player.cannonFlight = nil
    return
  end
  if player.pullTarget or player.portalTransit or player.isDying
      or player.isTeleporting or player.inPinball or player.inCannon then
    player.cannonFlight = nil
    return
  end

  local cannon = flight.cannon
  local piece = cannon.pieces[flight.piece]
  local dt = ts / 60
  if piece.kind == "arc" then
    -- Riding a rail: easing down to RAIL_SPEED.
    local rail = piece.rail
    flight.speed = RAIL_SPEED + (flight.speed - RAIL_SPEED) * math.exp(-RAIL_BRAKE * dt)
    flight.railS = flight.railS + flight.speed * ts
    if flight.railS < rail.length then
      placeOnRail(player, rail, flight.railS, flight.speed)
      railSparks(cannon, rail, flight.railS, player, flight.speed)
      rail.glowAt = cannon.time
    else
      -- Off its end, down the line after it — however far past the end
      -- he got.
      local over = flight.railS - rail.length
      local dir = rail.outDir
      player.pos.x, player.pos.y = rail.exit[1] + dir[1] * over, rail.exit[2] + dir[2] * over
      player.vel.x, player.vel.y = dir[1] * flight.speed, dir[2] * flight.speed
      flight.piece = flight.piece + 1
    end
  else
    -- A straight stretch: back up to LAUNCH_SPEED.
    flight.speed = LAUNCH_SPEED + (flight.speed - LAUNCH_SPEED) * math.exp(-LINE_BOOST * dt)
    player.vel.x, player.vel.y = piece.dir[1] * flight.speed, piece.dir[2] * flight.speed
    local nextPiece = cannon.pieces[flight.piece + 1]
    if nextPiece and nextPiece.kind == "bounce" then
      -- Heading for a bumper: reached it yet? Then off it, straight down
      -- the next leg (however far past it he got), at BUMPER_SPEED.
      local past = (player.pos.x - piece.to[1]) * piece.dir[1] + (player.pos.y - piece.to[2]) * piece.dir[2]
      if past >= 0 then
        local bumper = nextPiece.bumper
        local out = bumper.outDir
        flight.speed = BUMPER_SPEED
        player.pos.x, player.pos.y = bumper.at[1] + out[1] * past, bumper.at[2] + out[2] * past
        player.vel.x, player.vel.y = out[1] * flight.speed, out[2] * flight.speed
        flight.piece = flight.piece + 2
        cannon:hitBumper(bumper)
      end
    elseif nextPiece then
      -- Heading for a rail: reached the end of this line yet?
      local past = (player.pos.x - piece.to[1]) * piece.dir[1] + (player.pos.y - piece.to[2]) * piece.dir[2]
      if past >= 0 then
        local rail = nextPiece.rail
        flight.piece = flight.piece + 1
        flight.railS = past
        placeOnRail(player, rail, past, flight.speed)
        rail.glowAt = cannon.time
        if state.audioManager then state.audioManager:playBang("small", Vector2.new(player.pos.x, player.pos.y)) end
      end
    else
      -- The last leg: into the target, at full speed. Moving this fast,
      -- he can be well inside it by the time he's noticed — so the moment
      -- he's reached its surface he's put exactly on it (before anything's
      -- drawn) and crashes there.
      local t = flight.target
      local dx, dy = player.pos.x - t.pos.x, player.pos.y - t.pos.y
      local dist = math.sqrt(dx * dx + dy * dy)
      if dist <= t.radius + player.radius then
        local ux, uy = dx / math.max(dist, 1e-6), dy / math.max(dist, 1e-6)
        if dist < 1e-6 then ux, uy = -piece.dir[1], -piece.dir[2] end
        player.pos.x = t.pos.x + ux * (t.radius + player.radius)
        player.pos.y = t.pos.y + uy * (t.radius + player.radius)
        player.prevPos = player.pos:clone()
        player.vel.x, player.vel.y = 0, 0
        player.onSurface = true
        player.currentPlanet = t
        player.lastInfluencePlanet = t
        player.angle = math.atan2(uy, ux)
        crashLanding(player)
        player.cannonFlight = nil
        return
      end
    end
  end

  table.insert(flight.trail, 1, { x = player.pos.x, y = player.pos.y })
  if #flight.trail > TRAIL_LENGTH then table.remove(flight.trail) end
end

----------------------------------------------------------------------
-- Drawing the rails
----------------------------------------------------------------------

-- A rail's track, built once: a band round its curve, RAIL_GAP outside
-- his path and RAIL_WIDTH thick, running RAIL_OVERHANG past each end —
-- lit along its inner edge (the face he rolls along), dark along its back.
local function railMesh(rail)
  if rail.mesh then return rail.mesh end
  local inner = rail.radius + RAIL_GAP
  local outer = inner + RAIL_WIDTH
  local a0 = rail.phi0 - rail.sign * RAIL_OVERHANG
  local span = rail.sweep + RAIL_OVERHANG * 2
  if rail.loops > 0 then
    -- A loop-the-loop's rail: the whole ring.
    a0, span = rail.phi0, math.pi * 2
  end
  local steps = math.max(8, math.ceil(span * RAIL_SEGMENTS_PER_RADIAN))
  local l, m, d = COLOR_STEEL_LIGHT, COLOR_STEEL, COLOR_STEEL_DARK
  local verts = {}
  for i = 0, steps do
    local a = a0 + rail.sign * span * i / steps
    local c, s = math.cos(a), math.sin(a)
    verts[#verts + 1] = { rail.cx + c * inner, rail.cy + s * inner, 0, 0, l[1], l[2], l[3], 1 }
    verts[#verts + 1] = { rail.cx + c * (inner + RAIL_WIDTH * 0.45), rail.cy + s * (inner + RAIL_WIDTH * 0.45), 0, 0, m[1], m[2], m[3], 1 }
  end
  local back = {}
  for i = 0, steps do
    local a = a0 + rail.sign * span * i / steps
    local c, s = math.cos(a), math.sin(a)
    back[#back + 1] = { rail.cx + c * (inner + RAIL_WIDTH * 0.45), rail.cy + s * (inner + RAIL_WIDTH * 0.45), 0, 0, m[1], m[2], m[3], 1 }
    back[#back + 1] = { rail.cx + c * outer, rail.cy + s * outer, 0, 0, d[1], d[2], d[3], 1 }
  end
  rail.mesh = love.graphics.newMesh(verts, "strip", "static")
  rail.backMesh = love.graphics.newMesh(back, "strip", "static")
  -- Its outline: the two edges, and across each end.
  local edgeIn, edgeOut = {}, {}
  for i = 0, steps do
    local a = a0 + rail.sign * span * i / steps
    local c, s = math.cos(a), math.sin(a)
    edgeIn[#edgeIn + 1] = rail.cx + c * (inner - 1.5); edgeIn[#edgeIn + 1] = rail.cy + s * (inner - 1.5)
    edgeOut[#edgeOut + 1] = rail.cx + c * (outer + 1.5); edgeOut[#edgeOut + 1] = rail.cy + s * (outer + 1.5)
  end
  rail.edgeIn, rail.edgeOut = edgeIn, edgeOut
  rail.drawStart, rail.drawSpan = a0, span
  return rail.mesh
end

-- One chevron, pointing (dx, dy), centred on (x, y).
local function chevron(x, y, dx, dy, size)
  local nx, ny = -dy, dx
  love.graphics.line(
    x - dx * size * 0.5 + nx * size * 0.6, y - dy * size * 0.5 + ny * size * 0.6,
    x + dx * size * 0.5, y + dy * size * 0.5,
    x - dx * size * 0.5 - nx * size * 0.6, y - dy * size * 0.5 - ny * size * 0.6)
end

-- A loop's tail (see LOOP_TAIL): a straight run of the same track along
-- its leg, through the bottom of its ring — from LOOP_TAIL before where
-- he joins the ring to LOOP_TAIL past where he leaves it (the same point
-- — a lap brings him back there). On the far side of his path from the
-- ring's centre, the same as the ring's own track there, so the two
-- meet: he rolls in along it, up and round the ring, and back out along
-- it. Drawn over the ring, which it crosses.
local function drawLoopTail(cannon, rail, glow)
  local tx, ty = rail.entry[1], rail.entry[2]
  local dx, dy = rail.inDir[1], rail.inDir[2]
  -- Out from the ring's centre, at the touch point.
  local ox, oy = (tx - rail.cx) / rail.radius, (ty - rail.cy) / rail.radius
  local inner, mid, outer = RAIL_GAP, RAIL_GAP + RAIL_WIDTH * 0.45, RAIL_GAP + RAIL_WIDTH
  local ax, ay = tx - dx * rail.tail, ty - dy * rail.tail
  local bx, by = tx + dx * rail.tail, ty + dy * rail.tail
  local function at(x, y, off) return x + ox * off, y + oy * off end

  if not rail.tailMesh then
    local l, m, d = COLOR_STEEL_LIGHT, COLOR_STEEL, COLOR_STEEL_DARK
    local a1x, a1y = at(ax, ay, inner)
    local b1x, b1y = at(bx, by, inner)
    local a2x, a2y = at(ax, ay, mid)
    local b2x, b2y = at(bx, by, mid)
    local a3x, a3y = at(ax, ay, outer)
    local b3x, b3y = at(bx, by, outer)
    rail.tailMesh = love.graphics.newMesh({
      { a1x, a1y, 0, 0, l[1], l[2], l[3], 1 }, { b1x, b1y, 0, 0, l[1], l[2], l[3], 1 },
      { a2x, a2y, 0, 0, m[1], m[2], m[3], 1 }, { b2x, b2y, 0, 0, m[1], m[2], m[3], 1 },
      { a3x, a3y, 0, 0, d[1], d[2], d[3], 1 }, { b3x, b3y, 0, 0, d[1], d[2], d[3], 1 },
    }, "triangles", "static")
    rail.tailMesh:setVertexMap(1, 2, 4, 1, 4, 3, 3, 4, 6, 3, 6, 5)
  end

  -- The track, outlined.
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.setLineWidth(3)
  local x1, y1 = at(ax, ay, inner - 1.5)
  local x2, y2 = at(bx, by, inner - 1.5)
  love.graphics.line(x1, y1, x2, y2)
  x1, y1 = at(ax, ay, outer + 1.5)
  x2, y2 = at(bx, by, outer + 1.5)
  love.graphics.line(x1, y1, x2, y2)
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(rail.tailMesh)

  -- Brass caps and beacons on its two ends, like a rail's.
  for _, e in ipairs({ { ax, ay }, { bx, by } }) do
    local cx0, cy0 = at(e[1], e[2], inner - 2)
    local cx1, cy1 = at(e[1], e[2], outer + 2)
    love.graphics.setColor(COLOR_OUTLINE)
    love.graphics.setLineWidth(9)
    love.graphics.line(cx0, cy0, cx1, cy1)
    love.graphics.setColor(COLOR_BRASS)
    love.graphics.setLineWidth(6)
    love.graphics.line(cx0, cy0, cx1, cy1)
    local bxx, byy = at(e[1], e[2], outer + 9)
    local blink = (math.sin(cannon.time * 5 + e[1] * 0.01) > 0.3) and 1 or 0.25
    love.graphics.setColor(COLOR_OUTLINE)
    love.graphics.circle("fill", bxx, byy, 5.5)
    love.graphics.setBlendMode("add")
    love.graphics.setColor(COLOR_RAIL_GLOW[1], COLOR_RAIL_GLOW[2], COLOR_RAIL_GLOW[3], 0.25 * blink)
    love.graphics.circle("fill", bxx, byy, 14)
    love.graphics.setColor(COLOR_RAIL_GLOW[1], COLOR_RAIL_GLOW[2], COLOR_RAIL_GLOW[3], blink)
    love.graphics.circle("fill", bxx, byy, 3.5)
    love.graphics.setBlendMode("alpha")
  end

  -- Its glow strip and chevrons, lit along with the ring.
  love.graphics.setBlendMode("add")
  local sx1, sy1 = at(ax, ay, inner + RAIL_WIDTH * 0.3)
  local sx2, sy2 = at(bx, by, inner + RAIL_WIDTH * 0.3)
  love.graphics.setColor(COLOR_RAIL_GLOW[1], COLOR_RAIL_GLOW[2], COLOR_RAIL_GLOW[3], 0.12 + 0.35 * glow)
  love.graphics.setLineWidth(9 + 10 * glow)
  love.graphics.line(sx1, sy1, sx2, sy2)
  love.graphics.setColor(COLOR_RAIL_GLOW[1], COLOR_RAIL_GLOW[2], COLOR_RAIL_GLOW[3], 0.45 + 0.55 * glow)
  love.graphics.setLineWidth(2)
  love.graphics.line(sx1, sy1, sx2, sy2)
  love.graphics.setLineWidth(3)
  for s = -rail.tail + CHEVRON_SPACING * 0.5, rail.tail, CHEVRON_SPACING do
    local cx, cy = at(tx + dx * s, ty + dy * s, inner + RAIL_WIDTH * 0.62)
    local pulse = math.max(0, math.sin(s / CHEVRON_SPACING * 1.3 - cannon.time * 6)) ^ 3
    love.graphics.setColor(COLOR_RAIL_GLOW[1], COLOR_RAIL_GLOW[2], COLOR_RAIL_GLOW[3], 0.3 + 0.5 * pulse + 0.5 * glow)
    chevron(cx, cy, dx, dy, 9)
  end
  love.graphics.setBlendMode("alpha")
end

-- The rails, wherever they are on screen, and the sparks off them.
-- (Call every frame, whether or not the cannon itself is on screen.)
function Cannon:drawRails()
  love.graphics.push("all")
  love.graphics.setLineStyle("smooth")
  love.graphics.setLineJoin("bevel")
  for _, rail in ipairs(self.rails) do
    if utils.isOnScreen(rail.cx, rail.cy, rail.radius + RAIL_GAP + RAIL_WIDTH + (rail.tail or 0) + 60, 50) then
      railMesh(rail)
      local glow = rail.glowAt and math.max(0, 1 - (self.time - rail.glowAt) / RAIL_GLOW_SECONDS) or 0
      local inner = rail.radius + RAIL_GAP

      -- The track.
      love.graphics.setColor(COLOR_OUTLINE)
      love.graphics.setLineWidth(3)
      love.graphics.line(rail.edgeIn)
      love.graphics.line(rail.edgeOut)
      love.graphics.setColor(1, 1, 1, 1)
      love.graphics.draw(rail.mesh)
      love.graphics.draw(rail.backMesh)

      -- Its ends: a brass cap, and a beacon blinking on it. (A loop's
      -- ring has none — it gets beacons spaced round it instead.)
      local ends = { rail.drawStart, rail.drawStart + rail.sign * rail.drawSpan }
      if rail.loops > 0 then
        ends = {}
        for k = 0, 5 do ends[#ends + 1] = rail.phi0 + k * math.pi / 3 + math.pi / 6 end
      end
      for _, a in ipairs(ends) do
        local c, s = math.cos(a), math.sin(a)
        local x0, y0 = rail.cx + c * (inner - 2), rail.cy + s * (inner - 2)
        local x1, y1 = rail.cx + c * (inner + RAIL_WIDTH + 2), rail.cy + s * (inner + RAIL_WIDTH + 2)
        love.graphics.setColor(COLOR_OUTLINE)
        love.graphics.setLineWidth(9)
        love.graphics.line(x0, y0, x1, y1)
        love.graphics.setColor(COLOR_BRASS)
        love.graphics.setLineWidth(6)
        love.graphics.line(x0, y0, x1, y1)
        local bx, by = rail.cx + c * (inner + RAIL_WIDTH + 9), rail.cy + s * (inner + RAIL_WIDTH + 9)
        local blink = (math.sin(self.time * 5 + a * 3) > 0.3) and 1 or 0.25
        love.graphics.setColor(COLOR_OUTLINE)
        love.graphics.circle("fill", bx, by, 5.5)
        love.graphics.setBlendMode("add")
        love.graphics.setColor(COLOR_RAIL_GLOW[1], COLOR_RAIL_GLOW[2], COLOR_RAIL_GLOW[3], 0.25 * blink)
        love.graphics.circle("fill", bx, by, 14)
        love.graphics.setColor(COLOR_RAIL_GLOW[1], COLOR_RAIL_GLOW[2], COLOR_RAIL_GLOW[3], blink)
        love.graphics.circle("fill", bx, by, 3.5)
        love.graphics.setBlendMode("alpha")
      end

      -- The glow strip along it, and chevrons pointing the way round —
      -- a pulse running along them, and everything flaring up while
      -- (and just after) he rides it.
      love.graphics.setBlendMode("add")
      local stripR = inner + RAIL_WIDTH * 0.3
      local points = {}
      local steps = math.max(8, math.ceil(rail.drawSpan * RAIL_SEGMENTS_PER_RADIAN))
      for i = 0, steps do
        local a = rail.drawStart + rail.sign * rail.drawSpan * i / steps
        points[#points + 1] = rail.cx + math.cos(a) * stripR
        points[#points + 1] = rail.cy + math.sin(a) * stripR
      end
      love.graphics.setColor(COLOR_RAIL_GLOW[1], COLOR_RAIL_GLOW[2], COLOR_RAIL_GLOW[3], 0.12 + 0.35 * glow)
      love.graphics.setLineWidth(9 + 10 * glow)
      love.graphics.line(points)
      love.graphics.setColor(COLOR_RAIL_GLOW[1], COLOR_RAIL_GLOW[2], COLOR_RAIL_GLOW[3], 0.45 + 0.55 * glow)
      love.graphics.setLineWidth(2)
      love.graphics.line(points)

      love.graphics.setLineWidth(3)
      -- (Round a loop's ring just once — further laps would only stack
      -- chevrons on top of the first lap's.)
      local chevronEnd = rail.loops > 0 and (rail.radius * math.pi * 2 - CHEVRON_SPACING * 0.5) or rail.length
      for s = CHEVRON_SPACING * 0.5, chevronEnd, CHEVRON_SPACING do
        local x, y, dx, dy = railPoint(rail, s, RAIL_GAP + RAIL_WIDTH * 0.62)
        local pulse = math.max(0, math.sin(s / CHEVRON_SPACING * 1.3 - self.time * 6)) ^ 3
        love.graphics.setColor(COLOR_RAIL_GLOW[1], COLOR_RAIL_GLOW[2], COLOR_RAIL_GLOW[3], 0.3 + 0.5 * pulse + 0.5 * glow)
        chevron(x, y, dx, dy, 9)
      end
      love.graphics.setBlendMode("alpha")

      if rail.tail then drawLoopTail(self, rail, glow) end
    end
  end

  -- The bumpers: the pinball table's own (see PinballInterior.drawBumper)
  -- — popping and blinking after a hit — over a soft halo so they stand
  -- out in open space, and a ring flying off one he's just hit.
  for _, b in ipairs(self.bumpers) do
    if utils.isOnScreen(b.x, b.y, b.radius * 3, 50) then
      local since = b.hitAt and (self.time - b.hitAt) or nil
      love.graphics.setBlendMode("add")
      local pulse = 0.5 + 0.5 * math.sin(self.time * 3 + b.x * 0.01)
      for i = 3, 1, -1 do
        love.graphics.setColor(1, 0.35, 0.4, (0.05 + 0.03 * pulse) * (since and since < 0.3 and 3 or 1))
        love.graphics.circle("fill", b.x, b.y, b.radius * (1 + i * 0.22))
      end
      if since and since < BUMPER_RING_SECONDS then
        local k = since / BUMPER_RING_SECONDS
        love.graphics.setColor(1, 0.9, 0.6, 0.9 * (1 - k))
        love.graphics.setLineWidth(6 * (1 - k) + 1)
        love.graphics.circle("line", b.x, b.y, b.radius * (1.05 + k * 1.2))
      end
      love.graphics.setBlendMode("alpha")
      PinballInterior.drawBumper(b.x, b.y, b.radius, since and since * 60 or nil)
    end
  end

  -- The coins down the route, and the pops where he's just collected some.
  for _, coin in ipairs(self.coins) do
    if not coin.collected and utils.isOnScreen(coin.pos.x, coin.pos.y, coin.radius, 20) then
      coin:draw()
    end
  end
  love.graphics.setBlendMode("add")
  for _, pop in ipairs(self.coinPops) do
    local k = pop.t / COIN_POP_SECONDS
    love.graphics.setColor(1, 0.9, 0.4, 0.8 * (1 - k))
    love.graphics.setLineWidth(2.5 * (1 - k) + 0.5)
    love.graphics.circle("line", pop.x, pop.y, 10 + 26 * k)
  end
  love.graphics.setBlendMode("alpha")

  -- Sparks off the rails.
  love.graphics.setBlendMode("add")
  for _, p in ipairs(self.railParticles) do
    local k = p.life / p.maxLife
    love.graphics.setColor(1, 0.75 + 0.2 * k, 0.35, k)
    love.graphics.setLineWidth(p.size)
    love.graphics.line(p.x, p.y, p.x - p.vx * 0.02, p.y - p.vy * 0.02)
  end
  love.graphics.pop()
end

-- The streak behind him in flight. Call before drawing him.
function Cannon.drawFlightTrail(player)
  local flight = player and player.cannonFlight
  if not flight or #flight.trail < 2 then return end
  love.graphics.push("all")
  love.graphics.setBlendMode("add")
  love.graphics.setLineStyle("smooth")
  local n = #flight.trail
  for i = 1, n - 1 do
    local a, b = flight.trail[i], flight.trail[i + 1]
    local k = 1 - (i - 1) / (n - 1)
    love.graphics.setColor(COLOR_FIRE[1], COLOR_FIRE[2], COLOR_FIRE[3], 0.35 * k)
    love.graphics.setLineWidth(player.radius * 1.6 * k + 2)
    love.graphics.line(a.x, a.y, b.x, b.y)
    love.graphics.setColor(1, 0.95, 0.8, 0.6 * k)
    love.graphics.setLineWidth(player.radius * 0.5 * k + 1)
    love.graphics.line(a.x, a.y, b.x, b.y)
  end
  love.graphics.pop()
end

----------------------------------------------------------------------
-- Drawing
----------------------------------------------------------------------

-- Built once (they never change): the barrel and base's shaded faces —
-- steel lit along one side (local -y), dark along the other.
local barrelMeshes, baseMesh = nil, nil

local function makeQuadMesh(x0, h0, x1, h1, top, mid, bottom)
  local verts = {
    { x0, -h0, 0, 0, top[1], top[2], top[3], 1 },
    { x1, -h1, 0, 0, top[1], top[2], top[3], 1 },
    { x1, 0, 0, 0, mid[1], mid[2], mid[3], 1 },
    { x0, 0, 0, 0, mid[1], mid[2], mid[3], 1 },
    { x0, 0, 0, 0, mid[1], mid[2], mid[3], 1 },
    { x1, 0, 0, 0, mid[1], mid[2], mid[3], 1 },
    { x1, h1, 0, 0, bottom[1], bottom[2], bottom[3], 1 },
    { x0, h0, 0, 0, bottom[1], bottom[2], bottom[3], 1 },
  }
  local mesh = love.graphics.newMesh(verts, "triangles", "static")
  mesh:setVertexMap(1, 2, 3, 1, 3, 4, 5, 6, 7, 5, 7, 8)
  return mesh
end

local function getMeshes()
  if barrelMeshes then return barrelMeshes, baseMesh end
  local tipHalf = BARREL_HALF_WIDTH * 0.8
  barrelMeshes = {
    body = makeQuadMesh(-BARREL_BACK + 8, BARREL_HALF_WIDTH, BARREL_LENGTH - 10, tipHalf,
      COLOR_STEEL_LIGHT, COLOR_STEEL, COLOR_STEEL_DARK),
    lip = makeQuadMesh(BARREL_LENGTH - 10, MUZZLE_HALF_WIDTH, BARREL_LENGTH, MUZZLE_HALF_WIDTH,
      COLOR_STEEL_LIGHT, COLOR_STEEL, COLOR_STEEL_DARK),
  }
  -- The base: a trapezoid from the surface up to the pivot, lit from its
  -- top. Drawn with local -y pointing away from the planet.
  local t, m, d = COLOR_STEEL_LIGHT, COLOR_STEEL, COLOR_STEEL_DARK
  baseMesh = love.graphics.newMesh({
    { -BASE_TOP_HALF_WIDTH, -PIVOT_HEIGHT, 0, 0, t[1], t[2], t[3], 1 },
    { BASE_TOP_HALF_WIDTH, -PIVOT_HEIGHT, 0, 0, m[1], m[2], m[3], 1 },
    { BASE_HALF_WIDTH, 4, 0, 0, d[1], d[2], d[3], 1 },
    { -BASE_HALF_WIDTH, 4, 0, 0, m[1], m[2], m[3], 1 },
  }, "fan", "static")
  return barrelMeshes, baseMesh
end

-- Half the barrel's width at x along it (for the bands round it).
local function halfWidthAt(x)
  local t = (x - (-BARREL_BACK + 8)) / ((BARREL_LENGTH - 10) - (-BARREL_BACK + 8))
  return BARREL_HALF_WIDTH + (BARREL_HALF_WIDTH * 0.8 - BARREL_HALF_WIDTH) * t
end

function Cannon:drawBase()
  local _, base = getMeshes()
  local c, s = math.cos(self.mountAngle), math.sin(self.mountAngle)
  local sx, sy = self.planet.pos.x + c * self.planet.radius, self.planet.pos.y + s * self.planet.radius
  love.graphics.push()
  love.graphics.translate(sx, sy)
  love.graphics.rotate(self.mountAngle + math.pi / 2)   -- local -y: away from the planet
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.polygon("fill", -BASE_TOP_HALF_WIDTH - 2, -PIVOT_HEIGHT - 2, BASE_TOP_HALF_WIDTH + 2, -PIVOT_HEIGHT - 2,
    BASE_HALF_WIDTH + 2.5, 6, -BASE_HALF_WIDTH - 2.5, 6)
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(base)
  -- A brass band, and bolts along the foot.
  love.graphics.setColor(COLOR_BRASS)
  love.graphics.rectangle("fill", -BASE_TOP_HALF_WIDTH - 3, -PIVOT_HEIGHT * 0.55, (BASE_TOP_HALF_WIDTH + 3) * 2, 5)
  love.graphics.setColor(COLOR_BRASS_LIGHT)
  love.graphics.rectangle("fill", -BASE_TOP_HALF_WIDTH - 3, -PIVOT_HEIGHT * 0.55, (BASE_TOP_HALF_WIDTH + 3) * 2, 1.5)
  for i = -2, 2 do
    love.graphics.setColor(COLOR_OUTLINE)
    love.graphics.circle("fill", i * BASE_HALF_WIDTH * 0.4, -1, 2.6)
    love.graphics.setColor(COLOR_STEEL_LIGHT)
    love.graphics.circle("fill", i * BASE_HALF_WIDTH * 0.4 - 0.5, -1.5, 1.6)
  end
  love.graphics.pop()
end

function Cannon:drawBarrel()
  local meshes = getMeshes()
  local px, py = self:pivot()
  -- Trembling while it charges.
  if self.state == "charging" then
    local k = self.timer / CHARGE_SECONDS
    px = px + (math.random() - 0.5) * 2.5 * k
    py = py + (math.random() - 0.5) * 2.5 * k
  end
  love.graphics.push()
  love.graphics.translate(px, py)
  love.graphics.rotate(self.barrelAngle)
  love.graphics.translate(-self:recoilOffset(), 0)

  -- Outline, then the steel.
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.circle("fill", -BARREL_BACK + 9, 0, BARREL_HALF_WIDTH + 2.5)
  love.graphics.polygon("fill",
    -BARREL_BACK + 8, -BARREL_HALF_WIDTH - 2.5, BARREL_LENGTH - 10, -BARREL_HALF_WIDTH * 0.8 - 2.5,
    BARREL_LENGTH - 10, BARREL_HALF_WIDTH * 0.8 + 2.5, -BARREL_BACK + 8, BARREL_HALF_WIDTH + 2.5)
  love.graphics.rectangle("fill", BARREL_LENGTH - 12, -MUZZLE_HALF_WIDTH - 2.5, 14.5, (MUZZLE_HALF_WIDTH + 2.5) * 2, 3, 3)
  love.graphics.setColor(COLOR_STEEL)
  love.graphics.circle("fill", -BARREL_BACK + 9, 0, BARREL_HALF_WIDTH)
  love.graphics.setColor(COLOR_STEEL_LIGHT)
  love.graphics.circle("fill", -BARREL_BACK + 7, -4, BARREL_HALF_WIDTH * 0.45)
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(meshes.body)
  love.graphics.draw(meshes.lip)

  -- Brass bands.
  for _, bx in ipairs({ 6, 34 }) do
    local h = halfWidthAt(bx) + 1.5
    love.graphics.setColor(COLOR_BRASS)
    love.graphics.rectangle("fill", bx, -h, 6, h * 2)
    love.graphics.setColor(COLOR_BRASS_LIGHT)
    love.graphics.rectangle("fill", bx, -h, 6, 2)
    love.graphics.setColor(COLOR_OUTLINE[1], COLOR_OUTLINE[2], COLOR_OUTLINE[3], 0.6)
    love.graphics.rectangle("line", bx, -h, 6, h * 2)
  end

  -- The mouth: a dark opening in the lip — glowing hot while it charges.
  love.graphics.setColor(0.03, 0.03, 0.04, 1)
  love.graphics.ellipse("fill", BARREL_LENGTH - 1, 0, 4, MUZZLE_HALF_WIDTH - 4)
  if self.state == "charging" then
    local k = smoothstep(self.timer / CHARGE_SECONDS)
    love.graphics.setBlendMode("add")
    love.graphics.setColor(COLOR_FIRE[1], COLOR_FIRE[2], COLOR_FIRE[3], 0.9 * k)
    love.graphics.ellipse("fill", BARREL_LENGTH - 1, 0, 4, (MUZZLE_HALF_WIDTH - 4) * k)
    love.graphics.setBlendMode("alpha")
  end
  love.graphics.pop()

  -- The pivot hub over it: a bolted cap.
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.circle("fill", px, py, 11.5)
  love.graphics.setColor(COLOR_BRASS)
  love.graphics.circle("fill", px, py, 9)
  love.graphics.setColor(COLOR_BRASS_LIGHT)
  love.graphics.circle("fill", px - 2, py - 2, 4)
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.circle("fill", px, py, 2)
end

function Cannon:draw()
  love.graphics.push("all")
  love.graphics.setLineStyle("smooth")

  -- Smoke behind it.
  for _, p in ipairs(self.particles) do
    if p.kind == "smoke" then
      local k = p.life / p.maxLife
      local r = p.size * (1 + (1 - k) * 2.5)
      love.graphics.setColor(0.55, 0.55, 0.58, 0.45 * k)
      love.graphics.circle("fill", p.x, p.y, r)
    end
  end

  self:drawBase()
  self:drawBarrel()

  local mx, my = self:muzzle()

  -- Waiting for him: rings pulsing round the mouth, brighter once he's
  -- a ball and close — "in here".
  local player = state.player
  if self.state == "idle" and player and not player.inCannon then
    local dx, dy = player.pos.x - mx, player.pos.y - my
    local near = math.max(0, 1 - math.sqrt(dx * dx + dy * dy) / 500)
    if near > 0 then
      local strength = near * (player.isBall and 1 or 0.45)
      love.graphics.setBlendMode("add")
      love.graphics.setLineWidth(2)
      for i = 0, 1 do
        local phase = (self.time * 0.9 + i * 0.5) % 1
        love.graphics.setColor(COLOR_HINT[1], COLOR_HINT[2], COLOR_HINT[3], strength * 0.7 * (1 - phase))
        love.graphics.circle("line", mx, my, CAPTURE_RADIUS * (0.6 + phase * 0.9))
      end
      love.graphics.setBlendMode("alpha")
    end
  end

  -- Charging: the dotted line it's aimed along, marching outward.
  if self.state == "charging" then
    local k = smoothstep(self.timer / (CHARGE_SECONDS * 0.4))
    local c, s = math.cos(self.barrelAngle), math.sin(self.barrelAngle)
    love.graphics.setBlendMode("add")
    local spacing = 30
    local offset = (self.time * 160) % spacing
    for d = offset + 20, AIM_LINE_LENGTH, spacing do
      local a = k * 0.8 * (1 - d / AIM_LINE_LENGTH)
      love.graphics.setColor(COLOR_FIRE[1], COLOR_FIRE[2], COLOR_FIRE[3], a)
      love.graphics.circle("fill", mx + c * d, my + s * d, 2.6)
    end
    -- And the mouth's glow.
    local g = smoothstep(self.timer / CHARGE_SECONDS)
    for i = 3, 1, -1 do
      love.graphics.setColor(COLOR_FIRE[1], COLOR_FIRE[2], COLOR_FIRE[3], 0.12 * g)
      love.graphics.circle("fill", mx, my, 10 + i * 9 * g)
    end
    love.graphics.setBlendMode("alpha")
  end

  -- Sparks, and the muzzle flash, over it.
  love.graphics.setBlendMode("add")
  for _, p in ipairs(self.particles) do
    if p.kind == "spark" then
      local k = p.life / p.maxLife
      love.graphics.setColor(1, 0.75 + 0.2 * k, 0.35, k)
      love.graphics.setLineWidth(p.size)
      love.graphics.line(p.x, p.y, p.x - p.vx * 0.025, p.y - p.vy * 0.025)
    end
  end
  if self.flashTimer then
    local k = self.flashTimer / 0.18
    local c, s = math.cos(self.barrelAngle), math.sin(self.barrelAngle)
    for i = 4, 1, -1 do
      love.graphics.setColor(1, 0.85, 0.5, 0.18 * k)
      love.graphics.circle("fill", mx + c * 20, my + s * 20, 18 * i * (0.6 + 0.4 * k))
    end
    love.graphics.setColor(1, 1, 0.9, k)
    love.graphics.circle("fill", mx + c * 8, my + s * 8, 16 * k)
  end
  love.graphics.pop()
end

return Cannon
