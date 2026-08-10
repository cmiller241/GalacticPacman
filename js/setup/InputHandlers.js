// js/setup/inputHandlers.js
// attachInputHandlers(): wires up every DOM event listener the game
// responds to — mouse position tracking (for blaster aiming), click
// (fire/pull-select), scroll wheel (zoom), and keyboard (movement,
// jump, ground pound, maze/platform teleport, restart/advance). Split
// out of game.js since this is purely about translating raw browser
// events into state changes or player actions — none of it is part of
// the frame-by-frame simulation loop itself. Called once from game.js
// at startup.
//
// tryRestartOrAdvance lives here (not exported — only ever used by the
// two handlers below it, both of which live in this same file) rather
// than back in game.js, since "what a click or Enter press does on the
// game-over/level-complete screen" is itself just another input
// handler, not simulation logic.
import { state } from '../state.js';
import { MazeInterior } from '../interiors/MazeInterior.js';
import { BeamPlanetoid } from '../world/BeamPlanetoid.js';
import { angleDiff } from '../utils.js';
import { initGame } from './levelSetup.js';

// Shared by the Enter key handler and the mousedown handler below —
// restarts on the game-over screen, advances to the next level on the
// level-complete screen. Returns true if it actually did something, so
// the mousedown handler can skip firing/pulling on the same click that
// triggered a restart.
function tryRestartOrAdvance() {
  if (state.gameOver) {
    state.score = 0;
    state.level = 1;
    initGame();
    return true;
  } else if (state.levelComplete) {
    state.level++;
    initGame();
    state.levelComplete = false;
    return true;
  }
  return false;
}

export function attachInputHandlers() {
  // ----------------------------
  // MOUSE TRACKING (for blaster aiming)
  // Stored in canvas-space (relative to the canvas element). Player.js
  // converts this to world space each frame using state.camera, which
  // gameLoop() keeps up to date.
  // ----------------------------
  state.mouse = { x: state.canvas.width / 2, y: state.canvas.height / 2 };
  // Timestamp of the last actual mousemove event. Since mousemove only
  // fires on real pointer movement, "idle" is simply checked as
  // Date.now() - state.lastMouseMoveTime, no distance threshold needed.
  state.lastMouseMoveTime = Date.now();
  state.canvas.addEventListener('mousemove', (e) => {
    const rect = state.canvas.getBoundingClientRect();
    state.mouse.x = e.clientX - rect.left;
    state.mouse.y = e.clientY - rect.top;
    state.lastMouseMoveTime = Date.now();
  });

  // Hold left mouse button to fire the blaster (continuous fire is
  // handled per-frame in gameLoop via state.mouseDown). We also fire
  // immediately here on mousedown itself, so a quick click always
  // produces at least one shot rather than depending on frame timing.
  //
  // Right mouse button selects/releases a "pull star" target (see
  // Player.trySelectPullTarget/clearPullTarget) — right-clicking a new
  // planet while already pulling something else just switches targets
  // directly, no need to release first. The browser's default right-
  // click context menu is suppressed so it doesn't pop up over the game.
  state.mouseDown = false;
  state.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  state.canvas.addEventListener('mousedown', (e) => {
    if (tryRestartOrAdvance()) return; // clicking the game-over/level-complete screen restarts/advances instead of firing
    if (e.button === 0) {
      state.mouseDown = true;
      if (state.player) state.player.shootFireball();
    } else if (e.button === 2) {
      if (state.player) state.player.trySelectPullTarget();
    }
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) {
      state.mouseDown = false;
    } else if (e.button === 2) {
      if (state.player) state.player.clearPullTarget();
    }
  });

  // Scroll wheel zoom: up zooms in, down zooms out (standard convention —
  // same direction as Google Maps and most other apps). { passive: false }
  // is required for preventDefault() to actually stop the page itself
  // from scrolling — modern browsers default wheel listeners to passive
  // for scroll performance, which silently makes preventDefault a no-op
  // unless explicitly opted out here. Clears zoomTarget too, same as the
  // held +/- keys already do, so scrolling mid-auto-zoom (e.g. during a
  // maze transition) correctly cancels it rather than fighting it.
  //
  // Reads state.zoomMin/zoomMax (set in game.js before this is
  // attached) rather than its own copy of those constants, so the
  // clamp range can only ever come from one place.
  const ZOOM_WHEEL_STEP = 0.08; // per scroll "click" — a fixed step rather than scaling off e.deltaY's raw magnitude, since that varies wildly between mice and trackpads
  state.canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_WHEEL_STEP : ZOOM_WHEEL_STEP;
    state.zoom = Math.max(state.zoomMin, Math.min(state.zoomMax, state.zoom + delta));
    state.zoomTarget = null;
    // Read by Player.js's mouseIdle computation — scrolling rapidly
    // changes zoom without the cursor's screen position actually moving,
    // which makes the computed mouse WORLD position (screen/zoom + cam)
    // jump around, making the aim-tracked arm/head jitter. Suppressing
    // aim-tracking briefly after a scroll avoids that without touching
    // the actual aim math.
    state.lastWheelTime = Date.now();
  }, { passive: false });

  // Keyboard
  window.addEventListener('keydown', (e) => {
    state.keys[e.key] = true;
    if (e.key === ' ') {
      if (state.player.onSurface && state.player.mode != "maze") state.player.jump();
      else if (state.player.mode != "maze") state.player.tryGroundPound();
    }
    if (e.key === 'ArrowDown' && state.player.mode != "maze") {
      if (state.player.onSurface && state.player.currentPlanet instanceof BeamPlanetoid) {
        const diff = angleDiff(state.player.angle, state.player.currentPlanet.beamAngle);
        if (diff < Math.PI / 5) {
          state.player.startTeleport(state.player.currentPlanet.interior instanceof MazeInterior ? "maze" : "platform");
        }
      }
    }
    if (e.key === 'Enter') {
      tryRestartOrAdvance();
    }
  });
  window.addEventListener('keyup', (e) => { state.keys[e.key] = false; });
}