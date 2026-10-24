// js/world/RopeRock.js
//
// A rock slab hanging from a rope — placed in Tiled as two rectangle
// objects (see TiledTerrain's ropeSpawns/rockSpawns, paired up in main.js):
//   Rope  hangs from the top of its rectangle; custom property:
//           holds  (object, or its id) the Rock it holds — required
//   Rock  hangs where it's placed; custom property:
//           solid  (bool) true (the default): solid like a wall tile, and
//                  Bob can stand on top; false: just scenery
//
// The rock is solid on every side like a wall tile (it's in the level's
// walls — so fireballs go off against it, Ooombas turn at it, portals
// stick to it), with a walkable top (a moving surface — see
// TiledTerrain.newMovingSurface) for Bob to stand on.
//
// Hanging, it's still — until Bob jumps into it or shoots it: then it
// rocks back and forth on the rope, away from the hit, the swing slowly
// dying away. (It stays level as it swings — only the rope tilts.)
//
// Shoot the rope itself and it burns where it's hit, briefly, then it's
// gone — and the rock drops, falling with the dome's gravity until it
// lands on a ledge, a wall, another rock, or the dome's floor. Bob can
// Recall it (see js/systems/Recall.js — it's one of state.recallables).

import love from '../love/index.js';
import lua from '../love/lua.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import TiledTerrain from './TiledTerrain.js';
import Flame from '../effects/Flame.js';

// ---------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------

const ROPE_HIT_REACH = 10;     // world units from the rope a fireball's middle can pass and still set it alight
const BURN_TICKS = 60;         // how long the rope burns where it was hit before it's gone (60fps ticks)
const SWING_GRAVITY = 0.4;     // world units/tick^2 — what sets how fast it rocks
const SWING_DAMPING = 0.985;   // per tick: how much of its swing it keeps (lower dies away sooner)
const BUMP_SPEED = 0.025;      // radians/tick of swing Bob jumping into it gives it
const SHOT_SPEED = 0.022;      // ...and a fireball hitting it
const MAX_SWING_DEGREES = 70;  // never swings further than this either side
const FALL_GRAVITY = 0.6;      // world units/tick^2 (unless the dome has its own gravityStrength)
const MAX_FALL_SPEED = 22;     // world units/tick
const COLOR_ROPE = [0.55, 0.40, 0.22];
const COLOR_ROPE_DARK = [0.30, 0.20, 0.10];
const COLOR_ROPE_CHAR = [0.12, 0.08, 0.06]; // round where it's burning
const COLOR_ROCK_TOP = [0.60, 0.58, 0.55];  // the stone's lighter mottling...
const COLOR_ROCK_SPOT = [0.34, 0.32, 0.31]; // ...and its darker
const COLOR_ROCK_EDGE = [0.14, 0.13, 0.13]; // its rim
const ROCK_CORNER = 8;

