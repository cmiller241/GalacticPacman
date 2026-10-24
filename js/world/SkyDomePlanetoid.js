// js/world/SkyDomePlanetoid.js
//
// Upper-half glass dome (radial shader + specular highlight), lower-half
// metal base, flat grass platform, scrolling hex grids. Foreground hexes
// are larger, bulged, and host subtle force-field flashes.
//
// Physics: isRoundedRect + isSkyDome. Landing / walking / gravity use the
// grass deck (trueSurfaceY). Pull targets should aim at the deck, not the
// ellipse center. Dome shell is visual + shield only.

import love from '../love/index.js';
import lua from '../love/lua.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import constants from '../constants.js';

// ---------------------------------------------------------------------
// Glass radial shader (+ specular highlight)
// ---------------------------------------------------------------------

let glassShader = null;
function getGlassShader() {
  if (glassShader) return glassShader;
  glassShader = love.graphics.newShader(`
    extern vec2 center;
    extern vec2 radii;
    extern vec4 colorInner;
    extern vec4 colorOuter;
    extern vec2 highlightCenter;
    extern number highlightRadius;
    extern number highlightStrength;

    vec4 effect(vec4 color, Image tex, vec2 texture_coords, vec2 screen_coords) {
      vec2 p = (screen_coords - center) / radii;
      float d = length(p);

      float t = smoothstep(0.10, 1.0, d);
      vec4 outColor = mix(colorInner, colorOuter, t);

      float hd = length(p - highlightCenter);
      float h = 1.0 - smoothstep(0.0, highlightRadius, hd);
      h = h * h;
      outColor.rgb += vec3(h * highlightStrength);
      outColor.a = min(1.0, outColor.a + h * highlightStrength * 0.35);

      if (d > 1.0) outColor.a = 0.0;
      return outColor;
    }
  `);
  return glassShader;
}

function setGlassUniforms(self, cx, cy) {
  const shader = getGlassShader();
  const zoom = state.zoom ?? 1;
  const cam = state.camera ?? { x: 0, y: 0 };

  shader.send('center', [(cx - cam.x) * zoom, (cy - cam.y) * zoom]);
  shader.send('radii', [self.domeRadiusX * zoom, self.domeRadiusY * zoom]);
  // colorInner applies at the dome's own center, colorOuter at its rim —
  // the center is the more transparent one and the rim the more opaque.
  shader.send('colorInner', [0.30, 0.60, 0.95, 0.16]);
  shader.send('colorOuter', [0.85, 0.95, 1.0, 0.50]);
  shader.send('highlightCenter', [-0.32, -0.48]);
  shader.send('highlightRadius', 0.55);
  shader.send('highlightStrength', 0.40);
}

// ---------------------------------------------------------------------
// Metal base shader: #6A6A70 at the deck, fade to dark at the keel
// ---------------------------------------------------------------------

let metalShader = null;
function getMetalShader() {
  if (metalShader) return metalShader;
  metalShader = love.graphics.newShader(`
    extern vec2 center;
    extern vec2 radii;
    extern vec4 colorTop;
    extern vec4 colorBottom;
    extern vec4 colorHighlight;

    vec4 effect(vec4 color, Image tex, vec2 texture_coords, vec2 screen_coords) {
      vec2 p = (screen_coords - center) / radii;
      float d = length(p);
      if (d > 1.0 || p.y < -0.02) return vec4(0.0);

      // 0 at the deck line, 1 at the bottom of the hull
      float depth = clamp(p.y, 0.0, 1.0);
      float t = smoothstep(0.0, 1.0, depth);
      t = t * t * (3.0 - 2.0 * t);

      vec4 outColor = mix(colorTop, colorBottom, t);

      // Soft rim / bevel near the ellipse edge
      float rim = smoothstep(0.72, 1.0, d);
      outColor.rgb = mix(outColor.rgb, colorBottom.rgb * 0.55, rim * 0.65);

      // Cool highlight band just under the deck
      float band = 1.0 - smoothstep(0.0, 0.22, depth);
      outColor.rgb = mix(outColor.rgb, colorHighlight.rgb, band * 0.22);

      outColor.a = 1.0;
      return outColor;
    }
  `);
  return metalShader;
}

function setMetalUniforms(self, cx, cy, rx, ry) {
  const shader = getMetalShader();
  const zoom = state.zoom ?? 1;
  const cam = state.camera ?? { x: 0, y: 0 };

  shader.send('center', [(cx - cam.x) * zoom, (cy - cam.y) * zoom]);
  shader.send('radii', [rx * zoom, ry * zoom]);
  shader.send('colorTop', [106 / 255, 106 / 255, 112 / 255, 1]); // #6A6A70
  shader.send('colorBottom', [0.07, 0.07, 0.08, 1]);
  shader.send('colorHighlight', [180 / 255, 184 / 255, 196 / 255, 1]);
}

// ---------------------------------------------------------------------
// Foreground bulge shader
// ---------------------------------------------------------------------

