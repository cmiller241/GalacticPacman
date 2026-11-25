// state.js
export const state = {
  canvas: null,
  ctx: null,
  sceneWidth: 0,   // the world's size (fixed; see WORLD_WIDTH in game.js)
  sceneHeight: 0,
  zoom: 1,         // world units -> CSS pixels (below 1 on small screens)
  pixelRatio: 1,   // CSS pixels -> canvas pixels (the screen's density, capped)
  player: null,
  planetoids: [], // Includes regular and spikey planets
  asteroids: [],
  enemies: [], // Ghosts
  coins: [],
  particles: [],
  score: 0,
  level: 1,
  gameOver: false,
  levelComplete: false,
  keys: {},
  eatDotIndex: 0,
  lastAlphaUpdate: 0, 
  lastFrameTime: 0,
  fps: 0
};

// export const state = {
//     canvas: null,
//     ctx: null,
//     sceneWidth: 0,
//     sceneHeight: 0,
//     player: null,
//     planetoids: [],  // Includes regular and spikey planets
//     asteroids: [],
//     enemies: [],  // Ghosts
//     coins: [],
//     particles: [],
//     score: 0,
//     level: 1,
//     gameOver: false,
//     levelComplete: false,
//     stars: [],
//     keys: {},
//     eatDotIndex: 0,
//     lastAlphaUpdate: 0,  // If needed globally

//     lastFrameTime: 0,
//     fps: 0
//     // Add any other runtime state here as needed
// };