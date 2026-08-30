-- lua/effects/VatsOverlay.lua
--
-- Port of js/effects/VatsOverlay.js
-- Draws a full-viewport dark overlay with VHS-style scan lines while
-- V.A.T.S. is active, with a hole cut out around state.player.lockedTarget
-- (if any) so the locked object stays at full brightness — reinforced
-- further by the yellow LockOutline.lua ring still drawn on top of it.

local state = require("lua.state")
local utils = require("lua.utils")

local OVERLAY_ALPHA = 0.55        -- max darkness, reached once fully into V.A.T.S.
local CUTOUT_PADDING = 14         -- slightly beyond LockOutline.lua's own OUTLINE_PADDING (8), so the cutout comfortably surrounds the yellow outline rather than clipping it

-- Real, ALTERNATING light/dark bands baked into a small repeating tile —
-- a single faint line relying on absolute brightness (the first version
-- of this, in the original) is invisible against an already-dark scene
-- with a dark overlay on top of THAT. What reads as "scan lines" is the
-- CONTRAST between an explicit lighter band and an explicit darker
-- (here: fully transparent) band sitting right next to each other.
local SCANLINE_SPACING = 5        -- px per full light+dark cycle
local SCANLINE_LIGHT_ALPHA = 0.15 -- the lighter band
local SCANLINE_FLICKER_MIN = 0.8  -- flicker only ever dims the WHOLE pattern down to this fraction, never further
-- love.timer.getTime() is SECONDS; the original's ms-based rates
-- (0.01/ms flicker, 0.015 px/ms drift) become *1000 here.
local SCANLINE_FLICKER_RATE = 10   -- was 0.01 per ms
local SCANLINE_DRIFT_SPEED = 15    -- px/second, was 0.015 px/ms — a slow vertical roll, like an old tape's vertical hold drifting

local VatsOverlay = {}

-- Built once and reused across frames — a 1px-wide, SCANLINE_SPACING-
-- tall tile with its top half baked as the light band and bottom half
-- left fully transparent, tiled via Canvas:setWrap("repeat") + an
-- oversized Quad rather than manually looping rectangle draws.
local scanlineTile = nil
local function getScanlineTile()
  if scanlineTile then return scanlineTile end
  scanlineTile = love.graphics.newCanvas(1, SCANLINE_SPACING)
  scanlineTile:setWrap("repeat", "repeat")
  scanlineTile:setFilter("nearest", "nearest")

  -- push/origin: this is built lazily on VatsOverlay.draw()'s first
  -- call, which happens while the outer world-space zoom/translate
  -- transform (see love.draw() in main.lua) is already active — without
  -- resetting to identity first, the fill below would be drawn through
  -- THAT transform instead of in the tile's own 1xSCANLINE_SPACING
  -- pixel grid, permanently baking a wrong (and since this is cached
  -- and only ever built once, never-corrected) result into the tile.
  love.graphics.push()
  love.graphics.origin()
  love.graphics.setCanvas(scanlineTile)
  love.graphics.clear(0, 0, 0, 0)
  love.graphics.setColor(1, 1, 1, SCANLINE_LIGHT_ALPHA)
  love.graphics.rectangle("fill", 0, 0, 1, SCANLINE_SPACING / 2)
  love.graphics.setCanvas()
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.pop()

  return scanlineTile
end

-- Built once and reused across frames (resized only when the needed
-- dimensions actually change) — a SEPARATE canvas from the main
-- framebuffer, so the destination-out-style cutout below only ever
-- erases THIS layer's own pixels (the dark fill + scan lines drawn
-- into it moments ago) rather than anything already on screen. Doing
-- the cutout directly against the main framebuffer would erase
-- whatever had already been drawn there this frame (the planet
-- underneath it, in particular) instead of just revealing it.
local overlayCanvas = nil
local function getOverlayLayer(w, h)
  w = math.max(1, math.ceil(w))
  h = math.max(1, math.ceil(h))
  if not overlayCanvas or overlayCanvas:getWidth() ~= w or overlayCanvas:getHeight() ~= h then
    overlayCanvas = love.graphics.newCanvas(w, h)
  end
  return overlayCanvas
end

