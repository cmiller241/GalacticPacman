// js/levels/PinballPlanet.js
//
// The "pinball" planet: a tall rounded rectangle with a playable pinball
// table on its face (see js/interiors/PinballInterior.js), the dome's
// mirror image across the sun, and the one-way beam on its top that drops
// him onto the plunger. Port of lua/levels/PinballPlanet.lua.

import state from '../state.js';
import worldGen from '../setup/WorldGen.js';
import RoundedRectPlanetoid from '../world/RoundedRectPlanetoid.js';
import PinballInterior from '../interiors/PinballInterior.js';
import Beam from '../world/Beam.js';
import pinballMap from './Pinball-Level2.js';

const PinballPlanet = {};

// The table is drawn centered on the planet at 64 world units per tile;
// the planet is a margin bigger than it on every side.
const PINBALL_PLANET_MARGIN = 128;
const PINBALL_EXTRA_GAP = 100; // nudged a little further out than the dome's mirror point
// Experimental turning speed (radians per frame) — off for now; see
// docs/Pinball-Rotation-Ideas.md.
const TEMP_PINBALL_ROTATION_SPEED = 0;

PinballPlanet.build = function (dome) {
  const halfW = pinballMap.width * 64 / 2 + PINBALL_PLANET_MARGIN;
  const halfH = pinballMap.height * 64 / 2 + PINBALL_PLANET_MARGIN;
  const [sunX, sunY] = worldGen.sunPos();
  const domeEdgeFromSun = (dome.pos.x - dome.halfWidth) - sunX;
  const planet = RoundedRectPlanetoid.new(
    sunX - domeEdgeFromSun - PINBALL_EXTRA_GAP - halfW, sunY, halfW, halfH, 64, [0.55, 0.57, 0.62, 1]);
  planet.isImmovable = true;
  planet.isPermanent = true;
  planet.isSpawnExclusion = true;
  planet.vel.x = 0; planet.vel.y = 0;
  planet.rotationAngle = 0;
  planet.rotationSpeed = TEMP_PINBALL_ROTATION_SPEED;
  // (Baked at 0.5x: a 2x body canvas would exceed GPU texture limits.)
  planet.bodyCanvasScale = 0.5;
  planet.interior = PinballInterior.new(planet, pinballMap);
  state.planetoids.push(planet);
  state.pinballPlanet = planet;
  return planet;
};

// The entry beam, on the planet's top. One-way: its destination is a
// plain object, and onArrive curls him into a ball on the plunger. He
// gets back out by draining off the bottom of the table. Needs
// state.beams to exist already (RobotButler reads state.beams[0] as the
// home beam, so the home<->belt pair comes first).
PinballPlanet.addEntryBeam = function (pinball) {
  const PINBALL_BEAM_OFFSET_X = -pinball.halfWidth * 0.4;
  const pinballBeamX = pinball.pos.x + PINBALL_BEAM_OFFSET_X;
  const pinballBeamY = pinball.pos.y - pinball.halfHeight;
  const pinballBeam = Beam.new(pinballBeamX, pinballBeamY, -Math.PI / 2, [0.95, 0.45, 0.15]);
  pinballBeam.destination = {
    pos: pinball.interior.getPortalPosition(),
    angle: -Math.PI / 2,
    onArrive: (player) => pinball.interior.onEnter(player),
  };
  state.beams.push(pinballBeam);
  // Draining puts him back on the planet's top, beside this beam.
  pinball.interior.exitPosition = { x: pinballBeamX + pinball.halfWidth * 0.15 };
};

export default PinballPlanet;
