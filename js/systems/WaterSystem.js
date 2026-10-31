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

import love from '../love/index.js';
import lua from '../love/lua.js';
import state from '../state.js';
import constants from '../constants.js';
import Vector2 from '../vector2.js';
import PortalGun from './PortalGun.js';
import Splash from '../effects/Splash.js';
import Lava from '../world/Lava.js';
import TiledTerrain from '../world/TiledTerrain.js';
import IceBolt from '../entities/IceBolt.js';

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
// Sideways passes each step: water falls a cell a step, but spreads this
// many times a step — so what lands (under a waterfall, say) runs out
// across the floor and finds its level quickly, like water, instead of
// heaping up and oozing outward like gel. (Falling stays a cell a step.)
const SPREAD_PASSES = 4;
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

// Lava (see "Lava meeting water" below): a second liquid on the same
// grids, moving by the same rules as the water — falling, running down
// slopes, spreading out along what it's resting on, filling pits — but
// thick and slow. (One object, as in the Lua, where a file's limited to
// 200 locals.)
const LAVA_TUNING = {
  STEP_EVERY: 4,        // it moves one step for every this many of the water's
  SPREAD: 0.2,          // (water: SPREAD)
  SPREAD_PASSES: 1,     // (water: SPREAD_PASSES — lava oozes out rather than racing to level)
  MIN_SPREAD: 0.35,     // thinner than this it stays put, so it lies in a thick layer instead of filming out
  RIPPLE: 0.4,          // its surface moves this much as much as water's
  TOUCH: 0.05,          // this much lava, or water, in a cell counts as touching the other (see obsidian)
  BOIL: 0.4,            // cells' worth of water boiled off at once when they meet
  PORTAL_FLOW: 4,       // cells' worth a second one portal takes in (water: PORTAL_FLOW_PER_SECOND)
  TILE_CELLS: 4,        // cells across a Tiled tile (64 world units) — obsidian forms a tile at a time
  // Its look (see getLavaShader) — the same churning plasma as Lava.js's.
  COLOR_DEEP: [0.45, 0.05, 0.02],
  COLOR_MID: [0.85, 0.28, 0.03],
  COLOR_HOT: [1.0, 0.65, 0.15],
  GLOW_BAND: 22,        // world units under the surface it's hottest over
  PLASMA_SCALE: 0.05,
  PLASMA_DETAIL: 2.6,
  EVOLVE_SPEED: 0.18,
  SCROLL_SPEED: 0.06,
  POUR_SPEED: 1.2,      // how fast the pattern runs down a falling stream
  // Embers off its surface (as Lava.js's): chance a frame for each cell of surface
  EMBER_CHANCE: 0.05,   // (less over a thin layer: see updateLavaEmbers)
  EMBER_RISE_MIN: 0.6, EMBER_RISE_MAX: 1.4,
  EMBER_DRIFT: 0.35,
  EMBER_LIFE_MIN: 0.9, EMBER_LIFE_MAX: 1.8, // seconds
  EMBER_RADIUS_MIN: 1.2, EMBER_RADIUS_MAX: 2.6,
};

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
let lavaStepCount = 0;   // (see LAVA_TUNING.STEP_EVERY)
let lavaEmbers = [];     // { x, y, vx, vy, life, decay, radius }
let obsidians = [];      // obsidian blocks lava's turned into (see "Lava meeting water")
// Ice (see "Ice", further down): its blocks, and its own clock.
const Ice = { blocks: [], frame: 0 };
let age = 0;
const meshes = new Map(), meshSizes = new Map(); // a mesh for each liquid (see drawLiquidMesh)

// How each liquid moves (see stepWater): which of a grid's maps it's kept
// in, and its rules.
const WATER = { key: 'water', spread: SPREAD, passes: SPREAD_PASSES, minSpread: MIN_SPREAD, evaporate: EVAPORATE_PER_SECOND };
const LAVA = {
  key: 'lava', spread: LAVA_TUNING.SPREAD, passes: LAVA_TUNING.SPREAD_PASSES,
  minSpread: LAVA_TUNING.MIN_SPREAD, evaporate: 0,
};

// What a pool is to Bob while he's in one (Player.submergedIn): a huge
// round body centered far below him, its radius reaching up to the surface.
const poolWater = { isPool: true, pos: Vector2.new(0, 0), radius: 0 };

