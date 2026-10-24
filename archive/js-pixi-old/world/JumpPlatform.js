// js/world/JumpPlatform.js
import { state } from '../state.js';
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
    const color = options.color ?? '#8a8a8a'; // fallback fill if platform.png isn't loaded yet — see drawBodyTexture

    super(x, y, halfWidth, halfHeight, cornerRadius, color);

    this.vel = new Vector2(0, 0);
    this.rotationAngle = 0;
    this.rotationSpeed = 0;

    this.isImmovable = true;
    this.isSkyDome = true;    // reuses SkyDomePlanetoid's top-only gravity/landing/jump-carry gating
    this.isPullExempt = true; // excluded from the pull-beam's target selection
    // Exempts this from RoundedRectPlanetoid's live directional
    // sun-shading pass — see SkyDomePlanetoid's identical comment for
    // why: this reads as flat, evenly-lit ground/platform texture, not
    // a rocky, directionally-lit planet surface.
    this.noSunShading = true;

    this.gravityWindowHeight = options.gravityWindowHeight ?? 150;

    // Very subtle top-to-bottom darkening over the platform's own body
    // — bottom slightly darker, fading up to no darkening at the top.
    // Applied as a plain black overlay at this alpha at the very
    // bottom, faded to fully transparent at the top (see
    // drawBodyTexture) — deliberately kept low since this is meant to
    // read as a subtle depth cue, not a visible band.
    this.bottomDarkenAlpha = options.bottomDarkenAlpha ?? 0.50;
    // How far up from the bottom the darkening reaches, as a fraction
    // of the platform's own height — 0.25 means only the bottom
    // quarter fades, with the top 75% left completely untouched,
    // rather than fading gradually across the whole body.
    this.bottomDarkenReach = options.bottomDarkenReach ?? 0.4;
  }

  // Same shape as SkyDomePlanetoid's — a rectangular capture zone
  // directly above the platform's own surface, nothing outside it.
  isWithinGravityWindow(worldX, worldY) {
    const withinX = worldX >= this.pos.x - this.halfWidth && worldX <= this.pos.x + this.halfWidth;
    const topY = this.pos.y - this.halfHeight;
    const withinY = worldY <= topY && worldY >= topY - this.gravityWindowHeight;
    return withinX && withinY;
  }

  // Renders the platform's ENTIRE body using platform.png's 6-tile,
  // 96x64 tileset (three 32x32 tiles per row: left edge / center /
  // right edge, one row for the grass top, one row reused for every
  // row below it), scaled 2x (64 world units per tile) — a standard
  // "9-slice"-style tileset, so this platform's width/height should
  // both be multiples of 64 for clean, whole tiles with no cropping.
  // Replaces both the old single-tile grass top AND the separate
  // ground.png dirt "pillar" that used to extend down to the ground
  // separately — this tileset's own bottom-row tiles cover that same
  // role now, just by making the platform as many rows tall as needed
  // (a taller height, not a separate mechanism).
  drawBodyTexture(bodyCtx, w, h) {
    const platformImg = state.platformTexture;
    if (!platformImg || !platformImg.complete) {
      bodyCtx.beginPath();
      bodyCtx.roundRect(0, 0, w, h, this.cornerRadius);
      bodyCtx.fillStyle = this.color;
      bodyCtx.fill();
      return;
    }

    const scale = 2;
    const tile = 32 * scale; // 64 world units per tile
    const cols = Math.max(1, Math.round(w / tile));
    const rows = Math.max(1, Math.round(h / tile));

    bodyCtx.imageSmoothingEnabled = false;
    bodyCtx.save();
    bodyCtx.beginPath();
    bodyCtx.roundRect(0, 0, w, h, this.cornerRadius);
    bodyCtx.clip();

    for (let r = 0; r < rows; r++) {
      // Row 0 = top tiles (grass), source y=0. Every row below reuses
      // the SAME bottom-row tiles (source y=32), per the brief — the
      // "center" tile there is explicitly meant to repeat for however
      // many rows the platform's body needs.
      const srcY = r === 0 ? 0 : 32;
      for (let c = 0; c < cols; c++) {
        let srcX;
        if (cols === 1) {
          // No single tile is both edges at once in this tileset —
          // the center tile is the least-wrong fallback for a
          // one-column-wide platform. Widths of 128+ (2+ columns) get
          // proper left/right edges instead.
          srcX = 32;
        } else if (c === 0) {
          srcX = 0; // left edge
        } else if (c === cols - 1) {
          srcX = 64; // right edge
        } else {
          srcX = 32; // center
        }
        bodyCtx.drawImage(platformImg, srcX, srcY, 32, 32, c * tile, r * tile, tile, tile);
      }
    }

    // Subtle bottom-up darkening — plain black overlay, only reaching
    // up bottomDarkenReach of the platform's height (the region above
    // that stays fully transparent, since a linear gradient extends
    // its first stop's color beyond its own defined range by default).
    // source-atop is what keeps this correct against the tileset's own
    // transparency (e.g. grass spilling over an edge tile) — it only
    // draws the new fill where the EXISTING canvas content (the tiles
    // just drawn above) is already opaque, so transparent regions of
    // the tiles stay transparent instead of picking up a visible dark
    // patch. The outer restore() a couple lines down resets this back
    // to the default afterward.
    const fadeStart = h * (1 - this.bottomDarkenReach);
    const gradient = bodyCtx.createLinearGradient(0, fadeStart, 0, h);
    gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
    gradient.addColorStop(1, `rgba(0, 0, 0, ${this.bottomDarkenAlpha})`);
    bodyCtx.fillStyle = gradient;
    bodyCtx.globalCompositeOperation = 'source-atop';
    bodyCtx.fillRect(0, 0, w, h);

    bodyCtx.restore();
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