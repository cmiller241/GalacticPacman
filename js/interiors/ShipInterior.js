// js/interiors/ShipInterior.js
//
// The inside of Bob's spaceship (see js/levels/Spaceship.js): a round room
// with three flat floors stacked inside the hull. Unlike the maze and the
// pinball table he isn't a ball in here: he walks and jumps on his feet.
// The floors are one-way: he jumps up through the one above him, and Down
// drops him through the one he's on.
//
//   top floor      the console: the interact button takes the controls,
//                  and then the arrow keys or the left stick fly the ship
//                  (the interact button again lets go)
//   middle floor   the Bible, hovering in a beam of light over its
//                  pedestal (js/effects/BibleShrine.js), and mail crates
//   bottom floor   the beam pad: the beam there takes him back outside
//
// Everything here is in the ship's own frame: (0, 0) is its middle, x to
// the right, y down. The ship never turns, so a point in here is just the
// ship's position plus that offset; he moves with it as it flies.
//
// Port of lua/interiors/ShipInterior.lua.

import love from '../love/index.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import constants from '../constants.js';
import InteractPrompt from '../ui/InteractPrompt.js';
import BibleShrine from '../effects/BibleShrine.js';
import Conversation from '../ui/Conversation.js';

// ----------------------------------------------------------------------
// Tunables
// ----------------------------------------------------------------------

// The hull: its outside (what he walks round, outside) and the room
// inside it. World units.
const HULL_RADIUS = 445;
const INNER_RADIUS = 400;

// Each floor's top, top floor first (y in the ship's frame). Far enough
// apart for him to stand under the next one up, close enough for one jump
// to clear it (JUMP_SPEED and GRAVITY give about 200 units).
const FLOORS = [-90, 80, 250];
const TOP_FLOOR = 0, BOTTOM_FLOOR = FLOORS.length - 1;
const FLOOR_THICKNESS = 16;

const GRAVITY = 0.45;
const JUMP_SPEED = 13.5;
const MAX_FALL_SPEED = 16;

// The console (top floor), and where he stands to fly.
const CONSOLE_X = 230;
const CONSOLE_REACH = 110;       // how close (in x) he has to be to use it
const PILOT_STAND_X = CONSOLE_X - 90;
// The Bible's pedestal (middle floor).
const SHRINE_X = 30;
const BIBLE_REACH = 80;          // how close (in x) he has to be to look at it

// What happens when he looks at the Bible (see js/ui/Conversation.js).
const BIBLE_SCRIPT = [
  { text: 'Bob stands near the strange book, wondering if he should read it.' },
  { choice: 'Should he read it?', options: [
    { label: 'Read it', beats: [
      { text: '"But God shows His love for us in that while we were still sinners, Christ died for us." (Romans 5:8)' },
    ] },
    { label: "Don't read it" },
  ] },
];
// The beam pad (bottom floor): where the beam in puts him, and where the
// beam out stands.
const PAD_X = -170;

// Flying: speed added per tick at full stick, the top speed, and how much
// speed it keeps per tick with nothing held (a gentle coast to a stop).
const THRUST = 0.14;
const MAX_SPEED = 13;
const COAST = 0.985;
const STICK_DEADZONE = 0.2;

// What the camera frames: the whole ship plus a margin; flying, this many
// ship-widths, so there's space to see it moving through.
const CAMERA_MARGIN = 70;
const FLYING_VIEW = 2.4;

// Where leaving puts him: on the hull, a little round from the top (the
// outside beam is right on top).
const EXIT_ANGLE = -Math.PI / 2 + 0.3;

// Colors.
const COLOR_ROOM = [0.09, 0.08, 0.17, 1];
const COLOR_PANEL_LINE = [1, 1, 1, 0.035];
const COLOR_FLOOR = [0.42, 0.45, 0.56, 1];
const COLOR_FLOOR_EDGE = [0.78, 0.82, 0.92, 1];
const COLOR_FLOOR_SHADOW = [0, 0, 0, 0.35];
const COLOR_OUTLINE = [0.04, 0.04, 0.08, 1];
const COLOR_WINDOW = [0.05, 0.10, 0.22, 1];
const COLOR_WINDOW_RIM = [0.70, 0.74, 0.84, 1];
const COLOR_CONSOLE = [0.36, 0.39, 0.50, 1];
const COLOR_CONSOLE_TOP = [0.52, 0.56, 0.68, 1];
const COLOR_SCREEN = [0.25, 0.85, 0.45, 1];
const COLOR_CRATE = [0.79, 0.54, 0.29, 1];
const COLOR_TAPE = [0.93, 0.83, 0.55, 1];
const COLOR_PAD = [0.60, 0.64, 0.74, 1];
const LIGHT_COLORS = [[1, 0.35, 0.3], [1, 0.85, 0.3], [0.4, 0.8, 1]];

