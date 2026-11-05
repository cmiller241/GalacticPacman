-- lua/state.lua
--
-- The game's shared state: one table, returned once and `require`d
-- wherever it's needed (require caches modules, so every file gets the
-- same table). The fields below are the ones that exist from the start;
-- the rest are set by love.load and the systems that own them.

local state = {}

state.sceneWidth = 0
state.sceneHeight = 0

state.player = nil

state.planetoids = {}  -- every planet: regular, spikey, landmarks
state.asteroids = {}
state.enemies = {}     -- ghosts
state.coins = {}
state.particles = {}

state.score = 0
state.level = 1

state.stars = {}

-- Keys held right now, by name (state.keys["ArrowLeft"] = true), set by
-- the input handlers (see lua/setup/InputHandlers.lua).
state.keys = {}

state.eatDotIndex = 0
state.lastAlphaUpdate = 0
state.lastFrameTime = 0
state.fps = 0

return state
