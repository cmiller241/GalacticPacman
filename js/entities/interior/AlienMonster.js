// js/entities/interior/AlienMonster.js
import { state } from '../../state.js';
import { Vector2 } from '../../vector2.js';
import { GRAVITY_STRENGTH } from '../../constants.js';

export class AlienMonster {
  constructor(interior, startPos, color = '#ff3333') {
    this.interior = interior;
    this.pos = startPos.clone();
    this.vel = new Vector2(0, 0);
    this.color = color;
    this.radius = 30;

    this.dir = Math.random() > 0.5 ? 1 : -1;
    this.speed = 1.6;
    this.onGround = false;
    this.wasOnGround = false;
    this.dropping = false;
  }

  isSolid(x, y) {
    const ts = this.interior.tileSize;
    const col = Math.floor(x / ts);
    const row = Math.floor(y / ts);
    return this.interior.tiles[row]?.[col] === '#';
  }

  update() {
    const ts = this.interior.tileSize;

    // --- Horizontal movement ---
    this.vel.x = this.dir * this.speed;

    let newX = this.pos.x + this.vel.x;

    const left  = newX - this.radius;
    const right = newX + this.radius;
    const midY  = this.pos.y;

    if (this.vel.x < 0 && (this.isSolid(left, midY - this.radius + 2) || this.isSolid(left, midY))) {
      newX = Math.floor(left / ts) * ts + ts + this.radius;
      this.dir *= -1;
    } 
    else if (this.vel.x > 0 && (this.isSolid(right, midY - this.radius + 2) || this.isSolid(right, midY))) {
      newX = Math.floor(right / ts) * ts - this.radius;
      this.dir *= -1;
    }

    this.pos.x = newX;

    // --- Gravity ---
    this.vel.y += GRAVITY_STRENGTH;
    let newY = this.pos.y + this.vel.y;

    const leftFoot  = this.pos.x - this.radius + 3;
    const rightFoot = this.pos.x + this.radius - 3;
    const newBottom = newY + this.radius;
    const newTop    = newY - this.radius;

    this.wasOnGround = this.onGround;
    this.onGround = false;

    if (this.vel.y >= 0) {
      if (this.isSolid(leftFoot, newBottom) || this.isSolid(rightFoot, newBottom)) {
        newY = Math.floor(newBottom / ts) * ts - this.radius;
        this.vel.y = 0;
        this.onGround = true;
      }
    } 
    else {
      if (this.isSolid(leftFoot, newTop) || this.isSolid(rightFoot, newTop)) {
        newY = Math.floor(newTop / ts + 1) * ts + this.radius;
        this.vel.y = 0;
      }
    }

    this.pos.y = newY;

    // Turn around when landing (feels alive)
    if (this.onGround && !this.wasOnGround) {
      this.dir *= -1;
    }

    // Respawn if falling off
    if (this.pos.y > this.interior.rows * ts + 50) {
      this.pos.y = ts * 2;
      this.pos.x = ts * (8 + Math.random() * 10);
      this.vel.y = 0;
      this.dir = Math.random() > 0.5 ? 1 : -1;
    }
  }

draw() {
  const ctx = state.ctx;

  const offsetX = this.interior.planetoid.pos.x - (this.interior.cols * this.interior.tileSize / 2);
  const offsetY = this.interior.planetoid.pos.y - (this.interior.rows * this.interior.tileSize / 2);

  ctx.save();
  ctx.translate(offsetX + this.pos.x, offsetY + this.pos.y);

  // Flip based on direction
  if (this.dir < 0) ctx.scale(-1, 1);

  // Lift slightly so feet sit on platform
  ctx.translate(0, -this.radius * 0.3);

  // --- Body ---
  ctx.fillStyle = this.color;
  ctx.beginPath();
  ctx.ellipse(0, 0, this.radius, this.radius * 0.8, 0, 0, Math.PI * 2);
  ctx.fill();

  // --- Eyes (3 total) ---
  ctx.fillStyle = 'white';

  const eyeSizeSide  = this.radius * 0.24;
  const eyeSizeMid   = this.radius * 0.32;
  const pupilSizeSide = this.radius * 0.10;
  const pupilSizeMid  = this.radius * 0.14;

  // Left eye
  ctx.beginPath();
  ctx.arc(-this.radius * 0.62, -this.radius * 0.18, eyeSizeSide, 0, Math.PI * 2);
  ctx.fill();

  // Middle eye (bigger & higher)
  ctx.beginPath();
  ctx.arc(0, -this.radius * 0.42, eyeSizeMid, 0, Math.PI * 2);
  ctx.fill();

  // Right eye
  ctx.beginPath();
  ctx.arc(this.radius * 0.62, -this.radius * 0.18, eyeSizeSide, 0, Math.PI * 2);
  ctx.fill();

  // Pupils + tiny white glint in each
  ctx.fillStyle = 'black';

  // Left pupil + glint
  ctx.beginPath();
  ctx.arc(-this.radius * 0.62, -this.radius * 0.18, pupilSizeSide, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'white';
  ctx.beginPath();
  ctx.arc(-this.radius * 0.62 - pupilSizeSide*0.35, -this.radius * 0.18 - pupilSizeSide*0.35, pupilSizeSide*0.3, 0, Math.PI * 2);
  ctx.fill();

  // Middle pupil + glint
  ctx.fillStyle = 'black';
  ctx.beginPath();
  ctx.arc(0, -this.radius * 0.42, pupilSizeMid, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'white';
  ctx.beginPath();
  ctx.arc(0 - pupilSizeMid*0.35, -this.radius * 0.42 - pupilSizeMid*0.35, pupilSizeMid*0.32, 0, Math.PI * 2);
  ctx.fill();

  // Right pupil + glint
  ctx.fillStyle = 'black';
  ctx.beginPath();
  ctx.arc(this.radius * 0.62, -this.radius * 0.18, pupilSizeSide, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'white';
  ctx.beginPath();
  ctx.arc(this.radius * 0.62 - pupilSizeSide*0.35, -this.radius * 0.18 - pupilSizeSide*0.35, pupilSizeSide*0.3, 0, Math.PI * 2);
  ctx.fill();

  // --- Feet ---
  ctx.strokeStyle = this.color;
  ctx.lineWidth = 2;

  ctx.beginPath();
  ctx.moveTo(-this.radius * 0.4, this.radius * 0.8);
  ctx.lineTo(-this.radius * 0.4, this.radius * 1.2);

  ctx.moveTo(this.radius * 0.4, this.radius * 0.8);
  ctx.lineTo(this.radius * 0.4, this.radius * 1.2);
  ctx.stroke();

  ctx.restore();
}
}