// js/entities/world/Coin.js
import { Entity } from '../Entity.js';
import { state } from '../../state.js';
import { COIN_RADIUS, COIN_ORBIT_OFFSET } from '../../constants.js';
import { Vector2 } from '../../vector2.js';

export class Coin extends Entity {
  constructor(planet) {
    super();
    this.planet = planet;
    this.angularSpeed = (Math.random() - 0.5) * 0.04;
    this.angle = 0;
    this.radius = COIN_RADIUS;
    this.orbitRadius = planet.radius + COIN_ORBIT_OFFSET;
    this.updatePosition();
  }

  updatePosition() {
    this.pos.x = this.planet.pos.x + Math.cos(this.angle) * this.orbitRadius;
    this.pos.y = this.planet.pos.y + Math.sin(this.angle) * this.orbitRadius;
  }

  update() { 
    this.angle += this.angularSpeed; 
    this.updatePosition(); 
  }

  // Draws many coins in two fills (all the gold bodies, then all the
  // spinning glints) instead of save/rotate/restore and two fills per
  // coin. visible(x, y, r) skips coins that are off screen.
  static drawAll(ctx, coins, visible) {
    if (coins.length === 0) return;
    const spin = Date.now() * 0.01;
    const c = Math.cos(spin), s = Math.sin(spin);
    ctx.fillStyle = 'gold';
    ctx.beginPath();
    for (const coin of coins) {
      const { x, y } = coin.pos, r = coin.radius;
      if (!visible(x, y, r)) continue;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill();
    // The glint: a small dot at (-0.4r, -0.4r), rotated by the spin.
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.beginPath();
    for (const coin of coins) {
      const { x, y } = coin.pos, r = coin.radius;
      if (!visible(x, y, r)) continue;
      const k = r * 0.4;
      const gx = x - k * c + k * s, gy = y - k * s - k * c;
      ctx.moveTo(gx + k, gy);
      ctx.arc(gx, gy, k, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  draw() {
    const ctx = state.ctx;
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, this.radius, 0, Math.PI * 2);
    ctx.fillStyle = 'gold';
    ctx.fill();
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(Date.now() * 0.01);
    ctx.beginPath();
    ctx.arc(-this.radius*0.4, -this.radius*0.4, this.radius*0.4, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fill();
    ctx.restore();
  }
}