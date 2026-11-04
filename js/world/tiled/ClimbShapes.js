// js/world/tiled/ClimbShapes.js
//
// Wall-climb shapes: ramp-to-wall climbs, convex climbs, and joining them
// up into loops.
// Part of the Tiled level loader: see js/world/TiledTerrain.js.

import Vector2 from '../../vector2.js';
import { TILE_WORLD_SIZE, classifyGid } from './Tiles.js';
import { newShape, midpoint } from './TerrainShape.js';

// ---------------------------------------------------------------------
// Ramp-to-wall climbs (rampRight/rampLeft)
// ---------------------------------------------------------------------
// The ordinary per-column scan can only ever describe one floor height
// per column, capping any chain at 45 degrees of average rise — nowhere
// near enough for a curve that ends up fully vertical. This builds one
// explicit, hand-computed path per authored ramp tile instead: a
// quarter-circle arc exactly inscribed in that ONE tile's own 64x64 box,
// continuing straight up whatever "wall"-role stack sits directly above
// it, then picking up one ordinary 45-degree slope tile if one caps that
// stack (or a ceiling cap — see below).
//
// forceUprightJump is turned OFF on these shapes — orientation and the
// walking push-offset both follow the path's true local normal: upright
// on the flat approach, rotating through the curve, fully sideways
// climbing the wall, and upright again on flat ground.
//
// The "wall"-role tiles this climbs are unaffected — buildWallShapes
// still turns them into their own solid rects, so wall-jumping off them
// keeps working independently.
//
// INDEXING: point lists here keep the Lua version's numbering for the
// bookkeeping (counts like arcSegmentCount/capArcStart/wallSegIndex are
// "number of points so far"), and segment i (1-based) runs from
// points[i - 1] to points[i] in the 0-based JS array.
// ---------------------------------------------------------------------

const RAMP_ARC_SEGMENTS = 10; // straight segments approximating the quarter-circle

