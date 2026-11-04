// js/ui/WeaponBar.js
//
// The blaster selector in the lower-left: one white-outlined rounded box
// per mode (see js/systems/WeaponModes.js), side by side, each with its
// own icon. The mode in use is drawn bigger and fully bright; the others
// are smaller and dimmed. Boxes grow and shrink smoothly on a switch.
// (A port of lua/ui/WeaponBar.lua.)
//
// Icons are drawn with shapes, not images, in a 100x100 box centered on
// (0, 0), then scaled to the box's size on screen. Colors match each
// weapon's own effects in the game.

import love from '../love/index.js';
import state from '../state.js';
import WeaponModes from '../systems/WeaponModes.js';

const WeaponBar = {};

const MARGIN = 20;          // from the screen's left and bottom edges
const BOX_SIZE = 100;       // unselected box, in screen pixels
const SELECTED_SCALE = 1.3; // the mode in use is this much bigger
const GAP = 8;              // between boxes
const CORNER = 0.2;         // corner radius, as a fraction of box size
const EASE = 0.25;          // how quickly boxes grow/shrink each frame
const DIM = 0.5;            // brightness of unselected boxes and icons

const scales = {}; // current animated scale per mode
// Where each box was last drawn, for tapping one (see WeaponBar.modeAt).
let boxes = [];
// With the touch controls showing (see js/ui/TouchControls.js), the bar
// moves to the top middle, a little bigger, out of the thumbs' way.
const TOUCH_SCALE = 1.15;

// Icons are dimmed by darkening their colors, not by fading them:
// fading would let their overlapping layers show through each other.
let dim = 1;
function col(r, g, b, a = 1) {
  love.graphics.setColor(r * dim, g * dim, b * dim, a);
}

// ---------------------------------------------------------------------
// Icons. Each draws into a 100x100 box centered on (0, 0), using col()
// for its colors.
// ---------------------------------------------------------------------
function teardrop(tipX, tipY, cx, cy, r) {
  // A circle plus the triangle from `tip` to the circle's two tangent
  // points: a flame or comet shape.
  const dx = cx - tipX, dy = cy - tipY;
  const d = Math.sqrt(dx * dx + dy * dy);
  const ux = dx / d, uy = dy / d;
  const alpha = Math.acos(r / d);
  const base = Math.atan2(-uy, -ux); // from the center back toward the tip
  const p1x = cx + Math.cos(base + alpha) * r, p1y = cy + Math.sin(base + alpha) * r;
  const p2x = cx + Math.cos(base - alpha) * r, p2y = cy + Math.sin(base - alpha) * r;
  love.graphics.polygon('fill', tipX, tipY, p1x, p1y, p2x, p2y);
  love.graphics.circle('fill', cx, cy, r, 40);
}

const ICONS = {
  // A fireball streaking down-right, with a hot core.
  fireball() {
    col(1.0, 0.32, 0.08);
    teardrop(-32, -32, 8, 8, 21);
    col(1.0, 0.62, 0.15);
    teardrop(-18, -18, 10, 10, 14);
    col(1.0, 0.92, 0.55);
    love.graphics.circle('fill', 12, 12, 7, 24);
  },

  // A horseshoe magnet pulling a small rock toward it.
  pullbeam() {
    const g = love.graphics;
    const cy = 14, r = 17;
    g.setLineWidth(12);
    g.setLineStyle('smooth');
    col(0.47, 0.82, 1.0);
    g.arc('line', 'open', 0, cy, r, 0, Math.PI, 32);
    g.line(-r, cy, -r, -4);
    g.line(r, cy, r, -4);
    // Bright pole tips.
    col(0.84, 0.96, 1.0);
    g.rectangle('fill', -r - 6, -14, 12, 10);
    g.rectangle('fill', r - 6, -14, 12, 10);
    // The rock above, and motion lines toward the magnet.
    col(0.75, 0.72, 0.68);
    g.circle('fill', 0, -32, 8, 20);
    col(0.84, 0.96, 1.0, 0.8);
    g.setLineWidth(3);
    g.line(-6, -20, -6, -13);
    g.line(6, -20, 6, -13);
  },

  // A water drop with a shine.
  water() {
    col(0.30, 0.66, 1.0);
    teardrop(0, -34, 0, 8, 22);
    col(0.85, 0.95, 1.0);
    love.graphics.ellipse('fill', -9, 6, 4, 8, 16);
  },

  // A six-armed snowflake.
  ice() {
    const g = love.graphics;
    g.setLineStyle('smooth');
    col(0.78, 0.93, 1.0);
    const arm = 32, branchAt = 18, branchLen = 10;
    for (let i = 0; i <= 5; i++) {
      const ang = i * Math.PI / 3 - Math.PI / 2;
      const cx = Math.cos(ang), cy = Math.sin(ang);
      g.setLineWidth(6);
      g.line(0, 0, cx * arm, cy * arm);
      g.setLineWidth(4);
      const bx = cx * branchAt, by = cy * branchAt;
      for (const side of [-1, 1]) {
        const bang = ang + side * 0.8;
        g.line(bx, by, bx + Math.cos(bang) * branchLen, by + Math.sin(bang) * branchLen);
      }
    }
    col(0.92, 0.99, 1.0);
    g.circle('fill', 0, 0, 6, 6);
  },

  // A red portal and a blue portal side by side.
  portal() {
    const g = love.graphics;
    const ring = (x, core, glow) => {
      col(glow[0], glow[1], glow[2], 0.3);
      g.ellipse('fill', x, 0, 11, 28, 32);
      col(core[0], core[1], core[2]);
      g.setLineWidth(6);
      g.ellipse('line', x, 0, 11, 28, 32);
    };
    ring(-14, [1.0, 0.30, 0.22], [1.0, 0.45, 0.25]);
    ring(14, [0.20, 0.55, 1.0], [0.35, 0.70, 1.0]);
  },

  // A rewind arrow running counterclockwise round a clock face.
  recall() {
    const g = love.graphics;
    const r = 26;
    const a0 = -Math.PI * 0.30, a1 = Math.PI * 1.20; // arrow tip at a0
    col(1.0, 0.86, 0.25);
    g.setLineWidth(7);
    g.setLineStyle('smooth');
    g.arc('line', 'open', 0, 0, r, a0, a1, 40);
    // Arrowhead on the arc's end, pointing counterclockwise (decreasing
    // angle on screen).
    const px = Math.cos(a0) * r, py = Math.sin(a0) * r;
    const tx = Math.sin(a0), ty = -Math.cos(a0); // counterclockwise tangent
    const rx = Math.cos(a0), ry = Math.sin(a0);  // outward
    g.polygon('fill',
      px + tx * 14, py + ty * 14,
      px + rx * 11, py + ry * 11,
      px - rx * 11, py - ry * 11);
    // Clock hands.
    g.setLineWidth(5);
    g.line(0, 0, 0, -14);
    g.line(0, 0, 10, 5);
    g.circle('fill', 0, 0, 4, 12);
  },
};

