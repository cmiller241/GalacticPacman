// js/entities/interior/BlobMonster.js
import { state } from '../../state.js';
import { Vector2 } from '../../vector2.js';
import { GRAVITY_STRENGTH } from '../../constants.js';

export class BlobMonster {
  constructor(interior, startPos, color = '#ff4400') {
    this.interior = interior;
    this.pos = startPos.clone();
    this.vel = new Vector2(0, 0);
    this.color = color;
    this.radius = 11;

    this.dir = Math.random() > 0.5 ? 1 : -1;   // start left or right
    this.speed = 1.9;
    this.onGround = false;
    this.wasOnGround = false;
    this.onLadder = false;
    this.dropping = false;  // Flag to allow dropping through platform to ladder
  }

  isSolid(x, y) {
    const ts = this.interior.tileSize;
    const col = Math.floor(x / ts);
    const row = Math.floor(y / ts);
    return this.interior.tiles[row]?.[col] === '#';
  }

  isLadder(x, y) {
    const ts = this.interior.tileSize;
    const col = Math.floor(x / ts);
    const row = Math.floor(y / ts);
    return this.interior.tiles[row]?.[col] === 'H';
  }

update() {
  const ts = this.interior.tileSize;

  // Disable horizontal movement while dropping
  if (!this.dropping) {
    this.vel.x = this.dir * this.speed;
  } else {
    this.vel.x = 0;
  }

  let newX = this.pos.x + this.vel.x;

  const left  = newX - this.radius;
  const right = newX + this.radius;
  const midY  = this.pos.y;

  // Wall collision (ignore ladders)
  if (!this.dropping) {
    if (this.vel.x < 0 && (this.isSolid(left, midY - this.radius + 2) || this.isSolid(left, midY))) {
      newX = Math.floor(left / ts) * ts + ts + this.radius;
      this.dir *= -1;
      this.vel.x = 0;
    } 
    else if (this.vel.x > 0 && (this.isSolid(right, midY - this.radius + 2) || this.isSolid(right, midY))) {
      newX = Math.floor(right / ts) * ts - this.radius;
      this.dir *= -1;
      this.vel.x = 0;
    }
  }

  this.pos.x = newX;

  // Gravity
  this.vel.y += GRAVITY_STRENGTH;
  let newY = this.pos.y + this.vel.y;

  const leftFoot  = this.pos.x - this.radius + 3;
  const rightFoot = this.pos.x + this.radius - 3;
  const newBottom = newY + this.radius;
  const newTop    = newY - this.radius;

  this.wasOnGround = this.onGround;
  this.onGround = false;

  // Determine tile rows
  const footRow = Math.floor((this.pos.y + this.radius) / ts);
  const newFootRow = Math.floor((newBottom) / ts);

  // Platform collision (one-way)
  if (this.vel.y >= 0) {

    const hittingPlatform =
      this.isSolid(leftFoot, newBottom) ||
      this.isSolid(rightFoot, newBottom);

    // Ignore ONLY the platform we intentionally dropped from
    const ignoringDropPlatform =
      this.dropping && newFootRow === this.dropRow;

    if (!ignoringDropPlatform && hittingPlatform) {
      newY = Math.floor(newBottom / ts) * ts - this.radius;
      this.vel.y = 0;
      this.onGround = true;
      this.dropping = false;
      this.dropRow = null;
    }
  }
  else if (this.vel.y < 0) {
    if (this.isSolid(leftFoot, newTop) || this.isSolid(rightFoot, newTop)) {
      newY = Math.floor(newTop / ts + 1) * ts + this.radius;
      this.vel.y = 0;
    }
  }

  this.pos.y = newY;

  // Reverse direction only when landing
  if (this.onGround && !this.wasOnGround) {
    this.dir *= -1;
    this.checkedLadder = false;
  }

  // === TILE POSITION ===
  const tileX = Math.floor(this.pos.x / ts);
  const currentFootRow = Math.floor((this.pos.y + this.radius) / ts);

  const tileHere  = this.interior.tiles[currentFootRow]?.[tileX];
  const tileBelow = this.interior.tiles[currentFootRow + 1]?.[tileX];

  const ladderBelowPlatform = tileHere === '#' && tileBelow === 'H';

  // === DONKEY KONG BARREL TRICK ===
  const tileCenterX = tileX * ts + ts / 2;

  const crossingLadderColumn =
    (this.dir > 0 && this.pos.x >= tileCenterX && !this.checkedLadder) ||
    (this.dir < 0 && this.pos.x <= tileCenterX && !this.checkedLadder);

  if (this.onGround && ladderBelowPlatform && crossingLadderColumn) {

    this.checkedLadder = true;

    if (Math.random() < 0.7) {

      // Start ladder drop
      this.dropping = true;
      this.dropRow = currentFootRow;

      this.vel.y = 3.5;

      // Snap to ladder center so fall is perfectly vertical
      this.pos.x = tileCenterX;
      this.vel.x = 0;
    }
  }

  // Reset ladder check when leaving column
  if (Math.abs(this.pos.x - tileCenterX) > ts / 2) {
    this.checkedLadder = false;
  }

  // Respawn if falling too far
  if (this.pos.y > this.interior.rows * ts + 50) {
    this.pos.y = ts * 1.5;
    this.pos.x = ts * (10 + Math.random() * 8);
    this.vel.y = 0;
    this.dir = Math.random() > 0.5 ? 1 : -1;
    this.dropping = false;
    this.dropRow = null;
    this.checkedLadder = false;
  }
}

  draw() {
    const ctx = state.ctx;
    const offsetX = this.interior.planetoid.pos.x - (this.interior.cols * this.interior.tileSize / 2);
    const offsetY = this.interior.planetoid.pos.y - (this.interior.rows * this.interior.tileSize / 2);

    ctx.save();
    ctx.translate(offsetX + this.pos.x, offsetY + this.pos.y);

    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.beginPath();
    ctx.arc(-4, -5, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }
}