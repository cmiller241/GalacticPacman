// js/interiors/MazeInterior.js
//
// The maze inside the maze planet (see js/levels/MazePlanet.js): six square
// maze areas, joined the way a cube's faces are. He plays it as a ball:
// the planet's entry beam drops him in the middle of the front face
// (onEnter), and the exit portal in the middle of the back face puts him
// back on the planet's top (exitBall). While he's in here the camera
// frames the face he's on, whole (see cameraView and Camera.js). Port of
// lua/interiors/MazeInterior.lua (tiles counted from 0 here) — see there
// for how the cube's faces join and turn.

import love from '../love/index.js';
import state from '../state.js';
import Vector2 from '../vector2.js';

// #  wall      .  dot      o  big dot      S  the start      E  the exit
// (space)  open, no dot.
// n is the face's outward direction, r and d which ways its layout's right
// and down point (x right, y down, z toward you, looking at the front).
//
//          top
//   left  front  right  back
//         bottom
const FACES = {
  front: { n: [0, 0, 1], r: [1, 0, 0], d: [0, 1, 0], layout: [
    '######.######',
    '#o.........o#',
    '#.###.#.###.#',
    '#.###.#.###.#',
    '#...........#',
    '#.#.##.##.#.#',
    '..#...S...#..',
    '#.#.##.##.#.#',
    '#...........#',
    '#.###.#.###.#',
    '#.###.#.###.#',
    '#o.........o#',
    '######.######',
  ] },
  right: { n: [1, 0, 0], r: [0, 0, -1], d: [0, 1, 0], layout: [
    '######.######',
    '#o..#...#..o#',
    '#.#.#.#.#.#.#',
    '#.#...#...#.#',
    '#.###.#.###.#',
    '#...........#',
    '..##.#.#.##..',
    '#...........#',
    '#.###.#.###.#',
    '#.#...#...#.#',
    '#.#.#.#.#.#.#',
    '#o..#...#..o#',
    '######.######',
  ] },
  back: { n: [0, 0, -1], r: [-1, 0, 0], d: [0, 1, 0], layout: [
    '######.######',
    '#.....o.....#',
    '#.##.###.##.#',
    '#.#.......#.#',
    '#.#.##.##.#.#',
    '#...#...#...#',
    '..#.#.E.#.#..',
    '#...#...#...#',
    '#.#.##.##.#.#',
    '#.#.......#.#',
    '#.##.###.##.#',
    '#.....o.....#',
    '######.######',
  ] },
  left: { n: [-1, 0, 0], r: [0, 0, 1], d: [0, 1, 0], layout: [
    '######.######',
    '#o..#...#..o#',
    '#.#.#.#.#.#.#',
    '#.#.......#.#',
    '#.###.#.###.#',
    '#.....#.....#',
    '..###...###..',
    '#.....#.....#',
    '#.###.#.###.#',
    '#.#.......#.#',
    '#.#.#.#.#.#.#',
    '#o..#...#..o#',
    '######.######',
  ] },
  top: { n: [0, -1, 0], r: [1, 0, 0], d: [0, 0, 1], layout: [
    '######.######',
    '#o.........o#',
    '#.##.###.##.#',
    '#.#...#...#.#',
    '#.#.#.#.#.#.#',
    '#...#...#...#',
    '..#.##.##.#..',
    '#...#...#...#',
    '#.#.#.#.#.#.#',
    '#.#...#...#.#',
    '#.##.###.##.#',
    '#o.........o#',
    '######.######',
  ] },
  bottom: { n: [0, 1, 0], r: [1, 0, 0], d: [0, 0, -1], layout: [
    '######.######',
    '#o.........o#',
    '#.#.#.#.#.#.#',
    '#.#.#.#.#.#.#',
    '#...#...#...#',
    '###.#.#.#.###',
    '......#......',
    '###.#.#.#.###',
    '#...#...#...#',
    '#.#.#.#.#.#.#',
    '#.#.#.#.#.#.#',
    '#o.........o#',
    '######.######',
  ] },
};
const FACE_NAMES = ['front', 'right', 'back', 'left', 'top', 'bottom'];

