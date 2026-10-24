// js/love/graphics.js
//
// A WebGL2 implementation of the part of LÖVE 11's love.graphics the
// game uses, so the Lua drawing code could be translated call for call
// instead of being redesigned around a retained-mode scene graph.
//
// How it works:
// - Shapes, images and text are transformed on the CPU and collected
//   into one big vertex buffer; it is drawn ("flushed") only when
//   something that affects the draw changes (texture, shader, blend
//   mode, canvas, stencil, scissor). Same idea as LÖVE's autobatching.
// - Meshes and sprite batches keep their own vertex buffers and are
//   drawn with the current transform passed to the shader, exactly as
//   LÖVE does, so custom vertex shaders see the same vertex_position.
// - Shaders are written in LÖVE's GLSL dialect (effect(), position(),
//   extern, Texel, Image, number) and converted to GLSL ES 3.00 here.
//   GLSL ES is stricter than desktop GLSL: no implicit int -> float,
//   so shader code must write 2.0 rather than 2.
// - Canvases are framebuffers. They are stored top row first, like
//   images, so drawing a canvas works exactly like drawing an image.
//
// Index conventions differ from LÖVE in one place: Mesh:setVertexMap,
// Mesh:setDrawRange and Mesh:setVertices take 0-based indices here.

// One vertex, 24 bytes: x, y, u, v as 32-bit floats; r, g, b, a as bytes
// (0-255, like LÖVE's own vertex colors — 8 bits each, clamped to 0..1);
// then which of the batch's textures it reads (see TEXTURE_SLOTS), as a
// byte, and 3 bytes of padding.
const VERTEX_BYTES = 24;
const VERTEX_FLOATS = VERTEX_BYTES / 4;
const BATCH_MAX_VERTICES = 3 * 21000;
// How many different textures one batch of shapes and images can use
// before it has to be drawn (only with the built-in shader — a game
// shader reads just the one texture it's given, so it gets 1).
const TEXTURE_SLOTS = 8;

let gl = null;
let canvasEl = null;
// The window, in the game's (logical) units, and how many real pixels
// each of those is (window.devicePixelRatio). The canvas itself is
// screenW * dpiScale real pixels wide, like LÖVE's high-DPI mode: the
// game draws in logical units and the result stays sharp.
let screenW = 1, screenH = 1, dpiScale = 1;
const allFonts = new Set();

// ---------------------------------------------------------------
// Graphics state
// ---------------------------------------------------------------
const st = {
  color: [1, 1, 1, 1],
  backgroundColor: [0, 0, 0, 1],
  lineWidth: 1,
  lineStyle: 'smooth',
  lineJoin: 'miter',
  pointSize: 1,
  blendMode: 'alpha',
  alphaMode: 'alphamultiply',
  shader: null,
  canvas: null,            // the current Canvas object, or null for the screen
  canvasWantsStencil: false,
  stencilCompare: null,    // null = no stencil test
  stencilValue: 0,
  scissor: null,           // [x, y, w, h] or null
  font: null,
  defaultMinFilter: 'linear',
  defaultMagFilter: 'linear',
  // Current transform as a 2D affine matrix: x' = a*x + c*y + e, y' = b*x + d*y + f
  t: [1, 0, 0, 1, 0, 0],
  stack: [],
  writingStencil: false,
};

// A color component (0..1, clamped) as a byte, the way LÖVE stores vertex
// colors — rounded down, as LÖVE does (0.5 -> 127; checked against LÖVE
// 11.5's own output).
function colorByte(c) {
  return c <= 0 ? 0 : (c >= 1 ? 255 : (c * 255) | 0);
}

// A whole color as one 32-bit value, laid out in memory as the bytes
// r, g, b, a — so a vertex's color is written in one go.
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
function packColor(r, g, b, a) {
  const R = colorByte(r), G = colorByte(g), B = colorByte(b), A = colorByte(a);
  return LITTLE_ENDIAN ? (R | (G << 8) | (B << 16) | (A << 24)) >>> 0 : ((R << 24) | (G << 16) | (B << 8) | A) >>> 0;
}
// The current color (setColor), packed.
function currentColor() {
  const c = st.color;
  return packColor(c[0], c[1], c[2], c[3]);
}

