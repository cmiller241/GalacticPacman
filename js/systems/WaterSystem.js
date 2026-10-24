// js/systems/WaterSystem.js
//
// Water mode (see WeaponModes.js): right click / R2 sprays water from the
// blaster's muzzle.
//
// Spray is DROPLETS arcing under gravity. On the Tiled level (inside the
// dome) one becomes water on a fine grid of CELL-sized cells laid over the
// level (0 = dry, 1 = full); each step, a cell's water falls into the cell
// below if there's room, spreads sideways along whatever it's resting on,
// and evaporates slowly from the top (the way Terraria's water works). On
// a planetoid Bob can walk round it adds to an even layer of water round
// it (an "ocean"). Anywhere else it just splashes.
//
// Bob swims in water deep enough to cover his middle (see submergedAt and
// Player.js's submergedIn). Fireballs boil it (quenchFireball).
//
// Port notes: grid.water is a Map keyed by the 0-based cell index
// r * cols + c (Lua's was 1-based); oceans is a Map keyed by planetoid.

import love from '../love/index.js';
import lua from '../love/lua.js';
import state from '../state.js';
import constants from '../constants.js';
import Vector2 from '../vector2.js';
import PortalGun from './PortalGun.js';
import Splash from '../effects/Splash.js';

const WaterSystem = {};
const rnd = () => lua.random();
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------

const CELL = 16;
const STEP_SECONDS = 1 / 60;
const MAX_STEPS_PER_FRAME = 3;
const SPREAD = 0.25;
const MIN_SPREAD = 0.02;
const EVAPORATE_PER_SECOND = 0.006;
const DRY = 0.002;

const SPRAY_PER_SECOND = 240;
const SPRAY_SPEED = 10, SPRAY_SPEED_RANGE = 3;
const SPRAY_SPREAD = 0.08;
const DROPLET_VOLUME = 0.1 / 3;
const DROPLET_SECONDS = 3;
const MAX_DROPLETS = 1200;
const HITS_POOL = 0.5;

const PORTAL_FLOW_PER_SECOND = 12;
const PORTAL_JET_VOLUME = 0.25;
const OCEAN_LEVEL_RATE = 0.6;
const OCEAN_LEVEL_SLACK = 0.5;
const PORTAL_JET_SPEED = 4, PORTAL_JET_SPEED_RANGE = 2;
const PORTAL_JET_SPREAD = 0.15;

const WATER_CAP = 1500;
const SPUTTER_FRACTION = 0.15;

const OCEAN_SEGMENTS = 72;
const OCEAN_MAX_SEGMENTS = 720;

const SPLASH_BITS = 4;
const SPLASH_SECONDS = 0.35;

const WATERFALL_SPLASH_PER_SECOND = 220;
const WATERFALL_SPLASH_MIN_FALL = 24;
const WATERFALL_SPLASH = {
  coneAngle: Math.PI * 0.6,
  speedScale: 0.35,
  lifeScale: 0.6,
  radiusScale: 0.35,
  lightMin: 0.7,
};

const QUENCH_AT = 0.25;
const BOIL_ON_HIT = 0.6;
const BOIL_PER_SECOND = 1.2;
const HOT_SECONDS = 2.5;
const BOIL_REACH_CELLS = 3;
const STEAM_BURST = 50;
const STEAM_PER_SECOND = 22;
const STEAM_SECONDS = 5;
const STEAM_RISE = 1.1;
const STEAM_START_DEPTH = 12;
const STEAM_SIZE = 2;
const STEAM_GROWTH = 14;
const STEAM_ALPHA = 0.32;
const COLOR_STEAM = [0.92, 0.95, 1.00];

const COLOR_SHALLOW = [0.30, 0.66, 1.00];
const COLOR_DEEP = [0.08, 0.26, 0.62];
const DEEP_AT = 140;
const ALPHA_SHALLOW = 0.50, ALPHA_DEEP = 0.82;
const COLOR_SURFACE = [0.82, 0.94, 1.00];
const SURFACE_LINE = 8;
const SURFACE_FEATHER = 2.5;
const STREAM_REACH_CELLS = 8;
const LIP_THICKNESS = 6;
const SURFACE_SLICES = 4;
const SURFACE_GLOW = 16;
const COLOR_CAUSTIC = [0.75, 0.92, 1.00];
const CAUSTIC_SCALE = 34;
const CAUSTIC_GROW_FROM_DEPTH = 60;
const CAUSTIC_GROW_POWER = 0.5;
const CAUSTIC_MAX_GROWTH = 5;
const SPHERE_COLOR_SHALLOW = [0.30, 0.66, 0.85];
const SPHERE_COLOR_DEEP = [0.05, 0.24, 0.52];
const SPHERE_COLOR_SHADE = [0.02, 0.05, 0.20];
const SPHERE_SHADE_STRENGTH = 0.9;
const SPHERE_COLOR_RIM = [0.55, 0.88, 0.98];
const SPHERE_RIM_STRENGTH = 0.5;
const SPHERE_COLOR_REFLECTED = [0.20, 0.38, 0.60];
const SPHERE_REFLECTED_STRENGTH = 0.8;
const CORE_OVERLAY_FROM_DEPTH = 20;
const CORE_OVERLAY_FULL_DEPTH = 400;
const CORE_OVERLAY_MAX = 0.85;
const CAUSTIC_BULGE = 1.0;
const CAUSTIC_SPEED = 0.6;
const CAUSTIC_STRENGTH = 0.3;
const COLOR_DROPLET = [0.70, 0.88, 1.00, 0.95];

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------

let grid = null;
let droplets = [];
let splashes = [];
let waterfallLandings = [];
let steam = [];
let hotSpots = [];
let sprayBudget = 0;
let isSpraying = false;
let totalWater = 0;
// planetoid -> { volume, water, natural?, marker?, farPos? }
let oceans = new Map();
let stepClock = 0;
let age = 0;
let mesh = null, meshSize = 0;