// Tiles across a face, and world units per tile.
const N = 13;
const TILE = 72;
const MID = (N - 1) / 2;         // the middle tile (where the edge openings are), from 0
const FACE_WIDTH = N * TILE;
const WALL_INSET = 8;            // how far a wall's edge sits back from its tile's edge
const ROLL_SPEED = 6.5;          // world units per tick
// A turn asked for just after he's rolled past an opening still takes it
// (he's put back on the tile's middle), up to this far past.
const TURN_GRACE = TILE * 0.25;
const SCROLL_TICKS = 42;         // the cube turning over to the next face
// How dark a face gets, turned all the way away (0 = no shading, 1 = black).
const TURN_SHADE = 0.8;
// How far away the viewer is, in face widths: nearer makes the turning
// cube's perspective stronger.
const TURN_VIEW_DISTANCE = 3;
// Slices each turning face is bent in (more: smoother perspective).
const TURN_STRIPS = 24;
// How bright the light along the cube's near edge gets, halfway through a turn.
const TURN_EDGE_LIGHT = 0.5;
const HALF = FACE_WIDTH / 2;
const EYE = TURN_VIEW_DISTANCE * FACE_WIDTH; // the viewer, from the cube's middle

// The cube mid-turn, seen from in front: a point on the face he's leaving
// (leaving true) or on the next one, `a` from that face's middle along the
// way he's going, with the cube turned an angle with cosine c and sine s
// (0 to a quarter turn). Returns [how far along that is on screen from the
// planet's middle, how much bigger or smaller (perspective) things there
// look: 1 on the front, more nearer the viewer, less further off].
function turnedPoint(a, c, s, leaving) {
  const x = leaving ? a * c - HALF * s : HALF * c + a * s;
  const z = leaving ? a * s + HALF * c : HALF * s - a * c;
  const k = (EYE - HALF) / (EYE - z);
  return [x * k, k];
}

// The two faces of a turn drawn as pictures (made the first time, kept),
// and the meshes they're bent into place with (see drawTurningFace).
let turnCanvases = null;
const turnMeshes = [], turnVertices = [];
const DOT_POINTS = 10;
const BIG_DOT_POINTS = 50;
const CLEAR_BONUS = 1000;
// Room left round the face when the camera frames it (world units).
const CAMERA_MARGIN = 40;

const COLOR_FLOOR = [0.03, 0.03, 0.09, 1];
const COLOR_WALL = [0.08, 0.10, 0.30, 1];
const COLOR_WALL_EDGE = [0.38, 0.62, 1.00, 1];
const COLOR_WALL_GLOW = [0.38, 0.62, 1.00, 0.22];
const EDGE_WIDTH = 4;
const GLOW_WIDTH = 14;
const COLOR_DOT = [1.00, 0.92, 0.70, 1];
const DOT_RADIUS = 6;
const BIG_DOT_RADIUS = 14;
const COLOR_EXIT = [0.95, 0.35, 0.95];
const EXIT_RADIUS = 26;
const POPUP_TICKS = 50;

// Directions by arrow key, in the order they're checked when several are held.
const DIRECTIONS = [
  { key: 'ArrowUp', dx: 0, dy: -1 },
  { key: 'ArrowDown', dx: 0, dy: 1 },
  { key: 'ArrowLeft', dx: -1, dy: 0 },
  { key: 'ArrowRight', dx: 1, dy: 0 },
];

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const neg3 = (a) => [-a[0], -a[1], -a[2]];

// How a face (its own right r and down d) is turned on screen, when the
// screen's right and down point `right` and `down` on the cube: xx, yx is
// where the face's right ends up on screen, xy, yy its down.
const turning = (face, right, down) => ({
  xx: dot3(face.r, right), xy: dot3(face.d, right),
  yx: dot3(face.r, down), yy: dot3(face.d, down),
});

