// js/main.js
//
// The game's entry point: love.load / love.update / love.draw (a port of
// main.lua), run in the browser through the LÖVE-API shim in js/love/.
// Bundled by esbuild into dist/bundle.js (npm run build), which
// index.html loads.

import love from './love/index.js';
import lua from './love/lua.js';
import assetList from './assetList.js';
import state from './state.js';
import constants from './constants.js';
import Vector2 from './vector2.js';
import Planetoid from './world/Planetoid.js';
import Player from './entities/Player.js';
import Asteroid from './entities/Asteroid.js';
import Coin from './entities/Coin.js';
import Ooomba from './entities/Ooomba.js';
import Explosion from './entities/Explosion.js';
import Particle from './entities/Particle.js';
import StompBurst from './effects/StompBurst.js';
import TitleScreen from './ui/TitleScreen.js';
import PauseMenu from './ui/PauseMenu.js';
import GravitySystem from './systems/GravitySystem.js';
import CollisionSystem from './systems/CollisionSystem.js';
import CameraDirector from './systems/CameraDirector.js';
import Starfield from './world/Starfield.js';
import Sun from './world/Sun.js';
import PullBeam from './effects/PullBeam.js';
import assetLoading from './setup/assetLoading.js';
import inputHandlers from './setup/InputHandlers.js';
import gamepadInput from './setup/GamePadInput.js';
import worldGen from './setup/WorldGen.js';
import MiniMap from './ui/MiniMap.js';
import SkyDomePlanetoid from './world/SkyDomePlanetoid.js';
import SpaceShelter from './world/SpaceShelter.js';
import RobotButler from './entities/RobotButler.js';
import Fisherman from './entities/Fisherman.js';
import TiledTerrain from './world/TiledTerrain.js';
import Sphere from './world/Sphere.js';
import SphereMove from './world/SphereMove.js';
import RoundedRectPlanetoid from './world/RoundedRectPlanetoid.js';
import Spikey from './world/Spikey.js';
import SpikeyVertical from './world/SpikeyVertical.js';
import SpikeyOrbit from './world/SpikeyOrbit.js';
import Lever from './world/Lever.js';
import Crank from './world/Crank.js';
import Mirror from './world/Mirror.js';
import Sign from './world/Sign.js';
import Prism from './world/Prism.js';
import ElementPiece from './entities/ElementPiece.js';
import CrystalPlanet from './world/CrystalPlanet.js';
import PinballInterior from './interiors/PinballInterior.js';
import Beam from './world/Beam.js';
import Gate from './world/Gate.js';
import BeltOrbit from './systems/BeltOrbitSystem.js';
import utils from './utils.js';
import LockOutline from './effects/LockOutline.js';
import InfluenceRing from './effects/InfluenceRing.js';
import VatsOverlay from './effects/VatsOverlay.js';
import VatsCursor from './effects/VatsCursor.js';
import Lava from './world/Lava.js';
import WaterPlanet from './world/WaterPlanet.js';
import Fish from './entities/Fish.js';
import PortalGun from './systems/PortalGun.js';
import WaterSystem from './systems/WaterSystem.js';
import Recall from './systems/Recall.js';
import CharacterShadows from './effects/CharacterShadows.js';
import TileGlow from './effects/TileGlow.js';
import FireBarGlow from './effects/FireBarGlow.js';
import RopeRock from './world/RopeRock.js';
import Cannon from './world/Cannon.js';
import MissileOutpost from './world/MissileOutpost.js';
import CameraShake from './effects/CameraShake.js';
import WeaponModes from './systems/WeaponModes.js';
import level1Map from './levels/Level1.js';
import pinballMap from './levels/Pinball-Level2.js';

const rnd = () => lua.random();
const rad = (d) => d * Math.PI / 180;

let collisionSystem;

const ZOOM_MIN = 0.6;
const ZOOM_MAX = 2.5;
const ZOOM_STEP_PER_FRAME = 0.02;
const ZOOM_WINDOW_EASE_PER_FRAME = 0.03;
const ZOOM_WINDOW_SNAP = 0.002;
const OOOMBA_STOMP_BOUNCE = 7;
const INFLUENCE_RING_ALPHA_PULLING = 0.9;
const INFLUENCE_RING_ALPHA_INSIDE = 0.5;
const INFLUENCE_RING_ALPHA_NEAR = 0.35;
const INFLUENCE_RING_ALPHA_FAR = 0.05;
const INFLUENCE_RING_FADE_DISTANCE = 700;
const VATS_TIME_SCALE = 0.05;
const VATS_EASE_RATE = 0.12;
const VATS_EASE_SNAP_THRESHOLD = 0.005;

const PORTAL_CAMERA_GLIDE_RATE_MIN = 1;
const PORTAL_CAMERA_GLIDE_RATE_MAX = 8;
const PORTAL_CAMERA_GLIDE_FAR_DISTANCE = 2500;
const PORTAL_CAMERA_SETTLED = 1;

// The home dome's cell, counted from the sun's own cell.
const HOME_CELL_COL = worldGen.GRID_SIZE / 2 + 3;
const HOME_CELL_ROW = worldGen.GRID_SIZE / 2 - 1;

// love.load runs once at startup, and again in full every time the pause
// menu's EXIT TO TITLE is chosen (a fresh world each time).
let hasLoadedOnce = false;

// Empties everything a previous run of love.load left in `state`.
function resetWorldState() {
  state.planetoids = []; state.asteroids = []; state.coins = [];
  state.fireBars = []; state.particles = []; state.enemies = [];

  state.fish = null; state.beams = null; state.lavas = null; state.tiledLevels = null;
  state.ropeRocks = null; state.recallables = null;
  state.ooombas = null; state.spikeys = null; state.mirrors = null; state.levers = null;
  state.cranks = null; state.signs = null; state.gates = null;
  state.zoomWindows = null; state.deathZones = null;
  state.pinballPlanet = null; state.waterPlanet = null; state.waterCore = null; state.roundedRectPlanet = null;
  state.beltLandingPlanet = null;
  state.miningPlanet = null; state.prisms = null;
  state.cannons = null; state.clearLanes = null;
  state.expressway = null; state.expresswayExits = null;
  state.outposts = null; state.missiles = null;
  state.cannonZoomFlying = null; state.cannonZoomReturn = null;
  state.elementPieces = [];
  state.portals = null; state.portalTracers = null;
  WeaponModes.set('blaster');
  WaterSystem.reset();
  Recall.reset();
  state.portalCameraGlide = null;

  state.camera = null;
  state.cameraDirector = null;
  state.activeZoomWindow = null; state.zoomWindowReturn = null;
  state.dialogueActive = false;
  state.paused = false;
  state.gameOver = false; state.levelComplete = false;
  state.keys = {};
  state.mouseDown = false;
  state.vatsWasActive = false;
  state.gamepadPullHeld = false;
}

