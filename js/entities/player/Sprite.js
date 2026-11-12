// js/entities/player/Sprite.js
//
// Bob drawn from sprite sheets made from img/astronaut2.svg: posed and
// normal-mapped by tools/arm-animator.html, exported by
// tools/bob-sprite-export.html (which also measured the numbers in DATA
// below — re-export and paste them in whenever the drawing changes).
//
//   img/bob-sprite.png         his body, no arms: walk frames 1-6 (legs,
//                              buckle and bob), standing (frame 7), then
//                              in the air, legs wide (frame 8)
//   img/bob-sprite_normal.png  their normal maps
//   img/bob-arms.png           his arms as they hang standing: "Right Arm"
//                              (in front of him), "Left Arm" (behind him)
//                              and "Left Arm - Blaster" (in the left arm's
//   img/bob-arms_normal.png    place, while he aims), and their normal maps
//
// Every frame and every arm sits in the same frame box, so they line up as
// they are. The arms are turned round their shoulders: swinging as he
// walks, the right one forward as the left leg goes forward and back, the
// left one the other way. Mega Man rules: he only has the blaster arm out
// while he's aiming or shooting (see Rendering.js's drawSprite).
//
// His pupils aren't in the pictures: they're drawn here, looking where he's
// aiming (the way the arm animator's follow the mouse).
//
// Lit by the sun from the normal maps, the same lighting the Ooombas get
// (see Ooomba.js, and the arm animator's defaults).
// Port of lua/entities/player/Sprite.lua.

import love from '../../love/index.js';
import state from '../../state.js';

const Sprite = {};

// From tools/bob-sprite-export.html (pixels, in one frame).
const DATA = {
  frameW: 247, frameH: 321,
  walkFrames: 6, standFrame: 7, airFrame: 8,
  centerX: 89.3,                // the middle of his body, across
  soleY: 306, topY: 6,          // his soles, and the top of his antenna (standing)
  // How far all of him has dropped in each frame (his legs angled), so the
  // arms and pupils go down with him. (Frames counted from 1.)
  drop: [null, 5.7, 3.7, 0.5, 0.5, 3.7, 5.7, 0, 0],
  rightShoulder: { x: 46.3, y: 178.6 },    // what each arm turns round
  leftShoulder: { x: 126.1, y: 176.4 },
  blasterShoulder: { x: 128.2, y: 180.9 },
  muzzle: { x: 235.6, y: 160.7 },          // where the blaster's shots come out
  // His pupils, standing: where, their size, and how far they can move (to
  // the edge of the eye).
  eyes: [
    { x: 85.5, y: 114.5, rx: 3.5, ry: 5.9, travelX: 13.5, travelY: 21.1 },
    { x: 107, y: 108.4, rx: 2.9, ry: 5.7, travelX: 11.3, travelY: 19.8 },
  ],
  irisColor: [0, 0, 0],
};
Sprite.DATA = DATA;

// How tall he's drawn, soles to the top of his antenna (world units).
Sprite.HEIGHT = 150;
Sprite.SCALE = Sprite.HEIGHT / (DATA.soleY - DATA.topY);
// The posable rig (Rendering.js's wall slide, ground pound, curling into a
// ball) is built in the old rig's units, where standing he's 134.95 world
// units tall: drawn this much bigger, to match.
Sprite.RIG_SCALE = Sprite.HEIGHT / 134.95;

// The walk: frames 1 to 6 and back (the arm animator's ping-pong), once
// every WALK_CYCLE_STRIDES strides (his walkTime goes round 2*pi each
// stride: see Movement.js). Higher is a slower walk.
const WALK_SEQUENCE = [1, 2, 3, 4, 5, 6, 5, 4, 3, 2];
const WALK_CYCLE_STRIDES = 2;
// In the air: the air frame (legs wide), and both arms up: his right one (on
// his back side) up behind him, his left one up in front, this far round
// from hanging (radians) on the way up, and higher on the way down, easing
// between the two from rising at FALL_SPEED to falling at it (world units a
// tick).
const AIR_ARM_RISING = 1.9;
const AIR_ARM_FALLING = 2.6;
const FALL_SPEED = 5;
// How far his arms swing either way as he walks (radians).
const ARM_SWING = 0.45;
// Standing idle, a subtle sway: his arms drifting either way this far
// (radians), a little out of step with each other, and him breathing —
// stretching up from his soles by this fraction of his height and back. How
// fast each goes round (radians a second).
const IDLE_ARM_SWAY = 0.07, IDLE_ARM_SPEED = 1.6;
const IDLE_BREATH = 0.012, IDLE_BREATH_SPEED = 2.1;
// How far his pupils follow where he's aiming: 1 = right to the edge of
// the eye.
const EYE_FOLLOW = 0.5;