// Warps in FIXED box-pixel space (independent of scroll), then converts
// the warped position into the small repeating tile's own UV space and
// adds the scroll offset there, as the very last step before sampling.
// tex is expected to have wrap="repeat": warpedUV routinely exceeds
// [0,1], and the GPU sampler tiles it automatically.
//
// Also carries a ripple distortion: a standing sine wave in radial
// distance-from-center MINUS time — the "rings" travel outward forever
// with no reset bookkeeping needed, folded into the SAME warp pass.
let bulgeShader = null;
function getBulgeShader() {
  if (bulgeShader) return bulgeShader;
  bulgeShader = love.graphics.newShader(`
    extern vec2 center;
    extern vec2 radii;
    extern number strength;
    extern number radius;
    extern vec2 tileSize;
    extern number scroll;
    extern vec2 rippleCenter1;
    extern vec2 rippleCenter2;
    extern number rippleAmplitude;
    extern number rippleWidth;
    extern number rippleSpeed;
    extern number rippleMaxRadius;
    extern number rippleTime;

    // One ring-shaped band of displacement, expanding outward from
    // ringCenter (a radius that grows over time, wrapping via mod() once
    // past rippleMaxRadius). The Gaussian envelope confines the effect
    // to a narrow band around it, and the sin() inside that band gives
    // one small raised crest next to one small trough. phaseOffset
    // stands one ring's own clock apart from another's.
    vec2 ringDisplacement(vec2 p, vec2 ringCenter, float phaseOffset) {
      vec2 fromCenter = p - ringCenter;
      float d = length(fromCenter);
      if (d <= 0.0001) return vec2(0.0);
      vec2 dir = fromCenter / d;
      float ringRadius = mod(rippleTime * rippleSpeed + phaseOffset, rippleMaxRadius);
      float dist = d - ringRadius;
      float envelope = exp(-(dist * dist) / (2.0 * rippleWidth * rippleWidth));
      float ripple = sin(dist / rippleWidth * 3.14159265) * envelope;
      return dir * ripple;
    }

    vec4 effect(vec4 color, Image tex, vec2 texture_coords, vec2 screen_coords) {
      vec2 pixel = texture_coords * tileSize;
      vec2 p = (pixel - center) / radii;
      float d = length(p);

      if (d < radius && d > 0.0001) {
        float t = 1.0 - (d / radius);
        t = t * t * (3.0 - 2.0 * t);
        p /= (1.0 + strength * t);
      }

      // Two independent ripple SOURCES, phase-offset from each other.
      vec2 disp = ringDisplacement(p, rippleCenter1, 0.0)
                + ringDisplacement(p, rippleCenter2, rippleMaxRadius * 0.5);
      p += disp * rippleAmplitude;

      vec2 warpedPixel = center + p * radii;

      if (length((warpedPixel - center) / radii) > 1.02) {
        return vec4(0.0);
      }

      vec2 warpedUV = (warpedPixel + vec2(scroll, 0.0)) / tileSize;
      return Texel(tex, warpedUV) * color;
    }
  `);
  return bulgeShader;
}

// ---------------------------------------------------------------------
// Foreground forcefield shader
// ---------------------------------------------------------------------

// The foreground's hex lattice, drawn procedurally — through the same
// bulge-and-ripple warp as getBulgeShader, and the same scroll, but as
// glowing lines of energy:
//   * each hex edge a crisp bright line with a soft glow into its cell;
//   * faint near the deck, brighter toward the dome's edge (a fresnel
//     rim), with a soft haze right at the rim;
//   * a few cells at a time flashing up and fading;
//   * a slow band of energy sweeping across it on the diagonal;
//   * and round anything that just hit the shield (see
//     triggerShieldImpact): the cells there flaring, and a ring of lit
//     cells spreading out from it.
// Drawn additively, so it only ever adds light.
//
// Box space: pixels across the dome's bounding box (domeRadiusX*2 by
// domeRadiusY), the dome's centre at the middle of its bottom edge.
const FG_MAX_IMPACTS = 6;
const FG_IMPACT_SECONDS = 0.9;

let forcefieldShader = null;
function getForcefieldShader() {
  if (forcefieldShader) return forcefieldShader;
  forcefieldShader = love.graphics.newShader(`
    #define MAX_IMPACTS ${FG_MAX_IMPACTS}

    extern vec2 boxSize;
    extern vec2 center;
    extern vec2 radii;
    extern number strength;
    extern number radius;
    extern number hexWidth;
    extern number scroll;
    extern vec2 rippleCenter1;
    extern vec2 rippleCenter2;
    extern number rippleAmplitude;
    extern number rippleWidth;
    extern number rippleSpeed;
    extern number rippleMaxRadius;
    extern number time;
    extern vec3 tint;
    extern vec4 impacts[MAX_IMPACTS];   // x, y (box pixels), age 0..1, intensity
    extern int impactCount;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    // (Same ring as getBulgeShader's.)
    vec2 ringDisplacement(vec2 p, vec2 ringCenter, float phaseOffset) {
      vec2 fromCenter = p - ringCenter;
      float d = length(fromCenter);
      if (d <= 0.0001) return vec2(0.0);
      vec2 dir = fromCenter / d;
      float ringRadius = mod(time * rippleSpeed + phaseOffset, rippleMaxRadius);
      float dist = d - ringRadius;
      float envelope = exp(-(dist * dist) / (2.0 * rippleWidth * rippleWidth));
      return dir * sin(dist / rippleWidth * 3.14159265) * envelope;
    }

    // Distance from a pointy-topped hex cell's middle, in cell widths
    // (its flat sides at 0.5).
    float hexDist(vec2 p) {
      p = abs(p);
      return max(dot(p, vec2(0.5, 0.8660254)), p.x);
    }

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec2 pixel = uv * boxSize;
      vec2 p = (pixel - center) / radii;
      float d = length(p);
      if (d > 1.02) return vec4(0.0);

      if (d < radius && d > 0.0001) {
        float t = 1.0 - (d / radius);
        t = t * t * (3.0 - 2.0 * t);
        p /= (1.0 + strength * t);
      }
      p += (ringDisplacement(p, rippleCenter1, 0.0)
          + ringDisplacement(p, rippleCenter2, rippleMaxRadius * 0.5)) * rippleAmplitude;
      vec2 warped = center + p * radii;

      // Which cell, and how far from its edge.
      vec2 hp = (warped + vec2(scroll, 0.0)) / hexWidth;
      vec2 r = vec2(1.0, 1.7320508);
      vec2 h = r * 0.5;
      vec2 a = mod(hp, r) - h;
      vec2 b = mod(hp - h, r) - h;
      vec2 gv = dot(a, a) < dot(b, b) ? a : b;
      // Its middle, rounded to whole numbers — the same for every pixel
      // in it, so hashing it gives the whole cell one value.
      vec2 id = floor((hp - gv) * vec2(2.0, 1.1547005) + 0.5);
      float e = 0.5 - hexDist(gv);              // 0 on its edge .. 0.5 in its middle
      // (A pixel's size in cell widths — from hp, which is smooth.)
      float fw = max(length(vec2(dFdx(hp.x), dFdy(hp.x))), 1e-5);
      float line = 1.0 - smoothstep(fw * 0.6, fw * 1.8, e);
      float glow = exp(-e * 14.0);

      // Brighter toward the rim.
      float fres = smoothstep(0.25, 1.0, d);
      fres *= fres;
      float haze = smoothstep(0.82, 1.0, d) * (1.0 - smoothstep(0.98, 1.02, d));

      // Cells flashing up now and then.
      float flash = pow(max(0.0, sin(time * 0.7 + hash(id) * 60.0)), 24.0) * step(0.6, hash(id + 7.13));

      // The sweep, across the dome on the diagonal.
      float along = dot(pixel / radii.x, vec2(0.8, -0.6));
      float sw = (along - (mod(time * 0.08, 2.4) - 0.6)) / 0.06;
      float sweep = exp(-sw * sw);

      // Impacts.
      float imp = 0.0;
      for (int i = 0; i < MAX_IMPACTS; i++) {
        if (i >= impactCount) break;
        vec4 im = impacts[i];
        float dist = length(pixel - im.xy);   // (where it really hit — not through the lens)
        float fade = 1.0 - im.z;
        float rr = (dist - im.z * 900.0) / 110.0;
        float ring = exp(-rr * rr) * fade;
        float flare = exp(-dist / 160.0) * fade * fade;
        imp += (ring + flare) * im.w;
      }

      float edges = line * 0.85 + glow * 0.3;
      float light = edges * (0.18 + 0.9 * fres + 0.7 * sweep + 3.0 * imp)
                  + flash * (0.12 + glow * 0.5) * (0.4 + fres)
                  + imp * (0.25 + glow * 0.6)
                  + haze * 0.25;
      vec3 c = tint * light + vec3(1.0) * line * min(imp, 1.0) * 0.9;
      return vec4(c, 1.0) * color;
    }
  `);
  return forcefieldShader;
}