// Called when a ceiling-backing run STOPS and finds a ceilingLeft/
// ceilingRight tile one row below that isn't anchored by some other ramp:
// treats that tile as a genuine END cap of this shape — curves DOWN off
// of it into a wall descending in the adjacent column, and if that wall
// bottoms out onto an archLeft/archRight tile, curves into that arch and
// starts a fresh underside run past it (continuing in the SAME direction
// the ceiling run was already traveling).
//
// Returns null if there's no wall-into-arch structure there (the ordinary
// two-ramps-meet-directly case), or an object describing the new points
// plus the bookkeeping the caller needs.
//
// startPoint: the run's own last point, sitting exactly on this cap
// tile's near corner. capRow/capCol: the cap tile's grid position.
// capRole: its slope string, deciding which side the wall descends on.
function tryDescendCeilingCapToArch(layer, tileProps, width, height, anchorX, anchorY, capRow, capCol, capRole, startPoint) {
  const T = TILE_WORLD_SIZE;
  const dirCap = capRole === 'ceilingLeft' ? 1 : (capRole === 'ceilingRight' ? -1 : null);
  if (dirCap === null) return null;

  const wallCol = capCol + dirCap;
  if (wallCol < 0 || wallCol >= width) return null;

  // The side of the wall column facing back toward the cap tile.
  const wallEdgeX = anchorX + (dirCap > 0 ? wallCol : (wallCol + 1)) * T;

  // Scan DOWNWARD for contiguous "wall"-role tiles starting one row below
  // the cap. Left at capRow (a zero-height wall) when none are found.
  let wallBottomRow = capRow;
  for (let r = capRow + 1; r < height; r++) {
    const gid = layer.data[r * width + wallCol] ?? 0;
    if (gid === 0 || classifyGid(tileProps, gid) !== 'wall') break;
    wallBottomRow = r;
  }

  const archRow = wallBottomRow + 1;
  const archCol = wallCol;
  if (archRow >= height) return null;
  const archGid = layer.data[archRow * width + archCol] ?? 0;
  const archRole = archGid !== 0 ? classifyGid(tileProps, archGid) : 'empty';
  if (archRole !== 'archLeft' && archRole !== 'archRight') return null;

  const claimed = new Set();
  const newPoints = [];

  // First arc: ceiling cap's own corner (startPoint) curving down to the
  // wall's own top tangent point. Center sits directly below startPoint,
  // one tile down. ("Start" markers: the count of points BEFORE the new
  // range begins.)
  const center1 = new Vector2(startPoint.x, anchorY + (capRow + 1) * T);
  const arc1Start = newPoints.length;
  for (let i = 1; i <= RAMP_ARC_SEGMENTS; i++) {
    const t = i / RAMP_ARC_SEGMENTS;
    const theta = -Math.PI / 2 + dirCap * (Math.PI / 2) * t;
    newPoints.push(new Vector2(center1.x + T * Math.cos(theta), center1.y + T * Math.sin(theta)));
  }
  const arc1End = newPoints.length;

  // Wall segment (may end up zero-length — harmless).
  for (let r = capRow + 1; r <= wallBottomRow; r++) claimed.add(r * width + wallCol);
  const wallSegIndex = newPoints.length;
  newPoints.push(new Vector2(wallEdgeX, anchorY + (wallBottomRow + 1) * T));

  // Second arc: wall's own bottom tangent curving into the arch tile's
  // underside tangent. It enters with a VERTICAL tangent, so the center
  // is offset sideways (same y as the entry point). It's also CONVEX —
  // the center sits on the material side and the curve bulges away.
  const entry2 = newPoints[newPoints.length - 1];
  const center2 = new Vector2(entry2.x + dirCap * T, entry2.y);
  const entryTheta2 = dirCap > 0 ? Math.PI : 0;
  const arc2Start = newPoints.length;
  for (let i = 1; i <= RAMP_ARC_SEGMENTS; i++) {
    const t = i / RAMP_ARC_SEGMENTS;
    const theta = entryTheta2 - dirCap * (Math.PI / 2) * t;
    newPoints.push(new Vector2(center2.x + T * Math.cos(theta), center2.y + T * Math.sin(theta)));
  }
  const arc2End = newPoints.length;
  claimed.add(archRow * width + archCol);

  // Underside run: stops the instant it isn't "wall"-backed anymore,
  // checking for a same-row archLeft/archRight partner to hand off to via
  // continuesAtKey.
  const runStart = newPoints.length;
  let continuesAtKey = null;
  let fc = archCol + dirCap;
  while (fc >= 0 && fc < width) {
    const fgid = layer.data[archRow * width + fc] ?? 0;
    if (fgid === 0 || classifyGid(tileProps, fgid) !== 'wall') {
      if (fgid !== 0) {
        const hitRole = classifyGid(tileProps, fgid);
        if (hitRole === 'archLeft' || hitRole === 'archRight') continuesAtKey = archRow * width + fc;
      }
      break;
    }
    claimed.add(archRow * width + fc);
    const edgeCol = dirCap > 0 ? (fc + 1) : fc;
    newPoints.push(new Vector2(anchorX + edgeCol * T, anchorY + (archRow + 1) * T));
    fc += dirCap;
  }
  return {
    points: newPoints,
    center1, arc1Start, arc1End,
    wallSegIndex,
    center2, arc2Start, arc2End,
    runStart,
    claimed,
    ownCapTileKey2: archRow * width + archCol,
    continuesAtKey,
    dirCap,
  };
}

