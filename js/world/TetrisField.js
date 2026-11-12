// js/world/TetrisField.js
//
// The Tetris planet's game (see js/levels/TetrisPlanet.js): Tetris
// shapes fall in at the round planet one at a time and stick where they
// land on it (or on blocks already stuck to it). Stuck blocks turn with
// the planet, which the player turns a column at a time from its control
// panel (Left and Right; the jump button turns the falling shape — see
// js/interiors/ControlRoom.js, which this is the game of). That's how
// he picks where the next shape lands.
//
// The grid wraps round the planet, the way a Tiled map wraps round the
// dirt planet (see CrackedPlanetoid.fromTiledMap): COLUMNS columns all
// the way round, and rings stacked outward from the surface, ring 0
// sitting on it, each RING_HEIGHT thick. Every ring has the same number
// of columns, so a shape keeps its shape whatever ring it lands on; a
// block is one column of one ring, a curved slice of the ring
// (narrower the deeper it is), so stuck shapes hug the planet.
//
// The planet is split into four colored quadrants, QUADRANT_COLUMNS
// columns each (turning with it). A quadrant's row — every column of
// one ring, within that quadrant — filled up clears, Tetris-style: it
// flashes and fades out with a chime, and the blocks above it in that
// quadrant drop down a ring.
//
// Shapes come in from one direction for a while (LANE_TIME seconds),
// each from somewhere within LANE_SPREAD either side of it (so they all
// land on the same part of the planet), then the direction swings round
// to another part. A shape falls straight in toward
// the planet's middle, one ring at a time, lined up with the grid's
// columns. While it's far out it's drawn flat, an ordinary Tetris shape;
// it bends steadily as it comes in, to match the rings it's landing in.
// A faint ghost shows where it'll land.
//
// Landing isn't sticking: a shape that can't fall any further waits
// LOCK_DELAY seconds (pulsing) before it sticks. Turn the planet or the
// shape in that time so it can fall again, and it carries on falling.
//
// Letting go of the controls ends the game: every block bursts apart
// (see shatter) and the board's wiped, so taking them again starts over.
//
// The planet's turn is kept two ways: this.turns, the whole columns it's
// been turned (what landing and fitting go by), and this.angle, where
// it's drawn, easing after it.

import love from '../love/index.js';
import state from '../state.js';
import CameraShake from '../effects/CameraShake.js';

// --------------------------------------------------------------------
// Tunables
// --------------------------------------------------------------------

// The grid: columns round the planet, and each ring's thickness.
// (The planet's radius over a ring's thickness sets how much wider each
// ring's blocks are than the ring's below: about 8.6% a ring here. The
// columns are about as many as make a ring-0 block as wide as it's tall,
// rounded to split evenly into the four quadrants.)
const COLUMNS = 72;
const RING_HEIGHT = 36;
const SECTOR = (Math.PI * 2) / COLUMNS;
// The quadrants: how many columns each, and their colors (in order
// clockwise from column 0).
const QUADRANT_COLUMNS = COLUMNS / 4;
const QUADRANT_COLORS = [
  [0.98, 0.42, 0.52], // rose
  [0.99, 0.78, 0.30], // amber
  [0.30, 0.86, 0.74], // teal
  [0.42, 0.62, 0.99], // sky blue
];
const QUADRANT_TINT = 0.38;     // how strongly each quadrant's color shows over the planet
const CLEAR_TIME = 0.45;        // seconds a cleared row takes to flash and fade
// The game ending (see shatter): each block breaks into SHARDS x SHARDS
// chunks that fly out from the planet (world units a second), tumble
// (radians a second), slow a little (speed kept a second) and fade.
const SHARDS = 2;
const SHARD_SPEED_MIN = 160, SHARD_SPEED_RANGE = 340;
const SHARD_SPIN = 7;
const SHARD_DRAG = 0.55;
const SHARD_LIFE_MIN = 0.9, SHARD_LIFE_RANGE = 0.7;
const SHATTER_SHAKE_STRENGTH = 22, SHATTER_SHAKE_SECONDS = 0.5;
// The ring a new shape appears in (its bottom row).
const SPAWN_RING = 14;
const STEP_TIME = 0.3;          // seconds a shape takes to fall one ring
const SPAWN_DELAY = 0.6;        // seconds between one shape sticking and the next appearing
// How long a landed shape waits before it sticks (the grace to move it).
const LOCK_DELAY = 0.5;
// The direction shapes come in from: how far either side of it each may
// come from, how long (seconds at the controls) before it swings round,
// and at least how far it swings (clear of the last part of the planet).
const LANE_SPREAD = (45 * Math.PI) / 180;
const LANE_TIME = 30;
const MIN_LANE_CHANGE = (90 * Math.PI) / 180;
// Turning the planet: holding Left or Right turns it a column, then
// after REPEAT_DELAY seconds another every REPEAT_RATE seconds. Each
// turn eases into place (fraction of the way per tick).
const REPEAT_DELAY = 0.2;
const REPEAT_RATE = 0.06;
const TURN_EASE = 0.35;
// How many rings above where it'll land a shape starts to bend (about
// where it appears), bending steadily from there all the way in.
const BEND_RINGS = 13;
// Drawing: slices along each block's curve, its dark border's
// thickness, and how deep the light band along its outer edge and the
// shadow along its inner edge are (world units).
const SLICES = 4;
const BORDER = 3;
const LIGHT_BAND = 6;
const SHADE_BAND = 5;
const GHOST_ALPHA = 0.22;
// How fast a landed shape pulses while it waits to stick, and how far
// toward white it goes.
const LOCK_PULSE_SPEED = 18;
const LOCK_PULSE_WHITE = 0.35;

