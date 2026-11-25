// js/world/Starfield.js
//
// The main game's multi-layer parallax starfield (js/world/Starfield.js),
// in Canvas 2D: a navy gradient sky plus four layers of stars that move
// at different speeds relative to the camera. Stars wrap, so the field
// is effectively infinite. Drawn in screen space, before the camera
// transform.

// Vertical background gradient: dark navy at the top, darker at the bottom.
// (css/styles.css gives the page the same gradient, for the screens that
// don't draw the starfield, like Game Over.)
const TOP_COLOR = 'rgb(23,33,77)';
const BOTTOM_COLOR = 'rgb(8,11,28)';
const STAR_DENSITY = 8;
// Stars smaller than this (CSS pixels) are drawn as tiny squares.
const ROUND_STAR_RADIUS = 1;
const STAR_COLOR = [217, 230, 255];
const WRAP = 3000;

// Parallax factor + how many stars + size/brightness range, far to near.
const LAYERS = [
  { parallax: 0.08, count: Math.floor(90 * STAR_DENSITY), minSize: 0.6, maxSize: 1.1, alpha: 0.35 },
  { parallax: 0.18, count: Math.floor(70 * STAR_DENSITY), minSize: 0.8, maxSize: 1.4, alpha: 0.55 },
  { parallax: 0.35, count: Math.floor(50 * STAR_DENSITY), minSize: 1.0, maxSize: 1.8, alpha: 0.75 },
  { parallax: 0.55, count: Math.floor(30 * STAR_DENSITY), minSize: 1.2, maxSize: 2.2, alpha: 0.90 },
];

const mod = (a, n) => ((a % n) + n) % n;

function randomStar(layer) {
  return {
    x: Math.random() * 4000 - 500,
    y: Math.random() * 4000 - 500,
    radius: (layer.minSize + Math.random() * (layer.maxSize - layer.minSize)) * (0.5 + Math.random() * 0.5),
  };
}

export class Starfield {
  constructor() {
    this.layers = LAYERS.map(def => {
      const stars = [];
      for (let i = 0; i < def.count; i++) stars.push(randomStar(def));
      return {
        parallax: def.parallax,
        fill: `rgba(${STAR_COLOR[0]},${STAR_COLOR[1]},${STAR_COLOR[2]},${def.alpha})`,
        stars,
      };
    });
  }

  // camera: how far the view has scrolled, in screen pixels (only changes
  // in it matter).
  draw(ctx, camera, screenW, screenH) {
    if (!this.gradient || this.gradientHeight !== screenH) {
      this.gradient = ctx.createLinearGradient(0, 0, 0, screenH);
      this.gradient.addColorStop(0, TOP_COLOR);
      this.gradient.addColorStop(1, BOTTOM_COLOR);
      this.gradientHeight = screenH;
    }
    ctx.fillStyle = this.gradient;
    ctx.fillRect(0, 0, screenW, screenH);

    // The area stars are drawn over: the screen, plus a little margin.
    const minX = -50, maxX = screenW + 50, minY = -50, maxY = screenH + 50;
    for (const layer of this.layers) {
      const px = camera.x * layer.parallax;
      const py = camera.y * layer.parallax;
      ctx.fillStyle = layer.fill;
      ctx.beginPath();
      let round = false;
      for (const star of layer.stars) {
        // First copy of this star at or before the area's top-left edge.
        const sx = minX + mod(star.x - px - minX, WRAP);
        const sy = minY + mod(star.y - py - minY, WRAP);
        const r = star.radius;
        // The pattern repeats every WRAP pixels, tiled across the area.
        for (let y = sy; y < maxY; y += WRAP) {
          for (let x = sx; x < maxX; x += WRAP) {
            if (r < ROUND_STAR_RADIUS) {
              // Too small for its shape to show: a plain square, drawn
              // directly (browsers have a fast path for fillRect).
              ctx.fillRect(x - r, y - r, r * 2, r * 2);
            } else {
              ctx.moveTo(x + r, y);
              ctx.arc(x, y, r, 0, Math.PI * 2);
              round = true;
            }
          }
        }
      }
      if (round) ctx.fill();
    }
  }
}