let pixelImage = null;
function getPixel() {
  if (pixelImage) return pixelImage;
  const data = love.image.newImageData(1, 1);
  data.setPixel(0, 0, 1, 1, 1, 1);
  pixelImage = love.graphics.newImage(data);
  return pixelImage;
}

// ---------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------

function parseRGBA(str, def) {
  if (Array.isArray(str)) return str;
  if (typeof str !== 'string') return def;
  const m = /(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,?\s*([\d.]*)/.exec(str);
  if (!m) return def;
  return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255, m[4] !== '' ? Number(m[4]) : 1];
}

function ellipseArcPoints(cx, cy, rx, ry, a0, a1, segments = 64) {
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const t = a0 + (a1 - a0) * (i / segments);
    pts.push(cx + Math.cos(t) * rx, cy + Math.sin(t) * ry);
  }
  return pts;
}

function upperArc(cx, cy, rx, ry, segments) {
  return ellipseArcPoints(cx, cy, rx, ry, Math.PI, Math.PI * 2, segments ?? 72);
}

function lowerArc(cx, cy, rx, ry, segments) {
  return ellipseArcPoints(cx, cy, rx, ry, 0, Math.PI, segments ?? 72);
}

function closedHalf(cx, cy, rx, ry, upper, segments) {
  const pts = upper ? upperArc(cx, cy, rx, ry, segments) : lowerArc(cx, cy, rx, ry, segments);
  pts.push(upper ? (cx + rx) : (cx - rx), cy);
  pts.push(upper ? (cx - rx) : (cx + rx), cy);
  return pts;
}

function strokeHexagon(cx, cy, size) {
  const pts = [];
  for (let i = 0; i <= 5; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 6;
    pts.push(cx + size * Math.cos(angle), cy + size * Math.sin(angle));
  }
  love.graphics.polygon('line', pts);
}

// Quadratic bezier seam: deck → bowed away from center mid-hull → keel
// (not all the way in).
function curvedSeamPoints(cx, cy, rx, ry, startX, endX, segments = 18) {
  const ctrlX = startX + (startX - cx) * 0.05;
  const ctrlY = cy + ry * 0.48;
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const s = i / segments;
    const omt = 1 - s;
    const x = omt * omt * startX + 2 * omt * s * ctrlX + s * s * endX;
    const y = omt * omt * cy + 2 * omt * s * ctrlY + s * s * (cy + ry);
    pts.push(x, y);
  }
  return pts;
}

class SkyDomePlanetoid {
  static new(x, y, options) {
    return new SkyDomePlanetoid(x, y, options);
  }

