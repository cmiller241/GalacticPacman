// js/effects/VatsCursor.js
//
// While V.A.T.S. is active, the right stick drives a free-roaming
// on-screen cursor (a red X, fixed to the screen, not the world) instead
// of the ordinary fixed-length aim ray it drives the rest of the time
// (see GamePadInput.js's own comment on gamepadRightStickX/Y). Landing
// the cursor on a planet makes it the actual lock (player.lockedTarget) —
// the same one L1/R1 cycling and LockOutline.js's ring already revolve
// around — so there's a single source of truth for "what's highlighted"
// and "what L2 pulls toward" rather than a separate cosmetic hover layer
// that visually agrees with the lock but functionally ignores it.

import love from '../love/index.js';
import state from '../state.js';

// Px/second at full stick deflection. Deliberately NOT scaled by
// state.timeScale (V.A.T.S.'s own slow-mo) — this cursor is a UI layer
// riding on TOP of the slowdown, not part of the slowed simulation
// itself. A cursor that crawled at the same crawl as the slowed-down
// world would defeat V.A.T.S.'s whole point: carefully aiming WHILE
// everything else is slow, not slowly aiming too.
const CURSOR_SPEED = 900;
const CURSOR_SIZE = 14;
const CURSOR_THICKNESS = 3;
const CURSOR_COLOR = [1, 0.15, 0.15, 1];

const VatsCursor = {};

// Tracked so entering V.A.T.S. always starts the cursor fresh at screen
// center, rather than picking up wherever a PREVIOUS V.A.T.S. session
// left it.
let wasActive = false;

// The hover target as of LAST frame — see update()'s own use below.
// Locking only fires the moment the cursor ARRIVES on a (different)
// planet, not on every single frame it merely continues resting there;
// without that distinction, resting the cursor anywhere would silently
// fight L1/R1 forever afterward, re-snapping the lock straight back the
// instant a shoulder-button press tried to change it to something else.
let lastHoverTarget = null;

function findHoverTarget(worldX, worldY) {
  // Whatever the player is currently standing on is excluded, matching
  // TargetLock.js's own gatherLockCandidates rule.
  const standingOn = (state.player && state.player.onSurface) ? state.player.currentPlanet : null;

  let best = null, bestDistSq = Infinity;
  for (const planet of state.planetoids) {
    if (planet !== standingOn && !planet.isPullExempt) {
      let hit;
      if (planet.containsPoint) {
        hit = planet.containsPoint(worldX, worldY);
      } else {
        const dx = worldX - planet.pos.x, dy = worldY - planet.pos.y;
        const r = planet.radius ?? 0;
        hit = (dx * dx + dy * dy) <= r * r;
      }
      if (hit) {
        const dx = worldX - planet.pos.x, dy = worldY - planet.pos.y;
        const distSq = dx * dx + dy * dy;
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          best = planet;
        }
      }
    }
  }
  return best;
}

// Called once per frame from main.js's love.update, with the REAL
// (unscaled) frame dt.
VatsCursor.update = function (dt) {
  if (!state.vatsActive) {
    wasActive = false;
    lastHoverTarget = null;
    return;
  }

  const screenW = love.graphics.getWidth(), screenH = love.graphics.getHeight();

  if (!wasActive) {
    state.vatsCursorX = screenW / 2;
    state.vatsCursorY = screenH / 2;
    wasActive = true;
  }

  const dx = state.gamepadRightStickX ?? 0;
  const dy = state.gamepadRightStickY ?? 0;
  state.vatsCursorX = Math.max(0, Math.min(screenW, state.vatsCursorX + dx * CURSOR_SPEED * dt));
  state.vatsCursorY = Math.max(0, Math.min(screenH, state.vatsCursorY + dy * CURSOR_SPEED * dt));

  const cam = state.camera ?? { x: 0, y: 0 };
  const zoom = state.zoom ?? 1;
  const worldX = state.vatsCursorX / zoom + cam.x;
  const worldY = state.vatsCursorY / zoom + cam.y;
  const hoverTarget = findHoverTarget(worldX, worldY);

  // Edge-triggered: only on actually ARRIVING at a new planet. Landing
  // on empty space never clears an existing lock; only landing on a
  // DIFFERENT planet replaces it.
  if (hoverTarget && hoverTarget !== lastHoverTarget && state.player) {
    state.player.lockedTarget = hoverTarget;
  }
  lastHoverTarget = hoverTarget;
};

// Screen-space: call AFTER the camera transform is popped (see
// main.js's love.draw, alongside the minimap/HUD text) so the cursor
// stays fixed on screen like an actual mouse cursor.
VatsCursor.drawReticle = function () {
  if (!state.vatsActive || state.vatsCursorX == null) return;
  const x = state.vatsCursorX, y = state.vatsCursorY;

  love.graphics.setLineWidth(CURSOR_THICKNESS);
  love.graphics.setColor(CURSOR_COLOR[0], CURSOR_COLOR[1], CURSOR_COLOR[2], CURSOR_COLOR[3]);
  love.graphics.line(x - CURSOR_SIZE, y - CURSOR_SIZE, x + CURSOR_SIZE, y + CURSOR_SIZE);
  love.graphics.line(x - CURSOR_SIZE, y + CURSOR_SIZE, x + CURSOR_SIZE, y - CURSOR_SIZE);
  love.graphics.setColor(1, 1, 1, 1);
  love.graphics.setLineWidth(1);
};

export default VatsCursor;
