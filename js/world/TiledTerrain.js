// js/world/TiledTerrain.js
//
// Loads a Tiled map (js/levels/Level1.js — converted from tiled/Level1.lua
// by tools/tiled-lua-to-js.mjs) into real collision geometry (walkable top
// surfaces AND solid walls) plus a single baked-once rendering of the
// whole tile grid. NOTE: the converted map's arrays are 0-based, so
// layer.data[row * width + col] is the tile at (col, row).
//
// Tile roles come from CUSTOM PROPERTIES authored per-tile in Tiled
// (tiled/Grass Tiles.tsx), not from GID/index ranges — adding a new tile
// is just "draw it, tag it," no code changes required.
//
// Expected properties, set per-tile in the tileset (see buildTilePropertyLookup):
//   role  = "top" (walkable — stand on it, land on it, jump through from
//           below), "wall" (solid on every side — see WallShape below),
//           or "fill" (pure decoration, no collision). Untagged tiles
//           default to "fill".
//   slope = "flat", "riseLeft", or "riseRight" — only meaningful when
//           role == "top".
//
// IMPORTANT: this requires the tileset to be EMBEDDED in the map (Tiled:
// right-click the tileset in the Tilesets panel -> "Embed Tileset in
// Map"). An external tileset reference never carries tile properties into
// the map's own export — see buildTilePropertyLookup's assertion.
//
// Each walkable shape built here is an OPEN path (a hill has two ends,
// unlike RoundedRectPlanetoid's closed rectangle loop) — see the
// isOpenPath flag and Player.js's own walking code for the "fall off the
// end" half of this. It's also deliberately NOT isSkyDome: jump-through-
// from-below is handled by CollisionSystem's own swept crossing test
// instead (TerrainShape.findLandingCrossing).
//
// The parts are in js/world/tiled/ (split the same way as lua/world/tiled/):
//   Tiles.js         tile sizes, roles and slopes, image quads
//   TerrainShape.js  walkable runs of flat and slope segments
//   ClimbShapes.js   wall-climb ramps and loops
//   Level.js         walls, lava tiles, ball tunnels, the Level object
//   Baking.js        the baked image of the tile layers
// This file has TiledTerrain.load, which puts them together.

import lua from '../love/lua.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import {
  TILE_SOURCE_SIZE, TILE_SCALE, TILE_WORLD_SIZE, toNum,
  buildTilePropertyLookup, classifyGid, isTopRole,
} from './tiled/Tiles.js';
import {
  api as TerrainShapeApi, newShape, computeTopPointsByColumn, buildVertexRuns,
  buildWorldSegments,
} from './tiled/TerrainShape.js';
import { buildRampShapes } from './tiled/ClimbShapes.js';
import { buildWallShapes, buildLavaTiles, Level, buildTunnelSolids } from './tiled/Level.js';
import { api as BakingApi, bakeLayers } from './tiled/Baking.js';

const TiledTerrain = {};

