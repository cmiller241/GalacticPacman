// js/systems/GravitySystem.js
import { Vector2 } from '../vector2.js';
import { INFLUENCE_PADDING } from '../constants.js';

export class GravitySystem {
  constructor(planetoids) {
    this.planetoids = planetoids;
  }

  applyTo(entity) {
    if (entity.onSurface) return;
    const dominant = this.findDominantPlanet(entity.pos);
    if (dominant) {
      entity.lastInfluencePlanet = dominant;
      let dir;
      if (dominant.isRoundedRect) {
        const surface = dominant.nearestSurfacePoint(entity.pos.x, entity.pos.y);
        dir = surface.distance > 1e-6
          ? new Vector2(surface.point.x - entity.pos.x, surface.point.y - entity.pos.y).normalize()
          : surface.normal.clone().multiply(-1);
      } else {
        dir = dominant.pos.subtract(entity.pos).normalize();
      }
      let grav = entity.GRAVITY_STRENGTH || 0.35;
      if (entity.isGroundPounding) grav *= entity.GROUND_POUND_GRAV_MULTIPLIER || 3;
      entity.vel.add(dir.multiply(grav));
    }
  }

  // For rect planets, "distance" is measured to the nearest SURFACE
  // point (not the center) — otherwise gravity range/direction near a
  // wide, non-circular shape would feel wrong (e.g. pulling toward the
  // center from far off to the side instead of straight down). Compared
  // against a plain circle's center-distance when picking the closest
  // candidate across mixed planet types — not perfectly apples-to-
  // apples, but both represent "how close/urgent this planet's gravity
  // is" in their own natural terms, and it's a reasonable simplification
  // given how large this feature already is.
  findDominantPlanet(pos) {
    let closest = null;
    let minDist = Infinity;
    for (const planet of this.planetoids) {
      let dist, withinRange;
      if (planet.isRoundedRect) {
        dist = planet.distanceToSurface(pos.x, pos.y);
        withinRange = dist < INFLUENCE_PADDING;
      } else {
        dist = pos.subtract(planet.pos).length();
        withinRange = dist < planet.influenceRadius;
      }
      if (withinRange && dist < minDist) {
        minDist = dist;
        closest = planet;
      }
    }
    return closest;
  }
}