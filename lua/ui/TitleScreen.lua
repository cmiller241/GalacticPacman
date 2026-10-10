-- lua/ui/TitleScreen.lua
--
-- The startup screen shown before gameplay: the astronaut standing on a
-- planetoid out in the asteroid belt, the belt drifting by around him,
-- with a "PRESS [button] TO START" prompt overlaid. Pressing start fades
-- to black, puts him back behind the Space Shelter's door, and fades in
-- on the ordinary opening (door opens, he steps out, door closes — see
-- SpaceShelter.lua's own intro state machine).
--
-- This is the REAL player and the REAL world, not a separate scene: the
-- game simulates normally underneath, state.titleScreen just gates the
-- things that shouldn't happen yet. Everything that checks it:
--   main.lua           the autopilot's keys instead of the real ones;
--                      SpaceShelter's intro is held at its very start;
--                      FireBars are drawn but can't hurt him (the
--                      autopilot keeps him out of them — see "Fire
--                      bars" below — and that's the safety net); no
--                      HUD/minimap.
--   InputHandlers.lua  keys/mouse do nothing except start the game.
--   GamePadInput.lua   likewise for the controller.

local state = require("lua.state")
local worldGen = require("lua.setup.worldGen")
local Asteroid = require("lua.entities.Asteroid")
local Ooomba = require("lua.entities.Ooomba")

local TitleScreen = {}

local FADE_OUT_SECONDS = 0.5
local FADE_IN_SECONDS = 0.8

-- How far from the chosen spot in the belt (world units) a planetoid can
-- be and still be picked for him to stand on.
local STAND_SEARCH_RADIUS = 1500

local PROMPT_FONT_SIZE = 40
local PROMPT_ICON_HEIGHT = 48 -- screen px; 4x for the 12px pixel-art button icons
local PROMPT_ICON_GAP = 14
local PROMPT_Y_FRACTION = 0.84-- how far down the window the prompt's own center sits
local PROMPT_PULSE_SPEED = 2.6
-- A dark pill behind it, so it reads no matter what's drifting past
-- underneath — same rounded look as the in-game prompts.
local PROMPT_PILL_ALPHA = 0.55
local PROMPT_PILL_PAD_X, PROMPT_PILL_PAD_Y = 36, 18 -- screen px of padding around the text

local LOGO_WIDTH_FRACTION = 0.6 -- of the window's width
local LOGO_TOP_FRACTION = 0.06  -- of the window's height, from the top edge down to the logo's own top
local LOGO_METALLIC = true      -- chrome gradient multiplied over the logo (see drawLogo); false draws title.png exactly as it is
local LOGO_METAL_OPACITY = 0.2  -- how strongly: 1 is the full gradient, 0 is none at all (same as a multiply layer at that opacity)

-- Master volume while the title screen is up, as a fraction of the
-- game's normal volume — the autopilot never stops jumping, shooting
-- and collecting coins, which is a lot of noise for a screen that may
-- sit there for hours. Back to GAME_VOLUME the moment the game starts.
local TITLE_VOLUME = 0.5
local GAME_VOLUME = 1

-- "title" (waiting for start) -> "fadeOut" -> "fadeIn" -> nil (gone).
local phase = nil
local phaseTimer = 0
local fadeAlpha = 0

local promptFont = nil
local function getPromptFont()
  if not promptFont then
    promptFont = love.graphics.newFont(PROMPT_FONT_SIZE)
  end
  return promptFont
end

-- Same "which device did he touch last" test InteractPrompt.lua uses —
-- repeated here rather than required from it, since that module is about
-- world-space interact pills and this is a different prompt entirely.
local function usingGamepad()
  local gamepadTime = state.lastGamepadInputTime
  if not gamepadTime then return false end
  return gamepadTime > math.max(state.lastMouseMoveTime or 0, state.lastKeyboardMouseInputTime or 0)
end

----------------------------------------------------------------------
-- Fire bars
--
-- The belt's own fire bars (see worldGen's generateFireBarsForCell) are
-- on show on the title screen, and Bob must never touch one. A fire bar
-- is a fixed pivot with a bar of fireballs sweeping a full circle round
-- it every couple of seconds, so the whole disc it sweeps is off limits
-- — and since the bars stand still while the belt (and Bob with it)
-- drifts past, staying clear means looking AHEAD: where will this
-- planetoid be over the next few seconds?
----------------------------------------------------------------------

local FIREBAR_CLEARANCE = 45        -- world units kept between him and the edge of a fire bar's sweep
local FIREBAR_STAND_HORIZON = 150   -- ticks (2.5s): if the planetoid he's on will be inside a sweep within this, he leaves now
local FIREBAR_TARGET_HORIZON = 360  -- ticks (6s): a planetoid is only somewhere to GO if it stays clear at least this long
local FIREBAR_AIR_HORIZON = 45      -- ticks: mid-air, a sweep this close on his current heading means change course
local FIREBAR_FLEE_COOLDOWN = 0.6   -- seconds between mid-air course changes, so he doesn't dither between two escapes
local FIREBAR_PULL_FLIGHT_TICKS = 60 -- roughly how long a pull takes — a pull's path is checked against where its target is now AND will be by then
local PLAYER_REACH_ON_PLANET = 60   -- he can be standing anywhere on a planetoid: its radius plus his own height

-- Radius of the disc a fire bar sweeps.
local function fireBarReach(bar)
  return math.max(bar.blockRadius or 0, (bar.barLength or 0) + (bar.fireballRadius or 0))
end

-- How close a point at (px, py), moving (vx, vy) per tick in a straight
-- line, gets to a fire bar's pivot over the next `horizon` ticks.
local function closestApproach(px, py, vx, vy, bar, horizon)
  local dx, dy = px - bar.pos.x, py - bar.pos.y
  local speedSq = vx * vx + vy * vy
  local t = 0
  if speedSq > 1e-9 then
    t = math.max(0, math.min(horizon, -(dx * vx + dy * vy) / speedSq))
  end
  local cx, cy = dx + vx * t, dy + vy * t
  return math.sqrt(cx * cx + cy * cy)
end

-- Whether standing on planetoid `p` would bring him within a fire bar's
-- sweep at any point in the next `horizon` ticks.
local function fireBarThreatensPlanet(p, horizon)
  local vx, vy = p.vel and p.vel.x or 0, p.vel and p.vel.y or 0
  for _, bar in ipairs(state.fireBars or {}) do
    local limit = fireBarReach(bar) + (p.radius or 0) + PLAYER_REACH_ON_PLANET + FIREBAR_CLEARANCE
    if closestApproach(p.pos.x, p.pos.y, vx, vy, bar, horizon) < limit then return true end
  end
  return false
end

-- The same question for Bob himself, in flight, on his current heading.
local function fireBarThreatensPlayer(player, horizon)
  for _, bar in ipairs(state.fireBars or {}) do
    local limit = fireBarReach(bar) + player.radius + FIREBAR_CLEARANCE
    if closestApproach(player.pos.x, player.pos.y, player.vel.x, player.vel.y, bar, horizon) < limit then return true end
  end
  return false
end

