// js/systems/CollisionSystem.js
//
// Port of lua/systems/CollisionSystem.lua. (See it for the long-form
// notes on each pass.)
//
// Port notes: Lua's object-keyed "sets" are JS Sets (hitFireballs,
// killed...) and Maps (handlePlanetAsteroidCollisions: asteroid ->
// planetoid). Multi-returns come back as arrays.

import state from '../state.js';
import constants from '../constants.js';
import Vector2 from '../vector2.js';

// Smallest t in [0,1] along a->b where a circle of radius r at (cx,cy)
// is first entered, or null.
function sweptCircleEntryT(ax, ay, bx, by, cx, cy, r) {
  const dx = bx - ax, dy = by - ay;
  const fx = ax - cx, fy = ay - cy;
  const a = dx * dx + dy * dy;
  if (a < 1e-9) return (fx * fx + fy * fy <= r * r) ? 0 : null;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) {
    if (fx * fx + fy * fy <= r * r) return 0;
    const gx = bx - cx, gy = by - cy;
    if (gx * gx + gy * gy <= r * r) return 1;
    return null;
  }
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a);
  if (t1 > 1 || t2 < 0) return null;
  const tEnter = Math.max(0, t1);
  // Already resting on the boundary and moving outward: not a collision.
  if (tEnter <= 0 && c <= 1e-6 && b >= 0) return null;
  return tEnter;
}

const FIREBALL_MIRROR_BOUNCE_EXTRA_LIFE = 60;
const LEVER_HIT_RADIUS = 48;

class CollisionSystem {
  static new() {
    return new CollisionSystem();
  }

  distanceToPlanetSurface(pos, planet) {
    if (planet.isRoundedRect) return planet.distanceToSurface(pos.x, pos.y);
    return pos.subtract(planet.pos).length() - planet.radius;
  }

  handleImmovableCollisions(immovables, movables) {
    for (const im of immovables) {
      for (const mv of movables) {
        if (mv.isImmovable || mv.recalling) continue;
        let normal = null, targetPos = null;
        let domeContact = null;

        if (im.isRoundedRect) {
          const topY = im.pos.y - im.halfHeight;
          const usingDome = typeof im.nearestDomeSurfacePoint === 'function' && mv.pos.y < topY;
          const usingBase = !usingDome && typeof im.nearestBaseSurfacePoint === 'function' && mv.pos.y > topY;
          let surface;
          if (usingDome) surface = im.nearestDomeSurfacePoint(mv.pos.x, mv.pos.y);
          else if (usingBase) surface = im.nearestBaseSurfacePoint(mv.pos.x, mv.pos.y);
          else surface = im.nearestSurfacePoint(mv.pos.x, mv.pos.y);

          if (surface.distance < mv.radius) {
            normal = surface.normal;
            targetPos = surface.point.clone().add(normal.clone().multiply(mv.radius));
            if (usingDome) domeContact = surface.point;
          }
        } else {
          const offset = mv.pos.subtract(im.pos);
          const dist = offset.length();
          const minDist = im.radius + mv.radius;
          if (dist < minDist && dist > 0) {
            normal = offset.normalize();
            targetPos = im.pos.clone().add(normal.multiply(minDist));
          }
        }

        if (normal && targetPos) {
          mv.pos = targetPos;
          const dot = mv.vel.dot(normal);
          mv.vel = mv.vel.subtract(normal.multiply(2 * dot));

          if (domeContact && typeof im.triggerShieldImpact === 'function') {
            const intensity = Math.min(1, mv.radius / 60);
            im.triggerShieldImpact(domeContact.x, domeContact.y, intensity);
          }
        }
      }
    }
  }

