// js/world/Planetoid.js
import { state } from '../state.js';
import { INFLUENCE_PADDING, PLANET_SPEED } from '../constants.js';
import { Vector2 } from '../vector2.js';

export class Planetoid {
  // How far the glow extends past the planet's edge, and how strong it
  // is. These used to be set live via ctx.shadowBlur every frame; now
  // they're only used once, at bake time, in createOffscreen(). If the
  // glow ever looks clipped/square at the edges, increase SHADOW_PADDING.
  static SHADOW_BLUR = 25;
  static SHADOW_PADDING = 40;
  static SHADOW_COLOR = 'rgba(173,216,230,0.3)';

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
    this.offscreenPadding = 0;
    this.ringCanvas = null;
    this.interiorType = null; // "maze", "platform", etc.
  }

  createOffscreen() {
    // ---- Step 1: render the flat planet body (texture + color tint +
    // lighting) onto an unshadowed working canvas, same as before. ----
    const bodyCanvas = document.createElement('canvas');
    bodyCanvas.width = this.radius * 2;
    bodyCanvas.height = this.radius * 2;
    const bodyCtx = bodyCanvas.getContext('2d');

    bodyCtx.save();
    bodyCtx.beginPath();
    bodyCtx.arc(this.radius, this.radius, this.radius, 0, Math.PI * 2);
    bodyCtx.clip();
    const tiles = 2.5;
    const texSize = this.radius * 2 * tiles;
    const texOffset = this.radius * tiles;
    bodyCtx.drawImage(state.planetTexture, this.radius - texOffset, this.radius - texOffset, texSize, texSize);
    bodyCtx.restore();

    bodyCtx.save();
    bodyCtx.globalCompositeOperation = 'multiply';
    bodyCtx.beginPath();
    bodyCtx.arc(this.radius, this.radius, this.radius, 0, Math.PI * 2);
    bodyCtx.fillStyle = this.color;
    bodyCtx.fill();
    bodyCtx.globalCompositeOperation = 'source-over';
    bodyCtx.restore();

    bodyCtx.save();
    bodyCtx.globalCompositeOperation = 'multiply';
    const offsetX = -this.radius * 0.5;
    const offsetY = -this.radius * 0.5;
    const lightGradient = bodyCtx.createRadialGradient(
      this.radius + offsetX, this.radius + offsetY, 0,
      this.radius + offsetX, this.radius + offsetY, this.radius * 1.5
    );
    lightGradient.addColorStop(0, 'white');
    lightGradient.addColorStop(1, 'black');
    bodyCtx.beginPath();
    bodyCtx.arc(this.radius, this.radius, this.radius, 0, Math.PI * 2);
    bodyCtx.fillStyle = lightGradient;
    bodyCtx.fill();
    bodyCtx.globalCompositeOperation = 'source-over';
    bodyCtx.restore();

    // ---- Step 2: bake the glow ONCE onto a padded final canvas, by
    // drawing bodyCanvas with shadow properties set on THIS context.
    // The blur becomes part of the final pixels, so draw() never pays
    // for a live shadowBlur again — it just blits the result. ----
    const padding = Planetoid.SHADOW_PADDING;
    this.offscreenPadding = padding;
    this.offscreen = document.createElement('canvas');
    this.offscreen.width = this.radius * 2 + padding * 2;
    this.offscreen.height = this.radius * 2 + padding * 2;
    const finalCtx = this.offscreen.getContext('2d');
    finalCtx.shadowColor = Planetoid.SHADOW_COLOR;
    finalCtx.shadowBlur = Planetoid.SHADOW_BLUR;
    finalCtx.shadowOffsetX = 0;
    finalCtx.shadowOffsetY = 0;
    finalCtx.drawImage(bodyCanvas, padding, padding);

    // ---- Step 3: bake the dashed influence-radius ring at full
    // opacity too, so draw() can blit it with a cheap globalAlpha
    // instead of re-stroking a dashed path every frame. ----
    this.ringCanvas = document.createElement('canvas');
    this.ringCanvas.width = this.influenceRadius * 2;
    this.ringCanvas.height = this.influenceRadius * 2;
    const ringCtx = this.ringCanvas.getContext('2d');
    ringCtx.strokeStyle = 'rgba(173,216,230,1)';
    ringCtx.lineWidth = 3;
    ringCtx.setLineDash([10, 5]);
    ringCtx.beginPath();
    ringCtx.arc(this.influenceRadius, this.influenceRadius, this.influenceRadius, 0, Math.PI * 2);
    ringCtx.stroke();
  }

  draw() {
    const ctx = state.ctx;
    const now = Date.now();
    if (now - this.lastAlphaUpdate > 500) {
      const dist = this.pos.subtract(state.player.pos).length();
      this.cachedAlpha = Math.max(0.01, 0.3 - (dist / 1000) * 0.65);
      this.lastAlphaUpdate = now;
    }

    // Influence radius ring: pre-baked at full alpha, blended in via
    // globalAlpha — much cheaper than re-stroking a dashed circle
    // every frame for every planet.
    if (this.ringCanvas) {
      ctx.save();
      ctx.globalAlpha = this.cachedAlpha;
      ctx.drawImage(this.ringCanvas, this.pos.x - this.influenceRadius, this.pos.y - this.influenceRadius);
      ctx.restore();
    } else {
      // Fallback: only hit if draw() somehow runs before createOffscreen()
      ctx.save();
      ctx.strokeStyle = `rgba(173,216,230,${this.cachedAlpha})`;
      ctx.lineWidth = 3;
      ctx.setLineDash([10, 5]);
      ctx.beginPath();
      ctx.arc(this.pos.x, this.pos.y, this.influenceRadius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Planet body + baked-in glow — one drawImage, no live shadow cost.
    if (this.offscreen) {
      const padding = this.offscreenPadding;
      ctx.drawImage(this.offscreen, this.pos.x - this.radius - padding, this.pos.y - this.radius - padding);
    } else {
      // Fallback: live-rendered gradient, only hit if createOffscreen()
      // hasn't run yet (rare after init).
      ctx.save();
      ctx.shadowColor = Planetoid.SHADOW_COLOR;
      ctx.shadowBlur = Planetoid.SHADOW_BLUR;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
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
      ctx.restore();
    }
  }
}