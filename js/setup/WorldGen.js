// js/setup/worldGen.js
// Cell-based world streaming: the constants defining the world's cell
// grid, generation of a single cell's contents, and the periodic
// generate/cull pass that keeps only the player's 3x3 neighborhood
// populated. Split out of game.js specifically because this logic is
// self-contained (only ever reads/writes state.planetoids/asteroids/
// coins/enemies/activeCells, never anything belonging to the player,
// input, or asset loading) and is needed by BOTH levelSetup.js (for
// the initial cell) and game.js's own gameLoop (for the ongoing
// streaming tick) — pulling it out here avoids either of those two
// needing to import from the other for it.
import { state } from '../state.js';
import { planetColors, enemyColors } from '../constants.js';
import { Planetoid } from '../world/Planetoid.js';
import { SpikeyPlanetoid } from '../world/SpikeyPlanetoid.js';
import { Asteroid } from '../entities/world/Asteroid.js';
import { Coin } from '../entities/world/Coin.js';
import { SpaceGhost } from '../entities/world/SpaceGhost.js';
import { initCellManifest, getCellManifest, generateSpecialCell, updateBeltSpawning, shouldKeepBeltPlanetoid } from '../world/CellManifest.js';

// ----------------------------
// CELL-BASED WORLD STREAMING
// ----------------------------
// The world is a fixed 20x20 grid of cells. state.sceneWidth/Height are
// now the FULL world size — a constant, independent of the browser
// window (unlike before, where they were derived from canvas size).
// Only a 3x3 neighborhood of cells around the player is ever populated
// at once; everything else is generated on approach and culled on
// departure. See generateCell()/updateActiveCells()/cullDistantObjects()
// below.
export const CELL_SIZE = 3000; // world units per cell, both axes
export const GRID_SIZE = 20;   // 20x20 cells total
export const CENTER_CELL = { col: 10, row: 10 }; // where the permanent planets + player start live
export const CELL_CHECK_INTERVAL = 15; // frames between generation/cull passes — doesn't need to run every frame

state.sceneWidth = CELL_SIZE * GRID_SIZE;
state.sceneHeight = CELL_SIZE * GRID_SIZE;
// Exposed so Minimap.js can draw the correct number of grid lines
// without needing a (circular) import back into this file.
state.gridSize = GRID_SIZE;
// Lets CellManifest.js convert its cell-space belt coordinates into
// world-space once CELL_SIZE is known, without it needing to import
// (and hardcode a dependency on) this file's constants directly.
initCellManifest(CELL_SIZE);

// Per-cell density. Divided down from the original single-scene counts
// (44 regular / 16 spikey / 24 asteroids) by roughly the 3x3 active-
// neighborhood size, so the worst case (all 9 cells populated) lands
// back near the original totals instead of ~9x them. Tune independently
// once you've seen it in play — no need to match the old numbers exactly.
const PLANETOIDS_PER_CELL = 10;
const SPIKEY_PER_CELL = 10;
const ASTEROIDS_PER_CELL = 20;
const MAX_ENEMIES_PER_CELL = 5;

// ----------------------------
// CELL HELPERS
// ----------------------------
export function cellCoordFor(worldX, worldY) {
  return {
    col: Math.floor(worldX / CELL_SIZE),
    row: Math.floor(worldY / CELL_SIZE)
  };
}

export function cellKey(col, row) {
  return `${col},${row}`;
}

// Populates one cell with regular/spikey planetoids, asteroids, coins
// (one batch per regular planetoid, same density formula as before),
// and up to MAX_ENEMIES_PER_CELL enemies. No-ops (returns []) if this
// cell is already active. Returns the regular planetoids it created —
// only used by initGame() to pick a starting planet for the player.
// Phase 1: just the regular (non-hazardous) planetoids for a cell.
// Split out from hazard generation below specifically so initGame() can
// generate these FIRST, pick a starting planet from them, and only then
// generate hazards for that same cell — now knowing exactly what to
// steer them away from. Every other cell just runs both phases back to
// back via generateCell() with no avoidance, same as before.
export function generateRegularPlanetoidsInCell(col, row) {
  const originX = col * CELL_SIZE;
  const originY = row * CELL_SIZE;
  const regularPlanetoids = [];

  for (let i = 0; i < PLANETOIDS_PER_CELL; i++) {
    const radius = 30 + Math.random() * 40; // 30-70
    const x = originX + radius + Math.random() * (CELL_SIZE - 2 * radius);
    const y = originY + radius + Math.random() * (CELL_SIZE - 2 * radius);
    const color = planetColors[Math.floor(Math.random() * planetColors.length)];
    const p = new Planetoid(x, y, radius, color);
    p.createOffscreen();
    state.planetoids.push(p);
    regularPlanetoids.push(p);
  }

  return regularPlanetoids;
}