// Half the room's width at height y (in the ship's frame).
function halfWidthAt(y) {
  return Math.sqrt(Math.max(0, INNER_RADIUS * INNER_RADIUS - y * y));
}

// ----------------------------------------------------------------------
// Drawing helpers
// ----------------------------------------------------------------------

// A round window in the hull's wall at (x, y), looking out at the stars.
function drawWindow(x, y, radius, t) {
  const g = love.graphics;
  g.setColor(COLOR_OUTLINE);
  g.circle('fill', x, y, radius + 9);
  g.setColor(COLOR_WINDOW_RIM);
  g.circle('fill', x, y, radius + 6);
  g.setColor(COLOR_WINDOW);
  g.circle('fill', x, y, radius);
  // A few stars, twinkling.
  for (let k = 1; k <= 7; k++) {
    const a = k * 2.4, d = radius * (0.2 + 0.7 * ((k * 0.37) % 1));
    const twinkle = 0.5 + 0.5 * Math.sin(t * 2 + k);
    g.setColor(1, 1, 1, 0.4 + 0.5 * twinkle);
    g.circle('fill', x + Math.cos(a) * d, y + Math.sin(a) * d, 1.5 + (k % 2));
  }
  g.setColor(1, 1, 1, 0.25);
  g.setLineWidth(4);
  g.arc('line', 'open', x, y, radius * 0.72, Math.PI * 1.1, Math.PI * 1.45);
}

// One floor, its top at y (the ship's frame), across the whole room.
function drawFloor(cx, cy, y) {
  const g = love.graphics;
  const top = halfWidthAt(y), bottom = halfWidthAt(y + FLOOR_THICKNESS);
  const shadowBottom = halfWidthAt(y + FLOOR_THICKNESS + 10);
  g.setColor(COLOR_FLOOR_SHADOW);
  g.polygon('fill',
    cx - bottom, cy + y + FLOOR_THICKNESS, cx + bottom, cy + y + FLOOR_THICKNESS,
    cx + shadowBottom, cy + y + FLOOR_THICKNESS + 10, cx - shadowBottom, cy + y + FLOOR_THICKNESS + 10);
  g.setColor(COLOR_FLOOR);
  g.polygon('fill',
    cx - top, cy + y, cx + top, cy + y,
    cx + bottom, cy + y + FLOOR_THICKNESS, cx - bottom, cy + y + FLOOR_THICKNESS);
  g.setColor(COLOR_FLOOR_EDGE);
  g.setLineWidth(3);
  g.line(cx - top, cy + y + 1, cx + top, cy + y + 1);
  // Rivets along its side.
  g.setColor(0.30, 0.32, 0.42, 1);
  const step = 60;
  for (let x = -Math.floor(bottom / step) * step + step / 2; x <= bottom - step / 2; x += step) {
    g.circle('fill', cx + x, cy + y + FLOOR_THICKNESS * 0.6, 2.5);
  }
}

// A mail crate standing on the floor at (x, floorY), w wide, h tall.
function drawCrate(x, floorY, w, h) {
  const g = love.graphics;
  g.setColor(COLOR_OUTLINE);
  g.rectangle('fill', x - w / 2 - 3, floorY - h - 3, w + 6, h + 3, 4, 4);
  g.setColor(COLOR_CRATE);
  g.rectangle('fill', x - w / 2, floorY - h, w, h, 3, 3);
  g.setColor(COLOR_TAPE);
  g.rectangle('fill', x - 5, floorY - h, 10, h);
  g.setColor(0, 0, 0, 0.15);
  g.rectangle('fill', x - w / 2, floorY - 8, w, 8);
}

// The beam pad on the bottom floor (the beam itself is drawn as one of
// state.beams).
function drawPad(cx, cy) {
  const g = love.graphics;
  const x = cx + PAD_X, y = cy + FLOORS[BOTTOM_FLOOR];
  g.setColor(COLOR_OUTLINE);
  g.ellipse('fill', x, y - 2, 62, 14);
  g.setColor(COLOR_PAD);
  g.ellipse('fill', x, y - 4, 56, 10);
  g.setColor(1, 0.85, 0.4, 0.6);
  g.ellipse('fill', x, y - 5, 30, 5);
}

