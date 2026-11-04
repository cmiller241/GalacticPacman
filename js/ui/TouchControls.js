// js/ui/TouchControls.js
//
// On-screen controls for phones and tablets. They work as a virtual
// gamepad: TouchControls.pad answers the same questions a real one does
// (isGamepadDown, getGamepadAxis), and js/setup/GamePadInput.js reads it
// exactly as it reads a controller whenever no real one is plugged in —
// so every blaster, the pause menu, V.A.T.S. and lock-on all work by
// touch with no separate rules of their own.
//
//   Left thumb:  a move stick that appears wherever the thumb lands on the
//                left side (pushed near its edge, he runs).
//   Right thumb: an aim stick that appears wherever the thumb lands on
//                the right side, away from the buttons. A light push
//                aims; past the inner ring it fires the blaster in use
//                (R2), and its knob shows that blaster's icon.
//   Buttons:     ✕ jump (big, in the corner), ○ interact, △ ball (or
//                V.A.T.S. out in space), pull beam (L2 — the red portal in
//                Portal mode), lock-on (R1), pause, zoom in / out.
//   The weapon bar (top middle while these are showing) switches blaster
//   when a box is tapped.
//
// Shown from the first touch until a key, a mouse click or a real
// controller is used instead. Sizes are in real on-screen sizes (CSS
// pixels), so they're thumb-sized on any screen.

import love from '../love/index.js';
import state from '../state.js';
import WeaponModes from '../systems/WeaponModes.js';
import WeaponBar from './WeaponBar.js';

const TouchControls = {};

// Sizes, in CSS pixels.
const STICK_RADIUS = 58;        // how far the knob travels
const KNOB_RADIUS = 27;
const FIRE_AT = 0.62;           // aim stick pushed this far out (0..1) fires
const RUN_AT = 0.88;            // move stick pushed this far out runs
const DEADZONE = 0.16;
const JUMP_RADIUS = 46;
const SMALL_RADIUS = 29;
const RING = 104;               // the small buttons' distance from the jump button
const CORNER_MARGIN = 26;
const TOP_BUTTON_RADIUS = 21;

// PlayStation face-button colors, to match the button prompts in the game.
const CROSS_COLOR = [0.49, 0.70, 1.0];
const CIRCLE_COLOR = [1.0, 0.42, 0.42];
const TRIANGLE_COLOR = [0.33, 0.86, 0.62];
const ACCENT = [1.0, 0.72, 0.25]; // firing / held highlight

let lastTouchTime = -Infinity;
let everTouched = false;
let triedFullscreen = false;
let layout = null;              // see computeLayout
const fingers = new Map();      // touch id -> what it's holding: { kind, ... }

// The virtual gamepad's current state, written by the touch handlers.
const sticks = {
  move: { active: false, baseX: 0, baseY: 0, x: 0, y: 0, id: null }, // x, y: -1..1
  aim: { active: false, baseX: 0, baseY: 0, x: 0, y: 0, id: null },
};
const held = new Set(); // gamepad button names held by a finger ('a', 'b', 'y', ...)

// ---------------------------------------------------------------------
// The virtual gamepad
// ---------------------------------------------------------------------
TouchControls.pad = {
  isGamepad() { return true; },
  isConnected() { return true; },
  getName() { return 'Touch controls'; },
  isGamepadDown(...buttons) {
    if (buttons.length === 1 && Array.isArray(buttons[0])) buttons = buttons[0];
    return buttons.some((b) => held.has(b));
  },
  getGamepadAxis(axis) {
    const m = sticks.move, a = sticks.aim;
    switch (axis) {
      case 'leftx': return m.active ? m.x : 0;
      case 'lefty': return m.active ? m.y : 0;
      case 'rightx': return a.active ? a.x : 0;
      case 'righty': return a.active ? a.y : 0;
      case 'triggerright': return a.active && Math.hypot(a.x, a.y) >= FIRE_AT ? 1 : 0;
      case 'triggerleft': return held.has('pull') ? 1 : 0;
      default: return 0;
    }
  },
  setVibration() { return false; },
};

// Whether a real controller is plugged in (it wins over the touch one).
function realPadConnected() {
  return love.joystick.getJoysticks().some((j) => j.isGamepad());
}

// Whether the touch controls are the input in use right now.
TouchControls.isActive = function () {
  if (!everTouched || realPadConnected()) return false;
  const other = Math.max(state.lastKeyboardMouseInputTime ?? -Infinity, state.lastMouseMoveTime ?? -Infinity);
  return lastTouchTime >= other;
};