// Every wall of a face as one mesh, in the face's own frame (centered on
// 0, 0, unturned), built once: each wall tile filled (set back WALL_INSET
// from any side that faces a corridor, and with that much cut off any
// corner that only touches a corridor diagonally), with a glowing edge
// along everything facing a corridor.
function buildWallMesh(isWall) {
  const vertices = [];
  const quad = (x0, y0, x1, y1, c) => {
    const v = (x, y) => vertices.push([x, y, 0, 0, c[0], c[1], c[2], c[3]]);
    v(x0, y0); v(x1, y0); v(x1, y1);
    v(x0, y0); v(x1, y1); v(x0, y1);
  };
  // A straight edge from (x0, y0) to (x1, y1) (level or upright), as a
  // band `width` across.
  const band = (x0, y0, x1, y1, width, c) => {
    const h = width / 2;
    if (y0 === y1) quad(Math.min(x0, x1) - h, y0 - h, Math.max(x0, x1) + h, y0 + h, c);
    else quad(x0 - h, Math.min(y0, y1) - h, x0 + h, Math.max(y0, y1) + h, c);
  };

  const fills = [], cuts = [], edges = [];
  const I = WALL_INSET;
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      if (!isWall(col, row)) continue;
      const x0 = col * TILE - FACE_WIDTH / 2, y0 = row * TILE - FACE_WIDTH / 2;
      const x1 = x0 + TILE, y1 = y0 + TILE;
      const up = !isWall(col, row - 1), down = !isWall(col, row + 1);
      const left = !isWall(col - 1, row), right = !isWall(col + 1, row);
      const fx0 = left ? x0 + I : x0, fy0 = up ? y0 + I : y0;
      const fx1 = right ? x1 - I : x1, fy1 = down ? y1 - I : y1;
      fills.push([fx0, fy0, fx1, fy1]);
      if (up) edges.push([fx0, fy0, fx1, fy0]);
      if (down) edges.push([fx0, fy1, fx1, fy1]);
      if (left) edges.push([fx0, fy0, fx0, fy1]);
      if (right) edges.push([fx1, fy0, fx1, fy1]);
      // Inside corners: walls on both sides, a corridor only diagonally.
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        if (isWall(col + dx, row) && isWall(col, row + dy) && !isWall(col + dx, row + dy)) {
          const cx = dx < 0 ? x0 : x1, cy = dy < 0 ? y0 : y1;
          const ix = cx - dx * I, iy = cy - dy * I;
          cuts.push([Math.min(cx, ix), Math.min(cy, iy), Math.max(cx, ix), Math.max(cy, iy)]);
          edges.push([ix, iy, cx, iy]);
          edges.push([ix, iy, ix, cy]);
        }
      }
    }
  }
  for (const f of fills) quad(f[0], f[1], f[2], f[3], COLOR_WALL);
  for (const f of cuts) quad(f[0], f[1], f[2], f[3], COLOR_FLOOR);
  for (const e of edges) band(e[0], e[1], e[2], e[3], GLOW_WIDTH, COLOR_WALL_GLOW);
  for (const e of edges) band(e[0], e[1], e[2], e[3], EDGE_WIDTH, COLOR_WALL_EDGE);
  return love.graphics.newMesh(vertices, 'triangles', 'static');
}

class MazeInterior {
  static new(planetoid) {
    const self = new MazeInterior();
    self.planetoid = planetoid;
    self.faces = {};
    for (const name of FACE_NAMES) {
      const def = FACES[name];
      const face = { name, n: def.n, r: def.r, d: def.d, walls: [], dotKinds: [] };
      for (let row = 0; row < N; row++) {
        face.walls.push([]);
        face.dotKinds.push([]);
        for (let col = 0; col < N; col++) {
          const ch = def.layout[row][col];
          face.walls[row].push(ch === '#');
          face.dotKinds[row].push(ch === '.' ? 'dot' : ch === 'o' ? 'big' : null);
          if (ch === 'S') { self.startFace = name; self.startCol = col; self.startRow = row; }
          if (ch === 'E') { self.exitFace = name; self.exitCol = col; self.exitRow = row; }
        }
      }
      // (Off the face counts as wall for the mesh: the openings' walls end there.)
      face.mesh = buildWallMesh((col, row) =>
        col < 0 || col >= N || row < 0 || row >= N || face.walls[row][col]);
      self.faces[name] = face;
    }
    self.resetDots();
    self.popups = [];
    self.resetView();
    return self;
  }

