// js/systems/water/Oceans.js
//
// Water layers on round planetoids (and rounded rectangles).
// Part of the water system: see js/systems/WaterSystem.js.

import state from '../../state.js';
import { CELL } from './Tuning.js';
import { shared } from './Shared.js';

// Functions it adds to WaterSystem (copied on in js/systems/WaterSystem.js).
const WaterSystem = {};

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
  let o = shared.oceans.get(p);
  if (!o) {
    o = { volume: 0, water: { isPool: true, pos: p.pos, radius: p.radius } };
    shared.oceans.set(p, o);
  }
  o.volume += amount;
}

// A planetoid that starts out under water (see WaterPlanet.js).
WaterSystem.addNaturalOcean = function (core, outerRadius, marker) {
  const volume = Math.PI * (outerRadius * outerRadius - core.radius * core.radius) / (CELL * CELL);
  addToOcean(core, volume);
  const o = shared.oceans.get(core);
  o.natural = (o.natural ?? 0) + volume;
  o.marker = marker;
  if (marker) marker.radius = outerRadius;
};

function forgetCulledOceans() {
  if (shared.oceans.size === 0) return;
  const alive = new Set(state.planetoids ?? []);
  for (const p of [...shared.oceans.keys()]) {
    if (!alive.has(p)) shared.oceans.delete(p);
  }
}

export { holdsWater, perimeterOf, depthOf, surfaceDistance, addToOcean, forgetCulledOceans };
export { WaterSystem as api };
