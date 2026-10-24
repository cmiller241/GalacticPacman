// js/effects/CameraShake.js
//
// Screen shake: the whole view jolting about chaotically for a moment —
// big hits, like Bob crashing into a planet off a cannon shot (see
// js/world/Cannon.js). Mostly side to side, some up and down, dying
// away over its duration.
//
// Only ever moves what's DRAWN (see main.js's love.draw wrapper, which
// offsets the camera for the draw and puts it back after): the real
// camera, and everything that reads it — streaming, culling, aiming —
// never shakes. The HUD and minimap, drawn in screen space, stay still.
//
// Runs on real time, not game time: it's a jolt to the eye, and
// V.A.T.S. slow-mo shouldn't drag it out.

import love from '../love/index.js';

const CameraShake = {};

let active = null; // { start, duration, strength, seed }

// strength: how far it can throw the view, in screen pixels at its
// start. duration: seconds until it's died away. A weaker shake than
// one already going doesn't replace it.
CameraShake.start = function (strength, duration) {
  const now = love.timer.getTime();
  if (active) {
    const left = 1 - (now - active.start) / active.duration;
    if (left > 0 && active.strength * left * left >= strength) return;
  }
  active = { start: now, duration, strength, seed: Math.random() * 100 };
};

// This moment's offset, in screen pixels ([0, 0] when nothing's shaking).
CameraShake.offset = function () {
  if (!active) return [0, 0];
  const now = love.timer.getTime();
  const t = (now - active.start) / active.duration;
  if (t >= 1) {
    active = null;
    return [0, 0];
  }
  const fade = (1 - t) * (1 - t);
  const e = now - active.start, s = active.seed;
  // Sines at frequencies that never line up, plus a little noise: it
  // jerks about rather than swinging back and forth evenly.
  const x = Math.sin(e * 61 + s) * 0.55 + Math.sin(e * 97 + s * 1.7) * 0.3 + (Math.random() - 0.5) * 0.3;
  const y = Math.sin(e * 73 + s * 2.3) * 0.55 + Math.sin(e * 113 + s * 0.6) * 0.3 + (Math.random() - 0.5) * 0.3;
  return [x * active.strength * fade, y * active.strength * fade * 0.55];
};

export default CameraShake;
