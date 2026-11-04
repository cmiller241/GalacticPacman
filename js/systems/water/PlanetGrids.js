// js/systems/water/PlanetGrids.js
//
// Water on a dirt planet: a grid of the planet's own, bent round it.
// Part of the water system: see js/systems/WaterSystem.js.

import lua from '../../love/lua.js';
import { CELL, DRY, BOIL_REACH_CELLS } from './Tuning.js';
import { shared, pick, Scratch, WATER } from './Shared.js';

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
  for (const g of shared.planetGrids.values()) {
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
  const list = Scratch.collectCells(water).sort((a, b) => b - a); // (lowest rows first)
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
    for (const i of Scratch.collectCells(water)) {
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

export { PLANET_GRID_MAKE_DISTANCE, planetPoint, planetUp, planetColWidth, planetCol, planetIndex, planetCellCenter, sweepTurningPlanetGrid, newPlanetGrid, planetCellOf, catchUpPlanetGrid, planetSolid, addPlanetWater, convertPlanetGrid, planetGridAt, stepPlanetWater, planetSurfaceAt, boilPlanetGrid };
