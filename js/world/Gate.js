// js/world/Gate.js
//
// A vertical sliding barrier spanning the gap between a solid floor
// tile below and a solid ceiling tile above (see TiledTerrain.js's own
// gateSpawns — topY/bottomY are already resolved there). Blocks the
// player like any other solid wall while closed; opening slides its own
// BOTTOM edge upward until it's fully retracted flush with the ceiling
// (closing reverses that) — reads as a portcullis sliding into a slot.
//
// Controlled by a Lever (see main.js's own spawn wiring, lever.gate =
// gate) — setOpen(bool) is the only thing anything else needs to call.
//
// Doubles as BOTH a drawable/updatable entity (state.gates) AND a plain
// collision "wall" record — inserted directly into the level's own
// `walls` array, so CollisionSystem.handlePlayerWallCollisions picks it
// up through the same pos/halfWidth/halfHeight fields every other wall
// entry has, just recomputed every frame as it slides.

import love from '../love/index.js';
import Vector2 from '../vector2.js';

// Fraction of a full open<->close slide covered per baseline tick — a
// short gap slides just as fast start-to-finish as a tall one.
const SLIDE_SPEED_PER_TICK = 0.02; // ~50 baseline (60fps) ticks for a full 0->1 slide

const COLOR_FRAME = [0.32, 0.30, 0.28];
const COLOR_BAR = [0.55, 0.52, 0.46];
const BAR_SPACING = 18; // world units between horizontal cross-bars, cage/portcullis look
const BAR_THICKNESS = 4;

class Gate {
  // x: world position of the gate's own center column. topY/bottomY: the
  // CLOSED extent. halfWidth: how thick the bar is, left-right.
  static new(x, topY, bottomY, halfWidth) {
    return new Gate(x, topY, bottomY, halfWidth);
  }

  constructor(x, topY, bottomY, halfWidth) {
    // Lets things sharing the walls list tell a Gate apart from an
    // ordinary wall tile (which has isWall) — portal shots and Ooombas
    // treat a closed gate as solid.
    this.isGate = true;

    this.topY = topY;
    this.bottomYClosed = bottomY;
    this.halfWidth = halfWidth;

    // true = target is fully OPEN; false = fully CLOSED. slideProgress
    // is what actually animates toward it.
    this.isOpen = false;

    // 0 = fully closed, 1 = fully open (collapsed to near zero height at topY).
    this.slideProgress = 0;

    // Collision fields — same shape every other wall entry exposes,
    // kept in sync every frame by update().
    this.pos = new Vector2(x, (topY + bottomY) / 2);
    this.halfHeight = (bottomY - topY) / 2;
    this.radius = Math.sqrt(this.halfWidth * this.halfWidth + this.halfHeight * this.halfHeight);
  }

  // Called by whichever Lever controls this gate — just sets the TARGET.
  setOpen(isOpen) {
    this.isOpen = isOpen;
  }

  update(ts) {
    const target = this.isOpen ? 1 : 0;
    if (this.slideProgress < target) {
      this.slideProgress = Math.min(target, this.slideProgress + SLIDE_SPEED_PER_TICK * ts);
    } else if (this.slideProgress > target) {
      this.slideProgress = Math.max(target, this.slideProgress - SLIDE_SPEED_PER_TICK * ts);
    }

    // Bottom edge rises from bottomYClosed up to topY as slideProgress
    // goes 0 -> 1.
    const currentBottomY = this.bottomYClosed - this.slideProgress * (this.bottomYClosed - this.topY);

    // Floored just above zero — a defensive floor against a literal
    // zero-size box.
    this.halfHeight = Math.max(0.001, (currentBottomY - this.topY) / 2);
    this.pos.y = (this.topY + currentBottomY) / 2;
    this.radius = Math.sqrt(this.halfWidth * this.halfWidth + this.halfHeight * this.halfHeight);
  }

  draw() {
    if (this.halfHeight <= 0.5) return; // fully (or near-fully) retracted

    const x0 = this.pos.x - this.halfWidth;
    const x1 = this.pos.x + this.halfWidth;
    const y0 = this.pos.y - this.halfHeight;
    const y1 = this.pos.y + this.halfHeight;

    love.graphics.setColor(COLOR_FRAME);
    love.graphics.rectangle('fill', x0, y0, x1 - x0, y1 - y0);

    // Horizontal cross-bars, cage/portcullis texture.
    love.graphics.setColor(COLOR_BAR);
    for (let y = y0; y < y1; y += BAR_SPACING) {
      love.graphics.rectangle('fill', x0, y - BAR_THICKNESS / 2, x1 - x0, BAR_THICKNESS);
    }

    love.graphics.setColor(1, 1, 1, 1);
  }
}

export default Gate;
