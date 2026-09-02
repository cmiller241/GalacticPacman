-- lua/setup/assetLoading.lua
--
-- Direct translation of js/setup/assetLoading.js, with one structural
-- simplification that falls out naturally from how LÖVE's own asset
-- loading works: love.graphics.newImage(path) is SYNCHRONOUS — it
-- decodes the image and returns it ready to use before the call even
-- returns, unlike JS's `new Image(); img.src = ...; img.onload = ...`
-- pattern. That means the original's entire assetsLoaded/
-- ASSETS_TO_LOAD/onAssetLoaded counting apparatus — needed there
-- specifically to detect "every async load has now finished" — has
-- nothing to do here and is gone. loadAssets() just loads everything
-- directly, in order, and by the time the last line runs, it's all
-- already loaded.
--
-- loadAssets still takes an onComplete callback, even though nothing
-- here is actually async anymore — the original comment's own stated
-- reason for that parameter was decoupling this module from
-- levelSetup.js/game.js, not managing asynchrony, and that reasoning
-- holds regardless of language. onComplete now just fires
-- immediately, synchronously, at the end — a caller relying on any
-- deferred timing here would be relying on something the JS version
-- never actually promised either, since it only ever fired once
-- loading was ACTUALLY done.
--
-- One real gap, flagged rather than guessed at: initResizeListener()
-- has no direct call-site equivalent here. LÖVE handles window
-- resizing through its own love.resize(w, h) callback, invoked
-- automatically by the runtime whenever the window changes size —
-- there's no explicit "listener" to register the way
-- window.addEventListener('resize', ...) requires in JS. That
-- callback belongs wherever love.load/love.update/love.draw already
-- live (main.lua), not here — I don't have utils.js's own
-- initResizeListener() implementation, so I'm not guessing at what
-- state fields it updates on resize; that's a genuine follow-up, not
-- something silently ported.

local state = require("lua.state")
local AudioManager = require("lua.AudioManager")

local CHARACTER_IMAGE_SOURCES = {
  body = 'img/body.png',
  head = 'img/head.png',
  leftarm = 'img/leftarm.png',
  rightarm = 'img/rightarm.png',
  leftboot = 'img/leftboot.png',
  rightboot = 'img/rightboot.png'
}

local function loadAssets(onComplete)
  state.characterImages = {}

  state.planetTexture = love.graphics.newImage("img/planet_texture_2.jpg")

  -- SkyDomePlanetoid's ground tile — 32x32, tiled pixel-perfectly
  -- across its body instead of the default rocky planetTexture (see
  -- SkyDomePlanetoid.drawBodyTexture).
  -- JumpPlatform's tileset — replaces the old ground.png (now unused
  -- entirely, since JumpPlatform's pillar mechanism was removed in
  -- favor of this tileset's own bottom-row tiles covering that role).
  state.platformTexture = love.graphics.newImage("img/platform.png")

  -- Goomba enemy — 64x32, two 32x32 tiles (standing, walking).
  state.goombaTexture = love.graphics.newImage("img/goomba.png")

  -- Ooomba enemy (patrols the sky dome's terrain) — 2400x950, three
  -- 800x950 frames: standing, walk-forward-A, walk-forward-B. Explicitly
  -- kept smooth/"linear" rather than the game's pixel-art "nearest"
  -- default (see love.load's setDefaultFilter) — this sprite reads
  -- better with soft shading than as crisp pixel art, same reasoning
  -- Planetoid's own canvas already overrides the default for.
  state.oombaTexture = love.graphics.newImage("img/Ooomba.png")
  state.oombaTexture:setFilter("linear", "linear")

  -- SkyDomePlanetoid's grass cap — a single 32x16 tile, drawn as a
  -- thin strip right at the flat top line, on top of the metal base
  -- (see SkyDomePlanetoid.drawGrassCap).
  state.grassTexture = love.graphics.newImage("img/grass.png")

  -- Astronaut's home shelter — a single static background structure on
  -- the sky dome's own deck (see lua/world/SpaceShelter.lua). 4880x3404.
  state.spaceShelterTexture = love.graphics.newImage("img/spaceshelter.png")
  state.spaceShelterTexture:setFilter("linear", "linear")

  -- One half of the shelter's own double door (551x1873) — the other
  -- half is this same image mirrored, not a separate source file (see
  -- SpaceShelter.lua's own drawDoor).
  state.spaceShelterDoorTexture = love.graphics.newImage("img/spaceshelter_door.png")
  state.spaceShelterDoorTexture:setFilter("linear", "linear")

  for key, src in pairs(CHARACTER_IMAGE_SOURCES) do
    state.characterImages[key] = love.graphics.newImage(src)
  end

  -- The compact single-boot rendering (maze/platform/death modes)
  -- reuses the same leftboot image — no need to load it twice.
  state.bootImage = state.characterImages.leftboot

  -- Init audio
  state.audioManager = AudioManager.new()

  -- Window-resize handling belongs in love.resize(w, h), defined
  -- elsewhere — see this file's own header comment above.

  if onComplete then
    onComplete()
  end
end

return {
  loadAssets = loadAssets
}