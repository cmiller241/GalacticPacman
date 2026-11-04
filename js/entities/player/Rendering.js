// js/entities/player/Rendering.js
//
// Player methods for drawing him: aiming the arm and head, the body rig
// and its poses (walking, wall slide, ground pound, the ball-morph
// keyframes), the ball itself, sun shading, the teleport shimmer and the
// invincibility flicker. Copied onto Player by js/entities/Player.js.
// (A port of lua/entities/player/Rendering.lua.)

import love from '../../love/index.js';
import state from '../../state.js';
import Vector2 from '../../vector2.js';
import SilhouetteGlow from '../../effects/SilhouetteGlow.js';
import TransporterEffect from '../../effects/TransporterEffect.js';
import TargetLock from '../../systems/TargetLock.js';
import WaterSystem from '../../systems/WaterSystem.js';
import PortalGun from '../../systems/PortalGun.js';
import Tuning from './Tuning.js';

const { BALL_MORPH_SEGMENT_TICKS, TELEPORT_OUT_TICKS, TELEPORT_IN_TICKS } = Tuning;

// How long, once the door-opening intro ends (state.introLocked flips
// false), the rigid intro pose (arms/head — see drawFullBody's own
// poseBlend) takes to ease back into whatever the normal pose would
// be, rather than snapping there in one frame.
const INTRO_POSE_TRANSITION_SECONDS = 0.6;
const BLASTER_IN_USE_LINGER = 0.6; // seconds after a shot his blaster arm stays aimed (see isUsingBlaster)

// Ground pound pose (see GROUND_POUND_POSE / Player.getGroundPoundSeatDrop below).
const GROUND_POUND_SETTLE_TICKS = 7;  // baseline (60fps) ticks the pose takes to sink down into its seated position at the start of a pound
const GROUND_POUND_SEAT_ADJUST = 0;   // world units added to the computed seat drop (positive = lower still) — fine-tuning only

// How fast he blinks while invincible (see Player.isInvincible).
const INVINCIBLE_FLICKER_INTERVAL = 0.1; // seconds per blink phase

// Sun shading on the astronaut — the same treatment every planetoid
// gets (see Planetoid.js's own getSunShadingShader), applied separately to
// EACH piece of his rig (head, body, each arm, each boot): a lit side
// facing the sun, falling off into shadow on the far side, with a soft
// highlight on the lit side. Each piece is shaded as its own rounded
// form, so he reads as a set of solid parts rather than one flat cutout.
//
// The numbers mirror Planetoid.js's: the shadow gradient is centered
// shadowOffset of the way toward the sun and runs out over shadowReach
// (both in units of the piece's own half-size); the highlight sits
// highlightOffset toward the sun and is highlightSize across.
//   strength   how much of that shadow is actually applied — 1 is the
//              full planetoid treatment (far side nearly black), 0 none.
//
// HERO_SHADING_ENABLED is the one switch for all of it — the rig's
// pieces AND the ball he curls into.
const HERO_SHADING_ENABLED = true;

const BODY_SHADING = {
  strength: 0.28,
  shadowOffset: 0.5,
  shadowReach: 1.6,
  overallDarken: 0.08,
  highlightAlpha: 0.22,
  highlightSize: 0.55,
  highlightOffset: 0.48,
};

// One shader for every piece. It needs to know, for each pixel of
// whichever image is being drawn, where that pixel sits relative to the
// image's own center IN SCREEN SPACE — the rig rotates, scales and
// mirrors its pieces every which way, and the light has to come from
// the same direction on screen regardless. Rather than being told each
// piece's transform, it recovers that from the image's own texture
// coordinates: dFdx/dFdy say how the coordinates change from one screen
// pixel to the next, and inverting that turns "this far from the middle
// of the image" back into a direction and distance on screen. Anything
// drawn without an image (plain shapes) has no such gradient and is
// left untouched.
let bodyShadingShader = null;
function getBodyShadingShader() {
  if (bodyShadingShader) return bodyShadingShader;
  bodyShadingShader = love.graphics.newShader(`
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
  `);
  for (const name of ['strength', 'shadowOffset', 'shadowReach', 'overallDarken', 'highlightAlpha', 'highlightSize', 'highlightOffset']) {
    bodyShadingShader.send(name, BODY_SHADING[name]);
  }
  return bodyShadingShader;
}

class Rendering {
  // ----------------------------------------------------------------
  // Aim helpers
  // ----------------------------------------------------------------

  worldAngleToLocalRotation(desiredWorldAngle, orientation, dirSign) {
    if (dirSign > 0) return desiredWorldAngle - orientation;
    return (orientation + Math.PI) - desiredWorldAngle;
  }

