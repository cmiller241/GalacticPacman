// js/world/CrackedPlanetoid.js
//
// A round planetoid made of dirt: rings of dirt clods packed round a
// cracked, glowing core. Fireballs blow clods out, Terraria-style: every
// clod a shot's blast square touches is gone, so holes come out square
// and stepped. Nothing collapses — shoot sideways from the bottom of a
// hole and you dig a cave, with its roof left standing over you. The
// core itself can't be broken.
//
// Clods: ring i (0 = innermost) runs from coreRadius + i * CLOD_HEIGHT
// out to CLOD_HEIGHT further, split into as many clods as fit at about
// CLOD_LENGTH each, every other ring shifted by half a clod. Each is a
// slice of a ring (an "annular sector").
//
// Collision is against the clods themselves, so caves, overhangs and
// floating bits all work: nearestSurfacePoint finds the nearest point
// on any solid clod (or the core), and the player gets his own
// collision and walking here (collidePlayer while airborne, walkPlayer
// while standing) — lands on floors, bumps his head on ceilings, stops
// at walls and ledges (he jumps up them, the same as on the sky dome's
// Tiled levels), and walks off edges.
//
// To the rest of the game it's a non-round surface, like
// RoundedRectPlanetoid (isRoundedRect), so gravity's reach, pull
// targeting, fireball hits and so on go through nearestSurfacePoint /
// distanceToSurface / containsPoint, never through .radius. (.radius is
// the planet's full radius, which is also the furthest out it can ever
// reach, so it's still a correct bounding circle.) isCrackedPlanet asks
// for the things that treat it as round: gravity pulls toward its
// center, the player stands upright to its center and jumps straight
// out from it, and its lock-on and pull-beam outlines are circles.
//
// It can also be built from a Tiled map (CrackedPlanetoid.fromTiledMap):
// the map wraps round the planet, its top row the outermost ring and
// its bottom row sitting on the core, with every row the map's full
// width (so tiles get narrower the deeper they are). Each tile is drawn
// with its own art from the map's tileset, at TILED_SCALE times its
// size in the map — the same 2x the sky dome's Tiled levels use (see
// TiledTerrain.js's TILE_SCALE), so a 32px tile is 64 world units.
// Any tile is solid, 0 is open — tunnels and caves are just 0s in the map.
// A map's tiles can't be blown out by fireballs, unless the tileset gives
// a tile a `breakable` property set to true. A tile whose `role` is
// "water" isn't dirt at all: it's open, and starts out full of water
// (see this.waterTiles, and WaterSystem.js's "Water on a dirt planet").
// (Even "fill" tiles, which on the sky dome's levels are only decoration:
// this is solid ground you dig into.) Shaped tiles — the tileset's own
// `slope` property, the same tiles the sky dome's levels use — are solid
// only where their art is: riseRight/riseLeft below their 45-degree
// diagonal (he walks up and down those), rampRight/rampLeft below a
// concave quarter-circle that curves up into a wall, crestRight/
// crestLeft inside a convex one that curves over from a flat top down
// into a wall, and their undersides: ceilingLeft/ceilingRight (concave,
// a wall curving on up into a ceiling) and archLeft/archRight (convex, a
// wall curving under into the underside of an overhang). Running (the
// run button held), he runs all of them Sonic-style, the same as the
// sky dome's wall climbs (see walkPlayer): a ramp's curve up onto the
// wall above it, up the wall, over a crest onto the top or round a
// ceiling cap onto the ceiling, upside down along it, round an arch
// onto an overhang's underside — and the same the other way.
//
// Doesn't spin or drift (always immovable), so its local frame is just
// world space offset by pos.

import love from '../love/index.js';
import lua from '../love/lua.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import constants from '../constants.js';
import Planetoid from './Planetoid.js';
import PlanetSurface from './PlanetSurface.js';
import Particle from '../entities/Particle.js';
import CameraShake from '../effects/CameraShake.js';

const TWO_PI = Math.PI * 2;
const HALF_PI = Math.PI / 2;

// Clods, in world units: how thick each ring is, and about how long
// each clod is along its ring (each ring rounds this to fit a whole
// number of clods). (A Tiled map's own tile size is used instead for a
// planet built from one.)
const CLOD_HEIGHT = 32;
const CLOD_LENGTH = 44;

// The outline samples round the planet the halo and the caves' back
// wall are drawn from (see rebuildSilhouette).
const SILHOUETTE_SAMPLES = 512;
// (A planet built from a Tiled map gets at least this many per column,
// so the outline follows its slopes.)
const SILHOUETTE_SAMPLES_PER_COLUMN = 8;

// How big a Tiled map's tiles are in the world, as a multiple of their
// size in the map (see fromTiledMap).
const TILED_SCALE = 2;

// Walking (see walkPlayer): how far below him the ground can drop away
// while he still stays on it — only enough to keep him on it as he goes
// round (anything more is an edge, and he walks off it and falls).
const GROUND_SNAP = 6;
// How steep a slope he walks up and down: how far he can rise or drop
// for each unit he walks (1 = 45 degrees; a little over, so 45-degree
// slope tiles are always walkable, and a sheer ledge never is).
const SLOPE_CLIMB = 1.25;

// Standing room. Standing up, he's taller than his round body (his
// radius): a head circle sits on top of it, reaching about 78 units
// above his feet. A ball-tunnel is one tile — 64 units — high, so he
// only gets into one curled up as a ball (about 48 units), and can't
// uncurl inside it (see Player.exitBallMode). Checked when he walks or
// runs somewhere new (only if he has room where he is now, so he's never
// stuck), and pushed out of ceilings in the air (see collidePlayer).
const HEAD_OFFSET = 26;  // the head circle's center, above his own center
const HEAD_RADIUS = 22;

// Wall-running (see walkPlayer). The tile shapes he can run onto a wall
// from, or over the top of one, at a run...
const CURVE_SHAPES = {
  rampRight: true, rampLeft: true, crestRight: true, crestLeft: true,
  ceilingRight: true, ceilingLeft: true, archRight: true, archLeft: true,
};
// ...how much the surface may turn under him in one step on one of
// them (as a cosine — anything sharper is a corner, not a curve)...
const CLIMB_MAX_TURN_COS = Math.cos(35 * Math.PI / 180);
// ...and anywhere else (a wall's face is straight, so only a hair —
// what's left over where a curve's outline meets it; a plain sharp
// corner turns far more than this, and stops him or throws him off).
const CLIMB_STRAIGHT_TURN_COS = Math.cos(9 * Math.PI / 180);
// He's back on level ground, and walks normally again, once the ground
// under him is this close to flat (as a cosine).
const LEVEL_DOT = 0.95;
// How many straight pieces a curved tile's outline is made of.
const CURVE_SEGMENTS = 12;
// How steep a surface can be (as the cosine of its angle from straight
// up) and still count as floor he lands on, rather than a wall he
// slides down or a ceiling he bumps.
const FLOOR_DOT = 0.55;
// How near (beyond his own radius) solid ground has to be under him for
// him to still be standing on it.
const GROUND_SLACK = 3;
// How far he's lifted straight out, at most, if he's ended up sunk a
// little into the ground (see settlePlayer).
const SETTLE_MAX = 4;

// A shot's blast: a square, lined up with the way the shot was going,
// starting at the point it hit. Every clod any part of it overlaps is
// blown out. BLAST_REACH is how far in from the hit point it goes,
// BLAST_HALF_WIDTH how far either side of the shot's line. It's laid
// out along the planet's rings rather than in a straight line, so a
// shot fired level along the ground digs a level tunnel instead of one
// that drifts up toward the surface the further it goes.
const BLAST_REACH = 50;
const BLAST_HALF_WIDTH = 26;
const BLAST_SAMPLE_STEP = 6; // how finely the square is sampled for overlapping clods
// A shot this close to level with the ground (or to straight down or
// up), as the sine of its angle off it, digs exactly level (or exactly
// straight). A fireball flies straight while the ground curves away
// under it, so one fired level along a tunnel is slightly off level by
// the time it hits; without this, tunnels would creep up a ring.
const BLAST_SNAP = 0.38;

// The core's cracks (glowing, seen wherever the dirt is gone).
const CORE_CRACKS = 9;
const CRACK_STEP = 12;

// Thrown-off dirt clumps.
const MAX_CHUNKS_PER_HIT = 40;
const CHUNK_GRAVITY = 0.09;   // per frame, toward the planet's center
// Turning (N clockwise, M counter-clockwise — see toggleSpin): one
// turn in this many seconds.
const SPIN_SECONDS_PER_TURN = 120;
const CHUNK_BOUNCE = 0.3;     // fraction of its speed into the ground it keeps, bounced back out
const CHUNK_FRICTION = 0.7;   // sideways speed kept on each bounce
const CHUNK_LIFE_MIN = 110;
const CHUNK_LIFE_RANGE = 80;
const CHUNK_FADE = 30;        // frames at the end of its life it fades out over
const DUST_PER_CLOD = 2;

const HIT_SHAKE_STRENGTH = 6;
const HIT_SHAKE_SECONDS = 0.18;

// The baked body canvas's resolution, as a multiple of world units
// (same 2x Planetoid.js uses).
const BAKE_SCALE = 2;
const GLOW_LAYERS = 18; // the halo's layers (see bake)

// The look. Dirt's own color is the planet's `color`; these are the
// rest of it.
const SEAM_ALPHA = 0.16;        // the faint line between two clods
const EDGE_ALPHA = 0.5;         // the darker rim wherever a clod faces open air
const BACK_WALL_SHADE = 0.32;   // how dark a dug-out cave's back wall is, as a fraction of the dirt's color
const CORE_TINT = [0.7, 0.42, 0.34];
const CRACK_DARK = [0.06, 0.03, 0.02, 0.95];
const CRACK_GLOW = [1.0, 0.55, 0.18, 0.95];

const normalizeAngle = (a) => lua.mod(a, TWO_PI);

// Tiled stores a tile flipped or turned by setting the top three bits
// of its number; this is the number without them. (The very top one is
// "flipped left to right".)
const TILED_GID_MASK = 2 ** 29;
const TILED_FLIP_X = 2 ** 31;

// The shaped tiles, each as the outline of its solid part across the
// tile — u from 0 at its left edge to 1 at its right (in the map), v
// from 0 at its bottom to 1 at its top — and how high that solid part
// reaches at each u. (TiledTerrain's own conventions for the same tiles:
// a ramp's quarter-circle is centered on its top corner on the ledge
// side, a crest's on its bottom corner on the wall side, a ceiling cap's
// on its bottom corner on the ceiling side, an arch's on its top corner
// on the underside's side.)
function quarterArc(cu, cv, fromAngle, toAngle) {
  const points = [];
  for (let s = 0; s <= CURVE_SEGMENTS; s++) {
    const t = fromAngle + (toAngle - fromAngle) * s / CURVE_SEGMENTS;
    points.push([cu + Math.cos(t), cv + Math.sin(t)]);
  }
  return points;
}
const withCorners = (before, arc, after) => [...before, ...arc, ...after];
const SHAPED_TILES = {
  riseRight: { outline: [[0, 0], [1, 0], [1, 1]], top: (u) => u },
  riseLeft: { outline: [[0, 0], [1, 0], [0, 1]], top: (u) => 1 - u },
  rampRight: { // floor at its bottom-left, curving up to a wall at its right
    outline: withCorners([[0, 0], [1, 0]], quarterArc(0, 1, 0, -HALF_PI), []),
    top: (u) => 1 - Math.sqrt(Math.max(0, 1 - u * u)),
  },
  rampLeft: {
    outline: withCorners([[0, 0]], quarterArc(1, 1, -HALF_PI, -Math.PI), []),
    top: (u) => 1 - Math.sqrt(Math.max(0, 1 - (1 - u) ** 2)),
  },
  crestRight: { // flat top at its left, curving down to a wall at its right
    outline: withCorners([[0, 0]], quarterArc(0, 0, 0, HALF_PI), []),
    top: (u) => Math.sqrt(Math.max(0, 1 - u * u)),
  },
  crestLeft: {
    outline: withCorners([[1, 0]], quarterArc(1, 0, HALF_PI, Math.PI), []),
    top: (u) => Math.sqrt(Math.max(0, 1 - (1 - u) ** 2)),
  },
  // The undersides. (All four reach the tile's top all the way across,
  // so `top` is 1.)
  ceilingLeft: { // a wall at its right curving up into a ceiling running left
    outline: withCorners([[1, 0], [1, 1]], quarterArc(0, 0, HALF_PI, 0), []),
    top: () => 1,
  },
  ceilingRight: {
    outline: withCorners([[0, 0], [0, 1]], quarterArc(1, 0, HALF_PI, Math.PI), []),
    top: () => 1,
  },
  archRight: { // a wall at its left curving under into an underside running right
    outline: withCorners([[1, 1]], quarterArc(1, 1, Math.PI, 1.5 * Math.PI), []),
    top: () => 1,
  },
  archLeft: {
    outline: withCorners([[0, 1]], quarterArc(0, 1, -HALF_PI, 0), []),
    top: () => 1,
  },
};

