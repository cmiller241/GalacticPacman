// js/world/Cannon.js
//
// A cannon mounted on a planet's surface, aimed at another planet far
// across the map. Bob curls into a ball and jumps into its mouth; it
// swallows him, swings round to aim, charges, and fires him off — no
// gravity, drag or steering on the way (see Cannon.updateFlight) — and
// he crashes into the target like a giant ground pound.
//
// The route is a chain of corner points between the cannon and the
// target; at each corner a curved metal rail floats in space (or a
// bumper, or loop-the-loops on the leg into it). See lua/world/Cannon.lua
// for the long-form notes.
//
// The sequence (this.state): idle, loading, aiming, charging, cooldown,
// returning.
//
// Port notes: route points are arrays [x, y] with extra named props
// (bumper, loops, radius, ...). pieces / flight.piece are 0-based.
// Multi-returns (pivot, muzzle, breech, flipperPose) return arrays.

import love from '../love/index.js';
import lua from '../love/lua.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import GroundPoundBurst from '../effects/GroundPoundBurst.js';
import CameraShake from '../effects/CameraShake.js';
import TiledTerrain from './TiledTerrain.js';
import PinballInterior from '../interiors/PinballInterior.js';
import Planetoid from './Planetoid.js';
import Explosion from '../entities/Explosion.js';
import Asteroid from '../entities/Asteroid.js';
import Coin from '../entities/Coin.js';
import constants from '../constants.js';
import utils from '../utils.js';

const G = () => love.graphics;
const rnd = () => lua.random();

// ---------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------

const BASE_HALF_WIDTH = 50;
const PIVOT_HEIGHT = 42;
const BARREL_LENGTH = 100;
const BARREL_BACK = 32;
const BARREL_HALF_WIDTH = 26;
const MUZZLE_HALF_WIDTH = 30;

const CAPTURE_RADIUS = 48;

const LOAD_SECONDS = 0.35;
const AIM_SECONDS = 1.4;
const CHARGE_SECONDS = 0.8;
const COOLDOWN_SECONDS = 1.2;
const RETURN_SECONDS = 1.0;
const RECOIL_SECONDS = 0.45;
const RECOIL_DISTANCE = 16;

const LAUNCH_SPEED = 110;
const RAIL_SPEED = 45;
const RAIL_BRAKE = 10;
const LINE_BOOST = 4;
const CRASH_BURST_SCALE = 2.4;
const CRASH_INNER_BURST_SCALE = 1.2;
const CRASH_SHAKE_STRENGTH = 50;
const CRASH_SHAKE_SECONDS = 0.8;

const AIM_LINE_LENGTH = 900;
const TRAIL_LENGTH = 14;

const TURN_RADIUS = 900;
const LOOP_RADIUS = 550;
const LOOP_SPACING = 500;
const LOOP_LEAD = 600;
const LOOP_TAIL = 200;
const CORKSCREW_FLING_SPEED = 170;
const FLING_EASE = 0.9;

const BUMPER_RADIUS = 105;
const BALL_CONTACT = 24;
const BUMPER_SPEED = 75;
const BUMPER_SHAKE_STRENGTH = 14;
const BUMPER_SHAKE_SECONDS = 0.25;
const BUMPER_RING_SECONDS = 0.4;

const OBSTACLE_SHAKE_STRENGTH = 22;
const OBSTACLE_SHAKE_SECONDS = 0.35;

const HIT_STOP_SECONDS = 0.06;
const HIT_STOP_TIME_FACTOR = 0.03;

const GAUNTLET_SPACING = 600;
const GAUNTLET_END_MARGIN = 700;
const GAUNTLET_MIN_RADIUS = 22;
const GAUNTLET_MAX_RADIUS = 46;
const GAUNTLET_SIDE_NUDGE = 0.5;

const SPEED_LINES_PER_SECOND = 70;
const SPEED_LINE_SECONDS = 0.35;
const SPEED_LINE_ALPHA = 0.35;

const AFTERIMAGE_COUNT = 5;
const AFTERIMAGE_SPACING = 70;
const AFTERIMAGE_ALPHA = 0.28;

const ROUTE_COINS = false;
const COIN_SPACING = 220;
const COIN_END_MARGIN = 160;
const COIN_POP_SECONDS = 0.3;
const RAIL_GAP = 26;
const RAIL_WIDTH = 22;
const RAIL_OVERHANG = 0.1;
const RAIL_SEGMENTS_PER_RADIAN = 40;
const RAIL_GLOW_SECONDS = 1.6;
const CHEVRON_SPACING = 90;

const COLOR_RAIL_GLOW = [0.45, 0.9, 1.0];

const COLOR_OUTLINE = [0.06, 0.06, 0.08];
const COLOR_STEEL_LIGHT = [0.62, 0.66, 0.74];
const COLOR_STEEL = [0.34, 0.37, 0.44];
const COLOR_STEEL_DARK = [0.14, 0.15, 0.19];
const COLOR_BRASS = [0.82, 0.63, 0.3];
const COLOR_BRASS_LIGHT = [1.0, 0.88, 0.55];
const COLOR_HINT = [0.45, 0.9, 1.0];
const COLOR_FIRE = [1.0, 0.6, 0.2];

const FLIPPER_LENGTH = 560;
const FLIPPER_THICKNESS = 46;
const FLIPPER_CONTACT_AT = 0.45;
const FLIPPER_CONTACT_RADIUS = 24;
const FLIPPER_REST_ANGLE = 0.45;
const FLIPPER_SWING_RATE = 22;
const FLIPPER_MIN_SPEED = 90;

let hitStopUntil = 0;
const COLOR_FLIPPER = [0.95, 0.35, 0.4];
const COLOR_FLIPPER_LIGHT = [1.0, 0.75, 0.75];

// ---------------------------------------------------------------------

function smoothstep(t) {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
}

// From a toward b by t, the short way round.
function lerpAngle(a, b, t) {
  const d = lua.mod(b - a + Math.PI, Math.PI * 2) - Math.PI;
  return a + d * t;
}

const LEDGE_HALF_WIDTH = MUZZLE_HALF_WIDTH + 20;
const LEDGE_PARKED = -100000;

// A rail: a circular arc he rides — see the Lua for details.
function makeRail(entry, inX, inY, radius, sign, sweep, ring) {
  const ccx = entry[0] + sign * radius * -inY, ccy = entry[1] + sign * radius * inX;
  const rail = {
    cx: ccx, cy: ccy, radius,
    phi0: Math.atan2(entry[1] - ccy, entry[0] - ccx), sign, sweep,
    loops: ring ? 1 : 0,
    length: radius * sweep,
    entry, inDir: [inX, inY],
    glowAt: null,
  };
  const phi = rail.phi0 + sign * sweep;
  const c = Math.cos(phi), s = Math.sin(phi);
  rail.exit = [ccx + c * radius, ccy + s * radius];
  rail.outDir = [-s * sign, c * sign];
  return rail;
}

// A bumper at corner `at`, bouncing (inX,inY) off along (outX,outY).
function makeBumper(at, inX, inY, outX, outY, radius) {
  let nx = outX - inX, ny = outY - inY;
  const len = Math.sqrt(nx * nx + ny * ny);
  if (len < 1e-6) { nx = -inX; ny = -inY; } else { nx /= len; ny /= len; }
  const back = radius + BALL_CONTACT;
  return {
    x: at[0] - nx * back, y: at[1] - ny * back, radius,
    at: [at[0], at[1]], normal: [nx, ny],
    inDir: [inX, inY], outDir: [outX, outY],
    hitAt: null,
  };
}

function copyCorner(c) {
  return Object.assign([c[0], c[1]], {
    loops: c.loops, radius: c.radius, loopRadius: c.loopRadius,
    loopGap: c.loopGap, fling: c.fling, loopsFirst: c.loopsFirst,
    bumper: c.bumper, bumperRadius: c.bumperRadius, gauntlet: c.gauntlet,
  });
}

function dirBetween(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  return [dx / len, dy / len, len];
}

