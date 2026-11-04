// js/world/tiled/Level.js
//
// Solid wall blocks, lava tiles, and the Level object: drawing it, its
// ball tunnels, and headroom for the player.
// Part of the Tiled level loader: see js/world/TiledTerrain.js.

import love from '../../love/index.js';
import Vector2 from '../../vector2.js';
import CrackedPlanetoid from '../CrackedPlanetoid.js';
import { TILE_WORLD_SIZE, classifyGid } from './Tiles.js';

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
// Lava tiles: where the level's lava starts out. The lava itself is a
// liquid, flowing like the water — see WaterSystem.js (WaterSystem.init
// fills these tiles with it). Each is { x0, y0, size }: its top-left
// corner in world units, and its size.
// ---------------------------------------------------------------------

function buildLavaTiles(layer, tileProps, width, height, anchorX, anchorY) {
  const lavaTiles = [];
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const gid = layer.data[row * width + col] ?? 0;
      if (gid !== 0 && classifyGid(tileProps, gid) === 'lava') {
        lavaTiles.push({ x0: anchorX + col * TILE_WORLD_SIZE, y0: anchorY + row * TILE_WORLD_SIZE, size: TILE_WORLD_SIZE });
      }
    }
  }
  return lavaTiles;
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
    love.graphics.draw(this.canvas, this.anchorX, this.anchorY, 0, this.canvasScale, this.canvasScale);
  }

  // --- Ball tunnels (see the section below the class) ---

  // The tile column and row at world (x, y), or null off the map.
  cellAt(x, y) {
    const T = TILE_WORLD_SIZE;
    const col = Math.floor((x - this.anchorX) / T);
    const row = Math.floor((y - this.anchorY) / T);
    if (col < 0 || row < 0 || col >= this.mapWidth || row >= this.mapHeight) return null;
    return [col, row];
  }

  // Whether world (x, y) is inside a ball-tunnel piece.
  tunnelSolidAt(x, y) {
    const cell = this.cellAt(x, y);
    if (!cell) return false;
    const t = this.tunnelByCell.get(cell[1] * this.mapWidth + cell[0]);
    return t !== undefined && pointInOutline(t, x, y);
  }

  // Whether world (x, y) is solid rock: a wall tile or a ball-tunnel piece
  // — and, for headroom, the solid part of a ceiling/arch curve too. (Not
  // an ordinary top: he can always stand up into, or jump up through, one
  // of those.)
  solidAt(x, y, forHeadroom) {
    const cell = this.cellAt(x, y);
    if (!cell) return false;
    const [col, row] = cell;
    const key = row * this.mapWidth + col;
    const t = this.tunnelByCell.get(key);
    if (t) return pointInOutline(t, x, y);
    const gid = this.collisionData[key] ?? 0;
    if (gid === 0) return false;
    const role = classifyGid(this.tileProps, gid);
    if (role === 'wall') return true;
    if (forHeadroom && HEADROOM_CURVES.has(role)) {
      return pointInOutline(shapeOutlineWorld(role, this.anchorX, this.anchorY, col, row), x, y);
    }
    return false;
  }

  // Whether a standing Bob with his center at (cx, cy) and body radius r
  // has room: nothing solid in his head, or the top of his body.
  headroomAt(cx, cy, r) {
    const hx = cx, hy = cy - HEAD_OFFSET;
    if (this.solidAt(hx, hy, true)) return false;
    for (let k = 0; k <= 7; k++) {
      const a = k * Math.PI / 4;
      if (this.solidAt(hx + Math.cos(a) * (HEAD_RADIUS - 1), hy + Math.sin(a) * (HEAD_RADIUS - 1), true)) {
        return false;
      }
    }
    for (const deg of [-150, -120, -90, -60, -30]) {
      const a = deg * Math.PI / 180;
      if (this.solidAt(cx + Math.cos(a) * (r - 1), cy + Math.sin(a) * (r - 1), true)) return false;
    }
    return true;
  }

  // Whether curled-up Bob could stand up where he is: feet where the
  // ball's bottom is, at his full standing size.
  standingRoomAt(player) {
    const full = player.baseRadius ?? player.radius;
    const feetY = player.pos.y + player.radius;
    return this.headroomAt(player.pos.x, feetY - full, full);
  }

  // Pushes a circle at (x, y), radius r, out of the ball-tunnel pieces —
  // and, with withCurves, out of the solid part of ceiling/arch curves, and
  // with withWalls out of wall tiles too (for his head: his body's walls
  // are CollisionSystem's). -> [x, y, nx, ny]: its new center and the
  // direction of the last push (nx null if it wasn't moved).
  pushCircleOut(x, y, r, withWalls, withCurves) {
    const T = TILE_WORLD_SIZE;
    let nx = null, ny = null;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      const lo = this.cellAt(x - r, y - r), hi = this.cellAt(x + r, y + r);
      const c0 = lo ? lo[0] : Math.max(0, Math.floor((x - r - this.anchorX) / T));
      const r0 = lo ? lo[1] : Math.max(0, Math.floor((y - r - this.anchorY) / T));
      const c1 = hi ? hi[0] : Math.min(this.mapWidth - 1, Math.floor((x + r - this.anchorX) / T));
      const r1 = hi ? hi[1] : Math.min(this.mapHeight - 1, Math.floor((y + r - this.anchorY) / T));
      for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
          const key = row * this.mapWidth + col;
          let o = this.tunnelByCell.get(key);
          if (!o && (withWalls || withCurves)) {
            const gid = this.collisionData[key] ?? 0;
            if (gid !== 0) {
              const role = classifyGid(this.tileProps, gid);
              if (role === 'wall' && withWalls) {
                const x0 = this.anchorX + col * T, y0 = this.anchorY + row * T;
                o = [x0, y0, x0 + T, y0, x0 + T, y0 + T, x0, y0 + T];
              } else if (HEADROOM_CURVES.has(role) && withCurves) {
                o = shapeOutlineWorld(role, this.anchorX, this.anchorY, col, row);
              }
            }
          }
          if (o) {
            const [qx, qy, d2] = nearestOnOutline(o, x, y);
            const d = Math.sqrt(d2);
            const inside = pointInOutline(o, x, y);
            if (inside || d < r - 0.5) {
              let px, py;
              if (d > 1e-6) { px = (x - qx) / d; py = (y - qy) / d; } else { px = 0; py = -1; }
              if (inside) { px = -px; py = -py; } // (out the nearest side)
              const depth = inside ? (d + r) : (r - d);
              x += px * depth; y += py * depth;
              nx = px; ny = py; moved = true;
            }
          }
        }
      }
      if (!moved) break;
    }
    return [x, y, nx, ny];
  }

  // Every frame (see main.js): keeps Bob out of the ball-tunnel pieces —
  // and of the ceiling/arch curves, except while he's riding one of this
  // file's curve paths (it rounds them itself; see buildRampClimbShape) —
  // and, standing, in the air, his head out of ceilings.
  pushPlayer(player) {
    const apply = (dx, dy, nx, ny) => {
      player.pos.x += dx; player.pos.y += dy;
      const into = player.vel.x * nx + player.vel.y * ny;
      if (into < 0) {
        player.vel.x -= nx * into;
        player.vel.y -= ny * into;
      }
      if (player.onSurface && player.currentPlanet
          && typeof player.currentPlanet.arcPositionForWorldPoint === 'function') {
        player.surfaceArcPos = player.currentPlanet.arcPositionForWorldPoint(player.pos.x, player.pos.y);
      }
    };
    const onCurvePath = player.onSurface && player.currentPlanet && player.currentPlanet.isWallClimb;
    const [x, y, nx, ny] = this.pushCircleOut(player.pos.x, player.pos.y, player.radius, false, !onCurvePath);
    if (nx != null) apply(x - player.pos.x, y - player.pos.y, nx, ny);
    if (!player.isBall && !player.onSurface) {
      const hx = player.pos.x, hy = player.pos.y - HEAD_OFFSET;
      const [x2, y2, hnx, hny] = this.pushCircleOut(hx, hy, HEAD_RADIUS, true, true);
      if (hnx != null) apply(x2 - hx, y2 - hy, hnx, hny);
    }
  }
}

