// js/world/FireBar.js
//
// Immovable pivot block + rotating double-sided fireball bar + embers.
// Collision: block is solid (isImmovable + radius). Fireballs are
// hazard-only via getFireballPositions() (see
// CollisionSystem.handlePlayerFireBarCollisions).

import love from '../love/index.js';
import lua from '../love/lua.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import utils from '../utils.js';
import Flame from '../effects/Flame.js';

// ---------------------------------------------------------------------
// Ember (decorative only)
// ---------------------------------------------------------------------

class FireEmber {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    const angle = Math.random() * Math.PI * 2;
    const speed = 0.3 + Math.random() * 0.6;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed - 0.35;
    this.life = 1;
    this.decay = 0.025 + Math.random() * 0.03;
    this.radius = 1.3 + Math.random() * 2;
    this.hue = 18 + Math.random() * 30;
  }

  update(timeScale) {
    this.x += this.vx * timeScale;
    this.y += this.vy * timeScale;
    this.vx *= 0.97 ** timeScale;
    this.vy *= 0.97 ** timeScale;
    this.life -= this.decay * timeScale;
  }
}

// hue in degrees, sat/light 0–1 -> [r, g, b, alpha]
function hslaApprox(hue, sat, light, alpha) {
  const h = lua.mod(hue, 360) / 360;
  const s = sat, l = light;
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return [r, g, b, alpha];
}

// ---------------------------------------------------------------------
// Drawing resources (built once, shared by every bar)
// ---------------------------------------------------------------------

// A soft round white glow, fading to nothing at its edge — tinted and
// drawn additively for the hub's heat and the embers' halos.
let glowImage = null;
function getGlow() {
  if (glowImage) return glowImage;
  const size = 64;
  const data = love.image.newImageData(size, size);
  data.mapPixel((px, py) => {
    const dx = (px + 0.5) / size * 2 - 1;
    const dy = (py + 0.5) / size * 2 - 1;
    const t = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy));
    return [1, 1, 1, t * t];
  });
  glowImage = love.graphics.newImage(data);
  // (The game's default filter is "nearest", for its pixel art — this
  // one's scaled up a lot and needs to stay smooth.)
  glowImage.setFilter('linear', 'linear');
  return glowImage;
}

function drawGlow(img, x, y, diameter) {
  const w = img.getWidth();
  love.graphics.draw(img, x, y, 0, diameter / w, diameter / w, w / 2, w / 2);
}

// The pivot block's face: lit from above, darker toward the bottom.
function makeBlockMesh(r) {
  return love.graphics.newMesh([
    [-r, -r, 0, 0, 0.36, 0.35, 0.34, 1],
    [r, -r, 1, 0, 0.30, 0.29, 0.28, 1],
    [r, r, 1, 1, 0.11, 0.10, 0.10, 1],
    [-r, r, 0, 1, 0.15, 0.14, 0.13, 1],
  ], 'fan', 'static');
}

const MAX_TAIL = 2.0;  // extra tail length (in radii) at full swing speed
const TAIL_SPEED = 12; // swing speed (world units per frame) for that full tail

class FireBar {
  static new(x, y, options) {
    return new FireBar(x, y, options);
  }

  constructor(x, y, options = {}) {
    this.pos = new Vector2(x, y);
    this.isImmovable = true;

    this.blockRadius = options.blockRadius ?? 25;

    // Deliberately much SMALLER than blockRadius, and only used for the
    // generic immovable-vs-movable push in
    // CollisionSystem.handleImmovableCollisions — NOT the drawn block
    // size or the player's lethal-touch radius. A full-size radius made
    // belt planetoids pool in a visible ring around every bar's pivot;
    // the smaller the overlap window, the less often this bounce fights
    // BeltOrbitSystem's own sun-centered restore force.
    this.radius = options.collisionRadius ?? 0.5;

    this.barLength = options.barLength ?? 500;
    this.numFireballs = options.numFireballs ?? 10;
    this.fireballRadius = options.fireballRadius ?? 15;
    this.rotationSpeed = options.rotationSpeed ?? 0.05;
    this.angle = options.startAngle ?? 0;
    this.emberSpawnChance = options.emberSpawnChance ?? 0.15;
    this.embers = [];
    // Seconds of flame animation, advanced by update with the game's own
    // time scale. Random start so neighbouring bars don't flicker in step.
    this.flameTime = Math.random() * 100;
  }

  getFireballPositions() {
    const positions = [];
    const dirX = Math.cos(this.angle);
    const dirY = Math.sin(this.angle);
    for (let i = 1; i <= this.numFireballs; i++) {
      const dist = (i / this.numFireballs) * this.barLength;
      positions.push({ x: this.pos.x + dirX * dist, y: this.pos.y + dirY * dist, radius: this.fireballRadius });
      positions.push({ x: this.pos.x - dirX * dist, y: this.pos.y - dirY * dist, radius: this.fireballRadius });
    }
    return positions;
  }