// The nearest walkable Tiled surface straight below (x, y), within
// `reach` — the loose-placement snap used for Ooombas, levers, cranks
// and signs. -> { shape, hit } or null
function groundBelow(shapes, x, y, reach) {
  let best = null, bestDy = null;
  for (const shape of shapes) {
    if (shape.isWallClimb) continue;
    const hit = shape.findLandingCrossing(x, y, x, y + reach);
    if (hit) {
      const dy = hit.point.y - y;
      if (dy >= 0 && (bestDy == null || dy < bestDy)) {
        bestDy = dy;
        best = { shape, hit };
      }
    }
  }
  return best;
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

  state.zoom = 1;
  state.zoomMax = ZOOM_MAX;
  state.zoomMin = ZOOM_MIN;
  state.zoomTarget = null;
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
  state.fireballs = [];
  state.explosions = [];
  state.wallContactPulses = [];
  state.fireBars = state.fireBars ?? [];
  state.cellCheckCounter = 0;
  state.minimap = MiniMap.new();

  if (firstLoad) {
    assetLoading.loadAssets();
    inputHandlers.attachInputHandlers();
    // EXIT TO TITLE: run this whole function again.
    PauseMenu.onExitToTitle = () => love.load();
  }

  collisionSystem = CollisionSystem.new();
  state.starfield = Starfield.new();

  const cellSize = worldGen.CELL_SIZE;
  const domeHalfW = 4000;
  const domeX = HOME_CELL_COL * cellSize + domeHalfW + 80;
  const domeY = HOME_CELL_ROW * cellSize + cellSize * 0.5;

  const dome = SkyDomePlanetoid.new(domeX, domeY, {
    halfWidth: domeHalfW,
    halfHeight: 32,
    grassHeight: 32,
    domeRadiusX: domeHalfW,
    domeRadiusY: domeHalfW,
  });
  dome.isPermanent = true;
  state.planetoids.push(dome);

  state.spaceShelter = SpaceShelter.new(domeX - domeHalfW * 0.6, dome.trueSurfaceY());
  state.skyDomePlanet = dome;

  // "Pinball" planet: a tall rounded rectangle with a playable pinball
  // table on its face (see PinballInterior.js), the dome's mirror image
  // across the sun.
  const SHOW_PINBALL_PLANET = true;
  if (SHOW_PINBALL_PLANET) {
    const PINBALL_PLANET_MARGIN = 128;
    const halfW = pinballMap.width * 64 / 2 + PINBALL_PLANET_MARGIN;
    const halfH = pinballMap.height * 64 / 2 + PINBALL_PLANET_MARGIN;
    const [sunX, sunY] = worldGen.sunPos();
    const domeEdgeFromSun = (dome.pos.x - domeHalfW) - sunX;
    const PINBALL_EXTRA_GAP = 100;
    const planet = RoundedRectPlanetoid.new(
      sunX - domeEdgeFromSun - PINBALL_EXTRA_GAP - halfW, sunY, halfW, halfH, 64, [0.55, 0.57, 0.62, 1]);
    planet.isImmovable = true;
    planet.isPermanent = true;
    planet.isSpawnExclusion = true;
    planet.vel.x = 0; planet.vel.y = 0;
    planet.rotationAngle = 0;
    const TEMP_PINBALL_ROTATION_SPEED = 0;
    planet.rotationSpeed = TEMP_PINBALL_ROTATION_SPEED;
    // (Baked at 0.5x: a 2x body canvas would exceed GPU texture limits.)
    planet.bodyCanvasScale = 0.5;
    planet.interior = PinballInterior.new(planet, pinballMap);
    state.planetoids.push(planet);
    state.pinballPlanet = planet;
  }

  // Water planets, with fish.
  {
    const [sunCol, sunRow] = worldGen.sunCell();
    const waterCol = sunCol + 3, waterRow = sunRow + 3;
    const waterX = (waterCol + 0.5) * cellSize;
    const waterY = (waterRow + 0.5) * cellSize;
    const [waterPlanet, waterCore] = WaterPlanet.new(waterX, waterY, 960);
    state.planetoids.push(waterPlanet, waterCore);
    state.waterPlanet = waterPlanet;
    state.waterCore = waterCore;

    state.fish = [];
    const FISH_COUNT = 6;
    for (let k = 0; k < FISH_COUNT; k++) state.fish.push(Fish.new(waterPlanet, waterCore));

    const water2X = waterX + 1820;
    const water2Y = waterY + 750;
    const [waterPlanet2, waterCore2] = WaterPlanet.new(water2X, water2Y, 960 * 0.7);
    state.planetoids.push(waterPlanet2, waterCore2);
    state.waterPlanet2 = waterPlanet2;
    state.waterCore2 = waterCore2;

    const FISH_COUNT_2 = 4;
    for (let k = 0; k < FISH_COUNT_2; k++) state.fish.push(Fish.new(waterPlanet2, waterCore2));

    const SMALL_WATER_RADIUS = (960 * 0.7) * 0.5;
    const smallWaterOffsets = [[-650, 1050], [100, 1200], [900, 900]];
    for (const off of smallWaterOffsets) {
      const [wp, wc] = WaterPlanet.new(water2X + off[0], water2Y + off[1], SMALL_WATER_RADIUS);
      state.planetoids.push(wp, wc);
      for (let k = 0; k < 3; k++) state.fish.push(Fish.new(wp, wc));
    }
  }

  // Rounded-rectangle landmark above the second water planet, with the
  // fisherman on it dangling his line into the water.
  {
    const ROUNDED_RECT_HALF_WIDTH = 150;
    const ROUNDED_RECT_HALF_HEIGHT = 100;
    const ROUNDED_RECT_CORNER_RADIUS = 30;
    const FISHERMAN_HOOK_REACH = 852.75;
    const FISHERMAN_HOOK_WATER_DIP = 80;
    const groundY = state.waterPlanet2.pos.y - state.waterPlanet2.radius
      - FISHERMAN_HOOK_WATER_DIP - FISHERMAN_HOOK_REACH;
    let rectY = groundY + ROUNDED_RECT_HALF_HEIGHT;
    let rectX = state.waterPlanet2.pos.x;
    const ROUNDED_RECT_NUDGE_X = -150;
    const ROUNDED_RECT_NUDGE_Y = 210;
    rectX += ROUNDED_RECT_NUDGE_X;
    rectY += ROUNDED_RECT_NUDGE_Y;
    const roundedRectPlanet = RoundedRectPlanetoid.new(
      rectX, rectY,
      ROUNDED_RECT_HALF_WIDTH, ROUNDED_RECT_HALF_HEIGHT, ROUNDED_RECT_CORNER_RADIUS,
      [0.68, 0.56, 0.42, 1]);
    roundedRectPlanet.isImmovable = true;
    roundedRectPlanet.isPermanent = true;
    roundedRectPlanet.vel.x = 0; roundedRectPlanet.vel.y = 0;
    roundedRectPlanet.rotationAngle = 0;
    roundedRectPlanet.rotationSpeed = 0;
    state.planetoids.push(roundedRectPlanet);
    state.roundedRectPlanet = roundedRectPlanet;
  }

  // Robot butler, just right of the shelter.
  const ROBOT_GAP_FROM_SHELTER = 60;
  const robotHomeX = state.spaceShelter.pos.x + state.spaceShelter.drawWidth / 2 + ROBOT_GAP_FROM_SHELTER;
  state.robotButler = RobotButler.new(robotHomeX, dome.trueSurfaceY());

  // Fisherman, at the right edge of the rounded rectangle.
  const FISHERMAN_GAP_FROM_EDGE = 50;
  const fishermanHomeX = state.roundedRectPlanet.pos.x + state.roundedRectPlanet.halfWidth - FISHERMAN_GAP_FROM_EDGE;
  const fishermanGroundY = state.roundedRectPlanet.pos.y - state.roundedRectPlanet.halfHeight;
  state.fisherman = Fisherman.new(fishermanHomeX, fishermanGroundY);

  // Beam pair: shelter <-> belt-edge landing planet.
  {
    const BEAM_GAP_FROM_SHELTER = 150;
    const homeBeam = Beam.new(
      state.spaceShelter.pos.x - state.spaceShelter.drawWidth / 2 - BEAM_GAP_FROM_SHELTER,
      dome.trueSurfaceY(), -Math.PI / 2);

    const [sunX, sunY] = worldGen.sunPos();
    const [, beltOuterRadius] = worldGen.beltRadii();
    let dirX = domeX - sunX, dirY = domeY - sunY;
    const dirLen = Math.sqrt(dirX * dirX + dirY * dirY);
    dirX /= dirLen; dirY /= dirLen;

    const BELT_PLANET_RADIUS = 120;
    const BELT_PLANET_GAP = 260;
    const beltPlanetDist = beltOuterRadius + BELT_PLANET_RADIUS + BELT_PLANET_GAP;
    const beltPlanetX = sunX + dirX * beltPlanetDist;
    const BELT_PLANET_EXTRA_DOWN = 500;
    const beltPlanetY = sunY + dirY * beltPlanetDist + BELT_PLANET_EXTRA_DOWN;

    const beltLandingPlanet = Sphere.new(beltPlanetX, beltPlanetY, BELT_PLANET_RADIUS);
    state.planetoids.push(beltLandingPlanet);
    state.beltLandingPlanet = beltLandingPlanet;

    const beltBeam = Beam.new(beltPlanetX, beltPlanetY - BELT_PLANET_RADIUS, -Math.PI / 2);

    homeBeam.destination = beltBeam;
    beltBeam.destination = homeBeam;
    state.beams = [homeBeam, beltBeam];
  }

  // Mining planet (crystal), with prism clusters.
  {
    const MINING_PLANET_RADIUS = 140;
    const MINING_PLANET_PRISM_CLUSTERS = 5;
    const MINING_PLANET_BELOW_LANDING_PLANET = 900;
    const anchor = state.beltLandingPlanet;
    const miningPlanet = CrystalPlanet.new(
      anchor.pos.x, anchor.pos.y + MINING_PLANET_BELOW_LANDING_PLANET, MINING_PLANET_RADIUS);
    state.planetoids.push(miningPlanet);
    state.miningPlanet = miningPlanet;
    state.prisms = Prism.scatterClusters(miningPlanet, MINING_PLANET_PRISM_CLUSTERS);
  }

  // Pinball planet entry beam (one-way: drops him onto the plunger).
  const addPinballEntryBeam = (pinball) => {
    const PINBALL_BEAM_OFFSET_X = -pinball.halfWidth * 0.4;
    const pinballBeamX = pinball.pos.x + PINBALL_BEAM_OFFSET_X;
    const pinballBeamY = pinball.pos.y - pinball.halfHeight;
    const pinballBeam = Beam.new(pinballBeamX, pinballBeamY, -Math.PI / 2, [0.95, 0.45, 0.15]);
    pinballBeam.destination = {
      pos: pinball.interior.getPortalPosition(),
      angle: -Math.PI / 2,
      onArrive: (player) => pinball.interior.onEnter(player),
    };
    state.beams.push(pinballBeam);
    pinball.interior.exitPosition = { x: pinballBeamX + pinball.halfWidth * 0.15 };
  };
  if (state.pinballPlanet) addPinballEntryBeam(state.pinballPlanet);

  // Tiled hill terrain inside the sky dome (js/levels/Level1.js).
  {
    const levelData = level1Map;
    const mapWorldWidth = levelData.width * 64;
    const mapWorldHeight = levelData.height * 64;
    const anchorX = dome.pos.x - mapWorldWidth / 2;
    const anchorY = dome.trueSurfaceY() - mapWorldHeight;
    const terrainLevel = TiledTerrain.load(levelData, anchorX, anchorY);

    for (const shape of terrainLevel.shapes) {
      // Tiles jump like the dome's own deck.
      shape.jumpStrength = dome.jumpStrength;
      state.planetoids.push(shape);
    }
    state.tiledLevels = [terrainLevel];
    WaterSystem.init(terrainLevel);

    // Rocks hung on ropes.
    state.ropeRocks = [];
    state.recallables = state.ropeRocks;
    const rocksById = {};
    for (const rock of (terrainLevel.rockSpawns ?? [])) rocksById[rock.id] = rock;
    for (const rope of (terrainLevel.ropeSpawns ?? [])) {
      const rock = rope.holdsId != null ? rocksById[rope.holdsId] : null;
      if (rock) {
        state.ropeRocks.push(RopeRock.new(rope, rock, terrainLevel, dome));
      } else {
        console.log(`main.js: Rope id ${rope.id} holds nothing (its "holds" property names no Rock) — not spawned.`);
      }
    }
    state.lavas = terrainLevel.lavas;

    // Ooombas, snapped down onto the terrain under their Tiled points.
    const OOMBA_RAYCAST_DOWN = 6000;
    state.ooombas = [];
    for (const spawn of (terrainLevel.ooombaSpawns ?? [])) {
      const g = groundBelow(terrainLevel.shapes, spawn.x, spawn.y, OOMBA_RAYCAST_DOWN);
      if (g) {
        const arcPos = g.shape.arcPositionForWorldPoint(spawn.x, spawn.y);
        const direction = rnd() < 0.5 ? -1 : 1;
        state.ooombas.push(Ooomba.new(g.shape, arcPos, { direction }));
      }
    }

    // Spheres (and their Ooombas), registered by Tiled id for Spikey-Orbits.
    const entitiesById = {};
    for (const spawn of (terrainLevel.sphereSpawns ?? [])) {
      const sphere = Sphere.new(spawn.x, spawn.y, spawn.radius);
      state.planetoids.push(sphere);
      if (spawn.id != null) entitiesById[spawn.id] = sphere;

      if (spawn.gravityRadius != null) {
        if (spawn.gravityRadius > sphere.radius) {
          sphere.influenceRadius = spawn.gravityRadius;
        } else {
          console.log(`main.js: Sphere at (${Math.round(spawn.x)}, ${Math.round(spawn.y)}) has gravity=${spawn.gravityRadius}, which is not beyond its own radius of ${sphere.radius} — ignored.`);
        }
      }

      if ((spawn.ooombaCount ?? 0) > 0) {
        const direction = rnd() < 0.5 ? -1 : 1;
        const firstAngle = rnd() * Math.PI * 2;
        for (let i = 0; i < spawn.ooombaCount; i++) {
          const angle = firstAngle + i / spawn.ooombaCount * Math.PI * 2;
          state.ooombas.push(Ooomba.newOnPlanet(sphere, angle, { direction }));
        }
      }
    }

    for (const spawn of (terrainLevel.sphereMoveSpawns ?? [])) {
      state.planetoids.push(SphereMove.new(
        spawn.x, spawn.y, spawn.startX, spawn.startY, spawn.endX, spawn.endY, null, spawn.speed));
    }

    // Spikeys: lethal obstacles, in their own list.
    state.spikeys = [];
    for (const spawn of (terrainLevel.spikeySpawns ?? [])) {
      const spikey = Spikey.new(spawn.x, spawn.y);
      state.spikeys.push(spikey);
      if (spawn.id != null) entitiesById[spawn.id] = spikey;
    }

    // Spikey-Vertical: bounded by walls (from TiledTerrain) or Spikeys in
    // the same column.
    const SPIKEY_VERTICAL_RADIUS = Spikey.DEFAULT_RADIUS;
    for (const spawn of (terrainLevel.spikeyVerticalSpawns ?? [])) {
      let topY = spawn.topY, bottomY = spawn.bottomY;
      for (const other of state.spikeys) {
        if (Math.abs(other.pos.x - spawn.x) < other.radius + SPIKEY_VERTICAL_RADIUS) {
          if (other.pos.y < spawn.y) {
            const bound = other.pos.y + other.radius + SPIKEY_VERTICAL_RADIUS;
            topY = topY != null ? Math.max(topY, bound) : bound;
          } else if (other.pos.y > spawn.y) {
            const bound = other.pos.y - other.radius - SPIKEY_VERTICAL_RADIUS;
            bottomY = bottomY != null ? Math.min(bottomY, bound) : bound;
          }
        }
      }
      if (topY != null && bottomY != null && bottomY > topY) {
        state.spikeys.push(SpikeyVertical.new(spawn.x, topY, bottomY, SPIKEY_VERTICAL_RADIUS, spawn.speed));
      } else {
        console.log(`main.js: Spikey-Vertical at (${spawn.x.toFixed(1)}, ${spawn.y.toFixed(1)}) found no wall or nearby Spikey to bound it on one side (topY=${topY}, bottomY=${bottomY}) — not spawned.`);
      }
    }

    // Spikey-Orbit: circles whatever entity its "orbit" property names.
    for (const spawn of (terrainLevel.spikeyOrbitSpawns ?? [])) {
      const center = spawn.orbitId != null ? entitiesById[spawn.orbitId] : null;
      if (center) {
        state.spikeys.push(SpikeyOrbit.new(spawn.x, spawn.y, center, Spikey.DEFAULT_RADIUS, spawn.speed));
      } else {
        console.log(`main.js: Spikey-Orbit at (${spawn.x.toFixed(1)}, ${spawn.y.toFixed(1)}) names orbit id ${spawn.orbitId}, which isn't a spawned Sphere/Spikey — not spawned.`);
      }
    }

    state.mirrors = [];
    for (const spawn of (terrainLevel.mirrorSpawns ?? [])) {
      const mirror = Mirror.new(spawn.x, spawn.y, spawn.angle);
      state.mirrors.push(mirror);
      if (spawn.id != null) entitiesById[spawn.id] = mirror;
    }

    state.levers = [];
    for (const spawn of (terrainLevel.leverSpawns ?? [])) {
      const g = groundBelow(terrainLevel.shapes, spawn.x, spawn.y, OOMBA_RAYCAST_DOWN);
      if (g) {
        const lever = Lever.new(g.hit.point.x, g.hit.point.y);
        lever.gateId = spawn.gateId;
        state.levers.push(lever);
      }
    }

    state.cranks = [];
    for (const spawn of (terrainLevel.crankSpawns ?? [])) {
      const g = groundBelow(terrainLevel.shapes, spawn.x, spawn.y, OOMBA_RAYCAST_DOWN);
      if (g) {
        const crank = Crank.new(g.hit.point.x, g.hit.point.y);
        crank.mirrorId = spawn.mirrorId;
        crank.mirror = spawn.mirrorId != null ? (entitiesById[spawn.mirrorId] ?? null) : null;
        state.cranks.push(crank);
      }
    }

    state.signs = [];
    for (const spawn of (terrainLevel.signSpawns ?? [])) {
      const g = groundBelow(terrainLevel.shapes, spawn.x, spawn.y, OOMBA_RAYCAST_DOWN);
      if (g) state.signs.push(Sign.new(g.hit.point.x, g.hit.point.y, spawn.message));
    }

    state.zoomWindows = terrainLevel.zoomWindows ?? [];

    // Death zones: their respawn point is stood on the ground just below.
    const RESPAWN_SEARCH_UP = 64, RESPAWN_SEARCH_DOWN = 200;
    state.deathZones = terrainLevel.deathZones ?? [];
    for (const zone of state.deathZones) {
      let bestY = null;
      for (const shape of terrainLevel.shapes) {
        if (shape.isWallClimb) continue;
        const hit = shape.findLandingCrossing(
          zone.respawnX, zone.respawnY - RESPAWN_SEARCH_UP, zone.respawnX, zone.respawnY + RESPAWN_SEARCH_DOWN);
        if (hit && (bestY == null || hit.point.y < bestY)) bestY = hit.point.y;
      }
      if (bestY != null) zone.respawnY = bestY - constants.PLAYER_RADIUS - 1;
    }

    // Gates: in both the level's walls (collision) and state.gates.
    state.gates = [];
    const gatesByTiledId = {};
    for (const spawn of (terrainLevel.gateSpawns ?? [])) {
      const gate = Gate.new(spawn.x, spawn.topY, spawn.bottomY, spawn.halfWidth);
      terrainLevel.walls.push(gate);
      state.gates.push(gate);
      if (spawn.id != null) gatesByTiledId[spawn.id] = gate;
    }

    for (const lever of state.levers) {
      if (lever.gateId != null && gatesByTiledId[lever.gateId]) lever.gate = gatesByTiledId[lever.gateId];
    }
  }

  // A sign on the belt-edge landing planet, on its underside.
  if (state.beltLandingPlanet) {
    const planet = state.beltLandingPlanet;
    const SIGN_OFFSET_FROM_SOUTH_POLE = rad(35);
    const signAngle = Math.PI / 2 + SIGN_OFFSET_FROM_SOUTH_POLE;
    const up = Vector2.new(Math.cos(signAngle), Math.sin(signAngle));
    state.signs = state.signs ?? [];
    state.signs.push(Sign.new(
      planet.pos.x + up.x * planet.radius, planet.pos.y + up.y * planet.radius,
      'With so many planets clustered together, consider pressing **TRIANGLE** to slow down time. In this state, you can move the right joystick cursor around to select planets you can pull beam toward using the **L2** button. If you want time to go back to normal, press **TRIANGLE** again',
      { texture: state.signPlanetTexture, up }));
  }

  const topY = dome.trueSurfaceY();
  const doorwayX = state.spaceShelter ? state.spaceShelter.getDoorwayPosition()[0] : dome.pos.x;
  state.player = Player.new(doorwayX, topY - constants.PLAYER_RADIUS);
  state.player.onSurface = true;
  state.player.currentPlanet = dome;
  state.player.lastInfluencePlanet = dome;
  state.player.angle = -Math.PI / 2;
  state.introLocked = true;

  // Where Player.respawn puts him back after dying.
  state.respawnPoint = { x: doorwayX, y: topY - constants.PLAYER_RADIUS, planet: dome };

  // TEMPORARY start points, for testing (all off).
  const TEMP_START_ON_MINING_PLANET = false;
  if (TEMP_START_ON_MINING_PLANET && state.miningPlanet) {
    const planet = state.miningPlanet;
    state.respawnPoint = {
      x: planet.pos.x, y: planet.pos.y - planet.radius - constants.PLAYER_RADIUS,
      planet, followsPlanet: true,
    };
    state.spaceShelter.playerInFront = true;
    state.spaceShelter.introDone = true;
  }

  const TEMP_START_ON_FISHERMAN_RECT = false;
  if (TEMP_START_ON_FISHERMAN_RECT && state.roundedRectPlanet) {
    const rect = state.roundedRectPlanet;
    state.respawnPoint = {
      x: rect.pos.x - rect.halfWidth * 0.4,
      y: rect.pos.y - rect.halfHeight - constants.PLAYER_RADIUS - 20,
    };
    state.spaceShelter.playerInFront = true;
    state.spaceShelter.introDone = true;
  }

  const TEMP_START_IN_PINBALL = false;
  if (TEMP_START_IN_PINBALL && state.pinballPlanet) {
    const portal = state.pinballPlanet.interior.getPortalPosition();
    state.respawnPoint = { x: portal.x, y: portal.y, pinball: state.pinballPlanet.interior };
    state.spaceShelter.playerInFront = true;
    state.spaceShelter.introDone = true;
  }

  // === The galactic expressway (see Cannon.js) ===
  // A loop of track all the way round the sun, with rails at every
  // corner, loop-the-loops, a corkscrew, pinball pockets of bumpers and an
  // asteroid gauntlet; two entry cannons merging onto it, and exits off it
  // (flippers) down to landmarks. He starts on the north entry planet.
  const SHOW_EXPRESSWAY = true;
  if (SHOW_EXPRESSWAY) {
    const ENTRY_PLANET_INSET = 6500;
    const ENTRY_PLANET_RADIUS = 250;
    const CLEAR_LANE_HALF_WIDTH = 500;
    const RAIL_CLEARANCE = 250;
    const [sunX, sunY] = worldGen.sunPos();

    // The ring's corners, clockwise from the top: [degrees round the sun
    // (-90 straight up), distance from the sun].
    const OUTLINE = [
      [-90, 30000], [-62, 34500], [-38, 27500], [-55, 20500], [-6, 22000],
      [10, 33000], [38, 28500], [64, 36000], [92, 31000], [80, 41000],
      [122, 42500], [148, 33000], [172, 26000], [200, 30500], [190, 38500],
      [224, 40000], [248, 32000], [232, 24500], [256, 21500],
    ];
    const corners = OUTLINE.map(([deg, dist]) => {
      const a = rad(deg);
      return [sunX + Math.cos(a) * dist, sunY + Math.sin(a) * dist];
    });
    // (1-based corner numbers, as in the Lua: C(n) = corners[n - 1].
    // Corner n is reached by the straight from corner n-1.)
    const C = (n) => corners[n - 1];
    C(6).loops = 1;
    C(11).loops = 2;
    C(12).gauntlet = true;
    const CORKSCREW_LOOPS = 5;
    C(9).loops = CORKSCREW_LOOPS;
    C(9).loopRadius = 380;
    C(9).loopGap = 300;
    C(9).loopsFirst = true;
    C(9).fling = true;

    // Pinball pockets: bumpers in a zigzag either side of a straight.
    const POCKETS = [
      { from: 2, at: 0.5, count: 5, spacing: 700, spread: 400 },
      { from: 4, at: 0.45, count: 3, spacing: 800, spread: 350 },
      { from: 7, at: 0.5, count: 5, spacing: 700, spread: 400 },
      { from: 13, at: 0.5, count: 7, spacing: 650, spread: 380 },
      { from: 15, at: 0.3, count: 3, spacing: 800, spread: 450 },
      { from: 16, at: 0.55, count: 5, spacing: 700, spread: 420 },
    ];
    // (The south entry's straight, noted before the bumpers renumber things.)
    const southLegA = C(10), southLegB = C(11);

    // (Inserted last straight first, so earlier corner numbers stay put.)
    POCKETS.sort((p, q) => q.from - p.from);
    for (const spec of POCKETS) {
      const a = C(spec.from), b = C(spec.from + 1);
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.sqrt(dx * dx + dy * dy);
      const ux = dx / len, uy = dy / len;
      const nx = -uy, ny = ux;
      const mx = a[0] + dx * spec.at, my = a[1] + dy * spec.at;
      for (let k = spec.count - 1; k >= 0; k--) {
        const along = (k - (spec.count - 1) / 2) * spec.spacing;
        const side = (k % 2 === 0) ? spec.spread : -spec.spread;
        // (Lua's table.insert(corners, from + 1, ...) — 0-based index `from`.)
        corners.splice(spec.from, 0,
          Object.assign([mx + ux * along + nx * side, my + uy * along + ny * side], { bumper: true }));
      }
    }

    const expressway = Cannon.newTrack(corners);
    state.expressway = expressway;
    state.cannons = [expressway];

    // The entries: a planet inside the ring, ENTRY_PLANET_INSET in from the
    // middle of a straight, its cannon merging onto it. -> [planet, cannon]
    const entryPlanets = new Set();
    const makeEntry = (a, b, mountAngle) => {
      const midX = (a[0] + b[0]) / 2, midY = (a[1] + b[1]) / 2;
      let inX = sunX - midX, inY = sunY - midY;
      const inLen = Math.sqrt(inX * inX + inY * inY);
      inX /= inLen; inY /= inLen;
      const planet = Planetoid.new(midX + inX * ENTRY_PLANET_INSET, midY + inY * ENTRY_PLANET_INSET,
        ENTRY_PLANET_RADIUS, [0.5, 0.56, 0.68, 1]);
      planet.isImmovable = true;
      planet.isPermanent = true;
      planet.vel = Vector2.new(0, 0);
      state.planetoids.push(planet);
      entryPlanets.add(planet);
      const cannon = Cannon.new(planet, mountAngle ?? Math.atan2(-inY, -inX), null, [],
        Cannon.trackMergeAt(expressway, midX, midY));
      state.cannons.push(cannon);
      return [planet, cannon];
    };
    const [entryPlanet, entryCannon] = makeEntry(corners[0], corners[1], -Math.PI / 2);
    state.expresswayEntryPlanet = entryPlanet;
    const [southPlanet] = makeEntry(southLegA, southLegB);
    state.expresswaySouthEntryPlanet = southPlanet;

    // The exits (see Cannon.newExit): one to each landmark, leaving from
    // whichever straight gets there shortest with nothing in the way.
    const EXIT_CURVE_RADIUS = 700;
    const EXIT_APPROACH = 2600;
    const EXIT_CLEARANCE = 1600;
    const EXIT_END_MARGIN = 1300;
    const EXIT_LANDMARK_CLEARANCE = 500;
    const EXIT_MAX_TURN = rad(110);
    const EXIT_SAMPLE_STEP = 600;
    const EXIT_TARGETS = [
      { planet: state.beltLandingPlanet },
      { planet: state.roundedRectPlanet, along: -0.3 },
      { planet: state.pinballPlanet, along: 0.3 },
    ];
    const [, beltOuterR] = worldGen.beltRadii();
    const pointSegDist = (x, y, ax, ay, bx, by) => {
      const dx = bx - ax, dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      const t = lenSq > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lenSq)) : 0;
      return Math.sqrt((x - ax - dx * t) ** 2 + (y - ay - dy * t) ** 2);
    };
    const segSegDist = (a, b, c, d) => {
      const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
      if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return 0;
      return Math.min(pointSegDist(a[0], a[1], c[0], c[1], d[0], d[1]), pointSegDist(b[0], b[1], c[0], c[1], d[0], d[1]),
        pointSegDist(c[0], c[1], a[0], a[1], b[0], b[1]), pointSegDist(d[0], d[1], a[0], a[1], b[0], b[1]));
    };
    // How near segment a-b comes to landmark p's outline.
    const segClearance = (p, a, b) => {
      const len = Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
      if (!p.halfWidth) return pointSegDist(p.pos.x, p.pos.y, a[0], a[1], b[0], b[1]) - (p.radius ?? 0);
      const top = p.isSkyDome ? (p.domeRadiusY ?? p.halfWidth) : p.halfHeight;
      let best = Infinity;
      const n = Math.max(1, Math.ceil(len / 100));
      for (let k = 0; k <= n; k++) {
        const u = k / n;
        const x = a[0] + (b[0] - a[0]) * u, y = a[1] + (b[1] - a[1]) * u;
        const ox = Math.max(0, Math.abs(x - p.pos.x) - p.halfWidth);
        const dy = y - p.pos.y;
        const oy = dy < 0 ? Math.max(0, -dy - top) : Math.max(0, dy - p.halfHeight);
        best = Math.min(best, Math.sqrt(ox * ox + oy * oy));
      }
      return best;
    };
    // -> [clear, whatBlocks]
    const exitIsClear = (points, fromI, target) => {
      for (let k = 0; k < points.length - 1; k++) {
        let a = points[k];
        const b = points[k + 1];
        if (k === 0) {
          const len = Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
          const u = Math.min(1, EXIT_CLEARANCE / len);
          a = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
        }
        for (let i = 0; i < expressway.pieces.length; i++) {
          const pc = expressway.pieces[i];
          if (pc.kind === 'line' && i !== fromI && segSegDist(a, b, pc.from, pc.to) < EXIT_CLEARANCE) return [false, 'the expressway itself'];
        }
        for (const rail of expressway.rails) {
          if (pointSegDist(rail.cx, rail.cy, a[0], a[1], b[0], b[1]) < rail.radius + EXIT_CLEARANCE) return [false, 'the expressway itself'];
        }
        for (const bp of expressway.bumpers) {
          if (pointSegDist(bp.x, bp.y, a[0], a[1], b[0], b[1]) < bp.radius + EXIT_CLEARANCE) return [false, 'the expressway itself'];
        }
        if (pointSegDist(sunX, sunY, a[0], a[1], b[0], b[1]) < beltOuterR + 200) return [false, 'the belt'];
        for (const p of state.planetoids) {
          if ((p !== target || k < points.length - 2) && !entryPlanets.has(p) && p.pos
              && segClearance(p, a, b) < EXIT_LANDMARK_CLEARANCE) {
            return [false, `a landmark at (${Math.round(p.pos.x)}, ${Math.round(p.pos.y)})`];
          }
        }
      }
      return [true, null];
    };
    state.expresswayExits = [];
    for (const spec of EXIT_TARGETS) {
      const target = spec.planet;
      if (!target) continue;
      let tail;
      if (target.isRoundedRect) {
        const landX = target.pos.x + (spec.along ?? 0) * target.halfWidth;
        const landY = target.pos.y - target.halfHeight;
        tail = [Object.assign([landX, landY - EXIT_APPROACH], { radius: EXIT_CURVE_RADIUS }), [landX, landY]];
      } else {
        tail = [[target.pos.x, target.pos.y]];
      }
      const aimX = tail[0][0], aimY = tail[0][1];
      let best = null, nearestBlocker = null;
      expressway.pieces.forEach((pc, i) => {
        if (pc.kind !== 'line' || pc.gauntlet) return;
        const dx = pc.dir[0], dy = pc.dir[1];
        const len = Math.sqrt((pc.to[0] - pc.from[0]) ** 2 + (pc.to[1] - pc.from[1]) ** 2);
        for (let s = EXIT_END_MARGIN; s <= len - EXIT_END_MARGIN; s += EXIT_SAMPLE_STEP) {
          const qx = pc.from[0] + dx * s, qy = pc.from[1] + dy * s;
          const points = [[qx, qy], ...tail];
          const length = Math.sqrt((aimX - qx) ** 2 + (aimY - qy) ** 2);
          const ox = (aimX - qx) / length, oy = (aimY - qy) / length;
          const tooSharp = Math.acos(Math.max(-1, Math.min(1, ox * dx + oy * dy))) > EXIT_MAX_TURN;
          const fromBelow = target.isRoundedRect && oy < -0.3;
          if (!tooSharp && !fromBelow && (!best || length < best.length)) {
            const [clear, blocker] = exitIsClear(points, i, target);
            if (clear) best = { piece: i, points, length };
            else if (!nearestBlocker || length < nearestBlocker.length) nearestBlocker = { length, what: blocker };
          }
        }
      });
      if (best) {
        const exit = Cannon.newExit(expressway, best.piece, best.points, target);
        state.cannons.push(exit);
        state.expresswayExits.push(exit);
      } else {
        console.log(`main.js: no clear way off the expressway to the landmark at (${Math.round(target.pos.x)}, ${Math.round(target.pos.y)}) — no exit made for it (in the way: ${nearestBlocker ? nearestBlocker.what : 'no straight lines up with it'}).`);
      }
    }

    // Clear lanes down every straight of every route, and round every
    // rail and bumper.
    state.clearLanes = [];
    const isOurs = new Set(entryPlanets);
    const segmentsOf = (cannon) => {
      const route = cannon.points, segs = [];
      for (let i = 0; i < route.length - 1; i++) segs.push([route[i], route[i + 1]]);
      if (cannon.closed) segs.push([route[route.length - 1], route[0]]);
      return segs;
    };
    for (const cannon of state.cannons) {
      if (cannon.ledge) isOurs.add(cannon.ledge);
      for (const s of segmentsOf(cannon)) {
        state.clearLanes.push([s[0][0], s[0][1], s[1][0], s[1][1], CLEAR_LANE_HALF_WIDTH]);
      }
      cannon.clearCircles = [];
      for (const rail of cannon.rails) cannon.clearCircles.push([rail.cx, rail.cy, rail.radius]);
      for (const b of cannon.bumpers) cannon.clearCircles.push([b.x, b.y, b.radius]);
      for (const c of cannon.clearCircles) state.clearLanes.push([c[0], c[1], c[0], c[1], c[2] + RAIL_CLEARANCE]);
    }

    // Sanity check: each route against the sun/belt and every landmark.
    const nearestOnRoute = (cannon, x, y) => {
      let best = Infinity;
      for (const s of segmentsOf(cannon)) {
        const ax = s[0][0], ay = s[0][1], bx = s[1][0], by = s[1][1];
        const dx = bx - ax, dy = by - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
        best = Math.min(best, Math.sqrt((x - (ax + dx * t)) ** 2 + (y - (ay + dy * t)) ** 2));
      }
      for (const c of cannon.clearCircles) {
        const d = Math.sqrt((x - c[0]) ** 2 + (y - c[1]) ** 2) - (c[2] + RAIL_CLEARANCE);
        best = Math.min(best, Math.max(0, d));
      }
      return best;
    };
    const [, beltOuter] = worldGen.beltRadii();
    state.cannons.forEach((cannon, idx) => {
      if (cannon.isExit) return;
      const name = cannon.isTrack ? 'the expressway' : `cannon ${idx + 1}`;
      if (nearestOnRoute(cannon, sunX, sunY) < beltOuter + CLEAR_LANE_HALF_WIDTH) {
        console.log(`main.js: ${name} passes through the asteroid belt or the sun — move one of its corners.`);
      }
      for (const p of state.planetoids) {
        if (isOurs.has(p)) continue;
        const reach = (p.radius ?? Math.max(p.halfWidth ?? 0, p.halfHeight ?? 0)) + CLEAR_LANE_HALF_WIDTH;
        if (nearestOnRoute(cannon, p.pos.x, p.pos.y) < reach) {
          console.log(`main.js: ${name} passes close to a landmark at (${Math.round(p.pos.x)}, ${Math.round(p.pos.y)}).`);
        }
      }
    });

    // true: he starts, and respawns, on the north entry planet beside its
    // cannon, instead of behind the Space Shelter's door on the sky dome
    // (skipping the door-opening intro).
    const START_AT_EXPRESSWAY_ENTRY = false;
    if (START_AT_EXPRESSWAY_ENTRY) {
      const standAngle = entryCannon.mountAngle - 0.45;
      const standDist = entryPlanet.radius + constants.PLAYER_RADIUS;
      state.respawnPoint = {
        x: entryPlanet.pos.x + Math.cos(standAngle) * standDist,
        y: entryPlanet.pos.y + Math.sin(standAngle) * standDist,
        planet: entryPlanet,
      };
      state.spaceShelter.playerInFront = true;
      state.spaceShelter.introDone = true;
    }
  }

  // Missile outposts just past the belt's outer edge.
  const SHOW_MISSILE_OUTPOSTS = true;
  if (SHOW_MISSILE_OUTPOSTS) {
    const [sunX, sunY] = worldGen.sunPos();
    const [beltInner, beltOuter] = worldGen.beltRadii();
    state.outposts = MissileOutpost.createAll(sunX, sunY, beltInner, beltOuter);
    state.clearLanes = state.clearLanes ?? [];
    for (const o of state.outposts) {
      const p = o.planet;
      state.clearLanes.push([p.pos.x, p.pos.y, p.pos.x, p.pos.y, p.radius + 700]);
    }
  }

  // Stream the 3x3 around the house (after the dome exists, so cells
  // steer clear of it).
  worldGen.generateStartingNeighborhood(HOME_CELL_COL, HOME_CELL_ROW);

  state.sun = Sun.new(state.sceneWidth / 2, state.sceneHeight / 2, 1920);

  state.gravitySystem = GravitySystem.new(state.planetoids);

  // The title screen borrows the player until start is pressed.
  TitleScreen.enter(!firstLoad);

  state.visibleWidth = love.graphics.getWidth() / state.zoom;
  state.visibleHeight = love.graphics.getHeight() / state.zoom;
  state.camera = {
    x: state.player.pos.x - state.visibleWidth / 2,
    y: state.player.pos.y - state.visibleHeight / 2,
  };
};

