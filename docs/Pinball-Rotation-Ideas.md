# Pinball Rotation & Gravity Ideas

Brainstorm for making rotation and gravity changes *fun* in the pinball level, not just a novelty.

## The core problem

With gravity always pointing down the screen and the table turning slowly, a sideways table has no "floor" with flippers on it. The ball rolls into the lowest pocket and sits there until the rotation tips it out. The player has nothing to do, and waiting isn't gameplay.

Every idea below solves this in one of three ways:

1. **The player controls the rotation or gravity**, so a resting ball is the player's choice.
2. **Rotation happens in designed steps**, and each orientation is a deliberately built "room."
3. **Resting is made impossible or rewarding**: something always kicks the ball back into play, or resting in the right spot pays off.

---

## 1. Player-controlled tilt

- **Tilt with the shoulder buttons.** L1/R1 rotate the table a limited amount, say ±30°, and it springs back to upright when released. That's like nudging a real cabinet, but readable. The ball never comes to rest, because the player is always steering it.
- **A tilt meter.** Tilting too much or too long fills a meter; overdo it and the flippers die for a few seconds ("TILT!"), just like real pinball. It's a risk/reward choice instead of free control.
- **Full rotation as a power-up.** Normally the table stays upright. Collecting something, like a rubinium crystal, unlocks a few seconds of free 360° rotation.

## 2. Rotation in designed steps

The table snaps 90° (eased over about a second) when something triggers it, then holds still. Each orientation is its own playable layout.

- **Trigger ideas:** hit all three bumpers in a field, roll through a lit lane, or shoot a target with a fireball.
- **Four-sided table design.** Put flippers on more than one wall. Only the flippers on whichever wall is currently "down" are active; the others go dim or retract. Turned sideways, there's a fresh pair waiting.
- **Telegraph it.** A warning glow, arrows or a rumble in the second before it turns, so it feels fair rather than random.
- **"Which way is down" puzzles.** Some lanes and gates only work in one orientation: a ramp that's a wall upright becomes a slide sideways. Reaching a target means getting the table into the right orientation first.

## 3. Change gravity without rotating the table

The table doesn't have to turn for gravity to change. Rotating only the gravity direction may read much more clearly than rotating the whole table.

- **Gravity flip pads.** Roll over a pad and gravity flips to up, left or right for a few seconds, then returns to normal. A clear arrow or color tint on the table shows the current gravity direction.
- **Gravity zones.** Regions of the table with their own pull direction: an "up-current" column that floats the ball to the top, or a sideways zone feeding a side lane.
- **Mini gravity wells.** Small planetoids embedded in the table that the ball orbits or slingshots around. This ties directly into the rest of the game's planet-gravity mechanics, and it's very on-theme for Asteroid Bob.
- **Magnets and attractors.** The ball curves toward them, and a fireball hit turns them off.

## 4. Never let the ball just sit there

- **Kickout saucers.** Pockets that catch the ball, score, flash and then fire it back out after a beat. A ball resting in a saucer while the table is sideways becomes a feature: it gets shot out when the angle is right.
- **Anti-stall kicker.** If the ball hasn't moved in about two seconds, a nearby bumper or kicker nudges it free.
- **Resting scores.** A "hold" target that gives points per second while the ball rests in it, and its value drops if you camp there too long.

## 5. Use Bob's own abilities

Bob is still Bob while he's the ball, and his moveset could be a big part of what makes this table special.

- **Ground pound in the gravity direction.** Slam downward in whatever direction "down" currently is. It's a quick way out of a resting spot and a way to drop onto targets.
- **Pull beam to bumpers or anchors.** Grab a bumper and swing or yank toward it. This is a direct escape when the ball is stuck, and it builds on a mechanic players already know from the belt.
- **Fireballs as triggers.** Shoot switches that rotate the table or flip gravity, or shoot targets on the far wall.
- **V.A.T.S. slow-mo during a rotation.** While the table turns, time slows and the player aims a pull at a target. That's a dramatic, readable moment.

## 6. Scoring and progression hooks

- **Orientation multipliers.** Points are worth more while the table is sideways or upside down, which rewards playing in the hard orientation.
- **Collectibles only reachable at certain angles.** Coins or rubinium pieces placed in spots you can only roll into when the table is turned.
- **Locks and doors.** "Rotate to unlock": a gate that opens only when the table reaches a specific orientation, leading to a bonus area.
- **A goal for the table.** Light all targets across the four orientations to open the exit or earn an item. That gives the whole rotating idea a purpose.

## 7. Camera and feel

- **The camera rotates with the table.** The table always looks upright while gravity swings around on screen. That's disorienting in a fun way, and a mode worth trying.
- **The camera stays upright.** You watch the table turn. This is clearer, and probably the default.
- **Feedback:** a gravity-direction arrow near the ball, a sound or rumble when gravity changes, and particles drifting in the gravity direction.

## 8. Story tie-in

Plot.md already pairs abilities with scripture. A gravity or rotation section could use Acts 17:6, "These that have turned the world upside down are come hither also," to introduce the mechanic in the same way the jump and wall-run verses do.

---

## Suggested order to prototype

1. **Gravity flip pads without rotating the table** (section 3). This is the cheapest to try and the easiest for players to read.
2. **Player tilt with L1/R1** (section 1). It removes the "ball just rests" problem completely.
3. **Kickout saucers** (section 4). They're useful on any table, rotating or not.
4. **Stepped 90° rotations with flippers on multiple walls** (section 2). This is the biggest payoff, but it needs a table designed for it.

## What already exists in the code

- **Rotation switch:** `TEMP_PINBALL_ROTATION_SPEED` in main.lua, currently 0.
- **The table follows the planet's rotation:** `PinballInterior:tableToWorld` and `worldToTable`. The walls, bumpers, flippers and ball all rotate together, and the ball rides along.
- **Gravity direction:** `GRAVITY_ALWAYS_SCREEN_DOWN` in PinballInterior.lua. Gravity is applied as a vector in `updateBallInTable`, so flip pads and zones only need to change that vector.
- **Known gaps if rotation comes back:**
  - The orange entry beam doesn't turn with the planet.
  - The bumper highlights turn with the table.
  - At its current spot, a turning planet swings into the asteroid belt.
