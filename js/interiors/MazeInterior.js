// js/interiors/MazeInterior.js
import { Interior } from './Interior.js';
import { state } from '../state.js';
import { Vector2 } from '../vector2.js';

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