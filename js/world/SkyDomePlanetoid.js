// js/world/SkyDomePlanetoid.js
import { state } from '../state.js';
import { Vector2 } from '../vector2.js';
import { RoundedRectPlanetoid } from './RoundedRectPlanetoid.js';

// A fixed, non-rotating flat platform strip whose gravity only works
// from directly above it — approach from the side or below and this
// planet simply isn't a candidate for gravity or landing at all, same
// as if it weren't there. Extends RoundedRectPlanetoid to reuse its
// perimeter-walking, surface, and rendering machinery wholesale (once
// landed, walking along the flat top edge is just one segment of that
// already-working system, so no Player.js changes were needed for
// this at all) — the only genuinely new behavior is the top-only
// gravity/landing window (isWithinGravityWindow, checked by both
// GravitySystem.findDominantPlanet and CollisionSystem.tryLandOnPlanet
// via the isSkyDome flag) and the glass dome drawn above it.
//
// Deliberately fixed and non-rotating: vel/rotationSpeed are forced to
// zero regardless of what the parent constructor set them to, since
// the gravity window is computed directly in WORLD space with no
// rotation transform — it would silently give wrong answers if this
// were ever actually spinning.
export class SkyDomePlanetoid extends RoundedRectPlanetoid {
  constructor(x, y, options = {}) {
    const halfWidth = options.halfWidth ?? 2000;    // per the user's tuned defaults
    const halfHeight = options.halfHeight ?? 30;    // thin — reads as a ground strip, not a block
    const cornerRadius = options.cornerRadius ?? 0;
    const color = options.color ?? '#5c8a4a'; // grassy green ground, distinct from the original rect planet's tan

    super(x, y, halfWidth, halfHeight, cornerRadius, color);

    this.vel = new Vector2(0, 0);
    this.rotationAngle = 0;
    this.rotationSpeed = 0;

    // Same reasoning as FireBar: at this strip's modest size the
    // bounding-circle collision approximation isn't badly distorted,
    // but marking it immovable is still the right default for
    // something meant to be a stable platform, and future-proofs it
    // if it's ever made longer later.
    this.isImmovable = true;

    // Gates the top-only gravity/landing constraint in
    // GravitySystem.js and CollisionSystem.js.
    this.isSkyDome = true;

    // (gravity window is now bounded by the dome shell itself — see
    // isWithinGravityWindow below — rather than a fixed height above
    // the ground.)

    // Dome — a shallow semi-ellipse (deliberately NOT a true
    // semicircle, which would be disproportionately tall relative to
    // a long, thin strip), sized relative to the platform itself, its
    // flat base sitting right at the platform's top surface.
    this.domeRadiusX = options.domeRadiusX ?? halfWidth; // matches the platform's own width exactly, so the dome's base diameter lines up with the platform's edges rather than overhanging them
    this.domeRadiusY = options.domeRadiusY ?? halfWidth;
    this.domeFillColor = options.domeFillColor ?? 'rgba(141, 195, 244, 0.9)';
    this.domeRimColor = options.domeRimColor ?? 'rgba(90, 150, 210, 0.85)'; // deeper blue at the rim, for the glass-gradient effect below
    this.domeOutlineColor = options.domeOutlineColor ?? '#ffffff';
    this.domeOutlineWidth = options.domeOutlineWidth ?? 3;
  }

  // True if a world point falls within the rectangular "capture zone"
  // directly above the platform's top surface — the ONLY region this
  // planet ever pulls from or can be landed on from. No rotation
  // transform needed since this class never rotates (see the class
  // comment above).
  // Suppresses the inherited dashed "gravity influence" ring. That
  // ring implies a generic circular influence radius — accurate for
  // every other planet type, where gravity really does reach out in
  // a ring all around them, but actively misleading here, where
  // gravity only ever works within the small rectangular window
  // directly above the surface (see isWithinGravityWindow).
  createOffscreen() {
    super.createOffscreen();
    this.ringCanvas = null;
  }