// ---------------------------------------------------------------
// Matrix helpers (2D affine)
// ---------------------------------------------------------------
function mul(m, n) {
  // m * n (apply n first, then m)
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

// The local transform LÖVE's draw(drawable, x, y, r, sx, sy, ox, oy, kx, ky) builds.
function localTransform(x = 0, y = 0, r = 0, sx = 1, sy = sx, ox = 0, oy = 0, kx = 0, ky = 0) {
  const c = Math.cos(r), s = Math.sin(r);
  // Matches love::Matrix4::setTransformation
  const a = c * sx - ky * s * sy;
  const b = s * sx + ky * c * sy;
  const cc = kx * c * sx - s * sy;
  const d = kx * s * sx + c * sy;
  const e = x - ox * a - oy * cc;
  const f = y - ox * b - oy * d;
  return [a, b, cc, d, e, f];
}

// Real pixels per local unit right now: the transform's scale times the
// current target's pixel density (see targetDensity).
function pixelScale() {
  const t = st.t;
  return (Math.sqrt(Math.abs(t[0] * t[3] - t[1] * t[2])) || 1e-6) * targetDensity;
}

// ---------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------
const VERTEX_HEADER = `#version 300 es
precision highp float;
precision highp int;
#define VERTEX
#define LOVE_GLSL_ES 1
uniform mat4 TransformMatrix;
uniform mat4 ProjectionMatrix;
uniform mat4 TransformProjectionMatrix;
uniform vec4 love_ScreenSize;
uniform vec4 love_ConstantColor;
layout(location = 0) in vec4 VertexPosition;
layout(location = 1) in vec4 VertexTexCoord;
layout(location = 2) in vec4 VertexColor;
layout(location = 3) in float VertexTexIndex;
out vec4 VaryingTexCoord;
out vec4 VaryingColor;
`;

const FRAGMENT_HEADER = `#version 300 es
precision highp float;
precision highp int;
#define PIXEL
#define LOVE_GLSL_ES 1
uniform vec4 love_ScreenSize;
uniform sampler2D MainTex;
uniform float love_PixelScale;
in vec4 VaryingTexCoord;
in vec4 VaryingColor;
out vec4 love_PixelColor;
`;

const DEFAULT_POSITION = `
vec4 position(mat4 transform_projection, vec4 vertex_position) {
  return transform_projection * vertex_position;
}
`;

// The built-in shader's pixel stage when batching several textures:
// each vertex says which of the batch's textures (slots, bound to units
// 0..TEXTURE_SLOTS-1) it reads. Otherwise exactly DEFAULT_EFFECT.
const BATCH_PIXEL_MAIN = `
flat in float VaryingTexIndex;
uniform sampler2D love_Tex1;
uniform sampler2D love_Tex2;
uniform sampler2D love_Tex3;
uniform sampler2D love_Tex4;
uniform sampler2D love_Tex5;
uniform sampler2D love_Tex6;
uniform sampler2D love_Tex7;
vec4 love_batchTexel(vec2 uv) {
  int i = int(VaryingTexIndex + 0.5);
  if (i == 0) return texture(MainTex, uv);
  if (i == 1) return texture(love_Tex1, uv);
  if (i == 2) return texture(love_Tex2, uv);
  if (i == 3) return texture(love_Tex3, uv);
  if (i == 4) return texture(love_Tex4, uv);
  if (i == 5) return texture(love_Tex5, uv);
  if (i == 6) return texture(love_Tex6, uv);
  if (i == 7) return texture(love_Tex7, uv);
  return texture(MainTex, uv);
}
void main() {
  love_PixelColor = love_batchTexel(VaryingTexCoord.st) * VaryingColor;
}
`;

const DEFAULT_EFFECT = `
vec4 effect(vec4 vcolor, sampler2D tex, vec2 texcoord, vec2 pixcoord) {
  return texture(tex, texcoord) * vcolor;
}
`;

// LÖVE GLSL -> GLSL ES 3.00
function translateLoveGLSL(code, stage) {
  let c = code;
  c = c.replace(/#pragma language glsl\d/g, '');
  c = c.replace(/\bextern\b/g, 'uniform');
  c = c.replace(/\bnumber\b/g, 'float');
  c = c.replace(/\bImage\b/g, 'sampler2D');
  c = c.replace(/\bTexel\s*\(/g, 'texture(');
  c = c.replace(/\btexture2D\s*\(/g, 'texture(');
  c = c.replace(/\bvarying\b/g, stage === 'vertex' ? 'out' : 'in');
  c = c.replace(/\bgl_FragColor\b/g, 'love_PixelColor');
  c = c.replace(/\blove_PixelCoord\b/g, 'love_PixelCoordFn()');
  return c;
}

function compileShader(type, source) {
  const s = gl.createShader(type);
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    const numbered = source.split('\n').map((l, i) => String(i + 1).padStart(4) + ': ' + l).join('\n');
    console.error(numbered);
    throw new Error('Shader compile error:\n' + log);
  }
  return s;
}

class Shader {
  // batching: the built-in shader, which reads one of several textures
  // per vertex (see BATCH_PIXEL_MAIN). Only for the default shader.
  constructor(pixelCode, vertexCode, batching = false) {
    // LÖVE accepts one string holding both stages (split with
    // #ifdef VERTEX / #ifdef PIXEL), or two strings.
    // Like LÖVE, each string goes to the stage(s) whose entry point it
    // defines: effect() -> pixel, position() -> vertex, both -> both
    // (kept apart by its own #ifdef VERTEX / #ifdef PIXEL).
    const sources = [pixelCode, vertexCode].filter((s) => s);
    const definesPosition = (s) => /vec4\s+position\s*\(/.test(s);
    const definesEffect = (s) => /vec4\s+effect\s*\(/.test(s);
    const vertexUser = sources.filter(definesPosition).join('\n');
    const pixelUser = sources.filter(definesEffect).join('\n');
    const hasPosition = vertexUser !== '';
    const hasEffect = pixelUser !== '';

    const vsrc = VERTEX_HEADER +
      translateLoveGLSL(vertexUser, 'vertex') +
      (hasPosition ? '' : DEFAULT_POSITION) +
      (batching ? 'flat out float VaryingTexIndex;\n' : '') + `
void main() {
  VaryingTexCoord = VertexTexCoord;
  VaryingColor = VertexColor * love_ConstantColor;
  ${batching ? 'VaryingTexIndex = VertexTexIndex;' : ''}
  gl_PointSize = 1.0;
  gl_Position = position(TransformProjectionMatrix, VertexPosition);
}
`;
    const fsrc = FRAGMENT_HEADER + `
vec2 love_PixelCoordFn() {
  // (In the game's logical units, as it was written for 1 pixel each.)
  return vec2(gl_FragCoord.x, gl_FragCoord.y * love_ScreenSize.z + love_ScreenSize.w) / love_PixelScale;
}
` +
      (batching ? BATCH_PIXEL_MAIN : translateLoveGLSL(pixelUser, 'pixel') +
      (hasEffect ? '' : DEFAULT_EFFECT) +
      `
void main() {
  love_PixelColor = effect(VaryingColor, MainTex, VaryingTexCoord.st, love_PixelCoordFn());
}
`);
    const vs = compileShader(gl.VERTEX_SHADER, vsrc);
    const fs = compileShader(gl.FRAGMENT_SHADER, fsrc);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('Shader link error: ' + gl.getProgramInfoLog(p));
    }
    this.program = p;
    this.uniforms = {};
    this.textureUnits = {}; // sampler uniform name -> unit
    this.boundTextures = {}; // unit -> texture object (Image/Canvas)
    let nextUnit = 1;
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    gl.useProgram(p);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      const loc = gl.getUniformLocation(p, info.name);
      this.uniforms[name] = { loc, type: info.type, size: info.size };
      const slot = /^love_Tex(\d+)$/.exec(name);
      if (slot) {
        gl.uniform1i(loc, Number(slot[1])); // a batch texture slot: unit = slot number
      } else if (info.type === gl.SAMPLER_2D && name !== 'MainTex') {
        this.textureUnits[name] = nextUnit;
        gl.uniform1i(loc, nextUnit);
        nextUnit++;
      }
    }
    if (this.uniforms.MainTex) gl.uniform1i(this.uniforms.MainTex.loc, 0);
    this.cachedProjection = null;
    // Make sure the currently active program is restored.
    currentProgram = null;
  }

  hasUniform(name) {
    return !!this.uniforms[name];
  }

  // send(name, value, ...) — numbers, arrays (vectors / matrices,
  // given either as [x, y] or as nested rows), booleans, or an
  // Image/Canvas for a sampler. Several values fill a uniform array.
  send(name, ...values) {
    const u = this.uniforms[name];
    if (!u) return;
    if (this === st.shader) flush();
    if (u.type === gl.SAMPLER_2D) {
      this.boundTextures[this.textureUnits[name]] = values[0];
      return;
    }
    const flat = [];
    const push = (v) => {
      if (Array.isArray(v) || ArrayBuffer.isView(v)) { for (const x of v) push(x); }
      else if (typeof v === 'boolean') flat.push(v ? 1 : 0);
      else flat.push(Number(v));
    };
    for (const v of values) push(v);
    useProgram(this.program);
    const loc = u.loc;
    switch (u.type) {
      case gl.FLOAT: gl.uniform1fv(loc, flat); break;
      case gl.FLOAT_VEC2: gl.uniform2fv(loc, flat); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(loc, flat); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(loc, flat); break;
      case gl.INT: case gl.BOOL: gl.uniform1iv(loc, flat.map(Math.trunc)); break;
      case gl.INT_VEC2: case gl.BOOL_VEC2: gl.uniform2iv(loc, flat.map(Math.trunc)); break;
      case gl.INT_VEC3: case gl.BOOL_VEC3: gl.uniform3iv(loc, flat.map(Math.trunc)); break;
      case gl.INT_VEC4: case gl.BOOL_VEC4: gl.uniform4iv(loc, flat.map(Math.trunc)); break;
      case gl.FLOAT_MAT2: gl.uniformMatrix2fv(loc, false, transposeIfRows(flat, 2, values)); break;
      case gl.FLOAT_MAT3: gl.uniformMatrix3fv(loc, false, transposeIfRows(flat, 3, values)); break;
      case gl.FLOAT_MAT4: gl.uniformMatrix4fv(loc, false, transposeIfRows(flat, 4, values)); break;
      default: break;
    }
  }
}

// LÖVE treats nested-table matrices as rows; GL wants columns.
function transposeIfRows(flat, n, values) {
  if (!(values.length === 1 && Array.isArray(values[0]) && Array.isArray(values[0][0]))) return flat;
  const out = new Array(flat.length);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) out[c * n + r] = flat[r * n + c];
  return out;
}

let defaultShader = null;
let currentProgram = null;
function useProgram(p) {
  if (currentProgram !== p) {
    gl.useProgram(p);
    currentProgram = p;
  }
}

// ---------------------------------------------------------------
// Textures: Image, Canvas
// ---------------------------------------------------------------
const FILTERS = () => ({ linear: gl.LINEAR, nearest: gl.NEAREST });
const WRAPS = () => ({ clamp: gl.CLAMP_TO_EDGE, repeat: gl.REPEAT, mirroredrepeat: gl.MIRRORED_REPEAT, clampzero: gl.CLAMP_TO_EDGE });

class Texture {
  constructor() {
    this.tex = gl.createTexture();
    this.minFilter = st.defaultMinFilter;
    this.magFilter = st.defaultMagFilter;
    this.wrapH = 'clamp';
    this.wrapV = 'clamp';
    this.mipmaps = false;
    this.width = 0;
    this.height = 0;
  }
  type() { return 'Texture'; }
  getWidth() { return this.width; }
  getHeight() { return this.height; }
  getDimensions() { return [this.width, this.height]; }
  getPixelWidth() { return this.width; }
  getPixelHeight() { return this.height; }
  getPixelDimensions() { return [this.width, this.height]; }
  getDPIScale() { return 1; }
  setFilter(min, mag = min) {
    flush();
    this.minFilter = min;
    this.magFilter = mag;
    this.applyParams();
  }
  getFilter() { return [this.minFilter, this.magFilter]; }
  setWrap(h, v = h) {
    flush();
    this.wrapH = h;
    this.wrapV = v;
    this.applyParams();
  }
  getWrap() { return [this.wrapH, this.wrapV]; }
  setMipmapFilter() { /* mipmaps always use linear blending between levels here */ }
  applyParams() {
    const F = FILTERS(), W = WRAPS();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    let min = F[this.minFilter];
    if (this.mipmaps) min = this.minFilter === 'nearest' ? gl.NEAREST_MIPMAP_LINEAR : gl.LINEAR_MIPMAP_LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, F[this.magFilter]);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, W[this.wrapH]);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, W[this.wrapV]);
    boundTexture0 = null;
  }
  release() {
    flush();
    if (this.tex) gl.deleteTexture(this.tex);
    this.tex = null;
  }
}

class Image extends Texture {
  constructor(source, settings = {}) {
    super();
    this.mipmaps = !!(settings && settings.mipmaps);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    if (source instanceof ImageData) {
      this.width = source.width;
      this.height = source.height;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, source.data);
    } else {
      // An ImageBitmap / HTMLImageElement / HTMLCanvasElement
      this.width = source.width;
      this.height = source.height;
      // Bigger than this GPU allows: uploaded scaled down to fit. The
      // image still reports its real size (and texture coordinates are
      // fractions of it), so drawing it looks the same, just softer.
      const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      if (source.width > maxSize || source.height > maxSize) {
        const k = maxSize / Math.max(source.width, source.height);
        const scaled = new OffscreenCanvas(Math.max(1, Math.floor(source.width * k)), Math.max(1, Math.floor(source.height * k)));
        const ctx = scaled.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(source, 0, 0, scaled.width, scaled.height);
        console.warn(`Image ${source.width}x${source.height} exceeds the GPU's max texture size ${maxSize}; uploaded at ${scaled.width}x${scaled.height}.`);
        source = scaled;
      }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
    if (this.mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
    this.applyParams();
  }
  type() { return 'Image'; }
  replacePixels(imageData) {
    flush();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, imageData.width, imageData.height, gl.RGBA, gl.UNSIGNED_BYTE, imageData.data);
    if (this.mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
    boundTexture0 = null;
  }
}

class Canvas extends Texture {
  constructor(w, h, settings = {}) {
    super();
    this.width = Math.max(1, Math.floor(w));
    this.height = Math.max(1, Math.floor(h));
    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (this.width > maxSize || this.height > maxSize) {
      console.warn(`Canvas ${this.width}x${this.height} exceeds the GPU's max texture size ${maxSize}; clamped.`);
      this.width = Math.min(this.width, maxSize);
      this.height = Math.min(this.height, maxSize);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    const fmt = settings && settings.format;
    if (fmt === 'rgba16f') {
      gl.getExtension('EXT_color_buffer_float');
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, this.width, this.height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    this.applyParams();
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    this.stencilRb = null;
    // New canvases start fully transparent.
    gl.clearColor(0, 0, 0, 0);
    gl.disable(gl.SCISSOR_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT);
    rebindTarget();
  }
  type() { return 'Canvas'; }
  ensureStencil() {
    if (this.stencilRb) return;
    this.stencilRb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.stencilRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, this.width, this.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, this.stencilRb);
    gl.clearStencil(0);
    gl.stencilMask(0xff);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    rebindTarget();
  }
  renderTo(fn) {
    const prev = st.canvas;
    const prevStencil = st.canvasWantsStencil;
    setCanvas(this);
    try { fn(); } finally { setCanvas(prev ? { 0: prev, stencil: prevStencil } : null); }
  }
  // Reads the canvas back as ImageData (slow — for one-off bakes only).
  newImageData() {
    flush();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    const data = new Uint8ClampedArray(this.width * this.height * 4);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    rebindTarget();
    return new ImageData(this.width, this.height, data);
  }
  release() {
    super.release();
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    if (this.stencilRb) gl.deleteRenderbuffer(this.stencilRb);
    this.fbo = null;
  }
}

// ---------------------------------------------------------------
// ImageData (love.image)
// ---------------------------------------------------------------
class ImageData {
  constructor(w, h, data) {
    this.width = w;
    this.height = h;
    this.data = data || new Uint8ClampedArray(w * h * 4);
  }
  type() { return 'ImageData'; }
  getWidth() { return this.width; }
  getHeight() { return this.height; }
  getDimensions() { return [this.width, this.height]; }
  getPixel(x, y) {
    const i = (Math.floor(y) * this.width + Math.floor(x)) * 4;
    const d = this.data;
    return [d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, d[i + 3] / 255];
  }
  setPixel(x, y, r, g, b, a = 1) {
    if (Array.isArray(r)) { [r, g, b, a = 1] = r; }
    const i = (Math.floor(y) * this.width + Math.floor(x)) * 4;
    const d = this.data;
    d[i] = r * 255 + 0.5; d[i + 1] = g * 255 + 0.5; d[i + 2] = b * 255 + 0.5; d[i + 3] = a * 255 + 0.5;
  }
  // fn(x, y, r, g, b, a) returns [r, g, b, a]
  mapPixel(fn, sx = 0, sy = 0, sw = this.width, sh = this.height) {
    const d = this.data;
    for (let y = sy; y < sy + sh; y++) {
      for (let x = sx; x < sx + sw; x++) {
        const i = (y * this.width + x) * 4;
        const out = fn(x, y, d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, d[i + 3] / 255);
        d[i] = out[0] * 255 + 0.5;
        d[i + 1] = out[1] * 255 + 0.5;
        d[i + 2] = out[2] * 255 + 0.5;
        d[i + 3] = (out[3] === undefined ? 1 : out[3]) * 255 + 0.5;
      }
    }
  }
  paste(src, dx, dy, sx = 0, sy = 0, sw = src.width, sh = src.height) {
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const tx = dx + x, ty = dy + y;
        if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) continue;
        const si = ((sy + y) * src.width + (sx + x)) * 4;
        const di = (ty * this.width + tx) * 4;
        for (let k = 0; k < 4; k++) this.data[di + k] = src.data[si + k];
      }
    }
  }
}

