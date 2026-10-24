// js/world/RoundedRectPlanetoid.js
//
// A rounded-rectangle planetoid the player can land on and walk all the
// way AROUND (every edge and corner, not just the top), pull-target, and
// bounce off of like any ordinary circular Planetoid.
//
// Drifts and spins like any other field planetoid by default (this.vel,
// this.rotationAngle/rotationSpeed) — whoever spawns a "this one stays
// put" instance overrides isImmovable/isPermanent afterward.
//
// No influence-ring drawing — main.js's ring debug pass excludes every
// isRoundedRect planet (a circular ring would misrepresent a rectangular
// influence shape).

import love from '../love/index.js';
import lua from '../love/lua.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import constants from '../constants.js';
import Planetoid from './Planetoid.js';

class RoundedRectPlanetoid {
  // x, y: world center. halfWidth/halfHeight: half-extents of the core
  // box (before rounding). cornerRadius: clamped to never exceed either
  // half-extent. color: [r,g,b,a] 0..1, multiplied against the shared
  // rocky planetTexture.
  static new(x, y, halfWidth, halfHeight, cornerRadius, color) {
    return new RoundedRectPlanetoid(x, y, halfWidth, halfHeight, cornerRadius, color);
  }

  constructor(x, y, halfWidth, halfHeight, cornerRadius, color) {
    this.pos = new Vector2(x, y);
    this.halfWidth = halfWidth;
    this.halfHeight = halfHeight;
    this.cornerRadius = Math.min(cornerRadius ?? 0, halfWidth, halfHeight);
    this.color = color ?? [0.62, 0.58, 0.5, 1];

    // Bounding-circle radius — NOT the true surface distance anywhere
    // except the four corners — used only where other systems expect a
    // plain circular .radius: scene-edge bounce and planet-vs-planet
    // bouncing. Gravity/landing/walking/pull-targeting all use
    // nearestSurfacePoint/the arc-position methods below instead.
    this.radius = Math.sqrt(halfWidth * halfWidth + halfHeight * halfHeight);
    this.mass = (2 * halfWidth) * (2 * halfHeight);
    this.influenceRadius = this.radius + constants.INFLUENCE_PADDING;

    const direction = new Vector2(Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
    this.vel = direction.multiply(constants.PLANET_SPEED);

    // Slow spin — every surface query goes through worldToLocal/
    // localDirToWorld, which read rotationAngle fresh every call, so
    // anything riding the surface stays glued to it as it turns.
    this.rotationAngle = Math.random() * Math.PI * 2;
    this.rotationSpeed = 0.0006;

    this.isSpikey = false;
    this.isRoundedRect = true;

    this.bodyCanvas = null;
    this.bodyCanvasPadding = 0;
    this.bodyCanvasScale = 2;
    this.eclipseMesh = null;
    this.sunShadingMesh = null;

    this._segments = this.buildSegments();
  }

  // ----------------------------------------------------------------
  // Local/world frame helpers
  // ----------------------------------------------------------------

  // Returns [lx, ly].
  worldToLocal(worldX, worldY) {
    const dx = worldX - this.pos.x, dy = worldY - this.pos.y;
    const c = Math.cos(-this.rotationAngle), s = Math.sin(-this.rotationAngle);
    return [dx * c - dy * s, dx * s + dy * c];
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

  // ----------------------------------------------------------------
  // Surface geometry (clamp to the core rect, push out by cornerRadius
  // — one formula for flat edges AND corners)
  // ----------------------------------------------------------------

  nearestSurfacePoint(worldX, worldY) {
    const [lx, ly] = this.worldToLocal(worldX, worldY);
    const coreHW = this.halfWidth - this.cornerRadius;
    const coreHH = this.halfHeight - this.cornerRadius;
    const cr = this.cornerRadius;

    const cx = Math.max(-coreHW, Math.min(coreHW, lx));
    const cy = Math.max(-coreHH, Math.min(coreHH, ly));
    let dx = lx - cx, dy = ly - cy;
    let len = Math.sqrt(dx * dx + dy * dy);

    if (len < 1e-6) {
      const distV = coreHW - Math.abs(lx), distH = coreHH - Math.abs(ly);
      if (distV < distH) { dx = lx >= 0 ? 1 : -1; dy = 0; }
      else { dx = 0; dy = ly >= 0 ? 1 : -1; }
      len = 1;
    }
    dx /= len; dy /= len;

    const sx = cx + dx * cr, sy = cy + dy * cr;
    const distance = Math.sqrt((lx - sx) ** 2 + (ly - sy) ** 2);

    return {
      point: this.localPointToWorld(sx, sy),
      normal: this.localDirToWorld(dx, dy),
      distance,
    };
  }

  distanceToSurface(worldX, worldY) {
    return this.nearestSurfacePoint(worldX, worldY).distance;
  }

  // Used for pull-target selection — same clamp-then-check as
  // nearestSurfacePoint, just a boolean.
  containsPoint(worldX, worldY) {
    const [lx, ly] = this.worldToLocal(worldX, worldY);
    const coreHW = this.halfWidth - this.cornerRadius;
    const coreHH = this.halfHeight - this.cornerRadius;
    const cr = this.cornerRadius;
    const cx = Math.max(-coreHW, Math.min(coreHW, lx));
    const cy = Math.max(-coreHH, Math.min(coreHH, ly));
    const dx = lx - cx, dy = ly - cy;
    return (dx * dx + dy * dy) <= cr * cr;
  }

  // ----------------------------------------------------------------
  // Arc-length perimeter walking (right edge -> BR corner -> bottom edge
  // -> BL corner -> left edge -> TL corner -> top edge -> TR corner) —
  // what lets the player/coins walk all the way around the shape with a
  // single-scalar "position on the surface".
  // ----------------------------------------------------------------

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
      { type: 'corner', length: (Math.PI / 2) * cr, center: { x: coreHW, y: -coreHH }, startAngle: 3 * Math.PI / 2 },
    ];
  }