// Pushed near the edge, the move stick runs (see GamePadInput.js).
TouchControls.runHeld = function () {
  const m = sticks.move;
  return m.active && Math.abs(m.x) >= RUN_AT;
};

// ---------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------
// Game units per CSS pixel: the canvas shows a fixed amount of the
// world whatever the screen (see love.boot's minView in main.js).
function unit() {
  return love.graphics.getHeight() / Math.max(1, window.innerHeight);
}

function computeLayout() {
  const g = love.graphics;
  const W = g.getWidth(), H = g.getHeight(), u = unit();
  const jumpX = W - (CORNER_MARGIN + JUMP_RADIUS) * u;
  const jumpY = H - (CORNER_MARGIN + JUMP_RADIUS) * u;
  const polar = (dist, deg) => [jumpX + Math.cos(deg * Math.PI / 180) * dist * u,
    jumpY + Math.sin(deg * Math.PI / 180) * dist * u];
  const [intX, intY] = polar(RING, 180);
  const [ballX, ballY] = polar(RING, 225);
  const [pullX, pullY] = polar(RING, 270);
  const [lockX, lockY] = polar(RING * 1.75, 248);
  const top = (CORNER_MARGIN * 0.6 + TOP_BUTTON_RADIUS) * u;
  const pauseX = W - (CORNER_MARGIN * 0.6 + TOP_BUTTON_RADIUS) * u;
  // The minimap goes below the pause button, down the right edge, and
  // the zoom buttons below it (see MiniMap.draw's state.touchLayout).
  const minimapSize = Math.floor(Math.min(W * 0.13, H * 0.26));
  const minimapY = top + (TOP_BUTTON_RADIUS + 12) * u;
  const zoomY = minimapY + minimapSize + (12 + TOP_BUTTON_RADIUS) * u;
  state.touchLayout = { minimapY, minimapSize, margin: CORNER_MARGIN * 0.6 * u };

  layout = {
    W, H, u,
    buttons: [
      { name: 'jump', pad: 'a', x: jumpX, y: jumpY, r: JUMP_RADIUS * u },
      { name: 'interact', pad: 'b', x: intX, y: intY, r: SMALL_RADIUS * u },
      { name: 'ball', pad: 'y', x: ballX, y: ballY, r: SMALL_RADIUS * u },
      { name: 'pull', pad: 'pull', x: pullX, y: pullY, r: SMALL_RADIUS * u },
      { name: 'lock', pad: 'rightshoulder', x: lockX, y: lockY, r: SMALL_RADIUS * 0.9 * u },
      { name: 'pause', pad: 'start', x: pauseX, y: top, r: TOP_BUTTON_RADIUS * u },
      { name: 'zoomIn', pad: 'dpup', x: pauseX, y: zoomY, r: TOP_BUTTON_RADIUS * u },
      { name: 'zoomOut', pad: 'dpdown', x: pauseX, y: zoomY + (TOP_BUTTON_RADIUS * 2 + 10) * u, r: TOP_BUTTON_RADIUS * u },
    ],
    // Where each stick rests (drawn faintly) before a thumb lands.
    moveHome: [(CORNER_MARGIN + STICK_RADIUS + 20) * u, H - (CORNER_MARGIN + STICK_RADIUS + 10) * u],
    aimHome: [jumpX - (RING + SMALL_RADIUS + STICK_RADIUS + 40) * u, H - (CORNER_MARGIN + STICK_RADIUS + 10) * u],
  };
  return layout;
}

// Which buttons are on screen right now: the pull button only with a
// blaster that has one (or as the red portal), lock-on only out where
// there's something to lock on to.
function buttonShown(b) {
  if (b.name === 'pull') return WeaponModes.canPull() || state.portalMode;
  return true;
}

function buttonAt(x, y) {
  for (const b of layout.buttons) {
    if (!buttonShown(b)) continue;
    // (A little bigger than drawn: fingers aren't precise.)
    const reach = b.r * 1.25;
    if ((x - b.x) ** 2 + (y - b.y) ** 2 <= reach * reach) return b;
  }
  return null;
}

// ---------------------------------------------------------------------
// Touches (from js/setup/InputHandlers.js)
// ---------------------------------------------------------------------
function noteTouch() {
  everTouched = true;
  lastTouchTime = love.timer.getTime();
}
TouchControls.noteTouch = noteTouch;

