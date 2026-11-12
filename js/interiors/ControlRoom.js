// js/interiors/ControlRoom.js
//
// The inside of a game planet (the Tetris planet, the Zuma planet — see
// js/levels/): a small room in the planet's middle, with the beam pad on
// the left and a control panel on the right. He walks and hops about on
// his feet, as in the spaceship.
//
// The interact button at the panel takes the controls and starts the
// planet's game; from then on Left and Right steer it and the jump
// button is the game's own action. The interact button again lets go,
// which ends the game; taking the controls again starts a new one.
//
// The game itself is handed in (see js/world/TetrisField.js and
// js/world/ZumaField.js). It provides:
//   game.start()                       he's taken the controls
//   game.update(dt, ts, playing, steer) every frame (steer: -1, 0 or 1)
//   game.onJump()                      the jump button, at the controls
//   game.stop()                        he's let go (or left) mid-game
//   game.finished                      set when the game's over on its own
//                                      (he's let go of the controls for it)
//   game.cameraReach()                 how far out to frame, at the controls
//   game.angle                         how far the planet's turned (the
//                                      panel's screen shows it)
//   game.draw()                        world space, under the room
//   game.drawHud(playing)              screen space, with the HUD
//
// The room stays upright while the planet turns round it. Everything
// here is in the planet's frame, unturned: (0, 0) is its middle, x to
// the right, y down.
//
// While he's in here this replaces his gravity and planet collision (see
// main.js's updatePlayer, which calls updateBall every frame), and the
// camera frames the room, or the whole game while he's at the controls
// (see cameraView and Camera.js).

import love from '../love/index.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import constants from '../constants.js';
import InteractPrompt from '../ui/InteractPrompt.js';

// --------------------------------------------------------------------
// Tunables
// --------------------------------------------------------------------

// The room: its sides, ceiling and floor.
const ROOM_HALF_WIDTH = 140;
const ROOM_TOP = -105;
const FLOOR_Y = 100;

const GRAVITY = 0.45;
const JUMP_SPEED = 9;
const MAX_FALL_SPEED = 16;

// The panel, and how close (in x) he has to be to use it.
const PANEL_X = 82;
const PANEL_REACH = 60;
// The beam pad: where the beam in puts him, and where the beam out stands.
const PAD_X = -82;
// Where leaving puts him: on the planet's surface, a little round from
// the top (clear of the beam in).
const EXIT_ANGLE = -Math.PI / 2 + 0.3;

// The camera: how much room it leaves round the planet inside, and
// round the game at the controls.
const CAMERA_MARGIN = 120;
const FIELD_MARGIN = 80;

const COLOR_ROOM = [0.10, 0.07, 0.16, 1];
const COLOR_RIM = [0.70, 0.62, 0.86, 1];
const COLOR_OUTLINE = [0.04, 0.04, 0.08, 1];
const COLOR_FLOOR = [0.42, 0.40, 0.56, 1];
const COLOR_FLOOR_EDGE = [0.80, 0.78, 0.92, 1];
const COLOR_PANEL = [0.36, 0.34, 0.50, 1];
const COLOR_PANEL_TOP = [0.54, 0.52, 0.70, 1];
const COLOR_PAD = [0.60, 0.58, 0.74, 1];

export default class ControlRoom {
  // planet: the round Planetoid it's inside. game: its game (see above).
  // accent: an [r, g, b] for the panel's screen and the pad's glow (the
  // planet's beam color, say).
  constructor(planet, game, accent = [0.95, 0.55, 0.85]) {
    this.planet = planet;
    this.game = game;
    this.accent = accent;
    this.lx = PAD_X;
    this.ly = FLOOR_Y;
    this.vx = 0;
    this.vy = 0;
    this.onFloor = true;
    this.controlling = false;
    // Set by the planet's builder: the beam out (one of state.beams, shown
    // only while he's in here).
    this.beam = null;
  }

  hasPlayer() {
    const player = state.player;
    return player != null && player.inInterior === this;
  }

  toWorld(lx, ly) {
    return [this.planet.pos.x + lx, this.planet.pos.y + ly];
  }

  // Where the beam out stands, in world space: on the floor, at the pad.
  padPosition() {
    const [x, y] = this.toWorld(PAD_X, FLOOR_Y);
    return Vector2.new(x, y);
  }

  getPortalPosition() {
    return this.padPosition();
  }

  // Where leaving puts him: on the surface at EXIT_ANGLE, in world space.
  exitPosition() {
    const p = this.planet;
    return Vector2.new(p.pos.x + Math.cos(EXIT_ANGLE) * p.radius, p.pos.y + Math.sin(EXIT_ANGLE) * p.radius);
  }

  // ------------------------------------------------------------------
  // Going in and out
  // ------------------------------------------------------------------

  // The beam in has put him here (or he's respawned here): on the floor,
  // at the pad.
  onEnter(player) {
    if (player.isBall) player.forceStandMode();
    player.inInterior = this;
    player.onSurface = true;
    player.currentPlanet = null;
    player.lastInfluencePlanet = null;
    player.isGroundPounding = false;
    player.vel.x = 0; player.vel.y = 0;
    this.lx = PAD_X;
    this.ly = FLOOR_Y - player.radius;
    this.vx = 0; this.vy = 0;
    this.onFloor = true;
    this.controlling = false;
    this.placePlayer(player);
  }

