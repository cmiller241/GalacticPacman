// js/world/RoundedRectPlanetoid.js
import { state } from '../state.js';
import { INFLUENCE_PADDING, PLANET_SPEED } from '../constants.js';
import { Vector2 } from '../vector2.js';
import { Planetoid } from './Planetoid.js';

// A rounded rectangle = a smaller "core" rectangle (half-extents
// halfWidth-cornerRadius, halfHeight-cornerRadius) inflated by a circle
// of radius cornerRadius. That framing gives one shared formula for
// "nearest point on the surface": clamp the query point to the core
// rect, then push outward from that clamped point by cornerRadius.
// Works uniformly for flat edges AND corners, no special-casing.
//
// The perimeter is 4 straight edges (the core rect's sides) joined by
// 4 quarter-circle corner arcs. Walking that perimeter by arc-length
// gives the shape the same single-scalar "position on the surface"
// parameterization a circle gets for free from its angle — that's what
// lets the player and coins move along it exactly like they already do
// on circles.
//
// Everything is stored/rotated in the planet's own LOCAL frame
// (unrotated, centered on the shape); every PUBLIC method takes/returns
// WORLD coordinates, converting via rotationAngle + pos internally.
// Callers never need to know the shape rotates.

export class RoundedRectPlanetoid {
  constructor(x, y, halfWidth, halfHeight, cornerRadius, color) {
    this.pos = new Vector2(x, y);
    this.halfWidth = halfWidth;
    this.halfHeight = halfHeight;
    this.cornerRadius = Math.min(cornerRadius, halfWidth, halfHeight);
    this.color = color;

    // Bounding-circle radius. NOT the true surface distance anywhere
    // except the four corners — used only where other code expects a
    // plain circular `.radius`: updatePlanetoids()'s scene-edge bounce,
    // and handleElasticCollisions (planet-vs-planet bouncing). True
    // rect-vs-circle collision response is a separate physics problem
    // beyond nearestSurfacePoint (real contact normals, penetration
    // resolution) — out of scope here. This planet genuinely
    // participates in elastic bouncing with real momentum-conserving
    // math; it's just bouncing off this circular boundary rather than
    // the exact rounded-rect silhouette. Most noticeable near flat-edge
    // midpoints, least noticeable near corners (which the bounding
    // circle hugs closely). Gravity/landing/walking/orbiting all use
    // nearestSurfacePoint()/arc-position methods instead, never this.
    this.radius = Math.sqrt(halfWidth * halfWidth + halfHeight * halfHeight);
    this.mass = (2 * halfWidth) * (2 * halfHeight);
    this.influenceRadius = this.radius + INFLUENCE_PADDING;

    let direction = new Vector2(Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
    this.vel = direction.multiply(PLANET_SPEED);

    // Slow spin. Player/coins riding the surface stay glued to it as it
    // turns, same as they already stay glued to a drifting planet.
    this.rotationAngle = Math.random() * Math.PI * 2;
    this.rotationSpeed = 0.0006;

    this.isSpikey = false;
    this.isRoundedRect = true;
    this.offscreen = null;
    this.offscreenPadding = 0;
    this.ringCanvas = null;
    this.interiorType = null;
    this.cachedAlpha = 0.3;
    this.lastAlphaUpdate = 0;

    this._segments = this.buildSegments();
  }

  worldToLocal(worldX, worldY) {
    const dx = worldX - this.pos.x;
    const dy = worldY - this.pos.y;
    const c = Math.cos(-this.rotationAngle), s = Math.sin(-this.rotationAngle);
    return { x: dx * c - dy * s, y: dx * s + dy * c };
  }

  localDirToWorld(lx, ly) {
    const c = Math.cos(this.rotationAngle), s = Math.sin(this.rotationAngle);
    return new Vector2(lx * c - ly * s, lx * s + ly * c);
  }

  localPointToWorld(lx, ly) {
    const w = this.localDirToWorld(lx, ly);
    w.x += this.pos.x;
    w.y += this.pos.y;
    return w;
  }

  // Returns { point: Vector2 (world), normal: Vector2 (world, unit,
  // outward), distance: number >= 0 } for the nearest boundary point to
  // the given WORLD point.
  nearestSurfacePoint(worldX, worldY) {
    const local = this.worldToLocal(worldX, worldY);
    const coreHW = this.halfWidth - this.cornerRadius;
    const coreHH = this.halfHeight - this.cornerRadius;
    const cr = this.cornerRadius;

    const cx = Math.max(-coreHW, Math.min(coreHW, local.x));
    const cy = Math.max(-coreHH, Math.min(coreHH, local.y));
    let dx = local.x - cx, dy = local.y - cy;
    let len = Math.sqrt(dx * dx + dy * dy);

    if (len < 1e-6) {
      // Deep inside the core rect (shouldn't happen for a point that's
      // actually outside/on the surface) — fall back gracefully.
      const distV = coreHW - Math.abs(local.x), distH = coreHH - Math.abs(local.y);
      if (distV < distH) { dx = local.x >= 0 ? 1 : -1; dy = 0; }
      else { dx = 0; dy = local.y >= 0 ? 1 : -1; }
      len = 1;
    }
    dx /= len; dy /= len;

    const sx = cx + dx * cr, sy = cy + dy * cr;
    const distance = Math.sqrt((local.x - sx) ** 2 + (local.y - sy) ** 2);

    return {
      point: this.localPointToWorld(sx, sy),
      normal: this.localDirToWorld(dx, dy),
      distance
    };
  }

  distanceToSurface(worldX, worldY) {
    return this.nearestSurfacePoint(worldX, worldY).distance;
  }

  // Standard rounded-box point-containment test: clamp to the core
  // (unrounded) rect, then check whether the leftover offset falls
  // within the corner radius — correctly covers flat-edge regions,
  // corner regions, and fully-interior points with one formula, same
  // spirit as nearestSurfacePoint above. Used for right-click "pull
  // star" target selection (see Player.trySelectPullTarget).
  containsPoint(worldX, worldY) {
    const local = this.worldToLocal(worldX, worldY);
    const coreHW = this.halfWidth - this.cornerRadius;
    const coreHH = this.halfHeight - this.cornerRadius;
    const cr = this.cornerRadius;
    const cx = Math.max(-coreHW, Math.min(coreHW, local.x));
    const cy = Math.max(-coreHH, Math.min(coreHH, local.y));
    const dx = local.x - cx, dy = local.y - cy;
    return (dx * dx + dy * dy) <= cr * cr;
  }

  // Segment order (clockwise from the right edge's midpoint): right
  // edge -> BR corner -> bottom edge -> BL corner -> left edge -> TL
  // corner -> top edge -> TR corner -> (back to start). Each corner's
  // startAngle is chosen so consecutive segments meet exactly, with
  // continuous position/tangent/normal across every seam.
  buildSegments() {
    const coreHW = this.halfWidth - this.cornerRadius;
    const coreHH = this.halfHeight - this.cornerRadius;
    const hw = this.halfWidth, hh = this.halfHeight, cr = this.cornerRadius;
    return [
      { type: 'edge', length: 2 * coreHH, start: { x: hw, y: -coreHH }, dir: { x: 0, y: 1 }, normal: { x: 1, y: 0 } },
      { type: 'corner', length: (Math.PI / 2) * cr, center: { x: coreHW, y: coreHH }, startAngle: 0 },
      { type: 'edge', length: 2 * coreHW, start: { x: coreHW, y: hh }, dir: { x: -1, y: 0 }, normal: { x: 0, y: 1 } },
      { type: 'corner', length: (Math.PI / 2) * cr, center: { x: -coreHW, y: coreHH }, startAngle: Math.PI / 2 },
      { type: 'edge', length: 2 * coreHH, start: { x: -hw, y: coreHH }, dir: { x: 0, y: -1 }, normal: { x: -1, y: 0 } },
      { type: 'corner', length: (Math.PI / 2) * cr, center: { x: -coreHW, y: -coreHH }, startAngle: Math.PI },
      { type: 'edge', length: 2 * coreHW, start: { x: -coreHW, y: -hh }, dir: { x: 1, y: 0 }, normal: { x: 0, y: -1 } },
      { type: 'corner', length: (Math.PI / 2) * cr, center: { x: coreHW, y: -coreHH }, startAngle: 3 * Math.PI / 2 }
    ];
  }

  getPerimeter() {
    let t = 0;
    for (const seg of this._segments) t += seg.length;
    return t;
  }

  // Given arc-length s (wraps), returns local { point:{x,y},
  // tangent:{x,y} (unit, direction of increasing s), normal:{x,y} (unit,
  // outward) }.
  pointAtLocalArcPosition(s) {
    const perimeter = this.getPerimeter();
    let remaining = ((s % perimeter) + perimeter) % perimeter;
    for (const seg of this._segments) {
      if (remaining <= seg.length) {
        if (seg.type === 'edge') {
          return {
            point: { x: seg.start.x + seg.dir.x * remaining, y: seg.start.y + seg.dir.y * remaining },
            tangent: seg.dir,
            normal: seg.normal
          };
        }
        const angle = seg.startAngle + remaining / this.cornerRadius;
        const c = Math.cos(angle), s2 = Math.sin(angle);
        return {
          point: { x: seg.center.x + this.cornerRadius * c, y: seg.center.y + this.cornerRadius * s2 },
          tangent: { x: -s2, y: c },
          normal: { x: c, y: s2 }
        };
      }
      remaining -= seg.length;
    }
    const seg = this._segments[0];
    return { point: seg.start, tangent: seg.dir, normal: seg.normal };
  }

  // Inverse: given a LOCAL point already on/near the boundary, returns
  // the arc-length s that produced it. Used when the player lands, to
  // initialize their walk position from wherever they touched down.
  arcPositionForLocalPoint(lx, ly) {
    const coreHW = this.halfWidth - this.cornerRadius;
    const coreHH = this.halfHeight - this.cornerRadius;
    const cr = this.cornerRadius;
    const cumRightEdge = 2 * coreHH;
    const cumBR = cumRightEdge + (Math.PI / 2) * cr;
    const cumBottomEdge = cumBR + 2 * coreHW;
    const cumBL = cumBottomEdge + (Math.PI / 2) * cr;
    const cumLeftEdge = cumBL + 2 * coreHH;
    const cumTL = cumLeftEdge + (Math.PI / 2) * cr;
    const cumTopEdge = cumTL + 2 * coreHW;
    const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

    if (lx >= coreHW && ly >= coreHH) return cumRightEdge + norm(Math.atan2(ly - coreHH, lx - coreHW)) * cr;
    if (lx <= -coreHW && ly >= coreHH) return cumBottomEdge + (norm(Math.atan2(ly - coreHH, lx + coreHW)) - Math.PI / 2) * cr;
    if (lx <= -coreHW && ly <= -coreHH) return cumLeftEdge + (norm(Math.atan2(ly + coreHH, lx + coreHW)) - Math.PI) * cr;
    if (lx >= coreHW && ly <= -coreHH) return cumTopEdge + (norm(Math.atan2(ly + coreHH, lx - coreHW)) - 3 * Math.PI / 2) * cr;
    if (lx > coreHW) return ly + coreHH;
    if (ly > coreHH) return cumBR + (coreHW - lx);
    if (lx < -coreHW) return cumBL + (coreHH - ly);
    if (ly < -coreHH) return cumTL + (lx + coreHW);

    // Inside the core rect (shouldn't happen for a landing query) —
    // fall back to nearest edge.
    const distR = coreHW - lx, distL = lx + coreHW, distB = coreHH - ly, distT = ly + coreHH;
    const minH = Math.min(distR, distL), minV = Math.min(distB, distT);
    if (minH < minV) return distR < distL ? (ly + coreHH) : (cumBL + (coreHH - ly));
    return distB < distT ? (cumBR + (coreHW - lx)) : (cumTL + (lx + coreHW));
  }

  arcPositionForWorldPoint(worldX, worldY) {
    const local = this.worldToLocal(worldX, worldY);
    return this.arcPositionForLocalPoint(local.x, local.y);
  }

  // World-space wrapper: returns { point: Vector2 (world, pushed
  // outward by pushDistance), normal: Vector2 (world, unit) }. Player
  // uses pushDistance=PLAYER_RADIUS, Coin uses pushDistance=
  // COIN_ORBIT_OFFSET — same parameterization, different offset.
  worldPointAtArcPosition(s, pushDistance = 0) {
    const local = this.pointAtLocalArcPosition(s);
    const normal = this.localDirToWorld(local.normal.x, local.normal.y);
    const surfacePoint = this.localPointToWorld(local.point.x, local.point.y);
    const point = pushDistance !== 0 ? surfacePoint.add(normal.clone().multiply(pushDistance)) : surfacePoint;
    return { point, normal };
  }

  // Same recipe as Planetoid.js: bake texture+color tint once, then
  // bake the glow once onto a padded canvas, then bake the dashed
  // influence ring once. Uses ctx.roundRect() instead of a circular
  // arc. Reuses Planetoid's static shadow constants + shared sun-
  // overlay sprite for visual consistency without extending that
  // (circle-specific) class.
  createOffscreen() {
    const w = this.halfWidth * 2, h = this.halfHeight * 2;
    const bodyCanvas = document.createElement('canvas');
    bodyCanvas.width = w;
    bodyCanvas.height = h;
    const bodyCtx = bodyCanvas.getContext('2d');

    bodyCtx.save();
    bodyCtx.beginPath();
    bodyCtx.roundRect(0, 0, w, h, this.cornerRadius);
    bodyCtx.clip();
    const tiles = 2.5;
    const texSize = Math.max(w, h) * tiles;
    bodyCtx.drawImage(state.planetTexture, w / 2 - texSize / 2, h / 2 - texSize / 2, texSize, texSize);
    bodyCtx.restore();

    bodyCtx.save();
    bodyCtx.globalCompositeOperation = 'multiply';
    bodyCtx.beginPath();
    bodyCtx.roundRect(0, 0, w, h, this.cornerRadius);
    bodyCtx.fillStyle = this.color;
    bodyCtx.fill();
    bodyCtx.globalCompositeOperation = 'source-over';
    bodyCtx.restore();

    const padding = Planetoid.SHADOW_PADDING;
    this.offscreenPadding = padding;
    this.offscreen = document.createElement('canvas');
    this.offscreen.width = w + padding * 2;
    this.offscreen.height = h + padding * 2;
    const finalCtx = this.offscreen.getContext('2d');
    finalCtx.shadowColor = Planetoid.SHADOW_COLOR;
    finalCtx.shadowBlur = Planetoid.SHADOW_BLUR;
    finalCtx.drawImage(bodyCanvas, padding, padding);

    const ringPad = this.influenceRadius - this.radius;
    this.ringCanvas = document.createElement('canvas');
    this.ringCanvas.width = w + ringPad * 2;
    this.ringCanvas.height = h + ringPad * 2;
    const ringCtx = this.ringCanvas.getContext('2d');
    ringCtx.strokeStyle = 'rgba(173,216,230,1)';
    ringCtx.lineWidth = 3;
    ringCtx.setLineDash([10, 5]);
    ringCtx.beginPath();
    ringCtx.roundRect(0, 0, w + ringPad * 2, h + ringPad * 2, this.cornerRadius + ringPad);
    ringCtx.stroke();
  }

  draw() {
    const ctx = state.ctx;
    const now = Date.now();
    if (now - this.lastAlphaUpdate > 500) {
      const dist = this.pos.subtract(state.player.pos).length();
      this.cachedAlpha = Math.max(0.01, 0.3 - (dist / 1000) * 0.65);
      this.lastAlphaUpdate = now;
    }

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.rotationAngle);

    if (this.ringCanvas) {
      ctx.save();
      ctx.globalAlpha = this.cachedAlpha;
      ctx.drawImage(this.ringCanvas, -this.ringCanvas.width / 2, -this.ringCanvas.height / 2);
      ctx.restore();
    }
    if (this.offscreen) {
      ctx.drawImage(this.offscreen, -this.offscreen.width / 2, -this.offscreen.height / 2);
    }

    // Sun-relative shading, computed LIVE each frame via explicit
    // gradient coordinates rather than an extra ctx.rotate() layered on
    // top of this method's own rotate(rotationAngle) above. Two earlier
    // attempts using a composed ctx.rotate() for this produced visibly
    // wrong results (first a wandering offset, then a band that looked
    // rotated ~90° against the shape) despite the underlying angle math
    // checking out by hand both times — rather than keep chasing a
    // subtle transform-composition bug blind, this sidesteps the whole
    // category of it: the gradient's start/end points are computed
    // directly as coordinates, already expressed in the local frame
    // this code is already running in, so there's no additional
    // rotation call left to get wrong. Recomputed every frame (not
    // cached/baked) since the target direction changes continuously
    // from both the planet's spin and its slowly-shifting angle to the
    // sun as it drifts — cheap for the handful of these planets that
    // exist.
    const sunX = state.sceneWidth / 2, sunY = state.sceneHeight / 2;
    const toSunX = sunX - this.pos.x, toSunY = sunY - this.pos.y;
    const distToSun = Math.sqrt(toSunX * toSunX + toSunY * toSunY);
    const worldAngleToSun = Math.atan2(toSunY, toSunX);
    // Convert the WORLD angle-to-sun into a direction usable here,
    // since we're already inside the translate+rotate(rotationAngle)
    // frame from above — subtracting rotationAngle is what keeps the
    // gradient pointed at the true sun regardless of current spin.
    const localAngle = worldAngleToSun - this.rotationAngle;
    const hx = Math.cos(localAngle), hy = Math.sin(localAngle);

    const maxDist = Math.sqrt(state.sceneWidth ** 2 + state.sceneHeight ** 2) / 2;
    const distT = Math.min(distToSun / maxDist, 1);
    const overlayAlpha = Planetoid.SUN_MIN_ALPHA + distT * (Planetoid.SUN_MAX_ALPHA - Planetoid.SUN_MIN_ALPHA);

    const extent = Math.max(this.halfWidth, this.halfHeight) * 1.3;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(-this.halfWidth, -this.halfHeight, this.halfWidth * 2, this.halfHeight * 2, this.cornerRadius);
    ctx.clip();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = overlayAlpha;
    // Dark at the point opposite the sun, light at the point toward it.
    const grad = ctx.createLinearGradient(-hx * extent, -hy * extent, hx * extent, hy * extent);
    grad.addColorStop(0, 'black');
    grad.addColorStop(1, 'white');
    ctx.fillStyle = grad;
    ctx.fillRect(-this.halfWidth, -this.halfHeight, this.halfWidth * 2, this.halfHeight * 2);
    ctx.restore();

    const overallDarkness = Planetoid.SUN_MAX_DARKNESS * distT;
    if (overallDarkness > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = overallDarkness;
      ctx.fillStyle = '#000000';
      ctx.beginPath();
      ctx.roundRect(-this.halfWidth, -this.halfHeight, this.halfWidth * 2, this.halfHeight * 2, this.cornerRadius);
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();
  }
}