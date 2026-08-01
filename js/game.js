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
import { RoundedRectPlanetoid } from './world/RoundedRectPlanetoid.js';
import { SpikeyPlanetoid } from './world/SpikeyPlanetoid.js';
import { BeamPlanetoid } from './world/BeamPlanetoid.js';
import { MazeInterior } from './interiors/MazeInterior.js';
import { PlatformInterior } from './interiors/PlatformInterior.js';
import { Asteroid } from './entities/world/Asteroid.js';
import { Player } from './entities/Player.js';
import { SpaceGhost } from './entities/world/SpaceGhost.js';
import { Coin } from './entities/world/Coin.js';
import { Explosion } from './entities/world/Explosion.js';
import { BlobMonster } from './entities/interior/BlobMonster.js';
import { MazeGhost } from './entities/interior/MazeGhost.js';
import { GravitySystem } from './systems/GravitySystem.js';
import { CollisionSystem } from './systems/CollisionSystem.js';
import { AISystem } from './systems/AISystem.js';
import { AudioManager } from './AudioManager.js';
import { angleDiff, initResizeListener, createParticles } from './utils.js';
import { Minimap } from './ui/MiniMap.js';
import { drawPullIndicator } from './effects/PullBeam.js';

// Setup canvas and ctx
state.canvas = document.getElementById('gameCanvas');
state.ctx = state.canvas.getContext('2d');
// Set initial canvas size
state.canvas.width = window.innerWidth;
state.canvas.height = window.innerHeight;

// ----------------------------
// CELL-BASED WORLD STREAMING
// ----------------------------
// The world is a fixed 20x20 grid of cells. state.sceneWidth/Height are
// now the FULL world size — a constant, independent of the browser
// window (unlike before, where they were derived from canvas size).
// Only a 3x3 neighborhood of cells around the player is ever populated
// at once; everything else is generated on approach and culled on
// departure. See generateCell()/updateActiveCells()/cullDistantObjects()
// below.
const CELL_SIZE = 3000; // world units per cell, both axes
const GRID_SIZE = 20;   // 20x20 cells total
const CENTER_CELL = { col: 10, row: 10 }; // where the permanent planets + player start live
const CELL_CHECK_INTERVAL = 15; // frames between generation/cull passes — doesn't need to run every frame

state.sceneWidth = CELL_SIZE * GRID_SIZE;
state.sceneHeight = CELL_SIZE * GRID_SIZE;
// Exposed so Minimap.js can draw the correct number of grid lines
// without needing a (circular) import back into this file.
state.gridSize = GRID_SIZE;

// Per-cell density. Divided down from the original single-scene counts
// (44 regular / 16 spikey / 24 asteroids) by roughly the 3x3 active-
// neighborhood size, so the worst case (all 9 cells populated) lands
// back near the original totals instead of ~9x them. Tune independently
// once you've seen it in play — no need to match the old numbers exactly.
const PLANETOIDS_PER_CELL = 10;
const SPIKEY_PER_CELL = 10;
const ASTEROIDS_PER_CELL = 20;
const MAX_ENEMIES_PER_CELL = 5;

// ----------------------------
// ASSET LOADING
// Planet texture + all six astronaut body-part sprites. Everything
// waits for all of these before the game starts, since draw() now
// needs the full set to render the character.
// ----------------------------
const CHARACTER_IMAGE_SOURCES = {
  body: 'img/body.png',
  head: 'img/head.png',
  leftarm: 'img/leftarm.png',
  rightarm: 'img/rightarm.png',
  leftboot: 'img/leftboot.png',
  rightboot: 'img/rightboot.png'
};

state.characterImages = {};

let assetsLoaded = 0;
const ASSETS_TO_LOAD = 1 + Object.keys(CHARACTER_IMAGE_SOURCES).length; // planet texture + 6 body parts
function onAssetLoaded() {
  assetsLoaded++;
  if (assetsLoaded === ASSETS_TO_LOAD) {
    initGame();
    gameLoop();
  }
}

state.planetTexture = new Image();
state.planetTexture.src = "img/planet_texture_2.jpg";
state.planetTexture.onload = onAssetLoaded;

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

