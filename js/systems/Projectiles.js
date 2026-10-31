// js/systems/Projectiles.js
//
// The blasters' shots in flight: fireballs (see js/entities/Fireball.js)
// and ice bolts (js/entities/IceBolt.js) — moving them, passing them
// through portals, and everything they can hit. Called once a frame from
// love.update, after the planetoids, the player and the water have moved.
// Port of lua/systems/Projectiles.lua.
//
// Fireballs are checked against each kind of target in turn (water, ice
// cubes, mirrors, prisms, asteroids and planets, ball tunnels, walls,
// levers, Ooombas);
// a fireball that hits something is gone before the next check sees it.
// The order matters: mirrors go first, and a fireball a mirror just
// turned is left alone by the destructive checks this frame.

import state from '../state.js';
import Explosion from '../entities/Explosion.js';
import IceBolt from '../entities/IceBolt.js';
import Prism from '../world/Prism.js';
import PortalGun from './PortalGun.js';
import WaterSystem from './WaterSystem.js';
import Breakage from './Breakage.js';

const Projectiles = {};

// Removes, back to front, every item of `list` that `test` picks (test
// may also act on the ones it picks — they're visited back to front).
function removeWhere(list, test) {
  for (let i = list.length - 1; i >= 0; i--) if (test(list[i])) list.splice(i, 1);
}

// A shot going off at (x, y): its explosion and its bang.
function explodeAt(x, y) {
  state.explosions.push(Explosion.new(x, y));
  if (state.audioManager) state.audioManager.playFireball();
}

// ---------------------------------------------------------------------
// Fireballs
// ---------------------------------------------------------------------

// Into water: it goes out in a burst of steam, boiling some of the water
// off (see WaterSystem.quenchFireball).
function hitWater(fireballs) {
  removeWhere(fireballs, (f) => WaterSystem.quenchFireball(f));
}

// Into a frozen Ooomba's ice cube: the ice melts into a splash of water
// and steam, and the Ooomba walks on, unharmed (see WaterSystem.fireHitsIce).
// (The level's ice blocks are walls: hitWalls melts those.)
function hitIceCubes(fireballs) {
  removeWhere(fireballs, (f) => {
    if (!WaterSystem.fireHitsIce(f)) return false;
    state.explosions.push(Explosion.new(f.pos.x, f.pos.y));
    return true;
  });
}

// Prisms (see js/world/Prism.js): a fireball that reaches one goes off
// against it, and the whole cluster lights up — and, on its last hit,
// shatters into rubinium (see Breakage.breakPrismCluster). Checked before
// the planetoids, since every prism is standing on one.
function hitPrisms(fireballs, reflected) {
  if (!state.prisms) return;
  removeWhere(fireballs, (f) => {
    const prism = !reflected.has(f) && Prism.findAt(state.prisms, f.pos.x, f.pos.y, f.radius);
    if (!prism) return false;
    const shattered = prism.hit();
    explodeAt(f.pos.x, f.pos.y);
    if (shattered) Breakage.breakPrismCluster(prism);
    return true;
  });
}

// Asteroids and planetoids. A shot asteroid breaks apart the same way one
// that hits a planetoid does (see Breakage.breakAsteroid). A planetoid
// hit: an obsidian or ice block's walkable top melts the block (see
// WaterSystem.fireHitsWall); a breakable planet (see CrackedPlanetoid.js)
// loses bricks.
function hitAsteroidsAndPlanets(fireballs, reflected, collisionSystem, planetoids) {
  if (!state.asteroids) return;
  const [hitFireballs, toBreakAsteroids, planetHits] = collisionSystem.handleFireballCollisions(
    fireballs, planetoids, state.asteroids);
  for (const a of toBreakAsteroids) {
    explodeAt(a.pos.x, a.pos.y);
    Breakage.breakAsteroid(a, null);
  }
  for (const hit of planetHits) {
    if (reflected.has(hit.fireball)) continue;
    const f = hit.fireball;
    explodeAt(f.pos.x, f.pos.y);
    if (hit.planet.blockWall) WaterSystem.fireHitsWall(hit.planet.blockWall);
    if (hit.planet.takeHit) hit.planet.takeHit(f.pos.x, f.pos.y, f.vel.x, f.vel.y);
  }
  removeWhere(fireballs, (f) => hitFireballs.has(f) && !reflected.has(f));
}

// Into a ball-tunnel piece (see TiledTerrain.js's Level.tunnelSolidAt).
function hitTunnels(fireballs) {
  if (!state.tiledLevels) return;
  removeWhere(fireballs, (f) => {
    for (const level of state.tiledLevels) {
      if (level.tunnelSolidAt(f.pos.x, f.pos.y)) {
        explodeAt(f.pos.x, f.pos.y);
        return true;
      }
    }
    return false;
  });
}

