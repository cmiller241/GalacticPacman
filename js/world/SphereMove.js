// js/world/SphereMove.js
//
// Exactly Sphere (js/world/Sphere.js) — same body, same metallic
// GPU-shaded look, same full Planetoid treatment (gravity, landing,
// pull-beam targeting) — just not sitting still. Built directly on top
// of Sphere.new; the only thing added here is an update() that drives
// this.pos along a fixed back-and-forth path (Sphere's own
// isImmovable/vel-zeroing keeps updatePlanetoidsPhysics from fighting
// that).
//
// Path: from wherever it's actually placed in Tiled (its own x/y) to its
// "start" point ONCE, then forever back and forth between "start" and
// "end" (Tiled custom properties startX/startY/endX/endY/speed).

import Vector2 from '../vector2.js';
import state from '../state.js';
import Sphere from './Sphere.js';

const SphereMove = {};

// World units of actual travel per baseline (60fps) tick.
SphereMove.DEFAULT_SPEED = 5;

function sphereMoveUpdate() {
  const timeScale = state.timeScale ?? 1;
  const toTarget = this.target.subtract(this.pos);
  const dist = toTarget.length();
  const step = this.speed * timeScale;

  if (dist <= step) {
    // Reached (or would overshoot) this leg's target — snap exactly onto
    // it, then flip to the OTHER fixed point for the next leg (compared
    // by reference: those are the only two objects target is ever set to).
    this.pos.x = this.target.x;
    this.pos.y = this.target.y;
    this.target = (this.target === this.startPoint) ? this.endPoint : this.startPoint;
  } else {
    this.pos.addScaled(toTarget.normalize(), step);
  }
}

// x, y: wherever the object actually sits in Tiled — only used for the
// very first leg of the path. startX/startY, endX/endY: the two points
// it patrols between forever after that.
SphereMove.new = function (x, y, startX, startY, endX, endY, radius, speed) {
  const self = Sphere.new(x, y, radius);

  self.startPoint = new Vector2(startX, startY);
  self.endPoint = new Vector2(endX, endY);
  self.target = self.startPoint;
  self.speed = speed ?? SphereMove.DEFAULT_SPEED;

  self.update = sphereMoveUpdate;

  return self;
};

export default SphereMove;
