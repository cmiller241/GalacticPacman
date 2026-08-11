// js/game.js
// Orchestration only: canvas/zoom/starfield setup, the systems the
// main loop drives (collision, AI, minimap), wiring up input and
// asset loading, and the loop itself (gameLoop, plus the three small
// per-frame helpers it calls — updatePlanetoids, updateAsteroids,
// breakAsteroid). Everything else this file used to contain directly
// — asset loading, input handlers, cell-based world generation/
// streaming, and one-time level assembly — now lives in js/setup/,
// imported below. See each of those files' own header comments for
// why they're split the way they are.
import { state } from './state.js';
import { STAR_COUNT, JUMP_STRENGTH } from './constants.js';
import { Vector2 } from './vector2.js';
import { Asteroid } from './entities/world/Asteroid.js';
import { Explosion } from './entities/world/Explosion.js';
import { CollisionSystem } from './systems/CollisionSystem.js';
import { AISystem } from './systems/AISystem.js';
import { createParticles } from './utils.js';
import { Minimap } from './ui/Minimap.js';
import { getCellKindLabel, getBeltPlanetoidCount } from './world/CellManifest.js';
import { drawPullIndicator } from './effects/PullBeam.js';
import { drawAimIndicator } from './effects/AimIndicator.js';
import { drawLockOutline } from './effects/LockOutline.js';
import { drawVatsOverlay } from './effects/VatsOverlay.js';
import { cellCoordFor, updateActiveCells, CELL_CHECK_INTERVAL } from './setup/worldGen.js';
import { initGame } from './setup/levelSetup.js';
import { loadAssets } from './setup/assetLoading.js';
import { attachInputHandlers } from './setup/inputHandlers.js';
import { pollGamepad } from './setup/gamepadInput.js';

// Setup canvas and ctx
state.canvas = document.getElementById('gameCanvas');
state.ctx = state.canvas.getContext('2d');
// Set initial canvas size
state.canvas.width = window.innerWidth;
state.canvas.height = window.innerHeight;

state.fireballs = [];
state.explosions = [];

// Camera zoom (1 = default view; >1 zooms in, <1 zooms out). Held
// continuously with +/- (see gameLoop).
state.zoom = 1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
// Exposed so Player.js's sprite cache can bake at high enough
// resolution to stay crisp at the maximum zoom level, without ever
// needing to rebuild while zooming. Also read directly by
// inputHandlers.js's wheel listener, rather than that file keeping its
// own separate copy of these two constants.
state.zoomMax = ZOOM_MAX;
// Exposed alongside zoomMax so anything wanting to scale a visual
// effect by "how zoomed in are we" (currently: SkyDomePlanetoid's
// foreground glass pass) can read the real range directly, rather
// than hardcoding a guess at it in a different file.
state.zoomMin = ZOOM_MIN;
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

// ----------------------------
// V.A.T.S. TIME SCALE
// ----------------------------
// state.timeScale is a global multiplier every world entity's own
// movement/rotation/decay reads each frame (see Asteroid.js, Goomba.js,
// FireBar.js, Particle.js, Fireball.js, GravitySystem.js, Player.js's
// applyPullForce/airborne integration, and updatePlanetoids below) —
// 1 = normal speed, VATS_TIME_SCALE = the slowed speed while V.A.T.S.
// (Triangle, see gamepadInput.js's tryToggleVats) is active. Eased
// toward its target the same decelerating way state.zoom is above,
// rather than snapping instantly, so the slowdown/speed-up itself
// reads as a smooth transition rather than a jarring toggle.
//
// Deliberately does NOT affect: player input reading, aim computation
// (computeLeftArmAimAngle — angle-based, not per-frame integration),
// lock-cycling (L1/R1), facing direction, or walking input response
// (move()'s own direct position-from-input logic) — all of that stays
// fully responsive while V.A.T.S. is active, which is the whole point:
// the world slows down around a player who can still act at full speed.
state.timeScale = 1;
state.timeScaleTarget = 1;
state.vatsActive = false;
// Accessibility-style preference (see gamepadInput.js's R1/L1
// handling): if true, pressing R1/L1 to cycle a lock target ALSO turns
// V.A.T.S. on if it isn't already active, rather than requiring an
// explicit Triangle press first. Flip to false to require Triangle
// first, the original behavior. Doesn't change what Triangle itself
// does either way — it's still always available to slow things down
// and look around before committing to a lock.
state.vatsAutoEnterOnLock = false;
const VATS_TIME_SCALE = 0.05; // world speed while V.A.T.S. is active — near-freeze, not a dramatic-but-still-moving slowdown
state.vatsTimeScale = VATS_TIME_SCALE; // exposed so VatsOverlay.js can compute a fade progress that matches the easing curve below, rather than snapping on/off out of sync with it
const VATS_EASE_RATE = 0.12;
const VATS_EASE_SNAP_THRESHOLD = 0.005;

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
let collisionSystem = new CollisionSystem();
let aiSystem = new AISystem();
const minimap = new Minimap();
let cellCheckCounter = 0;
attachInputHandlers();
loadAssets(() => {
  initGame();
  gameLoop();
});