  constructor(x, y, options = {}) {
    const halfWidth = options.halfWidth ?? 2000;
    const halfHeight = options.halfHeight ?? 32;
    const grassHeight = options.grassHeight ?? 32;

    this.pos = new Vector2(x, y);
    this.vel = new Vector2(0, 0);
    this.halfWidth = halfWidth;
    this.halfHeight = halfHeight + grassHeight;
    this.grassHeight = grassHeight;
    this.cornerRadius = options.cornerRadius ?? 0;
    this.color = options.color ?? [0.36, 0.54, 0.29, 1];

    this.radius = Math.sqrt(halfWidth * halfWidth + (halfHeight + grassHeight) * (halfHeight + grassHeight));

    this.rotationAngle = 0;
    this.rotationSpeed = 0;

    this.isImmovable = true;
    this.isPermanent = true;
    this.isSkyDome = true;
    this.isRoundedRect = true;
    this.noSunShading = true;
    // Excluded from pull-beam/lock-on target selection — the dome itself
    // is huge background scenery the player is already standing on.
    this.isPullExempt = true;

    // Stronger than the game's default gravity — a Mario-style snappy
    // jump/fall inside the dome instead of the floaty arc the default
    // gives everywhere else.
    this.gravityStrength = options.gravityStrength ?? (constants.GRAVITY_STRENGTH * 1.6);

    // Compensates for the stronger gravity above — Player.jump() checks
    // this per-planet override before falling back to
    // constants.JUMP_STRENGTH. Applies on every Tiled tile's own
    // TerrainShape too (see main.js's own propagation of this value).
    this.jumpStrength = options.jumpStrength ?? 12;

    this.domeRadiusX = options.domeRadiusX ?? halfWidth;
    this.domeRadiusY = options.domeRadiusY ?? halfWidth;
    this.baseRadiusY = options.baseRadiusY ?? (this.domeRadiusY / 6);

    this.baseGlowColor = parseRGBA(options.baseGlowColor, [180 / 255, 210 / 255, 255 / 255, 1]);
    this.baseLineColor = parseRGBA(options.baseLineColor, [10 / 255, 10 / 255, 12 / 255, 1]);
    this.baseHighlightColor = parseRGBA(options.baseHighlightColor, [210 / 255, 220 / 255, 235 / 255, 1]);
    this.baseHorizontalLineCount = options.baseHorizontalLineCount ?? 3;
    this.baseSeamCount = options.baseSeamCount ?? 6;
    this.baseSeamConvergence = options.baseSeamConvergence ?? 0.35;

    this.domeFillColor = options.domeFillColor ?? [130 / 255, 196 / 255, 255 / 255, 0.9];
    this.domeRimColor = options.domeRimColor ?? [75 / 255, 150 / 255, 225 / 255, 0.85];
    this.domeOutlineColor = options.domeOutlineColor ?? [1, 1, 1, 1];
    this.domeOutlineWidth = options.domeOutlineWidth ?? 3;
    this.domeBottomFade = options.domeBottomFade ?? 0.45;

    this.domeGlowColor = parseRGBA(options.domeGlowColor, [1, 1, 1, 1]);
    this.domeGlowReach = options.domeGlowReach ?? 30;
    this.domeGlowIntensity = options.domeGlowIntensity ?? 1;
    this.domeInnerGlowReach = options.domeInnerGlowReach ?? 40;

    this.domeHexSize = options.domeHexSize ?? 60;
    this.domeHexColor = parseRGBA(options.domeHexColor, [0, 0, 0, 1]);
    this.domeHexOpacity = options.domeHexOpacity ?? 0.12;
    this.domeHexScrollSpeed = options.domeHexScrollSpeed ?? 0.006;
    this.domeHexLineWidth = options.domeHexLineWidth ?? 1;

    this.domeForegroundHexSize = options.domeForegroundHexSize ?? (this.domeHexSize * 1.5);
    this.domeForegroundHexOpacity = options.domeForegroundHexOpacity ?? Math.min(1, this.domeHexOpacity * 0.5);
    this.domeForegroundHexScrollSpeed = options.domeForegroundHexScrollSpeed ?? -0.01;
    this.domeForegroundHexLineWidth = options.domeForegroundHexLineWidth ?? 2.5;
    this.domeForegroundTintOpacity = options.domeForegroundTintOpacity ?? 2.0;
    this.domeForegroundOutlineOpacity = options.domeForegroundOutlineOpacity ?? 0.2;
    this.domeForegroundZoomReference = options.domeForegroundZoomReference ?? 1.0;
    this.domeForegroundZoomFloor = options.domeForegroundZoomFloor ?? 0;

    this.domeBulgeStrength = options.domeBulgeStrength ?? 0.55;
    this.domeBulgeRadius = options.domeBulgeRadius ?? 2.0;

    // Subtle forcefield ripple — a ring-shaped band of distortion
    // expanding outward, looping. Distances are in the bulge shader's
    // normalized (radii-divided) space, where the dome's edge is ~1.0.
    this.domeForegroundRippleAmplitude = options.domeForegroundRippleAmplitude ?? 0; // how far a pixel gets displaced at the ring's peak
    this.domeForegroundRippleWidth = options.domeForegroundRippleWidth ?? 0.05;      // how wide (radially) the ring band is
    this.domeForegroundRippleSpeed = options.domeForegroundRippleSpeed ?? 0.3;       // how fast the ring's own radius grows, per second
    this.domeForegroundRippleMaxRadius = options.domeForegroundRippleMaxRadius ?? 1.3; // radius the ring wraps back to 0 at

    // Two independent ripple SOURCES, each an offset from the dome's
    // true center in the same normalized space.
    this.domeForegroundRippleCenter1 = options.domeForegroundRippleCenter1 ?? [-0.3, -0.2];
    this.domeForegroundRippleCenter2 = options.domeForegroundRippleCenter2 ?? [0.3, -0.2];

    this.hexGridCanvas = null;
    this.hexGridForegroundCanvas = null;
    this.hexGridTileW = 0;
    this.hexGridTileH = 0;
    this.hexGridForegroundTileW = 0;
    this.hexGridForegroundTileH = 0;
    this.fgQuad = null;

    this.lastImpactTime = 0;
    this.shieldRipples = [];
    this.shieldSparks = [];
    this.fgImpacts = [];

    // The foreground forcefield's colour (see getForcefieldShader).
    this.domeForegroundFieldColor = parseRGBA(options.domeForegroundFieldColor, [0.45, 0.82, 1.0, 1]);
    this.domeForegroundFieldIntensity = options.domeForegroundFieldIntensity ?? 0.55;
    // ...and the background's: the same field on the shield's far side,
    // fainter and finer (see drawDome).
    this.domeBackFieldIntensity = options.domeBackFieldIntensity ?? 0.16;
    this.domeBackFieldHexSize = options.domeBackFieldHexSize ?? 38;

    this.createOffscreen();
  }

  // ----------------------------------------------------------------
  // Geometry / physics
  // ----------------------------------------------------------------

  trueSurfaceY() {
    return this.pos.y - this.halfHeight;
  }

  domeAnchorY() {
    return this.trueSurfaceY() + this.grassHeight;
  }

  // Returns [x, y].
  getPullAnchor() {
    return [this.pos.x, this.trueSurfaceY()];
  }

