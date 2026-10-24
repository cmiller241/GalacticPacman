// js/systems/Recall.js
//
// Recall mode (one of the modes P cycles through — see WeaponModes.js),
// after Tears of the Kingdom's: right click / R2 on a planetoid and it
// rewinds back along the path it's taken over the last 30 seconds.
//
// Recording: every RECORD_SECONDS of game time, every planetoid that's
// moved since its last sample records where it is (plus velocity, spin,
// and a moving Sphere's next patrol point), into flat ring arrays.
//
// Rewinding: the samples play back newest to oldest over
// REWIND_MIN_SECONDS..REWIND_MAX_SECONDS. While rewinding nothing else
// moves it (main.js skips anything with .recalling set) and whatever's in
// its way is shoved aside. Recalling it again mid-rewind stops it there.

import love from '../love/index.js';
import lua from '../love/lua.js';
import state from '../state.js';

const Recall = {};

// ---------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------

const RECORD_SECONDS = 0.1;
const MAX_SAMPLES = 300;
const MOVED_AT_LEAST = 0.5;
const REWIND_MIN_SECONDS = 2;
const REWIND_MAX_SECONDS = 4;
const GAMEPAD_AIM_REACH = 2500;

const COLOR = [1.0, 0.86, 0.25];
const BLINK_PER_SECOND = 2.5;
const OVERLAY_ALPHA_MIN = 0.18;
const OVERLAY_ALPHA_MAX = 0.55;
const RING_WIDTH = 3;
const PATH_DOT_SPACING = 18;
const PATH_ALPHA = 0.45;

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------

// planetoid -> { xs, ys, vxs, vys, rots, targets, head, count } (head:
// 0-based index of the newest sample). WeakMap, so a culled planetoid's
// history goes with it.
let histories = new WeakMap();
let recordClock = 0;
// planetoid -> its rewind under way: { path, t, duration, lastX, lastY }
let rewinds = new Map();
let age = 0;

Recall.reset = function () {
  histories = new WeakMap();
  rewinds = new Map();
  recordClock = 0;
};

// ---------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------

function record(p) {
  let h = histories.get(p);
  if (!h) {
    h = { xs: [], ys: [], vxs: [], vys: [], rots: [], targets: [], head: -1, count: 0 };
    histories.set(p, h);
  }
  if (h.count > 0) {
    const dx = p.pos.x - h.xs[h.head], dy = p.pos.y - h.ys[h.head];
    if (dx * dx + dy * dy < MOVED_AT_LEAST * MOVED_AT_LEAST) return;
  }
  const i = (h.head + 1) % MAX_SAMPLES;
  h.head = i;
  h.count = Math.min(h.count + 1, MAX_SAMPLES);
  h.xs[i] = p.pos.x; h.ys[i] = p.pos.y;
  h.vxs[i] = p.vel ? p.vel.x : 0; h.vys[i] = p.vel ? p.vel.y : 0;
  h.rots[i] = p.rotationAngle ?? false;
  h.targets[i] = p.target ?? false;
}

Recall.historyLength = function (p) {
  const h = histories.get(p);
  return h ? h.count : 0;
};

Recall.isRecalling = function (p) {
  return rewinds.has(p);
};

Recall.canRecall = function (p) {
  const h = histories.get(p);
  return h != null && h.count >= 2 && !rewinds.has(p);
};

// ---------------------------------------------------------------------
// Choosing a planetoid
// ---------------------------------------------------------------------

// Everything Recall can rewind: the planetoids, state.recallables (e.g.
// a fallen RopeRock) and the outposts' missiles in flight.
function recallTargets() {
  const extra = state.recallables;
  const missiles = state.missiles;
  if ((!extra || extra.length === 0) && (!missiles || missiles.length === 0)) return state.planetoids ?? [];
  return [...(state.planetoids ?? []), ...(extra ?? []), ...(missiles ?? [])];
}

function outline(p, mode, pad) {
  if (p.halfWidth && p.halfHeight && !p.isRoundedRect) {
    love.graphics.rectangle(mode, p.pos.x - p.halfWidth - pad, p.pos.y - p.halfHeight - pad,
      (p.halfWidth + pad) * 2, (p.halfHeight + pad) * 2, 6, 6);
  } else {
    love.graphics.circle(mode, p.pos.x, p.pos.y, p.radius + pad);
  }
}