  // The beam out has put him outside: just above the surface, a little
  // round from the top, falling onto it the ordinary way.
  arriveOutside(player) {
    player.inInterior = null;
    this.controlling = false;
    const p = this.planet;
    const dist = p.radius + player.radius + 2;
    player.pos.x = p.pos.x + Math.cos(EXIT_ANGLE) * dist;
    player.pos.y = p.pos.y + Math.sin(EXIT_ANGLE) * dist;
    player.prevPos = player.pos.clone();
    player.onSurface = false;
    player.currentPlanet = null;
    player.lastInfluencePlanet = p;
    player.vel.x = 0; player.vel.y = 0;
    player.isWalking = false;
  }

  placePlayer(player) {
    const [x, y] = this.toWorld(this.lx, this.ly);
    player.pos.x = x; player.pos.y = y;
    player.prevPos = player.pos.clone();
  }

  atPanel() {
    return this.onFloor && Math.abs(this.lx - PANEL_X) <= PANEL_REACH;
  }

  // The interact button (see WorldObjects.interact): lets go of the
  // controls (ending the game), takes them at the panel (starting one), or
  // uses the beam out at the pad.
  tryInteract(player) {
    if (player.isTeleporting) return;
    if (this.controlling) {
      this.controlling = false;
      this.game.stop();
      return;
    }
    if (this.atPanel()) {
      this.controlling = true;
      this.vx = 0;
      player.facingDirection = 1;
      player.isWalking = false;
      this.game.start();
      return;
    }
    const beam = this.beam;
    if (beam && beam.isShown() && beam.isPlayerNear(player)) beam.tryInteract(player);
  }

  // The jump button: at the controls, the game's own action; otherwise a
  // hop, standing on the floor.
  triggerJumpAction(player) {
    if (this.controlling) {
      this.game.onJump();
      return;
    }
    if (player.isTeleporting || !this.onFloor) return;
    this.vy = -JUMP_SPEED;
    this.onFloor = false;
    if (state.audioManager) state.audioManager.playJumpSmall();
  }

  // What the camera shows: the planet, or (at the controls) the planet and
  // the whole game round it.
  cameraView(screenW, screenH) {
    const reach = this.controlling
      ? this.game.cameraReach() + FIELD_MARGIN
      : this.planet.radius + CAMERA_MARGIN;
    return [this.planet.pos.x, this.planet.pos.y, Math.min(screenW, screenH) / (2 * reach)];
  }

  // ------------------------------------------------------------------
  // Every frame
  // ------------------------------------------------------------------

  // (Called by the planet's own update, whether he's in here or not: the
  // game keeps running its animations, and plays while he's at the
  // controls.)
  updateGame() {
    // (Gone without letting go — teleported away, say: that ends the game too.)
    if (this.controlling && !this.hasPlayer()) {
      this.controlling = false;
      this.game.stop();
    }
    const ts = state.timeScale ?? 1;
    let steer = 0;
    if (this.controlling) {
      const keys = state.keys;
      steer = (keys.ArrowRight ? 1 : 0) - (keys.ArrowLeft ? 1 : 0);
    }
    this.game.update(ts / 60, ts, this.controlling, steer);
    // (Over on its own — the Zuma train reaching the planet, say: he lets go.)
    if (this.game.finished) {
      this.game.finished = false;
      this.controlling = false;
    }
  }