WaterSystem.reset = function () {
  grid = null;
  droplets = []; splashes = []; waterfallLandings = [];
  steam = []; hotSpots = [];
  lavaEmbers = []; obsidians = []; lavaStepCount = 0;
  Ice.blocks = []; Ice.frame = 0;
  sprayBudget = 0; stepClock = 0;
  isSpraying = false;
  totalWater = 0;
  oceans = new Map();
  planetGrids = new Map();
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
    solid: new Uint8Array(cols * rows), floor: new Map(), water: new Map(), lava: new Map(), slope: new Map(),
    level,
  };
  const inside = (c, r) => c >= 0 && c < cols && r >= 0 && r < rows;

  // Wall tiles: every cell whose middle is inside one. (And the solid
  // cells of its ball-tunnel pieces — see TiledTerrain.js.)
  for (const w of [...(level.walls ?? []), ...(level.waterSolids ?? [])]) {
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

  // The map's lava tiles (see TiledTerrain.js's lavaTiles): the lava
  // starts out in them, a cell short of the top (where its surface used
  // to sit), or right to the top under more lava.
  const lavaAt = new Set((level.lavaTiles ?? []).map((t) => `${t.x0},${t.y0}`));
  for (const t of (level.lavaTiles ?? [])) {
    const full = lavaAt.has(`${t.x0},${t.y0 - t.size}`);
    const c0 = Math.floor((t.x0 - g.x0) / CELL + 0.5);
    const r0 = Math.floor((t.y0 - g.y0) / CELL + 0.5);
    const n = Math.floor(t.size / CELL + 0.5);
    for (let r = full ? r0 : r0 + 1; r <= r0 + n - 1; r++) {
      for (let c = c0; c <= c0 + n - 1; c++) {
        const i = r * cols + c;
        if (inside(c, r) && g.solid[i] !== 1) g.lava.set(i, 1);
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

// (key: which liquid — 'water', the default, or 'lava'.)
function addWater(c, r, amount, key = 'water') {
  if (amount <= 0 || !inGrid(c, r)) return;
  const i = r * grid.cols + c;
  const liquid = grid[key];
  liquid.set(i, (liquid.get(i) ?? 0) + amount);
}

// Water `w` in level cell i (column c, row r) spreading sideways along
// whatever it's resting on (ground, or full water) — toward lower
// neighbors, evening out into a flat surface. Returns what's left in it.
// (liquid: WATER or LAVA — which map, and how runny.)
function spreadSideways(i, w, c, r, liquid) {
  const cols = grid.cols, water = grid[liquid.key];
  const resting = blocked(c, r, 0, 1) || (water.get(i + cols) ?? 0) >= 0.99;
  if (resting && w > liquid.minSpread) {
    for (let k = 1; k <= 2; k++) {
      const dc = ((k === 1) === grid.flip) ? -1 : 1;
      const nc = c + dc;
      if (nc < 0 || nc >= cols) {
        w -= w * liquid.spread; // off the map's edge: it runs away
      } else if (!blocked(c, r, dc, 0)) {
        const n = i + dc;
        const wn = water.get(n) ?? 0;
        if (wn < w) {
          const f = (w - wn) * liquid.spread;
          water.set(n, wn + f);
          w -= f;
        }
      }
    }
  }
  return w;
}

// One step of the water (or lava: liquid, default WATER) moving: bottom
// rows first — then passes - 1 more passes of it just spreading sideways.
function stepWater(dt, liquid = WATER) {
  const cols = grid.cols, water = grid[liquid.key];
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

    w = spreadSideways(i, w, c, r, liquid);

    if (r === 0 || !water.has(i - cols)) w -= liquid.evaporate * dt;

    if (w < DRY) water.delete(i); else water.set(i, w);
  }

  for (let pass = 2; pass <= liquid.passes; pass++) {
    grid.flip = !grid.flip;
    // (Any order: only falling needs the bottom rows first.)
    for (const i of [...water.keys()]) {
      let w = water.get(i);
      if (w === undefined) continue;
      const r = Math.floor(i / cols);
      w = spreadSideways(i, w, i - r * cols, r, liquid);
      if (w < DRY) water.delete(i); else water.set(i, w);
    }
  }
}

// ---------------------------------------------------------------------
// Water on a dirt planet (CrackedPlanetoid.js — one built from a Tiled
// map, say)
// ---------------------------------------------------------------------
//
// The same water as on the level, on a grid of its own bent round the
// planet: columns going round it, rows going in toward its center, each
// cell CELL deep (a 64-unit tile is 4 rows) and PLANET_CELLS_PER_TILE
// across a tile. "Down" is toward the center, so water falls inward,
// spreads round along whatever it's resting on, runs down slopes and
// curves a cell at a time, gathers in pits, caves and tunnels, and
// evaporates off the top — the same rules stepWater uses, the grid
// wrapping all the way round. A few rows of open air above the surface
// (PLANET_ROWS_ABOVE) let it puddle on top too. Solid is whatever the
// planet itself says is solid at a cell's middle, so its shaped tiles
// hold water exactly where their art is; when a shot blows dirt out
// (see CrackedPlanetoid.takeHit's dirtChanges), the cells there open up.
// (water is a Map keyed by the 0-based cell index r * cols + c.)
//
// When the planet's gravity is switched to straight down or up the
// screen (see CrackedPlanetoid.cycleGravity), the water moves onto a
// second layout of the grid: flat, square cells over the whole planet,
// rows running the way gravity pulls (row 0 the highest), so pools lie
// level across the screen. Water that runs off its edges, or falls
// past its bottom, is gone into space. Switching back moves it back
// (see convertPlanetGrid). Both layouts measure a cell's height the
// same way — its distance "up" (out from the center, or up the
// screen) — so the rest of the code here works on either.
//
// A turning planet (see CrackedPlanetoid.toggleSpin — either way) takes the round
// layout round with it, water and all — its cells stay put on the dirt.
// The flat layout stays put, so its cells are looked at again as the
// dirt turns through them (FLAT_SWEEP_ROWS rows a frame), and water in
// a cell the dirt turns into is pushed up out of it.

const PLANET_CELLS_PER_TILE = 4;  // across a tile, round the planet
const PLANET_ROWS_ABOVE = 4;      // rows of open air over its surface, for water lying on top
const PLANET_GRID_MAKE_DISTANCE = 3000; // how near its surface he has to come for its grid to be made
const FLAT_SWEEP_ROWS = 16;       // rows of a turning planet's flat layout looked at again each frame
const TWO_PI = Math.PI * 2;

// Keyed by planet.
let planetGrids = new Map();

// Local point (planet-relative) [x, y] at column position f (a fraction
// of columns: c + 0.5 is column c's middle) and height h.
function planetPoint(g, f, h) {
  if (g.flat) return [-g.top + f * CELL, -g.s * h];
  const a = g.a0 + g.planet.rotationAngle + f * g.dA;
  return [Math.cos(a) * h, Math.sin(a) * h];
}

// "Up" (a unit vector [x, y]) at local point (lx, ly).
function planetUp(g, lx, ly) {
  if (g.flat) return [0, -g.s];
  const r = Math.sqrt(lx * lx + ly * ly);
  if (r < 1e-6) return [0, -1];
  return [lx / r, ly / r];
}

// How wide a column is at height h.
function planetColWidth(g, h) {
  if (g.flat) return CELL;
  return g.dA * Math.max(h, 1);
}

// Column c, wrapped round the planet — or, on the flat layout, null off
// its edges.
function planetCol(g, c) {
  if (g.flat) return (c < 0 || c >= g.cols) ? null : c;
  return lua.mod(c, g.cols);
}

// Cell (c, r)'s index in the grid, or null if it's outside it.
function planetIndex(g, c, r) {
  if (r < 0 || r >= g.rows) return null;
  const cc = planetCol(g, c);
  if (cc === null) return null;
  return r * g.cols + cc;
}

function planetCellCenter(g, c, r) {
  return planetPoint(g, c + 0.5, g.top - (r + 0.5) * CELL);
}

// Works out whether each cell in column range c0..c1 (wrapping round),
// rows r0..r1, is solid, from the planet.
function refreshPlanetSolid(g, c0, c1, r0, r1) {
  const p = g.planet;
  const reach2 = (p.radius + CELL) ** 2;
  for (let r = Math.max(0, r0); r <= Math.min(g.rows - 1, r1); r++) {
    for (let k = c0; k <= c1; k++) {
      const c = planetCol(g, k);
      if (c === null) continue;
      const [x, y] = planetCellCenter(g, c, r);
      const i = r * g.cols + c;
      if (x * x + y * y < reach2 && p.solidAtLocal(x, y)) {
        g.solid[i] = 1;
        // (Dirt's come into it — turned into it: the water's, and the
        // lava's, pushed up.)
        for (const liquid of [g.water, g.lava]) {
          const w = liquid.get(i);
          if (w === undefined) continue;
          liquid.delete(i);
          const up = i - g.cols;
          if (r > 0 && g.solid[up] !== 1) liquid.set(up, (liquid.get(up) ?? 0) + w);
        }
      } else g.solid[i] = 0;
    }
  }
}

// Lays grid g out for gravity mode `mode`: round the planet ('core'),
// or flat ('down', 'up'). Empty, and solid worked out afresh.
function layOutPlanetGrid(g, mode) {
  const p = g.planet;
  const top = p.radius + PLANET_ROWS_ABOVE * CELL;
  g.mode = mode; g.top = top; g.water = new Map(); g.lava = new Map();
  if (mode === 'down' || mode === 'up') {
    const n = Math.ceil(2 * top / CELL);
    g.flat = true; g.s = mode === 'up' ? -1 : 1;
    g.cols = n; g.rows = n;
    g.a0 = null; g.dA = null;
  } else {
    const ring = p.rings[0];
    g.flat = false; g.s = null;
    g.cols = ring.count * PLANET_CELLS_PER_TILE;
    g.rows = Math.ceil((top - p.coreRadius) / CELL);
    g.a0 = ring.offset; g.dA = TWO_PI / g.cols;
  }
  g.solid = new Uint8Array(g.cols * g.rows);
  refreshPlanetSolid(g, 0, g.cols - 1, 0, g.rows - 1);
  g.solidAngle = p.rotationAngle; g.sweepRow = 0; g.sweepLeft = 0;
}

// The flat layout of a turning planet: a few more of its rows looked at
// again (see above), round and round for as long as it's turning, and
// once all the way through after it stops.
function sweepTurningPlanetGrid(g) {
  if (!g.flat) return;
  const a = g.planet.rotationAngle;
  if (a !== g.solidAngle) { g.solidAngle = a; g.sweepLeft = g.rows; }
  if (g.sweepLeft <= 0) return;
  const n = Math.min(FLAT_SWEEP_ROWS, g.sweepLeft);
  for (let k = 0; k < n; k++) {
    const r = (g.sweepRow + k) % g.rows;
    refreshPlanetSolid(g, 0, g.cols - 1, r, r);
  }
  g.sweepRow = (g.sweepRow + n) % g.rows;
  g.sweepLeft -= n;
}

function newPlanetGrid(p) {
  const g = { planet: p, flip: false, changesSeen: (p.dirtChanges ?? []).length };
  layOutPlanetGrid(g, 'core');
  const cols = g.cols, rows = g.rows, top = g.top;

  // Every open cell whose middle is in ring ringIndex's tile j filled
  // with `liquid` — all but its top row, if skipTop.
  const fillTile = (ringIndex, j, liquid, skipTop) => {
    const wring = p.rings[ringIndex];
    const ta0 = wring.offset + j * wring.step;
    const c0 = Math.floor((ta0 - g.a0) / g.dA) - 1;
    const c1 = Math.floor((ta0 + wring.step - g.a0) / g.dA) + 1;
    const r0 = Math.floor((top - wring.outer) / CELL);
    const r1 = Math.floor((top - wring.inner) / CELL);
    for (let r = Math.max(0, r0); r <= Math.min(rows - 1, r1); r++) {
      const rr = top - (r + 0.5) * CELL;
      if (rr < wring.inner || rr >= wring.outer) continue;
      if (skipTop && rr >= wring.outer - CELL) continue;
      for (let k = c0; k <= c1; k++) {
        const c = lua.mod(k, cols);
        const u = lua.mod(g.a0 + (c + 0.5) * g.dA - ta0, TWO_PI) / wring.step;
        const i = r * cols + c;
        if (u < 1 && g.solid[i] !== 1) liquid.set(i, 1);
      }
    }
  };

  // The map's water tiles (see CrackedPlanetoid.fromTiledMap) start out
  // full; its lava tiles a cell short of the top (where its surface used
  // to sit), or right to the top under more lava.
  for (const wt of p.waterTiles ?? []) fillTile(wt.ring, wt.j, g.water, false);
  for (const lt of p.lavaTiles ?? []) fillTile(lt.ring, lt.j, g.lava, !lt.full);
  return g;
}

// Which cell [column, row] world point (x, y) is in, and its height (see
// above). Rows run from 0 at the top of the grid; round the planet, one
// past the bottom is the core, one above the top is open space. (The
// column can be off the flat layout's edges: see planetIndex.)
function planetCellOf(g, x, y) {
  const lx = x - g.planet.pos.x, ly = y - g.planet.pos.y;
  if (g.flat) {
    const h = -g.s * ly;
    return [Math.floor((lx + g.top) / CELL), Math.floor((g.top - h) / CELL), h];
  }
  const rr = Math.sqrt(lx * lx + ly * ly);
  const c = Math.floor(lua.mod(Math.atan2(ly, lx) - g.a0 - g.planet.rotationAngle, TWO_PI) / g.dA) % g.cols;
  return [c, Math.floor((g.top - rr) / CELL), rr];
}

// Dirt that's been blown out since the grid last looked (see
// CrackedPlanetoid.takeHit): its cells opened up.
function catchUpPlanetGrid(g) {
  const changes = g.planet.dirtChanges;
  if (!changes) return;
  for (let k = g.changesSeen; k < changes.length; k++) {
    const ch = changes[k];
    const ring = g.planet.rings[ch.ring];
    const a0 = ring.offset + ch.j * ring.step;
    if (g.flat) {
      // (Round the clod's corners and the middle of its outside.)
      const px = g.planet.pos.x, py = g.planet.pos.y;
      const turn = g.planet.rotationAngle;
      let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity;
      for (const a of [a0, a0 + ring.step / 2, a0 + ring.step]) {
        for (const rr of [ring.inner, ring.outer]) {
          const [c, r] = planetCellOf(g, px + Math.cos(a + turn) * rr, py + Math.sin(a + turn) * rr);
          c0 = Math.min(c0, c); c1 = Math.max(c1, c); r0 = Math.min(r0, r); r1 = Math.max(r1, r);
        }
      }
      refreshPlanetSolid(g, c0 - 1, c1 + 1, r0 - 1, r1 + 1);
    } else {
      const c0 = Math.floor((a0 - g.a0) / g.dA) - 1;
      const c1 = Math.floor((a0 + ring.step - g.a0) / g.dA) + 1;
      const r0 = Math.floor((g.top - ring.outer) / CELL) - 1;
      const r1 = Math.floor((g.top - ring.inner) / CELL) + 1;
      refreshPlanetSolid(g, c0, c1, r0, r1);
    }
  }
  g.changesSeen = changes.length;
}

function planetSolid(g, c, r) {
  if (g.flat) {
    const i = planetIndex(g, c, r);
    return i !== null && g.solid[i] === 1;
  }
  if (r >= g.rows) return true; // (the core)
  if (r < 0) return false;
  return g.solid[r * g.cols + lua.mod(c, g.cols)] === 1;
}

// (key: which liquid — 'water', the default, or 'lava'.)
function addPlanetWater(g, c, r, amount, key = 'water') {
  if (amount <= 0) return;
  const i = planetIndex(g, c, r);
  if (i === null) return;
  const liquid = g[key];
  liquid.set(i, (liquid.get(i) ?? 0) + amount);
}

// The planet's gravity has been switched (see
// CrackedPlanetoid.cycleGravity): grid g laid out the new way, its water
// moved over — each cell's water into whichever new cell its middle is
// in, the same amount of water (by area). Where that's solid (the two
// layouts' cells don't line up), into the open cell over it.
function convertPlanetGrid(g, mode) {
  const old = {
    planet: g.planet, flat: g.flat, s: g.s, top: g.top, cols: g.cols, a0: g.a0, dA: g.dA,
    water: g.water, lava: g.lava,
  };
  layOutPlanetGrid(g, mode);
  const px = g.planet.pos.x, py = g.planet.pos.y;
  // (The lava moved over the same way.)
  for (const key of ['water', 'lava']) {
    for (const [i, w] of old[key]) {
      const r = Math.floor(i / old.cols);
      const c = i - r * old.cols;
      const h = old.top - (r + 0.5) * CELL;
      const [lx, ly] = planetPoint(old, c + 0.5, h);
      let [nc, nr, nh] = planetCellOf(g, px + lx, py + ly);
      const amount = w * planetColWidth(old, h) / planetColWidth(g, nh);
      for (let k = 0; k < 3 && planetSolid(g, nc, nr); k++) nr -= 1;
      const ni = planetIndex(g, nc, nr);
      if (ni !== null && !planetSolid(g, nc, nr) && amount > 0) g[key].set(ni, (g[key].get(ni) ?? 0) + amount);
    }
  }
}

// The planet grid point (x, y) is in, if any: within its top row of any
// planet that has one.
function planetGridAt(x, y) {
  for (const g of planetGrids.values()) {
    const dx = x - g.planet.pos.x, dy = y - g.planet.pos.y;
    if (dx * dx + dy * dy < g.top * g.top) return g;
  }
  return null;
}

// Water `w` in planet grid g's cell i (column c, row r) spreading round
// along whatever it's resting on — spreadSideways, for a planet's grid
// (the columns wrapping all the way round; off the flat layout's edges,
// it runs away). Returns what's left in it.
function spreadPlanetSideways(g, i, w, c, r, liquid) {
  const cols = g.cols, water = g[liquid.key];
  const resting = planetSolid(g, c, r + 1) || (water.get(i + cols) ?? 0) >= 0.99;
  if (resting && w > liquid.minSpread) {
    for (let k = 1; k <= 2; k++) {
      const dc = ((k === 1) === g.flip) ? -1 : 1;
      const nc = planetCol(g, c + dc);
      if (nc === null) {
        w -= w * liquid.spread;
      } else if (!planetSolid(g, nc, r)) {
        const n = r * cols + nc;
        const wn = water.get(n) ?? 0;
        if (wn < w) {
          const f = (w - wn) * liquid.spread;
          water.set(n, wn + f);
          w -= f;
        }
      }
    }
  }
  return w;
}

// One step of a planet's water (or lava: liquid, default WATER) moving —
// stepWater's rules, with "down" toward the center (or down the flat
// layout's rows) and the columns wrapping all the way round — then
// passes - 1 more passes of it just spreading round.
function stepPlanetWater(g, dt, liquid = WATER) {
  const cols = g.cols, water = g[liquid.key];
  const list = [...water.keys()].sort((a, b) => b - a); // (lowest rows first)
  g.flip = !g.flip;

  for (const i of list) {
    let w = water.get(i);
    if (w === undefined) continue;
    const r = Math.floor(i / cols);
    const c = i - r * cols;

    if (w > 1 && r > 0 && !planetSolid(g, c, r - 1)) {
      water.set(i - cols, (water.get(i - cols) ?? 0) + (w - 1));
      w = 1;
    }

    if (g.flat && r === g.rows - 1) {
      w = 0; // (falling out of the bottom of the grid: gone into space)
    } else if (!planetSolid(g, c, r + 1)) {
      const below = water.get(i + cols) ?? 0;
      const f = Math.min(w, 1 - below);
      if (f > 0) {
        water.set(i + cols, below + f);
        w -= f;
      }
    }

    w = spreadPlanetSideways(g, i, w, c, r, liquid);

    if (r === 0 || !water.has(i - cols)) w -= liquid.evaporate * dt;

    if (w < DRY) water.delete(i); else water.set(i, w);
  }

  for (let pass = 2; pass <= liquid.passes; pass++) {
    g.flip = !g.flip;
    // (Any order: only falling needs the bottom rows first.)
    for (const i of [...water.keys()]) {
      let w = water.get(i);
      if (w === undefined) continue;
      const r = Math.floor(i / cols);
      w = spreadPlanetSideways(g, i, w, i - r * cols, r, liquid);
      if (w < DRY) water.delete(i); else water.set(i, w);
    }
  }
}

// How high the water's surface is over cell (c, r), if it's wet: up its
// column through the water to the top.
function planetSurfaceAt(g, c, r) {
  const water = g.water, cols = g.cols;
  let i = r * cols + c;
  if (!water.has(i)) return null;
  while (r > 0 && water.has(i - cols)) { i -= cols; r -= 1; }
  return g.top - (r + 1) * CELL + Math.min(1, water.get(i)) * CELL;
}

// Boils `amount` off the surface round cell (c, r) (the same as
// boilGrid, for a planet's grid). Returns [x, y, upX, upY] — a point on
// the surface there and which way is up from it — or null once there's
// no water left round it.
function boilPlanetGrid(g, c, r, amount) {
  const water = g.water, cols = g.cols;
  const cells = [];
  for (let dr = -BOIL_REACH_CELLS - 2; dr <= BOIL_REACH_CELLS; dr++) {
    for (let dc = -BOIL_REACH_CELLS; dc <= BOIL_REACH_CELLS; dc++) {
      const nc = planetCol(g, c + dc), nr = r + dr;
      if (nc !== null && nr >= 0 && nr < g.rows) {
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
  const one = pick(cells);
  const h = planetSurfaceAt(g, one.c, one.r) ?? (g.top - (one.r + 1) * CELL);
  const [lx, ly] = planetPoint(g, one.c + Math.random(), h);
  const [ux, uy] = planetUp(g, lx, ly);
  return [g.planet.pos.x + lx, g.planet.pos.y + ly, ux, uy];
}

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
  const verts = [];

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
    const v1 = [px + x1, py + y1, depthTop, stream, 1, 1, 1, 1];
    const v2 = [px + x2, py + y2, depthTop, stream, 1, 1, 1, 1];
    const v3 = [px + x3, py + y3, depthBottom, stream, 1, 1, 1, 1];
    const v4 = [px + x4, py + y4, depthBottom, stream, 1, 1, 1, 1];
    verts.push(v1, v2, v3, v1, v3, v4);
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
    return (Math.sin(age * 2.2 + s * 0.045) * 1.3 + Math.sin(age * 3.7 - s * 0.11) * 0.6) * rippleScale;
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
      for (const k of [c - d, c + d]) {
        const nc = planetCol(g, k);
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
    for (const rr of [r, r + 1, r - 1]) {
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
  if (verts.length === 0) return;
  drawLiquidMesh(`planet-${liquid.key}`, verts, liquid);
}

// `verts` drawn through `liquid`'s shader (the water's or the lava's), in
// the mesh kept for `slot`.
function drawLiquidMesh(slot, verts, liquid) {
  let m = meshes.get(slot);
  if (!m || meshSizes.get(slot) < verts.length) {
    const size = Math.max(verts.length, (meshSizes.get(slot) ?? 0) * 2, 600);
    m = love.graphics.newMesh(size, 'triangles', 'stream');
    meshes.set(slot, m);
    meshSizes.set(slot, size);
  }
  m.setVertices(verts);
  m.setDrawRange(0, verts.length);
  if (liquid === LAVA) useLavaShader(); else useWaterShader();
  love.graphics.setColor(1, 1, 1, 1);
  love.graphics.draw(m);
  love.graphics.setShader();
}

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

// (lava: lava splashing, drawn hot instead of watery.)
function spawnSplash(x, y, upX, upY, lava = false) {
  for (let k = 0; k < SPLASH_BITS; k++) {
    const a = Math.atan2(upY, upX) + (rnd() * 2 - 1) * 1.1;
    const speed = 1.5 + rnd() * 2.5;
    splashes.push({
      x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
      gx: -upX * 0.3, gy: -upY * 0.3,
      life: SPLASH_SECONDS, size: 1 + rnd() * 1.5, lava,
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
          if (!isSolid(lastC, lastR)) addWater(lastC, lastR, volume, key);
          spawnSplash(x, y, -d.vx / speed, -d.vy / speed, lava);
          return true;
        }
        const i = r * grid.cols + c;
        if ((grid.water.get(i) ?? 0) + (grid.lava.get(i) ?? 0) >= HITS_POOL) {
          addWater(c, r, volume, key);
          spawnSplash(x, y, 0, -1, lava);
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
      } else if (grid && m.ny < 0.3) {
        const [c, r] = cellOf(x, y);
        if (inGrid(c, r) && !isSolid(c, r)) { g = grid; i = r * grid.cols + c; }
      }
      if (g) {
        const key = (g === grid ? 'level:' : 'planet:') + i + ':' + (pg ? pg.cols : 0);
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

      while ((portalDrained[slot] ?? 0) >= PORTAL_JET_VOLUME && wet.length > 0 && droplets.length < MAX_DROPLETS) {
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
          droplets.push({
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
        hotSpots.push({ pg, c, r, life: HOT_SECONDS, steamBudget: 0 });
        return true;
      }
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

// ---------------------------------------------------------------------
// Lava meeting water: obsidian
// ---------------------------------------------------------------------
//
// Wherever lava touches water (in the same cell, or the one beside, above
// or below it), the whole tile the lava's in turns to an obsidian block,
// the way Terraria's does: the lava there soaks into the block (and is
// kept, for if it melts), the water there is pushed up out of it, and the
// water where they met boils off in a burst of steam, a hot spot left
// steaming a while. The block is solid ground — on the level a wall (in
// level.walls, so Bob walks on it and bumps his head on it, fireballs hit
// it, and the water and lava treat it as solid), on a dirt planet a clod
// (see CrackedPlanetoid.setObsidian). Lava.js's cooling effect plays over
// it as it forms. A fireball melts it (see WaterSystem.meltObsidian, and
// CrackedPlanetoid.takeHit's obsidianHits): the melting effect plays, the
// block still solid, then it's lava again — the lava it soaked up, free
// to run.
//
// obsidians holds one entry per block:
//   kind 'level': tc, tr (its tile), x0, y0, size, cells (the grid cells
//     it made solid), wall (its entry in level.walls);
//   kind 'planet': g (the planet's grid), planet, ring, j (its tile);
// and lava (cells' worth it soaked up), overlay (the Lava.js effect
// playing over it, while one is), melting.

const NEIGHBORS = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]];

let obsidianImage = null;
function getObsidianImage() {
  if (!obsidianImage) {
    obsidianImage = love.graphics.newImage('img/obsidian.png');
    obsidianImage.setFilter('nearest', 'nearest');
  }
  return obsidianImage;
}

function removeFrom(list, item) {
  const k = list.lastIndexOf(item);
  if (k >= 0) list.splice(k, 1);
}

// A Lava.js effect over block `entry`, drawn with the other lava (see
// main.js's state.lavas).
function newOverlay(entry) {
  let ov;
  if (entry.kind === 'level') {
    ov = Lava.new(entry.x0, entry.y0, entry.size);
  } else {
    const ring = entry.planet.rings[entry.ring];
    const a0 = ring.offset + entry.j * ring.step;
    ov = Lava.newOnRing(entry.planet, ring.inner, ring.outer, a0, a0 + ring.step, false);
  }
  state.lavas = state.lavas ?? [];
  state.lavas.push(ov);
  return ov;
}

// Steam off the water where it met the lava — water cell (wc, wr) of
// planet grid pg, or of the level's grid if pg is null — boiling some of
// it off, and a hot spot left there. (fx, fy): where it puffs from
// instead, and (ux, uy) which way's up there, if there's no water left
// to come off.
function steamWhereMet(pg, wc, wr, fx, fy, ux, uy) {
  let sx, sy, upX, upY;
  if (pg) {
    const hit = boilPlanetGrid(pg, wc, wr, LAVA_TUNING.BOIL);
    if (hit) [sx, sy, upX, upY] = hit;
  } else {
    const hit = boilGrid(wc, wr, LAVA_TUNING.BOIL);
    if (hit) { [sx, sy] = hit; upX = 0; upY = -1; }
  }
  if (sx === undefined) { sx = fx; sy = fy; upX = ux; upY = uy; }
  for (let k = 0; k < STEAM_BURST; k++) spawnSteam(sx, sy, upX, upY, 1.0);
  hotSpots.push({ pg, c: wc, r: wr, life: HOT_SECONDS, steamBudget: 0 });
}

// The level's tile (tc, tr) turned to obsidian, where lava in it met
// water in cell (wc, wr).
function hardenLevelTile(tc, tr, wc, wr) {
  const g = grid;
  const T = LAVA_TUNING.TILE_CELLS;
  const cols = g.cols, size = T * CELL;
  const x0 = g.x0 + tc * size, y0 = g.y0 + tr * size;
  const r0 = tr * T;
  let soaked = 0;
  const cells = [];
  for (let r = r0; r < r0 + T; r++) {
    for (let c = tc * T; c < tc * T + T; c++) {
      const i = r * cols + c;
      if (!inGrid(c, r) || g.solid[i] === 1) continue;
      soaked += g.lava.get(i) ?? 0;
      g.lava.delete(i);
      const w = g.water.get(i);
      if (w !== undefined) {
        // (Pushed up out of it, into the cell just over the block.)
        g.water.delete(i);
        if (r0 > 0 && !isSolid(c, r0 - 1)) addWater(c, r0 - 1, w);
      }
      g.solid[i] = 1;
      cells.push(i);
    }
  }

  const wall = {
    pos: new Vector2(x0 + size / 2, y0 + size / 2),
    halfWidth: size / 2, halfHeight: size / 2,
    radius: size * 0.7071067811865476,
    isWall: true,
  };
  g.level.walls.push(wall);
  Ice.addTop(wall); // (a walkable top — see Ice.addTop)
  const entry = { kind: 'level', tc, tr, x0, y0, size, cells, wall, lava: soaked };
  wall.obsidian = entry;
  entry.overlay = newOverlay(entry);
  entry.overlay.harden();
  obsidians.push(entry);

  // If he's in it, he's lifted out on top of it.
  const p = state.player;
  if (p) {
    const qx = Math.max(x0, Math.min(p.pos.x, x0 + size));
    const qy = Math.max(y0, Math.min(p.pos.y, y0 + size));
    if ((p.pos.x - qx) ** 2 + (p.pos.y - qy) ** 2 < p.radius * p.radius) p.pos.y = y0 - p.radius - 1;
  }

  steamWhereMet(null, wc, wr, x0 + size / 2, y0, 0, -1);
}

// The cells of planet grid g whose middles are in ring i's tile j (on
// whichever layout it has), as { i, r } — deepest first.
function planetTileCells(g, i, j) {
  const p = g.planet;
  const ring = p.rings[i];
  const a = ring.offset + (j + 0.5) * ring.step + p.rotationAngle;
  const [c0, r0] = planetCellOf(g, p.pos.x + Math.cos(a) * ring.mid, p.pos.y + Math.sin(a) * ring.mid);
  const list = [];
  const reach = LAVA_TUNING.TILE_CELLS + 2;
  for (let r = r0 - reach; r <= r0 + reach; r++) {
    for (let k = c0 - reach; k <= c0 + reach; k++) {
      const idx = planetIndex(g, k, r);
      if (idx === null) continue;
      const c = idx - r * g.cols;
      const [lx, ly] = planetCellCenter(g, c, r);
      const tile = p.tileAtLocal(lx, ly);
      if (tile && tile[0] === i && tile[1] === j) list.push({ i: idx, r });
    }
  }
  list.sort((a1, b1) => b1.r - a1.r);
  return list;
}

// Planet grid g's planet's tile (ring i, tile j) turned to obsidian,
// where lava in it met water in cell (wc, wr).
function hardenPlanetTile(g, i, j, wc, wr) {
  const p = g.planet;
  let soaked = 0;
  for (const cell of planetTileCells(g, i, j)) {
    soaked += g.lava.get(cell.i) ?? 0;
    g.lava.delete(cell.i);
  }
  // (Its water's pushed up out of it once the grid sees the block — see
  // catchUpPlanetGrid.)
  p.setObsidian(i, j, true);
  const entry = { kind: 'planet', g, planet: p, ring: i, j, lava: soaked };
  entry.overlay = newOverlay(entry);
  entry.overlay.harden();
  obsidians.push(entry);

  const ring = p.rings[i];
  const a = ring.offset + (j + 0.5) * ring.step + p.rotationAngle;
  const ux = Math.cos(a), uy = Math.sin(a);
  steamWhereMet(g, wc, wr, p.pos.x + ux * ring.outer, p.pos.y + uy * ring.outer, ux, uy);
}

// Lava touching water anywhere on the level: the tile each such bit of
// lava is in turns to obsidian.
function quenchLevelLava() {
  const g = grid;
  const cols = g.cols, lava = g.lava, water = g.water;
  if (lava.size === 0 || water.size === 0) return;
  const hits = [];
  for (const [i, l] of lava) {
    if (l < LAVA_TUNING.TOUCH) continue;
    const r = Math.floor(i / cols);
    const c = i - r * cols;
    for (const [dc, dr] of NEIGHBORS) {
      const nc = c + dc, nr = r + dr;
      if (inGrid(nc, nr) && (water.get(nr * cols + nc) ?? 0) >= LAVA_TUNING.TOUCH) {
        hits.push({ i, c, r, wc: nc, wr: nr });
        break;
      }
    }
  }
  const T = LAVA_TUNING.TILE_CELLS;
  for (const h of hits) {
    if (lava.has(h.i)) hardenLevelTile(Math.floor(h.c / T), Math.floor(h.r / T), h.wc, h.wr); // (not soaked into a block made just now)
  }
}

// The same on planet grid g.
function quenchPlanetLava(g) {
  const cols = g.cols, lava = g.lava, water = g.water, p = g.planet;
  if (lava.size === 0 || water.size === 0) return;
  const hits = [];
  for (const [i, l] of lava) {
    if (l < LAVA_TUNING.TOUCH) continue;
    const r = Math.floor(i / cols);
    const c = i - r * cols;
    for (const [dc, dr] of NEIGHBORS) {
      const ni = planetIndex(g, c + dc, r + dr);
      if (ni !== null && (water.get(ni) ?? 0) >= LAVA_TUNING.TOUCH) {
        hits.push({ i, c, r, wc: ni % cols, wr: r + dr });
        break;
      }
    }
  }
  for (const h of hits) {
    if (!lava.has(h.i)) continue;
    const [lx, ly] = planetCellCenter(g, h.c, h.r);
    const tile = p.tileAtLocal(lx, ly);
    if (tile && !p.rings[tile[0]].clods[tile[1]]) {
      hardenPlanetTile(g, tile[0], tile[1], h.wc, h.wr);
    } else {
      // (Lava up over the planet's tiles, or not yet out of one that's
      // just gone solid: there's no tile for a block, so it just goes out
      // in a puff of steam.)
      lava.delete(h.i);
      const [ux, uy] = planetUp(g, lx, ly);
      steamWhereMet(g, h.wc, h.wr, p.pos.x + lx, p.pos.y + ly, ux, uy);
    }
  }
}

// Starts block `entry` melting (see above).
function startMelt(entry) {
  if (entry.melting) return;
  entry.melting = true;
  let ov = entry.overlay;
  if (!ov) {
    ov = newOverlay(entry);
    ov.hardened = true; ov.cool = 1;
    entry.overlay = ov;
  }
  ov.melt();
}

// A fireball's hit a wall on the level (wall: its entry in level.walls —
// see js/systems/Projectiles.js): an obsidian block starts melting back
// into lava; an ice block (or an Ooomba's ice cube) melts into water (see
// "Ice"). Any other wall, it does nothing.
WaterSystem.fireHitsWall = function (wall) {
  if (!wall) return;
  if (wall.obsidian) startMelt(wall.obsidian);
  if (wall.ice) Ice.melt(wall.ice);
};
WaterSystem.meltObsidian = WaterSystem.fireHitsWall;

// `amount` cells' worth of lava poured into `cells` ({ i, r }, deepest
// first) of liquid map `lava`: each row filled before the one over it.
function pourLava(lava, cells, amount) {
  let k = 0;
  while (k < cells.length && amount > 0) {
    const r = cells[k].r;
    let n = 0;
    while (cells[k + n] && cells[k + n].r === r) n++;
    const each = Math.min(1, amount / n);
    for (let m = k; m < k + n; m++) lava.set(cells[m].i, (lava.get(cells[m].i) ?? 0) + each);
    amount -= each * n;
    k += n;
  }
}

// Block `entry`'s finished melting: it's lava again — the lava it soaked
// up, poured back into its cells, free to run.
function finishMelt(entry) {
  if (entry.kind === 'level') {
    const g = grid;
    if (!g) return;
    const cells = entry.cells.map((i) => { g.solid[i] = 0; return { i, r: Math.floor(i / g.cols) }; });
    removeFrom(g.level.walls, entry.wall);
    Ice.removeTop(entry.wall);
    cells.sort((a1, b1) => b1.r - a1.r);
    pourLava(g.lava, cells, entry.lava);
  } else {
    entry.planet.setObsidian(entry.ring, entry.j, false);
    pourLava(entry.g.lava, planetTileCells(entry.g, entry.ring, entry.j), entry.lava);
  }
}

// The blocks' effects playing out: one done forming leaves the block on
// its own; one done melting is lava again. And blocks on a planet a
// fireball's hit (see CrackedPlanetoid.takeHit) start melting — obsidian
// back into lava, ice into water (see "Ice").
function updateObsidians() {
  for (const g of planetGrids.values()) {
    const hitList = g.planet.blockHits;
    if (!hitList) continue;
    for (const h of hitList) {
      for (const e of obsidians) {
        if (e.planet === g.planet && e.ring === h.ring && e.j === h.j) startMelt(e);
      }
      for (const e of [...Ice.blocks]) {
        if (e.planet === g.planet && e.ring === h.ring && e.j === h.j) Ice.melt(e);
      }
    }
    g.planet.blockHits = null;
  }

  for (let k = obsidians.length - 1; k >= 0; k--) {
    const e = obsidians[k];
    const ov = e.overlay;
    if (!ov) continue;
    if (e.melting) {
      if (ov.coolDir === 0 && ov.cool <= 0) {
        removeFrom(state.lavas ?? [], ov);
        e.overlay = null;
        finishMelt(e);
        obsidians.splice(k, 1);
      }
    } else if (ov.cool >= 1) {
      removeFrom(state.lavas ?? [], ov);
      e.overlay = null;
    }
  }
}

// Every cell of the lava's surface (lava with none on top of it) near
// the screen: fn(x, y, upX, upY, c, r, g, amount) — its point on the
// surface, which way is up there, its cell (g: its planet grid, or null
// for the level's), and how much lava's in it.
function forEachLavaSurface(fn) {
  const cam = state.camera;
  if (!cam) return;
  const m = CELL * 8;
  const vx0 = cam.x - m, vy0 = cam.y - m;
  const vx1 = cam.x + (state.visibleWidth ?? 0) + m, vy1 = cam.y + (state.visibleHeight ?? 0) + m;
  if (grid) {
    const cols = grid.cols, lava = grid.lava;
    for (const [i, l] of lava) {
      if (lava.has(i - cols)) continue;
      const r = Math.floor(i / cols);
      const c = i - r * cols;
      const x = grid.x0 + (c + 0.5) * CELL;
      const y = grid.y0 + (r + 1) * CELL - Math.min(1, l) * CELL;
      if (x > vx0 && x < vx1 && y > vy0 && y < vy1) fn(x, y, 0, -1, c, r, null, l);
    }
  }
  for (const g of planetGrids.values()) {
    const cols = g.cols, lava = g.lava;
    const px = g.planet.pos.x, py = g.planet.pos.y;
    for (const [i, l] of lava) {
      if (lava.has(i - cols)) continue;
      const r = Math.floor(i / cols);
      const c = i - r * cols;
      const [lx, ly] = planetPoint(g, c + 0.5, g.top - (r + 1) * CELL + Math.min(1, l) * CELL);
      const x = px + lx, y = py + ly;
      if (x > vx0 && x < vx1 && y > vy0 && y < vy1) {
        const [ux, uy] = planetUp(g, lx, ly);
        fn(x, y, ux, uy, c, r, g, l);
      }
    }
  }
}

// Embers off the lava's surface (as Lava.js's own), drifting up and
// fading.
function updateLavaEmbers() {
  const ts = state.timeScale ?? 1;
  const L = LAVA_TUNING;
  forEachLavaSurface((x, y, ux, uy, c, r, g, amount) => {
    if (Math.random() >= L.EMBER_CHANCE * Math.min(1, amount) * ts) return;
    const speed = L.EMBER_RISE_MIN + Math.random() * (L.EMBER_RISE_MAX - L.EMBER_RISE_MIN);
    const drift = (Math.random() * 2 - 1) * L.EMBER_DRIFT;
    const along = (Math.random() - 0.5) * CELL;
    const life = L.EMBER_LIFE_MIN + Math.random() * (L.EMBER_LIFE_MAX - L.EMBER_LIFE_MIN);
    lavaEmbers.push({
      x: x - uy * along, y: y + ux * along,
      vx: -uy * drift + ux * speed, vy: ux * drift + uy * speed,
      life: 1, decay: 1 / life,
      radius: L.EMBER_RADIUS_MIN + Math.random() * (L.EMBER_RADIUS_MAX - L.EMBER_RADIUS_MIN),
    });
  });
  for (let k = lavaEmbers.length - 1; k >= 0; k--) {
    const e = lavaEmbers[k];
    e.x += e.vx * ts; e.y += e.vy * ts;
    e.life -= e.decay * ts / 60;
    if (e.life <= 0) lavaEmbers.splice(k, 1);
  }
}

// Where the lava glows (see TileGlow.js): fn(x, y) once for each tile's
// worth of its surface near the screen.
WaterSystem.forEachLavaGlow = function (fn) {
  const buckets = new Map();
  const T = LAVA_TUNING.TILE_CELLS;
  forEachLavaSurface((x, y, ux, uy, c, r, g) => {
    const owner = g ?? 'level';
    let byGrid = buckets.get(owner);
    if (!byGrid) { byGrid = new Map(); buckets.set(owner, byGrid); }
    const key = Math.floor(c / T) * 100000 + Math.floor(r / T);
    let b = byGrid.get(key);
    if (!b) { b = { x: 0, y: 0, n: 0 }; byGrid.set(key, b); }
    b.x += x; b.y += y; b.n += 1;
  });
  for (const byGrid of buckets.values()) {
    for (const b of byGrid.values()) fn(b.x / b.n, b.y / b.n);
  }
};

// ---------------------------------------------------------------------
// Ice
// ---------------------------------------------------------------------
//
// The ice blaster's bolts (see js/entities/IceBolt.js and
// WaterSystem.iceBoltHit):
//   * into water: a block of ice a tile across (Ice.TUNING.SIZE cells)
//     freezes there, out of the water round where it hit — the water's
//     kept, for when it melts. On the level it's a wall (in level.walls,
//     so Bob bumps into it and fireballs hit it, and the water flows
//     round it) with a walkable top (Ice.addTop), and it's slippery (see
//     Player.move). On a dirt planet it's an ice tile (see
//     CrackedPlanetoid.setBlock).
//   * into lava: the bolt turns to water there (Ice.TUNING.LAVA_WATER), so
//     the lava turns to obsidian (see "Lava meeting water").
//   * into an Ooomba: it's frozen in an ice cube (Ice.encase) — stock still
//     and harmless, and on the level's terrain, a block to stand on.
// Ice floats: a block sunk in water rises a cell at a time (the water
// flowing in under it) until it's riding at the surface, a quarter of it
// out; with nothing at all under it, it drops. (On a dirt planet, a whole
// tile at a time — its tiles are a ring deep.) A fireball melts it — and
// lava meeting it does too — into a splash of water and steam (Ice.melt):
// a frozen Ooomba's freed, and walks on.
//
// Ice.blocks holds one entry per block:
//   kind 'level': c0, r0 (its top-left cell), x0, y0, size, wall;
//   kind 'planet': g (the planet's grid), planet, ring, j (its tile);
//   kind 'ooomba': o (the frozen Ooomba), size, and on the level a wall;
// and water (cells' worth it'll melt back into).

Ice.TUNING = {
  SIZE: 4,              // cells across a block (a tile)
  MIN_WATER: 1.0,       // cells' worth of water it takes to freeze a block
  LAVA_WATER: 1.5,      // cells' worth of water a bolt turns to in lava
  LEVEL_STEP: 4,        // frames between a level block's floating/sinking steps (a cell each)
  PLANET_STEP: 30,      // ...and a planet's ice tile's (a whole tile each)
  CUBE_MARGIN: 16,      // world units an Ooomba's cube is bigger than it
  CUBE_WATER: 2,        // cells' worth of water a melted cube leaves
  ALPHA: 0.92,          // how solid ice looks (its art's own see-through on top)
};

let iceImage = null;
Ice.getImage = function () {
  if (!iceImage) {
    iceImage = love.graphics.newImage('img/ice.png');
    iceImage.setFilter('nearest', 'nearest');
  }
  return iceImage;
};

// A walkable top for a block on the level (obsidian, ice, or an Ooomba's
// cube): a moving surface along its top (see TiledTerrain.newMovingSurface
// — RopeRock's rock has one the same way), so he stands and walks on it
// rather than just bumping into it. An ice one is slippery (isIce — see
// Player.move).
Ice.addTop = function (wall) {
  const top = wall.pos.y - wall.halfHeight;
  const s = TiledTerrain.newMovingSurface(wall.pos.x - wall.halfWidth, top, wall.pos.x + wall.halfWidth, top);
  s.jumpStrength = state.skyDomePlanet ? state.skyDomePlanet.jumpStrength : undefined;
  s.blockWall = wall; // (a fireball hitting its top melts the block — see js/systems/Projectiles.js)
  s.isIce = wall.ice != null;
  wall.surface = s;
  state.planetoids = state.planetoids ?? [];
  state.planetoids.push(s);
};

Ice.placeTop = function (wall) {
  if (!wall.surface) return;
  const top = wall.pos.y - wall.halfHeight;
  wall.surface.moveTo(wall.pos.x - wall.halfWidth, top, wall.pos.x + wall.halfWidth, top);
};

Ice.removeTop = function (wall) {
  const s = wall.surface;
  if (!s) return;
  removeFrom(state.planetoids ?? [], s);
  const p = state.player;
  if (p && p.currentPlanet === s) { p.onSurface = false; p.currentPlanet = null; }
  wall.surface = null;
};

// If he's in the box (x0, y0)-(x1, y1), he's lifted out on top of it.
Ice.liftPlayerOutOf = function (x0, y0, x1, y1) {
  const p = state.player;
  if (!p) return;
  const qx = Math.max(x0, Math.min(p.pos.x, x1));
  const qy = Math.max(y0, Math.min(p.pos.y, y1));
  if ((p.pos.x - qx) ** 2 + (p.pos.y - qy) ** 2 < p.radius * p.radius) p.pos.y = y0 - p.radius - 1;
};

// A level block's wall, from its cells.
Ice.levelBlockWall = function (e) {
  const half = e.size / 2;
  return {
    pos: new Vector2(e.x0 + half, e.y0 + half), halfWidth: half, halfHeight: half,
    radius: e.size * 0.7071067811865476, isWall: true,
  };
};

// Water at level cell (c, r) froze: a block out of the water round it.
// Which rows: the four-row band through (c, r), in its tile's columns,
// that's all open (no wall, floor or other block in it) and holds the
// most water. Returns whether one froze.
Ice.freezeLevel = function (hc, hr) {
  const g = grid;
  const S = Ice.TUNING.SIZE, cols = grid.cols;
  const c0 = Math.floor(hc / S) * S;
  let bestR = null, bestWater = 0;
  for (let r0 = hr - (S - 1); r0 <= hr; r0++) {
    let ok = true, w = 0;
    for (let r = r0; r < r0 + S; r++) {
      for (let c = c0; c < c0 + S; c++) {
        const i = r * cols + c;
        if (!inGrid(c, r) || isSolid(c, r) || g.floor.has(i) || (g.lava.get(i) ?? 0) > 0) ok = false;
        w += g.water.get(i) ?? 0;
      }
    }
    if (ok && w > bestWater) { bestR = r0; bestWater = w; }
  }
  if (bestR === null || bestWater < Ice.TUNING.MIN_WATER) return false;

  for (let r = bestR; r < bestR + S; r++) {
    for (let c = c0; c < c0 + S; c++) {
      const i = r * cols + c;
      g.water.delete(i);
      g.solid[i] = 1;
    }
  }
  const e = {
    kind: 'level', c0, r0: bestR, x0: g.x0 + c0 * CELL, y0: g.y0 + bestR * CELL, size: S * CELL,
    water: bestWater,
  };
  e.wall = Ice.levelBlockWall(e);
  e.wall.ice = e;
  g.level.walls.push(e.wall);
  Ice.addTop(e.wall);
  Ice.blocks.push(e);
  Ice.liftPlayerOutOf(e.x0, e.y0, e.x0 + e.size, e.y0 + e.size);
  IceBolt.burst(e.x0 + e.size / 2, e.y0 + e.size / 2, 18);
  return true;
};

// Water at planet grid g's cell (c, r) froze: the tile it's in turns to
// ice, out of the water in it. Returns whether it did.
Ice.freezePlanet = function (g, c, r) {
  const p = g.planet;
  const [lx, ly] = planetCellCenter(g, c, r);
  const tile = p.tileAtLocal(lx, ly);
  if (!tile || p.rings[tile[0]].clods[tile[1]]) return false;
  const [i, j] = tile;
  const cells = planetTileCells(g, i, j);
  let w = 0;
  for (const cell of cells) {
    if ((g.lava.get(cell.i) ?? 0) > 0) return false;
    w += g.water.get(cell.i) ?? 0;
  }
  if (w < Ice.TUNING.MIN_WATER) return false;
  for (const cell of cells) g.water.delete(cell.i);
  p.setBlock(i, j, 'ice');
  Ice.blocks.push({ kind: 'planet', g, planet: p, ring: i, j, water: w });
  IceBolt.burst(p.pos.x + lx, p.pos.y + ly, 18);
  return true;
};

// An Ooomba frozen in an ice cube (see above).
Ice.encase = function (o) {
  if (o.iceBlock || o.isSquashing) return;
  const size = Math.max(o.drawWidth, o.drawHeight) + Ice.TUNING.CUBE_MARGIN;
  const e = { kind: 'ooomba', o, size, water: Ice.TUNING.CUBE_WATER };
  o.iceBlock = e;
  o.frozen = true;
  // Its middle where the Ooomba's is, its bottom on the ground under it.
  const feetX = o.pos.x - o.up.x * o.halfHeight, feetY = o.pos.y - o.up.y * o.halfHeight;
  e.cx = feetX + o.up.x * size / 2; e.cy = feetY + o.up.y * size / 2;
  // On the level's terrain (not a round planetoid, not flying), it's a
  // solid block to stand on.
  const level = state.tiledLevels && state.tiledLevels[0];
  if (level && !o.planet && !o.airborne && !o.portalTransit) {
    e.cx = feetX; e.cy = feetY - size / 2 + 2;
    e.x0 = e.cx - size / 2; e.y0 = e.cy - size / 2;
    e.level = level;
    e.wall = Ice.levelBlockWall(e);
    e.wall.ice = e;
    level.walls.push(e.wall);
    Ice.addTop(e.wall);
    Ice.liftPlayerOutOf(e.x0, e.y0, e.x0 + size, e.y0 + size);
  }
  Ice.blocks.push(e);
  IceBolt.burst(e.cx, e.cy, 24);
};

// Block e melts (see above): a splash of water — what it froze from — and
// steam.
Ice.melt = function (e) {
  removeFrom(Ice.blocks, e);
  let cx, cy, upX, upY;
  if (e.kind === 'level') {
    const g = grid, S = Ice.TUNING.SIZE;
    const cells = [];
    for (let r = e.r0 + S - 1; r >= e.r0; r--) {
      for (let c = e.c0; c < e.c0 + S; c++) {
        const i = r * g.cols + c;
        g.solid[i] = 0;
        cells.push({ i, r });
      }
    }
    pourLava(g.water, cells, e.water);
    cx = e.x0 + e.size / 2; cy = e.y0; upX = 0; upY = -1;
  } else if (e.kind === 'planet') {
    e.planet.setBlock(e.ring, e.j, null);
    pourLava(e.g.water, planetTileCells(e.g, e.ring, e.j), e.water);
    const ring = e.planet.rings[e.ring];
    const a = ring.offset + (e.j + 0.5) * ring.step + e.planet.rotationAngle;
    upX = Math.cos(a); upY = Math.sin(a);
    cx = e.planet.pos.x + upX * ring.mid; cy = e.planet.pos.y + upY * ring.mid;
  } else {
    const o = e.o;
    o.frozen = false; o.iceBlock = null;
    cx = e.cx; cy = e.cy; upX = o.up.x; upY = o.up.y;
    // (Its water, onto the level's grid if it's on the level.)
    if (grid && e.level) {
      const [c, r] = cellOf(cx, e.cy + e.size / 2 - CELL / 2);
      for (let dc = -1; dc <= 1; dc++) {
        if (inGrid(c + dc, r) && !isSolid(c + dc, r)) addWater(c + dc, r, e.water / 3);
      }
    }
  }
  if (e.wall) {
    removeFrom((e.level ?? (grid && grid.level) ?? {}).walls ?? [], e.wall);
    Ice.removeTop(e.wall);
  }
  for (let k = 0; k < Math.floor(STEAM_BURST * 0.6); k++) spawnSteam(cx, cy, upX, upY, 1.0);
  for (let k = 0; k < 3; k++) spawnSplash(cx + (Math.random() - 0.5) * 30, cy, upX, upY);
  IceBolt.burst(cx, cy, 10);
};

// A fireball (or anything hot) at f.pos: an Ooomba's ice cube it's
// touching melts (the level's blocks are walls, so js/systems/Projectiles.js's fireball-vs-
// wall pass finds those). Returns whether it melted one.
WaterSystem.fireHitsIce = function (f) {
  for (let k = Ice.blocks.length - 1; k >= 0; k--) {
    const e = Ice.blocks[k];
    if (e.kind !== 'ooomba') continue;
    const half = e.size / 2 + f.radius;
    if (Math.abs(f.pos.x - e.cx) < half && Math.abs(f.pos.y - e.cy) < half) {
      Ice.melt(e);
      return true;
    }
  }
  return false;
};

// Whether lava's touching level block e (in a cell round its edge).
Ice.lavaRoundLevelBlock = function (e) {
  const g = grid, S = Ice.TUNING.SIZE;
  for (let r = e.r0 - 1; r <= e.r0 + S; r++) {
    for (let c = e.c0 - 1; c <= e.c0 + S; c++) {
      if (inGrid(c, r) && (g.lava.get(r * g.cols + c) ?? 0) >= LAVA_TUNING.TOUCH) return true;
    }
  }
  return false;
};

// Level block e moved a cell (dir: -1 up, 1 down): the row it moves into
// swaps with the row it leaves — whatever water (or lava) was there goes
// to the other side of it.
Ice.moveLevelBlock = function (e, dir) {
  const g = grid, S = Ice.TUNING.SIZE;
  const into = dir < 0 ? e.r0 - 1 : e.r0 + S;
  const leave = dir < 0 ? e.r0 + S - 1 : e.r0;
  for (let c = e.c0; c < e.c0 + S; c++) {
    const i = into * g.cols + c, k = leave * g.cols + c;
    for (const liquid of [g.water, g.lava]) {
      const v = liquid.get(i);
      liquid.delete(i);
      if (v !== undefined) liquid.set(k, v); else liquid.delete(k);
    }
    g.solid[i] = 1; g.solid[k] = 0;
  }
  e.r0 += dir;
  e.y0 += dir * CELL;
  e.wall.pos.y += dir * CELL;
  Ice.placeTop(e.wall);
  // (Rising into him from below, he's lifted along.)
  if (dir < 0) Ice.liftPlayerOutOf(e.x0, e.y0, e.x0 + e.size, e.y0 + e.size);
};

// A level block floating or sinking a step (see above).
Ice.stepLevelBlock = function (e) {
  const g = grid, S = Ice.TUNING.SIZE;
  if (Ice.lavaRoundLevelBlock(e)) { Ice.melt(e); return; }
  const bottom = e.r0 + S - 1;
  let restsBelow = false, waterBelow = 0;
  for (let c = e.c0; c < e.c0 + S; c++) {
    if (blocked(c, bottom, 0, 1)) restsBelow = true;
    if (inGrid(c, bottom + 1)) waterBelow += g.water.get((bottom + 1) * g.cols + c) ?? 0;
  }
  if (!restsBelow && waterBelow < 1) {
    Ice.moveLevelBlock(e, 1); // (nothing to hold it up: it drops)
  } else {
    // Sunk in water, it floats up (the water it rises out of flowing in
    // under it — see moveLevelBlock), even off the bottom of a pool.
    let roofed = false, waterAbove = 0;
    for (let c = e.c0; c < e.c0 + S; c++) {
      if (e.r0 <= 0 || blocked(c, e.r0, 0, -1)) roofed = true;
      if (e.r0 > 0) waterAbove += g.water.get((e.r0 - 1) * g.cols + c) ?? 0;
    }
    // (Sunk: water over it, or up its sides to its top row.)
    const sideWet = (c) => inGrid(c, e.r0) && (g.water.get(e.r0 * g.cols + c) ?? 0) >= 0.5;
    const sunk = waterAbove > 0.05 || sideWet(e.c0 - 1) || sideWet(e.c0 + S);
    if (!roofed && sunk) Ice.moveLevelBlock(e, -1);
  }
};

// Planet ice tile e: [water, lava] in tile (ring ti, tile tj) — or null
// if it's solid (dirt, a block, or past the rings).
Ice.planetTileWater = function (e, ti, tj) {
  const p = e.planet;
  if (ti < 0 || ti >= p.rings.length) return null;
  tj = lua.mod(tj, p.rings[ti].count);
  if (p.rings[ti].clods[tj]) return null;
  let w = 0, lava = 0;
  for (const cell of planetTileCells(e.g, ti, tj)) {
    w += e.g.water.get(cell.i) ?? 0;
    lava += e.g.lava.get(cell.i) ?? 0;
  }
  return [w, lava];
};

// Planet ice tile e moved to ring ti (the next one in or out): the water
// (and lava) in that tile goes into the one it leaves.
Ice.movePlanetBlock = function (e, ti) {
  const g = e.g, p = e.planet;
  let water = 0, lava = 0;
  for (const cell of planetTileCells(g, ti, e.j)) {
    water += g.water.get(cell.i) ?? 0;
    lava += g.lava.get(cell.i) ?? 0;
    g.water.delete(cell.i); g.lava.delete(cell.i);
  }
  p.setBlock(e.ring, e.j, null);
  p.setBlock(ti, e.j, 'ice');
  const cells = planetTileCells(g, e.ring, e.j);
  pourLava(g.water, cells, water);
  pourLava(g.lava, cells, lava);
  e.ring = ti;
};

// A planet's ice tile floating or sinking a tile (see above).
Ice.stepPlanetBlock = function (e) {
  const i = e.ring, j = e.j;
  // Lava next to it (in, out, or either side) melts it.
  for (const [ti, tj] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) {
    const t = Ice.planetTileWater(e, ti, tj);
    if (t && t[1] >= LAVA_TUNING.TOUCH) { Ice.melt(e); return; }
  }
  const below = i > 0 ? Ice.planetTileWater(e, i - 1, j) : null;
  if (below && below[0] < 2) {
    Ice.movePlanetBlock(e, i - 1);
  } else if (i < e.planet.rings.length - 1) {
    // (Sunk in water, it floats up — even off the bottom of a pool.)
    const above = Ice.planetTileWater(e, i + 1, j);
    const left = Ice.planetTileWater(e, i, j - 1), right = Ice.planetTileWater(e, i, j + 1);
    const sunk = (above && above[0] > 0.5) || (left ? left[0] : 0) >= 12 || (right ? right[0] : 0) >= 12;
    if (above && sunk) Ice.movePlanetBlock(e, i + 1);
  }
};

// Each frame (see WaterSystem.update): the blocks floating and sinking,
// each at its own pace.
Ice.update = function () {
  if (Ice.blocks.length === 0) return;
  const before = Ice.frame;
  Ice.frame += state.timeScale ?? 1;
  const due = (every) => Math.floor(Ice.frame / every) > Math.floor(before / every);
  const levelDue = due(Ice.TUNING.LEVEL_STEP), planetDue = due(Ice.TUNING.PLANET_STEP);
  for (const e of [...Ice.blocks]) {
    if (!Ice.blocks.includes(e)) continue;
    if (e.kind === 'level' && levelDue && grid) Ice.stepLevelBlock(e);
    else if (e.kind === 'planet' && planetDue && planetGrids.get(e.planet) === e.g) Ice.stepPlanetBlock(e);
    else if (e.kind === 'ooomba' && e.o.isSquashing) Ice.melt(e);
  }
};

// Ice bolt b (see js/entities/IceBolt.js) reaching water or lava this
// frame (anywhere along the path it's just moved): water freezes into a
// block (see above), lava gets water poured into it (so it turns to
// obsidian). Returns whether it did — the bolt's spent either way, if it
// reached either (the caller removes it).
WaterSystem.iceBoltHit = function (b) {
  const ts = state.timeScale ?? 1;
  const x1 = b.pos.x, y1 = b.pos.y;
  const x0 = x1 - b.vel.x * ts, y0 = y1 - b.vel.y * ts;
  const dist = Math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2);
  const steps = Math.max(1, Math.ceil(dist / (CELL * 0.5)));
  for (let s = 0; s <= steps; s++) {
    const x = x0 + (x1 - x0) * s / steps, y = y0 + (y1 - y0) * s / steps;
    const pg = planetGridAt(x, y);
    if (pg) {
      const [c, r] = planetCellOf(pg, x, y);
      const i = planetIndex(pg, c, r);
      if (i !== null && (pg.lava.get(i) ?? 0) >= LAVA_TUNING.TOUCH) {
        pg.water.set(i, (pg.water.get(i) ?? 0) + Ice.TUNING.LAVA_WATER);
        return true;
      }
      if (i !== null && (pg.water.get(i) ?? 0) >= QUENCH_AT) {
        Ice.freezePlanet(pg, c, r);
        return true;
      }
    } else if (grid) {
      const [c, r] = cellOf(x, y);
      if (inGrid(c, r)) {
        const i = r * grid.cols + c;
        if ((grid.lava.get(i) ?? 0) >= LAVA_TUNING.TOUCH) {
          addWater(c, r, Ice.TUNING.LAVA_WATER);
          return true;
        }
        if ((grid.water.get(i) ?? 0) >= QUENCH_AT) {
          Ice.freezeLevel(c, r);
          return true;
        }
      }
    }
  }
  return false;
};

// Ooomba o frozen solid (an ice bolt's hit it — see js/systems/Projectiles.js).
WaterSystem.encaseOoomba = function (o) {
  Ice.encase(o);
};

// An Ooomba's ice cube, drawn over it (see main.js's Ooomba drawing).
WaterSystem.drawIceCube = function (e) {
  const image = Ice.getImage();
  const angle = (e.wall || !e.o) ? 0 : Math.atan2(e.o.up.x, -e.o.up.y);
  love.graphics.setColor(1, 1, 1, Ice.TUNING.ALPHA * 0.85);
  love.graphics.draw(image, e.cx, e.cy, angle, e.size / image.getWidth(), e.size / image.getHeight(),
    image.getWidth() / 2, image.getHeight() / 2);
  love.graphics.setColor(1, 1, 1, 1);
};

// The ice blocks on the level (a dirt planet's are part of its own
// picture; an Ooomba's cube is drawn with it).
Ice.drawLevel = function () {
  let image = null;
  for (const e of Ice.blocks) {
    if (e.kind !== 'level') continue;
    image = image ?? Ice.getImage();
    love.graphics.setColor(1, 1, 1, Ice.TUNING.ALPHA);
    love.graphics.draw(image, e.x0, e.y0, 0, e.size / image.getWidth(), e.size / image.getHeight());
  }
  love.graphics.setColor(1, 1, 1, 1);
};

// For debugging/tests: the ice blocks.
WaterSystem.debugIce = () => Ice.blocks;

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
    } else if (h.pg) {
      const res = boilPlanetGrid(h.pg, h.c, h.r, amount);
      if (res) [sx, sy, upX, upY] = res;
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

  // Dirt planets' water grids: one for each dirt planet he's anywhere
  // near (made the first time he is), caught up with any dirt blown out.
  if (player) {
    for (const p of state.planetoids ?? []) {
      if (p.isCrackedPlanet && p.rings && p.rings[0] && !planetGrids.has(p)) {
        const dx = player.pos.x - p.pos.x, dy = player.pos.y - p.pos.y;
        const near = p.radius + PLANET_GRID_MAKE_DISTANCE;
        if (dx * dx + dy * dy < near * near) planetGrids.set(p, newPlanetGrid(p));
      }
    }
  }
  for (const g of planetGrids.values()) {
    // (Its gravity switched — see convertPlanetGrid. The fireballs' hot
    // spots there are forgotten: their cells have moved.)
    const mode = g.planet.gravityMode ?? 'core';
    if (g.mode !== mode) {
      convertPlanetGrid(g, mode);
      hotSpots = hotSpots.filter((h) => h.pg !== g);
    }
    catchUpPlanetGrid(g);
    sweepTurningPlanetGrid(g);
  }

  totalWater = 0;
  if (grid) for (const w of grid.water.values()) totalWater += w;
  for (const g of planetGrids.values()) for (const w of g.water.values()) totalWater += w;
  for (const o of oceans.values()) totalWater += o.volume - (o.natural ?? 0);
  for (const d of droplets) if (!d.lava) totalWater += d.volume ?? DROPLET_VOLUME; // (lava's not water)

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

  if (grid || planetGrids.size > 0) {
    stepClock += dt * ts;
    let steps = 0;
    while (stepClock >= STEP_SECONDS && steps < MAX_STEPS_PER_FRAME) {
      if (grid) stepWater(STEP_SECONDS);
      for (const g of planetGrids.values()) stepPlanetWater(g, STEP_SECONDS);
      // (The lava, more slowly — see LAVA_TUNING.STEP_EVERY.)
      lavaStepCount += 1;
      if (lavaStepCount >= LAVA_TUNING.STEP_EVERY) {
        lavaStepCount = 0;
        if (grid) stepWater(STEP_SECONDS, LAVA);
        for (const g of planetGrids.values()) stepPlanetWater(g, STEP_SECONDS, LAVA);
      }
      stepClock -= STEP_SECONDS;
      steps += 1;
    }
    if (stepClock > STEP_SECONDS) stepClock = 0;
    drainIntoPortals(dt * ts);
  }
  // Lava and water meeting (see "Lava meeting water: obsidian").
  if (grid) quenchLevelLava();
  for (const g of planetGrids.values()) quenchPlanetLava(g);
  updateObsidians();
  Ice.update();
  updateLavaEmbers();
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
  return lavaShader;
}

function useLavaShader() {
  const shader = getLavaShader();
  const L = LAVA_TUNING;
  shader.send('time', age);
  shader.send('colorDeep', L.COLOR_DEEP);
  shader.send('colorMid', L.COLOR_MID);
  shader.send('colorHot', L.COLOR_HOT);
  shader.send('glowBand', L.GLOW_BAND);
  shader.send('plasmaScale', L.PLASMA_SCALE);
  shader.send('detailScale', L.PLASMA_DETAIL);
  shader.send('evolveSpeed', L.EVOLVE_SPEED);
  shader.send('scrollSpeed', L.SCROLL_SPEED);
  shader.send('pourSpeed', L.POUR_SPEED);
  shader.send('surfaceFeather', SURFACE_FEATHER);
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
  const cols = grid.cols, water = grid[liquid.key];
  const rippleScale = liquid === LAVA ? LAVA_TUNING.RIPPLE : 1;
  const has = (i) => water.has(i);
  const verts = [];
  if (liquid === WATER) waterfallLandings = [];

  const quad = (x0, yTop0, x1, yTop1, yBottom0, yBottom1, depthTop, depthBottom, stream) => {
    const v1 = [x0, yTop0, depthTop, stream, 1, 1, 1, 1];
    const v2 = [x1, yTop1, depthTop, stream, 1, 1, 1, 1];
    const v3 = [x1, yBottom1, depthBottom, stream, 1, 1, 1, 1];
    const v4 = [x0, yBottom0, depthBottom, stream, 1, 1, 1, 1];
    verts.push(v1, v2, v3, v1, v3, v4);
  };
  const ripple = (x) => (Math.sin(age * 2.2 + x * 0.045) * 1.3 + Math.sin(age * 3.7 - x * 0.11) * 0.6) * rippleScale;

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
    const surface = grid.y0 + (r + 1) * CELL - Math.max(2, total * CELL);
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
      for (const nc of [c - d, c + d]) {
        const n = r * cols + nc;
        if (nc >= 0 && nc < cols && stackFloor.has(n) && !capped.has(stackFloor.get(n)) && stackSurface.get(n) < stackSurface.get(i)) {
          capDepth.set(i, stackSurface.get(i) - stackSurface.get(n));
          break;
        }
      }
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
        if (liquid === WATER && streamBottom - fallTop >= WATERFALL_SPLASH_MIN_FALL) {
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

  if (verts.length === 0) return;
  drawLiquidMesh(liquid.key, verts, liquid);
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
// The obsidian blocks on the level (see "Lava meeting water"). (A dirt
// planet's are part of its own picture.)
function drawLevelObsidian() {
  let image = null;
  for (const e of obsidians) {
    if (e.kind !== 'level') continue;
    image = image ?? getObsidianImage();
    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.draw(image, e.x0, e.y0, 0, e.size / image.getWidth(), e.size / image.getHeight());
  }
}

function drawLavaEmbers() {
  for (const e of lavaEmbers) {
    const a = Math.max(0, e.life);
    love.graphics.setColor(1, 0.35 + 0.5 * a, 0.05 + 0.25 * a, a);
    love.graphics.circle('fill', e.x, e.y, e.radius);
  }
}

WaterSystem.draw = function () {
  const g = love.graphics;
  drawLevelObsidian();
  if (grid) drawPools(WATER);
  for (const pg of planetGrids.values()) drawPlanetWater(pg, WATER);
  // The ice blocks, in the water (see "Ice").
  Ice.drawLevel();
  // The lava, over the water (and, like it, over Bob: he's in it).
  if (grid && grid.lava.size > 0) drawPools(LAVA);
  for (const pg of planetGrids.values()) {
    if (pg.lava.size > 0) drawPlanetWater(pg, LAVA);
  }
  drawLavaEmbers();

  g.setLineWidth(2.5);
  for (const d of droplets) {
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
  for (const s of splashes) {
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

WaterSystem.isSpraying = () => isSpraying;
WaterSystem.totalWater = () => Math.max(0, totalWater);
WaterSystem.waterCap = () => WATER_CAP;
WaterSystem.debugOcean = (p) => (oceans.has(p) ? oceans.get(p).volume : 0);
// -> [grid, isSolid, CELL]
WaterSystem.debugGrid = () => [grid, isSolid, CELL];
// For debugging/tests: the obsidian blocks (see "Lava meeting water").
WaterSystem.debugObsidians = () => obsidians;
// For debugging/tests: planet p's water grid, if it has one (see "Water on
// a dirt planet"), and its cell lookup and solid test: [grid, cellOf, solid, CELL].
WaterSystem.debugPlanetGrid = (p) => [planetGrids.get(p) ?? null, planetCellOf, planetSolid, CELL];
// For debugging/tests: how much resting water each portal has taken in
// (cells' worth, all-time): { red, blue }.
WaterSystem.debugPortalFlow = () => portalTakenIn;

export default WaterSystem;
