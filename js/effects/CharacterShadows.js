// js/effects/CharacterShadows.js
//
// Bob and the Ooombas casting soft shadows onto the Tiled level's tiles —
// only onto tiles, never onto the open background where there are none.
// Off to the same side as the shadows the level's layers cast onto each
// other (see TiledTerrain's SHADOW_OFFSET_X), but never down below their
// feet (see OFFSET_Y).
//
// Each frame (see main.js, which calls these where the level is drawn):
//   * CharacterShadows.prepare: Bob and the Ooombas drawn again, shifted
//     by OFFSET_X/Y, into a screen-sized canvas — just their shapes.
//   * CharacterShadows.drawOnto(level): the level's own baked canvas
//     drawn over itself through a shader that, at each of its pixels,
//     shows black where those shapes are (softened a little) — times how
//     much tile is there (the canvas's own alpha), so open background,
//     where it's clear, gets none.
// Drawn right after the level and before the characters themselves, so
// they stand on top of their own shadows.
//
// Ooombas also shadow each other: CharacterShadows.drawOntoOoomba, called
// after each one is drawn, lays the shadows of the ones in front of it
// (later in state.ooombas) over its sprite, the same way.

import love from '../love/index.js';
import state from '../state.js';
import TiledTerrain from '../world/TiledTerrain.js';

const CharacterShadows = {};

// ---------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------

const STRENGTH = 0.22; // how dark a shadow is, at its darkest
const SOFTNESS = 5;    // world units its edge is softened over
// Where the shadow lands, from the character: to the side, the same way
// the level's own shadows go (see TiledTerrain's SHADOW_OFFSET_X), but
// not down like theirs — a shadow under his feet would read as him
// floating off the ledge he's standing on, so it's lifted a little
// instead, enough that even its softened edge stays above his feet.
// (Read lazily: TiledTerrain imports modules that import this one.)
const offsetX = () => TiledTerrain.SHADOW_OFFSET_X;
const OFFSET_Y = -SOFTNESS;

// ---------------------------------------------------------------------

let casters = null;       // the screen-sized canvas the shapes are drawn into
let anyCaster = false;    // whether anything was drawn into it this frame
let ooombaCasters = null; // the same, for the Ooombas in front of one Ooomba (see drawOntoOoomba)

// `canvas`, or a new one in its place, sized to whatever's being drawn
// to: the screen, or a canvas.
function screenSized(canvas) {
  const target = love.graphics.getCanvas();
  let w, h;
  if (target) [w, h] = target.getDimensions(); else [w, h] = love.graphics.getDimensions();
  if (canvas && canvas.getWidth() === w && canvas.getHeight() === h) return canvas;
  if (canvas) canvas.release();
  return love.graphics.newCanvas(w, h);
}

let shader = null;
function getShader() {
  if (shader) return shader;
  shader = love.graphics.newShader(`
    extern Image casters;     // the shapes, screen-sized
    extern vec2 castersSize;  // its size, in pixels
    extern number softPx;     // how far round to soften, in pixels
    extern number strength;
    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      float tile = Texel(tex, uv).a;  // how much tile is here
      if (tile <= 0.0) return vec4(0.0);
      vec2 p = screen / castersSize;
      vec2 r = vec2(softPx) / castersSize;
      float a = Texel(casters, p).a * 0.2;
      a += (Texel(casters, p + vec2(r.x, 0.0)).a + Texel(casters, p - vec2(r.x, 0.0)).a
          + Texel(casters, p + vec2(0.0, r.y)).a + Texel(casters, p - vec2(0.0, r.y)).a) * 0.125;
      a += (Texel(casters, p + r * 0.7).a + Texel(casters, p - r * 0.7).a
          + Texel(casters, p + vec2(r.x, -r.y) * 0.7).a + Texel(casters, p - vec2(r.x, -r.y) * 0.7).a) * 0.075;
      return vec4(0.0, 0.0, 0.0, a * tile * strength);
    }
  `);
  return shader;
}

// Draws this frame's casters' shapes. Call in world space (inside the
// camera transform), before drawOnto.
CharacterShadows.prepare = function () {
  anyCaster = false;
  const player = state.player;
  const drawPlayer = player && !player.isDying && !player.portalTransit && !player.inPinball
    && !player.inCannon;
  const hasOoombas = state.ooombas && state.ooombas.length > 0;
  if (!(drawPlayer || hasOoombas)) return;

  casters = screenSized(casters);

  love.graphics.push('all');
  love.graphics.setCanvas(casters);
  love.graphics.clear(0, 0, 0, 0);
  love.graphics.translate(offsetX(), OFFSET_Y);
  love.graphics.setColor(1, 1, 1, 1);
  if (drawPlayer) {
    player.drawRig();
    anyCaster = true;
  }
  if (hasOoombas) {
    for (const o of state.ooombas) {
      if (!o.portalTransit) {
        o.draw();
        anyCaster = true;
      }
    }
  }
  love.graphics.pop();
};

// The shadows on `level`'s tiles. Call right after drawing the level.
CharacterShadows.drawOnto = function (level) {
  if (!(anyCaster && casters && level.canvas)) return;
  const s = getShader();
  const [pw, ph] = casters.getPixelDimensions();
  s.send('casters', casters);
  s.send('castersSize', [pw, ph]);
  s.send('softPx', SOFTNESS * (state.zoom ?? 1) * casters.getDPIScale());
  s.send('strength', STRENGTH);
  love.graphics.setShader(s);
  love.graphics.setColor(1, 1, 1, 1);
  love.graphics.draw(level.canvas, level.anchorX, level.anchorY);
  love.graphics.setShader();
};

// Shadows on state.ooombas[index] (0-based) from the Ooombas drawn after
// it (in front of it — later in the list draws on top) that are close
// enough to reach it. Call right after drawing it, in world space. The
// same shader as drawOnto, with the Ooomba's own sprite standing in for
// the level's tiles: shadow only where the sprite is.
CharacterShadows.drawOntoOoomba = function (index) {
  const ooombas = state.ooombas;
  const o = ooombas[index];
  if (o.portalTransit) return;
  const oSize = Math.max(o.drawWidth, o.drawHeight);
  let any = false;
  for (let j = index + 1; j < ooombas.length; j++) {
    const f = ooombas[j];
    // (Generous: each one's whole sprite size, plus the shadow's offset
    // and softened edge.)
    const reach = oSize + Math.max(f.drawWidth, f.drawHeight) + Math.abs(offsetX()) + Math.abs(OFFSET_Y) + SOFTNESS;
    const dx = f.pos.x - o.pos.x, dy = f.pos.y - o.pos.y;
    if (!f.portalTransit && dx * dx + dy * dy < reach * reach) {
      if (!any) {
        any = true;
        ooombaCasters = screenSized(ooombaCasters);
        love.graphics.push('all');
        love.graphics.setCanvas(ooombaCasters);
        love.graphics.clear(0, 0, 0, 0);
        love.graphics.translate(offsetX(), OFFSET_Y);
      }
      f.draw();
    }
  }
  if (!any) return;
  love.graphics.pop();

  const s = getShader();
  const [pw, ph] = ooombaCasters.getPixelDimensions();
  s.send('casters', ooombaCasters);
  s.send('castersSize', [pw, ph]);
  s.send('softPx', SOFTNESS * (state.zoom ?? 1) * ooombaCasters.getDPIScale());
  s.send('strength', STRENGTH);
  const prevShader = love.graphics.getShader();
  love.graphics.setShader(s);
  o.draw();
  love.graphics.setShader(prevShader);
};

export default CharacterShadows;
