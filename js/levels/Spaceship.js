// js/levels/Spaceship.js
//
// Bob's spaceship: a round metal mail ship, styled like a postmark (a blue
// steel hull with the route printed in a ring round a big window, and a
// mailbox flag on top). Outside, it's a round planet like any other: he
// can land on it and walk all the way round. The beam on its top takes him
// inside (see js/interiors/ShipInterior.js), where he walks about on his
// feet, and the console flies it. A second beam inside, on the bottom
// floor, takes him back out.
//
// The hull is drawn by a metal shader (js/effects/ShipHull.js), and the
// engine burns with the same fire as Bob's fireballs: the shader flame
// (js/effects/Flame.js), a heat glow, fire puffs cooling into smoke, and
// sparks (see js/entities/Fireball.js).
//
// It drifts like any loose planetoid (so rocks that hit it shove it a
// little), but on its own it coasts to a stop: only flying moves it far.
// Both beams ride along with it.
//
// Parked to the left of the fisherman's planet.
// Port of lua/levels/Spaceship.lua.

import love from '../love/index.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import Planetoid from '../world/Planetoid.js';
import Beam from '../world/Beam.js';
import ShipInterior from '../interiors/ShipInterior.js';
import ShipHull from '../effects/ShipHull.js';
import Flame from '../effects/Flame.js';
import Fireball from '../entities/Fireball.js';

const Spaceship = {};

// From the fisherman's planet's left edge.
const OFFSET_X = -1500, OFFSET_Y = -300;
// Heavier than a rock its size, so rocks bump off it rather than it off them.
const MASS_MULTIPLIER = 4;
// With nobody flying it: how much of its speed it keeps per tick.
const PARKED_COAST = 0.96;
const BEAM_COLOR = [1.00, 0.78, 0.30]; // mail-truck yellow

// The engine. Its nozzle sticks out of the hull on the side away from the
// way it's being pushed (NOZZLE_LENGTH past the hull's edge), and its fire
// comes out of the nozzle's mouth.
const NOZZLE_LENGTH = 34;
// How fast the engine's fire grows and dies down (fraction of the way to
// full or out, per tick).
const ENGINE_SPOOL = 0.12;
// The flame (see Flame.draw): its ball's radius and tail length (in ball
// radii) at no thrust and the extra at full thrust.
const FLAME_RADIUS = 20, FLAME_RADIUS_FULL = 20;
const FLAME_STRETCH = 2.2, FLAME_STRETCH_FULL = 2.4;
const FLAME_SEED = 7.3;
// The exhaust: fire puffs (fire at first, cooling into smoke) and sparks
// thrown out of the nozzle, as with a fireball's trail (see Fireball.js).
const PUFFS_PER_TICK = 3;
const PUFF_LIFE_MIN = 16, PUFF_LIFE_RANGE = 14;
const PUFF_SPEED = 8;             // out of the nozzle, at full thrust
const PUFF_DRAG = 0.95;           // speed kept per tick
const PUFF_FIRE_FRACTION = 0.4;   // the first part of a puff's life it's fire; smoke after
const PUFF_GROWTH = 1.8;          // how much bigger a puff gets over its life
const SPARK_CHANCE = 0.7;         // per tick, at full thrust
const SPARK_LIFE_MIN = 10, SPARK_LIFE_RANGE = 10;

const COLOR_OUTLINE = [0.04, 0.04, 0.08, 1];
const COLOR_HULL = [0.42, 0.55, 0.85]; // the steel's blue tint
const COLOR_PAPER = [0.96, 0.94, 0.88, 0.92];
const COLOR_GLASS = [0.55, 0.84, 0.98, 1];
const COLOR_GLASS_DEEP = [0.30, 0.55, 0.80, 1];
const COLOR_FRAME = [0.62, 0.66, 0.74, 1];
const COLOR_FRAME_LIGHT = [0.92, 0.94, 0.98, 1];
const COLOR_FLAG = [0.89, 0.23, 0.23, 1];
const COLOR_POLE = [0.70, 0.74, 0.84, 1];
const COLOR_NOZZLE = [0.48, 0.52, 0.60, 1];
const COLOR_NOZZLE_LIGHT = [0.82, 0.86, 0.92, 1];
const RING_TEXT = "BOB'S DELIVERY  *  ROUTE 7  *  ASTEROID BELT  *  ";
const RING_TEXT_HEIGHT = 34; // world units

