// js/world/Planetoid.js
//
// The basic round body: drifts, has gravity reach (influenceRadius), a
// baked textured body canvas with a soft blue halo, sun shading applied
// by a shader as that canvas is drawn, and an eclipse shadow cast away
// from the sun.

import love from '../love/index.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import constants from '../constants.js';

let sunOverlayCanvas = null;

function createRadialGradientMesh(segments = 48) {
  const vertices = [[0, 0, 0.5, 0.5, 1, 1, 1, 1]];
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const x = Math.cos(angle), y = Math.sin(angle);
    vertices.push([x, y, 0.5 + x * 0.5, 0.5 + y * 0.5, 0, 0, 0, 1]);
  }
  return love.graphics.newMesh(vertices, 'fan', 'static');
}

let radialGradientMesh = null;

// Sun shading, applied by a shader AS the body canvas is drawn (see
// Planetoid.draw) rather than as separate shapes laid over it
// afterward. For each pixel of the canvas it works out where that pixel
// is on the planetoid (q: 0 at the center, length 1 at the body's own
// edge) and from that:
//   - the lit-side/dark-side gradient, MULTIPLIED onto the body's color
//     — centered half a radius toward the sun and running out over 1.6
//     radii, at SUN_LIT_BRIGHTNESS;
//   - the flat SUN_OVERALL_DARKEN, scaled by how close the sun is;
//   - the soft HIGHLIGHT, added on the sun-facing side.
// Only the body is touched (length(q) <= 1) — the halo outside it is
// passed straight through. The edge the shading stops at is computed
// from the very same canvas coordinates the body's edge sits at, so the
// two cannot disagree — and it's blended across the rim pixel (fwidth)
// in proportion to how much of that pixel is body.
let sunShadingShader = null;
function getSunShadingShader() {
  if (sunShadingShader) return sunShadingShader;
  sunShadingShader = love.graphics.newShader(`
    extern vec2 lightDir;        // unit vector on screen, toward the sun
    extern float bodyFraction;   // the body's radius as a fraction of half the canvas (the rest is halo padding)
    extern float sunStrength;    // 0..1, how close the sun is
    extern float litBrightness;
    extern float overallDarken;
    extern float highlightAlpha;
    extern float highlightSize;
    extern float highlightOffset;
    extern float shadingMix;     // 0..1, how much of the shading/highlight shows (1 = planetoids' full look)

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec4 texel = Texel(tex, uv) * color;

      vec2 q = (uv - vec2(0.5)) * 2.0 / bodyFraction;
      float dist = length(q);
      float edge = max(fwidth(dist), 1e-5);
      float body = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, dist);
      if (body <= 0.0) return texel;

      float lit = clamp(1.0 - length(q - lightDir * 0.5) / 1.6, 0.0, 1.0) * litBrightness;
      float shade = lit * (1.0 - sunStrength * overallDarken);

      float h = clamp(1.0 - length(q - lightDir * highlightOffset) / highlightSize, 0.0, 1.0);
      h = h * h * highlightAlpha;

      vec3 shaded = texel.rgb * shade + vec3(1.0, 0.98, 0.92) * h * texel.a;
      return vec4(mix(texel.rgb, shaded, body * shadingMix), texel.a);
    }
  `);
  return sunShadingShader;
}

function getSunOverlayCanvas() {
  if (sunOverlayCanvas) return sunOverlayCanvas;
  if (!radialGradientMesh) radialGradientMesh = createRadialGradientMesh();

  const d = Planetoid.SUN_OVERLAY_DIAMETER;
  const r = d / 2;
  const offset = -r * 0.5;

  const canvas = love.graphics.newCanvas(d, d);
  love.graphics.push();
  love.graphics.origin();
  love.graphics.setCanvas({ 0: canvas, stencil: true });
  love.graphics.clear(0, 0, 0, 0);
  love.graphics.setBlendMode('alpha');

  love.graphics.stencil(() => {
    love.graphics.circle('fill', r, r, r);
  }, 'replace', 1);
  love.graphics.setStencilTest('greater', 0);

  love.graphics.setColor(1, 1, 1, 1);
  love.graphics.draw(radialGradientMesh, r, r + offset, 0, r * 1.6, r * 1.6);

  love.graphics.setStencilTest();
  love.graphics.setCanvas();
  love.graphics.pop();

  sunOverlayCanvas = canvas;
  return sunOverlayCanvas;
}

