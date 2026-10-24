// js/world/Crank.js
//
// A ground-mounted crank wheel: a short post topped with a circular
// dial and a handle on its rim. Placed on the ground the same way
// Lever.js is (raycast straight down onto the terrain below). this.pos.x
// is the wheel's own horizontal center.
//
// Each interact press gives it one crank: the handle sweeps CRANK_STEP
// radians further around (always the same direction — a crank doesn't
// wind back), easing into place rather than snapping. If this crank
// names a Mirror via its own Tiled "Mirror" custom property (resolved
// to this.mirror by main.js's own spawn wiring), that Mirror is cranked
// by the exact same step at the same time — see js/world/Mirror.js.
// this.turns counts completed full rotations of the HANDLE.

import love from '../love/index.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import InteractPrompt from '../ui/InteractPrompt.js';

const POST_WIDTH = 10;
const POST_HEIGHT = 34;
const WHEEL_RADIUS = 26;
const SPOKE_COUNT = 4;
const HANDLE_LENGTH = 16; // sticks out past the wheel's own rim
const HANDLE_KNOB_RADIUS = 7;

const CRANK_STEP = Math.PI / 18; // 10 degrees per interact press
const HANDLE_SWING_SPEED = 0.2;  // radians per baseline (60fps) tick

const COLOR_POST_EDGE = [0.15, 0.15, 0.17];   // the post's shaded sides...
const COLOR_POST_LIGHT = [0.5, 0.51, 0.54];   // ...and its lit middle (a cylinder)
const COLOR_OUTLINE = [0.07, 0.07, 0.08];
const COLOR_FOOT = [0.22, 0.22, 0.24];
const COLOR_WHEEL_FACE = [0.1, 0.1, 0.11];    // the dark recess behind the spokes
const COLOR_RIM = [0.42, 0.43, 0.46];
const COLOR_RIM_LIGHT = [0.7, 0.72, 0.75];
const COLOR_SPOKE = [0.36, 0.37, 0.4];
const COLOR_HANDLE = [0.75, 0.15, 0.12];
const COLOR_PIVOT = [0.12, 0.12, 0.13];

const GRIP_COUNT = 12; // grip bumps round the rim, turning with it

const TOOLTIP_GAP_ABOVE = 26;

// The post, as a mesh: shaded at both sides, lit down the middle, so it
// reads as a round pillar. Drawn from its top-centre.
let postMesh = null;
function getPostMesh(height) {
  if (postMesh) return postMesh;
  const w = POST_WIDTH / 2;
  const e = COLOR_POST_EDGE, l = COLOR_POST_LIGHT;
  postMesh = love.graphics.newMesh([
    [-w, 0, 0, 0, e[0], e[1], e[2], 1],
    [-w * 0.2, 0, 0, 0, l[0], l[1], l[2], 1],
    [w, 0, 0, 0, e[0], e[1], e[2], 1],
    [w, height, 0, 0, e[0], e[1], e[2], 1],
    [-w * 0.2, height, 0, 0, l[0], l[1], l[2], 1],
    [-w, height, 0, 0, e[0], e[1], e[2], 1],
  ], 'triangles', 'static');
  postMesh.setVertexMap(0, 1, 5, 1, 4, 5, 1, 2, 4, 2, 3, 4);
  return postMesh;
}

// A red ball knob, shaded as if lit from the upper left.
function drawKnob(x, y, radius, color) {
  love.graphics.setColor(color[0] * 0.45, color[1] * 0.45, color[2] * 0.45, 1);
  love.graphics.circle('fill', x, y, radius + 1);
  love.graphics.setColor(color);
  love.graphics.circle('fill', x - radius * 0.12, y - radius * 0.12, radius * 0.85);
  love.graphics.setColor(Math.min(1, color[0] + 0.25), color[1] + 0.2, color[2] + 0.15, 1);
  love.graphics.circle('fill', x - radius * 0.28, y - radius * 0.28, radius * 0.45);
  love.graphics.setColor(1, 1, 1, 0.85);
  love.graphics.circle('fill', x - radius * 0.38, y - radius * 0.4, radius * 0.18);
}

