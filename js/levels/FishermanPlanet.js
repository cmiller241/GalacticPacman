// js/levels/FishermanPlanet.js
//
// The rounded-rectangle landmark the fisherman stands on, placed above
// the second water planet (so WaterPlanets.build must run first) with his
// line dangling into the water. Locked level and fixed in place. Port of
// lua/levels/FishermanPlanet.lua.

import state from '../state.js';
import RoundedRectPlanetoid from '../world/RoundedRectPlanetoid.js';
import Fisherman from '../entities/Fisherman.js';

const FishermanPlanet = {};

FishermanPlanet.build = function () {
  const ROUNDED_RECT_HALF_WIDTH = 150;
  const ROUNDED_RECT_HALF_HEIGHT = 100;
  const ROUNDED_RECT_CORNER_RADIUS = 30;
  // How far his hook dangles below his feet, and how far into the water
  // it should end up.
  const FISHERMAN_HOOK_REACH = 852.75;
  const FISHERMAN_HOOK_WATER_DIP = 80;
  const groundY = state.waterPlanet2.pos.y - state.waterPlanet2.radius
    - FISHERMAN_HOOK_WATER_DIP - FISHERMAN_HOOK_REACH;
  let rectY = groundY + ROUNDED_RECT_HALF_HEIGHT;
  let rectX = state.waterPlanet2.pos.x;
  const ROUNDED_RECT_NUDGE_X = -150;
  const ROUNDED_RECT_NUDGE_Y = 210;
  rectX += ROUNDED_RECT_NUDGE_X;
  rectY += ROUNDED_RECT_NUDGE_Y;
  const roundedRectPlanet = RoundedRectPlanetoid.new(
    rectX, rectY,
    ROUNDED_RECT_HALF_WIDTH, ROUNDED_RECT_HALF_HEIGHT, ROUNDED_RECT_CORNER_RADIUS,
    [0.68, 0.56, 0.42, 1]);
  roundedRectPlanet.isImmovable = true;
  roundedRectPlanet.isPermanent = true;
  roundedRectPlanet.vel.x = 0; roundedRectPlanet.vel.y = 0;
  roundedRectPlanet.rotationAngle = 0;
  roundedRectPlanet.rotationSpeed = 0;
  state.planetoids.push(roundedRectPlanet);
  state.roundedRectPlanet = roundedRectPlanet;
};

// The fisherman NPC, at the rectangle's right edge.
FishermanPlanet.addFisherman = function () {
  const FISHERMAN_GAP_FROM_EDGE = 50;
  const rect = state.roundedRectPlanet;
  const fishermanHomeX = rect.pos.x + rect.halfWidth - FISHERMAN_GAP_FROM_EDGE;
  const fishermanGroundY = rect.pos.y - rect.halfHeight;
  state.fisherman = Fisherman.new(fishermanHomeX, fishermanGroundY);
};

export default FishermanPlanet;
