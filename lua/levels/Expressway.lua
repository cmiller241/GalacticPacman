-- lua/levels/Expressway.lua
--
-- The galactic expressway (see lua/world/Cannon.lua): a loop of track
-- all the way round the sun — an irregular, zigzagging ring of straights
-- with a curved rail at every corner (see OUTLINE below), dressed up
-- along the way: a loop-the-loop on one straight, two on another, a
-- pinball pocket of bumpers on a third, an asteroid gauntlet on a
-- fourth. Once he's on it, he goes round and round.
--
-- The way on: a small planet just inside the ring, with a cannon on top
-- that fires him straight out at the expressway — its route ending in an
-- on-ramp that lines him up with one of the expressway's straights (see
-- Cannon.trackMergeAt). The ways off: exits to a few landmarks (see
-- Cannon.newExit), each with a flipper across the track.
--
-- All of it well clear of the sun, the belt and every landmark —
-- checked below, with a warning printed if that's ever no longer true.
-- Random planetoids and asteroids are kept out of a lane down every
-- straight and round every rail and bumper (state.clearLanes — see
-- worldGen.isInClearLane).
--
-- Called from lua/levels/World.lua, after every landmark it has to
-- route round already exists.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local Planetoid = require("lua.world.Planetoid")
local Cannon = require("lua.world.Cannon")
local worldGen = require("lua.setup.WorldGen")

local Expressway = {}

