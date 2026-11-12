// js/levels/TetrisPlanet.js
//
// The Tetris planet: a round planet with a small control room inside
// (see js/interiors/ControlRoom.js, drawn automatically for any
// planetoid with an .interior). The beam on its top takes him in; the
// one on the room's pad takes him back out. At the room's control panel
// he spins the planet, and Tetris shapes fall in at it from all sides,
// sticking where they land and turning with it (see
// js/world/TetrisField.js).
//
// It never drifts, and is kept clear of random spawns all round (the
// shapes fall in from a long way out).

import state from '../state.js';
import Vector2 from '../vector2.js';
import worldGen from '../setup/WorldGen.js';
import Planetoid from '../world/Planetoid.js';
import Beam from '../world/Beam.js';
import ControlRoom from '../interiors/ControlRoom.js';
import TetrisField from '../world/TetrisField.js';

const TetrisPlanet = {};

const OFFSET_X = 6500, OFFSET_Y = -8500; // from the sun
const COLOR = [0.50, 0.36, 0.72];
const BEAM_COLOR = [1.00, 0.45, 0.80];
const RADIUS = 420;

TetrisPlanet.build = function () {
  const [sunX, sunY] = worldGen.sunPos();
  const planet = Planetoid.new(sunX + OFFSET_X, sunY + OFFSET_Y, RADIUS, COLOR);
  planet.isImmovable = true;
  planet.isPermanent = true;
  planet.isSpawnExclusion = true;
  planet.vel.x = 0; planet.vel.y = 0;
  planet.interior = new ControlRoom(planet, new TetrisField(planet), BEAM_COLOR);
  // (Every frame: the game eases the planet's turn and drops its shapes.)
  planet.update = function () { this.interior.updateGame(); };
  state.planetoids.push(planet);
  state.tetrisPlanet = planet;
  return planet;
};

// The beam in, on top (shown while he's outside), and the beam out, on
// the room's pad (shown while he's in).
TetrisPlanet.addBeams = function (planet) {
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

export default TetrisPlanet;