// Baking a body canvas is real GPU work. Left uncapped, a single frame
// where many never-before-seen planetoids all become visible at once
// (e.g. scrolling into a freshly generated belt cell) bakes all of them
// in that one frame — a visible stall. Capping how many NEW bakes happen
// per frame spreads that burst across a handful of frames; draw()'s
// fallback (a plain red circle) covers the gap. Planetoid.beginFrame()
// resets the counter once per frame, from love.draw() in main.js.
let bodyCanvasBakesThisFrame = 0;

// Shared across every planetoid with a matching (color, radius) pair —
// keyed on this.color BY REFERENCE (callers reuse the same color array
// for "the same color", e.g. WorldGen.js's randomColor()) nested under
// this.radius. Since colors come from a small fixed swatch list and
// generated radii are snapped to 5px steps, the number of distinct
// pairs is small and bounded.
const sharedBodyCanvasCache = new Map();

// How far out the sun's shading reaches before it's gone: a fixed
// distance (the original 60000-unit map's half-diagonal), not the map's
// own size — so making the map bigger doesn't change how anything
// already out there is lit.
const SUN_SHADING_REACH = Math.sqrt(60000 * 60000 * 2) / 2;

class Planetoid {
  static new(x, y, radius, color) {
    return new Planetoid(x, y, radius, color);
  }

