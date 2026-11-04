// js/systems/Breakage.js
//
// Things breaking apart: an asteroid that hits a planetoid or is shot,
// and a prism cluster shot to pieces — the bang, the debris, and what
// they leave behind (smaller asteroids, rubinium, asteroidium). Used by
// main.js's asteroid collisions and by js/systems/Projectiles.js. Port of
// lua/systems/Breakage.lua.

import state from '../state.js';
import lua from '../love/lua.js';
import Vector2 from '../vector2.js';
import Particle from '../entities/Particle.js';
import Explosion from '../entities/Explosion.js';
import Asteroid from '../entities/Asteroid.js';
import ElementPiece from '../entities/ElementPiece.js';

const rnd = () => lua.random();

const Breakage = {};

// Plain debris burst: `count` small yellow particles in every direction.
Breakage.spawnDebrisParticles = function (pos, count) {
  for (let k = 0; k < count; k++) {
    const angle = rnd() * Math.PI * 2;
    const speed = rnd() * 4 + 2;
    state.particles.push(Particle.new(pos, Vector2.new(Math.cos(angle) * speed, Math.sin(angle) * speed)));
  }
};

// A prism cluster's last shot: every prism of it explodes, and
// RUBINIUM_PER_CLUSTER pieces of rubinium fly out to him.
const RUBINIUM_PER_CLUSTER = 6;
Breakage.breakPrismCluster = function (prism) {
  const cluster = prism.group.prisms;

  const gone = new Set(cluster);
  for (const p of cluster) {
    const [x, y] = p.pointAlong(0.5);
    state.explosions.push(Explosion.new(x, y));
  }
  for (let i = state.prisms.length - 1; i >= 0; i--) {
    if (gone.has(state.prisms[i])) state.prisms.splice(i, 1);
  }

  const [midX, midY] = cluster[0].pointAlong(0.5);
  Breakage.spawnDebrisParticles(Vector2.new(midX, midY), 60);
  if (state.audioManager) state.audioManager.playBang('large', Vector2.new(midX, midY));

  for (let k = 0; k < RUBINIUM_PER_CLUSTER; k++) {
    const from = cluster[Math.floor(Math.random() * cluster.length)];
    const [x, y, dirX, dirY] = from.pointAlong(0.2 + rnd() * 0.7);
    state.elementPieces.push(ElementPiece.new('rubinium', x, y, dirX, dirY));
  }
};

// An asteroid that's hit a planetoid or been shot: gone in a bang and a
// burst of debris, splitting into smaller ones (or, when shot, sometimes
// leaving asteroidium instead). planet: what it hit, or null if shot.
const ASTEROID_SPLIT_MIN_RADIUS = 15;
const ASTEROIDIUM_CHANCE = 0.3;
const ASTEROIDIUM_FULL_RADIUS = 45;

function asteroidiumCountFor(radius) {
  let size = (radius - ASTEROID_SPLIT_MIN_RADIUS) / (ASTEROIDIUM_FULL_RADIUS - ASTEROID_SPLIT_MIN_RADIUS);
  size = Math.max(0, Math.min(1, size));
  return lua.random(1 + Math.floor(size * 2), 2 + Math.floor(size * 4 + 0.5));
}

Breakage.breakAsteroid = function (ast, planet) {
  const idx = state.asteroids.indexOf(ast);
  if (idx >= 0) state.asteroids.splice(idx, 1);

  if (state.audioManager) {
    const size = (ast.radius > 30 && 'large') || (ast.radius > 20 && 'medium') || 'small';
    state.audioManager.playBang(size, ast.pos);
  }
  Breakage.spawnDebrisParticles(ast.pos, 150);
  const tooSmallToSplit = ast.radius < ASTEROID_SPLIT_MIN_RADIUS;
  if (!planet && (tooSmallToSplit || rnd() < ASTEROIDIUM_CHANCE)) {
    const n = asteroidiumCountFor(ast.radius);
    for (let k = 0; k < n; k++) {
      const angle = rnd() * Math.PI * 2;
      const out = rnd() * ast.radius * 0.6;
      state.elementPieces.push(ElementPiece.new('asteroidium',
        ast.pos.x + Math.cos(angle) * out, ast.pos.y + Math.sin(angle) * out, Math.cos(angle), Math.sin(angle)));
    }
    return;
  }
  if (tooSmallToSplit) return;

  let awayAngle = null, baseVel = ast.vel;
  if (planet && planet.radius && !planet.isRoundedRect) {
    awayAngle = Math.atan2(ast.pos.y - planet.pos.y, ast.pos.x - planet.pos.x);
    baseVel = planet.vel ?? ast.vel;
  }

  const pieceCount = ast.radius > 30 ? 3 : 2;
  for (let k = 0; k < pieceCount; k++) {
    const piece = Asteroid.new(ast.pos.x, ast.pos.y, ast.radius / 2);
    const angle = awayAngle != null ? (awayAngle + (rnd() - 0.5) * Math.PI * 0.8) : (rnd() * Math.PI * 2);
    const speed = 2 + rnd() * 3;
    piece.vel = Vector2.new(baseVel.x + Math.cos(angle) * speed, baseVel.y + Math.sin(angle) * speed);
    piece.angle = rnd() * Math.PI * 2;
    piece.angularSpeed = (rnd() * 2 - 1) * 0.1;
    if (ast.titleDrift) {
      piece.titleDrift = {
        x: piece.vel.x - (ast.vel.x - ast.titleDrift.x),
        y: piece.vel.y - (ast.vel.y - ast.titleDrift.y),
      };
    }
    state.asteroids.push(piece);
  }
  Breakage.spawnDebrisParticles(ast.pos, 10);
};

export default Breakage;
