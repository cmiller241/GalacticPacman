// js/systems/water/Effects.js
//
// Splashes and steam: spawning them, hot spots boiling water off, and
// drawing the steam.
// Part of the water system: see js/systems/WaterSystem.js.

import love from '../../love/index.js';
import state from '../../state.js';
import utils from '../../utils.js';
import {
  SPLASH_BITS, SPLASH_SECONDS, BOIL_PER_SECOND, HOT_SECONDS, STEAM_PER_SECOND,
  STEAM_SECONDS, STEAM_RISE, STEAM_START_DEPTH, STEAM_SIZE, STEAM_GROWTH,
  STEAM_ALPHA, COLOR_STEAM,
} from './Tuning.js';
import { shared, rnd } from './Shared.js';
import { depthOf, surfaceDistance } from './Oceans.js';
import { boilGrid } from './LevelGrid.js';
import { boilPlanetGrid } from './PlanetGrids.js';

// (lava: lava splashing, drawn hot instead of watery.)
function spawnSplash(x, y, upX, upY, lava = false) {
  for (let k = 0; k < SPLASH_BITS; k++) {
    const a = Math.atan2(upY, upX) + (rnd() * 2 - 1) * 1.1;
    const speed = 1.5 + rnd() * 2.5;
    shared.splashes.push({
      x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
      gx: -upX * 0.3, gy: -upY * 0.3,
      life: SPLASH_SECONDS, size: 1 + rnd() * 1.5, lava,
    });
  }
}

function spawnSteam(x, y, upX, upY, spread) {
  const a = Math.atan2(upY, upX) + (rnd() * 2 - 1) * (spread ?? 0.6);
  const speed = STEAM_RISE * (0.5 + rnd());
  const life = STEAM_SECONDS * (0.7 + rnd() * 0.6);
  const depth = STEAM_START_DEPTH * (0.3 + rnd() * 0.7);
  x -= upX * depth; y -= upY * depth;
  shared.steam.push({
    x: x + (rnd() * 2 - 1) * 6, y: y + (rnd() * 2 - 1) * 3,
    vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, life, maxLife: life,
  });
}

function updateSteam(dt) {
  const ts = state.timeScale ?? 1;
  const gameDt = ts / 60;

  for (let i = shared.hotSpots.length - 1; i >= 0; i--) {
    const h = shared.hotSpots[i];
    const heat = h.life / HOT_SECONDS;
    const amount = BOIL_PER_SECOND * heat * gameDt;
    let sx = null, sy, upX, upY;
    const o = h.planet ? shared.oceans.get(h.planet) : null;
    if (h.planet) {
      if (o) {
        o.volume = Math.max(0, o.volume - amount);
        const depth = depthOf(h.planet, o.volume);
        const qx = h.planet.pos.x + h.ox + (rnd() * 2 - 1) * 20;
        const qy = h.planet.pos.y + h.oy + (rnd() * 2 - 1) * 20;
        let d;
        [d, upX, upY] = surfaceDistance(h.planet, qx, qy);
        sx = qx + upX * (depth - d); sy = qy + upY * (depth - d);
      }
    } else if (h.pg) {
      const res = boilPlanetGrid(h.pg, h.c, h.r, amount);
      if (res) [sx, sy, upX, upY] = res;
    } else if (shared.grid) {
      const res = boilGrid(h.c, h.r, amount);
      if (res) [sx, sy] = res;
      upX = 0; upY = -1;
    }
    h.steamBudget += STEAM_PER_SECOND * heat * gameDt;
    while (h.steamBudget >= 1) {
      h.steamBudget -= 1;
      if (sx != null) spawnSteam(sx, sy, upX, upY, 0.4);
    }
    h.life -= gameDt;
    if (h.life <= 0 || sx == null) shared.hotSpots.splice(i, 1);
  }

  let gone = null;
  for (let i = shared.steam.length - 1; i >= 0; i--) {
    const s = shared.steam[i];
    s.life -= gameDt;
    if (s.life <= 0) {
      (gone ??= new Set()).add(s);
    } else {
      s.vx += (rnd() - 0.5) * 0.06 * ts;
      s.x += s.vx * ts; s.y += s.vy * ts;
    }
  }
  if (gone) utils.removeMarked(shared.steam, gone);
}

function drawSteam() {
  const g = love.graphics;
  for (const s of shared.steam) {
    const t = 1 - s.life / s.maxLife;
    const alpha = STEAM_ALPHA * (1 - t) * Math.min(1, 0.5 + t * 6);
    g.setColor(COLOR_STEAM[0], COLOR_STEAM[1], COLOR_STEAM[2], alpha);
    g.circle('fill', s.x, s.y, STEAM_SIZE + STEAM_GROWTH * t);
  }
  g.setColor(1, 1, 1, 1);
}

export { spawnSplash, spawnSteam, updateSteam, drawSteam };
