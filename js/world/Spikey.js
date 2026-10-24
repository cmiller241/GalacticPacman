// js/world/Spikey.js
//
// A gray, metallic hazard ringed with rotating off-white spikes that
// kills the player on contact. Deliberately NOT a planet/planetoid —
// it doesn't live in state.planetoids at all, so it has no gravity, no
// landing, and isn't pull-targetable. It's just a solid, impassable
// obstacle: CollisionSystem.handlePlayerSpikeyCollisions stops the
// player at its boundary from any approach angle and sets
// touchingWall/wallContactNormal exactly like an ordinary TiledTerrain
// wall does, so the EXISTING wall-jump code in Player.jump() is what
// lets him "jump off of it".
//
// Stationary — placed via Tiled's Object Layer (class = "Spikey"). Only
// the spike RING itself spins slowly — a purely decorative flourish.

import love from '../love/index.js';
import Vector2 from '../vector2.js';
import state from '../state.js';
import GlowOrb from '../effects/GlowOrb.js';

// The core reads as a small, dark nucleus with a much longer ring of
// spikes reaching out from it (15+18=33 total reach).
const DEFAULT_RADIUS = 15;

// GPU-shaded body (see js/effects/GlowOrb.js) — noticeably DARKER than
// Sphere.js's own silvery colors, and a warm reddish glow that
// reinforces "hazard".
const ORB_COLORS = {
  dark: [0.05, 0.05, 0.06],
  light: [0.28, 0.26, 0.26],
  rim: [0.55, 0.42, 0.4],
  glow: [0.55, 0.18, 0.15],
};

const SPIKE_COLOR = [0.94, 0.93, 0.90, 1]; // bright off-white, standing out sharply against the dark core
const SPIKE_HEIGHT = 18;
const SPIKE_SPACING = 6;
// Radians per baseline (60fps) frame's worth of shared time.
const SPIKE_ROTATION_SPEED = 0.02;

// Shared spin clock — one value read by every Spikey's own draw(),
// advanced explicitly once per frame from main.js.
let sharedSpin = 0;

// A ring of thin triangles, base resting on the body's own circle, tip
// poking out SPIKE_HEIGHT further. numSpikes is derived from the body's
// own circumference, so a bigger Spikey gets proportionally more spikes.
function drawSpikes(x, y, radius, rotation) {
  const numSpikes = Math.max(3, Math.floor(2 * Math.PI * radius / SPIKE_SPACING));
  const angleStep = 2 * Math.PI / numSpikes;
  const halfBaseAngle = angleStep / 2;

  love.graphics.setColor(SPIKE_COLOR);
  for (let i = 0; i < numSpikes; i++) {
    const angle = i * angleStep + rotation;
    const leftAngle = angle - halfBaseAngle;
    const rightAngle = angle + halfBaseAngle;
    const baseLeftX = x + Math.cos(leftAngle) * radius, baseLeftY = y + Math.sin(leftAngle) * radius;
    const baseRightX = x + Math.cos(rightAngle) * radius, baseRightY = y + Math.sin(rightAngle) * radius;
    const tipX = x + Math.cos(angle) * (radius + SPIKE_HEIGHT), tipY = y + Math.sin(angle) * (radius + SPIKE_HEIGHT);
    love.graphics.polygon('fill', baseLeftX, baseLeftY, tipX, tipY, baseRightX, baseRightY);
  }
}

class Spikey {
  // x, y: world position of the hazard's CENTER. radius: collision +
  // visual body radius (spikes extend SPIKE_HEIGHT further out).
  static new(x, y, radius) {
    return new Spikey(x, y, radius);
  }

  static updateSharedClock() {
    const timeScale = state.timeScale ?? 1;
    sharedSpin += SPIKE_ROTATION_SPEED * timeScale;
  }

  // Shared by SpikeyVertical/SpikeyOrbit, which look identical.
  static drawBody(self) {
    GlowOrb.draw(self.pos.x, self.pos.y, self.radius, ORB_COLORS, {
      glowRadiusMult: 1.3,
      glowStrength: 0.4,
      rimStrength: 0.35,
    });
    drawSpikes(self.pos.x, self.pos.y, self.radius, sharedSpin);
    love.graphics.setColor(1, 1, 1, 1);
  }

  constructor(x, y, radius) {
    this.pos = new Vector2(x, y);
    this.radius = radius ?? DEFAULT_RADIUS;
  }

  draw() {
    Spikey.drawBody(this);
  }
}

Spikey.DEFAULT_RADIUS = DEFAULT_RADIUS;

export default Spikey;
