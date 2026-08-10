// js/systems/CollisionSystem.js
import { state } from '../state.js';
import { SURFACE_TOLERANCE, PLAYER_RADIUS, ENEMY_RADIUS, COIN_RADIUS, GROUND_POUND_PUSH_STRENGTH } from '../constants.js';
import { Vector2 } from '../vector2.js';
import { createParticles } from '../utils.js';

export class CollisionSystem {
  // Shared helper: distance from a circle (pos, radius) to a planet's
  // true surface — nearestSurfacePoint for rect planets, plain
  // center-distance-minus-radius for circular ones. Used everywhere a
  // planet might be either shape, so each collision method doesn't need
  // its own copy of this branch.
  distanceToPlanetSurface(pos, planet) {
    if (planet.isRoundedRect) {
      return planet.distanceToSurface(pos.x, pos.y);
    }
    return pos.subtract(planet.pos).length() - planet.radius;
  }

  // General-purpose handler for ANY entity tagged isImmovable (FireBar
  // is the first example, not the only intended one) colliding with
  // ordinary movable entities (planetoids, asteroids, ...). This is
  // NOT a special-cased hack — it's the direct physical limit of a
  // normal elastic collision as one object's mass approaches infinity:
  // solving the standard two-body elastic collision formula with
  // m2 -> infinity reduces to "object 1 reflects off the surface
  // normal (like bouncing off a wall), object 2 is completely
  // unaffected." So rather than reuse handleElasticCollisions' mass-
  // ratio math (which assumes both masses are finite and comparable),
  // this applies that limiting case directly: a plain velocity
  // reflection for the movable object, zero change for the immovable
  // one, and the movable object gets pushed the FULL overlap distance
  // out (not split between both, since only one side is actually free
  // to move).
  handleImmovableCollisions(immovables, movables) {
    for (const im of immovables) {
      for (const mv of movables) {
        // Immovable objects never push each other — also correctly
        // skips a literal self-check on the rare occasions the same
        // array gets passed for both roles (e.g. immovable planetoids
        // checked against all planetoids, which naturally includes
        // themselves).
        if (mv.isImmovable) continue;

        let normal, targetPos;
        let domeContact = null; // set only when the dome shell (not the platform body) is what was actually hit
        if (im.isRoundedRect) {
          // For anything with a dome, an object above the platform's
          // own top line is checked against the DOME shell instead of
          // the platform body — the dome sits above and extends
          // further out than the body alone, so that's the surface
          // it'll actually reach first. Player landing never goes
          // through this path at all (see nearestDomeSurfacePoint's
          // own comment), so this can't affect that.
          //
          // Symmetric case below the line: if this immovable has a
          // metal base ellipse (nearestBaseSurfacePoint), an object
          // BELOW the top line is checked against THAT curved shape
          // instead of the plain rectangle — same reasoning, mirrored.
          const topY = im.pos.y - im.halfHeight;
          const usingDome = typeof im.nearestDomeSurfacePoint === 'function' && mv.pos.y < topY;
          const usingBase = !usingDome && typeof im.nearestBaseSurfacePoint === 'function' && mv.pos.y > topY;
          let surface;
          if (usingDome) surface = im.nearestDomeSurfacePoint(mv.pos.x, mv.pos.y);
          else if (usingBase) surface = im.nearestBaseSurfacePoint(mv.pos.x, mv.pos.y);
          else surface = im.nearestSurfacePoint(mv.pos.x, mv.pos.y);
          // TRUE surface distance/normal here, NOT the bounding-circle
          // shortcut used below for circular immovables — critical for
          // a long, thin shape (SkyDomePlanetoid is the motivating
          // case), where the bounding circle extends far beyond the
          // true surface in the short direction, causing a collision
          // to be detected long before anything visually touches it.
          if (surface.distance >= mv.radius) continue;
          normal = surface.normal;
          targetPos = surface.point.clone().add(normal.clone().multiply(mv.radius));
          if (usingDome) domeContact = surface.point;
        } else {
          const offset = mv.pos.subtract(im.pos);
          const dist = offset.length();
          const minDist = im.radius + mv.radius;
          if (dist >= minDist || dist <= 0) continue;
          normal = offset.normalize();
          targetPos = im.pos.clone().add(normal.multiply(minDist));
        }

        mv.pos = targetPos;
        const dot = mv.vel.dot(normal);
        mv.vel = mv.vel.subtract(normal.multiply(2 * dot));

        // Forcefield reaction — only for an actual dome-shell contact,
        // not the plain platform body (a glass shield reacting makes
        // sense; ordinary ground reacting doesn't).
        if (domeContact && typeof im.triggerShieldImpact === 'function') {
          const intensity = Math.min(1, mv.radius / 60);
          im.triggerShieldImpact(domeContact.x, domeContact.y, intensity);
        }
      }
    }
  }

