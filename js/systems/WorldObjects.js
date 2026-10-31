// js/systems/WorldObjects.js
//
// The registry of the world's object lists (state.levers, state.coins,
// state.fish, ...): how each kind is updated, when one is removed, how
// it's culled and drawn, and how its list starts out each game. main.js
// doesn't loop over these lists itself — it calls
//
//   WorldObjects.reset()                 in resetWorldState
//   WorldObjects.update(pass, dt)        at each update pass
//   WorldObjects.draw(layer)             at each draw layer
//   WorldObjects.drawDialogues()         with the HUD
//   WorldObjects.anyDialogueActive()     to freeze the player while talking
//
// To add a new kind of object:
//   1. describe it with kind(...) below;
//   2. put its key in an UPDATE_PASSES list (if it updates on its own);
//   3. put its key in a DRAW_LAYERS list (if it draws on its own).
// Update order and draw order are listed separately because they really
// do differ (a lever opens its gate during its own update, so gates
// update after levers, but gates are drawn behind them).
//
// Fireballs, ice bolts and plungers are updated by main.js itself, in the middle
// of its collision passes, and only drawn and reset through this
// registry. Port of lua/systems/WorldObjects.lua.

import state from '../state.js';
import utils from '../utils.js';
import Beam from '../world/Beam.js';
import Lava from '../world/Lava.js';
import WaterPlanet from '../world/WaterPlanet.js';
import Spikey from '../world/Spikey.js';
import MissileOutpost from '../world/MissileOutpost.js';
import PortalGun from './PortalGun.js';
import WaterSystem from './WaterSystem.js';
import CharacterShadows from '../effects/CharacterShadows.js';

const WorldObjects = {};

const isOnScreen = (x, y, r, m) => utils.isOnScreen(x, y, r, m);

// ---------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------
// Each kind's spec (every field optional):
//   single       state[key] is one object, not a list
//   startsEmpty  reset() makes the list [] rather than null
//   update(item, dt)
//   removeIf(item)   checked after update; true removes it (lists with
//                    removeIf are walked back to front)
//   onRemove(item)   called as it's removed
//   beforeUpdate()   once per frame, before the list's updates (only if
//                    the list exists)
//   visible(item)    false skips its draw (off-screen culling)
//   draw(item, i)    defaults to item.draw()
//   tooltip          also call item.drawTooltip() after drawing it
//   dialogue         has .dialogueActive and .drawDialogue()

const KINDS = {};

function kind(key, spec) {
  KINDS[key] = spec;
}

kind('asteroids', {
  startsEmpty: true,
  update: (a) => a.update(),
  visible: (a) => isOnScreen(a.pos.x, a.pos.y, a.radius, 50),
});

kind('coins', {
  startsEmpty: true,
  update: (c) => c.update(),
  visible: (c) => isOnScreen(c.pos.x, c.pos.y, c.radius, 20),
});

kind('ropeRocks', {
  // Rocks swinging on ropes (see js/world/RopeRock.js).
  update: (rr) => rr.update(state.timeScale),
  visible: (rr) => isOnScreen(rr.pos.x, rr.pos.y, rr.radius + rr.ropeLength, 50),
});

kind('ooombas', {
  update: (o) => o.update(),
  // Flung off through a portal and never came down (see Ooomba.updateAirborne).
  removeIf: (o) => o.lost,
  // (Mid-portal it's split across both portals, either of which may be
  // the one on screen — see PortalGun.drawOoomba.)
  visible: (o) => o.portalTransit || isOnScreen(o.pos.x, o.pos.y, Math.max(o.halfWidth, o.halfHeight), 20),
  draw: (o, i) => {
    PortalGun.drawOoomba(o);
    // ...with the shadows of any in front of it falling on it.
    CharacterShadows.drawOntoOoomba(i);
    // ...and, frozen, the ice cube round it (see WaterSystem.js's "Ice").
    if (o.iceBlock) WaterSystem.drawIceCube(o.iceBlock);
  },
});

kind('fireBars', {
  startsEmpty: true,
  update: (bar) => bar.update(),
  visible: (bar) => isOnScreen(bar.pos.x, bar.pos.y, bar.barLength + bar.fireballRadius, 50),
});

kind('lavas', {
  // (The lava itself is a liquid, in WaterSystem; these are the effects
  // played over lava turning to obsidian and back.)
  startsEmpty: true,
  beforeUpdate: () => Lava.updateSharedClock(),
  update: (lava) => lava.update(),
  visible: (lava) => isOnScreen(lava.pos.x, lava.pos.y, lava.radius, 50),
});

kind('spikeys', {
  // A plain Spikey never moves and has no update(); the moving kinds do.
  update: (sp) => { if (sp.update) sp.update(); },
  visible: (sp) => isOnScreen(sp.pos.x, sp.pos.y, sp.radius, 50),
});

