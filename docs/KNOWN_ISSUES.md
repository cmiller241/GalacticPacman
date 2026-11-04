# Known Issues

## Player collision capsule doesn't rotate on wall-climb shapes

**Where:** `lua/systems/CollisionSystem.lua` (`handlePlayerWallCollisions`), `main.lua` (the `C`-key debug view)

**What's going on:**

The player's collision shape against solid walls (`level.walls`, from
`TiledTerrain.lua`'s `buildWallShapes`) is a vertical capsule, not a plain
circle: a circle at `player.pos` (feet/center, radius `player.radius`) plus a
second circle offset straight up in **world-space Y** by `player.headReach`,
so a lowered ceiling tile can actually stop his head instead of only ever
colliding against a circle centered near his feet.

That "straight up in world-space Y" part is the problem. On ordinary ground
the player's real "up" (away from whatever he's standing on) really is
world-space up, so this is correct. But on a wall-climb shape (TiledTerrain's
`ceilingLeft`/`ceilingRight`/wall-face/ceiling loop-de-loop geometry —
`planet.isWallClimb`), the player's true "up" rotates to match the surface —
sideways on a wall face, upside-down on a ceiling run. The capsule never
rotates with him, so right at a `ceilingRight`/`ceilingLeft` tile's own seam
into the flat ceiling run, the capsule's stationary "head" extension pokes
into the very ceiling tile he's trying to walk onto, registering a bogus
collision. In practice this completely blocked the ceilingRight/ceilingLeft →
ceiling transition for the non-ball player (ball mode was accidentally immune,
since it already zeroes `headReach` out for an unrelated reason — a ball has
no head).

**Current fix (the hacky part):** `headReach` is zeroed out — collapsing the
capsule back to a plain circle — whenever
`player.onSurface and player.currentPlanet and player.currentPlanet.isWallClimb`
is true, the same way it's already zeroed for ball mode. This unblocks
movement correctly, but it's a blunt instrument: **while climbing a wall or
running across a ceiling, the player has NO head-collision reach at all**,
just the plain feet/center circle. Something that should be able to bonk his
head while he's sideways or upside-down on a wall-climb shape currently can't
— it'll just pass through where his (visually rotated) head actually is.

**Why it wasn't fixed properly instead:** the box-distance math in
`handlePlayerWallCollisions` currently relies on the capsule always being
purely vertical (its own comment: "exact for a vertical segment against an
axis-aligned box, since the segment's X never varies along its length").
Making the capsule rotate to match the current surface normal would mean
replacing that with a general segment-vs-AABB closest-point test (the
capsule's two circles at an arbitrary angle, not just stacked on the Y axis)
— a real, more involved change, not a one-line fix.

**Proper fix, if this ever actually matters in a level:** compute the
player's current "up" direction while on a wall-climb shape (the current
segment's own `.normal` — see `TerrainShape:segmentAtArcPosition`, already
used the same way in `Player.lua`'s own wall-climb movement code) and rotate
the capsule's head offset to point along that instead of assuming world-space
up. Then generalize the vertical-segment-only box-distance shortcut into a
real segment-vs-AABB closest-point test.

**Why it's fine for now:** nothing in the current levels puts a hazard where
it would hit the player's head specifically while he's mid-wall-climb, so the
gap is theoretical rather than something a player will actually run into
today.
