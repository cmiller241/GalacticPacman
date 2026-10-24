// js/interiors/PinballInterior.js
//
// The pinball table laid over the pinball planet's face, built from a
// Tiled map (js/levels/Pinball-Level2.js). The player plays it as a ball
// from the ordinary exterior camera: he arrives resting on the plunger
// (see onEnter), the jump button fires the plunger or the flippers (see
// triggerJumpAction), and draining out the bottom ends the session.
//
// Walls come from js/world/PinballCurveTiles.js (never from the tile
// art): each non-empty tile becomes one small polygon, and the ball
// collides against the polygons of the few cells it overlaps.
//
// Objects (Tiled point objects, matched on class): Plunger, Bumper,
// Flipper-Left / Flipper-Right, Drop, Rollover. See the Lua original for
// the long-form notes.
//
// Port notes: multi-returns (tableToWorld, worldToTable) return [x, y].

import love from '../love/index.js';
import lua from '../love/lua.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import CurveTiles from '../world/PinballCurveTiles.js';
import Planetoid from '../world/Planetoid.js';

// ---------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------

const TILE_SOURCE_SIZE = 32;
const TILE_SCALE = 2;
const TILE_WORLD_SIZE = TILE_SOURCE_SIZE * TILE_SCALE;

const GRAVITY_ACCEL = 0.15;
const GRAVITY_ALWAYS_SCREEN_DOWN = true;
const MAX_BALL_SPEED = 46;
const WALL_RESTITUTION = 0.5;
const PLUNGER_LAUNCH_SPEED = 44;
const BUMPER_RADIUS_PX = 48;
const BUMPER_KICK_SPEED = 24;

const FLIPPER_REST_DEGREES = 28;
const FLIPPER_SWING_DEGREES = 56;
const FLIPPER_SWING_UP_TICKS = 5;
const FLIPPER_SWING_HOLD_TICKS = 12;
const FLIPPER_SWING_DOWN_TICKS = 12;
const FLIPPER_SIZE_SCALE = 0.8;
const FLIPPER_RADIUS = 16 * FLIPPER_SIZE_SCALE;
const FLIPPER_RESTITUTION = 0.4;
const FLIPPER_TIP_GAP_BALLS = 1.6;
const FLIPPER_DEFAULT_LENGTH = 200;
const FLIPPER_PAIR_MAX_DY_PX = 64;
const FLIPPER_SNAP_REACH_PX = 40;

const PLUNGER_WIDTH_PX = 64;
const PLUNGER_HEIGHT_PX = 28;
const PLUNGER_CATCH_DISTANCE = 10;

const BALL_SUBSTEP_DISTANCE = 4;
const ARC_VERTEX_SPACING = 6;

const COLOR_TABLE = [0.09, 0.09, 0.12, 1];
const COLOR_BUMPER = [0.95, 0.25, 0.30, 1];
const COLOR_BUMPER_STRIPE = [0.96, 0.96, 0.96, 1];
const COLOR_BUMPER_CAP = [0.96, 0.96, 0.96, 1];
const COLOR_BUMPER_CAP_LIT = [1.00, 0.85, 0.20, 1];
const COLOR_BUMPER_OUTLINE = [0.12, 0.10, 0.14, 1];
const BUMPER_TRIANGLES = 8;
const BUMPER_FLASH_TICKS = 24;
const BUMPER_BLINK_TICKS = 4;
const BUMPER_BAKE_SCALE = 2;
const BUMPER_BAKE_PADDING = 2;
const BUMPER_SHADING_MIX = 0.55;
const COLOR_FLIPPER = [0.25, 0.45, 0.95, 1];
const COLOR_PLUNGER = [0.55, 0.58, 0.65, 1];

const DROP_LENGTH_PX = 44;
const DROP_THICKNESS_PX = 10;
const DROP_WALL_REACH_PX = 48;
const DROP_HIT_SPEED = 3;
const DROP_POINTS = 500;
const DROP_BANK_BONUS = 5000;
const DROP_RESET_TICKS = 90;
const DROP_FLASH_TICKS = 18;
const COLOR_DROP = [0.98, 0.62, 0.12, 1];
const COLOR_DROP_STRIPE = [1.00, 0.95, 0.80, 1];
const COLOR_DROP_EDGE = [0.35, 0.16, 0.04, 1];
const COLOR_DROP_SLOT = [0.03, 0.03, 0.05, 1];

const ROLLOVER_REACH_PX = 22;
const ROLLOVER_SLOT_WIDTH_PX = 12;
const ROLLOVER_SLOT_LENGTH_PX = 34;
const ROLLOVER_LIGHT_OFFSET_PX = 30;
const ROLLOVER_LIGHT_RADIUS_PX = 8;
const ROLLOVER_POINTS = 250;
const ROLLOVER_ALL_BONUS = 2500;
const ROLLOVER_CELEBRATE_TICKS = 70;
const COLOR_ROLLOVER_SLOT = [0.03, 0.03, 0.05, 1];
const COLOR_ROLLOVER_WIRE = [0.80, 0.82, 0.88, 1];
const COLOR_ROLLOVER_OFF = [0.35, 0.22, 0.05, 1];
const COLOR_ROLLOVER_ON = [1.00, 0.80, 0.20, 1];

const POPUP_TICKS = 50;
const POPUP_RISE = 1.2;
const COLOR_POPUP = [1.00, 0.95, 0.55];

const rad = (d) => d * Math.PI / 180;
// A Tiled "properties" table. (The map converter turns an empty Lua
// table into [], whose .length is 0 — it must read as "no property".)
const propsOf = (p) => (p && !Array.isArray(p) ? p : {});
// Lua's tonumber: a number, or null when it isn't one.
function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

// ---------------------------------------------------------------------
// Tile geometry -> collision polygons
// ---------------------------------------------------------------------

const FLIP_H = 0x80000000, FLIP_V = 0x40000000, FLIP_D = 0x20000000;