  resetDots() {
    this.dotsLeft = 0;
    for (const name of FACE_NAMES) {
      const face = this.faces[name];
      face.dots = face.dotKinds.map((r) => r.slice());
      for (const r of face.dots) for (const d of r) if (d) this.dotsLeft++;
    }
  }

  // ----------------------------------------------------------------
  // The view: which face is showing, turned which way. viewRight /
  // viewDown: which ways (on the cube) the screen's right and down point.
  // A face's tiles are worked with as VIEW tiles: as it's shown, right way
  // up on screen, (0, 0) top-left. faceTile converts to the face's own.
  // ----------------------------------------------------------------

  resetView() {
    this.setView(this.startFace, [1, 0, 0], [0, 1, 0]);
  }

  setView(faceName, right, down) {
    this.face = this.faces[faceName];
    this.viewRight = right;
    this.viewDown = down;
    this.m = turning(this.face, right, down);
  }

  // View tile -> the face's own tile.
  faceTile(col, row) {
    const m = this.m;
    const u = col - MID, v = row - MID;
    return [MID + m.xx * u + m.yx * v, MID + m.xy * u + m.yy * v];
  }

  // Whether view tile (col, row) is a wall. Off the face is wall, except
  // straight out of an edge opening (the next face's opening is there).
  isWall(col, row) {
    if (col < 0 || col >= N || row < 0 || row >= N) {
      return !((col === MID && (row === -1 || row === N)) || (row === MID && (col === -1 || col === N)));
    }
    const [fc, fr] = this.faceTile(col, row);
    return this.face.walls[fr][fc];
  }

  // The middle of view tile (col, row), in world space.
  tileCenter(col, row) {
    const p = this.planetoid;
    return [p.pos.x + (col - MID) * TILE, p.pos.y + (row - MID) * TILE];
  }

  // ----------------------------------------------------------------
  // Going in and out
  // ----------------------------------------------------------------

  // Where the beam drops him: the start tile (on the front face, which is
  // the one showing whenever he isn't inside).
  getPortalPosition() {
    const [x, y] = this.tileCenter(this.startCol, this.startRow);
    return new Vector2(x, y);
  }

  onEnter(player) {
    player.forceBallMode();
    player.inInterior = this;
    player.onSurface = false;
    // (No planet under him: he's drawn the right way up, not turned to
    // whichever face of the planet is nearest.)
    player.currentPlanet = null;
    player.lastInfluencePlanet = null;
    player.vel.x = 0; player.vel.y = 0;
    this.resetView();
    this.scroll = null;
    this.col = this.startCol; this.row = this.startRow;
    [player.pos.x, player.pos.y] = this.tileCenter(this.col, this.row);
    player.prevPos = player.pos.clone();
    // Rolling nowhere until he picks a way.
    this.dirX = 0; this.dirY = 0;
    this.wantX = 0; this.wantY = 0;
  }

  // The exit: he stands back up on top of the planet, beside the entry
  // beam (this.exitPosition, set by MazePlanet.js), or at the top-middle.
  // The planet shows its front face again.
  exitBall(player) {
    player.inInterior = null;
    player.vel.x = 0; player.vel.y = 0;
    if (player.isBall) player.exitBallMode();
    this.scroll = null;
    this.resetView();
    const p = this.planetoid;
    player.pos.x = this.exitPosition ? this.exitPosition.x : p.pos.x;
    player.pos.y = p.pos.y - p.halfHeight - player.radius - 2;
    player.prevPos = player.pos.clone();
  }

  // (The jump button does nothing in here.)
  triggerJumpAction() {}

  // What the camera shows while he's in here (see Camera.js): the face,
  // whole. Returns [middle x, middle y, zoom].
  cameraView(screenW, screenH) {
    const p = this.planetoid;
    return [p.pos.x, p.pos.y, Math.min(screenW, screenH) / (FACE_WIDTH + 2 * CAMERA_MARGIN)];
  }

  // ----------------------------------------------------------------
  // Rolling
  // ----------------------------------------------------------------

  canGo(dx, dy) {
    return (dx !== 0 || dy !== 0) && !this.isWall(this.col + dx, this.row + dy);
  }

