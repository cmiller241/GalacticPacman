// js/entities/Fireball.js
//
// Bob's blaster shot.

import love from '../love/index.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import Flame from '../effects/Flame.js';

const FIREBALL_SPEED = 14;
const FIREBALL_LIFE = 70;
const TRAIL_SPAWN_CHANCE = 0.9;
const TRAIL_PUFFS_PER_FRAME = 3;
const TRAIL_PARTICLE_LIFE_MIN = 14;
const TRAIL_PARTICLE_LIFE_RANGE = 12;
const SPARK_SPAWN_CHANCE = 0.35;
const SPARK_LIFE_MIN = 8;
const SPARK_LIFE_RANGE = 8;
const OFFSCREEN_MARGIN = 400;

// The look (see Fireball.draw): a shader flame for the head (the same
// one as the fire bars', js/effects/Flame.js) with a long comet tail,
// a heat glow round it, a trail of fire puffs that cool into drifting
// smoke, and sparks streaking off behind.
const FLAME_RADIUS = 11;        // the drawn head (its hit radius is this.radius)
const FLAME_STRETCH = 3.2;      // its comet tail, in head radii
const PUFF_FIRE_FRACTION = 0.4; // the first part of a puff's life it's fire; smoke after
const PUFF_GROWTH = 1.8;        // how much bigger a puff gets over its life

// A soft round white glow, fading smoothly to nothing at its edge.
const GLOW_SIZE = 64;
let glowImage = null;
function getGlow() {
  if (glowImage) return glowImage;
  const data = love.image.newImageData(GLOW_SIZE, GLOW_SIZE);
  const half = GLOW_SIZE / 2;
  data.mapPixel((x, y) => {
    const d = Math.sqrt((x + 0.5 - half) ** 2 + (y + 0.5 - half) ** 2) / half;
    const v = Math.max(0, 1 - d);
    return [1, 1, 1, v * v];
  });
  glowImage = love.graphics.newImage(data);
  glowImage.setFilter('linear', 'linear');
  return glowImage;
}

function drawGlow(x, y, diameter) {
  love.graphics.draw(getGlow(), x, y, 0, diameter / GLOW_SIZE, diameter / GLOW_SIZE, GLOW_SIZE / 2, GLOW_SIZE / 2);
}

// Fire's colour as it cools: t = 1 white-yellow, 0.5 orange, 0 deep red.
function fireColor(t) {
  if (t > 0.5) {
    const k = (t - 0.5) * 2;
    return [1, 0.55 + 0.4 * k, 0.12 + 0.45 * k];
  }
  const k = t * 2;
  return [0.75 + 0.25 * k, 0.12 + 0.43 * k, 0.03 + 0.09 * k];
}

class Fireball {
  static new(x, y, angle) {
    return new Fireball(x, y, angle);
  }

  constructor(x, y, angle) {
    this.pos = new Vector2(x, y);
    this.vel = new Vector2(Math.cos(angle), Math.sin(angle)).multiply(FIREBALL_SPEED);
    this.life = FIREBALL_LIFE;
    this.trail = [];
    this.sparks = [];
    this.radius = 8;
    this.flickerPhase = Math.random() * Math.PI * 2;
    // Seconds of flame animation, in game time (so V.A.T.S. slow-mo slows
    // the fire too); a random start so two shots don't churn in step.
    this.flameTime = Math.random() * 100;
  }

  isDead() {
    return this.life <= 0;
  }

