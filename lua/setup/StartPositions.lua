-- lua/setup/StartPositions.lua
--
-- Named places Bob can start at (main.lua's START_AT switch) and the
-- debug teleport list (T) that jumps him to any of them.
--
-- main.lua calls StartPositions.init once the world is built, then
-- StartPositions.apply(START_AT). PauseMenu calls openTeleportList on T.

local state = require("lua.state")
local constants = require("lua.constants")
local Camera = require("lua.systems.Camera")
local PauseMenu = require("lua.ui.PauseMenu")
local worldGen = require("lua.setup.WorldGen")

local StartPositions = {}

-- Set by init: the shelter's own respawn point (before START_AT changes
-- it), the expressway's { planet, cannon } entry (nil when it isn't
-- built), and the Tiled planet map column the "tiled" start sits over.
local shelterRespawnPoint, expresswayEntry
local tiledStartColumn = 0
local lastTeleport = 1 -- the teleport list opens on whichever was picked last

-- Each returns a respawn point (see Player:respawn), or false when that
-- planet is switched off.
local PLACES = {
  mining = function()
    local planet = state.miningPlanet
    if not planet then return false end
    -- The planet drifts: followsPlanet keeps the point on top of it
    -- every frame (see love.update).
    return {
      x = planet.pos.x, y = planet.pos.y - planet.radius - constants.PLAYER_RADIUS,
      planet = planet, followsPlanet = true,
    }
  end,

  fisherman = function()
    local rect = state.roundedRectPlanet
    if not rect then return false end
    -- No planet named: he lands through the ordinary collision pass.
    return {
      x = rect.pos.x - rect.halfWidth * 0.4,
      y = rect.pos.y - rect.halfHeight - constants.PLAYER_RADIUS - 20,
    }
  end,

  cracked = function()
    local planet = state.crackedPlanet
    if not planet then return false end
    return {
      x = planet.pos.x,
      y = planet.pos.y - planet.radius - constants.PLAYER_RADIUS - 20,
    }
  end,

  tiled = function()
    local planet = state.tiledPlanet
    if not planet then return false end
    local columns = planet.rings[1].count
    local angle = -math.pi / 2 + (tiledStartColumn + 0.5) / columns * 2 * math.pi
    local dist = planet.radius + constants.PLAYER_RADIUS + 20
    return {
      x = planet.pos.x + math.cos(angle) * dist,
      y = planet.pos.y + math.sin(angle) * dist,
    }
  end,

  tunnel = function()
    -- On the sky dome's ground, a few steps left of the ball tunnel's
    -- mouth in Level1 (map column 33, row 35), dropping onto the floor
    -- (row 36).
    local level = state.tiledLevels and state.tiledLevels[1]
    if not level then return false end
    local T = 64
    return {
      x = level.anchorX + 27.5 * T,
      y = level.anchorY + 36 * T - constants.PLAYER_RADIUS - 20,
    }
  end,

  pinball = function()
    if not state.pinballPlanet then return false end
    local portal = state.pinballPlanet.interior:getPortalPosition()
    return { x = portal.x, y = portal.y, interior = state.pinballPlanet.interior }
  end,

  maze = function()
    if not state.mazePlanet then return false end
    local start = state.mazePlanet.interior:getPortalPosition()
    return { x = start.x, y = start.y, interior = state.mazePlanet.interior }
  end,

  expressway = function()
    if not expresswayEntry then return false end
    -- Standing a little round from the cannon, not in it.
    local entryPlanet, entryCannon = expresswayEntry.planet, expresswayEntry.cannon
    local standAngle = entryCannon.mountAngle - 0.45
    local standDist = entryPlanet.radius + constants.PLAYER_RADIUS
    return {
      x = entryPlanet.pos.x + math.cos(standAngle) * standDist,
      y = entryPlanet.pos.y + math.sin(standAngle) * standDist,
      planet = entryPlanet,
    }
  end,
}

-- The teleport list (T), in order.
local TELEPORT_PLACES = {
  { key = "shelter", label = "SPACE SHELTER" },
  { key = "mining", label = "MINING PLANET" },
  { key = "fisherman", label = "FISHERMAN'S PLANET" },
  { key = "cracked", label = "CRACKED PLANET" },
  { key = "tiled", label = "TILED PLANET" },
  { key = "tunnel", label = "SKY DOME BALL TUNNEL" },
  { key = "pinball", label = "PINBALL TABLE" },
  { key = "expressway", label = "EXPRESSWAY" },
  { key = "maze", label = "MAZE PLANET" },
}

-- Called by love.load once every planet exists.
--   opts.shelterRespawnPoint  state.respawnPoint as World.build left it
--   opts.expresswayEntry      { planet, cannon }, or nil
--   opts.tiledStartColumn     map column for the "tiled" start (from 0, like Tiled)
function StartPositions.init(opts)
  shelterRespawnPoint = opts.shelterRespawnPoint
  expresswayEntry = opts.expresswayEntry
  tiledStartColumn = opts.tiledStartColumn or 0
end

-- Where `key` would put him right now, or nil if that planet is switched off.
local function pointFor(key)
  if key == "shelter" then return shelterRespawnPoint end
  return PLACES[key]() or nil
end

-- Makes `startAt` (a PLACES key, or "shelter") his start and respawn
-- point. If that planet is switched off, he starts at the shelter and the
-- console says why.
function StartPositions.apply(startAt)
  if startAt == "shelter" then return end
  local place = PLACES[startAt]
  local point = place and place()
  if not point then
    print(string.format('main.lua: START_AT = "%s" %s - starting at the shelter instead.', startAt,
      place and "but that planet is switched off" or "isn't a known start position"))
    return
  end
  state.respawnPoint = point
  -- He isn't waiting behind the shelter door, so skip its intro.
  state.spaceShelter.playerInFront = true
  state.spaceShelter.introDone = true
end

-- Puts him at `key` straight away. It also becomes his respawn point, so
-- dying brings him back to it.
local function teleportTo(key)
  local player, point = state.player, pointFor(key)
  if not (player and point) then return end
  state.respawnPoint = point
  -- (Out of the shelter's intro, if it was still playing.)
  if state.spaceShelter then
    state.spaceShelter.playerInFront = true
    state.spaceShelter.introDone = true
  end
  -- Nothing from where he was comes with him.
  player:clearPullTarget()
  player:clearLockTarget()
  state.vatsActive = false
  player.deathZoneRespawn = nil -- (Player:respawn would go there instead)
  player:respawn()
  -- The camera jumps with him, and the world round him is streamed in
  -- now rather than up to half a second later.
  state.portalCameraGlide = nil
  state.cannonZoomFlying, state.cannonZoomReturn = nil, nil
  Camera.pointAtPlayer()
  worldGen.updateActiveCells()
  state.cellCheckTimer = 0
end

-- T: pauses the game with the list of places (see PauseMenu.openList).
function StartPositions.openTeleportList()
  local options = {}
  for i, place in ipairs(TELEPORT_PLACES) do
    options[i] = { label = place.label, enabled = pointFor(place.key) ~= nil }
  end
  PauseMenu.openList("TELEPORT", options, function(index)
    lastTeleport = index
    teleportTo(TELEPORT_PLACES[index].key)
  end, lastTeleport)
end

return StartPositions