// ---------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------
WeaponBar.draw = function () {
  const g = love.graphics;
  const current = state.weaponMode ?? 'fireball';
  const touch = !!state.touchControlsVisible;
  const k0 = touch ? TOUCH_SCALE : 1;
  // Its full width, for centering it: every box at its current size.
  let total = 0;
  for (const mode of WeaponModes.ORDER) {
    const target = mode === current ? SELECTED_SCALE : 1;
    total += BOX_SIZE * k0 * (scales[mode] ?? target) + GAP;
  }
  total -= GAP;
  const top = MARGIN;
  const bottom = g.getHeight() - MARGIN;
  let x = touch ? (g.getWidth() - total) / 2 : MARGIN;
  boxes = [];

  g.push('all');
  for (const mode of WeaponModes.ORDER) {
    const selected = mode === current;
    const target = selected ? SELECTED_SCALE : 1;
    let s = scales[mode] ?? target;
    s += (target - s) * EASE;
    if (Math.abs(target - s) < 0.002) s = target;
    scales[mode] = s;

    // How far along this box is toward "selected", 0..1, for brightness.
    const t = (s - 1) / (SELECTED_SCALE - 1);
    dim = DIM + (1 - DIM) * t;
    const size = BOX_SIZE * k0 * s;
    // (Hanging from the top edge with the touch controls; standing on the
    // bottom edge otherwise.)
    const y = touch ? top : bottom - size;
    boxes.push({ mode, x, y, size });
    const corner = size * CORNER;

    // Box: dark backing, white outline.
    g.setColor(0, 0, 0, 0.45 + 0.15 * t);
    g.rectangle('fill', x, y, size, size, corner, corner);
    col(1, 1, 1);
    g.setLineWidth(2 + t);
    g.setLineStyle('smooth');
    g.rectangle('line', x, y, size, size, corner, corner);

    // Icon, scaled from its 100x100 design box to fit inside with padding.
    g.push();
    g.translate(x + size / 2, y + size / 2);
    const k = size / 100 * 0.82;
    g.scale(k, k);
    ICONS[mode]();
    g.pop();

    x += size + GAP;
  }
  g.pop();
};

// The mode whose box is at screen point (x, y), as last drawn — or null.
WeaponBar.modeAt = function (x, y) {
  if (state.dialogueActive) return null; // (hidden then — see main.js)
  for (const b of boxes) {
    if (x >= b.x && x <= b.x + b.size && y >= b.y && y <= b.y + b.size) return b.mode;
  }
  return null;
};

// One mode's icon on its own, `size` across, centered on (x, y) — for
// the touch controls' aim stick and pull button. brightness 0..1.
WeaponBar.drawIcon = function (mode, x, y, size, brightness = 1) {
  if (!ICONS[mode]) return;
  const g = love.graphics;
  g.push('all');
  g.translate(x, y);
  g.scale(size / 100, size / 100);
  dim = brightness;
  ICONS[mode]();
  dim = 1;
  g.pop();
};

export default WeaponBar;
