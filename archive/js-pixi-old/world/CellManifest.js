// js/world/CellManifest.js
import { state } from '../state.js';
import { Vector2 } from '../vector2.js';
import { Planetoid } from './Planetoid.js';

// ----------------------------
// CELL MANIFEST
// ----------------------------
// game.js no longer decides what goes in a cell directly — it just
// asks getCellManifest(col, row): null means "use the normal
// procedural generation," a non-null manifest means "this cell is
// hand-authored, generate/maintain it via the functions below
// instead." More entries (a fixed empty "void" cell, a hand-placed
// encounter, etc.) can be added the same way later without game.js
// needing to know anything about any of them.

// ----------------------------
// ASTEROID BELT
// ----------------------------
// A diagonal corridor of landable planetoids, all sharing ONE velocity,
// connecting the player's home area to their employer's. Defined in
// CELL-space (grid col/row), not world-space — initCellManifest(cellSize)
// converts the endpoints to world coordinates once CELL_SIZE is known.
// Exported so Minimap.js can draw a static visualization of the belt's
// path without needing its own copy of this geometry.
export const BELT_START = { col: 0, row: 15 };
export const BELT_END = { col: 15, row: 20 };
// How wide the corridor is, in cell-widths, measured as perpendicular
// distance from the ideal line — a cushion large enough to guarantee a
// fully-connected diagonal path with no gaps between cells (a bare
// straight line through cell centers can otherwise skip a corner).
// Increase if gaps are ever visible; decrease for a tighter belt.
export const BELT_THICKNESS_CELLS = 0.75;

const BELT_SPEED = 2.5; // world units/frame, shared by every planetoid in the belt
const BELT_RADIUS_MIN = 30;
const BELT_RADIUS_MAX = 70;
const BELT_COLOR = '#dcc48a'; // pale sandy tan, uniform across every belt planetoid (not a random pick from planetColors like regular planets) — a deliberate visual tell that "this one's part of the belt"

// How the belt's population is maintained: a plain timer, not per-cell
// density bookkeeping. An earlier version tracked a target count per
// active cell, counted via a window wide enough to include in-flight
// (not-yet-arrived) planetoids — necessarily very wide, since spawns
// can land far away. That wide window meant a big stretch of the belt
// shared one density target, so instead of topping up steadily it
// waited for that whole stretch to drain, then fired a burst, then
// went quiet again — bursty, not steady. A flat "spawn one every N ms,
// stop at a hard cap" avoids that class of problem entirely rather
// than trying to tune around it.
const BELT_SPAWN_INTERVAL_MS = 100;
const BELT_MAX_TOTAL_PLANETOIDS = 500;

// How far outside the player's CURRENT camera view a newly-spawned
// planetoid must land before it's allowed to stop being pushed further
// upstream — see spawnBeltPlanetoid below. This replaced an earlier
// version that just picked a random distance up to a fixed cap
// (BELT_SPAWN_SETBACK_CELLS): that guaranteed nothing about the actual
// result, since Math.random() * cap can land anywhere down to nearly
// zero — so a meaningful fraction of spawns were still landing in
// view no matter how big the cap was. Checking the real camera bounds
// directly is what actually guarantees hidden, regardless of zoom,
// window size, or exactly where the player is within the cell.
const BELT_HIDE_MARGIN = 350;   // extra buffer beyond the camera's exact edge
const BELT_HIDE_STEP = 150;     // how far each push-back iteration moves
const BELT_HIDE_MAX_STEPS = 35; // safety cap — 35*150 = 5250 units. Deliberately kept well under BELT_CULL_RADIUS_CELLS below (see the comment there) — a fresh spawn's maximum possible distance from the player MUST stay comfortably inside the cull radius, or it gets deleted the instant after being created.
const BELT_EXTRA_STAGGER_CELLS = 0.4; // extra randomized push on top of "just barely hidden," so arrivals stagger over time instead of all arriving in lockstep the moment they cross the boundary

