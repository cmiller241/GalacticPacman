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

import love from '../love/index.js';
import lua from '../love/lua.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import Lava from './Lava.js';

const TiledTerrain = {};

// ---------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------

const TILE_SOURCE_SIZE = 32; // px, matches tiled/Grass Tiles.tsx
const TILE_SCALE = 2;
const TILE_WORLD_SIZE = TILE_SOURCE_SIZE * TILE_SCALE; // 64 world units/tile

// Fallback only — used if the embedded tileset def doesn't carry its own
// `columns` field. Normally read straight off the tileset data.
const DEFAULT_TILESET_COLUMNS = 9;

const SLOPE_UPHILL_MULTIPLIER = 0.6;   // walking speed climbing a 45-degree segment; flat stays 1.0
const SLOPE_DOWNHILL_MULTIPLIER = 1.4; // walking speed descending a 45-degree segment

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

// ---------------------------------------------------------------------
// TerrainShape — one open, walkable run of flat/slope segments
// ---------------------------------------------------------------------

// Projects (worldX, worldY) onto segment [seg.a, seg.b], clamped to the
// segment's own extent. Returns [t, px, py, distance].
function projectOntoSegment(seg, worldX, worldY) {
  const dx = seg.b.x - seg.a.x, dy = seg.b.y - seg.a.y;
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 1e-9) {
    t = ((worldX - seg.a.x) * dx + (worldY - seg.a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
  }
  const px = seg.a.x + dx * t, py = seg.a.y + dy * t;
  const ddx = worldX - px, ddy = worldY - py;
  return [t, px, py, Math.sqrt(ddx * ddx + ddy * ddy)];
}

class TerrainShape {
  constructor(segments) {
    this.segments = segments;
    this.totalLength = 0;
    for (const seg of segments) this.totalLength += seg.length;

    this.isRoundedRect = true;
    this.isImmovable = true;
    this.isPermanent = true;
    this.isPullExempt = true;
    this.isOpenPath = true;
    this.forceUprightJump = true;
    this.vel = new Vector2(0, 0);
    this.mass = 1e9;

    // Bounding circle + halfHeight, for generic code that expects every
    // planetoid-like object to have these (utils.isOnScreen culling, and
    // CollisionSystem.handleImmovableCollisions, which reads
    // `im.pos.y - im.halfHeight` for ANY isRoundedRect immovable).
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const seg of segments) {
      for (const p of [seg.a, seg.b]) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    this.pos = new Vector2(cx, cy);
    this.halfHeight = Math.max(1, (maxY - minY) / 2);
    let radius = 0;
    for (const seg of segments) {
      for (const p of [seg.a, seg.b]) radius = Math.max(radius, p.subtract(this.pos).length());
    }
    this.radius = Math.max(1, radius);
  }

  nearestSurfacePoint(worldX, worldY) {
    let best = null;
    for (const seg of this.segments) {
      const [, px, py, dist] = projectOntoSegment(seg, worldX, worldY);
      if (!best || dist < best.distance) {
        best = { point: new Vector2(px, py), normal: seg.normal, distance: dist };
      }
    }
    return best;
  }

  distanceToSurface(worldX, worldY) {
    return this.nearestSurfacePoint(worldX, worldY).distance;
  }

  // Landing check for open-path terrain: a segment only counts as a
  // landing candidate when the player's movement THIS FRAME actually
  // crossed it — was on the outward (walkable) side a moment ago, and is
  // at/through it now — while genuinely positioned over the segment's
  // own span (no clamping to endpoints). The same swept test ordinary
  // platformer tile collision uses: jump-through-from-below and walking
  // off the end just work. Used by CollisionSystem.tryLandOnPlanet; every
  // other caller still wants the always-clamped nearestSurfacePoint.
  findLandingCrossing(prevX, prevY, curX, curY) {
    let best = null;
    for (const seg of this.segments) {
      // isWallFace segments are never a valid landing target — getting
      // "caught" on the wall by a direct jump bypassed the ramp entry.
      if (!seg.isWallFace) {
        const dx = seg.b.x - seg.a.x, dy = seg.b.y - seg.a.y;
        const lenSq = dx * dx + dy * dy;
        if (lenSq > 1e-9) {
          const nx = seg.normal.x, ny = seg.normal.y;
          // (Where they were measured against where the surface was then —
          // the same thing, except for a moving one: see newMovingSurface.)
          const pa = seg.prevA ?? seg.a, pn = seg.prevNormal ?? seg.normal;
          const prevSigned = (prevX - pa.x) * pn.x + (prevY - pa.y) * pn.y;
          const curSigned = (curX - seg.a.x) * nx + (curY - seg.a.y) * ny;
          if (prevSigned >= 0 && curSigned <= prevSigned) {
            const t = ((curX - seg.a.x) * dx + (curY - seg.a.y) * dy) / lenSq;
            if (t >= 0 && t <= 1) {
              const px = seg.a.x + dx * t, py = seg.a.y + dy * t;
              const ddx = curX - px, ddy = curY - py;
              const dist = Math.sqrt(ddx * ddx + ddy * ddy);
              if (!best || dist < best.distance) {
                best = { point: new Vector2(px, py), normal: seg.normal, distance: dist };
              }
            }
          }
        }
      }
    }
    return best;
  }

  containsPoint(worldX, worldY) {
    return this.distanceToSurface(worldX, worldY) < 1;
  }

  // No-op: TerrainShape instances live in state.planetoids, whose draw
  // loop calls draw() on every entry — the actual visuals are the
  // level's single baked canvas (Level.draw below).
  draw() {}

  getPerimeter() {
    return this.totalLength;
  }

  // Which segment covers arc-length s (clamped, not wrapped — this is an
  // open path), and the world point at that exact spot. Returns [seg, point].
  segmentAndPointAtArcPosition(s) {
    const clamped = Math.max(0, Math.min(this.totalLength, s));
    let remaining = clamped;
    const n = this.segments.length;
    for (let i = 0; i < n; i++) {
      const seg = this.segments[i];
      if (remaining <= seg.length || i === n - 1) {
        let t = seg.length > 0 ? (remaining / seg.length) : 0;
        t = Math.max(0, Math.min(1, t));
        const px = seg.a.x + (seg.b.x - seg.a.x) * t;
        const py = seg.a.y + (seg.b.y - seg.a.y) * t;
        return [seg, new Vector2(px, py)];
      }
      remaining -= seg.length;
    }
    const seg = this.segments[n - 1];
    return [seg, seg.b.clone()];
  }

  // Just the segment (what Player.js asks for).
  segmentAtArcPosition(s) {
    return this.segmentAndPointAtArcPosition(s)[0];
  }

  worldPointAtArcPosition(s, pushDistance = 0) {
    let [seg, point] = this.segmentAndPointAtArcPosition(s);
    const normal = seg.normal;
    if (pushDistance !== 0) {
      // forceUprightJump shapes (ordinary hills/ramps) push straight up,
      // never along the segment's own (possibly diagonal) normal — the
      // player stays upright regardless of slope, so the resting offset
      // has to match or his CENTER jumps sideways the instant a walk
      // crosses from flat onto 45 degrees (a camera jolt).
      //
      // Shapes with forceUprightJump = false (wall climbs) push along the
      // segment's TRUE normal instead — running up a wall needs the
      // resting offset to point sideways there too.
      const pushDir = this.forceUprightJump ? new Vector2(0, -1) : normal;
      point = point.clone().add(pushDir.multiply(pushDistance));
    }
    return { point, normal };
  }

  // excludeWallFace: skip the wall-face segment when picking the nearest
  // one. Only passed true from the LANDING path
  // (CollisionSystem.tryLandOnPlanet) — near a corner like a ceiling cap,
  // the wall face sits geometrically close to the segments a player
  // actually lands on, so "nearest segment" and "the segment they landed
  // on" can disagree. Left false for the wall-push resync, which fires
  // legitimately while genuinely walking the wall face itself.
  arcPositionForWorldPoint(worldX, worldY, excludeWallFace) {
    let traveled = 0;
    let bestArc = 0, bestDistSq = Infinity;
    for (const seg of this.segments) {
      if (!(excludeWallFace && seg.isWallFace)) {
        const [t, px, py] = projectOntoSegment(seg, worldX, worldY);
        const ddx = worldX - px, ddy = worldY - py;
        const distSq = ddx * ddx + ddy * ddy;
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          bestArc = traveled + t * seg.length;
        }
      }
      traveled += seg.length;
    }
    return bestArc;
  }

  // Walking-speed hook Player.js and Ooomba.js look for (duck-typed).
  // Steepness is binary here since every slope in this system is exactly
  // 45 degrees by construction. `direction` is the caller's own signed
  // arc-length step (ds for the player, ±1 for an Ooomba) — needed to
  // tell uphill from downhill. tangent points toward increasing arc
  // position; direction * tangent.y is positive walking downhill and
  // negative walking uphill.
  getArcSpeedMultiplier(s, direction = 1) {
    // Wall-climb shapes are exempt entirely — they're meant to run at
    // full, Sonic-style speed.
    if (this.isWallClimb) return 1.0;

    const seg = this.segmentAtArcPosition(s);
    if (Math.abs(seg.tangent.y) <= 0.01) return 1.0;
    if (direction * seg.tangent.y > 0) return SLOPE_DOWNHILL_MULTIPLIER;
    return SLOPE_UPHILL_MULTIPLIER;
  }

  // A moving surface's update: put its one segment at a -> b (see
  // TiledTerrain.newMovingSurface).
  moveTo(ax, ay, bx, by) {
    const seg = this.segments[0];
    // (Where it was a moment ago, for findLandingCrossing: a surface
    // rising into someone falling onto it would otherwise already be past
    // where they were last frame, and they'd fall straight through it.)
    seg.prevA = seg.prevA ?? new Vector2(0, 0);
    seg.prevA.x = seg.a.x;
    seg.prevA.y = seg.a.y;
    seg.prevNormal = seg.normal ?? new Vector2(0, -1);
    seg.a.x = ax; seg.a.y = ay; seg.b.x = bx; seg.b.y = by;
    const dx = bx - ax, dy = by - ay;
    const len = Math.max(1e-6, Math.sqrt(dx * dx + dy * dy));
    seg.length = len;
    seg.tangent = new Vector2(dx / len, dy / len);
    seg.normal = new Vector2(dy / len, -dx / len); // (the tangent turned -90 degrees: up, for a left-to-right one)
    this.totalLength = len;
    this.pos.x = (ax + bx) / 2;
    this.pos.y = (ay + by) / 2;
    this.halfHeight = Math.max(1, Math.abs(dy) / 2);
    this.radius = Math.max(1, len / 2);
  }
}

