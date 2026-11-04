-- lua/systems/WorldObjects.lua
--
-- The registry of the world's object lists (state.levers, state.coins,
-- state.fish, ...): how each kind is updated, when one is removed, how
-- it's culled and drawn, and how its list starts out each game. main.lua
-- doesn't loop over these lists itself — it calls
--
--   WorldObjects.reset()                 in resetWorldState
--   WorldObjects.update(pass, dt)        at each update pass
--   WorldObjects.draw(layer)             at each draw layer
--   WorldObjects.drawDialogues()         with the HUD
--   WorldObjects.anyDialogueActive()     to freeze the player while talking
--
-- To add a new kind of object:
--   1. describe it with kind(...) below;
--   2. put its key in an UPDATE_PASSES list (if it updates on its own);
--   3. put its key in a DRAW_LAYERS list (if it draws on its own).
-- Update order and draw order are listed separately because they really
-- do differ (a lever opens its gate during its own update, so gates
-- update after levers, but gates are drawn behind them).
--
-- Some lists aren't fully handled here: fireballs, ice bolts and plungers
-- are updated by main.lua itself, in the middle of its collision passes,
-- and only drawn and reset through this registry.

local state = require("lua.state")
local utils = require("lua.utils")
local Beam = require("lua.world.Beam")
local Lava = require("lua.world.Lava")
local Spikey = require("lua.world.Spikey")
local MissileOutpost = require("lua.world.MissileOutpost")
local PortalGun = require("lua.systems.PortalGun")
local WaterSystem = require("lua.systems.WaterSystem")
local CharacterShadows = require("lua.effects.CharacterShadows")

local WorldObjects = {}

local isOnScreen = utils.isOnScreen

-- ---------------------------------------------------------------------
-- Kinds
-- ---------------------------------------------------------------------
-- Each kind's spec (every field optional):
--   single       state[key] is one object, not a list
--   startsEmpty  reset() makes the list {} rather than nil
--   update(item, dt)
--   removeIf(item)   checked after update; true removes it (lists with
--                    removeIf are walked back to front)
--   onRemove(item)   called as it's removed
--   beforeUpdate()   once per frame, before the list's updates (only if
--                    the list exists)
--   visible(item)    false skips its draw (off-screen culling)
--   draw(item, i)    defaults to item:draw()
--   tooltip          also call item:drawTooltip() after drawing it
--   dialogue         has .dialogueActive and :drawDialogue()

local KINDS = {}

local function kind(key, spec)
  KINDS[key] = spec
end

kind("asteroids", {
  startsEmpty = true,
  update = function(a) a:update() end,
  visible = function(a) return isOnScreen(a.pos.x, a.pos.y, a.radius, 50) end,
})

kind("coins", {
  startsEmpty = true,
  update = function(c) c:update() end,
  visible = function(c) return isOnScreen(c.pos.x, c.pos.y, c.radius, 20) end,
})

kind("ropeRocks", {
  -- Rocks swinging on ropes (see lua/world/RopeRock.lua).
  update = function(rr) rr:update(state.timeScale) end,
  visible = function(rr) return isOnScreen(rr.pos.x, rr.pos.y, rr.radius + rr.ropeLength, 50) end,
})

