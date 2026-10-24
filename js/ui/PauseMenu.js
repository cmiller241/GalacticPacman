// js/ui/PauseMenu.js
//
// The in-game pause menu: Escape on the keyboard or Start (Options) on
// the controller freezes the game under a gray see-through overlay and
// offers CONTINUE or EXIT TO TITLE. main.js does the freezing (love.update
// returns early while PauseMenu.isOpen()) and sets onExitToTitle.

import love from '../love/index.js';
import lua from '../love/lua.js';
import state from '../state.js';

const PauseMenu = {};

const OPTIONS = ['CONTINUE', 'EXIT TO TITLE'];
const CONTINUE = 0, EXIT_TO_TITLE = 1;

const OVERLAY_COLOR = [0.32, 0.34, 0.38, 0.62];
const HEADING_FONT_SIZE = 56;
const OPTION_FONT_SIZE = 38;
const OPTION_SPACING = 74;
const OPTION_PILL_PAD_X = 40, OPTION_PILL_PAD_Y = 14;
const UNSELECTED_ALPHA = 0.5;

let selected = CONTINUE;
let pausedSources = null;

// Set by main.js: called (with the menu already closed) on EXIT TO TITLE.
PauseMenu.onExitToTitle = null;

const fonts = {};
function getFont(size) {
  if (!fonts[size]) fonts[size] = love.graphics.newFont(size);
  return fonts[size];
}

PauseMenu.isOpen = () => state.paused === true;

PauseMenu.open = function () {
  if (state.paused || state.titleScreen) return;
  state.paused = true;
  selected = CONTINUE;
  pausedSources = love.audio.pause();
};

PauseMenu.close = function () {
  if (!state.paused) return;
  state.paused = false;
  if (pausedSources && pausedSources.length > 0) love.audio.play(pausedSources);
  pausedSources = null;
};

// delta: -1 = up, 1 = down. Wraps round.
PauseMenu.move = function (delta) {
  if (!state.paused) return;
  selected = lua.mod(selected + delta, OPTIONS.length);
};

PauseMenu.confirm = function () {
  if (!state.paused) return;
  if (selected === CONTINUE) {
    PauseMenu.close();
    return;
  }
  state.paused = false;
  pausedSources = null;
  love.audio.stop();
  if (PauseMenu.onExitToTitle) PauseMenu.onExitToTitle();
};

// key: InputHandlers.js's own JS-style key name.
PauseMenu.keypressed = function (key) {
  if (key === 'ArrowUp' || key === 'w') PauseMenu.move(-1);
  else if (key === 'ArrowDown' || key === 's') PauseMenu.move(1);
  else if (key === 'Enter' || key === ' ') PauseMenu.confirm();
  else if (key === 'escape') PauseMenu.close();
};

// Call last in love.draw, in screen space.
PauseMenu.draw = function () {
  if (!state.paused) return;
  const g = love.graphics;
  const screenW = g.getWidth(), screenH = g.getHeight();

  g.setColor(OVERLAY_COLOR);
  g.rectangle('fill', 0, 0, screenW, screenH);

  const prevFont = g.getFont();
  const centerX = screenW / 2;
  const headingY = screenH * 0.3;

  const headingFont = getFont(HEADING_FONT_SIZE);
  g.setFont(headingFont);
  const heading = 'PAUSED';
  const headingX = Math.floor(centerX - headingFont.getWidth(heading) / 2);
  g.setColor(0, 0, 0, 0.6);
  g.print(heading, headingX + 3, Math.floor(headingY) + 3);
  g.setColor(1, 1, 1, 1);
  g.print(heading, headingX, Math.floor(headingY));

  const optionFont = getFont(OPTION_FONT_SIZE);
  g.setFont(optionFont);
  const firstY = headingY + HEADING_FONT_SIZE + 70;
  OPTIONS.forEach((label, i) => {
    const textW = optionFont.getWidth(label), textH = optionFont.getHeight();
    const centerY = firstY + i * OPTION_SPACING;
    const textX = Math.floor(centerX - textW / 2), textY = Math.floor(centerY - textH / 2);

    if (i === selected) {
      const pillW = textW + OPTION_PILL_PAD_X * 2, pillH = textH + OPTION_PILL_PAD_Y * 2;
      const pillX = centerX - pillW / 2, pillY = centerY - pillH / 2;
      g.setColor(0, 0, 0, 0.6);
      g.rectangle('fill', pillX, pillY, pillW, pillH, pillH / 2, pillH / 2);
      g.setColor(1, 1, 1, 0.9);
      g.setLineWidth(2);
      g.rectangle('line', pillX, pillY, pillW, pillH, pillH / 2, pillH / 2);
      g.setLineWidth(1);
      g.setColor(1, 1, 1, 1);
    } else {
      g.setColor(1, 1, 1, UNSELECTED_ALPHA);
    }
    g.print(label, textX, textY);
  });

  g.setFont(prevFont);
  g.setColor(1, 1, 1, 1);
};

export default PauseMenu;
