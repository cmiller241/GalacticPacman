// js/world/Plunger.js
//
// A pinball plunger on the ground, mounted against a wall: Bob runs into
// its striker, keeps pushing to load the spring, and when he lets go of
// the direction he was pushing, it snaps back and fires him the other way
// — a launch boost (see Player.move's launchBoost): for a couple of
// seconds he's driven on, much faster than he can run. Curled up as a
// ball that carries him right through a ball tunnel (Level1's, say);
// standing, he's fired just as hard, but a tunnel's mouth stops him (see
// TiledTerrain.js's headroom).
//
// Placed in Tiled as an object of class "RightPlunger" (mounted on the
// left of its tile, fires right) or "LeftPlunger" (the mirror image), on
// the tile it sits in — see TiledTerrain.js's plungerSpawns.
//
// Drawn: a steel backplate bolted to the wall, with three charge lights;
// a coiled spring on a rod; and a red striker with a black rubber face.
// Port of lua/world/Plunger.lua.

import love from '../love/index.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import Particle from '../entities/Particle.js';
import CameraShake from '../effects/CameraShake.js';

const T = 64;                    // a tile, in world units
const PLATE_W = 10;              // the backplate's thickness
const HEAD_W = 14;               // the striker's thickness
const REST_FACE = 60;            // the striker's face, from the wall, at rest
const MAX_COMPRESS = 32;         // how far it can be pushed back
const COMPRESS_RATE = 1.4;       // units per frame he pushes it back
const MIN_FIRE = 5;              // less than this and it just relaxes, no launch
const BOOST_MAX = 4.5;           // speed multiplier at a full charge...
const BOOST_FRAMES = 150;        // ...lasting this long (60fps frames), easing back to normal
const SNAP_FRAMES = 40;          // the striker's wobble after firing

function resync(player) {
  const planet = player.currentPlanet;
  if (player.onSurface && planet && typeof planet.arcPositionForWorldPoint === 'function') {
    player.surfaceArcPos = planet.arcPositionForWorldPoint(player.pos.x, player.pos.y);
  }
}

function puff(x, y, dir) {
  if (!state.particles) return;
  for (let k = 0; k < 10; k++) {
    const speed = 1 + Math.random() * 3;
    const a = (dir > 0 ? 0 : Math.PI) + (Math.random() - 0.5) * 1.4 - 0.3;
    const p = Particle.new(Vector2.new(x, y), Vector2.new(Math.cos(a) * speed, Math.sin(a) * speed - 0.5),
      22 + Math.random() * 18);
    p.color = [0.85, 0.82, 0.74];
    p.radius = 3 + Math.random() * 4;
    p.growRate = 0.2;
    p.drag = 0.92;
    state.particles.push(p);
  }
}

const steel = (k, a = 1) => love.graphics.setColor(0.62 * k, 0.66 * k, 0.72 * k, a);

class Plunger {
  static new(x, y, dir) {
    return new Plunger(x, y, dir);
  }

  constructor(x, y, dir) {
    this.x = x; this.y = y;      // its tile's top-left corner
    this.dir = dir ?? 1;         // 1: mounted on the left, fires right
    this.compress = 0;
    this.snap = 0;               // frames left of the wobble after firing
    this.snapFrom = 0;
    this.wasPushing = false;
    this.charge = 0;             // 0..1, for the lights
    // Bounding center/radius, for on-screen culling like everything else.
    this.pos = Vector2.new(x + T / 2, y + T / 2);
    this.radius = T;
  }

  // The striker's face, as distance from the wall, right now.
  faceOffset() {
    let off = REST_FACE - this.compress;
    if (this.snap > 0) {
      // A springy wobble round the rest position after firing.
      const t = 1 - this.snap / SNAP_FRAMES;
      off = REST_FACE + Math.sin(t * Math.PI * 5) * (1 - t) * 10;
    }
    return off;
  }

  // In world space: where the face is (an x), and which way it pushes.
  faceX() {
    const wallX = this.dir > 0 ? this.x : (this.x + T);
    return wallX + this.dir * this.faceOffset();
  }

  update(player, ts = 1) {
    if (this.snap > 0) this.snap = Math.max(0, this.snap - ts);
    if (!player || player.isDying || player.isTeleporting) return;

    let face = this.faceX();
    const r = player.radius;
    // Is he level with it, on its pushing side, touching (or past) its face?
    const midY = this.y + T / 2;
    const level = Math.abs(player.pos.y - midY) < T / 2 + r * 0.4;
    let side = (player.pos.x - face) * this.dir; // how far in front of the face his center is
    const touching = level && side < r + 1.5 && side > -T;
    const pushKey = this.dir > 0 ? 'ArrowLeft' : 'ArrowRight';
    const pushing = !!(touching && player.onSurface && state.keys[pushKey] && this.snap <= 0);

    if (pushing) {
      this.compress = Math.min(MAX_COMPRESS, this.compress + COMPRESS_RATE * ts);
    } else if (this.compress > 0) {
      if (this.wasPushing && touching && player.onSurface && this.compress >= MIN_FIRE) {
        // Let go: fire.
        const charge = this.compress / MAX_COMPRESS;
        const mult = 1 + (BOOST_MAX - 1) * charge;
        const frames = 40 + BOOST_FRAMES * charge;
        player.launchBoost = { dir: this.dir, mult, mult0: mult, time: frames, time0: frames };
        player.facingDirection = this.dir;
        this.snapFrom = this.compress;
        this.compress = 0;
        this.snap = SNAP_FRAMES;
        puff(face, this.y + T - 6, this.dir);
        CameraShake.start(3 + 4 * charge, 0.15);
        if (state.audioManager) state.audioManager.playJump();
      } else {
        // Backed off (or jumped away) without letting go: it just relaxes.
        this.compress = Math.max(0, this.compress - 4 * ts);
      }
    }
    this.wasPushing = pushing;
    this.charge = this.compress / MAX_COMPRESS;

    // The striker is solid: he can't get past its face.
    face = this.faceX();
    side = (player.pos.x - face) * this.dir;
    if (level && side < r && side > -T) {
      player.pos.x = face + this.dir * r;
      if (player.vel.x * this.dir < 0) player.vel.x = 0;
      resync(player);
    }
  }

