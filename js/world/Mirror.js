// js/world/Mirror.js
//
// A freestanding mirror pane: a framed rectangle that pivots in place
// around its own center, cranked by whichever Crank object(s) in Tiled
// name it via their own "Mirror" custom property (see Crank.js /
// TiledTerrain.js's crankSpawns and main.js's own spawn wiring). Angle
// convention, both in Tiled's "Angle" custom property and here, is
// plain degrees/radians in the rotate() sense (clockwise, since y grows
// downward): 0 = horizontal, 90 = vertical.
//
// Point-placement, same convention as Sphere/Spikey — the object's own
// x/y IS the mirror's own pivot.

import love from '../love/index.js';
import lua from '../love/lua.js';
import state from '../state.js';
import Vector2 from '../vector2.js';

const MIRROR_LENGTH = 90;
const MIRROR_THICKNESS = 10;
const SWING_SPEED = 0.12; // radians per baseline (60fps) tick

const FRAME_INSET = 2.5; // how much frame shows round the glass
const CAP_LENGTH = 7;    // the brass caps on each end
const HUB_RADIUS = 6.5;  // the pivot hub in the middle

const COLOR_OUTLINE = [0.07, 0.07, 0.09];
const COLOR_FRAME_LIGHT = [0.62, 0.64, 0.68]; // the frame, lit along its top...
const COLOR_FRAME_DARK = [0.24, 0.25, 0.28];  // ...and shadowed along its bottom
const COLOR_CAP = [0.78, 0.6, 0.28];          // brass
const COLOR_CAP_LIGHT = [1.0, 0.88, 0.55];

const GLINT_PERIOD = 3.2;  // seconds between glints sweeping along the glass
const GLINT_SECONDS = 0.7; // how long one takes to cross

// The glass: silvered, reflecting a sky — paler toward whichever of its
// faces is turned up, so cranking it round visibly shifts its
// reflection — with faint diagonal streaks fixed in it, a bright
// highlight just inside its top edge, and a glint sweeping along it now
// and then. uv.x runs along the glass, uv.y across it.
let glassShader = null;
function getGlassShader() {
  if (glassShader) return glassShader;
  glassShader = love.graphics.newShader(`
    extern number len;        // world units
    extern number thick;      // world units
    extern number upness;     // -1..1: how far its top face is turned to point up
    extern number glintAt;    // world units along it, or far off it when there's none

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      float s = uv.x * len;
      float v = uv.y * 2.0 - 1.0;   // -1 (top face) .. 1

      // The sky it reflects: bright toward whichever way faces up.
      float sky = 0.5 - 0.5 * v * upness;
      vec3 c = mix(vec3(0.32, 0.46, 0.62), vec3(0.86, 0.94, 1.0), sky);
      c = mix(c, vec3(0.6, 0.72, 0.84), 0.25);

      // Streaks fixed in the glass, on the diagonal.
      float diag = s + v * thick * 0.9;
      float streak = smoothstep(0.75, 1.0, sin(diag * 0.16)) * 0.18
                   + smoothstep(0.9, 1.0, sin(diag * 0.37 + 1.3)) * 0.1;
      c += vec3(streak);

      // The bright line just inside the top edge, and darker at the bottom.
      float e = (v + 0.62) / 0.12;
      c += vec3(0.5) * exp(-e * e);
      c *= mix(1.0, 0.72, smoothstep(0.2, 1.0, v));

      // The sweeping glint, slanted like the streaks.
      float gd = (diag - glintAt) / 3.5;
      float g = exp(-gd * gd);
      c += vec3(1.0, 0.98, 0.9) * g * 0.9;

      return vec4(c, 1.0) * color;
    }
  `);
  return glassShader;
}

let pixelImage = null;
function getPixel() {
  if (pixelImage) return pixelImage;
  const data = love.image.newImageData(1, 1);
  data.setPixel(0, 0, 1, 1, 1, 1);
  pixelImage = love.graphics.newImage(data);
  return pixelImage;
}

// The frame's face: lit along the top, shadowed along the bottom.
let frameMesh = null;
function getFrameMesh() {
  if (frameMesh) return frameMesh;
  const hl = MIRROR_LENGTH / 2, ht = MIRROR_THICKNESS / 2;
  const l = COLOR_FRAME_LIGHT, d = COLOR_FRAME_DARK;
  frameMesh = love.graphics.newMesh([
    [-hl, -ht, 0, 0, l[0], l[1], l[2], 1],
    [hl, -ht, 0, 0, l[0], l[1], l[2], 1],
    [hl, ht, 0, 0, d[0], d[1], d[2], 1],
    [-hl, ht, 0, 0, d[0], d[1], d[2], 1],
  ], 'fan', 'static');
  return frameMesh;
}

class Mirror {
  // x, y: world position of the mirror's own pivot. angleDegrees: its
  // starting angle (Tiled's own "Angle" custom property).
  static new(x, y, angleDegrees) {
    return new Mirror(x, y, angleDegrees);
  }

  constructor(x, y, angleDegrees) {
    this.pos = new Vector2(x, y);
    const angle = (angleDegrees ?? 0) * Math.PI / 180;
    this.angle = angle;
    this.targetAngle = angle;

    // Exposed so CollisionSystem.handleFireballMirrorCollisions can test
    // against this mirror's own rotated extent.
    this.halfLength = MIRROR_LENGTH / 2;
    this.halfThickness = MIRROR_THICKNESS / 2;

    // So neighbouring mirrors don't glint in step.
    this.glintOffset = Math.random() * GLINT_PERIOD;
  }