Spaceship.build = function () {
  let x, y;
  const rect = state.roundedRectPlanet;
  if (rect) {
    x = rect.pos.x - rect.halfWidth + OFFSET_X;
    y = rect.pos.y + OFFSET_Y;
  } else {
    x = state.sceneWidth / 2 + 4000;
    y = state.sceneHeight / 2;
  }
  const ship = Planetoid.new(x, y, ShipInterior.HULL_RADIUS, COLOR_HULL);
  ship.isSpaceship = true;
  ship.isPermanent = true;
  ship.vel.x = 0; ship.vel.y = 0;
  ship.mass *= MASS_MULTIPLIER;
  // Which way it's being pushed while flying (see ShipInterior.fly).
  ship.thrustX = 0; ship.thrustY = 0;
  // The engine: how hard it's burning (0 to 1, easing after the thrust),
  // which way its fire points (away from the ship), its fire's clock (in
  // game seconds), and its exhaust.
  ship.enginePower = 0;
  ship.exhaustX = 0; ship.exhaustY = 1;
  ship.flameTime = 0;
  ship.puffs = [];
  ship.sparks = [];
  ship.interior = ShipInterior.new(ship);
  ship.draw = function () { Spaceship.draw(this); };
  ship.update = function () { Spaceship.update(this); };
  state.planetoids.push(ship);
  state.spaceship = ship;
  return ship;
};

// The two beams: one on top of the hull, in (shown while he's outside), and
// one on the bottom floor inside, out (shown while he's in). Both are kept
// where they belong as the ship moves (see placeBeams).
Spaceship.addBeams = function (ship) {
  const interior = ship.interior;
  const inBeam = Beam.new(0, 0, -Math.PI / 2, BEAM_COLOR);
  inBeam.destination = {
    pos: Vector2.new(0, 0),
    angle: -Math.PI / 2,
    onArrive: (player) => interior.onEnter(player),
  };
  inBeam.showWhen = () => !interior.hasPlayer();

  const outBeam = Beam.new(0, 0, -Math.PI / 2, BEAM_COLOR);
  outBeam.destination = {
    pos: Vector2.new(0, 0),
    angle: ShipInterior.EXIT_ANGLE,
    onArrive: (player) => interior.arriveOutside(player),
  };
  outBeam.showWhen = () => interior.hasPlayer();
  outBeam.fade = 0; // (hidden from the start, not fading out)
  // The inside is a small room: he has to be at the pad, not just on its floor.
  outBeam.interactRadius = 90;

  ship.inBeam = inBeam;
  ship.outBeam = outBeam;
  interior.beam = outBeam;
  Spaceship.placeBeams(ship);
  state.beams.push(inBeam);
  state.beams.push(outBeam);
};

// Puts both beams (and where each sends him) where they belong on the ship
// as it is now. Their drifting motes move with them.
Spaceship.placeBeams = function (ship) {
  const inBeam = ship.inBeam, outBeam = ship.outBeam;
  if (!inBeam) return;
  const top = Vector2.new(ship.pos.x, ship.pos.y - ship.radius);
  const pad = ship.interior.padPosition();
  for (const [beam, at] of [[inBeam, top], [outBeam, pad]]) {
    const dx = at.x - beam.pos.x, dy = at.y - beam.pos.y;
    beam.pos.x = at.x; beam.pos.y = at.y;
    for (const p of beam.beamParticles) { p.pos.x += dx; p.pos.y += dy; }
  }
  const inDest = inBeam.destination.pos, outDest = outBeam.destination.pos;
  inDest.x = pad.x; inDest.y = pad.y;
  const exit = ship.interior.exitPosition();
  outDest.x = exit.x; outDest.y = exit.y;
};

// Where the engine's fire comes out: the nozzle's mouth, in world space.
function nozzleMouth(ship) {
  const d = ship.radius + NOZZLE_LENGTH - 8;
  return [ship.pos.x + ship.exhaustX * d, ship.pos.y + ship.exhaustY * d];
}

