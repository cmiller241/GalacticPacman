// js/setup/GamePadInput.js
//
// Polled once per frame from love.update (sticks have no "moved" event,
// so everything is polled uniformly and edge-detected against last
// frame). Buttons by POSITION (Xbox names): a = Cross, b = Circle,
// x = Square, y = Triangle. Triggers are analog axes, thresholded.
// Only the first connected gamepad is used.

import love from '../love/index.js';
import state from '../state.js';
import inputHandlers from './InputHandlers.js';
import TitleScreen from '../ui/TitleScreen.js';
import PauseMenu from '../ui/PauseMenu.js';
import PortalGun from '../systems/PortalGun.js';
import WeaponModes from '../systems/WeaponModes.js';
import Recall from '../systems/Recall.js';

const tryRestartOrAdvance = () => inputHandlers.tryRestartOrAdvance();

const BUTTON_X_CROSS = 'a';
const BUTTON_CIRCLE = 'b';
const BUTTON_SQUARE = 'x';
const BUTTON_TRIANGLE = 'y';
const BUTTON_R1 = 'rightshoulder';
const BUTTON_L1 = 'leftshoulder';
const BUTTON_DPAD_UP = 'dpup';
const BUTTON_DPAD_DOWN = 'dpdown';
const BUTTON_DPAD_LEFT = 'dpleft';
const BUTTON_DPAD_RIGHT = 'dpright';
const BUTTON_START = 'start';

const ALL_FACE_AND_SHOULDER_BUTTONS = [
  BUTTON_X_CROSS, BUTTON_CIRCLE, BUTTON_SQUARE, BUTTON_TRIANGLE,
  BUTTON_R1, BUTTON_L1, BUTTON_DPAD_UP, BUTTON_DPAD_DOWN, 'dpleft', 'dpright',
];

const STICK_DEADZONE = 0.2;
const TRIGGER_PRESS_THRESHOLD = 0.5;

// Keyboard equivalent of Square (run), polled here since this
// overwrites state.gamepadRunHeld every frame.
const isShiftHeld = () => love.keyboard.isDown('lshift') || love.keyboard.isDown('rshift');

let lastXPressed = false;
let lastL2Pressed = false;
let lastR2Pressed = false;
let lastDpadLeftPressed = false, lastDpadRightPressed = false;
let lastR1Pressed = false;
let lastL1Pressed = false;
let lastCirclePressed = false;
let lastStartPressed = false;
let lastMenuUp = false;
let lastMenuDown = false;
const MENU_STICK_THRESHOLD = 0.5;
let lastTrianglePressed = false;

let gamepadHeldLeft = false;
let gamepadHeldRight = false;
let gamepadHeldZoomIn = false;
let gamepadHeldZoomOut = false;

const SQUARE_DOUBLE_TAP_SECONDS = 0.3;
let lastSquarePressed = false;
let lastSquareTapTime = null;

function maybeAutoEnterVats() {
  if (state.vatsAutoEnterOnLock && !state.vatsActive && state.player && state.player.mode === 'space') {
    state.vatsActive = true;
  }
}

function interactAll(player) {
  if (state.robotButler) state.robotButler.tryInteract(player);
  if (state.fisherman) state.fisherman.tryInteract(player);
  for (const lever of (state.levers ?? [])) lever.tryInteract(player);
  for (const crank of (state.cranks ?? [])) crank.tryInteract(player);
  for (const sign of (state.signs ?? [])) sign.tryInteract(player);
  for (const beam of (state.beams ?? [])) beam.tryInteract(player);
}

