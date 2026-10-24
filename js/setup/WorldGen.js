// js/setup/WorldGen.js
//
// Cell streaming + annular sun belt (2–3 cell radii). The world is a
// GRID_SIZE x GRID_SIZE grid of CELL_SIZE cells; the 3x3 cells round the
// stream focus (the camera's center) are generated, and everything else
// culled. Belt planetoids orbit the sun and are topped up by a steady
// "drip" upstream of the player (updateBeltSpawning). Deterministic
// FireBar slots are spread across the belt's radial width.
//
// Port notes: sunPos/beltRadii/sunCell/streamFocus return arrays;
// cellCoordFor returns {col, row}.

import lua from '../love/lua.js';
import state from '../state.js';
import Planetoid from '../world/Planetoid.js';
import Asteroid from '../entities/Asteroid.js';
import Coin from '../entities/Coin.js';
import FireBar from '../world/FireBar.js';
import utils from '../utils.js';

const worldGen = {};
const rnd = () => lua.random();

worldGen.CELL_SIZE = 3000;
worldGen.GRID_SIZE = 40;
worldGen.CENTER_CELL = { col: worldGen.GRID_SIZE / 2, row: worldGen.GRID_SIZE / 2 };
worldGen.CELL_CHECK_INTERVAL = 30;

worldGen.BELT_INNER_CELLS = 2;
worldGen.BELT_OUTER_CELLS = 3;
worldGen.BELT_ORBIT_SPEED = 1.8 * 1.5;

worldGen.BELT_SPAWN_INTERVAL = 6;
worldGen.BELT_MAX_TOTAL_PLANETOIDS = 500;
worldGen.BELT_CELL_BURST_RESPECTS_CAP = true;
const BELT_SPAWN_ARC_SPACING = 300;
const BELT_DRIFT_RADIUS_MIN = 28;
const BELT_DRIFT_RADIUS_MAX = 64;
const BELT_HIDE_MARGIN = 350;
const BELT_HIDE_STEP = 150;
const BELT_HIDE_MAX_STEPS = 35;
const BELT_EXTRA_STAGGER_FRAC = 0.4;

worldGen.BELT_CULL_RADIUS_CELLS = 3;

worldGen.FIREBAR_COUNT = 36;
worldGen.FIREBAR_EDGE_COUNT = 10;

const PLANETOIDS_PER_CELL = 6;
const BELT_PLANETOIDS_PER_CELL = 36;
const ASTEROIDS_PER_CELL = 2;
const COINS_PER_PLANET_BASE = 4;

const BELT_COIN_MAX = 2;
const randomBeltCoinCount = () => lua.random(0, BELT_COIN_MAX);

const PLANET_COLORS = [
  [0.75, 0.78, 0.85, 1],
  [0.95, 0.45, 0.40, 1],
  [0.45, 0.85, 0.50, 1],
  [0.95, 0.85, 0.40, 1],
  [0.55, 0.55, 0.70, 1],
  [0.80, 0.55, 0.35, 1],
];

// The point streaming centers on: the camera's center (which follows a
// scripted camera tour too), or the player if there's no camera yet.
// -> [x, y] or [null, null]
worldGen.streamFocus = function () {
  const cam = state.camera;
  if (!cam) {
    if (!state.player) return [null, null];
    return [state.player.pos.x, state.player.pos.y];
  }
  return [cam.x + (state.visibleWidth ?? 0) / 2, cam.y + (state.visibleHeight ?? 0) / 2];
};

worldGen.cellCoordFor = function (worldX, worldY) {
  return {
    col: Math.floor(worldX / worldGen.CELL_SIZE),
    row: Math.floor(worldY / worldGen.CELL_SIZE),
  };
};

worldGen.cellKey = (col, row) => col + ',' + row;

worldGen.sunPos = function () {
  const w = state.sceneWidth ?? (worldGen.CELL_SIZE * worldGen.GRID_SIZE);
  const h = state.sceneHeight ?? (worldGen.CELL_SIZE * worldGen.GRID_SIZE);
  return [w / 2, h / 2];
};

