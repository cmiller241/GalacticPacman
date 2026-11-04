// js/main.js
//
// The game's entry point (a port of main.lua), run in the browser through
// the LÖVE-API shim in js/love/. Bundled by esbuild into dist/bundle.js
// (npm run build), which index.html loads.
//
// love.load builds the world; love.update and love.draw run each frame as
// a list of named steps, in order. Debug overlays are in js/debug/DebugDraw.js,
// the HUD text in js/ui/Hud.js, and the start positions and teleport list
// in js/setup/StartPositions.js.

import love from './love/index.js';
import assetList from './assetList.js';
import state from './state.js';
import constants from './constants.js';
import Planetoid from './world/Planetoid.js';
import StompBurst from './effects/StompBurst.js';
import TitleScreen from './ui/TitleScreen.js';
import PauseMenu from './ui/PauseMenu.js';
import GravitySystem from './systems/GravitySystem.js';
import CollisionSystem from './systems/CollisionSystem.js';
import Starfield from './world/Starfield.js';
import Sun from './world/Sun.js';
import PullBeam from './effects/PullBeam.js';
import assetLoading from './setup/assetLoading.js';
import inputHandlers from './setup/InputHandlers.js';
import gamepadInput from './setup/GamePadInput.js';
import worldGen from './setup/WorldGen.js';
import StartPositions from './setup/StartPositions.js';
import World from './levels/World.js';
import WorldObjects from './systems/WorldObjects.js';
import Projectiles from './systems/Projectiles.js';
import Breakage from './systems/Breakage.js';
import Camera from './systems/Camera.js';
import MiniMap from './ui/MiniMap.js';
import BeltOrbit from './systems/BeltOrbitSystem.js';
import utils from './utils.js';
import LockOutline from './effects/LockOutline.js';
import VatsOverlay from './effects/VatsOverlay.js';
import VatsCursor from './effects/VatsCursor.js';
import PortalGun from './systems/PortalGun.js';
import WaterSystem from './systems/WaterSystem.js';
import Recall from './systems/Recall.js';
import CharacterShadows from './effects/CharacterShadows.js';
import TileGlow from './effects/TileGlow.js';
import FireBarGlow from './effects/FireBarGlow.js';
import Cannon from './world/Cannon.js';
import MissileOutpost from './world/MissileOutpost.js';
import CameraShake from './effects/CameraShake.js';
import GrassBlades from './effects/GrassBlades.js';
import WeaponModes from './systems/WeaponModes.js';
import WeaponBar from './ui/WeaponBar.js';
import TouchControls from './ui/TouchControls.js';
import DebugDraw from './debug/DebugDraw.js';
import Hud from './ui/Hud.js';

// =====================================================================
// START POSITION (for testing)
// =====================================================================
// Where Bob starts the game, and where every respawn puts him back.
// Set START_AT to one of:
//
//   'shelter'     normal game start: behind the Space Shelter's door,
//                 with its door-opening intro
//   'mining'      on top of the mining planet (and its prisms)
//   'fisherman'   just above the fisherman's rounded-rectangle planet
//   'cracked'     just above the cracked planet, dropping onto it
//   'tiled'       just above the Tiled planet over map column
//                 TILED_START_COLUMN (needs World.SHOW.tiledPlanet)
//   'tunnel'      on the sky dome's ground just left of Level1's ball
//                 tunnel (curl into a ball to roll through it)
//   'pinball'     on the pinball table's plunger, already a ball
//   'expressway'  on the expressway's entry planet, beside its cannon
//                 (needs World.SHOW.expressway)
//
// If the planet you pick is switched off, he starts at the shelter and
// the console says why. T in game opens a list of the same places.
// (Same switch as main.lua's.)
const START_AT = 'shelter';
const TILED_START_COLUMN = 5; // counting from 0, like Tiled

let collisionSystem;

