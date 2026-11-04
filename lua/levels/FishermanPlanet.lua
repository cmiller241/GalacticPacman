-- lua/levels/FishermanPlanet.lua
--
-- The rounded-rectangle landmark (see lua/world/RoundedRectPlanetoid.lua)
-- the fisherman stands on — unlike every circular planetoid, the player
-- can land and walk all the way around it. Placed directly above the
-- SECOND water planet (state.waterPlanet2), so it needs
-- WaterPlanets.build to have run first. Locked level and fixed in place
-- (rotation zeroed, isImmovable/isPermanent, vel zeroed).

local state = require("lua.state")
local RoundedRectPlanetoid = require("lua.world.RoundedRectPlanetoid")
local Fisherman = require("lua.entities.Fisherman")

local FishermanPlanet = {}

function FishermanPlanet.build()
  -- Halved from this landmark's own original size (600x400, corner
  -- 60) per explicit request.
  local ROUNDED_RECT_HALF_WIDTH = 150
  local ROUNDED_RECT_HALF_HEIGHT = 100
  local ROUNDED_RECT_CORNER_RADIUS = 30
  -- How far (world units) the fisherman's own hook dangles below
  -- wherever he's standing, once planted at the rect's own top surface
  -- — worked out from his actual rig, not guessed: his own origin
  -- sits bodyHalfHeight (24.85, from Fisherman-Body.png's 497px height
  -- * BODY_SCALE 0.1 / 2) ABOVE his feet, the rod tip (POSE.lineY =
  -- -1118, same pre-scale units as every other POSE offset) sits
  -- 111.8 world units above THAT, and the hook (the line's own far
  -- end, 9920px long, jointY=26 near its top) hangs
  -- (9920-26)*BODY_SCALE = 989.4 world units below the rod tip. Net:
  -- 989.4 - 111.8 - 24.85 = 852.75 world units below his own feet.
  local FISHERMAN_HOOK_REACH = 852.75
  -- How far INTO the water the hook should actually end up, past its
  -- own surface — purely a "does it look right" number, easiest of
  -- all these to retune by eye once this is actually on screen.
  local FISHERMAN_HOOK_WATER_DIP = 80
  local groundY = state.waterPlanet2.pos.y - state.waterPlanet2.radius
    - FISHERMAN_HOOK_WATER_DIP - FISHERMAN_HOOK_REACH
  local rectY = groundY + ROUNDED_RECT_HALF_HEIGHT
  local rectX = state.waterPlanet2.pos.x
  -- Manual nudge on top of the computed placement above, per several
  -- explicit requests after seeing it on screen each time — cumulative:
  -- (-50, 80), then (-50, 50), then (-50, 80).
  local ROUNDED_RECT_NUDGE_X = -150
  local ROUNDED_RECT_NUDGE_Y = 210
  rectX = rectX + ROUNDED_RECT_NUDGE_X
  rectY = rectY + ROUNDED_RECT_NUDGE_Y
  local roundedRectPlanet = RoundedRectPlanetoid.new(
    rectX, rectY,
    ROUNDED_RECT_HALF_WIDTH, ROUNDED_RECT_HALF_HEIGHT, ROUNDED_RECT_CORNER_RADIUS,
    { 0.68, 0.56, 0.42, 1 })
  roundedRectPlanet.isImmovable = true
  roundedRectPlanet.isPermanent = true
  roundedRectPlanet.vel.x, roundedRectPlanet.vel.y = 0, 0
  roundedRectPlanet.rotationAngle = 0
  roundedRectPlanet.rotationSpeed = 0
  table.insert(state.planetoids, roundedRectPlanet)
  state.roundedRectPlanet = roundedRectPlanet
end

-- The fisherman NPC, at the RIGHT edge of the rounded rectangle, so his
-- line and hook dangle down into the water below. FISHERMAN_GAP_FROM_EDGE
-- is a small clip margin, so his art doesn't hang off the flat edge.
function FishermanPlanet.addFisherman()
  local FISHERMAN_GAP_FROM_EDGE = 50
  local rect = state.roundedRectPlanet
  local fishermanHomeX = rect.pos.x + rect.halfWidth - FISHERMAN_GAP_FROM_EDGE
  local fishermanGroundY = rect.pos.y - rect.halfHeight
  state.fisherman = Fisherman.new(fishermanHomeX, fishermanGroundY)
end

return FishermanPlanet