  // The fire bar's block and its rotating fireballs are both lethal to
  // the player on contact — no bounce/physics interaction for the
  // player, just instant death, same as touching a spikey planetoid.
  handlePlayerFireBarCollisions(player, fireBars) {
    for (const bar of fireBars) {
      const blockDist = player.pos.subtract(bar.pos).length();
      if (blockDist <= bar.blockRadius + PLAYER_RADIUS + SURFACE_TOLERANCE) {
        player.startDeath();
        return;
      }
      for (const f of bar.getFireballPositions()) {
        const dx = player.pos.x - f.x, dy = player.pos.y - f.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= f.radius + PLAYER_RADIUS + SURFACE_TOLERANCE) {
          player.startDeath();
          return;
        }
      }
    }
  }

  handleElasticCollisions(entities1, entities2 = entities1, radiusProp1 = 'radius', radiusProp2 = 'radius', massProp1 = 'mass', massProp2 = 'mass') {
    for (let i = 0; i < entities1.length; i++) {
      for (let j = (entities1 === entities2 ? i + 1 : 0); j < entities2.length; j++) {
        const p1 = entities1[i];
        const p2 = entities2[j];
        // Immovable objects are handled exclusively by
        // handleImmovableCollisions, which uses true surface distance
        // for rect-type shapes instead of this method's bounding-
        // circle-based check — critical for anything long/thin, where
        // that circle badly overshoots the true surface.
        if (p1.isImmovable || p2.isImmovable) continue;
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

    // While actively pulling toward a planet (right-click grapple
    // held), pass straight through every regular (non-spikey)
    // planetoid EXCEPT the one being pulled toward — touching that one
    // lands the player normally and ends the pull, same as flying into
    // any planet normally would. Everything else stays passable so the
    // pull remains useful for fast traversal through dense fields (the
    // belt especially) rather than getting stopped by incidental
    // planets along the way. The spikey check above is NOT gated on
    // this — it stays fully lethal regardless of pulling, including
    // for a spikey pull target (by the time execution reaches here,
    // being close enough to a spikey pullTarget to land on it would
    // already have killed the player above, so the isSpikey guard
    // below is just belt-and-suspenders clarity, not load-bearing).
    if (player.pullTarget) {
      if (!player.pullTarget.isSpikey && this.tryLandOnPlanet(player, player.pullTarget)) {
        player.pullTarget = null; // touching the target ends the pull
      }
      return;
    }

    for (const planet of state.planetoids.filter(p => !p.isSpikey)) {
      if (this.tryLandOnPlanet(player, planet)) return;
    }

    player.onSurface = false;
    player.currentPlanet = null;
  }

  // Attempts to land the player on a single planet (rounded-rect or
  // circular). Returns true if landing occurred. Factored out of
  // handlePlayerPlanetCollisions so the same logic can be applied
  // either across the full planet list (normal flight) or to just one
  // specific planet (the pull target, while otherwise passing through
  // everything else — see above).
  tryLandOnPlanet(player, planet) {
    if (planet.isRoundedRect) {
      // SkyDomePlanetoid is only landable from within its top-only
      // gravity window — without this, momentum, a pull-star yank, or
      // a ground-pound knockback could still land the player on the
      // side or underside via the generic nearest-surface-point check
      // below, even though gravity would never have pulled them there
      // (exactly the "stuck to the underside" weirdness the top-only
      // window was built to avoid in the first place).
      if (planet.isSkyDome && !planet.isWithinGravityWindow(player.pos.x, player.pos.y)) {
        return false;
      }
      // isSkyDome planets are deliberately pass-through from below —
      // jumping up INTO one from underneath, with enough speed to
      // still be closing in on the top surface while still ascending,
      // would otherwise trigger the same instant landing snap normal
      // falling uses (which is invisible there, since downward
      // velocity already carries the player toward where the snap
      // places them anyway). Mid-ascent, that snap instead freezes
      // upward momentum and teleports the player the rest of the way
      // in one frame — the "blip" this guard exists to prevent. Once
      // vel.y >= 0 (falling, or right at the peak), landing proceeds
      // normally and reads exactly like landing on anything else.
      if (planet.isSkyDome && player.vel.y < 0) {
        return false;
      }
      const surface = planet.nearestSurfacePoint(player.pos.x, player.pos.y);
      if (surface.distance <= PLAYER_RADIUS + SURFACE_TOLERANCE) {
        player.pos = surface.point.clone().add(surface.normal.clone().multiply(PLAYER_RADIUS));
        player.onSurface = true;
        player.currentPlanet = planet;
        player.lastInfluencePlanet = planet;
        player.surfaceArcPos = planet.arcPositionForWorldPoint(player.pos.x, player.pos.y);
        const impactVel = player.vel.clone();
        player.vel = new Vector2(0, 0);
        if (player.isGroundPounding) {
          player.isGroundPounding = false;
          const pushDir = surface.normal.clone().multiply(-1);
          planet.vel.add(pushDir.multiply(impactVel.length() * GROUND_POUND_PUSH_STRENGTH));
          createParticles(player.pos, 20);
        }
        return true;
      }
      return false;
    }

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
      return true;
    }
    return false;
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

  // Distinguishes a stomp (jump on its head — kills it) from a
  // damaging side/underneath touch (kills the player), the classic
  // Mario-style rule: the player's center needs to be meaningfully
  // above the goomba's own center, AND moving downward (or at least
  // not actively still rising from a jump) — landing squarely on top,
  // not just brushing past. Returns the list of goombas that got
  // stomped (game.js removes them and gives the player a bounce); any
  // non-stomp touch calls player.startDeath() directly here, same as
  // handlePlayerEnemyCollisions above (which already safely no-ops
  // during invincibility, so no extra guard needed here either).
  handlePlayerGoombaCollisions(player, goombas) {
    const stomped = [];
    for (const g of goombas) {
      const dist = player.pos.subtract(g.pos).length();
      if (dist > PLAYER_RADIUS + g.radius) continue;

      const isStomp = (g.pos.y - player.pos.y) > g.radius * 0.3 && player.vel.y >= 0;
      if (isStomp) {
        stomped.push(g);
      } else {
        player.startDeath();
      }
    }
    return stomped;
  }

  // Same shape as handleFireballCollisions below, for goombas
  // specifically — a separate method rather than folding into that
  // one, since goombas aren't planetoids/asteroids and have their own
  // simple circle-only collision (no surface-distance concept to
  // reuse from distanceToPlanetSurface).
  handleFireballGoombaCollisions(fireballs, goombas) {
    const hitFireballs = new Set();
    const killedGoombas = new Set();

    for (const f of fireballs) {
      for (const g of goombas) {
        if (killedGoombas.has(g)) continue; // already killed by an earlier fireball this same frame
        const dist = f.pos.subtract(g.pos).length();
        if (dist < f.radius + g.radius) {
          hitFireballs.add(f);
          killedGoombas.add(g);
          break;
        }
      }
    }

    return { hitFireballs, killedGoombas };
  }

  handleCoinCollisions(player, coins) {
    for (let i = coins.length - 1; i >= 0; i--) {
      const c = coins[i];
      const dist = player.pos.subtract(c.pos).length();
      if (dist <= PLAYER_RADIUS + COIN_RADIUS) {
        state.audioManager.playEatDot();
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
        const dist = this.distanceToPlanetSurface(a.pos, p);
        if (dist < a.radius) {
          toBreak.add(a);
          continue;
        }
        // Dome shell — a completely separate surface from the
        // platform body, only relevant for planets that actually have
        // one, and only for asteroids approaching from above the
        // platform's own top line (see nearestDomeSurfacePoint's own
        // comment for why this stays out of distanceToPlanetSurface).
        if (typeof p.nearestDomeSurfacePoint === 'function') {
          const topY = p.pos.y - p.halfHeight;
          if (a.pos.y < topY) {
            const domeSurface = p.nearestDomeSurfacePoint(a.pos.x, a.pos.y);
            if (domeSurface.distance < a.radius) {
              toBreak.add(a);
              if (typeof p.triggerShieldImpact === 'function') {
                const intensity = Math.min(1, a.radius / 45);
                p.triggerShieldImpact(domeSurface.point.x, domeSurface.point.y, intensity);
              }
              continue;
            }
          }
        }
        // Metal base ellipse — symmetric case below the platform's own
        // top line. No shield-impact trigger here: that effect is
        // specifically a glass/energy-shield reaction, and doesn't fit
        // a solid metal surface the same way.
        if (typeof p.nearestBaseSurfacePoint === 'function') {
          const topY = p.pos.y - p.halfHeight;
          if (a.pos.y > topY) {
            const baseSurface = p.nearestBaseSurfacePoint(a.pos.x, a.pos.y);
            if (baseSurface.distance < a.radius) {
              toBreak.add(a);
            }
          }
        }
      }
    }
    return toBreak;
  }

  // Checks every fireball against every asteroid, then every planetoid.
  // Each fireball can only register a single hit per frame (whichever
  // it's found to overlap first) — once it's hit something, it's spent
  // and doesn't get checked against further targets.
  //
  // Returns:
  //   hitFireballs     — Set of fireballs that hit something this frame
  //                       (caller should remove these from state.fireballs)
  //   toBreakAsteroids — Set of asteroids to break (pass to the
  //                       existing breakAsteroid() in game.js, same as
  //                       planet-asteroid collisions already do)
  //   planetHits       — array of { fireball, planet } pairs, for the
  //                       caller to apply a push impulse + spawn an
  //                       explosion at each impact
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
      if (hit) continue;

      for (const p of planetoids) {
        if (p.isSkyDome) {
          // Semi-solid from below/the side, like a classic Mario-style
          // platform — fireballs only ever collide with the TOP
          // surface, same top-only concept already used for player
          // gravity/landing and the dome/base's own curved collision.
          // Without this, a "grounded" platform's own collision
          // rectangle (which now extends all the way down to the
          // ground via its pillar) would register an immediate hit
          // for a fireball fired anywhere near or underneath it —
          // reading as "shooting immediately explodes" even though
          // nothing was genuinely hit from above.
          const topY = p.pos.y - p.halfHeight;
          if (f.pos.y >= topY) continue;

          // Above the line — check the DOME's curved shell (if this
          // planet has one) instead of the generic flat rect surface.
          // Same reasoning as handleImmovableCollisions: the dome
          // sits above and extends further out than the rect body
          // alone, so that's the surface a fireball fired upward from
          // inside will actually reach — without this, fireballs pass
          // straight through the dome, since the generic rect check
          // only ever measures distance to the flat line the player
          // walks on, which a fireball moving away from is unlikely to
          // ever get close to again.
          if (typeof p.nearestDomeSurfacePoint === 'function') {
            const domeSurface = p.nearestDomeSurfacePoint(f.pos.x, f.pos.y);
            if (domeSurface.distance < f.radius) {
              hitFireballs.add(f);
              planetHits.push({ fireball: f, planet: p });
              if (typeof p.triggerShieldImpact === 'function') {
                const intensity = Math.min(1, f.radius / 45); // same intensity formula as asteroid impacts — a fireball is roughly that scale
                p.triggerShieldImpact(domeSurface.point.x, domeSurface.point.y, intensity);
              }
            }
            continue;
          }
        }
        const dist = this.distanceToPlanetSurface(f.pos, p);
        if (dist < f.radius) {
          hitFireballs.add(f);
          planetHits.push({ fireball: f, planet: p });
          break;
        }
      }
    }

    return { hitFireballs, toBreakAsteroids, planetHits };
  }

  // Maze ghosts track grid coordinates (mazeCol/mazeRow), same as the
  // player does while in the maze — so this is a tile match, not a
  // distance check. Any death this triggers goes through
  // player.startDeath(), which already handles the invincibility
  // window on its own, so no special-casing is needed here.
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