TiledTerrain.TerrainShape = TerrainShape;

function newShape(segments) {
  return new TerrainShape(segments);
}

// A walkable surface that moves — one straight segment from a to b,
// walked on (left to right, its open side up) like any other ledge, put
// wherever it is each frame with moveTo. E.g. the top of a rock swinging
// on a rope (see js/world/RopeRock.js).
TiledTerrain.newMovingSurface = function (ax, ay, bx, by) {
  const seg = { a: new Vector2(ax, ay), b: new Vector2(bx, by), length: 0 };
  const shape = newShape([seg]);
  shape.moveTo(ax, ay, bx, by);
  return shape;
};

// ---------------------------------------------------------------------
// Building shapes from the tile grid
// ---------------------------------------------------------------------

// Returns an array indexed [0, width-1], each entry a list of every row
// (0-based tile row, smaller = higher up) classified "top" in that
// column, top-to-bottom. A single column can hold more than one — e.g. a
// floating plateau directly above a lower staircase step — see
// buildVertexRuns for how multiple layers become separate shapes.
//
// WALL tiles get one extra check: only the TOPMOST EXPOSED wall tile of a
// stack counts (the cell directly above must be empty) — buried wall
// tiles aren't floors. Flat/slope tiles do NOT get this check: they're
// only ever one layer deep, so a non-empty cell above one is just
// decoration (an overhang), not burial.
//
// claimedCells (optional): a set of row*width+col keys to skip entirely —
// tiles already absorbed into a ramp-climb shape, so they aren't ALSO
// picked up here as an overlapping ordinary shape (the seam between two
// overlapping shapes reads as a hop).
function computeTopPointsByColumn(layer, tileProps, width, height, claimedCells) {
  const pointsByColumn = [];
  for (let col = 0; col < width; col++) {
    const rows = [];
    for (let row = 0; row < height; row++) {
      const gid = layer.data[row * width + col] ?? 0;
      if (gid !== 0 && !(claimedCells && claimedCells.has(row * width + col))) {
        const role = classifyGid(tileProps, gid);
        if (isTopRole(role)) {
          if (role !== 'wall') {
            rows.push({ row, kind: role });
          } else {
            const aboveGid = row > 0 ? (layer.data[(row - 1) * width + col] ?? 0) : 0;
            if (aboveGid === 0) rows.push({ row, kind: role });
          }
        }
      }
    }
    pointsByColumn[col] = rows;
  }
  return pointsByColumn;
}

// A one-row height change only bridges into the SAME chain when it's an
// authored 45-degree slope tile (riseLeft/riseRight) on at least one side
// — two "flat" (or "wall") tops one row apart must NOT auto-connect (that
// spliced in a sheer vertical segment walkable as a "side" of a curb).
function isRiseKind(kind) {
  return kind === 'riseLeft' || kind === 'riseRight';
}

// Threads each column's top points into shapes: a list of open chains is
// carried left-to-right, each chain extended by whichever point in the
// next column is within one row (flat or 45-degree step) of its own last
// point; a chain that finds no match ends and is kept. Several stacked
// layers all run concurrently as independent shapes. A length-1 chain (a
// single-tile-wide pillar's cap) is kept too — it's a perfectly good tiny
// platform.
function buildVertexRuns(pointsByColumn, width) {
  const runs = [];
  let openChains = [];
  for (let col = 0; col < width; col++) {
    const entries = pointsByColumn[col] ?? [];
    const usedRow = new Set();
    const newOpenChains = [];

    for (const chain of openChains) {
      const last = chain[chain.length - 1];
      let best = null, bestDelta = null;
      for (const entry of entries) {
        if (!usedRow.has(entry.row)) {
          const delta = Math.abs(entry.row - last.row);
          const connects = delta === 0 || (delta === 1 && (isRiseKind(last.kind) || isRiseKind(entry.kind)));
          if (connects && (bestDelta === null || delta < bestDelta)) {
            bestDelta = delta;
            best = entry;
          }
        }
      }
      if (best) {
        usedRow.add(best.row);
        chain.push({ col, row: best.row, kind: best.kind });
        newOpenChains.push(chain);
      } else {
        runs.push(chain);
      }
    }

    for (const entry of entries) {
      if (!usedRow.has(entry.row)) newOpenChains.push([{ col, row: entry.row, kind: entry.kind }]);
    }

    openChains = newOpenChains;
  }

  for (const chain of openChains) runs.push(chain);
  return runs;
}