  computeLeftArmAimAngle(orientation, dirSign, originPos) {
    const cfg = this.bodyPartsConfig;
    const s = this.bodyScale;
    const cosO = Math.cos(orientation);
    const sinO = Math.sin(orientation);

    const offsetX = cfg.leftArmX * dirSign;
    const offsetY = cfg.leftArmY;
    const wx = offsetX * cosO - offsetY * sinO;
    const wy = offsetX * sinO + offsetY * cosO;
    const shoulderX = originPos.x + wx * s;
    const shoulderY = originPos.y + wy * s;

    const forwardAngle = dirSign > 0 ? orientation : (orientation + Math.PI);

    // Re-checked every frame — the moment a lock stops being valid
    // (destroyed, scrolled out of the viewport, or landed on), it's
    // cleared here and this frame falls through to the normal aim
    // priority chain below.
    if (this.lockedTarget && !TargetLock.isValidLockTarget(this.lockedTarget)) {
      this.lockedTarget = null;
    }

    // With a gamepad as the active input device and the right stick
    // resting in its deadzone, there's no meaningful aim target — the
    // mouse branch below would land almost exactly on the shoulder, and
    // that near-zero vector's angle is floating-point noise. Aiming
    // straight ahead matches the plain "shoot ahead of me" expectation.
    const aimStraightAhead = !this.lockedTarget && !this.pullTarget
      && !state.gamepadAimActive && state.gamepadIsActiveDevice;

    let targetWorldX, targetWorldY;
    if (aimStraightAhead) {
      targetWorldX = shoulderX + Math.cos(forwardAngle) * 1000;
      targetWorldY = shoulderY + Math.sin(forwardAngle) * 1000;
    } else if (this.lockedTarget) {
      // lockAimLeadX/Y: an optional offset from the target's own center
      // to aim at instead — the title screen's autopilot sets it to lead
      // a moving asteroid (see TitleScreen.js).
      targetWorldX = this.lockedTarget.pos.x + (this.lockAimLeadX ?? 0);
      targetWorldY = this.lockedTarget.pos.y + (this.lockAimLeadY ?? 0);
    } else if (this.pullTarget) {
      [targetWorldX, targetWorldY] = this.getPullAnchor(this.pullTarget);
    } else if (state.gamepadAimActive) {
      targetWorldX = shoulderX + (state.gamepadAimX ?? 0) * 1000;
      targetWorldY = shoulderY + (state.gamepadAimY ?? 0) * 1000;
    } else {
      const cam = state.camera ?? { x: 0, y: 0 };
      const zoom = state.zoom ?? 1;
      const mouse = state.mouse ?? { x: shoulderX, y: shoulderY };
      targetWorldX = mouse.x / zoom + cam.x;
      targetWorldY = mouse.y / zoom + cam.y;
    }

    const targetAngle = Math.atan2(targetWorldY - shoulderY, targetWorldX - shoulderX);
    let relative = Math.atan2(
      Math.sin(targetAngle - forwardAngle),
      Math.cos(targetAngle - forwardAngle),
    );

    if (!this.lockedTarget) {
      relative = Math.max(-this.maxAimFromForward, Math.min(this.maxAimFromForward, relative));
    }

    const clampedTargetAngle = forwardAngle + relative;
    this.aimShoulderPos = new Vector2(shoulderX, shoulderY);
    this.aimWorldAngle = clampedTargetAngle;
    this.aimRelativeAngle = relative;
    this.aimAnchorPos = this.pos.clone();

    return this.worldAngleToLocalRotation(clampedTargetAngle, orientation, dirSign);
  }

  computeHeadLookTilt(orientation, dirSign) {
    const forwardAngle = dirSign > 0 ? orientation : (orientation + Math.PI);
    const desiredWorldAngle = forwardAngle + this.headLookScale * (this.aimRelativeAngle ?? 0);
    return this.worldAngleToLocalRotation(desiredWorldAngle, orientation, dirSign);
  }

  // ----------------------------------------------------------------
  // Drawing
  // ----------------------------------------------------------------

  drawLimb(img, offsetX, offsetY, jointX, jointY, angle, orientation, originPos, cosO, sinO, flipHorizontal) {
    if (!img) return;
    const s = this.bodyScale;

    const wx = offsetX * cosO - offsetY * sinO;
    const wy = offsetX * sinO + offsetY * cosO;

    love.graphics.push();
    love.graphics.translate(originPos.x + wx * s, originPos.y + wy * s);
    love.graphics.rotate(orientation + angle);
    if (flipHorizontal) love.graphics.scale(-1, 1);
    love.graphics.draw(img, -jointX * s, -jointY * s, 0, s, s);
    love.graphics.pop();
  }

  // A fixed pose (WALL_SLIDE_POSE) — no walk-bob, no aim-follow. Also its
  // own z-order: the right arm (reaching back across/over the head in
  // this pose) is drawn AFTER the head.
  drawWallSlidePose(orientation, originPos) {
    const images = state.characterImages;
    if (!images) return;

    const cfg = this.bodyPartsConfig;
    const pose = WALL_SLIDE_POSE;
    const s = this.bodyScale;
    const cosO = Math.cos(orientation);
    const sinO = Math.sin(orientation);

    this.drawLimb(images.leftboot, pose.leftBootX, pose.leftBootY, cfg.leftBootJointX, cfg.leftBootJointY, pose.leftBootAngle, orientation, originPos, cosO, sinO);
    this.drawLimb(images.leftarm, cfg.leftArmX, cfg.leftArmY, cfg.leftArmJointX, cfg.leftArmJointY, pose.leftArmAngle, orientation, originPos, cosO, sinO);

    if (images.body) {
      const [bodyW, bodyH] = images.body.getDimensions();
      love.graphics.push();
      love.graphics.translate(originPos.x, originPos.y);
      love.graphics.rotate(orientation);
      love.graphics.draw(images.body, -bodyW * s / 2, cfg.bodyY * s - bodyH * s / 2, 0, s, s);
      love.graphics.pop();
    }

    this.drawLimb(images.rightboot, pose.rightBootX, pose.rightBootY, cfg.rightBootJointX, cfg.rightBootJointY, pose.rightBootAngle, orientation, originPos, cosO, sinO);

    if (images.head) {
      const [headW, headH] = images.head.getDimensions();
      const headWX = -pose.headY * sinO;
      const headWY = pose.headY * cosO;
      const pivotY = headH * s * this.headPivotFraction;
      love.graphics.push();
      love.graphics.translate(originPos.x + headWX * s, originPos.y + headWY * s);
      love.graphics.rotate(orientation + pose.headAngle);
      love.graphics.draw(images.head, -headW * s / 2, -pivotY, 0, s, s);
      love.graphics.pop();
    }

    this.drawLimb(images.rightarm, cfg.rightArmX, cfg.rightArmY, cfg.rightArmJointX, cfg.rightArmJointY, pose.rightArmAngle, orientation, originPos, cosO, sinO);
  }