-- Opacity tracks state.vatsMultiplier's own progress toward
-- state.vatsTimeScale (0 at normal speed, 1 once fully slowed) rather
-- than snapping on/off with state.vatsActive directly — main.lua eases
-- vatsMultiplier toward its target gradually, and tying the overlay to
-- that same curve keeps the darkening and the slowdown reading as one
-- cohesive transition.
--
-- Deliberately state.vatsMultiplier, NOT state.timeScale: main.lua's
-- own comment on timeScale explains why — timeScale is vatsMultiplier
-- multiplied by frameNorm (this frame's real-time normalization
-- factor), which jitters slightly around 1 every frame with ordinary
-- frame-time variance even while VATS is fully off. Using timeScale
-- here meant `progress` kept flickering just above zero on slightly-
-- slow frames, which read as the whole screen strobing — most visible
-- against the sky dome's own brightness. vatsMultiplier is the clean
-- easing value with no per-frame timing noise in it.
--
-- Called every frame from love.draw(), inside the same zoom/camera-
-- transformed push() block as everything else in world space.
function VatsOverlay.draw()
  local vatsTimeScale = state.vatsTimeScale or 0.05
  local denom = 1 - vatsTimeScale
  local progress = denom > 0 and ((1 - (state.vatsMultiplier or 1)) / denom) or 0
  if progress <= 0 then return end

  local cam = state.camera or { x = 0, y = 0 }
  local vw = state.visibleWidth or 0
  local vh = state.visibleHeight or 0
  if vw <= 0 or vh <= 0 then return end

  local layer = getOverlayLayer(vw, vh)
  local tile = getScanlineTile()
  local lw, lh = layer:getWidth(), layer:getHeight()

  -- push/origin: resets to an identity transform for everything drawn
  -- INTO layer below, so (0,0)-(lw,lh) means the canvas's own top-left
  -- pixel corner, not a point run through the outer world-space zoom/
  -- translate this function is called under (see love.draw()) — that
  -- outer transform only applies again once this layer is composited
  -- onto the main framebuffer further down, outside this push/pop.
  love.graphics.push()
  love.graphics.origin()

  love.graphics.setCanvas(layer)
  love.graphics.clear(0, 0, 0, 0)
  love.graphics.setBlendMode("alpha")
  love.graphics.setColor(0, 0, 0, OVERLAY_ALPHA)
  love.graphics.rectangle("fill", 0, 0, lw, lh)

  -- Scan lines, on top of the base dark fill but still BEFORE the
  -- cutout below, so the cutout removes them from the locked target's
  -- own area too. A slow drift (via the quad's own texture-space
  -- offset, which wraps automatically) plus a gentle alpha flicker
  -- sells the "old tape" feel. The flicker only ever scales the WHOLE
  -- pattern between SCANLINE_FLICKER_MIN and 1 — a floor, not a fade
  -- to nothing.
  local now = love.timer.getTime()
  local flickerT = (math.sin(now * SCANLINE_FLICKER_RATE) + 1) / 2
  local flicker = SCANLINE_FLICKER_MIN + (1 - SCANLINE_FLICKER_MIN) * flickerT
  local driftY = (now * SCANLINE_DRIFT_SPEED) % SCANLINE_SPACING
  local quad = love.graphics.newQuad(0, -driftY, lw, lh, tile:getWidth(), tile:getHeight())
  love.graphics.setColor(1, 1, 1, flicker)
  love.graphics.draw(tile, quad, 0, 0)

  -- Cutout: punches a hole (fully transparent, alpha 0) in THIS
  -- layer's own pixels around the locked target — same shape
  -- detection LockOutline.lua uses, so the hole matches the outline.
  -- "replace" blend mode overwrites destination pixels outright
  -- (including alpha) instead of blending, which is what actually
  -- erases rather than just drawing transparent-over-opaque (which
  -- alpha-blending a 0-alpha color would otherwise no-op).
  local target = state.player and state.player.lockedTarget
  if target then
    local localX = target.pos.x - cam.x
    local localY = target.pos.y - cam.y
    local radius = utils.boundingRadius(target) + CUTOUT_PADDING

    love.graphics.setBlendMode("replace", "premultiplied")
    love.graphics.setColor(0, 0, 0, 0)
    love.graphics.circle("fill", localX, localY, radius)
    love.graphics.setBlendMode("alpha")
  end

  love.graphics.setCanvas()
  love.graphics.pop()

  -- Composite the finished overlay onto the main framebuffer with
  -- normal blending, scaled by the overall V.A.T.S. fade progress.
  -- Already under the same zoom/translate transform as everything
  -- else in this draw pass (see love.draw()), so drawing at
  -- (cam.x, cam.y) — the same world-space point this layer's own
  -- (0,0) represents — lines up automatically; the layer's pixel
  -- dimensions were built equal to vw/vh (world units) in the first
  -- place, so no extra scale is needed either.
  love.graphics.setColor(1, 1, 1, progress)
  love.graphics.draw(layer, cam.x, cam.y)
  love.graphics.setColor(1, 1, 1, 1)
end

return VatsOverlay
