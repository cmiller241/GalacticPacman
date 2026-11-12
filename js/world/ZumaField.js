// js/world/ZumaField.js
//
// The Zuma planet's game (see js/levels/ZumaPlanet.js; it's the game of
// the planet's control room, js/interiors/ControlRoom.js).
//
// Taking the controls puts a cannon on the planet's surface, a colored
// ball poking out of its mouth. Left and Right turn the planet, which
// aims the cannon; the jump button fires the ball straight out.
//
// Out in space a black hole forms, and a train of colored balls rolls
// out of it along a path that spirals in round the planet (drawn
// faintly, brightening and reddening toward the planet). If the train's
// front ball reaches the planet, the game's lost.
//
// A shot that hits the train is pushed into it right there. If that
// makes MATCH or more touching balls of one color, they all pop. A gap
// left behind closes up (the part of the train in front of it rolls back
// to meet the part behind), and if the balls meeting there make a match
// too, they pop as well — a chain. Clear every ball the black hole sends (TOTAL_BALLS)
// and the game's won.
//
// The cannon only ever loads colors still in the train, and the next
// one's shown on its base.
//
// The train's balls each have a distance along the path (s), front
// first: this.balls[0] is nearest the planet. Only the back of the train
// is pushed along (the black hole pushes it out); a ball touching the
// one behind it is pushed along too. Ahead of a gap, the balls roll
// back toward it instead.

import love from '../love/index.js';
import state from '../state.js';
import CameraShake from '../effects/CameraShake.js';

// --------------------------------------------------------------------
// Tunables
// --------------------------------------------------------------------

const BALL_RADIUS = 56;
const GAP = BALL_RADIUS * 2;     // one ball to the next, along the path
const TOUCH = GAP + 0.5;         // (two balls closer than this are touching)
const COLORS = [
  [0.95, 0.30, 0.32], // red
  [1.00, 0.84, 0.22], // yellow
  [0.35, 0.85, 0.40], // green
  [0.32, 0.56, 1.00], // blue
];
const TOTAL_BALLS = 40;          // how many the black hole sends out
const SAME_COLOR_CHANCE = 0.35;  // how likely a new ball is the color of the one before it
const MATCH = 3;                 // touching balls of a color that pop

// The path: where it starts (how far from the planet's middle — the
// black hole's there), how many times it winds round, and how finely it's
// traced. It ends touching the planet.
const PATH_START = 1400;
const PATH_TURNS = 1.6;
const PATH_POINTS = 700;

// The train's speed along the path (world units a second): rushing out
// at first (till INTRO_BALLS are out), then its steady crawl, and how
// fast the part in front of a gap rolls back to close it.
const INTRO_SPEED = 600;
const INTRO_BALLS = 10;
const BASE_SPEED = 105;
const ROLLBACK_SPEED = 450;
const DRAW_EASE = 0.35;          // how quickly a ball pushed along slides to its place (per tick)

// The cannon: its barrel's length and width (before CANNON_SCALE: it's
// drawn that much bigger, to fit the balls), how fast shots fly (world
// units a second) and how soon it can fire again (seconds).
const CANNON_SCALE = 2;
const BARREL_LENGTH = 88;
const BARREL_WIDTH = 44;
const SHOT_SPEED = 1700;
const SHOT_COOLDOWN = 0.22;
const INSERT_TIME = 0.1;         // seconds a shot takes to settle into the train
// The planet's turn: top speed (radians a second), and how quickly it
// gets up to it and back down (fraction of the way per tick).
const SPIN_SPEED = 1.7;
const SPIN_EASE = 0.25;

// The black hole: its size, and how long it takes to form (and collapse).
const HOLE_RADIUS = 220;
const HOLE_FORM_TIME = 1.6;
// The shader's drawing: the event horizon's radius, and the square it's
// drawn on (half its size), each as a fraction of the hole's size.
const HORIZON_SIZE = 0.55;
const HOLE_BOX = 2.6;

