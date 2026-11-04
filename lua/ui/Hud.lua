-- lua/ui/Hud.lua
--
-- The text readout in the top-left corner: score, FPS, debug numbers and
-- the controls for the current blaster. Drawn in screen space.

local state = require("lua.state")
local worldGen = require("lua.setup.WorldGen")
local WaterSystem = require("lua.systems.WaterSystem")
local WeaponModes = require("lua.systems.WeaponModes")

local Hud = {}

local function controlsHint()
  if state.portalMode then
    return "Left-click / L2: red portal, Right-click / R2: blue portal, Space to jump"
  elseif state.waterMode then
    return string.format("Left-click / R2: spray water (%d / %d), Space to jump (or swim)",
      math.floor(WaterSystem.totalWater() + 0.5), WaterSystem.waterCap())
  elseif state.recallMode then
    return "Left-click / R2 on a planetoid: rewind it (again to stop), Space to jump"
  elseif state.iceMode then
    return "Left-click / R2: ice bolt (freezes water, cools lava, freezes Ooombas), Space to jump"
  elseif state.pullBeamMode then
    return "Left-click / R2 on a planet to pull toward it, Space to jump, C to toggle collision debug"
  end
  return "Left-click / R2: fireball (L2: pull beam), Space to jump, C to toggle collision debug"
end

function Hud.draw()
  local player = state.player
  local cell = worldGen.cellCoordFor(player.pos.x, player.pos.y)

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.print(string.format("Level %d - Score: %d", state.level, state.score), 20, 20)
  love.graphics.print(string.format("FPS: %.1f", state.fps or 0), 20, 40)
  love.graphics.print(string.format("Zoom: %.1fx (+/-)", state.zoom), 20, 60)
  love.graphics.print(string.format("Cell: (%d, %d)", cell.col, cell.row), 20, 80)
  love.graphics.print(string.format("Planetoids: %d  Coins: %d  Asteroids: %d  FireBars: %d",
    #state.planetoids,
    state.coins and #state.coins or 0,
    state.asteroids and #state.asteroids or 0,
    state.fireBars and #state.fireBars or 0
  ), 20, 100)
  love.graphics.print(string.format("Rubinium: %d  Asteroidium: %d", state.elements.rubinium, state.elements.asteroidium), 20, 120)
  love.graphics.print(string.format("Mode: %s (Tab / D-pad left-right to switch)   P: record clip", WeaponModes.label()), 20, 140)
  love.graphics.print(controlsHint(), 20, 160)

  -- On or near a dirt planet: which way its gravity pulls (see
  -- CrackedPlanetoid:cycleGravity).
  local p = player.currentPlanet or player.lastInfluencePlanet
  if p and p.cycleGravity then
    love.graphics.print(string.format("Gravity: %s (G to change)   Spin: %s (N clockwise, M counter-clockwise)",
      p.GRAVITY_LABELS[p.gravityMode] or p.gravityMode, p.SPIN_LABELS[p.spinDir] or "Off"), 20, 180)
  end
end

return Hud