  getPerimeter() {
    let total = 0;
    for (const seg of this._segments) total += seg.length;
    return total;
  }

  pointAtLocalArcPosition(s) {
    const perimeter = this.getPerimeter();
    let remaining = lua.mod(s, perimeter);
    for (const seg of this._segments) {
      if (remaining <= seg.length) {
        if (seg.type === 'edge') {
          return {
            point: { x: seg.start.x + seg.dir.x * remaining, y: seg.start.y + seg.dir.y * remaining },
            tangent: seg.dir,
            normal: seg.normal,
          };
        }
        const angle = seg.startAngle + remaining / this.cornerRadius;
        const c = Math.cos(angle), s2 = Math.sin(angle);
        return {
          point: { x: seg.center.x + this.cornerRadius * c, y: seg.center.y + this.cornerRadius * s2 },
          tangent: { x: -s2, y: c },
          normal: { x: c, y: s2 },
        };
      }
      remaining -= seg.length;
    }
    const seg = this._segments[0];
    return { point: seg.start, tangent: seg.dir, normal: seg.normal };
  }

  // Inverse: given a LOCAL point already on/near the boundary, returns the
  // arc-length s that produced it — used when the player lands.
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
    const norm = (a) => lua.mod(a, 2 * Math.PI);

    if (lx >= coreHW && ly >= coreHH) return cumRightEdge + norm(Math.atan2(ly - coreHH, lx - coreHW)) * cr;
    if (lx <= -coreHW && ly >= coreHH) return cumBottomEdge + (norm(Math.atan2(ly - coreHH, lx + coreHW)) - Math.PI / 2) * cr;
    if (lx <= -coreHW && ly <= -coreHH) return cumLeftEdge + (norm(Math.atan2(ly + coreHH, lx + coreHW)) - Math.PI) * cr;
    if (lx >= coreHW && ly <= -coreHH) return cumTopEdge + (norm(Math.atan2(ly + coreHH, lx - coreHW)) - 3 * Math.PI / 2) * cr;
    if (lx > coreHW) return ly + coreHH;
    if (ly > coreHH) return cumBR + (coreHW - lx);
    if (lx < -coreHW) return cumBL + (coreHH - ly);
    if (ly < -coreHH) return cumTL + (lx + coreHW);