  update() {
    const timeScale = state.timeScale ?? 1;
    this.angle += this.rotationSpeed * timeScale;
    this.flameTime += timeScale / 60;

    // Ember spawning is skipped entirely while this bar is off-screen —
    // purely decorative. Existing embers still decay below regardless.
    if (utils.isOnScreen(this.pos.x, this.pos.y, this.barLength + this.fireballRadius, 100)) {
      for (const f of this.getFireballPositions()) {
        if (Math.random() < this.emberSpawnChance * timeScale) {
          this.embers.push(new FireEmber(f.x, f.y));
        }
      }
    }

    for (let i = this.embers.length - 1; i >= 0; i--) {
      this.embers[i].update(timeScale);
      if (this.embers[i].life <= 0) this.embers.splice(i, 1);
    }
  }

  draw() {
    const x = this.pos.x, y = this.pos.y;
    const r = this.blockRadius;
    const t = this.flameTime;
    const glow = getGlow();

    love.graphics.push('all');

    // Block first (fireballs pass in front): a riveted metal block with
    // a red-hot socket in the middle that the arms spin out of.
    if (!this.blockMesh) this.blockMesh = makeBlockMesh(r);
    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.draw(this.blockMesh, x, y);
    love.graphics.setLineWidth(1.5);
    love.graphics.setColor(1, 1, 1, 0.14);
    love.graphics.line(x - r + 3, y + r - 4, x - r + 3, y - r + 3, x + r - 4, y - r + 3);
    love.graphics.setLineWidth(3);
    love.graphics.setColor(0.07, 0.07, 0.07, 1);
    love.graphics.rectangle('line', x - r, y - r, r * 2, r * 2, 3, 3);
    for (const sy of [-1, 1]) {
      for (const sx of [-1, 1]) {
        const rx = x + sx * r * 0.68, ry = y + sy * r * 0.68;
        love.graphics.setColor(0.06, 0.06, 0.06, 1);
        love.graphics.circle('fill', rx, ry + 0.8, r * 0.11);
        love.graphics.setColor(0.45, 0.44, 0.42, 1);
        love.graphics.circle('fill', rx, ry, r * 0.09);
      }
    }

    const pulse = 0.85 + 0.15 * Math.sin(t * 5);
    love.graphics.setColor(0.05, 0.03, 0.02, 1);
    love.graphics.circle('fill', x, y, r * 0.5);
    love.graphics.setBlendMode('add');
    love.graphics.setColor(1, 0.4, 0.08, 0.6 * pulse);
    drawGlow(glow, x, y, r * 2.6);
    love.graphics.setColor(1, 0.7, 0.3, pulse);
    love.graphics.circle('fill', x, y, r * 0.3);
    love.graphics.setBlendMode('alpha');
    // The axle, turning with the arms.
    const ax = Math.cos(this.angle) * r * 0.42, ay = Math.sin(this.angle) * r * 0.42;
    love.graphics.setColor(0.08, 0.05, 0.04, 1);
    love.graphics.setLineWidth(4);
    love.graphics.line(x - ax, y - ay, x + ax, y + ay);

    // Fireballs (see js/effects/Flame.js).
    const omega = this.rotationSpeed;
    const positions = this.getFireballPositions();
    for (let idx = 0; idx < positions.length; idx++) {
      const f = positions[idx];
      const i = idx + 1;
      const radius = f.radius * (0.93 + Math.sin(t * 12 + i * 1.7) * 0.07);
      // Swinging round the pivot: velocity is omega x offset.
      const ox = f.x - x, oy = f.y - y;
      const vx = -omega * oy, vy = omega * ox;
      const speed = Math.sqrt(vx * vx + vy * vy);
      const dirAngle = speed > 0.01 ? Math.atan2(vy, vx) : -Math.PI / 2;
      const stretch = 1 + Math.min(speed / TAIL_SPEED, 1) * MAX_TAIL;
      Flame.draw(f.x, f.y, radius, dirAngle, stretch, t, i * 3.17);
    }

    // Embers: glowing sparks, cooling from bright yellow to dull red.
    love.graphics.setBlendMode('add');
    for (const e of this.embers) {
      const a = Math.max(0, e.life);
      const [er, eg, eb] = hslaApprox(e.hue, 1, 0.35 + 0.4 * a, a);
      love.graphics.setColor(er, eg, eb, a * 0.5);
      drawGlow(glow, e.x, e.y, e.radius * 7);
      love.graphics.setColor(er, eg, eb, a);
      love.graphics.circle('fill', e.x, e.y, e.radius * 0.8);
    }

    love.graphics.pop();
  }
}

export default FireBar;