// Coalesces a vertex run into straight segments (flat runs and 45-degree
// runs collapse to one segment each), in WORLD space. Each column
// contributes its own LEFT and RIGHT tile edges — a flat tile's both at
// its own row; a slope tile's two edges at DIFFERENT rows, which edge is
// which determined by its `kind` ("riseLeft" and "riseRight" anchor to
// opposite neighbors). Consecutive columns' shared edge always lines up
// exactly, so the duplicate point is simply dropped.
function buildWorldSegments(vertices, anchorX, anchorY) {
  const worldXY = (col, row) => [anchorX + col * TILE_WORLD_SIZE, anchorY + row * TILE_WORLD_SIZE];

  const points = [];
  const addPoint = (x, y) => {
    const last = points[points.length - 1];
    if (!last || last.x !== x || last.y !== y) points.push({ x, y });
  };

  for (const v of vertices) {
    let leftRow, rightRow;
    if (v.kind === 'riseLeft') { leftRow = v.row; rightRow = v.row + 1; }
    else if (v.kind === 'riseRight') { leftRow = v.row + 1; rightRow = v.row; }
    else { leftRow = v.row; rightRow = v.row; }
    const [lx, ly] = worldXY(v.col, leftRow);
    addPoint(lx, ly);
    const [rx, ry] = worldXY(v.col + 1, rightRow);
    addPoint(rx, ry);
  }

  const segments = [];
  let segStart = 0;
  for (let i = 1; i < points.length; i++) {
    const prevDx = points[i].x - points[i - 1].x, prevDy = points[i].y - points[i - 1].y;
    const hasNext = i < points.length - 1;
    const nextDx = hasNext ? (points[i + 1].x - points[i].x) : null;
    const nextDy = hasNext ? (points[i + 1].y - points[i].y) : null;
    const sameDir = nextDx !== null && prevDx === nextDx && prevDy === nextDy;
    if (!sameDir) {
      const a = new Vector2(points[segStart].x, points[segStart].y);
      const b = new Vector2(points[i].x, points[i].y);
      const tangent = b.subtract(a).normalize();
      // rotate tangent -90 degrees for the outward (upward-facing) normal —
      // matches RoundedRectPlanetoid's own edge convention (dir=(1,0) -> normal=(0,-1))
      const normal = new Vector2(tangent.y, -tangent.x).normalize();
      segments.push({ a, b, tangent, normal, length: b.subtract(a).length() });
      segStart = i;
    }
  }
  return segments;
}

function midpoint(a, b) {
  return new Vector2((a.x + b.x) * 0.5, (a.y + b.y) * 0.5);
}

// ---------------------------------------------------------------------
// Ramp-to-wall climbs (rampRight/rampLeft)
// ---------------------------------------------------------------------
// The ordinary per-column scan can only ever describe one floor height
// per column, capping any chain at 45 degrees of average rise — nowhere
// near enough for a curve that ends up fully vertical. This builds one
// explicit, hand-computed path per authored ramp tile instead: a
// quarter-circle arc exactly inscribed in that ONE tile's own 64x64 box,
// continuing straight up whatever "wall"-role stack sits directly above
// it, then picking up one ordinary 45-degree slope tile if one caps that
// stack (or a ceiling cap — see below).
//
// forceUprightJump is turned OFF on these shapes — orientation and the
// walking push-offset both follow the path's true local normal: upright
// on the flat approach, rotating through the curve, fully sideways
// climbing the wall, and upright again on flat ground.
//
// The "wall"-role tiles this climbs are unaffected — buildWallShapes
// still turns them into their own solid rects, so wall-jumping off them
// keeps working independently.
//
// INDEXING: point lists here keep the Lua version's numbering for the
// bookkeeping (counts like arcSegmentCount/capArcStart/wallSegIndex are
// "number of points so far"), and segment i (1-based) runs from
// points[i - 1] to points[i] in the 0-based JS array.
// ---------------------------------------------------------------------

const RAMP_ARC_SEGMENTS = 10; // straight segments approximating the quarter-circle

// Called when a ceiling-backing run STOPS and finds a ceilingLeft/
// ceilingRight tile one row below that isn't anchored by some other ramp:
// treats that tile as a genuine END cap of this shape — curves DOWN off
// of it into a wall descending in the adjacent column, and if that wall
// bottoms out onto an archLeft/archRight tile, curves into that arch and
// starts a fresh underside run past it (continuing in the SAME direction
// the ceiling run was already traveling).
//
// Returns null if there's no wall-into-arch structure there (the ordinary
// two-ramps-meet-directly case), or an object describing the new points
// plus the bookkeeping the caller needs.
//
// startPoint: the run's own last point, sitting exactly on this cap
// tile's near corner. capRow/capCol: the cap tile's grid position.
// capRole: its slope string, deciding which side the wall descends on.
function tryDescendCeilingCapToArch(layer, tileProps, width, height, anchorX, anchorY, capRow, capCol, capRole, startPoint) {
  const T = TILE_WORLD_SIZE;
  const dirCap = capRole === 'ceilingLeft' ? 1 : (capRole === 'ceilingRight' ? -1 : null);
  if (dirCap === null) return null;

  const wallCol = capCol + dirCap;
  if (wallCol < 0 || wallCol >= width) return null;

  // The side of the wall column facing back toward the cap tile.
  const wallEdgeX = anchorX + (dirCap > 0 ? wallCol : (wallCol + 1)) * T;

  // Scan DOWNWARD for contiguous "wall"-role tiles starting one row below
  // the cap. Left at capRow (a zero-height wall) when none are found.
  let wallBottomRow = capRow;
  for (let r = capRow + 1; r < height; r++) {
    const gid = layer.data[r * width + wallCol] ?? 0;
    if (gid === 0 || classifyGid(tileProps, gid) !== 'wall') break;
    wallBottomRow = r;
  }

  const archRow = wallBottomRow + 1;
  const archCol = wallCol;
  if (archRow >= height) return null;
  const archGid = layer.data[archRow * width + archCol] ?? 0;
  const archRole = archGid !== 0 ? classifyGid(tileProps, archGid) : 'empty';
  if (archRole !== 'archLeft' && archRole !== 'archRight') return null;

  const claimed = new Set();
  const newPoints = [];

  // First arc: ceiling cap's own corner (startPoint) curving down to the
  // wall's own top tangent point. Center sits directly below startPoint,
  // one tile down. ("Start" markers: the count of points BEFORE the new
  // range begins.)
  const center1 = new Vector2(startPoint.x, anchorY + (capRow + 1) * T);
  const arc1Start = newPoints.length;
  for (let i = 1; i <= RAMP_ARC_SEGMENTS; i++) {
    const t = i / RAMP_ARC_SEGMENTS;
    const theta = -Math.PI / 2 + dirCap * (Math.PI / 2) * t;
    newPoints.push(new Vector2(center1.x + T * Math.cos(theta), center1.y + T * Math.sin(theta)));
  }
  const arc1End = newPoints.length;

  // Wall segment (may end up zero-length — harmless).
  for (let r = capRow + 1; r <= wallBottomRow; r++) claimed.add(r * width + wallCol);
  const wallSegIndex = newPoints.length;
  newPoints.push(new Vector2(wallEdgeX, anchorY + (wallBottomRow + 1) * T));

  // Second arc: wall's own bottom tangent curving into the arch tile's
  // underside tangent. It enters with a VERTICAL tangent, so the center
  // is offset sideways (same y as the entry point). It's also CONVEX —
  // the center sits on the material side and the curve bulges away.
  const entry2 = newPoints[newPoints.length - 1];
  const center2 = new Vector2(entry2.x + dirCap * T, entry2.y);
  const entryTheta2 = dirCap > 0 ? Math.PI : 0;
  const arc2Start = newPoints.length;
  for (let i = 1; i <= RAMP_ARC_SEGMENTS; i++) {
    const t = i / RAMP_ARC_SEGMENTS;
    const theta = entryTheta2 - dirCap * (Math.PI / 2) * t;
    newPoints.push(new Vector2(center2.x + T * Math.cos(theta), center2.y + T * Math.sin(theta)));
  }
  const arc2End = newPoints.length;
  claimed.add(archRow * width + archCol);

  // Underside run: stops the instant it isn't "wall"-backed anymore,
  // checking for a same-row archLeft/archRight partner to hand off to via
  // continuesAtKey.
  const runStart = newPoints.length;
  let continuesAtKey = null;
  let fc = archCol + dirCap;
  while (fc >= 0 && fc < width) {
    const fgid = layer.data[archRow * width + fc] ?? 0;
    if (fgid === 0 || classifyGid(tileProps, fgid) !== 'wall') {
      if (fgid !== 0) {
        const hitRole = classifyGid(tileProps, fgid);
        if (hitRole === 'archLeft' || hitRole === 'archRight') continuesAtKey = archRow * width + fc;
      }
      break;
    }
    claimed.add(archRow * width + fc);
    const edgeCol = dirCap > 0 ? (fc + 1) : fc;
    newPoints.push(new Vector2(anchorX + edgeCol * T, anchorY + (archRow + 1) * T));
    fc += dirCap;
  }
  return {
    points: newPoints,
    center1, arc1Start, arc1End,
    wallSegIndex,
    center2, arc2Start, arc2End,
    runStart,
    claimed,
    ownCapTileKey2: archRow * width + archCol,
    continuesAtKey,
    dirCap,
  };
}

