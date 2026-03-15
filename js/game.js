// js/game.js
import { state } from './state.js';
import {
  DRAG,
  PLANET_SPEED,
  PLAYER_RADIUS,
  COIN_RADIUS,
  ENEMY_RADIUS,
  STAR_COUNT,
  planetColors,
  enemyColors
} from './constants.js';
import { Vector2 } from './vector2.js';
import { Planetoid } from './world/Planetoid.js';
import { SpikeyPlanetoid } from './world/SpikeyPlanetoid.js';
import { BeamPlanetoid } from './world/BeamPlanetoid.js';
import { MazeInterior } from './interiors/MazeInterior.js';
import { PlatformInterior } from './interiors/PlatformInterior.js';
import { Asteroid } from './entities/world/Asteroid.js';
import { Player } from './entities/Player.js';
import { SpaceGhost } from './entities/world/SpaceGhost.js';
import { Coin } from './entities/world/Coin.js';
import { BlobMonster } from './entities/interior/BlobMonster.js';
import { MazeGhost } from './entities/interior/MazeGhost.js';
import { GravitySystem } from './systems/GravitySystem.js';
import { CollisionSystem } from './systems/CollisionSystem.js';
import { AISystem } from './systems/AISystem.js';
import { AudioManager } from './AudioManager.js';
import { angleDiff, initResizeListener, createParticles } from './utils.js';

// Setup canvas and ctx
state.canvas = document.getElementById('gameCanvas');
state.ctx = state.canvas.getContext('2d');
// Set initial canvas size
state.canvas.width = window.innerWidth;
state.canvas.height = window.innerHeight;
state.sceneWidth = state.canvas.width * 2;
state.sceneHeight = state.canvas.height * 2;

// Load planet texture
state.planetTexture = new Image();
state.planetTexture.src = "img/planet_texture_2.jpg";
state.planetTexture.onload = () => {
  initGame();
  gameLoop();
};

// Init audio and resize
state.audioManager = new AudioManager();
initResizeListener();

// Generate initial stars
state.stars = [];
for (let i = 0; i < STAR_COUNT; i++) {
  state.stars.push({
    x: Math.random() * state.sceneWidth,
    y: Math.random() * state.sceneHeight,
    size: Math.random() * 2 + 1
  });
}

// Systems
let gravitySystem;
let collisionSystem = new CollisionSystem();
let aiSystem = new AISystem();

// Event listeners
window.addEventListener('keydown', (e) => {
  state.keys[e.key] = true;
  if (e.key === ' ') {
    if (state.player.onSurface && state.player.mode != "maze") state.player.jump();
    else if (state.player.mode != "maze") state.player.tryGroundPound();
  }
  if (e.key === 'ArrowDown' && state.player.mode != "maze") {
    if (state.player.onSurface && state.player.currentPlanet instanceof BeamPlanetoid) {
      const diff = angleDiff(state.player.angle, state.player.currentPlanet.beamAngle);
      if (diff < Math.PI / 5) {
        state.player.startTeleport(state.player.currentPlanet.interior instanceof MazeInterior ? "maze" : "platform");
      }
    }
  }
  if (e.key === 'Enter') {
    if (state.gameOver) {
      state.score = 0;
      state.level = 1;
      initGame();
    } else if (state.levelComplete) {
      state.level++;
      initGame();
      state.levelComplete = false;
    }
  }
});
window.addEventListener('keyup', (e) => { state.keys[e.key] = false; });

