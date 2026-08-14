// js/entities/world/Fireball.js
import { Entity } from '../Entity.js';
import { state } from '../../state.js';
import { Vector2 } from '../../vector2.js';
import { Sprite, Texture } from 'pixi.js';

const FIREBALL_SPEED = 14;
const FIREBALL_LIFE = 70; // frames
const TRAIL_SPAWN_CHANCE = 0.9;
const TRAIL_PARTICLE_LIFE_MIN = 14;
const TRAIL_PARTICLE_LIFE_RANGE = 12;
const SPARK_SPAWN_CHANCE = 0.35; // separate, sparser than the trail — these are occasional accents, not a constant stream
const SPARK_LIFE_MIN = 8;
const SPARK_LIFE_RANGE = 8;
const OFFSCREEN_MARGIN = 400; // world-space margin before a stray shot is culled

// Linearly interpolates between two [r,g,b] arrays, t in 0..1.
function lerpColor(from, to, t) {
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t)
  ];
}

// ----------------------------
// SHARED GLOW SPRITE (perf)
// ----------------------------
// The glowing core is identical for every fireball — only position
// changes — so it's baked ONCE into a shared offscreen canvas (same
// trick used for planets and the astronaut's body parts) instead of
// paying for a live shadowBlur on every fireball, every frame. Built
// lazily on first use. The live flicker in draw() below (a scale/alpha
// pulse applied when drawing this sprite, not baked into it) is what
// keeps this from reading as a static, unchanging image despite being
// baked — cheap, since it's just a transform and alpha tweak per
// fireball per frame, not a re-bake.
let fireballSprite = null;
function getFireballSprite() {
  if (fireballSprite) return fireballSprite;

  const size = 14;    // outer glow radius
  const core = 8;      // bright inner radius
  const padding = 24;  // room for the baked blur to fall off into

  const canvas = document.createElement('canvas');
  canvas.width = (size + padding) * 2;
  canvas.height = (size + padding) * 2;
  const ctx = canvas.getContext('2d');
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;

  ctx.shadowBlur = 20;
  ctx.shadowColor = '#ff4400';
  ctx.fillStyle = '#ffaa00';
  ctx.beginPath();
  ctx.arc(cx, cy, size, 0, Math.PI * 2);
  ctx.fill();

  ctx.shadowBlur = 12;
  ctx.shadowColor = '#ffee00';
  ctx.fillStyle = '#ffff88';
  ctx.beginPath();
  ctx.arc(cx, cy, core, 0, Math.PI * 2);
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fill();

  fireballSprite = canvas;
  return canvas;
}

// ----------------------------
// PIXI RENDERING (fireballs — see js/render/PixiStage.js for the full
// migration context, and Planetoid.js/Asteroid.js's own createPixi*
// methods for the same overall pattern applied there first). draw()
// above is completely untouched.
// ----------------------------
// Unlike a planetoid or asteroid, a fireball's trail/sparks are
// genuinely dynamic every frame — particles spawn, age, and die
// continuously (see update() above) — so there's no static shape to
// bake once the way those two could. Each trail/spark particle gets
// its own small pool of reusable Pixi sprites instead (grown/shrunk
// each frame to match this.trail.length/this.sparks.length — see
// Fireball's own syncTrailSprites/syncSparkSprites below), all sharing
// ONE plain white circle texture (getCircleTexture, right below) tinted
// per-particle via the cheap GPU tint property — baking a separate
// texture per color would be wasteful given colors here change
// continuously, every particle, every frame.
let fireballTexture = null; // shared, wraps the existing baked glow canvas above
function getFireballTexture() {
  if (fireballTexture) return fireballTexture;
  fireballTexture = Texture.from(getFireballSprite());
  return fireballTexture;
}

let circleTexture = null; // shared plain white circle, tinted per-instance for trail/spark particles
function getCircleTexture() {
  if (circleTexture) return circleTexture;
  const size = 64; // arbitrary reference resolution — trail/spark particles are small and short-lived, fine detail from upscaling isn't a concern the way it is for the player rig or planet glow
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  circleTexture = Texture.from(canvas);
  return circleTexture;
}

// Converts lerpColor's own [r,g,b] (0-255 each) output into the hex
// number Pixi's own sprite.tint expects.
function rgbToHex([r, g, b]) {
  return (r << 16) | (g << 8) | b;
}

export class Fireball extends Entity {
  constructor(x, y, angle) {
    super();
    this.pos = new Vector2(x, y);
    this.vel = new Vector2(Math.cos(angle), Math.sin(angle)).multiply(FIREBALL_SPEED);
    this.life = FIREBALL_LIFE;
    this.trail = [];
    this.sparks = [];
    // Collision radius, used by CollisionSystem.handleFireballCollisions.
    // Roughly matches the bright core of the sprite rather than the
    // full outer glow, so hits feel fair rather than overly generous.
    this.radius = 8;
    // Random phase so multiple fireballs on screen at once don't all
    // flicker in perfect unison — same staggering idea used for the
    // dome base's status lights.
    this.flickerPhase = Math.random() * Math.PI * 2;
  }