// Plain debris burst: `count` small yellow particles in every direction.
function spawnDebrisParticles(pos, count) {
  for (let k = 0; k < count; k++) {
    const angle = rnd() * Math.PI * 2;
    const speed = rnd() * 4 + 2;
    state.particles.push(Particle.new(pos, Vector2.new(Math.cos(angle) * speed, Math.sin(angle) * speed)));
  }
}

// A prism cluster's last shot: every prism of it explodes, and
// RUBINIUM_PER_CLUSTER pieces of rubinium fly out to him.
const RUBINIUM_PER_CLUSTER = 6;
function breakPrismCluster(prism) {
  const cluster = prism.group.prisms;

  const gone = new Set(cluster);
  for (const p of cluster) {
    const [x, y] = p.pointAlong(0.5);
    state.explosions.push(Explosion.new(x, y));
  }
  for (let i = state.prisms.length - 1; i >= 0; i--) {
    if (gone.has(state.prisms[i])) state.prisms.splice(i, 1);
  }

  const [midX, midY] = cluster[0].pointAlong(0.5);
  spawnDebrisParticles(Vector2.new(midX, midY), 60);
  if (state.audioManager) state.audioManager.playBang('large', Vector2.new(midX, midY));

  for (let k = 0; k < RUBINIUM_PER_CLUSTER; k++) {
    const from = cluster[Math.floor(Math.random() * cluster.length)];
    const [x, y, dirX, dirY] = from.pointAlong(0.2 + rnd() * 0.7);
    state.elementPieces.push(ElementPiece.new('rubinium', x, y, dirX, dirY));
  }
}