function isCandidate(p) {
  return p && p.pos && p.radius && !p.isSkyDome && !p.isOpenPath;
}

function aimedPlanetoid(player) {
  if (state.gamepadIsActiveDevice) {
    if (player.lockedTarget && isCandidate(player.lockedTarget)) return player.lockedTarget;
    const ox = player.aimShoulderPos ? player.aimShoulderPos.x : player.pos.x;
    const oy = player.aimShoulderPos ? player.aimShoulderPos.y : player.pos.y;
    const a = (player.aimWorldAngle ?? 0) + (player.blasterAngleOffset ?? 0);
    const dx = Math.cos(a), dy = Math.sin(a);
    let best = null, bestT = GAMEPAD_AIM_REACH;
    for (const p of recallTargets()) {
      if (isCandidate(p) && p !== player.currentPlanet) {
        const fx = p.pos.x - ox, fy = p.pos.y - oy;
        const along = fx * dx + fy * dy;
        const offSq = fx * fx + fy * fy - along * along;
        const rSq = p.radius * p.radius;
        if (along > 0 && offSq <= rSq) {
          const t = along - Math.sqrt(rSq - offSq);
          if (t < bestT) { best = p; bestT = t; }
        }
      }
    }
    return best;
  }

  const cam = state.camera ?? { x: 0, y: 0 };
  const zoom = state.zoom ?? 1;
  const mouse = state.mouse;
  if (!mouse) return null;
  const wx = mouse.x / zoom + cam.x, wy = mouse.y / zoom + cam.y;
  let best = null, bestR = Infinity;
  for (const p of recallTargets()) {
    if (isCandidate(p)) {
      let hit;
      if (p.containsPoint) {
        hit = p.containsPoint(wx, wy);
      } else {
        const dx = wx - p.pos.x, dy = wy - p.pos.y;
        hit = dx * dx + dy * dy <= p.radius * p.radius;
      }
      if (hit && p.radius < bestR) { best = p; bestR = p.radius; }
    }
  }
  return best;
}

// ---------------------------------------------------------------------
// Rewinding
// ---------------------------------------------------------------------

function finish(p, point) {
  rewinds.delete(p);
  p.recalling = null;
  if (p.vel) { p.vel.x = point.vx; p.vel.y = point.vy; }
  if (point.rot !== false && point.rot != null && p.rotationAngle != null) p.rotationAngle = point.rot;
  if (point.target && p.target) p.target = point.target;
  histories.delete(p);
}

Recall.activate = function (player) {
  if (!player) return false;
  const p = aimedPlanetoid(player);
  if (!p) return false;

  const r = rewinds.get(p);
  if (r) {
    const n = r.path.length;
    finish(p, r.path[Math.min(n - 1, Math.floor(r.t / r.duration * (n - 1)))]);
    return true;
  }
  if (!Recall.canRecall(p)) return false;

  const h = histories.get(p);
  const path = [{
    x: p.pos.x, y: p.pos.y, vx: p.vel ? p.vel.x : 0, vy: p.vel ? p.vel.y : 0,
    rot: p.rotationAngle ?? false, target: p.target ?? false,
  }];
  for (let k = 0; k < h.count; k++) {
    const i = lua.mod(h.head - k, MAX_SAMPLES);
    path.push({ x: h.xs[i], y: h.ys[i], vx: h.vxs[i], vy: h.vys[i], rot: h.rots[i], target: h.targets[i] });
  }

  const duration = REWIND_MIN_SECONDS + (REWIND_MAX_SECONDS - REWIND_MIN_SECONDS) * (h.count / MAX_SAMPLES);
  rewinds.set(p, { path, t: 0, duration, lastX: p.pos.x, lastY: p.pos.y });
  p.recalling = true;
  if (p.vel) { p.vel.x = 0; p.vel.y = 0; }
  return true;
};

