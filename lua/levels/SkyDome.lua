-- lua/levels/SkyDome.lua
--
-- The home sky dome, the Space Shelter on its deck, and the robot
-- butler beside the shelter. (The Tiled terrain inside the dome is
-- lua/levels/DomeInterior.lua.)

local state = require("lua.state")
local worldGen = require("lua.setup.WorldGen")
local SkyDomePlanetoid = require("lua.world.SkyDomePlanetoid")
local SpaceShelter = require("lua.world.SpaceShelter")
local RobotButler = require("lua.entities.RobotButler")
local GrassBlades = require("lua.effects.GrassBlades")

local SkyDome = {}

-- The home dome's cell — counted from the sun's own cell, so it stays in
-- the same place relative to the sun whatever size the map is (see
-- worldGen.GRID_SIZE). (It was cell 13, 9 on the original 20x20 map,
-- whose sun was in cell 10, 10.)
SkyDome.HOME_CELL_COL = worldGen.GRID_SIZE / 2 + 3
SkyDome.HOME_CELL_ROW = worldGen.GRID_SIZE / 2 - 1

-- Builds the dome and the shelter on it. Returns the dome.
function SkyDome.build()
  local cellSize = worldGen.CELL_SIZE
  -- Doubled from the original 2000 (see domeRadiusX/Y below, both tied
  -- to this same value) — twice as long, and since domeRadiusY scales
  -- with it too, twice as tall as well. domeX's own formula (below)
  -- keeps the dome's LEFT edge anchored at a fixed point regardless of
  -- this value (domeHalfW cancels out of domeX - domeHalfW), so growing
  -- it only extends the dome further to the right, in the same cell —
  -- no separate repositioning needed to keep it where it was relative
  -- to the belt.
  local domeHalfW = 4000
  -- Left edge of the home cell, hull just inside the cell
  local domeX = SkyDome.HOME_CELL_COL * cellSize + domeHalfW + 80
  local domeY = SkyDome.HOME_CELL_ROW * cellSize + cellSize * 0.5

  local dome = SkyDomePlanetoid.new(domeX, domeY, {
    halfWidth = domeHalfW,
    halfHeight = 32,
    grassHeight = 32,
    -- Tied to domeHalfW: resizing the dome only ever needs that one
    -- number changed.
    domeRadiusX = domeHalfW,
    domeRadiusY = domeHalfW,
  })
  dome.isPermanent = true
  table.insert(state.planetoids, dome)

  -- Tufts of grass blades along the walkable deck (decoration — see
  -- lua/effects/GrassBlades.lua), coloured from its grass texture.
  local deckHalfW = dome.halfWidth - (dome.cornerRadius or 0)
  dome.grassBlades = GrassBlades.buildStrip(dome.pos.x - deckHalfW, dome.pos.x + deckHalfW,
    dome:trueSurfaceY(), "img/grass.png", dome.pos.x)

  -- Astronaut's home shelter — purely decorative background scenery on
  -- the dome's own deck, toward the left side of it. Drawn separately
  -- (see love.draw), right after the dome itself and before the Tiled
  -- interior terrain, so the terrain's own hills draw over it wherever
  -- the two overlap rather than the shelter clipping on top of gameplay
  -- geometry.
  state.spaceShelter = SpaceShelter.new(domeX - domeHalfW * 0.6, dome:trueSurfaceY())
  state.skyDomePlanet = dome
  return dome
end

-- Robot butler NPC — paces back and forth just to the right of the
-- shelter's own footprint (see RobotButler.lua). Positioned off the
-- shelter's right edge plus a small gap, rather than a hardcoded offset,
-- so it stays adjacent even if the shelter's scale ever changes.
function SkyDome.addRobotButler(dome)
  local ROBOT_GAP_FROM_SHELTER = 60
  local robotHomeX = state.spaceShelter.pos.x + state.spaceShelter.drawWidth / 2 + ROBOT_GAP_FROM_SHELTER
  state.robotButler = RobotButler.new(robotHomeX, dome:trueSurfaceY())
end

return SkyDome