// The engine, every tick: it burns as hard as the ship's being pushed
// (easing up and down), and throws out fire puffs and sparks while it does.
// The puffs and sparks already out keep going, slowing, till they die out —
// left behind in space as the ship flies on.
function updateEngine(ship, ts) {
  const tx = ship.thrustX || 0, ty = ship.thrustY || 0;
  const push = Math.sqrt(tx * tx + ty * ty);
  if (push > 0.05) { ship.exhaustX = -tx / push; ship.exhaustY = -ty / push; }
  ship.enginePower += (push - ship.enginePower) * Math.min(1, ENGINE_SPOOL * ts);
  if (ship.enginePower < 0.01) ship.enginePower = 0;
  ship.flameTime += ts / 60;

  const power = ship.enginePower;
  if (power > 0.05) {
    const [mx, my] = nozzleMouth(ship);
    const dx = ship.exhaustX, dy = ship.exhaustY;
    const sx = -dy, sy = dx;
    for (let i = 0; i < PUFFS_PER_TICK; i++) {
      if (Math.random() < power * ts) {
        const spread = (Math.random() - 0.5) * 50 * power;
        const speed = PUFF_SPEED * power * (0.6 + 0.6 * Math.random());
        const side = (Math.random() - 0.5) * 1.2;
        const maxLife = PUFF_LIFE_MIN + Math.random() * PUFF_LIFE_RANGE;
        ship.puffs.push({
          x: mx + sx * spread, y: my + sy * spread,
          vx: ship.vel.x + dx * speed + sx * side, vy: ship.vel.y + dy * speed + sy * side,
          life: maxLife, maxLife,
          size: (10 + 10 * Math.random()) * (0.6 + 0.4 * power),
        });
      }
    }
    if (Math.random() < SPARK_CHANCE * power * ts) {
      const a = Math.atan2(dy, dx) + (Math.random() - 0.5) * 1.0;
      const speed = (8 + 8 * Math.random()) * power;
      const maxLife = SPARK_LIFE_MIN + Math.random() * SPARK_LIFE_RANGE;
      ship.sparks.push({
        x: mx, y: my,
        vx: ship.vel.x + Math.cos(a) * speed, vy: ship.vel.y + Math.sin(a) * speed,
        life: maxLife, maxLife,
      });
    }
  }

  const keep = Math.pow(PUFF_DRAG, ts);
  for (let i = ship.puffs.length - 1; i >= 0; i--) {
    const p = ship.puffs[i];
    p.x += p.vx * ts; p.y += p.vy * ts;
    p.vx *= keep; p.vy *= keep;
    p.life -= ts;
    if (p.life <= 0) ship.puffs.splice(i, 1);
  }
  for (let i = ship.sparks.length - 1; i >= 0; i--) {
    const s = ship.sparks[i];
    s.x += s.vx * ts; s.y += s.vy * ts;
    s.life -= ts;
    if (s.life <= 0) ship.sparks.splice(i, 1);
  }
}

// Every frame, before the player moves (see main.js's updateWorld): with
// nobody flying it, it coasts to a stop; the engine burns (or dies down);
// and the beams keep up with it.
Spaceship.update = function (ship) {
  const ts = state.timeScale ?? 1;
  const interior = ship.interior;
  // (He can leave without letting go of the controls — teleported away,
  // say. Then nobody's flying it.)
  if (interior.piloting && !interior.hasPlayer()) interior.piloting = false;
  if (!interior.piloting) {
    ship.thrustX = 0; ship.thrustY = 0;
    const keep = Math.pow(PARKED_COAST, ts);
    ship.vel.x *= keep; ship.vel.y *= keep;
  }
  updateEngine(ship, ts);
  Spaceship.placeBeams(ship);
};

// ----------------------------------------------------------------------
// Drawing the outside
// ----------------------------------------------------------------------

