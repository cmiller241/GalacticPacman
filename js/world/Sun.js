// js/world/Sun.js
//
// Visual sun at the centre of the scene.
// Smooth radial gradient glow + a flat-filled core disc textured with a
// plasma shader: layered fractal noise forms a mottled, granular
// surface (colored by a fixed warm brightness ramp, not a hue-cycling
// palette) with darker sunspot blotches, all scrolling together to
// fake axial rotation. Both the glow and the core pulse.
// No gravity, no collision.

import love from '../love/index.js';
import state from '../state.js';

// ---------------------------------------------------------------------
// TUNABLES
// ---------------------------------------------------------------------
const RADIUS = 800;

// Flat-filled core disc — a solid circle, only blurred/faded right at
// its own rim, sitting inside the gradient glow. Its fill is painted by
// the plasma shader below rather than a flat color.
const CORE_DIAMETER = 3500;
const CORE_RADIUS = CORE_DIAMETER / 2;
// A fraction of CORE_RADIUS rather than a fixed pixel count, so the
// granulated surface actually dissolves into the corona.
const CORE_EDGE_BLUR_FRAC = 0.16;
const CORE_EDGE_BLUR = CORE_RADIUS * CORE_EDGE_BLUR_FRAC; // px of soft fade at the core's edge
// Fraction of the core's own radius that stays fully solid before the
// blur ring takes over — shared by both the solid disc draw and the
// ring-fade mesh's own geometry so the two always meet exactly.
const CORE_INNER_FRAC = 1 - CORE_EDGE_BLUR / CORE_RADIUS;

const SUN_INTENSITY = 16.0;

// Pulse
const PULSE_SPEED = 3;         // how fast it breathes (higher = faster)
const PULSE_AMOUNT = 0.045;    // how much the size changes (0.04 = ±4%)
const PULSE_INTENSITY = 0.12;  // how much the brightness pulses

// Plasma shader on the core — layered fractal noise (fbm) forming a
// granular, mottled surface (like solar granulation), colored by a small
// fixed warm ramp driven by the noise's own brightness. Granulation AND
// sunspots share the same horizontal scroll, so the whole surface drifts
// together — that's what makes the rotation read.
const PLASMA_SCALE = 7.0;          // spatial frequency of the granulation (higher = smaller cells)
const PLASMA_DETAIL_SCALE = 2.4;   // extra frequency multiplier for the fine speckle pass
const PLASMA_EVOLVE_SPEED = 0.05;  // how fast the granulation itself boils/changes shape in place
const PLASMA_SCROLL_SPEED = -0.12; // pattern drift speed (negative = drifts left = rotation)

// plasmaTime feeds the shader's noise as an elapsed-seconds value. GPU
// floats are 32-bit; once that value climbs into the thousands its
// per-frame increment drops below float precision and the surface
// jitters and wobbles. update() wraps it every PLASMA_TIME_WRAP seconds,
// far below where that starts. The wrap reshuffles the noise pattern
// once every few minutes, which reads as unnoticeable.
const PLASMA_TIME_WRAP = 300;

// Red-dominant body: DARK/MID cover most of the disc, WARM is a rarer
// transition tone, and HOT (yellow) is reserved for genuine noise peaks —
// and is the color the rim glow pulls toward near the disc's true edge.
const PLASMA_COLOR_DARK = [0.48, 0.12, 0.02]; // intergranular lanes / coolest, deep red
const PLASMA_COLOR_MID = [1.0, 0.32, 0.05];   // saturated red-orange — the base tone across most of the body
const PLASMA_COLOR_WARM = [1.0, 0.60, 0.15];  // orange, transition tone
const PLASMA_COLOR_HOT = [1.0, 0.90, 0.35];   // yellow — the dedicated rim-glow color
// Extra multiplier on top of the pulse's own brightness swing.
const CORE_BRIGHTNESS = 1.2;

const SPOT_SCALE = 0.6;      // spatial frequency of the sunspot pattern
const SPOT_THRESHOLD = 0.2;  // how much of the pattern becomes a spot (higher = fewer spots)
const SPOT_SOFTNESS = 0.10;  // edge softness of each spot
const SPOT_DARKEN = 0.9;     // how dark a spot gets (0 = black, 1 = no darkening)

// The plasma shader's spatial frequencies are tuned for the sun
// appearing at roughly this on-screen radius (px, post zoom). draw()
// scales the frequencies down when the sun is smaller on screen, so
// cells stay roughly a constant SCREEN size instead of aliasing into
// static.
const PLASMA_REFERENCE_SCREEN_RADIUS = 500;
const PLASMA_MIN_SCALE_FACTOR = 0.15; // never fully flatten out at extreme distance
// ---------------------------------------------------------------------

