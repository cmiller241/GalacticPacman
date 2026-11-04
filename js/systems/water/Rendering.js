// js/systems/water/Rendering.js
//
// Drawing the water and lava: the shaders, the pools on the level, the
// layers on planetoids, dirt planets' water, droplets and splashes.
// Part of the water system: see js/systems/WaterSystem.js.

import love from '../../love/index.js';
import state from '../../state.js';
import {
  CELL, OCEAN_SEGMENTS, OCEAN_MAX_SEGMENTS, SPLASH_SECONDS,
  WATERFALL_SPLASH_MIN_FALL, LAVA_TUNING, COLOR_SHALLOW, COLOR_DEEP, DEEP_AT,
  ALPHA_SHALLOW, ALPHA_DEEP, COLOR_SURFACE, SURFACE_LINE, SURFACE_FEATHER,
  STREAM_REACH_CELLS, LIP_THICKNESS, SURFACE_SLICES, SURFACE_GLOW,
  COLOR_CAUSTIC, CAUSTIC_SCALE, CAUSTIC_GROW_FROM_DEPTH, CAUSTIC_GROW_POWER,
  CAUSTIC_MAX_GROWTH, SPHERE_COLOR_SHALLOW, SPHERE_COLOR_DEEP,
  SPHERE_COLOR_SHADE, SPHERE_SHADE_STRENGTH, SPHERE_COLOR_RIM,
  SPHERE_RIM_STRENGTH, SPHERE_COLOR_REFLECTED, SPHERE_REFLECTED_STRENGTH,
  CORE_OVERLAY_FROM_DEPTH, CORE_OVERLAY_FULL_DEPTH, CORE_OVERLAY_MAX,
  CAUSTIC_BULGE, CAUSTIC_SPEED, CAUSTIC_STRENGTH, COLOR_DROPLET,
} from './Tuning.js';
import { shared, Ice, Scratch, WATER, LAVA } from './Shared.js';
import { depthOf } from './Oceans.js';
import { isSolid, blocked } from './LevelGrid.js';
import { planetPoint, planetColWidth, planetCol, planetSolid } from './PlanetGrids.js';
import { drawSteam } from './Effects.js';
import { getObsidianImage } from './Obsidian.js';

// Functions it adds to WaterSystem (copied on in js/systems/WaterSystem.js).
const WaterSystem = {};

const meshes = new Map(), meshSizes = new Map(); // a mesh for each liquid (see drawLiquidMesh)

