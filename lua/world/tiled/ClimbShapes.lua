-- lua/world/tiled/ClimbShapes.lua
--
-- Wall-climb shapes: ramp-to-wall climbs, convex climbs, and joining them
-- up into loops.
-- Part of the Tiled level loader: see lua/world/TiledTerrain.lua.

local Vector2 = require("lua.vector2")
local Tiles = require("lua.world.tiled.Tiles")
local TILE_WORLD_SIZE = Tiles.TILE_WORLD_SIZE
local classifyGid = Tiles.classifyGid
local TerrainShapePart = require("lua.world.tiled.TerrainShape")
local newShape = TerrainShapePart.newShape

----------------------------------------------------------------------
-- Ramp-to-wall climbs (rampRight/rampLeft)
----------------------------------------------------------------------
-- See classifyGid's own comment for why these need a shape builder of
-- their own instead of just being more "top" tiles: the ordinary
-- per-column scan above can only ever describe one floor height per
-- column (a hill/ramp profile), capping any chain it produces at 45
-- degrees of average rise — nowhere near enough for a curve that ends
-- up fully vertical. This builds one explicit, hand-computed path per
-- authored ramp tile instead: a quarter-circle arc exactly inscribed
-- in that ONE tile's own 64x64 box (matching the tile's own art,
-- confirmed against how it's actually drawn — see buildRampClimbShape
-- below for exactly which corner the arc centers on), continuing
-- straight up whatever "wall"-role stack sits directly above it, then
-- picking up one ordinary 45-degree slope tile if one caps that stack.
-- Past that point, flat ledge tiles are picked up by the ordinary scan
-- above just fine on their own — the hand-off is seamless because
-- flat ground's own normal (straight up) is identical whether this
-- shape or the ordinary ("forceUprightJump") one computed it.
--
-- forceUprightJump is explicitly turned OFF on these shapes (unlike
-- every ordinary TerrainShape) — see Player:visualDownDirection and
-- TerrainShape:worldPointAtArcPosition, both of which branch on it —
-- so orientation and the walking push-offset both follow the path's
-- true local normal instead of staying locked vertical: upright on
-- the flat approach, rotating through the curve, fully sideways
-- climbing the wall, tilting back through the slope, and upright
-- again the instant it reaches flat ground — all as a direct
-- consequence of the geometry, no special-cased snap anywhere.
--
-- The "wall"-role tiles this climbs are completely unaffected by any
-- of this — buildWallShapes still turns them into their own solid
-- rects exactly as it always has, so jumping into one from the side
-- and wall-jumping off it keeps working independently of this
-- walkable path sharing the same physical space.
----------------------------------------------------------------------

local RAMP_ARC_SEGMENTS = 10 -- straight segments approximating the quarter-circle — fine enough that the rotation (see above) reads as a smooth sweep, not a visible facet