// Reused every frame rather than built fresh each time: the planetoids
// the collision passes check (see runWorldCollisions), which of them are
// immovable, and the camera nudged by screen shake.
const collidablePlanetoids = [], immovablePlanetoids = [];
const shakenCamera = { x: 0, y: 0 };
// An empty list for `state.cannons ?? NONE` and the like, when a world
// list doesn't exist — instead of a new empty array every frame.
const NONE = Object.freeze([]);

// Upward speed (world units per baseline frame) the player hops off a
// freshly flattened Ooomba with — a small rebound, well under a jump.
const OOOMBA_STOMP_BOUNCE = 7;
// V.A.T.S. slow motion: the time scale it eases to, how fast (per
// baseline frame), and how close counts as there.
const VATS_TIME_SCALE = 0.05;
const VATS_EASE_RATE = 0.12;
const VATS_EASE_SNAP_THRESHOLD = 0.005;
// Frame time is measured in 60fps frames, clamped to a 20fps floor so a
// stall can't fling anything through geometry.
const FPS_BASELINE = 60;
const MAX_FRAME_DT = 0.05;

// =====================================================================
// LOAD
// =====================================================================
// love.load runs once at startup, and again in full every time the pause
// menu's EXIT TO TITLE is chosen (a fresh world each time).
let hasLoadedOnce = false;

// Empties everything a previous run of love.load left in `state`.
function resetWorldState() {
  state.planetoids = []; state.enemies = [];
  // Every object list the registry knows (levers, coins, fish, ...).
  WorldObjects.reset();

  state.tiledLevels = null; state.recallables = null;
  state.zoomWindows = null; state.deathZones = null;
  state.pinballPlanet = null; state.waterPlanet = null; state.waterCore = null; state.roundedRectPlanet = null;
  state.crackedPlanet = null; state.tiledPlanet = null;
  state.beltLandingPlanet = null;
  state.miningPlanet = null;
  state.cannons = null; state.clearLanes = null;
  state.expressway = null; state.expresswayExits = null;
  state.outposts = null; state.missiles = null;
  state.portals = null; state.portalTracers = null;
  WeaponModes.set('fireball');
  WaterSystem.reset();
  Recall.reset();

  Camera.reset();
  state.cameraDirector = null;
  state.dialogueActive = false;
  state.paused = false;
  state.keys = {};
  state.mouseDown = false;
  state.vatsWasActive = false;
  state.gamepadPullHeld = false;
}

love.load = function () {
  const firstLoad = !hasLoadedOnce;
  hasLoadedOnce = true;

  if (firstLoad) {
    love.window.setTitle('Asteroid Bob');
    love.window.maximize();
  }

  // Pixel-art default (crisp tiles, no seams between atlas tiles).
  love.graphics.setDefaultFilter('nearest', 'nearest');

  resetWorldState();
  worldGen.initWorldSize();

  state.timeScale = 1;
  state.timeScaleTarget = 1;
  state.vatsMultiplier = 1;
  state.showCollisionDebug = false;
  state.showBeltCellDebug = false;
  state.showInfluenceRings = false;
  state.scriptsCompleted = {};
  state.vatsActive = false;
  state.vatsAutoEnterOnLock = false;
  state.vatsTimeScale = VATS_TIME_SCALE;
  state.score = 0;
  state.elements = { rubinium: 0, asteroidium: 0 };
  state.level = 1;
  state.cellCheckTimer = 0;
  state.beltSpawnTimer = 0;
  state.minimap = MiniMap.new();

  if (firstLoad) {
    assetLoading.loadAssets();
    inputHandlers.attachInputHandlers();
    // EXIT TO TITLE: run this whole function again.
    PauseMenu.onExitToTitle = () => love.load();
    PauseMenu.onTeleportKey = StartPositions.openTeleportList;
  }

  collisionSystem = CollisionSystem.new();
  state.starfield = Starfield.new();

  // Every hand-placed landmark, the dome's Tiled interior and the
  // player (see js/levels/World.js).
  const world = World.build();

  // The testing start spot (START_AT, top of this file), now that every
  // planet it could pick exists.
  StartPositions.init({
    shelterRespawnPoint: state.respawnPoint,
    expresswayEntry: world.expresswayEntry,
    tiledStartColumn: TILED_START_COLUMN,
  });
  StartPositions.apply(START_AT);

  // Stream the 3x3 around the house (after the dome exists, so cells
  // steer clear of it).
  worldGen.generateStartingNeighborhood(World.HOME_CELL_COL, World.HOME_CELL_ROW);

  state.sun = Sun.new(state.sceneWidth / 2, state.sceneHeight / 2, 1920);

  state.gravitySystem = GravitySystem.new(state.planetoids);

  // The title screen borrows the player until start is pressed.
  TitleScreen.enter(!firstLoad);

  // Pointed at the player from the very first frame (love.update keeps it
  // current from here on).
  Camera.pointAtPlayer();
};

