-- lua/world/SpaceShelter.lua
--
-- A static background structure on the sky dome's own deck — the
-- astronaut's home. No collision; the only "gameplay" role it plays is
-- the game's opening beat: the player spawns behind its closed door
-- (see main.lua), the door slides open, the player's own draw order
-- swaps to stand in front of it once fully open, then it closes behind
-- them — see the intro state machine below.
--
-- Scaled to match Ooomba's own established world-per-source-pixel
-- ratio (Ooomba.lua: an 800x950 source frame drawn at 90 world units
-- tall) rather than picking a size of its own, so the shelter reads as
-- proportionate to the Ooomba already standing in the same scene.

local state = require("lua.state")

local SpaceShelter = {}
SpaceShelter.__index = SpaceShelter

-- Ooomba.lua's own scale, kept as an explicit ratio here rather than
-- read from that module at runtime — the two sprites are independent,
-- they just share this one "world units per source pixel" convention:
-- 90 world units per 950 source pixels tall.
local WORLD_UNITS_PER_SOURCE_PIXEL = 90 / 950

-- The door (img/spaceshelter_door.png, 551x1873) is authored as ONE
-- half only — this is where THAT unflipped image goes, in the base
-- shelter image's own UNSCALED pixel space (top-left corner). The
-- other half is this exact same source image mirrored horizontally
-- (see drawDoor), not a separate file — placed so its own inner edge
-- meets this half's inner edge (its right edge) with no gap or overlap.
local DOOR_LEFT_X = 3729
local DOOR_TOP_Y = 1155

-- Opening-cutscene timing (see :update). A beat closed, a slide open,
-- a beat standing open (player revealed), a slide shut — then normal
-- gameplay control.
local PHASE_HOLD_CLOSED = "holdClosed"
local PHASE_OPENING = "opening"
local PHASE_HOLD_OPEN = "holdOpen"
local PHASE_CLOSING = "closing"
local PHASE_DONE = "done"

local HOLD_CLOSED_SECONDS = 0.6
local OPEN_SECONDS = 1.6
local HOLD_OPEN_SECONDS = 1.2
local CLOSE_SECONDS = 1.6

