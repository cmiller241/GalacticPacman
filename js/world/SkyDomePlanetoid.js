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

    // Hex grid overlay — baked ONCE (see createOffscreen below) rather
    // than redrawn every frame. A grid covering a dome this size works
    // out to 800+ individual hexagons; since the dome never moves or
    // rotates, the pattern itself never changes, so re-stroking all of
    // them 60 times a second would be pure waste.
    this.domeHexSize = options.domeHexSize ?? 60; // hexagon "radius," center to vertex
    this.domeHexColor = options.domeHexColor ?? '255,255,255';
    this.domeHexOpacity = options.domeHexOpacity ?? 0.12; // "very transparent," per the brief

    // Foreground pass gets its OWN, larger hex grid — bigger hexagons
    // read as closer to the camera (the near surface of the glass,
    // between the player and the viewer), the same reasoning behind
    // drawForegroundGlass being a separate, later-drawn pass at all.
    // Defaults scale off domeHexSize/domeHexOpacity rather than being
    // independent fixed numbers, so they stay proportional if the
    // background grid is ever retuned.
    this.domeForegroundHexSize = options.domeForegroundHexSize ?? this.domeHexSize * 1.8;
    this.domeForegroundHexOpacity = options.domeForegroundHexOpacity ?? Math.min(1, this.domeHexOpacity * 2.5); // clearer/less transparent than the background grid, per the brief — a multiplier rather than an independent fixed value, so it stays proportional if the background's opacity is ever retuned

    // Foreground pass's tint/outline opacity — pulled out as proper
    // tunables since these get adjusted often while dialing in the
    // look (this replaces what used to be hardcoded 0.12/0.4 values
    // directly in drawForegroundGlass). Default tint now matches the
    // 0.4 already in use.
    this.domeForegroundTintOpacity = options.domeForegroundTintOpacity ?? 0.6;
    this.domeForegroundOutlineOpacity = options.domeForegroundOutlineOpacity ?? 0.6;

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
    this.hexGridCanvas = this.bakeHexGridOverlay(this.domeHexSize, this.domeHexOpacity);
    this.hexGridForegroundCanvas = this.bakeHexGridOverlay(this.domeForegroundHexSize, this.domeForegroundHexOpacity);
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

  // Bakes a full hex grid, clipped to the dome's own silhouette, into
  // a small offscreen canvas sized to just the dome's upper-half
  // bounding box (domeRadiusX*2 wide, domeRadiusY tall — no need to
  // bake the lower half of the ellipse, since the dome shape only ever
  // uses the upper half). Blitted directly at (boxX, boxY) — a single
  // cheap image copy instead of re-stroking ~800+ hexagons 60 times a
  // second. Parameterized by hexSize/opacity (rather than always
  // reading this.domeHexSize) and returns the canvas rather than
  // storing it directly, so this one method can bake BOTH the
  // background grid and the foreground grid's larger hexagons, called
  // twice from createOffscreen, instead of duplicating this logic.
  bakeHexGridOverlay(hexSize, opacity) {
    const w = this.domeRadiusX * 2;
    const h = this.domeRadiusY;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const bctx = canvas.getContext('2d');

    // Ellipse's true center sits at the BASE of this canvas (local
    // y = h), so the UPPER half (angle π to 2π) falls entirely within
    // this canvas's bounds — matches how the dome itself is drawn.
    const localCx = w / 2, localCy = h;
    bctx.beginPath();
    bctx.ellipse(localCx, localCy, this.domeRadiusX, this.domeRadiusY, 0, Math.PI, Math.PI * 2);
    bctx.closePath();
    bctx.clip();

    bctx.strokeStyle = `rgba(${this.domeHexColor}, ${opacity})`;
    bctx.lineWidth = 1;

    const hexWidth = Math.sqrt(3) * hexSize;
    const hexHeightStep = hexSize * 1.5;
    const endRow = Math.ceil(h / hexHeightStep) + 1;
    const endCol = Math.ceil(w / hexWidth) + 1;

    for (let row = -1; row <= endRow; row++) {
      const y = row * hexHeightStep;
      const rowOffset = (row % 2 !== 0) ? hexWidth / 2 : 0;
      for (let col = -1; col <= endCol; col++) {
        const x = col * hexWidth + rowOffset;
        this.strokeHexagon(bctx, x, y, hexSize);
      }
    }

    return canvas;
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

    // Hex grid overlay — pre-baked (see bakeHexGridOverlay), so this is
    // just a single cheap image blit, not hundreds of live strokes.
    // The baked image is already shaped to the dome's silhouette (it
    // was clipped at bake time), so no additional clip is needed here.
    if (this.hexGridCanvas) {
      ctx.drawImage(this.hexGridCanvas, boxX, boxY);
    }

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
    // opaque regardless of the fill's fade.
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, this.domeRadiusX, this.domeRadiusY, 0, Math.PI, Math.PI * 2);
    ctx.closePath();
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
    super.draw();
  }

  // A deliberately SUBTLE second pass — NOT called from draw() above,
  // called separately from game.js, AFTER the player and everything
  // else that might be standing inside the dome. Without this, the
  // dome only ever renders as a backdrop fully BEHIND the player,
  // which reads wrong once you think about it: if you're actually
  // standing inside a glass dome, the near surface of that glass sits
  // between you and the camera, not fully behind you like a painted
  // background. A faint tint plus a soft outline, reusing the dome's
  // own colors at low opacity, is enough to suggest "you're looking
  // through glass at this" without meaningfully obscuring anything
  // underneath — this isn't a second full dome render, just enough
  // translucency to sell the barrier.
  drawForegroundGlass() {
    const ctx = state.ctx;
    const cx = this.pos.x;
    const cy = this.pos.y - this.halfHeight;

    // How much of the foreground pass shows right now, based on
    // current zoom — see domeForegroundZoomReference/Floor's comment
    // for the reasoning. zoomT is 0 at zoomMin (zoomed out) and 1 at
    // domeForegroundZoomReference or beyond (zoomed in that much or
    // more); zoomFactor is the INVERSE of that (1 = fully visible at
    // zoomMin, domeForegroundZoomFloor = least visible at/past the
    // reference zoom), clamped so it stays well-defined even if zoom
    // is briefly outside its normal range.
    const zoom = state.zoom || 1;
    const zoomMin = state.zoomMin ?? 0.5;
    const zoomRef = this.domeForegroundZoomReference;
    const zoomT = zoomRef > zoomMin ? (zoom - zoomMin) / (zoomRef - zoomMin) : 0;
    const clampedT = Math.max(0, Math.min(1, zoomT)); // clamps anything at/past zoomRef to 1 (fully at floor), anything at/below zoomMin to 0 (fully visible)
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

    // Larger hexagons than the background grid — reads as closer to
    // the camera, matching the whole point of this being a separate,
    // later-drawn "near glass" pass. Pre-baked (see createOffscreen),
    // so still just a cheap image blit — globalAlpha here scales the
    // already-baked opacity down further for the zoom effect, rather
    // than needing to re-bake anything per frame.
    if (this.hexGridForegroundCanvas) {
      ctx.save();
      ctx.globalAlpha = zoomFactor;
      ctx.drawImage(this.hexGridForegroundCanvas, cx - this.domeRadiusX, cy - this.domeRadiusY);
      ctx.restore();
    }

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, this.domeRadiusX, this.domeRadiusY, 0, Math.PI, Math.PI * 2);
    ctx.closePath();
    ctx.globalAlpha = this.domeForegroundOutlineOpacity * zoomFactor;
    ctx.lineWidth = this.domeOutlineWidth;
    ctx.strokeStyle = this.domeOutlineColor;
    ctx.stroke();
    ctx.restore();
  }
}