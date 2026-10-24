// js/effects/GroundPoundBurst.js
//
// What a ground pound looks like when it lands (see Player.js's own
// ground-pound bookkeeping in Player.update): a circle outline that
// expands out from the point of contact and fades, plus a ring of dust
// thrown outward from that same point.
//
// The circle goes in state.explosions — it has the same update/isDead/
// draw shape Explosion.js does, so main.js's existing loops over that
// list drive it with no extra wiring (same arrangement as
// StompBurst.js's own ring). The dust is DustPuff.js's.

import love from '../love/index.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import DustPuff from './DustPuff.js';

const RING_DURATION = 0.45; // seconds, wall-clock like Explosion.js
const RING_START_RADIUS = 12;
const RING_END_RADIUS = 105;
const RING_START_ALPHA = 0.9;
const RING_START_WIDTH = 5; // line width at the start; thins to 1 as it spreads
const RING_COLOR = [1, 1, 1];

const DUST_COUNT = 22;
// World units per baseline frame, straight out from the point of
// contact. Dust slows quickly (DustPuff's own drag), covering about ten
// times its starting speed in total — so this is roughly 45 to 95 units
// of travel, out to near where the ring ends up.
const DUST_SPEED = [4.5, 9.5];

const GroundPoundBurst = {};

class Ring {
  constructor(x, y, scale) {
    this.x = x;
    this.y = y;
    this.startTime = love.timer.getTime();
    this.scale = scale;
  }

  isDead() {
    return love.timer.getTime() - this.startTime >= RING_DURATION;
  }

  update() {
    // Purely time-driven, same as Explosion.js.
  }

  draw() {
    const t = Math.min((love.timer.getTime() - this.startTime) / RING_DURATION, 1);
    const eased = 1 - (1 - t) ** 3; // bursts out fast, settles as it reaches full size
    const radius = (RING_START_RADIUS + (RING_END_RADIUS - RING_START_RADIUS) * eased) * this.scale;

    love.graphics.setColor(RING_COLOR[0], RING_COLOR[1], RING_COLOR[2], RING_START_ALPHA * (1 - t));
    love.graphics.setLineWidth((1 + (RING_START_WIDTH - 1) * (1 - t)) * Math.sqrt(this.scale));
    love.graphics.circle('line', this.x, this.y, radius);

    love.graphics.setLineWidth(1);
    love.graphics.setColor(1, 1, 1, 1);
  }
}

// x, y: the point of contact (where he hits the ground). up: unit
// vector pointing away from the ground there — straight up the screen
// if omitted. scale (optional, default 1): how big — the ring's reach,
// and how much dust and how far it's thrown (a cannon crash landing is
// a bigger one — see js/world/Cannon.js).
GroundPoundBurst.spawn = function (x, y, up, scale) {
  up = up ?? new Vector2(0, -1);
  scale = scale ?? 1;

  state.explosions = state.explosions ?? [];
  state.explosions.push(new Ring(x, y, scale));

  DustPuff.spawnRadial(new Vector2(x, y), up, Math.floor(DUST_COUNT * scale + 0.5),
    DUST_SPEED[0] * scale, DUST_SPEED[1] * scale);
};

export default GroundPoundBurst;
