// js/main.js
//
// The game's entry point: love.load / love.update / love.draw (a port of
// main.lua), run in the browser through the LÖVE-API shim in js/love/.
// Bundled by esbuild into dist/bundle.js (npm run build), which
// index.html loads.

import love from './love/index.js';
import assetList from './assetList.js';
import state from './state.js';
import constants from './constants.js';
import Planetoid from './world/Planetoid.js';
import Asteroid from './entities/Asteroid.js';
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
import World from './levels/World.js';
import WorldObjects from './systems/WorldObjects.js';
import Projectiles from './systems/Projectiles.js';
import Breakage from './systems/Breakage.js';
import Camera from './systems/Camera.js';
import MiniMap from './ui/MiniMap.js';
import BeltOrbit from './systems/BeltOrbitSystem.js';
import utils from './utils.js';
import LockOutline from './effects/LockOutline.js';
import InfluenceRing from './effects/InfluenceRing.js';
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


let collisionSystem;

// Reused every frame rather than built fresh each time: the planetoids
// the collision passes check (see collidablePlanetoids in love.update),
// which of them are immovable, and the camera nudged by screen shake.
const collidablePlanetoids = [], immovablePlanetoids = [];
const shakenCamera = { x: 0, y: 0 };
// An empty list for `state.cannons ?? NONE` and the like, when a world
// list doesn't exist — instead of a new empty array every frame.
const NONE = Object.freeze([]);

const OOOMBA_STOMP_BOUNCE = 7;
const INFLUENCE_RING_ALPHA_PULLING = 0.9;
const INFLUENCE_RING_ALPHA_INSIDE = 0.5;
const INFLUENCE_RING_ALPHA_NEAR = 0.35;
const INFLUENCE_RING_ALPHA_FAR = 0.05;
const INFLUENCE_RING_FADE_DISTANCE = 700;
const VATS_TIME_SCALE = 0.05;
const VATS_EASE_RATE = 0.12;
const VATS_EASE_SNAP_THRESHOLD = 0.005;


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
// the console says why. (Same switch as main.lua's.)
const START_AT = 'shelter';
const TILED_START_COLUMN = 5; // counting from 0, like Tiled

// Each option sets state.respawnPoint (see Player.respawn). `expresswayEntry`
// is { planet, cannon } when the expressway was built, else null.
const START_POSITIONS = {
  mining() {
    const planet = state.miningPlanet;
    if (!planet) return null;
    // The planet drifts: followsPlanet keeps the point on top of it every
    // frame (see love.update).
    return {
      x: planet.pos.x, y: planet.pos.y - planet.radius - constants.PLAYER_RADIUS,
      planet, followsPlanet: true,
    };
  },

  fisherman() {
    const rect = state.roundedRectPlanet;
    if (!rect) return null;
    return {
      x: rect.pos.x - rect.halfWidth * 0.4,
      y: rect.pos.y - rect.halfHeight - constants.PLAYER_RADIUS - 20,
    };
  },

  cracked() {
    const planet = state.crackedPlanet;
    if (!planet) return null;
    return {
      x: planet.pos.x,
      y: planet.pos.y - planet.radius - constants.PLAYER_RADIUS - 20,
    };
  },

  tiled() {
    const planet = state.tiledPlanet;
    if (!planet) return null;
    const columns = planet.rings[0].count;
    const angle = -Math.PI / 2 + (TILED_START_COLUMN + 0.5) / columns * 2 * Math.PI;
    const dist = planet.radius + constants.PLAYER_RADIUS + 20;
    return {
      x: planet.pos.x + Math.cos(angle) * dist,
      y: planet.pos.y + Math.sin(angle) * dist,
    };
  },

  tunnel() {
    // On the sky dome's ground, a few steps left of the ball tunnel's
    // mouth in Level1 (map column 33, row 35), dropping onto the floor
    // (row 36).
    const level = state.tiledLevels ? state.tiledLevels[0] : null;
    if (!level) return null;
    const T = 64;
    return {
      x: level.anchorX + 27.5 * T,
      y: level.anchorY + 36 * T - constants.PLAYER_RADIUS - 20,
    };
  },

  pinball() {
    if (!state.pinballPlanet) return null;
    const portal = state.pinballPlanet.interior.getPortalPosition();
    return { x: portal.x, y: portal.y, pinball: state.pinballPlanet.interior };
  },

  expressway(expresswayEntry) {
    if (!expresswayEntry) return null;
    // Standing a little round from the cannon, not in it.
    const { planet, cannon } = expresswayEntry;
    const standAngle = cannon.mountAngle - 0.45;
    const standDist = planet.radius + constants.PLAYER_RADIUS;
    return {
      x: planet.pos.x + Math.cos(standAngle) * standDist,
      y: planet.pos.y + Math.sin(standAngle) * standDist,
      planet,
    };
  },
};

