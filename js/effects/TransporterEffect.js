// js/effects/TransporterEffect.js
//
// The Beam.js teleport's look: a sci-fi "transporter" shimmer. On the way
// out, a column of twinkling sparkles fills his silhouette and drifts
// upward while his body flares with light and fades away, leaving only the
// sparkles, which then fade too. Arriving is the same thing played
// backward. (Player.js decides the timing — see Player.getTransporterState.)
//
//   TransporterEffect.curves(t)     — how faded/glowing/sparkly he is at
//     progress t (0 = fully here, 1 = fully gone).
//   TransporterEffect.drawFaded(...) — draws him see-through and/or lit
//     up, via an offscreen canvas (his rig sets its own solid colors, so a
//     plain setColor alpha can't fade him).
//   TransporterEffect.drawSparkles(...) — the shimmering motes.

import love from '../love/index.js';
import state from '../state.js';

const TransporterEffect = {};

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// t: 0 = fully materialized, 1 = fully gone. Returns [bodyAlpha, glow, sparkle], each 0..1.
TransporterEffect.curves = function (t) {
  const sparkle = smoothstep(0, 0.25, t) * (1 - smoothstep(0.75, 1, t));
  const glow = 0.45 * smoothstep(0.1, 0.45, t) * (1 - smoothstep(0.45, 0.8, t));
  const bodyAlpha = 1 - smoothstep(0.3, 0.75, t);
  return [bodyAlpha, glow, sparkle];
};

// Fills a silhouette with flat color (its own alpha decides where).
let fillShader = null;
function getFillShader() {
  if (fillShader) return fillShader;
  fillShader = love.graphics.newShader(`
    vec4 effect(vec4 color, Image tex, vec2 texture_coords, vec2 screen_coords) {
      float a = Texel(tex, texture_coords).a;
      return vec4(color.rgb * a * color.a, 0.0);
    }
  `);
  return fillShader;
}

let cachedCanvas = null;
function getCanvas(size) {
  if (cachedCanvas && cachedCanvas.getWidth() >= size && cachedCanvas.getHeight() >= size) return cachedCanvas;
  cachedCanvas = love.graphics.newCanvas(size, size);
  return cachedCanvas;
}

// worldX, worldY: the subject's anchor. boundWorldRadius: generous reach of
// the subject from that point. bodyAlpha, glow: 0..1. color: [r,g,b] of the
// glow. drawFn: draws the subject.
TransporterEffect.drawFaded = function (worldX, worldY, boundWorldRadius, bodyAlpha, glow, color, drawFn) {
  if (bodyAlpha <= 0 && glow <= 0) return;
  const g = love.graphics;
  const zoom = state.zoom ?? 1;
  const cam = state.camera ?? { x: 0, y: 0 };
  const halfPx = Math.ceil(boundWorldRadius * zoom);
  if (halfPx < 2) return;
  const size = halfPx * 2;
  const canvas = getCanvas(size);

  // Pass 1: render him into the cleared canvas at the scene's zoom.
  const prevCanvas = g.getCanvas();
  const [stencilMode, stencilValue] = g.getStencilTest();
  g.setStencilTest();
  g.push();
  g.setCanvas(canvas);
  g.clear(0, 0, 0, 0);
  g.origin();
  g.translate(halfPx, halfPx);
  g.scale(zoom, zoom);
  g.translate(-worldX, -worldY);
  drawFn();
  g.setShader();
  g.setCanvas(prevCanvas);
  g.pop();
  if (stencilMode && stencilMode !== 'always') g.setStencilTest(stencilMode, stencilValue);

  // Pass 2: draw it back where he stands — faded, then lit.
  const screenX = (worldX - cam.x) * zoom - halfPx;
  const screenY = (worldY - cam.y) * zoom - halfPx;
  g.push();
  g.origin();
  if (bodyAlpha > 0) {
    g.setBlendMode('alpha', 'premultiplied');
    g.setColor(bodyAlpha, bodyAlpha, bodyAlpha, bodyAlpha);
    g.draw(canvas, screenX, screenY);
  }
  if (glow > 0) {
    g.setShader(getFillShader());
    g.setBlendMode('add', 'premultiplied');
    g.setColor(color[0], color[1], color[2], glow);
    g.draw(canvas, screenX, screenY);
    g.setShader();
  }
  g.setBlendMode('alpha');
  g.pop();
  g.setColor(1, 1, 1, 1);
};

// Same pseudo-random hash every frame, so each sparkle keeps its own lane,
// speed and twinkle rate.
function hash(i, k) {
  const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

const SPARKLE_COUNT = 64;
const STREAK_COUNT = 12;

// cx, cy: middle of his body. upX, upY: his "up" (unit vector). height,
// width: column size, world units. intensity: 0..1. color: [r,g,b].
// time: seconds (real time, so it shimmers at the same speed in V.A.T.S.).
TransporterEffect.drawSparkles = function (cx, cy, upX, upY, height, width, intensity, color, time) {
  if (intensity <= 0) return;
  const g = love.graphics;
  const rightX = -upY, rightY = upX;
  const [cr, cg, cb] = color;
  const wr = cr + (1 - cr) * 0.7, wg = cg + (1 - cg) * 0.7, wb = cb + (1 - cb) * 0.7;

  g.setBlendMode('add');

  // White streaks of light shooting up from his feet, fading as they rise.
  const feetX = cx - upX * height * 0.5, feetY = cy - upY * height * 0.5;
  g.setLineWidth(1.2);
  for (let i = 1; i <= STREAK_COUNT; i++) {
    const across = (hash(i, 11) * 2 - 1) * width * 0.45;
    const progress = ((hash(i, 12) + time * (0.9 + hash(i, 13) * 0.8)) % 1 + 1) % 1; // 0 = at his feet, 1 = top
    const len = height * (0.18 + hash(i, 14) * 0.17);
    const a = intensity * (1 - progress) * (0.5 + 0.5 * hash(i, 15));
    const tail = progress * height;
    const head = Math.min(height, tail + len);
    const bx = feetX + rightX * across, by = feetY + rightY * across;
    g.setColor(1, 1, 1, a);
    g.line(bx + upX * tail, by + upY * tail, bx + upX * head, by + upY * head);
  }
  g.setLineWidth(1);

  for (let i = 1; i <= SPARKLE_COUNT; i++) {
    const u = hash(i, 1) + hash(i, 2) - 1;            // -1..1, bunched toward the middle
    const speed = 0.25 + hash(i, 3) * 0.5;            // column-heights per second, drifting up
    const v = ((hash(i, 4) + time * speed) % 1 + 1) % 1; // 0 = feet, 1 = head
    let tw = Math.sin(time * (5 + hash(i, 5) * 9) + hash(i, 6) * 6.2832);
    tw = tw > 0 ? tw * tw * tw : 0;
    const a = intensity * tw * (0.5 + 0.5 * hash(i, 7)) * Math.sqrt(Math.sin(v * Math.PI));
    if (a > 0.02) {
      const along = (v - 0.5) * height;
      const across = u * width * 0.5;
      const px = cx + upX * along + rightX * across;
      const py = cy + upY * along + rightY * across;
      const s = 0.7 + hash(i, 8) * 1.3;
      g.setColor(cr, cg, cb, a * 0.25);
      g.circle('fill', px, py, s * 2.2);
      g.setColor(wr, wg, wb, a);
      g.circle('fill', px, py, s);
    }
  }

  g.setBlendMode('alpha');
  g.setColor(1, 1, 1, 1);
};

export default TransporterEffect;
