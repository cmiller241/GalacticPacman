// js/levels/MiningPlanet.js
//
// A ball of cyan glass (see js/world/CrystalPlanet.js) that turns, drifts
// and can be ground-pounded along, with the mining prisms growing out of
// it in clusters. It starts directly below the belt landing planet, so
// BeltLanding.build must run first. Port of lua/levels/MiningPlanet.lua.

import state from '../state.js';
import CrystalPlanet from '../world/CrystalPlanet.js';
import Prism from '../world/Prism.js';

const MiningPlanet = {};

const MINING_PLANET_RADIUS = 140;
const MINING_PLANET_PRISM_CLUSTERS = 5;
const MINING_PLANET_BELOW_LANDING_PLANET = 900; // center to center

MiningPlanet.build = function () {
  const anchor = state.beltLandingPlanet;
  const miningPlanet = CrystalPlanet.new(
    anchor.pos.x, anchor.pos.y + MINING_PLANET_BELOW_LANDING_PLANET, MINING_PLANET_RADIUS);
  state.planetoids.push(miningPlanet);
  state.miningPlanet = miningPlanet;
  state.prisms = Prism.scatterClusters(miningPlanet, MINING_PLANET_PRISM_CLUSTERS);
};

export default MiningPlanet;