// What a pool is to Bob while he's in one (Player.submergedIn): a huge
// round body centered far below him, its radius reaching up to the surface.
const poolWater = { isPool: true, pos: Vector2.new(0, 0), radius: 0 };

WaterSystem.reset = function () {
  grid = null;
  droplets = []; splashes = []; waterfallLandings = [];
  steam = []; hotSpots = [];
  sprayBudget = 0; stepClock = 0;
  isSpraying = false;
  totalWater = 0;
  oceans = new Map();
};

// ---------------------------------------------------------------------
// Water on planetoids
// ---------------------------------------------------------------------

function holdsWater(p) {
  if (!(p && p.pos) || p.isSkyDome || p.isWaterPlanet || p.isOpenPath || p.isWall || p.isGate) return false;
  if (p.isRoundedRect) return p.pointAtLocalArcPosition != null && p.cornerRadius != null;
  return p.radius != null;
}

function perimeterOf(p) {
  if (p.isRoundedRect) return p.getPerimeter();
  return 2 * Math.PI * p.radius;
}

// How deep a layer `volume` (cells' worth) makes round planetoid p.
function depthOf(p, volume) {
  const P = perimeterOf(p);
  return (Math.sqrt(P * P + 4 * Math.PI * volume * CELL * CELL) - P) / (2 * Math.PI);
}

// -> [distance from p's surface (negative inside), nx, ny]
function surfaceDistance(p, x, y) {
  if (p.isRoundedRect) {
    const [lx, ly] = p.worldToLocal(x, y);
    const cr = p.cornerRadius;
    const qx = Math.abs(lx) - (p.halfWidth - cr), qy = Math.abs(ly) - (p.halfHeight - cr);
    let d, nx, ny;
    if (qx > 0 && qy > 0) {
      const len = Math.sqrt(qx * qx + qy * qy);
      d = len - cr; nx = qx / len; ny = qy / len;
    } else if (qx > qy) {
      d = qx - cr; nx = 1; ny = 0;
    } else {
      d = qy - cr; nx = 0; ny = 1;
    }
    if (lx < 0) nx = -nx;
    if (ly < 0) ny = -ny;
    const n = p.localDirToWorld(nx, ny);
    return [d, n.x, n.y];
  }
  const dx = x - p.pos.x, dy = y - p.pos.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1e-6) return [-p.radius, 0, -1];
  return [dist - p.radius, dx / dist, dy / dist];
}

function addToOcean(p, amount) {
  let o = oceans.get(p);
  if (!o) {
    o = { volume: 0, water: { isPool: true, pos: p.pos, radius: p.radius } };
    oceans.set(p, o);
  }
  o.volume += amount;
}

// A planetoid that starts out under water (see WaterPlanet.js).
WaterSystem.addNaturalOcean = function (core, outerRadius, marker) {
  const volume = Math.PI * (outerRadius * outerRadius - core.radius * core.radius) / (CELL * CELL);
  addToOcean(core, volume);
  const o = oceans.get(core);
  o.natural = (o.natural ?? 0) + volume;
  o.marker = marker;
  if (marker) marker.radius = outerRadius;
};

function forgetCulledOceans() {
  if (oceans.size === 0) return;
  const alive = new Set(state.planetoids ?? []);
  for (const p of [...oceans.keys()]) {
    if (!alive.has(p)) oceans.delete(p);
  }
}

// ---------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------

// Lays the water grid over a Tiled level (see TiledTerrain.load).
WaterSystem.init = function (level) {
  const width = (level.pos.x - level.anchorX) * 2;
  const height = (level.pos.y - level.anchorY) * 2;
  const cols = Math.ceil(width / CELL), rows = Math.ceil(height / CELL);
  const g = {
    x0: level.anchorX, y0: level.anchorY, cols, rows,
    solid: new Uint8Array(cols * rows), floor: new Map(), water: new Map(), slope: new Map(),
  };
  const inside = (c, r) => c >= 0 && c < cols && r >= 0 && r < rows;

  for (const w of (level.walls ?? [])) {
    if (!w.isWall) continue;
    const c0 = Math.ceil((w.pos.x - w.halfWidth - g.x0) / CELL - 0.5);
    const c1 = Math.floor((w.pos.x + w.halfWidth - g.x0) / CELL - 0.5);
    const r0 = Math.ceil((w.pos.y - w.halfHeight - g.y0) / CELL - 0.5);
    const r1 = Math.floor((w.pos.y + w.halfHeight - g.y0) / CELL - 0.5);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (inside(c, r)) g.solid[r * cols + c] = 1;
      }
    }
  }

  for (const shape of (level.shapes ?? [])) {
    for (const s of (shape.segments ?? [])) {
      if (!(s.normal.y < -0.3 && !s.isWallFace)) continue;
      const len = Math.sqrt((s.b.x - s.a.x) ** 2 + (s.b.y - s.a.y) ** 2);
      const steps = Math.max(1, Math.ceil(len / (CELL * 0.5)));
      for (let k = 0; k < steps; k++) {
        const t = (k + 0.5) / steps;
        const x = s.a.x + (s.b.x - s.a.x) * t - s.normal.x * 0.5;
        const y = s.a.y + (s.b.y - s.a.y) * t - s.normal.y * 0.5;
        const c = Math.floor((x - g.x0) / CELL), r = Math.floor((y - g.y0) / CELL);
        if (inside(c, r)) {
          const i = r * cols + c;
          let list = g.floor.get(i);
          if (!list) { list = []; g.floor.set(i, list); }
          if (!list.includes(s.normal)) list.push(s.normal);
        }
      }
    }
  }

  const taken = (c, r) => {
    const i = r * cols + c;
    return g.solid[i] === 1 || g.floor.has(i);
  };
  for (const shape of (level.shapes ?? [])) {
    for (const s of (shape.segments ?? [])) {
      const dx = s.b.x - s.a.x;
      if (s.normal.y < -0.3 && !s.isWallFace && Math.abs(s.normal.x) > 0.05 && Math.abs(dx) > 1) {
        const line = {
          ax: s.a.x, ay: s.a.y, k: (s.b.y - s.a.y) / dx,
          xMin: Math.min(s.a.x, s.b.x), xMax: Math.max(s.a.x, s.b.x),
        };
        const c0 = Math.floor((line.xMin - g.x0) / CELL);
        const c1 = Math.floor((line.xMax - g.x0) / CELL);
        for (let c = c0; c <= c1; c++) {
          const xc = Math.max(line.xMin, Math.min(line.xMax, g.x0 + (c + 0.5) * CELL));
          const y = line.ay + (xc - line.ax) * line.k;
          let r = Math.floor((y + 0.5 - g.y0) / CELL);
          for (let n = 0; n < 3; n++) {
            if (inside(c, r) && taken(c, r)) r -= 1;
          }
          if (inside(c, r) && !taken(c, r)) g.slope.set(r * cols + c, line);
        }
      }
    }
  }

  grid = g;
};

