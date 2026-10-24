// js/systems/PortalGun.js
//
// Portal mode (one of the modes P cycles through — see WeaponModes.js):
// the blaster shoots portals instead of fireballs/pull beams. Left click /
// L2 makes the red portal, right click / R2 the blue one. A shot is
// hitscan: a ray from the muzzle along the aim, stopping at the first
// solid surface, where the portal is placed flat against it. One portal
// of each color; a new one replaces the old.
//
// Portals stick to whatever they landed on and vanish if it's removed.
// With both up, Bob (and Ooombas, fireballs, water droplets) go in one
// and come out the other, Portal style.
//
// Port notes: surface functions (surfaceOf, wallSurfaceOf) return
// [dist, sx, sy, nx, ny]; raycast returns [hit, traveled]; passPoint /
// throughPortal return [x, y, vx, vy, exitPortal] or null.

import love from '../love/index.js';
import lua from '../love/lua.js';
import state from '../state.js';
import constants from '../constants.js';
import SilhouetteGlow from '../effects/SilhouetteGlow.js';
import Vector2 from '../vector2.js';

const PortalGun = {};
const rnd = () => lua.random();

// ---------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------

const MAX_RANGE = 2500;
const HIT_DISTANCE = 2;
const MIN_STEP = 1.5, MAX_STEP = 24;
const SHOT_COOLDOWN = 0.2;

const PORTAL_HALF_LENGTH = 70;
const PORTAL_SURFACE_OFFSET = 3;

const TRACER_LIFE = 0.18;
const PARTICLES_PER_SECOND = 45;
const PARTICLE_LIFE_MIN = 0.6, PARTICLE_LIFE_RANGE = 0.6;
const PARTICLE_SPEED_MIN = 30, PARTICLE_SPEED_RANGE = 50;

const MOUTH_POINTS = 24;
const CURTAIN_HEIGHT = 75;
const SHAFT_COUNT = 9;
const SHAFT_LENGTH_MIN = 55, SHAFT_LENGTH_RANGE = 120;
const SHAFT_WIDTH_MIN = 5, SHAFT_WIDTH_RANGE = 12;
const SHAFT_LIFE_MIN = 0.9, SHAFT_LIFE_RANGE = 1.4;

const AFTERGLOW_SECONDS = 0.8;
const AFTERGLOW_STRENGTH = 0.9;
const AFTERGLOW_REACH = 14;
const AFTERGLOW_MOTES_PER_SECOND = 40;
const AFTERGLOW_MOTE_LIFE_MIN = 0.4, AFTERGLOW_MOTE_LIFE_RANGE = 0.5;
const AFTERGLOW_MOTE_SPEED_MIN = 10, AFTERGLOW_MOTE_SPEED_RANGE = 30;

const COLORS = {
  red: { core: [1.00, 0.30, 0.22], glow: [1.00, 0.45, 0.25], bright: [1.00, 0.85, 0.75] },
  blue: { core: [0.20, 0.55, 1.00], glow: [0.35, 0.70, 1.00], bright: [0.80, 0.92, 1.00] },
};

// ---------------------------------------------------------------------
// Surfaces: each returns [distance, px, py, nx, ny]
// ---------------------------------------------------------------------

function circleSurface(p, x, y) {
  let dx = x - p.pos.x, dy = y - p.pos.y;
  let len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) { dx = 0; dy = -1; len = 1; }
  const nx = dx / len, ny = dy / len;
  return [len - p.radius, p.pos.x + nx * p.radius, p.pos.y + ny * p.radius, nx, ny];
}

function nearestToSurface(near) {
  return [near.distance, near.point.x, near.point.y, near.normal.x, near.normal.y];
}

// The dome: glass (upper half of the big ellipse), floor, and base.
function domeSurface(d, x, y) {
  let best = [Infinity, x, y, 0, -1];
  const anchorY = d.domeAnchorY();

  const topY = d.trueSurfaceY();
  const minX = d.pos.x - d.halfWidth, maxX = d.pos.x + d.halfWidth;
  const fx = Math.max(minX, Math.min(maxX, x));
  const fd = Math.sqrt((x - fx) ** 2 + (y - topY) ** 2);
  if (fd < best[0]) best = [fd, fx, topY, 0, -1];

  if (y <= anchorY) {
    const g = d.nearestDomeSurfacePoint(x, y);
    if (g.distance < best[0]) best = nearestToSurface(g);
  } else {
    const b = d.nearestBaseSurfacePoint(x, y);
    if (b.distance < best[0]) best = nearestToSurface(b);
  }
  return best;
}

function planetoidSurface(p, x, y) {
  if (p.isSkyDome) return domeSurface(p, x, y);
  if (p.isRoundedRect) return nearestToSurface(p.nearestSurfacePoint(x, y));
  return circleSurface(p, x, y);
}

function wallSurface(w, x, y) {
  const minX = w.pos.x - w.halfWidth, maxX = w.pos.x + w.halfWidth;
  const minY = w.pos.y - w.halfHeight, maxY = w.pos.y + w.halfHeight;
  const cx = Math.max(minX, Math.min(maxX, x));
  const cy = Math.max(minY, Math.min(maxY, y));
  const dx = x - cx, dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  let nx, ny;
  if (Math.abs(dx) >= Math.abs(dy)) { nx = dx >= 0 ? 1 : -1; ny = 0; } else { nx = 0; ny = dy >= 0 ? 1 : -1; }
  return [dist, cx, cy, nx, ny];
}

