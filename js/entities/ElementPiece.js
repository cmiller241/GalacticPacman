// js/entities/ElementPiece.js
//
// A piece of an element the astronaut mines by shooting things apart:
//   rubinium     what the red prisms are made of (see js/world/Prism.js)
//                — a handful are thrown out when a cluster of them is
//                shot apart (see main.js's own breakPrismCluster).
//   asteroidium  what asteroids are made of — left when he shoots an
//                asteroid too small to break into smaller ones, and
//                sometimes by a bigger one instead of breaking (see
//                main.js's own breakAsteroid).
// Each piece tumbles outward for a moment, then turns and flies to him
// on its own, wherever he is — as if pulled in by a tractor beam, though
// there isn't one — and is added to state.elements when it reaches him.
//
// Each is a six-sided gem, no two quite the same shape: its corners are
// spread unevenly round it and sit at slightly different distances from
// its middle, so its sides come out different lengths, but only a
// little (see CORNER_ANGLE_JITTER / CORNER_DISTANCE_RANGE).

import love from '../love/index.js';
import Vector2 from '../vector2.js';

const CORNER_ANGLE_JITTER = 11 * Math.PI / 180; // how far each corner may sit either way from an even 60 degrees apart
const CORNER_DISTANCE_RANGE = [0.82, 1.15];     // each corner's distance from the middle, as a fraction of the radius
const SPIN_RANGE = [2, 6];                      // radians per second it tumbles, either way
const GLOW_ALPHA = 0.22;                        // the soft light round it
const GLOW_SIZE = 2.2;                          // how far that reaches, in radii

function randomIn(range) {
  return range[0] + Math.random() * (range[1] - range[0]);
}

class ElementPiece {
  // elementName: a key of ElementPiece.ELEMENTS (and the name it's counted
  // under in state.elements). x, y: where it appears. dirX, dirY: roughly
  // the way it's thrown (it's given a random speed and knocked a little
  // off that line).
  static new(elementName, x, y, dirX, dirY) {
    return new ElementPiece(elementName, x, y, dirX, dirY);
  }

  constructor(elementName, x, y, dirX, dirY) {
    const element = ElementPiece.ELEMENTS[elementName];
    this.elementName = elementName;
    this.element = element;
    this.pos = new Vector2(x, y);

    const angle = Math.atan2(dirY, dirX) + (Math.random() * 2 - 1) * 0.6;
    const speed = randomIn(element.burstSpeed);
    this.vel = new Vector2(Math.cos(angle) * speed, Math.sin(angle) * speed);

    this.radius = randomIn(element.radius);
    this.rotation = Math.random() * Math.PI * 2;
    this.spin = randomIn(SPIN_RANGE) * (Math.random() < 0.5 ? -1 : 1);
    this.driftTime = randomIn(element.driftSeconds);
    this.homingSpeed = element.homingStartSpeed;
    this.collected = false;

    // Its corners, round its own middle, unturned: [x1, y1, x2, y2, ...].
    this.corners = [];
    for (let i = 0; i <= 5; i++) {
      const a = i * Math.PI / 3 + (Math.random() * 2 - 1) * CORNER_ANGLE_JITTER;
      const d = this.radius * randomIn(CORNER_DISTANCE_RANGE);
      this.corners.push(Math.cos(a) * d, Math.sin(a) * d);
    }
  }

  // dt: seconds. Marks itself collected once it reaches the player (the
  // caller counts it and removes it — see main.js).
  update(dt, player) {
    const element = this.element;
    this.rotation += this.spin * dt;

    if (this.driftTime > 0) {
      this.driftTime -= dt;
      const keep = Math.max(0, 1 - element.burstDrag * dt);
      this.vel.x *= keep;
      this.vel.y *= keep;
    } else if (player) {
      const dx = player.pos.x - this.pos.x, dy = player.pos.y - this.pos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 0.001) {
        this.homingSpeed = Math.min(element.homingMaxSpeed, this.homingSpeed + element.homingAcceleration * dt);
        const turn = Math.min(1, element.homingTurnRate * dt);
        this.vel.x += (dx / dist * this.homingSpeed - this.vel.x) * turn;
        this.vel.y += (dy / dist * this.homingSpeed - this.vel.y) * turn;
      }
    }

    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;

