-- lua/entities/Player.lua
--
-- Scoped port of js/entities/Player.js focusing on:
--   - Existing physics / movement / landing / pull
--   - Full-body astronaut rig (body, head, arms, boots)
--   - Planet-surface orientation + walk cycle
--   - Basic left-arm aim toward mouse / pull target
--   - SkyDome pull/aim/walk toward grass deck (trueSurfaceY)
--
-- Not yet ported (deliberately): maze/platform modes, death animations,
-- Pixi path, etc. Beam.lua teleport IS ported (Player:startTeleport/
-- updateTeleport/getTeleportPulse), including its own brief post-arrival
-- invincibility flicker (Player:isInvincible).

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local constants = require("lua.constants")
local DustPuff = require("lua.effects.DustPuff")
local Splash = require("lua.effects.Splash")
local GroundPoundBurst = require("lua.effects.GroundPoundBurst")
local SilhouetteGlow = require("lua.effects.SilhouetteGlow")
local TargetLock = require("lua.systems.TargetLock")

local Player = {}
Player.__index = Player

-- How long, once the door-opening intro ends (state.introLocked flips
-- false), the rigid intro pose (arms/head — see drawFullBody's own
-- poseBlend) takes to ease back into whatever the normal pose would
-- be, rather than snapping there in one frame.
local INTRO_POSE_TRANSITION_SECONDS = 0.6

-- Ground pound (see Player:update's own ground-pound bookkeeping, and
-- GROUND_POUND_POSE / Player:getGroundPoundSeatDrop further down).
local GROUND_POUND_SETTLE_TICKS = 7   -- baseline (60fps) ticks the pose takes to sink down into its seated position at the start of a pound
local GROUND_POUND_IMPACT_TICKS = 14  -- ticks he stays sat on the ground after landing one, before standing back up
local GROUND_POUND_SEAT_ADJUST = 0    -- world units added to the computed seat drop (positive = lower still) — fine-tuning only

