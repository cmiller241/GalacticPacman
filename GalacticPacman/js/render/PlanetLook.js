// js/render/PlanetLook.js
//
// The main game's planetoid look (js/world/Planetoid.js and
// js/effects/GlowOrb.js), ported to Canvas 2D. Where the main game runs a
// GPU shader every frame, this does the same math once per pixel when a
// body is first drawn and keeps the result — so it costs nothing per frame.
//
// There's no sun in this game, so the light comes from a fixed direction
// (upper left) instead of from the scene's center.

// Unit vector toward the light, screen space.
export const LIGHT_DIR = { x: -Math.SQRT1_2, y: -Math.SQRT1_2 };

// Bodies are baked at 2x and drawn at half size, for smooth edges.
const BAKE_SCALE = 2;

// ---- Planetoid (Planetoid.js) ----
// The soft pale-blue halo round every planetoid.
// (Smaller and fainter than the main game's 45 / 0.26.)
export const HALO_PADDING = 25;
const HALO_COLOR = [120, 185, 255];
const HALO_ALPHA = 0.14;
const HALO_LAYERS = 18;
// Sun shading and the soft highlight on the lit side.
const LIT_BRIGHTNESS = 1.0;
const OVERALL_DARKEN = 0.08;
const HIGHLIGHT_ALPHA = 0.22;
const HIGHLIGHT_SIZE = 0.55;
const HIGHLIGHT_OFFSET = 0.48;
const HIGHLIGHT_COLOR = [1.0, 0.98, 0.92];
// How much the tinted texture is lifted (a plain tint can only darken).
const BODY_BRIGHTEN = 0.18;
const TEXTURE_TILES = 2.5;

// Shared by every planetoid with the same color and radius.
const planetCache = new Map();

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const rgbCss = (c, a = 1) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = Math.ceil(size);
  return c;
}

