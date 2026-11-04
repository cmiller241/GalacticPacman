// js/world/SpikeyOrbit.js
//
// Exactly like Spikey (js/world/Spikey.js) — same look, same lethal/
// solid/wall-jumpable contact behavior (it's in the same state.spikeys
// list) — except it orbits clockwise around another entity (its own
// "orbit" Tiled property, resolved to an actual spawned object by
// main.js's own spawn wiring).
//
// The orbit radius and starting angle are both derived ONCE, at spawn
// time, from wherever the level designer actually placed the object in
// Tiled relative to the thing it orbits — moving the point in Tiled and
// reloading the level just works.

import Vector2 from '../vector2.js';
import state from '../state.js';
import Spikey from './Spikey.js';

class SpikeyOrbit {
  // x, y: this object's own spawn position (used only to derive the orbit
  // radius/starting angle). center: the entity being orbited (anything
  // with a live .pos). radius: this body's OWN collision size. speed
  // (optional): tangential world units per baseline tick.
  static new(x, y, center, radius, speed) {
    return new SpikeyOrbit(x, y, center, radius, speed);
  }

  constructor(x, y, center, radius, speed) {
    this.center = center;
    this.radius = radius ?? Spikey.DEFAULT_RADIUS;

    const dx = x - center.pos.x, dy = y - center.pos.y;
    this.orbitRadius = Math.sqrt(dx * dx + dy * dy);
    // 0 = +x/right, increasing clockwise (y grows downward on screen).
    this.orbitAngle = Math.atan2(dy, dx);

    const tangentialSpeed = speed ?? SpikeyOrbit.DEFAULT_SPEED;
    // Degenerate only if placed exactly on top of what it orbits — holds
    // still rather than dividing by zero.
    this.angularSpeed = (this.orbitRadius > 0) ? (tangentialSpeed / this.orbitRadius) : 0;

    this.pos = new Vector2(x, y);
  }

  update() {
    const timeScale = state.timeScale ?? 1;
    this.orbitAngle += this.angularSpeed * timeScale;
    this.pos.x = this.center.pos.x + this.orbitRadius * Math.cos(this.orbitAngle);
    this.pos.y = this.center.pos.y + this.orbitRadius * Math.sin(this.orbitAngle);
  }

  // Identical visuals to a plain Spikey.
  draw() {
    Spikey.drawBody(this);
  }
}

// Same meaning as SpikeyVertical.DEFAULT_SPEED (world units of actual
// travel per baseline tick), converted to an angular rate internally.
SpikeyOrbit.DEFAULT_SPEED = 1.2;

export default SpikeyOrbit;
