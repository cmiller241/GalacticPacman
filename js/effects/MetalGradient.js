// js/effects/MetalGradient.js
//
// The chrome-style gradient that gets MULTIPLIED over things meant to
// look like polished metal — the title-screen logo (TitleScreen.js)
// and metallic Spheres (GlowOrb.js, via Sphere.js). One gradient,
// defined here, so everything metal in the game is the same metal.
//
// It's the classic chrome look, read from one end to the other: cool
// sky tones, brightening to white, a hard dark "horizon" line just past
// the middle, then warm tones beyond it. Handed out as a 1-pixel-wide
// image strip for a shader to sample by position (0 at the top of the
// strip, 1 at the bottom).

import love from '../love/index.js';

const MetalGradient = {};

MetalGradient.STOPS = [
  // [position (0 = sky end, 1 = ground end), r, g, b]
  [0.00, 0.62, 0.74, 0.95],
  [0.30, 0.90, 0.95, 1.00],
  [0.47, 1.00, 1.00, 1.00],
  [0.52, 0.30, 0.33, 0.44], // the horizon line
  [0.62, 0.62, 0.58, 0.60],
  [0.84, 1.00, 0.92, 0.76],
  [1.00, 0.72, 0.60, 0.50],
];

const STRIP_HEIGHT = 256;
let image = null;

// The gradient as a 1 x 256 image, linear-filtered. Built once.
MetalGradient.getImage = function () {
  if (image) return image;
  const stops = MetalGradient.STOPS;
  const data = love.image.newImageData(1, STRIP_HEIGHT);
  for (let y = 0; y < STRIP_HEIGHT; y++) {
    const t = y / (STRIP_HEIGHT - 1);
    let a = stops[0], b = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (t >= stops[i][0] && t <= stops[i + 1][0]) {
        a = stops[i];
        b = stops[i + 1];
        break;
      }
    }
    const span = Math.max(1e-6, b[0] - a[0]);
    const k = Math.max(0, Math.min(1, (t - a[0]) / span));
    data.setPixel(0, y, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k, 1);
  }
  image = love.graphics.newImage(data);
  image.setFilter('linear', 'linear');
  return image;
};

export default MetalGradient;