class ShipInterior {
  static new(ship) {
    return new ShipInterior(ship);
  }

  constructor(ship) {
    this.ship = ship;
    this.lx = PAD_X;
    this.ly = FLOORS[BOTTOM_FLOOR];
    this.vx = 0;
    this.vy = 0;
    this.floor = BOTTOM_FLOOR;
    this.dropThrough = null;
    this.downWasHeld = false;
    this.piloting = false;
    // The Bible's conversation, and whether it's showing (what
    // WorldObjects.anyDialogueActive checks, to freeze him while it is).
    this.bible = new Conversation(BIBLE_SCRIPT);
    this.dialogueActive = false;
    // Set by Spaceship.js: the beam out (it's one of state.beams, shown only
    // while he's in here).
    this.beam = null;
  }

  // Whether he's in here right now.
  hasPlayer() {
    const player = state.player;
    return !!player && player.inInterior === this;
  }

  // A point in the ship's frame, in world space.
  toWorld(lx, ly) {
    return [this.ship.pos.x + lx, this.ship.pos.y + ly];
  }

  // Where the beam out stands, in world space: on the bottom floor, at the pad.
  padPosition() {
    const [x, y] = this.toWorld(PAD_X, FLOORS[BOTTOM_FLOOR]);
    return Vector2.new(x, y);
  }

  // Where the beam in (and a respawn into the ship) puts him.
  getPortalPosition() {
    return this.padPosition();
  }

  // Where leaving puts him: on the hull at EXIT_ANGLE, in world space.
  exitPosition() {
    const s = this.ship;
    return Vector2.new(s.pos.x + Math.cos(EXIT_ANGLE) * s.radius, s.pos.y + Math.sin(EXIT_ANGLE) * s.radius);
  }

  // ----------------------------------------------------------------
  // Going in and out
  // ----------------------------------------------------------------

  // The beam in has put him here (or he's respawned here): standing on the
  // bottom floor, at the pad.
  onEnter(player) {
    if (player.isBall) player.forceStandMode();
    player.inInterior = this;
    // (On a floor, upright: no planet under him, so he's drawn the right
    // way up.)
    player.onSurface = true;
    player.currentPlanet = null;
    player.lastInfluencePlanet = null;
    player.isGroundPounding = false;
    player.vel.x = 0; player.vel.y = 0;
    this.lx = PAD_X;
    this.ly = FLOORS[BOTTOM_FLOOR] - player.radius;
    this.vx = 0; this.vy = 0;
    this.floor = BOTTOM_FLOOR;
    this.dropThrough = null;
    this.downWasHeld = true; // (a Down held coming in doesn't drop him straight through)
    this.piloting = false;
    this.bible.stop();
    this.dialogueActive = false;
    this.placePlayer(player);
  }

  // The beam out has put him outside: on the hull, a little round from the
  // top, falling onto it the ordinary way.
  arriveOutside(player) {
    player.inInterior = null;
    this.piloting = false;
    this.ship.thrustX = 0; this.ship.thrustY = 0;
    const s = this.ship;
    const dist = s.radius + player.radius + 2;
    player.pos.x = s.pos.x + Math.cos(EXIT_ANGLE) * dist;
    player.pos.y = s.pos.y + Math.sin(EXIT_ANGLE) * dist;
    player.prevPos = player.pos.clone();
    player.onSurface = false;
    player.currentPlanet = null;
    player.lastInfluencePlanet = s;
    // (Moving with the ship, so he isn't left behind if it's still coasting.)
    player.vel.x = s.vel.x; player.vel.y = s.vel.y;
    player.isWalking = false;
  }

  // Puts him (in world space) where he is in the ship's frame.
  placePlayer(player) {
    const [x, y] = this.toWorld(this.lx, this.ly);
    player.pos.x = x; player.pos.y = y;
    player.prevPos = player.pos.clone();
  }

  // Whether he's standing close enough to the console to use it.
  atConsole() {
    return this.floor === TOP_FLOOR && Math.abs(this.lx - CONSOLE_X) <= CONSOLE_REACH;
  }

  // Whether he's standing close enough to the Bible to look at it.
  atBible() {
    return this.floor === 1 && Math.abs(this.lx - SHRINE_X) <= BIBLE_REACH;
  }

