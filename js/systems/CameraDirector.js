// js/systems/CameraDirector.js
//
// Lets a scripted sequence (see Script.js) temporarily take the camera
// away from its normal "always centered on the player" behavior —
// easing to a given world point + zoom, optionally chaining through
// several waypoints, then handing control back with one more eased
// transition onto wherever the player is by then.
//
// Call CameraDirector.update(ts) once per frame, BEFORE main.js's own
// player-centered camera math — it returns true (having already set
// state.camera/state.zoom) while an override is active.

import love from '../love/index.js';
import state from '../state.js';

const CameraDirector = {};

const DEFAULT_RELEASE_DURATION = 1.5;
const RELEASE_ZOOM = 1;
const SCRIPT_ZOOM_MIN = 0.1, SCRIPT_ZOOM_MAX = 2.5;

const clampZoom = (z) => Math.max(SCRIPT_ZOOM_MIN, Math.min(SCRIPT_ZOOM_MAX, z));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (t) => t * t * (3 - 2 * t);

// -> [x, y, zoom]
function currentCenter() {
  const d = state.cameraDirector;
  if (d && d.lastX != null) return [d.lastX, d.lastY, d.lastZoom];
  const zoom = state.zoom ?? 1;
  const cam = state.camera ?? { x: 0, y: 0 };
  const screenW = love.graphics.getWidth(), screenH = love.graphics.getHeight();
  return [cam.x + (screenW / zoom) / 2, cam.y + (screenH / zoom) / 2, zoom];
}

function applyCamera(cx, cy, zoom) {
  zoom = clampZoom(zoom);
  const screenW = love.graphics.getWidth(), screenH = love.graphics.getHeight();
  const visibleWidth = screenW / zoom, visibleHeight = screenH / zoom;
  let camX = cx - visibleWidth / 2, camY = cy - visibleHeight / 2;
  const maxCameraX = (state.sceneWidth ?? 0) - visibleWidth;
  const maxCameraY = (state.sceneHeight ?? 0) - visibleHeight;
  camX = maxCameraX > 0 ? Math.min(Math.max(camX, 0), maxCameraX) : maxCameraX / 2;
  camY = maxCameraY > 0 ? Math.min(Math.max(camY, 0), maxCameraY) : maxCameraY / 2;
  state.camera = { x: camX, y: camY };
  state.zoom = zoom;

  const d = state.cameraDirector;
  if (d) { d.lastX = cx; d.lastY = cy; d.lastZoom = zoom; }
}

function beginNextLeg() {
  const d = state.cameraDirector;
  if (!d) return;
  let nextWaypoint = d.queue.shift();
  if (!nextWaypoint) {
    if (d.mode === 'release') {
      state.cameraDirector = null;
      return;
    } else if (d.loop && d.waypoints && d.waypoints.length > 0) {
      d.queue = d.waypoints.slice();
      nextWaypoint = d.queue.shift();
    } else {
      d.leg = null;
      return;
    }
  }
  d.leg = {
    startX: d.lastX, startY: d.lastY, startZoom: d.lastZoom,
    targetX: nextWaypoint.x, targetY: nextWaypoint.y, targetZoom: nextWaypoint.zoom ?? d.lastZoom,
    duration: nextWaypoint.duration ?? 2,
    elapsed: 0,
  };
}

// waypoints: [{x, y, zoom, duration}, ...]. opts.loop repeats the tour.
CameraDirector.run = function (waypoints, opts) {
  if (!waypoints || waypoints.length === 0) return;
  const [startX, startY, startZoom] = currentCenter();
  state.cameraDirector = {
    mode: 'run',
    queue: waypoints.slice(),
    waypoints,
    loop: opts && opts.loop,
    lastX: startX, lastY: startY, lastZoom: startZoom,
  };
  beginNextLeg();
};

CameraDirector.release = function (duration) {
  const [startX, startY, startZoom] = currentCenter();
  const player = state.player;
  const targetX = player ? player.pos.x : startX;
  const targetY = player ? player.pos.y : startY;
  state.cameraDirector = {
    mode: 'release',
    queue: [],
    lastX: startX, lastY: startY, lastZoom: startZoom,
    leg: {
      startX, startY, startZoom,
      targetX, targetY, targetZoom: RELEASE_ZOOM,
      duration: duration ?? DEFAULT_RELEASE_DURATION,
      elapsed: 0,
    },
  };
};

CameraDirector.isActive = function () {
  return state.cameraDirector != null;
};

CameraDirector.update = function (ts) {
  const d = state.cameraDirector;
  if (!d) return false;

  if (d.leg) {
    const leg = d.leg;
    leg.elapsed += (ts ?? 1) / 60;
    const t = leg.duration > 0 ? Math.min(1, leg.elapsed / leg.duration) : 1;
    const e = smoothstep(t);
    applyCamera(lerp(leg.startX, leg.targetX, e), lerp(leg.startY, leg.targetY, e), lerp(leg.startZoom, leg.targetZoom, e));
    if (t >= 1) beginNextLeg();
  } else {
    applyCamera(d.lastX, d.lastY, d.lastZoom);
  }
  return true;
};

export default CameraDirector;
