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