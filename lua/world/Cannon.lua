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
local Planetoid = require("lua.world.Planetoid")
local Explosion = require("lua.entities.Explosion")
local Asteroid = require("lua.entities.Asteroid")
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
-- (The barrel's a little wider than he is as a ball — 30 * 0.792, about
-- 24 — so he can believably go in it.)
local BASE_HALF_WIDTH = 50
local BASE_TOP_HALF_WIDTH = 30
local PIVOT_HEIGHT = 42
local BARREL_LENGTH = 100
local BARREL_BACK = 32
local BARREL_HALF_WIDTH = 26
local MUZZLE_HALF_WIDTH = 30    -- the flared lip round the mouth

local CAPTURE_RADIUS = 48       -- the size of the "in here" rings pulsing round the mouth

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
-- How fast he's flung out of a corkscrew's last ring (a corner's `fling`
-- — see buildTrack), world units/frame: well past LAUNCH_SPEED, easing
-- back down to it after.
local CORKSCREW_FLING_SPEED = 170
local FLING_EASE = 0.9 -- how quickly he eases back down to LAUNCH_SPEED after (lower, the longer it lasts)

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

-- An ordinary planetoid or asteroid in the shot's way is blown apart
-- before he hits it (see clearTheWay) — with this jolt of the screen.
local OBSTACLE_SHAKE_STRENGTH = 22
local OBSTACLE_SHAKE_SECONDS = 0.35

-- Hit-stop: when he hits a bumper, the whole game all but freezes for
-- an instant (see Cannon.timeFactor, which main.lua scales the frame's
-- time by) — the trick fighting and pinball games use to make an impact
-- land. Real time; the screen still shakes through it.
local HIT_STOP_SECONDS = 0.06
local HIT_STOP_TIME_FACTOR = 0.03

-- A corner's `gauntlet` (see buildRoute): the straight into it lined
-- with asteroids for him to smash through, one after another (see
-- spawnGauntlet) — this far apart, this far clear of the straight's
-- ends, this big, and nudged at most this far (a fraction of each one's
-- radius) either side of his line, so every one's still in his way.
local GAUNTLET_SPACING = 600
local GAUNTLET_END_MARGIN = 700
local GAUNTLET_MIN_RADIUS = 22
local GAUNTLET_MAX_RADIUS = 46
local GAUNTLET_SIDE_NUDGE = 0.5

-- Speed lines (see Cannon.drawSpeedLines): streaks rushing past the
-- edges of the screen, opposite to the way he's flying — strongest at
-- full speed, gone by the time he's slowed to a rail's pace.
local SPEED_LINES_PER_SECOND = 70
local SPEED_LINE_SECONDS = 0.35
local SPEED_LINE_ALPHA = 0.35

-- Afterimages (see Cannon.drawFlightTrail): faint copies of the ball
-- left along his path, fading out.
local AFTERIMAGE_COUNT = 5
local AFTERIMAGE_SPACING = 70    -- world units along his path between one and the next
local AFTERIMAGE_ALPHA = 0.28    -- the nearest one; each further one fainter

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

-- Exits off a track (see Cannon.newExit): a pinball flipper across the
-- straight, raised for as long as the jump button's held. Holding it
-- as he reaches it, he bounces off it down the exit; not holding it,
-- it's lying out of his way and he carries straight on.
local FLIPPER_LENGTH = 560
local FLIPPER_THICKNESS = 46      -- at the pivot (the tip's narrower)
local FLIPPER_CONTACT_AT = 0.45   -- how far along it (from the pivot) he hits it
local FLIPPER_CONTACT_RADIUS = 24 -- his own radius, as a ball
local FLIPPER_REST_ANGLE = 0.45   -- at rest: radians off the straight, pointing on ahead and away from his path
local FLIPPER_SWING_RATE = 22     -- how fast it swings (higher, snappier)
local FLIPPER_MIN_SPEED = 90      -- he leaves it at least this fast

-- Until when (real time) the hit-stop holds — see HIT_STOP_SECONDS.
local hitStopUntil = 0
local COLOR_FLIPPER = { 0.95, 0.35, 0.4 }
local COLOR_FLIPPER_LIGHT = { 1.0, 0.75, 0.75 }

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
--   gauntlet    true: the straight into it lined with asteroids he
--               smashes through, one after another (see spawnGauntlet)
-- merge (optional, instead of a target — pass nil for target): the
-- route ends by merging onto a track partway along one of its straights,
-- instead of at a planet (see Cannon.trackMergeAt, which works it out,
-- and buildRoute). merge.radius optionally sets the on-ramp curve's own.
function Cannon.new(planet, mountAngle, target, corners, merge)
  local self = setmetatable({}, Cannon)
  self.planet = planet
  self.mountAngle = mountAngle
  self.target = target
  self.merge = merge
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

-- A route's corner, copied with everything a corner can have (see
-- Cannon.new for what each means).
local function copyCorner(c)
  return { c[1], c[2], loops = c.loops, radius = c.radius, loopRadius = c.loopRadius,
    loopGap = c.loopGap, fling = c.fling, loopsFirst = c.loopsFirst,
    bumper = c.bumper, bumperRadius = c.bumperRadius, gauntlet = c.gauntlet }
end

local function dirBetween(a, b)
  local dx, dy = b[1] - a[1], b[2] - a[2]
  local len = math.sqrt(dx * dx + dy * dy)
  return dx / len, dy / len, len
end