class Crank {
  // x, y: world position of the crank's own ground anchor (where the
  // post meets the ground).
  static new(x, y) {
    return new Crank(x, y);
  }

  constructor(x, y) {
    this.pos = new Vector2(x, y);
    this.wheelCenterY = y - POST_HEIGHT - WHEEL_RADIUS;

    this.angle = 0;
    this.targetAngle = 0;
    this.turns = 0;

    // this.mirrorId: the raw Tiled id of the Mirror this crank drives;
    // this.mirror: the actual Mirror instance (set by main.js's own
    // spawn wiring).
    this.mirrorId = null;
    this.mirror = null;

    this.interactRadius = 140;
    this.playerNearby = false;
  }

  isPlayerNear(player) {
    if (!player) return false;
    const dx = player.pos.x - this.pos.x, dy = player.pos.y - this.pos.y;
    return (dx * dx + dy * dy) <= this.interactRadius * this.interactRadius;
  }

  // Called from InputHandlers.js (Enter) and GamePadInput.js (Circle).
  tryInteract(player) {
    if (!this.isPlayerNear(player)) return;
    this.targetAngle += CRANK_STEP;
    if (this.mirror) this.mirror.crank(CRANK_STEP);
  }

  update() {
    const timeScale = state.timeScale ?? 1;
    this.playerNearby = this.isPlayerNear(state.player);

    if (this.angle < this.targetAngle) {
      this.angle = Math.min(this.targetAngle, this.angle + HANDLE_SWING_SPEED * timeScale);
    }

    this.turns = Math.floor(this.angle / (Math.PI * 2));
  }