// ---------------------------------------------------------------------
// Raycast
// ---------------------------------------------------------------------

function distToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  let t = ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby);
  t = Math.max(0, Math.min(1, t));
  const cx = ax + abx * t, cy = ay + aby * t;
  return Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
}

function gatherCandidates(ox, oy, ex, ey) {
  const list = [];
  for (const p of (state.planetoids ?? [])) {
    if (p.isWaterPlanet) continue;
    let cx = p.pos.x, cy = p.pos.y, r;
    if (p.isSkyDome) {
      cy = p.domeAnchorY();
      r = Math.max(p.domeRadiusX ?? 0, p.domeRadiusY ?? 0, p.halfWidth ?? 0) + 50;
    } else if (p.isRoundedRect && p.halfWidth) {
      r = Math.sqrt(p.halfWidth ** 2 + p.halfHeight ** 2) + 50;
    } else {
      r = (p.radius ?? 0) + 50;
    }
    if (distToSegment(cx, cy, ox, oy, ex, ey) <= r) {
      list.push({ obj: p, surface: planetoidSurface, oneWay: p.isOpenPath });
    }
  }
  for (const level of (state.tiledLevels ?? [])) {
    for (const w of (level.walls ?? [])) {
      if (w.isWall || (w.isGate && w.halfHeight > 1)) {
        const r = Math.sqrt(w.halfWidth ** 2 + w.halfHeight ** 2) + 50;
        if (distToSegment(w.pos.x, w.pos.y, ox, oy, ex, ey) <= r) {
          list.push({ obj: w, surface: wallSurface });
        }
      }
    }
  }
  return list;
}

// First surface along the ray. -> [hit {x, y, nx, ny, obj} | null, traveled]
PortalGun.raycast = function (ox, oy, dx, dy, maxRange) {
  maxRange = maxRange ?? MAX_RANGE;
  const candidates = gatherCandidates(ox, oy, ox + dx * maxRange, oy + dy * maxRange);
  let traveled = 0;
  while (traveled <= maxRange) {
    const x = ox + dx * traveled, y = oy + dy * traveled;
    let nearest = Infinity, hit = null;
    for (const c of candidates) {
      let [dist, sx, sy, nx, ny] = c.surface(c.obj, x, y);
      if (c.oneWay && nx * dx + ny * dy >= 0) dist = Infinity;
      if (dist < nearest) {
        nearest = dist;
        if (dist <= HIT_DISTANCE) hit = { x: sx, y: sy, nx, ny, obj: c.obj };
      }
    }
    if (hit) {
      if (hit.nx * dx + hit.ny * dy > 0) { hit.nx = -hit.nx; hit.ny = -hit.ny; }
      return [hit, traveled];
    }
    traveled += Math.max(MIN_STEP, Math.min(MAX_STEP, nearest));
  }
  return [null, maxRange];
};

// ---------------------------------------------------------------------
// Portals
// ---------------------------------------------------------------------

function toLocal(obj, x, y, nx, ny) {
  const a = obj.rotationAngle ?? 0;
  const c = Math.cos(-a), s = Math.sin(-a);
  const dx = x - obj.pos.x, dy = y - obj.pos.y;
  return [dx * c - dy * s, dx * s + dy * c, nx * c - ny * s, nx * s + ny * c];
}

function refreshWorldPlacement(portal) {
  const obj = portal.obj;
  const a = obj.rotationAngle ?? 0;
  const c = Math.cos(a), s = Math.sin(a);
  const lx = portal.localX, ly = portal.localY, lnx = portal.localNX, lny = portal.localNY;
  portal.x = obj.pos.x + lx * c - ly * s;
  portal.y = obj.pos.y + lx * s + ly * c;
  portal.nx = lnx * c - lny * s;
  portal.ny = lnx * s + lny * c;
  portal.mouth = portal.mouth ?? [];
  portal.mouthLocal.forEach((m, i) => {
    const w = portal.mouth[i] ?? {};
    w.x = obj.pos.x + m.x * c - m.y * s;
    w.y = obj.pos.y + m.x * s + m.y * c;
    w.nx = m.nx * c - m.ny * s;
    w.ny = m.nx * s + m.ny * c;
    portal.mouth[i] = w;
  });
}