  constructor(x, y, radius, color) {
    this.pos = new Vector2(x, y);
    this.radius = radius;
    this.mass = radius * radius;
    this.influenceRadius = radius + constants.INFLUENCE_PADDING;
    this.color = color;
    const direction = new Vector2(Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
    this.vel = direction.multiply(constants.PLANET_SPEED);
    this.isSpikey = false;
    this.bodyCanvas = null;
    this.bodyCanvasPadding = 0;
    this.interiorType = null;
    this.eclipseMesh = null;
  }

  static beginFrame() {
    bodyCanvasBakesThisFrame = 0;
  }

  ensureBodyCanvas() {
    if (this.bodyCanvas) return;
    if (!state.planetTexture) return;

    this.bodyCanvasPadding = Planetoid.SHADOW_PADDING;

    let colorCache = sharedBodyCanvasCache.get(this.color);
    const cachedCanvas = colorCache && colorCache.get(this.radius);
    if (cachedCanvas) {
      this.bodyCanvas = cachedCanvas;
      return;
    }

    if (bodyCanvasBakesThisFrame >= Planetoid.MAX_BODY_CANVAS_BAKES_PER_FRAME) return;
    bodyCanvasBakesThisFrame++;

    const r = this.radius;
    const padding = Planetoid.SHADOW_PADDING;

    const scale = 2;
    const size = (r * 2 + padding * 2) * scale;
    const cx = (r + padding) * scale, cy = (r + padding) * scale;
    const bakeR = r * scale;
    const bakePadding = padding * scale;

    const finalCanvas = love.graphics.newCanvas(size, size);
    finalCanvas.setFilter('linear', 'linear');

    love.graphics.push();
    love.graphics.origin();
    love.graphics.setCanvas({ 0: finalCanvas, stencil: true });
    love.graphics.clear(0, 0, 0, 0);
    love.graphics.setBlendMode('alpha');

    const GLOW_LAYERS = 18;
    for (let i = GLOW_LAYERS; i >= 1; i--) {
      const t = i / GLOW_LAYERS;
      const glowR = bakeR + bakePadding * t;
      // Quadratic falloff = much softer / more blurred look
      const falloff = (1 - t) * (1 - t);
      const glowAlpha = Planetoid.SHADOW_COLOR[3] * falloff * 0.85;
      love.graphics.setColor(Planetoid.SHADOW_COLOR[0], Planetoid.SHADOW_COLOR[1], Planetoid.SHADOW_COLOR[2], glowAlpha);
      love.graphics.circle('fill', cx, cy, glowR);
    }

    love.graphics.stencil(() => {
      love.graphics.circle('fill', cx, cy, bakeR);
    }, 'replace', 1);
    love.graphics.setStencilTest('greater', 0);

    const tiles = 2.5;
    const [texW, texH] = state.planetTexture.getDimensions();
    const texSize = bakeR * 2 * tiles;
    love.graphics.setColor(this.color[0], this.color[1], this.color[2], this.color[3] ?? 1);
    love.graphics.draw(state.planetTexture, cx, cy, 0, texSize / texW, texSize / texH, texW / 2, texH / 2);

    // A second, additive pass of the same tinted texture lifts the whole
    // body by BODY_BRIGHTEN (a plain tint can only ever darken a texture).
    if (Planetoid.BODY_BRIGHTEN > 0) {
      const lift = Planetoid.BODY_BRIGHTEN;
      love.graphics.setBlendMode('add', 'alphamultiply');
      love.graphics.setColor(this.color[0], this.color[1], this.color[2], lift);
      love.graphics.draw(state.planetTexture, cx, cy, 0, texSize / texW, texSize / texH, texW / 2, texH / 2);
      love.graphics.setBlendMode('alpha');
    }

    love.graphics.setStencilTest();
    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.setCanvas();
    love.graphics.pop();

    this.bodyCanvas = finalCanvas;

    colorCache = sharedBodyCanvasCache.get(this.color);
    if (!colorCache) {
      colorCache = new Map();
      sharedBodyCanvasCache.set(this.color, colorCache);
    }
    colorCache.set(this.radius, finalCanvas);
  }

  draw() {
    // Shadow first (behind everything)
    this.drawEclipseShadow();

    this.ensureBodyCanvas();

    if (this.bodyCanvas) {
      const padding = this.bodyCanvasPadding ?? 0;
      const shader = this.applySunShading(padding);
      love.graphics.setColor(1, 1, 1, 1);
      love.graphics.draw(
        this.bodyCanvas,
        this.pos.x - this.radius - padding,
        this.pos.y - this.radius - padding,
        0,
        0.5, 0.5,
      );
      if (shader) love.graphics.setShader();
    } else {
      love.graphics.setColor(1, 0, 0, 1);
      love.graphics.circle('fill', this.pos.x, this.pos.y, this.radius);
      love.graphics.setColor(1, 1, 1, 1);
    }
  }

  // Turns the sun-shading shader on for the body canvas about to be
  // drawn. Returns the shader so the caller can turn it back off, or
  // null if this one is too far from the sun to be shaded at all.
  applySunShading(padding) {
    return Planetoid.applySunShadingAt(this.pos.x, this.pos.y, this.radius, padding);
  }

  // The same, for any round body baked the planetoid way — an image
  // with the body centered and `padding` of margin round it — so other
  // things (the pinball bumpers, see PinballInterior.js) can share the
  // planetoids' exact look. mix (optional, 0..1, default 1) softens it.
  static applySunShadingAt(x, y, radius, padding, mix) {
    const sunX = state.sceneWidth / 2;
    const sunY = state.sceneHeight / 2;
    const toSunX = sunX - x;
    const toSunY = sunY - y;
    const distToSun = Math.sqrt(toSunX * toSunX + toSunY * toSunY);

    const strength = 1 - Math.min(distToSun / SUN_SHADING_REACH, 1);
    if (strength <= 0.01 || distToSun < 1) return null;

    const shader = getSunShadingShader();
    shader.send('lightDir', [toSunX / distToSun, toSunY / distToSun]);
    shader.send('bodyFraction', radius / (radius + padding));
    shader.send('sunStrength', strength);
    shader.send('litBrightness', Planetoid.SUN_LIT_BRIGHTNESS);
    shader.send('overallDarken', Planetoid.SUN_OVERALL_DARKEN);
    shader.send('highlightAlpha', Planetoid.HIGHLIGHT_ALPHA);
    shader.send('highlightSize', Planetoid.HIGHLIGHT_SIZE);
    shader.send('highlightOffset', Planetoid.HIGHLIGHT_OFFSET);
    shader.send('shadingMix', mix ?? 1);
    love.graphics.setShader(shader);
    return shader;
  }

  // Lets things built on Planetoid.new that override draw() (e.g.
  // CrystalPlanet) still call the shared shadow.
  static drawEclipseShadow(planet) {
    Planetoid.prototype.drawEclipseShadow.call(planet);
  }

  // Soft widening trapezoidal shadow (single mesh, fades to nothing)
  drawEclipseShadow() {
    const sunX = state.sceneWidth / 2;
    const sunY = state.sceneHeight / 2;
    const dx = this.pos.x - sunX;
    const dy = this.pos.y - sunY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) return;

    // The sun's own visible glow reaches about 4000 units — anything
    // visibly sitting in it gets a shadow, fading toward its edge.
    const maxShadowDist = 4000;
    const proximity = 1 - Math.min(dist / maxShadowDist, 1);
    if (proximity < 0.05) return;

    const invLen = 1 / dist;
    const dirX = dx * invLen; // away from the sun
    const dirY = dy * invLen;
    const perpX = -dirY;
    const perpY = dirX;

    const shadowStrength = proximity * 0.55;
    const shadowLength = this.radius * (5.0 + proximity * 7.0);

    // Short base (near the planet) ≈ diameter of the planet; long base wider
    const nearHalfWidth = this.radius;
    const farHalfWidth = this.radius * 2.8;

    const nearDist = 0;
    const farDist = nearDist + shadowLength;

    const n1x = this.pos.x + dirX * nearDist + perpX * nearHalfWidth;
    const n1y = this.pos.y + dirY * nearDist + perpY * nearHalfWidth;
    const n2x = this.pos.x + dirX * nearDist - perpX * nearHalfWidth;
    const n2y = this.pos.y + dirY * nearDist - perpY * nearHalfWidth;

    const f1x = this.pos.x + dirX * farDist + perpX * farHalfWidth;
    const f1y = this.pos.y + dirY * farDist + perpY * farHalfWidth;
    const f2x = this.pos.x + dirX * farDist - perpX * farHalfWidth;
    const f2y = this.pos.y + dirY * farDist - perpY * farHalfWidth;

    // Order: near1, near2, far2, far1 — opaque near, transparent far
    const vertices = [
      [n1x, n1y, 0, 0, 0, 0, 0, shadowStrength],
      [n2x, n2y, 0, 0, 0, 0, 0, shadowStrength],
      [f2x, f2y, 0, 0, 0, 0, 0, 0],
      [f1x, f1y, 0, 0, 0, 0, 0, 0],
    ];

    // Reused across frames (rewritten in place) instead of a new mesh
    // every frame.
    if (!this.eclipseMesh) {
      this.eclipseMesh = love.graphics.newMesh(vertices, 'fan', 'dynamic');
    } else {
      this.eclipseMesh.setVertices(vertices);
    }

    love.graphics.setBlendMode('alpha');
    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.draw(this.eclipseMesh);

    love.graphics.setColor(1, 1, 1, 1);
  }
}