// ----------------------------
// MOUSE TRACKING (for blaster aiming)
// Stored in canvas-space (relative to the canvas element). Player.js
// converts this to world space each frame using state.camera, which
// gameLoop() keeps up to date below.
// ----------------------------
state.mouse = { x: state.canvas.width / 2, y: state.canvas.height / 2 };
// Timestamp of the last actual mousemove event. Since mousemove only
// fires on real pointer movement, "idle" is simply checked as
// Date.now() - state.lastMouseMoveTime, no distance threshold needed.
state.lastMouseMoveTime = Date.now();
state.canvas.addEventListener('mousemove', (e) => {
  const rect = state.canvas.getBoundingClientRect();
  state.mouse.x = e.clientX - rect.left;
  state.mouse.y = e.clientY - rect.top;
  state.lastMouseMoveTime = Date.now();
});

// Hold left mouse button to fire the blaster (continuous fire is
// handled per-frame in gameLoop via state.mouseDown). We also fire
// immediately here on mousedown itself, so a quick click always
// produces at least one shot rather than depending on frame timing.
//
// Right mouse button selects/releases a "pull star" target (see
// Player.trySelectPullTarget/clearPullTarget) — right-clicking a new
// planet while already pulling something else just switches targets
// directly, no need to release first. The browser's default right-
// click context menu is suppressed so it doesn't pop up over the game.
state.mouseDown = false;
state.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
state.canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) {
    state.mouseDown = true;
    if (state.player) state.player.shootFireball();
  } else if (e.button === 2) {
    if (state.player) state.player.trySelectPullTarget();
  }
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) {
    state.mouseDown = false;
  } else if (e.button === 2) {
    if (state.player) state.player.clearPullTarget();
  }
});

state.fireballs = [];
state.explosions = [];

// Camera zoom (1 = default view; >1 zooms in, <1 zooms out). Held
// continuously with +/- (see gameLoop).
state.zoom = 1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
// Exposed so Player.js's sprite cache can bake at high enough
// resolution to stay crisp at the maximum zoom level, without ever
// needing to rebuild while zooming.
state.zoomMax = ZOOM_MAX;
const ZOOM_STEP_PER_FRAME = 0.02;

// ----------------------------
// AUTO-ZOOM ON MAZE ENTRY/EXIT
// ----------------------------
// While state.zoomTarget is non-null, gameLoop eases state.zoom toward
// it each frame (a decelerating ease, not a linear step, for a
// "graceful" feel) instead of waiting on +/- input. Entering the maze
// remembers whatever zoom the player had (state.preMazeZoom) and sets
// a target of ZOOM_MAX; leaving restores that remembered value.
// Pressing +/- manually at any point immediately cancels the target
// (sets it back to null), so auto-zoom never fights manual input.
state.zoomTarget = null;
state.preMazeZoom = state.zoom;
let previousPlayerMode = null; // tracked frame-to-frame in gameLoop to detect maze entry/exit
const ZOOM_EASE_RATE = 0.06; // fraction of remaining distance closed per frame — higher = snappier, lower = more gradual
const ZOOM_EASE_SNAP_THRESHOLD = 0.01; // once this close to the target, just snap to it and stop easing

// How hard a fireball impact shoves a planet (scaled by the fireball's
// own speed, same pattern as GROUND_POUND_PUSH_STRENGTH). Tune to taste.
const FIREBALL_PLANET_PUSH_STRENGTH = 0.05;

// ----------------------------
// STARFIELD (tileable, not world-sized)
// ----------------------------
// The old approach pre-rendered every star onto ONE canvas sized to the
// whole scene. That worked at the old (canvas-sized) scene, but a
// 20x20-cell world is 60000x60000 — far beyond what a <canvas> can even
// be (and would be gigabytes of memory if it somehow could). Instead,
// a small tile is rendered once and repeated across whatever's
// currently visible each frame (see gameLoop) — same look, no cap on
// world size, and it never needs rebuilding (not tied to window size,
// unlike the old resize-triggered regeneration).
const STAR_TILE_SIZE = 2000;
state.starTileSize = STAR_TILE_SIZE;
state.starCanvas = document.createElement('canvas');
state.starCanvas.width = STAR_TILE_SIZE;
state.starCanvas.height = STAR_TILE_SIZE;
{
  const starCtx = state.starCanvas.getContext('2d');
  starCtx.fillStyle = 'white';
  for (let i = 0; i < STAR_COUNT; i++) {
    const x = Math.random() * STAR_TILE_SIZE;
    const y = Math.random() * STAR_TILE_SIZE;
    const size = Math.random() * 2 + 1;
    starCtx.beginPath();
    starCtx.arc(x, y, size, 0, Math.PI * 2);
    starCtx.fill();
  }
}

