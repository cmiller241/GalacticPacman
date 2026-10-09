// js/starfield.js
//
// Full-viewport parallax starfield behind everything else. Several
// depth layers drift slowly on their own and shift a bit further with
// the mouse — nearer (faster/bigger) layers shift more, giving a
// cheap sense of depth without any real 3D.

"use strict";

const Starfield = (() => {
  const LAYER_DEFS = [
    { count: 140, size: [0.6, 1.2], alpha: [0.25, 0.55], speed: 2, parallax: 6 },
    { count: 90, size: [1.0, 1.8], alpha: [0.35, 0.7], speed: 5, parallax: 16 },
    { count: 50, size: [1.4, 2.6], alpha: [0.5, 0.9], speed: 9, parallax: 32 },
  ];

  let canvas, ctx;
  let layers = [];
  let mouseX = 0, mouseY = 0;
  let drift = 0;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    buildLayers();
  }

  function buildLayers() {
    layers = LAYER_DEFS.map((def) => {
      const stars = [];
      for (let i = 0; i < def.count; i++) {
        stars.push({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          r: def.size[0] + Math.random() * (def.size[1] - def.size[0]),
          a: def.alpha[0] + Math.random() * (def.alpha[1] - def.alpha[0]),
          twinklePhase: Math.random() * Math.PI * 2,
          twinkleRate: 0.5 + Math.random() * 1.5,
        });
      }
      return { def, stars };
    });
  }

  function init() {
    canvas = document.getElementById("starfield");
    ctx = canvas.getContext("2d");
    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("mousemove", (e) => {
      mouseX = (e.clientX / window.innerWidth) * 2 - 1; // -1..1
      mouseY = (e.clientY / window.innerHeight) * 2 - 1;
    });
  }

  function update(dt) {
    drift += dt;
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const layer of layers) {
      const offX = mouseX * layer.def.parallax;
      const offY = mouseY * layer.def.parallax * 0.6;
      const idleX = Math.sin(drift * 0.05 * layer.def.speed) * layer.def.speed;
      for (const star of layer.stars) {
        const twinkle = 0.75 + 0.25 * Math.sin(drift * star.twinkleRate + star.twinklePhase);
        let x = star.x + offX + idleX;
        let y = star.y + offY;
        // Wrap so parallax offset never reveals an edge.
        x = ((x % canvas.width) + canvas.width) % canvas.width;
        y = ((y % canvas.height) + canvas.height) % canvas.height;
        ctx.globalAlpha = star.a * twinkle;
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(x, y, star.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  return { init, update, draw };
})();
