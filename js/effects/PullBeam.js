// js/effects/PullBeam.js
import { state } from '../state.js';

const BEAM_COLOR = 'rgba(120, 210, 255, 1)';
const BEAM_GLOW_COLOR = 'rgba(120, 210, 255, 0.35)';
const BEAM_GLOW_WIDTH = 13;
const BEAM_CORE_WIDTH = 4;

const OUTLINE_COLOR = 'rgba(120, 210, 255, 0.9)';
const OUTLINE_GLOW_COLOR = 'rgba(120, 210, 255, 0.3)';
const OUTLINE_GLOW_WIDTH = 9;
const OUTLINE_CORE_WIDTH = 3;
const OUTLINE_PADDING = 8; // how far outside the target's own silhouette the outline sits

// "Electricity" sine-wave strands that hug the beam. Two strands, at
// different phase and frequency, so they don't stay perfectly mirrored
// the whole time — that irregularity is most of what reads as
// "electric" rather than "one clean wave."
const WAVE_COLOR = 'rgba(215, 246, 255, 1)';
const WAVE_GLOW_COLOR = 'rgba(215, 246, 255, 0.4)';
const WAVE_GLOW_WIDTH = 4;
const WAVE_CORE_WIDTH = 1.5;
const WAVE_AMPLITUDE = 5;          // px, perpendicular to the beam
const WAVE_FREQUENCY = 0.05;       // radians per pixel traveled along the beam
const WAVE_FREQUENCY_2 = 0.065;    // second strand's frequency — deliberately different from the first
const WAVE_SPEED = 0.012;          // radians per ms — how fast the pattern travels toward the target
const WAVE_SAMPLE_SPACING = 8;     // px between sample points along the beam (smaller = smoother curve)

// Builds a wavy polyline (array of {x,y}) from origin to origin+dir*beamLength,
// offset perpendicular to the beam direction by a sine wave whose phase
// depends on both distance-along-beam (s) and current time — the
// "- now*speed" term is what makes the wave pattern visibly travel
// toward the target as time advances, rather than just oscillating in
// place. frequency/phaseOffset let two strands look distinct from
// each other.
function buildWavePoints(originX, originY, dirX, dirY, perpX, perpY, beamLength, frequency, phaseOffset, now) {
  const points = [];
  const numSamples = Math.max(2, Math.floor(beamLength / WAVE_SAMPLE_SPACING));
  for (let i = 0; i <= numSamples; i++) {
    const s = (i / numSamples) * beamLength;
    const wave = WAVE_AMPLITUDE * Math.sin(s * frequency - now * WAVE_SPEED + phaseOffset);
    points.push({
      x: originX + dirX * s + perpX * wave,
      y: originY + dirY * s + perpY * wave
    });
  }
  return points;
}

function strokePolyline(ctx, points) {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.stroke();
}

// Draws the light-blue "pull star" beam (straight core + two traveling
// electric-wave strands hugging it) from the player's blaster to their
// current pull target, plus a matching glowing outline around the
// target itself. Called every frame from gameLoop, inside the same
// zoom/camera-transformed block as everything else in world space — a
// no-op whenever there's no active pull target.
export function drawPullIndicator() {
  const player = state.player;
  if (!player || !player.pullTarget || player.mode !== "space") return;
  const target = player.pullTarget;
  const ctx = state.ctx;

  // Gentle breathing pulse (0..1), used to vary glow strength slightly
  // so the beam/outline read as "live energy" rather than static lines.
  const pulse = (Math.sin(Date.now() * 0.006) + 1) / 2;
  const now = Date.now();

  ctx.save();

  const originX = player.aimShoulderPos ? player.aimShoulderPos.x : player.pos.x;
  const originY = player.aimShoulderPos ? player.aimShoulderPos.y : player.pos.y;
  const dx = target.pos.x - originX;
  const dy = target.pos.y - originY;
  const beamLength = Math.sqrt(dx * dx + dy * dy);

  // --- Straight beam core ---
  ctx.beginPath();
  ctx.moveTo(originX, originY);
  ctx.lineTo(target.pos.x, target.pos.y);

  ctx.globalAlpha = 0.4 + pulse * 0.3;
  ctx.strokeStyle = BEAM_GLOW_COLOR;
  ctx.lineWidth = BEAM_GLOW_WIDTH;
  ctx.stroke();

  ctx.globalAlpha = 0.7 + pulse * 0.3;
  ctx.strokeStyle = BEAM_COLOR;
  ctx.lineWidth = BEAM_CORE_WIDTH;
  ctx.stroke();

  // --- Electric wave strands, drawn on top of the straight beam so
  // they read as "riding along" it ---
  if (beamLength > 1e-3) {
    const dirX = dx / beamLength, dirY = dy / beamLength;
    const perpX = -dirY, perpY = dirX;

    const strand1 = buildWavePoints(originX, originY, dirX, dirY, perpX, perpY, beamLength, WAVE_FREQUENCY, 0, now);
    const strand2 = buildWavePoints(originX, originY, dirX, dirY, perpX, perpY, beamLength, WAVE_FREQUENCY_2, Math.PI, now);

    ctx.globalAlpha = 0.3 + pulse * 0.25;
    ctx.strokeStyle = WAVE_GLOW_COLOR;
    ctx.lineWidth = WAVE_GLOW_WIDTH;
    strokePolyline(ctx, strand1);
    strokePolyline(ctx, strand2);

    ctx.globalAlpha = 0.6 + pulse * 0.3;
    ctx.strokeStyle = WAVE_COLOR;
    ctx.lineWidth = WAVE_CORE_WIDTH;
    strokePolyline(ctx, strand1);
    strokePolyline(ctx, strand2);
  }

  // --- Outline around the target planet, matching its actual shape. ---
  if (target.isRoundedRect) {
    ctx.save();
    ctx.translate(target.pos.x, target.pos.y);
    ctx.rotate(target.rotationAngle);
    const w = target.halfWidth + OUTLINE_PADDING;
    const h = target.halfHeight + OUTLINE_PADDING;
    ctx.beginPath();
    ctx.roundRect(-w, -h, w * 2, h * 2, target.cornerRadius + OUTLINE_PADDING);

    ctx.globalAlpha = 0.4 + pulse * 0.4;
    ctx.strokeStyle = OUTLINE_GLOW_COLOR;
    ctx.lineWidth = OUTLINE_GLOW_WIDTH;
    ctx.stroke();

    ctx.globalAlpha = 0.7 + pulse * 0.3;
    ctx.strokeStyle = OUTLINE_COLOR;
    ctx.lineWidth = OUTLINE_CORE_WIDTH;
    ctx.stroke();
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.arc(target.pos.x, target.pos.y, target.radius + OUTLINE_PADDING, 0, Math.PI * 2);

    ctx.globalAlpha = 0.4 + pulse * 0.4;
    ctx.strokeStyle = OUTLINE_GLOW_COLOR;
    ctx.lineWidth = OUTLINE_GLOW_WIDTH;
    ctx.stroke();

    ctx.globalAlpha = 0.7 + pulse * 0.3;
    ctx.strokeStyle = OUTLINE_COLOR;
    ctx.lineWidth = OUTLINE_CORE_WIDTH;
    ctx.stroke();
  }

  ctx.restore();
}