  isWithinGravityWindow(worldX, worldY) {
    if (worldY > this.trueSurfaceY()) return false;
    const nx = (worldX - this.pos.x) / this.domeRadiusX;
    const ny = (worldY - this.domeAnchorY()) / this.domeRadiusY;
    return (nx * nx + ny * ny) <= 1;
  }

  nearestSurfacePoint(worldX, worldY) {
    const topY = this.trueSurfaceY();
    const minX = this.pos.x - this.halfWidth;
    const maxX = this.pos.x + this.halfWidth;
    const clampedX = Math.max(minX, Math.min(maxX, worldX));
    return {
      point: new Vector2(clampedX, topY),
      normal: new Vector2(0, -1),
      distance: Math.abs(worldY - topY),
    };
  }

  distanceToSurface(worldX, worldY) {
    return this.nearestSurfacePoint(worldX, worldY).distance;
  }

  containsPoint(worldX, worldY) {
    if (this.isWithinGravityWindow(worldX, worldY)) return true;
    const topY = this.trueSurfaceY();
    const minX = this.pos.x - this.halfWidth;
    const maxX = this.pos.x + this.halfWidth;
    return worldX >= minX && worldX <= maxX
      && worldY >= topY - 4
      && worldY <= topY + this.grassHeight + 8;
  }

  nearestEllipseSurfacePoint(centerX, centerY, radiusX, radiusY, worldX, worldY, fallbackDirY) {
    const lx = worldX - centerX;
    const ly = worldY - centerY;
    const nx = lx / radiusX;
    const ny = ly / radiusY;
    const nDist = Math.sqrt(nx * nx + ny * ny);

    let blx, bly;
    if (nDist < 1e-6) {
      blx = 0;
      bly = fallbackDirY * radiusY;
    } else {
      blx = (nx / nDist) * radiusX;
      bly = (ny / nDist) * radiusY;
    }

    const boundaryX = centerX + blx;
    const boundaryY = centerY + bly;
    const normal = new Vector2(blx / (radiusX * radiusX), bly / (radiusY * radiusY)).normalize();
    const dx = worldX - boundaryX;
    const dy = worldY - boundaryY;

    return {
      point: new Vector2(boundaryX, boundaryY),
      normal,
      distance: Math.sqrt(dx * dx + dy * dy),
    };
  }

  nearestDomeSurfacePoint(worldX, worldY) {
    return this.nearestEllipseSurfacePoint(this.pos.x, this.domeAnchorY(), this.domeRadiusX, this.domeRadiusY, worldX, worldY, -1);
  }

  nearestBaseSurfacePoint(worldX, worldY) {
    return this.nearestEllipseSurfacePoint(this.pos.x, this.domeAnchorY(), this.halfWidth, this.baseRadiusY, worldX, worldY, 1);
  }

  getPerimeter() {
    return this.halfWidth * 2;
  }

  arcPositionForWorldPoint(worldX, worldY) {
    const minX = this.pos.x - this.halfWidth;
    const maxX = this.pos.x + this.halfWidth;
    const x = Math.max(minX, Math.min(maxX, worldX));
    return x - minX;
  }

  worldPointAtArcPosition(s, pushDistance = 0) {
    const perimeter = this.getPerimeter();
    if (perimeter <= 0) {
      return { point: new Vector2(this.pos.x, this.trueSurfaceY() - pushDistance), normal: new Vector2(0, -1) };
    }
    s = lua.mod(s, perimeter);
    const x = (this.pos.x - this.halfWidth) + s;
    const y = this.trueSurfaceY() - pushDistance;
    return { point: new Vector2(x, y), normal: new Vector2(0, -1) };
  }

  // ----------------------------------------------------------------
  // Shield impact FX
  // ----------------------------------------------------------------

  triggerShieldImpact(worldX, worldY, intensity = 1) {
    this.lastImpactTime = love.timer.getTime() * 1000;
    this.shieldRipples.push({ x: worldX, y: worldY, spawnTime: this.lastImpactTime, intensity });
    // (The foreground forcefield's own record, kept a little longer.
    // Oldest dropped first past FG_MAX_IMPACTS.)
    this.fgImpacts.push({ x: worldX, y: worldY, time: love.timer.getTime(), intensity });
    if (this.fgImpacts.length > FG_MAX_IMPACTS) this.fgImpacts.shift();

    const sparkCount = Math.floor(4 + intensity * 6 + 0.5);
    for (let n = 0; n < sparkCount; n++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.06 + Math.random() * 0.12;
      this.shieldSparks.push({
        x: worldX, y: worldY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        spawnTime: this.lastImpactTime,
      });
    }
  }

  // FG lattice scroll — modded by the tile's own actual pixel width, so
  // it lines up EXACTLY with the GPU's own repeat period.
  fgScroll() {
    const tileW = this.hexGridForegroundTileW;
    if (!tileW || tileW <= 0) return 0;
    const nowMs = love.timer.getTime() * 1000;
    return lua.mod(nowMs * this.domeForegroundHexScrollSpeed, tileW);
  }

  // ----------------------------------------------------------------
  // Hex bake
  // ----------------------------------------------------------------

  // Returns [canvas, tileW, tileH, hexWidth, hexHeightStep].
  bakeHexGridTile(hexSize, opacity, lineWidth) {
    const hexWidth = Math.sqrt(3) * hexSize;
    const hexHeightStep = hexSize * 1.5;
    const tileW = Math.max(1, Math.ceil(hexWidth));
    const tileH = Math.max(1, Math.ceil(hexHeightStep * 2));

    const canvas = love.graphics.newCanvas(tileW, tileH);
    love.graphics.push();
    love.graphics.origin();
    love.graphics.setCanvas(canvas);
    love.graphics.clear(0, 0, 0, 0);

    love.graphics.setLineWidth(lineWidth ?? 1);
    love.graphics.setColor(this.domeHexColor[0], this.domeHexColor[1], this.domeHexColor[2], opacity);

    for (let row = -1; row <= 2; row++) {
      const y = row * hexHeightStep;
      const rowOffset = (lua.mod(row, 2) !== 0) ? (hexWidth / 2) : 0;
      for (let col = -1; col <= 2; col++) {
        const x = col * hexWidth + rowOffset;
        strokeHexagon(x, y, hexSize);
      }
    }

    love.graphics.setCanvas();
    love.graphics.pop();
    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.setLineWidth(1);

    return [canvas, tileW, tileH, hexWidth, hexHeightStep];
  }

