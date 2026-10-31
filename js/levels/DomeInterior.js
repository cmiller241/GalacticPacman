// js/levels/DomeInterior.js
//
// The sky dome's interior: the Tiled map Level1 loaded as walkable
// terrain on the dome's deck, plus everything placed in its object layer
// (Ooombas, Spheres, Spikeys, Mirrors, Levers, Cranks, Signs,
// Zoom-Windows, DeathZones, Gates, rope rocks). Called once per world
// build from js/levels/World.js. (Port of lua/levels/DomeInterior.lua.)

import state from '../state.js';
import constants from '../constants.js';
import lua from '../love/lua.js';
import TiledTerrain from '../world/TiledTerrain.js';
import WaterSystem from '../systems/WaterSystem.js';
import RopeRock from '../world/RopeRock.js';
import Ooomba from '../entities/Ooomba.js';
import Sphere from '../world/Sphere.js';
import SphereMove from '../world/SphereMove.js';
import Spikey from '../world/Spikey.js';
import SpikeyVertical from '../world/SpikeyVertical.js';
import SpikeyOrbit from '../world/SpikeyOrbit.js';
import Mirror from '../world/Mirror.js';
import Lever from '../world/Lever.js';
import Crank from '../world/Crank.js';
import Plunger from '../world/Plunger.js';
import Sign from '../world/Sign.js';
import Gate from '../world/Gate.js';
import level1Map from './Level1.js';

const rnd = () => lua.random();

// How far below a loosely placed spawn point to look for ground.
const GROUND_SEARCH_DOWN = 6000;

// Objects placed loosely in Tiled (anywhere above the surface they're
// meant to stand on) are snapped straight down onto the nearest terrain
// shape below them, using the same swept findLandingCrossing test
// CollisionSystem uses for landing. Ramp-climb shapes (isWallClimb) are
// skipped. -> { shape, hit } or null
function groundBelow(shapes, x, y, reach) {
  let best = null, bestDy = null;
  for (const shape of shapes) {
    if (shape.isWallClimb) continue;
    const hit = shape.findLandingCrossing(x, y, x, y + reach);
    if (hit) {
      const dy = hit.point.y - y;
      if (dy >= 0 && (bestDy == null || dy < bestDy)) {
        bestDy = dy;
        best = { shape, hit };
      }
    }
  }
  return best;
}

const DomeInterior = {};