// The seven shapes: their blocks (across, down) and colors.
const SHAPES = [
  { cells: [[0, 0], [1, 0], [2, 0], [3, 0]], color: [0.30, 0.85, 0.95] }, // I
  { cells: [[0, 0], [1, 0], [0, 1], [1, 1]], color: [0.98, 0.85, 0.25] }, // O
  { cells: [[0, 0], [1, 0], [2, 0], [1, 1]], color: [0.70, 0.40, 0.90] }, // T
  { cells: [[1, 0], [2, 0], [0, 1], [1, 1]], color: [0.45, 0.85, 0.35] }, // S
  { cells: [[0, 0], [1, 0], [1, 1], [2, 1]], color: [0.95, 0.35, 0.35] }, // Z
  { cells: [[0, 0], [0, 1], [1, 1], [2, 1]], color: [0.30, 0.50, 0.95] }, // J
  { cells: [[2, 0], [0, 1], [1, 1], [2, 1]], color: [0.98, 0.60, 0.20] }, // L
];

const COLOR_BORDER = [0.04, 0.04, 0.08];

// The next-shape box: its size and margin from the screen's corner, and
// the size of a block in it (screen pixels).
const NEXT_BOX = 150;
const NEXT_MARGIN = 20;
const NEXT_BLOCK = 26;
let nextFont = null;

const mod = (a, n) => ((a % n) + n) % n;

// --------------------------------------------------------------------
// Shapes
// --------------------------------------------------------------------

// A random shape, turned a random number of quarters: its blocks as
// [column, ring] from its bottom-left (ring 0 its bottom row), how many
// columns wide it is, and its color.
function randomShape() {
  const shape = SHAPES[Math.floor(Math.random() * SHAPES.length)];
  let cells = shape.cells.map((c) => [c[0], c[1]]);
  const turns = Math.floor(Math.random() * 4);
  for (let k = 0; k < turns; k++) cells = cells.map(([i, j]) => [-j, i]);
  let minI = Infinity, maxI = -Infinity, maxJ = -Infinity;
  for (const [i, j] of cells) { minI = Math.min(minI, i); maxI = Math.max(maxI, i); maxJ = Math.max(maxJ, j); }
  // (Down the screen is in toward the planet: the shape's bottom row is
  // ring 0 of it.)
  cells = cells.map(([i, j]) => [i - minI, maxJ - j]);
  return [cells, maxI - minI + 1, shape.color];
}

// --------------------------------------------------------------------
// Drawing helpers
// --------------------------------------------------------------------

// Triangles go into a list of mesh vertices: [x, y, u, v, r, g, b, a].
function addQuad(verts, x1, y1, x2, y2, x3, y3, x4, y4, r, g, b, a) {
  verts.push(
    [x1, y1, 0, 0, r, g, b, a], [x2, y2, 0, 0, r, g, b, a], [x3, y3, 0, 0, r, g, b, a],
    [x1, y1, 0, 0, r, g, b, a], [x3, y3, 0, 0, r, g, b, a], [x4, y4, 0, 0, r, g, b, a],
  );
}

// One band of a block: the part from u0 to u1 (across, in columns) and
// v0 to v1 (out, in rings), placed by `place` (u, v -> [x, y]), in
// slices along its curve.
function addBand(verts, place, u0, u1, v0, v1, r, g, b, a) {
  let [px, py] = place(u0, v0);
  let [qx, qy] = place(u0, v1);
  for (let s = 1; s <= SLICES; s++) {
    const u = u0 + ((u1 - u0) * s) / SLICES;
    const [nx, ny] = place(u, v0);
    const [mx, my] = place(u, v1);
    addQuad(verts, px, py, nx, ny, mx, my, qx, qy, r, g, b, a);
    px = nx; py = ny; qx = mx; qy = my;
  }
}

