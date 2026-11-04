// js/debug/DebugDraw.js
//
// The debug overlays, drawn in world space from love.draw. Each one checks
// its own toggle, so love.draw can just call them (a port of
// lua/debug/DebugDraw.lua):
//   C  state.showCollisionDebug  collision shapes
//   A  state.showBeltCellDebug   asteroid-belt cells
//   R  state.showInfluenceRings  gravity reach rings

import love from '../love/index.js';
import state from '../state.js';
import constants from '../constants.js';
import utils from '../utils.js';
import worldGen from '../setup/WorldGen.js';
import InfluenceRing from '../effects/InfluenceRing.js';

const NONE = Object.freeze([]);

// How strongly each gravity ring shows: brightest for the body pulling on
// him now, clearly for any other whose reach he's inside, and for the rest
// fading with how far outside the ring's edge he is.
const INFLUENCE_RING_ALPHA_PULLING = 0.9;
const INFLUENCE_RING_ALPHA_INSIDE = 0.5;
const INFLUENCE_RING_ALPHA_NEAR = 0.35;  // just outside its reach...
const INFLUENCE_RING_ALPHA_FAR = 0.05;   // ...down to this INFLUENCE_RING_FADE_DISTANCE beyond it
const INFLUENCE_RING_FADE_DISTANCE = 700;

function resetPen() {
  love.graphics.setColor(1, 1, 1, 1);
  love.graphics.setLineWidth(1);
}

const DebugDraw = {};

// R: a ring at the edge of each round gravity source's reach. Only bodies
// GravitySystem treats as plain circles (influenceRadius, not rounded
// rects); the dome's and Tiled shapes' reach isn't a circle, so a ring
// there would be wrong.
DebugDraw.influenceRings = function () {
  if (!state.showInfluenceRings) return;
  const player = state.player;
  const pulling = (player.onSurface && player.currentPlanet)
    || (state.gravitySystem && state.gravitySystem.findDominantPlanet(player.pos));
  for (const p of state.planetoids) {
    if (p.influenceRadius && !p.isRoundedRect && utils.isOnScreen(p.pos.x, p.pos.y, p.influenceRadius, 50)) {
      const dx = player.pos.x - p.pos.x, dy = player.pos.y - p.pos.y;
      const outside = Math.sqrt(dx * dx + dy * dy) - p.influenceRadius; // negative: he's within its reach
      let alpha;
      if (p === pulling) alpha = INFLUENCE_RING_ALPHA_PULLING;
      else if (outside <= 0) alpha = INFLUENCE_RING_ALPHA_INSIDE;
      else {
        const t = Math.min(1, outside / INFLUENCE_RING_FADE_DISTANCE);
        alpha = INFLUENCE_RING_ALPHA_NEAR + (INFLUENCE_RING_ALPHA_FAR - INFLUENCE_RING_ALPHA_NEAR) * t;
      }
      InfluenceRing.draw(p.pos.x, p.pos.y, p.influenceRadius, alpha);
    }
  }
};

// C: one Tiled level's collision shapes. Ground and ramps red, solid wall
// blocks blue, wall-climb loops green. Green goes last because wall-climb
// paths overlap wall blocks in the same tiles, and should stay visible.
DebugDraw.levelShapes = function (level) {
  if (!state.showCollisionDebug) return;
  const g = love.graphics;
  g.setLineWidth(4);
  g.setColor(1, 0, 0, 1);
  for (const shape of level.shapes) {
    if (shape.isWallClimb) continue;
    for (const seg of shape.segments) g.line(seg.a.x, seg.a.y, seg.b.x, seg.b.y);
  }
  g.setColor(0.2, 0.6, 1, 1);
  for (const wall of (level.walls ?? NONE)) {
    g.rectangle('line', wall.pos.x - wall.halfWidth, wall.pos.y - wall.halfHeight,
      wall.halfWidth * 2, wall.halfHeight * 2);
  }
  g.setColor(0.2, 1, 0.2, 1);
  for (const shape of level.shapes) {
    if (!shape.isWallClimb) continue;
    for (const seg of shape.segments) g.line(seg.a.x, seg.a.y, seg.b.x, seg.b.y);
  }
  resetPen();
};