// The exhaust and the engine's fire, the way a fireball's drawn (see
// Fireball.draw): smoke, fire puffs, sparks, a heat glow, and the shader
// flame at the nozzle's mouth with its tail streaming out behind.
function drawExhaust(ship) {
  const g = love.graphics;
  const drawGlow = Fireball.drawGlow, fireColor = Fireball.fireColor;
  g.push('all');

  for (const p of ship.puffs) {
    const life = p.life / p.maxLife;
    if (life < PUFF_FIRE_FRACTION + 0.1) {
      const k = Math.min(1, life / PUFF_FIRE_FRACTION);
      const size = p.size * (1 + PUFF_GROWTH * (1 - life));
      g.setColor(0.32, 0.3, 0.3, 0.3 * k);
      drawGlow(p.x, p.y, size * 2.6);
    }
  }

  g.setBlendMode('add');
  for (const p of ship.puffs) {
    const life = p.life / p.maxLife;
    if (life > PUFF_FIRE_FRACTION) {
      const heat = (life - PUFF_FIRE_FRACTION) / (1 - PUFF_FIRE_FRACTION);
      const size = p.size * (1 + PUFF_GROWTH * (1 - life));
      const [r, gg, b] = fireColor(heat);
      g.setColor(r, gg, b, 0.6 * heat);
      drawGlow(p.x, p.y, size * 2.8);
    }
  }

  g.setLineWidth(2.5);
  for (const s of ship.sparks) {
    const a = s.life / s.maxLife;
    const [r, gg, b] = fireColor(0.4 + 0.6 * a);
    g.setColor(r, gg, b, a);
    g.line(s.x, s.y, s.x - (s.vx - ship.vel.x) * 2.5, s.y - (s.vy - ship.vel.y) * 2.5);
  }

  const power = ship.enginePower;
  if (power > 0.03) {
    const [mx, my] = nozzleMouth(ship);
    const flicker = Math.sin(ship.flameTime * 20);
    const radius = (FLAME_RADIUS + FLAME_RADIUS_FULL * power) * (1 + flicker * 0.05);
    g.setColor(1, 0.45, 0.1, (0.45 + 0.1 * flicker) * Math.min(1, power * 2));
    drawGlow(mx, my, radius * 7);
    g.pop();
    // (Heading into the ship, so its tail streams out away from it.)
    Flame.draw(mx, my, radius, Math.atan2(-ship.exhaustY, -ship.exhaustX),
      FLAME_STRETCH + FLAME_STRETCH_FULL * power, ship.flameTime, FLAME_SEED);
  } else {
    g.pop();
  }
}

// The nozzle, out of the hull where the fire comes from: a steel bell
// widening toward its mouth.
function drawNozzle(ship) {
  if (ship.enginePower <= 0.03) return;
  const g = love.graphics;
  const dx = ship.exhaustX, dy = ship.exhaustY;
  const sx = -dy, sy = dx;
  const R = ship.radius;
  const bx = ship.pos.x + dx * (R - 12), by = ship.pos.y + dy * (R - 12);
  const L = NOZZLE_LENGTH + 12;
  const bell = (inset, color) => {
    g.setColor(color);
    g.polygon('fill',
      bx + sx * (44 - inset), by + sy * (44 - inset),
      bx + dx * (L - inset * 0.5) + sx * (64 - inset), by + dy * (L - inset * 0.5) + sy * (64 - inset),
      bx + dx * (L - inset * 0.5) - sx * (64 - inset), by + dy * (L - inset * 0.5) - sy * (64 - inset),
      bx - sx * (44 - inset), by - sy * (44 - inset));
  };
  bell(-6, COLOR_OUTLINE);
  bell(0, COLOR_NOZZLE);
  // A bright streak down one side of the bell: polished metal.
  g.setColor(COLOR_NOZZLE_LIGHT);
  g.polygon('fill',
    bx + sx * 30, by + sy * 30, bx + dx * L + sx * 48, by + dy * L + sy * 48,
    bx + dx * L + sx * 36, by + dy * L + sy * 36, bx + sx * 20, by + sy * 20);
  // Its glowing mouth.
  g.setColor(1, 0.6, 0.2, Math.min(1, ship.enginePower * 2));
  g.setLineWidth(6);
  g.line(bx + dx * L + sx * 58, by + dy * L + sy * 58, bx + dx * L - sx * 58, by + dy * L - sy * 58);
}