function buildMouth(hit) {
  const obj = hit.obj;
  const tx = -hit.ny, ty = hit.nx;
  const points = [];
  const isCircle = !(obj.isWall || obj.isGate || obj.isRoundedRect || obj.isSkyDome) && obj.radius;
  if (isCircle) {
    const cx = obj.pos.x, cy = obj.pos.y, R = obj.radius;
    const mid = Math.atan2(hit.y - cy, hit.x - cx);
    const half = Math.min(PORTAL_HALF_LENGTH / R, Math.PI * 0.85);
    const dir = ((-Math.sin(mid)) * tx + Math.cos(mid) * ty) >= 0 ? 1 : -1;
    const side = ((hit.x - cx) * hit.nx + (hit.y - cy) * hit.ny) >= 0 ? 1 : -1;
    for (let i = 0; i <= MOUTH_POINTS; i++) {
      const a = mid + dir * half * (2 * i / MOUTH_POINTS - 1);
      const ox = Math.cos(a), oy = Math.sin(a);
      points.push({ x: cx + ox * R, y: cy + oy * R, nx: ox * side, ny: oy * side });
    }
  } else {
    for (let i = 0; i <= MOUTH_POINTS; i++) {
      const t = PORTAL_HALF_LENGTH * (2 * i / MOUTH_POINTS - 1);
      const px = hit.x + tx * t, py = hit.y + ty * t;
      let x = px, y = py, nx = hit.nx, ny = hit.ny;
      if (!(obj.isWall || obj.isGate)) {
        let [dist, sx, sy, snx, sny] = planetoidSurface(obj, px + hit.nx * 4, py + hit.ny * 4);
        if (dist < 40) {
          if (snx * hit.nx + sny * hit.ny < 0) { snx = -snx; sny = -sny; }
          x = sx; y = sy; nx = snx; ny = sny;
        }
      }
      points.push({ x, y, nx, ny });
    }
  }
  return points;
}

function isStillInWorld(portal) {
  const obj = portal.obj;
  if (obj.isWall) return true;
  if (obj.isGate) return obj.slideProgress === portal.gateProgress;
  return (state.planetoids ?? []).includes(obj);
}

function placePortal(color, hit) {
  state.portals = state.portals ?? {};
  const [lx, ly, lnx, lny] = toLocal(hit.obj, hit.x, hit.y, hit.nx, hit.ny);
  const mouthLocal = buildMouth(hit).map((m) => {
    const [mx, my, mnx, mny] = toLocal(hit.obj, m.x, m.y, m.nx, m.ny);
    return { x: mx, y: my, nx: mnx, ny: mny };
  });
  const portal = {
    color, obj: hit.obj,
    localX: lx, localY: ly, localNX: lnx, localNY: lny,
    mouthLocal,
    particles: [], particleBudget: 0, age: 0, shafts: [],
    gateProgress: hit.obj.isGate ? hit.obj.slideProgress : null,
  };
  refreshWorldPlacement(portal);
  state.portals[color] = portal;
}

// color: "red" or "blue".
PortalGun.fire = function (player, color) {
  if (!player || (player.mode !== 'space' && player.mode !== 'platform')) return;
  if (player.isBall || player.isTeleporting || player.isDying || state.vatsActive) return;

  const now = love.timer.getTime();
  if (now - (PortalGun.lastShotTime ?? 0) < SHOT_COOLDOWN) return;
  PortalGun.lastShotTime = now;

  const angle = (player.aimWorldAngle ?? 0) + (player.blasterAngleOffset ?? 0);
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const [ox, oy] = player.getMuzzlePosition();
  const [hit, traveled] = PortalGun.raycast(ox, oy, dx, dy);

  state.portalTracers = state.portalTracers ?? [];
  state.portalTracers.push({
    color, x1: ox, y1: oy,
    x2: hit ? hit.x : ox + dx * traveled, y2: hit ? hit.y : oy + dy * traveled,
    life: TRACER_LIFE, missed: !hit,
  });
  if (hit) placePortal(color, hit);
};

// ---------------------------------------------------------------------
// Going through
// ---------------------------------------------------------------------

const ENTER_REACH = 4;
const ENTER_MIN_INWARD_SPEED = 0.5;
const ENTER_STEP_SPEED = 4;
const TRANSIT_MIN_SPEED = 2;
const TRANSIT_MAX_SPEED = 25;
const HEAD_DRAW_PAD = 10;
const EXIT_UPRIGHT_RATE = 0.12;
const CENTERING_SPEED = 6;

const tangentOf = (portal) => [-portal.ny, portal.nx];

function otherPortal(color) {
  const portals = state.portals;
  if (!portals) return null;
  return portals[color === 'red' ? 'blue' : 'red'] ?? null;
}

// -> [x, y]
function mapPoint(from, to, along, out) {
  const [ttx, tty] = tangentOf(to);
  return [to.x - ttx * along - to.nx * out, to.y - tty * along - to.ny * out];
}

function linkRotation(from, to) {
  return Math.atan2(to.ny, to.nx) - Math.atan2(from.ny, from.nx) + Math.PI;
}

function carryThrough(tr, x, y) {
  const from = tr.from;
  const [tx, ty] = tangentOf(from);
  const rx = x - from.x, ry = y - from.y;
  return mapPoint(from, tr.to, rx * tx + ry * ty, rx * from.nx + ry * from.ny);
}

function rotate(x, y, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

function gravityAt(portal, offset, influence) {
  const x = portal.x + portal.nx * offset, y = portal.y + portal.ny * offset;
  const gs = state.gravitySystem;
  const dominant = gs && gs.findDominantPlanet(Vector2.new(x, y), influence);
  if (!dominant) return Vector2.new(0, 0);
  let dx, dy;
  if (dominant.isRoundedRect && dominant.nearestSurfacePoint) {
    const surface = dominant.nearestSurfacePoint(x, y);
    if (surface.distance > 1e-6) { dx = surface.point.x - x; dy = surface.point.y - y; }
    else { dx = -surface.normal.x; dy = -surface.normal.y; }
  } else {
    dx = dominant.pos.x - x; dy = dominant.pos.y - y;
  }
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) return Vector2.new(0, 0);
  const strength = dominant.gravityStrength ?? constants.GRAVITY_STRENGTH;
  return Vector2.new(dx / len * strength, dy / len * strength);
}