-- A track: from a list of points, the whole path he flies, in order, as
-- owner.pieces — straight lines, and the rails' arcs (or bumpers'
-- bounces) between them — plus owner.rails and owner.bumpers, for
-- drawing.
--
-- Open (closed = false): points[1] is where it starts (a cannon's pivot)
-- and points[#points] where it ends (a target planet's middle); every
-- point in between is a corner. Closed (closed = true): every point is a
-- corner, the last joined back round to the first — a loop with no end
-- (see Cannon.newTrack); its pieces start at the end of the first
-- corner's curve, and the last of them brings him back there.
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
-- owner.pieces[i]  { kind = "line", from, to, dir }, { kind = "arc", rail }
--                  or { kind = "bounce", bumper }
-- owner.bumpers    every bumper
-- owner.rails      every rail (curves and loops) — each with its centre
--                  cx/cy, radius, where it starts round that centre
--                  (phi0), which way it goes round (sign), how far (sweep,
--                  radians), its length, its ends (entry/exit) and the
--                  directions in and out.
local function buildTrack(owner, points, closed)
  local n = #points
  local function before(i) return (closed and i == 1) and points[n] or points[i - 1] end
  local function after(i) return (closed and i == n) and points[1] or points[i + 1] end

  -- The curve at each corner (keyed by its index in points) — or, for a
  -- `bumper` corner, its bumper (see makeBumper).
  local turns, bumpers = {}, {}
  owner.bumpers = {}
  for i = closed and 1 or 2, closed and n or n - 1 do
    local inX, inY, lenIn = dirBetween(before(i), points[i])
    local outX, outY, lenOut = dirBetween(points[i], after(i))
    local turn = math.acos(math.max(-1, math.min(1, inX * outX + inY * outY)))
    local sign = (inX * outY - inY * outX) >= 0 and 1 or -1
    if points[i].bumper then
      bumpers[i] = makeBumper(points[i], inX, inY, outX, outY, points[i].bumperRadius or BUMPER_RADIUS)
      bumpers[i].sign = sign
      owner.bumpers[#owner.bumpers + 1] = bumpers[i]
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

  -- The legs, in the order he flies them: into every corner from the
  -- second on (and, open, into the end) — and, closed, round into the
  -- first corner again.
  local order = {}
  for i = 2, n do order[#order + 1] = i end
  if closed then order[#order + 1] = 1 end
  local cursor = points[1]
  if closed then cursor = turns[1] and turns[1].exit or points[1] end

  owner.pieces, owner.rails = {}, {}
  for _, i in ipairs(order) do
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
      -- (From one ring's touch point to the next: well apart, unless the
      -- corner gives its own loopGap — a corkscrew's, much less than a
      -- ring's width, so they overlap like a stretched-out spring.)
      local gap = points[i].loopGap or (loopR * 2 + LOOP_SPACING)
      local lead = loopR + LOOP_LEAD
      local fits = math.floor((len - lead - loopR - LOOP_LEAD) / gap) + 1
      if fits < loops then
        print(string.format("Cannon.lua: only room for %d of the %d loops on the leg into corner %d — make that leg longer.",
          math.max(0, fits), loops, i))
        loops = math.max(0, fits)
      end
      local side = (turn and turn.sign) or (bumper and bumper.sign) or 1
      -- (Where the first ring goes: the end of the leg, unless the corner
      -- has loopsFirst — then the start, so the rest of the leg's a long
      -- straight run after them, as a corkscrew's fling needs.)
      local legStart = cursor
      for k = 1, loops do
        local touch
        if points[i].loopsFirst then
          local ahead = lead + (k - 1) * gap
          touch = { legStart[1] + dx * ahead, legStart[2] + dy * ahead }
        else
          local back = lead + (loops - k) * gap
          touch = { legEnd[1] - dx * back, legEnd[2] - dy * back }
        end
        owner.pieces[#owner.pieces + 1] = { kind = "line", from = cursor, to = touch, dir = { dx, dy } }
        local ring = makeRail(touch, dx, dy, loopR, side, math.pi * 2, true)
        ring.tail = LOOP_TAIL
        -- (A corkscrew's last ring flings him out of it — see
        -- Cannon.updateFlight.)
        if points[i].fling and k == loops then ring.fling = true end
        owner.pieces[#owner.pieces + 1] = { kind = "arc", rail = ring }
        owner.rails[#owner.rails + 1] = ring
        cursor = touch
      end
    end

    -- (The leg's last straight — after any loops on it — is the one a
    -- `gauntlet` corner lines with asteroids.)
    owner.pieces[#owner.pieces + 1] = { kind = "line", from = cursor, to = legEnd, dir = { dx, dy },
      gauntlet = points[i].gauntlet }
    if turn then
      owner.pieces[#owner.pieces + 1] = { kind = "arc", rail = turn }
      owner.rails[#owner.rails + 1] = turn
      cursor = turn.exit
    elseif bumper then
      owner.pieces[#owner.pieces + 1] = { kind = "bounce", bumper = bumper }
      cursor = points[i]
    end
  end
end

-- A cannon's route: from its pivot, round `corners`, to either its
-- target planet's middle (where he crashes into it) — or, merging onto a
-- track (self.merge — see Cannon.trackMergeAt), to a point on one of
-- that track's straights, where one last curve (the on-ramp: just
-- another rail, its "out" being the straight's own direction) lines him
-- up exactly with the straight. From the end of that curve on he's on
-- the track itself (see Cannon.updateFlight), so the route stops there.
function Cannon:buildRoute(corners)
  local px, py = self:pivot()
  local points = { { px, py } }
  for _, c in ipairs(corners) do points[#points + 1] = copyCorner(c) end
  local m = self.merge
  if m then
    points[#points + 1] = { m.at[1], m.at[2], radius = m.radius }
    points[#points + 1] = { m.at[1] + m.dir[1] * m.ahead, m.at[2] + m.dir[2] * m.ahead }
  else
    points[#points + 1] = { self.target.pos.x, self.target.pos.y }
  end
  buildTrack(self, points, false)
  if m then
    -- (The straight past the on-ramp's curve is the track's own.)
    table.remove(self.pieces)
    table.remove(points)
  end
  self.points = points
  self:placeCoins()
end

-- A track that's a loop with no end — the galactic expressway (see
-- main.lua): `corners` all the way round (each can be anything a
-- cannon's route corner can be: a rail, with loops on the leg into it,
-- a bumper, a gauntlet), the last joined back to the first. Nothing
-- fires him onto it itself; cannons merge onto it (see trackMergeAt),
-- and once he's on, he goes round and round (see Cannon.updateFlight).
-- It's drawn, updated and kept clear like a cannon's route — it just has
-- no cannon (self.isTrack) and no target.
function Cannon.newTrack(corners)
  local self = setmetatable({}, Cannon)
  self.isTrack, self.closed = true, true
  self.time = 0
  self.particles = {}
  self.railParticles = {}
  self.coins, self.coinPops = {}, {}
  local points = {}
  for _, c in ipairs(corners) do points[#points + 1] = copyCorner(c) end
  self.points = points
  buildTrack(self, points, true)
  return self
end

-- Where a cannon's route can merge onto `track` near (x, y): the
-- nearest point on any of its straights, that straight's direction and
-- piece index, and how far on along it the straight still runs — the
-- `merge` to give Cannon.new. (Best somewhere along the middle of a long
-- straight, so there's room for the on-ramp's curve to finish on it.)
function Cannon.trackMergeAt(track, x, y)
  local best
  for i, piece in ipairs(track.pieces) do
    if piece.kind == "line" then
      local fx, fy, tx, ty = piece.from[1], piece.from[2], piece.to[1], piece.to[2]
      local dx, dy = tx - fx, ty - fy
      local lenSq = dx * dx + dy * dy
      local t = lenSq > 0 and math.max(0, math.min(1, ((x - fx) * dx + (y - fy) * dy) / lenSq)) or 0
      local px, py = fx + dx * t, fy + dy * t
      local d = (x - px) ^ 2 + (y - py) ^ 2
      if not best or d < best.d then
        best = { d = d, piece = i, at = { px, py }, dir = { piece.dir[1], piece.dir[2] },
          ahead = math.sqrt(lenSq) * (1 - t) }
      end
    end
  end
  return { track = track, piece = best.piece, at = best.at, dir = best.dir, ahead = best.ahead }
end

-- An exit off `track`: a route of its own (`points` — the first on one
-- of the track's straights, piece `pieceIndex`: where he hits the
-- flipper; then any corners, out to the last, the landing point)
-- ending in `target`, where he crashes like at the end of any cannon
-- shot.
--
-- At its start, a pinball flipper across the straight (see
-- Cannon.flipperHeld). If the button's held as he reaches it, he
-- bounces off it there, like off a bumper — straight off down the
-- exit's first leg, at whatever angle that leaves the straight (see
-- Cannon.updateFlight); if not, it's lying out of his way and he
-- carries on round the track. It's drawn and kept clear like any other
-- route (main.lua puts it in state.cannons).
function Cannon.newExit(track, pieceIndex, points, target)
  local self = setmetatable({}, Cannon)
  self.isTrack, self.isExit, self.closed = true, true, false
  self.time = 0
  self.particles = {}
  self.railParticles = {}
  self.coins, self.coinPops = {}, {}
  self.target = target
  self.points = points
  buildTrack(self, points, false)

  local piece = track.pieces[pieceIndex]
  self.fromTrack = track
  self.at = { points[1][1], points[1][2] }
  local dx, dy = piece.dir[1], piece.dir[2]
  local ox, oy = self.pieces[1].dir[1], self.pieces[1].dir[2]
  self.dir, self.outDir = { dx, dy }, { ox, oy }
  -- (Which side of the straight he's batted off to.)
  self.side = (dx * oy - dy * ox) >= 0 and 1 or -1
  local sx, sy = -dy * self.side, dx * self.side

  -- The flipper, raised: its face square to the bounce — facing back
  -- half-way between where he's coming from and where he's going
  -- (normal), so he leaves it exactly down the exit — touching him right
  -- at the straight's point. It runs out from its pivot, back on the
  -- side away from the exit, across his path toward the exit's side.
  local nx, ny = ox - dx, oy - dy
  local nLen = math.sqrt(nx * nx + ny * ny)
  nx, ny = nx / nLen, ny / nLen
  self.normal = { nx, ny }
  local tx, ty = -ny, nx
  if tx * sx + ty * sy < 0 then tx, ty = -tx, -ty end
  local reach = FLIPPER_CONTACT_RADIUS + FLIPPER_THICKNESS * 0.4
  local cx, cy = self.at[1] - nx * reach, self.at[2] - ny * reach
  self.pivot = { cx - tx * FLIPPER_LENGTH * FLIPPER_CONTACT_AT, cy - ty * FLIPPER_LENGTH * FLIPPER_CONTACT_AT }
  self.upAngle = math.atan2(ty, tx)
  -- At rest: swung back from that, about its pivot, until it's pointing
  -- on ahead and angled away from his path.
  local rx, ry = dx * math.cos(FLIPPER_REST_ANGLE) - sx * math.sin(FLIPPER_REST_ANGLE),
    dy * math.cos(FLIPPER_REST_ANGLE) - sy * math.sin(FLIPPER_REST_ANGLE)
  self.restAngle = math.atan2(ry, rx)
  self.flip = 0 -- 0 at rest, 1 fully raised

  piece.exits = piece.exits or {}
  table.insert(piece.exits, self)
  return self
end

-- The jump button, held (Space, or the gamepad's X/A) — what raises
-- every exit's flipper.
function Cannon.flipperHeld()
  return (state.keys and state.keys[' ']) or state.gamepadJumpHeld or false
end

-- An exit's flipper as it stands right now: its pivot, and the
-- direction to its tip — swung between rest and raised (see newExit).
function Cannon:flipperPose()
  local a = lerpAngle(self.restAngle, self.upAngle, self.flip)
  return self.pivot[1], self.pivot[2], math.cos(a), math.sin(a)
end

-- Bounced off an exit's flipper: sparks off its face, the hit-stop and
-- shake a bumper gives, and its smack.
function Cannon:hitFlipper()
  self.flippedAt = self.time
  self.flip = 1
  local x, y = self.at[1], self.at[2]
  local base = math.atan2(self.normal[2], self.normal[1])
  for _ = 1, 26 do
    local a = base + (math.random() - 0.5) * 2.2
    local speed = 500 + math.random() * 1000
    local life = 0.25 + math.random() * 0.35
    self.railParticles[#self.railParticles + 1] = {
      kind = "spark", x = x, y = y, vx = math.cos(a) * speed, vy = math.sin(a) * speed,
      life = life, maxLife = life, size = 1.6 + math.random() * 1.4,
    }
  end
  CameraShake.start(BUMPER_SHAKE_STRENGTH, BUMPER_SHAKE_SECONDS)
  hitStopUntil = love.timer.getTime() + HIT_STOP_SECONDS
  if state.audioManager then state.audioManager:playGoombaStomp() end
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
      local endAt = len - COIN_END_MARGIN - ((i == #self.pieces and self.target) and self.target.radius or 0)
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
  -- The ride's his whole world now: no V.A.T.S. slow-mo dragging it out
  -- (he couldn't turn it off — see Player:isCannonRiding), no lock-on.
  player.lockedTarget = nil
  state.vatsActive = false
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
  -- track: whose pieces he's following — this cannon's route at first,
  -- then (if it merges onto one) the track's (see Cannon.updateFlight).
  player.cannonFlight = { cannon = self, track = self, target = self.target, piece = 1, railS = 0,
    speed = LAUNCH_SPEED, trail = {} }

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
  -- (A track — see Cannon.newTrack — has no cannon: just its rails'
  -- glow and sparks to keep moving.)
  if self.isTrack then
    self:updateParticles(dt)
    if self.isExit then
      -- (Its flipper, swinging up or back down after the button.)
      local goal = Cannon.flipperHeld() and 1 or 0
      self.flip = goal + (self.flip - goal) * math.exp(-FLIPPER_SWING_RATE * dt)
    end
    return
  end
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

-- Whether `p` (a planetoid) is just an ordinary field planetoid — the
-- only kind a cannon shot will blow out of its way (see clearTheWay):
-- a plain Planetoid, not anything built on one with its own look (a
-- Sphere, the mining planet, a water planet...), not anything permanent
-- (the cannons' own planets, every other landmark), and never the
-- shot's own target.
local function isMundane(p, target)
  return p ~= target and getmetatable(p) == Planetoid and rawget(p, "draw") == nil
    and not p.isPermanent and not p.isImmovable and not p.isWaterPlanet
end

-- Blowing `thing` (a planetoid or an asteroid) apart: the game's own
-- fiery explosion (more of them for a bigger one, scattered over it),
-- a bang, and a jolt of the screen.
local function blowUp(thing)
  state.explosions = state.explosions or {}
  local bursts = math.max(1, math.floor(thing.radius / 25))
  for k = 1, bursts do
    local a, d = math.random() * math.pi * 2, (k == 1) and 0 or math.random() * thing.radius * 0.7
    table.insert(state.explosions, Explosion.new(thing.pos.x + math.cos(a) * d, thing.pos.y + math.sin(a) * d))
  end
  CameraShake.start(OBSTACLE_SHAKE_STRENGTH, OBSTACLE_SHAKE_SECONDS)
  if state.audioManager then state.audioManager:playBang("large", Vector2.new(thing.pos.x, thing.pos.y)) end
end

-- Anything ordinary in his way, blown apart before he hits it, so the
-- shot never stops short: any mundane planetoid (see isMundane) or
-- asteroid within reach of the stretch he's covered since last frame —
-- or will cover by next frame (so it goes up just as he gets there, not
-- after he's already landed on it). A planetoid's coins go with it, and
-- so does a lock-on he had on it.
local function clearTheWay(player, flight, ts)
  local ax, ay = (player.prevPos or player.pos).x, (player.prevPos or player.pos).y
  local bx, by = player.pos.x + player.vel.x * ts, player.pos.y + player.vel.y * ts
  local dx, dy = bx - ax, by - ay
  local lenSq = dx * dx + dy * dy
  local function inTheWay(thing)
    local t = lenSq > 0 and math.max(0, math.min(1, ((thing.pos.x - ax) * dx + (thing.pos.y - ay) * dy) / lenSq)) or 0
    local reach = thing.radius + player.radius
    return (thing.pos.x - (ax + dx * t)) ^ 2 + (thing.pos.y - (ay + dy * t)) ^ 2 <= reach * reach
  end

  for i = #state.planetoids, 1, -1 do
    local p = state.planetoids[i]
    if isMundane(p, flight.target) and inTheWay(p) then
      table.remove(state.planetoids, i)
      for k = #(state.coins or {}), 1, -1 do
        if state.coins[k].planet == p then table.remove(state.coins, k) end
      end
      if player.lockedTarget == p then player.lockedTarget = nil end
      if player.lastInfluencePlanet == p then player.lastInfluencePlanet = nil end
      blowUp(p)
    end
  end
  for i = #(state.asteroids or {}), 1, -1 do
    local a = state.asteroids[i]
    if inTheWay(a) then
      table.remove(state.asteroids, i)
      if player.lockedTarget == a then player.lockedTarget = nil end
      blowUp(a)
    end
  end
end

-- How much of the frame's time the game should take right now (main.lua
-- scales state.timeScale by it): all but none during a hit-stop.
function Cannon.timeFactor()
  if love.timer.getTime() < hitStopUntil then return HIT_STOP_TIME_FACTOR end
  return 1
end

-- The asteroids a gauntlet's laid out (see spawnGauntlet), so whatever's
-- left of them once the ride's over can be cleared away.
local gauntletRocks = {}

-- Laying out a gauntlet: asteroids all down `piece` (a straight he's
-- just started along), GAUNTLET_SPACING apart, still and spinning, each
-- nudged a little off his line but never out of his way — so he smashes
-- through every one (see clearTheWay). Laid out as he starts down it,
-- rather than when the route's built: asteroids out in space are culled
-- once the world's no longer generating round them, which these are
-- spared (isGauntlet — see WorldGen's culling) only until the ride ends.
local function spawnGauntlet(piece)
  local len = math.sqrt((piece.to[1] - piece.from[1]) ^ 2 + (piece.to[2] - piece.from[2]) ^ 2)
  local nx, ny = -piece.dir[2], piece.dir[1]
  state.asteroids = state.asteroids or {}
  for d = GAUNTLET_END_MARGIN, len - GAUNTLET_END_MARGIN, GAUNTLET_SPACING do
    local radius = GAUNTLET_MIN_RADIUS + math.random() * (GAUNTLET_MAX_RADIUS - GAUNTLET_MIN_RADIUS)
    local side = (math.random() * 2 - 1) * radius * GAUNTLET_SIDE_NUDGE
    local rock = Asteroid.new(piece.from[1] + piece.dir[1] * d + nx * side, piece.from[2] + piece.dir[2] * d + ny * side, radius)
    rock.vel = Vector2.new(0, 0)
    rock.isGauntlet = true
    table.insert(state.asteroids, rock)
    table.insert(gauntletRocks, rock)
  end
end

-- Whatever's left of a gauntlet once the ride's over (he landed early,
-- died, was pulled away...) — gone, so it doesn't sit out there forever.
local function clearGauntlet()
  if #gauntletRocks == 0 then return end
  local mine = {}
  for _, rock in ipairs(gauntletRocks) do mine[rock] = true end
  for i = #(state.asteroids or {}), 1, -1 do
    if mine[state.asteroids[i]] then table.remove(state.asteroids, i) end
  end
  gauntletRocks = {}
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
  hitStopUntil = love.timer.getTime() + HIT_STOP_SECONDS
  if state.audioManager then state.audioManager:playGoombaStomp() end
end

-- Puts him `s` world units round rail `rail`, moving along it at `speed`.
local function placeOnRail(player, rail, s, speed)
  local x, y, dx, dy = railPoint(rail, s, 0)
  player.pos.x, player.pos.y = x, y
  player.vel.x, player.vel.y = dx * speed, dy * speed
end

-- The piece after piece `i` of `track` — round to the first again on a
-- closed loop (see Cannon.newTrack); nil past the end of an open route.
local function nextPieceIndex(track, i)
  if i < #track.pieces then return i + 1 end
  if track.closed then return 1 end
  return nil
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
  if not flight then
    clearGauntlet()
    return
  end
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

  -- (Whose pieces he's on: the cannon's own route, or — once it's merged
  -- onto one — a track's, round and round if it's a closed loop.)
  local track = flight.track
  local piece = track.pieces[flight.piece]
  local dt = ts / 60

  -- Reaching an exit's flipper with the button held (see
  -- Cannon.newExit): he bounces off it right there, like off a bumper —
  -- straight off down the exit's first leg (however far past it he got
  -- this frame), never slower than FLIPPER_MIN_SPEED.
  if piece.kind == "line" and piece.exits and flight.lastX and Cannon.flipperHeld() then
    for _, exit in ipairs(piece.exits) do
      local dx, dy = exit.dir[1], exit.dir[2]
      local before = (flight.lastX - exit.at[1]) * dx + (flight.lastY - exit.at[2]) * dy
      local now = (player.pos.x - exit.at[1]) * dx + (player.pos.y - exit.at[2]) * dy
      if before < 0 and now >= 0 then
        local ox, oy = exit.outDir[1], exit.outDir[2]
        flight.track, flight.piece, flight.target = exit, 1, exit.target
        track, piece = exit, exit.pieces[1]
        flight.speed = math.max(flight.speed, FLIPPER_MIN_SPEED)
        player.pos.x, player.pos.y = exit.at[1] + ox * now, exit.at[2] + oy * now
        player.vel.x, player.vel.y = ox * flight.speed, oy * flight.speed
        exit:hitFlipper()
        break
      end
    end
  end
  flight.lastX, flight.lastY = player.pos.x, player.pos.y

  -- Just started down a gauntlet's straight: lay it out ahead of him
  -- (every time round, on a loop).
  if flight.onPiece ~= piece then
    flight.onPiece = piece
    if piece.kind == "line" and piece.gauntlet then spawnGauntlet(piece) end
  end
  if piece.kind == "arc" then
    -- Riding a rail: easing down to RAIL_SPEED.
    local rail = piece.rail
    flight.speed = RAIL_SPEED + (flight.speed - RAIL_SPEED) * math.exp(-RAIL_BRAKE * dt)
    flight.railS = flight.railS + flight.speed * ts
    if flight.railS < rail.length then
      placeOnRail(player, rail, flight.railS, flight.speed)
      railSparks(track, rail, flight.railS, player, flight.speed)
      rail.glowAt = track.time
    else
      -- Off its end, down the line after it — however far past the end
      -- he got. (The end of a cannon's on-ramp: onto the track it
      -- merges with, partway along one of its straights.)
      local over = flight.railS - rail.length
      local dir = rail.outDir
      if rail.fling then
        -- Out of a corkscrew: flung off it, faster than he ever goes
        -- otherwise (easing back to LAUNCH_SPEED down the straight after).
        flight.speed = CORKSCREW_FLING_SPEED
        CameraShake.start(BUMPER_SHAKE_STRENGTH, BUMPER_SHAKE_SECONDS)
        if state.audioManager then state.audioManager:playBang("medium", Vector2.new(player.pos.x, player.pos.y)) end
      end
      player.pos.x, player.pos.y = rail.exit[1] + dir[1] * over, rail.exit[2] + dir[2] * over
      player.vel.x, player.vel.y = dir[1] * flight.speed, dir[2] * flight.speed
      local nextI = nextPieceIndex(track, flight.piece)
      if nextI then
        flight.piece = nextI
      elseif track.merge then
        flight.track, flight.piece = track.merge.track, track.merge.piece
      end
    end
  else
    -- A straight stretch: back up to LAUNCH_SPEED — or, flung faster
    -- than that (out of a corkscrew), only slowly back down to it.
    local ease = flight.speed > LAUNCH_SPEED and FLING_EASE or LINE_BOOST
    flight.speed = LAUNCH_SPEED + (flight.speed - LAUNCH_SPEED) * math.exp(-ease * dt)
    player.vel.x, player.vel.y = piece.dir[1] * flight.speed, piece.dir[2] * flight.speed
    local nextI = nextPieceIndex(track, flight.piece)
    local nextPiece = nextI and track.pieces[nextI]
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
        flight.piece = nextPieceIndex(track, nextI)
        track:hitBumper(bumper)
      end
    elseif nextPiece then
      -- Heading for a rail: reached the end of this line yet?
      local past = (player.pos.x - piece.to[1]) * piece.dir[1] + (player.pos.y - piece.to[2]) * piece.dir[2]
      if past >= 0 then
        local rail = nextPiece.rail
        flight.piece = nextI
        flight.railS = past
        placeOnRail(player, rail, past, flight.speed)
        rail.glowAt = track.time
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
      if t.isRoundedRect then
        -- (A rounded-rectangle target — the fisherman's, the pinball
        -- planet: onto whichever face he's reached, the same way an
        -- ordinary landing puts him there — see CollisionSystem.)
        local surface = t:nearestSurfacePoint(player.pos.x, player.pos.y)
        if t:containsPoint(player.pos.x, player.pos.y) or surface.distance <= player.radius then
          player.pos.x = surface.point.x + surface.normal.x * player.radius
          player.pos.y = surface.point.y + surface.normal.y * player.radius
          player.prevPos = player.pos:clone()
          player.vel.x, player.vel.y = 0, 0
          player.onSurface = true
          player.currentPlanet = t
          player.lastInfluencePlanet = t
          if t.arcPositionForWorldPoint then
            player.surfaceArcPos = t:arcPositionForWorldPoint(player.pos.x, player.pos.y, true)
          end
          player.angle = -math.pi / 2
          crashLanding(player)
          player.cannonFlight = nil
          return
        end
      elseif dist <= t.radius + player.radius then
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

  -- (Last: wherever this frame's left him, and wherever he's headed.)
  clearTheWay(player, flight, ts)

  table.insert(flight.trail, 1, { x = player.pos.x, y = player.pos.y })
  if #flight.trail > TRAIL_LENGTH then table.remove(flight.trail) end

  -- Afterimages: a new one each time he's come AFTERIMAGE_SPACING since
  -- the last (so they sit evenly along his path, whatever his speed).
  flight.ghosts = flight.ghosts or {}
  local last = flight.ghosts[1]
  if not last or (player.pos.x - last.x) ^ 2 + (player.pos.y - last.y) ^ 2 >= AFTERIMAGE_SPACING ^ 2 then
    table.insert(flight.ghosts, 1, { x = player.pos.x, y = player.pos.y })
    if #flight.ghosts > AFTERIMAGE_COUNT + 1 then table.remove(flight.ghosts) end
  end
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

  if self.isExit then self:drawFlipper() end

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

-- An exit's flipper (see Cannon.newExit): a fat pinball flipper on a
-- brass pivot, across the straight — glowing while it's up, and
-- flashing when he's just bounced off it.
function Cannon:drawFlipper()
  local px, py, tx, ty = self:flipperPose()
  if not utils.isOnScreen(px, py, FLIPPER_LENGTH + 200, 50) then return end
  local nx, ny = -ty, tx
  local rp, rt = FLIPPER_THICKNESS / 2, FLIPPER_THICKNESS * 0.3
  local ex, ey = px + tx * FLIPPER_LENGTH, py + ty * FLIPPER_LENGTH
  local flash = self.flippedAt and math.max(0, 1 - (self.time - self.flippedAt) / 0.5) or 0
  local lit = math.max(self.flip, flash)

  local function shape(grow)
    local a, b = rp + grow, rt + grow
    love.graphics.polygon("fill", px + nx * a, py + ny * a, ex + nx * b, ey + ny * b,
      ex - nx * b, ey - ny * b, px - nx * a, py - ny * a)
    love.graphics.circle("fill", px, py, a)
    love.graphics.circle("fill", ex, ey, b)
  end

  -- Glow, while it's up.
  if lit > 0.02 then
    love.graphics.setBlendMode("add")
    for k = 3, 1, -1 do
      love.graphics.setColor(COLOR_FLIPPER[1], COLOR_FLIPPER[2], COLOR_FLIPPER[3], 0.12 * lit)
      shape(k * 14)
    end
    love.graphics.setBlendMode("alpha")
  end
  love.graphics.setColor(COLOR_OUTLINE)
  shape(4)
  local r, g, b = COLOR_FLIPPER[1], COLOR_FLIPPER[2], COLOR_FLIPPER[3]
  local k = 0.7 + 0.3 * lit
  love.graphics.setColor(r * k + flash * 0.3, g * k + flash * 0.3, b * k + flash * 0.3, 1)
  shape(0)
  -- (A highlight down its length.)
  love.graphics.setColor(COLOR_FLIPPER_LIGHT[1], COLOR_FLIPPER_LIGHT[2], COLOR_FLIPPER_LIGHT[3], 0.55 + 0.4 * lit)
  love.graphics.setLineWidth(5)
  love.graphics.line(px + nx * rp * 0.45 + tx * rp, py + ny * rp * 0.45 + ty * rp,
    ex + nx * rt * 0.45, ey + ny * rt * 0.45)
  -- The pivot.
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.circle("fill", px, py, rp * 0.55)
  love.graphics.setColor(COLOR_BRASS)
  love.graphics.circle("fill", px, py, rp * 0.42)
  love.graphics.setColor(COLOR_BRASS_LIGHT)
  love.graphics.circle("fill", px - rp * 0.12, py - rp * 0.12, rp * 0.16)

  love.graphics.setColor(1, 1, 1, 1)
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

  -- Afterimages: faint copies of the ball (its white body, grey rim and
  -- cyan middle — see Player:drawBallMode) at the spots he's just left,
  -- each further one fainter. (The newest spot is where he is now, under
  -- him — skipped.)
  love.graphics.setBlendMode("alpha")
  local ghosts = flight.ghosts or {}
  local r = player.radius
  love.graphics.setLineWidth(math.max(1, r * 0.12 - 1))
  for i = #ghosts, 2, -1 do
    local g = ghosts[i]
    local a = AFTERIMAGE_ALPHA * (1 - (i - 2) / AFTERIMAGE_COUNT)
    love.graphics.setColor(1, 1, 1, a)
    love.graphics.circle("fill", g.x, g.y, r)
    love.graphics.setColor(0.61, 0.61, 0.61, a)
    love.graphics.circle("line", g.x, g.y, r)
    love.graphics.setColor(0.42, 0.91, 0.92, a)
    love.graphics.circle("fill", g.x, g.y, r / 3)
  end
  love.graphics.pop()
end

-- Speed lines: streaks rushing past the edges of the screen, the
-- opposite way to the way he's flying — so it reads as the world
-- streaming past. Strongest at full speed on a straight; thinning out as
-- he slows on a rail, gone at a rail's own pace (and on the ground).
-- Screen space: call after the world's drawn (and its camera transform
-- undone), before the HUD.
local speedLines = {}
local speedLineBudget = 0

function Cannon.drawSpeedLines(player)
  local dt = math.min(love.timer.getDelta(), 1 / 20)
  local w, h = love.graphics.getDimensions()
  local flight = player and player.cannonFlight

  -- How strong, from 0 (a rail's pace or slower) to 1 (full speed).
  local k, dirX, dirY = 0, 1, 0
  if flight then
    local speed = math.sqrt(player.vel.x ^ 2 + player.vel.y ^ 2)
    if speed > 1e-3 then dirX, dirY = player.vel.x / speed, player.vel.y / speed end
    k = math.max(0, math.min(1, (flight.speed - RAIL_SPEED) / (LAUNCH_SPEED - RAIL_SPEED)))
    k = k * k
  end

  -- New ones, at random spots round the edges (never in the middle,
  -- where he is).
  speedLineBudget = speedLineBudget + SPEED_LINES_PER_SECOND * k * dt
  while speedLineBudget >= 1 do
    speedLineBudget = speedLineBudget - 1
    local x, y
    for _ = 1, 8 do
      x, y = math.random() * w, math.random() * h
      local ex, ey = (x - w / 2) / (w * 0.3), (y - h / 2) / (h * 0.3)
      if ex * ex + ey * ey > 1 then break end
    end
    speedLines[#speedLines + 1] = {
      x = x, y = y, vx = -dirX, vy = -dirY,
      speed = 2200 + math.random() * 1600, length = 70 + math.random() * 120,
      life = SPEED_LINE_SECONDS, strength = k,
    }
  end

  love.graphics.push("all")
  love.graphics.setBlendMode("add")
  love.graphics.setLineStyle("smooth")
  for i = #speedLines, 1, -1 do
    local s = speedLines[i]
    s.life = s.life - dt
    if s.life <= 0 then
      table.remove(speedLines, i)
    else
      s.x = s.x + s.vx * s.speed * dt
      s.y = s.y + s.vy * s.speed * dt
      local fade = s.life / SPEED_LINE_SECONDS
      local a = SPEED_LINE_ALPHA * s.strength * math.sin(math.pi * fade)
      love.graphics.setColor(0.85, 0.93, 1, a)
      love.graphics.setLineWidth(1.5)
      love.graphics.line(s.x, s.y, s.x - s.vx * s.length, s.y - s.vy * s.length)
    end
  end
  love.graphics.pop()
end

----------------------------------------------------------------------
-- Drawing
----------------------------------------------------------------------

-- PLACEHOLDER ART: a simple brushed-metal cannon — a rounded dome of a
-- base, and a barrel with a rounded breech — standing in until it gets
-- its own drawn art. (Same size and pivot as the real one will need:
-- see the BARREL_ and BASE_ sizes above.)
--
-- The metal: bands of light and dark across each part (a bright streak
-- toward the lit side, darkening off to both edges), built once as
-- meshes in the part's own local space.
local METAL_BANDS = {           -- { position across, -1 to 1; shade }
  { -1.0, 0.22 }, { -0.75, 0.55 }, { -0.4, 0.92 }, { -0.25, 0.8 },
  { 0.1, 0.5 }, { 0.6, 0.34 }, { 1.0, 0.16 },
}
local METAL_TINT = { 0.78, 0.82, 0.9 }
local METAL_SLICES = 18

local function metalShade(u)
  for i = 1, #METAL_BANDS - 1 do
    local a, b = METAL_BANDS[i], METAL_BANDS[i + 1]
    if u <= b[1] then
      local t = (u - a[1]) / (b[1] - a[1])
      local v = a[2] + (b[2] - a[2]) * t
      return METAL_TINT[1] * v, METAL_TINT[2] * v, METAL_TINT[3] * v
    end
  end
  local v = METAL_BANDS[#METAL_BANDS][2]
  return METAL_TINT[1] * v, METAL_TINT[2] * v, METAL_TINT[3] * v
end

-- A strip of metal across `slices` steps of u from -1 to 1: each step's
-- two ends from span(u) (x0, y0, x1, y1), shaded by u.
local function metalStrip(span)
  local verts = {}
  for i = 0, METAL_SLICES do
    local u = -1 + 2 * i / METAL_SLICES
    local x0, y0, x1, y1 = span(u)
    local r, g, b = metalShade(u)
    verts[#verts + 1] = { x0, y0, 0, 0, r, g, b, 1 }
    verts[#verts + 1] = { x1, y1, 0, 0, r, g, b, 1 }
  end
  return love.graphics.newMesh(verts, "strip", "static")
end

local cannonArt = nil
local function getCannonArt()
  if cannonArt then return cannonArt end
  cannonArt = {}
  -- The barrel: shaded across its width (u along local y); its back end
  -- rounded off into a half-circle.
  local H, back = BARREL_HALF_WIDTH, -BARREL_BACK
  cannonArt.barrel = metalStrip(function(u)
    local y = u * H
    return back + H - math.sqrt(math.max(0, H * H - y * y)), y, BARREL_LENGTH - 12, y
  end)
  -- The lip round the mouth: a little wider, with rounded corners.
  local M = MUZZLE_HALF_WIDTH
  cannonArt.lip = metalStrip(function(u)
    local y = u * M
    local round = math.max(0, math.abs(y) - (M - 4))
    local cut = 4 - math.sqrt(math.max(0, 16 - round * round))
    return BARREL_LENGTH - 14 + cut, y, BARREL_LENGTH - cut, y
  end)
  -- The base: a dome, from the surface up to just over the pivot,
  -- shaded across its width (u along local x).
  local W, top = BASE_HALF_WIDTH, PIVOT_HEIGHT + 8
  cannonArt.base = metalStrip(function(u)
    local x = u * W
    return x, 4, x, -top * math.sqrt(math.max(0, 1 - u * u))
  end)
  -- The base's outline, round its dome.
  local baseLine = {}
  for i = 0, 24 do
    local u = -1 + 2 * i / 24
    baseLine[#baseLine + 1] = u * W
    baseLine[#baseLine + 1] = -top * math.sqrt(math.max(0, 1 - u * u))
  end
  cannonArt.baseLine = baseLine
  return cannonArt
end

local COLOR_METAL_OUTLINE = { 0.08, 0.09, 0.11 }

function Cannon:drawBase()
  local art = getCannonArt()
  local c, s = math.cos(self.mountAngle), math.sin(self.mountAngle)
  local sx, sy = self.planet.pos.x + c * self.planet.radius, self.planet.pos.y + s * self.planet.radius
  love.graphics.push("all")
  love.graphics.translate(sx, sy)
  love.graphics.rotate(self.mountAngle + math.pi / 2)   -- local -y: away from the planet
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(art.base)
  love.graphics.setColor(COLOR_METAL_OUTLINE)
  love.graphics.setLineWidth(2.5)
  love.graphics.setLineJoin("bevel")
  love.graphics.line(art.baseLine)
  love.graphics.pop()
end

function Cannon:drawBarrel()
  local art = getCannonArt()
  local px, py = self:pivot()
  love.graphics.push("all")
  love.graphics.translate(px, py)
  love.graphics.rotate(self.barrelAngle)
  love.graphics.translate(-self:recoilOffset(), 0)
  local H = BARREL_HALF_WIDTH
  -- Outline first (a size bigger all round), then the metal over it.
  love.graphics.setColor(COLOR_METAL_OUTLINE)
  love.graphics.circle("fill", -BARREL_BACK + H, 0, H + 2)
  love.graphics.rectangle("fill", -BARREL_BACK + H, -H - 2, BARREL_LENGTH - 12 + BARREL_BACK - H, (H + 2) * 2)
  love.graphics.rectangle("fill", BARREL_LENGTH - 16, -MUZZLE_HALF_WIDTH - 2, 18, (MUZZLE_HALF_WIDTH + 2) * 2, 5, 5)
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(art.barrel)
  love.graphics.draw(art.lip)
  -- (The mouth.)
  love.graphics.setColor(0.04, 0.04, 0.05, 1)
  love.graphics.ellipse("fill", BARREL_LENGTH - 1, 0, 3, MUZZLE_HALF_WIDTH - 5)
  love.graphics.pop()
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
