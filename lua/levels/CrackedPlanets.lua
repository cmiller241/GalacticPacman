-- lua/levels/CrackedPlanets.lua
--
-- The two planets built from lua/world/CrackedPlanetoid.lua:
--   * the cracked planet: rings of dirt clods round a cracked core, which
--     fireballs blow out (caves and all). Out past the right end of the
--     sky dome, a little above its deck.
--   * the Tiled planet: the Tiled map tiled/Level2.lua wrapped round a
--     planet (see CrackedPlanetoid.fromTiledMap), with a tunnel through
--     it. Its size comes from the map. Straight below the cracked planet
--     (further right, it would sit on the galactic expressway's track).

local state = require("lua.state")
local CrackedPlanetoid = require("lua.world.CrackedPlanetoid")
local Ooomba = require("lua.entities.Ooomba")

local CrackedPlanets = {}

local CRACKED_PLANET_CORE_RADIUS = 320
local CRACKED_PLANET_BRICK_LAYERS = 14 -- 32 units each, so 768 to the outside
local CRACKED_PLANET_GAP = 1800 -- from the dome's right edge to the planet's center
local CRACKED_PLANET_ABOVE_DECK = 400
local TILED_PLANET_GAP = 1200 -- between the two planets' outsides

function CrackedPlanets.buildCracked(dome)
  local cracked = CrackedPlanetoid.new(
    dome.pos.x + dome.halfWidth + CRACKED_PLANET_GAP, dome.pos.y - CRACKED_PLANET_ABOVE_DECK,
    CRACKED_PLANET_CORE_RADIUS, CRACKED_PLANET_BRICK_LAYERS, { 0.52, 0.36, 0.24, 1 })
  table.insert(state.planetoids, cracked)
  state.crackedPlanet = cracked
end

-- Needs the cracked planet (it's placed below it).
function CrackedPlanets.buildTiled()
  local cracked = state.crackedPlanet
  if not cracked then return end
  local map = require("tiled.Level2")
  local radius = CrackedPlanetoid.tiledMapRadius(map)
  local tiledPlanet = CrackedPlanetoid.fromTiledMap(
    cracked.pos.x, cracked.pos.y + cracked.radius + TILED_PLANET_GAP + radius,
    map, { 0.45, 0.32, 0.2, 1 })
  table.insert(state.planetoids, tiledPlanet)
  state.tiledPlanet = tiledPlanet
end

-- Ooombas placed on the Tiled planet's own map (tiled/Level2's object
-- layer — see CrackedPlanetoid.fromTiledMap's objectSpawns): each set
-- down on the ground under where it was placed, patrolling it round the
-- planet (see Ooomba.newOnCrackedPlanet). Must run after
-- DomeInterior.build, which starts state.ooombas afresh.
function CrackedPlanets.addTiledPlanetOoombas()
  if not state.tiledPlanet then return end
  state.ooombas = state.ooombas or {}
  for _, spawn in ipairs(state.tiledPlanet.objectSpawns or {}) do
    if spawn.class == "Ooomba" then
      local direction = (math.random() < 0.5) and -1 or 1
      local o = Ooomba.newOnCrackedPlanet(state.tiledPlanet, spawn.lx, spawn.ly, { direction = direction })
      if o then table.insert(state.ooombas, o) end
    end
  end
end

return CrackedPlanets