// Whether the game should talk to this player in taps ("TAP TO START"):
// once touched, while the touch controls are in use; before any input at
// all, if the screen's a touch screen (a phone or tablet).
TouchControls.prefersTouch = function () {
  if (everTouched) return TouchControls.isActive();
  if (realPadConnected() || state.lastKeyboardMouseInputTime != null) return false;
  return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
};

// Whether (x, y) is on the pause button (for resuming by touch: while
// paused, taps go to the menu — see InputHandlers.js).
TouchControls.hitsPauseButton = function (x, y) {
  if (!layout) return false;
  const b = layout.buttons.find((o) => o.name === 'pause');
  return (x - b.x) ** 2 + (y - b.y) ** 2 <= (b.r * 1.3) ** 2;
};

function updateStick(stick, x, y) {
  const R = STICK_RADIUS * layout.u;
  let dx = (x - stick.baseX) / R, dy = (y - stick.baseY) / R;
  const len = Math.hypot(dx, dy);
  if (len > 1) { dx /= len; dy /= len; }
  if (len < DEADZONE) { dx = 0; dy = 0; }
  stick.x = dx; stick.y = dy;
}

function startStick(stick, id, x, y) {
  const R = STICK_RADIUS * layout.u;
  // (Kept wholly on screen, however close to the edge the thumb lands.)
  stick.baseX = Math.min(Math.max(x, R), layout.W - R);
  stick.baseY = Math.min(Math.max(y, R), layout.H - R);
  stick.active = true;
  stick.id = id;
  updateStick(stick, x, y);
}

function releaseAll() {
  fingers.clear();
  held.clear();
  sticks.move.active = false;
  sticks.aim.active = false;
}

TouchControls.touchpressed = function (id, x, y) {
  noteTouch();
  if (!layout) computeLayout();

  // The weapon bar: tap a box to switch to that blaster.
  const mode = WeaponBar.modeAt(x, y);
  if (mode) {
    if (!(state.player && state.player.isCannonRiding())) WeaponModes.set(mode);
    fingers.set(id, { kind: 'none' });
    return;
  }

  const b = buttonAt(x, y);
  if (b) {
    held.add(b.pad);
    fingers.set(id, { kind: 'button', pad: b.pad });
    return;
  }

  if (x < layout.W * 0.45) {
    if (!sticks.move.active) {
      startStick(sticks.move, id, x, y);
      fingers.set(id, { kind: 'move' });
      return;
    }
  } else if (!sticks.aim.active) {
    startStick(sticks.aim, id, x, y);
    fingers.set(id, { kind: 'aim' });
    return;
  }
  fingers.set(id, { kind: 'none' });
};

TouchControls.touchmoved = function (id, x, y) {
  noteTouch();
  const f = fingers.get(id);
  if (!f || !layout) return;
  if (f.kind === 'move') updateStick(sticks.move, x, y);
  else if (f.kind === 'aim') updateStick(sticks.aim, x, y);
  else if (f.kind === 'button') {
    // Sliding off a button lets go of it (and on to another presses that).
    const b = buttonAt(x, y);
    if (!b || b.pad !== f.pad) {
      held.delete(f.pad);
      if (b) { held.add(b.pad); f.pad = b.pad; } else f.kind = 'none';
    }
  }
};

TouchControls.touchreleased = function (id) {
  noteTouch();
  const f = fingers.get(id);
  fingers.delete(id);
  if (f) {
    if (f.kind === 'move') sticks.move.active = false;
    else if (f.kind === 'aim') sticks.aim.active = false;
    else if (f.kind === 'button') {
      // (Unless another finger is still on the same button.)
      if (![...fingers.values()].some((o) => o.kind === 'button' && o.pad === f.pad)) held.delete(f.pad);
    }
  }
  TouchControls.tryFullscreen();
};

// The whole screen, sideways, the first time the game is touched (a
// browser only allows it in answer to a tap). Phones that can't (an
// iPhone's browser) just carry on as they are.
TouchControls.tryFullscreen = function () {
  if (triedFullscreen) return;
  triedFullscreen = true;
  const root = document.documentElement;
  if (document.fullscreenElement || !root.requestFullscreen) return;
  root.requestFullscreen({ navigationUI: 'hide' })
    .then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape'))
    .catch(() => {});
};

// Called every frame (GamePadInput.js): nothing stays held while the
// game's paused, on the title screen, or once the controls aren't the
// input in use.
TouchControls.update = function () {
  // (Set here, before anything's drawn, for the weapon bar and minimap's
  // touch layouts.)
  state.touchControlsVisible = TouchControls.isActive() && !state.titleScreen;
  if (!state.touchControlsVisible || state.paused) {
    if (held.size || sticks.move.active || sticks.aim.active) releaseAll();
  }
};