function beginTrip(color, along, out, speed, alongSpeed, down, trail, offset, influence) {
  const from = state.portals[color], to = otherPortal(color);
  return {
    from, to, along, out,
    speed: Math.min(TRANSIT_MAX_SPEED, Math.max(ENTER_STEP_SPEED, speed)),
    alongSpeed, down, trail,
    entryGravity: gravityAt(from, offset, influence),
    exitGravity: gravityAt(to, offset, influence),
  };
}

// One frame along the trip. -> [x, y, through]
function advanceTrip(tr, ts, halfWidth) {
  let g, axisX, axisY;
  if (tr.out > 0) { g = tr.entryGravity; axisX = -tr.from.nx; axisY = -tr.from.ny; }
  else { g = tr.exitGravity; axisX = tr.to.nx; axisY = tr.to.ny; }
  tr.speed += (g.x * axisX + g.y * axisY) * ts;
  tr.speed = Math.max(TRANSIT_MIN_SPEED, Math.min(TRANSIT_MAX_SPEED, tr.speed));
  tr.out -= tr.speed * ts;
  const fit = Math.max(0, PORTAL_HALF_LENGTH - halfWidth);
  const target = Math.max(-fit, Math.min(fit, tr.along));
  tr.along += Math.max(-CENTERING_SPEED * ts, Math.min(CENTERING_SPEED * ts, target - tr.along));

  const from = tr.from;
  const [tx, ty] = tangentOf(from);
  return [from.x + tx * tr.along + from.nx * tr.out, from.y + ty * tr.along + from.ny * tr.out,
    tr.out <= -tr.trail];
}

function startAfterglow(thing, portal) {
  const glow = thing.portalGlow ?? { moteBudget: 0, motes: [] };
  glow.color = COLORS[portal.color].glow;
  glow.timer = AFTERGLOW_SECONDS;
  thing.portalGlow = glow;
}

// -> [x, y, vx, vy, down]
function finishTrip(tr) {
  const from = tr.from, to = tr.to;
  const [x, y] = mapPoint(from, to, tr.along, tr.out);
  const [ttx, tty] = tangentOf(to);
  const vx = to.nx * tr.speed - ttx * tr.alongSpeed;
  const vy = to.ny * tr.speed - tty * tr.alongSpeed;
  const [dx, dy] = rotate(tr.down.x, tr.down.y, linkRotation(from, to));
  return [x, y, vx, vy, Vector2.new(dx, dy)];
}

function bodyReach(player, down, dx, dy, headPad) {
  const r = player.radius;
  const head = Math.max(r, (player.isBall ? r : (player.headReach ?? r)) + (headPad ?? 0));
  const upward = Math.max(0, -(down.x * dx + down.y * dy));
  return r + (head - r) * upward;
}

function canTravel(player) {
  return !(player.inPinball || player.isTeleporting || player.isDying || player.morphState
    || state.titleScreen || state.introLocked);
}

// Once a frame after he's moved but BEFORE collision.
PortalGun.tryEnter = function (player) {
  if (player.portalTransit || !canTravel(player)) return;
  const portals = state.portals;
  if (!(portals && portals.red && portals.blue)) return;

  for (const color of ['red', 'blue']) {
    const from = portals[color];
    const [tx, ty] = tangentOf(from);
    const rx = player.pos.x - from.x, ry = player.pos.y - from.y;
    const out = rx * from.nx + ry * from.ny;
    const along = rx * tx + ry * ty;
    const r = player.radius;
    const down = player.visualDownDirection(player.currentPlanet);
    const lead = bodyReach(player, down, -from.nx, -from.ny);
    if (Math.abs(along) <= PORTAL_HALF_LENGTH && out <= lead + ENTER_REACH && out > -r * 0.5) {
      const inward = -(player.vel.x * from.nx + player.vel.y * from.ny);
      const underFeet = player.onSurface && -(down.x * from.nx + down.y * from.ny) > 0.7;
      if (inward > ENTER_MIN_INWARD_SPEED || underFeet) {
        player.portalTransit = beginTrip(color, along, out, inward,
          player.vel.x * tx + player.vel.y * ty, down,
          bodyReach(player, down, from.nx, from.ny, HEAD_DRAW_PAD),
          r, player.lastInfluencePlanet);
        player.portalDown = down;
        startAfterglow(player, player.portalTransit.to);
        player.onSurface = false;
        player.currentPlanet = null;
        player.isGroundPounding = false;
        return;
      }
    }
  }
};

