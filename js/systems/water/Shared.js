// js/systems/water/Shared.js
//
// State and helpers shared by the water system's parts. (A port of
// lua/systems/water/Shared.lua.)
//
// shared holds the state that WaterSystem.reset replaces (so the parts read it
// as shared.<name>, never keeping their own copy):
//   shared.grid               the Tiled level's water grid (see LevelGrid.js), or null
//   shared.planetGrids        dirt planets' grids, keyed by planet (see PlanetGrids.js)
//   shared.oceans             planetoid -> { volume, water, natural?, marker?, farPos? } (see Oceans.js)
//   shared.droplets           spray in flight
//   shared.splashes           splash bits
//   shared.waterfallLandings  this frame's, from drawPools: { x, y, half, flow }
//   shared.steam              puffs: { x, y, vx, vy, life, maxLife }
//   shared.hotSpots           where fireballs went out
//   shared.lavaEmbers         { x, y, vx, vy, life, decay, radius }
//   shared.obsidians          obsidian blocks lava's turned into (see Obsidian.js)
//   shared.age                seconds since the game started (for the shaders)
// Part of the water system: see js/systems/WaterSystem.js.

import lua from '../../love/lua.js';
import { SPREAD, SPREAD_PASSES, MIN_SPREAD, EVAPORATE_PER_SECOND, LAVA_TUNING } from './Tuning.js';

const shared = {
  grid: null,
  planetGrids: new Map(),
  oceans: new Map(),
  droplets: [],
  splashes: [],
  waterfallLandings: [],
  steam: [],
  hotSpots: [],
  lavaEmbers: [],
  obsidians: [],
  age: 0,
};

// Ice (see Ice.js): its blocks, and its own clock.
const Ice = { blocks: [], frame: 0 };

const rnd = () => lua.random();
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Scratch space reused every frame, so the water's busiest loops don't
// make fresh arrays each time: the wet-cell list stepWater walks, and
// the vertices the pools and oceans are drawn from — only the first
// vertCount of `verts` are this draw's (the rest are kept for reuse).
const Scratch = {
  cells: [],
  verts: [],
  vertCount: 0,

  // Every key of `water` (a liquid's cells), in Scratch.cells.
  collectCells(water) {
    const list = this.cells;
    list.length = 0;
    for (const i of water.keys()) list.push(i);
    return list;
  },

  resetVerts() { this.vertCount = 0; },

  // One vertex: position, texture coordinates (u, v), and alpha.
  vert(x, y, u, v, alpha) {
    const t = this.verts[this.vertCount];
    if (t) {
      t[0] = x; t[1] = y; t[2] = u; t[3] = v; t[7] = alpha;
    } else {
      this.verts[this.vertCount] = [x, y, u, v, 1, 1, 1, alpha];
    }
    this.vertCount++;
  },

  // Two triangles over the corners 1-2-3-4 (top edge 1->2, bottom edge
  // 4->3): depthTop/depthBottom are their u, stream their v.
  quad(x1, y1, x2, y2, x3, y3, x4, y4, depthTop, depthBottom, stream) {
    this.vert(x1, y1, depthTop, stream, 1); this.vert(x2, y2, depthTop, stream, 1); this.vert(x3, y3, depthBottom, stream, 1);
    this.vert(x1, y1, depthTop, stream, 1); this.vert(x3, y3, depthBottom, stream, 1); this.vert(x4, y4, depthBottom, stream, 1);
  },
};

// How each liquid moves (see stepWater): which of a grid's maps it's kept
// in, and its rules.
const WATER = { key: 'water', spread: SPREAD, passes: SPREAD_PASSES, minSpread: MIN_SPREAD, evaporate: EVAPORATE_PER_SECOND };
const LAVA = {
  key: 'lava', spread: LAVA_TUNING.SPREAD, passes: LAVA_TUNING.SPREAD_PASSES,
  minSpread: LAVA_TUNING.MIN_SPREAD, evaporate: 0,
};

export { shared, rnd, pick, Ice, Scratch, WATER, LAVA };
