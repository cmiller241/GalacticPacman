// js/world/Lever.js
//
// A ground-mounted pull-lever: a half-circle base plate (flat side
// resting on the ground) with a handle that pivots between an
// angled-left ("off"/closed) and angled-right ("on"/open) resting
// position. Placed on the ground the same way Ooomba is (see main.js's
// own spawn loop — the Tiled object's point is raycast straight down
// onto whatever TerrainShape surface sits below it).
//
// Controls a single Gate, named in Tiled via this Lever object's own
// "gate" custom property — resolved to the actual spawned Gate in
// main.js and stored on this.gate. Pulling the lever toggles that gate
// open/closed.

import love from '../love/index.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import InteractPrompt from '../ui/InteractPrompt.js';

const BASE_RADIUS = 40;
const HANDLE_LENGTH = 46;
const HANDLE_KNOB_RADIUS = 8;

// Both measured from straight up (-pi/2; 0 = +x/right, increasing
// clockwise since y grows downward) — the handle rests at ANGLE_OFF
// while closed, and swings to ANGLE_ON once pulled.
const ANGLE_UP = -Math.PI / 2;
const ANGLE_SPREAD = Math.PI / 5; // ~36 degrees either side of straight up
const ANGLE_OFF = ANGLE_UP - ANGLE_SPREAD; // angled left
const ANGLE_ON = ANGLE_UP + ANGLE_SPREAD;  // angled right

const HANDLE_SWING_SPEED = 0.12; // radians per baseline (60fps) tick

// Metal, lit from above (see baseMesh): its top and bottom shades.
const COLOR_BASE_TOP = [0.44, 0.45, 0.48];
const COLOR_BASE_BOTTOM = [0.16, 0.16, 0.18];
const COLOR_OUTLINE = [0.07, 0.07, 0.08];
const COLOR_FOOT = [0.22, 0.22, 0.24];
const COLOR_SLOT = [0.05, 0.05, 0.06];
const COLOR_SHAFT = [0.62, 0.64, 0.68];
const COLOR_SHAFT_SHADE = [0.3, 0.31, 0.34];
const COLOR_HANDLE = [0.75, 0.15, 0.12];
const COLOR_PIVOT = [0.12, 0.12, 0.13];
const COLOR_LAMP_OFF = [1, 0.2, 0.12];  // lit while the lever's off
const COLOR_LAMP_ON = [0.25, 1, 0.35];  // lit while it's on

const SLOT_RADIUS = BASE_RADIUS * 0.62; // the arc slot the handle rides in
const LAMP_RADIUS = 4;
// Where the lamps sit on the dome: low on either side, clear of the
// handle's whole swing.
const LAMP_DIST = BASE_RADIUS * 0.76;
const LAMP_ANGLE_LEFT = Math.PI + 0.32;
const LAMP_ANGLE_RIGHT = Math.PI * 2 - 0.32;

const TOOLTIP_GAP_ABOVE = 26;

