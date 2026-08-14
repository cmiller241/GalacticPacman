// js/effects/AimIndicator.js
import { state } from '../state.js';

const X_COLOR = 'rgba(255, 40, 40, 1)';
const X_GLOW_COLOR = 'rgba(255, 40, 40, 0.35)';
const X_ARM_LENGTH = 14; // half-length of each of the X's two arms, in px
const X_CORE_WIDTH = 5;
const X_GLOW_WIDTH = 11;
const X_DISTANCE_PAST_MUZZLE = 200; // px past the muzzle when the aim ray doesn't hit anything

// Draws a thick red X either on the nearest occluder along the current
// aim ray (see Player.js's computeLeftArmAimAngle, which caches this
// each frame via Raycast.js's findNearestOccluder), or a fixed
// distance past the blaster's muzzle tip when the ray doesn't hit
// anything. Only shown while state.gamepadAimActive is true — i.e. the
// right stick is actively being pushed this frame — since the whole
// point is showing where a shot would land while actively steering
// aim with the stick; it isn't needed for mouse aim (the cursor itself
// already shows that) or while the stick is simply centered.
// Deliberately axis-aligned (not rotated to match the aim angle) — an
// "X marks the spot" style marker reads more clearly upright than
// rotated, the same way a map marker or crosshair usually would.
// Called every frame from gameLoop, inside the same zoom/camera-
// transformed block as everything else in world space — a no-op
// whenever the player has no aim yet (very first frame or two) or
// isn't in "space" mode.
export function drawAimIndicator() {
  const player = state.player;
  if (!player || player.mode !== "space" || !player.aimShoulderPos) return;
  if (!state.gamepadAimActive) return;
  // Suppressed while hard-locked (see Player.js's lockedTarget /
  // LockOutline.js) — the yellow lock outline already unambiguously
  // shows the target, and aim is forced onto it anyway, so the X would
  // just sit redundantly on top of that outline.
  if (player.lockedTarget) return;

  let markX, markY;
  if (player.aimTargetPoint) {
    markX = player.aimTargetPoint.x;
    markY = player.aimTargetPoint.y;
  } else {
    const angle = player.aimWorldAngle + player.blasterAngleOffset;
    const muzzleDist = player.blasterMuzzleLength * player.bodyScale;
    const dirX = Math.cos(angle), dirY = Math.sin(angle);
    const muzzleX = player.aimShoulderPos.x + dirX * muzzleDist;
    const muzzleY = player.aimShoulderPos.y + dirY * muzzleDist;
    markX = muzzleX + dirX * X_DISTANCE_PAST_MUZZLE;
    markY = muzzleY + dirY * X_DISTANCE_PAST_MUZZLE;
  }

  const ctx = state.ctx;
  ctx.save();

  ctx.beginPath();
  ctx.moveTo(markX - X_ARM_LENGTH, markY - X_ARM_LENGTH);
  ctx.lineTo(markX + X_ARM_LENGTH, markY + X_ARM_LENGTH);
  ctx.moveTo(markX + X_ARM_LENGTH, markY - X_ARM_LENGTH);
  ctx.lineTo(markX - X_ARM_LENGTH, markY + X_ARM_LENGTH);

  ctx.strokeStyle = X_GLOW_COLOR;
  ctx.lineWidth = X_GLOW_WIDTH;
  ctx.lineCap = 'round';
  ctx.stroke();

  ctx.strokeStyle = X_COLOR;
  ctx.lineWidth = X_CORE_WIDTH;
  ctx.stroke();

  ctx.restore();
}