// The black hole, drawn by a shader (made the first time it's needed): a
// black event horizon, a white-hot ring of light hugging it, a disk of
// matter swirling in (orange-hot near the middle, cooling to purple
// further out, wound tighter the closer it is, with spiral arms), and a
// soft purple glow round it all.
let holeShader = null;
function getHoleShader() {
  if (holeShader) return holeShader;
  holeShader = love.graphics.newShader(`
    extern vec2 originScreen;  // the square's top-left corner, in screen pixels
    extern number zoom;
    extern number boxHalf;     // half the square's size (world units); the hole's in its middle
    extern number horizon;     // the event horizon's radius (world units)
    extern number time;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                 mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }
    float fbm(vec2 p) {
      return 0.5 * noise(p) + 0.3 * noise(p * 2.1 + 3.7) + 0.2 * noise(p * 4.3 + 9.1);
    }

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec2 p = (screen - originScreen) / zoom - vec2(boxHalf, boxHalf);
      float d = length(p) / horizon;          // 1 at the event horizon
      float a = atan(p.y, p.x);

      // The accretion disk: matter swirling in, wound tighter the closer it
      // is (the twist), turbulent (noise in the twisted frame, so it has no
      // seam), with spiral arms; brightest just outside the horizon.
      float twist = time * 1.4 + 2.2 / (d + 0.25);
      vec2 q = vec2(cos(twist) * p.x - sin(twist) * p.y, sin(twist) * p.x + cos(twist) * p.y) / horizon;
      float turbulence = fbm(q * 2.4 + vec2(time * 0.3, 0.0));
      float arms = 0.5 + 0.5 * sin(a * 3.0 + 5.0 * log(max(d, 0.01)) - time * 2.5);
      float disk = smoothstep(0.98, 1.2, d) * (1.0 - smoothstep(1.35, 2.9, d));
      float matter = disk * (0.35 + 0.65 * arms) * (0.45 + 0.9 * turbulence);
      vec3 hot = vec3(1.0, 0.62, 0.25);
      vec3 cool = vec3(0.55, 0.25, 0.95);
      vec3 matterColor = mix(cool, hot, 1.0 - smoothstep(1.1, 2.4, d));

      // The photon ring: a thin white-hot circle hugging the horizon, and a
      // soft purple glow fading out round everything.
      float ring = exp(-pow((d - 1.03) / 0.045, 2.0));
      float glow = exp(-max(d - 1.0, 0.0) * 1.5) * 0.35;

      vec3 light = matterColor * matter * 1.6 + vec3(1.0, 0.92, 0.8) * ring * 1.4 + vec3(0.5, 0.25, 0.9) * glow;
      float lit = clamp(matter + ring + glow, 0.0, 1.0);
      // Inside the horizon: black.
      float dark = 1.0 - smoothstep(0.94, 1.0, d);
      float alpha = max(dark, lit);
      vec3 rgb = light * (1.0 - dark) / max(alpha, 0.001);
      // (Nothing at the square's edges.)
      alpha *= 1.0 - smoothstep(boxHalf * 0.8, boxHalf, length(p));
      return vec4(min(rgb, vec3(1.0)), alpha) * color;
    }
`);
  return holeShader;
}
// The end of a game: how long the balls take to pop and the hole to
// collapse before he's let go of the controls, and how long the banner
// stays up.
const OVER_TIME = 1.8;
const BANNER_TIME = 4;
const POP_TIME = 0.35;

const COLOR_OUTLINE = [0.04, 0.04, 0.08];
const COLOR_BRONZE = [0.80, 0.60, 0.28];
const COLOR_BRONZE_DARK = [0.52, 0.36, 0.16];
const COLOR_BRONZE_LIGHT = [0.98, 0.82, 0.48];

const randomColor = () => Math.floor(Math.random() * COLORS.length);

// --------------------------------------------------------------------
// Drawing helpers
// --------------------------------------------------------------------

// One ball, shaded like a planet by the sun: lit on the sun's side and
// dark on the far side, a glare (the sun's reflection) toward it, and
// reflected light round the edge farthest from it; a dark edge, and a
// band showing it roll (roll: how far it's rolled, in radians; null for
// none). Drawn by a shader (made the first time it's needed), on a
// square round it — in whatever transform is current (the cannon's, say):
// it works out where that puts the ball on the screen. sunDirX/Y: set
// each frame (see ZumaField.draw).
let ballShader = null;
let sunDirX = 1, sunDirY = 0;
function getBallShader() {
  if (ballShader) return ballShader;
  ballShader = love.graphics.newShader(`
    extern vec2 center;        // the ball's middle, in screen pixels
    extern number radius;      // its radius, in screen pixels
    extern vec3 baseColor;
    extern vec2 sunDir;        // unit vector toward the sun (screen space, y down)
    extern number roll;        // how far it's rolled (radians): turns the band round it
    extern number rollAmount;  // 0: no band (a shot in flight, the cannon's balls)

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec2 p = (screen - center) / radius;
      float d = length(p);
      float px = 1.0 / radius;
      float edge = 1.0 + 2.5 * px;                    // a dark edge 2.5 pixels wide
      float body = 1.0 - smoothstep(1.0 - px, 1.0 + px, d);
      float alpha = 1.0 - smoothstep(edge - px, edge + px, d);
      vec2 out2 = p / max(d, 0.0001);                 // out from the middle, flat
      float dd = min(d, 1.0);
      vec3 n = vec3(out2 * dd, sqrt(max(0.0, 1.0 - dd * dd)));  // the sphere's normal
      vec3 light = normalize(vec3(sunDir, 0.55));

      // Shading: lit on the sun's side, dark on the far side.
      float lit = max(dot(n, light), 0.0);
      vec3 col = baseColor * (0.28 + 0.85 * lit);
      // The band it rolls round on.
      vec2 axis = vec2(cos(roll), sin(roll));
      float band = (1.0 - smoothstep(0.10, 0.18, abs(dot(p, vec2(-axis.y, axis.x))))) * rollAmount;
      col = mix(col, col * 1.25 + 0.08, band * 0.35);
      // The glare: the sun's reflection, a bright spot toward it.
      vec3 bounce = reflect(-light, n);
      col += vec3(1.0) * pow(max(bounce.z, 0.0), 28.0) * 0.85;
      // Reflected light round the edge farthest from the sun.
      float rim = pow(1.0 - n.z, 2.5) * max(dot(out2, -sunDir), 0.0);
      col += (baseColor * 0.6 + vec3(0.25, 0.30, 0.40)) * rim * 0.75;

      vec3 rgb = mix(vec3(0.04, 0.04, 0.08), col, body);
      return vec4(rgb, alpha) * color;
    }
`);
  return ballShader;
}

