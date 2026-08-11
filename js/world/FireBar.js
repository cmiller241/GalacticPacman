// js/world/FireBar.js
import { state } from '../state.js';
import { Vector2 } from '../vector2.js';

// A small, short-lived drifting spark spawned continuously from each
// fireball's current position — purely decorative (no collision), just
// what actually sells "fire" rather than "glowing orange dot." Kept as
// a lightweight, self-contained particle here rather than routing
// through the shared state.particles system, since this effect is
// entirely FireBar's own concern.
class FireEmber {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    const angle = Math.random() * Math.PI * 2;
    const speed = 0.3 + Math.random() * 0.6;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed - 0.35; // slight upward bias — embers rise, they don't just scatter
    this.life = 1; // counts down to 0
    this.decay = 0.025 + Math.random() * 0.03;
    this.radius = 1.3 + Math.random() * 2;
    this.hue = 18 + Math.random() * 30; // orange-yellow range
  }

  update(timeScale) {
    this.x += this.vx * timeScale;
    this.y += this.vy * timeScale;
    // Math.pow for the drag decay — see Asteroid.js's identical
    // reasoning for why an exponential per-frame rate needs to be
    // exponentiated by timeScale, not just multiplied.
    this.vx *= Math.pow(0.97, timeScale);
    this.vy *= Math.pow(0.97, timeScale);
    this.life -= this.decay * timeScale;
  }
}

// A classic Super Mario Bros-style fire bar: a fixed block with a
// rotating, double-sided bar of fireballs extending from it. The block
// never moves, ever — collisions push whatever hit it away instead
// (see CollisionSystem.handleImmovableCollisions). The fireballs are a
// pure hazard: touching one kills the player, same as a spikey
// planetoid, but they don't physically interact with other objects at
// all — only the block does.
export class FireBar {
  constructor(x, y, options = {}) {
    this.pos = new Vector2(x, y);

    // Used by CollisionSystem.handleImmovableCollisions, which treats
    // any entity with this flag as having effectively infinite mass —
    // see that method's own comment for the physics reasoning.
    this.isImmovable = true;

    this.blockRadius = options.blockRadius ?? 25;
    // Plain alias so generic collision code that expects a `.radius`
    // property (the same convention Planetoid/Asteroid/etc. already
    // use) works without needing to know this is a FireBar at all.
    this.radius = this.blockRadius;

    this.barLength = options.barLength ?? 500;       // how far fireballs extend from the block, on EACH side
    this.numFireballs = options.numFireballs ?? 10;   // per side (so numFireballs*2 total — double-sided through the pivot)
    this.fireballRadius = options.fireballRadius ?? 15;
    this.rotationSpeed = options.rotationSpeed ?? 0.05; // radians/frame
    this.angle = options.startAngle ?? 0;

    // Lowered from an earlier 0.35 default: numFireballs doubled (5->10)
    // and multiple bars now exist simultaneously (see game.js), so the
    // old rate would multiply into a much larger steady-state ember
    // count than a single test bar ever produced. Tune back up if it
    // looks too sparse once you see several bars at once.
    this.emberSpawnChance = options.emberSpawnChance ?? 0.15;

    this.embers = [];
  }

  update() {
    const timeScale = state.timeScale;
    this.angle += this.rotationSpeed * timeScale;

    const fireballs = this.getFireballPositions();
    for (const f of fireballs) {
      // Scaled so fewer embers spawn per REAL second while slowed —
      // this loop still runs once per real frame regardless of
      // timeScale (only how far things move per frame changes, not
      // the frame rate itself), so without scaling this chance the
      // spawn rate per real-second would stay exactly the same even
      // while everything else visibly slows down.
      if (Math.random() < this.emberSpawnChance * timeScale) {
        this.embers.push(new FireEmber(f.x, f.y));
      }
    }

    for (let i = this.embers.length - 1; i >= 0; i--) {
      this.embers[i].update(timeScale);
      if (this.embers[i].life <= 0) {
        this.embers.splice(i, 1);
      }
    }
  }

  // World-space {x, y, radius} for every fireball along the bar right
  // now — evenly spaced from just outside the block out to barLength,
  // mirrored on both sides of the pivot for the classic double-sided
  // firebar look. Used by update() (ember spawning), draw(), and the
  // player collision check, so none of them can ever disagree about
  // where a fireball actually is.
  getFireballPositions() {
    const positions = [];
    const dirX = Math.cos(this.angle), dirY = Math.sin(this.angle);
    for (let i = 1; i <= this.numFireballs; i++) {
      const dist = (i / this.numFireballs) * this.barLength;
      positions.push({ x: this.pos.x + dirX * dist, y: this.pos.y + dirY * dist, radius: this.fireballRadius });
      positions.push({ x: this.pos.x - dirX * dist, y: this.pos.y - dirY * dist, radius: this.fireballRadius });
    }
    return positions;
  }

  draw() {
    const ctx = state.ctx;
    ctx.save();

    // Fixed central block, drawn FIRST so the fireballs pass in front
    // of it as they rotate through, rather than being hidden behind it.
    const r = this.blockRadius;
    ctx.fillStyle = '#2b2b2b';
    ctx.fillRect(this.pos.x - r, this.pos.y - r, r * 2, r * 2);
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 3;
    ctx.strokeRect(this.pos.x - r, this.pos.y - r, r * 2, r * 2);

    // Fireballs — a real radial gradient (bright core -> orange ->
    // red -> transparent) instead of a flat fill, plus a per-fireball
    // flicker so they don't all pulse in lockstep. Index-based phase
    // rather than persistent per-fireball state, since these positions
    // are recomputed fresh from the current angle every call — the
    // INDEX still consistently identifies "the same" logical fireball
    // frame to frame even though the position object itself isn't
    // reused.
    const now = Date.now();
    const fireballs = this.getFireballPositions();
    fireballs.forEach((f, i) => {
      const flicker = 0.85 + Math.sin(now * 0.012 + i * 1.7) * 0.15;
      const radius = f.radius * flicker;

      // Soft outer glow, wider and fainter than the fireball itself.
      const glow = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, radius * 2.2);
      glow.addColorStop(0, 'rgba(255,140,40,0.35)');
      glow.addColorStop(1, 'rgba(255,80,20,0)');
      ctx.beginPath();
      ctx.fillStyle = glow;
      ctx.arc(f.x, f.y, radius * 2.2, 0, Math.PI * 2);
      ctx.fill();

      // Flame body itself.
      const grad = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, radius);
      grad.addColorStop(0, '#fff2c0');
      grad.addColorStop(0.4, '#ffb02e');
      grad.addColorStop(0.75, '#ff5522');
      grad.addColorStop(1, 'rgba(255,60,20,0)');
      ctx.beginPath();
      ctx.fillStyle = grad;
      ctx.arc(f.x, f.y, radius, 0, Math.PI * 2);
      ctx.fill();
    });

    // Drifting embers, on top of everything — small rising sparks that
    // fade out as they travel.
    for (const e of this.embers) {
      ctx.beginPath();
      ctx.fillStyle = `hsla(${e.hue}, 100%, 60%, ${Math.max(0, e.life)})`;
      ctx.arc(e.x, e.y, e.radius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }
}