// js/effects/PullBeam.js
//
// Draws the light-blue pull beam while the player is actively pulling
// toward a planet, all of it additive light:
//   * the beam itself (one quad through a shader): a hot white core, a
//     cyan body of rippling plasma, flaring a little wider toward the
//     target, with bright bands of energy streaming back down it toward
//     Bob — it reads as pulling;
//   * two strands twisting round it as a helix, pinned at both ends, and
//     a flickering lightning arc;
//   * sparks drifting back down the beam;
//   * a flare at the blaster's muzzle;
//   * on the target: a splash of light where the beam meets its surface,
//     its outline, and (round targets) rotating brackets plus rings
//     closing in on it.
// Animated in game time (state.timeScale), so V.A.T.S. slow-mo slows it.

import love from '../love/index.js';
import lua from '../love/lua.js';
import state from '../state.js';

// ---------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------

const COLOR = [120 / 255, 210 / 255, 255 / 255];
const COLOR_HOT = [215 / 255, 246 / 255, 255 / 255];

const BEAM_HALF_WIDTH = 22;      // world units, at the target end (the shader's quad)
const BEAM_START_FRACTION = 0.3; // how wide it is at the muzzle, as a fraction of that

const OUTLINE_GLOW_WIDTH = 9;
const OUTLINE_CORE_WIDTH = 3;
const OUTLINE_PADDING = 8;

const HELIX_AMPLITUDE = 11;      // world units, at the beam's middle
const HELIX_WAVELENGTH = 90;     // world units per twist
const HELIX_SPEED = 9;           // radians per second
const HELIX_SAMPLE_SPACING = 6;

const BOLT_INTERVAL = 0.06;      // seconds between lightning re-shapes
const BOLT_SEGMENT = 18;         // world units per jag
const BOLT_JITTER = 9;           // world units, at the beam's middle

const SPARKS_PER_100_UNITS = 5;  // per second, per 100 units of beam
const SPARK_SPEED = 260;         // world units per second, back toward Bob
const SPARK_LIFE = 0.6;          // seconds

const RING_PERIOD = 0.7;         // seconds for each closing-in ring
const RING_START_GAP = 46;       // how far outside the outline a ring starts

// ---------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------

let beamShader = null;
function getBeamShader() {
  if (beamShader) return beamShader;
  beamShader = love.graphics.newShader(`
    extern number time;
    extern number len;         // beam length, world units
    extern number halfWidth;   // the quad's half-width, world units
    extern number startFrac;   // the beam's width at the muzzle, as a fraction of that
    extern number pulse;       // 0..1 breathing
    extern vec3 color;
    extern vec3 hot;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                 mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }
    float fbm(vec2 p) {
      float v = 0.0;
      float a = 0.5;
      for (int k = 0; k < 3; k++) {
        v += a * noise(p);
        p = p * 2.07 + vec2(3.1, 7.7);
        a *= 0.5;
      }
      return v;
    }

    // uv.x: 0 at the muzzle .. 1 at the target; uv.y across the beam.
    vec4 effect(vec4 vcolor, Image tex, vec2 uv, vec2 screen) {
      float s = uv.x * len;                      // world units from the muzzle
      float v = uv.y * 2.0 - 1.0;
      float d = v * halfWidth;                   // world units from the axis
      // Wobbling a little, and flaring wider toward the target.
      d += (noise(vec2(s * 0.03 + time * 3.0, 1.7)) - 0.5) * 3.0;
      float spread = halfWidth * mix(startFrac, 1.0, smoothstep(0.0, 1.0, uv.x));
      float a = d / spread;                      // -1..1 across the beam, here

      float core = exp(-d * d / 2.2);
      float inner = exp(-a * a * 6.0);
      float outer = exp(-a * a * 2.0) * (1.0 - smoothstep(0.75, 1.0, abs(a)));

      // Plasma, and bands of energy, both streaming back toward the muzzle.
      float n = fbm(vec2(s * 0.018 + time * 2.2, a * 1.8));
      float band = pow(0.5 + 0.5 * sin(s * 0.09 + time * 16.0), 5.0);

      float ends = smoothstep(0.0, min(0.2, 14.0 / max(len, 1.0)), uv.x);

      vec3 rgb = color * outer * (0.3 + 0.7 * n) * (0.8 + 0.3 * pulse)
               + color * inner * (0.4 + 0.8 * band)
               + hot * core * (0.85 + 0.15 * pulse);
      return vec4(rgb * ends, 1.0);
    }
  `);
  return beamShader;
}