function drawBall(x, y, r, color, roll = null, alpha = 1) {
  const g = love.graphics;
  const [sx, sy] = g.transformPoint(x, y);
  const [ex, ey] = g.transformPoint(x + r, y);
  const radius = Math.hypot(ex - sx, ey - sy);
  if (radius < 0.5) return;
  const sh = getBallShader();
  g.setShader(sh);
  sh.send('center', [sx, sy]);
  sh.send('radius', radius);
  sh.send('baseColor', [color[0], color[1], color[2]]);
  sh.send('sunDir', [sunDirX, sunDirY]);
  sh.send('roll', roll ?? 0);
  sh.send('rollAmount', roll === null ? 0 : 1);
  g.setColor(1, 1, 1, alpha);
  const pad = r * 1.1 + 4;
  g.rectangle('fill', x - pad, y - pad, pad * 2, pad * 2);
  g.setShader();
}

// Marks round the planet's edge, turning with it, so its turn shows.
function drawSurfaceMarks(planet, angle) {
  const g = love.graphics;
  const r = planet.radius;
  g.setLineWidth(3);
  for (let k = 0; k < 24; k++) {
    const a = angle + (k / 24) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    g.setColor(1, 1, 1, k % 6 === 0 ? 0.25 : 0.1);
    g.line(planet.pos.x + c * (r - 16), planet.pos.y + s * (r - 16), planet.pos.x + c * (r - 3), planet.pos.y + s * (r - 3));
  }
}

let hudFont = null, bannerFont = null;

export default class ZumaField {
  constructor(planet) {
    this.planet = planet;
    this.angle = 0;          // how far the planet's turned (radians, clockwise)
    this.spin = 0;           // how fast it's turning now (radians a second)
    this.phase = 'idle';     // 'idle', 'forming' (the hole), 'playing', 'over'
    this.path = null;        // the path's points, { x, y, s } (s: distance along it)
    this.pathLength = 0;
    this.pathFade = 0;       // how much the path shows (fades in and out)
    this.holeSize = 0;       // the black hole's radius now (grows and shrinks)
    this.balls = [];         // the train, front first: { color, s, drawS, fly }
    this.spawned = 0;
    this.shots = [];
    this.cooldown = 0;
    this.current = null;     // the color in the cannon, and the one after it
    this.nextColor = null;
    this.cannonShow = 0;     // the cannon popping up (0 to 1) and down
    this.recoil = 0;
    this.chain = 0;
    this.pops = [];          // balls bursting: { x, y, color, t }
    this.over = null;        // { kind: 'lost' or 'won', timer, popTimer }
    this.banner = null;      // { title, sub, color, timer }
    this.finished = false;   // (see ControlRoom.updateGame)
  }

  // ------------------------------------------------------------------
  // The path
  // ------------------------------------------------------------------

  // A spiral from PATH_START out, in round the planet PATH_TURNS times, to
  // the planet's surface, starting from a random side.
  buildPath() {
    const planet = this.planet;
    const cx = planet.pos.x, cy = planet.pos.y;
    const endR = planet.radius + BALL_RADIUS;
    const a0 = Math.random() * Math.PI * 2;
    const points = [];
    let total = 0, px = null, py = null;
    for (let i = 0; i <= PATH_POINTS; i++) {
      const t = i / PATH_POINTS;
      const r = endR + (PATH_START - endR) * (1 - t);
      const a = a0 + t * PATH_TURNS * Math.PI * 2;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      if (px !== null) total += Math.hypot(x - px, y - py);
      points.push({ x, y, s: total });
      px = x; py = y;
    }
    this.path = points;
    this.pathLength = total;
  }

