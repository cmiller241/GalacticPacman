-- lua/world/TiledTerrain.lua
--
-- Loads a Tiled-exported Lua map (e.g. tiled/Level1.lua) into real
-- collision geometry (walkable top surfaces AND solid walls) plus a
-- single baked-once rendering of the whole tile grid.
--
-- Tile roles come from CUSTOM PROPERTIES authored per-tile in Tiled
-- (tiled/Grass Tiles.tsx), not from GID/index ranges: inferring a tile's
-- meaning from where it sits in the sheet breaks silently whenever a tile
-- doesn't match the assumed order. With explicit properties, adding a
-- new tile is just "draw it, tag it," no code changes required.
--
-- Expected properties, set per-tile in the tileset (see buildTilePropertyLookup):
--   role  = "top" (walkable — stand on it, land on it, jump through from
--           below), "wall" (solid on every side — see WallShape below),
--           or "fill" (pure decoration, no collision). Untagged tiles
--           default to "fill".
--   slope = "flat", "riseLeft", or "riseRight" — only meaningful when
--           role == "top".
--
-- IMPORTANT: this requires the tileset to be EMBEDDED in the map (Tiled:
-- right-click the tileset in the Tilesets panel -> "Embed Tileset in
-- Map"). An external tileset reference (just name/firstgid/filename) never
-- carries tile properties into the map's own Lua export — see
-- buildTilePropertyLookup's assertion if this hasn't been done.
--
-- Each walkable shape built here is an OPEN path (a hill has two ends,
-- unlike RoundedRectPlanetoid's closed rectangle loop) — see the
-- isOpenPath flag and Player.lua's own walking code for the "fall off the
-- end" half of this. It's also deliberately NOT isSkyDome: jump-through-
-- from-below is handled by CollisionSystem's own swept crossing test
-- instead (TerrainShape:findLandingCrossing), not the SkyDome gravity-
-- window model.
--
-- The parts are in lua/world/tiled/:
--   Tiles.lua         tile sizes, roles and slopes, image quads
--   TerrainShape.lua  walkable runs of flat and slope segments
--   ClimbShapes.lua   wall-climb ramps and loops
--   Level.lua         walls, lava tiles, ball tunnels, the Level object
--   Baking.lua        the baked image of the tile layers
-- This file has TiledTerrain.load, which puts them together.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local Tiles = require("lua.world.tiled.Tiles")
local TILE_SOURCE_SIZE = Tiles.TILE_SOURCE_SIZE
local TILE_SCALE = Tiles.TILE_SCALE
local TILE_WORLD_SIZE = Tiles.TILE_WORLD_SIZE
local buildTilePropertyLookup = Tiles.buildTilePropertyLookup
local classifyGid = Tiles.classifyGid
local isTopRole = Tiles.isTopRole
local TerrainShapePart = require("lua.world.tiled.TerrainShape")
local computeTopPointsByColumn = TerrainShapePart.computeTopPointsByColumn
local buildVertexRuns = TerrainShapePart.buildVertexRuns
local buildWorldSegments = TerrainShapePart.buildWorldSegments
local newShape = TerrainShapePart.newShape
local ClimbShapes = require("lua.world.tiled.ClimbShapes")
local buildRampShapes = ClimbShapes.buildRampShapes
local LevelPart = require("lua.world.tiled.Level")
local buildWallShapes = LevelPart.buildWallShapes
local buildLavaTiles = LevelPart.buildLavaTiles
local Level = LevelPart.Level
local buildTunnelSolids = LevelPart.buildTunnelSolids
local Baking = require("lua.world.tiled.Baking")
local bakeLayers = Baking.bakeLayers

local TiledTerrain = {}

-- The functions the parts add to TiledTerrain.
for _, part in ipairs({ TerrainShapePart, Baking }) do
  for name, value in pairs(part.api) do
    assert(TiledTerrain[name] == nil, "TiledTerrain." .. name .. " is defined twice")
    TiledTerrain[name] = value
  end
end

----------------------------------------------------------------------
-- Public API
----------------------------------------------------------------------

-- mapData: the table returned by require()-ing a Tiled Lua export.
-- anchorX/anchorY: world position of the map's own (0,0) (top-left) corner.
function TiledTerrain.load(mapData, anchorX, anchorY)
  -- Tile layers, in drawing order (Tiled's own: first is furthest back).
  -- A map can have several — ones named "Back" and "Middle" get the shadows
  -- of the layers in front of them (see bakeLayers); any other name is drawn plain, like a
  -- front layer.
  local tileLayers = {}
  for _, l in ipairs(mapData.layers) do
    if l.type == "tilelayer" then table.insert(tileLayers, l) end
  end
  assert(#tileLayers > 0, "TiledTerrain.load: no tilelayer found in map data")

  local width, height = mapData.width, mapData.height
  local tilesets = mapData.tilesets
  local tileProps = buildTilePropertyLookup(tilesets)

  -- Collision comes from every layer at once: one combined layer that,
  -- cell by cell, takes the most solid tile any layer has there (a wall or
  -- lava over a walkable top, a walkable top over plain fill; the front-
  -- most of equals) — so a ledge collides the same whichever layer it was
  -- drawn on, just as when the whole level was one layer.
  local layer = tileLayers[1]
  if #tileLayers > 1 then
    local function solidity(gid)
      if gid == 0 then return 0 end
      local role = classifyGid(tileProps, gid)
      if role == "wall" or role == "lava" then return 3 end
      if role == "fill" then return 1 end
      return 2 -- walkable: flat tops, slopes, ramps, crests, arches, ceilings
    end
    local data = {}
    for i = 1, width * height do
      local best, bestRank = 0, 0
      for li = #tileLayers, 1, -1 do -- front first, so it wins ties
        local gid = tileLayers[li].data[i] or 0
        local rank = solidity(gid)
        if rank > bestRank then best, bestRank = gid, rank end
      end
      data[i] = best
    end
    layer = { data = data }
  end

  -- Ramp-to-wall climbs (rampRight/rampLeft) — built BEFORE the
  -- ordinary column scan below, so its own claimed cells (see
  -- buildRampShapes/buildRampClimbShape) can be excluded from that
  -- scan rather than being picked up twice.
  local rampShapes, rampClaimedCells = buildRampShapes(layer, tileProps, width, height, anchorX, anchorY)

  -- Collision: derive shapes from the walkable-top height profile.
  local pointsByColumn = computeTopPointsByColumn(layer, tileProps, width, height, rampClaimedCells)
  local runs = buildVertexRuns(pointsByColumn, width)
  local shapes = {}
  for _, run in ipairs(runs) do
    local segments = buildWorldSegments(run, anchorX, anchorY)
    if #segments > 0 then
      table.insert(shapes, newShape(segments))
    end
  end

  -- Appended into the same `shapes` list as the ordinary ones above,
  -- since the result is a perfectly normal TerrainShape as far as
  -- every other system (main.lua's state.planetoids, collision,
  -- drawing) is concerned — see buildRampClimbShape's own comment on
  -- shape.isWallClimb for the few places that DO need to tell it apart
  -- from ordinary terrain.
  for _, shape in ipairs(rampShapes) do
    table.insert(shapes, shape)
  end

  -- Collision: solid walls, entirely separate from the walkable shapes
  -- above — see WallShape's own comment for why these are plain rects
  -- rather than TerrainShape instances.
  local walls = buildWallShapes(layer, tileProps, width, height, anchorX, anchorY)

  -- Ball-tunnel pieces, solid in their exact shape (see Level:pushPlayer).
  local tunnelByCell, waterSolids = buildTunnelSolids(layer, tileProps, width, height, anchorX, anchorY)

  -- Lava tiles — where the lava starts out (see buildLavaTiles above,
  -- and WaterSystem.init).
  local lavaTiles = buildLavaTiles(layer, tileProps, width, height, anchorX, anchorY)

  -- Entity spawn points authored via Tiled's own Object Layer (see
  -- tiled/Level1.lua's "objectgroup" layer) — each object's Class field
  -- says what kind of entity it is, matched against main.lua's own spawn
  -- loops. Object x/y come out of Tiled in the tileset's own unscaled
  -- pixel space (tilewidth=32, same raw units as every gid/row/col
  -- computation above), so they need the same TILE_SCALE applied as the
  -- tile grid to land in world space alongside anchorX/anchorY.
  local ooombaSpawns = {}
  -- "Sphere" objects (see lua/world/Sphere.lua): unlike ooombaSpawns,
  -- these are never raycast onto terrain below them — the object's own
  -- x/y IS the sphere's center, since it's a freestanding gravity/landing
  -- body in open space, not something that needs to rest on a surface.
  local sphereSpawns = {}
  -- "Spikey" objects (see lua/world/Spikey.lua): same
  -- point-placement convention as sphereSpawns above — the object's own
  -- x/y IS the planetoid's center, no raycasting onto terrain below it.
  local spikeySpawns = {}
  -- "Mirror" objects (see lua/world/Mirror.lua): same point-placement
  -- convention as sphereSpawns/spikeySpawns above — the object's own
  -- x/y IS the mirror's own pivot, no raycasting onto terrain below it.
  -- angle comes from its own "Angle" custom property (a String
  -- property in Tiled's own export, same as every other custom
  -- property here — tonumber'd back into a number, degrees, defaulting
  -- to 0/horizontal if left out).
  local mirrorSpawns = {}
  -- "Spikey-Vertical" objects (see lua/world/SpikeyVertical.lua): same
  -- hazard, but patrols up and down within a shaft instead of sitting
  -- still. topY/bottomY are the WALL half of its patrol bounds —
  -- resolved right here via the same tile-grid scan Gate uses just
  -- below, for the same reason (needs the raw layer.data/tileProps this
  -- function has in scope). The OTHER half — clamping those bounds
  -- against any nearby static Spikey sitting in the same shaft — needs
  -- to happen in main.lua instead, once every Spikey has actually been
  -- spawned (this function only knows about the tile grid, not other
  -- entity spawns).
  local spikeyVerticalSpawns = {}
  -- "Lever" objects (see lua/world/Lever.lua): placed on the ground,
  -- same "loosely placed, snapped down onto whatever's actually below
  -- it" convention as ooombaSpawns — the raycast itself happens in
  -- main.lua's own spawn loop (it needs `terrainLevel.shapes`, which
  -- isn't fully assembled yet at this point in this function), so this
  -- is just the raw spawn point, exactly like ooombaSpawns.
  local leverSpawns = {}
  -- "Crank" objects (see lua/world/Crank.lua): same "loosely placed,
  -- snapped down onto whatever's actually below it" convention as
  -- leverSpawns above — the raycast happens in main.lua's own spawn
  -- loop, this is just the raw spawn point plus whichever Tiled object
  -- id its own "Mirror" custom property names, if any (a String
  -- property in Tiled's own export — tonumber'd back into a number
  -- here, same as spikeyOrbitSpawns' own orbitId below). Not resolved
  -- against anything yet; carried along for a future effect to use.
  local crankSpawns = {}
  -- "Sign" objects (see lua/world/Sign.lua): same "loosely placed,
  -- snapped down onto whatever's actually below it" convention as
  -- leverSpawns/crankSpawns above — the raycast happens in main.lua's
  -- own spawn loop, this is just the raw spawn point plus its own
  -- "message" custom property (a String property in Tiled's own
  -- export, pipe-delimited for more than one message — see Sign.lua's
  -- own splitMessages).
  local signSpawns = {}
  local plungerSpawns = {} -- (RightPlunger/LeftPlunger — see lua/world/Plunger.lua)
  -- "Gate" objects (see lua/world/Gate.lua): a vertical barrier that
  -- spans from the nearest wall/top tile BELOW the object's own point
  -- up to the nearest wall/top tile ABOVE it — resolved right here via
  -- a plain tile-grid scan (rather than in main.lua, like Lever above)
  -- since that scan needs the raw layer.data/tileProps/classifyGid this
  -- function already has in scope, not anything from the assembled
  -- shapes/walls lists.
  local gateSpawns = {}
  local GATE_HALF_WIDTH = 16 -- world units — a thin vertical bar, not a full tile-wide wall
  -- "Spikey-Orbit" objects (see lua/world/SpikeyOrbit.lua): a Spikey that
  -- orbits another entity instead of sitting still or patrolling a
  -- shaft. orbitId is the raw Tiled object id its own "orbit" custom
  -- property names (a String property in practice, per Tiled's own
  -- export — tonumber here turns it back into the number main.lua needs
  -- to look it up against the OTHER spawn lists' own `id` fields, which
  -- is where the actual resolution happens: this function only knows the
  -- tile grid and this object layer's own data, not which entities main.lua
  -- ends up spawning from any of it).
  local spikeyOrbitSpawns = {}
  -- "Sphere-Move" objects (see lua/world/SphereMove.lua): a Sphere that
  -- shuttles back and forth between two points instead of sitting still.
  -- Its own x/y (like plain Sphere) is just where it starts out; the
  -- startX/startY/endX/endY/speed custom properties (Strings in Tiled's
  -- own export, same as every other custom property here — tonumber'd
  -- below) describe the actual path.
  local sphereMoveSpawns = {}
  -- "Zoom-Window" objects: a rectangle (not a point, unlike everything
  -- else here) that eases the camera to its own "zoom" custom property
  -- while the player is inside it — see lua/systems/Camera.lua's zoom-window pass
  -- in love.update. Already converted to world space here.
  local zoomWindows = {}
  -- "DeathZone" objects: a rectangle with respawnX/respawnY custom
  -- properties (raw Tiled pixel space, like Sphere-Move's own path
  -- points) — dying inside it respawns the player at that point instead
  -- of the Space Shelter door. See Player:startDeath/respawn.
  local deathZones = {}
  -- "Rope" and "Rock" objects (rectangles): a rope hanging from its top,
  -- holding whatever its "holds" property names — see lua/world/RopeRock.lua
  -- (main.lua pairs them up). World space; ids kept for the pairing.
  local ropeSpawns = {}
  local rockSpawns = {}

  -- Scans column `col` outward from `startRow` in direction `dRow`
  -- (+1 = downward/floor search, -1 = upward/ceiling search) for the
  -- nearest tile classified as "wall" or a walkable "top" (isTopRole —
  -- see that function's own comment: a wall tile's TOP counts as solid
  -- ground too, exactly the "wall or top tile" the Gate is meant to
  -- reach). Returns that tile's own row, or nil if the scan runs off
  -- the map edge without finding one.
  local function findSolidRow(col, startRow, dRow)
    local r = startRow
    while r >= 0 and r < height do
      local gid = layer.data[r * width + col + 1]
      if gid ~= 0 and isTopRole(classifyGid(tileProps, gid)) then
        return r
      end
      r = r + dRow
    end
    return nil
  end

  for _, l in ipairs(mapData.layers) do
    if l.type == "objectgroup" then
      for _, obj in ipairs(l.objects or {}) do
        if obj.class == "Ooomba" then
          table.insert(ooombaSpawns, {
            x = anchorX + obj.x * TILE_SCALE,
            y = anchorY + obj.y * TILE_SCALE,
          })
        elseif obj.class == "Sphere" then
          table.insert(sphereSpawns, {
            x = anchorX + obj.x * TILE_SCALE,
            y = anchorY + obj.y * TILE_SCALE,
            -- Tiled's own object id — exposed so a Spikey-Orbit object
            -- elsewhere in this same layer can reference this one by it
            -- (see spikeyOrbitSpawns below and main.lua's own spawn
            -- wiring, which is where that reference actually gets
            -- resolved to the real spawned Sphere).
            id = obj.id,
            -- Optional "radius" custom property — the Sphere's own
            -- radius in WORLD units, the same units as its default
            -- (Sphere.DEFAULT_RADIUS, 30), not Tiled pixels. nil when
            -- not set (or not a number), which leaves it at that
            -- default. A String in Tiled's own export, like every other
            -- custom property here, hence tonumber.
            radius = tonumber(obj.properties and obj.properties["radius"]),
            -- Optional "ooomba" custom property — how many Ooombas
            -- walk laps of this Sphere (see main.lua's own Sphere spawn
            -- loop and Ooomba.newOnPlanet). 0 when not set.
            ooombaCount = math.max(0, math.floor(tonumber(obj.properties and obj.properties["ooomba"]) or 0)),
            -- Optional "gravity" custom property — the radius of this
            -- Sphere's gravity, measured from its CENTER, in world
            -- units (the same units as "radius"): anywhere within that
            -- distance, it's what pulls on the player. nil when not
            -- set, which leaves the Sphere's own small default (see
            -- Sphere.new).
            gravityRadius = tonumber(obj.properties and obj.properties["gravity"]),
          })
        elseif obj.class == "Spikey" then
          table.insert(spikeySpawns, {
            x = anchorX + obj.x * TILE_SCALE,
            y = anchorY + obj.y * TILE_SCALE,
            id = obj.id,
          })
        elseif obj.class == "Mirror" then
          table.insert(mirrorSpawns, {
            x = anchorX + obj.x * TILE_SCALE,
            y = anchorY + obj.y * TILE_SCALE,
            angle = tonumber(obj.properties and obj.properties["Angle"]) or 0,
            id = obj.id,
          })
        elseif obj.class == "Lever" then
          table.insert(leverSpawns, {
            x = anchorX + obj.x * TILE_SCALE,
            y = anchorY + obj.y * TILE_SCALE,
            -- The Gate object's own Tiled id this lever opens/closes
            -- (a String property in Tiled's own export, same as every
            -- other custom property here — tonumber'd back into a
            -- number, matched against each gateSpawns entry's own `id`
            -- below). Resolved to the actual spawned Gate in main.lua,
            -- once both lists exist.
            gateId = tonumber(obj.properties and obj.properties["gate"]),
          })
        elseif obj.class == "Crank" then
          table.insert(crankSpawns, {
            x = anchorX + obj.x * TILE_SCALE,
            y = anchorY + obj.y * TILE_SCALE,
            mirrorId = tonumber(obj.properties and obj.properties["Mirror"]),
          })
        elseif obj.class == "RightPlunger" or obj.class == "LeftPlunger" then
          -- (See lua/world/Plunger.lua. Snapped to the tile the object's
          -- top-left corner is in.)
          local col = math.floor(obj.x / TILE_SOURCE_SIZE + 0.01)
          local row = math.floor(obj.y / TILE_SOURCE_SIZE + 0.01)
          table.insert(plungerSpawns, {
            x = anchorX + col * TILE_WORLD_SIZE,
            y = anchorY + row * TILE_WORLD_SIZE,
            dir = obj.class == "RightPlunger" and 1 or -1,
          })
        elseif obj.class == "Sign" then
          table.insert(signSpawns, {
            x = anchorX + obj.x * TILE_SCALE,
            y = anchorY + obj.y * TILE_SCALE,
            message = (obj.properties and obj.properties["message"]) or "",
          })
        elseif obj.class == "Gate" then
          -- obj.x/y are in the RAW, unscaled tile-pixel space (same as
          -- every gid/row/col computation in this file) — dividing by
          -- TILE_SOURCE_SIZE (not TILE_WORLD_SIZE) is what actually
          -- lands on the right row/col here, matching how classifyGid's
          -- own callers index layer.data elsewhere in this file.
          local col = math.floor(obj.x / TILE_SOURCE_SIZE)
          local row = math.floor(obj.y / TILE_SOURCE_SIZE)
          local topRow = findSolidRow(col, row, -1)
          local bottomRow = findSolidRow(col, row, 1)
          if topRow and bottomRow and bottomRow > topRow then
            table.insert(gateSpawns, {
              x = anchorX + (col + 0.5) * TILE_WORLD_SIZE,
              topY = anchorY + (topRow + 1) * TILE_WORLD_SIZE,
              bottomY = anchorY + bottomRow * TILE_WORLD_SIZE,
              halfWidth = GATE_HALF_WIDTH,
              -- Tiled's own object id — exposed so a Lever elsewhere in
              -- this same layer can reference this one by it (see
              -- leverSpawns' own gateId above and main.lua's own spawn
              -- wiring, which is where that reference actually gets
              -- resolved to the real spawned Gate).
              id = obj.id,
            })
          else
            -- Silent failure otherwise (no gate spawned at all) is
            -- exactly the kind of thing a level designer could spend a
            -- long time confused about — e.g. nudging the object's
            -- point a bit and having it land ON a wall/top tile instead
            -- of the open space between two of them collapses topRow
            -- and bottomRow onto the same tile (or leaves one/both nil
            -- if the scan runs off the map edge without finding solid
            -- ground at all), and this print is the only signal that
            -- happened.
            print(string.format(
              "TiledTerrain: Gate object at tile (col=%d, row=%d) failed to resolve a gate (topRow=%s, bottomRow=%s) — no gate spawned here.",
              col, row, tostring(topRow), tostring(bottomRow)))
          end
        elseif obj.class == "Spikey-Vertical" then
          -- col/row (for the wall scan below) DO need the tile-grid
          -- conversion Gate uses (obj.x/y are in the RAW, unscaled
          -- tile-pixel space) — but the entity's own world x is kept at
          -- its EXACT raw position, same convention ordinary Spikey
          -- uses just above, NOT snapped to the tile column's own
          -- center the way Gate's x is. Gate genuinely needs that snap
          -- (a wall should sit centered in its corridor tile) — a
          -- Spikey-Vertical is just a circular hazard like any other
          -- Spikey, and snapping it introduced a visible horizontal
          -- offset from a stationary Spikey placed at the exact same x
          -- in Tiled, since the two would then use different position
          -- math for what was supposed to be an identical value.
          --
          -- Only the WALL half of the patrol bounds is resolved here —
          -- topY/bottomY are left nil whenever findSolidRow doesn't
          -- find one in that direction, rather than failing the whole
          -- spawn outright: a shaft can just as validly be bounded by a
          -- nearby static Spikey instead of a wall (see this file's own
          -- spikeyVerticalSpawns comment), and this function has no way
          -- to know about other entity spawns — main.lua's own spawn
          -- wiring is what actually falls back to that, and it's the
          -- only place that can tell whether BOTH kinds of bound ended
          -- up missing on a given side.
          local col = math.floor(obj.x / TILE_SOURCE_SIZE)
          local row = math.floor(obj.y / TILE_SOURCE_SIZE)
          local topRow = findSolidRow(col, row, -1)
          local bottomRow = findSolidRow(col, row, 1)
          table.insert(spikeyVerticalSpawns, {
            x = anchorX + obj.x * TILE_SCALE,
            y = anchorY + obj.y * TILE_SCALE,
            topY = topRow and (anchorY + (topRow + 1) * TILE_WORLD_SIZE) or nil,
            bottomY = bottomRow and (anchorY + bottomRow * TILE_WORLD_SIZE) or nil,
            -- Optional per-object override — set in Tiled via a custom
            -- Float property named "speed" on this point; nil (falling
            -- back to SpikeyVertical.DEFAULT_SPEED) when not set.
            speed = obj.properties and obj.properties.speed,
          })
        elseif obj.class == "Spikey-Orbit" then
          -- Both custom properties come through as Strings in Tiled's own
          -- lua export (confirmed directly against tiled/Level1.lua's own
          -- data) — tonumber turns "28"/"3.5" back into real numbers.
          table.insert(spikeyOrbitSpawns, {
            x = anchorX + obj.x * TILE_SCALE,
            y = anchorY + obj.y * TILE_SCALE,
            orbitId = obj.properties and tonumber(obj.properties.orbit),
            speed = obj.properties and tonumber(obj.properties.speed),
          })
        elseif obj.class == "Sphere-Move" then
          local props = obj.properties or {}
          -- startX/startY/endX/endY are authored in the SAME raw,
          -- unscaled tile-pixel space obj.x/y themselves are (that's the
          -- only coordinate space a level designer placing points in
          -- Tiled ever sees), so they need the identical
          -- anchor+TILE_SCALE conversion applied to obj.x/y just below,
          -- not a bare pass-through.
          table.insert(sphereMoveSpawns, {
            x = anchorX + obj.x * TILE_SCALE,
            y = anchorY + obj.y * TILE_SCALE,
            startX = anchorX + (tonumber(props.startX) or obj.x) * TILE_SCALE,
            startY = anchorY + (tonumber(props.startY) or obj.y) * TILE_SCALE,
            endX = anchorX + (tonumber(props.endX) or obj.x) * TILE_SCALE,
            endY = anchorY + (tonumber(props.endY) or obj.y) * TILE_SCALE,
            speed = tonumber(props.speed),
          })
        elseif obj.class == "Zoom-Window" then
          local zoom = tonumber(obj.properties and obj.properties.zoom)
          if zoom then
            table.insert(zoomWindows, {
              x = anchorX + obj.x * TILE_SCALE,
              y = anchorY + obj.y * TILE_SCALE,
              width = obj.width * TILE_SCALE,
              height = obj.height * TILE_SCALE,
              zoom = zoom,
            })
          else
            print(string.format(
              "TiledTerrain: Zoom-Window object id %s has no numeric \"zoom\" property — ignored.",
              tostring(obj.id)))
          end
        elseif obj.class == "Rope" or obj.class == "Rock" then
          local props = obj.properties or {}
          local spawn = {
            id = obj.id,
            x = anchorX + obj.x * TILE_SCALE,
            y = anchorY + obj.y * TILE_SCALE,
            width = obj.width * TILE_SCALE,
            height = obj.height * TILE_SCALE,
          }
          if obj.class == "Rope" then
            -- "holds": an object property (exported as { id = n }), or
            -- the id typed in as a number/string, like Spikey-Orbit's "orbit".
            local holds = props.holds
            spawn.holdsId = tonumber(type(holds) == "table" and holds.id or holds)
            table.insert(ropeSpawns, spawn)
          else
            spawn.solid = props.solid ~= false
            table.insert(rockSpawns, spawn)
          end
        elseif obj.class == "DeathZone" then
          local props = obj.properties or {}
          local respawnX, respawnY = tonumber(props.respawnX), tonumber(props.respawnY)
          if respawnX and respawnY then
            table.insert(deathZones, {
              x = anchorX + obj.x * TILE_SCALE,
              y = anchorY + obj.y * TILE_SCALE,
              width = obj.width * TILE_SCALE,
              height = obj.height * TILE_SCALE,
              respawnX = anchorX + respawnX * TILE_SCALE,
              respawnY = anchorY + respawnY * TILE_SCALE,
            })
          else
            print(string.format(
              "TiledTerrain: DeathZone object id %s needs numeric \"respawnX\" and \"respawnY\" properties — ignored.",
              tostring(obj.id)))
          end
        end
      end
    end
  end

  -- Rendering: bake EVERY tile layer (fill tiles included — rendering
  -- doesn't care about the walkable/fill/wall distinction, only collision
  -- does) to one canvas, once, with the depth shading (see bakeLayers).
  local canvas = nil
  local img = state.platformTexture
  if img then
    canvas = bakeLayers(tileLayers, tilesets, tileProps, width, height, img)
  end

  local mapWorldWidth = width * TILE_WORLD_SIZE
  local mapWorldHeight = height * TILE_WORLD_SIZE

  local level = setmetatable({
    shapes = shapes,
    walls = walls,
    lavaTiles = lavaTiles,
    ooombaSpawns = ooombaSpawns,
    sphereSpawns = sphereSpawns,
    spikeySpawns = spikeySpawns,
    mirrorSpawns = mirrorSpawns,
    leverSpawns = leverSpawns,
    crankSpawns = crankSpawns,
    signSpawns = signSpawns,
    plungerSpawns = plungerSpawns,
    gateSpawns = gateSpawns,
    spikeyVerticalSpawns = spikeyVerticalSpawns,
    spikeyOrbitSpawns = spikeyOrbitSpawns,
    sphereMoveSpawns = sphereMoveSpawns,
    zoomWindows = zoomWindows,
    deathZones = deathZones,
    ropeSpawns = ropeSpawns,
    rockSpawns = rockSpawns,
    -- (For Level:solidAt/headroomAt/pushPlayer — ball tunnels.)
    tunnelByCell = tunnelByCell,
    waterSolids = waterSolids,
    collisionData = layer.data,
    tileProps = tileProps,
    -- (The visible art, layer by layer — see lua/effects/GrassBlades.lua.)
    tileLayers = tileLayers,
    tilesets = tilesets,
    mapWidth = width,
    mapHeight = height,
    canvas = canvas,
    canvasScale = Baking.CANVAS_SCALE, -- (drawn this many times bigger)
    anchorX = anchorX,
    anchorY = anchorY,
    -- Bounding center/radius, same convention every other drawable in
    -- this codebase exposes, so callers can viewport-cull this draw
    -- call the same way (see utils.isOnScreen).
    pos = Vector2.new(anchorX + mapWorldWidth / 2, anchorY + mapWorldHeight / 2),
    radius = math.sqrt(mapWorldWidth * mapWorldWidth + mapWorldHeight * mapWorldHeight) / 2,
  }, Level)

  return level
end

return TiledTerrain
