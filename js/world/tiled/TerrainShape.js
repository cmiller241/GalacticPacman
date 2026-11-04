// js/world/tiled/TerrainShape.js
//
// TerrainShape: one open, walkable run of flat and slope segments, and
// building them from the map's top tiles.
// Part of the Tiled level loader: see js/world/TiledTerrain.js.

import Vector2 from '../../vector2.js';
import PlanetSurface from '../PlanetSurface.js';
import { TILE_WORLD_SIZE, classifyGid, isTopRole } from './Tiles.js';

// Functions it adds to TiledTerrain (copied on in js/world/TiledTerrain.js).
const TiledTerrain = {};

const SLOPE_UPHILL_MULTIPLIER = 0.6;   // walking speed climbing a 45-degree segment; flat stays 1.0
const SLOPE_DOWNHILL_MULTIPLIER = 1.4; // walking speed descending a 45-degree segment

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

// Upright shapes (forceUprightJump — ordinary ground and slopes) keep
// him standing straight up, directly above the point he's on (see
// worldPointAtArcPosition). So the point that goes with a position near
// one is the one straight below (or above) it — not the nearest point,
// which on a slope is off to the uphill side: landing there, or working
// out his place along the shape from there, moved him up the slope
// every time he jumped and came back down.
//
// Returns [y, segment, how far along it (0..1)] for that point: of the
// segments spanning x, the one whose height there is nearest y. null if
// none spans x (past either end of the shape).
function pointStraightBelow(shape, x, y) {
  let best = null, bestDist = Infinity;
  for (const seg of shape.segments) {
    const ax = seg.a.x, bx = seg.b.x;
    const dx = bx - ax;
    if (!seg.isWallFace && Math.abs(dx) > 1e-9 && x >= Math.min(ax, bx) && x <= Math.max(ax, bx)) {
      const t = (x - ax) / dx;
      const py = seg.a.y + (seg.b.y - seg.a.y) * t;
      const d = Math.abs(y - py);
      if (d < bestDist) { bestDist = d; best = [py, seg, t]; }
    }
  }
  return best;
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
    this.refreshBounds();
  }

  nearestSurfacePoint(worldX, worldY) {
    // (The best so far kept in locals: one result object at the end, not
    // one for every closer segment found on the way.)
    let bestDist = null, bestX = 0, bestY = 0, bestNormal = null;
    for (const seg of this.segments) {
      const [, px, py, dist] = projectOntoSegment(seg, worldX, worldY);
      if (bestDist === null || dist < bestDist) {
        bestDist = dist; bestX = px; bestY = py; bestNormal = seg.normal;
      }
    }
    if (bestDist === null) return null;
    return { point: new Vector2(bestX, bestY), normal: bestNormal, distance: bestDist };
  }

  // True when (x, y) is certainly more than `reach` from every point of
  // this shape's segments — a cheap test to skip the per-segment work.
  // Uses boundX/boundY/boundRadius (see refreshBounds), which always
  // enclose every segment, unlike pos/radius, which a merged wall-climb
  // shape keeps from before its merge.
  isFartherThan(x, y, reach) {
    const dx = x - this.boundX, dy = y - this.boundY;
    const r = this.boundRadius + reach;
    return dx * dx + dy * dy > r * r;
  }

  // A circle round every segment end (and so every point of every
  // segment). Called whenever the segments change.
  refreshBounds() {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const seg of this.segments) {
      minX = Math.min(minX, seg.a.x, seg.b.x); maxX = Math.max(maxX, seg.a.x, seg.b.x);
      minY = Math.min(minY, seg.a.y, seg.b.y); maxY = Math.max(maxY, seg.a.y, seg.b.y);
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    let rSq = 0;
    for (const seg of this.segments) {
      for (const p of [seg.a, seg.b]) {
        const dx = p.x - cx, dy = p.y - cy;
        rSq = Math.max(rSq, dx * dx + dy * dy);
      }
    }
    this.boundX = cx; this.boundY = cy; this.boundRadius = Math.sqrt(rSq);
  }

  distanceToSurface(worldX, worldY) {
    return this.nearestSurfacePoint(worldX, worldY).distance;
  }

  // The planet surface interface (see js/world/PlanetSurface.js).
  // forceUprightJump shapes (ordinary ground and slopes) keep him
  // standing straight up, the way Mario doesn't tilt to a slope;
  // ramp-climb shapes (forceUprightJump = false) turn him to their surface.
  upAt(worldX, worldY) {
    if (this.forceUprightJump) return new Vector2(0, -1);
    return PlanetSurface.upFromNormal.call(this, worldX, worldY);
  }

  gravityDirAt(worldX, worldY) {
    return PlanetSurface.gravityTowardSurface.call(this, worldX, worldY);
  }

  // Open-path shapes (all of them, so far) are landing surfaces only,
  // never a gravity source of their own: a ledge would otherwise tug a
  // falling player sideways toward it like a tiny planet, instead of the
  // dome's straight-down gravity doing the rest.
  gravityDistance(worldX, worldY) {
    if (this.isOpenPath) return null;
    return PlanetSurface.gravityDistanceFromSurface.call(this, worldX, worldY);
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
    // On an upright shape, the landing point is the one straight below
    // (see pointStraightBelow). Whether and when it's a landing at all is
    // left exactly as found above.
    if (best && this.forceUprightJump) {
      const below = pointStraightBelow(this, curX, curY);
      if (below) {
        best.point.x = curX;
        best.point.y = below[0];
        best.normal = below[1].normal;
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
    // An upright shape: the place straight below the point (see
    // pointStraightBelow), when there's one.
    if (this.forceUprightJump) {
      const below = pointStraightBelow(this, worldX, worldY);
      if (below) {
        const [, seg, t] = below;
        let along = 0;
        for (const s of this.segments) {
          if (s === seg) return along + t * seg.length;
          along += s.length;
        }
      }
    }

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
    this.boundX = this.pos.x; this.boundY = this.pos.y; this.boundRadius = len / 2;
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

export { newShape, computeTopPointsByColumn, buildVertexRuns, buildWorldSegments, midpoint };
export { TiledTerrain as api };