// Systems
let gravitySystem;
let collisionSystem = new CollisionSystem();
let aiSystem = new AISystem();
const minimap = new Minimap();
let cellCheckCounter = 0;

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

// ----------------------------
// CELL HELPERS
// ----------------------------
function cellCoordFor(worldX, worldY) {
  return {
    col: Math.floor(worldX / CELL_SIZE),
    row: Math.floor(worldY / CELL_SIZE)
  };
}

function cellKey(col, row) {
  return `${col},${row}`;
}

// Populates one cell with regular/spikey planetoids, asteroids, coins
// (one batch per regular planetoid, same density formula as before),
// and up to MAX_ENEMIES_PER_CELL enemies. No-ops (returns []) if this
// cell is already active. Returns the regular planetoids it created —
// only used by initGame() to pick a starting planet for the player.
// Phase 1: just the regular (non-hazardous) planetoids for a cell.
// Split out from hazard generation below specifically so initGame() can
// generate these FIRST, pick a starting planet from them, and only then
// generate hazards for that same cell — now knowing exactly what to
// steer them away from. Every other cell just runs both phases back to
// back via generateCell() with no avoidance, same as before.
function generateRegularPlanetoidsInCell(col, row) {
  const originX = col * CELL_SIZE;
  const originY = row * CELL_SIZE;
  const regularPlanetoids = [];

  for (let i = 0; i < PLANETOIDS_PER_CELL; i++) {
    const radius = 30 + Math.random() * 40; // 30-70
    const x = originX + radius + Math.random() * (CELL_SIZE - 2 * radius);
    const y = originY + radius + Math.random() * (CELL_SIZE - 2 * radius);
    const color = planetColors[Math.floor(Math.random() * planetColors.length)];
    const p = new Planetoid(x, y, radius, color);
    p.createOffscreen();
    state.planetoids.push(p);
    regularPlanetoids.push(p);
  }

  return regularPlanetoids;
}

// Phase 2: spikey planetoids, asteroids, coins, and enemies for a cell.
// avoidPos/avoidRadius are optional — when given (only used for the
// player's starting cell, see initGame()), spikey planetoids and
// asteroids reroll their position (up to a bounded number of attempts,
// rather than looping forever if a cell is crowded) until they land
// outside avoidRadius of avoidPos, and enemies are only assigned to
// planets that are themselves far enough away. Coins aren't touched —
// they aren't hazards, and regular planetoids close to the player are
// fine (only spikey/asteroids/enemies can kill on contact).
function generateHazardsAndExtrasInCell(col, row, regularPlanetoids, avoidPos = null, avoidRadius = 0) {
  const originX = col * CELL_SIZE;
  const originY = row * CELL_SIZE;
  const MAX_REROLLS = 20;
  const avoidRadiusSq = avoidRadius * avoidRadius;
  const isSafe = (x, y) => !avoidPos || ((x - avoidPos.x) ** 2 + (y - avoidPos.y) ** 2) >= avoidRadiusSq;

  for (let i = 0; i < SPIKEY_PER_CELL; i++) {
    const radius = 25 + Math.random() * 15; // 25-40
    let x, y, attempts = 0;
    do {
      x = originX + radius + Math.random() * (CELL_SIZE - 2 * radius);
      y = originY + radius + Math.random() * (CELL_SIZE - 2 * radius);
      attempts++;
    } while (!isSafe(x, y) && attempts < MAX_REROLLS);
    const p = new SpikeyPlanetoid(x, y, radius);
    p.createOffscreen();
    state.planetoids.push(p);
  }

  for (let i = 0; i < ASTEROIDS_PER_CELL; i++) {
    const radius = 20 + Math.random() * 25; // 20-45
    let x, y, attempts = 0;
    do {
      x = originX + radius + Math.random() * (CELL_SIZE - 2 * radius);
      y = originY + radius + Math.random() * (CELL_SIZE - 2 * radius);
      attempts++;
    } while (!isSafe(x, y) && attempts < MAX_REROLLS);
    state.asteroids.push(new Asteroid(x, y, radius));
  }

  regularPlanetoids.forEach((planet) => {
    const numCoins = 4 + Math.floor(planet.radius / 10);
    for (let i = 0; i < numCoins; i++) {
      const coin = new Coin(planet);
      coin.angle = (i / numCoins) * Math.PI * 2 + Math.random() * 0.2;
      state.coins.push(coin);
    }
  });

  // Enemies don't have an independent spawn position to reroll — they're
  // tied to a planet — so instead we just restrict which planets are
  // eligible to host one.
  const safePlanetsForEnemies = avoidPos
    ? regularPlanetoids.filter(p => isSafe(p.pos.x, p.pos.y))
    : regularPlanetoids;
  const numEnemies = Math.min(MAX_ENEMIES_PER_CELL, safePlanetsForEnemies.length);
  for (let i = 0; i < numEnemies; i++) {
    const planet = safePlanetsForEnemies[Math.floor(Math.random() * safePlanetsForEnemies.length)];
    const color = enemyColors[i % enemyColors.length];
    state.enemies.push(new SpaceGhost(planet, color));
  }
}