worldGen.sunCell = function () {
  const [sx, sy] = worldGen.sunPos();
  let col = Math.floor(sx / worldGen.CELL_SIZE);
  let row = Math.floor(sy / worldGen.CELL_SIZE);
  col = Math.max(0, Math.min(worldGen.GRID_SIZE - 1, col));
  row = Math.max(0, Math.min(worldGen.GRID_SIZE - 1, row));
  return [col, row];
};

worldGen.beltRadii = function () {
  return [worldGen.BELT_INNER_CELLS * worldGen.CELL_SIZE, worldGen.BELT_OUTER_CELLS * worldGen.CELL_SIZE];
};

worldGen.isInBeltRing = function (x, y) {
  const [sx, sy] = worldGen.sunPos();
  const dx = x - sx, dy = y - sy;
  const d = Math.sqrt(dx * dx + dy * dy);
  const [inner, outer] = worldGen.beltRadii();
  return d > inner && d < outer;
};

worldGen.cellIntersectsBelt = function (col, row) {
  const [sx, sy] = worldGen.sunPos();
  const [inner, outer] = worldGen.beltRadii();
  const x0 = col * worldGen.CELL_SIZE, y0 = row * worldGen.CELL_SIZE;
  const x1 = x0 + worldGen.CELL_SIZE, y1 = y0 + worldGen.CELL_SIZE;
  const cx = Math.max(x0, Math.min(sx, x1));
  const cy = Math.max(y0, Math.min(sy, y1));
  const nearest = Math.sqrt((sx - cx) ** 2 + (sy - cy) ** 2);
  let farthest = 0;
  for (const [px, py] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
    const d = Math.sqrt((px - sx) ** 2 + (py - sy) ** 2);
    if (d > farthest) farthest = d;
  }
  return nearest < outer && farthest > inner;
};

// ---------------------------------------------------------------------
// Deterministic FireBar slots, spread across the belt's radial width
// ---------------------------------------------------------------------

const FIREBAR_RADIAL_JITTER = 0.75;
const FIREBAR_EDGE_MARGIN = 0.08;
const FIREBAR_EDGE_JITTER = 0.3;

function fireBarSlots() {
  if (worldGen._fireBarSlots) return worldGen._fireBarSlots;
  const [inner, outer] = worldGen.beltRadii();
  const width = outer - inner;
  const midR = (inner + outer) * 0.5;
  const halfSpan = width * 0.5;
  const [sx, sy] = worldGen.sunPos();
  const slots = [];
  let nextId = 0;

  const addSlot = (ang, r) => {
    const x = sx + Math.cos(ang) * r;
    const y = sy + Math.sin(ang) * r;
    const cell = worldGen.cellCoordFor(x, y);
    slots.push({
      id: nextId, x, y,
      startAngle: ang + Math.PI / 2,
      col: cell.col, row: cell.row,
      key: worldGen.cellKey(cell.col, cell.row),
    });
    nextId += 1;
  };

  for (let i = 0; i < worldGen.FIREBAR_COUNT; i++) {
    const ang = (i / worldGen.FIREBAR_COUNT) * Math.PI * 2;
    const radialJitter = (rnd() * 2 - 1) * FIREBAR_RADIAL_JITTER;
    addSlot(ang, midR + radialJitter * halfSpan);
  }

  const innerCount = Math.floor(worldGen.FIREBAR_EDGE_COUNT / 2);
  const outerCount = worldGen.FIREBAR_EDGE_COUNT - innerCount;
  const edgeMargin = FIREBAR_EDGE_MARGIN * width;
  const angleStagger = Math.PI / worldGen.FIREBAR_COUNT;

  for (let i = 0; i < innerCount; i++) {
    const ang = angleStagger + (i / innerCount) * Math.PI * 2;
    const jitter = (rnd() * 2 - 1) * FIREBAR_EDGE_JITTER * edgeMargin;
    addSlot(ang, inner + edgeMargin + jitter);
  }
  for (let i = 0; i < outerCount; i++) {
    const ang = angleStagger + (i / outerCount) * Math.PI * 2;
    const jitter = (rnd() * 2 - 1) * FIREBAR_EDGE_JITTER * edgeMargin;
    addSlot(ang, outer - edgeMargin + jitter);
  }

  worldGen._fireBarSlots = slots;
  return slots;
}