// Builds the full climb path for one ramp tile at (col, row). dir = 1 for
// rampRight (ledge below-left, wall above-right), dir = -1 for rampLeft
// (mirrored).
//
// The arc is centered on whichever corner of the tile's own box sits on
// the curve's open-air side — top-left for rampRight, top-right for
// rampLeft — sweeping from the tangent-HORIZONTAL point (the flat ledge
// below) to the tangent-VERTICAL point (the wall above). Its normal
// always points TOWARD the center (the open-air side).
//
// The straight portions reuse the rotate-the-tangent convention, mirrored
// by `dir` (rampLeft's path traverses each tile's edges in the opposite
// order).
//
// Returns [shape, claimedCells] — claimedCells is a Set of every tile
// this shape absorbed, for the caller to exclude from
// computeTopPointsByColumn.
function buildRampClimbShape(layer, tileProps, width, height, anchorX, anchorY, col, row, dir) {
  const T = TILE_WORLD_SIZE;
  const x0 = anchorX + col * T;
  const y0 = anchorY + row * T;
  const claimedCells = new Set();

  const centerX = dir > 0 ? x0 : (x0 + T);
  const centerY = y0;
  const center = new Vector2(centerX, centerY);

  const thetaLedge = Math.PI / 2;
  const thetaWall = dir > 0 ? 0 : Math.PI;

  const points = [];
  for (let i = 0; i <= RAMP_ARC_SEGMENTS; i++) {
    const t = i / RAMP_ARC_SEGMENTS;
    const theta = thetaLedge + (thetaWall - thetaLedge) * t;
    points.push(new Vector2(centerX + T * Math.cos(theta), centerY + T * Math.sin(theta)));
  }
  const arcSegmentCount = points.length - 1;

  // Wall column: directly above-right (rampRight) or above-left
  // (rampLeft) of the ramp tile. Walks upward counting contiguous
  // "wall"-role tiles to find where the stack actually ends.
  const wallCol = dir > 0 ? (col + 1) : (col - 1);
  let wallTopRow = null;
  for (let r = row - 1; r >= 0; r--) {
    const gid = layer.data[r * width + wallCol] ?? 0;
    if (gid === 0 || classifyGid(tileProps, gid) !== 'wall') break;
    wallTopRow = r;
    claimedCells.add(r * width + wallCol);
  }

  let wallSegIndex = null;
  // Set only when this shape's own ceiling run dips down into a wall and
  // an archLeft/archRight cap (see tryDescendCeilingCapToArch).
  let descentCenter1 = null, descentArc1Start = null, descentArc1End = null;
  let descentWallSegIndex = null;
  let descentCenter2 = null, descentArc2Start = null, descentArc2End = null;
  let descentRunStart = null;
  let descentDirCap = null;
  let secondaryCapTileKey = null;
  // Set only when a ceilingLeft/ceilingRight cap is found — a SECOND arc,
  // with its own center.
  let capCenter = null, capArcStart = null, capArcEnd = null;
  // The point count the ceiling-backing run starts from (only when the
  // run is the ceiling's own solid backing). Segments from here on, PLUS
  // the cap arc itself, are "the ceiling" for Player.js's isCeiling check.
  let ceilingRunStart = null;
  // This shape's OWN cap tile position (row*width+col), so
  // linkAndMergeWallClimbShapes can find it.
  let ownCapTileKey = null;
  // Set when this shape's ceiling run ran straight into ANOTHER
  // wall-climb shape's cap tile (two ramps authored to form one loop).
  let continuesAtKey = null;

  if (wallTopRow !== null) {
    const wallEdgeX = dir > 0 ? (anchorX + wallCol * T) : (anchorX + (wallCol + 1) * T);
    points.push(new Vector2(wallEdgeX, anchorY + wallTopRow * T));
    // The segment this point just closed off is THE wall face — recorded
    // by index, since the slope segment after it is ALSO steep.
    wallSegIndex = points.length - 1;

    // Where the run that follows starts from: directly above the wall
    // stack, unless a slope or ceiling cap is found (just below).
    let flatCol = wallCol, flatRow = wallTopRow - 1;
    let absorbRole = 'flat'; // what the run's tiles need to classify as; "wall" once past a ceiling cap
    let absorbDir = dir;     // which way the run continues; flips (-dir) past a ceiling cap

    // One ordinary 45-degree slope tile (same column as the wall stack),
    // OR a ceilingLeft/ceilingRight cap (one column BACK toward the base
    // ramp instead).
    const capRow = wallTopRow - 1;
    const capCol = wallCol - dir;
    if (capRow >= 0) {
      const slopeGid = layer.data[capRow * width + wallCol] ?? 0;
      const slopeRole = slopeGid !== 0 ? classifyGid(tileProps, slopeGid) : 'empty';
      const ceilGid = layer.data[capRow * width + capCol] ?? 0;
      const ceilRole = ceilGid !== 0 ? classifyGid(tileProps, ceilGid) : 'empty';
      const capRole = (slopeRole === 'riseLeft' || slopeRole === 'riseRight') ? slopeRole : ceilRole;

      if (capRole === 'riseLeft' || capRole === 'riseRight') {
        // Same left/right-edge convention buildWorldSegments uses.
        claimedCells.add(capRow * width + wallCol);
        let leftRow, rightRow;
        if (capRole === 'riseLeft') { leftRow = capRow; rightRow = capRow + 1; }
        else { leftRow = capRow + 1; rightRow = capRow; }
        const leftPt = new Vector2(anchorX + wallCol * T, anchorY + leftRow * T);
        const rightPt = new Vector2(anchorX + (wallCol + 1) * T, anchorY + rightRow * T);
        if (dir > 0) {
          points.push(leftPt, rightPt);
          flatCol = wallCol + 1; flatRow = rightRow;
        } else {
          points.push(rightPt, leftPt);
          flatCol = wallCol; flatRow = leftRow;
        }
      } else if (capRole === 'ceilingLeft' || capRole === 'ceilingRight') {
        // Continues the wall PAST vertical into a ceiling. This curve's
        // center is one full tile-width off to the side, in the direction
        // the ceiling continues (opposite `dir`); both ends land exactly
        // on the cap tile's own corners.
        claimedCells.add(capRow * width + capCol);
        ownCapTileKey = capRow * width + capCol;
        const ccx = wallEdgeX - dir * T;
        const ccy = anchorY + wallTopRow * T;
        capCenter = new Vector2(ccx, ccy);
        capArcStart = points.length;
        // Continues sweeping in the SAME angular direction the base arc
        // was already sweeping — another quarter turn past thetaWall.
        for (let i = 1; i <= RAMP_ARC_SEGMENTS; i++) {
          const t = i / RAMP_ARC_SEGMENTS;
          const theta = thetaWall + (thetaWall - thetaLedge) * t;
          points.push(new Vector2(ccx + T * Math.cos(theta), ccy + T * Math.sin(theta)));
        }
        capArcEnd = points.length;

        // The ceiling material is ABOVE the walkway line now: the run's
        // own row is one above where the curve landed, tagged "wall", and
        // continues opposite the original climb direction.
        flatCol = capCol - dir; flatRow = capRow - 1;
        absorbRole = 'wall';
        absorbDir = -dir;
      }
    }

    // Absorb the run that follows, all the way to its TRUE end — this
    // shape needs to BE the complete continuation for that stretch, so
    // nothing is left for the ordinary scan to pick up separately. "flat"
    // ground is walked ON TOP of (line at the row's top edge); "wall"
    // ceiling material is walked UNDER (line at the row's bottom edge).
    if (flatRow >= 0) {
      const rowEdge = (absorbRole === 'wall') ? (flatRow + 1) : flatRow;
      if (absorbRole === 'wall') ceilingRunStart = points.length;
      let fc = flatCol;
      while (fc >= 0 && fc < width) {
        const fgid = layer.data[flatRow * width + fc] ?? 0;
        if (fgid === 0 || classifyGid(tileProps, fgid) !== absorbRole) {
          // Ceiling backing stopping here because the next tile is
          // another cap means this run reached where a second wall-climb
          // shape's cap begins — record that cap's grid position so
          // linkAndMergeWallClimbShapes can stitch the two together.
          // Checks BOTH cap families: a convex cap (archLeft/archRight)
          // sits at the SAME row as its backing (it's the tile this run
          // just broke on), a concave cap (ceilingLeft/ceilingRight) ONE
          // ROW BELOW.
          if (absorbRole === 'wall') {
            if (fgid !== 0) {
              const sameRowRole = classifyGid(tileProps, fgid);
              if (sameRowRole === 'archLeft' || sameRowRole === 'archRight') continuesAtKey = flatRow * width + fc;
            }
            if (continuesAtKey === null) {
              const belowGid = layer.data[(flatRow + 1) * width + fc];
              if (belowGid !== undefined && belowGid !== 0) {
                const belowRole = classifyGid(tileProps, belowGid);
                if (belowRole === 'ceilingLeft' || belowRole === 'ceilingRight') {
                  // First try treating that tile as a genuine END cap of
                  // THIS shape (dipping into a wall and an arch); fall back
                  // to linking whatever ramp shape owns it.
                  const descentCapRow = flatRow + 1;
                  const descent = tryDescendCeilingCapToArch(
                    layer, tileProps, width, height, anchorX, anchorY,
                    descentCapRow, fc, belowRole, points[points.length - 1]);
                  if (descent) {
                    const baseIndex = points.length;
                    for (const p of descent.points) points.push(p);
                    descentCenter1 = descent.center1;
                    descentArc1Start = baseIndex + descent.arc1Start;
                    descentArc1End = baseIndex + descent.arc1End;
                    descentWallSegIndex = baseIndex + descent.wallSegIndex;
                    descentCenter2 = descent.center2;
                    descentArc2Start = baseIndex + descent.arc2Start;
                    descentArc2End = baseIndex + descent.arc2End;
                    descentRunStart = descent.runStart != null ? (baseIndex + descent.runStart) : null;
                    descentDirCap = descent.dirCap;
                    for (const key of descent.claimed) claimedCells.add(key);
                    secondaryCapTileKey = descent.ownCapTileKey2;
                    continuesAtKey = descent.continuesAtKey;
                  } else {
                    continuesAtKey = (flatRow + 1) * width + fc;
                  }
                }
              }
            }
          }
          break;
        }
        claimedCells.add(flatRow * width + fc);
        const edgeCol = absorbDir > 0 ? (fc + 1) : fc;
        points.push(new Vector2(anchorX + edgeCol * T, anchorY + rowEdge * T));
        fc += absorbDir;
      }
    }
  }

  if (points.length < 2) return [null, claimedCells];

  const segments = [];
  for (let i = 1; i <= points.length - 1; i++) {
    const a = points[i - 1], b = points[i];
    const tangent = b.subtract(a).normalize();
    let normal;
    const isDescentArc1 = descentArc1Start !== null && i >= descentArc1Start && i < descentArc1End;
    const isDescentArc2 = descentArc2Start !== null && i >= descentArc2Start && i < descentArc2End;
    if (i <= arcSegmentCount) {
      normal = center.subtract(midpoint(a, b)).normalize();
    } else if (capArcStart !== null && i >= capArcStart && i < capArcEnd) {
      normal = capCenter.subtract(midpoint(a, b)).normalize();
    } else if (isDescentArc1) {
      normal = descentCenter1.subtract(midpoint(a, b)).normalize();
    } else if (isDescentArc2) {
      // Convex: the center sits on the material side here, so the normal
      // points AWAY from it.
      normal = midpoint(a, b).subtract(descentCenter2).normalize();
    } else if (i === descentWallSegIndex) {
      // Away from the solid wall column (on the descentDirCap side).
      normal = new Vector2(-descentDirCap, 0);
    } else if (descentRunStart !== null && i >= descentRunStart) {
      // Underside run past the arch: material above, open air below.
      normal = new Vector2(0, 1);
    } else {
      normal = new Vector2(dir * tangent.y, -dir * tangent.x);
    }
    const isCapArc = capArcStart !== null && i >= capArcStart && i < capArcEnd;
    const isCeilingRun = ceilingRunStart !== null && i >= ceilingRunStart;
    segments.push({
      a, b, tangent, normal,
      length: b.subtract(a).length(),
      isWallFace: (i === wallSegIndex) || (i === descentWallSegIndex),
      // The ceiling cap arc AND the run past it (and the descent's own
      // arcs/run) — see Player.js's isCeiling check: nothing but a curve
      // holding you up overhead.
      isCeiling: isCapArc || isCeilingRun || isDescentArc1 || isDescentArc2
        || (descentRunStart !== null && i >= descentRunStart),
    });
  }

  const shape = newShape(segments);
  shape.forceUprightJump = false;
  // ownCapTileKey lets another shape's ceiling run find and merge into
  // THIS one; continuesAtKey is the reverse. ceilingRunStartSegment marks
  // where this shape's own absorbed ceiling backing begins (segment-index
  // terms, 1-based like i above) — the part that gets discarded when this
  // shape is merged in as the "other" side of a seam.
  shape.ownCapTileKey = ownCapTileKey;
  shape.continuesAtKey = continuesAtKey;
  shape.ceilingRunStartSegment = ceilingRunStart;
  // A second position this same shape can be found by, and a marker that
  // its absorbed run is genuinely new geometry a merge partner must keep.
  shape.secondaryCapTileKey = secondaryCapTileKey;
  shape.hasDescent = secondaryCapTileKey !== null;
  // Marks this as a ramp-climb shape: no uphill penalty, no Ooomba
  // spawning on it, and the player detaches if not actively climbing.
  shape.isWallClimb = true;
  // rampLeft's wall sits to the LEFT of its ground entry, so increasing
  // arc length there means moving LEFT — Player.js flips ds for this
  // shape so "the key that visually walks you into the ramp" climbs it.
  shape.controlsReversed = dir < 0;
  return [shape, claimedCells];
}