let pixelImage = null;
function getPixel() {
  if (pixelImage) return pixelImage;
  const data = love.image.newImageData(1, 1);
  data.setPixel(0, 0, 1, 1, 1, 1);
  pixelImage = love.graphics.newImage(data);
  return pixelImage;
}

// A soft round glow, fading smoothly to nothing at its edge.
const GLOW_SIZE = 64;
let glowImage = null;
function getGlow() {
  if (glowImage) return glowImage;
  const data = love.image.newImageData(GLOW_SIZE, GLOW_SIZE);
  const half = GLOW_SIZE / 2;
  data.mapPixel((x, y) => {
    const d = Math.sqrt((x + 0.5 - half) ** 2 + (y + 0.5 - half) ** 2) / half;
    const v = Math.max(0, 1 - d);
    return [1, 1, 1, v * v];
  });
  glowImage = love.graphics.newImage(data);
  glowImage.setFilter('linear', 'linear');
  return glowImage;
}

function drawGlow(x, y, diameter, r, g, b, a) {
  const img = getGlow();
  love.graphics.setColor(r, g, b, a);
  love.graphics.draw(img, x, y, 0, diameter / GLOW_SIZE, diameter / GLOW_SIZE, GLOW_SIZE / 2, GLOW_SIZE / 2);
}

// ---------------------------------------------------------------------
// State carried between frames (only while a pull is going on)
// ---------------------------------------------------------------------

let time = 0;
let bolt = null;  // { timer, offsets: [[u, off], ...] }
let sparks = [];  // { u, off, life }
let sparkBudget = 0;

function reset() {
  bolt = null;
  sparks = [];
  sparkBudget = 0;
}

// Strokes `points` (a flat x1, y1, x2, y2, ... list) twice: a wide faint
// glow, then a thin bright core.
function strokeGlowing(points, glowWidth, coreWidth, glowA, coreA) {
  if (points.length < 4) return;
  love.graphics.setLineWidth(glowWidth);
  love.graphics.setColor(COLOR[0], COLOR[1], COLOR[2], glowA);
  love.graphics.line(points);
  love.graphics.setLineWidth(coreWidth);
  love.graphics.setColor(COLOR_HOT[0], COLOR_HOT[1], COLOR_HOT[2], coreA);
  love.graphics.line(points);
}

// How far along the beam (0..1) fades the strands/bolt in and out, so
// they're pinned at both ends.
function envelope(u) {
  return Math.sin(Math.PI * u);
}

