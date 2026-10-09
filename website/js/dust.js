// js/dust.js
//
// Port of lua/effects/DustPuff.lua + lua/entities/Particle.lua's own
// update/draw — the dusty tan/beige footstep puffs Bob kicks up while
// walking OR rolling (Player.lua calls the exact same spawnWalkDust()
// for both; isBall doesn't change which function fires, just what's
// drawn at the position it fires from — see js/bob.js's own
// _updateFootstepDust). Velocities/drag/growRate/life below are kept
// in the SAME "per 60fps tick" units DustPuff.lua/Particle.lua use —
// update(dt) converts via ticks = dt*60 — so every tuning number here
// is copied verbatim rather than reconverted.

"use strict";

const Dust = (() => {
  const particles = [];

  // Same hand-ported HSL->RGB DustPuff.lua uses (LÖVE/canvas 2D both
  // lack a direct "give me rgb from this hsl" one-liner at this layer).
  function hslToRgb(h, s, l) {
    if (s === 0) return [l, l, l];
    const hueToRgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hNorm = h / 360;
    return [hueToRgb(p, q, hNorm + 1 / 3), hueToRgb(p, q, hNorm), hueToRgb(p, q, hNorm - 1 / 3)];
  }

  // Three overlapping sub-circles fused into one clover-shaped blob,
  // positions/sizes as FRACTIONS of the particle's own radius — see
  // DustPuff.lua's own randomBlobs for the full reasoning.
  function randomBlobs() {
    const baseAngle = Math.random() * Math.PI * 2;
    const blobs = [];
    for (let i = 0; i < 3; i++) {
      blobs.push({
        angle: baseAngle + i * ((2 * Math.PI) / 3) + (Math.random() - 0.5) * 0.4,
        distFrac: 0.26 + Math.random() * 0.12,
        radiusFrac: 0.62 + Math.random() * 0.28,
      });
    }
    return blobs;
  }

  // x,y: spawn point. intoX,intoY: unit vector pointing INTO the
  // surface (e.g. toward the planet's center) — particles drift away
  // from its negation. sideX,sideY: unit vector perpendicular to that,
  // for sideways scatter. count/sideSpreadScale/driftMin/driftMax: see
  // DustPuff.lua's own spawn() doc comment — same meanings, same units.
  function spawn(x, y, intoX, intoY, sideX, sideY, count, sideSpreadScale, driftMin, driftMax) {
    for (let i = 0; i < count; i++) {
      const sideSpread = (Math.random() - 0.5) * sideSpreadScale;
      const driftSpeed = driftMin + Math.random() * (driftMax - driftMin);
      const vx = sideX * sideSpread + -intoX * driftSpeed;
      const vy = sideY * sideSpread + -intoY * driftSpeed;
      const life = 22 + Math.random() * 14;
      const [r, g, b] = hslToRgb(35 + Math.random() * 15, (30 + Math.random() * 15) / 100, (55 + Math.random() * 15) / 100);
      particles.push({
        x, y, vx, vy,
        life, maxLife: life,
        color: [r * 255, g * 255, b * 255],
        radius: 2 + Math.random() * 1.5,
        drag: 0.9,
        growRate: 0.06,
        blobs: randomBlobs(),
      });
    }
  }

  function update(dt) {
    const ticks = dt * 60;
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * ticks;
      p.y += p.vy * ticks;
      const dragFactor = Math.pow(p.drag, ticks);
      p.vx *= dragFactor;
      p.vy *= dragFactor;
      p.radius += p.growRate * ticks;
      p.life -= ticks;
      if (p.life <= 0) particles.splice(i, 1);
    }
  }

  function draw(ctx) {
    for (const p of particles) {
      const alpha = Math.max(0, p.life / p.maxLife);
      ctx.fillStyle = `rgba(${p.color[0]}, ${p.color[1]}, ${p.color[2]}, ${alpha})`;
      for (const blob of p.blobs) {
        const bx = p.x + Math.cos(blob.angle) * blob.distFrac * p.radius;
        const by = p.y + Math.sin(blob.angle) * blob.distFrac * p.radius;
        ctx.beginPath();
        ctx.arc(bx, by, blob.radiusFrac * p.radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  return { spawn, update, draw };
})();
