-- lua/world/tiled/TerrainShape.lua
--
-- TerrainShape: one open, walkable run of flat and slope segments, and
-- building them from the map's top tiles.
-- Part of the Tiled level loader: see lua/world/TiledTerrain.lua.

local Vector2 = require("lua.vector2")
local PlanetSurface = require("lua.world.PlanetSurface")
local Tiles = require("lua.world.tiled.Tiles")
local TILE_WORLD_SIZE = Tiles.TILE_WORLD_SIZE
local classifyGid = Tiles.classifyGid
local isTopRole = Tiles.isTopRole

-- Functions it adds to TiledTerrain (copied on in lua/world/TiledTerrain.lua).
local TiledTerrain = {}

local SLOPE_UPHILL_MULTIPLIER = 0.6   -- walking speed climbing a 45-degree segment; flat stays 1.0
local SLOPE_DOWNHILL_MULTIPLIER = 1.4 -- walking speed descending a 45-degree segment

----------------------------------------------------------------------
-- TerrainShape — one open, walkable run of flat/slope segments
----------------------------------------------------------------------

local TerrainShape = {}
TerrainShape.__index = TerrainShape

-- Projects (worldX, worldY) onto segment [seg.a, seg.b], clamped to the
-- segment's own extent. Shared by nearestSurfacePoint (which wants the
-- point/normal/distance) and arcPositionForWorldPoint (which wants how
-- far along the segment that clamped point is).
local function projectOntoSegment(seg, worldX, worldY)
  local dx, dy = seg.b.x - seg.a.x, seg.b.y - seg.a.y
  local lenSq = dx * dx + dy * dy
  local t = 0
  if lenSq > 1e-9 then
    t = ((worldX - seg.a.x) * dx + (worldY - seg.a.y) * dy) / lenSq
    t = math.max(0, math.min(1, t))
  end
  local px, py = seg.a.x + dx * t, seg.a.y + dy * t
  local ddx, ddy = worldX - px, worldY - py
  return t, px, py, math.sqrt(ddx * ddx + ddy * ddy)
end

function TerrainShape:nearestSurfacePoint(worldX, worldY)
  -- (The best so far kept in locals: one result table at the end, not
  -- one for every closer segment found on the way.)
  local bestDist, bestX, bestY, bestNormal = nil, 0, 0, nil
  for _, seg in ipairs(self.segments) do
    local _, px, py, dist = projectOntoSegment(seg, worldX, worldY)
    if not bestDist or dist < bestDist then
      bestDist, bestX, bestY, bestNormal = dist, px, py, seg.normal
    end
  end
  if not bestDist then return nil end
  return { point = Vector2.new(bestX, bestY), normal = bestNormal, distance = bestDist }
end

-- True when (x, y) is certainly more than `reach` from every point of
-- this shape's segments — a cheap test to skip the per-segment work.
-- Uses boundX/boundY/boundRadius (see refreshBounds), which always
-- enclose every segment, unlike pos/radius, which a merged wall-climb
-- shape keeps from before its merge.
function TerrainShape:isFartherThan(x, y, reach)
  local dx, dy = x - self.boundX, y - self.boundY
  local r = self.boundRadius + reach
  return dx * dx + dy * dy > r * r
end

-- A circle round every segment end (and so every point of every
-- segment). Called whenever the segments change.
function TerrainShape:refreshBounds()
  local minX, maxX, minY, maxY = math.huge, -math.huge, math.huge, -math.huge
  for _, seg in ipairs(self.segments) do
    minX = math.min(minX, seg.a.x, seg.b.x); maxX = math.max(maxX, seg.a.x, seg.b.x)
    minY = math.min(minY, seg.a.y, seg.b.y); maxY = math.max(maxY, seg.a.y, seg.b.y)
  end
  local cx, cy = (minX + maxX) / 2, (minY + maxY) / 2
  local rSq = 0
  for _, seg in ipairs(self.segments) do
    for _, p in ipairs({ seg.a, seg.b }) do
      local dx, dy = p.x - cx, p.y - cy
      rSq = math.max(rSq, dx * dx + dy * dy)
    end
  end
  self.boundX, self.boundY, self.boundRadius = cx, cy, math.sqrt(rSq)