// The blaster arm's own direction as drawn, shoulder to muzzle (radians,
// image space: y down).
Sprite.ARM_REST_ANGLE = Math.atan2(DATA.muzzle.y - DATA.blasterShoulder.y, DATA.muzzle.x - DATA.blasterShoulder.x);

const LIGHTING = {
  shadingStrength: 0.7, // how much of all this shows: 0 = the plain art, 1 = full lighting
  ambient: 0.42,        // brightness with no sunlight on it at all
  diffuse: 0.72,        // added where the surface faces the sun full on
  specular: 0.55,       // the glossy highlight's strength...
  shininess: 36,        // ...and tightness (higher: smaller, sharper)
  rimLight: 0.9,        // the reflected light on the edge away from the sun (0: none)...
  rimWidth: 1.8,        // ...and how tightly it hugs the edge (higher: thinner)
  sunElevation: 0.5,    // how much the sun also lights him from the front (0: purely from the side)
};

let images;  // undefined: not tried yet; null: missing
let bodyQuads = null, armQuads = null;
const RIGHT_ARM = 0, LEFT_ARM = 1, BLASTER_ARM = 2;

// The sheets, loaded the first time they're needed (null if they're missing).
function getImages() {
  if (images !== undefined) return images;
  try {
    const load = (path) => {
      const img = love.graphics.newImage(path, { mipmaps: true });
      img.setFilter('linear', 'linear');
      img.setMipmapFilter('linear');
      return img;
    };
    images = {
      body: load('img/bob-sprite.png'),
      bodyNormal: load('img/bob-sprite_normal.png'),
      arms: load('img/bob-arms.png'),
      armsNormal: load('img/bob-arms_normal.png'),
    };
  } catch (e) {
    console.warn("Sprite.js: couldn't load Bob's sprite sheets - drawing the old rig instead.", e);
    images = null;
  }
  return images;
}

// A quad for each frame across the sheet (list[0] is the first).
function makeQuads(img, count) {
  const [sw, sh] = img.getDimensions();
  const list = [];
  for (let i = 0; i < count; i++) list.push(love.graphics.newQuad(i * DATA.frameW, 0, DATA.frameW, DATA.frameH, sw, sh));
  return list;
}

Sprite.available = function () {
  return getImages() !== null;
};

// -> [frame, rightAngle, leftAngle, breath]: which frame of the body he's
// in right now (counted from 1), how far his right and left arms are turned
// from hanging (positive: the hand goes back), and how much he's breathing
// in (see Sprite.draw). Walking, the arms swing opposite ways: the right
// one back as his right leg goes forward. Standing, they sway a little.
// upSpeed: how fast he's going up (negative: coming down), for his arms in
// the air — and his eyes, which look up on the way up and down on the way
// down: in the air, a fifth result, how far up (-1) or down (1) they look
// (null on the ground).
Sprite.pose = function (player, upSpeed) {
  if (!player.onSurface) {
    let falling = Math.max(0, Math.min(1, (FALL_SPEED - (upSpeed ?? 0)) / (2 * FALL_SPEED)));
    falling = falling * falling * (3 - 2 * falling);
    const raise = AIR_ARM_RISING + (AIR_ARM_FALLING - AIR_ARM_RISING) * falling;
    return [DATA.airFrame, raise, -raise, 0, 2 * falling - 1];
  }
  if (!player.isWalking) {
    const t = love.timer.getTime();
    return [DATA.standFrame,
      IDLE_ARM_SWAY * Math.sin(t * IDLE_ARM_SPEED),
      IDLE_ARM_SWAY * Math.sin(t * IDLE_ARM_SPEED + 1.3),
      IDLE_BREATH * Math.sin(t * IDLE_BREATH_SPEED)];
  }
  const turns = player.walkTime / (2 * Math.PI * WALK_CYCLE_STRIDES);
  const phase = turns - Math.floor(turns);
  // How far along frames 1 to 6 he is, 0 to 1 and back.
  const along = 1 - Math.abs(1 - 2 * phase);
  const swing = ARM_SWING * Math.cos(Math.PI * along);
  return [WALK_SEQUENCE[Math.floor(phase * WALK_SEQUENCE.length)], swing, -swing, 0];
};