function pollGamepad(dt) {
  const gp = love.joystick.getJoysticks().find((j) => j.isGamepad()) ?? null;

  if (!gp) {
    state.gamepadAimActive = false;
    state.gamepadFireHeld = false;
    state.gamepadSprayHeld = false;
    state.gamepadRunHeld = isShiftHeld();
    state.gamepadIsActiveDevice = false;
    state.gamepadPullHeld = false;
    return;
  }
  const axis = (name) => gp.getGamepadAxis(name) ?? 0;

  if (state.gameOver || state.levelComplete) {
    const xPressed = gp.isGamepadDown(BUTTON_X_CROSS);
    if (xPressed && !lastXPressed) tryRestartOrAdvance();
    lastXPressed = xPressed;
    return;
  }

  // Pause menu.
  const startPressed = gp.isGamepadDown(BUTTON_START);
  const startEdge = startPressed && !lastStartPressed;
  lastStartPressed = startPressed;
  if (PauseMenu.isOpen()) {
    const stickY = axis('lefty');
    const menuUp = gp.isGamepadDown(BUTTON_DPAD_UP) || stickY < -MENU_STICK_THRESHOLD;
    const menuDown = gp.isGamepadDown(BUTTON_DPAD_DOWN) || stickY > MENU_STICK_THRESHOLD;
    if (menuUp && !lastMenuUp) PauseMenu.move(-1);
    if (menuDown && !lastMenuDown) PauseMenu.move(1);
    lastMenuUp = menuUp; lastMenuDown = menuDown;

    const xPressed = gp.isGamepadDown(BUTTON_X_CROSS);
    const circlePressed = gp.isGamepadDown(BUTTON_CIRCLE);
    if (xPressed && !lastXPressed) PauseMenu.confirm();
    else if ((circlePressed && !lastCirclePressed) || startEdge) PauseMenu.close();
    lastXPressed = xPressed; lastCirclePressed = circlePressed;

    state.gamepadAimActive = false;
    state.gamepadFireHeld = false;
    state.gamepadSprayHeld = false;
    state.gamepadRunHeld = false;
    if (xPressed || circlePressed || startPressed || menuUp || menuDown) {
      state.lastGamepadInputTime = love.timer.getTime();
    }
    return;
  }
  if (startEdge && !state.titleScreen) {
    PauseMenu.open();
    lastMenuUp = true; lastMenuDown = true;
    return;
  }

  // Title screen: X starts the game; nothing else does anything.
  if (state.titleScreen) {
    const xPressed = gp.isGamepadDown(BUTTON_X_CROSS);
    if (xPressed && !lastXPressed) TitleScreen.requestStart();
    lastXPressed = xPressed;

    state.gamepadAimActive = false;
    state.gamepadFireHeld = false;
    state.gamepadSprayHeld = false;
    state.gamepadRunHeld = false;
    const stickX = axis('leftx'), stickY = axis('lefty');
    if (gp.isGamepadDown(ALL_FACE_AND_SHOULDER_BUTTONS)
        || Math.abs(stickX) > STICK_DEADZONE || Math.abs(stickY) > STICK_DEADZONE) {
      state.lastGamepadInputTime = love.timer.getTime();
    }
    return;
  }

  const riding = state.player && state.player.isCannonRiding();

  // Left stick: walk left/right.
  const leftX = axis('leftx');
  if (leftX < -STICK_DEADZONE) {
    state.keys['ArrowLeft'] = true;
    gamepadHeldLeft = true;
    if (gamepadHeldRight) { state.keys['ArrowRight'] = false; gamepadHeldRight = false; }
  } else if (leftX > STICK_DEADZONE) {
    state.keys['ArrowRight'] = true;
    gamepadHeldRight = true;
    if (gamepadHeldLeft) { state.keys['ArrowLeft'] = false; gamepadHeldLeft = false; }
  } else {
    if (gamepadHeldLeft) { state.keys['ArrowLeft'] = false; gamepadHeldLeft = false; }
    if (gamepadHeldRight) { state.keys['ArrowRight'] = false; gamepadHeldRight = false; }
  }

  // D-pad up/down: zoom in/out.
  const dpadUpPressed = gp.isGamepadDown(BUTTON_DPAD_UP);
  const dpadDownPressed = gp.isGamepadDown(BUTTON_DPAD_DOWN);
  if (dpadUpPressed) {
    state.keys['+'] = true;
    gamepadHeldZoomIn = true;
  } else if (gamepadHeldZoomIn) {
    state.keys['+'] = false;
    gamepadHeldZoomIn = false;
  }
  if (dpadDownPressed) {
    state.keys['-'] = true;
    gamepadHeldZoomOut = true;
  } else if (gamepadHeldZoomOut) {
    state.keys['-'] = false;
    gamepadHeldZoomOut = false;
  }

  // D-pad left/right: cycle weapon mode.
  const dpadLeftPressed = gp.isGamepadDown(BUTTON_DPAD_LEFT);
  const dpadRightPressed = gp.isGamepadDown(BUTTON_DPAD_RIGHT);
  if (dpadRightPressed && !lastDpadRightPressed && !riding) WeaponModes.cycle(1);
  if (dpadLeftPressed && !lastDpadLeftPressed && !riding) WeaponModes.cycle(-1);
  lastDpadLeftPressed = dpadLeftPressed; lastDpadRightPressed = dpadRightPressed;

  // X (Cross): jump — or the plunger/flippers in the pinball planet.
  const xPressed = gp.isGamepadDown(BUTTON_X_CROSS);
  if (xPressed && !lastXPressed && state.player && !riding) {
    if (state.player.inPinball) {
      state.player.inPinball.triggerJumpAction(state.player);
    } else if (state.player.mode !== 'maze' && !state.introLocked) {
      state.player.pressJump();
    }
  }
  lastXPressed = xPressed;
  state.gamepadJumpHeld = xPressed;

  // R2: fire (or portal / spray / recall, by weapon mode).
  const r2Pressed = axis('triggerright') > TRIGGER_PRESS_THRESHOLD;
  state.gamepadSprayHeld = false;
  if (riding) {
    state.gamepadFireHeld = false;
  } else if (state.portalMode) {
    if (r2Pressed && !lastR2Pressed) PortalGun.fire(state.player, 'blue');
    state.gamepadFireHeld = false;
  } else if (state.waterMode) {
    state.gamepadFireHeld = false;
    state.gamepadSprayHeld = r2Pressed;
  } else if (state.recallMode) {
    if (r2Pressed && !lastR2Pressed) Recall.activate(state.player);
    state.gamepadFireHeld = false;
  } else {
    state.gamepadFireHeld = r2Pressed;
  }
  lastR2Pressed = r2Pressed;

  // Triangle: toggle V.A.T.S. in space, otherwise toggle ball mode.
  const trianglePressed = gp.isGamepadDown(BUTTON_TRIANGLE);
  if (state.player && state.player.mode === 'space') {
    if (trianglePressed && !lastTrianglePressed && !riding) state.vatsActive = !state.vatsActive;
  } else if (state.vatsActive) {
    state.vatsActive = false;
  }
  if (trianglePressed && !lastTrianglePressed && state.player && !riding
      && state.player.mode !== 'space' && state.player.mode !== 'maze' && !state.introLocked) {
    if (state.player.isBall) state.player.exitBallMode(); else state.player.enterBallMode();
  }
  lastTrianglePressed = trianglePressed;

  // Square: run; a quick double tap toggles the morph ball.
  const squarePressed = gp.isGamepadDown(BUTTON_SQUARE);
  state.gamepadRunHeld = squarePressed || isShiftHeld();
  if (squarePressed && !lastSquarePressed) {
    const now = love.timer.getTime();
    if (lastSquareTapTime != null && now - lastSquareTapTime <= SQUARE_DOUBLE_TAP_SECONDS) {
      lastSquareTapTime = null;
      const player = state.player;
      if (player && player.mode !== 'maze' && !player.inPinball && !riding) {
        if (player.isBall) player.exitBallMode();
        else if (!state.introLocked) player.enterBallMode();
      }
    } else {
      lastSquareTapTime = now;
    }
  }
  lastSquarePressed = squarePressed;

  // R1 / L1: hard lock next / previous.
  const r1Pressed = gp.isGamepadDown(BUTTON_R1);
  if (r1Pressed && !lastR1Pressed && state.player && !riding) {
    maybeAutoEnterVats();
    state.player.tryLockTargetNext();
  }
  lastR1Pressed = r1Pressed;

  const l1Pressed = gp.isGamepadDown(BUTTON_L1);
  if (l1Pressed && !lastL1Pressed && state.player && !riding) {
    maybeAutoEnterVats();
    state.player.tryLockTargetPrevious();
  }
  lastL1Pressed = l1Pressed;

  // Circle: release lock, end V.A.T.S., and interact.
  const circlePressed = gp.isGamepadDown(BUTTON_CIRCLE);
  if (circlePressed && !lastCirclePressed && state.player && !riding) {
    state.player.clearLockTarget();
    state.vatsActive = false;
    if (!state.player.isBall) interactAll(state.player);
  }
  lastCirclePressed = circlePressed;

  // L2: pull beam (or red portal in portal mode).
  const l2Pressed = axis('triggerleft') > TRIGGER_PRESS_THRESHOLD;
  if (riding) {
    // (nothing)
  } else if (state.portalMode) {
    if (l2Pressed && !lastL2Pressed) PortalGun.fire(state.player, 'red');
  } else if (state.waterMode || state.recallMode) {
    // (L2 does nothing in these modes for now)
  } else if (state.player) {
    if (l2Pressed && !lastL2Pressed) {
      state.player.trySelectPullTarget(state.player.lockedTarget ?? state.player.aimTargetObject);
    } else if (!l2Pressed && lastL2Pressed && !state.vatsActive) {
      state.player.clearPullTarget();
    }
  }
  lastL2Pressed = l2Pressed;
  state.gamepadPullHeld = l2Pressed && !riding && !state.portalMode && !state.waterMode && !state.recallMode;

  // Right stick: aim (or the V.A.T.S. cursor).
  const rightX = axis('rightx');
  const rightY = axis('righty');
  const rightMag = Math.sqrt(rightX * rightX + rightY * rightY);
  if (rightMag > STICK_DEADZONE) {
    state.gamepadAimActive = true;
    state.gamepadAimX = rightX / rightMag;
    state.gamepadAimY = rightY / rightMag;
    state.gamepadRightStickX = rightX;
    state.gamepadRightStickY = rightY;
  } else {
    state.gamepadAimActive = false;
    state.gamepadRightStickX = 0;
    state.gamepadRightStickY = 0;
  }

  const anyButtonPressed = gp.isGamepadDown(ALL_FACE_AND_SHOULDER_BUTTONS)
    || axis('triggerleft') > TRIGGER_PRESS_THRESHOLD
    || axis('triggerright') > TRIGGER_PRESS_THRESHOLD;
  const anyStickActive = Math.abs(leftX) > STICK_DEADZONE || rightMag > STICK_DEADZONE;
  if (anyButtonPressed || anyStickActive) state.lastGamepadInputTime = love.timer.getTime();
  state.gamepadIsActiveDevice = (state.lastGamepadInputTime ?? 0) > (state.lastMouseMoveTime ?? 0);
}

export default { pollGamepad };
