// js/entities/Player.js
import { Entity } from './Entity.js';
import { state } from '../state.js';
import {
  GRAVITY_STRENGTH,
  GROUND_POUND_GRAV_MULTIPLIER,
  GROUND_POUND_PUSH_STRENGTH,
  JUMP_STRENGTH,
  PLAYER_LINEAR_SPEED,
  PLAYER_RADIUS,
  SURFACE_TOLERANCE,
  DRAG
} from '../constants.js';
import { Vector2 } from '../vector2.js';
import {
  createDeathParticles,
  createParticles
} from '../utils.js';

export class Player extends Entity {
  constructor(x, y) {
    super();
    this.pos = new Vector2(x, y);
    this.vel = new Vector2(0, 0);
    this.radius = PLAYER_RADIUS;
    this.onSurface = false;
    this.currentPlanet = null;
    this.lastInfluencePlanet = null;
    this.angle = 0;
    // Jelly animation (see squash()).
    this.walkPhase = 0;
    this.landTime = -1e9;
    // (Starts true so his first moment on his starting planet isn't a "landing".)
    this.wasOnSurface = true;
    this.facingDirection = 1;
    this.moveDirection = 0; // see setMoveDirection
    this.isGroundPounding = false;
    this.isDying = false;
    this.deathStartTime = 0;
    this.deathDuration = 1200;
    this.deathScale = 1;
    this.deathRotation = 0;
    this.deathAlpha = 1;
  }

  // ----------------------------
  // DEATH
  // ----------------------------
  startDeath() {
    if (!this.isDying) {
      this.isDying = true;
      this.deathStartTime = Date.now();
      this.deathScale = 1;
      this.deathRotation = 0;
      this.deathAlpha = 1;
      createDeathParticles(this.pos, 400);
      state.audioManager.playDeath();
    }
  }

  applyGravity() {
    if (this.onSurface) return;
    let planet = state.gravitySystem.findDominantPlanet(this.pos);
    if (!planet && this.lastInfluencePlanet) planet = this.lastInfluencePlanet;
    if (planet) {
      this.lastInfluencePlanet = planet;
      const direction = planet.pos.subtract(this.pos).normalize();
      let grav = GRAVITY_STRENGTH;
      if (this.isGroundPounding) grav *= GROUND_POUND_GRAV_MULTIPLIER;
      this.vel.add(direction.multiply(grav));
    }
  }

  // Which way he's walking, set every step from the held controls:
  // 1 = clockwise (right), -1 = counter-clockwise (left), 0 = standing
  // still. He keeps facing the way he last walked.
  setMoveDirection(dir) {
    this.moveDirection = dir;
    if (dir !== 0) this.facingDirection = dir;
  }

  move() {
    // ----------------------------
    // PLANET SURFACE
    // ----------------------------
    if (this.onSurface && this.currentPlanet) {
      const surfaceDist = this.currentPlanet.radius + this.radius;
      const angularSpeed = PLAYER_LINEAR_SPEED / surfaceDist;

      // (Screen y points down, so a growing angle is clockwise.)
      this.angle += angularSpeed * this.moveDirection;
      this.pos.x = this.currentPlanet.pos.x + Math.cos(this.angle) * surfaceDist;
      this.pos.y = this.currentPlanet.pos.y + Math.sin(this.angle) * surfaceDist;
    }
  }

  jump() {
    if (this.onSurface && this.currentPlanet) {
      const direction = this.pos.subtract(this.currentPlanet.pos).normalize();
      this.vel = direction.multiply(JUMP_STRENGTH);
      this.onSurface = false;
      this.currentPlanet = null;
      state.audioManager.playJump();
    }
  }

  tryGroundPound() {
    if (this.isGroundPounding) return;
    let planet = state.gravitySystem.findDominantPlanet(this.pos) || this.lastInfluencePlanet;
    if (planet) {
      const outwardDir = this.pos.subtract(planet.pos).normalize();
      const radialVel = this.vel.dot(outwardDir);
      if (radialVel > 0) this.isGroundPounding = true;
    }
  }