// One block (column u0 to u0+1, ring v0 to v0+1, in `place`'s terms):
// a dark border, the color, a light band along its outer edge and a
// shadow along its inner edge. du, dv: one world unit across and out,
// in those terms (near enough), for the border and bands.
function addBlock(verts, place, u0, v0, color, alpha, du, dv) {
  const [r, g, b] = color;
  const bu = BORDER * du, bv = BORDER * dv;
  addBand(verts, place, u0, u0 + 1, v0, v0 + 1, COLOR_BORDER[0], COLOR_BORDER[1], COLOR_BORDER[2], alpha);
  const ua = u0 + bu, ub = u0 + 1 - bu, va = v0 + bv, vb = v0 + 1 - bv;
  addBand(verts, place, ua, ub, va, vb, r, g, b, alpha);
  addBand(verts, place, ua, ub, vb - LIGHT_BAND * dv, vb,
    r + (1 - r) * 0.4, g + (1 - g) * 0.4, b + (1 - b) * 0.4, alpha);
  addBand(verts, place, ua, ub, va, va + SHADE_BAND * dv, r * 0.68, g * 0.68, b * 0.68, alpha);
}

// The four quadrants, turning with the planet: each tinted its color,
// with a bright band of it round its stretch of the surface and a line
// between one quadrant and the next.
function drawQuadrants(planet, angle) {
  const g = love.graphics;
  const x = planet.pos.x, y = planet.pos.y, r = planet.radius;
  const span = QUADRANT_COLUMNS * SECTOR;
  for (let q = 0; q < 4; q++) {
    const a0 = angle + q * span;
    const [cr, cg, cb] = QUADRANT_COLORS[q];
    g.setColor(cr, cg, cb, QUADRANT_TINT);
    g.arc('fill', 'pie', x, y, r, a0, a0 + span, 24);
    g.setColor(cr, cg, cb, 0.9);
    g.setLineWidth(8);
    g.arc('line', 'open', x, y, r - 5, a0 + 0.01, a0 + span - 0.01, 24);
    g.setColor(1, 1, 1, 0.45);
    g.setLineWidth(3);
    g.line(x, y, x + Math.cos(a0) * r, y + Math.sin(a0) * r);
  }
}

// Marks round the planet's edge, one per column, turning with it: the
// grid the shapes land on, and its turn.
function drawColumnMarks(planet, angle) {
  const g = love.graphics;
  const r = planet.radius;
  g.setLineWidth(3);
  for (let k = 0; k < COLUMNS; k++) {
    const a = angle + k * SECTOR;
    const c = Math.cos(a), s = Math.sin(a);
    g.setColor(1, 1, 1, k % 3 === 0 ? 0.22 : 0.10);
    g.line(planet.pos.x + c * (r - 16), planet.pos.y + s * (r - 16), planet.pos.x + c * (r - 3), planet.pos.y + s * (r - 3));
  }
}

// --------------------------------------------------------------------
// The field
// --------------------------------------------------------------------

export default class TetrisField {
  // planet: the round Planetoid it's on.
  constructor(planet) {
    this.planet = planet;
    this.turns = 0;        // whole columns the planet's been turned (clockwise)
    this.angle = 0;        // where it's drawn turned to (radians), easing after turns
    this.heldSteer = 0;    // which way Left/Right was held last frame, and when it repeats
    this.repeatTimer = 0;
    this.blocks = {};      // stuck blocks: blocks[ring][column] = color (columns 0 to COLUMNS-1)
    this.stuckVerts = null; // every stuck block, in the planet's frame (see rebuildStuckMesh)
    this.stuckMesh = null;
    this.pieceMesh = null;
    this.piece = null;     // the shape falling in
    this.spawnTimer = 0;
    this.lane = Math.random() * Math.PI * 2; // the direction shapes come in from
    this.laneTimer = LANE_TIME;
    this.full = false;     // no room for the next shape (game over, later)
    this.shards = [];      // chunks of a shattered game, flying apart (see shatter)
    this.shardMesh = null;
    this.clearing = null;  // rows clearing now: { rows: { [quadrant]: Set of rings }, blocks: [{ ring, column, color }], timer }
    this.clearMesh = null;
  }

  // ------------------------------------------------------------------
  // The grid
  // ------------------------------------------------------------------

  // Whether a block of the grid is taken: below ring 0 is the planet.
  isSolid(ring, column) {
    if (ring < 0) return true;
    const row = this.blocks[ring];
    return row !== undefined && row[mod(column, COLUMNS)] !== undefined;
  }

  // The planet's column under a shape's left edge. worldColumn: which
  // column of the world it's lined up with (column 0 starts at angle 0,
  // straight out to the right, and the count goes clockwise); turns: how
  // far the planet's turned (as it is, by default).
  columnAt(worldColumn, turns = this.turns) {
    return worldColumn - turns;
  }