function applyStartPosition(expresswayEntry) {
  if (START_AT === 'shelter') return;
  const place = START_POSITIONS[START_AT];
  const point = place ? place(expresswayEntry) : null;
  if (!point) {
    console.log(`main.js: START_AT = "${START_AT}" ${place ? 'but that planet is switched off' : "isn't a known start position"} - starting at the shelter instead.`);
    return;
  }
  state.respawnPoint = point;
  // He isn't waiting behind the shelter door, so skip its intro.
  state.spaceShelter.playerInFront = true;
  state.spaceShelter.introDone = true;
}

// =====================================================================
// DEBUG TELEPORT (T)
// =====================================================================
// T pauses the game with a list of every start position above; picking
// one puts him there straight away, the same as starting there would
// (see PauseMenu.openList). It also becomes his respawn point, so dying
// brings him back to it.
const TELEPORT_PLACES = [
  { key: 'shelter', label: 'SPACE SHELTER' },
  { key: 'mining', label: 'MINING PLANET' },
  { key: 'fisherman', label: "FISHERMAN'S PLANET" },
  { key: 'cracked', label: 'CRACKED PLANET' },
  { key: 'tiled', label: 'TILED PLANET' },
  { key: 'tunnel', label: 'SKY DOME BALL TUNNEL' },
  { key: 'pinball', label: 'PINBALL TABLE' },
  { key: 'expressway', label: 'EXPRESSWAY' },
];

// Remembered by love.load for the teleport list: the shelter's own
// respawn point (before START_AT changes it) and the expressway's entry.
let shelterRespawnPoint = null, expresswayEntry = null;
let lastTeleport = 0; // the list opens on whichever was picked last

// Where `key` (a TELEPORT_PLACES key) would put him right now, or null
// if that planet is switched off.
function teleportPoint(key) {
  if (key === 'shelter') return shelterRespawnPoint;
  return START_POSITIONS[key](expresswayEntry) || null;
}

function teleportTo(key) {
  const player = state.player, point = teleportPoint(key);
  if (!player || !point) return;
  state.respawnPoint = point;
  // (Out of the shelter's intro, if it was still playing.)
  if (state.spaceShelter) {
    state.spaceShelter.playerInFront = true;
    state.spaceShelter.introDone = true;
  }
  // Nothing from where he was comes with him.
  player.clearPullTarget();
  player.clearLockTarget();
  state.vatsActive = false;
  player.deathZoneRespawn = null; // (Player.respawn would go there instead)
  player.respawn();
  // The camera jumps with him, and the world round him is streamed in
  // now rather than up to half a second later.
  state.portalCameraGlide = null;
  state.cannonZoomFlying = null;
  state.cannonZoomReturn = null;
  Camera.pointAtPlayer();
  worldGen.updateActiveCells();
  state.cellCheckTimer = 0;
}

function openTeleportList() {
  const options = TELEPORT_PLACES.map((place) => ({
    label: place.label,
    enabled: teleportPoint(place.key) != null,
  }));
  PauseMenu.openList('TELEPORT', options, (index) => {
    lastTeleport = index;
    teleportTo(TELEPORT_PLACES[index].key);
  }, lastTeleport);
}

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
    // T: the debug teleport list (see openTeleportList).
    PauseMenu.onTeleportKey = openTeleportList;
  }

  collisionSystem = CollisionSystem.new();
  state.starfield = Starfield.new();

  // Every hand-placed landmark, the dome's Tiled interior and the
  // player (see js/levels/World.js).
  const world = World.build();
  // (For the T teleport list.)
  shelterRespawnPoint = state.respawnPoint;
  expresswayEntry = world.expresswayEntry;

  // Testing start spot (START_AT, top of this file), now that every
  // planet it could pick exists.
  applyStartPosition(world.expresswayEntry);

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

