// js/ui/MiniMap.js
//
// Screen-space overview of the world round the player: a window
// viewCells cells across, always centred on him. The grid lines are the
// world's own cell boundaries, scrolling with it. The belt is a static
// annulus of dots around the sun.

import love from '../love/index.js';
import lua from '../love/lua.js';
import state from '../state.js';
import worldGen from '../setup/WorldGen.js';

class Minimap {
  static new() {
    return new Minimap();
  }

  constructor() {
    this.size = 240;
    this.sizeFraction = 0.20;
    this.margin = 20;

    this.backgroundColor = [6 / 255, 14 / 255, 24 / 255, 0.72];
    this.gridColor = [80 / 255, 200 / 255, 255 / 255, 0.18];
    this.borderColor = [100 / 255, 220 / 255, 255 / 255, 0.85];
    this.cornerColor = [140 / 255, 230 / 255, 255 / 255, 1];
    this.labelColor = [150 / 255, 230 / 255, 255 / 255, 0.85];

    this.playerColor = [1, 1, 1, 1];
    this.playerGlowColor = [1, 1, 1, 0.35];
    this.playerRadius = 5;

    this.specialColor = [1, 210 / 255, 63 / 255, 1];
    this.specialGlowColor = [1, 210 / 255, 63 / 255, 0.5];
    this.specialRadius = 3;

    this.cannonColor = [0.45, 0.9, 1, 1];
    this.cannonGlowColor = [0.45, 0.9, 1, 0.45];
    this.cannonRouteColors = [
      [1, 0.6, 0.9, 0.5],
      [0.55, 1, 0.6, 0.5],
      [1, 0.85, 0.4, 0.5],
    ];

    this.sunColor = [1, 0.75, 0.2, 1];
    this.sunGlowColor = [1, 0.55, 0.1, 0.45];

    this.beltDotColor = [1, 77 / 255, 77 / 255, 0.78];
    this.beltDotCount = 600;
    this._beltDots = null;

    this.edgeColor = [100 / 255, 220 / 255, 255 / 255, 0.5];

    this.viewCells = 10;
    this.viewX = 0; this.viewY = 0; this.viewSpan = 1;
  }

  refreshSize() {
    const w = love.graphics.getWidth();
    this.size = Math.max(120, Math.floor(w * (this.sizeFraction ?? 0.25)));
  }

  getSpecialPlanets() {
    return [state.mazePlanet, state.platformPlanet, state.skyDomePlanet, state.waterPlanet, state.waterPlanet2]
      .filter((p) => p);
  }

  worldToMapPoint(worldX, worldY, x0, y0) {
    return {
      x: x0 + (worldX - this.viewX) / this.viewSpan * this.size,
      y: y0 + (worldY - this.viewY) / this.viewSpan * this.size,
    };
  }

  worldToMapLength(worldLength) {
    return worldLength / this.viewSpan * this.size;
  }

  drawGlowDot(x, y, radius, color, glowColor) {
    love.graphics.setColor(glowColor);
    love.graphics.circle('fill', x, y, radius * 2.2);
    love.graphics.setColor(color);
    love.graphics.circle('fill', x, y, radius);
  }

  ensureBeltDots() {
    if (this._beltDots) return;
    const cellSize = worldGen.CELL_SIZE ?? 3000;
    const rMin = (worldGen.BELT_INNER_CELLS ?? 2) * cellSize;
    const rMax = (worldGen.BELT_OUTER_CELLS ?? 3) * cellSize;
    const [sunX, sunY] = worldGen.sunPos();

    const dots = [];
    const rng = love.math.newRandomGenerator(20260821);
    const n = this.beltDotCount ?? 220;
    for (let k = 0; k < n; k++) {
      const ang = rng.random() * Math.PI * 2;
      const u = rng.random();
      const r = Math.sqrt(u * (rMax * rMax - rMin * rMin) + rMin * rMin);
      dots.push({ x: sunX + Math.cos(ang) * r, y: sunY + Math.sin(ang) * r });
    }
    this._beltDots = dots;
  }

