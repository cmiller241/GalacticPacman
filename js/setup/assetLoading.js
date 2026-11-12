// js/setup/assetLoading.js
//
// Loads every texture into state (images were already fetched and decoded
// by love.boot's preload — see js/assetList.js — so newImage here is
// synchronous, like LÖVE's), and creates the AudioManager.

import love from '../love/index.js';
import state from '../state.js';
import AudioManager from '../AudioManager.js';

// Bob's posable rig (his wall slide, ground pound, curling into a ball —
// see js/entities/player/Rendering.js): each part of img/astronaut2.svg on
// its own, with its normal map, made by tools/bob-sprite-export.html. (His
// walking, standing and jumping come from sprite sheets instead: see
// js/entities/player/Sprite.js.)
const CHARACTER_IMAGE_SOURCES = {
  body: ['img/bob-rig-body.png', 'img/bob-rig-body_normal.png'],
  head: ['img/bob-rig-head.png', 'img/bob-rig-head_normal.png'],
  leftarm: ['img/bob-rig-leftarm.png', 'img/bob-rig-leftarm_normal.png'],
  rightarm: ['img/bob-rig-rightarm.png', 'img/bob-rig-rightarm_normal.png'],
  leftboot: ['img/bob-rig-leftboot.png', 'img/bob-rig-leftboot_normal.png'],
  rightboot: ['img/bob-rig-rightboot.png', 'img/bob-rig-rightboot_normal.png'],
};

function smooth(img) {
  img.setFilter('linear', 'linear');
  return img;
}

function loadAssets(onComplete) {
  const g = love.graphics;
  state.characterImages = {};

  state.planetTexture = g.newImage('img/planet_texture_2.jpg');
  state.platformTexture = g.newImage('img/platform.png');
  state.goombaTexture = g.newImage('img/goomba.png');
  state.oombaTexture = smooth(g.newImage('img/Ooomba.png'));
  // Its normal map and ambient occlusion, for its sun lighting (same
  // sheet layout as the sprite — see Ooomba.sunLightingShader).
  state.oombaNormalTexture = smooth(g.newImage('img/Ooomba_normal.png'));
  state.oombaAOTexture = smooth(g.newImage('img/Ooomba_ao.png'));
  state.grassTexture = g.newImage('img/grass.png');
  state.spaceShelterTexture = smooth(g.newImage('img/spaceshelter.png'));
  state.spaceShelterDoorTexture = smooth(g.newImage('img/spaceshelter_door.png'));
  state.signTexture = g.newImage('img/sign.png');
  state.signPlanetTexture = g.newImage('img/sign-planet.png');

  // Mining prism frames: one sheet of 1000-wide pictures, each cut into
  // an image of its own (so the mipmapped edge-finding blur in Prism.js
  // doesn't bleed one picture into the next).
  const MINING_FRAME_WIDTH = 1000;
  const miningSheet = love.image.newImageData('img/mining.png');
  const miningFrame = (index) => {
    const frame = love.image.newImageData(MINING_FRAME_WIDTH, miningSheet.getHeight());
    frame.paste(miningSheet, 0, 0, index * MINING_FRAME_WIDTH, 0, MINING_FRAME_WIDTH, miningSheet.getHeight());
    return smooth(g.newImage(frame, { mipmaps: true }));
  };
  const MINING_DAMAGED_FRAMES = 2;
  state.miningTexture = miningFrame(0);
  // (Indexed by damage stage 1..MINING_DAMAGED_FRAMES, as in the Lua.)
  state.miningDamagedTextures = [];
  for (let i = 1; i <= MINING_DAMAGED_FRAMES; i++) state.miningDamagedTextures[i] = miningFrame(i);

  // Inline button icons (see DialogueBox.js), keyed by UPPERCASE name.
  state.buttonIcons = {};
  for (const name of ['CIRCLE', 'SQUARE', 'TRIANGLE', 'CROSS', 'L1', 'L2', 'R1', 'R2',
    'UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER']) {
    state.buttonIcons[name] = g.newImage('img/prompt_' + name.toLowerCase() + '.png');
  }
  state.buttonIcons.X = state.buttonIcons.CROSS;
  // (The Circle button is a smooth 96x96 image scaled down, not pixel art.)
  state.buttonIcons.CIRCLE = smooth(g.newImage('img/prompt_circle.png', { mipmaps: true }));

  state.titleLogoTexture = smooth(g.newImage('img/title.png', { mipmaps: true }));

  state.promptIcons = {
    gamepad: state.buttonIcons.CIRCLE,
    keyboard: state.buttonIcons.ENTER,
  };

  state.robotTexture = smooth(g.newImage('img/Robot2.png'));
  state.textboxTexture = smooth(g.newImage('img/textbox.png'));

  state.fishermanImages = {
    body: smooth(g.newImage('img/Fisherman-Body.png')),
    arms: smooth(g.newImage('img/Fisherman-Arms.png')),
    head: smooth(g.newImage('img/Fisherman-Head.png')),
    line: smooth(g.newImage('img/Fisherman-Line.png')),
  };

  // (Each drawn far smaller than it is, so mipmapped; its normal map under
  // the same key in state.characterNormals.)
  state.characterNormals = {};
  for (const [key, [src, normalSrc]] of Object.entries(CHARACTER_IMAGE_SOURCES)) {
    state.characterImages[key] = smooth(g.newImage(src, { mipmaps: true }));
    state.characterNormals[key] = smooth(g.newImage(normalSrc, { mipmaps: true }));
  }
  state.bootImage = state.characterImages.leftboot;

  state.audioManager = AudioManager.new();

  if (onComplete) onComplete();
}

export default { loadAssets };
