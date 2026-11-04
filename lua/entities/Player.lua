-- lua/entities/Player.lua
--
-- The player. This file has his state (Player.new), the per-frame
-- update, ball mode, teleporting, invincibility, bubbles, death and
-- respawn. The rest of his methods are in lua/entities/player/:
--   Movement.lua   gravity, jumping, ground pound, walking
--   Rendering.lua  drawing the rig, poses, ball and effects
--   Targeting.lua  pull beam, target lock, firing
-- and are copied onto Player at the bottom of this file.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local constants = require("lua.constants")
local Splash = require("lua.effects.Splash")
local Bubbles = require("lua.effects.Bubbles")
local GroundPoundBurst = require("lua.effects.GroundPoundBurst")
local WaterSystem = require("lua.systems.WaterSystem")
local Tuning = require("lua.entities.player.Tuning")

local Player = {}
Player.__index = Player

local BALL_MORPH_SEGMENT_TICKS = Tuning.BALL_MORPH_SEGMENT_TICKS
local TELEPORT_OUT_TICKS = Tuning.TELEPORT_OUT_TICKS
local TELEPORT_IN_TICKS = Tuning.TELEPORT_IN_TICKS

-- Ground pound (see Player:update's ground-pound bookkeeping).
local GROUND_POUND_IMPACT_TICKS = 14  -- ticks he stays sat on the ground after landing one, before standing back up


-- Water bubbles: spawn just outside the player's own body, on whichever
-- side currently faces AWAY from the water planet's center (matches the
-- radial "up" convention every circular planet already uses — that's
-- literally where his helmet points), then travel further outward along
-- that same radial line, with a lazy angular wobble, until reaching the
-- water's own outer radius — wherever that happens to be from the
-- player's CURRENT depth, not a fixed distance. Polar coordinates
-- (angle + r, both relative to the water planet's center) rather than
-- x/y for the same reason WaterPlanet.lua's original ambient version
-- used them: "outward toward the surface" is a radial motion here, and
-- critically, radial is direction-agnostic — a player on the far side
-- of the core sees bubbles correctly head the opposite screen direction
-- instead of always drifting toward one fixed screen "up."
local BUBBLE_SPAWN_CHANCE     = 0.35 -- per baseline (60fps) frame, while under BUBBLE_MAX_COUNT and submerged
local BUBBLE_MAX_COUNT        = 10

-- Morph ball (ArrowDown to curl up, ArrowUp to stand back up — see
-- InputHandlers.lua/GamePadInput.lua's calls into enterBallMode/
-- exitBallMode). The one number behind both the drawn ball's radius and
-- his collision radius as a ball, so the two always match.
local BALL_RADIUS_MULTIPLIER = 0.792 -- 0.5 * 1.2 * 1.2 * 1.1 — bumped 20%, 20%, then another 10% bigger

-- Brief invincibility after arriving through a beam or respawning, so an
-- enemy near where he appears can't get a free kill. Baseline (60fps)
-- ticks: 120 = 2s. (The flicker rate is in Rendering.lua.)
local INVINCIBLE_TICKS = 120

-- Death (Player:startDeath/updateDeath/respawn): how long he stays
-- gone — hidden and frozen where he died, his death burst playing out —
-- before reappearing at state.respawnPoint. Baseline (60fps) ticks.
local DEATH_TICKS = 50

local BUBBLE_HEAD_GAP         = 1.4 -- spawn distance from center, as a multiple of self.radius past the player's own position — clears his helmet instead of sitting on it
-- Sizes and rise speeds for his bubbles; the rest of their look and
-- motion lives in lua/effects/Bubbles.lua.
local BUBBLES = {
  radiusMin = 2,   -- world units, before they swell on the way up
  radiusMax = 5.5,
  riseMin = 0.5,   -- world units per baseline frame, radially outward
  riseMax = 1.1,
}

function Player.new(x, y)
  local self = setmetatable({}, Player)

  self.pos = Vector2.new(x, y)
  self.prevPos = Vector2.new(x, y)
  self.vel = Vector2.new(0, 0)
  self.sizeMultiplier = 1
  self.radius = constants.PLAYER_RADIUS * self.sizeMultiplier
  -- Snapshot of the normal (non-ball) radius — enterBallMode/exitBallMode
  -- toggle self.radius (the one every collision/gravity/surface-distance
  -- check actually reads) between this and baseRadius*BALL_RADIUS_MULTIPLIER,
  -- rather than the ball shrink permanently overwriting the number it'd
  -- need to restore later.
  self.baseRadius = self.radius
  self.isBall = false
  self.ballRollAngle = 0
  -- Set by the pinball planet's own entry beam (see
  -- lua/interiors/PinballInterior.lua:onEnter and main.lua's own
  -- pinball-beam setup) to the PinballInterior instance he's currently
  -- inside, nil otherwise. main.lua's own update loop checks this to
  -- swap out normal gravity/collision for PinballInterior:updateBall
  -- entirely, and InputHandlers.lua/GamePadInput.lua check it to route
  -- the jump button to PinballInterior:triggerJumpAction instead of an
  -- ordinary jump.
  self.inPinball = nil
  self.ballRollAngle = 0
  -- nil | "toBall" | "toHuman" — see Player:enterBallMode/exitBallMode/
  -- updateBallMorph. morphElapsed is in baseline (60fps) ticks, counted
  -- from 0 at the start of whichever transition is currently playing.
  self.morphState = nil
  self.morphElapsed = 0

  -- Beam.lua teleport (see Player:startTeleport/updateTeleport below):
  -- isTeleporting is the one guard every other system checks (movement,
  -- jumping, ball morph, target locking); teleportState/teleportTimer/
  -- teleportOrigin/teleportDestination are updateTeleport's own private
  -- bookkeeping.
  self.isTeleporting = false
  self.teleportState = nil
  self.teleportTimer = 0
  self.teleportOrigin = nil
  self.teleportDestination = nil

  -- Post-arrival invincibility (see Player:isInvincible/INVINCIBLE_TICKS)
  -- — ticks remaining, counted down in Player:update(); 0/negative means
  -- not currently invincible.
  self.invincibleTimer = 0

  -- See Player:startDeath/updateDeath/respawn. isDying is the one guard
  -- every other system checks, same role isTeleporting plays above.
  self.isDying = false
  self.deathTimer = 0

  -- Coyote time / jump buffering — see COYOTE_FRAMES and Player:pressJump.
  -- coyotePlanet/coyotePos: the surface he was last standing on, and
  -- where; coyoteTimer: ticks left to still jump off it once he's not.
  self.coyoteTimer = 0
  self.coyotePlanet = nil
  self.coyotePos = nil
  self.jumpBufferTimer = 0

  self.onSurface = false
  self.currentPlanet = nil
  self.lastInfluencePlanet = nil
  self.angle = 0
  self.surfaceArcPos = 0
  self.facingDirection = 1
  self.isGroundPounding = false
  self.mode = "space"

  -- Water planets (WaterPlanet.lua) never set onSurface — the player
  -- sinks straight through instead of landing (see CollisionSystem's
  -- own comment on this) — so self.submergedIn, recomputed fresh every
  -- frame in :update(), is the only way to know "currently inside one
  -- of these" for water drag and the swim stroke in :jump(). waterDrag
  -- is deliberately much stronger than the ordinary airborne DRAG
  -- constant — that's what makes sinking read as pushing through water
  -- instead of falling through empty space. swimStrength is the
  -- outward-from-center impulse each jump press adds while submerged.
  self.submergedIn = nil
  self.waterDrag = 0.90
  -- With waterDrag at 0.90 and ordinary gravity (~0.35/frame), terminal
  -- sink speed works out to roughly 3.5 units/frame (grav / (1-drag)) —
  -- swimStrength needs to clear that by a wide margin per stroke or it
  -- barely dents a sink already at or near that speed, which is why 6
  -- read as "only a few pixels" per press.
  self.swimStrength = 16
  self.waterWalkSpeedMultiplier = 0.4 -- walking the hard core at the bottom is still walking underwater

  -- One-shot arm-wave played over swimStrokeDuration frames after each
  -- swim stroke (see :jump()) — a simple placeholder "this is swimming"
  -- signal until there's a real stroke animation. Counts down in
  -- :update() the same way wallJumpLockTimer does.
  self.swimStrokeTimer = 0
  self.swimStrokeDuration = 18

  -- Ground-pound visuals (see GROUND_POUND_IMPACT_TICKS and the
  -- bookkeeping in Player:update). groundPoundPoseTime: ticks spent in
  -- the current pound, for easing the pose down into place.
  -- groundPoundImpactTimer: ticks left of the "sat on the ground" beat
  -- after landing one. wasGroundPounding: last frame's isGroundPounding,
  -- to catch the moment a pound ends.
  self.groundPoundPoseTime = 0
  self.groundPoundImpactTimer = 0
  self.wasGroundPounding = false

  self.bubbles = {}

  self.isWalking = false
  self.walkTime = 0
  self.strideLength = 90
  self.lastWalkBobT = 0
  self.walkBobStrength = 3

  -- Scales the ground-speed-carried horizontal jump velocity (see
  -- move()'s own groundMoveSpeedX and jump()'s use of it) — purely
  -- additive to vel.x. 1.0 would be an exact carry (jumping matches
  -- whatever speed you were already moving at); 0.5 is confirmed, felt
  -- in actual play, as the right amount of "jump friction" — a jump
  -- carries noticeably less horizontal speed than covering the same
  -- ground on foot would. This is the only horizontal-carry knob.
  self.jumpMomentumCarryScale = 0.3
  self.runSpeedMultiplier = 1.8
  -- Dialed back down from 1.3*1.1=1.43 — that was tuned back when
  -- SkyDomePlanetoid's own jumpStrength was 11 (running height ~15.7),
  -- but once jumpStrength was raised to 15 (and made to apply on every
  -- Tiled tile, not just the dome's bare deck), the SAME multiplier
  -- pushed a running jump up to ~21.5 — noticeably too high. 1.2 keeps
  -- running jumps clearly higher than standing ones (15 -> 18) without
  -- repeating that. Best-guess starting point, not a confirmed value —
  -- an easy single-number retune once it's been felt in play.
  self.runJumpMultiplier = 1.2
  self.airControlAccel = 0.3
  -- Also doubles as the hard ceiling jump()'s own momentum carry clamps
  -- to (see jumpMomentumCarryScale's own use there), so a jump's launch
  -- speed can never exceed this either, not just air control afterward.
  -- Pinned to the player's own max ground running speed (PLAYER_LINEAR_SPEED
  -- * runSpeedMultiplier): like Mario-style platformers, a jump carries
  -- and keeps your ground speed in the air but never adds to it. A
  -- higher cap would let each jump (and bunny-hops especially) build
  -- speed past top running speed.
  self.airControlMaxSpeed = constants.PLAYER_LINEAR_SPEED * self.runSpeedMultiplier
  self.edgeFallCarryFraction = 0.35
  -- How hard the player peels off a wall-climb shape (see
  -- TiledTerrain.lua's buildRampClimbShape) when they stop actively
  -- climbing — applied along the current segment's own normal, so it
  -- reads as falling AWAY from the wall/curve rather than just
  -- dropping straight down through it. A bit more assertive than
  -- edgeFallCarryFraction's own gentle edge-of-ledge carry, since this
  -- is meant to visibly sell "you just detached," not a subtle nudge.
  self.wallClimbDetachPush = constants.PLAYER_LINEAR_SPEED * 0.6
  -- Which way (1 = the shape's "forward"/climbing arc-length direction,
  -- -1 = the reverse) the player was last moving while on a wall-climb
  -- shape's wall face or ceiling — see Player:move()'s onClimbZone
  -- handling. nil whenever not currently on either, so stepping onto a
  -- fresh one always starts from a clean slate rather than remembering
  -- some earlier, unrelated climb.
  self.wallClimbDir = nil
  -- Which PLANET (TerrainShape) self.wallClimbDir was recorded against.
  -- Its sign is only meaningful relative to THAT shape's own
  -- controlsReversed convention (see buildRampClimbShape) — a full loop
  -- built from a rampRight tile on one side and a rampLeft tile on the
  -- other uses two separate shapes with OPPOSITE conventions, and the
  -- ceiling in between only ever belongs to whichever shape absorbed
  -- that stretch, not both. The player can fall off the end of one onto
  -- the other mid-ceiling (see the isOpenPath handling below) while
  -- still holding the same key the whole time — without this check,
  -- that same held key flips sign across the swap and reads as an
  -- instant, unearned reversal the moment they land.
  self.wallClimbDirPlanet = nil

  -- Wall jump: which wall (if any) was touched THIS FRAME, set fresh
  -- every frame by CollisionSystem:handlePlayerWallCollisions — never
  -- stale. wallJumpUpwardRatio shapes the launch direction: it's the
  -- vertical leg of an (horizontal=1, vertical=ratio) vector before
  -- normalizing, so the vertical FRACTION of the final launch speed is
  -- ratio/sqrt(1+ratio^2) — not ratio itself (ratio=1 is a 45-degree
  -- diagonal, not "pure up"; getting mostly-vertical needs ratio well
  -- above 1). 2 puts about 89% of launch speed into the upward
  -- component while still keeping a real sideways kick off the wall.
  self.touchingWall = nil
  self.wallContactNormal = nil
  self.wallJumpUpwardRatio = 2

  -- Wall slide: while airborne, touching a wall, and holding the
  -- direction key INTO it, fall speed is capped to this (much slower
  -- than a normal fall) — see Player:update. Letting go of the direction
  -- key resumes a normal fall even while still touching the wall.
  -- isWallSliding is set fresh each frame in Player:update() and drives
  -- drawFullBody's dedicated wall-slide pose (see drawWallSlidePose).
  self.wallSlideMaxFallSpeed = 2.5
  self.isWallSliding = false

  -- Wall jump input lock: for wallJumpLockFrames (~60fps-frame units,
  -- scaled by state.timeScale like everything else) after a wall jump,
  -- input back toward the wall just kicked off is ignored — otherwise
  -- air control immediately starts canceling the kick if that direction
  -- is still held, and the jump never actually goes anywhere. Direction
  -- AWAY from the wall (and neutral) are never blocked, so committing to
  -- a longer leap works immediately. wallJumpLockBlockedDir is which
  -- ArrowLeft/ArrowRight direction (-1/1) is currently locked out; nil
  -- when no lock is active.
  self.wallJumpLockFrames = 12
  self.wallJumpLockTimer = 0
  self.wallJumpLockBlockedDir = nil

  -- Time values are in SECONDS (love.timer.getTime()), matching inputHandlers.lua
  self.mouseIdle = true
  self.mouseIdleThreshold = 2.0          -- seconds
  self.mouseWheelSuppressDuration = 0.2  -- seconds

  self.pullTarget = nil
  self.lockedTarget = nil
  self.pullAccel = 0.85
  self.pullMaxSpeed = 18
  self.pullTangentialDamping = 0.12

  -- Visual rig
  self.bodyScale = 0.1 * self.sizeMultiplier
  self.groundOffset = 250
  self.armSwingScale = 0.5
  self.maxAimFromForward = (90 + 5) * math.pi / 180
  self.headLookScale = 0.6
  self.headPivotFraction = 0.9
  self.blasterMuzzleLength = 300
  self.blasterAngleOffset = -5 * math.pi / 180

  self.bodyPartsConfig = {
    bodyY = 115,
    headY = -150,
    leftArmX = 136, leftArmY = 9, leftArmJointX = 73, leftArmJointY = 199,
    rightArmX = -186, rightArmY = -14, rightArmJointX = 119, rightArmJointY = 40,
    leftBootX = 111, leftBootY = 241, leftBootJointX = 83, leftBootJointY = 15,
    rightBootX = -142, rightBootY = 241, rightBootJointX = 77, rightBootJointY = 15
  }

  -- How far above self.pos (world units) the very TOP of his visual
  -- helmet actually sits — derived from the same numbers drawFullBody
  -- itself uses to place the head (groundOffset, bodyPartsConfig.headY,
  -- headPivotFraction), not a guessed constant, so it stays correct if
  -- the rig's own proportions ever change. CollisionSystem's
  -- handlePlayerWallCollisions uses this to give the player a proper
  -- vertical CAPSULE against walls/ceilings instead of a single circle
  -- centered near his feet — a plain circle of radius self.radius (30
  -- units) never reached anywhere near his actual head height, which is
  -- exactly why a lowered ceiling tile could visibly clip through his
  -- helmet without ever registering a collision.
  --
  -- groundOffset*bodyScale: self.pos -> the rig's own draw origin.
  -- |headY|*bodyScale: draw origin -> the head's ATTACH point.
  -- headH*bodyScale*headPivotFraction: attach point -> the head
  -- image's own TOP edge (pivotY, in drawFullBody, is exactly how far
  -- below the image's top edge the attach point sits).
  local headImg = state.characterImages and state.characterImages.head
  local headH = 0
  if headImg then
    local _, imgH = headImg:getDimensions()
    headH = imgH
  end
  -- -10: trims the wall/ceiling collision capsule a little shorter than
  -- the helmet's own actual visual top edge — a bare match let the
  -- capsule clip low ceiling tiles that still looked visually clear
  -- above his helmet.
  self.headReach = (self.groundOffset + math.abs(self.bodyPartsConfig.headY)) * self.bodyScale
    + headH * self.bodyScale * self.headPivotFraction
    - 10

  -- Aim cache
  self.aimShoulderPos = nil
  self.aimWorldAngle = 0
  self.aimRelativeAngle = 0
  self.aimAnchorPos = nil

  return self
end

------------------------------------------------------------------
-- Morph ball
------------------------------------------------------------------

-- Down/Triangle only ENTER/EXIT ball mode on a clean press (not
-- held-stick drift), so it isn't triggered by accident while walking.
-- Flip to false to turn the ball off.
local BALL_MODE_ENABLED = true

-- Starts the curl-in ANIMATION — self.isBall itself (and therefore
-- self.radius/ground speed) doesn't flip until updateBallMorph below
-- finishes playing it. Ignored while any transition is already in
-- progress (can't interrupt/re-trigger mid-curl), same as it being
-- ignored while already fully a ball or while talking to an NPC
-- (state.dialogueActive — movement/jumping are already frozen then, see
-- Player:move/jump, and starting a morph mid-conversation would be the
-- same kind of "moving" while supposedly standing still talking).
-- Whether he's riding a cannon: loaded in one, or fired from one and
-- still on the way (see lua/world/Cannon.lua). He can't do anything at
-- all then — curl or uncurl, jump, fire, pull, interact, switch weapons
-- — it's purely a ride. Checked here by his own actions, and by the
-- input handlers before they'd even try (InputHandlers.lua,
-- GamePadInput.lua).
function Player:isCannonRiding()
  return self.inCannon ~= nil or self.cannonFlight ~= nil
end

function Player:enterBallMode()
  if not BALL_MODE_ENABLED then return end
  if self.isBall or self.morphState or state.dialogueActive or self.isTeleporting or self.isDying then return end
  if self:isCannonRiding() then return end
  if state.vatsActive then return end -- in V.A.T.S. he only picks a target and pulls to it (see main.lua's own V.A.T.S. rules)
  self.morphState = "toBall"
  self.morphElapsed = 0
  if state.audioManager then state.audioManager:playMorphBall() end
  -- Curling up mid ground pound calls the pound off (see
  -- tryGroundPound: a ball doesn't pound) — he just falls as a ball.
  self.isGroundPounding = false
end

-- Instantly becomes a ball — no curl-in animation, no guards (not even
-- BALL_MODE_ENABLED/isTeleporting) — for the one case where he should
-- already BE a ball the moment he arrives somewhere, rather than
-- morphing in place: the pinball planet's own entry beam (see
-- PinballInterior.lua:onEnter), called from inside the teleport
-- sequence itself, while isTeleporting is still true and would
-- otherwise block the ordinary animated enterBallMode above.
function Player:forceBallMode()
  self.isBall = true
  self.radius = self.baseRadius * BALL_RADIUS_MULTIPLIER
  self.morphState = nil
  self.morphElapsed = 0
end

-- Starts the stand-back-up animation, played in REVERSE — see
-- updateBallMorph/drawBallMorphTransition. Ignored while not currently
-- a ball, already mid-transition either direction, or talking to an NPC
-- (same reasoning as enterBallMode's own dialogueActive check above).
function Player:exitBallMode()
  if not self.isBall or self.morphState or state.dialogueActive or self.isTeleporting or self.isDying then return end
  if state.vatsActive then return end -- in V.A.T.S. he only picks a target and pulls to it (see main.lua's own V.A.T.S. rules)
  if self.inPinball then return end -- he's the pinball until he drains (PinballInterior:exitBall clears inPinball first)
  if self:isCannonRiding() then return end -- curled up for the whole ride, barrel and flight (see lua/world/Cannon.lua)
  -- No room to stand up (in a ball tunnel — see CrackedPlanetoid:standingRoomAt).
  local planet = self.currentPlanet or self.lastInfluencePlanet
  if planet and planet.standingRoomAt and not planet:standingRoomAt(self) then return end
  -- (Or in one of the sky dome's — see TiledTerrain.lua's Level:standingRoomAt.)
  for _, level in ipairs(state.tiledLevels or {}) do
    if level.standingRoomAt and not level:standingRoomAt(self) then return end
  end
  self.morphState = "toHuman"
  self.morphElapsed = 0
  if state.audioManager then state.audioManager:playMorphUnball() end
end

-- Advances whichever transition (if any) is currently playing, and
-- flips the actual functional isBall/radius state the instant it
-- completes — see BALL_MORPH_SEGMENT_TICKS's own comment for why that
-- boundary is at the END of each direction's animation, not the start.
function Player:updateBallMorph(ts)
  if not self.morphState then return end
  self.morphElapsed = self.morphElapsed + ts
  if self.morphElapsed >= BALL_MORPH_SEGMENT_TICKS * 2 then
    if self.morphState == "toBall" then
      self.isBall = true
      self.radius = self.baseRadius * BALL_RADIUS_MULTIPLIER
    else
      self.isBall = false
      self.radius = self.baseRadius
    end
    self.morphState = nil
    self.morphElapsed = 0
  end
end

------------------------------------------------------------------
-- Teleport (Beam.lua)
------------------------------------------------------------------

-- Starts the teleport sequence toward another Beam's own planted base —
-- called from Beam:tryInteract, same "the object itself decides whether
-- the player's close enough" split Lever.lua's own tryInteract uses.
-- origin: the beam he's actually standing at (used only for
-- Player:getTransporterState's shimmer color — see that function's own
-- comment). Ignored while already teleporting, curling into/out of a
-- ball, or talking to an NPC (same reasoning as enterBallMode's own
-- guard above) — Beam:tryInteract also checks isTeleporting itself
-- before even calling this, but the guard belongs here too since
-- nothing stops some OTHER future caller from reaching this directly.
function Player:startTeleport(origin, destination)
  if self.isTeleporting or self.isDying or self.morphState or state.dialogueActive then return end
  if self:isCannonRiding() then return end
  if not destination then return end
  self.isTeleporting = true
  self.teleportState = "out"
  self.teleportTimer = TELEPORT_OUT_TICKS
  self.teleportOrigin = origin
  self.teleportDestination = destination
  self.vel.x, self.vel.y = 0, 0
end

-- Advances the teleport sequence above (see Player:getTransporterState
-- for the shimmer drawn over both halves). The actual position
-- swap happens the instant the "out" pause reaches zero: lands at the
-- destination beam's own PLANTED BASE (destination.pos), not its portal
-- tip (Beam:getPortalPosition, Beam.LENGTH further out) — the tip can be
-- outside whatever he's meant to land ON (e.g. well past a small landing
-- planet's own gravity influence). Offset outward from that base by his own radius,
-- along the beam's own facing direction, same as standing on any
-- ordinary surface (his CENTER sits radius above the ground, not
-- exactly on it). Then clears onSurface/currentPlanet/touchingWall so
-- gravity/landing re-acquire completely fresh from the new position
-- next frame — exactly the ordinary way every other arrival at a planet
-- already works (falling in from open space), rather than trying to
-- force an instant landing onto whatever happens to be below — and
-- starts the post-arrival invincibility window (Player:isInvincible —
-- see INVINCIBLE_TICKS's own comment). A short "in" pause (just holding him
-- still a beat longer, no visual pulse of its own) follows before
-- isTeleporting finally clears and normal input resumes — invincibility
-- itself outlasts this pause and keeps flickering for a bit after he
-- can already move again.
function Player:updateTeleport(ts)
  if not self.teleportState then return end
  self.teleportTimer = self.teleportTimer - ts
  if self.teleportTimer > 0 then return end

  if self.teleportState == "out" then
    local destination = self.teleportDestination
    if destination then
      local dirX, dirY = math.cos(destination.angle), math.sin(destination.angle)
      self.pos.x = destination.pos.x + dirX * self.radius
      self.pos.y = destination.pos.y + dirY * self.radius
      -- Also re-anchor prevPos to the SAME spot: it was captured at the
      -- top of this frame's own Player:update(), before this jump, so
      -- left alone it would describe a single-frame "travel" spanning
      -- the entire distance from the origin beam to here — exactly the
      -- kind of large motion CollisionSystem's own swept checks
      -- (findLandingCrossing, sweptCircleEntryT) are built to catch, and
      -- would risk a spurious collision against anything that happened
      -- to sit along that straight line between the two beams.
      self.prevPos = self.pos:clone()
    end
    self.onSurface = false
    self.currentPlanet = nil
    self.touchingWall = nil
    self.wallContactNormal = nil
    self.invincibleTimer = INVINCIBLE_TICKS
    self.teleportState = "in"
    self.teleportTimer = TELEPORT_IN_TICKS
    -- Optional extension point for a destination that needs to do more
    -- than just "stand him here" the instant he arrives — e.g. the
    -- pinball planet's own entry beam (see main.lua's own setup),
    -- whose destination.onArrive curls him into a ball and hands
    -- control to PinballInterior:onEnter. Every ordinary Beam<->Beam
    -- destination simply has no onArrive field, so this is a no-op for
    -- them.
    if destination and destination.onArrive then
      destination.onArrive(self)
    end
  else
    self.isTeleporting = false
    self.teleportState = nil
    self.teleportOrigin = nil
    self.teleportDestination = nil
  end
end

-- See INVINCIBLE_TICKS's own comment. Checked by Player:startDeath
-- and by Player:draw for the flicker itself.
function Player:isInvincible()
  return self.invincibleTimer > 0
end

------------------------------------------------------------------
-- Pull anchor (SkyDome → grass deck; others → center)
------------------------------------------------------------------

function Player:getPullAnchor(target)
  if not target then
    return self.pos.x, self.pos.y
  end
  if target.isSkyDome then
    if target.getPullAnchor then
      return target:getPullAnchor()
    end
    if target.trueSurfaceY then
      return target.pos.x, target:trueSurfaceY()
    end
  end
  return target.pos.x, target.pos.y
end


function Player:updateBubbles()
  local timeScale = state.timeScale or 1
  self.bubbles = self.bubbles or {}

  if self.submergedIn and #self.bubbles < BUBBLE_MAX_COUNT and math.random() < BUBBLE_SPAWN_CHANCE * timeScale then
    local water = self.submergedIn
    local away = self.pos:subtract(water.pos)
    local dist = away:length()
    local angle = dist > 1 and math.atan2(away.y, away.x) or (math.random() * math.pi * 2)

    -- Spawned past the player's OWN position along this same radial
    -- line (not at a fixed screen offset) — that's what keeps it
    -- "above his head" regardless of which side of the core he's
    -- currently on. Skipped entirely if he's already right at the
    -- surface, with no room left to spawn one before the target.
    local spawnR = dist + self.radius * BUBBLE_HEAD_GAP
    Bubbles.spawn(self.bubbles, water.pos.x, water.pos.y, angle, spawnR, water.radius, BUBBLES)
  end

  Bubbles.update(self.bubbles, timeScale)
end

-- Drawn separately from the rest of the player (see main.lua's own call
-- site, right after the water planet's second draw pass) so bubbles
-- stay visible on top of the translucent water fill instead of getting
-- muddied underneath it.
function Player:drawBubbles()
  Bubbles.draw(self.bubbles or {})
end

function Player:update()
  -- Captured before this frame's own movement, so CollisionSystem can
  -- compare "where was I a moment ago" against "where am I now" — a
  -- swept crossing test against open-path terrain, the same principle
  -- ordinary platformer tile collision uses instead of a plain distance
  -- check. See TerrainShape:findLandingCrossing.
  self.prevPos = self.pos:clone()

  -- Frozen in place for the whole death pause — nothing below (morph,
  -- teleport, movement integration) should advance until he respawns.
  if self.isDying then
    self:updateDeath(state.timeScale)
    return
  end

  self:updateBallMorph(state.timeScale)
  self:updateTeleport(state.timeScale)
  self:updateJumpGraces(state.timeScale)

  if self.invincibleTimer > 0 then
    self.invincibleTimer = math.max(0, self.invincibleTimer - state.timeScale)
  end

  if self.swimStrokeTimer > 0 then
    self.swimStrokeTimer = math.max(0, self.swimStrokeTimer - state.timeScale)
  end

  -- Ground pound: time the pose, and catch the landing. isGroundPounding
  -- is cleared by the collision pass the moment he touches down (after
  -- this function has already run for that frame), so "it was true last
  -- time and now it isn't, and he's standing on something" is the
  -- landing — as opposed to a pound that ended some other way (bouncing
  -- off an Ooomba, dropping into water), which gets no impact.
  if self.isGroundPounding and not self.onSurface then
    self.groundPoundPoseTime = self.groundPoundPoseTime + state.timeScale
  end
  if self.wasGroundPounding and not self.isGroundPounding and self.onSurface then
    self.groundPoundImpactTimer = GROUND_POUND_IMPACT_TICKS
    local down = self:visualDownDirection(self.currentPlanet)
    GroundPoundBurst.spawn(
      self.pos.x + down.x * self.radius, self.pos.y + down.y * self.radius,
      Vector2.new(-down.x, -down.y))
    if state.audioManager then state.audioManager:playGroundPound() end

    -- Landed on a breakable tile (see CrackedPlanetoid:poundBreak): it
    -- shatters and he drops into the hole — no sitting on the ground.
    -- Jump still held, the pound carries on and breaks the next one he
    -- lands on, and so on down; let go, and he just falls the rest.
    local planet = self.currentPlanet
    if planet and planet.poundBreak and planet:poundBreak(self) then
      self.groundPoundImpactTimer = 0
      local jumpHeld = state.keys[' '] or state.gamepadJumpHeld
      if jumpHeld and not self.onSurface then
        self.isGroundPounding = true
      end
    end
  elseif self.groundPoundImpactTimer > 0 then
    self.groundPoundImpactTimer = self.onSurface and math.max(0, self.groundPoundImpactTimer - state.timeScale) or 0
  end
  if not self.isGroundPounding and self.groundPoundImpactTimer <= 0 then
    self.groundPoundPoseTime = 0
  end
  self.wasGroundPounding = self.isGroundPounding

  -- Recomputed fresh every frame, regardless of onSurface — a water
  -- planet never sets onSurface (see CollisionSystem's own comment), so
  -- this plain distance-to-center check is the only signal :jump() and
  -- the airborne drag below have for "currently inside one."
  local wasSubmergedIn = self.submergedIn
  self.submergedIn = nil
  if state.planetoids then
    for _, p in ipairs(state.planetoids) do
      if p.isWaterPlanet and self.pos:subtract(p.pos):length() < p.radius then
        self.submergedIn = p
        break
      end
    end
  end
  -- ...or in a pool of sprayed water (see lua/systems/WaterSystem.lua).
  if not self.submergedIn and not self.inPinball then
    self.submergedIn = WaterSystem.submergedAt(self)
  end

  -- Splash the instant submergedIn actually flips (either direction) —
  -- comparing this frame's result against last frame's is what catches
  -- the crossing itself, rather than "is currently submerged" which
  -- would fire every single frame he's underwater.
  if self.submergedIn ~= wasSubmergedIn then
    local water = self.submergedIn or wasSubmergedIn
    Splash.spawn(self.pos, self.pos:subtract(water.pos):normalize())
  end

  -- Guards against a real stuck-gravity bug: isGroundPounding only ever
  -- gets cleared by actually LANDING (CollisionSystem:tryLandOnPlanet),
  -- which water never does. If Space is pressed in the one-frame gap
  -- right as a swim stroke carries the player just past the surface
  -- (submergedIn already nil, onSurface/touchingWall still false), the
  -- input gate falls through to tryGroundPound() instead of jump() —
  -- and since his velocity is still outward at that exact instant,
  -- tryGroundPound() sets isGroundPounding true. With nothing to ever
  -- land on nearby, that stuck flag triples gravity (see
  -- GROUND_POUND_GRAV_MULTIPLIER) for as long as he's near the water,
  -- reading as "swimming suddenly stops working." Ground-pounding while
  -- floating in open water doesn't mean anything anyway, so just clear
  -- it unconditionally whenever submerged.
  if self.submergedIn then
    self.isGroundPounding = false
  end

  self:updateBubbles()

  -- Marks the moment the shelter door reaches fully open
  -- (state.spaceShelter.playerInFront flips true — see
  -- SpaceShelter.lua's own intro state machine) so drawFullBody can
  -- ease the rigid intro pose back to normal over
  -- INTRO_POSE_TRANSITION_SECONDS instead of snapping there in one
  -- frame. Deliberately keyed off playerInFront, not
  -- state.introLocked/introDone (movement stays locked through the
  -- door closing behind him too) — the ONLY reason the arm was held
  -- rigid was to avoid poking out past the door's still-closing frame,
  -- and that concern is already gone the moment he's drawn in front of
  -- it. self.wasPlayerInFront starts nil specifically so the very
  -- first call just establishes a baseline rather than firing a false
  -- transition.
  local playerInFront = state.spaceShelter and state.spaceShelter.playerInFront or false
  if self.wasPlayerInFront == nil then self.wasPlayerInFront = playerInFront end
  if (not self.wasPlayerInFront) and playerInFront then
    self.introPoseBlendStart = love.timer.getTime()
  end
  self.wasPlayerInFront = playerInFront

  if self.wallJumpLockTimer > 0 then
    self.wallJumpLockTimer = self.wallJumpLockTimer - state.timeScale
    if self.wallJumpLockTimer <= 0 then
      self.wallJumpLockBlockedDir = nil
    end
  end

  -- isWallSliding drives drawFullBody's dedicated wall-slide pose (see
  -- drawWallSlidePose) — reset false unconditionally, every frame,
  -- BEFORE the onSurface check below, not inside it: landing on a ledge
  -- or the ground mid-slide sets onSurface true, which would otherwise
  -- skip the whole airborne block below (reset included) and leave this
  -- stuck true forever, still rendering the wall-slide pose while
  -- standing on solid ground.
  self.isWallSliding = false

  -- Not while on a pinball table: PinballInterior:updateBall already
  -- moved him this frame, with its own collision. Moving him again here
  -- (with no collision at all, plus space drag) pushed the ball into the
  -- table's walls at speed — e.g. off the top curve, back down the lane.
  if not self.onSurface and not self.inPinball then
    -- Wall slide: touchingWall/wallContactNormal reflect contact as of
    -- the END of last frame's collision pass (CollisionSystem resets and
    -- rechecks them once per frame in main.lua) — one frame behind, same
    -- as onSurface/currentPlanet already are by the same mechanism, and
    -- not something a player can perceive. Only caps a fall that's
    -- already faster than the slide speed, and only while the direction
    -- key into that wall is actively held — letting go resumes a normal
    -- fall immediately even while still touching it.
    --
    -- Facing is forced AWAY from the wall for the whole slide (not just
    -- at the kick-off, which already did this) to match how that pose
    -- was authored, and so there's no sudden snap-turn the instant he
    -- jumps off — he's already facing that way throughout.
    if self.touchingWall and self.wallContactNormal and self.vel.y > self.wallSlideMaxFallSpeed and not self.isBall then
      local towardWallDir = self.wallContactNormal.x > 0 and -1 or 1
      local holdingIntoWall = (towardWallDir == -1 and state.keys["ArrowLeft"])
        or (towardWallDir == 1 and state.keys["ArrowRight"])
      if holdingIntoWall then
        self.vel.y = self.wallSlideMaxFallSpeed
        self.isWallSliding = true
        self.facingDirection = -towardWallDir
      end
    end

    -- Water's own much stronger drag (vs. ordinary space DRAG) is what
    -- makes sinking read as pushing through resistance instead of just
    -- falling slower — gravity itself (GravitySystem) is untouched, so
    -- without this a submerged player would fall exactly like they do
    -- anywhere else.
    -- (None at all on a cannon shot: it flies dead straight at full
    -- speed until it's near the target — see Cannon.updateFlight.)
    local dragFactor = self.submergedIn and self.waterDrag or constants.DRAG
    if self.cannonFlight then dragFactor = 1 end
    self.vel:scale(dragFactor ^ state.timeScale)
    self.pos:addScaled(self.vel, state.timeScale)

    if self.pos.x - self.radius < 0 then self.pos.x = self.radius; self.vel.x = -self.vel.x end
    if self.pos.x + self.radius > state.sceneWidth then self.pos.x = state.sceneWidth - self.radius; self.vel.x = -self.vel.x end
    if self.pos.y - self.radius < 0 then self.pos.y = self.radius; self.vel.y = -self.vel.y end
    if self.pos.y + self.radius > state.sceneHeight then self.pos.y = state.sceneHeight - self.radius; self.vel.y = -self.vel.y end
  end

  self:updateOrientationAndFacing()
end

------------------------------------------------------------------
-- Facing / orientation
------------------------------------------------------------------

function Player:updateOrientationAndFacing()
  if self.mode ~= "space" then return end

  -- Locked facing right for the door-opening intro (see main.lua's
  -- state.introLocked and drawFullBody's own poseBlend) — skips the
  -- normal mouse-tracking facing logic below entirely, so moving the
  -- mouse during the cutscene can't turn him around mid-reveal.
  -- (Not on the title screen, which is also introLocked the whole time
  -- but has him running around on autopilot — see TitleScreen.lua.)
  if state.introLocked and not state.titleScreen then
    self.facingDirection = 1
    return
  end

  local lastMove = state.lastMouseMoveTime or 0
  local lastWheel = state.lastWheelTime or 0
  local now = love.timer.getTime()

  -- The title screen ignores the mouse outright (always "idle"), so
  -- the autopilot's own movement decides which way he faces rather
  -- than wherever the cursor happens to be sitting.
  local recentlyScrolled = (now - lastWheel) < self.mouseWheelSuppressDuration
  self.mouseIdle = not self.lockedTarget
    and not state.gamepadAimActive
    and (state.titleScreen or recentlyScrolled or (now - lastMove) > self.mouseIdleThreshold)

  if self.mouseIdle then return end

  local planet = self.onSurface and self.currentPlanet or self.lastInfluencePlanet
  local downDir = self:visualDownDirection(planet)
  local downAngle = math.atan2(downDir.y, downDir.x)
  local orientation = downAngle - math.pi / 2
  local tangentX = math.cos(orientation)
  local tangentY = math.sin(orientation)

  local toTargetX, toTargetY
  if self.lockedTarget then
    toTargetX = self.lockedTarget.pos.x - self.pos.x
    toTargetY = self.lockedTarget.pos.y - self.pos.y
  elseif state.gamepadAimActive then
    toTargetX = state.gamepadAimX or 0
    toTargetY = state.gamepadAimY or 0
  else
    local cam = state.camera or { x = 0, y = 0 }
    local zoom = state.zoom or 1
    local mouse = state.mouse or { x = self.pos.x, y = self.pos.y }
    local mouseWorldX = mouse.x / zoom + cam.x
    local mouseWorldY = mouse.y / zoom + cam.y
    toTargetX = mouseWorldX - self.pos.x
    toTargetY = mouseWorldY - self.pos.y
  end

  -- Wall-jump facing lock and wall-sliding both force facing away from
  -- the wall on their own (see Player:jump and Player:update) — this
  -- mouse-driven reassignment is skipped while either is active, or it
  -- could flip him back around mid-slide/mid-lock just from moving the
  -- cursor, regardless of what direction is actually held.
  if self.wallJumpLockTimer <= 0 and not self.isWallSliding then
    local projection = toTargetX * tangentX + toTargetY * tangentY
    self.facingDirection = projection >= 0 and 1 or -1
  end
end


-- Lethal contact (Spikey, FireBar, Ooomba — see CollisionSystem.lua's
-- own call sites, which call this unconditionally every frame contact
-- continues; the isDying check is what makes that a single death).
-- Ignored while invincible (just respawned, or just arrived via a beam —
-- see INVINCIBLE_TICKS) or mid-teleport. He vanishes in a burst right
-- where he was hit, stays gone for DEATH_TICKS (see Player:updateDeath),
-- then reappears at state.respawnPoint (see Player:respawn).
function Player:startDeath()
  if self.isDying or self.isTeleporting or self:isInvincible() then return end

  self.isDying = true
  self.deathTimer = DEATH_TICKS
  -- Decided now, from where he actually died — not at respawn time.
  -- nil (no DeathZone here) falls back to state.respawnPoint.
  self.deathZoneRespawn = nil
  for _, zone in ipairs(state.deathZones or {}) do
    if self.pos.x >= zone.x and self.pos.x <= zone.x + zone.width
       and self.pos.y >= zone.y and self.pos.y <= zone.y + zone.height then
      self.deathZoneRespawn = { x = zone.respawnX, y = zone.respawnY }
      break
    end
  end
  self.vel.x, self.vel.y = 0, 0
  self.pullTarget = nil
  self.lockedTarget = nil

  local Explosion = require("lua.entities.Explosion")
  state.explosions = state.explosions or {}
  table.insert(state.explosions, Explosion.new(self.pos.x, self.pos.y))
  if state.audioManager then state.audioManager:playDeath() end
end

function Player:updateDeath(ts)
  self.deathTimer = self.deathTimer - ts
  if self.deathTimer <= 0 then
    self:respawn()
  end
end

-- Puts him back at state.respawnPoint (the Space Shelter's own doorway —
-- set once in main.lua, right where the game's own opening spawn is) —
-- or, if he died inside a Tiled "DeathZone", at that zone's own respawn
-- point (see startDeath) —
-- standing, on foot, with everything transient about wherever he died
-- cleared, and the same brief invincibility a beam arrival gets.
function Player:respawn()
  local point = self.deathZoneRespawn or state.respawnPoint
  self.deathZoneRespawn = nil
  -- Any trip through a portal is called off (see lua/systems/PortalGun.lua),
  -- and so is being in or fired from a cannon (see lua/world/Cannon.lua).
  self.portalTransit, self.portalDown = nil, nil
  self.inCannon, self.cannonFlight = nil, nil
  if point then
    self.pos.x, self.pos.y = point.x, point.y
    if point.planet then
      self.onSurface = true
      self.currentPlanet = point.planet
      self.lastInfluencePlanet = point.planet
      -- On a round planet his place on it IS this angle (from its
      -- centre) — straight up would put him on its very top, wherever
      -- the point actually is. Flat surfaces (the dome's deck) don't use it.
      if point.planet.isRoundedRect then
        self.angle = -math.pi / 2
      else
        self.angle = math.atan2(point.y - point.planet.pos.y, point.x - point.planet.pos.x)
      end
    else
      -- A DeathZone's own respawn point names no surface — he's left
      -- airborne there and lands through the ordinary collision pass,
      -- same as a beam arrival (see updateTeleport).
      self.onSurface = false
      self.currentPlanet = nil
    end
  end
  -- Same reasoning as updateTeleport's own prevPos re-anchor: without
  -- it, this frame's swept collision checks would see a single-frame
  -- "travel" all the way from where he died to here.
  self.prevPos = self.pos:clone()
  self.vel.x, self.vel.y = 0, 0

  self.isBall = false
  self.radius = self.baseRadius
  self.morphState = nil
  self.morphElapsed = 0
  self.isGroundPounding = false
  self.wasGroundPounding = false
  self.groundPoundImpactTimer = 0
  self.groundPoundPoseTime = 0
  self.isWallSliding = false
  self.touchingWall = nil
  self.wallContactNormal = nil
  self.wallClimbDir = nil
  self.wallClimbDirPlanet = nil
  self.wallJumpLockTimer = 0
  self.wallJumpLockBlockedDir = nil
  -- Cleared directly (not left for Player:update to notice) so dying
  -- underwater doesn't play a "left the water" splash at the shelter.
  self.submergedIn = nil
  self.bubbles = {}

  self.isDying = false
  self.deathTimer = 0
  self.invincibleTimer = INVINCIBLE_TICKS

  -- A respawn point can name a pinball table (point.pinball, a
  -- PinballInterior) to put him straight onto its plunger as a ball.
  self.inPinball = nil
  if point and point.pinball then
    point.pinball:onEnter(self)
  end
end


-- The methods kept in lua/entities/player/ (see the top of this file).
for _, part in ipairs({
  require("lua.entities.player.Movement"),
  require("lua.entities.player.Rendering"),
  require("lua.entities.player.Targeting"),
}) do
  for name, method in pairs(part) do
    assert(Player[name] == nil, "Player." .. name .. " is defined twice")
    Player[name] = method
  end
end

return Player
