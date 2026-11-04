-- lua/levels/WaterPlanets.lua
--
-- The water planets (see lua/world/WaterPlanet.lua) and their fish (see
-- lua/entities/Fish.lua): one big one placed one cell diagonally past
-- the belt's outer edge, toward the bottom-right of the sun, so it sits
-- just outside belt territory; a second, smaller one beside it; and
-- three small ones below that. Half the sun's own radius (1920), per
-- "not as big as the sun."

local state = require("lua.state")
local worldGen = require("lua.setup.WorldGen")
local WaterPlanet = require("lua.world.WaterPlanet")
local Fish = require("lua.entities.Fish")

local WaterPlanets = {}

function WaterPlanets.build()
  local sunCol, sunRow = worldGen.sunCell()
  local cellSize = worldGen.CELL_SIZE
  local waterCol, waterRow = sunCol + 3, sunRow + 3
  local waterX = (waterCol + 0.5) * cellSize
  local waterY = (waterRow + 0.5) * cellSize
  local waterPlanet, waterCore = WaterPlanet.new(waterX, waterY, 960)
  table.insert(state.planetoids, waterPlanet)
  table.insert(state.planetoids, waterCore)
  state.waterPlanet = waterPlanet
  state.waterCore = waterCore

  state.fish = {}
  local FISH_COUNT = 6
  for _ = 1, FISH_COUNT do
    table.insert(state.fish, Fish.new(waterPlanet, waterCore))
  end

  -- A second, smaller water body — right and a little further down
  -- from the first, with a ~336-unit gap between the two shores. Too
  -- far for an ordinary in-place jump's reach (see Fish.lua's
  -- JUMP_MAX_APEX_FRAC), which is deliberate: crossing this gap needs
  -- Fish.lua's own dedicated cross-pool jump (JUMP_CROSS_* tunables,
  -- decideToJump/startJump) — a fish specifically aiming for another
  -- pool it can reach, launching much harder than an ordinary hop.
  --
  -- At THIS distance, reaching the far shore actually requires
  -- Fish.lua's gravity hand-off (findDominantWaterInfluence): each
  -- WaterPlanet's own influence ring (radius + constants.
  -- INFLUENCE_PADDING) only reaches 1160 units from A's center and
  -- 872 from B's own (smaller) center, and neither ring alone reaches
  -- the far shore — but the two rings still overlap by about 64
  -- units, just barely, so a strong enough launch from A can coast
  -- into B's own ring before A's would have capped it, at which point
  -- B's own gravity takes over and pulls it the rest of the way in.
  -- Pushing the two pools any further apart than this will make the
  -- rings stop overlapping entirely — at that point crossing becomes
  -- flatly impossible without breaking the "never leave a pool's own
  -- influence ring" rule this whole feature is built on, not just a
  -- matter of retuning launch speed.
  local water2X = waterX + 1820
  local water2Y = waterY + 750
  local waterPlanet2, waterCore2 = WaterPlanet.new(water2X, water2Y, 960 * 0.7)
  table.insert(state.planetoids, waterPlanet2)
  table.insert(state.planetoids, waterCore2)
  state.waterPlanet2 = waterPlanet2
  state.waterCore2 = waterCore2

  local FISH_COUNT_2 = 4
  for _ = 1, FISH_COUNT_2 do
    table.insert(state.fish, Fish.new(waterPlanet2, waterCore2))
  end

  -- Three more, small water bodies below the second one (each offset
  -- sideways by a different amount, so none of them sit directly
  -- below it) — half its own radius (336). Placed with a comfortable
  -- ~150-250 unit reach margin each way to/from water2 specifically
  -- (not to each other, though none happen to overlap either), rather
  -- than pushed to the tight limit the water1<->water2 gap already
  -- is — see Fish.lua's own JUMP_CROSS_* tunables and
  -- findDominantWaterInfluence for what that margin actually has to
  -- absorb (randomized launch speed, tangential drift).
  local SMALL_WATER_RADIUS = (960 * 0.7) * 0.5
  local smallWaterOffsets = {
    { -650, 1050 },
    { 100, 1200 },
    { 900, 900 },
  }
  for _, off in ipairs(smallWaterOffsets) do
    local wp, wc = WaterPlanet.new(water2X + off[1], water2Y + off[2], SMALL_WATER_RADIUS)
    table.insert(state.planetoids, wp)
    table.insert(state.planetoids, wc)
    for _ = 1, 3 do
      table.insert(state.fish, Fish.new(wp, wc))
    end
  end
end

return WaterPlanets
