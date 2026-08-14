// js/setup/levelSetup.js
// initGame(): builds a fresh level from scratch — the fixed, permanent
// planets (maze/platform/rect/dome), the dome's jump platforms and
// goombas, the asteroid belt's fire bars, the two interior boss
// encounters (blob monsters, maze ghosts), and the player's starting
// position — then generates the player's starting cell via worldGen.js
// and hands off to it for everything beyond that first cell. Split out
// of game.js specifically because this is pure one-time level-assembly
// logic, entirely separate from the frame-by-frame orchestration in
// gameLoop() — called once on startup and again on restart/level-
// advance (see inputHandlers.js's tryRestartOrAdvance), never from
// inside the loop itself.
//
// gravitySystem is stored on state (state.gravitySystem) rather than
// as a module-level variable the way it used to live in game.js —
// it's created here but read every frame by gameLoop() in game.js, so
// it needs to be reachable from both files; state is what already
// serves that role for everything else shared across modules.
import { state } from '../state.js';
import { PLAYER_RADIUS } from '../constants.js';
import { Vector2 } from '../vector2.js';
import { BeamPlanetoid } from '../world/BeamPlanetoid.js';
import { RoundedRectPlanetoid } from '../world/RoundedRectPlanetoid.js';
import { FireBar } from '../world/FireBar.js';
import { SkyDomePlanetoid } from '../world/SkyDomePlanetoid.js';
import { JumpPlatform } from '../world/JumpPlatform.js';
import { MazeInterior } from '../interiors/MazeInterior.js';
import { PlatformInterior } from '../interiors/PlatformInterior.js';
import { Player } from '../entities/Player.js';
import { Goomba } from '../entities/world/Goomba.js';
import { BlobMonster } from '../entities/interior/BlobMonster.js';
import { MazeGhost } from '../entities/interior/MazeGhost.js';
import { GravitySystem } from '../systems/GravitySystem.js';
import { resetBeltState, BELT_START, BELT_END } from '../world/CellManifest.js';
import { CELL_SIZE, CENTER_CELL, cellKey, generateRegularPlanetoidsInCell, generateHazardsAndExtrasInCell, updateActiveCells, drainPendingCellGeneration } from './worldGen.js';