// How far (in cell-widths, plain straight-line distance from the
// player — not projected onto the belt's own direction) a belt
// planetoid is allowed to be before it's culled. An earlier version
// measured distance ALONG the belt's line instead of straight-line
// distance, specifically to dodge a grid-boundary edge case near
// BELT_START — but a plain distance check avoids that same edge case
// just as well (it never depends on grid cell indices at all), while
// being far more intuitive: "3 cells away" behaves the same regardless
// of which direction you traveled, rather than mostly ignoring travel
// that isn't well-aligned with the belt's own (fairly shallow,
// diagonal) direction.
//
// IMPORTANT: this MUST stay comfortably larger than the maximum
// possible spawn-hide distance above (BELT_HIDE_STEP * BELT_HIDE_MAX_STEPS
// + cellSizeRef * BELT_EXTRA_STAGGER_CELLS — currently up to ~6450
// units, 2.15 cells), or a freshly-spawned, correctly-hidden planetoid
// could get deleted the very next cull pass, before ever having a
// chance to drift into view.
const BELT_CULL_RADIUS_CELLS = 3;

let cellSizeRef = 1;
let beltDirWorld = null; // unit Vector2, shared by every belt planetoid
let beltStartWorld = null; // world-space start point, used by beltProgress() below

export function initCellManifest(cellSize) {
  cellSizeRef = cellSize;
  beltStartWorld = { x: BELT_START.col * cellSize, y: BELT_START.row * cellSize };
  const endWorld = { x: BELT_END.col * cellSize, y: BELT_END.row * cellSize };
  beltDirWorld = new Vector2(endWorld.x - beltStartWorld.x, endWorld.y - beltStartWorld.y).normalize();
}

function distancePointToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function isBeltCell(col, row) {
  return distancePointToSegment(col, row, BELT_START.col, BELT_START.row, BELT_END.col, BELT_END.row) <= BELT_THICKNESS_CELLS;
}

// A cell adjacent to a belt cell in ANY direction (not itself a belt
// cell) — kept fully empty, no procedural generation at all, so the
// belt reads as a clean corridor rather than having random content
// crowding right up against it. Checks the full 8-cell neighborhood,
// not just directly above/below — the belt is a diagonal corridor, so
// plenty of its neighboring cells are horizontal or diagonal, and an
// earlier version only checking vertical neighbors left those
// completely unprotected. (A planetoid CAN still end up in one of
// these cells later purely by drifting there on its own — this only
// controls what gets GENERATED, same as everywhere else in the cell
// system; drift-in itself is fine and not something this prevents.)
function isEmptyBufferCell(col, row) {
  if (isBeltCell(col, row)) return false;
  for (let dRow = -1; dRow <= 1; dRow++) {
    for (let dCol = -1; dCol <= 1; dCol++) {
      if (dRow === 0 && dCol === 0) continue;
      if (isBeltCell(col + dCol, row + dRow)) return true;
    }
  }
  return false;
}

// Returns a manifest descriptor for the given cell, or null to fall
// back to normal procedural generation (see generateCell in game.js).
export function getCellManifest(col, row) {
  if (isBeltCell(col, row)) return { type: 'belt' };
  if (isEmptyBufferCell(col, row)) return { type: 'empty' };
  return null;
}

function isPositionHiddenFromCamera(x, y) {
  const cam = state.camera;
  const zoom = state.zoom;
  const canvas = state.canvas;
  if (!cam || !zoom || !canvas) return true; // camera not established yet — treat as safe rather than crash
  const visibleWidth = canvas.width / zoom;
  const visibleHeight = canvas.height / zoom;
  return (
    x < cam.x - BELT_HIDE_MARGIN ||
    x > cam.x + visibleWidth + BELT_HIDE_MARGIN ||
    y < cam.y - BELT_HIDE_MARGIN ||
    y > cam.y + visibleHeight + BELT_HIDE_MARGIN
  );
}

// Scalar "how far along the belt" a world point is — projecting onto
// beltDirWorld from beltStartWorld. Not used for culling anymore (see
// BELT_CULL_RADIUS_CELLS above), but still used by updateBeltSpawning
// to measure how far the player has traveled along the corridor since
// the last check, for scaling the ongoing drip's spawn rate.
function beltProgress(worldX, worldY) {
  const dx = worldX - beltStartWorld.x, dy = worldY - beltStartWorld.y;
  return dx * beltDirWorld.x + dy * beltDirWorld.y;
}