  // The interact button (see WorldObjects.interact): lets go of the
  // controls if he's flying, takes them if he's at the console, or uses the
  // beam out if he's at it.
  tryInteract(player) {
    if (player.isTeleporting) return;
    // (Talking: on through the Bible's conversation.)
    if (this.bible.isActive()) {
      this.bible.press();
      this.dialogueActive = this.bible.isActive();
      return;
    }
    if (this.piloting) {
      this.piloting = false;
      this.ship.thrustX = 0; this.ship.thrustY = 0;
      return;
    }
    if (this.atConsole()) {
      this.piloting = true;
      this.lx = PILOT_STAND_X;
      this.vx = 0;
      player.facingDirection = 1;
      player.isWalking = false;
      return;
    }
    if (this.atBible()) {
      this.bible.start();
      this.dialogueActive = true;
      this.vx = 0;
      player.isWalking = false;
      player.facingDirection = this.lx < SHRINE_X ? 1 : -1;
      return;
    }
    const beam = this.beam;
    if (beam && beam.isShown() && beam.isPlayerNear(player)) beam.tryInteract(player);
  }

  // The jump button: a jump, standing on a floor (not while flying).
  triggerJumpAction(player) {
    if (this.piloting || this.dialogueActive || player.isTeleporting || this.floor === null) return;
    this.vy = -JUMP_SPEED;
    this.floor = null;
    if (state.audioManager) state.audioManager.playJump();
  }

  // What the camera shows while he's in here (see Camera.js): the ship,
  // whole, or (flying) a wider view round it. Returns the middle to look at
  // and the zoom.
  cameraView(screenW, screenH) {
    const size = this.piloting ? 2 * HULL_RADIUS * FLYING_VIEW : 2 * (HULL_RADIUS + CAMERA_MARGIN);
    return [this.ship.pos.x, this.ship.pos.y, Math.min(screenW, screenH) / size];
  }

  // ----------------------------------------------------------------
  // Walking, jumping, flying
  // ----------------------------------------------------------------

  // Called every frame he's in here, in place of gravity and collision.
  updateBall(player, ts) {
    // (Being beamed in or out: held still where he is, moving with the ship.)
    if (player.isTeleporting) {
      this.placePlayer(player);
      return;
    }
    if (this.piloting) {
      this.fly(ts);
      player.isWalking = false;
      player.onSurface = true;
      player.vel.x = 0; player.vel.y = 0;
      this.placePlayer(player);
      return;
    }
    this.ship.thrustX = 0; this.ship.thrustY = 0;

    // (Standing still while the Bible's talking. A Down held through it
    // doesn't drop him through the floor afterward.)
    if (this.dialogueActive) {
      this.vx = 0;
      this.downWasHeld = true;
      player.isWalking = false;
      player.vel.x = 0; player.vel.y = 0;
      this.placePlayer(player);
      return;
    }

    const keys = state.keys;
    const r = player.radius;
    const dir = (keys.ArrowRight ? 1 : 0) - (keys.ArrowLeft ? 1 : 0);
    const speed = constants.PLAYER_LINEAR_SPEED * (state.gamepadRunHeld ? player.runSpeedMultiplier : 1);
    this.vx = dir * speed;
    if (dir !== 0) player.facingDirection = dir;

    // Down (pressed, not held from before): drops through the floor he's
    // on, unless it's the bottom one.
    const downHeld = !!keys.ArrowDown;
    if (downHeld && !this.downWasHeld && this.floor !== null && this.floor !== BOTTOM_FLOOR) {
      this.dropThrough = this.floor;
      this.floor = null;
      this.vy = 1;
    }
    this.downWasHeld = downHeld;

    if (this.floor !== null) {
      this.ly = FLOORS[this.floor] - r;
    } else {
      const prevFeet = this.ly + r;
      this.vy = Math.min(this.vy + GRAVITY * ts, MAX_FALL_SPEED);
      this.ly += this.vy * ts;
      const feet = this.ly + r;
      // Lands on the first floor his feet came down through (never the one
      // he's dropping through).
      if (this.vy > 0) {
        for (let i = 0; i < FLOORS.length; i++) {
          const fy = FLOORS[i];
          if (i !== this.dropThrough && prevFeet <= fy && feet >= fy) {
            this.ly = fy - r;
            this.floor = i;
            this.vy = 0;
            this.dropThrough = null;
            break;
          }
        }
      }
      // (Once he's clear below the floor he dropped through, it's solid again.)
      if (this.dropThrough !== null && prevFeet > FLOORS[this.dropThrough]) this.dropThrough = null;
      // His head against the top of the hull.
      const headTop = -INNER_RADIUS + 12;
      if (this.ly - player.headReach < headTop) {
        this.ly = headTop + player.headReach;
        this.vy = Math.max(this.vy, 0);
      }
    }

    // The hull's curved wall, at both his feet and his head.
    const half = Math.min(halfWidthAt(this.ly + r), halfWidthAt(this.ly - player.headReach)) - r * 0.7;
    this.lx = Math.max(-half, Math.min(half, this.lx + this.vx * ts));

    // What his drawing goes by (see Rendering.js): standing or in the air,
    // walking or not.
    const walking = this.floor !== null && dir !== 0;
    player.onSurface = this.floor !== null;
    player.isWalking = walking;
    if (walking) {
      player.walkTime += (Math.abs(this.vx * ts) / player.strideLength) * Math.PI * 2;
    }
    player.vel.x = this.vx; player.vel.y = this.vy;
    this.placePlayer(player);
  }

