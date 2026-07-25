// js/entities/world/Explosion.js
import { Entity } from '../Entity.js';
import { state } from '../../state.js';
import { Vector2 } from '../../vector2.js';
import { createDeathParticles } from '../../utils.js';

const EXPLOSION_DURATION = 400; // ms
const RING_MAX_RADIUS = 70;
const FLASH_RADIUS = 30;
const FLASH_FRACTION = 0.3; // flash burns out over the first 30% of the duration
const PARTICLE_COUNT = 420;

export class Explosion extends Entity {
  constructor(x, y) {
    super();
    this.pos = new Vector2(x, y);
    this.startTime = Date.now();
    this.duration = EXPLOSION_DURATION;

    // Fiery particle burst — reuses the existing fire-colored death
    // particles rather than inventing a new particle style.
    createDeathParticles(this.pos.clone(), PARTICLE_COUNT);
  }

  get isDead() {
    return Date.now() - this.startTime >= this.duration;
  }

  update() {
    // Purely time-driven; nothing to simulate beyond the elapsed clock
    // read in draw().
  }

  draw() {
    const ctx = state.ctx;
    const t = Math.min((Date.now() - this.startTime) / this.duration, 1);
    const eased = 1 - Math.pow(1 - t, 3); // fast expand, settles near the end

    // Expanding, fading shockwave ring
    ctx.save();
    ctx.globalAlpha = 1 - t;
    ctx.strokeStyle = '#ffcc66';
    ctx.lineWidth = 4 * (1 - t) + 1;
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, eased * RING_MAX_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Bright core flash, burns out quickly. Explosions are short-lived
    // and infrequent, so a live radial gradient here is cheap enough —
    // unlike the planets, this isn't paid every frame for 60+ objects.
    const flashT = Math.min(t / FLASH_FRACTION, 1);
    if (flashT < 1) {
      ctx.save();
      ctx.globalAlpha = 1 - flashT;
      const grad = ctx.createRadialGradient(this.pos.x, this.pos.y, 0, this.pos.x, this.pos.y, FLASH_RADIUS);
      grad.addColorStop(0, 'rgba(255,255,220,1)');
      grad.addColorStop(0.4, 'rgba(255,180,60,0.8)');
      grad.addColorStop(1, 'rgba(255,100,20,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(this.pos.x, this.pos.y, FLASH_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}