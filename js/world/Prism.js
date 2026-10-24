// js/world/Prism.js
//
// A tall crystal prism (img/mining.png, state.miningTexture — and
// state.miningDamagedTextures, the same prism more and more broken, as
// its cluster is shot) sticking out of a planetoid. Purely scenery: no
// collision of its own, he walks straight past in front of it.
//
// Its foot is SUNK below the planetoid's surface and the whole thing is
// drawn BEFORE the planetoid (see main.js's love.draw), so the
// planetoid's own body covers the bottom of it and it reads as planted
// in the ground rather than balanced on top.
//
// Prisms differ in how much of them shows, never in scale: a shorter
// prism is the same image with more of its BOTTOM cut off (the pointed
// top is always whole).

import love from '../love/index.js';
import lua from '../love/lua.js';
import state from '../state.js';

// The prism's actual shape, measured off img/mining.png — it doesn't
// fill the image it's in. x as a fraction of the image's width, y of its
// height (0,0 is the top left corner).
const SHAPE_LEFT_X = 0.019;     // its left side
const SHAPE_RIGHT_X = 0.976;    // its right side
const SHAPE_APEX_X = 0.519;     // the very tip
const SHAPE_APEX_Y = 0.018;
const SHAPE_SHOULDER_Y = 0.175; // where the straight sides end and the point begins

// What a shot can actually hit, from the same shape.
const BODY_WIDTH_FRACTION = SHAPE_RIGHT_X - SHAPE_LEFT_X;
const TIP_HEIGHT_FRACTION = SHAPE_SHOULDER_Y - SHAPE_APEX_Y;

// How deep the foot has to go for both of its corners to stay hidden
// inside the planetoid: a prism standing straight needs little, a
// leaning one swings a corner back up toward the surface and needs more.
// Worked out in the frame where the planetoid's center is the origin and
// the prism leaves the surface at (radius, 0).
function sinkDepthFor(radius, halfWidth, tilt, minSink) {
  const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
  const limit = radius - Prism.SINK_MARGIN;
  let sink = minSink;
  while (sink < radius) {
    const footX = radius - sink * cosT, footY = -sink * sinT;
    let hidden = true;
    for (const side of [-1, 1]) {
      const cx = footX - side * halfWidth * sinT, cy = footY + side * halfWidth * cosT;
      if (cx * cx + cy * cy > limit * limit) hidden = false;
    }
    if (hidden) break;
    sink += 2;
  }
  return sink;
}

function randomIn(range) {
  return range[0] + Math.random() * (range[1] - range[0]);
}

// The halo round a prism that's been hit: light that ADDS to whatever
// is behind it, brightest against the prism's edge and fading to
// nothing HIT_HALO_REACH out from it — measured from the prism's real
// outline (its two straight sides and the two slopes of its point),
// worked out in the shader as the distance to that shape. Drawn on a
// piece of the image with empty space added round it (see haloQuad) —
// uv simply runs on past 0..1 there. p is the pixel in prism-widths.
let haloShader = null;
function getHaloShader() {
  if (haloShader) return haloShader;
  haloShader = love.graphics.newShader(`
    extern vec3 haloColor;
    extern float strength;
    extern float reach;      // prism-widths
    extern float aspect;     // the image's height / width
    extern float leftX;
    extern float rightX;
    extern float apexX;
    extern float apexY;
    extern float shoulderY;

    // Distance from p to the segment a-b.
    float toSegment(vec2 p, vec2 a, vec2 b) {
      vec2 ab = b - a;
      float t = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0);
      return length(p - a - ab * t);
    }

    // Which side of the line a->b the point is on (positive: its left).
    float side(vec2 p, vec2 a, vec2 b) {
      return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    }

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec2 p = vec2(uv.x, uv.y * aspect);
      float far = 1000.0;
      vec2 bottomLeft = vec2(leftX, far);
      vec2 shoulderLeft = vec2(leftX, shoulderY * aspect);
      vec2 apex = vec2(apexX, apexY * aspect);
      vec2 shoulderRight = vec2(rightX, shoulderY * aspect);
      vec2 bottomRight = vec2(rightX, far);

      float d = min(min(toSegment(p, bottomLeft, shoulderLeft), toSegment(p, shoulderLeft, apex)),
                    min(toSegment(p, apex, shoulderRight), toSegment(p, shoulderRight, bottomRight)));
      // Inside it (the same side of all four edges, going round): no distance at all.
      if (side(p, bottomLeft, shoulderLeft) > 0.0 && side(p, shoulderLeft, apex) > 0.0
          && side(p, apex, shoulderRight) > 0.0 && side(p, shoulderRight, bottomRight) > 0.0) {
        d = 0.0;
      }

      float fade = 1.0 - clamp(d / reach, 0.0, 1.0);
      return vec4(haloColor, fade * fade * strength) * color;
    }
  `);
  return haloShader;
}