// Builds the full climb path for one ramp tile at (col, row). dir = 1 for
// rampRight (ledge below-left, wall above-right), dir = -1 for rampLeft
// (mirrored).
//
// The arc is centered on whichever corner of the tile's own box sits on
// the curve's open-air side — top-left for rampRight, top-right for
// rampLeft — sweeping from the tangent-HORIZONTAL point (the flat ledge
// below) to the tangent-VERTICAL point (the wall above). Its normal
// always points TOWARD the center (the open-air side).
//
// The straight portions reuse the rotate-the-tangent convention, mirrored
// by `dir` (rampLeft's path traverses each tile's edges in the opposite
// order).
//
// Returns [shape, claimedCells] — claimedCells is a Set of every tile
// this shape absorbed, for the caller to exclude from
// computeTopPointsByColumn.
function buildRampClimbShape(layer, tileProps, width, height, anchorX, anchorY, col, row, dir) {
  const T = TILE_WORLD_SIZE;
  const x0 = anchorX + col * T;
  const y0 = anchorY + row * T;
  const claimedCells = new Set();

  const centerX = dir > 0 ? x0 : (x0 + T);
  const centerY = y0;
  const center = new Vector2(centerX, centerY);

  const thetaLedge = Math.PI / 2;
  const thetaWall = dir > 0 ? 0 : Math.PI;

  const points = [];
  for (let i = 0; i <= RAMP_ARC_SEGMENTS; i++) {
    const t = i / RAMP_ARC_SEGMENTS;
    const theta = thetaLedge + (thetaWall - thetaLedge) * t;
    points.push(new Vector2(centerX + T * Math.cos(theta), centerY + T * Math.sin(theta)));
  }
  const arcSegmentCount = points.length - 1;

  // Wall column: directly above-right (rampRight) or above-left
  // (rampLeft) of the ramp tile. Walks upward counting contiguous
  // "wall"-role tiles to find where the stack actually ends.
  const wallCol = dir > 0 ? (col + 1) : (col - 1);
  let wallTopRow = null;
  for (let r = row - 1; r >= 0; r--) {
    const gid = layer.data[r * width + wallCol] ?? 0;
    if (gid === 0 || classifyGid(tileProps, gid) !== 'wall') break;
    wallTopRow = r;
    claimedCells.add(r * width + wallCol);
  }

  let wallSegIndex = null;
  // Set only when this shape's own ceiling run dips down into a wall and
  // an archLeft/archRight cap (see tryDescendCeilingCapToArch).
  let descentCenter1 = null, descentArc1Start = null, descentArc1End = null;
  let descentWallSegIndex = null;
  let descentCenter2 = null, descentArc2Start = null, descentArc2End = null;
  let descentRunStart = null;
  let descentDirCap = null;
  let secondaryCapTileKey = null;
  // Set only when a ceilingLeft/ceilingRight cap is found — a SECOND arc,
  // with its own center.
  let capCenter = null, capArcStart = null, capArcEnd = null;
  // The point count the ceiling-backing run starts from (only when the
  // run is the ceiling's own solid backing). Segments from here on, PLUS
  // the cap arc itself, are "the ceiling" for Player.js's isCeiling check.
  let ceilingRunStart = null;
  // This shape's OWN cap tile position (row*width+col), so
  // linkAndMergeWallClimbShapes can find it.
  let ownCapTileKey = null;
  // Set when this shape's ceiling run ran straight into ANOTHER
  // wall-climb shape's cap tile (two ramps authored to form one loop).
  let continuesAtKey = null;

  if (wallTopRow !== null) {
    const wallEdgeX = dir > 0 ? (anchorX + wallCol * T) : (anchorX + (wallCol + 1) * T);
    points.push(new Vector2(wallEdgeX, anchorY + wallTopRow * T));
    // The segment this point just closed off is THE wall face — recorded
    // by index, since the slope segment after it is ALSO steep.
    wallSegIndex = points.length - 1;

    // Where the run that follows starts from: directly above the wall
    // stack, unless a slope or ceiling cap is found (just below).
    let flatCol = wallCol, flatRow = wallTopRow - 1;
    let absorbRole = 'flat'; // what the run's tiles need to classify as; "wall" once past a ceiling cap
    let absorbDir = dir;     // which way the run continues; flips (-dir) past a ceiling cap

    // One ordinary 45-degree slope tile (same column as the wall stack),
    // OR a ceilingLeft/ceilingRight cap (one column BACK toward the base
    // ramp instead).
    const capRow = wallTopRow - 1;
    const capCol = wallCol - dir;
    if (capRow >= 0) {
      const slopeGid = layer.data[capRow * width + wallCol] ?? 0;
      const slopeRole = slopeGid !== 0 ? classifyGid(tileProps, slopeGid) : 'empty';
      const ceilGid = layer.data[capRow * width + capCol] ?? 0;
      const ceilRole = ceilGid !== 0 ? classifyGid(tileProps, ceilGid) : 'empty';
      const capRole = (slopeRole === 'riseLeft' || slopeRole === 'riseRight') ? slopeRole : ceilRole;

      if (capRole === 'riseLeft' || capRole === 'riseRight') {
        // Same left/right-edge convention buildWorldSegments uses.
        claimedCells.add(capRow * width + wallCol);
        let leftRow, rightRow;
        if (capRole === 'riseLeft') { leftRow = capRow; rightRow = capRow + 1; }
        else { leftRow = capRow + 1; rightRow = capRow; }
        const leftPt = new Vector2(anchorX + wallCol * T, anchorY + leftRow * T);
        const rightPt = new Vector2(anchorX + (wallCol + 1) * T, anchorY + rightRow * T);
        if (dir > 0) {
          points.push(leftPt, rightPt);
          flatCol = wallCol + 1; flatRow = rightRow;
        } else {
          points.push(rightPt, leftPt);
          flatCol = wallCol; flatRow = leftRow;
        }
      } else if (capRole === (dir > 0 ? 'ceilingLeft' : 'ceilingRight')) {
        // (Only the cap that curves back over the ramp — ceilingLeft over
        // a rampRight, ceilingRight over a rampLeft — makes a loop. The
        // other way round, it's the far side of a ball tunnel turning
        // from a shaft into a passage, not a ceiling to run along.)
        // Continues the wall PAST vertical into a ceiling. This curve's
        // center is one full tile-width off to the side, in the direction
        // the ceiling continues (opposite `dir`); both ends land exactly
        // on the cap tile's own corners.
        claimedCells.add(capRow * width + capCol);
        ownCapTileKey = capRow * width + capCol;
        const ccx = wallEdgeX - dir * T;
        const ccy = anchorY + wallTopRow * T;
        capCenter = new Vector2(ccx, ccy);
        capArcStart = points.length;
        // Continues sweeping in the SAME angular direction the base arc
        // was already sweeping — another quarter turn past thetaWall.
        for (let i = 1; i <= RAMP_ARC_SEGMENTS; i++) {
          const t = i / RAMP_ARC_SEGMENTS;
          const theta = thetaWall + (thetaWall - thetaLedge) * t;
          points.push(new Vector2(ccx + T * Math.cos(theta), ccy + T * Math.sin(theta)));
        }
        capArcEnd = points.length;

        // The ceiling material is ABOVE the walkway line now: the run's
        // own row is one above where the curve landed, tagged "wall", and
        // continues opposite the original climb direction.
        flatCol = capCol - dir; flatRow = capRow - 1;
        absorbRole = 'wall';
        absorbDir = -dir;
      }
    }

    // A ball tunnel's inner corner (an *Inner tile — a "wall", see
    // classifyGid) topping the stack, with open tunnel above it: the
    // walkway runs on across the corner's own top, onto the ground beside
    // it at that height (the tunnel turning from the shaft into a passage).
    let runStartsOnStackTop = false;
    if (absorbRole === 'flat' && flatCol === wallCol && flatRow === wallTopRow - 1 && flatRow >= 0
        && (layer.data[flatRow * width + wallCol] ?? 0) === 0) {
      const topProps = tileProps[layer.data[wallTopRow * width + wallCol]];
      if (topProps && topProps.slope && /Inner$/.test(topProps.slope)) {
        flatRow = wallTopRow;
        runStartsOnStackTop = true;
      }
    }

    // Absorb the run that follows, all the way to its TRUE end — this
    // shape needs to BE the complete continuation for that stretch, so
    // nothing is left for the ordinary scan to pick up separately. "flat"
    // ground is walked ON TOP of (line at the row's top edge); "wall"
    // ceiling material is walked UNDER (line at the row's bottom edge).
    if (flatRow >= 0) {
      const rowEdge = (absorbRole === 'wall') ? (flatRow + 1) : flatRow;
      if (absorbRole === 'wall') ceilingRunStart = points.length;
      let fc = flatCol;
      if (runStartsOnStackTop) {
        // (Across the corner's own top first — it's the stack's, already claimed.)
        points.push(new Vector2(anchorX + (absorbDir > 0 ? (fc + 1) : fc) * T, anchorY + flatRow * T));
        fc += absorbDir;
      }
      while (fc >= 0 && fc < width) {
        const fgid = layer.data[flatRow * width + fc] ?? 0;
        if (fgid === 0 || classifyGid(tileProps, fgid) !== absorbRole) {
          // Ceiling backing stopping here because the next tile is
          // another cap means this run reached where a second wall-climb
          // shape's cap begins — record that cap's grid position so
          // linkAndMergeWallClimbShapes can stitch the two together.
          // Checks BOTH cap families: a convex cap (archLeft/archRight)
          // sits at the SAME row as its backing (it's the tile this run
          // just broke on), a concave cap (ceilingLeft/ceilingRight) ONE
          // ROW BELOW.
          if (absorbRole === 'wall') {
            if (fgid !== 0) {
              const sameRowRole = classifyGid(tileProps, fgid);
              if (sameRowRole === 'archLeft' || sameRowRole === 'archRight') continuesAtKey = flatRow * width + fc;
            }
            if (continuesAtKey === null) {
              const belowGid = layer.data[(flatRow + 1) * width + fc];
              if (belowGid !== undefined && belowGid !== 0) {
                const belowRole = classifyGid(tileProps, belowGid);
                if (belowRole === 'ceilingLeft' || belowRole === 'ceilingRight') {
                  // First try treating that tile as a genuine END cap of
                  // THIS shape (dipping into a wall and an arch); fall back
                  // to linking whatever ramp shape owns it.
                  const descentCapRow = flatRow + 1;
                  const descent = tryDescendCeilingCapToArch(
                    layer, tileProps, width, height, anchorX, anchorY,
                    descentCapRow, fc, belowRole, points[points.length - 1]);
                  if (descent) {
                    const baseIndex = points.length;
                    for (const p of descent.points) points.push(p);
                    descentCenter1 = descent.center1;
                    descentArc1Start = baseIndex + descent.arc1Start;
                    descentArc1End = baseIndex + descent.arc1End;
                    descentWallSegIndex = baseIndex + descent.wallSegIndex;
                    descentCenter2 = descent.center2;
                    descentArc2Start = baseIndex + descent.arc2Start;
                    descentArc2End = baseIndex + descent.arc2End;
                    descentRunStart = descent.runStart != null ? (baseIndex + descent.runStart) : null;
                    descentDirCap = descent.dirCap;
                    for (const key of descent.claimed) claimedCells.add(key);
                    secondaryCapTileKey = descent.ownCapTileKey2;
                    continuesAtKey = descent.continuesAtKey;
                  } else {
                    continuesAtKey = (flatRow + 1) * width + fc;
                  }
                }
              }
            }
          }
          break;
        }
        claimedCells.add(flatRow * width + fc);
        const edgeCol = absorbDir > 0 ? (fc + 1) : fc;
        points.push(new Vector2(anchorX + edgeCol * T, anchorY + rowEdge * T));
        fc += absorbDir;
      }
    }
  }

  if (points.length < 2) return [null, claimedCells];

  const segments = [];
  for (let i = 1; i <= points.length - 1; i++) {
    const a = points[i - 1], b = points[i];
    const tangent = b.subtract(a).normalize();
    let normal;
    const isDescentArc1 = descentArc1Start !== null && i >= descentArc1Start && i < descentArc1End;
    const isDescentArc2 = descentArc2Start !== null && i >= descentArc2Start && i < descentArc2End;
    if (i <= arcSegmentCount) {
      normal = center.subtract(midpoint(a, b)).normalize();
    } else if (capArcStart !== null && i >= capArcStart && i < capArcEnd) {
      normal = capCenter.subtract(midpoint(a, b)).normalize();
    } else if (isDescentArc1) {
      normal = descentCenter1.subtract(midpoint(a, b)).normalize();
    } else if (isDescentArc2) {
      // Convex: the center sits on the material side here, so the normal
      // points AWAY from it.
      normal = midpoint(a, b).subtract(descentCenter2).normalize();
    } else if (i === descentWallSegIndex) {
      // Away from the solid wall column (on the descentDirCap side).
      normal = new Vector2(-descentDirCap, 0);
    } else if (descentRunStart !== null && i >= descentRunStart) {
      // Underside run past the arch: material above, open air below.
      normal = new Vector2(0, 1);
    } else {
      normal = new Vector2(dir * tangent.y, -dir * tangent.x);
    }
    const isCapArc = capArcStart !== null && i >= capArcStart && i < capArcEnd;
    const isCeilingRun = ceilingRunStart !== null && i >= ceilingRunStart;
    segments.push({
      a, b, tangent, normal,
      length: b.subtract(a).length(),
      isWallFace: (i === wallSegIndex) || (i === descentWallSegIndex),
      // The ceiling cap arc AND the run past it (and the descent's own
      // arcs/run) — see Player.js's isCeiling check: nothing but a curve
      // holding you up overhead.
      isCeiling: isCapArc || isCeilingRun || isDescentArc1 || isDescentArc2
        || (descentRunStart !== null && i >= descentRunStart),
    });
  }

  const shape = newShape(segments);
  shape.forceUprightJump = false;
  // ownCapTileKey lets another shape's ceiling run find and merge into
  // THIS one; continuesAtKey is the reverse. ceilingRunStartSegment marks
  // where this shape's own absorbed ceiling backing begins (segment-index
  // terms, 1-based like i above) — the part that gets discarded when this
  // shape is merged in as the "other" side of a seam.
  shape.ownCapTileKey = ownCapTileKey;
  shape.continuesAtKey = continuesAtKey;
  shape.ceilingRunStartSegment = ceilingRunStart;
  // A second position this same shape can be found by, and a marker that
  // its absorbed run is genuinely new geometry a merge partner must keep.
  shape.secondaryCapTileKey = secondaryCapTileKey;
  shape.hasDescent = secondaryCapTileKey !== null;
  // Marks this as a ramp-climb shape: no uphill penalty, no Ooomba
  // spawning on it, and the player detaches if not actively climbing.
  shape.isWallClimb = true;
  // rampLeft's wall sits to the LEFT of its ground entry, so increasing
  // arc length there means moving LEFT — Player.js flips ds for this
  // shape so "the key that visually walks you into the ramp" climbs it.
  shape.controlsReversed = dir < 0;
  return [shape, claimedCells];
}

