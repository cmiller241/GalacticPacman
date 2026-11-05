// js/setup/InputHandlers.js
//
// Keyboard and mouse input, wired onto the LÖVE-style callbacks
// (love.mousemoved/mousepressed/mousereleased/wheelmoved/keypressed/
// keyreleased) by attachInputHandlers(), called once from love.load.
//
// state.keys stores JS-style key names ('ArrowLeft', ' ', 'Enter'), the
// same names GamePadInput writes, translated from LÖVE's key names by
// KEY_NAME_MAP. Mouse buttons: 1 left, 2 right, 3 middle. Wheel: positive
// y is scrolling up (LÖVE's convention).

import love from '../love/index.js';
import state from '../state.js';
import TitleScreen from '../ui/TitleScreen.js';
import PauseMenu from '../ui/PauseMenu.js';
import PortalGun from '../systems/PortalGun.js';
import WeaponModes from '../systems/WeaponModes.js';
import Recall from '../systems/Recall.js';
import WorldObjects from '../systems/WorldObjects.js';
import TouchControls from '../ui/TouchControls.js';
import Profiler from '../debug/Profiler.js';

const KEY_NAME_MAP = {
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  space: ' ',
  ' ': ' ',
  return: 'Enter',
};

const toJsStyleKey = (loveKey) => KEY_NAME_MAP[loveKey] ?? loveKey;

const ZOOM_WHEEL_STEP = 0.08;