// A dirt planet's water (see above), through the same shader and the
// same way as the pools (see drawPools — the same rules, on the planet's
// grid: "down" toward its center, or down the flat layout's rows; a
// column's height measured up from there):
//   - each column's resting water drawn as one stack from its floor up,
//     taking in up to two part-full cells over its full ones, at its real
//     height, so a pool's edge or a gently sloping surface doesn't step
//     row to row or throw up stray streams;
//   - a little water just settling onto a pool, or spilling a cell or
//     two down a step onto water below, not drawn at all (it's part of
//     the pool by next step; drawn as a stream it'd stick up out of the
//     surface as a one-cell spike);
//   - the surface in thin slices easing toward the columns either side
//     and rippling, so it curves rather than stepping column to column;
//   - falling water as a narrow stream down the middle of its column,
//     reaching down through any dry gap to whatever it's falling onto,
//     and — pouring over an edge — starting from the water it's spilling
//     off, with a short lip of water from the edge over to it.
// Only what's on screen. (Positions are in columns, f — c + 0.5 is
// column c's middle — and heights, h: see planetPoint.)
// (liquid: WATER or LAVA, as drawPools.)
function drawPlanetWater(g, liquid) {
  const cam = state.camera;
  if (!cam) return;
  const margin = CELL * 4;
  const vx0 = cam.x - margin, vy0 = cam.y - margin;
  const vx1 = cam.x + (state.visibleWidth ?? 0) + margin, vy1 = cam.y + (state.visibleHeight ?? 0) + margin;
  const px = g.planet.pos.x, py = g.planet.pos.y;
  const cols = g.cols, water = g[liquid.key], rows = g.rows;
  const rippleScale = liquid === LAVA ? LAVA_TUNING.RIPPLE : 1;
  Scratch.resetVerts();

  const cellBottom = (r) => g.top - (r + 1) * CELL;
  // A strip from column position f0 to f1: hTop0/hTop1 the height of its
  // top edge at each end, hBottom0/hBottom1 its bottom's; depthTop/
  // depthBottom how far below the surface those edges are; stream 1 for
  // falling water.
  const quad = (f0, hTop0, f1, hTop1, hBottom0, hBottom1, depthTop, depthBottom, stream) => {
    const [x1, y1] = planetPoint(g, f0, hTop0);
    const [x2, y2] = planetPoint(g, f1, hTop1);
    const [x3, y3] = planetPoint(g, f1, hBottom1);
    const [x4, y4] = planetPoint(g, f0, hBottom0);
    Scratch.quad(px + x1, py + y1, px + x2, py + y2, px + x3, py + y3, px + x4, py + y4,
      depthTop, depthBottom, stream);
  };
  // Where the ground under resting water in cell row r really is, at
  // column position f: on the flat layout, its square cells don't follow
  // the planet's curved ground, so found between the middles of the cell
  // and the one under it (round the planet, the cell's own bottom).
  const planet = g.planet;
  const solidAt = (f, h) => { const [x, y] = planetPoint(g, f, h); return planet.solidAtLocal(x, y); };
  const floorAt = (f, r) => {
    const bottom = cellBottom(r);
    if (!g.flat) return bottom;
    let lo = bottom - CELL * 0.5, hi = bottom + CELL * 0.5;
    if (solidAt(f, hi)) return hi;
    if (!solidAt(f, lo)) return lo;
    for (let k = 0; k < 5; k++) {
      const mid = (lo + hi) / 2;
      if (solidAt(f, mid)) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  };
  // (The same two waves as the pools', by distance along the surface.)
  const ripple = (f, h) => {
    const s = g.flat ? f * CELL : (g.a0 + f * g.dA) * h;
    return (Math.sin(shared.age * 2.2 + s * 0.045) * 1.3 + Math.sin(shared.age * 3.7 - s * 0.11) * 0.6) * rippleScale;
  };

  // The stacks (see drawPools): stackSurface: each stacked cell's
  // surface height; stackFloor: its bottom cell, which draws it.
  const stackSurface = new Map(), stackFloor = new Map();
  const capped = new Map(), capDepth = new Map(); // (by a stack's floor cell: see drawPools')
  for (const i of water.keys()) {
    const r = Math.floor(i / cols);
    const c = i - r * cols;
    if (!planetSolid(g, c, r + 1)) continue;
    const members = [];
    let total = 0, partials = 0, below = Infinity;
    let j = i, jr = r;
    while (jr >= 0 && water.has(j)) {
      const w = Math.min(1, water.get(j));
      if (w < 0.99) {
        if (partials === 2 || w >= below) break;
        partials += 1;
      }
      members.push(j);
      total += w;
      below = w;
      j -= cols; jr -= 1;
    }
    const surface = cellBottom(r) + Math.max(2, total * CELL);
    for (const m of members) { stackSurface.set(m, surface); stackFloor.set(m, i); }
    // (Full up to something solid over it — an ice tile, say: see drawPools'.)
    const topRow = r - members.length + 1;
    if (total >= members.length - 0.01 && topRow > 0 && planetSolid(g, c, topRow - 1)) capped.set(i, topRow);
  }
  for (const i of capped.keys()) {
    const r = Math.floor(i / cols);
    const c = i - r * cols;
    for (let d = 1; d <= 8 && !capDepth.has(i); d++) {
      for (let side = -1; side <= 1; side += 2) { // (c - d, then c + d)
        const nc = planetCol(g, c + side * d);
        const n = nc !== null ? r * cols + nc : null;
        if (n !== null && stackFloor.has(n) && !capped.has(stackFloor.get(n)) && stackSurface.get(n) > stackSurface.get(i)) {
          capDepth.set(i, stackSurface.get(n) - stackSurface.get(i));
          break;
        }
      }
    }
  }
  const isFalling = (i) => !stackSurface.has(i);
  // The resting water's surface in column c at about row r: that cell's
  // stack, or the one just below or above it.
  const surfaceNear = (c, r) => {
    const cc = planetCol(g, c);
    if (cc === null) return null;
    for (let step = 0; step < 3; step++) { // (r, then r + 1, then r - 1)
      const rr = step === 0 ? r : step === 1 ? r + 1 : r - 1;
      if (rr >= 0 && rr < rows) {
        const s = stackSurface.get(rr * cols + cc);
        if (s !== undefined) return s;
      }
    }
    return null;
  };

  for (const [i, w] of water) {
    const r = Math.floor(i / cols);
    const c = i - r * cols;
    const drawn = !stackFloor.has(i) || stackFloor.get(i) === i;
    const fm = c + 0.5;
    const rMid = g.top - (r + 0.5) * CELL;
    const [mx, my] = planetPoint(g, fm, rMid);
    const x = px + mx, y = py + my;
    if (!(drawn && x > vx0 && x < vx1 && y > vy0 && y < vy1)) continue;
    const f0 = c, f1 = c + 1;
    const rTop = g.top - r * CELL, rBottom = cellBottom(r);

    // Settling onto a pool, or stepping a cell or two down onto water
    // below: not drawn (see above). A real waterfall always has more
    // falling water above it, so it still is.
    let quiet = false;
    if (isFalling(i) && !water.has(i - 2 * cols)) {
      const b1 = i + cols, b2 = i + 2 * cols;
      if ((water.has(b1) && !isFalling(b1)) || (!water.has(b1) && water.has(b2) && !isFalling(b2))) {
        quiet = !water.has(i - cols) || !isFalling(i - cols);
      }
    }

    if (quiet) {
      // (nothing)
    } else if (isFalling(i)) {
      const half = CELL * Math.min(1, 0.25 + w * 2.5) / 2 / planetColWidth(g, rMid);
      let streamBottom = rBottom;
      let j = i + cols, jr = r + 1, gap = 0;
      while (gap < STREAM_REACH_CELLS && jr < rows && !water.has(j) && !planetSolid(g, c, jr)) {
        j += cols; jr += 1; gap += 1;
        streamBottom -= CELL;
      }
      if (water.has(j) && !isFalling(j)) streamBottom = Math.min(streamBottom, stackSurface.get(j));

      // Pouring over an edge (see drawPools): resting water right beside
      // it, the sheet on the ledge it's spilling off. The stream starts
      // at that water's surface, and a short lip of water runs from the
      // ledge's edge over to the stream, so the pour is one piece with
      // the water it comes from instead of a separate stream beside it.
      let streamTop = rTop;
      const sourceSurface = (dc) => {
        const nc = planetCol(g, c + dc);
        if (nc === null) return null;
        const n = r * cols + nc;
        if (water.has(n) && !isFalling(n)) return stackSurface.get(n);
        if (r > 0 && water.has(n - cols) && !isFalling(n - cols)) return stackSurface.get(n - cols);
        return null;
      };
      const srcBefore = sourceSurface(-1), srcAfter = sourceSurface(1);
      let src = srcBefore, side = -1;
      if (srcAfter !== null && (srcBefore === null || srcAfter > srcBefore)) { src = srcAfter; side = 1; }
      if (src !== null) {
        streamTop = src;
        const edgeF = side < 0 ? f0 : f1;
        const lipTop = src + ripple(edgeF, src);
        if (side < 0) {
          quad(edgeF, lipTop, fm, src - 2, lipTop - LIP_THICKNESS, src - 2 - LIP_THICKNESS, 0, 0, 1);
        } else {
          quad(fm, src - 2, edgeF, lipTop, src - 2 - LIP_THICKNESS, lipTop - LIP_THICKNESS, 0, 0, 1);
        }
      }
      quad(fm - half, streamTop, fm + half, streamTop, streamBottom, streamBottom, 0, 0, 1);
    } else {
      const surface = stackSurface.get(i);
      const cap = capped.has(stackFloor.get(i)) ? (capDepth.get(stackFloor.get(i)) ?? 0) : null;
      const neighborSurface = (dc) => {
        const s = surfaceNear(c + dc, r);
        if (s === null || Math.abs(s - surface) > CELL * 1.5 || cap !== null) return surface;
        return s;
      };
      const left = neighborSurface(-1), right = neighborSurface(1);
      const heightAt = (f) => { // f: 0..1 across the cell
        if (f < 0.5) {
          const k = 0.5 + f;
          return left + (surface - left) * (0.5 - 0.5 * Math.cos(Math.PI * k));
        }
        const k = f - 0.5;
        return surface + (right - surface) * (0.5 - 0.5 * Math.cos(Math.PI * k));
      };
      // (Its bottom on the ground under it: see floorAt.)
      const floorRow = Math.floor(stackFloor.get(i) / cols);
      const fl = [];
      for (let s = 0; s <= SURFACE_SLICES; s++) {
        fl[s] = floorRow === r ? floorAt(c + s / SURFACE_SLICES, r) : rBottom;
      }
      for (let s = 0; s < SURFACE_SLICES; s++) {
        const fa = s / SURFACE_SLICES, fb = (s + 1) / SURFACE_SLICES;
        const ba = fl[s], bb = fl[s + 1];
        const ha = heightAt(fa), hb = heightAt(fb);
        const ta = Math.max(ha + (cap !== null ? 0 : ripple(c + fa, surface)), ba + 1);
        const tb = Math.max(hb + (cap !== null ? 0 : ripple(c + fb, surface)), bb + 1);
        const d0 = cap ?? 0;
        quad(c + fa, ta, c + fb, tb, ba, bb, d0, d0 + (ha + hb) / 2 - (ba + bb) / 2, 0);
        // (A strip over the top, for the surface's soft edge — not under a cap.)
        if (cap === null) quad(c + fa, ta + SURFACE_FEATHER, c + fb, tb + SURFACE_FEATHER, ta, tb, -SURFACE_FEATHER, 0, 0);
      }
    }
  }
  if (Scratch.vertCount === 0) return;
  drawLiquidMesh(`planet-${liquid.key}`, liquid);
}

// The vertices built in Scratch (see Scratch.vert) drawn through
// `liquid`'s shader (the water's or the lava's), in the mesh kept for `slot`.
function drawLiquidMesh(slot, liquid) {
  const count = Scratch.vertCount;
  let m = meshes.get(slot);
  if (!m || meshSizes.get(slot) < count) {
    const size = Math.max(count, (meshSizes.get(slot) ?? 0) * 2, 600);
    m = love.graphics.newMesh(size, 'triangles', 'stream');
    meshes.set(slot, m);
    meshSizes.set(slot, size);
  }
  m.setVertices(Scratch.verts, 0, count);
  m.setDrawRange(0, count);
  if (liquid === LAVA) useLavaShader(); else useWaterShader();
  love.graphics.setColor(1, 1, 1, 1);
  love.graphics.draw(m);
  love.graphics.setShader();
}

// The pool shader. Each vertex carries, in its texture coordinates, how
// far below its pool's surface it is (u) and whether it's part of a
// falling stream (v = 1).
let waterShader = null;
function getWaterShader() {
  if (waterShader) return waterShader;
  waterShader = love.graphics.newShader(`
    varying vec2 worldPos;

    #ifdef VERTEX
    vec4 position(mat4 transform_projection, vec4 vertex_position) {
      worldPos = vertex_position.xy;
      return transform_projection * vertex_position;
    }
    #endif

    #ifdef PIXEL
    extern number time;
    extern vec3 colorShallow;
    extern vec3 colorDeep;
    extern number deepAt;
    extern number alphaShallow;
    extern number alphaDeep;
    extern vec3 colorSurface;
    extern number surfaceLine;
    extern number surfaceFeather;
    extern number surfaceGlow;
    extern vec3 colorCaustic;
    extern number causticScale;
    extern number causticSpeed;
    extern number causticStrength;
    extern vec2 bulgeCenter;
    extern number bulgeRadius;
    extern number causticBulge;
    extern number sphereShading;
    extern vec2 sunDir;
    extern vec3 sphereShallow;
    extern vec3 sphereDeep;
    extern vec3 sphereShade;
    extern number sphereShadeStrength;
    extern vec3 sphereRim;
    extern number sphereRimStrength;
    extern vec3 sphereReflected;
    extern number sphereReflectedStrength;

    vec2 hash2(vec2 p) {
      p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
      return fract(sin(p) * 43758.5453123);
    }

    vec2 voronoi(vec2 p, float t) {
      vec2 ip = floor(p);
      vec2 fp = fract(p);
      float f1 = 8.0;
      float f2 = 8.0;
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec2 neighbor = vec2(float(x), float(y));
          vec2 h = hash2(ip + neighbor);
          vec2 pt = neighbor + 0.5 + 0.4 * sin(t + 6.2831 * h) - fp;
          float d = length(pt);
          if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
        }
      }
      return vec2(f1, f2);
    }

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      float depth = uv.x;

      if (uv.y > 0.5) {
        float streak = 0.5 + 0.5 * sin(worldPos.y * 0.18 - time * 14.0 + worldPos.x * 0.9);
        vec3 c = mix(colorShallow, colorSurface, 0.3 + 0.45 * streak);
        return vec4(c, 0.55 + 0.3 * streak);
      }

      float t = clamp(depth / deepAt, 0.0, 1.0);
      vec3 c = mix(colorShallow, colorDeep, t);
      float a = mix(alphaShallow, alphaDeep, t);

      if (sphereShading > 0.0) {
        vec2 fromCenter = worldPos - bulgeCenter;
        float dist = length(fromCenter);
        float nxy = clamp(dist / bulgeRadius, 0.0, 1.0);
        vec2 inPlane = dist > 0.0001 ? fromCenter / dist : vec2(0.0);
        vec3 normal = vec3(inPlane * nxy, sqrt(max(0.0, 1.0 - nxy * nxy)));
        float facing = dot(normal, normalize(vec3(sunDir, 0.5)));
        float lightT = smoothstep(-0.3, 0.7, facing);
        vec3 s = mix(sphereShade, sphereShallow, mix(1.0 - sphereShadeStrength, 1.0, lightT));
        s = mix(sphereDeep, s, mix(0.55, 1.0, nxy));
        float rimT = smoothstep(0.6, 1.0, nxy) * clamp(facing, 0.0, 1.0);
        s = mix(s, sphereRim, rimT * sphereRimStrength);
        float reflectedT = smoothstep(0.65, 1.0, nxy) * (1.0 - lightT);
        s = mix(s, sphereReflected, reflectedT * sphereReflectedStrength);
        c = mix(c, s, sphereShading);
      }

      vec2 cp = worldPos;
      if (causticBulge > 0.0) {
        vec2 fromCenter = worldPos - bulgeCenter;
        float dist = length(fromCenter);
        float onGlobe = bulgeRadius * asin(clamp(dist / bulgeRadius, 0.0, 0.98));
        if (dist > 0.0001) cp = bulgeCenter + fromCenter / dist * mix(dist, onGlobe, causticBulge);
      }
      vec2 p = cp / causticScale;
      p += 0.25 * vec2(sin(p.y * 1.7 + time * 0.9), cos(p.x * 1.3 - time * 0.7));
      vec2 v = voronoi(p, time * causticSpeed);
      float thread = 1.0 - smoothstep(0.0, 0.06, v.y - v.x);
      c += colorCaustic * thread * causticStrength * (1.0 - t * 0.85);

      if (depth < 0.0) {
        float fade = smoothstep(-surfaceFeather, 0.0, depth);
        return vec4(colorSurface, 0.85 * fade) * color;
      }

      float line = 1.0 - smoothstep(surfaceLine * 0.3, surfaceLine, depth);
      float glow = 1.0 - smoothstep(0.0, surfaceGlow, depth);
      c += colorSurface * glow * 0.18;
      c = mix(c, colorSurface, line * 0.75);
      a = max(a, line * 0.85);

      return vec4(c, a) * color;
    }
    #endif
  `);
  // (The settings that never change: sent once here, not on every draw.
  // The rest are set in useWaterShader, and changed for each water body
  // in drawOceans.)
  waterShader.send('colorShallow', COLOR_SHALLOW);
  waterShader.send('colorDeep', COLOR_DEEP);
  waterShader.send('deepAt', DEEP_AT);
  waterShader.send('alphaShallow', ALPHA_SHALLOW);
  waterShader.send('alphaDeep', ALPHA_DEEP);
  waterShader.send('colorSurface', COLOR_SURFACE);
  waterShader.send('surfaceLine', SURFACE_LINE);
  waterShader.send('surfaceFeather', SURFACE_FEATHER);
  waterShader.send('surfaceGlow', SURFACE_GLOW);
  waterShader.send('colorCaustic', COLOR_CAUSTIC);
  waterShader.send('sphereShallow', SPHERE_COLOR_SHALLOW);
  waterShader.send('sphereDeep', SPHERE_COLOR_DEEP);
  waterShader.send('sphereShade', SPHERE_COLOR_SHADE);
  waterShader.send('sphereShadeStrength', SPHERE_SHADE_STRENGTH);
  waterShader.send('sphereRim', SPHERE_COLOR_RIM);
  waterShader.send('sphereRimStrength', SPHERE_RIM_STRENGTH);
  waterShader.send('sphereReflected', SPHERE_COLOR_REFLECTED);
  waterShader.send('sphereReflectedStrength', SPHERE_REFLECTED_STRENGTH);
  waterShader.send('causticSpeed', CAUSTIC_SPEED);
  waterShader.send('causticStrength', CAUSTIC_STRENGTH);
  return waterShader;
}

// Turns on the water shader. (The settings that never change are sent
// once, in getWaterShader. These are the ones drawOceans changes for each
// water body, put back for the pools.)
const POOL_BULGE_CENTER = [0, 0], POOL_SUN_DIR = [1, 0];
function useWaterShader() {
  const shader = getWaterShader();
  shader.send('time', shared.age);
  shader.send('causticScale', CAUSTIC_SCALE);
  shader.send('bulgeCenter', POOL_BULGE_CENTER);
  shader.send('bulgeRadius', 1);
  shader.send('causticBulge', 0);
  shader.send('sphereShading', 0);
  shader.send('sunDir', POOL_SUN_DIR);
  love.graphics.setShader(shader);
}

// The lava's shader: the same shapes as the water's (each vertex's
// texture coordinates carry how far below the surface it is, and whether
// it's a falling stream), filled with Lava.js's churning plasma — hottest
// along the surface, darker and crustier deeper down, solid rather than
// see-through, and pouring down a falling stream.
let lavaShader = null;
function getLavaShader() {
  if (lavaShader) return lavaShader;
  lavaShader = love.graphics.newShader(`
    varying vec2 worldPos;

    #ifdef VERTEX
    vec4 position(mat4 transform_projection, vec4 vertex_position) {
      worldPos = vertex_position.xy;
      return transform_projection * vertex_position;
    }
    #endif

    #ifdef PIXEL
    extern number time;
    extern vec3 colorDeep;
    extern vec3 colorMid;
    extern vec3 colorHot;
    extern number glowBand;
    extern number plasmaScale;
    extern number detailScale;
    extern number evolveSpeed;
    extern number scrollSpeed;
    extern number pourSpeed;
    extern number surfaceFeather;

    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
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
    float fbm(vec2 p) {
      float value = 0.0;
      float amp = 0.5;
      for (int i = 0; i < 4; i++) {
        value += amp * valueNoise(p);
        p *= 2.02;
        amp *= 0.55;
      }
      return value;
    }

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      float depth = uv.x;
      bool falling = uv.y > 0.5;
      // (Falling, the pattern pours down the stream instead of churning in place.)
      vec2 gp = worldPos * plasmaScale + (falling ? vec2(0.0, -time * pourSpeed)
                                                  : vec2(time * scrollSpeed, -time * evolveSpeed));
      float grain = fbm(gp);
      float speck = fbm(gp * detailScale + 5.2);
      float v = clamp(grain * 0.7 + speck * 0.3, 0.0, 1.0);
      float glowBias = falling ? 0.5 : clamp(1.0 - depth / glowBand, 0.0, 1.0);
      v = clamp(v * 0.55 + glowBias * 0.6, 0.0, 1.0);
      vec3 c = mix(colorDeep, colorMid, smoothstep(0.25, 0.55, v));
      c = mix(c, colorHot, smoothstep(0.6, 0.9, v));
      // (The strip over the surface fades out, for a soft edge.)
      float a = depth < 0.0 ? smoothstep(-surfaceFeather, 0.0, depth) : 1.0;
      return vec4(c, a) * color;
    }
    #endif
  `);
  // (The settings that never change: sent once here, not on every draw.)
  const L = LAVA_TUNING;
  lavaShader.send('colorDeep', L.COLOR_DEEP);
  lavaShader.send('colorMid', L.COLOR_MID);
  lavaShader.send('colorHot', L.COLOR_HOT);
  lavaShader.send('glowBand', L.GLOW_BAND);
  lavaShader.send('plasmaScale', L.PLASMA_SCALE);
  lavaShader.send('detailScale', L.PLASMA_DETAIL);
  lavaShader.send('evolveSpeed', L.EVOLVE_SPEED);
  lavaShader.send('scrollSpeed', L.SCROLL_SPEED);
  lavaShader.send('pourSpeed', L.POUR_SPEED);
  lavaShader.send('surfaceFeather', SURFACE_FEATHER);
  return lavaShader;
}

function useLavaShader() {
  const shader = getLavaShader();
  shader.send('time', shared.age); // (the rest never change: sent once, in getLavaShader)
  love.graphics.setShader(shader);
}

// The water on the level, as one mesh drawn through the pool shader.
// (liquid: WATER or LAVA — the lava's drawn the same way, through its own
// shader, its surface moving less.)
function drawPools(liquid) {
  const cam = state.camera;
  if (!cam) return;
  const vx0 = cam.x - CELL, vy0 = cam.y - CELL;
  const vx1 = cam.x + (state.visibleWidth ?? 0) + CELL, vy1 = cam.y + (state.visibleHeight ?? 0) + CELL;
  const cols = shared.grid.cols, water = shared.grid[liquid.key];
  const rippleScale = liquid === LAVA ? LAVA_TUNING.RIPPLE : 1;
  const has = (i) => water.has(i);
  Scratch.resetVerts();
  if (liquid === WATER) shared.waterfallLandings = [];

  const quad = (x0, yTop0, x1, yTop1, yBottom0, yBottom1, depthTop, depthBottom, stream) => {
    Scratch.quad(x0, yTop0, x1, yTop1, x1, yBottom1, x0, yBottom0, depthTop, depthBottom, stream);
  };
  const ripple = (x) => (Math.sin(shared.age * 2.2 + x * 0.045) * 1.3 + Math.sin(shared.age * 3.7 - x * 0.11) * 0.6) * rippleScale;

  // The water resting in each column, as one stack from its floor up.
  const stackSurface = new Map(), stackTotal = new Map(), stackFloor = new Map();
  const capped = new Map(), capDepth = new Map(); // (by a stack's floor cell: see below)
  for (const i of water.keys()) {
    const r = Math.floor(i / cols);
    const c = i - r * cols;
    if (!blocked(c, r, 0, 1)) continue;
    const members = [];
    let total = 0, partials = 0, below = Infinity;
    let j = i, jr = r;
    while (jr >= 0 && has(j)) {
      const w = Math.min(1, water.get(j));
      if (w < 0.99) {
        if (partials === 2 || w >= below) break;
        partials += 1;
      }
      members.push(j);
      total += w;
      below = w;
      j -= cols; jr -= 1;
    }
    const surface = shared.grid.y0 + (r + 1) * CELL - Math.max(2, total * CELL);
    for (const m of members) {
      stackSurface.set(m, surface);
      stackTotal.set(m, total);
      stackFloor.set(m, i);
    }
    // Full right up to something solid over it (under an ice block, say):
    // it has no surface of its own — see capDepth below.
    const topRow = r - members.length + 1;
    if (total >= members.length - 0.01 && topRow > 0 && isSolid(c, topRow - 1)) capped.set(i, topRow);
  }
  // A capped stack's depth below the open water's surface beside it (the
  // nearest column either side that isn't capped, reaching up past its
  // top), so it's shaded on down from there instead of starting fresh
  // under the cap. Its top's flat against the cap: no ripple, no surface
  // line.
  for (const i of capped.keys()) {
    const r = Math.floor(i / cols);
    const c = i - r * cols;
    for (let d = 1; d <= 8 && !capDepth.has(i); d++) {
      for (let side = -1; side <= 1; side += 2) { // (c - d, then c + d)
        const nc = c + side * d;
        const n = r * cols + nc;
        if (nc >= 0 && nc < cols && stackFloor.has(n) && !capped.has(stackFloor.get(n)) && stackSurface.get(n) < stackSurface.get(i)) {
          capDepth.set(i, stackSurface.get(i) - stackSurface.get(n));
          break;
        }
      }
    }
  }

  const isFalling = (i) => !stackSurface.has(i);

  const slope = shared.grid.slope;
  const slopeY = (line, x) => {
    x = Math.max(line.xMin, Math.min(line.xMax, x));
    return line.ay + (x - line.ax) * line.k;
  };
  const sheetThickness = (w) => Math.max(3, Math.min(1, w) * CELL);
  const slopeNeighbor = (c, r, dc) => {
    const nc = c + dc;
    if (nc < 0 || nc >= cols) return null;
    for (let dr = -1; dr <= 1; dr++) {
      const nr = r + dr;
      if (nr >= 0 && nr < shared.grid.rows) {
        const j = nr * cols + nc;
        if (slope.has(j) && stackTotal.has(j)) return stackTotal.get(j);
      }
    }
    return null;
  };
  const surfaceY = (i) => stackSurface.get(i);

  for (const [i, w] of water) {
    const r = Math.floor(i / cols);
    const c = i - r * cols;
    const x0 = shared.grid.x0 + c * CELL;
    const yTopCell = shared.grid.y0 + r * CELL;
    const drawn = !stackFloor.has(i) || stackFloor.get(i) === i;
    const reachTop = stackSurface.has(i) ? Math.min(yTopCell, stackSurface.get(i) - CELL) : yTopCell;
    if (!(drawn && x0 < vx1 && x0 + CELL > vx0 && reachTop < vy1 && yTopCell + CELL > vy0)) continue;
    const x1 = x0 + CELL;
    const bottom = yTopCell + CELL;
    const settling = isFalling(i)
      && !has(i - cols) && !has(i - 2 * cols)
      && has(i + cols) && !isFalling(i + cols);
    const stepping = isFalling(i) && !has(i - 2 * cols)
      && (slope.has(i + cols) || slope.has(i + 2 * cols));
    if (settling || stepping) {
      // (nothing)
    } else if (isFalling(i)) {
      const half = CELL * Math.min(1, 0.25 + w * 2.5) / 2;
      const mid = x0 + CELL / 2;
      let streamBottom = bottom;
      let j = i + cols, jr = r + 1, gap = 0;
      while (gap < STREAM_REACH_CELLS && jr < shared.grid.rows && !has(j) && !blocked(c, jr - 1, 0, 1)) {
        j += cols; jr += 1; gap += 1;
        streamBottom += CELL;
      }
      if (has(j) && jr < shared.grid.rows && !isFalling(j)) {
        streamBottom = Math.max(streamBottom, surfaceY(j));
      }

      let streamTop = yTopCell;
      const sourceSurface = (dc) => {
        const nc = c + dc;
        if (nc < 0 || nc >= cols) return null;
        const n = i + dc;
        if (has(n) && !isFalling(n)) return surfaceY(n);
        if (r > 0 && has(n - cols) && !isFalling(n - cols)) return surfaceY(n - cols);
        return null;
      };
      const srcLeft = sourceSurface(-1), srcRight = sourceSurface(1);
      let src = srcLeft, side = -1;
      if (srcRight != null && (srcLeft == null || srcRight < srcLeft)) { src = srcRight; side = 1; }
      if (src != null) {
        streamTop = src;
        const edgeX = side < 0 ? x0 : x1;
        const lipTop = src + ripple(edgeX);
        if (side < 0) quad(edgeX, lipTop, mid, src + 2, lipTop + LIP_THICKNESS, src + 2 + LIP_THICKNESS, 0, 0, 1);
        else quad(mid, src + 2, edgeX, lipTop, src + 2 + LIP_THICKNESS, lipTop + LIP_THICKNESS, 0, 0, 1);
      }
      quad(mid - half, streamTop, mid + half, streamTop, streamBottom, streamBottom, 0, 0, 1);

      if (blocked(c, jr - 1, 0, 1) || (has(j) && !isFalling(j))) {
        let fallTop = streamTop, k = i - cols;
        for (let n = 0; n < 32; n++) {
          if (!(has(k) && isFalling(k))) break;
          fallTop -= CELL; k -= cols;
        }
        if (liquid === WATER && streamBottom - fallTop >= WATERFALL_SPLASH_MIN_FALL) {
          shared.waterfallLandings.push({ x: mid, y: streamBottom, half, flow: Math.min(1, w * 4) });
        }
      }
    } else {
      const surface = surfaceY(i);
      const line = slope.get(i);
      const bottomAt = (x) => line ? Math.max(bottom, slopeY(line, x)) : bottom;
      if (line && stackTotal.get(i) < 0.99) {
        const t = sheetThickness(stackTotal.get(i));
        const wl = slopeNeighbor(c, r, -1), wr = slopeNeighbor(c, r, 1);
        const tl = (t + (wl != null ? sheetThickness(wl) : t * 0.5)) / 2;
        const tr = (t + (wr != null ? sheetThickness(wr) : t * 0.5)) / 2;
        const thicknessAt = (f) => (f < 0.5 ? tl + (t - tl) * f * 2 : t + (tr - t) * (f - 0.5) * 2);
        for (let s = 0; s < SURFACE_SLICES; s++) {
          const fa = s / SURFACE_SLICES, fb = (s + 1) / SURFACE_SLICES;
          const xa = x0 + CELL * fa, xb = x0 + CELL * fb;
          const ba = slopeY(line, xa), bb = slopeY(line, xb);
          const tha = thicknessAt(fa), thb = thicknessAt(fb);
          const ta = ba - tha + ripple(xa) * 0.3;
          const tb = bb - thb + ripple(xb) * 0.3;
          quad(xa, ta, xb, tb, ba, bb, 0, (tha + thb) / 2, 0);
          quad(xa, ta - SURFACE_FEATHER, xb, tb - SURFACE_FEATHER, ta, tb, -SURFACE_FEATHER, 0, 0);
        }
      } else {
        const cap = capped.has(stackFloor.get(i)) ? (capDepth.get(stackFloor.get(i)) ?? 0) : null;
        const neighborSurface = (dc) => {
          const nc = c + dc;
          if (nc < 0 || nc >= cols) return surface;
          const j = i + dc;
          const s = surfaceY(j) ?? surfaceY(j + cols) ?? surfaceY(j - cols);
          if (s == null || Math.abs(s - surface) > CELL * 1.5) return surface;
          // (Nor toward a capped neighbor's — or, capped, any — "surface":
          // see capDepth.)
          const nf = stackFloor.get(j) ?? stackFloor.get(j + cols) ?? stackFloor.get(j - cols);
          if ((nf != null && capped.has(nf)) || cap !== null) return surface;
          return s;
        };
        const left = neighborSurface(-1), right = neighborSurface(1);
        const rippleHere = cap !== null ? () => 0 : ripple;
        const heightAt = (f) => {
          if (f < 0.5) {
            const k = 0.5 + f;
            return left + (surface - left) * (0.5 - 0.5 * Math.cos(Math.PI * k));
          }
          const k = f - 0.5;
          return surface + (right - surface) * (0.5 - 0.5 * Math.cos(Math.PI * k));
        };
        for (let s = 0; s < SURFACE_SLICES; s++) {
          const fa = s / SURFACE_SLICES, fb = (s + 1) / SURFACE_SLICES;
          const xa = x0 + CELL * fa, xb = x0 + CELL * fb;
          const ha = heightAt(fa), hb = heightAt(fb);
          const ta = Math.min(ha + rippleHere(xa), bottom - 1);
          const tb = Math.min(hb + rippleHere(xb), bottom - 1);
          const ba = bottomAt(xa), bb = bottomAt(xb);
          const d0 = cap ?? 0;
          quad(xa, ta, xb, tb, ba, bb, d0, d0 + (ba + bb) / 2 - (ha + hb) / 2, 0);
          // (Not under a cap: there's no surface there.)
          if (cap === null) quad(xa, ta - SURFACE_FEATHER, xb, tb - SURFACE_FEATHER, ta, tb, -SURFACE_FEATHER, 0, 0);
        }
      }
    }
  }

  if (Scratch.vertCount === 0) return;
  drawLiquidMesh(liquid.key, liquid);
}

function causticScaleFor(depth) {
  const grow = Math.max(1, depth / CAUSTIC_GROW_FROM_DEPTH) ** CAUSTIC_GROW_POWER;
  return CAUSTIC_SCALE * Math.min(CAUSTIC_MAX_GROWTH, grow);
}

// Planetoid p's own surface as points (with outward normal and arc s).
function outlineOf(p, depth) {
  const points = [];
  if (p.isRoundedRect) {
    const cr = p.cornerRadius;
    let along = 0;
    const add = (lx, ly, nx, ny) => {
      const w = p.localPointToWorld(lx, ly);
      const n = p.localDirToWorld(nx, ny);
      points.push({ x: w.x, y: w.y, nx: n.x, ny: n.y, s: along });
    };
    for (const seg of p._segments) {
      if (seg.type === 'edge') {
        const steps = Math.max(1, Math.ceil(seg.length / 10));
        for (let k = 0; k < steps; k++) {
          const t = seg.length * k / steps;
          add(seg.start.x + seg.dir.x * t, seg.start.y + seg.dir.y * t, seg.normal.x, seg.normal.y);
          along += seg.length / steps;
        }
      } else {
        const arc = (cr + depth) * Math.PI / 2;
        const steps = Math.max(2, Math.ceil(arc / 10));
        for (let k = 0; k < steps; k++) {
          const a = seg.startAngle + (Math.PI / 2) * k / steps;
          const c = Math.cos(a), s = Math.sin(a);
          add(seg.center.x + c * cr, seg.center.y + s * cr, c, s);
          along += arc / steps;
        }
      }
      if (points.length > OCEAN_MAX_SEGMENTS) break;
    }
  } else {
    const R = p.radius, outer = p.radius + depth;
    const n = Math.max(OCEAN_SEGMENTS, Math.min(OCEAN_MAX_SEGMENTS, Math.floor(2 * Math.PI * outer / 10)));
    for (let k = 0; k < n; k++) {
      const a = k / n * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      points.push({ x: p.pos.x + c * R, y: p.pos.y + s * R, nx: c, ny: s, s: a * outer });
    }
  }
  return points;
}

let oceanMesh = null, oceanMeshSize = 0;
function drawOceans() {
  const cam = state.camera;
  if (!cam || shared.oceans.size === 0) return;
  const vx0 = cam.x, vy0 = cam.y;
  const vx1 = cam.x + (state.visibleWidth ?? 0), vy1 = cam.y + (state.visibleHeight ?? 0);
  let shaderOn = false;
  for (const [p, o] of shared.oceans) {
    const depth = depthOf(p, o.volume);
    const reach = p.radius + depth + SURFACE_FEATHER + 6;
    if (!(p.pos.x + reach > vx0 && p.pos.x - reach < vx1 && p.pos.y + reach > vy0 && p.pos.y - reach < vy1)) continue;
    Scratch.resetVerts();
    const vert = (x, y, d, alpha) => Scratch.vert(x, y, d, 0, alpha ?? 1);
    const cx = p.pos.x, cy = p.pos.y;
    const outline = outlineOf(p, depth);
    const n = outline.length;
    const top = (q) => {
      const rip = Math.sin(shared.age * 2.2 + q.s * 0.045) * 1.3 + Math.sin(shared.age * 3.7 - q.s * 0.11) * 0.6;
      const h = Math.max(1, depth + rip);
      return [q.x + q.nx * h, q.y + q.ny * h, q.x + q.nx * (h + SURFACE_FEATHER), q.y + q.ny * (h + SURFACE_FEATHER)];
    };
    for (let k = 0; k < n; k++) {
      const a = outline[k], b = outline[(k + 1) % n];
      const [ax, ay, afx, afy] = top(a);
      const [bx, by, bfx, bfy] = top(b);
      vert(a.x, a.y, depth); vert(b.x, b.y, depth); vert(bx, by, 0);
      vert(a.x, a.y, depth); vert(bx, by, 0); vert(ax, ay, 0);
      vert(ax, ay, 0); vert(bx, by, 0); vert(bfx, bfy, -SURFACE_FEATHER);
      vert(ax, ay, 0); vert(bfx, bfy, -SURFACE_FEATHER); vert(afx, afy, -SURFACE_FEATHER);
    }

    const overlay = Math.min(1, Math.max(0, (depth - CORE_OVERLAY_FROM_DEPTH)
      / (CORE_OVERLAY_FULL_DEPTH - CORE_OVERLAY_FROM_DEPTH))) * CORE_OVERLAY_MAX;
    if (overlay > 0) {
      for (let k = 0; k < n; k++) {
        const a = outline[k], b = outline[(k + 1) % n];
        vert(cx, cy, depth, overlay); vert(a.x, a.y, depth, overlay); vert(b.x, b.y, depth, overlay);
      }
    }

    const count = Scratch.vertCount;
    if (!oceanMesh || oceanMeshSize < count) {
      oceanMeshSize = Math.max(count, oceanMeshSize * 2, 600);
      oceanMesh = love.graphics.newMesh(oceanMeshSize, 'triangles', 'stream');
    }
    oceanMesh.setVertices(Scratch.verts, 0, count);
    oceanMesh.setDrawRange(0, count);
    if (!shaderOn) {
      useWaterShader();
      love.graphics.setColor(1, 1, 1, 1);
      shaderOn = true;
    }
    const shader = getWaterShader();
    shader.send('causticScale', causticScaleFor(depth));
    if (p.isRoundedRect) {
      shader.send('causticBulge', 0);
      shader.send('sphereShading', 0);
    } else {
      shader.send('bulgeCenter', [cx, cy]);
      shader.send('bulgeRadius', p.radius + depth);
      shader.send('causticBulge', CAUSTIC_BULGE);
      let sdx = (state.sceneWidth ?? 0) / 2 - cx, sdy = (state.sceneHeight ?? 0) / 2 - cy;
      let sd = Math.sqrt(sdx * sdx + sdy * sdy);
      if (sd < 1) { sdx = 1; sdy = 0; sd = 1; }
      shader.send('sphereShading', 1);
      shader.send('sunDir', [sdx / sd, sdy / sd]);
    }
    love.graphics.draw(oceanMesh);
  }
  if (shaderOn) love.graphics.setShader();
}

// In world space. Drawn after Bob, so he looks like he's in the water.
// The obsidian blocks on the level (see "Lava meeting water"). (A dirt
// planet's are part of its own picture.)
function drawLevelObsidian() {
  let image = null;
  for (const e of shared.obsidians) {
    if (e.kind !== 'level') continue;
    image = image ?? getObsidianImage();
    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.draw(image, e.x0, e.y0, 0, e.size / image.getWidth(), e.size / image.getHeight());
  }
}

function drawLavaEmbers() {
  for (const e of shared.lavaEmbers) {
    const a = Math.max(0, e.life);
    love.graphics.setColor(1, 0.35 + 0.5 * a, 0.05 + 0.25 * a, a);
    love.graphics.circle('fill', e.x, e.y, e.radius);
  }
}

WaterSystem.draw = function () {
  const g = love.graphics;
  drawLevelObsidian();
  if (shared.grid) drawPools(WATER);
  for (const pg of shared.planetGrids.values()) drawPlanetWater(pg, WATER);
  // The ice blocks, in the water (see "Ice").
  Ice.drawLevel();
  // The lava, over the water (and, like it, over Bob: he's in it).
  if (shared.grid && shared.grid.lava.size > 0) drawPools(LAVA);
  for (const pg of shared.planetGrids.values()) {
    if (pg.lava.size > 0) drawPlanetWater(pg, LAVA);
  }
  drawLavaEmbers();

  g.setLineWidth(2.5);
  for (const d of shared.droplets) {
    const speed = Math.sqrt(d.vx * d.vx + d.vy * d.vy);
    const tail = Math.min(10, speed * 0.8) / Math.max(speed, 0.001);
    // (A lava droplet — out of a portal: see drainIntoPortals — hot,
    // trailing darker; bigger, as lava's jets are thicker.)
    const head = d.lava ? LAVA_TUNING.COLOR_HOT : COLOR_DROPLET;
    const trail = d.lava ? LAVA_TUNING.COLOR_MID : COLOR_DROPLET;
    g.setColor(trail[0], trail[1], trail[2], d.lava ? 0.9 : COLOR_DROPLET[3] * 0.6);
    g.line(d.x - d.vx * tail, d.y - d.vy * tail, d.x, d.y);
    g.setColor(head[0], head[1], head[2], d.lava ? 1 : COLOR_DROPLET[3]);
    g.circle('fill', d.x, d.y, d.lava ? 3 : 2.2);
  }
  g.setLineWidth(1);
  for (const s of shared.splashes) {
    const c = s.lava ? LAVA_TUNING.COLOR_HOT : COLOR_DROPLET;
    g.setColor(c[0], c[1], c[2], s.life / SPLASH_SECONDS);
    g.circle('fill', s.x, s.y, s.size);
  }
  g.setColor(1, 1, 1, 1);
};

// The planetoids' water layers, and steam over all the water — drawn
// after the fish as well as Bob.
WaterSystem.drawOceans = function () {
  drawOceans();
  drawSteam();
};

export { WaterSystem as api };