// Ball tunnels: the tiles that go round the curves above, one tile
// inside or outside them, so a tunnel one tile high (just enough for him
// curled up as a ball — see Player's standing-room rule and
// standingRoomAt) keeps its height all the way round a bend.
//
//   *Inner (4): a solid tile with one corner rounded off (half a tile's
//   radius), for the INSIDE of the bend round a ramp or ceiling cap —
//   the tile diagonally inside the curve:
//     rampRightInner    up and to the left of a rampRight
//     rampLeftInner     up and to the right of a rampLeft
//     ceilingLeftInner  down and to the left of a ceilingLeft
//     ceilingRightInner down and to the right of a ceilingRight
//
//   *Outer1/2/3 (12): the big curve (two tiles' radius) round the
//   OUTSIDE of a crest or arch — three tiles each, going round from its
//   flat side to its wall side:
//     crestRightOuter1 above the crest, 2 above and to the right, 3 to its right
//     crestLeftOuter1  above the crest, 2 above and to the left,  3 to its left
//     archRightOuter1  below the arch,  2 below and to the left,  3 to its left
//     archLeftOuter1   below the arch,  2 below and to the right, 3 to its right
//
// Each is built from one base piece (rampRightInner, crestRightOuter*),
// mirrored left-right and/or top-bottom. (Port of the same block in
// lua/world/CrackedPlanetoid.lua.)
{
  const arc = (cu, cv, r, from, to, out) => {
    for (let s = 0; s <= CURVE_SEGMENTS; s++) {
      const t = from + (to - from) * s / CURVE_SEGMENTS;
      out.push([cu + Math.cos(t) * r, cv + Math.sin(t) * r]);
    }
    return out;
  };
  const mirrored = (points, flipU, flipV) =>
    points.map((p) => [flipU ? 1 - p[0] : p[0], flipV ? 1 - p[1] : p[1]]);
  const pointIn = (points, u, v) => {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i], b = points[j];
      if ((a[1] > v) !== (b[1] > v) && u < (b[0] - a[0]) * (v - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  };
  // How high the solid reaches in column u (null: none in that column).
  const topOf = (points) => (u) => {
    u = Math.min(0.999, Math.max(0.001, u));
    for (let k = 64; k >= 0; k--) {
      if (pointIn(points, u, k / 64)) return k / 64;
    }
    return null;
  };
  const add = (name, points) => {
    SHAPED_TILES[name] = { outline: points, top: topOf(points), tunnel: true };
  };

  const R3 = Math.sqrt(3) - 1; // where a two-tile circle crosses a tile edge
  // Base pieces: the corner up-left of a rampRight, and the outside of a
  // crestRight (a circle of radius 2 round the crest's own center).
  const inner = arc(0.5, 0.5, 0.5, -HALF_PI, 0, [[0, 0]]);
  inner.push([1, 1], [0, 1]);
  const outer = [
    arc(0, -1, 2, HALF_PI, Math.PI / 3, []),              // 1: above the crest
    arc(-1, -1, 2, Math.PI / 3, Math.PI / 6, []),         // 2: above and beside
    arc(-1, 0, 2, Math.PI / 6, 0, []),                    // 3: beside its wall
  ];
  outer[0].push([1, 1]);
  outer[1].push([1, 0], [1, 1], [0, 1]);
  outer[2].push([1, 1]);
  console.assert(Math.abs(outer[0][outer[0].length - 2][1] - R3) < 1e-6);

  add('rampRightInner', inner);
  add('rampLeftInner', mirrored(inner, true, false));
  add('ceilingLeftInner', mirrored(inner, false, true));
  add('ceilingRightInner', mirrored(inner, true, true));
  for (let k = 1; k <= 3; k++) {
    add('crestRightOuter' + k, outer[k - 1]);
    add('crestLeftOuter' + k, mirrored(outer[k - 1], true, false));
    add('archRightOuter' + k, mirrored(outer[k - 1], true, true));
    add('archLeftOuter' + k, mirrored(outer[k - 1], false, true));
    // (Round on the tunnel's side, like a ramp: he runs them Sonic-style.)
    CURVE_SHAPES['crestRightOuter' + k] = true;
    CURVE_SHAPES['crestLeftOuter' + k] = true;
    CURVE_SHAPES['archRightOuter' + k] = true;
    CURVE_SHAPES['archLeftOuter' + k] = true;
  }
  for (const name of ['rampRightInner', 'rampLeftInner', 'ceilingLeftInner', 'ceilingRightInner']) {
    CURVE_SHAPES[name] = true;
  }
}

// Which clod of ring `ring` covers angle a (0-based).
// A local point (world-aligned, from the planet's center) turned into
// the planet's own frame, and back (see the constructor's rotationAngle).
function toFrame(self, lx, ly) {
  const a = self.rotationAngle;
  if (a === 0) return [lx, ly];
  const c = Math.cos(a), s = Math.sin(a);
  return [lx * c + ly * s, -lx * s + ly * c];
}

function fromFrame(self, fx, fy) {
  const a = self.rotationAngle;
  if (a === 0) return [fx, fy];
  const c = Math.cos(a), s = Math.sin(a);
  return [fx * c - fy * s, fx * s + fy * c];
}

function clodIndexAt(ring, a) {
  return Math.floor(normalizeAngle(a - ring.offset) / ring.step) % ring.count;
}

// Clod j of ring `ring`'s angles: [start, end].
function clodAngles(ring, j) {
  const a0 = ring.offset + j * ring.step;
  return [a0, a0 + ring.step];
}

// A shaped tile's outline, bent round onto clod j of ring `ring`, as
// local points [x1, y1, x2, y2, ...]. (Straight between its points,
// though the tile's own edges curve with the ring — at a Tiled planet's
// size, the difference is under a pixel.)
function shapeOutline(ring, j, shape) {
  const a0 = ring.offset + j * ring.step;
  const points = [];
  for (const p of SHAPED_TILES[shape].outline) {
    const a = a0 + p[0] * ring.step;
    const r = ring.inner + p[1] * (ring.outer - ring.inner);
    points.push(Math.cos(a) * r, Math.sin(a) * r);
  }
  return points;
}

// Which of the map's tilesets tile number `gid` comes from: the one with
// the highest firstgid that's still no higher than it.
function tilesetForGid(tilesets, gid) {
  let best = null;
  for (const ts of tilesets) {
    if (ts.firstgid <= gid && (!best || ts.firstgid > best.firstgid)) best = ts;
  }
  return best;
}

// Whether local point (lx, ly) is inside outline [x1, y1, ...] (the
// usual even-odd crossing count — it works for the ramps' hollowed-out
// outlines as well as the rest).
function insideOutline(outline, lx, ly) {
  let inside = false;
  const n = outline.length;
  let jx = outline[n - 2], jy = outline[n - 1];
  for (let k = 0; k < n; k += 2) {
    const ix = outline[k], iy = outline[k + 1];
    if ((iy > ly) !== (jy > ly) && lx < (jx - ix) * (ly - iy) / (jy - iy) + ix) inside = !inside;
    jx = ix; jy = iy;
  }
  return inside;
}

// The nearest point on clod j of ring `ring` (a ring slice) to local
// point (lx, ly), whose own polar coordinates are (r, a): [x, y,
// squared distance] — or null if the point's inside it.
function nearestOnClod(ring, j, lx, ly, r, a) {
  const a0 = ring.offset + j * ring.step;
  const delta = normalizeAngle(a - a0);
  if (delta <= ring.step) {
    // Within its angles: straight in or out to its inner or outer arc.
    if (r < ring.inner) {
      const s = ring.inner / r;
      return [lx * s, ly * s, (ring.inner - r) ** 2];
    } else if (r > ring.outer) {
      const s = ring.outer / r;
      return [lx * s, ly * s, (r - ring.outer) ** 2];
    }
    return null;
  }
  // Off to one side: the nearer of its two straight edges.
  const edge = (delta - ring.step < TWO_PI - delta) ? a0 + ring.step : a0;
  const ux = Math.cos(edge), uy = Math.sin(edge);
  let t = lx * ux + ly * uy;
  if (t < ring.inner) t = ring.inner; else if (t > ring.outer) t = ring.outer;
  const qx = ux * t, qy = uy * t;
  return [qx, qy, (lx - qx) ** 2 + (ly - qy) ** 2];
}

// The nearest point on segment (ax, ay)-(bx, by) to (px, py): [x, y,
// squared distance].
function nearestOnSegment(ax, ay, bx, by, px, py) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 1e-12) {
    t = ((px - ax) * dx + (py - ay) * dy) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
  }
  const qx = ax + dx * t, qy = ay + dy * t;
  return [qx, qy, (px - qx) ** 2 + (py - qy) ** 2];
}

// The same as nearestOnClod, for a shaped tile: the nearest point on
// its outline (see shapeOutline) — or null if the point's inside it.
function nearestOnOutline(outline, lx, ly) {
  if (insideOutline(outline, lx, ly)) return null;
  const n = outline.length;
  let best = [0, 0, Infinity];
  for (let k = 0; k < n; k += 2) {
    const k2 = (k + 2) % n;
    const q = nearestOnSegment(outline[k], outline[k + 1], outline[k2], outline[k2 + 1], lx, ly);
    if (q[2] < best[2]) best = q;
  }
  return best;
}

// How close to straight up (see CrackedPlanetoid.upAtLocal) local normal
// (nx, ny) is at local point (lx, ly) (1 = a level floor, 0 = a wall,
// -1 = a ceiling).
function upness(self, nx, ny, lx, ly) {
  const [ux, uy] = self.upAtLocal(lx, ly);
  return nx * ux + ny * uy;
}

// While he's running along a wall (see walkPlayer), the surface he's
// on: player.climbNormal (its outward normal, local), player.climbPlanet
// (this planet) and player.climbDir (which way he's running: 1
// clockwise, -1 the other way), and player.climbCurved (whether that
// surface was a curve tile's, last step). All null the rest of the time.
function stopClimbing(player) {
  player.climbNormal = null; player.climbPlanet = null; player.climbDir = null; player.climbCurved = null;
}

function blocked(player) {
  player.isWalking = false;
  player.groundMoveSpeedX = 0;
}

// A fan of triangles from the center out to `count` points round a
// circle, each radiusOf(index) out, textured with the shared
// planetTexture the way Planetoid.js lays it.
function fanVertices(count, radiusOf, texSize, color) {
  const vertices = [[0, 0, 0.5, 0.5, color[0], color[1], color[2], 1]];
  for (let k = 0; k <= count; k++) {
    const a = k / count * TWO_PI;
    const r = radiusOf(k % count);
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    vertices.push([x, y, 0.5 + x / texSize, 0.5 + y / texSize, color[0], color[1], color[2], 1]);
  }
  return vertices;
}

// ---------------------------------------------------------------------
// Redrawing only what's changed
// ---------------------------------------------------------------------
//
// A full bake of a big planet takes ~100 ms (thousands of clods, edges
// and tiles): a stutter on every hit. So after the first one, bake()
// compares the planet with what the last bake drew (rememberBake) and
// redraws only a box round the difference (changedArea): cleared, then
// everything that touches it drawn again in the usual order, clipped to
// it. The pixels come out the same as a full bake's.

// Room round a clod's or crack's box for the lines drawn along its edges.
const BOX_MARGIN = 4;

// A box [minX, minY, maxX, maxY] in the planet's own frame, grown to take
// in (x, y) (a new one when box is null).
function growBox(box, x, y) {
  if (!box) return [x, y, x, y];
  if (x < box[0]) box[0] = x;
  if (y < box[1]) box[1] = y;
  if (x > box[2]) box[2] = x;
  if (y > box[3]) box[3] = y;
  return box;
}

function padBox(box, by) {
  box[0] -= by; box[1] -= by; box[2] += by; box[3] += by;
  return box;
}

const boxesTouch = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