  // Called every frame he's in here, in place of gravity and collision.
  updateBall(player, ts) {
    this.updatePopups(ts);
    if (this.scroll) { this.updateScroll(player, ts); return; }

    for (const d of DIRECTIONS) {
      if (state.keys[d.key]) { this.wantX = d.dx; this.wantY = d.dy; break; }
    }

    // Back the way he came: at once.
    if (this.wantX === -this.dirX && this.wantY === -this.dirY && (this.dirX !== 0 || this.dirY !== 0)) {
      this.dirX = this.wantX; this.dirY = this.wantY;
      this.col -= this.dirX; this.row -= this.dirY;
    }

    // A turn a moment late: just past the middle of the tile he's leaving.
    const turningNow = (this.wantX !== 0 || this.wantY !== 0) && this.wantX !== this.dirX && this.wantY !== this.dirY;
    if (turningNow && (this.dirX !== 0 || this.dirY !== 0) && this.canGo(this.wantX, this.wantY)) {
      const [cx, cy] = this.tileCenter(this.col, this.row);
      if (Math.abs(player.pos.x - cx) + Math.abs(player.pos.y - cy) <= TURN_GRACE) {
        player.pos.x = cx; player.pos.y = cy;
        this.dirX = this.wantX; this.dirY = this.wantY;
      }
    }

    const x0 = player.pos.x, y0 = player.pos.y;
    let left = ROLL_SPEED * ts;
    for (let guard = 0; left > 0 && guard < 8; guard++) {
      if (this.dirX === 0 && this.dirY === 0) {
        // Standing still on a tile's middle: off as soon as there's a way.
        if (this.canGo(this.wantX, this.wantY)) { this.dirX = this.wantX; this.dirY = this.wantY; } else break;
      }
      // Out of an edge opening: over to the next face.
      const nextCol = this.col + this.dirX, nextRow = this.row + this.dirY;
      if (nextCol < 0 || nextCol >= N || nextRow < 0 || nextRow >= N) {
        this.startScroll(player);
        break;
      }
      // Toward the middle of the next tile along.
      const [tx, ty] = this.tileCenter(nextCol, nextRow);
      const dist = Math.abs(tx - player.pos.x) + Math.abs(ty - player.pos.y);
      if (dist > left) {
        player.pos.x += this.dirX * left;
        player.pos.y += this.dirY * left;
        left = 0;
      } else {
        player.pos.x = tx; player.pos.y = ty;
        left -= dist;
        this.col = nextCol; this.row = nextRow;
        if (this.arriveAt(player)) return;
        // At a tile's middle: turn the way he wants if he can, else carry
        // on, else stop against the wall.
        if ((this.wantX !== this.dirX || this.wantY !== this.dirY) && this.canGo(this.wantX, this.wantY)) {
          this.dirX = this.wantX; this.dirY = this.wantY;
        } else if (!this.canGo(this.dirX, this.dirY)) {
          this.dirX = 0; this.dirY = 0;
        }
      }
    }
    this.rolled(player, x0, y0, ts, Math.abs(player.pos.x - x0) + Math.abs(player.pos.y - y0));
  }

  // After moving him from (x0, y0) this frame, `rolledBy` along the
  // ground: turns the ball (right and down one way, left and up the
  // other), and sets his velocity.
  rolled(player, x0, y0, ts, rolledBy) {
    const sign = (this.dirX + this.dirY) >= 0 ? 1 : -1;
    const TWO_PI = Math.PI * 2;
    player.ballRollAngle = (((player.ballRollAngle + sign * rolledBy / player.radius) % TWO_PI) + TWO_PI) % TWO_PI;
    const t = Math.max(ts, 1e-6);
    player.vel.x = (player.pos.x - x0) / t;
    player.vel.y = (player.pos.y - y0) / t;
    player.prevPos = player.pos.clone();
  }