// A track: from a list of points, the whole path he flies, as
// owner.pieces (0-based), plus owner.rails and owner.bumpers.
// (Inside, corners keep Lua's 1-based numbering: P(i) = points[i - 1].)
function buildTrack(owner, points, closed) {
  const n = points.length;
  const P = (i) => points[i - 1];
  const before = (i) => (closed && i === 1) ? P(n) : P(i - 1);
  const after = (i) => (closed && i === n) ? P(1) : P(i + 1);

  const turns = {}, bumpers = {};
  owner.bumpers = [];
  for (let i = closed ? 1 : 2; i <= (closed ? n : n - 1); i++) {
    const [inX, inY, lenIn] = dirBetween(before(i), P(i));
    const [outX, outY, lenOut] = dirBetween(P(i), after(i));
    const turn = Math.acos(Math.max(-1, Math.min(1, inX * outX + inY * outY)));
    const sign = (inX * outY - inY * outX) >= 0 ? 1 : -1;
    if (P(i).bumper) {
      bumpers[i] = makeBumper(P(i), inX, inY, outX, outY, P(i).bumperRadius ?? BUMPER_RADIUS);
      bumpers[i].sign = sign;
      owner.bumpers.push(bumpers[i]);
    } else {
      let radius = P(i).radius ?? TURN_RADIUS;
      const maxT = 0.45 * Math.min(lenIn, lenOut);
      if (radius * Math.tan(turn / 2) > maxT) radius = maxT / Math.tan(turn / 2);
      const t = radius * Math.tan(turn / 2);
      const entry = [P(i)[0] - inX * t, P(i)[1] - inY * t];
      turns[i] = makeRail(entry, inX, inY, radius, sign, turn, false);
    }
  }

  const order = [];
  for (let i = 2; i <= n; i++) order.push(i);
  if (closed) order.push(1);
  let cursor = P(1);
  if (closed) cursor = turns[1] ? turns[1].exit : P(1);

  owner.pieces = [];
  owner.rails = [];
  for (const i of order) {
    const turn = turns[i], bumper = bumpers[i];
    const legEnd = turn ? turn.entry : P(i);
    const [dx, dy, len] = dirBetween(cursor, legEnd);

    let loops = P(i).loops ?? 0;
    if (loops > 0) {
      const loopR = P(i).loopRadius ?? LOOP_RADIUS;
      const gap = P(i).loopGap ?? (loopR * 2 + LOOP_SPACING);
      const lead = loopR + LOOP_LEAD;
      const fits = Math.floor((len - lead - loopR - LOOP_LEAD) / gap) + 1;
      if (fits < loops) {
        console.log(`Cannon.js: only room for ${Math.max(0, fits)} of the ${loops} loops on the leg into corner ${i} — make that leg longer.`);
        loops = Math.max(0, fits);
      }
      const side = (turn && turn.sign) || (bumper && bumper.sign) || 1;
      const legStart = cursor;
      for (let k = 1; k <= loops; k++) {
        let touch;
        if (P(i).loopsFirst) {
          const ahead = lead + (k - 1) * gap;
          touch = [legStart[0] + dx * ahead, legStart[1] + dy * ahead];
        } else {
          const back = lead + (loops - k) * gap;
          touch = [legEnd[0] - dx * back, legEnd[1] - dy * back];
        }
        owner.pieces.push({ kind: 'line', from: cursor, to: touch, dir: [dx, dy] });
        const ring = makeRail(touch, dx, dy, loopR, side, Math.PI * 2, true);
        ring.tail = LOOP_TAIL;
        if (P(i).fling && k === loops) ring.fling = true;
        owner.pieces.push({ kind: 'arc', rail: ring });
        owner.rails.push(ring);
        cursor = touch;
      }
    }

    owner.pieces.push({ kind: 'line', from: cursor, to: legEnd, dir: [dx, dy], gauntlet: P(i).gauntlet });
    if (turn) {
      owner.pieces.push({ kind: 'arc', rail: turn });
      owner.rails.push(turn);
      cursor = turn.exit;
    } else if (bumper) {
      owner.pieces.push({ kind: 'bounce', bumper });
      cursor = P(i);
    }
  }
}

// A point round rail `rail`, `s` world units along, `out` further out;
// and the direction of travel there. -> [x, y, dx, dy]
function railPoint(rail, s, out) {
  const phi = rail.phi0 + rail.sign * s / rail.radius;
  const r = rail.radius + (out ?? 0);
  const c = Math.cos(phi), sn = Math.sin(phi);
  return [rail.cx + c * r, rail.cy + sn * r, -sn * rail.sign, c * rail.sign];
}

class Cannon {
  // planet: what it's mounted on. mountAngle: where on it. target: the
  // planet it fires at. corners (optional): [[x, y, {extra props}], ...].
  // merge (optional, instead of a target): see Cannon.trackMergeAt.
  static new(planet, mountAngle, target, corners, merge) {
    const self = new Cannon();
    self.planet = planet;
    self.mountAngle = mountAngle;
    self.target = target;
    self.merge = merge;
    self.restAngle = mountAngle;
    self.barrelAngle = mountAngle;
    self.state = 'idle';
    self.timer = 0;
    self.time = 0;
    self.firedAt = null;
    self.particles = [];
    self.railParticles = [];
    self.buildRoute(corners ?? []);

    self.ledge = TiledTerrain.newMovingSurface(0, 0, 1, 0);
    self.placeLedge();
    state.planetoids.push(self.ledge);
    return self;
  }

  placeLedge() {
    if (this.state !== 'idle') {
      this.ledge.moveTo(LEDGE_PARKED, LEDGE_PARKED, LEDGE_PARKED + 1, LEDGE_PARKED);
      return;
    }
    const [mx, my] = this.muzzle();
    const dx = Math.cos(this.barrelAngle), dy = Math.sin(this.barrelAngle);
    const tx = -dy, ty = dx;
    this.ledge.moveTo(mx - tx * LEDGE_HALF_WIDTH, my - ty * LEDGE_HALF_WIDTH,
      mx + tx * LEDGE_HALF_WIDTH, my + ty * LEDGE_HALF_WIDTH);
  }

  buildRoute(corners) {
    const [px, py] = this.pivot();
    const points = [[px, py]];
    for (const c of corners) points.push(copyCorner(c));
    const m = this.merge;
    if (m) {
      points.push(Object.assign([m.at[0], m.at[1]], { radius: m.radius }));
      points.push([m.at[0] + m.dir[0] * m.ahead, m.at[1] + m.dir[1] * m.ahead]);
    } else {
      points.push([this.target.pos.x, this.target.pos.y]);
    }
    buildTrack(this, points, false);
    if (m) {
      this.pieces.pop();
      points.pop();
    }
    this.points = points;
    this.placeCoins();
  }

  // A track that's a loop with no end — the galactic expressway.
  static newTrack(corners) {
    const self = new Cannon();
    self.isTrack = true;
    self.closed = true;
    self.time = 0;
    self.particles = [];
    self.railParticles = [];
    self.coins = [];
    self.coinPops = [];
    const points = [];
    for (const c of corners) points.push(copyCorner(c));
    self.points = points;
    buildTrack(self, points, true);
    return self;
  }

  // Where a cannon's route can merge onto `track` near (x, y). piece is a
  // 0-based index into track.pieces.
  static trackMergeAt(track, x, y) {
    let best = null;
    track.pieces.forEach((piece, i) => {
      if (piece.kind !== 'line') return;
      const fx = piece.from[0], fy = piece.from[1], tx = piece.to[0], ty = piece.to[1];
      const dx = tx - fx, dy = ty - fy;
      const lenSq = dx * dx + dy * dy;
      const t = lenSq > 0 ? Math.max(0, Math.min(1, ((x - fx) * dx + (y - fy) * dy) / lenSq)) : 0;
      const px = fx + dx * t, py = fy + dy * t;
      const d = (x - px) ** 2 + (y - py) ** 2;
      if (!best || d < best.d) {
        best = { d, piece: i, at: [px, py], dir: [piece.dir[0], piece.dir[1]], ahead: Math.sqrt(lenSq) * (1 - t) };
      }
    });
    return { track, piece: best.piece, at: best.at, dir: best.dir, ahead: best.ahead };
  }

  // An exit off `track` (pieceIndex 0-based) — see the Lua.
  static newExit(track, pieceIndex, points, target) {
    const self = new Cannon();
    self.isTrack = true;
    self.isExit = true;
    self.closed = false;
    self.time = 0;
    self.particles = [];
    self.railParticles = [];
    self.coins = [];
    self.coinPops = [];
    self.target = target;
    self.points = points;
    buildTrack(self, points, false);

    const piece = track.pieces[pieceIndex];
    self.fromTrack = track;
    self.at = [points[0][0], points[0][1]];
    const dx = piece.dir[0], dy = piece.dir[1];
    const ox = self.pieces[0].dir[0], oy = self.pieces[0].dir[1];
    self.dir = [dx, dy];
    self.outDir = [ox, oy];
    self.side = (dx * oy - dy * ox) >= 0 ? 1 : -1;
    const sx = -dy * self.side, sy = dx * self.side;

    let nx = ox - dx, ny = oy - dy;
    const nLen = Math.sqrt(nx * nx + ny * ny);
    nx /= nLen; ny /= nLen;
    self.normal = [nx, ny];
    let tx = -ny, ty = nx;
    if (tx * sx + ty * sy < 0) { tx = -tx; ty = -ty; }
    const reach = FLIPPER_CONTACT_RADIUS + FLIPPER_THICKNESS * 0.4;
    const cx = self.at[0] - nx * reach, cy = self.at[1] - ny * reach;
    // (Named flipperPivot — `pivot` is the cannon's method.)
    self.flipperPivot = [cx - tx * FLIPPER_LENGTH * FLIPPER_CONTACT_AT, cy - ty * FLIPPER_LENGTH * FLIPPER_CONTACT_AT];
    self.upAngle = Math.atan2(ty, tx);
    const rx = dx * Math.cos(FLIPPER_REST_ANGLE) - sx * Math.sin(FLIPPER_REST_ANGLE);
    const ry = dy * Math.cos(FLIPPER_REST_ANGLE) - sy * Math.sin(FLIPPER_REST_ANGLE);
    self.restAngle = Math.atan2(ry, rx);
    self.flip = 0;

    piece.exits = piece.exits ?? [];
    piece.exits.push(self);
    return self;
  }