// =====================================================================
// UPDATE
// =====================================================================

// Removes every element of `list` (back to front) that `test` picks.
function removeWhere(list, test) {
  for (let i = list.length - 1; i >= 0; i--) if (test(list[i])) list.splice(i, 1);
}

// Is he anywhere in the Sky Dome level? Standing on (or last pulled by)
// the dome's deck or any of its Tiled level's tiles (each tile is its own
// "planet" — see shape.inSkyDome where the level is loaded), or simply
// somewhere inside the dome's glass, e.g. mid-jump or shot from a plunger.
function isInSkyDome(player) {
  const dome = state.skyDomePlanet;
  if (!dome) return false;
  const planet = player.currentPlanet ?? player.lastInfluencePlanet;
  if (planet && (planet === dome || planet.inSkyDome)) return true;
  return dome.containsPoint(player.pos.x, player.pos.y);
}

// Is he in one of the asteroid belt's cells (the same cells the belt-cell
// debug overlay highlights — see worldGen.cellIntersectsBelt)?
function isInBeltCell(player) {
  const col = Math.floor(player.pos.x / worldGen.CELL_SIZE);
  const row = Math.floor(player.pos.y / worldGen.CELL_SIZE);
  return worldGen.cellIntersectsBelt(col, row);
}

// Which background music should be playing right now (a track name from
// js/AudioManager.js's MUSIC, or null for none). None on the title screen.
// The Sky Dome wins where it overlaps belt cells.
function musicForPlayer() {
  if (state.titleScreen || !state.player) return null;
  if (isInSkyDome(state.player)) return 'skyDome';
  if (isInBeltCell(state.player)) return 'belt';
  return null;
}

// V.A.T.S. (Triangle — see GamePadInput.js): while it's active he only
// picks a pull target; walking, jumping and firing are refused. A pull
// already under way carries on even with L2 released, which lets him chain
// pulls without landing.
//
// The moment it ends: whatever was locked is unlocked, and a pull that
// nobody is holding L2 (or the right mouse button) for is dropped.
function handleVatsEnd() {
  if (state.vatsWasActive && !state.vatsActive && state.player) {
    state.player.clearLockTarget();
    if (state.player.pullTarget && !(state.gamepadPullHeld || love.mouse.isDown(1))) {
      state.player.clearPullTarget();
    }
  }
  state.vatsWasActive = state.vatsActive;
}

// Sets state.timeScale, which everything that moves multiplies its
// per-frame movement by: this frame's length in 60fps frames, times the
// V.A.T.S. slow-motion ease, times a cannon shot's hit-stop.
function updateTimeScale(dt) {
  const frameNorm = Math.min(dt, MAX_FRAME_DT) * FPS_BASELINE;

  state.timeScaleTarget = state.vatsActive ? VATS_TIME_SCALE : 1;
  const timeScaleDiff = state.timeScaleTarget - state.vatsMultiplier;
  if (Math.abs(timeScaleDiff) < VATS_EASE_SNAP_THRESHOLD) {
    state.vatsMultiplier = state.timeScaleTarget;
  } else {
    state.vatsMultiplier += timeScaleDiff * Math.min(VATS_EASE_RATE * frameNorm, 1);
  }

  state.timeScale = state.vatsMultiplier * frameNorm * Cannon.timeFactor();
}

