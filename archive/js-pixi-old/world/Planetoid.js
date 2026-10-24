// js/world/Planetoid.js
import { state } from '../state.js';
import { INFLUENCE_PADDING, PLANET_SPEED } from '../constants.js';
import { Vector2 } from '../vector2.js';
import { Container, Sprite, Texture, Graphics, BlurFilter, RenderTexture } from 'pixi.js';
import { getDarknessTexture, getRenderer } from '../render/PixiStage.js';

export class Planetoid {
  // How far the glow extends past the planet's edge, and how strong it
  // is. These used to be set live via ctx.shadowBlur every frame; now
  // they're only used once, at bake time, in createOffscreen(). If the
  // glow ever looks clipped/square at the edges, increase SHADOW_PADDING.
  static SHADOW_BLUR = 25;
  static SHADOW_PADDING = 40;
  static SHADOW_COLOR = 'rgba(173,216,230,0.3)';

  // ----------------------------
  // SUN-RELATIVE SHADING (perf note)
  // ----------------------------
  // The sun is assumed fixed at the center of the level (sceneWidth/2,
  // sceneHeight/2) — not shown yet, per the plan.
  //
  // Rather than recomputing a gradient per planet per frame (real cost,
  // 60+ times a frame), a SINGLE overlay circle is baked ONCE, shared
  // by every planet instance, with its highlight pointing "up" by
  // convention. Each frame, draw() just rotates and blits that shared
  // overlay per planet — a rotate+drawImage is cheap, comparable to the
  // existing ring-canvas blit, not a shadowBlur/gradient-rebuild cost.
  static SUN_OVERLAY_DIAMETER = 200; // reference bake size; scaled per-planet at draw time (soft gradients upscale fine, unlike sharp sprites)
  static SUN_MIN_ALPHA = 0.25; // shading strength for planets farthest from the sun
  static SUN_MAX_ALPHA = 0.9;  // shading strength for planets closest to the sun
  static SUN_MAX_DARKNESS = 0.5; // overall (non-directional) dimming applied to the farthest planets — 0 = none, 1 = fully black. Grows linearly with distance; planets at the sun get none.
  static sunOverlayCanvas = null; // built lazily, shared across all instances

