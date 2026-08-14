// js/interiors/MazeInterior.js
import { Interior } from './Interior.js';
import { state } from '../state.js';
import { Vector2 } from '../vector2.js';
import { Sprite, Texture, Graphics } from 'pixi.js';

let dotTexture = null;
function getDotTexture() {
  if (dotTexture) return dotTexture;
  const r = 4;
  const canvas = document.createElement('canvas');
  canvas.width = r * 2;
  canvas.height = r * 2;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  dotTexture = Texture.from(canvas);
  return dotTexture;
}

let powerPelletTexture = null;
function getPowerPelletTexture() {
  if (powerPelletTexture) return powerPelletTexture;
  const r = 8;
  const canvas = document.createElement('canvas');
  canvas.width = r * 2;
  canvas.height = r * 2;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fillStyle = '#ffff00';
  ctx.fill();
  powerPelletTexture = Texture.from(canvas);
  return powerPelletTexture;
}

export class MazeInterior extends Interior {
  constructor(planetoid) {
    super(planetoid);
    this.cols = 28;
    this.rows = 29;
    this.tileSize = 12;
    this.exitColLeft = 13;
    this.exitColRight = 14;
    this.exitRow = 13;
    this.layout = [
        "     ##################     ",
        "     #.......##.......#     ",
        "     #.#####.##.#####.#     ",
        "     #.#####.##.#####.#     ",
        "######.#####.##.#####.######",
        "#..........................#",
        "#.####.##.########.##.####.#",
        "#.####.##.########.##.####.#",
        "#......##....##....##......#",
        "#.####.#####.##.#####.####.#",
        "#.####.#####.##.#####.####.#",
        "#.####.##          ##.####.#",
        "#......## ######## ##......#",
        "#.####.## #      # ##.####.#",
        "#.####.   #      #   .####.#",
        "#......## #      # ##......#",
        "#.####.## ###  ### ##.####.#",
        "#.####.##          ##.####.#",
        "#.####.## ######## ##.####.#",
        "#.####.##.########.##.####.#",
        "#............##............#",
        "#.####.#####.##.#####.####.#",
        "#.####.#####.##.#####.####.#",
        "#.####.#####.##.#####.####.#",
        "#..........................#",
        "######.##.########.##.######",
        "     #.##.########.##.#     ",
        "     #................#     ",
        "     ##################     "
    ];
    this.walls = [];
    this.dots = [];
    this.powerPellets = []; // Initialize with specific positions if known, e.g., this.powerPellets = [{x: 1, y: 3}, {x: 26, y: 3}, {x: 1, y: 23}, {x: 26, y: 23}];
    this.ghosts = []; // Ghosts should be added via game logic, e.g., new Ghost() instances
    this.offscreen = null;
    this.initializeWallsAndDots();
    this.createOffscreen();
  }

  initializeWallsAndDots() {
    for (let row = 0; row < this.rows; row++) {
      let rowStr = this.layout[row];
      // Pad shorter rows to cols with spaces (assuming centered layout)
      if (rowStr.length < this.cols) {
        const padTotal = this.cols - rowStr.length;
        const padLeft = Math.floor(padTotal / 2);
        const padRight = Math.ceil(padTotal / 2);
        rowStr = ' '.repeat(padLeft) + rowStr + ' '.repeat(padRight);
      }
      this.walls[row] = [];
      for (let col = 0; col < this.cols; col++) {
        const char = rowStr[col] || ' ';
        // Treat '#' and '-' as walls (assuming '-' is a special wall like ghost door)
        this.walls[row][col] = (char === '#' || char === '-');
        if (char === '.') {
          this.dots.push({x: col, y: row});
        }
        // If layout has chars for power pellets (e.g., 'P'), add here: if (char === 'P') this.powerPellets.push({x: col, y: row});
      }
    }
  }