kind("ooombas", {
  update = function(o) o:update() end,
  -- Flung off through a portal and never came down (see Ooomba:updateAirborne).
  removeIf = function(o) return o.lost end,
  -- (Mid-portal it's split across both portals, either of which may be
  -- the one on screen — see PortalGun.drawOoomba.)
  visible = function(o)
    return o.portalTransit or isOnScreen(o.pos.x, o.pos.y, math.max(o.halfWidth, o.halfHeight), 20)
  end,
  draw = function(o, i)
    PortalGun.drawOoomba(o)
    -- ...with the shadows of any in front of it falling on it.
    CharacterShadows.drawOntoOoomba(i)
    -- ...and, frozen, the ice cube round it (see WaterSystem.lua's "Ice").
    if o.iceBlock then WaterSystem.drawIceCube(o.iceBlock) end
  end,
})

kind("fireBars", {
  startsEmpty = true,
  update = function(bar) bar:update() end,
  visible = function(bar) return isOnScreen(bar.pos.x, bar.pos.y, bar.barLength + bar.fireballRadius, 50) end,
})

kind("lavas", {
  -- (The lava itself is a liquid, in WaterSystem; these are the effects
  -- played over lava turning to obsidian and back.)
  startsEmpty = true,
  beforeUpdate = function() Lava.updateSharedClock() end,
  update = function(lava) lava:update() end,
  visible = function(lava) return isOnScreen(lava.pos.x, lava.pos.y, lava.radius, 50) end,
})

kind("spikeys", {
  -- A plain Spikey never moves and has no :update(); the moving kinds
  -- (SpikeyVertical, SpikeyOrbit) do.
  update = function(sp) if sp.update then sp:update() end end,
  visible = function(sp) return isOnScreen(sp.pos.x, sp.pos.y, sp.radius, 50) end,
})

kind("levers", {
  update = function(lever) lever:update() end,
  visible = function(lever) return isOnScreen(lever.pos.x, lever.pos.y, 80, 20) end,
  tooltip = true,
})

kind("cranks", {
  update = function(crank) crank:update() end,
  visible = function(crank) return isOnScreen(crank.pos.x, crank.pos.y, 80, 20) end,
  tooltip = true,
})

kind("plungers", {
  -- Updated by main.lua alongside the player's collisions (they're solid
  -- to him) — see lua/world/Plunger.lua.
  visible = function(plunger) return isOnScreen(plunger.pos.x, plunger.pos.y, plunger.radius, 20) end,
})

kind("signs", {
  update = function(sign) sign:update() end,
  visible = function(sign) return isOnScreen(sign.pos.x, sign.pos.y, 80, 20) end,
  tooltip = true,
  dialogue = true,
})

kind("mirrors", {
  update = function(mirror) mirror:update() end,
  visible = function(mirror) return isOnScreen(mirror.pos.x, mirror.pos.y, 80, 20) end,
})

kind("beams", {
  update = function(beam) beam:update() end,
  visible = function(beam) return isOnScreen(beam.pos.x, beam.pos.y, Beam.LENGTH, 60) end,
  tooltip = true,
})

kind("gates", {
  update = function(gate) gate:update(state.timeScale or 1) end,
  visible = function(gate)
    return isOnScreen(gate.pos.x, gate.pos.y, math.max(gate.halfWidth, gate.halfHeight), 20)
  end,
})

kind("fish", {
  update = function(fish) fish:update() end,
  visible = function(fish) return isOnScreen(fish.pos.x, fish.pos.y, 70, 50) end,
})

kind("spaceShelter", {
  single = true,
  -- Held at the very start of its opening sequence for as long as the
  -- title screen is up (see TitleScreen.lua) — the door only starts
  -- opening once the game has actually begun. (Drawn by love.draw
  -- itself: its body and door go at different depths.)
  update = function(shelter, dt)
    if state.titleScreen then return end
    shelter:update(dt)
    if state.introLocked and shelter.introDone then
      state.introLocked = false
    end
  end,
})

kind("robotButler", {
  single = true,
  update = function(r) r:update() end,
  visible = function(r) return isOnScreen(r.pos.x, r.pos.y, math.max(r.halfWidth, r.halfHeight), 20) end,
  tooltip = true,
  dialogue = true,
})

kind("fisherman", {
  single = true,
  update = function(f) f:update() end,
  -- drawBoundRadius, not just his body: his fishing line reaches far
  -- below him, and the whole rig must stay drawn while the camera is
  -- near the water it dangles into (see Fisherman.lua).
  visible = function(f) return isOnScreen(f.pos.x, f.pos.y, f.drawBoundRadius, 20) end,
  tooltip = true,
  dialogue = true,
})