  update() {
    // ----------------------------
    // DEATH
    // ----------------------------
    if (this.isDying) {
      const elapsed = Date.now() - this.deathStartTime;
      const t = Math.min(elapsed / this.deathDuration, 1);
      this.deathScale = 1 - (t*t*t);
      this.deathRotation += 0.2;
      this.deathAlpha = 1 - t;
      if (t >= 1) state.gameOver = true;
      return;
    }

    // ----------------------------
    // PLANET MOVEMENT
    // ----------------------------
    if (!this.onSurface) {
      this.vel = this.vel.multiply(DRAG);
      this.pos.add(this.vel);

      if (this.pos.x - this.radius < 0) { this.pos.x = this.radius; this.vel.x = -this.vel.x; }
      if (this.pos.x + this.radius > state.sceneWidth) { this.pos.x = state.sceneWidth - this.radius; this.vel.x = -this.vel.x; }
      if (this.pos.y - this.radius < 0) { this.pos.y = this.radius; this.vel.y = -this.vel.y; }
      if (this.pos.y + this.radius > state.sceneHeight) { this.pos.y = state.sceneHeight - this.radius; this.vel.y = -this.vel.y; }
    }

    // ----------------------------
    // JELLY ANIMATION
    // ----------------------------
    // Squish as he moves along the ground (the faster round the planet, the
    // quicker the wobble).
    if (this.onSurface && this.moveDirection !== 0) this.walkPhase += 0.32;
    // Landing: a springy wobble that dies away.
    if (this.onSurface && !this.wasOnSurface) this.landTime = performance.now();
    this.wasOnSurface = this.onSurface;
  }

  // How squashed he is right now: > 0 wider and shorter, < 0 taller and
  // thinner.
  squash() {
    let s = 0;
    if (this.onSurface && this.moveDirection !== 0) s += Math.sin(this.walkPhase) * 0.05;
    const sinceLanding = (performance.now() - this.landTime) / 1000;
    if (sinceLanding < 0.8) s += Math.sin(sinceLanding * 22) * 0.22 * Math.exp(-sinceLanding * 6);
    // Flying: stretched along his path a little.
    if (!this.onSurface) s -= 0.06;
    return s;
  }

