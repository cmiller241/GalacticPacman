// js/systems/water/Ice.js
//
// Ice: the ice blaster freezing water into blocks, and the blocks melting,
// moving and floating.
// Part of the water system: see js/systems/WaterSystem.js.

import love from '../../love/index.js';
import lua from '../../love/lua.js';
import state from '../../state.js';
import Vector2 from '../../vector2.js';
import TiledTerrain from '../../world/TiledTerrain.js';
import IceBolt from '../../entities/IceBolt.js';
import { CELL, QUENCH_AT, STEAM_BURST, LAVA_TUNING } from './Tuning.js';
import { shared, Ice } from './Shared.js';
import { cellOf, inGrid, isSolid, blocked, addWater } from './LevelGrid.js';
import { planetIndex, planetCellCenter, planetCellOf, planetGridAt } from './PlanetGrids.js';
import { spawnSplash, spawnSteam } from './Effects.js';
import { removeFrom, planetTileCells, pourLava } from './Obsidian.js';

// Functions it adds to WaterSystem (copied on in js/systems/WaterSystem.js).
const WaterSystem = {};

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
  const g = shared.grid;
  const S = Ice.TUNING.SIZE, cols = shared.grid.cols;
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
    const g = shared.grid, S = Ice.TUNING.SIZE;
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
    if (shared.grid && e.level) {
      const [c, r] = cellOf(cx, e.cy + e.size / 2 - CELL / 2);
      for (let dc = -1; dc <= 1; dc++) {
        if (inGrid(c + dc, r) && !isSolid(c + dc, r)) addWater(c + dc, r, e.water / 3);
      }
    }
  }
  if (e.wall) {
    removeFrom((e.level ?? (shared.grid && shared.grid.level) ?? {}).walls ?? [], e.wall);
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
  const g = shared.grid, S = Ice.TUNING.SIZE;
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
  const g = shared.grid, S = Ice.TUNING.SIZE;
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
  const g = shared.grid, S = Ice.TUNING.SIZE;
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
    if (e.kind === 'level' && levelDue && shared.grid) Ice.stepLevelBlock(e);
    else if (e.kind === 'planet' && planetDue && shared.planetGrids.get(e.planet) === e.g) Ice.stepPlanetBlock(e);
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
    } else if (shared.grid) {
      const [c, r] = cellOf(x, y);
      if (inGrid(c, r)) {
        const i = r * shared.grid.cols + c;
        if ((shared.grid.lava.get(i) ?? 0) >= LAVA_TUNING.TOUCH) {
          addWater(c, r, Ice.TUNING.LAVA_WATER);
          return true;
        }
        if ((shared.grid.water.get(i) ?? 0) >= QUENCH_AT) {
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

export { WaterSystem as api };
