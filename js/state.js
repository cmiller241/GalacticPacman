// js/state.js
//
// The game's one shared state object. Every module imports this same
// instance, so it doubles as the place systems hand data to each other
// (the player, the camera, every list of world objects).

const state = {};

state.sceneWidth = 0;
state.sceneHeight = 0;

state.player = null;

state.planetoids = []; // includes regular, spikey, and maze planets
state.asteroids = [];
state.enemies = [];    // ghosts
state.coins = [];
state.particles = [];

state.score = 0;
state.level = 1;
state.gameOver = false;
state.levelComplete = false;

state.stars = [];

// Lookup of held keys by LÖVE key name: state.keys['up'] = true.
state.keys = {};

state.eatDotIndex = 0;
state.lastAlphaUpdate = 0;
state.lastFrameTime = 0;
state.fps = 0;

export default state;
