// js/levels/CrackedPlanets.js
//
// The two planets built from js/world/CrackedPlanetoid.js:
//   * the cracked planet: rings of dirt clods round a cracked core, which
//     fireballs blow out. Out past the right end of the sky dome, a
//     little above its deck.
//   * the Tiled planet: the Tiled map Level2 wrapped round a planet (see
//     CrackedPlanetoid.fromTiledMap), with a tunnel through it. Straight
//     below the cracked planet.
// Port of lua/levels/CrackedPlanets.lua.

import state from '../state.js';
import CrackedPlanetoid from '../world/CrackedPlanetoid.js';
import Ooomba from '../entities/Ooomba.js';
import level2Map from './Level2.js';

const CrackedPlanets = {};

const CRACKED_PLANET_CORE_RADIUS = 320;
const CRACKED_PLANET_BRICK_LAYERS = 14; // 32 units each, so 768 to the outside
const CRACKED_PLANET_GAP = 1800; // from the dome's right edge to the planet's center
const CRACKED_PLANET_ABOVE_DECK = 400;
const TILED_PLANET_GAP = 1200; // between the two planets' outsides

CrackedPlanets.buildCracked = function (dome) {
  const cracked = CrackedPlanetoid.new(
    dome.pos.x + dome.halfWidth + CRACKED_PLANET_GAP, dome.pos.y - CRACKED_PLANET_ABOVE_DECK,
    CRACKED_PLANET_CORE_RADIUS, CRACKED_PLANET_BRICK_LAYERS, [0.52, 0.36, 0.24, 1]);
  state.planetoids.push(cracked);
  state.crackedPlanet = cracked;
};

// Needs the cracked planet (it's placed below it).
CrackedPlanets.buildTiled = function () {
  const cracked = state.crackedPlanet;
  if (!cracked) return;
  const radius = CrackedPlanetoid.tiledMapRadius(level2Map);
  const tiledPlanet = CrackedPlanetoid.fromTiledMap(
    cracked.pos.x, cracked.pos.y + cracked.radius + TILED_PLANET_GAP + radius,
    level2Map, [0.45, 0.32, 0.2, 1]);
  state.planetoids.push(tiledPlanet);
  state.tiledPlanet = tiledPlanet;
};

// Ooombas placed on the Tiled planet's own map, each set down on the
// ground under where it was placed, patrolling round the planet (see
// Ooomba.newOnCrackedPlanet). Must run after DomeInterior.build, which
// starts state.ooombas afresh.
CrackedPlanets.addTiledPlanetOoombas = function () {
  if (!state.tiledPlanet) return;
  state.ooombas = state.ooombas ?? [];
  for (const spawn of state.tiledPlanet.objectSpawns ?? []) {
    if (spawn.class !== 'Ooomba') continue;
    const direction = Math.random() < 0.5 ? -1 : 1;
    const o = Ooomba.newOnCrackedPlanet(state.tiledPlanet, spawn.lx, spawn.ly, { direction });
    if (o) state.ooombas.push(o);
  }
};

export default CrackedPlanets;
