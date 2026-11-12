# Future Updates

Plans for larger changes that aren't built yet. Each section says how things work today, why that needs to change, and a suggested route.

---

## Level loading and unloading (toward hundreds of levels)

**Goal:** a galaxy with hundreds of levels (sky domes, pinball tables, water worlds, Tiled planets), where only the levels near the player are loaded, and what the player did there is remembered.

### How it works today

- **Everything is built once, at startup.** `love.load` calls `World.build()` ([lua/levels/World.lua](../lua/levels/World.lua)), which builds every landmark and its contents: the sky dome and its Tiled interior, the pinball, water, cracked and Tiled planets, the expressway and the missile outposts. *Exit to title* runs `love.load` again and rebuilds all of it from scratch.
- **Landmarks are never streamed out.** The 3×3 cell streaming in [lua/setup/WorldGen.lua](../lua/setup/WorldGen.lua) (`cullDistantObjects`) only removes planetoids without `isPermanent` (belt and random planetoids). Every landmark is permanent, so it stays loaded wherever the player is.
- **Killed enemies stay dead.** Ooombas are created once, in `state.ooombas`. Killing one removes it from that list, and nothing re-creates it until *Exit to title*.
- **Everything updates every frame, near or far.** The `"world"` update pass in [lua/systems/WorldObjects.lua](../lua/systems/WorldObjects.lua) walks every Ooomba, fish, lever, gate, crank, mirror, sign, beam, spikey, rope rock, prism and lava effect every frame, however far away it is. The dome's water simulation (`WaterSystem.update`) also steps every frame. Only *drawing* is skipped for things off screen.
- **Landmarks take part in per-frame physics.** They sit in `state.planetoids`, so gravity (`GravitySystem:findDominantPlanet`) and collision passes look at them every frame.

### Why that won't scale

| With hundreds of levels… | Problem |
|---|---|
| All built at startup | Startup time grows with every level: parsing Tiled maps and baking level and planet images is the expensive part. |
| All kept in memory | Each level holds large baked images (the Tiled level, planet bodies, the pinball table) plus a water grid. Hundreds would use far too much memory, especially in the browser. |
| All updated every frame | Hundreds of enemies, switches and water grids simulated for nothing. |
| All in `state.planetoids` | Gravity and collision checks walk a list that keeps growing. |

### Step 1 (interim): sleeping

Before real loading exists, a cheap first step. It's only worth doing if profiling shows the far-away updates cost something.

- Give each landmark a **wake radius**. Its contents (enemies, switches, water) only update while the player is inside it.
- Everything stays in memory, frozen as it was left, so persistence comes for free: killed Ooombas stay dead, and levers stay where they were pulled.
- This fixes the per-frame cost, but not startup time or memory.

### Step 2: real loading and unloading — "regions"

Each level becomes a **region** with two parts:

| Part | Always loaded? | What it holds |
|---|---|---|
| **Shell** | Yes, small and cheap | Position, size and gravity (so pull beams, lock-on and landing still work from a distance); its minimap marker; its clear zone, which keeps random spawns off it; its beam and expressway connections; how to build its interior. |
| **Interior** | Only near the player | The Tiled level and its terrain shapes, enemies, switches, gates, signs, water grid, baked images, a pinball table, and so on. |

#### Lifecycle

```
unloaded  --(player within LOAD radius)-->     loading (spread over frames)
loading   --(done)-->                          active
active    --(player beyond UNLOAD radius)-->   save state, then unloaded
```

- **The load radius must be bigger than the view,** so a level is ready before it comes on screen.
- **The unload radius must be bigger than the load radius,** so a player hovering at the edge doesn't make it load and unload over and over.

#### Persistence: what each region remembers

Unloading throws the interior away, so anything the player changed has to be saved first and re-applied when it's rebuilt. A small table per region would do, for example:

- **Defeated enemies**, by their Tiled object id (every placed object already has one).
- **Switches and machinery:** lever on/off, gate open/closed, crank angle, mirror angle.
- **Terrain changes:** the cracked planet's destroyed bricks, fallen rope rocks, melted or frozen blocks.
- **Water and lava levels**, if they should survive. That's a choice: water could simply reset.
- **Collected things:** coins, mined prisms.

**Design decision to make per object type:** does it stay changed for good, or reset when you come back (Mario-style respawning)? For example, enemies might respawn while opened gates stay open. Decide this before building, because it determines what gets saved.

This same saved state is most of a **save-game file**, so the two features can share one format.

#### Avoiding hitches

Building an interior is slow: parsing the map, baking images, setting up the water grid. Ways to keep it from stalling the game:

- **Start early:** a load radius well beyond the screen edge.
- **Spread the work over several frames:** parse one frame, bake the next, spawn enemies after that.
- **Cache baked images** for recently left regions, so going back and forth is instant.
- **Pre-bake offline** later, if needed: save baked level images as PNGs at build time instead of making them at runtime.

#### Things that cross region boundaries

These need deciding before regions exist, or they'll break in odd ways:

- **Beams** between regions (the dome ↔ belt landing planet pair): the destination shell must exist even when its interior isn't loaded. Arriving triggers a load, and the player may need a short wait or fade.
- **Portals** stuck to a surface in a region that then unloads, and Ooombas or fireballs flung through a portal into an unloaded region.
- **Expressway exits** that route to landmarks: they only need the shell.
- **Scripted camera tours** (CameraDirector) that pan across several regions.
- **Lock-on, pull beam and the minimap**, which should keep working against shells.

#### Data-driven levels

Today every landmark is hand-placed in code (one module per landmark under `lua/levels/`). For hundreds of levels, positions and settings should come from **data**: a level list (a manifest) where each entry gives a region's map file, position, kind (dome, pinball, water, Tiled planet…), size and any settings. Adding a level then means adding a map and a manifest entry, not code. The `lua/levels/` modules would become one builder per *kind* of level instead of one per level.

#### Randomness

Some builders use random numbers: fish, Ooomba walking directions, prism clusters. If regions load in different orders, today's single shared random sequence would make each level come out differently every time. Give each region **its own random seed** (for example, derived from its id) so it always builds the same way, whatever order you visit in. This also keeps the replay test harness used for refactoring working.

#### Both versions

The JS port (`js/`) mirrors the Lua code and would need the same region system. Memory matters even more in the browser, so the web version benefits most.

### Suggested milestones

1. **Profile.** Measure what the far-away updates and the water simulation actually cost today.
2. **Sleeping** (Step 1), if profiling says it's worth it.
3. **Region shell/interior split** for one landmark, say the pinball planet: build its interior on approach and unload it when far away, with no persistence yet (it resets).
4. **Persistence:** a per-region saved state, starting with defeated enemies and switches.
5. **Move the sky dome and the other landmarks** to regions; settle the cross-region cases (beams, portals).
6. **Manifest-driven levels:** level data instead of per-level code.
7. **Spread loading over frames** and cache baked images; tune load and unload radii.
8. **Save games** built on the persisted region state.
9. **Port each step to `js/`.**

### Open questions

- Respawn or permanent, per object type (enemies, coins, switches, terrain damage, water)?
- How big can one region be? A single sky dome is already large. Does a region ever need to stream within itself?
- Should the galaxy map itself (the cell grid around the sun) be generated per region too, or stay one shared world?
- What happens to things in flight (missiles, fireballs, flung Ooombas) when their region unloads?