end

function TerrainShape:distanceToSurface(worldX, worldY)
  return self:nearestSurfacePoint(worldX, worldY).distance
end

-- The planet surface interface (see lua/world/PlanetSurface.lua).
-- forceUprightJump shapes (ordinary ground and slopes) keep him standing
-- straight up, the way Mario doesn't tilt to a slope; ramp-climb shapes
-- (forceUprightJump = false) turn him to their surface.
function TerrainShape:upAt(worldX, worldY)
  if self.forceUprightJump then return Vector2.new(0, -1) end
  return PlanetSurface.upFromNormal(self, worldX, worldY)
end

TerrainShape.gravityDirAt = PlanetSurface.gravityTowardSurface

-- Open-path shapes (all of them, so far) are landing surfaces only,
-- never a gravity source of their own: a ledge would otherwise tug a
-- falling player sideways toward it like a tiny planet, instead of the
-- dome's straight-down gravity doing the rest.
function TerrainShape:gravityDistance(worldX, worldY)
  if self.isOpenPath then return nil end
  return PlanetSurface.gravityDistanceFromSurface(self, worldX, worldY)
end

-- Landing check for open-path terrain: a segment only counts as a landing
-- candidate when the player's movement THIS FRAME actually crossed it —
-- was on the outward (walkable) side of the segment a moment ago, and is
-- at/through it now — while genuinely positioned over the segment's own
-- span (no clamping to endpoints). This is the same swept test ordinary
-- platformer tile collision uses ("was above last frame, at-or-below now"),
-- and it's what makes both jump-through-from-below and walking off the end
-- just work with no timers or tuned distance tolerances: approaching from
-- below never satisfies "was on the outward side," and once the player is
-- horizontally past a segment's true endpoint, no segment's span contains
-- them, so nothing lands. Used only by CollisionSystem:tryLandOnPlanet;
-- every other caller (orientation, gravity direction while airborne, etc.)
-- still wants the always-clamped nearestSurfacePoint.
-- Upright shapes (forceUprightJump — ordinary ground and slopes) keep
-- him standing straight up, directly above the point he's on (see
-- worldPointAtArcPosition). So the point that goes with a position near
-- one is the one straight below (or above) it — not the nearest point,
-- which on a slope is off to the uphill side: landing there, or working
-- out his place along the shape from there, moved him up the slope
-- every time he jumped and came back down.
--
-- Returns that point's y, its segment and how far along the segment it
-- is (0..1): of the segments spanning x, the one whose height there is
-- nearest y. nil if none spans x (past either end of the shape).
local function pointStraightBelow(self, x, y)
  local bestDist, bestY, bestSeg, bestT
  for _, seg in ipairs(self.segments) do
    local ax, bx = seg.a.x, seg.b.x
    local dx = bx - ax
    if not seg.isWallFace and math.abs(dx) > 1e-9 and x >= math.min(ax, bx) and x <= math.max(ax, bx) then
      local t = (x - ax) / dx
      local py = seg.a.y + (seg.b.y - seg.a.y) * t
      local d = math.abs(y - py)
      if not bestDist or d < bestDist then
        bestDist, bestY, bestSeg, bestT = d, py, seg, t
      end
    end
  end
  return bestY, bestSeg, bestT
end