  // He's rolled out of an edge opening: the face beyond it starts
  // scrolling in. Which face that is, and which way it's turned, is the
  // cube rolling over that edge: the face that was off to that side comes
  // round to face him, and the one he was on goes round to the other side.
  startScroll(player) {
    const n = this.face.n;
    let right = this.viewRight, down = this.viewDown, newN;
    if (this.dirX === 1) { newN = right; right = neg3(n); }
    else if (this.dirX === -1) { newN = neg3(right); right = n; }
    else if (this.dirY === 1) { newN = down; down = neg3(n); }
    else { newN = neg3(down); down = n; }
    const nextName = FACE_NAMES.find((name) => dot3(this.faces[name].n, newN) > 0.5);
    this.scroll = {
      t: 0,
      dirX: this.dirX, dirY: this.dirY,
      fromFace: this.face, fromM: this.m,
      toName: nextName, toRight: right, toDown: down, toM: turning(this.faces[nextName], right, down),
      // Where he rolls from: this face's edge tile.
      fromX: player.pos.x, fromY: player.pos.y,
    };
  }

  // Mid-turn (see turnedPoint): he rides the edge between the two faces as
  // it sweeps across, rolling from this face's edge tile onto the next
  // face's (each where it is on its face, turned and in perspective).
  updateScroll(player, ts) {
    const s = this.scroll;
    const t0 = s.t;
    s.t = Math.min(1, s.t + ts / SCROLL_TICKS);
    const [c, sn] = this.turnCosSin();
    const fromAlong = turnedPoint(HALF - TILE / 2, c, sn, true)[0];
    const toAlong = turnedPoint(-HALF + TILE / 2, c, sn, false)[0];
    // From the middle of the planet, along the way he's going.
    const along = fromAlong + (toAlong - fromAlong) * this.scrollAmount();
    const p = this.planetoid;
    const x0 = player.pos.x, y0 = player.pos.y;
    if (s.dirX !== 0) { player.pos.x = p.pos.x + s.dirX * along; player.pos.y = s.fromY; }
    else { player.pos.x = s.fromX; player.pos.y = p.pos.y + s.dirY * along; }
    // (The ball turns only with the tile he really rolls, not the slide.)
    this.rolled(player, x0, y0, ts, TILE * (s.t - t0));
    if (s.t >= 1) {
      this.setView(s.toName, s.toRight, s.toDown);
      this.scroll = null;
      // On the next face's edge tile, still rolling the same way.
      if (s.dirX === 1) this.col = 0; else if (s.dirX === -1) this.col = N - 1;
      if (s.dirY === 1) this.row = 0; else if (s.dirY === -1) this.row = N - 1;
      [player.pos.x, player.pos.y] = this.tileCenter(this.col, this.row);
      player.prevPos = player.pos.clone();
      this.arriveAt(player);
    }
  }

  // How far the turn has gone (0 to 1), eased in and out.
  scrollAmount() {
    const t = this.scroll.t;
    return t * t * (3 - 2 * t);
  }

  // The cosine and sine of how far the cube has turned (a quarter turn in
  // all): also how squarely the face he's leaving, and the next one, face
  // the viewer.
  turnCosSin() {
    const a = Math.PI / 2 * this.scrollAmount();
    return [Math.cos(a), Math.sin(a)];
  }

  // While the cube turns, the planet's own (flat, square) body isn't
  // drawn: the turning cube is, sticking out past it at its nearest edge
  // (see main.js's drawTerrain).
  hidesPlanet() {
    return this.scroll != null;
  }

  // The two faces of a turn, drawn into pictures once (at its start), for
  // drawing bent into perspective (see drawTurningFace).
  paintTurnFaces(t) {
    const g = love.graphics, s = this.scroll;
    if (!turnCanvases) {
      turnCanvases = [g.newCanvas(FACE_WIDTH, FACE_WIDTH), g.newCanvas(FACE_WIDTH, FACE_WIDTH)];
      for (const c of turnCanvases) c.setFilter('linear', 'linear');
    }
    g.push('all');
    g.origin();
    [[s.fromFace, s.fromM], [this.faces[s.toName], s.toM]].forEach(([face, m], i) => {
      g.setCanvas(turnCanvases[i]);
      g.clear(0, 0, 0, 0);
      this.drawFace(face, m, HALF, HALF, t);
    });
    g.pop();
    s.painted = true;
  }

