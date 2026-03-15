// js/world/SpikeyPlanetoid.js
import { Planetoid } from './Planetoid.js';
import { state } from '../state.js';

export class SpikeyPlanetoid extends Planetoid {
  constructor(x, y, radius) {
    super(x, y, radius, 'gray');
    this.isSpikey = true;
    this.spikeHeight = 8;
    this.spikeSpacing = 6;
    this.padding = this.spikeHeight;
    this.spikeRotation = 0;
    this.spikeRotationSpeed = 0.02;
  }

  createOffscreen() {
    const padding = this.padding;
    this.offscreen = document.createElement('canvas');
    this.offscreen.width = 2 * (this.radius + padding);
    this.offscreen.height = 2 * (this.radius + padding);
    const offCtx = this.offscreen.getContext('2d');
    const cx = this.radius + padding;
    const cy = this.radius + padding;
    // Planet body
    offCtx.beginPath();
    offCtx.arc(cx, cy, this.radius, 0, Math.PI * 2);
    offCtx.fillStyle = this.color;
    offCtx.fill();
    // Lighting gradient
    offCtx.save();
    offCtx.globalCompositeOperation = 'multiply';
    const offsetX = -this.radius * 0.5;
    const offsetY = -this.radius * 0.5;
    const lightGradient = offCtx.createRadialGradient(
      cx + offsetX, cy + offsetY, 0,
      cx + offsetX, cy + offsetY, this.radius * 1.5
    );
    lightGradient.addColorStop(0, 'white');
    lightGradient.addColorStop(1, 'black');
    offCtx.beginPath();
    offCtx.arc(cx, cy, this.radius, 0, Math.PI * 2);
    offCtx.fillStyle = lightGradient;
    offCtx.fill();
    offCtx.globalCompositeOperation = 'source-over';
    offCtx.restore();
  }

  drawSpikes(ctx) {
    const numSpikes = Math.floor(2 * Math.PI * this.radius / this.spikeSpacing);
    const angleStep = 2 * Math.PI / numSpikes;
    const halfBaseAngle = angleStep / 2;
    for (let i = 0; i < numSpikes; i++) {
      const angle = i * angleStep;
      const leftAngle = angle - halfBaseAngle;
      const rightAngle = angle + halfBaseAngle;
      const baseLeftX = Math.cos(leftAngle) * this.radius;
      const baseLeftY = Math.sin(leftAngle) * this.radius;
      const baseRightX = Math.cos(rightAngle) * this.radius;
      const baseRightY = Math.sin(rightAngle) * this.radius;
      const tipX = Math.cos(angle) * (this.radius + this.spikeHeight);
      const tipY = Math.sin(angle) * (this.radius + this.spikeHeight);
      ctx.beginPath();
      ctx.moveTo(baseLeftX, baseLeftY);
      ctx.lineTo(tipX, tipY);
      ctx.lineTo(baseRightX, baseRightY);
      ctx.closePath();
      ctx.fillStyle = 'darkgray';
      ctx.fill();
    }
  }

  draw() {
    const ctx = state.ctx;
    const now = Date.now();
    if (now - this.lastAlphaUpdate > 500) {
      const dist = this.pos.subtract(state.player.pos).length();
      this.cachedAlpha = Math.max(0.01, 0.3 - (dist / 1000) * 0.65);
      this.lastAlphaUpdate = now;
    }
    // Influence radius
    ctx.save();
    ctx.strokeStyle = `rgba(173,216,230,${this.cachedAlpha})`;
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 5]);
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, this.influenceRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    // Planet body
    ctx.save();
    ctx.shadowColor = 'rgba(173,216,230,0.3)';
    ctx.shadowBlur = 25;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    if (this.offscreen) {
      ctx.drawImage(
        this.offscreen,
        this.pos.x - (this.radius + this.padding),
        this.pos.y - (this.radius + this.padding)
      );
    } else {
      ctx.beginPath();
      ctx.arc(this.pos.x, this.pos.y, this.radius, 0, Math.PI * 2);
      ctx.fillStyle = this.color;
      ctx.fill();
    }
    ctx.restore();
    // Rotate spikes
    this.spikeRotation += this.spikeRotationSpeed;
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.spikeRotation);
    this.drawSpikes(ctx);
    ctx.restore();
  }
}