  // Where on the path distance s is, and which way it runs there (a unit
  // vector toward the planet end): [x, y, dx, dy].
  pathAt(s) {
    const points = this.path;
    s = Math.max(0, Math.min(this.pathLength, s));
    let lo = 0, hi = points.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (points[mid].s <= s) lo = mid; else hi = mid;
    }
    const a = points[lo], b = points[hi];
    const len = b.s - a.s;
    const f = len > 0 ? (s - a.s) / len : 0;
    const dx = b.x - a.x, dy = b.y - a.y;
    let d = Math.hypot(dx, dy);
    if (d < 1e-6) d = 1;
    return [a.x + dx * f, a.y + dy * f, dx / d, dy / d];
  }

  // ------------------------------------------------------------------
  // Colors
  // ------------------------------------------------------------------

  // Whether a color's still in the train.
  colorInTrain(color) {
    return this.balls.some((b) => b.color === color);
  }

  // A color for the cannon: one still in the train (any, if it's empty).
  pickColor() {
    const present = [];
    for (let k = 0; k < COLORS.length; k++) if (this.colorInTrain(k)) present.push(k);
    if (present.length === 0) return randomColor();
    return present[Math.floor(Math.random() * present.length)];
  }

  // ------------------------------------------------------------------
  // The train
  // ------------------------------------------------------------------

  // New balls out of the black hole, while there's room at the back: each
  // right behind the last one out, or at the hole itself if the back of
  // the train's been cleared away from it (so they always come out of the
  // hole, one at a time, never appearing all along the empty path).
  spawnBalls() {
    while (this.spawned < TOTAL_BALLS) {
      const tail = this.balls[this.balls.length - 1];
      if (tail && tail.s < GAP) return;
      const s = tail && tail.s < GAP * 2 ? tail.s - GAP : 0;
      const color = tail && Math.random() < SAME_COLOR_CHANCE ? tail.color : randomColor();
      this.balls.push({ color, s, drawS: s, fly: null });
      this.spawned++;
    }
  }

  // The run of touching same-colored balls around ball i: [first, last].
  runAround(i) {
    const balls = this.balls;
    const color = balls[i].color;
    let lo = i, hi = i;
    while (lo > 0 && balls[lo - 1].color === color && balls[lo - 1].s - balls[lo].s <= TOUCH) lo--;
    while (hi < balls.length - 1 && balls[hi + 1].color === color && balls[hi].s - balls[hi + 1].s <= TOUCH) hi++;
    return [lo, hi];
  }

  // Pops the run round ball i if it's MATCH or more. chained: whether a
  // gap closing set it off (else a shot did). Returns whether it popped.
  tryMatch(i, chained) {
    const [lo, hi] = this.runAround(i);
    if (hi - lo + 1 < MATCH) return false;
    this.chain = chained ? this.chain + 1 : 1;
    for (const b of this.balls.splice(lo, hi - lo + 1)) {
      const [x, y] = this.pathAt(b.drawS);
      this.pops.push({ x, y, color: b.color, t: 0 });
    }
    if (state.audioManager) state.audioManager.playZumaPop(this.chain);
    return true;
  }

  // The train rolls on: the back of it pushed along, everything it touches
  // pushed ahead of it. In front of a gap, the balls roll back toward it
  // (never past touching the balls behind). Where a gap has just closed and
  // the balls meeting match, they pop (a chain).
  moveTrain(dt) {
    const balls = this.balls;
    const n = balls.length;
    if (n === 0) return;
    const open = [];
    for (let i = 0; i < n - 1; i++) open[i] = balls[i].s - balls[i + 1].s > TOUCH;
    const speed = this.spawned < INTRO_BALLS ? INTRO_SPEED : BASE_SPEED;
    balls[n - 1].s += speed * dt;
    for (let i = n - 2; i >= 0; i--) {
      const least = balls[i + 1].s + GAP;
      if (balls[i].s < least) balls[i].s = least;
    }
    // (Each part of the train in front of a gap, from the back forward: it
    // rolls back as one, as far as it can this frame.)
    let i = n - 2;
    while (i >= 0) {
      if (balls[i].s - balls[i + 1].s > TOUCH) {
        let first = i;
        while (first > 0 && balls[first - 1].s - balls[first].s <= TOUCH) first--;
        const back = Math.min(ROLLBACK_SPEED * dt, balls[i].s - (balls[i + 1].s + GAP));
        for (let k = first; k <= i; k++) balls[k].s -= back;
        i = first - 1;
      } else {
        i--;
      }
    }
    for (let i = 0; i < n - 1; i++) {
      if (open[i] && balls[i].s - balls[i + 1].s <= TOUCH && balls[i].color === balls[i + 1].color) {
        this.tryMatch(i, true);
        return; // (one at a time: the train's changed)
      }
    }
  }

  // ------------------------------------------------------------------
  // The cannon and its shots
  // ------------------------------------------------------------------

  // Which way the cannon points (out from the planet): it sits on top of
  // the planet as it was at the start, and turns with it.
  cannonAngle() {
    return this.angle - Math.PI / 2;
  }

  // The jump button: fires the ball in the cannon, then loads the next.
  fire() {
    if (this.phase !== 'playing' || this.cooldown > 0) return;
    const planet = this.planet;
    const a = this.cannonAngle();
    const dx = Math.cos(a), dy = Math.sin(a);
    const r = planet.radius + BARREL_LENGTH * CANNON_SCALE;
    this.shots.push({
      x: planet.pos.x + dx * r, y: planet.pos.y + dy * r,
      vx: dx * SHOT_SPEED, vy: dy * SHOT_SPEED,
      color: this.current,
    });
    this.current = this.nextColor;
    this.nextColor = this.pickColor();
    this.cooldown = SHOT_COOLDOWN;
    this.recoil = 1;
    if (state.audioManager) state.audioManager.playZumaShoot();
  }

  // A shot's hit ball i: it's pushed into the train beside it (ahead of it
  // or behind, whichever side it hit), the balls ahead pushed along to make
  // room, and anything it matches pops.
  insertShot(shot, i) {
    const balls = this.balls;
    const b = balls[i];
    const [bx, by, tx, ty] = this.pathAt(b.s);
    const ahead = (shot.x - bx) * tx + (shot.y - by) * ty > 0;
    const k = ahead ? i : i + 1;
    const s = ahead ? b.s + GAP : b.s;
    balls.splice(k, 0, { color: shot.color, s, drawS: s, fly: { x: shot.x, y: shot.y, t: 0 } });
    for (let j = k - 1; j >= 0; j--) {
      const least = balls[j + 1].s + GAP;
      if (balls[j].s < least) balls[j].s = least; else break;
    }
    this.tryMatch(k, false);
  }

  updateShots(dt) {
    const planet = this.planet;
    const balls = this.balls;
    // (Where every ball is now, for hitting.)
    const where = balls.map((b) => this.pathAt(b.s));
    const reach = PATH_START + 300;
    for (let k = this.shots.length - 1; k >= 0; k--) {
      const shot = this.shots[k];
      const dist = Math.hypot(shot.vx * dt, shot.vy * dt);
      const steps = Math.max(1, Math.ceil(dist / (BALL_RADIUS * 0.5)));
      let hit = -1;
      for (let step = 0; step < steps && hit < 0; step++) {
        shot.x += (shot.vx * dt) / steps;
        shot.y += (shot.vy * dt) / steps;
        for (let i = 0; i < balls.length; i++) {
          const [bx, by] = where[i];
          if ((shot.x - bx) ** 2 + (shot.y - by) ** 2 < GAP * GAP) { hit = i; break; }
        }
      }
      if (hit >= 0) {
        this.shots.splice(k, 1);
        this.insertShot(shot, hit);
        return; // (the train's changed; other shots carry on next frame)
      }
      const dx = shot.x - planet.pos.x, dy = shot.y - planet.pos.y;
      if (dx * dx + dy * dy > reach * reach) this.shots.splice(k, 1);
    }
  }

  // ------------------------------------------------------------------
  // Starting and ending
  // ------------------------------------------------------------------

  // He's taken the controls: a new game. The black hole starts forming; the
  // train comes out once it has.
  start() {
    this.buildPath();
    this.balls = [];
    this.shots = [];
    this.spawned = 0;
    this.phase = 'forming';
    this.over = null;
    this.banner = null;
    this.finished = false;
    this.chain = 0;
    this.current = randomColor();
    this.nextColor = randomColor();
  }

  // Every ball still in the train pops (the game's been stopped).
  popAll() {
    for (const b of this.balls) {
      const [x, y] = this.pathAt(b.drawS);
      this.pops.push({ x, y, color: b.color, t: 0 });
    }
    this.balls = [];
    this.shots = [];
  }

  // He's let go mid-game: it's over. Everything pops and the hole collapses.
  stop() {
    if (this.phase === 'idle') return;
    this.popAll();
    if (this.pops.length > 0 && state.audioManager) state.audioManager.playZumaPop(1);
    this.phase = 'idle';
    this.over = null;
  }

  // The game's ended on its own: lost (the train reached the planet) or won
  // (every ball cleared).
  finish(kind) {
    this.phase = 'over';
    this.over = { kind, timer: 0, popTimer: 0 };
    this.shots = [];
    const audio = state.audioManager;
    if (kind === 'lost') {
      this.banner = {
        title: 'THE BALLS REACHED THE PLANET!', sub: 'Press ENTER at the panel to try again',
        color: [1, 0.45, 0.4], timer: BANNER_TIME,
      };
      CameraShake.start(18, 0.6);
      if (audio) audio.playDeath();
    } else {
      this.banner = {
        title: 'CLEARED!', sub: 'The black hole collapses',
        color: [1, 0.86, 0.4], timer: BANNER_TIME,
      };
      if (audio) audio.playTetrisClear(4);
    }
  }

  // ------------------------------------------------------------------
  // Every frame
  // ------------------------------------------------------------------

  update(dt, ts, playing, steer = 0) {
    const active = this.phase === 'forming' || this.phase === 'playing';

    // The planet's turn (only while there's a cannon to aim).
    const want = playing && active ? steer * SPIN_SPEED : 0;
    this.spin += (want - this.spin) * Math.min(1, SPIN_EASE * ts);
    if (Math.abs(this.spin) < 0.001 && want === 0) this.spin = 0;
    this.angle += this.spin * dt;

    // What fades and grows: the path, the hole, the cannon.
    const showing = active || (this.phase === 'over' && this.over.timer < OVER_TIME * 0.6);
    this.pathFade = Math.max(0, Math.min(1, this.pathFade + (showing ? 1 : -1) * dt * 1.5));
    const holeRate = HOLE_RADIUS / HOLE_FORM_TIME;
    if (showing) this.holeSize = Math.min(HOLE_RADIUS, this.holeSize + holeRate * dt);
    else this.holeSize = Math.max(0, this.holeSize - holeRate * 2 * dt);
    this.cannonShow = Math.max(0, Math.min(1, this.cannonShow + (active && playing ? 1 : -1) * dt * 4));
    this.recoil = Math.max(0, this.recoil - dt * 6);
    this.cooldown = Math.max(0, this.cooldown - dt);

    // Balls bursting, and sliding into their places.
    for (const p of this.pops) p.t += dt;
    this.pops = this.pops.filter((p) => p.t < POP_TIME);
    const ease = Math.min(1, DRAW_EASE * ts);
    for (const b of this.balls) {
      b.drawS += (b.s - b.drawS) * ease;
      if (b.fly) {
        b.fly.t += dt;
        if (b.fly.t >= INSERT_TIME) b.fly = null;
      }
    }
    if (this.banner) {
      this.banner.timer -= dt;
      if (this.banner.timer <= 0) this.banner = null;
    }

    if (this.phase === 'forming') {
      if (this.holeSize >= HOLE_RADIUS) this.phase = 'playing';
    } else if (this.phase === 'playing') {
      this.spawnBalls();
      this.moveTrain(dt);
      this.updateShots(dt);
      // (The cannon only ever holds colors still in the train.)
      if (this.balls.length > 0) {
        if (!this.colorInTrain(this.current)) this.current = this.pickColor();
        if (!this.colorInTrain(this.nextColor)) this.nextColor = this.pickColor();
      }
      const front = this.balls[0];
      if (front && front.s >= this.pathLength) this.finish('lost');
      else if (this.spawned >= TOTAL_BALLS && this.balls.length === 0) this.finish('won');
    } else if (this.phase === 'over') {
      const over = this.over;
      over.timer += dt;
      // (Lost: the train pops, front first.)
      over.popTimer -= dt;
      while (this.balls.length > 0 && over.popTimer <= 0) {
        over.popTimer += 0.03;
        const b = this.balls.shift();
        const [x, y] = this.pathAt(b.drawS);
        this.pops.push({ x, y, color: b.color, t: 0 });
      }
      if (over.timer >= OVER_TIME) {
        this.balls = [];
        this.phase = 'idle';
        this.over = null;
        this.finished = true;
      }
    }
  }

  // How far round the planet its game reaches (the path, the black hole and
  // its glow): what drifting planetoids are kept out of (see ZumaPlanet.js).
  static REACH = PATH_START + HOLE_RADIUS * 1.4;

  // The jump button at the controls: fires.
  onJump() { this.fire(); }

  // How far out the camera frames, at the controls: the whole path, and the hole.
  cameraReach() {
    return PATH_START + HOLE_RADIUS * 0.6;
  }

  // ------------------------------------------------------------------
  // Drawing
  // ------------------------------------------------------------------

  // The path: faint where it starts, brighter and redder toward the planet.
  // The stretch still ahead of the train glows more (and pulses) the nearer
  // the front ball is to the end. A red ring marks the end.
  drawPath(t) {
    const g = love.graphics;
    const points = this.path, fade = this.pathFade;
    const n = points.length;
    const front = this.balls[0];
    const danger = front ? front.s / this.pathLength : 0;
    const warn = Math.max(0, (danger - 0.5) * 2);
    const pulse = 0.5 + 0.5 * Math.sin(t * 7);
    const CHUNK = 14;
    g.setLineWidth(20);
    for (let i = 0; i < n - 1; i += CHUNK) {
      const j = Math.min(n - 1, i + CHUNK);
      const f = points[i].s / this.pathLength;
      const ahead = front && points[i].s > front.s;
      let alpha = (0.08 + 0.22 * f) * fade;
      if (ahead) alpha += warn * (0.25 + 0.35 * pulse) * fade;
      g.setColor(0.85 + 0.15 * f, 0.85 - 0.6 * f, 1.0 - 0.8 * f, alpha);
      const line = [];
      for (let k = i; k <= j; k++) line.push(points[k].x, points[k].y);
      g.line(line);
    }
    const last = points[n - 1];
    g.setColor(1, 0.25, 0.2, (0.4 + 0.4 * pulse * (0.3 + warn)) * fade);
    g.setLineWidth(8);
    g.circle('line', last.x, last.y, BALL_RADIUS + 12);
  }

  // The black hole (see getHoleShader), on a square round where the path
  // starts.
  drawHole(t) {
    const g = love.graphics;
    const size = this.holeSize;
    if (size <= 0.5 || !this.path) return;
    const p = this.path[0];
    const sh = getHoleShader();
    const zoom = state.zoom ?? 1;
    const cam = state.camera ?? { x: 0, y: 0 };
    const half = size * HOLE_BOX;
    const x0 = p.x - half, y0 = p.y - half;
    g.setShader(sh);
    sh.send('originScreen', [(x0 - cam.x) * zoom, (y0 - cam.y) * zoom]);
    sh.send('zoom', zoom);
    sh.send('boxHalf', half);
    sh.send('horizon', size * HORIZON_SIZE);
    sh.send('time', t % 600); // (kept small: shaders lose precision on big numbers)
    g.setColor(1, 1, 1, 1);
    g.rectangle('fill', x0, y0, half * 2, half * 2);
    g.setShader();
  }

  // The cannon on the planet's surface, pointing out: a bronze dome with a
  // barrel, the loaded ball half out of its mouth, and the next color on
  // the dome. It pops up out of the planet when the game starts.
  drawCannon() {
    const g = love.graphics;
    const show = this.cannonShow;
    if (show <= 0.01) return;
    const planet = this.planet;
    g.push();
    g.translate(planet.pos.x, planet.pos.y);
    g.rotate(this.cannonAngle() + Math.PI / 2);
    g.translate(0, -planet.radius);
    g.scale(show * CANNON_SCALE, show * CANNON_SCALE);
    // (Here: the surface at 0, 0, out from the planet is up the screen,
    // everything CANNON_SCALE times bigger.)
    const kick = this.recoil * 10;
    const mouth = -BARREL_LENGTH + kick;
    const hw = BARREL_WIDTH / 2;

    if (this.current !== null && this.phase !== 'idle') drawBall(0, mouth, BALL_RADIUS / CANNON_SCALE, COLORS[this.current]);
    g.setColor(COLOR_OUTLINE);
    g.rectangle('fill', -hw - 3, mouth - 3, BARREL_WIDTH + 6, BARREL_LENGTH - kick + 3, 4, 4);
    g.setColor(COLOR_BRONZE);
    g.rectangle('fill', -hw, mouth, BARREL_WIDTH, BARREL_LENGTH - kick, 3, 3);
    g.setColor(COLOR_BRONZE_LIGHT);
    g.rectangle('fill', -hw + 4, mouth + 2, 6, BARREL_LENGTH - kick - 4, 2, 2);
    g.setColor(COLOR_BRONZE_DARK);
    for (let k = 0; k < 2; k++) g.rectangle('fill', -hw, mouth + 18 + k * 28, BARREL_WIDTH, 6);
    // The rim round the mouth.
    g.setColor(COLOR_OUTLINE);
    g.rectangle('fill', -hw - 6, mouth - 2, BARREL_WIDTH + 12, 12, 3, 3);
    g.setColor(COLOR_BRONZE_LIGHT);
    g.rectangle('fill', -hw - 3, mouth + 1, BARREL_WIDTH + 6, 6, 2, 2);
    // The dome.
    g.setColor(COLOR_OUTLINE);
    g.arc('fill', 'pie', 0, 6, 54, Math.PI, Math.PI * 2, 24);
    g.setColor(COLOR_BRONZE);
    g.arc('fill', 'pie', 0, 6, 50, Math.PI, Math.PI * 2, 24);
    g.setColor(COLOR_BRONZE_LIGHT);
    g.arc('fill', 'pie', 0, 6, 50, Math.PI * 1.15, Math.PI * 1.4, 10);
    if (this.nextColor !== null && this.phase !== 'idle') drawBall(0, -18, 12, COLORS[this.nextColor]);
    g.pop();

    // A faint aiming line, straight out.
    if (this.phase === 'playing') {
      const a = this.cannonAngle();
      const c = Math.cos(a), s = Math.sin(a);
      g.setColor(1, 1, 1, 0.18);
      for (let k = 0; k < 10; k++) {
        const d = planet.radius + BARREL_LENGTH * CANNON_SCALE + 70 + k * 60;
        g.circle('fill', planet.pos.x + c * d, planet.pos.y + s * d, 6);
      }
    }
  }

  // World space: the planet's marks, the path, the hole, the train, the
  // shots, the bursts and the cannon.
  draw() {
    const g = love.graphics;
    const t = love.timer.getTime();
    // (Which way the sun is — the middle of the world, as the planets have
    // it. It's so far off it's the same way for every ball.)
    const planet = this.planet;
    const tx = (state.sceneWidth ?? 0) / 2 - planet.pos.x, ty = (state.sceneHeight ?? 0) / 2 - planet.pos.y;
    const len = Math.hypot(tx, ty);
    if (len > 1) { sunDirX = tx / len; sunDirY = ty / len; }
    drawSurfaceMarks(this.planet, this.angle);
    if (this.path && this.pathFade > 0) this.drawPath(t);
    this.drawHole(t);

    for (const b of this.balls) {
      let [x, y] = this.pathAt(b.drawS);
      if (b.fly) {
        const f = b.fly.t / INSERT_TIME;
        x = b.fly.x + (x - b.fly.x) * f;
        y = b.fly.y + (y - b.fly.y) * f;
      }
      // (Coming out of the hole: growing to full size over its first ball's width.)
      const r = BALL_RADIUS * Math.min(1, Math.max(0.15, b.drawS / GAP));
      drawBall(x, y, r, COLORS[b.color], b.drawS / BALL_RADIUS);
    }
    for (const shot of this.shots) drawBall(shot.x, shot.y, BALL_RADIUS, COLORS[shot.color]);
    for (const p of this.pops) {
      const f = p.t / POP_TIME;
      const c = COLORS[p.color];
      drawBall(p.x, p.y, BALL_RADIUS * (1 + f * 0.6), c.map((v) => v + (1 - v) * f), null, 1 - f);
      g.setColor(1, 1, 1, 0.8 * (1 - f));
      g.setLineWidth(3);
      g.circle('line', p.x, p.y, BALL_RADIUS * (1 + f * 1.4));
    }
    this.drawCannon();
    g.setColor(1, 1, 1, 1);
  }

  // Screen space: how many balls are left (at the controls), and the
  // win/lose banner.
  drawHud(playing) {
    const g = love.graphics;
    hudFont ??= g.newFont(18);
    bannerFont ??= g.newFont(40);
    const prevFont = g.getFont();
    const screenW = g.getWidth(), screenH = g.getHeight();

    if (playing && (this.phase === 'forming' || this.phase === 'playing')) {
      const left = TOTAL_BALLS - this.spawned + this.balls.length;
      const w = 170, h = 64;
      const x0 = screenW - 20 - w, y0 = 20;
      g.setColor(0.04, 0.03, 0.08, 0.7);
      g.rectangle('fill', x0, y0, w, h, 12, 12);
      g.setColor(1, 1, 1, 0.3);
      g.setLineWidth(2);
      g.rectangle('line', x0, y0, w, h, 12, 12);
      g.setFont(hudFont);
      g.setColor(1, 1, 1, 0.85);
      g.printf('BALLS LEFT', x0, y0 + 8, w, 'center');
      g.setColor(1, 0.86, 0.4, 1);
      g.printf(String(left), x0, y0 + 32, w, 'center');
    }

    const banner = this.banner;
    if (banner) {
      const alpha = Math.min(1, banner.timer / 0.5);
      const y = screenH * 0.22;
      g.setFont(bannerFont);
      g.setColor(0, 0, 0, 0.6 * alpha);
      g.printf(banner.title, 3, y + 3, screenW, 'center');
      g.setColor(banner.color[0], banner.color[1], banner.color[2], alpha);
      g.printf(banner.title, 0, y, screenW, 'center');
      g.setFont(hudFont);
      g.setColor(1, 1, 1, 0.85 * alpha);
      g.printf(banner.sub, 0, y + 56, screenW, 'center');
    }

    g.setFont(prevFont);
    g.setColor(1, 1, 1, 1);
  }
}
