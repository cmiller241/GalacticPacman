// js/world/Planetoid.js
import { state } from '../state.js';
import { INFLUENCE_PADDING, PLANET_SPEED } from '../constants.js';
import { Vector2 } from '../vector2.js';
import { getPlanetBody, drawBaked } from '../render/PlanetLook.js';
import { drawInfluenceRing } from '../render/InfluenceRing.js';

export class Planetoid {
  // color: [r, g, b] in 0..1 (see planetColors in constants.js).
  constructor(x, y, radius, color) {
    this.pos = new Vector2(x, y);
    this.radius = radius;
    this.mass = radius * radius;
    this.influenceRadius = radius + INFLUENCE_PADDING;
    this.color = color;
    let direction = new Vector2(Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
    this.vel = direction.multiply(PLANET_SPEED);
    this.cachedAlpha = 0.3;
    this.lastAlphaUpdate = 0;
    this.isSpikey = false;
    this.body = null;
  }

  createOffscreen() {
    this.body = getPlanetBody(this.radius, this.color, state.planetTexture);
  }

  drawInfluenceRing() {
    const now = Date.now();
    if (now - this.lastAlphaUpdate > 500) {
      const dx = this.pos.x - state.player.pos.x, dy = this.pos.y - state.player.pos.y;
      this.cachedAlpha = Math.max(0.01, 0.3 - (Math.sqrt(dx * dx + dy * dy) / 1000) * 0.65);
      this.lastAlphaUpdate = now;
    }
    drawInfluenceRing(state.ctx, this.pos.x, this.pos.y, this.influenceRadius, this.cachedAlpha);
  }

  draw() {
    this.drawInfluenceRing();
    if (!this.body) this.createOffscreen();
    drawBaked(state.ctx, this.body, this.pos.x, this.pos.y);
  }
}