  // Whether the shape fits with its bottom-left block at (ring, column).
  fits(piece, ring, column) {
    for (const [u, v] of piece.cells) {
      if (this.isSolid(ring + v, column + u)) return false;
    }
    return true;
  }

  // Whether the shape fits where it is (both the ring it's in and the one
  // it's sliding down from), its left edge over world column worldColumn,
  // with the planet turned `turns` (as it is, by default).
  fitsHere(piece, worldColumn, turns = this.turns) {
    const column = this.columnAt(worldColumn, turns);
    return this.fits(piece, piece.ring, column) && this.fits(piece, piece.prevRing, column);
  }

  // The ring the shape would land in, falling straight down from where it
  // is, and the planet's column under it.
  landingRing(piece) {
    const column = this.columnAt(piece.worldColumn);
    let ring = piece.ring;
    while (ring > 0 && this.fits(piece, ring - 1, column)) ring--;
    return [ring, column];
  }

  // ------------------------------------------------------------------
  // Shapes
  // ------------------------------------------------------------------

  // Swings the direction shapes come in from round to a new one, at least
  // MIN_LANE_CHANGE from the old.
  newLane() {
    const old = this.lane;
    let lane;
    for (;;) {
      lane = Math.random() * Math.PI * 2;
      const apart = Math.abs(mod(lane - old + Math.PI, 2 * Math.PI) - Math.PI);
      if (apart >= MIN_LANE_CHANGE) break;
    }
    this.lane = lane;
    this.laneTimer = LANE_TIME;
  }

  // Sends in the next shape, from somewhere within LANE_SPREAD of the
  // direction they're coming in from, lined up with the grid's columns.
  spawn() {
    const side = this.lane + (Math.random() * 2 - 1) * LANE_SPREAD;
    const next = this.peekNext();
    this.nextShape = null; // (a new one's made the next time it's looked at)
    const { cells, width, color } = next;
    const piece = {
      cells, width, color,
      worldColumn: Math.floor(side / SECTOR - width / 2 + 0.5), // see columnAt
      ring: SPAWN_RING, prevRing: SPAWN_RING,
      stepTimer: 0,
      landed: false,   // can't fall further: waiting LOCK_DELAY to stick
      lockTimer: 0,
    };
    if (!this.fitsHere(piece, piece.worldColumn)) {
      this.full = true;
      return;
    }
    this.piece = piece;
  }

  // Sticks the shape where it's landed.
  lock(piece) {
    const column = this.columnAt(piece.worldColumn);
    for (const [u, v] of piece.cells) {
      const ring = piece.ring + v;
      this.blocks[ring] ??= {};
      this.blocks[ring][mod(column + u, COLUMNS)] = piece.color;
      if (ring >= SPAWN_RING - 1) this.full = true;
    }
    this.piece = null;
    this.spawnTimer = SPAWN_DELAY;
    if (state.audioManager) state.audioManager.playGoombaStomp(); // (a solid thunk)
    this.findClears(piece, column);
    this.rebuildStuckMesh();
  }

  // Whether every column of a quadrant is filled in a ring.
  quadrantRowFull(ring, quadrant) {
    const row = this.blocks[ring];
    if (!row) return false;
    for (let c = quadrant * QUADRANT_COLUMNS; c < (quadrant + 1) * QUADRANT_COLUMNS; c++) {
      if (row[c] === undefined) return false;
    }
    return true;
  }

  // After a shape sticks: any quadrant row it filled starts clearing. Its
  // blocks come out of the grid now (to flash and fade, see draw), and
  // the blocks above drop once they've gone (see finishClear).
  findClears(piece, column) {
    const rows = {};
    let count = 0;
    for (const [u, v] of piece.cells) {
      const ring = piece.ring + v;
      const quadrant = Math.floor(mod(column + u, COLUMNS) / QUADRANT_COLUMNS);
      rows[quadrant] ??= new Set();
      if (!rows[quadrant].has(ring) && this.quadrantRowFull(ring, quadrant)) {
        rows[quadrant].add(ring);
        count++;
      }
    }
    if (count === 0) return;

    const fading = [];
    for (const [qKey, rings] of Object.entries(rows)) {
      const quadrant = Number(qKey);
      for (const ring of rings) {
        for (let c = quadrant * QUADRANT_COLUMNS; c < (quadrant + 1) * QUADRANT_COLUMNS; c++) {
          fading.push({ ring, column: c, color: this.blocks[ring][c] });
          delete this.blocks[ring][c];
        }
      }
    }
    this.clearing = { rows, blocks: fading, timer: 0 };
    if (state.audioManager) state.audioManager.playTetrisClear(count);
  }

