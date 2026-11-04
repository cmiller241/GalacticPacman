// js/systems/water/Obsidian.js
//
// Lava meeting water: obsidian blocks, melting them, lava embers and glow.
// Part of the water system: see js/systems/WaterSystem.js.

import love from '../../love/index.js';
import state from '../../state.js';
import Vector2 from '../../vector2.js';
import utils from '../../utils.js';
import Lava from '../../world/Lava.js';
import { CELL, HOT_SECONDS, STEAM_BURST, LAVA_TUNING } from './Tuning.js';
import { shared, Ice } from './Shared.js';
import { inGrid, isSolid, addWater, boilGrid } from './LevelGrid.js';
import {
  planetPoint, planetUp, planetIndex, planetCellCenter, planetCellOf,
  boilPlanetGrid,
} from './PlanetGrids.js';
import { spawnSteam } from './Effects.js';

// Functions it adds to WaterSystem (copied on in js/systems/WaterSystem.js).
const WaterSystem = {};

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
  shared.hotSpots.push({ pg, c: wc, r: wr, life: HOT_SECONDS, steamBudget: 0 });
}

// The level's tile (tc, tr) turned to obsidian, where lava in it met
// water in cell (wc, wr).
function hardenLevelTile(tc, tr, wc, wr) {
  const g = shared.grid;
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
  shared.obsidians.push(entry);

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
  shared.obsidians.push(entry);

  const ring = p.rings[i];
  const a = ring.offset + (j + 0.5) * ring.step + p.rotationAngle;
  const ux = Math.cos(a), uy = Math.sin(a);
  steamWhereMet(g, wc, wr, p.pos.x + ux * ring.outer, p.pos.y + uy * ring.outer, ux, uy);
}

// Lava touching water anywhere on the level: the tile each such bit of
// lava is in turns to obsidian.
function quenchLevelLava() {
  const g = shared.grid;
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
    const g = shared.grid;
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
  for (const g of shared.planetGrids.values()) {
    const hitList = g.planet.blockHits;
    if (!hitList) continue;
    for (const h of hitList) {
      for (const e of shared.obsidians) {
        if (e.planet === g.planet && e.ring === h.ring && e.j === h.j) startMelt(e);
      }
      for (const e of [...Ice.blocks]) {
        if (e.planet === g.planet && e.ring === h.ring && e.j === h.j) Ice.melt(e);
      }
    }
    g.planet.blockHits = null;
  }

  for (let k = shared.obsidians.length - 1; k >= 0; k--) {
    const e = shared.obsidians[k];
    const ov = e.overlay;
    if (!ov) continue;
    if (e.melting) {
      if (ov.coolDir === 0 && ov.cool <= 0) {
        removeFrom(state.lavas ?? [], ov);
        e.overlay = null;
        finishMelt(e);
        shared.obsidians.splice(k, 1);
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
  if (shared.grid) {
    const cols = shared.grid.cols, lava = shared.grid.lava;
    for (const [i, l] of lava) {
      if (lava.has(i - cols)) continue;
      const r = Math.floor(i / cols);
      const c = i - r * cols;
      const x = shared.grid.x0 + (c + 0.5) * CELL;
      const y = shared.grid.y0 + (r + 1) * CELL - Math.min(1, l) * CELL;
      if (x > vx0 && x < vx1 && y > vy0 && y < vy1) fn(x, y, 0, -1, c, r, null, l);
    }
  }
  for (const g of shared.planetGrids.values()) {
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
    shared.lavaEmbers.push({
      x: x - uy * along, y: y + ux * along,
      vx: -uy * drift + ux * speed, vy: ux * drift + uy * speed,
      life: 1, decay: 1 / life,
      radius: L.EMBER_RADIUS_MIN + Math.random() * (L.EMBER_RADIUS_MAX - L.EMBER_RADIUS_MIN),
    });
  });
  // (Finished ones noted as they go and removed together at the end —
  // see utils.removeMarked. Likewise the steam, droplets and splashes.)
  let gone = null;
  for (let k = shared.lavaEmbers.length - 1; k >= 0; k--) {
    const e = shared.lavaEmbers[k];
    e.x += e.vx * ts; e.y += e.vy * ts;
    e.life -= e.decay * ts / 60;
    if (e.life <= 0) (gone ??= new Set()).add(e);
  }
  if (gone) utils.removeMarked(shared.lavaEmbers, gone);
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

export { getObsidianImage, removeFrom, planetTileCells, quenchLevelLava, quenchPlanetLava, pourLava, updateObsidians, updateLavaEmbers };
export { WaterSystem as api };