// An asteroid that's hit a planetoid or been shot: gone in a bang and a
// burst of debris, splitting into smaller ones (or, when shot, sometimes
// leaving asteroidium instead). planet: what it hit, or null if shot.
const ASTEROID_SPLIT_MIN_RADIUS = 15;
const ASTEROIDIUM_CHANCE = 0.3;
const ASTEROIDIUM_FULL_RADIUS = 45;

function asteroidiumCountFor(radius) {
  let size = (radius - ASTEROID_SPLIT_MIN_RADIUS) / (ASTEROIDIUM_FULL_RADIUS - ASTEROID_SPLIT_MIN_RADIUS);
  size = Math.max(0, Math.min(1, size));
  return lua.random(1 + Math.floor(size * 2), 2 + Math.floor(size * 4 + 0.5));
}

function breakAsteroid(ast, planet) {
  const idx = state.asteroids.indexOf(ast);
  if (idx >= 0) state.asteroids.splice(idx, 1);

  if (state.audioManager) {
    const size = (ast.radius > 30 && 'large') || (ast.radius > 20 && 'medium') || 'small';
    state.audioManager.playBang(size, ast.pos);
  }
  spawnDebrisParticles(ast.pos, 150);
  const tooSmallToSplit = ast.radius < ASTEROID_SPLIT_MIN_RADIUS;
  if (!planet && (tooSmallToSplit || rnd() < ASTEROIDIUM_CHANCE)) {
    const n = asteroidiumCountFor(ast.radius);
    for (let k = 0; k < n; k++) {
      const angle = rnd() * Math.PI * 2;
      const out = rnd() * ast.radius * 0.6;
      state.elementPieces.push(ElementPiece.new('asteroidium',
        ast.pos.x + Math.cos(angle) * out, ast.pos.y + Math.sin(angle) * out, Math.cos(angle), Math.sin(angle)));
    }
    return;
  }
  if (tooSmallToSplit) return;

  let awayAngle = null, baseVel = ast.vel;
  if (planet && planet.radius && !planet.isRoundedRect) {
    awayAngle = Math.atan2(ast.pos.y - planet.pos.y, ast.pos.x - planet.pos.x);
    baseVel = planet.vel ?? ast.vel;
  }

  const pieceCount = ast.radius > 30 ? 3 : 2;
  for (let k = 0; k < pieceCount; k++) {
    const piece = Asteroid.new(ast.pos.x, ast.pos.y, ast.radius / 2);
    const angle = awayAngle != null ? (awayAngle + (rnd() - 0.5) * Math.PI * 0.8) : (rnd() * Math.PI * 2);
    const speed = 2 + rnd() * 3;
    piece.vel = Vector2.new(baseVel.x + Math.cos(angle) * speed, baseVel.y + Math.sin(angle) * speed);
    piece.angle = rnd() * Math.PI * 2;
    piece.angularSpeed = (rnd() * 2 - 1) * 0.1;
    if (ast.titleDrift) {
      piece.titleDrift = {
        x: piece.vel.x - (ast.vel.x - ast.titleDrift.x),
        y: piece.vel.y - (ast.vel.y - ast.titleDrift.y),
      };
    }
    state.asteroids.push(piece);
  }
  spawnDebrisParticles(ast.pos, 10);
}

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

