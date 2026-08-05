// js/world/JumpPlatform.js
import { Vector2 } from '../vector2.js';
import { RoundedRectPlanetoid } from './RoundedRectPlanetoid.js';

// A small, fixed, non-rotating platform the player can jump onto and
// stand on. Reuses the SAME top-only gravity/landing window concept
// SkyDomePlanetoid introduced — gated by the shared isSkyDome flag,
// which GravitySystem.findDominantPlanet, CollisionSystem.
// tryLandOnPlanet, and Player.getOutwardLaunchDirection all already
// check generically (not tied to any specific class) — but deliberately
// does NOT extend SkyDomePlanetoid itself. That class carries real
// dome-specific baggage (drawing, dome collision, dome-tuned defaults)
// that doesn't apply to a bare platform, and duplicating the one small
// method this actually needs (isWithinGravityWindow) felt safer than
// risking a regression in the already-tuned ground+dome planet.
//
// Deliberately excluded from the pull-beam's target selection (see the
// isPullExempt check in Player.trySelectPullTarget) — jump-only, never
// a valid pull target.
export class JumpPlatform extends RoundedRectPlanetoid {
  constructor(x, y, width, height, options = {}) {
    const halfWidth = width / 2;
    const halfHeight = height / 2;
    const cornerRadius = options.cornerRadius ?? 0;
    const color = options.color ?? '#8a8a8a'; // plain stone-gray, visually distinct from the ground

    super(x, y, halfWidth, halfHeight, cornerRadius, color);

    this.vel = new Vector2(0, 0);
    this.rotationAngle = 0;
    this.rotationSpeed = 0;

    this.isImmovable = true;
    this.isSkyDome = true;    // reuses SkyDomePlanetoid's top-only gravity/landing/jump-carry gating
    this.isPullExempt = true; // excluded from the pull-beam's target selection

    this.gravityWindowHeight = options.gravityWindowHeight ?? 150;
  }

  // Same shape as SkyDomePlanetoid's — a rectangular capture zone
  // directly above the platform's own surface, nothing outside it.
  isWithinGravityWindow(worldX, worldY) {
    const withinX = worldX >= this.pos.x - this.halfWidth && worldX <= this.pos.x + this.halfWidth;
    const topY = this.pos.y - this.halfHeight;
    const withinY = worldY <= topY && worldY >= topY - this.gravityWindowHeight;
    return withinX && withinY;
  }

  // Suppresses the inherited dashed "gravity influence" ring — same
  // reasoning as SkyDomePlanetoid: misleading for anything whose
  // gravity only works in a small window above it, not a ring all
  // around it.
  createOffscreen() {
    super.createOffscreen();
    this.ringCanvas = null;
  }
}