  // How far (world units) the ground-pound pose has to be drawn below his
  // standing position for the lowest part of it to sit exactly on the
  // ground. Worked out from the pose itself — the bottom of the body,
  // and each boot's image turned to its own angle about its own joint,
  // whichever reaches lowest. Cached; none of it changes.
  getGroundPoundSeatDrop() {
    if (groundPoundSeatDrop !== null) return groundPoundSeatDrop;
    const images = state.characterImages;
    if (!images || !images.body) return 0;

    const cfg = this.bodyPartsConfig, pose = GROUND_POUND_POSE;
    const bodyH = images.body.getHeight();
    let lowest = pose.bodyY + bodyH / 2;

    const lowestOfBoot = (img, attachY, jointX, jointY, angle) => {
      if (!img) return -Infinity;
      const [w, h] = img.getDimensions();
      const sinA = Math.sin(angle), cosA = Math.cos(angle);
      let best = -Infinity;
      for (const corner of [[0, 0], [w, 0], [0, h], [w, h]]) {
        best = Math.max(best, attachY + (corner[0] - jointX) * sinA + (corner[1] - jointY) * cosA);
      }
      return best;
    };
    lowest = Math.max(lowest,
      lowestOfBoot(images.leftboot, pose.leftBootY, cfg.leftBootJointX, cfg.leftBootJointY, pose.leftBootAngle),
      lowestOfBoot(images.rightboot, pose.rightBootY, cfg.rightBootJointX, cfg.rightBootJointY, pose.rightBootAngle));

    // All in the rig's own unscaled units until the last step: the soles
    // of his feet are his collision radius below this.pos, and the rig's
    // origin is groundOffset above it.
    const solesY = this.groundOffset + this.baseRadius / this.bodyScale;
    groundPoundSeatDrop = (solesY - lowest) * this.bodyScale + GROUND_POUND_SEAT_ADJUST;
    return groundPoundSeatDrop;
  }

  // Draws one blended ball-morph pose (leftboot, leftarm, body,
  // rightboot, rightarm, head) — every part's own X/Y/angle comes
  // straight from `pose`; jointX/jointY still come from cfg (an intrinsic
  // property of the source art).
  drawBallMorphPose(orientation, originPos, pose) {
    const images = state.characterImages;
    if (!images) return;

    const cfg = this.bodyPartsConfig;
    const s = this.bodyScale;
    const cosO = Math.cos(orientation);
    const sinO = Math.sin(orientation);

    this.drawLimb(images.leftboot, pose.leftBootX, pose.leftBootY, cfg.leftBootJointX, cfg.leftBootJointY, pose.leftBootAngle, orientation, originPos, cosO, sinO);
    this.drawLimb(images.leftarm, pose.leftArmX, pose.leftArmY, cfg.leftArmJointX, cfg.leftArmJointY, pose.leftArmAngle, orientation, originPos, cosO, sinO);

    if (images.body) {
      const [bodyW, bodyH] = images.body.getDimensions();
      love.graphics.push();
      love.graphics.translate(originPos.x, originPos.y);
      love.graphics.rotate(orientation);
      love.graphics.draw(images.body, -bodyW * s / 2, pose.bodyY * s - bodyH * s / 2, 0, s, s);
      love.graphics.pop();
    }

    this.drawLimb(images.rightboot, pose.rightBootX, pose.rightBootY, cfg.rightBootJointX, cfg.rightBootJointY, pose.rightBootAngle, orientation, originPos, cosO, sinO);
    this.drawLimb(images.rightarm, pose.rightArmX, pose.rightArmY, cfg.rightArmJointX, cfg.rightArmJointY, pose.rightArmAngle, orientation, originPos, cosO, sinO);

    if (images.head) {
      const [headW, headH] = images.head.getDimensions();
      const headWX = -pose.headY * sinO;
      const headWY = pose.headY * cosO;
      const pivotY = headH * s * this.headPivotFraction;
      love.graphics.push();
      love.graphics.translate(originPos.x + headWX * s, originPos.y + headWY * s);
      love.graphics.rotate(orientation + pose.headAngle);
      love.graphics.draw(images.head, -headW * s / 2, -pivotY, 0, s, s);
      love.graphics.pop();
    }
  }

