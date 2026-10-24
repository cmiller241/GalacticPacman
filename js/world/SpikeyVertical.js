// js/world/SpikeyVertical.js
//
// Exactly like Spikey (js/world/Spikey.js) — same look, same lethal/
// solid/wall-jumpable contact behavior (it's in the same state.spikeys
// list) — except it patrols up and down within a shaft, reversing
// direction the instant it reaches whatever blocks it on either end (a
// solid wall/floor tile, or another Spikey sitting in its path), forever.
//
// topY/bottomY (the full patrol range) are resolved ONCE, at spawn time
// — see TiledTerrain.js's own tile-grid scan for the wall half, and
// main.js's own spawn wiring for the "clamped further by any nearby
// static Spikey" half.

import Vector2 from '../vector2.js';
import state from '../state.js';
import Spikey from './Spikey.js';

class SpikeyVertical {
  // x: world column (fixed). topY/bottomY: the full patrol range. radius:
  // same meaning as Spikey's own. speed (optional): world units per
  // baseline tick — the Tiled object's own "speed" custom property.
  static new(x, topY, bottomY, radius, speed) {
    return new SpikeyVertical(x, topY, bottomY, radius, speed);
  }

  constructor(x, topY, bottomY, radius, speed) {
    this.pos = new Vector2(x, topY);
    this.radius = radius ?? Spikey.DEFAULT_RADIUS;
    this.topY = topY;
    this.bottomY = bottomY;
    this.speed = speed ?? SpikeyVertical.DEFAULT_SPEED;
    // Starts at the top of its own range and heads down first.
    this.direction = 1; // 1 = moving down (toward bottomY), -1 = moving up (toward topY)
  }

  update() {
    const timeScale = state.timeScale ?? 1;
    const dy = this.direction * this.speed * timeScale;
    let desiredY = this.pos.y + dy;
    if (desiredY > this.bottomY) {
      desiredY = this.bottomY;
      this.direction = -1;
    } else if (desiredY < this.topY) {
      desiredY = this.topY;
      this.direction = 1;
    }
    this.pos.y = desiredY;
  }

  // Identical visuals to a plain Spikey.
  draw() {
    Spikey.drawBody(this);
  }
}

// World units per baseline (60fps) tick.
SpikeyVertical.DEFAULT_SPEED = 1.2;

export default SpikeyVertical;