// Sun shading. img/mining.png is painted as a key, not in its final
// colors: the faces on the prism's LEFT side are pure blue, the ones on
// its RIGHT pure red, outlined in black. The shader repaints both sides
// red, each in its own shade — from which of the two sides is turned
// toward the sun (see faceColors below). Pixels are sorted by how blue
// vs. how red they are, so the soft edge between two faces blends. The
// black outlines become a dark shade of the face they border.
//
// It also applies the base-to-tip gradient (see Prism.BASE_BRIGHTNESS):
// surfaceV is how far down the image this prism meets the ground.
//
// And the glass:
//   rim    A heavily blurred copy of the image (a small mipmap of it, via
//          Texel's bias) thins out near any outline or silhouette — so
//          "how thin" is "how close to an edge", and that's where the
//          rim light goes.
//   sheen  A wide band and a thin one, slanted across the prism and
//          repeating along it; sheenShift slides them along.
//   core   Brightest on the prism's center line, gone by its sides.
// The flat of a face is slightly see-through; wherever one of those
// lights or an outline falls, it's solid again.
//
// And being shot: hitGlow brightens the glass, most along its edges and
// down its middle; hitFlash then pushes the whole thing toward hitColor.
let faceShader = null;
function getFaceShader() {
  if (faceShader) return faceShader;
  faceShader = love.graphics.newShader(`
    extern vec3 leftColor;
    extern vec3 rightColor;
    extern float leftLit;        // 0..1: how squarely each side faces the sun
    extern float rightLit;
    extern float surfaceV;
    extern float baseBrightness;
    extern float faceOpacity;
    extern float outlineBrightness;
    extern vec3 glintColor;
    extern float rimStrength;
    extern float rimWidth;
    extern float sheenStrength;
    extern float sheenSpacing;
    extern float sheenSlant;
    extern float sheenShift;
    extern float coreStrength;
    extern float aspect;         // the image's height / width
    extern vec3 hitColor;
    extern float hitFlash;       // 0..1, already scaled by its strength
    extern float hitGlow;

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec4 texel = Texel(tex, uv);
      float leftness = texel.b / max(texel.b + texel.r, 0.0001);
      vec3 face = mix(rightColor, leftColor, leftness);
      float lit = mix(rightLit, leftLit, leftness);
      float ink = max(texel.b, texel.r); // 0 on the outlines

      float up = clamp(1.0 - uv.y / surfaceV, 0.0, 1.0); // 0 at the ground, 1 at the tip
      float brightness = mix(baseBrightness, 1.0, up);
      vec3 body = face * brightness;

      vec4 soft = Texel(tex, uv, rimWidth);
      float rim = smoothstep(0.0, 0.6, 1.0 - max(soft.b, soft.r) * soft.a);

      float along = fract((uv.x + uv.y * aspect * sheenSlant) / sheenSpacing + sheenShift);
      float sheen = smoothstep(0.0, 0.03, along) * (1.0 - smoothstep(0.12, 0.15, along))
        + 0.6 * smoothstep(0.20, 0.215, along) * (1.0 - smoothstep(0.235, 0.25, along));

      float core = 1.0 - smoothstep(0.0, 0.5, abs(uv.x - 0.5));

      float glint = (rim * rimStrength + sheen * sheenStrength + core * coreStrength)
        * (0.35 + 0.65 * lit) * brightness;

      vec3 rgb = body * mix(outlineBrightness, 1.0, ink) + glintColor * glint * mix(0.4, 1.0, ink);
      float opacity = mix(faceOpacity, 1.0, clamp(glint * 1.5 + (1.0 - ink), 0.0, 1.0));

      rgb += hitColor * hitGlow * (0.25 + 0.6 * rim + 0.4 * core);
      rgb = mix(rgb, hitColor, hitFlash);
      opacity = mix(opacity, 1.0, max(hitFlash, hitGlow * 0.6));
      return vec4(rgb, texel.a * opacity) * color;
    }
  `);
  return faceShader;
}