  // The blob, drawn round the current origin, with +y pointing down toward
  // the ground (the planet) and +x the way clockwise walking goes.
  drawBlob(ctx) {
    const r = this.radius;
    const sq = this.squash();
    const rx = r * (1.06 + sq), ry = r * (0.94 - sq);
    // Sitting on the ground: the bottom of the blob stays at +r.
    const cy = r - ry;

    // Body: lime jelly, lit from the upper left, deeper green at the rim.
    const body = ctx.createRadialGradient(-rx * 0.3, cy - ry * 0.4, r * 0.1, 0, cy, Math.max(rx, ry) * 1.05);
    body.addColorStop(0, BLOB_LIGHT);
    body.addColorStop(0.55, BLOB_COLOR);
    body.addColorStop(1, BLOB_RIM);
    ctx.beginPath();
    ctx.ellipse(0, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = body;
    ctx.fill();
    ctx.lineWidth = Math.max(1.2, r * 0.06);
    ctx.strokeStyle = BLOB_OUTLINE;
    ctx.stroke();

    // Sheen: a soft glossy streak and a small glint, upper left.
    ctx.save();
    ctx.translate(-rx * 0.36, cy - ry * 0.48);
    ctx.rotate(-0.55);
    ctx.beginPath();
    ctx.ellipse(0, 0, rx * 0.3, ry * 0.14, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(-rx * 0.62, cy - ry * 0.08, r * 0.065, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fill();

    // Eyes: two black ovals, glancing the way he's going, blinking now
    // and then.
    const look = this.facingDirection * r * 0.09;
    // (Squeezed hard, he scrunches his eyes shut.)
    const blink = this.squeezed || (performance.now() % BLINK_EVERY_MS) < BLINK_MS ? 0.15 : 1;
    const eyeY = cy - ry * 0.02, eyeRx = r * 0.12, eyeRy = r * 0.18 * blink;
    for (const side of [-1, 1]) {
      const ex = side * r * 0.3 + look;
      ctx.beginPath();
      ctx.ellipse(ex, eyeY, eyeRx, eyeRy, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#111';
      ctx.fill();
      if (blink === 1) {
        // A tiny catchlight, so they read as shiny.
        ctx.beginPath();
        ctx.arc(ex - eyeRx * 0.3, eyeY - eyeRy * 0.4, eyeRx * 0.38, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
      }
    }
  }

  // Is another planet pressing in on him (he's standing on one, and
  // another has come closer than the top of him)? Returns how squished he
  // is — amount 1 = not at all, down to SQUEEZE_MIN — or null. Purely how
  // he's drawn: it doesn't hurt him.
  squeezeFrom() {
    const r = this.radius;
    let best = null, bestGap = r;
    for (const p of state.planetoids) {
      if (p === this.currentPlanet || p.isSpikey) continue;
      const dx = p.pos.x - this.pos.x, dy = p.pos.y - this.pos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const gap = dist - p.radius; // from his middle to that planet's surface
      if (gap < bestGap && dist > 0) { bestGap = gap; best = { dirX: dx / dist, dirY: dy / dist }; }
    }
    if (!best) return null;
    // He's 2r tall; with only r + gap of room, squash to fit...
    const fit = Math.max(SQUEEZE_MIN, (r + bestGap) / (2 * r));
    // ...fully when the other planet is right overhead, less when it's
    // pressing in from the side (then there's more room straight up).
    const upX = this.pos.x - this.currentPlanet.pos.x, upY = this.pos.y - this.currentPlanet.pos.y;
    const upLen = Math.sqrt(upX * upX + upY * upY) || 1;
    const overhead = Math.max(0, Math.min(1, ((best.dirX * upX + best.dirY * upY) / upLen) * 1.3));
    best.amount = 1 - (1 - fit) * overhead;
    return best.amount < 0.999 ? best : null;
  }

  draw() {
    const ctx = state.ctx;

    // Feet toward the planet he's on (or the one pulling him).
    const planet = this.onSurface ? this.currentPlanet : this.lastInfluencePlanet;
    let downAngle = Math.PI / 2;
    if (planet) downAngle = Math.atan2(planet.pos.y - this.pos.y, planet.pos.x - this.pos.x);

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);

    if (this.isDying) {
      // Spins, shrinks and fades, with a green glow.
      ctx.globalAlpha = this.deathAlpha;
      ctx.rotate(this.deathRotation);
      ctx.scale(this.deathScale, this.deathScale);
      ctx.shadowColor = BLOB_COLOR;
      ctx.shadowBlur = 30 * (this.deathAlpha * 0.5);
      this.drawBlob(ctx);
      ctx.restore();
      return;
    }

    const frame = downAngle - Math.PI / 2;
    ctx.rotate(frame);
    // Squished between his planet and another one pressing in on him.
    this.squeezed = false;
    const squeeze = this.onSurface ? this.squeezeFrom() : null;
    if (squeeze) {
      // Pressed down flat onto his own planet (his base stays planted),
      // bulging out sideways like jelly.
      const r = this.radius;
      ctx.translate(0, r);
      ctx.scale(Math.min(SQUEEZE_MAX_BULGE, 1 / Math.sqrt(squeeze.amount)), squeeze.amount);
      ctx.translate(0, -r);
      this.squeezed = squeeze.amount < SQUEEZE_SQUINT;
    }
    // Leans a touch into the way he's walking (pivoting on his bottom).
    if (this.onSurface && this.moveDirection !== 0) {
      ctx.translate(0, this.radius);
      ctx.rotate(this.moveDirection * LEAN);
      ctx.translate(0, -this.radius);
    }
    this.drawBlob(ctx);
    ctx.restore();
  }
}

// The blob's colors: a bright, saturated lime.
const BLOB_COLOR = '#6cf01a';
const BLOB_LIGHT = '#c4ff7a';
const BLOB_RIM = '#3faa00';
const BLOB_OUTLINE = '#2a7a00';
const LEAN = 0.12; // radians
// Squished between planets: never flatter than this (fraction of his
// height), never bulging wider than this, and eyes scrunched shut below
// SQUEEZE_SQUINT.
const SQUEEZE_MIN = 0.22;
const SQUEEZE_MAX_BULGE = 1.6;
const SQUEEZE_SQUINT = 0.7;
// Blinks: every BLINK_EVERY_MS, for BLINK_MS.
const BLINK_EVERY_MS = 3200;
const BLINK_MS = 120;