// A fireball's path this frame, in a few steps (it's fast, the rope's
// thin): returns the first fireball for which `test` says yes at some
// point along it.
function alongFireballs(ts, test) {
  for (const f of state.fireballs ?? []) {
    for (let k = 0; k <= 4; k++) {
      const x = f.pos.x + f.vel.x * ts * k / 4;
      const y = f.pos.y + f.vel.y * ts * k / 4;
      if (test(f, x, y)) return f;
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// Drawing resources
// ---------------------------------------------------------------------

// Both the rope and the rock are drawn as one quad each through a
// shader, in their own local space — so the rope's twist and the rock's
// texture move with them as they swing and fall.

const NOISE_GLSL = `
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  vec2 hash2(vec2 p) {
    return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
  }
  // Gradient noise, 0..1 — not value noise, whose slope goes flat along
  // every grid line, which shows up as squares once it's lit as bumps.
  float grad(vec2 i, vec2 f) { return dot(hash2(i) * 2.0 - 1.0, f); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float n = mix(mix(grad(i, f), grad(i + vec2(1.0, 0.0), f - vec2(1.0, 0.0)), u.x),
                  mix(grad(i + vec2(0.0, 1.0), f - vec2(0.0, 1.0)), grad(i + vec2(1.0, 1.0), f - vec2(1.0, 1.0)), u.x), u.y);
    return n * 0.7 + 0.5;
  }
  // (Each octave turned, so their grids don't line up either.)
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int k = 0; k < 4; k++) {
      v += a * noise(p);
      p = mat2(1.6, 1.2, -1.2, 1.6) * p + vec2(1.7, 9.2);
      a *= 0.5;
    }
    return v;
  }
`;

// The rope: strands twisting round it, so they cross it on the diagonal
// (each shaded as a little cylinder, with dark grooves between), fine
// fibres running along them, and the whole rope shaded round. Charred
// where it's burning, glowing at the char's edges. uv.x runs along it
// from the top (where it's tied) to the rock; uv.y across.
const ROPE_DRAW_WIDTH = 8; // world units (its hit reach is ROPE_HIT_REACH)
const ROPE_PITCH = 9;      // world units along it from one strand to the next
const CHAR_HALF = 14;      // world units of char either side of the flame

let ropeShader = null;
function getRopeShader() {
  if (ropeShader) return ropeShader;
  ropeShader = love.graphics.newShader(NOISE_GLSL + `
    extern number len;
    extern number width;
    extern number pitch;
    extern number burnAt;     // world units along it, or < 0 if it isn't burning
    extern number charHalf;
    extern number time;
    extern vec3 ropeColor;
    extern vec3 darkColor;
    extern vec3 charColor;

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      float s = uv.x * len;
      float v = uv.y * 2.0 - 1.0;            // -1..1 across
      float y = v * width * 0.5;

      // The strands, slanting across it.
      float along = s + y * 1.3;
      float phase = fract(along / pitch);
      float strand = sin(phase * 3.14159);   // 0 in a groove .. 1 mid-strand
      float roundness = sqrt(max(0.0, 1.0 - v * v));
      float fibre = noise(vec2(along * 0.8, (s - y * 0.8) * 0.12));

      float light = (0.35 + 0.65 * strand) * (0.5 + 0.5 * roundness);
      vec3 c = ropeColor * light * (0.85 + 0.3 * fibre);
      c += vec3(1.0, 0.9, 0.7) * pow(max(strand, 0.0), 8.0) * smoothstep(0.4, -0.6, v) * 0.18;  // a sheen up one side
      c = mix(c, darkColor, smoothstep(0.72, 1.0, abs(v)) * 0.8);                                 // its edges

      if (burnAt >= 0.0) {
        float k = 1.0 - smoothstep(charHalf - 4.0, charHalf, abs(s - burnAt));
        c = mix(c, charColor * (0.6 + 0.6 * strand), k);
        float ember = k * (1.0 - k) * 4.0 * (0.6 + 0.4 * sin(time * 17.0 + s * 0.7));
        c += vec3(1.0, 0.35, 0.05) * ember * strand;
      }

      float a = 1.0 - smoothstep(0.88, 1.0, abs(v));
      return vec4(c, a) * color;
    }
  `);
  return ropeShader;
}

// The rock: hewn stone. A slightly lumpy outline, mottled colour and
// fine grit, a bumpy surface lit from the upper left, bevelled edges, a
// network of cracks, and a dark rim. Quad space: world units from the
// rock's middle, with `pad` to spare round it for the antialiased edge.
const ROCK_PAD = 3;
const ROCK_BEVEL = 7; // world units its edges are rounded over

let rockShader = null;
function getRockShader() {
  if (rockShader) return rockShader;
  rockShader = love.graphics.newShader(NOISE_GLSL + `
    extern vec2 halfSize;
    extern number corner;
    extern number pad;
    extern number bevel;
    extern number seed;
    extern vec3 darkColor;
    extern vec3 lightColor;
    extern vec3 rimColor;

    float sdRect(vec2 p) {
      vec2 q = abs(p) - halfSize + corner;
      return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - corner;
    }

    // How near the nearest crack — the edges between Voronoi cells.
    float crackDist(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      float d1 = 8.0;
      float d2 = 8.0;
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec2 g = vec2(float(x), float(y));
          vec2 o = hash2(i + g + seed);
          float d = length(g + o - f);
          if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
        }
      }
      return d2 - d1;
    }

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec2 p = (uv * 2.0 - 1.0) * (halfSize + pad);

      float d = sdRect(p) + (noise(p * 0.09 + seed) - 0.5) * 2.5;   // a little lumpy
      float aa = max(fwidth(d), 0.001);
      float alpha = 1.0 - smoothstep(-aa, aa, d);
      if (alpha <= 0.0) return vec4(0.0);

      // Its colour: mottled, with fine grit.
      float n = fbm(p * 0.045 + seed);
      float grit = noise(p * 0.35 - seed);
      vec3 base = mix(darkColor, lightColor, n) * (0.88 + 0.24 * grit);

      // Its surface: bumps from noise, and the edges bevelled over.
      float h0 = fbm(p * 0.11 + seed * 1.3);
      float hx = fbm((p + vec2(1.0, 0.0)) * 0.11 + seed * 1.3);
      float hy = fbm((p + vec2(0.0, 1.0)) * 0.11 + seed * 1.3);
      vec2 bump = vec2(hx - h0, hy - h0) * 5.0;
      vec2 grd = vec2(sdRect(p + vec2(0.5, 0.0)) - sdRect(p - vec2(0.5, 0.0)),
                      sdRect(p + vec2(0.0, 0.5)) - sdRect(p - vec2(0.0, 0.5)));
      grd /= max(length(grd), 1e-4);
      float edge = 1.0 - smoothstep(0.0, bevel, -d);
      vec2 nxy = grd * edge * 0.95 - bump;
      float nl = length(nxy);
      if (nl > 0.95) nxy *= 0.95 / nl;
      vec3 N = vec3(nxy, sqrt(1.0 - dot(nxy, nxy)));
      vec3 L = normalize(vec3(-0.45, -0.75, 0.7));
      float light = 0.4 + 0.8 * max(dot(N, L), 0.0);
      vec3 c = base * light;

      // Cracks: dark, with a faint lit lip on one side. (Only some of the
      // cell edges crack — the rest fade out.)
      float cd = crackDist(p * 0.024 + seed * 0.1);
      float mask = smoothstep(0.42, 0.6, noise(p * 0.03 + seed * 2.0)) * smoothstep(1.0, 6.0, -d);
      float crack = (1.0 - smoothstep(0.01, 0.04, cd)) * mask;
      float lip = (smoothstep(0.04, 0.07, cd) - smoothstep(0.07, 0.12, cd)) * mask;
      c *= 1.0 - crack * 0.65;
      c += vec3(0.06) * lip * max(dot(N, L), 0.0);

      // A little darker toward the bottom, and the dark rim.
      c *= mix(1.0, 0.82, smoothstep(-halfSize.y, halfSize.y, p.y));
      c = mix(c, rimColor, smoothstep(-2.5, -0.5, d));
      return vec4(c, alpha) * color;
    }
  `);
  return rockShader;
}

// A 1x1 white pixel: the quad the shaders are drawn on.
let pixelImage = null;
function getPixel() {
  if (pixelImage) return pixelImage;
  const data = love.image.newImageData(1, 1);
  data.setPixel(0, 0, 1, 1, 1, 1);
  pixelImage = love.graphics.newImage(data);
  return pixelImage;
}

class RopeRock {
  // rope, rock: their spawns (world space — see TiledTerrain). level: the
  // Tiled level it's in (its walls and shapes). dome: whose gravity it
  // falls with and floor it lands on, and jump strength its top shares.
  static new(rope, rock, level, dome) {
    return new RopeRock(rope, rock, level, dome);
  }

  constructor(rope, rock, level, dome) {
    this.level = level;
    this.dome = dome;
    this.gravity = (dome && dome.gravityStrength) || FALL_GRAVITY;
    this.top = { x: rope.x + rope.width / 2, y: rope.y }; // where the rope hangs from
    this.ropeLength = Math.max(1, rope.height);
    this.angle = 0;  // the rope's swing (+ = out to the right)
    this.angVel = 0;

    // The rock — pos/vel/halfWidth/halfHeight/radius like a wall tile (it
    // IS one of the level's walls, and Recall moves it by pos/vel).
    this.halfWidth = rock.width / 2;
    this.halfHeight = rock.height / 2;
    this.pos = new Vector2(rock.x + this.halfWidth, rock.y + this.halfHeight);
    this.vel = new Vector2(0, 0);
    this.radius = Math.sqrt(this.halfWidth ** 2 + this.halfHeight ** 2);
    // Its middle, from the end of the rope (as placed).
    this.offX = this.pos.x - this.top.x;
    this.offY = this.pos.y - (this.top.y + this.ropeLength);
    this.hanging = true;
    this.solid = rock.solid;
    // Varies its stone's pattern (and its flame's churn) from the next
    // rock's — from where it was placed, so it's the same every time.
    // (Kept small: the shaders' noise loses precision far from zero.)
    this.seed = lua.mod(rock.x * 0.0137 + rock.y * 0.0291, 7.3);

    if (this.solid) {
      this.wall = { pos: this.pos, halfWidth: this.halfWidth, halfHeight: this.halfHeight, radius: this.radius, isWall: true };
      level.walls.push(this.wall);
      this.surface = TiledTerrain.newMovingSurface(0, 0, 1, 0);
      this.surface.jumpStrength = dome ? dome.jumpStrength : undefined;
      state.planetoids.push(this.surface);
    }
    this.placeSurface();
  }

  // For Recall (see js/systems/Recall.js): whether a point's on the rock.
  containsPoint(x, y) {
    return Math.abs(x - this.pos.x) <= this.halfWidth && Math.abs(y - this.pos.y) <= this.halfHeight;
  }

  placeSurface() {
    if (!this.surface) return;
    const topY = this.pos.y - this.halfHeight;
    this.surface.moveTo(this.pos.x - this.halfWidth, topY, this.pos.x + this.halfWidth, topY);
  }

  // The end of the rope, at the current swing. Returns [x, y].
  ropeEnd() {
    return [this.top.x + Math.sin(this.angle) * this.ropeLength, this.top.y + Math.cos(this.angle) * this.ropeLength];
  }

  // ----------------------------------------------------------------
  // The rope burning
  // ----------------------------------------------------------------

  // Distance from (x, y) to the rope, and how far along it (0 = top,
  // 1 = end). Returns [distance, t].
  distanceToRope(x, y) {
    const [ex, ey] = this.ropeEnd();
    const dx = ex - this.top.x, dy = ey - this.top.y;
    const t = Math.max(0, Math.min(1, ((x - this.top.x) * dx + (y - this.top.y) * dy) / (dx * dx + dy * dy)));
    const px = this.top.x + dx * t, py = this.top.y + dy * t;
    return [Math.sqrt((x - px) ** 2 + (y - py) ** 2), t];
  }

  // Any fireball crossing the rope sets it alight there; any about to go
  // off against the hanging rock sets it rocking, its way.
  checkFireballs(ts) {
    if (!this.burn && !this.burnedAway) {
      let hitT = null;
      alongFireballs(ts, (f, x, y) => {
        const [d, t] = this.distanceToRope(x, y);
        if (d <= ROPE_HIT_REACH + (f.radius ?? 0)) { hitT = t; return true; }
        return false;
      });
      if (hitT !== null) this.burn = { at: hitT, ticks: BURN_TICKS };
    }
    if (this.hanging && this.solid) {
      const f = alongFireballs(ts, (fb, x, y) => {
        const r = fb.radius ?? 0;
        return Math.abs(x - this.pos.x) <= this.halfWidth + r && Math.abs(y - this.pos.y) <= this.halfHeight + r;
      });
      if (f) this.push((f.vel.x >= 0 ? 1 : -1) * SHOT_SPEED);
    }
  }

  // Where it's burning, as a fraction along the rope (null if it isn't)
  // — second value always null (see TileGlow, which lights each flame).
  flameFronts() {
    if (!this.burn) return [null, null];
    return [this.burn.at, null];
  }

  // Returns [x, y].
  flamePoint(t) {
    const [ex, ey] = this.ropeEnd();
    return [this.top.x + (ex - this.top.x) * t, this.top.y + (ey - this.top.y) * t];
  }

  updateBurn(ts) {
    if (!this.burn) return;
    this.burn.ticks -= ts;
    if (this.burn.ticks <= 0) {
      // Burned through: the rope's gone, and the rock with it.
      this.burn = null;
      this.burnedAway = true;
      if (this.hanging) {
        this.hanging = false;
        this.vel.x = 0;
        this.vel.y = 0;
      }
    }
  }

  // ----------------------------------------------------------------
  // Rocking
  // ----------------------------------------------------------------

  // A shove to its swing (radians/tick, + = to the right).
  push(speed) {
    this.angVel += speed;
  }

  // Bob jumping into it from the side or underneath (just touching it,
  // having not been a moment ago — not standing on its top) sets it
  // rocking away from him.
  checkBump() {
    const player = state.player;
    if (!(player && this.solid)) return;
    const onTop = player.onSurface && player.currentPlanet === this.surface;
    const dx = player.pos.x - this.pos.x;
    const nearX = Math.max(0, Math.abs(dx) - this.halfWidth);
    const nearY = Math.max(0, Math.abs(player.pos.y - this.pos.y) - this.halfHeight);
    const touching = !onTop && nearX * nearX + nearY * nearY <= (player.radius + 3) ** 2;
    if (touching && !this.bobTouching) this.push((dx <= 0 ? 1 : -1) * BUMP_SPEED);
    this.bobTouching = touching;
  }

  updateSwing(ts) {
    const steps = Math.max(1, Math.ceil(ts));
    const dt = ts / steps;
    const omega2 = SWING_GRAVITY / this.ropeLength;
    for (let n = 0; n < steps; n++) {
      this.angVel = (this.angVel - omega2 * Math.sin(this.angle) * dt) * SWING_DAMPING ** dt;
      this.angle += this.angVel * dt;
    }
    const limit = MAX_SWING_DEGREES * Math.PI / 180;
    if (Math.abs(this.angle) > limit) {
      this.angle = limit * (this.angle > 0 ? 1 : -1);
      this.angVel = 0;
    }
    // The rock hangs off the end of the rope, level.
    const [ex, ey] = this.ropeEnd();
    this.pos.x = ex + this.offX;
    this.pos.y = ey + this.offY;
  }

  // ----------------------------------------------------------------
  // Falling
  // ----------------------------------------------------------------

  // The highest thing below the rock's bottom edge that it reaches moving
  // from prevBottom down to newBottom: a ledge, the top of a wall
  // (another rock included), or the dome's own floor. null if nothing.
  floorBetween(prevBottom, newBottom) {
    let best = null;
    const deck = this.dome && this.dome.trueSurfaceY ? this.dome.trueSurfaceY() : null;
    if (deck != null && deck >= prevBottom - 0.01 && deck <= newBottom + 0.01) best = deck;
    const xs = [this.pos.x - this.halfWidth + 4, this.pos.x, this.pos.x + this.halfWidth - 4];
    for (const shape of this.level.shapes ?? []) {
      if (shape.findLandingCrossing) {
        for (const x of xs) {
          const hit = shape.findLandingCrossing(x, prevBottom, x, newBottom + 0.01);
          if (hit && hit.point.y >= prevBottom - 0.01 && hit.point.y <= newBottom + 0.01) {
            if (best === null || hit.point.y < best) best = hit.point.y;
          }
        }
      }
    }
    for (const w of this.level.walls ?? []) {
      if (w !== this.wall && w.isWall) {
        const wTop = w.pos.y - w.halfHeight;
        if (Math.abs(w.pos.x - this.pos.x) < w.halfWidth + this.halfWidth - 2
          && wTop >= prevBottom - 0.01 && wTop <= newBottom + 0.01) {
          if (best === null || wTop < best) best = wTop;
        }
      }
    }
    return best;
  }

  updateFall(ts) {
    this.vel.y = Math.min(MAX_FALL_SPEED, this.vel.y + this.gravity * ts);
    const prevBottom = this.pos.y + this.halfHeight;
    let newBottom = prevBottom + this.vel.y * ts;
    const floor = this.vel.y >= 0 ? this.floorBetween(prevBottom, newBottom) : null;
    if (floor !== null) {
      newBottom = floor;
      this.vel.y = 0;
    }
    this.vel.x = 0;
    this.pos.y = newBottom - this.halfHeight;
  }

  // Call once a frame, before the player moves (so he's carried along).
  update(ts) {
    this.checkFireballs(ts);
    this.updateBurn(ts);

    if (this.recalling) {
      // Being rewound (see Recall.js) moves it itself.
      this.wasRecalling = true;
    } else {
      if (this.wasRecalling && this.hanging) {
        // Back from a rewind on its rope: carry on swinging from wherever
        // it was left (as near as the rope allows), at rest.
        this.angle = Math.atan2(this.pos.x - this.offX - this.top.x, this.pos.y - this.offY - this.top.y);
        this.angVel = 0;
      }
      this.wasRecalling = false;
      if (this.hanging) {
        this.checkBump();
        this.updateSwing(ts);
      } else {
        this.updateFall(ts);
      }
    }
    this.placeSurface();
  }

  // ----------------------------------------------------------------
  // Drawing
  // ----------------------------------------------------------------

  drawRope() {
    const [ex, ey] = this.ropeEnd();
    const dx = ex - this.top.x, dy = ey - this.top.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return;
    const dirX = dx / len, dirY = dy / len;
    const perpX = -dirY, perpY = dirX;

    const s = getRopeShader();
    s.send('len', len);
    s.send('width', ROPE_DRAW_WIDTH);
    s.send('pitch', ROPE_PITCH);
    s.send('burnAt', this.burn ? this.burn.at * len : -1);
    s.send('charHalf', CHAR_HALF);
    s.send('time', love.timer.getTime());
    s.send('ropeColor', COLOR_ROPE);
    s.send('darkColor', COLOR_ROPE_DARK);
    s.send('charColor', COLOR_ROPE_CHAR);
    love.graphics.setShader(s);
    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.draw(getPixel(), this.top.x - perpX * ROPE_DRAW_WIDTH / 2, this.top.y - perpY * ROPE_DRAW_WIDTH / 2,
      Math.atan2(dirY, dirX), len, ROPE_DRAW_WIDTH);
    love.graphics.setShader();

    // The flame itself, rising off it (see js/effects/Flame.js).
    if (this.burn) {
      const [fx, fy] = this.flamePoint(this.burn.at);
      const t = love.timer.getTime();
      Flame.draw(fx, fy - 4, 7 * (1 + 0.08 * Math.sin(t * 31)), Math.PI / 2, 1.8, t, this.seed);
    }
  }

  drawRock() {
    const s = getRockShader();
    s.send('halfSize', [this.halfWidth, this.halfHeight]);
    s.send('corner', Math.min(ROCK_CORNER, this.halfWidth, this.halfHeight));
    s.send('pad', ROCK_PAD);
    s.send('bevel', ROCK_BEVEL);
    s.send('seed', this.seed);
    s.send('darkColor', COLOR_ROCK_SPOT);
    s.send('lightColor', COLOR_ROCK_TOP);
    s.send('rimColor', COLOR_ROCK_EDGE);
    love.graphics.setShader(s);
    love.graphics.setColor(1, 1, 1, 1);
    const w = (this.halfWidth + ROCK_PAD) * 2, h = (this.halfHeight + ROCK_PAD) * 2;
    love.graphics.draw(getPixel(), this.pos.x - w / 2, this.pos.y - h / 2, 0, w, h);
    love.graphics.setShader();
  }

  draw() {
    love.graphics.push('all');
    if (!this.burnedAway) this.drawRope();
    this.drawRock();
    love.graphics.pop();
  }
}

export default RopeRock;