// The colors for the left and right faces of a prism whose own "right"
// points along rightX, rightY, standing at x, y. A side turned squarely
// at the sun gets LIT_COLOR, one turned squarely away SHADOW_COLOR, and
// anything between is a blend. Returns [left, right, leftLit, rightLit].
function faceColors(x, y, rightX, rightY) {
  let facing = 0; // 1: the right side faces the sun dead on; -1: the left side does
  const sun = state.sun;
  if (sun && sun.pos) {
    const dx = sun.pos.x - x, dy = sun.pos.y - y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 0) facing = (dx * rightX + dy * rightY) / dist;
  }
  const lit = Prism.LIT_COLOR, shadow = Prism.SHADOW_COLOR;
  const shade = (t) => [ // t: 0 fully in shadow, 1 fully lit
    shadow[0] + (lit[0] - shadow[0]) * t,
    shadow[1] + (lit[1] - shadow[1]) * t,
    shadow[2] + (lit[2] - shadow[2]) * t,
  ];
  const leftLit = 0.5 - 0.5 * facing, rightLit = 0.5 + 0.5 * facing;
  return [shade(leftLit), shade(rightLit), leftLit, rightLit];
}

class Prism {
  // planet: the planetoid it stands on. angle: where round it (radians,
  // same convention as the player's own angle — -pi/2 is the top).
  //
  // options (all optional):
  //   tilt    radians it leans away from standing straight out of the
  //           surface (positive leans clockwise). 0 by default.
  //   length  world units of it showing above the surface. As much as the
  //           image allows by default, and never more than that.
  //   size    how big the whole prism is drawn, as a fraction of the
  //           ordinary size. 1 by default.
  static new(planet, angle, options) {
    return new Prism(planet, angle, options);
  }

  constructor(planet, angle, options = {}) {
    this.planet = planet;
    this.angle = angle ?? -Math.PI / 2;
    this.tilt = options.tilt ?? 0;
    // Where along it its bands of sheen fall — taken from where it
    // stands, so each prism's are somewhere different.
    this.sheenShift = lua.mod(this.angle * 7.31, 1);

    const img = state.miningTexture;
    const [imgW, imgH] = img.getDimensions();
    this.size = options.size ?? 1;
    const fullHeight = Prism.FULL_HEIGHT * this.size;
    this.scale = fullHeight / imgH;
    const sink = sinkDepthFor(planet.radius, imgW * this.scale / 2, this.tilt, Prism.MIN_SINK * this.size);
    this.length = Math.min(options.length ?? fullHeight, fullHeight - sink);

    // The top of the image, down as far as the sunken foot. lengthPx is
    // where the surface crosses it.
    this.lengthPx = this.length / this.scale;
    this.quad = love.graphics.newQuad(0, 0, imgW, (this.length + sink) / this.scale, imgW, imgH);

    // The same piece with empty space added round its sides and top, for
    // the halo to spread into when it's hit.
    this.haloPadPx = imgW * Prism.HIT_HALO_REACH;
    this.haloQuad = love.graphics.newQuad(-this.haloPadPx, -this.haloPadPx,
      imgW + this.haloPadPx * 2, (this.length + sink) / this.scale + this.haloPadPx, imgW, imgH);

    // For containsPoint.
    this.halfWidth = imgW * this.scale * BODY_WIDTH_FRACTION / 2;
    this.tipHeight = Math.min(fullHeight * TIP_HEIGHT_FRACTION, this.length);

    // What lights up together when any one of them is shot. hitAge:
    // seconds since it was last hit, null if not lit. hits: how many
    // times it's been hit in all.
    this.group = { prisms: [this], hitAge: null, hits: 0 };
  }