  get isDead() {
    return this.life <= 0;
  }

  update() {
    const timeScale = state.timeScale;
    this.pos.add(this.vel.clone().multiply(timeScale));
    this.life -= timeScale;

    // Spawn chances scaled so fewer trail/spark particles spawn per
    // REAL second while slowed — this update() still runs once per
    // real frame regardless of timeScale, so without scaling these
    // the spawn rate per real-second would stay exactly the same even
    // while everything else visibly slows down.
    if (Math.random() < TRAIL_SPAWN_CHANCE * timeScale) {
      const spread = 10;
      const maxLife = TRAIL_PARTICLE_LIFE_MIN + Math.random() * TRAIL_PARTICLE_LIFE_RANGE;
      this.trail.push({
        x: this.pos.x + (Math.random() - 0.5) * spread,
        y: this.pos.y + (Math.random() - 0.5) * spread * 0.8,
        life: maxLife,
        maxLife,
        size: 3 + Math.random() * 6
      });
    }
    for (let i = this.trail.length - 1; i >= 0; i--) {
      this.trail[i].life -= timeScale;
      if (this.trail[i].life <= 0) this.trail.splice(i, 1);
    }

    // Sparks: sharp, fast, short-lived — distinct from the softer
    // trail blobs above. Each gets its own small random velocity (on
    // top of drifting along with the fireball's own motion isn't
    // needed here since these are so short-lived it wouldn't read
    // anyway), so they scatter outward at odd angles rather than
    // simply trailing straight behind like the main trail does.
    if (Math.random() < SPARK_SPAWN_CHANCE * timeScale) {
      const sparkAngle = Math.random() * Math.PI * 2;
      const sparkSpeed = 1 + Math.random() * 2.5;
      const maxLife = SPARK_LIFE_MIN + Math.random() * SPARK_LIFE_RANGE;
      this.sparks.push({
        x: this.pos.x,
        y: this.pos.y,
        vx: Math.cos(sparkAngle) * sparkSpeed,
        vy: Math.sin(sparkAngle) * sparkSpeed,
        life: maxLife,
        maxLife
      });
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.x += s.vx * timeScale;
      s.y += s.vy * timeScale;
      s.life -= timeScale;
      if (s.life <= 0) this.sparks.splice(i, 1);
    }

    if (
      this.pos.x < -OFFSCREEN_MARGIN || this.pos.x > state.sceneWidth + OFFSCREEN_MARGIN ||
      this.pos.y < -OFFSCREEN_MARGIN || this.pos.y > state.sceneHeight + OFFSCREEN_MARGIN
    ) {
      this.life = 0;
    }
  }

