-- main.lua

local state = require("lua.state")
local constants = require("lua.constants")
local Vector2 = require("lua.vector2")
local Planetoid = require("lua.world.Planetoid")
local Player = require("lua.entities.Player")
local Asteroid = require("lua.entities.Asteroid")
local Coin = require("lua.entities.Coin")
local Ooomba = require("lua.entities.Ooomba")
local Explosion = require("lua.entities.Explosion")
local GravitySystem = require("lua.systems.GravitySystem")
local CollisionSystem = require("lua.systems.CollisionSystem")
local Starfield = require("lua.world.Starfield")
local Sun = require("lua.world.Sun")
local PullBeam = require("lua.effects.PullBeam")
local assetLoading = require("lua.setup.assetLoading")
local inputHandlers = require("lua.setup.inputHandlers")
local gamepadInput = require("lua.setup.gamepadInput")
local worldGen = require("lua.setup.worldGen")
local MiniMap = require("lua.ui.MiniMap")
local SkyDomePlanetoid = require("lua.world.SkyDomePlanetoid")
local SpaceShelter = require("lua.world.SpaceShelter")
local RobotButler = require("lua.entities.RobotButler")
local Fisherman = require("lua.entities.Fisherman")
local TiledTerrain = require("lua.world.TiledTerrain")
local Sphere = require("lua.world.Sphere")
local BeltOrbit = require("lua.systems.BeltOrbitSystem")
local utils = require("lua.utils")
local LockOutline = require("lua.effects.LockOutline")
local InfluenceRing = require("lua.effects.InfluenceRing")
local VatsOverlay = require("lua.effects.VatsOverlay")
local VatsCursor = require("lua.effects.VatsCursor")
local Lava = require("lua.world.Lava")
local WaterPlanet = require("lua.world.WaterPlanet")
local Fish = require("lua.entities.Fish")

local collisionSystem

local ZOOM_MIN = 0.1
local ZOOM_MAX = 2.5
local ZOOM_STEP_PER_FRAME = 0.02
local VATS_TIME_SCALE = 0.05
local VATS_EASE_RATE = 0.12
local VATS_EASE_SNAP_THRESHOLD = 0.005

local HOME_CELL_COL = 13
local HOME_CELL_ROW = 9