  // The jump button, held — what raises every exit's flipper.
  static flipperHeld() {
    return !!((state.keys && state.keys[' ']) || state.gamepadJumpHeld);
  }

  // -> [px, py, tx, ty]
  flipperPose() {
    const a = lerpAngle(this.restAngle, this.upAngle, this.flip);
    return [this.flipperPivot[0], this.flipperPivot[1], Math.cos(a), Math.sin(a)];
  }

  hitFlipper() {
    this.flippedAt = this.time;
    this.flip = 1;
    const x = this.at[0], y = this.at[1];
    const base = Math.atan2(this.normal[1], this.normal[0]);
    for (let k = 0; k < 26; k++) {
      const a = base + (rnd() - 0.5) * 2.2;
      const speed = 500 + rnd() * 1000;
      const life = 0.25 + rnd() * 0.35;
      this.railParticles.push({
        kind: 'spark', x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
        life, maxLife: life, size: 1.6 + rnd() * 1.4,
      });
    }
    CameraShake.start(BUMPER_SHAKE_STRENGTH, BUMPER_SHAKE_SECONDS);
    hitStopUntil = love.timer.getTime() + HIT_STOP_SECONDS;
    if (state.audioManager) state.audioManager.playGoombaStomp();
  }

  placeCoins() {
    this.coins = [];
    this.coinPops = [];
    if (!ROUTE_COINS) return;
    this.pieces.forEach((piece, idx) => {
      if (piece.kind !== 'line') return;
      const len = Math.sqrt((piece.to[0] - piece.from[0]) ** 2 + (piece.to[1] - piece.from[1]) ** 2);
      const startAt = COIN_END_MARGIN + (idx === 0 ? BARREL_LENGTH : 0);
      const endAt = len - COIN_END_MARGIN - ((idx === this.pieces.length - 1 && this.target) ? this.target.radius : 0);
      if (endAt > startAt) {
        const count = Math.floor((endAt - startAt) / COIN_SPACING) + 1;
        const first = startAt + ((endAt - startAt) - (count - 1) * COIN_SPACING) / 2;
        for (let k = 0; k < count; k++) {
          const d = first + k * COIN_SPACING;
          const coin = Object.assign(Object.create(Coin.prototype), {
            pos: Vector2.new(piece.from[0] + piece.dir[0] * d, piece.from[1] + piece.dir[1] * d),
            radius: constants.COIN_RADIUS ?? 12,
          });
          this.coins.push(coin);
        }
      }
    });
  }

