// js/fireball.js
//
// Port of lua/entities/Fireball.lua's shape, simplified for a
// decorative web flourish: a bright bolt that flies in a straight line
// from Bob's blaster muzzle toward wherever the player clicked,
// trailing small fading sparks, and just disappearing once it leaves
// the browser window (or, as a backup, once its own life runs out) —
// the real game has no dedicated "dissipate" animation either; the
// trail particles are the whole effect, and the bolt itself simply
// vanishes (table.remove) the instant isDead() is true.
//
// Lives on its OWN full-viewport canvas (#fireballLayer), separate
// from #heroCanvas, specifically so a bolt keeps flying — over the
// topbar, over the content panel — past the hero box's own small
// bounds instead of vanishing at that canvas's edge. See
// js/main.js for the hero-logical -> viewport-pixel conversion used
// when spawning one.

"use strict";

const Fireball = (() => {
  const SPEED = 900; // px/sec, viewport pixels — brisk enough to cross a real browser window quickly
  const LIFE = 4; // seconds — a generous backup in case a bolt somehow never crosses the viewport edge
  const RADIUS = 5;
  const EDGE_MARGIN = 20; // despawn shortly after actually leaving the window, not well past it

  const TRAIL_INTERVAL = 0.02; // seconds between spark spawns while a bolt is alive
  const TRAIL_LIFE_MIN = 0.12, TRAIL_LIFE_MAX = 0.26;

  let canvas, ctx;
  let bolts = [];
  let sparks = [];

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function init() {
    canvas = document.getElementById("fireballLayer");
    ctx = canvas.getContext("2d");
    resize();
    window.addEventListener("resize", resize);
  }

  // x,y: muzzle spawn point. angle: fire direction (radians) — both in
  // VIEWPORT PIXELS (this canvas's own coordinate space), not
  // hero-canvas logical coordinates.
  function spawn(x, y, angle) {
    bolts.push({
      x, y,
      vx: Math.cos(angle) * SPEED,
      vy: Math.sin(angle) * SPEED,
      life: LIFE,
      trailTimer: 0,
    });
  }

  function update(dt) {
    for (let i = bolts.length - 1; i >= 0; i--) {
      const b = bolts[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;
      b.trailTimer -= dt;

      if (b.trailTimer <= 0) {
        b.trailTimer = TRAIL_INTERVAL;
        sparks.push({
          x: b.x, y: b.y,
          life: TRAIL_LIFE_MIN + Math.random() * (TRAIL_LIFE_MAX - TRAIL_LIFE_MIN),
          maxLife: TRAIL_LIFE_MAX,
          radius: RADIUS * (0.4 + Math.random() * 0.4),
        });
      }

      const offscreen = b.x < -EDGE_MARGIN || b.x > canvas.width + EDGE_MARGIN
        || b.y < -EDGE_MARGIN || b.y > canvas.height + EDGE_MARGIN;
      if (b.life <= 0 || offscreen) bolts.splice(i, 1);
    }

    for (let i = sparks.length - 1; i >= 0; i--) {
      sparks[i].life -= dt;
      if (sparks[i].life <= 0) sparks.splice(i, 1);
    }
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const s of sparks) {
      const alpha = Math.max(0, s.life / s.maxLife);
      ctx.fillStyle = `rgba(255, 140, 40, ${alpha * 0.8})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const b of bolts) {
      const glow = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, RADIUS * 3.5);
      glow.addColorStop(0, "rgba(255, 220, 140, 0.9)");
      glow.addColorStop(0.4, "rgba(255, 140, 40, 0.55)");
      glow.addColorStop(1, "rgba(255, 90, 20, 0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(b.x, b.y, RADIUS * 3.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#fff6d8";
      ctx.beginPath();
      ctx.arc(b.x, b.y, RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return { init, spawn, update, draw };
})();
