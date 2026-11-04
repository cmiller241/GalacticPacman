-- lua/world/tiled/Level.lua
--
-- Solid wall blocks, lava tiles, and the Level object: drawing it, its
-- ball tunnels, and headroom for the player.
-- Part of the Tiled level loader: see lua/world/TiledTerrain.lua.

local Vector2 = require("lua.vector2")
local Tiles = require("lua.world.tiled.Tiles")
local TILE_WORLD_SIZE = Tiles.TILE_WORLD_SIZE
local classifyGid = Tiles.classifyGid

----------------------------------------------------------------------
-- WallShape — a solid axis-aligned rectangle, blocking the player from
-- every side. Unlike TerrainShape (a one-way "stand on top of me"
-- surface with its own arc-length walking API), a wall has no surface to
-- walk along — it's plain circle-vs-rectangle collision, handled
-- entirely in CollisionSystem:handlePlayerWallCollisions. Just a plain
-- table (pos/halfWidth/halfHeight/radius), not a TerrainShape.
----------------------------------------------------------------------

-- Scans each row for horizontal runs of "wall"-role tiles and merges each
-- run into one wide rectangle (same "don't emit one collider per tile"
-- reasoning TerrainShape's own segment coalescing uses). Runs are NOT
-- merged vertically across rows — a tall wall becomes a stack of
-- full-width rectangles rather than one tall one — which is a deliberate
-- simplicity trade, not a correctness issue: a stack of rectangles
-- collides identically to one tall rectangle.
local function buildWallShapes(layer, tileProps, width, height, anchorX, anchorY)
  local walls = {}

  local function addWallRun(row, startCol, endCol)
    local x0 = anchorX + startCol * TILE_WORLD_SIZE
    local x1 = anchorX + (endCol + 1) * TILE_WORLD_SIZE
    local y0 = anchorY + row * TILE_WORLD_SIZE
    local y1 = anchorY + (row + 1) * TILE_WORLD_SIZE
    local halfWidth, halfHeight = (x1 - x0) / 2, (y1 - y0) / 2
    table.insert(walls, {
      pos = Vector2.new((x0 + x1) / 2, (y0 + y1) / 2),
      halfWidth = halfWidth,
      halfHeight = halfHeight,
      radius = math.sqrt(halfWidth * halfWidth + halfHeight * halfHeight),
      isWall = true,
    })
  end

  for row = 0, height - 1 do
    local runStartCol = nil
    for col = 0, width - 1 do
      local gid = layer.data[row * width + col + 1]
      local isWallTile = gid ~= 0 and classifyGid(tileProps, gid) == "wall"
      if isWallTile and not runStartCol then
        runStartCol = col
      elseif not isWallTile and runStartCol then
        addWallRun(row, runStartCol, col - 1)
        runStartCol = nil
      end
    end
    if runStartCol then addWallRun(row, runStartCol, width - 1) end
  end

  return walls
end

----------------------------------------------------------------------
-- Lava tiles: where the level's lava starts out. The lava itself is a
-- liquid, flowing like the water — see WaterSystem.lua (WaterSystem.init
-- fills these tiles with it). Each is { x0, y0, size }: its top-left
-- corner in world units, and its size.
----------------------------------------------------------------------

local function buildLavaTiles(layer, tileProps, width, height, anchorX, anchorY)
  local lavaTiles = {}
  for row = 0, height - 1 do
    for col = 0, width - 1 do
      local gid = layer.data[row * width + col + 1]
      if gid ~= 0 and classifyGid(tileProps, gid) == "lava" then
        table.insert(lavaTiles, {
          x0 = anchorX + col * TILE_WORLD_SIZE, y0 = anchorY + row * TILE_WORLD_SIZE, size = TILE_WORLD_SIZE,
        })
      end
    end
  end
  return lavaTiles
end

----------------------------------------------------------------------
-- Whole-level renderer — baked ONCE to a single canvas, never rebuilt
-- per frame (see SkyDomePlanetoid's own foreground-hex-grid history for
-- exactly why a per-frame rebuild of something static is worth avoiding).
----------------------------------------------------------------------

local Level = {}
Level.__index = Level

function Level:draw()
  if not self.canvas then return end
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(self.canvas, self.anchorX, self.anchorY)
end

----------------------------------------------------------------------
-- Ball tunnels: solid tunnel pieces, and headroom
----------------------------------------------------------------------
--
-- The ball-tunnel arc pieces (CrackedPlanetoid.lua's *Outer1/2/3, round
-- the outside of a bend over a crest or under an arch) are solid exactly
-- where their art is: Bob (and his head, standing — see below), fireballs
-- and water are kept out of them. The tunnel's straight ceilings and
-- walls are ordinary wall tiles, so are its *Inner corners (see
-- classifyGid), and its bends are the ordinary ramp/ceiling/crest curves
-- he already rolls round (see buildRampClimbShape/buildConvexClimbShape).
--
-- Headroom: standing up, Bob is taller than his round body — a head
-- circle sits on top of it, reaching about 78 units above his feet. A
-- ball tunnel is one tile (64 units) high: he only fits curled up as a
-- ball (about 48), so he can't walk into one standing, his head is
-- stopped jumping into one, and he can't uncurl inside one (see
-- Player:exitBallMode and main.lua). The same as on the Tiled planet
-- (CrackedPlanetoid:standingRoomAt).

