// js/levels/MazePlanet.js
//
// The maze planet: a square rounded rectangle holding a cube of six maze
// faces, one showing at a time (see js/interiors/MazeInterior.js), up and
// to the left of the sun just past the belt, and the one-way beam on its
// top that drops him in the middle of the front face, already a ball.
// Port of lua/levels/MazePlanet.lua.

import state from '../state.js';
import worldGen from '../setup/WorldGen.js';
import RoundedRectPlanetoid from '../world/RoundedRectPlanetoid.js';
import MazeInterior from '../interiors/MazeInterior.js';
import Beam from '../world/Beam.js';

const MazePlanet = {};

const OFFSET_X = -6500, OFFSET_Y = -8500; // from the sun
// The planet is exactly one maze face, square-cornered: rolling from one
// face to the next then looks like the planet itself turning over.
const CORNER_RADIUS = 0;
const COLOR = [0.08, 0.10, 0.30, 1]; // the maze walls' dark blue
const BEAM_COLOR = [0.35, 0.80, 1.00]; // the pinball beam's effect, in blue

MazePlanet.build = function () {
  const [sunX, sunY] = worldGen.sunPos();
  // (The maze's size, before there's a planet to put it on.)
  const half = MazeInterior.SIZE * MazeInterior.TILE / 2;
  const halfW = half, halfH = half;
  const planet = RoundedRectPlanetoid.new(sunX + OFFSET_X, sunY + OFFSET_Y, halfW, halfH, CORNER_RADIUS, COLOR);
  planet.isImmovable = true;
  planet.isPermanent = true;
  planet.isSpawnExclusion = true;
  planet.vel.x = 0; planet.vel.y = 0;
  planet.rotationAngle = 0;
  planet.rotationSpeed = 0;
  // The maze covers nearly all of the face, so the body is baked at 1x.
  planet.bodyCanvasScale = 1;
  planet.interior = MazeInterior.new(planet);
  state.planetoids.push(planet);
  state.mazePlanet = planet;
  return planet;
};

// The entry beam on the planet's top. One-way, like the pinball planet's:
// its destination is a plain object, and onArrive hands him to the maze.
// He gets back out by the maze's exit.
MazePlanet.addEntryBeam = function (planet) {
  const beamX = planet.pos.x - planet.halfWidth * 0.4;
  const beamY = planet.pos.y - planet.halfHeight;
  const beam = Beam.new(beamX, beamY, -Math.PI / 2, BEAM_COLOR);
  beam.destination = {
    pos: planet.interior.getPortalPosition(),
    angle: -Math.PI / 2,
    onArrive: (player) => planet.interior.onEnter(player),
  };
  // Only there while he's outside: it fades away once he's in the maze,
  // and back once he's out (see Beam.isShown).
  beam.showWhen = () => !(state.player && state.player.inInterior === planet.interior);
  state.beams.push(beam);
  // The exit puts him back on top, a little to the beam's right (clear of
  // it, so he isn't beamed straight back in).
  planet.interior.exitPosition = { x: beamX + planet.halfWidth * 0.3 };
};

export default MazePlanet;