  createOffscreen() {
    [this.hexGridCanvas, this.hexGridTileW, this.hexGridTileH] =
      this.bakeHexGridTile(this.domeHexSize, this.domeHexOpacity, this.domeHexLineWidth);

    [this.hexGridForegroundCanvas, this.hexGridForegroundTileW, this.hexGridForegroundTileH] =
      this.bakeHexGridTile(this.domeForegroundHexSize, this.domeForegroundHexOpacity, this.domeForegroundHexLineWidth);

    // Lets the bulge shader sample this one small baked tile as an
    // infinitely repeating texture.
    this.hexGridForegroundCanvas.setWrap('repeat', 'repeat');

    // A single quad covering the dome's full box in the tile's own repeat
    // units — built once; scroll is applied in the shader instead.
    this.fgQuad = love.graphics.newQuad(
      0, 0, this.domeRadiusX * 2, this.domeRadiusY,
      this.hexGridForegroundTileW, this.hexGridForegroundTileH,
    );
  }

  // ----------------------------------------------------------------
  // Drawing
  // ----------------------------------------------------------------

  drawDome() {
    const cx = this.pos.x;
    const cy = this.domeAnchorY();
    const rx = this.domeRadiusX, ry = this.domeRadiusY;
    const glass = closedHalf(cx, cy, rx, ry, true);

    const shader = getGlassShader();
    setGlassUniforms(this, cx, cy);

    love.graphics.setShader(shader);
    love.graphics.stencil(() => {
      love.graphics.polygon('fill', glass);
    }, 'replace', 1);
    love.graphics.setStencilTest('greater', 0);
    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.rectangle('fill', cx - rx, cy - ry, rx * 2, ry);
    love.graphics.setStencilTest();
    love.graphics.setShader();

    love.graphics.stencil(() => {
      love.graphics.polygon('fill', glass);
    }, 'replace', 1);
    love.graphics.setStencilTest('greater', 0);
    for (let i = 1; i <= 5; i++) {
      const t = i / 5;
      love.graphics.setColor(0.05, 0.10, 0.18, this.domeBottomFade * 0.08 * t);
      love.graphics.polygon('fill', closedHalf(cx, cy, rx, ry * (0.15 + 0.35 * t), true));
    }
    love.graphics.setStencilTest();

    if (this.domeBackFieldIntensity > 0) {
      // The far side of the shield: the same forcefield as the
      // foreground's, but smaller hexes, flat (no lens), much fainter,
      // scrolling the other way, and flashing on its own clock.
      this.drawForcefield(glass, cx, cy, rx, ry, {
        hexSize: this.domeBackFieldHexSize,
        scrollSpeed: this.domeHexScrollSpeed,
        bulge: false,
        alpha: this.domeBackFieldIntensity,
        timeOffset: 37.3,
      });
    } else if (this.hexGridCanvas) {
      // (The plain baked lattice, when domeBackFieldIntensity is 0.)
      love.graphics.stencil(() => {
        love.graphics.polygon('fill', glass);
      }, 'replace', 1);
      love.graphics.setStencilTest('greater', 0);

      const tileW = this.hexGridTileW, tileH = this.hexGridTileH;
      const now = love.timer.getTime() * 1000;
      const scroll = lua.mod(now * this.domeHexScrollSpeed, tileW);
      const boxX = cx - rx, boxY = cy - ry;

      love.graphics.setColor(1, 1, 1, 0.75);
      for (let y = boxY - tileH; y <= cy; y += tileH) {
        for (let x = boxX - scroll - tileW; x <= boxX + rx * 2 + tileW; x += tileW) {
          love.graphics.draw(this.hexGridCanvas, x, y);
        }
      }
      love.graphics.setStencilTest();
    }

    const arc = upperArc(cx, cy, rx, ry);
    const reach = this.domeGlowReach;
    for (let i = 4; i >= 1; i--) {
      const t = i / 4;
      love.graphics.setLineWidth(this.domeOutlineWidth + reach * t);
      love.graphics.setColor(1, 1, 1, 0.035 * (1 - t * 0.5) * this.domeGlowIntensity);
      love.graphics.line(arc);
    }

    love.graphics.setLineWidth(this.domeOutlineWidth);
    love.graphics.setColor(1, 1, 1, 0.75);
    love.graphics.line(arc);

    love.graphics.setLineWidth(1);
    love.graphics.setColor(1, 1, 1, 1);

    this.drawShieldImpactEffects(cx, cy);
  }

