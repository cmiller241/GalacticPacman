-- main.lua
--
-- love.load builds the world; love.update and love.draw run each frame as
-- a list of named steps, in order. Debug overlays are in
-- lua/debug/DebugDraw.lua, the HUD text in lua/ui/Hud.lua, and the start
-- positions and teleport list in lua/setup/StartPositions.lua.

local state = require("lua.state")
local constants = require("lua.constants")
local Planetoid = require("lua.world.Planetoid")
local StompBurst = require("lua.effects.StompBurst")
local TitleScreen = require("lua.ui.TitleScreen")
local PauseMenu = require("lua.ui.PauseMenu")
local GravitySystem = require("lua.systems.GravitySystem")
local CollisionSystem = require("lua.systems.CollisionSystem")
local Starfield = require("lua.world.Starfield")
local Sun = require("lua.world.Sun")
local PullBeam = require("lua.effects.PullBeam")
local assetLoading = require("lua.setup.assetLoading")
local inputHandlers = require("lua.setup.InputHandlers")
local gamepadInput = require("lua.setup.GamePadInput")
local worldGen = require("lua.setup.WorldGen")
local StartPositions = require("lua.setup.StartPositions")
local World = require("lua.levels.World")
local WorldObjects = require("lua.systems.WorldObjects")
local Projectiles = require("lua.systems.Projectiles")
local Breakage = require("lua.systems.Breakage")
local Camera = require("lua.systems.Camera")
local GrassBlades = require("lua.effects.GrassBlades")
local MiniMap = require("lua.ui.MiniMap")
local BeltOrbit = require("lua.systems.BeltOrbitSystem")
local utils = require("lua.utils")
local LockOutline = require("lua.effects.LockOutline")
local VatsOverlay = require("lua.effects.VatsOverlay")
local VatsCursor = require("lua.effects.VatsCursor")
local PortalGun = require("lua.systems.PortalGun")
local WaterSystem = require("lua.systems.WaterSystem")
local ClipRecorder = require("lua.systems.ClipRecorder")
local Recall = require("lua.systems.Recall")
local CharacterShadows = require("lua.effects.CharacterShadows")
local TileGlow = require("lua.effects.TileGlow")
local FireBarGlow = require("lua.effects.FireBarGlow")
local Cannon = require("lua.world.Cannon")
local MissileOutpost = require("lua.world.MissileOutpost")
local CameraShake = require("lua.effects.CameraShake")
local WeaponModes = require("lua.systems.WeaponModes")
local WeaponBar = require("lua.ui.WeaponBar")
local DebugDraw = require("lua.debug.DebugDraw")
local Hud = require("lua.ui.Hud")
local Profiler = require("lua.debug.Profiler")

