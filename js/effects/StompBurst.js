// js/effects/StompBurst.js
//
// The "squashed it flat" punctuation for stomping an Ooomba (see
// Ooomba.js's own updateSquash and main.js's own Ooomba pass): a
// burst of particles kicked up from under the player's feet, plus a
// ring that expands a little while fading out.
//
// The ring goes in state.explosions — it has the same update/isDead/
// draw shape Explosion.js does, so main.js's existing loops over that
// list drive it with no extra wiring. Particles are ordinary shared
// Particle.js ones in state.particles.

import love from '../love/index.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import Particle from '../entities/Particle.js';
import DustPuff from './DustPuff.js';

const RING_DURATION = 0.4; // seconds, wall-clock like Explosion.js
const RING_START_RADIUS = 14;
const RING_END_RADIUS = 62;
const RING_START_ALPHA = 0.85;
const RING_COLOR = [1, 0.96, 0.8];

const SPARK_COUNT = 16;
const DUST_COUNT = 10;

const StompBurst = {};

class Ring {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.startTime = love.timer.getTime();
  }

  isDead() {
    return love.timer.getTime() - this.startTime >= RING_DURATION;
  }

  update() {
    // Purely time-driven, same as Explosion.js.
  }

  draw() {
    const t = Math.min((love.timer.getTime() - this.startTime) / RING_DURATION, 1);
    const eased = 1 - (1 - t) ** 2; // quick at first, easing off as it spreads
    const radius = RING_START_RADIUS + (RING_END_RADIUS - RING_START_RADIUS) * eased;
    const alpha = RING_START_ALPHA * (1 - t);

    love.graphics.setColor(RING_COLOR[0], RING_COLOR[1], RING_COLOR[2], alpha * 0.25);
    love.graphics.circle('fill', this.x, this.y, radius);
    love.graphics.setColor(RING_COLOR[0], RING_COLOR[1], RING_COLOR[2], alpha);
    love.graphics.setLineWidth(3 * (1 - t) + 1);
    love.graphics.circle('line', this.x, this.y, radius);

    love.graphics.setLineWidth(1);
    love.graphics.setColor(1, 1, 1, 1);
  }
}

// x, y: world position of the player's feet (ground level) at the
// moment the Ooomba went flat.
//
// up (optional): unit vector pointing away from the ground there —
// straight up the screen if omitted, which is right for terrain; an
// Ooomba on a round planetoid passes its own (see Ooomba.up).
StompBurst.spawn = function (x, y, up) {
  const pos = new Vector2(x, y);
  up = up ?? new Vector2(0, -1);
  const side = new Vector2(-up.y, up.x);

  // Bright sparks fanned out over the upper half only — sideways and
  // up, never down into the ground he's standing on.
  for (let n = 0; n < SPARK_COUNT; n++) {
    const angle = Math.random() * Math.PI;
    const speed = 2.5 + Math.random() * 5;
    const along = Math.cos(angle) * speed, away = Math.sin(angle) * speed * 0.7;
    const particle = Particle.new(pos, new Vector2(side.x * along + up.x * away, side.y * along + up.y * away), 20 + Math.random() * 14);
    particle.color = [1, 0.85 + Math.random() * 0.15, 0.45 + Math.random() * 0.35];
    particle.radius = 2 + Math.random() * 2;
    particle.drag = 0.9;
    state.particles.push(particle);
  }

  // Plus a wide, low skirt of the usual footstep dust.
  DustPuff.spawn(pos, new Vector2(-up.x, -up.y), side, DUST_COUNT, 9, 0.3, 1.8);

  state.explosions = state.explosions ?? [];
  state.explosions.push(new Ring(x, y));
};

export default StompBurst;
