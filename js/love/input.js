// js/love/input.js
//
// love.keyboard, love.mouse and love.joystick for the browser.
// Keyboard keys use LÖVE's key names ("left", "space", "return", "a",
// "lshift", "kp+", "=" ...), mapped from KeyboardEvent.code so they
// don't change with Shift. Gamepads are read through the standard
// Gamepad API mapping and turned into LÖVE's gamepad button/axis names.

const CODE_TO_KEY = {
  Space: 'space', Enter: 'return', NumpadEnter: 'kpenter', Escape: 'escape', Backspace: 'backspace',
  Tab: 'tab', Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
  ShiftLeft: 'lshift', ShiftRight: 'rshift', ControlLeft: 'lctrl', ControlRight: 'rctrl',
  AltLeft: 'lalt', AltRight: 'ralt', MetaLeft: 'lgui', MetaRight: 'rgui', CapsLock: 'capslock',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';',
  Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/',
  NumpadAdd: 'kp+', NumpadSubtract: 'kp-', NumpadMultiply: 'kp*', NumpadDivide: 'kp/', NumpadDecimal: 'kp.',
  NumpadEqual: 'kp=',
};

function keyFromEvent(e) {
  const code = e.code;
  if (CODE_TO_KEY[code]) return CODE_TO_KEY[code];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1].toLowerCase();
  m = /^Digit(\d)$/.exec(code);
  if (m) return m[1];
  m = /^Numpad(\d)$/.exec(code);
  if (m) return 'kp' + m[1];
  m = /^F(\d+)$/.exec(code);
  if (m) return 'f' + m[1];
  return (e.key || 'unknown').toLowerCase();
}

// Keys the browser would otherwise use for scrolling/focus.
const PREVENT_DEFAULT = new Set(['space', 'left', 'right', 'up', 'down', 'tab', 'pageup', 'pagedown', 'home', 'end', 'backspace', "'", '/']);

const keysDown = new Set();
const mouseButtonsDown = new Set();
let mouseX = 0, mouseY = 0;
// Like LÖVE, key repeat is off unless the game turns it on: holding a key
// fires love.keypressed once, not over and over while it's held (the
// browser's own repeated keydown events are dropped).
let keyRepeat = false;

const keyboard = {
  isDown(...keys) {
    if (keys.length === 1 && Array.isArray(keys[0])) keys = keys[0];
    return keys.some((k) => keysDown.has(k));
  },
  isScancodeDown(...keys) { return keyboard.isDown(...keys); },
  setKeyRepeat(on) { keyRepeat = !!on; },
  hasKeyRepeat() { return keyRepeat; },
};

const mouse = {
  getPosition() { return [mouseX, mouseY]; },
  getX() { return mouseX; },
  getY() { return mouseY; },
  isDown(...buttons) { return buttons.some((b) => mouseButtonsDown.has(b)); },
  setVisible(v) { if (canvasEl) canvasEl.style.cursor = v ? '' : 'none'; },
  isVisible() { return !canvasEl || canvasEl.style.cursor !== 'none'; },
  setGrabbed() {},
  setRelativeMode() {},
};

// ---------------- Gamepads ----------------
const STANDARD_BUTTONS = [
  'a', 'b', 'x', 'y', 'leftshoulder', 'rightshoulder', null, null,
  'back', 'start', 'leftstick', 'rightstick', 'dpup', 'dpdown', 'dpleft', 'dpright', 'guide',
];

class Joystick {
  constructor(index) {
    this.index = index;
    this.id = index + 1;
    this.connected = true;
    this.prevButtons = {};
    this.pad = null;
  }
  type() { return 'Joystick'; }
  getID() { return [this.id, this.id]; }
  getName() { return this.pad ? this.pad.id : 'Gamepad'; }
  getGUID() { return this.pad ? this.pad.id : ''; }
  isConnected() { return this.connected; }
  isGamepad() { return true; }
  buttonDown(name) {
    const p = this.pad;
    if (!p) return false;
    const i = STANDARD_BUTTONS.indexOf(name);
    if (i < 0 || !p.buttons[i]) return false;
    return p.buttons[i].pressed;
  }
  isGamepadDown(...buttons) {
    if (buttons.length === 1 && Array.isArray(buttons[0])) buttons = buttons[0];
    return buttons.some((b) => this.buttonDown(b));
  }
  getGamepadAxis(axis) {
    const p = this.pad;
    if (!p) return 0;
    switch (axis) {
      case 'leftx': return p.axes[0] || 0;
      case 'lefty': return p.axes[1] || 0;
      case 'rightx': return p.axes[2] || 0;
      case 'righty': return p.axes[3] || 0;
      case 'triggerleft': return p.buttons[6] ? p.buttons[6].value : 0;
      case 'triggerright': return p.buttons[7] ? p.buttons[7].value : 0;
      default: return 0;
    }
  }
  getAxisCount() { return this.pad ? this.pad.axes.length : 0; }
  getButtonCount() { return this.pad ? this.pad.buttons.length : 0; }
  isVibrationSupported() { return !!(this.pad && this.pad.vibrationActuator); }
  setVibration(left = 0, right = 0, duration = -1) {
    const act = this.pad && this.pad.vibrationActuator;
    if (!act || !act.playEffect) return false;
    act.playEffect('dual-rumble', {
      duration: duration < 0 ? 1000 : duration * 1000, strongMagnitude: left, weakMagnitude: right,
    }).catch(() => {});
    return true;
  }
}