  // Flying: the arrow keys, or the left stick (how far it's pushed sets how
  // hard), push the ship that way; with nothing held it coasts to a stop.
  fly(ts) {
    const ship = this.ship;
    let ax = state.gamepadMoveX || 0, ay = state.gamepadMoveY || 0;
    if (ax * ax + ay * ay < STICK_DEADZONE * STICK_DEADZONE) {
      const keys = state.keys;
      ax = (keys.ArrowRight ? 1 : 0) - (keys.ArrowLeft ? 1 : 0);
      ay = (keys.ArrowDown ? 1 : 0) - (keys.ArrowUp ? 1 : 0);
    }
    const len = Math.sqrt(ax * ax + ay * ay);
    if (len > 1) { ax /= len; ay /= len; }
    ship.thrustX = ax; ship.thrustY = ay;

    if (ax !== 0 || ay !== 0) {
      ship.vel.x += ax * THRUST * ts;
      ship.vel.y += ay * THRUST * ts;
      const speed = Math.sqrt(ship.vel.x * ship.vel.x + ship.vel.y * ship.vel.y);
      if (speed > MAX_SPEED) {
        ship.vel.x = ship.vel.x / speed * MAX_SPEED;
        ship.vel.y = ship.vel.y / speed * MAX_SPEED;
      }
    } else {
      const keep = Math.pow(COAST, ts);
      ship.vel.x *= keep; ship.vel.y *= keep;
    }
  }

  // An arrow while the Bible's asking something (see
  // WorldObjects.moveChoice): moves the cursor.
  moveChoice(dir) {
    if (this.bible.isActive()) this.bible.move(dir);
  }

  // The Bible's textbox, with the HUD (see WorldObjects.drawDialogues).
  drawDialogue() {
    if (this.bible.isActive()) this.bible.draw();
  }

  // ----------------------------------------------------------------
  // Drawing (over the hull, while he's in here)
  // ----------------------------------------------------------------