// ---------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------
const fonts = {};
function font(size) {
  const k = Math.max(8, Math.round(size));
  if (!fonts[k]) fonts[k] = love.graphics.newFont(k);
  return fonts[k];
}

function label(text, x, y, size, alpha = 0.85) {
  const g = love.graphics;
  const f = font(size);
  g.setFont(f);
  g.setColor(1, 1, 1, alpha);
  g.print(text, Math.floor(x - f.getWidth(text) / 2), Math.floor(y - f.getHeight() / 2));
}

// A round button's backing: dark glass, a white rim, brighter when held.
function disc(x, y, r, pressed, tint = null) {
  const g = love.graphics;
  const s = pressed ? 0.93 : 1;
  g.setColor(0, 0, 0, pressed ? 0.5 : 0.34);
  g.circle('fill', x, y, r * s, 48);
  if (pressed) {
    const t = tint ?? [1, 1, 1];
    g.setColor(t[0], t[1], t[2], 0.28);
    g.circle('fill', x, y, r * s, 48);
  }
  g.setColor(1, 1, 1, pressed ? 0.9 : 0.55);
  g.setLineWidth(Math.max(1.5, r * 0.06));
  g.circle('line', x, y, r * s, 48);
}

const GLYPHS = {
  jump(x, y, r) {
    const g = love.graphics, k = r * 0.36;
    g.setColor(CROSS_COLOR[0], CROSS_COLOR[1], CROSS_COLOR[2], 1);
    g.setLineWidth(r * 0.13);
    g.line(x - k, y - k, x + k, y + k);
    g.line(x - k, y + k, x + k, y - k);
  },
  interact(x, y, r) {
    const g = love.graphics;
    g.setColor(CIRCLE_COLOR[0], CIRCLE_COLOR[1], CIRCLE_COLOR[2], 1);
    g.setLineWidth(r * 0.13);
    g.circle('line', x, y, r * 0.42, 32);
  },
  ball(x, y, r) {
    const g = love.graphics, k = r * 0.48;
    g.setColor(TRIANGLE_COLOR[0], TRIANGLE_COLOR[1], TRIANGLE_COLOR[2], 1);
    g.setLineWidth(r * 0.12);
    g.polygon('line', x, y - k, x + k * 0.92, y + k * 0.6, x - k * 0.92, y + k * 0.6);
  },
  pull(x, y, r) {
    // The blaster's own icon: a magnet, or the red portal in Portal mode.
    if (state.portalMode) {
      const g = love.graphics;
      g.setColor(1.0, 0.45, 0.25, 0.3);
      g.ellipse('fill', x, y, r * 0.24, r * 0.55, 32);
      g.setColor(1.0, 0.30, 0.22, 1);
      g.setLineWidth(r * 0.11);
      g.ellipse('line', x, y, r * 0.24, r * 0.55, 32);
    } else {
      WeaponBar.drawIcon('pullbeam', x, y, r * 1.3);
    }
  },
  lock(x, y, r) {
    const g = love.graphics, k = r * 0.42;
    g.setColor(1, 1, 1, 0.95);
    g.setLineWidth(r * 0.09);
    g.circle('line', x, y, k, 32);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      g.line(x + dx * k * 0.55, y + dy * k * 0.55, x + dx * k * 1.45, y + dy * k * 1.45);
    }
  },
  pause(x, y, r) {
    const g = love.graphics, w = r * 0.17, h = r * 0.62;
    g.setColor(1, 1, 1, 0.95);
    g.rectangle('fill', x - w * 2, y - h / 2, w * 1.3, h, w * 0.3, w * 0.3);
    g.rectangle('fill', x + w * 0.7, y - h / 2, w * 1.3, h, w * 0.3, w * 0.3);
  },
  zoomIn(x, y, r) {
    const g = love.graphics, k = r * 0.42;
    g.setColor(1, 1, 1, 0.95);
    g.setLineWidth(r * 0.13);
    g.line(x - k, y, x + k, y);
    g.line(x, y - k, x, y + k);
  },
  zoomOut(x, y, r) {
    const g = love.graphics, k = r * 0.42;
    g.setColor(1, 1, 1, 0.95);
    g.setLineWidth(r * 0.13);
    g.line(x - k, y, x + k, y);
  },
};