const joysticksByIndex = new Map();

function pollGamepads(love) {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const seen = new Set();
  for (const p of pads) {
    if (!p) continue;
    seen.add(p.index);
    let js = joysticksByIndex.get(p.index);
    if (!js) {
      js = new Joystick(p.index);
      joysticksByIndex.set(p.index, js);
      js.pad = p;
      if (love.joystickadded) love.joystickadded(js);
    }
    js.pad = p;
    js.connected = true;
    STANDARD_BUTTONS.forEach((name, i) => {
      if (!name || !p.buttons[i]) return;
      const down = p.buttons[i].pressed;
      const was = !!js.prevButtons[name];
      if (down && !was && love.gamepadpressed) love.gamepadpressed(js, name);
      if (!down && was && love.gamepadreleased) love.gamepadreleased(js, name);
      js.prevButtons[name] = down;
    });
  }
  for (const [index, js] of joysticksByIndex) {
    if (!seen.has(index)) {
      js.connected = false;
      joysticksByIndex.delete(index);
      if (love.joystickremoved) love.joystickremoved(js);
    }
  }
}

const joystick = {
  getJoysticks() { return [...joysticksByIndex.values()]; },
  getJoystickCount() { return joysticksByIndex.size; },
};

// ---------------- DOM wiring ----------------
let canvasEl = null;
let graphicsWidth = () => (canvasEl ? canvasEl.width : 1);

function attach(el, love, onFirstInput) {
  if (love.graphics) graphicsWidth = () => love.graphics.getWidth();
  canvasEl = el;
  const mouseButton = (b) => (b === 0 ? 1 : b === 2 ? 2 : b === 1 ? 3 : b + 1);
  const toCanvas = (e) => {
    const r = el.getBoundingClientRect();
    // (In the game's units — see screenUnits in index.js — via the
    // canvas' real pixels per CSS pixel and the game's units per real pixel.)
    const k = (el.width / r.width) * (graphicsWidth() / el.width);
    return [(e.clientX - r.left) * k, (e.clientY - r.top) * k];
  };

  window.addEventListener('keydown', (e) => {
    onFirstInput();
    const key = keyFromEvent(e);
    if (PREVENT_DEFAULT.has(key) || (key.startsWith('f') && key.length <= 3 && key !== 'f' && key !== 'f12' && key !== 'f5')) e.preventDefault();
    const isRepeat = e.repeat || keysDown.has(key);
    keysDown.add(key);
    if (isRepeat && !keyRepeat) return;
    if (love.keypressed) love.keypressed(key, key, isRepeat);
    if (love.textinput && e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey) love.textinput(e.key);
  });
  window.addEventListener('keyup', (e) => {
    const key = keyFromEvent(e);
    keysDown.delete(key);
    if (PREVENT_DEFAULT.has(key)) e.preventDefault();
    if (love.keyreleased) love.keyreleased(key, key);
  });
  window.addEventListener('blur', () => {
    for (const k of [...keysDown]) {
      keysDown.delete(k);
      if (love.keyreleased) love.keyreleased(k, k);
    }
    mouseButtonsDown.clear();
    if (love.focus) love.focus(false);
  });
  window.addEventListener('focus', () => { if (love.focus) love.focus(true); });

  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('mousedown', (e) => {
    onFirstInput();
    e.preventDefault();
    [mouseX, mouseY] = toCanvas(e);
    const b = mouseButton(e.button);
    mouseButtonsDown.add(b);
    if (love.mousepressed) love.mousepressed(mouseX, mouseY, b, false, e.detail || 1);
  });
  window.addEventListener('mouseup', (e) => {
    [mouseX, mouseY] = toCanvas(e);
    const b = mouseButton(e.button);
    if (!mouseButtonsDown.has(b)) return;
    mouseButtonsDown.delete(b);
    if (love.mousereleased) love.mousereleased(mouseX, mouseY, b, false, e.detail || 1);
  });
  window.addEventListener('mousemove', (e) => {
    const [x, y] = toCanvas(e);
    const dx = x - mouseX, dy = y - mouseY;
    mouseX = x; mouseY = y;
    if (love.mousemoved) love.mousemoved(x, y, dx, dy, false);
  });
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    const sx = Math.sign(e.deltaX), sy = -Math.sign(e.deltaY);
    if (love.wheelmoved && (sx || sy)) love.wheelmoved(sx, sy);
  }, { passive: false });
}

export { keyboard, mouse, joystick, pollGamepads, attach };