  // The console at the cockpit end of the top floor: a desk with a screen
  // (a heading arrow while he's flying, a slow blink while it isn't).
  drawConsole(cx, cy, t) {
    const g = love.graphics;
    const x = cx + CONSOLE_X, floorY = cy + FLOORS[TOP_FLOOR];
    // The desk, leaning back toward the wall.
    const desk = [x - 60, floorY, x + 70, floorY, x + 70, floorY - 70, x - 40, floorY - 92];
    g.setColor(COLOR_OUTLINE);
    g.setLineWidth(8);
    g.polygon('line', desk);
    g.setColor(COLOR_CONSOLE);
    g.polygon('fill', desk);
    g.setColor(COLOR_CONSOLE_TOP);
    g.polygon('fill', x - 40, floorY - 92, x + 70, floorY - 70, x + 70, floorY - 60, x - 44, floorY - 80);

    // The screen.
    const sx = x - 18, sy = floorY - 150, sw = 74, sh = 50;
    g.setColor(COLOR_OUTLINE);
    g.rectangle('fill', sx - 5, sy - 5, sw + 10, sh + 10, 6, 6);
    g.setColor(0.04, 0.12, 0.07, 1);
    g.rectangle('fill', sx, sy, sw, sh, 4, 4);
    g.setColor(COLOR_OUTLINE);
    g.setLineWidth(6);
    g.line(x + 18, sy + sh + 5, x + 10, floorY - 88);
    const mx = sx + sw / 2, my = sy + sh / 2;
    g.setColor(COLOR_SCREEN);
    const ship = this.ship;
    if (this.piloting) {
      // The way it's being pushed (or a dot, coasting).
      const tx = ship.thrustX || 0, ty = ship.thrustY || 0;
      if (tx !== 0 || ty !== 0) {
        const a = Math.atan2(ty, tx);
        const c = Math.cos(a), s = Math.sin(a);
        g.setLineWidth(4);
        g.line(mx - c * 14, my - s * 14, mx + c * 14, my + s * 14);
        g.polygon('fill',
          mx + c * 20, my + s * 20,
          mx + c * 8 - s * 8, my + s * 8 + c * 8,
          mx + c * 8 + s * 8, my + s * 8 - c * 8);
      } else {
        g.circle('fill', mx, my, 5);
      }
    } else {
      const blink = (Math.sin(t * 3) + 1) / 2;
      g.setColor(COLOR_SCREEN[0], COLOR_SCREEN[1], COLOR_SCREEN[2], 0.35 + 0.5 * blink);
      g.rectangle('fill', sx + 10, sy + 12, sw - 20, 6, 2, 2);
      g.rectangle('fill', sx + 10, sy + 26, (sw - 20) * 0.6, 6, 2, 2);
    }
    // Little lights along the desk.
    for (let k = 0; k <= 2; k++) {
      const on = Math.floor(t * 2 + k) % 3 === 0;
      const c = LIGHT_COLORS[k];
      g.setColor(c[0], c[1], c[2], on ? 1 : 0.35);
      g.circle('fill', x - 20 + k * 26, floorY - 72 + k * 5, 5);
    }
  }

  draw() {
    if (!this.hasPlayer()) return;
    const g = love.graphics;
    const cx = this.ship.pos.x, cy = this.ship.pos.y;
    const t = love.timer.getTime();

    // The room.
    g.setColor(COLOR_ROOM);
    g.circle('fill', cx, cy, INNER_RADIUS);
    // Wall panels: faint lines across it.
    g.setColor(COLOR_PANEL_LINE);
    g.setLineWidth(2);
    for (let y = -INNER_RADIUS + 40; y <= INNER_RADIUS - 40; y += 40) {
      const half = halfWidthAt(y);
      g.line(cx - half, cy + y, cx + half, cy + y);
    }

    // Windows: one by the console, one on each side lower down.
    drawWindow(cx + 250, cy - 215, 42, t);
    drawWindow(cx - 290, cy - 10, 34, t);
    drawWindow(cx + 300, cy + 160, 30, t);

    for (const y of FLOORS) drawFloor(cx, cy, y);

    // Scenery: mail crates on the middle floor.
    const middleY = cy + FLOORS[1];
    drawCrate(cx - 250, middleY, 60, 46);
    drawCrate(cx - 186, middleY, 48, 34);
    drawCrate(cx - 222, middleY - 46, 44, 32);

    // The Bible, its beam reaching up to the floor above.
    BibleShrine.draw(cx + SHRINE_X, middleY, cy + FLOORS[TOP_FLOOR] + FLOOR_THICKNESS, t);

    this.drawConsole(cx, cy, t);
    drawPad(cx, cy);

    // The button prompts: at the console to take the controls, and over him
    // while flying to let go.
    const player = state.player;
    if (player.isTeleporting) return;
    if (this.piloting) {
      InteractPrompt.draw(player.pos.x, player.pos.y - player.headReach - 30, 'stop flying');
    } else if (this.atConsole()) {
      InteractPrompt.draw(cx + CONSOLE_X, cy + FLOORS[TOP_FLOOR] - 175, 'fly');
    } else if (this.atBible() && !this.dialogueActive) {
      InteractPrompt.draw(cx + SHRINE_X, cy + FLOORS[1] - 140, 'look');
    }
  }
}

ShipInterior.HULL_RADIUS = HULL_RADIUS;
ShipInterior.PAD_X = PAD_X;
ShipInterior.EXIT_ANGLE = EXIT_ANGLE;
// (The gamepad stick's up/down count too while he's in here: Down drops
// through a floor, and both fly the ship. See GamePadInput.js.)
ShipInterior.prototype.fourWayInput = true;

export default ShipInterior;