  // The cleared rows have faded: in each quadrant that cleared, every block
  // above a cleared row drops a ring for each cleared row beneath it.
  finishClear() {
    const rows = this.clearing.rows;
    this.clearing = null;
    let top = 0;
    for (const ringKey of Object.keys(this.blocks)) top = Math.max(top, Number(ringKey));
    for (const [qKey, rings] of Object.entries(rows)) {
      const quadrant = Number(qKey);
      for (let c = quadrant * QUADRANT_COLUMNS; c < (quadrant + 1) * QUADRANT_COLUMNS; c++) {
        let drop = 0;
        for (let ring = 0; ring <= top; ring++) {
          if (rings.has(ring)) {
            drop++;
          } else if (drop > 0) {
            const row = this.blocks[ring];
            const color = row ? row[c] : undefined;
            if (color !== undefined) {
              delete row[c];
              this.blocks[ring - drop] ??= {};
              this.blocks[ring - drop][c] = color;
            }
          }
        }
      }
    }
    this.rebuildStuckMesh();
  }

  // Left or Right at the controls: turns the planet a column (dir 1
  // clockwise), unless that would swing a stuck block into the falling
  // shape. Returns whether it turned.
  turnPlanet(dir) {
    const turns = this.turns + dir;
    const piece = this.piece;
    if (piece && !this.fitsHere(piece, piece.worldColumn, turns)) return false;
    this.turns = turns;
    return true;
  }

  // The jump button at the controls: turns the falling shape a quarter
  // turn clockwise (as seen with the planet below it), about its middle.
  // If it won't fit turned, it tries a column either way, then a ring
  // further out; if none fits, it stays as it was. Returns whether it turned.
  rotatePiece() {
    const piece = this.piece;
    if (!piece) return false;
    // (Across and out, turned: what was out goes across, what was across
    // goes in. Then back to its bottom-left at 0, 0.)
    let cells = piece.cells.map(([u, v]) => [v, -u]);
    let minU = Infinity, minV = Infinity, maxU = -Infinity;
    for (const [u, v] of cells) { minU = Math.min(minU, u); minV = Math.min(minV, v); maxU = Math.max(maxU, u); }
    cells = cells.map(([u, v]) => [u - minU, v - minV]);
    const width = maxU - minU + 1;
    // (Its middle stays where it was, to the nearest column.)
    const worldColumn = piece.worldColumn + Math.floor((piece.width - width) / 2 + 0.5);

    const turned = { cells, ring: 0, prevRing: 0 };
    for (const [dc, dr] of [[0, 0], [-1, 0], [1, 0], [0, 1]]) {
      turned.ring = piece.ring + dr;
      turned.prevRing = piece.prevRing + dr;
      if (this.fitsHere(turned, worldColumn + dc)) {
        piece.cells = cells; piece.width = width;
        piece.worldColumn = worldColumn + dc;
        piece.ring = turned.ring; piece.prevRing = turned.prevRing;
        return true;
      }
    }
    return false;
  }

  // The game's over (he's let go of the controls): every block — stuck,
  // clearing or falling — breaks into chunks that fly apart, with a bang,
  // and the board's wiped for a fresh start.
  shatter() {
    const planet = this.planet;
    const cx = planet.pos.x, cy = planet.pos.y, radius = planet.radius;
    let count = 0;
    // One block: column u, ring v (fractions allowed), the planet's middle
    // at angle a0 for column 0.
    const burst = (a0, u, v, color) => {
      const a = a0 + (u + 0.5) * SECTOR;
      const r = radius + (v + 0.5) * RING_HEIGHT;
      const width = r * SECTOR, height = RING_HEIGHT;
      const ox = Math.cos(a), oy = Math.sin(a);   // out from the planet
      const tx = -oy, ty = ox;                    // across
      for (let i = 0; i < SHARDS; i++) {
        for (let j = 0; j < SHARDS; j++) {
          const across = ((i + 0.5) / SHARDS - 0.5) * width;
          const out = ((j + 0.5) / SHARDS - 0.5) * height;
          const speed = SHARD_SPEED_MIN + Math.random() * SHARD_SPEED_RANGE;
          const spread = (Math.random() * 2 - 1) * 0.6;
          const life = SHARD_LIFE_MIN + Math.random() * SHARD_LIFE_RANGE;
          this.shards.push({
            x: cx + ox * (r + out) + tx * across, y: cy + oy * (r + out) + ty * across,
            vx: (ox + tx * spread) * speed, vy: (oy + ty * spread) * speed,
            angle: a + Math.PI / 2, spin: (Math.random() * 2 - 1) * SHARD_SPIN,
            w: width / SHARDS, h: height / SHARDS,
            color, life, maxLife: life,
          });
        }
      }
      count++;
    };

    for (const [ringKey, row] of Object.entries(this.blocks)) {
      for (const [columnKey, color] of Object.entries(row)) burst(this.angle, Number(columnKey), Number(ringKey), color);
    }
    if (this.clearing) {
      for (const b of this.clearing.blocks) burst(this.angle, b.column, b.ring, b.color);
    }
    const piece = this.piece;
    if (piece) {
      const t = Math.min(1, piece.stepTimer / STEP_TIME);
      const ringNow = piece.prevRing + (piece.ring - piece.prevRing) * t;
      for (const [u, v] of piece.cells) burst(piece.worldColumn * SECTOR, u, ringNow + v, piece.color);
    }

    // A fresh board (the planet stays turned the way it is).
    this.blocks = {};
    this.piece = null;
    this.nextShape = null;
    this.clearing = null;
    this.spawnTimer = 0;
    this.full = false;
    this.newLane();
    this.rebuildStuckMesh();

    if (count > 0) {
      CameraShake.start(SHATTER_SHAKE_STRENGTH, SHATTER_SHAKE_SECONDS);
      if (state.audioManager && state.player) state.audioManager.playBang('large', state.player.pos);
    }
  }