// Phase 2: spikey planetoids, asteroids, coins, and enemies for a cell.
// avoidPos/avoidRadius are optional — when given (only used for the
// player's starting cell, see initGame()), spikey planetoids and
// asteroids reroll their position (up to a bounded number of attempts,
// rather than looping forever if a cell is crowded) until they land
// outside avoidRadius of avoidPos, and enemies are only assigned to
// planets that are themselves far enough away. Coins aren't touched —
// they aren't hazards, and regular planetoids close to the player are
// fine (only spikey/asteroids/enemies can kill on contact).
export function generateHazardsAndExtrasInCell(col, row, regularPlanetoids, avoidPos = null, avoidRadius = 0) {
  const originX = col * CELL_SIZE;
  const originY = row * CELL_SIZE;
  const MAX_REROLLS = 20;
  const avoidRadiusSq = avoidRadius * avoidRadius;
  const isSafe = (x, y) => !avoidPos || ((x - avoidPos.x) ** 2 + (y - avoidPos.y) ** 2) >= avoidRadiusSq;

  for (let i = 0; i < SPIKEY_PER_CELL; i++) {
    const radius = 25 + Math.random() * 15; // 25-40
    let x, y, attempts = 0;
    do {
      x = originX + radius + Math.random() * (CELL_SIZE - 2 * radius);
      y = originY + radius + Math.random() * (CELL_SIZE - 2 * radius);
      attempts++;
    } while (!isSafe(x, y) && attempts < MAX_REROLLS);
    const p = new SpikeyPlanetoid(x, y, radius);
    p.createOffscreen();
    state.planetoids.push(p);
  }

  for (let i = 0; i < ASTEROIDS_PER_CELL; i++) {
    const radius = 20 + Math.random() * 25; // 20-45
    let x, y, attempts = 0;
    do {
      x = originX + radius + Math.random() * (CELL_SIZE - 2 * radius);
      y = originY + radius + Math.random() * (CELL_SIZE - 2 * radius);
      attempts++;
    } while (!isSafe(x, y) && attempts < MAX_REROLLS);
    state.asteroids.push(new Asteroid(x, y, radius));
  }

  regularPlanetoids.forEach((planet) => {
    const numCoins = 4 + Math.floor(planet.radius / 10);
    for (let i = 0; i < numCoins; i++) {
      const coin = new Coin(planet);
      coin.angle = (i / numCoins) * Math.PI * 2 + Math.random() * 0.2;
      state.coins.push(coin);
    }
  });

  // Enemies don't have an independent spawn position to reroll — they're
  // tied to a planet — so instead we just restrict which planets are
  // eligible to host one.
  const safePlanetsForEnemies = avoidPos
    ? regularPlanetoids.filter(p => isSafe(p.pos.x, p.pos.y))
    : regularPlanetoids;
  const numEnemies = Math.min(MAX_ENEMIES_PER_CELL, safePlanetsForEnemies.length);
  for (let i = 0; i < numEnemies; i++) {
    const planet = safePlanetsForEnemies[Math.floor(Math.random() * safePlanetsForEnemies.length)];
    const color = enemyColors[i % enemyColors.length];
    state.enemies.push(new SpaceGhost(planet, color));
  }
}