love.update = function (dt) {
  if (dt > 0) state.fps = (state.fps ?? 0) * 0.9 + (1 / dt) * 0.1;

  gamepadInput.pollGamepad(dt);

  // Paused: nothing below runs at all.
  if (PauseMenu.isOpen()) return;

  // The moment V.A.T.S. ends: unlock, and drop a pull nobody's holding.
  if (state.vatsWasActive && !state.vatsActive && state.player) {
    state.player.clearLockTarget();
    if (state.player.pullTarget && !(state.gamepadPullHeld || love.mouse.isDown(1))) {
      state.player.clearPullTarget();
    }
  }
  state.vatsWasActive = state.vatsActive;

  TitleScreen.update(dt);
  VatsCursor.update(dt);

  // Background music fades to suit where he is (see js/AudioManager.js).
  if (state.audioManager) state.audioManager.updateMusic(musicForPlayer(), dt);

  // This frame's time as "how many 60fps frames" (clamped to a 20fps floor).
  const FPS_BASELINE = 60;
  const MAX_FRAME_DT = 0.05;
  const frameNorm = Math.min(dt, MAX_FRAME_DT) * FPS_BASELINE;

  state.timeScaleTarget = state.vatsActive ? VATS_TIME_SCALE : 1;
  const timeScaleDiff = state.timeScaleTarget - state.vatsMultiplier;
  if (Math.abs(timeScaleDiff) < VATS_EASE_SNAP_THRESHOLD) {
    state.vatsMultiplier = state.timeScaleTarget;
  } else {
    state.vatsMultiplier += timeScaleDiff * Math.min(VATS_EASE_RATE * frameNorm, 1);
  }

  state.timeScale = state.vatsMultiplier * frameNorm;
  // (A cannon shot's hit-stop.)
  state.timeScale *= Cannon.timeFactor();

  updatePlanetoidsPhysics();

  for (const p of state.planetoids) {
    if (p.updateRotation && !p.recalling) p.updateRotation(state.timeScale);
  }

  // (TEMPORARY, with TEMP_START_ON_MINING_PLANET.)
  if (state.respawnPoint && state.respawnPoint.followsPlanet) {
    const point = state.respawnPoint, planet = state.respawnPoint.planet;
    point.x = planet.pos.x; point.y = planet.pos.y - planet.radius - constants.PLAYER_RADIUS;
  }

  for (const p of state.planetoids) {
    if (p.update && !p.recalling) p.update();
  }

  Recall.update(dt);

  // Everything in the world's object lists (rope rocks, asteroids, coins,
  // Ooombas, fire bars, levers, fish, NPCs, ...) — before the player
  // moves, so one standing on a rope rock is carried along. Order and
  // details: js/systems/WorldObjects.js.
  WorldObjects.update('world', dt);

  // Player.js reads this to freeze him while any conversation is showing.
  state.dialogueActive = WorldObjects.anyDialogueActive();

  const player = state.player;
  // A left click since last frame (see InputHandlers.js), fired below
  // once he's moved; dropped if he can't fire this frame.
  const mouseFire = state.mouseFirePending;
  state.mouseFirePending = false;
  if (player.portalTransit) {
    PortalGun.updateTransit(player, state.timeScale);
  } else {
    if (state.titleScreen) {
      player.move(TitleScreen.getKeys());
    } else {
      const noSteering = state.introLocked || player.inPinball || state.vatsActive
        || player.inCannon || player.cannonFlight;
      // Standing, he can't walk or run into a gap lower than he is tall —
      // a ball tunnel (see TiledTerrain.js's Level.headroomAt) — unless
      // he's already somewhere that low.
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

    if (player.inPinball) {
      const jumpHeld = !!(state.keys[' '] || state.gamepadJumpHeld);
      player.inPinball.updateBall(player, state.timeScale, jumpHeld);
    } else if (player.pullTarget) {
      player.applyPullForce();
    } else if (!(player.inCannon || player.cannonFlight)) {
      state.gravitySystem.applyTo(player);
    }

    player.update();

    for (const cannon of (state.cannons ?? NONE)) cannon.update(player, state.timeScale);
    Cannon.updateFlight(player, state.timeScale);
    for (const cannon of (state.cannons ?? NONE)) cannon.updateCoins(player, state.timeScale / 60);

    PortalGun.tryEnter(player);

    if (!player.inPinball && !player.inCannon) collisionSystem.handlePlayerPlanetCollisions(player);

    // Gamepad R2 held, or a left click: fire (shootFireball throttles itself).
    if ((state.gamepadFireHeld || mouseFire) && player) {
      if (state.iceMode) player.shootIceBolt(); else player.shootFireball();
    }

    player.touchingWall = null;
    player.wallContactNormal = null;

    if (state.tiledLevels) {
      for (const level of state.tiledLevels) {
        collisionSystem.handlePlayerWallCollisions(player, level.walls);
        // Ball-tunnel pieces, and (standing, in the air) his head.
        level.pushPlayer(player);
      }
    }
    // Plungers: solid to him, loaded by pushing into them, fire him when
    // he lets go (see js/world/Plunger.js).
    for (const plunger of state.plungers ?? NONE) plunger.update(player, state.timeScale);

    collisionSystem.handlePlayerSpikeyCollisions(player, state.spikeys);

    // Ooombas: squashed flat ones go with a burst and a little hop.
    if (state.ooombas && state.ooombas.length > 0 && !state.titleScreen) {
      const flattened = collisionSystem.handlePlayerOoombaCollisions(player, state.ooombas);
      for (const o of flattened) {
        const up = o.up;
        const groundX = o.pos.x - up.x * o.halfHeight, groundY = o.pos.y - up.y * o.halfHeight;
        if (o.squashPressed) {
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

    collisionSystem.handlePlayerSkyDomeContainment(player, state.skyDomePlanet);
  }

  // Off-screen belt planetoids are left out of planetoid collisions.
  collidablePlanetoids.length = 0;
  for (const p of state.planetoids) {
    if (!p.isBeltPlanetoid || utils.isOnScreen(p.pos.x, p.pos.y, p.radius, 50)) collidablePlanetoids.push(p);
  }

  collisionSystem.handleElasticCollisions(collidablePlanetoids);

  {
    immovablePlanetoids.length = 0;
    for (const p of collidablePlanetoids) if (p.isImmovable) immovablePlanetoids.push(p);
    if (immovablePlanetoids.length > 0) collisionSystem.handleImmovableCollisions(immovablePlanetoids, collidablePlanetoids);
  }

  if (state.fireBars && state.fireBars.length > 0) {
    // (Not lethal on the title screen.)
    if (!state.titleScreen) collisionSystem.handlePlayerFireBarCollisions(player, state.fireBars);
    if (state.asteroids && state.asteroids.length > 0) {
      collisionSystem.handleImmovableCollisions(state.fireBars, state.asteroids);
    }
  }

  if (state.asteroids && state.asteroids.length > 0) {
    collisionSystem.handleElasticCollisions(state.asteroids);
    const toBreak = collisionSystem.handlePlanetAsteroidCollisions(collidablePlanetoids, state.asteroids);
    for (const [asteroid, planet] of toBreak) Breakage.breakAsteroid(asteroid, planet);
  }

  if (state.coins) collisionSystem.handleCoinCollisions(player, state.coins);

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

  // Explosions, wall-jump contact rings and debris particles: purely
  // time-driven visuals (see js/systems/WorldObjects.js).
  WorldObjects.update('effects', dt);

  BeltOrbit.apply(state.planetoids);

  if (state.sun) state.sun.update();

  // World streaming and the belt's drip, every so many seconds (real
  // time, not frames — so neither runs more often at a higher frame rate).
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

  // Zoom and camera position for this frame (see js/systems/Camera.js).
  Camera.update(dt);
};

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

  // Bob's and the Ooombas' shadow shapes for this frame (see
  // CharacterShadows.js) — up front, since the Space Shelter just below
  // takes them, as well as the level's tiles further down.
  CharacterShadows.prepare();

  if (state.skyDomePlanet) {
    state.skyDomePlanet.draw();
    GrassBlades.draw(state.skyDomePlanet.grassBlades);
  }

  // Between the dome's background and foreground hex layers; the door
  // goes over the player once he's stepped out in front of it.
  if (state.spaceShelter) {
    const shelter = state.spaceShelter;
    shelter.drawBody();
    if (shelter.playerInFront) {
      shelter.drawDoor();
      // His shadow on the shelter (and its doors), the same as on the
      // level's tiles — only once he's stepped out in front of it, not
      // while he's still inside behind the closed door.
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

  // Influence rings ('R'), brightest for whatever's pulling him.
  if (state.showInfluenceRings) {
    const player = state.player;
    const pulling = (player.onSurface && player.currentPlanet)
      || (state.gravitySystem && state.gravitySystem.findDominantPlanet(player.pos));
    for (const p of state.planetoids) {
      if (p.influenceRadius && !p.isRoundedRect && utils.isOnScreen(p.pos.x, p.pos.y, p.influenceRadius, 50)) {
        const dx = player.pos.x - p.pos.x, dy = player.pos.y - p.pos.y;
        const outside = Math.sqrt(dx * dx + dy * dy) - p.influenceRadius;
        let alpha;
        if (p === pulling) alpha = INFLUENCE_RING_ALPHA_PULLING;
        else if (outside <= 0) alpha = INFLUENCE_RING_ALPHA_INSIDE;
        else {
          const t = Math.min(1, outside / INFLUENCE_RING_FADE_DISTANCE);
          alpha = INFLUENCE_RING_ALPHA_NEAR + (INFLUENCE_RING_ALPHA_FAR - INFLUENCE_RING_ALPHA_NEAR) * t;
        }
        InfluenceRing.draw(p.pos.x, p.pos.y, p.influenceRadius, alpha);
      }
    }
  }

  // Prisms before the planetoids, so each planetoid covers its prisms' feet.
  WorldObjects.draw('planetFeet');

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
      if (state.showCollisionDebug) {
        g.setLineWidth(4);
        g.setColor(1, 0, 0, 1);
        for (const shape of level.shapes) {
          if (shape.isWallClimb) continue;
          for (const seg of shape.segments) g.line(seg.a.x, seg.a.y, seg.b.x, seg.b.y);
        }
        g.setColor(0.2, 0.6, 1, 1);
        for (const wall of (level.walls ?? NONE)) {
          g.rectangle('line', wall.pos.x - wall.halfWidth, wall.pos.y - wall.halfHeight,
            wall.halfWidth * 2, wall.halfHeight * 2);
        }
        g.setColor(0.2, 1, 0.2, 1);
        for (const shape of level.shapes) {
          if (!shape.isWallClimb) continue;
          for (const seg of shape.segments) g.line(seg.a.x, seg.a.y, seg.b.x, seg.b.y);
        }
        g.setColor(1, 1, 1, 1);
        g.setLineWidth(1);
      }
    }
  }

  // Rope rocks, gates, levers, cranks, signs, mirrors.
  WorldObjects.draw('props');

  // Debug ('A'): belt cells in the 3x3, and the cell grid across the view.
  if (state.showBeltCellDebug && state.player) {
    const cellSize = worldGen.CELL_SIZE;
    const playerCell = worldGen.cellCoordFor(state.player.pos.x, state.player.pos.y);
    g.setColor(1, 0, 0, 0.35);
    for (let dRow = -1; dRow <= 1; dRow++) {
      for (let dCol = -1; dCol <= 1; dCol++) {
        const col = playerCell.col + dCol, row = playerCell.row + dRow;
        if (worldGen.cellIntersectsBelt(col, row)) g.rectangle('fill', col * cellSize, row * cellSize, cellSize, cellSize);
      }
    }
    const cam = state.camera ?? { x: 0, y: 0 };
    const visW = state.visibleWidth ?? 0, visH = state.visibleHeight ?? 0;
    const firstCol = Math.floor(cam.x / cellSize), lastCol = Math.floor((cam.x + visW) / cellSize) + 1;
    const firstRow = Math.floor(cam.y / cellSize), lastRow = Math.floor((cam.y + visH) / cellSize) + 1;
    g.setColor(0.2, 0.6, 1, 0.9);
    g.setLineWidth(2);
    for (let col = firstCol; col <= lastCol; col++) {
      const x = col * cellSize;
      g.line(x, firstRow * cellSize, x, (lastRow + 1) * cellSize);
    }
    for (let row = firstRow; row <= lastRow; row++) {
      const y = row * cellSize;
      g.line(firstCol * cellSize, y, (lastCol + 1) * cellSize, y);
    }
    g.setLineWidth(1);
    g.setColor(1, 1, 1, 1);
  }

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

  // Debug ('C'): the player's collision capsule.
  if (state.showCollisionDebug) {
    const p = state.player;
    const r = p.radius;
    const onWallClimb = p.onSurface && p.currentPlanet && p.currentPlanet.isWallClimb;
    const headReach = (!p.isBall && !onWallClimb) ? (p.headReach ?? 0) : 0;
    const topY = p.pos.y - Math.max(0, headReach - r);
    const bottomY = p.pos.y;
    const px = p.pos.x;
    g.setLineWidth(3);
    g.setColor(1, 0.2, 1, 1);
    g.circle('line', px, bottomY, r);
    g.circle('line', px, topY, r);
    if (topY < bottomY) {
      g.line(px - r, topY, px - r, bottomY);
      g.line(px + r, topY, px + r, bottomY);
    }
    g.setColor(1, 1, 1, 1);
    g.setLineWidth(1);
  }

  // Debug ('C'): Spikeys' solid boundaries.
  if (state.showCollisionDebug && state.player && state.spikeys) {
    g.setLineWidth(3);
    g.setColor(1, 0.55, 0, 1);
    for (const sp of state.spikeys) {
      if (utils.isOnScreen(sp.pos.x, sp.pos.y, sp.radius + state.player.radius, 20)) {
        g.circle('line', sp.pos.x, sp.pos.y, sp.radius + state.player.radius + constants.SURFACE_TOLERANCE);
      }
    }
    g.setColor(1, 1, 1, 1);
    g.setLineWidth(1);
  }

  // Debug ('C'): each Ooomba's contact circle — he's hit when his own circle
  // overlaps it, unless he's stomping from above (fireballs use it too). Cyan.
  if (state.showCollisionDebug && state.ooombas) {
    g.setLineWidth(3);
    g.setColor(0.2, 0.9, 1, 1);
    for (const o of state.ooombas) {
      if (utils.isOnScreen(o.pos.x, o.pos.y, o.hitRadius, 20)) g.circle('line', o.pos.x, o.pos.y, o.hitRadius);
    }
    g.setColor(1, 1, 1, 1);
    g.setLineWidth(1);
  }

  // Debug ('C'): the sky dome's containment boundary.
  if (state.showCollisionDebug && state.skyDomePlanet) {
    const dome = state.skyDomePlanet;
    g.setLineWidth(3);
    g.setColor(1, 1, 0.2, 1);
    const deckY = dome.trueSurfaceY();
    const domeTopY = dome.domeAnchorY() - dome.domeRadiusY;
    g.line(dome.pos.x - dome.halfWidth, deckY, dome.pos.x - dome.halfWidth, domeTopY);
    g.line(dome.pos.x + dome.halfWidth, deckY, dome.pos.x + dome.halfWidth, domeTopY);
    g.line(dome.pos.x - dome.halfWidth, deckY, dome.pos.x + dome.halfWidth, deckY);
    const cx = dome.pos.x, cy = dome.domeAnchorY();
    const rx = dome.domeRadiusX, ry = dome.domeRadiusY;
    const segments = 72;
    const points = [];
    for (let i = 0; i <= segments; i++) {
      const t = Math.PI + (i / segments) * Math.PI;
      points.push(cx + Math.cos(t) * rx, cy + Math.sin(t) * ry);
    }
    g.line(points);
    g.setColor(1, 1, 1, 1);
    g.setLineWidth(1);
  }

  // Fish, then lava: after the player and before the water's top layer,
  // so water and lava cover whatever is in them.
  WorldObjects.draw('submerged');

  WaterSystem.drawOceans();

  state.player.drawBubbles();
  if (state.fish) for (const fish of state.fish) fish.drawBubbles();

  if (state.spaceShelter && !state.spaceShelter.playerInFront) state.spaceShelter.drawDoor();

  PullBeam.draw();

  // Fireballs, ice bolts, particles, element pieces, explosions,
  // wall-jump rings.
  WorldObjects.draw('effects');

  if (state.skyDomePlanet) state.skyDomePlanet.drawForegroundGlass();

  VatsOverlay.draw();
  LockOutline.draw();

  g.pop();

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

  const cell = worldGen.cellCoordFor(state.player.pos.x, state.player.pos.y);

  g.setColor(1, 1, 1, 1);
  g.print(`Level ${state.level} - Score: ${state.score}`, 20, 20);
  g.print(`FPS: ${(state.fps ?? 0).toFixed(1)}`, 20, 40);
  // (The rest is keyboard/mouse help and debug readouts — not shown
  // with the touch controls, which are their own guide.)
  if (!state.touchControlsVisible) {
    g.print(`Zoom: ${state.zoom.toFixed(1)}x (+/-)`, 20, 60);
    g.print(`Cell: (${cell.col}, ${cell.row})`, 20, 80);
    g.print(`Planetoids: ${state.planetoids.length}  Coins: ${state.coins ? state.coins.length : 0}  Asteroids: ${state.asteroids ? state.asteroids.length : 0}  FireBars: ${state.fireBars ? state.fireBars.length : 0}`, 20, 100);
    g.print(`Rubinium: ${state.elements.rubinium}  Asteroidium: ${state.elements.asteroidium}`, 20, 120);
    g.print(`Mode: ${WeaponModes.label()} (Tab / D-pad left-right to switch)`, 20, 140);
    if (state.portalMode) {
      g.print('Left-click / L2: red portal, Right-click / R2: blue portal, Space to jump', 20, 160);
    } else if (state.waterMode) {
      g.print(`Left-click / R2: spray water (${Math.floor(WaterSystem.totalWater() + 0.5)} / ${WaterSystem.waterCap()}), Space to jump (or swim)`, 20, 160);
    } else if (state.recallMode) {
      g.print('Left-click / R2 on a planetoid: rewind it (again to stop), Space to jump', 20, 160);
    } else if (state.iceMode) {
      g.print('Left-click / R2: ice bolt (freezes water, cools lava, freezes Ooombas), Space to jump', 20, 160);
    } else if (state.pullBeamMode) {
      g.print('Left-click / R2 on a planet to pull toward it, Space to jump, C to toggle collision debug', 20, 160);
    } else {
      g.print('Left-click / R2: fireball (L2: pull beam), Space to jump, C to toggle collision debug', 20, 160);
    }
    // On or near a dirt planet: which way its gravity pulls (see
    // CrackedPlanetoid.cycleGravity).
    {
      const p = state.player.currentPlanet ?? state.player.lastInfluencePlanet;
      if (p && p.cycleGravity) {
        g.print(`Gravity: ${p.GRAVITY_LABELS[p.gravityMode] ?? p.gravityMode} (G to change)   Spin: ${p.SPIN_LABELS[p.spinDir] ?? 'Off'} (N clockwise, M counter-clockwise)`, 20, 180);
      }
    }
  }

  PauseMenu.draw();

  // The on-screen touch controls, on phones and tablets (see
  // js/ui/TouchControls.js) — over the pause menu, so its pause button
  // can resume.
  TouchControls.draw();

  // The black fade-in out of the title screen, over everything.
  TitleScreen.draw();
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
