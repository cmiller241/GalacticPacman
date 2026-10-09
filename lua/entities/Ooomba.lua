-- lua/entities/Ooomba.lua
--
-- A simple ground-patrol enemy: walks back and forth along a TiledTerrain
-- TerrainShape's own arc-length path, turning around at either end
-- instead of falling off. The edge-patrol movement itself is ported from
-- js/entities/world/Goomba.js (see that file's own comment for why this
-- is its own simple "walk to the edge, turn around" logic rather than
-- routing through any orbit/jump AI system) — reskinned here with the
-- Ooomba sprite sheet (img/Ooomba.png: 3 frames of 800x950 — standing,
-- walk-forward-A, walk-forward-B) instead of Goomba's 2-frame tileset,
-- cycled standing/walk-A/standing/walk-B rather than a plain 2-frame
-- alternation.
--
-- Walking along arc length rather than a flat X range is what gets slope
-- climbing for free: TerrainShape:worldPointAtArcPosition already handles
-- both flat and 45-degree segments (and pushes the sprite straight up
-- from the surface, same upright convention the player itself uses — see
-- Player.lua's own worldPointAtArcPosition comment for why that matters),
-- and TerrainShape:getArcSpeedMultiplier already slows walking on slopes
-- — both reused here unchanged rather than reimplemented.
--
-- A hazard: touching one kills the player, unless he lands on it from
-- above, which squashes it flat instead (see :startSquash/:updateSquash
-- and CollisionSystem:handlePlayerOoombaCollisions). A fireball kills it
-- outright (see main.lua's own fireball pass).

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local DustPuff = require("lua.effects.DustPuff")

local Ooomba = {}
Ooomba.__index = Ooomba

-- The user-described 1-based walk order (standing, walk-A, standing,
-- walk-B) as 0-based sheet frame indices, used directly against the
-- baked quads below. Loops — index 4 wraps back to index 1 (frame 0),
-- not a true ping-pong reverse.
local FRAME_SEQUENCE = { 0, 1, 0, 2 }

-- Purely a visual nudge (the sprite's feet sit slightly above self.pos
-- otherwise) — doesn't touch self.pos itself, so the platform-edge
-- turn-around math in :update() stays anchored to the true surface.
local DRAW_Y_OFFSET = 3

-- Circle used for player/fireball contact — a bit under halfWidth, so
-- hits need real overlap with the body, not the sprite's empty corners.
local HIT_RADIUS = 36

-- Stomp tuning (see :updateSquash). All in world units / baseline
-- (60fps) ticks.
local SQUASH_FALL_SPEED = 4.5   -- the player's own fall is capped to this while he's pressing one flat, so the squash is slow enough to actually see
local SQUASH_SOLO_SPEED = 9     -- how fast it finishes collapsing by itself if he's no longer pressing down on it
local SQUASH_DONE_HEIGHT = 6    -- squashed "to nothing" once it's this thin
local SQUASH_MAX_BULGE = 0.4    -- extra width (fraction) it spreads out to as it flattens

-- Baked once, shared by every Ooomba instance — same "bake once, draw
-- many" precedent as JumpPlatform.lua's own getTileQuad.
local frameQuads = nil
local sheetFrameW, sheetFrameH = nil, nil

local function ensureFrameQuads(img)
  if frameQuads then return end
  local fullW, fullH = img:getDimensions()
  sheetFrameW, sheetFrameH = fullW / 3, fullH
  frameQuads = {}
  for i = 0, 2 do
    frameQuads[i] = love.graphics.newQuad(i * sheetFrameW, 0, sheetFrameW, sheetFrameH, fullW, fullH)
  end
end

function Ooomba.new(homeShape, startArcPos, options)
  options = options or {}
  local self = setmetatable({}, Ooomba)

  self.homeShape = homeShape

  -- Draw size in world units — NOT a true radius (the source art is
  -- 800x950, not square); halfWidth insets the turn-around bounds near
  -- either end of the shape's own path, halfHeight is the push-out
  -- distance worldPointAtArcPosition uses to place the sprite's feet on
  -- the surface. Same two roles Goomba.js's single `radius` served
  -- there, split in two here since this sprite isn't square.
  self.drawHeight = options.drawHeight or 90
  self.drawWidth = options.drawWidth or (self.drawHeight * 800 / 950)
  self.halfWidth = self.drawWidth / 2
  self.halfHeight = self.drawHeight / 2
  -- Not named plain `radius`: utils.boundingRadius (target-lock outline,
  -- on-screen checks) prefers that field over halfWidth/halfHeight, and
  -- this is a contact circle, not the sprite's bounds.
  self.hitRadius = HIT_RADIUS

  -- See :startSquash/:updateSquash. squashHeight is how tall the sprite
  -- is currently drawn — drawHeight normally, shrinking toward 0 while
  -- being stomped. squashPressed is whether the player was still
  -- pressing it down on the most recent :updateSquash.
  self.isSquashing = false
  self.squashHeight = self.drawHeight
  self.squashPressed = false

  self.speed = options.speed or 1.4       -- arc-length units per frame — deliberately a bit slower than the player's own walk speed
  self.direction = options.direction or -1 -- -1 = toward arc position 0, 1 = toward the far end; the art faces left by default, so -1 needs no flip

  self.surfaceArcPos = startArcPos or 0
  self.pos = homeShape:worldPointAtArcPosition(self.surfaceArcPos, self.halfHeight).point

  self.walkCyclePhase = 0
  self.walkCycleSpeed = 0.12 -- how fast the 4-step stand/walk cycle advances

  -- Footstep-dust timing — same distance-driven "just planted" detection
  -- Player.lua's own spawnWalkDust and RobotButler.lua use (see
  -- DustPuff.lua): walkTime advances by actual arc-length distance
  -- covered this frame, and a footfall is the moment sin(walkTime)^2
  -- crosses back above 0.85 (once per leg, twice per full stride).
  self.walkTime = 0
  self.lastWalkBobT = 0
  self.strideLength = 90

  return self
end

function Ooomba:startSquash()
  self.isSquashing = true
end

-- Called every frame while isSquashing (see
-- CollisionSystem:handlePlayerOoombaCollisions). The sprite's own top
-- edge is pinned to the player's feet for as long as he's still above
-- it, so it flattens exactly in step with him sinking down onto it —
-- and his fall is slowed to SQUASH_FALL_SPEED so that takes long enough
-- to see. If he's no longer pressing down (landed on something, moved
-- off sideways, died), it finishes collapsing on its own. Returns true
-- once it's flat.
function Ooomba:updateSquash(player)
  local timeScale = state.timeScale or 1
  local bottomY = self.pos.y + self.halfHeight
  local feetY = player.pos.y + player.radius

  local above = not player.isDying
    and math.abs(player.pos.x - self.pos.x) <= self.halfWidth + player.radius
  local descending = above and not player.onSurface and player.vel.y > 0

  if above then
    self.squashHeight = math.max(0, math.min(self.squashHeight, bottomY - feetY))
  end
  if descending then
    if player.vel.y > SQUASH_FALL_SPEED then player.vel.y = SQUASH_FALL_SPEED end
  else
    self.squashHeight = math.max(0, self.squashHeight - SQUASH_SOLO_SPEED * timeScale)
  end
  self.squashPressed = above

  return self.squashHeight <= SQUASH_DONE_HEIGHT
