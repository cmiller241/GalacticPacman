// js/entities/Particle.js
import { state } from '../state.js';
import { Vector2 } from '../vector2.js';

export class Particle {
  constructor(pos, vel, life = 40) {
    this.pos = pos.clone();
    this.vel = vel;
    this.life = life;
    // Stored separately from the live-decrementing life above, so the
    // alpha fade in draw() scales correctly regardless of what life
    // value was passed in — previously hardcoded to /40, which was
    // wrong for any particle NOT created with the default life.
    this.maxLife = life;
    // Any valid CSS color string (hex, rgb, hsl, named) — alpha is
    // applied separately via globalAlpha in draw() rather than baked
    // into this string, so it works regardless of format. Defaults to
    // the original hardcoded yellow, so any existing caller that
    // doesn't set this explicitly (e.g. Player.js's teleport
    // particles) looks exactly the same as before.
    //
    // NOTE: draw() previously never actually read this property at
    // all — it was hardcoded to rgba(255,255,0,...) regardless of what
    // callers set here, silently no-op-ing utils.js's
    // createDeathParticles' own color override. Fixed below.
    this.color = 'rgb(255, 255, 0)';
    this.radius = 2; // matches the original hardcoded draw size
    // Both default to "no effect," so any existing caller that doesn't
    // set these explicitly (every current caller) behaves exactly as
    // before.
    this.drag = 1;     // velocity multiplier applied per frame — 1 = constant velocity forever, <1 = decelerates over time
    this.growRate = 0; // radius change per frame — 0 = constant size, positive = expands over its lifetime
  }
  update() {
    const timeScale = state.timeScale;
    this.pos.add(this.vel.clone().multiply(timeScale));
    // Math.pow for the drag decay — see Asteroid.js's identical
    // reasoning for why an exponential per-frame rate needs to be
    // exponentiated by timeScale, not just multiplied.
    this.vel = this.vel.multiply(Math.pow(this.drag, timeScale));
    this.radius += this.growRate * timeScale;
    this.life -= timeScale;
  }
  draw() {
    const ctx = state.ctx;
    if (this.life <= 0) return;
    ctx.globalAlpha = this.life / this.maxLife;
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, this.radius, 0, Math.PI * 2);
    ctx.fillStyle = this.color;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}