// js/pullbeam.js
//
// Port of lua/effects/PullBeam.lua for the website's pull-beam fast
// travel (see js/bob.js's Rig "pulling" mode). All additive light:
//   * the beam itself — the game's shader (run through js/fx.js): a hot
//     white core, a cyan body of rippling plasma flaring wider toward the
//     target, bands of energy streaming back toward Bob;
//   * two strands twisting round it as a helix, pinned at both ends, and
//     a flickering lightning arc;
//   * sparks drifting back down the beam;
//   * a flare at the blaster's muzzle;
//   * on the target: a splash of light where the beam meets its surface,
//     its outline, rotating brackets, and rings closing in on it.
//
// Every size is the game's, in game units, times GAME_TO_SITE (Bob is
// drawn at 0.04 scale here against the game's 0.1). Our planets are all
// circles, so only the game's round-target branch is needed.

"use strict";

const PullBeam = (() => {
  const GAME_TO_SITE = 0.4;

  // From lua/effects/PullBeam.lua.
  const COLOR = [120 / 255, 210 / 255, 255 / 255];
  const COLOR_HOT = [215 / 255, 246 / 255, 255 / 255];
  const BEAM_HALF_WIDTH = 22;
  const BEAM_START_FRACTION = 0.3;
  const OUTLINE_GLOW_WIDTH = 9;
  const OUTLINE_CORE_WIDTH = 3;
  const OUTLINE_PADDING = 8;
  const HELIX_AMPLITUDE = 11;
  const HELIX_WAVELENGTH = 90;
  const HELIX_SPEED = 9;
  const HELIX_SAMPLE_SPACING = 6;
  const BOLT_INTERVAL = 0.06;
  const BOLT_SEGMENT = 18;
  const BOLT_JITTER = 9;
  const SPARKS_PER_100_UNITS = 5;
  const SPARK_SPEED = 260;
  const SPARK_LIFE = 0.6;
  const RING_PERIOD = 0.7;
  const RING_START_GAP = 46;

  const U = GAME_TO_SITE;

  // Carried between frames, only while a pull is going on.
  let time = 0, lastNow = null;
  let bolt = null, sparks = [], sparkBudget = 0;

  function reset() {
    bolt = null;
    sparks = [];
    sparkBudget = 0;
  }

  const rgba = (c, a) => `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${Math.max(0, a)})`;

  // The game's soft glow sprite: alpha (1 - d)^2 to nothing at the edge.
  function glow(ctx, x, y, diameter, c, a) {
    const r = diameter / 2;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      g.addColorStop(t, rgba(c, a * (1 - t) * (1 - t)));
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // A wide faint glow stroke, then a thin bright core.
  function strokeGlowing(ctx, points, glowWidth, coreWidth, glowA, coreA) {
    if (points.length < 2) return;
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
    };
    ctx.lineWidth = glowWidth;
    ctx.strokeStyle = rgba(COLOR, glowA);
    path();
    ctx.stroke();
    ctx.lineWidth = coreWidth;
    ctx.strokeStyle = rgba(COLOR_HOT, coreA);
    path();
    ctx.stroke();
  }

  // Fades the strands and bolt in and out along the beam, so they're
  // pinned at both ends.
  const envelope = (u) => Math.sin(Math.PI * u);

  // originX/Y: the blaster's muzzle. targetX/Y/targetRadius: the planet
  // being pulled toward. now: seconds.
  function draw(ctx, originX, originY, targetX, targetY, targetRadius, now) {
    // A gap since the last frame means a new pull: start fresh.
    if (lastNow == null || now - lastNow > 0.25) reset();
    const dt = lastNow == null ? 0 : Math.min(0.05, Math.max(0, now - lastNow));
    lastNow = now;
    time += dt;
    const pulse = (Math.sin(time * 6) + 1) / 2;

    const dx = targetX - originX, dy = targetY - originY;
    const toCenter = Math.hypot(dx, dy);
    if (toCenter < 1e-3) return;
    const dirX = dx / toCenter, dirY = dy / toCenter;
    const perpX = -dirY, perpY = dirX;

    // The beam stops where it meets the planet's surface.
    const len = Math.max(8 * U, toCenter - targetRadius);
    const endX = originX + dirX * len, endY = originY + dirY * len;
    const at = (u, off) => [originX + dirX * u * len + perpX * off, originY + dirY * u * len + perpY * off];

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    ctx.lineJoin = "bevel";

    // The beam.
    const angle = Math.atan2(dirY, dirX);
    const params = { time, startFrac: BEAM_START_FRACTION, pulse, color: COLOR, hot: COLOR_HOT };
    if (!Fx.beam(ctx, originX, originY, angle, len / U, BEAM_HALF_WIDTH, U, params)) {
      // No WebGL: a plain glowing line.
      strokeGlowing(ctx, [[originX, originY], [endX, endY]], 4, 1.5, 0.35, 0.9);
    }

    // Helix strands, half a twist apart, pinned at both ends.
    const samples = Math.max(2, Math.floor(len / (HELIX_SAMPLE_SPACING * U)));
    for (let strand = 0; strand <= 1; strand++) {
      const points = [];
      for (let i = 0; i <= samples; i++) {
        const u = i / samples;
        const phase = (u * len / U) / HELIX_WAVELENGTH * Math.PI * 2 + time * HELIX_SPEED + strand * Math.PI;
        points.push(at(u, Math.sin(phase) * HELIX_AMPLITUDE * U * envelope(u)));
      }
      strokeGlowing(ctx, points, 5 * U, Math.max(0.6, 1.5 * U), 0.12 + 0.08 * pulse, 0.55 + 0.3 * pulse);
    }

    // Lightning: a jagged arc down the beam, re-shaped every few frames.
    if (!bolt || bolt.timer <= 0) {
      const jags = Math.max(2, Math.floor(len / (BOLT_SEGMENT * U)));
      const offsets = [];
      for (let i = 0; i <= jags; i++) {
        const u = i / jags;
        offsets.push([u, (Math.random() * 2 - 1) * BOLT_JITTER * U * envelope(u)]);
      }
      bolt = { timer: BOLT_INTERVAL, offsets };
    }
    bolt.timer -= dt;
    strokeGlowing(ctx, bolt.offsets.map(([u, off]) => at(u, off)), 4 * U, Math.max(0.5, 1.2 * U), 0.15, 0.4 + 0.4 * Math.random());

    // Sparks, drifting back down the beam toward Bob.
    sparkBudget += SPARKS_PER_100_UNITS * (len / U / 100) * dt;
    while (sparkBudget >= 1) {
      sparkBudget -= 1;
      const u = 0.15 + Math.random() * 0.85;
      sparks.push({ u, off: (Math.random() * 2 - 1) * BEAM_HALF_WIDTH * U * 0.5 * u, life: 1 });
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const sp = sparks[i];
      sp.u -= SPARK_SPEED * U * dt / len;
      sp.off *= 1 - 1.5 * dt;
      sp.life -= dt / SPARK_LIFE;
      if (sp.life <= 0 || sp.u <= 0) {
        sparks.splice(i, 1);
      } else {
        const [x, y] = at(sp.u, sp.off);
        glow(ctx, x, y, 16 * U, COLOR, 0.7 * sp.life);
        ctx.fillStyle = rgba(COLOR_HOT, sp.life);
        ctx.beginPath();
        ctx.arc(x, y, 1.8 * U, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Muzzle flare: a glow and a turning four-point star.
    glow(ctx, originX, originY, (44 + 10 * pulse) * U, COLOR, 0.85);
    glow(ctx, originX, originY, 16 * U, COLOR_HOT, 1);
    const starA = time * 2.5;
    const starR = (11 + 3 * pulse) * U;
    ctx.lineWidth = Math.max(0.6, 1.5 * U);
    ctx.strokeStyle = rgba(COLOR_HOT, 0.7);
    for (let k = 0; k <= 1; k++) {
      const a = starA + k * Math.PI / 2;
      const cx = Math.cos(a) * starR, cy = Math.sin(a) * starR;
      ctx.beginPath();
      ctx.moveTo(originX - cx, originY - cy);
      ctx.lineTo(originX + cx, originY + cy);
      ctx.stroke();
    }

    // Where it meets the planet: a splash of light.
    glow(ctx, endX, endY, (80 + 16 * pulse) * U, COLOR, 0.75);
    glow(ctx, endX, endY, 26 * U, COLOR_HOT, 1);

    // Outline round the planet.
    const ringR = targetRadius + OUTLINE_PADDING * U;
    ctx.lineWidth = OUTLINE_GLOW_WIDTH * U;
    ctx.strokeStyle = rgba(COLOR, 0.3 * (0.4 + pulse * 0.4));
    ctx.beginPath();
    ctx.arc(targetX, targetY, ringR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = OUTLINE_CORE_WIDTH * U;
    ctx.strokeStyle = rgba(COLOR, 0.7 + pulse * 0.3);
    ctx.beginPath();
    ctx.arc(targetX, targetY, ringR, 0, Math.PI * 2);
    ctx.stroke();

    // Three brackets turning round it, just outside the outline.
    const bracketR = ringR + 10 * U;
    const spin = time * 1.6;
    ctx.lineWidth = 3 * U;
    ctx.strokeStyle = rgba(COLOR_HOT, 0.55 + 0.3 * pulse);
    for (let k = 0; k <= 2; k++) {
      const a = spin + k * Math.PI * 2 / 3;
      ctx.beginPath();
      ctx.arc(targetX, targetY, bracketR, a, a + 0.55);
      ctx.stroke();
    }

    // Rings closing in on it — being reeled in.
    ctx.lineWidth = 2 * U;
    for (let k = 0; k <= 1; k++) {
      const phase = (time / RING_PERIOD + k * 0.5) % 1;
      const r = ringR + RING_START_GAP * U * (1 - phase);
      ctx.strokeStyle = rgba(COLOR, 0.45 * Math.sin(Math.PI * phase));
      ctx.beginPath();
      ctx.arc(targetX, targetY, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  return { draw };
})();