  handlePlayerFireBarCollisions(player, fireBars) {
    for (const bar of fireBars) {
      const blockDist = player.pos.subtract(bar.pos).length();
      if (blockDist <= bar.blockRadius + player.radius + constants.SURFACE_TOLERANCE) {
        player.startDeath();
        return;
      }
      for (const f of bar.getFireballPositions()) {
        const dx = player.pos.x - f.x, dy = player.pos.y - f.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= f.radius + player.radius + constants.SURFACE_TOLERANCE) {
          player.startDeath();
          return;
        }
      }
    }
  }

  // Solid axis-aligned walls — the player as a vertical capsule.
  handlePlayerWallCollisions(player, walls) {
    if (!walls) return;

    const onWallClimb = player.onSurface && player.currentPlanet && player.currentPlanet.isWallClimb;
    const headReach = (!player.isBall && !onWallClimb) ? (player.headReach ?? 0) : 0;
    const segBottomY = player.pos.y;
    const segTopY = player.pos.y - Math.max(0, headReach - player.radius);

    for (const wall of walls) {
      const boxMinX = wall.pos.x - wall.halfWidth, boxMaxX = wall.pos.x + wall.halfWidth;
      const boxMinY = wall.pos.y - wall.halfHeight, boxMaxY = wall.pos.y + wall.halfHeight;

      const segY = Math.max(segTopY, Math.min(wall.pos.y, segBottomY));
      const closestX = Math.max(boxMinX, Math.min(player.pos.x, boxMaxX));
      const closestY = Math.max(boxMinY, Math.min(segY, boxMaxY));
      const dx = player.pos.x - closestX, dy = segY - closestY;
      const distSq = dx * dx + dy * dy;

      if (distSq < player.radius * player.radius) {
        const dist = Math.sqrt(distSq);
        let normal, penetration;

        if (dist > 1e-6) {
          normal = Vector2.new(dx / dist, dy / dist);
          penetration = player.radius - dist;
        } else {
          const overlapX = (wall.halfWidth + player.radius) - Math.abs(player.pos.x - wall.pos.x);
          const overlapY = Math.min(segBottomY + player.radius, boxMaxY) - Math.max(segTopY - player.radius, boxMinY);
          if (overlapX < overlapY) {
            normal = Vector2.new(player.pos.x >= wall.pos.x ? 1 : -1, 0);
            penetration = overlapX;
          } else {
            normal = Vector2.new(0, player.pos.y >= wall.pos.y ? 1 : -1);
            penetration = overlapY;
          }
        }

        player.pos.add(normal.multiply(penetration));
        const intoWall = player.vel.dot(normal);
        if (intoWall < 0) player.vel = player.vel.subtract(normal.multiply(intoWall));

        if (Math.abs(normal.x) > Math.abs(normal.y)) {
          player.touchingWall = wall;
          player.wallContactNormal = normal.clone();
        }

        if (player.onSurface && player.currentPlanet
            && typeof player.currentPlanet.arcPositionForWorldPoint === 'function') {
          player.surfaceArcPos = player.currentPlanet.arcPositionForWorldPoint(player.pos.x, player.pos.y);
        }
      }
    }
  }

  handleElasticCollisions(entities1, entities2, radiusProp1, radiusProp2, massProp1, massProp2) {
    entities2 = entities2 ?? entities1;
    radiusProp1 = radiusProp1 ?? 'radius';
    radiusProp2 = radiusProp2 ?? 'radius';
    massProp1 = massProp1 ?? 'mass';
    massProp2 = massProp2 ?? 'mass';
    const sameArray = entities1 === entities2;

    let maxRadius = 0;
    for (const e of entities1) {
      const r = e[radiusProp1];
      if (r && r > maxRadius) maxRadius = r;
    }
    if (!sameArray) {
      for (const e of entities2) {
        const r = e[radiusProp2];
        if (r && r > maxRadius) maxRadius = r;
      }
    }
    const gridSize = Math.max(maxRadius * 2, 50);

    const grid = new Map();
    entities2.forEach((e, j) => {
      const key = Math.floor(e.pos.x / gridSize) + ',' + Math.floor(e.pos.y / gridSize);
      let bucket = grid.get(key);
      if (!bucket) { bucket = []; grid.set(key, bucket); }
      bucket.push(j);
    });

    for (let i = 0; i < entities1.length; i++) {
      const p1 = entities1[i];
      const col = Math.floor(p1.pos.x / gridSize);
      const row = Math.floor(p1.pos.y / gridSize);

      for (let dRow = -1; dRow <= 1; dRow++) {
        for (let dCol = -1; dCol <= 1; dCol++) {
          const bucket = grid.get((col + dCol) + ',' + (row + dRow));
          if (!bucket) continue;
          for (const j of bucket) {
            if (sameArray && j <= i) continue;
            const p2 = entities2[j];
            if (p1.isImmovable || p2.isImmovable || p1.recalling || p2.recalling) continue;
            const offset = p1.pos.subtract(p2.pos);
            const distSq = offset.lengthSq();
            const sumR = p1[radiusProp1] + p2[radiusProp2];
            if (distSq < sumR * sumR && distSq > 0) {
              const dist = Math.sqrt(distSq);
              const overlap = sumR - dist;
              const normal = offset.normalize();
              const tangent = Vector2.new(-normal.y, normal.x);
              const m1 = p1[massProp1], m2 = p2[massProp2];
              const totalMass = m1 + m2;
              const sep1 = overlap * (m2 / totalMass);
              const sep2 = overlap * (m1 / totalMass);
              p1.pos.add(normal.multiply(sep1));
              p2.pos.add(normal.multiply(-sep2));
              const v1 = p1.vel.clone(), v2 = p2.vel.clone();
              const v1n = normal.dot(v1), v2n = normal.dot(v2);
              const v1t = tangent.dot(v1), v2t = tangent.dot(v2);
              const newV1n = (v1n * (m1 - m2) + 2 * m2 * v2n) / totalMass;
              const newV2n = (v2n * (m2 - m1) + 2 * m1 * v1n) / totalMass;
              p1.vel = normal.multiply(newV1n).add(tangent.multiply(v1t));
              p2.vel = normal.multiply(newV2n).add(tangent.multiply(v2t));
            }
          }
        }
      }
    }
  }

  handlePlayerPlanetCollisions(player) {
    if (player.onSurface) return;

    if (player.pullTarget) {
      if (this.tryLandOnPlanet(player, player.pullTarget)) player.pullTarget = null;
      return;
    }

    for (const planet of state.planetoids) {
      if (this.tryLandOnPlanet(player, planet)) return;
    }

    player.onSurface = false;
    player.currentPlanet = null;
  }

  // Spikeys: solid, lethal obstacles — swept so fast movement can't skip them.
  handlePlayerSpikeyCollisions(player, spikeys) {
    if (!spikeys) return;
    const prevPos = player.prevPos ?? player.pos;
    for (const spikey of spikeys) {
      const r = spikey.radius + player.radius + constants.SURFACE_TOLERANCE;
      const t = sweptCircleEntryT(prevPos.x, prevPos.y, player.pos.x, player.pos.y, spikey.pos.x, spikey.pos.y, r);
      if (t != null) {
        player.pos.x = prevPos.x + (player.pos.x - prevPos.x) * t;
        player.pos.y = prevPos.y + (player.pos.y - prevPos.y) * t;

        const nx = player.pos.x - spikey.pos.x, ny = player.pos.y - spikey.pos.y;
        const ndist = Math.sqrt(nx * nx + ny * ny);
        const normal = ndist > 1e-6 ? Vector2.new(nx / ndist, ny / ndist) : Vector2.new(0, -1);

        const into = player.vel.dot(normal);
        if (into < 0) player.vel = player.vel.subtract(normal.multiply(into));

        player.touchingWall = spikey;
        player.wallContactNormal = normal;
        player.startDeath();
      }
    }
  }

  // Keeps the player sealed inside the SkyDomePlanetoid.
  handlePlayerSkyDomeContainment(player, dome) {
    if (!dome) return;
    if (player.isTeleporting) return;

    const deckY = dome.trueSurfaceY();
    const domeTopY = dome.domeAnchorY() - dome.domeRadiusY;
    const MARGIN = 200;

    if (player.pos.y < domeTopY - MARGIN || player.pos.y > deckY + MARGIN) return;
    if (Math.abs(player.pos.x - dome.pos.x) > dome.halfWidth + MARGIN) return;

    const r = player.radius;

    const minX = dome.pos.x - dome.halfWidth + r;
    const maxX = dome.pos.x + dome.halfWidth - r;
    if (player.pos.x < minX) {
      player.pos.x = minX;
      if (player.vel.x < 0) player.vel.x = 0;
    } else if (player.pos.x > maxX) {
      player.pos.x = maxX;
      if (player.vel.x > 0) player.vel.x = 0;
    }

    const restY = deckY - r;
    if (player.pos.y > restY) {
      player.pos.y = restY;
      if (player.vel.y > 0) player.vel.y = 0;
    }

    const cx = dome.pos.x, cy = dome.domeAnchorY();
    const rx = dome.domeRadiusX, ry = dome.domeRadiusY;
    if (player.pos.y < cy) {
      const nx = (player.pos.x - cx) / rx;
      const ny = (player.pos.y - cy) / ry;
      const nDist = Math.sqrt(nx * nx + ny * ny);
      if (nDist > 0.0001) {
        const boundaryDist = 1 - r / ((rx + ry) / 2);
        if (nDist > boundaryDist) {
          const scale = boundaryDist / nDist;
          player.pos.x = cx + nx * rx * scale;
          player.pos.y = cy + ny * ry * scale;

          const normal = Vector2.new(nx / rx, ny / ry).normalize();
          const outward = player.vel.dot(normal);
          if (outward > 0) player.vel = player.vel.subtract(normal.multiply(outward));
        }
      }
    }
  }

  tryLandOnPlanet(player, planet) {
    if (planet.isRoundedRect) {
      if (planet.isSkyDome) {
        if (typeof planet.isWithinGravityWindow === 'function'
            && !planet.isWithinGravityWindow(player.pos.x, player.pos.y)) return false;
        if (player.vel.y < 0) return false;
      }

      let surface;
      if (planet.isOpenPath && typeof planet.findLandingCrossing === 'function') {
        const prev = player.prevPos ?? player.pos;
        surface = planet.findLandingCrossing(prev.x, prev.y, player.pos.x, player.pos.y);
        if (!surface) return false;
      } else {
        surface = planet.nearestSurfacePoint(player.pos.x, player.pos.y);
      }

      if (surface.distance <= player.radius + constants.SURFACE_TOLERANCE) {
        if (planet.isSkyDome) {
          const minX = planet.pos.x - planet.halfWidth;
          const maxX = planet.pos.x + planet.halfWidth;
          if (player.pos.x < minX - player.radius || player.pos.x > maxX + player.radius) return false;
        }

        const restOffset = planet.forceUprightJump
          ? Vector2.new(0, -player.radius)
          : surface.normal.clone().multiply(player.radius);
        player.pos = surface.point.clone().add(restOffset);
        player.onSurface = true;
        player.currentPlanet = planet;
        player.lastInfluencePlanet = planet;

        if (typeof planet.arcPositionForWorldPoint === 'function') {
          player.surfaceArcPos = planet.arcPositionForWorldPoint(player.pos.x, player.pos.y, true);
        } else if (planet.isSkyDome) {
          player.surfaceArcPos = player.pos.x - (planet.pos.x - planet.halfWidth);
        }

        const impactVel = player.vel.clone();
        player.vel = Vector2.new(0, 0);

        if (player.isGroundPounding) {
          player.isGroundPounding = false;
          if (!planet.isImmovable) {
            const pushDir = surface.normal.clone().multiply(-1);
            planet.vel.add(pushDir.multiply(impactVel.length() * constants.GROUND_POUND_PUSH_STRENGTH));
          }
        }
        return true;
      }
      return false;
    }

    // Water planets are never solid ground.
    if (planet.isWaterPlanet) return false;

    const offset = player.pos.subtract(planet.pos);
    const dist = offset.length();
    const surfaceDist = planet.radius + player.radius;
    if (dist <= surfaceDist + constants.SURFACE_TOLERANCE) {
      const normal = offset.normalize();
      player.pos = planet.pos.clone().add(normal.multiply(surfaceDist));
      player.onSurface = true;
      player.currentPlanet = planet;
      player.lastInfluencePlanet = planet;
      const impactVel = player.vel.clone();
      player.vel = Vector2.new(0, 0);
      player.angle = Math.atan2(player.pos.y - planet.pos.y, player.pos.x - planet.pos.x);
      if (player.isGroundPounding) {
        player.isGroundPounding = false;
        if (!planet.isImmovable) {
          const pushDir = normal.multiply(-1);
          planet.vel.add(pushDir.multiply(impactVel.length() * constants.GROUND_POUND_PUSH_STRENGTH));
        }
      }
      return true;
    }
    return false;
  }

  handlePlayerAsteroidCollisions(player, asteroids) {
    if (!asteroids) return;
    for (const a of asteroids) {
      const dist = player.pos.subtract(a.pos).length();
      if (dist <= player.radius + a.radius) {
        if (player.startDeath) player.startDeath();
        return;
      }
    }
  }

  handlePlayerEnemyCollisions(player, enemies) {
    for (const e of enemies) {
      const dist = player.pos.subtract(e.pos).length();
      if (dist <= player.radius + constants.ENEMY_RADIUS) {
        player.startDeath();
        return;
      }
    }
  }

  handlePlayerGoombaCollisions(player, goombas) {
    const stomped = [];
    for (const g of goombas) {
      const dist = player.pos.subtract(g.pos).length();
      if (dist <= player.radius + g.radius) {
        const isStomp = (g.pos.y - player.pos.y) > g.radius * 0.3 && player.vel.y >= 0;
        if (isStomp) stomped.push(g);
        else player.startDeath();
      }
    }
    return stomped;
  }

  // Returns the Ooombas that finished going flat THIS frame.
  handlePlayerOoombaCollisions(player, ooombas) {
    const flattened = [];
    if (!ooombas) return flattened;

    for (const o of ooombas) {
      if (!o.isSquashing && !player.isDying && !o.portalTransit) {
        const dx = player.pos.x - o.pos.x, dy = player.pos.y - o.pos.y;
        const r = player.radius + o.hitRadius;
        if (dx * dx + dy * dy <= r * r) {
          if (o.isStompedBy(player)) o.startSquash();
          else player.startDeath();
        }
      }
      if (o.isSquashing && o.updateSquash(player)) flattened.push(o);
    }
    return flattened;
  }

  // -> [Set hitFireballs, Set killedOoombas]
  handleFireballOoombaCollisions(fireballs, ooombas) {
    const hitFireballs = new Set();
    const killed = new Set();
    for (const f of fireballs) {
      for (const o of ooombas) {
        if (killed.has(o)) continue;
        const dist = f.pos.subtract(o.pos).length();
        if (dist < f.radius + o.hitRadius) {
          hitFireballs.add(f);
          killed.add(o);
          break;
        }
      }
    }
    return [hitFireballs, killed];
  }

  // -> [Set hitFireballs, Set killedGoombas]
  handleFireballGoombaCollisions(fireballs, goombas) {
    const hitFireballs = new Set();
    const killed = new Set();
    for (const f of fireballs) {
      for (const g of goombas) {
        if (killed.has(g)) continue;
        const dist = f.pos.subtract(g.pos).length();
        if (dist < f.radius + g.radius) {
          hitFireballs.add(f);
          killed.add(g);
          break;
        }
      }
    }
    return [hitFireballs, killed];
  }

  handlePlayerBlobCollisions(player, blobs) {
    for (const b of blobs) {
      const dist = player.pos.subtract(b.getWorldPos()).length();
      if (dist <= player.platformHalfExtent + b.radius) {
        player.startDeath();
        return;
      }
    }
  }

  handleFireballBlobCollisions(fireballs, blobs) {
    const hitFireballs = new Set();
    const killed = new Set();
    for (const f of fireballs) {
      for (const b of blobs) {
        if (killed.has(b)) continue;
        const dist = f.pos.subtract(b.getWorldPos()).length();
        if (dist < f.radius + b.radius) {
          hitFireballs.add(f);
          killed.add(b);
          break;
        }
      }
    }
    return [hitFireballs, killed];
  }

  handleCoinCollisions(player, coins) {
    for (let i = coins.length - 1; i >= 0; i--) {
      const c = coins[i];
      const dist = player.pos.subtract(c.pos).length();
      if (dist <= player.radius + constants.COIN_RADIUS) {
        if (state.audioManager) state.audioManager.playEatDot();
        coins.splice(i, 1);
        state.score = state.score + 1;
      }
    }
  }

  // -> Map asteroid -> the planetoid it hit.
  handlePlanetAsteroidCollisions(planetoids, asteroids) {
    const toBreak = new Map();
    if (!asteroids) return toBreak;

    for (const p of planetoids) {
      for (const a of asteroids) {
        if (!p.isSkyDome) {
          const dist = this.distanceToPlanetSurface(a.pos, p);
          if (dist < a.radius) toBreak.set(a, p);
        }

        if (typeof p.nearestDomeSurfacePoint === 'function') {
          const topY = p.pos.y - (p.halfHeight ?? 0);
          if (a.pos.y < topY) {
            const domeSurface = p.nearestDomeSurfacePoint(a.pos.x, a.pos.y);
            if (domeSurface.distance < a.radius) {
              toBreak.set(a, p);
              if (typeof p.triggerShieldImpact === 'function') {
                const intensity = Math.min(1, a.radius / 45);
                p.triggerShieldImpact(domeSurface.point.x, domeSurface.point.y, intensity);
              }
            }
          }
        }

        if (typeof p.nearestBaseSurfacePoint === 'function') {
          const topY = p.pos.y - (p.halfHeight ?? 0);
          if (a.pos.y > topY) {
            const baseSurface = p.nearestBaseSurfacePoint(a.pos.x, a.pos.y);
            if (baseSurface.distance < a.radius) toBreak.set(a, p);
          }
        }
      }
    }
    return toBreak;
  }

  // Fireball vs WALL tiles (only those flagged isWall). -> Set
  handleFireballWallCollisions(fireballs, walls) {
    const hitFireballs = new Set();
    if (!walls) return hitFireballs;

    for (const f of fireballs) {
      if (hitFireballs.has(f)) continue;
      for (const wall of walls) {
        if (!wall.isWall) continue;
        const boxMinX = wall.pos.x - wall.halfWidth, boxMaxX = wall.pos.x + wall.halfWidth;
        const boxMinY = wall.pos.y - wall.halfHeight, boxMaxY = wall.pos.y + wall.halfHeight;
        const closestX = Math.max(boxMinX, Math.min(f.pos.x, boxMaxX));
        const closestY = Math.max(boxMinY, Math.min(f.pos.y, boxMaxY));
        const dx = f.pos.x - closestX, dy = f.pos.y - closestY;
        if (dx * dx + dy * dy < f.radius * f.radius) {
          hitFireballs.add(f);
          break;
        }
      }
    }
    return hitFireballs;
  }

  // Fireball vs Lever: engages it. -> Set
  handleFireballLeverCollisions(fireballs, levers) {
    const hitFireballs = new Set();
    if (!levers) return hitFireballs;

    for (const f of fireballs) {
      for (const lever of levers) {
        const dx = f.pos.x - lever.pos.x, dy = f.pos.y - lever.pos.y;
        const minDist = f.radius + LEVER_HIT_RADIUS;
        if (dx * dx + dy * dy < minDist * minDist) {
          lever.engage();
          hitFireballs.add(f);
          break;
        }
      }
    }
    return hitFireballs;
  }

  // Fireball vs Mirror: reflects it. -> Set of reflected fireballs
  handleFireballMirrorCollisions(fireballs, mirrors) {
    const reflected = new Set();
    if (!mirrors) return reflected;

    for (const f of fireballs) {
      for (const m of mirrors) {
        const cosA = Math.cos(m.angle), sinA = Math.sin(m.angle);
        const dx = f.pos.x - m.pos.x, dy = f.pos.y - m.pos.y;
        const localX = dx * cosA + dy * sinA;
        const localY = -dx * sinA + dy * cosA;

        if (Math.abs(localX) < m.halfLength + f.radius && Math.abs(localY) < m.halfThickness + f.radius) {
          const vx = f.vel.x, vy = f.vel.y;
          const localVX = vx * cosA + vy * sinA;
          const localVY = -(-vx * sinA + vy * cosA);

          f.vel.x = localVX * cosA - localVY * sinA;
          f.vel.y = localVX * sinA + localVY * cosA;

          const pushLocalY = (localY >= 0 ? 1 : -1) * (m.halfThickness + f.radius + 1);
          f.pos.x = m.pos.x + localX * cosA - pushLocalY * sinA;
          f.pos.y = m.pos.y + localX * sinA + pushLocalY * cosA;

          f.life += FIREBALL_MIRROR_BOUNCE_EXTRA_LIFE;
          reflected.add(f);
          break;
        }
      }
    }
    return reflected;
  }

  // -> [Set hitFireballs, Set toBreakAsteroids, planetHits[]]
  handleFireballCollisions(fireballs, planetoids, asteroids) {
    const hitFireballs = new Set();
    const toBreakAsteroids = new Set();
    const planetHits = [];

    for (const f of fireballs) {
      let hit = false;

      for (const a of asteroids) {
        const dist = f.pos.subtract(a.pos).length();
        if (dist < f.radius + a.radius) {
          hitFireballs.add(f);
          toBreakAsteroids.add(a);
          hit = true;
          break;
        }
      }

      if (!hit) {
        for (const p of planetoids) {
          let skipRest = false;
          if (p.isSkyDome) {
            const topY = p.pos.y - (p.halfHeight ?? 0);
            if (f.pos.y >= topY) {
              skipRest = true;
            } else if (typeof p.nearestDomeSurfacePoint === 'function') {
              const domeSurface = p.nearestDomeSurfacePoint(f.pos.x, f.pos.y);
              if (domeSurface.distance < f.radius) {
                hitFireballs.add(f);
                planetHits.push({ fireball: f, planet: p });
                if (typeof p.triggerShieldImpact === 'function') {
                  const intensity = Math.min(1, f.radius / 45);
                  p.triggerShieldImpact(domeSurface.point.x, domeSurface.point.y, intensity);
                }
              }
              skipRest = true;
            }
          }
          if (!skipRest) {
            const dist = this.distanceToPlanetSurface(f.pos, p);
            if (dist < f.radius) {
              hitFireballs.add(f);
              planetHits.push({ fireball: f, planet: p });
              break;
            }
          }
        }
      }
    }
    return [hitFireballs, toBreakAsteroids, planetHits];
  }

  handlePlayerMazeGhostCollisions(player, ghosts) {
    if (!ghosts) return;
    for (const g of ghosts) {
      if (player.mazeCol === g.mazeCol && player.mazeRow === g.mazeRow) {
        player.startDeath();
        return;
      }
    }
  }
}

export default CollisionSystem;