function attachInputHandlers() {
  state.mouse = { x: love.graphics.getWidth() / 2, y: love.graphics.getHeight() / 2 };
  state.lastMouseMoveTime = love.timer.getTime();

  love.mousemoved = function (x, y) {
    state.mouse.x = x;
    state.mouse.y = y;
    state.lastMouseMoveTime = love.timer.getTime();
  };

  state.mouseDown = false;

  love.mousepressed = function (x, y, button) {
    state.lastKeyboardMouseInputTime = love.timer.getTime();
    if (state.titleScreen) return;
    if (PauseMenu.isOpen()) return;
    if (state.player && state.player.isCannonRiding()) return;
    if (state.portalMode) {
      if (button === 1) PortalGun.fire(state.player, 'red');
      else if (button === 2) PortalGun.fire(state.player, 'blue');
      return;
    }
    // Every other blaster fires with the left button only (see
    // js/systems/WeaponModes.js).
    if (button !== 1 || !state.player) return;
    if (state.fireballMode || state.iceMode) {
      // Fired in love.update, after he's moved this frame (same spot as
      // R2), so the shot leaves from where the muzzle is drawn.
      state.mouseDown = true;
      state.mouseFirePending = true;
    } else if (state.pullBeamMode) {
      state.player.trySelectPullTarget();
    } else if (state.recallMode) {
      Recall.activate(state.player);
    }
    // Water: spraying is held, so it's read each frame instead (see
    // WaterSystem.update).
  };

  // ----------------------------
  // TOUCH (phones and tablets — see js/ui/TouchControls.js)
  // ----------------------------
  love.touchpressed = function (id, x, y) {
    TouchControls.noteTouch();
    // A tap anywhere starts the game from the title screen...
    if (state.titleScreen) {
      TitleScreen.requestStart();
      return;
    }
    // ...and, paused, picks a menu option (or the pause button resumes).
    if (PauseMenu.isOpen()) {
      if (TouchControls.hitsPauseButton(x, y)) PauseMenu.close();
      else PauseMenu.tapAt(x, y);
      return;
    }
    TouchControls.touchpressed(id, x, y);
  };
  love.touchmoved = function (id, x, y) {
    TouchControls.touchmoved(id, x, y);
  };
  love.touchreleased = function (id, x, y) {
    TouchControls.touchreleased(id, x, y);
  };

  love.mousereleased = function (x, y, button) {
    if (button === 1) {
      state.mouseDown = false;
      // Not in V.A.T.S. — same rule as letting go of L2 (see
      // GamePadInput.js's own L2 handling).
      if (state.player && !state.vatsActive) state.player.clearPullTarget();
    }
  };

  love.wheelmoved = function (x, y) {
    if (state.titleScreen) return;
    if (PauseMenu.isOpen()) return;
    const delta = y > 0 ? ZOOM_WHEEL_STEP : -ZOOM_WHEEL_STEP;
    state.zoom = Math.max(state.zoomMin, Math.min(state.zoomMax, state.zoom + delta));
    state.zoomTarget = null;
    state.lastWheelTime = love.timer.getTime();
    state.lastKeyboardMouseInputTime = state.lastWheelTime;
  };

  love.keypressed = function (loveKey, scancode, isrepeat) {
    const key = toJsStyleKey(loveKey);
    state.lastKeyboardMouseInputTime = love.timer.getTime();

    // F3: the frame-time profiler (see js/debug/Profiler.js). Works
    // everywhere, even on the title screen and in the pause menu.
    if (key === 'f3' && !isrepeat) Profiler.toggle();

    // Title screen: Enter, Space or X starts the game; nothing else.
    if (state.titleScreen) {
      if (!isrepeat && (key === 'Enter' || key === ' ' || key === 'x')) TitleScreen.requestStart();
      return;
    }

    // Pause menu: while it's open every key goes to it; Escape opens it.
    if (PauseMenu.isOpen()) {
      if (!isrepeat) PauseMenu.keypressed(key);
      return;
    }
    if (key === 'escape' && !isrepeat) {
      PauseMenu.open();
      return;
    }
    // T: the debug teleport list (see main.js's own PauseMenu.onTeleportKey).
    if (key === 't' && !isrepeat && PauseMenu.onTeleportKey) {
      PauseMenu.onTeleportKey();
      return;
    }

    state.keys[key] = true;

    const riding = state.player && state.player.isCannonRiding();

    if (key === ' ' && !riding) {
      if (state.player && state.player.inInterior) {
        state.player.inInterior.triggerJumpAction(state.player);
      } else if (state.player && !state.introLocked) {
        state.player.pressJump();
      }
    }

    // Morph ball: ArrowDown curls up, ArrowUp stands back up (inside a
    // planet he stays a ball).
    if (key === 'ArrowDown' && !isrepeat && !riding && state.player && !state.introLocked) {
      state.player.enterBallMode();
    }
    if (key === 'ArrowUp' && !isrepeat && !riding && state.player) {
      state.player.exitBallMode();
    }

    // Interact: NPCs, levers, cranks, signs, beams (see WorldObjects.interact).
    if (key === 'Enter' && !riding) WorldObjects.interact(state.player);

    if (key === 'c' && !isrepeat) state.showCollisionDebug = !state.showCollisionDebug;

    // Turns the dirt planet he's on or near: N clockwise, M
    // counter-clockwise; the same key again stops it (see
    // CrackedPlanetoid.toggleSpin).
    if ((key === 'n' || key === 'm') && !isrepeat && state.player) {
      const p = state.player.currentPlanet ?? state.player.lastInfluencePlanet;
      if (p && p.toggleSpin) p.toggleSpin(key === 'n' ? 1 : -1);
    }
    if (key === 'a' && !isrepeat) state.showBeltCellDebug = !state.showBeltCellDebug;
    if (key === 'r' && !isrepeat) state.showInfluenceRings = !state.showInfluenceRings;

    // Tab: the next blaster (see WeaponModes.js, and js/ui/WeaponBar.js
    // for the selector in the lower-left).
    if (key === 'tab' && !isrepeat && !riding) WeaponModes.cycle(1);

    // Switches the gravity of the dirt planet he's on or near: toward
    // its core, straight down, straight up (see
    // CrackedPlanetoid.cycleGravity).
    if (key === 'g' && !isrepeat && state.player) {
      const p = state.player.currentPlanet ?? state.player.lastInfluencePlanet;
      if (p && p.cycleGravity) p.cycleGravity();
    }
  };

  love.keyreleased = function (loveKey) {
    state.keys[toJsStyleKey(loveKey)] = false;
  };
}

export default { attachInputHandlers };