// In place of normal movement/gravity/collision while he's in transit.
PortalGun.updateTransit = function (player, ts) {
  const tr = player.portalTransit;
  player.prevPos = player.pos.clone();
  player.onSurface = false;
  player.currentPlanet = null;

  const [x, y, through] = advanceTrip(tr, ts, player.radius * 0.6);
  player.pos.x = x; player.pos.y = y;
  player.vel.x = 0; player.vel.y = 0;
  if (tr.out < 0) [tr.cameraX, tr.cameraY] = mapPoint(tr.from, tr.to, tr.along, tr.out);
  else { tr.cameraX = x; tr.cameraY = y; }

  if (through) {
    const [fx, fy, vx, vy, down] = finishTrip(tr);
    player.pos.x = fx; player.pos.y = fy;
    player.vel.x = vx; player.vel.y = vy;
    player.prevPos = player.pos.clone();
    player.portalDown = down;
    startAfterglow(player, tr.to);
    player.portalTransit = null;
  }
};

function easeUpright(player) {
  if (!player.portalDown || player.portalTransit) return;
  const held = player.portalDown;
  player.portalDown = null;
  const natural = player.visualDownDirection((player.onSurface && player.currentPlanet) || player.lastInfluencePlanet);
  if (player.onSurface) return;
  const a = Math.atan2(held.y, held.x), b = Math.atan2(natural.y, natural.x);
  const diff = lua.mod(b - a + Math.PI, 2 * Math.PI) - Math.PI;
  if (Math.abs(diff) < 0.02) return;
  const next = a + diff * EXIT_UPRIGHT_RATE * state.timeScale;
  player.portalDown = Vector2.new(Math.cos(next), Math.sin(next));
}

PortalGun.passFireballs = function (fireballs, ts) {
  for (const f of fireballs) {
    const res = PortalGun.passPoint(f.pos.x, f.pos.y, f.vel.x, f.vel.y, f.radius, ts);
    if (res) [f.pos.x, f.pos.y, f.vel.x, f.vel.y] = res;
  }
};

// -> [x, y, vx, vy, exitPortal] or null
PortalGun.throughPortal = function (from, x, y, vx, vy, clearance) {
  const to = otherPortal(from.color);
  if (!to) return null;
  const [tx, ty] = tangentOf(from);
  const along = (x - from.x) * tx + (y - from.y) * ty;
  const [ox, oy] = mapPoint(from, to, along, -(clearance ?? 2));
  const [nvx, nvy] = rotate(vx, vy, linkRotation(from, to));
  return [ox, oy, nvx, nvy, to];
};

// -> [x, y, vx, vy, exitPortal] or null
PortalGun.passPoint = function (x, y, vx, vy, radius, ts) {
  const portals = state.portals;
  if (!(portals && portals.red && portals.blue)) return null;
  for (const color of ['red', 'blue']) {
    const from = portals[color];
    const [tx, ty] = tangentOf(from);
    const rx = x - from.x, ry = y - from.y;
    const out = rx * from.nx + ry * from.ny;
    const along = rx * tx + ry * ty;
    const inward = -(vx * from.nx + vy * from.ny);
    const outBefore = out + inward * ts;
    if (inward > 0 && out <= radius && outBefore > -radius
        && Math.abs(along) <= PORTAL_HALF_LENGTH - radius) {
      return PortalGun.throughPortal(from, x, y, vx, vy, radius + 2);
    }
  }
  return null;
};

function stencilFrontOf(portal) {
  const [tx, ty] = tangentOf(portal);
  const L = 20000;
  love.graphics.polygon('fill',
    portal.x - tx * L, portal.y - ty * L,
    portal.x + tx * L, portal.y + ty * L,
    portal.x + tx * L + portal.nx * L, portal.y + ty * L + portal.ny * L,
    portal.x - tx * L + portal.nx * L, portal.y - ty * L + portal.ny * L);
}

function drawSplit(thing, tr, glowBound, glowShape) {
  const g = love.graphics;
  if (!tr) { thing.draw(); return; }
  const from = tr.from, to = tr.to;
  const rot = linkRotation(from, to);
  const carried = (drawFn) => {
    g.push();
    g.translate(to.x, to.y);
    g.rotate(rot);
    g.translate(-from.x, -from.y);
    drawFn();
    g.pop();
  };

  g.stencil(() => stencilFrontOf(from), 'replace', 1);
  g.setStencilTest('greater', 0);
  thing.draw();

  g.stencil(() => stencilFrontOf(to), 'replace', 1);
  const glow = thing.portalGlow;
  if (glow && glowShape) {
    const [gx, gy] = carryThrough(tr, thing.pos.x, thing.pos.y);
    const t = glow.timer / AFTERGLOW_SECONDS;
    SilhouetteGlow.draw(gx, gy, glowBound, AFTERGLOW_REACH, glow.color, AFTERGLOW_STRENGTH * t * t,
      () => carried(glowShape));
  }
  carried(() => thing.draw());
  g.setStencilTest();
}

function drawAfterglowUnder(thing, x, y, bound, drawShape) {
  const glow = thing.portalGlow;
  if (!glow || glow.timer <= 0 || thing.portalTransit) return;
  const t = glow.timer / AFTERGLOW_SECONDS;
  SilhouetteGlow.draw(x, y, bound, AFTERGLOW_REACH, glow.color, AFTERGLOW_STRENGTH * t * t, drawShape);
}