  // Picks and blends the right pair of keyframes for whichever direction
  // (this.morphState) and how far into it (this.morphElapsed) the
  // transition is, then draws that pose with the same facing-direction
  // flip wrapper draw() itself uses.
  drawBallMorphTransition(orientation) {
    const planet = (this.onSurface && this.currentPlanet) || this.lastInfluencePlanet;
    const outwardDir = this.visualDownDirection(planet).multiply(-1);
    const visualPos = this.pos.clone().add(outwardDir.multiply(this.groundOffset * this.bodyScale));
    const dirSign = this.facingDirection < 0 ? -1 : 1;

    const segT = Math.min(1, this.morphElapsed / BALL_MORPH_SEGMENT_TICKS);
    let pose;
    if (this.morphState === 'toBall') {
      if (this.morphElapsed < BALL_MORPH_SEGMENT_TICKS) {
        pose = lerpBallMorphPose(BALL_MORPH_STANDING_POSE, BALL_MORPH_FRAME_1, segT);
      } else {
        const t2 = Math.min(1, (this.morphElapsed - BALL_MORPH_SEGMENT_TICKS) / BALL_MORPH_SEGMENT_TICKS);
        pose = lerpBallMorphPose(BALL_MORPH_FRAME_1, BALL_MORPH_FRAME_2, t2);
      }
    } else { // "toHuman" — same two keyframes, played in reverse
      if (this.morphElapsed < BALL_MORPH_SEGMENT_TICKS) {
        pose = lerpBallMorphPose(BALL_MORPH_FRAME_2, BALL_MORPH_FRAME_1, segT);
      } else {
        const t2 = Math.min(1, (this.morphElapsed - BALL_MORPH_SEGMENT_TICKS) / BALL_MORPH_SEGMENT_TICKS);
        pose = lerpBallMorphPose(BALL_MORPH_FRAME_1, BALL_MORPH_STANDING_POSE, t2);
      }
    }

    love.graphics.push();
    love.graphics.translate(this.pos.x, this.pos.y);
    love.graphics.rotate(orientation);
    love.graphics.scale(dirSign, 1);
    love.graphics.rotate(-orientation);
    love.graphics.translate(-this.pos.x, -this.pos.y);

    this.drawBallMorphPose(orientation, visualPos, pose);

    love.graphics.pop();
  }

  // Whether the blaster's in use right now, or was a moment ago: spraying
  // water, holding fire, or a fireball/portal shot within the last
  // BLASTER_IN_USE_LINGER seconds. Its arm then stays aimed (see
  // drawFullBody) instead of drifting into the idle sway.
  isUsingBlaster() {
    if (WaterSystem.isSpraying()) return true;
    const mode = state.weaponMode ?? 'fireball';
    if (state.gamepadFireHeld || (state.mouseDown && (mode === 'fireball' || mode === 'ice'))) return true;
    const now = love.timer.getTime();
    if (this.lastShotTime != null && now - this.lastShotTime < BLASTER_IN_USE_LINGER) return true;
    if (PortalGun.lastShotTime != null && now - PortalGun.lastShotTime < BLASTER_IN_USE_LINGER) return true;
    return false;
  }