// ---------------------------------------------------------------------
// Convex wall-climbs (crestRight/crestLeft + archRight/archLeft) — the
// outside-of-a-rounded-block counterpart to buildRampClimbShape.
// ---------------------------------------------------------------------

// A flat TOP curving DOWN into a wall (crest), optionally a straight run
// of that wall, then optionally a second curve into an underside belly
// (arch) the player walks upside-down along. Differences from the
// concave version, matching how the tile art places these pieces:
//   - The wall continues in the SAME column as the crest tile.
//   - The arch cap tile, if any, is ALSO in that same column, directly
//     below wherever the wall stack ends.
//   - A wall stack is entirely OPTIONAL.
// Every arc's normal points AWAY from its own center (the material side).
//
// dir = 1 for crestRight (wall descends to the right of the flat top),
// dir = -1 for crestLeft. Returns [shape, claimedCells].
function buildConvexClimbShape(layer, tileProps, width, height, anchorX, anchorY, col, row, dir) {
  const T = TILE_WORLD_SIZE;
  const x0 = anchorX + col * T;
  const y0 = anchorY + row * T;
  const claimedCells = new Set();

  // Base arc, inscribed in the crest tile's own box: center on the
  // BOTTOM corner nearest the wall side.
  const centerX = dir > 0 ? x0 : (x0 + T);
  const centerY = y0 + T;
  const center = new Vector2(centerX, centerY);

  const thetaLedge = -Math.PI / 2;
  const thetaWall = dir > 0 ? 0 : -Math.PI;

  const points = [];
  for (let i = 0; i <= RAMP_ARC_SEGMENTS; i++) {
    const t = i / RAMP_ARC_SEGMENTS;
    const theta = thetaLedge + (thetaWall - thetaLedge) * t;
    points.push(new Vector2(centerX + T * Math.cos(theta), centerY + T * Math.sin(theta)));
  }
  const arcSegmentCount = points.length - 1;

  // Wall stack: straight down the SAME column as the crest tile.
  const wallCol = col;
  const wallEdgeX = dir > 0 ? (x0 + T) : x0;
  let wallBottomRow = null;
  for (let r = row + 1; r < height; r++) {
    const gid = layer.data[r * width + wallCol] ?? 0;
    if (gid === 0 || classifyGid(tileProps, gid) !== 'wall') break;
    wallBottomRow = r;
    claimedCells.add(r * width + wallCol);
  }

  let wallSegIndex = null;
  if (wallBottomRow !== null) {
    points.push(new Vector2(wallEdgeX, anchorY + (wallBottomRow + 1) * T));
    wallSegIndex = points.length - 1;
  }

  // Arch cap: directly below wherever the wall search stopped.
  const capRow = wallBottomRow !== null ? (wallBottomRow + 1) : (row + 1);
  const capCol = col;

  let capCenter = null, capArcStart = null, capArcEnd = null;
  let ceilingRunStart = null;
  let ownCapTileKey = null;
  let continuesAtKey = null;

  if (capRow < height) {
    const capGid = layer.data[capRow * width + capCol] ?? 0;
    const capRole = capGid !== 0 ? classifyGid(tileProps, capGid) : 'empty';

    if (capRole === 'archRight' || capRole === 'archLeft') {
      claimedCells.add(capRow * width + capCol);
      ownCapTileKey = capRow * width + capCol;

      // Second arc, its own center — another quarter turn past thetaWall.
      const ccx = wallEdgeX - dir * T;
      const ccy = anchorY + capRow * T;
      capCenter = new Vector2(ccx, ccy);
      capArcStart = points.length;
      for (let i = 1; i <= RAMP_ARC_SEGMENTS; i++) {
        const t = i / RAMP_ARC_SEGMENTS;
        const theta = thetaWall + (thetaWall - thetaLedge) * t;
        points.push(new Vector2(ccx + T * Math.cos(theta), ccy + T * Math.sin(theta)));
      }
      capArcEnd = points.length;

      // Underside backing: continues sideways AWAY from the crest's own
      // climb direction, same row the arch tile itself sits in.
      const flatRow = capRow;
      const flatCol = capCol - dir;
      const absorbDir = -dir;
      ceilingRunStart = points.length;

      let fc = flatCol;
      while (fc >= 0 && fc < width) {
        const fgid = layer.data[flatRow * width + fc] ?? 0;
        if (fgid === 0 || classifyGid(tileProps, fgid) !== 'wall') {
          // If this run stopped because it ran into ANOTHER shape's cap,
          // record where (both cap families — see buildRampClimbShape).
          if (fgid !== 0) {
            const hitRole = classifyGid(tileProps, fgid);
            if (hitRole === 'archRight' || hitRole === 'archLeft') continuesAtKey = flatRow * width + fc;
          }
          if (continuesAtKey === null) {
            const belowGid = layer.data[(flatRow + 1) * width + fc];
            if (belowGid !== undefined && belowGid !== 0) {
              const belowRole = classifyGid(tileProps, belowGid);
              if (belowRole === 'ceilingLeft' || belowRole === 'ceilingRight') continuesAtKey = (flatRow + 1) * width + fc;
            }
          }
          break;
        }
        claimedCells.add(flatRow * width + fc);
        const edgeCol = absorbDir > 0 ? (fc + 1) : fc;
        points.push(new Vector2(anchorX + edgeCol * T, anchorY + (flatRow + 1) * T));
        fc += absorbDir;
      }
    }
  }

  if (points.length < 2) return [null, claimedCells];

  const segments = [];
  for (let i = 1; i <= points.length - 1; i++) {
    const a = points[i - 1], b = points[i];
    const tangent = b.subtract(a).normalize();
    let normal;
    if (i <= arcSegmentCount) {
      // Convex: normal points AWAY from center.
      normal = midpoint(a, b).subtract(center).normalize();
    } else if (capArcStart !== null && i >= capArcStart && i < capArcEnd) {
      normal = midpoint(a, b).subtract(capCenter).normalize();
    } else {
      // Straight segments (wall face, underside backing run).
      normal = new Vector2(dir * tangent.y, -dir * tangent.x);
    }
    const isCapArc = capArcStart !== null && i >= capArcStart && i < capArcEnd;
    const isCeilingRun = ceilingRunStart !== null && i >= ceilingRunStart;
    segments.push({
      a, b, tangent, normal,
      length: b.subtract(a).length(),
      isWallFace: i === wallSegIndex,
      isCeiling: isCapArc || isCeilingRun,
    });
  }

  const shape = newShape(segments);
  shape.forceUprightJump = false;
  shape.ownCapTileKey = ownCapTileKey;
  shape.continuesAtKey = continuesAtKey;
  shape.ceilingRunStartSegment = ceilingRunStart;
  shape.isWallClimb = true;
  shape.controlsReversed = dir < 0;
  return [shape, claimedCells];
}

