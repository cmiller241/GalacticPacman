-- lua/levels/PinballPlanet.lua
--
-- The "pinball" planet — a tall RoundedRectPlanetoid with a playable
-- pinball table on its face, built from the Tiled map
-- tiled/Pinball-Level2.lua (see lua/interiors/PinballInterior.lua, drawn
-- automatically for any planetoid with an .interior). Entered through
-- the orange beam on its top, or by pull-beaming over from the belt.
--
-- The dome's mirror image across the sun: on the sun's LEFT, centered on
-- its height, with its right edge about the same distance from the sun
-- as the dome's left edge — just past the belt's outer edge, so it's in
-- view (and in pull-beam/lock-on reach) from the belt's left side. Its
-- cells are kept free of random spawns (see WorldGen.lua's
-- cellIntersectsLandmark and the isSpawnExclusion flag).

local state = require("lua.state")
local worldGen = require("lua.setup.WorldGen")
local RoundedRectPlanetoid = require("lua.world.RoundedRectPlanetoid")
local PinballInterior = require("lua.interiors.PinballInterior")
local Beam = require("lua.world.Beam")

local PinballPlanet = {}

-- The table is drawn centered on the planet at 64 world units per tile;
-- the planet is a margin bigger than it on every side, so the table's
-- square corners sit inside the planet's rounded ones.
local PINBALL_PLANET_MARGIN = 128
local PINBALL_EXTRA_GAP = 100 -- nudged a little further out than the dome's mirror point
-- Experimental: radians per frame the planet turns about its center
-- (0.0009 is about one full turn every two minutes). Off for now — see
-- docs/Pinball-Rotation-Ideas.md. The table turns with it (see
-- PinballInterior's tableToWorld/worldToTable), but the orange entry
-- beam does NOT, and at its current spot a turning planet swings into
-- the belt.
local TEMP_PINBALL_ROTATION_SPEED = 0

function PinballPlanet.build(dome)
  local pinballMap = require("tiled.Pinball-Level2")
  local halfW = pinballMap.width * 64 / 2 + PINBALL_PLANET_MARGIN
  local halfH = pinballMap.height * 64 / 2 + PINBALL_PLANET_MARGIN
  local sunX, sunY = worldGen.sunPos()
  local domeEdgeFromSun = (dome.pos.x - dome.halfWidth) - sunX
  local planet = RoundedRectPlanetoid.new(
    sunX - domeEdgeFromSun - PINBALL_EXTRA_GAP - halfW, sunY, halfW, halfH, 64, { 0.55, 0.57, 0.62, 1 })
  planet.isImmovable = true
  planet.isPermanent = true
  planet.isSpawnExclusion = true
  planet.vel.x, planet.vel.y = 0, 0
  planet.rotationAngle = 0
  planet.rotationSpeed = TEMP_PINBALL_ROTATION_SPEED
  -- Baked at 0.5x instead of the default 2x: at this size a 2x body
  -- canvas would be over 20000 pixels tall, past GPUs' texture limits.
  -- The table covers almost all of the face, so it barely shows.
  planet.bodyCanvasScale = 0.5
  planet.interior = PinballInterior.new(planet, pinballMap)
  table.insert(state.planetoids, planet)
  state.pinballPlanet = planet
  return planet
end

-- The entry beam, planted on top of the planet. Stepping through it
-- drops the player onto the plunger, already curled into a ball (see
-- PinballInterior:onEnter). Deliberately ONE-WAY: its "destination" is a
-- plain table, not another Beam — Player:updateTeleport only reads
-- destination.pos/angle, and destination.onArrive is what curls him
-- into a ball and hands control to PinballInterior the instant he lands.
-- Getting back OUT happens by draining off the bottom of the table
-- (PinballInterior:exitBall), not a return beam.
--
-- Needs state.beams to exist already (the home<->belt pair comes first:
-- RobotButler reads state.beams[1] as the home beam).
function PinballPlanet.addEntryBeam(pinball)
  local PINBALL_BEAM_OFFSET_X = -pinball.halfWidth * 0.4 -- off-center so it doesn't sit exactly at the rounded top's own midpoint
  local pinballBeamX = pinball.pos.x + PINBALL_BEAM_OFFSET_X
  local pinballBeamY = pinball.pos.y - pinball.halfHeight
  local pinballBeam = Beam.new(pinballBeamX, pinballBeamY, -math.pi / 2, { 0.95, 0.45, 0.15 }) -- orange, distinct from the home<->belt pair's own violet
  pinballBeam.destination = {
    pos = pinball.interior:getPortalPosition(),
    angle = -math.pi / 2,
    onArrive = function(player)
      pinball.interior:onEnter(player)
    end,
  }
  table.insert(state.beams, pinballBeam)
  -- Draining puts him back on the planet's top, beside this beam.
  pinball.interior.exitPosition = { x = pinballBeamX + pinball.halfWidth * 0.15 }
end

return PinballPlanet