  static getSunOverlayCanvas() {
    if (Planetoid.sunOverlayCanvas) return Planetoid.sunOverlayCanvas;

    const d = Planetoid.SUN_OVERLAY_DIAMETER;
    const r = d / 2;
    const canvas = document.createElement('canvas');
    canvas.width = d;
    canvas.height = d;
    const ctx = canvas.getContext('2d');

    // Highlight offset toward -y ("up") by convention — same offset
    // style as the old static lightGradient this replaces. draw()
    // rotates this per planet so "up" instead points at the actual sun.
    const offset = -r * 0.5;
    const grad = ctx.createRadialGradient(r, r + offset, 0, r, r + offset, r * 1.5);
    grad.addColorStop(0, 'white');
    grad.addColorStop(1, 'black');

    ctx.beginPath();
    ctx.arc(r, r, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    Planetoid.sunOverlayCanvas = canvas;
    return canvas;
  }

  constructor(x, y, radius, color) {
    this.pos = new Vector2(x, y);
    this.radius = radius;
    this.mass = radius * radius;
    this.influenceRadius = radius + INFLUENCE_PADDING;
    this.color = color;
    let direction = new Vector2(Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
    this.vel = direction.multiply(PLANET_SPEED);
    this.cachedAlpha = 0.3;
    this.lastAlphaUpdate = 0;
    this.isSpikey = false;
    this.offscreen = null;
    this.offscreenPadding = 0;
    this.ringCanvas = null;
    this.interiorType = null; // "maze", "platform", etc.
  }

  createOffscreen() {
    // ---- Step 1: render the flat planet body (texture + color tint
    // ONLY — no static directional lighting anymore, since that's now
    // handled dynamically, per-frame, relative to the sun in draw()) onto
    // an unshadowed working canvas. ----
    const bodyCanvas = document.createElement('canvas');
    bodyCanvas.width = this.radius * 2;
    bodyCanvas.height = this.radius * 2;
    const bodyCtx = bodyCanvas.getContext('2d');

    bodyCtx.save();
    bodyCtx.beginPath();
    bodyCtx.arc(this.radius, this.radius, this.radius, 0, Math.PI * 2);
    bodyCtx.clip();
    const tiles = 2.5;
    const texSize = this.radius * 2 * tiles;
    const texOffset = this.radius * tiles;
    bodyCtx.drawImage(state.planetTexture, this.radius - texOffset, this.radius - texOffset, texSize, texSize);
    bodyCtx.restore();

    bodyCtx.save();
    bodyCtx.globalCompositeOperation = 'multiply';
    bodyCtx.beginPath();
    bodyCtx.arc(this.radius, this.radius, this.radius, 0, Math.PI * 2);
    bodyCtx.fillStyle = this.color;
    bodyCtx.fill();
    bodyCtx.globalCompositeOperation = 'source-over';
    bodyCtx.restore();

    // ---- Step 2: bake the glow ONCE onto a padded final canvas, by
    // drawing bodyCanvas with shadow properties set on THIS context.
    // The blur becomes part of the final pixels, so draw() never pays
    // for a live shadowBlur again — it just blits the result. ----
    const padding = Planetoid.SHADOW_PADDING;
    this.offscreenPadding = padding;
    this.offscreen = document.createElement('canvas');
    this.offscreen.width = this.radius * 2 + padding * 2;
    this.offscreen.height = this.radius * 2 + padding * 2;
    const finalCtx = this.offscreen.getContext('2d');
    finalCtx.shadowColor = Planetoid.SHADOW_COLOR;
    finalCtx.shadowBlur = Planetoid.SHADOW_BLUR;
    finalCtx.shadowOffsetX = 0;
    finalCtx.shadowOffsetY = 0;
    finalCtx.drawImage(bodyCanvas, padding, padding);

    // ---- Step 3: bake the dashed influence-radius ring at full
    // opacity too, so draw() can blit it with a cheap globalAlpha
    // instead of re-stroking a dashed path every frame. ----
    this.ringCanvas = document.createElement('canvas');
    this.ringCanvas.width = this.influenceRadius * 2;
    this.ringCanvas.height = this.influenceRadius * 2;
    const ringCtx = this.ringCanvas.getContext('2d');
    ringCtx.strokeStyle = 'rgba(173,216,230,1)';
    ringCtx.lineWidth = 3;
    ringCtx.setLineDash([10, 5]);
    ringCtx.beginPath();
    ringCtx.arc(this.influenceRadius, this.influenceRadius, this.influenceRadius, 0, Math.PI * 2);
    ringCtx.stroke();
  }

  // Same ring bake as createOffscreen()'s own Step 3 above, extracted
  // into its own method — this is what worldGen.js actually calls now
  // instead of createOffscreen() itself. Still Canvas2D (the dashed-
  // stroke pattern has no direct Pixi Graphics equivalent — confirmed
  // by checking Pixi's real StrokeAttributes type, which has no dash
  // property at all, only width/alignment/cap/join/miterLimit/
  // pixelLine — reproducing it means manually computing dash segments,
  // deliberately deferred as a smaller, separate follow-up), but this
  // was never the expensive part — no gradient, no shadowBlur, just one
  // stroke() call. createOffscreen() itself stays fully untouched
  // elsewhere in this file specifically so it keeps building this same
  // ring too, in case it's ever needed again as a whole (draw()'s own
  // Canvas2D fallback path) — this just duplicates those few lines
  // rather than having worldGen.js's new, lightweight call path run
  // through createOffscreen()'s much larger, now-unnecessary body+glow
  // work to get at them.
  createRingCanvas() {
    this.ringCanvas = document.createElement('canvas');
    this.ringCanvas.width = this.influenceRadius * 2;
    this.ringCanvas.height = this.influenceRadius * 2;
    const ringCtx = this.ringCanvas.getContext('2d');
    ringCtx.strokeStyle = 'rgba(173,216,230,1)';
    ringCtx.lineWidth = 3;
    ringCtx.setLineDash([10, 5]);
    ringCtx.beginPath();
    ringCtx.arc(this.influenceRadius, this.influenceRadius, this.influenceRadius, 0, Math.PI * 2);
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

    // Influence radius ring: pre-baked at full alpha, blended in via
    // globalAlpha — much cheaper than re-stroking a dashed circle
    // every frame for every planet.
    if (this.ringCanvas) {
      ctx.save();
      ctx.globalAlpha = this.cachedAlpha;
      ctx.drawImage(this.ringCanvas, this.pos.x - this.influenceRadius, this.pos.y - this.influenceRadius);
      ctx.restore();
    } else {
      // Fallback: only hit if draw() somehow runs before createOffscreen()
      ctx.save();
      ctx.strokeStyle = `rgba(173,216,230,${this.cachedAlpha})`;
      ctx.lineWidth = 3;
      ctx.setLineDash([10, 5]);
      ctx.beginPath();
      ctx.arc(this.pos.x, this.pos.y, this.influenceRadius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Planet body + baked-in glow — one drawImage, no live shadow cost.
    if (this.offscreen) {
      const padding = this.offscreenPadding;
      ctx.drawImage(this.offscreen, this.pos.x - this.radius - padding, this.pos.y - this.radius - padding);
    } else {
      // Fallback: live-rendered gradient, only hit if createOffscreen()
      // hasn't run yet (rare after init).
      ctx.save();
      ctx.shadowColor = Planetoid.SHADOW_COLOR;
      ctx.shadowBlur = Planetoid.SHADOW_BLUR;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      const offsetX = -this.radius * 0.5;
      const offsetY = -this.radius * 0.5;
      const gradient = ctx.createRadialGradient(
        this.pos.x + offsetX, this.pos.y + offsetY, 0,
        this.pos.x + offsetX, this.pos.y + offsetY, this.radius * 1.5
      );
      gradient.addColorStop(0, this.color);
      gradient.addColorStop(1, 'black');
      ctx.beginPath();
      ctx.arc(this.pos.x, this.pos.y, this.radius, 0, Math.PI * 2);
      ctx.fillStyle = gradient;
      ctx.fill();
      ctx.restore();
    }

    // ---- Sun-relative shading ----
    // Rotates the shared overlay (see getSunOverlayCanvas) so its
    // baked-in highlight points at the sun's actual direction from this
    // planet, and multiply-blends it on top of the body. Alpha (shading
    // strength) falls off with distance from the sun, so nearby planets
    // show a more pronounced lit/shadowed contrast than distant ones.
    const sunX = state.sceneWidth / 2;
    const sunY = state.sceneHeight / 2;
    const toSunX = sunX - this.pos.x;
    const toSunY = sunY - this.pos.y;
    const distToSun = Math.sqrt(toSunX * toSunX + toSunY * toSunY);
    const angleToSun = Math.atan2(toSunY, toSunX);

    // The overlay's highlight is baked pointing "up" (-90°) by default;
    // rotate it so that direction points at the sun instead.
    const overlayRotation = angleToSun + Math.PI / 2;

    // Falloff: minimal shadow (SUN_MIN_ALPHA) right at the sun, growing
    // to a more prominent shadow (SUN_MAX_ALPHA) toward the far corners
    // of the level. Note this overlay only ever DARKENS (multiply blend
    // can't brighten past the original color), so alpha here directly
    // controls shadow strength, not overall brightness — low alpha near
    // the sun means "barely any shadow" (planet reads as its plain,
    // bright, undimmed texture), high alpha far away means "pronounced
    // dark side."
    const maxDist = Math.sqrt(state.sceneWidth * state.sceneWidth + state.sceneHeight * state.sceneHeight) / 2;
    const distT = Math.min(distToSun / maxDist, 1);
    const overlayAlpha = Planetoid.SUN_MIN_ALPHA + distT * (Planetoid.SUN_MAX_ALPHA - Planetoid.SUN_MIN_ALPHA);

    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = overlayAlpha;
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(overlayRotation);
    const overlay = Planetoid.getSunOverlayCanvas();
    const d = this.radius * 2;
    ctx.drawImage(overlay, -this.radius, -this.radius, d, d);
    ctx.restore();

    // ---- Overall distance darkening ----
    // The directional overlay above can only ever DARKEN (multiply
    // can't brighten past the original color), so it can shape WHERE
    // the shadow falls but can't dim the lit side. This is a separate,
    // flat (non-directional) darkening pass — a plain black circle,
    // multiply-blended — whose strength grows with distT (already
    // computed above), so far planets get dimmer everywhere, not just
    // on their shadowed side. Cheap: one more solid-color fill.
    const overallDarkness = Planetoid.SUN_MAX_DARKNESS * distT;
    if (overallDarkness > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = overallDarkness;
      ctx.fillStyle = '#000000';
      ctx.beginPath();
      ctx.arc(this.pos.x, this.pos.y, this.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // ----------------------------
  // GPU-NATIVE BODY+GLOW BAKE (replaces createOffscreen()'s Canvas2D
  // version — see worldGen.js's own comment on why that call was
  // removed from generateRegularPlanetoidsInCell entirely, not just
  // left unused: createOffscreen() itself stays intact below, as a
  // rollback path, but nothing calls it anymore)
  // ----------------------------
  // This — not a Pixi-internal z-order or texture-wrapping issue — was
  // the actual cause of the performance break during a pull: every
  // time the player enters a previously-inactive world cell,
  // PLANETOIDS_PER_CELL (50) new planetoids get created at once, and
  // createOffscreen() used Canvas2D's shadowBlur to bake each one's
  // glow — a genuinely slow, CPU-bound operation, run 50 times
  // synchronously in a single frame. This replaces that with a GPU-
  // native bake: the same "compute once, blit many times" idea
  // (createPixiSprites below still only calls this once, lazily,
  // exactly like it read from this.offscreen before), but the
  // expensive part now runs on the GPU via renderer.render() instead
  // of the CPU.
  //
  // Canvas2D's shadowBlur doesn't just blur the shape — it renders a
  // BLURRED COPY of it, in shadowColor, BEHIND the sharp original,
  // both in the same drawImage call. Pixi's BlurFilter blurs whatever
  // it's applied to as a whole, including an opaque center — applying
  // it directly to the sharp body would blur the planet's own core,
  // not just add a glow around it, which isn't what this looks like
  // today. So this builds the same two-layer composite explicitly:
  // a separately-blurred shadow-colored circle behind, the sharp
  // textured+tinted body on top — verified this distinction by hand
  // against the original's actual behavior before writing this, not
  // assumed.
  //
  // The original's own "tiles"/texOffset math (state.planetTexture
  // drawn at 2.5x the visible diameter, centered, then clipped to a
  // circle — NOT an actually-repeating tiled pattern, despite the
  // variable's name) reduces to a plain centered, scaled sprite once
  // worked through by hand — simpler here than in the original, which
  // computed it in bodyCanvas's own top-left-origin coordinate system
  // rather than a centered one.
  createGpuBodyTexture() {
    const renderer = getRenderer();
    if (!renderer) return null; // Pixi hasn't finished initializing yet — try again next frame, same tolerance as createPixiSprites' own offscreen/ringCanvas check

    const r = this.radius;
    const tiles = 2.5; // same value/meaning as the original's own "tiles" variable
    const texSize = r * 2 * tiles;

    const textureSprite = new Sprite(Texture.from(state.planetTexture));
    textureSprite.anchor.set(0.5, 0.5);
    textureSprite.width = texSize;
    textureSprite.height = texSize;

    const circleMask = new Graphics().circle(0, 0, r).fill(0xffffff);
    textureSprite.mask = circleMask;

    const colorTint = new Graphics().circle(0, 0, r).fill(this.color);
    colorTint.blendMode = 'multiply';

    const sharpBody = new Container();
    sharpBody.addChild(textureSprite, circleMask, colorTint);

    // BlurFilter's own strength isn't a direct 1:1 equivalent of
    // Canvas2D's shadowBlur value — different blur algorithms/
    // parameterizations entirely — this is a reasoned starting guess
    // (roughly half, since BlurFilter's strength tends to read
    // stronger per-unit than shadowBlur's own pixel value does), not a
    // verified-correct mapping. Worth a visual comparison against the
    // original once you can see both side by side.
    const shadow = new Graphics().circle(0, 0, r).fill(Planetoid.SHADOW_COLOR);
    shadow.filters = [new BlurFilter({ strength: Planetoid.SHADOW_BLUR / 2, quality: 4 })];

    const padding = Planetoid.SHADOW_PADDING;
    this.offscreenPadding = padding; // still read by draw()'s own Canvas2D fallback position math, kept in sync even though that path is currently unused
    const finalContainer = new Container();
    // shadow/sharpBody are both centered at their own local (0,0) —
    // this offsets the WHOLE composite into the render texture's own
    // top-left-origin space, same reasoning as the original's
    // finalCtx.drawImage(bodyCanvas, padding, padding).
    finalContainer.position.set(r + padding, r + padding);
    finalContainer.addChild(shadow, sharpBody);

    const renderTexture = RenderTexture.create({
      width: r * 2 + padding * 2,
      height: r * 2 + padding * 2,
    });
    renderer.render({ container: finalContainer, target: renderTexture });

    // The Container/Sprite/Graphics objects used to PRODUCE the bake
    // aren't needed once it's done — renderTexture itself is a static
    // snapshot from here on, same "bake once" idea as the original.
    // No texture:true here — textureSprite wraps state.planetTexture,
    // which is SHARED across every planetoid's own bake; destroying
    // that shared texture here would break every other planetoid still
    // using it, same reasoning already applied to the shared sun-
    // overlay/darkness textures elsewhere in this file.
    finalContainer.destroy({ children: true });

    return renderTexture;
  }


  // ----------------------------
  // PIXI RENDERING (planetoids/player/starfield migration — see
  // js/render/PixiStage.js for the full context on why this is a
  // separate render path rather than a replacement for draw() above)
  // ----------------------------
  // Lazily builds the Pixi-side representation the first time
  // this.offscreen/this.ringCanvas actually exist — createOffscreen()
  // is called from elsewhere (worldGen/levelSetup, not this file), and
  // rather than needing to know or touch that call site, this just
  // keeps checking each frame (from updatePixiSprites below) until
  // they're ready, mirroring draw()'s own "fallback" pattern of
  // tolerating createOffscreen() not having run yet.
  //
  // Four child sprites, matching draw()'s own four composited layers
  // exactly, back to front: the influence ring, the baked body+glow,
  // the rotating sun-relative shading (multiply blend), and the flat
  // distance-darkening circle (multiply blend, tinted black from a
  // single shared white-circle texture — see getDarknessTexture in
  // PixiStage.js for why a shared texture rather than a per-planet
  // bake). All four use anchor 0.5 (center), so position is just
  // this.pos directly, no per-layer offset math to keep in sync with
  // draw()'s own top-left-anchored drawImage calls.
  createPixiSprites(planetoidLayer) {
    if (this.pixiSprites) return; // already built
    if (!this.ringCanvas) return; // createRingCanvas() hasn't run yet — try again next frame

    const bodyTexture = this.createGpuBodyTexture();
    if (!bodyTexture) return; // renderer not ready yet — try again next frame

    const ring = new Sprite(Texture.from(this.ringCanvas));
    ring.anchor.set(0.5);

    const body = new Sprite(bodyTexture);
    body.anchor.set(0.5);

    const sunOverlay = new Sprite(Texture.from(Planetoid.getSunOverlayCanvas()));
    sunOverlay.anchor.set(0.5);
    sunOverlay.blendMode = 'multiply';
    sunOverlay.width = this.radius * 2;
    sunOverlay.height = this.radius * 2;

    const darkness = new Sprite(getDarknessTexture());
    darkness.anchor.set(0.5);
    darkness.blendMode = 'multiply';
    darkness.tint = 0x000000; // tints the shared white-circle texture black
    darkness.width = this.radius * 2;
    darkness.height = this.radius * 2;

    // Added DIRECTLY to planetoidLayer, not wrapped in a per-planetoid
    // Container the way this used to be — that wrapper was never
    // itself positioned (every sprite below already gets its own
    // independent position.set() call in updatePixiSprites, since
    // that's simpler to reason about than keeping a parent's position
    // in sync with four children that also each need independent
    // alpha/rotation/tint), so it contributed a whole extra level of
    // Pixi's own recursive updateTransformAndChildren walk for every
    // single planetoid, for literally no functional benefit — a real,
    // profiler-identified cost (confirmed directly in a DevTools
    // Performance capture: that function recursing 4 levels deep, with
    // the deepest level alone accounting for 23.6% of total frame
    // time), not a guessed-at one. Insertion order still preserves the
    // correct relative z-order WITHIN each planetoid (ring behind
    // body behind sun-shading behind darkening, same as draw()'s own
    // layer order, since all four still get added in that sequence) —
    // the exact order BETWEEN different planetoids doesn't matter
    // visually, since they don't meaningfully overlap on screen.
    planetoidLayer.addChild(ring, body, sunOverlay, darkness);

    this.pixiSprites = { ring, body, sunOverlay, darkness };
  }

  // Called every frame in place of draw() once migrated. Same
  // cachedAlpha/sun-angle/distance math as draw() above, applied to
  // Pixi sprite properties instead of ctx calls.
  updatePixiSprites(planetoidLayer) {
    if (!this.pixiSprites) {
      this.createPixiSprites(planetoidLayer);
      if (!this.pixiSprites) return; // still not ready
    }

    const now = Date.now();
    if (now - this.lastAlphaUpdate > 500) {
      const dist = this.pos.subtract(state.player.pos).length();
      this.cachedAlpha = Math.max(0.01, 0.3 - (dist / 1000) * 0.65);
      this.lastAlphaUpdate = now;
    }

    const { ring, body, sunOverlay, darkness } = this.pixiSprites;

    ring.position.set(this.pos.x, this.pos.y);
    ring.alpha = this.cachedAlpha;

    body.position.set(this.pos.x, this.pos.y);

    const sunX = state.sceneWidth / 2;
    const sunY = state.sceneHeight / 2;
    const toSunX = sunX - this.pos.x;
    const toSunY = sunY - this.pos.y;
    const distToSun = Math.sqrt(toSunX * toSunX + toSunY * toSunY);
    const angleToSun = Math.atan2(toSunY, toSunX);
    const overlayRotation = angleToSun + Math.PI / 2;
    const maxDist = Math.sqrt(state.sceneWidth * state.sceneWidth + state.sceneHeight * state.sceneHeight) / 2;
    const distT = Math.min(distToSun / maxDist, 1);
    const overlayAlpha = Planetoid.SUN_MIN_ALPHA + distT * (Planetoid.SUN_MAX_ALPHA - Planetoid.SUN_MIN_ALPHA);

    sunOverlay.position.set(this.pos.x, this.pos.y);
    sunOverlay.rotation = overlayRotation;
    sunOverlay.alpha = overlayAlpha;

    const overallDarkness = Planetoid.SUN_MAX_DARKNESS * distT;
    darkness.position.set(this.pos.x, this.pos.y);
    darkness.alpha = overallDarkness;
    darkness.visible = overallDarkness > 0; // draw() skips this layer entirely below threshold; matched here rather than just relying on alpha=0, which would still cost a (cheap, but nonzero) draw call
  }
}