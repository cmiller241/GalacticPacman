-- lua/levels/MazePlanet.lua
--
-- The maze planet: a square RoundedRectPlanetoid holding a cube of six
-- maze faces, one showing at a time (see lua/interiors/MazeInterior.lua,
-- drawn automatically for any planetoid with an .interior). Entered
-- through the beam on its top, which drops the player in the middle of
-- the front face, already a ball; the exit in the middle of the back face
-- puts him back on top, beside the beam.
--
-- Up and to the left of the sun, just past the belt's outer edge, clear
-- of the pinball planet and the missile outposts. Its cells are kept free
-- of random spawns (see WorldGen.lua's cellIntersectsLandmark and the
-- isSpawnExclusion flag).

local state = require("lua.state")
local worldGen = require("lua.setup.WorldGen")
local RoundedRectPlanetoid = require("lua.world.RoundedRectPlanetoid")
local MazeInterior = require("lua.interiors.MazeInterior")
local Beam = require("lua.world.Beam")

local MazePlanet = {}

local OFFSET_X, OFFSET_Y = -6500, -8500 -- from the sun
-- The planet is exactly one maze face, square-cornered: rolling from one
-- face to the next then looks like the planet itself turning over.
local CORNER_RADIUS = 0
local COLOR = { 0.08, 0.10, 0.30, 1 } -- the maze walls' dark blue
local BEAM_COLOR = { 0.35, 0.80, 1.00 } -- the pinball beam's effect, in blue

function MazePlanet.build()
  local sunX, sunY = worldGen.sunPos()
  local x, y = sunX + OFFSET_X, sunY + OFFSET_Y
  -- (The maze's size, before there's a planet to put it on.)
  local half = MazeInterior.SIZE * MazeInterior.TILE / 2
  local halfW, halfH = half, half
  local planet = RoundedRectPlanetoid.new(x, y, halfW, halfH, CORNER_RADIUS, COLOR)
  planet.isImmovable = true
  planet.isPermanent = true
  planet.isSpawnExclusion = true
  planet.vel.x, planet.vel.y = 0, 0
  planet.rotationAngle = 0
  planet.rotationSpeed = 0
  -- The maze covers nearly all of the face, so the body is baked at 1x
  -- rather than 2x (saving about 40 MB of texture memory).
  planet.bodyCanvasScale = 1
  planet.interior = MazeInterior.new(planet)
  table.insert(state.planetoids, planet)
  state.mazePlanet = planet
  return planet
end

-- The entry beam on the planet's top. One-way, like the pinball planet's
-- (see PinballPlanet.addEntryBeam): its destination is a plain table, and
-- onArrive hands him to the maze. He gets back out by the maze's exit.
function MazePlanet.addEntryBeam(planet)
  local beamX = planet.pos.x - planet.halfWidth * 0.4
  local beamY = planet.pos.y - planet.halfHeight
  local beam = Beam.new(beamX, beamY, -math.pi / 2, BEAM_COLOR)
  beam.destination = {
    pos = planet.interior:getPortalPosition(),
    angle = -math.pi / 2,
    onArrive = function(player)
      planet.interior:onEnter(player)
    end,
  }
  -- Only there while he's outside: it fades away once he's in the maze,
  -- and back once he's out (see Beam:isShown).
  beam.showWhen = function()
    return not (state.player and state.player.inInterior == planet.interior)
  end
  table.insert(state.beams, beam)
  -- The exit puts him back on top, a little to the beam's right (clear
  -- of it, so he isn't beamed straight back in).
  planet.interior.exitPosition = { x = beamX + planet.halfWidth * 0.3 }
end

return MazePlanet
