// js/ui/InteractPrompt.js
//
// The floating world-space "Press [button] to <verb>" pill shown above
// anything the player can interact with. The button is an inline icon —
// Circle after gamepad input, Enter after keyboard/mouse input (see
// state.promptIcons, loaded in assetLoading.js).
//
// Call from inside the camera-transformed block.

import love from '../love/index.js';
import state from '../state.js';

const InteractPrompt = {};

const PAD_X = 12, PAD_Y = 8;
const ICON_HEIGHT = 24;
const ICON_GAP = 6;
const BOB_SPEED = 3, BOB_HEIGHT = 4;

const FALLBACK_LABEL = { gamepad: 'Circle', keyboard: 'ENTER' };

// True when the gamepad is what the player used most recently.
InteractPrompt.usingGamepad = function () {
  const gamepadTime = state.lastGamepadInputTime;
  if (gamepadTime == null) return false;
  const keyboardMouseTime = Math.max(state.lastMouseMoveTime ?? 0, state.lastKeyboardMouseInputTime ?? 0);
  return gamepadTime > keyboardMouseTime;
};

// centerX: world x the pill is centered on. bottomY: world y of its
// bottom edge at rest. verb: what the button does here, or null for just
// the icon.
InteractPrompt.draw = function (centerX, bottomY, verb) {
  const g = love.graphics;
  const device = InteractPrompt.usingGamepad() ? 'gamepad' : 'keyboard';
  const icon = state.promptIcons ? state.promptIcons[device] : null;
  const iconOnly = icon && !verb;

  const font = g.getFont();
  let before = 'Press';
  const after = verb ? ('to ' + verb) : '';
  if (iconOnly) before = '';
  else if (!icon) before = before + ' ' + FALLBACK_LABEL[device];

  const textH = font.getHeight();
  const beforeW = font.getWidth(before), afterW = font.getWidth(after);
  let iconW = 0, iconH = 0, iconScale = 1;
  if (icon) {
    iconScale = ICON_HEIGHT / icon.getHeight();
    iconW = icon.getWidth() * iconScale;
    iconH = ICON_HEIGHT;
  }
  const iconGap = iconOnly ? 0 : ICON_GAP;
  const middleW = icon ? (iconGap + iconW + iconGap) : (after !== '' ? font.getWidth(' ') : 0);

  const pillW = beforeW + middleW + afterW + PAD_X * 2;
  const pillH = textH + PAD_Y * 2;

  const bob = Math.sin(love.timer.getTime() * BOB_SPEED) * BOB_HEIGHT;
  const pillX = centerX - pillW / 2;
  const pillY = bottomY - pillH + bob;

  g.setColor(0, 0, 0, 0.6);
  g.rectangle('fill', pillX, pillY, pillW, pillH, pillH / 2, pillH / 2);
  g.setColor(1, 1, 1, 0.9);
  g.rectangle('line', pillX, pillY, pillW, pillH, pillH / 2, pillH / 2);

  let x = pillX + PAD_X;
  g.print(before, x, pillY + PAD_Y);
  x += beforeW;
  if (icon) {
    g.setColor(1, 1, 1, 1);
    g.draw(icon, x + iconGap, pillY + (pillH - iconH) / 2, 0, iconScale, iconScale);
    g.setColor(1, 1, 1, 0.9);
  }
  x += middleW;
  g.print(after, x, pillY + PAD_Y);

  g.setColor(1, 1, 1, 1);
};

export default InteractPrompt;
