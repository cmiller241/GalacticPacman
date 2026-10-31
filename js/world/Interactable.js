// js/world/Interactable.js
//
// Shared by everything the player can interact with (Enter on the
// keyboard, Circle on a pad): the robot butler, the fisherman, beams,
// levers, cranks and signs. Each of those has
//
//   this.interactRadius     how close he has to be
//   this.playerNearby       set each update from isPlayerNear, read by
//                           its drawTooltip (the button prompt)
//   tryInteract(player)     what happens when he presses the button —
//                           each checks isPlayerNear itself first
//
// and is listed in js/systems/WorldObjects.js's INTERACTIVE_KINDS, which
// is what the input handlers call (WorldObjects.interact). Port of
// lua/world/Interactable.lua.

const Interactable = {
  // Whether the player is within this.interactRadius of this.pos.
  isPlayerNear(player) {
    if (!player) return false;
    const dx = player.pos.x - this.pos.x, dy = player.pos.y - this.pos.y;
    return (dx * dx + dy * dy) <= this.interactRadius * this.interactRadius;
  },
};

export default Interactable;
