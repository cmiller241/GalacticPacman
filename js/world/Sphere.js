// js/world/Sphere.js
//
// A small, fixed metallic ball — a lightweight landmark planetoid, not a
// drifting field body. Built on top of Planetoid.new() the same way
// WaterPlanet.js is (isImmovable + isPermanent + a plain vel of zero,
// plus a custom draw override), so it gets exactly the same gravity /
// landing / pull-beam eligibility as every other entry in
// state.planetoids for free.
//
// Placed via Tiled's Object Layer (tiled/Level1, class = "Sphere") —
// see TiledTerrain.js's sphereSpawns and main.js's own spawn loop. The
// object's x/y IS the sphere's center, unlike ooombaSpawns (which get
// raycast down onto whatever terrain sits below them).

import Planetoid from './Planetoid.js';
import Vector2 from '../vector2.js';
import GlowOrb from '../effects/GlowOrb.js';

const Sphere = {};

Sphere.DEFAULT_RADIUS = 30;
Sphere.COLOR = [0.6, 0.63, 0.67, 1];

// GPU-shaded metallic look (see js/effects/GlowOrb.js) — a cool,
// silvery gradient with a soft blue-white ambient glow.
const ORB_COLORS = {
  dark: [0.22, 0.24, 0.28],
  light: [0.78, 0.81, 0.86],
  rim: [0.92, 0.95, 1.0],
  glow: [0.55, 0.70, 0.95],
};

// With the same soft sun-side highlight every ordinary planetoid has,
// read straight from Planetoid's own settings so the two always match.
//
// And with the chrome gradient multiplied over it (see GlowOrb.js's own
// metal block and js/effects/MetalGradient.js) — the same metal as the
// title-screen logo, wrapped round the ball. METAL_OPACITY is how
// strongly: 0 none, 1 the full gradient.
Sphere.METAL_OPACITY = 0.5;

function drawMetallic() {
  GlowOrb.draw(this.pos.x, this.pos.y, this.radius, ORB_COLORS, {
    metalOpacity: Sphere.METAL_OPACITY,
    highlightAlpha: Planetoid.HIGHLIGHT_ALPHA,
    highlightSize: Planetoid.HIGHLIGHT_SIZE,
    highlightOffset: Planetoid.HIGHLIGHT_OFFSET,
  });
}

// x, y: world position of the sphere's CENTER.
Sphere.new = function (x, y, radius) {
  const self = Planetoid.new(x, y, radius ?? Sphere.DEFAULT_RADIUS, Sphere.COLOR);

  // Fixed landmark, not a drifting field planetoid.
  self.isImmovable = true;
  self.isPermanent = true;
  self.vel = new Vector2(0, 0);

  // A quarter of Planetoid's own default influenceRadius — that padding
  // is tuned for the much bigger belt/water planets, and read as a
  // wildly oversized gravity well around a small landmark this size.
  self.influenceRadius = self.influenceRadius / 4;

  self.draw = drawMetallic;

  return self;
};

export default Sphere;
