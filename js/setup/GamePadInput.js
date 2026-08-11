// js/setup/gamepadInput.js
// pollGamepad(): reads the first connected gamepad's current state and
// translates it into the same shared state the rest of the game
// already reads — state.keys['ArrowLeft']/['ArrowRight'] for walking
// (exactly what Player.move() already checks for keyboard input, so
// that function needed zero changes), a fire-held flag gameLoop checks
// alongside state.mouseDown, state.gamepadAimActive/X/Y for
// Player.js's computeLeftArmAimAngle to read as an aim source,
// state.gamepadIsActiveDevice so that same method knows to default to
// aiming straight ahead (rather than falling back to the mouse) when
// the stick is centered but the player is still clearly using the
// controller, R1/L1/Circle button presses that call straight into
// Player.js's tryLockTargetNext()/tryLockTargetPrevious()/
// clearLockTarget() for the hard-lock system, and Triangle toggling
// state.vatsActive for V.A.T.S. (see game.js's timeScale easing and
// effects/VatsOverlay.js for the rest of that system).
//
// Unlike keyboard/mouse (event-driven — inputHandlers.js just attaches
// listeners once), the Gamepad API has no press/release/move events at
// all for stick or button state — the only way to know the CURRENT
// state is to poll navigator.getGamepads() fresh every single frame.
// That's why this is a function called every frame from gameLoop() in
// game.js, rather than a one-time attachInputHandlers()-style setup
// call the way every other input source in this game works.
import { state } from '../state.js';
import { tryRestartOrAdvance } from './inputHandlers.js';

// Standard gamepad mapping button indices (https://w3c.github.io/gamepad/#remapping).
// IMPORTANT GOTCHA: the spec's button NAMES use Xbox terminology — its
// button index 2 is literally labeled "X" there, but that's Xbox's own
// X button, which sits in the LEFT face-button position (PlayStation's
// Square in that same position). PS5's actual Cross/X button sits in
// the BOTTOM face-button position, which is index 0 in the standard
// mapping regardless of controller brand. Getting this backwards is a
// very easy, very common mistake.
const BUTTON_X_CROSS = 0;
const BUTTON_CIRCLE = 1;
const BUTTON_SQUARE = 2;
const BUTTON_TRIANGLE = 3;
const BUTTON_R2 = 7;
const BUTTON_L2 = 6;
const BUTTON_R1 = 5;
const BUTTON_L1 = 4;
const BUTTON_DPAD_UP = 12;
const BUTTON_DPAD_DOWN = 13;

const STICK_DEADZONE = 0.2; // ignore small stick drift near center, on both sticks

// Tracked across frames so the X button's jump can be edge-triggered
// (fires once per press, not once per frame it's held) — gamepad
// buttons are polled, not events, so detecting "just pressed this
// frame" (this frame true, last frame false) has to be done by hand.
let lastXPressed = false;
let lastL2Pressed = false;
let lastR1Pressed = false;
let lastL1Pressed = false;
let lastCirclePressed = false;
let lastTrianglePressed = false;

// Tracked so the left stick can CLEAR state.keys['ArrowLeft']/
// ['ArrowRight'] when released, WITHOUT ever clearing a flag the
// keyboard itself set — only clearing a flag this module itself most
// recently set to true. Without this, an idle/centered stick would
// unconditionally force both flags false every single frame, which
// would silently break keyboard movement entirely the moment any
// gamepad was connected, even if the player never touched it.
let gamepadHeldLeft = false;
let gamepadHeldRight = false;
let gamepadHeldZoomIn = false;
let gamepadHeldZoomOut = false;

