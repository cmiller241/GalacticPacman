// js/world/SkyDomePlanetoid.js
import { state } from '../state.js';
import { Vector2 } from '../vector2.js';
import { RoundedRectPlanetoid } from './RoundedRectPlanetoid.js';
import { Sprite, Texture, Graphics, Container } from 'pixi.js';

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
    const halfHeight = options.halfHeight ?? 32;    // full height 64 = 2x the ground tile's 32px, for pixel-perfect scaling (see drawBodyTexture below)
    const cornerRadius = options.cornerRadius ?? 0;
    const color = options.color ?? '#5c8a4a'; // grassy green ground, distinct from the original rect planet's tan

    super(x, y, halfWidth, halfHeight, cornerRadius, color);

    // Grass sits ABOVE the metal base's own top edge and becomes the
    // TRUE walking/gravity/landing surface — rather than updating every
    // individual consumer of "where's the surface" (Player.js's
    // walking code, CollisionSystem's landing check, game.js's
    // JumpPlatform pillar height), this single adjustment covers all
    // of them at once: they all ultimately derive their reference from
    // this.halfHeight, so growing it by the grass layer's own
    // thickness automatically pushes the true surface up to the top of
    // the grass everywhere. The metal base (drawMetalBase,
    // nearestBaseSurfacePoint) is the one thing that needs to actively
    // COMPENSATE for this, since it should stay anchored exactly where
    // it always was, not drift upward along with everything else.
    this.grassHeight = options.grassHeight ?? 32; // matches drawGrassCap's own rendered tile height (16px source * 2x scale)
    this.halfHeight += this.grassHeight;

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

    // Exempts this from RoundedRectPlanetoid's live directional
    // sun-shading pass — that effect simulates lighting on a rocky,
    // roughly spherical-reading surface, which doesn't suit a flat
    // grass tile, and it would only ever hit this ground body, never
    // JumpPlatform's separately-baked pillar underneath it, causing a
    // visible brightness mismatch between the two.
    this.noSunShading = true;

    // (gravity window is now bounded by the dome shell itself — see
    // isWithinGravityWindow below — rather than a fixed height above
    // the ground.)

    // Dome — a shallow semi-ellipse (deliberately NOT a true
    // semicircle, which would be disproportionately tall relative to
    // a long, thin strip), sized relative to the platform itself, its
    // flat base sitting right at the platform's top surface.
    this.domeRadiusX = options.domeRadiusX ?? halfWidth; // matches the platform's own width exactly, so the dome's base diameter lines up with the platform's edges rather than overhanging them
    this.domeRadiusY = options.domeRadiusY ?? halfWidth;
    // Metal base's own vertical radius — a SIXTH of the dome's height.
    // Stored once here rather than recomputed separately in
    // drawMetalBase/nearestBaseSurfacePoint, so the visible shape and
    // the actual collision shape can never drift out of sync with
    // each other.
    this.baseRadiusY = options.baseRadiusY ?? this.domeRadiusY / 6;
    // Panel detailing on the metal base — a rim glow (tinted toward
    // the dome's own light, suggesting reflected glass-light on the
    // metal), horizontal panel-seam lines, and curved seams converging
    // toward the base's own bottom-center point (like longitude lines
    // on a globe). Deliberately no small indicator lights here, per
    // explicit feedback.
    this.baseGlowColor = options.baseGlowColor ?? '180, 210, 255';
    this.baseLineColor = options.baseLineColor ?? '10, 10, 12';
    this.baseHorizontalLineCount = options.baseHorizontalLineCount ?? 3;
    this.baseSeamCount = options.baseSeamCount ?? 6;
    // Subtle light edge highlight — above each horizontal line, right
    // of each curved seam — simulating a raised panel edge catching
    // light, alongside the existing dark seam line itself.
    this.baseHighlightColor = options.baseHighlightColor ?? '210, 220, 235';
    // How far the seams converge toward center by the bottom, as a
    // fraction of their starting distance from center — 1 = fully
    // converge to a single point (the original look), lower values
    // spread the endpoints out instead of all meeting at one spot.
    this.baseSeamConvergence = options.baseSeamConvergence ?? 0.35;
    this.domeFillColor = options.domeFillColor ?? 'rgba(130, 196, 255, 0.9)'; // 25% more saturated than the original (141,195,244), via HSL conversion
    this.domeRimColor = options.domeRimColor ?? 'rgba(75, 150, 225, 0.85)'; // deeper blue at the rim, for the glass-gradient effect below — also 25% more saturated than the original (90,150,210)
    this.domeOutlineColor = options.domeOutlineColor ?? '#ffffff';
    this.domeOutlineWidth = options.domeOutlineWidth ?? 3;
    // How much extra transparency fades in toward the dome's base,
    // via drawDome()'s second gradient pass — 0 = no fade (matches the
    // old single-gradient look), 1 = fully transparent at the very
    // bottom edge. Applied ON TOP of the glass gradient's own alpha,
    // not a replacement for it.
    this.domeBottomFade = options.domeBottomFade ?? 0.45;

    // Outer glow — bleeds OUTWARD from the outline into the
    // surrounding space, rather than the crisp line just stopping
    // abruptly at a hard edge.
    this.domeGlowColor = options.domeGlowColor ?? '255,255,255'; // RGB components only (no alpha) — reused at varying alpha across the layered glow strokes below
    this.domeGlowReach = options.domeGlowReach ?? 30; // how far, in world units, the glow extends beyond the outline
    this.domeGlowIntensity = options.domeGlowIntensity ?? 1; // multiplier on the glow layers' base alpha, for easy overall brightness tuning

    // Subtle inner glow — same layered-stroke idea as the outer glow,
    // but clipped to the dome's INTERIOR and traced along ellipses
    // inset from the true boundary, so it reads as energy gathering
    // near the inside of the shield rather than bleeding into space.
    // Reuses domeGlowColor/domeGlowIntensity above rather than adding
    // yet another pair of color/intensity properties, since "subtle
    // inner glow" reads as the same energy, not a separately-tinted one.
    this.domeInnerGlowReach = options.domeInnerGlowReach ?? 40; // how far inward, in world units, the inner glow extends from the edge

    // Hex grid overlay — a small repeating tile baked ONCE (see
    // createOffscreen below) and tiled across the dome at draw time
    // with a slowly-shifting offset, rather than re-stroking ~800+
    // individual hexagons freshly every frame — still cheap regardless
    // of the scroll animation, since it's just a handful of image
    // blits either way.
    this.domeHexSize = options.domeHexSize ?? 60; // hexagon "radius," center to vertex
    this.domeHexColor = options.domeHexColor ?? '255,255,255';
    this.domeHexOpacity = options.domeHexOpacity ?? 0.12; // "very transparent," per the brief
    // World units per millisecond the background grid drifts —
    // positive drifts LEFT (see drawScrollingHexTile's own comment for
    // why positive means left). Small and slow on purpose.
    this.domeHexScrollSpeed = options.domeHexScrollSpeed ?? 0.006;
    this.domeHexLineWidth = options.domeHexLineWidth ?? 1;

    // Foreground pass gets its OWN, larger hex grid — bigger hexagons
    // read as closer to the camera (the near surface of the glass,
    // between the player and the viewer), the same reasoning behind
    // drawForegroundGlass being a separate, later-drawn pass at all.
    // Defaults scale off domeHexSize/domeHexOpacity rather than being
    // independent fixed numbers, so they stay proportional if the
    // background grid is ever retuned.
    this.domeForegroundHexSize = options.domeForegroundHexSize ?? this.domeHexSize * 1.8;
    this.domeForegroundHexOpacity = options.domeForegroundHexOpacity ?? Math.min(1, this.domeHexOpacity * 2.5); // clearer/less transparent than the background grid, per the brief — a multiplier rather than an independent fixed value, so it stays proportional if the background's opacity is ever retuned
    // Negative — the opposite sign of domeHexScrollSpeed — so the
    // foreground drifts RIGHT while the background drifts left, per
    // the brief.
    this.domeForegroundHexScrollSpeed = options.domeForegroundHexScrollSpeed ?? -0.01;
    this.domeForegroundHexLineWidth = options.domeForegroundHexLineWidth ?? 1.5;

    // Foreground pass's tint/outline opacity — pulled out as proper
    // tunables since these get adjusted often while dialing in the
    // look (this replaces what used to be hardcoded 0.12/0.4 values
    // directly in drawForegroundGlass). Default tint now matches the
    // 0.4 already in use.
    this.domeForegroundTintOpacity = options.domeForegroundTintOpacity ?? 0.8;
    this.domeForegroundOutlineOpacity = options.domeForegroundOutlineOpacity ?? 0.2;

    // How much the ENTIRE foreground pass (tint, hex grid, outline —
    // all together) scales with current camera zoom. Zoomed IN, less
    // of it shows (as if you've moved past the near glass, closer to
    // the subject); zoomed OUT, more of it reads (as if the glass
    // between a more distant camera and the scene is more apparent).
    //
    // domeForegroundZoomReference is the zoom level at which visibility
    // reaches domeForegroundZoomFloor — below it (zoomed out further),
    // visibility ramps up toward full; AT or BEYOND it (zoomed in this
    // much or more), visibility stays pinned at the floor rather than
    // continuing to change. Defaults to 1.0, so the foreground is
    // fully invisible (floor = 0) at normal/default zoom and anything
    // more zoomed in than that, only becoming apparent as you zoom OUT
    // past 1.0 toward zoomMin.
    this.domeForegroundZoomReference = options.domeForegroundZoomReference ?? 1.0;
    this.domeForegroundZoomFloor = options.domeForegroundZoomFloor ?? 0;
    this.hexGridCanvas = null;
    this.hexGridForegroundCanvas = null;

    // Forcefield impact reaction — whole-dome brightness pulse plus a
    // flat expanding ring and a few sparks right at the contact point.
    // Triggered externally via triggerShieldImpact(), called from
    // CollisionSystem.js whenever a planetoid bounces off or an
    // asteroid breaks against the DOME shell specifically (not the
    // platform body — a glass forcefield reacting makes sense, plain
    // ground reacting doesn't). Everything here is computed from
    // elapsed real time in drawDome() below, same pattern PullBeam/
    // FireBar already use — no separate per-frame update() call
    // needed anywhere.
    this.lastImpactTime = 0;
    this.shieldRipples = []; // {x, y, spawnTime, intensity}
    this.shieldSparks = [];  // {x, y, vx, vy, spawnTime} — vx/vy in world units per MILLISECOND, not per frame, so position can be computed directly from elapsed time with no frame-rate assumption
  }

  // Called from CollisionSystem.js. intensity is a rough 0-1 scale
  // (typically impactor radius / some reasonable max) — bigger objects
  // produce a slightly bigger ripple and more sparks, not a
  // fundamentally different effect.
  triggerShieldImpact(worldX, worldY, intensity = 1) {
    this.lastImpactTime = Date.now();
    this.shieldRipples.push({ x: worldX, y: worldY, spawnTime: this.lastImpactTime, intensity });

    const sparkCount = Math.round(4 + intensity * 6);
    for (let i = 0; i < sparkCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.06 + Math.random() * 0.12; // world units/ms
      this.shieldSparks.push({
        x: worldX,
        y: worldY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        spawnTime: this.lastImpactTime
      });
    }
  }

  // The TRUE walking/gravity/landing surface — the top of the grass.
  // This is what this.halfHeight already measures out to (see the
  // constructor's own comment on why it was grown by grassHeight), so
  // this getter exists purely so every call site can read intent
  // directly ("the true surface") instead of re-deriving
  // `this.pos.y - this.halfHeight` from memory each time, which used
  // to be spread across half a dozen methods with no way to tell at a
  // glance whether a given one had (correctly, or incorrectly)
  // remembered to add grassHeight back on top.
  get trueSurfaceY() {
    return this.pos.y - this.halfHeight;
  }

  // The dome/metal-base's shared ORIGINAL anchor position — where the
  // dome's own shell and the metal base's own top edge both live,
  // unmoved from before the grass layer was introduced. Everything
  // that needs to stay anchored at the pre-grass position (the dome's
  // visible shape and collision shell, the metal base's visible shape
  // and collision shell) reads this getter; everything that needs the
  // NEW, grass-adjusted surface (gravity gate, walking, the grass cap
  // itself) reads trueSurfaceY above instead. Having both as named
  // getters is what makes that distinction legible at each call site,
  // rather than a bare `+ this.grassHeight` whose presence or absence
  // was easy to get wrong when duplicated by hand across methods.
  get domeAnchorY() {
    return this.trueSurfaceY + this.grassHeight;
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
  // Overrides the inherited rocky-texture-plus-tint body with the
  // ground.png tile (32x32) instead, repeated pixel-perfectly across
  // the platform's width only — no vertical tiling, since the tile's
  // own 32px height is scaled to match the platform's FULL height
  // exactly (which is why the constructor defaults halfHeight to a
  // clean multiple of 32 — that's what keeps this scale factor a whole
  // number). imageSmoothingEnabled = false is what actually makes this
  // "pixel perfect": with a non-integer scale, the browser would
  // interpolate/blur the source pixels when stretching; with a whole-
  // number scale and smoothing off, each source pixel becomes a clean
  // NxN block with no blur at all.
  // Intentionally empty. This used to tile the grass ground.png tile
  // across the platform's rectangle; that's now replaced entirely by
  // the metal half-ellipse base (see drawMetalBase below). The
  // underlying halfWidth/halfHeight rectangle still exists and is
  // still exactly what all collision/gravity/landing/walking physics
  // uses — it's simply no longer drawn, the same relationship the
  // dome's own gravity-window rectangle already has with the visible
  // glass ellipse above it (a real collision concept with no matching
  // visible rectangle of its own).
  drawBodyTexture(bodyCtx, w, h) {}

  // Bottom half-ellipse "base" — dark gray metal, replacing the old
  // rectangular grass-tiled ground body. Mirrors the dome's own shape
  // (a matching ellipse, curved DOWNWARD instead of upward), its flat
  // top sitting at the same reference line the dome's own flat base
  // sits at, sized via baseRadiusY (a sixth of the dome's own height).
  // Now has REAL matching collision too — see nearestBaseSurfacePoint
  // below, used by CollisionSystem the same way nearestDomeSurfacePoint
  // is for the dome's own shell.
  drawMetalBase() {
    const ctx = state.ctx;
    const cx = this.pos.x;
    const cy = this.domeAnchorY; // stays anchored at the ORIGINAL, pre-grass position — see nearestBaseSurfacePoint's identical comment
    const baseRadiusX = this.halfWidth;
    const baseRadiusY = this.baseRadiusY;

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, baseRadiusX, baseRadiusY, 0, 0, Math.PI); // LOWER half (right -> bottom -> left)
    ctx.closePath(); // needed for fill's shape to be correct — unlike the outline stroke below, closing a fill path is harmless

    const grad = ctx.createLinearGradient(cx, cy, cx, cy + baseRadiusY);
    grad.addColorStop(0, '#8a8a92');   // brighter highlight than before, for more contrast
    grad.addColorStop(0.5, '#333338'); // dark gray
    grad.addColorStop(1, '#050506');   // near-pure black toward the underside

    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();

    // Inner glow near the top rim, where the metal meets the grass/
    // dome above — same layered-inset-stroke technique as the dome's
    // own inner glow, tinted toward the dome's light color so it reads
    // as reflected glass-light rather than an unrelated color.
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

    // Horizontal panel-seam lines — plain straight strokes, clipped to
    // the ellipse so they naturally narrow with its curve at each
    // depth rather than needing their own width calculation. Each dark
    // line gets a subtle light highlight just above it, simulating a
    // raised panel edge catching light.
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

    // Curved seams — evenly-spaced starting points along the flat top
    // edge, each a quadratic curve whose control point shares the
    // starting X (so it starts moving straight down before bending
    // inward). Deliberately do NOT all converge to the exact same
    // bottom-center point — each seam's endpoint is only pulled toward
    // center by baseSeamConvergence, spreading them out along the
    // bottom instead of meeting at one spot. Each dark seam gets a
    // subtle light highlight just to its right.
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

    // Thin outline for definition. Deliberately NO closePath() here —
    // same reasoning as the dome's own outline (see drawDome's
    // comment): stroke() doesn't auto-close a path, and closing it
    // would draw an unwanted straight line across the flat top edge.
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, baseRadiusX, baseRadiusY, 0, 0, Math.PI);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#1e1e20';
    ctx.stroke();
    ctx.restore();
  }

  // A single row of grass.png (32x16, scaled 2x = 64x32 world units
  // per tile — a fixed 2x, matching the ground tile's own scale,
  // rather than the "derive scale from height" approach used
  // elsewhere, since this is a thin cap layer, not something meant to
  // exactly fill a specific height), tiled horizontally across the
  // platform's full width, extending UPWARD from the flat top line
  // into the dome's own open interior — where the player actually
  // stands — rather than downward into the metal base's own territory.
  // Deliberately NOT clipped to the metal base's ellipse (an earlier
  // version was, which was the actual bug: it made the grass read as
  // sitting on top of / part of the metal structure, instead of being
  // its own distinct ground layer within the dome). A plain
  // rectangular clip is enough here — at this shallow a depth the dome
  // is already at its full width, so there's no curve to worry about
  // clipping against.
  //
  // JumpPlatform's own pillar terminates at this exact same flat line
  // (its groundY option) — the pillar's bottom lands right where this
  // grass layer's own BOTTOM edge is, so the two should still connect
  // correctly with no changes needed there.
  drawGrassCap() {
    const ctx = state.ctx;
    const grassImg = state.grassTexture;
    if (!grassImg || !grassImg.complete) return;

    // trueSurfaceY is exactly the grass layer's own top edge.
    const grassTopY = this.trueSurfaceY;
    const scale = 2;
    const tileW = 32 * scale;
    const fullWidth = this.halfWidth * 2;
    const startX = this.pos.x - this.halfWidth;

    // Mathematically, filling exactly grassHeight lands precisely on
    // the metal base's own compensated top edge (see drawMetalBase/
    // nearestBaseSurfacePoint) with no gap. In practice, canvas's own
    // subpixel rounding when the whole scene is scaled by the current
    // zoom can still leave a hairline seam there at certain zoom
    // levels, even though the two shapes share the exact same
    // coordinate. A small, fixed overlap beyond the true height —
    // extending slightly into the metal base's own territory — costs
    // nothing (grass is drawn AFTER the metal base, so it simply
    // covers this sliver) and reliably eliminates the seam regardless
    // of zoom, rather than depending on exact edge alignment.
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

    const fgTile = this.bakeHexGridTile(this.domeForegroundHexSize, this.domeForegroundHexOpacity, this.domeForegroundHexLineWidth);
    this.hexGridForegroundCanvas = fgTile.canvas;
    this.hexGridForegroundTileW = fgTile.tileW;
    this.hexGridForegroundTileH = fgTile.tileH;
  }

  // Draws one hexagon outline (stroke only, not filled — reads as a
  // grid/panel line, not a solid tile) centered at (cx, cy).
  strokeHexagon(ctx, cx, cy, size) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 6; // pointy-top orientation
      const x = cx + size * Math.cos(angle);
      const y = cy + size * Math.sin(angle);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  }

  // Bakes a SMALL, seamlessly-repeating hex tile — NOT clipped to the
  // dome shape (clipping happens separately at draw time, see
  // drawScrollingHexTile), since this tile needs to tile/repeat across
  // the dome's area with a scrolling offset for the animation. The hex
  // grid pattern has a true period of exactly `hexWidth` horizontally
  // and `2 * hexHeightStep` vertically (two rows, since alternating
  // row offsets need two rows to complete one full cycle) — baking a
  // canvas of EXACTLY that size, with hexagons drawn out to a small
  // margin beyond its edges (so anything crossing a boundary still
  // gets drawn), produces a tile that lines up perfectly with itself
  // when repeated, with no visible seam. Parameterized by hexSize/
  // opacity so this one method bakes both the background grid and the
  // foreground grid's larger hexagons, called twice from
  // createOffscreen, instead of duplicating this logic.
  bakeHexGridTile(hexSize, opacity, lineWidth = 1) {
    const hexWidth = Math.sqrt(3) * hexSize;
    const hexHeightStep = hexSize * 1.5;
    const tileW = hexWidth;
    const tileH = hexHeightStep * 2;

    const canvas = document.createElement('canvas');
    canvas.width = tileW;
    canvas.height = tileH;
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

  // Draws a pre-baked, seamlessly-repeating hex tile across the dome's
  // area with a horizontal scroll offset based on elapsed real time —
  // shared by both the background (drawDome) and foreground
  // (drawForegroundGlass) hex layers, just with different tile
  // canvases/speeds. Still just a handful of cheap image blits per
  // frame regardless of the animation, same as the static version this
  // replaced. Positive scrollSpeed drifts content leftward, negative
  // drifts it rightward (see the two call sites for why each uses the
  // sign it does).
  drawScrollingHexTile(ctx, cx, cy, boxX, boxY, boxW, tileCanvas, tileW, tileH, scrollSpeed) {
    if (!tileCanvas) return;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, this.domeRadiusX, this.domeRadiusY, 0, Math.PI, Math.PI * 2);
    ctx.closePath();
    ctx.clip();

    const scrollOffset = ((Date.now() * scrollSpeed) % tileW + tileW) % tileW; // double-mod keeps this positive regardless of sign/timing
    const startX = boxX - scrollOffset - tileW;
    for (let y = boxY - tileH; y < cy; y += tileH) {
      for (let x = startX; x < boxX + boxW + tileW; x += tileW) {
        ctx.drawImage(tileCanvas, x, y);
      }
    }
    ctx.restore();
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
    if (worldY > this.trueSurfaceY) return false; // never applies below the ground's own surface — approaching from below just flies past, same as before

    // The dome's own shell stays anchored at its ORIGINAL, pre-grass
    // position (domeAnchorY, not trueSurfaceY) — the grass is a floor
    // WITHIN the dome's interior, not something that pushes the dome's
    // own curved shell upward too.
    const nx = (worldX - this.pos.x) / this.domeRadiusX;
    const ny = (worldY - this.domeAnchorY) / this.domeRadiusY;
    return (nx * nx + ny * ny) <= 1;
  }

  // Nearest point on an ellipse to a world point, its true elliptical
  // outward normal, and the distance to it — the shared math behind
  // both nearestDomeSurfacePoint and nearestBaseSurfacePoint below,
  // which used to each carry their own ~25-line copy of this,
  // differing only in which radii they used and which direction their
  // degenerate (dead-center) fallback pushed. Parameterized by center/
  // radii/fallback so both are now just a few lines expressing what's
  // actually different between them, with the math itself living in
  // exactly one place.
  //
  // Uses the standard normalized-space approximation for nearest point
  // on an ellipse (scale into a unit circle, solve there, scale back) —
  // exact when radiusX equals radiusY, and a good approximation
  // otherwise.
  nearestEllipseSurfacePoint(centerX, centerY, radiusX, radiusY, worldX, worldY, fallbackDirY) {
    const lx = worldX - centerX, ly = worldY - centerY;
    const nx = lx / radiusX, ny = ly / radiusY;
    const nDist = Math.sqrt(nx * nx + ny * ny);

    let blx, bly;
    if (nDist < 1e-6) {
      // Degenerate: essentially at the ellipse's own center — push
      // toward fallbackDirY (e.g. -1 = up for the dome, +1 = down for
      // the base) as a reasonable default rather than dividing by
      // (near) zero.
      blx = 0;
      bly = fallbackDirY * radiusY;
    } else {
      blx = (nx / nDist) * radiusX;
      bly = (ny / nDist) * radiusY;
    }

    const boundaryX = centerX + blx, boundaryY = centerY + bly;
    // True elliptical outward normal — gradient of (x/rx)^2+(y/ry)^2=1
    // at the boundary point, not the cruder "point minus center"
    // shortcut (which is only exact for a true circle).
    const normal = new Vector2(blx / (radiusX * radiusX), bly / (radiusY * radiusY)).normalize();

    const dx = worldX - boundaryX, dy = worldY - boundaryY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    return { point: new Vector2(boundaryX, boundaryY), normal, distance };
  }

  // Nearest point on the DOME's curved shell to a world point — a
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
  nearestDomeSurfacePoint(worldX, worldY) {
    // The dome's own shell stays anchored at its ORIGINAL, pre-grass
    // position (domeAnchorY) — same as the metal base (see
    // nearestBaseSurfacePoint's identical comment).
    return this.nearestEllipseSurfacePoint(this.pos.x, this.domeAnchorY, this.domeRadiusX, this.domeRadiusY, worldX, worldY, -1);
  }

  // Same underlying math as nearestDomeSurfacePoint above, mirrored
  // for the metal base's LOWER ellipse instead of the dome's upper
  // one. Used by CollisionSystem.js's handleImmovableCollisions/
  // handlePlanetAsteroidCollisions for anything approaching from
  // BELOW the platform's flat line (mv.pos.y > topY), the same way the
  // dome version is used for anything approaching from above — giving
  // planetoids/asteroids real curved collision against the base's true
  // visible shape instead of the old flat rectangle underneath it.
  nearestBaseSurfacePoint(worldX, worldY) {
    // The metal base's own position needs to stay anchored at
    // domeAnchorY (the ORIGINAL, pre-grass position), not drift upward
    // along with the true walking surface.
    return this.nearestEllipseSurfacePoint(this.pos.x, this.domeAnchorY, this.halfWidth, this.baseRadiusY, worldX, worldY, 1);
  }

  drawDome() {
    const ctx = state.ctx;
    const cx = this.pos.x;
    const cy = this.domeAnchorY; // dome's own visible shape stays anchored at its original, pre-grass position, matching nearestDomeSurfacePoint

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, this.domeRadiusX, this.domeRadiusY, 0, Math.PI, Math.PI * 2);
    ctx.closePath(); // draws the flat bottom edge back to the arc's start
    // Clips BOTH fill passes below to exactly the dome's silhouette —
    // matters most for the second pass, which uses destination-out and
    // would otherwise erase alpha from whatever's drawn beneath it too
    // (the platform body, drawn right after this in draw()).
    ctx.clip();

    const boxX = cx - this.domeRadiusX, boxY = cy - this.domeRadiusY;
    const boxW = this.domeRadiusX * 2, boxH = this.domeRadiusY * 2;

    // Pass 1: glass-like highlight gradient (unchanged) — a bright
    // highlight offset toward the upper area, as if reflecting a light
    // source off curved glass, fading through the base color toward a
    // deeper, more saturated blue at the rim.
    const highlightX = cx - this.domeRadiusX * 0.25;
    const highlightY = cy - this.domeRadiusY * 0.55;
    const outerRadius = Math.max(this.domeRadiusX, this.domeRadiusY) * 1.1;
    const glassGrad = ctx.createRadialGradient(highlightX, highlightY, 0, cx, cy, outerRadius);
    glassGrad.addColorStop(0, 'rgba(255,255,255,0.9)');
    glassGrad.addColorStop(0.25, this.domeFillColor);
    glassGrad.addColorStop(1, this.domeRimColor);
    ctx.fillStyle = glassGrad;
    ctx.fillRect(boxX, boxY, boxW, boxH);

    // Pass 2: top-to-bottom opacity fade, applied via destination-out —
    // this composite mode ERASES alpha from what's already drawn,
    // proportional to the new shape's own alpha at each pixel, rather
    // than drawing new color on top. A gradient from fully transparent
    // (top) to partially opaque black (bottom) therefore leaves the
    // top of the glass gradient above untouched, and fades the bottom
    // out by up to domeBottomFade — "more transparent, but not
    // completely," rather than a hard cutoff.
    ctx.globalCompositeOperation = 'destination-out';
    const fadeGrad = ctx.createLinearGradient(cx, boxY, cx, cy);
    fadeGrad.addColorStop(0, 'rgba(0,0,0,0)');
    fadeGrad.addColorStop(1, `rgba(0,0,0,${this.domeBottomFade})`);
    ctx.fillStyle = fadeGrad;
    ctx.fillRect(boxX, boxY, boxW, boxH);

    ctx.restore(); // undoes both the clip and globalCompositeOperation

    // Subtle inner glow — same layered idea as the outer glow below,
    // but clipped to the dome's INTERIOR and traced along ellipses
    // inset from the true boundary, so it reads as energy gathering
    // near the inside of the shield rather than bleeding into space.
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

    // Hex grid overlay — pre-baked as a small repeating tile (see
    // bakeHexGridTile), tiled across the dome with a slowly-shifting
    // offset for the scroll effect. Still just a handful of cheap
    // image blits per frame regardless of the animation.
    this.drawScrollingHexTile(ctx, cx, cy, boxX, boxY, boxW, this.hexGridCanvas, this.hexGridTileW, this.hexGridTileH, this.domeHexScrollSpeed);

    // Outer glow — bleeds OUTWARD from the outline into the
    // surrounding space, rather than the line just stopping abruptly.
    // Several progressively wider, fainter strokes of the same arc,
    // layered from widest/faintest to narrowest/brightest — same cheap
    // glow technique used elsewhere in this project (FireBar's
    // fireballs, the pull beam) rather than an expensive shadowBlur.
    // Drawn BEHIND the crisp outline stroke below, so the sharp line
    // still reads clearly on top of the soft glow.
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

    // Outline — drawn separately, after restore, so the fade above
    // (and its composite mode) can't affect it; stays crisp and fully
    // opaque regardless of the fill's fade. Deliberately NO closePath()
    // here (unlike the fill/clip paths above, where it's harmless) —
    // stroke() doesn't auto-close a path the way fill()/clip() do, so
    // closing it here would stroke the flat straight line back across
    // the base too, which is exactly the unwanted line at the dome/
    // ground seam this fixes. Leaving the path open means only the
    // curved arc itself gets stroked.
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, this.domeRadiusX, this.domeRadiusY, 0, Math.PI, Math.PI * 2);
    ctx.lineWidth = this.domeOutlineWidth;
    ctx.strokeStyle = this.domeOutlineColor;
    ctx.stroke();
    ctx.restore();

    this.drawShieldImpactEffects(ctx, cx, cy, boxX, boxY, boxW, boxH);
  }

  // Forcefield impact reaction: a brief whole-dome brightness pulse,
  // plus a flat expanding ring and a few drifting sparks at each
  // recent contact point. Deliberately a flat 2D ring rather than a
  // ripple that actually travels along the dome's curved surface —
  // that would need to walk the ellipse's own boundary the way the
  // belt's perimeter-walk does, a meaningfully bigger build for
  // something that happens fast enough it likely wouldn't read
  // differently in practice. Everything here is computed straight from
  // elapsed real time, so no per-frame update() call is needed.
  drawShieldImpactEffects(ctx, cx, cy, boxX, boxY, boxW, boxH) {
    const now = Date.now();

    // Whole-dome pulse — classic "shield just absorbed a hit" flash,
    // clipped to the dome and decaying back to nothing.
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

    // Expanding rings at each recent contact point. Pruned here
    // (rather than needing a separate update pass) since draw() already
    // runs every frame regardless.
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

    // Sparks — position computed directly from elapsed time (spawnX +
    // vx*elapsedMs), not integrated frame-by-frame, since vx/vy are
    // already in world-units-per-millisecond.
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
    this.drawDome(); // background layer, drawn first so the platform body renders on top of it
    this.drawMetalBase();
    this.drawGrassCap();
    super.draw();
  }

  // ----------------------------
  // PIXI RENDERING
  // ----------------------------

  domeBakeGeometry() {
    const padding = this.domeGlowReach + 10;
    const width = this.domeRadiusX * 2 + padding * 2;
    const height = this.domeRadiusY + padding * 2;
    const cx = width / 2;
    const cy = height - padding; // the dome's own flat base line
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

  // Creates a scrolling hex-grid overlay.
  // Uses a persistent full-size canvas that is re-tiled every frame
  // with the current scroll offset (same technique as the original
  // Canvas2D path). This avoids all the TilingSprite / addressMode
  // issues that refused to cooperate.
  createHexGridSprite(hexCanvas, tileW, tileH, fadeCenter = false) {
    const container = new Container();

    const fullWidth = Math.ceil(this.domeRadiusX * 2);
    const fullHeight = Math.ceil(this.domeRadiusY);

    const bakedCanvas = document.createElement('canvas');
    bakedCanvas.width = fullWidth;
    bakedCanvas.height = fullHeight;
    const bakedCtx = bakedCanvas.getContext('2d');

    // Initial fill (will be overwritten every frame)
    for (let y = 0; y < fullHeight; y += tileH) {
      for (let x = 0; x < fullWidth; x += tileW) {
        bakedCtx.drawImage(hexCanvas, x, y);
      }
    }

    const texture = Texture.from(bakedCanvas);
    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5, 1);

    const mask = new Graphics()
      .ellipse(0, 0, this.domeRadiusX, this.domeRadiusY)
      .fill(0xffffff);
    sprite.mask = mask;

    container.addChild(sprite, mask);

    return {
      container,
      sprite,
      bakedCanvas,
      bakedCtx,
      texture,
      hexCanvas,
      tileW,
      tileH,
      fullWidth,
      fullHeight,
      fadeCenter
    };
  }

  // Repositions the container and re-tiles the hex pattern with the
  // current scroll offset so the grid drifts.
  updateHexGridSprite(entry, anchorX, anchorY, scrollSpeed) {
    entry.container.position.set(anchorX, anchorY);

    const {
      bakedCtx, hexCanvas, tileW, tileH,
      fullWidth, fullHeight, texture, fadeCenter
    } = entry;

    // Same scroll math the original Canvas2D path used
    const scrollOffset = ((Date.now() * scrollSpeed) % tileW + tileW) % tileW;

    bakedCtx.clearRect(0, 0, fullWidth, fullHeight);

    const startX = -scrollOffset - tileW;
    for (let y = -tileH; y < fullHeight + tileH; y += tileH) {
      for (let x = startX; x < fullWidth + tileW; x += tileW) {
        bakedCtx.drawImage(hexCanvas, x, y);
      }
    }

    // Soft radial fade for the foreground only:
    // center of the dome = hexes invisible, edges = fully visible
    if (fadeCenter) {
      bakedCtx.globalCompositeOperation = 'destination-in';

      // Gradient origin is the flat base center of the half-ellipse
      // (canvas y = fullHeight). It expands upward into the dome.
      const cx = fullWidth / 2;
      const cy = fullHeight;
      const radius = Math.max(this.domeRadiusX, this.domeRadiusY) * 1.05;

      const grad = bakedCtx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      grad.addColorStop(0.0, 'rgba(0,0,0,0)');   // dead center – fully masked
      grad.addColorStop(0.45, 'rgba(0,0,0,0.15)');
      grad.addColorStop(0.75, 'rgba(0,0,0,0.6)');
      grad.addColorStop(1.0, 'rgba(0,0,0,1)');    // rim – fully visible

      bakedCtx.fillStyle = grad;
      bakedCtx.fillRect(0, 0, fullWidth, fullHeight);

      bakedCtx.globalCompositeOperation = 'source-over';
    }

    texture.source.update();
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
    const cy = padding; // the base's own flat top line

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

    // Background hex grid (now with live scroll)
    const hexEntry = this.createHexGridSprite(
      this.hexGridCanvas,
      this.hexGridTileW,
      this.hexGridTileH,
      false
    );
    this.pixiHexGridBg = hexEntry.container;
    this.pixiHexGridBgSprite = hexEntry.sprite;
    this.pixiHexGridBgEntry = hexEntry; // keep the full entry so update can re-tile

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

    // Live scroll for background hex grid
    if (this.pixiHexGridBgEntry) {
      this.updateHexGridSprite(
        this.pixiHexGridBgEntry,
        this.pos.x,
        this.domeAnchorY,
        this.domeHexScrollSpeed
      );
    }

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

    this.pixiHexGridBg?.destroy({ children: true, texture: true, textureSource: true });
    this.pixiHexGridBg = null;
    this.pixiHexGridBgSprite = null;
    this.pixiHexGridBgEntry = null;

    this.pixiMetalBaseSprite?.destroy({ texture: true, textureSource: true });
    this.pixiMetalBaseSprite = null;
    this.pixiGrassSprite?.destroy({ texture: true, textureSource: true });
    this.pixiGrassSprite = null;

    this.pixiForegroundTintSprite?.destroy({ texture: true, textureSource: true });
    this.pixiForegroundTintSprite = null;
    this.pixiHexGridFg?.destroy({ children: true, texture: true, textureSource: true });
    this.pixiHexGridFg = null;
    this.pixiHexGridFgSprite = null;
    this.pixiHexGridFgEntry = null;
    this.pixiForegroundOutlineSprite?.destroy({ texture: true, textureSource: true });
    this.pixiForegroundOutlineSprite = null;

    super.destroyPixiSprite();
  }

