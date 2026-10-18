-- lua/systems/WeaponModes.lua
--
-- What the blaster's two buttons do, cycled with P (keyboard) or D-pad
-- left/right (gamepad):
--   blaster — left click / R2 fires fireballs, right click / L2 pull beam
--   portal  — left click / L2 red portal, right click / R2 blue portal
--             (see lua/systems/PortalGun.lua)
--   water   — right click / R2 sprays water (see lua/systems/WaterSystem.lua)
--
-- state.weaponMode holds the current one; state.portalMode/state.waterMode
-- are the same thing as plain flags, for the input code's checks.

local state = require("lua.state")

local WeaponModes = {}

WeaponModes.ORDER = { "blaster", "portal", "water" }
WeaponModes.LABELS = { blaster = "Blaster", portal = "Portal", water = "Water" }

function WeaponModes.set(mode)
  state.weaponMode = mode
  state.portalMode = mode == "portal"
  state.waterMode = mode == "water"
  -- A pull beam in progress is let go once its button does something else.
  if mode ~= "blaster" and state.player and state.player.pullTarget then
    state.player:clearPullTarget()
  end
end

-- step: +1 for the next mode, -1 for the previous one.
function WeaponModes.cycle(step)
  local current = state.weaponMode or "blaster"
  local index = 1
  for i, m in ipairs(WeaponModes.ORDER) do
    if m == current then index = i end
  end
  local n = #WeaponModes.ORDER
  WeaponModes.set(WeaponModes.ORDER[(index - 1 + (step or 1)) % n + 1])
end

function WeaponModes.label()
  return WeaponModes.LABELS[state.weaponMode or "blaster"]
end

return WeaponModes
