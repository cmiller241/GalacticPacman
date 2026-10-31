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
    if (state.waterMode) return;
    // Ice mode: the left button fires an ice bolt; the right does nothing for now.
    if (state.iceMode) {
      if (button === 1) {
        state.mouseDown = true;
        if (state.player) state.player.shootIceBolt();
      }
      return;
    }
    if (state.recallMode) {
      if (button === 2) Recall.activate(state.player);
      return;
    }
    if (button === 1) {
      state.mouseDown = true;
      if (state.player) state.player.shootFireball();
    } else if (button === 2) {
      if (state.player) state.player.trySelectPullTarget();
    }
  };

  love.mousereleased = function (x, y, button) {
    if (button === 1) {
      state.mouseDown = false;
    } else if (button === 2) {
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

    state.keys[key] = true;

    const riding = state.player && state.player.isCannonRiding();

    if (key === ' ' && !riding) {
      if (state.player && state.player.inPinball) {
        state.player.inPinball.triggerJumpAction(state.player);
      } else if (state.player && state.player.mode !== 'maze' && !state.introLocked) {
        state.player.pressJump();
      }
    }

    // Morph ball: ArrowDown curls up, ArrowUp stands back up.
    if (key === 'ArrowDown' && !isrepeat && !riding && state.player && state.player.mode !== 'maze' && !state.introLocked) {
      state.player.enterBallMode();
    }
    if (key === 'ArrowUp' && !isrepeat && !riding && state.player && state.player.mode !== 'maze') {
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

    // Cycles what the blaster's buttons do (see WeaponModes.js).
    if (key === 'p' && !isrepeat && !riding) WeaponModes.cycle(1);

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
