// js/effects/VatsOverlay.js
//
// Draws a full-viewport dark overlay with VHS-style scan lines while
// V.A.T.S. is active, with a hole cut out around state.player.lockedTarget
// (if any) so the locked object stays at full brightness — reinforced
// further by the yellow LockOutline.js ring still drawn on top of it.

import love from '../love/index.js';
import lua from '../love/lua.js';
import state from '../state.js';
import utils from '../utils.js';

const OVERLAY_ALPHA = 0.55; // max darkness, reached once fully into V.A.T.S.
const CUTOUT_PADDING = 14;  // slightly beyond LockOutline.js's own OUTLINE_PADDING (8), so the cutout comfortably surrounds the yellow outline rather than clipping it

// Real, ALTERNATING light/dark bands baked into a small repeating tile —
// a single faint line relying on absolute brightness is invisible
// against an already-dark scene with a dark overlay on top of THAT.
// What reads as "scan lines" is the CONTRAST between an explicit lighter
// band and an explicit darker (here: fully transparent) band sitting
// right next to each other.
const SCANLINE_SPACING = 5;        // px per full light+dark cycle
const SCANLINE_LIGHT_ALPHA = 0.15; // the lighter band
const SCANLINE_FLICKER_MIN = 0.8;  // flicker only ever dims the WHOLE pattern down to this fraction, never further
const SCANLINE_FLICKER_RATE = 10;
const SCANLINE_DRIFT_SPEED = 15;   // px/second — a slow vertical roll, like an old tape's vertical hold drifting

const VatsOverlay = {};

// Built once and reused across frames — a 1px-wide, SCANLINE_SPACING-
// tall tile with its top half baked as the light band and bottom half
// left fully transparent, tiled via setWrap('repeat') + an oversized
// Quad rather than manually looping rectangle draws.
let scanlineTile = null;
function getScanlineTile() {
  if (scanlineTile) return scanlineTile;
  scanlineTile = love.graphics.newCanvas(1, SCANLINE_SPACING);
  scanlineTile.setWrap('repeat', 'repeat');
  scanlineTile.setFilter('nearest', 'nearest');

  // push/origin: this is built lazily on VatsOverlay.draw()'s first
  // call, which happens while the outer world-space zoom/translate
  // transform is already active — without resetting to identity first,
  // the fill below would be drawn through THAT transform instead of in
  // the tile's own pixel grid.
  love.graphics.push();
  love.graphics.origin();
  love.graphics.setCanvas(scanlineTile);
  love.graphics.clear(0, 0, 0, 0);
  love.graphics.setColor(1, 1, 1, SCANLINE_LIGHT_ALPHA);
  love.graphics.rectangle('fill', 0, 0, 1, SCANLINE_SPACING / 2);
  love.graphics.setCanvas();
  love.graphics.setColor(1, 1, 1, 1);
  love.graphics.pop();

  return scanlineTile;
}

// Built once and reused across frames (resized only when the needed
// dimensions actually change) — a SEPARATE canvas from the main
// framebuffer, so the cutout below only ever erases THIS layer's own
// pixels (the dark fill + scan lines drawn into it moments ago) rather
// than anything already on screen.
let overlayCanvas = null;
function getOverlayLayer(w, h) {
  w = Math.max(1, Math.ceil(w));
  h = Math.max(1, Math.ceil(h));
  if (!overlayCanvas || overlayCanvas.getWidth() !== w || overlayCanvas.getHeight() !== h) {
    overlayCanvas = love.graphics.newCanvas(w, h);
  }
  return overlayCanvas;
}