// Used by game.js's cullDistantObjects INSTEAD OF the normal grid-cell
// membership check, for anything tagged isBeltPlanetoid. Grid-cell
// membership doesn't work for belt planetoids specifically: hiding one
// from camera view (see spawnBeltPlanetoidNear) can require pushing it
// into negative/out-of-grid coordinates when the player is near the
// world's edge column, and a grid-based cull would delete it
// immediately for having a "cell index" that can never be active —
// before it ever gets a chance to drift back into view. Plain
// straight-line distance from the player sidesteps grid boundaries
// entirely, the same way the old progress-along-the-line version did,
// without that version's confusing side effect (see the comment on
// BELT_CULL_RADIUS_CELLS above).
export function shouldKeepBeltPlanetoid(planetoid, playerWorldX, playerWorldY) {
  const dx = planetoid.pos.x - playerWorldX;
  const dy = planetoid.pos.y - playerWorldY;
  const maxDist = cellSizeRef * BELT_CULL_RADIUS_CELLS;
  return (dx * dx + dy * dy) <= maxDist * maxDist;
}

// Projects a world point onto the belt's infinite line (not clamped to
// the segment) — used so new spawns stay centered on the corridor even
// if the player has drifted slightly off its exact centerline.
function projectOntoBeltLine(x, y) {
  const dx = x - beltStartWorld.x, dy = y - beltStartWorld.y;
  const t = dx * beltDirWorld.x + dy * beltDirWorld.y; // signed distance along the line from beltStartWorld
  return {
    x: beltStartWorld.x + beltDirWorld.x * t,
    y: beltStartWorld.y + beltDirWorld.y * t
  };
}

// Spawns one belt planetoid near a reference world point (in practice,
// always the player's current position projected onto the belt's
// line — see updateBeltSpawning below), with a little perpendicular
// jitter across the corridor's width for natural variety, then pushed
// upstream until hidden from the current camera view (same guarantee
// as before, just no longer tied to a specific cell's bounds).
function spawnBeltPlanetoidNear(refX, refY) {
  const radius = BELT_RADIUS_MIN + Math.random() * (BELT_RADIUS_MAX - BELT_RADIUS_MIN);

  const perpX = -beltDirWorld.y, perpY = beltDirWorld.x;
  const jitter = (Math.random() * 2 - 1) * cellSizeRef * BELT_THICKNESS_CELLS;
  let x = refX + perpX * jitter;
  let y = refY + perpY * jitter;

  // Push upstream (opposite beltDirWorld), one step at a time, until
  // this position is CONFIRMED outside the player's current camera
  // view — checked directly against real camera/zoom/canvas state,
  // not assumed from a fixed distance. Typically only takes a handful
  // of steps (a few hundred units) at normal zoom; the cap only
  // matters at extreme zoom-out on a very wide window.
  let steps = 0;
  while (!isPositionHiddenFromCamera(x, y) && steps < BELT_HIDE_MAX_STEPS) {
    x -= beltDirWorld.x * BELT_HIDE_STEP;
    y -= beltDirWorld.y * BELT_HIDE_STEP;
    steps++;
  }

  // Extra randomized distance on top, purely so arrivals stagger over
  // time rather than everything that was "just barely hidden" arriving
  // in one synchronized wave the instant it crosses back into view.
  const extraStagger = Math.random() * cellSizeRef * BELT_EXTRA_STAGGER_CELLS;
  x -= beltDirWorld.x * extraStagger;
  y -= beltDirWorld.y * extraStagger;

  const p = new Planetoid(x, y, radius, BELT_COLOR);
  p.vel = beltDirWorld.clone().multiply(BELT_SPEED); // overrides the random drift direction Planetoid's own constructor picks
  p.isBeltPlanetoid = true; // tag — used by the cull check, and by game.js to exempt belt planetoids from the world-edge wall-bounce (their trajectory is authored, not meant to be reflected)
  p.createOffscreen();
  state.planetoids.push(p);
  return p;
}

