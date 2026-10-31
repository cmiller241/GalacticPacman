// js/world/PlanetSurface.js
//
// The surface interface every body in state.planetoids provides, so code
// dealing with "the planet he's on, or near" can ask it directly instead
// of checking what kind of planet it is:
//
//   planet.upAt(x, y)               unit Vector2 — "up" for something at
//                                   (x, y): which way it stands, and which
//                                   way it jumps off
//   planet.gravityDirAt(x, y)       unit Vector2 — which way gravity pulls
//                                   a free body at (x, y)
//   planet.distanceToSurface(x, y)  how far (x, y) is from the surface
//   planet.gravityDistance(x, y)    the distance GravitySystem ranks
//                                   competing gravity sources by — or null
//                                   when (x, y) is outside this body's
//                                   gravity altogether
//
// Implemented by Planetoid (every round body: belt planetoids, spheres,
// water planets, the mining planet, ...), RoundedRectPlanetoid,
// SkyDomePlanetoid, CrackedPlanetoid and TiledTerrain's TerrainShape. The
// functions below are the implementations several of those classes share
// (call them with the planet as `this`). Port of lua/world/PlanetSurface.lua.

import Vector2 from '../vector2.js';
import constants from '../constants.js';

const PlanetSurface = {
  // Flat-sided bodies (a rounded rectangle, the dome's deck, Tiled
  // terrain) pull toward the nearest point of their surface while you're
  // away from it — and, once you're on it, straight in along its normal
  // (for the dome's deck that's straight down: platform gravity).
  gravityTowardSurface(x, y) {
    const surface = this.nearestSurfacePoint(x, y);
    if (surface.distance > 1e-6) {
      return Vector2.new(surface.point.x - x, surface.point.y - y).normalize();
    }
    return surface.normal.clone().multiply(-1);
  },

  // "Up" is the surface's own normal at the nearest point.
  upFromNormal(x, y) {
    return this.nearestSurfacePoint(x, y).normal.clone();
  },

  // "Up" is straight up the screen, whatever the surface's shape.
  upStraight() {
    return Vector2.new(0, -1);
  },

  // Gravity that reaches INFLUENCE_PADDING out from the surface.
  gravityDistanceFromSurface(x, y) {
    const dist = this.distanceToSurface(x, y);
    return dist < (constants.INFLUENCE_PADDING ?? 200) ? dist : null;
  },

  // Gravity only inside the body's own gravity window (the sky dome's
  // bubble — see SkyDomePlanetoid.isWithinGravityWindow), however high in
  // it you are.
  gravityDistanceInWindow(x, y) {
    const dist = this.distanceToSurface(x, y);
    return this.isWithinGravityWindow(x, y) ? dist : null;
  },
};

export default PlanetSurface;