end

function Ooomba:update()
  -- Stops dead the moment it's stepped on.
  if self.isSquashing then return end

  local timeScale = state.timeScale or 1
  local shape = self.homeShape
  local perimeter = shape:getPerimeter()

  local speedMultiplier = 1
  if type(shape.getArcSpeedMultiplier) == "function" then
    speedMultiplier = shape:getArcSpeedMultiplier(self.surfaceArcPos, self.direction)
  end

  -- Turn-around bounds are inset by this.halfWidth so the Ooomba's own
  -- body stays fully on the shape's own footprint when it turns, rather
  -- than visually overhanging the end before reversing.
  local prevArcPos = self.surfaceArcPos
  local desiredArcPos = self.surfaceArcPos + self.direction * self.speed * speedMultiplier * timeScale
  if desiredArcPos < self.halfWidth or desiredArcPos > perimeter - self.halfWidth then
    self.direction = -self.direction -- reached the end — turn around instead of falling off
  else
    self.surfaceArcPos = desiredArcPos
  end

  local surface = shape:worldPointAtArcPosition(self.surfaceArcPos, self.halfHeight)
  self.pos = surface.point

  self.walkCyclePhase = self.walkCyclePhase + self.walkCycleSpeed * timeScale

  -- Actual distance covered THIS frame, not the attempted step above —
  -- 0 on the very frame he turns around at an end, so that frame
  -- correctly spawns no footstep dust for a step he didn't actually take.
  local actualDs = self.surfaceArcPos - prevArcPos
  self.walkTime = self.walkTime + (math.abs(actualDs) / self.strideLength) * math.pi * 2
  local bobT = math.sin(self.walkTime) ^ 2
  local justPlanted = bobT > 0.85 and self.lastWalkBobT <= 0.85
  self.lastWalkBobT = bobT
  if justPlanted then
    -- shape.forceUprightJump (every shape an Ooomba ever patrols — see
    -- main.lua's own spawn loop, which skips wall-climb shapes entirely)
    -- means "down" is always straight down here, same override
    -- Player:visualDownDirection uses for the same kind of surface.
    local downDir = shape.forceUprightJump and Vector2.new(0, 1) or surface.normal:clone():multiply(-1)
    local feetPos = self.pos:clone():add(downDir:clone():multiply(self.halfHeight))
    local sideDir = Vector2.new(-downDir.y, downDir.x)
    DustPuff.spawn(feetPos, downDir, sideDir, 2 + math.floor(math.random() * 2), 2.5, 0.2, 0.6)
  end
end

function Ooomba:draw()
  local img = state.oombaTexture
  if not img then return end
  ensureFrameQuads(img)

  local seqIndex = (math.floor(self.walkCyclePhase) % #FRAME_SEQUENCE) + 1
  local frame = FRAME_SEQUENCE[seqIndex]
  local quad = frameQuads[frame]

  -- Sprite faces LEFT by default — moving right needs a horizontal
  -- flip. Flipping via a negative scaleX with the origin set to the
  -- frame's own center (rather than a manual translate/scale/restore)
  -- keeps the sprite centered on self.pos with no separate offset
  -- needed for the mirrored case.
  local scaleX = self.drawWidth / sheetFrameW
  if self.direction > 0 then scaleX = -scaleX end
  local scaleY = self.drawHeight / sheetFrameH

  -- Anchored at the sprite's own bottom-center (its feet) rather than
  -- its center, so a squash flattens it DOWN onto the ground instead of
  -- shrinking toward its middle. At full height this lands on exactly
  -- the same pixels a center-anchored draw would.
  local squash = self.squashHeight / self.drawHeight
  scaleX = scaleX * (1 + SQUASH_MAX_BULGE * (1 - squash))
  scaleY = scaleY * squash

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(img, quad, self.pos.x, self.pos.y + self.halfHeight + DRAW_Y_OFFSET, 0, scaleX, scaleY, sheetFrameW / 2, sheetFrameH)
end

return Ooomba
