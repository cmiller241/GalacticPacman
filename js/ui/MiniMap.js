// js/ui/Minimap.js
import { state } from '../state.js';

// A fixed-position, screen-space overview of the ENTIRE world grid —
// drawn after the camera/zoom transform is restored each frame (see
// game.js), so it's unaffected by both. Deliberately shows the whole
// 20x20 grid at once rather than a scrolling/zoomed local view, since
// "each cell in the grid representing a cell in the world" only makes
// sense as a full overview — a player near one edge of the world will
// just show up near one edge of the map, not re-centered.
export class Minimap {
  constructor() {
    // Panel size/position — tune to taste.
    this.size = 240;   // panel is a `size x size` square
    this.margin = 20;  // distance from the canvas' bottom-right corner

    this.backgroundColor = 'rgba(6, 14, 24, 0.72)';
    this.gridColor = 'rgba(80, 200, 255, 0.18)';
    this.borderColor = 'rgba(100, 220, 255, 0.85)';
    this.cornerColor = 'rgba(140, 230, 255, 1)';
    this.labelColor = 'rgba(150, 230, 255, 0.85)';

    this.playerColor = '#ffffff';
    this.playerGlowColor = 'rgba(255,255,255,0.35)';
    this.playerRadius = 5; // deliberately larger than specialRadius, per the brief

    this.specialColor = '#ffd23f';
    this.specialGlowColor = 'rgba(255,210,63,0.5)';
    this.specialRadius = 3;
  }

  // Which planetoids get plotted as the yellow "special" dots. Reads
  // directly from state each call (rather than being passed in) to
  // match how every other system in this codebase already works.
  // Add state.rectPlanet here too if you want the rounded-rect planet
  // included on the map as well.
  getSpecialPlanets() {
    return [state.mazePlanet, state.platformPlanet].filter(Boolean);
  }

  worldToMapPoint(worldX, worldY, x0, y0) {
    return {
      x: x0 + (worldX / state.sceneWidth) * this.size,
      y: y0 + (worldY / state.sceneHeight) * this.size
    };
  }

  drawGlowDot(ctx, x, y, radius, dotColor, glowColor) {
    ctx.beginPath();
    ctx.fillStyle = glowColor;
    ctx.arc(x, y, radius * 2.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.fillStyle = dotColor;
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  draw() {
    if (!state.player || !state.sceneWidth || !state.sceneHeight || !state.canvas) return;
    const ctx = state.ctx;
    const gridSize = state.gridSize || 20;

    const x0 = state.canvas.width - this.margin - this.size;
    const y0 = state.canvas.height - this.margin - this.size;

    ctx.save();

    // Panel background
    ctx.fillStyle = this.backgroundColor;
    ctx.fillRect(x0, y0, this.size, this.size);

    // Grid lines — one set of gridSize+1 lines per axis, matching the
    // world's actual cell grid exactly (so each square on the minimap
    // really does correspond to one world cell).
    ctx.strokeStyle = this.gridColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= gridSize; i++) {
      const gx = x0 + (i / gridSize) * this.size;
      ctx.moveTo(gx, y0);
      ctx.lineTo(gx, y0 + this.size);
      const gy = y0 + (i / gridSize) * this.size;
      ctx.moveTo(x0, gy);
      ctx.lineTo(x0 + this.size, gy);
    }
    ctx.stroke();

    // Special planetoids (yellow)
    for (const planet of this.getSpecialPlanets()) {
      const p = this.worldToMapPoint(planet.pos.x, planet.pos.y, x0, y0);
      this.drawGlowDot(ctx, p.x, p.y, this.specialRadius, this.specialColor, this.specialGlowColor);
    }

    // Player (white, larger, drawn last so it's always on top)
    {
      const p = this.worldToMapPoint(state.player.pos.x, state.player.pos.y, x0, y0);
      this.drawGlowDot(ctx, p.x, p.y, this.playerRadius, this.playerColor, this.playerGlowColor);
    }

    // Border + sci-fi corner brackets
    ctx.strokeStyle = this.borderColor;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0, y0, this.size, this.size);

    const bracket = Math.min(20, this.size * 0.12);
    ctx.strokeStyle = this.cornerColor;
    ctx.lineWidth = 2;
    const corners = [
      [x0, y0, 1, 1],
      [x0 + this.size, y0, -1, 1],
      [x0, y0 + this.size, 1, -1],
      [x0 + this.size, y0 + this.size, -1, -1]
    ];
    for (const [cx, cy, dx, dy] of corners) {
      ctx.beginPath();
      ctx.moveTo(cx, cy + bracket * dy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + bracket * dx, cy);
      ctx.stroke();
    }

    // Label
    ctx.fillStyle = this.labelColor;
    ctx.font = '12px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('SECTOR MAP', x0 + 8, y0 - 8);

    ctx.restore();
  }
}