// Normal (no-avoidance) full generation for a cell — both phases back
// to back. Used for every cell EXCEPT the player's starting one, which
// initGame() generates in two separate steps instead (see there).
function generateCell(col, row) {
  const key = cellKey(col, row);
  if (state.activeCells.has(key)) return [];
  state.activeCells.add(key);
  const regularPlanetoids = generateRegularPlanetoidsInCell(col, row);
  generateHazardsAndExtrasInCell(col, row, regularPlanetoids);
  return regularPlanetoids;
}

// Removes anything whose CURRENT position (not spawn origin — objects
// drift between cells via their own velocity) has fallen outside the
// active neighborhood. Planetoids are mutated IN PLACE (spliced, not
// filtered-and-reassigned) so GravitySystem's cached array reference —
// captured once at construction — stays valid; reassigning
// state.planetoids here would silently break gravity for anything
// generated or culled after the first pass.
function cullDistantObjects(activeCellKeys) {
  for (let i = state.planetoids.length - 1; i >= 0; i--) {
    const p = state.planetoids[i];
    if (p.isPermanent) continue;
    const { col, row } = cellCoordFor(p.pos.x, p.pos.y);
    if (!activeCellKeys.has(cellKey(col, row))) {
      state.planetoids.splice(i, 1);
    }
  }

  // Built AFTER the planetoid splice above, so it reflects exactly
  // what survived — used below to detect "this coin/enemy's planet was
  // just culled" in O(1) rather than an O(n) Array.includes() per item.
  const survivingPlanetoids = new Set(state.planetoids);

  state.asteroids = state.asteroids.filter(a => {
    const { col, row } = cellCoordFor(a.pos.x, a.pos.y);
    return activeCellKeys.has(cellKey(col, row));
  });

  // Coins are tied to a planet's orbit, not an independent position —
  // cull them by their PARENT planet's cell, not their own. Their own
  // position drifts around the planet via the orbit offset, and right
  // when a planet sits near a cell boundary, a coin at the wrong point
  // in its orbit can momentarily compute into a DIFFERENT (still-
  // active) cell than its planet's — letting that one coin survive a
  // pass that removes its planet, which is exactly the "orbiting
  // nothing" bug. Tying it directly to the planet's own position (and
  // treating a just-culled planet as "gone") makes a coin's lifetime
  // strictly match its planet's, with no gap for this to happen.
  state.coins = state.coins.filter(c => {
    if (!c.planet || !survivingPlanetoids.has(c.planet)) return false;
    const { col, row } = cellCoordFor(c.planet.pos.x, c.planet.pos.y);
    return activeCellKeys.has(cellKey(col, row));
  });

  // Enemies have the same risk while grounded (orbiting a planet the
  // same way coins do), but can also be genuinely mid-flight between
  // planets (onSurface === false), where they really do have an
  // independent position — so only grounded enemies defer to their
  // planet; flying ones are culled by their own position as before.
  state.enemies = state.enemies.filter(e => {
    if (e.onSurface && e.planet) {
      if (!survivingPlanetoids.has(e.planet)) return false;
      const { col, row } = cellCoordFor(e.planet.pos.x, e.planet.pos.y);
      return activeCellKeys.has(cellKey(col, row));
    }
    const { col, row } = cellCoordFor(e.pos.x, e.pos.y);
    return activeCellKeys.has(cellKey(col, row));
  });
}