  draw() {
    const g = love.graphics;
    this.refreshSize();
    this.ensureBeltDots();

    const winW = g.getWidth();
    const winH = g.getHeight();
    const x0 = winW - this.size - this.margin;
    const y0 = winH - this.size - this.margin;

    const cellSize = worldGen.CELL_SIZE ?? 3000;
    this.viewSpan = cellSize * this.viewCells;
    let cx = (state.sceneWidth ?? 0) / 2, cy = (state.sceneHeight ?? 0) / 2;
    if (state.player && state.player.pos) { cx = state.player.pos.x; cy = state.player.pos.y; }
    this.viewX = cx - this.viewSpan / 2;
    this.viewY = cy - this.viewSpan / 2;

    g.setColor(this.backgroundColor);
    g.rectangle('fill', x0, y0, this.size, this.size);

    g.push('all');
    g.setScissor(x0, y0, this.size, this.size);

    g.setColor(this.gridColor);
    g.setLineWidth(1);
    for (let col = Math.ceil(this.viewX / cellSize); col <= Math.floor((this.viewX + this.viewSpan) / cellSize); col++) {
      const m = this.worldToMapPoint(col * cellSize, 0, x0, y0);
      g.line(m.x, y0, m.x, y0 + this.size);
    }
    for (let row = Math.ceil(this.viewY / cellSize); row <= Math.floor((this.viewY + this.viewSpan) / cellSize); row++) {
      const m = this.worldToMapPoint(0, row * cellSize, x0, y0);
      g.line(x0, m.y, x0 + this.size, m.y);
    }

    if (state.sceneWidth && state.sceneWidth > 0) {
      const a = this.worldToMapPoint(0, 0, x0, y0);
      const b = this.worldToMapPoint(state.sceneWidth, state.sceneHeight, x0, y0);
      g.setColor(this.edgeColor);
      g.setLineWidth(2);
      g.rectangle('line', a.x, a.y, b.x - a.x, b.y - a.y);
    }

    g.setColor(this.beltDotColor);
    for (const d of this._beltDots) {
      const m = this.worldToMapPoint(d.x, d.y, x0, y0);
      g.circle('fill', m.x, m.y, 1.15);
    }

    if (state.sun && state.sun.pos) {
      const sunMap = this.worldToMapPoint(state.sun.pos.x, state.sun.pos.y, x0, y0);
      let sunR = 6;
      if (state.sun.radius) {
        sunR = Math.max(4, this.worldToMapLength(state.sun.radius));
        sunR = Math.min(sunR, this.size * 0.08);
      }
      this.drawGlowDot(sunMap.x, sunMap.y, sunR, this.sunColor, this.sunGlowColor);
    }

    for (const planet of this.getSpecialPlanets()) {
      if (planet && planet.pos) {
        const p = this.worldToMapPoint(planet.pos.x, planet.pos.y, x0, y0);
        this.drawGlowDot(p.x, p.y, this.specialRadius, this.specialColor, this.specialGlowColor);
      }
    }

    (state.cannons ?? []).forEach((cannon, idx) => {
      const route = cannon.points;
      g.setColor(this.cannonRouteColors[idx % this.cannonRouteColors.length]);
      g.setLineWidth(1);
      const dash = 4;
      const segs = cannon.closed ? route.length : route.length - 1;
      for (let i = 0; i < segs; i++) {
        const nextPoint = route[(i + 1) % route.length];
        const p = this.worldToMapPoint(route[i][0], route[i][1], x0, y0);
        const q = this.worldToMapPoint(nextPoint[0], nextPoint[1], x0, y0);
        const dx = q.x - p.x, dy = q.y - p.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 0) {
          for (let d = 0; d <= len - dash; d += dash * 2) {
            g.line(p.x + dx / len * d, p.y + dy / len * d,
              p.x + dx / len * (d + dash), p.y + dy / len * (d + dash));
          }
        }
      }
      for (const rail of cannon.rails) {
        if ((rail.loops ?? 0) > 0) {
          const c = this.worldToMapPoint(rail.cx, rail.cy, x0, y0);
          const r = Math.max(2.5, this.worldToMapLength(rail.radius));
          g.setColor(this.cannonColor);
          g.circle('line', c.x, c.y, r);
        }
      }
      for (const b of cannon.bumpers) {
        const m = this.worldToMapPoint(b.x, b.y, x0, y0);
        g.setColor(1, 0.3, 0.35, 1);
        g.circle('fill', m.x, m.y, 2);
      }
    });
    for (const cannon of (state.cannons ?? [])) {
      if (cannon.planet) {
        const a = this.worldToMapPoint(cannon.planet.pos.x, cannon.planet.pos.y, x0, y0);
        this.drawGlowDot(a.x, a.y, this.specialRadius, this.cannonColor, this.cannonGlowColor);
      }
    }

    if (state.player && state.player.pos) {
      const playerMap = this.worldToMapPoint(state.player.pos.x, state.player.pos.y, x0, y0);
      this.drawGlowDot(playerMap.x, playerMap.y, this.playerRadius, this.playerColor, this.playerGlowColor);
    }

    g.pop();

    g.setColor(this.borderColor);
    g.setLineWidth(1.5);
    g.rectangle('line', x0, y0, this.size, this.size);

    const bracket = Math.min(20, this.size * 0.12);
    g.setColor(this.cornerColor);
    g.setLineWidth(2);
    const corners = [
      [x0, y0, 1, 1],
      [x0 + this.size, y0, -1, 1],
      [x0, y0 + this.size, 1, -1],
      [x0 + this.size, y0 + this.size, -1, -1],
    ];
    for (const [ccx, ccy, dx, dy] of corners) {
      g.line(ccx, ccy + bracket * dy, ccx, ccy);
      g.line(ccx, ccy, ccx + bracket * dx, ccy);
    }

    g.setColor(this.labelColor);
    g.print('SECTOR MAP', x0 + 8, y0 - 18);

    g.setColor(1, 1, 1, 1);
    g.setLineWidth(1);
  }
}

export default Minimap;