function TerrainShape:findLandingCrossing(prevX, prevY, curX, curY)
  local best = nil
  for _, seg in ipairs(self.segments) do
    -- isWallFace segments (see buildRampClimbShape) are never a valid
    -- landing target — jumping straight at the wall and getting
    -- swept-crossing "caught" on it here is exactly what let a player
    -- run up the wall without ever going through the ramp, bypassing
    -- the ramp/curve entry point (and Player.lua's own isWallFace
    -- detach check) entirely. The wall's own separate WallShape (see
    -- buildWallShapes) still pushes the player out and enables an
    -- ordinary wall-jump for this exact same physical surface — this
    -- only blocks TerrainShape's own "walk up it" attachment via a
    -- direct jump; walking onto it continuously from the ramp (which
    -- never calls findLandingCrossing at all — see Player.lua's
    -- move()) is completely unaffected.
    if not seg.isWallFace then
      local dx, dy = seg.b.x - seg.a.x, seg.b.y - seg.a.y
      local lenSq = dx * dx + dy * dy
      if lenSq > 1e-9 then
        local nx, ny = seg.normal.x, seg.normal.y
        -- (Where they were measured against where the surface was then —
        -- the same thing, except for a moving one: see newMovingSurface.)
        local pa, pn = seg.prevA or seg.a, seg.prevNormal or seg.normal
        local prevSigned = (prevX - pa.x) * pn.x + (prevY - pa.y) * pn.y
        local curSigned = (curX - seg.a.x) * nx + (curY - seg.a.y) * ny
        if prevSigned >= 0 and curSigned <= prevSigned then
          local t = ((curX - seg.a.x) * dx + (curY - seg.a.y) * dy) / lenSq
          if t >= 0 and t <= 1 then
            local px, py = seg.a.x + dx * t, seg.a.y + dy * t
            local ddx, ddy = curX - px, curY - py
            local dist = math.sqrt(ddx * ddx + ddy * ddy)
            if not best or dist < best.distance then
              best = { point = Vector2.new(px, py), normal = seg.normal, distance = dist }
            end
          end
        end
      end
    end
  end
  -- On an upright shape, the landing point is the one straight below
  -- (see pointStraightBelow). Whether and when it's a landing at all is
  -- left exactly as found above.
  if best and self.forceUprightJump then
    local py, seg = pointStraightBelow(self, curX, curY)
    if py then
      best.point.x, best.point.y = curX, py
      best.normal = seg.normal
    end
  end
  return best
end

function TerrainShape:containsPoint(worldX, worldY)
  return self:distanceToSurface(worldX, worldY) < 1
end

-- No-op: TerrainShape instances live in state.planetoids (needed for the
-- generic physics/collision/gravity code to find them), and that list's
-- own draw loop calls :draw() on every entry unconditionally — but the
-- actual visuals are handled once for the whole level by Level:draw()
-- below (the single baked canvas), not per-shape. Same "provide the
-- no-op so the generic loop doesn't crash" precedent SkyDomePlanetoid
-- uses for methods that genuinely don't apply to it.
function TerrainShape:draw() end

function TerrainShape:getPerimeter()
  return self.totalLength
end