// Normal (no-avoidance) full generation for a cell — both phases back
// to back. Used for every cell EXCEPT the player's starting one, which
// initGame() generates in two separate steps instead (see there).
//
// Checks CellManifest first — a non-null result means this cell is
// hand-authored (e.g. part of the asteroid belt), and normal
// procedural generation is skipped entirely for it. Special cells
// return an empty regularPlanetoids list, since nothing currently
// picks a player-starting-spawn from a special cell (CENTER_CELL is
// nowhere near the belt) — worth revisiting if that ever changes.
function generateCell(col, row) {
  const key = cellKey(col, row);
  if (state.activeCells.has(key)) return [];
  state.activeCells.add(key);

  const manifest = getCellManifest(col, row);
  if (manifest) {
    generateSpecialCell(col, row, manifest);
    return [];
  }

  const regularPlanetoids = generateRegularPlanetoidsInCell(col, row);
  generateHazardsAndExtrasInCell(col, row, regularPlanetoids);
  return regularPlanetoids;
}

// Removes anything whose CURRENT position (not spawn origin — objects
// drift between cells via their own velocity) has fallen outside the
// active neighborhood. Planetoids are mutated IN PLACE (spliced, not
// filtered-and-reassigned) so GravitySystem's cached array reference —
// captured once at construction — stays valid; reassigning
// state.planetoids here would silently break gravity for anything
// generated or culled after the first pass.
// True if a world point falls within a generous exclusion zone around
// the SkyDomePlanetoid ground — used to keep hazards (regular/spikey
// planetoids, asteroids, enemies) from EVER existing inside what's
// meant to read as a safe, enclosed pocket, regardless of how they got
// there (procedural generation near the dome's cell, an enemy jumping
// planet to planet, ordinary drift). Rather than teaching every
// different generation code path about the dome individually — there
// are several, some of which don't cleanly support per-position
// rejection — this is enforced as a periodic sweep (see
// cullDistantObjects below), the same way distance-based culling
// already works, which guarantees "never" regardless of the source. A
// single generous circular zone, sized to comfortably cover both the
// platform body and the dome shell with margin, rather than precisely
// carving out the two shapes separately — simpler, and errs toward
// excluding slightly more area rather than risking a gap.
// True only when a world point is MEANINGFULLY inside the dome's true
// ellipse boundary — not "near" it. An earlier version used a radius
// PADDED beyond the dome's actual size, which was the bug this fixes:
// that padding made the cull zone bigger than the dome's real
// collision surface, so an approaching planetoid got deleted before it
// ever got close enough to trigger the actual bounce physics — the two
// systems were fighting, and the cull always won first. Using the true
// radius (with a modest 10% INSET as a safety margin, not padding
// outward) means normal bouncing — which re-corrects position every
// single frame — will always keep a properly-colliding object outside
// this zone by the time the cull sweep samples it (only every 15
// frames): this only ever catches something ALREADY inside some other
// way (generation, a teleport, a rare fast-object tunneling edge
// case), never something merely on its way toward a normal bounce.
function isInsideSkyDome(worldX, worldY) {
  if (!state.skyDomePlanet) return false;
  const dome = state.skyDomePlanet;
  const topY = dome.pos.y - dome.halfHeight;
  if (worldY > topY) return false; // at/below the platform's own top line isn't "inside the dome" — the dome shape only exists above that line
  const insetFactor = 0.9;
  const nx = (worldX - dome.pos.x) / (dome.domeRadiusX * insetFactor);
  const ny = (worldY - topY) / (dome.domeRadiusY * insetFactor);
  return (nx * nx + ny * ny) < 1;
}

