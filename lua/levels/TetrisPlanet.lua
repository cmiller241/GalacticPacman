-- lua/levels/TetrisPlanet.lua
--
-- The Tetris planet: a round planet with a small control room inside
-- (see lua/interiors/ControlRoom.lua, drawn automatically for any
-- planetoid with an .interior). The beam on its top takes him in; the
-- one on the room's pad takes him back out. At the room's control panel
-- he spins the planet, and Tetris shapes fall in at it from all sides,
-- sticking where they land and turning with it (see
-- lua/world/TetrisField.lua).
--
-- It never drifts, and is kept clear of random spawns all round (the
-- shapes fall in from a long way out).

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local worldGen = require("lua.setup.WorldGen")
local Planetoid = require("lua.world.Planetoid")
local Beam = require("lua.world.Beam")
local ControlRoom = require("lua.interiors.ControlRoom")
local TetrisField = require("lua.world.TetrisField")

local TetrisPlanet = {}

local OFFSET_X, OFFSET_Y = 6500, -8500 -- from the sun
local COLOR = { 0.50, 0.36, 0.72 }
local BEAM_COLOR = { 1.00, 0.45, 0.80 }
local RADIUS = 420

function TetrisPlanet.build()
  local sunX, sunY = worldGen.sunPos()
  local planet = Planetoid.new(sunX + OFFSET_X, sunY + OFFSET_Y, RADIUS, COLOR)
  planet.isImmovable = true
  planet.isPermanent = true
  planet.isSpawnExclusion = true
  planet.vel.x, planet.vel.y = 0, 0
  planet.interior = ControlRoom.new(planet, TetrisField.new(planet), BEAM_COLOR)
  -- (Every frame: the game eases the planet's turn and drops its shapes.)
  planet.update = function(self) self.interior:updateGame() end
  table.insert(state.planetoids, planet)
  state.tetrisPlanet = planet
  return planet
end

-- The beam in, on top (shown while he's outside), and the beam out, on
-- the room's pad (shown while he's in).
function TetrisPlanet.addBeams(planet)
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

return TetrisPlanet
