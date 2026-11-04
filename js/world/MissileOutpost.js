// js/world/MissileOutpost.js
//
// Missile outposts: small planets just past the asteroid belt's outer
// edge, each with a missile cannon on it and an Ooomba to fire it.
//
// The Ooomba (an ordinary one — lethal to touch, can be stomped or shot,
// see Ooomba.js — given a "brain" here that steers it instead of its
// usual patrol) just stands about at its post, round from the cannon.
// Once the player comes near (TRIGGER_RANGE of the planet), it walks
// briskly over to the cannon and mans it: the barrel swings round to
// follow him, and every FIRE_SECONDS it fires a homing missile at him.
// If he gets well away (LOSE_RANGE) and stays away a while, it wanders
// back to its post. Kill the Ooomba and its cannon falls silent.
//
// The missiles: blinking red, trailing smoke, turning (at most
// MISSILE_TURN a frame) to keep chasing him — fast, but not so nimble he
// can't dodge one. They blow up on him (killing him), on any planetoid
// or asteroid they run into, on a fireball (he can shoot them down), or
// after MISSILE_SECONDS on their own.
//
// Made by MissileOutpost.createAll (main.js), updated and drawn by
// MissileOutpost.updateAll / drawCannons / drawMissiles.

import love from '../love/index.js';
import lua from '../love/lua.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import Planetoid from './Planetoid.js';
import Ooomba from '../entities/Ooomba.js';
import Explosion from '../entities/Explosion.js';
import utils from '../utils.js';
import CameraShake from '../effects/CameraShake.js';

// ---------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------

// Where they are: just past the belt's outer edge (OUTPOST_GAP beyond it,
// from the edge to the planet's surface), at these angles round the sun
// (degrees; 0 = straight right, increasing clockwise) — kept clear of the
// tall pinball planet, which stands just past the belt straight left of it.
const OUTPOST_ANGLES = [70, 140, 285];
const OUTPOST_GAP = 500;
const PLANET_RADIUS = 230;
const PLANET_COLOR = [0.62, 0.42, 0.4, 1]; // a rusty, unfriendly red-grey
// How far round the planet the Ooomba's post is from the cannon (radians).
const POST_OFFSET = 1.7;
// Where it stands to man the cannon: just behind it (radians round).
const MANNING_OFFSET = 0.3;

const TRIGGER_RANGE = 1800;  // he's this near the planet's middle: the Ooomba heads for the cannon
const LOSE_RANGE = 2700;     // he's this far: it gives up after LOSE_SECONDS...
const LOSE_SECONDS = 4;      // ...and wanders back to its post
const BRISK_SPEED = 3.4;     // the Ooomba's walk to the cannon (an ordinary one patrols at 1.4)
const STROLL_SPEED = 1.2;    // its walk back to its post
const FIRE_SECONDS = 3.2;    // between missiles, while it's manning the cannon
const FIRST_SHOT_SECONDS = 0.8; // from reaching the cannon to its first shot
const MAX_MISSILES = 2;      // in the air at once, per cannon

const MISSILE_SPEED = 7.5;   // world units per (60fps) frame
const MISSILE_LAUNCH_SPEED = 4; // leaving the barrel, before it gets going
const MISSILE_ACCEL = 0.25;  // per frame, up to MISSILE_SPEED
const MISSILE_TURN = 0.045;  // radians per frame it can turn toward him
const MISSILE_SECONDS = 7;   // how long one lasts before it blows up anyway
const MISSILE_SCALE = 3.6;   // how big they're drawn
const MISSILE_RADIUS = 34;   // what counts as it touching something
const MISSILE_ARMING_SECONDS = 0.35; // it can't hit its own planet this soon after launch
const MISSILE_RECALL_AIM_RADIUS = 46; // how near the cursor has to be to aim Recall at one
const RECALL_TURN_RATE = 0.25; // while recalled: how fast it turns to face the way it's being taken

// A recalled missile reaching the cannon that fired it: how near counts,
// the cannon's blast, and the Ooomba caught in it if it's within
// GUNNER_BLAST_REACH of the cannon.
const CANNON_HIT_REACH = 90;
const CANNON_BLAST_SHAKE = 26;
const GUNNER_BLAST_REACH = 170;

