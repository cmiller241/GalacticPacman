// js/effects/LockOutline.js
//
// Draws a pulsing yellow ring around state.player.lockedTarget.

import love from '../love/index.js';
import state from '../state.js';

const OUTLINE_R = 255 / 255, OUTLINE_G = 220 / 255, OUTLINE_B = 40 / 255;
const OUTLINE_GLOW_WIDTH = 9;
const OUTLINE_CORE_WIDTH = 3;
const OUTLINE_PADDING = 8; // how far outside the target's own silhouette the outline sits, matching PullBeam.js's own convention

const LockOutline = {};

// Deliberately simpler/single-layer rather than mirroring PullBeam.js's
// full pulsing multi-layer glow — the two need to read as clearly
// DIFFERENT things when both are visible at once (locking onto
// something, then pulling it, is an expected combined state), not
// blend into a single ambiguous glow around the same object.
//
// Shape: a true rotated rounded rect for isRoundedRect targets
// (RoundedRectPlanetoid.js's own halfWidth/halfHeight/cornerRadius/
// rotationAngle), a plain circle otherwise — matching PullBeam.js's
// own target outline exactly, so the two keep reading as the same kind
// of marker.
// Shared by draw() below (the actual L1/R1 hard lock) and
// VatsCursor.js's own hover ring (the right-stick cursor, while in
// V.A.T.S., pointing at a planet without necessarily having locked it
// yet) — both want the exact same "this is a valid target" visual, just
// driven by a different target each.
LockOutline.drawRingAround = function (target) {
  // Gentle pulse, same technique PullBeam.js uses, but a slower/subtler
  // one — this needs to read as "steady, holding a lock," not "actively
  // channeling energy" the way the pull beam's own faster pulse does.
  const pulse = (Math.sin(love.timer.getTime() * 3) + 1) / 2;

  const glowColor = [OUTLINE_R, OUTLINE_G, OUTLINE_B, 0.35 * (0.35 + pulse * 0.25)];
  const coreColor = [OUTLINE_R, OUTLINE_G, OUTLINE_B, 0.8 + pulse * 0.2];

  if (target.isRoundedRect) {
    const hw = (target.halfWidth ?? target.radius ?? 0) + OUTLINE_PADDING;
    const hh = (target.halfHeight ?? target.radius ?? 0) + OUTLINE_PADDING;
    const cr = (target.cornerRadius ?? 0) + OUTLINE_PADDING;

    love.graphics.push();
    love.graphics.translate(target.pos.x, target.pos.y);
    love.graphics.rotate(target.rotationAngle ?? 0);

    love.graphics.setLineWidth(OUTLINE_GLOW_WIDTH);
    love.graphics.setColor(glowColor);
    love.graphics.rectangle('line', -hw, -hh, hw * 2, hh * 2, cr, cr);

    love.graphics.setLineWidth(OUTLINE_CORE_WIDTH);
    love.graphics.setColor(coreColor);
    love.graphics.rectangle('line', -hw, -hh, hw * 2, hh * 2, cr, cr);

    love.graphics.pop();
  } else {
    const radius = (target.halfWidth ?? target.radius ?? 0) + OUTLINE_PADDING;

    love.graphics.setLineWidth(OUTLINE_GLOW_WIDTH);
    love.graphics.setColor(glowColor);
    love.graphics.circle('line', target.pos.x, target.pos.y, radius);

    love.graphics.setLineWidth(OUTLINE_CORE_WIDTH);
    love.graphics.setColor(coreColor);
    love.graphics.circle('line', target.pos.x, target.pos.y, radius);
  }

  love.graphics.setColor(1, 1, 1, 1);
  love.graphics.setLineWidth(1);
};

LockOutline.draw = function () {
  const player = state.player;
  if (!player || !player.lockedTarget || player.mode !== 'space') return;
  LockOutline.drawRingAround(player.lockedTarget);
};

export default LockOutline;
