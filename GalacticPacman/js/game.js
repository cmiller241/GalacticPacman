// js/game.js
import { state } from './state.js';
import {
  DRAG,
  PLANET_SPEED,
  PLAYER_RADIUS,
  COIN_RADIUS,
  ENEMY_RADIUS,
  planetColors,
  enemyColors
} from './constants.js';
import { Vector2, distance } from './vector2.js';
import { Planetoid } from './world/Planetoid.js';
import { SpikeyPlanetoid } from './world/SpikeyPlanetoid.js';
import { Asteroid } from './entities/world/Asteroid.js';
import { Player } from './entities/Player.js';
import { SpaceGhost } from './entities/world/SpaceGhost.js';
import { Coin } from './entities/world/Coin.js';
import { Starfield } from './world/Starfield.js';
import { initControls, input } from './input/Controls.js';
import { GravitySystem } from './systems/GravitySystem.js';
import { CollisionSystem } from './systems/CollisionSystem.js';
import { AISystem } from './systems/AISystem.js';
import { AudioManager } from './AudioManager.js';
import { createParticles } from './utils.js';
import { setBakeResolution } from './render/PlanetLook.js';

// ---- World and screen ----
// The world is a FIXED size, the same on every device (it used to be
// twice the window, which packed every planet into a tiny world on a
// phone). Small screens zoom the camera out instead, so they still see a
// useful slice of it.
const WORLD_WIDTH = 3600;
const WORLD_HEIGHT = 2200;
// The least world a screen should show along its shorter side; screens
// smaller than this (in CSS pixels) zoom out to fit it.
const MIN_VIEW = 640;
// Canvas pixels per CSS pixel, at most: sharp on high-density phone
// screens without paying for 3x the pixels.
const MAX_PIXEL_RATIO = 2;

state.sceneWidth = WORLD_WIDTH;
state.sceneHeight = WORLD_HEIGHT;
state.canvas = document.getElementById('gameCanvas');
state.ctx = state.canvas.getContext('2d');

// Sizes the canvas to the window (at the screen's pixel density) and
// works out the camera zoom.
function fitToScreen() {
  const cssW = window.innerWidth, cssH = window.innerHeight;
  const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
  state.pixelRatio = ratio;
  state.canvas.width = Math.round(cssW * ratio);
  state.canvas.height = Math.round(cssH * ratio);
  state.canvas.style.width = cssW + 'px';
  state.canvas.style.height = cssH + 'px';
  state.viewWidth = cssW;   // CSS pixels
  state.viewHeight = cssH;
  // Zoom out when the shorter side is under MIN_VIEW; never zoom in past
  // 1, and never so far out that the view is bigger than the world.
  let zoom = Math.min(1, Math.min(cssW, cssH) / MIN_VIEW);
  zoom = Math.max(zoom, cssW / WORLD_WIDTH, cssH / WORLD_HEIGHT);
  state.zoom = zoom;
  setBakeResolution(zoom * ratio);
}
fitToScreen();
window.addEventListener('resize', fitToScreen);

// Load planet texture
state.planetTexture = new Image();
state.planetTexture.src = "img/planet_texture_2.jpg";
state.planetTexture.onload = () => {
  initGame();
  requestAnimationFrame(gameLoop);
};

// Init audio
state.audioManager = new AudioManager();

const starfield = new Starfield();

// Systems
let gravitySystem;
let collisionSystem = new CollisionSystem();
let aiSystem = new AISystem();

// ---- Controls ----
// Hold to move: he walks while left or right is held (keys or the touch
// pad — see input/Controls.js) and stands still when let go. Right is
// always clockwise round his planet, left always counter-clockwise.

// Jump from a planet; in the air, a ground pound.
function jumpOrPound() {
  if (!state.player || state.gameOver || state.levelComplete) return;
  if (state.player.onSurface) state.player.jump();
  else state.player.tryGroundPound();
}

// Leave the Game Over / level-complete screen. Returns true if it did.
function continueFromScreen() {
  if (state.gameOver) {
    state.score = 0;
    state.level = 1;
    initGame();
    return true;
  }
  if (state.levelComplete) {
    state.level++;
    initGame();
    state.levelComplete = false;
    return true;
  }
  return false;
}

initControls(state.canvas, { onJump: jumpOrPound, onContinue: continueFromScreen });

// Phones keep sound switched off until the player touches the page; turn
// it on at the first touch, click or key (and again if the phone paused
// it, e.g. after switching apps). These listen in the CAPTURE phase so
// they run before the game's own handlers: the jump that a tap triggers
// then finds audio already switching on, instead of being silent.
for (const type of ['pointerdown', 'pointerup', 'touchend', 'keydown']) {
  window.addEventListener(type, () => state.audioManager.unlock(), { capture: true, passive: true });
}