  drawFullBody(orientation, originPos) {
    const images = state.characterImages;
    if (!images) return;

    if (this.isWallSliding) {
      this.drawWallSlidePose(orientation, originPos);
      return;
    }

    // Mid ground pound: its own fixed pose (GROUND_POUND_POSE) from the
    // moment it starts until he lands, held through the impact beat after
    // landing so he's seen to actually HIT the ground in it. Drawn lower
    // than his standing self by getGroundPoundSeatDrop (in this pose his
    // feet are up in front of him), eased in over the first
    // GROUND_POUND_SETTLE_TICKS so he sinks into the pose.
    const poundAirborne = this.isGroundPounding && !this.onSurface;
    const poundLanded = this.onSurface && (this.groundPoundImpactTimer > 0 || this.wasGroundPounding);
    if (poundAirborne || poundLanded) {
      const settle = poundLanded ? 1 : Math.min(1, this.groundPoundPoseTime / GROUND_POUND_SETTLE_TICKS);
      const drop = this.getGroundPoundSeatDrop() * settle;
      const downAngle = orientation + Math.PI / 2;
      const seatedOrigin = new Vector2(originPos.x + Math.cos(downAngle) * drop, originPos.y + Math.sin(downAngle) * drop);
      this.drawBallMorphPose(orientation, seatedOrigin, GROUND_POUND_POSE);
      return;
    }

    const cfg = this.bodyPartsConfig;
    const s = this.bodyScale;
    const cosO = Math.cos(orientation);
    const sinO = Math.sin(orientation);

    const walkAngle = (this.onSurface && this.isWalking) ? (Math.sin(this.walkTime) * 0.6) : 0;
    const walkBobT = (this.onSurface && this.isWalking) ? (Math.sin(this.walkTime) ** 2) : 0;
    const walkBobAmount = walkBobT * this.walkBobStrength;
    originPos = new Vector2(
      originPos.x + -sinO * walkBobAmount,
      originPos.y + cosO * walkBobAmount,
    );

    const dirSign = this.facingDirection < 0 ? -1 : 1;

    let leftBootAngle = walkAngle;
    let rightBootAngle = -walkAngle;
    let leftArmAngle, rightArmAngle;
    let rightArmFlipped = false;

    // Held rigidly at attention (both arms straight down, no aim/sway/
    // head-tilt) while standing behind the shelter's still-closed/opening
    // door — the blaster arm's own aim pose would poke out past the
    // door's clipped frame otherwise (see SpaceShelter.js's drawDoor).
    // poseBlend (1 = fully forced, 0 = fully normal) eases this back to
    // the normal pose over INTRO_POSE_TRANSITION_SECONDS starting the
    // moment the door reaches fully open.
    let poseBlend = 0;
    if (state.titleScreen) {
      // Out in the belt on autopilot (see TitleScreen.js) — ordinary pose.
      poseBlend = 0;
    } else if (state.spaceShelter && !state.spaceShelter.playerInFront) {
      poseBlend = 1;
    } else if (this.introPoseBlendStart != null) {
      const elapsed = love.timer.getTime() - this.introPoseBlendStart;
      poseBlend = Math.max(0, 1 - elapsed / INTRO_POSE_TRANSITION_SECONDS);
    }

    const aimAngle = this.computeLeftArmAimAngle(orientation, dirSign, originPos);
    if (this.mouseIdle && !this.pullTarget && !this.isUsingBlaster()) {
      const swayAngle = (this.onSurface && this.isWalking)
        ? (walkAngle * this.armSwingScale)
        : (Math.sin(love.timer.getTime() * 1.5) * 0.15);
      leftArmAngle = swayAngle;
      rightArmAngle = swayAngle;
    } else {
      leftArmAngle = aimAngle;
      rightArmAngle = walkAngle * this.armSwingScale;
    }

    if (poseBlend > 0) {
      // The right arm's rest art already hangs down at 0 local rotation,
      // but the left (blaster) arm's local 0 points it straight out in
      // front — rotate it to world-angle pi/2 (straight down), nudged 5
      // degrees counterclockwise, via the same world-to-local conversion
      // every other world-angle-driven pose here uses.
      const blasterRestWorldAngle = Math.PI / 2 - (5 * Math.PI / 180);
      const forcedLeftArmAngle = this.worldAngleToLocalRotation(blasterRestWorldAngle, orientation, dirSign);
      leftArmAngle += (forcedLeftArmAngle - leftArmAngle) * poseBlend;
      rightArmAngle *= (1 - poseBlend);
    }

    if (!this.onSurface && poseBlend <= 0) {
      leftBootAngle = -0.7;
      rightBootAngle = 0.7;
      const raisedWorldAngle = -Math.PI / 2 - (Math.PI * 0.75) * dirSign;
      rightArmAngle = this.worldAngleToLocalRotation(raisedWorldAngle, orientation, dirSign);
      rightArmFlipped = true;
    }

    // Swim stroke: a brief one-shot sweep overriding whatever pose came
    // before it. Both arms sweep the SAME WORLD angle together, from
    // horizontal-out to straight overhead and back — converted to local
    // rotation for EACH arm separately (their local-angle conventions
    // differ), so they look like a matched pair.
    if (this.swimStrokeTimer > 0) {
      const progress = 1 - (this.swimStrokeTimer / this.swimStrokeDuration);
      const swingT = Math.sin(progress * Math.PI); // 0 -> 1 -> 0 across the stroke
      const overheadWorldAngle = -Math.PI / 2;
      const outWorldAngle = dirSign > 0 ? 0 : Math.PI;
      const strokeWorldAngle = outWorldAngle + (overheadWorldAngle - outWorldAngle) * swingT;
      leftArmAngle = this.worldAngleToLocalRotation(strokeWorldAngle, orientation, dirSign);
      rightArmAngle = this.worldAngleToLocalRotation(strokeWorldAngle, orientation, dirSign);
      rightArmFlipped = false;
    }

    this.drawLimb(images.leftboot, cfg.leftBootX, cfg.leftBootY, cfg.leftBootJointX, cfg.leftBootJointY, leftBootAngle, orientation, originPos, cosO, sinO);
    this.drawLimb(images.leftarm, cfg.leftArmX, cfg.leftArmY, cfg.leftArmJointX, cfg.leftArmJointY, leftArmAngle, orientation, originPos, cosO, sinO);

    if (images.body) {
      const [bodyW, bodyH] = images.body.getDimensions();
      love.graphics.push();
      love.graphics.translate(originPos.x, originPos.y);
      love.graphics.rotate(orientation);
      love.graphics.draw(images.body, -bodyW * s / 2, cfg.bodyY * s - bodyH * s / 2, 0, s, s);
      love.graphics.pop();
    }

    this.drawLimb(images.rightboot, cfg.rightBootX, cfg.rightBootY, cfg.rightBootJointX, cfg.rightBootJointY, rightBootAngle, orientation, originPos, cosO, sinO);
    this.drawLimb(images.rightarm, cfg.rightArmX, cfg.rightArmY, cfg.rightArmJointX, cfg.rightArmJointY, rightArmAngle, orientation, originPos, cosO, sinO, rightArmFlipped);

    if (images.head) {
      const [headW, headH] = images.head.getDimensions();
      const headWX = -cfg.headY * sinO;
      const headWY = cfg.headY * cosO;
      const headBob = (poseBlend <= 0 && this.onSurface && this.isWalking) ? (Math.sin(this.walkTime * 2) * 0.03) : 0;
      const normalHeadLookTilt = this.mouseIdle ? 0 : this.computeHeadLookTilt(orientation, dirSign);
      const headLookTilt = normalHeadLookTilt * (1 - poseBlend);
      const headTilt = headBob + headLookTilt;
      const pivotY = headH * s * this.headPivotFraction;

      love.graphics.push();
      love.graphics.translate(originPos.x + headWX * s, originPos.y + headWY * s);
      love.graphics.rotate(orientation + headTilt);
      love.graphics.draw(images.head, -headW * s / 2, -pivotY, 0, s, s);
      love.graphics.pop();
    }
  }

