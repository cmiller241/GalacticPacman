// js/systems/WeaponModes.js
//
// What the blaster's two buttons do, cycled with P (keyboard) or D-pad
// left/right (gamepad): blaster, ice (ice bolts — see js/entities/IceBolt.js:
// water they hit freezes, lava turns to water, Ooombas freeze solid),
// portal, water, recall.
//
// state.weaponMode holds the current one; state.iceMode/portalMode/waterMode/recallMode
// are the same thing as plain flags, for the input code's checks.

import state from '../state.js';
import lua from '../love/lua.js';

const WeaponModes = {};

WeaponModes.ORDER = ['blaster', 'ice', 'portal', 'water', 'recall'];
WeaponModes.LABELS = { blaster: 'Blaster', ice: 'Ice', portal: 'Portal', water: 'Water', recall: 'Recall' };

WeaponModes.set = function (mode) {
  state.weaponMode = mode;
  state.iceMode = mode === 'ice';
  state.portalMode = mode === 'portal';
  state.waterMode = mode === 'water';
  state.recallMode = mode === 'recall';
  if (mode !== 'blaster' && state.player && state.player.pullTarget) {
    state.player.clearPullTarget();
  }
};

// step: +1 for the next mode, -1 for the previous one.
WeaponModes.cycle = function (step) {
  const current = state.weaponMode ?? 'blaster';
  let index = 0;
  WeaponModes.ORDER.forEach((m, i) => { if (m === current) index = i; });
  const n = WeaponModes.ORDER.length;
  WeaponModes.set(WeaponModes.ORDER[lua.mod(index + (step ?? 1), n)]);
};

WeaponModes.label = function () {
  return WeaponModes.LABELS[state.weaponMode ?? 'blaster'];
};

export default WeaponModes;