// WALL tiles (not Gates — see handleFireballWallCollisions): a fireball
// explodes against one like it does against a planet. An obsidian block
// starts melting back into lava; an ice block melts into water.
function hitWalls(fireballs, reflected, collisionSystem) {
  if (!state.tiledLevels || fireballs.length === 0) return;
  const hitWall = new Map();
  for (const level of state.tiledLevels) {
    for (const [f, wall] of collisionSystem.handleFireballWallCollisions(fireballs, level.walls)) {
      hitWall.set(f, wall);
    }
  }
  removeWhere(fireballs, (f) => {
    if (!hitWall.has(f) || reflected.has(f)) return false;
    WaterSystem.fireHitsWall(hitWall.get(f));
    explodeAt(f.pos.x, f.pos.y);
    return true;
  });
}

// Levers: a fireball hitting one engages it (see Lever.engage) and goes
// off, like against a wall.
function hitLevers(fireballs, reflected, collisionSystem) {
  if (!state.levers || fireballs.length === 0) return;
  const hitLever = collisionSystem.handleFireballLeverCollisions(fireballs, state.levers);
  removeWhere(fireballs, (f) => {
    if (!hitLever.has(f) || reflected.has(f)) return false;
    explodeAt(f.pos.x, f.pos.y);
    return true;
  });
}

// Ooombas: a fireball kills one outright — it's gone in an explosion, and
// the fireball is spent.
function hitOoombas(fireballs, collisionSystem) {
  if (!state.ooombas || state.ooombas.length === 0 || fireballs.length === 0) return;
  const [hitFireballs, killed] = collisionSystem.handleFireballOoombaCollisions(fireballs, state.ooombas);
  removeWhere(state.ooombas, (o) => {
    if (!killed.has(o)) return false;
    explodeAt(o.pos.x, o.pos.y);
    return true;
  });
  removeWhere(fireballs, (f) => hitFireballs.has(f));
}

function updateFireballs(collisionSystem, planetoids) {
  const fireballs = state.fireballs;
  if (!fireballs) return;

  removeWhere(fireballs, (f) => { f.update(); return f.isDead(); });
  // Through a portal, before anything below can see one hit the portal's
  // own surface (see PortalGun.passFireballs).
  PortalGun.passFireballs(fireballs, state.timeScale);

  hitWater(fireballs);
  hitIceCubes(fireballs);
  if (fireballs.length === 0) return;

  // Mirrors get first look: a reflected fireball just had its velocity and
  // position turned, not destroyed, and it's only a few pixels off the
  // mirror's face — so it's left out of every destructive check below
  // this frame.
  const reflected = state.mirrors ? collisionSystem.handleFireballMirrorCollisions(fireballs, state.mirrors) : new Set();

  hitPrisms(fireballs, reflected);
  hitAsteroidsAndPlanets(fireballs, reflected, collisionSystem, planetoids);
  hitTunnels(fireballs);
  hitWalls(fireballs, reflected, collisionSystem);
  hitLevers(fireballs, reflected, collisionSystem);
  hitOoombas(fireballs, collisionSystem);
}

// ---------------------------------------------------------------------
// Ice bolts
// ---------------------------------------------------------------------

// Whether ice bolt b has hit something: water it reaches freezes into an
// ice block and lava turns to water (and so to obsidian) — see
// WaterSystem.iceBoltHit; an Ooomba is frozen in an ice cube; anything
// else solid, it shatters on.
function iceBoltHits(b, collisionSystem, planetoids) {
  if (WaterSystem.iceBoltHit(b)) return true;
  for (const o of state.ooombas ?? []) {
    if (o.frozen || o.isSquashing || o.portalTransit) continue;
    const dx = b.pos.x - o.pos.x, dy = b.pos.y - o.pos.y;
    const r = b.radius + o.hitRadius * 1.3;
    if (dx * dx + dy * dy < r * r) {
      WaterSystem.encaseOoomba(o);
      return true;
    }
  }
  let hit = false;
  for (const level of state.tiledLevels ?? []) {
    if (collisionSystem.handleFireballWallCollisions([b], level.walls).size > 0) hit = true;
  }
  if (hit) return true;
  const [hitBolts] = collisionSystem.handleFireballCollisions([b], planetoids, []);
  return hitBolts.has(b);
}

function updateIceBolts(collisionSystem, planetoids) {
  const bolts = state.iceBolts;
  if (!bolts || bolts.length === 0) return;
  removeWhere(bolts, (b) => { b.update(); return b.isDead(); });
  PortalGun.passFireballs(bolts, state.timeScale);
  removeWhere(bolts, (b) => {
    if (!iceBoltHits(b, collisionSystem, planetoids)) return false;
    IceBolt.burst(b.pos.x, b.pos.y, 12);
    return true;
  });
}

// planetoids: the ones worth colliding with this frame (main.js leaves
// off-screen belt planetoids out).
Projectiles.update = function (collisionSystem, planetoids) {
  updateFireballs(collisionSystem, planetoids);
  updateIceBolts(collisionSystem, planetoids);
};

export default Projectiles;
