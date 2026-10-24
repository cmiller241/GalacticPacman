// js/effects/LockOutline.js
import { state } from '../state.js';
import { getBoundingRadius } from '../systems/Raycast.js';

const OUTLINE_COLOR = 'rgba(255, 220, 40, 1)';
const OUTLINE_GLOW_COLOR = 'rgba(255, 220, 40, 0.35)';
const OUTLINE_CORE_WIDTH = 3;
const OUTLINE_GLOW_WIDTH = 9;
const OUTLINE_PADDING = 8; // how far outside the target's own silhouette the outline sits, matching PullBeam.js's own convention

// Draws a yellow outline around state.player.lockedTarget, shape-aware
// the same way PullBeam.js's own target outline is (a rotated rounded-
// rect for isRoundedRect planets, a plain circle otherwise) — but
// deliberately simpler/single-layer rather than mirroring that
// effect's full pulsing multi-layer glow. The two need to read as
// clearly DIFFERENT things when both are visible at once (locking onto
// something, then pulling it, is an expected combined state — see
// Player.js's tryLockTarget/L2 interaction), not blend into a single
// ambiguous glow around the same object. Called every frame from
// gameLoop, inside the same zoom/camera-transformed block as
// everything else in world space — a no-op whenever there's no active
// lock.
export function drawLockOutline() {
  const player = state.player;
  if (!player || !player.lockedTarget || player.mode !== "space") return;
  const target = player.lockedTarget;
  const ctx = state.ctx;

  // Gentle pulse, same technique PullBeam.js uses, but a slower/subtler
  // one — this needs to read as "steady, holding a lock," not "actively
  // channeling energy" the way the pull beam's own faster pulse does.
  const pulse = (Math.sin(Date.now() * 0.003) + 1) / 2;

  ctx.save();

  if (target.isRoundedRect) {
    ctx.translate(target.pos.x, target.pos.y);
    ctx.rotate(target.rotationAngle);
    const w = target.halfWidth + OUTLINE_PADDING;
    const h = target.halfHeight + OUTLINE_PADDING;
    ctx.beginPath();
    ctx.roundRect(-w, -h, w * 2, h * 2, target.cornerRadius + OUTLINE_PADDING);
  } else {
    const radius = getBoundingRadius(target);
    ctx.beginPath();
    ctx.arc(target.pos.x, target.pos.y, radius + OUTLINE_PADDING, 0, Math.PI * 2);
  }

  ctx.globalAlpha = 0.35 + pulse * 0.25;
  ctx.strokeStyle = OUTLINE_GLOW_COLOR;
  ctx.lineWidth = OUTLINE_GLOW_WIDTH;
  ctx.stroke();

  ctx.globalAlpha = 0.8 + pulse * 0.2;
  ctx.strokeStyle = OUTLINE_COLOR;
  ctx.lineWidth = OUTLINE_CORE_WIDTH;
  ctx.stroke();

  ctx.restore();
}