// color: [r, g, b] in 0..1. Returns { canvas, half } — draw the canvas
// centered on the planet, `half` world units out on every side.
export function getPlanetBody(radius, color, texture) {
  const key = `${color.join(',')}|${radius}`;
  const cached = planetCache.get(key);
  if (cached) return cached;

  const s = BAKE_SCALE;
  const R = radius * s;
  const P = HALO_PADDING * s;
  const size = (R + P) * 2;
  const c = size / 2;

  // --- The body: texture tinted by the color, then lifted ---
  const tinted = makeCanvas(R * 2);
  const tctx = tinted.getContext('2d');
  tctx.save();
  tctx.beginPath();
  tctx.arc(R, R, R, 0, Math.PI * 2);
  tctx.clip();
  const texSize = R * 2 * TEXTURE_TILES;
  tctx.drawImage(texture, R - texSize / 2, R - texSize / 2, texSize, texSize);
  tctx.globalCompositeOperation = 'multiply';
  tctx.fillStyle = rgbCss(color);
  tctx.fillRect(0, 0, R * 2, R * 2);
  tctx.restore();
  // (multiply leaves the outside opaque black — cut back to the circle)
  tctx.globalCompositeOperation = 'destination-in';
  tctx.beginPath();
  tctx.arc(R, R, R, 0, Math.PI * 2);
  tctx.fill();
  tctx.globalCompositeOperation = 'source-over';

  const body = makeCanvas(R * 2);
  const bctx = body.getContext('2d');
  bctx.drawImage(tinted, 0, 0);
  bctx.globalCompositeOperation = 'lighter';
  bctx.globalAlpha = BODY_BRIGHTEN;
  bctx.drawImage(tinted, 0, 0);
  bctx.globalAlpha = 1;
  bctx.globalCompositeOperation = 'source-over';

  // --- Shading + highlight, per pixel (Planetoid.js's shader) ---
  const img = bctx.getImageData(0, 0, body.width, body.height);
  const d = img.data;
  const shadeMul = LIT_BRIGHTNESS * (1 - OVERALL_DARKEN);
  const lx = LIGHT_DIR.x, ly = LIGHT_DIR.y;
  for (let py = 0; py < body.height; py++) {
    const qy = (py + 0.5 - R) / R;
    for (let px = 0; px < body.width; px++) {
      const i = (py * body.width + px) * 4;
      if (d[i + 3] === 0) continue;
      const qx = (px + 0.5 - R) / R;
      const litX = qx - lx * 0.5, litY = qy - ly * 0.5;
      const shade = clamp01(1 - Math.sqrt(litX * litX + litY * litY) / 1.6) * shadeMul;
      const hX = qx - lx * HIGHLIGHT_OFFSET, hY = qy - ly * HIGHLIGHT_OFFSET;
      let h = clamp01(1 - Math.sqrt(hX * hX + hY * hY) / HIGHLIGHT_SIZE);
      h = h * h * HIGHLIGHT_ALPHA * 255;
      d[i] = d[i] * shade + HIGHLIGHT_COLOR[0] * h;
      d[i + 1] = d[i + 1] * shade + HIGHLIGHT_COLOR[1] * h;
      d[i + 2] = d[i + 2] * shade + HIGHLIGHT_COLOR[2] * h;
    }
  }
  bctx.putImageData(img, 0, 0);

  // --- Halo behind, body on top ---
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  for (let i = HALO_LAYERS; i >= 1; i--) {
    const t = i / HALO_LAYERS;
    const falloff = (1 - t) * (1 - t);
    ctx.fillStyle = `rgba(${HALO_COLOR[0]},${HALO_COLOR[1]},${HALO_COLOR[2]},${HALO_ALPHA * falloff * 0.85})`;
    ctx.beginPath();
    ctx.arc(c, c, R + P * t, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.drawImage(body, c - R, c - R);

  const result = toWorldSize(canvas, radius + HALO_PADDING);
  planetCache.set(key, result);
  return result;
}

// ---- Glowing metal orb (GlowOrb.js) ----
// options: glowRadiusMult, edgeSoftness, glowStrength, rimStrength —
// same meanings and defaults as GlowOrb.draw.
const orbCache = new Map();

export function getGlowOrb(radius, colors, options = {}) {
  const glowMult = options.glowRadiusMult ?? 1.6;
  const edgeSoftness = options.edgeSoftness ?? 2;
  const glowStrength = options.glowStrength ?? 0.5;
  const rimStrength = options.rimStrength ?? 0.6;
  const key = `${radius}|${glowMult}|${edgeSoftness}|${glowStrength}|${rimStrength}|${JSON.stringify(colors)}`;
  const cached = orbCache.get(key);
  if (cached) return cached;

  const s = BAKE_SCALE;
  const glowRadius = radius * glowMult;
  const half = glowRadius;
  const canvas = makeCanvas(half * 2 * s);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(canvas.width, canvas.height);
  const d = img.data;

  // Light direction, lifted out of the screen a little (as GlowOrb does)
  // so the lit side is a visible cap rather than a thin crescent.
  const sl = Math.hypot(LIGHT_DIR.x, LIGHT_DIR.y, 0.5);
  const sx = LIGHT_DIR.x / sl, sy = LIGHT_DIR.y / sl, sz = 0.5 / sl;
  const { dark, light, rim, glow } = colors;

  for (let py = 0; py < canvas.height; py++) {
    const ly = (py + 0.5) / s - half;
    for (let px = 0; px < canvas.width; px++) {
      const lx = (px + 0.5) / s - half;
      const dist = Math.sqrt(lx * lx + ly * ly);

      const bodyAlpha = 1 - smoothstep(radius - edgeSoftness, radius + edgeSoftness, dist);
      const glowAlpha = (1 - smoothstep(radius, glowRadius, dist)) * glowStrength;
      const alpha = Math.max(bodyAlpha, glowAlpha);
      if (alpha <= 0) continue;

      // Pseudo-3D sphere normal.
      const nxy = clamp01(dist / radius);
      const dx = dist > 0.0001 ? lx / dist : 0, dy = dist > 0.0001 ? ly / dist : 0;
      const nz = Math.sqrt(Math.max(0, 1 - nxy * nxy));
      const facing = dx * nxy * sx + dy * nxy * sy + nz * sz;
      const lightT = smoothstep(-0.3, 0.7, facing);
      const rimT = smoothstep(radius * 0.6, radius, dist) * clamp01(facing) * rimStrength;

      const i = (py * canvas.width + px) * 4;
      for (let k = 0; k < 3; k++) {
        let b = dark[k] + (light[k] - dark[k]) * lightT;
        b = b + (rim[k] - b) * rimT;
        const out = glow[k] + (b - glow[k]) * bodyAlpha;
        d[i + k] = clamp01(out) * 255;
      }
      d[i + 3] = alpha * 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const result = toWorldSize(canvas, half);
  orbCache.set(key, result);
  return result;
}

// Canvas pixels per world unit that baked bodies are kept at — matched to
// how big they actually appear (camera zoom x screen density, see
// fitToScreen in game.js), between 1 and 2. At 1 (a desktop screen at
// full zoom) every frame's draw is a plain 1:1 copy.
let outputScale = 1;

export function setBakeResolution(scale) {
  const s = Math.max(1, Math.min(2, Math.round(scale * 4) / 4));
  if (s === outputScale) return;
  outputScale = s;
  // Bodies baked from now on use the new resolution.
  planetCache.clear();
  orbCache.clear();
}

// Shrinks a BAKE_SCALE bake down to its on-screen resolution ONCE (with
// high-quality smoothing), so every frame's draw is a copy, not a 2x
// resample.
function toWorldSize(big, half) {
  const canvas = makeCanvas(half * 2 * outputScale);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(big, 0, 0, canvas.width, canvas.height);
  return { canvas, half: canvas.width / 2 / outputScale };
}

// Draws a baked { canvas, half } centered at (x, y).
export function drawBaked(ctx, baked, x, y) {
  ctx.drawImage(baked.canvas, x - baked.half, y - baked.half, baked.half * 2, baked.half * 2);
}
