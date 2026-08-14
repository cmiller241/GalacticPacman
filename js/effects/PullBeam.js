// js/effects/PullBeam.js
import { state } from '../state.js';
import { Graphics } from 'pixi.js';

// Parses an 'rgba(r,g,b,a)' string into {color, alpha} — needed because
// the original code relies on Canvas2D automatically MULTIPLYING a
// strokeStyle color's own baked-in alpha (e.g. BEAM_GLOW_COLOR's own
// 0.35) together with a separately-set ctx.globalAlpha (e.g.
// 0.4 + pulse*0.3) — Pixi's own stroke({alpha}) is a single value with
// no such automatic combination, so reproducing the same visual
// requires parsing each color's own alpha out and multiplying it by
// the dynamic pulse value by hand wherever it's used below.
function parseRgba(rgbaString) {
  const match = rgbaString.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!match) return { color: 0xffffff, alpha: 1 };
  const r = parseInt(match[1], 10);
  const g = parseInt(match[2], 10);
  const b = parseInt(match[3], 10);
  const a = match[4] !== undefined ? parseFloat(match[4]) : 1;
  return { color: (r << 16) | (g << 8) | b, alpha: a };
}

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

// Parsed once at module load — these are fixed constants, not
// per-frame values, so there's no reason to re-parse the same string
// every frame.
const BEAM_GLOW_PARSED = parseRgba(BEAM_GLOW_COLOR);
const BEAM_CORE_PARSED = parseRgba(BEAM_COLOR);
const WAVE_GLOW_PARSED = parseRgba(WAVE_GLOW_COLOR);
const WAVE_CORE_PARSED = parseRgba(WAVE_COLOR);
const OUTLINE_GLOW_PARSED = parseRgba(OUTLINE_GLOW_COLOR);
const OUTLINE_CORE_PARSED = parseRgba(OUTLINE_COLOR);

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

// ----------------------------
// PIXI RENDERING — a single, global overlay tied to
// state.player.pullTarget, not a per-entity effect the way everything
// else in this migration has been, so there's no class/instance here
// to attach createPixiSprite/updatePixiSprite methods to. Instead,
// exactly one set of Graphics objects, module-level, lazily built on
// first actual use and toggled visible/invisible based on whether a
// pull is currently active, rather than created/destroyed repeatedly.
// Every piece of this — beam length/direction (player moves every
// frame), the wave strands (continuously time-driven trig across many
// sample points), and the outline (drawn fresh for whichever target
// happens to be active, unknown in advance) — is genuinely dynamic,
// so unlike most of this migration there's nothing here worth baking
// once; all eight Graphics objects below get cleared and redrawn every
// frame, same reasoning as Explosion's own ring: cheap and short work
// for a small, fixed, non-multiplied object count.
// ----------------------------
let pixiBeamGlow, pixiBeamCore;
let pixiWave1Glow, pixiWave1Core, pixiWave2Glow, pixiWave2Core;
let pixiOutlineGlow, pixiOutlineCore;

function ensurePixiObjects(layer) {
  if (pixiBeamGlow) return;
  pixiBeamGlow = new Graphics();
  pixiBeamCore = new Graphics();
  pixiWave1Glow = new Graphics();
  pixiWave1Core = new Graphics();
  pixiWave2Glow = new Graphics();
  pixiWave2Core = new Graphics();
  pixiOutlineGlow = new Graphics();
  pixiOutlineCore = new Graphics();
  // Insertion order matches draw()'s own stroke order exactly: beam
  // glow, beam core, BOTH wave strands' glow passes, THEN both
  // strands' core passes (matching the original's own "all glows,
  // then all cores" grouping, not glow+core per strand), outline glow,
  // outline core.
  layer.addChild(
    pixiBeamGlow, pixiBeamCore,
    pixiWave1Glow, pixiWave2Glow, pixiWave1Core, pixiWave2Core,
    pixiOutlineGlow, pixiOutlineCore
  );
}

function setAllVisible(visible) {
  pixiBeamGlow.visible = visible;
  pixiBeamCore.visible = visible;
  pixiWave1Glow.visible = visible;
  pixiWave1Core.visible = visible;
  pixiWave2Glow.visible = visible;
  pixiWave2Core.visible = visible;
  pixiOutlineGlow.visible = visible;
  pixiOutlineCore.visible = visible;
}

// Clears and redraws a single polyline stroke on the given Graphics
// object — the Pixi equivalent of strokePolyline() above, since a
// live Graphics redraw is how this migration reproduces "clear the
// path and stroke a fresh one" for anything whose geometry changes
// every frame.
function strokePolylinePixi(graphics, points, width, color, alpha) {
  graphics.clear();
  if (points.length < 2) return;
  graphics.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    graphics.lineTo(points[i].x, points[i].y);
  }
  graphics.stroke({ width, color, alpha });
}

