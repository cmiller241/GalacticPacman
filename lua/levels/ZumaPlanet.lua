-- lua/levels/ZumaPlanet.lua
--
-- The Zuma planet: a round planet with a small control room inside (see
-- lua/interiors/ControlRoom.lua, drawn automatically for any planetoid
-- with an .interior). The beam on its top takes him in; the one on the
-- room's pad takes him back out. At the room's control panel a cannon
-- comes up on the planet's surface, a black hole forms out in space, and
-- a train of colored balls rolls out of it, spiraling in round the
-- planet (see lua/world/ZumaField.lua).
--
-- It sits in the middle of a world cell of its own (CELL_FROM_SUN cells
-- from the sun's, out past the asteroid belt), and never drifts. Nothing
-- random is made in its cell or the eight round it (spawnExclusionCells —
-- see WorldGen's cellIntersectsLandmark), and a planetoid drifting in from
-- further off bounces off a ring round the whole game (keepOutRadius —
-- see main.lua's updatePlanetoidsPhysics), so nothing floats into it.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local worldGen = require("lua.setup.WorldGen")
local Planetoid = require("lua.world.Planetoid")
local Beam = require("lua.world.Beam")
local ControlRoom = require("lua.interiors.ControlRoom")
local ZumaField = require("lua.world.ZumaField")

local ZumaPlanet = {}

-- Which cell, counted from the sun's (columns right, rows down).
local CELL_FROM_SUN = { 4, 1 }
local RADIUS = 300
local COLOR = { 0.32, 0.58, 0.36 }      -- jungle green
local BEAM_COLOR = { 1.00, 0.80, 0.30 } -- gold

function ZumaPlanet.build()
  local sunCol, sunRow = worldGen.sunCell()
  local size = worldGen.CELL_SIZE
  local x = (sunCol + CELL_FROM_SUN[1] + 0.5) * size
  local y = (sunRow + CELL_FROM_SUN[2] + 0.5) * size
  local planet = Planetoid.new(x, y, RADIUS, COLOR)
  planet.isImmovable = true
  planet.isPermanent = true
  planet.isSpawnExclusion = true
  planet.spawnExclusionCells = 1 -- (its cell and the eight round it)
  planet.keepOutRadius = ZumaField.REACH
  planet.vel.x, planet.vel.y = 0, 0
  planet.interior = ControlRoom.new(planet, ZumaField.new(planet), BEAM_COLOR)
  -- (Every frame: the game runs, and animates whether he's playing or not.)
  planet.update = function(self) self.interior:updateGame() end
  table.insert(state.planetoids, planet)
  state.zumaPlanet = planet
  return planet
end

-- The beam in, on top (shown while he's outside), and the beam out, on
-- the room's pad (shown while he's in).
function ZumaPlanet.addBeams(planet)
  local interior = planet.interior
  local pad = interior:padPosition()
  local exit = interior:exitPosition()

  local inBeam = Beam.new(planet.pos.x, planet.pos.y - planet.radius, -math.pi / 2, BEAM_COLOR)
  inBeam.destination = {
    pos = pad,
    angle = -math.pi / 2,
    onArrive = function(player) interior:onEnter(player) end,
  }
  inBeam.showWhen = function() return not interior:hasPlayer() end

  local outBeam = Beam.new(pad.x, pad.y, -math.pi / 2, BEAM_COLOR)
  outBeam.destination = {
    pos = Vector2.new(exit.x, exit.y),
    angle = ControlRoom.EXIT_ANGLE,
    onArrive = function(player) interior:arriveOutside(player) end,
  }
  outBeam.showWhen = function() return interior:hasPlayer() end
  outBeam.fade = 0 -- (hidden from the start, not fading out)
  -- (A small room: he has to be at the pad, not just near it.)
  outBeam.interactRadius = 70

  interior.beam = outBeam
  table.insert(state.beams, inBeam)
  table.insert(state.beams, outBeam)
end

return ZumaPlanet