  updateCoins(player, dt) {
    for (let i = this.coinPops.length - 1; i >= 0; i--) {
      const pop = this.coinPops[i];
      pop.t += dt;
      if (pop.t >= COIN_POP_SECONDS) this.coinPops.splice(i, 1);
    }
    if (!player || player.inCannon || player.isDying) return;
    const from = player.prevPos ?? player.pos;
    const ax = from.x, ay = from.y;
    const bx = player.pos.x, by = player.pos.y;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    for (const coin of this.coins) {
      if (coin.collected) continue;
      const cx = coin.pos.x, cy = coin.pos.y;
      const t = lenSq > 0 ? Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / lenSq)) : 0;
      const reach = player.radius + coin.radius;
      if ((cx - (ax + dx * t)) ** 2 + (cy - (ay + dy * t)) ** 2 <= reach * reach) {
        coin.collected = true;
        state.score = (state.score ?? 0) + 1;
        this.coinPops.push({ x: cx, y: cy, t: 0 });
        if (state.audioManager) state.audioManager.playEatDot();
      }
    }
  }

  // -> [x, y]
  pivot() {
    const c = Math.cos(this.mountAngle), s = Math.sin(this.mountAngle);
    const d = this.planet.radius + PIVOT_HEIGHT;
    return [this.planet.pos.x + c * d, this.planet.pos.y + s * d];
  }

  aimAngle() {
    const dir = this.pieces[0].dir;
    return Math.atan2(dir[1], dir[0]);
  }

  recoilOffset() {
    if (this.firedAt == null) return 0;
    const t = (this.time - this.firedAt) / RECOIL_SECONDS;
    if (t >= 1) return 0;
    return RECOIL_DISTANCE * (t < 0.15 ? t / 0.15 : (1 - smoothstep((t - 0.15) / 0.85)));
  }

  // -> [x, y]
  muzzle() {
    const [px, py] = this.pivot();
    const d = BARREL_LENGTH - this.recoilOffset();
    return [px + Math.cos(this.barrelAngle) * d, py + Math.sin(this.barrelAngle) * d];
  }

  // Where he's held while inside. -> [x, y]
  breech() {
    const [px, py] = this.pivot();
    const d = -BARREL_BACK * 0.3;
    return [px + Math.cos(this.barrelAngle) * d, py + Math.sin(this.barrelAngle) * d];
  }

  // -------------------------------------------------------------------
  // Particles
  // -------------------------------------------------------------------

  puff(x, y, dirAngle, count, speed, kind) {
    for (let k = 0; k < count; k++) {
      const a = dirAngle + (rnd() - 0.5) * (kind === 'spark' ? 0.9 : 1.4);
      const v = speed * (0.4 + rnd() * 0.8);
      const life = kind === 'spark' ? (0.25 + rnd() * 0.35) : (0.7 + rnd() * 0.8);
      this.particles.push({
        kind, x, y,
        vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        life, maxLife: life,
        size: kind === 'spark' ? 1.6 : (8 + rnd() * 10),
      });
    }
  }

  updateParticles(dt) {
    updateParticleList(this.particles, dt);
    updateParticleList(this.railParticles, dt);
  }

  // -------------------------------------------------------------------
  // The sequence
  // -------------------------------------------------------------------

  capture(player) {
    player.inCannon = this;
    player.cannonFlight = null;
    player.pullTarget = null;
    player.lockedTarget = null;
    state.vatsActive = false;
    player.onSurface = false;
    player.currentPlanet = null;
    player.lastInfluencePlanet = this.planet;
    player.isGroundPounding = false;
    player.vel.x = 0; player.vel.y = 0;
    this.captureFrom = Vector2.new(player.pos.x, player.pos.y);
    this.state = 'loading'; this.timer = 0;
    const [mx, my] = this.muzzle();
    this.puff(mx, my, this.barrelAngle, 6, 60, 'smoke');
    if (state.audioManager) state.audioManager.playJumpSmall();
  }

  launch(player) {
    const dirX = this.pieces[0].dir[0], dirY = this.pieces[0].dir[1];
    const [mx, my] = this.muzzle();
    player.inCannon = null;
    player.pos.x = mx + dirX * (player.radius + 2);
    player.pos.y = my + dirY * (player.radius + 2);
    player.prevPos = player.pos.clone();
    player.vel.x = dirX * LAUNCH_SPEED; player.vel.y = dirY * LAUNCH_SPEED;
    player.cannonFlight = {
      cannon: this, track: this, target: this.target, piece: 0, railS: 0,
      speed: LAUNCH_SPEED, trail: [],
    };

    for (const coin of this.coins) coin.collected = false;

    this.firedAt = this.time;
    this.state = 'cooldown'; this.timer = 0;
    this.flashTimer = 0.18;
    this.puff(mx, my, this.barrelAngle, 16, 260, 'smoke');
    this.puff(mx, my, this.barrelAngle, 26, 900, 'spark');
    if (state.audioManager) state.audioManager.playBang('large', Vector2.new(mx, my));
  }

  update(player, ts) {
    const dt = ts / 60;
    this.time += dt;
    if (this.isTrack) {
      this.updateParticles(dt);
      if (this.isExit) {
        const goal = Cannon.flipperHeld() ? 1 : 0;
        this.flip = goal + (this.flip - goal) * Math.exp(-FLIPPER_SWING_RATE * dt);
      }
      return;
    }
    this.timer += dt;
    if (this.flashTimer != null) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.flashTimer = null;
    }
    this.updateParticles(dt);

    let holding = this.state === 'loading' || this.state === 'aiming' || this.state === 'charging';
    if (holding && (!player || player.inCannon !== this)) {
      this.state = 'returning'; this.timer = 0;
      this.returnFrom = this.barrelAngle;
      holding = false;
    }

    if (this.state === 'idle') {
      if (player && player.isBall && !player.morphState && !player.inCannon
          && player.onSurface && player.currentPlanet === this.ledge
          && !player.isDying && !player.isTeleporting && !player.portalTransit) {
        this.capture(player);
        holding = true;
      }
    } else if (this.state === 'loading') {
      if (this.timer >= LOAD_SECONDS) { this.state = 'aiming'; this.timer = 0; }
    } else if (this.state === 'aiming') {
      const t = smoothstep(this.timer / AIM_SECONDS);
      this.barrelAngle = lerpAngle(this.restAngle, this.aimAngle(), t);
      if (this.timer >= AIM_SECONDS) {
        this.barrelAngle = this.aimAngle();
        this.state = 'charging'; this.timer = 0;
      }
    } else if (this.state === 'charging') {
      const [mx, my] = this.muzzle();
      if (rnd() < 0.5) this.puff(mx, my, this.barrelAngle, 1, 120, 'spark');
      if (this.timer >= CHARGE_SECONDS) {
        this.launch(player);
        holding = false;
      }
    } else if (this.state === 'cooldown') {
      if (this.timer >= COOLDOWN_SECONDS) {
        this.state = 'returning'; this.timer = 0;
        this.returnFrom = this.barrelAngle;
      }
    } else if (this.state === 'returning') {
      this.barrelAngle = lerpAngle(this.returnFrom ?? this.restAngle, this.restAngle, smoothstep(this.timer / RETURN_SECONDS));
      if (this.timer >= RETURN_SECONDS) {
        this.barrelAngle = this.restAngle;
        this.state = 'idle'; this.timer = 0;
      }
    }

    this.placeLedge();

    if (holding && player) {
      let [bx, by] = this.breech();
      if (this.state === 'loading' && this.captureFrom) {
        const t = smoothstep(this.timer / LOAD_SECONDS);
        bx = this.captureFrom.x + (bx - this.captureFrom.x) * t;
        by = this.captureFrom.y + (by - this.captureFrom.y) * t;
      }
      player.pos.x = bx; player.pos.y = by;
      player.prevPos = player.pos.clone();
      player.vel.x = 0; player.vel.y = 0;
    }
  }

  static timeFactor() {
    if (love.timer.getTime() < hitStopUntil) return HIT_STOP_TIME_FACTOR;
    return 1;
  }

  hitBumper(bumper) {
    bumper.hitAt = this.time;
    const x = bumper.at[0], y = bumper.at[1];
    const base = Math.atan2(bumper.normal[1], bumper.normal[0]);
    for (let k = 0; k < 22; k++) {
      const a = base + (rnd() - 0.5) * 2.4;
      const speed = 500 + rnd() * 900;
      const life = 0.25 + rnd() * 0.35;
      this.railParticles.push({
        kind: 'spark', x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
        life, maxLife: life, size: 1.6 + rnd() * 1.4,
      });
    }
    CameraShake.start(BUMPER_SHAKE_STRENGTH, BUMPER_SHAKE_SECONDS);
    hitStopUntil = love.timer.getTime() + HIT_STOP_SECONDS;
    if (state.audioManager) state.audioManager.playGoombaStomp();
  }

  // -------------------------------------------------------------------
  // The flight
  // -------------------------------------------------------------------

  static updateFlight(player, ts) {
    const flight = player && player.cannonFlight;
    if (!flight) {
      clearGauntlet();
      return;
    }
    if (player.onSurface) {
      crashLanding(player);
      player.cannonFlight = null;
      return;
    }
    if (player.pullTarget || player.portalTransit || player.isDying
        || player.isTeleporting || player.inPinball || player.inCannon) {
      player.cannonFlight = null;
      return;
    }

    let track = flight.track;
    let piece = track.pieces[flight.piece];
    const dt = ts / 60;

    if (piece.kind === 'line' && piece.exits && flight.lastX != null && Cannon.flipperHeld()) {
      for (const exit of piece.exits) {
        const dx = exit.dir[0], dy = exit.dir[1];
        const before = (flight.lastX - exit.at[0]) * dx + (flight.lastY - exit.at[1]) * dy;
        const now = (player.pos.x - exit.at[0]) * dx + (player.pos.y - exit.at[1]) * dy;
        if (before < 0 && now >= 0) {
          const ox = exit.outDir[0], oy = exit.outDir[1];
          flight.track = exit; flight.piece = 0; flight.target = exit.target;
          track = exit; piece = exit.pieces[0];
          flight.speed = Math.max(flight.speed, FLIPPER_MIN_SPEED);
          player.pos.x = exit.at[0] + ox * now; player.pos.y = exit.at[1] + oy * now;
          player.vel.x = ox * flight.speed; player.vel.y = oy * flight.speed;
          exit.hitFlipper();
          break;
        }
      }
    }
    flight.lastX = player.pos.x; flight.lastY = player.pos.y;

    if (flight.onPiece !== piece) {
      flight.onPiece = piece;
      if (piece.kind === 'line' && piece.gauntlet) spawnGauntlet(piece);
    }
    if (piece.kind === 'arc') {
      const rail = piece.rail;
      flight.speed = RAIL_SPEED + (flight.speed - RAIL_SPEED) * Math.exp(-RAIL_BRAKE * dt);
      flight.railS += flight.speed * ts;
      if (flight.railS < rail.length) {
        placeOnRail(player, rail, flight.railS, flight.speed);
        railSparks(track, rail, flight.railS, player, flight.speed);
        rail.glowAt = track.time;
      } else {
        const over = flight.railS - rail.length;
        const dir = rail.outDir;
        if (rail.fling) {
          flight.speed = CORKSCREW_FLING_SPEED;
          CameraShake.start(BUMPER_SHAKE_STRENGTH, BUMPER_SHAKE_SECONDS);
          if (state.audioManager) state.audioManager.playBang('medium', Vector2.new(player.pos.x, player.pos.y));
        }
        player.pos.x = rail.exit[0] + dir[0] * over; player.pos.y = rail.exit[1] + dir[1] * over;
        player.vel.x = dir[0] * flight.speed; player.vel.y = dir[1] * flight.speed;
        const nextI = nextPieceIndex(track, flight.piece);
        if (nextI != null) {
          flight.piece = nextI;
        } else if (track.merge) {
          flight.track = track.merge.track; flight.piece = track.merge.piece;
        }
      }
    } else {
      const ease = flight.speed > LAUNCH_SPEED ? FLING_EASE : LINE_BOOST;
      flight.speed = LAUNCH_SPEED + (flight.speed - LAUNCH_SPEED) * Math.exp(-ease * dt);
      player.vel.x = piece.dir[0] * flight.speed; player.vel.y = piece.dir[1] * flight.speed;
      const nextI = nextPieceIndex(track, flight.piece);
      const nextPiece = nextI != null ? track.pieces[nextI] : null;
      if (nextPiece && nextPiece.kind === 'bounce') {
        const past = (player.pos.x - piece.to[0]) * piece.dir[0] + (player.pos.y - piece.to[1]) * piece.dir[1];
        if (past >= 0) {
          const bumper = nextPiece.bumper;
          const out = bumper.outDir;
          flight.speed = BUMPER_SPEED;
          player.pos.x = bumper.at[0] + out[0] * past; player.pos.y = bumper.at[1] + out[1] * past;
          player.vel.x = out[0] * flight.speed; player.vel.y = out[1] * flight.speed;
          flight.piece = nextPieceIndex(track, nextI);
          track.hitBumper(bumper);
        }
      } else if (nextPiece) {
        const past = (player.pos.x - piece.to[0]) * piece.dir[0] + (player.pos.y - piece.to[1]) * piece.dir[1];
        if (past >= 0) {
          const rail = nextPiece.rail;
          flight.piece = nextI;
          flight.railS = past;
          placeOnRail(player, rail, past, flight.speed);
          rail.glowAt = track.time;
          if (state.audioManager) state.audioManager.playBang('small', Vector2.new(player.pos.x, player.pos.y));
        }
      } else {
        // The last leg: into the target, at full speed.
        const t = flight.target;
        const dx = player.pos.x - t.pos.x, dy = player.pos.y - t.pos.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (t.isRoundedRect) {
          const surface = t.nearestSurfacePoint(player.pos.x, player.pos.y);
          if (t.containsPoint(player.pos.x, player.pos.y) || surface.distance <= player.radius) {
            player.pos.x = surface.point.x + surface.normal.x * player.radius;
            player.pos.y = surface.point.y + surface.normal.y * player.radius;
            player.prevPos = player.pos.clone();
            player.vel.x = 0; player.vel.y = 0;
            player.onSurface = true;
            player.currentPlanet = t;
            player.lastInfluencePlanet = t;
            if (t.arcPositionForWorldPoint) {
              player.surfaceArcPos = t.arcPositionForWorldPoint(player.pos.x, player.pos.y, true);
            }
            player.angle = -Math.PI / 2;
            crashLanding(player);
            player.cannonFlight = null;
            return;
          }
        } else if (dist <= t.radius + player.radius) {
          let ux = dx / Math.max(dist, 1e-6), uy = dy / Math.max(dist, 1e-6);
          if (dist < 1e-6) { ux = -piece.dir[0]; uy = -piece.dir[1]; }
          player.pos.x = t.pos.x + ux * (t.radius + player.radius);
          player.pos.y = t.pos.y + uy * (t.radius + player.radius);
          player.prevPos = player.pos.clone();
          player.vel.x = 0; player.vel.y = 0;
          player.onSurface = true;
          player.currentPlanet = t;
          player.lastInfluencePlanet = t;
          player.angle = Math.atan2(uy, ux);
          crashLanding(player);
          player.cannonFlight = null;
          return;
        }
      }
    }

    clearTheWay(player, flight, ts);

    flight.trail.unshift({ x: player.pos.x, y: player.pos.y });
    if (flight.trail.length > TRAIL_LENGTH) flight.trail.pop();

    flight.ghosts = flight.ghosts ?? [];
    const last = flight.ghosts[0];
    if (!last || (player.pos.x - last.x) ** 2 + (player.pos.y - last.y) ** 2 >= AFTERIMAGE_SPACING ** 2) {
      flight.ghosts.unshift({ x: player.pos.x, y: player.pos.y });
      if (flight.ghosts.length > AFTERIMAGE_COUNT + 1) flight.ghosts.pop();
    }
  }

  // -------------------------------------------------------------------
  // Drawing the rails
  // -------------------------------------------------------------------

  drawRails() {
    const g = G();
    g.push('all');
    g.setLineStyle('smooth');
    g.setLineJoin('bevel');
    for (const rail of this.rails) {
      if (!utils.isOnScreen(rail.cx, rail.cy, rail.radius + RAIL_GAP + RAIL_WIDTH + (rail.tail ?? 0) + 60, 50)) continue;
      railMesh(rail);
      const glow = rail.glowAt != null ? Math.max(0, 1 - (this.time - rail.glowAt) / RAIL_GLOW_SECONDS) : 0;
      const inner = rail.radius + RAIL_GAP;

      g.setColor(COLOR_OUTLINE);
      g.setLineWidth(3);
      g.line(rail.edgeIn);
      g.line(rail.edgeOut);
      g.setColor(1, 1, 1, 1);
      g.draw(rail.mesh);
      g.draw(rail.backMesh);

      let ends = [rail.drawStart, rail.drawStart + rail.sign * rail.drawSpan];
      if (rail.loops > 0) {
        ends = [];
        for (let k = 0; k <= 5; k++) ends.push(rail.phi0 + k * Math.PI / 3 + Math.PI / 6);
      }
      for (const a of ends) {
        const c = Math.cos(a), s = Math.sin(a);
        const x0 = rail.cx + c * (inner - 2), y0 = rail.cy + s * (inner - 2);
        const x1 = rail.cx + c * (inner + RAIL_WIDTH + 2), y1 = rail.cy + s * (inner + RAIL_WIDTH + 2);
        g.setColor(COLOR_OUTLINE);
        g.setLineWidth(9);
        g.line(x0, y0, x1, y1);
        g.setColor(COLOR_BRASS);
        g.setLineWidth(6);
        g.line(x0, y0, x1, y1);
        const bx = rail.cx + c * (inner + RAIL_WIDTH + 9), by = rail.cy + s * (inner + RAIL_WIDTH + 9);
        const blink = (Math.sin(this.time * 5 + a * 3) > 0.3) ? 1 : 0.25;
        g.setColor(COLOR_OUTLINE);
        g.circle('fill', bx, by, 5.5);
        g.setBlendMode('add');
        g.setColor(COLOR_RAIL_GLOW[0], COLOR_RAIL_GLOW[1], COLOR_RAIL_GLOW[2], 0.25 * blink);
        g.circle('fill', bx, by, 14);
        g.setColor(COLOR_RAIL_GLOW[0], COLOR_RAIL_GLOW[1], COLOR_RAIL_GLOW[2], blink);
        g.circle('fill', bx, by, 3.5);
        g.setBlendMode('alpha');
      }

      g.setBlendMode('add');
      const stripR = inner + RAIL_WIDTH * 0.3;
      const points = [];
      const steps = Math.max(8, Math.ceil(rail.drawSpan * RAIL_SEGMENTS_PER_RADIAN));
      for (let i = 0; i <= steps; i++) {
        const a = rail.drawStart + rail.sign * rail.drawSpan * i / steps;
        points.push(rail.cx + Math.cos(a) * stripR, rail.cy + Math.sin(a) * stripR);
      }
      g.setColor(COLOR_RAIL_GLOW[0], COLOR_RAIL_GLOW[1], COLOR_RAIL_GLOW[2], 0.12 + 0.35 * glow);
      g.setLineWidth(9 + 10 * glow);
      g.line(points);
      g.setColor(COLOR_RAIL_GLOW[0], COLOR_RAIL_GLOW[1], COLOR_RAIL_GLOW[2], 0.45 + 0.55 * glow);
      g.setLineWidth(2);
      g.line(points);

      g.setLineWidth(3);
      const chevronEnd = rail.loops > 0 ? (rail.radius * Math.PI * 2 - CHEVRON_SPACING * 0.5) : rail.length;
      for (let s = CHEVRON_SPACING * 0.5; s <= chevronEnd; s += CHEVRON_SPACING) {
        const [x, y, dx, dy] = railPoint(rail, s, RAIL_GAP + RAIL_WIDTH * 0.62);
        const pulse = Math.max(0, Math.sin(s / CHEVRON_SPACING * 1.3 - this.time * 6)) ** 3;
        g.setColor(COLOR_RAIL_GLOW[0], COLOR_RAIL_GLOW[1], COLOR_RAIL_GLOW[2], 0.3 + 0.5 * pulse + 0.5 * glow);
        chevron(x, y, dx, dy, 9);
      }
      g.setBlendMode('alpha');

      if (rail.tail) drawLoopTail(this, rail, glow);
    }

    for (const b of this.bumpers) {
      if (!utils.isOnScreen(b.x, b.y, b.radius * 3, 50)) continue;
      const since = b.hitAt != null ? (this.time - b.hitAt) : null;
      g.setBlendMode('add');
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 3 + b.x * 0.01);
      for (let i = 3; i >= 1; i--) {
        g.setColor(1, 0.35, 0.4, (0.05 + 0.03 * pulse) * ((since != null && since < 0.3) ? 3 : 1));
        g.circle('fill', b.x, b.y, b.radius * (1 + i * 0.22));
      }
      if (since != null && since < BUMPER_RING_SECONDS) {
        const k = since / BUMPER_RING_SECONDS;
        g.setColor(1, 0.9, 0.6, 0.9 * (1 - k));
        g.setLineWidth(6 * (1 - k) + 1);
        g.circle('line', b.x, b.y, b.radius * (1.05 + k * 1.2));
      }
      g.setBlendMode('alpha');
      PinballInterior.drawBumper(b.x, b.y, b.radius, since != null ? since * 60 : null);
    }

    for (const coin of this.coins) {
      if (!coin.collected && utils.isOnScreen(coin.pos.x, coin.pos.y, coin.radius, 20)) coin.draw();
    }
    g.setBlendMode('add');
    for (const pop of this.coinPops) {
      const k = pop.t / COIN_POP_SECONDS;
      g.setColor(1, 0.9, 0.4, 0.8 * (1 - k));
      g.setLineWidth(2.5 * (1 - k) + 0.5);
      g.circle('line', pop.x, pop.y, 10 + 26 * k);
    }
    g.setBlendMode('alpha');

    if (this.isExit) this.drawFlipper();

    g.setBlendMode('add');
    for (const p of this.railParticles) {
      const k = p.life / p.maxLife;
      g.setColor(1, 0.75 + 0.2 * k, 0.35, k);
      g.setLineWidth(p.size);
      g.line(p.x, p.y, p.x - p.vx * 0.02, p.y - p.vy * 0.02);
    }
    g.pop();
  }

  drawFlipper() {
    const g = G();
    const [px, py, tx, ty] = this.flipperPose();
    if (!utils.isOnScreen(px, py, FLIPPER_LENGTH + 200, 50)) return;
    const nx = -ty, ny = tx;
    const rp = FLIPPER_THICKNESS / 2, rt = FLIPPER_THICKNESS * 0.3;
    const ex = px + tx * FLIPPER_LENGTH, ey = py + ty * FLIPPER_LENGTH;
    const flash = this.flippedAt != null ? Math.max(0, 1 - (this.time - this.flippedAt) / 0.5) : 0;
    const lit = Math.max(this.flip, flash);

    const shape = (grow) => {
      const a = rp + grow, b = rt + grow;
      g.polygon('fill', px + nx * a, py + ny * a, ex + nx * b, ey + ny * b,
        ex - nx * b, ey - ny * b, px - nx * a, py - ny * a);
      g.circle('fill', px, py, a);
      g.circle('fill', ex, ey, b);
    };

    if (lit > 0.02) {
      g.setBlendMode('add');
      for (let k = 3; k >= 1; k--) {
        g.setColor(COLOR_FLIPPER[0], COLOR_FLIPPER[1], COLOR_FLIPPER[2], 0.12 * lit);
        shape(k * 14);
      }
      g.setBlendMode('alpha');
    }
    g.setColor(COLOR_OUTLINE);
    shape(4);
    const [r, gg, b] = COLOR_FLIPPER;
    const k = 0.7 + 0.3 * lit;
    g.setColor(r * k + flash * 0.3, gg * k + flash * 0.3, b * k + flash * 0.3, 1);
    shape(0);
    g.setColor(COLOR_FLIPPER_LIGHT[0], COLOR_FLIPPER_LIGHT[1], COLOR_FLIPPER_LIGHT[2], 0.55 + 0.4 * lit);
    g.setLineWidth(5);
    g.line(px + nx * rp * 0.45 + tx * rp, py + ny * rp * 0.45 + ty * rp,
      ex + nx * rt * 0.45, ey + ny * rt * 0.45);
    g.setColor(COLOR_OUTLINE);
    g.circle('fill', px, py, rp * 0.55);
    g.setColor(COLOR_BRASS);
    g.circle('fill', px, py, rp * 0.42);
    g.setColor(COLOR_BRASS_LIGHT);
    g.circle('fill', px - rp * 0.12, py - rp * 0.12, rp * 0.16);

    g.setColor(1, 1, 1, 1);
  }

  // The streak behind him in flight. Call before drawing him.
  static drawFlightTrail(player) {
    const flight = player && player.cannonFlight;
    if (!flight || flight.trail.length < 2) return;
    const g = G();
    g.push('all');
    g.setBlendMode('add');
    g.setLineStyle('smooth');
    const n = flight.trail.length;
    for (let i = 0; i < n - 1; i++) {
      const a = flight.trail[i], b = flight.trail[i + 1];
      const k = 1 - i / (n - 1);
      g.setColor(COLOR_FIRE[0], COLOR_FIRE[1], COLOR_FIRE[2], 0.35 * k);
      g.setLineWidth(player.radius * 1.6 * k + 2);
      g.line(a.x, a.y, b.x, b.y);
      g.setColor(1, 0.95, 0.8, 0.6 * k);
      g.setLineWidth(player.radius * 0.5 * k + 1);
      g.line(a.x, a.y, b.x, b.y);
    }

    g.setBlendMode('alpha');
    const ghosts = flight.ghosts ?? [];
    const r = player.radius;
    g.setLineWidth(Math.max(1, r * 0.12 - 1));
    // (Lua index i from #ghosts down to 2 -> 0-based j = i - 1.)
    for (let j = ghosts.length - 1; j >= 1; j--) {
      const gh = ghosts[j];
      const a = AFTERIMAGE_ALPHA * (1 - (j - 1) / AFTERIMAGE_COUNT);
      g.setColor(1, 1, 1, a);
      g.circle('fill', gh.x, gh.y, r);
      g.setColor(0.61, 0.61, 0.61, a);
      g.circle('line', gh.x, gh.y, r);
      g.setColor(0.42, 0.91, 0.92, a);
      g.circle('fill', gh.x, gh.y, r / 3);
    }
    g.pop();
  }

  static drawSpeedLines(player) {
    const g = G();
    const dt = Math.min(love.timer.getDelta(), 1 / 20);
    const [w, h] = g.getDimensions();
    const flight = player && player.cannonFlight;

    let k = 0, dirX = 1, dirY = 0;
    if (flight) {
      const speed = Math.sqrt(player.vel.x ** 2 + player.vel.y ** 2);
      if (speed > 1e-3) { dirX = player.vel.x / speed; dirY = player.vel.y / speed; }
      k = Math.max(0, Math.min(1, (flight.speed - RAIL_SPEED) / (LAUNCH_SPEED - RAIL_SPEED)));
      k = k * k;
    }

    speedLineBudget += SPEED_LINES_PER_SECOND * k * dt;
    while (speedLineBudget >= 1) {
      speedLineBudget -= 1;
      let x, y;
      for (let t = 0; t < 8; t++) {
        x = rnd() * w; y = rnd() * h;
        const ex = (x - w / 2) / (w * 0.3), ey = (y - h / 2) / (h * 0.3);
        if (ex * ex + ey * ey > 1) break;
      }
      speedLines.push({
        x, y, vx: -dirX, vy: -dirY,
        speed: 2200 + rnd() * 1600, length: 70 + rnd() * 120,
        life: SPEED_LINE_SECONDS, strength: k,
      });
    }

    g.push('all');
    g.setBlendMode('add');
    g.setLineStyle('smooth');
    for (let i = speedLines.length - 1; i >= 0; i--) {
      const s = speedLines[i];
      s.life -= dt;
      if (s.life <= 0) {
        speedLines.splice(i, 1);
      } else {
        s.x += s.vx * s.speed * dt;
        s.y += s.vy * s.speed * dt;
        const fade = s.life / SPEED_LINE_SECONDS;
        const a = SPEED_LINE_ALPHA * s.strength * Math.sin(Math.PI * fade);
        g.setColor(0.85, 0.93, 1, a);
        g.setLineWidth(1.5);
        g.line(s.x, s.y, s.x - s.vx * s.length, s.y - s.vy * s.length);
      }
    }
    g.pop();
  }

  // -------------------------------------------------------------------
  // Drawing the cannon
  // -------------------------------------------------------------------

  drawBase() {
    const g = G();
    const art = getCannonArt();
    const c = Math.cos(this.mountAngle), s = Math.sin(this.mountAngle);
    const sx = this.planet.pos.x + c * this.planet.radius, sy = this.planet.pos.y + s * this.planet.radius;
    g.push('all');
    g.translate(sx, sy);
    g.rotate(this.mountAngle + Math.PI / 2);
    g.setColor(1, 1, 1, 1);
    g.draw(art.base);
    g.setColor(COLOR_METAL_OUTLINE);
    g.setLineWidth(2.5);
    g.setLineJoin('bevel');
    g.line(art.baseLine);
    g.pop();
  }

  drawBarrel() {
    const g = G();
    const art = getCannonArt();
    const [px, py] = this.pivot();
    g.push('all');
    g.translate(px, py);
    g.rotate(this.barrelAngle);
    g.translate(-this.recoilOffset(), 0);
    const H = BARREL_HALF_WIDTH;
    g.setColor(COLOR_METAL_OUTLINE);
    g.circle('fill', -BARREL_BACK + H, 0, H + 2);
    g.rectangle('fill', -BARREL_BACK + H, -H - 2, BARREL_LENGTH - 12 + BARREL_BACK - H, (H + 2) * 2);
    g.rectangle('fill', BARREL_LENGTH - 16, -MUZZLE_HALF_WIDTH - 2, 18, (MUZZLE_HALF_WIDTH + 2) * 2, 5, 5);
    g.setColor(1, 1, 1, 1);
    g.draw(art.barrel);
    g.draw(art.lip);
    g.setColor(0.04, 0.04, 0.05, 1);
    g.ellipse('fill', BARREL_LENGTH - 1, 0, 3, MUZZLE_HALF_WIDTH - 5);
    g.pop();
  }

  draw() {
    const g = G();
    g.push('all');
    g.setLineStyle('smooth');

    for (const p of this.particles) {
      if (p.kind === 'smoke') {
        const k = p.life / p.maxLife;
        const r = p.size * (1 + (1 - k) * 2.5);
        g.setColor(0.55, 0.55, 0.58, 0.45 * k);
        g.circle('fill', p.x, p.y, r);
      }
    }

    this.drawBase();
    this.drawBarrel();

    const [mx, my] = this.muzzle();

    const player = state.player;
    if (this.state === 'idle' && player && !player.inCannon) {
      const dx = player.pos.x - mx, dy = player.pos.y - my;
      const near = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / 500);
      if (near > 0) {
        const strength = near * (player.isBall ? 1 : 0.45);
        g.setBlendMode('add');
        g.setLineWidth(2);
        for (let i = 0; i <= 1; i++) {
          const phase = lua.mod(this.time * 0.9 + i * 0.5, 1);
          g.setColor(COLOR_HINT[0], COLOR_HINT[1], COLOR_HINT[2], strength * 0.7 * (1 - phase));
          g.circle('line', mx, my, CAPTURE_RADIUS * (0.6 + phase * 0.9));
        }
        g.setBlendMode('alpha');
      }
    }

    if (this.state === 'charging') {
      const k = smoothstep(this.timer / (CHARGE_SECONDS * 0.4));
      const c = Math.cos(this.barrelAngle), s = Math.sin(this.barrelAngle);
      g.setBlendMode('add');
      const spacing = 30;
      const offset = lua.mod(this.time * 160, spacing);
      for (let d = offset + 20; d <= AIM_LINE_LENGTH; d += spacing) {
        const a = k * 0.8 * (1 - d / AIM_LINE_LENGTH);
        g.setColor(COLOR_FIRE[0], COLOR_FIRE[1], COLOR_FIRE[2], a);
        g.circle('fill', mx + c * d, my + s * d, 2.6);
      }
      const gl = smoothstep(this.timer / CHARGE_SECONDS);
      for (let i = 3; i >= 1; i--) {
        g.setColor(COLOR_FIRE[0], COLOR_FIRE[1], COLOR_FIRE[2], 0.12 * gl);
        g.circle('fill', mx, my, 10 + i * 9 * gl);
      }
      g.setBlendMode('alpha');
    }

    g.setBlendMode('add');
    for (const p of this.particles) {
      if (p.kind === 'spark') {
        const k = p.life / p.maxLife;
        g.setColor(1, 0.75 + 0.2 * k, 0.35, k);
        g.setLineWidth(p.size);
        g.line(p.x, p.y, p.x - p.vx * 0.025, p.y - p.vy * 0.025);
      }
    }
    if (this.flashTimer != null) {
      const k = this.flashTimer / 0.18;
      const c = Math.cos(this.barrelAngle), s = Math.sin(this.barrelAngle);
      for (let i = 4; i >= 1; i--) {
        g.setColor(1, 0.85, 0.5, 0.18 * k);
        g.circle('fill', mx + c * 20, my + s * 20, 18 * i * (0.6 + 0.4 * k));
      }
      g.setColor(1, 1, 0.9, k);
      g.circle('fill', mx + c * 8, my + s * 8, 16 * k);
    }
    g.pop();
  }
}

