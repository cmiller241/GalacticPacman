-- lua/levels/BeltLanding.lua
--
-- The beam pair between the home dome and a small landing planet at the
-- belt's outer edge (see lua/world/Beam.lua — a point-to-point
-- teleporter), plus the sign on that landing planet.
--
-- homeBeam sits just left of the shelter, on the dome's own deck.
-- beltBeam sits on TOP of a small landing planet placed along the SAME
-- radial line from the sun the dome sits on, pulled in to just past the
-- belt's outer radius, then nudged further down the screen
-- (BELT_PLANET_EXTRA_DOWN) so it reads as its own separate landmark.
-- Both beams point straight up, away from the surface they stand on.

local state = require("lua.state")
local constants = require("lua.constants")
local Vector2 = require("lua.vector2")
local worldGen = require("lua.setup.WorldGen")
local Sphere = require("lua.world.Sphere")
local Beam = require("lua.world.Beam")
local Sign = require("lua.world.Sign")

local BeltLanding = {}

-- Creates state.beams as { homeBeam, beltBeam } — RobotButler reads
-- state.beams[1] as the home beam, so keep that one first.
function BeltLanding.build(dome)
  local domeX, domeY = dome.pos.x, dome.pos.y
  local BEAM_GAP_FROM_SHELTER = 150
  local homeBeam = Beam.new(
    state.spaceShelter.pos.x - state.spaceShelter.drawWidth / 2 - BEAM_GAP_FROM_SHELTER,
    dome:trueSurfaceY(), -math.pi / 2)

  local sunX, sunY = worldGen.sunPos()
  local _, beltOuterRadius = worldGen.beltRadii()
  local dirX, dirY = domeX - sunX, domeY - sunY
  local dirLen = math.sqrt(dirX * dirX + dirY * dirY)
  dirX, dirY = dirX / dirLen, dirY / dirLen

  local BELT_PLANET_RADIUS = 120
  -- Clear space between the landing planet's own surface and the
  -- belt's outer edge — real but short, same spirit as Fish.lua's own
  -- cross-pool jump margins (a gap the player is clearly MEANT to
  -- clear, not one that's borderline).
  local BELT_PLANET_GAP = 260
  local beltPlanetDist = beltOuterRadius + BELT_PLANET_RADIUS + BELT_PLANET_GAP
  local beltPlanetX = sunX + dirX * beltPlanetDist
  -- A plain screen-space downward nudge from there (NOT further along
  -- dirX/dirY — the dome sits slightly ABOVE the sun, so dirY itself
  -- is negative, and pushing further along it would actually move the
  -- planet UP, the opposite of what's wanted here).
  local BELT_PLANET_EXTRA_DOWN = 500
  local beltPlanetY = sunY + dirY * beltPlanetDist + BELT_PLANET_EXTRA_DOWN

  local beltLandingPlanet = Sphere.new(beltPlanetX, beltPlanetY, BELT_PLANET_RADIUS)
  -- A Sphere's own default gravity reach is a quarter of an ordinary
  -- planetoid's (see Sphere.new) — at this size that's SMALLER than the
  -- ball itself, so a jump off it left its pull straight away. Given an
  -- ordinary planetoid's reach instead (radius + INFLUENCE_PADDING, same
  -- as Planetoid.new): he can jump around on it, and its edge still
  -- stops short of the belt (BELT_PLANET_GAP beyond its surface).
  beltLandingPlanet.influenceRadius = BELT_PLANET_RADIUS + constants.INFLUENCE_PADDING
  table.insert(state.planetoids, beltLandingPlanet)
  state.beltLandingPlanet = beltLandingPlanet -- its own sign is planted further down, once state.signs exists

  local beltBeam = Beam.new(beltPlanetX, beltPlanetY - BELT_PLANET_RADIUS, -math.pi / 2)

  homeBeam.destination = beltBeam
  beltBeam.destination = homeBeam
  state.beams = { homeBeam, beltBeam }
end

-- A sign on the landing planet, planted on the far side from its beam:
-- the beam stands on top, so the sign hangs off the underside, turned to
-- stand on the surface there — not at the very bottom (the south pole)
-- but SIGN_OFFSET_FROM_SOUTH_POLE round from it, toward the lower left
-- (the side facing the belt). Negative would put it toward the lower
-- right instead. Must run after DomeInterior.build, which creates
-- state.signs.
function BeltLanding.addSign()
  local planet = state.beltLandingPlanet
  if not planet then return end
  local SIGN_OFFSET_FROM_SOUTH_POLE = math.rad(35)
  local signAngle = math.pi / 2 + SIGN_OFFSET_FROM_SOUTH_POLE -- pi/2 is straight down the screen
  local up = Vector2.new(math.cos(signAngle), math.sin(signAngle)) -- away from the planet's center, where the sign stands
  state.signs = state.signs or {}
  table.insert(state.signs, Sign.new(
    planet.pos.x + up.x * planet.radius, planet.pos.y + up.y * planet.radius,
    "With so many planets clustered together, consider pressing **TRIANGLE** to slow down time. In this state, you can move the right joystick cursor around to select planets you can pull beam toward using the **L2** button. If you want time to go back to normal, press **TRIANGLE** again",
    { texture = state.signPlanetTexture, up = up }))
end

return BeltLanding
