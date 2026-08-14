// js/effects/VatsOverlay.js
import { state } from '../state.js';
import { getBoundingRadius } from '../systems/Raycast.js';

const OVERLAY_COLOR = 'rgba(0, 0, 0, 0.55)'; // max darkness, reached once fully into V.A.T.S.
const CUTOUT_PADDING = 14; // slightly beyond LockOutline.js's own OUTLINE_PADDING (8), so the cutout comfortably surrounds the yellow outline rather than clipping it

// VHS/CRT-style scan lines drawn on top of the base dark fill — see
// drawVatsOverlay's own comment for where these get applied and why
// the cutout removes them from the locked target's own area too.
//
// Real, ALTERNATING light/dark bands, baked directly into the tile —
// not a single faint line relying on absolute brightness, which is
// what the first version of this did and why it was invisible: a
// space scene is already mostly dark, with a dark overlay on top of
// THAT, so a ~5%-alpha white line had nothing to contrast against.
// What actually reads as "scan lines" is the CONTRAST between an
// explicit lighter band and an explicit darker band sitting right next
// to each other, not how bright either one is in isolation.
const SCANLINE_SPACING = 5; // px per full light+dark cycle
const SCANLINE_LIGHT_ALPHA = 0.15; // the lighter band — strong enough to read clearly against a dark scene
const SCANLINE_DARK_ALPHA = 0; // the darker band — extra black ON TOP of the base overlay, for contrast against the light band right next to it
const SCANLINE_FLICKER_MIN = 0.8; // flicker only ever dims the WHOLE pattern down to this fraction of its baked-in alpha, never further — keeps it consistently visible rather than fading in and out to nothing
const SCANLINE_DRIFT_SPEED = 0.015; // px/ms — a slow vertical roll, like an old tape's vertical hold drifting, not a fast scroll

// Built once and reused across frames — a 1px-wide, SCANLINE_SPACING-
// tall tile with its own top half baked as the light band and bottom
// half as the dark band, repeated via CanvasRenderingContext2D's own
// pattern-fill (cheaper and simpler than manually looping drawImage
// calls for something this small).
let scanlinePattern = null;
function getScanlinePattern(ctx) {
  if (scanlinePattern) return scanlinePattern;
  const tile = document.createElement('canvas');
  tile.width = 1;
  tile.height = SCANLINE_SPACING;
  const tileCtx = tile.getContext('2d');
  const half = SCANLINE_SPACING / 2;
  tileCtx.fillStyle = `rgba(255, 255, 255, ${SCANLINE_LIGHT_ALPHA})`;
  tileCtx.fillRect(0, 0, 1, half);
  tileCtx.fillStyle = `rgba(0, 0, 0, ${SCANLINE_DARK_ALPHA})`;
  tileCtx.fillRect(0, half, 1, half);
  scanlinePattern = ctx.createPattern(tile, 'repeat');
  return scanlinePattern;
}

// Built once and reused across frames (resized only when the needed
// dimensions actually change, not recreated every single frame) — see
// drawVatsOverlay's own comment for why this has to be a SEPARATE
// canvas rather than compositing directly onto the main one.
let overlayCanvas = null;
let overlayCtx = null;

function getOverlayLayer(width, height) {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  if (!overlayCanvas) {
    overlayCanvas = document.createElement('canvas');
    overlayCtx = overlayCanvas.getContext('2d');
  }
  if (overlayCanvas.width !== w || overlayCanvas.height !== h) {
    overlayCanvas.width = w;
    overlayCanvas.height = h;
  }
  return { canvas: overlayCanvas, ctx: overlayCtx };
}