function initGame() {
  state.starCanvas = document.createElement('canvas');
  state.starCanvas.width = state.sceneWidth;
  state.starCanvas.height = state.sceneHeight;
  const starCtx = state.starCanvas.getContext('2d');
  starCtx.fillStyle = 'white';
  state.stars.forEach(star => {
    starCtx.beginPath();
    starCtx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
    starCtx.fill();
  });

  state.planetoids = [];
  // Create regular planetoids
  for (let i = 0; i < 44; i++) {
    const radius = 30 + Math.random() * 40; // 30-70
    const x = radius + Math.random() * (state.sceneWidth - 2 * radius);
    const y = radius + Math.random() * (state.sceneHeight - 2 * radius);
    const color = planetColors[Math.floor(Math.random() * planetColors.length)];
    state.planetoids.push(new Planetoid(x, y, radius, color));
  }
  // Create spikey planetoids
  for (let i = 0; i < 16; i++) {
    const radius = 25 + Math.random() * 15; // 25-40
    const x = radius + Math.random() * (state.sceneWidth - 2 * radius);
    const y = radius + Math.random() * (state.sceneHeight - 2 * radius);
    state.planetoids.push(new SpikeyPlanetoid(x, y, radius));
  }
  // === SPECIAL MAZE PLANET ===
  state.mazePlanet = new BeamPlanetoid(state.sceneWidth * 0.55, state.sceneHeight * 0.45, 250, '#8A2BE2', 'rgba(255,0,255,1)');
  state.mazePlanet.interior = new MazeInterior(state.mazePlanet);
  state.planetoids.push(state.mazePlanet);
  // === SPECIAL PLATFORM PLANET ===
  state.platformPlanet = new BeamPlanetoid(state.sceneWidth * 0.3, state.sceneHeight * 0.6, 250, '#55aa55', 'rgba(57,255,20,1)');
  state.platformPlanet.interior = new PlatformInterior(state.platformPlanet);
  state.planetoids.push(state.platformPlanet);

  // === BLOB MONSTER on top platform ===
  const interior = state.platformPlanet.interior;
  const tile = interior.tileSize;

  // Placed right on the highest platform (column 13, sitting on row 1)
  interior.blobs = [
    new BlobMonster(
      interior,
      new Vector2(15 * tile + tile / 2, 1 * tile - 15),  // centered on top platform
      '#ff6600'  // bright orange blob
    ),
    new BlobMonster(
      interior,
      new Vector2(13 * tile + tile / 2, 1 * tile - 15),  // centered on top platform
      '#ff6600'  // bright orange blob
    ),
  ];

  // Initialize two miniature maze ghosts at random open positions
  let pos1 = state.mazePlanet.interior.getRandomPelletPos();
  let pos2 = state.mazePlanet.interior.getRandomPelletPos();
  while (pos2.col === pos1.col && pos2.row === pos1.row) {
    pos2 = state.mazePlanet.interior.getRandomPelletMazePos();
  }
  state.mazePlanet.interior.ghosts = [
    new MazeGhost(state.mazePlanet.interior, pos1.col, pos1.row, 'red'),
    new MazeGhost(state.mazePlanet.interior, pos2.col, pos2.row, 'pink')
  ];

  state.asteroids = [];
  for (let i = 0; i < 24; i++) {
    const radius = 20 + Math.random() * 25; // 20-45
    const x = radius + Math.random() * (state.sceneWidth - 2 * radius);
    const y = radius + Math.random() * (state.sceneHeight - 2 * radius);
    state.asteroids.push(new Asteroid(x, y, radius));
  }
  const regularPlanets = state.planetoids.filter(p => !p.isSpikey && p !== state.mazePlanet && p !== state.platformPlanet);
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
    let dist = a.pos.subtract(state.player.pos).length();
    while (dist < 200) {
      a.pos.x = a.radius + Math.random() * (state.sceneWidth - 2 * a.radius);
      a.pos.y = a.radius + Math.random() * (state.sceneHeight - 2 * a.radius);
      dist = a.pos.subtract(state.player.pos).length();
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
  state.player.mode = "space";
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

function gameLoop(timestamp) {

  if (state.lastFrameTime) {
    const delta = timestamp - state.lastFrameTime; // ms since last frame
    let instant = 1000 / delta;

    state.fps = state.fps * 0.9 + instant * 0.1;
  }
  state.lastFrameTime = timestamp;

  state.ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
  if (state.gameOver) {
    state.ctx.fillStyle = 'white';
    state.ctx.font = '48px Arial';
    state.ctx.textAlign = 'center';
    state.ctx.fillText('Game Over', state.canvas.width / 2, state.canvas.height / 2 - 20);
    state.ctx.font = '32px Arial';
    state.ctx.fillText(`Final Score: ${state.score}`, state.canvas.width / 2, state.canvas.height / 2 + 30);
    state.ctx.font = '24px Arial';
    state.ctx.fillText('Press Enter to Restart', state.canvas.width / 2, state.canvas.height / 2 + 70);
    state.player.isDying = 'false';
    requestAnimationFrame(gameLoop);
    return;
  } else if (state.levelComplete) {
    state.ctx.fillStyle = 'white';
    state.ctx.font = '48px Arial';
    state.ctx.textAlign = 'center';
    state.ctx.fillText('You beat the level!', state.canvas.width / 2, state.canvas.height / 2 - 20);
    state.ctx.font = '32px Arial';
    state.ctx.fillText(`Score: ${state.score}`, state.canvas.width / 2, state.canvas.height / 2 + 30);
    state.ctx.font = '24px Arial';
    state.ctx.fillText('Press Enter to start next level', state.canvas.width / 2, state.canvas.height / 2 + 70);
    requestAnimationFrame(gameLoop);
    return;
  }

  updatePlanetoids();
  if (state.player.mode == "maze") state.player.updateMazePosition();
  updateAsteroids();

  let toBreak = collisionSystem.handlePlanetAsteroidCollisions(state.planetoids, state.asteroids);
  collisionSystem.handleElasticCollisions(state.planetoids);
  collisionSystem.handleElasticCollisions(state.asteroids);

  for (let a of toBreak) {
    breakAsteroid(a);
  }

  // Only do normal player logic when NOT dying
  if (!state.player.isDying) {
    state.player.move(state.keys);
    if (state.player.mode != "maze") gravitySystem.applyTo(state.player);
    state.player.update();
    if (state.player.mode != "maze") collisionSystem.handlePlayerPlanetCollisions(state.player);
  } else {
    state.player.update(); // Run death animation
  }

  aiSystem.updateEnemies(state.enemies, state.planetoids);
  if (state.player.mode === "maze" && state.player.currentPlanet?.interior) {
    aiSystem.updateInteriorGhosts(state.player.currentPlanet.interior);
  }
  if (state.player.mode === "platform" && state.platformPlanet?.interior?.blobs) {
    state.platformPlanet.interior.blobs.forEach(b => b.update());
  }
  state.coins.forEach(c => c.update());
  state.particles.forEach(p => p.update());
  state.particles = state.particles.filter(p => p.life > 0);
  collisionSystem.handleCoinCollisions(state.player, state.coins);
  collisionSystem.handlePlayerAsteroidCollisions(state.player, state.asteroids);
  collisionSystem.handlePlayerEnemyCollisions(state.player, state.enemies);
  if (state.player.mode === "maze" && state.player.currentPlanet?.interior) {
    state.player.checkMazeDots();
  }
  if (state.coins.length === 0 && state.player.mode != "maze") {
    state.levelComplete = true;
  }
  // Camera follows player
  const camera = new Vector2();
  camera.x = state.player.pos.x - state.canvas.width / 2;
  camera.y = state.player.pos.y - state.canvas.height / 2;
  // Clamp camera to scene bounds
  if (camera.x < 0) camera.x = 0;
  if (camera.y < 0) camera.y = 0;
  if (camera.x > state.sceneWidth - state.canvas.width) camera.x = state.sceneWidth - state.canvas.width;
  if (camera.y > state.sceneHeight - state.canvas.height) camera.y = state.sceneHeight - state.canvas.height;
  state.ctx.save();
  state.ctx.translate(-camera.x, -camera.y);
  state.ctx.drawImage(state.starCanvas, 0, 0);

  state.planetoids.forEach(p => p.draw());
  state.asteroids.forEach(a => a.draw());
  state.player.draw();
  state.enemies.forEach(e => e.draw());
  state.coins.forEach(c => c.draw());
  state.particles.forEach(p => p.draw());
  state.ctx.restore();
  // HUD
  state.ctx.fillStyle = 'white';
  state.ctx.font = '24px Arial';
  state.ctx.textAlign = 'left';
  state.ctx.fillText(`Level ${state.level} - Score: ${state.score}`, 20, 40);
  state.ctx.fillText(`FPS: ${state.fps.toFixed(1)}`, 20, 70);
  requestAnimationFrame(gameLoop);
}