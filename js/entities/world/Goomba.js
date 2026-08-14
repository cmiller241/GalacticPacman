// js/entities/world/Goomba.js
import { state } from '../../state.js';
import { Vector2 } from '../../vector2.js';

// A simple ground-patrol enemy: walks back and forth along the flat
// top of a single isSkyDome-type surface (a JumpPlatform, or
// SkyDomePlanetoid's own ground), reversing direction at the edges
// rather than falling off. Never jumps and never leaves its home
// surface voluntarily, per the brief.
//
// Deliberately its own class rather than a variant of SpaceGhost —
// SpaceGhost orbits circular/rect planets in open space and jumps
// planet to planet; this is a different kind of enemy for a
// different kind of surface, with much simpler "walk to the edge,
// turn around" logic instead of orbit/jump AI. Reuses the same plain
// world-X-clamped approach Player.js's own isSkyDome walking already
// uses, rather than the general arc-length/segment system every other
// rect-type planet's walking goes through.
export class Goomba {
  constructor(homePlanet, startX, options = {}) {
    this.homePlanet = homePlanet;
    this.radius = options.radius ?? 32; // matches the platform tileset's own 2x scale (32px source * 2 = 64 world units drawn size)
    this.speed = options.speed ?? 1.4; // world units per frame — deliberately a bit slower than the player's own walk speed, for a "shuffling" goomba feel
    this.direction = options.direction ?? -1; // -1 = moving left, 1 = moving right; the sprite art faces left by default, so -1 needs no flip

    const topY = homePlanet.pos.y - homePlanet.halfHeight;
    this.pos = new Vector2(startX, topY - this.radius);

    this.walkCyclePhase = 0;
    this.walkCycleSpeed = 0.12; // how fast the 2-frame stand/walk animation alternates
  }

  update() {
    const planet = this.homePlanet;
    const coreHalfWidth = planet.halfWidth - planet.cornerRadius;
    // Turn-around bounds are inset by this.radius so the goomba's own
    // body stays fully on the platform when it turns, rather than
    // visually overhanging the edge before reversing.
    const minX = planet.pos.x - coreHalfWidth + this.radius;
    const maxX = planet.pos.x + coreHalfWidth - this.radius;

    const desiredX = this.pos.x + this.direction * this.speed * state.timeScale;
    if (desiredX < minX || desiredX > maxX) {
      this.direction *= -1; // reached the edge — turn around instead of falling off
    } else {
      this.pos.x = desiredX;
    }

    // Stay glued to the platform's own top surface — matters if the
    // platform ever moved, though none currently do; cheap to keep
    // correct regardless.
    const topY = planet.pos.y - planet.halfHeight;
    this.pos.y = topY - this.radius;

    this.walkCyclePhase += this.walkCycleSpeed * state.timeScale;
  }

  draw() {
    const img = state.goombaTexture;
    if (!img || !img.complete) return;

    const ctx = state.ctx;
    const frame = Math.floor(this.walkCyclePhase) % 2; // 0 = standing tile, 1 = walking tile
    const srcX = frame * 32;
    const drawSize = this.radius * 2;

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    // Sprite faces LEFT by default — moving right needs a horizontal
    // flip. Same ctx.scale(-1,1)-before-drawImage technique used for
    // the player's own arm flip: applying the flip before drawImage,
    // with the draw offset centered on the transform origin, keeps the
    // sprite correctly centered with no separate offset adjustment
    // needed for the mirrored case.
    if (this.direction > 0) ctx.scale(-1, 1);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, srcX, 0, 32, 32, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
    ctx.restore();
  }
}