// generateSpecialCell is still called the first time any special cell
// activates (see generateCell in game.js), but belt population no
// Fires once per belt cell, EVERY time that specific cell activates —
// including re-activation after the player left and came back, since
// generateCell's existing activeCells guard already gives every
// special cell exactly this "once per activation" lifecycle for free.
// This replaced an earlier version that fired ONCE, globally, the
// first time the player got near the belt AT ALL (checked against the
// belt's entire line, not any specific stretch of it) — which meant a
// long round trip (ride to BELT_END, then back to BELT_START) never
// got a second establish-burst for the start you'd long since drifted
// away from and had culled out from under you, even though you were
// "near the belt" continuously the whole trip. Per-cell activation has
// no such blind spot: each stretch of corridor re-establishes itself
// correctly on its own, every time it's revisited.
export function generateSpecialCell(col, row, manifest) {
  if (manifest.type === 'belt') {
    establishBeltCell(col, row);
  }
  // 'empty' cells: nothing to generate.
}

let lastBeltSpawnTime = 0;
let lastPlayerBeltProgress = null; // player's belt-progress at the last check, used to measure distance covered since then

// How many planetoids to place instantly when a belt cell activates —
// per CELL now, not one single global amount (see the comment on
// generateSpecialCell above for why that changed). A value tuned for
// the old global-burst-once design will be WAY too high here, since
// several belt cells can be active at once — each one requesting a
// large batch would blow through BELT_MAX_TOTAL_PLANETOIDS almost
// immediately. Re-tune from scratch for this per-cell meaning.
const BELT_ESTABLISH_COUNT = 40;

// Target average world-distance between consecutive belt spawns along
// the corridor. Spawning is paced by how much belt-progress the player
// has covered since the last check (see updateBeltSpawning), not by
// elapsed time alone — a player moving faster than BELT_SPEED sweeps
// through fresh, never-yet-topped-up corridor faster than a purely
// time-based trickle can keep up with, which is exactly what caused
// density to visibly thin out when racing toward BELT_END. Tying spawn
// COUNT to distance covered keeps density roughly constant regardless
// of how fast the player is actually moving.
const BELT_SPAWN_SPACING = 300;


// True when the player's own current cell, or any of its 8 immediate
// neighbors, is classified as belt or buffer territory — recomputed
// directly from world position rather than needing game.js to pass
// activeCellKeys through, but deliberately the SAME scope as the
// normal 3x3 active neighborhood. This replaced a looser version that
// checked raw distance to the belt's line (reaching out several
// cell-widths, well beyond actual belt territory) — that mismatch was
// a real problem: it let the ongoing drip fire in cells that would
// never pass establishment's stricter test, producing a confusing
// "gray zone" where things slowly trickled in from off-screen with
// none of the instant-establish treatment, even though the cell itself
// was never really part of the belt at all.
function isPlayerNearBeltCell(playerWorldX, playerWorldY) {
  const playerCol = Math.floor(playerWorldX / cellSizeRef);
  const playerRow = Math.floor(playerWorldY / cellSizeRef);
  for (let dRow = -1; dRow <= 1; dRow++) {
    for (let dCol = -1; dCol <= 1; dCol++) {
      if (getCellManifest(playerCol + dCol, playerRow + dRow)) return true;
    }
  }
  return false;
}

// Fills a belt cell with an initial batch, spread across the cell's
// own bounds — so a freshly-activated cell already looks established
// rather than empty. Respects the same global cap the drip does, so a
// burst of several cells activating close together can't blow past it.
function establishBeltCell(col, row) {
  let totalBeltCount = 0;
  for (const p of state.planetoids) {
    if (p.isBeltPlanetoid) totalBeltCount++;
  }

  const originX = col * cellSizeRef;
  const originY = row * cellSizeRef;
  for (let i = 0; i < BELT_ESTABLISH_COUNT; i++) {
    if (totalBeltCount >= BELT_MAX_TOTAL_PLANETOIDS) break;
    spawnBeltPlanetoidInCell(originX, originY);
    totalBeltCount++;
  }
}