  // Drawing (in its own frame: x across from the wall, y down from the
  // tile's top; mirrored for a LeftPlunger).
  draw() {
    const g = love.graphics;
    const floorY = T; // (the tile's bottom: the ground it stands on)
    const midY = floorY - 30;
    const face = this.faceOffset();
    const headX = face - HEAD_W;

    g.push('all');
    g.translate(this.dir > 0 ? this.x : (this.x + T), this.y);
    g.scale(this.dir, 1);
    g.setLineJoin('bevel');
    g.setLineStyle('smooth');

    // A rail along the ground.
    g.setColor(0.16, 0.17, 0.2, 1);
    g.rectangle('fill', 0, floorY - 5, T - 2, 5, 2, 2);
    steel(0.8);
    g.rectangle('fill', 0, floorY - 5, T - 2, 1.5);

    // Backplate, bolted to the wall.
    g.setColor(0.13, 0.14, 0.17, 1);
    g.rectangle('fill', -1, floorY - 58, PLATE_W + 3, 56, 3, 3);
    g.setColor(0.27, 0.29, 0.34, 1);
    g.rectangle('fill', 0, floorY - 57, PLATE_W, 54, 2, 2);
    steel(1.15);
    g.rectangle('fill', 1, floorY - 56, 2, 52);
    for (const by of [floorY - 52, floorY - 8]) {
      g.setColor(0.1, 0.1, 0.12, 1);
      g.circle('fill', PLATE_W / 2, by, 2.6, 10);
      steel(1.3);
      g.circle('fill', PLATE_W / 2 - 0.6, by - 0.6, 1.4, 8);
    }
    // Charge lights: yellow, orange, red, lighting up as it's pushed back.
    const lights = [[1, 0.85, 0.2], [1, 0.55, 0.12], [1, 0.2, 0.12]];
    lights.forEach((c, i) => {
      const ly = floorY - 42 + i * 9;
      const lit = Math.max(0, Math.min(1, this.charge * 3 - i));
      g.setColor(0.08, 0.08, 0.1, 1);
      g.circle('fill', PLATE_W / 2, ly, 3.2, 12);
      g.setColor(c[0] * (0.25 + 0.75 * lit), c[1] * (0.25 + 0.75 * lit), c[2] * (0.25 + 0.75 * lit), 1);
      g.circle('fill', PLATE_W / 2, ly, 2.4, 12);
      if (lit > 0) {
        g.setBlendMode('add');
        g.setColor(c[0], c[1], c[2], 0.35 * lit);
        g.circle('fill', PLATE_W / 2, ly, 6, 16);
        g.setBlendMode('alpha');
      }
    });

    // The rod, through the spring.
    g.setColor(0.12, 0.12, 0.14, 1);
    g.setLineWidth(5);
    g.line(PLATE_W, midY, headX + 2, midY);
    steel(1.1);
    g.setLineWidth(2);
    g.line(PLATE_W, midY - 1, headX + 2, midY - 1);

    // The spring: coils squeezed between the plate and the striker.
    const x0 = PLATE_W + 1, x1 = headX - 1;
    const coils = 7;
    const amp = 13;
    const pts = [];
    const steps = coils * 8;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      pts.push(x0 + (x1 - x0) * t, midY + Math.sin(t * coils * Math.PI * 2) * amp);
    }
    g.setColor(0.1, 0.1, 0.12, 1);
    g.setLineWidth(5);
    g.line(pts);
    steel(1.05);
    g.setLineWidth(3);
    g.line(pts);
    // (a glint along the coils' tops)
    g.setColor(1, 1, 1, 0.55);
    g.setLineWidth(1);
    for (let i = 0; i < coils; i++) {
      const t = (i + 0.25) / coils;
      const cx = x0 + (x1 - x0) * t;
      g.line(cx - 1, midY - amp + 1, cx + 1, midY - amp + 2);
    }

    // The striker: a red block with a black rubber face.
    const top = floorY - 52, h = 44;
    if (this.charge > 0) {
      g.setBlendMode('add');
      g.setColor(1, 0.4 + 0.3 * (1 - this.charge), 0.15, 0.25 * this.charge);
      g.circle('fill', face, midY, 26 + 6 * this.charge, 24);
      g.setBlendMode('alpha');
    }
    g.setColor(0.25, 0.04, 0.04, 1);
    g.rectangle('fill', headX - 1, top - 1, HEAD_W + 2, h + 2, 4, 4);
    g.setColor(0.82, 0.16, 0.13, 1);
    g.rectangle('fill', headX, top, HEAD_W - 4, h, 3, 3);
    g.setColor(1, 0.5, 0.42, 1);
    g.rectangle('fill', headX + 2, top + 3, 3, h - 6, 1.5, 1.5);
    g.setColor(0.55, 0.08, 0.07, 1);
    g.rectangle('fill', headX + HEAD_W - 8, top + 2, 2, h - 4);
    // rubber face
    g.setColor(0.07, 0.07, 0.08, 1);
    g.rectangle('fill', face - 4, top + 1, 4, h - 2, 2, 2);
    g.setColor(0.3, 0.3, 0.33, 1);
    g.rectangle('fill', face - 3, top + 4, 1, h - 8);

    g.pop();
  }
}

export default Plunger;