// ---------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------

function updateParticleList(list, dt) {
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    p.life -= dt;
    if (p.life <= 0) {
      list.splice(i, 1);
    } else {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const drag = p.kind === 'smoke' ? 2.2 : 1.2;
      p.vx *= Math.exp(-drag * dt);
      p.vy *= Math.exp(-drag * dt);
    }
  }
}

function crashLanding(player) {
  const planet = player.currentPlanet;
  let ux = 0, uy = -1;
  if (planet && !planet.isRoundedRect) {
    const dx = player.pos.x - planet.pos.x, dy = player.pos.y - planet.pos.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 0) { ux = dx / d; uy = dy / d; }
  } else if (planet && planet.nearestSurfacePoint) {
    const n = planet.nearestSurfacePoint(player.pos.x, player.pos.y).normal;
    ux = n.x; uy = n.y;
  }
  const x = player.pos.x - ux * player.radius, y = player.pos.y - uy * player.radius;
  const up = Vector2.new(ux, uy);
  GroundPoundBurst.spawn(x, y, up, CRASH_BURST_SCALE);
  GroundPoundBurst.spawn(x, y, up, CRASH_INNER_BURST_SCALE);
  CameraShake.start(CRASH_SHAKE_STRENGTH, CRASH_SHAKE_SECONDS);
  if (state.audioManager) {
    state.audioManager.playGroundPound();
    state.audioManager.playBang('medium', Vector2.new(x, y));
  }
}