// Places a belt planetoid at a random position WITHIN a cell's own
// bounds, with NO camera-hiding push — deliberately different from
// spawnBeltPlanetoidNear (used by the ongoing drip below), which
// exists specifically to hide fresh spawns from a player who's
// already looking at that stretch of corridor. Establishment fires
// the instant a cell activates, typically while the player is still a
// cell away and approaching — same moment every other object in this
// game (regular planetoids, spikey planetoids, asteroids) already just
// appears with no hiding treatment at all. Reusing the drip's hide
// logic here was the actual bug: it made a freshly-established
// planetoid behave identically to a fresh drip spawn — hidden, then
// visibly drifting in over time — which is exactly the "seeping in"
// look establishment is supposed to avoid, not reproduce.
function spawnBeltPlanetoidInCell(originX, originY) {
  const radius = BELT_RADIUS_MIN + Math.random() * (BELT_RADIUS_MAX - BELT_RADIUS_MIN);
  const x = originX + radius + Math.random() * (cellSizeRef - 2 * radius);
  const y = originY + radius + Math.random() * (cellSizeRef - 2 * radius);

  const p = new Planetoid(x, y, radius, BELT_COLOR);
  p.vel = beltDirWorld.clone().multiply(BELT_SPEED);
  p.isBeltPlanetoid = true;
  p.createOffscreen();
  state.planetoids.push(p);
  return p;
}

// Called once per updateActiveCells() tick. Gated on actual DISTANCE
// to the belt's line, not on whether a currently-active grid cell
// happens to be classified as belt territory — a cell-based gate meant
// the drip couldn't start until the player was already standing right
// next to the corridor. Checking real distance directly lets both the
// establish-burst and the ongoing drip start well before arrival.
export function updateBeltSpawning(playerWorldX, playerWorldY) {
  if (!beltDirWorld || !beltStartWorld) return;

  const nearNow = isPlayerNearBeltCell(playerWorldX, playerWorldY);
  if (!nearNow) {
    lastPlayerBeltProgress = null;
    return;
  }

  const now = Date.now();
  if (now - lastBeltSpawnTime < BELT_SPAWN_INTERVAL_MS) return;
  lastBeltSpawnTime = now;

  // How many planetoids to spawn this check: proportional to how far
  // the player has traveled along the belt since the LAST check
  // (covers more ground -> needs more spawns to keep density steady),
  // with a floor of 1 so a stationary or slow player still gets a
  // steady baseline trickle, same as before.
  const currentProgress = beltProgress(playerWorldX, playerWorldY);
  let spawnsNeeded = 1;
  if (lastPlayerBeltProgress !== null) {
    const distanceTraveled = Math.abs(currentProgress - lastPlayerBeltProgress);
    spawnsNeeded = Math.max(1, Math.ceil(distanceTraveled / BELT_SPAWN_SPACING));
  }
  lastPlayerBeltProgress = currentProgress;

  let totalBeltCount = 0;
  for (const p of state.planetoids) {
    if (p.isBeltPlanetoid) totalBeltCount++;
  }

  const projected = projectOntoBeltLine(playerWorldX, playerWorldY);
  for (let i = 0; i < spawnsNeeded; i++) {
    if (totalBeltCount >= BELT_MAX_TOTAL_PLANETOIDS) break;
    spawnBeltPlanetoidNear(projected.x, projected.y);
    totalBeltCount++;
  }
}

// Resets the establish-burst trigger and drip timer on a fresh game —
// these are module-level state, NOT part of `state`, so they otherwise
// survive a restart untouched (initCellManifest itself only runs once,
// at module load, not per-restart) and could suppress a legitimate
// establish-burst the next time the player approaches. Call this from
// initGame() in game.js.
export function resetBeltState() {
  lastBeltSpawnTime = 0;
  lastPlayerBeltProgress = null;
}

// Debug helpers — not used by gameplay logic itself, just for an
// on-screen readout (see game.js's HUD) so belt geometry/behavior can
// be sanity-checked directly instead of guessing from what's on screen.
export function getBeltPlanetoidCount() {
  let count = 0;
  for (const p of state.planetoids) {
    if (p.isBeltPlanetoid) count++;
  }
  return count;
}

// Returns 'belt', 'buffer', or 'normal' for a given cell — same
// classification getCellManifest already uses internally, just
// labeled for display rather than returned as a manifest object.
export function getCellKindLabel(col, row) {
  const manifest = getCellManifest(col, row);
  if (!manifest) return 'normal';
  return manifest.type; // 'belt' or 'empty' (buffer)
}