function splitGid(gid) {
  const h = gid >= FLIP_H; if (h) gid -= FLIP_H;
  const v = gid >= FLIP_V; if (v) gid -= FLIP_V;
  const d = gid >= FLIP_D; if (d) gid -= FLIP_D;
  return [gid, h, v, d];
}

function flipMatrix(h, v, d) {
  let a = 1, b = 0, c = 0, dd = 1;
  if (d) { a = 0; b = 1; c = 1; dd = 0; }
  if (h) { a = -a; b = -b; }
  if (v) { c = -c; dd = -dd; }
  return [a, b, c, dd];
}

function surfaceFor(geom) {
  if (geom.kind === 'line') {
    const side = (x, y) => (x - geom.x1) * geom.nx + (y - geom.y1) * geom.ny;
    return {
      inside: (x, y) => side(x, y) < 0,
      cross: (ax, ay, bx, by) => {
        const da = side(ax, ay), db = side(bx, by);
        const t = da / (da - db);
        return [ax + (bx - ax) * t, ay + (by - ay) * t];
      },
    };
  }
  const cx = geom.cx, cy = geom.cy, r = geom.r;
  const wantInside = geom.solid === 'inside';
  return {
    isArc: true,
    inside: (x, y) => {
      const inDisc = (x - cx) ** 2 + (y - cy) ** 2 < r * r;
      return inDisc === wantInside;
    },
    cross: (ax, ay, bx, by) => {
      const dx = bx - ax, dy = by - ay;
      const fx = ax - cx, fy = ay - cy;
      const A = dx * dx + dy * dy;
      const B = 2 * (fx * dx + fy * dy);
      const C = fx * fx + fy * fy - r * r;
      const disc = Math.sqrt(Math.max(0, B * B - 4 * A * C));
      let t = (-B - disc) / (2 * A);
      if (t < -1e-6 || t > 1 + 1e-6) t = (-B + disc) / (2 * A);
      t = Math.max(0, Math.min(1, t));
      return [ax + dx * t, ay + dy * t];
    },
  };
}

function tileSolidPolygon(geom) {
  const S = TILE_SOURCE_SIZE;
  if (geom.kind === 'solid') return [[0, 0], [S, 0], [S, S], [0, S]];
  const surf = surfaceFor(geom);
  const box = [[0, 0], [S, 0], [S, S], [0, S]];

  let start = null;
  for (let i = 0; i < 4; i++) {
    if (surf.inside(box[i][0], box[i][1])) { start = i; break; }
  }
  if (start == null) return null;

  const out = [];
  let exitX = null, exitY = null;
  for (let k = 0; k <= 3; k++) {
    const a = box[(start + k) % 4];
    const b = box[(start + k + 1) % 4];
    const aIn = surf.inside(a[0], a[1]), bIn = surf.inside(b[0], b[1]);
    if (aIn) out.push([a[0], a[1]]);
    if (aIn && !bIn) {
      [exitX, exitY] = surf.cross(a[0], a[1], b[0], b[1]);
      out.push([exitX, exitY]);
    } else if (bIn && !aIn) {
      const [enterX, enterY] = surf.cross(a[0], a[1], b[0], b[1]);
      if (surf.isArc && exitX != null) {
        const a0 = Math.atan2(exitY - geom.cy, exitX - geom.cx);
        const a1 = Math.atan2(enterY - geom.cy, enterX - geom.cx);
        const delta = lua.mod(a1 - a0 + Math.PI, 2 * Math.PI) - Math.PI;
        const steps = Math.ceil(Math.abs(delta) * geom.r * TILE_SCALE / ARC_VERTEX_SPACING);
        for (let i = 1; i <= steps - 1; i++) {
          const ang = a0 + delta * i / steps;
          out.push([geom.cx + geom.r * Math.cos(ang), geom.cy + geom.r * Math.sin(ang)]);
        }
      }
      out.push([enterX, enterY]);
    }
  }
  if (out.length < 3) return null;
  return out;
}

function signedArea(poly) {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area / 2;
}

function finishPolygon(points) {
  const poly = { points, orient: signedArea(points) >= 0 ? 1 : -1 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }
  poly.minX = minX; poly.minY = minY; poly.maxX = maxX; poly.maxY = maxY;
  return poly;
}

function pointInPolygon(points, px, py) {
  let inside = false;
  let j = points.length - 1;
  for (let i = 0; i < points.length; i++) {
    const xi = points[i][0], yi = points[i][1];
    const xj = points[j][0], yj = points[j][1];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
    j = i;
  }
  return inside;
}

// -> [x, y, dist, nx, ny]
function closestPointOnPolygon(poly, px, py) {
  const points = poly.points;
  let bestDist = Infinity, bestX = 0, bestY = 0, bestNX = 0, bestNY = -1;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const abx = b[0] - a[0], aby = b[1] - a[1];
    const len2 = abx * abx + aby * aby;
    let t = 0;
    if (len2 > 1e-9) t = Math.max(0, Math.min(1, ((px - a[0]) * abx + (py - a[1]) * aby) / len2));
    const ex = a[0] + abx * t, ey = a[1] + aby * t;
    const dist = Math.sqrt((px - ex) ** 2 + (py - ey) ** 2);
    if (dist < bestDist) {
      const len = Math.sqrt(len2);
      let nx = 0, ny = -1;
      if (len > 1e-9) { nx = (aby / len) * poly.orient; ny = (-abx / len) * poly.orient; }
      bestDist = dist; bestX = ex; bestY = ey; bestNX = nx; bestNY = ny;
    }
  }
  return [bestX, bestY, bestDist, bestNX, bestNY];
}