// Draws a full-viewport dark overlay while V.A.T.S. is active, with a
// hole cut out around state.player.lockedTarget (if any) so the locked
// object stays at full brightness — reinforced further by the yellow
// LockOutline.js ring still drawn on top of it — while everything else
// dims.
//
// Built on a SEPARATE, dedicated offscreen canvas, then composited onto
// the main one with normal (source-over) blending — NOT drawn as a dark
// rect plus a destination-out cutout directly on the main canvas, which
// is what this used to do and was the actual bug behind "a dark navy
// circle covers the selected planet." destination-out doesn't
// distinguish "what THIS fillRect call just drew" from everything else
// already accumulated on the canvas — it erases from the WHOLE current
// pixel buffer. Applied directly to the main canvas, which by this
// point already has the planet itself painted onto it from an earlier
// draw call the same frame, the cutout wasn't just erasing the dark
// overlay — it was erasing the PLANET too, punching an actually
// transparent hole straight through to whatever's behind the canvas
// element itself (its page background) — which is exactly what a
// bigger cutout radius made look like a BIGGER dark shape, backwards
// from what a working reveal should do, and the tell that gave this
// away. Building the overlay on its own isolated layer first — where
// nothing but the overlay's own pixels exist for destination-out to
// touch — and compositing that finished result onto the main canvas
// normally sidesteps this entirely: normal blending can only ever ADD
// darkness on top of what's already there, never remove it.
//
// The cutout's shape detection mirrors LockOutline.js's own (rotated
// rounded-rect vs. plain circle) exactly, so the hole matches the
// outline rather than being a generic circle regardless of the
// target's real shape.
//
// Opacity tracks state.timeScale's own progress toward
// state.vatsTimeScale (0 at normal speed, 1 once fully slowed) rather
// than snapping on/off with state.vatsActive directly — game.js eases
// timeScale toward its target gradually, and tying the overlay to that
// same curve keeps the darkening and the slowdown reading as one
// cohesive transition instead of a mismatched "instant overlay, gradual
// slowdown" combination. Applied as the alpha of the final composite
// step below, not baked into the layer's own fill — the cutout region
// is fully transparent (alpha 0) within the layer regardless, and
// zero times any progress value is still zero, so the hole itself
// stays completely unaffected by the fade either way.
//
// Called every frame from gameLoop, inside the same zoom/camera-
// transformed block as everything else in world space.
export function drawVatsOverlay() {
  const denom = 1 - state.vatsTimeScale;
  const progress = denom > 0 ? (1 - state.timeScale) / denom : 0;
  if (progress <= 0) return;

  const mainCtx = state.ctx;
  const cam = state.camera || { x: 0, y: 0 };
  const vw = state.visibleWidth || 0;
  const vh = state.visibleHeight || 0;
  if (vw <= 0 || vh <= 0) return;

  const { canvas: layer, ctx } = getOverlayLayer(vw, vh);
  ctx.clearRect(0, 0, layer.width, layer.height);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = OVERLAY_COLOR;
  ctx.fillRect(0, 0, layer.width, layer.height);

  // VHS-style scan lines — drawn on top of the base dark fill but
  // still BEFORE the cutout below, so the cutout removes them from the
  // locked target's own area too, same as the base darkening. A slow
  // vertical drift (via translate, before the pattern fill — patterns
  // tile relative to wherever the canvas origin currently is) plus a
  // gentle alpha flicker sells the "old tape" feel without being
  // distracting; the fillRect deliberately overshoots the layer's own
  // bounds on both ends so the translated pattern still fully covers
  // it regardless of the current drift offset. The flicker only ever
  // scales the WHOLE pattern (both bands together, preserving their
  // contrast with each other) between SCANLINE_FLICKER_MIN and 1 — a
  // floor, not a fade to nothing, since the goal is a lively texture
  // that's always clearly there, not one that periodically vanishes.
  const flickerT = (Math.sin(Date.now() * 0.01) + 1) / 2; // 0..1
  const flicker = SCANLINE_FLICKER_MIN + (1 - SCANLINE_FLICKER_MIN) * flickerT;
  ctx.save();
  const driftY = (Date.now() * SCANLINE_DRIFT_SPEED) % SCANLINE_SPACING;
  ctx.translate(0, driftY);
  ctx.globalAlpha = flicker;
  ctx.fillStyle = getScanlinePattern(ctx);
  ctx.fillRect(0, -SCANLINE_SPACING - driftY, layer.width, layer.height + SCANLINE_SPACING * 2);
  ctx.restore();

  const target = state.player && state.player.lockedTarget;
  if (target) {
    // Local to THIS layer — world position minus the viewport's own
    // top-left corner, since this canvas only spans the current
    // visible area, not the whole world.
    const localX = target.pos.x - cam.x;
    const localY = target.pos.y - cam.y;

    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,1)'; // only the alpha channel matters for destination-out; color is irrelevant

    if (target.isRoundedRect) {
      ctx.save();
      ctx.translate(localX, localY);
      ctx.rotate(target.rotationAngle);
      const w = target.halfWidth + CUTOUT_PADDING;
      const h = target.halfHeight + CUTOUT_PADDING;
      ctx.beginPath();
      ctx.roundRect(-w, -h, w * 2, h * 2, target.cornerRadius + CUTOUT_PADDING);
      ctx.fill();
      ctx.restore();
    } else {
      const radius = getBoundingRadius(target) + CUTOUT_PADDING;
      ctx.beginPath();
      ctx.arc(localX, localY, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Composite the finished overlay (dark rect with its hole already
  // punched out of ITS OWN pixels, nothing else's) onto the main
  // canvas with normal blending, scaled by the overall V.A.T.S. fade
  // progress. mainCtx is already under the same zoom/translate
  // transform as everything else in this draw pass, so drawing at
  // (cam.x, cam.y) with size (vw, vh) — the same world-space rectangle
  // this layer represents — lines up automatically.
  mainCtx.save();
  mainCtx.globalAlpha = progress;
  mainCtx.globalCompositeOperation = 'source-over';
  mainCtx.drawImage(layer, cam.x, cam.y, vw, vh);
  mainCtx.restore();
}