function generateFireBarsForCell(col, row) {
  state.fireBars = state.fireBars ?? [];
  state.activeFireBarIds = state.activeFireBarIds ?? {};
  const key = worldGen.cellKey(col, row);
  for (const slot of fireBarSlots()) {
    if (slot.key === key && !state.activeFireBarIds[slot.id]) {
      const bar = FireBar.new(slot.x, slot.y, {
        barLength: 420,
        numFireballs: 10,
        startAngle: slot.startAngle,
        rotationSpeed: 0.05,
      });
      bar.fireBarId = slot.id;
      bar.isPermanent = false;
      state.fireBars.push(bar);
      state.activeFireBarIds[slot.id] = true;
    }
  }
}

const randomColor = () => PLANET_COLORS[lua.random(1, PLANET_COLORS.length) - 1];

// Radii snapped to RADIUS_STEP so baked planetoid bodies can be shared.
const RADIUS_STEP = 5;
function randomQuantizedRadius(min, max, step) {
  step = step ?? RADIUS_STEP;
  const steps = Math.floor((max - min) / step);
  return min + lua.random(0, steps) * step;
}

const BELT_PLANETOID_MIN_GAP = 20;
const BELT_PLACEMENT_ATTEMPTS = 30;

function applyBeltOrbit(planet) {
  planet.isBeltPlanetoid = true;
  const [sunX, sunY] = worldGen.sunPos();
  const dx = planet.pos.x - sunX;
  const dy = planet.pos.y - sunY;
  let dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1) dist = 1;
  planet.vel.x = (-dy / dist) * worldGen.BELT_ORBIT_SPEED;
  planet.vel.y = (dx / dist) * worldGen.BELT_ORBIT_SPEED;
  planet.beltOrbitRadius = dist;
}

// ---------------------------------------------------------------------
// Ongoing belt drip
// ---------------------------------------------------------------------

// Walks back along the belt ring from `theta` until off-screen, plus a
// little randomized extra. -> [x, y]
function pushUpstreamUntilHidden(theta, r, radius) {
  const [sunX, sunY] = worldGen.sunPos();
  let x = sunX + Math.cos(theta) * r;
  let y = sunY + Math.sin(theta) * r;
  let steps = 0;
  while (utils.isOnScreen(x, y, radius, BELT_HIDE_MARGIN) && steps < BELT_HIDE_MAX_STEPS) {
    theta -= BELT_HIDE_STEP / r;
    x = sunX + Math.cos(theta) * r;
    y = sunY + Math.sin(theta) * r;
    steps += 1;
  }

  const extra = rnd() * worldGen.CELL_SIZE * BELT_EXTRA_STAGGER_FRAC;
  theta -= extra / r;
  return [sunX + Math.cos(theta) * r, sunY + Math.sin(theta) * r];
}

function spawnDriftingBeltPlanetoid(refTheta) {
  const [inner, outer] = worldGen.beltRadii();
  const rInner = inner + 10, rOuter = outer - 10;
  const radius = randomQuantizedRadius(BELT_DRIFT_RADIUS_MIN, BELT_DRIFT_RADIUS_MAX);

  let x, y;
  let placed = false;
  for (let k = 0; k < BELT_PLACEMENT_ATTEMPTS; k++) {
    // (Uniform in r^2, for an even scatter over the annulus' area.)
    const r = Math.sqrt(rInner * rInner + rnd() * (rOuter * rOuter - rInner * rInner));
    [x, y] = pushUpstreamUntilHidden(refTheta, r, radius);
    if (!beltPlanetoidTooClose(x, y, radius)) { placed = true; break; }
  }
  if (!placed) return null;

  const p = Planetoid.new(x, y, radius, randomColor());
  applyBeltOrbit(p);
  state.planetoids.push(p);

  const numCoins = randomBeltCoinCount();
  for (let i = 1; i <= numCoins; i++) {
    const coin = Coin.new(p);
    coin.angle = (i / numCoins) * Math.PI * 2 + rnd() * 0.2;
    if (coin.updatePosition) coin.updatePosition();
    state.coins.push(coin);
  }
  return p;
}

