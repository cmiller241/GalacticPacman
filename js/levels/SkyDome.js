// js/levels/SkyDome.js
//
// The home sky dome, the Space Shelter on its deck, and the robot butler
// beside the shelter. (The Tiled terrain inside the dome is
// js/levels/DomeInterior.js.) Port of lua/levels/SkyDome.lua.

import state from '../state.js';
import worldGen from '../setup/WorldGen.js';
import SkyDomePlanetoid from '../world/SkyDomePlanetoid.js';
import SpaceShelter from '../world/SpaceShelter.js';
import RobotButler from '../entities/RobotButler.js';
import GrassBlades from '../effects/GrassBlades.js';

const SkyDome = {};

// The home dome's cell, counted from the sun's own cell, so it stays in
// the same place relative to the sun whatever size the map is.
SkyDome.HOME_CELL_COL = worldGen.GRID_SIZE / 2 + 3;
SkyDome.HOME_CELL_ROW = worldGen.GRID_SIZE / 2 - 1;

// Builds the dome and the shelter on it. -> the dome
SkyDome.build = function () {
  const cellSize = worldGen.CELL_SIZE;
  const domeHalfW = 4000;
  // Left edge of the home cell, hull just inside the cell.
  const domeX = SkyDome.HOME_CELL_COL * cellSize + domeHalfW + 80;
  const domeY = SkyDome.HOME_CELL_ROW * cellSize + cellSize * 0.5;

  const dome = SkyDomePlanetoid.new(domeX, domeY, {
    halfWidth: domeHalfW,
    halfHeight: 32,
    grassHeight: 32,
    // Tied to domeHalfW: resizing the dome only needs that one number changed.
    domeRadiusX: domeHalfW,
    domeRadiusY: domeHalfW,
  });
  dome.isPermanent = true;
  state.planetoids.push(dome);

  // Tufts of grass blades along the walkable deck (decoration — see
  // js/effects/GrassBlades.js), coloured from its grass texture.
  const deckHalfW = dome.halfWidth - (dome.cornerRadius ?? 0);
  dome.grassBlades = GrassBlades.buildStrip(dome.pos.x - deckHalfW, dome.pos.x + deckHalfW,
    dome.trueSurfaceY(), 'img/grass.png', dome.pos.x);

  // The astronaut's home shelter, on the dome's deck toward its left side.
  state.spaceShelter = SpaceShelter.new(domeX - domeHalfW * 0.6, dome.trueSurfaceY());
  state.skyDomePlanet = dome;
  return dome;
};

// Robot butler NPC, pacing just right of the shelter.
SkyDome.addRobotButler = function (dome) {
  const ROBOT_GAP_FROM_SHELTER = 60;
  const robotHomeX = state.spaceShelter.pos.x + state.spaceShelter.drawWidth / 2 + ROBOT_GAP_FROM_SHELTER;
  state.robotButler = RobotButler.new(robotHomeX, dome.trueSurfaceY());
};

export default SkyDome;
