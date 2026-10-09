// js/planets.js
//
// The four nav planets: where they sit, what they're tinted, and how
// they're baked to look like the game's own planetoids (see
// lua/world/Planetoid.lua:ensureBodyCanvas, which this mirrors —
// texture cropped to a circle, tinted via a multiply blend, a
// directional "sun-shading" gradient, a thin rim light).
//
// Positions are authored in a FIXED internal coordinate space
// (HERO_WIDTH x HERO_HEIGHT), not real CSS pixels — js/main.js draws
// the shared hero canvas at this same logical size and lets CSS scale
// the whole thing responsively, and buildNavLinks below positions the
// real DOM nav links as PERCENTAGES of that same space so they stay
// exactly aligned with the canvas-drawn circles at any width.

"use strict";

const Planets = (() => {
  const HERO_WIDTH = 1050;
  // Cropped down from 420 — the planets/labels only ever occupy the
  // top ~275px of this coordinate space (see DEFS' cy/r below), so the
  // rest was just dead space inflating the hero's rendered height
  // (and, via width:100%/height:auto, pushing main#content down with
  // it). Every drawing/positioning call in this file and js/bob.js's
  // own jump math already reads HERO_HEIGHT (or works in raw cx/cy/r
  // units, independent of it) rather than hardcoding 420, so this is
  // the only number that needed to change.
  const HERO_HEIGHT = 300;

  // "Adjacent... but vertically offset some" — hand-placed, not a
  // formula, same "author it by eye" approach the game's own
  // hand-placed landmarks (the dome, the beams, the pinball planet)
  // already use. Gaps between neighboring edges are ~86px, close
  // enough to read as an easy, deliberate hop for Bob. Radius kept
  // smaller than the hero's own first pass specifically so Bob (a
  // fixed pixel size, see js/bob.js's SCALE) reads as bigger/crisper
  // next to them.
  const DEFS = [
    { key: "home", label: "Home", cx: 201, cy: 166, r: 65, color: [0.95, 0.85, 0.40] },
    { key: "about", label: "About", cx: 417, cy: 126, r: 65, color: [0.45, 0.85, 0.50] },
    { key: "media", label: "Media", cx: 633, cy: 178, r: 65, color: [0.65, 0.55, 0.95] },
    { key: "contact", label: "Contact", cx: 849, cy: 134, r: 65, color: [0.95, 0.45, 0.40] },
  ];

  // Subtle per-planet up/down undulation — small amplitude, and a
  // distinct phase per planet (i*1.7, an arbitrary non-resonant
  // offset) so the four don't bob in unison. draw() and js/main.js's
  // live planet copy (which Bob's Rig actually stands on) both call
  // this SAME function with the SAME elapsed-time value, so his feet
  // never drift from the visibly-bobbing surface.
  const BOB_AMPLITUDE = 6;
  const BOB_SPEED = 0.6;
  function bobOffset(i, t) {
    return Math.sin(t * BOB_SPEED + i * 1.7) * BOB_AMPLITUDE;
  }

  const TEXTURE_SRC = "img/planet_texture_2.jpg";
  let textureImg = null;
  let baked = []; // offscreen <canvas> per planet, same order/index as DEFS

  function loadTexture() {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { textureImg = img; resolve(img); };
      img.onerror = () => { textureImg = null; resolve(null); };
      img.src = TEXTURE_SRC;
    });
  }

  // Bakes one planet's own circular body once — cheap enough (4 of
  // them, once at startup) that there's no need for the game's own
  // per-frame bake-budget/cache machinery here.
  function bakePlanet(def) {
    const size = def.r * 2;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const r = def.r;

    ctx.save();
    ctx.beginPath();
    ctx.arc(r, r, r, 0, Math.PI * 2);
    ctx.clip();

    if (textureImg) {
      // Oversized + centered crop (not a true tile) — same technique
      // Planetoid.lua's own bake uses: draw the texture bigger than
      // the circle so only its middle portion actually shows once
      // clipped, instead of stretching the whole image to exactly fit.
      const scale = Math.max(size / textureImg.width, size / textureImg.height) * 1.5;
      const dw = textureImg.width * scale, dh = textureImg.height * scale;
      ctx.drawImage(textureImg, r - dw / 2, r - dh / 2, dw, dh);
    } else {
      ctx.fillStyle = "#888";
      ctx.fillRect(0, 0, size, size);
    }

    // Tint — a multiply blend against a flat fill is the canvas
    // equivalent of love.graphics.draw(img, ..., color): both just
    // multiply the drawn pixels by the tint color channel-for-channel.
    const [cr, cg, cb] = def.color;
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = `rgb(${cr * 255}, ${cg * 255}, ${cb * 255})`;
    ctx.fillRect(0, 0, size, size);

    // Directional "sun-shading" — a bright highlight toward the
    // upper-left, darkening toward the lower-right — same idea as
    // Planetoid.lua's own drawSunShading, just a static baked gradient
    // here instead of one recomputed from a live sun position.
    ctx.globalCompositeOperation = "source-over";
    const shade = ctx.createRadialGradient(r * 0.6, r * 0.5, r * 0.15, r * 0.6, r * 0.5, r * 1.5);
    shade.addColorStop(0, "rgba(255,255,255,0.30)");
    shade.addColorStop(0.5, "rgba(255,255,255,0)");
    shade.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, size, size);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(r, r, r - 1, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.stroke();
    ctx.restore();

    return canvas;
  }

  async function init() {
    await loadTexture();
    baked = DEFS.map(bakePlanet);
  }

  // Call every frame, before Bob draws on top. `t` is shared elapsed
  // seconds — js/main.js passes the SAME value here and into its own
  // live planet copy (what Bob's Rig actually stands on), so the
  // visible bob and his footing always agree. A soft ambient glow is
  // drawn first (a radial gradient a bit wider than the planet itself,
  // tinted the same color) — its gradient has to be rebuilt each frame
  // since the bobbing center moves, but it's cheap enough not to bother
  // pre-baking separately.
  function draw(ctx, t) {
    for (let i = 0; i < DEFS.length; i++) {
      const def = DEFS[i];
      const cy = def.cy + bobOffset(i, t || 0);
      const [cr, cg, cb] = def.color;
      const glowR = def.r * 1.55;
      const glow = ctx.createRadialGradient(def.cx, cy, def.r * 0.8, def.cx, cy, glowR);
      glow.addColorStop(0, `rgba(${cr * 255}, ${cg * 255}, ${cb * 255}, 0.35)`);
      glow.addColorStop(1, `rgba(${cr * 255}, ${cg * 255}, ${cb * 255}, 0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(def.cx, cy, glowR, 0, Math.PI * 2);
      ctx.fill();

      ctx.drawImage(baked[i], def.cx - def.r, cy - def.r);
    }
  }

  // Builds the real, accessible nav links (plus their text labels),
  // positioned as PERCENTAGES of HERO_WIDTH/HERO_HEIGHT so they stay
  // exactly aligned with the canvas-drawn circles regardless of how
  // wide the hero actually renders (see this file's own header
  // comment).
  //
  // Hover/focus only drive the CSS glow (see .planet-hit:hover +
  // .planet-label in style.css) — Bob only actually walks/jumps on a
  // genuine click, not on the mouse merely passing over a planet on
  // its way somewhere else on the page. onClick receives the planet's
  // own index into DEFS.
  const labelEls = []; // same order/index as DEFS, filled by buildNavLinks

  function buildNavLinks(container, onClick) {
    labelEls.length = 0;
    for (let i = 0; i < DEFS.length; i++) {
      const def = DEFS[i];
      const leftPct = ((def.cx - def.r) / HERO_WIDTH) * 100;
      const topPct = ((def.cy - def.r) / HERO_HEIGHT) * 100;
      const sizePctW = ((def.r * 2) / HERO_WIDTH) * 100;
      const sizePctH = ((def.r * 2) / HERO_HEIGHT) * 100;

      const a = document.createElement("a");
      a.href = "#" + def.key;
      a.className = "planet-hit";
      a.style.left = leftPct + "%";
      a.style.top = topPct + "%";
      a.style.width = sizePctW + "%";
      a.style.height = sizePctH + "%";
      a.textContent = def.label;
      a.addEventListener("click", (e) => { e.preventDefault(); onClick(i); });
      container.appendChild(a);

      const label = document.createElement("span");
      label.className = "planet-label";
      label.textContent = def.label;
      label.style.left = ((def.cx / HERO_WIDTH) * 100) + "%";
      label.style.top = (((def.cy + def.r + 10) / HERO_HEIGHT) * 100) + "%";
      container.appendChild(label);
      labelEls.push(label);
    }
  }

  // Call every frame (after buildNavLinks) with the same elapsed-time
  // value passed to draw() — keeps each label riding its own planet's
  // bob instead of sitting at its resting position while the planet
  // undulates underneath it.
  function updateLabels(t) {
    for (let i = 0; i < labelEls.length; i++) {
      const def = DEFS[i];
      const cy = def.cy + bobOffset(i, t);
      labelEls[i].style.top = (((cy + def.r + 10) / HERO_HEIGHT) * 100) + "%";
    }
  }

  return { HERO_WIDTH, HERO_HEIGHT, DEFS, init, draw, buildNavLinks, updateLabels, bobOffset };
})();