// The main streaming tick: figures out the player's current cell,
// generates any of the surrounding 3x3 neighborhood that isn't already
// active, deactivates any cell that fell 2+ away (so it regenerates
// fresh if revisited later — no long-term memory of past contents is
// kept), then culls anything outside the resulting active set.
function updateActiveCells() {
  const playerCell = cellCoordFor(state.player.pos.x, state.player.pos.y);
  const activeCellKeys = new Set();

  for (let dRow = -1; dRow <= 1; dRow++) {
    for (let dCol = -1; dCol <= 1; dCol++) {
      const col = playerCell.col + dCol;
      const row = playerCell.row + dRow;
      if (col < 0 || col >= GRID_SIZE || row < 0 || row >= GRID_SIZE) continue; // off the edge of the 20x20 world
      const key = cellKey(col, row);
      activeCellKeys.add(key);
      generateCell(col, row); // no-op if already active
    }
  }

  for (const key of Array.from(state.activeCells)) {
    if (!activeCellKeys.has(key)) {
      state.activeCells.delete(key);
    }
  }

  cullDistantObjects(activeCellKeys);
}

function initGame() {
  state.planetoids = [];
  state.asteroids = [];
  state.coins = [];
  state.enemies = [];
  state.activeCells = new Set();

  const centerOriginX = CENTER_CELL.col * CELL_SIZE;
  const centerOriginY = CENTER_CELL.row * CELL_SIZE;

  // === SPECIAL MAZE PLANET === (fixed, permanent — lives in the center cell)
  state.mazePlanet = new BeamPlanetoid(centerOriginX + CELL_SIZE * 0.55, centerOriginY + CELL_SIZE * 0.45, 250, '#8A2BE2', 'rgba(255,0,255,1)');
  state.mazePlanet.interior = new MazeInterior(state.mazePlanet);
  state.mazePlanet.isPermanent = true;
  state.planetoids.push(state.mazePlanet);

  // === SPECIAL PLATFORM PLANET ===
  state.platformPlanet = new BeamPlanetoid(centerOriginX + CELL_SIZE * 0.3, centerOriginY + CELL_SIZE * 0.6, 250, '#55aa55', 'rgba(57,255,20,1)');
  state.platformPlanet.interior = new PlatformInterior(state.platformPlanet);
  state.platformPlanet.isPermanent = true;
  state.planetoids.push(state.platformPlanet);

  // === ROUNDED-RECT PLANET ===
  state.rectPlanet = new RoundedRectPlanetoid(
    centerOriginX + CELL_SIZE * 0.75, centerOriginY + CELL_SIZE * 0.7,
    150, 90, 35,
    '#cc8844'
  );
  state.rectPlanet.isPermanent = true;
  state.planetoids.push(state.rectPlanet);

  // Bake all three permanent planets' textures once.
  state.mazePlanet.createOffscreen();
  state.platformPlanet.createOffscreen();
  state.rectPlanet.createOffscreen();

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

  // Generate the center cell's REGULAR planetoids first (Phase 1 only —
  // no hazards yet) so there's something to spawn the player on; we
  // need to know exactly where the player ends up before we can steer
  // spikey planetoids/asteroids/enemies away from that spot.
  state.activeCells.add(cellKey(CENTER_CELL.col, CENTER_CELL.row));
  const centerRegulars = generateRegularPlanetoidsInCell(CENTER_CELL.col, CENTER_CELL.row);
  const startingPlanet = centerRegulars[Math.floor(Math.random() * centerRegulars.length)];
  const surfaceDist = startingPlanet.radius + PLAYER_RADIUS;
  state.player = new Player(startingPlanet.pos.x, startingPlanet.pos.y - surfaceDist);
  state.player.onSurface = true;
  state.player.currentPlanet = startingPlanet;
  state.player.lastInfluencePlanet = startingPlanet;
  state.player.angle = Math.atan2(state.player.pos.y - startingPlanet.pos.y, state.player.pos.x - startingPlanet.pos.x);
  state.player.mode = "space";

  // Now that the player's starting position is known, generate hazards
  // for that same cell (Phase 2), steering spikey planetoids, asteroids,
  // and enemy placement away from it — so nothing instantly-lethal ever
  // spawns right on top of a brand new player. "Moderately away" — tune
  // to taste.
  const SAFE_SPAWN_RADIUS = 400;
  generateHazardsAndExtrasInCell(CENTER_CELL.col, CENTER_CELL.row, centerRegulars, state.player.pos, SAFE_SPAWN_RADIUS);

  updateActiveCells(); // fills in the other 8 cells around the player's starting position

  state.particles = [];
  state.fireballs = [];
  state.explosions = [];
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
    if (p.isRoundedRect) {
      p.rotationAngle += p.rotationSpeed;
    }
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
    if (state.player.mode != "maze") {
      // While pulling toward a right-clicked planet, that pull replaces
      // normal gravity entirely for this frame rather than adding to
      // it — see the comment on Player's pullTarget for why.
      if (state.player.pullTarget) {
        state.player.applyPullForce();
      } else {
        gravitySystem.applyTo(state.player);
      }
    }
    state.player.update();
    if (state.player.mode != "maze") collisionSystem.handlePlayerPlanetCollisions(state.player);
    if (state.mouseDown) state.player.shootFireball();
  } else {
    state.player.update(); // Run death animation
  }

  aiSystem.updateEnemies(state.enemies, state.planetoids);
  if (state.player.mode === "maze" && state.player.currentPlanet?.interior) {
    aiSystem.updateInteriorGhosts(state.player.currentPlanet.interior);
    collisionSystem.handlePlayerMazeGhostCollisions(state.player, state.player.currentPlanet.interior.ghosts);
  }
  if (state.player.mode === "platform" && state.platformPlanet?.interior?.blobs) {
    state.platformPlanet.interior.blobs.forEach(b => b.update());
  }
  state.coins.forEach(c => c.update());
  state.fireballs.forEach(f => f.update());

  const fireballResults = collisionSystem.handleFireballCollisions(state.fireballs, state.planetoids, state.asteroids);
  for (const a of fireballResults.toBreakAsteroids) {
    breakAsteroid(a);
    state.explosions.push(new Explosion(a.pos.x, a.pos.y));
  }
  for (const hit of fireballResults.planetHits) {
    const speed = hit.fireball.vel.length();
    const pushDir = hit.fireball.vel.clone().normalize(); // planet gets knocked further along the fireball's own path, away from the shooter
    hit.planet.vel.add(pushDir.multiply(speed * FIREBALL_PLANET_PUSH_STRENGTH));
    state.explosions.push(new Explosion(hit.fireball.pos.x, hit.fireball.pos.y));
  }
  state.fireballs = state.fireballs.filter(f => !f.isDead && !fireballResults.hitFireballs.has(f));

  state.explosions.forEach(e => e.update());
  state.explosions = state.explosions.filter(e => !e.isDead);

  state.particles.forEach(p => p.update());
  state.particles = state.particles.filter(p => p.life > 0);
  collisionSystem.handleCoinCollisions(state.player, state.coins);
  collisionSystem.handlePlayerAsteroidCollisions(state.player, state.asteroids);
  collisionSystem.handlePlayerEnemyCollisions(state.player, state.enemies);
  if (state.player.mode === "maze" && state.player.currentPlanet?.interior) {
    state.player.checkMazeDots();
  }

  // Coin-based win condition removed — coins now stream in/out with
  // the active cell neighborhood, so "collect every coin" is no longer
  // a coherent goal (there's no longer a finite, knowable set of them).
  // state.levelComplete is left in place structurally (see the
  // gameOver/levelComplete branches above and the Enter-key handler)
  // for whenever a new win condition gets designed, but nothing sets
  // it true anymore.

  // Cell-based world streaming: periodically (not every frame) check
  // which 3x3 neighborhood of cells should be active around the
  // player, generating any newly-entered cells and culling anything
  // whose CURRENT position has drifted outside that neighborhood —
  // including things that drifted in from elsewhere, which is exactly
  // why this checks live position rather than tracking origin cells.
  cellCheckCounter++;
  if (cellCheckCounter >= CELL_CHECK_INTERVAL) {
    cellCheckCounter = 0;
    updateActiveCells();
  }

  // Detect maze entry/exit and set an auto-zoom target accordingly.
  // Checked every frame, cheap (two string comparisons).
  if (state.player.mode === "maze" && previousPlayerMode !== "maze") {
    state.preMazeZoom = state.zoom; // remember wherever they were zoomed to, to restore on exit
    state.zoomTarget = ZOOM_MAX;
  } else if (previousPlayerMode === "maze" && state.player.mode !== "maze") {
    state.zoomTarget = state.preMazeZoom;
  }
  previousPlayerMode = state.player.mode;

  // Zoom controls: held continuously, same pattern as movement keys.
  // Manual input immediately cancels any in-progress auto-zoom target,
  // so the two never fight each other.
  if (state.keys['+'] || state.keys['=']) {
    state.zoom = Math.min(ZOOM_MAX, state.zoom + ZOOM_STEP_PER_FRAME);
    state.zoomTarget = null;
  }
  if (state.keys['-'] || state.keys['_']) {
    state.zoom = Math.max(ZOOM_MIN, state.zoom - ZOOM_STEP_PER_FRAME);
    state.zoomTarget = null;
  }

  // Graceful auto-zoom easing: closes a fraction of the remaining
  // distance to the target each frame (decelerating, not a linear
  // step), snapping once close enough to avoid an endless tiny creep.
  if (state.zoomTarget !== null) {
    const diff = state.zoomTarget - state.zoom;
    if (Math.abs(diff) < ZOOM_EASE_SNAP_THRESHOLD) {
      state.zoom = state.zoomTarget;
      state.zoomTarget = null;
    } else {
      state.zoom += diff * ZOOM_EASE_RATE;
    }
  }

  // Camera follows player. The visible world area shrinks as zoom
  // increases (zooming in) and grows as it decreases (zooming out).
  const zoom = state.zoom;
  const visibleWidth = state.canvas.width / zoom;
  const visibleHeight = state.canvas.height / zoom;
  const camera = new Vector2();
  camera.x = state.player.pos.x - visibleWidth / 2;
  camera.y = state.player.pos.y - visibleHeight / 2;
  // Clamp camera to world bounds. Guarded in case the visible area
  // ever exceeds the world size (shouldn't happen given ZOOM_MIN and a
  // 60000x60000 world, but cheap insurance) — in that case, just center
  // the camera instead of leaving it unclamped.
  const maxCameraX = state.sceneWidth - visibleWidth;
  const maxCameraY = state.sceneHeight - visibleHeight;
  camera.x = maxCameraX > 0 ? Math.min(Math.max(camera.x, 0), maxCameraX) : maxCameraX / 2;
  camera.y = maxCameraY > 0 ? Math.min(Math.max(camera.y, 0), maxCameraY) : maxCameraY / 2;
  // Exposed on state so Player.js can convert the tracked mouse
  // position (canvas-space) into world-space for blaster aiming.
  state.camera = camera;
  state.ctx.save();
  state.ctx.scale(zoom, zoom);
  state.ctx.translate(-camera.x, -camera.y);

  // Tiled starfield: repeat the small pre-rendered tile across whatever
  // is currently visible, rather than one canvas sized to the world
  // (see the STARFIELD comment near the top of this file for why).
  {
    const ts = state.starTileSize;
    const startX = Math.floor(camera.x / ts) * ts;
    const startY = Math.floor(camera.y / ts) * ts;
    const endX = camera.x + visibleWidth;
    const endY = camera.y + visibleHeight;
    for (let ty = startY; ty < endY; ty += ts) {
      for (let tx = startX; tx < endX; tx += ts) {
        state.ctx.drawImage(state.starCanvas, tx, ty);
      }
    }
  }

  state.planetoids.forEach(p => p.draw());
  state.asteroids.forEach(a => a.draw());
  state.player.draw();
  drawPullIndicator();
  state.enemies.forEach(e => e.draw());
  state.coins.forEach(c => c.draw());
  state.fireballs.forEach(f => f.draw());
  state.particles.forEach(p => p.draw());
  state.explosions.forEach(e => e.draw());
  state.ctx.restore();
  // HUD
  state.ctx.fillStyle = 'white';
  state.ctx.font = '24px Arial';
  state.ctx.textAlign = 'left';
  state.ctx.fillText(`Level ${state.level} - Score: ${state.score}`, 20, 40);
  state.ctx.fillText(`FPS: ${state.fps.toFixed(1)}`, 20, 70);
  state.ctx.fillText(`Zoom: ${state.zoom.toFixed(1)}x (+/-)`, 20, 100);
  const playerCell = cellCoordFor(state.player.pos.x, state.player.pos.y);
  state.ctx.fillText(`Cell: (${playerCell.col}, ${playerCell.row})`, 20, 130);
  minimap.draw();
  requestAnimationFrame(gameLoop);
}