  // The chunks of a shattered game: flying, tumbling, slowing and fading.
  updateShards(dt) {
    const shards = this.shards;
    if (shards.length === 0) return;
    const keep = SHARD_DRAG ** dt;
    for (const s of shards) {
      s.x += s.vx * dt; s.y += s.vy * dt;
      s.vx *= keep; s.vy *= keep;
      s.angle += s.spin * dt;
      s.life -= dt;
    }
    this.shards = shards.filter((s) => s.life > 0);
  }

  // ------------------------------------------------------------------
  // Every frame
  // ------------------------------------------------------------------

  // Left/Right held (dir: -1, 0 or 1): a column turn as it's pressed, then
  // more while it's held, after a moment.
  steer(dir, dt) {
    if (dir === 0) {
      this.heldSteer = 0;
      return;
    }
    if (dir !== this.heldSteer) {
      this.heldSteer = dir;
      this.repeatTimer = REPEAT_DELAY;
      this.turnPlanet(dir);
      return;
    }
    this.repeatTimer -= dt;
    while (this.repeatTimer <= 0) {
      this.repeatTimer += REPEAT_RATE;
      this.turnPlanet(dir);
    }
  }

  // steer: -1, 0 or 1 (Left, nothing, Right held). Shapes only fall, and
  // the planet only turns, while `playing` (someone's at the controls);
  // its drawn turn always eases after its last whole-column turn.
  update(dt, ts, playing, steer = 0) {
    this.updateShards(dt);
    if (playing) this.steer(steer, dt); else this.heldSteer = 0;
    const target = this.turns * SECTOR;
    this.angle += (target - this.angle) * Math.min(1, TURN_EASE * ts);
    if (Math.abs(target - this.angle) < 0.0001) this.angle = target;

    if (!playing || this.full) return;

    this.laneTimer -= dt;
    if (this.laneTimer <= 0) this.newLane();

    // (Rows clearing: nothing new comes in till they've gone.)
    if (this.clearing) {
      this.clearing.timer += dt;
      if (this.clearing.timer >= CLEAR_TIME) this.finishClear();
      return;
    }

    const piece = this.piece;
    if (!piece) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) this.spawn();
      return;
    }

    const column = this.columnAt(piece.worldColumn);
    if (piece.landed) {
      if (this.fits(piece, piece.ring - 1, column)) {
        // (Moved off its landing in time: it carries on falling.)
        piece.landed = false;
        piece.stepTimer = 0;
      } else {
        piece.lockTimer += dt;
        if (piece.lockTimer >= LOCK_DELAY) this.lock(piece);
        return;
      }
    }

    piece.stepTimer += dt;
    while (piece.stepTimer >= STEP_TIME) {
      piece.stepTimer -= STEP_TIME;
      piece.prevRing = piece.ring;
      if (this.fits(piece, piece.ring - 1, column)) {
        piece.ring--;
      } else {
        piece.landed = true;
        piece.lockTimer = 0;
        piece.stepTimer = 0;
        return;
      }
    }
  }

  // ------------------------------------------------------------------
  // Drawing
  // ------------------------------------------------------------------

  // Every stuck block, in the planet's own frame (its middle at 0, 0,
  // unturned): rebuilt only when one sticks, and drawn turned with the
  // planet. (The mesh itself is made the next time it's drawn.)
  rebuildStuckMesh() {
    const radius = this.planet.radius;
    const place = (u, v) => {
      const a = u * SECTOR, r = radius + v * RING_HEIGHT;
      return [Math.cos(a) * r, Math.sin(a) * r];
    };
    const verts = [];
    for (const [ringKey, row] of Object.entries(this.blocks)) {
      const ring = Number(ringKey);
      const du = 1 / ((radius + (ring + 0.5) * RING_HEIGHT) * SECTOR);
      for (const [columnKey, color] of Object.entries(row)) {
        addBlock(verts, place, Number(columnKey), ring, color, 1, du, 1 / RING_HEIGHT);
      }
    }
    this.stuckVerts = verts;
    if (this.stuckMesh) this.stuckMesh.release?.();
    this.stuckMesh = null;
  }

  // Draws mesh vertices through a mesh kept in this[field], grown as needed.
  // ------------------------------------------------------------------
  // As the control room's game (see js/interiors/ControlRoom.js)
  // ------------------------------------------------------------------

  // (Nothing to set up: shapes start falling as soon as he's at the controls.)
  start() {}

  // The jump button at the controls: turns the falling shape.
  onJump() { this.rotatePiece(); }

  // He's let go: the game's over, its blocks burst apart.
  stop() { this.shatter(); }

  // How far out the camera frames, at the controls: everything falling in.
  cameraReach() {
    return this.planet.radius + TetrisField.SPAWN_DISTANCE;
  }

  // With the HUD: the next shape, while he's at the controls.
  drawHud(playing) {
    if (playing) this.drawNext();
  }

  // The shape that'll come in after the one falling now (made the first
  // time it's asked for): { cells, width, color }.
  peekNext() {
    if (!this.nextShape) {
      const [cells, width, color] = randomShape();
      this.nextShape = { cells, width, color };
    }
    return this.nextShape;
  }

  // The next shape, flat and the way round it'll come in, in a box at the
  // top right of the screen (see drawHud). Screen space.
  drawNext() {
    const g = love.graphics;
    const shape = this.peekNext();
    const x0 = g.getWidth() - NEXT_MARGIN - NEXT_BOX, y0 = NEXT_MARGIN;

    g.setColor(0.04, 0.03, 0.08, 0.7);
    g.rectangle('fill', x0, y0, NEXT_BOX, NEXT_BOX, 12, 12);
    g.setColor(1, 1, 1, 0.3);
    g.setLineWidth(2);
    g.rectangle('line', x0, y0, NEXT_BOX, NEXT_BOX, 12, 12);

    nextFont ??= g.newFont(18);
    const prevFont = g.getFont();
    g.setFont(nextFont);
    g.setColor(1, 1, 1, 0.85);
    g.printf('NEXT', x0, y0 + 10, NEXT_BOX, 'center');
    g.setFont(prevFont);

    // Centered in the space under the label, its bottom row at the bottom
    // (the side that'll face the planet).
    let height = 0;
    for (const [, v] of shape.cells) height = Math.max(height, v + 1);
    const s = NEXT_BLOCK;
    const midX = x0 + NEXT_BOX / 2, midY = y0 + 36 + (NEXT_BOX - 36) / 2;
    const left = midX - (shape.width * s) / 2, bottom = midY + (height * s) / 2;
    const place = (u, v) => [left + u * s, bottom - v * s];
    const verts = [];
    for (const [u, v] of shape.cells) addBlock(verts, place, u, v, shape.color, 1, 1 / s, 1 / s);
    this.drawVertices('nextMesh', verts);
    g.setColor(1, 1, 1, 1);
  }

  drawVertices(field, verts) {
    const n = verts.length;
    if (n === 0) return;
    let mesh = this[field];
    if (!mesh || mesh.getVertexCount() < n) {
      mesh?.release?.();
      mesh = love.graphics.newMesh(Math.max(n, 1200), 'triangles', 'dynamic');
      this[field] = mesh;
    }
    mesh.setVertices(verts);
    mesh.setDrawRange(0, n);
    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.draw(mesh);
  }

  // The column marks, the stuck blocks, and the shape falling in (with a
  // ghost where it'll land). World space.
  draw() {
    const g = love.graphics;
    const planet = this.planet;
    const cx = planet.pos.x, cy = planet.pos.y, radius = planet.radius;
    drawQuadrants(planet, this.angle);
    drawColumnMarks(planet, this.angle);

    if (this.stuckVerts && this.stuckVerts.length > 0) {
      if (!this.stuckMesh) this.stuckMesh = g.newMesh(this.stuckVerts, 'triangles', 'static');
      g.push();
      g.translate(cx, cy);
      g.rotate(this.angle);
      g.setColor(1, 1, 1, 1);
      g.draw(this.stuckMesh);
      g.pop();
    }

    // Rows clearing: flashing white, then fading out.
    const clearing = this.clearing;
    if (clearing) {
      const t = Math.min(1, clearing.timer / CLEAR_TIME);
      const white = 0.8 * (1 - t), alpha = 1 - t * t;
      const placeTurned = (u, v) => {
        const a = this.angle + u * SECTOR, r = radius + v * RING_HEIGHT;
        return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
      };
      const fadeVerts = [];
      for (const b of clearing.blocks) {
        const color = b.color.map((c) => c + (1 - c) * white);
        addBlock(fadeVerts, placeTurned, b.column, b.ring, color, alpha,
          1 / ((radius + (b.ring + 0.5) * RING_HEIGHT) * SECTOR), 1 / RING_HEIGHT);
      }
      this.drawVertices('clearMesh', fadeVerts);
    }

    // A shattered game's chunks: each a small square of its block's color
    // (a dark edge round it), tumbling, fading out at the end of its life.
    if (this.shards.length > 0) {
      const shardVerts = [];
      for (const s of this.shards) {
        const alpha = Math.min(1, s.life / (s.maxLife * 0.5));
        const c = Math.cos(s.angle), sn = Math.sin(s.angle);
        for (let layer = 1; layer <= 2; layer++) {
          let hw = s.w / 2, hh = s.h / 2;
          let [r, gr, b] = COLOR_BORDER;
          if (layer === 2) { hw -= 2; hh -= 2; [r, gr, b] = s.color; }
          const ax = c * hw, ay = sn * hw;
          const bx = -sn * hh, by = c * hh;
          addQuad(shardVerts,
            s.x - ax - bx, s.y - ay - by, s.x + ax - bx, s.y + ay - by,
            s.x + ax + bx, s.y + ay + by, s.x - ax + bx, s.y - ay + by,
            r, gr, b, alpha);
        }
      }
      this.drawVertices('shardMesh', shardVerts);
    }

    const piece = this.piece;
    if (!piece) return;
    const verts = [];

    // The ghost: where it'll land, in the grid as the planet is drawn.
    const [landRing, column] = this.landingRing(piece);
    const snapped = this.angle + column * SECTOR;
    const placeCurved = (u, v) => {
      const a = snapped + u * SECTOR, r = radius + v * RING_HEIGHT;
      return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    };
    const dv = 1 / RING_HEIGHT;
    if (!piece.landed) {
      for (const [u, v] of piece.cells) {
        const ring = landRing + v;
        addBlock(verts, placeCurved, u, ring, piece.color, GHOST_ALPHA,
          1 / ((radius + (ring + 0.5) * RING_HEIGHT) * SECTOR), dv);
      }
    }

    // The shape itself: slid smoothly from the ring it was last in to the
    // one it's in, and bent by how near it is to where it'll land — flat
    // (an ordinary Tetris shape, its blocks as wide as they'll be at the
    // surface) far out, curved like the rings close in. Landed, it pulses
    // toward white while it waits to stick.
    const t = Math.min(1, piece.stepTimer / STEP_TIME);
    const ringNow = piece.prevRing + (piece.ring - piece.prevRing) * t;
    const bend = 1 - Math.min(1, Math.max(0, (ringNow - landRing) / BEND_RINGS));
    const theta = piece.worldColumn * SECTOR;
    const mid = theta + (piece.width / 2) * SECTOR;
    const ox = Math.cos(mid), oy = Math.sin(mid);  // out from the planet, at the shape's middle
    const tx = -oy, ty = ox;                       // across, the way the columns count
    const flatWidth = (radius + 0.5 * RING_HEIGHT) * SECTOR;
    const placeShape = (u, v) => {
      const ring = ringNow + v;
      const a = theta + u * SECTOR, r = radius + ring * RING_HEIGHT;
      const curvedX = cx + Math.cos(a) * r, curvedY = cy + Math.sin(a) * r;
      const across = (u - piece.width / 2) * flatWidth;
      const flatX = cx + ox * r + tx * across;
      const flatY = cy + oy * r + ty * across;
      return [flatX + (curvedX - flatX) * bend, flatY + (curvedY - flatY) * bend];
    };
    let color = piece.color;
    if (piece.landed) {
      const w = LOCK_PULSE_WHITE * (0.5 + 0.5 * Math.sin(piece.lockTimer * LOCK_PULSE_SPEED));
      color = color.map((c) => c + (1 - c) * w);
    }
    for (const [u, v] of piece.cells) {
      addBlock(verts, placeShape, u, v, color, 1, 1 / flatWidth, dv);
    }

    this.drawVertices('pieceMesh', verts);
  }
}

TetrisField.COLUMNS = COLUMNS;
TetrisField.RING_HEIGHT = RING_HEIGHT;
TetrisField.SPAWN_DISTANCE = (SPAWN_RING + 4) * RING_HEIGHT;