-- Sun shading on the astronaut — the same treatment every planetoid
-- gets (see Planetoid.lua's own getSunShadingShader), applied separately to
-- EACH piece of his rig (head, body, each arm, each boot): a lit side
-- facing the sun, falling off into shadow on the far side, with a soft
-- highlight on the lit side. Each piece is shaded as its own rounded
-- form, so he reads as a set of solid parts rather than one flat cutout.
--
-- The numbers mirror Planetoid.lua's: the shadow gradient is centered
-- shadowOffset of the way toward the sun and runs out over shadowReach
-- (both in units of the piece's own half-size); the highlight sits
-- highlightOffset toward the sun and is highlightSize across.
--   strength   how much of that shadow is actually applied — 1 is the
--              full planetoid treatment (far side nearly black), 0 none.
--
-- HERO_SHADING_ENABLED is the one switch for all of it — the rig's
-- pieces AND the ball he curls into. false draws him exactly as he was
-- before any of this existed.
local HERO_SHADING_ENABLED = true

local BODY_SHADING = {
  strength = 0.28,
  shadowOffset = 0.5,
  shadowReach = 1.6,
  overallDarken = 0.08,
  highlightAlpha = 0.22,
  highlightSize = 0.55,
  highlightOffset = 0.48,
}

-- One shader for every piece. It needs to know, for each pixel of
-- whichever image is being drawn, where that pixel sits relative to the
-- image's own center IN SCREEN SPACE — the rig rotates, scales and
-- mirrors its pieces every which way, and the light has to come from
-- the same direction on screen regardless. Rather than being told each
-- piece's transform, it recovers that from the image's own texture
-- coordinates: dFdx/dFdy say how the coordinates change from one screen
-- pixel to the next, and inverting that turns "this far from the middle
-- of the image" back into a direction and distance on screen. Anything
-- drawn without an image (plain shapes) has no such gradient and is
-- left untouched.
local bodyShadingShader = nil
local function getBodyShadingShader()
  if bodyShadingShader then return bodyShadingShader end
  bodyShadingShader = love.graphics.newShader([[
    extern vec2 lightDir;        // unit vector on screen, toward the sun
    extern float strength;
    extern float shadowOffset;
    extern float shadowReach;
    extern float overallDarken;
    extern float highlightAlpha;
    extern float highlightSize;
    extern float highlightOffset;

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec4 texel = Texel(tex, uv) * color;

      vec2 dx = dFdx(uv);
      vec2 dy = dFdy(uv);
      float det = dx.x * dy.y - dx.y * dy.x;
      if (abs(det) < 1e-12) return texel;

      // Screen-space offset of this pixel from the image's center, and
      // the image's own half-width/half-height as screen-space vectors.
      vec2 d = uv - vec2(0.5);
      vec2 offset = vec2(dy.y * d.x - dy.x * d.y, dx.x * d.y - dx.y * d.x) / det;
      vec2 halfW = vec2(dy.y, -dx.y) * 0.5 / det;
      vec2 halfH = vec2(-dy.x, dx.x) * 0.5 / det;
      float size = max(length(halfW), length(halfH));
      if (size < 1e-6) return texel;
      vec2 q = offset / size;   // -1..1 across the piece's longer side

      float lit = clamp(1.0 - length(q - lightDir * shadowOffset) / shadowReach, 0.0, 1.0);
      float shade = mix(1.0, lit, strength) * (1.0 - overallDarken * strength);

      float h = clamp(1.0 - length(q - lightDir * highlightOffset) / highlightSize, 0.0, 1.0);
      h = h * h * highlightAlpha;

      vec3 rgb = texel.rgb * shade + vec3(1.0, 0.98, 0.92) * h * texel.a;
      return vec4(rgb, texel.a);
    }
  ]])
  for _, name in ipairs({ "strength", "shadowOffset", "shadowReach", "overallDarken", "highlightAlpha", "highlightSize", "highlightOffset" }) do
    bodyShadingShader:send(name, BODY_SHADING[name])
  end
  return bodyShadingShader
end

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
-- InputHandlers.lua/GamePadInput.lua's own calls into
-- enterBallMode/exitBallMode, and Player:drawBallMode for how it's
-- actually drawn). BALL_RADIUS_MULTIPLIER is deliberately the ONE
-- number behind both "about half his current height" (the drawn
-- ball's own radius) and "his collision boundary should be shorter" —
-- those are the same physical shrink, not two separately-tuned values,
-- since the ball's visible silhouette should always exactly match
-- where its actual collision is.
local BALL_RADIUS_MULTIPLIER = 0.792 -- 0.5 * 1.2 * 1.2 * 1.1 — bumped 20%, 20%, then another 10% bigger
local BALL_SPEED_MULTIPLIER  = 2.1  -- 1.25 * 1.2 * 1.4 — bumped 20%, then another 40% faster

-- Curl-into-a-ball transition: two authored keyframes (see
-- BALL_MORPH_FRAME_1/2 near drawBallMorphPose, in the Drawing section
-- below) played in order on the way in, reversed on the way out, before/
-- after the plain ball circle itself. self.isBall (and therefore
-- self.radius/ground speed — everything actually FUNCTIONAL) only
-- flips at the very END of whichever direction is playing — see
-- Player:updateBallMorph — so he's fully humanoid-physics throughout
-- the curl-in animation, and stays ball-sized/ball-speed throughout the
-- whole stand-back-up animation too, only becoming humanoid again once
-- he's actually fully stood up.
local BALL_MORPH_SEGMENT_TICKS = 8 -- baseline (60fps) ticks each of the two keyframe blends takes — a full transition either direction is 2x this, ~0.27s at 60fps

-- Teleport (Beam.lua's own :tryInteract) — a freeze-then-snap, not a
-- fade/cutscene: TELEPORT_OUT_TICKS is the pause before he vanishes
-- from the origin beam, with Player:getTeleportPulse's own scale/glow
-- blip playing out over it (see that function's own comment — ONLY this
-- half gets the blip, not the arrival half: a visible "launching" swell
-- on the way out, not a symmetric one on both ends). TELEPORT_IN_TICKS
-- is the equally paced, but visually plain, "arriving" pause right
-- after landing at the destination — just holds him still a beat longer
-- before normal input resumes, no scale/glow of its own. Both in
-- baseline (60fps) ticks; 30 = 0.5s, close to half of the old JS game's
-- own single 900ms teleportDuration (js/entities/Player.js), since that
-- one pulse covered a whole mode-switch and this one only needs to
-- cover the departure half.
local TELEPORT_OUT_TICKS = 30
local TELEPORT_IN_TICKS = 30

-- Brief post-arrival invincibility (same name/duration/flicker-rate as
-- the old JS game's own invincibleDuration/isInvincible — see that
-- file's own "so an enemy sitting near the beam entrance can't get a
-- free kill the instant he arrives somewhere new" comment, which
-- applies exactly as much to arriving via Beam.lua here). Counted down
-- in baseline (60fps) ticks like everything else in this file, not
-- wall-clock time the way the JS original's Date.now()-based version
-- was — 120 ticks = 2s at 60fps, matching its own 2000ms.
local INVINCIBLE_TICKS = 120
local INVINCIBLE_FLICKER_INTERVAL = 0.1 -- seconds per blink phase — matches the JS original's own 100ms

-- Death (Player:startDeath/updateDeath/respawn): how long he stays
-- gone — hidden and frozen where he died, his death burst playing out —
-- before reappearing at state.respawnPoint. Baseline (60fps) ticks.
local DEATH_TICKS = 50

local BUBBLE_HEAD_GAP         = 1.4 -- spawn distance from center, as a multiple of self.radius past the player's own position — clears his helmet instead of sitting on it
local BUBBLE_FADE_DISTANCE    = 20   -- world units of travel, just before reaching the water's own radius, that a bubble fades out over
local BUBBLE_RISE_SPEED_MIN   = 0.5  -- world units per baseline frame, radially outward
local BUBBLE_RISE_SPEED_MAX   = 1.1
local BUBBLE_WOBBLE_FREQ_MIN  = 0.01 -- radians per baseline frame the angular wobble oscillates at
local BUBBLE_WOBBLE_FREQ_MAX  = 0.03
local BUBBLE_WOBBLE_AMPLITUDE = 0.1  -- radians of angular sway at full swing
local BUBBLE_RADIUS_MIN       = 2.5
local BUBBLE_RADIUS_MAX       = 6
local BUBBLE_COLOR            = { 0.85, 0.97, 1.0 }

local function newBubble(centerX, centerY, angle, startR, targetR)
  return {
    centerX = centerX,
    centerY = centerY,
    baseAngle = angle,
    r = startR,
    targetR = targetR,
    wobblePhase = math.random() * math.pi * 2,
    wobbleFreq = BUBBLE_WOBBLE_FREQ_MIN + math.random() * (BUBBLE_WOBBLE_FREQ_MAX - BUBBLE_WOBBLE_FREQ_MIN),
    riseSpeed = BUBBLE_RISE_SPEED_MIN + math.random() * (BUBBLE_RISE_SPEED_MAX - BUBBLE_RISE_SPEED_MIN),
    radius = BUBBLE_RADIUS_MIN + math.random() * (BUBBLE_RADIUS_MAX - BUBBLE_RADIUS_MIN),
  }
end

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
  -- ground on foot would. (This used to also stack with a SEPARATE
  -- fixed launch-direction tilt — getOutwardLaunchDirection's own
  -- former jumpHorizontalCarry — which is what made even a plain
  -- walking jump launch at roughly 3x normal speed; that mechanism is
  -- gone now, so this is the only horizontal-carry knob left.)
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
  -- * runSpeedMultiplier) rather than some larger fixed number — this
  -- used to be a flat 13, well above the ~9 you can ever reach by
  -- running, which meant holding a direction through a jump let you
  -- keep accelerating past your own top running speed every single
  -- jump (compounding further on repeated/bunny-hop jumps). Mario-style
  -- platformers never let jumping outrun running like that — a jump
  -- carries and lets you maintain your ground speed in the air, it
  -- doesn't add to it — so this caps air speed at exactly that ceiling
  -- instead of letting it run higher.
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

-- Re-enabled — Down/Triangle now only ENTER/EXIT ball mode on a clean
-- press (not held-stick drift), so the earlier "too easy to trigger
-- while just walking" issue (see git history) shouldn't recur. Flip
-- back to false again if it does.
local BALL_MODE_ENABLED = true

-- Starts the curl-in ANIMATION — self.isBall itself (and therefore
-- self.radius/ground speed) doesn't flip until updateBallMorph below
-- finishes playing it. Ignored while any transition is already in
-- progress (can't interrupt/re-trigger mid-curl), same as it being
-- ignored while already fully a ball or while talking to an NPC
-- (state.dialogueActive — movement/jumping are already frozen then, see
-- Player:move/jump, and starting a morph mid-conversation would be the
-- same kind of "moving" while supposedly standing still talking).
function Player:enterBallMode()
  if not BALL_MODE_ENABLED then return end
  if self.isBall or self.morphState or state.dialogueActive or self.isTeleporting or self.isDying then return end
  if state.vatsActive then return end -- in V.A.T.S. he only picks a target and pulls to it (see main.lua's own V.A.T.S. rules)
  self.morphState = "toBall"
  self.morphElapsed = 0
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
  self.morphState = "toHuman"
  self.morphElapsed = 0
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
-- Player:getTeleportPulse's own glow color — see that function's own
-- comment). Ignored while already teleporting, curling into/out of a
-- ball, or talking to an NPC (same reasoning as enterBallMode's own
-- guard above) — Beam:tryInteract also checks isTeleporting itself
-- before even calling this, but the guard belongs here too since
-- nothing stops some OTHER future caller from reaching this directly.
function Player:startTeleport(origin, destination)
  if self.isTeleporting or self.isDying or self.morphState or state.dialogueActive then return end
  if not destination then return end
  self.isTeleporting = true
  self.teleportState = "out"
  self.teleportTimer = TELEPORT_OUT_TICKS
  self.teleportOrigin = origin
  self.teleportDestination = destination
  self.vel.x, self.vel.y = 0, 0
end

-- Advances the freeze-then-snap sequence above (see Player:getTeleportPulse
-- for the scale/glow blip, which only plays over the "out" half — see
-- that function's own comment on why not both). The actual position
-- swap happens the instant the "out" pause reaches zero: lands at the
-- destination beam's own PLANTED BASE (destination.pos), not its portal
-- tip (Beam:getPortalPosition, Beam.LENGTH further out) — landing at the
-- tip was leaving him outside whatever he's meant to land ON (e.g. well
-- past a small landing planet's own gravity influence entirely), rather
-- than standing on it. Offset outward from that base by his own radius,
-- along the beam's own facing direction, same as standing on any
-- ordinary surface (his CENTER sits radius above the ground, not
-- exactly on it). Then clears onSurface/currentPlanet/touchingWall so
-- gravity/landing re-acquire completely fresh from the new position
-- next frame — exactly the ordinary way every other arrival at a planet
-- already works (falling in from open space), rather than trying to
-- force an instant landing onto whatever happens to be below — and
-- starts the post-arrival invincibility window (Player:isInvincible),
-- same reasoning as the old JS game's own equivalent (see
-- INVINCIBLE_TICKS's own comment). A short "in" pause (just holding him
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

------------------------------------------------------------------
-- Physics / movement
------------------------------------------------------------------

function Player:applyGravity()
  if self.onSurface then return end
  -- Prefer shared GravitySystem (handles SkyDome deck gravity correctly)
  if state.gravitySystem then
    state.gravitySystem:applyTo(self)
    return
  end

  local planet = nil
  if state.gravitySystem and state.gravitySystem.findDominantPlanet then
    planet = state.gravitySystem:findDominantPlanet(self.pos)
  end
  if not planet and self.lastInfluencePlanet then planet = self.lastInfluencePlanet end
  if planet then
    self.lastInfluencePlanet = planet
    local direction
    if planet.isRoundedRect and planet.nearestSurfacePoint then
      local surface = planet:nearestSurfacePoint(self.pos.x, self.pos.y)
      if surface.distance > 1e-6 then
        direction = Vector2.new(surface.point.x - self.pos.x, surface.point.y - self.pos.y):normalize()
      else
        direction = surface.normal:clone():multiply(-1)
      end
    else
      direction = planet.pos:subtract(self.pos):normalize()
    end
    local grav = constants.GRAVITY_STRENGTH
    if self.isGroundPounding then grav = grav * constants.GROUND_POUND_GRAV_MULTIPLIER end
    self.vel:add(direction:multiply(grav))
  end
end

-- "Down" direction used purely for the character rig's visual rotation
-- (drawing and idle-facing orientation) — NOT for physics/gravity, which
-- still follows the real surface normal. forceUprightJump surfaces
-- (TiledTerrain) keep the astronaut standing straight up regardless of
-- which way a 45-degree segment's normal points, the same way Mario
-- doesn't tilt to match a slope's angle. Without this override, the rig
-- would snap between upright and tilted every time the player crossed a
-- short slope segment, which reads as a glitch rather than motion.
function Player:visualDownDirection(planet)
  if not planet then return Vector2.new(0, 1) end
  if planet.isRoundedRect then
    if planet.forceUprightJump then return Vector2.new(0, 1) end
    local surface = planet:nearestSurfacePoint(self.pos.x, self.pos.y)
    return surface.normal:clone():multiply(-1)
  end
  return planet.pos:subtract(self.pos):normalize()
end

function Player:getOutwardLaunchDirection()
  if not self.currentPlanet then return Vector2.new(0, -1) end
  if self.currentPlanet.isRoundedRect then
    local surface = self.currentPlanet:nearestSurfacePoint(self.pos.x, self.pos.y)
    local direction = surface.normal
    -- forceUprightJump (e.g. TiledTerrain's sloped segments) overrides
    -- whatever this surface's own local normal is — a 45-degree slope's
    -- normal points diagonally, but jumping off one should still launch
    -- straight up, same as a flat SkyDome deck already does (there, it's
    -- straight up only because a flat deck's own normal already equals
    -- (0,-1) — this makes the same result explicit for surfaces whose
    -- normal isn't vertical).
    if self.currentPlanet.forceUprightJump then
      direction = Vector2.new(0, -1)
    end
    -- Used to also tilt this direction sideways by a fixed fraction
    -- (jumpHorizontalCarry) whenever a direction key was held — but
    -- that tilt gets multiplied by the FULL jumpStrength once
    -- normalized, and jump()'s own groundMoveSpeedX carry (added
    -- separately, AFTER this direction is turned into a velocity) now
    -- covers the same "carry your speed into the jump" need more
    -- precisely (it actually distinguishes walking from running,
    -- rather than a single fixed lean regardless of speed). The two
    -- stacking together is what made even a plain walking jump launch
    -- at roughly 3x normal walking speed — removed here rather than
    -- retuned, since keeping both around invites this same conflict
    -- again the next time either one gets adjusted.
    return direction
  end
  return self.pos:subtract(self.currentPlanet.pos):normalize()
end

function Player:jump()
  -- Locked out entirely while curling into/out of a ball (self.morphState
  -- — see enterBallMode/exitBallMode/updateBallMorph) OR while talking
  -- to an NPC (state.dialogueActive — see main.lua, computed fresh each
  -- frame from every NPC's own dialogueActive) — a single guard here
  -- covers every input source (keyboard Space, gamepad Cross) that
  -- calls this, rather than needing the same check patched into each
  -- one separately. isTeleporting (Beam.lua) gets the same treatment —
  -- same reasoning, frozen-in-place for a moment rather than mid-action.
  if self.morphState or state.dialogueActive or self.isTeleporting or self.isDying then return end
  if state.vatsActive then return end -- in V.A.T.S. he only picks a target and pulls to it (see main.lua's own V.A.T.S. rules)

  -- Requires actually MOVING at run speed, not just holding the run
  -- button (state.gamepadRunHeld) while standing still — self.groundMoveSpeedX
  -- (set each frame in move(), see its own comment) is 0 whenever no
  -- direction key is held, so holding Square in place no longer gives
  -- the same jump-height boost as an actual running jump.
  local isRunningAndMoving = state.gamepadRunHeld and (self.groundMoveSpeedX or 0) ~= 0
  local jumpBoost = isRunningAndMoving and self.runJumpMultiplier or 1
  if self.onSurface and self.currentPlanet then
    local direction = self:getOutwardLaunchDirection()
    -- Per-planet override (e.g. SkyDomePlanetoid's own stronger
    -- jumpStrength, compensating for its heavier gravityStrength — see
    -- that file's own comment) takes priority over the global default.
    -- Still scaled by jumpBoost — running SHOULD jump higher, not just
    -- farther — but see runJumpMultiplier's own comment for why that
    -- multiplier itself came back down once jumpStrength was raised.
    local jumpStrength = self.currentPlanet.jumpStrength or constants.JUMP_STRENGTH
    self.vel = direction:multiply(jumpStrength * jumpBoost)
    -- Carries current ground speed into the jump (see move()'s own
    -- self.groundMoveSpeedX) — conventional platformer behavior: a
    -- running jump launches you forward as well as up, instead of
    -- discarding all horizontal momentum the instant you leave the
    -- ground. 0 whenever no direction key was held, so a standing jump
    -- is unaffected. Clamped to airControlMaxSpeed (see that field's
    -- own comment) — this is ADDED to whatever vel.x already has, so
    -- without a ceiling here specifically, rapid repeat jumps (bunny-
    -- hopping) could stack this every single time and compound into an
    -- ever-increasing "leapfrog" instead of settling at one running
    -- jump's own natural speed.
    local carriedVelX = self.vel.x + (self.groundMoveSpeedX or 0) * self.jumpMomentumCarryScale
    self.vel.x = math.max(-self.airControlMaxSpeed, math.min(self.airControlMaxSpeed, carriedVelX))
    self.onSurface = false
    self.currentPlanet = nil
    if state.audioManager then state.audioManager:playJump() end
  elseif (not self.onSurface) and self.touchingWall and not self.isBall then
    -- Wall jump: kicks away from whichever wall was touched THIS FRAME
    -- (self.wallContactNormal, set fresh each frame by
    -- CollisionSystem:handlePlayerWallCollisions — never stale, since it's
    -- reset to nil every frame before wall collisions are re-checked).
    -- Mostly-up with a horizontal kick away from the wall, same overall
    -- launch strength as a normal jump so it feels consistent. Clearing
    -- touchingWall afterward means chaining wall jumps requires actually
    -- drifting back into a wall in between — pressing toward the wall you
    -- just left (or the opposite one) and re-touching it — rather than
    -- letting the same single contact be spent over and over in place.
    -- self.lastInfluencePlanet (not currentPlanet — that's already nil
    -- while airborne) is the same "whichever surface actually applies
    -- right now" lookup used elsewhere for airborne gravity/orientation;
    -- using its jumpStrength here matches an ordinary jump's launch
    -- speed on this level instead of always falling back to the plain
    -- global default, which used to leave wall jumps weaker than ground
    -- jumps on any level (like the dome) with a stronger override.
    local jumpStrength = (self.lastInfluencePlanet and self.lastInfluencePlanet.jumpStrength) or constants.JUMP_STRENGTH
    local direction = Vector2.new(self.wallContactNormal.x, -self.wallJumpUpwardRatio):normalize()
    self.vel = direction:multiply(jumpStrength * jumpBoost)

    -- Turn to face away from the wall (the kick direction), matching
    -- whichever way he's actually launching — and lock BOTH that facing
    -- and horizontal input back toward this wall for the same
    -- wallJumpLockFrames window, so the same "just kicked off, don't
    -- immediately reverse" beat applies to how he looks as well as how
    -- he moves. Without also locking facing, updateOrientationAndFacing's
    -- own mouse-aim logic could flip him back around the very next frame
    -- regardless of the movement lock, since it's driven by cursor
    -- position, not input direction.
    local awayDir = self.wallContactNormal.x > 0 and 1 or -1
    self.facingDirection = awayDir
    self.wallJumpLockBlockedDir = -awayDir
    self.wallJumpLockTimer = self.wallJumpLockFrames

    self:spawnWallJumpEffects()

    self.touchingWall = nil
    self.wallContactNormal = nil
    if state.audioManager then state.audioManager:playJump() end
  elseif self.submergedIn then
    -- Swim stroke: an outward-from-center impulse ADDED to (not
    -- replacing) current velocity, so repeated presses build against
    -- the water's own strong drag instead of resetting momentum each
    -- time — reads as paddling rather than a series of identical
    -- little hops. Deliberately no onSurface/touchingWall-style gate
    -- and no cooldown of its own: this can fire on every single press
    -- while submerged, which is what makes it feel like swimming rather
    -- than a single limited jump. Enough consecutive strokes carry the
    -- player back out past the surface entirely — CollisionSystem never
    -- treats a water planet as solid, so crossing back out just resumes
    -- ordinary falling/gravity toward whatever's dominant next.
    local planet = self.submergedIn
    local away = self.pos:subtract(planet.pos)
    local dist = away:length()
    local dir = dist > 1 and away:normalize() or Vector2.new(0, -1)
    self.vel:add(dir:multiply(self.swimStrength))
    self.swimStrokeTimer = self.swimStrokeDuration
    if state.audioManager then state.audioManager:playJump() end
  end
end

-- Jump pressed in mid-air (the input handlers only call this when
-- there's nothing to jump off and nothing to swim in): slam straight
-- down. Works at ANY point in the air — on the way up from a jump, on
-- the way back down, or after simply walking off a ledge.
--
-- It used to only take while he was still moving AWAY from the ground
-- (the first few frames after a jump), which is why it needed a second
-- press almost immediately, and couldn't be done at all from a fall.
--
-- The one requirement left is that something is actually pulling on
-- him: a pound is just heavier gravity (GROUND_POUND_GRAV_MULTIPLIER)
-- until he lands, so out in open space with no planet in range it would
-- do nothing except leave him stuck in the pose.
function Player:tryGroundPound()
  if self.isGroundPounding or self.isDying or self.onSurface then return end
  if state.vatsActive then return end -- in V.A.T.S. he only picks a target and pulls to it (see main.lua's own V.A.T.S. rules)
  -- Not as a ball, or while curling into/out of one — the pound is his
  -- own move, on his feet.
  if self.isBall or self.morphState then return end
  if not state.gravitySystem or not state.gravitySystem:findDominantPlanet(self.pos) then return end
  self.isGroundPounding = true
end

-- Spawns an occasional dust puff at the player's feet while actively
-- walking on a surface — a gentle scatter-and-drift-up, as opposed to
-- spawnWallJumpEffects' bigger outward burst. Called from all three
-- on-surface walking branches in move() (SkyDome/TiledTerrain
-- flat-or-arc walking, and circular-planet walking), since dust should
-- kick up regardless of which underlying walking system currently
-- applies.
function Player:spawnWalkDust()
  if not self.currentPlanet then return end

  -- Ties dust to actual FOOTSTEPS rather than a flat per-frame chance —
  -- the walk-bob (see drawFullBody) is exactly 0 when a leg passes
  -- through vertical and peaks at 1 right when it's most scissored,
  -- about to plant. Detecting the moment it crosses back above a high
  -- threshold catches that "just planted" instant, once per actual
  -- footfall (twice per full walkTime cycle, one per leg).
  local bobT = math.sin(self.walkTime) ^ 2
  local justPlanted = bobT > 0.85 and self.lastWalkBobT <= 0.85
  self.lastWalkBobT = bobT
  if not justPlanted then return end

  -- Same "down" derivation used for the character rig's own visual
  -- orientation (see visualDownDirection) — including its forceUprightJump
  -- override, so on a TiledTerrain slope dust spawns at the astronaut's
  -- actual (always-upright) visual feet, not off to the side along the
  -- slope's true normal.
  local downDir = self:visualDownDirection(self.currentPlanet)
  local feetPos = self.pos:clone():add(downDir:clone():multiply(self.radius * 0.9))
  local sideDir = Vector2.new(-downDir.y, downDir.x) -- perpendicular to "down" — scatters dust sideways along the surface

  -- A small CLUSTER per footstep (2-3 particles, 4-6 while running) —
  -- reads as an actual puff kicking up rather than a trailing spark.
  -- Running already triggers this MORE OFTEN for free too, since
  -- walkTime (and therefore footstep timing) advances by actual distance
  -- covered per frame, which running increases directly — this only adds
  -- the extra per-footstep volume on top of that.
  local running = state.gamepadRunHeld
  local puffCount = (running and 4 or 2) + math.floor(math.random() * (running and 3 or 2))
  DustPuff.spawn(feetPos, downDir, sideDir, puffCount, 2.5, 0.2, 0.6)
end

-- Visual feedback for a wall-jump kick-off: a dust burst (roughly double
-- spawnWalkDust's walking baseline, bursting outward from the wall
-- instead of gently drifting up) plus a small, subtle expanding contact
-- ring (WallContactPulse — same "expanding fading ring" idea
-- Explosion.lua uses, just much smaller/quicker/more subdued, with no
-- core flash or fiery particle burst since the dust already covers that
-- role here). Called from Player:jump's wall-jump branch, BEFORE
-- self.pos/self.wallContactNormal change for the kick, so both land
-- exactly at the contact point.
function Player:spawnWallJumpEffects()
  local normal = self.wallContactNormal
  local sideDir = Vector2.new(-normal.y, normal.x)
  local intoWallDir = normal:clone():multiply(-1)

  local puffCount = 4 + math.floor(math.random() * 3) -- ~double spawnWalkDust's 2-3 walking baseline
  DustPuff.spawn(self.pos, intoWallDir, sideDir, puffCount, 3.5, 0.6, 1.2)

  if state.wallContactPulses then
    local WallContactPulse = require("lua.entities.WallContactPulse")
    table.insert(state.wallContactPulses, WallContactPulse.new(self.pos.x, self.pos.y))
  end
end

function Player:move(keys)
  -- Locked out while curling into/out of a ball (self.morphState — see
  -- enterBallMode/exitBallMode/updateBallMorph) OR while talking to an
  -- NPC (state.dialogueActive — see main.lua): treating `keys` as empty
  -- for the rest of this call means every ArrowLeft/ArrowRight check
  -- below naturally falls through to "no input," so he can't walk
  -- anywhere, while everything else this function still does
  -- (gravity-airborne handling, wall-climb bookkeeping, arc-position
  -- resync, etc.) keeps running exactly as normal rather than being
  -- skipped wholesale. isTeleporting (Beam.lua) gets the same treatment.
  if self.morphState or state.dialogueActive or self.isTeleporting or self.isDying then keys = {} end
  -- Sat on the ground for a beat after a ground pound lands (see
  -- GROUND_POUND_IMPACT_TICKS) — no walking off mid-impact. Jumping is
  -- still allowed, and ends the beat.
  -- (wasGroundPounding covers the one frame between touching down and
  -- Player:update starting that timer.)
  if self.groundPoundImpactTimer > 0 or (self.wasGroundPounding and self.onSurface) then keys = {} end

  if self.onSurface and self.currentPlanet and self.currentPlanet.isRoundedRect then
    local planet = self.currentPlanet
    self.isWalking = false
    local ds = 0
    local rawSpeed = constants.PLAYER_LINEAR_SPEED * (state.gamepadRunHeld and self.runSpeedMultiplier or 1)
      * (self.isBall and BALL_SPEED_MULTIPLIER or 1)
    local speed = rawSpeed * state.timeScale

    -- Unscaled (no state.timeScale) current ground speed+direction —
    -- Player:jump() carries this into the jump's own vel.x, same
    -- convention as every other platformer (a running jump launches you
    -- forward, not just straight up). Kept separate from ds/speed above
    -- specifically because self.vel gets state.timeScale applied again,
    -- on its own, during airborne integration — folding an
    -- already-timeScale'd value in here would double-apply it.
    self.groundMoveSpeedX = 0

    if keys["ArrowLeft"] then ds = -speed; self.facingDirection = -1; self.isWalking = true; self.groundMoveSpeedX = -rawSpeed end
    if keys["ArrowRight"] then ds = speed; self.facingDirection = 1; self.isWalking = true; self.groundMoveSpeedX = rawSpeed end

    if planet.isSkyDome then
      local coreHalfWidth = planet.halfWidth - (planet.cornerRadius or 0)
      local minX = planet.pos.x - coreHalfWidth
      local maxX = planet.pos.x + coreHalfWidth
      local desiredX = self.pos.x + ds

      if desiredX < minX or desiredX > maxX then
        self.onSurface = false
        self.currentPlanet = nil
        self.vel = Vector2.new(ds * self.edgeFallCarryFraction, 0)
      else
        local topY = planet.trueSurfaceY and planet:trueSurfaceY() or (planet.pos.y - planet.halfHeight)
        self.pos = Vector2.new(desiredX, topY - self.radius)
      end
    else
      -- rampLeft's wall sits on the opposite side from rampRight's, so
      -- its arc-length-increasing direction is physically leftward
      -- instead of rightward (see buildRampClimbShape's own comment on
      -- controlsReversed) — flip ds here, once, before anything below
      -- reads it, so "climbing" always lines up with the key that
      -- visually walks the player into the ramp.
      if planet.isWallClimb and planet.controlsReversed then ds = -ds end

      -- Wall-climb shapes (see TiledTerrain.lua's buildRampClimbShape)
      -- detach the player if they STOP or REVERSE direction on the
      -- actual wall face OR the ceiling (isWallFace / isCeiling — see
      -- that file's own comments on each) — Sonic-loop style: nothing
      -- but committed momentum holds you to either, so easing off or
      -- changing your mind peels you off instead of leaving you glued
      -- in place. Not the curve leading into the wall, not the slope
      -- leading out of it, and not an ordinary flat ledge — turning
      -- around or standing still there is perfectly normal footing,
      -- same as any other ramp in the game. (Stopping used to be
      -- allowed on the wall face specifically, to let the player rest
      -- mid-climb — but the wall is just as sheer standing still as it
      -- is moving, so that exception is gone; both zones share the same
      -- rule now.)
      --
      -- self.wallClimbDir resets to nil once off BOTH zones, so entering
      -- either fresh always accepts whichever direction you arrive with
      -- as the baseline — but NOT when crossing from one into the
      -- other, since arc-length direction is one continuous thing
      -- across the whole climb; a commitment made on the wall still
      -- counts once you're over onto the ceiling. It ALSO resets on a
      -- planet swap (self.wallClimbDirPlanet — see that field's own
      -- comment): a fall off the end of one wall-climb shape can land
      -- the player on a DIFFERENT one mid-ceiling, and that shape may
      -- read the same held key with the opposite sign.
      local currentSeg = planet.isWallClimb and planet:segmentAtArcPosition(self.surfaceArcPos) or nil
      local onClimbZone = currentSeg ~= nil and (currentSeg.isWallFace or currentSeg.isCeiling)
      if planet ~= self.wallClimbDirPlanet then
        self.wallClimbDir = nil
        self.wallClimbDirPlanet = planet
      end

      local shouldDetach = false
      if onClimbZone then
        -- Requires the run button (state.gamepadRunHeld — Square on a
        -- PS5 pad), the same flag that already gates the run-speed
        -- multiplier on `speed` above: an ordinary walking pace isn't
        -- committed enough to hold either zone, matching stopping and
        -- reversing as things that peel the player off. Ball mode is
        -- ALWAYS treated as "running" for this specific check — a ball
        -- rolling with enough commitment to not stop or reverse (ds==0/
        -- direction-reversal detachment below still applies exactly the
        -- same either way) can cling to a wall or ceiling without also
        -- needing the run button held down.
        if ds == 0 or not (state.gamepadRunHeld or self.isBall) then
          shouldDetach = true
        else
          local dirSign = ds > 0 and 1 or -1
          if self.wallClimbDir and self.wallClimbDir ~= dirSign then
            shouldDetach = true
          else
            self.wallClimbDir = dirSign
          end
        end
      else
        self.wallClimbDir = nil
      end

      if shouldDetach then
        self.onSurface = false
        self.currentPlanet = nil
        self.vel = currentSeg.normal:multiply(self.wallClimbDetachPush)
      else
        -- Optional per-surface speed scaling (e.g. TiledTerrain slowing
        -- the player down climbing a 45-degree slope, speeding up
        -- descending one) — looked up at the CURRENT arc position,
        -- before stepping, since the segment the player is standing on
        -- right now is what should govern this step's speed. ds itself
        -- (still its pre-multiplied, direction-only value here) tells
        -- the surface which way along the segment this step is heading,
        -- which is what separates uphill from downhill. Duck-typed:
        -- surfaces without this method (every existing one) behave
        -- exactly as before.
        if type(planet.getArcSpeedMultiplier) == "function" then
          ds = ds * planet:getArcSpeedMultiplier(self.surfaceArcPos, ds)
        end

        local desiredArcPos = self.surfaceArcPos + ds

        -- isOpenPath surfaces (e.g. TiledTerrain — a hill has two ends, not
        -- a closed loop like RoundedRectPlanetoid) fall off the end instead
        -- of wrapping around, same "carry momentum into a fall" pattern
        -- SkyDome's own edge-of-deck check above already uses.
        if planet.isOpenPath and (desiredArcPos < 0 or desiredArcPos > planet:getPerimeter()) then
          -- Snap to the exact edge vertex before falling, rather than
          -- leaving self.pos wherever last frame's walk step landed (which
          -- can be up to one whole step short of the true end). Landing
          -- back on this same shape is decided purely by geometry from here
          -- on (CollisionSystem's swept crossing test) — starting exactly
          -- at the edge is what lets that test exclude a re-land on the
          -- very next frame instead of only after several more steps'
          -- worth of horizontal drift.
          local edgeArcPos = desiredArcPos < 0 and 0 or planet:getPerimeter()
          self.pos = planet:worldPointAtArcPosition(edgeArcPos, self.radius).point
          self.onSurface = false
          self.currentPlanet = nil
          -- Carried along the path's ACTUAL tangent at the edge, not
          -- assumed purely horizontal — ds is an arc-length rate, and
          -- "forward along the path" only equals "rightward in world
          -- space" for a shape whose tangent never really turns (an
          -- ordinary hill). A wall-climb shape's ceiling stretch runs
          -- backwards in world-x relative to its own ground/wall
          -- portions (same ds sign throughout, opposite dx) — carrying
          -- with plain (ds, 0) sent the player skidding back the way
          -- they came instead of on through, missing the neighboring
          -- shape they were supposed to fall onto and catch.
          local edgeSeg = planet.segmentAtArcPosition and planet:segmentAtArcPosition(edgeArcPos)
          local carryDir = edgeSeg and edgeSeg.tangent or Vector2.new(1, 0)
          self.vel = carryDir:multiply(ds * self.edgeFallCarryFraction)
        else
          self.surfaceArcPos = desiredArcPos
          local worldSurface = planet:worldPointAtArcPosition(self.surfaceArcPos, self.radius)
          self.pos = worldSurface.point
        end
      end
    end

    if self.isWalking then
      self.walkTime = self.walkTime + (math.abs(ds) / self.strideLength) * math.pi * 2
      self:spawnWalkDust()
      -- Rolling-without-slipping: a wheel of radius r moving a signed
      -- distance ds rotates by exactly ds/r radians — ds is already the
      -- true signed world-unit displacement attempted this frame, so
      -- this is the physically correct spin rate, not just a stylized
      -- approximation. Wrapped via math.fmod every frame (same
      -- precaution Sun.lua's own unbounded-time bug taught — see that
      -- file's PLASMA_TIME_WRAP) so this angle never grows large enough
      -- to lose precision over a long play session.
      if self.isBall then
        self.ballRollAngle = math.fmod(self.ballRollAngle + ds / self.radius, math.pi * 2)
      end
    end

  elseif self.onSurface and self.currentPlanet then
    local surfaceDist = self.currentPlanet.radius + self.radius
    -- Walking the hard core at the bottom of a water planet (see
    -- WaterPlanet.lua) is still walking underwater — self.submergedIn
    -- stays true even once landed there (it's a plain distance-to-the-
    -- water-body's-own-center check, unrelated to onSurface/currentPlanet),
    -- so the same water resistance that slows swimming above also
    -- slows walking down here.
    local speedMul = (state.gamepadRunHeld and self.runSpeedMultiplier or 1) * (self.submergedIn and self.waterWalkSpeedMultiplier or 1)
      * (self.isBall and BALL_SPEED_MULTIPLIER or 1)
    local speed = constants.PLAYER_LINEAR_SPEED * speedMul * state.timeScale
    local angularSpeed = speed / surfaceDist

    self.isWalking = false
    local prevAngle = self.angle

    if keys["ArrowLeft"] then
      self.angle = self.angle - angularSpeed
      self.facingDirection = -1
      self.isWalking = true
    end
    if keys["ArrowRight"] then
      self.angle = self.angle + angularSpeed
      self.facingDirection = 1
      self.isWalking = true
    end
    self.pos.x = self.currentPlanet.pos.x + math.cos(self.angle) * surfaceDist
    self.pos.y = self.currentPlanet.pos.y + math.sin(self.angle) * surfaceDist

    if self.isWalking then
      local signedDistanceMoved = (self.angle - prevAngle) * surfaceDist
      self.walkTime = self.walkTime + (math.abs(signedDistanceMoved) / self.strideLength) * math.pi * 2
      self:spawnWalkDust()
      if self.isBall then
        self.ballRollAngle = math.fmod(self.ballRollAngle + signedDistanceMoved / self.radius, math.pi * 2)
      end
    end

  elseif (not self.onSurface) and self.lastInfluencePlanet
      and (self.lastInfluencePlanet.isSkyDome or self.lastInfluencePlanet.forceUprightJump or self.submergedIn) then
    -- Ordinary circular planets deliberately don't get this fixed
    -- screen-space left/right air control at all — "sideways" isn't a
    -- well-defined direction on a sphere you could be approaching from
    -- any angle. SkyDome / forceUprightJump surfaces are the exception,
    -- reading fine with a plain fixed left/right.
    local lockedDir = self.wallJumpLockTimer > 0 and self.wallJumpLockBlockedDir or nil

    if self.submergedIn then
      -- Orbits around the water body's own center instead of a fixed
      -- screen-space direction — same idea Player:move's own
      -- onSurface-on-a-round-planet branch above already uses for
      -- walking the seabed (ArrowRight always increases self.angle,
      -- i.e. always the SAME rotational sense regardless of where on
      -- the circle you currently are), just applied as a velocity nudge
      -- along the current TANGENT instead of directly setting position,
      -- since swimming is still physics-driven (gravity + drag), unlike
      -- walking's fixed-radius arc.
      --
      -- Deliberately decomposes vel into tangential + radial components
      -- and only ever touches the tangential one here — getting FARTHER
      -- from the water's center is NOT something ArrowLeft/ArrowRight
      -- can do at all, on purpose (an earlier version nudged vel.x in a
      -- fixed screen-space direction instead, which could carry a
      -- player near the water's own left/right side straight out past
      -- the shore). The radial component — gravity pulling in, and
      -- Player:jump's own swim-stroke impulse pushing straight out — is
      -- preserved untouched, so that stays the only way to actually
      -- move toward or away from the center.
      local water = self.submergedIn
      local radial = self.pos:subtract(water.pos)
      if radial:length() > 0.01 then
        radial:normalize()
      else
        radial = Vector2.new(0, -1)
      end
      local tangent = Vector2.new(-radial.y, radial.x)

      local tangentSpeed = self.vel:dot(tangent)
      local radialSpeed = self.vel:dot(radial)

      -- Same accel-toward-a-cap-without-fighting-existing-momentum
      -- shape the screen-space version below uses, just applied to the
      -- tangential speed instead of vel.x directly.
      -- Scaled by state.timeScale like every other per-frame rate (see
      -- the airborne branch below for why that matters).
      local swimAccel = self.airControlAccel * state.timeScale
      if keys["ArrowLeft"] and lockedDir ~= -1 then
        tangentSpeed = math.min(tangentSpeed, math.max(tangentSpeed - swimAccel, -self.airControlMaxSpeed))
        self.facingDirection = -1
      end
      if keys["ArrowRight"] and lockedDir ~= 1 then
        tangentSpeed = math.max(tangentSpeed, math.min(tangentSpeed + swimAccel, self.airControlMaxSpeed))
        self.facingDirection = 1
      end

      self.vel = tangent:multiply(tangentSpeed):add(radial:multiply(radialSpeed))
    else
      -- Nudges vel.x toward (and up to) airControlMaxSpeed in the held
      -- direction — but never REDUCES it if momentum carried from a
      -- running jump (see jump()'s own groundMoveSpeedX carry) already
      -- exceeds that cap. The plain math.max/math.min clamp used to snap
      -- straight down to airControlMaxSpeed the instant this ran with a
      -- faster vel.x already in flight — which happens on essentially
      -- every running jump, since the same direction key held to run is
      -- still held going into the jump — reading as sudden air friction
      -- killing the jump's own distance. The outer math.min/math.max
      -- keeps the accelerated value only when it doesn't walk speed back
      -- DOWN toward the cap from above.
      --
      -- The cap itself follows the run button, same as ground speed
      -- does: walking speed without it, running speed with it. It used
      -- to be running speed (airControlMaxSpeed) unconditionally, so
      -- just holding a direction through a WALKING jump accelerated him
      -- to nearly double his own walking speed in mid-air. Because of
      -- the never-reduces rule above, letting go of run partway through
      -- a running jump keeps the speed he already has rather than
      -- braking him.
      --
      -- The acceleration is scaled by state.timeScale like every other
      -- per-frame rate — unscaled, it was applied once per rendered
      -- frame, so air control got stronger the higher the frame rate.
      local airMaxSpeed = constants.PLAYER_LINEAR_SPEED * (state.gamepadRunHeld and self.runSpeedMultiplier or 1)
      local airAccel = self.airControlAccel * state.timeScale
      if keys["ArrowLeft"] and lockedDir ~= -1 then
        self.vel.x = math.min(self.vel.x, math.max(self.vel.x - airAccel, -airMaxSpeed))
        self.facingDirection = -1
      end
      if keys["ArrowRight"] and lockedDir ~= 1 then
        self.vel.x = math.max(self.vel.x, math.min(self.vel.x + airAccel, airMaxSpeed))
        self.facingDirection = 1
      end
    end
  end
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
    local targetR = water.radius
    if spawnR < targetR then
      table.insert(self.bubbles, newBubble(water.pos.x, water.pos.y, angle, spawnR, targetR))
    end
  end

  for i = #self.bubbles, 1, -1 do
    local b = self.bubbles[i]
    b.r = b.r + b.riseSpeed * timeScale
    b.wobblePhase = b.wobblePhase + b.wobbleFreq * timeScale
    if b.r >= b.targetR then
      table.remove(self.bubbles, i)
    end
  end
end

-- Drawn separately from the rest of the player (see main.lua's own call
-- site, right after the water planet's second draw pass) so bubbles
-- stay visible on top of the translucent water fill instead of getting
-- muddied underneath it — matches how the water planet's own now-removed
-- ambient bubbles used to layer.
function Player:drawBubbles()
  for _, b in ipairs(self.bubbles or {}) do
    local angle = b.baseAngle + math.sin(b.wobblePhase) * BUBBLE_WOBBLE_AMPLITUDE
    local bx = b.centerX + math.cos(angle) * b.r
    local by = b.centerY + math.sin(angle) * b.r

    local fadeStart = b.targetR - BUBBLE_FADE_DISTANCE
    local fade = 1
    if b.r > fadeStart then
      fade = 1 - (b.r - fadeStart) / BUBBLE_FADE_DISTANCE
    end

    love.graphics.setColor(BUBBLE_COLOR[1], BUBBLE_COLOR[2], BUBBLE_COLOR[3], 0.5 * fade)
    love.graphics.circle("fill", bx, by, b.radius)
    love.graphics.setColor(1, 1, 1, 0.75 * fade)
    love.graphics.circle("line", bx, by, b.radius)
  end
  love.graphics.setColor(1, 1, 1, 1)
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

  if not self.onSurface then
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
    local dragFactor = self.submergedIn and self.waterDrag or constants.DRAG
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

------------------------------------------------------------------
-- Aim helpers
------------------------------------------------------------------

function Player:worldAngleToLocalRotation(desiredWorldAngle, orientation, dirSign)
  if dirSign > 0 then
    return desiredWorldAngle - orientation
  end
  return (orientation + math.pi) - desiredWorldAngle
end

function Player:computeLeftArmAimAngle(orientation, dirSign, originPos)
  local cfg = self.bodyPartsConfig
  local s = self.bodyScale
  local cosO = math.cos(orientation)
  local sinO = math.sin(orientation)

  local offsetX = cfg.leftArmX * dirSign
  local offsetY = cfg.leftArmY
  local wx = offsetX * cosO - offsetY * sinO
  local wy = offsetX * sinO + offsetY * cosO
  local shoulderX = originPos.x + wx * s
  local shoulderY = originPos.y + wy * s

  local forwardAngle = dirSign > 0 and orientation or (orientation + math.pi)

  -- Re-checked every frame — the moment a lock stops being valid
  -- (destroyed, scrolled out of the viewport, or landed on), it's
  -- cleared here and this frame just falls through to the normal aim
  -- priority chain below instead, rather than needing a separate
  -- per-frame watcher elsewhere.
  if self.lockedTarget and not TargetLock.isValidLockTarget(self.lockedTarget) then
    self.lockedTarget = nil
  end

  -- With a gamepad as the active input device and the right stick
  -- resting in its deadzone, there's no meaningful aim target to fall
  -- back to — the "else" mouse branch below would use state.mouse,
  -- which for a controller-only player still sits at its startup value
  -- (screen center, see InputHandlers.lua) and, since the camera keeps
  -- the player centered on screen too, lands almost exactly on top of
  -- shoulderX/Y. That degenerate near-zero vector's atan2 angle is
  -- essentially floating-point noise — observed as the blaster settling
  -- on an arbitrary direction (e.g. straight up) instead of forward.
  -- Aiming straight down forwardAngle here (relative = 0 after the
  -- atan2 below) matches the plain "shoot ahead of me" expectation
  -- instead.
  local aimStraightAhead = not self.lockedTarget and not self.pullTarget
    and not state.gamepadAimActive and state.gamepadIsActiveDevice

  local targetWorldX, targetWorldY
  if aimStraightAhead then
    targetWorldX = shoulderX + math.cos(forwardAngle) * 1000
    targetWorldY = shoulderY + math.sin(forwardAngle) * 1000
  elseif self.lockedTarget then
    -- lockAimLeadX/Y: an optional offset from the target's own center
    -- to aim at instead — nil in ordinary play. The title screen's
    -- autopilot sets it to lead a moving asteroid, since a fireball
    -- takes time to arrive (see TitleScreen.lua).
    targetWorldX = self.lockedTarget.pos.x + (self.lockAimLeadX or 0)
    targetWorldY = self.lockedTarget.pos.y + (self.lockAimLeadY or 0)
  elseif self.pullTarget then
    targetWorldX, targetWorldY = self:getPullAnchor(self.pullTarget)
  elseif state.gamepadAimActive then
    targetWorldX = shoulderX + (state.gamepadAimX or 0) * 1000
    targetWorldY = shoulderY + (state.gamepadAimY or 0) * 1000
  else
    local cam = state.camera or { x = 0, y = 0 }
    local zoom = state.zoom or 1
    local mouse = state.mouse or { x = shoulderX, y = shoulderY }
    targetWorldX = mouse.x / zoom + cam.x
    targetWorldY = mouse.y / zoom + cam.y
  end

  local targetAngle = math.atan2(targetWorldY - shoulderY, targetWorldX - shoulderX)
  local relative = math.atan2(
    math.sin(targetAngle - forwardAngle),
    math.cos(targetAngle - forwardAngle)
  )

  if not self.lockedTarget then
    relative = math.max(-self.maxAimFromForward, math.min(self.maxAimFromForward, relative))
  end

  local clampedTargetAngle = forwardAngle + relative
  self.aimShoulderPos = Vector2.new(shoulderX, shoulderY)
  self.aimWorldAngle = clampedTargetAngle
  self.aimRelativeAngle = relative
  self.aimAnchorPos = self.pos:clone()

  return self:worldAngleToLocalRotation(clampedTargetAngle, orientation, dirSign)
end

function Player:computeHeadLookTilt(orientation, dirSign)
  local forwardAngle = dirSign > 0 and orientation or (orientation + math.pi)
  local desiredWorldAngle = forwardAngle + self.headLookScale * (self.aimRelativeAngle or 0)
  return self:worldAngleToLocalRotation(desiredWorldAngle, orientation, dirSign)
end

------------------------------------------------------------------
-- Drawing
------------------------------------------------------------------

function Player:drawLimb(img, offsetX, offsetY, jointX, jointY, angle, orientation, originPos, cosO, sinO, flipHorizontal)
  if not img then return end
  local s = self.bodyScale

  local wx = offsetX * cosO - offsetY * sinO
  local wy = offsetX * sinO + offsetY * cosO

  love.graphics.push()
  love.graphics.translate(originPos.x + wx * s, originPos.y + wy * s)
  love.graphics.rotate(orientation + angle)
  if flipHorizontal then
    love.graphics.scale(-1, 1)
  end
  love.graphics.draw(img, -jointX * s, -jointY * s, 0, s, s)
  love.graphics.pop()
end

-- Wall-slide pose, authored with paperdoll.html against the actual
-- bodyPartsConfig/drawLimb numbers, so these plug in directly with no
-- unit conversion. Authored facing RIGHT with the wall on the left —
-- i.e. facing AWAY from the wall, back braced against it — which is
-- exactly what Player:update() now forces facingDirection to do for the
-- whole slide, not just the kick-off, so this needs no extra mirroring.
-- jointX/jointY are omitted here (unchanged from bodyPartsConfig — the
-- pose only moves/rotates parts, it doesn't relocate their pivots).
local WALL_SLIDE_POSE = {
  leftBootX = 41.64,    leftBootY = 313.37, leftBootAngle = 34 * math.pi / 180,
  leftArmAngle = 49 * math.pi / 180,
  rightBootX = -138.98, rightBootY = 204.81, rightBootAngle = 0,
  rightArmAngle = 166 * math.pi / 180,
  headY = -125.87, headAngle = 13 * math.pi / 180,
}

-- A fixed pose — no walk-bob, no aim-follow, no airborne-raised-arm
-- logic, unlike drawFullBody's normal branch. Also its own z-order: the
-- right arm (reaching back across/over the head in this pose) is drawn
-- AFTER the head instead of before, per how it was authored.
function Player:drawWallSlidePose(orientation, originPos)
  local images = state.characterImages
  if not images then return end

  local cfg = self.bodyPartsConfig
  local pose = WALL_SLIDE_POSE
  local s = self.bodyScale
  local cosO = math.cos(orientation)
  local sinO = math.sin(orientation)

  self:drawLimb(images.leftboot, pose.leftBootX, pose.leftBootY, cfg.leftBootJointX, cfg.leftBootJointY, pose.leftBootAngle, orientation, originPos, cosO, sinO)
  self:drawLimb(images.leftarm, cfg.leftArmX, cfg.leftArmY, cfg.leftArmJointX, cfg.leftArmJointY, pose.leftArmAngle, orientation, originPos, cosO, sinO)

  if images.body then
    local bodyW, bodyH = images.body:getDimensions()
    love.graphics.push()
    love.graphics.translate(originPos.x, originPos.y)
    love.graphics.rotate(orientation)
    love.graphics.draw(images.body, -bodyW * s / 2, cfg.bodyY * s - bodyH * s / 2, 0, s, s)
    love.graphics.pop()
  end

  self:drawLimb(images.rightboot, pose.rightBootX, pose.rightBootY, cfg.rightBootJointX, cfg.rightBootJointY, pose.rightBootAngle, orientation, originPos, cosO, sinO)

  if images.head then
    local headW, headH = images.head:getDimensions()
    local headWX = -pose.headY * sinO
    local headWY = pose.headY * cosO
    local pivotY = headH * s * self.headPivotFraction
    love.graphics.push()
    love.graphics.translate(originPos.x + headWX * s, originPos.y + headWY * s)
    love.graphics.rotate(orientation + pose.headAngle)
    love.graphics.draw(images.head, -headW * s / 2, -pivotY, 0, s, s)
    love.graphics.pop()
  end

  self:drawLimb(images.rightarm, cfg.rightArmX, cfg.rightArmY, cfg.rightArmJointX, cfg.rightArmJointY, pose.rightArmAngle, orientation, originPos, cosO, sinO)
end

------------------------------------------------------------------
-- Ball-morph transition poses
------------------------------------------------------------------

-- Neutral standing pose — angle=0 everywhere, same attach offsets
-- bodyPartsConfig itself already uses. This is what the curl-in
-- animation blends FROM (and the stand-back-up animation blends BACK
-- TO) — a fixed authored frame, not whatever dynamic walk/aim/idle pose
-- happened to be playing the instant the transition began, same
-- "just cut to a fixed pose" convention WALL_SLIDE_POSE above already
-- uses rather than blending from arbitrary live state.
local BALL_MORPH_STANDING_POSE = {
  leftBootX = 111,   leftBootY = 241, leftBootAngle = 0,
  leftArmX  = 136,   leftArmY  = 9,   leftArmAngle  = 0,
  bodyY = 115,
  rightBootX = -142, rightBootY = 241, rightBootAngle = 0,
  rightArmX  = -186, rightArmY  = -14, rightArmAngle  = 0,
  headY = -150, headAngle = 0,
}

-- Curl-in keyframes, authored with paperdoll.html against the actual
-- bodyPartsConfig/drawLimb numbers, so these plug in directly with no
-- unit conversion — same precedent as WALL_SLIDE_POSE above, just with
-- explicit X offsets too (unlike that pose, arms/boots actually move
-- sideways here, not just rotate). Played STANDING -> FRAME_1 -> FRAME_2
-- -> (cut to the actual ball) when curling in, and the reverse when
-- standing back up — see Player:drawBallMorphTransition.
local BALL_MORPH_FRAME_1 = {
  leftBootX = 111,     leftBootY = 241,    leftBootAngle = 0,
  leftArmX  = 143.01,  leftArmY  = 131.67, leftArmAngle  = 40 * math.pi / 180,
  bodyY = 206.13,
  rightBootX = -142,   rightBootY = 241,   rightBootAngle = 0,
  rightArmX  = -182.5, rightArmY  = 98.16, rightArmAngle  = -31 * math.pi / 180,
  headY = 18.24, headAngle = 0,
}
local BALL_MORPH_FRAME_2 = {
  leftBootX = 111,      leftBootY = 195.44, leftBootAngle = 32 * math.pi / 180,
  leftArmX  = -130.37,  leftArmY  = 163.22, leftArmAngle  = 40 * math.pi / 180,
  bodyY = 328.8,
  rightBootX = -134.99, rightBootY = 167.4,  rightBootAngle = -9 * math.pi / 180,
  rightArmX  = -143.95, rightArmY  = 213.82, rightArmAngle  = -43 * math.pi / 180,
  headY = 312.65, headAngle = 25 * math.pi / 180,
}

-- Ground-pound pose (Player:tryGroundPound / self.isGroundPounding),
-- authored with paperdoll.html the same way as the poses above: both
-- boots swung up and forward, blaster arm tucked slightly back, right
-- arm thrown up overhead. Only the angles differ from the standing
-- pose — every part sits at its ordinary attach point — and it's in
-- the same table shape as the ball-morph frames, so it's drawn by the
-- same drawBallMorphPose (whose draw order — leftboot, leftarm, body,
-- rightboot, rightarm, head — is exactly the order this was authored
-- in). A fixed pose, cut to directly, same as WALL_SLIDE_POSE.
local GROUND_POUND_POSE = {
  leftBootX = 111,   leftBootY = 241, leftBootAngle = -100 * math.pi / 180,
  leftArmX  = 136,   leftArmY  = 9,   leftArmAngle  = -20 * math.pi / 180,
  bodyY = 115,
  rightBootX = -142, rightBootY = 241, rightBootAngle = -109 * math.pi / 180,
  rightArmX  = -186, rightArmY  = -14, rightArmAngle  = 117 * math.pi / 180,
  headY = -150, headAngle = 0,
}


-- How far (world units) the ground-pound pose has to be drawn below his
-- standing position for the lowest part of it to sit exactly on the
-- ground his feet would otherwise be standing on. Worked out from the
-- pose itself — the bottom of the body, and each boot's image turned to
-- its own angle about its own joint, whichever reaches lowest — against
-- where the soles of his feet are when standing. Cached; none of it
-- changes.
local groundPoundSeatDrop = nil
function Player:getGroundPoundSeatDrop()
  if groundPoundSeatDrop then return groundPoundSeatDrop end
  local images = state.characterImages
  if not images or not images.body then return 0 end

  local cfg, pose = self.bodyPartsConfig, GROUND_POUND_POSE
  local _, bodyH = images.body:getDimensions()
  local lowest = pose.bodyY + bodyH / 2

  local function lowestOfBoot(img, attachY, jointX, jointY, angle)
    if not img then return -math.huge end
    local w, h = img:getDimensions()
    local sinA, cosA = math.sin(angle), math.cos(angle)
    local best = -math.huge
    for _, corner in ipairs({ { 0, 0 }, { w, 0 }, { 0, h }, { w, h } }) do
      best = math.max(best, attachY + (corner[1] - jointX) * sinA + (corner[2] - jointY) * cosA)
    end
    return best
  end
  lowest = math.max(lowest,
    lowestOfBoot(images.leftboot, pose.leftBootY, cfg.leftBootJointX, cfg.leftBootJointY, pose.leftBootAngle),
    lowestOfBoot(images.rightboot, pose.rightBootY, cfg.rightBootJointX, cfg.rightBootJointY, pose.rightBootAngle))

  -- All in the rig's own unscaled units until the last step: the soles
  -- of his feet are his collision radius below self.pos, and the rig's
  -- origin is groundOffset above it.
  local solesY = self.groundOffset + self.baseRadius / self.bodyScale
  groundPoundSeatDrop = (solesY - lowest) * self.bodyScale + GROUND_POUND_SEAT_ADJUST
  return groundPoundSeatDrop
end

local function lerpNum(a, b, t) return a + (b - a) * t end

-- Blends every field of two ball-morph pose tables — plain linear
-- interpolation is enough for a transition this quick (~0.27s total).
local function lerpBallMorphPose(a, b, t)
  return {
    leftBootX = lerpNum(a.leftBootX, b.leftBootX, t),
    leftBootY = lerpNum(a.leftBootY, b.leftBootY, t),
    leftBootAngle = lerpNum(a.leftBootAngle, b.leftBootAngle, t),
    leftArmX = lerpNum(a.leftArmX, b.leftArmX, t),
    leftArmY = lerpNum(a.leftArmY, b.leftArmY, t),
    leftArmAngle = lerpNum(a.leftArmAngle, b.leftArmAngle, t),
    bodyY = lerpNum(a.bodyY, b.bodyY, t),
    rightBootX = lerpNum(a.rightBootX, b.rightBootX, t),
    rightBootY = lerpNum(a.rightBootY, b.rightBootY, t),
    rightBootAngle = lerpNum(a.rightBootAngle, b.rightBootAngle, t),
    rightArmX = lerpNum(a.rightArmX, b.rightArmX, t),
    rightArmY = lerpNum(a.rightArmY, b.rightArmY, t),
    rightArmAngle = lerpNum(a.rightArmAngle, b.rightArmAngle, t),
    headY = lerpNum(a.headY, b.headY, t),
    headAngle = lerpNum(a.headAngle, b.headAngle, t),
  }
end

-- Draws one blended ball-morph pose — same draw-order/structure as
-- drawWallSlidePose above (leftboot, leftarm, body, rightboot, rightarm,
-- head), except every part's own X/Y/angle comes straight from `pose`
-- instead of bodyPartsConfig, since these poses move parts sideways too,
-- not just rotate them. jointX/jointY still come from cfg — those are
-- an intrinsic property of the source art (which pixel is the pivot),
-- not something a pose changes.
function Player:drawBallMorphPose(orientation, originPos, pose)
  local images = state.characterImages
  if not images then return end

  local cfg = self.bodyPartsConfig
  local s = self.bodyScale
  local cosO = math.cos(orientation)
  local sinO = math.sin(orientation)

  self:drawLimb(images.leftboot, pose.leftBootX, pose.leftBootY, cfg.leftBootJointX, cfg.leftBootJointY, pose.leftBootAngle, orientation, originPos, cosO, sinO)
  self:drawLimb(images.leftarm, pose.leftArmX, pose.leftArmY, cfg.leftArmJointX, cfg.leftArmJointY, pose.leftArmAngle, orientation, originPos, cosO, sinO)

  if images.body then
    local bodyW, bodyH = images.body:getDimensions()
    love.graphics.push()
    love.graphics.translate(originPos.x, originPos.y)
    love.graphics.rotate(orientation)
    love.graphics.draw(images.body, -bodyW * s / 2, pose.bodyY * s - bodyH * s / 2, 0, s, s)
    love.graphics.pop()
  end

  self:drawLimb(images.rightboot, pose.rightBootX, pose.rightBootY, cfg.rightBootJointX, cfg.rightBootJointY, pose.rightBootAngle, orientation, originPos, cosO, sinO)
  self:drawLimb(images.rightarm, pose.rightArmX, pose.rightArmY, cfg.rightArmJointX, cfg.rightArmJointY, pose.rightArmAngle, orientation, originPos, cosO, sinO)

  if images.head then
    local headW, headH = images.head:getDimensions()
    local headWX = -pose.headY * sinO
    local headWY = pose.headY * cosO
    local pivotY = headH * s * self.headPivotFraction
    love.graphics.push()
    love.graphics.translate(originPos.x + headWX * s, originPos.y + headWY * s)
    love.graphics.rotate(orientation + pose.headAngle)
    love.graphics.draw(images.head, -headW * s / 2, -pivotY, 0, s, s)
    love.graphics.pop()
  end
end

-- Picks and blends the right pair of keyframes for whichever direction
-- (self.morphState) and how far into it (self.morphElapsed) the
-- transition currently is, then draws that pose with the same
-- facing-direction flip wrapper Player:draw() itself uses.
function Player:drawBallMorphTransition(orientation)
  local planet = self.onSurface and self.currentPlanet or self.lastInfluencePlanet
  local outwardDir = self:visualDownDirection(planet):multiply(-1)
  local visualPos = self.pos:clone():add(outwardDir:multiply(self.groundOffset * self.bodyScale))
  local dirSign = self.facingDirection < 0 and -1 or 1

  local segT = math.min(1, self.morphElapsed / BALL_MORPH_SEGMENT_TICKS)
  local pose
  if self.morphState == "toBall" then
    if self.morphElapsed < BALL_MORPH_SEGMENT_TICKS then
      pose = lerpBallMorphPose(BALL_MORPH_STANDING_POSE, BALL_MORPH_FRAME_1, segT)
    else
      local t2 = math.min(1, (self.morphElapsed - BALL_MORPH_SEGMENT_TICKS) / BALL_MORPH_SEGMENT_TICKS)
      pose = lerpBallMorphPose(BALL_MORPH_FRAME_1, BALL_MORPH_FRAME_2, t2)
    end
  else -- "toHuman" — same two keyframes, played in reverse
    if self.morphElapsed < BALL_MORPH_SEGMENT_TICKS then
      pose = lerpBallMorphPose(BALL_MORPH_FRAME_2, BALL_MORPH_FRAME_1, segT)
    else
      local t2 = math.min(1, (self.morphElapsed - BALL_MORPH_SEGMENT_TICKS) / BALL_MORPH_SEGMENT_TICKS)
      pose = lerpBallMorphPose(BALL_MORPH_FRAME_1, BALL_MORPH_STANDING_POSE, t2)
    end
  end

  love.graphics.push()
  love.graphics.translate(self.pos.x, self.pos.y)
  love.graphics.rotate(orientation)
  love.graphics.scale(dirSign, 1)
  love.graphics.rotate(-orientation)
  love.graphics.translate(-self.pos.x, -self.pos.y)

  self:drawBallMorphPose(orientation, visualPos, pose)

  love.graphics.pop()
end

function Player:drawFullBody(orientation, originPos)
  local images = state.characterImages
  if not images then return end

  if self.isWallSliding then
    self:drawWallSlidePose(orientation, originPos)
    return
  end

  -- Mid ground pound: its own fixed pose (see GROUND_POUND_POSE) from
  -- the moment it starts until he lands. The onSurface check is only a
  -- guard — landing already clears isGroundPounding — so a pound can
  -- never leave him stuck in this pose standing on the ground.
  --
  -- Also held through the impact beat after landing (and through the
  -- single frame between touching down and Player:update noticing —
  -- wasGroundPounding), so he's seen to actually HIT the ground in it.
  --
  -- And drawn lower than his standing self by getGroundPoundSeatDrop:
  -- his collision circle still stops where his feet would be, but in
  -- this pose his feet are up in front of him — without the drop he'd
  -- land with his backside hovering well above the ground. Eased in
  -- over the first GROUND_POUND_SETTLE_TICKS of the pound so he sinks
  -- into the pose rather than jumping down the screen.
  local poundAirborne = self.isGroundPounding and not self.onSurface
  local poundLanded = self.onSurface and (self.groundPoundImpactTimer > 0 or self.wasGroundPounding)
  if poundAirborne or poundLanded then
    local settle = poundLanded and 1 or math.min(1, self.groundPoundPoseTime / GROUND_POUND_SETTLE_TICKS)
    local drop = self:getGroundPoundSeatDrop() * settle
    local downAngle = orientation + math.pi / 2
    local seatedOrigin = Vector2.new(originPos.x + math.cos(downAngle) * drop, originPos.y + math.sin(downAngle) * drop)
    self:drawBallMorphPose(orientation, seatedOrigin, GROUND_POUND_POSE)
    return
  end

  local cfg = self.bodyPartsConfig
  local s = self.bodyScale
  local cosO = math.cos(orientation)
  local sinO = math.sin(orientation)

  local walkAngle = (self.onSurface and self.isWalking) and (math.sin(self.walkTime) * 0.6) or 0
  local walkBobT = (self.onSurface and self.isWalking) and (math.sin(self.walkTime) ^ 2) or 0
  local walkBobAmount = walkBobT * self.walkBobStrength
  originPos = Vector2.new(
    originPos.x + -sinO * walkBobAmount,
    originPos.y + cosO * walkBobAmount
  )

  local dirSign = self.facingDirection < 0 and -1 or 1

  local leftBootAngle = walkAngle
  local rightBootAngle = -walkAngle
  local leftArmAngle, rightArmAngle
  local rightArmFlipped = false

  -- Held rigidly at attention (both arms straight down, no aim/sway/
  -- head-tilt) while standing behind the shelter's still-closed/opening
  -- door (see main.lua's state.introLocked and SpaceShelter.lua's own
  -- intro state machine) — the blaster arm's own aim pose is wide
  -- enough to poke out past the door's clipped frame otherwise (see
  -- SpaceShelter.lua's drawDoor). poseBlend (1 = fully forced, 0 =
  -- fully normal) eases this back to the normal pose over
  -- INTRO_POSE_TRANSITION_SECONDS starting the moment the door reaches
  -- fully open (self.introPoseBlendStart, set in update()'s own
  -- playerInFront edge detection) — NOT once the whole intro finishes
  -- closing back up; he's already drawn in front of the door by then,
  -- so there's nothing left for the rigid pose to protect against.
  local poseBlend = 0
  if state.titleScreen then
    -- Out in the belt on autopilot (see TitleScreen.lua), nowhere near
    -- the door this pose exists for — ordinary pose throughout.
    poseBlend = 0
  elseif state.spaceShelter and not state.spaceShelter.playerInFront then
    poseBlend = 1
  elseif self.introPoseBlendStart then
    local elapsed = love.timer.getTime() - self.introPoseBlendStart
    poseBlend = math.max(0, 1 - elapsed / INTRO_POSE_TRANSITION_SECONDS)
  end

  local aimAngle = self:computeLeftArmAimAngle(orientation, dirSign, originPos)
  if self.mouseIdle and not self.pullTarget then
    local swayAngle = (self.onSurface and self.isWalking)
      and (walkAngle * self.armSwingScale)
      or (math.sin(love.timer.getTime() * 1.5) * 0.15)
    leftArmAngle = swayAngle
    rightArmAngle = swayAngle
  else
    leftArmAngle = aimAngle
    rightArmAngle = walkAngle * self.armSwingScale
  end

  if poseBlend > 0 then
    -- The right arm's own rest art already hangs down naturally at 0
    -- local rotation — but the left (blaster) arm's local 0 points it
    -- straight out in front (that's its AIMING rest, not an idle one:
    -- world-angle 0 == "forwardAngle" is what computeLeftArmAimAngle's
    -- own 0-relative aim means). Rotating it to world-angle pi/2
    -- (straight down, same "down" atan2 gives for a downDir of (0,1))
    -- brings it down to its side to match, via the same world-to-local
    -- conversion every other world-angle-driven pose here already uses.
    -- Nudged 5 degrees further counterclockwise from dead-straight-down
    -- (world angle increases clockwise in this atan2/y-down convention,
    -- so counterclockwise means subtracting) — a small stylistic tweak,
    -- not a correctness fix.
    local blasterRestWorldAngle = math.pi / 2 - (5 * math.pi / 180)
    local forcedLeftArmAngle = self:worldAngleToLocalRotation(blasterRestWorldAngle, orientation, dirSign)
    leftArmAngle = leftArmAngle + (forcedLeftArmAngle - leftArmAngle) * poseBlend
    rightArmAngle = rightArmAngle * (1 - poseBlend)
  end

  if not self.onSurface and poseBlend <= 0 then
    leftBootAngle = -0.7
    rightBootAngle = 0.7
    local raisedWorldAngle = -math.pi / 2 - (math.pi * 0.75) * dirSign
    rightArmAngle = self:worldAngleToLocalRotation(raisedWorldAngle, orientation, dirSign)
    rightArmFlipped = true
  end

  -- Swim stroke: a brief one-shot sweep overriding whatever pose came
  -- before it — the airborne raised-arm pose above otherwise stays
  -- perfectly static the whole time submerged, with nothing marking the
  -- moment a stroke actually happened. Both arms sweep the SAME WORLD
  -- angle together (a simplified, synchronized stroke rather than
  -- alternating arms), from horizontal-out to straight overhead and
  -- back — a placeholder signal until there's a real swim animation.
  --
  -- Each arm's own local-angle convention is different (the right arm's
  -- rest art hangs straight down at local 0; the left/blaster arm's
  -- local 0 points it forward — see the intro-pose block above's own
  -- comment), so setting both to one shared LOCAL value, like the
  -- previous version of this did, produced two different-looking poses
  -- from the same number. Converting a single WORLD angle via
  -- worldAngleToLocalRotation for EACH arm separately — the same trick
  -- the intro pose above uses to put the left arm at the same literal
  -- world angle as the right's own natural hang — is what actually
  -- keeps them looking like a matched pair here.
  if self.swimStrokeTimer > 0 then
    local progress = 1 - (self.swimStrokeTimer / self.swimStrokeDuration)
    local swingT = math.sin(progress * math.pi) -- 0 -> 1 -> 0 across the stroke
    local overheadWorldAngle = -math.pi / 2
    local outWorldAngle = dirSign > 0 and 0 or math.pi
    local strokeWorldAngle = outWorldAngle + (overheadWorldAngle - outWorldAngle) * swingT
    leftArmAngle = self:worldAngleToLocalRotation(strokeWorldAngle, orientation, dirSign)
    rightArmAngle = self:worldAngleToLocalRotation(strokeWorldAngle, orientation, dirSign)
    rightArmFlipped = false
  end

  self:drawLimb(images.leftboot, cfg.leftBootX, cfg.leftBootY, cfg.leftBootJointX, cfg.leftBootJointY, leftBootAngle, orientation, originPos, cosO, sinO)
  self:drawLimb(images.leftarm, cfg.leftArmX, cfg.leftArmY, cfg.leftArmJointX, cfg.leftArmJointY, leftArmAngle, orientation, originPos, cosO, sinO)

  if images.body then
    local bodyW, bodyH = images.body:getDimensions()
    love.graphics.push()
    love.graphics.translate(originPos.x, originPos.y)
    love.graphics.rotate(orientation)
    love.graphics.draw(images.body, -bodyW * s / 2, cfg.bodyY * s - bodyH * s / 2, 0, s, s)
    love.graphics.pop()
  end

  self:drawLimb(images.rightboot, cfg.rightBootX, cfg.rightBootY, cfg.rightBootJointX, cfg.rightBootJointY, rightBootAngle, orientation, originPos, cosO, sinO)
  self:drawLimb(images.rightarm, cfg.rightArmX, cfg.rightArmY, cfg.rightArmJointX, cfg.rightArmJointY, rightArmAngle, orientation, originPos, cosO, sinO, rightArmFlipped)

  if images.head then
    local headW, headH = images.head:getDimensions()
    local headWX = -cfg.headY * sinO
    local headWY = cfg.headY * cosO
    local headBob = (poseBlend <= 0 and self.onSurface and self.isWalking) and (math.sin(self.walkTime * 2) * 0.03) or 0
    local normalHeadLookTilt = self.mouseIdle and 0 or self:computeHeadLookTilt(orientation, dirSign)
    local headLookTilt = normalHeadLookTilt * (1 - poseBlend)
    local headTilt = headBob + headLookTilt
    local pivotY = headH * s * self.headPivotFraction

    love.graphics.push()
    love.graphics.translate(originPos.x + headWX * s, originPos.y + headWY * s)
    love.graphics.rotate(orientation + headTilt)
    love.graphics.draw(images.head, -headW * s / 2, -pivotY, 0, s, s)
    love.graphics.pop()
  end
end

-- White morph-ball body split by three black spokes into equal wedges,
-- like a classic peace-sign/beach-ball marking — spoke positions are
-- offset by self.ballRollAngle (see :move()'s own rolling-without-
-- slipping update), so they visibly sweep around as he travels instead
-- of the ball reading as a static painted-on circle. orientation is the
-- same "which way is down relative to the surface below" convention
-- every other draw here uses, so the wedge pattern stays sensibly
-- aligned with gravity rather than just the rolling spin alone.
local BALL_LINE_COLOR = { 0x9C / 255, 0x9B / 255, 0x9B / 255 } -- #9C9B9B — outline + section-spoke color
local BALL_CENTER_FILL_COLOR = { 0x6A / 255, 0xE7 / 255, 0xEB / 255 } -- #6AE7EB
local BALL_CENTER_RADIUS_FRACTION = 1 / 3

function Player:drawBallMode(orientation)
  local r = self.radius

  love.graphics.push()
  love.graphics.translate(self.pos.x, self.pos.y)
  love.graphics.rotate(orientation + self.ballRollAngle)

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.circle("fill", 0, 0, r)

  love.graphics.setColor(BALL_LINE_COLOR)
  local prevLineWidth = love.graphics.getLineWidth()
  love.graphics.setLineWidth(math.max(1, r * 0.12 - 1))
  for i = 0, 2 do
    local a = i * (math.pi * 2 / 3)
    love.graphics.line(0, 0, math.cos(a) * r, math.sin(a) * r)
  end
  love.graphics.circle("line", 0, 0, r)

  -- Small center "eye" — a plain filled+outlined circle, same section-
  -- line gray for its own outline so it reads as part of the same
  -- marking scheme rather than a separate decoration.
  local centerR = r * BALL_CENTER_RADIUS_FRACTION
  love.graphics.setColor(BALL_CENTER_FILL_COLOR)
  love.graphics.circle("fill", 0, 0, centerR)
  love.graphics.setColor(BALL_LINE_COLOR)
  love.graphics.circle("line", 0, 0, centerR)

  love.graphics.setLineWidth(prevLineWidth)
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.pop()

  self:drawBallShading()
end

-- The ball's own share of the sun shading (see BODY_SHADING). The rig's
-- pieces get theirs from a shader that works off each image — but the
-- ball is plain drawn shapes, with no image for that shader to read, so
-- it's shaded the direct way instead: the same shadow and the same
-- highlight, as two soft discs laid over it. Same numbers, so a ball
-- and a standing astronaut are lit identically. Drawn in world space,
-- outside the ball's own roll rotation — the markings spin, the light
-- doesn't.
local ballShadowMesh, ballHighlightMesh = nil, nil
local function getBallShadingMeshes()
  if ballShadowMesh then return ballShadowMesh, ballHighlightMesh end
  local s = BODY_SHADING
  local segments, rings = 48, 10

  -- Both are unit discs built for a light shining from +x; drawing them
  -- rotated to the sun's actual direction puts the light where it is.
  local function disc(alphaAt, r, g, b)
    local vertices = {}
    local function vertex(angle, t)
      local x, y = math.cos(angle) * t, math.sin(angle) * t
      return { x, y, 0, 0, r, g, b, alphaAt(x, y) }
    end
    for ring = 1, rings do
      local t0, t1 = (ring - 1) / rings, ring / rings
      for i = 0, segments - 1 do
        local a0, a1 = (i / segments) * math.pi * 2, ((i + 1) / segments) * math.pi * 2
        table.insert(vertices, vertex(a0, t0)); table.insert(vertices, vertex(a0, t1)); table.insert(vertices, vertex(a1, t1))
        table.insert(vertices, vertex(a0, t0)); table.insert(vertices, vertex(a1, t1)); table.insert(vertices, vertex(a1, t0))
      end
    end
    return love.graphics.newMesh(vertices, "triangles", "static")
  end

  -- How much darker each point is than its own color — the same
  -- formula as the shader, written as an amount of black to lay on top.
  ballShadowMesh = disc(function(x, y)
    local dx, dy = x - s.shadowOffset, y
    local lit = math.max(0, math.min(1, 1 - math.sqrt(dx * dx + dy * dy) / s.shadowReach))
    local shade = (1 + (lit - 1) * s.strength) * (1 - s.overallDarken * s.strength)
    return 1 - shade
  end, 0, 0, 0)

  ballHighlightMesh = disc(function(x, y)
    local dx, dy = x - s.highlightOffset, y
    local h = math.max(0, math.min(1, 1 - math.sqrt(dx * dx + dy * dy) / s.highlightSize))
    return h * h * s.highlightAlpha
  end, 1, 0.98, 0.92)

  return ballShadowMesh, ballHighlightMesh
end

function Player:drawBallShading()
  if not HERO_SHADING_ENABLED then return end
  local toSunX = (state.sceneWidth or 0) / 2 - self.pos.x
  local toSunY = (state.sceneHeight or 0) / 2 - self.pos.y
  if toSunX == 0 and toSunY == 0 then return end
  local sunAngle = math.atan2(toSunY, toSunX)

  local shadow, highlight = getBallShadingMeshes()
  local r = self.radius
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(shadow, self.pos.x, self.pos.y, sunAngle, r, r)
  love.graphics.setBlendMode("add", "alphamultiply")
  love.graphics.draw(highlight, self.pos.x, self.pos.y, sunAngle, r, r)
  love.graphics.setBlendMode("alpha")
  love.graphics.setColor(1, 1, 1, 1)
end

-- Scale/glow "blip" pulse during a Beam.lua teleport — ported from the
-- old JS game's own teleportScale/teleportGlow (startTeleport/update in
-- js/entities/Player.js): pulse = sin(t*pi), scale = 1 + pulse*1.2, glow
-- intensity = pulse — 0 at the phase's own start/end, peaking at its own
-- midpoint. ONLY plays over the "out" half (departing the origin beam),
-- not the "in" half (arriving at the destination) — the arrival moment
-- gets its own, different cue instead (the post-arrival invincibility
-- flicker — see Player:isInvincible/draw), not a second scale/glow
-- blip. Returns 1, 0 (no pulse at all) whenever he isn't currently
-- departing.
function Player:getTeleportPulse()
  if self.teleportState ~= "out" then return 1, 0 end
  local elapsed = TELEPORT_OUT_TICKS - self.teleportTimer
  local t = (TELEPORT_OUT_TICKS > 0) and math.max(0, math.min(1, elapsed / TELEPORT_OUT_TICKS)) or 1
  local pulse = math.sin(t * math.pi)
  return 1 + pulse * 1.2, pulse
end

-- Any Beam.lua teleporter currently close enough to interact with — nil
-- when none is — plus how close, as a 0..1 proximity fraction (1 right
-- at the beam's own planted base, fading linearly to 0 at its own
-- interactRadius, same reach Beam:tryInteract/drawTooltip already use
-- for "close enough," just measured continuously here instead of as a
-- flat yes/no). Recomputed directly rather than trusting a beam's own
-- cached self.playerNearby from its last :update(), so this can't end
-- up a frame stale relative to whatever :draw() is about to show
-- regardless of update/draw ordering. When more than one beam is
-- somehow in range at once, picks whichever one he's actually closer to.
function Player:getNearbyBeam()
  if not state.beams then return nil, 0 end
  local best, bestProximity = nil, 0
  for _, beam in ipairs(state.beams) do
    local dx, dy = self.pos.x - beam.pos.x, self.pos.y - beam.pos.y
    local dist = math.sqrt(dx * dx + dy * dy)
    if dist <= beam.interactRadius then
      local proximity = 1 - dist / beam.interactRadius
      if not best or proximity > bestProximity then
        best = beam
        bestProximity = proximity
      end
    end
  end
  return best, bestProximity
end

function Player:draw()
  -- Gone for the death pause — only his death burst is on screen.
  if self.isDying then return end

  local scale, pulseGlow = self:getTeleportPulse()

  -- Outer glow hugging his own real silhouette (SilhouetteGlow.lua —
  -- not a plain circle, an actual shader-dilated copy of his rendered
  -- shape) whenever he's close enough to a beam to interact with it,
  -- tinted to match THAT beam's own color (Beam.lua's own self.color)
  -- rather than a hardcoded color — both of main.lua's current beams
  -- are violet, so this reads as purple today, but it'll follow
  -- whatever color a future beam actually uses. Fades out with distance
  -- (proximity, 1 right at the beam down to 0 at its own interactRadius
  -- — see Player:getNearbyBeam) rather than snapping on at full
  -- strength the instant he's in range, and is boosted a bit extra
  -- during the departure pulse itself (pulseGlow, see
  -- Player:getTeleportPulse) so interacting still reads as more intense
  -- than just standing nearby, without needing a second, separate glow
  -- effect for that moment.
  --
  -- The mask drawFn below applies the SAME scale transform the real
  -- draw further down uses (see the scale~=1 branch there) rather than
  -- always rendering him at scale=1 — without this, the glow stayed
  -- silhouette-shaped for his NORMAL size the whole time, visibly
  -- mismatched against his own body actually ballooning up through the
  -- pulse. boundWorldRadius is scaled right along with it (self.radius*
  -- 4*scale, not a fixed *4) so the mask canvas stays big enough to fit
  -- him without clipping at the pulse's own largest point.
  local nearbyBeam, proximity = self:getNearbyBeam()
  if nearbyBeam then
    SilhouetteGlow.draw(
      self.pos.x, self.pos.y,
      self.radius * 4 * scale, 14,
      nearbyBeam.color, 0.8 * proximity * (1 + pulseGlow * 0.6),
      function()
        if scale == 1 then
          self:drawRig()
          return
        end
        love.graphics.push()
        love.graphics.translate(self.pos.x, self.pos.y)
        love.graphics.scale(scale, scale)
        love.graphics.translate(-self.pos.x, -self.pos.y)
        self:drawRig()
        love.graphics.pop()
      end)
  end

  -- Post-arrival invincibility flicker (Player:isInvincible) — a hard
  -- on/off blink (skip drawing him entirely on the "off" beat) rather
  -- than the old JS game's own alternating-alpha version: drawRig below
  -- sets its own opaque color on nearly every piece of the rig it draws
  -- (suit, visor, boots, ...), so a single love.graphics.setColor(...,
  -- alpha) wrapped around the whole call would just get overwritten by
  -- the first of those and never actually dim anything. A true skipped
  -- frame can't be overwritten the same way, and reads just as clearly
  -- as "flickering" — same ~100ms-per-phase rate the JS original used
  -- (INVINCIBLE_FLICKER_INTERVAL), driven off love.timer.getTime()
  -- rather than state.timeScale-scaled ticks since it's a pure visual
  -- readability cue, not gameplay timing: it should blink at a
  -- consistent real-world rate regardless of VATS slow-mo.
  if self:isInvincible() then
    local phase = math.floor(love.timer.getTime() / INVINCIBLE_FLICKER_INTERVAL) % 2
    if phase ~= 0 then return end
  end

  -- Sun shading on every piece of the rig — see getBodyShadingShader.
  local shadingShader = self:applyBodyShading()

  if scale == 1 then
    self:drawRig()
  else
    love.graphics.push()
    love.graphics.translate(self.pos.x, self.pos.y)
    love.graphics.scale(scale, scale)
    love.graphics.translate(-self.pos.x, -self.pos.y)
    self:drawRig()
    love.graphics.pop()
  end

  if shadingShader then love.graphics.setShader() end
end

-- Turns the body-shading shader on for whatever's drawn next, pointed
-- at wherever the sun is from him right now. Returns the shader (so the
-- caller knows to turn it back off), or nil if shading is switched off.
function Player:applyBodyShading()
  if not HERO_SHADING_ENABLED then return nil end
  local toSunX = (state.sceneWidth or 0) / 2 - self.pos.x
  local toSunY = (state.sceneHeight or 0) / 2 - self.pos.y
  local dist = math.sqrt(toSunX * toSunX + toSunY * toSunY)
  if dist < 1 then return nil end

  local shader = getBodyShadingShader()
  shader:send("lightDir", { toSunX / dist, toSunY / dist })
  love.graphics.setShader(shader)
  return shader
end

-- Everything draw() USED to be, unchanged — just renamed so draw()
-- itself could become a thin wrapper applying the teleport pulse above
-- (scale transform + glow) around whichever branch below actually
-- draws him, without needing to duplicate that wrapper at each of this
-- function's own early returns.
function Player:drawRig()
  local planet = self.onSurface and self.currentPlanet or self.lastInfluencePlanet
  local downDir = self:visualDownDirection(planet)
  local downAngle = math.atan2(downDir.y, downDir.x)
  local orientation = downAngle - math.pi / 2

  if self.morphState then
    self:drawBallMorphTransition(orientation)
    return
  end

  if self.isBall then
    self:drawBallMode(orientation)
    return
  end

  local outwardDir = downDir:multiply(-1)
  local visualPos = self.pos:clone():add(outwardDir:multiply(self.groundOffset * self.bodyScale))

  local dirSign = self.facingDirection < 0 and -1 or 1

  love.graphics.push()
  love.graphics.translate(self.pos.x, self.pos.y)
  love.graphics.rotate(orientation)
  love.graphics.scale(dirSign, 1)
  love.graphics.rotate(-orientation)
  love.graphics.translate(-self.pos.x, -self.pos.y)

  self:drawFullBody(orientation, visualPos)

  love.graphics.pop()
end

------------------------------------------------------------------
-- Pull target
------------------------------------------------------------------

function Player:trySelectPullTarget(explicitTarget)
  if self.mode ~= "space" or self.isBall or self.isTeleporting or self.isDying then return end

  local best = nil
  if explicitTarget then
    for _, p in ipairs(state.planetoids) do
      if p == explicitTarget and not explicitTarget.isPullExempt then
        best = explicitTarget
        break
      end
    end
  else
    local cam = state.camera or { x = 0, y = 0 }
    local zoom = state.zoom or 1
    local mouse = state.mouse or { x = self.pos.x, y = self.pos.y }
    local worldX = mouse.x / zoom + cam.x
    local worldY = mouse.y / zoom + cam.y

    local bestDistSq = math.huge
    for _, planet in ipairs(state.planetoids) do
      if not planet.isPullExempt then
        local hit = false
        if planet.containsPoint then
          hit = planet:containsPoint(worldX, worldY)
        else
          local dx = worldX - planet.pos.x
          local dy = worldY - planet.pos.y
          hit = (dx * dx + dy * dy) <= (planet.radius or 0) * (planet.radius or 0)
        end

        if hit then
          local ax, ay = self:getPullAnchor(planet)
          local adx = worldX - ax
          local ady = worldY - ay
          local distSq = adx * adx + ady * ady
          if distSq < bestDistSq then
            bestDistSq = distSq
            best = planet
          end
        end
      end
    end
  end

  if best then
    if self.onSurface and self.currentPlanet then
      local launchDir = self:getOutwardLaunchDirection()
      self.vel = launchDir:multiply(constants.JUMP_STRENGTH)
    end
    self.pullTarget = best
    self.onSurface = false
    self.currentPlanet = nil
    state.vatsActive = false
  end
end

function Player:clearPullTarget()
  self.pullTarget = nil
end

function Player:applyPullForce()
  if self.onSurface then self.pullTarget = nil; return end
  if not self.pullTarget then return end
  -- Curling into a ball drops any pull in progress outright, rather
  -- than leaving it silently paused mid-flight — a ball has no pull
  -- beam at all (see this session's own "no pull beam while a ball"
  -- request), so there's nothing for a stale pullTarget to resume once
  -- he un-morphs either.
  if self.isBall then self.pullTarget = nil; return end
  -- Same reasoning, for mid-teleport (Beam.lua) instead of ball mode —
  -- he's frozen in place either way, so a pull target left over from
  -- right before interacting with a beam shouldn't resume once he
  -- arrives somewhere else entirely.
  if self.isTeleporting or self.isDying then self.pullTarget = nil; return end

  local stillActive = false
  for _, p in ipairs(state.planetoids) do
    if p == self.pullTarget then stillActive = true; break end
  end
  if not stillActive then
    self.pullTarget = nil
    return
  end

  local tx, ty = self:getPullAnchor(self.pullTarget)
  local dx = tx - self.pos.x
  local dy = ty - self.pos.y
  local dist = math.sqrt(dx * dx + dy * dy)
  if dist < 1e-6 then return end

  local dirX, dirY = dx / dist, dy / dist

  local radialSpeed = self.vel.x * dirX + self.vel.y * dirY
  local tangentX = self.vel.x - radialSpeed * dirX
  local tangentY = self.vel.y - radialSpeed * dirY
  local tangentRetention = (1 - self.pullTangentialDamping) ^ state.timeScale
  self.vel.x = self.vel.x - tangentX * (1 - tangentRetention)
  self.vel.y = self.vel.y - tangentY * (1 - tangentRetention)

  self.vel.x = self.vel.x + dirX * self.pullAccel * state.timeScale
  self.vel.y = self.vel.y + dirY * self.pullAccel * state.timeScale

  local speed = self.vel:length()
  if speed > self.pullMaxSpeed then
    self.vel = self.vel:multiply(self.pullMaxSpeed / speed)
  end
end

-- World position of the blaster's own muzzle — the hole at the end of his
-- arm — given where the arm is currently aimed (self.aimShoulderPos/
-- aimWorldAngle, set whenever he is drawn). Everything that comes out of
-- the blaster starts here: fireballs (shootFireball, just below) and the
-- pull beam (lua/effects/PullBeam.lua). Falls back to his own position
-- before he has ever been drawn.
function Player:getMuzzlePosition()
  -- Exact muzzle pixel within leftarm.png (602x256) — NOT the old
  -- fixed-distance-along-the-aim-angle approximation (blasterMuzzleLength),
  -- which only ever put the origin somewhere along the right ray, not
  -- necessarily where the blaster's own muzzle actually is once the arm's
  -- real rotation/scale/mirroring are accounted for.
  local MUZZLE_PX_X, MUZZLE_PX_Y = 530, 120

  local originX, originY
  if self.aimShoulderPos then
    local cfg = self.bodyPartsConfig
    local s = self.bodyScale
    local dirSign = self.facingDirection < 0 and -1 or 1
    local aimWorldAngle = self.aimWorldAngle or 0

    -- Raw offset (world units) from the arm's own joint pivot
    -- (leftArmJointX/Y — the pixel drawLimb lands exactly on the
    -- shoulder attach point) to the target muzzle pixel, still in the
    -- image's own unrotated local space.
    local vx = (MUZZLE_PX_X - cfg.leftArmJointX) * s
    local vy = (MUZZLE_PX_Y - cfg.leftArmJointY) * s

    local worldVX, worldVY
    if dirSign > 0 then
      -- Facing right (unmirrored): drawLimb's own rotate(orientation+
      -- localAngle) is exactly aimWorldAngle in world space (see
      -- computeLeftArmAimAngle/worldAngleToLocalRotation — the two
      -- cancel out cleanly for this case), so this local offset just
      -- rotates by aimWorldAngle directly.
      local c, sn = math.cos(aimWorldAngle), math.sin(aimWorldAngle)
      worldVX = vx * c - vy * sn
      worldVY = vx * sn + vy * c
    else
      -- Facing left: the whole rig is additionally mirrored by
      -- Player:drawRig's own outer scale(dirSign,1) (reflecting about
      -- the line through self.pos at angle `orientation`), which does
      -- NOT commute with the arm's own extra rotate(localAngle) the
      -- naive way. Working through the actual composed transform (same
      -- identity worldAngleToLocalRotation's own dirSign<0 branch is
      -- built on) reduces it to: flip this local offset horizontally,
      -- then rotate by (aimWorldAngle - pi) — not aimWorldAngle itself.
      local rot = aimWorldAngle - math.pi
      local c, sn = math.cos(rot), math.sin(rot)
      local fx, fy = -vx, vy
      worldVX = fx * c - fy * sn
      worldVY = fx * sn + fy * c
    end

    originX = self.aimShoulderPos.x + worldVX
    originY = self.aimShoulderPos.y + worldVY
  else
    originX = self.pos.x
    originY = self.pos.y
  end

  return originX, originY
end

function Player:shootFireball()
  if self.mode ~= "space" and self.mode ~= "platform" then return end
  if self.isBall or self.isTeleporting or self.isDying then return end
  if state.vatsActive then return end -- in V.A.T.S. he only picks a target and pulls to it (see main.lua's own V.A.T.S. rules)

  local now = love.timer.getTime()
  self.lastShotTime = self.lastShotTime or 0
  self.fireCooldown = self.fireCooldown or 0.15
  if now - self.lastShotTime < self.fireCooldown then return end
  self.lastShotTime = now

  local angle = self.aimWorldAngle or 0
  if self.blasterAngleOffset then
    angle = angle + self.blasterAngleOffset
  end

  local originX, originY = self:getMuzzlePosition()

  state.fireballs = state.fireballs or {}
  local Fireball = require("lua.entities.Fireball")
  table.insert(state.fireballs, Fireball.new(originX, originY, angle))
end

-- ----------------------------
-- HARD LOCK (gamepad R1 = next/clockwise, L1 = previous/counter-
-- clockwise, Circle = release) — see GamePadInput.lua for the button
-- wiring and lua/systems/TargetLock.lua for the actual candidate-
-- gathering/sorting logic.
-- ----------------------------
-- Both cycle from wherever the blaster is currently aimed
-- (self.aimWorldAngle — kept accurate every frame regardless of
-- source, so this works whether there's no lock yet, starting from
-- whatever the normal aim system currently has it pointed at, or an
-- existing lock, since aimWorldAngle already equals the angle to the
-- current lockedTarget by the time either of these runs again). The
-- two are mirror images of each other, so in the common case a single
-- R1 press followed by a single L1 press (or vice versa) lands back on
-- whatever was locked before, reading as a genuine undo.
function Player:tryLockTargetNext()
  if self.mode ~= "space" or self.isDying or self.isTeleporting or self.isBall then return end
  local originPos = self.aimShoulderPos or self.pos
  local referenceAngle = self.aimWorldAngle or 0
  self.lockedTarget = TargetLock.selectNextLockTarget(self.lockedTarget, referenceAngle, originPos)
end

function Player:tryLockTargetPrevious()
  if self.mode ~= "space" or self.isDying or self.isTeleporting or self.isBall then return end
  local originPos = self.aimShoulderPos or self.pos
  local referenceAngle = self.aimWorldAngle or 0
  self.lockedTarget = TargetLock.selectPreviousLockTarget(self.lockedTarget, referenceAngle, originPos)
end

function Player:clearLockTarget()
  self.lockedTarget = nil
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
  if point then
    self.pos.x, self.pos.y = point.x, point.y
    if point.planet then
      self.onSurface = true
      self.currentPlanet = point.planet
      self.lastInfluencePlanet = point.planet
      self.angle = -math.pi / 2
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
end

return Player