// ---------------------------------------------------------------
// Quad
// ---------------------------------------------------------------
class Quad {
  constructor(x, y, w, h, sw, sh) {
    this.x = x; this.y = y; this.w = w; this.h = h; this.sw = sw; this.sh = sh;
  }
  type() { return 'Quad'; }
  setViewport(x, y, w, h, sw, sh) {
    this.x = x; this.y = y; this.w = w; this.h = h;
    if (sw !== undefined) this.sw = sw;
    if (sh !== undefined) this.sh = sh;
  }
  getViewport() { return [this.x, this.y, this.w, this.h]; }
  getTextureDimensions() { return [this.sw, this.sh]; }
}

// ---------------------------------------------------------------
// Fonts (glyphs rasterized with Canvas2D into an atlas)
// ---------------------------------------------------------------
const DEFAULT_FONT_FAMILY = '"Bitstream Vera Sans", "DejaVu Sans", Verdana, Geneva, sans-serif';
const ATLAS_SIZE = 1024;

class Font {
  constructor(size = 12, family = DEFAULT_FONT_FAMILY) {
    this.size = size;
    this.family = family;
    this.cssFont = `${size}px ${family}`;
    // Glyphs are rasterized rs times bigger (the screen's pixel density)
    // and drawn back at their logical size, so text stays sharp.
    this.rs = fontRasterScale();
    allFonts.add(this);
    this.measureCtx = document.createElement('canvas').getContext('2d');
    this.measureCtx.font = this.cssFont;
    const m = this.measureCtx.measureText('Hg');
    const asc = m.fontBoundingBoxAscent !== undefined ? m.fontBoundingBoxAscent : size * 0.93;
    const desc = m.fontBoundingBoxDescent !== undefined ? m.fontBoundingBoxDescent : size * 0.24;
    this.ascent = Math.round(asc);
    this.descent = Math.round(desc);
    this.height = this.ascent + this.descent;
    this.lineHeight = 1;
    this.glyphs = new Map();
    this.pages = [];
    this.pad = 2;
    this.minFilter = st.defaultMinFilter;
    this.magFilter = st.defaultMagFilter;
    this.newPage();
  }
  type() { return 'Font'; }
  setRasterScale(rs) {
    if (rs === this.rs) return;
    flush();
    for (const p of this.pages) if (p.image) p.image.release();
    this.rs = rs;
    this.glyphs.clear();
    this.pages = [];
    this.newPage();
  }
  newPage() {
    const c = document.createElement('canvas');
    c.width = ATLAS_SIZE; c.height = ATLAS_SIZE;
    const ctx = c.getContext('2d');
    ctx.font = `${this.size * this.rs}px ${this.family}`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#fff';
    const page = { canvas: c, ctx, image: null, dirty: true, penX: 0, penY: 0, rowH: 0 };
    this.pages.push(page);
    return page;
  }
  glyph(ch) {
    let g = this.glyphs.get(ch);
    if (g) return g;
    const adv = this.measureCtx.measureText(ch).width;
    const m = this.measureCtx.measureText(ch);
    const left = Math.ceil(m.actualBoundingBoxLeft || 0);
    const right = Math.ceil(m.actualBoundingBoxRight || adv);
    const w = Math.max(1, left + right) + this.pad * 2;
    const h = this.height + this.pad * 2;
    const rs = this.rs;
    const aw = Math.ceil(w * rs), ah = Math.ceil(h * rs); // its size in the atlas
    let page = this.pages[this.pages.length - 1];
    if (page.penX + aw > ATLAS_SIZE) { page.penX = 0; page.penY += page.rowH; page.rowH = 0; }
    if (page.penY + ah > ATLAS_SIZE) page = this.newPage();
    const gx = page.penX, gy = page.penY;
    page.ctx.fillText(ch, gx + (this.pad + left) * rs, gy + (this.pad + this.ascent) * rs);
    page.penX += aw;
    page.rowH = Math.max(page.rowH, ah);
    page.dirty = true;
    g = { page, x: gx, y: gy, w, h, aw, ah, adv, ox: this.pad + left, oy: this.pad };
    this.glyphs.set(ch, g);
    return g;
  }
  pageImage(page) {
    if (page.dirty) {
      flush();
      if (page.image) page.image.release();
      const prevMin = st.defaultMinFilter, prevMag = st.defaultMagFilter;
      st.defaultMinFilter = this.minFilter; st.defaultMagFilter = this.magFilter;
      page.image = new Image(page.canvas);
      st.defaultMinFilter = prevMin; st.defaultMagFilter = prevMag;
      page.dirty = false;
    }
    return page.image;
  }
  getWidth(text) {
    text = String(text);
    let maxW = 0;
    for (const line of text.split('\n')) {
      let w = 0;
      for (const ch of line) w += this.glyph(ch).adv;
      maxW = Math.max(maxW, w);
    }
    return Math.round(maxW);
  }
  getHeight() { return this.height; }
  getAscent() { return this.ascent; }
  getDescent() { return this.descent; }
  getBaseline() { return this.ascent; }
  getLineHeight() { return this.lineHeight; }
  setLineHeight(h) { this.lineHeight = h; }
  setFilter(min, mag = min) {
    this.minFilter = min; this.magFilter = mag;
    for (const p of this.pages) if (p.image) p.image.setFilter(min, mag);
  }
  // Word-wraps text to a width; returns [maxWidth, lines]
  getWrap(text, wrapLimit) {
    const lines = [];
    let maxW = 0;
    for (const para of String(text).split('\n')) {
      const words = para.split(/(\s+)/);
      let line = '';
      for (const word of words) {
        const test = line + word;
        if (line !== '' && this.getWidth(test.trimEnd()) > wrapLimit) {
          lines.push(line.trimEnd());
          maxW = Math.max(maxW, this.getWidth(line.trimEnd()));
          line = word.trimStart();
        } else line = test;
      }
      lines.push(line);
      maxW = Math.max(maxW, this.getWidth(line));
    }
    return [maxW, lines];
  }
}

// ---------------------------------------------------------------
// Mesh
// ---------------------------------------------------------------
const MESH_MODES = () => ({ fan: gl.TRIANGLE_FAN, strip: gl.TRIANGLE_STRIP, triangles: gl.TRIANGLES, points: gl.POINTS });

