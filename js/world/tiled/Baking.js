// js/world/tiled/Baking.js
//
// Baking the map's tile layers into one image, with depth shading and
// shadows between layers.
// Part of the Tiled level loader: see js/world/TiledTerrain.js.

import love from '../../love/index.js';
import {
  TILE_SCALE, TILE_WORLD_SIZE, DEFAULT_TILESET_COLUMNS, findTileset,
  classifyGid, getTileQuadForLocalIndex,
} from './Tiles.js';

// Functions it adds to TiledTerrain (copied on in js/world/TiledTerrain.js).
const TiledTerrain = {};

// ---------------------------------------------------------------------
// Depth shading — layers named Back and Middle set behind Front
// ---------------------------------------------------------------------
//
// Baked once, into the level's one canvas, back to front: a soft shadow of
// the layer in front cast onto each layer behind it — Middle's onto Back,
// then Front's onto both (offset down and a little sideways, blurred).
// Shadows are made at 1/SHADOW_DOWNSCALE size and the canvas only ever
// multiplied. And each layer darkening toward the bottom of the map (see
// GROUND_SHADE_ROWS).
const SHADOWED_LAYERS = { back: true, middle: true }; // (by name, any capitals)
const SHADOW_STRENGTH = 0.5;  // how dark the shadow of a layer in front is, at its darkest
const SHADOW_OFFSET_X = 14;   // world units: the shadow lands this far right...
const SHADOW_OFFSET_Y = 30;   // ...and this far down from what casts it
// (The same offset Bob's and the Ooombas' shadows use — see
// js/effects/CharacterShadows.js.)
TiledTerrain.SHADOW_OFFSET_X = SHADOW_OFFSET_X;
TiledTerrain.SHADOW_OFFSET_Y = SHADOW_OFFSET_Y;
const SHADOW_BLUR = 3;        // blur passes (at the shadow's reduced size)
const SHADOW_DOWNSCALE = 8;
// Each layer's tiles darkening toward the bottom of the map, over its
// bottom this-many rows — darkest right at the bottom edge. The further
// back the layer, the higher it reaches.
const GROUND_SHADE_ROWS = { front: 1, middle: 3, back: 5 };
const GROUND_SHADE_DARKNESS = 0.5; // how much darker it gets at the very bottom (0 = none, 1 = black)

// Draws tiles darkened by how near the bottom of the map they are — by
// their own pixels' height, so it's only ever the tiles' own art that
// darkens, never what shows through their clear parts.
let groundShadeShader = null;
function getGroundShadeShader() {
  if (groundShadeShader) return groundShadeShader;
  groundShadeShader = love.graphics.newShader(`
    varying float canvasY;
    #ifdef VERTEX
    vec4 position(mat4 transform_projection, vec4 vertex_position) {
      canvasY = (TransformMatrix * vertex_position).y;
      return transform_projection * vertex_position;
    }
    #endif
    #ifdef PIXEL
    extern number bottomY;   // the map's bottom edge, canvas pixels
    extern number fadeHeight; // how far up from it the darkening reaches
    extern number darkness;
    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec4 c = Texel(tex, uv) * color;
      float t = clamp((bottomY - canvasY) / fadeHeight, 0.0, 1.0); // 0 at the bottom, 1 at the top of the fade
      c.rgb *= 1.0 - darkness * (1.0 - t);
      return c;
    }
    #endif
  `);
  return groundShadeShader;
}

let blurShader = null;
function getBlurShader() {
  if (blurShader) return blurShader;
  blurShader = love.graphics.newShader(`
    extern vec2 stepUV; // one texel along the blur's direction
    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec4 sum = Texel(tex, uv) * 0.2270270;
      sum += (Texel(tex, uv + stepUV * 1.3846154) + Texel(tex, uv - stepUV * 1.3846154)) * 0.3162162;
      sum += (Texel(tex, uv + stepUV * 3.2307692) + Texel(tex, uv - stepUV * 3.2307692)) * 0.0702703;
      return sum * color;
    }
  `);
  return blurShader;
}

