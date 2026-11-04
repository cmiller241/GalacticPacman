-- lua/world/Interactable.lua
--
-- Shared by everything the player can interact with (Enter on the
-- keyboard, Circle on a pad): the robot butler, the fisherman, beams,
-- levers, cranks and signs. Each of those has
--
--   self.interactRadius     how close he has to be
--   self.playerNearby       set each update from :isPlayerNear, read by
--                           its :drawTooltip (the button prompt)
--   :tryInteract(player)    what happens when he presses the button —
--                           each checks :isPlayerNear itself first
--
-- and is marked `interactive` in lua/systems/WorldObjects.lua, which is
-- what the input handlers call (WorldObjects.interact).

local Interactable = {}

-- Whether the player is within self.interactRadius of self.pos.
function Interactable.isPlayerNear(self, player)
  if not player then return false end
  local dx, dy = player.pos.x - self.pos.x, player.pos.y - self.pos.y
  return (dx * dx + dy * dy) <= self.interactRadius * self.interactRadius
end

return Interactable