-- Internal: which segment covers arc-length s (clamped, not wrapped —
-- this is an open path), and the world point at that exact spot.
function TerrainShape:segmentAtArcPosition(s)
  local clamped = math.max(0, math.min(self.totalLength, s))
  local remaining = clamped
  for i, seg in ipairs(self.segments) do
    if remaining <= seg.length or i == #self.segments then
      local t = seg.length > 0 and (remaining / seg.length) or 0
      t = math.max(0, math.min(1, t))
      local px = seg.a.x + (seg.b.x - seg.a.x) * t
      local py = seg.a.y + (seg.b.y - seg.a.y) * t
      return seg, Vector2.new(px, py)
    end
    remaining = remaining - seg.length
  end
  local seg = self.segments[#self.segments]
  return seg, seg.b:clone()
end

function TerrainShape:worldPointAtArcPosition(s, pushDistance)
  pushDistance = pushDistance or 0
  local seg, point = self:segmentAtArcPosition(s)
  local normal = seg.normal
  if pushDistance ~= 0 then
    -- forceUprightJump shapes (ordinary hills/ramps) push straight up,
    -- never along the segment's own (possibly diagonal) normal — this
    -- surface forces the player upright regardless of slope (see
    -- Player:visualDownDirection), so the resting offset has to match
    -- or the player's CENTER jumps sideways by a chunk of pushDistance
    -- the instant a walk crosses from a flat segment (normal straight
    -- up) onto a 45-degree one (normal diagonal) or back. Since the
    -- camera tracks player.pos directly with no smoothing, that jump
    -- reads as a camera jolt.
    --
    -- Shapes with forceUprightJump = false (see buildRampClimbShape)
    -- push along the segment's TRUE normal instead — required for
    -- those specifically, since a shape whose orientation is meant to
    -- rotate with the surface (running up a wall, sideways-on) needs
    -- its resting offset to point sideways there too, not straight up
    -- into empty air.
    local pushDir = self.forceUprightJump and Vector2.new(0, -1) or normal
    point = point:clone():add(pushDir:multiply(pushDistance))
  end
  return { point = point, normal = normal }
end

-- excludeWallFace: skip the wall-face segment (see buildRampClimbShape)
-- when picking the nearest one. Only passed true from the LANDING path
-- (CollisionSystem:tryLandOnPlanet) — findLandingCrossing already
-- refuses to land ON the wall face itself, but without this, this
-- function's own separate nearest-segment search (used right after, to
-- turn that landing point into an arc position) could still resolve to
-- it anyway: near a corner like a ceiling cap, the wall face sits
-- geometrically close to the cap-arc/ceiling segments a player actually
-- lands on, so "nearest segment" and "the segment they landed on" can
-- disagree. Left false for the OTHER caller (CollisionSystem's
-- wall-push resync, every frame the player is shoved by touching a
-- WallShape) — that one fires legitimately while genuinely walking the
-- wall face itself, and needs to keep resolving to it.
function TerrainShape:arcPositionForWorldPoint(worldX, worldY, excludeWallFace)
  -- An upright shape: the place straight below the point (see
  -- pointStraightBelow), when there's one.
  if self.forceUprightJump then
    local _, seg, t = pointStraightBelow(self, worldX, worldY)
    if seg then
      local traveled = 0
      for _, s in ipairs(self.segments) do
        if s == seg then return traveled + t * seg.length end
        traveled = traveled + s.length
      end
    end
  end

  local traveled = 0
  local bestArc, bestDistSq = 0, math.huge
  for _, seg in ipairs(self.segments) do
    if not (excludeWallFace and seg.isWallFace) then
      local t, px, py = projectOntoSegment(seg, worldX, worldY)
      local ddx, ddy = worldX - px, worldY - py
      local distSq = ddx * ddx + ddy * ddy
      if distSq < bestDistSq then
        bestDistSq = distSq
        bestArc = traveled + t * seg.length
      end
    end
    traveled = traveled + seg.length
  end
  return bestArc
end

