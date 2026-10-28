// js/fx.js
//
// The game's two GPU effects, run in the browser with WebGL so the
// website's fireballs and pull beam look the same as the game's:
//   * Fx.flame — the fireball head (lua/effects/Flame.lua's shader);
//   * Fx.beam  — the pull beam (lua/effects/PullBeam.lua's beam shader).
//
// Each renders into one shared offscreen WebGL canvas and then draws
// that onto an ordinary 2D canvas context, positioned and rotated, so
// the rest of the site keeps drawing with the 2D canvas as before.
//
// The shader code is the game's, with one change: LÖVE draws these with
// additive / premultiplied blending, where glow can add light without
// adding coverage. A browser canvas needs every pixel's alpha to cover
// its color, so the alpha written here is raised to fit the glow. On the
// dark page it looks the same.
//
// If WebGL isn't available, Fx.available is false and both functions do
// nothing; the callers draw simple fallbacks.

"use strict";

const Fx = (() => {
  const VERTEX = `
    attribute vec2 pos;
    varying vec2 uv;
    void main() {
      uv = vec2(pos.x, 1.0 - pos.y); // uv.y = 0 at the top, like LÖVE
      gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
    }`;

  const NOISE = `
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                 mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }`;

  // lua/effects/Flame.lua
  const FLAME = `
    precision highp float;
    varying vec2 uv;
    uniform float time;
    uniform float seed;
    uniform float stretch;
    uniform vec2 xRange;
    uniform float yHalf;
    ${NOISE}
    float fbm(vec2 p) {
      float v = 0.0;
      float a = 0.5;
      for (int k = 0; k < 4; k++) {
        v += a * noise(p);
        p = p * 2.03 + vec2(1.7, 9.2);
        a *= 0.5;
      }
      return v;
    }
    void main() {
      vec2 q = vec2(mix(xRange.x, xRange.y, uv.x), (uv.y * 2.0 - 1.0) * yHalf);
      vec2 s = q;
      if (s.x < 0.0) {
        s.x /= stretch;
        s.y *= 1.0 - s.x * 0.6;
      }
      float d = length(s);
      float halo = exp(-d * d * 0.55);
      float n1 = fbm(vec2(q.x * 0.9 + time * 3.0, q.y * 1.2) + seed);
      float n2 = fbm(vec2(q.x * 1.8 + time * 5.5, q.y * 2.2) - seed);
      float edge = d + (n1 - 0.5) * 1.0 * smoothstep(0.2, 1.0, d) + (n2 - 0.5) * 0.25;
      float heat = clamp(1.0 - edge * 0.85, 0.0, 1.0);
      vec3 c = mix(vec3(0.45, 0.03, 0.0), vec3(0.95, 0.22, 0.02), smoothstep(0.05, 0.35, heat));
      c = mix(c, vec3(1.0, 0.6, 0.1), smoothstep(0.3, 0.6, heat));
      c = mix(c, vec3(1.0, 0.93, 0.6), smoothstep(0.6, 0.85, heat));
      c = mix(c, vec3(1.0), smoothstep(0.85, 1.0, heat));
      float a = smoothstep(0.02, 0.22, heat);
      vec3 g = vec3(1.0, 0.42, 0.08) * halo * 0.6 * (1.0 - a);
      vec3 rgb = c * a + g;
      gl_FragColor = vec4(rgb, clamp(a + max(g.r, max(g.g, g.b)), 0.0, 1.0));
    }`;

  // lua/effects/PullBeam.lua
  const BEAM = `
    precision highp float;
    varying vec2 uv;
    uniform float time;
    uniform float len;
    uniform float halfWidth;
    uniform float startFrac;
    uniform float pulse;
    uniform vec3 color;
    uniform vec3 hot;
    ${NOISE}
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
    void main() {
      float s = uv.x * len;
      float v = uv.y * 2.0 - 1.0;
      float d = v * halfWidth;
      d += (noise(vec2(s * 0.03 + time * 3.0, 1.7)) - 0.5) * 3.0;
      float spread = halfWidth * mix(startFrac, 1.0, smoothstep(0.0, 1.0, uv.x));
      float a = d / spread;
      float core = exp(-d * d / 2.2);
      float inner = exp(-a * a * 6.0);
      float outer = exp(-a * a * 2.0) * (1.0 - smoothstep(0.75, 1.0, abs(a)));
      float n = fbm(vec2(s * 0.018 + time * 2.2, a * 1.8));
      float band = pow(0.5 + 0.5 * sin(s * 0.09 + time * 16.0), 5.0);
      float ends = smoothstep(0.0, min(0.2, 14.0 / max(len, 1.0)), uv.x);
      vec3 rgb = color * outer * (0.3 + 0.7 * n) * (0.8 + 0.3 * pulse)
               + color * inner * (0.4 + 0.8 * band)
               + hot * core * (0.85 + 0.15 * pulse);
      rgb = min(rgb * ends, vec3(1.0));
      gl_FragColor = vec4(rgb, max(rgb.r, max(rgb.g, rgb.b)));
    }`;

  let gl = null, glCanvas = null, programs = {}, available = false;

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn("Fx shader:", gl.getShaderInfoLog(sh));
      return null;
    }
    return sh;
  }

  function makeProgram(fragSrc, uniforms) {
    const vs = compile(gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl.FRAGMENT_SHADER, fragSrc);
    if (!vs || !fs) return null;
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return null;
    const loc = {};
    for (const u of uniforms) loc[u] = gl.getUniformLocation(p, u);
    return { p, loc, pos: gl.getAttribLocation(p, "pos") };
  }

  function init() {
    try {
      glCanvas = document.createElement("canvas");
      gl = glCanvas.getContext("webgl", { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false });
      if (!gl) return;
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
      programs.flame = makeProgram(FLAME, ["time", "seed", "stretch", "xRange", "yHalf"]);
      programs.beam = makeProgram(BEAM, ["time", "len", "halfWidth", "startFrac", "pulse", "color", "hot"]);
      available = !!(programs.flame && programs.beam);
    } catch (e) {
      available = false;
    }
  }

  // Renders `prog` into a w x h pixel area of the shared canvas (its
  // top-left corner), returning that area's size.
  function render(prog, w, h, setUniforms) {
    w = Math.max(1, Math.min(2048, Math.ceil(w)));
    h = Math.max(1, Math.min(2048, Math.ceil(h)));
    if (glCanvas.width < w || glCanvas.height < h) {
      glCanvas.width = Math.max(glCanvas.width, w);
      glCanvas.height = Math.max(glCanvas.height, h);
    }
    // WebGL's origin is bottom-left: draw into the top-left w x h.
    gl.viewport(0, glCanvas.height - h, w, h);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(prog.p);
    gl.enableVertexAttribArray(prog.pos);
    gl.vertexAttribPointer(prog.pos, 2, gl.FLOAT, false, 0, 0);
    setUniforms(prog.loc);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return [w, h];
  }

  // How many screen pixels one unit of `ctx`'s current drawing space is.
  function pixelScale(ctx) {
    const m = ctx.getTransform();
    return Math.hypot(m.a, m.b) || 1;
  }

  // Draws the rendered area as a rectangle `len` by `width` (ctx units),
  // starting at (x, y) and running along `angle`, centered across it.
  function blit(ctx, area, x, y, angle, length, width, offsetAlong) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.drawImage(glCanvas, 0, 0, area[0], area[1], offsetAlong, -width / 2, length, width);
    ctx.restore();
  }

  // lua/effects/Flame.lua's Flame.draw: a flame centered on (x, y),
  // `radius` units, heading along dirAngle with a tail `stretch` radii
  // long behind it.
  const REACH = 2.8;
  function flame(ctx, x, y, radius, dirAngle, stretch, time, seed) {
    if (!available) return false;
    const xMin = -REACH * stretch, xMax = REACH;
    const length = (xMax - xMin) * radius, width = REACH * 2 * radius;
    const px = pixelScale(ctx);
    const area = render(programs.flame, length * px, width * px, (u) => {
      gl.uniform1f(u.time, time);
      gl.uniform1f(u.seed, seed);
      gl.uniform1f(u.stretch, stretch);
      gl.uniform2f(u.xRange, xMin, xMax);
      gl.uniform1f(u.yHalf, REACH);
    });
    blit(ctx, area, x, y, dirAngle, length, width, xMin * radius);
    return true;
  }

  // lua/effects/PullBeam.lua's beam quad: from (x, y) along `angle`,
  // `len` long and halfWidth*2 wide. Sizes passed in GAME units
  // (lenGame, halfWidthGame) drive the shader's pattern, so it looks
  // the same as the game's; `unit` converts game units to ctx units.
  function beam(ctx, x, y, angle, lenGame, halfWidthGame, unit, params) {
    if (!available) return false;
    const length = lenGame * unit, width = halfWidthGame * 2 * unit;
    const px = pixelScale(ctx);
    const area = render(programs.beam, length * px, width * px, (u) => {
      gl.uniform1f(u.time, params.time);
      gl.uniform1f(u.len, lenGame);
      gl.uniform1f(u.halfWidth, halfWidthGame);
      gl.uniform1f(u.startFrac, params.startFrac);
      gl.uniform1f(u.pulse, params.pulse);
      gl.uniform3fv(u.color, params.color);
      gl.uniform3fv(u.hot, params.hot);
    });
    blit(ctx, area, x, y, angle, length, width, 0);
    return true;
  }

  init();
  return { get available() { return available; }, flame, beam };
})();
