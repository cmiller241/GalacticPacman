// js/entities/WallContactPulse.js
//
// A small, subtle expanding-and-fading ring — visual feedback for a wall
// jump's kick-off point. Same "expanding fading ring" idea
// Explosion.js's own shockwave uses, just much smaller, quicker, and
// more subdued: no core flash, no particle burst (Player.js's own dust
// puff already covers that role for a wall jump), just the ring.

import love from '../love/index.js';
import Vector2 from '../vector2.js';

const PULSE_DURATION = 0.25; // seconds
const PULSE_MAX_RADIUS = 22;
const PULSE_MAX_ALPHA = 0.5; // capped well under full opacity to read as subtle, not flashy

class WallContactPulse {
  static new(x, y) {
    return new WallContactPulse(x, y);
  }

  constructor(x, y) {
    this.pos = new Vector2(x, y);
    this.startTime = love.timer.getTime();
  }

  isDead() {
    return love.timer.getTime() - this.startTime >= PULSE_DURATION;
  }

  // Purely time-driven; nothing to simulate beyond the elapsed clock.
  update() {}

  draw() {
    const t = Math.min((love.timer.getTime() - this.startTime) / PULSE_DURATION, 1);
    const eased = 1 - (1 - t) ** 2; // quick expand, settles near the end

    love.graphics.setColor(1, 1, 1, (1 - t) * PULSE_MAX_ALPHA);
    love.graphics.setLineWidth(2);
    love.graphics.circle('line', this.pos.x, this.pos.y, eased * PULSE_MAX_RADIUS);
    love.graphics.setLineWidth(1);
    love.graphics.setColor(1, 1, 1, 1);
  }
}

export default WallContactPulse;