function railSparks(cannon, rail, s, player, riding) {
  const [cx, cy, dx, dy] = railPoint(rail, s, player.radius);
  for (let k = 0; k < 3; k++) {
    const back = 0.15 + rnd() * 0.35;
    const outward = (rnd() - 0.3) * 0.6;
    const ox = (cx - rail.cx) / rail.radius, oy = (cy - rail.cy) / rail.radius;
    const speed = riding * 60 * back;
    const life = 0.2 + rnd() * 0.3;
    cannon.railParticles.push({
      kind: 'spark', x: cx, y: cy,
      vx: -dx * speed + ox * speed * outward, vy: -dy * speed + oy * speed * outward,
      life, maxLife: life, size: 1.4 + rnd(),
    });
  }
}

// Just an ordinary field planetoid (a plain Planetoid with no draw of its own)?
function isMundane(p, target) {
  return p !== target && p.constructor === Planetoid && !Object.prototype.hasOwnProperty.call(p, 'draw')
    && !p.isPermanent && !p.isImmovable && !p.isWaterPlanet;
}

function blowUp(thing) {
  state.explosions = state.explosions ?? [];
  const bursts = Math.max(1, Math.floor(thing.radius / 25));
  for (let k = 1; k <= bursts; k++) {
    const a = rnd() * Math.PI * 2, d = (k === 1) ? 0 : rnd() * thing.radius * 0.7;
    state.explosions.push(Explosion.new(thing.pos.x + Math.cos(a) * d, thing.pos.y + Math.sin(a) * d));
  }
  CameraShake.start(OBSTACLE_SHAKE_STRENGTH, OBSTACLE_SHAKE_SECONDS);
  if (state.audioManager) state.audioManager.playBang('large', Vector2.new(thing.pos.x, thing.pos.y));
}