const BARREL_LENGTH = 54;
const BARREL_WIDTH = 16;
const BASE_RADIUS = 30;
const AIM_RATE = 0.08; // how fast the barrel swings round to follow him (fraction per frame)

function angleDiff(a, b) {
  return lua.mod(b - a + Math.PI, 2 * Math.PI) - Math.PI;
}

function explode(m) {
  m.dead = true;
  state.explosions = state.explosions ?? [];
  state.explosions.push(Explosion.new(m.pos.x, m.pos.y));
  if (state.audioManager) state.audioManager.playBang('medium', new Vector2(m.pos.x, m.pos.y));
}

class MissileOutpost {
  // Every outpost, just outside the belt. Each one's planet goes into
  // state.planetoids and its Ooomba into state.ooombas. Any that would
  // sit too near a landmark (any permanent planetoid) is skipped.
  static createAll(sunX, sunY, beltInner, beltOuter) {
    const outposts = [];
    state.ooombas = state.ooombas ?? [];
    state.missiles = [];
    const orbit = beltOuter + OUTPOST_GAP + PLANET_RADIUS;
    for (const deg of OUTPOST_ANGLES) {
      const a = deg * Math.PI / 180;
      const x = sunX + Math.cos(a) * orbit, y = sunY + Math.sin(a) * orbit;
      let clear = true;
      for (const p of state.planetoids ?? []) {
        if (p.isPermanent && p.pos) {
          // (How far from its outline: its circle, or — for anything
          // flat, like the tall pinball planet — its box.)
          let gap;
          if (p.halfWidth) {
            const ox = Math.max(0, Math.abs(x - p.pos.x) - p.halfWidth);
            const oy = Math.max(0, Math.abs(y - p.pos.y) - (p.halfHeight ?? p.halfWidth));
            gap = Math.sqrt(ox * ox + oy * oy);
          } else {
            gap = Math.sqrt((p.pos.x - x) ** 2 + (p.pos.y - y) ** 2) - (p.radius ?? 0);
          }
          if (gap < PLANET_RADIUS + 600) clear = false;
        }
      }
      if (clear) {
        outposts.push(MissileOutpost.new(x, y, sunX, sunY));
      } else {
        console.log(lua.format('MissileOutpost.js: no room for the outpost at %d degrees round the belt — skipped.', deg));
      }
    }
    return outposts;
  }

  static new(x, y, sunX, sunY) {
    return new MissileOutpost(x, y, sunX, sunY);
  }

  constructor(x, y, sunX, sunY) {
    const planet = Planetoid.new(x, y, PLANET_RADIUS, PLANET_COLOR);
    planet.isImmovable = true;
    planet.isPermanent = true;
    planet.vel = new Vector2(0, 0);
    state.planetoids.push(planet);
    this.planet = planet;

    // The cannon sits on the side facing out of the belt, away from the
    // sun; the Ooomba's post is a good way round from there.
    this.cannonAngle = Math.atan2(y - sunY, x - sunX);
    this.postAngle = this.cannonAngle + POST_OFFSET;
    this.manningAngle = this.cannonAngle + MANNING_OFFSET;
    this.aim = this.cannonAngle; // where the barrel's pointing right now
    this.flash = 0;              // the muzzle flash, fading

    this.addGunner();

    this.mode = 'idle'; // idle (at its post), toCannon, manning, returning
    this.fireTimer = 0;
    this.awayTimer = 0;
  }

  addGunner() {
    const gunner = Ooomba.newOnPlanet(this.planet, this.postAngle, { direction: -1 });
    gunner.speed = 0;
    gunner.brain = (o) => this.think(o);
    state.ooombas = state.ooombas ?? [];
    state.ooombas.push(gunner);
    this.gunner = gunner;
  }

  // ----------------------------------------------------------------
  // The Ooomba's brain
  // ----------------------------------------------------------------

  // Where the Ooomba is round its planet (radians).
  gunnerAngle(o) {
    return o.surfaceArcPos / this.planet.radius;
  }