function updatePlanetoids() {
  for (const p of state.planetoids) {
    if (p.isImmovable) {
      // Absolute guarantee: nothing can ever accumulate velocity on an
      // immovable object, regardless of what pushed it this frame —
      // fireball impact and ground-pound knockback both add directly
      // to planet.vel and neither one checks isImmovable (a gap that
      // predates this class), and there could be others later. Forcing
      // velocity to zero here, at the actual source of movement, is a
      // hard guarantee that doesn't depend on remembering to guard
      // every individual push site.
      p.vel.x = 0;
      p.vel.y = 0;
      continue; // never moves, so skip position update and wall-bounce entirely
    }
    p.pos.add(p.vel.clone().multiply(state.timeScale));
    // Belt planetoids are exempt from the world-edge bounce: their
    // trajectory is deliberately authored (see CellManifest.js), and
    // the upstream spawn setback used to avoid visible pop-in can
    // briefly place a fresh one just outside world bounds near
    // BELT_START (col 0) — bouncing would flip its velocity and break
    // the belt's shared direction for that one planetoid.
    if (!p.isBeltPlanetoid) {
      if (p.pos.x - p.radius < 0) { p.pos.x = p.radius; p.vel.x = -p.vel.x; }
      if (p.pos.x + p.radius > state.sceneWidth) { p.pos.x = state.sceneWidth - p.radius; p.vel.x = -p.vel.x; }
      if (p.pos.y - p.radius < 0) { p.pos.y = p.radius; p.vel.y = -p.vel.y; }
      if (p.pos.y + p.radius > state.sceneHeight) { p.pos.y = state.sceneHeight - p.radius; p.vel.y = -p.vel.y; }
    }
    if (p.isRoundedRect) {
      p.rotationAngle += p.rotationSpeed * state.timeScale;
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

  // Gamepad state has no push events at all (unlike keyboard/mouse) —
  // has to be read fresh every frame, before anything below that
  // depends on it, INCLUDING the gameOver/levelComplete screens below
  // (pollGamepad checks those flags itself first and handles X-button
  // restart/advance there, mirroring how the mouse path's
  // tryRestartOrAdvance() already gets checked before any other mouse
  // action) — if this call were placed after those early-returns
  // instead, it would simply never run at all while either screen is
  // showing, and X would silently do nothing on them.
  pollGamepad();

  if (state.gameOver) {
    state.ctx.fillStyle = 'white';
    state.ctx.font = '48px Arial';
    state.ctx.textAlign = 'center';
    state.ctx.fillText('Game Over', state.canvas.width / 2, state.canvas.height / 2 - 20);
    state.ctx.font = '32px Arial';
    state.ctx.fillText(`Final Score: ${state.score}`, state.canvas.width / 2, state.canvas.height / 2 + 30);
    state.ctx.font = '24px Arial';
    state.ctx.fillText('Press Enter or X to Restart', state.canvas.width / 2, state.canvas.height / 2 + 70);
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
    state.ctx.fillText('Press Enter or X to start next level', state.canvas.width / 2, state.canvas.height / 2 + 70);
    requestAnimationFrame(gameLoop);
    return;
  }

  // Eases state.timeScale toward whatever pollGamepad() set
  // state.vatsActive to this frame — same decelerating-ease technique
  // as the auto-zoom block below, just a separate value with its own
  // target/rate. Runs here, before updatePlanetoids and everything
  // else that reads state.timeScale this frame, so the whole world
  // sees a single, already-settled value for this frame rather than a
  // stale one from last frame.
  state.timeScaleTarget = state.vatsActive ? VATS_TIME_SCALE : 1;
  const timeScaleDiff = state.timeScaleTarget - state.timeScale;
  if (Math.abs(timeScaleDiff) < VATS_EASE_SNAP_THRESHOLD) {
    state.timeScale = state.timeScaleTarget;
  } else {
    state.timeScale += timeScaleDiff * VATS_EASE_RATE;
  }

  updatePlanetoids();
  if (state.player.mode == "maze") state.player.updateMazePosition();
  updateAsteroids();
  state.fireBars.forEach(b => b.update());

  let toBreak = collisionSystem.handlePlanetAsteroidCollisions(state.planetoids, state.asteroids);
  collisionSystem.handleElasticCollisions(state.planetoids);
  collisionSystem.handleElasticCollisions(state.asteroids);
  collisionSystem.handleImmovableCollisions(state.fireBars, state.planetoids);
  collisionSystem.handleImmovableCollisions(state.fireBars, state.asteroids);
  // Any planetoid tagged isImmovable (SkyDomePlanetoid is the first
  // example) gets the same surface-accurate bounce treatment FireBar's
  // block already has, against both other planetoids and asteroids —
  // this is what the elastic-collision skip above was for. Asteroids
  // are deliberately NOT included here — they should always break
  // against a planet's true surface (dome or body), same as they
  // already do against every other planet in the game, handled by
  // handlePlanetAsteroidCollisions/toBreak below. Bouncing them here
  // too would be redundant with that (and could even bounce one away
  // the same frame it's about to be destroyed anyway). FireBar's block
  // keeps its own separate bounce behavior for asteroids — it's a
  // different kind of object (a hard mechanical obstacle), not a
  // planet's surface.
  {
    const immovablePlanetoids = state.planetoids.filter(p => p.isImmovable);
    collisionSystem.handleImmovableCollisions(immovablePlanetoids, state.planetoids);
  }

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
        state.gravitySystem.applyTo(state.player);
      }
    }
    state.player.update();
    if (state.player.mode != "maze") collisionSystem.handlePlayerPlanetCollisions(state.player);
    if (state.mouseDown || state.gamepadFireHeld) state.player.shootFireball();
  } else {
    state.player.update(); // Run death animation
  }

  aiSystem.updateEnemies(state.enemies, state.planetoids);
  // Goomba's own simple edge-patrol logic is entirely self-contained
  // (see Goomba.update) — no orbit/gravity/jump concepts to route
  // through AISystem, which is built specifically for that model.
  state.goombas.forEach(g => g.update());
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
    state.audioManager.playFireball();
  }
  for (const hit of fireballResults.planetHits) {
    const speed = hit.fireball.vel.length();
    const pushDir = hit.fireball.vel.clone().normalize(); // planet gets knocked further along the fireball's own path, away from the shooter
    hit.planet.vel.add(pushDir.multiply(speed * FIREBALL_PLANET_PUSH_STRENGTH));
    state.explosions.push(new Explosion(hit.fireball.pos.x, hit.fireball.pos.y));
    state.audioManager.playFireball();
  }
  const goombaFireballResults = collisionSystem.handleFireballGoombaCollisions(state.fireballs, state.goombas);
  for (const g of goombaFireballResults.killedGoombas) {
    state.explosions.push(new Explosion(g.pos.x, g.pos.y));
    state.audioManager.playGoombaStomp();
    state.audioManager.playFireball();
  }
  state.goombas = state.goombas.filter(g => !goombaFireballResults.killedGoombas.has(g));
  state.fireballs = state.fireballs.filter(f => !f.isDead && !fireballResults.hitFireballs.has(f) && !goombaFireballResults.hitFireballs.has(f));

  state.explosions.forEach(e => e.update());
  state.explosions = state.explosions.filter(e => !e.isDead);

  state.particles.forEach(p => p.update());
  state.particles = state.particles.filter(p => p.life > 0);
  collisionSystem.handleCoinCollisions(state.player, state.coins);
  collisionSystem.handlePlayerAsteroidCollisions(state.player, state.asteroids);
  collisionSystem.handlePlayerEnemyCollisions(state.player, state.enemies);
  {
    // Stomping a goomba kills it and gives the player a small upward
    // bounce (classic Mario-style feedback); any other touch already
    // called player.startDeath() inside handlePlayerGoombaCollisions
    // itself.
    const stomped = collisionSystem.handlePlayerGoombaCollisions(state.player, state.goombas);
    if (stomped.length > 0) {
      for (const g of stomped) {
        state.explosions.push(new Explosion(g.pos.x, g.pos.y));
        state.audioManager.playGoombaStomp();
      }
      state.goombas = state.goombas.filter(g => !stomped.includes(g));
      state.player.vel.y = -JUMP_STRENGTH * 0.6; // smaller than a full jump — a bounce, not a launch
    }
  }
  collisionSystem.handlePlayerFireBarCollisions(state.player, state.fireBars);
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
  // Exposed alongside camera so Raycast.js's findNearestOccluder can
  // tell whether a candidate occluder is actually within the visible
  // viewport, without needing its own separate way to derive this.
  state.visibleWidth = visibleWidth;
  state.visibleHeight = visibleHeight;
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
  state.fireBars.forEach(b => b.draw());
  state.enemies.forEach(e => e.draw());
  state.goombas.forEach(g => g.draw());
  state.player.draw();
  drawPullIndicator();
  drawVatsOverlay();
  drawLockOutline();
  drawAimIndicator();
  state.coins.forEach(c => c.draw());
  state.fireballs.forEach(f => f.draw());
  state.particles.forEach(p => p.draw());
  state.explosions.forEach(e => e.draw());
  // Drawn last, after the player and everything else — see
  // drawForegroundGlass's own comment for why this needs to be a
  // separate, later pass rather than part of the normal planetoid
  // draw loop above.
  if (state.skyDomePlanet) state.skyDomePlanet.drawForegroundGlass();
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
  state.ctx.fillText(`Cell type: ${getCellKindLabel(playerCell.col, playerCell.row)} | Belt planetoids: ${getBeltPlanetoidCount()}`, 20, 160);
  minimap.draw();
  requestAnimationFrame(gameLoop);
}