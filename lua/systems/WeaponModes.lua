-- lua/systems/WeaponModes.lua
--
-- Which blaster Bob is using, cycled with Tab (keyboard) or D-pad
-- left/right (gamepad). Shown in the lower-left by lua/ui/WeaponBar.lua.
--
-- Every blaster except Portal fires with the LEFT mouse button (R2 on a
-- gamepad):
--   fireball — fires fireballs
--   pullbeam — pull beam toward a planetoid (held)
--   water    — sprays water while held (see lua/systems/WaterSystem.lua)
--   ice      — fires ice bolts (see lua/entities/IceBolt.lua): water they
--              hit freezes, lava turns to water, Ooombas freeze solid
--   portal   — left click / L2 red portal, right click / R2 blue portal
--              (see lua/systems/PortalGun.lua)
--   recall   — rewinds the planetoid under the cursor (see lua/systems/Recall.lua)
--
-- Gamepad L2 also stays a pull beam in Fireball and Pull Beam modes, so
-- V.A.T.S. targeting (pick with the stick, pull with L2) works as before.
--
-- state.weaponMode holds the current one; state.fireballMode/pullBeamMode/
-- waterMode/iceMode/portalMode/recallMode are the same thing as plain
-- flags, for the input code's checks.

local state = require("lua.state")

local WeaponModes = {}

WeaponModes.ORDER = { "fireball", "pullbeam", "water", "ice", "portal", "recall" }
WeaponModes.LABELS = {
  fireball = "Fireball", pullbeam = "Pull Beam", water = "Water",
  ice = "Ice", portal = "Portal", recall = "Recall",
}

function WeaponModes.set(mode)
  state.weaponMode = mode
  state.fireballMode = mode == "fireball"
  state.pullBeamMode = mode == "pullbeam"
  state.waterMode = mode == "water"
  state.iceMode = mode == "ice"
  state.portalMode = mode == "portal"
  state.recallMode = mode == "recall"
  -- Held fire stops when the mode changes.
  state.mouseDown = false
  -- A pull beam in progress is let go once nothing that pulls is selected.
  if not WeaponModes.canPull() and state.player and state.player.pullTarget then
    state.player:clearPullTarget()
  end
end

-- Modes the pull beam works in (left click in Pull Beam; gamepad L2 in
-- Fireball and Pull Beam).
function WeaponModes.canPull()
  return state.weaponMode == "fireball" or state.weaponMode == "pullbeam"
end

-- step: +1 for the next mode, -1 for the previous one.
function WeaponModes.cycle(step)
  local current = state.weaponMode or "fireball"
  local index = 1
  for i, m in ipairs(WeaponModes.ORDER) do
    if m == current then index = i end
  end
  local n = #WeaponModes.ORDER
  WeaponModes.set(WeaponModes.ORDER[(index - 1 + (step or 1)) % n + 1])
end

function WeaponModes.label()
  return WeaponModes.LABELS[state.weaponMode or "fireball"]
end

return WeaponModes