function initGame() {
  state.planetoids = [];
  // Create regular planetoids
  for (let i = 0; i < 44; i++) {
    // 30-70 in 5px steps, so baked bodies can be shared (see PlanetLook.js)
    const radius = 30 + Math.floor(Math.random() * 9) * 5;
    const x = radius + Math.random() * (state.sceneWidth - 2 * radius);
    const y = radius + Math.random() * (state.sceneHeight - 2 * radius);
    const color = planetColors[Math.floor(Math.random() * planetColors.length)];
    state.planetoids.push(new Planetoid(x, y, radius, color));
  }
  // Create spikey planetoids
  for (let i = 0; i < 16; i++) {
    const radius = 25 + Math.floor(Math.random() * 4) * 5; // 25-40 in 5px steps
    const x = radius + Math.random() * (state.sceneWidth - 2 * radius);
    const y = radius + Math.random() * (state.sceneHeight - 2 * radius);
    state.planetoids.push(new SpikeyPlanetoid(x, y, radius));
  }
  state.asteroids = [];
  for (let i = 0; i < 24; i++) {
    const radius = 20 + Math.random() * 25; // 20-45
    const x = radius + Math.random() * (state.sceneWidth - 2 * radius);
    const y = radius + Math.random() * (state.sceneHeight - 2 * radius);
    state.asteroids.push(new Asteroid(x, y, radius));
  }
  const regularPlanets = state.planetoids.filter(p => !p.isSpikey);
  const startingPlanet = regularPlanets[Math.floor(Math.random() * regularPlanets.length)];
  const surfaceDist = startingPlanet.radius + PLAYER_RADIUS;
  state.player = new Player(startingPlanet.pos.x, startingPlanet.pos.y - surfaceDist);
  state.player.onSurface = true;
  state.player.currentPlanet = startingPlanet;
  state.player.lastInfluencePlanet = startingPlanet;
  state.player.angle = Math.atan2(state.player.pos.y - startingPlanet.pos.y, state.player.pos.x - startingPlanet.pos.x);
  state.enemies = [];
  const numEnemies = (2 + state.level) * 2;
  for (let i = 0; i < numEnemies; i++) {
    let planetIndex = Math.floor(Math.random() * regularPlanets.length);
    let selectedPlanet = regularPlanets[planetIndex];
    while (selectedPlanet === startingPlanet) {
      planetIndex = Math.floor(Math.random() * regularPlanets.length);
      selectedPlanet = regularPlanets[planetIndex];
    }
    const color = enemyColors[i % enemyColors.length];
    state.enemies.push(new SpaceGhost(selectedPlanet, color));
  }
  // Ensure asteroids not too close to player
  for (let a of state.asteroids) {
    let dist = distance(a.pos, state.player.pos);
    while (dist < 200) {
      a.pos.x = a.radius + Math.random() * (state.sceneWidth - 2 * a.radius);
      a.pos.y = a.radius + Math.random() * (state.sceneHeight - 2 * a.radius);
      dist = distance(a.pos, state.player.pos);
    }
  }
  state.coins = [];
  regularPlanets.forEach((planet) => {
    const numCoins = 4 + Math.floor(planet.radius / 10);
    for (let i = 0; i < numCoins; i++) {
      const coin = new Coin(planet);
      coin.angle = (i / numCoins) * Math.PI * 2 + Math.random() * 0.2;
      state.coins.push(coin);
    }
  });
  state.planetoids.forEach(p => p.createOffscreen());
  state.particles = [];
  state.gameOver = false;
  state.levelComplete = false;
  state.audioManager.reset(); // Reset sound index on restart

  gravitySystem = new GravitySystem(state.planetoids);
}

function updatePlanetoids() {
  for (const p of state.planetoids) {
    p.pos.add(p.vel);
    if (p.pos.x - p.radius < 0) { p.pos.x = p.radius; p.vel.x = -p.vel.x; }
    if (p.pos.x + p.radius > state.sceneWidth) { p.pos.x = state.sceneWidth - p.radius; p.vel.x = -p.vel.x; }
    if (p.pos.y - p.radius < 0) { p.pos.y = p.radius; p.vel.y = -p.vel.y; }
    if (p.pos.y + p.radius > state.sceneHeight) { p.pos.y = state.sceneHeight - p.radius; p.vel.y = -p.vel.y; }
  }
}

function updateAsteroids() {
  for (const a of state.asteroids) {
    a.update();
  }
}

