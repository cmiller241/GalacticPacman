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
// it (an "ocean"). On a dirt planet (CrackedPlanetoid.js — one built from
// a Tiled map, say) it's the same water as the level's on a grid of the
// planet's own, bent round it, with "down" toward its center (see "Water
// on a dirt planet"). Anywhere else it just splashes.
//
// Bob swims in water deep enough to cover his middle (see submergedAt and
// Player.js's submergedIn). Fireballs boil it (quenchFireball).
//
// Port notes: grid.water is a Map keyed by the 0-based cell index
// r * cols + c (Lua's was 1-based); oceans is a Map keyed by planetoid.
//
// The parts are in js/systems/water/ (split the same way as lua/systems/water/):
//   Tuning.js       every tunable number and color
//   Shared.js       the state the parts share (shared), and scratch buffers
//   Oceans.js       water layers on round planetoids
//   LevelGrid.js    the Tiled level's water grid and its stepping
//   PlanetGrids.js  water on dirt planets
//   Effects.js      splashes and steam
//   Obsidian.js     lava meeting water
//   Ice.js          the ice blaster's blocks
//   Rendering.js    drawing water and lava
// This file has spraying, droplets, portals, fireballs going out, the
// per-frame update and the public functions.

import love from '../love/index.js';
import state from '../state.js';
import constants from '../constants.js';
import Vector2 from '../vector2.js';
import utils from '../utils.js';
import PortalGun from './PortalGun.js';
import Splash from '../effects/Splash.js';
import {
  CELL, STEP_SECONDS, MAX_STEPS_PER_FRAME, EVAPORATE_PER_SECOND, DRY,
  SPRAY_PER_SECOND, SPRAY_SPEED, SPRAY_SPEED_RANGE, SPRAY_SPREAD,
  DROPLET_VOLUME, DROPLET_SECONDS, MAX_DROPLETS, HITS_POOL,
  PORTAL_FLOW_PER_SECOND, PORTAL_JET_VOLUME, OCEAN_LEVEL_RATE,
  OCEAN_LEVEL_SLACK, PORTAL_JET_SPEED, PORTAL_JET_SPEED_RANGE,
  PORTAL_JET_SPREAD, WATER_CAP, SPUTTER_FRACTION, WATERFALL_SPLASH_PER_SECOND,
  WATERFALL_SPLASH, QUENCH_AT, BOIL_ON_HIT, HOT_SECONDS, STEAM_BURST,
  LAVA_TUNING,
} from './water/Tuning.js';
import { shared, rnd, pick, Ice, WATER, LAVA } from './water/Shared.js';
import {
  api as OceansApi, holdsWater, perimeterOf, depthOf, surfaceDistance,
  addToOcean, forgetCulledOceans,
} from './water/Oceans.js';
import {
  api as LevelGridApi, cellOf, inGrid, isSolid, blocked, addWater, stepWater,
  surfaceAt, boilGrid,
} from './water/LevelGrid.js';
import {
  PLANET_GRID_MAKE_DISTANCE, planetUp, planetIndex, sweepTurningPlanetGrid,
  newPlanetGrid, planetCellOf, catchUpPlanetGrid, planetSolid, addPlanetWater,
  convertPlanetGrid, planetGridAt, stepPlanetWater, planetSurfaceAt,
  boilPlanetGrid,
} from './water/PlanetGrids.js';
import { spawnSplash, spawnSteam, updateSteam } from './water/Effects.js';
import {
  api as ObsidianApi, quenchLevelLava, quenchPlanetLava, updateObsidians,
  updateLavaEmbers,
} from './water/Obsidian.js';
import { api as IceApi } from './water/Ice.js';
import { api as RenderingApi } from './water/Rendering.js';

const WaterSystem = {};

// The functions the parts add to WaterSystem.
for (const part of [OceansApi, LevelGridApi, ObsidianApi, IceApi, RenderingApi]) {
  for (const [name, value] of Object.entries(part)) {
    if (name in WaterSystem) throw new Error(`WaterSystem.${name} is defined twice`);
    WaterSystem[name] = value;
  }
}

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------