function countBeltPlanetoids() {
  let count = 0;
  for (const p of state.planetoids) if (p.isBeltPlanetoid) count += 1;
  return count;
}

function focusNearBelt(fx, fy) {
  const focusCell = worldGen.cellCoordFor(fx, fy);
  for (let dRow = -1; dRow <= 1; dRow++) {
    for (let dCol = -1; dCol <= 1; dCol++) {
      if (worldGen.cellIntersectsBelt(focusCell.col + dCol, focusCell.row + dRow)) return true;
    }
  }
  return false;
}

let lastFocusBeltTheta = null;

// Called every BELT_SPAWN_INTERVAL frames from main.js.
worldGen.updateBeltSpawning = function () {
  const [fx, fy] = worldGen.streamFocus();
  if (fx == null || !focusNearBelt(fx, fy)) {
    lastFocusBeltTheta = null;
    return;
  }

  const [sunX, sunY] = worldGen.sunPos();
  const dx = fx - sunX, dy = fy - sunY;
  let dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1) dist = 1;
  const theta = Math.atan2(dy, dx);

  const [inner, outer] = worldGen.beltRadii();
  const pacingR = Math.max(inner + 10, Math.min(outer - 10, dist));

  let spawnsNeeded = 1;
  if (lastFocusBeltTheta != null) {
    let d = theta - lastFocusBeltTheta;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const arcMoved = Math.abs(d) * pacingR;
    spawnsNeeded = Math.max(1, Math.ceil(arcMoved / BELT_SPAWN_ARC_SPACING));
  }
  lastFocusBeltTheta = theta;

  let total = countBeltPlanetoids();
  for (let k = 0; k < spawnsNeeded; k++) {
    if (total >= worldGen.BELT_MAX_TOTAL_PLANETOIDS) break;
    if (!spawnDriftingBeltPlanetoid(theta)) break;
    total += 1;
  }
};

const SKYDOME_SPAWN_MARGIN = 200;

// -> [cx, cy, r] or null
function skyDomeExclusionCircle() {
  const dome = state.skyDomePlanet;
  if (!dome) return null;
  const cy = dome.domeAnchorY ? dome.domeAnchorY() : dome.pos.y;
  const exclR = Math.max(dome.domeRadiusX ?? 0, dome.domeRadiusY ?? 0, dome.halfWidth ?? 0)
    + (dome.baseRadiusY ?? 0) + SKYDOME_SPAWN_MARGIN;
  return [dome.pos.x, cy, exclR];
}

function isNearSkyDome(x, y) {
  const c = skyDomeExclusionCircle();
  if (!c) return false;
  const [cx, cy, exclR] = c;
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy < exclR * exclR;
}

worldGen.cellIntersectsSkyDome = function (col, row) {
  const c = skyDomeExclusionCircle();
  if (!c) return false;
  const [cx, cy, exclR] = c;
  const x0 = col * worldGen.CELL_SIZE, y0 = row * worldGen.CELL_SIZE;
  const x1 = x0 + worldGen.CELL_SIZE, y1 = y0 + worldGen.CELL_SIZE;
  const nearestX = Math.max(x0, Math.min(cx, x1));
  const nearestY = Math.max(y0, Math.min(cy, y1));
  const dx = cx - nearestX, dy = cy - nearestY;
  return dx * dx + dy * dy < exclR * exclR;
};

const WATER_SPAWN_MARGIN = 150;