  // White morph-ball body split by three spokes into equal wedges —
  // spoke positions are offset by this.ballRollAngle (see move()'s own
  // rolling-without-slipping update), so they visibly sweep around as he
  // travels. orientation keeps the pattern aligned with gravity.
  drawBallMode(orientation) {
    const r = this.radius;

    love.graphics.push();
    love.graphics.translate(this.pos.x, this.pos.y);
    love.graphics.rotate(orientation + this.ballRollAngle);

    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.circle('fill', 0, 0, r);

    love.graphics.setColor(BALL_LINE_COLOR);
    const prevLineWidth = love.graphics.getLineWidth();
    love.graphics.setLineWidth(Math.max(1, r * 0.12 - 1));
    for (let i = 0; i <= 2; i++) {
      const a = i * (Math.PI * 2 / 3);
      love.graphics.line(0, 0, Math.cos(a) * r, Math.sin(a) * r);
    }
    love.graphics.circle('line', 0, 0, r);

    // Small center "eye" — same section-line gray for its own outline.
    const centerR = r * BALL_CENTER_RADIUS_FRACTION;
    love.graphics.setColor(BALL_CENTER_FILL_COLOR);
    love.graphics.circle('fill', 0, 0, centerR);
    love.graphics.setColor(BALL_LINE_COLOR);
    love.graphics.circle('line', 0, 0, centerR);

    love.graphics.setLineWidth(prevLineWidth);
    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.pop();

    this.drawBallShading();
  }

  // The ball's own share of the sun shading (see BODY_SHADING). The ball
  // is plain drawn shapes, with no image for the rig's shader to read,
  // so it's shaded the direct way: the same shadow and highlight, as two
  // soft discs laid over it. Drawn outside the ball's own roll rotation —
  // the markings spin, the light doesn't.
  drawBallShading() {
    if (!HERO_SHADING_ENABLED) return;
    const toSunX = (state.sceneWidth ?? 0) / 2 - this.pos.x;
    const toSunY = (state.sceneHeight ?? 0) / 2 - this.pos.y;
    if (toSunX === 0 && toSunY === 0) return;
    const sunAngle = Math.atan2(toSunY, toSunX);

    const [shadow, highlight] = getBallShadingMeshes();
    const r = this.radius;
    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.draw(shadow, this.pos.x, this.pos.y, sunAngle, r, r);
    love.graphics.setBlendMode('add', 'alphamultiply');
    love.graphics.draw(highlight, this.pos.x, this.pos.y, sunAngle, r, r);
    love.graphics.setBlendMode('alpha');
    love.graphics.setColor(1, 1, 1, 1);
  }

  // Where he is in a Beam.js teleport's transporter shimmer (see
  // js/effects/TransporterEffect.js). Returns [bodyAlpha, glow, sparkle,
  // color]: dematerializing on the way out, the same curve backward on
  // arrival; color is the beam's own washed toward white. [1, 0, 0, null]
  // when he isn't teleporting.
  getTransporterState() {
    if (!this.teleportState) return [1, 0, 0, null];
    const total = this.teleportState === 'out' ? TELEPORT_OUT_TICKS : TELEPORT_IN_TICKS;
    let t = total > 0 ? Math.max(0, Math.min(1, (total - this.teleportTimer) / total)) : 1;
    if (this.teleportState === 'in') t = 1 - t;
    const [bodyAlpha, glow, sparkle] = TransporterEffect.curves(t);
    const beam = this.teleportState === 'out' ? this.teleportOrigin : this.teleportDestination;
    const c = beam?.color ?? [0.6, 0.8, 1];
    const color = [c[0] + (1 - c[0]) * 0.5, c[1] + (1 - c[1]) * 0.5, c[2] + (1 - c[2]) * 0.5];
    return [bodyAlpha, glow, sparkle, color];
  }