  drawMetalBase() {
    const cx = this.pos.x;
    const cy = this.domeAnchorY();
    const rx = this.halfWidth, ry = this.baseRadiusY;
    const hull = closedHalf(cx, cy, rx, ry, false);

    const shader = getMetalShader();
    setMetalUniforms(this, cx, cy, rx, ry);

    love.graphics.setShader(shader);
    love.graphics.stencil(() => {
      love.graphics.polygon('fill', hull);
    }, 'replace', 1);
    love.graphics.setStencilTest('greater', 0);
    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.rectangle('fill', cx - rx, cy, rx * 2, ry);
    love.graphics.setStencilTest();
    love.graphics.setShader();

    // Deck lip matches grass.png metal (#6A6A70)
    love.graphics.setColor(106 / 255, 106 / 255, 112 / 255, 1);
    love.graphics.setLineWidth(3);
    love.graphics.line(cx - rx, cy, cx + rx, cy);

    // Soft underside rim
    love.graphics.setColor(this.baseGlowColor[0], this.baseGlowColor[1], this.baseGlowColor[2], 0.08);
    love.graphics.setLineWidth(Math.max(2, ry * 0.18));
    love.graphics.line(lowerArc(cx, cy, rx * 0.98, ry * 0.92));

    // Horizontal plate seams (ellipse chords)
    love.graphics.setLineWidth(1.25);
    for (let i = 1; i <= this.baseHorizontalLineCount; i++) {
      const t = i / (this.baseHorizontalLineCount + 1);
      const y = cy + ry * t;
      const halfSpan = rx * Math.sqrt(Math.max(0, 1 - t * t));
      love.graphics.setColor(0.82, 0.84, 0.88, 0.06);
      love.graphics.line(cx - halfSpan, y - 1.2, cx + halfSpan, y - 1.2);
      love.graphics.setColor(0.04, 0.04, 0.05, 0.28);
      love.graphics.line(cx - halfSpan, y, cx + halfSpan, y);
    }

    // Vertical panel seams: curve inward, stop short of center
    for (let i = 1; i <= this.baseSeamCount - 1; i++) {
      const t = i / this.baseSeamCount;
      const startX = cx - rx + t * (rx * 2);
      const endX = cx + (startX - cx) * (1 - this.baseSeamConvergence);
      const pts = curvedSeamPoints(cx, cy, rx, ry, startX, endX, 20);
      love.graphics.setColor(0.03, 0.03, 0.035, 0.38);
      love.graphics.setLineWidth(1.6);
      love.graphics.line(pts);
      love.graphics.setColor(0.78, 0.80, 0.84, 0.07);
      love.graphics.setLineWidth(1);
      // slight highlight offset
      const hi = [];
      for (let n = 0; n < pts.length; n += 2) hi.push(pts[n] + 1.2, pts[n + 1]);
      love.graphics.line(hi);
    }

    love.graphics.setColor(0.10, 0.10, 0.12, 0.85);
    love.graphics.setLineWidth(1.5);
    love.graphics.line(lowerArc(cx, cy, rx, ry));

    love.graphics.setLineWidth(1);
    love.graphics.setColor(1, 1, 1, 1);
  }

  drawGrassCap() {
    const topY = this.trueSurfaceY();
    const fullW = this.halfWidth * 2;
    const startX = this.pos.x - this.halfWidth;
    const h = this.grassHeight;

    // Clipped to the SAME glass-dome ellipse drawDome's own stencil uses —
    // at the deck's outer edges the plain grass rectangle would otherwise
    // poke out past the visible glass by a sliver.
    const cx = this.pos.x, cy = this.domeAnchorY();
    const rx = this.domeRadiusX, ry = this.domeRadiusY;
    love.graphics.stencil(() => {
      love.graphics.polygon('fill', closedHalf(cx, cy, rx, ry, true));
    }, 'replace', 1);
    love.graphics.setStencilTest('greater', 0);

    if (state.grassTexture) {
      const img = state.grassTexture;
      const scale = 2;
      const tileW = 32 * scale;
      love.graphics.setColor(1, 1, 1, 1);
      for (let x = 0; x <= fullW; x += tileW) {
        love.graphics.draw(img, startX + x, topY, 0, scale, h / img.getHeight());
      }
    } else {
      love.graphics.setColor(0.36, 0.55, 0.28, 1);
      love.graphics.rectangle('fill', startX, topY, fullW, h);
    }

    love.graphics.setStencilTest();
    love.graphics.setColor(1, 1, 1, 1);
  }

  drawShieldImpactEffects(cx, cy) {
    const now = love.timer.getTime() * 1000;
    const rx = this.domeRadiusX, ry = this.domeRadiusY;

    const PULSE_DURATION_MS = 350;
    const pulseElapsed = now - this.lastImpactTime;
    if (pulseElapsed < PULSE_DURATION_MS) {
      const t = 1 - pulseElapsed / PULSE_DURATION_MS;
      love.graphics.setColor(1, 1, 1, t * 0.45);
      love.graphics.polygon('fill', closedHalf(cx, cy, rx, ry, true));
    }

    const RIPPLE_DURATION_MS = 400;
    for (let i = this.shieldRipples.length - 1; i >= 0; i--) {
      const r = this.shieldRipples[i];
      const age = now - r.spawnTime;
      if (age > RIPPLE_DURATION_MS) {
        this.shieldRipples.splice(i, 1);
      } else {
        const t = age / RIPPLE_DURATION_MS;
        const radius = (10 + r.intensity * 15) * (0.3 + t * 0.7);
        love.graphics.setColor(210 / 255, 240 / 255, 255 / 255, (1 - t) * 0.8);
        love.graphics.setLineWidth(2.5);
        love.graphics.circle('line', r.x, r.y, radius);
      }
    }

    const SPARK_DURATION_MS = 500;
    for (let i = this.shieldSparks.length - 1; i >= 0; i--) {
      const s = this.shieldSparks[i];
      const age = now - s.spawnTime;
      if (age > SPARK_DURATION_MS) {
        this.shieldSparks.splice(i, 1);
      } else {
        const x = s.x + s.vx * age;
        const y = s.y + s.vy * age;
        love.graphics.setColor(220 / 255, 240 / 255, 255 / 255, 1 - age / SPARK_DURATION_MS);
        love.graphics.circle('fill', x, y, 2);
      }
    }

    love.graphics.setLineWidth(1);
    love.graphics.setColor(1, 1, 1, 1);
  }