// The dome, as a fan (its centre on the ground line) coloured by height:
// a vertex colour that's linear in y interpolates to exactly linear in
// y across each triangle too, so this is an even top-lit gradient.
let baseMesh = null;
function getBaseMesh() {
  if (baseMesh) return baseMesh;
  const shade = (t) => [
    COLOR_BASE_BOTTOM[0] + (COLOR_BASE_TOP[0] - COLOR_BASE_BOTTOM[0]) * t,
    COLOR_BASE_BOTTOM[1] + (COLOR_BASE_TOP[1] - COLOR_BASE_BOTTOM[1]) * t,
    COLOR_BASE_BOTTOM[2] + (COLOR_BASE_TOP[2] - COLOR_BASE_BOTTOM[2]) * t,
  ];
  let [r, g, b] = shade(0);
  const verts = [[0, 0, 0, 0, r, g, b, 1]];
  const SEGMENTS = 32;
  for (let i = 0; i <= SEGMENTS; i++) {
    const a = Math.PI + (i / SEGMENTS) * Math.PI;
    const vy = Math.sin(a) * BASE_RADIUS;
    [r, g, b] = shade(-vy / BASE_RADIUS);
    verts.push([Math.cos(a) * BASE_RADIUS, vy, 0, 0, r, g, b, 1]);
  }
  baseMesh = love.graphics.newMesh(verts, 'fan', 'static');
  return baseMesh;
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

// A status lamp: lit (with a soft glow round it) or dark glass.
function drawLamp(x, y, color, lit) {
  love.graphics.setColor(COLOR_OUTLINE);
  love.graphics.circle('fill', x, y, LAMP_RADIUS + 1.5);
  if (lit) {
    love.graphics.setBlendMode('add');
    for (let i = 3; i >= 1; i--) {
      love.graphics.setColor(color[0], color[1], color[2], 0.12);
      love.graphics.circle('fill', x, y, LAMP_RADIUS + i * 3);
    }
    love.graphics.setBlendMode('alpha');
    love.graphics.setColor(color);
    love.graphics.circle('fill', x, y, LAMP_RADIUS);
    love.graphics.setColor(1, 1, 1, 0.8);
    love.graphics.circle('fill', x - 1, y - 1, LAMP_RADIUS * 0.4);
  } else {
    love.graphics.setColor(color[0] * 0.25, color[1] * 0.25, color[2] * 0.25, 1);
    love.graphics.circle('fill', x, y, LAMP_RADIUS);
  }
}

class Lever {
  // x, y: world position of the lever's own ground anchor (the flat
  // base's own center).
  static new(x, y) {
    return new Lever(x, y);
  }

  constructor(x, y) {
    this.pos = new Vector2(x, y);
    // Which Gate this lever opens/closes — set by main.js once both
    // lists exist. this.gateId is the raw Tiled id, set right after
    // Lever.new returns.
    this.gate = null;
    this.gateId = null;

    // False = closed/off (handle angled left).
    this.isOn = false;
    this.handleAngle = ANGLE_OFF;

    this.interactRadius = 140;
    this.playerNearby = false;
  }

  isPlayerNear(player) {
    if (!player) return false;
    const dx = player.pos.x - this.pos.x, dy = player.pos.y - this.pos.y;
    return (dx * dx + dy * dy) <= this.interactRadius * this.interactRadius;
  }

  // Actually flips the lever and whatever Gate it controls — shared by
  // tryInteract (the player pulling it directly) and
  // CollisionSystem.handleFireballLeverCollisions (a fireball hitting it).
  engage() {
    this.isOn = !this.isOn;
    if (this.gate) this.gate.setOpen(this.isOn);
  }

  // Called from InputHandlers.js (Enter) and GamePadInput.js (Circle).
  tryInteract(player) {
    if (!this.isPlayerNear(player)) return;
    this.engage();
  }

  update() {
    const timeScale = state.timeScale ?? 1;
    this.playerNearby = this.isPlayerNear(state.player);

    const target = this.isOn ? ANGLE_ON : ANGLE_OFF;
    if (this.handleAngle < target) {
      this.handleAngle = Math.min(target, this.handleAngle + HANDLE_SWING_SPEED * timeScale);
    } else if (this.handleAngle > target) {
      this.handleAngle = Math.max(target, this.handleAngle - HANDLE_SWING_SPEED * timeScale);
    }
  }

  draw() {
    const x = this.pos.x, y = this.pos.y;
    love.graphics.push('all');

    // Half-dome base, flat side down — angle range pi..2*pi sweeps left
    // -> straight up -> right. Shaded metal, outlined, with a highlight
    // along its upper-left edge.
    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.draw(getBaseMesh(), x, y);
    love.graphics.setLineWidth(1.5);
    love.graphics.setColor(1, 1, 1, 0.22);
    love.graphics.arc('line', 'open', x, y, BASE_RADIUS - 3, Math.PI * 1.08, Math.PI * 1.45);
    love.graphics.setLineWidth(2.5);
    love.graphics.setColor(COLOR_OUTLINE);
    love.graphics.arc('line', 'open', x, y, BASE_RADIUS, Math.PI, Math.PI * 2);

    // Foot plate along the ground, bolted down at both ends.
    const footW = BASE_RADIUS + 8, footH = 5;
    love.graphics.setColor(COLOR_FOOT);
    love.graphics.rectangle('fill', x - footW, y - footH, footW * 2, footH, 2, 2);
    love.graphics.setColor(COLOR_OUTLINE);
    love.graphics.setLineWidth(1.5);
    love.graphics.rectangle('line', x - footW, y - footH, footW * 2, footH, 2, 2);
    for (const side of [-1, 1]) {
      const bx = x + side * (footW - 4);
      love.graphics.setColor(0.55, 0.56, 0.58, 1);
      love.graphics.circle('fill', bx, y - footH / 2, 1.8);
    }

    // The slot the handle rides in, end to end of its swing.
    love.graphics.setColor(COLOR_SLOT);
    love.graphics.setLineWidth(6);
    love.graphics.setLineStyle('smooth');
    love.graphics.arc('line', 'open', x, y, SLOT_RADIUS, ANGLE_OFF, ANGLE_ON, 16);
    love.graphics.circle('fill', x + Math.cos(ANGLE_OFF) * SLOT_RADIUS, y + Math.sin(ANGLE_OFF) * SLOT_RADIUS, 3);
    love.graphics.circle('fill', x + Math.cos(ANGLE_ON) * SLOT_RADIUS, y + Math.sin(ANGLE_ON) * SLOT_RADIUS, 3);

    // Status lamps: red while off, green while on.
    drawLamp(x + Math.cos(LAMP_ANGLE_LEFT) * LAMP_DIST, y + Math.sin(LAMP_ANGLE_LEFT) * LAMP_DIST,
      COLOR_LAMP_OFF, !this.isOn);
    drawLamp(x + Math.cos(LAMP_ANGLE_RIGHT) * LAMP_DIST, y + Math.sin(LAMP_ANGLE_RIGHT) * LAMP_DIST,
      COLOR_LAMP_ON, this.isOn);

    // Handle, pivoting at the base's own center: a steel shaft ending in
    // a red ball knob.
    const cosA = Math.cos(this.handleAngle), sinA = Math.sin(this.handleAngle);
    const tipX = x + cosA * HANDLE_LENGTH;
    const tipY = y + sinA * HANDLE_LENGTH;
    const nx = -sinA, ny = cosA; // across the shaft
    love.graphics.setColor(COLOR_OUTLINE);
    love.graphics.setLineWidth(8);
    love.graphics.line(x, y, tipX, tipY);
    love.graphics.setColor(COLOR_SHAFT_SHADE);
    love.graphics.setLineWidth(5);
    love.graphics.line(x, y, tipX, tipY);
    love.graphics.setColor(COLOR_SHAFT);
    love.graphics.setLineWidth(2);
    love.graphics.line(x - nx * 1.2, y - ny * 1.2, tipX - nx * 1.2, tipY - ny * 1.2);
    drawKnob(tipX, tipY, HANDLE_KNOB_RADIUS, COLOR_HANDLE);

    // Pivot cap: a bolt head.
    love.graphics.setColor(COLOR_OUTLINE);
    love.graphics.circle('fill', x, y, 8);
    love.graphics.setColor(0.5, 0.51, 0.54, 1);
    love.graphics.circle('fill', x, y, 6);
    love.graphics.setColor(COLOR_PIVOT);
    love.graphics.circle('fill', x, y, 2.5);

    love.graphics.pop();
  }

  // World-space "you can interact with this" hint. Not shown while
  // curled into a ball.
  drawTooltip() {
    if (!this.playerNearby) return;
    if (state.player && state.player.isBall) return;

    InteractPrompt.draw(this.pos.x, this.pos.y - BASE_RADIUS - TOOLTIP_GAP_ABOVE);
  }
}

export default Lever;