worldGen.cellIntersectsWaterPlanet = function (col, row) {
  if (!state.planetoids) return false;
  const x0 = col * worldGen.CELL_SIZE, y0 = row * worldGen.CELL_SIZE;
  const x1 = x0 + worldGen.CELL_SIZE, y1 = y0 + worldGen.CELL_SIZE;
  for (const p of state.planetoids) {
    if (!p.isWaterPlanet) continue;
    const exclR = p.radius + WATER_SPAWN_MARGIN;
    const nearestX = Math.max(x0, Math.min(p.pos.x, x1));
    const nearestY = Math.max(y0, Math.min(p.pos.y, y1));
    const dx = p.pos.x - nearestX, dy = p.pos.y - nearestY;
    if (dx * dx + dy * dy < exclR * exclR) return true;
  }
  return false;
};

const LANDMARK_SPAWN_MARGIN = 600;

worldGen.cellIntersectsLandmark = function (col, row) {
  if (!state.planetoids) return false;
  const x0 = col * worldGen.CELL_SIZE, y0 = row * worldGen.CELL_SIZE;
  const x1 = x0 + worldGen.CELL_SIZE, y1 = y0 + worldGen.CELL_SIZE;
  for (const p of state.planetoids) {
    if (!p.isSpawnExclusion) continue;
    let hw = p.halfWidth ?? p.radius, hh = p.halfHeight ?? p.radius;
    if ((p.rotationSpeed ?? 0) !== 0) {
      const reach = Math.sqrt(hw * hw + hh * hh);
      hw = reach; hh = reach;
    }
    hw += LANDMARK_SPAWN_MARGIN; hh += LANDMARK_SPAWN_MARGIN;
    if (x1 > p.pos.x - hw && x0 < p.pos.x + hw && y1 > p.pos.y - hh && y0 < p.pos.y + hh) return true;
  }
  return false;
};

// Lanes kept clear of random spawns: state.clearLanes, each
// [ax, ay, bx, by, halfWidth].
worldGen.isInClearLane = function (x, y, radius) {
  for (const lane of (state.clearLanes ?? [])) {
    const [ax, ay, bx, by, halfWidth] = lane;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lenSq)) : 0;
    const px = ax + dx * t, py = ay + dy * t;
    const reach = halfWidth + (radius ?? 0);
    if ((x - px) ** 2 + (y - py) ** 2 < reach * reach) return true;
  }
  return false;
};

// -> [x, y]
function randomPointInCell(col, row, radius) {
  const originX = col * worldGen.CELL_SIZE, originY = row * worldGen.CELL_SIZE;
  let x, y;
  for (let k = 0; k < 20; k++) {
    x = originX + radius + rnd() * (worldGen.CELL_SIZE - 2 * radius);
    y = originY + radius + rnd() * (worldGen.CELL_SIZE - 2 * radius);
    if (!isNearSkyDome(x, y) && !worldGen.isInClearLane(x, y, radius)) return [x, y];
  }
  return [x, y];
}

// Rejection sampling of a point in the cell that's inside the belt. -> [x, y]
function randomPointInCellBelt(col, row, radius) {
  const x0 = col * worldGen.CELL_SIZE, y0 = row * worldGen.CELL_SIZE;
  for (let k = 0; k < 200; k++) {
    const x = x0 + radius + rnd() * (worldGen.CELL_SIZE - 2 * radius);
    const y = y0 + radius + rnd() * (worldGen.CELL_SIZE - 2 * radius);
    if (worldGen.isInBeltRing(x, y) && !isNearSkyDome(x, y)) return [x, y];
  }

  const [sx, sy] = worldGen.sunPos();
  const [inner, outer] = worldGen.beltRadii();
  const x = x0 + radius + rnd() * (worldGen.CELL_SIZE - 2 * radius);
  const y = y0 + radius + rnd() * (worldGen.CELL_SIZE - 2 * radius);
  let dx = x - sx, dy = y - sy;
  let d = Math.sqrt(dx * dx + dy * dy);
  if (d < 1) { d = 1; dx = 1; dy = 0; }
  const clampedD = Math.max(inner + radius, Math.min(outer - radius, d));
  return [sx + (dx / d) * clampedD, sy + (dy / d) * clampedD];
}