-- Returns { planet, cannon } for the first entry (used by main.lua's
-- START_AT = "expressway").
function Expressway.build()
  local ENTRY_PLANET_INSET = 6500 -- how far inside the ring the entry planet sits
  local ENTRY_PLANET_RADIUS = 250
  local CLEAR_LANE_HALF_WIDTH = 500
  local RAIL_CLEARANCE = 250 -- beyond each rail's own curve (and each bumper)
  local sunX, sunY = worldGen.sunPos()

  -- The ring's corners, clockwise from the top, each as { angle round
  -- the sun (degrees: -90 straight up, increasing clockwise), distance
  -- from the sun }. Deliberately irregular: sides of every length,
  -- corners anywhere from 21000 to 42500 out — and four switchbacks,
  -- where it doubles back the way it came at a slant for a stretch
  -- (3 to 4, 9 to 10, 14 to 15, 17 to 18) before swinging forward
  -- again. (Each corner's a plain rail unless given something more —
  -- see Cannon.new for what a corner can be.) Moving any of them: keep
  -- the sides from crossing or crowding each other (7000 apart at the
  -- closest, as it is), and well clear of the belt.
  local OUTLINE = {
    { -90, 30000 }, { -62, 34500 }, { -38, 27500 }, { -55, 20500 }, { -6, 22000 },
    { 10, 33000 }, { 38, 28500 }, { 64, 36000 }, { 92, 31000 }, { 80, 41000 },
    { 122, 42500 }, { 148, 33000 }, { 172, 26000 }, { 200, 30500 }, { 190, 38500 },
    { 224, 40000 }, { 248, 32000 }, { 232, 24500 }, { 256, 21500 },
  }
  local corners = {}
  for _, c in ipairs(OUTLINE) do
    local a = math.rad(c[1])
    corners[#corners + 1] = { sunX + math.cos(a) * c[2], sunY + math.sin(a) * c[2] }
  end
  -- (Corner n is reached by the straight from corner n-1 — so a
  -- corner's loops and gauntlet are on the straight leading into it.)
  corners[6].loops = 1         -- a loop-the-loop, down the right side
  corners[11].loops = 2        -- two, one after the other, along the long bottom stretch
  corners[12].gauntlet = true  -- an asteroid gauntlet, up the lower left
  -- A corkscrew, down the lower right: CORKSCREW_LOOPS loops packed so
  -- close they overlap like a stretched-out spring — round and round,
  -- slowing to a rail's pace, then flung off the last one down the
  -- rest of the straight (see the loopGap, loopsFirst and fling
  -- options in Cannon.lua's buildTrack).
  local CORKSCREW_LOOPS = 5
  corners[9].loops = CORKSCREW_LOOPS
  corners[9].loopRadius = 380
  corners[9].loopGap = 300
  corners[9].loopsFirst = true
  corners[9].fling = true

  -- Pinball pockets: bumpers in a tight zigzag either side of a
  -- straight's line, he ping-pongs through before carrying on. Each:
  -- on the straight from corner `from` to the next, `at` of the way
  -- along it; `count` bumpers, `spacing` apart along it and `spread`
  -- out to either side. (Kept off the straights with loops, the
  -- gauntlet, and the entry's straight, corner 1 to 2.)
  local POCKETS = {
    { from = 2, at = 0.5, count = 5, spacing = 700, spread = 400 },
    { from = 4, at = 0.45, count = 3, spacing = 800, spread = 350 },
    { from = 7, at = 0.5, count = 5, spacing = 700, spread = 400 },
    { from = 13, at = 0.5, count = 7, spacing = 650, spread = 380 },
    { from = 15, at = 0.3, count = 3, spacing = 800, spread = 450 },
    { from = 16, at = 0.55, count = 5, spacing = 700, spread = 420 },
  }
  -- (The bottom straight the south entry merges onto — see below —
  -- noted before the pockets' bumpers are slotted in among the
  -- corners, which renumbers them.)
  local southLegA, southLegB = corners[10], corners[11]

  -- (Inserted last straight first, so the earlier corners' numbers
  -- stay put while it's done.)
  table.sort(POCKETS, function(p, q) return p.from > q.from end)
  for _, spec in ipairs(POCKETS) do
    local a, b = corners[spec.from], corners[spec.from + 1]
    local dx, dy = b[1] - a[1], b[2] - a[2]
    local len = math.sqrt(dx * dx + dy * dy)
    local ux, uy = dx / len, dy / len
    local nx, ny = -uy, ux
    local mx, my = a[1] + dx * spec.at, a[2] + dy * spec.at
    for k = spec.count - 1, 0, -1 do
      local along = (k - (spec.count - 1) / 2) * spec.spacing
      local side = (k % 2 == 0) and spec.spread or -spec.spread
      table.insert(corners, spec.from + 1,
        { mx + ux * along + nx * side, my + uy * along + ny * side, bumper = true })
    end
  end

  local expressway = Cannon.newTrack(corners)
  state.expressway = expressway
  state.cannons = { expressway }

  -- The entries: each a planet inside the ring, ENTRY_PLANET_INSET in
  -- from the middle of one of its straights (corner `a` to corner `b`)
  -- — and its cannon, firing out at that straight and merging onto it
  -- there. `mountAngle`: where on the planet the cannon sits (radians
  -- from its centre); none, facing straight out at the straight.
  local entryPlanets = {} -- { [planet] = true }, for every entry
  local function makeEntry(a, b, mountAngle)
    local midX, midY = (a[1] + b[1]) / 2, (a[2] + b[2]) / 2
    local inX, inY = sunX - midX, sunY - midY
    local inLen = math.sqrt(inX * inX + inY * inY)
    inX, inY = inX / inLen, inY / inLen
    local planet = Planetoid.new(midX + inX * ENTRY_PLANET_INSET, midY + inY * ENTRY_PLANET_INSET,
      ENTRY_PLANET_RADIUS, { 0.5, 0.56, 0.68, 1 })
    planet.isImmovable = true
    planet.isPermanent = true
    planet.vel = Vector2.new(0, 0)
    table.insert(state.planetoids, planet)
    entryPlanets[planet] = true
    local cannon = Cannon.new(planet, mountAngle or math.atan2(-inY, -inX), nil, {},
      Cannon.trackMergeAt(expressway, midX, midY))
    table.insert(state.cannons, cannon)
    return planet, cannon
  end
  -- The first, north of the sun: below the middle of the top straight
  -- (corner 1 to 2), its cannon on top. He starts here (see below).
  local entryPlanet, entryCannon = makeEntry(corners[1], corners[2], -math.pi / 2)
  state.expresswayEntryPlanet = entryPlanet
  -- The second, south of the sun: above the middle of the long bottom
  -- straight (corner 10 to 11), its cannon underneath, facing down at it.
  local southPlanet = makeEntry(southLegA, southLegB)
  state.expresswaySouthEntryPlanet = southPlanet

  -- The exits (see Cannon.newExit): one to each of these landmarks,
  -- each with a flipper across the expressway — hold jump as he
  -- reaches it and he bounces off it down the exit, crashing down on
  -- the landmark like at the end of any cannon shot. For a rounded rectangle, onto the
  -- middle of its top (nudged along it by `along` — a fraction of its
  -- half-width, clear of the pinball planet's entry beam), coming
  -- straight down from EXIT_APPROACH above it; for a round planet,
  -- straight at its middle.
  --
  -- Each one leaves the expressway from whichever of its straights
  -- gets it there shortest with nothing in the way: off the flipper
  -- (turning him by at most EXIT_MAX_TURN), straight for the landmark
  -- (or the point above it, then down). Never from the gauntlet's
  -- straight, or too near either end of a straight (its corners'
  -- curves); and never so that its way out crosses or crowds the
  -- expressway's other straights or rails, the sun, the belt or
  -- another landmark.
  local EXIT_CURVE_RADIUS = 700 -- the curve down onto a rectangle's top
  local EXIT_APPROACH = 2600
  local EXIT_CLEARANCE = 1600  -- from the expressway's other straights and rails
  local EXIT_END_MARGIN = 1300 -- from either end of the straight it leaves
  local EXIT_LANDMARK_CLEARANCE = 500 -- from any other landmark's outline
  local EXIT_MAX_TURN = math.rad(110) -- the sharpest it can curve off the straight
  local EXIT_SAMPLE_STEP = 600 -- how finely each straight's tried for a place to leave from
  local EXIT_TARGETS = {
    { planet = state.beltLandingPlanet },
    { planet = state.roundedRectPlanet, along = -0.3 },
    { planet = state.pinballPlanet, along = 0.3 },
  }
  local _, beltOuterR = worldGen.beltRadii()
  local function pointSegDist(x, y, ax, ay, bx, by)
    local dx, dy = bx - ax, by - ay
    local lenSq = dx * dx + dy * dy
    local t = lenSq > 0 and math.max(0, math.min(1, ((x - ax) * dx + (y - ay) * dy) / lenSq)) or 0
    return math.sqrt((x - ax - dx * t) ^ 2 + (y - ay - dy * t) ^ 2)
  end
  local function segSegDist(a, b, c, d)
    local function cross(o, p, q) return (p[1] - o[1]) * (q[2] - o[2]) - (p[2] - o[2]) * (q[1] - o[1]) end
    if cross(a, b, c) * cross(a, b, d) < 0 and cross(c, d, a) * cross(c, d, b) < 0 then return 0 end
    return math.min(pointSegDist(a[1], a[2], c[1], c[2], d[1], d[2]), pointSegDist(b[1], b[2], c[1], c[2], d[1], d[2]),
      pointSegDist(c[1], c[2], a[1], a[2], b[1], b[2]), pointSegDist(d[1], d[2], a[1], a[2], b[1], b[2]))
  end
  -- How near the segment a to b comes to landmark p's own outline: a
  -- round one's circle; anything flat (a rounded rectangle, the dome)
  -- its box — the dome's reaching up over its bubble. (Sampled along
  -- the segment, which is plenty this far out.)
  local function segClearance(p, a, b)
    local len = math.sqrt((b[1] - a[1]) ^ 2 + (b[2] - a[2]) ^ 2)
    if not p.halfWidth then
      return pointSegDist(p.pos.x, p.pos.y, a[1], a[2], b[1], b[2]) - (p.radius or 0)
    end
    local top = p.isSkyDome and (p.domeRadiusY or p.halfWidth) or p.halfHeight
    local best = math.huge
    for k = 0, math.max(1, math.ceil(len / 100)) do
      local u = k / math.max(1, math.ceil(len / 100))
      local x, y = a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u
      local ox = math.max(0, math.abs(x - p.pos.x) - p.halfWidth)
      local dy = y - p.pos.y
      local oy = dy < 0 and math.max(0, -dy - top) or math.max(0, dy - p.halfHeight)
      best = math.min(best, math.sqrt(ox * ox + oy * oy))
    end
    return best
  end
  -- Whether the legs of a would-be exit are clear. (Its first leg only
  -- from EXIT_CLEARANCE on: it starts right on the expressway — on
  -- piece `fromI` — and near that straight's own corners.)
  local function exitIsClear(points, fromI, target)
    for k = 1, #points - 1 do
      local a, b = points[k], points[k + 1]
      if k == 1 then
        local len = math.sqrt((b[1] - a[1]) ^ 2 + (b[2] - a[2]) ^ 2)
        local u = math.min(1, EXIT_CLEARANCE / len)
        a = { a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u }
      end
      for i, pc in ipairs(expressway.pieces) do
        if pc.kind == "line" and i ~= fromI and segSegDist(a, b, pc.from, pc.to) < EXIT_CLEARANCE then return false, "the expressway itself" end
      end
      for _, rail in ipairs(expressway.rails) do
        if pointSegDist(rail.cx, rail.cy, a[1], a[2], b[1], b[2]) < rail.radius + EXIT_CLEARANCE then return false, "the expressway itself" end
      end
      for _, bp in ipairs(expressway.bumpers) do
        if pointSegDist(bp.x, bp.y, a[1], a[2], b[1], b[2]) < bp.radius + EXIT_CLEARANCE then return false, "the expressway itself" end
      end
      if pointSegDist(sunX, sunY, a[1], a[2], b[1], b[2]) < beltOuterR + 200 then return false, "the belt" end
      for _, p in ipairs(state.planetoids) do
        -- (Its own landmark only counts on the last leg — the one
        -- that's meant to hit it.)
        if (p ~= target or k < #points - 1) and not entryPlanets[p] and p.pos
            and segClearance(p, a, b) < EXIT_LANDMARK_CLEARANCE then
          return false, string.format("a landmark at (%.0f, %.0f)", p.pos.x, p.pos.y)
        end
      end
    end
    return true
  end
  state.expresswayExits = {}
  for _, spec in ipairs(EXIT_TARGETS) do
    local target = spec.planet
    if target then
      -- Where the route's aimed: straight at a round planet's middle;
      -- for a rounded rectangle, a point above its top, then down onto it.
      local tail
      if target.isRoundedRect then
        local landX = target.pos.x + (spec.along or 0) * target.halfWidth
        local landY = target.pos.y - target.halfHeight
        tail = { { landX, landY - EXIT_APPROACH, radius = EXIT_CURVE_RADIUS }, { landX, landY } }
      else
        tail = { { target.pos.x, target.pos.y } }
      end
      local aimX, aimY = tail[1][1], tail[1][2]
      local best, nearestBlocker
      for i, pc in ipairs(expressway.pieces) do
        if pc.kind == "line" and not pc.gauntlet then
          local dx, dy = pc.dir[1], pc.dir[2]
          local len = math.sqrt((pc.to[1] - pc.from[1]) ^ 2 + (pc.to[2] - pc.from[2]) ^ 2)
          for s = EXIT_END_MARGIN, len - EXIT_END_MARGIN, EXIT_SAMPLE_STEP do
            -- (The flipper's here, at q.)
            local qx, qy = pc.from[1] + dx * s, pc.from[2] + dy * s
            local points = { { qx, qy } }
            for _, p in ipairs(tail) do points[#points + 1] = p end
            local length = math.sqrt((aimX - qx) ^ 2 + (aimY - qy) ^ 2)
            local ox, oy = (aimX - qx) / length, (aimY - qy) / length
            -- (Not too sharp a bounce off the straight; and coming down
            -- onto a rectangle's top, not up from below it, which would
            -- need a hairpin back down at the point above.)
            local tooSharp = math.acos(math.max(-1, math.min(1, ox * dx + oy * dy))) > EXIT_MAX_TURN
            local fromBelow = target.isRoundedRect and oy < -0.3
            if not tooSharp and not fromBelow and (not best or length < best.length) then
              local clear, blocker = exitIsClear(points, i, target)
              if clear then
                best = { piece = i, points = points, length = length }
              elseif not nearestBlocker or length < nearestBlocker.length then
                nearestBlocker = { length = length, what = blocker }
              end
            end
          end
        end
      end
      if best then
        local exit = Cannon.newExit(expressway, best.piece, best.points, target)
        table.insert(state.cannons, exit)
        table.insert(state.expresswayExits, exit)
      else
        print(string.format("Expressway: no clear way off the expressway to the landmark at (%.0f, %.0f) — no exit made for it (in the way: %s).",
          target.pos.x, target.pos.y, nearestBlocker and nearestBlocker.what or "no straight lines up with it"))
      end
    end
  end

  -- A clear lane down every straight of every route (corner to corner —
  -- and, round the expressway, from its last corner back to its first),
  -- and round every rail and bumper (a loop's whole ring reaches well
  -- past its straight).
  state.clearLanes = {}
  local isOurs = {}
  for p in pairs(entryPlanets) do isOurs[p] = true end
  local function segmentsOf(cannon)
    local route, segs = cannon.points, {}
    for i = 1, #route - 1 do segs[#segs + 1] = { route[i], route[i + 1] } end
    if cannon.closed then segs[#segs + 1] = { route[#route], route[1] } end
    return segs
  end
  for _, cannon in ipairs(state.cannons) do
    if cannon.ledge then isOurs[cannon.ledge] = true end
    for _, s in ipairs(segmentsOf(cannon)) do
      table.insert(state.clearLanes, { s[1][1], s[1][2], s[2][1], s[2][2], CLEAR_LANE_HALF_WIDTH })
    end
    -- (Rails and bumpers alike: a circle round each.)
    cannon.clearCircles = {}
    for _, rail in ipairs(cannon.rails) do table.insert(cannon.clearCircles, { rail.cx, rail.cy, rail.radius }) end
    for _, b in ipairs(cannon.bumpers) do table.insert(cannon.clearCircles, { b.x, b.y, b.radius }) end
    for _, c in ipairs(cannon.clearCircles) do
      table.insert(state.clearLanes, { c[1], c[2], c[1], c[2], c[3] + RAIL_CLEARANCE })
    end
  end

  -- Each route's own sanity check: nearest it comes to the sun (versus
  -- the belt's outer edge), and to every landmark that exists so far —
  -- down its straights, and round its rails and bumpers (each taken as
  -- its whole circle). The entry planet and its cannon don't count.
  local function nearestOnRoute(cannon, x, y)
    local best = math.huge
    for _, s in ipairs(segmentsOf(cannon)) do
      local ax, ay, bx, by = s[1][1], s[1][2], s[2][1], s[2][2]
      local dx, dy = bx - ax, by - ay
      local t = math.max(0, math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
      best = math.min(best, math.sqrt((x - (ax + dx * t)) ^ 2 + (y - (ay + dy * t)) ^ 2))
    end
    for _, c in ipairs(cannon.clearCircles) do
      local d = math.sqrt((x - c[1]) ^ 2 + (y - c[2]) ^ 2) - (c[3] + RAIL_CLEARANCE)
      best = math.min(best, math.max(0, d))
    end
    return best
  end
  local _, beltOuter = worldGen.beltRadii()
  -- (The exits were checked already, as they were laid out.)
  for n, cannon in ipairs(state.cannons) do if not cannon.isExit then
    local name = cannon.isTrack and "the expressway" or string.format("cannon %d", n)
    if nearestOnRoute(cannon, sunX, sunY) < beltOuter + CLEAR_LANE_HALF_WIDTH then
      print(string.format("Expressway: %s passes through the asteroid belt or the sun — move one of its corners.", name))
    end
    for _, p in ipairs(state.planetoids) do
      if not isOurs[p] then
        local reach = (p.radius or math.max(p.halfWidth or 0, p.halfHeight or 0)) + CLEAR_LANE_HALF_WIDTH
        if nearestOnRoute(cannon, p.pos.x, p.pos.y) < reach then
          print(string.format("Expressway: %s passes close to a landmark at (%.0f, %.0f).", name, p.pos.x, p.pos.y))
        end
      end
    end
  end end

  return { planet = entryPlanet, cannon = entryCannon }
end

return Expressway