// Two ramps authored to meet mid-ceiling are two separate TerrainShapes
// with a hard edge between them — reaching the end of one's arc length
// would make the player fall, instead of continuing onto the second wall
// the art promises. This splices them into one: shapeA keeps its own
// segments, and shapeB's own PRE-absorption segments (base arc, wall, cap
// arc — up to but not including its own ceiling backing run) are appended
// in REVERSE. shapeB's own absorption run is dropped: it just retraces
// ground shapeA's run already covered from the far end — unless shapeB
// hasDescent (its run turned a corner into new geometry), when it's kept.
function mergeWallClimbShapes(shapeA, shapeB) {
  const cut = shapeB.hasDescent ? (shapeB.segments.length + 1)
    : (shapeB.ceilingRunStartSegment ?? (shapeB.segments.length + 1));
  for (let i = cut - 1; i >= 1; i--) {
    const seg = shapeB.segments[i - 1];
    shapeA.segments.push({
      a: seg.b,
      b: seg.a,
      tangent: seg.tangent.clone().multiply(-1),
      normal: seg.normal,
      length: seg.length,
      isWallFace: seg.isWallFace,
      isCeiling: seg.isCeiling,
    });
  }
  shapeA.totalLength = 0;
  for (const seg of shapeA.segments) shapeA.totalLength += seg.length;
}