function love.load()
  love.window.setTitle("Asteroid Bob")

  -- Starts large (filling the screen) without going into actual
  -- fullscreen mode — conf.lua's window stays resizable with its normal
  -- title bar/chrome (minimize, maximize, close, drag-to-resize) rather
  -- than a borderless takeover; this just maximizes that ordinary
  -- window on launch, exactly like clicking its own maximize button.
  love.window.maximize()

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

  worldGen.initWorldSize()

  state.zoom = 1
  state.zoomMax = ZOOM_MAX
  state.zoomMin = ZOOM_MIN
  state.zoomTarget = nil
  state.timeScale = 1
  state.timeScaleTarget = 1
  state.vatsMultiplier = 1
  state.showCollisionDebug = false
  state.showBeltCellDebug = false
  state.showInfluenceRings = false
  state.vatsActive = false
  state.vatsAutoEnterOnLock = true
  state.vatsTimeScale = VATS_TIME_SCALE
  state.score = 0
  state.level = 1
  state.fireballs = {}
  state.explosions = {}
  state.wallContactPulses = {}
  state.fireBars = state.fireBars or {}
  state.cellCheckCounter = 0
  state.minimap = MiniMap.new()

  assetLoading.loadAssets()
  inputHandlers.attachInputHandlers()

  collisionSystem = CollisionSystem.new()
  state.starfield = Starfield.new()

  local cellSize = worldGen.CELL_SIZE
  -- Doubled from the original 2000 (see :domeRadiusX/Y below, both tied
  -- to this same value) — twice as long, and since domeRadiusY scales
  -- with it too, twice as tall as well. domeX's own formula (below)
  -- keeps the dome's LEFT edge anchored at a fixed point regardless of
  -- this value (domeHalfW cancels out of domeX - domeHalfW), so growing
  -- it only extends the dome further to the right, in the same cell —
  -- no separate repositioning needed to keep it where it was relative
  -- to the belt.
  local domeHalfW = 4000
  -- Left edge of cell 9,14, hull just inside the cell
  local domeX = HOME_CELL_COL * cellSize + domeHalfW + 80
  local domeY = HOME_CELL_ROW * cellSize + cellSize * 0.5

  local dome = SkyDomePlanetoid.new(domeX, domeY, {
    halfWidth = domeHalfW,
    halfHeight = 32,
    grassHeight = 32,
    -- Tied to domeHalfW rather than repeating its own literal — these
    -- default to halfWidth anyway when omitted (SkyDomePlanetoid.lua),
    -- but were kept explicit as a plain hardcoded 2000 here; referencing
    -- the variable instead means resizing the dome again later only
    -- ever needs the one domeHalfW number changed.
    domeRadiusX = domeHalfW,
    domeRadiusY = domeHalfW,
  })
  dome.isPermanent = true
  table.insert(state.planetoids, dome)

  -- Astronaut's home shelter — purely decorative background scenery on
  -- the dome's own deck, toward the left side of it. Drawn separately
  -- (see love.draw below), right after the dome itself and before the
  -- Tiled interior terrain, so the terrain's own hills draw over it
  -- wherever the two happen to overlap rather than the shelter clipping
  -- on top of gameplay geometry.
  state.spaceShelter = SpaceShelter.new(domeX - domeHalfW * 0.6, dome:trueSurfaceY())
  state.skyDomePlanet = dome

  -- Water planet landmark — an ordinary walkable/landable Planetoid
  -- (see WaterPlanet.lua) with a shader-wavy edge instead of a plain
  -- circle. Placed one cell diagonally past the belt's own outer edge,
  -- toward the bottom-right of the sun (screen +x/+y), so it sits just
  -- outside belt territory rather than overlapping it. Half the sun's
  -- own radius (1920), per "not as big as the sun."
  do
    local sunCol, sunRow = worldGen.sunCell()
    local cellSize = worldGen.CELL_SIZE
    local waterCol, waterRow = sunCol + 3, sunRow + 3
    local waterX = (waterCol + 0.5) * cellSize
    local waterY = (waterRow + 0.5) * cellSize
    local waterPlanet, waterCore = WaterPlanet.new(waterX, waterY, 960)
    table.insert(state.planetoids, waterPlanet)
    table.insert(state.planetoids, waterCore)
    state.waterPlanet = waterPlanet
    state.waterCore = waterCore

    state.fish = {}
    local FISH_COUNT = 6
    for _ = 1, FISH_COUNT do
      table.insert(state.fish, Fish.new(waterPlanet, waterCore))
    end

    -- A second, smaller water body — right and a little further down
    -- from the first, with a ~336-unit gap between the two shores. Too
    -- far for an ordinary in-place jump's reach (see Fish.lua's
    -- JUMP_MAX_APEX_FRAC), which is deliberate: crossing this gap needs
    -- Fish.lua's own dedicated cross-pool jump (JUMP_CROSS_* tunables,
    -- decideToJump/startJump) — a fish specifically aiming for another
    -- pool it can reach, launching much harder than an ordinary hop.
    --
    -- At THIS distance, reaching the far shore actually requires
    -- Fish.lua's gravity hand-off (findDominantWaterInfluence): each
    -- WaterPlanet's own influence ring (radius + constants.
    -- INFLUENCE_PADDING) only reaches 1160 units from A's center and
    -- 872 from B's own (smaller) center, and neither ring alone reaches
    -- the far shore — but the two rings still overlap by about 64
    -- units, just barely, so a strong enough launch from A can coast
    -- into B's own ring before A's would have capped it, at which point
    -- B's own gravity takes over and pulls it the rest of the way in.
    -- Pushing the two pools any further apart than this will make the
    -- rings stop overlapping entirely — at that point crossing becomes
    -- flatly impossible without breaking the "never leave a pool's own
    -- influence ring" rule this whole feature is built on, not just a
    -- matter of retuning launch speed.
    local water2X = waterX + 1820
    local water2Y = waterY + 750
    local waterPlanet2, waterCore2 = WaterPlanet.new(water2X, water2Y, 960 * 0.7)
    table.insert(state.planetoids, waterPlanet2)
    table.insert(state.planetoids, waterCore2)
    state.waterPlanet2 = waterPlanet2
    state.waterCore2 = waterCore2

    local FISH_COUNT_2 = 4
    for _ = 1, FISH_COUNT_2 do
      table.insert(state.fish, Fish.new(waterPlanet2, waterCore2))
    end

    -- Three more, small water bodies below the second one (each offset
    -- sideways by a different amount, so none of them sit directly
    -- below it) — half its own radius (336). Placed with a comfortable
    -- ~150-250 unit reach margin each way to/from water2 specifically
    -- (not to each other, though none happen to overlap either), rather
    -- than pushed to the tight limit the water1<->water2 gap already
    -- is — see Fish.lua's own JUMP_CROSS_* tunables and
    -- findDominantWaterInfluence for what that margin actually has to
    -- absorb (randomized launch speed, tangential drift).
    local SMALL_WATER_RADIUS = (960 * 0.7) * 0.5
    local smallWaterOffsets = {
      { -650, 1050 },
      { 100, 1200 },
      { 900, 900 },
    }
    for _, off in ipairs(smallWaterOffsets) do
      local wp, wc = WaterPlanet.new(water2X + off[1], water2Y + off[2], SMALL_WATER_RADIUS)
      table.insert(state.planetoids, wp)
      table.insert(state.planetoids, wc)
      for _ = 1, 3 do
        table.insert(state.fish, Fish.new(wp, wc))
      end
    end
  end

  -- Robot butler NPC — paces back and forth just to the right of the
  -- shelter's own footprint (see RobotButler.lua). Positioned off the
  -- shelter's own right edge (pos.x + half its drawn width) plus a
  -- small gap, rather than a hardcoded offset, so it stays adjacent
  -- even if the shelter's own scale ever changes.
  local ROBOT_GAP_FROM_SHELTER = 60
  local robotHomeX = state.spaceShelter.pos.x + state.spaceShelter.drawWidth / 2 + ROBOT_GAP_FROM_SHELTER
  state.robotButler = RobotButler.new(robotHomeX, dome:trueSurfaceY())

  -- Fisherman NPC — same decorative/interactive role as the robot
  -- butler above, mirrored to the dome's own RIGHT edge instead (a
  -- fixed inset from the true edge so his art doesn't clip off the
  -- walkable deck — see SkyDomePlanetoid.lua's own halfWidth/
  -- trueSurfaceY for the deck's actual bounds).
  local FISHERMAN_GAP_FROM_EDGE = 300
  local fishermanHomeX = dome.pos.x + dome.halfWidth - FISHERMAN_GAP_FROM_EDGE
  state.fisherman = Fisherman.new(fishermanHomeX, dome:trueSurfaceY())

  -- === TILED HILL TERRAIN above the sky dome's ground ===
  -- Replaces the old hardcoded JumpPlatform zigzag: this dome's interior
  -- is now authored in Tiled (tiled/Level1.lua) and loaded as real
  -- walkable terrain (flat ground + 45-degree slopes) via
  -- lua/world/TiledTerrain.lua. Centered horizontally on the dome and
  -- bottom-aligned to its ground line; TiledTerrain.load itself just
  -- takes a plain world-space anchor, so this centering math is the
  -- dome-specific part, kept here rather than baked into that module.
  do
    local levelData = require("tiled.Level1")
    local mapWorldWidth = levelData.width * 64
    local mapWorldHeight = levelData.height * 64
    local anchorX = dome.pos.x - mapWorldWidth / 2
    local anchorY = dome:trueSurfaceY() - mapWorldHeight
    local terrainLevel = TiledTerrain.load(levelData, anchorX, anchorY)

    for _, shape in ipairs(terrainLevel.shapes) do
      -- Every tile inside the dome should feel like standing on the
      -- dome's own deck, jump-wise — Player:jump()'s launch speed reads
      -- self.currentPlanet.jumpStrength directly, and self.currentPlanet
      -- while standing on ordinary Tiled ground is the specific
      -- TerrainShape tile itself, not the dome — so without this it
      -- silently fell back to constants.JUMP_STRENGTH's plain global
      -- value instead of the dome's own stronger, Mario-style one (see
      -- SkyDomePlanetoid.lua's own jumpStrength comment), making jumps
      -- noticeably weaker on ordinary tiles than on the bare deck.
      -- gravityStrength doesn't need the same treatment: TerrainShape's
      -- own isOpenPath flag excludes it from ever being picked as the
      -- FALLING gravity source (see GravitySystem:findDominantPlanet) —
      -- that's always the dome itself, tile or no tile underfoot.
      shape.jumpStrength = dome.jumpStrength
      table.insert(state.planetoids, shape)
    end
    state.tiledLevels = { terrainLevel }
    state.lavas = terrainLevel.lavas

    -- Ooombas are placed explicitly via Tiled's own Object Layer now
    -- (see TiledTerrain.lua's ooombaSpawns) instead of auto-spawned onto
    -- every long-enough walkable shape — that heuristic had no idea a
    -- shape might be the sunken floor of a lava pit or some other spot
    -- that looks walkable but isn't a good fit for a patrol. Each spawn
    -- point can be placed loosely (anywhere above the intended surface,
    -- doesn't need to sit exactly on it) and gets snapped straight down
    -- onto whichever terrain shape it's actually standing over, via the
    -- same swept findLandingCrossing test CollisionSystem itself uses
    -- for landing on open-path terrain. Ramp-climb shapes (isWallClimb)
    -- are excluded from the search — an ordinary edge-patrolling Ooomba
    -- has no concept of "this surface needs active momentum to stay
    -- attached" the way Player.lua's own isWallClimb check does.
    local OOMBA_RAYCAST_DOWN = 6000
    state.ooombas = {}
    for _, spawn in ipairs(terrainLevel.ooombaSpawns or {}) do
      local bestShape, bestDy = nil, nil
      for _, shape in ipairs(terrainLevel.shapes) do
        if not shape.isWallClimb then
          local hit = shape:findLandingCrossing(spawn.x, spawn.y, spawn.x, spawn.y + OOMBA_RAYCAST_DOWN)
          if hit then
            local dy = hit.point.y - spawn.y
            if dy >= 0 and (not bestDy or dy < bestDy) then
              bestDy = dy
              bestShape = shape
            end
          end
        end
      end
      if bestShape then
        local arcPos = bestShape:arcPositionForWorldPoint(spawn.x, spawn.y)
        local direction = (math.random() < 0.5) and -1 or 1
        table.insert(state.ooombas, Ooomba.new(bestShape, arcPos, { direction = direction }))
      end
    end

    -- "Sphere" objects (see lua/world/Sphere.lua): small fixed metal
    -- balls the player can jump on and pull-beam to, exactly like any
    -- other planetoid. Unlike Ooombas above, the spawn point IS the
    -- sphere's own center — no raycast-onto-terrain needed for a
    -- freestanding body.
    for _, spawn in ipairs(terrainLevel.sphereSpawns or {}) do
      table.insert(state.planetoids, Sphere.new(spawn.x, spawn.y))
    end
  end

  -- Spawns at the shelter's own doorway, not dome center — the opening
  -- beat (see SpaceShelter.lua's own intro state machine) has the
  -- player standing behind its closed door when the game starts, the
  -- door sliding open around them, then closing again once they've
  -- stepped out. state.introLocked (checked in love.update) keeps
  -- movement input from interrupting that sequence.
  local topY = dome:trueSurfaceY()
  local doorwayX = state.spaceShelter and (state.spaceShelter:getDoorwayPosition()) or dome.pos.x
  state.player = Player.new(doorwayX, topY - constants.PLAYER_RADIUS)
  state.player.onSurface = true
  state.player.currentPlanet = dome
  state.player.lastInfluencePlanet = dome
  state.player.angle = -math.pi / 2
  state.introLocked = true

  -- Stream the 3x3 around the house, not world center — must run AFTER
  -- the dome above is created and assigned to state.skyDomePlanet, not
  -- before: cell generation steers new planetoids/asteroids away from
  -- the dome's footprint (see WorldGen.lua's isNearSkyDome), and it can
  -- only do that for cells generated while state.skyDomePlanet is
  -- already set — which, for this exact starting neighborhood, is
  -- every cell that actually overlaps the dome's home area.
  worldGen.generateStartingNeighborhood(HOME_CELL_COL, HOME_CELL_ROW)

  state.sun = Sun.new(state.sceneWidth / 2, state.sceneHeight / 2, 1920)

  state.gravitySystem = GravitySystem.new(state.planetoids)
end

local function updatePlanetoidsPhysics()
  for _, p in ipairs(state.planetoids) do
    if p.isImmovable then
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

function love.update(dt)
  if dt > 0 then
    state.fps = (state.fps or 0) * 0.9 + (1 / dt) * 0.1
  end

  gamepadInput.pollGamepad(dt)
  VatsCursor.update(dt)

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

  updatePlanetoidsPhysics()

  if state.asteroids then
    for _, a in ipairs(state.asteroids) do
      a:update()
    end
  end

  if state.coins then
    for _, c in ipairs(state.coins) do
      c:update()
    end
  end

  if state.ooombas then
    for _, o in ipairs(state.ooombas) do
      o:update()
    end
  end

  if state.fireBars then
    for _, bar in ipairs(state.fireBars) do
      bar:update()
    end
  end

  if state.lavas then
    Lava.updateSharedClock()
    for _, lava in ipairs(state.lavas) do
      lava:update()
    end
  end

  WaterPlanet.updateSharedClock()

  if state.fish then
    for _, fish in ipairs(state.fish) do
      fish:update()
    end
  end

  if state.spaceShelter then
    state.spaceShelter:update(dt)
    if state.introLocked and state.spaceShelter.introDone then
      state.introLocked = false
    end
  end

  if state.robotButler then
    state.robotButler:update()
  end

  if state.fisherman then
    state.fisherman:update()
  end

  -- Recomputed fresh every frame (never a flag some NPC sets and might
  -- forget to clear) from whichever NPCs actually have a dialogue box
  -- open right now — Player.lua reads this to freeze movement/jumping
  -- for as long as any conversation is showing, same "empty keys" trick
  -- state.introLocked already uses just below, generalized to cover
  -- every NPC's own dialogueActive rather than hardcoding one.
  state.dialogueActive = (state.robotButler and state.robotButler.dialogueActive)
    or (state.fisherman and state.fisherman.dialogueActive)
    or false

  -- Empty keys while the opening cutscene is running — the player
  -- still stands on the deck normally (gravity/collision below are
  -- untouched), just with no WALKING input read, so they don't wander
  -- off mid-sequence before the door's finished its own choreography.
  state.player:move(state.introLocked and {} or state.keys)

  if state.player.pullTarget then
    state.player:applyPullForce()
  else
    state.gravitySystem:applyTo(state.player)
  end

  state.player:update()

  collisionSystem:handlePlayerPlanetCollisions(state.player)

  -- Gamepad R2 fire: a continuous-hold flag (see GamePadInput.lua),
  -- not an edge-triggered press — called every frame while held, same
  -- as the mouse-click path (love.mousepressed -> shootFireball in
  -- InputHandlers.lua). shootFireball()'s own fireCooldown/lastShotTime
  -- check is what actually throttles the real fire rate; this is what
  -- was missing before — GamePadInput.lua already set
  -- state.gamepadFireHeld every frame from the trigger's analog value,
  -- but nothing ever read it, so R2 silently did nothing.
  if state.gamepadFireHeld and state.player then
    state.player:shootFireball()
  end

  if state.tiledLevels then
    -- Reset once per frame, before re-checking every level's walls below
    -- — handlePlayerWallCollisions only ever SETS this (on actual
    -- contact), never clears it, so without this the flag would latch
    -- true forever after the first touch instead of reflecting only
    -- THIS frame's contact (see Player:jump's wall-jump branch).
    state.player.touchingWall = nil
    state.player.wallContactNormal = nil
    for _, level in ipairs(state.tiledLevels) do
      collisionSystem:handlePlayerWallCollisions(state.player, level.walls)
    end
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
  local collidablePlanetoids = {}
  for _, p in ipairs(state.planetoids) do
    if not p.isBeltPlanetoid or utils.isOnScreen(p.pos.x, p.pos.y, p.radius, 50) then
      table.insert(collidablePlanetoids, p)
    end
  end

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
    local immovablePlanetoids = {}
    for _, p in ipairs(collidablePlanetoids) do
      if p.isImmovable then table.insert(immovablePlanetoids, p) end
    end
    if #immovablePlanetoids > 0 then
      collisionSystem:handleImmovableCollisions(immovablePlanetoids, collidablePlanetoids)
    end
  end

  if state.fireBars and #state.fireBars > 0 then
    if collisionSystem.handlePlayerFireBarCollisions then
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
    collisionSystem:handlePlayerAsteroidCollisions(state.player, state.asteroids)
    collisionSystem:handleElasticCollisions(state.asteroids)

    local toBreak = collisionSystem:handlePlanetAsteroidCollisions(collidablePlanetoids, state.asteroids)
    if next(toBreak) then
      for i = #state.asteroids, 1, -1 do
        if toBreak[state.asteroids[i]] then
          table.remove(state.asteroids, i)
        end
      end
    end
  end

  if state.coins then
    collisionSystem:handleCoinCollisions(state.player, state.coins)
  end

  if state.fireballs then
    for i = #state.fireballs, 1, -1 do
      local f = state.fireballs[i]
      f:update()
      if f:isDead() then
        table.remove(state.fireballs, i)
      end
    end

    if #state.fireballs > 0 and state.asteroids then
      local hitFireballs, toBreakAsteroids, planetHits = collisionSystem:handleFireballCollisions(
        state.fireballs, collidablePlanetoids, state.asteroids
      )
      if next(toBreakAsteroids) then
        for i = #state.asteroids, 1, -1 do
          local a = state.asteroids[i]
          if toBreakAsteroids[a] then
            table.insert(state.explosions, Explosion.new(a.pos.x, a.pos.y))
            if state.audioManager then state.audioManager:playFireball() end
            table.remove(state.asteroids, i)
          end
        end
      end
      for _, hit in ipairs(planetHits) do
        table.insert(state.explosions, Explosion.new(hit.fireball.pos.x, hit.fireball.pos.y))
        if state.audioManager then state.audioManager:playFireball() end
      end
      for i = #state.fireballs, 1, -1 do
        if hitFireballs[state.fireballs[i]] then
          table.remove(state.fireballs, i)
        end
      end
    end
  end

  -- Explosions: purely time-driven visuals (see lua/entities/Explosion.lua)
  if state.explosions then
    for i = #state.explosions, 1, -1 do
      state.explosions[i]:update()
      if state.explosions[i]:isDead() then
        table.remove(state.explosions, i)
      end
    end
  end

  -- Wall-jump contact rings: purely time-driven visuals, same pattern as
  -- explosions above (see lua/entities/WallContactPulse.lua)
  if state.wallContactPulses then
    for i = #state.wallContactPulses, 1, -1 do
      state.wallContactPulses[i]:update()
      if state.wallContactPulses[i]:isDead() then
        table.remove(state.wallContactPulses, i)
      end
    end
  end

  -- Debris/death particles (explosion bursts, etc. — see lua/entities/Particle.lua)
  if state.particles then
    for i = #state.particles, 1, -1 do
      state.particles[i]:update()
      if state.particles[i].life <= 0 then
        table.remove(state.particles, i)
      end
    end
  end

  BeltOrbit.apply(state.planetoids)

  if state.sun then
    state.sun:update()
  end

  state.cellCheckCounter = (state.cellCheckCounter or 0) + 1
  if state.cellCheckCounter >= worldGen.CELL_CHECK_INTERVAL then
    state.cellCheckCounter = 0
    worldGen.updateActiveCells()
  end

  state.beltSpawnCounter = (state.beltSpawnCounter or 0) + 1
  if state.beltSpawnCounter >= worldGen.BELT_SPAWN_INTERVAL then
    state.beltSpawnCounter = 0
    worldGen.updateBeltSpawning()
  end

  if state.keys['+'] or state.keys['='] then
    state.zoom = math.min(ZOOM_MAX, state.zoom + ZOOM_STEP_PER_FRAME)
    state.zoomTarget = nil
  end
  if state.keys['-'] or state.keys['_'] then
    state.zoom = math.max(ZOOM_MIN, state.zoom - ZOOM_STEP_PER_FRAME)
    state.zoomTarget = nil
  end

  local zoom = state.zoom
  local visibleWidth = love.graphics.getWidth() / zoom
  local visibleHeight = love.graphics.getHeight() / zoom
  local camera = {
    x = state.player.pos.x - visibleWidth / 2,
    y = state.player.pos.y - visibleHeight / 2,
  }
  local maxCameraX = state.sceneWidth - visibleWidth
  local maxCameraY = state.sceneHeight - visibleHeight
  camera.x = maxCameraX > 0 and math.min(math.max(camera.x, 0), maxCameraX) or maxCameraX / 2
  camera.y = maxCameraY > 0 and math.min(math.max(camera.y, 0), maxCameraY) or maxCameraY / 2
  state.camera = camera
  state.visibleWidth = visibleWidth
  state.visibleHeight = visibleHeight
end

function love.draw()
  Planetoid.beginFrame()
  state.starfield:draw(state.camera, state.visibleWidth, state.visibleHeight)

  love.graphics.push()
  love.graphics.scale(state.zoom, state.zoom)
  love.graphics.translate(-state.camera.x, -state.camera.y)

  if state.skyDomePlanet then
    state.skyDomePlanet:draw()
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
    state.spaceShelter:drawBody()
    if state.spaceShelter.playerInFront then
      state.spaceShelter:drawDoor()
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
  -- culling only :draw() never risks.
  if state.asteroids then
    for _, a in ipairs(state.asteroids) do
      if utils.isOnScreen(a.pos.x, a.pos.y, a.radius, 50) then
        a:draw()
      end
    end
  end

  -- Influence-radius rings ('R' toggles — see InputHandlers.lua): only
  -- for planetoids GravitySystem itself treats as plain circular gravity
  -- sources (has influenceRadius, not isRoundedRect — see
  -- GravitySystem:findDominantPlanet's own branching). The dome and
  -- TiledTerrain shapes are deliberately skipped: their real gravity
  -- range isn't a circle at all (isWithinGravityWindow / "whatever's
  -- underfoot"), so a ring around them would just be wrong, not merely
  -- redundant.
  if state.showInfluenceRings then
    for _, p in ipairs(state.planetoids) do
      if p.influenceRadius and not p.isRoundedRect
         and utils.isOnScreen(p.pos.x, p.pos.y, p.influenceRadius, 50) then
        p:updateCachedAlpha()
        InfluenceRing.draw(p.pos.x, p.pos.y, p.influenceRadius, p.cachedAlpha)
      end
    end
  end

  -- Every water body's own opaque BACKDROP (see WaterPlanet.lua's own
  -- comment on drawWaterBackdrop) drawn first, so the core/player/fish
  -- below layer normally on top of it, and the translucent shell's own
  -- later redraw pass (after the player — see further down) blends its
  -- shading/caustics over an already-solid base instead of raw
  -- starfield. Without this, turning BODY_OPACITY down made the water
  -- look "ghostly" — the background showed through evenly whether or
  -- not something was actually standing in the water.
  for _, p in ipairs(state.planetoids) do
    if p.isWaterPlanet and p.drawBackdrop and utils.isOnScreen(p.pos.x, p.pos.y, p.radius, 50) then
      p:drawBackdrop()
    end
  end

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
    end
  end

  if state.tiledLevels then
    for _, level in ipairs(state.tiledLevels) do
      if utils.isOnScreen(level.pos.x, level.pos.y, level.radius, 50) then
        level:draw()
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
          for _, wall in ipairs(level.walls or {}) do
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

  if state.ooombas then
    for _, o in ipairs(state.ooombas) do
      if utils.isOnScreen(o.pos.x, o.pos.y, math.max(o.halfWidth, o.halfHeight), 20) then
        o:draw()
      end
    end
  end

  if state.robotButler then
    local r = state.robotButler
    if utils.isOnScreen(r.pos.x, r.pos.y, math.max(r.halfWidth, r.halfHeight), 20) then
      r:draw()
      r:drawTooltip()
    end
  end

  if state.fisherman then
    local f = state.fisherman
    if utils.isOnScreen(f.pos.x, f.pos.y, math.max(f.halfWidth, f.halfHeight), 20) then
      f:draw()
      f:drawTooltip()
    end
  end

  if state.coins then
    for _, c in ipairs(state.coins) do
      if utils.isOnScreen(c.pos.x, c.pos.y, c.radius, 20) then
        c:draw()
      end
    end
  end

  if state.fireBars then
    for _, bar in ipairs(state.fireBars) do
      if utils.isOnScreen(bar.pos.x, bar.pos.y, bar.barLength + bar.fireballRadius, 50) then
        bar:draw()
      end
    end
  end

  state.player:draw()

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
    local headReach = (not state.player.isBall) and (state.player.headReach or 0) or 0
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

  -- Same "draw before the water's second pass so its translucent fill
  -- reads as covering them" reasoning as the player himself — see the
  -- water re-draw a bit further down.
  if state.fish then
    for _, fish in ipairs(state.fish) do
      if utils.isOnScreen(fish.pos.x, fish.pos.y, 70, 50) then
        fish:draw()
      end
    end
  end

  -- Drawn AFTER the player (not back with the other hazards/scenery
  -- above) so lava visually covers him the moment he's in it, instead of
  -- him rendering on top of a hazard he's supposedly submerged in —
  -- z-order standing in for "he's under the surface" until lava actually
  -- kills him.
  if state.lavas then
    for _, lava in ipairs(state.lavas) do
      if utils.isOnScreen(lava.pos.x, lava.pos.y, lava.radius, 50) then
        lava:draw()
      end
    end
  end

  -- Same reasoning as lava above — drawn again here (excluded from the
  -- ordinary planetoid pass) so the water always renders on top of the
  -- player whenever they overlap, reading as submerged rather than
  -- floating in front of it. Every water body's shell gets this same
  -- treatment, not just one named one — see the exclusion pass above's
  -- own comment.
  for _, p in ipairs(state.planetoids) do
    if p.isWaterPlanet and utils.isOnScreen(p.pos.x, p.pos.y, p.radius, 50) then
      p:draw()
    end
  end

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

  if state.fireballs then
    for _, f in ipairs(state.fireballs) do
      f:draw()
    end
  end

  if state.particles then
    for _, p in ipairs(state.particles) do
      p:draw()
    end
  end

  if state.explosions then
    for _, e in ipairs(state.explosions) do
      e:draw()
    end
  end

  if state.wallContactPulses then
    for _, p in ipairs(state.wallContactPulses) do
      p:draw()
    end
  end

  if state.skyDomePlanet then
    state.skyDomePlanet:drawForegroundGlass()
  end

  VatsOverlay.draw()
  LockOutline.draw()

  love.graphics.pop()

  VatsCursor.drawReticle()

  if state.robotButler then
    state.robotButler:drawDialogue()
  end

  if state.fisherman then
    state.fisherman:drawDialogue()
  end

  if state.minimap then
    state.minimap:draw()
  end

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
  love.graphics.print("Right-click a planet to pull toward it, Space to jump, C to toggle collision debug", 20, 120)
end