// `text` set round a circle of `radius` about (x, y), each letter upright to
// the circle, starting at the top and going clockwise.
function drawRingText(text, x, y, radius, height) {
  const g = love.graphics;
  const font = g.getFont();
  const scale = height / font.getHeight();
  const count = text.length;
  for (let i = 0; i < count; i++) {
    const ch = text[i];
    if (ch === ' ') continue;
    const a = -Math.PI / 2 + i / count * 2 * Math.PI;
    g.push();
    g.translate(x + Math.cos(a) * radius, y + Math.sin(a) * radius);
    g.rotate(a + Math.PI / 2);
    g.scale(scale, scale);
    g.print(ch, -font.getWidth(ch) / 2, -font.getHeight() / 2);
    g.pop();
  }
}

// The mailbox flag, up on its pole, a little left of the top.
function drawFlag(x, y, R, t) {
  const g = love.graphics;
  const fa = -Math.PI / 2 - 0.42;
  const c = Math.cos(fa), s = Math.sin(fa);
  const poleBaseX = x + c * (R - 10), poleBaseY = y + s * (R - 10);
  const poleTopX = x + c * (R + 95), poleTopY = y + s * (R + 95);
  g.setColor(COLOR_OUTLINE);
  g.setLineWidth(14);
  g.line(poleBaseX, poleBaseY, poleTopX, poleTopY);
  g.setColor(COLOR_POLE);
  g.setLineWidth(7);
  g.line(poleBaseX, poleBaseY, poleTopX, poleTopY);
  // (The flag sticks out to the right of the pole, the way it's leaning.)
  const wave = Math.sin(t * 3) * 4;
  const fx = -s, fy = c; // along the hull, clockwise
  const flag = [
    poleTopX, poleTopY,
    poleTopX + fx * 70 + c * wave, poleTopY + fy * 70 + s * wave,
    poleTopX + fx * 70 - c * 36 + c * wave, poleTopY + fy * 70 - s * 36 + s * wave,
    poleTopX - c * 36, poleTopY - s * 36,
  ];
  g.setColor(COLOR_OUTLINE);
  g.setLineWidth(8);
  g.polygon('line', flag);
  g.setColor(COLOR_FLAG);
  g.polygon('fill', flag);
}

// The big window: glass in a steel frame, deeper blue toward the bottom,
// with a shine across its top.
function drawWindow(x, y, R) {
  const g = love.graphics;
  g.setColor(COLOR_OUTLINE);
  g.circle('fill', x, y, R * 0.53);
  g.setColor(COLOR_FRAME);
  g.circle('fill', x, y, R * 0.515);
  g.setColor(COLOR_FRAME_LIGHT);
  g.setLineWidth(5);
  g.arc('line', 'open', x, y, R * 0.505, Math.PI * 1.0, Math.PI * 1.6);
  g.setColor(COLOR_OUTLINE);
  g.circle('fill', x, y, R * 0.475);
  g.setColor(COLOR_GLASS_DEEP);
  g.circle('fill', x, y, R * 0.465);
  g.setColor(COLOR_GLASS);
  g.circle('fill', x - R * 0.04, y - R * 0.06, R * 0.41);
  g.setColor(1, 1, 1, 0.6);
  g.setLineWidth(10);
  g.arc('line', 'open', x, y, R * 0.36, Math.PI * 1.1, Math.PI * 1.4);
  g.setColor(1, 1, 1, 0.35);
  g.setLineWidth(5);
  g.arc('line', 'open', x, y, R * 0.29, Math.PI * 1.15, Math.PI * 1.3);
}

Spaceship.draw = function (ship) {
  const g = love.graphics;
  const x = ship.pos.x, y = ship.pos.y, R = ship.radius;
  const t = love.timer.getTime();

  drawExhaust(ship);
  drawNozzle(ship);
  drawFlag(x, y, R, t);

  // The hull: metal (see js/effects/ShipHull.js), inside a dark outline.
  g.setColor(COLOR_OUTLINE);
  g.circle('fill', x, y, R + 7);
  ShipHull.draw(x, y, R, COLOR_HULL);

  // The postmark, painted on: two rings with the route between them.
  g.setColor(COLOR_PAPER);
  g.setLineWidth(6);
  g.circle('line', x, y, R * 0.80);
  g.circle('line', x, y, R * 0.56);
  drawRingText(RING_TEXT, x, y, R * 0.68, RING_TEXT_HEIGHT);

  drawWindow(x, y, R);
  g.setColor(1, 1, 1, 1);
  g.setLineWidth(1);
};

export default Spaceship;