    if (player && this.driftTime <= 0) {
      const dx = player.pos.x - this.pos.x, dy = player.pos.y - this.pos.y;
      const reach = (player.radius ?? 0) + this.radius;
      if (dx * dx + dy * dy <= reach * reach) this.collected = true;
    }
  }

  draw() {
    const element = this.element;
    love.graphics.push();
    love.graphics.translate(this.pos.x, this.pos.y);

    // Not turned with the gem — it's the same all the way round.
    const glow = element.glow;
    love.graphics.setBlendMode('add', 'alphamultiply');
    for (let i = 3; i >= 1; i--) {
      love.graphics.setColor(glow[0], glow[1], glow[2], GLOW_ALPHA / i);
      love.graphics.circle('fill', 0, 0, this.radius * (1 + (GLOW_SIZE - 1) * i / 3));
    }
    love.graphics.setBlendMode('alpha');

    love.graphics.rotate(this.rotation);

    // Six faces, each a triangle from the middle to one side.
    const c = this.corners;
    for (let i = 0; i <= 5; i++) {
      const a = i * 2, b = ((i + 1) % 6) * 2;
      const color = (i % 2 === 0) ? element.faceLight : element.faceDark;
      love.graphics.setColor(color[0], color[1], color[2], 1);
      love.graphics.polygon('fill', 0, 0, c[a], c[a + 1], c[b], c[b + 1]);
    }

    const outline = element.outline;
    love.graphics.setColor(outline[0], outline[1], outline[2], 1);
    love.graphics.setLineWidth(1.5);
    love.graphics.polygon('line', c);
    love.graphics.setLineWidth(1);

    const spark = element.spark;
    love.graphics.setColor(spark[0], spark[1], spark[2], 0.9);
    love.graphics.circle('fill', 0, 0, this.radius * 0.18);

    love.graphics.pop();
    love.graphics.setColor(1, 1, 1, 1);
  }
}

// What differs from one element to the next. Each range is [least, most].
//   radius          world units, middle to corner, before the per-corner variation above
//   Thrown out of whatever broke, slowing as it goes...
//   burstSpeed      world units per second
//   burstDrag       how quickly that speed dies away (per second)
//   driftSeconds    ...for this long, before it starts toward him
//   ...then toward the astronaut, faster and faster.
//   homingStartSpeed    world units per second
//   homingAcceleration  world units per second, per second
//   homingMaxSpeed
//   homingTurnRate  how sharply it swings round to face him (per second; higher is sharper)
//   Colors: a cut gem — its six faces alternately faceLight and
//   faceDark, an outline, a bright spark in the middle, and a soft glow.
ElementPiece.ELEMENTS = {
  rubinium: {
    radius: [8, 11],
    burstSpeed: [140, 320], burstDrag: 3.0, driftSeconds: [0.35, 0.7],
    homingStartSpeed: 120, homingAcceleration: 1500, homingMaxSpeed: 1400, homingTurnRate: 7,
    // The prisms' own red.
    faceLight: [1.0, 0.36, 0.32], faceDark: [0.72, 0.10, 0.12], outline: [0.30, 0.0, 0.03],
    spark: [1.0, 0.86, 0.8], glow: [1.0, 0.52, 0.48],
  },
  asteroidium: {
    radius: [7, 10],
    burstSpeed: [60, 140], burstDrag: 2.5, driftSeconds: [0.5, 0.9],
    // Slow: it drifts over to him rather than racing. Still quicker
    // than he walks, so it does arrive.
    homingStartSpeed: 40, homingAcceleration: 160, homingMaxSpeed: 420, homingTurnRate: 4,
    // The asteroids' own brown (see Asteroid.js's this.color and its outline).
    faceLight: [0.80, 0.44, 0.15], faceDark: [0.50, 0.24, 0.06], outline: [0.23, 0.11, 0.03],
    spark: [1.0, 0.86, 0.6], glow: [0.95, 0.60, 0.25],
  },
};

export default ElementPiece;
