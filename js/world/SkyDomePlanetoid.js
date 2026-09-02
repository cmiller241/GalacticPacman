// js/world/SkyDomePlanetoid.js
import { state } from '../state.js';
import { Vector2 } from '../vector2.js';
import { RoundedRectPlanetoid } from './RoundedRectPlanetoid.js';
import { Sprite, Texture, TilingSprite, Graphics, Container, Rectangle } from 'pixi.js';
import { ShockwaveFilter, BulgePinchFilter } from 'pixi-filters';

export class SkyDomePlanetoid extends RoundedRectPlanetoid {
  constructor(x, y, options = {}) {
    const halfWidth = options.halfWidth ?? 2000;
    const halfHeight = options.halfHeight ?? 32;
    const cornerRadius = options.cornerRadius ?? 0;
    const color = options.color ?? '#5c8a4a';

    super(x, y, halfWidth, halfHeight, cornerRadius, color);

    this.grassHeight = options.grassHeight ?? 32;
    this.halfHeight += this.grassHeight;

    this.vel = new Vector2(0, 0);
    this.rotationAngle = 0;
    this.rotationSpeed = 0;

    this.isImmovable = true;
    this.isSkyDome = true;
    this.noSunShading = true;

    this.domeRadiusX = options.domeRadiusX ?? halfWidth;
    this.domeRadiusY = options.domeRadiusY ?? halfWidth;
    this.baseRadiusY = options.baseRadiusY ?? this.domeRadiusY / 6;

    this.baseGlowColor = options.baseGlowColor ?? '180, 210, 255';
    this.baseLineColor = options.baseLineColor ?? '10, 10, 12';
    this.baseHorizontalLineCount = options.baseHorizontalLineCount ?? 3;
    this.baseSeamCount = options.baseSeamCount ?? 6;
    this.baseHighlightColor = options.baseHighlightColor ?? '210, 220, 235';
    this.baseSeamConvergence = options.baseSeamConvergence ?? 0.35;

    this.domeFillColor = options.domeFillColor ?? 'rgba(130, 196, 255, 0.9)';
    this.domeRimColor = options.domeRimColor ?? 'rgba(75, 150, 225, 0.85)';
    this.domeOutlineColor = options.domeOutlineColor ?? '#ffffff';
    this.domeOutlineWidth = options.domeOutlineWidth ?? 3;
    this.domeBottomFade = options.domeBottomFade ?? 0.45;

    this.domeGlowColor = options.domeGlowColor ?? '255,255,255';
    this.domeGlowReach = options.domeGlowReach ?? 30;
    this.domeGlowIntensity = options.domeGlowIntensity ?? 1;
    this.domeInnerGlowReach = options.domeInnerGlowReach ?? 40;

    this.domeHexSize = options.domeHexSize ?? 60;
    this.domeHexColor = options.domeHexColor ?? '255,255,255';
    this.domeHexOpacity = options.domeHexOpacity ?? 0.12;
    this.domeHexScrollSpeed = options.domeHexScrollSpeed ?? 0.006;
    this.domeHexLineWidth = options.domeHexLineWidth ?? 1;

    this.domeForegroundHexSize = options.domeForegroundHexSize ?? this.domeHexSize * 1;
    this.domeForegroundHexOpacity = options.domeForegroundHexOpacity ?? Math.min(1, this.domeHexOpacity * 2.5);
    this.domeForegroundHexScrollSpeed = options.domeForegroundHexScrollSpeed ?? -0.01;
    this.domeForegroundHexLineWidth = options.domeForegroundHexLineWidth ?? 1.5;

    this.domeForegroundTintOpacity = options.domeForegroundTintOpacity ?? 1.0;
    this.domeForegroundOutlineOpacity = options.domeForegroundOutlineOpacity ?? 0.2;

    this.domeForegroundZoomReference = options.domeForegroundZoomReference ?? 1.0;
    this.domeForegroundZoomFloor = options.domeForegroundZoomFloor ?? 0;

    this.hexGridCanvas = null;
    this.hexGridForegroundCanvas = null;

    this.lastImpactTime = 0;
    this.shieldRipples = [];
    this.shieldSparks = [];

    this.shockwaveFilter = null;
    this.pixiForegroundContainer = null;
  }

  triggerShieldImpact(worldX, worldY, intensity = 1) {
    this.lastImpactTime = Date.now();
    this.shieldRipples.push({ x: worldX, y: worldY, spawnTime: this.lastImpactTime, intensity });

    const sparkCount = Math.round(4 + intensity * 6);
    for (let i = 0; i < sparkCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.06 + Math.random() * 0.12;
      this.shieldSparks.push({
        x: worldX,
        y: worldY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        spawnTime: this.lastImpactTime
      });
    }
  }

  get trueSurfaceY() {
    return this.pos.y - this.halfHeight;
  }

  get domeAnchorY() {
    return this.trueSurfaceY + this.grassHeight;
  }

  drawBodyTexture() {}

  drawMetalBase() {
    const ctx = state.ctx;
    const cx = this.pos.x;
    const cy = this.domeAnchorY;
    const baseRadiusX = this.halfWidth;
    const baseRadiusY = this.baseRadiusY;

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, baseRadiusX, baseRadiusY, 0, 0, Math.PI);
    ctx.closePath();

