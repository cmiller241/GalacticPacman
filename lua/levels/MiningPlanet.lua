-- lua/levels/MiningPlanet.lua
--
-- A ball of cyan glass (see lua/world/CrystalPlanet.lua) that turns,
-- drifts and can be ground-pounded along, with the mining prisms (see
-- lua/world/Prism.lua) growing out of it in clusters. Twice the radius
-- of the biggest planetoid the field generates (70 — see WorldGen.lua's
-- createPlanetoidsInCell). It STARTS directly below the belt-edge
-- landing planet, clear of the belt's outer edge — so BeltLanding.build
-- must run first.

local state = require("lua.state")
local CrystalPlanet = require("lua.world.CrystalPlanet")
local Prism = require("lua.world.Prism")

local MiningPlanet = {}

local MINING_PLANET_RADIUS = 140
local MINING_PLANET_PRISM_CLUSTERS = 5
local MINING_PLANET_BELOW_LANDING_PLANET = 900 -- center to center

function MiningPlanet.build()
  local anchor = state.beltLandingPlanet
  local miningPlanet = CrystalPlanet.new(
    anchor.pos.x, anchor.pos.y + MINING_PLANET_BELOW_LANDING_PLANET,
    MINING_PLANET_RADIUS)
  table.insert(state.planetoids, miningPlanet)
  state.miningPlanet = miningPlanet
  state.prisms = Prism.scatterClusters(miningPlanet, MINING_PLANET_PRISM_CLUSTERS)
end

return MiningPlanet