// A clod's slice of its ring, as a box (worked out once: the rings never
// move or change shape).
function clodBox(ring, j) {
  ring.boxes = ring.boxes ?? [];
  let box = ring.boxes[j];
  if (box) return box;
  box = null;
  const [a0, a1] = clodAngles(ring, j);
  for (let s = 0; s <= 2; s++) {
    const a = a0 + (a1 - a0) * s / 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    box = growBox(box, ca * ring.inner, sa * ring.inner);
    box = growBox(box, ca * ring.outer, sa * ring.outer);
  }
  box = padBox(box, BOX_MARGIN);
  ring.boxes[j] = box;
  return box;
}

function crackBox(crack) {
  if (crack.box) return crack.box;
  let box = null;
  for (let p = 0; p + 1 < crack.points.length; p += 2) box = growBox(box, crack.points[p], crack.points[p + 1]);
  crack.box = padBox(box ?? [0, 0, 0, 0], crack.width + BOX_MARGIN);
  return crack.box;
}

// One fan vertex (see fanVertices): the k-th point round, radius r.
function fanVertex(k, count, r, texSize) {
  const a = k / count * TWO_PI;
  const x = Math.cos(a) * r, y = Math.sin(a) * r;
  return [x, y, 0.5 + x / texSize, 0.5 + y / texSize];
}

// One ring slice (from radius rIn to rOut, angle a0 to a1) filled, as a
// strip of four-sided pieces short enough to look curved.
function fillSector(rIn, rOut, a0, a1) {
  const segs = Math.max(2, Math.ceil((a1 - a0) * rOut / 10));
  for (let s = 0; s < segs; s++) {
    const b0 = a0 + (a1 - a0) * s / segs;
    const b1 = a0 + (a1 - a0) * (s + 1) / segs;
    const c0 = Math.cos(b0), s0 = Math.sin(b0), c1 = Math.cos(b1), s1 = Math.sin(b1);
    love.graphics.polygon('fill',
      c0 * rIn, s0 * rIn, c1 * rIn, s1 * rIn, c1 * rOut, s1 * rOut, c0 * rOut, s0 * rOut);
  }
}

// An arc at radius r from angle a0 to a1, as a line, drawn only where
// show(angle) says (null: all of it) — for a clod edge that's open air
// along only part of its length.
function arcLine(r, a0, a1, show) {
  const segs = Math.max(2, Math.ceil((a1 - a0) * r / 6));
  let points = [];
  const flush = () => {
    if (points.length >= 4) love.graphics.line(points);
    points = [];
  };
  for (let s = 0; s < segs; s++) {
    const b0 = a0 + (a1 - a0) * s / segs;
    const b1 = a0 + (a1 - a0) * (s + 1) / segs;
    if (!show || show((b0 + b1) / 2)) {
      if (points.length === 0) points.push(Math.cos(b0) * r, Math.sin(b0) * r);
      points.push(Math.cos(b1) * r, Math.sin(b1) * r);
    } else {
      flush();
    }
  }
  flush();
}

function radialLine(a, rIn, rOut) {
  const c = Math.cos(a), s = Math.sin(a);
  love.graphics.line(c * rIn, s * rIn, c * rOut, s * rOut);
}

const TILE_PIECES = 3; // (see drawTiles)

// The obsidian and ice blocks' art (see setBlock), each loaded the first
// time one's drawn.
const blockImages = new Map();
function getBlockImage(clod) {
  const path = clod.obsidian ? 'img/obsidian.png' : clod.ice ? 'img/ice.png' : null;
  if (!path) return null;
  if (!blockImages.has(path)) {
    const image = love.graphics.newImage(path);
    image.setFilter('nearest', 'nearest');
    blockImages.set(path, image);
  }
  return blockImages.get(path);
}

class CrackedPlanetoid {
  // The setup both ways of building one share, before its rings are
  // filled in (see CrackedPlanetoid.new and fromTiledMap).
  constructor(x, y, coreRadius, radius, clodHeight, color) {
    this.clodHeight = clodHeight;
    this.pos = new Vector2(x, y);
    this.coreRadius = coreRadius;
    this.radius = radius;
    this.mass = radius * radius;
    this.influenceRadius = radius + constants.INFLUENCE_PADDING;
    this.color = color ?? [0.52, 0.36, 0.24, 1];
    this.vel = new Vector2(0, 0);

    this.isImmovable = true;
    this.isPermanent = true;
    this.isSpawnExclusion = true;
    this.isSpikey = false;
    this.isRoundedRect = true;
    this.isCrackedPlanet = true;
    // CollisionSystem.handleImmovableCollisions reads this for every
    // isRoundedRect immovable (only to compare against, for the sky
    // dome's own top), so it has to be a number.
    this.halfHeight = radius;
    this.rings = [];
    this.silhouetteSamples = SILHOUETTE_SAMPLES;
    // Which way things fall here (G switches it — see cycleGravity):
    // 'core' (toward the center), 'down' or 'up' (straight down or up
    // the screen, the same everywhere round the planet).
    this.gravityMode = 'core';
    // How far it's turned (radians, clockwise — see toggleSpin), and
    // which way it's turning (spinDir: 1 clockwise, -1 counter-clockwise,
    // 0 not at all). Everything about the dirt is kept as it was
    // made, unturned (its "frame"): the queries below turn the point
    // asked about into that frame (see toFrame), and drawing turns the
    // picture. (PortalGun reads rotationAngle too, so portals on it turn
    // with it.)
    this.rotationAngle = 0;
    this.spinDir = 0;
  }

  // ...and the rest, once they are.
  finish() {
    this.silhouette = new Float64Array(this.silhouetteSamples);
    this.coreCracks = [];
    this.seedCoreCracks();
    this.chunks = [];

    this.coreMesh = null;
    this.backWallMesh = null;
    this.glowMeshes = [];
    this.tileMeshes = [];
    this.bodyCanvas = null;
    this.bodyCanvasPadding = Planetoid.SHADOW_PADDING;
    this.needsBake = true;
    this.eclipseMesh = null;

    this.rebuildSilhouette();
    return this;
  }

  // x, y: world center. coreRadius: the unbreakable core's radius.
  // layers: how many rings of clods round it. color: [r,g,b,a] 0..1, the
  // dirt's color.
  static new(x, y, coreRadius, layers, color) {
    const self = new CrackedPlanetoid(x, y, coreRadius, coreRadius + layers * CLOD_HEIGHT, CLOD_HEIGHT, color);
    for (let i = 0; i < layers; i++) {
      const inner = coreRadius + i * CLOD_HEIGHT;
      const mid = inner + CLOD_HEIGHT / 2;
      const count = Math.max(6, Math.floor(TWO_PI * mid / CLOD_LENGTH + 0.5));
      const step = TWO_PI / count;
      const ring = {
        inner, outer: inner + CLOD_HEIGHT, mid, count, step,
        offset: (i % 2 === 1) ? step / 2 : 0, // every other ring shifted half a clod
        clods: [],
      };
      for (let j = 0; j < count; j++) ring.clods[j] = self.newClod();
      self.rings.push(ring);
    }
    return self.finish();
  }

  // The radius a planet built from Tiled map `map` will have: the map's
  // full width, at its world size, round the outside.
  static tiledMapRadius(map) {
    return map.width * map.tilewidth * TILED_SCALE / TWO_PI;
  }

  // x, y: world center. map: a Tiled map converted for the web build
  // (js/levels/Level2.js, say); its first tile layer is wrapped round the
  // planet, column 0 starting at the very top and the columns going
  // clockwise, so the map reads left to right walking right across the
  // top. The planet's size comes from the map: its full width round the
  // outside (see tiledMapRadius), its rows deep, and whatever's left
  // inside them is the core. color: [r,g,b,a], for the back wall of
  // dug-out caves and the dirt thrown off.
  static fromTiledMap(x, y, map, color) {
    const layer = map.layers.find((l) => l.type === 'tilelayer');
    if (!layer) throw new Error('CrackedPlanetoid.fromTiledMap: the map has no tile layer');
    const w = layer.width, h = layer.height;
    const tileH = map.tileheight * TILED_SCALE;
    const radius = CrackedPlanetoid.tiledMapRadius(map);
    const coreRadius = radius - h * tileH;
    if (!(coreRadius > tileH)) {
      throw new Error('CrackedPlanetoid.fromTiledMap: the map is too deep for how wide it is '
        + '(its rows would reach past the center) - make it wider or shallower');
    }

    const self = new CrackedPlanetoid(x, y, coreRadius, radius, tileH, color);
    self.isTiled = true;
    self.silhouetteSamples = Math.max(SILHOUETTE_SAMPLES, w * SILHOUETTE_SAMPLES_PER_COLUMN);
    self.loadTilesets(map.tilesets);

    // Each tile number's shape (see SHAPED_TILES; null for a whole tile),
    // from its tileset's own `slope` property, and whether a fireball can
    // blow it out: only if its tileset gives it a `breakable` property set
    // to true — a map's tiles are solid ground that stays put otherwise.
    // (And its role: "water" and "lava" tiles aren't dirt — see below.)
    const shapeOfGid = new Map();
    const shapeFor = (gid) => {
      if (!shapeOfGid.has(gid)) {
        let shape = null, breakable = false, role = null;
        const ts = tilesetForGid(map.tilesets, gid);
        for (const tile of (ts && ts.tiles) || []) {
          if (tile.id === gid - ts.firstgid) {
            const props = tile.properties || {};
            if (SHAPED_TILES[props.slope]) shape = props.slope;
            breakable = props.breakable === true || props.breakable === 'true';
            role = props.role || null;
          }
        }
        shapeOfGid.set(gid, [shape, breakable, role]);
      }
      return shapeOfGid.get(gid);
    };

    // Where the map's water tiles are: { ring: i, j } each — open space,
    // filled with water when the planet's water grid is made.
    self.waterTiles = [];
    // And its lava tiles, the same way: open space, filled with lava when
    // the grid's made (it flows like the water — see WaterSystem.js), as
    // { ring, j, full (more lava on top of it) }.
    const lavaAt = new Set(); // "i,j"
    const lavaTiles = [];

    const step = TWO_PI / w;
    for (let i = 0; i < h; i++) {
      const row = h - 1 - i; // (the map's own row, from 0 at its top: the top row is the outermost ring)
      const inner = coreRadius + i * tileH;
      const ring = {
        inner, outer: inner + tileH, mid: inner + tileH / 2,
        count: w, step, offset: -Math.PI / 2,
        clods: [],
      };
      for (let j = 0; j < w; j++) {
        const raw = layer.data[row * w + j] || 0;
        const gid = raw % TILED_GID_MASK;
        if (gid !== 0) {
          const flipX = Math.floor(raw / TILED_FLIP_X) % 2 === 1;
          let [shape, breakable, role] = shapeFor(gid);
          if (role === 'water') {
            self.waterTiles.push({ ring: i, j });
            ring.clods[j] = null;
          } else if (role === 'lava') {
            lavaAt.add(`${i},${j}`);
            lavaTiles.push({ ring: i, j });
            ring.clods[j] = null;
          } else {
            // (A shaped tile flipped left to right faces the other way.)
            if (shape && flipX) {
              shape = shape.includes('Right') ? shape.replace('Right', 'Left') : shape.replace('Left', 'Right');
            }
            const clod = { gid, shade: 1, shape, flipX, breakable };
            if (shape) clod.outline = shapeOutline(ring, j, shape);
            ring.clods[j] = clod;
          }
        } else {
          ring.clods[j] = null;
        }
      }
      self.rings.push(ring);
    }

    // (Every ring of a map has the same number of tiles, so the tile on
    // top of tile j is tile j of the next ring out: full, if it's lava too.)
    for (const t of lavaTiles) t.full = lavaAt.has(`${t.ring + 1},${t.j}`);
    self.lavaTiles = lavaTiles;

    // Things placed on the map's object layers (an Ooomba, say — see
    // main.js, which spawns them): each { class, lx, ly, properties },
    // where it was placed, wrapped round the planet the same way as the
    // tiles — in the planet's own frame, from its center. (Across the map
    // is round the planet from its top, clockwise; down the map is in
    // toward the core.)
    self.objectSpawns = [];
    const mapPixelsAround = w * map.tilewidth;
    for (const l of map.layers) {
      if (l.type !== 'objectgroup') continue;
      for (const obj of l.objects ?? []) {
        const a = -Math.PI / 2 + (obj.x / mapPixelsAround) * TWO_PI;
        const r = radius - (obj.y / map.tileheight) * tileH;
        self.objectSpawns.push({
          class: obj.class ?? obj.type, lx: Math.cos(a) * r, ly: Math.sin(a) * r, properties: obj.properties ?? {},
        });
      }
    }
    return self.finish();
  }