// ---------------------------------------------------------------------
// Convex wall-climbs (crestRight/crestLeft + archRight/archLeft) — the
// outside-of-a-rounded-block counterpart to buildRampClimbShape.
// ---------------------------------------------------------------------

// A flat TOP curving DOWN into a wall (crest), optionally a straight run
// of that wall, then optionally a second curve into an underside belly
// (arch) the player walks upside-down along. Differences from the
// concave version, matching how the tile art places these pieces:
//   - The wall continues in the SAME column as the crest tile.
//   - The arch cap tile, if any, is ALSO in that same column, directly
//     below wherever the wall stack ends.
//   - A wall stack is entirely OPTIONAL.
// Every arc's normal points AWAY from its own center (the material side).
//
// dir = 1 for crestRight (wall descends to the right of the flat top),
// dir = -1 for crestLeft. Returns [shape, claimedCells].
function buildConvexClimbShape(layer, tileProps, width, height, anchorX, anchorY, col, row, dir) {
  const T = TILE_WORLD_SIZE;
  const x0 = anchorX + col * T;
  const y0 = anchorY + row * T;
  const claimedCells = new Set();

  // Base arc, inscribed in the crest tile's own box: center on the
  // BOTTOM corner nearest the wall side.
  const centerX = dir > 0 ? x0 : (x0 + T);
  const centerY = y0 + T;
  const center = new Vector2(centerX, centerY);

  const thetaLedge = -Math.PI / 2;
  const thetaWall = dir > 0 ? 0 : -Math.PI;

  const points = [];
  for (let i = 0; i <= RAMP_ARC_SEGMENTS; i++) {
    const t = i / RAMP_ARC_SEGMENTS;
    const theta = thetaLedge + (thetaWall - thetaLedge) * t;
    points.push(new Vector2(centerX + T * Math.cos(theta), centerY + T * Math.sin(theta)));
  }
  const arcSegmentCount = points.length - 1;

  // Wall stack: straight down the SAME column as the crest tile.
  const wallCol = col;
  const wallEdgeX = dir > 0 ? (x0 + T) : x0;
  let wallBottomRow = null;
  for (let r = row + 1; r < height; r++) {
    const gid = layer.data[r * width + wallCol] ?? 0;
    if (gid === 0 || classifyGid(tileProps, gid) !== 'wall') break;
    wallBottomRow = r;
    claimedCells.add(r * width + wallCol);
  }

  let wallSegIndex = null;
  if (wallBottomRow !== null) {
    points.push(new Vector2(wallEdgeX, anchorY + (wallBottomRow + 1) * T));
    wallSegIndex = points.length - 1;
  }

  // Arch cap: directly below wherever the wall search stopped.
  const capRow = wallBottomRow !== null ? (wallBottomRow + 1) : (row + 1);
  const capCol = col;

  let capCenter = null, capArcStart = null, capArcEnd = null;
  let ceilingRunStart = null;
  let ownCapTileKey = null;
  let continuesAtKey = null;

  if (capRow < height) {
    const capGid = layer.data[capRow * width + capCol] ?? 0;
    const capRole = capGid !== 0 ? classifyGid(tileProps, capGid) : 'empty';

    if (capRole === 'archRight' || capRole === 'archLeft') {
      claimedCells.add(capRow * width + capCol);
      ownCapTileKey = capRow * width + capCol;

      // Second arc, its own center — another quarter turn past thetaWall.
      const ccx = wallEdgeX - dir * T;
      const ccy = anchorY + capRow * T;
      capCenter = new Vector2(ccx, ccy);
      capArcStart = points.length;
      for (let i = 1; i <= RAMP_ARC_SEGMENTS; i++) {
        const t = i / RAMP_ARC_SEGMENTS;
        const theta = thetaWall + (thetaWall - thetaLedge) * t;
        points.push(new Vector2(ccx + T * Math.cos(theta), ccy + T * Math.sin(theta)));
      }
      capArcEnd = points.length;

      // Underside backing: continues sideways AWAY from the crest's own
      // climb direction, same row the arch tile itself sits in.
      const flatRow = capRow;
      const flatCol = capCol - dir;
      const absorbDir = -dir;
      ceilingRunStart = points.length;

      let fc = flatCol;
      while (fc >= 0 && fc < width) {
        const fgid = layer.data[flatRow * width + fc] ?? 0;
        if (fgid === 0 || classifyGid(tileProps, fgid) !== 'wall') {
          // If this run stopped because it ran into ANOTHER shape's cap,
          // record where (both cap families — see buildRampClimbShape).
          if (fgid !== 0) {
            const hitRole = classifyGid(tileProps, fgid);
            if (hitRole === 'archRight' || hitRole === 'archLeft') continuesAtKey = flatRow * width + fc;
          }
          if (continuesAtKey === null) {
            const belowGid = layer.data[(flatRow + 1) * width + fc];
            if (belowGid !== undefined && belowGid !== 0) {
              const belowRole = classifyGid(tileProps, belowGid);
              if (belowRole === 'ceilingLeft' || belowRole === 'ceilingRight') continuesAtKey = (flatRow + 1) * width + fc;
            }
          }
          break;
        }
        claimedCells.add(flatRow * width + fc);
        const edgeCol = absorbDir > 0 ? (fc + 1) : fc;
        points.push(new Vector2(anchorX + edgeCol * T, anchorY + (flatRow + 1) * T));
        fc += absorbDir;
      }
    }
  }

  if (points.length < 2) return [null, claimedCells];

  const segments = [];
  for (let i = 1; i <= points.length - 1; i++) {
    const a = points[i - 1], b = points[i];
    const tangent = b.subtract(a).normalize();
    let normal;
    if (i <= arcSegmentCount) {
      // Convex: normal points AWAY from center.
      normal = midpoint(a, b).subtract(center).normalize();
    } else if (capArcStart !== null && i >= capArcStart && i < capArcEnd) {
      normal = midpoint(a, b).subtract(capCenter).normalize();
    } else {
      // Straight segments (wall face, underside backing run).
      normal = new Vector2(dir * tangent.y, -dir * tangent.x);
    }
    const isCapArc = capArcStart !== null && i >= capArcStart && i < capArcEnd;
    const isCeilingRun = ceilingRunStart !== null && i >= ceilingRunStart;
    segments.push({
      a, b, tangent, normal,
      length: b.subtract(a).length(),
      isWallFace: i === wallSegIndex,
      isCeiling: isCapArc || isCeilingRun,
    });
  }

  const shape = newShape(segments);
  shape.forceUprightJump = false;
  shape.ownCapTileKey = ownCapTileKey;
  shape.continuesAtKey = continuesAtKey;
  shape.ceilingRunStartSegment = ceilingRunStart;
  shape.isWallClimb = true;
  shape.controlsReversed = dir < 0;
  return [shape, claimedCells];
}