  // Any Beam.js teleporter currently close enough to interact with, plus
  // how close, as a 0..1 proximity fraction (1 right at the beam's own
  // planted base, fading linearly to 0 at its own interactRadius).
  // Returns [beam, proximity] — [null, 0] when none is in range.
  getNearbyBeam() {
    if (!state.beams) return [null, 0];
    let best = null, bestProximity = 0;
    for (const beam of state.beams) {
      const dx = this.pos.x - beam.pos.x, dy = this.pos.y - beam.pos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= beam.interactRadius) {
        const proximity = 1 - dist / beam.interactRadius;
        if (!best || proximity > bestProximity) {
          best = beam;
          bestProximity = proximity;
        }
      }
    }
    return [best, bestProximity];
  }

  draw() {
    // Gone for the death pause — only his death burst is on screen. And
    // not seen while he's inside a cannon's barrel.
    if (this.isDying || this.inCannon) return;

    // Mid-teleport, he shimmers out (or back in) — see getTransporterState.
    const [bodyAlpha, energize, sparkle, transporterColor] = this.getTransporterState();

    // Outer glow hugging his own real silhouette (SilhouetteGlow.js)
    // whenever he's close enough to a beam to interact with it, tinted to
    // match THAT beam's own color, fading with distance and with his body
    // as he dematerializes, brightening a little as he's energized.
    const [nearbyBeam, proximity] = this.getNearbyBeam();
    if (nearbyBeam) {
      SilhouetteGlow.draw(
        this.pos.x, this.pos.y,
        this.radius * 4, 14,
        nearbyBeam.color, 0.8 * proximity * bodyAlpha * (1 + energize * 0.6),
        () => this.drawRig());
    }

    // Post-arrival invincibility flicker — a hard on/off blink (skip
    // drawing him entirely on the "off" beat): drawRig sets its own
    // opaque colors, so an alpha around the whole call would just get
    // overwritten. Real-time rate, not slowed by V.A.T.S. Not while he's
    // still rematerializing — the shimmer is the arrival cue.
    if (this.isInvincible() && this.teleportState !== 'in') {
      const phase = Math.floor(love.timer.getTime() / INVINCIBLE_FLICKER_INTERVAL) % 2;
      if (phase !== 0) return;
    }

    // Sun shading on every piece of the rig — see getBodyShadingShader.
    const drawShaded = () => {
      const shadingShader = this.applyBodyShading();
      this.drawRig();
      if (shadingShader) love.graphics.setShader();
    };

    if (bodyAlpha >= 1 && energize <= 0) drawShaded();
    else TransporterEffect.drawFaded(this.pos.x, this.pos.y, this.radius * 4, bodyAlpha, energize, transporterColor, drawShaded);

    // The transporter sparkles, in a column covering him from boots to helmet.
    if (sparkle > 0) {
      const planet = (this.onSurface && this.currentPlanet) || this.lastInfluencePlanet;
      const down = this.visualDownDirection(planet);
      const upX = -down.x, upY = -down.y;
      const r = this.radius;
      const headTop = this.headReach ?? r * 2.5;
      const height = headTop + r;
      const mid = (headTop - r) / 2;
      TransporterEffect.drawSparkles(
        this.pos.x + upX * mid, this.pos.y + upY * mid, upX, upY,
        height * 1.15, r * 2.4, sparkle, transporterColor, love.timer.getTime());
    }
  }

  // Turns the body-shading shader on for whatever's drawn next, pointed
  // at wherever the sun is from him right now. Returns the shader, or
  // null if shading is switched off.
  applyBodyShading() {
    if (!HERO_SHADING_ENABLED) return null;
    const toSunX = (state.sceneWidth ?? 0) / 2 - this.pos.x;
    const toSunY = (state.sceneHeight ?? 0) / 2 - this.pos.y;
    const dist = Math.sqrt(toSunX * toSunX + toSunY * toSunY);
    if (dist < 1) return null;

    const shader = getBodyShadingShader();
    shader.send('lightDir', [toSunX / dist, toSunY / dist]);
    love.graphics.setShader(shader);
    return shader;
  }

  // Everything that actually draws him (draw() is a thin wrapper that
  // applies the teleport pulse and shading around this).
  drawRig() {
    const planet = (this.onSurface && this.currentPlanet) || this.lastInfluencePlanet;
    const downDir = this.visualDownDirection(planet);
    const downAngle = Math.atan2(downDir.y, downDir.x);
    const orientation = downAngle - Math.PI / 2;

    if (this.morphState) {
      this.drawBallMorphTransition(orientation);
      return;
    }

    if (this.isBall) {
      this.drawBallMode(orientation);
      return;
    }

    const outwardDir = downDir.multiply(-1);
    const visualPos = this.pos.clone().add(outwardDir.multiply(this.groundOffset * this.bodyScale));

    const dirSign = this.facingDirection < 0 ? -1 : 1;

    love.graphics.push();
    love.graphics.translate(this.pos.x, this.pos.y);
    love.graphics.rotate(orientation);
    love.graphics.scale(dirSign, 1);
    love.graphics.rotate(-orientation);
    love.graphics.translate(-this.pos.x, -this.pos.y);

    this.drawFullBody(orientation, visualPos);

    love.graphics.pop();
  }
}

// ------------------------------------------------------------------
// Pose tables and shading meshes (module-level, used by the methods above)
// ------------------------------------------------------------------

// Wall-slide pose, authored with paperdoll.html against the actual
// bodyPartsConfig/drawLimb numbers. Authored facing RIGHT with the wall
// on the left — facing AWAY from the wall, back braced against it —
// which is what update() forces facingDirection to do for the whole
// slide. jointX/jointY are unchanged from bodyPartsConfig.
const WALL_SLIDE_POSE = {
  leftBootX: 41.64, leftBootY: 313.37, leftBootAngle: 34 * Math.PI / 180,
  leftArmAngle: 49 * Math.PI / 180,
  rightBootX: -138.98, rightBootY: 204.81, rightBootAngle: 0,
  rightArmAngle: 166 * Math.PI / 180,
  headY: -125.87, headAngle: 13 * Math.PI / 180,
};