// Drifting planetoids move and bounce off the edges of the world.
function updatePlanetoidsPhysics() {
  for (const p of state.planetoids) {
    if (p.recalling) {
      // (Rewinding: Recall.update moves it.)
    } else if (p.isImmovable) {
      p.vel.x = 0; p.vel.y = 0;
    } else {
      p.pos.addScaled(p.vel, state.timeScale);
      if (p.pos.x - p.radius < 0) { p.pos.x = p.radius; p.vel.x = -p.vel.x; }
      if (p.pos.x + p.radius > state.sceneWidth) { p.pos.x = state.sceneWidth - p.radius; p.vel.x = -p.vel.x; }
      if (p.pos.y - p.radius < 0) { p.pos.y = p.radius; p.vel.y = -p.vel.y; }
      if (p.pos.y + p.radius > state.sceneHeight) { p.pos.y = state.sceneHeight - p.radius; p.vel.y = -p.vel.y; }
    }
  }
}

// Planetoids, and everything in the world's object lists. All of this runs
// before the player moves, so he's carried along by whatever he's standing on.
function updateWorld(dt) {
  updatePlanetoidsPhysics();

  // Planetoids that turn on the spot (see CrystalPlanet.js).
  for (const p of state.planetoids) {
    if (p.updateRotation && !p.recalling) p.updateRotation(state.timeScale);
  }

  // START_AT = 'mining': keeps the respawn point on top of the drifting planet.
  if (state.respawnPoint && state.respawnPoint.followsPlanet) {
    const point = state.respawnPoint, planet = state.respawnPoint.planet;
    point.x = planet.pos.x; point.y = planet.pos.y - planet.radius - constants.PLAYER_RADIUS;
  }

  // Planetoids with their own movement (SphereMove's patrol path, so far).
  for (const p of state.planetoids) {
    if (p.update && !p.recalling) p.update();
  }

  Recall.update(dt);

  // Rope rocks, asteroids, coins, Ooombas, fire bars, levers, fish, NPCs,
  // ... (order and details: js/systems/WorldObjects.js).
  WorldObjects.update('world', dt);

  // Player.js reads this to freeze him while any conversation is showing.
  state.dialogueActive = WorldObjects.anyDialogueActive();
}

// Walking input. On the title screen its autopilot steers him. No steering
// during the opening cutscene, inside the pinball table, in V.A.T.S., or in
// or shot from a cannon.
function movePlayer(player) {
  if (state.titleScreen) {
    player.move(TitleScreen.getKeys());
    return;
  }
  const noSteering = state.introLocked || player.inPinball || state.vatsActive
    || player.inCannon || player.cannonFlight;
  // Standing, he can't walk or run into a gap lower than he is tall — a
  // ball tunnel (see TiledTerrain.js's Level.headroomAt) — unless he's
  // already somewhere that low.
  const level = state.tiledLevels ? state.tiledLevels[0] : null;
  const px = player.pos.x, py = player.pos.y, parc = player.surfaceArcPos;
  const hadRoom = level && player.onSurface && !player.isBall && level.headroomAt(px, py, player.radius);
  player.move(noSteering ? {} : state.keys);
  if (hadRoom && player.onSurface && !player.isBall && !level.headroomAt(player.pos.x, player.pos.y, player.radius)) {
    player.pos.x = px; player.pos.y = py; player.surfaceArcPos = parc;
    player.isWalking = false;
    player.groundMoveSpeedX = 0;
  }
}