-- Walking-speed hook Player.lua and Ooomba.lua look for (duck-typed —
-- see Player.lua's generic isRoundedRect walking branch). Steepness is
-- binary here since every slope in this system is exactly 45 degrees by
-- construction: a segment either has a horizontal tangent (flat) or it
-- doesn't (slope).
--
-- `direction` is the caller's own signed arc-length step for this update
-- (ds for the player, ±1 for an Ooomba) — needed to tell uphill from
-- downhill, which a segment's steepness alone can't: the same sloped
-- segment is downhill walking one way along it and uphill walking the
-- other. tangent always points toward increasing arc position; its sign
-- says whether that direction climbs (tangent.y < 0, since y decreases
-- upward) or descends (tangent.y > 0). direction * tangent.y is
-- therefore positive when walking WITH that descent (downhill) and
-- negative when walking AGAINST it (uphill).
function TerrainShape:getArcSpeedMultiplier(s, direction)
  -- Wall-climb shapes (see buildRampClimbShape) are exempt entirely —
  -- every segment past the initial curve is steep by design (that's
  -- the whole point), so the ordinary uphill penalty below would slow
  -- the player down through practically the whole feature. This is
  -- meant to run at full, Sonic-style speed instead — see also
  -- Player.lua's own isWallClimb check, which detaches the player from
  -- these shapes entirely rather than just slowing them down further
  -- once they stop actively climbing.
  if self.isWallClimb then return 1.0 end

  local seg = self:segmentAtArcPosition(s)
  if math.abs(seg.tangent.y) <= 0.01 then
    return 1.0
  end
  direction = direction or 1
  if direction * seg.tangent.y > 0 then
    return SLOPE_DOWNHILL_MULTIPLIER
  end
  return SLOPE_UPHILL_MULTIPLIER
end

----------------------------------------------------------------------
-- Building shapes from the tile grid
----------------------------------------------------------------------

-- Returns an array indexed [0, width-1], each entry a list of every row
-- (0-based tile row, smaller = higher up) classified "top" in that column,
-- top-to-bottom. A single column can legitimately hold more than one —
-- e.g. a floating plateau directly above a lower staircase step, which is
-- exactly how tiled/Level1.lua is built (confirmed by walking its actual
-- data: columns 30-34 each carry three separate top tiles at rows 14, 22,
-- and 29). A naive "first hit wins" height profile would silently discard
-- every layer but the topmost, making the staircase underneath completely
-- uncollidable even though it renders fine — see buildVertexRuns below for
-- how multiple simultaneous layers are threaded into separate shapes.
--
-- WALL tiles get one extra check the others don't: only the TOPMOST
-- EXPOSED wall tile of a stack counts (recorded only if the cell
-- directly above it is empty). Wall tiles are routinely stacked many
-- tiles deep to fill a cliff's solid body (confirmed against
-- tiled/Level1.lua: column 14 is 8 wall tiles stacked solid, rows 14-21,
-- no gaps) — without this check, every one of those buried tiles was
-- ALSO recorded as its own walkable "floor," physically nonsensical
-- (nothing can stand where solid rock is directly overhead), and worse,
-- a buried wall tile several rows down could end up just one row away
-- from an unrelated neighboring column's real shelf, letting the
-- chain-builder connect them into a single shape with a genuine vertical
-- jump in it — since a wall-kind vertex always draws its edges flat at
-- its OWN row (see buildWorldSegments) regardless of what row it's
-- chained from, that jump became a literal straight-up segment, walked
-- via the same arc-length system as everything else, which is what made
-- a character look like they were climbing a ladder up the tile.
--
-- Flat/slope tiles do NOT get this check, deliberately — they're only
-- ever drawn one layer deep by design (a single cap over fill), so a
-- non-empty cell above one is never a sign of being buried under more
-- walkable surface; it's just ordinary terrain, like the decorative
-- overhang tiles some ledges in tiled/Level1.lua actually have directly
-- above them. Applying the wall-only check to these too briefly made
-- every such ledge silently vanish from collision despite still
-- rendering fine.
-- claimedCells (optional): a set of row*width+col keys to skip entirely
-- — used so tiles already absorbed into a ramp-climb shape (see
-- buildRampClimbShape) aren't ALSO picked up here as their own,
-- separate ordinary shape. Without this, a ramp's slope tile and the
-- flat ledge past it would exist as TWO overlapping shapes covering
-- the same physical space, and walking from the ramp-climb shape onto
-- the ordinary one they overlap with would hit the exact "fall off an
-- open path's end, briefly airborne, then re-land" sequence that
-- reads as a hop — the same mechanism a real gap between two
-- genuinely separate shapes triggers on purpose, just here from a
-- seam that shouldn't exist at all.
local function computeTopPointsByColumn(layer, tileProps, width, height, claimedCells)
  local pointsByColumn = {}
  for col = 0, width - 1 do
    local rows = {}
    for row = 0, height - 1 do
      local gid = layer.data[row * width + col + 1] -- Lua 1-based, row-major
      if gid ~= 0 and not (claimedCells and claimedCells[row * width + col]) then
        local role = classifyGid(tileProps, gid)
        if isTopRole(role) then
          -- Exposure check applies ONLY to "wall" — the one role that
          -- gets stacked many tiles deep. Flat/slope tiles are recorded
          -- unconditionally: they're always a single cap layer by design,
          -- so a non-empty cell directly above one is never a sign of
          -- being buried under more walkable surface — it's ordinary
          -- terrain like a decorative overhang tile (a real case in
          -- tiled/Level1.lua: some ledges have a fill tile immediately
          -- above them), and excluding those wrongly made real, walkable
          -- ledges disappear from collision entirely.
          if role ~= "wall" then
            table.insert(rows, { row = row, kind = role })
          else
            local aboveGid = row > 0 and layer.data[(row - 1) * width + col + 1] or 0
            if aboveGid == 0 then
              table.insert(rows, { row = row, kind = role })
            end
          end
        end
      end
    end
    pointsByColumn[col] = rows
  end
  return pointsByColumn
