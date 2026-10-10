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
local Particle = require("lua.entities.Particle")
local StompBurst = require("lua.effects.StompBurst")
local TitleScreen = require("lua.ui.TitleScreen")
local PauseMenu = require("lua.ui.PauseMenu")
local GravitySystem = require("lua.systems.GravitySystem")
local CollisionSystem = require("lua.systems.CollisionSystem")
local CameraDirector = require("lua.systems.CameraDirector")
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
local SphereMove = require("lua.world.SphereMove")
local RoundedRectPlanetoid = require("lua.world.RoundedRectPlanetoid")
local Spikey = require("lua.world.Spikey")
local SpikeyVertical = require("lua.world.SpikeyVertical")
local SpikeyOrbit = require("lua.world.SpikeyOrbit")
local Lever = require("lua.world.Lever")
local Crank = require("lua.world.Crank")
local Mirror = require("lua.world.Mirror")
local Sign = require("lua.world.Sign")
local PinballInterior = require("lua.interiors.PinballInterior")
local Beam = require("lua.world.Beam")
local Gate = require("lua.world.Gate")
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

local ZOOM_MIN = 0.6
local ZOOM_MAX = 2.5
local ZOOM_STEP_PER_FRAME = 0.02
-- Zoom-Window easing (see the zoom-window pass in love.update): fraction
-- of the remaining distance to the target zoom covered each frame, and
-- how close counts as "arrived".
local ZOOM_WINDOW_EASE_PER_FRAME = 0.03
local ZOOM_WINDOW_SNAP = 0.002
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

