// js/entities/Asteroid.js
//
// Irregular faceted asteroid with simple directional shading.

import love from '../love/index.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import constants from '../constants.js';

// Simple flat-shaded triangle
function fillTriangle(x0, y0, x1, y1, x2, y2, baseR, baseG, baseB, lightDir, radius) {
  // Edge normal (approximate)
  const ex = x2 - x1, ey = y2 - y1;
  let nx = ey, ny = -ex;
  const len = Math.sqrt(nx * nx + ny * ny);
  if (len > 0) {
    nx /= len; ny /= len;
  } else {
    nx = 0; ny = 1;
  }

  const dot = lightDir.x * nx + lightDir.y * ny;
  const edgeDist = (Math.sqrt(x1 * x1 + y1 * y1) + Math.sqrt(x2 * x2 + y2 * y2)) / (2 * radius);

  let brightness = 0.30 + Math.max(0, dot) * 0.70;
  brightness = brightness * (1 - 0.4 * edgeDist) + 0.20;

  const r = Math.min(1, Math.max(0, baseR * brightness));
  const g = Math.min(1, Math.max(0, baseG * brightness));
  const b = Math.min(1, Math.max(0, baseB * brightness));

  love.graphics.setColor(r, g, b, 1);
  love.graphics.polygon('fill', x0, y0, x1, y1, x2, y2);
}

class Asteroid {
  static new(x, y, radius) {
    return new Asteroid(x, y, radius);
  }

  constructor(x, y, radius) {
    this.pos = new Vector2(x, y);
    this.radius = radius;
    this.mass = radius * radius;

    const dir = new Vector2(Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
    this.vel = dir.multiply(constants.PLANET_SPEED);

    this.angularSpeed = (Math.random() * 2 - 1) * 0.05;
    this.angle = Math.random() * Math.PI * 2;

    // Base brown color (roughly #A85417)
    this.color = [0.66, 0.33, 0.09];

    this.points = this.generatePoints();
    this.interiorPoints = [];

    const numInterior = 2 + Math.floor(Math.random() * 2); // 2 or 3
    for (let i = 0; i < numInterior; i++) {
      this.interiorPoints.push(new Vector2(
        (Math.random() - 0.5) * this.radius * 1.2,
        (Math.random() - 0.5) * this.radius * 1.2,
      ));
    }
  }

  generatePoints() {
    const numSides = 6 + Math.floor(Math.random() * 6); // 6–11
    const points = [];
    const angleStep = (2 * Math.PI) / numSides;

    for (let i = 0; i < numSides; i++) {
      const a = i * angleStep + (Math.random() - 0.5) * angleStep * 0.5;
      const r = this.radius * (0.7 + Math.random() * 0.6);
      points.push(new Vector2(Math.cos(a) * r, Math.sin(a) * r));
    }

    return points;
  }

  update() {
    const ts = state.timeScale ?? 1;

    const drag = constants.DRAG ?? 0.995;
    this.vel.scale(drag ** ts);

    this.pos.addScaled(this.vel, ts);
    this.angle += this.angularSpeed * ts;

    // Bounce off world edges
    if (this.pos.x - this.radius < 0) {
      this.pos.x = this.radius;
      this.vel.x = -this.vel.x;
    }
    if (this.pos.x + this.radius > state.sceneWidth) {
      this.pos.x = state.sceneWidth - this.radius;
      this.vel.x = -this.vel.x;
    }
    if (this.pos.y - this.radius < 0) {
      this.pos.y = this.radius;
      this.vel.y = -this.vel.y;
    }
    if (this.pos.y + this.radius > state.sceneHeight) {
      this.pos.y = state.sceneHeight - this.radius;
      this.vel.y = -this.vel.y;
    }
  }

  draw() {
    love.graphics.push();
    love.graphics.translate(this.pos.x, this.pos.y);
    love.graphics.rotate(this.angle);

    const lightDir = new Vector2(-0.7, -0.7).normalize();
    const [br, bg, bb] = this.color;

    // Faceted body
    const n = this.points.length;
    for (let i = 0; i < n; i++) {
      const p1 = this.points[i];
      const p2 = this.points[(i + 1) % n];

      // Connect to each interior point
      for (const ip of this.interiorPoints) {
        fillTriangle(p1.x, p1.y, p2.x, p2.y, ip.x, ip.y, br, bg, bb, lightDir, this.radius);
      }

      // Small mid-edge facet
      const mx = (p1.x + p2.x) * 0.5;
      const my = (p1.y + p2.y) * 0.5;
      fillTriangle(p1.x, p1.y, mx, my, p2.x, p2.y, br, bg, bb, lightDir, this.radius);
    }

    // Dark outline
    love.graphics.setColor(0.23, 0.11, 0.03, 1);
    love.graphics.setLineWidth(2);
    const outline = [];
    for (const p of this.points) outline.push(p.x, p.y);
    love.graphics.polygon('line', outline);

    // Subtle inner shadow (simple darkening toward the edge)
    love.graphics.setColor(0, 0, 0, 0.22);
    love.graphics.polygon('fill', outline);

    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.setLineWidth(1);
    love.graphics.pop();
  }
}

export default Asteroid;