kind("prisms", {
  update = function(prism, dt) prism:update(dt * (state.timeScale or 1)) end,
  visible = function(m) return isOnScreen(m.planet.pos.x, m.planet.pos.y, m:reach(), 50) end,
})

kind("elementPieces", {
  -- Rubinium and asteroidium on their way to him (see
  -- lua/entities/ElementPiece.lua): each piece that arrives is counted
  -- and gone.
  startsEmpty = true,
  update = function(piece, dt) piece:update(dt * (state.timeScale or 1), state.player) end,
  removeIf = function(piece) return piece.collected end,
  onRemove = function(piece)
    state.elements[piece.elementName] = state.elements[piece.elementName] + 1
    if state.audioManager then state.audioManager:playEatDot() end
  end,
  visible = function(piece) return isOnScreen(piece.pos.x, piece.pos.y, piece.radius, 50) end,
})

-- Updated by main.lua (they collide with nearly everything).
kind("fireballs", { startsEmpty = true })
kind("iceBolts", { startsEmpty = true })

-- Purely time-driven visuals (see lua/entities/Explosion.lua,
-- WallContactPulse.lua, Particle.lua).
kind("explosions", {
  startsEmpty = true,
  update = function(e) e:update() end,
  removeIf = function(e) return e:isDead() end,
})
kind("wallContactPulses", {
  startsEmpty = true,
  update = function(p) p:update() end,
  removeIf = function(p) return p:isDead() end,
})
kind("particles", {
  startsEmpty = true,
  update = function(p) p:update() end,
  removeIf = function(p) return p.life <= 0 end,
})

-- ---------------------------------------------------------------------
-- Update passes
-- ---------------------------------------------------------------------
-- Run in order by WorldObjects.update(pass, dt). A string is a kind's
-- key; a function is a plain step that has to happen at that point.

-- The belt outposts: their Ooombas noticing him, manning the cannons,
-- and the homing missiles (see lua/world/MissileOutpost.lua). Not while
-- the title screen's own autopilot is playing.
local function updateMissileOutposts()
  if not state.outposts then return end
  if state.titleScreen then
    MissileOutpost.restock(state.outposts)
  else
    MissileOutpost.updateAll(state.outposts, state.player)
  end
end

local function updateSharedClocks()
  Spikey.updateSharedClock()
end

local UPDATE_PASSES = {
  -- After the planetoids have moved (and Recall has rewound any), before
  -- the player moves.
  world = {
    "ropeRocks", "asteroids", "coins", "ooombas",
    updateMissileOutposts,
    "fireBars", "lavas",
    updateSharedClocks,
    "spikeys", "levers", "cranks", "signs", "mirrors", "beams", "gates",
    "fish", "spaceShelter", "robotButler", "fisherman", "prisms",
    "elementPieces",
  },
  -- At the end of the frame, after every collision has spawned its
  -- effects.
  effects = { "explosions", "wallContactPulses", "particles" },
}

-- ---------------------------------------------------------------------
-- Draw layers
-- ---------------------------------------------------------------------
-- Each drawn back to front, in world space, by WorldObjects.draw(layer);
-- see love.draw for where each layer sits in the scene.
local DRAW_LAYERS = {
  -- Behind the planetoids.
  backdrop = { "asteroids" },
  -- Before the planetoids, so the one each stands on covers its sunken
  -- foot (see lua/world/Prism.lua).
  planetFeet = { "prisms" },
  -- Over the planetoids and cannons, behind the Tiled level.
  hazards = { "spikeys" },
  -- Over the Tiled level.
  props = { "ropeRocks", "gates", "levers", "plungers", "cranks", "signs", "mirrors" },
  enemies = { "ooombas" },
  -- Over the outposts' missiles; behind the portals and the player
  -- (beams go last so he stands in front of one he's at).
  actors = { "robotButler", "fisherman", "coins", "fireBars", "beams" },
  -- After the player and before the water's top layer, so the water (or
  -- lava) covers them, reading as submerged.
  submerged = { "fish", "lavas" },
  -- Over everything else in the world.
  effects = { "fireballs", "iceBolts", "particles", "elementPieces", "explosions", "wallContactPulses" },
}

