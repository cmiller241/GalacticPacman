-- lua/state.lua
--
-- Direct translation of js/state.js. Same pattern as constants.lua:
-- a single table, returned once, `require`'d wherever it's needed —
-- Lua's require() caches modules, so every require("lua.state")
-- across every file returns the exact same table instance, which is
-- the same shared-singleton behavior state.js relies on via ES
-- module semantics.
--
-- `canvas` and `ctx` are kept as fields (set to nil) purely so this
-- table's shape stays visibly parallel to the original for anyone
-- comparing the two side by side — but they don't serve any real
-- purpose in LÖVE. There's no DOM, no <canvas> element, and no
-- separate drawing-context object to hold a reference to: love.graphics
-- is a global module that draws directly to the window from anywhere,
-- so code that would have checked state.ctx before drawing in JS
-- just calls love.graphics.* directly instead in the ported version.

local state = {}

state.canvas = nil  -- no LÖVE equivalent — see comment above
state.ctx = nil      -- no LÖVE equivalent — see comment above

state.sceneWidth = 0
state.sceneHeight = 0

state.player = nil

-- JS [] becomes a plain empty Lua table — Lua has no separate array
-- type, so this is both "the list" and "the object" at once. Use
-- table.insert(state.planetoids, newPlanetoid) in place of .push(),
-- and ipairs(state.planetoids) to iterate in order.
state.planetoids = {}  -- includes regular, spikey, and maze planets
state.asteroids = {}
state.enemies = {}     -- ghosts
state.coins = {}
state.particles = {}

state.score = 0
state.level = 1
state.gameOver = false
state.levelComplete = false

state.stars = {}

-- keys was a plain {} object in JS used as a lookup/set (e.g.
-- keys['ArrowUp'] = true), not an array — same table type in Lua,
-- same usage: state.keys["up"] = true, then `if state.keys["up"]
-- then ... end` to check it. LÖVE's own love.keypressed(key) /
-- love.keyreleased(key) callbacks are the natural place to set these,
-- mirroring wherever the JS version's keydown/keyup listeners live.
state.keys = {}

state.eatDotIndex = 0
state.lastAlphaUpdate = 0
state.lastFrameTime = 0
state.fps = 0

return state