// ---------------------------------------------------------------------
// Ball tunnels: solid tunnel pieces, and headroom
// ---------------------------------------------------------------------
//
// The ball-tunnel arc pieces (CrackedPlanetoid.js's *Outer1/2/3, round
// the outside of a bend over a crest or under an arch) are solid exactly
// where their art is: Bob (and his head, standing — see below), fireballs
// and water are kept out of them. The tunnel's straight ceilings and
// walls are ordinary wall tiles, so are its *Inner corners (see
// classifyGid), and its bends are the ordinary ramp/ceiling/crest curves
// he already rolls round (see buildRampClimbShape/buildConvexClimbShape).
//
// Headroom: standing up, Bob is taller than his round body — a head
// circle sits on top of it, reaching about 78 units above his feet. A
// ball tunnel is one tile (64 units) high: he only fits curled up as a
// ball (about 48), so he can't walk into one standing, his head is
// stopped jumping into one, and he can't uncurl inside one (see
// Player.exitBallMode and main.js). The same as on the Tiled planet
// (CrackedPlanetoid.standingRoomAt). Port of the same section of
// lua/world/TiledTerrain.lua.

const HEAD_OFFSET = 26;  // the head circle's center, above his own center
const HEAD_RADIUS = 22;
// Curves that are a ceiling over him (solid above), for headroom.
const HEADROOM_CURVES = new Set(['ceilingLeft', 'ceilingRight', 'archLeft', 'archRight']);