// -> [c, r]
function cellOf(x, y) {
  return [Math.floor((x - grid.x0) / CELL), Math.floor((y - grid.y0) / CELL)];
}

function inGrid(c, r) {
  return c >= 0 && c < grid.cols && r >= 0 && r < grid.rows;
}

function gateCovers(c, r) {
  const x = grid.x0 + (c + 0.5) * CELL, y = grid.y0 + (r + 0.5) * CELL;
  for (const gate of (state.gates ?? [])) {
    if (gate.halfHeight > 1 && Math.abs(x - gate.pos.x) <= gate.halfWidth
        && Math.abs(y - gate.pos.y) <= gate.halfHeight) return true;
  }
  return false;
}

function isSolid(c, r) {
  if (r >= grid.rows) return true;
  if (c < 0 || c >= grid.cols || r < 0) return false;
  return grid.solid[r * grid.cols + c] === 1 || gateCovers(c, r);
}

function blocked(c, r, dc, dr) {
  const nc = c + dc, nr = r + dr;
  if (isSolid(nc, nr)) return true;
  if (nc < 0 || nc >= grid.cols || nr < 0) return false;
  const floors = grid.floor.get(nr * grid.cols + nc);
  if (floors) {
    for (const n of floors) {
      if (n.x * dc + n.y * dr < -0.1) return true;
    }
  }
  return false;
}

function addWater(c, r, amount) {
  if (amount <= 0 || !inGrid(c, r)) return;
  const i = r * grid.cols + c;
  grid.water.set(i, (grid.water.get(i) ?? 0) + amount);
}

// One step of the water moving: bottom rows first.
function stepWater(dt) {
  const cols = grid.cols, water = grid.water;
  const list = [...water.keys()].sort((a, b) => b - a);
  grid.flip = !grid.flip;

  for (const i of list) {
    let w = water.get(i);
    if (w === undefined) continue;
    const r = Math.floor(i / cols);
    const c = i - r * cols;

    if (w > 1 && r > 0 && !blocked(c, r, 0, -1)) {
      water.set(i - cols, (water.get(i - cols) ?? 0) + (w - 1));
      w = 1;
    }

    if (!blocked(c, r, 0, 1)) {
      const below = water.get(i + cols) ?? 0;
      const f = Math.min(w, 1 - below);
      if (f > 0) {
        water.set(i + cols, below + f);
        w -= f;
      }
    }

    const resting = blocked(c, r, 0, 1) || (water.get(i + cols) ?? 0) >= 0.99;
    if (resting && w > MIN_SPREAD) {
      for (let k = 1; k <= 2; k++) {
        const dc = ((k === 1) === grid.flip) ? -1 : 1;
        const nc = c + dc;
        if (nc < 0 || nc >= cols) {
          w -= w * SPREAD;
        } else if (!blocked(c, r, dc, 0)) {
          const n = i + dc;
          const wn = water.get(n) ?? 0;
          if (wn < w) {
            const f = (w - wn) * SPREAD;
            water.set(n, wn + f);
            w -= f;
          }
        }
      }
    }

    if (r === 0 || !water.has(i - cols)) w -= EVAPORATE_PER_SECOND * dt;

    if (w < DRY) water.delete(i); else water.set(i, w);
  }
}

// ---------------------------------------------------------------------
// Swimming
// ---------------------------------------------------------------------

// Whether (x, y) is in real water (not just a damp film).
WaterSystem.wetAt = function (x, y) {
  if (!grid) return false;
  const [c, r] = cellOf(x, y);
  if (!inGrid(c, r)) return false;
  const i = r * grid.cols + c;
  const w = grid.water.get(i);
  if (r > 0 && grid.water.has(i - grid.cols)) return true;
  return w !== undefined && w >= 0.3 && y > grid.y0 + (r + 1) * CELL - w * CELL;
};

// The water Bob's middle is under, if any (see Player.js's submergedIn).
WaterSystem.submergedAt = function (player) {
  const x = player.pos.x, y = player.pos.y;
  for (const [p, o] of oceans) {
    const depth = depthOf(p, o.volume);
    const [d, nx, ny] = surfaceDistance(p, x, y);
    if (d < depth) {
      if (p.isRoundedRect) {
        const far = 100000;
        o.farPos = o.farPos ?? Vector2.new(0, 0);
        o.farPos.x = x - nx * (d + far); o.farPos.y = y - ny * (d + far);
        o.water.pos = o.farPos; o.water.radius = far + depth;
      } else {
        o.water.pos = p.pos; o.water.radius = p.radius + depth;
      }
      return o.water;
    }
  }
  if (!grid) return null;
  const [c, r] = cellOf(x, y);
  if (!inGrid(c, r)) return null;
  const i = r * grid.cols + c;
  const w = grid.water.get(i);
  const covered = (r > 0 && grid.water.has(i - grid.cols))
    || (w !== undefined && y > grid.y0 + (r + 1) * CELL - w * CELL);
  if (!covered) return null;
  let top = r;
  while (top > 0 && grid.water.has((top - 1) * grid.cols + c)) top -= 1;
  const surfaceY = grid.y0 + (top + 1) * CELL - Math.min(1, grid.water.get(top * grid.cols + c) ?? 1) * CELL;
  poolWater.pos.x = x; poolWater.pos.y = y + 100000;
  poolWater.radius = poolWater.pos.y - surfaceY;
  return poolWater;
};