// Called every frame in place of drawPullIndicator() once migrated.
export function updatePullIndicator(layer) {
  const player = state.player;
  const active = player && player.pullTarget && player.mode === "space";

  if (!active) {
    if (pixiBeamGlow) setAllVisible(false);
    return;
  }

  ensurePixiObjects(layer);
  setAllVisible(true);

  const target = player.pullTarget;
  const pulse = (Math.sin(Date.now() * 0.006) + 1) / 2;
  const now = Date.now();

  const originX = player.aimShoulderPos ? player.aimShoulderPos.x : player.pos.x;
  const originY = player.aimShoulderPos ? player.aimShoulderPos.y : player.pos.y;
  const dx = target.pos.x - originX;
  const dy = target.pos.y - originY;
  const beamLength = Math.sqrt(dx * dx + dy * dy);

  // --- Straight beam core ---
  pixiBeamGlow.clear();
  pixiBeamGlow
    .moveTo(originX, originY)
    .lineTo(target.pos.x, target.pos.y)
    .stroke({ width: BEAM_GLOW_WIDTH, color: BEAM_GLOW_PARSED.color, alpha: BEAM_GLOW_PARSED.alpha * (0.4 + pulse * 0.3) });

  pixiBeamCore.clear();
  pixiBeamCore
    .moveTo(originX, originY)
    .lineTo(target.pos.x, target.pos.y)
    .stroke({ width: BEAM_CORE_WIDTH, color: BEAM_CORE_PARSED.color, alpha: BEAM_CORE_PARSED.alpha * (0.7 + pulse * 0.3) });

  // --- Electric wave strands ---
  if (beamLength > 1e-3) {
    const dirX = dx / beamLength, dirY = dy / beamLength;
    const perpX = -dirY, perpY = dirX;

    const strand1 = buildWavePoints(originX, originY, dirX, dirY, perpX, perpY, beamLength, WAVE_FREQUENCY, 0, now);
    const strand2 = buildWavePoints(originX, originY, dirX, dirY, perpX, perpY, beamLength, WAVE_FREQUENCY_2, Math.PI, now);

    const glowAlpha = WAVE_GLOW_PARSED.alpha * (0.3 + pulse * 0.25);
    strokePolylinePixi(pixiWave1Glow, strand1, WAVE_GLOW_WIDTH, WAVE_GLOW_PARSED.color, glowAlpha);
    strokePolylinePixi(pixiWave2Glow, strand2, WAVE_GLOW_WIDTH, WAVE_GLOW_PARSED.color, glowAlpha);

    const coreAlpha = WAVE_CORE_PARSED.alpha * (0.6 + pulse * 0.3);
    strokePolylinePixi(pixiWave1Core, strand1, WAVE_CORE_WIDTH, WAVE_CORE_PARSED.color, coreAlpha);
    strokePolylinePixi(pixiWave2Core, strand2, WAVE_CORE_WIDTH, WAVE_CORE_PARSED.color, coreAlpha);
  } else {
    pixiWave1Glow.clear();
    pixiWave2Glow.clear();
    pixiWave1Core.clear();
    pixiWave2Core.clear();
  }

  // --- Outline around the target planet, matching its actual shape.
  // position+rotation handle the rect case's own translate+rotate —
  // Pixi's own transform system does this instead of computing
  // rotated points by hand. Circles are rotationally symmetric, so
  // rotation is just left at 0 for that case rather than needing a
  // branch to skip setting it. ---
  pixiOutlineGlow.position.set(target.pos.x, target.pos.y);
  pixiOutlineCore.position.set(target.pos.x, target.pos.y);

  if (target.isRoundedRect) {
    pixiOutlineGlow.rotation = target.rotationAngle;
    pixiOutlineCore.rotation = target.rotationAngle;
    const w = target.halfWidth + OUTLINE_PADDING;
    const h = target.halfHeight + OUTLINE_PADDING;
    const cornerRadius = target.cornerRadius + OUTLINE_PADDING;

    pixiOutlineGlow.clear();
    pixiOutlineGlow
      .roundRect(-w, -h, w * 2, h * 2, cornerRadius)
      .stroke({ width: OUTLINE_GLOW_WIDTH, color: OUTLINE_GLOW_PARSED.color, alpha: OUTLINE_GLOW_PARSED.alpha * (0.4 + pulse * 0.4) });

    pixiOutlineCore.clear();
    pixiOutlineCore
      .roundRect(-w, -h, w * 2, h * 2, cornerRadius)
      .stroke({ width: OUTLINE_CORE_WIDTH, color: OUTLINE_CORE_PARSED.color, alpha: OUTLINE_CORE_PARSED.alpha * (0.7 + pulse * 0.3) });
  } else {
    pixiOutlineGlow.rotation = 0;
    pixiOutlineCore.rotation = 0;
    const r = target.radius + OUTLINE_PADDING;

    pixiOutlineGlow.clear();
    pixiOutlineGlow
      .circle(0, 0, r)
      .stroke({ width: OUTLINE_GLOW_WIDTH, color: OUTLINE_GLOW_PARSED.color, alpha: OUTLINE_GLOW_PARSED.alpha * (0.4 + pulse * 0.4) });

    pixiOutlineCore.clear();
    pixiOutlineCore
      .circle(0, 0, r)
      .stroke({ width: OUTLINE_CORE_WIDTH, color: OUTLINE_CORE_PARSED.color, alpha: OUTLINE_CORE_PARSED.alpha * (0.7 + pulse * 0.3) });
  }
}