function breakAsteroid(ast) {
  const index = state.asteroids.indexOf(ast);
  if (index > -1) {
    state.asteroids.splice(index, 1);
  }
  let size;
  if (ast.radius > 30) size = 'large';
  else if (ast.radius > 20) size = 'medium';
  else size = 'small';
  state.audioManager.playBang(size, ast.pos);
  createParticles(ast.pos, 150);
  if (ast.radius < 15) return;
  const numSmall = ast.radius > 30 ? 3 : 2;
  for (let i = 0; i < numSmall; i++) {
    const smallR = ast.radius / 2;
    const small = new Asteroid(ast.pos.x, ast.pos.y, smallR);
    const randVel = new Vector2(Math.random() * 2 - 1, Math.random() * 2 - 1).normalize().multiply(2 + Math.random() * 3);
    small.vel = ast.vel.clone().add(randVel);
    small.angle = Math.random() * Math.PI * 2;
    small.angularSpeed = (Math.random() * 2 - 1) * 0.1;
    state.asteroids.push(small);
  }
  createParticles(ast.pos, 10);
}

// ---- The loop ----
// The game logic runs in fixed steps of 1/60 s, however often the screen
// actually refreshes: a 120 Hz phone draws twice per step, a phone held
// to 30 fps runs two steps per drawn frame — the game plays at the same
// speed on both. (All the movement numbers in this game are "per 1/60 s".)
const STEP_MS = 1000 / 60;
// After a long stall (a hidden tab, a debugger pause) don't try to catch
// up on every missed step at once; just carry on.
const MAX_STEPS_PER_FRAME = 5;
let lastTime = null;
let pendingMs = 0;

function gameLoop(timestamp) {
  if (lastTime !== null) {
    const delta = timestamp - lastTime; // ms since last frame
    if (delta > 0) state.fps = state.fps * 0.9 + (1000 / delta) * 0.1;
    pendingMs += Math.min(delta, 250);
  }
  lastTime = timestamp;

  let steps = 0;
  while (pendingMs >= STEP_MS && steps < MAX_STEPS_PER_FRAME) {
    rememberPositions();
    update();
    pendingMs -= STEP_MS;
    steps++;
  }
  if (steps === MAX_STEPS_PER_FRAME) pendingMs = 0;

  // Draw part-way between the last two steps, by how far we are into the
  // next one. Without this, a frame that happens to run 0 steps and the
  // next that runs 2 (frame timing on phones wobbles around 1/60 s) make
  // everything visibly stutter even at a good frame rate.
  const blend = Math.min(1, pendingMs / STEP_MS);
  blendPositions(blend);
  render();
  restorePositions();
  requestAnimationFrame(gameLoop);
}

// ---- Smooth drawing between steps ----
// Before each step, every moving thing's position (and spin) is noted;
// render() then sees them blended between that and where the step put
// them, and they're put back afterwards so the game logic never sees it.
function movingThings() {
  return [state.planetoids, state.asteroids, state.enemies, state.coins, state.particles];
}

function rememberPositions() {
  if (state.player) {
    const p = state.player;
    p.prevX = p.pos.x; p.prevY = p.pos.y;
  }
  for (const list of movingThings()) {
    for (const e of list) {
      e.prevX = e.pos.x; e.prevY = e.pos.y;
      if (e instanceof Asteroid) e.prevAngle = e.angle;
    }
  }
}

function blendOne(e, t) {
  // (Things created during the last step have no earlier position yet.)
  if (e.prevX === undefined) { e.blended = false; return; }
  e.blended = true;
  e.realX = e.pos.x; e.realY = e.pos.y;
  e.pos.x = e.prevX + (e.realX - e.prevX) * t;
  e.pos.y = e.prevY + (e.realY - e.prevY) * t;
  if (e.prevAngle !== undefined) {
    e.realAngle = e.angle;
    e.angle = e.prevAngle + (e.realAngle - e.prevAngle) * t;
  }
}

function restoreOne(e) {
  if (!e.blended) return;
  e.pos.x = e.realX; e.pos.y = e.realY;
  if (e.prevAngle !== undefined) e.angle = e.realAngle;
  e.blended = false;
}

function blendPositions(t) {
  if (state.player) blendOne(state.player, t);
  for (const list of movingThings()) for (const e of list) blendOne(e, t);
}

function restorePositions() {
  if (state.player) restoreOne(state.player);
  for (const list of movingThings()) for (const e of list) restoreOne(e);
}

// Centered message screen (Game Over, level complete), in CSS pixels.
function drawMessageScreen(ctx, title, line, prompt) {
  const w = state.viewWidth, h = state.viewHeight;
  // Smaller text on small screens.
  const s = Math.min(1, Math.min(w, h) / 500);
  ctx.fillStyle = 'white';
  ctx.textAlign = 'center';
  ctx.font = `${Math.round(48 * s)}px Arial`;
  ctx.fillText(title, w / 2, h / 2 - 20 * s);
  ctx.font = `${Math.round(32 * s)}px Arial`;
  ctx.fillText(line, w / 2, h / 2 + 30 * s);
  ctx.font = `${Math.round(24 * s)}px Arial`;
  ctx.fillText(prompt, w / 2, h / 2 + 70 * s);
}