// Outlines are flat [x1, y1, x2, y2, ...] arrays.
function pointInOutline(o, x, y) {
  let inside = false;
  const n = o.length;
  let jx = o[n - 2], jy = o[n - 1];
  for (let k = 0; k < n; k += 2) {
    const ix = o[k], iy = o[k + 1];
    if ((iy > y) !== (jy > y) && x < (jx - ix) * (y - iy) / (jy - iy) + ix) inside = !inside;
    jx = ix; jy = iy;
  }
  return inside;
}

// -> [qx, qy, squared distance]: the nearest point on outline o to (x, y).
function nearestOnOutline(o, x, y) {
  let bx = x, by = y, bd = Infinity;
  const n = o.length;
  for (let k = 0; k < n; k += 2) {
    const k2 = (k + 2) % n;
    const ax = o[k], ay = o[k + 1], cx = o[k2], cy = o[k2 + 1];
    const dx = cx - ax, dy = cy - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const qx = ax + dx * t, qy = ay + dy * t;
    const d = (x - qx) * (x - qx) + (y - qy) * (y - qy);
    if (d < bd) { bx = qx; by = qy; bd = d; }
  }
  return [bx, by, bd];
}

// A tile's outline (shape name) in world space, for the cell at col/row.
function shapeOutlineWorld(shape, anchorX, anchorY, col, row) {
  const T = TILE_WORLD_SIZE;
  const x0 = anchorX + col * T, y0 = anchorY + row * T;
  const o = [];
  for (const p of CrackedPlanetoid.SHAPED_TILES[shape].outline) o.push(x0 + p[0] * T, y0 + (1 - p[1]) * T);
  return o;
}

// The ball-tunnel pieces: Map of row * width + col -> world outline —
// and, for the water, a solid cell for each whose middle is inside one.
// -> [byCell, waterSolids]
function buildTunnelSolids(layer, tileProps, width, height, anchorX, anchorY) {
  const SHAPED = CrackedPlanetoid.SHAPED_TILES;
  const byCell = new Map(), waterSolids = [];
  const T = TILE_WORLD_SIZE;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const raw = layer.data[row * width + col] ?? 0;
      const gid = raw % 2 ** 29;
      const props = gid !== 0 ? tileProps[gid] : null;
      let shape = props ? props.slope : null;
      // (The *Inner corners are walls — see classifyGid.)
      if (shape && SHAPED[shape] && /Outer\d$/.test(shape)) {
        if (Math.floor(raw / 2 ** 31) % 2 === 1) { // (flipped left-right in Tiled)
          shape = shape.includes('Right') ? shape.replace('Right', 'Left') : shape.replace('Left', 'Right');
        }
        const o = shapeOutlineWorld(shape, anchorX, anchorY, col, row);
        byCell.set(row * width + col, o);
        const cx = anchorX + (col + 0.5) * T, cy = anchorY + (row + 0.5) * T;
        if (pointInOutline(o, cx, cy)) {
          waterSolids.push({ pos: new Vector2(cx, cy), halfWidth: T / 2, halfHeight: T / 2, isWall: true });
        }
      }
    }
  }
  return [byCell, waterSolids];
}

export { buildWallShapes, buildLavaTiles, Level, buildTunnelSolids };