kind('levers', {
  update: (lever) => lever.update(),
  visible: (lever) => isOnScreen(lever.pos.x, lever.pos.y, 80, 20),
  tooltip: true,
});

kind('cranks', {
  update: (crank) => crank.update(),
  visible: (crank) => isOnScreen(crank.pos.x, crank.pos.y, 80, 20),
  tooltip: true,
});

kind('plungers', {
  // Updated by main.js alongside the player's collisions (they're solid
  // to him) — see js/world/Plunger.js.
  visible: (plunger) => isOnScreen(plunger.pos.x, plunger.pos.y, plunger.radius, 20),
});

kind('signs', {
  update: (sign) => sign.update(),
  visible: (sign) => isOnScreen(sign.pos.x, sign.pos.y, 80, 20),
  tooltip: true,
  dialogue: true,
});

kind('mirrors', {
  update: (mirror) => mirror.update(),
  visible: (mirror) => isOnScreen(mirror.pos.x, mirror.pos.y, 80, 20),
});

kind('beams', {
  update: (beam) => beam.update(),
  visible: (beam) => isOnScreen(beam.pos.x, beam.pos.y, Beam.LENGTH, 60),
  tooltip: true,
});

kind('gates', {
  update: (gate) => gate.update(state.timeScale ?? 1),
  visible: (gate) => isOnScreen(gate.pos.x, gate.pos.y, Math.max(gate.halfWidth, gate.halfHeight), 20),
});

kind('fish', {
  update: (fish) => fish.update(),
  visible: (fish) => isOnScreen(fish.pos.x, fish.pos.y, 70, 50),
});

kind('spaceShelter', {
  single: true,
  // Held at the very start of its opening sequence for as long as the
  // title screen is up. (Drawn by drawFrame itself: its body and door go
  // at different depths.)
  update: (shelter, dt) => {
    if (state.titleScreen) return;
    shelter.update(dt);
    if (state.introLocked && shelter.introDone) state.introLocked = false;
  },
});

kind('robotButler', {
  single: true,
  update: (r) => r.update(),
  visible: (r) => isOnScreen(r.pos.x, r.pos.y, Math.max(r.halfWidth, r.halfHeight), 20),
  tooltip: true,
  dialogue: true,
});

kind('fisherman', {
  single: true,
  update: (f) => f.update(),
  // drawBoundRadius, not just his body: his fishing line reaches far
  // below him (see Fisherman.js).
  visible: (f) => isOnScreen(f.pos.x, f.pos.y, f.drawBoundRadius, 20),
  tooltip: true,
  dialogue: true,
});

kind('prisms', {
  update: (prism, dt) => prism.update(dt * (state.timeScale ?? 1)),
  visible: (m) => isOnScreen(m.planet.pos.x, m.planet.pos.y, m.reach(), 50),
});

kind('elementPieces', {
  // Rubinium and asteroidium on their way to him: each piece that arrives
  // is counted and gone.
  startsEmpty: true,
  update: (piece, dt) => piece.update(dt * (state.timeScale ?? 1), state.player),
  removeIf: (piece) => piece.collected,
  onRemove: (piece) => {
    state.elements[piece.elementName] += 1;
    if (state.audioManager) state.audioManager.playEatDot();
  },
  visible: (piece) => isOnScreen(piece.pos.x, piece.pos.y, piece.radius, 50),
});

// Updated by main.js (they collide with nearly everything).
kind('fireballs', { startsEmpty: true });
kind('iceBolts', { startsEmpty: true });

// Purely time-driven visuals.
kind('explosions', {
  startsEmpty: true,
  update: (e) => e.update(),
  removeIf: (e) => e.isDead(),
});
kind('wallContactPulses', {
  startsEmpty: true,
  update: (p) => p.update(),
  removeIf: (p) => p.isDead(),
});
kind('particles', {
  startsEmpty: true,
  update: (p) => p.update(),
  removeIf: (p) => p.life <= 0,
});

// ---------------------------------------------------------------------
// Update passes
// ---------------------------------------------------------------------
// Run in order by WorldObjects.update(pass, dt). A string is a kind's
// key; a function is a plain step that has to happen at that point.

// The belt outposts: their Ooombas noticing him, manning the cannons, and
// the homing missiles. Not while the title screen's autopilot is playing.
function updateMissileOutposts() {
  if (!state.outposts) return;
  if (state.titleScreen) MissileOutpost.restock(state.outposts);
  else MissileOutpost.updateAll(state.outposts, state.player);
}

function updateSharedClocks() {
  WaterPlanet.updateSharedClock();
  Spikey.updateSharedClock();
}

