// js/ui/PauseMenu.js
//
// The in-game pause menu: Escape on the keyboard or Start (Options) on
// the controller freezes the game under a gray see-through overlay and
// offers CONTINUE, EXIT TO TITLE or EXIT GAME. main.js does the freezing
// (love.update returns early while PauseMenu.isOpen()) and sets onExitToTitle.
//
// EXIT GAME closes the game in LÖVE. A browser tab usually isn't allowed to
// close itself, so here it tries, and if the tab is still open a moment
// later it falls back to EXIT TO TITLE.
//
// It can also show a list of choices instead (PauseMenu.openList — e.g.
// the T key's debug teleport list, see main.js): the same freeze, look
// and controls, with a title of its own; choosing one closes the menu
// and calls back with it.

import love from '../love/index.js';
import lua from '../love/lua.js';
import state from '../state.js';

const PauseMenu = {};

const OPTIONS = ['CONTINUE', 'EXIT TO TITLE', 'EXIT GAME'];
const CONTINUE = 0, EXIT_TO_TITLE = 1, EXIT_GAME = 2;

const OVERLAY_COLOR = [0.32, 0.34, 0.38, 0.62];
const HEADING_FONT_SIZE = 56;
const OPTION_FONT_SIZE = 38;
const OPTION_SPACING = 74;
const OPTION_PILL_PAD_X = 40, OPTION_PILL_PAD_Y = 14;
const UNSELECTED_ALPHA = 0.5;

// The list page, while one's showing (see PauseMenu.openList):
// { title, options: [{ label, enabled }, ...], onChoose }.
let list = null;
const LIST_OPTION_FONT_SIZE = 30;
const LIST_OPTION_SPACING = 54;
const LIST_DISABLED_ALPHA = 0.22;
const HINT_FONT_SIZE = 20;

let selected = CONTINUE;
let pausedSources = null;
// Where each option was last drawn, for tapping one (see PauseMenu.tapAt).
let optionRects = [];

// Set by main.js: called (with the menu already closed) on EXIT TO TITLE.
PauseMenu.onExitToTitle = null;
// Set by main.js: called when T is pressed in the game (see
// InputHandlers.js), to open its teleport list.
PauseMenu.onTeleportKey = null;

const fonts = {};
function getFont(size) {
  if (!fonts[size]) fonts[size] = love.graphics.newFont(size);
  return fonts[size];
}

PauseMenu.isOpen = () => state.paused === true;

PauseMenu.open = function () {
  if (state.paused || state.titleScreen) return;
  state.paused = true;
  list = null;
  selected = CONTINUE;
  pausedSources = love.audio.pause();
};

// Pauses with a list of choices showing instead of the usual options.
// options: [{ label: '...', enabled: true/false }, ...] (disabled ones
// are shown dimmed and skipped over). initial: which to start on (0-based).
// onChoose(index) is called once the menu has closed again.
PauseMenu.openList = function (title, options, onChoose, initial) {
  if (state.titleScreen || options.length === 0) return;
  if (!state.paused) {
    state.paused = true;
    pausedSources = love.audio.pause();
  }
  list = { title, options, onChoose };
  selected = 0;
  if (initial != null && options[initial]?.enabled) selected = initial;
  else if (!options[0].enabled) PauseMenu.move(1);
};

PauseMenu.isListOpen = () => state.paused === true && list !== null;

PauseMenu.close = function () {
  if (!state.paused) return;
  state.paused = false;
  list = null;
  if (pausedSources && pausedSources.length > 0) love.audio.play(pausedSources);
  pausedSources = null;
};

// delta: -1 = up, 1 = down. Wraps round, skipping a list's disabled options.
PauseMenu.move = function (delta) {
  if (!state.paused) return;
  const options = list ? list.options : OPTIONS;
  let at = selected;
  for (let k = 0; k < options.length; k++) {
    at = lua.mod(at + delta, options.length);
    if (!list || options[at].enabled) {
      selected = at;
      return;
    }
  }
};