-- x, bottomY: world position of the shelter's own base (where it meets
-- the deck) — bottomY should be whatever surface it's resting on
-- (SkyDomePlanetoid:trueSurfaceY() for the sky dome's own deck).
function SpaceShelter.new(x, bottomY, options)
  options = options or {}
  local self = setmetatable({}, SpaceShelter)

  self.pos = { x = x, y = bottomY }

  local img = state.spaceShelterTexture
  local sourceW, sourceH
  if img then
    sourceW, sourceH = img:getDimensions()
  else
    sourceW, sourceH = 4880, 3404
  end
  self.sourceW, self.sourceH = sourceW, sourceH

  local scale = options.scale or WORLD_UNITS_PER_SOURCE_PIXEL
  self.drawWidth = sourceW * scale
  self.drawHeight = sourceH * scale
  self.scaleX = self.drawWidth / sourceW
  self.scaleY = self.drawHeight / sourceH

  -- Opening-cutscene state — see the PHASE_* constants above.
  -- doorOpenFraction: 0 fully closed, 1 fully open (drives drawDoor's
  -- own slide-and-clip). playerInFront: false while the player should
  -- draw BEHIND the door (see main.lua's draw order), flips true the
  -- instant the door reaches fully open and stays true from then on —
  -- once the player has stepped out, they never need to duck back
  -- behind this door again. introDone: true once the whole sequence
  -- (closed -> open -> closed) has finished, which is what main.lua
  -- gates normal player movement input on.
  self.introPhase = PHASE_HOLD_CLOSED
  self.introTimer = 0
  self.doorOpenFraction = 0
  self.playerInFront = false
  self.introDone = false

  return self
end

-- World position of the doorway's own ground-level center (where the
-- two door halves meet) — where main.lua spawns the player for the
-- opening cutscene.
function SpaceShelter:getDoorwayPosition()
  local doorImg = state.spaceShelterDoorTexture
  local doorW = doorImg and (select(1, doorImg:getDimensions())) or 551
  local centerPx = DOOR_LEFT_X + doorW
  local x = self.pos.x + (centerPx - self.sourceW / 2) * self.scaleX
  return x, self.pos.y
end

function SpaceShelter:update(dt)
  if self.introPhase == PHASE_DONE then return end

  self.introTimer = self.introTimer + dt

  if self.introPhase == PHASE_HOLD_CLOSED then
    self.doorOpenFraction = 0
    if self.introTimer >= HOLD_CLOSED_SECONDS then
      self.introPhase, self.introTimer = PHASE_OPENING, 0
    end

  elseif self.introPhase == PHASE_OPENING then
    local t = math.min(1, self.introTimer / OPEN_SECONDS)
    self.doorOpenFraction = 0.5 - 0.5 * math.cos(t * math.pi) -- eased 0 -> 1
    if t >= 1 then
      self.introPhase, self.introTimer = PHASE_HOLD_OPEN, 0
      self.doorOpenFraction = 1
      self.playerInFront = true
    end

  elseif self.introPhase == PHASE_HOLD_OPEN then
    self.doorOpenFraction = 1
    if self.introTimer >= HOLD_OPEN_SECONDS then
      self.introPhase, self.introTimer = PHASE_CLOSING, 0
    end

  elseif self.introPhase == PHASE_CLOSING then
    local t = math.min(1, self.introTimer / CLOSE_SECONDS)
    self.doorOpenFraction = 1 - (0.5 - 0.5 * math.cos(t * math.pi)) -- eased 1 -> 0
    if t >= 1 then
      self.introPhase = PHASE_DONE
      self.doorOpenFraction = 0
      self.introDone = true
    end
  end
end

-- Maps a point given in the base shelter image's own unscaled pixel
-- space into world coordinates — keeps the door (and anything else
-- added later) pixel-accurate to that source art regardless of
-- self.pos or the shelter's own overall scale.
function SpaceShelter:imagePointToWorld(px, py)
  return self.pos.x + (px - self.sourceW / 2) * self.scaleX,
         self.pos.y + (py - self.sourceH) * self.scaleY
end

-- The shelter's own body — no door. Called separately from drawDoor
-- (see main.lua's draw order) so the player can be interleaved between
-- the two: behind the door but still in front of the shelter itself.
function SpaceShelter:drawBody()
  local img = state.spaceShelterTexture
  if not img then return end

  love.graphics.setColor(1, 1, 1, 1)
  -- Origin at (sourceW/2, sourceH) — bottom-center of the source image
  -- — so self.pos is exactly the point where the shelter's base meets
  -- the deck, matching Ooomba's own center-anchored draw convention.
  love.graphics.draw(img, self.pos.x, self.pos.y, 0, self.scaleX, self.scaleY, self.sourceW / 2, self.sourceH)
end

-- Draws both door halves, center-anchored so each half's own world
-- position is just its closed-position center nudged left or right by
-- the current slide offset, not a re-derivation of the geometry.
--
-- self.doorOpenFraction (see :update) drives how far each half has
-- slid from closed: negative offset for the left half (toward the
-- doorway's own left edge), positive for the right half (mirror
-- image, toward the right edge) — at fully open, each half has slid
-- its entire own width past the frame's edge.
--
-- Clipped to the doorway's own frame (the closed two-door span,
-- DOOR_LEFT_X to DOOR_LEFT_X + doorW*2) via a stencil the same way
-- SkyDomePlanetoid.lua clips its glass/metal regions — as each half
-- slides toward its own outer edge, the part that's slid past the
-- frame boundary is hidden rather than poking out past the wall,
-- reading as sliding INTO a pocket in the structure rather than just
-- floating off past its edge.
function SpaceShelter:drawDoor()
  local doorImg = state.spaceShelterDoorTexture
  if not doorImg then return end

  local doorW, doorH = doorImg:getDimensions()
  local centerPy = DOOR_TOP_Y + doorH / 2
  local offsetPx = self.doorOpenFraction * doorW

  local frameLeftX, frameTopY = self:imagePointToWorld(DOOR_LEFT_X, DOOR_TOP_Y)
  local frameRightX, frameBottomY = self:imagePointToWorld(DOOR_LEFT_X + doorW * 2, DOOR_TOP_Y + doorH)

  love.graphics.stencil(function()
    love.graphics.rectangle("fill", frameLeftX, frameTopY, frameRightX - frameLeftX, frameBottomY - frameTopY)
  end, "replace", 1)
  love.graphics.setStencilTest("greater", 0)

  love.graphics.setColor(1, 1, 1, 1)

  -- Left half: the source image as-is, slid toward the frame's left edge.
  local leftCenterPx = DOOR_LEFT_X + doorW / 2 - offsetPx
  local leftX, leftY = self:imagePointToWorld(leftCenterPx, centerPy)
  love.graphics.draw(doorImg, leftX, leftY, 0, self.scaleX, self.scaleY, doorW / 2, doorH / 2)

  -- Right half: the SAME source image, mirrored (negative X scale),
  -- slid toward the frame's right edge — the mirror of the left half.
  local rightCenterPx = DOOR_LEFT_X + doorW + doorW / 2 + offsetPx
  local rightX, rightY = self:imagePointToWorld(rightCenterPx, centerPy)
  love.graphics.draw(doorImg, rightX, rightY, 0, -self.scaleX, self.scaleY, doorW / 2, doorH / 2)

  love.graphics.setStencilTest()
end

return SpaceShelter