// Runs after every individual ramp-climb shape exists — looks up, for
// each shape whose ceiling run ran into another shape's cap, that owning
// shape, and merges them. Loops until a full pass makes no further
// merges, so chains longer than a pair work; shapeB's own cap-tile
// ownership and continuation are carried forward onto shapeA after each
// merge.
function linkAndMergeWallClimbShapes(shapes) {
  const capOwnerByKey = new Map();
  for (const shape of shapes) {
    if (shape.ownCapTileKey != null) capOwnerByKey.set(shape.ownCapTileKey, shape);
    if (shape.secondaryCapTileKey != null) capOwnerByKey.set(shape.secondaryCapTileKey, shape);
  }

  const absorbed = new Set();
  let mergedAny = true;
  while (mergedAny) {
    mergedAny = false;
    for (const shapeA of shapes) {
      if (!absorbed.has(shapeA) && shapeA.continuesAtKey != null) {
        const shapeB = capOwnerByKey.get(shapeA.continuesAtKey);
        if (shapeB && shapeB !== shapeA && !absorbed.has(shapeB)) {
          mergeWallClimbShapes(shapeA, shapeB);
          absorbed.add(shapeB);

          // Redirect anything that still thinks shapeB owns its cap tile
          // to shapeA, where its geometry now lives.
          if (shapeB.ownCapTileKey != null) capOwnerByKey.set(shapeB.ownCapTileKey, shapeA);
          if (shapeB.secondaryCapTileKey != null) capOwnerByKey.set(shapeB.secondaryCapTileKey, shapeA);

          // Carry shapeB's own continuation forward (it may itself have
          // been mid-chain).
          shapeA.continuesAtKey = shapeB.continuesAtKey;

          mergedAny = true;
        }
      }
    }
  }

  return shapes.filter((shape) => !absorbed.has(shape));
}

// Returns [shapes, claimedCells] — claimedCells merges every individual
// shape's own claimed set, for computeTopPointsByColumn.
function buildRampShapes(layer, tileProps, width, height, anchorX, anchorY) {
  let shapes = [];
  const claimedCells = new Set();
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const gid = layer.data[row * width + col] ?? 0;
      if (gid !== 0) {
        const role = classifyGid(tileProps, gid);
        const dir = role === 'rampRight' ? 1 : (role === 'rampLeft' ? -1 : null);
        const convexDir = role === 'crestRight' ? 1 : (role === 'crestLeft' ? -1 : null);
        if (dir !== null) {
          const [shape, shapeClaimed] = buildRampClimbShape(layer, tileProps, width, height, anchorX, anchorY, col, row, dir);
          if (shape) {
            shapes.push(shape);
            for (const key of shapeClaimed) claimedCells.add(key);
          }
        } else if (convexDir !== null) {
          const [shape, shapeClaimed] = buildConvexClimbShape(layer, tileProps, width, height, anchorX, anchorY, col, row, convexDir);
          if (shape) {
            shapes.push(shape);
            for (const key of shapeClaimed) claimedCells.add(key);
          }
        }
      }
    }
  }
  shapes = linkAndMergeWallClimbShapes(shapes);
  return [shapes, claimedCells];
}

// ---------------------------------------------------------------------
// WallShape — a solid axis-aligned rectangle, blocking the player from
// every side. No surface to walk along — plain circle-vs-rectangle
// collision, handled in CollisionSystem.handlePlayerWallCollisions. Just
// a plain object (pos/halfWidth/halfHeight/radius).
// ---------------------------------------------------------------------

// Scans each row for horizontal runs of "wall"-role tiles and merges each
// run into one wide rectangle. Runs are NOT merged vertically across rows
// — a stack of rectangles collides identically to one tall one.
function buildWallShapes(layer, tileProps, width, height, anchorX, anchorY) {
  const walls = [];

  const addWallRun = (row, startCol, endCol) => {
    const x0 = anchorX + startCol * TILE_WORLD_SIZE;
    const x1 = anchorX + (endCol + 1) * TILE_WORLD_SIZE;
    const y0 = anchorY + row * TILE_WORLD_SIZE;
    const y1 = anchorY + (row + 1) * TILE_WORLD_SIZE;
    const halfWidth = (x1 - x0) / 2, halfHeight = (y1 - y0) / 2;
    walls.push({
      pos: new Vector2((x0 + x1) / 2, (y0 + y1) / 2),
      halfWidth,
      halfHeight,
      radius: Math.sqrt(halfWidth * halfWidth + halfHeight * halfHeight),
      isWall: true,
    });
  };

  for (let row = 0; row < height; row++) {
    let runStartCol = null;
    for (let col = 0; col < width; col++) {
      const gid = layer.data[row * width + col] ?? 0;
      const isWallTile = gid !== 0 && classifyGid(tileProps, gid) === 'wall';
      if (isWallTile && runStartCol === null) {
        runStartCol = col;
      } else if (!isWallTile && runStartCol !== null) {
        addWallRun(row, runStartCol, col - 1);
        runStartCol = null;
      }
    }
    if (runStartCol !== null) addWallRun(row, runStartCol, width - 1);
  }

  return walls;
}

// ---------------------------------------------------------------------
// Lava — see js/world/Lava.js for the actual entity. One instance per
// lava-role tile, NOT merged (the wave is driven by absolute world X, so
// adjacent tiles already line up).
// ---------------------------------------------------------------------

function buildLavaTiles(layer, tileProps, width, height, anchorX, anchorY) {
  const lavas = [];
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const gid = layer.data[row * width + col] ?? 0;
      if (gid !== 0 && classifyGid(tileProps, gid) === 'lava') {
        lavas.push(Lava.new(anchorX + col * TILE_WORLD_SIZE, anchorY + row * TILE_WORLD_SIZE, TILE_WORLD_SIZE));
      }
    }
  }
  return lavas;
}

// ---------------------------------------------------------------------
// Whole-level renderer — baked ONCE to a single canvas.
// ---------------------------------------------------------------------

class Level {
  constructor(fields) {
    Object.assign(this, fields);
  }

  draw() {
    if (!this.canvas) return;
    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.draw(this.canvas, this.anchorX, this.anchorY);
  }
}

// ---------------------------------------------------------------------
// Depth shading — layers named Back and Middle set behind Front
// ---------------------------------------------------------------------
//
// Baked once, into the level's one canvas, back to front: a soft shadow of
// the layer in front cast onto each layer behind it — Middle's onto Back,
// then Front's onto both (offset down and a little sideways, blurred).
// Shadows are made at 1/SHADOW_DOWNSCALE size and the canvas only ever
// multiplied. And each layer darkening toward the bottom of the map (see
// GROUND_SHADE_ROWS).
const SHADOWED_LAYERS = { back: true, middle: true }; // (by name, any capitals)
const SHADOW_STRENGTH = 0.5;  // how dark the shadow of a layer in front is, at its darkest
const SHADOW_OFFSET_X = 14;   // world units: the shadow lands this far right...
const SHADOW_OFFSET_Y = 30;   // ...and this far down from what casts it
// (The same offset Bob's and the Ooombas' shadows use — see
// js/effects/CharacterShadows.js.)
TiledTerrain.SHADOW_OFFSET_X = SHADOW_OFFSET_X;
TiledTerrain.SHADOW_OFFSET_Y = SHADOW_OFFSET_Y;
const SHADOW_BLUR = 3;        // blur passes (at the shadow's reduced size)
const SHADOW_DOWNSCALE = 8;
// Each layer's tiles darkening toward the bottom of the map, over its
// bottom this-many rows — darkest right at the bottom edge. The further
// back the layer, the higher it reaches.
const GROUND_SHADE_ROWS = { front: 1, middle: 3, back: 5 };
const GROUND_SHADE_DARKNESS = 0.5; // how much darker it gets at the very bottom (0 = none, 1 = black)