function beltPlanetoidTooClose(x, y, radius) {
  for (const p of state.planetoids) {
    if (p.radius && !p.isRoundedRect) {
      const dx = p.pos.x - x, dy = p.pos.y - y;
      const minDist = p.radius + radius + BELT_PLANETOID_MIN_GAP;
      if (dx * dx + dy * dy < minDist * minDist) return true;
    }
  }
  return false;
}

function createPlanetoidsInCell(col, row, count, belt) {
  const created = [];
  for (let i = 0; i < count; i++) {
    const radius = belt ? randomQuantizedRadius(28, 64) : randomQuantizedRadius(30, 70);
    let x, y;
    let placed = true;
    if (belt) {
      placed = false;
      for (let k = 0; k < BELT_PLACEMENT_ATTEMPTS; k++) {
        [x, y] = randomPointInCellBelt(col, row, radius);
        if (!beltPlanetoidTooClose(x, y, radius)) { placed = true; break; }
      }
    } else {
      [x, y] = randomPointInCell(col, row, radius);
      placed = !worldGen.isInClearLane(x, y, radius);
    }
    if (placed) {
      const p = Planetoid.new(x, y, radius, randomColor());
      if (belt) applyBeltOrbit(p);
      state.planetoids.push(p);
      created.push(p);
    }
  }
  return created;
}

function createAsteroidsInCell(col, row, count) {
  for (let i = 0; i < count; i++) {
    const radius = 16 + rnd() * 30;
    const [x, y] = randomPointInCell(col, row, radius);
    if (!worldGen.isInClearLane(x, y, radius)) state.asteroids.push(Asteroid.new(x, y, radius));
  }
}

function createCoinsForPlanetoids(planetoids) {
  for (const planet of planetoids) {
    const numCoins = planet.isBeltPlanetoid
      ? randomBeltCoinCount()
      : COINS_PER_PLANET_BASE + Math.floor(planet.radius / 10);
    for (let i = 1; i <= numCoins; i++) {
      const coin = Coin.new(planet);
      coin.angle = (i / numCoins) * Math.PI * 2 + rnd() * 0.2;
      if (coin.updatePosition) coin.updatePosition();
      state.coins.push(coin);
    }
  }
}

function generateCell(col, row) {
  const key = worldGen.cellKey(col, row);
  if (state.activeCells[key]) return;
  state.activeCells[key] = true;

  const belt = worldGen.cellIntersectsBelt(col, row);

  // Regular cells touched by the dome, a water planet or a landmark stay
  // empty (belt cells are exempt — their points steer clear on their own).
  if (!belt && (worldGen.cellIntersectsSkyDome(col, row) || worldGen.cellIntersectsWaterPlanet(col, row)
      || worldGen.cellIntersectsLandmark(col, row))) return;

  let planetCount = belt ? BELT_PLANETOIDS_PER_CELL : PLANETOIDS_PER_CELL;
  if (belt && worldGen.BELT_CELL_BURST_RESPECTS_CAP) {
    const room = worldGen.BELT_MAX_TOTAL_PLANETOIDS - countBeltPlanetoids();
    planetCount = Math.max(0, Math.min(planetCount, room));
  }
  const regulars = createPlanetoidsInCell(col, row, planetCount, belt);

  if (!belt) createAsteroidsInCell(col, row, ASTEROIDS_PER_CELL);

  createCoinsForPlanetoids(regulars);
  generateFireBarsForCell(col, row);
}