// ---------------------------------------------------------------------
// Spraying and droplets
// ---------------------------------------------------------------------

function canSpray(player) {
  return player && (player.mode === 'space' || player.mode === 'platform')
    && !(player.isBall || player.isTeleporting || player.isDying || player.inPinball
      || player.portalTransit || state.vatsActive || state.introLocked || state.titleScreen);
}

function spawnSplash(x, y, upX, upY) {
  for (let k = 0; k < SPLASH_BITS; k++) {
    const a = Math.atan2(upY, upX) + (rnd() * 2 - 1) * 1.1;
    const speed = 1.5 + rnd() * 2.5;
    splashes.push({
      x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
      gx: -upX * 0.3, gy: -upY * 0.3,
      life: SPLASH_SECONDS, size: 1 + rnd() * 1.5,
    });
  }
}

// -> [gx, gy]
function gravityOn(d) {
  if (grid) {
    const [c, r] = cellOf(d.x, d.y);
    if (inGrid(c, r)) {
      const dome = state.skyDomePlanet;
      return [0, (dome && dome.gravityStrength) || constants.GRAVITY_STRENGTH];
    }
  }
  const p = d.planet;
  if (!p) return [0, 0];
  const s = p.gravityStrength ?? constants.GRAVITY_STRENGTH;
  if (p.isSkyDome || p.forceUprightJump) return [0, s];
  if (p.isRoundedRect) {
    const n = p.nearestSurfacePoint(d.x, d.y).normal;
    return [-n.x * s, -n.y * s];
  }
  const dx = p.pos.x - d.x, dy = p.pos.y - d.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) return [0, 0];
  return [dx / len * s, dy / len * s];
}

function spray(player, dt) {
  let empty = totalWater >= WATER_CAP;
  sprayBudget += SPRAY_PER_SECOND * (empty ? SPUTTER_FRACTION : 1) * dt;
  const [ox, oy] = player.getMuzzlePosition();
  const aim = (player.aimWorldAngle ?? 0) + (player.blasterAngleOffset ?? 0);
  let sprayPlanet = (player.onSurface && player.currentPlanet) || player.lastInfluencePlanet;
  if (sprayPlanet && sprayPlanet.isWaterPlanet && sprayPlanet.core) sprayPlanet = sprayPlanet.core;
  while (sprayBudget >= 1) {
    sprayBudget -= 1;
    empty = empty || totalWater >= WATER_CAP;
    if (droplets.length < MAX_DROPLETS) {
      const a = aim + (rnd() * 2 - 1) * SPRAY_SPREAD * (empty ? 2 : 1);
      const speed = (SPRAY_SPEED + rnd() * SPRAY_SPEED_RANGE) * (empty ? 0.4 : 1);
      droplets.push({
        x: ox, y: oy,
        vx: Math.cos(a) * speed + player.vel.x, vy: Math.sin(a) * speed + player.vel.y,
        life: DROPLET_SECONDS,
        volume: empty ? 0 : DROPLET_VOLUME,
        planet: sprayPlanet,
      });
      if (!empty) totalWater += DROPLET_VOLUME;
    }
  }
}

// Moves a droplet; true once it's landed (or gone).
function updateDroplet(d, ts, dt) {
  d.life -= dt;
  if (d.life <= 0) return true;
  const [gx, gy] = gravityOn(d);
  d.vx += gx * ts; d.vy += gy * ts;
  const px = d.x, py = d.y;
  d.x += d.vx * ts; d.y += d.vy * ts;

  const through = PortalGun.passPoint(d.x, d.y, d.vx, d.vy, 3, ts);
  if (through) {
    const to = through[4];
    [d.x, d.y, d.vx, d.vy] = through;
    if (!(to.obj.isWall || to.obj.isGate)) d.planet = to.obj;
    return false;
  }

  const volume = d.volume ?? DROPLET_VOLUME;
  if (grid) {
    const dist = Math.sqrt((d.x - px) ** 2 + (d.y - py) ** 2);
    const steps = Math.max(1, Math.ceil(dist / (CELL * 0.5)));
    let [lastC, lastR] = cellOf(px, py);
    const floorBelow = !holdsWater(d.planet);
    for (let s = 1; s <= steps; s++) {
      const x = px + (d.x - px) * s / steps, y = py + (d.y - py) * s / steps;
      const [c, r] = cellOf(x, y);
      if (inGrid(c, r) || (floorBelow && r >= grid.rows)) {
        const speed = Math.sqrt(d.vx * d.vx + d.vy * d.vy);
        if (isSolid(c, r) || ((c !== lastC || r !== lastR) && blocked(lastC, lastR, c - lastC, r - lastR))) {
          if (!isSolid(lastC, lastR)) addWater(lastC, lastR, volume);
          spawnSplash(x, y, -d.vx / speed, -d.vy / speed);
          return true;
        }
        if ((grid.water.get(r * grid.cols + c) ?? 0) >= HITS_POOL) {
          addWater(c, r, volume);
          spawnSplash(x, y, 0, -1);
          return true;
        }
      }
      lastC = c; lastR = r;
    }
  }

  const p = d.planet;
  if (grid) {
    const [c, r] = cellOf(d.x, d.y);
    if (inGrid(c, r) && !holdsWater(p)) return false;
  }
  if (holdsWater(p)) {
    const o = oceans.get(p);
    const depth = o ? depthOf(p, o.volume) : 0;
    const [sd, nx, ny] = surfaceDistance(p, d.x, d.y);
    if (sd < depth + 2) {
      if (volume > 0) addToOcean(p, volume);
      spawnSplash(d.x, d.y, nx, ny);
      return true;
    }
    return false;
  }

  if (p && !p.isSkyDome && !p.forceUprightJump) {
    let dist;
    if (p.isRoundedRect) dist = p.nearestSurfacePoint(d.x, d.y).distance;
    else dist = Math.sqrt((d.x - p.pos.x) ** 2 + (d.y - p.pos.y) ** 2) - p.radius;
    if (dist < 3) {
      const [gx2, gy2] = gravityOn(d);
      const gl = Math.sqrt(gx2 * gx2 + gy2 * gy2);
      if (gl > 0) spawnSplash(d.x, d.y, -gx2 / gl, -gy2 / gl);
      return true;
    }
  }
  return false;
}

