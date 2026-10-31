-- lua/levels/DomeInterior.lua
--
-- The sky dome's interior: the Tiled map tiled/Level1.lua loaded as
-- walkable terrain on the dome's deck, plus everything placed in its
-- object layer (Ooombas, Spheres, Spikeys, Mirrors, Levers, Cranks,
-- Plungers, Signs, Zoom-Windows, DeathZones, Gates, rope rocks).
-- Called once per world build from lua/levels/World.lua.

local state = require("lua.state")
local constants = require("lua.constants")
local TiledTerrain = require("lua.world.TiledTerrain")
local WaterSystem = require("lua.systems.WaterSystem")
local RopeRock = require("lua.world.RopeRock")
local Ooomba = require("lua.entities.Ooomba")
local Sphere = require("lua.world.Sphere")
local SphereMove = require("lua.world.SphereMove")
local Spikey = require("lua.world.Spikey")
local SpikeyVertical = require("lua.world.SpikeyVertical")
local SpikeyOrbit = require("lua.world.SpikeyOrbit")
local Mirror = require("lua.world.Mirror")
local Lever = require("lua.world.Lever")
local Crank = require("lua.world.Crank")
local Plunger = require("lua.world.Plunger")
local Sign = require("lua.world.Sign")
local Gate = require("lua.world.Gate")

local DomeInterior = {}

-- How far below a loosely placed spawn point to look for ground.
local GROUND_SEARCH_DOWN = 6000

-- Objects placed loosely in Tiled (anywhere above the surface they're
-- meant to stand on) are snapped straight down onto the nearest terrain
-- shape below them, using the same swept findLandingCrossing test
-- CollisionSystem uses for landing on open-path terrain. Ramp-climb
-- shapes (isWallClimb) are skipped. Returns the shape and the hit, or
-- nil when there's no ground below.
local function findGroundBelow(shapes, x, y)
  local bestShape, bestHit, bestDy = nil, nil, nil
  for _, shape in ipairs(shapes) do
    if not shape.isWallClimb then
      local hit = shape:findLandingCrossing(x, y, x, y + GROUND_SEARCH_DOWN)
      if hit then
        local dy = hit.point.y - y
        if dy >= 0 and (not bestDy or dy < bestDy) then
          bestShape, bestHit, bestDy = shape, hit, dy
        end
      end
    end
  end
  return bestShape, bestHit
end