function cullDistantObjects(activeCellKeys) {
  for (let i = state.planetoids.length - 1; i >= 0; i--) {
    const p = state.planetoids[i];
    if (p.isPermanent) continue;

    if (p.isBeltPlanetoid) {
      // Grid-cell membership doesn't work for belt planetoids — hiding
      // one from camera view can require pushing it into negative/
      // out-of-grid coordinates when the player is near the world's
      // edge column, and no cell index out there can ever be "active."
      // shouldKeepBeltPlanetoid measures plain distance along the
      // belt's own direction instead, which has no concept of grid
      // boundaries at all.
      if (!shouldKeepBeltPlanetoid(p, state.player.pos.x, state.player.pos.y)) {
        state.planetoids.splice(i, 1);
      }
      continue;
    }

    if (isInsideSkyDome(p.pos.x, p.pos.y)) {
      state.planetoids.splice(i, 1);
      continue;
    }

    // Note: this does NOT stop non-belt content from drifting INTO
    // belt/buffer territory over time — only from being GENERATED
    // there in the first place (see getCellManifest / generateCell).
    // That's intentional: drifting in is fine, it's only unwanted
    // GENERATION inside the corridor that's the actual problem.
    const { col, row } = cellCoordFor(p.pos.x, p.pos.y);
    if (!activeCellKeys.has(cellKey(col, row))) {
      state.planetoids.splice(i, 1);
    }
  }

  // Built AFTER the planetoid splice above, so it reflects exactly
  // what survived — used below to detect "this coin/enemy's planet was
  // just culled" in O(1) rather than an O(n) Array.includes() per item.
  const survivingPlanetoids = new Set(state.planetoids);

  state.asteroids = state.asteroids.filter(a => {
    if (isInsideSkyDome(a.pos.x, a.pos.y)) return false;
    const { col, row } = cellCoordFor(a.pos.x, a.pos.y);
    return activeCellKeys.has(cellKey(col, row));
  });

  // Coins are tied to a planet's orbit, not an independent position —
  // cull them by their PARENT planet's cell, not their own. Their own
  // position drifts around the planet via the orbit offset, and right
  // when a planet sits near a cell boundary, a coin at the wrong point
  // in its orbit can momentarily compute into a DIFFERENT (still-
  // active) cell than its planet's — letting that one coin survive a
  // pass that removes its planet, which is exactly the "orbiting
  // nothing" bug. Tying it directly to the planet's own position (and
  // treating a just-culled planet as "gone") makes a coin's lifetime
  // strictly match its planet's, with no gap for this to happen.
  state.coins = state.coins.filter(c => {
    if (!c.planet || !survivingPlanetoids.has(c.planet)) return false;
    const { col, row } = cellCoordFor(c.planet.pos.x, c.planet.pos.y);
    return activeCellKeys.has(cellKey(col, row));
  });

  // Enemies have the same risk while grounded (orbiting a planet the
  // same way coins do), but can also be genuinely mid-flight between
  // planets (onSurface === false), where they really do have an
  // independent position — so only grounded enemies defer to their
  // planet; flying ones are culled by their own position as before.
  state.enemies = state.enemies.filter(e => {
    if (e.onSurface && e.planet) {
      if (!survivingPlanetoids.has(e.planet)) return false;
      if (isInsideSkyDome(e.planet.pos.x, e.planet.pos.y)) return false;
      const { col, row } = cellCoordFor(e.planet.pos.x, e.planet.pos.y);
      return activeCellKeys.has(cellKey(col, row));
    }
    if (isInsideSkyDome(e.pos.x, e.pos.y)) return false;
    const { col, row } = cellCoordFor(e.pos.x, e.pos.y);
    return activeCellKeys.has(cellKey(col, row));
  });
}

// The main streaming tick: figures out the player's current cell,
// generates any of the surrounding 3x3 neighborhood that isn't already
// active, deactivates any cell that fell 2+ away (so it regenerates
// fresh if revisited later — no long-term memory of past contents is
// kept), then culls anything outside the resulting active set.
export function updateActiveCells() {
  const playerCell = cellCoordFor(state.player.pos.x, state.player.pos.y);
  const activeCellKeys = new Set();

  for (let dRow = -1; dRow <= 1; dRow++) {
    for (let dCol = -1; dCol <= 1; dCol++) {
      const col = playerCell.col + dCol;
      const row = playerCell.row + dRow;
      if (col < 0 || col >= GRID_SIZE || row < 0 || row >= GRID_SIZE) continue; // off the edge of the 20x20 world
      const key = cellKey(col, row);
      activeCellKeys.add(key);
      generateCell(col, row); // no-op if already active
    }
  }

  for (const key of Array.from(state.activeCells)) {
    if (!activeCellKeys.has(key)) {
      state.activeCells.delete(key);
    }
  }

  cullDistantObjects(activeCellKeys);

  // Belt spawning: gated on actual distance to the belt (see
  // updateBeltSpawning's own comment in CellManifest.js), so it starts
  // filling in before the player arrives, not only once already there.
  updateBeltSpawning(state.player.pos.x, state.player.pos.y);
}