// Two ramps authored to meet mid-ceiling are two separate TerrainShapes
// with a hard edge between them — reaching the end of one's arc length
// would make the player fall, instead of continuing onto the second wall
// the art promises. This splices them into one: shapeA keeps its own
// segments, and shapeB's own PRE-absorption segments (base arc, wall, cap
// arc — up to but not including its own ceiling backing run) are appended
// in REVERSE. shapeB's own absorption run is dropped: it just retraces
// ground shapeA's run already covered from the far end — unless shapeB
// hasDescent (its run turned a corner into new geometry), when it's kept.
function mergeWallClimbShapes(shapeA, shapeB) {
  const cut = shapeB.hasDescent ? (shapeB.segments.length + 1)
    : (shapeB.ceilingRunStartSegment ?? (shapeB.segments.length + 1));
  for (let i = cut - 1; i >= 1; i--) {
    const seg = shapeB.segments[i - 1];
    shapeA.segments.push({
      a: seg.b,
      b: seg.a,
      tangent: seg.tangent.clone().multiply(-1),
      normal: seg.normal,
      length: seg.length,
      isWallFace: seg.isWallFace,
      isCeiling: seg.isCeiling,
    });
  }
  shapeA.totalLength = 0;
  for (const seg of shapeA.segments) shapeA.totalLength += seg.length;
  shapeA.refreshBounds();
}