-- Whether the straight line from (ax, ay) to (bx, by) passes through a
-- fire bar's sweep.
local function fireBarBlocksPath(ax, ay, bx, by, playerRadius)
  local abx, aby = bx - ax, by - ay
  local lenSq = abx * abx + aby * aby
  for _, bar in ipairs(state.fireBars or {}) do
    local t = 0
    if lenSq > 1e-9 then
      t = math.max(0, math.min(1, ((bar.pos.x - ax) * abx + (bar.pos.y - ay) * aby) / lenSq))
    end
    local cx, cy = ax + abx * t - bar.pos.x, ay + aby * t - bar.pos.y
    local limit = fireBarReach(bar) + playerRadius + FIREBAR_CLEARANCE * 0.5
    if cx * cx + cy * cy < limit * limit then return true end
  end
  return false
end

-- Whether a pull from where he is to planetoid `p` would take him
-- through a sweep — checked against both where `p` is now and where
-- it'll have drifted to by the time he gets there.
local function fireBarBlocksPullTo(player, p)
  local vx, vy = p.vel and p.vel.x or 0, p.vel and p.vel.y or 0
  return fireBarBlocksPath(player.pos.x, player.pos.y, p.pos.x, p.pos.y, player.radius)
    or fireBarBlocksPath(player.pos.x, player.pos.y,
      p.pos.x + vx * FIREBAR_PULL_FLIGHT_TICKS, p.pos.y + vy * FIREBAR_PULL_FLIGHT_TICKS, player.radius)
end

-- Stands the player on top of a belt planetoid. The spot is the middle
-- of the belt ring on the same side of the sun he's currently on (i.e.
-- the stretch of belt nearest home); the cells around it are generated
-- right now so there's something there to stand on, and the biggest
-- planetoid nearby is the one he gets. Leaves him where he is if the
-- belt somehow has nothing there.
local function standPlayerInBelt()
  local player = state.player
  local sunX, sunY = worldGen.sunPos()
  local inner, outer = worldGen.beltRadii()

  local dirX, dirY = player.pos.x - sunX, player.pos.y - sunY
  local dirLen = math.sqrt(dirX * dirX + dirY * dirY)
  if dirLen < 1 then dirX, dirY, dirLen = 1, 0, 1 end
  local beltX = sunX + (dirX / dirLen) * (inner + outer) / 2
  local beltY = sunY + (dirY / dirLen) * (inner + outer) / 2

  local cell = worldGen.cellCoordFor(beltX, beltY)
  worldGen.generateStartingNeighborhood(cell.col, cell.row)

  local best = nil
  for _, p in ipairs(state.planetoids) do
    if p.isBeltPlanetoid and p.radius and not fireBarThreatensPlanet(p, FIREBAR_TARGET_HORIZON) then
      local dx, dy = p.pos.x - beltX, p.pos.y - beltY
      if dx * dx + dy * dy <= STAND_SEARCH_RADIUS * STAND_SEARCH_RADIUS then
        if not best or p.radius > best.radius then best = p end
      end
    end
  end
  if not best then return end

  player.angle = -math.pi / 2
  player.pos.x = best.pos.x
  player.pos.y = best.pos.y - (best.radius + player.radius)
  player.prevPos = player.pos:clone()
  player.vel.x, player.vel.y = 0, 0
  player.onSurface = true
  player.currentPlanet = best
  player.lastInfluencePlanet = best
end

----------------------------------------------------------------------
-- Autopilot
--
-- Bob plays by himself while the title is up, and everything he does
-- has one visible purpose: collecting coins. Each time he's standing on
-- a planetoid he asks, in order:
--
--   1. Are there coins on THIS planetoid? Go round it and collect them
--      all — on foot, at a run, or curled into a ball.
--   2. If not, is there a planetoid within jumping distance that has
--      coins? Line up with it and jump across.
--   3. If not, pull-beam to a planetoid that does have coins.
--
-- It drives him through exactly the controls a person has — a keys
-- table for Player:move (see TitleScreen.getKeys, read by main.lua),
-- the run button (state.gamepadRunHeld), Player:jump, enterBallMode/
-- exitBallMode and trySelectPullTarget — so it's all ordinary gameplay,
-- with the ordinary physics deciding how it turns out, and the coins
-- are collected by the ordinary coin collision (see main.lua).
----------------------------------------------------------------------

-- How he collects a planetoid's coins, picked afresh for each planetoid
-- (relative odds).
local COLLECT_STYLE_WEIGHTS = { walk = 45, run = 20, ball = 35 }

local PAUSE_SECONDS = { 0.2, 0.5 }  -- the beat he stands still for between one thing and the next
local COIN_CHASE_SECONDS = 5.0      -- longest he keeps going one way after a single coin before re-picking

-- Whenever he curls into a ball he rolls this many complete laps of the
-- planetoid, in one direction, before doing anything else — whether or
-- not the coins are all gone sooner.
local BALL_LAPS = 2

-- A hop target has to be close: a jump only gets him across if the
-- other planetoid's gravity takes over mid-flight, which needs the gap
-- between the two surfaces to be well under his own jump height.
local HOP_MAX_GAP = 190
local HOP_ALIGN_TOLERANCE = 0.1     -- radians off "pointing straight at it" that still counts as lined up
local HOP_ALIGN_TIMEOUT = 3.0       -- seconds of going round to line up before he just jumps anyway

-- Pull-beam targets: a coin planetoid visible on screen if there is
-- one (the nearest), otherwise the nearest one anywhere.
local PULL_SCREEN_INSET = 70        -- screen px a target has to be inside the window edge by to count as "on screen"
local PULL_TIMEOUT = 6.0            -- seconds before a pull that isn't getting there is dropped

-- Even with a coin planetoid right next to him to hop to, this often he
-- pull-beams clear across the screen to a far one instead (the coin
-- planetoid furthest from him that's still on screen).
local FAR_PULL_CHANCE = 0.6

-- Asteroids. The belt itself has none of its own (see worldGen's
-- generateCell), so the title screen keeps a small supply drifting
-- through wherever Bob is — spawned just outside the view, carried
-- along with the belt's own orbit (so they wander across the screen
-- rather than being swept out of it) and heading roughly his way.
local TITLE_ASTEROID_COUNT = 10         -- how many it tries to keep alive around him
local ASTEROID_SPAWN_SECONDS = { 0.4, 1.0 } -- gap between one spawn and the next while under that count
local ASTEROID_RADIUS = { 18, 40 }
local ASTEROID_DRIFT_SPEED = { 0.9, 1.9 } -- world units per baseline frame, relative to the belt's own orbit
local ASTEROID_SPAWN_MARGIN = 70        -- world units outside the edge of the view they appear at
local ASTEROID_KEEP_MARGIN = 700        -- how far past the corner of the view one has to drift before it is removed
local ASTEROID_SPAWN_CLEARANCE = 30     -- minimum gap to any planetoid at the moment of spawning