class Mesh {
  // new Mesh(vertices | count, mode = 'fan', usage = 'dynamic')
  // Each vertex is [x, y, u, v, r, g, b, a] (u, v, colors optional).
  constructor(vertices, mode = 'fan', usage = 'dynamic') {
    this.mode = mode;
    const count = typeof vertices === 'number' ? vertices : vertices.length;
    this.count = count;
    this.buffer = new ArrayBuffer(count * VERTEX_BYTES);
    this.f32 = new Float32Array(this.buffer);
    this.u8 = new Uint8Array(this.buffer);
    for (let i = 0; i < count; i++) {
      const b = i * VERTEX_BYTES + 16;
      this.u8[b] = 255; this.u8[b + 1] = 255; this.u8[b + 2] = 255; this.u8[b + 3] = 255;
    }
    if (typeof vertices !== 'number') this.setVertices(vertices);
    this.vbo = gl.createBuffer();
    this.dirty = true;
    this.indices = null;
    this.ibo = null;
    this.indicesDirty = false;
    this.texture = null;
    this.rangeStart = null;
    this.rangeCount = null;
    this.usage = usage;
  }
  type() { return 'Mesh'; }
  getVertexCount() { return this.count; }
  setVertex(index, x, y, u, v, r, g, b, a) {
    if (Array.isArray(x)) [x, y, u, v, r, g, b, a] = x;
    this.writeVertex(index, x, y, u, v, r, g, b, a);
    this.dirty = true;
  }
  writeVertex(index, x, y, u, v, r, g, b, a) {
    const o = index * VERTEX_FLOATS, c = index * VERTEX_BYTES + 16;
    const f = this.f32, d = this.u8;
    f[o] = x; f[o + 1] = y; f[o + 2] = u ?? 0; f[o + 3] = v ?? 0;
    d[c] = colorByte(r ?? 1); d[c + 1] = colorByte(g ?? 1); d[c + 2] = colorByte(b ?? 1); d[c + 3] = colorByte(a ?? 1);
  }
  getVertex(index) {
    const o = index * VERTEX_FLOATS, c = index * VERTEX_BYTES + 16;
    const f = this.f32, d = this.u8;
    return [f[o], f[o + 1], f[o + 2], f[o + 3], d[c] / 255, d[c + 1] / 255, d[c + 2] / 255, d[c + 3] / 255];
  }
  // setVertices(list, startIndex = 0)  — 0-based start index.
  setVertices(list, start = 0, count) {
    const n = count === undefined ? list.length : Math.min(count, list.length);
    for (let i = 0; i < n && start + i < this.count; i++) {
      const v = list[i];
      this.writeVertex(start + i, v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7]);
    }
    this.dirty = true;
  }
  // setVertexMap(i0, i1, ...) or setVertexMap([..]) — 0-based indices.
  setVertexMap(...map) {
    if (map.length === 1 && Array.isArray(map[0])) map = map[0];
    if (map.length === 0 || map[0] === null || map[0] === undefined) { this.indices = null; return; }
    this.indices = new Uint32Array(map);
    this.indicesDirty = true;
  }
  getVertexMap() { return this.indices ? Array.from(this.indices) : null; }
  setTexture(tex) { this.texture = tex || null; }
  getTexture() { return this.texture; }
  // setDrawRange(start, count) — 0-based start. No arguments resets it.
  setDrawRange(start, count) {
    if (start === undefined) { this.rangeStart = null; this.rangeCount = null; return; }
    this.rangeStart = start; this.rangeCount = count;
  }
  getDrawRange() { return [this.rangeStart, this.rangeCount]; }
  setDrawMode(mode) { this.mode = mode; }
  release() {
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.ibo) gl.deleteBuffer(this.ibo);
    this.vbo = null; this.ibo = null;
  }
  upload() {
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    if (this.dirty) {
      if (this.vboBytes === this.u8.length) gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.u8);
      else { gl.bufferData(gl.ARRAY_BUFFER, this.u8, gl.DYNAMIC_DRAW); this.vboBytes = this.u8.length; }
      this.dirty = false;
    }
    if (this.indices) {
      if (!this.ibo) this.ibo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
      if (this.indicesDirty) {
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indices, gl.STATIC_DRAW);
        this.indicesDirty = false;
      }
    }
  }
  drawWith(m) {
    flush();
    prepareDraw(this.texture, true);
    setTransformUniforms(m);
    setConstantColor(st.color);
    this.upload();
    bindVertexLayout();
    const glMode = MESH_MODES()[this.mode];
    if (this.indices) {
      const start = this.rangeStart ?? 0;
      const cnt = this.rangeCount ?? (this.indices.length - start);
      gl.drawElements(glMode, cnt, gl.UNSIGNED_INT, start * 4);
      drawCalls++;
    } else {
      const start = this.rangeStart ?? 0;
      const cnt = this.rangeCount ?? (this.count - start);
      if (cnt > 0) { gl.drawArrays(glMode, start, cnt); drawCalls++; }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, batchVbo);
    bindVertexLayout();
    setConstantColor(WHITE);
    setTransformUniforms(IDENTITY);
  }
}

// ---------------------------------------------------------------
// SpriteBatch
// ---------------------------------------------------------------
class SpriteBatch {
  constructor(texture, size = 1000) {
    this.texture = texture;
    this.sprites = [];
    this.color = [1, 1, 1, 1];
    this.mesh = null;
    this.dirty = true;
  }
  type() { return 'SpriteBatch'; }
  setColor(r = 1, g = 1, b = 1, a = 1) {
    if (Array.isArray(r)) [r, g, b, a = 1] = r;
    this.color = [r, g, b, a];
  }
  // add([quad,] x, y, r, sx, sy, ox, oy, kx, ky) -> id (0-based)
  add(...args) {
    let quad = null;
    if (args[0] instanceof Quad) quad = args.shift();
    this.sprites.push(this.makeSprite(quad, args));
    this.dirty = true;
    return this.sprites.length - 1;
  }
  set(id, ...args) {
    let quad = null;
    if (args[0] instanceof Quad) quad = args.shift();
    this.sprites[id] = this.makeSprite(quad, args);
    this.dirty = true;
  }
  makeSprite(quad, args) {
    const tw = this.texture.width, th = this.texture.height;
    let qx = 0, qy = 0, qw = tw, qh = th;
    if (quad) { qx = quad.x; qy = quad.y; qw = quad.w; qh = quad.h; }
    const m = localTransform(...args);
    const u0 = qx / tw, v0 = qy / th, u1 = (qx + qw) / tw, v1 = (qy + qh) / th;
    const [r, g, b, a] = this.color;
    const P = (x, y, u, v) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5], u, v, r, g, b, a];
    return [P(0, 0, u0, v0), P(qw, 0, u1, v0), P(qw, qh, u1, v1), P(0, qh, u0, v1)];
  }
  clear() { this.sprites = []; this.dirty = true; }
  getCount() { return this.sprites.length; }
  flush() {}
  setTexture(t) { this.texture = t; }
  getTexture() { return this.texture; }
  build() {
    if (!this.dirty && this.mesh) return;
    const verts = [];
    const idx = [];
    for (const s of this.sprites) {
      const base = verts.length;
      verts.push(...s);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    if (this.mesh) this.mesh.release();
    this.mesh = new Mesh(verts.length ? verts : 1, 'triangles');
    if (verts.length) this.mesh.setVertexMap(idx);
    this.mesh.setTexture(this.texture);
    this.dirty = false;
  }
  drawWith(m) {
    if (this.sprites.length === 0) return;
    this.build();
    this.mesh.drawWith(m);
  }
}

// ---------------------------------------------------------------
// GL plumbing
// ---------------------------------------------------------------
const IDENTITY = [1, 0, 0, 1, 0, 0];
const WHITE = [1, 1, 1, 1];
let batchVbo = null;
let vao = null;
let whiteTex = null;
const batchBuffer = new ArrayBuffer(BATCH_MAX_VERTICES * VERTEX_BYTES);
const batchF32 = new Float32Array(batchBuffer);
const batchU8 = new Uint8Array(batchBuffer);
const batchU32 = new Uint32Array(batchBuffer);
let batchCount = 0; // vertices
// The GPU buffer batches go into: each one is written after the last
// (bufferSubData) instead of re-creating the buffer every time; once
// it's full, it's replaced with a fresh one (so the GPU can keep reading
// the old one while new batches go in) and filling starts again.
const BATCH_VBO_BYTES = BATCH_MAX_VERTICES * VERTEX_BYTES * 4;
let batchVboOffset = BATCH_VBO_BYTES; // (forces a fresh buffer the first time)
// The textures this batch draws with (null = plain color, the white
// texture), one per slot, and the slot of the one being drawn now.
const batchTextures = [];
let batchSlot = 0;
// The vertex's texture-slot word (slot byte, then padding), as written.
let batchSlotWord = 0;
let boundTexture0 = null;
let projection = null; // Float32Array(16)
let screenSize = [0, 0, 1, 0];

function bindVertexLayout() {
  const stride = VERTEX_BYTES;
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, stride, 16);
  gl.enableVertexAttribArray(3);
  gl.vertexAttribPointer(3, 1, gl.UNSIGNED_BYTE, false, stride, 20);
}

function texOf(t) {
  if (!t) return whiteTex.tex;
  return t.tex;
}

function activeShader() {
  return st.shader || defaultShader;
}

let lastTransformKey = null;
// (Scratch matrices: uniformMatrix4fv copies them, so they're reused.)
const tmScratch = new Float32Array(16);
const tpScratch = new Float32Array(16);
function setTransformUniforms(m) {
  const sh = activeShader();
  const tm = tmScratch;
  tm[0] = m[0]; tm[1] = m[1]; tm[2] = 0; tm[3] = 0;
  tm[4] = m[2]; tm[5] = m[3]; tm[6] = 0; tm[7] = 0;
  tm[8] = 0; tm[9] = 0; tm[10] = 1; tm[11] = 0;
  tm[12] = m[4]; tm[13] = m[5]; tm[14] = 0; tm[15] = 1;
  const u = sh.uniforms;
  if (u.TransformMatrix) gl.uniformMatrix4fv(u.TransformMatrix.loc, false, tm);
  if (u.ProjectionMatrix) gl.uniformMatrix4fv(u.ProjectionMatrix.loc, false, projection);
  if (u.TransformProjectionMatrix) {
    const a = projection, o = tpScratch;
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * tm[c * 4 + k];
        o[c * 4 + r] = sum;
      }
    }
    gl.uniformMatrix4fv(u.TransformProjectionMatrix.loc, false, o);
  }
  if (u.love_ScreenSize) gl.uniform4fv(u.love_ScreenSize.loc, screenSize);
  if (u.love_PixelScale) gl.uniform1f(u.love_PixelScale.loc, targetDensity);
  lastTransformKey = null;
}

function setConstantColor(c) {
  const sh = activeShader();
  if (sh.uniforms.love_ConstantColor) gl.uniform4fv(sh.uniforms.love_ConstantColor.loc, c);
}