// One fixed step of game logic.
function update() {
  if (state.gameOver || state.levelComplete) return;

  updatePlanetoids();
  updateAsteroids();

  let toBreak = collisionSystem.handlePlanetAsteroidCollisions(state.planetoids, state.asteroids);
  collisionSystem.handleElasticCollisions(state.planetoids);
  collisionSystem.handleElasticCollisions(state.asteroids);

  for (let a of toBreak) {
    breakAsteroid(a);
  }

  // Only do normal player logic when NOT dying
  if (!state.player.isDying) {
    // Hold to move: walks while left/right is held, stands still otherwise.
    state.player.setMoveDirection((input.right ? 1 : 0) - (input.left ? 1 : 0));
    state.player.move();
    gravitySystem.applyTo(state.player);
    state.player.update();
    collisionSystem.handlePlayerPlanetCollisions(state.player);
  } else {
    state.player.update(); // Run death animation
  }

  aiSystem.updateEnemies(state.enemies, state.planetoids);
  state.coins.forEach(c => c.update());
  state.particles.forEach(p => p.update());
  state.particles = state.particles.filter(p => p.life > 0);
  collisionSystem.handleCoinCollisions(state.player, state.coins);
  collisionSystem.handlePlayerAsteroidCollisions(state.player, state.asteroids);
  collisionSystem.handlePlayerEnemyCollisions(state.player, state.enemies);
  if (state.coins.length === 0) {
    state.levelComplete = true;
  }
}

// Draws the current state (as often as the screen refreshes).
function render() {
  const ctx = state.ctx;
  const ratio = state.pixelRatio, zoom = state.zoom;
  const screenW = state.viewWidth, screenH = state.viewHeight; // CSS pixels

  // Screen space: CSS pixels.
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, screenW, screenH);

  if (state.gameOver) {
    drawMessageScreen(ctx, 'Game Over', `Final Score: ${state.score}`, 'Tap or press Enter to restart');
    state.player.isDying = 'false';
    return;
  }
  if (state.levelComplete) {
    drawMessageScreen(ctx, 'You beat the level!', `Score: ${state.score}`, 'Tap or press Enter for the next level');
    return;
  }

  // Camera follows the player: the world rectangle on screen, clamped to
  // the world's edges.
  const viewW = screenW / zoom, viewH = screenH / zoom; // world units
  const camera = new Vector2(state.player.pos.x - viewW / 2, state.player.pos.y - viewH / 2);
  camera.x = Math.max(0, Math.min(camera.x, state.sceneWidth - viewW));
  camera.y = Math.max(0, Math.min(camera.y, state.sceneHeight - viewH));

  // (The starfield is in screen pixels, so it scrolls by the camera's
  // on-screen movement.)
  starfield.draw(ctx, { x: camera.x * zoom, y: camera.y * zoom }, screenW, screenH);

  // World space.
  ctx.save();
  ctx.scale(zoom, zoom);
  ctx.translate(-camera.x, -camera.y);

  // Only draw what's on screen: most of the world is off camera at any
  // moment.
  const viewL = camera.x, viewT = camera.y;
  const viewR = viewL + viewW, viewB = viewT + viewH;
  const visible = (x, y, r) => x + r > viewL && x - r < viewR && y + r > viewT && y - r < viewB;

  // (Reach: the influence ring, plus its line width.)
  state.planetoids.forEach(p => { if (visible(p.pos.x, p.pos.y, p.influenceRadius + 3)) p.draw(); });
  // (Reach: the farthest a rock's corner can sit from its center.)
  state.asteroids.forEach(a => { if (visible(a.pos.x, a.pos.y, a.radius * 1.3 + 2)) a.draw(); });
  state.player.draw();
  state.enemies.forEach(e => { if (visible(e.pos.x, e.pos.y, e.radius * 2)) e.draw(); });
  Coin.drawAll(state.ctx, state.coins, visible);
  state.particles.forEach(p => p.draw());
  ctx.restore();

  // HUD (screen space; smaller text on small screens)
  const hud = Math.max(14, Math.min(24, Math.round(Math.min(screenW, screenH) / 25)));
  ctx.fillStyle = 'white';
  ctx.font = `${hud}px Arial`;
  ctx.textAlign = 'left';
  ctx.fillText(`Level ${state.level} - Score: ${state.score}`, hud, hud * 1.6);
  ctx.fillText(`FPS: ${state.fps.toFixed(1)}`, hud, hud * 2.9);
}