  // Walks it toward `targetAngle` at `speed`; returns true once it's there.
  walkTo(o, targetAngle, speed) {
    const d = angleDiff(this.gunnerAngle(o), targetAngle);
    const step = speed * (state.timeScale ?? 1) / this.planet.radius;
    if (Math.abs(d) <= step) {
      o.surfaceArcPos = lua.mod(targetAngle, 2 * Math.PI) * this.planet.radius;
      o.speed = 0;
      return true;
    }
    o.direction = d > 0 ? 1 : -1;
    o.speed = speed;
    o.walkCycleSpeed = 0.12 * speed / 1.4;
    return false;
  }

  // Called by the Ooomba itself each frame (see Ooomba.update's brain):
  // sets where it's walking and how fast.
  think(o) {
    if (this.mode === 'idle' || this.mode === 'manning') {
      o.speed = 0;
      o.walkCycleSpeed = 0;
      o.walkCyclePhase = 0;
      // (Facing him, standing there.)
      const player = state.player;
      if (player) {
        const px = player.pos.x - o.pos.x, py = player.pos.y - o.pos.y;
        const side = px * -o.up.y + py * o.up.x;
        o.direction = side > 0 ? 1 : -1;
      }
    } else if (this.mode === 'toCannon') {
      if (this.walkTo(o, this.manningAngle, BRISK_SPEED)) {
        this.mode = 'manning';
        this.fireTimer = FIRST_SHOT_SECONDS;
      }
    } else if (this.mode === 'returning') {
      if (this.walkTo(o, this.postAngle, STROLL_SPEED)) this.mode = 'idle';
    }
  }

  // ----------------------------------------------------------------
  // Updating
  // ----------------------------------------------------------------

  // The barrel's tip, where missiles leave from, and its base.
  // Returns [mx, my, bx, by].
  muzzle() {
    const p = this.planet;
    const bx = p.pos.x + Math.cos(this.cannonAngle) * (p.radius + BASE_RADIUS * 0.6);
    const by = p.pos.y + Math.sin(this.cannonAngle) * (p.radius + BASE_RADIUS * 0.6);
    return [bx + Math.cos(this.aim) * BARREL_LENGTH, by + Math.sin(this.aim) * BARREL_LENGTH, bx, by];
  }

  fire() {
    const [mx, my] = this.muzzle();
    state.missiles.push({
      owner: this,
      pos: new Vector2(mx, my),
      heading: this.aim,
      speed: MISSILE_LAUNCH_SPEED,
      age: 0,
      trail: [],
      // (For Recall, which records and rewinds anything with a position,
      // velocity and radius — see js/systems/Recall.js. The radius is
      // also how near the cursor has to be to aim Recall at it.)
      vel: new Vector2(Math.cos(this.aim) * MISSILE_LAUNCH_SPEED, Math.sin(this.aim) * MISSILE_LAUNCH_SPEED),
      radius: MISSILE_RECALL_AIM_RADIUS,
    });
    this.flash = 1;
    if (state.audioManager) state.audioManager.playBang('small', new Vector2(mx, my));
  }

  // Its own missile, recalled back into it: the cannon goes up in a big
  // blast — several explosions round it, the screen shaking — and is a
  // wreck from then on. Its Ooomba goes with it, if it's within
  // GUNNER_BLAST_REACH.
  destroyCannon() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.flash = 0;
    this.smokeTimer = 0;
    const [, , bx, by] = this.muzzle();
    state.explosions = state.explosions ?? [];
    state.explosions.push(Explosion.new(bx, by));
    for (let k = 1; k <= 4; k++) {
      const a = Math.random() * Math.PI * 2;
      const r = 25 + Math.random() * 45;
      state.explosions.push(Explosion.new(bx + Math.cos(a) * r, by + Math.sin(a) * r));
    }
    CameraShake.start(CANNON_BLAST_SHAKE, 0.45);
    if (state.audioManager) state.audioManager.playBang('large', new Vector2(bx, by));