  // Called every frame he's in here, in place of gravity and collision.
  updateBall(player, ts) {
    if (player.isTeleporting || this.controlling) {
      this.vx = 0;
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

    if (!this.onFloor) {
      this.vy = Math.min(this.vy + GRAVITY * ts, MAX_FALL_SPEED);
      this.ly += this.vy * ts;
      if (this.ly + r >= FLOOR_Y) {
        this.ly = FLOOR_Y - r;
        this.vy = 0;
        this.onFloor = true;
      }
      // His head against the ceiling.
      const headTop = ROOM_TOP + 6;
      if (this.ly - player.headReach < headTop) {
        this.ly = headTop + player.headReach;
        this.vy = Math.max(this.vy, 0);
      }
    } else {
      this.ly = FLOOR_Y - r;
    }

    const half = ROOM_HALF_WIDTH - r * 0.7;
    this.lx = Math.max(-half, Math.min(half, this.lx + this.vx * ts));

    const walking = this.onFloor && dir !== 0;
    player.onSurface = this.onFloor;
    player.isWalking = walking;
    if (walking) {
      player.walkTime += (Math.abs(this.vx * ts) / player.strideLength) * Math.PI * 2;
    }
    player.vel.x = this.vx; player.vel.y = this.vy;
    this.placePlayer(player);
  }

  // ------------------------------------------------------------------
  // Drawing
  // ------------------------------------------------------------------

  // On the screen, with the HUD (see main.js's draw): whatever the game
  // shows there.
  drawHud() {
    if (this.hasPlayer()) this.game.drawHud(this.controlling);
  }

  // The panel: a small desk with a screen showing which way the planet's
  // turned (a blinking ring while nobody's at it).
  drawPanel(cx, cy, t) {
    const g = love.graphics;
    const x = cx + PANEL_X, floorY = cy + FLOOR_Y;
    const desk = [x - 34, floorY, x + 40, floorY, x + 40, floorY - 50, x - 22, floorY - 64];
    g.setColor(COLOR_OUTLINE);
    g.setLineWidth(7);
    g.polygon('line', desk);
    g.setColor(COLOR_PANEL);
    g.polygon('fill', desk);
    g.setColor(COLOR_PANEL_TOP);
    g.polygon('fill', x - 22, floorY - 64, x + 40, floorY - 50, x + 40, floorY - 43, x - 25, floorY - 55);

    // The screen, on a stalk.
    const sx = x - 10, sy = floorY - 112, sw = 48, sh = 36;
    g.setColor(COLOR_OUTLINE);
    g.setLineWidth(5);
    g.line(x + 14, sy + sh + 4, x + 8, floorY - 60);
    g.rectangle('fill', sx - 4, sy - 4, sw + 8, sh + 8, 5, 5);
    g.setColor(0.10, 0.04, 0.10, 1);
    g.rectangle('fill', sx, sy, sw, sh, 3, 3);
    const mx = sx + sw / 2, my = sy + sh / 2;
    const [ar, ag, ab] = this.accent;
    g.setColor(ar, ag, ab, 1);
    g.setLineWidth(3);
    if (this.controlling) {
      // A ring turning with the planet, and a mark on it.
      const a = this.game.angle;
      g.circle('line', mx, my, 11);
      g.circle('fill', mx + Math.cos(a - Math.PI / 2) * 11, my + Math.sin(a - Math.PI / 2) * 11, 4);
    } else {
      const blink = (Math.sin(t * 3) + 1) / 2;
      g.setColor(ar, ag, ab, 0.3 + 0.6 * blink);
      g.circle('line', mx, my, 11);
    }
    // Two lights on the desk: Left and Right.
    const keys = state.keys;
    for (let k = 0; k <= 1; k++) {
      const on = this.controlling && keys[k === 0 ? 'ArrowLeft' : 'ArrowRight'];
      g.setColor(1, 0.75, 0.3, on ? 1 : 0.35);
      g.circle('fill', x - 6 + k * 24, floorY - 48 + k * 4, 5);
    }
  }

  drawPad(cx, cy) {
    const g = love.graphics;
    const x = cx + PAD_X, y = cy + FLOOR_Y;
    g.setColor(COLOR_OUTLINE);
    g.ellipse('fill', x, y - 2, 46, 11);
    g.setColor(COLOR_PAD);
    g.ellipse('fill', x, y - 4, 41, 8);
    const [ar, ag, ab] = this.accent;
    g.setColor(ar, ag, ab, 0.6);
    g.ellipse('fill', x, y - 5, 22, 4);
  }

  // The game (always: what's on the planet shows from outside too), then
  // the room over the planet's middle while he's in.
  draw() {
    const g = love.graphics;
    this.game.draw();
    if (!this.hasPlayer()) return;

    const cx = this.planet.pos.x, cy = this.planet.pos.y;
    const t = love.timer.getTime();
    const x0 = cx - ROOM_HALF_WIDTH, y0 = cy + ROOM_TOP;
    const w = ROOM_HALF_WIDTH * 2, h = FLOOR_Y - ROOM_TOP + 14;

    g.setColor(COLOR_OUTLINE);
    g.rectangle('fill', x0 - 10, y0 - 10, w + 20, h + 20, 22, 22);
    g.setColor(COLOR_RIM);
    g.rectangle('fill', x0 - 6, y0 - 6, w + 12, h + 12, 19, 19);
    g.setColor(COLOR_ROOM);
    g.rectangle('fill', x0, y0, w, h, 14, 14);
    // Faint wall panels.
    g.setColor(1, 1, 1, 0.04);
    g.setLineWidth(2);
    for (let y = ROOM_TOP + 35; y <= FLOOR_Y - 20; y += 35) {
      g.line(x0 + 8, cy + y, x0 + w - 8, cy + y);
    }
    // The floor.
    g.setColor(COLOR_FLOOR);
    g.rectangle('fill', x0, cy + FLOOR_Y, w, 14, 0, 0);
    g.setColor(COLOR_FLOOR_EDGE);
    g.setLineWidth(3);
    g.line(x0, cy + FLOOR_Y + 1, x0 + w, cy + FLOOR_Y + 1);

    this.drawPanel(cx, cy, t);
    this.drawPad(cx, cy);

    const player = state.player;
    if (player.isTeleporting) return;
    if (this.controlling) {
      InteractPrompt.draw(cx + PANEL_X, cy + ROOM_TOP - 4, 'stop');
    } else if (this.atPanel()) {
      InteractPrompt.draw(cx + PANEL_X, cy + ROOM_TOP - 4, 'play');
    }
  }
}

ControlRoom.PAD_X = PAD_X;
ControlRoom.EXIT_ANGLE = EXIT_ANGLE;