function createSunGradientMesh(segments = 64) {
  const vertices = [[0, 0, 0.5, 0.5, 1, 1, 1, 1]];
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const x = Math.cos(angle);
    const y = Math.sin(angle);
    vertices.push([x, y, 0.5 + x * 0.5, 0.5 + y * 0.5, 1, 1, 1, 0]);
  }
  return love.graphics.newMesh(vertices, 'fan', 'static');
}

// A thin RING going from fully opaque at innerFrac*radius to fully
// transparent at radius — drawn on top of a flat-filled circle of radius
// innerFrac*radius so only the disc's outer rim actually fades.
function createRingFadeMesh(innerFrac, segments = 96) {
  const vertices = [];
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const cx = Math.cos(angle), cy = Math.sin(angle);
    const ix = cx * innerFrac, iy = cy * innerFrac;
    vertices.push([ix, iy, 0.5 + ix * 0.5, 0.5 + iy * 0.5, 1, 1, 1, 1]);
    vertices.push([cx, cy, 0.5 + cx * 0.5, 0.5 + cy * 0.5, 1, 1, 1, 0]);
  }
  return love.graphics.newMesh(vertices, 'strip', 'static');
}

// Uses screen_coords + a center/radius uniform for its local disc
// coordinate, NOT texture_coords — that works for both the solid circle
// fill and the ring mesh alike. Multiplying by the incoming `color` lets
// the same shader paint the opaque inner fill AND the fading ring.
function createPlasmaShader() {
  return love.graphics.newShader(`
    extern vec2 center;
    extern number radius;
    extern number baseRadius;
    extern number time;
    extern number brightness;
    extern number plasmaScale;
    extern number detailScale;
    extern number evolveSpeed;
    extern number scrollSpeed;
    extern vec3 colorDark;
    extern vec3 colorMid;
    extern vec3 colorWarm;
    extern vec3 colorHot;
    extern number spotScale;
    extern number spotThreshold;
    extern number spotSoftness;
    extern number spotDarken;

    // Cheap scramble hash (Dave Hoskins-style).
    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    // Bilinear value noise, smoothed with a Hermite curve.
    float valueNoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      float a = hash(i);
      float b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0));
      float d = hash(i + vec2(1.0, 1.0));
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }

    // Fractal Brownian motion — the mottled, multi-scale texture actual
    // solar granulation has.
    float fbm(vec2 p) {
      float value = 0.0;
      float amp = 0.5;
      for (int i = 0; i < 5; i++) {
        value += amp * valueNoise(p);
        p *= 2.02;
        amp *= 0.55;
      }
      return value;
    }

    vec4 effect(vec4 color, Image tex, vec2 texture_coords, vec2 screen_coords) {
      // Radial distance (0 at center, 1 at the disc's true, pulsing edge)
      // — the rim glow needs to track the actual edge as it breathes.
      vec2 rawUV = (screen_coords - center) / radius;
      float rd = length(rawUV);

      // The noise-sampling coordinate is normalized against baseRadius —
      // a STABLE size that does NOT pulse — so the disc's breathing
      // doesn't rescale the noise field and make it lurch back and forth.
      vec2 uv = (screen_coords - center) / baseRadius;
      uv.x += time * scrollSpeed;

      // Fine granulation — evolves slowly in place so the surface also
      // gently boils rather than just sliding.
      vec2 gp = uv * plasmaScale + vec2(time * evolveSpeed, time * evolveSpeed * 0.6);
      float grain = fbm(gp);

      // A second, higher-frequency pass layers finer speckle on top.
      float speck = fbm(gp * detailScale + 7.3);
      float v = clamp(grain * 0.7 + speck * 0.3, 0.0, 1.0);

      // Fixed warm brightness ramp, driven purely by the noise's own value.
      vec3 col = mix(colorDark, colorMid, smoothstep(0.15, 0.45, v));
      col = mix(col, colorWarm, smoothstep(0.45, 0.72, v));
      col = mix(col, colorHot, smoothstep(0.72, 0.95, v));

      // Yellow rim glow — blends toward colorHot as rd approaches the
      // disc's true edge; the pow biases it to reach strong yellow well
      // before the edge, so the band reads as solidly yellow.
      float rimT = smoothstep(0.55, 1.0, rd);
      rimT = pow(rimT, 0.55);
      col = mix(col, colorHot, rimT);

      // Sunspots — a coarser fbm on the same scrolled uv, so they drift
      // together with the granulation.
      vec2 sp = uv * spotScale + vec2(time * evolveSpeed * 0.3, 0.0);
      float spotV = fbm(sp);
      float spotMask = smoothstep(spotThreshold - spotSoftness, spotThreshold + spotSoftness, spotV);
      col *= mix(1.0, spotDarken, spotMask);

      col *= brightness;

      return vec4(col, 1.0) * color;
    }
  `);
}

let sunMesh = null;
let coreRingMesh = null;
let plasmaShader = null;

class Sun {
  static new(x, y, radius) {
    return new Sun(x, y, radius);
  }

