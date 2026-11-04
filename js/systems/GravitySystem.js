// js/systems/GravitySystem.js
//
// Pure physics math, no rendering. Dominant-planet selection +
// directional gravity. (See the Lua original for the long notes on the
// SkyDome gravity window and the sticky hand-off.)

import state from '../state.js';
import Vector2 from '../vector2.js';
import constants from '../constants.js';

// A NEW candidate must beat the current dominant planet by this much (as
// a fraction of the current one's distance) to take over.
const DOMINANT_SWITCH_MARGIN = 0.85;

class GravitySystem {
  static new(planetoids) {
    return new GravitySystem(planetoids);
  }

  constructor(planetoids) {
    this.planetoids = planetoids;
  }

  findDominantPlanet(pos, currentDominant) {
    let closest = null;
    let minDist = Infinity;
    let currentDist = null;

    for (const planet of this.planetoids) {
      // Each kind of planet decides its own reach (see
      // js/world/PlanetSurface.js): null when pos is out of it.
      const dist = planet.gravityDistance(pos.x, pos.y);

      if (dist != null) {
        if (dist < minDist) {
          minDist = dist;
          closest = planet;
        }
        if (planet === currentDominant) currentDist = dist;
      }
    }

    if (currentDominant && currentDist != null && closest !== currentDominant) {
      if (minDist > currentDist * DOMINANT_SWITCH_MARGIN) return currentDominant;
    }

    return closest;
  }

  applyTo(entity) {
    if (entity.onSurface) return;

    const dominant = this.findDominantPlanet(entity.pos, entity.lastInfluencePlanet);
    if (!dominant) return;

    entity.lastInfluencePlanet = dominant;

    // Toward a round planet's center, toward a flat surface's nearest
    // point, or however a cracked planet's switchable gravity points (see
    // js/world/PlanetSurface.js).
    const dir = dominant.gravityDirAt(entity.pos.x, entity.pos.y);

    let grav = dominant.gravityStrength ?? entity.GRAVITY_STRENGTH ?? constants.GRAVITY_STRENGTH ?? 0.35;
    if (entity.isGroundPounding) {
      grav *= (entity.GROUND_POUND_GRAV_MULTIPLIER ?? constants.GROUND_POUND_GRAV_MULTIPLIER ?? 3);
    }

    entity.vel.addScaled(dir, grav * (state.timeScale ?? 1)); // (no throwaway vector, unlike dir.multiply)
  }
}

export default GravitySystem;
