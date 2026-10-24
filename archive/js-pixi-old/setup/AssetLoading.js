// js/setup/assetLoading.js
// loadAssets(onComplete): kicks off every image load the game needs
// (planet/platform/grass/goomba textures plus all six astronaut body-
// part sprites) and calls onComplete() once every single one has
// finished — the game doesn't start until draw() has everything it
// needs to render the character. Takes onComplete as a callback,
// rather than calling initGame()/gameLoop() directly the way this
// logic used to inline them, specifically so this module has no
// dependency on levelSetup.js or game.js itself — game.js is the one
// that wires the two together (see its own top-level
// loadAssets(() => { initGame(); gameLoop(); }) call).
import { state } from '../state.js';
import { AudioManager } from '../AudioManager.js';
import { initResizeListener } from '../utils.js';

const CHARACTER_IMAGE_SOURCES = {
  body: 'img/body.png',
  head: 'img/head.png',
  leftarm: 'img/leftarm.png',
  rightarm: 'img/rightarm.png',
  leftboot: 'img/leftboot.png',
  rightboot: 'img/rightboot.png'
};

export function loadAssets(onComplete) {
  state.characterImages = {};

  let assetsLoaded = 0;
  const ASSETS_TO_LOAD = 4 + Object.keys(CHARACTER_IMAGE_SOURCES).length; // planet texture + platform texture + grass texture + goomba texture + 6 body parts
  function onAssetLoaded() {
    assetsLoaded++;
    if (assetsLoaded === ASSETS_TO_LOAD) {
      onComplete();
    }
  }

  state.planetTexture = new Image();
  state.planetTexture.src = "img/planet_texture_2.jpg";
  state.planetTexture.onload = onAssetLoaded;

  // SkyDomePlanetoid's ground tile — 32x32, tiled pixel-perfectly across
  // its body instead of the default rocky planetTexture (see
  // SkyDomePlanetoid.drawBodyTexture).
  // JumpPlatform's tileset — replaces the old ground.png (now unused
  // entirely, since JumpPlatform's pillar mechanism was removed in favor
  // of this tileset's own bottom-row tiles covering that role).
  state.platformTexture = new Image();
  state.platformTexture.src = "img/platform.png";
  state.platformTexture.onload = onAssetLoaded;

  // Goomba enemy — 64x32, two 32x32 tiles (standing, walking).
  state.goombaTexture = new Image();
  state.goombaTexture.src = "img/goomba.png";
  state.goombaTexture.onload = onAssetLoaded;

  // SkyDomePlanetoid's grass cap — a single 32x16 tile, drawn as a thin
  // strip right at the flat top line, on top of the metal base (see
  // SkyDomePlanetoid.drawGrassCap).
  state.grassTexture = new Image();
  state.grassTexture.src = "img/grass.png";
  state.grassTexture.onload = onAssetLoaded;

  Object.entries(CHARACTER_IMAGE_SOURCES).forEach(([key, src]) => {
    const img = new Image();
    img.src = src;
    img.onload = onAssetLoaded;
    state.characterImages[key] = img;
  });

  // The compact single-boot rendering (maze/platform/death modes) reuses
  // the same leftboot image — no need to load it twice.
  state.bootImage = state.characterImages.leftboot;

  // Init audio and resize
  state.audioManager = new AudioManager();
  initResizeListener();
}