// Makes the active shader current, binds its textures and the main
// texture, and sets the per-target uniforms.
// texture: one texture, or (for a batch) the list of its slot textures.
function prepareDraw(texture, isMesh) {
  const sh = activeShader();
  useProgram(sh.program);
  if (sh.cachedProjection !== projection) {
    sh.cachedProjection = projection;
    setTransformUniforms(IDENTITY);
    setConstantColor(WHITE);
  }
  for (const unit in sh.boundTextures) {
    const t = sh.boundTextures[unit];
    gl.activeTexture(gl.TEXTURE0 + Number(unit));
    gl.bindTexture(gl.TEXTURE_2D, t ? t.tex : whiteTex.tex);
  }
  if (Array.isArray(texture)) {
    for (let i = texture.length - 1; i >= 0; i--) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, texOf(texture[i]));
    }
    boundTexture0 = texture[0];
  } else {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texOf(texture));
    boundTexture0 = texture;
  }
  gl.activeTexture(gl.TEXTURE0);
}

function flush() {
  if (batchCount === 0) return;
  prepareDraw(batchTextures, false);
  gl.bindBuffer(gl.ARRAY_BUFFER, batchVbo);
  const bytes = batchCount * VERTEX_BYTES;
  if (batchVboOffset + bytes > BATCH_VBO_BYTES) {
    gl.bufferData(gl.ARRAY_BUFFER, BATCH_VBO_BYTES, gl.STREAM_DRAW);
    batchVboOffset = 0;
  }
  gl.bufferSubData(gl.ARRAY_BUFFER, batchVboOffset, batchU8, 0, bytes);
  gl.drawArrays(gl.TRIANGLES, batchVboOffset / VERTEX_BYTES, batchCount);
  batchVboOffset += bytes;
  drawCalls++;
  batchCount = 0;
  batchTextures.length = 0;
}

// Reserve room for n vertices drawn with the given texture.
// (A batch can hold up to TEXTURE_SLOTS different textures with the
// built-in shader — a game shader only ever sees one, so it gets one.)
function reserve(texture, n) {
  if (batchCount + n > BATCH_MAX_VERTICES) flush();
  let slot = batchTextures.indexOf(texture);
  if (slot < 0) {
    if (batchTextures.length >= (st.shader ? 1 : TEXTURE_SLOTS)) flush();
    slot = batchTextures.length;
    batchTextures.push(texture);
  }
  batchSlot = slot;
  batchSlotWord = LITTLE_ENDIAN ? slot : slot << 24;
}

// Push one transformed vertex. (x, y) are local; the current transform applies.
// Push one transformed vertex. (x, y) are local; the current transform
// applies. rgba: a packed color (see packColor).
function pushVC(x, y, u, v, rgba) {
  const t = st.t;
  const o = batchCount * VERTEX_FLOATS;
  batchF32[o] = t[0] * x + t[2] * y + t[4];
  batchF32[o + 1] = t[1] * x + t[3] * y + t[5];
  batchF32[o + 2] = u;
  batchF32[o + 3] = v;
  batchU32[o + 4] = rgba;
  batchU32[o + 5] = batchSlotWord;
  batchCount++;
}

// The same, with the color as separate components (8-bit, like LÖVE's own
// vertex colors).
function pushV(x, y, u, v, r, g, b, a) {
  pushVC(x, y, u, v, packColor(r, g, b, a));
}

// Triangles from a flat list of [x, y] points (local space), solid color.
function pushTriangles(pts) {
  const n = pts.length / 2;
  reserve(null, n);
  const c = currentColor();
  for (let i = 0; i < n; i++) pushVC(pts[i * 2], pts[i * 2 + 1], 0, 0, c);
}

function pushFan(pts, len = pts.length) {
  const n = len / 2;
  if (n < 3) return;
  reserve(null, (n - 2) * 3);
  const c = currentColor();
  const x0 = pts[0], y0 = pts[1];
  for (let i = 1; i < n - 1; i++) {
    pushVC(x0, y0, 0, 0, c);
    pushVC(pts[i * 2], pts[i * 2 + 1], 0, 0, c);
    pushVC(pts[i * 2 + 2], pts[i * 2 + 3], 0, 0, c);
  }
}

// Real pixels per logical unit of the current draw target (dpiScale on
// the screen, 1 on a canvas).
let targetDensity = 1;
// w, h: the target in logical units; pixW, pixH: in real pixels.
function setProjectionFor(w, h, flipY, pixW = w, pixH = h) {
  // Orthographic: x 0..w -> -1..1; y 0..h -> 1..-1 for the screen
  // (top-left origin), or -1..1 for canvases (stored top row first).
  const sy = flipY ? -2 / h : 2 / h;
  const ty = flipY ? 1 : -1;
  projection = new Float32Array([
    2 / w, 0, 0, 0,
    0, sy, 0, 0,
    0, 0, -1, 0,
    -1, ty, 0, 1,
  ]);
  screenSize = flipY ? [pixW, pixH, -1, pixH] : [pixW, pixH, 1, 0];
  targetDensity = pixW / w;
}

function rebindTarget() {
  if (st.canvas) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, st.canvas.fbo);
    gl.viewport(0, 0, st.canvas.width, st.canvas.height);
    setProjectionFor(st.canvas.width, st.canvas.height, false);
  } else {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasEl.width, canvasEl.height);
    setProjectionFor(screenW, screenH, true, canvasEl.width, canvasEl.height);
  }
  applyScissor();
}

function applyScissor() {
  if (st.scissor) {
    const [x, y, w, h] = st.scissor;
    gl.enable(gl.SCISSOR_TEST);
    if (st.canvas) {
      gl.scissor(Math.floor(x), Math.floor(y), Math.max(0, Math.floor(w)), Math.max(0, Math.floor(h)));
    } else {
      const k = dpiScale;
      const px0 = Math.floor(x * k), py0 = Math.floor(y * k);
      const px1 = Math.ceil((x + w) * k), py1 = Math.ceil((y + h) * k);
      gl.scissor(px0, canvasEl.height - py1, Math.max(0, px1 - px0), Math.max(0, py1 - py0));
    }
  } else {
    gl.disable(gl.SCISSOR_TEST);
  }
}

function applyBlend() {
  const mode = st.blendMode, alphaMode = st.alphaMode;
  let op = gl.FUNC_ADD, srcRGB = gl.ONE, srcA = gl.ONE, dstRGB = gl.ZERO, dstA = gl.ZERO;
  switch (mode) {
    case 'alpha':
      srcRGB = srcA = gl.ONE; dstRGB = dstA = gl.ONE_MINUS_SRC_ALPHA; break;
    case 'multiply':
      srcRGB = srcA = gl.DST_COLOR; dstRGB = dstA = gl.ZERO; break;
    case 'subtract':
      op = gl.FUNC_REVERSE_SUBTRACT;
      srcRGB = gl.ONE; srcA = gl.ZERO; dstRGB = dstA = gl.ONE; break;
    case 'add':
      srcRGB = gl.ONE; srcA = gl.ZERO; dstRGB = dstA = gl.ONE; break;
    case 'lighten':
      op = gl.MAX; srcRGB = srcA = dstRGB = dstA = gl.ONE; break;
    case 'darken':
      op = gl.MIN; srcRGB = srcA = dstRGB = dstA = gl.ONE; break;
    case 'screen':
      srcRGB = srcA = gl.ONE; dstRGB = dstA = gl.ONE_MINUS_SRC_COLOR; break;
    case 'replace': default:
      srcRGB = srcA = gl.ONE; dstRGB = dstA = gl.ZERO; break;
  }
  if (srcRGB === gl.ONE && alphaMode === 'alphamultiply' && mode !== 'replace') srcRGB = gl.SRC_ALPHA;
  gl.enable(gl.BLEND);
  gl.blendEquation(op);
  gl.blendFuncSeparate(srcRGB, dstRGB, srcA, dstA);
}

const STENCIL_COMPARE = () => ({
  // LÖVE compares (stencil COMPARE value); GL compares (value FUNC stencil), so these are swapped.
  less: gl.GREATER, lequal: gl.GEQUAL, equal: gl.EQUAL, gequal: gl.LEQUAL,
  greater: gl.LESS, notequal: gl.NOTEQUAL, always: gl.ALWAYS, never: gl.NEVER,
});

