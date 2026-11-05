// js/setup/StartPositions.js
//
// Named places Bob can start at (main.js's START_AT switch) and the debug
// teleport list (T) that jumps him to any of them. (A port of
// lua/setup/StartPositions.lua.)
//
// main.js calls StartPositions.init once the world is built, then
// StartPositions.apply(START_AT). PauseMenu calls openTeleportList on T.

import state from '../state.js';
import constants from '../constants.js';
import Camera from '../systems/Camera.js';
import PauseMenu from '../ui/PauseMenu.js';
import worldGen from './WorldGen.js';

// Set by init: the shelter's own respawn point (before START_AT changes
// it), the expressway's { planet, cannon } entry (null when it isn't
// built), and the Tiled planet map column the 'tiled' start sits over.
let shelterRespawnPoint = null, expresswayEntry = null;
let tiledStartColumn = 0;
let lastTeleport = 0; // the teleport list opens on whichever was picked last

// Each returns a respawn point (see Player.respawn), or null when that
// planet is switched off.
const PLACES = {
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
    const angle = -Math.PI / 2 + (tiledStartColumn + 0.5) / columns * 2 * Math.PI;
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
    return { x: portal.x, y: portal.y, interior: state.pinballPlanet.interior };
  },

  maze() {
    if (!state.mazePlanet) return null;
    const start = state.mazePlanet.interior.getPortalPosition();
    return { x: start.x, y: start.y, interior: state.mazePlanet.interior };
  },

  expressway() {
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

// The teleport list (T), in order.
const TELEPORT_PLACES = [
  { key: 'shelter', label: 'SPACE SHELTER' },
  { key: 'mining', label: 'MINING PLANET' },
  { key: 'fisherman', label: "FISHERMAN'S PLANET" },
  { key: 'cracked', label: 'CRACKED PLANET' },
  { key: 'tiled', label: 'TILED PLANET' },
  { key: 'tunnel', label: 'SKY DOME BALL TUNNEL' },
  { key: 'pinball', label: 'PINBALL TABLE' },
  { key: 'expressway', label: 'EXPRESSWAY' },
  { key: 'maze', label: 'MAZE PLANET' },
];

const StartPositions = {};

// Called by love.load once every planet exists.
//   opts.shelterRespawnPoint  state.respawnPoint as World.build left it
//   opts.expresswayEntry      { planet, cannon }, or null
//   opts.tiledStartColumn     map column for the 'tiled' start (from 0, like Tiled)
StartPositions.init = function (opts) {
  shelterRespawnPoint = opts.shelterRespawnPoint;
  expresswayEntry = opts.expresswayEntry;
  tiledStartColumn = opts.tiledStartColumn ?? 0;
};

// Where `key` would put him right now, or null if that planet is switched off.
function pointFor(key) {
  if (key === 'shelter') return shelterRespawnPoint;
  return PLACES[key]() || null;
}

// Makes `startAt` (a PLACES key, or 'shelter') his start and respawn point.
// If that planet is switched off, he starts at the shelter and the console
// says why.
StartPositions.apply = function (startAt) {
  if (startAt === 'shelter') return;
  const place = PLACES[startAt];
  const point = place ? place() : null;
  if (!point) {
    console.log(`main.js: START_AT = "${startAt}" ${place ? 'but that planet is switched off' : "isn't a known start position"} - starting at the shelter instead.`);
    return;
  }
  state.respawnPoint = point;
  // He isn't waiting behind the shelter door, so skip its intro.
  state.spaceShelter.playerInFront = true;
  state.spaceShelter.introDone = true;
};

// Puts him at `key` straight away. It also becomes his respawn point, so
// dying brings him back to it.
function teleportTo(key) {
  const player = state.player, point = pointFor(key);
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
  // The camera jumps with him, and the world round him is streamed in now
  // rather than up to half a second later.
  state.portalCameraGlide = null;
  state.cannonZoomFlying = null;
  state.cannonZoomReturn = null;
  Camera.pointAtPlayer();
  worldGen.updateActiveCells();
  state.cellCheckTimer = 0;
}

// T: pauses the game with the list of places (see PauseMenu.openList).
StartPositions.openTeleportList = function () {
  const options = TELEPORT_PLACES.map((place) => ({
    label: place.label,
    enabled: pointFor(place.key) != null,
  }));
  PauseMenu.openList('TELEPORT', options, (index) => {
    lastTeleport = index;
    teleportTo(TELEPORT_PLACES[index].key);
  }, lastTeleport);
};

export default StartPositions;