  // The map's tilesets: where each one's tiles are in its image, and the
  // image itself (each loaded once, however many tilesets share it; its
  // path is written relative to tiled/, where the map lives — the image
  // has to be in js/assetList.js, which `npm run assets` builds from the
  // maps' tilesets).
  loadTilesets(tilesets) {
    this.tilesets = [];
    const images = new Map();
    for (const ts of tilesets) {
      const entry = {
        firstgid: ts.firstgid, columns: ts.columns,
        tileW: ts.tilewidth, tileH: ts.tileheight,
        imageW: ts.imagewidth, imageH: ts.imageheight, image: null,
      };
      if (ts.image) {
        const path = ts.image.startsWith('../') ? ts.image.slice(3) : 'tiled/' + ts.image;
        if (!images.has(path)) {
          const image = love.graphics.newImage(path);
          image.setFilter('nearest', 'nearest');
          images.set(path, image);
        }
        entry.image = images.get(path);
        entry.imageW = entry.image.getWidth();
        entry.imageH = entry.image.getHeight();
      }
      this.tilesets.push(entry);
    }
  }

  // A clod's own look, picked once: a slightly different shade from its
  // neighbors, and a few pebbles (each { along, out, size, light }: where
  // it sits across and up the clod, 0..1, its radius, and whether it's a
  // light or a dark one).
  newClod() {
    const pebbles = [];
    const n = 2 + Math.floor(Math.random() * 3);
    for (let p = 0; p < n; p++) {
      pebbles.push({
        along: 0.15 + Math.random() * 0.7, out: 0.2 + Math.random() * 0.6,
        size: 1.5 + Math.random() * 2.5, light: Math.random() < 0.4,
      });
    }
    return { shade: 0.9 + Math.random() * 0.16, pebbles, lump: Math.random() * TWO_PI, breakable: true };
  }

  // ----------------------------------------------------------------
  // Clods
  // ----------------------------------------------------------------

  // The clod [ring index, clod index] at local point (lx, ly), or null.
  clodAtLocal(lx, ly) {
    [lx, ly] = toFrame(this, lx, ly);
    const r = Math.sqrt(lx * lx + ly * ly);
    if (r < this.coreRadius || r >= this.radius) return null;
    const i = Math.floor((r - this.coreRadius) / this.clodHeight);
    const ring = this.rings[i];
    if (!ring) return null;
    const j = clodIndexAt(ring, Math.atan2(ly, lx));
    const clod = ring.clods[j];
    if (!clod) return null;
    if (clod.outline && !insideOutline(clod.outline, lx, ly)) return null; // (outside a shaped tile's solid part: open)
    return [i, j];
  }

  // How high a shaped tile's solid part reaches at angle a, as a fraction
  // of the tile's height.
  shapeTopFraction(ring, j, shape, a) {
    const a0 = ring.offset + j * ring.step;
    let u = normalizeAngle(a - a0) / ring.step;
    if (u > 1) u = 1;
    return SHAPED_TILES[shape].top(u);
  }

  // How far out ring i's solid reaches at angle a: its outside, a slope's
  // diagonal, or null where it's open.
  solidTopInRing(i, a) {
    const ring = this.rings[i];
    const j = clodIndexAt(ring, a);
    const clod = ring.clods[j];
    if (!clod) return null;
    if (clod.shape) {
      // (null: this column of a ball-tunnel piece is all open.)
      const top = this.shapeTopFraction(ring, j, clod.shape, a);
      return top == null ? null : ring.inner + top * (ring.outer - ring.inner);
    }
    return ring.outer;
  }

  // Whether ring i has solid at angle a (ring -1 is the core: always).
  solidInRing(i, a) {
    if (i < 0) return true;
    const ring = this.rings[i];
    if (!ring) return false;
    return !!ring.clods[clodIndexAt(ring, a)];
  }

  solidAtLocal(lx, ly) {
    if (lx * lx + ly * ly < this.coreRadius * this.coreRadius) return true;
    return this.clodAtLocal(lx, ly) !== null;
  }

  // At each sample angle, how far out the dirt reaches (its outermost
  // clod there, caves underneath or not): the outline the halo hugs and
  // the caves' back wall fills.
  rebuildSilhouette() {
    const n = this.silhouetteSamples;
    for (let k = 0; k < n; k++) {
      const a = k / n * TWO_PI;
      let h = this.coreRadius;
      for (let i = this.rings.length - 1; i >= 0; i--) {
        const top = this.solidTopInRing(i, a);
        if (top !== null) { h = top; break; }
      }
      this.silhouette[k] = h;
    }
    this.needsBake = true;
  }

  // How far out the dirt reaches at angle a.
  silhouetteAt(a) {
    const n = this.silhouetteSamples;
    return this.silhouette[Math.floor(normalizeAngle(a) / TWO_PI * n) % n];
  }

  // ----------------------------------------------------------------
  // Surface geometry: the nearest point on the solid dirt (clods and
  // core) to a point.
  // ----------------------------------------------------------------

  // The nearest point on solid dirt to local point (lx, ly), looking no
  // further than `reach` past where it already is (anything further only
  // comes in as the core's own edge): [x, y, squared distance, whether
  // the point is inside the dirt (then the rest is meaningless), the
  // clod that nearest point is on (null for the core)].
  nearestSolidLocal(lx, ly, reach) {
    const [fx, fy] = toFrame(this, lx, ly);
    const hit = this.nearestSolidInFrame(fx, fy, reach);
    if (hit[3]) return hit;
    const [qx, qy] = fromFrame(this, hit[0], hit[1]);
    return [qx, qy, hit[2], false, hit[4]];
  }

  // (The same, with the point and the answer in the planet's own frame.)
  nearestSolidInFrame(lx, ly, reach) {
    const r = Math.sqrt(lx * lx + ly * ly);
    if (r < this.coreRadius) return [0, 0, 0, true, null];
    const a = Math.atan2(ly, lx);
    let bestX, bestY, bestD2, bestClod = null;
    if (r > 1e-9) {
      const s = this.coreRadius / r;
      bestX = lx * s; bestY = ly * s; bestD2 = (r - this.coreRadius) ** 2;
    } else {
      bestX = this.coreRadius; bestY = 0; bestD2 = this.coreRadius ** 2;
    }

    for (const ring of this.rings) {
      if (ring.inner - reach <= r && r <= ring.outer + reach) {
        const halfSpan = reach / Math.max(ring.inner, 1) + ring.step;
        const n = Math.min(ring.count, Math.ceil(2 * halfSpan / ring.step) + 1);
        let j = clodIndexAt(ring, a - halfSpan);
        for (let m = 0; m < n; m++) {
          const clod = ring.clods[j];
          if (clod) {
            const hit = clod.outline ? nearestOnOutline(clod.outline, lx, ly) : nearestOnClod(ring, j, lx, ly, r, a);
            if (hit === null) return [0, 0, 0, true, clod];
            if (hit[2] < bestD2) { bestX = hit[0]; bestY = hit[1]; bestD2 = hit[2]; bestClod = clod; }
          }
          j = (j + 1) % ring.count;
        }
      }
    }
    return [bestX, bestY, bestD2, false, bestClod];
  }

  // How much room there is round local point (lx, ly): its distance to
  // the nearest solid dirt (0 inside it), looking about `reach` round.
  clearanceLocal(lx, ly, reach) {
    const [, , d2, inside] = this.nearestSolidLocal(lx, ly, reach);
    return inside ? 0 : Math.sqrt(d2);
  }

  // From a point inside the dirt: the first open spot straight out from
  // the center (the top of whatever it's buried in), as [x, y, ux, uy].
  escapeOutward(lx, ly) {
    const r = Math.sqrt(lx * lx + ly * ly);
    let ux = 1, uy = 0;
    if (r > 1e-9) { ux = lx / r; uy = ly / r; }
    const a = Math.atan2(uy, ux) - this.rotationAngle; // (in its own frame)
    let top = this.coreRadius;
    for (let i = 0; i < this.rings.length; i++) {
      const ring = this.rings[i];
      if (ring.outer > r) {
        top = Math.max(top, ring.inner);
        if (!this.solidInRing(i, a)) break;
        top = ring.outer;
      }
    }
    return [ux * top, uy * top, ux, uy];
  }

  nearestSurfacePoint(worldX, worldY) {
    const lx = worldX - this.pos.x, ly = worldY - this.pos.y;
    const r = Math.sqrt(lx * lx + ly * ly);
    const reach = Math.max(0, r - this.radius) + 96;
    const [qx, qy, d2, inside] = this.nearestSolidLocal(lx, ly, reach);
    if (inside) {
      const [ex, ey, ux, uy] = this.escapeOutward(lx, ly);
      return { point: new Vector2(this.pos.x + ex, this.pos.y + ey), normal: new Vector2(ux, uy), distance: 0 };
    }
    const d = Math.sqrt(d2);
    let nx, ny;
    if (d > 1e-6) { nx = (lx - qx) / d; ny = (ly - qy) / d; }
    else { nx = r > 1e-9 ? lx / r : 1; ny = r > 1e-9 ? ly / r : 0; }
    return { point: new Vector2(this.pos.x + qx, this.pos.y + qy), normal: new Vector2(nx, ny), distance: d };
  }

  // True when a circle at (x, y) reaching this far can't touch the planet:
  // nothing solid lies at or beyond this.radius (see solidAtLocal). The
  // collision passes skip their surface search for such pairs.
  isFartherThan(x, y, reach) {
    const dx = x - this.pos.x, dy = y - this.pos.y;
    const r = this.radius + reach;
    return dx * dx + dy * dy > r * r;
  }

  // 0 inside the dirt. Gravity asks this of every planet for every falling
  // thing, every frame, so anything well clear of the planet gets a cheap
  // answer from its center instead (anything further than
  // INFLUENCE_PADDING is out of its reach either way).
  distanceToSurface(worldX, worldY) {
    const lx = worldX - this.pos.x, ly = worldY - this.pos.y;
    const far = Math.sqrt(lx * lx + ly * ly) - this.radius;
    if (far > constants.INFLUENCE_PADDING + 50) return far;
    return this.clearanceLocal(lx, ly, Math.max(0, far) + 96);
  }

  containsPoint(worldX, worldY) {
    return this.solidAtLocal(worldX - this.pos.x, worldY - this.pos.y);
  }

  // The isRoundedRect "position along the surface" methods, for anything
  // generic that asks (a cannon dropping him here, say). He doesn't walk
  // by them here (see walkPlayer), so they're just an angle round the
  // planet's outline, as a distance at its full radius.
  getPerimeter() {
    return TWO_PI * this.radius;
  }

  arcPositionForWorldPoint(worldX, worldY) {
    return normalizeAngle(Math.atan2(worldY - this.pos.y, worldX - this.pos.x)) * this.radius;
  }

  worldPointAtArcPosition(s, pushDistance = 0) {
    const a = s / this.radius;
    const ux = Math.cos(a), uy = Math.sin(a);
    const r = this.silhouetteAt(a - this.rotationAngle) + pushDistance;
    return { point: new Vector2(this.pos.x + ux * r, this.pos.y + uy * r), normal: new Vector2(ux, uy) };
  }

  // ----------------------------------------------------------------
  // Gravity modes
  // ----------------------------------------------------------------

  // "Up" at local point (lx, ly), as a unit vector [x, y]: straight out
  // from the center (core), or straight up or down the screen.
  upAtLocal(lx, ly) {
    const mode = this.gravityMode;
    if (mode === 'down') return [0, -1];
    if (mode === 'up') return [0, 1];
    const r = Math.sqrt(lx * lx + ly * ly);
    if (r < 1e-6) return [0, -1];
    return [lx / r, ly / r];
  }

  // The planet surface interface (see js/world/PlanetSurface.js). "Up"
  // here is away from this planet's gravity, which can be switched (see
  // cycleGravity) — not off whichever brick edge is nearest: its bricky
  // ground is all steps, so things stay upright to the way it pulls.
  upAt(wx, wy) {
    const [ux, uy] = this.upAtLocal(wx - this.pos.x, wy - this.pos.y);
    return new Vector2(ux, uy);
  }

  // Which way gravity pulls at a world point (a unit Vector2).
  gravityDirAt(wx, wy) {
    const [ux, uy] = this.upAtLocal(wx - this.pos.x, wy - this.pos.y);
    return new Vector2(-ux, -uy);
  }

  // Core -> Down -> Up -> Core. If he's standing on this planet, he lets
  // go of it, to fall the new way.
  cycleGravity() {
    const modes = CrackedPlanetoid.GRAVITY_MODES;
    const k = Math.max(0, modes.indexOf(this.gravityMode));
    this.gravityMode = modes[(k + 1) % modes.length];
    const player = state.player;
    if (player && player.currentPlanet === this) {
      stopClimbing(player);
      player.onSurface = false;
      player.currentPlanet = null;
      player.lastInfluencePlanet = this;
      player.vel = new Vector2(0, 0);
    }
    return this.gravityMode;
  }

