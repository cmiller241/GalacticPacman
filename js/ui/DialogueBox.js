// js/ui/DialogueBox.js
//
// Shared textbox rendering/pagination for every NPC-style dialogue in
// the game (RobotButler, Fisherman, Sign). Each caller owns its own
// dialogue STATE; this module only lays out and draws a screen-space
// textbox and paginates a string to fit one.
//
// Inline button icons: "Hold **R2** to fire" draws R2's icon (from
// state.buttonIcons, matched case-insensitively). Unknown names are left
// as typed.

import love from '../love/index.js';
import state from '../state.js';

const DialogueBox = {};

const TEXTBOX_SOURCE_W = 1410, TEXTBOX_SOURCE_H = 227;
const TEXTBOX_WIDTH_MARGIN = 20;
const TEXTBOX_BOTTOM_MARGIN = 20;
const TEXTBOX_TEXT_PAD_X = 60;
const TEXTBOX_TEXT_PAD_Y = 33;
const TEXTBOX_SHADOW_OFFSET = 2;

const DIALOGUE_MORE_SIZE = 16;
const DIALOGUE_MORE_MARGIN = 18;

let dialogueFont = null;
DialogueBox.getFont = function () {
  if (!dialogueFont) dialogueFont = love.graphics.newFont(30);
  return dialogueFont;
};

// The box's screen-space rect. -> [x, y, w, h]
DialogueBox.computeBoxRect = function () {
  const screenW = love.graphics.getWidth(), screenH = love.graphics.getHeight();
  let rightEdge = screenW - TEXTBOX_WIDTH_MARGIN;
  if (state.minimap) {
    state.minimap.refreshSize();
    const mapLeftEdge = screenW - state.minimap.size - state.minimap.margin;
    rightEdge = Math.min(rightEdge, mapLeftEdge - TEXTBOX_WIDTH_MARGIN);
  }
  const boxX = TEXTBOX_WIDTH_MARGIN;
  const boxW = rightEdge - boxX;
  const boxH = boxW * (TEXTBOX_SOURCE_H / TEXTBOX_SOURCE_W);
  const boxY = screenH - TEXTBOX_BOTTOM_MARGIN - boxH;
  return [boxX, boxY, boxW, boxH];
};

const ICON_HEIGHT = 36;
const ICON_PAD = 3;

function iconFor(name) {
  const icons = state.buttonIcons;
  return icons ? (icons[name.toUpperCase()] ?? null) : null;
}

// Breaks one whitespace-free word into drawable pieces. -> [pieces, width]
function parseWord(word, font) {
  const pieces = [];
  let width = 0;
  const addText = (s) => {
    if (s === '') return;
    const w = font.getWidth(s);
    pieces.push({ text: s, width: w });
    width += w;
  };

  const re = /\*\*([A-Za-z0-9]+)\*\*/g;
  let pos = 0;
  let m;
  while ((m = re.exec(word)) !== null) {
    const icon = iconFor(m[1]);
    const startAt = m.index, endAt = m.index + m[0].length;
    if (icon) {
      addText(word.slice(pos, startAt));
      const w = icon.getWidth() * (ICON_HEIGHT / icon.getHeight()) + ICON_PAD * 2;
      pieces.push({ icon, width: w });
      width += w;
    } else {
      addText(word.slice(pos, endAt));
    }
    pos = endAt;
  }
  addText(word.slice(pos));
  return [pieces, width];
}

// Word-wraps `text` to `limit` pixels, icon widths included.
// -> [lines, spaceW]; each line { raw, words: [{ pieces, width }] }
function layoutLines(text, limit) {
  const font = DialogueBox.getFont();
  const spaceW = font.getWidth(' ');
  const lines = [];

  for (const paragraph of (text ?? '').split('\n')) {
    let line = { raw: '', words: [] };
    let lineW = 0;
    for (const word of paragraph.split(/\s+/).filter((w) => w !== '')) {
      const [pieces, wordW] = parseWord(word, font);
      if (line.words.length > 0 && lineW + spaceW + wordW > limit) {
        lines.push(line);
        line = { raw: '', words: [] };
        lineW = 0;
      }
      if (line.words.length > 0) {
        line.raw += ' ';
        lineW += spaceW;
      }
      line.raw += word;
      lineW += wordW;
      line.words.push({ pieces, width: wordW });
    }
    lines.push(line);
  }
  return [lines, spaceW];
}

