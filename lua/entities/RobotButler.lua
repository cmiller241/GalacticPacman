-- lua/entities/RobotButler.lua
--
-- A decorative NPC beside the astronaut's shelter: paces back and forth
-- along a fixed stretch of the sky dome's own flat deck, walking right
-- to the far end of its patrol range, then back left to its own home
-- point, forever. Purely background flavor, same role SpaceShelter.lua
-- itself plays — no collision, not a lock-on/pull target, doesn't
-- appear in state.ooombas (that list's own patrol logic walks a
-- TerrainShape's arc length; this one just walks a fixed X range on
-- flat ground, which doesn't need any of that machinery).
--
-- Sprite sheet (img/Robot2.png, loaded as state.robotTexture): 4000x1200,
-- four 1000x1200 walking frames in a single row. The art faces LEFT by
-- default — walking right mirrors it horizontally, same convention
-- Ooomba.lua's own sprite already uses.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local DustPuff = require("lua.effects.DustPuff")

local RobotButler = {}
RobotButler.__index = RobotButler

local FRAME_COUNT = 4

-- 100ms per animation frame, expressed in 60fps-baseline ticks (this
-- project's own convention — see main.lua's own frameNorm/timeScale
-- comment) rather than raw milliseconds, so it advances correctly
-- whether the game (and V.A.T.S.'s own slow-mo) is running at normal
-- speed or not: 0.1s * 60 ticks/s = 6.
local FRAME_TICKS = 6

-- Odds of spawning a dust puff on any given 60fps-baseline tick while
-- moving (see the continuous-trickle comment in :update below) — not a
-- probability per real second, so it scales correctly with timeScale
-- the same way every other per-tick rate in this codebase does.
local DUST_SPAWN_CHANCE = 0.3

-- Baked once, shared by every RobotButler instance (there's only ever
-- one right now, but no reason to re-slice the sheet if that changes) —
-- same "bake once, draw many" precedent as Ooomba.lua's own
-- ensureFrameQuads.
local frameQuads = nil
local sheetFrameW, sheetFrameH = nil, nil

local function ensureFrameQuads(img)
  if frameQuads then return end
  local fullW, fullH = img:getDimensions()
  sheetFrameW, sheetFrameH = fullW / FRAME_COUNT, fullH
  frameQuads = {}
  for i = 0, FRAME_COUNT - 1 do
    frameQuads[i + 1] = love.graphics.newQuad(i * sheetFrameW, 0, sheetFrameW, sheetFrameH, fullW, fullH)
  end
end

-- homeX: the LEFT end of the patrol range (and the robot's starting
-- position) — "adjacent right of the space shelter" in practice means
-- passing the shelter's own right edge plus a gap here. groundY: the
-- deck surface it stands on (SkyDomePlanetoid:trueSurfaceY()).
function RobotButler.new(homeX, groundY, options)
  options = options or {}
  local self = setmetatable({}, RobotButler)

  local img = state.robotTexture
  local sheetW, sheetH
  if img then
    sheetW, sheetH = img:getDimensions()
  else
    sheetW, sheetH = 4000, 1200
  end
  local frameW, frameH = sheetW / FRAME_COUNT, sheetH

  -- Draw size in world units — same convention as Ooomba.lua's own
  -- drawHeight/drawWidth: a flat default height, width derived from the
  -- source frame's own aspect ratio (1000x1200, not square).
  self.drawHeight = options.drawHeight or 120
  self.drawWidth = options.drawWidth or (self.drawHeight * frameW / frameH)
  self.halfWidth = self.drawWidth / 2
  self.halfHeight = self.drawHeight / 2

  self.homeX = homeX
  self.groundY = groundY
  self.patrolWidth = options.patrolWidth or 350 -- how far right of homeX he walks before turning back
  self.speed = options.speed or 1.5             -- world units per 60fps-baseline tick

  -- Starts walking right (direction = 1) — the art's own default-left
  -- facing means this is also the frame he first needs flipping for.
  self.direction = 1

  -- Center-bottom anchor, same convention Ooomba/Player use: self.pos
  -- sits HALF the draw height above the true ground line, so drawing
  -- centered on it lands the sprite's feet exactly on groundY.
  self.pos = Vector2.new(homeX, groundY - self.halfHeight)

  self.frameIndex = 1
  self.frameTimer = 0

  -- Interaction (Enter / gamepad Circle — see InputHandlers.lua and
  -- GamePadInput.lua) — see :tryInteract and :drawTooltip/:drawDialogue
  -- below. World-units radius, not tied to drawWidth/drawHeight, since
  -- "close enough to talk to him" is a bigger, more forgiving zone than
  -- his own visual silhouette.
  self.interactRadius = options.interactRadius or 220
  self.dialogueText = "Hello Bob! How did you sleep?"
  self.playerNearby = false
  self.dialogueActive = false
  self.dialogueTimer = 0
  self.dialogueDurationTicks = 240 -- ~4 seconds at 60fps-baseline

  return self
end

function RobotButler:isPlayerNear(player)
  if not player then return false end
  local dx, dy = player.pos.x - self.pos.x, player.pos.y - self.pos.y
  return (dx * dx + dy * dy) <= self.interactRadius * self.interactRadius
end

-- Called from InputHandlers.lua (Enter) and GamePadInput.lua (Circle) —
-- both just call this unconditionally on their own press; it's the one
-- place that actually decides whether Bob is close enough for it to do
-- anything.
function RobotButler:tryInteract(player)
  if not self:isPlayerNear(player) then return end
  self.dialogueActive = true
  self.dialogueTimer = self.dialogueDurationTicks
end

function RobotButler:update()
  local timeScale = state.timeScale or 1
  local ds = self.direction * self.speed * timeScale

  local minX, maxX = self.homeX, self.homeX + self.patrolWidth
  local desiredX = self.pos.x + ds
  if desiredX > maxX then
    desiredX = maxX
    self.direction = -1
  elseif desiredX < minX then
    desiredX = minX
    self.direction = 1
  end
  self.pos.x = desiredX

  -- Walk-cycle animation frame: fixed 100ms cadence regardless of speed
  -- (see FRAME_TICKS's own comment) — separate from the dust timing
  -- below, which is driven by actual distance covered instead.
  self.frameTimer = self.frameTimer + timeScale
  if self.frameTimer >= FRAME_TICKS then
    self.frameTimer = self.frameTimer - FRAME_TICKS
    self.frameIndex = (self.frameIndex % FRAME_COUNT) + 1
  end

  -- Dust: a steady per-frame trickle instead of Player.lua/Ooomba.lua's
  -- own footstep-timed "just planted" pulse — those are built around a
  -- LEG actually planting on a walk cycle, which this robot doesn't
  -- have, so there's no discrete footfall to time dust against. Rolling
  -- the dice every tick he's actually moving (same "chance per
  -- 60fps-baseline tick" pattern FireBar.lua's own ember spawning
  -- already uses) instead gives continuous dust that scales naturally
  -- with speed/timeScale rather than a periodic burst.
  if ds ~= 0 and math.random() < DUST_SPAWN_CHANCE * timeScale then
    local downDir = Vector2.new(0, 1)
    local feetPos = Vector2.new(self.pos.x, self.groundY)
    local sideDir = Vector2.new(1, 0)
    DustPuff.spawn(feetPos, downDir, sideDir, 1 + math.floor(math.random() * 2), 2.5, 0.2, 0.6)
  end

  -- Interaction: :tryInteract (fired from Enter/Circle) only ever sets
  -- dialogueActive true — this is what counts it back down and clears
  -- it again, and what drives whether :drawTooltip's own "press to
  -- interact" hint should be showing right now.
  self.playerNearby = self:isPlayerNear(state.player)
  if self.dialogueActive then
    -- Walking out of range dismisses it immediately, same as running
    -- out the clock does — no point leaving a reply hanging on screen
    -- once he's no longer even in earshot.
    if not self.playerNearby then
      self.dialogueActive = false
    else
      self.dialogueTimer = self.dialogueTimer - timeScale
      if self.dialogueTimer <= 0 then
        self.dialogueActive = false
      end
    end
  end
end

function RobotButler:draw()
  local img = state.robotTexture
  if not img then return end
  ensureFrameQuads(img)

  local quad = frameQuads[self.frameIndex]

  -- Sprite faces LEFT by default — moving right needs a horizontal
  -- flip. Same negative-scaleX-with-centered-origin trick Ooomba.lua
  -- uses, for the same reason: keeps the sprite centered on self.pos
  -- with no separate offset needed for the mirrored case.
  local scaleX = self.drawWidth / sheetFrameW
  if self.direction > 0 then scaleX = -scaleX end
  local scaleY = self.drawHeight / sheetFrameH

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(img, quad, self.pos.x, self.pos.y, 0, scaleX, scaleY, sheetFrameW / 2, sheetFrameH / 2)
end

local TOOLTIP_TEXT = "Press ENTER / Circle to talk"
local TOOLTIP_PAD_X, TOOLTIP_PAD_Y = 12, 8
local TOOLTIP_GAP_ABOVE_HEAD = 26 -- world units between his head and the pill's own bottom edge

-- World-space "you can interact with him" hint — call from inside the
-- same camera-transformed push() block everything else in the scene
-- draws from (see main.lua's love.draw). Only shown while he's actually
-- in range AND not already mid-conversation (see :drawDialogue) — no
-- point advertising an interaction that's already happening.
function RobotButler:drawTooltip()
  if not self.playerNearby or self.dialogueActive then return end

  local font = love.graphics.getFont()
  local textW = font:getWidth(TOOLTIP_TEXT)
  local textH = font:getHeight()
  local pillW = textW + TOOLTIP_PAD_X * 2
  local pillH = textH + TOOLTIP_PAD_Y * 2

  -- Gentle bob, same "alive, not static" pulsing idea LockOutline.lua's
  -- own ring already uses elsewhere, just vertical motion instead of an
  -- alpha pulse — reads as a little floating tooltip rather than a flat
  -- painted-on label.
  local bob = math.sin(love.timer.getTime() * 3) * 4
  local pillX = self.pos.x - pillW / 2
  local pillY = self.pos.y - self.halfHeight - TOOLTIP_GAP_ABOVE_HEAD - pillH + bob

  love.graphics.setColor(0, 0, 0, 0.6)
  love.graphics.rectangle("fill", pillX, pillY, pillW, pillH, pillH / 2, pillH / 2)
  love.graphics.setColor(1, 1, 1, 0.9)
  love.graphics.rectangle("line", pillX, pillY, pillW, pillH, pillH / 2, pillH / 2)
  love.graphics.print(TOOLTIP_TEXT, pillX + TOOLTIP_PAD_X, pillY + TOOLTIP_PAD_Y)
  love.graphics.setColor(1, 1, 1, 1)
end

-- Source textbox.png is 1410x227 — used here just for its own aspect
-- ratio, not a hardcoded literal, so this keeps working if that image
-- is ever swapped for a different size.
local TEXTBOX_SOURCE_W, TEXTBOX_SOURCE_H = 1410, 227
local TEXTBOX_WIDTH_MARGIN = 20  -- screen px of clearance kept on either side of the window
local TEXTBOX_BOTTOM_MARGIN = 20 -- screen px kept between the box's own bottom edge and the window's
local TEXTBOX_TEXT_PAD_X = 60    -- inset from the box's own edges before text is allowed to start/wrap
local TEXTBOX_TEXT_PAD_Y = 33    -- inset from the box's own TOP edge (text is top-aligned, not centered)
local TEXTBOX_SHADOW_OFFSET = 2  -- px the drop shadow sits down-and-right of the actual text

-- Built lazily, once, and reused — same "bake once" precedent as this
-- file's own frameQuads. The default LÖVE font reads too small against
-- a box this wide; love.graphics.setFont is reset back to whatever it
-- was right after printing (see :drawDialogue), so this never leaks
-- into the HUD text/minimap drawn elsewhere with the default font.
local dialogueFont = nil
local function ensureDialogueFont()
  if not dialogueFont then
    dialogueFont = love.graphics.newFont(30)
  end
  return dialogueFont
end

-- Screen-space dialogue box — call AFTER the camera transform is
-- popped (see main.lua's love.draw, alongside the minimap/HUD/VatsCursor
-- reticle), so it stays fixed relative to the WINDOW rather than the
-- world underneath it, matching how a dialogue box behaves in basically
-- every game that has one.
function RobotButler:drawDialogue()
  if not self.dialogueActive then return end
  local img = state.textboxTexture
  if not img then return end

  local screenW, screenH = love.graphics.getWidth(), love.graphics.getHeight()

  -- 20px clearance from the window on either side — at this project's
  -- own default 1280-wide window that's already close to the "about 95%
  -- of window width" ballpark; sized off the fixed margin rather than a
  -- flat percentage so it stays a consistent, deliberate gap at any
  -- window size instead of drifting wider on a bigger window.
  --
  -- Left-anchored at that same margin, but the RIGHT edge yields to the
  -- minimap (lua/ui/MiniMap.lua) when one exists, stopping short of its
  -- own left edge (plus the same margin again) instead of running the
  -- full window width and disappearing behind it — see the screenshot
  -- that prompted this: the box's own right portion was drawn UNDER the
  -- minimap panel, which draws after it. refreshSize() is called here
  -- (not just trusted from minimap's own last :draw()) so this is
  -- correct even the very first frame dialogue shows, not one frame
  -- stale after a resize.
  local rightEdge = screenW - TEXTBOX_WIDTH_MARGIN
  if state.minimap then
    state.minimap:refreshSize()
    local mapLeftEdge = screenW - state.minimap.size - state.minimap.margin
    rightEdge = math.min(rightEdge, mapLeftEdge - TEXTBOX_WIDTH_MARGIN)
  end

  local boxX = TEXTBOX_WIDTH_MARGIN
  local boxW = rightEdge - boxX
  local boxH = boxW * (TEXTBOX_SOURCE_H / TEXTBOX_SOURCE_W)
  local boxY = screenH - TEXTBOX_BOTTOM_MARGIN - boxH

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(img, boxX, boxY, 0, boxW / TEXTBOX_SOURCE_W, boxH / TEXTBOX_SOURCE_H)

  -- Top-left aligned, white with a small dark drop shadow — plain black
  -- text read poorly against the box's own dark interior; a shadow
  -- keeps the white text readable regardless of exactly what's behind
  -- it, rather than depending on the box art always being dark enough.
  local prevFont = love.graphics.getFont()
  love.graphics.setFont(ensureDialogueFont())

  local textX = boxX + TEXTBOX_TEXT_PAD_X
  local textY = boxY + TEXTBOX_TEXT_PAD_Y
  local textLimit = boxW - TEXTBOX_TEXT_PAD_X * 2

  love.graphics.setColor(0, 0, 0, 0.65)
  love.graphics.printf(self.dialogueText, textX + TEXTBOX_SHADOW_OFFSET, textY + TEXTBOX_SHADOW_OFFSET, textLimit, "left")

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.printf(self.dialogueText, textX, textY, textLimit, "left")

  love.graphics.setFont(prevFont)
end

return RobotButler