  // One face mid-turn (see turnedPoint), as a strip of TURN_STRIPS slices
  // across the way he's going, each bent into place: narrower and further
  // off at the far side, nearer and bigger at the near edge, and darkened
  // as far as it's turned away. `leaving`: the face he's leaving (else the
  // next one).
  drawTurningFace(index, leaving, c, sn) {
    const s = this.scroll, p = this.planetoid;
    const dir = s.dirX !== 0 ? s.dirX : s.dirY;
    const facing = leaving ? c : sn;
    const b = 1 - (1 - facing) * TURN_SHADE;
    const verts = turnVertices[index] ?? (turnVertices[index] = []);
    for (let i = 0; i <= TURN_STRIPS; i++) {
      const a = -HALF + FACE_WIDTH * i / TURN_STRIPS;
      const [along, k] = turnedPoint(a, c, sn, leaving);
      // Where that slice is in the face's picture, the way he's going.
      const tex = (dir * a + HALF) / FACE_WIDTH;
      if (s.dirX !== 0) {
        const x = p.pos.x + dir * along;
        verts[2 * i] = [x, p.pos.y - HALF * k, tex, 0, b, b, b, 1];
        verts[2 * i + 1] = [x, p.pos.y + HALF * k, tex, 1, b, b, b, 1];
      } else {
        const y = p.pos.y + dir * along;
        verts[2 * i] = [p.pos.x - HALF * k, y, 0, tex, b, b, b, 1];
        verts[2 * i + 1] = [p.pos.x + HALF * k, y, 1, tex, b, b, b, 1];
      }
    }
    let mesh = turnMeshes[index];
    if (!mesh) mesh = turnMeshes[index] = love.graphics.newMesh(verts.length, 'strip', 'stream');
    mesh.setVertices(verts);
    mesh.setTexture(turnCanvases[index]);
    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.draw(mesh);
  }

  // The cube's near edge mid-turn (where the two faces meet): a faint line
  // of light along it, brightest halfway through.
  drawTurnEdge(c, sn) {
    const g = love.graphics, s = this.scroll, p = this.planetoid;
    const [along, k] = turnedPoint(HALF, c, sn, true);
    const glow = TURN_EDGE_LIGHT * 2 * c * sn; // (sin of twice the angle: 0 at the ends, 1 halfway)
    if (glow < 0.01) return;
    g.setColor(COLOR_WALL_EDGE[0], COLOR_WALL_EDGE[1], COLOR_WALL_EDGE[2], glow);
    g.setLineWidth(3);
    if (s.dirX !== 0) {
      const x = p.pos.x + s.dirX * along;
      g.line(x, p.pos.y - HALF * k, x, p.pos.y + HALF * k);
    } else {
      const y = p.pos.y + s.dirY * along;
      g.line(p.pos.x - HALF * k, y, p.pos.x + HALF * k, y);
    }
    g.setLineWidth(1);
  }

  // Reached the middle of a tile: picks up its dot, or leaves by the exit.
  // Returns true when he's left.
  arriveAt(player) {
    const face = this.face;
    const [fc, fr] = this.faceTile(this.col, this.row);
    if (face.name === this.exitFace && fc === this.exitCol && fr === this.exitRow) {
      this.exitBall(player);
      return true;
    }
    const kind = face.dots[fr][fc];
    if (kind) {
      face.dots[fr][fc] = null;
      this.dotsLeft--;
      this.score(kind === 'big' ? BIG_DOT_POINTS : DOT_POINTS, player.pos.x, player.pos.y, kind === 'big');
      if (state.audioManager) state.audioManager.playEatDot();
      if (this.dotsLeft === 0) {
        this.score(CLEAR_BONUS, player.pos.x, player.pos.y - TILE, true);
        this.resetDots();
        // (Not the one he's on.)
        if (face.dots[fr][fc]) { face.dots[fr][fc] = null; this.dotsLeft--; }
      }
    }
    return false;
  }

  // Adds to the HUD's score; `shown` puts up a little "+points".
  score(points, x, y, shown) {
    state.score = (state.score ?? 0) + points;
    if (shown) this.popups.push({ text: '+' + points, x, y, ticks: POPUP_TICKS });
  }

  updatePopups(ts) {
    for (let i = this.popups.length - 1; i >= 0; i--) {
      this.popups[i].ticks -= ts;
      if (this.popups[i].ticks <= 0) this.popups.splice(i, 1);
    }
  }