let shader = null;
function getShader() {
  if (shader) return shader;
  shader = love.graphics.newShader(`
    extern Image normalMap;
    extern vec3 lightDir;   // toward the sun, in the image's own frame (x right, y up, z toward the viewer)
    extern float ambient;
    extern float diffuse;
    extern float specular;
    extern float shininess;
    extern float rimLight;
    extern float rimWidth;
    extern float shadingStrength;

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec4 texel = Texel(tex, uv) * color;
      vec4 nt = Texel(normalMap, uv);
      if (nt.a < 0.01) return texel;
      vec3 n = normalize(nt.rgb * 2.0 - 1.0);
      float facing = max(dot(n, lightDir), 0.0);
      vec3 halfway = normalize(lightDir + vec3(0.0, 0.0, 1.0));
      float shine = pow(max(dot(n, halfway), 0.0), shininess) * specular;

      // Reflected light round the edge away from the sun.
      float edge = pow(1.0 - clamp(n.z, 0.0, 1.0), rimWidth);
      float away = 0.0;
      if (length(n.xy) > 1e-4 && length(lightDir.xy) > 1e-4) {
        away = max(dot(normalize(n.xy), -normalize(lightDir.xy)), 0.0);
      }
      float rim = edge * away * rimLight;

      vec3 lit = texel.rgb * (ambient + diffuse * facing)
        + mix(texel.rgb, vec3(1.0), 0.35) * rim
        + vec3(1.0, 0.98, 0.92) * shine * texel.a;
      vec3 rgb = mix(texel.rgb, lit, shadingStrength);
      return vec4(min(rgb, vec3(1.0)), texel.a);
    }
  `);
  for (const name of ['ambient', 'diffuse', 'specular', 'shininess', 'rimLight', 'rimWidth', 'shadingStrength']) {
    shader.send(name, LIGHTING[name]);
  }
  return shader;
}

// Turns the lighting on for the next image drawn, if nothing else has a
// shader on (the silhouette glow, the shadows and the portals draw him
// under shaders of their own, which this mustn't replace). The image is
// drawn turned `rotation`, mirrored if `flipped`, and then (inside that)
// turned `extra` more: the sun's direction is taken back through all of
// that into the image's own frame. Returns whether it turned it on.
function light(x, y, normalMap, rotation, flipped, extra) {
  if (love.graphics.getShader()) return false;
  let toSunX = (state.sceneWidth ?? 0) / 2 - x;
  let toSunY = (state.sceneHeight ?? 0) / 2 - y;
  const dist = Math.sqrt(toSunX * toSunX + toSunY * toSunY);
  if (dist < 1) return false;
  toSunX /= dist; toSunY /= dist;
  let c = Math.cos(-rotation), s = Math.sin(-rotation);
  let lx = c * toSunX - s * toSunY, ly = s * toSunX + c * toSunY;
  if (flipped) lx = -lx;
  c = Math.cos(-extra); s = Math.sin(-extra);
  [lx, ly] = [c * lx - s * ly, s * lx + c * ly];
  ly = -ly; // (the map's y is up)
  const lz = LIGHTING.sunElevation;
  const len = Math.sqrt(lx * lx + ly * ly + lz * lz);
  const sh = getShader();
  sh.send('normalMap', normalMap);
  sh.send('lightDir', [lx / len, ly / len, lz / len]);
  love.graphics.setShader(sh);
  return true;
}

// The same, for an image about to be drawn (unturned, unmirrored) under
// whatever transform is set right now: how it's turned and mirrored is read
// from the transform itself. (The posable rig's parts: see Rendering.js's
// drawRigImage.) (x, y): where it is in the world.
Sprite.lightHere = function (x, y, normalMap) {
  if (love.graphics.getShader()) return false;
  const toSunX = (state.sceneWidth ?? 0) / 2 - x;
  const toSunY = (state.sceneHeight ?? 0) / 2 - y;
  const dist = Math.sqrt(toSunX * toSunX + toSunY * toSunY);
  if (dist < 1) return false;
  // Where the image's own x and y axes point on screen (the camera only
  // moves and zooms, so that's the way they point in the world too).
  const [ox, oy] = love.graphics.transformPoint(0, 0);
  let [ax, ay] = love.graphics.transformPoint(1, 0);
  let [bx, by] = love.graphics.transformPoint(0, 1);
  ax -= ox; ay -= oy; bx -= ox; by -= oy;
  const det = ax * by - bx * ay;
  if (Math.abs(det) < 1e-12) return false;
  // The sun's direction in those axes.
  let lx = (by * toSunX - bx * toSunY) / det;
  let ly = (-ay * toSunX + ax * toSunY) / det;
  const flat = Math.sqrt(lx * lx + ly * ly);
  if (flat < 1e-9) return false;
  lx /= flat; ly = -ly / flat; // (the map's y is up)
  const lz = LIGHTING.sunElevation;
  const len = Math.sqrt(1 + lz * lz);
  const sh = getShader();
  sh.send('normalMap', normalMap);
  sh.send('lightDir', [lx / len, ly / len, lz / len]);
  love.graphics.setShader(sh);
  return true;
};

