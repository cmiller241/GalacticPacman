// js/systems/Camera.js
//
// The game camera: where it looks (state.camera — the world point at the
// screen's top-left) and how far it's zoomed in (state.zoom), plus
// state.visibleWidth/visibleHeight, how much of the world fits on screen.
// Port of lua/systems/Camera.lua.
//
// Zoom comes from, in order of who wins: a scripted camera move
// (js/systems/CameraDirector.js, which takes over completely while it
// runs), the +/- keys and mouse wheel, Zoom-Window areas of the Tiled
// level, and a cannon shot (zoomed all the way out for the journey). The
// camera follows the player, gliding over after a trip through a portal.

import love from '../love/index.js';
import state from '../state.js';
import CameraDirector from './CameraDirector.js';

const Camera = {};

Camera.ZOOM_MIN = 0.6;
Camera.ZOOM_MAX = 2.5;
const ZOOM_MIN = Camera.ZOOM_MIN, ZOOM_MAX = Camera.ZOOM_MAX;
const ZOOM_STEP_PER_FRAME = 0.02;
// Zoom easing (zoom windows, cannon shots): fraction of the remaining
// distance to the target zoom covered each frame, and how close counts
// as "arrived".
const ZOOM_WINDOW_EASE_PER_FRAME = 0.03;
const ZOOM_WINDOW_SNAP = 0.002;

// Camera glide after a trip through a portal: quicker the further apart
// the two portals are (MIN for portals touching, MAX for FAR_DISTANCE
// apart or more). SETTLED: how close counts as caught up.
const PORTAL_CAMERA_GLIDE_RATE_MIN = 1;
const PORTAL_CAMERA_GLIDE_RATE_MAX = 8;
const PORTAL_CAMERA_GLIDE_FAR_DISTANCE = 2500;
const PORTAL_CAMERA_SETTLED = 1;

// Back to a new game's camera: no position yet, zoom 1, nothing easing.
Camera.reset = function () {
  state.camera = null;
  state.interiorFramed = false; state.interiorZoomReturn = null;
  state.zoom = 1;
  state.zoomMax = ZOOM_MAX;
  state.zoomMin = ZOOM_MIN;
  state.zoomTarget = null;
  state.activeZoomWindow = null; state.zoomWindowReturn = null;
  state.cannonZoomFlying = null; state.cannonZoomReturn = null;
  state.portalCameraGlide = null;
};

// Centered on the player, straight away (no easing). love.load calls this
// once the player exists: a draw can come before the first update, and
// worldGen streams the world around the camera.
Camera.pointAtPlayer = function () {
  state.visibleWidth = love.graphics.getWidth() / state.zoom;
  state.visibleHeight = love.graphics.getHeight() / state.zoom;
  state.camera = {
    x: state.player.pos.x - state.visibleWidth / 2,
    y: state.player.pos.y - state.visibleHeight / 2,
  };
};

// Once a frame, at the end of love.update, after everything has moved.
// The interior he's in, if it frames itself (the maze's faces: see
// MazeInterior.cameraView), or null.
function framingInterior() {
  const inside = state.player && state.player.inInterior;
  return inside && inside.cameraView ? inside : null;
}

Camera.update = function (dt) {
  const player = state.player;
  const framing = framingInterior();
  // Manual zoom (ignored while a scripted camera is directing, or inside
  // an interior that frames itself: its zoom is set below).
  if (!CameraDirector.isActive() && !framing) {
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

  // Inside an interior that frames itself: eased to its zoom; back to the
  // zoom he had once he's out.
  if (framing) {
    if (state.interiorZoomReturn == null) state.interiorZoomReturn = state.zoomTarget ?? state.zoom;
    state.zoomTarget = framing.cameraView(love.graphics.getWidth(), love.graphics.getHeight())[2];
  } else if (state.interiorZoomReturn != null) {
    state.zoomTarget = state.interiorZoomReturn;
    state.interiorZoomReturn = null;
  }

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
    // Inside an interior that frames itself, it's what's looked at. Going
    // in or coming out, the camera glides over (the same glide as after a
    // portal) rather than cutting.
    if (framing) [focusX, focusY] = framing.cameraView(love.graphics.getWidth(), love.graphics.getHeight());
    if (!!framing !== !!state.interiorFramed) {
      state.interiorFramed = !!framing;
      const prev = state.camera;
      if (prev) state.portalCameraGlide = { x: prev.x + visibleWidth / 2, y: prev.y + visibleHeight / 2 };
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

export default Camera;