-- =====================================================================
-- START POSITION (for testing)
-- =====================================================================
-- Where Bob starts the game, and where every respawn puts him back.
-- Set START_AT to one of:
--
--   "shelter"     normal game start: behind the Space Shelter's door,
--                 with its door-opening intro
--   "mining"      on top of the mining planet (and its prisms)
--   "fisherman"   just above the fisherman's rounded-rectangle planet,
--                 left of the fisherman, dropping onto it
--   "cracked"     just above the cracked planet, dropping onto it
--   "tiled"       just above the Tiled planet over map column
--                 TILED_START_COLUMN (needs World.SHOW.tiledPlanet — see lua/levels/World.lua)
--   "tunnel"      on the sky dome's ground just left of Level1's ball
--                 tunnel (curl into a ball to roll through it)
--   "pinball"     on the pinball table's plunger, already a ball
--   "expressway"  on the expressway's entry planet, beside its cannon
--                 (needs World.SHOW.expressway — see lua/levels/World.lua)
--
-- If the planet you pick is switched off, he starts at the shelter and
-- the console says why. T in game opens a list of the same places.
local START_AT = "fisherman"
local TILED_START_COLUMN = 146 -- counting from 0, like Tiled (146: over the middle of Level2's cracked, poundable column)

local collisionSystem

-- Reused every frame rather than built fresh each time: the planetoids
-- the collision passes check (see runWorldCollisions), which of them are
-- immovable, and the camera nudged by screen shake.
local collidablePlanetoids, immovablePlanetoids = {}, {}
local shakenCamera = { x = 0, y = 0 }
-- An empty list for `ipairs(state.cannons or NONE)` and the like, when a
-- world list doesn't exist — instead of a new empty table every frame.
-- Read-only: nothing may add to it.
local NONE = setmetatable({}, { __newindex = function() error("main.lua: NONE is read-only") end })

-- Upward speed (world units per baseline frame) the player hops off a
-- freshly flattened Ooomba with — a small rebound, well under a jump.
local OOOMBA_STOMP_BOUNCE = 7
-- V.A.T.S. slow motion: the time scale it eases to, how fast (per
-- baseline frame), and how close counts as there.
local VATS_TIME_SCALE = 0.05
local VATS_EASE_RATE = 0.12
local VATS_EASE_SNAP_THRESHOLD = 0.005
-- Frame time is measured in 60fps frames, clamped to a 20fps floor so a
-- stall can't fling anything through geometry.
local FPS_BASELINE = 60
local MAX_FRAME_DT = 0.05

-- =====================================================================
-- LOAD
-- =====================================================================
-- love.load runs once at startup, and again in full every time the pause
-- menu's EXIT TO TITLE is chosen. Rebuilding the whole world is what
-- makes a fresh game fresh: every Ooomba back, every lever reset, every
-- coin uncollected. Only one-time setup (window, assets, input
-- callbacks) is skipped on later runs.
local hasLoadedOnce = false

-- Empties everything a previous run of love.load left in `state`. Most
-- lists are assigned fresh in love.load, but a few are only appended to
-- there and would otherwise keep last game's contents.
local function resetWorldState()
  state.planetoids, state.enemies = {}, {}
  -- Every object list the registry knows (levers, coins, fish, ...).
  WorldObjects.reset()

  state.tiledLevels, state.recallables = nil, nil
  state.zoomWindows, state.deathZones = nil, nil
  state.pinballPlanet, state.waterPlanet, state.waterCore, state.roundedRectPlanet = nil, nil, nil, nil
  state.crackedPlanet, state.tiledPlanet = nil, nil
  state.beltLandingPlanet = nil
  state.miningPlanet = nil
  state.cannons, state.clearLanes = nil, nil
  state.expressway, state.expresswayExits = nil, nil
  state.outposts, state.missiles = nil, nil
  state.portals, state.portalTracers = nil, nil
  WeaponModes.set("fireball")
  WaterSystem.reset()
  Recall.reset()

  Camera.reset()
  state.cameraDirector = nil
  state.dialogueActive = false
  state.paused = false
  state.keys = {}
  state.mouseDown = false
  state.vatsWasActive = false
  state.gamepadPullHeld = false

  -- Twice: the first pass runs finalizers, the second frees what they released.
  collectgarbage()
  collectgarbage()
end

function love.load()
  local firstLoad = not hasLoadedOnce
  hasLoadedOnce = true

  if firstLoad then
    love.window.setTitle("Asteroid Bob")

    if not love.window.getFullscreen() then
      love.window.maximize()
    end
  end

  -- Pixel-art default (crisp tiles, no seams between atlas tiles).
  love.graphics.setDefaultFilter("nearest", "nearest")

  resetWorldState()
  worldGen.initWorldSize()

  state.timeScale = 1
  state.timeScaleTarget = 1
  state.vatsMultiplier = 1
  state.showCollisionDebug = false
  state.showBeltCellDebug = false
  state.showInfluenceRings = false
  state.scriptsCompleted = {}
  state.vatsActive = false
  state.vatsAutoEnterOnLock = false
  state.vatsTimeScale = VATS_TIME_SCALE
  state.score = 0
  state.elements = { rubinium = 0, asteroidium = 0 } -- how much of each he's mined (see lua/entities/ElementPiece.lua)
  state.level = 1
  state.cellCheckTimer, state.beltSpawnTimer = 0, 0
  state.minimap = MiniMap.new()

  if firstLoad then
    assetLoading.loadAssets()
    inputHandlers.attachInputHandlers()
    -- EXIT TO TITLE: run this whole function again.
    PauseMenu.onExitToTitle = function() love.load() end
    PauseMenu.onTeleportKey = StartPositions.openTeleportList
  end

  collisionSystem = CollisionSystem.new()
  state.starfield = Starfield.new()

  -- Every hand-placed landmark, the dome's Tiled interior and the player
  -- (see lua/levels/World.lua).
  local world = World.build()

  -- The testing start spot (START_AT, top of this file), now that every
  -- planet it could pick exists.
  StartPositions.init({
    shelterRespawnPoint = state.respawnPoint,
    expresswayEntry = world.expresswayEntry,
    tiledStartColumn = TILED_START_COLUMN,
  })
  StartPositions.apply(START_AT)

  -- Stream the 3x3 around the house (after the dome exists, so cells
  -- steer clear of it).
  worldGen.generateStartingNeighborhood(World.HOME_CELL_COL, World.HOME_CELL_ROW)

  state.sun = Sun.new(state.sceneWidth / 2, state.sceneHeight / 2, 1920)

  state.gravitySystem = GravitySystem.new(state.planetoids)

  -- The title screen borrows the player until start is pressed.
  TitleScreen.enter(not firstLoad)

  -- Pointed at the player from the very first frame (love.update keeps
  -- it current from here on).
  Camera.pointAtPlayer()
end

-- =====================================================================
-- UPDATE
-- =====================================================================

-- Is he anywhere in the Sky Dome level? Standing on (or last pulled by)
-- the dome's deck or any of its Tiled level's tiles (each tile is its own
-- "planet" — see shape.inSkyDome where the level is loaded), or simply
-- somewhere inside the dome's glass, e.g. mid-jump or shot from a plunger.
local function isInSkyDome(player)
  local dome = state.skyDomePlanet
  if not dome then return false end
  local planet = player.currentPlanet or player.lastInfluencePlanet
  if planet and (planet == dome or planet.inSkyDome) then return true end
  return dome:containsPoint(player.pos.x, player.pos.y)
end

-- Is he in one of the asteroid belt's cells (the same cells the belt-cell
-- debug overlay highlights — see worldGen.cellIntersectsBelt)?
local function isInBeltCell(player)
  local col = math.floor(player.pos.x / worldGen.CELL_SIZE)
  local row = math.floor(player.pos.y / worldGen.CELL_SIZE)
  return worldGen.cellIntersectsBelt(col, row)