  // ----------------------------------------------------------------
  // Drawing (on the planet's face, every frame it's on screen)
  // ----------------------------------------------------------------

  // One face, turned as m says (see turning), its middle at (cx, cy).
  drawFace(face, m, cx, cy, t) {
    const g = love.graphics;
    g.push();
    g.translate(cx, cy);
    g.rotate(Math.atan2(m.yx, m.xx));
    g.setColor(COLOR_FLOOR[0], COLOR_FLOOR[1], COLOR_FLOOR[2], COLOR_FLOOR[3]);
    g.rectangle('fill', -FACE_WIDTH / 2, -FACE_WIDTH / 2, FACE_WIDTH, FACE_WIDTH);
    g.setColor(1, 1, 1, 1);
    g.draw(face.mesh);

    g.setColor(COLOR_DOT[0], COLOR_DOT[1], COLOR_DOT[2], COLOR_DOT[3]);
    const bigR = BIG_DOT_RADIUS * (0.85 + 0.15 * Math.sin(t * 6));
    for (let row = 0; row < N; row++) {
      for (let col = 0; col < N; col++) {
        const kind = face.dots[row][col];
        if (kind) g.circle('fill', (col - MID) * TILE, (row - MID) * TILE, kind === 'big' ? bigR : DOT_RADIUS);
      }
    }

    // The exit: a pulsing ring with a swirl of light inside.
    if (face.name === this.exitFace) {
      const ex = (this.exitCol - MID) * TILE, ey = (this.exitRow - MID) * TILE;
      const pulse = (Math.sin(t * 4) + 1) / 2;
      g.setColor(COLOR_EXIT[0], COLOR_EXIT[1], COLOR_EXIT[2], 0.25 + 0.2 * pulse);
      g.circle('fill', ex, ey, EXIT_RADIUS + 10 + pulse * 6);
      g.setColor(COLOR_EXIT[0], COLOR_EXIT[1], COLOR_EXIT[2], 0.9);
      g.setLineWidth(4);
      g.circle('line', ex, ey, EXIT_RADIUS + pulse * 4);
      for (let k = 0; k < 3; k++) {
        const a = t * 3 + k * 2 * Math.PI / 3;
        g.arc('line', 'open', ex, ey, EXIT_RADIUS * 0.6, a, a + 1.2);
      }
      g.setLineWidth(1);
    }
    g.pop();
  }

  draw() {
    const g = love.graphics;
    const p = this.planetoid;
    const t = love.timer.getTime();
    const s = this.scroll;
    if (s) {
      // The cube mid-turn: the face he's leaving turning away, the next one
      // coming round (see turnedPoint), in place of the planet's own body.
      if (!s.painted) this.paintTurnFaces(t);
      const [c, sn] = this.turnCosSin();
      this.drawTurningFace(0, true, c, sn);
      this.drawTurningFace(1, false, c, sn);
      this.drawTurnEdge(c, sn);
    } else {
      // The planet's whole face in the walls' blue first: its own body is
      // shaded by the sun (nearly black on the side away from it), and the
      // border round the maze should match the walls instead.
      g.setColor(COLOR_WALL[0], COLOR_WALL[1], COLOR_WALL[2], COLOR_WALL[3]);
      g.rectangle('fill', p.pos.x - p.halfWidth, p.pos.y - p.halfHeight,
        p.halfWidth * 2, p.halfHeight * 2, p.cornerRadius, p.cornerRadius);
      this.drawFace(this.face, this.m, p.pos.x, p.pos.y, t);
    }

    for (const pop of this.popups) {
      const fade = Math.min(1, pop.ticks / (POPUP_TICKS * 0.4));
      g.setColor(1, 1, 0.6, fade);
      g.print(pop.text, pop.x - 12, pop.y - 30 - (POPUP_TICKS - pop.ticks) * 0.6);
    }
    g.setColor(1, 1, 1, 1);
  }
}

MazeInterior.SIZE = N;
MazeInterior.TILE = TILE;
// (The gamepad stick's up/down roll him too while he's in here: see
// GamePadInput.js.)
MazeInterior.prototype.fourWayInput = true;

export default MazeInterior;