  createOffscreen() {
    const width = this.cols * this.tileSize;
    const height = this.rows * this.tileSize;
    this.offscreen = document.createElement('canvas');
    this.offscreen.width = width;
    this.offscreen.height = height;
    const offCtx = this.offscreen.getContext('2d');
    offCtx.fillStyle = '#cc00cc';
    offCtx.strokeStyle = '#330033';
    offCtx.lineWidth = 4;
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        if (this.walls[row][col]) {
          offCtx.fillRect(
            col * this.tileSize,
            row * this.tileSize,
            this.tileSize,
            this.tileSize
          );
        }
      }
    }
  }

  // ----------------------------
  // PIXI RENDERING (MazeInterior — the semi-transparent exterior/
  // space-view overlay drawn ON the maze planet from outside, NOT the
  // walkable interior-mode rendering itself, which lives elsewhere).
  // Deliberately scoped to NOT include ghosts.forEach(g => g.draw()) —
  // MazeGhost's own rendering wasn't available to port against this
  // session, so ghosts stay unrendered here, same as it already was
  // (draw() itself is dead code in the actual game now, same as
  // everywhere else in this migration).
  //
  // Dots are tracked dynamically (a Map from each dot object to its
  // own Sprite, diffed against this.dots every frame) rather than
  // baked into a static texture the way the walls are — deliberately:
  // there's no visibility into whether some maze pellet-eating
  // mechanic elsewhere in the game mutates this.dots at runtime, and
  // baking them once would silently keep showing an eaten dot forever
  // if that assumption turned out wrong. Power pellets get the exact
  // same treatment for consistency, even though the array is
  // currently always empty in this codebase.
  // ----------------------------
  createPixiSprites(layer) {
    if (this.pixiWallSprite) return;

    this.pixiWallSprite = new Sprite(Texture.from(this.offscreen));
    this.pixiWallSprite.anchor.set(0, 0); // top-left, matching the original's own drawImage(img, offsetX, offsetY) semantics
    this.pixiWallSprite.alpha = 0.5;
    layer.addChild(this.pixiWallSprite);

    this.pixiDotSprites = new Map(); // dot object -> Sprite
    this.pixiPelletSprites = new Map(); // pellet object -> Sprite

    // Added after the wall sprite but before any dot/pellet sprites
    // exist yet (those get added lazily as syncPointSprites creates
    // them) — Graphics added here, though, so its insertion position
    // in the layer is locked in ahead of any dot/pellet sprite,
    // guaranteeing the portal renders on top of them once both exist,
    // matching draw()'s own layer order (walls, dots/pellets, portal
    // last).
    this.pixiPortalGraphics = new Graphics();
    layer.addChild(this.pixiPortalGraphics);
  }

  // Called every frame in place of draw() once migrated.
  updatePixiSprites(layer) {
    if (!this.pixiWallSprite) this.createPixiSprites(layer);
    if (!this.pixiWallSprite) return;

    const offsetX = this.planetoid.pos.x - (this.cols * this.tileSize / 2);
    const offsetY = this.planetoid.pos.y - (this.rows * this.tileSize / 2);
    this.pixiWallSprite.position.set(offsetX, offsetY);

    this.syncPointSprites(this.dots, this.pixiDotSprites, getDotTexture(), offsetX, offsetY, layer);
    this.syncPointSprites(this.powerPellets, this.pixiPelletSprites, getPowerPelletTexture(), offsetX, offsetY, layer);

    const portalX = offsetX + (this.exitColLeft + 0.5) * this.tileSize + this.tileSize / 2;
    const portalY = offsetY + this.exitRow * this.tileSize + this.tileSize / 2;
    const pulse = (Math.sin(Date.now() * 0.006) + 1) / 2;
    // Cleared and redrawn every frame — radius and alpha both change
    // continuously, same reasoning as Explosion's own ring: cheap and
    // short work for a single, permanent instance, nothing worth
    // baking once here.
    this.pixiPortalGraphics.clear();
    this.pixiPortalGraphics
      .circle(portalX, portalY, 10 + pulse * 4)
      .fill({ color: 0xff00ff, alpha: 0.7 + pulse * 0.3 })
      .stroke({ width: 3, color: 0xffaaff });
  }

  // Shared diffing helper for dots/power pellets — both are plain
  // arrays of {x,y} TILE-coordinate literals, not full entity classes
  // with their own createPixiSprite/destroyPixiSprite methods the way
  // Coin or Fireball are, so the sync logic lives here instead,
  // applied to whichever array/tracked-Map/texture is passed in.
  syncPointSprites(points, tracked, texture, offsetX, offsetY, layer) {
    const currentSet = new Set(points);
    for (const [point, sprite] of tracked) {
      if (currentSet.has(point)) continue;
      sprite.destroy();
      tracked.delete(point);
    }
    for (const point of points) {
      let sprite = tracked.get(point);
      if (!sprite) {
        sprite = new Sprite(texture);
        sprite.anchor.set(0.5, 0.5);
        layer.addChild(sprite);
        tracked.set(point, sprite);
      }
      sprite.position.set(
        offsetX + point.x * this.tileSize + this.tileSize / 2,
        offsetY + point.y * this.tileSize + this.tileSize / 2
      );
    }
  }

  // NOTE: not currently wired to anything — mazePlanet is
  // isPermanent, so this can never actually run in the current game
  // (same situation as BeamPlanetoid's own destroyPixiSprite).
  // Implemented anyway for correctness rather than leaving a silent
  // gap.
  destroyPixiSprite() {
    // Unique to this one maze, unlike the shared dot/pellet textures
    // below — texture:true here is correct and doesn't risk breaking
    // anything else.
    this.pixiWallSprite?.destroy({ texture: true, textureSource: true });
    this.pixiWallSprite = null;
    if (this.pixiDotSprites) {
      for (const sprite of this.pixiDotSprites.values()) sprite.destroy();
      this.pixiDotSprites.clear();
    }
    if (this.pixiPelletSprites) {
      for (const sprite of this.pixiPelletSprites.values()) sprite.destroy();
      this.pixiPelletSprites.clear();
    }
    this.pixiPortalGraphics?.destroy();
    this.pixiPortalGraphics = null;
  }

  draw() {
    const ctx = state.ctx;
    const offsetX = this.planetoid.pos.x - (this.cols * this.tileSize / 2);
    const offsetY = this.planetoid.pos.y - (this.rows * this.tileSize / 2);
    ctx.save();
    ctx.globalAlpha = 0.5;
    // Draw maze walls (pre-rendered)
    if (this.offscreen) {
      ctx.drawImage(
        this.offscreen,
        offsetX,
        offsetY
      );
    }
    ctx.globalAlpha = 1.0;
    // ===== DOTS =====
    ctx.fillStyle = '#FFFFFF';
    for (let dot of this.dots) {
      const x = offsetX + dot.x * this.tileSize + this.tileSize / 2;
      const y = offsetY + dot.y * this.tileSize + this.tileSize / 2;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    // ===== POWER PELLETS =====
    ctx.fillStyle = '#FFFF00';
    for (let pp of this.powerPellets) {
      const x = offsetX + pp.x * this.tileSize + this.tileSize / 2;
      const y = offsetY + pp.y * this.tileSize + this.tileSize / 2;
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fill();
    }
    // ===== EXIT PORTAL =====
    const portalX = offsetX + (this.exitColLeft + 0.5) * this.tileSize + this.tileSize / 2;
    const portalY = offsetY + this.exitRow * this.tileSize + this.tileSize / 2;
    const pulse = (Math.sin(Date.now() * 0.006) + 1) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(portalX, portalY, 10 + pulse * 4, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 0, 255, ${0.7 + pulse * 0.3})`;
    ctx.fill();
    ctx.strokeStyle = '#ffaaff';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
    // ===== GHOSTS =====
    this.ghosts.forEach(g => g.draw()); // Assuming ghosts have draw() method and are positioned relative to maze
    ctx.restore();
  }

  getPortalPosition() {
    const offsetX = this.planetoid.pos.x - (this.cols * this.tileSize / 2);
    const offsetY = this.planetoid.pos.y - (this.rows * this.tileSize / 2);
    const portalX = offsetX + (this.exitColLeft + 0.5) * this.tileSize + this.tileSize / 2;
    const portalY = offsetY + this.exitRow * this.tileSize + this.tileSize / 2;
    return new Vector2(portalX, portalY);
  }

  getRandomOpenPos() {
    const opens = [];
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        if (!this.walls[row][col]) {
          opens.push({ col, row });
        }
      }
    }
    return opens[Math.floor(Math.random() * opens.length)];
  }

  getRandomPelletPos() {
    const pellets = [...this.dots, ...this.powerPellets];
    if (pellets.length === 0) return this.getRandomOpenPos(); // Fallback
    const p = pellets[Math.floor(Math.random() * pellets.length)];
    return { col: p.x, row: p.y };
  }
}