end

-- Which background music should be playing right now (a track name from
-- lua/AudioManager.lua's MUSIC table, or nil for none). None on the
-- title screen. The Sky Dome wins where it overlaps belt cells.
local function musicForPlayer()
  if state.titleScreen or not state.player then return nil end
  if isInSkyDome(state.player) then return 'skyDome' end
  if isInBeltCell(state.player) then return 'belt' end
  return nil
end

-- V.A.T.S. (Triangle — see GamePadInput.lua): while it's active he only
-- picks a pull target; walking, jumping and firing are refused (see
-- noSteering in movePlayer, and the Player methods that check
-- state.vatsActive). A pull already under way carries on even with L2
-- released, which lets him chain pulls without landing.
--
-- The moment it ends: whatever was locked is unlocked, and a pull that
-- nobody is holding L2 (or the right mouse button) for is dropped.
local function handleVatsEnd()
  if state.vatsWasActive and not state.vatsActive and state.player then
    state.player:clearLockTarget()
    if state.player.pullTarget and not (state.gamepadPullHeld or love.mouse.isDown(1)) then
      state.player:clearPullTarget()
    end
  end
  state.vatsWasActive = state.vatsActive
end

-- Sets state.timeScale, which everything that moves multiplies its
-- per-frame movement by. It's this frame's length in 60fps frames (1.0 at
-- exactly 60fps, so all the tuning written for 60fps holds at any frame
-- rate), times the V.A.T.S. slow-motion ease, times a cannon shot's
-- hit-stop (see Cannon.timeFactor).
local function updateTimeScale(dt)
  local frameNorm = math.min(dt, MAX_FRAME_DT) * FPS_BASELINE

  state.timeScaleTarget = state.vatsActive and VATS_TIME_SCALE or 1
  local timeScaleDiff = state.timeScaleTarget - state.vatsMultiplier
  if math.abs(timeScaleDiff) < VATS_EASE_SNAP_THRESHOLD then
    state.vatsMultiplier = state.timeScaleTarget
  else
    state.vatsMultiplier = state.vatsMultiplier + timeScaleDiff * math.min(VATS_EASE_RATE * frameNorm, 1)
  end

  state.timeScale = state.vatsMultiplier * frameNorm * Cannon.timeFactor()
end

-- Drifting planetoids move and bounce off the edges of the world.
local function updatePlanetoidsPhysics()
  for _, p in ipairs(state.planetoids) do
    if p.recalling then
      -- Rewinding: Recall.update moves it (see lua/systems/Recall.lua).
    elseif p.isImmovable then
      p.vel.x, p.vel.y = 0, 0
    else
      p.pos:addScaled(p.vel, state.timeScale)

      if p.pos.x - p.radius < 0 then
        p.pos.x = p.radius
        p.vel.x = -p.vel.x
      end
      if p.pos.x + p.radius > state.sceneWidth then
        p.pos.x = state.sceneWidth - p.radius
        p.vel.x = -p.vel.x
      end
      if p.pos.y - p.radius < 0 then
        p.pos.y = p.radius
        p.vel.y = -p.vel.y
      end
      if p.pos.y + p.radius > state.sceneHeight then
        p.pos.y = state.sceneHeight - p.radius
        p.vel.y = -p.vel.y
      end
    end
  end
end

-- Planetoids, and everything in the world's object lists. All of this
-- runs before the player moves, so he's carried along by whatever he's
-- standing on.
local function updateWorld(dt)
  updatePlanetoidsPhysics()

  -- Planetoids that turn on the spot (see CrystalPlanet.lua).
  for _, p in ipairs(state.planetoids) do
    if p.updateRotation and not p.recalling then p:updateRotation(state.timeScale) end
  end

  -- START_AT = "mining": keeps the respawn point on top of the drifting planet.
  if state.respawnPoint and state.respawnPoint.followsPlanet then
    local point, planet = state.respawnPoint, state.respawnPoint.planet
    point.x, point.y = planet.pos.x, planet.pos.y - planet.radius - constants.PLAYER_RADIUS
  end

  -- Planetoids with their own movement (SphereMove's patrol path, so far).
  for _, p in ipairs(state.planetoids) do
    if p.update and not p.recalling then p:update() end
  end

  -- Rewinding planetoids moved back along their recorded paths, and every
  -- planetoid's path recorded (see lua/systems/Recall.lua).
  Recall.update(dt)

  -- Rope rocks, asteroids, coins, Ooombas, fire bars, levers, fish, NPCs,
  -- ... (order and details: lua/systems/WorldObjects.lua).
  WorldObjects.update("world", dt)

  -- Player.lua reads this to freeze him while any conversation is showing.
  state.dialogueActive = WorldObjects.anyDialogueActive()
end

-- Walking input. On the title screen its autopilot steers him (see
-- TitleScreen.lua). No steering during the opening cutscene, inside the
-- pinball table, in V.A.T.S., or in or shot from a cannon.
local function movePlayer(player)
  if state.titleScreen then
    player:move(TitleScreen.getKeys())
    return
  end
  local noSteering = state.introLocked or player.inPinball or state.vatsActive
    or player.inCannon or player.cannonFlight
  -- Standing, he can't walk or run into a gap lower than he is tall — a
  -- ball tunnel (see TiledTerrain.lua's Level:headroomAt) — unless he's
  -- already somewhere that low.
  local level = state.tiledLevels and state.tiledLevels[1]
  local px, py, parc = player.pos.x, player.pos.y, player.surfaceArcPos
  local hadRoom = level and player.onSurface and not player.isBall and level:headroomAt(px, py, player.radius)
  player:move(noSteering and {} or state.keys)
  if hadRoom and player.onSurface and not player.isBall and not level:headroomAt(player.pos.x, player.pos.y, player.radius) then
    player.pos.x, player.pos.y, player.surfaceArcPos = px, py, parc
    player.isWalking = false
    player.groundMoveSpeedX = 0
  end
end

-- Ooombas are lethal to touch unless landed on from above (see
-- CollisionSystem:handlePlayerOoombaCollisions). Each one squashed flat
-- this frame is removed, with a burst on the ground under his feet (or
-- where it stood, if he's no longer on top of it) and a small hop for
-- him. "Up" is the Ooomba's own up (Ooomba.up): up the screen on
-- terrain, out from the center on a round planetoid; the hop is relative
-- to what it was standing on, which may be moving. Skipped on the title
-- screen: he can't die before the game starts.
local function handleOoombaStomps(player)
  if not (state.ooombas and #state.ooombas > 0) or state.titleScreen then return end
  local flattened = collisionSystem:handlePlayerOoombaCollisions(player, state.ooombas)
  for _, o in ipairs(flattened) do
    local up = o.up
    local groundX, groundY = o.pos.x - up.x * o.halfHeight, o.pos.y - up.y * o.halfHeight
    if o.squashPressed then
      -- The point on the ground directly beneath him.
      local sideways = (player.pos.x - o.pos.x) * -up.y + (player.pos.y - o.pos.y) * up.x
      StompBurst.spawn(groundX + -up.y * sideways, groundY + up.x * sideways, up)
      if not player.onSurface then
        local groundVelX, groundVelY = o:groundVelocity()
        local rising = (player.vel.x - groundVelX) * up.x + (player.vel.y - groundVelY) * up.y
        player.vel.x = player.vel.x + up.x * (OOOMBA_STOMP_BOUNCE - rising)
        player.vel.y = player.vel.y + up.y * (OOOMBA_STOMP_BOUNCE - rising)
        player.isGroundPounding = false
      end
    else
      StompBurst.spawn(groundX, groundY, up)
    end
    if state.audioManager then state.audioManager:playGoombaStomp() end
    for i = #state.ooombas, 1, -1 do
      if state.ooombas[i] == o then table.remove(state.ooombas, i) end
    end
  end
end

-- The player for one frame: moving, gravity (or whatever replaces it),
-- cannons, portals, firing, and his collisions with the world.
-- `fire` is true when he should shoot this frame.
local function updatePlayer(player, fire)
  -- Going through a portal: he follows its path instead of everything
  -- below (see lua/systems/PortalGun.lua).
  if player.portalTransit then
    PortalGun.updateTransit(player, state.timeScale)
    return
  end

  movePlayer(player)

  -- Inside the pinball table its own ball physics replace gravity and
  -- planet collision (see lua/interiors/PinballInterior.lua). No gravity
  -- in a cannon or on a cannon shot either.
  if player.inPinball then
    local jumpHeld = state.keys[' '] or state.gamepadJumpHeld or false
    player.inPinball:updateBall(player, state.timeScale, jumpHeld)
  elseif player.pullTarget then
    player:applyPullForce()
  elseif not (player.inCannon or player.cannonFlight) then
    state.gravitySystem:applyTo(player)
  end

  -- Timers, teleport, ball morph, invincibility, ... (always runs).
  player:update()

  -- Cannons swallowing, aiming and firing him, his flight once fired,
  -- and then the coins down their routes (see lua/world/Cannon.lua).
  for _, cannon in ipairs(state.cannons or NONE) do
    cannon:update(player, state.timeScale)
  end
  Cannon.updateFlight(player, state.timeScale)
  for _, cannon in ipairs(state.cannons or NONE) do
    cannon:updateCoins(player, state.timeScale / 60)
  end

  -- Before collision, so landing on a floor portal doesn't stop his fall
  -- first (see PortalGun.tryEnter).
  PortalGun.tryEnter(player)

  if not player.inPinball and not player.inCannon then
    collisionSystem:handlePlayerPlanetCollisions(player)
  end

  -- shootFireball / shootIceBolt throttle the fire rate themselves.
  if fire then
    if state.iceMode then player:shootIceBolt() else player:shootFireball() end
  end

  -- Wall and Spikey collisions only ever set these, so they're cleared
  -- first to mean "touching this frame" (Player:jump's wall jump reads them).
  player.touchingWall = nil
  player.wallContactNormal = nil

  for _, level in ipairs(state.tiledLevels or NONE) do
    collisionSystem:handlePlayerWallCollisions(player, level.walls)
    -- Ball-tunnel pieces, and (standing, in the air) his head.
    level:pushPlayer(player)
  end
  -- Plungers: solid to him, loaded by pushing into them, fire him when he
  -- lets go (see lua/world/Plunger.lua).
  for _, plunger in ipairs(state.plungers or NONE) do plunger:update(player, state.timeScale) end

  collisionSystem:handlePlayerSpikeyCollisions(player, state.spikeys)
  handleOoombaStomps(player)
  collisionSystem:handlePlayerSkyDomeContainment(player, state.skyDomePlanet)
end

-- Collisions between everything that isn't the player, plus coin pickups.
local function runWorldCollisions()
  -- Belt planetoids can number in the hundreds, nearly all off screen,
  -- where bumping into each other has no visible payoff — so off-screen
  -- ones are left out of every planetoid collision pass below. Other
  -- planetoids are few, and always collide.
  local count = 0
  for _, p in ipairs(state.planetoids) do
    if not p.isBeltPlanetoid or utils.isOnScreen(p.pos.x, p.pos.y, p.radius, 50) then
      count = count + 1
      collidablePlanetoids[count] = p
    end
  end
  for i = #collidablePlanetoids, count + 1, -1 do collidablePlanetoids[i] = nil end -- (last frame's extras)

  -- Movable planetoids bounce off each other (pairs with an immovable
  -- one are skipped)...
  collisionSystem:handleElasticCollisions(collidablePlanetoids)

  -- ...and off the immovable ones' (the sky dome's, the Tiled hills')
  -- true surfaces. Asteroids aren't included: they break against a
  -- planet instead (handlePlanetAsteroidCollisions below).
  local immovableCount = 0
  for _, p in ipairs(collidablePlanetoids) do
    if p.isImmovable then
      immovableCount = immovableCount + 1
      immovablePlanetoids[immovableCount] = p
    end
  end
  for i = #immovablePlanetoids, immovableCount + 1, -1 do immovablePlanetoids[i] = nil end
  if immovableCount > 0 then
    collisionSystem:handleImmovableCollisions(immovablePlanetoids, collidablePlanetoids)
  end

  -- Fire bars are a hazard to him (not on the title screen) and solid to
  -- asteroids. Planetoids pass through them: bouncing off fought the
  -- belt's orbit and pooled planetoids round each bar.
  if state.fireBars and #state.fireBars > 0 then
    if not state.titleScreen then
      collisionSystem:handlePlayerFireBarCollisions(state.player, state.fireBars)
    end
    if state.asteroids and #state.asteroids > 0 then
      collisionSystem:handleImmovableCollisions(state.fireBars, state.asteroids)
    end
  end

  -- Asteroids bounce off each other, and break apart on hitting a
  -- planetoid (see Breakage.breakAsteroid). They aren't lethal to him.
  if state.asteroids and #state.asteroids > 0 then
    collisionSystem:handleElasticCollisions(state.asteroids)
    local toBreak = collisionSystem:handlePlanetAsteroidCollisions(collidablePlanetoids, state.asteroids)
    for asteroid, planet in pairs(toBreak) do
      Breakage.breakAsteroid(asteroid, planet)
    end
  end

  -- On the title screen too: his autopilot collects coins (the score is
  -- wiped when the game starts — see TitleScreen.lua's beginGame).
  if state.coins then
    collisionSystem:handleCoinCollisions(state.player, state.coins)
  end
end

-- Portals, water, projectiles, effects, the belt's orbit and the sun.
local function updateSystems(dt)
  -- Portals follow whatever they're stuck to and emit their particles;
  -- the shot streaks fade (see lua/systems/PortalGun.lua).
  PortalGun.update(dt)
  -- Spraying, droplets, and water flowing/pooling/evaporating.
  Profiler.start("water")
  WaterSystem.update(dt)
  Profiler.stop("water")
  -- The water blaster's hiss while he sprays (see lua/AudioManager.lua).
  if state.audioManager then
    state.audioManager:updateSpray(WaterSystem.isSpraying(),
      WaterSystem.totalWater() >= WaterSystem.waterCap(), dt)
  end

  -- Fireballs and ice bolts: moving, through portals, and everything they
  -- can hit (see lua/systems/Projectiles.lua).
  Profiler.start("projectiles")
  Projectiles.update(collisionSystem, collidablePlanetoids)
  Profiler.stop("projectiles")

  -- Explosions, wall-jump contact rings and debris particles.
  WorldObjects.update("effects", dt)

  BeltOrbit.apply(state.planetoids)

  if state.sun then
    state.sun:update()
  end
end

-- World streaming and the belt's drip, every so many seconds of real time
-- (so neither runs more often at a higher frame rate).
local function updateStreaming(dt)
  state.cellCheckTimer = (state.cellCheckTimer or 0) + dt
  if state.cellCheckTimer >= worldGen.CELL_CHECK_SECONDS then
    state.cellCheckTimer = 0
    worldGen.updateActiveCells()
  end

  state.beltSpawnTimer = (state.beltSpawnTimer or 0) + dt
  if state.beltSpawnTimer >= worldGen.BELT_SPAWN_SECONDS then
    state.beltSpawnTimer = 0
    worldGen.updateBeltSpawning()
  end
end

-- One frame of the game (love.update below times it as a whole).
local function updateGame(dt)
  if dt > 0 then
    state.fps = (state.fps or 0) * 0.9 + (1 / dt) * 0.1
  end

  -- Polled even while paused: it's what drives the pause menu.
  gamepadInput.pollGamepad(dt)
  if PauseMenu.isOpen() then return end

  handleVatsEnd()
  TitleScreen.update(dt)
  VatsCursor.update(dt)

  -- Background music fades to suit where he is (see lua/AudioManager.lua).
  if state.audioManager then state.audioManager:updateMusic(musicForPlayer(), dt) end

  updateTimeScale(dt)
  Profiler.start("world")
  updateWorld(dt)
  Profiler.stop("world")

  -- A left click since last frame (see InputHandlers.lua) fires once he's
  -- moved, and is dropped if he can't fire this frame. R2 fires for as
  -- long as it's held.
  local mouseFire = state.mouseFirePending
  state.mouseFirePending = false
  Profiler.start("player")
  updatePlayer(state.player, state.gamepadFireHeld or mouseFire)
  Profiler.stop("player")

  Profiler.start("collisions")
  runWorldCollisions()
  Profiler.stop("collisions")
  Profiler.start("systems")
  updateSystems(dt)
  Profiler.stop("systems")
  Profiler.start("streaming")
  updateStreaming(dt)
  Profiler.stop("streaming")

  -- Zoom and camera position for this frame (see lua/systems/Camera.lua).
  Camera.update(dt)
end

-- (Timing for the F3 profiler — see lua/debug/Profiler.lua.)
function love.update(dt)
  Profiler.start("update")
  updateGame(dt)
  Profiler.stop("update")
end

-- =====================================================================
-- DRAW
-- =====================================================================

-- Everything up to the planetoids: stars are drawn before this, in
-- screen space.
local function drawBackground()
  -- Bob's and the Ooombas' shadow shapes for this frame (see
  -- lua/effects/CharacterShadows.lua) — up front, since the Space Shelter
  -- just below takes them, as well as the level's tiles further down.
  CharacterShadows.prepare()

  if state.skyDomePlanet then
    state.skyDomePlanet:draw()
    -- Tufts of grass blades along its deck (see lua/effects/GrassBlades.lua).
    GrassBlades.draw(state.skyDomePlanet.grassBlades)
  end

  -- The shelter sits between the dome's background hex layer (drawn by
  -- :draw() above) and its foreground glass (drawForegroundGlass, near
  -- the end). Its door is drawn here once he's stepped out in front of it
  -- (see SpaceShelter.lua's intro); until then it's drawn after him, so
  -- the closed door covers him.
  if state.spaceShelter then
    local shelter = state.spaceShelter
    shelter:drawBody()
    if shelter.playerInFront then
      shelter:drawDoor()
      -- His shadow on the shelter and its doors, only once he's in front.
      CharacterShadows.drawOntoSprite(function()
        shelter:drawBody()
        shelter:drawDoor()
      end)
    end
  end

  if state.sun then
    state.sun:draw()
  end

  -- Asteroids. Each WorldObjects layer skips its own off-screen items
  -- (see lua/systems/WorldObjects.lua). Updates still run for everything.
  WorldObjects.draw("backdrop")

  DebugDraw.influenceRings()

  -- Prisms: before the planetoids, so the one each stands on covers its
  -- sunken foot (see lua/world/Prism.lua).
  WorldObjects.draw("planetFeet")
end

-- Planetoids, cannons, hazards and the Tiled levels.
local function drawTerrain()
  -- The fire bars' fireballs lighting up the planets near them (see
  -- lua/effects/FireBarGlow.lua) — added over each one right after it's drawn.
  FireBarGlow.prepare()
  for _, p in ipairs(state.planetoids) do
    -- The dome already drew above. Water planets draw after the player,
    -- so he looks submerged in them.
    if p ~= state.skyDomePlanet and not p.isWaterPlanet and utils.isOnScreen(p.pos.x, p.pos.y, p.radius, 50) then
      p:draw()
      FireBarGlow.drawOnto(p)
      -- (The pinball planet's table — see lua/interiors/PinballInterior.lua.)
      if p.interior then
        p.interior:draw()
      end
    end
  end

  -- The belt outposts' missile cannons (see lua/world/MissileOutpost.lua).
  MissileOutpost.drawCannons(state.outposts)

  -- Cannons on their planets, and the rails along their routes (see
  -- lua/world/Cannon.lua).
  for _, cannon in ipairs(state.cannons or NONE) do
    cannon:drawRails()
    if not cannon.isTrack then -- (a track's just rails: no cannon of its own)
      local px, py = cannon:pivot()
      if utils.isOnScreen(px, py, 400, 50) then cannon:draw() end
    end
  end

  -- Recall's yellow overlay on rewinding planetoids (and the aim ring).
  Recall.draw()

  -- Spikeys (lua/world/Spikey.lua) — not planetoids, so not drawn above.
  WorldObjects.draw("hazards")

  if state.tiledLevels then
    -- Glowing things (fireballs, lava, portals, ...) lighting the tiles
    -- up (see lua/effects/TileGlow.lua).
    TileGlow.prepare()
    for _, level in ipairs(state.tiledLevels) do
      if utils.isOnScreen(level.pos.x, level.pos.y, level.radius, 50) then
        level:draw()
        CharacterShadows.drawOnto(level)
        TileGlow.drawOnto(level)
        -- Tufts of grass blades poking out of its grass (see lua/effects/GrassBlades.lua).
        GrassBlades.draw(level.grassBlades)
        DebugDraw.levelShapes(level)
      end
    end
  end

  -- Rope rocks, gates, levers, plungers, cranks, signs, mirrors.
  WorldObjects.draw("props")

  DebugDraw.beltCells()
end

-- Enemies, NPCs, the player, and what stands in front of him.
local function drawActors()
  WorldObjects.draw("enemies")

  -- The belt outposts' missiles, in flight (see lua/world/MissileOutpost.lua).
  MissileOutpost.drawMissiles()

  -- Robot butler, fisherman, coins, fire bars, beams. Beams are drawn
  -- before the player, so he stands in front of one he's at.
  WorldObjects.draw("actors")

  -- Portals and their shot streaks: over the surfaces they're on,
  -- behind the player.
  PortalGun.draw()

  -- (Split across the two portals while he's going through one.)
  Cannon.drawFlightTrail(state.player)
  PortalGun.drawPlayer(state.player)

  -- The grass tufts that stand in front of Bob and the Ooombas (the rest
  -- were drawn behind, with their ground — see lua/effects/GrassBlades.lua).
  if state.skyDomePlanet then GrassBlades.draw(state.skyDomePlanet.grassBlades, true) end
  for _, level in ipairs(state.tiledLevels or NONE) do
    GrassBlades.draw(level.grassBlades, true)
  end

  -- Water and spray, over him, so he looks like he's in it when swimming.
  WaterSystem.draw()

  DebugDraw.collisionShapes()
end

-- Water, lava, effects and overlays, over the player.
local function drawForeground()
  -- Fish, then lava: after the player and before the water's top layer,
  -- so water and lava cover whatever is in them.
  WorldObjects.draw("submerged")

  -- Every planetoid's water layer (the water planets' included — see
  -- WaterPlanet.lua) and steam, over the player and the fish.
  WaterSystem.drawOceans()

  -- Bubbles on top of the water's translucent fill.
  state.player:drawBubbles()
  for _, fish in ipairs(state.fish or NONE) do
    fish:drawBubbles()
  end

  -- The shelter door, over him while it's still closed or opening (see
  -- drawBackground).
  if state.spaceShelter and not state.spaceShelter.playerInFront then
    state.spaceShelter:drawDoor()
  end

  PullBeam.draw()

  -- Fireballs, ice bolts, particles, element pieces, explosions,
  -- wall-jump rings.
  WorldObjects.draw("effects")

  if state.skyDomePlanet then
    state.skyDomePlanet:drawForegroundGlass()
  end

  VatsOverlay.draw()
  LockOutline.draw()
end

-- Screen-space UI: minimap, blaster bar, dialogue, HUD text, pause menu.
local function drawInterface()
  -- A cannon shot's speed lines, streaking past the screen's edges (see
  -- Cannon.drawSpeedLines) — over the world, under everything else.
  Cannon.drawSpeedLines(state.player)

  VatsCursor.drawReticle()

  -- Title screen: just the scene and its own prompt.
  if state.titleScreen then
    TitleScreen.draw()
    return
  end

  if state.minimap then
    state.minimap:draw()
  end

  -- Blaster selector, lower-left (see lua/ui/WeaponBar.lua). Hidden
  -- while a conversation textbox is up, so the box has the bottom of the
  -- screen to itself.
  if not state.dialogueActive then
    WeaponBar.draw()
  end

  -- Conversation textboxes — after the minimap, so the box covers it.
  WorldObjects.drawDialogues()

  -- Kept out of recorded trailer clips (P - see lua/systems/ClipRecorder.lua).
  if not ClipRecorder.isRecording() then
    Hud.draw()
  end

  PauseMenu.draw()

  -- The black fade-in out of the title screen, over everything.
  TitleScreen.draw()
end

-- One frame's picture (love.draw below times it, and adds the profiler).
local function drawGame()
  Planetoid.beginFrame()
  state.starfield:draw(state.camera, state.visibleWidth, state.visibleHeight)

  love.graphics.push()
  love.graphics.scale(state.zoom, state.zoom)
  -- Snapped to whole screen pixels, so the pixel art doesn't shimmer as
  -- the camera moves. state.camera itself stays exact.
  local zoom = state.zoom
  love.graphics.translate(-math.floor(state.camera.x * zoom + 0.5) / zoom,
                          -math.floor(state.camera.y * zoom + 0.5) / zoom)

  Profiler.start("background")
  drawBackground()
  Profiler.stop("background")
  Profiler.start("terrain")
  drawTerrain()
  Profiler.stop("terrain")
  Profiler.start("actors")
  drawActors()
  Profiler.stop("actors")
  Profiler.start("foreground")
  drawForeground()
  Profiler.stop("foreground")

  love.graphics.pop()

  Profiler.start("interface")
  drawInterface()
  Profiler.stop("interface")
end

function love.draw()
  Profiler.start("draw")
  drawGame()
  Profiler.stop("draw")
  -- F3's timings, kept out of recorded trailer clips.
  if not ClipRecorder.isRecording() then Profiler.draw() end
  Profiler.endFrame()
end

-- Screen shake (see lua/effects/CameraShake.lua): the camera nudged by
-- this moment's shake for the draw only, and put back after — so the
-- whole scene jolts on screen, but nothing that reads state.camera to
-- decide anything (streaming, culling, aiming) is ever thrown off by it.
do
  local drawFrame = love.draw
  function love.draw()
    local camera = state.camera
    local sx, sy = CameraShake.offset()
    if camera and (sx ~= 0 or sy ~= 0) then
      local zoom = state.zoom or 1
      shakenCamera.x, shakenCamera.y = camera.x + sx / zoom, camera.y + sy / zoom
      state.camera = shakenCamera
    end
    drawFrame()
    state.camera = camera
  end
end

-- Trailer clip recording (P - see lua/systems/ClipRecorder.lua).
--   * Debug overlays (collision shapes, belt cells, influence rings) are
--     switched off for recorded frames only, then put back.
--   * Every finished frame is handed to the recorder.
--   * Updates run on a fixed 1/60 s step while recording, so the video
--     plays at perfect speed even if capturing slows the game down.
do
  local drawFrame = love.draw
  function love.draw()
    if ClipRecorder.isRecording() then
      local c, b, r = state.showCollisionDebug, state.showBeltCellDebug, state.showInfluenceRings
      state.showCollisionDebug, state.showBeltCellDebug, state.showInfluenceRings = false, false, false
      drawFrame()
      state.showCollisionDebug, state.showBeltCellDebug, state.showInfluenceRings = c, b, r
      ClipRecorder.captureFrame()
    else
      drawFrame()
    end
  end

  local updateFrame = love.update
  function love.update(dt)
    updateFrame(ClipRecorder.frameDt(dt))
  end

  -- Quitting mid-recording still saves the clip.
  local quit = love.quit
  function love.quit()
    ClipRecorder.shutdown()
    if quit then return quit() end
  end
end
