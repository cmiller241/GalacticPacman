// js/world/Starfield.js
//
// Simple multi-layer parallax starfield.
// Draws a deep blue background + several layers of stars that move
// at different speeds relative to the camera for a nice sense of depth.
// Stars wrap so the field is effectively infinite.

import love from '../love/index.js';
import lua from '../love/lua.js';
import SkyRegions from './SkyRegions.js';
import BackgroundAsteroids from './BackgroundAsteroids.js';

// Vertical background gradient: a clearly-visible dark navy blue at the
// top of the screen, fading to a darker shade at the bottom.
const TOP_COLOR = [0.09, 0.13, 0.30, 1];
const BOTTOM_COLOR = [0.03, 0.045, 0.11, 1];
const GRADIENT_STRIPS = 48; // horizontal bands approximating the gradient
const STAR_DENSITY = 8;

// Layer definitions: parallax factor + how many stars + size/brightness range
const LAYERS = [
  { parallax: 0.08, count: Math.floor(90 * STAR_DENSITY), minSize: 0.6, maxSize: 1.1, alpha: 0.35 },
  { parallax: 0.18, count: Math.floor(70 * STAR_DENSITY), minSize: 0.8, maxSize: 1.4, alpha: 0.55 },
  { parallax: 0.35, count: Math.floor(50 * STAR_DENSITY), minSize: 1.0, maxSize: 1.8, alpha: 0.75 },
  { parallax: 0.55, count: Math.floor(30 * STAR_DENSITY), minSize: 1.2, maxSize: 2.2, alpha: 0.90 },
];

function randomStar(layer) {
  return {
    x: Math.random() * 4000 - 500, // spread a bit wider than typical view
    y: Math.random() * 4000 - 500,
    size: layer.minSize + Math.random() * (layer.maxSize - layer.minSize),
    brightness: 0.5 + Math.random() * 0.5,
  };
}

// Screen-space vertical gradient, top to bottom — a stack of thin solid
// strips. Strips overlap by 1px so there's no visible seam line.
// (The colours themselves change with where the view is — see
// SkyRegions.skyColors; TOP_COLOR/BOTTOM_COLOR are only the fallback.)
function drawBackgroundGradient(top, bottom) {
  top = top ?? TOP_COLOR;
  bottom = bottom ?? BOTTOM_COLOR;
  const w = love.graphics.getWidth();
  const h = love.graphics.getHeight();
  const stripH = h / GRADIENT_STRIPS;

  for (let i = 0; i < GRADIENT_STRIPS; i++) {
    const t = i / (GRADIENT_STRIPS - 1);
    love.graphics.setColor(
      top[0] + (bottom[0] - top[0]) * t,
      top[1] + (bottom[1] - top[1]) * t,
      top[2] + (bottom[2] - top[2]) * t,
      1,
    );
    love.graphics.rectangle('fill', 0, i * stripH, w, stripH + 1);
  }

  love.graphics.setColor(1, 1, 1, 1);
}

class Starfield {
  static new() {
    return new Starfield();
  }

  constructor() {
    this.layers = [];
    for (const def of LAYERS) {
      const stars = [];
      for (let i = 0; i < def.count; i++) stars.push(randomStar(def));
      this.layers.push({ parallax: def.parallax, alpha: def.alpha, stars });
    }
  }

  // Optional: regenerate stars
  regenerate() {
    for (const layer of this.layers) {
      for (const star of layer.stars) {
        star.x = Math.random() * 4000 - 500;
        star.y = Math.random() * 4000 - 500;
      }
    }
  }

  draw(camera, visibleWidth, visibleHeight) {
    const camX = camera ? camera.x : 0;
    const camY = camera ? camera.y : 0;

    // The sky's colour for this part of space, and the far-off scenery
    // (nebulae, landmarks) behind every star — see SkyRegions.js.
    const viewX = camX + (visibleWidth ?? 0) / 2, viewY = camY + (visibleHeight ?? 0) / 2;
    const [skyTop, skyBottom] = SkyRegions.skyColors(viewX, viewY);
    drawBackgroundGradient(skyTop, skyBottom);
    SkyRegions.draw('far', viewX, viewY);
    // (For the background asteroids' lit edges: which way the sun is from here.)
    const [sunX, sunY] = SkyRegions.sunPos();
    let toSunX = sunX - viewX, toSunY = sunY - viewY;
    const toSun = Math.sqrt(toSunX * toSunX + toSunY * toSunY);
    if (toSun > 1000) { toSunX /= toSun; toSunY /= toSun; } else { toSunX = null; toSunY = null; }

    // Stars are drawn in SCREEN pixels, so what has to be covered is the
    // window itself — not visibleWidth/visibleHeight (world units).
    const screenW = love.graphics.getWidth(), screenH = love.graphics.getHeight();
    const wrap = 3000;

    for (let i = 0; i < this.layers.length; i++) {
      const layer = this.layers[i];
      // (Dust lanes go in after the two furthest layers: they hide the
      // distant stars, but the nearer ones show in front of them.)
      if (i === 2) SkyRegions.draw('dust', viewX, viewY);
      const px = camX * layer.parallax;
      const py = camY * layer.parallax;

      love.graphics.setColor(0.85, 0.9, 1.0, layer.alpha);

      for (const star of layer.stars) {
        // Wrap stars so they stay in a reasonable range around the view
        const sx = lua.mod(star.x - px, wrap);
        const sy = lua.mod(star.y - py, wrap);

        // The pattern repeats every `wrap` pixels, tiled across however
        // much window there is.
        const radius = star.size * star.brightness;
        for (let y = sy; y < screenH + 50; y += wrap) {
          for (let x = sx; x < screenW + 50; x += wrap) {
            love.graphics.circle('fill', x, y, radius);
          }
        }
      }
    }

    // The background asteroids, in front of every star (see
    // BackgroundAsteroids.js).
    BackgroundAsteroids.draw(camX, camY, toSunX, toSunY);

    love.graphics.setColor(1, 1, 1, 1);
  }
}

export default Starfield;