// (The state the parts share is in water/Shared.js's shared table.)
let sprayBudget = 0;
let isSpraying = false;
let totalWater = 0;
let stepClock = 0;
let lavaStepCount = 0;   // (see LAVA_TUNING.STEP_EVERY)

// What a pool is to Bob while he's in one (Player.submergedIn): a huge
// round body centered far below him, its radius reaching up to the surface.
const poolWater = { isPool: true, pos: Vector2.new(0, 0), radius: 0 };

WaterSystem.reset = function () {
  shared.grid = null;
  shared.droplets = []; shared.splashes = []; shared.waterfallLandings = [];
  shared.steam = []; shared.hotSpots = [];
  shared.lavaEmbers = []; shared.obsidians = []; lavaStepCount = 0;
  Ice.blocks = []; Ice.frame = 0;
  sprayBudget = 0; stepClock = 0;
  isSpraying = false;
  totalWater = 0;
  shared.oceans = new Map();
  shared.planetGrids = new Map();
};

// ---------------------------------------------------------------------
// Swimming
// ---------------------------------------------------------------------

// Whether (x, y) is in real water (not just a damp film).
WaterSystem.wetAt = function (x, y) {
  const pg = planetGridAt(x, y);
  if (pg) {
    const [c, r, rr] = planetCellOf(pg, x, y);
    const i = planetIndex(pg, c, r);
    if (i === null) return false;
    const w = pg.water.get(i);
    if (r > 0 && pg.water.has(i - pg.cols)) return true;
    return w !== undefined && w >= 0.3 && rr < pg.top - (r + 1) * CELL + w * CELL;
  }
  if (!shared.grid) return false;
  const [c, r] = cellOf(x, y);
  if (!inGrid(c, r)) return false;
  const i = r * shared.grid.cols + c;
  const w = shared.grid.water.get(i);
  if (r > 0 && shared.grid.water.has(i - shared.grid.cols)) return true;
  return w !== undefined && w >= 0.3 && y > shared.grid.y0 + (r + 1) * CELL - w * CELL;
};