  draw() {
    const x = this.pos.x, groundY = this.pos.y;
    const wheelY = this.wheelCenterY;
    love.graphics.push('all');
    love.graphics.setLineStyle('smooth');

    // Post connecting the wheel down to the ground anchor: a round
    // pillar, with a collar where it meets a bolted foot plate.
    love.graphics.setColor(COLOR_OUTLINE);
    love.graphics.rectangle('fill', x - POST_WIDTH / 2 - 1.5, wheelY, POST_WIDTH + 3, groundY - wheelY);
    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.draw(getPostMesh(groundY - wheelY), x, wheelY);
    const footW = POST_WIDTH * 1.8, footH = 6;
    love.graphics.setColor(COLOR_FOOT);
    love.graphics.polygon('fill', x - footW, groundY, x + footW, groundY,
      x + footW * 0.6, groundY - footH, x - footW * 0.6, groundY - footH);
    love.graphics.setColor(COLOR_OUTLINE);
    love.graphics.setLineWidth(1.5);
    love.graphics.polygon('line', x - footW, groundY, x + footW, groundY,
      x + footW * 0.6, groundY - footH, x - footW * 0.6, groundY - footH);
    love.graphics.setColor(1, 1, 1, 0.15);
    love.graphics.line(x - footW * 0.6, groundY - footH + 1, x + footW * 0.6, groundY - footH + 1);
    for (const side of [-1, 1]) {
      love.graphics.setColor(0.55, 0.56, 0.58, 1);
      love.graphics.circle('fill', x + side * footW * 0.72, groundY - footH * 0.4, 1.6);
    }

    // Wheel: a dark recess behind thick spokes, a heavy rim with grip
    // bumps (both turning with the handle), lit from the upper left.
    const rimW = 5;
    const innerR = WHEEL_RADIUS - rimW / 2;
    love.graphics.setColor(COLOR_WHEEL_FACE);
    love.graphics.circle('fill', x, wheelY, innerR);

    for (let i = 0; i < SPOKE_COUNT; i++) {
      const a = this.angle + (i / SPOKE_COUNT) * Math.PI * 2;
      const sx = x + Math.cos(a) * innerR;
      const sy = wheelY + Math.sin(a) * innerR;
      love.graphics.setColor(COLOR_OUTLINE);
      love.graphics.setLineWidth(6);
      love.graphics.line(x, wheelY, sx, sy);
      love.graphics.setColor(COLOR_SPOKE);
      love.graphics.setLineWidth(3.5);
      love.graphics.line(x, wheelY, sx, sy);
    }

    for (let i = 0; i < GRIP_COUNT; i++) {
      const a = this.angle + (i + 0.5) / GRIP_COUNT * Math.PI * 2;
      love.graphics.setColor(COLOR_OUTLINE);
      love.graphics.circle('fill', x + Math.cos(a) * WHEEL_RADIUS, wheelY + Math.sin(a) * WHEEL_RADIUS, 3.6);
      love.graphics.setColor(COLOR_RIM);
      love.graphics.circle('fill', x + Math.cos(a) * WHEEL_RADIUS, wheelY + Math.sin(a) * WHEEL_RADIUS, 2.4);
    }
    love.graphics.setColor(COLOR_OUTLINE);
    love.graphics.setLineWidth(rimW + 3);
    love.graphics.circle('line', x, wheelY, WHEEL_RADIUS, 40);
    love.graphics.setColor(COLOR_RIM);
    love.graphics.setLineWidth(rimW);
    love.graphics.circle('line', x, wheelY, WHEEL_RADIUS, 40);
    // The light catching its upper left (fixed: the light doesn't turn).
    love.graphics.setColor(COLOR_RIM_LIGHT);
    love.graphics.setLineWidth(1.5);
    love.graphics.arc('line', 'open', x, wheelY, WHEEL_RADIUS - 0.5, Math.PI * 1.05, Math.PI * 1.55, 16);

    // Hub: a boss with a bolt in it.
    love.graphics.setColor(COLOR_OUTLINE);
    love.graphics.circle('fill', x, wheelY, 8);
    love.graphics.setColor(COLOR_RIM);
    love.graphics.circle('fill', x, wheelY, 6.5);
    love.graphics.setColor(COLOR_RIM_LIGHT);
    love.graphics.circle('fill', x - 1.2, wheelY - 1.2, 3.5);
    love.graphics.setColor(COLOR_PIVOT);
    love.graphics.circle('fill', x, wheelY, 2);

    // Handle, mounted on the wheel's rim, sticking out a bit past it: a
    // steel arm ending in a red ball knob.
    const cosA = Math.cos(this.angle), sinA = Math.sin(this.angle);
    const rimX = x + cosA * WHEEL_RADIUS;
    const rimY = wheelY + sinA * WHEEL_RADIUS;
    const tipX = x + cosA * (WHEEL_RADIUS + HANDLE_LENGTH);
    const tipY = wheelY + sinA * (WHEEL_RADIUS + HANDLE_LENGTH);
    love.graphics.setColor(COLOR_OUTLINE);
    love.graphics.setLineWidth(7);
    love.graphics.line(rimX, rimY, tipX, tipY);
    love.graphics.setColor(COLOR_SPOKE);
    love.graphics.setLineWidth(4);
    love.graphics.line(rimX, rimY, tipX, tipY);
    love.graphics.setColor(COLOR_OUTLINE);
    love.graphics.circle('fill', rimX, rimY, 4);
    love.graphics.setColor(COLOR_RIM_LIGHT);
    love.graphics.circle('fill', rimX, rimY, 2.5);
    drawKnob(tipX, tipY, HANDLE_KNOB_RADIUS, COLOR_HANDLE);

    love.graphics.pop();
  }

  // World-space "you can interact with this" hint. Not shown while
  // curled into a ball.
  drawTooltip() {
    if (!this.playerNearby) return;
    if (state.player && state.player.isBall) return;

    InteractPrompt.draw(this.pos.x, this.wheelCenterY - WHEEL_RADIUS - TOOLTIP_GAP_ABOVE);
  }
}

export default Crank;