// Bakes the tile layers into one canvas. Lava tiles are skipped: the lava
// (WaterSystem.js's liquid) is drawn over it, and it flows away from
// where it started — the sheet's flat red tile art would show wherever
// it's run off from, as if still lava.
function bakeLayers(tileLayers, tilesets, tileProps, width, height, img) {
  const drawLayerTiles = (l, scale, ox, oy) => {
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const gid = l.data[row * width + col] ?? 0;
        if (gid !== 0 && classifyGid(tileProps, gid) !== 'lava') {
          const ts = findTileset(tilesets, gid);
          if (ts) {
            const quad = getTileQuadForLocalIndex(img, gid - ts.firstgid, ts.columns ?? DEFAULT_TILESET_COLUMNS);
            love.graphics.draw(img, quad, ox + col * TILE_WORLD_SIZE * scale, oy + row * TILE_WORLD_SIZE * scale,
              0, TILE_SCALE * scale, TILE_SCALE * scale);
          }
        }
      }
    }
  };

  // A soft shadow of `casters` (layers in front) multiplied over
  // everything baked so far. Made small: white, with the casters'
  // silhouettes laid over it in black at SHADOW_STRENGTH (offset),
  // blurred, then stretched back up over the canvas.
  const sw = Math.ceil(width * TILE_WORLD_SIZE / SHADOW_DOWNSCALE);
  const sh = Math.ceil(height * TILE_WORLD_SIZE / SHADOW_DOWNSCALE);
  let shadowA = null, shadowB = null;
  const castShadow = (casters, onto) => {
    shadowA = shadowA ?? love.graphics.newCanvas(sw, sh);
    shadowB = shadowB ?? love.graphics.newCanvas(sw, sh);
    shadowA.setFilter('linear', 'linear');
    shadowB.setFilter('linear', 'linear');
    love.graphics.setCanvas(shadowA);
    love.graphics.clear(1, 1, 1, 1);
    love.graphics.setColor(0, 0, 0, SHADOW_STRENGTH);
    const s = 1 / SHADOW_DOWNSCALE;
    for (const l of casters) drawLayerTiles(l, s, SHADOW_OFFSET_X * s, SHADOW_OFFSET_Y * s);
    const blur = getBlurShader();
    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.setShader(blur);
    for (let n = 0; n < SHADOW_BLUR; n++) {
      love.graphics.setCanvas(shadowB);
      blur.send('stepUV', [1 / sw, 0]);
      love.graphics.draw(shadowA);
      love.graphics.setCanvas(shadowA);
      blur.send('stepUV', [0, 1 / sh]);
      love.graphics.draw(shadowB);
    }
    love.graphics.setShader();
    love.graphics.setCanvas(onto);
    love.graphics.setBlendMode('multiply', 'premultiplied');
    love.graphics.draw(shadowA, 0, 0, 0, SHADOW_DOWNSCALE, SHADOW_DOWNSCALE);
    love.graphics.setBlendMode('alpha');
  };

  const canvas = love.graphics.newCanvas(width * TILE_WORLD_SIZE, height * TILE_WORLD_SIZE);
  love.graphics.push('all');
  love.graphics.origin();
  love.graphics.setCanvas(canvas);
  love.graphics.clear(0, 0, 0, 0);
  for (let i = 0; i < tileLayers.length; i++) {
    const l = tileLayers[i];
    love.graphics.setColor(1, 1, 1, 1);
    const shadeRows = GROUND_SHADE_ROWS[String(l.name ?? '').toLowerCase()];
    if (shadeRows && shadeRows > 0) {
      const shade = getGroundShadeShader();
      shade.send('bottomY', height * TILE_WORLD_SIZE);
      shade.send('fadeHeight', shadeRows * TILE_WORLD_SIZE);
      shade.send('darkness', GROUND_SHADE_DARKNESS);
      love.graphics.setShader(shade);
    }
    drawLayerTiles(l, 1, 0, 0);
    love.graphics.setShader();
    if (SHADOWED_LAYERS[String(l.name ?? '').toLowerCase()]) {
      // The shadow of the next layer in front (only the next: one further
      // forward casts its own over this one too, when that one's done).
      const nextLayer = tileLayers[i + 1];
      if (nextLayer) castShadow([nextLayer], canvas);
    }
  }
  love.graphics.pop();
  love.graphics.setColor(1, 1, 1, 1);
  if (shadowA) { shadowA.release(); shadowB.release(); }
  return canvas;
}

export { bakeLayers };
export { TiledTerrain as api };