PauseMenu.confirm = function () {
  if (!state.paused) return;
  if (list) {
    const option = list.options[selected];
    if (!option?.enabled) return;
    const onChoose = list.onChoose;
    const index = selected;
    PauseMenu.close();
    if (onChoose) onChoose(index);
    return;
  }
  if (selected === CONTINUE) {
    PauseMenu.close();
    return;
  }
  if (selected === EXIT_GAME) {
    love.event.quit();
    window.close(); // only works if the browser allows it (e.g. a tab the game itself opened)
    // Still here? Exiting to the title is the closest thing a tab can do.
    setTimeout(() => {
      if (window.closed || !state.paused) return;
      selected = EXIT_TO_TITLE;
      PauseMenu.confirm();
    }, 200);
    return;
  }
  state.paused = false;
  pausedSources = null;
  love.audio.stop();
  if (PauseMenu.onExitToTitle) PauseMenu.onExitToTitle();
};

// A tap on the screen (see InputHandlers.js's love.touchpressed): picks
// the option tapped. Off every option, a list closes; the pause menu
// itself stays.
PauseMenu.tapAt = function (x, y) {
  if (!state.paused) return;
  const hit = optionRects.find((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
  if (!hit) {
    if (list) PauseMenu.close();
    return;
  }
  if (list && !list.options[hit.i].enabled) return;
  selected = hit.i;
  PauseMenu.confirm();
};

// key: InputHandlers.js's own JS-style key name.
PauseMenu.keypressed = function (key) {
  if (list) {
    // (Any arrow cycles through a list; X picks, like the pad's Cross; T,
    // which opened it, closes it again.)
    if (key === 'ArrowUp' || key === 'ArrowLeft' || key === 'w' || key === 'a') PauseMenu.move(-1);
    else if (key === 'ArrowDown' || key === 'ArrowRight' || key === 's' || key === 'd') PauseMenu.move(1);
    else if (key === 'Enter' || key === ' ' || key === 'x') PauseMenu.confirm();
    else if (key === 'escape' || key === 't') PauseMenu.close();
    return;
  }
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
  // (A list starts higher up, with smaller, closer options, to fit more.)
  const headingY = screenH * (list ? 0.14 : 0.3);
  const optionFontSize = list ? LIST_OPTION_FONT_SIZE : OPTION_FONT_SIZE;
  const optionSpacing = list ? LIST_OPTION_SPACING : OPTION_SPACING;

  const headingFont = getFont(HEADING_FONT_SIZE);
  g.setFont(headingFont);
  const heading = list ? list.title : 'PAUSED';
  const headingX = Math.floor(centerX - headingFont.getWidth(heading) / 2);
  g.setColor(0, 0, 0, 0.6);
  g.print(heading, headingX + 3, Math.floor(headingY) + 3);
  g.setColor(1, 1, 1, 1);
  g.print(heading, headingX, Math.floor(headingY));

  const optionFont = getFont(optionFontSize);
  g.setFont(optionFont);
  const firstY = headingY + HEADING_FONT_SIZE + (list ? 50 : 70);
  const options = list ? list.options : OPTIONS;
  optionRects = [];
  options.forEach((option, i) => {
    const enabled = !list || option.enabled;
    let label = list ? option.label : option;
    if (!enabled) label += '  (OFF)';
    const textW = optionFont.getWidth(label), textH = optionFont.getHeight();
    const centerY = firstY + i * optionSpacing;
    const textX = Math.floor(centerX - textW / 2), textY = Math.floor(centerY - textH / 2);
    // (A generous band for a finger: the option's whole row, at least a
    // decent width.)
    const hitHalfW = Math.max(textW / 2 + OPTION_PILL_PAD_X, 220);
    optionRects.push({ i, x0: centerX - hitHalfW, x1: centerX + hitHalfW,
      y0: centerY - optionSpacing / 2, y1: centerY + optionSpacing / 2 });

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
      g.setColor(1, 1, 1, enabled ? UNSELECTED_ALPHA : LIST_DISABLED_ALPHA);
    }
    g.print(label, textX, textY);
  });

  if (list) {
    const hintFont = getFont(HINT_FONT_SIZE);
    g.setFont(hintFont);
    const hint = 'Arrows / left stick: choose     Enter, Space or X: go     T or Esc: cancel';
    const hintY = firstY + options.length * optionSpacing + 10;
    g.setColor(1, 1, 1, 0.75);
    g.print(hint, Math.floor(centerX - hintFont.getWidth(hint) / 2), Math.floor(hintY));
  }

  g.setFont(prevFont);
  g.setColor(1, 1, 1, 1);
};

export default PauseMenu;