// Text under a button saying what it does right now.
function buttonLabel(b) {
  switch (b.name) {
    case 'jump': return 'JUMP';
    case 'interact': return 'TALK / USE';
    case 'ball': return state.player && state.player.mode === 'space' ? 'V.A.T.S.' : 'BALL';
    case 'pull': return state.portalMode ? 'RED' : 'PULL';
    case 'lock': return 'LOCK';
    default: return null;
  }
}

function drawStick(stick, home, u, aim) {
  const g = love.graphics;
  const R = STICK_RADIUS * u, k = KNOB_RADIUS * u;
  const active = stick.active;
  const bx = active ? stick.baseX : home[0], by = active ? stick.baseY : home[1];
  const mag = Math.hypot(stick.x, stick.y);
  const firing = aim && active && mag >= FIRE_AT;

  // Base: a dark ring (and, for the aim stick, the ring it fires past).
  g.setColor(0, 0, 0, active ? 0.3 : 0.16);
  g.circle('fill', bx, by, R, 56);
  g.setLineWidth(Math.max(1.5, 2.2 * u));
  g.setColor(1, 1, 1, active ? 0.5 : 0.22);
  g.circle('line', bx, by, R, 56);
  if (aim) {
    if (firing) g.setColor(ACCENT[0], ACCENT[1], ACCENT[2], 0.75);
    else g.setColor(1, 1, 1, active ? 0.25 : 0.12);
    g.setLineWidth(Math.max(1, 1.5 * u));
    g.circle('line', bx, by, R * FIRE_AT, 48);
  }

  // Knob.
  const kx = bx + (active ? stick.x : 0) * R, ky = by + (active ? stick.y : 0) * R;
  if (firing) {
    g.setColor(ACCENT[0], ACCENT[1], ACCENT[2], 0.35);
    g.circle('fill', kx, ky, k * 1.35, 40);
  }
  g.setColor(0.08, 0.1, 0.14, active ? 0.75 : 0.45);
  g.circle('fill', kx, ky, k, 40);
  g.setColor(1, 1, 1, active ? 0.95 : 0.5);
  g.setLineWidth(Math.max(1.5, 2 * u));
  g.circle('line', kx, ky, k, 40);
  if (aim) {
    // The blaster this fires, on the knob.
    WeaponBar.drawIcon(state.weaponMode ?? 'fireball', kx, ky, k * 1.5, active ? 1 : 0.6);
  } else {
    // Arrows: left and right.
    const a = k * 0.42;
    g.setColor(1, 1, 1, active ? 0.9 : 0.5);
    g.polygon('fill', kx - a * 1.6, ky, kx - a * 0.7, ky - a * 0.7, kx - a * 0.7, ky + a * 0.7);
    g.polygon('fill', kx + a * 1.6, ky, kx + a * 0.7, ky - a * 0.7, kx + a * 0.7, ky + a * 0.7);
  }

  // What it's for, under its resting place.
  if (!active) label(aim ? 'AIM · FIRE' : 'MOVE', bx, by + R + 14 * u, 11 * u, 0.5);
}

TouchControls.draw = function () {
  if (!TouchControls.isActive() || state.titleScreen) {
    state.touchControlsVisible = false;
    return;
  }
  state.touchControlsVisible = true;
  const g = love.graphics;
  const L = computeLayout();
  const u = L.u;

  g.push('all');
  g.origin();
  g.setLineStyle('smooth');

  if (L.H > L.W) {
    // Held upright: everything's laid out for sideways.
    g.setColor(0, 0, 0, 0.72);
    g.rectangle('fill', 0, 0, L.W, L.H);
    label('Turn your phone sideways', L.W / 2, L.H / 2, 22 * u, 1);
    g.pop();
    return;
  }

  if (!state.paused) {
    drawStick(sticks.move, L.moveHome, u, false);
    drawStick(sticks.aim, L.aimHome, u, true);
  }

  for (const b of L.buttons) {
    if (!buttonShown(b)) continue;
    if (state.paused && b.name !== 'pause') continue;
    const pressed = held.has(b.pad);
    const tint = b.name === 'jump' ? CROSS_COLOR : b.name === 'interact' ? CIRCLE_COLOR
      : b.name === 'ball' ? TRIANGLE_COLOR : null;
    disc(b.x, b.y, b.r, pressed, tint);
    GLYPHS[b.name](b.x, b.y, b.r);
    const text = buttonLabel(b);
    if (text) label(text, b.x, b.y + b.r + 9 * u, 10 * u, 0.7);
  }

  g.pop();
};

export default TouchControls;