local HEAD_OFFSET = 26   -- the head circle's center, above his own center
local HEAD_RADIUS = 22
-- Curves that are a ceiling over him (solid above), for headroom.
local HEADROOM_CURVES = { ceilingLeft = true, ceilingRight = true, archLeft = true, archRight = true }

local function pointInOutline(o, x, y)
  local inside, n = false, #o
  local jx, jy = o[n - 1], o[n]
  for k = 1, n, 2 do
    local ix, iy = o[k], o[k + 1]
    if (iy > y) ~= (jy > y) and x < (jx - ix) * (y - iy) / (jy - iy) + ix then inside = not inside end
    jx, jy = ix, iy
  end
  return inside
end

local function nearestOnOutline(o, x, y)
  local bx, by, bd = x, y, math.huge
  local n = #o
  for k = 1, n, 2 do
    local k2 = (k + 1) % n + 1
    local ax, ay, cx, cy = o[k], o[k + 1], o[k2], o[k2 + 1]
    local dx, dy = cx - ax, cy - ay
    local len2 = dx * dx + dy * dy
    local t = len2 > 0 and ((x - ax) * dx + (y - ay) * dy) / len2 or 0
    if t < 0 then t = 0 elseif t > 1 then t = 1 end
    local qx, qy = ax + dx * t, ay + dy * t
    local d = (x - qx) ^ 2 + (y - qy) ^ 2
    if d < bd then bx, by, bd = qx, qy, d end
  end
  return bx, by, bd
end