  // One layer of the procedural forcefield, clipped to the dome's glass
  // — the foreground's (big hexes, through the bulge lens) or the
  // background's (smaller, flat, fainter). opts:
  //   hexSize, scrollSpeed  the lattice's
  //   bulge                 whether it goes through the lens (and its ripples)
  //   alpha                 overall brightness
  //   timeOffset            seconds its flashes/sweep run ahead
  drawForcefield(glass, cx, cy, rx, ry, opts) {
    if (opts.alpha <= 0.001) return;
    const now = love.timer.getTime();
    const hexWidth = Math.sqrt(3) * opts.hexSize;
    const scroll = lua.mod(now * 1000 * opts.scrollSpeed, hexWidth);

    // Recent impacts, in box pixels, aged 0..1.
    const impacts = [];
    for (let i = this.fgImpacts.length - 1; i >= 0; i--) {
      const im = this.fgImpacts[i];
      const age = (now - im.time) / FG_IMPACT_SECONDS;
      if (age >= 1) {
        this.fgImpacts.splice(i, 1);
      } else {
        impacts.push([im.x - (cx - rx), im.y - (cy - ry), age, im.intensity]);
      }
    }

    const shader = getForcefieldShader();
    shader.send('boxSize', [rx * 2, ry]);
    shader.send('center', [rx, ry]);
    shader.send('radii', [rx, ry]);
    shader.send('strength', opts.bulge ? this.domeBulgeStrength : 0);
    shader.send('radius', this.domeBulgeRadius);
    shader.send('hexWidth', hexWidth);
    shader.send('scroll', scroll);
    shader.send('rippleCenter1', this.domeForegroundRippleCenter1);
    shader.send('rippleCenter2', this.domeForegroundRippleCenter2);
    shader.send('rippleAmplitude', opts.bulge ? this.domeForegroundRippleAmplitude : 0);
    shader.send('rippleWidth', this.domeForegroundRippleWidth);
    shader.send('rippleSpeed', this.domeForegroundRippleSpeed);
    shader.send('rippleMaxRadius', this.domeForegroundRippleMaxRadius);
    shader.send('time', now + opts.timeOffset);
    shader.send('tint', [this.domeForegroundFieldColor[0], this.domeForegroundFieldColor[1], this.domeForegroundFieldColor[2]]);
    shader.send('impactCount', impacts.length);
    if (impacts.length > 0) shader.send('impacts', ...impacts);

    love.graphics.stencil(() => {
      love.graphics.polygon('fill', glass);
    }, 'replace', 1);
    love.graphics.setStencilTest('greater', 0);
    love.graphics.push('all');
    love.graphics.setShader(shader);
    love.graphics.setBlendMode('add');
    love.graphics.setColor(1, 1, 1, opts.alpha);
    love.graphics.draw(getPixel(), cx - rx, cy - ry, 0, rx * 2, ry);
    love.graphics.pop();
    love.graphics.setStencilTest();
  }

  drawForegroundGlass() {
    const zoom = state.zoom ?? 1;
    const zoomMin = state.zoomMin ?? 0.5;
    const zoomRef = this.domeForegroundZoomReference;
    const zoomT = zoomRef > zoomMin ? (zoom - zoomMin) / (zoomRef - zoomMin) : 0;
    const clampedT = Math.max(0, Math.min(1, zoomT));
    const zoomFactor = this.domeForegroundZoomFloor + (1 - this.domeForegroundZoomFloor) * (1 - clampedT);
    if (zoomFactor <= 0.001) return;

    const cx = this.pos.x;
    const cy = this.domeAnchorY();
    const rx = this.domeRadiusX, ry = this.domeRadiusY;
    const glass = closedHalf(cx, cy, rx, ry, true);

    const c = this.domeFillColor;
    love.graphics.setColor(c[0], c[1], c[2], (c[3] ?? 1) * this.domeForegroundTintOpacity * zoomFactor * 0.22);
    love.graphics.polygon('fill', glass);

    // The procedural forcefield, or (when domeForegroundFieldIntensity is
    // 0) the baked lattice tile, sampled through the bulge shader via
    // fgQuad.
    if (this.domeForegroundFieldIntensity > 0) {
      this.drawForcefield(glass, cx, cy, rx, ry, {
        hexSize: this.domeForegroundHexSize,
        scrollSpeed: this.domeForegroundHexScrollSpeed,
        bulge: true,
        alpha: zoomFactor * this.domeForegroundFieldIntensity,
        timeOffset: 0,
      });
    } else if (this.hexGridForegroundCanvas) {
      love.graphics.stencil(() => {
        love.graphics.polygon('fill', glass);
      }, 'replace', 1);
      love.graphics.setStencilTest('greater', 0);

      const shader = getBulgeShader();
      shader.send('center', [this.domeRadiusX, this.domeRadiusY]);
      shader.send('radii', [rx, ry]);
      shader.send('strength', this.domeBulgeStrength);
      shader.send('radius', this.domeBulgeRadius);
      shader.send('tileSize', [this.hexGridForegroundTileW, this.hexGridForegroundTileH]);
      shader.send('scroll', this.fgScroll());
      shader.send('rippleCenter1', this.domeForegroundRippleCenter1);
      shader.send('rippleCenter2', this.domeForegroundRippleCenter2);
      shader.send('rippleAmplitude', this.domeForegroundRippleAmplitude);
      shader.send('rippleWidth', this.domeForegroundRippleWidth);
      shader.send('rippleSpeed', this.domeForegroundRippleSpeed);
      shader.send('rippleMaxRadius', this.domeForegroundRippleMaxRadius);
      shader.send('rippleTime', love.timer.getTime());

      love.graphics.setShader(shader);
      love.graphics.setColor(1, 1, 1, zoomFactor * 0.95);
      love.graphics.draw(this.hexGridForegroundCanvas, this.fgQuad, cx - rx, cy - ry);
      love.graphics.setShader();

      love.graphics.setStencilTest();
    }

    love.graphics.setColor(this.domeOutlineColor[0], this.domeOutlineColor[1], this.domeOutlineColor[2],
      this.domeForegroundOutlineOpacity * zoomFactor);
    love.graphics.setLineWidth(this.domeOutlineWidth);
    love.graphics.line(upperArc(cx, cy, rx, ry));

    love.graphics.setLineWidth(1);
    love.graphics.setColor(1, 1, 1, 1);
  }

  draw() {
    this.drawDome();
    this.drawMetalBase();
    this.drawGrassCap();
  }

  createRingCanvas() {}
  drawSunShading() {}
  drawEclipseShadow() {}
}

export default SkyDomePlanetoid;