-- Ooombas. A couple of them patrol planetoids near Bob, walking laps
-- (see Ooomba.newOnPlanet). They're put on planetoids that are off
-- screen at the time, so they're discovered as he moves about rather
-- than popping into view — and he keeps clear of them: never picks a
-- planetoid with one on it as somewhere to go, and leaves at once if he
-- ever finds himself sharing one. (He can't be hurt on the title screen
-- regardless — see main.lua's own Ooomba collision pass.)
-- Currently switched OFF (0): they turned out not to suit the title
-- screen. Everything below is still here and still works — set this
-- back to 2 or so to have them again.
local TITLE_OOOMBA_COUNT = 0
local OOOMBA_MIN_PLANET_RADIUS = 55     -- a full-size Ooomba is 90 tall; on anything smaller than this it dwarfs the planetoid
local OOOMBA_SPAWN_SECONDS = 1.0        -- between attempts to place one while under TITLE_OOOMBA_COUNT
local OOOMBA_OFFSCREEN_MARGIN = 80      -- world units outside the view a planetoid has to be to get one
local OOOMBA_SPAWN_REACH = 650          -- ...but no further than this beyond the corner of the view
local OOOMBA_KEEP_MARGIN = 1100         -- one that's been left this far past the corner of the view is removed

-- Shooting them. Whenever he's on his feet on a planetoid and there's
-- an asteroid on screen, in range, with nothing between him and it, he
-- stops what he's doing and shoots it — this comes before everything
-- else (except a ball roll in progress, since a ball has no blaster).
local SHOOT_RANGE = { 110, 620 }        -- world units from him
local SHOOT_SCREEN_INSET = 40           -- screen px the asteroid has to be inside the window edge by
local SHOOT_PATH_CLEARANCE = 16         -- how far the shot's path has to clear every planetoid's surface by (a fireball's own radius is 8)
local SHOOT_AIM_SECONDS = 0.3           -- he takes aim for a moment before the first shot
local SHOOT_INTERVAL_SECONDS = 0.2      -- extra wait after a shot should have landed before he fires again
local SHOOT_GIVE_UP_SECONDS = 3.0       -- an asteroid he can't hit in this long is left alone
local SHOOT_REST_SECONDS = 1.0          -- after a shooting spell, before he'll start another
local FIREBALL_SPEED = 14               -- must match lua/entities/Fireball.lua's own FIREBALL_SPEED — used to lead a moving target

-- Safety nets. He'll occasionally miss a hop and drift: after this long
-- airborne with nothing pulling him in, he beams to a planetoid — and
-- if even that doesn't land him, he's put back on one.
local DRIFT_RESCUE_SECONDS = 2.6
local LOST_SECONDS = 9.0
local LEASH_BEYOND_BELT = 900       -- world units past the belt ring's own edge before he's fetched back

local AUTOPILOT_MAX_DT = 0.05

local auto = {
  action = "pause",    -- "pause" | "collect" | "hopAlign"
  timer = 0,
  run = false,
  collectPlanet = nil, -- the planetoid `style` was picked for
  style = "walk",      -- "walk" | "run" | "ball"
  coin = nil,          -- the coin he's currently going after
  coinDir = 1,         -- -1 = ArrowLeft, 1 = ArrowRight
  coinTime = 0,
  target = nil,        -- the planetoid a hop is lining up with
  failedHops = {},     -- planetoids a hop just failed to reach — not tried again until he's somewhere new
  ballDir = 1,         -- which way the current ball roll is going
  ballAngle = 0,       -- radians rolled so far as a ball on collectPlanet (BALL_LAPS laps = BALL_LAPS * 2*pi)
  lastAngle = nil,     -- his angle round the planetoid last frame, to measure that
  airTime = 0,
  pullTime = 0,
  asteroid = nil,      -- the asteroid he's shooting at ("shoot" action)
  shootTime = 0,
  fireTimer = 0,
  shootRest = 0,       -- counts down after a shooting spell (SHOOT_REST_SECONDS)
  ignoredAsteroids = setmetatable({}, { __mode = "k" }), -- ones he gave up on
  spawnTimer = 0,
  ooombaPlanets = {},  -- { [planetoid] = true } for every planetoid with an Ooomba on it right now
  ooombaSpawnTimer = 0,
  fleeCooldown = 0,    -- seconds until he may change course away from a fire bar again (see FIREBAR_FLEE_COOLDOWN)
}
local autoKeys = {}

local function randomBetween(range)
  return range[1] + math.random() * (range[2] - range[1])
end

local function wrapAngle(a)
  while a > math.pi do a = a - 2 * math.pi end
  while a < -math.pi do a = a + 2 * math.pi end
  return a
end

local function pause()
  auto.action = "pause"
  auto.timer = randomBetween(PAUSE_SECONDS)
end

-- Plain round planetoids only — the dome, rounded rects and water all
-- have their own landing rules the autopilot has no business near.
local function isPlainPlanetoid(p)
  return p.radius and not p.isRoundedRect and not p.isWaterPlanet and not p.isPullExempt
end

-- Somewhere he may choose to GO: a plain planetoid with no Ooomba on
-- it. Every hop, pull and rescue target goes through this — he never
-- heads for a planetoid an Ooomba is patrolling. auto.ooombaPlanets is
-- refreshed at the top of every updateAutopilot.
local function isSafeTarget(p)
  return isPlainPlanetoid(p) and not auto.ooombaPlanets[p]
    and not fireBarThreatensPlanet(p, FIREBAR_TARGET_HORIZON)
end

-- { [planetoid] = how many coins are orbiting it right now }
local function countCoinsByPlanet()
  local counts = {}
  for _, coin in ipairs(state.coins or {}) do
    counts[coin.planet] = (counts[coin.planet] or 0) + 1
  end
  return counts
end

local function nearestPlanetoid(player, filter)
  local best, bestDistSq = nil, math.huge
  for _, p in ipairs(state.planetoids) do
    if isSafeTarget(p) and (not filter or filter(p)) then
      local dx, dy = p.pos.x - player.pos.x, p.pos.y - player.pos.y
      local distSq = dx * dx + dy * dy
      if distSq < bestDistSq then best, bestDistSq = p, distSq end
    end
  end
  return best
end

-- The closest planetoid with coins that's within jumping distance of
-- the one he's standing on (and hasn't just been tried and missed).
local function pickHopTarget(player, coinCounts)
  local home = player.currentPlanet
  local best, bestGap = nil, math.huge
  for _, p in ipairs(state.planetoids) do
    if p ~= home and coinCounts[p] and isSafeTarget(p) and not auto.failedHops[p] then
      local dx, dy = p.pos.x - home.pos.x, p.pos.y - home.pos.y
      local gap = math.sqrt(dx * dx + dy * dy) - p.radius - home.radius
      if gap > 0 and gap <= HOP_MAX_GAP and gap < bestGap then
        best, bestGap = p, gap
      end
    end
  end
  return best
end

local function isOnScreen(p)
  local cam, zoom = state.camera, state.zoom or 1
  if not cam then return false end
  local sx, sy = (p.pos.x - cam.x) * zoom, (p.pos.y - cam.y) * zoom
  return sx >= PULL_SCREEN_INSET and sx <= love.graphics.getWidth() - PULL_SCREEN_INSET
    and sy >= PULL_SCREEN_INSET and sy <= love.graphics.getHeight() - PULL_SCREEN_INSET
end

-- The coin planetoid furthest from him that's still on screen — the
-- "clear across the screen" pull (see FAR_PULL_CHANCE). Never one he
-- could simply have hopped to.
local function pickFarPullTarget(player, coinCounts)
  local home = player.currentPlanet
  local best, bestDistSq = nil, 0
  for _, p in ipairs(state.planetoids) do
    if p ~= home and coinCounts[p] and isSafeTarget(p) and isOnScreen(p) then
      local dx, dy = p.pos.x - home.pos.x, p.pos.y - home.pos.y
      local distSq = dx * dx + dy * dy
      local gap = math.sqrt(distSq) - p.radius - home.radius
      if gap > HOP_MAX_GAP and distSq > bestDistSq then
        best, bestDistSq = p, distSq
      end
    end
  end
  return best
end

local function pickPullTarget(player, coinCounts)
  local function hasCoins(p) return p ~= player.currentPlanet and coinCounts[p] ~= nil end
  return nearestPlanetoid(player, function(p) return hasCoins(p) and isOnScreen(p) end)
    or nearestPlanetoid(player, hasCoins)
end

-- Fires the pull beam at `target`, with the target locked so his arm
-- actually aims at it for the flight (see Player:updateOrientationAndFacing).
-- Returns whether the pull took.
local function startPull(player, target)
  -- Never a pull whose path cuts through a fire bar's sweep.
  if fireBarBlocksPullTo(player, target) then return false end
  player:trySelectPullTarget(target)
  if player.pullTarget ~= target then return false end
  player.lockedTarget = target
  player.lockAimLeadX, player.lockAimLeadY = nil, nil
  auto.pullTime = 0
  return true
end

-- Somewhere to get away TO: the nearest safe planetoid he can reach by
-- a pull that doesn't itself cross a fire bar's sweep (one with coins
-- counts as a little nearer than it is, so an escape still looks like
-- part of his coin run when there's a choice). `exclude` is a planetoid
-- not to pick — whatever he's already heading for, when the point is to
-- change course.
local function pickEscape(player, exclude)
  local coinCounts = countCoinsByPlanet()
  local best, bestScore = nil, math.huge
  for _, p in ipairs(state.planetoids) do
    if p ~= player.currentPlanet and p ~= exclude and isSafeTarget(p) and not fireBarBlocksPullTo(player, p) then
      local dx, dy = p.pos.x - player.pos.x, p.pos.y - player.pos.y
      local score = math.sqrt(dx * dx + dy * dy) - (coinCounts[p] and 150 or 0)
      if score < bestScore then best, bestScore = p, score end
    end
  end
  return best
end

-- The belt's own orbital velocity at a point (same formula as
-- worldGen's applyBeltOrbit).
local function beltOrbitVelocity(x, y)
  local sunX, sunY = worldGen.sunPos()
  local dx, dy = x - sunX, y - sunY
  local dist = math.max(1, math.sqrt(dx * dx + dy * dy))
  return (-dy / dist) * worldGen.BELT_ORBIT_SPEED, (dx / dist) * worldGen.BELT_ORBIT_SPEED
end

-- Keeps the title screen's own Ooombas (flagged .titleOoomba) supplied —
-- see TITLE_OOOMBA_COUNT and friends — and auto.ooombaPlanets current.
local function updateTitleOoombas(dt)
  local player = state.player
  if not player then return end
  state.ooombas = state.ooombas or {}

  local viewW = state.visibleWidth or love.graphics.getWidth()
  local viewH = state.visibleHeight or love.graphics.getHeight()
  local cornerDist = math.sqrt(viewW * viewW + viewH * viewH) / 2

  local alivePlanets = {}
  for _, p in ipairs(state.planetoids) do alivePlanets[p] = true end

  -- An Ooomba whose planetoid has been culled out from under it (see
  -- worldGen's own cullDistantObjects), or that's been left far behind,
  -- goes too.
  local count = 0
  auto.ooombaPlanets = {}
  for i = #state.ooombas, 1, -1 do
    local o = state.ooombas[i]
    if o.titleOoomba then
      local dx, dy = o.pos.x - player.pos.x, o.pos.y - player.pos.y
      local keepDist = cornerDist + OOOMBA_KEEP_MARGIN
      if not alivePlanets[o.planet] or dx * dx + dy * dy > keepDist * keepDist then
        table.remove(state.ooombas, i)
      else
        count = count + 1
      end
    end
  end
  for _, o in ipairs(state.ooombas) do
    if o.planet then auto.ooombaPlanets[o.planet] = true end
  end

  auto.ooombaSpawnTimer = auto.ooombaSpawnTimer - dt
  if count >= TITLE_OOOMBA_COUNT or auto.ooombaSpawnTimer > 0 then return end
  auto.ooombaSpawnTimer = OOOMBA_SPAWN_SECONDS

  local cam = state.camera
  if not cam then return end
  local candidates = {}
  for _, p in ipairs(state.planetoids) do
    if p.isBeltPlanetoid and p.radius >= OOOMBA_MIN_PLANET_RADIUS and not auto.ooombaPlanets[p]
       and p ~= player.currentPlanet and p ~= player.pullTarget and p ~= auto.target then
      local margin = p.radius + OOOMBA_OFFSCREEN_MARGIN
      local offScreen = p.pos.x < cam.x - margin or p.pos.x > cam.x + viewW + margin
        or p.pos.y < cam.y - margin or p.pos.y > cam.y + viewH + margin
      local dx, dy = p.pos.x - player.pos.x, p.pos.y - player.pos.y
      local reach = cornerDist + OOOMBA_SPAWN_REACH
      if offScreen and dx * dx + dy * dy <= reach * reach then
        table.insert(candidates, p)
      end
    end
  end
  if #candidates == 0 then return end

  local planet = candidates[math.random(#candidates)]
  local ooomba = Ooomba.newOnPlanet(planet, math.random() * math.pi * 2, { direction = math.random() < 0.5 and -1 or 1 })
  ooomba.titleOoomba = true
  table.insert(state.ooombas, ooomba)
  auto.ooombaPlanets[planet] = true
end

-- Keeps the title screen's own asteroids (flagged .titleDrift) supplied
-- and moving — see TITLE_ASTEROID_COUNT and friends.
local function updateTitleAsteroids(dt)
  local player = state.player
  if not player or not state.asteroids then return end

  local viewW = state.visibleWidth or love.graphics.getWidth()
  local viewH = state.visibleHeight or love.graphics.getHeight()
  local keepDist = math.sqrt(viewW * viewW + viewH * viewH) / 2 + ASTEROID_KEEP_MARGIN

  local alive = 0
  for i = #state.asteroids, 1, -1 do
    local a = state.asteroids[i]
    if a.titleDrift then
      local dx, dy = a.pos.x - player.pos.x, a.pos.y - player.pos.y
      if dx * dx + dy * dy > keepDist * keepDist then
        table.remove(state.asteroids, i)
      else
        alive = alive + 1
        -- Re-set every frame: Asteroid:update's own drag would otherwise
        -- bleed the orbital speed off and leave it falling behind.
        local ox, oy = beltOrbitVelocity(a.pos.x, a.pos.y)
        -- A piece flung off a broken asteroid (see main.lua's own
        -- breakAsteroid) starts out much faster than an ordinary drift;
        -- it's eased back down to one rather than tearing off forever.
        local driftSpeed = math.sqrt(a.titleDrift.x ^ 2 + a.titleDrift.y ^ 2)
        if driftSpeed > ASTEROID_DRIFT_SPEED[2] then
          local keep = 0.985 ^ (dt * 60)
          a.titleDrift.x, a.titleDrift.y = a.titleDrift.x * keep, a.titleDrift.y * keep
        end
        a.vel.x, a.vel.y = ox + a.titleDrift.x, oy + a.titleDrift.y
      end
    end
  end

  auto.spawnTimer = auto.spawnTimer - dt
  if alive >= TITLE_ASTEROID_COUNT or auto.spawnTimer > 0 then return end
  auto.spawnTimer = randomBetween(ASTEROID_SPAWN_SECONDS)

  local radius = randomBetween(ASTEROID_RADIUS)
  for _ = 1, 8 do
    -- A point just outside one of the four edges of the view (not out at
    -- its corner distance — the top and bottom edges are much nearer
    -- than that, and an asteroid has to survive the trip in).
    local halfW, halfH = viewW / 2 + ASTEROID_SPAWN_MARGIN, viewH / 2 + ASTEROID_SPAWN_MARGIN
    local ox, oy
    if math.random() < viewW / (viewW + viewH) then
      ox, oy = (math.random() * 2 - 1) * halfW, (math.random() < 0.5 and -1 or 1) * halfH
    else
      ox, oy = (math.random() < 0.5 and -1 or 1) * halfW, (math.random() * 2 - 1) * halfH
    end
    local angle = math.atan2(oy, ox)
    local x, y = player.pos.x + ox, player.pos.y + oy

    local clear = true
    for _, p in ipairs(state.planetoids) do
      if p.radius then
        local dx, dy = p.pos.x - x, p.pos.y - y
        local minDist = p.radius + radius + ASTEROID_SPAWN_CLEARANCE
        if dx * dx + dy * dy < minDist * minDist then clear = false; break end
      end
    end

    if clear then
      local asteroid = Asteroid.new(x, y, radius)
      -- Back across the view, give or take, so it actually passes him.
      local heading = angle + math.pi + (math.random() - 0.5) * 1.0
      local speed = randomBetween(ASTEROID_DRIFT_SPEED)
      asteroid.titleDrift = { x = math.cos(heading) * speed, y = math.sin(heading) * speed }
      table.insert(state.asteroids, asteroid)
      return
    end
  end
end

-- Where to aim to hit `asteroid`, given it keeps moving while the
-- fireball is on its way: returns the intercept point.
local function interceptPoint(player, asteroid)
  local rx, ry = asteroid.pos.x - player.pos.x, asteroid.pos.y - player.pos.y
  local vx, vy = asteroid.vel.x, asteroid.vel.y
  local a = vx * vx + vy * vy - FIREBALL_SPEED * FIREBALL_SPEED
  local b = 2 * (rx * vx + ry * vy)
  local c = rx * rx + ry * ry
  local t = 0
  local disc = b * b - 4 * a * c
  if a < 0 and disc >= 0 then
    t = math.max(0, (-b - math.sqrt(disc)) / (2 * a))
  end
  return asteroid.pos.x + vx * t, asteroid.pos.y + vy * t
end

-- Where his ARM has to point for the fireball to actually pass through
-- (tx, ty). Not simply at it: a fireball leaves from the muzzle, which
-- sits off to one side of the shoulder-to-target line, and its heading
-- is the arm's angle plus blasterAngleOffset (see Player:shootFireball,
-- whose own muzzle pixel these two numbers repeat). Up close that
-- hardly matters; at a few hundred units it's a clean miss. Solved by
-- a couple of rounds of "where would the muzzle be if he aimed there".
local MUZZLE_PX_X, MUZZLE_PX_Y = 530, 120
local function aimPointFor(player, tx, ty)
  local shoulder = player.aimShoulderPos
  if not shoulder then return tx, ty end
  local cfg, scale = player.bodyPartsConfig, player.bodyScale
  local vx = (MUZZLE_PX_X - cfg.leftArmJointX) * scale
  local vy = (MUZZLE_PX_Y - cfg.leftArmJointY) * scale * (player.facingDirection < 0 and -1 or 1)
  local angleOffset = player.blasterAngleOffset or 0

  local aim = math.atan2(ty - shoulder.y, tx - shoulder.x)
  for _ = 1, 3 do
    local c, s = math.cos(aim), math.sin(aim)
    local muzzleX = shoulder.x + vx * c - vy * s
    local muzzleY = shoulder.y + vx * s + vy * c
    aim = math.atan2(ty - muzzleY, tx - muzzleX) - angleOffset
  end

  local dist = math.sqrt((tx - shoulder.x) ^ 2 + (ty - shoulder.y) ^ 2)
  return shoulder.x + math.cos(aim) * dist, shoulder.y + math.sin(aim) * dist
end

-- Whether he has a clean shot at `asteroid` right now: on screen, in
-- range, and no planetoid (the one he's standing on included) anywhere
-- along the line the fireball would take.
local function hasClearShot(player, asteroid)
  local dx, dy = asteroid.pos.x - player.pos.x, asteroid.pos.y - player.pos.y
  local distSq = dx * dx + dy * dy
  if distSq < SHOOT_RANGE[1] * SHOOT_RANGE[1] or distSq > SHOOT_RANGE[2] * SHOOT_RANGE[2] then return false end

  local cam, zoom = state.camera, state.zoom or 1
  if not cam then return false end
  local sx, sy = (asteroid.pos.x - cam.x) * zoom, (asteroid.pos.y - cam.y) * zoom
  if sx < SHOOT_SCREEN_INSET or sx > love.graphics.getWidth() - SHOOT_SCREEN_INSET
     or sy < SHOOT_SCREEN_INSET or sy > love.graphics.getHeight() - SHOOT_SCREEN_INSET then
    return false
  end

  local ax, ay = player.pos.x, player.pos.y
  local bx, by = interceptPoint(player, asteroid)
  local abx, aby = bx - ax, by - ay
  local abLenSq = abx * abx + aby * aby
  if abLenSq < 1 then return false end

  for _, p in ipairs(state.planetoids) do
    if p.radius then
      -- Closest point on the shot's own segment to this planetoid's center.
      local t = ((p.pos.x - ax) * abx + (p.pos.y - ay) * aby) / abLenSq
      t = math.max(0, math.min(1, t))
      local cx, cy = ax + abx * t - p.pos.x, ay + aby * t - p.pos.y
      local block = p.radius + SHOOT_PATH_CLEARANCE
      if cx * cx + cy * cy < block * block then return false end
    end
  end
  return true
end

-- The nearest asteroid he has a clean shot at, if any.
local function pickShootTarget(player)
  local best, bestDistSq = nil, math.huge
  for _, a in ipairs(state.asteroids or {}) do
    if not auto.ignoredAsteroids[a] then
      local dx, dy = a.pos.x - player.pos.x, a.pos.y - player.pos.y
      local distSq = dx * dx + dy * dy
      if distSq < bestDistSq and hasClearShot(player, a) then
        best, bestDistSq = a, distSq
      end
    end
  end
  return best
end

local function endShoot(player)
  player.lockedTarget = nil
  player.lockAimLeadX, player.lockAimLeadY = nil, nil
  auto.asteroid = nil
  auto.shootRest = SHOOT_REST_SECONDS
  pause()
end

-- One frame of the "shoot" action: stand still, keep the blaster on
-- the asteroid (leading it), and fire until it's gone.
local function updateShoot(player, dt)
  local asteroid = auto.asteroid
  local exists = false
  for _, a in ipairs(state.asteroids or {}) do
    if a == asteroid then exists = true; break end
  end
  if not exists then
    endShoot(player) -- got it (or something else did)
    return
  end

  auto.shootTime = auto.shootTime + dt
  if auto.shootTime > SHOOT_GIVE_UP_SECONDS or not hasClearShot(player, asteroid) then
    auto.ignoredAsteroids[asteroid] = true
    endShoot(player)
    return
  end

  local ix, iy = interceptPoint(player, asteroid)
  local aimX, aimY = aimPointFor(player, ix, iy)
  player.lockedTarget = asteroid
  player.lockAimLeadX, player.lockAimLeadY = aimX - asteroid.pos.x, aimY - asteroid.pos.y

  auto.fireTimer = auto.fireTimer - dt
  if auto.shootTime >= SHOOT_AIM_SECONDS and auto.fireTimer <= 0 then
    player:shootFireball()
    -- Waits out that shot's own flight time before firing again, so a
    -- second fireball only goes out if the first actually missed.
    local dist = math.sqrt((ix - player.pos.x) ^ 2 + (iy - player.pos.y) ^ 2)
    auto.fireTimer = dist / FIREBALL_SPEED / 60 + SHOOT_INTERVAL_SECONDS
  end
end

local function pickCollectStyle()
  local total = 0
  for _, weight in pairs(COLLECT_STYLE_WEIGHTS) do total = total + weight end
  local roll = math.random() * total
  for _, name in ipairs({ "walk", "run", "ball" }) do
    if roll < COLLECT_STYLE_WEIGHTS[name] then return name end
    roll = roll - COLLECT_STYLE_WEIGHTS[name]
  end
  return "walk"
end

local function holdDirection(dir)
  autoKeys[dir < 0 and "ArrowLeft" or "ArrowRight"] = true
end

-- Goes round the planetoid he's on toward one coin at a time: the one
-- nearest him by angle, approached the short way round, and stuck with
-- until it's collected (re-picking every frame would have him dither
-- between two coins on opposite sides).
local function collectCoins(player, dt)
  local planet = player.currentPlanet

  local stillThere = false
  local nearest, nearestOff = nil, math.huge
  for _, coin in ipairs(state.coins) do
    if coin.planet == planet then
      if coin == auto.coin then stillThere = true end
      local off = math.abs(wrapAngle(coin.angle - player.angle))
      if off < nearestOff then nearest, nearestOff = coin, off end
    end
  end

  auto.coinTime = auto.coinTime + dt
  if not stillThere or auto.coinTime > COIN_CHASE_SECONDS then
    auto.coin = nearest
    auto.coinTime = 0
    if nearest then
      auto.coinDir = wrapAngle(nearest.angle - player.angle) >= 0 and 1 or -1 -- ArrowRight increases his angle
    end
  end
  if not auto.coin then return end

  if auto.style == "ball" and not player.isBall and not player.morphState then
    player:enterBallMode()
  end
  auto.run = auto.style == "run"
  holdDirection(auto.coinDir)
end

-- Standing on a planetoid with nothing in progress: decide what's next.
local function decide(player)
  local coinCounts = countCoinsByPlanet()
  local here = player.currentPlanet
  auto.run = false

  if coinCounts[here] then
    if auto.collectPlanet ~= here then
      auto.collectPlanet = here
      auto.style = pickCollectStyle()
      auto.failedHops = {}
      auto.ballAngle = 0
      if auto.style == "ball" then
        -- Sets off toward whichever coin is nearest, then keeps going
        -- that same way round for the whole roll.
        local nearestOff = nil
        for _, coin in ipairs(state.coins) do
          if coin.planet == here then
            local off = wrapAngle(coin.angle - player.angle)
            if not nearestOff or math.abs(off) < math.abs(nearestOff) then nearestOff = off end
          end
        end
        auto.ballDir = (nearestOff or 1) >= 0 and 1 or -1
      end
    end
    auto.action = "collect"
    auto.coin = nil
    return
  end

  -- Nothing (left) here. Everything from this point needs him on his
  -- feet — a ball can't jump across or use the pull beam.
  if player.isBall or player.morphState then
    player:exitBallMode()
    return
  end

  local hopTarget = pickHopTarget(player, coinCounts)
  if hopTarget and math.random() < FAR_PULL_CHANCE then
    local farTarget = pickFarPullTarget(player, coinCounts)
    if farTarget and startPull(player, farTarget) then
      pause()
      return
    end
  end
  if hopTarget then
    auto.action = "hopAlign"
    auto.timer = HOP_ALIGN_TIMEOUT
    auto.target = hopTarget
    return
  end

  local pullTarget = pickPullTarget(player, coinCounts)
  if pullTarget and startPull(player, pullTarget) then
    pause() -- airborne from here; what's next is decided once he's landed
    return
  end

  pause()
end

local function updateAutopilot(dt)
  local player = state.player
  autoKeys = {}
  if not player or player.isDying or player.isTeleporting then return end

  -- Fetched back if he's somehow wandered right out of the belt.
  local sunX, sunY = worldGen.sunPos()
  local inner, outer = worldGen.beltRadii()
  local fromSun = math.sqrt((player.pos.x - sunX) ^ 2 + (player.pos.y - sunY) ^ 2)
  if fromSun < inner - LEASH_BEYOND_BELT or fromSun > outer + LEASH_BEYOND_BELT then
    player.pullTarget, player.lockedTarget = nil, nil
    standPlayerInBelt()
  end

  auto.fleeCooldown = math.max(0, auto.fleeCooldown - dt)

  if not player.onSurface then
    auto.airTime = auto.airTime + dt
    auto.run = false

    -- Mid-air and heading into a fire bar's sweep (a hop gone wide, or
    -- a pull whose target has since drifted toward one): change course
    -- to somewhere safe, right now.
    if auto.fleeCooldown <= 0 and not player.isBall and not player.morphState
       and fireBarThreatensPlayer(player, FIREBAR_AIR_HORIZON) then
      local escape = pickEscape(player, player.pullTarget)
      if escape and startPull(player, escape) then
        auto.fleeCooldown = FIREBAR_FLEE_COOLDOWN
      end
    end
    if auto.asteroid then
      -- Knocked off his planetoid mid-shot — the shooting's over.
      player.lockedTarget = nil
      player.lockAimLeadX, player.lockAimLeadY = nil, nil
      auto.asteroid = nil
      auto.action = "pause"
    end
    if player.pullTarget then
      auto.pullTime = auto.pullTime + dt
      if auto.pullTime > PULL_TIMEOUT then
        player:clearPullTarget()
        player.lockedTarget = nil
      end
    elseif auto.airTime > LOST_SECONDS then
      player.lockedTarget = nil
      standPlayerInBelt()
      auto.airTime = 0
    elseif auto.airTime > DRIFT_RESCUE_SECONDS and not player.isBall and not player.morphState then
      local coinCounts = countCoinsByPlanet()
      local rescue = nearestPlanetoid(player, function(p) return coinCounts[p] ~= nil end) or nearestPlanetoid(player)
      if rescue then startPull(player, rescue) end
    end
    return
  end

  -- Standing on something.
  if auto.airTime > 0 then
    -- Just landed. If that was a hop that came back down where it
    -- started (or somewhere else entirely), that target isn't tried
    -- again from here.
    auto.airTime = 0
    player.lockedTarget = nil
    if auto.target and player.currentPlanet ~= auto.target then
      auto.failedHops[auto.target] = true
    end
    auto.target = nil
    pause()
  end
  if not player.currentPlanet or not isPlainPlanetoid(player.currentPlanet) then return end

  -- A fire bar comes before everything. If the planetoid he's standing
  -- on is about to drift into one's sweep, he drops whatever he was
  -- doing and pull-beams to a planetoid that isn't — on his feet first
  -- if he's a ball, since a ball has no pull beam.
  if fireBarThreatensPlanet(player.currentPlanet, FIREBAR_STAND_HORIZON) then
    auto.run = false
    if auto.asteroid then
      player.lockAimLeadX, player.lockAimLeadY = nil, nil
      auto.asteroid = nil
    end
    auto.target = nil
    if player.isBall or player.morphState then
      player:exitBallMode()
      return
    end
    local escape = pickEscape(player)
    if escape and startPull(player, escape) then
      auto.fleeCooldown = FIREBAR_FLEE_COOLDOWN
      pause()
      return
    end
    -- Nowhere safe within reach this instant: carry on, and try again
    -- next frame as things move.
    if auto.action == "shoot" then pause() end
  end

  -- Sharing a planetoid with an Ooomba (a missed hop can land him on
  -- one he never chose): he leaves immediately, before anything else —
  -- on his feet first if he's a ball, then by pull beam to the nearest
  -- safe planetoid (one with coins if there is one), or failing that a
  -- plain jump off.
  if auto.ooombaPlanets[player.currentPlanet] then
    auto.run = false
    if auto.asteroid then
      player.lockAimLeadX, player.lockAimLeadY = nil, nil
      auto.asteroid = nil
    end
    auto.target = nil
    if player.isBall or player.morphState then
      player:exitBallMode()
      return
    end
    local coinCounts = countCoinsByPlanet()
    local escape = nearestPlanetoid(player, function(p) return p ~= player.currentPlanet and coinCounts[p] ~= nil end)
      or nearestPlanetoid(player, function(p) return p ~= player.currentPlanet end)
    if not (escape and startPull(player, escape)) then
      player:jump()
    end
    pause()
    return
  end

  -- An asteroid he can shoot comes before everything else — checked
  -- every frame he's standing on his feet, whatever he was doing.
  auto.shootRest = math.max(0, auto.shootRest - dt)
  if auto.action == "shoot" then
    auto.run = false
    updateShoot(player, dt)
    return
  end
  if auto.shootRest <= 0 and not player.isBall and not player.morphState then
    local asteroid = pickShootTarget(player)
    if asteroid then
      auto.action = "shoot"
      auto.asteroid = asteroid
      auto.shootTime = 0
      auto.fireTimer = 0
      auto.target = nil -- a hop he was lining up is abandoned; he'll decide afresh afterwards
      auto.run = false
      return
    end
  end

  auto.timer = auto.timer - dt

  -- How far round the planetoid he's rolled as a ball since last frame.
  if player.isBall and auto.lastAngle and auto.collectPlanet == player.currentPlanet then
    auto.ballAngle = auto.ballAngle + math.abs(wrapAngle(player.angle - auto.lastAngle))
  end
  auto.lastAngle = player.angle

  if auto.action == "collect" and auto.style == "ball" and auto.ballAngle < BALL_LAPS * 2 * math.pi then
    -- The ball roll: BALL_LAPS full laps one way, picking up whatever
    -- coins are in the way, before anything else is considered.
    if not player.isBall and not player.morphState then
      player:enterBallMode()
    end
    auto.run = false
    holdDirection(auto.ballDir)

  elseif auto.action == "collect" then
    collectCoins(player, dt)
    if not auto.coin then
      -- That was the last of them.
      pause()
    end

  elseif auto.action == "hopAlign" then
    -- Go round the planetoid until he's standing on the side facing
    -- the target, then jump straight off toward it.
    local home, target = player.currentPlanet, auto.target
    local wanted = math.atan2(target.pos.y - home.pos.y, target.pos.x - home.pos.x)
    local off = wrapAngle(wanted - player.angle)
    if math.abs(off) <= HOP_ALIGN_TOLERANCE or auto.timer <= 0 then
      player:jump()
      pause()
    else
      holdDirection(off > 0 and 1 or -1) -- ArrowRight increases his angle round the planetoid
    end

  else -- "pause"
    if auto.timer <= 0 then
      decide(player)
    end
  end
end

-- The direction keys the autopilot is "holding" this frame — main.lua
-- passes this to Player:move in place of the real keys while the title
-- screen is up.
function TitleScreen.getKeys()
  return autoKeys
end

-- Call once, at the end of love.load (the player, the shelter and
-- state.respawnPoint all need to exist already).
function TitleScreen.enter()
  state.titleScreen = true
  phase = "title"
  phaseTimer = 0
  fadeAlpha = 0
  auto.action, auto.timer, auto.airTime, auto.pullTime = "pause", 1.0, 0, 0
  auto.run, auto.target = false, nil
  auto.collectPlanet, auto.coin, auto.coinTime, auto.failedHops = nil, nil, 0, {}
  auto.ballAngle, auto.lastAngle = 0, nil
  auto.asteroid, auto.shootRest, auto.spawnTimer = nil, 0, 0
  auto.ooombaPlanets, auto.ooombaSpawnTimer = {}, 0
  auto.fleeCooldown = 0
  autoKeys = {}
  love.audio.setVolume(TITLE_VOLUME)
  standPlayerInBelt()
end

-- The start button (see InputHandlers.lua/GamePadInput.lua). Only does
-- anything while the title is actually waiting for it.
function TitleScreen.requestStart()
  if phase ~= "title" then return end
  phase = "fadeOut"
  phaseTimer = 0
end

-- The cut itself, made while the screen is fully black: back to the
-- shelter doorway (Player:respawn already does exactly this move — see
-- state.respawnPoint — minus the post-death blinking, which doesn't
-- belong here), and the title is over.
local function beginGame()
  local player = state.player
  -- Whatever the autopilot was in the middle of is dropped.
  player.pullTarget = nil
  player.lockedTarget = nil
  player.lockAimLeadX, player.lockAimLeadY = nil, nil
  state.gamepadRunHeld = false
  -- The title screen's own Ooombas go with it — the real game's belt
  -- doesn't have any.
  for i = #(state.ooombas or {}), 1, -1 do
    if state.ooombas[i].titleOoomba then table.remove(state.ooombas, i) end
  end
  autoKeys = {}
  player:respawn()
  player.invincibleTimer = 0

  state.zoom = 1
  state.zoomTarget = nil
  -- Coins the autopilot picked up on the title screen don't count.
  state.score = 0
  love.audio.setVolume(GAME_VOLUME)

  -- worldGen streams around the CAMERA (see worldGen.streamFocus), which
  -- main.lua won't recompute until later this same frame — pointed at
  -- his new position now so the home area is generated/culled around
  -- where he actually is before the fade-in shows it.
  state.camera = {
    x = player.pos.x - (state.visibleWidth or 0) / 2,
    y = player.pos.y - (state.visibleHeight or 0) / 2,
  }
  worldGen.updateActiveCells()

  state.titleScreen = false
end

-- Call every frame from love.update, before the player/camera update.
function TitleScreen.update(dt)
  -- The autopilot keeps going through the fade-out too, so he doesn't
  -- freeze the instant start is pressed. The run button is written
  -- here, after GamePadInput.lua's own poll has set it for the frame.
  if state.titleScreen then
    updateTitleOoombas(math.min(dt, AUTOPILOT_MAX_DT))
    updateTitleAsteroids(math.min(dt, AUTOPILOT_MAX_DT))
    updateAutopilot(math.min(dt, AUTOPILOT_MAX_DT))
    state.gamepadRunHeld = auto.run and next(autoKeys) ~= nil
  end

  if not phase or phase == "title" then return end

  phaseTimer = phaseTimer + dt
  if phase == "fadeOut" then
    fadeAlpha = math.min(1, phaseTimer / FADE_OUT_SECONDS)
    if phaseTimer >= FADE_OUT_SECONDS then
      beginGame()
      phase = "fadeIn"
      phaseTimer = 0
      fadeAlpha = 1
    end
  elseif phase == "fadeIn" then
    fadeAlpha = math.max(0, 1 - phaseTimer / FADE_IN_SECONDS)
    if phaseTimer >= FADE_IN_SECONDS then
      phase = nil
      fadeAlpha = 0
    end
  end
end

-- The logo (img/title.png), top center: LOGO_WIDTH_FRACTION of the
-- window wide — never enlarged past its own real size — with its top
-- edge LOGO_TOP_FRACTION of the window's height down from the top.
--
-- LOGO_METALLIC: a chrome-style gradient MULTIPLIED over the logo as
-- it's drawn — img/title.png itself is untouched. Multiplying means the
-- white letter faces take on the gradient while the black extrusion
-- behind them stays black. The gradient is the classic chrome look, top
-- to bottom (LOGO_METAL_STOPS): cool sky tones, up to white, a hard
-- dark "horizon" line just past the middle, then warm tones below it.
local LOGO_METAL_STOPS = {
  -- { position down the logo (0 = top, 1 = bottom), r, g, b }
  { 0.00, 0.62, 0.74, 0.95 },
  { 0.30, 0.90, 0.95, 1.00 },
  { 0.47, 1.00, 1.00, 1.00 },
  { 0.52, 0.30, 0.33, 0.44 }, -- the horizon line
  { 0.62, 0.62, 0.58, 0.60 },
  { 0.84, 1.00, 0.92, 0.76 },
  { 1.00, 0.72, 0.60, 0.50 },
}

local logoMetalShader, logoMetalGradient = nil, nil
local function getLogoMetal()
  if logoMetalShader then return logoMetalShader end

  -- The gradient as a 1px-wide strip, sampled by how far down the logo
  -- a pixel is.
  local height = 256
  local data = love.image.newImageData(1, height)
  for y = 0, height - 1 do
    local t = y / (height - 1)
    local a, b = LOGO_METAL_STOPS[1], LOGO_METAL_STOPS[#LOGO_METAL_STOPS]
    for i = 1, #LOGO_METAL_STOPS - 1 do
      if t >= LOGO_METAL_STOPS[i][1] and t <= LOGO_METAL_STOPS[i + 1][1] then
        a, b = LOGO_METAL_STOPS[i], LOGO_METAL_STOPS[i + 1]
        break
      end
    end
    local span = math.max(1e-6, b[1] - a[1])
    local k = math.max(0, math.min(1, (t - a[1]) / span))
    data:setPixel(0, y, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k, a[4] + (b[4] - a[4]) * k, 1)
  end
  logoMetalGradient = love.graphics.newImage(data)
  logoMetalGradient:setFilter("linear", "linear")

  logoMetalShader = love.graphics.newShader([[
    extern Image gradient;
    extern float opacity;
    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec4 texel = Texel(tex, uv);
      // "opacity" blends the gradient toward plain white (no change) first,
      // exactly like lowering the opacity of a multiply layer.
      vec3 metal = mix(vec3(1.0), Texel(gradient, vec2(0.5, uv.y)).rgb, opacity);
      return vec4(texel.rgb * metal, texel.a) * color;
    }
  ]])
  logoMetalShader:send("gradient", logoMetalGradient)
  logoMetalShader:send("opacity", LOGO_METAL_OPACITY)
  return logoMetalShader
end

local function drawLogo()
  local logo = state.titleLogoTexture
  if not logo then return end
  local screenW, screenH = love.graphics.getWidth(), love.graphics.getHeight()
  local scale = math.min(1, screenW * LOGO_WIDTH_FRACTION / logo:getWidth())
  love.graphics.setColor(1, 1, 1, 1)
  if LOGO_METALLIC then love.graphics.setShader(getLogoMetal()) end
  love.graphics.draw(logo, math.floor((screenW - logo:getWidth() * scale) / 2), math.floor(screenH * LOGO_TOP_FRACTION), 0, scale, scale)
  if LOGO_METALLIC then love.graphics.setShader() end
end

local function drawPrompt()
  local font = getPromptFont()
  local icons = state.buttonIcons
  local icon = icons and (usingGamepad() and icons.CROSS or icons.ENTER)

  local before, after = "PRESS", "TO START"
  if not icon then before = usingGamepad() and "PRESS X" or "PRESS ENTER" end

  local beforeW, afterW = font:getWidth(before), font:getWidth(after)
  local iconScale, iconW = 1, 0
  if icon then
    iconScale = PROMPT_ICON_HEIGHT / icon:getHeight()
    iconW = icon:getWidth() * iconScale
  end
  local middleW = icon and (PROMPT_ICON_GAP + iconW + PROMPT_ICON_GAP) or font:getWidth(" ")
  local totalW = beforeW + middleW + afterW

  local screenW, screenH = love.graphics.getWidth(), love.graphics.getHeight()
  local x = math.floor((screenW - totalW) / 2)
  local centerY = math.floor(screenH * PROMPT_Y_FRACTION)
  local textY = math.floor(centerY - font:getHeight() / 2)

  -- The pill holds steady; only the words and the button breathe.
  local pillH = math.max(font:getHeight(), PROMPT_ICON_HEIGHT) + PROMPT_PILL_PAD_Y * 2
  local pillX, pillW = x - PROMPT_PILL_PAD_X, totalW + PROMPT_PILL_PAD_X * 2
  love.graphics.setColor(0, 0, 0, PROMPT_PILL_ALPHA)
  love.graphics.rectangle("fill", pillX, centerY - pillH / 2, pillW, pillH, pillH / 2, pillH / 2)
  love.graphics.setColor(1, 1, 1, 0.35)
  love.graphics.setLineWidth(2)
  love.graphics.rectangle("line", pillX, centerY - pillH / 2, pillW, pillH, pillH / 2, pillH / 2)
  love.graphics.setLineWidth(1)

  -- A slow breathing pulse rather than a hard blink.
  local alpha = 0.6 + 0.4 * (0.5 + 0.5 * math.sin(love.timer.getTime() * PROMPT_PULSE_SPEED))

  local prevFont = love.graphics.getFont()
  love.graphics.setFont(font)

  local function text(s, tx)
    love.graphics.setColor(0, 0, 0, 0.7 * alpha)
    love.graphics.print(s, tx + 3, textY + 3)
    love.graphics.setColor(1, 1, 1, alpha)
    love.graphics.print(s, tx, textY)
  end

  text(before, x)
  if icon then
    love.graphics.setColor(1, 1, 1, alpha)
    love.graphics.draw(icon, math.floor(x + beforeW + PROMPT_ICON_GAP), math.floor(centerY - PROMPT_ICON_HEIGHT / 2),
      0, iconScale, iconScale)
  end
  text(after, x + beforeW + middleW)

  love.graphics.setFont(prevFont)
  love.graphics.setColor(1, 1, 1, 1)
end

-- Call last in love.draw, in screen space (after the camera transform
-- is popped) — the prompt while the title is up, and the black fade
-- across the cut into gameplay.
function TitleScreen.draw()
  if state.titleScreen then
    drawLogo()
    drawPrompt()
  end
  if fadeAlpha > 0 then
    love.graphics.setColor(0, 0, 0, fadeAlpha)
    love.graphics.rectangle("fill", 0, 0, love.graphics.getWidth(), love.graphics.getHeight())
    love.graphics.setColor(1, 1, 1, 1)
  end
end

return TitleScreen