export function initGame() {
  state.planetoids = [];
  state.asteroids = [];
  state.coins = [];
  state.enemies = [];
  state.goombas = [];
  state.activeCells = new Set();
  resetBeltState(); // module-level in CellManifest.js, doesn't reset itself on restart otherwise

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

  // === SKY DOME PLATFORM ===
  state.skyDomePlanet = new SkyDomePlanetoid(
    centerOriginX + CELL_SIZE * 0.5, centerOriginY + CELL_SIZE * 0.15
  );
  state.skyDomePlanet.isPermanent = true;
  state.planetoids.push(state.skyDomePlanet);

  // === TEST JUMP PLATFORMS above the sky dome's ground ===
  // Heights here are a rough first guess, not a verified fit against
  // actual jump strength/gravity/horizontal-carry — expect to nudge
  // these Y values once you've actually seen how high a jump reaches.
  {
    const groundTopY = state.skyDomePlanet.pos.y - state.skyDomePlanet.halfHeight;
    const groundX = state.skyDomePlanet.pos.x;

    // Builds a JumpPlatform whose top surface sits at topSurfaceY (the
    // jump-height target, same numbers as before) but whose BODY
    // extends all the way down to the ground — height is rounded UP to
    // the nearest multiple of 64 (never down), so it always reaches at
    // least to the ground rather than stopping just short and leaving
    // a visible gap. platform.png's tileset (see JumpPlatform.js)
    // handles rendering however many rows that ends up being.
    // Builds a JumpPlatform whose BOTTOM edge sits exactly at
    // groundTopY (the top of the grass layer) — anchoring the bottom
    // rather than the top is what guarantees this: the grass layer is
    // only 32 units thick, and rounding height to a clean multiple of
    // 64 can shift things by up to 64 units either way, which is
    // enough to overshoot straight through the grass into the metal
    // base if the TOP were the fixed point instead. Anchoring the
    // bottom means the top (the actual jump-height target) shifts
    // slightly from these numbers instead — a much smaller, far less
    // visible tradeoff than the platform's own body appearing to merge
    // into the metal base beneath it.
    function createGroundedPlatform(centerX, topSurfaceY, width) {
      const rawHeight = groundTopY - topSurfaceY;
      const height = Math.max(64, Math.round(rawHeight / 64) * 64);
      const centerY = groundTopY - height / 2;
      return new JumpPlatform(centerX, centerY, width, height);
    }

    // Named for clarity — D/A/B are the original 3 platforms
    // (leftmost/center/rightmost), reshaped to shortest/medium/
    // tallest; NEW1-3 are new stepping stones filling the gaps
    // between them, each wide enough to overlap its neighbors so
    // there's no awkward full-width jump between any two. The whole
    // sequence (left to right): NEW3, D, NEW2, A, NEW1, B — a gently
    // rising zigzag, room to extend further up toward the dome later.
    const platformD = createGroundedPlatform(groundX - 700, groundTopY - 90, 256);  // leftmost, shortest
    const platformA = createGroundedPlatform(groundX - 300, groundTopY - 150, 320); // center, medium
    const platformB = createGroundedPlatform(groundX + 100, groundTopY - 210, 256); // rightmost, tallest

    // Between A and B, jumpable from B specifically — sits a bit
    // closer to B's height than A's, and wide enough (320, 5 tiles)
    // that its edges genuinely overlap both A's right edge and B's
    // left edge, rather than just touching them.
    const platformNew1 = createGroundedPlatform(groundX - 84, groundTopY - 300, 320);
    // Between D and A.
    const platformNew2 = createGroundedPlatform(groundX - 516, groundTopY - 360, 256);
    // Just left of D — the start of the path.
    const platformNew3 = createGroundedPlatform(groundX - 900, groundTopY - 420, 256);

    // New platforms pushed first so they render BEHIND the original 3
    // at the overlap regions.
    state.jumpPlatforms = [platformNew1, platformNew2, platformNew3, platformD, platformA, platformB];
    for (const platform of state.jumpPlatforms) {
      platform.isPermanent = true;
      state.planetoids.push(platform);
    }

    // One goomba on each of the original 3 platforms only — the new
    // stepping stones stay goomba-free for now.
    for (const platform of [platformD, platformA, platformB]) {
      state.goombas.push(new Goomba(platform, platform.pos.x));
    }
  }

  // Bake all permanent planets' textures once.
  state.mazePlanet.createOffscreen();
  state.platformPlanet.createOffscreen();
  state.rectPlanet.createOffscreen();
  // Was commented out — harmless under the old Canvas2D rendering
  // path, since drawScrollingHexTile() already tolerated a missing
  // hexGridCanvas/hexGridForegroundCanvas silently (`if (!tileCanvas)
  // return;`), so skipping this call just meant the hex grid quietly
  // never appeared, with the rest of the dome rendering normally. The
  // new Pixi rendering has no equivalent silent-skip for this
  // specifically — it genuinely needs these two baked canvases to
  // exist — so leaving this commented out crashed on
  // Texture.from(null) instead of just quietly doing without a hex
  // grid the way the old path did.
  state.skyDomePlanet.createOffscreen();
  state.jumpPlatforms.forEach(platform => platform.createOffscreen());

  // === FIRE BARS along the asteroid belt ===
  // Fixed, permanent placements (not part of the belt's own generate/
  // cull streaming — fire bars live in their own small array, cheap
  // enough to just all exist for the whole session) spread along the
  // belt's actual line, from just past BELT_START to just before
  // BELT_END so none sit right on top of either endpoint. Each gets a
  // random perpendicular offset (within the belt's own gameplay
  // corridor width) so they don't sit in a perfectly straight,
  // mechanical row, plus a random starting angle and rotation
  // direction for visual variety — size/speed/fireball-count all come
  // from FireBar's own tuned defaults, not overridden here.
  {
    const NUM_BELT_FIRE_BARS = 20;
    const beltDx = BELT_END.col - BELT_START.col;
    const beltDy = BELT_END.row - BELT_START.row;
    const beltLen = Math.hypot(beltDx, beltDy);
    const beltDirCol = beltDx / beltLen, beltDirRow = beltDy / beltLen;
    const perpCol = -beltDirRow, perpRow = beltDirCol; // perpendicular to the belt's direction, in cell-space

    state.fireBars = [];
    for (let i = 0; i < NUM_BELT_FIRE_BARS; i++) {
      const t = (i + 1) / (NUM_BELT_FIRE_BARS + 1); // evenly spaced, skipping the exact endpoints
      const baseCol = BELT_START.col + beltDx * t;
      const baseRow = BELT_START.row + beltDy * t;
      const jitter = (Math.random() * 2 - 1) * 0.6; // cell-widths, perpendicular — stays within the belt's own gameplay corridor
      const col = baseCol + perpCol * jitter;
      const row = baseRow + perpRow * jitter;

      state.fireBars.push(new FireBar(col * CELL_SIZE, row * CELL_SIZE, {
        startAngle: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() < 0.5 ? -1 : 1) * 0.05
      }));
    }
  }

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
  // Drains that queued work synchronously, right now, rather than
  // leaving it for the ongoing gameLoop to spread across many frames —
  // see drainPendingCellGeneration's own comment in worldGen.js for
  // why that distinction matters specifically at game start.
  drainPendingCellGeneration();

  state.particles = [];
  state.fireballs = [];
  state.explosions = [];
  state.gameOver = false;
  state.levelComplete = false;
  state.audioManager.reset(); // Reset sound index on restart

  state.gravitySystem = new GravitySystem(state.planetoids);
}