  update() {
    const ts = state.timeScale ?? 1;
    this.pos.addScaled(this.vel, ts);
    this.life -= ts;
    this.flameTime += ts / 60;

    // Trail: puffs left behind (drifting on a little, the way it was
    // going), fire at first, then smoke. (Several a frame, spread back
    // along the step it just took, so the trail stays unbroken at its
    // speed.)
    for (let n = 0; n < TRAIL_PUFFS_PER_FRAME; n++) {
      if (Math.random() < TRAIL_SPAWN_CHANCE * ts) {
        const spread = 8;
        const back = Math.random() * ts;
        const maxLife = TRAIL_PARTICLE_LIFE_MIN + Math.random() * TRAIL_PARTICLE_LIFE_RANGE;
        this.trail.push({
          x: this.pos.x - this.vel.x * back + (Math.random() - 0.5) * spread,
          y: this.pos.y - this.vel.y * back + (Math.random() - 0.5) * spread,
          vx: this.vel.x * 0.08 + (Math.random() - 0.5) * 0.6,
          vy: this.vel.y * 0.08 + (Math.random() - 0.5) * 0.6,
          life: maxLife,
          maxLife,
          size: 4 + Math.random() * 5,
        });
      }
    }
    for (let i = this.trail.length - 1; i >= 0; i--) {
      const t = this.trail[i];
      t.x += t.vx * ts;
      t.y += t.vy * ts;
      t.vx *= 0.94 ** ts;
      t.vy *= 0.94 ** ts;
      t.life -= ts;
      if (t.life <= 0) this.trail.splice(i, 1);
    }

    // Sparks, thrown off mostly backward.
    if (Math.random() < SPARK_SPAWN_CHANCE * ts) {
      const sparkAngle = Math.atan2(this.vel.y, this.vel.x) + Math.PI + (Math.random() - 0.5) * 1.8;
      const sparkSpeed = 1.5 + Math.random() * 3;
      const maxLife = SPARK_LIFE_MIN + Math.random() * SPARK_LIFE_RANGE;
      this.sparks.push({
        x: this.pos.x,
        y: this.pos.y,
        vx: Math.cos(sparkAngle) * sparkSpeed,
        vy: Math.sin(sparkAngle) * sparkSpeed,
        life: maxLife,
        maxLife,
      });
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.x += s.vx * ts;
      s.y += s.vy * ts;
      s.life -= ts;
      if (s.life <= 0) this.sparks.splice(i, 1);
    }

    // Cull off-screen
    if (this.pos.x < -OFFSCREEN_MARGIN || this.pos.x > state.sceneWidth + OFFSCREEN_MARGIN
      || this.pos.y < -OFFSCREEN_MARGIN || this.pos.y > state.sceneHeight + OFFSCREEN_MARGIN) {
      this.life = 0;
    }
  }

  draw() {
    love.graphics.push('all');

    // Smoke: the older puffs, grey, growing as they fade.
    for (const t of this.trail) {
      const life = t.life / t.maxLife;
      if (life < PUFF_FIRE_FRACTION + 0.1) {
        const k = Math.min(1, life / PUFF_FIRE_FRACTION); // 1 just turned to smoke .. 0 gone
        const size = t.size * (1 + PUFF_GROWTH * (1 - life));
        love.graphics.setColor(0.32, 0.3, 0.3, 0.3 * k);
        drawGlow(t.x, t.y, size * 2.6);
      }
    }

    // Fire: the younger puffs, glowing, cooling from yellow to red.
    love.graphics.setBlendMode('add');
    for (const t of this.trail) {
      const life = t.life / t.maxLife;
      if (life > PUFF_FIRE_FRACTION) {
        const heat = (life - PUFF_FIRE_FRACTION) / (1 - PUFF_FIRE_FRACTION);
        const size = t.size * (1 + PUFF_GROWTH * (1 - life));
        const [r, g, b] = fireColor(heat);
        love.graphics.setColor(r, g, b, 0.6 * heat);
        drawGlow(t.x, t.y, size * 2.8);
      }
    }

    // Sparks: short bright streaks along the way they're flying.
    love.graphics.setLineWidth(1.5);
    for (const s of this.sparks) {
      const a = s.life / s.maxLife;
      const [r, g, b] = fireColor(0.4 + 0.6 * a);
      love.graphics.setColor(r, g, b, a);
      love.graphics.line(s.x, s.y, s.x - s.vx * 2.5, s.y - s.vy * 2.5);
    }

    // Heat glow round the head, flickering.
    const flicker = Math.sin(this.flameTime * 20 + this.flickerPhase);
    love.graphics.setColor(1, 0.45, 0.1, 0.45 + 0.1 * flicker);
    drawGlow(this.pos.x, this.pos.y, FLAME_RADIUS * 6);
    love.graphics.pop();

    // The head: a shader flame, its tail streaming back behind it.
    const dirAngle = Math.atan2(this.vel.y, this.vel.x);
    Flame.draw(this.pos.x, this.pos.y, FLAME_RADIUS * (1 + flicker * 0.05), dirAngle,
      FLAME_STRETCH, this.flameTime, this.flickerPhase * 10);
  }
}

export default Fireball;