  // One cluster of prisms round `planet`, its tall middle prism standing
  // at `angle` — see Prism.CLUSTER_RINGS. Returned in drawing order: the
  // tall one first, then each ring out from it.
  static cluster(planet, angle) {
    const center = Prism.new(planet, angle, { length: randomIn(Prism.CLUSTER_CENTER_LENGTH) });
    const prisms = [center];

    // The prisms of the ring before, per side (-1, 1).
    let inner = { [-1]: [center], [1]: [center] };
    for (const ring of Prism.CLUSTER_RINGS) {
      const placed = { [-1]: [], [1]: [] };
      let side = Math.random() < 0.5 ? -1 : 1;
      const count = lua.random(ring.count[0], ring.count[1]);
      for (let n = 0; n < count; n++) {
        const neighbors = inner[side];
        const neighbor = neighbors[Math.floor(Math.random() * neighbors.length)];
        const offset = randomIn(ring.distance) / planet.radius; // round the surface, as an angle
        const fraction = randomIn(ring.heightFraction);
        const prism = Prism.new(planet, angle + side * offset, {
          // Standing straight out of the ground there would already turn
          // it `offset` away from the tall prism, so that much is taken
          // back out to leave just the lean.
          tilt: side * (randomIn(ring.lean) * Math.PI / 180 - offset),
          length: neighbor.length * fraction,
          size: neighbor.size * fraction,
        });
        prism.group = center.group;
        prisms.push(prism);
        placed[side].push(prism);
        side = -side; // alternating, so both sides of the tall one get some
      }
      const nextInner = { [-1]: inner[-1], [1]: inner[1] };
      for (const s of [-1, 1]) if (placed[s].length > 0) nextInner[s] = placed[s];
      inner = nextInner;
    }
    center.group.prisms = prisms;
    return prisms;
  }

  // `count` clusters spread round `planet`, one near the middle of each
  // equal share. Returns every prism of every cluster, in drawing order.
  static scatterClusters(planet, count) {
    const prisms = [];
    const share = Math.PI * 2 / count;
    const start = Math.random() * Math.PI * 2;
    for (let i = 1; i <= count; i++) {
      const jitter = (Math.random() * 2 - 1) * Prism.CLUSTER_PLACEMENT_JITTER;
      for (const prism of Prism.cluster(planet, start + (i - 0.5 + jitter) * share)) prisms.push(prism);
    }
    return prisms;
  }

  // The first of `prisms` the point is inside (see containsPoint), or null.
  static findAt(prisms, x, y, margin) {
    for (const prism of prisms) {
      if (prism.containsPoint(x, y, margin)) return prism;
    }
    return null;
  }

  // How far it can reach from the planetoid's center — for viewport culling.
  reach() {
    return this.planet.radius + Prism.FULL_HEIGHT;
  }

  // Where it leaves the surface, and the way it's turned (0 is pointing
  // straight up the screen) — a planetoid that turns carries it round.
  // Returns [x, y, rotation].
  placement() {
    const planet = this.planet;
    const angle = this.angle + (planet.rotationAngle ?? 0);
    return [
      planet.pos.x + Math.cos(angle) * planet.radius,
      planet.pos.y + Math.sin(angle) * planet.radius,
      angle + Math.PI / 2 + this.tilt,
    ];
  }

  // Whether the world point x, y is inside the part of it that shows
  // above the ground — or within `margin` of it (a fireball's radius).
  containsPoint(x, y, margin = 0) {
    const [baseX, baseY, rotation] = this.placement();
    const dx = x - baseX, dy = y - baseY;
    const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
    const across = dx * cosR + dy * sinR; // toward the prism's own right
    const along = dx * sinR - dy * cosR;  // from the ground toward its tip
    if (along < 0 || along > this.length + margin) return false;
    let halfWidth = this.halfWidth;
    const fromTip = this.length - along;
    if (fromTip < this.tipHeight) halfWidth = halfWidth * Math.max(0, fromTip) / this.tipHeight;
    return Math.abs(across) <= halfWidth + margin;
  }

  // It's been shot: its whole cluster flashes and glows. Returns true if
  // that was the hit that shatters the cluster (Prism.DESTROY_HITS) — the
  // caller takes it from there.
  hit() {
    const group = this.group;
    group.hitAge = 0;
    group.hits++;
    return group.hits >= Prism.DESTROY_HITS;
  }

  // The world point `fraction` of the way from where it leaves the ground
  // (0) to its tip (1), and the unit direction it points in.
  // Returns [x, y, dirX, dirY].
  pointAlong(fraction) {
    const [baseX, baseY, rotation] = this.placement();
    const dirX = Math.sin(rotation), dirY = -Math.cos(rotation);
    return [baseX + dirX * this.length * fraction, baseY + dirY * this.length * fraction, dirX, dirY];
  }