function drawAfterglowMotes(thing) {
  const glow = thing.portalGlow;
  if (!glow) return;
  const g = love.graphics;
  const [r, gg, b] = glow.color;
  g.setBlendMode('add');
  for (const m of glow.motes) {
    const t = m.life / m.maxLife;
    g.setColor(1, 1, 1, t * 0.8);
    g.circle('fill', m.x, m.y, m.size * (0.5 + t * 0.5));
    g.setColor(r, gg, b, t * 0.35);
    g.circle('fill', m.x, m.y, m.size * 2.2);
  }
  g.setBlendMode('alpha');
  g.setColor(1, 1, 1, 1);
}

PortalGun.drawPlayer = function (player) {
  const bound = player.radius * 4, shape = () => player.drawRig();
  if (player.portalTransit) {
    drawSplit(player, player.portalTransit, bound, shape);
  } else {
    drawAfterglowUnder(player, player.pos.x, player.pos.y, bound, shape);
    player.draw();
  }
  drawAfterglowMotes(player);
};

// ---------------------------------------------------------------------
// Ooombas
// ---------------------------------------------------------------------

function ooombaReach(o, dx, dy) {
  const ux = o.up.x, uy = o.up.y;
  return Math.abs(dx * ux + dy * uy) * o.halfHeight + Math.abs(dx * -uy + dy * ux) * o.halfWidth;
}

PortalGun.tryEnterOoomba = function (o, walking) {
  if (o.portalTransit || o.isSquashing) return false;
  const portals = state.portals;
  if (!(portals && portals.red && portals.blue)) return false;
  for (const color of ['red', 'blue']) {
    const from = portals[color];
    const [tx, ty] = tangentOf(from);
    const rx = o.pos.x - from.x, ry = o.pos.y - from.y;
    const out = rx * from.nx + ry * from.ny;
    const along = rx * tx + ry * ty;
    const reach = ooombaReach(o, from.nx, from.ny);
    if (Math.abs(along) <= PORTAL_HALF_LENGTH && out <= reach + ENTER_REACH && out > -reach * 0.5) {
      const inward = -(o.vel.x * from.nx + o.vel.y * from.ny);
      const underFeet = walking && (o.up.x * from.nx + o.up.y * from.ny) > 0.7;
      if (inward > ENTER_MIN_INWARD_SPEED || underFeet) {
        o.portalTransit = beginTrip(color, along, out, inward, o.vel.x * tx + o.vel.y * ty,
          Vector2.new(-o.up.x, -o.up.y), reach, o.halfHeight, o.lastInfluencePlanet);
        startAfterglow(o, o.portalTransit.to);
        return true;
      }
    }
  }
  return false;
};

// One frame of an Ooomba's trip. Returns true the frame it comes out.
PortalGun.updateOoombaTrip = function (o, ts) {
  const tr = o.portalTransit;
  const [x, y, through] = advanceTrip(tr, ts, o.halfWidth * 0.8);
  o.pos = Vector2.new(x, y);
  if (!through) return false;
  const [fx, fy, vx, vy, down] = finishTrip(tr);
  o.pos.x = fx; o.pos.y = fy;
  o.vel = Vector2.new(vx, vy);
  o.up = Vector2.new(-down.x, -down.y);
  startAfterglow(o, tr.to);
  o.portalTransit = null;
  return true;
};

PortalGun.drawOoomba = function (o) {
  const bound = Math.max(o.halfWidth, o.halfHeight) * 1.6, shape = () => o.draw();
  if (o.portalTransit) {
    drawSplit(o, o.portalTransit, bound, shape);
  } else {
    drawAfterglowUnder(o, o.pos.x, o.pos.y, bound, shape);
    o.draw();
  }
  drawAfterglowMotes(o);
};

PortalGun.surfaceOf = planetoidSurface;
PortalGun.wallSurfaceOf = wallSurface;

// ---------------------------------------------------------------------
// Update / draw
// ---------------------------------------------------------------------

function updateAfterglow(thing, cx, cy, spread, dt, exitPortal) {
  const glow = thing.portalGlow;
  if (!glow) return;
  if (thing.portalTransit) glow.timer = AFTERGLOW_SECONDS;
  else glow.timer -= dt;
  if (glow.timer > 0) {
    glow.moteBudget += AFTERGLOW_MOTES_PER_SECOND * (glow.timer / AFTERGLOW_SECONDS) * dt;
    while (glow.moteBudget >= 1) {
      glow.moteBudget -= 1;
      const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * spread;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      if (!exitPortal || (x - exitPortal.x) * exitPortal.nx + (y - exitPortal.y) * exitPortal.ny > 0) {
        const da = rnd() * Math.PI * 2;
        const speed = AFTERGLOW_MOTE_SPEED_MIN + rnd() * AFTERGLOW_MOTE_SPEED_RANGE;
        const life = AFTERGLOW_MOTE_LIFE_MIN + rnd() * AFTERGLOW_MOTE_LIFE_RANGE;
        glow.motes.push({
          x, y, vx: Math.cos(da) * speed, vy: Math.sin(da) * speed,
          life, maxLife: life, size: 1.2 + rnd() * 1.6,
        });
      }
    }
  }
  for (let i = glow.motes.length - 1; i >= 0; i--) {
    const m = glow.motes[i];
    m.life -= dt;
    if (m.life <= 0) glow.motes.splice(i, 1);
    else { m.x += m.vx * dt; m.y += m.vy * dt; }
  }
  if (glow.timer <= 0 && glow.motes.length === 0) thing.portalGlow = null;
}