  draw() {
    const ctx = state.ctx;

    // Trail: cheap live-drawn circles, no shadow — only the shared
    // core sprite below uses a (pre-baked) glow. Color shifts from
    // bright fire (a=1, just spawned) toward dark smoke (a=0, about to
    // vanish) over each particle's own lifetime, rather than staying a
    // fixed fire color throughout — reads as embers cooling and
    // smoke drifting, not just uniformly-colored dots fading out.
    for (const t of this.trail) {
      const a = t.life / t.maxLife;
      const ts = t.size * a;
      const outer = lerpColor([255, 85, 0], [70, 68, 72], 1 - a);
      const inner = lerpColor([255, 204, 68], [110, 108, 112], 1 - a);
      ctx.globalAlpha = a * 0.85;
      ctx.fillStyle = `rgb(${outer[0]}, ${outer[1]}, ${outer[2]})`;
      ctx.beginPath();
      ctx.arc(t.x, t.y, ts * 1.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgb(${inner[0]}, ${inner[1]}, ${inner[2]})`;
      ctx.beginPath();
      ctx.arc(t.x, t.y, ts * 0.75, 0, Math.PI * 2);
      ctx.fill();
    }

    // Sparks: small, sharp, bright white-yellow dots — no color
    // transition (they're too short-lived for cooling to read), just
    // a fade to nothing.
    for (const s of this.sparks) {
      const a = s.life / s.maxLife;
      ctx.globalAlpha = a;
      ctx.fillStyle = '#ffe066';
      ctx.beginPath();
      ctx.arc(s.x, s.y, 1.5 * a + 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Live flicker — a subtle scale + alpha pulse applied when drawing
    // the (static, pre-baked) sprite, computed from elapsed real time
    // plus this fireball's own random phase offset. Keeps a baked
    // sprite from reading as a flat, unchanging image despite never
    // being re-rendered.
    const flicker = Math.sin(Date.now() * 0.02 + this.flickerPhase);
    const scale = 1 + flicker * 0.08;
    const alpha = 1 - Math.abs(flicker) * 0.1;

    const sprite = getFireballSprite();
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(this.pos.x, this.pos.y);
    ctx.scale(scale, scale);
    ctx.drawImage(sprite, -sprite.width / 2, -sprite.height / 2);
    ctx.restore();
  }

  // Lazily builds the main glow sprite. Trail/spark sprite pools start
  // empty — syncTrailSprites/syncSparkSprites (called every frame from
  // updatePixiSprite below) grow and shrink them to match
  // this.trail/this.sparks as those arrays themselves change, rather
  // than needing anything built upfront here.
  createPixiSprite(fireballLayer) {
    if (this.pixiGlow) return;
    this.pixiGlow = new Sprite(getFireballTexture());
    this.pixiGlow.anchor.set(0.5, 0.5);
    fireballLayer.addChild(this.pixiGlow);
    this.trailSprites = []; // array of { outer, inner } pairs, one per this.trail[] entry
    this.sparkSprites = []; // one sprite per this.sparks[] entry
    this.fireballLayer = fireballLayer; // needed by the pool-growing helpers below, called every frame
  }

  // Grows/shrinks this.trailSprites to match this.trail.length exactly,
  // reusing existing pooled sprites where possible rather than
  // destroying and recreating every frame — same reasoning as any
  // object pool: creating/destroying GPU-backed sprites every single
  // frame for particles that already churn this fast would be wasteful
  // in a way simply repositioning/re-tinting existing ones isn't.
  syncTrailSprites() {
    while (this.trailSprites.length < this.trail.length) {
      const outer = new Sprite(getCircleTexture());
      const inner = new Sprite(getCircleTexture());
      outer.anchor.set(0.5, 0.5);
      inner.anchor.set(0.5, 0.5);
      this.fireballLayer.addChild(outer, inner);
      this.trailSprites.push({ outer, inner });
    }
    while (this.trailSprites.length > this.trail.length) {
      const { outer, inner } = this.trailSprites.pop();
      outer.destroy();
      inner.destroy();
    }
    for (let i = 0; i < this.trail.length; i++) {
      const t = this.trail[i];
      const { outer, inner } = this.trailSprites[i];
      const a = t.life / t.maxLife;
      const ts = t.size * a;
      const outerColor = lerpColor([255, 85, 0], [70, 68, 72], 1 - a);
      const innerColor = lerpColor([255, 204, 68], [110, 108, 112], 1 - a);
      outer.position.set(t.x, t.y);
      outer.width = outer.height = ts * 1.4 * 2; // *2: width/height are diameters, ts*1.4 in draw()'s own arc() call is a radius
      outer.tint = rgbToHex(outerColor);
      outer.alpha = a * 0.85;
      inner.position.set(t.x, t.y);
      inner.width = inner.height = ts * 0.75 * 2;
      inner.tint = rgbToHex(innerColor);
      inner.alpha = a * 0.85;
    }
  }

  // Same pooling approach as syncTrailSprites, one sprite per spark
  // rather than two — sparks are a single flat color (#ffe066, no
  // cooling-color transition), only size/alpha vary.
  syncSparkSprites() {
    while (this.sparkSprites.length < this.sparks.length) {
      const sprite = new Sprite(getCircleTexture());
      sprite.anchor.set(0.5, 0.5);
      sprite.tint = 0xffe066;
      this.fireballLayer.addChild(sprite);
      this.sparkSprites.push(sprite);
    }
    while (this.sparkSprites.length > this.sparks.length) {
      this.sparkSprites.pop().destroy();
    }
    for (let i = 0; i < this.sparks.length; i++) {
      const s = this.sparks[i];
      const sprite = this.sparkSprites[i];
      const a = s.life / s.maxLife;
      sprite.position.set(s.x, s.y);
      sprite.width = sprite.height = (1.5 * a + 0.5) * 2;
      sprite.alpha = a;
    }
  }

  // Called every frame in place of draw() once migrated.
  updatePixiSprite(fireballLayer) {
    if (!this.pixiGlow) this.createPixiSprite(fireballLayer);

    this.syncTrailSprites();
    this.syncSparkSprites();

    // Same live flicker as draw() above, applied to the Pixi sprite's
    // own scale/alpha instead of a ctx transform.
    const flicker = Math.sin(Date.now() * 0.02 + this.flickerPhase);
    const scale = 1 + flicker * 0.08;
    const alpha = 1 - Math.abs(flicker) * 0.1;
    this.pixiGlow.position.set(this.pos.x, this.pos.y);
    this.pixiGlow.scale.set(scale, scale);
    this.pixiGlow.alpha = alpha;
  }

  // Called from PixiStage.js's own sync function when this fireball is
  // removed (hit something, or its own life ran out) — tears down the
  // main glow sprite plus every currently-pooled trail/spark sprite.
  // None of these wrap a texture unique to this fireball (the glow and
  // circle textures are both shared across every fireball, tinted per-
  // instance rather than baked per-instance), so a plain destroy() with
  // no options — leaving texture/textureSource at their default false —
  // is correct here: destroying the shared texture itself would break
  // every OTHER still-alive fireball's own sprites.
  destroyPixiSprite() {
    if (this.pixiGlow) {
      this.pixiGlow.destroy();
      this.pixiGlow = null;
    }
    for (const { outer, inner } of this.trailSprites || []) {
      outer.destroy();
      inner.destroy();
    }
    this.trailSprites = [];
    for (const sprite of this.sparkSprites || []) {
      sprite.destroy();
    }
    this.sparkSprites = [];
  }
}