end

-- Threads each column's top points into shapes: a list of open chains is
-- carried left-to-right, each chain extended by whichever point in the
-- next column is within one row (flat or 45-degree step) of its own last
-- point; a chain that finds no match ends and is kept. This lets several
-- stacked layers (a plateau, a shelf below it, a staircase below that)
-- all run concurrently as independent shapes instead of only ever
-- tracking the topmost one. Result: a list of vertex runs, each a list of
-- {col, row, kind} points, same shape buildWorldSegments expects (kind
-- carried straight through unchanged — it's per-tile, not derived from
-- chain adjacency).
--
-- A length-1 chain (an isolated top tile with no same-row neighbor
-- within one column on either side — e.g. a single-tile-wide pillar) is
-- kept too, not discarded: buildWorldSegments turns even one vertex into
-- a real segment (that tile's own left edge to its own right edge), so a
-- length-1 chain is a perfectly good tiny platform, not a degenerate
-- one. Without it, a standalone single-column top (like a thin wall
-- pillar's cap) would have a solid WallShape body but nothing walkable
-- on top: the WallShape push-out (circle-vs-rect, not a landing that
-- sets onSurface) would be all that touched him there, so he'd glide in
-- place on the pillar in the wall-slide pose instead of standing on it.
-- A one-row height change only bridges into the SAME chain when it's an
-- authored 45-degree slope tile (riseLeft/riseRight) on at least one side.
-- Two "flat" (or "wall") tops that happen to sit one row apart — e.g. a
-- raised curb tile beside a sunken lava-floor tile, with no ramp art
-- between them — must NOT auto-connect: that would splice in a sheer
-- vertical segment (one flat tile's edge, immediately followed by the
-- neighboring flat tile's edge one row off) that the walkable path
-- would treat as a climbable "side" of the curb. Real slopes are always explicitly tiled in this project (rampLeft/
-- Right, riseLeft/Right, crestLeft/Right, archLeft/Right all get their own
-- tile), so requiring an explicit rise tile to justify a delta of 1 here
-- doesn't cost any intentional terrain.
local function isRiseKind(kind)
  return kind == "riseLeft" or kind == "riseRight"
end

local function buildVertexRuns(pointsByColumn, width)
  local runs = {}
  local openChains = {}
  for col = 0, width - 1 do
    local entries = pointsByColumn[col] or {}
    local usedRow = {}
    local newOpenChains = {}

    for _, chain in ipairs(openChains) do
      local last = chain[#chain]
      local best, bestDelta = nil, nil
      for _, entry in ipairs(entries) do
        if not usedRow[entry.row] then
          local delta = math.abs(entry.row - last.row)
          local connects = delta == 0 or (delta == 1 and (isRiseKind(last.kind) or isRiseKind(entry.kind)))
          if connects and (not bestDelta or delta < bestDelta) then
            bestDelta = delta
            best = entry
          end
        end
      end
      if best then
        usedRow[best.row] = true
        table.insert(chain, { col = col, row = best.row, kind = best.kind })
        table.insert(newOpenChains, chain)
      else
        table.insert(runs, chain)
      end
    end

    for _, entry in ipairs(entries) do
      if not usedRow[entry.row] then
        table.insert(newOpenChains, { { col = col, row = entry.row, kind = entry.kind } })
      end
    end

    openChains = newOpenChains
  end

  for _, chain in ipairs(openChains) do
    table.insert(runs, chain)
  end
  return runs
end

-- Coalesces a vertex run into straight segments (flat runs and 45-degree
-- runs collapse to one segment each, not one per tile), in WORLD space.
--
-- Each column contributes its own LEFT and RIGHT tile edges rather than a
-- single point at its center — a flat tile's left and right edges are
-- both at its own row, tracing a plain horizontal line; a slope tile's
-- two edges sit at DIFFERENT rows (one tile's own row, the other one row
-- off), exactly which edge is which determined by its `kind` (the tile's
-- own `slope` property — "riseLeft" and "riseRight" tiles anchor to
-- opposite neighbors and are not interchangeable). Consecutive columns'
-- shared edge always lines up exactly, so
-- the duplicate point is simply dropped, leaving a minimal, pixel-accurate
-- polyline with no separate "extend the outer ends" step needed — the
-- first and last points are already true tile edges.
local function buildWorldSegments(vertices, anchorX, anchorY)
  local function worldXY(col, row)
    return anchorX + col * TILE_WORLD_SIZE, anchorY + row * TILE_WORLD_SIZE
  end

  local points = {}
  local function addPoint(x, y)
    local last = points[#points]
    if not last or last.x ~= x or last.y ~= y then
      table.insert(points, { x = x, y = y })
    end
  end

  for _, v in ipairs(vertices) do
    local leftRow, rightRow
    if v.kind == "riseLeft" then
      leftRow, rightRow = v.row, v.row + 1
    elseif v.kind == "riseRight" then
      leftRow, rightRow = v.row + 1, v.row
    else
      leftRow, rightRow = v.row, v.row
    end
    local lx, ly = worldXY(v.col, leftRow)
    addPoint(lx, ly)
    local rx, ry = worldXY(v.col + 1, rightRow)
    addPoint(rx, ry)
  end

  local segments = {}
  local segStart = 1
  for i = 2, #points do
    local prevDx, prevDy = points[i].x - points[i - 1].x, points[i].y - points[i - 1].y
    local nextDx = (i < #points) and (points[i + 1].x - points[i].x) or nil
    local nextDy = (i < #points) and (points[i + 1].y - points[i].y) or nil
    local sameDir = nextDx ~= nil and prevDx == nextDx and prevDy == nextDy
    if not sameDir then
      local a = Vector2.new(points[segStart].x, points[segStart].y)
      local b = Vector2.new(points[i].x, points[i].y)
      local tangent = b:subtract(a):normalize()
      -- rotate tangent -90 degrees for the outward (upward-facing) normal —
      -- matches RoundedRectPlanetoid's own edge convention (dir=(1,0) -> normal=(0,-1))
      local normal = Vector2.new(tangent.y, -tangent.x):normalize()
      table.insert(segments, {
        a = a, b = b, tangent = tangent, normal = normal,
        length = b:subtract(a):length(),
      })
      segStart = i
    end
  end
  return segments
end

local function newShape(segments)
  local self = setmetatable({}, TerrainShape)
  self.segments = segments
  self.totalLength = 0
  for _, seg in ipairs(segments) do self.totalLength = self.totalLength + seg.length end

  self.isRoundedRect = true
  self.isImmovable = true
  self.isPermanent = true
  self.isPullExempt = true
  self.isOpenPath = true
  self.forceUprightJump = true
  self.vel = Vector2.new(0, 0)
  self.mass = 1e9

  -- Bounding circle + halfHeight, for generic code that expects every
  -- planetoid-like object to have these (e.g. utils.isOnScreen culling,
  -- and CollisionSystem:handleImmovableCollisions, which unconditionally
  -- computes `im.pos.y - im.halfHeight` for ANY isRoundedRect immovable
  -- before checking whether nearestDomeSurfacePoint/nearestBaseSurfacePoint
  -- even exist — omitting halfHeight would crash that call, not just
  -- silently skip a branch).
  local minX, maxX, minY, maxY = math.huge, -math.huge, math.huge, -math.huge
  for _, seg in ipairs(segments) do
    for _, p in ipairs({ seg.a, seg.b }) do
      minX = math.min(minX, p.x); maxX = math.max(maxX, p.x)
      minY = math.min(minY, p.y); maxY = math.max(maxY, p.y)
    end
  end
  local cx, cy = (minX + maxX) / 2, (minY + maxY) / 2
  self.pos = Vector2.new(cx, cy)
  self.halfHeight = math.max(1, (maxY - minY) / 2)
  local radius = 0
  for _, seg in ipairs(segments) do
    for _, p in ipairs({ seg.a, seg.b }) do
      radius = math.max(radius, p:subtract(self.pos):length())
    end
  end
  self.radius = math.max(1, radius)
  self:refreshBounds()

  return self
end

-- A walkable surface that moves — one straight segment from a to b,
-- walked on (left to right, its open side up) like any other ledge, put
-- wherever it is each frame with :moveTo. E.g. the top of a rock swinging
-- on a rope (see lua/world/RopeRock.lua). Anyone standing on it rides
-- along, since a stood-on surface's position is read fresh every frame.
function TiledTerrain.newMovingSurface(ax, ay, bx, by)
  local seg = { a = Vector2.new(ax, ay), b = Vector2.new(bx, by), length = 0 }
  local shape = newShape({ seg })
  shape:moveTo(ax, ay, bx, by)
  return shape
end

function TerrainShape:moveTo(ax, ay, bx, by)
  local seg = self.segments[1]
  -- (Where it was a moment ago, for findLandingCrossing: a surface rising
  -- into someone falling onto it would otherwise already be past where
  -- they were last frame, and they'd fall straight through it.)
  seg.prevA = seg.prevA or Vector2.new(0, 0)
  seg.prevA.x, seg.prevA.y = seg.a.x, seg.a.y
  seg.prevNormal = seg.normal or Vector2.new(0, -1)
  seg.a.x, seg.a.y, seg.b.x, seg.b.y = ax, ay, bx, by
  local dx, dy = bx - ax, by - ay
  local len = math.max(1e-6, math.sqrt(dx * dx + dy * dy))
  seg.length = len
  seg.tangent = Vector2.new(dx / len, dy / len)
  seg.normal = Vector2.new(dy / len, -dx / len) -- (the tangent turned -90 degrees: up, for a left-to-right one)
  self.totalLength = len
  self.pos.x, self.pos.y = (ax + bx) / 2, (ay + by) / 2
  self.halfHeight = math.max(1, math.abs(dy) / 2)
  self.radius = math.max(1, len / 2)
  self.boundX, self.boundY, self.boundRadius = self.pos.x, self.pos.y, len / 2
end

return {
  computeTopPointsByColumn = computeTopPointsByColumn,
  buildVertexRuns = buildVertexRuns,
  buildWorldSegments = buildWorldSegments,
  newShape = newShape,
  api = TiledTerrain,
}
