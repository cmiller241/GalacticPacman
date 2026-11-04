// js/ui/Hud.js
//
// The text readout in the top-left corner: score, FPS, debug numbers and
// the controls for the current blaster. Drawn in screen space. (A port of
// lua/ui/Hud.lua.)

import love from '../love/index.js';
import state from '../state.js';
import worldGen from '../setup/WorldGen.js';
import WaterSystem from '../systems/WaterSystem.js';
import WeaponModes from '../systems/WeaponModes.js';

function controlsHint() {
  if (state.portalMode) return 'Left-click / L2: red portal, Right-click / R2: blue portal, Space to jump';
  if (state.waterMode) {
    return `Left-click / R2: spray water (${Math.floor(WaterSystem.totalWater() + 0.5)} / ${WaterSystem.waterCap()}), Space to jump (or swim)`;
  }
  if (state.recallMode) return 'Left-click / R2 on a planetoid: rewind it (again to stop), Space to jump';
  if (state.iceMode) return 'Left-click / R2: ice bolt (freezes water, cools lava, freezes Ooombas), Space to jump';
  if (state.pullBeamMode) return 'Left-click / R2 on a planet to pull toward it, Space to jump, C to toggle collision debug';
  return 'Left-click / R2: fireball (L2: pull beam), Space to jump, C to toggle collision debug';
}

const Hud = {};

Hud.draw = function () {
  const g = love.graphics;
  const player = state.player;
  g.setColor(1, 1, 1, 1);
  g.print(`Level ${state.level} - Score: ${state.score}`, 20, 20);
  g.print(`FPS: ${(state.fps ?? 0).toFixed(1)}`, 20, 40);
  // The rest is keyboard/mouse help and debug readouts — not shown with
  // the touch controls, which are their own guide.
  if (state.touchControlsVisible) return;

  const cell = worldGen.cellCoordFor(player.pos.x, player.pos.y);
  g.print(`Zoom: ${state.zoom.toFixed(1)}x (+/-)`, 20, 60);
  g.print(`Cell: (${cell.col}, ${cell.row})`, 20, 80);
  g.print(`Planetoids: ${state.planetoids.length}  Coins: ${state.coins ? state.coins.length : 0}  Asteroids: ${state.asteroids ? state.asteroids.length : 0}  FireBars: ${state.fireBars ? state.fireBars.length : 0}`, 20, 100);
  g.print(`Rubinium: ${state.elements.rubinium}  Asteroidium: ${state.elements.asteroidium}`, 20, 120);
  g.print(`Mode: ${WeaponModes.label()} (Tab / D-pad left-right to switch)`, 20, 140);
  g.print(controlsHint(), 20, 160);

  // On or near a dirt planet: which way its gravity pulls (see
  // CrackedPlanetoid.cycleGravity).
  const p = player.currentPlanet ?? player.lastInfluencePlanet;
  if (p && p.cycleGravity) {
    g.print(`Gravity: ${p.GRAVITY_LABELS[p.gravityMode] ?? p.gravityMode} (G to change)   Spin: ${p.SPIN_LABELS[p.spinDir] ?? 'Off'} (N clockwise, M counter-clockwise)`, 20, 180);
  }
};

export default Hud;
