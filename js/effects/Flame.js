// js/effects/Flame.js
//
// A ball of fire, drawn as one quad through a shader — shared by the
// fire bars' fireballs (see js/world/FireBar.js) and Bob's own blaster
// fireballs (see js/entities/Fireball.js), so all the fire in the game
// looks alike.
//
// A ball with turbulent, ragged edges (two layers of scrolling value
// noise), trailing a comet tail behind it (`stretch`: how long — longer
// for faster things). Coloured by "heat": white-hot core, yellow, orange,
// deep red at the ragged edge. Drawn with premultiplied blending, so the
// soft orange halo around it (which writes colour but no alpha) only
// ever brightens what's behind it.

import love from '../love/index.js';

const Flame = {};

// How far (in radii, before stretching) the flame and its glow reach.
const REACH = 2.8;

// Quad space, in flame radii: +x is the direction of travel, the ball's
// centre at (0, 0). xRange/yHalf say how much of that space the quad
// covers (it's shifted back to fit the tail).
let shader = null;
function getShader() {
  if (shader) return shader;
  shader = love.graphics.newShader(`
    extern number time;
    extern number seed;
    extern number stretch;  // tail length, in radii, behind the ball
    extern vec2 xRange;     // quad's x extent (min, max), in radii
    extern number yHalf;    // quad's y half-extent, in radii

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                 mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }
    float fbm(vec2 p) {
      float v = 0.0;
      float a = 0.5;
      for (int k = 0; k < 4; k++) {
        v += a * noise(p);
        p = p * 2.03 + vec2(1.7, 9.2);
        a *= 0.5;
      }
      return v;
    }

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec2 q = vec2(mix(xRange.x, xRange.y, uv.x), (uv.y * 2.0 - 1.0) * yHalf);
      // The tail: the shape stretched out behind, and tapering.
      vec2 s = q;
      if (s.x < 0.0) {
        s.x /= stretch;
        s.y *= 1.0 - s.x * 0.6;
      }
      float d = length(s);
      // The glow is a touch wider than the flame.
      float halo = exp(-d * d * 0.55);

      // Turbulence, flowing back along the tail (+time scrolls it -x).
      float n1 = fbm(vec2(q.x * 0.9 + time * 3.0, q.y * 1.2) + seed);
      float n2 = fbm(vec2(q.x * 1.8 + time * 5.5, q.y * 2.2) - seed);
      float edge = d + (n1 - 0.5) * 1.0 * smoothstep(0.2, 1.0, d) + (n2 - 0.5) * 0.25;
      float heat = clamp(1.0 - edge * 0.85, 0.0, 1.0);

      vec3 c = mix(vec3(0.45, 0.03, 0.0), vec3(0.95, 0.22, 0.02), smoothstep(0.05, 0.35, heat));
      c = mix(c, vec3(1.0, 0.6, 0.1), smoothstep(0.3, 0.6, heat));
      c = mix(c, vec3(1.0, 0.93, 0.6), smoothstep(0.6, 0.85, heat));
      c = mix(c, vec3(1.0), smoothstep(0.85, 1.0, heat));
      float a = smoothstep(0.02, 0.22, heat);

      vec3 g = vec3(1.0, 0.42, 0.08) * halo * 0.6 * (1.0 - a);
      return vec4(c * a + g, a) * color.a;
    }
  `);
  return shader;
}

// A 1x1 white pixel: the quad the shader is drawn on (its texture
// coordinates still run 0..1 across however big it's scaled).
let pixelImage = null;
function getPixel() {
  if (pixelImage) return pixelImage;
  const data = love.image.newImageData(1, 1);
  data.setPixel(0, 0, 1, 1, 1, 1);
  pixelImage = love.graphics.newImage(data);
  return pixelImage;
}

// Draws one flame centred on (x, y), `radius` world units, heading
// along dirAngle (radians) with a tail `stretch` radii long behind it
// (1 = none). time: seconds of animation; seed: any number, so flames
// side by side don't churn in step.
Flame.draw = function (x, y, radius, dirAngle, stretch, time, seed) {
  const s = getShader();
  const xMin = -REACH * stretch, xMax = REACH;
  const mid = (xMin + xMax) / 2 * radius;
  s.send('time', time);
  s.send('seed', seed);
  s.send('stretch', stretch);
  s.send('xRange', [xMin, xMax]);
  s.send('yHalf', REACH);
  love.graphics.push('all');
  love.graphics.setShader(s);
  love.graphics.setBlendMode('alpha', 'premultiplied');
  love.graphics.setColor(1, 1, 1, 1);
  love.graphics.draw(getPixel(),
    x + Math.cos(dirAngle) * mid, y + Math.sin(dirAngle) * mid, dirAngle,
    (xMax - xMin) * radius, REACH * 2 * radius, 0.5, 0.5);
  love.graphics.pop();
};

export default Flame;
