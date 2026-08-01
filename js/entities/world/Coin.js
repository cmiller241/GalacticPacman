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

    // Rounded-rect planets don't have a single "angle" — they use the
    // same arc-length perimeter-walk parameterization the player uses
    // to walk their surface, just always drifting (never player-
    // controlled) and pushed further out (COIN_ORBIT_OFFSET instead of
    // PLAYER_RADIUS).
    this.orbitOffset = COIN_ORBIT_OFFSET;
    this.arcPos = planet.isRoundedRect ? Math.random() * planet.getPerimeter() : 0;
    this.arcSpeed = (Math.random() - 0.5) * 2; // px/frame, comparable visual speed to the circular case

    this.updatePosition();
  }

  updatePosition() {
    if (this.planet.isRoundedRect) {
      const world = this.planet.worldPointAtArcPosition(this.arcPos, this.orbitOffset);
      this.pos.x = world.point.x;
      this.pos.y = world.point.y;
    } else {
      this.pos.x = this.planet.pos.x + Math.cos(this.angle) * this.orbitRadius;
      this.pos.y = this.planet.pos.y + Math.sin(this.angle) * this.orbitRadius;
    }
  }

  update() {
    if (this.planet.isRoundedRect) {
      this.arcPos += this.arcSpeed;
    } else {
      this.angle += this.angularSpeed;
    }
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