// js/world/BeamPlanetoid.js
import { Planetoid } from './Planetoid.js';
import { state } from '../state.js';
import { Vector2 } from '../vector2.js';
import { Sprite, Texture } from 'pixi.js';

// Parses beamColor's own 'rgba(r,g,b,a)' string format into a Pixi
// tint value — Fireball.js has its own rgbToHex, but that one takes an
// [r,g,b] array (already-parsed color stops), not a raw CSS string, so
// it doesn't fit here without its own parsing step first anyway. Kept
// local rather than reaching across files for a two-line helper,
// matching how every other file in this migration keeps its own small
// utilities self-contained instead of building cross-file dependencies
// for something this small.
function parseRgbToTint(rgbaString) {
  const match = rgbaString.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return 0xffffff;
  const r = parseInt(match[1], 10);
  const g = parseInt(match[2], 10);
  const b = parseInt(match[3], 10);
  return (r << 16) | (g << 8) | b;
}

// Shared across EVERY beam/portal particle, on EVERY BeamPlanetoid — a
// plain white circle, radius 3 (matching BeamParticle's own fixed
// draw() size), tinted per-instance via sprite.tint rather than baking
// a separate colored texture per planet's own beamColor. Only ever a
// few dozen live particles at once given there are just 2
// BeamPlanetoid instances total, so this isn't the "hundreds of
// Graphics" scale Coin's own bug needed fixing at — but there's no
// reason to build live Graphics per particle when a shared texture is
// just as easy and is the established pattern everywhere else in this
// migration.
let particleTexture = null;
function getParticleTexture() {
  if (particleTexture) return particleTexture;
  const r = 3;
  const canvas = document.createElement('canvas');
  canvas.width = r * 2;
  canvas.height = r * 2;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  particleTexture = Texture.from(canvas);
  return particleTexture;
}

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

  // ----------------------------
  // PIXI RENDERING (BeamPlanetoid-specific — beam + particle systems
  // layered on top of everything base Planetoid already provides via
  // super.createPixiSprites/super.updatePixiSprites). Deliberately
  // scoped to NOT include drawInterior()/this.interior.draw() — that
  // depends on MazeInterior.js/PlatformInterior.js, which weren't
  // available to port against this session, so it stays unrendered
  // here, same as it already was before this port (draw() itself is
  // dead code in the actual game now, same as everywhere else in this
  // migration — a real, known, flagged gap, not an oversight).
  // ----------------------------

  // Bakes the beam ONCE — unlike the base planet body, which needed a
  // GPU-native bake specifically because it ran 50+ times per cell
  // activation, this only ever runs twice total (mazePlanet,
  // platformPlanet are the only BeamPlanetoid instances that exist),
  // so a plain Canvas2D bake — same gradient+shadowBlur technique
  // drawBeam() already used live — is genuinely fine here; the
  // performance problem was always about REPEATED cost at scale, not
  // this specific technique being inherently too slow to ever use.
  // Baked in LOCAL space (planet center at local origin) rather than
  // world space, so the resulting texture can be reused as-is even as
  // this.pos itself changes — same reasoning as every other baked
  // texture in this migration.
  createBeamTexture() {
    const a = this.beamAngle;
    const dirX = Math.cos(a), dirY = Math.sin(a);
    const localStart = { x: dirX * this.radius, y: dirY * this.radius };
    const localEnd = { x: localStart.x + dirX * this.beamLength, y: localStart.y + dirY * this.beamLength };

    // Same fixed HORIZONTAL ±8 offset drawBeam() itself uses for the
    // two side strokes — not a true perpendicular offset (see this
    // class's own top-of-file comment for why that's preserved
    // exactly as-is here, not "corrected" to true perpendicular).
    const points = [
      { x: localStart.x - 8, y: localStart.y },
      { x: localStart.x + 8, y: localStart.y },
      { x: localEnd.x - 8, y: localEnd.y },
      { x: localEnd.x + 8, y: localEnd.y },
    ];
    const minX = Math.min(...points.map(p => p.x));
    const maxX = Math.max(...points.map(p => p.x));
    const minY = Math.min(...points.map(p => p.y));
    const maxY = Math.max(...points.map(p => p.y));

    const padding = 80; // comfortably larger than the main stroke's own shadowBlur=60, same margin reasoning as Planetoid's own SHADOW_PADDING relative to its own shadowBlur=25
    const width = (maxX - minX) + padding * 2;
    const height = (maxY - minY) + padding * 2;
    const offsetX = -minX + padding;
    const offsetY = -minY + padding;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.translate(offsetX, offsetY);

    const start = localStart, end = localEnd;
    const gradient = ctx.createLinearGradient(start.x, start.y, end.x, end.y);
    gradient.addColorStop(0, this.beamColor);
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
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

    return {
      texture: Texture.from(canvas),
      // Fractions (0-1), not pixels — Pixi's own anchor convention —
      // so that positioning this sprite at this.pos correctly lands
      // the planet's own local origin (0,0) at the right spot on the
      // baked texture.
      anchorX: offsetX / width,
      anchorY: offsetY / height,
    };
  }

  createPixiSprites(planetoidLayer) {
    super.createPixiSprites(planetoidLayer);
    if (!this.pixiSprites) return; // base body/ring/etc not ready yet — try again next frame, same tolerance super's own guard already has
    if (this.pixiBeamSprite) return; // beam-specific parts already built

    // Interior created FIRST, before the beam sprite below — matching
    // draw()'s own order (super.draw(), THEN drawInterior(), THEN
    // drawBeam()) — planetoidLayer isn't sortableChildren, so
    // insertion order alone determines render order, and the interior
    // needs to land behind the beam, not on top of it.
    if (this.interior) this.interior.createPixiSprites(planetoidLayer);

    const baked = this.createBeamTexture();
    this.pixiBeamSprite = new Sprite(baked.texture);
    this.pixiBeamSprite.anchor.set(baked.anchorX, baked.anchorY);
    // Added AFTER super's own ring/body/sunOverlay/darkness AND the
    // interior's own sprites (both already in planetoidLayer by this
    // point) — renders on top of both, matching draw()'s own visual
    // order exactly.
    planetoidLayer.addChild(this.pixiBeamSprite);
  }

  // Called every frame in place of draw() once migrated. Reuses
  // spawnBeamParticles/spawnPortalParticles directly, unmodified —
  // those are pure physics/spawning methods with no Canvas2D work of
  // their own, so there's nothing to port about them specifically —
  // but replaces updateParticles()'s own p.draw() calls with Pixi
  // sprite sync instead (see updateParticlesPixi below). draw()/
  // updateParticles() themselves stay fully untouched elsewhere in
  // this file as the Canvas2D rollback path. Now also drives
  // this.interior's own updatePixiSprites (MazeInterior/
  // PlatformInterior each implement this themselves) — this WAS
  // scoped out of this class's own Pixi port (see this class's
  // earlier header comment, now stale on that specific point), but
  // both interior classes have since been ported too, so this closes
  // that gap rather than leaving it open. Its sprites were already
  // created (in createPixiSprites above, BEFORE the beam sprite, for
  // correct z-order) — this just keeps them updated every frame.
  updatePixiSprites(planetoidLayer) {
    super.updatePixiSprites(planetoidLayer);
    if (!this.pixiBeamSprite) this.createPixiSprites(planetoidLayer);
    if (!this.pixiBeamSprite) return;

    this.pixiBeamSprite.position.set(this.pos.x, this.pos.y);

    if (this.interior) this.interior.updatePixiSprites(planetoidLayer);

    const start = this.getBeamStart();
    const portal = this.getPortalPosition();
    this.spawnBeamParticles(start);
    this.spawnPortalParticles(portal);
    this.updateParticlesPixi(planetoidLayer);
  }

  // Same physics-update-then-splice-on-death shape as updateParticles()
  // above, but syncs each particle's own Pixi sprite instead of
  // calling its draw() — see BeamParticle/PortalParticle's own
  // createPixiSprite/updatePixiSprite/destroyPixiSprite methods below.
  // A freshly-spawned particle's sprite gets created on this SAME
  // call (createPixiSprite is lazy/idempotent, same pattern as
  // everywhere else in this migration), matching the original's own
  // spawn-then-immediately-update-and-draw-same-frame timing.
  updateParticlesPixi(planetoidLayer) {
    for (let i = this.beamParticles.length - 1; i >= 0; i--) {
      const p = this.beamParticles[i];
      p.update();
      if (p.life <= 0) {
        p.destroyPixiSprite();
        this.beamParticles.splice(i, 1);
      } else {
        p.createPixiSprite(planetoidLayer, parseRgbToTint(p.color));
        p.updatePixiSprite();
      }
    }
    for (let i = this.portalParticles.length - 1; i >= 0; i--) {
      const p = this.portalParticles[i];
      p.update();
      if (p.life <= 0) {
        p.destroyPixiSprite();
        this.portalParticles.splice(i, 1);
      } else {
        p.createPixiSprite(planetoidLayer, parseRgbToTint(p.color));
        p.updatePixiSprite();
      }
    }
  }

  // NOTE: not currently called from anywhere — mazePlanet/
  // platformPlanet are both isPermanent, and worldGen.js's own
  // cullDistantObjects skips isPermanent planetoids unconditionally,
  // so in the actual game this can never run. Implemented anyway for
  // correctness rather than leaving a silent gap: if that ever
  // changes, or a future BeamPlanetoid isn't permanent, this is ready
  // rather than something to rediscover was missing. PixiStage.js's
  // own cleanup for base Planetoid sprites (ring/body/sunOverlay/
  // darkness) is NOT wired to call this — it destroys those directly
  // inline rather than delegating to a per-entity method, so this
  // covers only the beam/particle sprites this subclass itself added.
  destroyPixiSprite() {
    this.pixiBeamSprite?.destroy();
    this.pixiBeamSprite = null;
    for (const p of this.beamParticles) p.destroyPixiSprite();
    for (const p of this.portalParticles) p.destroyPixiSprite();
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

  // Wraps the shared getParticleTexture() (already radius 3, matching
  // draw()'s own fixed size above) — tint is passed in rather than
  // parsed here, since parseRgbToTint lives at module scope in
  // BeamPlanetoid.js, not on this class.
  createPixiSprite(layer, tint) {
    if (this.pixiSprite) return;
    this.pixiSprite = new Sprite(getParticleTexture());
    this.pixiSprite.anchor.set(0.5, 0.5);
    this.pixiSprite.tint = tint;
    layer.addChild(this.pixiSprite);
  }

  // Only position/alpha change over this particle's life — size stays
  // fixed the whole time, matching draw()'s own arc(...,3,...) never
  // varying with alpha the way PortalParticle's own size = 3*alpha
  // does below.
  updatePixiSprite() {
    if (!this.pixiSprite) return;
    this.pixiSprite.position.set(this.pos.x, this.pos.y);
    this.pixiSprite.alpha = this.life / this.maxLife;
  }

  destroyPixiSprite() {
    this.pixiSprite?.destroy();
    this.pixiSprite = null;
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

  // Same shared-texture wrapping as BeamParticle's own createPixiSprite
  // above.
  createPixiSprite(layer, tint) {
    if (this.pixiSprite) return;
    this.pixiSprite = new Sprite(getParticleTexture());
    this.pixiSprite.anchor.set(0.5, 0.5);
    this.pixiSprite.tint = tint;
    layer.addChild(this.pixiSprite);
  }

  // Unlike BeamParticle, this one's own draw() shrinks over its life
  // (size = 3 * alpha, not a fixed 3) — reproduced here via
  // sprite.scale rather than a different texture: the shared texture
  // is already radius 3, so scale.set(alpha) alone gives exactly
  // 3 * alpha at every point in its life, matching draw() exactly.
  updatePixiSprite() {
    if (!this.pixiSprite) return;
    const alpha = this.life / this.maxLife;
    this.pixiSprite.position.set(this.pos.x, this.pos.y);
    this.pixiSprite.alpha = alpha;
    this.pixiSprite.scale.set(alpha);
  }

  destroyPixiSprite() {
    this.pixiSprite?.destroy();
    this.pixiSprite = null;
  }
}