function DomeInterior.build(dome)
  local levelData = require("tiled.Level1")
  local mapWorldWidth = levelData.width * 64
  local mapWorldHeight = levelData.height * 64
  local anchorX = dome.pos.x - mapWorldWidth / 2
  local anchorY = dome:trueSurfaceY() - mapWorldHeight
  local terrainLevel = TiledTerrain.load(levelData, anchorX, anchorY)

  for _, shape in ipairs(terrainLevel.shapes) do
    -- Every tile inside the dome should feel like standing on the
    -- dome's own deck, jump-wise — Player:jump()'s launch speed reads
    -- self.currentPlanet.jumpStrength directly, and self.currentPlanet
    -- while standing on ordinary Tiled ground is the specific
    -- TerrainShape tile itself, not the dome — so without this it
    -- silently fell back to constants.JUMP_STRENGTH's plain global
    -- value instead of the dome's own stronger, Mario-style one (see
    -- SkyDomePlanetoid.lua's own jumpStrength comment), making jumps
    -- noticeably weaker on ordinary tiles than on the bare deck.
    -- gravityStrength doesn't need the same treatment: TerrainShape's
    -- own isOpenPath flag excludes it from ever being picked as the
    -- FALLING gravity source (see GravitySystem:findDominantPlanet) —
    -- that's always the dome itself, tile or no tile underfoot.
    shape.jumpStrength = dome.jumpStrength
    -- Part of the Sky Dome level (the dome's music keeps playing on it
    -- — see musicForPlayer).
    shape.inSkyDome = true
    table.insert(state.planetoids, shape)
  end
  state.tiledLevels = { terrainLevel }
  -- The grid sprayed water flows and pools on (see WaterSystem.lua).
  WaterSystem.init(terrainLevel)

  -- Rocks hung on ropes: each Rope paired with the Rock its "holds"
  -- property names (see lua/world/RopeRock.lua). After the water grid
  -- (they move — a rock that's fallen mustn't leave its old place solid
  -- to water); recallable (see lua/systems/Recall.lua).
  state.ropeRocks = {}
  state.recallables = state.ropeRocks
  local rocksById = {}
  for _, rock in ipairs(terrainLevel.rockSpawns or {}) do rocksById[rock.id] = rock end
  for _, rope in ipairs(terrainLevel.ropeSpawns or {}) do
    local rock = rope.holdsId and rocksById[rope.holdsId]
    if rock then
      table.insert(state.ropeRocks, RopeRock.new(rope, rock, terrainLevel, dome))
    else
      print(string.format("DomeInterior: Rope id %s holds nothing (its \"holds\" property names no Rock) — not spawned.",
        tostring(rope.id)))
    end
  end

  -- Ooombas are placed explicitly via Tiled's own Object Layer now
  -- (see TiledTerrain.lua's ooombaSpawns) instead of auto-spawned onto
  -- every long-enough walkable shape — that heuristic had no idea a
  -- shape might be the sunken floor of a lava pit or some other spot
  -- that looks walkable but isn't a good fit for a patrol. Each spawn
  -- point is snapped down onto the ground below it (findGroundBelow;
  -- ramp-climb shapes are skipped — an edge-patrolling Ooomba can't
  -- hold onto a surface that needs momentum to stay attached).
  state.ooombas = {}
  for _, spawn in ipairs(terrainLevel.ooombaSpawns or {}) do
    local bestShape = findGroundBelow(terrainLevel.shapes, spawn.x, spawn.y)
    if bestShape then
      local arcPos = bestShape:arcPositionForWorldPoint(spawn.x, spawn.y)
      local direction = (math.random() < 0.5) and -1 or 1
      table.insert(state.ooombas, Ooomba.new(bestShape, arcPos, { direction = direction }))
    end
  end

  -- "Sphere" objects (see lua/world/Sphere.lua): small fixed metal
  -- balls the player can jump on and pull-beam to, exactly like any
  -- other planetoid. Unlike Ooombas above, the spawn point IS the
  -- sphere's own center — no raycast-onto-terrain needed for a
  -- freestanding body.
  --
  -- entitiesById collects every spawned Sphere/Spikey by its own
  -- Tiled object id as it goes, so a Spikey-Orbit object further down
  -- this same loop set (spawned after all of these, see
  -- spikeyOrbitSpawns below) can resolve its own "orbit" property —
  -- just the raw id at this point, read by TiledTerrain.lua — back to
  -- the actual entity it names, whichever of these two lists it came
  -- from.
  local entitiesById = {}
  for _, spawn in ipairs(terrainLevel.sphereSpawns or {}) do
    -- spawn.radius: the object's optional "radius" property in Tiled;
    -- nil falls back to Sphere.DEFAULT_RADIUS.
    local sphere = Sphere.new(spawn.x, spawn.y, spawn.radius)
    table.insert(state.planetoids, sphere)
    if spawn.id then entitiesById[spawn.id] = sphere end

    -- spawn.gravityRadius: the object's optional "gravity" property —
    -- how far out from the Sphere's center its gravity reaches. A
    -- Sphere's own default reach is deliberately tiny (see Sphere.new),
    -- so small that a jump off anywhere but the very top leaves its
    -- pull and never comes back; setting this is how a Sphere becomes
    -- somewhere he can jump around on. It has to reach past the
    -- surface to do anything at all, so a value that doesn't is
    -- reported rather than silently applied.
    if spawn.gravityRadius then
      if spawn.gravityRadius > sphere.radius then
        sphere.influenceRadius = spawn.gravityRadius
      else
        print(string.format(
          "DomeInterior: Sphere at (%.0f, %.0f) has gravity=%s, which is not beyond its own radius of %s — ignored.",
          spawn.x, spawn.y, tostring(spawn.gravityRadius), tostring(sphere.radius)))
      end
    end

    -- spawn.ooombaCount: the object's optional "ooomba" property —
    -- that many Ooombas walking laps of this Sphere (see
    -- Ooomba.newOnPlanet). Spaced evenly round it and all walking the
    -- same way at the same speed, so they keep their spacing and
    -- never bunch up or pass through one another; which way is
    -- picked per Sphere, and the starting point is random so two
    -- Spheres with Ooombas don't look like copies of each other.
    -- Ordinary Ooombas in every other respect: lethal to touch, can
    -- be stomped or shot.
    if (spawn.ooombaCount or 0) > 0 then
      local direction = math.random() < 0.5 and -1 or 1
      local firstAngle = math.random() * math.pi * 2
      for i = 1, spawn.ooombaCount do
        local angle = firstAngle + (i - 1) / spawn.ooombaCount * math.pi * 2
        table.insert(state.ooombas, Ooomba.newOnPlanet(sphere, angle, { direction = direction }))
      end
    end
  end

  -- "Sphere-Move" objects (see lua/world/SphereMove.lua): same Sphere,
  -- just shuttling back and forth between two points instead of
  -- sitting still. Added straight into state.planetoids too — it's a
  -- full Planetoid in every other respect (gravity, landing,
  -- pull-beam targeting), so it needs no separate list or wiring
  -- anywhere else, just like plain Sphere above.
  for _, spawn in ipairs(terrainLevel.sphereMoveSpawns or {}) do
    table.insert(state.planetoids, SphereMove.new(
      spawn.x, spawn.y, spawn.startX, spawn.startY, spawn.endX, spawn.endY, nil, spawn.speed))
  end

  -- "Spikey" objects (see lua/world/Spikey.lua): gray, spike-ringed
  -- hazards that kill the player on contact
  -- (CollisionSystem:handlePlayerSpikeyCollisions) — deliberately NOT
  -- planetoids (no gravity, no landing/orbital walking around them),
  -- so they get their own separate list rather than state.planetoids.
  -- Stationary, same point-placement convention as the Sphere spawns
  -- just above.
  state.spikeys = {}
  for _, spawn in ipairs(terrainLevel.spikeySpawns or {}) do
    local spikey = Spikey.new(spawn.x, spawn.y)
    table.insert(state.spikeys, spikey)
    if spawn.id then entitiesById[spawn.id] = spikey end
  end

  -- "Spikey-Vertical" objects (see lua/world/SpikeyVertical.lua):
  -- same hazard, but patrols up and down within a shaft.
  -- TiledTerrain.lua's own tile-grid scan already resolved topY/
  -- bottomY against the nearest WALL in each direction, where one
  -- exists — this pass additionally clamps (or, if that scan found
  -- no wall at all on a given side, ENTIRELY SUPPLIES) those bounds
  -- against any Spikey (from the loop just above) sitting in the
  -- same column, so "collides with a wall OR another Spikey" holds
  -- as two genuinely equal alternatives, not "a wall, with Spikeys
  -- only ever narrowing that further." A shaft with a wall ceiling
  -- but no floor tile at all — bounded only by a stack of ordinary
  -- Spikeys below it — is exactly the case this fixes: TiledTerrain's
  -- own scan leaves bottomY nil there, and this pass is what actually
  -- resolves it instead of leaving the whole spawn dead on arrival.
  -- Added to the same state.spikeys list as everything else here, so
  -- it's collided with/drawn exactly like a plain Spikey with zero
  -- extra wiring anywhere else.
  local SPIKEY_VERTICAL_RADIUS = Spikey.DEFAULT_RADIUS
  for _, spawn in ipairs(terrainLevel.spikeyVerticalSpawns or {}) do
    local topY, bottomY = spawn.topY, spawn.bottomY
    for _, other in ipairs(state.spikeys) do
      -- "Same column" fuzziness — both radii, not just one, since
      -- either body's own width can bring them into contact even
      -- when their CENTERS aren't perfectly aligned.
      if math.abs(other.pos.x - spawn.x) < other.radius + SPIKEY_VERTICAL_RADIUS then
        if other.pos.y < spawn.y then
          local bound = other.pos.y + other.radius + SPIKEY_VERTICAL_RADIUS
          topY = topY and math.max(topY, bound) or bound
        elseif other.pos.y > spawn.y then
          local bound = other.pos.y - other.radius - SPIKEY_VERTICAL_RADIUS
          bottomY = bottomY and math.min(bottomY, bound) or bound
        end
      end
    end
    -- Only NOW (after both a wall AND a nearby-Spikey chance) is this
    -- actually a failure — nothing at all bounds one side, which
    -- would let it patrol forever in that direction with nothing to
    -- ever turn it around.
    if topY and bottomY and bottomY > topY then
      table.insert(state.spikeys, SpikeyVertical.new(spawn.x, topY, bottomY, SPIKEY_VERTICAL_RADIUS, spawn.speed))
    else
      print(string.format(
        "DomeInterior: Spikey-Vertical at (%.1f, %.1f) found no wall or nearby Spikey to bound it on one side (topY=%s, bottomY=%s) — not spawned.",
        spawn.x, spawn.y, tostring(topY), tostring(bottomY)))
    end
  end

  -- "Spikey-Orbit" objects (see lua/world/SpikeyOrbit.lua): same
  -- hazard again, but orbits clockwise around whatever entity its own
  -- "orbit" property names (resolved here against entitiesById, built
  -- above as the Sphere/Spikey spawns happened — this is why this
  -- loop has to come after both of those, not before). The orbit's
  -- own radius/starting angle come from however far apart the two
  -- objects actually are in Tiled right now — see SpikeyOrbit.new.
  for _, spawn in ipairs(terrainLevel.spikeyOrbitSpawns or {}) do
    local center = spawn.orbitId and entitiesById[spawn.orbitId]
    if center then
      table.insert(state.spikeys, SpikeyOrbit.new(spawn.x, spawn.y, center, Spikey.DEFAULT_RADIUS, spawn.speed))
    else
      print(string.format(
        "DomeInterior: Spikey-Orbit at (%.1f, %.1f) names orbit id %s, which isn't a spawned Sphere/Spikey — not spawned.",
        spawn.x, spawn.y, tostring(spawn.orbitId)))
    end
  end

  -- "Mirror" objects (see lua/world/Mirror.lua): freestanding, same
  -- point-placement convention as the Sphere/Spikey spawns above —
  -- added to entitiesById too, so a Crank's own "Mirror" property
  -- (resolved below, once this loop has run) can find it.
  state.mirrors = {}
  for _, spawn in ipairs(terrainLevel.mirrorSpawns or {}) do
    local mirror = Mirror.new(spawn.x, spawn.y, spawn.angle)
    table.insert(state.mirrors, mirror)
    if spawn.id then entitiesById[spawn.id] = mirror end
  end

  -- "Lever" objects (see lua/world/Lever.lua): snapped down onto the
  -- ground below them, like the Ooombas above.
  state.levers = {}
  for _, spawn in ipairs(terrainLevel.leverSpawns or {}) do
    local _, bestHit = findGroundBelow(terrainLevel.shapes, spawn.x, spawn.y)
    if bestHit then
      local lever = Lever.new(bestHit.point.x, bestHit.point.y)
      lever.gateId = spawn.gateId
      table.insert(state.levers, lever)
    end
  end

  -- "Crank" objects (see lua/world/Crank.lua): snapped down onto the
  -- ground, like the levers just above.
  state.cranks = {}
  for _, spawn in ipairs(terrainLevel.crankSpawns or {}) do
    local _, bestHit = findGroundBelow(terrainLevel.shapes, spawn.x, spawn.y)
    if bestHit then
      local crank = Crank.new(bestHit.point.x, bestHit.point.y)
      crank.mirrorId = spawn.mirrorId
      crank.mirror = spawn.mirrorId and entitiesById[spawn.mirrorId]
      table.insert(state.cranks, crank)
    end
  end

  -- Plungers (see lua/world/Plunger.lua): fire Bob along, e.g. into a
  -- ball tunnel.
  state.plungers = {}
  for _, spawn in ipairs(terrainLevel.plungerSpawns or {}) do
    table.insert(state.plungers, Plunger.new(spawn.x, spawn.y, spawn.dir))
  end

  -- "Sign" objects (see lua/world/Sign.lua): snapped down onto the
  -- ground, like the levers/cranks above.
  state.signs = {}
  for _, spawn in ipairs(terrainLevel.signSpawns or {}) do
    local _, bestHit = findGroundBelow(terrainLevel.shapes, spawn.x, spawn.y)
    if bestHit then
      table.insert(state.signs, Sign.new(bestHit.point.x, bestHit.point.y, spawn.message))
    end
  end

  -- "Zoom-Window" objects: world-space rectangles, already fully
  -- resolved by TiledTerrain.lua — see the zoom-window pass in
  -- love.update for what they actually do.
  state.zoomWindows = terrainLevel.zoomWindows or {}

  -- "DeathZone" objects: dying inside one respawns the player at its
  -- own respawn point rather than the shelter door (see
  -- Player:startDeath/respawn). The point is loosely placed like the
  -- signs/levers above: if there's ground within reach just below it
  -- (searching from one tile above, in case it was clicked right at
  -- ground level), he's stood on that ground instead of being left
  -- overlapping it; otherwise the point is used exactly as given and
  -- he simply drops from there.
  local RESPAWN_SEARCH_UP, RESPAWN_SEARCH_DOWN = 64, 200
  state.deathZones = terrainLevel.deathZones or {}
  for _, zone in ipairs(state.deathZones) do
    local bestY = nil
    for _, shape in ipairs(terrainLevel.shapes) do
      if not shape.isWallClimb then
        local hit = shape:findLandingCrossing(
          zone.respawnX, zone.respawnY - RESPAWN_SEARCH_UP, zone.respawnX, zone.respawnY + RESPAWN_SEARCH_DOWN)
        if hit and (not bestY or hit.point.y < bestY) then
          bestY = hit.point.y
        end
      end
    end
    if bestY then
      zone.respawnY = bestY - constants.PLAYER_RADIUS - 1
    end
  end

  -- "Gate" objects (see lua/world/Gate.lua): topY/bottomY/halfWidth
  -- are already fully resolved by TiledTerrain.lua's own tile-grid
  -- scan (see its gateSpawns). Inserted into BOTH terrainLevel.walls
  -- (so CollisionSystem:handlePlayerWallCollisions blocks the player
  -- with zero changes needed there) and state.gates (so the WorldObjects
  -- registry can animate and render it) — the
  -- exact same object serves both roles at once.
  state.gates = {}
  local gatesByTiledId = {}
  for _, spawn in ipairs(terrainLevel.gateSpawns or {}) do
    local gate = Gate.new(spawn.x, spawn.topY, spawn.bottomY, spawn.halfWidth)
    table.insert(terrainLevel.walls, gate)
    table.insert(state.gates, gate)
    if spawn.id then
      gatesByTiledId[spawn.id] = gate
    end
  end

  -- Wires each lever to the Gate its own "gate" custom property names
  -- (see leverSpawns' own gateId, set from that property in
  -- TiledTerrain.lua) — a lever with no gateId, or one naming a gate
  -- that didn't resolve, is just left unwired (Lever:tryInteract
  -- already no-ops with self.gate == nil).
  for _, lever in ipairs(state.levers) do
    if lever.gateId and gatesByTiledId[lever.gateId] then
      lever.gate = gatesByTiledId[lever.gateId]
    end
  end
  return terrainLevel
end

return DomeInterior
