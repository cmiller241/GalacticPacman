// js/entities/Particle.js
// (No changes needed; this matches the provided particle.js code, with minor adjustments for architecture)
import { state } from '../state.js';
import { Vector2 } from '../vector2.js';

export class Particle {
  constructor(pos, vel, life = 40) {
    this.pos = pos.clone();
    this.vel = vel;
    this.life = life;
  }
  update() {
    this.pos.add(this.vel);
    this.life--;
  }
  draw() {
    const ctx = state.ctx;
    if (this.life <= 0) return;
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, 2, 0, Math.PI * 2);
    if (this.color) {
      // Colored particles (e.g. the blob's green death burst) fade too.
      ctx.globalAlpha = this.life / 40;
      ctx.fillStyle = this.color;
      ctx.fill();
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = `rgba(255, 255, 0, ${this.life / 40})`;
      ctx.fill();
    }
  }
}