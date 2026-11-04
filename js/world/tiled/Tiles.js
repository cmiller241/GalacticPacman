// js/world/tiled/Tiles.js
//
// Tile sizes, each tile's role and slope (read from the tileset's custom
// properties), and the quads its images are drawn from.
// Part of the Tiled level loader: see js/world/TiledTerrain.js.

import love from '../../love/index.js';

// ---------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------

const TILE_SOURCE_SIZE = 32; // px, matches tiled/Grass Tiles.tsx
const TILE_SCALE = 2;
const TILE_WORLD_SIZE = TILE_SOURCE_SIZE * TILE_SCALE; // 64 world units/tile

// Fallback only — used if the embedded tileset def doesn't carry its own
// `columns` field. Normally read straight off the tileset data.
const DEFAULT_TILESET_COLUMNS = 9;

// Lua's tonumber: a finite number, or null.
function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------
// Tileset GID -> role/slope, read from Tiled custom properties
// ---------------------------------------------------------------------

function findTileset(tilesets, gid) {
  let best = null;
  for (const ts of tilesets) {
    if (ts.firstgid <= gid && (!best || ts.firstgid > best.firstgid)) best = ts;
  }
  return best;
}

// Tiled's Lua exporter emits a tile's custom properties as a flat
// { name: value } object. Defensively also accept the array-of-
// {name, value} shape (the JSON exporter's convention).
function readTileProperties(rawProperties) {
  if (!rawProperties) return {};
  if (rawProperties.role !== undefined || rawProperties.slope !== undefined) return rawProperties;
  const out = {};
  if (Array.isArray(rawProperties)) {
    for (const entry of rawProperties) if (entry && entry.name) out[entry.name] = entry.value;
  }
  return out;
}

// Builds a gid -> {role, slope} lookup from every tileset's embedded
// `tiles` array. Asserts loudly if a tileset has none — the near-certain
// cause is the tileset still being an external reference.
function buildTilePropertyLookup(tilesets) {
  const byGid = {};
  let anyTiles = false;
  for (const ts of tilesets) {
    if (ts.tiles) {
      anyTiles = true;
      for (const tileDef of ts.tiles) {
        byGid[ts.firstgid + tileDef.id] = readTileProperties(tileDef.properties);
      }
    }
  }
  if (!anyTiles) {
    throw new Error('TiledTerrain.load: no embedded tile properties found — '
      + 'the tileset must be embedded in the map (Tiled: right-click it in the '
      + 'Tilesets panel -> "Embed Tileset in Map", then re-export)');
  }
  return byGid;
}

// Returns "flat", "riseRight", "riseLeft", "wall", "lava", "rampRight",
// "rampLeft", "ceilingLeft/Right", "crestLeft/Right", "archLeft/Right",
// "fill", or "empty", straight from that tile's own role/slope
// properties. Untagged or unrecognized-role tiles default to "fill".
//
// The ramp/ceiling/crest/arch kinds are deliberately NOT isTopRole (see
// below) — they never go through the ordinary per-column walkable-top
// scan, which can only describe one floor height per column (capping any
// chain at 45 degrees of average rise). See buildRampClimbShape and
// buildConvexClimbShape, which build explicit paths for these instead.
function classifyGid(tileProps, gid) {
  if (gid === 0) return 'empty';
  const props = tileProps[gid];
  const role = props ? props.role : undefined;
  if (role === 'wall') return 'wall';
  if (role === 'lava') return 'lava';
  if (role === 'top') {
    const slope = props.slope;
    if (slope === 'riseLeft' || slope === 'riseRight') return slope;
    // A curve from flat ground up into a wall face.
    if (slope === 'rampRight' || slope === 'rampLeft') return slope;
    // A second curve capping a wall-climb's wall stack, continuing PAST
    // vertical into a ceiling.
    if (slope === 'ceilingLeft' || slope === 'ceilingRight') return slope;
    // The CONVEX counterparts: a flat TOP curving down into a wall
    // (crest), and that wall curving further into an underside belly
    // (arch) — walking over and around the outside of a rounded block.
    if (slope === 'crestRight' || slope === 'crestLeft') return slope;
    if (slope === 'archRight' || slope === 'archLeft') return slope;
    // Ball-tunnel pieces (see CrackedPlanetoid.js's SHAPED_TILES):
    //   * an *Inner corner is the tunnel's wall and ceiling (or floor) at
    //     a bend: a "wall" — solid, with a walkable top — so the curve he
    //     rolls round (buildRampClimbShape) runs up its face and over it
    //     like any other wall. (Its rounded corner is only art.)
    //   * an *Outer1/2/3 arc is the outside of a bend round a crest or
    //     arch: mostly open tunnel, solid only out past its curve — so no
    //     top here (it'd be an invisible ledge in the middle of the
    //     tunnel); it's solid in its exact shape (see buildTunnelSolids).
    if (slope && /Inner$/.test(slope)) return 'wall';
    if (slope && /Outer\d$/.test(slope)) return 'fill';
    return 'flat';
  }
  return 'fill';
}

// "wall" counts as walkable-top too, in addition to getting its own solid
// WallShape AABB elsewhere (see buildWallShapes) — a wall tile is solid
// rock: its vertical face blocks horizontal passage and is what a wall
// jump kicks off of, but its TOP is ordinary ground, exactly like a real
// cliff.
function isTopRole(role) {
  return role === 'flat' || role === 'riseRight' || role === 'riseLeft' || role === 'wall';
}

// ---------------------------------------------------------------------
// Shared baked quads (reused by every loaded level). Keyed only by
// localIndex — fine as long as this project uses a single tileset.
// ---------------------------------------------------------------------

let tileQuadCache = null;

function getTileQuadForLocalIndex(img, localIndex, columns) {
  if (!tileQuadCache) tileQuadCache = new Map();
  let quad = tileQuadCache.get(localIndex);
  if (quad) return quad;
  const col = localIndex % columns;
  const row = Math.floor(localIndex / columns);
  const [fullW, fullH] = img.getDimensions();
  quad = love.graphics.newQuad(col * TILE_SOURCE_SIZE, row * TILE_SOURCE_SIZE, TILE_SOURCE_SIZE, TILE_SOURCE_SIZE, fullW, fullH);
  tileQuadCache.set(localIndex, quad);
  return quad;
}

export { TILE_SOURCE_SIZE, TILE_SCALE, TILE_WORLD_SIZE, DEFAULT_TILESET_COLUMNS, toNum, findTileset, buildTilePropertyLookup, classifyGid, isTopRole, getTileQuadForLocalIndex };
