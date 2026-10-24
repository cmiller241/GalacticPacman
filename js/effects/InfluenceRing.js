// js/effects/InfluenceRing.js
//
// A planetoid's dashed influence-radius ring — a visual debug aid
// showing how far a planetoid's gravity actually reaches, toggled with
// 'R' (see InputHandlers.js). Drawn directly as short chords around the
// circle — cheap enough not to need baking, since it only ever runs for
// on-screen planetoids while the toggle is on.

import love from '../love/index.js';

const InfluenceRing = {};

const DASH_LENGTH = 10;
const GAP_LENGTH = 5;
const LINE_WIDTH = 3;
const COLOR = [173 / 255, 216 / 255, 230 / 255];

// alpha: how strongly to draw it — decided by the caller (see the ring
// pass in main.js's love.draw) from how much this body's gravity
// matters to the player right now, rather than drawing every ring on
// screen at full strength.
InfluenceRing.draw = function (x, y, radius, alpha) {
  if (radius <= 0 || alpha <= 0) return;

  const period = DASH_LENGTH + GAP_LENGTH;
  const circumference = 2 * Math.PI * radius;
  // Whole number of dash+gap periods around the circle, so the pattern
  // joins up cleanly instead of leaving one oddly-sized dash where it
  // wraps back to the start.
  const segmentCount = Math.max(1, Math.floor(circumference / period));
  const angleStep = (2 * Math.PI) / segmentCount;
  const dashAngle = angleStep * (DASH_LENGTH / period);

  love.graphics.setColor(COLOR[0], COLOR[1], COLOR[2], alpha);
  love.graphics.setLineWidth(LINE_WIDTH);
  for (let i = 0; i < segmentCount; i++) {
    const a0 = i * angleStep;
    const a1 = a0 + dashAngle;
    love.graphics.line(
      x + Math.cos(a0) * radius, y + Math.sin(a0) * radius,
      x + Math.cos(a1) * radius, y + Math.sin(a1) * radius,
    );
  }

  love.graphics.setColor(1, 1, 1, 1);
  love.graphics.setLineWidth(1);
};

export default InfluenceRing;
