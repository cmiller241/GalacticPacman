// js/systems/CollisionSystem.js
import { state } from '../state.js';
import { SURFACE_TOLERANCE, PLAYER_RADIUS, ENEMY_RADIUS, COIN_RADIUS, GROUND_POUND_PUSH_STRENGTH } from '../constants.js';
import { Vector2 } from '../vector2.js';
import { createParticles, playEatDot } from '../utils.js';

export class CollisionSystem {
  handleElasticCollisions(entities1, entities2 = entities1, radiusProp1 = 'radius', radiusProp2 = 'radius', massProp1 = 'mass', massProp2 = 'mass') {
    for (let i = 0; i < entities1.length; i++) {
      for (let j = (entities1 === entities2 ? i + 1 : 0); j < entities2.length; j++) {
        const p1 = entities1[i];
        const p2 = entities2[j];
        const offset = p1.pos.subtract(p2.pos);
        const distSq = offset.lengthSq();
        const sumR = p1[radiusProp1] + p2[radiusProp2];
        const sumRSq = sumR * sumR;
        if (distSq < sumRSq) {
          const dist = Math.sqrt(distSq);
          const overlap = sumR - dist;
          const normal = offset.normalize();
          const tangent = new Vector2(-normal.y, normal.x);
          const m1 = p1[massProp1], m2 = p2[massProp2], totalMass = m1 + m2;
          const sep1 = overlap * (m2 / totalMass), sep2 = overlap * (m1 / totalMass);
          p1.pos.add(normal.multiply(sep1));
          p2.pos.add(normal.multiply(-sep2));
          const v1 = p1.vel.clone(), v2 = p2.vel.clone();
          const v1n = normal.dot(v1), v2n = normal.dot(v2);
          const v1t = tangent.dot(v1), v2t = tangent.dot(v2);
          const new_v1n = (v1n * (m1 - m2) + 2 * m2 * v2n) / totalMass;
          const new_v2n = (v2n * (m2 - m1) + 2 * m1 * v1n) / totalMass;
          p1.vel = normal.multiply(new_v1n).add(tangent.multiply(v1t));
          p2.vel = normal.multiply(new_v2n).add(tangent.multiply(v2t));
        }
      }
    }
  }

  handlePlayerPlanetCollisions(player) {
    for (const planet of state.planetoids.filter(p => p.isSpikey)) {
      const dist = player.pos.subtract(planet.pos).length();
      if (dist <= planet.radius + PLAYER_RADIUS + SURFACE_TOLERANCE) {
        player.startDeath();
        return;
      }
    }

    if (player.onSurface) return;

    for (const planet of state.planetoids.filter(p => !p.isSpikey)) {
      const offset = player.pos.subtract(planet.pos);
      const dist = offset.length();
      const surfaceDist = planet.radius + PLAYER_RADIUS;
      if (dist <= surfaceDist + SURFACE_TOLERANCE) {
        const normal = offset.normalize();
        player.pos = planet.pos.clone().add(normal.multiply(surfaceDist));
        player.onSurface = true;
        player.currentPlanet = planet;
        player.lastInfluencePlanet = planet;
        const impactVel = player.vel.clone();
        player.vel = new Vector2(0, 0);
        player.angle = Math.atan2(player.pos.y - planet.pos.y, player.pos.x - planet.pos.x);
        if (player.isGroundPounding) {
          player.isGroundPounding = false;
          const pushDir = normal.multiply(-1);
          planet.vel.add(pushDir.multiply(impactVel.length() * GROUND_POUND_PUSH_STRENGTH));
          createParticles(player.pos, 20);
        }
        return;
      }
    }

    player.onSurface = false;
    player.currentPlanet = null;
  }

  handlePlayerAsteroidCollisions(player, asteroids) {
    for (const a of asteroids) {
      const dist = player.pos.subtract(a.pos).length();
      if (dist <= PLAYER_RADIUS + a.radius) {
        player.startDeath();
        return;
      }
    }
  }

  handlePlayerEnemyCollisions(player, enemies) {
    for (const e of enemies) {
      const dist = player.pos.subtract(e.pos).length();
      if (dist <= PLAYER_RADIUS + ENEMY_RADIUS) {
        player.startDeath();
        return;
      }
    }
  }

  handleCoinCollisions(player, coins) {
    for (let i = coins.length - 1; i >= 0; i--) {
      const c = coins[i];
      const dist = player.pos.subtract(c.pos).length();
      if (dist <= PLAYER_RADIUS + COIN_RADIUS) {
        playEatDot();
        coins.splice(i, 1);
        state.score++;
      }
    }
  }

  handlePlanetAsteroidCollisions(planetoids, asteroids) {
    const toBreak = new Set();
    // Original doesn't add to toBreak on every collision, but assume all planet-asteroid collisions break asteroid
    for (let p of planetoids) {
      for (let a of asteroids) {
        const dist = p.pos.subtract(a.pos).length();
        if (dist < p.radius + a.radius) {
          toBreak.add(a);
        }
      }
    }
    return toBreak;
  }
}