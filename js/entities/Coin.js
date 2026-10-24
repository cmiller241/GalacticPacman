// js/entities/Coin.js
//
// Coins orbit a planet and can be collected by the player.

import love from '../love/index.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import constants from '../constants.js';

const COIN_RADIUS = constants.COIN_RADIUS ?? 12;
const COIN_ORBIT_OFFSET = constants.COIN_ORBIT_OFFSET ?? 28;

class Coin {
  static new(planet) {
    return new Coin(planet);
  }

  constructor(planet) {
    this.planet = planet;
    this.radius = COIN_RADIUS;
    this.orbitRadius = planet.radius + COIN_ORBIT_OFFSET;
    this.orbitOffset = COIN_ORBIT_OFFSET;

    this.angularSpeed = (Math.random() - 0.5) * 0.04;
    this.angle = Math.random() * Math.PI * 2;

    // For rounded-rect planets (arc-length walk)
    this.arcPos = 0;
    this.arcSpeed = (Math.random() - 0.5) * 2;
    if (planet.isRoundedRect && planet.getPerimeter) {
      this.arcPos = Math.random() * planet.getPerimeter();
    }

    this.pos = new Vector2(0, 0);
    this.updatePosition();
  }

  updatePosition() {
    const planet = this.planet;
    if (planet.isRoundedRect && planet.worldPointAtArcPosition) {
      const world = planet.worldPointAtArcPosition(this.arcPos, this.orbitOffset);
      this.pos.x = world.point.x;
      this.pos.y = world.point.y;
    } else {
      this.pos.x = planet.pos.x + Math.cos(this.angle) * this.orbitRadius;
      this.pos.y = planet.pos.y + Math.sin(this.angle) * this.orbitRadius;
    }
  }

  update() {
    const ts = state.timeScale ?? 1;
    if (this.planet.isRoundedRect) {
      this.arcPos += this.arcSpeed * ts;
    } else {
      this.angle += this.angularSpeed * ts;
    }
    this.updatePosition();
  }

  draw() {
    const x = this.pos.x, y = this.pos.y;
    const r = this.radius;

    // Gold body
    love.graphics.setColor(1.0, 0.84, 0.0, 1);
    love.graphics.circle('fill', x, y, r);

    // Darker gold rim
    love.graphics.setColor(0.72, 0.53, 0.04, 0.8);
    love.graphics.setLineWidth(2);
    love.graphics.circle('line', x, y, r);

    // Spinning highlight
    const spin = love.timer.getTime() * 10;
    love.graphics.push();
    love.graphics.translate(x, y);
    love.graphics.rotate(spin);
    love.graphics.setColor(1, 1, 1, 0.8);
    love.graphics.circle('fill', -r * 0.4, -r * 0.4, r * 0.4);
    love.graphics.pop();

    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.setLineWidth(1);
  }
}

export default Coin;
