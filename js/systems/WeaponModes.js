// js/systems/WeaponModes.js
//
// Which blaster Bob is using, cycled with Tab (keyboard) or D-pad
// left/right (gamepad). Shown in the lower-left by js/ui/WeaponBar.js.
// The same modes, in the same order, as lua/systems/WeaponModes.lua.
//
// Every blaster except Portal fires with the LEFT mouse button (R2 on a
// gamepad):
//   fireball — fires fireballs
//   pullbeam — pull beam toward a planetoid (held)
//   water    — sprays water while held (see js/systems/WaterSystem.js)
//   ice      — fires ice bolts (see js/entities/IceBolt.js): water they
//              hit freezes, lava turns to water, Ooombas freeze solid
//   portal   — left click / L2 red portal, right click / R2 blue portal
//              (see js/systems/PortalGun.js)
//   recall   — rewinds the planetoid under the cursor (see js/systems/Recall.js)
//
// Gamepad L2 also stays a pull beam in Fireball and Pull Beam modes, so
// V.A.T.S. targeting (pick with the stick, pull with L2) works as before.
//
// state.weaponMode holds the current one; state.fireballMode/pullBeamMode/
// waterMode/iceMode/portalMode/recallMode are the same thing as plain
// flags, for the input code's checks.

import state from '../state.js';
import lua from '../love/lua.js';

const WeaponModes = {};

WeaponModes.ORDER = ['fireball', 'pullbeam', 'water', 'ice', 'portal', 'recall'];
WeaponModes.LABELS = {
  fireball: 'Fireball', pullbeam: 'Pull Beam', water: 'Water',
  ice: 'Ice', portal: 'Portal', recall: 'Recall',
};

WeaponModes.set = function (mode) {
  state.weaponMode = mode;
  state.fireballMode = mode === 'fireball';
  state.pullBeamMode = mode === 'pullbeam';
  state.waterMode = mode === 'water';
  state.iceMode = mode === 'ice';
  state.portalMode = mode === 'portal';
  state.recallMode = mode === 'recall';
  state.mouseDown = false;
  if (!WeaponModes.canPull() && state.player && state.player.pullTarget) {
    state.player.clearPullTarget();
  }
};

// Whether this blaster has a pull beam at all (Fireball and Pull Beam).
WeaponModes.canPull = function () {
  return state.weaponMode === 'fireball' || state.weaponMode === 'pullbeam';
};

WeaponModes.cycle = function (step) {
  const current = state.weaponMode ?? 'fireball';
  let index = 0;
  WeaponModes.ORDER.forEach((m, i) => { if (m === current) index = i; });
  const n = WeaponModes.ORDER.length;
  WeaponModes.set(WeaponModes.ORDER[lua.mod(index + (step ?? 1), n)]);
};

WeaponModes.label = function () {
  return WeaponModes.LABELS[state.weaponMode ?? 'fireball'];
};

export default WeaponModes;