  // ----------------------------------------------------------------
  // The player
  // ----------------------------------------------------------------

  // Off the surface he was running along: airborne, carrying (vx, vy).
  leaveSurface(player, vx, vy) {
    stopClimbing(player);
    player.onSurface = false;
    player.currentPlanet = null;
    player.lastInfluencePlanet = this;
    player.vel = new Vector2(vx, vy);
  }

  // Whether a standing head over local point (lx, ly), "up" being
  // (ux, uy), is clear of the dirt (see HEAD_OFFSET).
  headFreeLocal(lx, ly, ux, uy) {
    return this.clearanceLocal(lx + ux * HEAD_OFFSET, ly + uy * HEAD_OFFSET, HEAD_RADIUS + 8) >= HEAD_RADIUS - 0.5;
  }

  // Whether he has room to stand up where he is (curled up now — see
  // Player.exitBallMode): his full-size body, feet where the ball's
  // bottom is, and his head on top.
  standingRoomAt(player) {
    const lx = player.pos.x - this.pos.x, ly = player.pos.y - this.pos.y;
    let [ux, uy] = this.upAtLocal(lx, ly);
    if (player.climbNormal && player.climbPlanet === this) { ux = player.climbNormal.x; uy = player.climbNormal.y; }
    const full = player.baseRadius ?? player.radius;
    const rise = player.onSurface ? Math.max(0, full - player.radius) : 0;
    const cx = lx + ux * rise, cy = ly + uy * rise;
    return this.clearanceLocal(cx, cy, full + 8) >= full - 0.5 && this.headFreeLocal(cx, cy, ux, uy);
  }

  // Airborne: pushes him out of any dirt he's run into — off walls, down
  // from ceilings (losing the speed he had into them) — and lands him on
  // anything floor-like he comes down on. Called from
  // CollisionSystem.tryLandOnPlanet in place of its own landing; returns
  // whether he landed.
  collidePlayer(player) {
    const pr = player.radius;
    let lx = player.pos.x - this.pos.x, ly = player.pos.y - this.pos.y;
    if (lx * lx + ly * ly > (this.radius + pr + 10) ** 2) return false;

    let landed = false;
    for (let iter = 0; iter < 3; iter++) {
      const [qx, qy, d2, inside] = this.nearestSolidLocal(lx, ly, pr + 8);
      if (inside) {
        // Buried (dirt can't appear round him, so only by being thrown in
        // hard): out on top of it.
        const [ex, ey, ux, uy] = this.escapeOutward(lx, ly);
        lx = ex + ux * pr; ly = ey + uy * pr;
        landed = true;
        break;
      }
      const d = Math.sqrt(d2);
      if (d >= pr || d < 1e-6) break;
      const nx = (lx - qx) / d, ny = (ly - qy) / d;
      lx += nx * (pr - d); ly += ny * (pr - d);

      const into = player.vel.x * nx + player.vel.y * ny;
      if (upness(this, nx, ny, lx, ly) > FLOOR_DOT && into <= 0.5) {
        landed = true;
      } else if (into < 0) {
        player.vel.x -= nx * into;
        player.vel.y -= ny * into;
      }
    }

    // Standing (not a ball), his head too: out from under a ceiling or a
    // tunnel's mouth he doesn't fit into, losing the speed he had into it.
    if (!player.isBall) {
      const [ux, uy] = this.upAtLocal(lx, ly);
      for (let iter = 0; iter < 2; iter++) {
        const hx = lx + ux * HEAD_OFFSET, hy = ly + uy * HEAD_OFFSET;
        const [qx, qy, d2, inside] = this.nearestSolidLocal(hx, hy, HEAD_RADIUS + 8);
        if (inside) break;
        const d = Math.sqrt(d2);
        if (d >= HEAD_RADIUS || d < 1e-6) break;
        const nx = (hx - qx) / d, ny = (hy - qy) / d;
        lx += nx * (HEAD_RADIUS - d); ly += ny * (HEAD_RADIUS - d);
        const into = player.vel.x * nx + player.vel.y * ny;
        if (into < 0) {
          player.vel.x -= nx * into;
          player.vel.y -= ny * into;
        }
      }
    }

    player.pos.x = this.pos.x + lx; player.pos.y = this.pos.y + ly;
    if (landed) {
      stopClimbing(player);
      this.settlePlayer(player);
      player.onSurface = true;
      player.currentPlanet = this;
      player.lastInfluencePlanet = this;
      player.surfaceArcPos = this.arcPositionForWorldPoint(player.pos.x, player.pos.y);
      player.vel = new Vector2(0, 0);
      player.isGroundPounding = false;
    }
    return landed;
  }

  // Standing: walks him `ds` (world units, + is clockwise on screen) round
  // the planet, along the ground he's on — up and down slopes as steep as
  // SLOPE_CLIMB. Stops at anything steeper in his way — a wall, or a ledge
  // even one tile high (he jumps up those) — and walks off an edge and
  // falls. Called from Player.move in place of its own surface walking.
  //
  // Running (the run button, or rolled up as a ball), he can also run
  // walls, the way the sky dome's wall climbs work: once he's on a curve
  // tile (CURVE_SHAPES), he follows the surface itself (see
  // runAlongSurface) — up a ramp's curve onto the wall above it, up the
  // wall, over a crest onto the top, round a ceiling cap and along the
  // ceiling, and so on — until he's on level ground again. On a wall or
  // ceiling, stopping, letting go of run or turning back peels him off it.
  walkPlayer(player, ds) {
    const running = state.gamepadRunHeld || player.isBall;
    if (player.climbPlanet !== this) stopClimbing(player);

    if (player.climbNormal) {
      const lx = player.pos.x - this.pos.x, ly = player.pos.y - this.pos.y;
      const n = player.climbNormal;
      const dir = ds > 0 ? 1 : (ds < 0 ? -1 : 0);
      const steep = upness(this, n.x, n.y, lx, ly) < FLOOR_DOT;
      if (steep && (dir === 0 || !running || (player.climbDir && dir !== player.climbDir))) {
        const push = player.wallClimbDetachPush ?? 3;
        this.leaveSurface(player, n.x * push, n.y * push);
        return;
      }
      if (dir === 0) return;
      if (running) {
        player.climbDir = dir;
        this.runAlongSurface(player, ds);
        return;
      }
      stopClimbing(player); // (stopped running somewhere floor-like: walks normally)
    }

    if (ds === 0) return;
    this.settlePlayer(player);
    const pr = player.radius;
    const lx = player.pos.x - this.pos.x, ly = player.pos.y - this.pos.y;
    const r = Math.sqrt(lx * lx + ly * ly);
    if (r < 1e-6) return;

    // Running onto a curve tile's curve: from here, he follows it.
    if (running) {
      const [qx, qy, d2, inside, clod] = this.nearestSolidLocal(lx, ly, pr + 8);
      const d = Math.sqrt(d2);
      if (!inside && clod && CURVE_SHAPES[clod.shape] && d < pr + GROUND_SNAP && d > 1e-6) {
        player.climbNormal = { x: (lx - qx) / d, y: (ly - qy) / d };
        player.climbPlanet = this;
        player.climbDir = ds > 0 ? 1 : -1;
        player.climbCurved = true;
        this.runAlongSurface(player, ds);
        return;
      }
    }

    const climb = Math.abs(ds) * SLOPE_CLIMB + 1;
    const reach = pr + GROUND_SNAP + climb + 8;
    // Standing, his head has to fit too (see headFreeLocal) — as long as
    // it does where he is now (so he's never stuck somewhere low).
    const checkHead = !player.isBall && this.headFreeLocal(lx, ly, ...this.upAtLocal(lx, ly));
    const free = (x, y) => {
      if (this.clearanceLocal(x, y, reach) < pr - 0.5) return false;
      if (checkHead) return this.headFreeLocal(x, y, ...this.upAtLocal(x, y));
      return true;
    };

    // Round the planet at the same height first (or, when gravity's
    // straight down or up the screen, straight along it).
    let ux, uy, nx, ny;
    if (this.gravityMode === 'down' || this.gravityMode === 'up') {
      [ux, uy] = this.upAtLocal(lx, ly);
      nx = lx - uy * ds; ny = ly + ux * ds;
    } else {
      const a = Math.atan2(ly, lx) + ds / r;
      ux = Math.cos(a); uy = Math.sin(a);
      nx = ux * r; ny = uy * r;
    }

    if (!free(nx, ny)) {
      // Something's in the way: up it, if it's a slope he can walk up (by
      // as little as gets him clear) — otherwise he stays put.
      let lifted = false;
      for (let hgt = 0.5; hgt <= climb; hgt += 0.5) {
        if (free(nx + ux * hgt, ny + uy * hgt)) {
          nx += ux * hgt; ny += uy * hgt; lifted = true;
          break;
        }
      }
      if (!lifted) { blocked(player); return; }
    }

    // Down onto the ground: in 4-unit steps to find it, then halved in
    // to rest right on it.
    const step = 4;
    let drop = 0, found = false;
    while (drop < GROUND_SNAP + climb) {
      if (!free(nx - ux * (drop + step), ny - uy * (drop + step))) { found = true; break; }
      drop += step;
    }
    if (found) {
      let lo = drop, hi = drop + step;
      for (let k = 0; k < 5; k++) {
        const mid = (lo + hi) / 2;
        if (free(nx - ux * mid, ny - uy * mid)) lo = mid; else hi = mid;
      }
      nx -= ux * lo; ny -= uy * lo;
      player.pos.x = this.pos.x + nx; player.pos.y = this.pos.y + ny;
    } else {
      // Walked off an edge: on he goes, falling, carrying his pace.
      player.pos.x = this.pos.x + nx; player.pos.y = this.pos.y + ny;
      const carry = ds * (player.edgeFallCarryFraction ?? 0.5);
      this.leaveSurface(player, -uy * carry, ux * carry);
    }
  }

  // Wall-running: moves him `ds` along the surface he's on (its tangent,
  // the way he's running), then back onto it — pressed against it along
  // its own normal, whichever way that points. A curve tile's surface may
  // turn under him (up to CLIMB_MAX_TURN_COS a step), and so may the step
  // where he comes off one onto what it leads to (the wall a ramp curves
  // up into, the top a crest curves over onto — he's touching that
  // corner while his feet are still on the curve); anywhere else it may
  // barely turn at all, so a plain sharp corner either stops him (one he'd
  // run into) or throws him off it (one he'd run over the edge of). Back on
  // level ground, he walks normally again.
  runAlongSurface(player, ds) {
    const pr = player.radius;
    const lx = player.pos.x - this.pos.x, ly = player.pos.y - this.pos.y;
    const n = player.climbNormal;
    // (Clockwise along a surface with outward normal n is (-n.y, n.x) —
    // on level ground, the same way walking right goes.)
    const tx = -n.y, ty = n.x;
    const cx = lx + tx * ds, cy = ly + ty * ds;
    const [qx, qy, d2, inside, clod] = this.nearestSolidLocal(cx, cy, pr + Math.abs(ds) * 2 + 16);
    if (inside) { blocked(player); return; }
    const d = Math.sqrt(d2);

    const launch = () => {
      player.pos.x = this.pos.x + cx; player.pos.y = this.pos.y + cy;
      this.leaveSurface(player, tx * ds, ty * ds);
    };
    if (d > pr + Math.abs(ds) + GROUND_SNAP || d < 1e-6) { launch(); return; }

    let mx = (cx - qx) / d, my = (cy - qy) / d;
    const turn = mx * n.x + my * n.y;
    let curved = !!(clod && CURVE_SHAPES[clod.shape]);
    const mayTurn = curved || player.climbCurved;
    // (Turning INTO a curve — a ramp or a ceiling cap — he can take any
    // bend: deep down, where the tiles are narrower, a curve can be
    // tighter than he is wide, and he touches both its ends at once.)
    const intoCurve = mayTurn && d <= pr;
    if (turn < (mayTurn ? CLIMB_MAX_TURN_COS : CLIMB_STRAIGHT_TURN_COS) && !intoCurve) {
      // A corner, not a curve.
      if (d > pr) launch(); else blocked(player);
      return;
    }

    // Onto the surface, pressed against it — and pushed out of anything
    // else he's now touching too (both sides of a curve tighter than he
    // is wide), the way a ball rolls through a tight corner.
    let px = qx + mx * pr, py = qy + my * pr;
    for (let k = 0; k < 4; k++) {
      const [q2x, q2y, e2, inside2] = this.nearestSolidLocal(px, py, pr + 8);
      if (inside2) { blocked(player); return; }
      const e = Math.sqrt(e2);
      if (e >= pr - 0.25 || e < 1e-6) break;
      px += (px - q2x) / e * (pr - e); py += (py - q2y) / e * (pr - e);
    }
    if (this.clearanceLocal(px, py, pr + 8) < pr - 0.5) { blocked(player); return; }
    // Standing, his head has to fit there too (see headFreeLocal), if it
    // does where he is now.
    if (!player.isBall && this.headFreeLocal(lx, ly, n.x, n.y) && !this.headFreeLocal(px, py, mx, my)) {
      blocked(player); return;
    }
    // (And it has to have got him somewhere: wedged, he stays put.)
    const progress = ((px - lx) * tx + (py - ly) * ty) * (ds > 0 ? 1 : -1);
    if (progress < 0.05 * Math.abs(ds)) { blocked(player); return; }
    // The surface he's on now is whatever's nearest him there.
    {
      const [fx, fy, f2, , fclod] = this.nearestSolidLocal(px, py, pr + 8);
      const f = Math.sqrt(f2);
      if (f > 1e-6) { mx = (px - fx) / f; my = (py - fy) / f; }
      curved = !!(fclod && CURVE_SHAPES[fclod.shape]);
    }
    player.pos.x = this.pos.x + px; player.pos.y = this.pos.y + py;
    player.climbNormal = { x: mx, y: my };
    player.climbCurved = curved;
    if (!curved && upness(this, mx, my, px, py) > LEVEL_DOT) stopClimbing(player);
  }

