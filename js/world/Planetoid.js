// js/world/Planetoid.js
import { state } from '../state.js';
import { INFLUENCE_PADDING, PLANET_SPEED } from '../constants.js';
import { Vector2 } from '../vector2.js';

export class Planetoid {
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
    this.offscreen = null;
    this.interiorType = null; // "maze", "platform", etc.
  }

  createOffscreen() {
    this.offscreen = document.createElement('canvas');
    this.offscreen.width = this.radius * 2;
    this.offscreen.height = this.radius * 2;
    const offCtx = this.offscreen.getContext('2d');
    offCtx.save();
    offCtx.beginPath();
    offCtx.arc(this.radius, this.radius, this.radius, 0, Math.PI * 2);
    offCtx.clip();
    const tiles = 2.5;
    const texSize = this.radius * 2 * tiles;
    const texOffset = this.radius * tiles;
    offCtx.drawImage(state.planetTexture, this.radius - texOffset, this.radius - texOffset, texSize, texSize);
    offCtx.restore();
    offCtx.save();
    offCtx.globalCompositeOperation = 'multiply';
    offCtx.beginPath();
    offCtx.arc(this.radius, this.radius, this.radius, 0, Math.PI * 2);
    offCtx.fillStyle = this.color;
    offCtx.fill();
    offCtx.globalCompositeOperation = 'source-over';
    offCtx.restore();
    offCtx.save();
    offCtx.globalCompositeOperation = 'multiply';
    const offsetX = -this.radius * 0.5;
    const offsetY = -this.radius * 0.5;
    const lightGradient = offCtx.createRadialGradient(
      this.radius + offsetX, this.radius + offsetY, 0,
      this.radius + offsetX, this.radius + offsetY, this.radius * 1.5
    );
    lightGradient.addColorStop(0, 'white');
    lightGradient.addColorStop(1, 'black');
    offCtx.beginPath();
    offCtx.arc(this.radius, this.radius, this.radius, 0, Math.PI * 2);
    offCtx.fillStyle = lightGradient;
    offCtx.fill();
    offCtx.globalCompositeOperation = 'source-over';
    offCtx.restore();
  }

  draw() {
    const ctx = state.ctx;
    const now = Date.now();
    if (now - this.lastAlphaUpdate > 500) {
      const dist = this.pos.subtract(state.player.pos).length();
      this.cachedAlpha = Math.max(0.01, 0.3 - (dist / 1000) * 0.65);
      this.lastAlphaUpdate = now;
    }
    // Batch stroke-related settings for influence radius
    ctx.save();
    ctx.strokeStyle = `rgba(173,216,230,${this.cachedAlpha})`;
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 5]);
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, this.influenceRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    // Batch shadow settings for planet body (applied once before draw, reset after)
    ctx.save();
    ctx.shadowColor = 'rgba(173,216,230,0.3)';
    ctx.shadowBlur = 25;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    if (this.offscreen) {
      ctx.drawImage(this.offscreen, this.pos.x - this.radius, this.pos.y - this.radius);
    } else {
      // Fallback: Create gradient only if needed (rare after init)
      const offsetX = -this.radius * 0.5;
      const offsetY = -this.radius * 0.5;
      const gradient = ctx.createRadialGradient(
        this.pos.x + offsetX, this.pos.y + offsetY, 0,
        this.pos.x + offsetX, this.pos.y + offsetY, this.radius * 1.5
      );
      gradient.addColorStop(0, this.color);
      gradient.addColorStop(1, 'black');
      ctx.beginPath();
      ctx.arc(this.pos.x, this.pos.y, this.radius, 0, Math.PI * 2);
      ctx.fillStyle = gradient;
      ctx.fill();
    }
    ctx.restore(); // Reset shadow after draw
  }
}