  // How broken its cluster is: 0 whole, then 1 for each entry of
  // Prism.DAMAGE_HITS it has been hit enough for.
  damageStage() {
    let stage = 0;
    Prism.DAMAGE_HITS.forEach((hits, i) => {
      if (this.group.hits >= hits) stage = i + 1;
    });
    return stage;
  }

  // dt: seconds. Call for every prism each frame; a cluster's glow is
  // shared, and only its first prism moves it along.
  update(dt) {
    const group = this.group;
    if (group.prisms[0] !== this || group.hitAge == null) return;
    group.hitAge += dt;
    if (group.hitAge >= Math.max(Prism.HIT_FLASH_SECONDS, Prism.HIT_GLOW_SECONDS)) group.hitAge = null;
  }

  // How strongly it's flashing and glowing right now, each 0..1.
  // Returns [flash, glow].
  hitLight() {
    const age = this.group.hitAge;
    if (age == null) return [0, 0];
    const flash = Math.max(0, 1 - age / Prism.HIT_FLASH_SECONDS);
    const fade = Math.max(0, 1 - age / Prism.HIT_GLOW_SECONDS);
    const shimmer = 1 - Prism.HIT_SHIMMER * (0.5 + 0.5 * Math.sin(age * 38 + this.sheenShift * 6.28));
    return [flash, fade * fade * shimmer];
  }

  draw() {
    // Every picture is the same size, so everything worked out from the
    // whole one (the quads, the scale) fits the others.
    const img = (state.miningDamagedTextures && state.miningDamagedTextures[this.damageStage()]) ?? state.miningTexture;
    if (!img) return;
    const [x, y, rotation] = this.placement();
    const [flash, glow] = this.hitLight();

    // The halo first, so the prism itself is drawn over the middle of it.
    if (glow > 0) {
      const halo = getHaloShader();
      halo.send('haloColor', Prism.HIT_COLOR);
      halo.send('strength', glow * Prism.HIT_HALO_STRENGTH);
      halo.send('reach', Prism.HIT_HALO_REACH);
      halo.send('aspect', img.getHeight() / img.getWidth());
      halo.send('leftX', SHAPE_LEFT_X);
      halo.send('rightX', SHAPE_RIGHT_X);
      halo.send('apexX', SHAPE_APEX_X);
      halo.send('apexY', SHAPE_APEX_Y);
      halo.send('shoulderY', SHAPE_SHOULDER_Y);
      love.graphics.setColor(1, 1, 1, 1);
      love.graphics.setBlendMode('add', 'alphamultiply');
      love.graphics.setShader(halo);
      love.graphics.draw(img, this.haloQuad, x, y, rotation, this.scale, this.scale,
        img.getWidth() / 2 + this.haloPadPx, this.lengthPx + this.haloPadPx);
      love.graphics.setShader();
      love.graphics.setBlendMode('alpha');
    }

    const shader = getFaceShader();
    const [leftColor, rightColor, leftLit, rightLit] = faceColors(x, y, Math.cos(rotation), Math.sin(rotation));
    shader.send('leftColor', leftColor);
    shader.send('rightColor', rightColor);
    shader.send('leftLit', leftLit);
    shader.send('hitColor', Prism.HIT_COLOR);
    shader.send('hitFlash', flash * Prism.HIT_FLASH_STRENGTH);
    shader.send('hitGlow', glow * Prism.HIT_GLOW_STRENGTH);
    shader.send('rightLit', rightLit);
    shader.send('surfaceV', this.lengthPx / img.getHeight());
    shader.send('baseBrightness', Prism.BASE_BRIGHTNESS);
    shader.send('faceOpacity', Prism.FACE_OPACITY);
    shader.send('outlineBrightness', Prism.OUTLINE_BRIGHTNESS);
    shader.send('glintColor', Prism.GLINT_COLOR);
    shader.send('rimStrength', Prism.RIM_STRENGTH);
    shader.send('rimWidth', Prism.RIM_WIDTH);
    shader.send('sheenStrength', Prism.SHEEN_STRENGTH);
    shader.send('sheenSpacing', Prism.SHEEN_SPACING);
    shader.send('sheenSlant', Prism.SHEEN_SLANT);
    shader.send('sheenShift', this.sheenShift);
    shader.send('coreStrength', Prism.CORE_STRENGTH);
    shader.send('aspect', img.getHeight() / img.getWidth());

    // Origin on the image's own center line, at the point where it meets
    // the surface — so it's placed exactly on the surface and leans about
    // that same point.
    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.setShader(shader);
    love.graphics.draw(img, this.quad, x, y, rotation, this.scale, this.scale, img.getWidth() / 2, this.lengthPx);
    love.graphics.setShader();
  }
}

