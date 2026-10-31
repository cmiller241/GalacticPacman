// js/levels/WaterPlanets.js
//
// The water planets (see js/world/WaterPlanet.js) and their fish: one
// big one a cell diagonally past the belt's outer edge, a second smaller
// one beside it, and three small ones below that. Port of
// lua/levels/WaterPlanets.lua.

import state from '../state.js';
import worldGen from '../setup/WorldGen.js';
import WaterPlanet from '../world/WaterPlanet.js';
import Fish from '../entities/Fish.js';

const WaterPlanets = {};

WaterPlanets.build = function () {
  const cellSize = worldGen.CELL_SIZE;
  const [sunCol, sunRow] = worldGen.sunCell();
  const waterCol = sunCol + 3, waterRow = sunRow + 3;
  const waterX = (waterCol + 0.5) * cellSize;
  const waterY = (waterRow + 0.5) * cellSize;
  const [waterPlanet, waterCore] = WaterPlanet.new(waterX, waterY, 960);
  state.planetoids.push(waterPlanet, waterCore);
  state.waterPlanet = waterPlanet;
  state.waterCore = waterCore;

  state.fish = [];
  const FISH_COUNT = 6;
  for (let k = 0; k < FISH_COUNT; k++) state.fish.push(Fish.new(waterPlanet, waterCore));

  // A second, smaller one, just close enough that a fish's cross-pool
  // jump can reach it (see Fish.js).
  const water2X = waterX + 1820;
  const water2Y = waterY + 750;
  const [waterPlanet2, waterCore2] = WaterPlanet.new(water2X, water2Y, 960 * 0.7);
  state.planetoids.push(waterPlanet2, waterCore2);
  state.waterPlanet2 = waterPlanet2;
  state.waterCore2 = waterCore2;

  const FISH_COUNT_2 = 4;
  for (let k = 0; k < FISH_COUNT_2; k++) state.fish.push(Fish.new(waterPlanet2, waterCore2));

  // Three small ones below the second.
  const SMALL_WATER_RADIUS = (960 * 0.7) * 0.5;
  const smallWaterOffsets = [[-650, 1050], [100, 1200], [900, 900]];
  for (const off of smallWaterOffsets) {
    const [wp, wc] = WaterPlanet.new(water2X + off[0], water2Y + off[1], SMALL_WATER_RADIUS);
    state.planetoids.push(wp, wc);
    for (let k = 0; k < 3; k++) state.fish.push(Fish.new(wp, wc));
  }
};

export default WaterPlanets;