// -> the Tiled level
DomeInterior.build = function (dome) {
  const levelData = level1Map;
  const mapWorldWidth = levelData.width * 64;
  const mapWorldHeight = levelData.height * 64;
  const anchorX = dome.pos.x - mapWorldWidth / 2;
  const anchorY = dome.trueSurfaceY() - mapWorldHeight;
  const terrainLevel = TiledTerrain.load(levelData, anchorX, anchorY);

  for (const shape of terrainLevel.shapes) {
    // Tiles jump like the dome's own deck.
    shape.jumpStrength = dome.jumpStrength;
    // Part of the Sky Dome level (the dome's music keeps playing on it — see musicForPlayer).
    shape.inSkyDome = true;
    state.planetoids.push(shape);
  }
  state.tiledLevels = [terrainLevel];
  WaterSystem.init(terrainLevel);

  // Rocks hung on ropes.
  state.ropeRocks = [];
  state.recallables = state.ropeRocks;
  const rocksById = {};
  for (const rock of (terrainLevel.rockSpawns ?? [])) rocksById[rock.id] = rock;
  for (const rope of (terrainLevel.ropeSpawns ?? [])) {
    const rock = rope.holdsId != null ? rocksById[rope.holdsId] : null;
    if (rock) {
      state.ropeRocks.push(RopeRock.new(rope, rock, terrainLevel, dome));
    } else {
      console.log(`DomeInterior: Rope id ${rope.id} holds nothing (its "holds" property names no Rock) — not spawned.`);
    }
  }

  // Ooombas, snapped down onto the terrain under their Tiled points.
  state.ooombas = [];
  for (const spawn of (terrainLevel.ooombaSpawns ?? [])) {
    const g = groundBelow(terrainLevel.shapes, spawn.x, spawn.y, GROUND_SEARCH_DOWN);
    if (g) {
      const arcPos = g.shape.arcPositionForWorldPoint(spawn.x, spawn.y);
      const direction = rnd() < 0.5 ? -1 : 1;
      state.ooombas.push(Ooomba.new(g.shape, arcPos, { direction }));
    }
  }

  // Spheres (and their Ooombas), registered by Tiled id for Spikey-Orbits.
  const entitiesById = {};
  for (const spawn of (terrainLevel.sphereSpawns ?? [])) {
    const sphere = Sphere.new(spawn.x, spawn.y, spawn.radius);
    state.planetoids.push(sphere);
    if (spawn.id != null) entitiesById[spawn.id] = sphere;

    if (spawn.gravityRadius != null) {
      if (spawn.gravityRadius > sphere.radius) {
        sphere.influenceRadius = spawn.gravityRadius;
      } else {
        console.log(`DomeInterior: Sphere at (${Math.round(spawn.x)}, ${Math.round(spawn.y)}) has gravity=${spawn.gravityRadius}, which is not beyond its own radius of ${sphere.radius} — ignored.`);
      }
    }

    if ((spawn.ooombaCount ?? 0) > 0) {
      const direction = rnd() < 0.5 ? -1 : 1;
      const firstAngle = rnd() * Math.PI * 2;
      for (let i = 0; i < spawn.ooombaCount; i++) {
        const angle = firstAngle + i / spawn.ooombaCount * Math.PI * 2;
        state.ooombas.push(Ooomba.newOnPlanet(sphere, angle, { direction }));
      }
    }
  }

  for (const spawn of (terrainLevel.sphereMoveSpawns ?? [])) {
    state.planetoids.push(SphereMove.new(
      spawn.x, spawn.y, spawn.startX, spawn.startY, spawn.endX, spawn.endY, null, spawn.speed));
  }

  // Spikeys: lethal obstacles, in their own list.
  state.spikeys = [];
  for (const spawn of (terrainLevel.spikeySpawns ?? [])) {
    const spikey = Spikey.new(spawn.x, spawn.y);
    state.spikeys.push(spikey);
    if (spawn.id != null) entitiesById[spawn.id] = spikey;
  }

  // Spikey-Vertical: bounded by walls (from TiledTerrain) or Spikeys in
  // the same column.
  const SPIKEY_VERTICAL_RADIUS = Spikey.DEFAULT_RADIUS;
  for (const spawn of (terrainLevel.spikeyVerticalSpawns ?? [])) {
    let topY = spawn.topY, bottomY = spawn.bottomY;
    for (const other of state.spikeys) {
      if (Math.abs(other.pos.x - spawn.x) < other.radius + SPIKEY_VERTICAL_RADIUS) {
        if (other.pos.y < spawn.y) {
          const bound = other.pos.y + other.radius + SPIKEY_VERTICAL_RADIUS;
          topY = topY != null ? Math.max(topY, bound) : bound;
        } else if (other.pos.y > spawn.y) {
          const bound = other.pos.y - other.radius - SPIKEY_VERTICAL_RADIUS;
          bottomY = bottomY != null ? Math.min(bottomY, bound) : bound;
        }
      }
    }
    if (topY != null && bottomY != null && bottomY > topY) {
      state.spikeys.push(SpikeyVertical.new(spawn.x, topY, bottomY, SPIKEY_VERTICAL_RADIUS, spawn.speed));
    } else {
      console.log(`DomeInterior: Spikey-Vertical at (${spawn.x.toFixed(1)}, ${spawn.y.toFixed(1)}) found no wall or nearby Spikey to bound it on one side (topY=${topY}, bottomY=${bottomY}) — not spawned.`);
    }
  }

  // Spikey-Orbit: circles whatever entity its "orbit" property names.
  for (const spawn of (terrainLevel.spikeyOrbitSpawns ?? [])) {
    const center = spawn.orbitId != null ? entitiesById[spawn.orbitId] : null;
    if (center) {
      state.spikeys.push(SpikeyOrbit.new(spawn.x, spawn.y, center, Spikey.DEFAULT_RADIUS, spawn.speed));
    } else {
      console.log(`DomeInterior: Spikey-Orbit at (${spawn.x.toFixed(1)}, ${spawn.y.toFixed(1)}) names orbit id ${spawn.orbitId}, which isn't a spawned Sphere/Spikey — not spawned.`);
    }
  }

  state.mirrors = [];
  for (const spawn of (terrainLevel.mirrorSpawns ?? [])) {
    const mirror = Mirror.new(spawn.x, spawn.y, spawn.angle);
    state.mirrors.push(mirror);
    if (spawn.id != null) entitiesById[spawn.id] = mirror;
  }

  state.levers = [];
  for (const spawn of (terrainLevel.leverSpawns ?? [])) {
    const g = groundBelow(terrainLevel.shapes, spawn.x, spawn.y, GROUND_SEARCH_DOWN);
    if (g) {
      const lever = Lever.new(g.hit.point.x, g.hit.point.y);
      lever.gateId = spawn.gateId;
      state.levers.push(lever);
    }
  }

  state.cranks = [];
  for (const spawn of (terrainLevel.crankSpawns ?? [])) {
    const g = groundBelow(terrainLevel.shapes, spawn.x, spawn.y, GROUND_SEARCH_DOWN);
    if (g) {
      const crank = Crank.new(g.hit.point.x, g.hit.point.y);
      crank.mirrorId = spawn.mirrorId;
      crank.mirror = spawn.mirrorId != null ? (entitiesById[spawn.mirrorId] ?? null) : null;
      state.cranks.push(crank);
    }
  }

  // Plungers (see js/world/Plunger.js): fire Bob along, e.g. into a ball
  // tunnel.
  state.plungers = [];
  for (const spawn of (terrainLevel.plungerSpawns ?? [])) {
    state.plungers.push(Plunger.new(spawn.x, spawn.y, spawn.dir));
  }

  state.signs = [];
  for (const spawn of (terrainLevel.signSpawns ?? [])) {
    const g = groundBelow(terrainLevel.shapes, spawn.x, spawn.y, GROUND_SEARCH_DOWN);
    if (g) state.signs.push(Sign.new(g.hit.point.x, g.hit.point.y, spawn.message));
  }

  state.zoomWindows = terrainLevel.zoomWindows ?? [];

  // Death zones: their respawn point is stood on the ground just below.
  const RESPAWN_SEARCH_UP = 64, RESPAWN_SEARCH_DOWN = 200;
  state.deathZones = terrainLevel.deathZones ?? [];
  for (const zone of state.deathZones) {
    let bestY = null;
    for (const shape of terrainLevel.shapes) {
      if (shape.isWallClimb) continue;
      const hit = shape.findLandingCrossing(
        zone.respawnX, zone.respawnY - RESPAWN_SEARCH_UP, zone.respawnX, zone.respawnY + RESPAWN_SEARCH_DOWN);
      if (hit && (bestY == null || hit.point.y < bestY)) bestY = hit.point.y;
    }
    if (bestY != null) zone.respawnY = bestY - constants.PLAYER_RADIUS - 1;
  }

  // Gates: in both the level's walls (collision) and state.gates.
  state.gates = [];
  const gatesByTiledId = {};
  for (const spawn of (terrainLevel.gateSpawns ?? [])) {
    const gate = Gate.new(spawn.x, spawn.topY, spawn.bottomY, spawn.halfWidth);
    terrainLevel.walls.push(gate);
    state.gates.push(gate);
    if (spawn.id != null) gatesByTiledId[spawn.id] = gate;
  }

  for (const lever of state.levers) {
    if (lever.gateId != null && gatesByTiledId[lever.gateId]) lever.gate = gatesByTiledId[lever.gateId];
  }
  return terrainLevel;
};

export default DomeInterior;
