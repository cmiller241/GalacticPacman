// js/entities/Explosion.js
//
// Expanding fading ring + a quick bright core flash + a fiery particle
// burst. Purely time-driven — nothing to simulate beyond the elapsed
// clock read in draw()/isDead().

import love from '../love/index.js';
import lua from '../love/lua.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import Particle from './Particle.js';

const EXPLOSION_DURATION = 0.4; // seconds
const RING_MAX_RADIUS = 70;
const FLASH_RADIUS = 30;
const FLASH_FRACTION = 0.3;     // flash burns out over the first 30% of the duration
const PARTICLE_COUNT = 40;

// Shared radial-gradient flash mesh (bright warm-white center fading to
// transparent orange at the edge) — baked once, reused by every
// explosion via love.graphics.draw(mesh, x, y, 0, radius, radius).
let flashMesh = null;
function getFlashMesh() {
  if (flashMesh) return flashMesh;
  const segments = 32;
  const vertices = [
    [0, 0, 0.5, 0.5, 1, 1, 220 / 255, 1],
  ];
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const x = Math.cos(angle), y = Math.sin(angle);
    vertices.push([x, y, 0.5 + x * 0.5, 0.5 + y * 0.5, 1, 100 / 255, 20 / 255, 0]);
  }
  flashMesh = love.graphics.newMesh(vertices, 'fan', 'static');
  return flashMesh;
}

function randomRange(a, b) {
  return a + Math.random() * (b - a);
}

// hsl(hue, 100%, 50%) -> [r, g, b]
function hueToRgb(hue) {
  const h = lua.mod(hue, 360) / 360;
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  // l=0.5, s=1 fixed throughout, so q = 1.0, p = 0.0
  return [hue2rgb(0, 1, h + 1 / 3), hue2rgb(0, 1, h), hue2rgb(0, 1, h - 1 / 3)];
}

// Fiery particle burst — reuses the shared Particle system.
function spawnFieryParticles(pos, count) {
  for (let n = 0; n < count; n++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = randomRange(3, 9);
    const vel = new Vector2(Math.cos(angle) * speed, Math.sin(angle) * speed);
    const particle = Particle.new(pos, vel);
    particle.color = hueToRgb(randomRange(20, 80)); // fiery oranges/yellows
    state.particles.push(particle);
  }
}

class Explosion {
  static new(x, y) {
    return new Explosion(x, y);
  }

  constructor(x, y) {
    this.pos = new Vector2(x, y);
    this.startTime = love.timer.getTime();
    this.duration = EXPLOSION_DURATION;
    spawnFieryParticles(this.pos, PARTICLE_COUNT);
  }

  isDead() {
    return love.timer.getTime() - this.startTime >= this.duration;
  }

  update() {
    // Purely time-driven.
  }

  draw() {
    const t = Math.min((love.timer.getTime() - this.startTime) / this.duration, 1);
    const eased = 1 - (1 - t) ** 3; // fast expand, settles near the end

    // Expanding, fading shockwave ring
    love.graphics.setColor(1, 204 / 255, 102 / 255, 1 - t);
    love.graphics.setLineWidth(4 * (1 - t) + 1);
    love.graphics.circle('line', this.pos.x, this.pos.y, eased * RING_MAX_RADIUS);

    // Bright core flash, burns out quickly.
    const flashT = Math.min(t / FLASH_FRACTION, 1);
    if (flashT < 1) {
      love.graphics.setColor(1, 1, 1, 1 - flashT);
      love.graphics.draw(getFlashMesh(), this.pos.x, this.pos.y, 0, FLASH_RADIUS, FLASH_RADIUS);
    }

    love.graphics.setLineWidth(1);
    love.graphics.setColor(1, 1, 1, 1);
  }
}

export default Explosion;