// Draws tiles darkened by how near the bottom of the map they are — by
// their own pixels' height, so it's only ever the tiles' own art that
// darkens, never what shows through their clear parts.
let groundShadeShader = null;
function getGroundShadeShader() {
  if (groundShadeShader) return groundShadeShader;
  groundShadeShader = love.graphics.newShader(`
    varying float canvasY;
    #ifdef VERTEX
    vec4 position(mat4 transform_projection, vec4 vertex_position) {
      canvasY = (TransformMatrix * vertex_position).y;
      return transform_projection * vertex_position;
    }
    #endif
    #ifdef PIXEL
    extern number bottomY;   // the map's bottom edge, canvas pixels
    extern number fadeHeight; // how far up from it the darkening reaches
    extern number darkness;
    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec4 c = Texel(tex, uv) * color;
      float t = clamp((bottomY - canvasY) / fadeHeight, 0.0, 1.0); // 0 at the bottom, 1 at the top of the fade
      c.rgb *= 1.0 - darkness * (1.0 - t);
      return c;
    }
    #endif
  `);
  return groundShadeShader;
}

let blurShader = null;
function getBlurShader() {
  if (blurShader) return blurShader;
  blurShader = love.graphics.newShader(`
    extern vec2 stepUV; // one texel along the blur's direction
    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec4 sum = Texel(tex, uv) * 0.2270270;
      sum += (Texel(tex, uv + stepUV * 1.3846154) + Texel(tex, uv - stepUV * 1.3846154)) * 0.3162162;
      sum += (Texel(tex, uv + stepUV * 3.2307692) + Texel(tex, uv - stepUV * 3.2307692)) * 0.0702703;
      return sum * color;
    }
  `);
  return blurShader;
}

// Bakes the tile layers into one canvas. Lava tiles are skipped: Lava.js
// draws its own animated shader quad over that same area every frame.
function bakeLayers(tileLayers, tilesets, tileProps, width, height, img) {
  const drawLayerTiles = (l, scale, ox, oy) => {
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const gid = l.data[row * width + col] ?? 0;
        if (gid !== 0 && classifyGid(tileProps, gid) !== 'lava') {
          const ts = findTileset(tilesets, gid);
          if (ts) {
            const quad = getTileQuadForLocalIndex(img, gid - ts.firstgid, ts.columns ?? DEFAULT_TILESET_COLUMNS);
            love.graphics.draw(img, quad, ox + col * TILE_WORLD_SIZE * scale, oy + row * TILE_WORLD_SIZE * scale,
              0, TILE_SCALE * scale, TILE_SCALE * scale);
          }
        }
      }
    }
  };

  // A soft shadow of `casters` (layers in front) multiplied over
  // everything baked so far. Made small: white, with the casters'
  // silhouettes laid over it in black at SHADOW_STRENGTH (offset),
  // blurred, then stretched back up over the canvas.
  const sw = Math.ceil(width * TILE_WORLD_SIZE / SHADOW_DOWNSCALE);
  const sh = Math.ceil(height * TILE_WORLD_SIZE / SHADOW_DOWNSCALE);
  let shadowA = null, shadowB = null;
  const castShadow = (casters, onto) => {
    shadowA = shadowA ?? love.graphics.newCanvas(sw, sh);
    shadowB = shadowB ?? love.graphics.newCanvas(sw, sh);
    shadowA.setFilter('linear', 'linear');
    shadowB.setFilter('linear', 'linear');
    love.graphics.setCanvas(shadowA);
    love.graphics.clear(1, 1, 1, 1);
    love.graphics.setColor(0, 0, 0, SHADOW_STRENGTH);
    const s = 1 / SHADOW_DOWNSCALE;
    for (const l of casters) drawLayerTiles(l, s, SHADOW_OFFSET_X * s, SHADOW_OFFSET_Y * s);
    const blur = getBlurShader();
    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.setShader(blur);
    for (let n = 0; n < SHADOW_BLUR; n++) {
      love.graphics.setCanvas(shadowB);
      blur.send('stepUV', [1 / sw, 0]);
      love.graphics.draw(shadowA);
      love.graphics.setCanvas(shadowA);
      blur.send('stepUV', [0, 1 / sh]);
      love.graphics.draw(shadowB);
    }
    love.graphics.setShader();
    love.graphics.setCanvas(onto);
    love.graphics.setBlendMode('multiply', 'premultiplied');
    love.graphics.draw(shadowA, 0, 0, 0, SHADOW_DOWNSCALE, SHADOW_DOWNSCALE);
    love.graphics.setBlendMode('alpha');
  };

  const canvas = love.graphics.newCanvas(width * TILE_WORLD_SIZE, height * TILE_WORLD_SIZE);
  love.graphics.push('all');
  love.graphics.origin();
  love.graphics.setCanvas(canvas);
  love.graphics.clear(0, 0, 0, 0);
  for (let i = 0; i < tileLayers.length; i++) {
    const l = tileLayers[i];
    love.graphics.setColor(1, 1, 1, 1);
    const shadeRows = GROUND_SHADE_ROWS[String(l.name ?? '').toLowerCase()];
    if (shadeRows && shadeRows > 0) {
      const shade = getGroundShadeShader();
      shade.send('bottomY', height * TILE_WORLD_SIZE);
      shade.send('fadeHeight', shadeRows * TILE_WORLD_SIZE);
      shade.send('darkness', GROUND_SHADE_DARKNESS);
      love.graphics.setShader(shade);
    }
    drawLayerTiles(l, 1, 0, 0);
    love.graphics.setShader();
    if (SHADOWED_LAYERS[String(l.name ?? '').toLowerCase()]) {
      // The shadow of the next layer in front (only the next: one further
      // forward casts its own over this one too, when that one's done).
      const nextLayer = tileLayers[i + 1];
      if (nextLayer) castShadow([nextLayer], canvas);
    }
  }
  love.graphics.pop();
  love.graphics.setColor(1, 1, 1, 1);
  if (shadowA) { shadowA.release(); shadowB.release(); }
  return canvas;
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

  // Lava tiles.
  const lavas = buildLavaTiles(layer, tileProps, width, height, anchorX, anchorY);

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
    lavas,
    ooombaSpawns,
    sphereSpawns,
    spikeySpawns,
    mirrorSpawns,
    leverSpawns,
    crankSpawns,
    signSpawns,
    gateSpawns,
    spikeyVerticalSpawns,
    spikeyOrbitSpawns,
    sphereMoveSpawns,
    zoomWindows,
    deathZones,
    ropeSpawns,
    rockSpawns,
    canvas,
    anchorX,
    anchorY,
    // Bounding center/radius, for viewport culling (utils.isOnScreen).
    pos: new Vector2(anchorX + mapWorldWidth / 2, anchorY + mapWorldHeight / 2),
    radius: Math.sqrt(mapWorldWidth * mapWorldWidth + mapWorldHeight * mapWorldHeight) / 2,
  });
};

export default TiledTerrain;
