// js/entities/world/Fireball.js
import { Entity } from '../Entity.js';
import { state } from '../../state.js';
import { Vector2 } from '../../vector2.js';

const FIREBALL_SPEED = 14;
const FIREBALL_LIFE = 70; // frames
const TRAIL_SPAWN_CHANCE = 0.9;
const TRAIL_PARTICLE_LIFE_MIN = 14;
const TRAIL_PARTICLE_LIFE_RANGE = 12;
const OFFSCREEN_MARGIN = 400; // world-space margin before a stray shot is culled

// ----------------------------
// SHARED GLOW SPRITE (perf)
// ----------------------------
// The glowing core is identical for every fireball — only position
// changes — so it's baked ONCE into a shared offscreen canvas (same
// trick used for planets and the astronaut's body parts) instead of
// paying for a live shadowBlur on every fireball, every frame. Built
// lazily on first use.
let fireballSprite = null;
function getFireballSprite() {
  if (fireballSprite) return fireballSprite;

  const size = 14;    // outer glow radius
  const core = 8;      // bright inner radius
  const padding = 24;  // room for the baked blur to fall off into

  const canvas = document.createElement('canvas');
  canvas.width = (size + padding) * 2;
  canvas.height = (size + padding) * 2;
  const ctx = canvas.getContext('2d');
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;

  ctx.shadowBlur = 20;
  ctx.shadowColor = '#ff4400';
  ctx.fillStyle = '#ffaa00';
  ctx.beginPath();
  ctx.arc(cx, cy, size, 0, Math.PI * 2);
  ctx.fill();

  ctx.shadowBlur = 12;
  ctx.shadowColor = '#ffee00';
  ctx.fillStyle = '#ffff88';
  ctx.beginPath();
  ctx.arc(cx, cy, core, 0, Math.PI * 2);
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fill();

  fireballSprite = canvas;
  return canvas;
}

export class Fireball extends Entity {
  constructor(x, y, angle) {
    super();
    this.pos = new Vector2(x, y);
    this.vel = new Vector2(Math.cos(angle), Math.sin(angle)).multiply(FIREBALL_SPEED);
    this.life = FIREBALL_LIFE;
    this.trail = [];
    // Collision radius, used by CollisionSystem.handleFireballCollisions.
    // Roughly matches the bright core of the sprite rather than the
    // full outer glow, so hits feel fair rather than overly generous.
    this.radius = 8;
  }

  get isDead() {
    return this.life <= 0;
  }

  update() {
    this.pos.add(this.vel);
    this.life--;

    if (Math.random() < TRAIL_SPAWN_CHANCE) {
      const spread = 10;
      const maxLife = TRAIL_PARTICLE_LIFE_MIN + Math.random() * TRAIL_PARTICLE_LIFE_RANGE;
      this.trail.push({
        x: this.pos.x + (Math.random() - 0.5) * spread,
        y: this.pos.y + (Math.random() - 0.5) * spread * 0.8,
        life: maxLife,
        maxLife,
        size: 3 + Math.random() * 6
      });
    }

    for (let i = this.trail.length - 1; i >= 0; i--) {
      this.trail[i].life--;
      if (this.trail[i].life <= 0) this.trail.splice(i, 1);
    }

    if (
      this.pos.x < -OFFSCREEN_MARGIN || this.pos.x > state.sceneWidth + OFFSCREEN_MARGIN ||
      this.pos.y < -OFFSCREEN_MARGIN || this.pos.y > state.sceneHeight + OFFSCREEN_MARGIN
    ) {
      this.life = 0;
    }
  }

  draw() {
    const ctx = state.ctx;

    // Trail: cheap live-drawn circles, no shadow — only the shared
    // core sprite below uses a (pre-baked) glow.
    for (const t of this.trail) {
      const a = t.life / t.maxLife;
      const ts = t.size * a;
      ctx.globalAlpha = a * 0.85;
      ctx.fillStyle = '#ff5500';
      ctx.beginPath();
      ctx.arc(t.x, t.y, ts * 1.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffcc44';
      ctx.beginPath();
      ctx.arc(t.x, t.y, ts * 0.75, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    const sprite = getFireballSprite();
    ctx.drawImage(sprite, this.pos.x - sprite.width / 2, this.pos.y - sprite.height / 2);
  }
}