love.update = function (dt) {
  if (dt > 0) state.fps = (state.fps ?? 0) * 0.9 + (1 / dt) * 0.1;

  gamepadInput.pollGamepad(dt);

  // Paused: nothing below runs at all.
  if (PauseMenu.isOpen()) return;

  // The moment V.A.T.S. ends: unlock, and drop a pull nobody's holding.
  if (state.vatsWasActive && !state.vatsActive && state.player) {
    state.player.clearLockTarget();
    if (state.player.pullTarget && !(state.gamepadPullHeld || love.mouse.isDown(2))) {
      state.player.clearPullTarget();
    }
  }
  state.vatsWasActive = state.vatsActive;

  TitleScreen.update(dt);
  VatsCursor.update(dt);

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

  if (state.ropeRocks) for (const rr of state.ropeRocks) rr.update(state.timeScale);
  if (state.asteroids) for (const a of state.asteroids) a.update();
  if (state.coins) for (const c of state.coins) c.update();

  if (state.ooombas) {
    for (let i = state.ooombas.length - 1; i >= 0; i--) {
      const o = state.ooombas[i];
      o.update();
      if (o.lost) state.ooombas.splice(i, 1);
    }
  }

  if (state.outposts) {
    if (state.titleScreen) MissileOutpost.restock(state.outposts);
    else MissileOutpost.updateAll(state.outposts, state.player);
  }

  if (state.fireBars) for (const bar of state.fireBars) bar.update();

  if (state.lavas) {
    Lava.updateSharedClock();
    for (const lava of state.lavas) lava.update();
  }

  WaterPlanet.updateSharedClock();
  Spikey.updateSharedClock();

  if (state.spikeys) for (const sp of state.spikeys) if (sp.update) sp.update();
  if (state.levers) for (const lever of state.levers) lever.update();
  if (state.cranks) for (const crank of state.cranks) crank.update();
  if (state.signs) for (const sign of state.signs) sign.update();
  if (state.mirrors) for (const mirror of state.mirrors) mirror.update();
  if (state.beams) for (const beam of state.beams) beam.update();
  if (state.gates) for (const gate of state.gates) gate.update(state.timeScale ?? 1);
  if (state.fish) for (const fish of state.fish) fish.update();

  // (The shelter's opening is held while the title screen is up.)
  if (state.spaceShelter && !state.titleScreen) {
    state.spaceShelter.update(dt);
    if (state.introLocked && state.spaceShelter.introDone) state.introLocked = false;
  }

  if (state.robotButler) state.robotButler.update();
  if (state.fisherman) state.fisherman.update();

  if (state.prisms) for (const prism of state.prisms) prism.update(dt * (state.timeScale ?? 1));

  // Rubinium/asteroidium on their way to him.
  for (let i = state.elementPieces.length - 1; i >= 0; i--) {
    const piece = state.elementPieces[i];
    piece.update(dt * (state.timeScale ?? 1), state.player);
    if (piece.collected) {
      state.elements[piece.elementName] += 1;
      if (state.audioManager) state.audioManager.playEatDot();
      state.elementPieces.splice(i, 1);
    }
  }

  state.dialogueActive = !!((state.robotButler && state.robotButler.dialogueActive)
    || (state.fisherman && state.fisherman.dialogueActive)
    || (state.signs ?? []).some((s) => s.dialogueActive));

  const player = state.player;
  if (player.portalTransit) {
    PortalGun.updateTransit(player, state.timeScale);
  } else {
    if (state.titleScreen) {
      player.move(TitleScreen.getKeys());
    } else {
      const noSteering = state.introLocked || player.inPinball || state.vatsActive
        || player.inCannon || player.cannonFlight;
      player.move(noSteering ? {} : state.keys);
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

    for (const cannon of (state.cannons ?? [])) cannon.update(player, state.timeScale);
    Cannon.updateFlight(player, state.timeScale);
    for (const cannon of (state.cannons ?? [])) cannon.updateCoins(player, state.timeScale / 60);

    PortalGun.tryEnter(player);

    if (!player.inPinball && !player.inCannon) collisionSystem.handlePlayerPlanetCollisions(player);

    // Gamepad R2 held: fire (shootFireball throttles itself).
    if (state.gamepadFireHeld && player) player.shootFireball();

    player.touchingWall = null;
    player.wallContactNormal = null;

    if (state.tiledLevels) {
      for (const level of state.tiledLevels) collisionSystem.handlePlayerWallCollisions(player, level.walls);
    }

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
  const collidablePlanetoids = state.planetoids.filter(
    (p) => !p.isBeltPlanetoid || utils.isOnScreen(p.pos.x, p.pos.y, p.radius, 50));

  collisionSystem.handleElasticCollisions(collidablePlanetoids);

  {
    const immovablePlanetoids = collidablePlanetoids.filter((p) => p.isImmovable);
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
    for (const [asteroid, planet] of toBreak) breakAsteroid(asteroid, planet);
  }

  if (state.coins) collisionSystem.handleCoinCollisions(player, state.coins);

  PortalGun.update(dt);
  WaterSystem.update(dt);

  if (state.fireballs) {
    removeWhere(state.fireballs, (f) => { f.update(); return f.isDead(); });

    PortalGun.passFireballs(state.fireballs, state.timeScale);

    removeWhere(state.fireballs, (f) => WaterSystem.quenchFireball(f));

    if (state.fireballs.length > 0) {
      const boom = (x, y) => {
        state.explosions.push(Explosion.new(x, y));
        if (state.audioManager) state.audioManager.playFireball();
      };
      const reflected = state.mirrors ? collisionSystem.handleFireballMirrorCollisions(state.fireballs, state.mirrors) : new Set();

      if (state.prisms) {
        for (let i = state.fireballs.length - 1; i >= 0; i--) {
          const f = state.fireballs[i];
          const prism = !reflected.has(f) && Prism.findAt(state.prisms, f.pos.x, f.pos.y, f.radius);
          if (prism) {
            const shattered = prism.hit();
            boom(f.pos.x, f.pos.y);
            state.fireballs.splice(i, 1);
            if (shattered) breakPrismCluster(prism);
          }
        }
      }

      if (state.asteroids) {
        const [hitFireballs, toBreakAsteroids, planetHits] = collisionSystem.handleFireballCollisions(
          state.fireballs, collidablePlanetoids, state.asteroids);
        for (const a of toBreakAsteroids) {
          boom(a.pos.x, a.pos.y);
          breakAsteroid(a, null);
        }
        for (const hit of planetHits) {
          if (!reflected.has(hit.fireball)) boom(hit.fireball.pos.x, hit.fireball.pos.y);
        }
        removeWhere(state.fireballs, (f) => hitFireballs.has(f) && !reflected.has(f));
      }

      if (state.tiledLevels && state.fireballs.length > 0) {
        const hitWallFireballs = new Set();
        for (const level of state.tiledLevels) {
          for (const f of collisionSystem.handleFireballWallCollisions(state.fireballs, level.walls)) hitWallFireballs.add(f);
        }
        removeWhere(state.fireballs, (f) => {
          if (hitWallFireballs.has(f) && !reflected.has(f)) { boom(f.pos.x, f.pos.y); return true; }
          return false;
        });
      }

      if (state.levers && state.fireballs.length > 0) {
        const hitLeverFireballs = collisionSystem.handleFireballLeverCollisions(state.fireballs, state.levers);
        removeWhere(state.fireballs, (f) => {
          if (hitLeverFireballs.has(f) && !reflected.has(f)) { boom(f.pos.x, f.pos.y); return true; }
          return false;
        });
      }

      if (state.ooombas && state.ooombas.length > 0 && state.fireballs.length > 0) {
        const [hitOoombaFireballs, killedOoombas] = collisionSystem.handleFireballOoombaCollisions(state.fireballs, state.ooombas);
        removeWhere(state.ooombas, (o) => {
          if (killedOoombas.has(o)) { boom(o.pos.x, o.pos.y); return true; }
          return false;
        });
        removeWhere(state.fireballs, (f) => hitOoombaFireballs.has(f));
      }
    }
  }

  if (state.explosions) removeWhere(state.explosions, (e) => { e.update(); return e.isDead(); });
  if (state.wallContactPulses) removeWhere(state.wallContactPulses, (w) => { w.update(); return w.isDead(); });
  if (state.particles) removeWhere(state.particles, (p) => { p.update(); return p.life <= 0; });

  BeltOrbit.apply(state.planetoids);

  if (state.sun) state.sun.update();

  state.cellCheckCounter = (state.cellCheckCounter ?? 0) + 1;
  if (state.cellCheckCounter >= worldGen.CELL_CHECK_INTERVAL) {
    state.cellCheckCounter = 0;
    worldGen.updateActiveCells();
  }

  state.beltSpawnCounter = (state.beltSpawnCounter ?? 0) + 1;
  if (state.beltSpawnCounter >= worldGen.BELT_SPAWN_INTERVAL) {
    state.beltSpawnCounter = 0;
    worldGen.updateBeltSpawning();
  }

  // Manual zoom (ignored while a scripted camera is directing).
  if (!CameraDirector.isActive()) {
    if (state.keys['+'] || state.keys['=']) {
      state.zoom = Math.min(ZOOM_MAX, state.zoom + ZOOM_STEP_PER_FRAME);
      state.zoomTarget = null;
    }
    if (state.keys['-'] || state.keys['_']) {
      state.zoom = Math.max(ZOOM_MIN, state.zoom - ZOOM_STEP_PER_FRAME);
      state.zoomTarget = null;
    }
  }

  // Zoom windows: entering one eases to its zoom; leaving eases back.
  let insideWindow = null;
  const px = player.pos.x, py = player.pos.y;
  for (const w of (state.zoomWindows ?? [])) {
    if (px >= w.x && px <= w.x + w.width && py >= w.y && py <= w.y + w.height) { insideWindow = w; break; }
  }
  if (insideWindow !== state.activeZoomWindow) {
    const previous = state.activeZoomWindow;
    if (insideWindow) {
      if (!previous) state.zoomWindowReturn = state.zoomTarget ?? state.zoom;
      state.zoomTarget = insideWindow.zoom;
    } else if (state.zoomWindowReturn != null) {
      if (state.zoomTarget === previous.zoom || Math.abs(state.zoom - previous.zoom) < ZOOM_WINDOW_SNAP) {
        state.zoomTarget = state.zoomWindowReturn;
      }
      state.zoomWindowReturn = null;
    }
    state.activeZoomWindow = insideWindow;
  }

  // A cannon shot: ease all the way out for the journey, then back.
  const cannonFlying = player.cannonFlight != null;
  if (cannonFlying !== (state.cannonZoomFlying ?? false)) {
    if (cannonFlying) {
      state.cannonZoomReturn = state.zoomTarget ?? state.zoom;
      state.zoomTarget = ZOOM_MIN;
    } else if (state.cannonZoomReturn != null) {
      state.zoomTarget = state.cannonZoomReturn;
      state.cannonZoomReturn = null;
    }
    state.cannonZoomFlying = cannonFlying;
  }

  if (!CameraDirector.isActive() && state.zoomTarget == null && state.zoom < ZOOM_MIN) state.zoomTarget = ZOOM_MIN;

  if (state.zoomTarget != null && !CameraDirector.isActive()) {
    const target = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, state.zoomTarget));
    state.zoom += (target - state.zoom) * ZOOM_WINDOW_EASE_PER_FRAME;
    if (Math.abs(target - state.zoom) < ZOOM_WINDOW_SNAP) {
      state.zoom = target;
      state.zoomTarget = null;
    }
  }

  // The camera: CameraDirector's, or centered on him (gliding after a portal).
  if (!CameraDirector.update(state.timeScale)) {
    const zoom = state.zoom;
    const visibleWidth = love.graphics.getWidth() / zoom;
    const visibleHeight = love.graphics.getHeight() / zoom;
    const transit = player.portalTransit;
    // (The trip's camera point is only set from its first update on.)
    let focusX = (transit && transit.cameraX != null) ? transit.cameraX : player.pos.x;
    let focusY = (transit && transit.cameraY != null) ? transit.cameraY : player.pos.y;
    if (transit && !state.portalCameraGlide) {
      const prev = state.camera;
      state.portalCameraGlide = prev
        ? { x: prev.x + visibleWidth / 2, y: prev.y + visibleHeight / 2 }
        : { x: focusX, y: focusY };
    }
    const glide = state.portalCameraGlide;
    if (glide && transit) {
      const apart = Math.sqrt((transit.to.x - transit.from.x) ** 2 + (transit.to.y - transit.from.y) ** 2);
      const t = Math.min(1, apart / PORTAL_CAMERA_GLIDE_FAR_DISTANCE);
      glide.rate = PORTAL_CAMERA_GLIDE_RATE_MIN + (PORTAL_CAMERA_GLIDE_RATE_MAX - PORTAL_CAMERA_GLIDE_RATE_MIN) * t;
    }
    if (glide) {
      const catchUp = 1 - Math.exp(-(glide.rate ?? PORTAL_CAMERA_GLIDE_RATE_MAX) * Math.min(dt, 1 / 30));
      glide.x += (focusX - glide.x) * catchUp;
      glide.y += (focusY - glide.y) * catchUp;
      if (!transit && (focusX - glide.x) ** 2 + (focusY - glide.y) ** 2 < PORTAL_CAMERA_SETTLED ** 2) {
        state.portalCameraGlide = null;
      } else {
        focusX = glide.x; focusY = glide.y;
      }
    }
    const camera = { x: focusX - visibleWidth / 2, y: focusY - visibleHeight / 2 };
    const maxCameraX = state.sceneWidth - visibleWidth;
    const maxCameraY = state.sceneHeight - visibleHeight;
    camera.x = maxCameraX > 0 ? Math.min(Math.max(camera.x, 0), maxCameraX) : maxCameraX / 2;
    camera.y = maxCameraY > 0 ? Math.min(Math.max(camera.y, 0), maxCameraY) : maxCameraY / 2;
    state.camera = camera;
  }

  state.visibleWidth = love.graphics.getWidth() / state.zoom;
  state.visibleHeight = love.graphics.getHeight() / state.zoom;
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

  if (state.skyDomePlanet) state.skyDomePlanet.draw();

  // Between the dome's background and foreground hex layers; the door
  // goes over the player once he's stepped out in front of it.
  if (state.spaceShelter) {
    state.spaceShelter.drawBody();
    if (state.spaceShelter.playerInFront) state.spaceShelter.drawDoor();
  }

  if (state.sun) state.sun.draw();

  if (state.asteroids) {
    for (const a of state.asteroids) if (utils.isOnScreen(a.pos.x, a.pos.y, a.radius, 50)) a.draw();
  }

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
  if (state.prisms) {
    for (const m of state.prisms) if (utils.isOnScreen(m.planet.pos.x, m.planet.pos.y, m.reach(), 50)) m.draw();
  }

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

  for (const cannon of (state.cannons ?? [])) {
    cannon.drawRails();
    if (!cannon.isTrack) {
      const [px, py] = cannon.pivot();
      if (utils.isOnScreen(px, py, 400, 50)) cannon.draw();
    }
  }

  Recall.draw();

  if (state.spikeys) {
    for (const sp of state.spikeys) if (utils.isOnScreen(sp.pos.x, sp.pos.y, sp.radius, 50)) sp.draw();
  }

  if (state.tiledLevels) {
    CharacterShadows.prepare();
    TileGlow.prepare();
    for (const level of state.tiledLevels) {
      if (!utils.isOnScreen(level.pos.x, level.pos.y, level.radius, 50)) continue;
      level.draw();
      CharacterShadows.drawOnto(level);
      TileGlow.drawOnto(level);
      if (state.showCollisionDebug) {
        g.setLineWidth(4);
        g.setColor(1, 0, 0, 1);
        for (const shape of level.shapes) {
          if (shape.isWallClimb) continue;
          for (const seg of shape.segments) g.line(seg.a.x, seg.a.y, seg.b.x, seg.b.y);
        }
        g.setColor(0.2, 0.6, 1, 1);
        for (const wall of (level.walls ?? [])) {
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

  if (state.ropeRocks) {
    for (const rr of state.ropeRocks) if (utils.isOnScreen(rr.pos.x, rr.pos.y, rr.radius + rr.ropeLength, 50)) rr.draw();
  }

  if (state.gates) {
    for (const gate of state.gates) {
      if (utils.isOnScreen(gate.pos.x, gate.pos.y, Math.max(gate.halfWidth, gate.halfHeight), 20)) gate.draw();
    }
  }
  for (const list of [state.levers, state.cranks, state.signs]) {
    for (const thing of (list ?? [])) {
      if (utils.isOnScreen(thing.pos.x, thing.pos.y, 80, 20)) { thing.draw(); thing.drawTooltip(); }
    }
  }
  if (state.mirrors) {
    for (const mirror of state.mirrors) if (utils.isOnScreen(mirror.pos.x, mirror.pos.y, 80, 20)) mirror.draw();
  }

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

  if (state.ooombas) {
    state.ooombas.forEach((o, i) => {
      if (o.portalTransit || utils.isOnScreen(o.pos.x, o.pos.y, Math.max(o.halfWidth, o.halfHeight), 20)) {
        PortalGun.drawOoomba(o);
        CharacterShadows.drawOntoOoomba(i);
      }
    });
  }

  MissileOutpost.drawMissiles();

  if (state.robotButler) {
    const r = state.robotButler;
    if (utils.isOnScreen(r.pos.x, r.pos.y, Math.max(r.halfWidth, r.halfHeight), 20)) { r.draw(); r.drawTooltip(); }
  }
  if (state.fisherman) {
    const f = state.fisherman;
    if (utils.isOnScreen(f.pos.x, f.pos.y, f.drawBoundRadius, 20)) { f.draw(); f.drawTooltip(); }
  }

  if (state.coins) {
    for (const c of state.coins) if (utils.isOnScreen(c.pos.x, c.pos.y, c.radius, 20)) c.draw();
  }

  if (state.fireBars) {
    for (const bar of state.fireBars) {
      if (utils.isOnScreen(bar.pos.x, bar.pos.y, bar.barLength + bar.fireballRadius, 50)) bar.draw();
    }
  }

  if (state.beams) {
    for (const beam of state.beams) {
      if (utils.isOnScreen(beam.pos.x, beam.pos.y, Beam.LENGTH, 60)) { beam.draw(); beam.drawTooltip(); }
    }
  }

  PortalGun.draw();

  Cannon.drawFlightTrail(state.player);
  PortalGun.drawPlayer(state.player);

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

  if (state.fish) {
    for (const fish of state.fish) if (utils.isOnScreen(fish.pos.x, fish.pos.y, 70, 50)) fish.draw();
  }

  // Lava and water over the player, so he reads as in them.
  if (state.lavas) {
    for (const lava of state.lavas) if (utils.isOnScreen(lava.pos.x, lava.pos.y, lava.radius, 50)) lava.draw();
  }

  WaterSystem.drawOceans();

  state.player.drawBubbles();
  if (state.fish) for (const fish of state.fish) fish.drawBubbles();

  if (state.spaceShelter && !state.spaceShelter.playerInFront) state.spaceShelter.drawDoor();

  PullBeam.draw();

  if (state.fireballs) for (const f of state.fireballs) f.draw();
  if (state.particles) for (const p of state.particles) p.draw();
  for (const piece of state.elementPieces) {
    if (utils.isOnScreen(piece.pos.x, piece.pos.y, piece.radius, 50)) piece.draw();
  }
  if (state.explosions) for (const e of state.explosions) e.draw();
  if (state.wallContactPulses) for (const p of state.wallContactPulses) p.draw();

  if (state.skyDomePlanet) state.skyDomePlanet.drawForegroundGlass();

  VatsOverlay.draw();
  LockOutline.draw();

  g.pop();

  Cannon.drawSpeedLines(state.player);

  VatsCursor.drawReticle();

  if (state.robotButler) state.robotButler.drawDialogue();
  if (state.fisherman) state.fisherman.drawDialogue();
  if (state.signs) for (const sign of state.signs) sign.drawDialogue();

  // Title screen: just the scene and its own prompt.
  if (state.titleScreen) {
    TitleScreen.draw();
    return;
  }

  if (state.minimap) state.minimap.draw();

  const cell = worldGen.cellCoordFor(state.player.pos.x, state.player.pos.y);

  g.setColor(1, 1, 1, 1);
  g.print(`Level ${state.level} - Score: ${state.score}`, 20, 20);
  g.print(`FPS: ${(state.fps ?? 0).toFixed(1)}`, 20, 40);
  g.print(`Zoom: ${state.zoom.toFixed(1)}x (+/-)`, 20, 60);
  g.print(`Cell: (${cell.col}, ${cell.row})`, 20, 80);
  g.print(`Planetoids: ${state.planetoids.length}  Coins: ${state.coins ? state.coins.length : 0}  Asteroids: ${state.asteroids ? state.asteroids.length : 0}  FireBars: ${state.fireBars ? state.fireBars.length : 0}`, 20, 100);
  g.print(`Rubinium: ${state.elements.rubinium}  Asteroidium: ${state.elements.asteroidium}`, 20, 120);
  g.print(`Mode: ${WeaponModes.label()} (P / D-pad left-right to switch)`, 20, 140);
  if (state.portalMode) {
    g.print('Left-click / L2: red portal, Right-click / R2: blue portal, Space to jump', 20, 160);
  } else if (state.waterMode) {
    g.print(`Right-click / R2: spray water (${Math.floor(WaterSystem.totalWater() + 0.5)} / ${WaterSystem.waterCap()}), Space to jump (or swim)`, 20, 160);
  } else if (state.recallMode) {
    g.print('Right-click / R2 on a planetoid: rewind it (again to stop), Space to jump', 20, 160);
  } else {
    g.print('Right-click a planet to pull toward it, Space to jump, C to toggle collision debug', 20, 160);
  }

  PauseMenu.draw();

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
    state.camera = { x: camera.x + sx / zoom, y: camera.y + sy / zoom };
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
});

// For poking at the game from the browser console while debugging.
globalThis.__asteroidBob = { state, love, Cannon, PortalGun, WaterSystem };