// Ooombas are lethal to touch unless landed on from above. Each one
// squashed flat this frame is removed, with a burst on the ground under his
// feet (or where it stood) and a small hop for him, along the Ooomba's own
// up. Skipped on the title screen: he can't die before the game starts.
function handleOoombaStomps(player) {
  if (!(state.ooombas && state.ooombas.length > 0) || state.titleScreen) return;
  const flattened = collisionSystem.handlePlayerOoombaCollisions(player, state.ooombas);
  for (const o of flattened) {
    const up = o.up;
    const groundX = o.pos.x - up.x * o.halfHeight, groundY = o.pos.y - up.y * o.halfHeight;
    if (o.squashPressed) {
      // The point on the ground directly beneath him.
      const sideways = (player.pos.x - o.pos.x) * -up.y + (player.pos.y - o.pos.y) * up.x;
      StompBurst.spawn(groundX + -up.y * sideways, groundY + up.x * sideways, up);
      if (!player.onSurface) {
        const [groundVelX, groundVelY] = o.groundVelocity();
        const rising = (player.vel.x - groundVelX) * up.x + (player.vel.y - groundVelY) * up.y;
        player.vel.x += up.x * (OOOMBA_STOMP_BOUNCE - rising);
        player.vel.y += up.y * (OOOMBA_STOMP_BOUNCE - rising);
        player.isGroundPounding = false;
      }
    } else {
      StompBurst.spawn(groundX, groundY, up);
    }
    if (state.audioManager) state.audioManager.playGoombaStomp();
    removeWhere(state.ooombas, (x) => x === o);
  }
}

// The player for one frame: moving, gravity (or whatever replaces it),
// cannons, portals, firing, and his collisions with the world. `fire` is
// true when he should shoot this frame.
function updatePlayer(player, fire) {
  // Going through a portal: he follows its path instead of everything below.
  if (player.portalTransit) {
    PortalGun.updateTransit(player, state.timeScale);
    return;
  }

  movePlayer(player);

  // Inside the pinball table its own ball physics replace gravity and
  // planet collision. No gravity in a cannon or on a cannon shot either.
  if (player.inPinball) {
    const jumpHeld = !!(state.keys[' '] || state.gamepadJumpHeld);
    player.inPinball.updateBall(player, state.timeScale, jumpHeld);
  } else if (player.pullTarget) {
    player.applyPullForce();
  } else if (!(player.inCannon || player.cannonFlight)) {
    state.gravitySystem.applyTo(player);
  }

  player.update();

  // Cannons swallowing, aiming and firing him, his flight once fired, and
  // then the coins down their routes (see js/world/Cannon.js).
  for (const cannon of (state.cannons ?? NONE)) cannon.update(player, state.timeScale);
  Cannon.updateFlight(player, state.timeScale);
  for (const cannon of (state.cannons ?? NONE)) cannon.updateCoins(player, state.timeScale / 60);

  // Before collision, so landing on a floor portal doesn't stop his fall first.
  PortalGun.tryEnter(player);

  if (!player.inPinball && !player.inCannon) collisionSystem.handlePlayerPlanetCollisions(player);

  // shootFireball / shootIceBolt throttle the fire rate themselves.
  if (fire) {
    if (state.iceMode) player.shootIceBolt(); else player.shootFireball();
  }

  // Wall and Spikey collisions only ever set these, so they're cleared
  // first to mean "touching this frame" (Player.jump's wall jump reads them).
  player.touchingWall = null;
  player.wallContactNormal = null;

  for (const level of (state.tiledLevels ?? NONE)) {
    collisionSystem.handlePlayerWallCollisions(player, level.walls);
    // Ball-tunnel pieces, and (standing, in the air) his head.
    level.pushPlayer(player);
  }
  // Plungers: solid to him, loaded by pushing into them, fire him when he
  // lets go (see js/world/Plunger.js).
  for (const plunger of state.plungers ?? NONE) plunger.update(player, state.timeScale);

  collisionSystem.handlePlayerSpikeyCollisions(player, state.spikeys);
  handleOoombaStomps(player);
  collisionSystem.handlePlayerSkyDomeContainment(player, state.skyDomePlanet);
}