  // If he's sunk a fraction into the ground (pushed out of it to within a
  // hair, then nudged back by something else), lifts him straight out —
  // off the wall he's running along, if he is — until he's clear;
  // otherwise walking would take the ground he's standing in for a wall,
  // and stop him dead.
  settlePlayer(player) {
    const pr = player.radius;
    const lx = player.pos.x - this.pos.x, ly = player.pos.y - this.pos.y;
    let [ux, uy] = this.upAtLocal(lx, ly);
    if (player.climbNormal && player.climbPlanet === this) { ux = player.climbNormal.x; uy = player.climbNormal.y; }
    let lift = 0;
    while (lift < SETTLE_MAX && this.clearanceLocal(lx + ux * lift, ly + uy * lift, pr + 8) < pr - 0.25) lift += 0.25;
    if (lift > 0 && lift < SETTLE_MAX) {
      player.pos.x = this.pos.x + lx + ux * lift; player.pos.y = this.pos.y + ly + uy * lift;
    }
  }

  // The dirt just changed: if he's standing on this planet (or running
  // along one of its walls) and the ground under him is gone, he falls.
  refitPlayer() {
    const player = state.player;
    if (!(player && player.onSurface && player.currentPlanet === this)) return;
    const lx = player.pos.x - this.pos.x, ly = player.pos.y - this.pos.y;
    let [ux, uy] = this.upAtLocal(lx, ly);
    if (player.climbNormal && player.climbPlanet === this) { ux = player.climbNormal.x; uy = player.climbNormal.y; }
    const below = GROUND_SLACK + constants.SURFACE_TOLERANCE;
    if (this.clearanceLocal(lx - ux * below, ly - uy * below, player.radius + 8) >= player.radius - 0.5) {
      this.leaveSurface(player, 0, 0);
    }
  }

  // ----------------------------------------------------------------
  // Obsidian
  // ----------------------------------------------------------------

  // Which tile [ring index, tile index] local point (lx, ly) is in —
  // whether there's anything in it or not — or null if it's outside the
  // rings (in the core, or past the outermost ring).
  // The ground under a point (fx, fy) in its own frame (see objectSpawns):
  // how far out from the center its top is, straight down from there
  // toward the center — or null if there's nothing under it but the core.
  floorBelow(fx, fy) {
    let r = Math.sqrt(fx * fx + fy * fy);
    if (r < 1e-6) return null;
    const ux = fx / r, uy = fy / r;
    const a = this.rotationAngle;
    const c = Math.cos(a), s = Math.sin(a);
    const solid = (rr) => {
      const x = ux * rr, y = uy * rr;
      return this.solidAtLocal(x * c - y * s, x * s + y * c);
    };
    // (Out of anything it's buried in first, then down to the ground.)
    while (r < this.radius && solid(r)) r += 2;
    while (r > this.coreRadius) {
      if (solid(r - 1)) return r;
      r -= 2;
    }
    return this.coreRadius;
  }

  // A path for something to walk round the planet along ground whose top
  // is radius R out (an Ooomba — see Ooomba.newOnCrackedPlanet), in the
  // same shape as a TerrainShape (getPerimeter, worldPointAtArcPosition),
  // arc position s going clockwise round from the planet's own angle 0 (in
  // its frame — it turns with the planet). canWalkTo says whether the next
  // step's clear: ground under its leading edge, and nothing in the way of
  // its body — so it turns round at a wall, a drop or a gap, the way one
  // on the level turns at the end of its ledge.
  floorPath(R) {
    const planet = this;
    const solidAt = (angle, r) => {
      const a = angle + planet.rotationAngle;
      return planet.solidAtLocal(Math.cos(a) * r, Math.sin(a) * r);
    };
    return {
      crackedPlanet: this,
      isLoop: true,
      radius: R,
      getPerimeter: () => TWO_PI * R,
      worldPointAtArcPosition: (s, offset) => {
        const a = s / R + planet.rotationAngle;
        const nx = Math.cos(a), ny = Math.sin(a);
        return {
          point: new Vector2(planet.pos.x + nx * (R + offset), planet.pos.y + ny * (R + offset)),
          normal: new Vector2(nx, ny),
        };
      },
      canWalkTo: (s, dir, halfWidth, halfHeight) => {
        const lead = s / R + dir * halfWidth / R;
        return solidAt(lead, R - 4) && !solidAt(lead, R + 4) && !solidAt(lead, R + halfHeight)
          && !solidAt(lead, R + halfHeight * 1.8);
      },
    };
  }

  // (See tileAtLocal, just below.)
  // Whether the ground right under him is an ice tile (see setBlock): he
  // slides on it (see Player.move).
  iceUnder(player) {
    const lx = player.pos.x - this.pos.x, ly = player.pos.y - this.pos.y;
    let [ux, uy] = this.upAtLocal(lx, ly);
    if (player.climbNormal && player.climbPlanet === this) { ux = player.climbNormal.x; uy = player.climbNormal.y; }
    const d = player.radius + 6;
    const ij = this.clodAtLocal(lx - ux * d, ly - uy * d);
    return !!ij && this.rings[ij[0]].clods[ij[1]].ice === true;
  }

  tileAtLocal(lx, ly) {
    [lx, ly] = toFrame(this, lx, ly);
    const r = Math.sqrt(lx * lx + ly * ly);
    if (r < this.coreRadius || r >= this.radius) return null;
    const i = Math.floor((r - this.coreRadius) / this.clodHeight);
    const ring = this.rings[i];
    if (!ring) return null;
    return [i, clodIndexAt(ring, Math.atan2(ly, lx))];
  }

  // Ring i's tile j made an obsidian block (on), or the block taken away
  // (not on). Lava meeting water makes them, and a fireball melts them
  // back — see WaterSystem.js's "Lava meeting water: obsidian", which
  // plays Lava.js's effect over it each way. A block is ordinary solid
  // ground: walked on, bumped into from below, like any other tile.
  setObsidian(i, j, on) {
    this.setBlock(i, j, on ? 'obsidian' : null);
  }

  // Ring i's tile j made a block of `kind` — 'obsidian' (see setObsidian)
  // or 'ice' (an ice block — see WaterSystem.js's "Ice": slippery to walk
  // on, see iceUnder) — or, with kind null, the block taken away.
  setBlock(i, j, kind) {
    const on = kind != null;
    const ring = this.rings[i];
    ring.clods[j] = on ? { obsidian: kind === 'obsidian', ice: kind === 'ice', shade: 1, breakable: false } : null;
    // (For the water and lava on it: the cells there fill in, or open up
    // — see WaterSystem.js's catchUpPlanetGrid.)
    this.dirtChanges = this.dirtChanges || [];
    this.dirtChanges.push({ ring: i, j });
    this.rebuildSilhouette();

    // Made while he's in it: he's lifted out on top of it.
    const player = state.player;
    if (on && player) {
      const [a0, a1] = clodAngles(ring, j);
      const [fx, fy] = toFrame(this, player.pos.x - this.pos.x, player.pos.y - this.pos.y);
      const r = Math.sqrt(fx * fx + fy * fy);
      const pr = player.radius;
      if (r > 1e-6 && r < ring.outer + pr && r > ring.inner - pr) {
        const a = Math.atan2(fy, fx);
        const slack = pr / r; // (his radius, as an angle)
        const da = normalizeAngle(a - a0 + slack);
        if (da < a1 - a0 + 2 * slack) {
          const out = ring.outer + pr + 1;
          const [wx, wy] = fromFrame(this, Math.cos(a) * out, Math.sin(a) * out);
          player.pos.x = this.pos.x + wx; player.pos.y = this.pos.y + wy;
        }
      }
    }
    this.refitPlayer();
  }

  // ----------------------------------------------------------------
  // The core's cracks
  // ----------------------------------------------------------------

  // Grows one crack from local (x, y) heading `angle`, wandering a little
  // each step, sometimes splitting off a thinner branch.
  growCrack(x, y, angle, length, width, branchesLeft) {
    const points = [x, y];
    const steps = Math.max(2, Math.floor(length / CRACK_STEP));
    let cx = x, cy = y, a = angle;
    for (let i = 0; i < steps; i++) {
      a += (Math.random() - 0.5) * 0.8;
      const step = CRACK_STEP * (0.7 + Math.random() * 0.6);
      cx += Math.cos(a) * step;
      cy += Math.sin(a) * step;
      points.push(cx, cy);
      if (branchesLeft > 0 && Math.random() < 0.15) {
        const side = Math.random() < 0.5 ? -1 : 1;
        this.growCrack(cx, cy, a + side * (0.5 + Math.random() * 0.7),
          length * (0.3 + Math.random() * 0.3), width * 0.6, branchesLeft - 1);
      }
    }
    this.coreCracks.push({ points, width });
  }

  seedCoreCracks() {
    const r = this.coreRadius;
    for (let i = 0; i < CORE_CRACKS; i++) {
      const a = Math.random() * TWO_PI;
      const inward = a + Math.PI + (Math.random() - 0.5) * 0.9;
      this.growCrack(Math.cos(a) * r * 1.02, Math.sin(a) * r * 1.02, inward,
        r * (0.5 + Math.random() * 0.5), 3 + Math.random() * 2, 2);
    }
  }

  // ----------------------------------------------------------------
  // Getting hit
  // ----------------------------------------------------------------

  // A fireball hit the dirt at world (x, y), going (vx, vy): blow out
  // every clod the blast square in front of it touches and throw them off
  // as clumps. Works from any side — from inside a hole or a cave just as
  // well as from above. Called from main.js's fireball-vs-planetoid pass.
  // With no velocity it blasts straight down toward the center.
  takeHit(worldX, worldY, vx, vy) {
    const hx = worldX - this.pos.x, hy = worldY - this.pos.y;
    let dx = vx ?? 0, dy = vy ?? 0;
    let len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-6) {
      dx = -hx; dy = -hy; len = Math.sqrt(hx * hx + hy * hy);
      if (len < 1e-6) return;
    }
    dx /= len; dy /= len;

    // The shot's direction split into out-from-the-center and
    // round-the-planet parts at the hit point; the square is stepped out
    // in those (as height and as distance round the ring) from there.
    const hr = Math.sqrt(hx * hx + hy * hy);
    if (hr < 1e-6) return;
    const ha = Math.atan2(hy, hx);
    const rx = hx / hr, ry = hy / hr;
    let dOut = dx * rx + dy * ry, dRound = dx * -ry + dy * rx;
    if (Math.abs(dOut) < BLAST_SNAP) {
      dOut = 0; dRound = dRound < 0 ? -1 : 1;
    } else if (Math.abs(dRound) < BLAST_SNAP) {
      dOut = dOut < 0 ? -1 : 1; dRound = 0;
    }
    const sOut = -dRound, sRound = dOut; // sideways across the shot