function applyStencilTest() {
  if (st.writingStencil) return;
  if (st.stencilCompare && st.stencilCompare !== 'always') {
    gl.enable(gl.STENCIL_TEST);
    gl.stencilFunc(STENCIL_COMPARE()[st.stencilCompare], st.stencilValue, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
  } else {
    gl.disable(gl.STENCIL_TEST);
  }
}

// ---------------------------------------------------------------
// Line geometry (LÖVE-style polylines with optional 1px smoothing fringe)
// ---------------------------------------------------------------
// Scratch space for drawPolyline (grown as needed, reused every call).
let plPts = new Float64Array(512);
let plNx = new Float64Array(256), plNy = new Float64Array(256);
let plInX = new Float64Array(256), plInY = new Float64Array(256);
let plOutX = new Float64Array(256), plOutY = new Float64Array(256);
// The current line's half-width, fringe width and colors (solid, and
// faded to nothing at the fringe's outer edge), for plQuad.
let plHW = 0, plFringe = 0, plC = 0, plC0 = 0;

// Emits a quad strip section between two "rails" — (aL, aR) -> (bL, bR)
// given as center + offset-direction pairs, with fringe.
function plQuad(ax, ay, aox, aoy, bx, by, box, boy) {
  const hw = plHW, c = plC, c0 = plC0;
  // Core: from -offset to +offset
  const aLx = ax - aox * hw, aLy = ay - aoy * hw, aRx = ax + aox * hw, aRy = ay + aoy * hw;
  const bLx = bx - box * hw, bLy = by - boy * hw, bRx = bx + box * hw, bRy = by + boy * hw;
  pushVC(aLx, aLy, 0, 0, c); pushVC(aRx, aRy, 0, 0, c); pushVC(bRx, bRy, 0, 0, c);
  pushVC(aLx, aLy, 0, 0, c); pushVC(bRx, bRy, 0, 0, c); pushVC(bLx, bLy, 0, 0, c);
  if (plFringe > 0) {
    const f = plFringe;
    // Scale the fringe along the (possibly miter-lengthened) offset direction.
    const aol = Math.hypot(aox, aoy) || 1, bol = Math.hypot(box, boy) || 1;
    const aLLx = aLx - aox / aol * f * aol, aLLy = aLy - aoy / aol * f * aol;
    const bLLx = bLx - box / bol * f * bol, bLLy = bLy - boy / bol * f * bol;
    const aRRx = aRx + aox * f, aRRy = aRy + aoy * f;
    const bRRx = bRx + box * f, bRRy = bRy + boy * f;
    pushVC(aLLx, aLLy, 0, 0, c0); pushVC(aLx, aLy, 0, 0, c); pushVC(bLx, bLy, 0, 0, c);
    pushVC(aLLx, aLLy, 0, 0, c0); pushVC(bLx, bLy, 0, 0, c); pushVC(bLLx, bLLy, 0, 0, c0);
    pushVC(aRx, aRy, 0, 0, c); pushVC(aRRx, aRRy, 0, 0, c0); pushVC(bRRx, bRRy, 0, 0, c0);
    pushVC(aRx, aRy, 0, 0, c); pushVC(bRRx, bRRy, 0, 0, c0); pushVC(bRx, bRy, 0, 0, c);
  }
}

// coords: flat x, y list (an array or typed array); len: how many of its
// numbers to use (default all).
function drawPolyline(coords, closed, len = coords.length) {
  let n = len / 2;
  if (n < 2) return;
  if (plPts.length < len) plPts = new Float64Array(Math.max(len, plPts.length * 2));
  const pts = plPts;
  // Drop consecutive duplicate points (they have no direction).
  let k = 0;
  for (let i = 0; i < n; i++) {
    const x = coords[i * 2], y = coords[i * 2 + 1];
    if (k >= 2 && Math.abs(pts[k - 2] - x) < 1e-9 && Math.abs(pts[k - 1] - y) < 1e-9) continue;
    pts[k] = x; pts[k + 1] = y; k += 2;
  }
  if (closed && k >= 4) {
    if (Math.abs(pts[0] - pts[k - 2]) < 1e-9 && Math.abs(pts[1] - pts[k - 1]) < 1e-9) k -= 2;
  }
  n = k / 2;
  if (n < 2) return;
  if (plNx.length < n) {
    const m = Math.max(n, plNx.length * 2);
    plNx = new Float64Array(m); plNy = new Float64Array(m);
    plInX = new Float64Array(m); plInY = new Float64Array(m);
    plOutX = new Float64Array(m); plOutY = new Float64Array(m);
  }

  const ps = pixelScale();
  let hw = st.lineWidth / 2;
  const smooth = st.lineStyle === 'smooth';
  // The fringe that fades the edge out over about one screen pixel.
  const fringe = smooth ? 1 / ps : 0;
  if (smooth) hw = Math.max(hw - fringe * 0.5, fringe * 0.25);

  const col = st.color;
  plHW = hw; plFringe = fringe;
  plC = packColor(col[0], col[1], col[2], col[3]);
  plC0 = packColor(col[0], col[1], col[2], 0);
  const segCount = closed ? n : n - 1;

  // Segment normals
  const nx = plNx, ny = plNy;
  for (let i = 0; i < segCount; i++) {
    const x0 = pts[i * 2], y0 = pts[i * 2 + 1];
    const j = (i + 1) % n;
    const dx = pts[j * 2] - x0, dy = pts[j * 2 + 1] - y0;
    const len = Math.hypot(dx, dy) || 1;
    nx[i] = -dy / len; ny[i] = dx / len;
  }

  const vertsPerQuad = fringe > 0 ? 18 : 6;

  if (st.lineJoin === 'none' || segCount === 1 && !closed) {
    reserve(null, segCount * vertsPerQuad);
    for (let i = 0; i < segCount; i++) {
      const j = (i + 1) % n;
      plQuad(pts[i * 2], pts[i * 2 + 1], nx[i], ny[i], pts[j * 2], pts[j * 2 + 1], nx[i], ny[i]);
    }
    return;
  }

  // Per-vertex join offsets. For miter: one offset direction (scaled
  // so the edges meet). For bevel: the incoming and outgoing normals.
  const inX = plInX, inY = plInY, outX = plOutX, outY = plOutY;
  const bevel = st.lineJoin === 'bevel';
  for (let i = 0; i < n; i++) {
    let prev = i - 1, next = i;
    if (closed) { prev = (i - 1 + segCount) % segCount; next = i % segCount; }
    const hasPrev = closed || i > 0;
    const hasNext = closed || i < n - 1;
    if (!hasPrev) { inX[i] = outX[i] = nx[next]; inY[i] = outY[i] = ny[next]; continue; }
    if (!hasNext) { inX[i] = outX[i] = nx[prev]; inY[i] = outY[i] = ny[prev]; continue; }
    if (bevel) {
      inX[i] = nx[prev]; inY[i] = ny[prev];
      outX[i] = nx[next]; outY[i] = ny[next];
    } else {
      let mx = nx[prev] + nx[next], my = ny[prev] + ny[next];
      const ml = Math.hypot(mx, my);
      if (ml < 1e-6) { mx = nx[prev]; my = ny[prev]; }
      else {
        mx /= ml; my /= ml;
        let d = mx * nx[next] + my * ny[next];
        // Keep very sharp corners from producing huge spikes.
        d = Math.max(d, 0.1);
        mx /= d; my /= d;
      }
      inX[i] = outX[i] = mx; inY[i] = outY[i] = my;
    }
  }
  const joins = bevel ? n : 0;
  reserve(null, (segCount + joins) * vertsPerQuad);
  for (let i = 0; i < segCount; i++) {
    const j = (i + 1) % n;
    plQuad(pts[i * 2], pts[i * 2 + 1], outX[i], outY[i], pts[j * 2], pts[j * 2 + 1], inX[j], inY[j]);
    if (bevel && (closed || j < n - 1)) {
      // Fill the wedge between this segment's end and the next one's start.
      plQuad(pts[j * 2], pts[j * 2 + 1], inX[j], inY[j], pts[j * 2], pts[j * 2 + 1], outX[j], outY[j]);
    }
  }
}

function flattenCoords(args) {
  if (args.length === 1 && Array.isArray(args[0])) return args[0].flat ? args[0].flat() : args[0];
  return args;
}

function ellipsePoints(rx, ry) {
  const p = Math.floor(Math.sqrt(((rx + ry) / 2) * 20 * pixelScale()));
  return Math.max(p, 8);
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------
function setColor(r, g, b, a) {
  if (Array.isArray(r)) { a = r[3]; b = r[2]; g = r[1]; r = r[0]; }
  // LÖVE clamps every component to 0..1 (checked against LÖVE 11.5:
  // an alpha of 3.5 draws exactly like 1, meshes included). (Updated in
  // place: push('all') keeps its own copy, so nothing else holds this one.)
  const c = st.color;
  c[0] = r === undefined || r === null ? 1 : (r < 0 ? 0 : (r > 1 ? 1 : r));
  c[1] = g === undefined || g === null ? 1 : (g < 0 ? 0 : (g > 1 ? 1 : g));
  c[2] = b === undefined || b === null ? 1 : (b < 0 ? 0 : (b > 1 ? 1 : b));
  c[3] = a === undefined || a === null ? 1 : (a < 0 ? 0 : (a > 1 ? 1 : a));
}

function getColor() { return st.color.slice(); }

function setBackgroundColor(r, g, b, a) {
  if (Array.isArray(r)) { [r, g, b, a] = r; }
  st.backgroundColor = [r ?? 0, g ?? 0, b ?? 0, a ?? 1];
}
function getBackgroundColor() { return st.backgroundColor.slice(); }

function clear(r, g, b, a, clearStencil = true) {
  flush();
  if (r === undefined) [r, g, b, a] = st.backgroundColor;
  if (Array.isArray(r)) { clearStencil = g ?? true; [r, g, b, a] = r; }
  gl.clearColor(r, g ?? 0, b ?? 0, a ?? 1);
  let bits = gl.COLOR_BUFFER_BIT;
  const hasStencil = !st.canvas || st.canvas.stencilRb;
  if (clearStencil !== false && hasStencil) {
    gl.clearStencil(0);
    gl.stencilMask(0xff);
    bits |= gl.STENCIL_BUFFER_BIT;
  }
  gl.clear(bits);
}

function setLineWidth(w) { st.lineWidth = w; }
function getLineWidth() { return st.lineWidth; }
function setLineStyle(s) { st.lineStyle = s; }
function getLineStyle() { return st.lineStyle; }
function setLineJoin(j) { st.lineJoin = j; }
function getLineJoin() { return st.lineJoin; }
function setPointSize(s) { st.pointSize = s; }
function getPointSize() { return st.pointSize; }

function setBlendMode(mode, alphaMode = 'alphamultiply') {
  if (mode === st.blendMode && alphaMode === st.alphaMode) return;
  flush();
  st.blendMode = mode;
  st.alphaMode = alphaMode;
  applyBlend();
}
function getBlendMode() { return [st.blendMode, st.alphaMode]; }

function setShader(shader) {
  shader = shader || null;
  if (shader === st.shader) return;
  flush();
  st.shader = shader;
  const sh = activeShader();
  useProgram(sh.program);
  // Make sure the new program has this target's projection.
  sh.cachedProjection = null;
}
function getShader() { return st.shader; }

function newShader(pixel, vertex) {
  flush();
  const s = new Shader(pixel, vertex);
  useProgram(activeShader().program);
  return s;
}

// setCanvas(canvas) / setCanvas({canvas, stencil: true}) / setCanvas()
function setCanvas(c) {
  flush();
  let canvas = null, wantStencil = false;
  if (c instanceof Canvas) canvas = c;
  else if (c && typeof c === 'object') {
    canvas = c[0] || c.canvas || null;
    wantStencil = !!(c.stencil || c.depthstencil);
  }
  st.canvas = canvas;
  st.canvasWantsStencil = wantStencil;
  if (canvas && wantStencil) canvas.ensureStencil();
  rebindTarget();
  // Force uniform refresh for the new projection.
  if (defaultShader) defaultShader.cachedProjection = null;
  if (st.shader) st.shader.cachedProjection = null;
}
function getCanvas() { return st.canvas; }

function stencil(fn, action = 'replace', value = 1, keepValues = false) {
  flush();
  if (st.canvas && !st.canvas.stencilRb) st.canvas.ensureStencil();
  if (!keepValues) {
    gl.clearStencil(0);
    gl.stencilMask(0xff);
    gl.clear(gl.STENCIL_BUFFER_BIT);
  }
  const ops = {
    replace: gl.REPLACE, increment: gl.INCR, decrement: gl.DECR,
    incrementwrap: gl.INCR_WRAP, decrementwrap: gl.DECR_WRAP, invert: gl.INVERT,
  };
  gl.enable(gl.STENCIL_TEST);
  gl.stencilFunc(gl.ALWAYS, value, 0xff);
  gl.stencilOp(gl.KEEP, gl.KEEP, ops[action] || gl.REPLACE);
  gl.stencilMask(0xff);
  gl.colorMask(false, false, false, false);
  st.writingStencil = true;
  try {
    fn();
    flush();
  } finally {
    st.writingStencil = false;
    gl.colorMask(true, true, true, true);
    applyStencilTest();
  }
}

function setStencilTest(compare, value) {
  flush();
  if (compare === undefined || compare === null) {
    st.stencilCompare = null;
  } else {
    st.stencilCompare = compare;
    st.stencilValue = value ?? 0;
  }
  applyStencilTest();
}
function getStencilTest() {
  return st.stencilCompare ? [st.stencilCompare, st.stencilValue] : ['always', 0];
}

function setScissor(x, y, w, h) {
  flush();
  st.scissor = (x === undefined) ? null : [x, y, w, h];
  applyScissor();
}
function getScissor() { return st.scissor ? st.scissor.slice() : []; }

function setDefaultFilter(min, mag = min) {
  st.defaultMinFilter = min;
  st.defaultMagFilter = mag;
}
function getDefaultFilter() { return [st.defaultMinFilter, st.defaultMagFilter]; }

// --- transform stack ---
// push() saves the transform; push('all') also saves the color, blend
// mode, shader, canvas, stencil test, scissor, line and font settings,
// and pop() puts all of them back.
function push(kind) {
  const entry = { t: st.t.slice(), all: null };
  if (kind === 'all') {
    entry.all = {
      color: st.color.slice(), backgroundColor: st.backgroundColor.slice(),
      lineWidth: st.lineWidth, lineStyle: st.lineStyle, lineJoin: st.lineJoin, pointSize: st.pointSize,
      blendMode: st.blendMode, alphaMode: st.alphaMode, shader: st.shader,
      canvas: st.canvas, canvasWantsStencil: st.canvasWantsStencil,
      stencilCompare: st.stencilCompare, stencilValue: st.stencilValue,
      scissor: st.scissor ? st.scissor.slice() : null, font: st.font,
    };
  }
  st.stack.push(entry);
}
function pop() {
  if (st.stack.length === 0) throw new Error('Minimum stack depth reached (more pops than pushes?)');
  const entry = st.stack.pop();
  st.t = entry.t;
  const a = entry.all;
  if (a) {
    st.color = a.color; st.backgroundColor = a.backgroundColor;
    st.lineWidth = a.lineWidth; st.lineStyle = a.lineStyle; st.lineJoin = a.lineJoin; st.pointSize = a.pointSize;
    st.font = a.font;
    setBlendMode(a.blendMode, a.alphaMode);
    setShader(a.shader);
    if (a.canvas !== st.canvas) setCanvas(a.canvas ? { 0: a.canvas, stencil: a.canvasWantsStencil } : null);
    if (a.stencilCompare !== st.stencilCompare || a.stencilValue !== st.stencilValue) setStencilTest(a.stencilCompare ?? undefined, a.stencilValue);
    const sc = a.scissor;
    if (JSON.stringify(sc) !== JSON.stringify(st.scissor)) { if (sc) setScissor(...sc); else setScissor(); }
  }
}
function origin() { st.t = [1, 0, 0, 1, 0, 0]; }
function translate(x, y) { st.t = mul(st.t, [1, 0, 0, 1, x, y]); }
function rotate(a) {
  const c = Math.cos(a), s = Math.sin(a);
  st.t = mul(st.t, [c, s, -s, c, 0, 0]);
}
function scale(sx, sy = sx) { st.t = mul(st.t, [sx, 0, 0, sy, 0, 0]); }
function shear(kx, ky) { st.t = mul(st.t, [1, ky, kx, 1, 0, 0]); }
function transformPoint(x, y) {
  const t = st.t;
  return [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
}
function inverseTransformPoint(x, y) {
  const [a, b, c, d, e, f] = st.t;
  const det = a * d - b * c;
  const px = x - e, py = y - f;
  return [(d * px - c * py) / det, (-b * px + a * py) / det];
}

function getWidth() { return screenW; }
function getHeight() { return screenH; }
function getDimensions() { return [screenW, screenH]; }
function getPixelWidth() { return canvasEl.width; }
function getPixelHeight() { return canvasEl.height; }
function getDPIScale() { return dpiScale; }

// --- shapes ---
function rectangle(mode, x, y, w, h, rx, ry, segs) {
  if (rx !== undefined && rx > 0) {
    ry = ry ?? rx;
    rx = Math.min(rx, Math.abs(w) / 2);
    ry = Math.min(ry, Math.abs(h) / 2);
    const pts = [];
    const n = segs ?? Math.max(1, Math.floor(ellipsePoints(rx, ry) / 4));
    const corner = (cx, cy, a0) => {
      for (let i = 0; i <= n; i++) {
        const a = a0 + (Math.PI / 2) * (i / n);
        pts.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
      }
    };
    corner(x + w - rx, y + h - ry, 0);
    corner(x + rx, y + h - ry, Math.PI / 2);
    corner(x + rx, y + ry, Math.PI);
    corner(x + w - rx, y + ry, Math.PI * 1.5);
    polygon(mode, pts);
    return;
  }
  polygon(mode, [x, y, x + w, y, x + w, y + h, x, y + h]);
}

// Unit-circle point tables, one per segment count (cos/sin are the
// costly part of drawing a circle, and the same counts recur every frame).
const unitCircles = new Map();
function unitCircle(n) {
  let c = unitCircles.get(n);
  if (!c) {
    c = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      c[i * 2] = Math.cos(a);
      c[i * 2 + 1] = Math.sin(a);
    }
    unitCircles.set(n, c);
  }
  return c;
}

// Scratch space for an ellipse's outline (see ellipse).
let ellipsePts = new Float64Array(512);

function ellipse(mode, x, y, rx, ry, segs) {
  ry = ry ?? rx;
  const n = segs ?? ellipsePoints(rx, ry);
  const u = unitCircle(n);
  if (mode === 'fill') {
    // (The same fan of triangles from the first point as polygon('fill')
    // makes, written straight into the batch.)
    if (n < 3) return;
    reserve(null, (n - 2) * 3);
    const c = currentColor();
    const x0 = x + u[0] * rx, y0 = y + u[1] * ry;
    let px = x + u[2] * rx, py = y + u[3] * ry;
    for (let i = 1; i < n - 1; i++) {
      const qx = x + u[i * 2 + 2] * rx, qy = y + u[i * 2 + 3] * ry;
      pushVC(x0, y0, 0, 0, c);
      pushVC(px, py, 0, 0, c);
      pushVC(qx, qy, 0, 0, c);
      px = qx; py = qy;
    }
    return;
  }
  if (ellipsePts.length < n * 2) ellipsePts = new Float64Array(Math.max(n * 2, ellipsePts.length * 2));
  const pts = ellipsePts;
  for (let i = 0; i < n; i++) {
    pts[i * 2] = x + u[i * 2] * rx;
    pts[i * 2 + 1] = y + u[i * 2 + 1] * ry;
  }
  drawPolyline(pts, true, n * 2);
}

function circle(mode, x, y, r, segs) {
  ellipse(mode, x, y, r, r, segs);
}

// arc(mode, [arctype,] x, y, r, a1, a2, segs)
function arc(mode, ...args) {
  let arctype = 'pie';
  if (typeof args[0] === 'string') arctype = args.shift();
  let [x, y, r, a1, a2, segs] = args;
  if (a1 === a2) return;
  const twoPi = Math.PI * 2;
  if (Math.abs(a1 - a2) >= twoPi) { circle(mode, x, y, r, segs); return; }
  if (segs === undefined || segs <= 0) {
    const full = ellipsePoints(r, r);
    segs = Math.max(Math.floor(full * Math.abs(a2 - a1) / twoPi), 1);
  }
  const pts = [];
  if (arctype === 'pie') pts.push(x, y);
  for (let i = 0; i <= segs; i++) {
    const a = a1 + (a2 - a1) * (i / segs);
    pts.push(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  if (mode === 'fill') {
    pushFan(arctype === 'pie' ? pts : pts);
  } else if (arctype === 'open') {
    drawPolyline(pts, false);
  } else {
    drawPolyline(pts, true);
  }
}

function polygon(mode, ...args) {
  const pts = flattenCoords(args);
  if (mode === 'fill') pushFan(pts);
  else drawPolyline(pts, true);
}

function line(...args) {
  drawPolyline(flattenCoords(args), false);
}

function points(...args) {
  let pts = args;
  if (args.length === 1 && Array.isArray(args[0])) pts = args[0];
  const flatPts = [];
  const colors = [];
  for (const p of pts) {
    if (Array.isArray(p)) { flatPts.push(p[0], p[1]); colors.push(p.length > 2 ? [p[2], p[3], p[4], p[5] ?? 1] : null); }
    else flatPts.push(p);
  }
  const n = Math.floor(flatPts.length / 2);
  const hs = st.pointSize / 2 / pixelScale();
  reserve(null, n * 6);
  for (let i = 0; i < n; i++) {
    const x = flatPts[i * 2], y = flatPts[i * 2 + 1];
    const [r, g, b, a] = colors[i] || st.color;
    pushV(x - hs, y - hs, 0, 0, r, g, b, a); pushV(x + hs, y - hs, 0, 0, r, g, b, a); pushV(x + hs, y + hs, 0, 0, r, g, b, a);
    pushV(x - hs, y - hs, 0, 0, r, g, b, a); pushV(x + hs, y + hs, 0, 0, r, g, b, a); pushV(x - hs, y + hs, 0, 0, r, g, b, a);
  }
}

// --- drawables ---
function drawTextured(texture, qx, qy, qw, qh, tw, th, m) {
  const saved = st.t;
  st.t = m;
  reserve(texture, 6);
  const u0 = qx / tw, v0 = qy / th, u1 = (qx + qw) / tw, v1 = (qy + qh) / th;
  const c = currentColor();
  pushVC(0, 0, u0, v0, c); pushVC(qw, 0, u1, v0, c); pushVC(qw, qh, u1, v1, c);
  pushVC(0, 0, u0, v0, c); pushVC(qw, qh, u1, v1, c); pushVC(0, qh, u0, v1, c);
  st.t = saved;
}

// draw(drawable, [quad,] x, y, r, sx, sy, ox, oy, kx, ky)
function draw(drawable, ...args) {
  let quad = null;
  if (args[0] instanceof Quad) quad = args.shift();
  const m = mul(st.t, localTransform(...args));
  if (drawable instanceof Mesh || drawable instanceof SpriteBatch) {
    drawable.drawWith(m);
    return;
  }
  if (drawable instanceof Texture) {
    if (quad) drawTextured(drawable, quad.x, quad.y, quad.w, quad.h, quad.sw, quad.sh, m);
    else drawTextured(drawable, 0, 0, drawable.width, drawable.height, drawable.width, drawable.height, m);
    return;
  }
  throw new Error('love.graphics.draw: unsupported drawable');
}

// print(text, x, y, r, sx, sy, ox, oy, kx, ky)
function print(text, ...args) {
  const font = st.font || getDefaultFont();
  if (Array.isArray(text)) {
    // Colored text: { color, string, color, string, ... }
    let s = '';
    for (let i = 1; i < text.length; i += 2) s += text[i];
    text = s;
  }
  text = String(text);
  const m = mul(st.t, localTransform(...args));
  const saved = st.t;
  st.t = m;
  const c = currentColor();
  let penY = 0;
  for (const lineText of text.split('\n')) {
    let penX = 0;
    for (const ch of lineText) {
      const gph = font.glyph(ch);
      if (ch !== ' ') {
        const img = font.pageImage(gph.page);
        reserve(img, 6);
        const x0 = penX - gph.ox, y0 = penY - gph.oy;
        const x1 = x0 + gph.w, y1 = y0 + gph.h;
        const u0 = gph.x / ATLAS_SIZE, v0 = gph.y / ATLAS_SIZE;
        const u1 = (gph.x + gph.aw) / ATLAS_SIZE, v1 = (gph.y + gph.ah) / ATLAS_SIZE;
        pushVC(x0, y0, u0, v0, c); pushVC(x1, y0, u1, v0, c); pushVC(x1, y1, u1, v1, c);
        pushVC(x0, y0, u0, v0, c); pushVC(x1, y1, u1, v1, c); pushVC(x0, y1, u0, v1, c);
      }
      penX += gph.adv;
    }
    penY += Math.round(font.height * font.lineHeight);
  }
  st.t = saved;
}

// printf(text, x, y, limit, align, r, sx, sy, ox, oy)
function printf(text, x, y, limit, align = 'left', ...rest) {
  const font = st.font || getDefaultFont();
  const [, lines] = font.getWrap(String(text), limit);
  let yy = 0;
  for (const l of lines) {
    const w = font.getWidth(l);
    let xx = 0;
    if (align === 'center') xx = (limit - w) / 2;
    else if (align === 'right') xx = limit - w;
    push();
    translate(x, y);
    if (rest.length) {
      const m = localTransform(0, 0, ...rest);
      st.t = mul(st.t, m);
    }
    print(l, xx, yy);
    pop();
    yy += Math.round(font.height * font.lineHeight);
  }
}

let defaultFont = null;
function getDefaultFont() {
  if (!defaultFont) defaultFont = new Font(12);
  return defaultFont;
}
function newFont(a, b) {
  if (typeof a === 'number') return new Font(a);
  if (typeof a === 'string') return new Font(b ?? 12, `"${a}", ${DEFAULT_FONT_FAMILY}`);
  return new Font(12);
}
function setFont(f) { st.font = f; }
function getFont() { return st.font || getDefaultFont(); }

// --- object constructors ---
let assetLookup = null; // set by index.js: path -> decoded ImageBitmap
function setAssetLookup(fn) { assetLookup = fn; }

function newImage(src, settings) {
  flush();
  if (typeof src === 'string') {
    const bmp = assetLookup && assetLookup(src);
    if (!bmp) throw new Error(`newImage: "${src}" was not preloaded (add it to the asset list)`);
    return new Image(bmp, settings);
  }
  return new Image(src, settings);
}
function newCanvas(w, h, settings) {
  flush();
  return new Canvas(w ?? screenW, h ?? screenH, settings);
}
function newQuad(x, y, w, h, sw, sh) {
  if (sw && typeof sw === 'object') { sh = sw.height; sw = sw.width; }
  return new Quad(x, y, w, h, sw, sh);
}
function newMesh(a, b, c, d) {
  // newMesh(vertices|count, mode, usage) — the vertex-format form isn't supported.
  if (Array.isArray(a) && a.length && Array.isArray(a[0]) && typeof a[0][0] === 'string') {
    throw new Error('newMesh: custom vertex formats are not supported');
  }
  return new Mesh(a, b, c);
}
function newSpriteBatch(texture, size) { return new SpriteBatch(texture, size); }

// ---------------------------------------------------------------
// Init / frame
// ---------------------------------------------------------------
function init(el) {
  canvasEl = el;
  gl = el.getContext('webgl2', {
    alpha: false, antialias: false, stencil: true, depth: false,
    premultipliedAlpha: false, preserveDrawingBuffer: false,
  });
  if (!gl) throw new Error('WebGL2 is not available in this browser.');
  batchVbo = gl.createBuffer();
  vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, batchVbo);
  bindVertexLayout();
  const white = new ImageData(1, 1, new Uint8ClampedArray([255, 255, 255, 255]));
  whiteTex = new Image(white);
  defaultShader = new Shader(DEFAULT_EFFECT, null, true);
  useProgram(defaultShader.program);
  applyBlend();
  rebindTarget();
}

// Draw calls: counting this frame, and the last frame's total (getStats).
let drawCalls = 0, lastFrameDrawCalls = 0;
function getStats() {
  return { drawcalls: lastFrameDrawCalls };
}

function beginFrame() {
  lastFrameDrawCalls = drawCalls;
  drawCalls = 0;
  st.canvas = null;
  rebindTarget();
  if (defaultShader) defaultShader.cachedProjection = null;
  if (st.shader) st.shader.cachedProjection = null;
  origin();
}

function present() {
  flush();
}

// How much bigger than its nominal size a font's glyphs are rasterized:
// the screen's real pixels per game unit (so text is drawn 1:1 with the
// screen's pixels), kept within reason.
function fontRasterScale() {
  return Math.min(4, Math.max(0.5, dpiScale));
}

// w, h: the window in logical units; scale: real pixels per unit.
function setScreen(w, h, scale) {
  screenW = w; screenH = h;
  if (scale !== dpiScale) {
    dpiScale = scale;
    for (const font of allFonts) font.setRasterScale(fontRasterScale());
  }
}

function onResize() {
  if (!st.canvas) rebindTarget();
  if (defaultShader) defaultShader.cachedProjection = null;
  if (st.shader) st.shader.cachedProjection = null;
}

function isInitialized() { return !!gl; }

// Waits for the GPU to finish everything drawn so far (reads back one
// pixel). For measuring how long a frame really takes; never needed
// otherwise.
const syncPixel = new Uint8Array(4);
function syncGPU() {
  flush();
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncPixel);
}

const graphics = {
  // state
  setColor, getColor, setBackgroundColor, getBackgroundColor, clear,
  setLineWidth, getLineWidth, setLineStyle, getLineStyle, setLineJoin, getLineJoin,
  setPointSize, getPointSize, setBlendMode, getBlendMode,
  setShader, getShader, newShader,
  setCanvas, getCanvas, stencil, setStencilTest, getStencilTest,
  setScissor, getScissor, setDefaultFilter, getDefaultFilter, getStats,
  push, pop, origin, translate, rotate, scale, shear, transformPoint, inverseTransformPoint,
  getWidth, getHeight, getDimensions, getPixelWidth, getPixelHeight, getDPIScale,
  // drawing
  rectangle, circle, ellipse, arc, polygon, line, points, draw, print, printf,
  // objects
  newImage, newCanvas, newQuad, newMesh, newSpriteBatch, newFont, setFont, getFont,
  // internal (used by love/index.js)
  _init: init, _beginFrame: beginFrame, _present: present, _onResize: onResize, _setScreen: setScreen, _syncGPU: syncGPU,
  _setAssetLookup: setAssetLookup, _isInitialized: isInitialized, _flush: flush,
};

export { graphics, ImageData, Image, Canvas, Mesh, Quad, Font, Shader, SpriteBatch };
export default graphics;