    const grad = ctx.createLinearGradient(cx, cy, cx, cy + baseRadiusY);
    grad.addColorStop(0, '#8a8a92');
    grad.addColorStop(0.5, '#333338');
    grad.addColorStop(1, '#050506');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, baseRadiusX, baseRadiusY, 0, 0, Math.PI);
    ctx.closePath();
    ctx.clip();
    const glowLayers = [
      { inset: 0, alpha: 0.12 },
      { inset: baseRadiusY * 0.15, alpha: 0.08 },
      { inset: baseRadiusY * 0.3, alpha: 0.04 }
    ];
    for (const layer of glowLayers) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, baseRadiusX - layer.inset, baseRadiusY - layer.inset, 0, 0, Math.PI);
      ctx.lineWidth = baseRadiusY * 0.2;
      ctx.strokeStyle = `rgba(${this.baseGlowColor}, ${layer.alpha})`;
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, baseRadiusX, baseRadiusY, 0, 0, Math.PI);
    ctx.closePath();
    ctx.clip();
    const highlightOffset = 2;
    ctx.lineWidth = 2;
    for (let i = 1; i <= this.baseHorizontalLineCount; i++) {
      const t = i / (this.baseHorizontalLineCount + 1);
      const lineY = cy + baseRadiusY * t;

      ctx.strokeStyle = `rgba(${this.baseHighlightColor}, 0.15)`;
      ctx.beginPath();
      ctx.moveTo(cx - baseRadiusX, lineY - highlightOffset);
      ctx.lineTo(cx + baseRadiusX, lineY - highlightOffset);
      ctx.stroke();

      ctx.strokeStyle = `rgba(${this.baseLineColor}, 0.5)`;
      ctx.beginPath();
      ctx.moveTo(cx - baseRadiusX, lineY);
      ctx.lineTo(cx + baseRadiusX, lineY);
      ctx.stroke();
    }

    const bottomY = cy + baseRadiusY;
    for (let i = 1; i < this.baseSeamCount; i++) {
      const t = i / this.baseSeamCount;
      const startX = cx - baseRadiusX + t * (baseRadiusX * 2);
      const endX = cx + (startX - cx) * (1 - this.baseSeamConvergence);
      const controlY = cy + baseRadiusY * 0.6;

      ctx.strokeStyle = `rgba(${this.baseHighlightColor}, 0.12)`;
      ctx.beginPath();
      ctx.moveTo(startX + highlightOffset, cy);
      ctx.quadraticCurveTo(startX + highlightOffset, controlY, endX + highlightOffset, bottomY);
      ctx.stroke();

      ctx.strokeStyle = `rgba(${this.baseLineColor}, 0.4)`;
      ctx.beginPath();
      ctx.moveTo(startX, cy);
      ctx.quadraticCurveTo(startX, controlY, endX, bottomY);
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, baseRadiusX, baseRadiusY, 0, 0, Math.PI);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#1e1e20';
    ctx.stroke();
    ctx.restore();
  }

  drawGrassCap() {
    const ctx = state.ctx;
    const grassImg = state.grassTexture;
    if (!grassImg || !grassImg.complete) return;

    const grassTopY = this.trueSurfaceY;
    const scale = 2;
    const tileW = 32 * scale;
    const fullWidth = this.halfWidth * 2;
    const startX = this.pos.x - this.halfWidth;
    const seamOverlap = 2;
    const drawHeight = this.grassHeight + seamOverlap;

    ctx.save();
    ctx.beginPath();
    ctx.rect(startX, grassTopY, fullWidth, drawHeight);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    for (let x = 0; x < fullWidth; x += tileW) {
      ctx.drawImage(grassImg, startX + x, grassTopY, tileW, drawHeight);
    }
    ctx.restore();
  }

  createOffscreen() {
    super.createOffscreen();
    this.ringCanvas = null;

    const bgTile = this.bakeHexGridTile(this.domeHexSize, this.domeHexOpacity, this.domeHexLineWidth);
    this.hexGridCanvas = bgTile.canvas;
    this.hexGridTileW = bgTile.tileW;
    this.hexGridTileH = bgTile.tileH;

    const fgTile = this.bakeHexGridTile(
      this.domeForegroundHexSize,
      this.domeForegroundHexOpacity,
      this.domeForegroundHexLineWidth
    );
    this.hexGridForegroundCanvas = fgTile.canvas;
    this.hexGridForegroundTileW = fgTile.tileW;
    this.hexGridForegroundTileH = fgTile.tileH;
  }

  strokeHexagon(ctx, cx, cy, size) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 6;
      const x = cx + size * Math.cos(angle);
      const y = cy + size * Math.sin(angle);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  }

  bakeHexGridTile(hexSize, opacity, lineWidth = 1) {
    const hexWidth = Math.sqrt(3) * hexSize;
    const hexHeightStep = hexSize * 1.5;
    const tileW = hexWidth;
    const tileH = hexHeightStep * 2;

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(tileW);
    canvas.height = Math.ceil(tileH);
    const bctx = canvas.getContext('2d');
    bctx.strokeStyle = `rgba(${this.domeHexColor}, ${opacity})`;
    bctx.lineWidth = lineWidth;

    for (let row = -1; row <= 2; row++) {
      const y = row * hexHeightStep;
      const rowOffset = (row % 2 !== 0) ? hexWidth / 2 : 0;
      for (let col = -1; col <= 2; col++) {
        const x = col * hexWidth + rowOffset;
        this.strokeHexagon(bctx, x, y, hexSize);
      }
    }

    return { canvas, tileW, tileH };
  }

  drawScrollingHexTile(ctx, cx, cy, boxX, boxY, boxW, tileCanvas, tileW, tileH, scrollSpeed) {
    if (!tileCanvas) return;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, this.domeRadiusX, this.domeRadiusY, 0, Math.PI, Math.PI * 2);
    ctx.closePath();
    ctx.clip();

    const scrollOffset = ((Date.now() * scrollSpeed) % tileW + tileW) % tileW;
    const startX = boxX - scrollOffset - tileW;
    for (let y = boxY - tileH; y < cy; y += tileH) {
      for (let x = startX; x < boxX + boxW + tileW; x += tileW) {
        ctx.drawImage(tileCanvas, x, y);
      }
    }
    ctx.restore();
  }

  isWithinGravityWindow(worldX, worldY) {
    if (worldY > this.trueSurfaceY) return false;
    const nx = (worldX - this.pos.x) / this.domeRadiusX;
    const ny = (worldY - this.domeAnchorY) / this.domeRadiusY;
    return (nx * nx + ny * ny) <= 1;
  }

  nearestEllipseSurfacePoint(centerX, centerY, radiusX, radiusY, worldX, worldY, fallbackDirY) {
    const lx = worldX - centerX, ly = worldY - centerY;
    const nx = lx / radiusX, ny = ly / radiusY;
    const nDist = Math.sqrt(nx * nx + ny * ny);

    let blx, bly;
    if (nDist < 1e-6) {
      blx = 0;
      bly = fallbackDirY * radiusY;
    } else {
      blx = (nx / nDist) * radiusX;
      bly = (ny / nDist) * radiusY;
    }

    const boundaryX = centerX + blx, boundaryY = centerY + bly;
    const normal = new Vector2(blx / (radiusX * radiusX), bly / (radiusY * radiusY)).normalize();
    const dx = worldX - boundaryX, dy = worldY - boundaryY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    return { point: new Vector2(boundaryX, boundaryY), normal, distance };
  }

  nearestDomeSurfacePoint(worldX, worldY) {
    return this.nearestEllipseSurfacePoint(
      this.pos.x, this.domeAnchorY,
      this.domeRadiusX, this.domeRadiusY,
      worldX, worldY, -1
    );
  }

  nearestBaseSurfacePoint(worldX, worldY) {
    return this.nearestEllipseSurfacePoint(
      this.pos.x, this.domeAnchorY,
      this.halfWidth, this.baseRadiusY,
      worldX, worldY, 1
    );
  }

  drawDome() {
    const ctx = state.ctx;
    const cx = this.pos.x;
    const cy = this.domeAnchorY;

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, this.domeRadiusX, this.domeRadiusY, 0, Math.PI, Math.PI * 2);
    ctx.closePath();
    ctx.clip();

    const boxX = cx - this.domeRadiusX, boxY = cy - this.domeRadiusY;
    const boxW = this.domeRadiusX * 2, boxH = this.domeRadiusY * 2;

    const highlightX = cx - this.domeRadiusX * 0.25;
    const highlightY = cy - this.domeRadiusY * 0.55;
    const outerRadius = Math.max(this.domeRadiusX, this.domeRadiusY) * 1.1;
    const glassGrad = ctx.createRadialGradient(highlightX, highlightY, 0, cx, cy, outerRadius);
    glassGrad.addColorStop(0, 'rgba(255,255,255,0.9)');
    glassGrad.addColorStop(0.25, this.domeFillColor);
    glassGrad.addColorStop(1, this.domeRimColor);
    ctx.fillStyle = glassGrad;
    ctx.fillRect(boxX, boxY, boxW, boxH);

    ctx.globalCompositeOperation = 'destination-out';
    const fadeGrad = ctx.createLinearGradient(cx, boxY, cx, cy);
    fadeGrad.addColorStop(0, 'rgba(0,0,0,0)');
    fadeGrad.addColorStop(1, `rgba(0,0,0,${this.domeBottomFade})`);
    ctx.fillStyle = fadeGrad;
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, this.domeRadiusX, this.domeRadiusY, 0, Math.PI, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    const innerLayers = [
      { inset: 0, alpha: 0.10 },
      { inset: this.domeInnerGlowReach * 0.5, alpha: 0.07 },
      { inset: this.domeInnerGlowReach, alpha: 0.04 }
    ];
    for (const layer of innerLayers) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, this.domeRadiusX - layer.inset, this.domeRadiusY - layer.inset, 0, Math.PI, Math.PI * 2);
      ctx.lineWidth = this.domeInnerGlowReach;
      ctx.strokeStyle = `rgba(${this.domeGlowColor}, ${layer.alpha * this.domeGlowIntensity})`;
      ctx.stroke();
    }
    ctx.restore();

    this.drawScrollingHexTile(
      ctx, cx, cy, boxX, boxY, boxW,
      this.hexGridCanvas, this.hexGridTileW, this.hexGridTileH,
      this.domeHexScrollSpeed
    );

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, this.domeRadiusX, this.domeRadiusY, 0, Math.PI, Math.PI * 2);
    const reach = this.domeGlowReach;
    const glowLayers = [
      { width: this.domeOutlineWidth + reach, alpha: 0.06 },
      { width: this.domeOutlineWidth + reach * 0.6, alpha: 0.10 },
      { width: this.domeOutlineWidth + reach * 0.3, alpha: 0.16 }
    ];
    for (const layer of glowLayers) {
      ctx.lineWidth = layer.width;
      ctx.strokeStyle = `rgba(${this.domeGlowColor}, ${layer.alpha * this.domeGlowIntensity})`;
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, this.domeRadiusX, this.domeRadiusY, 0, Math.PI, Math.PI * 2);
    ctx.lineWidth = this.domeOutlineWidth;
    ctx.strokeStyle = this.domeOutlineColor;
    ctx.stroke();
    ctx.restore();

    this.drawShieldImpactEffects(ctx, cx, cy, boxX, boxY, boxW, boxH);
  }

  drawShieldImpactEffects(ctx, cx, cy, boxX, boxY, boxW, boxH) {
    const now = Date.now();
    const PULSE_DURATION_MS = 350;
    const pulseElapsed = now - this.lastImpactTime;
    if (pulseElapsed < PULSE_DURATION_MS) {
      const t = 1 - pulseElapsed / PULSE_DURATION_MS;
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(cx, cy, this.domeRadiusX, this.domeRadiusY, 0, Math.PI, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.globalAlpha = t * 0.5;
      ctx.fillStyle = 'rgba(255,255,255,1)';
      ctx.fillRect(boxX, boxY, boxW, boxH);
      ctx.restore();
    }

    const RIPPLE_DURATION_MS = 400;
    for (let i = this.shieldRipples.length - 1; i >= 0; i--) {
      const r = this.shieldRipples[i];
      const age = now - r.spawnTime;
      if (age > RIPPLE_DURATION_MS) {
        this.shieldRipples.splice(i, 1);
        continue;
      }
      const t = age / RIPPLE_DURATION_MS;
      const radius = (10 + r.intensity * 15) * (0.3 + t * 0.7);
      ctx.beginPath();
      ctx.strokeStyle = `rgba(210, 240, 255, ${(1 - t) * 0.8})`;
      ctx.lineWidth = 2.5;
      ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }

    const SPARK_DURATION_MS = 500;
    for (let i = this.shieldSparks.length - 1; i >= 0; i--) {
      const s = this.shieldSparks[i];
      const age = now - s.spawnTime;
      if (age > SPARK_DURATION_MS) {
        this.shieldSparks.splice(i, 1);
        continue;
      }
      const x = s.x + s.vx * age;
      const y = s.y + s.vy * age;
      ctx.beginPath();
      ctx.fillStyle = `rgba(220, 240, 255, ${1 - age / SPARK_DURATION_MS})`;
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  draw() {
    this.drawDome();
    this.drawMetalBase();
    this.drawGrassCap();
    super.draw();
  }

  // ─────────────────────────────────────────────────────────────
  // PIXI
  // ─────────────────────────────────────────────────────────────

  domeBakeGeometry() {
    const padding = this.domeGlowReach + 10;
    const width = this.domeRadiusX * 2 + padding * 2;
    const height = this.domeRadiusY + padding * 2;
    const cx = width / 2;
    const cy = height - padding;
    return { padding, width, height, cx, cy };
  }

  createDomeBackTexture() {
    const { width, height, cx, cy } = this.domeBakeGeometry();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, this.domeRadiusX, this.domeRadiusY, 0, Math.PI, Math.PI * 2);
    ctx.closePath();
    ctx.clip();

    const boxX = cx - this.domeRadiusX, boxY = cy - this.domeRadiusY;
    const boxW = this.domeRadiusX * 2, boxH = this.domeRadiusY * 2;

    const highlightX = cx - this.domeRadiusX * 0.25;
    const highlightY = cy - this.domeRadiusY * 0.55;
    const outerRadius = Math.max(this.domeRadiusX, this.domeRadiusY) * 1.1;
    const glassGrad = ctx.createRadialGradient(highlightX, highlightY, 0, cx, cy, outerRadius);
    glassGrad.addColorStop(0, 'rgba(255,255,255,0.9)');
    glassGrad.addColorStop(0.25, this.domeFillColor);
    glassGrad.addColorStop(1, this.domeRimColor);
    ctx.fillStyle = glassGrad;
    ctx.fillRect(boxX, boxY, boxW, boxH);

    ctx.globalCompositeOperation = 'destination-out';
    const fadeGrad = ctx.createLinearGradient(cx, boxY, cx, cy);
    fadeGrad.addColorStop(0, 'rgba(0,0,0,0)');
    fadeGrad.addColorStop(1, `rgba(0,0,0,${this.domeBottomFade})`);
    ctx.fillStyle = fadeGrad;
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, this.domeRadiusX, this.domeRadiusY, 0, Math.PI, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    const innerLayers = [
      { inset: 0, alpha: 0.10 },
      { inset: this.domeInnerGlowReach * 0.5, alpha: 0.07 },
      { inset: this.domeInnerGlowReach, alpha: 0.04 }
    ];
    for (const layer of innerLayers) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, this.domeRadiusX - layer.inset, this.domeRadiusY - layer.inset, 0, Math.PI, Math.PI * 2);
      ctx.lineWidth = this.domeInnerGlowReach;
      ctx.strokeStyle = `rgba(${this.domeGlowColor}, ${layer.alpha * this.domeGlowIntensity})`;
      ctx.stroke();
    }
    ctx.restore();

    return { canvas, anchorX: cx / width, anchorY: cy / height };
  }

  createDomeFrontTexture() {
    const { width, height, cx, cy } = this.domeBakeGeometry();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, this.domeRadiusX, this.domeRadiusY, 0, Math.PI, Math.PI * 2);
    const reach = this.domeGlowReach;
    const glowLayers = [
      { width: this.domeOutlineWidth + reach, alpha: 0.06 },
      { width: this.domeOutlineWidth + reach * 0.6, alpha: 0.10 },
      { width: this.domeOutlineWidth + reach * 0.3, alpha: 0.16 }
    ];
    for (const layer of glowLayers) {
      ctx.lineWidth = layer.width;
      ctx.strokeStyle = `rgba(${this.domeGlowColor}, ${layer.alpha * this.domeGlowIntensity})`;
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, this.domeRadiusX, this.domeRadiusY, 0, Math.PI, Math.PI * 2);
    ctx.lineWidth = this.domeOutlineWidth;
    ctx.strokeStyle = this.domeOutlineColor;
    ctx.stroke();
    ctx.restore();

    return { canvas, anchorX: cx / width, anchorY: cy / height };
  }

  // Split into an OUTER container (carries the ellipse mask) and an
  // INNER container (holds the raw TilingSprite, nothing else). Any
  // filter meant to distort the hex pattern itself — the bulge, for
  // instance — belongs on the INNER container specifically, not on
  // the one returned as .container. This ordering matters: a Filter
  // renders its own target (everything inside it, including any mask
  // already applied within that same subtree) to an offscreen texture
  // FIRST, then distorts that texture. Masking the sprite directly,
  // inside the same container a filter is applied to, bakes a sharp
  // clipped edge into that texture before the distortion runs — so
  // the distortion warps the mask's own boundary right along with the
  // content, and the hex pattern's edge stops lining up with the
  // dome's true (undistorted) edge, defined separately by the front/
  // tint/outline sprites. Keeping the mask OUTSIDE the filtered
  // subtree means: distort the raw pattern first, then clip the
  // distorted result to the true, undistorted ellipse boundary as a
  // separate step — the filter and the mask each do their own job
  // without fighting each other.
  createHexGridSprite(hexCanvas) {
    const container = new Container();       // outer — carries the mask only
    const innerContainer = new Container();   // inner — holds the raw sprite; apply filters HERE

    const texture = Texture.from(hexCanvas);
    if (texture.source) {
      texture.source.addressMode = 'repeat';
      texture.source.scaleMode = 'nearest';
    }

    const sprite = new TilingSprite({
      texture,
      width: this.domeRadiusX * 2,
      height: this.domeRadiusY,
    });
    sprite.anchor.set(0.5, 1);

    innerContainer.addChild(sprite);

    const mask = new Graphics()
      .ellipse(0, 0, this.domeRadiusX, this.domeRadiusY)
      .fill(0xffffff);
    container.addChild(innerContainer, mask);
    container.mask = mask;

    return { container, sprite, innerContainer };
  }

  updateHexGridSprite(entry, anchorX, anchorY, scrollSpeed) {
    entry.container.position.set(anchorX, anchorY);
    const tileW = entry.sprite.texture.width;
    entry.sprite.tilePosition.x = -(((Date.now() * scrollSpeed) % tileW) + tileW) % tileW;
  }

  createForegroundFadeOverlay() {
    const fullWidth = Math.ceil(this.domeRadiusX * 2);
    const fullHeight = Math.ceil(this.domeRadiusY);

    const canvas = document.createElement('canvas');
    canvas.width = fullWidth;
    canvas.height = fullHeight;
    const ctx = canvas.getContext('2d');

    const cx = fullWidth / 2;
    const cy = fullHeight;
    const radius = Math.max(this.domeRadiusX, this.domeRadiusY) * 1.05;

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    grad.addColorStop(0.00, 'rgba(0,0,0,0)');
    grad.addColorStop(0.45, this.domeFillColor.replace(/[\d.]+\)$/, '0.15)'));
    grad.addColorStop(0.75, this.domeFillColor.replace(/[\d.]+\)$/, '0.45)'));
    grad.addColorStop(1.00, this.domeFillColor.replace(/[\d.]+\)$/, '0.70)'));

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, fullWidth, fullHeight);

    const container = new Container();
    const sprite = new Sprite(Texture.from(canvas));
    sprite.anchor.set(0.5, 1);

    const mask = new Graphics()
      .ellipse(0, 0, this.domeRadiusX, this.domeRadiusY)
      .fill(0xffffff);
    sprite.mask = mask;

    container.addChild(sprite, mask);
    return container;
  }

  createMetalBaseTexture() {
    const padding = 4;
    const baseRadiusX = this.halfWidth;
    const baseRadiusY = this.baseRadiusY;
    const width = baseRadiusX * 2 + padding * 2;
    const height = baseRadiusY + padding * 2;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    const cx = width / 2;
    const cy = padding;

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, baseRadiusX, baseRadiusY, 0, 0, Math.PI);
    ctx.closePath();

    const grad = ctx.createLinearGradient(cx, cy, cx, cy + baseRadiusY);
    grad.addColorStop(0, '#8a8a92');
    grad.addColorStop(0.5, '#333338');
    grad.addColorStop(1, '#050506');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, baseRadiusX, baseRadiusY, 0, 0, Math.PI);
    ctx.closePath();
    ctx.clip();
    const glowLayers = [
      { inset: 0, alpha: 0.12 },
      { inset: baseRadiusY * 0.15, alpha: 0.08 },
      { inset: baseRadiusY * 0.3, alpha: 0.04 }
    ];
    for (const layer of glowLayers) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, baseRadiusX - layer.inset, baseRadiusY - layer.inset, 0, 0, Math.PI);
      ctx.lineWidth = baseRadiusY * 0.2;
      ctx.strokeStyle = `rgba(${this.baseGlowColor}, ${layer.alpha})`;
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, baseRadiusX, baseRadiusY, 0, 0, Math.PI);
    ctx.closePath();
    ctx.clip();
    const highlightOffset = 2;
    ctx.lineWidth = 2;
    for (let i = 1; i <= this.baseHorizontalLineCount; i++) {
      const t = i / (this.baseHorizontalLineCount + 1);
      const lineY = cy + baseRadiusY * t;

      ctx.strokeStyle = `rgba(${this.baseHighlightColor}, 0.15)`;
      ctx.beginPath();
      ctx.moveTo(cx - baseRadiusX, lineY - highlightOffset);
      ctx.lineTo(cx + baseRadiusX, lineY - highlightOffset);
      ctx.stroke();

      ctx.strokeStyle = `rgba(${this.baseLineColor}, 0.5)`;
      ctx.beginPath();
      ctx.moveTo(cx - baseRadiusX, lineY);
      ctx.lineTo(cx + baseRadiusX, lineY);
      ctx.stroke();
    }

    const bottomY = cy + baseRadiusY;
    for (let i = 1; i < this.baseSeamCount; i++) {
      const t = i / this.baseSeamCount;
      const startX = cx - baseRadiusX + t * (baseRadiusX * 2);
      const endX = cx + (startX - cx) * (1 - this.baseSeamConvergence);
      const controlY = cy + baseRadiusY * 0.6;

      ctx.strokeStyle = `rgba(${this.baseHighlightColor}, 0.12)`;
      ctx.beginPath();
      ctx.moveTo(startX + highlightOffset, cy);
      ctx.quadraticCurveTo(startX + highlightOffset, controlY, endX + highlightOffset, bottomY);
      ctx.stroke();

      ctx.strokeStyle = `rgba(${this.baseLineColor}, 0.4)`;
      ctx.beginPath();
      ctx.moveTo(startX, cy);
      ctx.quadraticCurveTo(startX, controlY, endX, bottomY);
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, baseRadiusX, baseRadiusY, 0, 0, Math.PI);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#1e1e20';
    ctx.stroke();
    ctx.restore();

    return { canvas, anchorX: cx / width, anchorY: cy / height };
  }

  createGrassTexture() {
    const grassImg = state.grassTexture;
    if (!grassImg || !grassImg.complete) return null;

    const scale = 2;
    const tileW = 32 * scale;
    const fullWidth = this.halfWidth * 2;
    const seamOverlap = 2;
    const drawHeight = this.grassHeight + seamOverlap;

    const canvas = document.createElement('canvas');
    canvas.width = fullWidth;
    canvas.height = drawHeight;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    for (let x = 0; x < fullWidth; x += tileW) {
      ctx.drawImage(grassImg, x, 0, tileW, drawHeight);
    }
    return canvas;
  }

  createPixiSprites(layer) {
    if (this.pixiDomeBackSprite) return;
    if (!this.hexGridCanvas || !this.hexGridForegroundCanvas) return;

    const backBaked = this.createDomeBackTexture();
    this.pixiDomeBackSprite = new Sprite(Texture.from(backBaked.canvas));
    this.pixiDomeBackSprite.anchor.set(backBaked.anchorX, backBaked.anchorY);

    const hexEntry = this.createHexGridSprite(this.hexGridCanvas);
    this.pixiHexGridBg = hexEntry.container;
    this.pixiHexGridBgSprite = hexEntry.sprite;

    const frontBaked = this.createDomeFrontTexture();
    this.pixiDomeFrontSprite = new Sprite(Texture.from(frontBaked.canvas));
    this.pixiDomeFrontSprite.anchor.set(frontBaked.anchorX, frontBaked.anchorY);

    const baseBaked = this.createMetalBaseTexture();
    this.pixiMetalBaseSprite = new Sprite(Texture.from(baseBaked.canvas));
    this.pixiMetalBaseSprite.anchor.set(baseBaked.anchorX, baseBaked.anchorY);

    layer.addChild(
      this.pixiDomeBackSprite,
      this.pixiHexGridBg,
      this.pixiDomeFrontSprite,
      this.pixiMetalBaseSprite
    );

    super.createPixiSprites(layer);
  }

  updatePixiSprites(layer) {
    if (!this.pixiDomeBackSprite) this.createPixiSprites(layer);
    if (!this.pixiDomeBackSprite) return;

    super.updatePixiSprites(layer);

    this.pixiDomeBackSprite.position.set(this.pos.x, this.domeAnchorY);
    this.pixiDomeFrontSprite.position.set(this.pos.x, this.domeAnchorY);
    this.pixiMetalBaseSprite.position.set(this.pos.x, this.domeAnchorY);

    this.updateHexGridSprite(
      { container: this.pixiHexGridBg, sprite: this.pixiHexGridBgSprite },
      this.pos.x, this.domeAnchorY,
      this.domeHexScrollSpeed
    );

    if (!this.pixiGrassSprite) {
      const grassCanvas = this.createGrassTexture();
      if (grassCanvas) {
        this.pixiGrassSprite = new Sprite(Texture.from(grassCanvas));
        this.pixiGrassSprite.anchor.set(0, 0);
        layer.addChild(this.pixiGrassSprite);
      }
    }
    if (this.pixiGrassSprite) {
      this.pixiGrassSprite.position.set(this.pos.x - this.halfWidth, this.trueSurfaceY);
    }
  }

  destroyPixiSprite() {
    this.pixiDomeBackSprite?.destroy({ texture: true, textureSource: true });
    this.pixiDomeBackSprite = null;
    this.pixiDomeFrontSprite?.destroy({ texture: true, textureSource: true });
    this.pixiDomeFrontSprite = null;

    // pixiHexGridBg/Fg is the OUTER container from createHexGridSprite
    // — children:true recursively cascades this destroy call through
    // innerContainer's own children (the sprite and its texture) and
    // the mask, confirmed directly against Pixi's actual
    // Container.destroy() source (recursively re-applies the same
    // options to each child, including nested containers).
    this.pixiHexGridBg?.destroy({ children: true, texture: true, textureSource: true });
    this.pixiHexGridBg = null;
    this.pixiHexGridBgSprite = null;

    this.pixiMetalBaseSprite?.destroy({ texture: true, textureSource: true });
    this.pixiMetalBaseSprite = null;
    this.pixiGrassSprite?.destroy({ texture: true, textureSource: true });
    this.pixiGrassSprite = null;

    this.pixiForegroundTintSprite?.destroy({ texture: true, textureSource: true });
    this.pixiForegroundTintSprite = null;
    this.pixiHexGridFg?.destroy({ children: true, texture: true, textureSource: true });
    this.pixiHexGridFg = null;
    this.pixiHexGridFgSprite = null;
    this.pixiHexFadeOverlay?.destroy({ children: true, texture: true, textureSource: true });
    this.pixiHexFadeOverlay = null;
    this.pixiForegroundOutlineSprite?.destroy({ texture: true, textureSource: true });
    this.pixiForegroundOutlineSprite = null;

    this.pixiForegroundContainer?.destroy({ children: true });
    this.pixiForegroundContainer = null;
    this.shockwaveFilter = null;

    super.destroyPixiSprite();
  }

  createForegroundTintTexture() {
    const { width, height, cx, cy } = this.domeBakeGeometry();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, this.domeRadiusX, this.domeRadiusY, 0, Math.PI, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.fillStyle = this.domeFillColor;
    ctx.fillRect(cx - this.domeRadiusX, cy - this.domeRadiusY, this.domeRadiusX * 2, this.domeRadiusY * 2);
    ctx.restore();

    ctx.globalCompositeOperation = 'destination-in';
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(this.domeRadiusX, this.domeRadiusY) * 1.05);
    grad.addColorStop(0.00, 'rgba(0,0,0,0.60)');
    grad.addColorStop(0.50, 'rgba(0,0,0,0.75)');
    grad.addColorStop(1.00, 'rgba(0,0,0,1.00)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'source-over';

    return { canvas, anchorX: cx / width, anchorY: cy / height };
  }

  createForegroundOutlineTexture() {
    const { width, height, cx, cy } = this.domeBakeGeometry();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, this.domeRadiusX, this.domeRadiusY, 0, Math.PI, Math.PI * 2);
    ctx.lineWidth = this.domeOutlineWidth;
    ctx.strokeStyle = this.domeOutlineColor;
    ctx.stroke();
    ctx.restore();

    return { canvas, anchorX: cx / width, anchorY: cy / height };
  }

  createForegroundPixiSprites(layer) {
    if (this.pixiForegroundTintSprite) return;
    if (!this.hexGridForegroundCanvas) return;

    // Tint
    const tintBaked = this.createForegroundTintTexture();
    this.pixiForegroundTintSprite = new Sprite(Texture.from(tintBaked.canvas));
    this.pixiForegroundTintSprite.anchor.set(tintBaked.anchorX, tintBaked.anchorY);

    // Un-faded hex grid
    const hexEntry = this.createHexGridSprite(this.hexGridForegroundCanvas);
    this.pixiHexGridFg = hexEntry.container;
    this.pixiHexGridFgSprite = hexEntry.sprite;
    this.pixiHexGridFgInner = hexEntry.innerContainer;

    // Radial fade overlay
    this.pixiHexFadeOverlay = this.createForegroundFadeOverlay();

    // Outline
    const outlineBaked = this.createForegroundOutlineTexture();
    this.pixiForegroundOutlineSprite = new Sprite(Texture.from(outlineBaked.canvas));
    this.pixiForegroundOutlineSprite.anchor.set(outlineBaked.anchorX, outlineBaked.anchorY);

    // Group everything that should receive the shockwave
    this.pixiForegroundContainer = new Container();
    this.pixiForegroundContainer.addChild(
      this.pixiForegroundTintSprite,
      this.pixiHexGridFg,
      this.pixiHexFadeOverlay,
      this.pixiForegroundOutlineSprite
    );

    // 1. BulgePinch – makes the hex pattern look like it's on a curved
    // surface. Applied to pixiHexGridFgInner (the hex grid's own INNER
    // container, holding just the raw sprite) rather than
    // pixiHexGridFg (the outer container that carries the ellipse
    // mask) — see createHexGridSprite's own comment for exactly why
    // that ordering matters: this way the bulge distorts the pattern
    // FIRST, and the mask clips the already-distorted result to the
    // true, undistorted dome edge SECOND, instead of the distortion
    // warping the clip boundary itself.
    //
    // BulgePinchFilter's own center is documented, verbatim in its
    // real source, as "normalized SCREEN coords" — not normalized to
    // the sprite's own fixed local bounds. Its uDimensions uniform
    // comes directly from the filtered region's own actually-rendered
    // pixel frame, confirmed in the filter's own apply() method
    // (input.frame.width/height) — which, left to Pixi's automatic
    // bounds computation, reflects whatever's currently VISIBLE on
    // screen, not the dome's own true, fixed extent. As the camera
    // follows the player around inside the dome, a different portion
    // of it is visible each time, so "50% across, 80% down THAT
    // shifting region" lands on a different point of the dome every
    // frame — reading as the bulge following the player, exactly the
    // reported symptom. filterArea, confirmed as a real, documented
    // Container property specifically for this ("define a specific
    // area for filter effects"), forces this filter's own render
    // region to always be the sprite's own fixed local bounds instead
    // — the same domeRadiusX*2 x domeRadiusY box the TilingSprite
    // itself is sized to, offset for its own anchor(0.5,1) — so
    // center now always refers to the same, unmoving point ON THE
    // DOME, regardless of where the camera happens to be looking.
    this.bulgeFilter = new BulgePinchFilter({
      center: { x: 0.5, y: 0.8 },   // slightly above the base of the half-ellipse
      // Overwritten every frame in updateForegroundGlassPixi (radius =
      // BASE_BULGE_RADIUS * zoom) — this initial value only matters
      // for the very first frame before that runs, kept consistent
      // with BASE_BULGE_RADIUS below so it isn't a stale, misleading
      // number for anyone reading this later.
      radius: 3200,
      strength: 0.7,                // positive = bulge (good for a dome)
      // The actual remaining cause of "bulge shifts when part of the
      // dome is off-screen" — confirmed directly in Pixi's real
      // FilterSystem source: after filterArea and the container's own
      // world transform are applied to compute this filter's render
      // bounds, there's a SEPARATE clamping step —
      // bounds.fitBounds(0, viewport.width, 0, viewport.height) — that
      // still cuts those bounds down to the visible viewport, but ONLY
      // when clipToViewport is true, which is every filter's own
      // default. filterArea alone fixes this whenever the dome is
      // entirely on-screen (fitBounds is a no-op there, since the
      // bounds already fit) — but whenever part of it extends past the
      // viewport, this clamp still shrinks uDimensions down to just
      // the visible portion, which is exactly what was still moving
      // the bulge's own effective center. Setting this false skips
      // that clamp entirely, so the full, fixed dome extent is always
      // used regardless of how much of it happens to be visible.
      clipToViewport: false
    });
    this.BASE_BULGE_RADIUS = 3200; // read every frame in updateForegroundGlassPixi to keep this scaled with zoom — see that method's own comment for why a flat, unscaled radius covers a different fraction of the dome at different zoom levels

    this.pixiHexGridFgInner.filterArea = new Rectangle(
      -this.domeRadiusX, -this.domeRadiusY,
      this.domeRadiusX * 2, this.domeRadiusY
    );

    this.pixiHexGridFgInner.filters = [this.bulgeFilter];

    // Persistent looping ShockwaveFilter on the FOREGROUND
    this.shockwaveFilter = new ShockwaveFilter({
      amplitude: 3,
      wavelength: 150,
      speed: 300,
      brightness: 1,
      radius: Math.max(this.domeRadiusX, this.domeRadiusY) * 1.5,
      center: { x: this.domeRadiusX/2, y: this.domeRadiusY/4 }
    });

    this.shockwaveFilter2 = new ShockwaveFilter({
      amplitude: 3,
      wavelength: 150,
      speed: 300,
      brightness: 1,
      radius: Math.max(this.domeRadiusX, this.domeRadiusY) * 1.5,
      center: { x: this.domeRadiusX/4, y: this.domeRadiusY/4 }
    });

    this.pixiForegroundContainer.filters = [this.shockwaveFilter, this.shockwaveFilter2];

    layer.addChild(this.pixiForegroundContainer);
  }

  updateForegroundGlassPixi(layer) {
    if (!this.pixiForegroundTintSprite) this.createForegroundPixiSprites(layer);
    if (!this.pixiForegroundTintSprite) return;

    const zoom = state.zoom || 1;
    const zoomMin = state.zoomMin ?? 0.5;
    const zoomRef = this.domeForegroundZoomReference;
    const zoomT = zoomRef > zoomMin ? (zoom - zoomMin) / (zoomRef - zoomMin) : 0;
    const clampedT = Math.max(0, Math.min(1, zoomT));
    const zoomFactor = this.domeForegroundZoomFloor + (1 - this.domeForegroundZoomFloor) * (1 - clampedT);

    const isVisible = zoomFactor > 0.001;
    this.pixiForegroundContainer.visible = isVisible;

    if (!isVisible) return;

    // Position the individual pieces (they live inside the container)
    this.pixiForegroundTintSprite.position.set(this.pos.x, this.domeAnchorY);
    this.pixiForegroundTintSprite.alpha = this.domeForegroundTintOpacity * zoomFactor;

    this.updateHexGridSprite(
      { container: this.pixiHexGridFg, sprite: this.pixiHexGridFgSprite },
      this.pos.x, this.domeAnchorY,
      this.domeForegroundHexScrollSpeed
    );
    this.pixiHexGridFg.alpha = zoomFactor;

    this.pixiHexFadeOverlay.position.set(this.pos.x, this.domeAnchorY);
    this.pixiHexFadeOverlay.alpha = zoomFactor;

    this.pixiForegroundOutlineSprite.position.set(this.pos.x, this.domeAnchorY);
    this.pixiForegroundOutlineSprite.alpha = this.domeForegroundOutlineOpacity * zoomFactor;

    // Scales the bulge's own radius with zoom every frame — confirmed
    // directly in BulgePinchFilter's real shader source that uRadius
    // is compared as a raw, unnormalized value against distances
    // computed in the filtered region's own actually-rendered pixel
    // space (uDimensions/uInputSize), not scaled by anything else in
    // the shader itself. Since the dome's own on-screen pixel size
    // scales directly with zoom (worldContainer.scale.set(zoom)
    // affects everything inside it, this dome included), a flat,
    // unscaled radius covers a different FRACTION of the dome at
    // different zoom levels — matching the reported "covers the whole
    // dome at some zooms, only part of it at others." Multiplying by
    // zoom is the more intuitive direction (more on-screen pixels at
    // higher zoom should need a proportionally larger radius to cover
    // the same fraction of the dome) but I want to be honest this is
    // a reasoned attempt based on the verified shader math, not
    // something I could confirm by actually rendering it — if it
    // turns out backwards in practice, dividing by zoom instead of
    // multiplying is the first thing to try.
    if (this.bulgeFilter) {
      this.bulgeFilter.radius = this.BASE_BULGE_RADIUS * zoom;
    }

    // Advance and loop the shockwave
    if (this.shockwaveFilter) {
      this.shockwaveFilter.time += 0.016;
      if (this.shockwaveFilter.time > 2.5) {
        this.shockwaveFilter.time = 0;
      }
    }

    if (this.shockwaveFilter2) {
      this.shockwaveFilter2.time += 0.016;
      if (this.shockwaveFilter2.time > 2) {
        this.shockwaveFilter2.time = 0;
      }
    }
  }

  drawForegroundGlass() {
    const ctx = state.ctx;
    const cx = this.pos.x;
    const cy = this.domeAnchorY;

    const zoom = state.zoom || 1;
    const zoomMin = state.zoomMin ?? 0.5;
    const zoomRef = this.domeForegroundZoomReference;
    const zoomT = zoomRef > zoomMin ? (zoom - zoomMin) / (zoomRef - zoomMin) : 0;
    const clampedT = Math.max(0, Math.min(1, zoomT));
    const zoomFactor = this.domeForegroundZoomFloor + (1 - this.domeForegroundZoomFloor) * (1 - clampedT);

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, this.domeRadiusX, this.domeRadiusY, 0, Math.PI, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.globalAlpha = this.domeForegroundTintOpacity * zoomFactor;
    ctx.fillStyle = this.domeFillColor;
    ctx.fillRect(cx - this.domeRadiusX, cy - this.domeRadiusY, this.domeRadiusX * 2, this.domeRadiusY * 2);
    ctx.restore();

    ctx.globalAlpha = zoomFactor;
    this.drawScrollingHexTile(
      ctx, cx, cy,
      cx - this.domeRadiusX, cy - this.domeRadiusY, this.domeRadiusX * 2,
      this.hexGridForegroundCanvas, this.hexGridForegroundTileW, this.hexGridForegroundTileH,
      this.domeForegroundHexScrollSpeed
    );
    ctx.globalAlpha = 1;

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, this.domeRadiusX, this.domeRadiusY, 0, Math.PI, Math.PI * 2);
    ctx.globalAlpha = this.domeForegroundOutlineOpacity * zoomFactor;
    ctx.lineWidth = this.domeOutlineWidth;
    ctx.strokeStyle = this.domeOutlineColor;
    ctx.stroke();
    ctx.restore();
  }
}