// Splits `text` into the pages that fit a box of the given size.
DialogueBox.paginate = function (text, boxW, boxH) {
  const font = DialogueBox.getFont();
  const textLimit = boxW - TEXTBOX_TEXT_PAD_X * 2;
  const wrappedLines = layoutLines(text, textLimit)[0].map((l) => l.raw);

  const lineHeight = font.getHeight();
  const availableHeight = boxH - TEXTBOX_TEXT_PAD_Y * 2;
  const linesPerPage = Math.max(1, Math.floor(availableHeight / lineHeight));

  const pages = [];
  for (let i = 0; i < wrappedLines.length; i += linesPerPage) {
    pages.push(wrappedLines.slice(i, i + linesPerPage).join('\n'));
  }
  if (pages.length === 0) pages.push('');
  return pages;
};

DialogueBox.paginateForBox = function (text) {
  const [, , boxW, boxH] = DialogueBox.computeBoxRect();
  return DialogueBox.paginate(text, boxW, boxH);
};

// Draws the box art, the page text and (if hasMore) the "more" marker.
// Call after the camera transform is popped.
DialogueBox.draw = function (pageText, hasMore) {
  const g = love.graphics;
  const img = state.textboxTexture;
  if (!img) return;

  const [boxX, boxY, boxW, boxH] = DialogueBox.computeBoxRect();

  g.setColor(1, 1, 1, 1);
  g.draw(img, boxX, boxY, 0, boxW / TEXTBOX_SOURCE_W, boxH / TEXTBOX_SOURCE_H);

  const prevFont = g.getFont();
  g.setFont(DialogueBox.getFont());

  const textX = boxX + TEXTBOX_TEXT_PAD_X;
  const textY = boxY + TEXTBOX_TEXT_PAD_Y;
  const textLimit = boxW - TEXTBOX_TEXT_PAD_X * 2;

  const font = DialogueBox.getFont();
  const lineHeight = font.getHeight();
  const [lines, spaceW] = layoutLines(pageText, textLimit);
  lines.forEach((line, lineIndex) => {
    let x = textX;
    const y = textY + lineIndex * lineHeight;
    for (const word of line.words) {
      for (const piece of word.pieces) {
        if (piece.icon) {
          g.setColor(1, 1, 1, 1);
          g.draw(piece.icon,
            Math.floor(x + ICON_PAD), Math.floor(y + (lineHeight - ICON_HEIGHT) / 2),
            0, ICON_HEIGHT / piece.icon.getHeight(), ICON_HEIGHT / piece.icon.getHeight());
        } else {
          g.setColor(0, 0, 0, 0.65);
          g.print(piece.text, x + TEXTBOX_SHADOW_OFFSET, y + TEXTBOX_SHADOW_OFFSET);
          g.setColor(1, 1, 1, 1);
          g.print(piece.text, x, y);
        }
        x += piece.width;
      }
      x += spaceW;
    }
  });

  g.setFont(prevFont);

  if (hasMore) {
    const bob = Math.sin(love.timer.getTime() * 4) * 3;
    const tx = boxX + boxW - DIALOGUE_MORE_MARGIN;
    const ty = boxY + boxH - DIALOGUE_MORE_MARGIN + bob;
    g.setColor(1, 1, 1, 0.9);
    g.polygon('fill', tx, ty - DIALOGUE_MORE_SIZE, tx, ty, tx - DIALOGUE_MORE_SIZE, ty);
    g.setColor(1, 1, 1, 1);
  }
};

export default DialogueBox;