function shove(p, list, mvx, mvy) {
  for (const o of (list ?? [])) {
    if (o !== p && o.pos && o.radius && !o.isImmovable && !o.recalling && o.vel) {
      const dx = o.pos.x - p.pos.x, dy = o.pos.y - p.pos.y;
      const sumR = p.radius + o.radius;
      const distSq = dx * dx + dy * dy;
      if (distSq < sumR * sumR) {
        const dist = Math.sqrt(distSq);
        let nx, ny;
        if (dist > 1e-6) { nx = dx / dist; ny = dy / dist; } else { nx = 0; ny = -1; }
        const overlap = sumR - dist;
        o.pos.x += nx * overlap; o.pos.y += ny * overlap;
        const pushN = mvx * nx + mvy * ny;
        const oN = o.vel.x * nx + o.vel.y * ny;
        if (oN < pushN) {
          o.vel.x += nx * (pushN - oN);
          o.vel.y += ny * (pushN - oN);
        }
      }
    }
  }
}

// Once a frame, after the planetoids' own movement and before the player's.
Recall.update = function (dt) {
  const ts = state.timeScale ?? 1;
  const gameDt = ts / 60;
  age += dt;

  for (const [p, r] of [...rewinds]) {
    r.t += gameDt;
    const n = r.path.length;
    const u = Math.min(1, r.t / r.duration) * (n - 1);
    const k = Math.floor(u);
    const a = r.path[k], b = r.path[Math.min(n - 1, k + 1)];
    const f = u - k;
    p.pos.x = a.x + (b.x - a.x) * f;
    p.pos.y = a.y + (b.y - a.y) * f;
    if (a.rot !== false && b.rot !== false && p.rotationAngle != null) {
      const d = Math.atan2(Math.sin(b.rot - a.rot), Math.cos(b.rot - a.rot));
      p.rotationAngle = a.rot + d * f;
    }
    let mvx = 0, mvy = 0;
    if (ts > 0) { mvx = (p.pos.x - r.lastX) / ts; mvy = (p.pos.y - r.lastY) / ts; }
    r.lastX = p.pos.x; r.lastY = p.pos.y;
    shove(p, state.planetoids, mvx, mvy);
    shove(p, state.asteroids, mvx, mvy);
    if (r.t >= r.duration) finish(p, r.path[n - 1]);
  }

  recordClock += gameDt;
  if (recordClock >= RECORD_SECONDS) {
    recordClock = lua.mod(recordClock, RECORD_SECONDS);
    for (const p of recallTargets()) {
      if (p.pos && !p.recalling) record(p);
    }
  }
};

// ---------------------------------------------------------------------
// Drawing (world space, over the planetoids)
// ---------------------------------------------------------------------

Recall.draw = function () {
  const g = love.graphics;
  const blink = 0.5 + 0.5 * Math.sin(age * BLINK_PER_SECOND * Math.PI * 2);

  for (const [p, r] of rewinds) {
    const n = r.path.length;
    const u = Math.min(1, r.t / r.duration) * (n - 1);
    const k = Math.floor(u);
    g.setColor(COLOR[0], COLOR[1], COLOR[2], PATH_ALPHA);
    let carry = 0;
    let px = p.pos.x, py = p.pos.y;
    // (Lua j = k + 2 .. n, 1-based -> 0-based k + 1 .. n - 1.)
    for (let j = k + 1; j < n; j++) {
      const q = r.path[j];
      const dx = q.x - px, dy = q.y - py;
      const len = Math.sqrt(dx * dx + dy * dy);
      let s = PATH_DOT_SPACING - carry;
      while (s <= len) {
        g.circle('fill', px + dx * s / len, py + dy * s / len, 2);
        s += PATH_DOT_SPACING;
      }
      carry = len - (s - PATH_DOT_SPACING);
      px = q.x; py = q.y;
    }

    g.setColor(COLOR[0], COLOR[1], COLOR[2], OVERLAY_ALPHA_MIN + (OVERLAY_ALPHA_MAX - OVERLAY_ALPHA_MIN) * blink);
    outline(p, 'fill', 0);
    g.setLineWidth(RING_WIDTH);
    g.setColor(COLOR[0], COLOR[1], COLOR[2], 0.6 + 0.4 * blink);
    outline(p, 'line', RING_WIDTH / 2);
  }

  if (state.recallMode && state.player) {
    const p = aimedPlanetoid(state.player);
    if (p && Recall.canRecall(p)) {
      g.setLineWidth(2);
      g.setColor(COLOR[0], COLOR[1], COLOR[2], 0.7);
      outline(p, 'line', 4);
    }
  }

  g.setLineWidth(1);
  g.setColor(1, 1, 1, 1);
};

export default Recall;