-- Builds the full climb path for one ramp tile at (col, row). dir = 1
-- for rampRight (ledge below-left, wall above-right, path runs overall
-- left-to-right), dir = -1 for rampLeft (mirrored: ledge below-right,
-- wall above-left, path runs overall right-to-left).
--
-- The arc is centered on whichever corner of the tile's own box sits
-- on the curve's "inside" (open-air) side — top-left for rampRight,
-- top-right for rampLeft — sweeping from the tangent-HORIZONTAL point
-- (matching the flat ledge below) to the tangent-VERTICAL point
-- (matching the wall above). Its normal is derived straight from the
-- true circle center (always points TOWARD it — that's the open-air
-- side, verified directly against the geometry: the corner the arc
-- centers on is exactly the corner left empty in the tile's own art).
-- That "toward center" rule is direction-agnostic, so unlike the
-- straight wall/slope segments past the arc it needs no `dir`
-- adjustment of its own.
--
-- The straight portions (wall, and the one slope tile if present)
-- reuse the same rotate-the-tangent convention every other
-- TerrainShape segment uses (buildWorldSegments) — but mirrored by
-- `dir`, since walking rampLeft's path traverses each tile's own
-- left/right edges in the OPPOSITE order the ordinary left-to-right
-- column scan assumes, and rotating a reversed tangent by the
-- standard formula gives the reversed (wrong-side) normal unless that
-- reversal is compensated for here.
-- Returns shape, claimedCells — claimedCells is a set (row*width+col ->
-- true) of every tile this shape absorbed (wall stack, slope, and the
-- flat ledge run past it), for the caller to exclude from
-- computeTopPointsByColumn. See that function's own comment for why:
-- without this, a tile like the slope (unconditionally picked up by
-- the ordinary column scan, no exposure check the way "wall" gets)
-- would end up covered by TWO overlapping shapes, and the seam between
-- them reads as a hop.
-- Mirrors buildRampClimbShape's own "wall curving into a ceiling" cap
-- (see that function's own capRole=="ceilingLeft"/"ceilingRight" branch,
-- and buildConvexClimbShape's own arch-cap branch) turned upside down.
-- Called when a ceiling-backing run STOPS and finds a ceilingLeft/
-- ceilingRight tile one row below (see that run's own "belowGid" check)
-- that isn't already owned by some other independently-anchored ramp
-- shape. Previously the run just assumed one must exist elsewhere and
-- set continuesAtKey hoping to find it via capOwnerByKey — fine for the
-- classic "two ramps meet mid-ceiling" case, but wrong when what's
-- actually there is a ceiling dipping down into a walled archway with no
-- separate ramp anchoring it at all: nothing would ever own that key, and
-- the path would just dead-end.
--
-- This instead treats that ceilingLeft/ceilingRight tile as a genuine END
-- cap in its own right: curves DOWN off of it into a wall descending in
-- the adjacent column (wallCol = capCol + dir — exactly the relationship
-- buildRampClimbShape's own START cap uses, just discovered here instead
-- of searched for), and if that wall bottoms out onto an archLeft/
-- archRight tile, curves into that arch and starts a fresh underside run
-- past it — continuing in the SAME direction the ceiling run was already
-- traveling (this is a bridge continuing the same journey forward, unlike
-- buildConvexClimbShape's own underside run, which doubles back under a
-- single free-standing block since there's nothing beyond it to reach).
--
-- Returns nil if there's no wall-into-arch structure there at all (the
-- ordinary two-ramps-meet-directly case, where the caller's own existing
-- continuesAtKey fallback still applies unchanged) — or a table
-- describing the new points to append plus enough bookkeeping for the
-- caller to classify the new segments and know where to look for a
-- further link onward (continuesAtKey, same meaning as everywhere else in
-- this file).
--
-- startPoint: the run's own last point before it stopped — already
-- sitting exactly on this cap tile's own near corner (see the caller).
-- capRow/capCol: the ceilingLeft/ceilingRight tile's own grid position.
-- capRole: its own slope string, deciding which side the wall descends on
-- (mirrors how it decides which side a START cap's wall climbs up on).
local function tryDescendCeilingCapToArch(layer, tileProps, width, height, anchorX, anchorY, capRow, capCol, capRole, startPoint)
  local T = TILE_WORLD_SIZE
  local dirCap = (capRole == "ceilingLeft" and 1) or (capRole == "ceilingRight" and -1)
  if not dirCap then return nil end

  local wallCol = capCol + dirCap
  if wallCol < 0 or wallCol >= width then return nil end

  -- Same edge convention buildRampClimbShape's own wallEdgeX uses: the
  -- side of the wall column facing back toward the cap tile (and thus
  -- the open ceiling territory the run just came from).
  local wallEdgeX = anchorX + (dirCap > 0 and wallCol or (wallCol + 1)) * T

  -- Scan DOWNWARD (mirrors buildRampClimbShape's own upward wall search)
  -- for contiguous "wall"-role tiles starting one row below the cap.
  -- Left at capRow (a zero-height wall) when none are found — same
  -- "wall stack is entirely optional" tolerance buildConvexClimbShape's
  -- own arch-cap check already has.
  local wallBottomRow = capRow
  do
    local r = capRow + 1
    while r < height do
      local gid = layer.data[r * width + wallCol + 1]
      if gid == 0 or classifyGid(tileProps, gid) ~= "wall" then break end
      wallBottomRow = r
      r = r + 1
    end
  end

  local archRow = wallBottomRow + 1
  local archCol = wallCol
  if archRow >= height then return nil end
  local archGid = layer.data[archRow * width + archCol + 1]
  local archRole = archGid ~= 0 and classifyGid(tileProps, archGid) or "empty"
  if archRole ~= "archLeft" and archRole ~= "archRight" then return nil end

  local claimed = {}
  local newPoints = {}

  -- First arc: ceiling cap's own corner (startPoint, already sitting
  -- exactly on it) curving down to the wall's own top tangent point.
  -- Center sits directly below startPoint, one tile down — a fresh
  -- derivation (this arc runs the opposite way from buildRampClimbShape's
  -- own cap arc, ceiling into wall rather than wall into ceiling), but
  -- confirmed against the tile corners it has to land on exactly the same
  -- way that function's own header comment confirms its own arcs.
  local center1 = Vector2.new(startPoint.x, anchorY + (capRow + 1) * T)
  -- "Start" markers below all follow the same convention capArcStart/
  -- ceilingRunStart use in buildRampClimbShape itself: the index of the
  -- point BEFORE the new range begins (here, since startPoint lives in
  -- the CALLER's own points array, not in newPoints, that's simply
  -- newPoints' current length, with no adjustment) — not the first new
  -- point's own index.
  local arc1Start = #newPoints
  for i = 1, RAMP_ARC_SEGMENTS do
    local t = i / RAMP_ARC_SEGMENTS
    local theta = -math.pi / 2 + dirCap * (math.pi / 2) * t
    table.insert(newPoints, Vector2.new(center1.x + T * math.cos(theta), center1.y + T * math.sin(theta)))
  end
  local arc1End = #newPoints

  -- Wall segment (may end up zero-length, when the arch cap sits
  -- directly beneath the ceiling cap with no plain wall tile between —
  -- harmless, the segment built from it later just has zero length).
  for r = capRow + 1, wallBottomRow do
    claimed[r * width + wallCol] = true
  end
  local wallSegIndex = #newPoints
  table.insert(newPoints, Vector2.new(wallEdgeX, anchorY + (wallBottomRow + 1) * T))

  -- Second arc: wall's own bottom tangent curving into the arch tile's
  -- own underside tangent. NOT the same construction as the first arc:
  -- arc1 enters with a HORIZONTAL tangent (the ceiling run), so its
  -- center sits directly below the entry point (same x, offset in y).
  -- This arc enters with a VERTICAL tangent instead (the wall segment
  -- just above it), so the center has to be offset the OTHER way — same
  -- y as the entry point, offset by T in x — or the "radius perpendicular
  -- to tangent" relationship a circle needs doesn't hold at all.
  --
  -- It's also convex rather than concave: the wall material genuinely
  -- fills the block sitting between the two walls at this row (confirmed
  -- against the real tile data — both wall columns carry a "wall" tile at
  -- the same row here), so the center sits ON the material side, at the
  -- corner shared between this archLeft/archRight tile and its mirror
  -- image on the far side of the notch, and the curve bulges AWAY from
  -- it — hugging the visible grass edge instead of cutting a chord
  -- straight through the middle of it.
  local entry2 = newPoints[#newPoints]
  local center2 = Vector2.new(entry2.x + dirCap * T, entry2.y)
  local entryTheta2 = dirCap > 0 and math.pi or 0
  local arc2Start = #newPoints
  for i = 1, RAMP_ARC_SEGMENTS do
    local t = i / RAMP_ARC_SEGMENTS
    local theta = entryTheta2 - dirCap * (math.pi / 2) * t
    table.insert(newPoints, Vector2.new(center2.x + T * math.cos(theta), center2.y + T * math.sin(theta)))
  end
  local arc2End = #newPoints
  claimed[archRow * width + archCol] = true

  -- Underside run: stops the instant it isn't "wall"-backed anymore
  -- (exactly like every other absorption run in this file), checking for
  -- a same-row archLeft/archRight partner to hand off to via
  -- continuesAtKey the same way buildConvexClimbShape's own underside run
  -- already does — that partner is normally the mirror-image descent of
  -- whichever OTHER ceiling run is coming from the far side of this same
  -- archway, landing on the immediately adjacent arch tile.
  local runStart = #newPoints
  local continuesAtKey = nil
  local fc = archCol + dirCap
  while fc >= 0 and fc < width do
    local fgid = layer.data[archRow * width + fc + 1]
    if fgid == 0 or classifyGid(tileProps, fgid) ~= "wall" then
      if fgid ~= 0 then
        local hitRole = classifyGid(tileProps, fgid)
        if hitRole == "archLeft" or hitRole == "archRight" then
          continuesAtKey = archRow * width + fc
        end
      end
      break
    end
    claimed[archRow * width + fc] = true
    local edgeCol = dirCap > 0 and (fc + 1) or fc
    table.insert(newPoints, Vector2.new(anchorX + edgeCol * T, anchorY + (archRow + 1) * T))
    fc = fc + dirCap
  end
  return {
    points = newPoints,
    center1 = center1, arc1Start = arc1Start, arc1End = arc1End,
    wallSegIndex = wallSegIndex,
    center2 = center2, arc2Start = arc2Start, arc2End = arc2End,
    runStart = runStart,
    claimed = claimed,
    ownCapTileKey2 = archRow * width + archCol,
    continuesAtKey = continuesAtKey,
    dirCap = dirCap,
  }
end

local function buildRampClimbShape(layer, tileProps, width, height, anchorX, anchorY, col, row, dir)
  local T = TILE_WORLD_SIZE
  local x0 = anchorX + col * T
  local y0 = anchorY + row * T
  local claimedCells = {}

  local centerX = dir > 0 and x0 or (x0 + T)
  local centerY = y0
  local center = Vector2.new(centerX, centerY)

  local thetaLedge = math.pi / 2
  local thetaWall = dir > 0 and 0 or math.pi

  local points = {}
  for i = 0, RAMP_ARC_SEGMENTS do
    local t = i / RAMP_ARC_SEGMENTS
    local theta = thetaLedge + (thetaWall - thetaLedge) * t
    table.insert(points, Vector2.new(centerX + T * math.cos(theta), centerY + T * math.sin(theta)))
  end
  local arcSegmentCount = #points - 1

  -- Wall column: directly above-right (rampRight) or above-left
  -- (rampLeft) of the ramp tile, per this feature's own authoring
  -- convention (see this file's header comment / classifyGid). Walks
  -- upward counting contiguous "wall"-role tiles to find where the
  -- stack actually ends.
  local wallCol = dir > 0 and (col + 1) or (col - 1)
  local wallTopRow = nil
  do
    local r = row - 1
    while r >= 0 do
      local gid = layer.data[r * width + wallCol + 1]
      if gid == 0 or classifyGid(tileProps, gid) ~= "wall" then break end
      wallTopRow = r
      claimedCells[r * width + wallCol] = true
      r = r - 1
    end
  end

  local wallSegIndex = nil
  -- Set only when this shape's own ceiling run dips down into a wall and
  -- an archLeft/archRight cap (see tryDescendCeilingCapToArch below) —
  -- the second, symmetric set of the same bookkeeping ceilingRunStart's
  -- own cap arc gets, just one bend further along the path.
  local descentCenter1, descentArc1Start, descentArc1End = nil, nil, nil
  local descentWallSegIndex = nil
  local descentCenter2, descentArc2Start, descentArc2End = nil, nil, nil
  local descentRunStart = nil
  local descentDirCap = nil
  local secondaryCapTileKey = nil
  -- Set only when a ceilingLeft/ceilingRight cap is found below — a
  -- SECOND arc, with its own center, distinct from the base arc above.
  local capCenter, capArcStart, capArcEnd = nil, nil, nil
  -- Set only alongside a ceiling cap too — the point index the flat-run
  -- absorption starts inserting from, when (and only when) that run is
  -- the ceiling's own solid backing (absorbRole == "wall") rather than
  -- an ordinary ground-level ledge (absorbRole == "flat"). Segments from
  -- here to the end of the shape, PLUS the cap arc itself, are "the
  -- ceiling" for Player.lua's own isCeiling detach check below.
  local ceilingRunStart = nil
  -- This shape's OWN cap tile position (row*width+col), set only when a
  -- ceilingLeft/ceilingRight cap was actually built above. Exposed on
  -- the finished shape so linkAndMergeWallClimbShapes (below) can look
  -- up "which shape owns the cap tile at this grid position" when some
  -- OTHER shape's ceiling run runs straight into it.
  local ownCapTileKey = nil
  -- Set only when this shape's OWN ceiling-backing absorption run (see
  -- below) stops because it ran straight into ANOTHER wall-climb
  -- shape's cap tile, rather than a genuine gap or unrelated feature —
  -- i.e. two ramps authored to form one continuous loop, meeting
  -- mid-ceiling (see linkAndMergeWallClimbShapes). Grid position
  -- (row*width+col) of that OTHER shape's own cap tile.
  local continuesAtKey = nil

  if wallTopRow then
    local wallEdgeX = dir > 0 and (anchorX + wallCol * T) or (anchorX + (wallCol + 1) * T)
    table.insert(points, Vector2.new(wallEdgeX, anchorY + wallTopRow * T))
    -- The segment this point just closed off (from the arc's own last
    -- point to here) is THE wall face — exactly one segment, however
    -- many tiles tall the stack actually is. Recorded now, by index,
    -- rather than inferred later from steepness — the slope segment
    -- right after this is ALSO steep (nonzero tangent.y), and detach
    -- (see Player.lua's own isWallFace check) needs to apply to the
    -- wall specifically, not the curve or the slope.
    wallSegIndex = #points - 1

    -- Where the run that follows (absorbed below) starts from:
    -- directly above the wall stack, same column, ONE row up, unless a
    -- slope or ceiling cap is found (handled just below, which
    -- overrides these to wherever that cap's own "continuing" edge
    -- lands instead).
    local flatCol, flatRow = wallCol, wallTopRow - 1
    local absorbRole = "flat"  -- what the run's tiles need to classify as; "wall" once past a ceiling cap
    local absorbDir = dir      -- which way the run continues; flips (-dir) past a ceiling cap

    -- One ordinary 45-degree slope tile (same column as the wall stack,
    -- wallCol), OR a ceilingLeft/ceilingRight cap (one column BACK
    -- toward the base ramp instead — wallCol - dir — matching how the
    -- ramp tile itself sits diagonally off its own wall rather than
    -- stacked on it).
    local capRow = wallTopRow - 1
    local capCol = wallCol - dir
    if capRow >= 0 then
      local slopeGid = layer.data[capRow * width + wallCol + 1]
      local slopeRole = slopeGid ~= 0 and classifyGid(tileProps, slopeGid) or "empty"
      local ceilGid = layer.data[capRow * width + capCol + 1]
      local ceilRole = ceilGid ~= 0 and classifyGid(tileProps, ceilGid) or "empty"
      local capRole = (slopeRole == "riseLeft" or slopeRole == "riseRight") and slopeRole or ceilRole

      if capRole == "riseLeft" or capRole == "riseRight" then
        -- Reuses the exact same left/right-edge convention
        -- buildWorldSegments uses for riseLeft/riseRight, so it
        -- behaves identically to any other slope tile in the map. A
        -- slope tile's "high" edge lands at ITS OWN row (not the row
        -- above — a 45 tile's art reaches the same height as the row
        -- it's drawn in on one side), in the NEXT column over, which
        -- is where the run below actually starts from in this branch.
        claimedCells[capRow * width + wallCol] = true
        local leftRow, rightRow
        if capRole == "riseLeft" then
          leftRow, rightRow = capRow, capRow + 1
        else
          leftRow, rightRow = capRow + 1, capRow
        end
        local leftPt = Vector2.new(anchorX + wallCol * T, anchorY + leftRow * T)
        local rightPt = Vector2.new(anchorX + (wallCol + 1) * T, anchorY + rightRow * T)
        if dir > 0 then
          table.insert(points, leftPt)
          table.insert(points, rightPt)
          flatCol, flatRow = wallCol + 1, rightRow
        else
          table.insert(points, rightPt)
          table.insert(points, leftPt)
          flatCol, flatRow = wallCol, leftRow
        end

      elseif capRole == (dir > 0 and "ceilingLeft" or "ceilingRight") then
        -- (Only the cap that curves back over the ramp — ceilingLeft over
        -- a rampRight, ceilingRight over a rampLeft — makes a loop. The
        -- other way round, it's the far side of a ball tunnel turning
        -- from a shaft into a passage, not a ceiling to run along.)
        -- Continues the wall PAST vertical into a ceiling, instead of
        -- stopping at a 45-degree slope. Unlike the base arc, this
        -- curve's center is NOT one of the cap tile's own four corners
        -- — a quarter-circle that (a) starts EXACTLY at the wall's own
        -- established climbing point (wallEdgeX, set above, already
        -- fixed) with a vertical tangent there, and (b) has the same
        -- open-air side the wall already does, only works out to a
        -- center one full tile-width off to the side, in the direction
        -- the ceiling continues (opposite `dir` — a wall climbed via
        -- rampRight naturally continues into a ceiling running back
        -- to the left, i.e. "ceilingLeft"). That center, and both ends
        -- of this arc, land exactly on this cap tile's (capCol, capRow)
        -- own corners — see the run absorption below, which starts
        -- from the far corner.
        claimedCells[capRow * width + capCol] = true
        ownCapTileKey = capRow * width + capCol
        local ccx = wallEdgeX - dir * T
        local ccy = anchorY + wallTopRow * T
        capCenter = Vector2.new(ccx, ccy)
        capArcStart = #points
        -- Continues sweeping in the SAME angular direction the base arc
        -- above was already sweeping (thetaLedge -> thetaWall) — another
        -- quarter turn past thetaWall. That sweep is -pi/2 (decreasing)
        -- for rampRight/ceilingLeft (dir>0) but +pi/2 (increasing) for
        -- rampLeft/ceilingRight (dir<0), so this has to mirror by dir
        -- the same way the base arc's own thetaWall does — a hardcoded
        -- -pi/2 here only ever swept the right way for one of the two.
        for i = 1, RAMP_ARC_SEGMENTS do
          local t = i / RAMP_ARC_SEGMENTS
          local theta = thetaWall + (thetaWall - thetaLedge) * t
          table.insert(points, Vector2.new(ccx + T * math.cos(theta), ccy + T * math.sin(theta)))
        end
        capArcEnd = #points

        -- The ceiling material is ABOVE the walkway line now, not
        -- below it — the run's own row is one above where the curve
        -- landed, and it's tagged "wall" (this project's usual
        -- solid-on-every-side role — see classifyGid), not "flat".
        -- Continues opposite the original climb direction, starting
        -- one column past the cap tile itself (capCol - dir).
        flatCol, flatRow = capCol - dir, capRow - 1
        absorbRole = "wall"
        absorbDir = -dir
      end
    end

    -- A ball tunnel's inner corner (an *Inner tile — a "wall", see
    -- classifyGid) topping the stack, with open tunnel above it: the
    -- walkway runs on across the corner's own top, onto the ground beside
    -- it at that height (the tunnel turning from the shaft into a passage).
    local runStartsOnStackTop = false
    if absorbRole == "flat" and flatCol == wallCol and flatRow == wallTopRow - 1 and flatRow >= 0
       and (layer.data[flatRow * width + wallCol + 1] or 0) == 0 then
      local topProps = tileProps[layer.data[wallTopRow * width + wallCol + 1]]
      if topProps and topProps.slope and topProps.slope:find("Inner$") then
        flatRow = wallTopRow
        runStartsOnStackTop = true
      end
    end

    -- Absorb the run that follows, all the way to its TRUE end (a gap,
    -- wall, or other feature) — not just a tile or two. This shape
    -- needs to BE the complete continuation for that stretch, so
    -- nothing is left over for the ordinary scan to pick up separately
    -- (which would just relocate the seam a few tiles down instead of
    -- removing it). Same absorption loop for the ordinary ground-flat
    -- case and the ceiling case above — only which role counts as
    -- "still going" (absorbRole), which way it continues (absorbDir),
    -- and which edge of the checked row the line actually sits on
    -- differ: "flat" ground is walked ON TOP of (line at the row's own
    -- top edge, flatRow * T), while "wall" ceiling material is walked
    -- UNDER (line at the row's bottom edge, (flatRow+1) * T — the same
    -- edge the cap arc's own last point already landed on).
    if flatRow >= 0 then
      local rowEdge = (absorbRole == "wall") and (flatRow + 1) or flatRow
      if absorbRole == "wall" then ceilingRunStart = #points end
      local fc = flatCol
      if runStartsOnStackTop then
        -- (Across the corner's own top first — it's the stack's, already claimed.)
        table.insert(points, Vector2.new(anchorX + (absorbDir > 0 and (fc + 1) or fc) * T, anchorY + flatRow * T))
        fc = fc + absorbDir
      end
      while fc >= 0 and fc < width do
        local fgid = layer.data[flatRow * width + fc + 1]
        if fgid == 0 or classifyGid(tileProps, fgid) ~= absorbRole then
          -- Ceiling backing (never the ordinary ground-level "flat" run)
          -- stopping here because the tile directly BELOW this scan row
          -- is another cap tile means this shape's own ceiling run has
          -- reached exactly where a second wall-climb shape's cap
          -- begins — the two were authored to meet here and continue as
          -- one loop. Recording that cap's grid position lets
          -- linkAndMergeWallClimbShapes stitch the two shapes into a
          -- single continuous path afterward, once every shape in the
          -- level exists to look up.
          --
          -- Checks BOTH cap families, not just this shape's own
          -- (ceilingLeft/ceilingRight) — a flat ceiling run doesn't care
          -- whether the wall on the far side of the cap it reaches goes
          -- UP (another concave shape) or DOWN (a convex
          -- buildConvexClimbShape one, archLeft/archRight): both
          -- present the exact same "normal points down, now curve
          -- toward a wall" orientation where a plain run reaches them,
          -- so either is a valid splice point.
          --
          -- The two families sit on DIFFERENT rows relative to this
          -- scan, though, and checking only one misses the other: a
          -- concave cap (ceilingLeft/ceilingRight) sits ONE ROW BELOW
          -- its own backing (this shape's own convention, hence
          -- flatRow+1 below), but a convex cap (archLeft/archRight)
          -- sits at the SAME row as its own backing (see
          -- buildConvexClimbShape's own header comment) — so it shows
          -- up as the tile THIS run just broke on (fgid itself), not a
          -- neighbor row.
          if absorbRole == "wall" then
            if fgid ~= 0 then
              local sameRowRole = classifyGid(tileProps, fgid)
              if sameRowRole == "archLeft" or sameRowRole == "archRight" then
                continuesAtKey = flatRow * width + fc
              end
            end
            if not continuesAtKey then
              local belowGid = layer.data[(flatRow + 1) * width + fc + 1]
              if belowGid and belowGid ~= 0 then
                local belowRole = classifyGid(tileProps, belowGid)
                if belowRole == "ceilingLeft" or belowRole == "ceilingRight" then
                  -- Found a ceilingLeft/ceilingRight tile one row below —
                  -- before assuming some OTHER independently-anchored
                  -- ramp shape owns it, first try treating IT as a
                  -- genuine end cap of THIS shape: curving down into a
                  -- wall and, if one's there, an archLeft/archRight cap
                  -- beyond it (see tryDescendCeilingCapToArch's own header
                  -- comment for why a ceiling can't otherwise dip into an
                  -- archway without a separate crestLeft/crestRight tile
                  -- to anchor it). Otherwise (no wall/arch there — the
                  -- ordinary case of two ramps meeting directly),
                  -- continuesAtKey points at this tile, for capOwnerByKey
                  -- to resolve.
                  local descentCapRow = flatRow + 1
                  local descent = tryDescendCeilingCapToArch(
                    layer, tileProps, width, height, anchorX, anchorY,
                    descentCapRow, fc, belowRole, points[#points])
                  if descent then
                    local baseIndex = #points
                    for _, p in ipairs(descent.points) do
                      table.insert(points, p)
                    end
                    descentCenter1 = descent.center1
                    descentArc1Start = baseIndex + descent.arc1Start
                    descentArc1End = baseIndex + descent.arc1End
                    descentWallSegIndex = baseIndex + descent.wallSegIndex
                    descentCenter2 = descent.center2
                    descentArc2Start = baseIndex + descent.arc2Start
                    descentArc2End = baseIndex + descent.arc2End
                    descentRunStart = descent.runStart and (baseIndex + descent.runStart) or nil
                    descentDirCap = descent.dirCap
                    for key in pairs(descent.claimed) do claimedCells[key] = true end
                    secondaryCapTileKey = descent.ownCapTileKey2
                    continuesAtKey = descent.continuesAtKey
                  else
                    continuesAtKey = (flatRow + 1) * width + fc
                  end
                end
              end
            end
          end
          break
        end
        claimedCells[flatRow * width + fc] = true
        local edgeCol = absorbDir > 0 and (fc + 1) or fc
        table.insert(points, Vector2.new(anchorX + edgeCol * T, anchorY + rowEdge * T))
        fc = fc + absorbDir
      end
    end
  end

  if #points < 2 then return nil end

  local segments = {}
  for i = 1, #points - 1 do
    local a, b = points[i], points[i + 1]
    local tangent = b:subtract(a):normalize()
    local normal
    local isDescentArc1 = descentArc1Start and i >= descentArc1Start and i < descentArc1End
    local isDescentArc2 = descentArc2Start and i >= descentArc2Start and i < descentArc2End
    if i <= arcSegmentCount then
      local mid = (a + b) * 0.5
      normal = center:subtract(mid):normalize()
    elseif capArcStart and i >= capArcStart and i < capArcEnd then
      local mid = (a + b) * 0.5
      normal = capCenter:subtract(mid):normalize()
    elseif isDescentArc1 then
      local mid = (a + b) * 0.5
      normal = descentCenter1:subtract(mid):normalize()
    elseif isDescentArc2 then
      -- Convex, unlike every other arc in this file — see
      -- tryDescendCeilingCapToArch's own comment on descentCenter2: the
      -- center sits on the material side here, so the normal points AWAY
      -- from it instead of toward it.
      local mid = (a + b) * 0.5
      normal = mid:subtract(descentCenter2):normalize()
    elseif i == descentWallSegIndex then
      -- Away from the solid wall column: wallCol = capCol + descentDirCap
      -- (see tryDescendCeilingCapToArch), so the material sits on the
      -- descentDirCap side and the open-air/climbable normal points the
      -- opposite way — the vertical-mirror counterpart of the ordinary
      -- ascending wallSegIndex segment's own -dir normal.
      normal = Vector2.new(-descentDirCap, 0)
    elseif descentRunStart and i >= descentRunStart then
      -- Underside run past the arch: material's above, open air's below,
      -- regardless of which way the run travels (same reasoning
      -- buildConvexClimbShape's own underside run uses).
      normal = Vector2.new(0, 1)
    else
      normal = Vector2.new(dir * tangent.y, -dir * tangent.x)
    end
    local isCapArc = capArcStart and i >= capArcStart and i < capArcEnd
    local isCeilingRun = ceilingRunStart and i >= ceilingRunStart
    table.insert(segments, {
      a = a, b = b, tangent = tangent, normal = normal,
      length = b:subtract(a):length(),
      isWallFace = (i == wallSegIndex) or (i == descentWallSegIndex),
      -- The ceiling cap arc (the ceilingLeft/ceilingRight tile itself)
      -- AND the flat run past it (the ceiling's own solid backing) —
      -- see Player.lua's own isCeiling check, which detaches on a stop
      -- OR a reversal here (unlike the wall face, which only detaches
      -- on a reversal — standing still on a WALL is fine, standing on
      -- open ceiling with nothing but a curve holding you up isn't).
      -- The descent arcs/run (dipping into an archway mid-shape) are the
      -- same kind of "nothing but a curve holding you up" overhead
      -- surface, so they're tagged isCeiling too.
      isCeiling = isCapArc or isCeilingRun or isDescentArc1 or isDescentArc2
        or (descentRunStart and i >= descentRunStart),
    })
  end

  local shape = newShape(segments)
  shape.forceUprightJump = false
  -- See linkAndMergeWallClimbShapes below: ownCapTileKey lets another
  -- shape's ceiling run find and merge into THIS one; continuesAtKey is
  -- the reverse — set when THIS shape's own ceiling run ran into some
  -- other shape's cap. ceilingRunStartSegment marks where this shape's
  -- own absorbed ceiling backing begins (in segment-index terms, same
  -- convention isCeilingRun above already uses) — the part that gets
  -- discarded, not duplicated, when this shape is merged in as the
  -- "other" side of a seam (its own backing run would just retrace
  -- ground the first shape's run already covered from the far end).
  shape.ownCapTileKey = ownCapTileKey
  shape.continuesAtKey = continuesAtKey
  shape.ceilingRunStartSegment = ceilingRunStart
  -- Set only when this shape's own ceiling run dipped down into a wall
  -- and an archLeft/archRight cap mid-shape (see
  -- tryDescendCeilingCapToArch) — a second position this same shape can
  -- be found by (linkAndMergeWallClimbShapes registers both), and a
  -- marker telling mergeWallClimbShapes that this shape's own absorbed
  -- run (everything from ceilingRunStartSegment onward) is genuinely new
  -- geometry a merge partner needs to keep, not a redundant retrace of
  -- ground the OTHER side of the merge already covered the way a plain
  -- ceiling run meeting another ramp's cap directly would be.
  shape.secondaryCapTileKey = secondaryCapTileKey
  shape.hasDescent = secondaryCapTileKey ~= nil
  -- Marks this as a ramp-climb shape for every other system that needs
  -- to treat it differently from ordinary terrain: getArcSpeedMultiplier
  -- (no uphill penalty — this is meant to run at full speed), main.lua's
  -- Ooomba-spawning loop (skipped — see that file's own comment), and
  -- Player.lua's own move() (detaches the player if they're not
  -- actively climbing, Sonic-loop style, instead of leaving them glued
  -- to a wall regardless of input).
  shape.isWallClimb = true
  -- Arc length increases in the direction the path was swept above,
  -- which is always "toward the wall" — but which PHYSICAL key drives
  -- that depends on which side the wall is on. rampRight's wall sits to
  -- the right of its ground entry, so increasing arc length already
  -- means moving right — matching ds>0 (ArrowRight) with no help
  -- needed. rampLeft is the mirror image: its wall sits to the LEFT of
  -- its ground entry, so increasing arc length there means moving
  -- LEFT — the opposite of what ds>0 (ArrowRight) means everywhere
  -- else. Player.lua flips ds for this shape specifically so that
  -- "the key that visually walks you into the ramp" is always the one
  -- that climbs it, regardless of which way the ramp faces.
  shape.controlsReversed = dir < 0
  return shape, claimedCells
end

----------------------------------------------------------------------
-- Convex wall-climbs (crestRight/crestLeft + archRight/archLeft) — the
-- outside-of-a-rounded-block counterpart to buildRampClimbShape's own
-- inside-of-a-tube shapes above.
----------------------------------------------------------------------

-- Builds a convex wall-climb shape: a flat TOP curving DOWN into a wall
-- (crestRight/crestLeft), optionally a straight run of that wall, then
-- optionally a second curve into an underside/ceiling belly
-- (archRight/archLeft) the player walks upside-down along — like
-- walking over and around the OUTSIDE of a rounded block, rather than
-- through the INSIDE of a tube the way buildRampClimbShape's own
-- concave shapes work.
--
-- This mirrors buildRampClimbShape closely, but several things differ
-- because that's genuinely how the actual authored tile art places
-- these pieces — confirmed directly against tiled/Level1.lua's own
-- crestRight/archLeft placement (row 38/39, same column), not guessed:
--
--   - The wall continues in the SAME column as the crest tile itself,
--     not an adjacent one (concave's ramp wall sits in col+dir; this
--     one is straight down in `col`).
--   - The arch cap tile, if any, is ALSO in that same column, directly
--     below wherever the wall stack ends — not offset sideways the way
--     concave's ceiling cap is.
--   - A wall stack is entirely OPTIONAL: the arch cap can sit directly
--     beneath the crest tile with zero plain wall tiles between them
--     (that's exactly how the level's own tiles are laid out), so the
--     cap check can't be nested inside "only if a wall tile was found"
--     the way concave's is — it always runs, using whichever row comes
--     right after the wall search (found or not).
--
-- Every arc's normal points AWAY from its own center instead of toward
-- it (buildRampClimbShape's concave arcs have center on the OPEN-air
-- side; here center sits on the material side, and the player walks
-- the outside of the curve) — that's the entire concave/convex
-- difference in one sentence; everything else follows from it.
--
-- dir = 1 for crestRight (wall descends to the right of the flat top),
-- dir = -1 for crestLeft (mirrored).
local function buildConvexClimbShape(layer, tileProps, width, height, anchorX, anchorY, col, row, dir)
  local T = TILE_WORLD_SIZE
  local x0 = anchorX + col * T
  local y0 = anchorY + row * T
  local claimedCells = {}

  -- Base arc, inscribed in the crest tile's own box: center on the
  -- BOTTOM corner nearest the wall side (the corner a rounded-off sharp
  -- corner would have pivoted around), sweeping from the flat-top
  -- tangent point (normal straight up) to the wall tangent point
  -- (normal straight out sideways) — a quarter turn either way
  -- depending on dir.
  local centerX = dir > 0 and x0 or (x0 + T)
  local centerY = y0 + T
  local center = Vector2.new(centerX, centerY)

  local thetaLedge = -math.pi / 2
  local thetaWall = dir > 0 and 0 or -math.pi

  local points = {}
  for i = 0, RAMP_ARC_SEGMENTS do
    local t = i / RAMP_ARC_SEGMENTS
    local theta = thetaLedge + (thetaWall - thetaLedge) * t
    table.insert(points, Vector2.new(centerX + T * math.cos(theta), centerY + T * math.sin(theta)))
  end
  local arcSegmentCount = #points - 1

  -- Wall stack: straight down the SAME column as the crest tile (see
  -- this function's own header comment), starting one row below it.
  -- Wholly optional — see below, the cap check runs either way.
  local wallCol = col
  local wallEdgeX = dir > 0 and (x0 + T) or x0
  local wallBottomRow = nil
  do
    local r = row + 1
    while r < height do
      local gid = layer.data[r * width + wallCol + 1]
      if gid == 0 or classifyGid(tileProps, gid) ~= "wall" then break end
      wallBottomRow = r
      claimedCells[r * width + wallCol] = true
      r = r + 1
    end
  end

  local wallSegIndex = nil
  if wallBottomRow then
    table.insert(points, Vector2.new(wallEdgeX, anchorY + (wallBottomRow + 1) * T))
    wallSegIndex = #points - 1
  end

  -- Arch cap: directly below wherever the wall search stopped (right
  -- after the last wall tile, or right after the crest tile itself if
  -- there was no wall at all) — same column throughout.
  local capRow = wallBottomRow and (wallBottomRow + 1) or (row + 1)
  local capCol = col

  local capCenter, capArcStart, capArcEnd = nil, nil, nil
  local ceilingRunStart = nil
  local ownCapTileKey = nil
  local continuesAtKey = nil

  if capRow < height then
    local capGid = layer.data[capRow * width + capCol + 1]
    local capRole = capGid ~= 0 and classifyGid(tileProps, capGid) or "empty"

    if capRole == "archRight" or capRole == "archLeft" then
      claimedCells[capRow * width + capCol] = true
      ownCapTileKey = capRow * width + capCol

      -- Second arc, its own center — continues sweeping in the SAME
      -- angular direction the base arc was already sweeping, another
      -- quarter turn past thetaWall, exactly like buildRampClimbShape's
      -- own ceiling cap does. Lands, at its far end, on this arch
      -- tile's own bottom corner.
      local ccx = wallEdgeX - dir * T
      local ccy = anchorY + capRow * T
      capCenter = Vector2.new(ccx, ccy)
      capArcStart = #points
      for i = 1, RAMP_ARC_SEGMENTS do
        local t = i / RAMP_ARC_SEGMENTS
        local theta = thetaWall + (thetaWall - thetaLedge) * t
        table.insert(points, Vector2.new(ccx + T * math.cos(theta), ccy + T * math.sin(theta)))
      end
      capArcEnd = #points

      -- Underside backing: continues sideways AWAY from the crest's own
      -- climb direction, same row the arch tile itself sits in (unlike
      -- buildRampClimbShape's own ceiling run, which continues one row
      -- ABOVE its cap — the arch cap's own arc ends at ITS OWN bottom
      -- edge, not its top edge, so the matching backing row is the cap's
      -- own row, not the row above it).
      local flatRow = capRow
      local flatCol = capCol - dir
      local absorbDir = -dir
      ceilingRunStart = #points

      local fc = flatCol
      while fc >= 0 and fc < width do
        local fgid = layer.data[flatRow * width + fc + 1]
        if fgid == 0 or classifyGid(tileProps, fgid) ~= "wall" then
          -- Same idea as buildRampClimbShape's own continuesAtKey: if
          -- this run stopped because it ran straight into ANOTHER
          -- shape's own cap, record where, so linkAndMergeWallClimbShapes
          -- can stitch the two together once every shape in the level
          -- exists to look up. Checks BOTH cap families (see
          -- buildRampClimbShape's own matching comment) — the neighbor
          -- on the other end of this underside run might belong to
          -- another convex piece (archLeft/archRight) or an ordinary
          -- CONCAVE one (ceilingLeft/ceilingRight): both present the
          -- same "normal points down" orientation this run is already
          -- walking in, so either is a valid splice point.
          --
          -- The two families sit on DIFFERENT rows relative to this
          -- scan, though: THIS shape's own convex cap sits at the SAME
          -- row as its backing, so another convex cap shows up as the
          -- tile this run just broke on (fgid itself) — but a concave
          -- cap (ceilingLeft/ceilingRight) sits ONE ROW BELOW its own
          -- backing (buildRampClimbShape's own convention), so it shows
          -- up one row further down from here instead.
          if fgid ~= 0 then
            local hitRole = classifyGid(tileProps, fgid)
            if hitRole == "archRight" or hitRole == "archLeft" then
              continuesAtKey = flatRow * width + fc
            end
          end
          if not continuesAtKey then
            local belowGid = layer.data[(flatRow + 1) * width + fc + 1]
            if belowGid and belowGid ~= 0 then
              local belowRole = classifyGid(tileProps, belowGid)
              if belowRole == "ceilingLeft" or belowRole == "ceilingRight" then
                continuesAtKey = (flatRow + 1) * width + fc
              end
            end
          end
          break
        end
        claimedCells[flatRow * width + fc] = true
        local edgeCol = absorbDir > 0 and (fc + 1) or fc
        table.insert(points, Vector2.new(anchorX + edgeCol * T, anchorY + (flatRow + 1) * T))
        fc = fc + absorbDir
      end
    end
  end

  if #points < 2 then return nil end

  local segments = {}
  for i = 1, #points - 1 do
    local a, b = points[i], points[i + 1]
    local tangent = b:subtract(a):normalize()
    local normal
    if i <= arcSegmentCount then
      -- Convex: normal points AWAY from center (the material side),
      -- not toward it — the one formula flip that makes this the
      -- outside of a curve instead of the inside.
      local mid = (a + b) * 0.5
      normal = mid:subtract(center):normalize()
    elseif capArcStart and i >= capArcStart and i < capArcEnd then
      local mid = (a + b) * 0.5
      normal = mid:subtract(capCenter):normalize()
    else
      -- Straight segments (wall face, underside backing run): this
      -- formula needs no convex/concave adjustment — it already gives
      -- the correct outward normal for a wall descending on either
      -- side, same as buildRampClimbShape's own straight segments use.
      normal = Vector2.new(dir * tangent.y, -dir * tangent.x)
    end
    local isCapArc = capArcStart and i >= capArcStart and i < capArcEnd
    local isCeilingRun = ceilingRunStart and i >= ceilingRunStart
    table.insert(segments, {
      a = a, b = b, tangent = tangent, normal = normal,
      length = b:subtract(a):length(),
      isWallFace = (i == wallSegIndex),
      isCeiling = isCapArc or isCeilingRun,
    })
  end

  local shape = newShape(segments)
  shape.forceUprightJump = false
  shape.ownCapTileKey = ownCapTileKey
  shape.continuesAtKey = continuesAtKey
  shape.ceilingRunStartSegment = ceilingRunStart
  shape.isWallClimb = true
  shape.controlsReversed = dir < 0
  return shape, claimedCells
end

-- Two ramps authored to meet mid-ceiling (e.g. a rampRight climb capped
-- with ceilingLeft, whose own ceiling run stops exactly where a rampLeft
-- climb's ceilingRight cap begins — see buildRampClimbShape's own
-- continuesAtKey/ownCapTileKey comments) are, up to this point, still two
-- separate TerrainShape objects with a hard edge between them: reaching
-- the end of one's own arc length is an ordinary isOpenPath boundary,
-- which Player:move() falls off of. That's fine for a genuine dead end,
-- but wrong here — the two were drawn as one continuous loop, and gravity
-- can't carry a falling player INTO a ceiling the way it can a floor (see
-- Player.lua's own move(), the isOpenPath edge-carry comment), so a player
-- who reaches this particular kind of "edge" would just fall every time,
-- regardless of direction, instead of continuing onto the second wall the
-- art clearly promises.
--
-- Fixes that by literally splicing the two shapes into one before the
-- player ever sees either: shapeA keeps its own segments as-is, and
-- shapeB's own PRE-absorption segments (its base arc, wall, and cap arc —
-- everything up to but not including its own ceiling backing run) are
-- appended in REVERSE. Reversed, because shapeB's own arc length runs
-- ground-to-ceiling, the opposite direction shapeA is arriving from.
-- shapeB's own absorption run itself is deliberately dropped, not
-- reversed-and-kept: both shapes' ceiling runs independently absorb
-- toward each other's cap along the SAME backing row (that's how
-- shapeA's own run found shapeB's cap tile to link to in the first
-- place), so shapeB's run just retraces ground shapeA's own run already
-- covered from the far end — appending it too would double back over the
-- whole ceiling a second time instead of continuing through the wall.
local function mergeWallClimbShapes(shapeA, shapeB)
  -- shapeB.hasDescent means its own absorbed run doesn't just retrace
  -- ground shapeA's own run already covered — partway through, it turned
  -- a corner (dipped down into a wall and an archLeft/archRight cap, see
  -- tryDescendCeilingCapToArch) and is now genuinely new geometry the
  -- merge needs to keep, all the way to its own far end, not just up to
  -- ceilingRunStartSegment.
  local cut = shapeB.hasDescent and (#shapeB.segments + 1)
    or shapeB.ceilingRunStartSegment or (#shapeB.segments + 1)
  for i = cut - 1, 1, -1 do
    local seg = shapeB.segments[i]
    table.insert(shapeA.segments, {
      a = seg.b,
      b = seg.a,
      tangent = seg.tangent:clone():multiply(-1),
      normal = seg.normal,
      length = seg.length,
      isWallFace = seg.isWallFace,
      isCeiling = seg.isCeiling,
    })
  end
  shapeA.totalLength = 0
  for _, seg in ipairs(shapeA.segments) do
    shapeA.totalLength = shapeA.totalLength + seg.length
  end
  shapeA:refreshBounds()
end

-- Runs after every individual ramp-climb shape already exists (a shape's
-- own continuesAtKey may point at a cap tile belonging to a shape built
-- LATER in the raster scan, so this can't happen inline during that scan)
-- — looks up, for each shape whose ceiling run ran into another shape's
-- cap, that owning shape, and merges them (see mergeWallClimbShapes).
-- Loops until a full pass makes no further merges, so a shape freshly
-- extended by one merge is still eligible to be found (as either side)
-- by another — needed for chains longer than a single pair (e.g. a
-- wall/ceiling/wall climb, arched across to a second wall/ceiling/wall
-- climb, all one continuous loop), which is also why shapeB's own
-- continuesAtKey and cap-tile ownership both get carried forward onto
-- shapeA below after each merge, not just discarded.
local function linkAndMergeWallClimbShapes(shapes)
  local capOwnerByKey = {}
  for _, shape in ipairs(shapes) do
    if shape.ownCapTileKey then capOwnerByKey[shape.ownCapTileKey] = shape end
    -- secondaryCapTileKey: this same shape's OWN dip into a wall+arch
    -- (see tryDescendCeilingCapToArch) lands on a second tile position —
    -- typically the immediately adjacent archLeft/archRight tile another
    -- shape's own mirror-image dip lands on from the far side of the same
    -- archway — findable the same way ownCapTileKey already is.
    if shape.secondaryCapTileKey then capOwnerByKey[shape.secondaryCapTileKey] = shape end
  end

  local absorbed = {}
  local mergedAny = true
  while mergedAny do
    mergedAny = false
    for _, shapeA in ipairs(shapes) do
      if not absorbed[shapeA] and shapeA.continuesAtKey then
        local shapeB = capOwnerByKey[shapeA.continuesAtKey]
        if shapeB and shapeB ~= shapeA and not absorbed[shapeB] then
          mergeWallClimbShapes(shapeA, shapeB)
          absorbed[shapeB] = true

          -- Redirect anything that still thinks shapeB owns its own cap
          -- tile to shapeA instead: shapeB's geometry now physically
          -- lives inside shapeA (see mergeWallClimbShapes), so a THIRD
          -- shape further down the path whose own continuesAtKey points
          -- at that same tile position needs to resolve to whichever
          -- shape is actually still there, not the now-absorbed one —
          -- capOwnerByKey was only ever built once, up front, and never
          -- updated as merges happen, so without this a chain longer
          -- than two shapes could never find its way past the first
          -- splice: it would look up shapeB, see it's already absorbed,
          -- and give up rather than continuing on to shapeA.
          if shapeB.ownCapTileKey then
            capOwnerByKey[shapeB.ownCapTileKey] = shapeA
          end
          if shapeB.secondaryCapTileKey then
            capOwnerByKey[shapeB.secondaryCapTileKey] = shapeA
          end

          -- Carry shapeB's own continuation forward instead of just
          -- clearing shapeA's — shapeB may ITSELF have been mid-chain
          -- (its own ceiling/underside run reaching into a THIRD
          -- shape's cap, e.g. an arch bridging to another wall-climb
          -- further along); clearing it would cap every chain at a
          -- single pair. When shapeB had no further continuation of its
          -- own, shapeB.continuesAtKey is already nil, so this ends the
          -- chain there.
          shapeA.continuesAtKey = shapeB.continuesAtKey

          mergedAny = true
        end
      end
    end
  end

  local result = {}
  for _, shape in ipairs(shapes) do
    if not absorbed[shape] then table.insert(result, shape) end
  end
  return result
end

-- Returns shapes, claimedCells — claimedCells merges every individual
-- shape's own claimed set (see buildRampClimbShape), for
-- TiledTerrain.load to pass into computeTopPointsByColumn.
local function buildRampShapes(layer, tileProps, width, height, anchorX, anchorY)
  local shapes = {}
  local claimedCells = {}
  for row = 0, height - 1 do
    for col = 0, width - 1 do
      local gid = layer.data[row * width + col + 1]
      if gid ~= 0 then
        local role = classifyGid(tileProps, gid)
        local dir = (role == "rampRight" and 1) or (role == "rampLeft" and -1) or nil
        local convexDir = (role == "crestRight" and 1) or (role == "crestLeft" and -1) or nil
        if dir then
          local shape, shapeClaimed = buildRampClimbShape(layer, tileProps, width, height, anchorX, anchorY, col, row, dir)
          if shape then
            table.insert(shapes, shape)
            for key in pairs(shapeClaimed) do claimedCells[key] = true end
          end
        elseif convexDir then
          local shape, shapeClaimed = buildConvexClimbShape(layer, tileProps, width, height, anchorX, anchorY, col, row, convexDir)
          if shape then
            table.insert(shapes, shape)
            for key in pairs(shapeClaimed) do claimedCells[key] = true end
          end
        end
      end
    end
  end
  shapes = linkAndMergeWallClimbShapes(shapes)
  return shapes, claimedCells
end

return {
  buildRampShapes = buildRampShapes,
}
