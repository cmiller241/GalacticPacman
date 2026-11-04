-- lua/entities/player/Rendering.lua
--
-- Player methods for drawing him: aiming the arm and head, the body rig
-- and its poses (walking, wall slide, ground pound, the ball-morph
-- keyframes), the ball itself, sun shading, the teleport shimmer and the
-- invincibility flicker. Copied onto Player by lua/entities/Player.lua.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local SilhouetteGlow = require("lua.effects.SilhouetteGlow")
local TransporterEffect = require("lua.effects.TransporterEffect")
local TargetLock = require("lua.systems.TargetLock")
local WaterSystem = require("lua.systems.WaterSystem")
local PortalGun = require("lua.systems.PortalGun")
local Tuning = require("lua.entities.player.Tuning")

local Player = {}

local BALL_MORPH_SEGMENT_TICKS = Tuning.BALL_MORPH_SEGMENT_TICKS
local TELEPORT_OUT_TICKS = Tuning.TELEPORT_OUT_TICKS
local TELEPORT_IN_TICKS = Tuning.TELEPORT_IN_TICKS

-- How long, once the door-opening intro ends (state.introLocked flips
-- false), the rigid intro pose (arms/head — see drawFullBody's own
-- poseBlend) takes to ease back into whatever the normal pose would
-- be, rather than snapping there in one frame.
local INTRO_POSE_TRANSITION_SECONDS = 0.6
local BLASTER_IN_USE_LINGER = 0.6 -- seconds after a shot his blaster arm stays aimed (see isUsingBlaster)

-- Ground pound pose (see GROUND_POUND_POSE / Player:getGroundPoundSeatDrop below).
local GROUND_POUND_SETTLE_TICKS = 7   -- baseline (60fps) ticks the pose takes to sink down into its seated position at the start of a pound
local GROUND_POUND_SEAT_ADJUST = 0    -- world units added to the computed seat drop (positive = lower still) — fine-tuning only

-- How fast he blinks while invincible (see Player:isInvincible).
local INVINCIBLE_FLICKER_INTERVAL = 0.1 -- seconds per blink phase

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

-- Whether the blaster's in use right now, or was a moment ago: spraying
-- water, holding fire, or a fireball/portal shot within the last
-- BLASTER_IN_USE_LINGER seconds. Its arm then stays aimed (see
-- drawFullBody) instead of drifting into the idle sway just because the
-- mouse has sat still — the shots come out along the aim either way, so
-- the arm has to show it.
function Player:isUsingBlaster()
  if WaterSystem.isSpraying() then return true end
  local mode = state.weaponMode or "fireball"
  if state.gamepadFireHeld or (state.mouseDown and (mode == "fireball" or mode == "ice")) then return true end
  local now = love.timer.getTime()
  if self.lastShotTime and now - self.lastShotTime < BLASTER_IN_USE_LINGER then return true end
  if PortalGun.lastShotTime and now - PortalGun.lastShotTime < BLASTER_IN_USE_LINGER then return true end
  return false
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
  if self.mouseIdle and not self.pullTarget and not self:isUsingBlaster() then
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