// dt: real seconds.
PortalGun.update = function (dt) {
  const player = state.player;
  if (player) {
    easeUpright(player);
    const down = player.visualDownDirection((player.onSurface && player.currentPlanet) || player.lastInfluencePlanet);
    const lift = ((player.headReach ?? player.radius) - player.radius) / 2;
    let cx = player.pos.x - down.x * lift, cy = player.pos.y - down.y * lift;
    const tr = player.portalTransit;
    if (tr) [cx, cy] = carryThrough(tr, cx, cy);
    updateAfterglow(player, cx, cy, player.radius * 1.1, dt, tr && tr.to);
  }
  for (const o of (state.ooombas ?? [])) {
    const tr = o.portalTransit;
    let cx = o.pos.x, cy = o.pos.y;
    if (tr) [cx, cy] = carryThrough(tr, cx, cy);
    updateAfterglow(o, cx, cy, Math.min(o.halfWidth, o.halfHeight), dt, tr && tr.to);
  }

  const portals = state.portals ?? {};
  for (const color of Object.keys(portals)) {
    const portal = portals[color];
    if (!portal) continue;
    if (!isStillInWorld(portal)) {
      portals[color] = null;
      continue;
    }
    refreshWorldPlacement(portal);
    portal.age += dt;

    portal.particleBudget += PARTICLES_PER_SECOND * dt;
    while (portal.particleBudget >= 1) {
      portal.particleBudget -= 1;
      const m = PortalGun.mouthAt(portal, 0.05 + rnd() * 0.9);
      const tx = -m.ny, ty = m.nx;
      const speed = PARTICLE_SPEED_MIN + rnd() * PARTICLE_SPEED_RANGE;
      const spread = (rnd() * 2 - 1) * 0.25;
      const life = PARTICLE_LIFE_MIN + rnd() * PARTICLE_LIFE_RANGE;
      portal.particles.push({
        ox: m.x - portal.x + m.nx * PORTAL_SURFACE_OFFSET,
        oy: m.y - portal.y + m.ny * PORTAL_SURFACE_OFFSET,
        vx: (m.nx + tx * spread) * speed, vy: (m.ny + ty * spread) * speed,
        life, maxLife: life, size: 1.2 + rnd() * 1.8,
      });
    }

    for (let i = 0; i < SHAFT_COUNT; i++) {
      let sh = portal.shafts[i];
      if (!sh || sh.life <= 0) {
        const life = SHAFT_LIFE_MIN + rnd() * SHAFT_LIFE_RANGE;
        sh = {
          u: 0.08 + rnd() * 0.84,
          length: SHAFT_LENGTH_MIN + rnd() * SHAFT_LENGTH_RANGE,
          width: SHAFT_WIDTH_MIN + rnd() * SHAFT_WIDTH_RANGE,
          white: rnd() * 0.6,
          phase: rnd() * Math.PI * 2, flicker: 6 + rnd() * 8,
          life: sh ? life : life * rnd(), maxLife: life,
        };
        portal.shafts[i] = sh;
      }
      sh.life -= dt;
    }
    for (let i = portal.particles.length - 1; i >= 0; i--) {
      const p = portal.particles[i];
      p.life -= dt;
      if (p.life <= 0) portal.particles.splice(i, 1);
      else { p.ox += p.vx * dt; p.oy += p.vy * dt; }
    }
  }

  const tracers = state.portalTracers ?? [];
  for (let i = tracers.length - 1; i >= 0; i--) {
    tracers[i].life -= dt;
    if (tracers[i].life <= 0) tracers.splice(i, 1);
  }
};

// A point partway along the mouth (u: 0..1), with the surface's normal.
PortalGun.mouthAt = function (portal, u) {
  const mouth = portal.mouth;
  const f = Math.max(0, Math.min(1, u)) * (mouth.length - 1);
  const i = Math.min(mouth.length - 2, Math.floor(f));
  const a = mouth[i], b = mouth[i + 1], t = f - i;
  const nx = a.nx + (b.nx - a.nx) * t, ny = a.ny + (b.ny - a.ny) * t;
  const len = Math.sqrt(nx * nx + ny * ny);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, nx: nx / len, ny: ny / len };
};

function endFade(u) {
  const d = Math.abs(u * 2 - 1);
  return 1 - d * d * d;
}

function drawCurtain(portal, key, height, r, g, b, alpha) {
  const verts = [];
  const n = portal.mouth.length;
  portal.mouth.forEach((m, i) => {
    const u = i / (n - 1);
    const e = endFade(u);
    const h = height * (0.55 + 0.45 * e);
    const bx = m.x + m.nx * PORTAL_SURFACE_OFFSET, by = m.y + m.ny * PORTAL_SURFACE_OFFSET;
    verts.push([bx, by, 0, 0, r, g, b, alpha * e]);
    verts.push([bx + m.nx * h, by + m.ny * h, 0, 0, r, g, b, 0]);
  });
  portal[key] = portal[key] ?? love.graphics.newMesh(verts.length, 'strip', 'stream');
  portal[key].setVertices(verts);
  love.graphics.draw(portal[key]);
}