// Pushes the ball out of a solid polygon and reflects the velocity going
// into it. Returns the contact normal [nx, ny] when it touched, else null.
function bounceOffPolygon(poly, player) {
  const x = player.pos.x, y = player.pos.y, r = player.radius;
  if (x + r < poly.minX || x - r > poly.maxX || y + r < poly.minY || y - r > poly.maxY) return null;
  let [ex, ey, dist, nx, ny] = closestPointOnPolygon(poly, x, y);
  if (pointInPolygon(poly.points, x, y)) {
    player.pos.x = ex + nx * r; player.pos.y = ey + ny * r;
  } else if (dist < r) {
    if (dist > 1e-6) { nx = (x - ex) / dist; ny = (y - ey) / dist; }
    player.pos.x = ex + nx * r; player.pos.y = ey + ny * r;
  } else {
    return null;
  }
  const into = player.vel.x * nx + player.vel.y * ny;
  if (into < 0) {
    player.vel.x -= (1 + WALL_RESTITUTION) * into * nx;
    player.vel.y -= (1 + WALL_RESTITUTION) * into * ny;
  }
  return [nx, ny];
}

// "../img/foo.png" relative to tiled/ -> "img/foo.png".
function resolveMapPath(relative) {
  const parts = [];
  for (const part of ('tiled/' + relative).split('/')) {
    if (part === '') continue;
    if (part === '..') parts.pop();
    else if (part !== '.') parts.push(part);
  }
  return parts.join('/');
}