const UPDATE_PASSES = {
  // After the planetoids have moved (and Recall has rewound any), before
  // the player moves.
  world: [
    'ropeRocks', 'asteroids', 'coins', 'ooombas',
    updateMissileOutposts,
    'fireBars', 'lavas',
    updateSharedClocks,
    'spikeys', 'levers', 'cranks', 'signs', 'mirrors', 'beams', 'gates',
    'fish', 'spaceShelter', 'robotButler', 'fisherman', 'prisms',
    'elementPieces',
  ],
  // At the end of the frame, after every collision has spawned its effects.
  effects: ['explosions', 'wallContactPulses', 'particles'],
};

// ---------------------------------------------------------------------
// Draw layers
// ---------------------------------------------------------------------
// Each drawn back to front, in world space, by WorldObjects.draw(layer);
// see drawFrame in main.js for where each layer sits in the scene.
const DRAW_LAYERS = {
  // Behind the planetoids.
  backdrop: ['asteroids'],
  // Before the planetoids, so the one each stands on covers its sunken foot.
  planetFeet: ['prisms'],
  // Over the planetoids and cannons, behind the Tiled level.
  hazards: ['spikeys'],
  // Over the Tiled level.
  props: ['ropeRocks', 'gates', 'levers', 'plungers', 'cranks', 'signs', 'mirrors'],
  enemies: ['ooombas'],
  // Over the outposts' missiles; behind the portals and the player (beams
  // go last so he stands in front of one he's at).
  actors: ['robotButler', 'fisherman', 'coins', 'fireBars', 'beams'],
  // After the player and before the water's top layer, so the water (or
  // lava) covers them, reading as submerged.
  submerged: ['fish', 'lavas'],
  // Over everything else in the world.
  effects: ['fireballs', 'iceBolts', 'particles', 'elementPieces', 'explosions', 'wallContactPulses'],
};

// Characters with conversations, in the order their textboxes draw.
const DIALOGUE_KINDS = ['robotButler', 'fisherman', 'signs'];

// Everything the player can interact with (Enter / Circle — see
// js/world/Interactable.js), in the order a press reaches them. Each
// one's tryInteract checks for itself whether he's close enough.
const INTERACTIVE_KINDS = ['robotButler', 'fisherman', 'levers', 'cranks', 'signs', 'beams'];

// ---------------------------------------------------------------------
// Running them
// ---------------------------------------------------------------------

function eachItem(key, fn) {
  const value = state[key];
  if (value == null) return;
  if (KINDS[key].single) fn(value, 0);
  else value.forEach(fn);
}

// Every list back to how a new game starts it: [] for startsEmpty kinds,
// otherwise null (the world builder creates them).
WorldObjects.reset = function () {
  for (const [key, spec] of Object.entries(KINDS)) state[key] = spec.startsEmpty ? [] : null;
};

function updateKind(key, dt) {
  const spec = KINDS[key];
  const list = state[key];
  if (list == null || !spec.update) return;
  if (spec.beforeUpdate) spec.beforeUpdate();
  if (spec.single) {
    spec.update(list, dt);
  } else if (spec.removeIf) {
    for (let i = list.length - 1; i >= 0; i--) {
      const item = list[i];
      spec.update(item, dt);
      if (spec.removeIf(item)) {
        if (spec.onRemove) spec.onRemove(item);
        list.splice(i, 1);
      }
    }
  } else {
    for (const item of list) spec.update(item, dt);
  }
}

WorldObjects.update = function (pass, dt) {
  for (const entry of UPDATE_PASSES[pass]) {
    if (typeof entry === 'function') entry(dt);
    else updateKind(entry, dt);
  }
};

WorldObjects.draw = function (layer) {
  for (const key of DRAW_LAYERS[layer]) {
    const { visible, draw, tooltip } = KINDS[key];
    eachItem(key, (item, i) => {
      if (visible && !visible(item)) return;
      if (draw) draw(item, i); else item.draw();
      if (tooltip) item.drawTooltip();
    });
  }
};

// The interact button (Enter, or Circle on a pad): offered to everything
// interactive. Not while he's curled into a ball — no talking to NPCs or
// pulling levers as a ball.
WorldObjects.interact = function (player) {
  if (!player || player.isBall) return;
  for (const key of INTERACTIVE_KINDS) eachItem(key, (item) => item.tryInteract(player));
};

WorldObjects.drawDialogues = function () {
  for (const key of DIALOGUE_KINDS) eachItem(key, (item) => item.drawDialogue());
};

// Recomputed fresh every frame from whichever characters have a textbox
// open now.
WorldObjects.anyDialogueActive = function () {
  for (const key of DIALOGUE_KINDS) {
    const value = state[key];
    if (value == null) continue;
    if (KINDS[key].single) {
      if (value.dialogueActive) return true;
    } else if (value.some((item) => item.dialogueActive)) {
      return true;
    }
  }
  return false;
};

export default WorldObjects;