// Level water resting against a portal's opening drains into it and
// comes out of the other portal as a jet of droplets.
const portalDrained = {};
function drainIntoPortals(dt) {
  const portals = state.portals;
  if (!(portals && portals.red && portals.blue)) return;
  for (const color of ['red', 'blue']) {
    const p = portals[color];
    if (!(p.ny < 0.3 && p.mouth)) continue;
    const cells = new Map();
    for (const m of p.mouth) {
      const x = m.x + m.nx * CELL * 0.5, y = m.y + m.ny * CELL * 0.5;
      const [c, r] = cellOf(x, y);
      if (inGrid(c, r) && !isSolid(c, r)) {
        const i = r * grid.cols + c;
        if (!cells.has(i)) cells.set(i, { x, y });
      }
    }

    const share = cells.size > 0 ? PORTAL_FLOW_PER_SECOND * dt / cells.size : 0;
    const wet = [];
    for (const [i, at] of cells) {
      let w = grid.water.get(i);
      if (w !== undefined) {
        const f = Math.min(w, share);
        w -= f;
        if (w >= DRY) grid.water.set(i, w); else grid.water.delete(i);
        portalDrained[color] = (portalDrained[color] ?? 0) + f;
        wet.push(at);
      }
    }

    while ((portalDrained[color] ?? 0) >= PORTAL_JET_VOLUME && wet.length > 0 && droplets.length < MAX_DROPLETS) {
      portalDrained[color] -= PORTAL_JET_VOLUME;
      const at = pick(wet);
      const a = Math.atan2(-p.ny, -p.nx) + (rnd() * 2 - 1) * PORTAL_JET_SPREAD;
      const speed = PORTAL_JET_SPEED + rnd() * PORTAL_JET_SPEED_RANGE;
      const res = PortalGun.throughPortal(p, at.x, at.y, Math.cos(a) * speed, Math.sin(a) * speed, 4);
      if (res) {
        const [x, y, vx, vy, to] = res;
        const intoOcean = holdsWater(to.obj);
        if (intoOcean) addToOcean(to.obj, PORTAL_JET_VOLUME);
        droplets.push({
          x, y, vx, vy, life: DROPLET_SECONDS,
          volume: intoOcean ? 0 : PORTAL_JET_VOLUME,
          planet: !(to.obj.isWall || to.obj.isGate) ? to.obj : null,
        });
      }
    }
    if (wet.length === 0) portalDrained[color] = 0;
  }
}