-- A tile's outline (shape name) in world space, for the cell at col/row.
local function shapeOutlineWorld(shape, anchorX, anchorY, col, row)
  local SHAPED = require("lua.world.CrackedPlanetoid").SHAPED_TILES
  local T = TILE_WORLD_SIZE
  local x0, y0 = anchorX + col * T, anchorY + row * T
  local o = {}
  for _, p in ipairs(SHAPED[shape].outline) do
    o[#o + 1] = x0 + p[1] * T
    o[#o + 1] = y0 + (1 - p[2]) * T
  end
  return o
end

function Level:cellAt(x, y)
  local T = TILE_WORLD_SIZE
  local col = math.floor((x - self.anchorX) / T)
  local row = math.floor((y - self.anchorY) / T)
  if col < 0 or row < 0 or col >= self.mapWidth or row >= self.mapHeight then return nil end
  return col, row
end

-- Whether world (x, y) is inside a ball-tunnel piece.
function Level:tunnelSolidAt(x, y)
  local col, row = self:cellAt(x, y)
  if not col then return false end
  local t = self.tunnelByCell[row * self.mapWidth + col]
  return t ~= nil and pointInOutline(t, x, y)
end

-- Whether world (x, y) is solid rock: a wall tile or a ball-tunnel piece
-- — and, for headroom, the solid part of a ceiling/arch curve too. (Not
-- an ordinary top: he can always stand up into, or jump up through, one
-- of those.)
function Level:solidAt(x, y, forHeadroom)
  local col, row = self:cellAt(x, y)
  if not col then return false end
  local key = row * self.mapWidth + col
  local t = self.tunnelByCell[key]
  if t then return pointInOutline(t, x, y) end
  local gid = self.collisionData[key + 1] or 0
  if gid == 0 then return false end
  local role = classifyGid(self.tileProps, gid)
  if role == "wall" then return true end
  if forHeadroom and HEADROOM_CURVES[role] then
    return pointInOutline(shapeOutlineWorld(role, self.anchorX, self.anchorY, col, row), x, y)
  end
  return false
end

-- Whether a standing Bob with his center at (cx, cy) and body radius r
-- has room: nothing solid in his head, or the top of his body.
function Level:headroomAt(cx, cy, r)
  local hx, hy = cx, cy - HEAD_OFFSET
  if self:solidAt(hx, hy, true) then return false end
  for k = 0, 7 do
    local a = k * math.pi / 4
    if self:solidAt(hx + math.cos(a) * (HEAD_RADIUS - 1), hy + math.sin(a) * (HEAD_RADIUS - 1), true) then
      return false
    end
  end
  for _, deg in ipairs({ -150, -120, -90, -60, -30 }) do
    local a = math.rad(deg)
    if self:solidAt(cx + math.cos(a) * (r - 1), cy + math.sin(a) * (r - 1), true) then return false end
  end
  return true
end

-- Whether curled-up Bob could stand up where he is: feet where the
-- ball's bottom is, at his full standing size.
function Level:standingRoomAt(player)
  local full = player.baseRadius or player.radius
  local feetY = player.pos.y + player.radius
  return self:headroomAt(player.pos.x, feetY - full, full)
end

-- Pushes a circle at (x, y), radius r, out of the ball-tunnel pieces —
-- and, with withCurves, out of the solid part of ceiling/arch curves, and
-- with withWalls out of wall tiles too (for his head: his body's walls
-- are CollisionSystem's). Returns its new center and the direction of
-- the last push (nil if it wasn't moved).
function Level:pushCircleOut(x, y, r, withWalls, withCurves)
  local T = TILE_WORLD_SIZE
  local nx, ny
  for _ = 1, 3 do
    local moved = false
    local c0, r0 = self:cellAt(x - r, y - r)
    local c1, r1 = self:cellAt(x + r, y + r)
    c0 = c0 or math.max(0, math.floor((x - r - self.anchorX) / T))
    r0 = r0 or math.max(0, math.floor((y - r - self.anchorY) / T))
    c1 = c1 or math.min(self.mapWidth - 1, math.floor((x + r - self.anchorX) / T))
    r1 = r1 or math.min(self.mapHeight - 1, math.floor((y + r - self.anchorY) / T))
    for row = r0, r1 do
      for col = c0, c1 do
        local key = row * self.mapWidth + col
        local o = self.tunnelByCell[key]
        if not o and (withWalls or withCurves) then
          local gid = self.collisionData[key + 1] or 0
          if gid ~= 0 then
            local role = classifyGid(self.tileProps, gid)
            if role == "wall" and withWalls then
              local x0, y0 = self.anchorX + col * T, self.anchorY + row * T
              o = { x0, y0, x0 + T, y0, x0 + T, y0 + T, x0, y0 + T }
            elseif HEADROOM_CURVES[role] and withCurves then
              o = shapeOutlineWorld(role, self.anchorX, self.anchorY, col, row)
            end
          end
        end
        if o then
          local qx, qy, d2 = nearestOnOutline(o, x, y)
          local d = math.sqrt(d2)
          local inside = pointInOutline(o, x, y)
          if inside or d < r - 0.5 then
            local px, py
            if d > 1e-6 then px, py = (x - qx) / d, (y - qy) / d else px, py = 0, -1 end
            if inside then px, py = -px, -py end -- (out the nearest side)
            local depth = inside and (d + r) or (r - d)
            x, y = x + px * depth, y + py * depth
            nx, ny, moved = px, py, true
          end
        end
      end
    end
    if not moved then break end
  end
  return x, y, nx, ny
end

-- Every frame (see main.lua): keeps Bob out of the ball-tunnel pieces —
-- and of the ceiling/arch curves, except while he's riding one of this
-- file's curve paths (it rounds them itself; see buildRampClimbShape) —
-- and, standing, in the air, his head out of ceilings.
function Level:pushPlayer(player)
  local function apply(dx, dy, nx, ny)
    player.pos.x, player.pos.y = player.pos.x + dx, player.pos.y + dy
    local into = player.vel.x * nx + player.vel.y * ny
    if into < 0 then
      player.vel.x, player.vel.y = player.vel.x - nx * into, player.vel.y - ny * into
    end
    if player.onSurface and player.currentPlanet
       and type(player.currentPlanet.arcPositionForWorldPoint) == "function" then
      player.surfaceArcPos = player.currentPlanet:arcPositionForWorldPoint(player.pos.x, player.pos.y)
    end
  end
  local onCurvePath = player.onSurface and player.currentPlanet and player.currentPlanet.isWallClimb
  local x, y, nx, ny = self:pushCircleOut(player.pos.x, player.pos.y, player.radius, false, not onCurvePath)
  if nx then apply(x - player.pos.x, y - player.pos.y, nx, ny) end
  if not player.isBall and not player.onSurface then
    local hx, hy = player.pos.x, player.pos.y - HEAD_OFFSET
    local x2, y2, hnx, hny = self:pushCircleOut(hx, hy, HEAD_RADIUS, true, true)
    if hnx then apply(x2 - hx, y2 - hy, hnx, hny) end
  end
end

-- The ball-tunnel pieces: { [row * width + col] = world outline } — and,
-- for the water, a solid cell for each whose middle is inside one.
local function buildTunnelSolids(layer, tileProps, width, height, anchorX, anchorY)
  local SHAPED = require("lua.world.CrackedPlanetoid").SHAPED_TILES
  local byCell, waterSolids = {}, {}
  local T = TILE_WORLD_SIZE
  for row = 0, height - 1 do
    for col = 0, width - 1 do
      local raw = layer.data[row * width + col + 1] or 0
      local gid = raw % 2 ^ 29
      local props = gid ~= 0 and tileProps[gid]
      local shape = props and props.slope
      if shape and SHAPED[shape] and shape:find("Outer%d$") then -- (the *Inner corners are walls — see classifyGid)
        if math.floor(raw / 2 ^ 31) % 2 == 1 then -- (flipped left-right in Tiled)
          shape = shape:find("Right") and (shape:gsub("Right", "Left")) or (shape:gsub("Left", "Right"))
        end
        local o = shapeOutlineWorld(shape, anchorX, anchorY, col, row)
        byCell[row * width + col] = o
        local cx, cy = anchorX + (col + 0.5) * T, anchorY + (row + 0.5) * T
        if pointInOutline(o, cx, cy) then
          table.insert(waterSolids, { pos = Vector2.new(cx, cy), halfWidth = T / 2, halfHeight = T / 2, isWall = true })
        end
      end
    end
  end
  return byCell, waterSolids
end

return {
  buildWallShapes = buildWallShapes,
  buildLavaTiles = buildLavaTiles,
  Level = Level,
  buildTunnelSolids = buildTunnelSolids,
}
