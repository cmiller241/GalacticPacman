// js/systems/water/LevelGrid.js
//
// The Tiled level's water grid: laying it out, its cells, and stepping
// its water and lava.
// Part of the water system: see js/systems/WaterSystem.js.

import state from '../../state.js';
import { CELL, DRY, BOIL_REACH_CELLS } from './Tuning.js';
import { shared, rnd, pick, Scratch, WATER } from './Shared.js';

// Functions it adds to WaterSystem (copied on in js/systems/WaterSystem.js).
const WaterSystem = {};

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

  shared.grid = g;
};

// -> [c, r]
function cellOf(x, y) {
  return [Math.floor((x - shared.grid.x0) / CELL), Math.floor((y - shared.grid.y0) / CELL)];
}

function inGrid(c, r) {
  return c >= 0 && c < shared.grid.cols && r >= 0 && r < shared.grid.rows;
}

function gateCovers(c, r) {
  // (Called for nearly every neighbor the water looks at: no `?? []`
  // array made each time when there are no gates.)
  const gates = state.gates;
  if (!gates) return false;
  const x = shared.grid.x0 + (c + 0.5) * CELL, y = shared.grid.y0 + (r + 0.5) * CELL;
  for (const gate of gates) {
    if (gate.halfHeight > 1 && Math.abs(x - gate.pos.x) <= gate.halfWidth
        && Math.abs(y - gate.pos.y) <= gate.halfHeight) return true;
  }
  return false;
}

function isSolid(c, r) {
  if (r >= shared.grid.rows) return true;
  if (c < 0 || c >= shared.grid.cols || r < 0) return false;
  return shared.grid.solid[r * shared.grid.cols + c] === 1 || gateCovers(c, r);
}

function blocked(c, r, dc, dr) {
  const nc = c + dc, nr = r + dr;
  if (isSolid(nc, nr)) return true;
  if (nc < 0 || nc >= shared.grid.cols || nr < 0) return false;
  const floors = shared.grid.floor.get(nr * shared.grid.cols + nc);
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
  const i = r * shared.grid.cols + c;
  const liquid = shared.grid[key];
  liquid.set(i, (liquid.get(i) ?? 0) + amount);
}

// Water `w` in level cell i (column c, row r) spreading sideways along
// whatever it's resting on (ground, or full water) — toward lower
// neighbors, evening out into a flat surface. Returns what's left in it.
// (liquid: WATER or LAVA — which map, and how runny.)
function spreadSideways(i, w, c, r, liquid) {
  const cols = shared.grid.cols, water = shared.grid[liquid.key];
  const resting = blocked(c, r, 0, 1) || (water.get(i + cols) ?? 0) >= 0.99;
  if (resting && w > liquid.minSpread) {
    for (let k = 1; k <= 2; k++) {
      const dc = ((k === 1) === shared.grid.flip) ? -1 : 1;
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
  const cols = shared.grid.cols, water = shared.grid[liquid.key];
  const list = Scratch.collectCells(water).sort((a, b) => b - a);
  shared.grid.flip = !shared.grid.flip;

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
    shared.grid.flip = !shared.grid.flip;
    // (Any order: only falling needs the bottom rows first.)
    for (const i of Scratch.collectCells(water)) {
      let w = water.get(i);
      if (w === undefined) continue;
      const r = Math.floor(i / cols);
      w = spreadSideways(i, w, i - r * cols, r, liquid);
      if (w < DRY) water.delete(i); else water.set(i, w);
    }
  }
}

// The water line over grid cell (c, r), if it's wet.
function surfaceAt(c, r) {
  const water = shared.grid.water, cols = shared.grid.cols;
  let i = r * cols + c;
  if (!water.has(i)) return null;
  while (r > 0 && water.has(i - cols)) { i -= cols; r -= 1; }
  return shared.grid.y0 + (r + 1) * CELL - Math.min(1, water.get(i)) * CELL;
}

// Boils `amount` off the surface round (c, r). -> [x, y] or null
function boilGrid(c, r, amount) {
  const water = shared.grid.water, cols = shared.grid.cols;
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
  return [shared.grid.x0 + (pk.c + rnd()) * CELL, surfaceAt(pk.c, pk.r) ?? (shared.grid.y0 + (pk.r + 1) * CELL)];
}

export { cellOf, inGrid, isSolid, blocked, addWater, stepWater, surfaceAt, boilGrid };
export { WaterSystem as api };
