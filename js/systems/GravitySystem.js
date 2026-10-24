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
      let dist, withinRange;

      if (planet.isOpenPath) {
        withinRange = false;
      } else if (planet.isRoundedRect) {
        if (planet.distanceToSurface) {
          dist = planet.distanceToSurface(pos.x, pos.y);
        } else if (planet.nearestSurfacePoint) {
          dist = planet.nearestSurfacePoint(pos.x, pos.y).distance;
        } else {
          dist = pos.subtract(planet.pos).length();
        }

        if (planet.isSkyDome) {
          withinRange = !!(planet.isWithinGravityWindow && planet.isWithinGravityWindow(pos.x, pos.y));
        } else {
          withinRange = dist < (constants.INFLUENCE_PADDING ?? 200);
        }
      } else {
        dist = pos.subtract(planet.pos).length();
        withinRange = dist < (planet.influenceRadius ?? (planet.radius + (constants.INFLUENCE_PADDING ?? 200)));
      }

      if (withinRange) {
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

    let dir;
    if (dominant.isRoundedRect && dominant.nearestSurfacePoint) {
      const surface = dominant.nearestSurfacePoint(entity.pos.x, entity.pos.y);
      if (surface.distance > 1e-6) {
        dir = Vector2.new(surface.point.x - entity.pos.x, surface.point.y - entity.pos.y).normalize();
      } else {
        dir = surface.normal.clone().multiply(-1);
      }
    } else {
      dir = dominant.pos.subtract(entity.pos).normalize();
    }

    let grav = dominant.gravityStrength ?? entity.GRAVITY_STRENGTH ?? constants.GRAVITY_STRENGTH ?? 0.35;
    if (entity.isGroundPounding) {
      grav *= (entity.GROUND_POUND_GRAV_MULTIPLIER ?? constants.GROUND_POUND_GRAV_MULTIPLIER ?? 3);
    }

    entity.vel.add(dir.multiply(grav * (state.timeScale ?? 1)));
  }
}

export default GravitySystem;