    // (Obsidian it reaches isn't blown out: it starts melting back into
    // lava; ice melts into water — listed in blockHits for WaterSystem.js
    // to see to; see its "Lava meeting water: obsidian" and "Ice".)
    const removed = [];
    for (let along = 0; along <= BLAST_REACH; along += BLAST_SAMPLE_STEP) {
      for (let across = -BLAST_HALF_WIDTH; across <= BLAST_HALF_WIDTH; across += BLAST_SAMPLE_STEP) {
        const pr = hr + dOut * along + sOut * across;
        const pa = ha + (dRound * along + sRound * across) / hr;
        const ij = this.clodAtLocal(Math.cos(pa) * pr, Math.sin(pa) * pr);
        if (!ij) continue;
        const [i, j] = ij;
        const clod = this.rings[i].clods[j];
        if (clod && (clod.obsidian || clod.ice)) {
          this.blockHits = this.blockHits || [];
          this.blockHits.push({ ring: i, j });
        } else if (clod && clod.breakable) { // (see fromTiledMap: a map's tiles mostly aren't)
          removed.push({ ring: i, j, clod });
          this.rings[i].clods[j] = null;
        }
      }
    }
    if (removed.length === 0) return;

    // (For the water on it — see WaterSystem.js's "Water on a dirt
    // planet": every clod gone, so the cells there open up.)
    this.dirtChanges = this.dirtChanges || [];
    for (const e of removed) this.dirtChanges.push({ ring: e.ring, j: e.j });

