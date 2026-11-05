// js/levels/World.js
//
// Builds every hand-placed part of the world — the landmarks, the dome's
// Tiled interior, the player — called once per love.load (so again on
// every EXIT TO TITLE). The random asteroid-belt field around them is
// js/setup/WorldGen.js's job, streamed in afterwards. Port of
// lua/levels/World.lua.
//
// Each landmark lives in its own module next to this one. They're built
// in a fixed order, and the order matters:
//   * later landmarks are placed relative to earlier ones (the
//     fisherman's planet sits above the second water planet, the mining
//     planet below the belt landing planet, ...);
//   * state.planetoids' order is the order planets are drawn and
//     collided in;
//   * RobotButler reads state.beams[0] as the home beam;
//   * several builders draw random numbers, so moving one changes the
//     world every later one makes.
// So add new landmarks at the end unless they must come earlier.
//
// (This folder also holds the Tiled maps converted from tiled/ —
// Level1.js, Level2.js, Pinball-Level2.js — which the builders import.)

import state from '../state.js';
import constants from '../constants.js';
import worldGen from '../setup/WorldGen.js';
import Player from '../entities/Player.js';
import MissileOutpost from '../world/MissileOutpost.js';

import SkyDome from './SkyDome.js';
import PinballPlanet from './PinballPlanet.js';
import WaterPlanets from './WaterPlanets.js';
import FishermanPlanet from './FishermanPlanet.js';
import CrackedPlanets from './CrackedPlanets.js';
import BeltLanding from './BeltLanding.js';
import MiningPlanet from './MiningPlanet.js';
import DomeInterior from './DomeInterior.js';
import Expressway from './Expressway.js';
import MazePlanet from './MazePlanet.js';

const World = {};

// Switch optional landmarks off here (e.g. to test without them).
World.SHOW = {
  pinballPlanet: true,   // the pinball planet and its entry beam
  crackedPlanet: true,
  tiledPlanet: true,     // needs crackedPlanet (it's placed below it)
  expressway: true,      // the expressway and its entries/exits
  missileOutposts: true,
  mazePlanet: true,      // the maze planet and its entry beam
};

World.HOME_CELL_COL = SkyDome.HOME_CELL_COL;
World.HOME_CELL_ROW = SkyDome.HOME_CELL_ROW;

// The player starts behind the shelter's closed door: the opening beat
// (see SpaceShelter.js) slides it open around him, then closes it once
// he's stepped out. state.introLocked keeps movement input from
// interrupting that.
function spawnPlayer(dome) {
  const topY = dome.trueSurfaceY();
  const doorwayX = state.spaceShelter ? state.spaceShelter.getDoorwayPosition()[0] : dome.pos.x;
  state.player = Player.new(doorwayX, topY - constants.PLAYER_RADIUS);
  state.player.onSurface = true;
  state.player.currentPlanet = dome;
  state.player.lastInfluencePlanet = dome;
  state.player.angle = -Math.PI / 2;
  state.introLocked = true;

  // Where Player.respawn puts him back after dying — this same doorway.
  state.respawnPoint = { x: doorwayX, y: topY - constants.PLAYER_RADIUS, planet: dome };
}

// Missile outposts just past the belt's outer edge (see
// js/world/MissileOutpost.js). Random spawns are kept off them.
function buildMissileOutposts() {
  const [sunX, sunY] = worldGen.sunPos();
  const [beltInner, beltOuter] = worldGen.beltRadii();
  state.outposts = MissileOutpost.createAll(sunX, sunY, beltInner, beltOuter);
  state.clearLanes = state.clearLanes ?? [];
  for (const o of state.outposts) {
    const p = o.planet;
    state.clearLanes.push([p.pos.x, p.pos.y, p.pos.x, p.pos.y, p.radius + 700]);
  }
}

// -> { dome, expresswayEntry: { planet, cannon } or null }
World.build = function () {
  const SHOW = World.SHOW;

  const dome = SkyDome.build();
  if (SHOW.pinballPlanet) PinballPlanet.build(dome);
  WaterPlanets.build();
  FishermanPlanet.build();
  if (SHOW.crackedPlanet) CrackedPlanets.buildCracked(dome);
  if (SHOW.tiledPlanet) CrackedPlanets.buildTiled();
  SkyDome.addRobotButler(dome);
  FishermanPlanet.addFisherman();
  BeltLanding.build(dome);
  MiningPlanet.build();
  if (state.pinballPlanet) PinballPlanet.addEntryBeam(state.pinballPlanet);
  DomeInterior.build(dome);
  BeltLanding.addSign();
  CrackedPlanets.addTiledPlanetOoombas();
  spawnPlayer(dome);

  const expresswayEntry = SHOW.expressway ? Expressway.build() : null;
  if (SHOW.missileOutposts) buildMissileOutposts();
  if (SHOW.mazePlanet) MazePlanet.addEntryBeam(MazePlanet.build());

  return { dome, expresswayEntry };
};

export default World;