// A: red over each cell of the 3x3 around him that's inside the asteroid
// belt (the cells worldGen.updateActiveCells fills with belt planetoids),
// and a blue line on every cell edge in view.
DebugDraw.beltCells = function () {
  if (!(state.showBeltCellDebug && state.player)) return;
  const g = love.graphics;
  const cellSize = worldGen.CELL_SIZE;
  const playerCell = worldGen.cellCoordFor(state.player.pos.x, state.player.pos.y);
  g.setColor(1, 0, 0, 0.35);
  for (let dRow = -1; dRow <= 1; dRow++) {
    for (let dCol = -1; dCol <= 1; dCol++) {
      const col = playerCell.col + dCol, row = playerCell.row + dRow;
      if (worldGen.cellIntersectsBelt(col, row)) g.rectangle('fill', col * cellSize, row * cellSize, cellSize, cellSize);
    }
  }
  const cam = state.camera ?? { x: 0, y: 0 };
  const visW = state.visibleWidth ?? 0, visH = state.visibleHeight ?? 0;
  const firstCol = Math.floor(cam.x / cellSize), lastCol = Math.floor((cam.x + visW) / cellSize) + 1;
  const firstRow = Math.floor(cam.y / cellSize), lastRow = Math.floor((cam.y + visH) / cellSize) + 1;
  g.setColor(0.2, 0.6, 1, 0.9);
  g.setLineWidth(2);
  for (let col = firstCol; col <= lastCol; col++) {
    const x = col * cellSize;
    g.line(x, firstRow * cellSize, x, (lastRow + 1) * cellSize);
  }
  for (let row = firstRow; row <= lastRow; row++) {
    const y = row * cellSize;
    g.line(firstCol * cellSize, y, (lastCol + 1) * cellSize, y);
  }
  resetPen();
};

// Magenta: the player's capsule (see CollisionSystem.handlePlayerWallCollisions).
// The bottom circle sits at player.pos; the top one is raised to reach his
// head. On a wall-climb shape, or as a ball, it's a plain circle.
function drawPlayerCapsule() {
  const g = love.graphics;
  const p = state.player;
  const r = p.radius;
  const onWallClimb = p.onSurface && p.currentPlanet && p.currentPlanet.isWallClimb;
  const headReach = (!p.isBall && !onWallClimb) ? (p.headReach ?? 0) : 0;
  const topY = p.pos.y - Math.max(0, headReach - r);
  const bottomY = p.pos.y;
  const px = p.pos.x;
  g.setLineWidth(3);
  g.setColor(1, 0.2, 1, 1);
  g.circle('line', px, bottomY, r);
  g.circle('line', px, topY, r);
  if (topY < bottomY) {
    g.line(px - r, topY, px - r, bottomY);
    g.line(px + r, topY, px + r, bottomY);
  }
  resetPen();
}

// Orange: where his circle first touches each Spikey
// (see CollisionSystem.handlePlayerSpikeyCollisions).
function drawSpikeyBounds() {
  if (!(state.player && state.spikeys)) return;
  const g = love.graphics;
  const playerRadius = state.player.radius;
  g.setLineWidth(3);
  g.setColor(1, 0.55, 0, 1);
  for (const sp of state.spikeys) {
    if (utils.isOnScreen(sp.pos.x, sp.pos.y, sp.radius + playerRadius, 20)) {
      g.circle('line', sp.pos.x, sp.pos.y, sp.radius + playerRadius + constants.SURFACE_TOLERANCE);
    }
  }
  resetPen();
}

// Cyan: each Ooomba's contact circle (see
// CollisionSystem.handlePlayerOoombaCollisions; fireballs use it too).
function drawOoombaBounds() {
  if (!state.ooombas) return;
  const g = love.graphics;
  g.setLineWidth(3);
  g.setColor(0.2, 0.9, 1, 1);
  for (const o of state.ooombas) {
    if (utils.isOnScreen(o.pos.x, o.pos.y, o.hitRadius, 20)) g.circle('line', o.pos.x, o.pos.y, o.hitRadius);
  }
  resetPen();
}

// Yellow: the sky dome's containment (see
// CollisionSystem.handlePlayerSkyDomeContainment): the two side walls, the
// deck, and the upper half of the glass ellipse, the only half that is
// enforced.
function drawSkyDomeBounds() {
  const dome = state.skyDomePlanet;
  if (!dome) return;
  const g = love.graphics;
  g.setLineWidth(3);
  g.setColor(1, 1, 0.2, 1);
  const deckY = dome.trueSurfaceY();
  const domeTopY = dome.domeAnchorY() - dome.domeRadiusY;
  g.line(dome.pos.x - dome.halfWidth, deckY, dome.pos.x - dome.halfWidth, domeTopY);
  g.line(dome.pos.x + dome.halfWidth, deckY, dome.pos.x + dome.halfWidth, domeTopY);
  g.line(dome.pos.x - dome.halfWidth, deckY, dome.pos.x + dome.halfWidth, deckY);
  const cx = dome.pos.x, cy = dome.domeAnchorY();
  const rx = dome.domeRadiusX, ry = dome.domeRadiusY;
  const segments = 72;
  const points = [];
  for (let i = 0; i <= segments; i++) {
    const t = Math.PI + (i / segments) * Math.PI;
    points.push(cx + Math.cos(t) * rx, cy + Math.sin(t) * ry);
  }
  g.line(points);
  resetPen();
}

// C: the player's, Spikeys', Ooombas' and the sky dome's collision shapes.
DebugDraw.collisionShapes = function () {
  if (!state.showCollisionDebug) return;
  drawPlayerCapsule();
  drawSpikeyBounds();
  drawOoombaBounds();
  drawSkyDomeBounds();
};

export default DebugDraw;