// Collisions between everything that isn't the player, plus coin pickups.
function runWorldCollisions() {
  // Off-screen belt planetoids are left out of every planetoid collision
  // pass: there can be hundreds, and bumping off screen has no payoff.
  collidablePlanetoids.length = 0;
  for (const p of state.planetoids) {
    if (!p.isBeltPlanetoid || utils.isOnScreen(p.pos.x, p.pos.y, p.radius, 50)) collidablePlanetoids.push(p);
  }

  // Movable planetoids bounce off each other, and off the immovable ones'
  // true surfaces.
  collisionSystem.handleElasticCollisions(collidablePlanetoids);
  immovablePlanetoids.length = 0;
  for (const p of collidablePlanetoids) if (p.isImmovable) immovablePlanetoids.push(p);
  if (immovablePlanetoids.length > 0) collisionSystem.handleImmovableCollisions(immovablePlanetoids, collidablePlanetoids);

  // Fire bars are a hazard to him (not on the title screen) and solid to asteroids.
  if (state.fireBars && state.fireBars.length > 0) {
    if (!state.titleScreen) collisionSystem.handlePlayerFireBarCollisions(state.player, state.fireBars);
    if (state.asteroids && state.asteroids.length > 0) {
      collisionSystem.handleImmovableCollisions(state.fireBars, state.asteroids);
    }
  }

  // Asteroids bounce off each other, and break apart on hitting a planetoid.
  if (state.asteroids && state.asteroids.length > 0) {
    collisionSystem.handleElasticCollisions(state.asteroids);
    const toBreak = collisionSystem.handlePlanetAsteroidCollisions(collidablePlanetoids, state.asteroids);
    for (const [asteroid, planet] of toBreak) Breakage.breakAsteroid(asteroid, planet);
  }

  if (state.coins) collisionSystem.handleCoinCollisions(state.player, state.coins);
}

// Portals, water, projectiles, effects, the belt's orbit and the sun.
function updateSystems(dt) {
  PortalGun.update(dt);
  WaterSystem.update(dt);
  // The water blaster's hiss while he sprays (see js/AudioManager.js).
  if (state.audioManager) {
    state.audioManager.updateSpray(WaterSystem.isSpraying(),
      WaterSystem.totalWater() >= WaterSystem.waterCap(), dt);
  }

  // Fireballs and ice bolts: moving, through portals, and everything they
  // can hit (see js/systems/Projectiles.js).
  Projectiles.update(collisionSystem, collidablePlanetoids);

  // Explosions, wall-jump contact rings and debris particles.
  WorldObjects.update('effects', dt);

  BeltOrbit.apply(state.planetoids);

  if (state.sun) state.sun.update();
}

// World streaming and the belt's drip, every so many seconds of real time
// (so neither runs more often at a higher frame rate).
function updateStreaming(dt) {
  state.cellCheckTimer = (state.cellCheckTimer ?? 0) + dt;
  if (state.cellCheckTimer >= worldGen.CELL_CHECK_SECONDS) {
    state.cellCheckTimer = 0;
    worldGen.updateActiveCells();
  }

  state.beltSpawnTimer = (state.beltSpawnTimer ?? 0) + dt;
  if (state.beltSpawnTimer >= worldGen.BELT_SPAWN_SECONDS) {
    state.beltSpawnTimer = 0;
    worldGen.updateBeltSpawning();
  }
}

love.update = function (dt) {
  if (dt > 0) state.fps = (state.fps ?? 0) * 0.9 + (1 / dt) * 0.1;

  // Polled even while paused: it's what drives the pause menu.
  gamepadInput.pollGamepad(dt);
  if (PauseMenu.isOpen()) return;

  handleVatsEnd();
  TitleScreen.update(dt);
  VatsCursor.update(dt);

  // Background music fades to suit where he is (see js/AudioManager.js).
  if (state.audioManager) state.audioManager.updateMusic(musicForPlayer(), dt);

  updateTimeScale(dt);
  updateWorld(dt);

  // A left click since last frame (see InputHandlers.js) fires once he's
  // moved, and is dropped if he can't fire this frame. R2 fires for as
  // long as it's held.
  const mouseFire = state.mouseFirePending;
  state.mouseFirePending = false;
  updatePlayer(state.player, !!(state.gamepadFireHeld || mouseFire));

  runWorldCollisions();
  updateSystems(dt);
  updateStreaming(dt);

  // Zoom and camera position for this frame (see js/systems/Camera.js).
  Camera.update(dt);
};