function rotateVector(x, y, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

function flipperSwingAmount(t) {
  const up = FLIPPER_SWING_UP_TICKS, hold = FLIPPER_SWING_HOLD_TICKS, down = FLIPPER_SWING_DOWN_TICKS;
  if (t < up) return t / up;
  if (t < up + hold) return 1;
  if (t < up + hold + down) return 1 - (t - up - hold) / down;
  return null;
}

function bounceOffBumper(b, player) {
  const dx = player.pos.x - b.x, dy = player.pos.y - b.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const minDist = b.radius + player.radius;
  if (dist >= minDist) return;
  let nx = 0, ny = -1;
  if (dist > 1e-4) { nx = dx / dist; ny = dy / dist; }
  player.pos.x = b.x + nx * minDist; player.pos.y = b.y + ny * minDist;
  player.vel.x = nx * BUMPER_KICK_SPEED; player.vel.y = ny * BUMPER_KICK_SPEED;
  b.flashTimer = BUMPER_FLASH_TICKS;
}

function bounceOffFlipper(f, player) {
  const tipX = f.x + Math.cos(f.angle) * f.length;
  const tipY = f.y + Math.sin(f.angle) * f.length;
  const abx = tipX - f.x, aby = tipY - f.y;
  let t = ((player.pos.x - f.x) * abx + (player.pos.y - f.y) * aby) / (abx * abx + aby * aby);
  t = Math.max(0, Math.min(1, t));
  const ex = f.x + abx * t, ey = f.y + aby * t;
  const dx = player.pos.x - ex, dy = player.pos.y - ey;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const minDist = FLIPPER_RADIUS + player.radius;
  if (dist >= minDist) return null;

  let nx = 0, ny = -1;
  if (dist > 1e-4) { nx = dx / dist; ny = dy / dist; }
  player.pos.x = ex + nx * minDist; player.pos.y = ey + ny * minDist;

  const rx = ex - f.x, ry = ey - f.y;
  const surfVX = -ry * f.angularVel, surfVY = rx * f.angularVel;
  const into = (player.vel.x - surfVX) * nx + (player.vel.y - surfVY) * ny;
  if (into < 0) {
    player.vel.x -= (1 + FLIPPER_RESTITUTION) * into * nx;
    player.vel.y -= (1 + FLIPPER_RESTITUTION) * into * ny;
  }
  return [nx, ny];
}

// ---------------------------------------------------------------------
// Bumper faces (shared with the cannon routes' bumpers)
// ---------------------------------------------------------------------

function drawBumperFace(cx, cy, r, lit) {
  const g = love.graphics;
  g.setColor(COLOR_BUMPER_STRIPE);
  g.circle('fill', cx, cy, r);

  g.setColor(COLOR_BUMPER_OUTLINE);
  g.setLineWidth(r * 0.06);
  g.circle('line', cx, cy, r * 0.97);

  const step = 2 * Math.PI / BUMPER_TRIANGLES;
  const baseR = r * 0.58;
  g.setColor(COLOR_BUMPER);
  for (let i = 0; i < BUMPER_TRIANGLES; i++) {
    const mid = (i + 0.5) * step;
    const a0 = mid - step / 2, a1 = mid + step / 2;
    g.polygon('fill',
      cx + Math.cos(a0) * baseR, cy + Math.sin(a0) * baseR,
      cx + Math.cos(mid) * r, cy + Math.sin(mid) * r,
      cx + Math.cos(a1) * baseR, cy + Math.sin(a1) * baseR);
  }

  g.setColor(COLOR_BUMPER_OUTLINE);
  g.circle('fill', cx, cy, r * 0.61);

  g.setColor(lit ? COLOR_BUMPER_CAP_LIT : COLOR_BUMPER_CAP);
  g.circle('fill', cx, cy, r * 0.55);
}

const bumperFaceCache = new Map();
function getBumperFace(r) {
  if (bumperFaceCache.has(r)) return bumperFaceCache.get(r);
  const g = love.graphics;
  const size = Math.ceil((r + BUMPER_BAKE_PADDING) * 2 * BUMPER_BAKE_SCALE);
  const half = size / (2 * BUMPER_BAKE_SCALE);
  const bake = (lit) => {
    const canvas = g.newCanvas(size, size);
    canvas.setFilter('linear', 'linear');
    g.push('all');
    g.origin();
    g.setCanvas(canvas);
    g.clear(0, 0, 0, 0);
    g.scale(BUMPER_BAKE_SCALE);
    drawBumperFace(half, half, r, lit);
    g.pop();
    return canvas;
  };
  const face = { normal: bake(false), lit: bake(true), half };
  bumperFaceCache.set(r, face);
  return face;
}

// ---------------------------------------------------------------------

class PinballInterior {
  static new(planetoid, mapData) {
    return new PinballInterior(planetoid, mapData);
  }

  constructor(planetoid, mapData) {
    this.planetoid = planetoid;
    this.mapWidth = mapData.width;
    this.mapHeight = mapData.height;
    this.anchorX = planetoid.pos.x - mapData.width * TILE_WORLD_SIZE / 2;
    this.anchorY = planetoid.pos.y - mapData.height * TILE_WORLD_SIZE / 2;

    const mapProps = propsOf(mapData.properties);
    this.plungerLaunchSpeed = toNum(mapProps.plungerSpeed) ?? PLUNGER_LAUNCH_SPEED;
    this.maxBallSpeed = toNum(mapProps.maxBallSpeed) ?? MAX_BALL_SPEED;

    const layer = mapData.layers.find((l) => l.type === 'tilelayer');
    if (!layer || !mapData.tilesets[0]) throw new Error('PinballInterior: map needs a tile layer and a tileset');

    this.buildTiles(layer, mapData.tilesets);
    this.buildObjects(mapData);
  }

  buildTiles(layer, tilesets) {
    const W = this.mapWidth, H = this.mapHeight;
    const S = TILE_SOURCE_SIZE;
    const half = S / 2;
    let tileset = tilesets[0];
    for (const ts of tilesets) {
      if (ts.image) { tileset = ts; break; }
    }
    const columns = tileset.columns ?? CurveTiles.columns;
    const firstgidOf = (gid) => {
      let best = tileset.firstgid;
      for (const ts of tilesets) {
        if (ts.firstgid <= gid && ts.firstgid > best) best = ts.firstgid;
      }
      return best;
    };
    // Keyed row * W + col (sparse) — a Map, iterated like Lua's pairs.
    this.cellPolys = new Map();

    const image = love.graphics.newImage(resolveMapPath(tileset.image));
    image.setFilter('nearest', 'nearest');
    this.batch = love.graphics.newSpriteBatch(image, W * H, 'static');
    const [imgW, imgH] = image.getDimensions();
    const quads = {};
    const missing = {};

    for (let row = 0; row < H; row++) {
      for (let col = 0; col < W; col++) {
        const rawGid = layer.data[row * W + col];
        if (!rawGid) continue;
        const [gid, fh, fv, fd] = splitGid(rawGid);
        const id = gid - firstgidOf(gid);
        const [a, b, c, d] = flipMatrix(fh, fv, fd);
        const tileX = this.anchorX + col * TILE_WORLD_SIZE;
        const tileY = this.anchorY + row * TILE_WORLD_SIZE;

        if (!quads[id]) {
          quads[id] = love.graphics.newQuad((id % columns) * S, Math.floor(id / columns) * S, S, S, imgW, imgH);
        }
        let rot, sx, sy;
        if (b === 0) { rot = 0; sx = a; sy = d; } else { rot = Math.PI / 2; sx = c; sy = -b; }
        this.batch.add(quads[id], tileX + TILE_WORLD_SIZE / 2, tileY + TILE_WORLD_SIZE / 2,
          rot, sx * TILE_SCALE, sy * TILE_SCALE, half, half);

        const geom = CurveTiles.tiles[id];
        if (geom) {
          const localPoly = tileSolidPolygon(geom);
          if (localPoly) {
            const points = [];
            for (const p of localPoly) {
              const ux = p[0] - half, uy = p[1] - half;
              const fx = a * ux + b * uy + half, fy = c * ux + d * uy + half;
              points.push([tileX + fx * TILE_SCALE, tileY + fy * TILE_SCALE]);
            }
            this.cellPolys.set(row * W + col, finishPolygon(points));
          }
        } else if (!missing[id]) {
          missing[id] = true;
          console.log(`PinballInterior: tile id ${id} has no entry in PinballCurveTiles — treated as empty (no collision).`);
        }
      }
    }
  }

  buildObjects(mapData) {
    this.bumpers = []; this.flippers = []; this.plunger = null;
    this.drops = []; this.rollovers = []; this.popups = [];
    const ax = this.anchorX, ay = this.anchorY;

    for (const l of mapData.layers) {
      if (l.type !== 'objectgroup') continue;
      for (const obj of (l.objects ?? [])) {
        const props = propsOf(obj.properties);
        const wx = ax + obj.x * TILE_SCALE, wy = ay + obj.y * TILE_SCALE;
        if (obj.class === 'Bumper') {
          this.bumpers.push({ x: wx, y: wy, radius: (toNum(props.radius) ?? BUMPER_RADIUS_PX) * TILE_SCALE });
        } else if (obj.class === 'Flipper-Left' || obj.class === 'Flipper-Right') {
          const isLeft = obj.class === 'Flipper-Left';
          const rest = rad(isLeft ? FLIPPER_REST_DEGREES : (180 - FLIPPER_REST_DEGREES));
          const len = toNum(props.length);
          this.flippers.push({
            x: wx, y: wy, isLeft,
            restAngle: rest,
            swingDir: isLeft ? -1 : 1,
            length: len != null ? len * TILE_SCALE : null,
            angle: rest, angularVel: 0,
          });
        } else if (obj.class === 'Plunger') {
          const w = PLUNGER_WIDTH_PX * TILE_SCALE, h = PLUNGER_HEIGHT_PX * TILE_SCALE;
          const points = [[wx - w / 2, wy], [wx + w / 2, wy], [wx + w / 2, wy + h], [wx - w / 2, wy + h]];
          this.plunger = { x: wx, y: wy, width: w, height: h, poly: finishPolygon(points) };
        } else if (obj.class === 'Drop') {
          this.drops.push({ x: wx, y: wy, up: true, length: (toNum(props.length) ?? DROP_LENGTH_PX) * TILE_SCALE });
        } else if (obj.class === 'Rollover') {
          this.rollovers.push({ x: wx, y: wy, lit: false });
        }
      }
    }

    // Snap each pivot onto the end of the guide wall beside it.
    const snapReach = FLIPPER_SNAP_REACH_PX * TILE_SCALE;
    for (const f of this.flippers) {
      const side = f.isLeft ? 1 : -1;
      let endX = null, endY = null;
      for (const poly of this.cellPolys.values()) {
        for (const p of poly.points) {
          const dx = (f.x - p[0]) * side, dy = f.y - p[1];
          if (dx >= 0 && dx <= snapReach && Math.abs(dy) <= snapReach) {
            if (endX == null || dx < (f.x - endX) * side - 1e-6
                || (Math.abs(dx - (f.x - endX) * side) <= 1e-6 && p[1] < endY)) {
              endX = p[0]; endY = p[1];
            }
          }
        }
      }
      if (endX != null) {
        f.x = endX + side * FLIPPER_RADIUS;
        f.y = endY + FLIPPER_RADIUS;
      }
    }

    // Size each flipper without a "length" from its partner.
    const ballDiameter = 2 * (30 * 0.792);
    for (const f of this.flippers) {
      if (f.length != null) continue;
      let best = null;
      for (const g of this.flippers) {
        if (g.isLeft !== f.isLeft && Math.abs(g.y - f.y) <= FLIPPER_PAIR_MAX_DY_PX * TILE_SCALE) {
          if (!best || Math.abs(g.x - f.x) < Math.abs(best.x - f.x)) best = g;
        }
      }
      if (best) {
        const span = Math.abs(best.x - f.x) - ballDiameter * FLIPPER_TIP_GAP_BALLS - 2 * FLIPPER_RADIUS;
        f.length = Math.max(FLIPPER_RADIUS * 2, span / (2 * Math.cos(rad(FLIPPER_REST_DEGREES))));
      } else {
        f.length = FLIPPER_DEFAULT_LENGTH;
      }
    }

    for (const f of this.flippers) f.length *= FLIPPER_SIZE_SCALE;

    // Each drop target stands with its back against the wall nearest it.
    const reach = DROP_WALL_REACH_PX * TILE_SCALE;
    const thick = DROP_THICKNESS_PX * TILE_SCALE;
    const solidAt = (x, y) => {
      const col = Math.floor((x - ax) / TILE_WORLD_SIZE);
      const row = Math.floor((y - ay) / TILE_WORLD_SIZE);
      if (col < 0 || row < 0 || col >= this.mapWidth || row >= this.mapHeight) return true;
      const poly = this.cellPolys.get(row * this.mapWidth + col);
      return poly != null && pointInPolygon(poly.points, x, y);
    };
    for (const d of this.drops) {
      let bestDist = reach, bx = d.x, by = d.y + thick / 2, bnx = 0, bny = -1;
      for (const poly of this.cellPolys.values()) {
        if (d.x + reach >= poly.minX && d.x - reach <= poly.maxX && d.y + reach >= poly.minY && d.y - reach <= poly.maxY) {
          const pts = poly.points;
          for (let i = 0; i < pts.length; i++) {
            const a = pts[i], b = pts[(i + 1) % pts.length];
            const abx = b[0] - a[0], aby = b[1] - a[1];
            const len = Math.sqrt(abx * abx + aby * aby);
            if (len > 1e-6) {
              const nx = (aby / len) * poly.orient, ny = (-abx / len) * poly.orient;
              const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
              if (!solidAt(mx + nx * 2, my + ny * 2)) {
                const t = Math.max(0, Math.min(1, ((d.x - a[0]) * abx + (d.y - a[1]) * aby) / (len * len)));
                const ex = a[0] + abx * t, ey = a[1] + aby * t;
                const dist = Math.sqrt((d.x - ex) ** 2 + (d.y - ey) ** 2);
                if (dist < bestDist) { bestDist = dist; bx = ex; by = ey; bnx = nx; bny = ny; }
              }
            }
          }
        }
      }
      const tx = -bny, ty = bnx;
      const hl = d.length / 2;
      d.nx = bnx; d.ny = bny; d.tx = tx; d.ty = ty;
      d.cx = bx + bnx * thick / 2; d.cy = by + bny * thick / 2;
      d.corners = [
        [bx - tx * hl, by - ty * hl],
        [bx + tx * hl, by + ty * hl],
        [bx + tx * hl + bnx * thick, by + ty * hl + bny * thick],
        [bx - tx * hl + bnx * thick, by - ty * hl + bny * thick],
      ];
      d.poly = finishPolygon(d.corners);
    }
  }

  // -------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------

  rotationAngle() {
    return this.planetoid.rotationAngle ?? 0;
  }

  // -> [x, y]
  tableToWorld(x, y, angle) {
    const a = angle ?? this.rotationAngle();
    if (a === 0) return [x, y];
    const cx = this.planetoid.pos.x, cy = this.planetoid.pos.y;
    const c = Math.cos(a), s = Math.sin(a);
    const dx = x - cx, dy = y - cy;
    return [cx + dx * c - dy * s, cy + dx * s + dy * c];
  }

  // -> [x, y]
  worldToTable(x, y, angle) {
    const a = angle ?? this.rotationAngle();
    if (a === 0) return [x, y];
    const cx = this.planetoid.pos.x, cy = this.planetoid.pos.y;
    const c = Math.cos(-a), s = Math.sin(-a);
    const dx = x - cx, dy = y - cy;
    return [cx + dx * c - dy * s, cy + dx * s + dy * c];
  }

  getPortalPosition() {
    const pl = this.plunger;
    const ballRadius = 30 * 0.792;
    if (!pl) return Vector2.new(this.planetoid.pos.x, this.planetoid.pos.y);
    const [x, y] = this.tableToWorld(pl.x, pl.y - ballRadius - 1);
    return Vector2.new(x, y);
  }

  onEnter(player) {
    player.forceBallMode();
    player.inPinball = this;
    player.vel.x = 0; player.vel.y = 0;
    player.ballSpin = 0;
    this.ballAngle = this.rotationAngle();
    const pl = this.plunger;
    if (pl) [player.pos.x, player.pos.y] = this.tableToWorld(pl.x, pl.y - player.radius - 1);
    player.prevPos = player.pos.clone();
    for (const f of this.flippers) {
      f.swingTimer = null; f.angle = f.restAngle; f.angularVel = 0;
    }
  }

  exitBall(player) {
    player.inPinball = null;
    player.vel.x = 0; player.vel.y = 0;
    if (player.isBall) player.exitBallMode();
    const p = this.planetoid;
    const exitX = this.exitPosition ? this.exitPosition.x : p.pos.x;
    [player.pos.x, player.pos.y] = this.tableToWorld(exitX, p.pos.y - p.halfHeight - player.radius - 2);
    player.prevPos = player.pos.clone();
  }

  updateFlippers(ts) {
    for (const f of this.flippers) {
      const previous = f.angle;
      let amount = 0;
      if (f.swingTimer != null) {
        f.swingTimer += ts;
        if (this.flippersHeld) {
          f.swingTimer = Math.min(f.swingTimer, FLIPPER_SWING_UP_TICKS + FLIPPER_SWING_HOLD_TICKS);
        }
        amount = flipperSwingAmount(f.swingTimer);
        if (amount == null) { f.swingTimer = null; amount = 0; }
      }
      f.angle = f.restAngle + f.swingDir * rad(FLIPPER_SWING_DEGREES) * amount;
      f.angularVel = ts > 0 ? (f.angle - previous) / ts : 0;
    }
  }

  triggerFlippers() {
    for (const f of this.flippers) {
      if (f.swingTimer != null && f.swingTimer > FLIPPER_SWING_UP_TICKS) {
        f.swingTimer = FLIPPER_SWING_UP_TICKS;
      } else {
        f.swingTimer = f.swingTimer ?? 0;
      }
    }
  }

  isBallOnPlunger(player) {
    const pl = this.plunger;
    if (!pl) return false;
    const [px, py] = this.worldToTable(player.pos.x, player.pos.y);
    const gap = pl.y - (py + player.radius);
    return Math.abs(px - pl.x) < pl.width / 2 + player.radius
      && gap > -player.radius && gap < PLUNGER_CATCH_DISTANCE;
  }

  triggerJumpAction(player) {
    if (this.isBallOnPlunger(player)) {
      [player.vel.x, player.vel.y] = rotateVector(0, -this.plungerLaunchSpeed, this.rotationAngle());
      this.plunger.kickTimer = 8;
    } else {
      this.triggerFlippers();
    }
  }

  // -------------------------------------------------------------------
  // Ball physics
  // -------------------------------------------------------------------

  updateBall(player, ts, jumpHeld) {
    const a = this.rotationAngle();
    const from = this.ballAngle ?? a;
    [player.pos.x, player.pos.y] = this.worldToTable(player.pos.x, player.pos.y, from);
    [player.vel.x, player.vel.y] = rotateVector(player.vel.x, player.vel.y, -from);
    this.updateBallInTable(player, ts, jumpHeld);
    if (player.inPinball === this) {
      [player.pos.x, player.pos.y] = this.tableToWorld(player.pos.x, player.pos.y, a);
      [player.vel.x, player.vel.y] = rotateVector(player.vel.x, player.vel.y, a);
      this.ballAngle = a;
    }
  }

  updateBallInTable(player, ts, jumpHeld) {
    this.flippersHeld = jumpHeld;
    let gx = 0, gy = GRAVITY_ACCEL;
    if (GRAVITY_ALWAYS_SCREEN_DOWN) [gx, gy] = rotateVector(0, GRAVITY_ACCEL, -(this.ballAngle ?? this.rotationAngle()));
    player.vel.x += gx * ts;
    player.vel.y += gy * ts;

    let speed = Math.sqrt(player.vel.x * player.vel.x + player.vel.y * player.vel.y);
    if (speed > this.maxBallSpeed) {
      const scale = this.maxBallSpeed / speed;
      player.vel.x *= scale; player.vel.y *= scale;
      speed = this.maxBallSpeed;
    }

    let fastest = speed;
    for (const f of this.flippers) {
      if (f.swingTimer != null) {
        fastest = Math.max(fastest, f.length * rad(FLIPPER_SWING_DEGREES) / FLIPPER_SWING_UP_TICKS);
      }
    }
    const steps = Math.max(1, Math.ceil(fastest * ts / BALL_SUBSTEP_DISTANCE));
    const stepTs = ts / steps;

    const W = this.mapWidth, H = this.mapHeight;
    const mapRight = this.anchorX + W * TILE_WORLD_SIZE;
    const mapBottom = this.anchorY + H * TILE_WORLD_SIZE;

    for (let s = 0; s < steps; s++) {
      this.updateFlippers(stepTs);
      player.pos.x += player.vel.x * stepTs;
      player.pos.y += player.vel.y * stepTs;
      let contact = null;

      if (player.pos.y - player.radius > mapBottom || player.pos.y < this.anchorY
          || player.pos.x < this.anchorX || player.pos.x > mapRight) {
        this.exitBall(player);
        return;
      }

      const r = player.radius;
      const c0 = Math.max(0, Math.floor((player.pos.x - r - this.anchorX) / TILE_WORLD_SIZE));
      const c1 = Math.min(W - 1, Math.floor((player.pos.x + r - this.anchorX) / TILE_WORLD_SIZE));
      const r0 = Math.max(0, Math.floor((player.pos.y - r - this.anchorY) / TILE_WORLD_SIZE));
      const r1 = Math.min(H - 1, Math.floor((player.pos.y + r - this.anchorY) / TILE_WORLD_SIZE));
      for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
          const poly = this.cellPolys.get(row * W + col);
          if (poly) {
            const n = bounceOffPolygon(poly, player);
            if (n) contact = n;
          }
        }
      }

      if (this.plunger) {
        const n = bounceOffPolygon(this.plunger.poly, player);
        if (n) contact = n;
      }
      for (const b of this.bumpers) bounceOffBumper(b, player);
      for (const f of this.flippers) {
        const n = bounceOffFlipper(f, player);
        if (n) contact = n;
      }
      for (const d of this.drops) {
        if (!d.up) continue;
        const vx = player.vel.x, vy = player.vel.y;
        const n = bounceOffPolygon(d.poly, player);
        if (n) {
          contact = n;
          if (-(vx * n[0] + vy * n[1]) >= DROP_HIT_SPEED) this.knockDown(d);
        }
      }
      this.checkRollovers(player);

      if (contact) {
        player.ballSpin = (contact[0] * player.vel.y - contact[1] * player.vel.x) / player.radius;
      }
      player.ballRollAngle = lua.mod((player.ballRollAngle ?? 0) + (player.ballSpin ?? 0) * stepTs, 2 * Math.PI);
    }

    for (const b of this.bumpers) {
      if (b.flashTimer != null) b.flashTimer = b.flashTimer > ts ? b.flashTimer - ts : null;
    }
    if (this.plunger && this.plunger.kickTimer != null) {
      this.plunger.kickTimer = this.plunger.kickTimer > ts ? this.plunger.kickTimer - ts : null;
    }
    this.updateTargets(player, ts);
  }

  // -------------------------------------------------------------------
  // Drop targets, rollovers, scoring
  // -------------------------------------------------------------------

  score(points, x, y) {
    state.score = (state.score ?? 0) + points;
    this.popups.push({ text: '+' + points, x, y, life: POPUP_TICKS });
  }

  knockDown(d) {
    d.up = false;
    d.flashTimer = DROP_FLASH_TICKS;
    this.score(DROP_POINTS, d.cx, d.cy);
    for (const other of this.drops) if (other.up) return;
    const first = this.drops[0];
    this.score(DROP_BANK_BONUS, first.cx + first.nx * 60, first.cy + first.ny * 60);
    this.dropResetTimer = DROP_RESET_TICKS;
  }

  checkRollovers(player) {
    if (this.rolloverCelebrate != null) return;
    const reach = ROLLOVER_REACH_PX * TILE_SCALE;
    for (const ro of this.rollovers) {
      const over = (player.pos.x - ro.x) ** 2 + (player.pos.y - ro.y) ** 2 <= reach * reach;
      if (over && !ro.ballOver) {
        ro.flashTimer = DROP_FLASH_TICKS;
        if (!ro.lit) {
          ro.lit = true;
          this.score(ROLLOVER_POINTS, ro.x, ro.y);
          if (this.rollovers.every((o) => o.lit)) {
            this.score(ROLLOVER_ALL_BONUS, ro.x, ro.y - 80);
            this.rolloverCelebrate = ROLLOVER_CELEBRATE_TICKS;
          }
        }
      }
      ro.ballOver = over;
    }
  }

  updateTargets(player, ts) {
    for (const d of this.drops) {
      if (d.flashTimer != null) d.flashTimer = d.flashTimer > ts ? d.flashTimer - ts : null;
    }
    for (const ro of this.rollovers) {
      if (ro.flashTimer != null) ro.flashTimer = ro.flashTimer > ts ? ro.flashTimer - ts : null;
    }

    if (this.dropResetTimer != null) {
      this.dropResetTimer -= ts;
      if (this.dropResetTimer <= 0) {
        let clear = true;
        for (const d of this.drops) {
          const [, , dist] = closestPointOnPolygon(d.poly, player.pos.x, player.pos.y);
          if (dist < player.radius + 4 || pointInPolygon(d.poly.points, player.pos.x, player.pos.y)) clear = false;
        }
        if (clear) {
          for (const d of this.drops) { d.up = true; d.flashTimer = DROP_FLASH_TICKS; }
          this.dropResetTimer = null;
        }
      }
    }

    if (this.rolloverCelebrate != null) {
      this.rolloverCelebrate -= ts;
      if (this.rolloverCelebrate <= 0) {
        for (const ro of this.rollovers) ro.lit = false;
        this.rolloverCelebrate = null;
      }
    }

    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i];
      p.life -= ts;
      p.y -= POPUP_RISE * ts;
      if (p.life <= 0) this.popups.splice(i, 1);
    }
  }

  // -------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------

  // One bumper, centred on (x, y), through the planetoids' sun shading.
  // hitTicks: ticks since it was last hit, or null. Shared with the
  // bumpers out in space along the cannon's route (see Cannon.js).
  static drawBumper(x, y, radius, hitTicks) {
    const g = love.graphics;
    const hit = hitTicks != null && hitTicks < BUMPER_FLASH_TICKS;
    const grow = (hit && hitTicks < 6) ? 1.15 : 1;
    const lit = hit && lua.mod(Math.floor(hitTicks / BUMPER_BLINK_TICKS), 2) === 0;
    const face = getBumperFace(radius);
    const canvas = lit ? face.lit : face.normal;
    const r = radius * grow;
    const shader = Planetoid.applySunShadingAt(x, y, r, (face.half - radius) * grow, BUMPER_SHADING_MIX);
    const s = grow / BUMPER_BAKE_SCALE;
    g.setColor(1, 1, 1, 1);
    g.draw(canvas, x, y, 0, s, s, canvas.getWidth() / 2, canvas.getHeight() / 2);
    if (shader) g.setShader();
  }

  draw() {
    const g = love.graphics;
    const ax = this.anchorX, ay = this.anchorY;
    const w = this.mapWidth * TILE_WORLD_SIZE, h = this.mapHeight * TILE_WORLD_SIZE;

    const cx = this.planetoid.pos.x, cy = this.planetoid.pos.y;
    g.push();
    g.translate(cx, cy);
    g.rotate(this.rotationAngle());
    g.translate(-cx, -cy);

    g.setColor(COLOR_TABLE);
    g.rectangle('fill', ax, ay, w, h);
    g.setColor(1, 1, 1, 1);
    g.draw(this.batch);

    this.drawRollovers();
    this.drawDrops();

    for (const b of this.bumpers) {
      const elapsed = b.flashTimer != null ? (BUMPER_FLASH_TICKS - b.flashTimer) : null;
      PinballInterior.drawBumper(b.x, b.y, b.radius, elapsed);
    }

    const pl = this.plunger;
    if (pl) {
      const lift = pl.kickTimer != null ? -pl.height * 0.5 : 0;
      g.setColor(COLOR_PLUNGER);
      g.rectangle('fill', pl.x - pl.width / 2, pl.y + lift, pl.width, pl.height);
    }

    g.setColor(COLOR_FLIPPER);
    for (const f of this.flippers) {
      const cosA = Math.cos(f.angle), sinA = Math.sin(f.angle);
      const tipX = f.x + cosA * f.length, tipY = f.y + sinA * f.length;
      const nx = -sinA, ny = cosA;
      const rp = FLIPPER_RADIUS, rt = FLIPPER_RADIUS * 0.6;
      g.polygon('fill',
        f.x + nx * rp, f.y + ny * rp, tipX + nx * rt, tipY + ny * rt,
        tipX - nx * rt, tipY - ny * rt, f.x - nx * rp, f.y - ny * rp);
      g.circle('fill', f.x, f.y, rp);
      g.circle('fill', tipX, tipY, rt);
    }

    this.drawPopups();

    g.setColor(1, 1, 1, 1);
    g.pop();
  }

  drawRollovers() {
    const g = love.graphics;
    const w = ROLLOVER_SLOT_WIDTH_PX * TILE_SCALE, l = ROLLOVER_SLOT_LENGTH_PX * TILE_SCALE;
    const lightR = ROLLOVER_LIGHT_RADIUS_PX * TILE_SCALE;
    const blinkOn = this.rolloverCelebrate != null && lua.mod(Math.floor(this.rolloverCelebrate / 6), 2) === 0;
    for (const ro of this.rollovers) {
      g.setColor(COLOR_ROLLOVER_SLOT);
      g.rectangle('fill', ro.x - w / 2, ro.y - l / 2, w, l, w / 2, w / 2);
      g.setColor(COLOR_ROLLOVER_WIRE);
      g.setLineWidth(3);
      g.line(ro.x - w * 0.3, ro.y, ro.x + w * 0.3, ro.y);

      const on = (ro.lit && this.rolloverCelebrate == null) || blinkOn || ro.flashTimer != null;
      const lx = ro.x, ly = ro.y - l / 2 - ROLLOVER_LIGHT_OFFSET_PX * TILE_SCALE + lightR;
      if (on) {
        g.setColor(COLOR_ROLLOVER_ON[0], COLOR_ROLLOVER_ON[1], COLOR_ROLLOVER_ON[2], 0.25);
        g.circle('fill', lx, ly, lightR * 1.9);
      }
      g.setColor(on ? COLOR_ROLLOVER_ON : COLOR_ROLLOVER_OFF);
      g.circle('fill', lx, ly, lightR);
      g.setColor(COLOR_ROLLOVER_SLOT);
      g.setLineWidth(2);
      g.circle('line', lx, ly, lightR);
    }
    g.setLineWidth(1);
  }

  drawDrops() {
    const g = love.graphics;
    for (const d of this.drops) {
      const c = d.corners;
      const flash = d.flashTimer != null && lua.mod(Math.floor(d.flashTimer / 3), 2) === 0;
      if (d.up) {
        g.setColor(flash ? COLOR_DROP_STRIPE : COLOR_DROP);
        g.polygon('fill', c[0][0], c[0][1], c[1][0], c[1][1], c[2][0], c[2][1], c[3][0], c[3][1]);
        const inset = 0.3;
        const along = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
        const [ax, ay] = along(c[3], c[0], inset);
        const [bx, by] = along(c[2], c[1], inset);
        const s = 0.15;
        const ax2 = ax + (bx - ax) * s, ay2 = ay + (by - ay) * s;
        const bx2 = bx - (bx - ax) * s, by2 = by - (by - ay) * s;
        g.setColor(COLOR_DROP_STRIPE);
        g.setLineWidth(3);
        g.line(ax2, ay2, bx2, by2);
        g.setColor(COLOR_DROP_EDGE);
        g.setLineWidth(2);
        g.polygon('line', c[0][0], c[0][1], c[1][0], c[1][1], c[2][0], c[2][1], c[3][0], c[3][1]);
      } else {
        const t = 0.3;
        const toward = (p, q) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
        const [x3, y3] = toward(c[1], c[2]);
        const [x4, y4] = toward(c[0], c[3]);
        g.setColor(flash ? COLOR_DROP : COLOR_DROP_SLOT);
        g.polygon('fill', c[0][0], c[0][1], c[1][0], c[1][1], x3, y3, x4, y4);
      }
    }
    g.setLineWidth(1);
  }

  drawPopups() {
    const g = love.graphics;
    const font = g.getFont();
    const scale = 3;
    for (const p of this.popups) {
      const alpha = Math.min(1, p.life / (POPUP_TICKS * 0.4));
      const w = font.getWidth(p.text) * scale;
      g.setColor(0, 0, 0, alpha * 0.6);
      g.print(p.text, p.x - w / 2 + 2, p.y + 2, 0, scale, scale);
      g.setColor(COLOR_POPUP[0], COLOR_POPUP[1], COLOR_POPUP[2], alpha);
      g.print(p.text, p.x - w / 2, p.y, 0, scale, scale);
    }
  }
}

export default PinballInterior;
