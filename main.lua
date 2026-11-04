-- main.lua

local state = require("lua.state")
local constants = require("lua.constants")
local Vector2 = require("lua.vector2")
local Planetoid = require("lua.world.Planetoid")
local Asteroid = require("lua.entities.Asteroid")
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
local InfluenceRing = require("lua.effects.InfluenceRing")
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

local collisionSystem

-- Reused every frame rather than built fresh each time: the planetoids
-- the collision passes check (see collidablePlanetoids in love.update),
-- which of them are immovable, and the camera nudged by screen shake.
local collidablePlanetoids, immovablePlanetoids = {}, {}
local shakenCamera = { x = 0, y = 0 }
-- An empty list for `ipairs(state.cannons or NONE)` and the like, when a
-- world list doesn't exist — instead of a new empty table every frame.
-- Read-only: nothing may add to it.
local NONE = setmetatable({}, { __newindex = function() error("main.lua: NONE is read-only") end })

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
-- the console says why.
local START_AT = "fisherman"
local TILED_START_COLUMN = 146 -- counting from 0, like Tiled (146: over the middle of Level2's cracked, poundable column)

-- Each option sets state.respawnPoint (see Player:respawn). Called near
-- the end of love.load, once every planet exists. `expresswayEntry` is
-- { planet, cannon } when the expressway was built, else nil.
local START_POSITIONS = {
  mining = function()
    local planet = state.miningPlanet
    if not planet then return false end
    -- The planet drifts: followsPlanet keeps the point on top of it
    -- every frame (see love.update).
    return {
      x = planet.pos.x, y = planet.pos.y - planet.radius - constants.PLAYER_RADIUS,
      planet = planet, followsPlanet = true,
    }
  end,

  fisherman = function()
    local rect = state.roundedRectPlanet
    if not rect then return false end
    -- No planet named: he lands through the ordinary collision pass.
    return {
      x = rect.pos.x - rect.halfWidth * 0.4,
      y = rect.pos.y - rect.halfHeight - constants.PLAYER_RADIUS - 20,
    }
  end,

  cracked = function()
    local planet = state.crackedPlanet
    if not planet then return false end
    return {
      x = planet.pos.x,
      y = planet.pos.y - planet.radius - constants.PLAYER_RADIUS - 20,
    }
  end,

  tiled = function()
    local planet = state.tiledPlanet
    if not planet then return false end
    local columns = planet.rings[1].count
    local angle = -math.pi / 2 + (TILED_START_COLUMN + 0.5) / columns * 2 * math.pi
    local dist = planet.radius + constants.PLAYER_RADIUS + 20
    return {
      x = planet.pos.x + math.cos(angle) * dist,
      y = planet.pos.y + math.sin(angle) * dist,
    }
  end,

  tunnel = function()
    -- On the sky dome's ground, a few steps left of the ball tunnel's
    -- mouth in Level1 (map column 33, row 35),
    -- dropping onto the floor (row 36).
    local level = state.tiledLevels and state.tiledLevels[1]
    if not level then return false end
    local T = 64
    return {
      x = level.anchorX + 27.5 * T,
      y = level.anchorY + 36 * T - constants.PLAYER_RADIUS - 20,
    }
  end,

  pinball = function()
    if not state.pinballPlanet then return false end
    local portal = state.pinballPlanet.interior:getPortalPosition()
    return { x = portal.x, y = portal.y, pinball = state.pinballPlanet.interior }
  end,

  expressway = function(expresswayEntry)
    if not expresswayEntry then return false end
    -- Standing a little round from the cannon, not in it.
    local entryPlanet, entryCannon = expresswayEntry.planet, expresswayEntry.cannon
    local standAngle = entryCannon.mountAngle - 0.45
    local standDist = entryPlanet.radius + constants.PLAYER_RADIUS
    return {
      x = entryPlanet.pos.x + math.cos(standAngle) * standDist,
      y = entryPlanet.pos.y + math.sin(standAngle) * standDist,
      planet = entryPlanet,
    }
  end,
}

local function applyStartPosition(expresswayEntry)
  if START_AT == "shelter" then return end
  local place = START_POSITIONS[START_AT]
  local point = place and place(expresswayEntry)
  if not point then
    print(string.format('main.lua: START_AT = "%s" %s - starting at the shelter instead.', START_AT,
      place and "but that planet is switched off" or "isn't a known start position"))
    return
  end
  state.respawnPoint = point
  -- He isn't waiting behind the shelter door, so skip its intro.
  state.spaceShelter.playerInFront = true
  state.spaceShelter.introDone = true
end

-- =====================================================================
-- DEBUG TELEPORT (T)
-- =====================================================================
-- T pauses the game with a list of every start position above; picking
-- one puts him there straight away, the same as starting there would
-- (see PauseMenu.openList). It also becomes his respawn point, so dying
-- brings him back to it.
local TELEPORT_PLACES = {
  { key = "shelter", label = "SPACE SHELTER" },
  { key = "mining", label = "MINING PLANET" },
  { key = "fisherman", label = "FISHERMAN'S PLANET" },
  { key = "cracked", label = "CRACKED PLANET" },
  { key = "tiled", label = "TILED PLANET" },
  { key = "tunnel", label = "SKY DOME BALL TUNNEL" },
  { key = "pinball", label = "PINBALL TABLE" },
  { key = "expressway", label = "EXPRESSWAY" },
}

-- Remembered by love.load for the teleport list: the shelter's own
-- respawn point (before START_AT changes it) and the expressway's entry.
local shelterRespawnPoint, expresswayEntry
local lastTeleport = 1 -- the list opens on whichever was picked last

-- Where `key` (a TELEPORT_PLACES key) would put him right now, or nil
-- if that planet is switched off.
local function teleportPoint(key)
  if key == "shelter" then return shelterRespawnPoint end
  return START_POSITIONS[key](expresswayEntry) or nil
end

local function teleportTo(key)
  local player, point = state.player, teleportPoint(key)
  if not (player and point) then return end
  state.respawnPoint = point
  -- (Out of the shelter's intro, if it was still playing.)
  if state.spaceShelter then
    state.spaceShelter.playerInFront = true
    state.spaceShelter.introDone = true
  end
  -- Nothing from where he was comes with him.
  player:clearPullTarget()
  player:clearLockTarget()
  state.vatsActive = false
  player.deathZoneRespawn = nil -- (Player:respawn would go there instead)
  player:respawn()
  -- The camera jumps with him, and the world round him is streamed in
  -- now rather than up to half a second later.
  state.portalCameraGlide = nil
  state.cannonZoomFlying, state.cannonZoomReturn = nil, nil
  Camera.pointAtPlayer()
  worldGen.updateActiveCells()
  state.cellCheckTimer = 0
end

local function openTeleportList()
  local options = {}
  for i, place in ipairs(TELEPORT_PLACES) do
    options[i] = { label = place.label, enabled = teleportPoint(place.key) ~= nil }
  end
  PauseMenu.openList("TELEPORT", options, function(index)
    lastTeleport = index
    teleportTo(TELEPORT_PLACES[index].key)
  end, lastTeleport)
end

-- Upward speed (world units per baseline frame) the player hops off a
-- freshly flattened Ooomba with — a small rebound, well under a jump.
local OOOMBA_STOMP_BOUNCE = 7
-- Opacity of the 'R' gravity rings (see the ring pass in love.draw).
local INFLUENCE_RING_ALPHA_PULLING = 0.9  -- the body whose gravity has hold of him right now
local INFLUENCE_RING_ALPHA_INSIDE = 0.5   -- he's inside its reach, but another body has the stronger claim
local INFLUENCE_RING_ALPHA_NEAR = 0.35    -- he's just outside its reach...
local INFLUENCE_RING_ALPHA_FAR = 0.05     -- ...down to this once he's INFLUENCE_RING_FADE_DISTANCE beyond it
local INFLUENCE_RING_FADE_DISTANCE = 700
local VATS_TIME_SCALE = 0.05
local VATS_EASE_RATE = 0.12
local VATS_EASE_SNAP_THRESHOLD = 0.005

-- love.load runs once when the program starts — and again, in full,
-- every time the pause menu's EXIT TO TITLE is chosen (see
-- lua/ui/PauseMenu.lua and the PauseMenu.onExitToTitle hookup below).
-- Rebuilding the whole world from scratch is what guarantees a fresh
-- game really is fresh: every Ooomba back, every lever and gate in its
-- starting position, every coin uncollected, with no per-object "undo"
-- anywhere to keep in step as the game grows. Only the genuinely
-- one-time setup (window, images/sounds, input callbacks) is skipped on
-- those later runs.
local hasLoadedOnce = false

-- Empties everything a previous run of love.load left in `state`.
-- Most of the world's lists are simply assigned fresh further down, but
-- a few are only ever APPENDED to there (or created with `or {}`), and
-- would otherwise come back with last game's contents still in them.
local function resetWorldState()
  state.planetoids, state.enemies = {}, {}
  -- Every object list the registry knows (levers, coins, fish, ...).
  WorldObjects.reset()

  -- Set only inside conditional blocks below — cleared so nothing from
  -- the last game survives if a block doesn't run.
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

  -- Whatever was in progress.
  Camera.reset()
  state.cameraDirector = nil
  state.dialogueActive = false
  state.paused = false
  state.keys = {}
  state.mouseDown = false
  state.vatsWasActive = false
  state.gamepadPullHeld = false

  -- The old world's canvases (baked terrain and so on) are garbage now;
  -- collected here, before building their replacements, rather than
  -- left to pile up alongside them.
  collectgarbage()
  collectgarbage()
end

function love.load()
  local firstLoad = not hasLoadedOnce
  hasLoadedOnce = true

  if firstLoad then
    love.window.setTitle("Asteroid Bob")

    -- conf.lua starts in 1920x1080 borderless fullscreen (16:9, for
    -- trailer clips). If fullscreen is ever turned off there, fill the
    -- screen with an ordinary maximized window instead.
    if not love.window.getFullscreen() then
      love.window.maximize()
    end
  end

  -- Pixel-art default: LÖVE's own default is "linear" filtering, which
  -- blends neighboring texels — including across tile boundaries in a
  -- shared atlas image (img/platform.png) the moment it's sampled while
  -- baking TiledTerrain's level canvas. That's what caused both the faint
  -- seam lines between tiles (bleeding a sliver of the adjacent tile's
  -- edge color) and the overall soft/anti-aliased look instead of crisp
  -- SNES-style pixels. Must be set before any image/canvas is created —
  -- it only affects textures loaded after this call, not retroactively —
  -- so this has to run before assetLoading.loadAssets() below. Anything
  -- that specifically wants smooth shading instead (Planetoid's canvas)
  -- already sets its own filter explicitly afterward, which overrides
  -- this default for that one texture only.
  love.graphics.setDefaultFilter("nearest", "nearest")

  resetWorldState()
  worldGen.initWorldSize()

  state.timeScale = 1
  state.timeScaleTarget = 1
  state.vatsMultiplier = 1
  state.showCollisionDebug = false
  state.showBeltCellDebug = false
  state.showInfluenceRings = false
  -- Global record of which one-time scripted NPC sequences (see
  -- Script.lua/CameraDirector.lua) have already played out, keyed by an
  -- arbitrary id each script chooses for itself (e.g. "robotButlerIntro")
  -- — checked by the NPC's own tryInteract so the full sequence only ever
  -- plays once per session, falling back to an ordinary one-line
  -- greeting afterward.
  state.scriptsCompleted = {}
  state.vatsActive = false
  -- Whether cycling the lock-on target with L1/R1 also drops into
  -- V.A.T.S. (slow motion + the screen overlay) on its own. Off: L1/R1
  -- just pick the next/previous target in real time, and V.A.T.S. is
  -- only ever entered deliberately, with Triangle (see GamePadInput.lua's
  -- own maybeAutoEnterVats and Triangle handling).
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
    -- EXIT TO TITLE: run this whole function again (see its own header).
    PauseMenu.onExitToTitle = function() love.load() end
    -- T: the debug teleport list (see openTeleportList).
    PauseMenu.onTeleportKey = openTeleportList
  end

  collisionSystem = CollisionSystem.new()
  state.starfield = Starfield.new()

  -- Every hand-placed landmark, the dome's Tiled interior and the
  -- player (see lua/levels/World.lua).
  local world = World.build()
  -- (For the T teleport list.)
  shelterRespawnPoint = state.respawnPoint
  expresswayEntry = world.expresswayEntry

  -- Testing start spot (START_AT, top of this file), now that every
  -- planet it could pick exists.
  applyStartPosition(world.expresswayEntry)

  -- Stream the 3x3 around the house, not world center — must run AFTER
  -- the dome above is created and assigned to state.skyDomePlanet, not
  -- before: cell generation steers new planetoids/asteroids away from
  -- the dome's footprint (see WorldGen.lua's isNearSkyDome), and it can
  -- only do that for cells generated while state.skyDomePlanet is
  -- already set — which, for this exact starting neighborhood, is
  -- every cell that actually overlaps the dome's home area.
  worldGen.generateStartingNeighborhood(World.HOME_CELL_COL, World.HOME_CELL_ROW)

  state.sun = Sun.new(state.sceneWidth / 2, state.sceneHeight / 2, 1920)

  state.gravitySystem = GravitySystem.new(state.planetoids)

  -- Everything above sets the game up exactly as it starts — the title
  -- screen then borrows the player and stands him out in the belt until
  -- start is pressed (see lua/ui/TitleScreen.lua).
  -- Fading in from black when this is a return from the pause menu, so
  -- the rebuild isn't a hard cut.
  TitleScreen.enter(not firstLoad)

  -- Pointed at the player from the very first frame (love.update keeps
  -- it current from here on).
  Camera.pointAtPlayer()
end

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

function love.update(dt)
  if dt > 0 then
    state.fps = (state.fps or 0) * 0.9 + (1 / dt) * 0.1
  end

  gamepadInput.pollGamepad(dt)

  -- Paused (see lua/ui/PauseMenu.lua): nothing below runs at all —
  -- no movement, physics, timers or world streaming — until the menu
  -- is closed. The pad is still polled above, since that's how the menu
  -- itself is driven.
  if PauseMenu.isOpen() then return end

  -- V.A.T.S. rules. While it's active (Triangle — see GamePadInput.lua)
  -- the player doesn't act on his own: no walking (see the move call
  -- further down), and no jumping, ground-pounding, curling into a ball
  -- or firing (each of those Player methods refuses while
  -- state.vatsActive). All he can do is choose a target — L1/R1 or the
  -- right-stick cursor — and press L2 to pull-beam to it, which ends
  -- V.A.T.S. (Player:trySelectPullTarget).
  --
  -- A pull already under way when V.A.T.S. is entered carries on by
  -- itself, even with L2 released (GamePadInput.lua doesn't drop it
  -- while V.A.T.S. is active) — which is what lets him chain from one
  -- planetoid to the next without landing: pull, V.A.T.S., pick the
  -- next, pull again.
  --
  -- And the moment V.A.T.S. ends, however it ends:
  --   - whatever was locked during it is unlocked;
  --   - a pull that was only still going because V.A.T.S. was holding
  --     it — nobody is actually holding L2 (or the right mouse button)
  --     — is dropped, back to the ordinary hold-to-pull rule.
  if state.vatsWasActive and not state.vatsActive and state.player then
    state.player:clearLockTarget()
    if state.player.pullTarget and not (state.gamepadPullHeld or love.mouse.isDown(1)) then
      state.player:clearPullTarget()
    end
  end
  state.vatsWasActive = state.vatsActive

  TitleScreen.update(dt)
  VatsCursor.update(dt)

  -- Background music fades to suit where he is (see lua/AudioManager.lua).
  if state.audioManager then state.audioManager:updateMusic(musicForPlayer(), dt) end

  -- Normalizes this frame's real elapsed time to "how many 60fps-baseline
  -- frames this update represents" (1.0 at exactly 60fps) — clamped so a
  -- stall or frame-drop spike can't fling anything through geometry.
  -- Every per-frame rate below is expressed in these units so the game's
  -- existing speed/force/easing tuning (all written assuming ~60fps)
  -- keeps meaning the same thing at exactly 60 FPS, and produces the same
  -- real-time behavior at any other frame rate.
  local FPS_BASELINE = 60
  local MAX_FRAME_DT = 0.05 -- clamp to a 20fps floor
  local frameNorm = math.min(dt, MAX_FRAME_DT) * FPS_BASELINE

  -- state.vatsMultiplier is the slow-motion easing value on its own (1 =
  -- normal speed, VATS_TIME_SCALE = full slow-mo). VATS_EASE_RATE is
  -- itself a per-baseline-frame rate, so it's scaled by frameNorm too —
  -- otherwise the slow-mo blend-in/out speed would still vary with frame
  -- rate even after everything else stopped.
  state.timeScaleTarget = state.vatsActive and VATS_TIME_SCALE or 1
  local timeScaleDiff = state.timeScaleTarget - state.vatsMultiplier
  if math.abs(timeScaleDiff) < VATS_EASE_SNAP_THRESHOLD then
    state.vatsMultiplier = state.timeScaleTarget
  else
    state.vatsMultiplier = state.vatsMultiplier + timeScaleDiff * math.min(VATS_EASE_RATE * frameNorm, 1)
  end

  -- state.timeScale is what nearly every moving thing in the game (Player,
  -- Asteroid, Coin, Fireball, Ooomba, Particle, FireBar, GravitySystem,
  -- BeltOrbitSystem, ...) multiplies its per-update movement/velocity by.
  -- It was never actually tied to real elapsed time — only to the VATS
  -- slow-mo easing above — so every one of those systems was advancing by
  -- a fixed amount PER FRAME rather than per SECOND. That's why raising
  -- the frame rate visibly sped the whole game up: 150 FPS produced 150
  -- movement steps per second of real time versus 60 FPS's 60.
  state.timeScale = state.vatsMultiplier * frameNorm
  -- A cannon shot's hit-stop (see Cannon.timeFactor): the whole game all
  -- but frozen for an instant when he hits a bumper.
  state.timeScale = state.timeScale * Cannon.timeFactor()

  updatePlanetoidsPhysics()

  -- Planetoids that turn on the spot (see CrystalPlanet.lua) — before
  -- Player:move below, which is what places him on the planetoid he's
  -- being carried round by.
  for _, p in ipairs(state.planetoids) do
    if p.updateRotation and not p.recalling then p:updateRotation(state.timeScale) end
  end

  -- Goes with START_AT = "mining" (top of this file): keeps the respawn
  -- point on top of the mining planet as it drifts.
  if state.respawnPoint and state.respawnPoint.followsPlanet then
    local point, planet = state.respawnPoint, state.respawnPoint.planet
    point.x, point.y = planet.pos.x, planet.pos.y - planet.radius - constants.PLAYER_RADIUS
  end

  -- Duck-typed, same pattern state.spikeys' own update loop already
  -- uses: only SphereMove (so far) actually has an :update() of its
  -- own, driving self.pos directly along its fixed patrol path — every
  -- other planetoid type is left untouched here, same as always.
  for _, p in ipairs(state.planetoids) do
    if p.update and not p.recalling then p:update() end
  end

  -- Recall: rewinding planetoids moved back along their recorded paths
  -- (shoving whatever's in the way), and every planetoid's path recorded
  -- — after their own movement above, before the player's below, so he's
  -- carried along on one that's rewinding. See lua/systems/Recall.lua.
  Recall.update(dt)

  -- Everything in the world's object lists (rope rocks, asteroids, coins,
  -- Ooombas, fire bars, levers, fish, NPCs, ...) — before the player
  -- moves, so one standing on a rope rock is carried along. Order and
  -- details: lua/systems/WorldObjects.lua.
  WorldObjects.update("world", dt)

  -- Player.lua reads this to freeze movement/jumping for as long as any
  -- conversation is showing, same "empty keys" trick state.introLocked
  -- uses just below.
  state.dialogueActive = WorldObjects.anyDialogueActive()

  -- Empty keys while the opening cutscene is running — the player
  -- still stands on the deck normally (gravity/collision below are
  -- untouched), just with no WALKING input read, so they don't wander
  -- off mid-sequence before the door's finished its own choreography.
  -- Also empty while inside the pinball planet — he's a ball under
  -- PinballInterior's own gravity/collision there (see just below),
  -- not something walking-input steers directly, same as a real
  -- pinball only ever responding to flippers/plunger/gravity.
  -- On the title screen he's driven by its own autopilot instead (see
  -- TitleScreen.lua) — the real keys never reach him there at all.
  -- Going through a portal: he follows the portal path instead of all
  -- the normal movement/gravity/collision below (see lua/systems/PortalGun.lua).
  -- A left click since last frame (see InputHandlers.lua), fired below
  -- once he's moved; dropped if he can't fire this frame.
  local mouseFire = state.mouseFirePending
  state.mouseFirePending = false
  if state.player.portalTransit then
    PortalGun.updateTransit(state.player, state.timeScale)
  else
    if state.titleScreen then
      state.player:move(TitleScreen.getKeys())
    else
      -- (No walking in V.A.T.S. either — see the V.A.T.S. rules near the
      -- top of this function.)
      -- (Nor while he's in a cannon or flying from one: the shot goes
      -- dead straight — see lua/world/Cannon.lua.)
      local noSteering = state.introLocked or state.player.inPinball or state.vatsActive
        or state.player.inCannon or state.player.cannonFlight
      -- Standing, he can't walk or run into a gap lower than he is tall —
      -- a ball tunnel (see TiledTerrain.lua's Level:headroomAt) — unless
      -- he's already somewhere that low.
      local pl = state.player
      local level = state.tiledLevels and state.tiledLevels[1]
      local px, py, parc = pl.pos.x, pl.pos.y, pl.surfaceArcPos
      local hadRoom = level and pl.onSurface and not pl.isBall and level:headroomAt(px, py, pl.radius)
      state.player:move(noSteering and {} or state.keys)
      if hadRoom and pl.onSurface and not pl.isBall and not level:headroomAt(pl.pos.x, pl.pos.y, pl.radius) then
        pl.pos.x, pl.pos.y, pl.surfaceArcPos = px, py, parc
        pl.isWalking = false
        pl.groundMoveSpeedX = 0
      end
    end

    -- PinballInterior:updateBall entirely REPLACES normal gravity and
    -- planet collision while he's inside it (see Player.lua's own
    -- inPinball comment) — state.player:update() still runs normally
    -- either way, since it's what actually advances teleport/ball-morph/
    -- invincibility, none of which should pause just because he's now
    -- inside the table.
    if state.player.inPinball then
      local jumpHeld = state.keys[' '] or state.gamepadJumpHeld or false
      state.player.inPinball:updateBall(state.player, state.timeScale, jumpHeld)
    elseif state.player.pullTarget then
      state.player:applyPullForce()
    elseif not (state.player.inCannon or state.player.cannonFlight) then
      -- (No gravity in a cannon, or on a cannon shot — see Cannon.lua.)
      state.gravitySystem:applyTo(state.player)
    end

    state.player:update()

    -- Cannons: swallowing him, holding him while they aim, firing him —
    -- and his flight once fired (see lua/world/Cannon.lua).
    for _, cannon in ipairs(state.cannons or NONE) do
      cannon:update(state.player, state.timeScale)
    end
    Cannon.updateFlight(state.player, state.timeScale)
    -- (And the coins down their routes — after the flight's moved him
    -- for the frame.)
    for _, cannon in ipairs(state.cannons or NONE) do
      cannon:updateCoins(state.player, state.timeScale / 60)
    end

    -- Into a portal? Checked before collision, so landing on a floor
    -- portal doesn't stop his fall first (see PortalGun.tryEnter).
    PortalGun.tryEnter(state.player)

    if not state.player.inPinball and not state.player.inCannon then
      collisionSystem:handlePlayerPlanetCollisions(state.player)
    end

    -- Gamepad R2 fire: a continuous-hold flag (see GamePadInput.lua),
    -- not an edge-triggered press — called every frame while held, same
    -- as the mouse-click path (love.mousepressed -> shootFireball in
    -- InputHandlers.lua). shootFireball()'s own fireCooldown/lastShotTime
    -- check is what actually throttles the real fire rate; this is what
    -- was missing before — GamePadInput.lua already set
    -- state.gamepadFireHeld every frame from the trigger's analog value,
    -- but nothing ever read it, so R2 silently did nothing.
    -- (A left click is handled here too — see mouseFire above.)
    if (state.gamepadFireHeld or mouseFire) and state.player then
      if state.iceMode then state.player:shootIceBolt() else state.player:shootFireball() end
    end

    -- Reset once per frame, before re-checking walls AND Spikeys below —
    -- neither handlePlayerWallCollisions nor handlePlayerSpikeyCollisions
    -- ever CLEARS this, only sets it on actual contact, so without this
    -- the flag would latch true forever after the first touch instead of
    -- reflecting only THIS frame's contact (see Player:jump's wall-jump
    -- branch, which is also what lets him "jump off" a Spikey — see
    -- CollisionSystem:handlePlayerSpikeyCollisions's own comment).
    state.player.touchingWall = nil
    state.player.wallContactNormal = nil

    if state.tiledLevels then
      for _, level in ipairs(state.tiledLevels) do
        collisionSystem:handlePlayerWallCollisions(state.player, level.walls)
        -- Ball-tunnel pieces, and (standing, in the air) his head.
        level:pushPlayer(state.player)
      end
    end
    -- Plungers: solid to him, loaded by pushing into them, fire him
    -- when he lets go (see lua/world/Plunger.lua).
    for _, plunger in ipairs(state.plungers or NONE) do plunger:update(state.player, state.timeScale) end

    collisionSystem:handlePlayerSpikeyCollisions(state.player, state.spikeys)

    -- Ooombas: lethal to touch, unless landed on from above — see
    -- CollisionSystem:handlePlayerOoombaCollisions. Anything it returns
    -- has just finished being squashed flat: gone, with a burst under the
    -- player's feet (or where it stood, if he's no longer on top of it)
    -- and a small hop for him off the top of it.
    --
    -- "Under his feet", "the ground" and "a hop" are all along the
    -- Ooomba's own up direction (Ooomba.up) — straight up the screen on
    -- terrain, straight out from the center on a round planetoid — and
    -- the hop is relative to whatever it was standing on, which for a
    -- belt planetoid is itself moving.
    --
    -- Skipped entirely on the title screen: Bob's autopilot keeps clear
    -- of Ooombas there (see TitleScreen.lua), and if he ever does brush
    -- one anyway, nothing happens — he can't die before the game starts.
    if state.ooombas and #state.ooombas > 0 and not state.titleScreen then
      local flattened = collisionSystem:handlePlayerOoombaCollisions(state.player, state.ooombas)
      for _, o in ipairs(flattened) do
        local player = state.player
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

    collisionSystem:handlePlayerSkyDomeContainment(state.player, state.skyDomePlanet)
  end

  -- Belt planetoids alone can number in the hundreds
  -- (worldGen.BELT_MAX_TOTAL_PLANETOIDS = 500), and almost all of them
  -- sit outside the camera at any given moment. Bouncing off each other
  -- (or off an asteroid/fireball) is purely a background physics detail
  -- with no visible payoff when it happens off-screen, so any belt
  -- planetoid the player can't currently see is left out of every
  -- planetoid-involved collision pass below — built once per frame and
  -- reused by all of them. Regular planets and the dome/hill shapes are
  -- never filtered out here: they're comparatively few, and (for the
  -- immovable ones) always meant to react precisely regardless of
  -- visibility.
  local count = 0
  for _, p in ipairs(state.planetoids) do
    if not p.isBeltPlanetoid or utils.isOnScreen(p.pos.x, p.pos.y, p.radius, 50) then
      count = count + 1
      collidablePlanetoids[count] = p
    end
  end
  for i = #collidablePlanetoids, count + 1, -1 do collidablePlanetoids[i] = nil end -- (last frame's extras)

  collisionSystem:handleElasticCollisions(collidablePlanetoids)

  -- Any planetoid tagged isImmovable (the sky dome and its TiledTerrain
  -- hill shapes are the current examples) gets the same surface-accurate
  -- bounce treatment FireBar's
  -- block already has below, against every OTHER planetoid — this is
  -- what handleElasticCollisions above deliberately skips (it excludes
  -- any pair where either side is immovable). Without this, an
  -- immovable planetoid never reacted to anything touching it at all,
  -- which is what let regular planetoids silently overlap/sit inside
  -- the dome instead of repelling off its actual dome+base shape.
  -- Asteroids are deliberately NOT included here — they always break
  -- against a planet's true surface (dome included), handled by
  -- handlePlanetAsteroidCollisions below instead; bouncing them here
  -- too would be redundant with that.
  do
    local immovableCount = 0
    for _, p in ipairs(collidablePlanetoids) do
      if p.isImmovable then
        immovableCount = immovableCount + 1
        immovablePlanetoids[immovableCount] = p
      end
    end
    for i = #immovablePlanetoids, immovableCount + 1, -1 do immovablePlanetoids[i] = nil end
    if #immovablePlanetoids > 0 then
      collisionSystem:handleImmovableCollisions(immovablePlanetoids, collidablePlanetoids)
    end
  end

  if state.fireBars and #state.fireBars > 0 then
    -- Not lethal on the title screen. They ARE drawn there, and Bob's
    -- autopilot is what keeps him out of them (see TitleScreen.lua's own
    -- "Fire bars" section) — this is only the safety net behind that: he
    -- can't die before the game starts.
    if collisionSystem.handlePlayerFireBarCollisions and not state.titleScreen then
      collisionSystem:handlePlayerFireBarCollisions(state.player, state.fireBars)
    end
    -- Deliberately no handleImmovableCollisions(state.fireBars, state.planetoids)
    -- call -- planetoids used to bounce off a firebar's tiny pivot
    -- collision radius, which fought BeltOrbitSystem's own sun-centered
    -- restore force and visibly pooled belt planetoids around each bar.
    -- FireBars are only meant to be a hazard for the player; asteroids
    -- (free physics, not orbit-scripted) still collide with them below.
    if state.asteroids and #state.asteroids > 0 then
      collisionSystem:handleImmovableCollisions(state.fireBars, state.asteroids)
    end
  end

  if state.asteroids and #state.asteroids > 0 then
    -- No handlePlayerAsteroidCollisions call: all it does is
    -- player:startDeath() on contact, and asteroids aren't meant to be
    -- lethal — that was only ever harmless because startDeath used to
    -- be an empty stub.
    collisionSystem:handleElasticCollisions(state.asteroids)

    -- An asteroid that hits a planetoid breaks apart — see Breakage.breakAsteroid.
    local toBreak = collisionSystem:handlePlanetAsteroidCollisions(collidablePlanetoids, state.asteroids)
    for asteroid, planet in pairs(toBreak) do
      Breakage.breakAsteroid(asteroid, planet)
    end
  end

  -- Runs on the title screen too — Bob collects whatever coins his
  -- autopilot carries him through, sound and all. Anything that adds to
  -- state.score there is wiped when the game actually starts (see
  -- TitleScreen.lua's own beginGame).
  if state.coins then
    collisionSystem:handleCoinCollisions(state.player, state.coins)
  end

  -- Portals follow whatever they're stuck to (moved above) and emit
  -- their particles; the shot streaks fade (see lua/systems/PortalGun.lua).
  PortalGun.update(dt)
  -- Spraying, droplets, and water flowing/pooling/evaporating.
  WaterSystem.update(dt)
  -- The water blaster's hiss while he sprays (see lua/AudioManager.lua).
  if state.audioManager then
    state.audioManager:updateSpray(WaterSystem.isSpraying(),
      WaterSystem.totalWater() >= WaterSystem.waterCap(), dt)
  end

  -- Fireballs and ice bolts: moving, through portals, and everything they
  -- can hit (see lua/systems/Projectiles.lua).
  Projectiles.update(collisionSystem, collidablePlanetoids)

  -- Explosions, wall-jump contact rings and debris particles: purely
  -- time-driven visuals (see lua/systems/WorldObjects.lua).
  WorldObjects.update("effects", dt)

  BeltOrbit.apply(state.planetoids)

  if state.sun then
    state.sun:update()
  end

  -- World streaming and the belt's drip, every so many seconds (real
  -- time, not frames — so neither runs more often at a higher frame rate).
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

  -- Zoom and camera position for this frame (see lua/systems/Camera.lua).
  Camera.update(dt)
