// js/world/SpikeyPlanetoid.js
//
// Looks like the main game's Spikey (js/world/Spikey.js): a dark metallic
// orb with a lit rim and a warm reddish glow, ringed by bright off-white
// spikes that spin slowly.
import { Planetoid } from './Planetoid.js';
import { state } from '../state.js';
import { getGlowOrb, drawBaked } from '../render/PlanetLook.js';

const ORB_COLORS = {
  dark: [0.05, 0.05, 0.06],
  light: [0.28, 0.26, 0.26],
  rim: [0.55, 0.42, 0.4],
  glow: [0.55, 0.18, 0.15],
};
const ORB_OPTIONS = { glowRadiusMult: 1.3, glowStrength: 0.4, rimStrength: 0.35 };
const SPIKE_COLOR = 'rgb(240,237,230)';
const spikePathCache = new Map();

export class SpikeyPlanetoid extends Planetoid {
  constructor(x, y, radius) {
    super(x, y, radius, null);
    this.isSpikey = true;
    this.spikeHeight = 8;
    this.spikeSpacing = 6;
    this.spikeRotation = 0;
    this.spikeRotationOffset = Math.random() * Math.PI * 2;
    this.spikeRotationSpeed = 0.02;
  }

  createOffscreen() {
    this.body = getGlowOrb(this.radius, ORB_COLORS, ORB_OPTIONS);
  }

  // The ring of spikes, built once per radius and reused (only its
  // rotation changes from frame to frame).
  spikePath() {
    const key = `${this.radius}|${this.spikeHeight}|${this.spikeSpacing}`;
    let path = spikePathCache.get(key);
    if (path) return path;
    path = new Path2D();
    const numSpikes = Math.floor(2 * Math.PI * this.radius / this.spikeSpacing);
    const angleStep = 2 * Math.PI / numSpikes;
    const halfBaseAngle = angleStep / 2;
    for (let i = 0; i < numSpikes; i++) {
      const angle = i * angleStep;
      const leftAngle = angle - halfBaseAngle;
      const rightAngle = angle + halfBaseAngle;
      path.moveTo(Math.cos(leftAngle) * this.radius, Math.sin(leftAngle) * this.radius);
      path.lineTo(Math.cos(angle) * (this.radius + this.spikeHeight), Math.sin(angle) * (this.radius + this.spikeHeight));
      path.lineTo(Math.cos(rightAngle) * this.radius, Math.sin(rightAngle) * this.radius);
      path.closePath();
    }
    spikePathCache.set(key, path);
    return path;
  }

  drawSpikes(ctx) {
    ctx.fillStyle = SPIKE_COLOR;
    ctx.fill(this.spikePath());
  }

  draw() {
    const ctx = state.ctx;
    this.drawInfluenceRing();
    if (!this.body) this.createOffscreen();
    drawBaked(ctx, this.body, this.pos.x, this.pos.y);
    // Rotate spikes
    // Spin by the clock (spikeRotationSpeed per 1/60 s), not per drawn
    // frame — so it turns at the same speed on any screen, on screen or off.
    this.spikeRotation = this.spikeRotationOffset + (performance.now() / 1000) * 60 * this.spikeRotationSpeed;
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.spikeRotation);
    this.drawSpikes(ctx);
    ctx.restore();
  }
}
