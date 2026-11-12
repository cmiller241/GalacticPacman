// js/levels/ZumaPlanet.js
//
// The Zuma planet: a round planet with a small control room inside (see
// js/interiors/ControlRoom.js, drawn automatically for any planetoid with
// an .interior). The beam on its top takes him in; the one on the room's
// pad takes him back out. At the room's control panel a cannon comes up
// on the planet's surface, a black hole forms out in space, and a train
// of colored balls rolls out of it, spiraling in round the planet (see
// js/world/ZumaField.js).
//
// It sits in the middle of a world cell of its own (CELL_FROM_SUN cells
// from the sun's, out past the asteroid belt), and never drifts. Nothing
// random is made in its cell or the eight round it (spawnExclusionCells —
// see WorldGen's cellIntersectsLandmark), and a planetoid drifting in from
// further off bounces off a ring round the whole game (keepOutRadius —
// see main.js's updatePlanetoidsPhysics), so nothing floats into it.

import state from '../state.js';
import Vector2 from '../vector2.js';
import worldGen from '../setup/WorldGen.js';
import Planetoid from '../world/Planetoid.js';
import Beam from '../world/Beam.js';
import ControlRoom from '../interiors/ControlRoom.js';
import ZumaField from '../world/ZumaField.js';

const ZumaPlanet = {};

// Which cell, counted from the sun's (columns right, rows down).
const CELL_FROM_SUN = [4, 1];
const RADIUS = 300;
const COLOR = [0.32, 0.58, 0.36];      // jungle green
const BEAM_COLOR = [1.00, 0.80, 0.30]; // gold

ZumaPlanet.build = function () {
  const [sunCol, sunRow] = worldGen.sunCell();
  const size = worldGen.CELL_SIZE;
  const x = (sunCol + CELL_FROM_SUN[0] + 0.5) * size;
  const y = (sunRow + CELL_FROM_SUN[1] + 0.5) * size;
  const planet = Planetoid.new(x, y, RADIUS, COLOR);
  planet.isImmovable = true;
  planet.isPermanent = true;
  planet.isSpawnExclusion = true;
  planet.spawnExclusionCells = 1; // (its cell and the eight round it)
  planet.keepOutRadius = ZumaField.REACH;
  planet.vel.x = 0; planet.vel.y = 0;
  planet.interior = new ControlRoom(planet, new ZumaField(planet), BEAM_COLOR);
  // (Every frame: the game runs, and animates whether he's playing or not.)
  planet.update = function () { this.interior.updateGame(); };
  state.planetoids.push(planet);
  state.zumaPlanet = planet;
  return planet;
};

// The beam in, on top (shown while he's outside), and the beam out, on
// the room's pad (shown while he's in).
ZumaPlanet.addBeams = function (planet) {
  const interior = planet.interior;
  const pad = interior.padPosition();
  const exit = interior.exitPosition();

  const inBeam = Beam.new(planet.pos.x, planet.pos.y - planet.radius, -Math.PI / 2, BEAM_COLOR);
  inBeam.destination = {
    pos: pad,
    angle: -Math.PI / 2,
    onArrive: (player) => interior.onEnter(player),
  };
  inBeam.showWhen = () => !interior.hasPlayer();

  const outBeam = Beam.new(pad.x, pad.y, -Math.PI / 2, BEAM_COLOR);
  outBeam.destination = {
    pos: Vector2.new(exit.x, exit.y),
    angle: ControlRoom.EXIT_ANGLE,
    onArrive: (player) => interior.arriveOutside(player),
  };
  outBeam.showWhen = () => interior.hasPlayer();
  outBeam.fade = 0; // (hidden from the start, not fading out)
  // (A small room: he has to be at the pad, not just near it.)
  outBeam.interactRadius = 70;

  interior.beam = outBeam;
  state.beams.push(inBeam);
  state.beams.push(outBeam);
};

export default ZumaPlanet;