  constructor(x, y, radius) {
    this.pos = { x, y };
    this.radius = radius ?? RADIUS;
    this.pulseTime = 0;
    this.plasmaTime = 0;

    if (!sunMesh) sunMesh = createSunGradientMesh(80);
    if (!coreRingMesh) coreRingMesh = createRingFadeMesh(CORE_INNER_FRAC, 96);
    if (!plasmaShader) plasmaShader = createPlasmaShader();
  }

  update() {
    // state.timeScale includes real elapsed time (normalized to a 60fps
    // baseline) and the VATS multiplier — dividing out the baseline
    // recovers real seconds.
    const scaledDt = (state.timeScale ?? 1) / 60;

    // Wrapped rather than left to grow — see PLASMA_TIME_WRAP.
    this.pulseTime = (this.pulseTime + scaledDt * PULSE_SPEED) % (Math.PI * 2);
    this.plasmaTime = (this.plasmaTime + scaledDt) % PLASMA_TIME_WRAP;
  }

  draw() {
    const x = this.pos.x, y = this.pos.y;

    // Smooth pulse value between -1 and 1
    const pulse = Math.sin(this.pulseTime);
    const radiusScale = 1 + pulse * PULSE_AMOUNT;
    const intensityScale = 1 + pulse * PULSE_INTENSITY;

    const r = this.radius * radiusScale;
    const intensity = SUN_INTENSITY * intensityScale;

    // Soft outer corona — deep, saturated red, wide and faint.
    love.graphics.setColor(1.0, 0.18, 0.02, 0.22 * intensity);
    love.graphics.draw(sunMesh, x, y, 0, r * 2.1, r * 2.1);

    // Mid glow — denser and more saturated red-orange than the outer haze.
    love.graphics.setColor(1.0, 0.30, 0.04, 0.40 * intensity);
    love.graphics.draw(sunMesh, x, y, 0, r * 1.55, r * 1.55);

    // Inner glow — tighter still, warming toward the core's own yellow.
    love.graphics.setColor(1.0, 0.42, 0.07, 0.55 * intensity);
    love.graphics.draw(sunMesh, x, y, 0, r * 1.15, r * 1.15);

    const coreR = CORE_RADIUS * radiusScale;
    const zoom = state.zoom ?? 1;
    const cam = state.camera ?? { x: 0, y: 0 };

    // Flat core disc painted by the plasma shader. Only the outer
    // CORE_EDGE_BLUR px actually fade, via the ring mesh on top of the
    // solid fill; the two share CORE_INNER_FRAC so they always meet.
    love.graphics.setShader(plasmaShader);
    plasmaShader.send('center', [(x - cam.x) * zoom, (y - cam.y) * zoom]);
    plasmaShader.send('radius', coreR * zoom);
    // Stable, non-pulsing counterpart to "radius" above.
    plasmaShader.send('baseRadius', CORE_RADIUS * zoom);
    plasmaShader.send('time', this.plasmaTime);
    plasmaShader.send('brightness', intensityScale * CORE_BRIGHTNESS);

    // Scales the noise frequencies down when the sun's on-screen size is
    // smaller than PLASMA_REFERENCE_SCREEN_RADIUS. Uses the stable
    // CORE_RADIUS, not the pulsing one — that made the pattern lurch on
    // every pulse.
    const screenRadius = Math.max(1, CORE_RADIUS * zoom);
    const sizeFactor = Math.max(PLASMA_MIN_SCALE_FACTOR, Math.min(1, screenRadius / PLASMA_REFERENCE_SCREEN_RADIUS));
    plasmaShader.send('plasmaScale', PLASMA_SCALE * sizeFactor);
    plasmaShader.send('detailScale', PLASMA_DETAIL_SCALE);
    plasmaShader.send('evolveSpeed', PLASMA_EVOLVE_SPEED);
    plasmaShader.send('scrollSpeed', PLASMA_SCROLL_SPEED);
    plasmaShader.send('colorDark', PLASMA_COLOR_DARK);
    plasmaShader.send('colorMid', PLASMA_COLOR_MID);
    plasmaShader.send('colorWarm', PLASMA_COLOR_WARM);
    plasmaShader.send('colorHot', PLASMA_COLOR_HOT);
    plasmaShader.send('spotScale', SPOT_SCALE * Math.max(sizeFactor, 0.5));
    plasmaShader.send('spotThreshold', SPOT_THRESHOLD);
    plasmaShader.send('spotSoftness', SPOT_SOFTNESS);
    plasmaShader.send('spotDarken', SPOT_DARKEN);

    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.circle('fill', x, y, coreR * CORE_INNER_FRAC);
    love.graphics.draw(coreRingMesh, x, y, 0, coreR, coreR);

    love.graphics.setShader();
    love.graphics.setColor(1, 1, 1, 1);
  }
}

export default Sun;
