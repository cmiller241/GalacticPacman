// js/interiors/PlatformInterior.js
import { Interior } from './Interior.js';
import { state } from '../state.js';
import { Vector2 } from '../vector2.js';

export class PlatformInterior extends Interior {
  constructor(planetoid) {
    super(planetoid);
    this.cols = 28;
    this.rows = 29;
    this.tileSize = 12;
    this.exitColLeft = 24;
    this.exitColRight = 25;
    this.exitRow = 25;
    this.tiles = [
      "............................",
      "..........#######...........",
      "..........H.................",
      "..........H.................",
      "..........H.................",
      "..........H.................",
      "...######################...",
      ".............H.......H......",
      ".............H.......H......",
      ".............H.......H......",
      ".............H.......H......",
      "..########################..",
      ".......H........H...........",
      ".......H........H...........",
      ".......H....................",
      ".......H....................",
      "..########################..",
      "...........H........H.......",
      "...........H........H.......",
      "...........H........H.......",
      "...........H........H.......",
      "..########################..",
      ".....H......................",
      ".....H......................",
      ".....H......................",
      ".....H......................",
      "############################",
      "............................",
      "............................"
    ];
    this.offscreen = null;
    this.createOffscreen();
    this.blobs=[];
  }

  createOffscreen() {
    const width = this.cols * this.tileSize;
    const height = this.rows * this.tileSize;
    this.offscreen = document.createElement('canvas');
    this.offscreen.width = width;
    this.offscreen.height = height;
    const offCtx = this.offscreen.getContext('2d');
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const tile = this.tiles[row][col];
        const x = col * this.tileSize;
        const y = row * this.tileSize;
        // PLATFORM BLOCK
        if (tile === "#") {
          offCtx.fillStyle = "#6b3f1d";
          offCtx.fillRect(x, y, this.tileSize, this.tileSize);
          offCtx.strokeStyle = "#3b200f";
          offCtx.strokeRect(x, y, this.tileSize, this.tileSize);
          // highlight strip
          offCtx.fillStyle = "rgba(255,255,255,0.15)";
          offCtx.fillRect(x, y, this.tileSize, 6);
        }
        // LADDER
        if (tile === "H") {
          const centerX = x + this.tileSize / 2;
          const railOffset = 3;
          const leftRail = centerX - railOffset;
          const rightRail = centerX + railOffset;
          offCtx.strokeStyle = "#d8c38f";
          offCtx.lineWidth = 2;
          // vertical rails
          offCtx.beginPath();
          offCtx.moveTo(leftRail, y);
          offCtx.lineTo(leftRail, y + this.tileSize);
          offCtx.moveTo(rightRail, y);
          offCtx.lineTo(rightRail, y + this.tileSize);
          offCtx.stroke();
          // ladder rungs
          for (let r = 3; r < this.tileSize; r += 4) {
            offCtx.beginPath();
            offCtx.moveTo(leftRail, y + r);
            offCtx.lineTo(rightRail, y + r);
            offCtx.stroke();
          }
        }
      }
    }
  }

  draw() {
    const ctx = state.ctx;
    const offsetX = this.planetoid.pos.x - (this.cols * this.tileSize / 2);
    const offsetY = this.planetoid.pos.y - (this.rows * this.tileSize / 2);
    ctx.save();
    ctx.globalAlpha = 0.6;
    if (this.offscreen) {
      ctx.drawImage(this.offscreen, offsetX, offsetY);
    }
    ctx.globalAlpha = 1;
    // ===== PLATFORM PORTAL =====
    const portal = this.getPortalPosition();
    const time = Date.now() * 0.004;
    const pulse = (Math.sin(Date.now() * 0.006) + 1) / 2;
    ctx.save();
    // glow
    ctx.shadowColor = "#39ff14";
    ctx.shadowBlur = 20;
    // core portal
    ctx.beginPath();
    ctx.arc(portal.x, portal.y, 8 + pulse * 3, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(57,255,20,${0.7 + pulse * 0.3})`;
    ctx.fill();
    ctx.globalCompositeOperation = "lighter";
    // swirl particles
    const swirlCount = 8;
    for (let i = 0; i < swirlCount; i++) {
      const angle = time + (i / swirlCount) * Math.PI * 2;
      const radius = 12 + Math.sin(time * 2 + i) * 3;
      const x = portal.x + Math.cos(angle) * radius;
      const y = portal.y + Math.sin(angle) * radius;
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fillStyle = "#baff9a";
      ctx.fill();
    }

    // Draw Blob Monsters
    this.blobs.forEach(blob => blob.draw());

    ctx.restore();
    ctx.restore();
  }

  getPortalPosition() {
    const offsetX = this.planetoid.pos.x - (this.cols * this.tileSize / 2);
    const offsetY = this.planetoid.pos.y - (this.rows * this.tileSize / 2);
    const portalX = offsetX + (this.exitColLeft + 0.5) * this.tileSize + this.tileSize / 2;
    const portalY = offsetY + this.exitRow * this.tileSize + this.tileSize / 2;
    return new Vector2(portalX, portalY);
  }
}