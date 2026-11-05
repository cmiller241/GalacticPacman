-- lua/levels/World.lua
--
-- Builds every hand-placed part of the world — the landmarks, the dome's
-- Tiled interior, the player — called once per love.load (so again on
-- every EXIT TO TITLE). The random asteroid-belt field around them is
-- lua/setup/WorldGen.lua's job, streamed in afterwards.
--
-- Each landmark lives in its own module next to this one. They're built
-- in a fixed order, and the order matters:
--   * later landmarks are placed relative to earlier ones (the
--     fisherman's planet sits above the second water planet, the mining
--     planet below the belt landing planet, ...);
--   * state.planetoids' order is the order planets are drawn and
--     collided in;
--   * RobotButler reads state.beams[1] as the home beam;
--   * several builders draw random numbers, so moving one changes the
--     world every later one makes.
-- So add new landmarks at the end unless they must come earlier.

local state = require("lua.state")
local constants = require("lua.constants")
local worldGen = require("lua.setup.WorldGen")
local Player = require("lua.entities.Player")
local MissileOutpost = require("lua.world.MissileOutpost")

local SkyDome = require("lua.levels.SkyDome")
local PinballPlanet = require("lua.levels.PinballPlanet")
local WaterPlanets = require("lua.levels.WaterPlanets")
local FishermanPlanet = require("lua.levels.FishermanPlanet")
local CrackedPlanets = require("lua.levels.CrackedPlanets")
local BeltLanding = require("lua.levels.BeltLanding")
local MiningPlanet = require("lua.levels.MiningPlanet")
local DomeInterior = require("lua.levels.DomeInterior")
local Expressway = require("lua.levels.Expressway")
local MazePlanet = require("lua.levels.MazePlanet")

local World = {}

-- Switch optional landmarks off here (e.g. to test without them).
World.SHOW = {
  pinballPlanet = true,   -- the pinball planet and its entry beam
  crackedPlanet = true,
  tiledPlanet = true,     -- needs crackedPlanet (it's placed below it)
  expressway = false,     -- the expressway and its entries/exits
  missileOutposts = true,
  mazePlanet = true,      -- the maze planet and its entry beam
}

World.HOME_CELL_COL = SkyDome.HOME_CELL_COL
World.HOME_CELL_ROW = SkyDome.HOME_CELL_ROW

-- The player starts behind the shelter's closed door: the opening beat
-- (see SpaceShelter.lua's intro state machine) slides it open around
-- him, then closes it once he's stepped out. state.introLocked (checked
-- in love.update) keeps movement input from interrupting that.
local function spawnPlayer(dome)
  local topY = dome:trueSurfaceY()
  local doorwayX = state.spaceShelter and (state.spaceShelter:getDoorwayPosition()) or dome.pos.x
  state.player = Player.new(doorwayX, topY - constants.PLAYER_RADIUS)
  state.player.onSurface = true
  state.player.currentPlanet = dome
  state.player.lastInfluencePlanet = dome
  state.player.angle = -math.pi / 2
  state.introLocked = true

  -- Where Player:respawn puts him back after dying — this same doorway.
  state.respawnPoint = { x = doorwayX, y = topY - constants.PLAYER_RADIUS, planet = dome }
end

-- Missile outposts just past the asteroid belt's outer edge (see
-- lua/world/MissileOutpost.lua): three small planets, each with a
-- missile cannon and an Ooomba that mans it once he comes near. Random
-- spawns are kept off them.
local function buildMissileOutposts()
  local sunX, sunY = worldGen.sunPos()
  local beltInner, beltOuter = worldGen.beltRadii()
  state.outposts = MissileOutpost.createAll(sunX, sunY, beltInner, beltOuter)
  state.clearLanes = state.clearLanes or {}
  for _, o in ipairs(state.outposts) do
    local p = o.planet
    table.insert(state.clearLanes, { p.pos.x, p.pos.y, p.pos.x, p.pos.y, p.radius + 700 })
  end
end

-- Returns { dome = <the sky dome>, expresswayEntry = { planet, cannon }
-- or nil }.
function World.build()
  local SHOW = World.SHOW

  local dome = SkyDome.build()
  if SHOW.pinballPlanet then PinballPlanet.build(dome) end
  WaterPlanets.build()
  FishermanPlanet.build()
  if SHOW.crackedPlanet then CrackedPlanets.buildCracked(dome) end
  if SHOW.tiledPlanet then CrackedPlanets.buildTiled() end
  SkyDome.addRobotButler(dome)
  FishermanPlanet.addFisherman()
  BeltLanding.build(dome)
  MiningPlanet.build()
  if state.pinballPlanet then PinballPlanet.addEntryBeam(state.pinballPlanet) end
  DomeInterior.build(dome)
  BeltLanding.addSign()
  CrackedPlanets.addTiledPlanetOoombas()
  spawnPlayer(dome)

  local expresswayEntry = SHOW.expressway and Expressway.build() or nil
  if SHOW.missileOutposts then buildMissileOutposts() end
  if SHOW.mazePlanet then MazePlanet.addEntryBeam(MazePlanet.build()) end

  return { dome = dome, expresswayEntry = expresswayEntry }
end

return World