export function pollGamepad() {
  const gamepads = navigator.getGamepads();
  // Just the first connected gamepad — this game has no multiplayer or
  // gamepad-selection concept, so "whichever one is first" is a
  // reasonable, simple default.
  const gp = Array.from(gamepads).find(g => g);
  if (!gp) {
    state.gamepadAimActive = false;
    state.gamepadFireHeld = false;
    state.gamepadRunHeld = false;
    state.gamepadIsActiveDevice = false;
    return;
  }

  // On the GAME OVER / level-complete screens, X is the ONLY thing
  // this function should do — walk/fire/pull all need to be skipped
  // entirely here, not just left harmless, since L2 below calls
  // trySelectPullTarget() directly (immediately, not via a flag
  // checked later), which would otherwise still be able to launch the
  // player and set a pull target while these screens are up. Mirrors
  // how the mouse path already behaves: inputHandlers.js's mousedown
  // handler checks tryRestartOrAdvance() FIRST and returns immediately
  // if it did something, before ever reaching the right-click pull
  // logic.
  if (state.gameOver || state.levelComplete) {
    const xPressed = gp.buttons[BUTTON_X_CROSS]?.pressed || false;
    if (xPressed && !lastXPressed) {
      tryRestartOrAdvance();
    }
    lastXPressed = xPressed;
    return;
  }

  // --- Left stick: walk left/right ---
  const leftX = gp.axes[0] || 0;
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

  // --- D-pad up/down: zoom in/out ---
  // Feeds into the SAME state.keys['+']/['-'] flags the keyboard's own
  // zoom keys already set — game.js's gameLoop reads those directly
  // (held-continuous, same ZOOM_STEP_PER_FRAME either way), so this
  // needed zero changes there, same reasoning as the left stick above.
  // Same "only clear a flag this module itself set" bookkeeping too,
  // so an idle D-pad can't stomp on an actual keyboard +/- press.
  const dpadUpPressed = gp.buttons[BUTTON_DPAD_UP]?.pressed || false;
  const dpadDownPressed = gp.buttons[BUTTON_DPAD_DOWN]?.pressed || false;
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

  // --- X (Cross): jump / ground pound ---
  // Mirrors the spacebar's own keydown behavior in inputHandlers.js.
  // (GAME OVER / level-complete restart handling for X lives in the
  // dedicated early branch above instead, not here.)
  const xPressed = gp.buttons[BUTTON_X_CROSS]?.pressed || false;
  if (xPressed && !lastXPressed && state.player && state.player.mode !== "maze") {
    if (state.player.onSurface) state.player.jump();
    else state.player.tryGroundPound();
  }
  lastXPressed = xPressed;

  // --- R2: fire ---
  // A continuous-hold flag, same pattern as state.mouseDown — gameLoop
  // checks this every frame and calls shootFireball(), which already
  // has its own internal cooldown (this.fireCooldown), so holding this
  // down is safe and doesn't need its own rate-limiting here.
  state.gamepadFireHeld = gp.buttons[BUTTON_R2]?.pressed || false;

  // --- Triangle: toggle V.A.T.S. ---
  // Edge-triggered — a press turns it on if off, or off if on (a
  // second Triangle press is the manual "back out without firing"
  // escape hatch; the automatic exits — firing or a successful pull —
  // live inside shootFireball()/trySelectPullTarget() themselves in
  // Player.js, since gamepadInput.js only INITIATES those calls each
  // frame and has no way to know whether they actually succeeded).
  // Only toggleable in "space" mode — locking onto world objects
  // doesn't mean anything inside a maze/platform interior — and forced
  // back off if the player somehow leaves space mode while it's
  // active, so the slowdown/overlay can never persist somewhere it
  // doesn't make sense.
  const trianglePressed = gp.buttons[BUTTON_TRIANGLE]?.pressed || false;
  if (state.player && state.player.mode === "space") {
    if (trianglePressed && !lastTrianglePressed) {
      state.vatsActive = !state.vatsActive;
    }
  } else if (state.vatsActive) {
    state.vatsActive = false;
  }
  lastTrianglePressed = trianglePressed;

  // --- Square: run ---
  // A continuous-hold flag, same pattern as gamepadFireHeld above —
  // read directly by Player.move() to boost walking speed while held,
  // and by spawnWalkDust() to kick up more dust per footstep while
  // running.
  state.gamepadRunHeld = gp.buttons[BUTTON_SQUARE]?.pressed || false;

  // --- R1: hard lock, next (clockwise) ---
  // --- L1: hard lock, previous (counter-clockwise) ---
  // Both edge-triggered — each press cycles to a candidate (see
  // Player.js's tryLockTargetNext/tryLockTargetPrevious and
  // TargetLock.js's selectNextLockTarget/selectPreviousLockTarget),
  // neither is a hold-to-lock button. L1 is the mirror of R1 — in the
  // common case, pressing one then the other undoes the first press.
  const r1Pressed = gp.buttons[BUTTON_R1]?.pressed || false;
  if (r1Pressed && !lastR1Pressed && state.player) {
    state.player.tryLockTargetNext();
  }
  lastR1Pressed = r1Pressed;

  const l1Pressed = gp.buttons[BUTTON_L1]?.pressed || false;
  if (l1Pressed && !lastL1Pressed && state.player) {
    state.player.tryLockTargetPrevious();
  }
  lastL1Pressed = l1Pressed;

  // --- Circle: release lock, and end V.A.T.S. ---
  // A natural dual-purpose "cancel" press — releasing whatever's
  // locked and backing out of V.A.T.S. (if active) are both "never
  // mind" actions, so one button doing both reads as consistent rather
  // than needing a second, separate cancel button.
  const circlePressed = gp.buttons[BUTTON_CIRCLE]?.pressed || false;
  if (circlePressed && !lastCirclePressed && state.player) {
    state.player.clearLockTarget();
    state.vatsActive = false;
  }
  lastCirclePressed = circlePressed;

  // --- L2: pull beam ---
  // Mirrors the mouse's right-click UX exactly: press to initiate a
  // pull (edge-triggered — trySelectPullTarget() does a one-time
  // launch-off-the-surface kick, so this must fire once per press, not
  // every frame it's held), release to let go. Prefers the current
  // hard lock if one's active (this is in fact the main reason the
  // lock system exists — locking on specifically to make pulling more
  // reliable/deliberate than the raycast alone), falling back to
  // whatever the raycast most recently found (state.player.
  // aimTargetObject — the same object the red X would be resting on,
  // were it not suppressed while locked) otherwise. Passed as
  // trySelectPullTarget's explicit-target parameter so this reuses the
  // exact same validation/launch logic the mouse path already has.
  const l2Pressed = gp.buttons[BUTTON_L2]?.pressed || false;
  if (state.player) {
    if (l2Pressed && !lastL2Pressed) {
      state.player.trySelectPullTarget(state.player.lockedTarget || state.player.aimTargetObject);
    } else if (!l2Pressed && lastL2Pressed) {
      state.player.clearPullTarget();
    }
  }
  lastL2Pressed = l2Pressed;

  // --- Right stick: aim ---
  // Stored as a normalized DIRECTION (not a position — sticks don't
  // have one), read by Player.js's computeLeftArmAimAngle as a second-
  // priority aim source (after pullTarget, before the mouse fallback).
  // gamepadAimActive naturally goes true/false as the stick is pushed/
  // released, which is also what Player.js's mouseIdle computation
  // reads to know whether gamepad aim should override the mouse-idle
  // timeout.
  const rightX = gp.axes[2] || 0;
  const rightY = gp.axes[3] || 0;
  const rightMag = Math.hypot(rightX, rightY);
  if (rightMag > STICK_DEADZONE) {
    state.gamepadAimActive = true;
    state.gamepadAimX = rightX / rightMag;
    state.gamepadAimY = rightY / rightMag;
  } else {
    state.gamepadAimActive = false;
  }

  // --- Tracks whether the gamepad is the player's CURRENTLY preferred
  // input device (used more recently than the mouse) ---
  // Broader than gamepadAimActive (which only reflects "is the right
  // stick specifically pushed THIS exact frame") — this stays true
  // across frames where the stick is momentarily centered but the
  // player is still clearly playing with the controller (e.g. walking
  // with the left stick alone). Read by Player.js's
  // computeLeftArmAimAngle to decide whether "stick is centered" should
  // fall back to aiming straight ahead (gamepad play) or to the mouse
  // position (mouse play) — see that method's own comment for why this
  // distinction matters.
  const anyButtonPressed = gp.buttons.some(b => b.pressed);
  const anyStickActive = Math.abs(leftX) > STICK_DEADZONE || rightMag > STICK_DEADZONE;
  if (anyButtonPressed || anyStickActive) {
    state.lastGamepadInputTime = Date.now();
  }
  state.gamepadIsActiveDevice = (state.lastGamepadInputTime || 0) > (state.lastMouseMoveTime || 0);
}