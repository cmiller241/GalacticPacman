// js/main.js
//
// Wires the starfield, the four nav planets, and Bob together, and
// runs the single requestAnimationFrame loop that drives all three.

"use strict";

(async function () {
  const heroCanvas = document.getElementById("heroCanvas");
  const heroCtx = heroCanvas.getContext("2d");
  const stage = heroCanvas.parentElement;

  const HERO_WIDTH = Planets.HERO_WIDTH;
  const HERO_HEIGHT = Planets.HERO_HEIGHT;

  function sizeHeroCanvas() {
    const dpr = window.devicePixelRatio || 1;
    heroCanvas.width = HERO_WIDTH * dpr;
    heroCanvas.height = HERO_HEIGHT * dpr;
    heroCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    heroCtx.imageSmoothingEnabled = true;
    heroCtx.imageSmoothingQuality = "high";
  }
  sizeHeroCanvas();
  window.addEventListener("resize", sizeHeroCanvas);

  Starfield.init();
  Fireball.init();

  await Promise.all([Planets.init(), Bob.init()]);

  // Bob's Rig reads planet positions every frame it needs them (surface
  // walk, jump start/end) — this is a live per-frame-mutated copy of
  // Planets.DEFS (same cx/r, but cy updated to the SAME bobbing value
  // Planets.draw uses, via Planets.bobOffset) so his feet always match
  // the planet as it visibly undulates, rather than standing on its
  // resting position.
  const livePlanets = Planets.DEFS.map((d) => ({ ...d }));
  const rig = new Bob.Rig(livePlanets);

  const pages = Array.from(document.querySelectorAll("#content .page"));
  function setActivePage(idx) {
    for (const page of pages) {
      page.classList.toggle("active", Number(page.dataset.page) === idx);
    }
    for (const link of stage.querySelectorAll(".planet-hit")) {
      link.classList.toggle("active", Number(link.dataset.index) === idx);
    }
  }

  // A click both sends Bob walking/jumping/pull-beaming there AND
  // switches the page content — hover is deliberately NOT wired to
  // movement (see planets.js's own buildNavLinks comment), just the
  // CSS glow, so he doesn't react to the mouse merely passing over a
  // planet on its way elsewhere on the page.
  Planets.buildNavLinks(stage, (idx) => {
    rig.goTo(idx);
    setActivePage(idx);
  });
  // buildNavLinks doesn't know about page indices for the active-state
  // toggle above — tag each hit link with its own index now that it exists.
  stage.querySelectorAll(".planet-hit").forEach((link, idx) => {
    link.dataset.index = String(idx);
  });
  setActivePage(0);

  // Blaster aim + fire — Player.lua's own mouse-aim/shootFireball,
  // ported (see js/bob.js's Rig._computeAim/getBlasterMuzzle and
  // js/fireball.js). Mouse position is tracked globally (not just over
  // the hero canvas) so he keeps tracking the cursor even down over the
  // content panel, matching the game's own always-on-screen cursor.
  let aimX = 0, aimY = 0;
  let lastMouseMoveAt = performance.now();
  window.addEventListener("mousemove", (e) => {
    const rect = heroCanvas.getBoundingClientRect();
    aimX = ((e.clientX - rect.left) / rect.width) * HERO_WIDTH;
    aimY = ((e.clientY - rect.top) / rect.height) * HERO_HEIGHT;
    lastMouseMoveAt = performance.now();
  });

  // Hero-canvas logical coordinates (what Bob.Rig/Planets work in) ->
  // real on-screen viewport pixels (what #fireballLayer works in) —
  // same proportional mapping the mousemove listener above runs in
  // reverse. Uniform per-axis scaling (the hero canvas's own aspect
  // ratio is locked, see style.css), so an ANGLE carries over unchanged
  // between the two spaces — only positions need converting.
  function heroToViewport(logicalX, logicalY) {
    const rect = heroCanvas.getBoundingClientRect();
    return {
      x: rect.left + (logicalX / HERO_WIDTH) * rect.width,
      y: rect.top + (logicalY / HERO_HEIGHT) * rect.height,
    };
  }

  // Left-click fires, UNLESS it landed on an actual interactive element
  // (a planet, a gallery thumbnail, a lightbox button, ...) — those
  // keep their own click behavior rather than also shooting a bolt.
  window.addEventListener("click", (e) => {
    if (e.target.closest("a, button")) return;
    const muzzle = rig.getBlasterMuzzle();
    if (!muzzle) return;
    const screenMuzzle = heroToViewport(muzzle.x, muzzle.y);
    Fireball.spawn(screenMuzzle.x, screenMuzzle.y, muzzle.angle);
  });

  const startTime = performance.now();
  let lastTime = startTime;
  function frame(now) {
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    const t = (now - startTime) / 1000;

    Starfield.update(dt);
    Starfield.draw();

    for (let i = 0; i < livePlanets.length; i++) {
      livePlanets[i].cy = Planets.DEFS[i].cy + Planets.bobOffset(i, t);
    }
    Planets.updateLabels(t);
    rig.setAimTarget(aimX, aimY, now - lastMouseMoveAt > Bob.MOUSE_IDLE_MS);
    rig.update(dt);
    Dust.update(dt);
    Fireball.update(dt);
    Fireball.draw();

    heroCtx.clearRect(0, 0, HERO_WIDTH, HERO_HEIGHT);
    Planets.draw(heroCtx, t);
    rig.draw(heroCtx);
    // PullBeam.lua is drawn AFTER the player in main.lua too — the
    // beam overlays Bob rather than sitting behind him.
    const beamInfo = rig.pullBeamInfo();
    if (beamInfo) {
      PullBeam.draw(heroCtx, beamInfo.originX, beamInfo.originY, beamInfo.targetX, beamInfo.targetY, beamInfo.targetRadius, t);
    }
    // main.lua's own draw order: player -> ... -> fireballs -> particles
    // (fireballs are drawn on their own separate canvas above, not here).
    Dust.draw(heroCtx);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
