-- lua/constants.lua
--
-- Direct, verified translation of js/constants.js — confirmed against
-- an actual copy of that file (not reconstructed from memory), so
-- these values are exact, not approximated. Lua modules don't have
-- individual named exports the way ES modules do; the standard,
-- idiomatic pattern is a single table returned at the end of the
-- file, then `local constants = require("lua.constants")` wherever
-- it's needed, reading e.g. constants.GRAVITY_STRENGTH instead of a
-- bare imported name — Lua has no equivalent of JS's
-- `import { X } from ...` destructuring into local names.

local constants = {}

constants.GRAVITY_STRENGTH = 0.35
constants.GROUND_POUND_GRAV_MULTIPLIER = 3
constants.GROUND_POUND_PUSH_STRENGTH = 0.05
constants.JUMP_STRENGTH = 10
constants.MOVE_SPEED = 0.5
constants.PLAYER_LINEAR_SPEED = 5
constants.PLAYER_RADIUS = 30
constants.ENEMY_RADIUS = 20
constants.COIN_RADIUS = 10
constants.COIN_ORBIT_OFFSET = 25
constants.INFLUENCE_PADDING = 200
constants.SURFACE_TOLERANCE = 4
constants.DRAG = 0.995
constants.PLANET_SPEED = 1
constants.ENEMY_JUMP_PROB = 0.0005
constants.STAR_COUNT = 800

-- JS array literals become plain Lua tables with 1-based integer
-- keys (Lua has no separate array type — this IS the array, same
-- table type used for everything else) — iterate with ipairs(), not
-- pairs(), to get them back out in order.
constants.enemyColors = { 'red', 'pink', 'cyan', 'orange' }
constants.planetColors = { 'green', 'purple', 'orange', 'yellow', 'red', 'cyan' }

return constants