Planetoid.VERSION = 'textured-body-with-sun-shading-6';

// Original glow
Planetoid.SHADOW_BLUR = 200;
Planetoid.SHADOW_PADDING = 45;
// The soft halo round every planetoid: a pale blue.
Planetoid.SHADOW_COLOR = [120 / 255, 185 / 255, 255 / 255, 0.26];

Planetoid.SUN_OVERLAY_DIAMETER = 200;
Planetoid.SUN_MIN_ALPHA = 0.15;
Planetoid.SUN_MAX_ALPHA = 0.95;
Planetoid.SUN_MAX_DARKNESS = 0.18;

// The highlight on the sun-facing side — a soft bright spot, the thing
// that makes a shaded disc read as a sphere: how bright it is at its
// center, how big it is relative to the radius, and how far out (toward
// the sun) it sits. HIGHLIGHT_ALPHA = 0 turns it off.
Planetoid.HIGHLIGHT_ALPHA = 0.22;
Planetoid.HIGHLIGHT_SIZE = 0.55;
Planetoid.HIGHLIGHT_OFFSET = 0.48;

// SUN_LIT_BRIGHTNESS: how much of its own color the sun-facing side
// keeps. SUN_OVERALL_DARKEN: a flat darkening over the whole planetoid.
// BODY_BRIGHTEN: how much the body's own texture is lifted when baked.
Planetoid.SUN_LIT_BRIGHTNESS = 1.0;
Planetoid.SUN_OVERALL_DARKEN = 0.08;
Planetoid.BODY_BRIGHTEN = 0.18;

Planetoid.MAX_BODY_CANVAS_BAKES_PER_FRAME = 3;

Planetoid._getSunOverlayCanvasForDiagnostics = getSunOverlayCanvas;

export default Planetoid;