    const g = this.gunner;
    if (g && (g.pos.x - bx) ** 2 + (g.pos.y - by) ** 2 < GUNNER_BLAST_REACH * GUNNER_BLAST_REACH) {
      const list = state.ooombas ?? [];
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i] === g) list.splice(i, 1);
      }
      state.explosions.push(Explosion.new(g.pos.x, g.pos.y));
      this.gunner = null;
    }
  }

  update(player, dt) {
    // Its Ooomba's gone (stomped or shot): the cannon's silent.
    if (this.gunner && !(state.ooombas ?? []).includes(this.gunner)) this.gunner = null;
    this.flash = Math.max(0, this.flash - dt * 5);

    // Blown up: nothing more to do but smoke.
    if (this.destroyed) {
      this.smokeTimer = (this.smokeTimer ?? 0) + dt;
      this.mode = 'idle';
      return;
    }

    let dist = Infinity;
    if (player && !player.isDying) {
      dist = Math.sqrt((player.pos.x - this.planet.pos.x) ** 2 + (player.pos.y - this.planet.pos.y) ** 2);
    }

    // The barrel follows him while it's manned; otherwise eases back to
    // pointing straight out.
    let wantAim = this.cannonAngle;
    if (this.gunner && this.mode === 'manning' && dist < LOSE_RANGE) {
      const [, , bx, by] = this.muzzle();
      wantAim = Math.atan2(player.pos.y - by, player.pos.x - bx);
      // (Never down into its own planet.)
      const off = angleDiff(this.cannonAngle, wantAim);
      wantAim = this.cannonAngle + Math.max(-1.35, Math.min(1.35, off));
    }
    this.aim += angleDiff(this.aim, wantAim) * Math.min(1, AIM_RATE * (state.timeScale ?? 1));

    if (!this.gunner) return;

    if (this.mode === 'idle' || this.mode === 'returning') {
      if (dist < TRIGGER_RANGE) this.mode = 'toCannon';
    } else if (this.mode === 'manning' || this.mode === 'toCannon') {
      if (dist > LOSE_RANGE) {
        this.awayTimer += dt;
        if (this.awayTimer > LOSE_SECONDS) {
          this.mode = 'returning';
          this.awayTimer = 0;
        }
      } else {
        this.awayTimer = 0;
      }
    }

    if (this.mode === 'manning' && dist < LOSE_RANGE) {
      this.fireTimer -= dt;
      let live = 0;
      for (const m of state.missiles) if (m.owner === this && !m.dead) live++;
      if (this.fireTimer <= 0 && live < MAX_MISSILES) {
        this.fire();
        this.fireTimer = FIRE_SECONDS;
      }
    }
  }

  // While the title screen's playing: any outpost that's lost its Ooomba
  // gets a fresh one back at its post, so they're all manned when the
  // game starts.
  static restock(outposts) {
    for (const self of outposts ?? []) {
      if (!(state.ooombas ?? []).includes(self.gunner)) {
        self.addGunner();
        self.mode = 'idle';
      }
    }
  }

  // Every outpost and missile, once a frame.
  static updateAll(outposts, player) {
    const ts = state.timeScale ?? 1;
    const dt = ts / 60;
    for (const o of outposts ?? []) o.update(player, dt);
    const missiles = state.missiles ?? [];
    for (let i = missiles.length - 1; i >= 0; i--) {
      const m = missiles[i];
      if (!m.dead) updateMissile(m, player, ts, dt);
      if (m.dead) missiles.splice(i, 1);
    }
  }

  // ----------------------------------------------------------------
  // Drawing
  // ----------------------------------------------------------------

  // The cannons: a squat dark turret on the surface, a red band round
  // it, and its barrel — turning to follow him while it's manned.
  static drawCannons(outposts) {
    for (const self of outposts ?? []) {
      const p = self.planet;
      if (self.destroyed && utils.isOnScreen(p.pos.x, p.pos.y, p.radius + 300, 50)) {
        MissileOutpost.drawWreck(self);
      } else if (utils.isOnScreen(p.pos.x, p.pos.y, p.radius + 120, 50)) {
        const [mx, my, bx, by] = self.muzzle();
        const ca = Math.cos(self.cannonAngle), sa = Math.sin(self.cannonAngle);
        const sx = p.pos.x + ca * p.radius, sy = p.pos.y + sa * p.radius;
        love.graphics.push('all');
        // The barrel.
        love.graphics.setColor(0.08, 0.08, 0.1, 1);
        love.graphics.setLineWidth(BARREL_WIDTH + 5);
        love.graphics.line(bx, by, mx, my);
        love.graphics.setColor(0.42, 0.44, 0.5, 1);
        love.graphics.setLineWidth(BARREL_WIDTH);
        love.graphics.line(bx, by, mx, my);
        love.graphics.setColor(0.62, 0.64, 0.7, 1);
        love.graphics.setLineWidth(4);
        const nx = -Math.sin(self.aim) * 3, ny = Math.cos(self.aim) * 3;
        love.graphics.line(bx - nx, by - ny, mx - nx, my - ny);
        // (Its mouth, and the flash when it fires.)
        love.graphics.setColor(0.05, 0.05, 0.06, 1);
        love.graphics.circle('fill', mx, my, BARREL_WIDTH * 0.45);
        if (self.flash > 0) {
          love.graphics.setBlendMode('add');
          love.graphics.setColor(1, 0.6, 0.25, self.flash);
          love.graphics.circle('fill', mx, my, 18 + 22 * self.flash);
          love.graphics.setBlendMode('alpha');
        }
        // The turret: a dome on the surface, with a red band.
        const rot = self.cannonAngle + Math.PI / 2;
        love.graphics.translate(sx, sy);
        love.graphics.rotate(rot);
        love.graphics.setColor(0.08, 0.08, 0.1, 1);
        love.graphics.arc('fill', 0, 4, BASE_RADIUS + 3, Math.PI, 2 * Math.PI, 24);
        love.graphics.setColor(0.36, 0.37, 0.42, 1);
        love.graphics.arc('fill', 0, 4, BASE_RADIUS, Math.PI, 2 * Math.PI, 24);
        love.graphics.setColor(0.75, 0.16, 0.14, 1);
        love.graphics.rectangle('fill', -BASE_RADIUS * 0.95, -8, BASE_RADIUS * 1.9, 6);
        love.graphics.setColor(0.6, 0.62, 0.68, 1);
        love.graphics.arc('fill', -6, -6, BASE_RADIUS * 0.45, Math.PI * 1.1, Math.PI * 1.6, 12);
        love.graphics.pop();
      }
    }
  }

  // A blown-up cannon: its turret charred black and split, a short
  // twisted stub of barrel left, an ember glowing in the wreck, and
  // smoke curling up off it for good.
  static drawWreck(self) {
    const p = self.planet;
    const ca = Math.cos(self.cannonAngle), sa = Math.sin(self.cannonAngle);
    const sx = p.pos.x + ca * p.radius, sy = p.pos.y + sa * p.radius;
    const t = self.smokeTimer ?? 0;
    love.graphics.push('all');
    // Smoke, rising straight out from the surface and spreading as it goes.
    for (let k = 0; k <= 9; k++) {
      const life = lua.mod(t * 0.35 + k / 10, 1);
      const rise = 20 + life * 220;
      const drift = Math.sin(k * 2.3 + t * 0.8) * 30 * life;
      const x = sx + ca * rise - sa * drift;
      const y = sy + sa * rise + ca * drift;
      love.graphics.setColor(0.22, 0.21, 0.22, 0.45 * (1 - life));
      love.graphics.circle('fill', x, y, 12 + 30 * life);
    }
    love.graphics.translate(sx, sy);
    love.graphics.rotate(self.cannonAngle + Math.PI / 2);
    // The charred, split turret.
    love.graphics.setColor(0.06, 0.06, 0.07, 1);
    love.graphics.arc('fill', 0, 4, BASE_RADIUS + 3, Math.PI, 2 * Math.PI, 24);
    love.graphics.setColor(0.17, 0.16, 0.16, 1);
    love.graphics.arc('fill', 0, 4, BASE_RADIUS, Math.PI, 2 * Math.PI, 24);
    love.graphics.setColor(0.06, 0.06, 0.07, 1);
    love.graphics.polygon('fill', -4, 4, 6, -BASE_RADIUS + 4, 10, -BASE_RADIUS + 2, 2, 4);
    // What's left of the barrel: a short stub, bent off to one side.
    love.graphics.setLineWidth(BARREL_WIDTH * 0.8);
    love.graphics.setColor(0.12, 0.12, 0.13, 1);
    love.graphics.line(-6, -BASE_RADIUS * 0.5, -16, -BASE_RADIUS - 14, -30, -BASE_RADIUS - 20);
    // An ember still glowing in it.
    const glow = 0.55 + 0.45 * Math.sin(t * 7) * Math.sin(t * 2.3);
    love.graphics.setBlendMode('add');
    love.graphics.setColor(1, 0.4, 0.1, 0.35 * glow);
    love.graphics.circle('fill', 4, -8, 16);
    love.graphics.setColor(1, 0.65, 0.2, 0.8 * glow);
    love.graphics.circle('fill', 4, -8, 4);
    love.graphics.pop();
  }

  // The missiles: a smoke trail, a dark body with fins, and a red light
  // on its nose blinking — faster the longer it's been flying, and faster
  // still once it's close to him.
  static drawMissiles() {
    const player = state.player;
    for (const m of state.missiles ?? []) {
      if (utils.isOnScreen(m.pos.x, m.pos.y, 200, 50)) {
        love.graphics.push('all');
        // Smoke.
        for (let i = m.trail.length - 1; i >= 0; i--) {
          const t = m.trail[i];
          const k = t.age / 0.6;
          love.graphics.setColor(0.7, 0.7, 0.72, 0.35 * (1 - k));
          love.graphics.circle('fill', t.x, t.y, (4 + 10 * k) * MISSILE_SCALE);
        }
        // Its exhaust flame.
        love.graphics.translate(m.pos.x, m.pos.y);
        love.graphics.rotate(m.heading);
        love.graphics.scale(MISSILE_SCALE);
        love.graphics.setBlendMode('add');
        // (No flame while it's being recalled — it's not flying itself.)
        const flick = m.recalling ? 0 : (0.8 + 0.4 * Math.random());
        love.graphics.setColor(1, 0.55, 0.15, 0.85);
        love.graphics.polygon('fill', -14, -5, -14, 5, -14 - 16 * flick, 0);
        love.graphics.setColor(1, 0.9, 0.5, 0.9);
        love.graphics.polygon('fill', -14, -2.5, -14, 2.5, -14 - 8 * flick, 0);
        love.graphics.setBlendMode('alpha');
        // Its body and fins.
        love.graphics.setColor(0.08, 0.08, 0.1, 1);
        love.graphics.polygon('fill', -16, -10, -8, -6, -8, 6, -16, 10);
        love.graphics.rectangle('fill', -15, -6.5, 26, 13, 5, 5);
        love.graphics.setColor(0.55, 0.57, 0.62, 1);
        love.graphics.rectangle('fill', -13, -4.5, 22, 9, 4, 4);
        love.graphics.setColor(0.75, 0.16, 0.14, 1);
        love.graphics.rectangle('fill', -6, -4.5, 4, 9);
        love.graphics.setColor(0.75, 0.77, 0.82, 1);
        love.graphics.rectangle('fill', -12, -3.5, 18, 2.5, 1, 1);
        // The blinking light.
        let rate = 3 + 6 * (m.age / MISSILE_SECONDS);
        if (player) {
          const d = Math.sqrt((player.pos.x - m.pos.x) ** 2 + (player.pos.y - m.pos.y) ** 2);
          if (d < 500) rate += 8 * (1 - d / 500);
        }
        m.blinkPhase = (m.blinkPhase ?? 0) + rate * love.timer.getDelta();
        const on = lua.mod(m.blinkPhase, 1) < 0.5;
        if (on) {
          love.graphics.setBlendMode('add');
          love.graphics.setColor(1, 0.15, 0.1, 0.35);
          love.graphics.circle('fill', 11, 0, 16);
          love.graphics.setColor(1, 0.2, 0.15, 0.6);
          love.graphics.circle('fill', 11, 0, 8);
          love.graphics.setBlendMode('alpha');
          love.graphics.setColor(1, 0.55, 0.5, 1);
        } else {
          love.graphics.setColor(0.35, 0.05, 0.05, 1);
        }
        love.graphics.circle('fill', 11, 0, 4);
        love.graphics.pop();
      }
    }
  }
}