// Runs after every individual ramp-climb shape exists — looks up, for
// each shape whose ceiling run ran into another shape's cap, that owning
// shape, and merges them. Loops until a full pass makes no further
// merges, so chains longer than a pair work; shapeB's own cap-tile
// ownership and continuation are carried forward onto shapeA after each
// merge.
function linkAndMergeWallClimbShapes(shapes) {
  const capOwnerByKey = new Map();
  for (const shape of shapes) {
    if (shape.ownCapTileKey != null) capOwnerByKey.set(shape.ownCapTileKey, shape);
    if (shape.secondaryCapTileKey != null) capOwnerByKey.set(shape.secondaryCapTileKey, shape);
  }

  const absorbed = new Set();
  let mergedAny = true;
  while (mergedAny) {
    mergedAny = false;
    for (const shapeA of shapes) {
      if (!absorbed.has(shapeA) && shapeA.continuesAtKey != null) {
        const shapeB = capOwnerByKey.get(shapeA.continuesAtKey);
        if (shapeB && shapeB !== shapeA && !absorbed.has(shapeB)) {
          mergeWallClimbShapes(shapeA, shapeB);
          absorbed.add(shapeB);

          // Redirect anything that still thinks shapeB owns its cap tile
          // to shapeA, where its geometry now lives.
          if (shapeB.ownCapTileKey != null) capOwnerByKey.set(shapeB.ownCapTileKey, shapeA);
          if (shapeB.secondaryCapTileKey != null) capOwnerByKey.set(shapeB.secondaryCapTileKey, shapeA);

          // Carry shapeB's own continuation forward (it may itself have
          // been mid-chain).
          shapeA.continuesAtKey = shapeB.continuesAtKey;

          mergedAny = true;
        }
      }
    }
  }

  return shapes.filter((shape) => !absorbed.has(shape));
}

