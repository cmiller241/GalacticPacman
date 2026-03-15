// js/world/BeamPlanetoid.js
import { Planetoid } from './Planetoid.js';
import { state } from '../state.js';
import { Vector2 } from '../vector2.js';

export class BeamPlanetoid extends Planetoid {
  constructor(x, y, radius, color, beamColor) {
    super(x, y, radius, color);
    this.beamColor = beamColor;
    this.beamAngle = -Math.PI / 2;
    this.beamLength = 140;
    this.beamWidth = 14;
    this.beamParticles = [];
    this.portalParticles = [];
    this.interior = null;
  }

  getBeamStart() {
    return new Vector2(
      this.pos.x + Math.cos(this.beamAngle) * this.radius,
      this.pos.y + Math.sin(this.beamAngle) * this.radius
    );
  }

  getBeamEnd(start) {
    return new Vector2(
      start.x + Math.cos(this.beamAngle) * this.beamLength,
      start.y + Math.sin(this.beamAngle) * this.beamLength
    );
  }

  getPortalPosition() {
    if (this.interior) {
      return this.interior.getPortalPosition();
    }
    // Fallback or error if no interior
    throw new Error('No interior set for BeamPlanetoid');
  }

  spawnPortalParticles(pos) {
    if (Math.random() < 0.5) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1 + Math.random() * 2;
      const vel = new Vector2(
        Math.cos(angle) * speed,
        Math.sin(angle) * speed
      );
      this.portalParticles.push(
        new PortalParticle(pos, vel, 40, this.beamColor)
      );
    }
  }

  spawnBeamParticles(start) {
    if (Math.random() < 0.6) {
      const beamDir = new Vector2(
        Math.cos(this.beamAngle),
        Math.sin(this.beamAngle)
      );
      const side = new Vector2(-beamDir.y, beamDir.x)
        .multiply((Math.random() - 0.5) * 1.5);
      const speed = 2 + Math.random() * 2;
      const vel = beamDir.multiply(speed).add(side);
      this.beamParticles.push(
        new BeamParticle(start, vel, 50, this.beamColor)
      );
    }
  }

  drawBeam(start, end) {
    const ctx = state.ctx;
    const gradient = ctx.createLinearGradient(
      start.x, start.y, end.x, end.y
    );
    gradient.addColorStop(0, this.beamColor);
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.save();
    ctx.shadowColor = this.beamColor;
    ctx.shadowBlur = 60;
    ctx.strokeStyle = gradient;
    ctx.lineWidth = this.beamWidth;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.shadowBlur = 20;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(start.x - 8, start.y);
    ctx.lineTo(end.x - 8, end.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(start.x + 8, start.y);
    ctx.lineTo(end.x + 8, end.y);
    ctx.stroke();
    ctx.restore();
  }

  updateParticles() {
    for (let i = this.beamParticles.length - 1; i >= 0; i--) {
      const p = this.beamParticles[i];
      p.update();
      p.draw();
      if (p.life <= 0) {
        this.beamParticles.splice(i, 1);
      }
    }
    for (let i = this.portalParticles.length - 1; i >= 0; i--) {
      const p = this.portalParticles[i];
      p.update();
      p.draw();
      if (p.life <= 0) {
        this.portalParticles.splice(i, 1);
      }
    }
  }

  drawInterior() {
    if (this.interior) {
      this.interior.draw();
    }
  }

  draw() {
    super.draw();
    this.drawInterior();
    const start = this.getBeamStart();
    const end = this.getBeamEnd(start);
    const portal = this.getPortalPosition();
    this.spawnBeamParticles(start);
    this.spawnPortalParticles(portal);
    this.drawBeam(start, end);
    this.updateParticles();
  }
}

class BeamParticle {
  constructor(pos, vel, life = 40, color = 'rgba(255,0,255,1)') {
    this.pos = pos.clone();
    this.vel = vel;
    this.life = life;
    this.maxLife = life;
    this.color = color;
  }

  update() {
    this.pos.add(this.vel);
    this.life--;
  }

  draw() {
    const ctx = state.ctx;
    if (this.life <= 0) return;
    const alpha = this.life / this.maxLife;
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = this.color.replace("1)", `${alpha})`);
    ctx.fill();
  }
}

class PortalParticle {
  constructor(pos, vel, life = 35, color = 'rgba(255,0,255,1)') {
    this.pos = pos.clone();
    this.vel = vel;
    this.life = life;
    this.maxLife = life;
    this.color = color;
  }

  update() {
    this.pos.add(this.vel);
    this.life--;
  }

  draw() {
    const ctx = state.ctx;
    if (this.life <= 0) return;
    const alpha = this.life / this.maxLife;
    const size = 3 * alpha;
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, size, 0, Math.PI * 2);
    ctx.fillStyle = this.color.replace("1)", `${alpha})`);
    ctx.fill();
  }
}