// =====================================================================
// DRAW
// =====================================================================

// Everything up to the planetoids: stars are drawn before this, in screen space.
function drawBackground() {
  // Bob's and the Ooombas' shadow shapes for this frame (see
  // CharacterShadows.js) — up front, since the Space Shelter just below
  // takes them, as well as the level's tiles further down.
  CharacterShadows.prepare();

  if (state.skyDomePlanet) {
    state.skyDomePlanet.draw();
    GrassBlades.draw(state.skyDomePlanet.grassBlades);
  }

  // Between the dome's background and foreground hex layers; the door goes
  // over the player once he's stepped out in front of it (until then it's
  // drawn after him — see drawForeground).
  if (state.spaceShelter) {
    const shelter = state.spaceShelter;
    shelter.drawBody();
    if (shelter.playerInFront) {
      shelter.drawDoor();
      // His shadow on the shelter and its doors, only once he's in front.
      CharacterShadows.drawOntoSprite(() => {
        shelter.drawBody();
        shelter.drawDoor();
      });
    }
  }

  if (state.sun) state.sun.draw();

  // Asteroids. (Each WorldObjects layer culls its own off-screen items —
  // see js/systems/WorldObjects.js.)
  WorldObjects.draw('backdrop');

  DebugDraw.influenceRings();

  // Prisms before the planetoids, so each planetoid covers its prisms' feet.
  WorldObjects.draw('planetFeet');
}

// Planetoids, cannons, hazards and the Tiled levels.
function drawTerrain() {
  FireBarGlow.prepare();
  for (const p of state.planetoids) {
    // (The dome drew above; water planets draw after the player.)
    if (p !== state.skyDomePlanet && !p.isWaterPlanet && utils.isOnScreen(p.pos.x, p.pos.y, p.radius, 50)) {
      p.draw();
      FireBarGlow.drawOnto(p);
      if (p.interior) p.interior.draw();
    }
  }

  MissileOutpost.drawCannons(state.outposts);

  for (const cannon of (state.cannons ?? NONE)) {
    cannon.drawRails();
    if (!cannon.isTrack) {
      const [px, py] = cannon.pivot();
      if (utils.isOnScreen(px, py, 400, 50)) cannon.draw();
    }
  }

  Recall.draw();

  // Spikeys (deliberately not planetoids).
  WorldObjects.draw('hazards');

  if (state.tiledLevels) {
    TileGlow.prepare();
    for (const level of state.tiledLevels) {
      if (!utils.isOnScreen(level.pos.x, level.pos.y, level.radius, 50)) continue;
      level.draw();
      CharacterShadows.drawOnto(level);
      TileGlow.drawOnto(level);
      GrassBlades.draw(level.grassBlades);
      DebugDraw.levelShapes(level);
    }
  }

  // Rope rocks, gates, levers, cranks, signs, mirrors.
  WorldObjects.draw('props');

  DebugDraw.beltCells();
}

// Enemies, NPCs, the player, and what stands in front of him.
function drawActors() {
  WorldObjects.draw('enemies');

  MissileOutpost.drawMissiles();

  // Robot butler, fisherman, coins, fire bars, beams — beams before the
  // player, so he stands in front of one he's at.
  WorldObjects.draw('actors');

  PortalGun.draw();

  Cannon.drawFlightTrail(state.player);
  PortalGun.drawPlayer(state.player);

  // The grass tufts that stand in front of Bob and the Ooombas (the rest
  // were drawn behind, with their ground — see js/effects/GrassBlades.js).
  if (state.skyDomePlanet) GrassBlades.draw(state.skyDomePlanet.grassBlades, true);
  for (const level of state.tiledLevels ?? NONE) GrassBlades.draw(level.grassBlades, true);

  WaterSystem.draw();

  DebugDraw.collisionShapes();
}

