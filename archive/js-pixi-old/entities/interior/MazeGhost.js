// js/entities/interior/MazeGhost.js
import { state } from '../../state.js';
import { Vector2 } from '../../vector2.js';

export class MazeGhost {
  constructor(interior, col, row, color) {
    this.interior = interior;
    this.mazeCol = col;
    this.mazeRow = row;
    this.color = color;
    this.radius = 10; // Miniature size
    this.dir = new Vector2(1, 0); // Initial direction (right)
    this.lastMoveTime = Date.now();
  }

  update() {
    const now = Date.now();
    if (now - this.lastMoveTime < 110) return; // Match player move speed
    this.lastMoveTime = now;
    // Define all 4 directions
    const dirs = [
      new Vector2(1, 0), // right
      new Vector2(0, 1), // down
      new Vector2(-1, 0), // left
      new Vector2(0, -1) // up
    ];
    // Find possible directions: open paths, excluding immediate reverse
    let possible = [];
    for (let d of dirs) {
      let testCol = this.mazeCol + d.x;
      // Wrap columns for tunnels
      if (testCol < 0) testCol = this.interior.cols - 1;
      if (testCol >= this.interior.cols) testCol = 0;
      let testRow = this.mazeRow + d.y;
      const isReverse = (d.x === -this.dir.x && d.y === -this.dir.y);
      if (!this.interior.walls[testRow]?.[testCol] && !isReverse) {
        possible.push(d.clone());
      }
    }
    // If no options (rare dead-end), allow reverse as fallback
    if (possible.length === 0) {
      for (let d of dirs) {
        let testCol = this.mazeCol + d.x;
        if (testCol < 0) testCol = this.interior.cols - 1;
        if (testCol >= this.interior.cols) testCol = 0;
        let testRow = this.mazeRow + d.y;
        if (!this.interior.walls[testRow]?.[testCol]) {
          possible.push(d.clone());
        }
      }
    }
    // Check if straight ahead is possible
    const straightOpen = possible.some(d => d.x === this.dir.x && d.y === this.dir.y);
    // Prefer straight 80% of the time if open, else random turn
    if (straightOpen && Math.random() < 0.8) {
      // Keep current dir (straight)
    } else {
      // Pick random from possible (turn or forced)
      this.dir = possible[Math.floor(Math.random() * possible.length)];
    }
    // Move forward in chosen dir
    let newCol = this.mazeCol + this.dir.x;
    let newRow = this.mazeRow + this.dir.y;
    // Wrap columns
    if (newCol < 0) newCol = this.interior.cols - 1;
    if (newCol >= this.interior.cols) newCol = 0;
    this.mazeCol = newCol;
    this.mazeRow = newRow;
  }

  draw() {
    const ctx = state.ctx;
    const offsetX = this.interior.planetoid.pos.x - (this.interior.cols * this.interior.tileSize / 2);
    const offsetY = this.interior.planetoid.pos.y - (this.interior.rows * this.interior.tileSize / 2);
    const x = offsetX + this.mazeCol * this.interior.tileSize + this.interior.tileSize / 2;
    const y = offsetY + this.mazeRow * this.interior.tileSize + this.interior.tileSize / 2;
    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = 1; // Match maze overlay transparency
    // Body: semicircle on top, wavy bottom
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(0, 0, this.radius, Math.PI, 0, false);
    ctx.lineTo(this.radius, this.radius);
    ctx.lineTo(this.radius / 3, this.radius / 2);
    ctx.lineTo(-this.radius / 3, this.radius / 2);
    ctx.lineTo(-this.radius, this.radius);
    ctx.closePath();
    ctx.fill();
    // Eyes (facing "up" for simplicity)
    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.arc(-this.radius / 3, -this.radius / 3, this.radius / 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(this.radius / 3, -this.radius / 3, this.radius / 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'black';
    ctx.beginPath();
    ctx.arc(-this.radius / 3, -this.radius / 3, this.radius / 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(this.radius / 3, -this.radius / 3, this.radius / 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1.0;
    ctx.restore();
  }
}