local HOME_CELL_COL = 13
local HOME_CELL_ROW = 9

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
  state.planetoids, state.asteroids, state.coins = {}, {}, {}
  state.fireBars, state.particles, state.enemies = {}, {}, {}

  -- Set only inside conditional blocks below — cleared so nothing from
  -- the last game survives if a block doesn't run.
  state.fish, state.beams, state.lavas, state.tiledLevels = nil, nil, nil, nil
  state.ooombas, state.spikeys, state.mirrors, state.levers = nil, nil, nil, nil
  state.cranks, state.signs, state.gates = nil, nil, nil
  state.zoomWindows, state.deathZones = nil, nil
  state.pinballPlanet, state.waterPlanet, state.waterCore, state.roundedRectPlanet = nil, nil, nil, nil
  state.beltLandingPlanet = nil

  -- Whatever was in progress.
  state.camera = nil
  state.cameraDirector = nil
  state.activeZoomWindow, state.zoomWindowReturn = nil, nil
  state.dialogueActive = false
  state.paused = false
  state.gameOver, state.levelComplete = false, false
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

    -- Starts large (filling the screen) without going into actual
    -- fullscreen mode — conf.lua's window stays resizable with its normal
    -- title bar/chrome (minimize, maximize, close, drag-to-resize) rather
    -- than a borderless takeover; this just maximizes that ordinary
    -- window on launch, exactly like clicking its own maximize button.
    love.window.maximize()
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
  state.level = 1
  state.fireballs = {}
  state.explosions = {}
  state.wallContactPulses = {}
  state.fireBars = state.fireBars or {}
  state.cellCheckCounter = 0
  state.minimap = MiniMap.new()

  if firstLoad then
    assetLoading.loadAssets()
    inputHandlers.attachInputHandlers()
    -- EXIT TO TITLE: run this whole function again (see its own header).
    PauseMenu.onExitToTitle = function() love.load() end
  end

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

  -- "Pinball" planet — a tall RoundedRectPlanetoid (see
  -- lua/world/RoundedRectPlanetoid.lua; same typical baked body/
  -- sun-shading look every rounded-rect landmark already uses, just a
  -- different shape than a plain circular Planetoid) sitting directly
  -- below the dome, with an actual pinball-table level overlaid on its
  -- face — an outer boundary, an obstacle wall, bumpers, flippers, and
  -- plungers, all traced directly over the real reference image
  -- (img/pinball.png) using pinball-editor.html, with real
  -- circle-vs-polygon/bumper collision math behind the boundary/wall/
  -- bumpers (see lua/interiors/PinballInterior.lua, drawn automatically
  -- for any planetoid with a .interior — see main.lua's own draw loop
  -- below). Half-width:half-height is ~0.6, matching that reference
  -- image's own proportions. Actually entering/playing it isn't wired
  -- up at all yet (no ball entity, no flipper-swing/plunger-pull
  -- gameplay) — this is the exterior landmark + overlay + ready-to-use
  -- collision, nothing more.
  local SHOW_PINBALL_PLANET = false -- off for now: no pinball planet, and so no entry beam for it either (that only exists if the planet does). true brings both back.
  if SHOW_PINBALL_PLANET then
    -- Doubled from the original 225/375/50, per explicit request after
    -- seeing it in place — the overlay's own shapes are plain vector
    -- polygons (see PinballInterior.lua), so this doesn't add any new
    -- detail, but it does make everything on the table more legible.
    local PINBALL_PLANET_HALF_WIDTH = 450 -- 0.6 * half-height, matching the reference image's own aspect ratio
    local PINBALL_PLANET_HALF_HEIGHT = 750
    local PINBALL_PLANET_CORNER_RADIUS = 100
    local PINBALL_PLANET_GAP = 300 -- clearance kept below the dome's own base before this planet starts
    local pinballX = dome.pos.x
    local pinballY = dome:domeAnchorY() + dome.baseRadiusY + PINBALL_PLANET_GAP + PINBALL_PLANET_HALF_HEIGHT

    local pinballPlanet = RoundedRectPlanetoid.new(
      pinballX, pinballY,
      PINBALL_PLANET_HALF_WIDTH, PINBALL_PLANET_HALF_HEIGHT, PINBALL_PLANET_CORNER_RADIUS,
      { 0.55, 0.57, 0.62, 1 })
    pinballPlanet.isImmovable = true
    pinballPlanet.isPermanent = true
    pinballPlanet.vel.x, pinballPlanet.vel.y = 0, 0
    pinballPlanet.rotationAngle = 0
    pinballPlanet.rotationSpeed = 0
    pinballPlanet.interior = PinballInterior.new(pinballPlanet)
    table.insert(state.planetoids, pinballPlanet)
    state.pinballPlanet = pinballPlanet
  end

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

  -- Rounded-rectangle landmark planetoid (see
  -- lua/world/RoundedRectPlanetoid.lua, ported from the old JS game's
  -- RoundedRectPlanetoid.js) — unlike every circular planetoid, the
  -- player can land and walk all the way around this one, not just
  -- stand on top. Placed directly above the SECOND water planet
  -- (state.waterPlanet2, not the largest one) — needs that table
  -- already populated, which is why this block runs AFTER the water
  -- block above rather than right next to the dome the way an earlier
  -- version of this did. Locked level (rotationAngle/rotationSpeed = 0,
  -- overriding the random spin the constructor gives it by default) and
  -- made a fixed landmark (isImmovable/isPermanent, vel zeroed) — same
  -- override-after-construction convention the belt-landing Sphere
  -- below already uses, not something the constructor itself forces.
  do
    -- Halved from this landmark's own original size (600x400, corner
    -- 60) per explicit request.
    local ROUNDED_RECT_HALF_WIDTH = 150
    local ROUNDED_RECT_HALF_HEIGHT = 100
    local ROUNDED_RECT_CORNER_RADIUS = 30
    -- How far (world units) the fisherman's own hook dangles below
    -- wherever he's standing, once planted at the rect's own top surface
    -- — worked out from his actual rig, not guessed: his own origin
    -- sits bodyHalfHeight (24.85, from Fisherman-Body.png's 497px height
    -- * BODY_SCALE 0.1 / 2) ABOVE his feet, the rod tip (POSE.lineY =
    -- -1118, same pre-scale units as every other POSE offset) sits
    -- 111.8 world units above THAT, and the hook (the line's own far
    -- end, 9920px long, jointY=26 near its top) hangs
    -- (9920-26)*BODY_SCALE = 989.4 world units below the rod tip. Net:
    -- 989.4 - 111.8 - 24.85 = 852.75 world units below his own feet.
    local FISHERMAN_HOOK_REACH = 852.75
    -- How far INTO the water the hook should actually end up, past its
    -- own surface — purely a "does it look right" number, easiest of
    -- all these to retune by eye once this is actually on screen.
    local FISHERMAN_HOOK_WATER_DIP = 80
    local groundY = state.waterPlanet2.pos.y - state.waterPlanet2.radius
      - FISHERMAN_HOOK_WATER_DIP - FISHERMAN_HOOK_REACH
    local rectY = groundY + ROUNDED_RECT_HALF_HEIGHT
    local rectX = state.waterPlanet2.pos.x
    -- Manual nudge on top of the computed placement above, per several
    -- explicit requests after seeing it on screen each time — cumulative:
    -- (-50, 80), then (-50, 50), then (-50, 80).
    local ROUNDED_RECT_NUDGE_X = -150
    local ROUNDED_RECT_NUDGE_Y = 210
    rectX = rectX + ROUNDED_RECT_NUDGE_X
    rectY = rectY + ROUNDED_RECT_NUDGE_Y
    local roundedRectPlanet = RoundedRectPlanetoid.new(
      rectX, rectY,
      ROUNDED_RECT_HALF_WIDTH, ROUNDED_RECT_HALF_HEIGHT, ROUNDED_RECT_CORNER_RADIUS,
      { 0.68, 0.56, 0.42, 1 })
    roundedRectPlanet.isImmovable = true
    roundedRectPlanet.isPermanent = true
    roundedRectPlanet.vel.x, roundedRectPlanet.vel.y = 0, 0
    roundedRectPlanet.rotationAngle = 0
    roundedRectPlanet.rotationSpeed = 0
    table.insert(state.planetoids, roundedRectPlanet)
    state.roundedRectPlanet = roundedRectPlanet
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
  -- butler above. Stands at the RIGHT edge of the new rounded-rect
  -- landmark (state.roundedRectPlanet, directly above the second water
  -- planet — see that block's own comment) rather than the dome, so his
  -- line+hook actually dangle down into the water below instead of
  -- dangling over empty space. FISHERMAN_GAP_FROM_EDGE here is a small
  -- clip margin (the rect has a flat edge, not the dome's own huge
  -- curve, so it doesn't need nearly as much inset to keep his art from
  -- visually hanging off it).
  local FISHERMAN_GAP_FROM_EDGE = 50
  local fishermanHomeX = state.roundedRectPlanet.pos.x + state.roundedRectPlanet.halfWidth - FISHERMAN_GAP_FROM_EDGE
  local fishermanGroundY = state.roundedRectPlanet.pos.y - state.roundedRectPlanet.halfHeight
  state.fisherman = Fisherman.new(fishermanHomeX, fishermanGroundY)

  -- === Beam pair: shelter <-> belt-edge landing planet ===
  -- See lua/world/Beam.lua (ported from the old JS game's
  -- BeamPlanetoid, minus the maze/platform "interior" concept that
  -- version tied a beam to — this is just a point-to-point teleporter).
  -- homeBeam sits just left of the shelter, on the dome's own deck.
  -- beltBeam sits on TOP of a small new landing planet placed along the
  -- SAME radial line from the sun the dome itself already sits on (the
  -- closest "under the dome" can mean while ALSO being near the belt,
  -- since the dome's own position is already well outside the belt's
  -- outer edge — literally directly below the dome in x/y would never
  -- be close enough), pulled in to just past the belt's outer radius —
  -- then nudged further down the screen from there (BELT_PLANET_EXTRA_DOWN)
  -- so it reads more clearly as its own separate landmark. Both beams
  -- planted exactly like Lever.lua's own ground objects: pointing
  -- straight up, away from whatever surface they're standing on.
  do
    local BEAM_GAP_FROM_SHELTER = 150
    local homeBeam = Beam.new(
      state.spaceShelter.pos.x - state.spaceShelter.drawWidth / 2 - BEAM_GAP_FROM_SHELTER,
      dome:trueSurfaceY(), -math.pi / 2)

    local sunX, sunY = worldGen.sunPos()
    local _, beltOuterRadius = worldGen.beltRadii()
    local dirX, dirY = domeX - sunX, domeY - sunY
    local dirLen = math.sqrt(dirX * dirX + dirY * dirY)
    dirX, dirY = dirX / dirLen, dirY / dirLen

    local BELT_PLANET_RADIUS = 120
    -- Clear space between the landing planet's own surface and the
    -- belt's outer edge — real but short, same spirit as Fish.lua's own
    -- cross-pool jump margins (a gap the player is clearly MEANT to
    -- clear, not one that's borderline).
    local BELT_PLANET_GAP = 260
    local beltPlanetDist = beltOuterRadius + BELT_PLANET_RADIUS + BELT_PLANET_GAP
    local beltPlanetX = sunX + dirX * beltPlanetDist
    -- A plain screen-space downward nudge from there (NOT further along
    -- dirX/dirY — the dome sits slightly ABOVE the sun, so dirY itself
    -- is negative, and pushing further along it would actually move the
    -- planet UP, the opposite of what's wanted here).
    local BELT_PLANET_EXTRA_DOWN = 500
    local beltPlanetY = sunY + dirY * beltPlanetDist + BELT_PLANET_EXTRA_DOWN

    local beltLandingPlanet = Sphere.new(beltPlanetX, beltPlanetY, BELT_PLANET_RADIUS)
    table.insert(state.planetoids, beltLandingPlanet)
    state.beltLandingPlanet = beltLandingPlanet -- its own sign is planted further down, once state.signs exists

    local beltBeam = Beam.new(beltPlanetX, beltPlanetY - BELT_PLANET_RADIUS, -math.pi / 2)

    homeBeam.destination = beltBeam
    beltBeam.destination = homeBeam
    state.beams = { homeBeam, beltBeam }
  end

  -- === Pinball planet entry beam ===
  -- Planted on top of the pinball planet (see the SHOW_PINBALL_PLANET
  -- block above) — stepping through it drops the player onto the
  -- plunger, already curled into a ball (see
  -- lua/interiors/PinballInterior.lua:onEnter). Unlike the home<->belt
  -- pair above, this is deliberately ONE-WAY: its own "destination" is
  -- a plain synthetic table (not another Beam) — Player:updateTeleport
  -- only ever reads destination.pos/destination.angle (see its own
  -- comment), so anything with those two fields works as a valid
  -- target, and destination.onArrive (a small extension this needed —
  -- see Player:updateTeleport's own "out" phase) is what actually
  -- curls him into a ball and hands control to PinballInterior the
  -- instant he lands. Getting back OUT happens by draining off the
  -- bottom of the table (PinballInterior:exitBall), not a return beam.
  if state.pinballPlanet then
    local pinball = state.pinballPlanet
    local PINBALL_BEAM_OFFSET_X = -pinball.halfWidth * 0.4 -- off-center so it doesn't sit exactly at the rounded top's own midpoint
    local pinballBeamX = pinball.pos.x + PINBALL_BEAM_OFFSET_X
    local pinballBeamY = pinball.pos.y - pinball.halfHeight
    local pinballBeam = Beam.new(pinballBeamX, pinballBeamY, -math.pi / 2, { 0.95, 0.45, 0.15 }) -- orange, distinct from the home<->belt pair's own violet
    pinballBeam.destination = {
      pos = pinball.interior:getPortalPosition(),
      angle = -math.pi / 2,
      onArrive = function(player)
        pinball.interior:onEnter(player)
      end,
    }
    table.insert(state.beams, pinballBeam)
  end

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
    --
    -- entitiesById collects every spawned Sphere/Spikey by its own
    -- Tiled object id as it goes, so a Spikey-Orbit object further down
    -- this same loop set (spawned after all of these, see
    -- spikeyOrbitSpawns below) can resolve its own "orbit" property —
    -- just the raw id at this point, read by TiledTerrain.lua — back to
    -- the actual entity it names, whichever of these two lists it came
    -- from.
    local entitiesById = {}
    for _, spawn in ipairs(terrainLevel.sphereSpawns or {}) do
      -- spawn.radius: the object's optional "radius" property in Tiled;
      -- nil falls back to Sphere.DEFAULT_RADIUS.
      local sphere = Sphere.new(spawn.x, spawn.y, spawn.radius)
      table.insert(state.planetoids, sphere)
      if spawn.id then entitiesById[spawn.id] = sphere end

      -- spawn.gravityRadius: the object's optional "gravity" property —
      -- how far out from the Sphere's center its gravity reaches. A
      -- Sphere's own default reach is deliberately tiny (see Sphere.new),
      -- so small that a jump off anywhere but the very top leaves its
      -- pull and never comes back; setting this is how a Sphere becomes
      -- somewhere he can jump around on. It has to reach past the
      -- surface to do anything at all, so a value that doesn't is
      -- reported rather than silently applied.
      if spawn.gravityRadius then
        if spawn.gravityRadius > sphere.radius then
          sphere.influenceRadius = spawn.gravityRadius
        else
          print(string.format(
            "main.lua: Sphere at (%.0f, %.0f) has gravity=%s, which is not beyond its own radius of %s — ignored.",
            spawn.x, spawn.y, tostring(spawn.gravityRadius), tostring(sphere.radius)))
        end
      end

      -- spawn.ooombaCount: the object's optional "ooomba" property —
      -- that many Ooombas walking laps of this Sphere (see
      -- Ooomba.newOnPlanet). Spaced evenly round it and all walking the
      -- same way at the same speed, so they keep their spacing and
      -- never bunch up or pass through one another; which way is
      -- picked per Sphere, and the starting point is random so two
      -- Spheres with Ooombas don't look like copies of each other.
      -- Ordinary Ooombas in every other respect: lethal to touch, can
      -- be stomped or shot.
      if (spawn.ooombaCount or 0) > 0 then
        local direction = math.random() < 0.5 and -1 or 1
        local firstAngle = math.random() * math.pi * 2
        for i = 1, spawn.ooombaCount do
          local angle = firstAngle + (i - 1) / spawn.ooombaCount * math.pi * 2
          table.insert(state.ooombas, Ooomba.newOnPlanet(sphere, angle, { direction = direction }))
        end
      end
    end

    -- "Sphere-Move" objects (see lua/world/SphereMove.lua): same Sphere,
    -- just shuttling back and forth between two points instead of
    -- sitting still. Added straight into state.planetoids too — it's a
    -- full Planetoid in every other respect (gravity, landing,
    -- pull-beam targeting), so it needs no separate list or wiring
    -- anywhere else, just like plain Sphere above.
    for _, spawn in ipairs(terrainLevel.sphereMoveSpawns or {}) do
      table.insert(state.planetoids, SphereMove.new(
        spawn.x, spawn.y, spawn.startX, spawn.startY, spawn.endX, spawn.endY, nil, spawn.speed))
    end

    -- "Spikey" objects (see lua/world/Spikey.lua): gray, spike-ringed
    -- hazards that kill the player on contact
    -- (CollisionSystem:handlePlayerSpikeyCollisions) — deliberately NOT
    -- planetoids (no gravity, no landing/orbital walking around them),
    -- so they get their own separate list rather than state.planetoids.
    -- Stationary, same point-placement convention as the Sphere spawns
    -- just above.
    state.spikeys = {}
    for _, spawn in ipairs(terrainLevel.spikeySpawns or {}) do
      local spikey = Spikey.new(spawn.x, spawn.y)
      table.insert(state.spikeys, spikey)
      if spawn.id then entitiesById[spawn.id] = spikey end
    end

    -- "Spikey-Vertical" objects (see lua/world/SpikeyVertical.lua):
    -- same hazard, but patrols up and down within a shaft.
    -- TiledTerrain.lua's own tile-grid scan already resolved topY/
    -- bottomY against the nearest WALL in each direction, where one
    -- exists — this pass additionally clamps (or, if that scan found
    -- no wall at all on a given side, ENTIRELY SUPPLIES) those bounds
    -- against any Spikey (from the loop just above) sitting in the
    -- same column, so "collides with a wall OR another Spikey" holds
    -- as two genuinely equal alternatives, not "a wall, with Spikeys
    -- only ever narrowing that further." A shaft with a wall ceiling
    -- but no floor tile at all — bounded only by a stack of ordinary
    -- Spikeys below it — is exactly the case this fixes: TiledTerrain's
    -- own scan leaves bottomY nil there, and this pass is what actually
    -- resolves it instead of leaving the whole spawn dead on arrival.
    -- Added to the same state.spikeys list as everything else here, so
    -- it's collided with/drawn exactly like a plain Spikey with zero
    -- extra wiring anywhere else.
    local SPIKEY_VERTICAL_RADIUS = Spikey.DEFAULT_RADIUS
    for _, spawn in ipairs(terrainLevel.spikeyVerticalSpawns or {}) do
      local topY, bottomY = spawn.topY, spawn.bottomY
      for _, other in ipairs(state.spikeys) do
        -- "Same column" fuzziness — both radii, not just one, since
        -- either body's own width can bring them into contact even
        -- when their CENTERS aren't perfectly aligned.
        if math.abs(other.pos.x - spawn.x) < other.radius + SPIKEY_VERTICAL_RADIUS then
          if other.pos.y < spawn.y then
            local bound = other.pos.y + other.radius + SPIKEY_VERTICAL_RADIUS
            topY = topY and math.max(topY, bound) or bound
          elseif other.pos.y > spawn.y then
            local bound = other.pos.y - other.radius - SPIKEY_VERTICAL_RADIUS
            bottomY = bottomY and math.min(bottomY, bound) or bound
          end
        end
      end
      -- Only NOW (after both a wall AND a nearby-Spikey chance) is this
      -- actually a failure — nothing at all bounds one side, which
      -- would let it patrol forever in that direction with nothing to
      -- ever turn it around.
      if topY and bottomY and bottomY > topY then
        table.insert(state.spikeys, SpikeyVertical.new(spawn.x, topY, bottomY, SPIKEY_VERTICAL_RADIUS, spawn.speed))
      else
        print(string.format(
          "main.lua: Spikey-Vertical at (%.1f, %.1f) found no wall or nearby Spikey to bound it on one side (topY=%s, bottomY=%s) — not spawned.",
          spawn.x, spawn.y, tostring(topY), tostring(bottomY)))
      end
    end

    -- "Spikey-Orbit" objects (see lua/world/SpikeyOrbit.lua): same
    -- hazard again, but orbits clockwise around whatever entity its own
    -- "orbit" property names (resolved here against entitiesById, built
    -- above as the Sphere/Spikey spawns happened — this is why this
    -- loop has to come after both of those, not before). The orbit's
    -- own radius/starting angle come from however far apart the two
    -- objects actually are in Tiled right now — see SpikeyOrbit.new.
    for _, spawn in ipairs(terrainLevel.spikeyOrbitSpawns or {}) do
      local center = spawn.orbitId and entitiesById[spawn.orbitId]
      if center then
        table.insert(state.spikeys, SpikeyOrbit.new(spawn.x, spawn.y, center, Spikey.DEFAULT_RADIUS, spawn.speed))
      else
        print(string.format(
          "main.lua: Spikey-Orbit at (%.1f, %.1f) names orbit id %s, which isn't a spawned Sphere/Spikey — not spawned.",
          spawn.x, spawn.y, tostring(spawn.orbitId)))
      end
    end

    -- "Mirror" objects (see lua/world/Mirror.lua): freestanding, same
    -- point-placement convention as the Sphere/Spikey spawns above —
    -- added to entitiesById too, so a Crank's own "Mirror" property
    -- (resolved below, once this loop has run) can find it.
    state.mirrors = {}
    for _, spawn in ipairs(terrainLevel.mirrorSpawns or {}) do
      local mirror = Mirror.new(spawn.x, spawn.y, spawn.angle)
      table.insert(state.mirrors, mirror)
      if spawn.id then entitiesById[spawn.id] = mirror end
    end

    -- "Lever" objects (see lua/world/Lever.lua): placed on the ground
    -- via the exact same raycast-down approach as Ooombas above (loosely
    -- placed in Tiled, snapped onto whatever TerrainShape surface
    -- actually sits below it).
    state.levers = {}
    for _, spawn in ipairs(terrainLevel.leverSpawns or {}) do
      local bestShape, bestDy, bestHit = nil, nil, nil
      for _, shape in ipairs(terrainLevel.shapes) do
        if not shape.isWallClimb then
          local hit = shape:findLandingCrossing(spawn.x, spawn.y, spawn.x, spawn.y + OOMBA_RAYCAST_DOWN)
          if hit then
            local dy = hit.point.y - spawn.y
            if dy >= 0 and (not bestDy or dy < bestDy) then
              bestDy = dy
              bestShape = shape
              bestHit = hit
            end
          end
        end
      end
      if bestHit then
        local lever = Lever.new(bestHit.point.x, bestHit.point.y)
        lever.gateId = spawn.gateId
        table.insert(state.levers, lever)
      end
    end

    -- "Crank" objects (see lua/world/Crank.lua): same raycast-down
    -- ground placement as the levers just above.
    state.cranks = {}
    for _, spawn in ipairs(terrainLevel.crankSpawns or {}) do
      local bestShape, bestDy, bestHit = nil, nil, nil
      for _, shape in ipairs(terrainLevel.shapes) do
        if not shape.isWallClimb then
          local hit = shape:findLandingCrossing(spawn.x, spawn.y, spawn.x, spawn.y + OOMBA_RAYCAST_DOWN)
          if hit then
            local dy = hit.point.y - spawn.y
            if dy >= 0 and (not bestDy or dy < bestDy) then
              bestDy = dy
              bestShape = shape
              bestHit = hit
            end
          end
        end
      end
      if bestHit then
        local crank = Crank.new(bestHit.point.x, bestHit.point.y)
        crank.mirrorId = spawn.mirrorId
        crank.mirror = spawn.mirrorId and entitiesById[spawn.mirrorId]
        table.insert(state.cranks, crank)
      end
    end

    -- "Sign" objects (see lua/world/Sign.lua): same raycast-down
    -- ground placement as the levers/cranks above.
    state.signs = {}
    for _, spawn in ipairs(terrainLevel.signSpawns or {}) do
      local bestShape, bestDy, bestHit = nil, nil, nil
      for _, shape in ipairs(terrainLevel.shapes) do
        if not shape.isWallClimb then
          local hit = shape:findLandingCrossing(spawn.x, spawn.y, spawn.x, spawn.y + OOMBA_RAYCAST_DOWN)
          if hit then
            local dy = hit.point.y - spawn.y
            if dy >= 0 and (not bestDy or dy < bestDy) then
              bestDy = dy
              bestShape = shape
              bestHit = hit
            end
          end
        end
      end
      if bestHit then
        table.insert(state.signs, Sign.new(bestHit.point.x, bestHit.point.y, spawn.message))
      end
    end

    -- "Zoom-Window" objects: world-space rectangles, already fully
    -- resolved by TiledTerrain.lua — see the zoom-window pass in
    -- love.update for what they actually do.
    state.zoomWindows = terrainLevel.zoomWindows or {}

    -- "DeathZone" objects: dying inside one respawns the player at its
    -- own respawn point rather than the shelter door (see
    -- Player:startDeath/respawn). The point is loosely placed like the
    -- signs/levers above: if there's ground within reach just below it
    -- (searching from one tile above, in case it was clicked right at
    -- ground level), he's stood on that ground instead of being left
    -- overlapping it; otherwise the point is used exactly as given and
    -- he simply drops from there.
    local RESPAWN_SEARCH_UP, RESPAWN_SEARCH_DOWN = 64, 200
    state.deathZones = terrainLevel.deathZones or {}
    for _, zone in ipairs(state.deathZones) do
      local bestY = nil
      for _, shape in ipairs(terrainLevel.shapes) do
        if not shape.isWallClimb then
          local hit = shape:findLandingCrossing(
            zone.respawnX, zone.respawnY - RESPAWN_SEARCH_UP, zone.respawnX, zone.respawnY + RESPAWN_SEARCH_DOWN)
          if hit and (not bestY or hit.point.y < bestY) then
            bestY = hit.point.y
          end
        end
      end
      if bestY then
        zone.respawnY = bestY - constants.PLAYER_RADIUS - 1
      end
    end

    -- "Gate" objects (see lua/world/Gate.lua): topY/bottomY/halfWidth
    -- are already fully resolved by TiledTerrain.lua's own tile-grid
    -- scan (see its gateSpawns). Inserted into BOTH terrainLevel.walls
    -- (so CollisionSystem:handlePlayerWallCollisions blocks the player
    -- with zero changes needed there) and state.gates (so main.lua's
    -- own update/draw loops below can animate and render it) — the
    -- exact same object serves both roles at once.
    state.gates = {}
    local gatesByTiledId = {}
    for _, spawn in ipairs(terrainLevel.gateSpawns or {}) do
      local gate = Gate.new(spawn.x, spawn.topY, spawn.bottomY, spawn.halfWidth)
      table.insert(terrainLevel.walls, gate)
      table.insert(state.gates, gate)
      if spawn.id then
        gatesByTiledId[spawn.id] = gate
      end
    end

    -- Wires each lever to the Gate its own "gate" custom property names
    -- (see leverSpawns' own gateId, set from that property in
    -- TiledTerrain.lua) — a lever with no gateId, or one naming a gate
    -- that didn't resolve, is just left unwired (Lever:tryInteract
    -- already no-ops with self.gate == nil).
    for _, lever in ipairs(state.levers) do
      if lever.gateId and gatesByTiledId[lever.gateId] then
        lever.gate = gatesByTiledId[lever.gateId]
      end
    end
  end

  -- Spawns at the shelter's own doorway, not dome center — the opening
  -- beat (see SpaceShelter.lua's own intro state machine) has the
  -- player standing behind its closed door when the game starts, the
  -- door sliding open around them, then closing again once they've
  -- stepped out. state.introLocked (checked in love.update) keeps
  -- movement input from interrupting that sequence.

  -- A sign on the belt-edge landing planet (the white one the home beam
  -- arrives on — see the beam pair above), planted on the far side from
  -- its beam: the beam stands on top, so the sign hangs off the
  -- underside, turned to stand on the surface there — not at the very
  -- bottom (the south pole) but SIGN_OFFSET_FROM_SOUTH_POLE round from
  -- it, toward the lower left (the side facing the belt). Negative
  -- would put it toward the lower right instead. Added here rather
  -- than up by the planet itself because state.signs is created by the
  -- Tiled level's own sign loop, which runs in between.
  if state.beltLandingPlanet then
    local planet = state.beltLandingPlanet
    local SIGN_OFFSET_FROM_SOUTH_POLE = math.rad(35)
    local signAngle = math.pi / 2 + SIGN_OFFSET_FROM_SOUTH_POLE -- pi/2 is straight down the screen
    local up = Vector2.new(math.cos(signAngle), math.sin(signAngle)) -- away from the planet's center, where the sign stands
    state.signs = state.signs or {}
    table.insert(state.signs, Sign.new(
      planet.pos.x + up.x * planet.radius, planet.pos.y + up.y * planet.radius,
      "With so many planets clustered together, consider pressing **TRIANGLE** to slow down time. In this state, you can move the right joystick cursor around to select planets you can pull beam toward using the **L2** button. If you want time to go back to normal, press **TRIANGLE** again",
      { texture = state.signPlanetTexture, up = up }))
  end

  local topY = dome:trueSurfaceY()
  local doorwayX = state.spaceShelter and (state.spaceShelter:getDoorwayPosition()) or dome.pos.x
  state.player = Player.new(doorwayX, topY - constants.PLAYER_RADIUS)
  state.player.onSurface = true
  state.player.currentPlanet = dome
  state.player.lastInfluencePlanet = dome
  state.player.angle = -math.pi / 2
  state.introLocked = true

  -- Where Player:respawn puts him back after dying — this same doorway.
  state.respawnPoint = { x = doorwayX, y = topY - constants.PLAYER_RADIUS, planet = dome }

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

  -- Everything above sets the game up exactly as it starts — the title
  -- screen then borrows the player and stands him out in the belt until
  -- start is pressed (see lua/ui/TitleScreen.lua).
  -- Fading in from black when this is a return from the pause menu, so
  -- the rebuild isn't a hard cut.
  TitleScreen.enter(not firstLoad)

  -- Pointed at the player from the very first frame. love.update keeps
  -- this current from here on, but a draw can come before the first
  -- update after a rebuild — and worldGen streams the world around the
  -- camera (see worldGen.streamFocus), which must not be last game's.
  state.visibleWidth = love.graphics.getWidth() / state.zoom
  state.visibleHeight = love.graphics.getHeight() / state.zoom
  state.camera = {
    x = state.player.pos.x - state.visibleWidth / 2,
    y = state.player.pos.y - state.visibleHeight / 2,
  }
end

-- Plain debris burst — port of js/utils.js's createParticles: `count`
-- of Particle.lua's default small yellow particles thrown out in every
-- direction.
local function spawnDebrisParticles(pos, count)
  for _ = 1, count do
    local angle = math.random() * math.pi * 2
    local speed = math.random() * 4 + 2
    table.insert(state.particles, Particle.new(pos, Vector2.new(math.cos(angle) * speed, math.sin(angle) * speed)))
  end
end

-- Port of js/game.js's breakAsteroid — what happens to an asteroid
-- that's hit a planetoid or been shot: it's gone in a bang and a burst
-- of debris, and unless it was already small (radius under 15) it
-- leaves 2 smaller asteroids behind (3 if it was a big one, radius over
-- 30), each half its radius, flung apart.
--
-- planet: the planetoid it hit, or nil if it was shot. One deliberate
-- difference from the JS, for a round planetoid only: the pieces are
-- thrown AWAY from its surface, off the planetoid's own velocity. The
-- original threw them in any direction off the asteroid's own inbound
-- velocity, which sent about half of them straight back into the
-- planetoid to break again the very next frame.
local function breakAsteroid(ast, planet)
  for i = #state.asteroids, 1, -1 do
    if state.asteroids[i] == ast then
      table.remove(state.asteroids, i)
      break
    end
  end

  if state.audioManager then
    local size = (ast.radius > 30 and "large") or (ast.radius > 20 and "medium") or "small"
    state.audioManager:playBang(size, ast.pos)
  end
  spawnDebrisParticles(ast.pos, 150)
  if ast.radius < 15 then return end

  local awayAngle, baseVel = nil, ast.vel
  if planet and planet.radius and not planet.isRoundedRect then
    awayAngle = math.atan2(ast.pos.y - planet.pos.y, ast.pos.x - planet.pos.x)
    baseVel = planet.vel or ast.vel
  end

  local pieceCount = ast.radius > 30 and 3 or 2
  for _ = 1, pieceCount do
    local piece = Asteroid.new(ast.pos.x, ast.pos.y, ast.radius / 2)
    local angle = awayAngle and (awayAngle + (math.random() - 0.5) * math.pi * 0.8) or (math.random() * math.pi * 2)
    local speed = 2 + math.random() * 3
    piece.vel = Vector2.new(baseVel.x + math.cos(angle) * speed, baseVel.y + math.sin(angle) * speed)
    piece.angle = math.random() * math.pi * 2
    piece.angularSpeed = (math.random() * 2 - 1) * 0.1
    -- A title-screen asteroid's pieces stay title-screen asteroids (see
    -- TitleScreen.lua's own updateTitleAsteroids): same idea, a drift
    -- relative to the belt's orbit, worked out from the velocity each
    -- piece was just given.
    if ast.titleDrift then
      piece.titleDrift = {
        x = piece.vel.x - (ast.vel.x - ast.titleDrift.x),
        y = piece.vel.y - (ast.vel.y - ast.titleDrift.y),
      }
    end
    table.insert(state.asteroids, piece)
  end
  spawnDebrisParticles(ast.pos, 10)
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
    if state.player.pullTarget and not (state.gamepadPullHeld or love.mouse.isDown(2)) then
      state.player:clearPullTarget()
    end
  end
  state.vatsWasActive = state.vatsActive

  TitleScreen.update(dt)
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

  -- Duck-typed, same pattern state.spikeys' own update loop already
  -- uses: only SphereMove (so far) actually has an :update() of its
  -- own, driving self.pos directly along its fixed patrol path — every
  -- other planetoid type is left untouched here, same as always.
  for _, p in ipairs(state.planetoids) do
    if p.update then p:update() end
  end

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
  Spikey.updateSharedClock()

  -- Duck-typed: a plain Spikey has no :update() at all (it never
  -- moves), only SpikeyVertical does — this one loop covers both kinds
  -- without state.spikeys needing to be split into separate lists.
  if state.spikeys then
    for _, sp in ipairs(state.spikeys) do
      if sp.update then sp:update() end
    end
  end

  if state.levers then
    for _, lever in ipairs(state.levers) do
      lever:update()
    end
  end

  if state.cranks then
    for _, crank in ipairs(state.cranks) do
      crank:update()
    end
  end

  if state.signs then
    for _, sign in ipairs(state.signs) do
      sign:update()
    end
  end

  if state.mirrors then
    for _, mirror in ipairs(state.mirrors) do
      mirror:update()
    end
  end

  if state.beams then
    for _, beam in ipairs(state.beams) do
      beam:update()
    end
  end

  if state.gates then
    for _, gate in ipairs(state.gates) do
      gate:update(state.timeScale or 1)
    end
  end

  if state.fish then
    for _, fish in ipairs(state.fish) do
      fish:update()
    end
  end

  -- Held at the very start of its opening sequence for as long as the
  -- title screen is up (see TitleScreen.lua) — the door only starts
  -- opening once the game has actually begun.
  if state.spaceShelter and not state.titleScreen then
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

  if state.signs then
    for _, sign in ipairs(state.signs) do
      if sign.dialogueActive then
        state.dialogueActive = true
        break
      end
    end
  end

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
  if state.titleScreen then
    state.player:move(TitleScreen.getKeys())
  else
    -- (No walking in V.A.T.S. either — see the V.A.T.S. rules near the
    -- top of this function.)
    state.player:move((state.introLocked or state.player.inPinball or state.vatsActive) and {} or state.keys)
  end

  -- PinballInterior:updateBall entirely REPLACES normal gravity and
  -- planet collision while he's inside it (see Player.lua's own
  -- inPinball comment) — state.player:update() still runs normally
  -- either way, since it's what actually advances teleport/ball-morph/
  -- invincibility, none of which should pause just because he's now
  -- inside the table.
  if state.player.inPinball then
    state.player.inPinball:updateBall(state.player, state.timeScale)
  elseif state.player.pullTarget then
    state.player:applyPullForce()
  else
    state.gravitySystem:applyTo(state.player)
  end

  state.player:update()

  if not state.player.inPinball then
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
  if state.gamepadFireHeld and state.player then
    state.player:shootFireball()
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
    end
  end

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

    -- An asteroid that hits a planetoid breaks apart — see breakAsteroid.
    local toBreak = collisionSystem:handlePlanetAsteroidCollisions(collidablePlanetoids, state.asteroids)
    for asteroid, planet in pairs(toBreak) do
      breakAsteroid(asteroid, planet)
    end
  end

  -- Runs on the title screen too — Bob collects whatever coins his
  -- autopilot carries him through, sound and all. Anything that adds to
  -- state.score there is wiped when the game actually starts (see
  -- TitleScreen.lua's own beginGame).
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

    if #state.fireballs > 0 then
      -- Mirrors get first look: a reflected fireball just had its
      -- velocity/position adjusted, not destroyed, so it's excluded
      -- below from every destructive check this same frame (its new
      -- position is only a few pixels off the mirror's own face, not
      -- far enough to trust a fresh destructive check against
      -- whatever's sitting right next to it).
      local reflected = state.mirrors and collisionSystem:handleFireballMirrorCollisions(state.fireballs, state.mirrors) or {}

      if state.asteroids then
        local hitFireballs, toBreakAsteroids, planetHits = collisionSystem:handleFireballCollisions(
          state.fireballs, collidablePlanetoids, state.asteroids
        )
        -- A shot asteroid breaks apart the same way one that hits a
        -- planetoid does (see breakAsteroid), plus the fireball's own
        -- explosion.
        for a in pairs(toBreakAsteroids) do
          table.insert(state.explosions, Explosion.new(a.pos.x, a.pos.y))
          if state.audioManager then state.audioManager:playFireball() end
          breakAsteroid(a, nil)
        end
        for _, hit in ipairs(planetHits) do
          if not reflected[hit.fireball] then
            table.insert(state.explosions, Explosion.new(hit.fireball.pos.x, hit.fireball.pos.y))
            if state.audioManager then state.audioManager:playFireball() end
          end
        end
        for i = #state.fireballs, 1, -1 do
          if hitFireballs[state.fireballs[i]] and not reflected[state.fireballs[i]] then
            table.remove(state.fireballs, i)
          end
        end
      end

      -- WALL tiles (not Gate — see handleFireballWallCollisions' own
      -- comment): a fireball explodes against one exactly like it does
      -- against a planet or asteroid, instead of silently flying
      -- straight through.
      if state.tiledLevels and #state.fireballs > 0 then
        local hitWallFireballs = {}
        for _, level in ipairs(state.tiledLevels) do
          local hits = collisionSystem:handleFireballWallCollisions(state.fireballs, level.walls)
          for f in pairs(hits) do hitWallFireballs[f] = true end
        end
        for i = #state.fireballs, 1, -1 do
          local f = state.fireballs[i]
          if hitWallFireballs[f] and not reflected[f] then
            table.insert(state.explosions, Explosion.new(f.pos.x, f.pos.y))
            if state.audioManager then state.audioManager:playFireball() end
            table.remove(state.fireballs, i)
          end
        end
      end

      -- Lever: a fireball hitting one engages it (see Lever:engage,
      -- shared with the player's own direct pull) and detonates the
      -- fireball, same "something solid stopped it" treatment as a
      -- wall tile.
      if state.levers and #state.fireballs > 0 then
        local hitLeverFireballs = collisionSystem:handleFireballLeverCollisions(state.fireballs, state.levers)
        for i = #state.fireballs, 1, -1 do
          local f = state.fireballs[i]
          if hitLeverFireballs[f] and not reflected[f] then
            table.insert(state.explosions, Explosion.new(f.pos.x, f.pos.y))
            if state.audioManager then state.audioManager:playFireball() end
            table.remove(state.fireballs, i)
          end
        end
      end

      -- Ooomba: a fireball kills one outright — it's gone in an
      -- explosion (Explosion.lua's own ring/flash/particle burst), and
      -- the fireball is spent.
      if state.ooombas and #state.ooombas > 0 and #state.fireballs > 0 then
        local hitOoombaFireballs, killedOoombas = collisionSystem:handleFireballOoombaCollisions(state.fireballs, state.ooombas)
        for i = #state.ooombas, 1, -1 do
          local o = state.ooombas[i]
          if killedOoombas[o] then
            table.insert(state.explosions, Explosion.new(o.pos.x, o.pos.y))
            if state.audioManager then state.audioManager:playFireball() end
            table.remove(state.ooombas, i)
          end
        end
        for i = #state.fireballs, 1, -1 do
          if hitOoombaFireballs[state.fireballs[i]] then
            table.remove(state.fireballs, i)
          end
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

  -- Manual zoom input is ignored while CameraDirector.lua is actively
  -- directing (a scripted sequence — see RobotButler.lua's own intro
  -- script) — fighting a scripted camera move with +/- would just look
  -- broken, and it releases control back on its own once the sequence
  -- ends anyway.
  if not CameraDirector.isActive() then
    if state.keys['+'] or state.keys['='] then
      state.zoom = math.min(ZOOM_MAX, state.zoom + ZOOM_STEP_PER_FRAME)
      state.zoomTarget = nil
    end
    if state.keys['-'] or state.keys['_'] then
      state.zoom = math.max(ZOOM_MIN, state.zoom - ZOOM_STEP_PER_FRAME)
      state.zoomTarget = nil
    end
  end

  -- Zoom-Window pass: walking into one of state.zoomWindows eases the
  -- camera to that window's own zoom; walking back out eases it back to
  -- whatever zoom the player had on the way in. Only the enter/exit
  -- EDGES set state.zoomTarget, so any manual zoom input (which clears
  -- it — see just above, and InputHandlers.lua's own wheel handler)
  -- simply wins until the player next crosses a window boundary.
  local insideWindow = nil
  local px, py = state.player.pos.x, state.player.pos.y
  for _, w in ipairs(state.zoomWindows or {}) do
    if px >= w.x and px <= w.x + w.width and py >= w.y and py <= w.y + w.height then
      insideWindow = w
      break
    end
  end
  if insideWindow ~= state.activeZoomWindow then
    local previous = state.activeZoomWindow
    if insideWindow then
      -- Stepping straight from one window into another keeps the
      -- ORIGINAL pre-window zoom as the one to return to.
      if not previous then
        state.zoomWindowReturn = state.zoomTarget or state.zoom
      end
      state.zoomTarget = insideWindow.zoom
    elseif state.zoomWindowReturn then
      -- Skipped if the player re-zoomed by hand while inside — their
      -- own choice shouldn't be undone just for walking out.
      if state.zoomTarget == previous.zoom or math.abs(state.zoom - previous.zoom) < ZOOM_WINDOW_SNAP then
        state.zoomTarget = state.zoomWindowReturn
      end
      state.zoomWindowReturn = nil
    end
    state.activeZoomWindow = insideWindow
  end

  -- Safety net: CameraDirector may zoom out past the player's own
  -- ZOOM_MIN during a script (see its SCRIPT_ZOOM_MIN) and normally
  -- hands back at a regular zoom — but if it ever lets go while still
  -- further out than the player is allowed, ease back in to the limit
  -- rather than leaving him stuck there.
  if not CameraDirector.isActive() and not state.zoomTarget and state.zoom < ZOOM_MIN then
    state.zoomTarget = ZOOM_MIN
  end

  if state.zoomTarget and not CameraDirector.isActive() then
    local target = math.min(ZOOM_MAX, math.max(ZOOM_MIN, state.zoomTarget))
    state.zoom = state.zoom + (target - state.zoom) * ZOOM_WINDOW_EASE_PER_FRAME
    if math.abs(target - state.zoom) < ZOOM_WINDOW_SNAP then
      state.zoom = target
      state.zoomTarget = nil
    end
  end

  -- CameraDirector.update already sets state.camera/state.zoom itself
  -- (and returns true) while a scripted sequence is driving — the
  -- ordinary player-centered computation below only runs when it isn't,
  -- so the handoff between the two is a single smooth eased transition
  -- (CameraDirector.release), never a one-frame pop between two
  -- independently-computed camera positions.
  if not CameraDirector.update(state.timeScale) then
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
  end

  -- Kept up to date regardless of which of the two paths above actually
  -- drove state.camera/state.zoom this frame — other systems (VatsOverlay.lua,
  -- etc.) read these directly and need them correct either way.
  state.visibleWidth = love.graphics.getWidth() / state.zoom
  state.visibleHeight = love.graphics.getHeight() / state.zoom
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
      -- Duck-typed: only PinballPlanet has one right now (see
      -- lua/interiors/PinballInterior.lua and this planet's own setup
      -- comment), but any future planetoid with its own .interior
      -- overlay rides this same draw pass for free.
      if p.interior then
        p.interior:draw()
      end
    end
  end

  -- Spikey (lua/world/Spikey.lua) isn't in state.planetoids anymore (see
  -- its own header comment on why — it's deliberately not a planet),
  -- so it needs its own explicit draw pass instead of riding the loop
  -- just above.
  if state.spikeys then
    for _, sp in ipairs(state.spikeys) do
      if utils.isOnScreen(sp.pos.x, sp.pos.y, sp.radius, 50) then
        sp:draw()
      end
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

  -- Gate/Lever (see lua/world/Gate.lua, lua/world/Lever.lua) — drawn
  -- every frame regardless of state.showCollisionDebug above, since
  -- that debug view only shows the gate's current COLLISION rectangle
  -- (via level.walls, since a Gate is inserted directly into that same
  -- array), not its actual bar/cross-bar art.
  if state.gates then
    for _, gate in ipairs(state.gates) do
      if utils.isOnScreen(gate.pos.x, gate.pos.y, math.max(gate.halfWidth, gate.halfHeight), 20) then
        gate:draw()
      end
    end
  end

  if state.levers then
    for _, lever in ipairs(state.levers) do
      if utils.isOnScreen(lever.pos.x, lever.pos.y, 80, 20) then
        lever:draw()
        lever:drawTooltip()
      end
    end
  end

  if state.cranks then
    for _, crank in ipairs(state.cranks) do
      if utils.isOnScreen(crank.pos.x, crank.pos.y, 80, 20) then
        crank:draw()
        crank:drawTooltip()
      end
    end
  end

  if state.signs then
    for _, sign in ipairs(state.signs) do
      if utils.isOnScreen(sign.pos.x, sign.pos.y, 80, 20) then
        sign:draw()
        sign:drawTooltip()
      end
    end
  end

  if state.mirrors then
    for _, mirror in ipairs(state.mirrors) do
      if utils.isOnScreen(mirror.pos.x, mirror.pos.y, 80, 20) then
        mirror:draw()
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
    -- f.drawBoundRadius (not just halfWidth/halfHeight) — his fishing
    -- line reaches far below his own compact body, and this needs to
    -- cover that full reach or the whole rig (hook included) vanishes
    -- the instant the camera's near the water the line dangles into but
    -- far from his own actual position. See Fisherman.lua's own comment.
    if utils.isOnScreen(f.pos.x, f.pos.y, f.drawBoundRadius, 20) then
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

  -- Drawn BEFORE the player (just below), so he renders IN FRONT of the
  -- beam rather than behind it while standing at one (interacting, or
  -- mid-teleport) — his own silhouette glow (Player:drawBeamGlow, called
  -- from Player:draw itself) is what actually signals "near a beam" now,
  -- so he no longer needs to duck behind it for that to read clearly.
  if state.beams then
    for _, beam in ipairs(state.beams) do
      if utils.isOnScreen(beam.pos.x, beam.pos.y, Beam.LENGTH, 60) then
        beam:draw()
        beam:drawTooltip()
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

  if state.signs then
    for _, sign in ipairs(state.signs) do
      sign:drawDialogue()
    end
  end

  -- Title screen: just the scene and its own prompt — no minimap, no
  -- HUD text.
  if state.titleScreen then
    TitleScreen.draw()
    return
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

  PauseMenu.draw()

  -- The black fade-in out of the title screen, over everything.
  TitleScreen.draw()
end
