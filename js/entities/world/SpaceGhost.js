// js/entities/world/SpaceGhost.js
import { Entity } from '../Entity.js';
import { state } from '../../state.js';
import {
  ENEMY_RADIUS,
  GRAVITY_STRENGTH,
  SURFACE_TOLERANCE,
  DRAG,
  ENEMY_JUMP_PROB,
  JUMP_STRENGTH
} from '../../constants.js';
import { Vector2 } from '../../vector2.js';

export class SpaceGhost extends Entity {
  constructor(planet, color) {
    super();
    this.planet = planet;
    this.angularSpeed = (Math.random() > 0.5 ? 1 : -1) * 0.02;
    this.angle = Math.random() * Math.PI * 2;
    this.radius = ENEMY_RADIUS;
    this.onSurface = true;
    this.color = color;
    this.lastInfluencePlanet = planet;

    // Animation phase for ghost bottom wiggle
    this.wavePhase = Math.random() * Math.PI * 2;

    this.updatePosition();
  }

  updatePosition() {
    const surfaceDist = this.planet.radius + this.radius;
    this.pos.x = this.planet.pos.x + Math.cos(this.angle) * surfaceDist;
    this.pos.y = this.planet.pos.y + Math.sin(this.angle) * surfaceDist;
  }

  update() {
    // advance ghost cloth animation
    this.wavePhase += 0.15;

    // Normal rotation on current planet
    if (this.onSurface) {
      this.angle += this.angularSpeed;
      this.updatePosition();

      // chance to jump to a nearby planet
      if (Math.random() < ENEMY_JUMP_PROB) {
        for (const p of state.planetoids) {
          if (p !== this.planet && !p.isSpikey) {
            const dist = this.pos.subtract(p.pos).length();

            if (dist < p.influenceRadius) {
              const direction = this.pos.subtract(this.planet.pos).normalize();
              this.vel = direction.multiply(JUMP_STRENGTH);
              this.onSurface = false;
              this.planet = p;
              break;
            }
          }
        }
      }
    }

    // Apply gravity if in jump
    if (!this.onSurface) {

      if (!this.vel) this.vel = new Vector2();

      let dominant = this.findDominantPlanet();

      if (dominant) {
        this.lastInfluencePlanet = dominant;

        const dir = dominant.pos.subtract(this.pos).normalize();
        this.vel.add(dir.multiply(GRAVITY_STRENGTH));
      }

      this.vel = this.vel.multiply(DRAG);
      this.pos.add(this.vel);

      // Bound to scene
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

      if (dominant) {

        // Check landing
        const offset = this.pos.subtract(dominant.pos);
        const dist = offset.length();

        if (dist <= dominant.radius + this.radius + SURFACE_TOLERANCE) {

          if (!dominant.isSpikey) {

            const normal = offset.normalize();

            this.pos = dominant.pos.clone().add(
              normal.multiply(dominant.radius + this.radius)
            );

            this.onSurface = true;

            this.angle = Math.atan2(
              this.pos.y - dominant.pos.y,
              this.pos.x - dominant.pos.x
            );

            this.planet = dominant;
            this.vel = new Vector2();

          } else {

            // Bounce off spikey
            const normal = offset.normalize();
            const dot = this.vel.dot(normal);

            this.vel.subtract(normal.multiply(2 * dot));

            this.pos.add(
              normal.multiply(
                dominant.radius + this.radius + SURFACE_TOLERANCE - dist
              )
            );
          }
        }
      }
    }
  }

  findDominantPlanet() {
    let closest = null;
    let minDist = Infinity;

    for (const planet of state.planetoids) {

      const dist = this.pos.subtract(planet.pos).length();

      if (dist < planet.influenceRadius && dist < minDist) {
        minDist = dist;
        closest = planet;
      }
    }

    return closest;
  }

  draw() {

    const ctx = state.ctx;

    // Determine down direction (towards planet center)
    let planet = this.onSurface ? this.planet : this.lastInfluencePlanet;

    let downDir = new Vector2(0, 1);

    if (planet) {
      downDir = planet.pos.subtract(this.pos).normalize();
    }

    const downAngle = Math.atan2(downDir.y, downDir.x);
    const rotation = downAngle - Math.PI / 2;

    ctx.save();

    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(rotation);

    // Draw ghost body
    ctx.fillStyle = this.color;
    ctx.beginPath();

    // top semicircle
    ctx.arc(0, 0, this.radius, Math.PI, 0, false);

    // triangular cloth bottom
    const spikeCount = 4;
    const width = this.radius * 2.1;
    const step = width / spikeCount;

    for (let i = 0; i < spikeCount; i++) {

      const left = this.radius - i * step;
      const right = this.radius - (i + 1) * step;
      const mid = (left + right) / 2;

      const wave = Math.sin(this.wavePhase + i) * (this.radius * 0.2);

      ctx.lineTo(left, this.radius);
      ctx.lineTo(mid, this.radius + this.radius * 0.25 + wave);
      ctx.lineTo(right, this.radius);
    }

    ctx.closePath();
    ctx.fill();

    // --- Determine pupil direction ---
    let pupilOffsetX = 0;
    let pupilOffsetY = 0;

    const pupilMove = this.radius * 0.12;

    if (this.onSurface) {

      // moving around planet
      if (this.angularSpeed > 0) {
        pupilOffsetX = pupilMove;
      } else {
        pupilOffsetX = -pupilMove;
      }

    } else if (this.vel) {

      // moving in space
      if (Math.abs(this.vel.x) > Math.abs(this.vel.y)) {
        pupilOffsetX = this.vel.x > 0 ? pupilMove : -pupilMove;
      } else {
        pupilOffsetY = this.vel.y > 0 ? pupilMove : -pupilMove;
      }
    }

    // Eyes
    ctx.fillStyle = 'white';

    const leftEyeX = -this.radius / 3;
    const rightEyeX = this.radius / 3;
    const eyeY = -this.radius / 3;
    const eyeRadius = this.radius / 4;

    ctx.beginPath();
    ctx.arc(leftEyeX, eyeY, eyeRadius, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(rightEyeX, eyeY, eyeRadius, 0, Math.PI * 2);
    ctx.fill();

    // Pupils
    ctx.fillStyle = 'black';

    const pupilRadius = this.radius / 8;

    ctx.beginPath();
    ctx.arc(leftEyeX + pupilOffsetX, eyeY + pupilOffsetY, pupilRadius, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(rightEyeX + pupilOffsetX, eyeY + pupilOffsetY, pupilRadius, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }
}