    // Inside the core rect (shouldn't happen for a landing query) — fall
    // back to the nearest edge.
    const distR = coreHW - lx, distL = lx + coreHW, distB = coreHH - ly, distT = ly + coreHH;
    const minH = Math.min(distR, distL), minV = Math.min(distB, distT);
    if (minH < minV) {
      if (distR < distL) return ly + coreHH;
      return cumBL + (coreHH - ly);
    }
    if (distB < distT) return cumBR + (coreHW - lx);
    return cumTL + (lx + coreHW);
  }

  arcPositionForWorldPoint(worldX, worldY) {
    const [lx, ly] = this.worldToLocal(worldX, worldY);
    return this.arcPositionForLocalPoint(lx, ly);
  }

  // World-space wrapper: returns { point: Vector2 (world, pushed outward
  // by pushDistance), normal: Vector2 (world, unit) }.
  worldPointAtArcPosition(s, pushDistance = 0) {
    const local = this.pointAtLocalArcPosition(s);
    const normal = this.localDirToWorld(local.normal.x, local.normal.y);
    const surfacePoint = this.localPointToWorld(local.point.x, local.point.y);
    let point = surfacePoint;
    if (pushDistance !== 0) point = surfacePoint.clone().add(normal.clone().multiply(pushDistance));
    return { point, normal };
  }

  // Spin only — position drift is handled generically by main.js's
  // updatePlanetoidsPhysics.
  update() {
    const ts = state.timeScale ?? 1;
    this.rotationAngle += this.rotationSpeed * ts;
  }

  // ----------------------------------------------------------------
  // Drawing
  // ----------------------------------------------------------------

  // Bakes the body ONCE (per instance — there are only a handful): a
  // soft glow border (successively padded rounded rects), then the
  // shared rocky planetTexture tiled and tinted by this.color, clipped to
  // the rounded-rect shape. Baked at bodyCanvasScale resolution.
  ensureBodyCanvas() {
    if (this.bodyCanvas) return;
    if (!state.planetTexture) return;

    const padding = Planetoid.SHADOW_PADDING;
    this.bodyCanvasPadding = padding;
    const scale = this.bodyCanvasScale;
    const w = this.halfWidth * 2, h = this.halfHeight * 2;
    const cr = this.cornerRadius * scale;
    const canvasW = (w + padding * 2) * scale, canvasH = (h + padding * 2) * scale;
    const originX = padding * scale, originY = padding * scale;

    const canvas = love.graphics.newCanvas(canvasW, canvasH);
    canvas.setFilter('linear', 'linear');

    love.graphics.push();
    love.graphics.origin();
    love.graphics.setCanvas({ 0: canvas, stencil: true });
    love.graphics.clear(0, 0, 0, 0);
    love.graphics.setBlendMode('alpha');

    const GLOW_LAYERS = 18;
    for (let i = GLOW_LAYERS; i >= 1; i--) {
      const t = i / GLOW_LAYERS;
      const pad = padding * scale * t;
      const falloff = (1 - t) * (1 - t);
      const alpha = Planetoid.SHADOW_COLOR[3] * falloff * 0.85;
      love.graphics.setColor(Planetoid.SHADOW_COLOR[0], Planetoid.SHADOW_COLOR[1], Planetoid.SHADOW_COLOR[2], alpha);
      love.graphics.rectangle('fill',
        originX - pad, originY - pad, w * scale + pad * 2, h * scale + pad * 2,
        cr + pad, cr + pad);
    }

    love.graphics.stencil(() => {
      love.graphics.rectangle('fill', originX, originY, w * scale, h * scale, cr, cr);
    }, 'replace', 1);
    love.graphics.setStencilTest('greater', 0);

    const tiles = 2.5;
    const [texW, texH] = state.planetTexture.getDimensions();
    const texSize = Math.max(w, h) * scale * tiles;
    love.graphics.setColor(this.color[0], this.color[1], this.color[2], this.color[3] ?? 1);
    love.graphics.draw(state.planetTexture,
      originX + w * scale / 2, originY + h * scale / 2, 0,
      texSize / texW, texSize / texH, texW / 2, texH / 2);

    love.graphics.setStencilTest();
    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.setCanvas();
    love.graphics.pop();

    this.bodyCanvas = canvas;
  }

  draw() {
    // Shadow first (behind everything) — circular Planetoid's own method.
    Planetoid.drawEclipseShadow(this);

    this.ensureBodyCanvas();

    love.graphics.push();
    love.graphics.translate(this.pos.x, this.pos.y);
    love.graphics.rotate(this.rotationAngle);

    if (this.bodyCanvas) {
      const padding = this.bodyCanvasPadding ?? 0;
      const invScale = 1 / this.bodyCanvasScale;
      love.graphics.setColor(1, 1, 1, 1);
      love.graphics.draw(this.bodyCanvas, -(this.halfWidth + padding), -(this.halfHeight + padding), 0, invScale, invScale);
    } else {
      love.graphics.setColor(this.color[0], this.color[1], this.color[2], this.color[3] ?? 1);
      love.graphics.rectangle('fill', -this.halfWidth, -this.halfHeight,
        this.halfWidth * 2, this.halfHeight * 2, this.cornerRadius, this.cornerRadius);
      love.graphics.setColor(1, 1, 1, 1);
    }

    love.graphics.pop();

    this.drawSunShading();
  }

  // Live directional shading, recomputed every frame: a directional
  // gradient (dark at the point opposite the sun, unchanged toward it)
  // blended "multiply", then a flat overall-darkness fill on top. The
  // gradient is a vertex-colored quad mesh oriented along the local
  // direction to the sun and clipped to the rounded-rect via stencil.
  drawSunShading() {
    const sunX = (state.sceneWidth ?? 0) / 2, sunY = (state.sceneHeight ?? 0) / 2;
    const toSunX = sunX - this.pos.x, toSunY = sunY - this.pos.y;
    const distToSun = Math.sqrt(toSunX * toSunX + toSunY * toSunY);
    const worldAngleToSun = Math.atan2(toSunY, toSunX);
    // Subtracting rotationAngle keeps the gradient pointed at the true
    // sun regardless of this planet's own current spin.
    const localAngle = worldAngleToSun - this.rotationAngle;
    const hx = Math.cos(localAngle), hy = Math.sin(localAngle);

    const maxDist = Math.sqrt((state.sceneWidth ?? 0) ** 2 + (state.sceneHeight ?? 0) ** 2) / 2;
    const distT = maxDist > 0 ? Math.min(distToSun / maxDist, 1) : 0;
    const overlayAlpha = Planetoid.SUN_MIN_ALPHA + distT * (Planetoid.SUN_MAX_ALPHA - Planetoid.SUN_MIN_ALPHA);

    const w = this.halfWidth * 2, h = this.halfHeight * 2;
    const extent = Math.max(this.halfWidth, this.halfHeight) * 1.3;

    love.graphics.push();
    love.graphics.translate(this.pos.x, this.pos.y);
    love.graphics.rotate(this.rotationAngle);

    love.graphics.stencil(() => {
      love.graphics.rectangle('fill', -this.halfWidth, -this.halfHeight, w, h, this.cornerRadius, this.cornerRadius);
    }, 'replace', 1);
    love.graphics.setStencilTest('greater', 0);

    // A big quad straddling the shape, long axis along the sun direction,
    // oversized so it fully covers the stencil region. Premultiplied
    // alpha for the multiply blend: black stays black, white fades toward
    // "no darkening" as overlayAlpha shrinks.
    const px = -hy, py = hx;
    const vertices = [
      [-hx * extent + px * extent, -hy * extent + py * extent, 0, 0, 0, 0, 0, overlayAlpha],
      [-hx * extent - px * extent, -hy * extent - py * extent, 0, 0, 0, 0, 0, overlayAlpha],
      [hx * extent - px * extent, hy * extent - py * extent, 0, 0, overlayAlpha, overlayAlpha, overlayAlpha, overlayAlpha],
      [hx * extent + px * extent, hy * extent + py * extent, 0, 0, overlayAlpha, overlayAlpha, overlayAlpha, overlayAlpha],
    ];
    if (!this.sunShadingMesh) this.sunShadingMesh = love.graphics.newMesh(vertices, 'fan', 'dynamic');
    else this.sunShadingMesh.setVertices(vertices);

    love.graphics.setBlendMode('multiply', 'premultiplied');
    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.draw(this.sunShadingMesh);

    const overallDarkness = Planetoid.SUN_MAX_DARKNESS * distT;
    if (overallDarkness > 0) {
      love.graphics.setBlendMode('alpha');
      love.graphics.setColor(0, 0, 0, overallDarkness);
      love.graphics.rectangle('fill', -this.halfWidth, -this.halfHeight, w, h, this.cornerRadius, this.cornerRadius);
    }

    love.graphics.setBlendMode('alpha');
    love.graphics.setStencilTest();
    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.pop();
  }
}

export default RoundedRectPlanetoid;
