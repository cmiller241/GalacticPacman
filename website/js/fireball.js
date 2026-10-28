// js/fireball.js
//
// Port of lua/entities/Fireball.lua's look: a shader flame for the head
// (lua/effects/Flame.lua, run through js/fx.js) with a long comet tail,
// a flickering heat glow round it, a trail of fire puffs that cool from
// yellow to red and then into drifting grey smoke, and sparks streaking
// off behind.
//
// Sizes are the game's, in game units, shrunk by GAME_TO_SITE (Bob is
// drawn at 0.04 scale here against the game's 0.1) and by how big the
// hero canvas is shown (`unit`, passed to spawn). Speed is the website's
// own — fast, so a bolt crosses the whole browser window — and a bolt
// disappears once it leaves the window.
//
// Lives on its OWN full-viewport canvas (#fireballLayer), separate from
// #heroCanvas, so a bolt keeps flying over the topbar and the content
// panel past the hero box's bounds. See js/main.js for the hero-logical
// -> viewport-pixel conversion used when spawning one.

"use strict";

const Fireball = (() => {
  const GAME_TO_SITE = 0.4;   // Bob's website scale (0.04) / the game's (0.1)
  const SPEED = 900;          // viewport px per second
  const LIFE = 4;             // seconds — a backup in case a bolt never leaves the window
  const EDGE_MARGIN = 60;     // despawn this far past the window's edge (the tail trails behind)

  // From lua/entities/Fireball.lua (game units; per 60fps frame).
  const TRAIL_SPAWN_CHANCE = 0.9;
  const TRAIL_PUFFS_PER_FRAME = 3;
  const TRAIL_PARTICLE_LIFE_MIN = 14;
  const TRAIL_PARTICLE_LIFE_RANGE = 12;
  const SPARK_SPAWN_CHANCE = 0.35;
  const SPARK_LIFE_MIN = 8;
  const SPARK_LIFE_RANGE = 8;
  const FLAME_RADIUS = 11;
  const FLAME_STRETCH = 3.2;
  const PUFF_FIRE_FRACTION = 0.4;
  const PUFF_GROWTH = 1.8;

  let canvas, ctx, dpr = 1;
  let bolts = [];

  // Real pixels: the window's size times the screen's pixel density, for
  // sharpness. Size on screen: exactly the window — pinned with CSS, or
  // the browser would show the canvas at its pixel size, i.e. too big on
  // any screen with scaling above 100%, and every bolt in the wrong place.
  function resize() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
  }

  function init() {
    canvas = document.getElementById("fireballLayer");
    ctx = canvas.getContext("2d");
    resize();
    window.addEventListener("resize", resize);
  }

  // Fire's colour as it cools: t = 1 white-yellow, 0.5 orange, 0 deep red.
  function fireColor(t) {
    if (t > 0.5) {
      const k = (t - 0.5) * 2;
      return [1, 0.55 + 0.4 * k, 0.12 + 0.45 * k];
    }
    const k = t * 2;
    return [0.75 + 0.25 * k, 0.12 + 0.43 * k, 0.03 + 0.09 * k];
  }

  // The game's soft glow sprite: alpha (1 - d)^2, fading to nothing at
  // its edge. `diameter` in px.
  function glow(x, y, diameter, rgb, alpha) {
    const r = diameter / 2;
    if (r <= 0 || alpha <= 0) return;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const c = `${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)}`;
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      g.addColorStop(t, `rgba(${c}, ${alpha * (1 - t) * (1 - t)})`);
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // x, y: muzzle point; angle: fire direction — viewport pixels.
  // unit: viewport px per hero-canvas unit (how big the hero is shown).
  function spawn(x, y, angle, unit) {
    const u = GAME_TO_SITE * (unit || 1);
    bolts.push({
      x, y, u,
      vx: Math.cos(angle) * SPEED,
      vy: Math.sin(angle) * SPEED,
      life: LIFE,
      trail: [],
      sparks: [],
      flickerPhase: Math.random() * Math.PI * 2,
      flameTime: Math.random() * 100,
      alive: true,
    });
  }

  function update(dt) {
    const ts = dt * 60; // the game's per-frame steps, in 60fps frames
    const w = window.innerWidth, h = window.innerHeight;

    for (let i = bolts.length - 1; i >= 0; i--) {
      const b = bolts[i];
      const u = b.u;
      // Per-frame step, px.
      const stepX = b.vx / 60, stepY = b.vy / 60;

      if (b.alive) {
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.life -= dt;
        b.flameTime += dt;

        // Trail puffs, spread back along the step just taken, drifting
        // on a little the way it was going. This flies faster than the
        // game's fireball (14 units a frame), so more puffs a frame keep
        // the trail as dense as the game's.
        const density = Math.max(1, Math.hypot(stepX, stepY) / (14 * u));
        const puffs = Math.round(TRAIL_PUFFS_PER_FRAME * density);
        for (let k = 0; k < puffs; k++) {
          if (Math.random() < TRAIL_SPAWN_CHANCE * ts) {
            const back = Math.random() * ts;
            const maxLife = TRAIL_PARTICLE_LIFE_MIN + Math.random() * TRAIL_PARTICLE_LIFE_RANGE;
            b.trail.push({
              x: b.x - stepX * back + (Math.random() - 0.5) * 8 * u,
              y: b.y - stepY * back + (Math.random() - 0.5) * 8 * u,
              vx: stepX * 0.08 + (Math.random() - 0.5) * 0.6 * u,
              vy: stepY * 0.08 + (Math.random() - 0.5) * 0.6 * u,
              life: maxLife, maxLife,
              size: (4 + Math.random() * 5) * u,
            });
          }
        }

        // Sparks, thrown off mostly backward.
        if (Math.random() < SPARK_SPAWN_CHANCE * ts) {
          const a = Math.atan2(b.vy, b.vx) + Math.PI + (Math.random() - 0.5) * 1.8;
          const speed = (1.5 + Math.random() * 3) * u;
          const maxLife = SPARK_LIFE_MIN + Math.random() * SPARK_LIFE_RANGE;
          b.sparks.push({ x: b.x, y: b.y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, life: maxLife, maxLife });
        }

        const off = b.x < -EDGE_MARGIN || b.x > w + EDGE_MARGIN || b.y < -EDGE_MARGIN || b.y > h + EDGE_MARGIN;
        // Once gone, its trail and sparks are left to finish fading.
        if (b.life <= 0 || off) b.alive = false;
      }

      for (let k = b.trail.length - 1; k >= 0; k--) {
        const t = b.trail[k];
        t.x += t.vx * ts;
        t.y += t.vy * ts;
        t.vx *= Math.pow(0.94, ts);
        t.vy *= Math.pow(0.94, ts);
        t.life -= ts;
        if (t.life <= 0) b.trail.splice(k, 1);
      }
      for (let k = b.sparks.length - 1; k >= 0; k--) {
        const s = b.sparks[k];
        s.x += s.vx * ts;
        s.y += s.vy * ts;
        s.life -= ts;
        if (s.life <= 0) b.sparks.splice(k, 1);
      }

      if (!b.alive && b.trail.length === 0 && b.sparks.length === 0) bolts.splice(i, 1);
    }
  }

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    for (const b of bolts) {
      // Smoke: the older puffs, grey, growing as they fade.
      ctx.globalCompositeOperation = "source-over";
      for (const t of b.trail) {
        const life = t.life / t.maxLife;
        if (life < PUFF_FIRE_FRACTION + 0.1) {
          const k = Math.min(1, life / PUFF_FIRE_FRACTION);
          const size = t.size * (1 + PUFF_GROWTH * (1 - life));
          glow(t.x, t.y, size * 2.6, [0.32, 0.3, 0.3], 0.3 * k);
        }
      }

      // Fire: the younger puffs, glowing, cooling from yellow to red.
      ctx.globalCompositeOperation = "lighter";
      for (const t of b.trail) {
        const life = t.life / t.maxLife;
        if (life > PUFF_FIRE_FRACTION) {
          const heat = (life - PUFF_FIRE_FRACTION) / (1 - PUFF_FIRE_FRACTION);
          const size = t.size * (1 + PUFF_GROWTH * (1 - life));
          glow(t.x, t.y, size * 2.8, fireColor(heat), 0.6 * heat);
        }
      }

      // Sparks: short bright streaks along the way they're flying.
      ctx.lineWidth = Math.max(0.75, 1.5 * b.u);
      ctx.lineCap = "round";
      for (const s of b.sparks) {
        const a = s.life / s.maxLife;
        const [r, g, bl] = fireColor(0.4 + 0.6 * a);
        ctx.strokeStyle = `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(bl * 255)}, ${a})`;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x - s.vx * 2.5, s.y - s.vy * 2.5);
        ctx.stroke();
      }

      if (!b.alive) continue;

      // Heat glow round the head, flickering.
      const flicker = Math.sin(b.flameTime * 20 + b.flickerPhase);
      glow(b.x, b.y, FLAME_RADIUS * 6 * b.u, [1, 0.45, 0.1], 0.45 + 0.1 * flicker);

      // The head: the shader flame, its tail streaming back behind it.
      ctx.globalCompositeOperation = "source-over";
      const dirAngle = Math.atan2(b.vy, b.vx);
      const radius = FLAME_RADIUS * b.u * (1 + flicker * 0.05);
      if (!Fx.flame(ctx, b.x, b.y, radius, dirAngle, FLAME_STRETCH, b.flameTime, b.flickerPhase * 10)) {
        glow(b.x, b.y, radius * 2.4, [1, 0.93, 0.6], 1); // no WebGL: a plain hot core
      }
    }
    ctx.globalCompositeOperation = "source-over";
  }

  return { init, spawn, update, draw };
})();