createForegroundTintTexture() {
  const { width, height, cx, cy } = this.domeBakeGeometry();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  // First draw the solid tint color (clipped to the dome)
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, this.domeRadiusX, this.domeRadiusY, 0, Math.PI, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.fillStyle = this.domeFillColor;
  ctx.fillRect(cx - this.domeRadiusX, cy - this.domeRadiusY, this.domeRadiusX * 2, this.domeRadiusY * 2);
  ctx.restore();

  // Then multiply by the same radial falloff used on the hex grid
  // (center transparent → rim opaque)
  ctx.globalCompositeOperation = 'destination-in';

  const gradCx = cx;
  const gradCy = cy;               // base of the half-ellipse
  const radius = Math.max(this.domeRadiusX, this.domeRadiusY) * 1.05;

  const grad = ctx.createRadialGradient(gradCx, gradCy, 0, gradCx, gradCy, radius);
  grad.addColorStop(0.0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.45, 'rgba(0,0,0,0.15)');
  grad.addColorStop(0.75, 'rgba(0,0,0,0.6)');
  grad.addColorStop(1.0, 'rgba(0,0,0,1)');

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

  // Apply the same radial falloff
  ctx.globalCompositeOperation = 'destination-in';

  const gradCx = cx;
  const gradCy = cy;
  const radius = Math.max(this.domeRadiusX, this.domeRadiusY) * 1.05;

  const grad = ctx.createRadialGradient(gradCx, gradCy, 0, gradCx, gradCy, radius);
  grad.addColorStop(0.0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.45, 'rgba(0,0,0,0.15)');
  grad.addColorStop(0.75, 'rgba(0,0,0,0.6)');
  grad.addColorStop(1.0, 'rgba(0,0,0,1)');

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  ctx.globalCompositeOperation = 'source-over';

  return { canvas, anchorX: cx / width, anchorY: cy / height };
}

  createForegroundPixiSprites(layer) {
    if (this.pixiForegroundTintSprite) return;
    if (!this.hexGridForegroundCanvas) return;

    const tintBaked = this.createForegroundTintTexture();
    this.pixiForegroundTintSprite = new Sprite(Texture.from(tintBaked.canvas));
    this.pixiForegroundTintSprite.anchor.set(tintBaked.anchorX, tintBaked.anchorY);

    // Foreground hex grid (also with live scroll)
    const hexEntry = this.createHexGridSprite(
      this.hexGridForegroundCanvas,
      this.hexGridForegroundTileW,
      this.hexGridForegroundTileH,
      true
    );
    this.pixiHexGridFg = hexEntry.container;
    this.pixiHexGridFgSprite = hexEntry.sprite;
    this.pixiHexGridFgEntry = hexEntry;

    const outlineBaked = this.createForegroundOutlineTexture();
    this.pixiForegroundOutlineSprite = new Sprite(Texture.from(outlineBaked.canvas));
    this.pixiForegroundOutlineSprite.anchor.set(outlineBaked.anchorX, outlineBaked.anchorY);

    layer.addChild(
      this.pixiForegroundTintSprite,
      this.pixiHexGridFg,
      this.pixiForegroundOutlineSprite
    );
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

    this.pixiForegroundTintSprite.position.set(this.pos.x, this.domeAnchorY);
    this.pixiForegroundTintSprite.alpha = this.domeForegroundTintOpacity * zoomFactor;

    // Live scroll for foreground hex grid
    if (this.pixiHexGridFgEntry) {
      this.updateHexGridSprite(
        this.pixiHexGridFgEntry,
        this.pos.x,
        this.domeAnchorY,
        this.domeForegroundHexScrollSpeed
      );
    }
    this.pixiHexGridFg.alpha = zoomFactor;

    this.pixiForegroundOutlineSprite.position.set(this.pos.x, this.domeAnchorY);
    this.pixiForegroundOutlineSprite.alpha = this.domeForegroundOutlineOpacity * zoomFactor;
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
    this.drawScrollingHexTile(ctx, cx, cy, cx - this.domeRadiusX, cy - this.domeRadiusY, this.domeRadiusX * 2, this.hexGridForegroundCanvas, this.hexGridForegroundTileW, this.hexGridForegroundTileH, this.domeForegroundHexScrollSpeed);
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