// Where a point of the frame (px, py) is in the world, with him standing
// with his soles at (feetX, feetY), turned `rotation`, facing dirSign.
Sprite.toWorld = function (px, py, feetX, feetY, rotation, dirSign) {
  const lx = (px - DATA.centerX) * Sprite.SCALE * dirSign;
  const ly = (py - DATA.soleY) * Sprite.SCALE;
  const c = Math.cos(rotation), s = Math.sin(rotation);
  return [feetX + lx * c - ly * s, feetY + lx * s + ly * c];
};

// Where the blaster arm's shoulder is in the world, in body frame `frame`.
Sprite.blasterShoulder = function (frame, feetX, feetY, rotation, dirSign) {
  const sh = DATA.blasterShoulder;
  return Sprite.toWorld(sh.x, sh.y + DATA.drop[frame], feetX, feetY, rotation, dirSign);
};

// Where the blaster's muzzle is, from its shoulder, with the arm turned
// armAngle (world units).
Sprite.muzzleOffset = function (rotation, dirSign, armAngle) {
  let dx = DATA.muzzle.x - DATA.blasterShoulder.x, dy = DATA.muzzle.y - DATA.blasterShoulder.y;
  let c = Math.cos(armAngle), s = Math.sin(armAngle);
  [dx, dy] = [dx * c - dy * s, dx * s + dy * c];
  dx *= Sprite.SCALE * dirSign; dy *= Sprite.SCALE;
  c = Math.cos(rotation); s = Math.sin(rotation);
  return [dx * c - dy * s, dx * s + dy * c];
};

// One arm (RIGHT_ARM, LEFT_ARM or BLASTER_ARM), turned `angle` round its
// shoulder, in body frame `frame`. (Inside Sprite.draw's transform.)
function drawArm(imgs, which, shoulder, angle, frame, feetX, feetY, rotation, flipped) {
  const g = love.graphics;
  g.push();
  g.translate(shoulder.x - DATA.centerX, shoulder.y + DATA.drop[frame] - DATA.soleY);
  g.rotate(angle);
  const lit = light(feetX, feetY, imgs.armsNormal, rotation, flipped, angle);
  g.draw(imgs.arms, armQuads[which], 0, 0, 0, 1, 1, shoulder.x, shoulder.y);
  if (lit) g.setShader();
  g.pop();
}

// Draws him: soles at (feetX, feetY), turned `rotation` (0 = upright),
// facing dirSign (1 right, -1 left), in body frame `frame`, his arms turned
// rightAngle and leftAngle (see Sprite.pose). blasterAngle: null for his
// ordinary left arm, or the blaster arm in its place, turned that far round
// its shoulder (0 = as drawn). (lookX, lookY): which way his pupils look, in
// the picture's own frame (x forward, y down), up to a unit vector (0, 0:
// straight ahead). breath: how much taller he's drawn, stretched up from
// his soles (a fraction: see Sprite.pose).
Sprite.draw = function (feetX, feetY, rotation, dirSign, frame, rightAngle, leftAngle, blasterAngle, lookX, lookY, breath) {
  const imgs = getImages();
  if (!imgs) return;
  bodyQuads ??= makeQuads(imgs.body, DATA.airFrame);
  armQuads ??= makeQuads(imgs.arms, 3);
  const flipped = dirSign < 0;
  const g = love.graphics;

  g.push();
  g.translate(feetX, feetY);
  g.rotate(rotation);
  g.scale(Sprite.SCALE * dirSign, Sprite.SCALE * (1 + (breath ?? 0)));
  g.setColor(1, 1, 1, 1);

  // Behind him: his left arm, or the blaster arm in its place.
  if (blasterAngle != null) {
    drawArm(imgs, BLASTER_ARM, DATA.blasterShoulder, blasterAngle, frame, feetX, feetY, rotation, flipped);
  } else {
    drawArm(imgs, LEFT_ARM, DATA.leftShoulder, leftAngle, frame, feetX, feetY, rotation, flipped);
  }

  const lit = light(feetX, feetY, imgs.bodyNormal, rotation, flipped, 0);
  g.draw(imgs.body, bodyQuads[frame - 1], 0, 0, 0, 1, 1, DATA.centerX, DATA.soleY);
  if (lit) g.setShader();

  // His pupils, looking where he's aiming.
  g.setColor(DATA.irisColor[0], DATA.irisColor[1], DATA.irisColor[2], 1);
  for (const e of DATA.eyes) {
    g.ellipse('fill',
      e.x - DATA.centerX + lookX * e.travelX * EYE_FOLLOW,
      e.y + DATA.drop[frame] - DATA.soleY + lookY * e.travelY * EYE_FOLLOW,
      e.rx, e.ry);
  }
  g.setColor(1, 1, 1, 1);

  // In front of him: his right arm.
  drawArm(imgs, RIGHT_ARM, DATA.rightShoulder, rightAngle, frame, feetX, feetY, rotation, flipped);

  g.pop();
};

export default Sprite;