// Neutral standing pose — what the curl-in animation blends FROM (and
// the stand-back-up animation blends BACK TO).
const BALL_MORPH_STANDING_POSE = {
  leftBootX: 111, leftBootY: 241, leftBootAngle: 0,
  leftArmX: 136, leftArmY: 9, leftArmAngle: 0,
  bodyY: 115,
  rightBootX: -142, rightBootY: 241, rightBootAngle: 0,
  rightArmX: -186, rightArmY: -14, rightArmAngle: 0,
  headY: -150, headAngle: 0,
};

// Curl-in keyframes, authored with paperdoll.html. Played STANDING ->
// FRAME_1 -> FRAME_2 -> (cut to the actual ball) when curling in, and
// the reverse when standing back up.
const BALL_MORPH_FRAME_1 = {
  leftBootX: 111, leftBootY: 241, leftBootAngle: 0,
  leftArmX: 143.01, leftArmY: 131.67, leftArmAngle: 40 * Math.PI / 180,
  bodyY: 206.13,
  rightBootX: -142, rightBootY: 241, rightBootAngle: 0,
  rightArmX: -182.5, rightArmY: 98.16, rightArmAngle: -31 * Math.PI / 180,
  headY: 18.24, headAngle: 0,
};
const BALL_MORPH_FRAME_2 = {
  leftBootX: 111, leftBootY: 195.44, leftBootAngle: 32 * Math.PI / 180,
  leftArmX: -130.37, leftArmY: 163.22, leftArmAngle: 40 * Math.PI / 180,
  bodyY: 328.8,
  rightBootX: -134.99, rightBootY: 167.4, rightBootAngle: -9 * Math.PI / 180,
  rightArmX: -143.95, rightArmY: 213.82, rightArmAngle: -43 * Math.PI / 180,
  headY: 312.65, headAngle: 25 * Math.PI / 180,
};

// Ground-pound pose, authored with paperdoll.html: both boots swung up
// and forward, blaster arm tucked slightly back, right arm thrown up
// overhead. Drawn by drawBallMorphPose. A fixed pose, cut to directly.
const GROUND_POUND_POSE = {
  leftBootX: 111, leftBootY: 241, leftBootAngle: -100 * Math.PI / 180,
  leftArmX: 136, leftArmY: 9, leftArmAngle: -20 * Math.PI / 180,
  bodyY: 115,
  rightBootX: -142, rightBootY: 241, rightBootAngle: -109 * Math.PI / 180,
  rightArmX: -186, rightArmY: -14, rightArmAngle: 117 * Math.PI / 180,
  headY: -150, headAngle: 0,
};

let groundPoundSeatDrop = null;

function lerpNum(a, b, t) { return a + (b - a) * t; }

// Blends every field of two ball-morph pose tables.
function lerpBallMorphPose(a, b, t) {
  const out = {};
  for (const key of Object.keys(a)) out[key] = lerpNum(a[key], b[key], t);
  return out;
}

const BALL_LINE_COLOR = [0x9C / 255, 0x9B / 255, 0x9B / 255]; // #9C9B9B — outline + section-spoke color
const BALL_CENTER_FILL_COLOR = [0x6A / 255, 0xE7 / 255, 0xEB / 255]; // #6AE7EB
const BALL_CENTER_RADIUS_FRACTION = 1 / 3;

let ballShadowMesh = null, ballHighlightMesh = null;
function getBallShadingMeshes() {
  if (ballShadowMesh) return [ballShadowMesh, ballHighlightMesh];
  const s = BODY_SHADING;
  const segments = 48, rings = 10;

  // Both are unit discs built for a light shining from +x; drawing them
  // rotated to the sun's actual direction puts the light where it is.
  const disc = (alphaAt, r, g, b) => {
    const vertices = [];
    const vertex = (angle, t) => {
      const x = Math.cos(angle) * t, y = Math.sin(angle) * t;
      return [x, y, 0, 0, r, g, b, alphaAt(x, y)];
    };
    for (let ring = 1; ring <= rings; ring++) {
      const t0 = (ring - 1) / rings, t1 = ring / rings;
      for (let i = 0; i < segments; i++) {
        const a0 = (i / segments) * Math.PI * 2, a1 = ((i + 1) / segments) * Math.PI * 2;
        vertices.push(vertex(a0, t0), vertex(a0, t1), vertex(a1, t1));
        vertices.push(vertex(a0, t0), vertex(a1, t1), vertex(a1, t0));
      }
    }
    return love.graphics.newMesh(vertices, 'triangles', 'static');
  };

  // How much darker each point is than its own color — the same formula
  // as the shader, written as an amount of black to lay on top.
  ballShadowMesh = disc((x, y) => {
    const dx = x - s.shadowOffset, dy = y;
    const lit = Math.max(0, Math.min(1, 1 - Math.sqrt(dx * dx + dy * dy) / s.shadowReach));
    const shade = (1 + (lit - 1) * s.strength) * (1 - s.overallDarken * s.strength);
    return 1 - shade;
  }, 0, 0, 0);

  ballHighlightMesh = disc((x, y) => {
    const dx = x - s.highlightOffset, dy = y;
    const h = Math.max(0, Math.min(1, 1 - Math.sqrt(dx * dx + dy * dy) / s.highlightSize));
    return h * h * s.highlightAlpha;
  }, 1, 0.98, 0.92);

  return [ballShadowMesh, ballHighlightMesh];
}

export default Rendering;