function drawPullIndicator() {
  const player = state.player;
  if (!player || !player.pullTarget || player.mode !== 'space') {
    reset();
    return;
  }

  const target = player.pullTarget;
  const dt = (state.timeScale ?? 1) / 60;
  time += dt;
  const pulse = (Math.sin(time * 6) + 1) / 2; // ~0..1 breathing

  // Out of the blaster's own muzzle (the hole at the end of his arm),
  // same as a fireball.
  const [originX, originY] = player.getMuzzlePosition();
  const dx = target.pos.x - originX;
  const dy = target.pos.y - originY;
  const toCenter = Math.sqrt(dx * dx + dy * dy);
  if (toCenter < 1e-3) return;
  const dirX = dx / toCenter, dirY = dy / toCenter;
  const perpX = -dirY, perpY = dirX;

  // The beam stops where it meets the target's surface (roughly, for a
  // rounded rect: its shorter half-extent), not its centre.
  const surfaceInset = target.isRoundedRect
    ? Math.min(target.halfWidth ?? target.radius, target.halfHeight ?? target.radius)
    : target.radius;
  const len = Math.max(8, toCenter - surfaceInset);
  const endX = originX + dirX * len, endY = originY + dirY * len;
  const at = (u, off) => {
    const s = u * len;
    return [originX + dirX * s + perpX * off, originY + dirY * s + perpY * off];
  };

  love.graphics.push('all');
  love.graphics.setBlendMode('add');
  love.graphics.setLineStyle('smooth');
  love.graphics.setLineJoin('bevel');

  // The beam.
  const shader = getBeamShader();
  shader.send('time', time);
  shader.send('len', len);
  shader.send('halfWidth', BEAM_HALF_WIDTH);
  shader.send('startFrac', BEAM_START_FRACTION);
  shader.send('pulse', pulse);
  shader.send('color', COLOR);
  shader.send('hot', COLOR_HOT);
  love.graphics.setShader(shader);
  love.graphics.setColor(1, 1, 1, 1);
  love.graphics.draw(getPixel(), originX - perpX * BEAM_HALF_WIDTH, originY - perpY * BEAM_HALF_WIDTH,
    Math.atan2(dirY, dirX), len, BEAM_HALF_WIDTH * 2);
  love.graphics.setShader();

  // Helix strands, half a twist apart, pinned at both ends.
  const samples = Math.max(2, Math.floor(len / HELIX_SAMPLE_SPACING));
  for (let strand = 0; strand <= 1; strand++) {
    const points = [];
    for (let i = 0; i <= samples; i++) {
      const u = i / samples;
      const phase = (u * len) / HELIX_WAVELENGTH * Math.PI * 2 + time * HELIX_SPEED + strand * Math.PI;
      const [x, y] = at(u, Math.sin(phase) * HELIX_AMPLITUDE * envelope(u));
      points.push(x, y);
    }
    strokeGlowing(points, 5, 1.5, 0.12 + 0.08 * pulse, 0.55 + 0.3 * pulse);
  }

  // Lightning: a jagged arc down the beam, re-shaped every few frames.
  if (!bolt || bolt.timer <= 0) {
    const jags = Math.max(2, Math.floor(len / BOLT_SEGMENT));
    const offsets = [];
    for (let i = 0; i <= jags; i++) {
      const u = i / jags;
      offsets.push([u, (Math.random() * 2 - 1) * BOLT_JITTER * envelope(u)]);
    }
    bolt = { timer: BOLT_INTERVAL, offsets };
  }
  bolt.timer -= dt;
  const boltPoints = [];
  for (const o of bolt.offsets) {
    const [x, y] = at(o[0], o[1]);
    boltPoints.push(x, y);
  }
  strokeGlowing(boltPoints, 4, 1.2, 0.15, 0.4 + 0.4 * Math.random());

  // Sparks, drifting back down the beam toward Bob.
  sparkBudget += SPARKS_PER_100_UNITS * (len / 100) * dt;
  while (sparkBudget >= 1) {
    sparkBudget -= 1;
    const u = 0.15 + Math.random() * 0.85;
    sparks.push({ u, off: (Math.random() * 2 - 1) * BEAM_HALF_WIDTH * 0.5 * u, life: 1 });
  }
  for (let i = sparks.length - 1; i >= 0; i--) {
    const sp = sparks[i];
    sp.u -= SPARK_SPEED * dt / len;
    sp.off *= (1 - 1.5 * dt);
    sp.life -= dt / SPARK_LIFE;
    if (sp.life <= 0 || sp.u <= 0) {
      sparks.splice(i, 1);
    } else {
      const [x, y] = at(sp.u, sp.off);
      drawGlow(x, y, 16, COLOR[0], COLOR[1], COLOR[2], 0.7 * sp.life);
      love.graphics.setColor(COLOR_HOT[0], COLOR_HOT[1], COLOR_HOT[2], sp.life);
      love.graphics.circle('fill', x, y, 1.8);
    }
  }

  // Muzzle flare: a glow and a turning four-point star.
  drawGlow(originX, originY, 44 + 10 * pulse, COLOR[0], COLOR[1], COLOR[2], 0.85);
  drawGlow(originX, originY, 16, COLOR_HOT[0], COLOR_HOT[1], COLOR_HOT[2], 1);
  const starA = time * 2.5;
  const starR = 11 + 3 * pulse;
  love.graphics.setLineWidth(1.5);
  love.graphics.setColor(COLOR_HOT[0], COLOR_HOT[1], COLOR_HOT[2], 0.7);
  for (let k = 0; k <= 1; k++) {
    const a = starA + k * Math.PI / 2;
    const cx = Math.cos(a) * starR, cy = Math.sin(a) * starR;
    love.graphics.line(originX - cx, originY - cy, originX + cx, originY + cy);
  }

  // Where it meets the target: a splash of light.
  drawGlow(endX, endY, 80 + 16 * pulse, COLOR[0], COLOR[1], COLOR[2], 0.75);
  drawGlow(endX, endY, 26, COLOR_HOT[0], COLOR_HOT[1], COLOR_HOT[2], 1);

  // Outline around the target
  if (target.isRoundedRect) {
    // A true rotated rounded-rect outline, matching the target's own
    // actual silhouette. Each half-extent AND the corner radius all get
    // the same OUTLINE_PADDING added, so the outline sits evenly outset
    // from the real edge all the way around.
    const hw = (target.halfWidth ?? target.radius) + OUTLINE_PADDING;
    const hh = (target.halfHeight ?? target.radius) + OUTLINE_PADDING;
    const cr = (target.cornerRadius ?? 0) + OUTLINE_PADDING;

    love.graphics.push();
    love.graphics.translate(target.pos.x, target.pos.y);
    love.graphics.rotate(target.rotationAngle ?? 0);

    love.graphics.setLineWidth(OUTLINE_GLOW_WIDTH);
    love.graphics.setColor(COLOR[0], COLOR[1], COLOR[2], 0.3 * (0.4 + pulse * 0.4));
    love.graphics.rectangle('line', -hw, -hh, hw * 2, hh * 2, cr, cr);

    love.graphics.setLineWidth(OUTLINE_CORE_WIDTH);
    love.graphics.setColor(COLOR[0], COLOR[1], COLOR[2], 0.7 + pulse * 0.3);
    love.graphics.rectangle('line', -hw, -hh, hw * 2, hh * 2, cr, cr);

    love.graphics.pop();
  } else {
    const tx = target.pos.x, ty = target.pos.y;
    const ringR = target.radius + OUTLINE_PADDING;

    love.graphics.setLineWidth(OUTLINE_GLOW_WIDTH);
    love.graphics.setColor(COLOR[0], COLOR[1], COLOR[2], 0.3 * (0.4 + pulse * 0.4));
    love.graphics.circle('line', tx, ty, ringR);
    love.graphics.setLineWidth(OUTLINE_CORE_WIDTH);
    love.graphics.setColor(COLOR[0], COLOR[1], COLOR[2], 0.7 + pulse * 0.3);
    love.graphics.circle('line', tx, ty, ringR);

    // Three brackets turning round it, just outside the outline.
    const bracketR = ringR + 10;
    const spin = time * 1.6;
    love.graphics.setLineWidth(3);
    love.graphics.setColor(COLOR_HOT[0], COLOR_HOT[1], COLOR_HOT[2], 0.55 + 0.3 * pulse);
    for (let k = 0; k <= 2; k++) {
      const a = spin + k * Math.PI * 2 / 3;
      love.graphics.arc('line', 'open', tx, ty, bracketR, a, a + 0.55, 12);
    }

    // Rings closing in on it — being reeled in.
    love.graphics.setLineWidth(2);
    for (let k = 0; k <= 1; k++) {
      const phase = lua.mod(time / RING_PERIOD + k * 0.5, 1);
      const r = ringR + RING_START_GAP * (1 - phase);
      love.graphics.setColor(COLOR[0], COLOR[1], COLOR[2], 0.45 * Math.sin(Math.PI * phase));
      love.graphics.circle('line', tx, ty, r);
    }
  }

  love.graphics.pop();
}

export default {
  draw: drawPullIndicator,
};