// Water, lava, effects and overlays, over the player.
function drawForeground() {
  // Fish, then lava: after the player and before the water's top layer,
  // so water and lava cover whatever is in them.
  WorldObjects.draw('submerged');

  WaterSystem.drawOceans();

  state.player.drawBubbles();
  if (state.fish) for (const fish of state.fish) fish.drawBubbles();

  // The shelter door, over him while it's still closed or opening.
  if (state.spaceShelter && !state.spaceShelter.playerInFront) state.spaceShelter.drawDoor();

  PullBeam.draw();

  // Fireballs, ice bolts, particles, element pieces, explosions,
  // wall-jump rings.
  WorldObjects.draw('effects');

  if (state.skyDomePlanet) state.skyDomePlanet.drawForegroundGlass();

  VatsOverlay.draw();
  LockOutline.draw();
}

// Screen-space UI: minimap, blaster bar, dialogue, HUD text, pause menu,
// touch controls.
function drawInterface() {
  Cannon.drawSpeedLines(state.player);

  VatsCursor.drawReticle();

  // Title screen: just the scene and its own prompt.
  if (state.titleScreen) {
    TitleScreen.draw();
    return;
  }

  if (state.minimap) state.minimap.draw();

  // Blaster selector, lower-left (see js/ui/WeaponBar.js). Hidden while a
  // conversation textbox is up, so the box has the bottom of the screen
  // to itself.
  if (!state.dialogueActive) WeaponBar.draw();

  // Conversation textboxes — after the minimap, so the box covers it.
  WorldObjects.drawDialogues();

  Hud.draw();

  PauseMenu.draw();

  // The on-screen touch controls, on phones and tablets (see
  // js/ui/TouchControls.js) — over the pause menu, so its pause button
  // can resume.
  TouchControls.draw();

  // The black fade-in out of the title screen, over everything.
  TitleScreen.draw();
}

function drawFrame() {
  const g = love.graphics;
  Planetoid.beginFrame();
  state.starfield.draw(state.camera, state.visibleWidth, state.visibleHeight);

  g.push();
  g.scale(state.zoom, state.zoom);
  // (Snapped to whole screen pixels, so pixel art doesn't shimmer.)
  const zoom = state.zoom;
  g.translate(-Math.floor(state.camera.x * zoom + 0.5) / zoom,
    -Math.floor(state.camera.y * zoom + 0.5) / zoom);

  drawBackground();
  drawTerrain();
  drawActors();
  drawForeground();

  g.pop();

  drawInterface();
}

// Screen shake: the camera nudged for the draw only, then put back, so
// nothing that reads state.camera to decide anything is thrown off.
love.draw = function () {
  const camera = state.camera;
  const [sx, sy] = CameraShake.offset();
  if (camera && (sx !== 0 || sy !== 0)) {
    const zoom = state.zoom ?? 1;
    shakenCamera.x = camera.x + sx / zoom;
    shakenCamera.y = camera.y + sy / zoom;
    state.camera = shakenCamera;
  }
  try {
    drawFrame();
  } finally {
    state.camera = camera;
  }
};

// Start: preload every image and sound, then run love.load and the loop.
love.boot({
  canvas: document.getElementById('gameCanvas'),
  images: assetList.images,
  sounds: assetList.sounds,
  // Always show at least as much of the world as the LÖVE version does
  // in a maximized window on a 1920x1080 screen (1920x1004 — measured),
  // whatever size the browser window is. Hand-tuned zooms (the Tiled
  // Zoom-Windows framing the mirror puzzle, say) depend on it.
  minView: { width: 1920, height: 1004 },
});

// For poking at the game from the browser console while debugging.
globalThis.__asteroidBob = { state, love, Cannon, PortalGun, WaterSystem };