-- Where he is in a Beam.lua teleport's transporter shimmer (see
-- lua/effects/TransporterEffect.lua). Returns bodyAlpha, glow, sparkle
-- (each 0..1 — see TransporterEffect.curves) and the {r,g,b} the light
-- should be: the beam's own color washed toward white, like a
-- transporter's glow. Dematerializing on the way out; arriving is the
-- same curve played backward, so he shimmers back in. Returns 1, 0, 0
-- (fully here, no effect) when he isn't teleporting.
function Player:getTransporterState()
  if not self.teleportState then return 1, 0, 0, nil end
  local total = (self.teleportState == "out") and TELEPORT_OUT_TICKS or TELEPORT_IN_TICKS
  local t = (total > 0) and math.max(0, math.min(1, (total - self.teleportTimer) / total)) or 1
  if self.teleportState == "in" then t = 1 - t end
  local bodyAlpha, glow, sparkle = TransporterEffect.curves(t)
  local beam = (self.teleportState == "out") and self.teleportOrigin or self.teleportDestination
  local c = beam and beam.color or { 0.6, 0.8, 1 }
  local color = { c[1] + (1 - c[1]) * 0.5, c[2] + (1 - c[2]) * 0.5, c[3] + (1 - c[3]) * 0.5 }
  return bodyAlpha, glow, sparkle, color
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
  -- Gone for the death pause — only his death burst is on screen. And
  -- not seen while he's inside a cannon's barrel (see lua/world/Cannon.lua).
  if self.isDying or self.inCannon then return end

  -- Mid-teleport, he shimmers out (or back in) — see
  -- Player:getTransporterState / lua/effects/TransporterEffect.lua.
  local bodyAlpha, energize, sparkle, transporterColor = self:getTransporterState()

  -- Outer glow hugging his own real silhouette (SilhouetteGlow.lua —
  -- not a plain circle, an actual shader-dilated copy of his rendered
  -- shape) whenever he's close enough to a beam to interact with it,
  -- tinted to match THAT beam's own color (Beam.lua's own self.color).
  -- Fades out with distance (proximity, 1 right at the beam down to 0 at
  -- its own interactRadius — see Player:getNearbyBeam), and with his
  -- body as he dematerializes, brightening a little as he's energized.
  local nearbyBeam, proximity = self:getNearbyBeam()
  if nearbyBeam then
    SilhouetteGlow.draw(
      self.pos.x, self.pos.y,
      self.radius * 4, 14,
      nearbyBeam.color, 0.8 * proximity * bodyAlpha * (1 + energize * 0.6),
      function() self:drawRig() end)
  end

  -- Post-arrival invincibility flicker (Player:isInvincible) — a hard
  -- on/off blink (skip drawing him entirely on the "off" beat) rather
  -- than fading him: drawRig below sets its own opaque color on nearly
  -- every piece of the rig (suit, visor, boots, ...), so a single
  -- love.graphics.setColor(..., alpha) around the whole call would be
  -- overwritten and never dim anything. The blink rate
  -- (INVINCIBLE_FLICKER_INTERVAL) is driven off love.timer.getTime()
  -- rather than state.timeScale-scaled ticks since it's a pure visual
  -- readability cue, not gameplay timing: it should blink at a
  -- consistent real-world rate regardless of VATS slow-mo.
  -- (Not while he's still rematerializing — the shimmer is the arrival
  -- cue; the flicker takes over once he's fully back.)
  if self:isInvincible() and self.teleportState ~= "in" then
    local phase = math.floor(love.timer.getTime() / INVINCIBLE_FLICKER_INTERVAL) % 2
    if phase ~= 0 then return end
  end

  -- Sun shading on every piece of the rig — see getBodyShadingShader.
  local function drawShaded()
    local shadingShader = self:applyBodyShading()
    self:drawRig()
    if shadingShader then love.graphics.setShader() end
  end

  if bodyAlpha >= 1 and energize <= 0 then
    drawShaded()
  else
    TransporterEffect.drawFaded(self.pos.x, self.pos.y, self.radius * 4, bodyAlpha, energize, transporterColor, drawShaded)
  end

  -- The transporter sparkles, in a column covering him from boots to helmet.
  if sparkle > 0 then
    local planet = self.onSurface and self.currentPlanet or self.lastInfluencePlanet
    local down = self:visualDownDirection(planet)
    local upX, upY = -down.x, -down.y
    local r = self.radius
    local headTop = self.headReach or (r * 2.5)
    local height = headTop + r
    local mid = (headTop - r) / 2
    TransporterEffect.drawSparkles(
      self.pos.x + upX * mid, self.pos.y + upY * mid, upX, upY,
      height * 1.15, r * 2.4, sparkle, transporterColor, love.timer.getTime())
  end
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

return Player