function clearTheWay(player, flight, ts) {
  const from = player.prevPos ?? player.pos;
  const ax = from.x, ay = from.y;
  const bx = player.pos.x + player.vel.x * ts, by = player.pos.y + player.vel.y * ts;
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const inTheWay = (thing) => {
    const t = lenSq > 0 ? Math.max(0, Math.min(1, ((thing.pos.x - ax) * dx + (thing.pos.y - ay) * dy) / lenSq)) : 0;
    const reach = thing.radius + player.radius;
    return (thing.pos.x - (ax + dx * t)) ** 2 + (thing.pos.y - (ay + dy * t)) ** 2 <= reach * reach;
  };

  for (let i = state.planetoids.length - 1; i >= 0; i--) {
    const p = state.planetoids[i];
    if (isMundane(p, flight.target) && inTheWay(p)) {
      state.planetoids.splice(i, 1);
      const coins = state.coins ?? [];
      for (let k = coins.length - 1; k >= 0; k--) {
        if (coins[k].planet === p) coins.splice(k, 1);
      }
      if (player.lockedTarget === p) player.lockedTarget = null;
      if (player.lastInfluencePlanet === p) player.lastInfluencePlanet = null;
      blowUp(p);
    }
  }
  const asteroids = state.asteroids ?? [];
  for (let i = asteroids.length - 1; i >= 0; i--) {
    const a = asteroids[i];
    if (inTheWay(a)) {
      asteroids.splice(i, 1);
      if (player.lockedTarget === a) player.lockedTarget = null;
      blowUp(a);
    }
  }
}

let gauntletRocks = [];

function spawnGauntlet(piece) {
  const len = Math.sqrt((piece.to[0] - piece.from[0]) ** 2 + (piece.to[1] - piece.from[1]) ** 2);
  const nx = -piece.dir[1], ny = piece.dir[0];
  state.asteroids = state.asteroids ?? [];
  for (let d = GAUNTLET_END_MARGIN; d <= len - GAUNTLET_END_MARGIN; d += GAUNTLET_SPACING) {
    const radius = GAUNTLET_MIN_RADIUS + rnd() * (GAUNTLET_MAX_RADIUS - GAUNTLET_MIN_RADIUS);
    const side = (rnd() * 2 - 1) * radius * GAUNTLET_SIDE_NUDGE;
    const rock = Asteroid.new(piece.from[0] + piece.dir[0] * d + nx * side, piece.from[1] + piece.dir[1] * d + ny * side, radius);
    rock.vel = Vector2.new(0, 0);
    rock.isGauntlet = true;
    state.asteroids.push(rock);
    gauntletRocks.push(rock);
  }
}

function clearGauntlet() {
  if (gauntletRocks.length === 0) return;
  const mine = new Set(gauntletRocks);
  const asteroids = state.asteroids ?? [];
  for (let i = asteroids.length - 1; i >= 0; i--) {
    if (mine.has(asteroids[i])) asteroids.splice(i, 1);
  }
  gauntletRocks = [];
}

function placeOnRail(player, rail, s, speed) {
  const [x, y, dx, dy] = railPoint(rail, s, 0);
  player.pos.x = x; player.pos.y = y;
  player.vel.x = dx * speed; player.vel.y = dy * speed;
}

// The piece after piece `i` (0-based) — round to the first again on a
// closed loop; null past the end of an open route.
function nextPieceIndex(track, i) {
  if (i < track.pieces.length - 1) return i + 1;
  if (track.closed) return 0;
  return null;
}

// A rail's track mesh, built once.
function railMesh(rail) {
  if (rail.mesh) return rail.mesh;
  const g = G();
  const inner = rail.radius + RAIL_GAP;
  const outer = inner + RAIL_WIDTH;
  let a0 = rail.phi0 - rail.sign * RAIL_OVERHANG;
  let span = rail.sweep + RAIL_OVERHANG * 2;
  if (rail.loops > 0) { a0 = rail.phi0; span = Math.PI * 2; }
  const steps = Math.max(8, Math.ceil(span * RAIL_SEGMENTS_PER_RADIAN));
  const l = COLOR_STEEL_LIGHT, m = COLOR_STEEL, d = COLOR_STEEL_DARK;
  const verts = [], back = [];
  const edgeIn = [], edgeOut = [];
  const midR = inner + RAIL_WIDTH * 0.45;
  for (let i = 0; i <= steps; i++) {
    const a = a0 + rail.sign * span * i / steps;
    const c = Math.cos(a), s = Math.sin(a);
    verts.push([rail.cx + c * inner, rail.cy + s * inner, 0, 0, l[0], l[1], l[2], 1]);
    verts.push([rail.cx + c * midR, rail.cy + s * midR, 0, 0, m[0], m[1], m[2], 1]);
    back.push([rail.cx + c * midR, rail.cy + s * midR, 0, 0, m[0], m[1], m[2], 1]);
    back.push([rail.cx + c * outer, rail.cy + s * outer, 0, 0, d[0], d[1], d[2], 1]);
    edgeIn.push(rail.cx + c * (inner - 1.5), rail.cy + s * (inner - 1.5));
    edgeOut.push(rail.cx + c * (outer + 1.5), rail.cy + s * (outer + 1.5));
  }
  rail.mesh = g.newMesh(verts, 'strip', 'static');
  rail.backMesh = g.newMesh(back, 'strip', 'static');
  rail.edgeIn = edgeIn;
  rail.edgeOut = edgeOut;
  rail.drawStart = a0;
  rail.drawSpan = span;
  return rail.mesh;
}