-- Characters with conversations, in the order their textboxes draw.
local DIALOGUE_KINDS = { "robotButler", "fisherman", "signs" }

-- Everything the player can interact with (Enter / Circle — see
-- lua/world/Interactable.lua), in the order a press reaches them. Each
-- one's :tryInteract checks for itself whether he's close enough.
local INTERACTIVE_KINDS = { "robotButler", "fisherman", "levers", "cranks", "signs", "beams" }

-- ---------------------------------------------------------------------
-- Running them
-- ---------------------------------------------------------------------

local function eachItem(key, fn)
  local spec = KINDS[key]
  local value = state[key]
  if value == nil then return end
  if spec.single then
    fn(value, 1)
  else
    for i, item in ipairs(value) do fn(item, i) end
  end
end

-- Every list back to how a new game starts it: {} for startsEmpty
-- kinds, otherwise nil (the world builder creates them).
function WorldObjects.reset()
  for key, spec in pairs(KINDS) do
    state[key] = spec.startsEmpty and {} or nil
  end
end

local function updateKind(key, dt)
  local spec = KINDS[key]
  local list = state[key]
  if list == nil or not spec.update then return end
  if spec.beforeUpdate then spec.beforeUpdate() end
  if spec.single then
    spec.update(list, dt)
  elseif spec.removeIf then
    -- (Finished ones noted as they go and removed together at the end —
    -- see utils.removeMarked.)
    local gone
    for i = #list, 1, -1 do
      local item = list[i]
      spec.update(item, dt)
      if spec.removeIf(item) then
        if spec.onRemove then spec.onRemove(item) end
        gone = gone or {}
        gone[item] = true
      end
    end
    if gone then utils.removeMarked(list, gone) end
  else
    for _, item in ipairs(list) do spec.update(item, dt) end
  end
end

function WorldObjects.update(pass, dt)
  for _, entry in ipairs(UPDATE_PASSES[pass]) do
    if type(entry) == "function" then
      entry(dt)
    else
      updateKind(entry, dt)
    end
  end
end

function WorldObjects.draw(layer)
  for _, key in ipairs(DRAW_LAYERS[layer]) do
    local spec = KINDS[key]
    local visible, draw, tooltip = spec.visible, spec.draw, spec.tooltip
    eachItem(key, function(item, i)
      if visible and not visible(item) then return end
      if draw then draw(item, i) else item:draw() end
      if tooltip then item:drawTooltip() end
    end)
  end
end

-- The interact button (Enter, or Circle on a pad): offered to everything
-- interactive. Not while he's curled into a ball — no talking to NPCs or
-- pulling levers as a ball.
function WorldObjects.interact(player)
  if not player or player.isBall then return end
  for _, key in ipairs(INTERACTIVE_KINDS) do
    eachItem(key, function(item) item:tryInteract(player) end)
  end
end

function WorldObjects.drawDialogues()
  for _, key in ipairs(DIALOGUE_KINDS) do
    eachItem(key, function(item) item:drawDialogue() end)
  end
end

-- Recomputed fresh every frame (never a flag some NPC sets and might
-- forget to clear) from whichever characters have a textbox open now.
function WorldObjects.anyDialogueActive()
  for _, key in ipairs(DIALOGUE_KINDS) do
    local value = state[key]
    if value ~= nil then
      if KINDS[key].single then
        if value.dialogueActive then return true end
      else
        for _, item in ipairs(value) do
          if item.dialogueActive then return true end
        end
      end
    end
  end
  return false
end

return WorldObjects