Prism.FULL_HEIGHT = 236; // world units the whole image would stand, top to bottom
Prism.MIN_SINK = 23;     // at least this much of it is below the surface (less for a scaled-down prism, in proportion)
Prism.SINK_MARGIN = 4;   // how far inside the planetoid's edge the foot's corners are kept

// The two ends of the red its faces are painted in (see faceColors).
Prism.LIT_COLOR = [1.0, 0.30, 0.26];
Prism.SHADOW_COLOR = [0.42, 0.0, 0.04];

// A gradient along the part of it that shows: darkest where it comes out
// of the ground, lightening up to its own untouched color at the tip.
Prism.BASE_BRIGHTNESS = 0.45; // how bright it is right at the surface (1: no darkening)

// What makes it read as glass rather than painted stone (see getFaceShader).
Prism.FACE_OPACITY = 0.8;         // how solid the flat of a face is (1: not see-through at all)
Prism.OUTLINE_BRIGHTNESS = 0.3;   // the outlines: this fraction of the face color they border (0: black)
Prism.GLINT_COLOR = [1.0, 0.82, 0.8]; // the color of all three lights
Prism.RIM_STRENGTH = 0.45;        // light gathered along every edge of a face
Prism.RIM_WIDTH = 3.0;            // how far in from an edge that reaches (each +1 roughly doubles it)
Prism.SHEEN_STRENGTH = 0.3;       // slanted bands of reflection crossing the faces
Prism.SHEEN_SPACING = 1.9;        // prism-widths from one pair of bands to the next
Prism.SHEEN_SLANT = 0.55;         // how steeply the bands cross (0: straight along the prism)
Prism.CORE_STRENGTH = 0.22;       // a soft glow down the middle of each prism's width

// How many shots it takes before every prism of a cluster is drawn as
// each of the broken pictures in img/mining.png, in order.
Prism.DAMAGE_HITS = [2, 4];
// And how many before the whole cluster shatters (see main.js's own
// breakPrismCluster for what happens then).
Prism.DESTROY_HITS = 6;

// Being shot: every prism of the cluster lights up together — a quick
// FLASH toward HIT_COLOR, over a slower GLOW, with a soft halo.
Prism.HIT_COLOR = [1.0, 0.86, 0.8];
Prism.HIT_FLASH_SECONDS = 0.16;
Prism.HIT_FLASH_STRENGTH = 0.8;
Prism.HIT_GLOW_SECONDS = 1.2;
Prism.HIT_GLOW_STRENGTH = 0.7;
Prism.HIT_HALO_STRENGTH = 0.6;
Prism.HIT_HALO_REACH = 0.3;  // in prism-widths
Prism.HIT_SHIMMER = 0.18;    // how much the glow flickers while it fades

// Prisms grow in CLUSTERS (see Prism.cluster): one tall prism standing
// straight out of the surface, a few shorter ones nestled against it,
// and a few shorter still against those. Each range is [least, most].
//   count           how many prisms the ring has
//   heightFraction  its height, as a fraction of the prism it's nestled
//                   against — SCALED DOWN by this much, width and all
//   distance        how far round the surface from the tall prism, world units
//   lean            degrees it leans away from the tall prism
Prism.CLUSTER_CENTER_LENGTH = [161, 199]; // world units of the tall prism showing above the surface
Prism.CLUSTER_RINGS = [
  { count: [2, 3], heightFraction: [0.5, 0.75], distance: [21, 33], lean: [6, 13] },
  { count: [2, 4], heightFraction: [0.5, 0.75], distance: [38, 54], lean: [13, 22] },
];
// How far a cluster may land from the middle of its own share of the
// planetoid, as a fraction of that share.
Prism.CLUSTER_PLACEMENT_JITTER = 0.25;

export default Prism;
