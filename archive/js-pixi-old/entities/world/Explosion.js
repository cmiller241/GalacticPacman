// js/entities/world/Explosion.js
import { Entity } from '../Entity.js';
import { state } from '../../state.js';
import { Vector2 } from '../../vector2.js';
import { createDeathParticles } from '../../utils.js';
import { Graphics, Sprite, Texture } from 'pixi.js';

const EXPLOSION_DURATION = 400; // ms
const RING_MAX_RADIUS = 70;
const FLASH_RADIUS = 30;
const FLASH_FRACTION = 0.3; // flash burns out over the first 30% of the duration
const PARTICLE_COUNT = 40;

// ----------------------------
// PIXI RENDERING (explosions — see js/render/PixiStage.js for the full
// migration context, and Planetoid.js/Asteroid.js/Fireball.js's own
// createPixi* methods for the same overall pattern applied there
// first). draw()/update()/isDead below are completely untouched.
// ----------------------------
// Unlike everything ported before it, this class is purely time-driven
// — update() above does nothing at all, and even isDead reads straight
// off Date.now(), not any per-frame-accumulated state. That's actually
// the SIMPLEST case for a live (not baked) Pixi representation: no
// object pooling needed (no variable-count particle array the way
// Fireball's trail/sparks are — the actual particle burst here is a
// SEPARATE system, createDeathParticles/state.particles, not part of
// this class's own visuals and not touched by this port at all), and
// nothing to bake once, since the ring's radius/alpha/lineWidth all
// change continuously for this object's entire ~400ms lifetime — there
// would be nothing left to reuse a bake for. updatePixiSprite below
// just reads the same wall-clock progress draw() already does, applied
// to Pixi sprite/graphics properties instead of ctx calls, every
// frame, for consistency with the original's own "purely time-driven"
// design rather than introducing per-frame state tracking that wasn't
// there before.
let flashTexture = null; // shared — the flash's own radial gradient (white-yellow center to transparent orange edge) never changes between explosions, only its alpha/scale over time do, so this bakes once and gets reused via a plain Sprite rather than needing Pixi's own gradient-fill API
function getFlashTexture() {
  if (flashTexture) return flashTexture;
  const size = FLASH_RADIUS * 2;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(FLASH_RADIUS, FLASH_RADIUS, 0, FLASH_RADIUS, FLASH_RADIUS, FLASH_RADIUS);
  grad.addColorStop(0, 'rgba(255,255,220,1)');
  grad.addColorStop(0.4, 'rgba(255,180,60,0.8)');
  grad.addColorStop(1, 'rgba(255,100,20,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(FLASH_RADIUS, FLASH_RADIUS, FLASH_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  flashTexture = Texture.from(canvas);
  return flashTexture;
}

export class Explosion extends Entity {
  constructor(x, y) {
    super();
    this.pos = new Vector2(x, y);
    this.startTime = Date.now();
    this.duration = EXPLOSION_DURATION;

    // Fiery particle burst — reuses the existing fire-colored death
    // particles rather than inventing a new particle style.
    createDeathParticles(this.pos.clone(), PARTICLE_COUNT);
  }

  get isDead() {
    return Date.now() - this.startTime >= this.duration;
  }

  update() {
    // Purely time-driven; nothing to simulate beyond the elapsed clock
    // read in draw().
  }

  draw() {
    const ctx = state.ctx;
    const t = Math.min((Date.now() - this.startTime) / this.duration, 1);
    const eased = 1 - Math.pow(1 - t, 3); // fast expand, settles near the end

    // Expanding, fading shockwave ring
    ctx.save();
    ctx.globalAlpha = 1 - t;
    ctx.strokeStyle = '#ffcc66';
    ctx.lineWidth = 4 * (1 - t) + 1;
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, eased * RING_MAX_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Bright core flash, burns out quickly. Explosions are short-lived
    // and infrequent, so a live radial gradient here is cheap enough —
    // unlike the planets, this isn't paid every frame for 60+ objects.
    const flashT = Math.min(t / FLASH_FRACTION, 1);
    if (flashT < 1) {
      ctx.save();
      ctx.globalAlpha = 1 - flashT;
      const grad = ctx.createRadialGradient(this.pos.x, this.pos.y, 0, this.pos.x, this.pos.y, FLASH_RADIUS);
      grad.addColorStop(0, 'rgba(255,255,220,1)');
      grad.addColorStop(0.4, 'rgba(255,180,60,0.8)');
      grad.addColorStop(1, 'rgba(255,100,20,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(this.pos.x, this.pos.y, FLASH_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // Lazily builds the ring Graphics and flash Sprite. Both stay
  // extremely cheap to build — no gradient computation happens here at
  // all for the ring (a plain stroke), and the flash reuses the one
  // shared, already-baked texture above rather than creating its own.
  createPixiSprite(explosionLayer) {
    if (this.pixiRing) return;

    this.pixiRing = new Graphics();
    explosionLayer.addChild(this.pixiRing);

    this.pixiFlash = new Sprite(getFlashTexture());
    this.pixiFlash.anchor.set(0.5, 0.5);
    this.pixiFlash.position.set(this.pos.x, this.pos.y);
    explosionLayer.addChild(this.pixiFlash);
  }

  // Called every frame in place of draw() once migrated. Reads the
  // same Date.now()-based t/eased/flashT draw() itself computes — no
  // per-frame state accumulates anywhere in this class, so there's
  // nothing to advance here beyond re-reading the clock, matching the
  // original's own "purely time-driven" design exactly.
  updatePixiSprite(explosionLayer) {
    if (!this.pixiRing) this.createPixiSprite(explosionLayer);

    const t = Math.min((Date.now() - this.startTime) / this.duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);

    // Ring: cleared and redrawn every frame, not built once — radius,
    // alpha, AND lineWidth all change continuously for this object's
    // entire short lifetime, so unlike a planetoid or asteroid's own
    // static shape, there's no single baked state that would still be
    // correct on a later frame.
    this.pixiRing.clear();
    this.pixiRing
      .circle(this.pos.x, this.pos.y, eased * RING_MAX_RADIUS)
      .stroke({ width: 4 * (1 - t) + 1, color: 0xffcc66, alpha: 1 - t });

    const flashT = Math.min(t / FLASH_FRACTION, 1);
    this.pixiFlash.visible = flashT < 1; // draw() skips this layer entirely once flashT reaches 1; matched here rather than just alpha=0, which would still cost a (cheap, but nonzero) draw call
    if (flashT < 1) {
      this.pixiFlash.position.set(this.pos.x, this.pos.y);
      this.pixiFlash.alpha = 1 - flashT;
    }
  }

  // Called from PixiStage.js's own sync function when this explosion's
  // isDead flips true and it's removed from state.explosions. The
  // flash's own texture is SHARED across every explosion (see
  // getFlashTexture above), so no texture:true here — that would break
  // every other still-alive explosion's own flash. The ring is a
  // Graphics object with no texture at all to worry about either way.
  destroyPixiSprite() {
    if (this.pixiRing) {
      this.pixiRing.destroy();
      this.pixiRing = null;
    }
    if (this.pixiFlash) {
      this.pixiFlash.destroy();
      this.pixiFlash = null;
    }
  }
}