  // True for any point above the ground's own surface AND inside the
  // dome's actual ellipse — replaced an earlier version using a fixed
  // height band above the ground, which was sized for "landing on flat
  // ground" and turned out far too shallow once real jump chains
  // (platform to platform) could carry the player well above it: past
  // that band, nothing pulled the player back down at all, even though
  // they were still visibly inside the glass. Bounding by the dome's
  // real shape instead means gravity reaches anywhere actually inside
  // the dome, matching what the player can see, no matter how high a
  // jump carries them — reuses the same ellipse-containment math as
  // nearestDomeSurfacePoint (nx²+ny² <= 1 in the dome's own normalized
  // space), just without needing the exact boundary point/normal.
  isWithinGravityWindow(worldX, worldY) {
    const topY = this.pos.y - this.halfHeight;
    if (worldY > topY) return false; // never applies below the ground's own surface — approaching from below just flies past, same as before

    const nx = (worldX - this.pos.x) / this.domeRadiusX;
    const ny = (worldY - topY) / this.domeRadiusY;
    return (nx * nx + ny * ny) <= 1;
  }

  // Nearest point on the DOME's curved shell to a world point, its
  // true elliptical outward normal, and the distance to it — a
  // completely separate surface from nearestSurfacePoint (the
  // platform body, inherited from RoundedRectPlanetoid). Deliberately
  // kept separate rather than folded into nearestSurfacePoint: that
  // method is also what the PLAYER's landing check uses, and the
  // player is always well inside the dome, close to the flat ground,
  // never near the shell — conflating the two would have broken normal
  // landing for anyone standing anywhere near the platform's
  // horizontal center. This is only ever called from planetoid/
  // asteroid collision code (see CollisionSystem.js), which checks it
  // is present via `typeof x.nearestDomeSurfacePoint === 'function'`
  // rather than a separate flag, so nothing needs updating elsewhere
  // if a future planet type adds a dome the same way.
  //
  // Uses the standard normalized-space approximation for nearest point
  // on an ellipse (scale into a unit circle, solve there, scale back) —
  // exact when domeRadiusX equals domeRadiusY (the current default),
  // and a good approximation otherwise.
  nearestDomeSurfacePoint(worldX, worldY) {
    const ex = this.pos.x;
    const ey = this.pos.y - this.halfHeight; // dome's ellipse center = the platform's own top surface line
    const rx = this.domeRadiusX, ry = this.domeRadiusY;

    const lx = worldX - ex, ly = worldY - ey;
    const nx = lx / rx, ny = ly / ry;
    const nDist = Math.sqrt(nx * nx + ny * ny);

    let blx, bly;
    if (nDist < 1e-6) {
      // Degenerate: essentially at the ellipse's own center — push
      // straight up as a reasonable default rather than dividing by
      // (near) zero.
      blx = 0;
      bly = -ry;
    } else {
      blx = (nx / nDist) * rx;
      bly = (ny / nDist) * ry;
    }

    const boundaryX = ex + blx, boundaryY = ey + bly;
    // True elliptical outward normal — gradient of (x/rx)^2+(y/ry)^2=1
    // at the boundary point, not the cruder "point minus center"
    // shortcut (which is only exact for a true circle).
    const normal = new Vector2(blx / (rx * rx), bly / (ry * ry)).normalize();

    const dx = worldX - boundaryX, dy = worldY - boundaryY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    return { point: new Vector2(boundaryX, boundaryY), normal, distance };
  }

  drawDome() {
    const ctx = state.ctx;
    const cx = this.pos.x;
    const cy = this.pos.y - this.halfHeight; // flat base sits right at the platform's top surface

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, this.domeRadiusX, this.domeRadiusY, 0, Math.PI, Math.PI * 2);
    ctx.closePath(); // draws the flat bottom edge back to the arc's start

    // Glass-like gradient: a bright highlight offset toward the upper
    // area, as if reflecting a light source off curved glass, fading
    // through the base color toward a deeper, more saturated blue at
    // the rim — reads as a shiny, curved surface rather than a flat
    // tinted shape.
    const highlightX = cx - this.domeRadiusX * 0.25;
    const highlightY = cy - this.domeRadiusY * 0.55;
    const outerRadius = Math.max(this.domeRadiusX, this.domeRadiusY) * 1.1;
    const grad = ctx.createRadialGradient(highlightX, highlightY, 0, cx, cy, outerRadius);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.25, this.domeFillColor);
    grad.addColorStop(1, this.domeRimColor);

    ctx.fillStyle = grad;
    ctx.fill();

    ctx.lineWidth = this.domeOutlineWidth;
    ctx.strokeStyle = this.domeOutlineColor;
    ctx.stroke();
    ctx.restore();
  }

  draw() {
    this.drawDome(); // background layer, drawn first so the platform body renders on top of it
    super.draw();
  }
}