    this.rebuildSilhouette();
    this.spawnDebris(removed);
    CameraShake.start(HIT_SHAKE_STRENGTH, HIT_SHAKE_SECONDS);
    this.refitPlayer();
  }

  // Each blown-out clod flies off as a clump about half its size, with a
  // puff of dust.
  spawnDebris(removed) {
    const c = this.color;
    removed.forEach((entry, n) => {
      const ring = this.rings[entry.ring];
      const [a0, a1] = clodAngles(ring, entry.j);
      const a = (a0 + a1) / 2 + this.rotationAngle;
      const ux = Math.cos(a), uy = Math.sin(a);
      const tx = -uy, ty = ux;
      const x = this.pos.x + ux * ring.mid, y = this.pos.y + uy * ring.mid;
      const shade = entry.clod.shade;

      if (n < MAX_CHUNKS_PER_HIT) {
        const size = this.clodHeight * (0.22 + Math.random() * 0.12);
        const sides = 6 + Math.floor(Math.random() * 3);
        const shape = [];
        for (let k = 0; k < sides; k++) {
          const ang = k / sides * TWO_PI + (Math.random() - 0.5) * 0.4;
          const rr = size * (0.7 + Math.random() * 0.3);
          shape.push(Math.cos(ang) * rr, Math.sin(ang) * rr);
        }
        const out = 2 + Math.random() * 3.5;
        const side = (Math.random() - 0.5) * 3;
        const life = CHUNK_LIFE_MIN + Math.random() * CHUNK_LIFE_RANGE;
        this.chunks.push({
          x, y, vx: ux * out + tx * side, vy: uy * out + ty * side,
          angle: Math.random() * TWO_PI, spin: (Math.random() - 0.5) * 0.25,
          size, shape, life, maxLife: life, shade,
        });
      }

      if (state.particles) {
        for (let d = 0; d < DUST_PER_CLOD; d++) {
          const speed = 0.6 + Math.random() * 1.8;
          const spread = (Math.random() - 0.5) * 1.8;
          const px = ux + tx * spread, py = uy + ty * spread;
          const plen = Math.sqrt(px * px + py * py);
          const p = Particle.new(new Vector2(x, y), new Vector2(px / plen * speed, py / plen * speed),
            30 + Math.random() * 25);
          p.color = [c[0] * 0.85, c[1] * 0.8, c[2] * 0.75];
          p.radius = 4 + Math.random() * 5;
          p.growRate = 0.25;
          p.drag = 0.94;
          state.particles.push(p);
        }
      }
    });
  }

  // ----------------------------------------------------------------
  // Update: the thrown-off clumps fly, fall back, bounce and fade.
  // ----------------------------------------------------------------

  // Starts it turning `dir` (1 clockwise, -1 counter-clockwise) — or, if
  // it's already turning that way, stops it. Returns which way it's
  // turning now.
  toggleSpin(dir) {
    this.spinDir = this.spinDir === dir ? 0 : dir;
    return this.spinDir;
  }

  // It's just turned `d` radians: if he's standing on it, he goes round
  // with it — unless, with its gravity straight down or up the screen,
  // the ground under him has tipped too steep to stand on: then he
  // slides off, carrying the ground's speed.
  carryPlayer(d) {
    const player = state.player;
    if (!(player && player.onSurface && player.currentPlanet === this)) return;
    const c = Math.cos(d), s = Math.sin(d);
    let lx = player.pos.x - this.pos.x, ly = player.pos.y - this.pos.y;
    [lx, ly] = [lx * c - ly * s, lx * s + ly * c];
    player.pos.x = this.pos.x + lx; player.pos.y = this.pos.y + ly;
    const n = player.climbNormal;
    if (n && player.climbPlanet === this) {
      player.climbNormal = { x: n.x * c - n.y * s, y: n.x * s + n.y * c };
      return;
    }
    const pr = player.radius;
    const [qx, qy, d2, inside] = this.nearestSolidLocal(lx, ly, pr + GROUND_SNAP + 8);
    if (inside || d2 < 1e-12) return;
    const dist = Math.sqrt(d2);
    if (dist > pr + GROUND_SNAP) return;
    const nx = (lx - qx) / dist, ny = (ly - qy) / dist;
    if (upness(this, nx, ny, lx, ly) < FLOOR_DOT) this.leaveSurface(player, -ly * d, lx * d);
  }

  update() {
    const ts = state.timeScale ?? 1;
    if (this.spinDir !== 0) {
      const d = TWO_PI / (SPIN_SECONDS_PER_TURN * 60) * ts * this.spinDir;
      this.rotationAngle += d;
      this.carryPlayer(d);
    }
    const chunks = this.chunks;
    for (let i = chunks.length - 1; i >= 0; i--) {
      const c = chunks[i];
      const lx = c.x - this.pos.x, ly = c.y - this.pos.y;
      const dist = Math.sqrt(lx * lx + ly * ly);
      if (dist > 1e-6) {
        const [ux, uy] = this.upAtLocal(lx, ly);
        c.vx -= ux * CHUNK_GRAVITY * ts;
        c.vy -= uy * CHUNK_GRAVITY * ts;
      }
      const nxp = lx + c.vx * ts, nyp = ly + c.vy * ts;
      if (this.solidAtLocal(nxp, nyp)) {
        // Hit dirt: stays where it was and bounces off it.
        const [qx, qy, d2, inside] = this.nearestSolidLocal(lx, ly, c.size + 20);
        const d = Math.sqrt(d2);
        let nx, ny;
        if (inside || d < 1e-6) {
          nx = lx / Math.max(dist, 1e-6); ny = ly / Math.max(dist, 1e-6);
        } else {
          nx = (lx - qx) / d; ny = (ly - qy) / d;
        }
        const into = c.vx * nx + c.vy * ny;
        if (into < 0) {
          const tx = c.vx - into * nx, ty = c.vy - into * ny;
          c.vx = tx * CHUNK_FRICTION - into * CHUNK_BOUNCE * nx;
          c.vy = ty * CHUNK_FRICTION - into * CHUNK_BOUNCE * ny;
        }
        c.spin *= 0.7;
      } else {
        c.x = this.pos.x + nxp; c.y = this.pos.y + nyp;
      }
      c.angle += c.spin * ts;
      c.life -= ts;
      if (c.life <= 0) chunks.splice(i, 1);
    }
  }

  // ----------------------------------------------------------------
  // Drawing
  // ----------------------------------------------------------------

  // A fan mesh kept on this (field) or in this[field][index], created
  // the first time and refilled after that.
  setMesh(field, index, vertices) {
    const holder = index === null ? this : this[field];
    const key = index === null ? field : index;
    let mesh = holder[key];
    if (!mesh) {
      mesh = love.graphics.newMesh(vertices, 'fan', 'dynamic');
      holder[key] = mesh;
    } else {
      mesh.setVertices(vertices);
    }
    return mesh;
  }

  // What this bake drew, for the next one to compare with: each clod
  // (clods are replaced or removed when hit, never edited), the outline,
  // and how many core cracks there are.
  rememberBake() {
    const clods = this.rings.map((ring) => {
      const row = [];
      for (let j = 0; j < ring.count; j++) row.push(ring.clods[j] ?? null);
      return row;
    });
    this.baked = { clods, silhouette: this.silhouette.slice(0, this.silhouetteSamples), cracks: this.coreCracks.length };
  }

  // What's different from the last bake: a box round every clod added or
  // taken away, every new crack, and every stretch of outline that moved
  // (out to the edge of its halo), and the list of outline samples that
  // moved. null when nothing has.
  changedArea() {
    const baked = this.baked;
    let area = null;
    const take = (box) => { area = growBox(area, box[0], box[1]); area = growBox(area, box[2], box[3]); };
    this.rings.forEach((ring, i) => {
      const row = baked.clods[i];
      for (let j = 0; j < ring.count; j++) {
        if ((ring.clods[j] ?? null) !== row[j]) take(clodBox(ring, j));
      }
    });
    for (let n = baked.cracks; n < this.coreCracks.length; n++) take(crackBox(this.coreCracks[n]));

    // A moved sample changes the outline's (and each halo layer's) two
    // edges either side of it: between it and its neighbours, anywhere
    // from the nearer outline, old or new, to the farther one plus the
    // halo's reach.
    const moved = [];
    const n = this.silhouetteSamples, old = baked.silhouette, now = this.silhouette;
    const reach = this.bodyCanvasPadding;
    for (let k = 0; k < n; k++) {
      if (now[k] === old[k]) continue;
      moved.push(k);
      for (let d = -1; d <= 1; d++) {
        const s = (k + d + n) % n;
        const a = s / n * TWO_PI;
        const ca = Math.cos(a), sa = Math.sin(a);
        const rIn = Math.min(now[s], old[s]), rOut = Math.max(now[s], old[s]) + reach;
        area = growBox(area, ca * rIn, sa * rIn);
        area = growBox(area, ca * rOut, sa * rOut);
      }
    }
    if (!area) return null;
    return { area: padBox(area, BOX_MARGIN), moved };
  }

  // A fan mesh following the outline (radiusOf(sample)), kept like
  // setMesh's. With moved (a list of outline samples), only those
  // samples' points are updated.
  outlineMesh(field, index, radiusOf, texSize, color, moved) {
    const holder = index === null ? this : this[field];
    const mesh = holder && holder[index === null ? field : index];
    const count = this.silhouetteSamples;
    if (!(mesh && moved)) return this.setMesh(field, index, fanVertices(count, radiusOf, texSize, color));
    for (const s of moved) {
      const r = radiusOf(s);
      // (Vertex 0 is the centre; sample s is point s round, and the first
      // sample is also the last point, closing the fan.)
      let [x, y, u, v] = fanVertex(s, count, r, texSize);
      mesh.setVertex(s + 1, x, y, u, v, color[0], color[1], color[2], 1);
      if (s === 0) {
        [x, y, u, v] = fanVertex(count, count, r, texSize);
        mesh.setVertex(count + 1, x, y, u, v, color[0], color[1], color[2], 1);
      }
    }
    return mesh;
  }

  // Bakes the planet into its own canvas: the soft blue halo (the same
  // layered glow Planetoid.js bakes, but following the dirt's outline),
  // the cracked core, the dark back wall of any caves, and every clod
  // still there. After the first time, only what's changed is redrawn
  // (see above).
  bake() {
    if (!state.planetTexture) return;
    const r = this.radius;
    const padding = this.bodyCanvasPadding;
    const size = Math.ceil((r + padding) * 2 * BAKE_SCALE);
    let area = null, moved = null;
    if (this.bodyCanvas && this.baked) {
      const changed = this.changedArea();
      if (!changed) { this.needsBake = false; return; }
      ({ area, moved } = changed);
    }
    if (!this.bodyCanvas) {
      this.bodyCanvas = love.graphics.newCanvas(size, size);
      this.bodyCanvas.setFilter('linear', 'linear');
    }
    const texSize = r * 2 * 2.5;
    const white = [1, 1, 1];
    const c = this.color;
    const g = love.graphics;
    // Whether a piece (by its box) needs drawing this time.
    const touches = (box) => area === null || boxesTouch(box, area);

    g.push('all');
    g.origin();
    g.setCanvas({ 0: this.bodyCanvas, stencil: true });
    if (area) {
      // (In canvas pixels. The clear below, and everything after, stay inside it.)
      const o = (r + padding) * BAKE_SCALE, w = this.bodyCanvas.getWidth();
      const x0 = Math.max(0, Math.floor(area[0] * BAKE_SCALE + o));
      const y0 = Math.max(0, Math.floor(area[1] * BAKE_SCALE + o));
      const x1 = Math.min(w, Math.ceil(area[2] * BAKE_SCALE + o));
      const y1 = Math.min(w, Math.ceil(area[3] * BAKE_SCALE + o));
      g.setScissor(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
    }
    g.clear(0, 0, 0, 0);
    g.setBlendMode('alpha');
    g.translate((r + padding) * BAKE_SCALE, (r + padding) * BAKE_SCALE);
    g.scale(BAKE_SCALE, BAKE_SCALE);

    // The outline, as a fan: everything inside it is dirt or dug-out cave.
    const outline = this.outlineMesh('backWallMesh', null, (k) => this.silhouette[k], texSize, white, moved);

    // Halo, outside the outline only (not glowing up the inside of a cave).
    g.stencil(() => g.draw(outline), 'replace', 1);
    g.setStencilTest('equal', 0);
    const sc = Planetoid.SHADOW_COLOR;
    for (let i = GLOW_LAYERS; i >= 1; i--) {
      const t = i / GLOW_LAYERS;
      const falloff = (1 - t) * (1 - t);
      const grow = padding * t;
      const mesh = this.outlineMesh('glowMeshes', i, (k) => this.silhouette[k] + grow, texSize, white, moved);
      g.setColor(sc[0], sc[1], sc[2], sc[3] * falloff * 0.85);
      g.draw(mesh);
    }
    g.setStencilTest();

    // Caves' back wall: dark dirt, under everything that's still there.
    g.setColor(c[0] * BACK_WALL_SHADE, c[1] * BACK_WALL_SHADE, c[2] * BACK_WALL_SHADE, 1);
    g.draw(outline);

    // The core: the shared rocky texture, tinted dark and hot, with
    // glowing cracks through it.
    // (The core never changes: built the first time only.)
    const core = this.coreMesh ?? this.setMesh('coreMesh', null, fanVertices(96, () => this.coreRadius, texSize, CORE_TINT));
    core.setTexture(state.planetTexture);
    g.setColor(1, 1, 1, 1);
    g.draw(core);
    g.stencil(() => g.draw(core), 'replace', 1);
    g.setStencilTest('greater', 0);
    g.setLineJoin('bevel');
    for (const crack of this.coreCracks) {
      if (!touches(crackBox(crack))) continue;
      g.setColor(CRACK_DARK[0], CRACK_DARK[1], CRACK_DARK[2], CRACK_DARK[3]);
      g.setLineWidth(crack.width + 2);
      g.line(crack.points);
    }
    g.setBlendMode('add');
    for (const crack of this.coreCracks) {
      if (!touches(crackBox(crack))) continue;
      g.setColor(CRACK_GLOW[0], CRACK_GLOW[1], CRACK_GLOW[2], CRACK_GLOW[3]);
      g.setLineWidth(Math.max(1, crack.width * 0.55));
      g.line(crack.points);
    }
    g.setBlendMode('alpha');
    g.setStencilTest();

    // A Tiled map's tiles, each with its own art, and the obsidian and ice
    // blocks (on any cracked planet)...
    this.drawTiles(touches);

    // ...or the clods: dirt, a soft lighter lump in the middle, a few pebbles.
    for (const ring of (this.isTiled ? [] : this.rings)) {
      for (let j = 0; j < ring.count; j++) {
        const clod = ring.clods[j];
        // (Blocks aren't dirt: drawTiles drew them.)
        if (!clod || clod.obsidian || clod.ice || !touches(clodBox(ring, j))) continue;
        const [a0, a1] = clodAngles(ring, j);
        const s = clod.shade;
        g.setColor(c[0] * s, c[1] * s, c[2] * s, 1);
        fillSector(ring.inner, ring.outer, a0, a1);

        const am = (a0 + a1) / 2;
        const arcLen = ring.step * ring.mid;
        g.push();
        g.translate(Math.cos(am) * ring.mid, Math.sin(am) * ring.mid);
        g.rotate(am + Math.PI / 2);
        g.setColor(1, 0.92, 0.78, 0.07);
        g.ellipse('fill', Math.cos(clod.lump) * 2, Math.sin(clod.lump) * 2, arcLen * 0.38, this.clodHeight * 0.34);
        g.pop();

        for (const p of clod.pebbles) {
          const pa = a0 + ring.step * p.along;
          const pr = ring.inner + this.clodHeight * p.out;
          if (p.light) g.setColor(1, 0.9, 0.75, 0.16);
          else g.setColor(0.1, 0.06, 0.03, 0.22);
          g.circle('fill', Math.cos(pa) * pr, Math.sin(pa) * pr, p.size);
        }
      }
    }

    // Their edges: a faint seam between two clods, a darker rim wherever
    // one faces open air (a hole, a cave, space). (Not round a shaped
    // tile: its open side is its curve or diagonal, which its own art
    // already edges.)
    this.rings.forEach((ring, i) => {
      for (let j = 0; j < ring.count; j++) {
        const clod = ring.clods[j];
        if (!clod || clod.shape || !touches(clodBox(ring, j))) continue;
        const [a0, a1] = clodAngles(ring, j);
        const openAbove = (a) => !this.solidInRing(i + 1, a);
        const openBelow = (a) => !this.solidInRing(i - 1, a);
        const solidAbove = (a) => this.solidInRing(i + 1, a);
        const prevOpen = !ring.clods[(j - 1 + ring.count) % ring.count];
        const nextOpen = !ring.clods[(j + 1) % ring.count];

        // (Each seam once: a clod draws the one along its top and the one
        // on its clockwise side. None between a Tiled map's tiles: their
        // art lines up on its own.)
        if (!this.isTiled) {
          g.setLineWidth(1);
          g.setColor(0.08, 0.05, 0.03, SEAM_ALPHA);
          if (i < this.rings.length - 1) arcLine(ring.outer, a0, a1, solidAbove);
          if (!nextOpen) radialLine(a1, ring.inner, ring.outer);
        }

        g.setLineWidth(2);
        g.setColor(0.07, 0.04, 0.02, EDGE_ALPHA);
        arcLine(ring.outer - 1, a0, a1, openAbove);
        arcLine(ring.inner + 1, a0, a1, openBelow);
        if (prevOpen) radialLine(a0 + 1 / ring.mid, ring.inner, ring.outer);
        if (nextOpen) radialLine(a1 - 1 / ring.mid, ring.inner, ring.outer);
      }
    });

    g.pop();
    this.rememberBake();
    this.needsBake = false;
  }

  // Every tile of a Tiled-map planet, as one mesh per tileset image: each
  // tile its own slice of its ring, bent round in a few pieces, with its
  // art from its tileset (its top edge on the ring's outside, mirrored if
  // it's flipped in the map). Rebuilt with every bake: only the tiles
  // touches(box) passes, when given (see bake).
  drawTiles(touches) {
    const verticesByImage = new Map();
    for (const ring of this.rings) {
      for (let j = 0; j < ring.count; j++) {
        const clod = ring.clods[j];
        if (!clod) continue;
        const block = getBlockImage(clod);
        // (On a planet that isn't a Tiled map, only the blocks are drawn here.)
        const ts = block || !this.isTiled ? null : tilesetForGid(this.tilesets, clod.gid);
        const image = block || (ts && ts.image);
        if (!image || (touches && !touches(clodBox(ring, j)))) continue;
        let vertices = verticesByImage.get(image);
        if (!vertices) { vertices = []; verticesByImage.set(image, vertices); }
        const add = (r, a, u, v) => vertices.push([Math.cos(a) * r, Math.sin(a) * r, u, v, 1, 1, 1, 1]);
        let u0, v0, u1, v1;
        if (block) {
          u0 = 0; v0 = 0; u1 = 1; v1 = 1;
        } else {
          // (Half a texel in from each tile's edges, so nothing bleeds in
          // from its neighbors in the tileset image.)
          const padU = 0.5 / ts.imageW, padV = 0.5 / ts.imageH;
          const id = clod.gid - ts.firstgid;
          u0 = (id % ts.columns) * ts.tileW / ts.imageW + padU;
          v0 = Math.floor(id / ts.columns) * ts.tileH / ts.imageH + padV;
          u1 = u0 + ts.tileW / ts.imageW - 2 * padU;
          v1 = v0 + ts.tileH / ts.imageH - 2 * padV;
          if (clod.flipX) [u0, u1] = [u1, u0];
        }
        const [a0, a1] = clodAngles(ring, j);
        for (let p = 0; p < TILE_PIECES; p++) {
          const t0 = p / TILE_PIECES, t1 = (p + 1) / TILE_PIECES;
          const b0 = a0 + (a1 - a0) * t0, b1 = a0 + (a1 - a0) * t1;
          const ua = u0 + (u1 - u0) * t0, ub = u0 + (u1 - u0) * t1;
          add(ring.outer, b0, ua, v0); add(ring.outer, b1, ub, v0); add(ring.inner, b1, ub, v1);
          add(ring.outer, b0, ua, v0); add(ring.inner, b1, ub, v1); add(ring.inner, b0, ua, v1);
        }
      }
    }
    for (const mesh of this.tileMeshes) mesh.release();
    this.tileMeshes = [];
    love.graphics.setColor(1, 1, 1, 1);
    for (const [image, vertices] of verticesByImage) {
      const mesh = love.graphics.newMesh(vertices, 'triangles', 'static');
      mesh.setTexture(image);
      love.graphics.draw(mesh);
      this.tileMeshes.push(mesh);
    }
  }

  draw() {
    Planetoid.drawEclipseShadow(this);

    if (this.needsBake) this.bake();

    const r = this.radius;
    if (this.bodyCanvas) {
      const padding = this.bodyCanvasPadding;
      const shader = Planetoid.applySunShadingAt(this.pos.x, this.pos.y, r, padding);
      // (Drawn turned: so the sun's side stays put, its direction turned
      // back the other way, into the picture's own frame.)
      const angle = this.rotationAngle;
      if (shader && angle !== 0) {
        const sunX = state.sceneWidth / 2 - this.pos.x, sunY = state.sceneHeight / 2 - this.pos.y;
        const len = Math.sqrt(sunX * sunX + sunY * sunY);
        shader.send('lightDir', toFrame(this, sunX / len, sunY / len));
      }
      love.graphics.setColor(1, 1, 1, 1);
      const half = (r + padding) * BAKE_SCALE;
      love.graphics.draw(this.bodyCanvas, this.pos.x, this.pos.y,
        angle, 1 / BAKE_SCALE, 1 / BAKE_SCALE, half, half);
      if (shader) love.graphics.setShader();
    } else {
      love.graphics.setColor(this.color[0], this.color[1], this.color[2], 1);
      love.graphics.circle('fill', this.pos.x, this.pos.y, r);
    }

    this.drawChunks();
    love.graphics.setColor(1, 1, 1, 1);
  }

  drawChunks() {
    const c = this.color;
    const g = love.graphics;
    for (const chunk of this.chunks) {
      const alpha = Math.min(1, chunk.life / CHUNK_FADE);
      const s = chunk.shade;
      g.push();
      g.translate(chunk.x, chunk.y);
      g.rotate(chunk.angle);
      g.setColor(c[0] * s, c[1] * s, c[2] * s, alpha);
      g.polygon('fill', chunk.shape);
      g.setLineWidth(1.2);
      g.setColor(0.08, 0.05, 0.03, alpha * 0.6);
      g.polygon('line', chunk.shape);
      g.pop();
    }
  }
}

CrackedPlanetoid.GRAVITY_MODES = ['core', 'down', 'up'];
CrackedPlanetoid.GRAVITY_LABELS = { core: 'Core', down: 'Down', up: 'Up' };
CrackedPlanetoid.prototype.GRAVITY_LABELS = CrackedPlanetoid.GRAVITY_LABELS;
CrackedPlanetoid.SPIN_LABELS = { 0: 'Off', 1: 'Clockwise', '-1': 'Counter-clockwise' };
CrackedPlanetoid.prototype.SPIN_LABELS = CrackedPlanetoid.SPIN_LABELS;

CrackedPlanetoid.prototype.gravityDistance = PlanetSurface.gravityDistanceFromSurface;

// (Shared with js/world/TiledTerrain.js: the sky dome's levels use the
// same ball-tunnel tile shapes.)
CrackedPlanetoid.SHAPED_TILES = SHAPED_TILES;

export default CrackedPlanetoid;