// One chevron, pointing (dx, dy), centred on (x, y).
function chevron(x, y, dx, dy, size) {
  const nx = -dy, ny = dx;
  G().line(
    x - dx * size * 0.5 + nx * size * 0.6, y - dy * size * 0.5 + ny * size * 0.6,
    x + dx * size * 0.5, y + dy * size * 0.5,
    x - dx * size * 0.5 - nx * size * 0.6, y - dy * size * 0.5 - ny * size * 0.6);
}

// A loop's tail: a straight run of the same track through the bottom
// of its ring.
function drawLoopTail(cannon, rail, glow) {
  const g = G();
  const tx = rail.entry[0], ty = rail.entry[1];
  const dx = rail.inDir[0], dy = rail.inDir[1];
  const ox = (tx - rail.cx) / rail.radius, oy = (ty - rail.cy) / rail.radius;
  const inner = RAIL_GAP, mid = RAIL_GAP + RAIL_WIDTH * 0.45, outer = RAIL_GAP + RAIL_WIDTH;
  const ax = tx - dx * rail.tail, ay = ty - dy * rail.tail;
  const bx = tx + dx * rail.tail, by = ty + dy * rail.tail;
  const at = (x, y, off) => [x + ox * off, y + oy * off];

  if (!rail.tailMesh) {
    const l = COLOR_STEEL_LIGHT, m = COLOR_STEEL, d = COLOR_STEEL_DARK;
    const [a1x, a1y] = at(ax, ay, inner);
    const [b1x, b1y] = at(bx, by, inner);
    const [a2x, a2y] = at(ax, ay, mid);
    const [b2x, b2y] = at(bx, by, mid);
    const [a3x, a3y] = at(ax, ay, outer);
    const [b3x, b3y] = at(bx, by, outer);
    rail.tailMesh = g.newMesh([
      [a1x, a1y, 0, 0, l[0], l[1], l[2], 1], [b1x, b1y, 0, 0, l[0], l[1], l[2], 1],
      [a2x, a2y, 0, 0, m[0], m[1], m[2], 1], [b2x, b2y, 0, 0, m[0], m[1], m[2], 1],
      [a3x, a3y, 0, 0, d[0], d[1], d[2], 1], [b3x, b3y, 0, 0, d[0], d[1], d[2], 1],
    ], 'triangles', 'static');
    // (0-based: Lua's 1,2,4, 1,4,3, 3,4,6, 3,6,5.)
    rail.tailMesh.setVertexMap(0, 1, 3, 0, 3, 2, 2, 3, 5, 2, 5, 4);
  }

  g.setColor(COLOR_OUTLINE);
  g.setLineWidth(3);
  let [x1, y1] = at(ax, ay, inner - 1.5);
  let [x2, y2] = at(bx, by, inner - 1.5);
  g.line(x1, y1, x2, y2);
  [x1, y1] = at(ax, ay, outer + 1.5);
  [x2, y2] = at(bx, by, outer + 1.5);
  g.line(x1, y1, x2, y2);
  g.setColor(1, 1, 1, 1);
  g.draw(rail.tailMesh);

  for (const e of [[ax, ay], [bx, by]]) {
    const [cx0, cy0] = at(e[0], e[1], inner - 2);
    const [cx1, cy1] = at(e[0], e[1], outer + 2);
    g.setColor(COLOR_OUTLINE);
    g.setLineWidth(9);
    g.line(cx0, cy0, cx1, cy1);
    g.setColor(COLOR_BRASS);
    g.setLineWidth(6);
    g.line(cx0, cy0, cx1, cy1);
    const [bxx, byy] = at(e[0], e[1], outer + 9);
    const blink = (Math.sin(cannon.time * 5 + e[0] * 0.01) > 0.3) ? 1 : 0.25;
    g.setColor(COLOR_OUTLINE);
    g.circle('fill', bxx, byy, 5.5);
    g.setBlendMode('add');
    g.setColor(COLOR_RAIL_GLOW[0], COLOR_RAIL_GLOW[1], COLOR_RAIL_GLOW[2], 0.25 * blink);
    g.circle('fill', bxx, byy, 14);
    g.setColor(COLOR_RAIL_GLOW[0], COLOR_RAIL_GLOW[1], COLOR_RAIL_GLOW[2], blink);
    g.circle('fill', bxx, byy, 3.5);
    g.setBlendMode('alpha');
  }

  g.setBlendMode('add');
  const [sx1, sy1] = at(ax, ay, inner + RAIL_WIDTH * 0.3);
  const [sx2, sy2] = at(bx, by, inner + RAIL_WIDTH * 0.3);
  g.setColor(COLOR_RAIL_GLOW[0], COLOR_RAIL_GLOW[1], COLOR_RAIL_GLOW[2], 0.12 + 0.35 * glow);
  g.setLineWidth(9 + 10 * glow);
  g.line(sx1, sy1, sx2, sy2);
  g.setColor(COLOR_RAIL_GLOW[0], COLOR_RAIL_GLOW[1], COLOR_RAIL_GLOW[2], 0.45 + 0.55 * glow);
  g.setLineWidth(2);
  g.line(sx1, sy1, sx2, sy2);
  g.setLineWidth(3);
  for (let s = -rail.tail + CHEVRON_SPACING * 0.5; s <= rail.tail; s += CHEVRON_SPACING) {
    const [cx, cy] = at(tx + dx * s, ty + dy * s, inner + RAIL_WIDTH * 0.62);
    const pulse = Math.max(0, Math.sin(s / CHEVRON_SPACING * 1.3 - cannon.time * 6)) ** 3;
    g.setColor(COLOR_RAIL_GLOW[0], COLOR_RAIL_GLOW[1], COLOR_RAIL_GLOW[2], 0.3 + 0.5 * pulse + 0.5 * glow);
    chevron(cx, cy, dx, dy, 9);
  }
  g.setBlendMode('alpha');
}

// Speed-line state.
const speedLines = [];
let speedLineBudget = 0;

// PLACEHOLDER ART: a simple brushed-metal cannon.
const METAL_BANDS = [
  [-1.0, 0.22], [-0.75, 0.55], [-0.4, 0.92], [-0.25, 0.8],
  [0.1, 0.5], [0.6, 0.34], [1.0, 0.16],
];
const METAL_TINT = [0.78, 0.82, 0.9];
const METAL_SLICES = 18;

function metalShade(u) {
  for (let i = 0; i < METAL_BANDS.length - 1; i++) {
    const a = METAL_BANDS[i], b = METAL_BANDS[i + 1];
    if (u <= b[0]) {
      const t = (u - a[0]) / (b[0] - a[0]);
      const v = a[1] + (b[1] - a[1]) * t;
      return [METAL_TINT[0] * v, METAL_TINT[1] * v, METAL_TINT[2] * v];
    }
  }
  const v = METAL_BANDS[METAL_BANDS.length - 1][1];
  return [METAL_TINT[0] * v, METAL_TINT[1] * v, METAL_TINT[2] * v];
}

function metalStrip(span) {
  const verts = [];
  for (let i = 0; i <= METAL_SLICES; i++) {
    const u = -1 + 2 * i / METAL_SLICES;
    const [x0, y0, x1, y1] = span(u);
    const [r, g, b] = metalShade(u);
    verts.push([x0, y0, 0, 0, r, g, b, 1]);
    verts.push([x1, y1, 0, 0, r, g, b, 1]);
  }
  return G().newMesh(verts, 'strip', 'static');
}

let cannonArt = null;
function getCannonArt() {
  if (cannonArt) return cannonArt;
  cannonArt = {};
  const H = BARREL_HALF_WIDTH, back = -BARREL_BACK;
  cannonArt.barrel = metalStrip((u) => {
    const y = u * H;
    return [back + H - Math.sqrt(Math.max(0, H * H - y * y)), y, BARREL_LENGTH - 12, y];
  });
  const M = MUZZLE_HALF_WIDTH;
  cannonArt.lip = metalStrip((u) => {
    const y = u * M;
    const round = Math.max(0, Math.abs(y) - (M - 4));
    const cut = 4 - Math.sqrt(Math.max(0, 16 - round * round));
    return [BARREL_LENGTH - 14 + cut, y, BARREL_LENGTH - cut, y];
  });
  const W = BASE_HALF_WIDTH, top = PIVOT_HEIGHT + 8;
  cannonArt.base = metalStrip((u) => {
    const x = u * W;
    return [x, 4, x, -top * Math.sqrt(Math.max(0, 1 - u * u))];
  });
  const baseLine = [];
  for (let i = 0; i <= 24; i++) {
    const u = -1 + 2 * i / 24;
    baseLine.push(u * W, -top * Math.sqrt(Math.max(0, 1 - u * u)));
  }
  cannonArt.baseLine = baseLine;
  return cannonArt;
}

const COLOR_METAL_OUTLINE = [0.08, 0.09, 0.11];

export default Cannon;