// Returns [shapes, claimedCells] — claimedCells merges every individual
// shape's own claimed set, for computeTopPointsByColumn.
function buildRampShapes(layer, tileProps, width, height, anchorX, anchorY) {
  let shapes = [];
  const claimedCells = new Set();
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const gid = layer.data[row * width + col] ?? 0;
      if (gid !== 0) {
        const role = classifyGid(tileProps, gid);
        const dir = role === 'rampRight' ? 1 : (role === 'rampLeft' ? -1 : null);
        const convexDir = role === 'crestRight' ? 1 : (role === 'crestLeft' ? -1 : null);
        if (dir !== null) {
          const [shape, shapeClaimed] = buildRampClimbShape(layer, tileProps, width, height, anchorX, anchorY, col, row, dir);
          if (shape) {
            shapes.push(shape);
            for (const key of shapeClaimed) claimedCells.add(key);
          }
        } else if (convexDir !== null) {
          const [shape, shapeClaimed] = buildConvexClimbShape(layer, tileProps, width, height, anchorX, anchorY, col, row, convexDir);
          if (shape) {
            shapes.push(shape);
            for (const key of shapeClaimed) claimedCells.add(key);
          }
        }
      }
    }
  }
  shapes = linkAndMergeWallClimbShapes(shapes);
  return [shapes, claimedCells];
}

export { buildRampShapes };