// The functions the parts add to TiledTerrain.
for (const part of [TerrainShapeApi, BakingApi]) {
  for (const [name, value] of Object.entries(part)) {
    if (name in TiledTerrain) throw new Error(`TiledTerrain.${name} is defined twice`);
    TiledTerrain[name] = value;
  }
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

TiledTerrain.TILE_WORLD_SIZE = TILE_WORLD_SIZE;
TiledTerrain.TILE_SCALE = TILE_SCALE;

// mapData: a converted Tiled map (js/levels/*.js). anchorX/anchorY:
// world position of the map's own (0,0) (top-left) corner.
TiledTerrain.load = function (mapData, anchorX, anchorY) {
  // Tile layers, in drawing order (first is furthest back). Ones named
  // "Back" and "Middle" get the shadows of the layers in front of them.
  const tileLayers = mapData.layers.filter((l) => l.type === 'tilelayer');
  if (tileLayers.length === 0) throw new Error('TiledTerrain.load: no tilelayer found in map data');

  const width = mapData.width, height = mapData.height;
  const tilesets = mapData.tilesets;
  const tileProps = buildTilePropertyLookup(tilesets);

  // Collision comes from every layer at once: one combined layer that,
  // cell by cell, takes the most solid tile any layer has there (a wall
  // or lava over a walkable top, a walkable top over plain fill; the
  // front-most of equals).
  let layer = tileLayers[0];
  if (tileLayers.length > 1) {
    const solidity = (gid) => {
      if (gid === 0) return 0;
      const role = classifyGid(tileProps, gid);
      if (role === 'wall' || role === 'lava') return 3;
      if (role === 'fill') return 1;
      return 2; // walkable: flat tops, slopes, ramps, crests, arches, ceilings
    };
    const data = new Array(width * height);
    for (let i = 0; i < width * height; i++) {
      let best = 0, bestRank = 0;
      for (let li = tileLayers.length - 1; li >= 0; li--) { // front first, so it wins ties
        const gid = tileLayers[li].data[i] ?? 0;
        const rank = solidity(gid);
        if (rank > bestRank) { best = gid; bestRank = rank; }
      }
      data[i] = best;
    }
    layer = { data };
  }

  // Ramp-to-wall climbs — built BEFORE the ordinary column scan below, so
  // their claimed cells can be excluded from that scan.
  const [rampShapes, rampClaimedCells] = buildRampShapes(layer, tileProps, width, height, anchorX, anchorY);

  // Collision: derive shapes from the walkable-top height profile.
  const pointsByColumn = computeTopPointsByColumn(layer, tileProps, width, height, rampClaimedCells);
  const runs = buildVertexRuns(pointsByColumn, width);
  const shapes = [];
  for (const run of runs) {
    const segments = buildWorldSegments(run, anchorX, anchorY);
    if (segments.length > 0) shapes.push(newShape(segments));
  }

  // Ramp shapes are perfectly normal TerrainShapes as far as every other
  // system is concerned.
  for (const shape of rampShapes) shapes.push(shape);

  // Collision: solid walls, separate from the walkable shapes.
  const walls = buildWallShapes(layer, tileProps, width, height, anchorX, anchorY);

  // Ball-tunnel pieces, solid in their exact shape (see Level.pushPlayer).
  const [tunnelByCell, waterSolids] = buildTunnelSolids(layer, tileProps, width, height, anchorX, anchorY);

  // Lava tiles — where the lava starts out (see buildLavaTiles above, and WaterSystem.init).
  const lavaTiles = buildLavaTiles(layer, tileProps, width, height, anchorX, anchorY);

  // Entity spawn points authored via Tiled's own Object Layer — each
  // object's Class field says what kind of entity it is, matched against
  // main.js's own spawn loops. Object x/y come out of Tiled in the
  // tileset's own unscaled pixel space, so they need TILE_SCALE applied
  // to land in world space alongside anchorX/anchorY.
  const ooombaSpawns = [];
  // "Sphere": the object's own x/y IS the sphere's center.
  const sphereSpawns = [];
  // "Spikey": same point-placement convention.
  const spikeySpawns = [];
  // "Mirror": the object's own x/y IS the mirror's pivot; "Angle"
  // property in degrees.
  const mirrorSpawns = [];
  // "Spikey-Vertical": topY/bottomY are the WALL half of its patrol
  // bounds (main.js clamps further against nearby Spikeys).
  const spikeyVerticalSpawns = [];
  // "Lever": loosely placed, snapped down onto the terrain in main.js.
  const leverSpawns = [];
  // "Crank": same, plus the Mirror id it drives.
  const crankSpawns = [];
  // "Sign": same, plus its "message" property.
  const signSpawns = [];
  const plungerSpawns = []; // (RightPlunger/LeftPlunger — see js/world/Plunger.js)
  // "Gate": spans from the nearest wall/top tile BELOW the object's point
  // up to the nearest wall/top tile ABOVE it.
  const gateSpawns = [];
  const GATE_HALF_WIDTH = 16; // world units — a thin vertical bar
  // "Spikey-Orbit": orbitId is the Tiled id its "orbit" property names.
  const spikeyOrbitSpawns = [];
  // "Sphere-Move": startX/startY/endX/endY/speed describe its path.
  const sphereMoveSpawns = [];
  // "Zoom-Window": a rectangle that eases the camera to its own "zoom"
  // property while the player is inside it.
  const zoomWindows = [];
  // "DeathZone": dying inside it respawns at its respawnX/respawnY.
  const deathZones = [];
  // "Rope" and "Rock" rectangles (see js/world/RopeRock.js).
  const ropeSpawns = [];
  const rockSpawns = [];

  // Scans column `col` outward from `startRow` in direction `dRow` (+1 =
  // down, -1 = up) for the nearest "wall" or walkable "top" tile. Returns
  // its row, or null.
  const findSolidRow = (col, startRow, dRow) => {
    for (let r = startRow; r >= 0 && r < height; r += dRow) {
      const gid = layer.data[r * width + col] ?? 0;
      if (gid !== 0 && isTopRole(classifyGid(tileProps, gid))) return r;
    }
    return null;
  };

  const prop = (obj, name) => (obj.properties ? obj.properties[name] : undefined);

  for (const l of mapData.layers) {
    if (l.type !== 'objectgroup') continue;
    for (const obj of l.objects ?? []) {
      const wx = anchorX + obj.x * TILE_SCALE;
      const wy = anchorY + obj.y * TILE_SCALE;
      if (obj.class === 'Ooomba') {
        ooombaSpawns.push({ x: wx, y: wy });
      } else if (obj.class === 'Sphere') {
        sphereSpawns.push({
          x: wx, y: wy,
          // Tiled's own object id — a Spikey-Orbit can reference it.
          id: obj.id,
          // Optional "radius" (world units); null leaves the default.
          radius: toNum(prop(obj, 'radius')),
          // Optional "ooomba": how many Ooombas walk laps of it.
          ooombaCount: Math.max(0, Math.floor(toNum(prop(obj, 'ooomba')) ?? 0)),
          // Optional "gravity": its gravity's reach from its center.
          gravityRadius: toNum(prop(obj, 'gravity')),
        });
      } else if (obj.class === 'Spikey') {
        spikeySpawns.push({ x: wx, y: wy, id: obj.id });
      } else if (obj.class === 'Mirror') {
        mirrorSpawns.push({ x: wx, y: wy, angle: toNum(prop(obj, 'Angle')) ?? 0, id: obj.id });
      } else if (obj.class === 'Lever') {
        // The Gate object's own Tiled id this lever opens/closes.
        leverSpawns.push({ x: wx, y: wy, gateId: toNum(prop(obj, 'gate')) });
      } else if (obj.class === 'Crank') {
        crankSpawns.push({ x: wx, y: wy, mirrorId: toNum(prop(obj, 'Mirror')) });
      } else if (obj.class === 'RightPlunger' || obj.class === 'LeftPlunger') {
        // (See js/world/Plunger.js. Snapped to the tile the object's
        // top-left corner is in.)
        const col = Math.floor(obj.x / TILE_SOURCE_SIZE + 0.01);
        const row = Math.floor(obj.y / TILE_SOURCE_SIZE + 0.01);
        plungerSpawns.push({
          x: anchorX + col * TILE_WORLD_SIZE,
          y: anchorY + row * TILE_WORLD_SIZE,
          dir: obj.class === 'RightPlunger' ? 1 : -1,
        });
      } else if (obj.class === 'Sign') {
        signSpawns.push({ x: wx, y: wy, message: prop(obj, 'message') ?? '' });
      } else if (obj.class === 'Gate') {
        // obj.x/y are in the RAW tile-pixel space — dividing by
        // TILE_SOURCE_SIZE lands on the right row/col.
        const col = Math.floor(obj.x / TILE_SOURCE_SIZE);
        const row = Math.floor(obj.y / TILE_SOURCE_SIZE);
        const topRow = findSolidRow(col, row, -1);
        const bottomRow = findSolidRow(col, row, 1);
        if (topRow !== null && bottomRow !== null && bottomRow > topRow) {
          gateSpawns.push({
            x: anchorX + (col + 0.5) * TILE_WORLD_SIZE,
            topY: anchorY + (topRow + 1) * TILE_WORLD_SIZE,
            bottomY: anchorY + bottomRow * TILE_WORLD_SIZE,
            halfWidth: GATE_HALF_WIDTH,
            id: obj.id,
          });
        } else {
          // The only signal a level designer gets that a gate didn't resolve.
          console.log(lua.format(
            'TiledTerrain: Gate object at tile (col=%d, row=%d) failed to resolve a gate (topRow=%s, bottomRow=%s) — no gate spawned here.',
            col, row, lua.tostring(topRow), lua.tostring(bottomRow)));
        }
      } else if (obj.class === 'Spikey-Vertical') {
        // The entity's own world x is its EXACT raw position (not snapped
        // to the tile column the way Gate's is). Only the WALL half of the
        // patrol bounds is resolved here; null where none is found.
        const col = Math.floor(obj.x / TILE_SOURCE_SIZE);
        const row = Math.floor(obj.y / TILE_SOURCE_SIZE);
        const topRow = findSolidRow(col, row, -1);
        const bottomRow = findSolidRow(col, row, 1);
        spikeyVerticalSpawns.push({
          x: wx, y: wy,
          topY: topRow !== null ? (anchorY + (topRow + 1) * TILE_WORLD_SIZE) : null,
          bottomY: bottomRow !== null ? (anchorY + bottomRow * TILE_WORLD_SIZE) : null,
          speed: toNum(prop(obj, 'speed')),
        });
      } else if (obj.class === 'Spikey-Orbit') {
        spikeyOrbitSpawns.push({
          x: wx, y: wy,
          orbitId: toNum(prop(obj, 'orbit')),
          speed: toNum(prop(obj, 'speed')),
        });
      } else if (obj.class === 'Sphere-Move') {
        // startX/startY/endX/endY are in the SAME raw tile-pixel space
        // obj.x/y are, so they get the same conversion.
        sphereMoveSpawns.push({
          x: wx, y: wy,
          startX: anchorX + (toNum(prop(obj, 'startX')) ?? obj.x) * TILE_SCALE,
          startY: anchorY + (toNum(prop(obj, 'startY')) ?? obj.y) * TILE_SCALE,
          endX: anchorX + (toNum(prop(obj, 'endX')) ?? obj.x) * TILE_SCALE,
          endY: anchorY + (toNum(prop(obj, 'endY')) ?? obj.y) * TILE_SCALE,
          speed: toNum(prop(obj, 'speed')),
        });
      } else if (obj.class === 'Zoom-Window') {
        const zoom = toNum(prop(obj, 'zoom'));
        if (zoom !== null) {
          zoomWindows.push({ x: wx, y: wy, width: obj.width * TILE_SCALE, height: obj.height * TILE_SCALE, zoom });
        } else {
          console.log(lua.format('TiledTerrain: Zoom-Window object id %s has no numeric "zoom" property — ignored.', lua.tostring(obj.id)));
        }
      } else if (obj.class === 'Rope' || obj.class === 'Rock') {
        const spawn = { id: obj.id, x: wx, y: wy, width: obj.width * TILE_SCALE, height: obj.height * TILE_SCALE };
        if (obj.class === 'Rope') {
          // "holds": an object property (exported as { id: n }), or the
          // id typed in as a number/string.
          const holds = prop(obj, 'holds');
          spawn.holdsId = toNum(holds && typeof holds === 'object' ? holds.id : holds);
          ropeSpawns.push(spawn);
        } else {
          spawn.solid = prop(obj, 'solid') !== false;
          rockSpawns.push(spawn);
        }
      } else if (obj.class === 'DeathZone') {
        const respawnX = toNum(prop(obj, 'respawnX')), respawnY = toNum(prop(obj, 'respawnY'));
        if (respawnX !== null && respawnY !== null) {
          deathZones.push({
            x: wx, y: wy, width: obj.width * TILE_SCALE, height: obj.height * TILE_SCALE,
            respawnX: anchorX + respawnX * TILE_SCALE,
            respawnY: anchorY + respawnY * TILE_SCALE,
          });
        } else {
          console.log(lua.format('TiledTerrain: DeathZone object id %s needs numeric "respawnX" and "respawnY" properties — ignored.', lua.tostring(obj.id)));
        }
      }
    }
  }

  // Rendering: bake EVERY tile layer to one canvas, once, with the depth
  // shading (see bakeLayers).
  let canvas = null;
  const img = state.platformTexture;
  if (img) canvas = bakeLayers(tileLayers, tilesets, tileProps, width, height, img);

  const mapWorldWidth = width * TILE_WORLD_SIZE;
  const mapWorldHeight = height * TILE_WORLD_SIZE;

  return new Level({
    shapes,
    walls,
    lavaTiles,
    ooombaSpawns,
    sphereSpawns,
    spikeySpawns,
    mirrorSpawns,
    leverSpawns,
    crankSpawns,
    signSpawns,
    plungerSpawns,
    gateSpawns,
    spikeyVerticalSpawns,
    spikeyOrbitSpawns,
    sphereMoveSpawns,
    zoomWindows,
    deathZones,
    ropeSpawns,
    rockSpawns,
    // (For Level.solidAt/headroomAt/pushPlayer — ball tunnels.)
    tunnelByCell,
    waterSolids,
    collisionData: layer.data,
    tileProps,
    // (For GrassBlades.build — what art is drawn where.)
    tileLayers,
    tilesets,
    mapWidth: width,
    mapHeight: height,
    canvas,
    anchorX,
    anchorY,
    // Bounding center/radius, for viewport culling (utils.isOnScreen).
    pos: new Vector2(anchorX + mapWorldWidth / 2, anchorY + mapWorldHeight / 2),
    radius: Math.sqrt(mapWorldWidth * mapWorldWidth + mapWorldHeight * mapWorldHeight) / 2,
  });
};

export default TiledTerrain;
