// js/world/WaterPlanet.js
//
// A water planet is an ordinary planetoid with a layer of water round
// it, the same as the water spraying builds on any planetoid — see
// WaterPlanet.new below. (The Lua version still carries the old
// shader-drawn wavy water body this replaced, unused; it isn't ported.)

import state from '../state.js';
import Vector2 from '../vector2.js';
import Planetoid from './Planetoid.js';
import WaterSystem from '../systems/WaterSystem.js';

const WaterPlanet = {};

const COLOR_SHALLOW = [0.30, 0.66, 0.85];

// Hard core: a perfectly ordinary solid Planetoid nested at the water
// body's own center, sized as a fraction of the water body's radius.
// Gives gravity a real, physical place to stop — a falling player used
// to overshoot back and forth across the exact center point every frame.
const CORE_FRACTION = 1 / 8;
const CORE_COLOR = [0.42, 0.30, 0.20]; // brown

// Shared wave clock (kept for anything still reading it; advanced once
// per frame from main.js).
let sharedTime = 0;

WaterPlanet.updateSharedClock = function () {
  const timeScale = state.timeScale ?? 1;
  sharedTime += (1 / 60) * timeScale;
};

WaterPlanet.sharedTime = () => sharedTime;

// x, y: world position of the planet's center. radius: how far out its
// water reaches.
//
// A water planet is an ordinary planetoid (the core — solid, landed and
// walked on like any other) with a layer of water round it out to
// `radius` — the very same kind of water layer spraying water on any
// round planetoid builds (see WaterSystem.addNaturalOcean): swum in,
// drained through a portal, boiled by a fireball, leveled with another
// planetoid's water, drawn by WaterSystem.
//
// Also returned: an invisible marker for the water body (isWaterPlanet,
// never solid, never drawn — see CollisionSystem.tryLandOnPlanet), which
// is what the fish swim in and jump between (Fish.js), Bob swims in
// (Player.js), and whose gravity holds both. WaterSystem keeps its radius
// at the water's actual surface, so a drained water planet shrinks for
// them too.
//
// Returns [planet, core].
WaterPlanet.new = function (x, y, radius) {
  const planet = Planetoid.new(x, y, radius, COLOR_SHALLOW);

  // A fixed landmark, not a drifting field planetoid.
  planet.isImmovable = true;
  planet.isPermanent = true;
  planet.vel = new Vector2(0, 0);

  // The water body is never solid — a player just sinks straight
  // through it, with its radius purely "how far out counts as
  // submerged". Its influenceRadius stays where it was set from the full
  // radius, even as the water drains.
  planet.isWaterPlanet = true;
  planet.draw = function () {}; // (WaterSystem draws the water)

  // The hard core: a completely ordinary Planetoid.
  const core = Planetoid.new(x, y, radius * CORE_FRACTION, CORE_COLOR);
  core.isImmovable = true;
  core.isPermanent = true;
  core.vel = new Vector2(0, 0);

  // Lets code that only holds the water body find its matching core.
  planet.core = core;

  WaterSystem.addNaturalOcean(core, radius, planet);

  return [planet, core];
};

export default WaterPlanet;