// A planetoid's water layer flowing through a portal under it.
const oceanDrained = {};
function drainOceansIntoPortals(dt) {
  const portals = state.portals;
  if (!(portals && portals.red && portals.blue)) return;
  for (const color of ['red', 'blue']) {
    const p = portals[color];
    const other = portals[color === 'red' ? 'blue' : 'red'];
    const o = oceans.get(p.obj);
    if (!(o && p.x != null)) continue;
    const here = depthOf(p.obj, o.volume);
    let there = 0;
    const far = oceans.get(other.obj);
    if (far) there = depthOf(other.obj, far.volume);
    const diff = here - there;
    if (diff > OCEAN_LEVEL_SLACK) {
      let f = Math.min(PORTAL_FLOW_PER_SECOND, diff * OCEAN_LEVEL_RATE) * dt;
      f = Math.min(f, o.volume);
      o.volume -= f;
      const intoOcean = holdsWater(other.obj);
      if (intoOcean) addToOcean(other.obj, f);
      oceanDrained[color] = (oceanDrained[color] ?? 0) + f;

      while (oceanDrained[color] >= PORTAL_JET_VOLUME && droplets.length < MAX_DROPLETS) {
        oceanDrained[color] -= PORTAL_JET_VOLUME;
        const m = p.mouth ? pick(p.mouth) : { x: p.x, y: p.y, nx: p.nx, ny: p.ny };
        const a = Math.atan2(-m.ny, -m.nx) + (rnd() * 2 - 1) * PORTAL_JET_SPREAD;
        const speed = PORTAL_JET_SPEED + rnd() * PORTAL_JET_SPEED_RANGE;
        const res = PortalGun.throughPortal(p, m.x + m.nx * 2, m.y + m.ny * 2,
          Math.cos(a) * speed, Math.sin(a) * speed, 4);
        if (res) {
          const [x, y, vx, vy, to] = res;
          droplets.push({
            x, y, vx, vy, life: DROPLET_SECONDS,
            volume: intoOcean ? 0 : PORTAL_JET_VOLUME,
            planet: !(to.obj.isWall || to.obj.isGate) ? to.obj : null,
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------
// Fireballs and steam
// ---------------------------------------------------------------------

function spawnSteam(x, y, upX, upY, spread) {
  const a = Math.atan2(upY, upX) + (rnd() * 2 - 1) * (spread ?? 0.6);
  const speed = STEAM_RISE * (0.5 + rnd());
  const life = STEAM_SECONDS * (0.7 + rnd() * 0.6);
  const depth = STEAM_START_DEPTH * (0.3 + rnd() * 0.7);
  x -= upX * depth; y -= upY * depth;
  steam.push({
    x: x + (rnd() * 2 - 1) * 6, y: y + (rnd() * 2 - 1) * 3,
    vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, life, maxLife: life,
  });
}

// The water line over grid cell (c, r), if it's wet.
function surfaceAt(c, r) {
  const water = grid.water, cols = grid.cols;
  let i = r * cols + c;
  if (!water.has(i)) return null;
  while (r > 0 && water.has(i - cols)) { i -= cols; r -= 1; }
  return grid.y0 + (r + 1) * CELL - Math.min(1, water.get(i)) * CELL;
}

// Boils `amount` off the surface round (c, r). -> [x, y] or null
function boilGrid(c, r, amount) {
  const water = grid.water, cols = grid.cols;
  const cells = [];
  for (let dr = -BOIL_REACH_CELLS - 2; dr <= BOIL_REACH_CELLS; dr++) {
    for (let dc = -BOIL_REACH_CELLS; dc <= BOIL_REACH_CELLS; dc++) {
      const nc = c + dc, nr = r + dr;
      if (inGrid(nc, nr)) {
        const i = nr * cols + nc;
        if (water.has(i) && (nr === 0 || !water.has(i - cols))) cells.push({ i, c: nc, r: nr });
      }
    }
  }
  if (cells.length === 0) return null;
  const share = amount / cells.length;
  for (const cell of cells) {
    const w = water.get(cell.i) - share;
    if (w < DRY) water.delete(cell.i); else water.set(cell.i, w);
  }
  const pk = pick(cells);
  return [grid.x0 + (pk.c + rnd()) * CELL, surfaceAt(pk.c, pk.r) ?? (grid.y0 + (pk.r + 1) * CELL)];
}

// Whether fireball `f` has hit water this frame. The caller removes it.
WaterSystem.quenchFireball = function (f) {
  const ts = state.timeScale ?? 1;

  for (const [p, o] of oceans) {
    const depth = depthOf(p, o.volume);
    const [d, nx, ny] = surfaceDistance(p, f.pos.x, f.pos.y);
    if (d < depth) {
      o.volume = Math.max(0, o.volume - BOIL_ON_HIT);
      const sx = f.pos.x + nx * (depth - d), sy = f.pos.y + ny * (depth - d);
      for (let k = 0; k < STEAM_BURST; k++) spawnSteam(sx, sy, nx, ny, 1.0);
      hotSpots.push({ planet: p, ox: sx - p.pos.x, oy: sy - p.pos.y, life: HOT_SECONDS, steamBudget: 0 });
      return true;
    }
  }

  if (grid) {
    const x1 = f.pos.x, y1 = f.pos.y;
    const x0 = x1 - f.vel.x * ts, y0 = y1 - f.vel.y * ts;
    const dist = Math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2);
    const steps = Math.max(1, Math.ceil(dist / (CELL * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const x = x0 + (x1 - x0) * s / steps, y = y0 + (y1 - y0) * s / steps;
      const [c, r] = cellOf(x, y);
      if (inGrid(c, r) && (grid.water.get(r * grid.cols + c) ?? 0) >= QUENCH_AT) {
        const surface = surfaceAt(c, r) ?? y;
        boilGrid(c, r, BOIL_ON_HIT);
        for (let k = 0; k < STEAM_BURST; k++) spawnSteam(x, surface, 0, -1, 1.0);
        hotSpots.push({ c, r, life: HOT_SECONDS, steamBudget: 0 });
        return true;
      }
    }
  }
  return false;
};

function updateSteam(dt) {
  const ts = state.timeScale ?? 1;
  const gameDt = ts / 60;

  for (let i = hotSpots.length - 1; i >= 0; i--) {
    const h = hotSpots[i];
    const heat = h.life / HOT_SECONDS;
    const amount = BOIL_PER_SECOND * heat * gameDt;
    let sx = null, sy, upX, upY;
    const o = h.planet ? oceans.get(h.planet) : null;
    if (h.planet) {
      if (o) {
        o.volume = Math.max(0, o.volume - amount);
        const depth = depthOf(h.planet, o.volume);
        const qx = h.planet.pos.x + h.ox + (rnd() * 2 - 1) * 20;
        const qy = h.planet.pos.y + h.oy + (rnd() * 2 - 1) * 20;
        let d;
        [d, upX, upY] = surfaceDistance(h.planet, qx, qy);
        sx = qx + upX * (depth - d); sy = qy + upY * (depth - d);
      }
    } else if (grid) {
      const res = boilGrid(h.c, h.r, amount);
      if (res) [sx, sy] = res;
      upX = 0; upY = -1;
    }
    h.steamBudget += STEAM_PER_SECOND * heat * gameDt;
    while (h.steamBudget >= 1) {
      h.steamBudget -= 1;
      if (sx != null) spawnSteam(sx, sy, upX, upY, 0.4);
    }
    h.life -= gameDt;
    if (h.life <= 0 || sx == null) hotSpots.splice(i, 1);
  }

  for (let i = steam.length - 1; i >= 0; i--) {
    const s = steam[i];
    s.life -= gameDt;
    if (s.life <= 0) {
      steam.splice(i, 1);
    } else {
      s.vx += (rnd() - 0.5) * 0.06 * ts;
      s.x += s.vx * ts; s.y += s.vy * ts;
    }
  }
}

function drawSteam() {
  const g = love.graphics;
  for (const s of steam) {
    const t = 1 - s.life / s.maxLife;
    const alpha = STEAM_ALPHA * (1 - t) * Math.min(1, 0.5 + t * 6);
    g.setColor(COLOR_STEAM[0], COLOR_STEAM[1], COLOR_STEAM[2], alpha);
    g.circle('fill', s.x, s.y, STEAM_SIZE + STEAM_GROWTH * t);
  }
  g.setColor(1, 1, 1, 1);
}

// dt: real seconds.
WaterSystem.update = function (dt) {
  age += dt;
  const ts = state.timeScale ?? 1;
  const player = state.player;

  forgetCulledOceans();
  for (const [p, o] of [...oceans]) {
    const surfaceLength = perimeterOf(p) + 2 * Math.PI * depthOf(p, o.volume);
    if (!o.natural) o.volume -= EVAPORATE_PER_SECOND * (surfaceLength / CELL) * dt * ts;
    if (o.volume <= 0.05) {
      oceans.delete(p);
      if (o.marker) o.marker.radius = p.radius;
    }
  }

  totalWater = 0;
  if (grid) for (const w of grid.water.values()) totalWater += w;
  for (const o of oceans.values()) totalWater += o.volume - (o.natural ?? 0);
  for (const d of droplets) totalWater += d.volume ?? DROPLET_VOLUME;

  const sprayHeld = state.waterMode && (love.mouse.isDown(2) || state.gamepadSprayHeld);
  isSpraying = !!(sprayHeld && canSpray(player));
  if (isSpraying) spray(player, dt * ts);
  else sprayBudget = 0;

  for (let i = droplets.length - 1; i >= 0; i--) {
    if (updateDroplet(droplets[i], ts, dt)) droplets.splice(i, 1);
  }
  updateSteam(dt);

  if (state.particles) {
    const up = Vector2.new(0, -1);
    for (const l of waterfallLandings) {
      const expected = WATERFALL_SPLASH_PER_SECOND * l.flow * dt * ts;
      const n = Math.floor(expected) + (rnd() < expected % 1 ? 1 : 0);
      for (let k = 0; k < n; k++) {
        Splash.spawn(Vector2.new(l.x + (rnd() * 2 - 1) * l.half, l.y), up, 1, WATERFALL_SPLASH);
      }
    }
  }

  for (let i = splashes.length - 1; i >= 0; i--) {
    const s = splashes[i];
    s.life -= dt;
    if (s.life <= 0) {
      splashes.splice(i, 1);
    } else {
      s.vx += s.gx * ts; s.vy += s.gy * ts;
      s.x += s.vx * ts; s.y += s.vy * ts;
    }
  }

  if (grid) {
    stepClock += dt * ts;
    let steps = 0;
    while (stepClock >= STEP_SECONDS && steps < MAX_STEPS_PER_FRAME) {
      stepWater(STEP_SECONDS);
      stepClock -= STEP_SECONDS;
      steps += 1;
    }
    if (stepClock > STEP_SECONDS) stepClock = 0;
    drainIntoPortals(dt * ts);
  }
  drainOceansIntoPortals(dt * ts);

  for (const [p, o] of oceans) {
    if (o.marker) o.marker.radius = p.radius + depthOf(p, o.volume);
  }
};

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
  return waterShader;
}

// Turns on the water shader with every setting from the tunables above.
function useWaterShader() {
  const shader = getWaterShader();
  shader.send('time', age);
  shader.send('colorShallow', COLOR_SHALLOW);
  shader.send('colorDeep', COLOR_DEEP);
  shader.send('deepAt', DEEP_AT);
  shader.send('alphaShallow', ALPHA_SHALLOW);
  shader.send('alphaDeep', ALPHA_DEEP);
  shader.send('colorSurface', COLOR_SURFACE);
  shader.send('surfaceLine', SURFACE_LINE);
  shader.send('surfaceFeather', SURFACE_FEATHER);
  shader.send('surfaceGlow', SURFACE_GLOW);
  shader.send('colorCaustic', COLOR_CAUSTIC);
  shader.send('causticScale', CAUSTIC_SCALE);
  shader.send('bulgeCenter', [0, 0]);
  shader.send('bulgeRadius', 1);
  shader.send('causticBulge', 0);
  shader.send('sphereShading', 0);
  shader.send('sunDir', [1, 0]);
  shader.send('sphereShallow', SPHERE_COLOR_SHALLOW);
  shader.send('sphereDeep', SPHERE_COLOR_DEEP);
  shader.send('sphereShade', SPHERE_COLOR_SHADE);
  shader.send('sphereShadeStrength', SPHERE_SHADE_STRENGTH);
  shader.send('sphereRim', SPHERE_COLOR_RIM);
  shader.send('sphereRimStrength', SPHERE_RIM_STRENGTH);
  shader.send('sphereReflected', SPHERE_COLOR_REFLECTED);
  shader.send('sphereReflectedStrength', SPHERE_REFLECTED_STRENGTH);
  shader.send('causticSpeed', CAUSTIC_SPEED);
  shader.send('causticStrength', CAUSTIC_STRENGTH);
  love.graphics.setShader(shader);
}

// The water on the level, as one mesh drawn through the pool shader.
function drawPools() {
  const cam = state.camera;
  if (!cam) return;
  const vx0 = cam.x - CELL, vy0 = cam.y - CELL;
  const vx1 = cam.x + (state.visibleWidth ?? 0) + CELL, vy1 = cam.y + (state.visibleHeight ?? 0) + CELL;
  const cols = grid.cols, water = grid.water;
  const has = (i) => water.has(i);
  const verts = [];
  waterfallLandings = [];

  const quad = (x0, yTop0, x1, yTop1, yBottom0, yBottom1, depthTop, depthBottom, stream) => {
    const v1 = [x0, yTop0, depthTop, stream, 1, 1, 1, 1];
    const v2 = [x1, yTop1, depthTop, stream, 1, 1, 1, 1];
    const v3 = [x1, yBottom1, depthBottom, stream, 1, 1, 1, 1];
    const v4 = [x0, yBottom0, depthBottom, stream, 1, 1, 1, 1];
    verts.push(v1, v2, v3, v1, v3, v4);
  };
  const ripple = (x) => Math.sin(age * 2.2 + x * 0.045) * 1.3 + Math.sin(age * 3.7 - x * 0.11) * 0.6;

  // The water resting in each column, as one stack from its floor up.
  const stackSurface = new Map(), stackTotal = new Map(), stackFloor = new Map();
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
    const surface = grid.y0 + (r + 1) * CELL - Math.max(2, total * CELL);
    for (const m of members) {
      stackSurface.set(m, surface);
      stackTotal.set(m, total);
      stackFloor.set(m, i);
    }
  }

  const isFalling = (i) => !stackSurface.has(i);

  const slope = grid.slope;
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
      if (nr >= 0 && nr < grid.rows) {
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
    const x0 = grid.x0 + c * CELL;
    const yTopCell = grid.y0 + r * CELL;
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
      while (gap < STREAM_REACH_CELLS && jr < grid.rows && !has(j) && !blocked(c, jr - 1, 0, 1)) {
        j += cols; jr += 1; gap += 1;
        streamBottom += CELL;
      }
      if (has(j) && jr < grid.rows && !isFalling(j)) {
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
        if (streamBottom - fallTop >= WATERFALL_SPLASH_MIN_FALL) {
          waterfallLandings.push({ x: mid, y: streamBottom, half, flow: Math.min(1, w * 4) });
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
        const neighborSurface = (dc) => {
          const nc = c + dc;
          if (nc < 0 || nc >= cols) return surface;
          const j = i + dc;
          const s = surfaceY(j) ?? surfaceY(j + cols) ?? surfaceY(j - cols);
          if (s == null || Math.abs(s - surface) > CELL * 1.5) return surface;
          return s;
        };
        const left = neighborSurface(-1), right = neighborSurface(1);
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
          const ta = Math.min(ha + ripple(xa), bottom - 1);
          const tb = Math.min(hb + ripple(xb), bottom - 1);
          const ba = bottomAt(xa), bb = bottomAt(xb);
          quad(xa, ta, xb, tb, ba, bb, 0, (ba + bb) / 2 - (ha + hb) / 2, 0);
          quad(xa, ta - SURFACE_FEATHER, xb, tb - SURFACE_FEATHER, ta, tb, -SURFACE_FEATHER, 0, 0);
        }
      }
    }
  }

  if (verts.length === 0) return;
  if (!mesh || meshSize < verts.length) {
    meshSize = Math.max(verts.length, meshSize * 2, 600);
    mesh = love.graphics.newMesh(meshSize, 'triangles', 'stream');
  }
  mesh.setVertices(verts);
  mesh.setDrawRange(0, verts.length);
  useWaterShader();
  love.graphics.setColor(1, 1, 1, 1);
  love.graphics.draw(mesh);
  love.graphics.setShader();
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
  if (!cam || oceans.size === 0) return;
  const vx0 = cam.x, vy0 = cam.y;
  const vx1 = cam.x + (state.visibleWidth ?? 0), vy1 = cam.y + (state.visibleHeight ?? 0);
  let shaderOn = false;
  for (const [p, o] of oceans) {
    const depth = depthOf(p, o.volume);
    const reach = p.radius + depth + SURFACE_FEATHER + 6;
    if (!(p.pos.x + reach > vx0 && p.pos.x - reach < vx1 && p.pos.y + reach > vy0 && p.pos.y - reach < vy1)) continue;
    const verts = [];
    const vert = (x, y, d, alpha) => verts.push([x, y, d, 0, 1, 1, 1, alpha ?? 1]);
    const cx = p.pos.x, cy = p.pos.y;
    const outline = outlineOf(p, depth);
    const n = outline.length;
    const top = (q) => {
      const rip = Math.sin(age * 2.2 + q.s * 0.045) * 1.3 + Math.sin(age * 3.7 - q.s * 0.11) * 0.6;
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

    if (!oceanMesh || oceanMeshSize < verts.length) {
      oceanMeshSize = Math.max(verts.length, oceanMeshSize * 2, 600);
      oceanMesh = love.graphics.newMesh(oceanMeshSize, 'triangles', 'stream');
    }
    oceanMesh.setVertices(verts);
    oceanMesh.setDrawRange(0, verts.length);
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
WaterSystem.draw = function () {
  const g = love.graphics;
  if (grid) drawPools();

  g.setLineWidth(2.5);
  for (const d of droplets) {
    const speed = Math.sqrt(d.vx * d.vx + d.vy * d.vy);
    const tail = Math.min(10, speed * 0.8) / Math.max(speed, 0.001);
    g.setColor(COLOR_DROPLET[0], COLOR_DROPLET[1], COLOR_DROPLET[2], COLOR_DROPLET[3] * 0.6);
    g.line(d.x - d.vx * tail, d.y - d.vy * tail, d.x, d.y);
    g.setColor(COLOR_DROPLET);
    g.circle('fill', d.x, d.y, 2.2);
  }
  g.setLineWidth(1);
  for (const s of splashes) {
    g.setColor(COLOR_DROPLET[0], COLOR_DROPLET[1], COLOR_DROPLET[2], s.life / SPLASH_SECONDS);
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

WaterSystem.isSpraying = () => isSpraying;
WaterSystem.totalWater = () => Math.max(0, totalWater);
WaterSystem.waterCap = () => WATER_CAP;
WaterSystem.debugOcean = (p) => (oceans.has(p) ? oceans.get(p).volume : 0);
// -> [grid, isSolid, CELL]
WaterSystem.debugGrid = () => [grid, isSolid, CELL];

export default WaterSystem;