function cullDistantObjects(activeCellKeys, focusX, focusY) {
  const beltCullRadius = worldGen.BELT_CULL_RADIUS_CELLS * worldGen.CELL_SIZE;
  const keyOf = (x, y) => {
    const cell = worldGen.cellCoordFor(x, y);
    return worldGen.cellKey(cell.col, cell.row);
  };

  for (let i = state.planetoids.length - 1; i >= 0; i--) {
    const p = state.planetoids[i];
    if (p.isPermanent) continue;
    if (p.isBeltPlanetoid) {
      if (focusX != null) {
        const dx = p.pos.x - focusX, dy = p.pos.y - focusY;
        if (dx * dx + dy * dy > beltCullRadius * beltCullRadius) state.planetoids.splice(i, 1);
      }
    } else if (!activeCellKeys[keyOf(p.pos.x, p.pos.y)]) {
      state.planetoids.splice(i, 1);
    }
  }

  const survivingPlanetoids = new Set(state.planetoids);

  if (state.asteroids) {
    for (let i = state.asteroids.length - 1; i >= 0; i--) {
      const a = state.asteroids[i];
      if (!activeCellKeys[keyOf(a.pos.x, a.pos.y)] && !a.isGauntlet) state.asteroids.splice(i, 1);
    }
  }

  if (state.coins) {
    for (let i = state.coins.length - 1; i >= 0; i--) {
      const c = state.coins[i];
      if (!c.planet || !survivingPlanetoids.has(c.planet)) {
        state.coins.splice(i, 1);
      } else if (!c.planet.isBeltPlanetoid && !activeCellKeys[keyOf(c.planet.pos.x, c.planet.pos.y)]) {
        state.coins.splice(i, 1);
      }
    }
  }

  if (state.fireBars) {
    state.activeFireBarIds = state.activeFireBarIds ?? {};
    for (let i = state.fireBars.length - 1; i >= 0; i--) {
      const bar = state.fireBars[i];
      if (!activeCellKeys[keyOf(bar.pos.x, bar.pos.y)]) {
        if (bar.fireBarId != null) delete state.activeFireBarIds[bar.fireBarId];
        state.fireBars.splice(i, 1);
      }
    }
  }
}

worldGen.updateActiveCells = function () {
  const [fx, fy] = worldGen.streamFocus();
  if (fx == null) return;

  const focusCell = worldGen.cellCoordFor(fx, fy);
  const activeCellKeys = {};

  for (let dRow = -1; dRow <= 1; dRow++) {
    for (let dCol = -1; dCol <= 1; dCol++) {
      const col = focusCell.col + dCol, row = focusCell.row + dRow;
      if (col >= 0 && col < worldGen.GRID_SIZE && row >= 0 && row < worldGen.GRID_SIZE) {
        activeCellKeys[worldGen.cellKey(col, row)] = true;
        generateCell(col, row);
      }
    }
  }

  for (const key of Object.keys(state.activeCells)) {
    if (!activeCellKeys[key]) delete state.activeCells[key];
  }

  cullDistantObjects(activeCellKeys, fx, fy);
};

worldGen.initWorldSize = function () {
  state.sceneWidth = worldGen.CELL_SIZE * worldGen.GRID_SIZE;
  state.sceneHeight = worldGen.CELL_SIZE * worldGen.GRID_SIZE;
  state.gridSize = worldGen.GRID_SIZE;
  state.activeCells = {};
  state.planetoids = state.planetoids ?? [];
  state.asteroids = state.asteroids ?? [];
  state.coins = state.coins ?? [];
  state.fireBars = state.fireBars ?? [];
  state.activeFireBarIds = {};
  worldGen._fireBarSlots = null;
};

worldGen.generateStartingNeighborhood = function (centerCol, centerRow) {
  centerCol = centerCol ?? worldGen.CENTER_CELL.col;
  centerRow = centerRow ?? worldGen.CENTER_CELL.row;
  for (let dRow = -1; dRow <= 1; dRow++) {
    for (let dCol = -1; dCol <= 1; dCol++) {
      const col = centerCol + dCol, row = centerRow + dRow;
      if (col >= 0 && col < worldGen.GRID_SIZE && row >= 0 && row < worldGen.GRID_SIZE) generateCell(col, row);
    }
  }
};

export default worldGen;
