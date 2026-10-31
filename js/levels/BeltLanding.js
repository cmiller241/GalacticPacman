// js/levels/BeltLanding.js
//
// The beam pair between the home dome and a small landing planet at the
// belt's outer edge (a point-to-point teleporter — see js/world/Beam.js),
// plus the sign on that landing planet. Port of lua/levels/BeltLanding.lua.

import state from '../state.js';
import constants from '../constants.js';
import Vector2 from '../vector2.js';
import worldGen from '../setup/WorldGen.js';
import Sphere from '../world/Sphere.js';
import Beam from '../world/Beam.js';
import Sign from '../world/Sign.js';

const rad = (d) => d * Math.PI / 180;

const BeltLanding = {};

// Creates state.beams as [homeBeam, beltBeam] — RobotButler reads
// state.beams[0] as the home beam, so keep that one first.
BeltLanding.build = function (dome) {
  const domeX = dome.pos.x, domeY = dome.pos.y;
  const BEAM_GAP_FROM_SHELTER = 150;
  const homeBeam = Beam.new(
    state.spaceShelter.pos.x - state.spaceShelter.drawWidth / 2 - BEAM_GAP_FROM_SHELTER,
    dome.trueSurfaceY(), -Math.PI / 2);

  // The landing planet: along the same line from the sun as the dome,
  // just past the belt's outer edge, then nudged down the screen.
  const [sunX, sunY] = worldGen.sunPos();
  const [, beltOuterRadius] = worldGen.beltRadii();
  let dirX = domeX - sunX, dirY = domeY - sunY;
  const dirLen = Math.sqrt(dirX * dirX + dirY * dirY);
  dirX /= dirLen; dirY /= dirLen;

  const BELT_PLANET_RADIUS = 120;
  const BELT_PLANET_GAP = 260;
  const beltPlanetDist = beltOuterRadius + BELT_PLANET_RADIUS + BELT_PLANET_GAP;
  const beltPlanetX = sunX + dirX * beltPlanetDist;
  const BELT_PLANET_EXTRA_DOWN = 500;
  const beltPlanetY = sunY + dirY * beltPlanetDist + BELT_PLANET_EXTRA_DOWN;

  const beltLandingPlanet = Sphere.new(beltPlanetX, beltPlanetY, BELT_PLANET_RADIUS);
  // A Sphere's default gravity reach (a quarter of an ordinary planetoid's)
  // is smaller than this ball itself, so jumps left its pull at once. Given
  // an ordinary planetoid's reach instead; its edge still stops short of the belt.
  beltLandingPlanet.influenceRadius = BELT_PLANET_RADIUS + constants.INFLUENCE_PADDING;
  state.planetoids.push(beltLandingPlanet);
  state.beltLandingPlanet = beltLandingPlanet;

  const beltBeam = Beam.new(beltPlanetX, beltPlanetY - BELT_PLANET_RADIUS, -Math.PI / 2);

  homeBeam.destination = beltBeam;
  beltBeam.destination = homeBeam;
  state.beams = [homeBeam, beltBeam];
};

// A sign on the landing planet's underside, a little round toward the
// belt. Must run after DomeInterior.build, which creates state.signs.
BeltLanding.addSign = function () {
  const planet = state.beltLandingPlanet;
  if (!planet) return;
  const SIGN_OFFSET_FROM_SOUTH_POLE = rad(35);
  const signAngle = Math.PI / 2 + SIGN_OFFSET_FROM_SOUTH_POLE;
  const up = Vector2.new(Math.cos(signAngle), Math.sin(signAngle));
  state.signs = state.signs ?? [];
  state.signs.push(Sign.new(
    planet.pos.x + up.x * planet.radius, planet.pos.y + up.y * planet.radius,
    'With so many planets clustered together, consider pressing **TRIANGLE** to slow down time. In this state, you can move the right joystick cursor around to select planets you can pull beam toward using the **L2** button. If you want time to go back to normal, press **TRIANGLE** again',
    { texture: state.signPlanetTexture, up }));
};

export default BeltLanding;