  // Called by Crank.js on each interact press — bumps the mirror's target
  // angle by stepRadians, eased into place over the following frames.
  crank(stepRadians) {
    this.targetAngle += stepRadians;
  }

  update() {
    const timeScale = state.timeScale ?? 1;
    if (this.angle < this.targetAngle) {
      this.angle = Math.min(this.targetAngle, this.angle + SWING_SPEED * timeScale);
    } else if (this.angle > this.targetAngle) {
      this.angle = Math.max(this.targetAngle, this.angle - SWING_SPEED * timeScale);
    }
  }

  // Drawn in its own rotated space: a steel frame with brass end caps,
  // the silvered glass inset in it, and a bolted hub over its pivot.
  draw() {
    const hl = MIRROR_LENGTH / 2, ht = MIRROR_THICKNESS / 2;
    love.graphics.push('all');
    love.graphics.translate(this.pos.x, this.pos.y);
    love.graphics.rotate(this.angle);
    love.graphics.setLineStyle('smooth');

    // Frame.
    love.graphics.setColor(COLOR_OUTLINE);
    love.graphics.rectangle('fill', -hl - 1.5, -ht - 1.5, MIRROR_LENGTH + 3, MIRROR_THICKNESS + 3, 3, 3);
    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.draw(getFrameMesh());

    // Glass.
    const glassLen = MIRROR_LENGTH - (CAP_LENGTH + FRAME_INSET) * 2;
    const glassThick = MIRROR_THICKNESS - FRAME_INSET * 2;
    const now = love.timer.getTime() + this.glintOffset;
    const glintT = lua.mod(now, GLINT_PERIOD) / GLINT_SECONDS; // 0..1 while it's crossing
    const glintAt = glintT <= 1 ? (-15 + glintT * (glassLen + 30)) : -1000;
    const s = getGlassShader();
    s.send('len', glassLen);
    s.send('thick', glassThick);
    // Its top face's normal is (sin, -cos) of its angle: how much that
    // points up the screen.
    s.send('upness', Math.cos(this.angle));
    s.send('glintAt', glintAt);
    love.graphics.setShader(s);
    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.draw(getPixel(), -glassLen / 2, -glassThick / 2, 0, glassLen, glassThick);
    love.graphics.setShader();
    love.graphics.setColor(COLOR_OUTLINE[0], COLOR_OUTLINE[1], COLOR_OUTLINE[2], 0.6);
    love.graphics.setLineWidth(1);
    love.graphics.rectangle('line', -glassLen / 2, -glassThick / 2, glassLen, glassThick);

    // Brass end caps.
    for (const side of [-1, 1]) {
      const cx = side > 0 ? (hl - CAP_LENGTH) : -hl;
      love.graphics.setColor(COLOR_CAP);
      love.graphics.rectangle('fill', cx, -ht, CAP_LENGTH, MIRROR_THICKNESS, 2, 2);
      love.graphics.setColor(COLOR_CAP_LIGHT);
      love.graphics.rectangle('fill', cx + 1, -ht + 1, CAP_LENGTH - 2, 2);
      love.graphics.setColor(COLOR_OUTLINE[0], COLOR_OUTLINE[1], COLOR_OUTLINE[2], 0.7);
      love.graphics.rectangle('line', cx, -ht, CAP_LENGTH, MIRROR_THICKNESS, 2, 2);
    }

    // Pivot hub: a bolt, its slot turning with the mirror.
    love.graphics.setColor(COLOR_OUTLINE);
    love.graphics.circle('fill', 0, 0, HUB_RADIUS + 1.5);
    love.graphics.setColor(COLOR_FRAME_DARK);
    love.graphics.circle('fill', 0, 0, HUB_RADIUS);
    love.graphics.setColor(COLOR_FRAME_LIGHT);
    love.graphics.circle('fill', -0.8, -0.8, HUB_RADIUS * 0.7);
    love.graphics.setColor(COLOR_OUTLINE);
    love.graphics.setLineWidth(1.6);
    love.graphics.line(-HUB_RADIUS * 0.5, 0, HUB_RADIUS * 0.5, 0);

    love.graphics.pop();

    // The glint's sparkle, travelling along with it — in world space, so
    // the star stands upright however the mirror's turned.
    if (glintT <= 1) {
      const k = Math.sin(glintT * Math.PI);
      const along = glintAt - glassLen / 2;
      const c = Math.cos(this.angle), sn = Math.sin(this.angle);
      const x = this.pos.x + c * along, y = this.pos.y + sn * along;
      love.graphics.push('all');
      love.graphics.setBlendMode('add');
      love.graphics.setLineStyle('smooth');
      love.graphics.setColor(1, 1, 0.92, 0.7 * k);
      love.graphics.setLineWidth(1.5);
      const r = 9 * k;
      love.graphics.line(x - r, y, x + r, y);
      love.graphics.line(x, y - r, x, y + r);
      love.graphics.setColor(1, 1, 0.92, 0.35 * k);
      love.graphics.circle('fill', x, y, 3 * k);
      love.graphics.pop();
    }
  }
}

export default Mirror;