// Opacity tracks state.vatsMultiplier's own progress toward
// state.vatsTimeScale (0 at normal speed, 1 once fully slowed) rather
// than snapping on/off with state.vatsActive directly — main.js eases
// vatsMultiplier toward its target gradually, and tying the overlay to
// that same curve keeps the darkening and the slowdown reading as one
// cohesive transition.
//
// Deliberately state.vatsMultiplier, NOT state.timeScale: timeScale is
// vatsMultiplier multiplied by frameNorm (this frame's real-time
// normalization factor), which jitters slightly around 1 every frame
// even while VATS is fully off — using it here made the whole screen
// strobe. vatsMultiplier is the clean easing value.
//
// Called every frame from love.draw(), inside the same zoom/camera-
// transformed push() block as everything else in world space.
VatsOverlay.draw = function () {
  const vatsTimeScale = state.vatsTimeScale ?? 0.05;
  const denom = 1 - vatsTimeScale;
  const progress = denom > 0 ? ((1 - (state.vatsMultiplier ?? 1)) / denom) : 0;
  if (progress <= 0) return;

  const cam = state.camera ?? { x: 0, y: 0 };
  const zoom = state.zoom ?? 1;

  // Built at real SCREEN pixel dimensions, NOT world units — the visible
  // world span grows without bound as the player zooms out, eventually
  // requesting a texture wider than the GPU's own max size. Screen
  // pixels are bounded by the window regardless of zoom. See the
  // composite draw at the bottom for the explicit 1/zoom scale that
  // goes with this.
  const sw = love.graphics.getWidth(), sh = love.graphics.getHeight();
  if (sw <= 0 || sh <= 0) return;

  const layer = getOverlayLayer(sw, sh);
  const tile = getScanlineTile();
  const lw = layer.getWidth(), lh = layer.getHeight();

  // push/origin: identity transform for everything drawn INTO layer.
  love.graphics.push();
  love.graphics.origin();

  love.graphics.setCanvas(layer);
  love.graphics.clear(0, 0, 0, 0);
  love.graphics.setBlendMode('alpha');
  love.graphics.setColor(0, 0, 0, OVERLAY_ALPHA);
  love.graphics.rectangle('fill', 0, 0, lw, lh);

  // Scan lines, on top of the base dark fill but still BEFORE the
  // cutout below, so the cutout removes them from the locked target's
  // own area too. A slow drift (via the quad's own texture-space
  // offset, which wraps automatically) plus a gentle alpha flicker
  // sells the "old tape" feel.
  const now = love.timer.getTime();
  const flickerT = (Math.sin(now * SCANLINE_FLICKER_RATE) + 1) / 2;
  const flicker = SCANLINE_FLICKER_MIN + (1 - SCANLINE_FLICKER_MIN) * flickerT;
  const driftY = lua.mod(now * SCANLINE_DRIFT_SPEED, SCANLINE_SPACING);
  const quad = love.graphics.newQuad(0, -driftY, lw, lh, tile.getWidth(), tile.getHeight());
  love.graphics.setColor(1, 1, 1, flicker);
  love.graphics.draw(tile, quad, 0, 0);

  // Cutout: punches a hole (fully transparent, alpha 0) in THIS
  // layer's own pixels around the locked target — same shape
  // detection LockOutline.js uses, so the hole matches the outline.
  // "replace" blend mode overwrites destination pixels outright
  // (including alpha) instead of blending.
  const target = state.player && state.player.lockedTarget;
  if (target) {
    const localX = (target.pos.x - cam.x) * zoom;
    const localY = (target.pos.y - cam.y) * zoom;
    const radius = (utils.boundingRadius(target) + CUTOUT_PADDING) * zoom;

    love.graphics.setBlendMode('replace', 'premultiplied');
    love.graphics.setColor(0, 0, 0, 0);
    love.graphics.circle('fill', localX, localY, radius);
    love.graphics.setBlendMode('alpha');
  }

  love.graphics.setCanvas();
  love.graphics.pop();

  // Composite the finished overlay onto the main framebuffer with
  // normal blending, scaled by the overall V.A.T.S. fade progress.
  // Still under the outer zoom/translate transform — drawing at (cam.x,
  // cam.y) lines the layer's own (0,0) pixel up with real screen (0,0),
  // and the explicit 1/zoom draw-scale cancels that outer transform's
  // own scale(zoom, zoom).
  love.graphics.setColor(1, 1, 1, progress);
  love.graphics.draw(layer, cam.x, cam.y, 0, 1 / zoom, 1 / zoom);
  love.graphics.setColor(1, 1, 1, 1);
};

export default VatsOverlay;