function mouthTaper(u) {
  const d = u * 2 - 1;
  return (1 - d * d) ** 0.75;
}

function drawMouthBand(portal, key, width, r, g, b, alpha) {
  const verts = [];
  const n = portal.mouth.length;
  portal.mouth.forEach((m, i) => {
    const half = width / 2 * mouthTaper(i / (n - 1));
    const cx = m.x + m.nx * PORTAL_SURFACE_OFFSET, cy = m.y + m.ny * PORTAL_SURFACE_OFFSET;
    verts.push([cx + m.nx * half, cy + m.ny * half, 0, 0, r, g, b, alpha]);
    verts.push([cx - m.nx * half, cy - m.ny * half, 0, 0, r, g, b, alpha]);
  });
  portal[key] = portal[key] ?? love.graphics.newMesh(verts.length, 'strip', 'stream');
  portal[key].setVertices(verts);
  love.graphics.draw(portal[key]);
}

function drawPortal(portal) {
  const g = love.graphics;
  const col = COLORS[portal.color];
  const shimmer = 0.85 + 0.15 * Math.sin(portal.age * 5);
  const [gr, gg, gb] = col.glow;

  g.setBlendMode('add');
  g.setColor(1, 1, 1, 1);

  drawCurtain(portal, 'curtainMesh', CURTAIN_HEIGHT, gr, gg, gb, 0.42 * shimmer);
  drawCurtain(portal, 'coreMesh', CURTAIN_HEIGHT * 0.3, col.bright[0], col.bright[1], col.bright[2], 0.55 * shimmer);

  const verts = [];
  for (const sh of portal.shafts) {
    const m = PortalGun.mouthAt(portal, sh.u);
    const tx = -m.ny, ty = m.nx;
    const lifeT = 1 - Math.max(0, sh.life) / sh.maxLife;
    const alpha = Math.sin(lifeT * Math.PI) * (0.7 + 0.3 * Math.sin(portal.age * sh.flicker + sh.phase))
      * endFade(sh.u) * 0.55;
    const r = gr + (1 - gr) * sh.white;
    const gg2 = gg + (1 - gg) * sh.white;
    const b = gb + (1 - gb) * sh.white;
    const bx = m.x + m.nx * PORTAL_SURFACE_OFFSET, by = m.y + m.ny * PORTAL_SURFACE_OFFSET;
    const w0 = sh.width / 2, w1 = sh.width * 0.2;
    const ex = bx + m.nx * sh.length, ey = by + m.ny * sh.length;
    const b1 = [bx - tx * w0, by - ty * w0, 0, 0, r, gg2, b, alpha];
    const b2 = [bx + tx * w0, by + ty * w0, 0, 0, r, gg2, b, alpha];
    const t1 = [ex - tx * w1, ey - ty * w1, 0, 0, r, gg2, b, 0];
    const t2 = [ex + tx * w1, ey + ty * w1, 0, 0, r, gg2, b, 0];
    verts.push(b1, b2, t2, b1, t2, t1);
  }
  if (verts.length > 0) {
    if (!portal.shaftMesh || portal.shaftMeshSize !== verts.length) {
      portal.shaftMesh = g.newMesh(verts.length, 'triangles', 'stream');
      portal.shaftMeshSize = verts.length;
    }
    portal.shaftMesh.setVertices(verts);
    g.draw(portal.shaftMesh);
  }

  g.setColor(1, 1, 1, 1);
  drawMouthBand(portal, 'band1', 24, gr, gg, gb, 0.10 * shimmer);
  drawMouthBand(portal, 'band2', 14, gr, gg, gb, 0.20 * shimmer);
  drawMouthBand(portal, 'band3', 8, gr, gg, gb, 0.60 * shimmer);
  drawMouthBand(portal, 'band4', 3.5, 1, 1, 1, 0.95);

  for (const p of portal.particles) {
    const t = p.life / p.maxLife;
    g.setColor(1, 1, 1, t * 0.85);
    g.circle('fill', portal.x + p.ox, portal.y + p.oy, p.size * (0.5 + t * 0.5));
    g.setColor(gr, gg, gb, t * 0.35);
    g.circle('fill', portal.x + p.ox, portal.y + p.oy, p.size * 2.2);
  }
  g.setBlendMode('alpha');
}

// In world space (inside the camera transform).
PortalGun.draw = function () {
  const g = love.graphics;
  for (const tr of (state.portalTracers ?? [])) {
    const col = COLORS[tr.color];
    const t = tr.life / TRACER_LIFE;
    g.setBlendMode('add');
    g.setLineWidth(tr.missed ? 2 : 3);
    g.setColor(col.glow[0], col.glow[1], col.glow[2], t * (tr.missed ? 0.4 : 0.8));
    g.line(tr.x1, tr.y1, tr.x2, tr.y2);
    g.setLineWidth(1);
    g.setBlendMode('alpha');
  }
  for (const color of ['red', 'blue']) {
    const portal = state.portals && state.portals[color];
    if (portal) drawPortal(portal);
  }
  g.setColor(1, 1, 1, 1);
};

export default PortalGun;