function updateMissile(m, player, ts, dt) {
  // Recalled (see js/systems/Recall.js): Recall's moving it back along
  // the way it came (nose first) — nothing of its own (no homing, no
  // running out, no hurting him) until that's over. Reaching the cannon
  // that fired it, it blows the cannon up.
  const owner = m.owner;
  const atItsCannon = () => {
    if (owner.destroyed) return false;
    const [, , bx, by] = owner.muzzle();
    return (m.pos.x - bx) ** 2 + (m.pos.y - by) ** 2 < CANNON_HIT_REACH * CANNON_HIT_REACH;
  };
  const ageTrail = () => {
    for (let i = m.trail.length - 1; i >= 0; i--) {
      m.trail[i].age += dt;
      if (m.trail[i].age > 0.6) m.trail.splice(i, 1);
    }
  };
  if (m.recalling) {
    m.wasRecalled = true;
    // (Nose first the way it's being taken — back toward the cannon —
    // turning smoothly round to face wherever Recall's moving it.)
    if (m.recallLastX != null) {
      const dx = m.pos.x - m.recallLastX, dy = m.pos.y - m.recallLastY;
      if (dx * dx + dy * dy > 0.01) {
        const want = Math.atan2(dy, dx);
        m.heading += angleDiff(m.heading, want) * Math.min(1, RECALL_TURN_RATE * ts);
      }
    }
    m.recallLastX = m.pos.x;
    m.recallLastY = m.pos.y;
    // (Its old smoke still fades away.)
    ageTrail();
    if (atItsCannon()) {
      owner.destroyCannon();
      explode(m);
    }
    return;
  }
  if (m.wasRecalled) {
    // The rewind's over: all the way back (at the cannon), or stopped
    // partway — then it just carries on after him.
    m.wasRecalled = null;
    m.recallLastX = null;
    m.recallLastY = null;
    if (atItsCannon()) {
      owner.destroyCannon();
      explode(m);
      return;
    }
  }

  m.age += dt;
  if (m.age > MISSILE_SECONDS) { explode(m); return; }

  // Turning toward him (at most MISSILE_TURN), and speeding up.
  if (player && !player.isDying) {
    const want = Math.atan2(player.pos.y - m.pos.y, player.pos.x - m.pos.x);
    const d = angleDiff(m.heading, want);
    const turn = MISSILE_TURN * ts;
    m.heading += Math.max(-turn, Math.min(turn, d));
  }
  m.speed = Math.min(MISSILE_SPEED, m.speed + MISSILE_ACCEL * ts);
  m.pos.x += Math.cos(m.heading) * m.speed * ts;
  m.pos.y += Math.sin(m.heading) * m.speed * ts;
  m.vel.x = Math.cos(m.heading) * m.speed;
  m.vel.y = Math.sin(m.heading) * m.speed;

  // Smoke behind it.
  const back = 14 * MISSILE_SCALE;
  m.trail.unshift({ x: m.pos.x - Math.cos(m.heading) * back, y: m.pos.y - Math.sin(m.heading) * back, age: 0 });
  ageTrail();

  // Him.
  if (player && !player.isDying) {
    const r = MISSILE_RADIUS + player.radius;
    if ((player.pos.x - m.pos.x) ** 2 + (player.pos.y - m.pos.y) ** 2 < r * r) {
      player.startDeath();
      explode(m);
      return;
    }
  }
  // A fireball (shot down).
  const fireballs = state.fireballs ?? [];
  for (let i = fireballs.length - 1; i >= 0; i--) {
    const f = fireballs[i];
    const r = MISSILE_RADIUS + (f.radius ?? 8) + 4;
    if ((f.pos.x - m.pos.x) ** 2 + (f.pos.y - m.pos.y) ** 2 < r * r) {
      fireballs.splice(i, 1);
      explode(m);
      return;
    }
  }
  // Anything solid it runs into.
  for (const p of state.planetoids ?? []) {
    if (p.pos && !p.isWaterPlanet && !(p === m.owner.planet && m.age < MISSILE_ARMING_SECONDS)) {
      let hit = false;
      if (p.isRoundedRect && p.containsPoint) {
        hit = p.containsPoint(m.pos.x, m.pos.y);
      } else if (p.radius) {
        const r = p.radius + MISSILE_RADIUS;
        const dx = p.pos.x - m.pos.x, dy = p.pos.y - m.pos.y;
        hit = dx * dx + dy * dy < r * r;
      }
      if (hit) { explode(m); return; }
    }
  }
  for (const a of state.asteroids ?? []) {
    const r = (a.radius ?? 0) + MISSILE_RADIUS;
    if ((a.pos.x - m.pos.x) ** 2 + (a.pos.y - m.pos.y) ** 2 < r * r) { explode(m); return; }
  }
}

export default MissileOutpost;