// The water Bob's middle is under, if any (see Player.js's submergedIn).
WaterSystem.submergedAt = function (player) {
  const x = player.pos.x, y = player.pos.y;
  for (const [p, o] of shared.oceans) {
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
  // A dirt planet's water: the same trick, with "straight up" being
  // straight out from the planet's center.
  const pg = planetGridAt(x, y);
  if (pg) {
    const [c, r, rr] = planetCellOf(pg, x, y);
    const i = planetIndex(pg, c, r);
    if (i === null) return null;
    const w = pg.water.get(i);
    const covered = (r > 0 && pg.water.has(i - pg.cols)) || (w !== undefined && rr < pg.top - (r + 1) * CELL + w * CELL);
    if (!covered) return null;
    const surfaceR = planetSurfaceAt(pg, c, r) ?? rr;
    // (Up: out from the planet's center — or up the screen, or down it,
    // with its gravity switched.)
    const [ux, uy] = planetUp(pg, x - pg.planet.pos.x, y - pg.planet.pos.y);
    const far = 100000;
    poolWater.pos.x = x - ux * far; poolWater.pos.y = y - uy * far;
    poolWater.radius = far + (surfaceR - rr);
    return poolWater;
  }

  if (!shared.grid) return null;
  const [c, r] = cellOf(x, y);
  if (!inGrid(c, r)) return null;
  const i = r * shared.grid.cols + c;
  const w = shared.grid.water.get(i);
  const covered = (r > 0 && shared.grid.water.has(i - shared.grid.cols))
    || (w !== undefined && y > shared.grid.y0 + (r + 1) * CELL - w * CELL);
  if (!covered) return null;
  let top = r;
  while (top > 0 && shared.grid.water.has((top - 1) * shared.grid.cols + c)) top -= 1;
  const surfaceY = shared.grid.y0 + (top + 1) * CELL - Math.min(1, shared.grid.water.get(top * shared.grid.cols + c) ?? 1) * CELL;
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

// -> [gx, gy]
function gravityOn(d) {
  if (shared.grid) {
    const [c, r] = cellOf(d.x, d.y);
    if (inGrid(c, r)) {
      const dome = state.skyDomePlanet;
      return [0, (dome && dome.gravityStrength) || constants.GRAVITY_STRENGTH];
    }
  }
  const p = d.planet;
  if (!p) return [0, 0];
  const s = p.gravityStrength ?? constants.GRAVITY_STRENGTH;
  // Straight "down" for wherever it is: opposite the planet's own "up"
  // (see js/world/PlanetSurface.js) — so on the dome's deck and Tiled
  // ground it falls straight down the screen, and onto the nearest face
  // of a rounded rectangle.
  const up = p.upAt(d.x, d.y);
  return [-up.x * s, -up.y * s];
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
    if (shared.droplets.length < MAX_DROPLETS) {
      const a = aim + (rnd() * 2 - 1) * SPRAY_SPREAD * (empty ? 2 : 1);
      const speed = (SPRAY_SPEED + rnd() * SPRAY_SPEED_RANGE) * (empty ? 0.4 : 1);
      shared.droplets.push({
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
  // (A droplet of lava — out of a portal lava's run into, see
  // drainIntoPortals — lands as lava. Either kind lands in a pool of
  // either: water and lava meeting that way turn to obsidian.)
  const key = d.lava ? 'lava' : 'water';
  const lava = !!d.lava;

  // Onto a dirt planet's water grid: the same landing as on the level's
  // (below), in its own cells.
  const pg = planetGridAt(d.x, d.y);
  if (pg) {
    const dist = Math.sqrt((d.x - px) ** 2 + (d.y - py) ** 2);
    const steps = Math.max(1, Math.ceil(dist / (CELL * 0.5)));
    let [lastC, lastR] = planetCellOf(pg, px, py);
    for (let s = 1; s <= steps; s++) {
      const x = px + (d.x - px) * s / steps, y = py + (d.y - py) * s / steps;
      const [c, r] = planetCellOf(pg, x, y);
      if (planetSolid(pg, c, r)) {
        if (!planetSolid(pg, lastC, lastR)) addPlanetWater(pg, lastC, lastR, volume, key);
        const speed = Math.max(1e-6, Math.sqrt(d.vx * d.vx + d.vy * d.vy));
        spawnSplash(x, y, -d.vx / speed, -d.vy / speed, lava);
        return true;
      }
      const hit = planetIndex(pg, c, r);
      if (hit !== null && (pg.water.get(hit) ?? 0) + (pg.lava.get(hit) ?? 0) >= HITS_POOL) {
        addPlanetWater(pg, c, r, volume, key);
        const [ux, uy] = planetUp(pg, x - pg.planet.pos.x, y - pg.planet.pos.y);
        spawnSplash(x, y, ux, uy, lava);
        return true;
      }
      lastC = c; lastR = r;
    }
    return false;
  }

  if (shared.grid) {
    const dist = Math.sqrt((d.x - px) ** 2 + (d.y - py) ** 2);
    const steps = Math.max(1, Math.ceil(dist / (CELL * 0.5)));
    let [lastC, lastR] = cellOf(px, py);
    const floorBelow = !holdsWater(d.planet);
    for (let s = 1; s <= steps; s++) {
      const x = px + (d.x - px) * s / steps, y = py + (d.y - py) * s / steps;
      const [c, r] = cellOf(x, y);
      if (inGrid(c, r) || (floorBelow && r >= shared.grid.rows)) {
        const speed = Math.sqrt(d.vx * d.vx + d.vy * d.vy);
        if (isSolid(c, r) || ((c !== lastC || r !== lastR) && blocked(lastC, lastR, c - lastC, r - lastR))) {
          if (!isSolid(lastC, lastR)) addWater(lastC, lastR, volume, key);
          spawnSplash(x, y, -d.vx / speed, -d.vy / speed, lava);
          return true;
        }
        const i = r * shared.grid.cols + c;
        if ((shared.grid.water.get(i) ?? 0) + (shared.grid.lava.get(i) ?? 0) >= HITS_POOL) {
          addWater(c, r, volume, key);
          spawnSplash(x, y, 0, -1, lava);
          return true;
        }
      }
      lastC = c; lastR = r;
    }
  }

  const p = d.planet;
  if (shared.grid) {
    const [c, r] = cellOf(d.x, d.y);
    if (inGrid(c, r) && !holdsWater(p)) return false;
  }
  if (holdsWater(p)) {
    const o = shared.oceans.get(p);
    const depth = o ? depthOf(p, o.volume) : 0;
    const [sd, nx, ny] = surfaceDistance(p, d.x, d.y);
    if (sd < depth + 2) {
      if (lava) {
        // (Lava into a planetoid's water goes out in a puff of steam;
        // onto a bare one, it splashes and is gone.)
        if (depth > 0) { for (let k = 0; k < 4; k++) spawnSteam(d.x, d.y, nx, ny, 0.8); }
        else spawnSplash(d.x, d.y, nx, ny, true);
        return true;
      }
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
      if (gl > 0) spawnSplash(d.x, d.y, -gx2 / gl, -gy2 / gl, lava);
      return true;
    }
  }
  return false;
}

// Level water resting against a portal's opening drains into it and
// comes out of the other portal as a jet of droplets.
// (The same for a dirt planet's water — see "Water on a dirt planet" —
// on whichever grid the water just in front of a portal is in: there,
// a ceiling portal is one facing in toward the planet's center.)
// Lava goes through the same way, more slowly (LAVA_TUNING.PORTAL_FLOW),
// as a jet of lava droplets that land as lava.
const portalDrained = {}; // (keyed by portal color and liquid: 'redwater', 'bluelava', ...)
const portalTakenIn = {}; // (all-time totals of water, per portal color: see WaterSystem.debugPortalFlow)
function drainIntoPortals(dt) {
  const portals = state.portals;
  if (!(portals && portals.red && portals.blue)) return;
  for (const color of ['red', 'blue']) {
    const p = portals[color];
    if (!p.mouth) continue;
    // The open cells just in front of its opening, on the level's grid
    // or a planet's, each with the grid it's in — left out wherever the
    // opening faces down (nothing flows up into it).
    const cells = []; // { g, i, at }
    const seen = new Set();
    for (const m of p.mouth) {
      const x = m.x + m.nx * CELL * 0.5, y = m.y + m.ny * CELL * 0.5;
      const pg = planetGridAt(x, y);
      let g = null, i = 0;
      if (pg) {
        const [c, r] = planetCellOf(pg, x, y);
        const [ux, uy] = planetUp(pg, x - pg.planet.pos.x, y - pg.planet.pos.y);
        const facingDown = -(m.nx * ux + m.ny * uy) > 0.3;
        const k = planetIndex(pg, c, r);
        if (k !== null && !planetSolid(pg, c, r) && !facingDown) { g = pg; i = k; }
      } else if (shared.grid && m.ny < 0.3) {
        const [c, r] = cellOf(x, y);
        if (inGrid(c, r) && !isSolid(c, r)) { g = shared.grid; i = r * shared.grid.cols + c; }
      }
      if (g) {
        const key = (g === shared.grid ? 'level:' : 'planet:') + i + ':' + (pg ? pg.cols : 0);
        if (!seen.has(key)) { seen.add(key); cells.push({ g, i, at: { x, y } }); }
      }
    }

    for (const liquid of [WATER, LAVA]) {
      const slot = color + liquid.key;
      const flow = liquid === LAVA ? LAVA_TUNING.PORTAL_FLOW : PORTAL_FLOW_PER_SECOND;
      const share = cells.length > 0 ? flow * dt / cells.length : 0;
      const wet = [];
      for (const { g, i, at } of cells) {
        const store = g[liquid.key];
        let w = store.get(i);
        if (w !== undefined) {
          const f = Math.min(w, share);
          w -= f;
          if (w >= DRY) store.set(i, w); else store.delete(i);
          portalDrained[slot] = (portalDrained[slot] ?? 0) + f;
          if (liquid === WATER) portalTakenIn[color] = (portalTakenIn[color] ?? 0) + f;
          wet.push(at);
        }
      }

      while ((portalDrained[slot] ?? 0) >= PORTAL_JET_VOLUME && wet.length > 0 && shared.droplets.length < MAX_DROPLETS) {
        portalDrained[slot] -= PORTAL_JET_VOLUME;
        const at = pick(wet);
        const a = Math.atan2(-p.ny, -p.nx) + (rnd() * 2 - 1) * PORTAL_JET_SPREAD;
        const speed = PORTAL_JET_SPEED + rnd() * PORTAL_JET_SPEED_RANGE;
        const res = PortalGun.throughPortal(p, at.x, at.y, Math.cos(a) * speed, Math.sin(a) * speed, 4);
        if (res) {
          const [x, y, vx, vy, to] = res;
          // Water out onto a round planetoid: straight into its water, the
          // jet just for show.
          const intoOcean = liquid === WATER && holdsWater(to.obj);
          if (intoOcean) addToOcean(to.obj, PORTAL_JET_VOLUME);
          shared.droplets.push({
            x, y, vx, vy, life: DROPLET_SECONDS,
            volume: intoOcean ? 0 : PORTAL_JET_VOLUME,
            planet: !(to.obj.isWall || to.obj.isGate) ? to.obj : null,
            lava: liquid === LAVA || undefined,
          });
        }
      }
      if (wet.length === 0) portalDrained[slot] = 0;
    }
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
    const o = shared.oceans.get(p.obj);
    if (!(o && p.x != null)) continue;
    const here = depthOf(p.obj, o.volume);
    let there = 0;
    const far = shared.oceans.get(other.obj);
    if (far) there = depthOf(other.obj, far.volume);
    const diff = here - there;
    if (diff > OCEAN_LEVEL_SLACK) {
      let f = Math.min(PORTAL_FLOW_PER_SECOND, diff * OCEAN_LEVEL_RATE) * dt;
      f = Math.min(f, o.volume);
      o.volume -= f;
      const intoOcean = holdsWater(other.obj);
      if (intoOcean) addToOcean(other.obj, f);
      oceanDrained[color] = (oceanDrained[color] ?? 0) + f;

      while (oceanDrained[color] >= PORTAL_JET_VOLUME && shared.droplets.length < MAX_DROPLETS) {
        oceanDrained[color] -= PORTAL_JET_VOLUME;
        const m = p.mouth ? pick(p.mouth) : { x: p.x, y: p.y, nx: p.nx, ny: p.ny };
        const a = Math.atan2(-m.ny, -m.nx) + (rnd() * 2 - 1) * PORTAL_JET_SPREAD;
        const speed = PORTAL_JET_SPEED + rnd() * PORTAL_JET_SPEED_RANGE;
        const res = PortalGun.throughPortal(p, m.x + m.nx * 2, m.y + m.ny * 2,
          Math.cos(a) * speed, Math.sin(a) * speed, 4);
        if (res) {
          const [x, y, vx, vy, to] = res;
          shared.droplets.push({
            x, y, vx, vy, life: DROPLET_SECONDS,
            volume: intoOcean ? 0 : PORTAL_JET_VOLUME,
            planet: !(to.obj.isWall || to.obj.isGate) ? to.obj : null,
          });
        }
      }
    }
  }
}


// Whether fireball `f` has hit water this frame. The caller removes it.
WaterSystem.quenchFireball = function (f) {
  const ts = state.timeScale ?? 1;

  for (const [p, o] of shared.oceans) {
    const depth = depthOf(p, o.volume);
    const [d, nx, ny] = surfaceDistance(p, f.pos.x, f.pos.y);
    if (d < depth) {
      o.volume = Math.max(0, o.volume - BOIL_ON_HIT);
      const sx = f.pos.x + nx * (depth - d), sy = f.pos.y + ny * (depth - d);
      for (let k = 0; k < STEAM_BURST; k++) spawnSteam(sx, sy, nx, ny, 1.0);
      shared.hotSpots.push({ planet: p, ox: sx - p.pos.x, oy: sy - p.pos.y, life: HOT_SECONDS, steamBudget: 0 });
      return true;
    }
  }

  // A dirt planet's water.
  {
    const x1 = f.pos.x, y1 = f.pos.y;
    const x0 = x1 - f.vel.x * ts, y0 = y1 - f.vel.y * ts;
    const dist = Math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2);
    const steps = Math.max(1, Math.ceil(dist / (CELL * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const x = x0 + (x1 - x0) * s / steps, y = y0 + (y1 - y0) * s / steps;
      const pg = planetGridAt(x, y);
      if (!pg) continue;
      const [c, r] = planetCellOf(pg, x, y);
      const qi = planetIndex(pg, c, r);
      if (qi !== null && (pg.water.get(qi) ?? 0) >= QUENCH_AT) {
        const res = boilPlanetGrid(pg, c, r, BOIL_ON_HIT);
        if (res) for (let k = 0; k < STEAM_BURST; k++) spawnSteam(res[0], res[1], res[2], res[3], 1.0);
        shared.hotSpots.push({ pg, c, r, life: HOT_SECONDS, steamBudget: 0 });
        return true;
      }
    }
  }

  if (shared.grid) {
    const x1 = f.pos.x, y1 = f.pos.y;
    const x0 = x1 - f.vel.x * ts, y0 = y1 - f.vel.y * ts;
    const dist = Math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2);
    const steps = Math.max(1, Math.ceil(dist / (CELL * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const x = x0 + (x1 - x0) * s / steps, y = y0 + (y1 - y0) * s / steps;
      const [c, r] = cellOf(x, y);
      if (inGrid(c, r) && (shared.grid.water.get(r * shared.grid.cols + c) ?? 0) >= QUENCH_AT) {
        const surface = surfaceAt(c, r) ?? y;
        boilGrid(c, r, BOIL_ON_HIT);
        for (let k = 0; k < STEAM_BURST; k++) spawnSteam(x, surface, 0, -1, 1.0);
        shared.hotSpots.push({ c, r, life: HOT_SECONDS, steamBudget: 0 });
        return true;
      }
    }
  }
  return false;
};

// dt: real seconds.
WaterSystem.update = function (dt) {
  shared.age += dt;
  const ts = state.timeScale ?? 1;
  const player = state.player;

  forgetCulledOceans();
  for (const [p, o] of [...shared.oceans]) {
    const surfaceLength = perimeterOf(p) + 2 * Math.PI * depthOf(p, o.volume);
    if (!o.natural) o.volume -= EVAPORATE_PER_SECOND * (surfaceLength / CELL) * dt * ts;
    if (o.volume <= 0.05) {
      shared.oceans.delete(p);
      if (o.marker) o.marker.radius = p.radius;
    }
  }

  // Dirt planets' water grids: one for each dirt planet he's anywhere
  // near (made the first time he is), caught up with any dirt blown out.
  if (player) {
    for (const p of state.planetoids ?? []) {
      if (p.isCrackedPlanet && p.rings && p.rings[0] && !shared.planetGrids.has(p)) {
        const dx = player.pos.x - p.pos.x, dy = player.pos.y - p.pos.y;
        const near = p.radius + PLANET_GRID_MAKE_DISTANCE;
        if (dx * dx + dy * dy < near * near) shared.planetGrids.set(p, newPlanetGrid(p));
      }
    }
  }
  for (const g of shared.planetGrids.values()) {
    // (Its gravity switched — see convertPlanetGrid. The fireballs' hot
    // spots there are forgotten: their cells have moved.)
    const mode = g.planet.gravityMode ?? 'core';
    if (g.mode !== mode) {
      convertPlanetGrid(g, mode);
      shared.hotSpots = shared.hotSpots.filter((h) => h.pg !== g);
    }
    catchUpPlanetGrid(g);
    sweepTurningPlanetGrid(g);
  }

  totalWater = 0;
  if (shared.grid) for (const w of shared.grid.water.values()) totalWater += w;
  for (const g of shared.planetGrids.values()) for (const w of g.water.values()) totalWater += w;
  for (const o of shared.oceans.values()) totalWater += o.volume - (o.natural ?? 0);
  for (const d of shared.droplets) if (!d.lava) totalWater += d.volume ?? DROPLET_VOLUME; // (lava's not water)

  const sprayHeld = state.waterMode && (love.mouse.isDown(1) || state.gamepadSprayHeld);
  isSpraying = !!(sprayHeld && canSpray(player));
  if (isSpraying) spray(player, dt * ts);
  else sprayBudget = 0;

  let gone = null;
  for (let i = shared.droplets.length - 1; i >= 0; i--) {
    const d = shared.droplets[i];
    if (updateDroplet(d, ts, dt)) (gone ??= new Set()).add(d);
  }
  if (gone) utils.removeMarked(shared.droplets, gone);
  updateSteam(dt);

  if (state.particles) {
    const up = Vector2.new(0, -1);
    for (const l of shared.waterfallLandings) {
      const expected = WATERFALL_SPLASH_PER_SECOND * l.flow * dt * ts;
      const n = Math.floor(expected) + (rnd() < expected % 1 ? 1 : 0);
      for (let k = 0; k < n; k++) {
        Splash.spawn(Vector2.new(l.x + (rnd() * 2 - 1) * l.half, l.y), up, 1, WATERFALL_SPLASH);
      }
    }
  }

  gone = null;
  for (let i = shared.splashes.length - 1; i >= 0; i--) {
    const s = shared.splashes[i];
    s.life -= dt;
    if (s.life <= 0) {
      (gone ??= new Set()).add(s);
    } else {
      s.vx += s.gx * ts; s.vy += s.gy * ts;
      s.x += s.vx * ts; s.y += s.vy * ts;
    }
  }
  if (gone) utils.removeMarked(shared.splashes, gone);

  if (shared.grid || shared.planetGrids.size > 0) {
    stepClock += dt * ts;
    let steps = 0;
    while (stepClock >= STEP_SECONDS && steps < MAX_STEPS_PER_FRAME) {
      if (shared.grid) stepWater(STEP_SECONDS);
      for (const g of shared.planetGrids.values()) stepPlanetWater(g, STEP_SECONDS);
      // (The lava, more slowly — see LAVA_TUNING.STEP_EVERY.)
      lavaStepCount += 1;
      if (lavaStepCount >= LAVA_TUNING.STEP_EVERY) {
        lavaStepCount = 0;
        if (shared.grid) stepWater(STEP_SECONDS, LAVA);
        for (const g of shared.planetGrids.values()) stepPlanetWater(g, STEP_SECONDS, LAVA);
      }
      stepClock -= STEP_SECONDS;
      steps += 1;
    }
    if (stepClock > STEP_SECONDS) stepClock = 0;
    drainIntoPortals(dt * ts);
  }
  // Lava and water meeting (see "Lava meeting water: obsidian").
  if (shared.grid) quenchLevelLava();
  for (const g of shared.planetGrids.values()) quenchPlanetLava(g);
  updateObsidians();
  Ice.update();
  updateLavaEmbers();
  drainOceansIntoPortals(dt * ts);

  for (const [p, o] of shared.oceans) {
    if (o.marker) o.marker.radius = p.radius + depthOf(p, o.volume);
  }
};

WaterSystem.isSpraying = () => isSpraying;
WaterSystem.totalWater = () => Math.max(0, totalWater);
WaterSystem.waterCap = () => WATER_CAP;
WaterSystem.debugOcean = (p) => (shared.oceans.has(p) ? shared.oceans.get(p).volume : 0);
// -> [grid, isSolid, CELL]
WaterSystem.debugGrid = () => [shared.grid, isSolid, CELL];
// For debugging/tests: the obsidian blocks (see "Lava meeting water").
WaterSystem.debugObsidians = () => shared.obsidians;
// For debugging/tests: planet p's water grid, if it has one (see "Water on
// a dirt planet"), and its cell lookup and solid test: [grid, cellOf, solid, CELL].
WaterSystem.debugPlanetGrid = (p) => [shared.planetGrids.get(p) ?? null, planetCellOf, planetSolid, CELL];
// For debugging/tests: how much resting water each portal has taken in
// (cells' worth, all-time): { red, blue }.
WaterSystem.debugPortalFlow = () => portalTakenIn;

export default WaterSystem;