end

function love.draw()
  Planetoid.beginFrame()
  state.starfield:draw(state.camera, state.visibleWidth, state.visibleHeight)

  love.graphics.push()
  love.graphics.scale(state.zoom, state.zoom)
  -- Snapped to whole screen pixels: the camera follows the player's exact
  -- (fractional) position, and drawing the world at sub-pixel offsets
  -- made the pixel-art ("nearest"-filtered) tiles and textures shimmer —
  -- big static things like the pinball planet visibly quivered as the
  -- camera moved. state.camera itself stays exact for everything else.
  local zoom = state.zoom
  love.graphics.translate(-math.floor(state.camera.x * zoom + 0.5) / zoom,
                          -math.floor(state.camera.y * zoom + 0.5) / zoom)

  -- Bob's and the Ooombas' shadow shapes for this frame (see
  -- lua/effects/CharacterShadows.lua) — up front, since the Space Shelter
  -- just below takes them, as well as the level's tiles further down.
  CharacterShadows.prepare()

  if state.skyDomePlanet then
    state.skyDomePlanet:draw()
    -- Tufts of grass blades along its deck (see lua/effects/GrassBlades.lua).
    GrassBlades.draw(state.skyDomePlanet.grassBlades)
  end

  -- In front of the background hex canvas (baked scrolling grid, drawn
  -- INSIDE :draw() -> drawDome()) but behind the foreground hex canvas
  -- (the larger bulging/rippled one, drawn separately much later via
  -- drawForegroundGlass — see below) — sandwiched between the two
  -- layers, not in front of both.
  --
  -- The door itself is drawn HERE only once state.spaceShelter.playerInFront
  -- is true (opening cutscene reached fully-open — see
  -- SpaceShelter.lua's own intro state machine) — the player then draws
  -- on top of it further down. Until then it's drawn later instead,
  -- right after the player (see below), so the closed/opening door
  -- covers the player standing behind it.
  if state.spaceShelter then
    local shelter = state.spaceShelter
    shelter:drawBody()
    if shelter.playerInFront then
      shelter:drawDoor()
      -- His shadow on the shelter (and its doors), the same as on the
      -- level's tiles — only once he's stepped out in front of it, not
      -- while he's still inside behind the closed door.
      CharacterShadows.drawOntoSprite(function()
        shelter:drawBody()
        shelter:drawDoor()
      end)
    end
  end

  if state.sun then
    state.sun:draw()
  end

  -- Viewport culling below: this game can have hundreds of active
  -- planetoids (BELT_PLANETOIDS_PER_CELL=36 alone) and dozens of fire
  -- bars alive at once in the streamed 3x3 cell neighborhood, almost
  -- all off-screen at any given moment — skipping their (comparatively
  -- expensive, especially Planetoid's own per-frame stencil sun-shading
  -- pass) draw calls entirely when they can't possibly be visible is
  -- the single biggest lever for frame time here. Update/physics
  -- (position integration, orbits, collisions) deliberately still runs
  -- for everything regardless of visibility — culling THAT risks a
  -- visible "catch-up" pop the moment something re-enters view, which
  -- culling only :draw() never risks. (Each WorldObjects layer culls its
  -- own items the same way — see lua/systems/WorldObjects.lua.)
  WorldObjects.draw("backdrop")

  -- Influence-radius rings ('R' toggles — see InputHandlers.lua): only
  -- for planetoids GravitySystem itself treats as plain circular gravity
  -- sources (has influenceRadius, not isRoundedRect — see
  -- GravitySystem:findDominantPlanet's own branching). The dome and
  -- TiledTerrain shapes are deliberately skipped: their real gravity
  -- range isn't a circle at all (isWithinGravityWindow / "whatever's
  -- underfoot"), so a ring around them would just be wrong, not merely
  -- redundant.
  --
  -- How strongly each ring shows says how much that body's gravity
  -- matters to him RIGHT NOW (see the INFLUENCE_RING_* values at the top
  -- of this file): brightest for the one actually pulling on him,
  -- clearly visible for any other whose reach he's inside, and for the
  -- rest fading with how far outside the ring's own edge he is. It used
  -- to fade with his distance from the body's CENTER, which made a big
  -- ring fainter than a small one for no better reason than its size —
  -- standing on a large sphere, well inside its reach, its ring was
  -- nearly invisible.
  if state.showInfluenceRings then
    local player = state.player
    local pulling = (player.onSurface and player.currentPlanet)
      or (state.gravitySystem and state.gravitySystem:findDominantPlanet(player.pos))
    for _, p in ipairs(state.planetoids) do
      if p.influenceRadius and not p.isRoundedRect
         and utils.isOnScreen(p.pos.x, p.pos.y, p.influenceRadius, 50) then
        local dx, dy = player.pos.x - p.pos.x, player.pos.y - p.pos.y
        local outside = math.sqrt(dx * dx + dy * dy) - p.influenceRadius -- negative: he's within its reach
        local alpha
        if p == pulling then
          alpha = INFLUENCE_RING_ALPHA_PULLING
        elseif outside <= 0 then
          alpha = INFLUENCE_RING_ALPHA_INSIDE
        else
          local t = math.min(1, outside / INFLUENCE_RING_FADE_DISTANCE)
          alpha = INFLUENCE_RING_ALPHA_NEAR + (INFLUENCE_RING_ALPHA_FAR - INFLUENCE_RING_ALPHA_NEAR) * t
        end
        InfluenceRing.draw(p.pos.x, p.pos.y, p.influenceRadius, alpha)
      end
    end
  end

  -- Prisms: before the planetoids, so the one each stands on covers its
  -- sunken foot (see lua/world/Prism.lua).
  WorldObjects.draw("planetFeet")

  -- The fire bars' fireballs lighting up the planets near them (see
  -- lua/effects/FireBarGlow.lua) — added over each one right after it's drawn.
  FireBarGlow.prepare()
  for _, p in ipairs(state.planetoids) do
    -- The dome is ALSO in this list (for gravity/physics bookkeeping —
    -- see GravitySystem.new(state.planetoids)), but already drew
    -- explicitly above; drawing it again here would re-paint the whole
    -- background hex layer on top of everything sandwiched between the
    -- two explicit dome draw calls (the shelter — see above — and
    -- anything else meant to sit behind the foreground hex but in
    -- front of the background one).
    -- Every water body's own SHELL (isWaterPlanet — there can be more
    -- than one now, see the second WaterPlanet.new() call above) is
    -- ALSO excluded here and drawn again later, right after the player
    -- (see that draw call's own comment) — same reasoning as the lava
    -- fix: it needs to render ON TOP of him whenever they overlap, so
    -- he reads as submerged rather than floating in front of the water.
    -- Checked via the flag rather than comparing against specific named
    -- water planet variables, so this keeps working regardless of how
    -- many water bodies end up existing.
    if p ~= state.skyDomePlanet and not p.isWaterPlanet and utils.isOnScreen(p.pos.x, p.pos.y, p.radius, 50) then
      p:draw()
      FireBarGlow.drawOnto(p)
      -- Duck-typed: only PinballPlanet has one right now (see
      -- lua/interiors/PinballInterior.lua and this planet's own setup
      -- comment), but any future planetoid with its own .interior
      -- overlay rides this same draw pass for free.
      if p.interior then
        p.interior:draw()
      end
    end
  end

  -- The belt outposts' missile cannons (see lua/world/MissileOutpost.lua).
  MissileOutpost.drawCannons(state.outposts)

  -- Cannons, on their planets, and the rails along their routes, out in
  -- space wherever they are (see lua/world/Cannon.lua).
  for _, cannon in ipairs(state.cannons or NONE) do
    cannon:drawRails()
    if not cannon.isTrack then -- (a track's just rails: no cannon of its own)
      local px, py = cannon:pivot()
      if utils.isOnScreen(px, py, 400, 50) then cannon:draw() end
    end
  end

  -- Recall's yellow overlay on rewinding planetoids (and the aim ring).
  Recall.draw()

  -- Spikeys (lua/world/Spikey.lua) — deliberately not planetoids, so
  -- not drawn by the loop just above.
  WorldObjects.draw("hazards")

  if state.tiledLevels then
    -- (Bob's and the Ooombas' shadows on the level's tiles — see
    -- lua/effects/CharacterShadows.lua, prepared at the top of
    -- love.draw — are drawn over each level, before they themselves are.)
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
        if state.showCollisionDebug then
          love.graphics.setLineWidth(4)
          -- Ordinary ground/ramp shapes (red) first, then the solid wall
          -- blocks (blue), then wall-climb loop shapes (green) LAST —
          -- see this file's own note on why the wall-climb path and the
          -- solid wall blocks legitimately overlap in the same tiles.
          -- Drawing green last keeps that overlapping stretch of path
          -- visible on top instead of buried under the wall rectangles.
          love.graphics.setColor(1, 0, 0, 1)
          for _, shape in ipairs(level.shapes) do
            if not shape.isWallClimb then
              for _, seg in ipairs(shape.segments) do
                love.graphics.line(seg.a.x, seg.a.y, seg.b.x, seg.b.y)
              end
            end
          end
          love.graphics.setColor(0.2, 0.6, 1, 1)
          for _, wall in ipairs(level.walls or NONE) do
            love.graphics.rectangle("line",
              wall.pos.x - wall.halfWidth, wall.pos.y - wall.halfHeight,
              wall.halfWidth * 2, wall.halfHeight * 2)
          end
          -- Wall-climb shapes (ramp-to-wall-to-ceiling loops — see
          -- TiledTerrain.lua's buildRampClimbShape/
          -- linkAndMergeWallClimbShapes) draw green, so a multi-tile
          -- path like a full loop is visibly distinct from plain
          -- ground/ramp shapes at a glance, same red/blue/green
          -- convention this debug view already uses to tell top vs wall
          -- shapes apart.
          love.graphics.setColor(0.2, 1, 0.2, 1)
          for _, shape in ipairs(level.shapes) do
            if shape.isWallClimb then
              for _, seg in ipairs(shape.segments) do
                love.graphics.line(seg.a.x, seg.a.y, seg.b.x, seg.b.y)
              end
            end
          end
          love.graphics.setColor(1, 1, 1, 1)
          love.graphics.setLineWidth(1)
        end
      end
    end
  end

  -- Rope rocks, gates, levers, plungers, cranks, signs, mirrors. (Gates
  -- are drawn whatever state.showCollisionDebug says: that debug view
  -- only shows a gate's collision rectangle, not its bars.)
  WorldObjects.draw("props")

  -- Debug: transparent red over every cell that's BOTH in the player's
  -- current 3x3 active window AND geometrically inside the asteroid
  -- belt ring (worldGen.cellIntersectsBelt) — lets you see at a glance
  -- exactly which nearby cells worldGen.updateActiveCells should be
  -- populating with belt planetoids right now. Toggle with 'A'.
  if state.showBeltCellDebug and state.player then
    local cellSize = worldGen.CELL_SIZE
    local playerCell = worldGen.cellCoordFor(state.player.pos.x, state.player.pos.y)
    love.graphics.setColor(1, 0, 0, 0.35)
    for dRow = -1, 1 do
      for dCol = -1, 1 do
        local col = playerCell.col + dCol
        local row = playerCell.row + dRow
        if worldGen.cellIntersectsBelt(col, row) then
          love.graphics.rectangle("fill", col * cellSize, row * cellSize, cellSize, cellSize)
        end
      end
    end

    -- Bright blue grid over EVERY cell boundary in the current view, not
    -- just the 3x3 -- lets you see at a glance how much more of the
    -- world your camera is actually showing at low zoom than the fixed
    -- 3x3 active-cell window covers, and lines up individual belt
    -- planetoids against which cell they actually landed in. Only drawn
    -- across the camera's own visible span (snapped outward to the
    -- nearest cell lines), not the whole 20x20 world grid -- that span
    -- itself grows at lower zoom, so more lines naturally appear the
    -- further out you zoom.
    local cam = state.camera or { x = 0, y = 0 }
    local visW = state.visibleWidth or 0
    local visH = state.visibleHeight or 0
    local firstCol = math.floor(cam.x / cellSize)
    local lastCol = math.floor((cam.x + visW) / cellSize) + 1
    local firstRow = math.floor(cam.y / cellSize)
    local lastRow = math.floor((cam.y + visH) / cellSize) + 1

    love.graphics.setColor(0.2, 0.6, 1, 0.9)
    love.graphics.setLineWidth(2)
    for col = firstCol, lastCol do
      local x = col * cellSize
      love.graphics.line(x, firstRow * cellSize, x, (lastRow + 1) * cellSize)
    end
    for row = firstRow, lastRow do
      local y = row * cellSize
      love.graphics.line(firstCol * cellSize, y, (lastCol + 1) * cellSize, y)
    end
    love.graphics.setLineWidth(1)

    love.graphics.setColor(1, 1, 1, 1)
  end

  WorldObjects.draw("enemies")

  -- The belt outposts' missiles, in flight (see lua/world/MissileOutpost.lua).
  MissileOutpost.drawMissiles()

  -- Robot butler, fisherman, coins, fire bars, beams. Beams are drawn
  -- BEFORE the player (just below), so he renders in front of one he's
  -- standing at — his own silhouette glow (Player:drawBeamGlow) is what
  -- signals "near a beam".
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

  -- Debug: the player's own actual collision shape (toggle with 'C',
  -- state.showCollisionDebug — same flag/key the TiledTerrain wall/shape
  -- debug view above already uses). A vertical CAPSULE, not a plain
  -- circle — see CollisionSystem:handlePlayerWallCollisions and
  -- Player.lua's own headReach for why: the bottom circle sits right at
  -- player.pos (exactly what every other system — ground distance,
  -- water, enemies — already treats as "the player"), and the top
  -- circle is offset up by however far his actual visual head reaches,
  -- minus this circle's own radius (since the circle itself already
  -- contributes that much reach). Drawn in magenta so it's visually
  -- distinct from the red/blue/green wall-shape debug lines above.
  if state.showCollisionDebug then
    local r = state.player.radius
    -- Same onWallClimb exemption CollisionSystem:handlePlayerWallCollisions
    -- itself uses — see that file's own comment on why the head capsule
    -- collapses to a plain circle there (it doesn't rotate with the
    -- surface, so it otherwise pokes into the ceiling right at a
    -- wall-climb shape's own ceilingLeft/ceilingRight seam).
    local onWallClimb = state.player.onSurface and state.player.currentPlanet and state.player.currentPlanet.isWallClimb
    local headReach = (not state.player.isBall and not onWallClimb) and (state.player.headReach or 0) or 0
    local topY = state.player.pos.y - math.max(0, headReach - r)
    local bottomY = state.player.pos.y
    local px = state.player.pos.x

    love.graphics.setLineWidth(3)
    love.graphics.setColor(1, 0.2, 1, 1)
    love.graphics.circle("line", px, bottomY, r)
    love.graphics.circle("line", px, topY, r)
    if topY < bottomY then
      love.graphics.line(px - r, topY, px - r, bottomY)
      love.graphics.line(px + r, topY, px + r, bottomY)
    end
    love.graphics.setColor(1, 1, 1, 1)
    love.graphics.setLineWidth(1)
  end

  -- Debug: Spikey's own solid collision boundary (same 'C' toggle as
  -- every other debug view here) — see
  -- CollisionSystem:handlePlayerSpikeyCollisions's own sweptCircleEntryT
  -- for the actual solid-stop logic this circle represents:
  -- spikey.radius + player.radius + SURFACE_TOLERANCE, i.e. where the
  -- player's OWN collision circle first touches the spikey's, not just
  -- its bare radius. Drawn in orange to read as "danger boundary,"
  -- distinct from the blue ordinary-wall / magenta player-capsule debug
  -- lines elsewhere.
  if state.showCollisionDebug and state.player and state.spikeys then
    love.graphics.setLineWidth(3)
    love.graphics.setColor(1, 0.55, 0, 1)
    for _, sp in ipairs(state.spikeys) do
      if utils.isOnScreen(sp.pos.x, sp.pos.y, sp.radius + state.player.radius, 20) then
        love.graphics.circle("line", sp.pos.x, sp.pos.y, sp.radius + state.player.radius + constants.SURFACE_TOLERANCE)
      end
    end
    love.graphics.setColor(1, 1, 1, 1)
    love.graphics.setLineWidth(1)
  end

  -- Debug: each Ooomba's contact circle (same 'C' toggle) — see
  -- CollisionSystem:handlePlayerOoombaCollisions: he's hit when his own
  -- collision circle overlaps this one, unless he's stomping it from above.
  -- Fireballs use the same circle. Drawn in cyan, distinct from the other
  -- debug colors (orange Spikey, magenta player, yellow dome).
  if state.showCollisionDebug and state.ooombas then
    love.graphics.setLineWidth(3)
    love.graphics.setColor(0.2, 0.9, 1, 1)
    for _, o in ipairs(state.ooombas) do
      if utils.isOnScreen(o.pos.x, o.pos.y, o.hitRadius, 20) then
        love.graphics.circle("line", o.pos.x, o.pos.y, o.hitRadius)
      end
    end
    love.graphics.setColor(1, 1, 1, 1)
    love.graphics.setLineWidth(1)
  end

  -- Debug: SkyDomePlanetoid's own containment boundary (same 'C' toggle
  -- as every other debug view here) — see
  -- CollisionSystem:handlePlayerSkyDomeContainment's own comment for why
  -- this is two separate pieces rather than one shape: the two vertical
  -- side walls at the deck's own true left/right edges (floor to dome
  -- top), plus the glass dome's own upper ellipse — only the half that
  -- function actually enforces (it never applies below
  -- dome:domeAnchorY()), so only that half is drawn here too, rather
  -- than a full ellipse that would overstate what's actually solid.
  -- Drawn in yellow, distinct from every other debug color already used
  -- here (red/blue/green terrain, magenta player capsule, orange
  -- Spikey).
  if state.showCollisionDebug and state.skyDomePlanet then
    local dome = state.skyDomePlanet
    love.graphics.setLineWidth(3)
    love.graphics.setColor(1, 1, 0.2, 1)

    local deckY = dome:trueSurfaceY()
    local domeTopY = dome:domeAnchorY() - dome.domeRadiusY
    love.graphics.line(dome.pos.x - dome.halfWidth, deckY, dome.pos.x - dome.halfWidth, domeTopY)
    love.graphics.line(dome.pos.x + dome.halfWidth, deckY, dome.pos.x + dome.halfWidth, domeTopY)
    love.graphics.line(dome.pos.x - dome.halfWidth, deckY, dome.pos.x + dome.halfWidth, deckY)

    local cx, cy = dome.pos.x, dome:domeAnchorY()
    local rx, ry = dome.domeRadiusX, dome.domeRadiusY
    local segments = 72
    local points = {}
    for i = 0, segments do
      local t = math.pi + (i / segments) * math.pi
      points[#points + 1] = cx + math.cos(t) * rx
      points[#points + 1] = cy + math.sin(t) * ry
    end
    love.graphics.line(points)

    love.graphics.setColor(1, 1, 1, 1)
    love.graphics.setLineWidth(1)
  end

  -- Fish, then lava: after the player (not back with the other scenery
  -- above) and before the water's top layer just below, so water and
  -- lava cover whatever is in them — reading as submerged rather than
  -- floating in front.
  WorldObjects.draw("submerged")

  -- Every planetoid's water layer — the water planets' included (see
  -- WaterPlanet.lua) — and steam. Same reasoning as lava above: drawn
  -- here, after the player and the fish, so the water renders on top of
  -- them whenever they overlap, reading as submerged rather than
  -- floating in front of it.
  WaterSystem.drawOceans()

  -- Drawn after the water planet's own redraw above, so bubbles stay
  -- visible on top of the translucent fill rather than getting muddied
  -- underneath it (see Player:drawBubbles's own comment).
  state.player:drawBubbles()

  if state.fish then
    for _, fish in ipairs(state.fish) do
      fish:drawBubbles()
    end
  end

  -- Drawn HERE, on top of the just-drawn player, only while the
  -- opening-cutscene door is still closed/opening — see the matching
  -- comment up by drawBody() above for the other half of this z-order
  -- swap.
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

  love.graphics.pop()

  -- A cannon shot's speed lines, streaking past the screen's edges (see
  -- Cannon.drawSpeedLines) — over the world, under everything else.
  Cannon.drawSpeedLines(state.player)

  VatsCursor.drawReticle()

  -- Title screen: just the scene and its own prompt — no minimap, no
  -- HUD text.
  if state.titleScreen then
    TitleScreen.draw()
    return
  end

  if state.minimap then
    state.minimap:draw()
  end

  -- Blaster selector, lower-left (see lua/ui/WeaponBar.lua). Hidden
  -- while a conversation textbox is up (state.dialogueActive), so the
  -- box has the bottom of the screen to itself.
  if not state.dialogueActive then
    WeaponBar.draw()
  end

  -- Conversation textboxes — after the minimap, so the box covers it
  -- rather than the other way round.
  WorldObjects.drawDialogues()

  -- Recording a trailer clip (P - see lua/systems/ClipRecorder.lua):
  -- none of the top-left HUD/debug text goes into the video.
  if not ClipRecorder.isRecording() then
    local cell = worldGen.cellCoordFor(state.player.pos.x, state.player.pos.y)

    love.graphics.setColor(1, 1, 1, 1)
    love.graphics.print(string.format("Level %d - Score: %d", state.level, state.score), 20, 20)
    love.graphics.print(string.format("FPS: %.1f", state.fps or 0), 20, 40)
    love.graphics.print(string.format("Zoom: %.1fx (+/-)", state.zoom), 20, 60)
    love.graphics.print(string.format("Cell: (%d, %d)", cell.col, cell.row), 20, 80)
    love.graphics.print(string.format("Planetoids: %d  Coins: %d  Asteroids: %d  FireBars: %d",
      #state.planetoids,
      state.coins and #state.coins or 0,
      state.asteroids and #state.asteroids or 0,
      state.fireBars and #state.fireBars or 0
    ), 20, 100)
    love.graphics.print(string.format("Rubinium: %d  Asteroidium: %d", state.elements.rubinium, state.elements.asteroidium), 20, 120)
    love.graphics.print(string.format("Mode: %s (Tab / D-pad left-right to switch)   P: record clip", WeaponModes.label()), 20, 140)
    if state.portalMode then
      love.graphics.print("Left-click / L2: red portal, Right-click / R2: blue portal, Space to jump", 20, 160)
    elseif state.waterMode then
      love.graphics.print(string.format("Left-click / R2: spray water (%d / %d), Space to jump (or swim)",
        math.floor(WaterSystem.totalWater() + 0.5), WaterSystem.waterCap()), 20, 160)
    elseif state.recallMode then
      love.graphics.print("Left-click / R2 on a planetoid: rewind it (again to stop), Space to jump", 20, 160)
    elseif state.iceMode then
      love.graphics.print("Left-click / R2: ice bolt (freezes water, cools lava, freezes Ooombas), Space to jump", 20, 160)
    elseif state.pullBeamMode then
      love.graphics.print("Left-click / R2 on a planet to pull toward it, Space to jump, C to toggle collision debug", 20, 160)
    else
      love.graphics.print("Left-click / R2: fireball (L2: pull beam), Space to jump, C to toggle collision debug", 20, 160)
    end
    -- On or near a dirt planet: which way its gravity pulls (see
    -- CrackedPlanetoid:cycleGravity).
    do
      local p = state.player.currentPlanet or state.player.lastInfluencePlanet
      if p and p.cycleGravity then
        love.graphics.print(string.format("Gravity: %s (G to change)   Spin: %s (N clockwise, M counter-clockwise)",
          p.GRAVITY_LABELS[p.gravityMode] or p.gravityMode, p.SPIN_LABELS[p.spinDir] or "Off"), 20, 180)
      end
    end
  end

  PauseMenu.draw()

  -- The black fade-in out of the title screen, over everything.
  TitleScreen.draw()
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
