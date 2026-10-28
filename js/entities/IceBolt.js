// js/entities/IceBolt.js
//
// The ice blaster's shot (see WeaponModes.js's 'ice' mode and
// Player.shootIceBolt): a glinting shard of ice flying straight, leaving
// a trail of frost. What it does when it hits something is main.js's and
// WaterSystem.js's business (see WaterSystem.iceBoltHit): water it
// reaches freezes into an ice block, lava it reaches turns to water (and
// so to obsidian), an Ooomba it reaches is frozen in an ice cube, and
// anything else it just shatters on (IceBolt.burst).
//
// Shaped like a Fireball (pos, vel, radius, life), so the same portal and
// collision passes work on it.

import love from '../love/index.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import Particle from './Particle.js';

const SPEED = 13;
const LIFE = 60;                 // frames (60fps ticks)
const RADIUS = 7;                // what it hits with
const SHARD_LENGTH = 15;         // the drawn shard, nose to tail
const SHARD_WIDTH = 6;
const FROST_PER_FRAME = 0.8;     // chance a frame of a frost mote left behind
const FROST_LIFE_MIN = 14, FROST_LIFE_RANGE = 12;
const OFFSCREEN_MARGIN = 400;

const COLOR_CORE = [0.92, 0.99, 1.0];
const COLOR_EDGE = [0.45, 0.78, 1.0];
const COLOR_FROST = [0.78, 0.93, 1.0];

class IceBolt {
  static new(x, y, angle) {
    return new IceBolt(x, y, angle);
  }

  constructor(x, y, angle) {
    this.pos = new Vector2(x, y);
    this.vel = new Vector2(Math.cos(angle), Math.sin(angle)).multiply(SPEED);
    this.life = LIFE;
    this.radius = RADIUS;
    this.frost = [];
    this.spin = Math.random() * Math.PI * 2;
  }

  isDead() {
    return this.life <= 0;
  }

  update() {
    const ts = state.timeScale ?? 1;
    this.pos.addScaled(this.vel, ts);
    this.life -= ts;
    this.spin += 0.25 * ts;

    if (Math.random() < FROST_PER_FRAME * ts) {
      const life = FROST_LIFE_MIN + Math.random() * FROST_LIFE_RANGE;
      this.frost.push({
        x: this.pos.x + (Math.random() - 0.5) * 6, y: this.pos.y + (Math.random() - 0.5) * 6,
        vx: this.vel.x * 0.05 + (Math.random() - 0.5) * 0.5, vy: this.vel.y * 0.05 + (Math.random() - 0.5) * 0.5,
        life, maxLife: life, size: 1 + Math.random() * 1.6,
      });
    }
    for (let i = this.frost.length - 1; i >= 0; i--) {
      const f = this.frost[i];
      f.x += f.vx * ts; f.y += f.vy * ts;
      f.life -= ts;
      if (f.life <= 0) this.frost.splice(i, 1);
    }

    if (this.pos.x < -OFFSCREEN_MARGIN || this.pos.x > (state.sceneWidth ?? Infinity) + OFFSCREEN_MARGIN
        || this.pos.y < -OFFSCREEN_MARGIN || this.pos.y > (state.sceneHeight ?? Infinity) + OFFSCREEN_MARGIN) {
      this.life = 0;
    }
  }

  // A puff of frost and ice chips at (x, y): where a shot shattered, or
  // something froze or thawed.
  static burst(x, y, count = 12) {
    if (!state.particles) return;
    for (let k = 0; k < count; k++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 0.8 + Math.random() * 2.6;
      const p = Particle.new(new Vector2(x, y), new Vector2(Math.cos(a) * speed, Math.sin(a) * speed), 18 + Math.random() * 18);
      p.color = [COLOR_FROST[0], COLOR_FROST[1], COLOR_FROST[2]];
      p.radius = 1.5 + Math.random() * 2.5;
      p.drag = 0.93;
      state.particles.push(p);
    }
  }

  draw() {
    const g = love.graphics;
    for (const f of this.frost) {
      const a = f.life / f.maxLife;
      g.setColor(COLOR_FROST[0], COLOR_FROST[1], COLOR_FROST[2], 0.7 * a);
      g.circle('fill', f.x, f.y, f.size);
    }

    // A soft cold glow, then the shard: a long diamond along its flight,
    // pale at its heart, bluer at its edges, glinting as it turns.
    g.setColor(COLOR_EDGE[0], COLOR_EDGE[1], COLOR_EDGE[2], 0.25);
    g.circle('fill', this.pos.x, this.pos.y, this.radius * 2.2);
    const dir = Math.atan2(this.vel.y, this.vel.x);
    const glint = 0.5 + 0.5 * Math.sin(this.spin);
    g.push();
    g.translate(this.pos.x, this.pos.y);
    g.rotate(dir);
    const L = SHARD_LENGTH, Wd = SHARD_WIDTH * (0.7 + 0.3 * glint);
    g.setColor(COLOR_EDGE[0], COLOR_EDGE[1], COLOR_EDGE[2], 0.95);
    g.polygon('fill', L * 0.6, 0, 0, -Wd / 2, -L * 0.4, 0, 0, Wd / 2);
    g.setColor(COLOR_CORE[0], COLOR_CORE[1], COLOR_CORE[2], 1);
    g.polygon('fill', L * 0.5, 0, 0, -Wd / 4, -L * 0.25, 0, 0, Wd / 4);
    g.pop();
    g.setColor(1, 1, 1, 1);
  }
}

export default IceBolt;
