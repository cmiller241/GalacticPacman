// js/systems/GravitySystem.js
import { Vector2 } from '../vector2.js';

export class GravitySystem {
  constructor(planetoids) {
    this.planetoids = planetoids;
  }

  applyTo(entity) {
    if (entity.onSurface) return;
    const dominant = this.findDominantPlanet(entity.pos);
    if (dominant) {
      entity.lastInfluencePlanet = dominant;
      const dir = dominant.pos.subtract(entity.pos).normalize();
      let grav = entity.GRAVITY_STRENGTH || 0.35; // Use entity-specific if needed
      if (entity.isGroundPounding) grav *= entity.GROUND_POUND_GRAV_MULTIPLIER || 3;
      entity.vel.add(dir.multiply(grav));
    }
  }

  findDominantPlanet(pos) {
    let closest = null;
    let minDist = Infinity;
    for (const planet of this.planetoids) {
      const dist = pos.subtract(planet.pos).length();
      if (dist < planet.influenceRadius && dist < minDist) {
        minDist = dist;
        closest = planet;
      }
    }
    return closest;
  }
}