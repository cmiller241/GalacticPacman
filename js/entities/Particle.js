// js/entities/Particle.js
//
// A single simple physics particle (position + velocity + fading
// life), used for debris/death/explosion bursts, dust and splashes.

import love from '../love/index.js';
import state from '../state.js';

class Particle {
  static new(pos, vel, life) {
    return new Particle(pos, vel, life);
  }

  constructor(pos, vel, life = 40) {
    this.pos = pos.clone();
    this.vel = vel;
    this.life = life;
    this.maxLife = life;
    // Plain [r, g, b] (0-1). Defaults to yellow.
    this.color = [1, 1, 0];
    this.radius = 2;
    // Both default to "no effect": 1 = constant velocity forever, 0 =
    // constant size.
    this.drag = 1;
    this.growRate = 0;
    // Optional — null by default, so ordinary particles (explosions,
    // sparks, etc.) draw as a single plain circle. When set (see
    // DustPuff.js), a list of {angle, distFrac, radiusFrac} blobs, each
    // positioned/sized as a FRACTION of the particle's own current
    // radius rather than fixed pixels — so as the particle grows over
    // its life (see growRate), the whole cluster grows with it instead
    // of the sub-circles drifting apart or staying a fixed size.
    this.blobs = null;
  }

  update() {
    const timeScale = state.timeScale ?? 1;
    this.pos.addScaled(this.vel, timeScale);
    this.vel.scale(this.drag ** timeScale);
    this.radius += this.growRate * timeScale;
    this.life -= timeScale;
  }

  draw() {
    if (this.life <= 0) return;
    love.graphics.setColor(this.color[0], this.color[1], this.color[2], this.life / this.maxLife);
    if (this.blobs) {
      for (const blob of this.blobs) {
        const bx = this.pos.x + Math.cos(blob.angle) * blob.distFrac * this.radius;
        const by = this.pos.y + Math.sin(blob.angle) * blob.distFrac * this.radius;
        love.graphics.circle('fill', bx, by, blob.radiusFrac * this.radius);
      }
    } else {
      love.graphics.circle('fill', this.pos.x, this.pos.y, this.radius);
    }
    love.graphics.setColor(1, 1, 1, 1);
  }
}

export default Particle;
