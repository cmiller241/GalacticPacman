// js/pullbeam.js
//
// Port of lua/effects/PullBeam.lua's visuals (the light-blue beam +
// electric wave strands + pulsing target outline) for the website's
// own pull-beam fast-travel (see js/bob.js's Rig "pulling" mode).
// Same structure and color palette as the Lua version, with widths/
// amplitude scaled down for the hero canvas's much smaller figures
// (Bob is ~40px tall here vs. a game character several times that).

"use strict";

const PullBeam = (() => {
  const BEAM_GLOW_WIDTH = 4;
  const BEAM_CORE_WIDTH = 1.5;
  const OUTLINE_GLOW_WIDTH = 3;
  const OUTLINE_CORE_WIDTH = 1.2;
  const OUTLINE_PADDING = 5;

  const WAVE_AMPLITUDE = 2.5;
  const WAVE_FREQUENCY = 0.05;
  const WAVE_FREQUENCY_2 = 0.065;
  const WAVE_SPEED = 12; // radians/sec
  const WAVE_SAMPLE_SPACING = 8;
  const WAVE_GLOW_WIDTH = 1.5;
  const WAVE_CORE_WIDTH = 0.7;

  function buildWavePoints(originX, originY, dirX, dirY, perpX, perpY, beamLength, frequency, phaseOffset, now) {
    const points = [];
    const numSamples = Math.max(2, Math.floor(beamLength / WAVE_SAMPLE_SPACING));
    for (let i = 0; i <= numSamples; i++) {
      const s = (i / numSamples) * beamLength;
      const wave = WAVE_AMPLITUDE * Math.sin(s * frequency - now * WAVE_SPEED + phaseOffset);
      points.push({ x: originX + dirX * s + perpX * wave, y: originY + dirY * s + perpY * wave });
    }
    return points;
  }

  function strokePolyline(ctx, points, width, rgba) {
    if (points.length < 2) return;
    ctx.lineWidth = width;
    ctx.strokeStyle = rgba;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
  }

  // originX/Y: the shoulder attach point (Rig.pullBeamInfo()).
  // targetX/Y/targetRadius: the destination planet's center and
  // radius — the beam/outline target the planet itself, not the
  // surface point Bob is actually flying to land on (see
  // lua/effects/PullBeam.lua's own target.pos/target.radius usage).
  function draw(ctx, originX, originY, targetX, targetY, targetRadius, now) {
    const pulse = (Math.sin(now * 6) + 1) / 2; // ~0..1 breathing

    const dx = targetX - originX;
    const dy = targetY - originY;
    const beamLength = Math.sqrt(dx * dx + dy * dy);

    ctx.lineCap = "round";

    ctx.lineWidth = BEAM_GLOW_WIDTH;
    ctx.strokeStyle = `rgba(120, 210, 255, ${0.35 * (0.4 + pulse * 0.3)})`;
    ctx.beginPath();
    ctx.moveTo(originX, originY);
    ctx.lineTo(targetX, targetY);
    ctx.stroke();

    ctx.lineWidth = BEAM_CORE_WIDTH;
    ctx.strokeStyle = `rgba(120, 210, 255, ${0.7 + pulse * 0.3})`;
    ctx.beginPath();
    ctx.moveTo(originX, originY);
    ctx.lineTo(targetX, targetY);
    ctx.stroke();

    if (beamLength > 1e-3) {
      const dirX = dx / beamLength, dirY = dy / beamLength;
      const perpX = -dirY, perpY = dirX;

      const strand1 = buildWavePoints(originX, originY, dirX, dirY, perpX, perpY, beamLength, WAVE_FREQUENCY, 0, now);
      const strand2 = buildWavePoints(originX, originY, dirX, dirY, perpX, perpY, beamLength, WAVE_FREQUENCY_2, Math.PI, now);

      const glowA = 0.4 * (0.3 + pulse * 0.25);
      strokePolyline(ctx, strand1, WAVE_GLOW_WIDTH, `rgba(215, 246, 255, ${glowA})`);
      strokePolyline(ctx, strand2, WAVE_GLOW_WIDTH, `rgba(215, 246, 255, ${glowA})`);

      const coreA = 0.6 + pulse * 0.3;
      strokePolyline(ctx, strand1, WAVE_CORE_WIDTH, `rgba(215, 246, 255, ${coreA})`);
      strokePolyline(ctx, strand2, WAVE_CORE_WIDTH, `rgba(215, 246, 255, ${coreA})`);
    }

    // Target outline — our planets are always plain circles (no
    // rounded-rect targets like the game's RoundedRectPlanetoid), so
    // this only needs PullBeam.lua's circle branch.
    ctx.beginPath();
    ctx.arc(targetX, targetY, targetRadius + OUTLINE_PADDING, 0, Math.PI * 2);
    ctx.lineWidth = OUTLINE_GLOW_WIDTH;
    ctx.strokeStyle = `rgba(120, 210, 255, ${0.3 * (0.4 + pulse * 0.4)})`;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(targetX, targetY, targetRadius + OUTLINE_PADDING, 0, Math.PI * 2);
    ctx.lineWidth = OUTLINE_CORE_WIDTH;
    ctx.strokeStyle = `rgba(120, 210, 255, ${0.7 + pulse * 0.3})`;
    ctx.stroke();
  }

  return { draw };
})();
