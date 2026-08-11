// js/entities/Player.js
import { Entity } from './Entity.js';
import { state } from '../state.js';
import {
  GRAVITY_STRENGTH,
  GROUND_POUND_GRAV_MULTIPLIER,
  GROUND_POUND_PUSH_STRENGTH,
  JUMP_STRENGTH,
  MOVE_SPEED,
  PLAYER_LINEAR_SPEED,
  PLAYER_RADIUS,
  SURFACE_TOLERANCE,
  DRAG
} from '../constants.js';
import { Vector2 } from '../vector2.js';
import {
  createDeathParticles,
  createParticles
} from '../utils.js';
import { Particle } from './Particle.js';
import { Fireball } from './world/Fireball.js';
import { findNearestOccluder } from '../systems/Raycast.js';
import { isValidLockTarget, selectNextLockTarget, selectPreviousLockTarget } from '../systems/TargetLock.js';

export class Player extends Entity {
  constructor(x, y) {
    super();
    this.pos = new Vector2(x, y);
    this.vel = new Vector2(0, 0);
    this.radius = PLAYER_RADIUS;
    this.onSurface = false;
    this.onGround = false;
    this.currentPlanet = null;
    this.currentInterior = null;
    this.lastInfluencePlanet = null;
    this.angle = 0;
    // Rounded-rect equivalent of `angle` above — an arc-length position
    // along the planet's perimeter (see RoundedRectPlanetoid), used only
    // while this.currentPlanet.isRoundedRect. Set on landing by
    // CollisionSystem, advanced by move() while walking.
    this.surfaceArcPos = 0;
    this.mouthAngle = 0;
    this.facingDirection = 1;
    this.isGroundPounding = false;
    this.mode = "space";
    this.mazeCol = 14;
    this.mazeRow = 15;
    this.mazeDir = new Vector2(1, 0);
    this.platformPos = null;
    this.platformVel = new Vector2(0,0);
    this.lastMoveTime = 0;
    this.isTeleporting = false;
    this.teleportTargetMode = null; // "maze", "platform", or "space"
    this.teleportStartTime = 0;
    this.teleportDuration = 900;
    this.teleportScale = 1;
    this.teleportGlow = 0;
    this.isDying = false;
    this.deathStartTime = 0;
    this.deathDuration = 1200;
    this.deathScale = 1;
    this.deathRotation = 0;
    this.deathAlpha = 1;

    // ----------------------------
    // BOOT SPRITE (used for platform/death — small stylized modes)
    // ----------------------------
    this.bootNaturalWidth = 232;
    this.bootNaturalHeight = 312;
    this.bootScale = 0.1;
    // Final on-screen boot size is determined by the pre-scaled canvas
    // built in initScaledAssets() (see scaledBootCanvas), not by these
    // two natural-size fields directly — they're kept only as a record
    // of the source PNG dimensions.

    // ----------------------------
    // FULL BODY SPRITE (used for the main planet-surface/space mode AND
    // the maze mode)
    // Offsets/joints are in each image's native pixel space — ported
    // directly from the standalone astronaut prototype, since those
    // values are what make the limbs line up anatomically.
    // ----------------------------
    this.bodyScale = 0.1;
    this.bodyPartsConfig = {
      bodyY: 115, headY: -150,//-400,
      leftArmX: 136, leftArmY: 9, leftArmJointX: 73, leftArmJointY: 199,
      rightArmX: -186, rightArmY: -14, rightArmJointX: 119, rightArmJointY: 40,
      leftBootX: 111, leftBootY: 241, leftBootJointX: 83, leftBootJointY: 15,
      rightBootX: -142, rightBootY: 241, rightBootJointX: 77, rightBootJointY: 15
    };
    this.walkTime = 0;
    this.isWalking = false;

    // How many pixels of actual surface travel make up one full leg
    // swing cycle. The walk animation now advances based on real
    // distance walked (see move()), not a flat per-frame amount — so
    // legs/arms pendulate faster or slower in lockstep with how much
    // ground he's actually covering. Lower = faster-looking stride.
    this.strideLength = 90;
    // Vertical walk bob — the body's effective height is lowest when
    // both legs are angled apart (scissored mid-stride) and highest
    // when either leg passes through vertical beneath it, same as a
    // real walk cycle. See drawFullBody for how this gets applied.
    this.walkBobStrength = 3;
    // Tracks the walk-bob's own value frame to frame, so spawnWalkDust
    // can detect the exact moment it crosses back above its "just
    // planted" threshold, rather than sampling on a flat per-frame
    // chance unrelated to actual footsteps.
    this.lastWalkBobT = 0;

    // Arm swing amplitude relative to the leg swing amplitude (0.6,
    // hardcoded below in drawFullBody). The right arm moves opposite
    // its same-side leg, like a natural walking gait. (The left arm no
    // longer uses this — it's dedicated to aiming, see below.)
    this.armSwingScale = 0.5;

    // How far (in the same raw joint-space units as bodyPartsConfig,
    // multiplied by bodyScale) to shift the whole rig outward from the
    // planet — away from this.pos — when drawing, so the boot soles
    // land on the physical surface instead of the belt/origin doing so.
    // Increase to lift the astronaut further off the surface, decrease
    // to sink him back in. Tune this to taste once you see it in-game.
    this.groundOffset = 250;

    // How far past straight forward the blaster (left) arm is allowed
    // to swing — up to and slightly past directly up/down, but never
    // all the way around to point behind the character. 90° = exactly
    // vertical; the extra amount is the "5 degrees past vertical"
    // allowance.
    this.maxAimFromForward = (90 + 5) * Math.PI / 180;

    // Cached each frame by computeLeftArmAimAngle() while in "space"
    // mode: the shoulder joint's world position and the actual
    // (clamped) world angle the arm is currently pointing. shootFireball()
    // reads these directly so shots always originate exactly where the
    // gun barrel is visually aiming. aimRelativeAngle (the signed angle
    // from "forward" to the clamped aim target) is what
    // computeHeadLookTilt() reuses so the head can do a partial version
    // of the same look direction.
    this.aimShoulderPos = null;
    this.aimWorldAngle = 0;
    this.aimRelativeAngle = 0;
    // this.pos AS OF the moment aimShoulderPos above was computed —
    // recorded so shootFireball() can tell how far this.pos has moved
    // since (computeLeftArmAimAngle runs during drawing, which happens
    // AFTER shootFireball() within the same frame — see game.js's
    // gameLoop — so this is always at least one frame behind by the
    // time a shot actually fires). Re-anchoring the cached shoulder
    // offset to the CURRENT this.pos at firing time, rather than firing
    // from wherever the shoulder was a frame ago, matters most while
    // pulling: this.pos accelerates continuously during a pull, and the
    // early part of one often still curves in from residual launch
    // velocity rather than moving in a straight line at the target, so
    // the one-frame-old angle can be meaningfully wrong — enough to
    // miss a small target even though everything LOOKED lined up.
    this.aimAnchorPos = null;

    // How much of the arm's aim angle the head mimics when looking
    // up/down at the aim target — 1.0 would match the arm exactly;
    // lower values read as a more natural glance rather than a full
    // swing. Tune to taste.
    this.headLookScale = 0.6;

    // Where within the head image, vertically, it pivots from — 0 = top
    // of the image, 1 = bottom, 0.5 = dead center (the previous, only,
    // behavior). A real head-tilt hinges from the neck rather than the
    // middle, so once you're happy with headLookScale, try nudging this
    // toward wherever the neck actually sits in head.png (probably
    // somewhere in the 0.7–0.95 range). You'll likely want to re-check
    // bodyPartsConfig.headY (how far the head sits from the body) at
    // the same time, since changing the pivot shifts where the image
    // lands relative to that anchor point.
    this.headPivotFraction = 0.9;

    // Distance from the shoulder joint to the muzzle tip, in the same
    // raw joint-space units as bodyPartsConfig (multiplied by
    // bodyScale). This is a guess — tune it once you see where
    // fireballs actually spawn relative to the leftarm.png artwork.
    this.blasterMuzzleLength = 300;

    // Fine-tuning correction (radians), applied only at firing time —
    // to both the muzzle position and the fired direction — in case
    // the actual barrel opening in leftarm.png isn't perfectly aligned
    // with the arm's computed aim direction. Does NOT affect the arm's
    // visual rotation, only where/how the fireball launches. Nudge the
    // sign/magnitude until shots visually leave from the barrel tip.
    this.blasterAngleOffset = -5 * Math.PI / 180;

    // Minimum time (ms) between shots while firing is held.
    this.fireCooldown = 150;

    // How strongly current left/right input leans a jump on
    // SkyDomePlanetoid specifically (see getOutwardLaunchDirection) —
    // weighted against a vertical component of 1.0 before
    // normalizing, so this is roughly "how sideways" versus "how up"
    // the jump reads. 0 = straight up regardless of input (old
    // behavior); higher = more of a running-jump arc.
    this.jumpHorizontalCarry = 0.6;
    this.lastShotTime = 0;

    // How much faster walking is while state.gamepadRunHeld is true
    // (Square button) — multiplies PLAYER_LINEAR_SPEED directly in
    // move()'s walking branches, so running speeds up everything that
    // already scales off that value (footstep timing, dust frequency)
    // for free, with no separate handling needed.
    this.runSpeedMultiplier = 1.8;

    // How much higher a jump launches while running (Square held) —
    // a real, well-established platformer convention (a running jump
    // going higher/farther than a standing one), and physically
    // sensible too: momentum carrying into the jump. Deliberately more
    // modest than runSpeedMultiplier above — jump height changes read
    // as more dramatic per unit of multiplier than walking speed does,
    // so a smaller boost here still feels clearly noticeable without
    // tipping into "broken."
    this.runJumpMultiplier = 1.3;

    // Continuous mid-air horizontal steering (SkyDomePlanetoid gravity
    // only — see move()'s airborne branch for why): per-frame
    // acceleration while holding left/right, and a cap on how fast
    // holding a direction can build vel.x up to. Deliberately modest —
    // this is meant to read as "can nudge his arc a bit," not full
    // in-air control comparable to ground walking.
    this.airControlAccel = 0.3;
    this.airControlMaxSpeed = 4;

    // Scales down the horizontal velocity carried into a fall when
    // walking off a SkyDomePlanetoid/JumpPlatform edge (see move()'s
    // isSkyDome branch) — full PLAYER_LINEAR_SPEED read as an
    // unnaturally strong "launch off a ramp," since it's roughly 14x
    // GRAVITY_STRENGTH's own per-frame pull, so gravity took many
    // frames to visually catch up and dominate the trajectory. A
    // fraction still carries real, visible momentum (stepping off
    // reads as a natural fall with a bit of forward drift, not an
    // abrupt stop) without that launched-off-a-ramp look.
    this.edgeFallCarryFraction = 0.35;

    // ----------------------------
    // PULL TARGET (right-click "pull star")
    // ----------------------------
    // this.pullTarget is a reference to whichever planetoid the player
    // right-clicked on (null if not currently pulling). While set, and
    // only in "space" mode, gameLoop applies a constant acceleration
    // toward it instead of normal gravity (see applyPullForce below) —
    // suspending gravity while pulling, rather than adding the two
    // together, keeps the pull feeling like a deliberate, authoritative
    // move rather than something fighting other nearby planets' pull.
    // Cleared automatically on release, on landing, or if the target
    // gets culled while out of range — never needs manual cleanup
    // elsewhere.
    this.pullTarget = null;
    // ----------------------------
    // this.lockedTarget (gamepad R1 "hard lock") is a reference to
    // whichever planetoid/asteroid/goomba is currently locked on, or
    // null. While set, it takes ABSOLUTE priority over every other aim
    // source (even pullTarget) in computeLeftArmAimAngle below — the
    // whole point is that the blaster persists pointing at it
    // regardless of stick input, mouse position, or anything else.
    // Validity (still exists, still on screen) is re-checked every
    // frame in computeLeftArmAimAngle itself, which clears this the
    // moment either check fails, rather than needing a separate
    // per-frame update pass. See TargetLock.js for the actual
    // candidate-gathering/selection logic, and tryLockTargetNext/
    // tryLockTargetPrevious/clearLockTarget below for how this gets
    // set/cleared.
    this.lockedTarget = null;
    // Acceleration per frame while pulling, and a speed cap so holding
    // it indefinitely (or starting very close to the target) doesn't
    // build unbounded velocity. Both are guesses — tune once you see it
    // in motion.
    this.pullAccel = 0.85;
    this.pullMaxSpeed = 18;
    // Fraction of velocity PERPENDICULAR to the pull direction removed
    // each frame (see applyPullForce's own comment for the full
    // reasoning) — without this, any sideways/tangential velocity
    // present when a pull starts just persists, and a purely radial
    // attractive force with nothing damping that tangential component
    // is exactly what produces real orbital mechanics: circling the
    // target for multiple loops while the pull only very gradually
    // tightens the radius, rather than converging on it directly.
    this.pullTangentialDamping = 0.12;

    // How long (ms) the mouse can go without moving before we consider
    // it "idle": facing stops following it (reverts to whatever
    // movement set), and both arms switch to a synchronized sway
    // instead of aim-tracking/counter-swing. Updated once per frame in
    // updateOrientationAndFacing().
    this.mouseIdleThreshold = 2000;
    this.mouseIdle = true;
    // How long (ms) after the last scroll-wheel zoom to also treat the
    // mouse as idle — see updateOrientationAndFacing for why: rapid
    // zoom changes shift the computed mouse WORLD position even though
    // the cursor's screen position hasn't moved, which otherwise makes
    // the aim-tracked arm/head jitter while scrolling.
    this.mouseWheelSuppressDuration = 200;

    // How much smaller the full-body rig renders inside the maze
    // interior versus the main planet-surface/space mode. Tune to
    // taste — 0.1 is roughly "fits in one tile."
    this.mazeBodyScale = 0.1;

    // How long (ms) without a successful tile-hop before the maze legs/
    // head settle back to a neutral standing pose, instead of freezing
    // mid-stride forever. Reuses this.lastMoveTime, which move()'s maze
    // branch already updates on every hop.
    this.mazeMoveIdleThreshold = 300;

    // Brief invincibility window after teleporting into/out of the
    // maze, so an enemy sitting near the beam entrance can't get a free
    // kill the instant he arrives somewhere new. Set at the end of
    // enterMazeMode()/exitMazeMode(). startDeath() checks isInvincible()
    // and simply no-ops while it's active — centralized there rather
    // than in each individual collision check, so it automatically
    // covers every current and future cause of death, not just ghosts.
    // draw() flickers him while it's in effect so it's visibly
    // communicated, not just a silent grace period.
    this.invincibleDuration = 2000; // ms
    this.invincibleUntil = 0;

    // ----------------------------
    // PRE-SCALED SPRITE CACHE (perf)
    // ----------------------------
    // Every body part gets rendered ONCE to an offscreen canvas, instead
    // of being resampled by drawImage from full source resolution every
    // single frame. This is the same trick Planetoid.js uses for its
    // texture. Built lazily on first draw() call, once we know the
    // images have actually loaded.
    //
    // Baked at a resolution higher than "zoom = 1" needs — enough to
    // stay crisp at state.zoomMax (see game.js) — so that zooming IN
    // never has to upscale a low-res bitmap (blurry). Zooming out just
    // downscales a higher-res one, which always looks clean. This means
    // we never need to rebuild the cache while the player is actively
    // zooming, which would reintroduce per-frame cost.
    //
    // Each cached entry is { canvas, displayWidth, displayHeight }:
    // `canvas` is the (higher-res) baked bitmap; displayWidth/Height are
    // the correct WORLD-SPACE size to actually draw it at (i.e. what its
    // size would be at zoom=1) — draws always pass these explicitly to
    // drawImage rather than relying on the canvas's own pixel size.
    // This same cache is reused for both planet-surface/space mode and
    // maze mode; maze mode just applies an additional mazeBodyScale
    // shrink as an outer transform in draw().
    //
    // NOTE: if you ever change bodyScale or bootScale after construction,
    // call this.invalidateScaledAssets() so these get rebuilt at the
    // new size.
    this.scaledPartsReady = false;
    this.scaledParts = {};        // partKey -> { canvas, displayWidth, displayHeight }, at bodyScale
    this.scaledBootCanvas = null; // { canvas, displayWidth, displayHeight }, at bootScale
  }

  invalidateScaledAssets() {
    this.scaledPartsReady = false;
    this.scaledParts = {};
    this.scaledBootCanvas = null;
  }

  // Bakes img at `scale` (its correct world-space size, i.e. size at
  // zoom=1) but rasterizes it internally at `scale * resolutionMultiplier`
  // pixels, so it stays crisp when the caller later draws it larger
  // (zoomed in) via the canvas' own scale transform. Returns both the
  // baked canvas and the world-space size it should actually be drawn
  // at, since those now differ.
  makeScaledSprite(img, scale, resolutionMultiplier = 1) {
    const displayWidth = Math.max(1, img.naturalWidth * scale);
    const displayHeight = Math.max(1, img.naturalHeight * scale);
    const bakeWidth = Math.max(1, Math.round(displayWidth * resolutionMultiplier));
    const bakeHeight = Math.max(1, Math.round(displayHeight * resolutionMultiplier));
    const canvas = document.createElement('canvas');
    canvas.width = bakeWidth;
    canvas.height = bakeHeight;
    canvas.getContext('2d').drawImage(img, 0, 0, bakeWidth, bakeHeight);
    return { canvas, displayWidth, displayHeight };
  }

  initScaledAssets() {
    const images = state.characterImages;
    // How much extra resolution to bake in, beyond zoom=1, so zooming
    // in never has to upscale a low-res bitmap. Falls back to 2.5 (the
    // current ZOOM_MAX in game.js) if state.zoomMax isn't set for some
    // reason, so this degrades gracefully rather than baking too small.
    const resMultiplier = Math.max(1, state.zoomMax || 2.5);

    if (images) {
      for (const key of ['body', 'head', 'leftarm', 'rightarm', 'leftboot', 'rightboot']) {
        const img = images[key];
        if (img && img.complete && img.naturalWidth > 0) {
          this.scaledParts[key] = this.makeScaledSprite(img, this.bodyScale, resMultiplier);
        }
      }
    }
    if (state.bootImage && state.bootImage.complete && state.bootImage.naturalWidth > 0) {
      this.scaledBootCanvas = this.makeScaledSprite(state.bootImage, this.bootScale, resMultiplier);
    }
    this.scaledPartsReady = true;
  }

  // ----------------------------
  // BLASTER (LEFT ARM) AIMING
  // ----------------------------
  // Computes the local rotation to feed into drawLimb for the left arm
  // so that — after accounting for the character's current orientation
  // on the planet and the left/right mirror flip — the arm visually
  // points at the mouse cursor in world space, clamped so it can swing
  // up to just past straight up/down but never point behind him.
  //
  // Two things make this trickier than a plain "aim at target" formula:
  //  1. "Forward" itself flips to the opposite world angle when the rig
  //     is mirrored (facing left) — see the mirror comment in draw().
  //  2. Because that mirror is a REFLECTION (not a rotation), a local
  //     rotation applied before it doesn't just get negated — it gets
  //     reflected. So converting "desired world angle" back into the
  //     local rotation parameter needs different math on each side.
  computeLeftArmAimAngle(orientation, dirSign, originPos) {
    const cfg = this.bodyPartsConfig;
    const s = this.bodyScale;
    const cosO = Math.cos(orientation);
    const sinO = Math.sin(orientation);

    // Mirror-aware shoulder world position: local x (offsetX) flips
    // sign under the mirror, local y (offsetY) does not — same rule
    // drawLimb relies on implicitly via the outer ctx transform.
    const offsetX = cfg.leftArmX * dirSign;
    const offsetY = cfg.leftArmY;
    const wx = offsetX * cosO - offsetY * sinO;
    const wy = offsetX * sinO + offsetY * cosO;
    const shoulderX = originPos.x + wx * s;
    const shoulderY = originPos.y + wy * s;

    // "Forward" flips to the opposite world angle when mirrored, since
    // the whole rig reflects about the vertical (radial, up/down)
    // axis. Computed here (rather than only where it was previously
    // used, further below) so the gamepad-idle fallback right below
    // can also use it as its default aim direction.
    const forwardAngle = dirSign > 0 ? orientation : orientation + Math.PI;

    // Re-checked every frame — the moment a lock stops being valid
    // (destroyed, or scrolled out of the viewport), it's cleared here
    // and this frame just falls through to the normal aim priority
    // chain below instead, rather than needing a separate per-frame
    // watcher elsewhere.
    if (this.lockedTarget && !isValidLockTarget(this.lockedTarget)) {
      this.lockedTarget = null;
    }

    // While actively pulling toward a planet, aim at the pull target's
    // actual world position instead of the mouse — the beam in
    // PullBeam.js originates from this same aimShoulderPos, so this is
    // what keeps the blaster visually pointing along the beam rather
    // than wherever the mouse happens to be hovering (which can easily
    // drift away from the target once a pull is already underway).
    let targetWorldX, targetWorldY;
    if (this.lockedTarget) {
      // Absolute top priority — even above pullTarget. A hard lock
      // means the blaster persists pointing at this object no matter
      // what else is going on; the right stick, mouse, and (unless
      // it's pulling toward this SAME object — see L2's own handling
      // in gamepadInput.js) pulling itself all get overridden while
      // this is set.
      targetWorldX = this.lockedTarget.pos.x;
      targetWorldY = this.lockedTarget.pos.y;
    } else if (this.pullTarget) {
      targetWorldX = this.pullTarget.pos.x;
      targetWorldY = this.pullTarget.pos.y;
    } else if (state.gamepadAimActive) {
      // The right stick gives a DIRECTION (normalized dx/dy), not a
      // world position — atan2 below only cares about the direction
      // from shoulder to target, not the distance, so projecting an
      // arbitrary point far out along that direction works exactly
      // the same as a real target position would.
      targetWorldX = shoulderX + state.gamepadAimX * 1000;
      targetWorldY = shoulderY + state.gamepadAimY * 1000;
    } else if (state.gamepadIsActiveDevice) {
      // Gamepad is the player's current input device, but the right
      // stick itself is centered right now — falling through to the
      // mouse fallback below would be wrong here. For a gamepad-only
      // player the mouse cursor typically sits wherever it started
      // (often near screen-center, which the camera keeps close to the
      // player's own world position), making the shoulder-to-mouse
      // vector tiny and numerically unstable. That instability was the
      // actual cause of fireballs occasionally firing straight up
      // despite the blaster visually appearing to point forward: the
      // arm's VISUAL pose (natural sway, gated by mouseIdle) looked
      // fine, but aimWorldAngle underneath was quietly still being
      // computed from that degenerate mouse position regardless, since
      // aimWorldAngle is deliberately kept accurate every frame even
      // while the arm itself is just swaying (see where this method is
      // called from drawFullBody). Defaulting to straight ahead here
      // fixes the actual number fed to shootFireball()/the aim
      // raycast, not just the arm's visual pose.
      targetWorldX = shoulderX + Math.cos(forwardAngle) * 1000;
      targetWorldY = shoulderY + Math.sin(forwardAngle) * 1000;
    } else {
      const cam = state.camera || { x: 0, y: 0 };
      const zoom = state.zoom || 1;
      const mouse = state.mouse || { x: shoulderX, y: shoulderY };
      targetWorldX = mouse.x / zoom + cam.x;
      targetWorldY = mouse.y / zoom + cam.y;
    }

    const targetAngle = Math.atan2(targetWorldY - shoulderY, targetWorldX - shoulderX);

    // Signed angle from forward to target, normalized to (-π, π]
    let relative = Math.atan2(
      Math.sin(targetAngle - forwardAngle),
      Math.cos(targetAngle - forwardAngle)
    );
    // A hard lock bypasses the forward-cone clamp entirely — this is
    // the actual fix for two symptoms that both trace back to the same
    // cause: shots not going where the lock visually indicated, and
    // repeated L1/R1 presses oscillating between just two objects
    // instead of cycling through everyone in view. Both shootFireball()
    // and tryLockTargetNext()'s own "next clockwise" search read
    // this.aimWorldAngle directly, trusting it to be the TRUE angle to
    // the locked target — but whenever that angle sat outside
    // maxAimFromForward of wherever "forward" currently was, clamping
    // pinned aimWorldAngle to the edge of that cone instead. Firing
    // then went wherever the cone's edge pointed, not the target itself
    // (looking "stale," as if using the target's position from whenever
    // it was first locked, since the pinned angle barely moved frame to
    // frame) — and cycling used that same wrong, barely-moving angle as
    // its search's starting point, so successive presses kept
    // re-finding whichever two candidates happened to straddle the
    // cone's edge rather than sweeping around the whole group. A hard
    // lock is a deliberate targeting mode, not normal free-aim, so it
    // makes sense for it to ignore this arm-range constraint altogether
    // rather than working around it.
    if (!this.lockedTarget) {
      relative = Math.max(-this.maxAimFromForward, Math.min(this.maxAimFromForward, relative));
    }
    const clampedTargetAngle = forwardAngle + relative;

    // Cache for shootFireball() (so shots spawn exactly where the arm
    // is visually pointing this frame) and for computeHeadLookTilt()
    // (so the head can do a partial version of the same "look toward"
    // rotation).
    this.aimShoulderPos = new Vector2(shoulderX, shoulderY);
    this.aimWorldAngle = clampedTargetAngle;
    this.aimRelativeAngle = relative;
    this.aimAnchorPos = this.pos.clone();

    // Raycast from the muzzle tip, along the actual firing angle (the
    // same formula shootFireball() itself uses for a real shot's
    // direction), to find whatever the aim indicator should rest on
    // and whatever L2 (gamepad) should be able to pull toward — see
    // findNearestOccluder's own comment. Cached here (not recomputed
    // separately by AimIndicator.js or gamepadInput.js) so both of
    // those always agree on exactly the same target.
    const fireAngle = clampedTargetAngle + this.blasterAngleOffset;
    const muzzleDist = this.blasterMuzzleLength * this.bodyScale;
    const muzzleX = shoulderX + Math.cos(fireAngle) * muzzleDist;
    const muzzleY = shoulderY + Math.sin(fireAngle) * muzzleDist;
    const aimResult = findNearestOccluder(muzzleX, muzzleY, fireAngle);
    this.aimTargetPoint = aimResult.point;
    this.aimTargetObject = aimResult.object;

    return this.worldAngleToLocalRotation(clampedTargetAngle, orientation, dirSign);
  }

  // Converts a desired WORLD-space angle into the local rotation
  // parameter drawLimb (or a head/other part's own ctx.rotate) expects,
  // accounting for the left/right mirror. Because that mirror is a
  // REFLECTION (not a rotation), this isn't just a sign flip — see the
  // comment on computeLeftArmAimAngle above for why.
  worldAngleToLocalRotation(desiredWorldAngle, orientation, dirSign) {
    if (dirSign > 0) {
      return desiredWorldAngle - orientation;
    }
    return (orientation + Math.PI) - desiredWorldAngle;
  }

  // ----------------------------
  // HEAD LOOK TILT
  // ----------------------------
  // Tilts the head partway toward the same clamped aim target the
  // blaster arm uses (computeLeftArmAimAngle, called earlier this frame
  // — this reads its cached aimRelativeAngle rather than recomputing
  // anything), scaled down by headLookScale so it reads as a natural
  // glance up/down rather than a full arm-like swing. headLookScale of
  // 1.0 would exactly match the arm's aim angle; lower values glance
  // less. Returns 0 (straight ahead) when aimRelativeAngle hasn't been
  // set yet.
  computeHeadLookTilt(orientation, dirSign) {
    const forwardAngle = dirSign > 0 ? orientation : orientation + Math.PI;
    const desiredWorldAngle = forwardAngle + this.headLookScale * this.aimRelativeAngle;
    return this.worldAngleToLocalRotation(desiredWorldAngle, orientation, dirSign);
  }

  // ----------------------------
  // FIRING
  // ----------------------------
  // Spawns a Fireball from the blaster's muzzle tip, using this frame's
  // cached aim (see computeLeftArmAimAngle). Only fires while in
  // "space" mode (the main planet-surface/flight gameplay), respects a
  // cooldown, and does nothing while dying/teleporting or before the
  // first aim has been computed.
  shootFireball() {
    if (this.mode !== "space" || this.isDying || this.isTeleporting) return;
    if (!this.aimShoulderPos) return;

    const now = Date.now();
    if (now - this.lastShotTime < this.fireCooldown) return;
    this.lastShotTime = now;

    // aimShoulderPos/aimWorldAngle were computed during the PREVIOUS
    // frame's drawing pass (see aimAnchorPos's own comment for why),
    // so this.pos may have moved since — re-anchor the cached shoulder
    // offset to wherever this.pos actually is right now, rather than
    // firing from where the shoulder was a frame ago.
    const anchor = this.aimAnchorPos || this.pos;
    const shoulderX = this.aimShoulderPos.x + (this.pos.x - anchor.x);
    const shoulderY = this.aimShoulderPos.y + (this.pos.y - anchor.y);

    // For a hard lock or an active pull, there's a known, LIVE target
    // position worth aiming at exactly, rather than trusting the
    // previous frame's cached angle — this is what actually fixes
    // shots drifting off a small target while pulling toward it (the
    // scenario most likely to have moved meaningfully since last
    // frame). Mouse/stick aim has no such live position to re-derive
    // from (the mouse didn't move just because the player did), so
    // those keep using the cached angle as before.
    let angle;
    if (this.lockedTarget) {
      // Deliberately excludes blasterAngleOffset below — see that
      // property's own comment: it's a permanent few-degree visual
      // fudge so the fireball appears to leave from the barrel opening
      // in leftarm.png, tuned for ordinary free-aim where the player
      // judges "does this look right" by eye. Applied to an actual
      // hard lock, that same bias becomes a real miss: its linear
      // deviation scales with distance (~8.7% of range at 5°), which a
      // close/large target's own radius usually absorbs but a distant
      // or small one often can't — exactly the intermittent "off by a
      // few degrees" pattern this exists to fix. A lock's whole point
      // is guaranteed centering, so it gets the true angle, unmodified.
      angle = Math.atan2(this.lockedTarget.pos.y - shoulderY, this.lockedTarget.pos.x - shoulderX);
    } else if (this.pullTarget) {
      angle = Math.atan2(this.pullTarget.pos.y - shoulderY, this.pullTarget.pos.x - shoulderX) + this.blasterAngleOffset;
    } else {
      angle = this.aimWorldAngle + this.blasterAngleOffset;
    }

    const muzzleDist = this.blasterMuzzleLength * this.bodyScale;
    const tipX = shoulderX + Math.cos(angle) * muzzleDist;
    const tipY = shoulderY + Math.sin(angle) * muzzleDist;

    state.fireballs.push(new Fireball(tipX, tipY, angle));
    state.audioManager.playFireball();
    // Firing is one of the two actions that immediately ends V.A.T.S.
    // (the other is a successful pull — see trySelectPullTarget below)
    // — set here, at the point a shot actually fires, rather than in
    // gamepadInput.js's R2 handling, since that only INITIATES the
    // call each frame and has no way to know whether this cooldown
    // check above actually let a shot through.
    state.vatsActive = false;
  }

  // ----------------------------
  // PULL TARGET (right-click "pull star")
  // ----------------------------
  // Converts the current mouse position to world space (same approach
  // computeLeftArmAimAngle already uses) and checks it against every
  // planetoid — circular ones via a plain distance-to-center check,
  // the rounded-rect one via its own containsPoint(), since it isn't
  // truly circular. On a hit: sets pullTarget, and if currently
  // grounded, launches off the current planet with a real jump-strength
  // kick so the pull can actually take hold immediately (see below for
  // why that launch matters, not just a bare onSurface flip).
  //
  // explicitTarget, if given, skips the mouse-position lookup entirely
  // and uses that object instead — this is how gamepadInput.js's L2
  // handler reuses this same method with the raycast-derived
  // aimTargetObject rather than duplicating everything below it. Still
  // validated the same way an explicit target STILL has to actually be
  // a current, pullable planetoid (in state.planetoids, not
  // isPullExempt) — the raycast that produced aimTargetObject also
  // considers asteroids as occluders, which were never valid pull
  // targets even via mouse, so this guards against pulling one of
  // those in by mistake.
  trySelectPullTarget(explicitTarget = null) {
    if (this.mode !== "space" || this.isDying || this.isTeleporting) return;

    let best = null;
    if (explicitTarget) {
      if (state.planetoids.includes(explicitTarget) && !explicitTarget.isPullExempt) {
        best = explicitTarget;
      }
    } else {
      const cam = state.camera || { x: 0, y: 0 };
      const zoom = state.zoom || 1;
      const mouse = state.mouse || { x: this.pos.x, y: this.pos.y };
      const worldX = mouse.x / zoom + cam.x;
      const worldY = mouse.y / zoom + cam.y;

      let bestDistSq = Infinity;
      for (const planet of state.planetoids) {
        if (planet.isPullExempt) continue; // e.g. JumpPlatform - jump-only, never a valid pull target
        let hit;
        if (planet.isRoundedRect) {
          hit = typeof planet.containsPoint === 'function' && planet.containsPoint(worldX, worldY);
        } else {
          const dx = worldX - planet.pos.x;
          const dy = worldY - planet.pos.y;
          hit = (dx * dx + dy * dy) <= planet.radius * planet.radius;
        }
        if (!hit) continue;
        const distSq = (worldX - planet.pos.x) ** 2 + (worldY - planet.pos.y) ** 2;
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          best = planet;
        }
      }
    }

    if (best) {
      // If currently standing on something, launch off it exactly like
      // a normal jump does (same JUMP_STRENGTH kick, same direction —
      // straight out from the planet's center). Without this, onSurface
      // flips to false but position doesn't move at all this instant,
      // so the very next landing-collision check (which still runs
      // every frame regardless of pulling) finds him still within
      // landing range of the SAME planet and immediately re-catches
      // him before the pull force has had any real distance to work
      // with. The jump kick gives him genuine separation in the first
      // frame; applyPullForce() then bends that trajectory toward the
      // target over subsequent frames.
      if (this.onSurface && this.currentPlanet) {
        const launchDir = this.getOutwardLaunchDirection();
        this.vel = launchDir.multiply(JUMP_STRENGTH);
      }
      this.pullTarget = best;
      this.onSurface = false;
      this.currentPlanet = null;
      // A successful pull is the other of the two actions that
      // immediately ends V.A.T.S. (the other is firing — see
      // shootFireball above) — set here, inside the `if (best)` branch,
      // since this method can also just no-op if no valid target was
      // found (explicitTarget invalid, or nothing under the mouse),
      // and V.A.T.S. should only end on an ACTUAL pull, not merely an
      // attempt.
      state.vatsActive = false;
    }
  }

  clearPullTarget() {
    this.pullTarget = null;
  }

  // ----------------------------
  // HARD LOCK (gamepad R1 = next/clockwise, L1 = previous/counter-
  // clockwise, circle = release)
  // ----------------------------
  // Both cycle from wherever the blaster is currently aimed
  // (this.aimWorldAngle — kept accurate every frame regardless of
  // source, so this works whether there's no lock yet, per the
  // first-press case starting from whatever the normal aim system
  // currently has it pointed at, or an existing lock, since
  // aimWorldAngle would already equal the angle to the current
  // lockedTarget by the time either of these runs again). See
  // TargetLock.js's selectNextLockTarget/selectPreviousLockTarget for
  // the actual candidate-gathering/sorting logic — the two are mirror
  // images of each other, so in the common case a single R1 press
  // followed by a single L1 press (or vice versa) lands back on
  // whatever was locked before, reading as a genuine undo.
  tryLockTargetNext() {
    if (this.mode !== "space" || this.isDying || this.isTeleporting) return;
    const originPos = this.aimShoulderPos || this.pos;
    const referenceAngle = this.aimWorldAngle ?? 0;
    this.lockedTarget = selectNextLockTarget(this.lockedTarget, referenceAngle, originPos);
  }

  tryLockTargetPrevious() {
    if (this.mode !== "space" || this.isDying || this.isTeleporting) return;
    const originPos = this.aimShoulderPos || this.pos;
    const referenceAngle = this.aimWorldAngle ?? 0;
    this.lockedTarget = selectPreviousLockTarget(this.lockedTarget, referenceAngle, originPos);
  }

  clearLockTarget() {
    this.lockedTarget = null;
  }

  // Called from gameLoop INSTEAD OF normal gravity while pullTarget is
  // set (see the comment on pullTarget in the constructor for why).
  // Constant acceleration toward the target's current center — not
  // distance-scaled like gravity — so it reads as a deliberate pull
  // rather than a weak ambient force, with a speed cap so it can't
  // build unbounded velocity if held a long time.
  applyPullForce() {
    if (this.onSurface) { this.pullTarget = null; return; }
    if (!this.pullTarget) return;
    if (!state.planetoids.includes(this.pullTarget)) {
      // Target drifted out of the active cell neighborhood and got
      // culled while still far away — let the player keep whatever
      // velocity they already had rather than erroring or snapping.
      this.pullTarget = null;
      return;
    }

    const dx = this.pullTarget.pos.x - this.pos.x;
    const dy = this.pullTarget.pos.y - this.pos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1e-6) return;

    const dirX = dx / dist, dirY = dy / dist;

    // Split current velocity into a RADIAL component (along dirX/dirY,
    // toward the target) and whatever's left over — the TANGENTIAL
    // (perpendicular/sideways) component — and damp only that second
    // part. A plain "keep adding acceleration toward the target," with
    // nothing ever removing sideways velocity, is a purely radial
    // attractive force — the same shape as gravity, which is exactly
    // why it was producing real orbits instead of a direct approach:
    // whatever tangential velocity was present when the pull started
    // (almost always some, since the initiating launch-kick fires
    // straight out from wherever the player was standing, not
    // necessarily toward the pull target at all) just persisted,
    // circling the target while the radial pull only very slowly
    // tightened the loop. Damping the tangential part each frame is
    // what actually converges the path onto the target directly.
    const radialSpeed = this.vel.x * dirX + this.vel.y * dirY;
    const tangentX = this.vel.x - radialSpeed * dirX;
    const tangentY = this.vel.y - radialSpeed * dirY;
    // Math.pow for the retained fraction — same reasoning as
    // Asteroid.js's drag: damping is an exponential per-frame decay
    // rate, so scaling it correctly by timeScale means exponentiating
    // the RETAINED fraction (1 - damping), not just multiplying the
    // damping amount directly.
    const tangentRetention = Math.pow(1 - this.pullTangentialDamping, state.timeScale);
    this.vel.x -= tangentX * (1 - tangentRetention);
    this.vel.y -= tangentY * (1 - tangentRetention);

    this.vel.x += dirX * this.pullAccel * state.timeScale;
    this.vel.y += dirY * this.pullAccel * state.timeScale;

    const speed = this.vel.length();
    if (speed > this.pullMaxSpeed) {
      this.vel = this.vel.multiply(this.pullMaxSpeed / speed);
    }
  }

  // ----------------------------
  // TELEPORT HELPER
  // ----------------------------
  startTeleport(targetMode, targetPos = null) {
    this.isTeleporting = true;
    this.teleportTargetMode = targetMode;
    this.teleportStartTime = Date.now();
    this.teleportScale = 1;
    this.teleportGlow = 0;
    this.vel = new Vector2(0, 0);
    this.onSurface = false;

    if (targetPos && targetMode === "platform") {
      this.platformPos = targetPos.clone();
    }
  }

  // ----------------------------
  // INVINCIBILITY
  // ----------------------------
  isInvincible() {
    return Date.now() < this.invincibleUntil;
  }

  // ----------------------------
  // DEATH
  // ----------------------------
  startDeath() {
    if (this.isInvincible()) return;
    if (!this.isDying) {
      this.isDying = true;
      this.deathStartTime = Date.now();
      this.deathScale = 1;
      this.deathRotation = 0;
      this.deathAlpha = 1;
      createDeathParticles(this.pos, 400);
      state.audioManager.playDeath();
      state.vatsActive = false; // dying ends V.A.T.S. immediately, same as a successful shot or pull already do
    }
  }

  applyGravity() {
    if (this.onSurface) return;
    let planet = state.gravitySystem.findDominantPlanet(this.pos);
    if (!planet && this.lastInfluencePlanet) planet = this.lastInfluencePlanet;
    if (planet) {
      this.lastInfluencePlanet = planet;
      const direction = planet.pos.subtract(this.pos).normalize();
      let grav = GRAVITY_STRENGTH;
      if (this.isGroundPounding) grav *= GROUND_POUND_GRAV_MULTIPLIER;
      this.vel.add(direction.multiply(grav));
    }
  }

  // Helper: Check if a point (x,y) is inside a solid tile ('#')
  isSolidTile(x, y) {
    const interior = this.currentInterior;
    if (!interior) return false;
    const tileX = Math.floor(x / interior.tileSize);
    const tileY = Math.floor(y / interior.tileSize);
    return interior.tiles[tileY]?.[tileX] === '#';  // Only '#' blocks; 'H' is climbable/passable
  }

  updateMazePosition() {
    const interior = this.currentInterior;
    const planet = this.currentPlanet;   // still points to the BeamPlanetoid
  
    if (!interior || !planet) {
      console.warn("updatePlayerMazePosition: missing interior or planet");
      return;
    }
  
    const offsetX = planet.pos.x - (interior.cols * interior.tileSize / 2);
    const offsetY = planet.pos.y - (interior.rows * interior.tileSize / 2);
  
    this.pos.x = offsetX + this.mazeCol * interior.tileSize + interior.tileSize / 2;
    this.pos.y = offsetY + this.mazeRow * interior.tileSize + interior.tileSize / 2;
  }

  enterMazeMode() {
    const interior = this.currentPlanet?.interior;
    if (!interior) {
      console.error("Cannot enter maze: no planet or interior");
      return;
    }
    this.mode = "maze";
    this.currentInterior = interior;
    this.onSurface = false;
    this.mazeCol = interior.exitColLeft;
    this.mazeRow = interior.exitRow;
  
    this.mazeDir = new Vector2(1, 0);
    this.lastMoveTime = Date.now();
  
    this.updateMazePosition();
    this.invincibleUntil = Date.now() + this.invincibleDuration;
  }

  exitMazeMode() {
    this.mode = "space";
    this.currentInterior = null;
    if (this.currentPlanet) { // Assuming set before entering, or set to mazePlanet
      const surfaceDist = this.currentPlanet.radius + PLAYER_RADIUS;
      this.pos.x = this.currentPlanet.pos.x + Math.cos(this.currentPlanet.beamAngle) * surfaceDist;
      this.pos.y = this.currentPlanet.pos.y + Math.sin(this.currentPlanet.beamAngle) * surfaceDist;
      this.angle = this.currentPlanet.beamAngle;
      this.onSurface = true;
      this.lastInfluencePlanet = this.currentPlanet;
    }
    this.invincibleUntil = Date.now() + this.invincibleDuration;
  }

  updatePlatformPosition() {
    const interior = this.currentInterior;
    const planet = this.currentPlanet;
  
    if (!interior || !planet) {
      console.warn("updatePlayerPlatformPosition: missing interior or planet");
      return;
    }
  
    const offsetX = planet.pos.x - (interior.cols * interior.tileSize / 2);
    const offsetY = planet.pos.y - (interior.rows * interior.tileSize / 2);
  
    this.pos.x = offsetX + this.platformPos.x;
    this.pos.y = offsetY + this.platformPos.y;
  }

  enterPlatformMode() {
    const interior = this.currentPlanet?.interior;
    if (!interior) {
      console.error("Cannot enter platform: no planet or interior");
      return;
    }
  
    this.mode = "platform";
    this.currentInterior = interior;
    this.onSurface = false; // Not on planetary surface anymore
  
    // Spawn player at the portal exit tile (centered)
    this.platformPos = new Vector2(
      (interior.exitColLeft + 0.5) * interior.tileSize,
      (interior.exitRow + 0.5) * interior.tileSize
    );
  
    this.platformVel = new Vector2(0, 0);
  
    // Check if on ground immediately below
    const tileX = Math.floor(this.platformPos.x / interior.tileSize);
    const tileY = Math.floor(this.platformPos.y / interior.tileSize);
    const belowTile = interior.tiles[tileY + 1]?.[tileX];
    this.onGround = belowTile === "#" || belowTile === "H";
  
    // Sync global position
    this.updatePlatformPosition();
  }

  // Spawns an occasional dust puff at the player's feet while actively
  // walking on a surface — reuses the same Particle class already used
  // for explosions/impacts elsewhere (see utils.js's createParticles),
  // just with a dusty tan/beige color instead of that pattern's fiery
  // oranges, and a gentle scatter-and-drift-up rather than an
  // energetic burst. Called from all three on-surface walking branches
  // in move() below (isSkyDome flat walking, generic rect-perimeter
  // walking, and circular-planet walking), since dust should kick up
  // regardless of which underlying walking system currently applies.
  spawnWalkDust() {
    if (!this.currentPlanet) return;

    // Ties dust to actual FOOTSTEPS rather than a flat per-frame
    // chance — the walk-bob (see drawFullBody) is exactly 0 when a leg
    // passes through vertical and peaks at 1 right when it's most
    // scissored, about to plant. Detecting the moment it crosses back
    // above a high threshold catches that "just planted" instant, once
    // per actual footfall (twice per full walkTime cycle, once per
    // leg) — a flat per-frame chance instead just produced a
    // continuous, undifferentiated trail with no relationship to
    // individual steps.
    const bobT = Math.sin(this.walkTime) ** 2;
    const justPlanted = bobT > 0.85 && this.lastWalkBobT <= 0.85;
    this.lastWalkBobT = bobT;
    if (!justPlanted) return;

    // "Down" toward whatever surface the player is currently standing
    // on — same derivation used elsewhere in this class (surface
    // normal for rect-type planets, direction-to-center for circular
    // ones), so dust spawns at the actual feet regardless of
    // orientation.
    let downDir;
    if (this.currentPlanet.isRoundedRect) {
      const surface = this.currentPlanet.nearestSurfacePoint(this.pos.x, this.pos.y);
      downDir = surface.normal.clone().multiply(-1);
    } else {
      downDir = this.currentPlanet.pos.subtract(this.pos).normalize();
    }
    const feetPos = this.pos.clone().add(downDir.multiply(this.radius * 0.9));
    const sideDir = new Vector2(-downDir.y, downDir.x); // perpendicular to "down" — scatters dust sideways along the surface, regardless of its orientation

    // A small CLUSTER per footstep (2-3 particles, 4-6 while running) —
    // reads as an actual puff kicking up rather than a trailing spark.
    // Running already triggers this MORE OFTEN for free too, since
    // walkTime (and therefore footstep timing) advances by actual
    // distance covered per frame, which running increases directly —
    // this only adds the extra per-footstep volume on top of that.
    const running = state.gamepadRunHeld;
    const puffCount = (running ? 4 : 2) + Math.floor(Math.random() * (running ? 3 : 2));
    for (let i = 0; i < puffCount; i++) {
      const sideSpread = (Math.random() - 0.5) * 2.5;
      const upSpeed = 0.2 + Math.random() * 0.4;
      const vel = sideDir.multiply(sideSpread).add(downDir.multiply(-upSpeed));

      const particle = new Particle(feetPos, vel, 22 + Math.random() * 14);
      particle.color = `hsl(${35 + Math.random() * 15}, ${30 + Math.random() * 15}%, ${55 + Math.random() * 15}%)`; // dusty tan/beige
      particle.radius = 2 + Math.random() * 1.5;
      particle.drag = 0.9;      // slows down rather than drifting at constant speed forever, like real dust settling
      particle.growRate = 0.06; // gently expands over its life, like a puff dispersing rather than staying a fixed-size dot
      state.particles.push(particle);
    }
  }

  move(keys) {
    // ----------------------------
    // MAZE MODE
    // ----------------------------
    if (this.mode=="maze") {
      const now = Date.now();
      if (now - this.lastMoveTime < 110) return;
      let dx = 0, dy = 0;
      if (keys['ArrowLeft']) dx = -1;
      if (keys['ArrowRight']) dx = 1;
      if (keys['ArrowUp']) dy = -1;
      if (keys['ArrowDown']) dy = 1;
      if (dx !== 0 || dy !== 0) {
        const newCol = this.mazeCol + dx;
        const newRow = this.mazeRow + dy;
        if (dy === -1 && this.mazeRow === this.currentInterior.exitRow &&
          (this.mazeCol === this.currentInterior.exitColLeft || this.mazeCol === this.currentInterior.exitColRight)) {
          this.startTeleport("space");
          return;
        }
        if (!this.currentInterior.walls[newRow]?.[newCol]) {
          this.mazeCol = newCol;
          this.mazeRow = newRow;
          this.mazeDir = new Vector2(dx || this.mazeDir.x, dy || this.mazeDir.y).normalize();
          // Only horizontal movement changes which way he's facing —
          // moving up/down keeps whatever left/right he was last
          // facing, rather than rotating him to face up/down.
          if (dx !== 0) this.facingDirection = dx > 0 ? 1 : -1;
          // Advance the same walk-cycle phase used on planet surfaces,
          // by one tile's worth of "distance" per hop — ties the small
          // leg/arm wiggle directly to actual tile hops (discrete,
          // matching the maze's stop-motion-style movement) rather than
          // a continuous per-frame timer.
          this.walkTime += (this.currentInterior.tileSize / this.strideLength) * Math.PI * 2;
          this.lastMoveTime = now;
          this.updateMazePosition();
        }
      }
      return;
    }


    // ----------------------------
    // PLATFORM MODE
    // ----------------------------
    if (this.mode === "platform") {
      const interior = this.currentInterior;
      const tileSize = interior.tileSize;
      const tiles = interior.tiles;

      // Horizontal input
      if (keys['ArrowLeft']) this.platformVel.x = -MOVE_SPEED * 60;
      else if (keys['ArrowRight']) this.platformVel.x = MOVE_SPEED * 60;
      else this.platformVel.x = 0;

      // Vertical input/checks (ladders)
      const centerX = this.platformPos.x;
      const centerY = this.platformPos.y;
      const halfWidth = this.radius * 0.4;
      const halfHeight = this.radius * 0.4;
      const tileX = Math.floor(centerX / tileSize);
      const tileY = Math.floor(centerY / tileSize);
      const onLadder = tiles[tileY]?.[tileX] === 'H';
      const footTileY = Math.floor((centerY + halfHeight) / tileSize);
      const ladderBelow = tiles[footTileY + 1]?.[tileX] === 'H';

        // allow dropping through platform onto ladder
        if (this.onGround && keys['ArrowDown'] && ladderBelow) {
        this.onGround = false;
        this.platformVel.y = MOVE_SPEED * 60;
        }

        if (onLadder) {
        if (keys['ArrowUp']) this.platformVel.y = -MOVE_SPEED * 60;
        else if (keys['ArrowDown']) this.platformVel.y = MOVE_SPEED * 60;
        else this.platformVel.y = 0;
        }
        else if (!this.onGround) {
        this.platformVel.y += GRAVITY_STRENGTH;
        }

      // Separate horizontal/vertical movement for better collision
      // Horizontal first (unchanged)
      let newX = this.platformPos.x + this.platformVel.x;
      const left = newX - halfWidth;
      const right = newX + halfWidth;
      const midY = this.platformPos.y; // Use center for side checks

      if (this.platformVel.x < 0 && (this.isSolidTile(left, this.platformPos.y - halfHeight + 0.1) || this.isSolidTile(left, midY))) {
        newX = (Math.floor(left / tileSize) + 1) * tileSize + halfWidth;
        this.platformVel.x = 0;
      } else if (this.platformVel.x > 0 && (this.isSolidTile(right, this.platformPos.y - halfHeight + 0.1) || this.isSolidTile(right, midY))) {
        newX = Math.floor(right / tileSize) * tileSize - halfWidth;
        this.platformVel.x = 0;
      }
      this.platformPos.x = newX;

      // Vertical — ONE-WAY PLATFORMS (this is the fix!)
      let newY = this.platformPos.y + this.platformVel.y;
      const leftFoot = this.platformPos.x - halfWidth + 0.1;
      const rightFoot = this.platformPos.x + halfWidth - 0.1;
      const newBottom = newY + halfHeight;
      const newTop = newY - halfHeight;

      this.onGround = false;

    if (this.platformVel.y < 0 && !onLadder) {
        if (this.isSolidTile(leftFoot, newTop) || this.isSolidTile(rightFoot, newTop)) {
          newY = (Math.floor(newTop / tileSize) + 1) * tileSize + halfHeight;
          this.platformVel.y = 0;
        }
      } 
      else if (this.platformVel.y >= 0) {

        const wantsDrop = keys['ArrowDown'] && ladderBelow;

        if (!wantsDrop &&
            (this.isSolidTile(leftFoot, newBottom) || this.isSolidTile(rightFoot, newBottom))) {

            newY = Math.floor(newBottom / tileSize) * tileSize - halfHeight;
            this.platformVel.y = 0;
            this.onGround = true;
        }

        // allow dropping through platform if ladder below
        if (wantsDrop) {
            this.platformVel.y = MOVE_SPEED * 60;
        }
     }

      this.platformPos.y = newY;

      // Prevent falling offscreen (safety net)
      if (this.platformPos.y > interior.rows * tileSize + 100) {
        this.platformPos.y = 0;
        this.platformVel.y = 0;
        console.warn('Player fell offscreen - respawning');
      }

      this.updatePlatformPosition();  // Sync global pos
      return;
    }

    // ----------------------------
    // PLANET SURFACE
    // ----------------------------
    if (this.onSurface && this.currentPlanet && this.currentPlanet.isRoundedRect) {
      const planet = this.currentPlanet;
      this.isWalking = false;
      let ds = 0;
      const speed = PLAYER_LINEAR_SPEED * (state.gamepadRunHeld ? this.runSpeedMultiplier : 1);

      if (keys['ArrowLeft']) { ds = -speed; this.facingDirection = -1; this.isWalking = true; }
      if (keys['ArrowRight']) { ds = speed; this.facingDirection = 1; this.isWalking = true; }

      // isSkyDome planets (SkyDomePlanetoid, JumpPlatform) are always
      // axis-aligned and never rotate, so walking on them is handled
      // directly in world-X rather than through the general arc-length/
      // segment system every other rect-type planet uses. Two reasons:
      // right at a sharp (cornerRadius=0) corner, the flat top and the
      // side edge meet at literally the same point, and an earlier
      // version that clamped the ARC POSITION there turned out
      // unreliable — the player could still end up walking onto the
      // (very short) side edges despite the clamp. And more
      // importantly: reaching the edge should DETACH the player and
      // let them fall, not just halt them there — plain world-X bounds
      // checking makes both of those straightforward, with no
      // equivalent segment-boundary ambiguity.
      if (planet.isSkyDome) {
        const coreHalfWidth = planet.halfWidth - planet.cornerRadius;
        const minX = planet.pos.x - coreHalfWidth;
        const maxX = planet.pos.x + coreHalfWidth;
        const desiredX = this.pos.x + ds;

        if (desiredX < minX || desiredX > maxX) {
          // Walked past the edge of the flat top — detach and fall,
          // carrying a FRACTION of current walking speed into vel.x
          // (see edgeFallCarryFraction's own comment for why not the
          // full speed) so stepping off a ledge reads as a natural
          // fall with a bit of forward momentum, not an abrupt stop, a
          // slide onto the side, or an unnaturally strong launch.
          this.onSurface = false;
          this.currentPlanet = null;
          this.vel = new Vector2(ds * this.edgeFallCarryFraction, 0);
        } else {
          const topY = planet.pos.y - planet.halfHeight;
          this.pos = new Vector2(desiredX, topY - PLAYER_RADIUS);
        }
      } else {
        // Recomputed every frame (not just when ds !== 0) so the
        // player stays glued to the surface as the planet rotates, the
        // same way circular-planet walking already recomputes pos from
        // the planet's current pos every frame regardless of input.
        this.surfaceArcPos += ds;
        const worldSurface = planet.worldPointAtArcPosition(this.surfaceArcPos, PLAYER_RADIUS);
        this.pos = worldSurface.point;
      }

      if (this.isWalking) {
        this.walkTime += (Math.abs(ds) / this.strideLength) * Math.PI * 2;
        this.spawnWalkDust();
      }
    } else if (this.onSurface && this.currentPlanet) {
      const surfaceDist = this.currentPlanet.radius + this.radius;
      const speed = PLAYER_LINEAR_SPEED * (state.gamepadRunHeld ? this.runSpeedMultiplier : 1);
      const angularSpeed = speed / surfaceDist;

      this.isWalking = false;
      const prevAngle = this.angle;

      if (keys['ArrowLeft']) {
        this.angle -= angularSpeed;
        this.facingDirection = -1;
        this.isWalking = true;
      }
      if (keys['ArrowRight']) {
        this.angle += angularSpeed;
        this.facingDirection = 1;
        this.isWalking = true;
      }
      this.pos.x = this.currentPlanet.pos.x + Math.cos(this.angle) * surfaceDist;
      this.pos.y = this.currentPlanet.pos.y + Math.sin(this.angle) * surfaceDist;

      // Advance the walk cycle by the actual arc-length distance moved
      // this frame (|Δangle| × surfaceDist), scaled by strideLength, so
      // the leg/arm swing speed always matches real ground covered
      // rather than an arbitrary flat rate.
      if (this.isWalking) {
        const distanceMoved = Math.abs(this.angle - prevAngle) * surfaceDist;
        this.walkTime += (distanceMoved / this.strideLength) * Math.PI * 2;
        this.spawnWalkDust();
      }
    } else if (!this.onSurface && this.lastInfluencePlanet && this.lastInfluencePlanet.isSkyDome) {
      // Continuous mid-air horizontal steering, specific to
      // SkyDomePlanetoid gravity — "left/right" always maps to a
      // consistent world direction there (unlike a circular planet,
      // where it wouldn't mean anything fixed while airborne). Without
      // this, a jump that started from a standstill could never be
      // steered at all once airborne, even holding left/right the
      // whole time: getOutwardLaunchDirection() only reads input ONCE,
      // at the moment jump() is called, and the edge-detach fall sets
      // vel.x once too — neither is ever revisited afterward, so with
      // no horizontal input held at that single instant, the rest of
      // the arc was locked in as purely vertical no matter what was
      // pressed mid-air. This adds a light touch of ongoing control on
      // top of whatever the jump/fall already set vel.x to, not a
      // replacement for it — gentle acceleration while held, capped at
      // airControlMaxSpeed, so it reads as "can nudge the arc a bit,"
      // not full ground-level walking control transplanted into the air.
      if (keys['ArrowLeft']) {
        this.vel.x = Math.max(this.vel.x - this.airControlAccel, -this.airControlMaxSpeed);
        this.facingDirection = -1;
      }
      if (keys['ArrowRight']) {
        this.vel.x = Math.min(this.vel.x + this.airControlAccel, this.airControlMaxSpeed);
        this.facingDirection = 1;
      }
    }
  }

  // "Straight up from wherever I'm currently standing," given the
  // current planet — the planet's TRUE surface normal for rect-type
  // planets, not the naive "away from the planet's center" vector.
  // Those two are only ever the same thing on a perfect circle (or,
  // close enough, near a corner of a roughly-square rect) — on
  // anything long and thin, "away from center" increasingly tilts
  // toward whichever edge you're standing nearest, worse the further
  // you are from the horizontal middle, which is exactly the
  // curving-jumps-near-the-edge bug this replaced. Shared by jump()
  // and the pull-initiation launch kick, since both are fundamentally
  // the same action: detach outward from the current standing spot.
  getOutwardLaunchDirection() {
    if (!this.currentPlanet) return new Vector2(0, -1);
    if (this.currentPlanet.isRoundedRect) {
      const surface = this.currentPlanet.nearestSurfacePoint(this.pos.x, this.pos.y);
      let direction = surface.normal;

      // SkyDomePlanetoid specifically: blend in current horizontal
      // input. The ground here never curves, so "straight up relative
      // to the local surface" is ALWAYS exactly world-up no matter how
      // the player is moving — unlike every other planet (including
      // the original, full-perimeter rect one), where walking around a
      // curve naturally imparts a sense of "forward" into the jump via
      // the surface normal itself. Without this, jumps here read as
      // unnaturally floaty compared to everywhere else in the game.
      if (this.currentPlanet.isSkyDome) {
        let horizontalInput = 0;
        if (state.keys['ArrowLeft']) horizontalInput = -1;
        if (state.keys['ArrowRight']) horizontalInput = 1;
        if (horizontalInput !== 0) {
          direction = new Vector2(
            direction.x + horizontalInput * this.jumpHorizontalCarry,
            direction.y
          ).normalize();
        }
      }

      return direction;
    }
    return this.pos.subtract(this.currentPlanet.pos).normalize();
  }

  jump() {
    const jumpBoost = state.gamepadRunHeld ? this.runJumpMultiplier : 1;

    if (this.mode === "platform") {
      if (this.onGround) {
        this.platformVel.y = -JUMP_STRENGTH * 0.5 * jumpBoost;
        this.onGround = false;
        state.audioManager.playJump();
      }
      return;
    }

    if (this.onSurface && this.currentPlanet) {
      const direction = this.getOutwardLaunchDirection();
      this.vel = direction.multiply(JUMP_STRENGTH * jumpBoost);
      this.onSurface = false;
      this.currentPlanet = null;
      state.audioManager.playJump();
    }
  }

  tryGroundPound() {
    if (this.isGroundPounding) return;
    let planet = state.gravitySystem.findDominantPlanet(this.pos) || this.lastInfluencePlanet;
    if (planet) {
      const outwardDir = this.pos.subtract(planet.pos).normalize();
      const radialVel = this.vel.dot(outwardDir);
      if (radialVel > 0) this.isGroundPounding = true;
    }
  }

  checkMazeDots() {
    if (this.mode != "maze") return;
    const interior = this.currentInterior;
    for (let i = interior.dots.length - 1; i >= 0; i--) {
      const d = interior.dots[i];
      if (d.x === this.mazeCol && d.y === this.mazeRow) {
        state.audioManager.playEatDot();
        interior.dots.splice(i, 1);
        state.score += 10;
      }
    }
    for (let i = interior.powerPellets.length - 1; i >= 0; i--) {
      const p = interior.powerPellets[i];
      if (p.x === this.mazeCol && p.y === this.mazeRow) {
        state.audioManager.playEatDot();
        interior.powerPellets.splice(i, 1);
        state.score += 50;
      }
    }
  }

  update() {
    // ----------------------------
    // DEATH
    // ----------------------------
    if (this.isDying) {
      const elapsed = Date.now() - this.deathStartTime;
      const t = Math.min(elapsed / this.deathDuration, 1);
      this.deathScale = 1 - (t*t*t);
      this.deathRotation += 0.2;
      this.deathAlpha = 1 - t;
      if (t >= 1) state.gameOver = true;
      return;
    }

    // ----------------------------
    // TELEPORT
    // ----------------------------
    if (this.isTeleporting) {
      const elapsed = Date.now() - this.teleportStartTime;
      const t = elapsed / this.teleportDuration;

      if (t >= 1) {
        this.isTeleporting = false;

        if (this.teleportTargetMode === "maze") {
          this.enterMazeMode();
        } else if (this.teleportTargetMode === "platform") {
          this.enterPlatformMode();
        } else {
          this.exitMazeMode(); // Assuming for "space"
        }

        this.teleportTargetMode = null;
        return;
      }

      const pulse = Math.sin(t * Math.PI);
      this.teleportScale = 1 + pulse * 1.2;
      this.teleportGlow = pulse;

      if (Math.random() < 0.6) {
        const beamDir = new Vector2(
          Math.cos(this.currentPlanet?.beamAngle || 0),
          Math.sin(this.currentPlanet?.beamAngle || 0)
        );
        const side = new Vector2(-beamDir.y, beamDir.x).multiply((Math.random()-0.5)*1.5);
        const speed = 2 + Math.random()*2;
        const vel = beamDir.multiply(speed).add(side);
        state.particles.push(new Particle(this.pos.clone(), vel));
      }
      return;
    }

    // ----------------------------
    // MAZE MODE
    // ----------------------------
    if (this.mode=="maze") {
      this.vel = new Vector2(0,0);
      this.mouthAngle = Math.sin(Date.now()*0.01)*(Math.PI/4);
      return;
    }

    // ----------------------------
    // PLANET MOVEMENT
    // ----------------------------
    if (!this.onSurface) {
      // Math.pow for the drag decay — see Asteroid.js's identical
      // reasoning: an exponential per-frame rate has to be
      // exponentiated by timeScale, not just multiplied, or the
      // player's velocity would decay at its normal, un-slowed rate
      // even while visible movement is slowed, and wouldn't resume at
      // the same speed once V.A.T.S. ends.
      this.vel = this.vel.multiply(Math.pow(DRAG, state.timeScale));
      this.pos.add(this.vel.clone().multiply(state.timeScale));

      if (this.pos.x - this.radius < 0) { this.pos.x = this.radius; this.vel.x = -this.vel.x; }
      if (this.pos.x + this.radius > state.sceneWidth) { this.pos.x = state.sceneWidth - this.radius; this.vel.x = -this.vel.x; }
      if (this.pos.y - this.radius < 0) { this.pos.y = this.radius; this.vel.y = -this.vel.y; }
      if (this.pos.y + this.radius > state.sceneHeight) { this.pos.y = state.sceneHeight - this.radius; this.vel.y = -this.vel.y; }
    }

    this.mouthAngle = Math.sin(Date.now() * 0.01) * (Math.PI / 4);

    this.updateOrientationAndFacing();
  }

  // ----------------------------
  // MOUSE-DRIVEN FACING
  // ----------------------------
  // While the mouse is actively being used, the character faces
  // whichever side of him it's currently on — even if that's opposite
  // his direction of travel (a fun little "moonwalk" when aiming
  // backward while moving forward, left in on purpose). Once the mouse
  // has been idle for a while, facing just reverts to whatever move()
  // already set from arrow-key input.
  //
  // Also updates this.mouseIdle, which drawFullBody uses to decide
  // whether the arms should track the aim or sway together instead.
  //
  // Only meaningful in "space" mode (the full-body rig); a no-op
  // otherwise. Deliberately recomputes its own local `orientation`
  // rather than touching/reading anything shared with draw() — cheap
  // trig, and keeps the two computations independent so there's no risk
  // of them drifting out of sync during early-return frames (death,
  // teleport) where update() doesn't reach this point.
  updateOrientationAndFacing() {
    if (this.mode !== "space") return;

    const lastMove = state.lastMouseMoveTime || 0;
    const lastWheel = state.lastWheelTime || 0;
    const recentlyScrolled = (Date.now() - lastWheel) < this.mouseWheelSuppressDuration;
    // A hard lock (this.lockedTarget) counts as live aim input too,
    // same as an actively-pushed gamepad stick — without this, facing
    // would stay frozen at whatever it was before the lock (never
    // turning to actually face a locked target that's behind the
    // player), and the arm would keep showing its idle sway pose
    // instead of visually tracking the lock (see drawFullBody's own
    // mouseIdle check).
    this.mouseIdle = !this.lockedTarget && !state.gamepadAimActive && (recentlyScrolled || (Date.now() - lastMove) > this.mouseIdleThreshold);

    if (this.mouseIdle) return; // facing stays whatever move() set

    let planet = this.onSurface ? this.currentPlanet : this.lastInfluencePlanet;
    let downDir = new Vector2(0, 1);
    if (planet) {
      if (planet.isRoundedRect) {
        const surface = planet.nearestSurfacePoint(this.pos.x, this.pos.y);
        downDir = surface.normal.clone().multiply(-1);
      } else {
        downDir = planet.pos.subtract(this.pos).normalize();
      }
    }
    const downAngle = Math.atan2(downDir.y, downDir.x);
    const orientation = downAngle - Math.PI / 2;

    const tangentX = Math.cos(orientation);
    const tangentY = Math.sin(orientation);

    // A hard lock takes priority over everything else here too — the
    // astronaut should turn to face whatever's locked on, even if it's
    // currently behind him, rather than the mouse/stick case below
    // (which the lock overrides the same way computeLeftArmAimAngle's
    // own priority chain already does for the aim angle itself).
    let toTargetX, toTargetY;
    if (this.lockedTarget) {
      toTargetX = this.lockedTarget.pos.x - this.pos.x;
      toTargetY = this.lockedTarget.pos.y - this.pos.y;
    } else if (state.gamepadAimActive) {
      // The right stick already gives a DIRECTION, not a position — no
      // subtraction from the player's own position needed, unlike the
      // mouse case below (which has to convert a screen point into a
      // world point, then subtract). Same projection-onto-tangent-axis
      // technique either way, just a different source for the vector
      // being projected.
      toTargetX = state.gamepadAimX;
      toTargetY = state.gamepadAimY;
    } else {
      const cam = state.camera || { x: 0, y: 0 };
      const zoom = state.zoom || 1;
      const mouse = state.mouse || { x: this.pos.x, y: this.pos.y };
      const mouseWorldX = mouse.x / zoom + cam.x;
      const mouseWorldY = mouse.y / zoom + cam.y;
      toTargetX = mouseWorldX - this.pos.x;
      toTargetY = mouseWorldY - this.pos.y;
    }
    const projection = toTargetX * tangentX + toTargetY * tangentY;

    // Positive means the target (locked object, mouse, or stick
    // direction) is on the local +x side (dirSign +1); negative means
    // it's on the local -x side (dirSign -1) — same convention drawing
    // and aiming already use elsewhere.
    this.facingDirection = projection >= 0 ? 1 : -1;
  }

  // ----------------------------
  // BOOT DRAW HELPER (platform / death modes)
  // ----------------------------
  drawBoot(ctx) {
    const sprite = this.scaledBootCanvas;
    if (!sprite) return;
    ctx.drawImage(
      sprite.canvas,
      -sprite.displayWidth / 2,
      -sprite.displayHeight / 2,
      sprite.displayWidth,
      sprite.displayHeight
    );
  }

  // ----------------------------
  // FULL BODY DRAW HELPERS (planet-surface/space mode AND maze mode)
  // Ported from the standalone astronaut prototype: each limb has a
  // fixed offset from the rig's origin (rotated by `orientation`, the
  // same "up is away from the planet" angle already computed by the
  // caller) plus a "joint" pivot within its own image so it swings from
  // the right spot. `originPos` is passed in explicitly (rather than
  // always using this.pos) so the caller can offset the whole rig
  // outward from the planet without touching the physics position.
  //
  // Draws from the pre-scaled sprite cache (see initScaledAssets) rather
  // than resampling the source images every frame. cosO/sinO are passed
  // in from drawFullBody so they're computed once per frame, not once
  // per limb. Each sprite's displayWidth/Height (its correct world-space
  // size) is passed explicitly to drawImage, since the underlying cached
  // canvas is baked at a higher resolution than that (see
  // initScaledAssets) so zooming in stays crisp.
  // ----------------------------
  drawLimb(ctx, partKey, offsetX, offsetY, jointX, jointY, angle, orientation, originPos, cosO, sinO, flipHorizontal = false) {
    const sprite = this.scaledParts[partKey];
    if (!sprite) return;
    const s = this.bodyScale;
    ctx.save();
    const wx = offsetX * cosO - offsetY * sinO;
    const wy = offsetX * sinO + offsetY * cosO;
    ctx.translate(originPos.x + wx * s, originPos.y + wy * s);
    ctx.rotate(orientation + angle);
    // Mirrors the sprite art itself (e.g. so a thumb baked into the
    // artwork points the correct way after a rotation that swings the
    // limb well outside its normal range of motion) — added AFTER the
    // rotate above but BEFORE drawImage. Because it's applied here, the
    // existing -jointX*s/-jointY*s offset below still correctly lands
    // the joint at the origin with no separate adjustment needed: the
    // flip mirrors the offset along with the art, and those two
    // mirrored quantities still cancel out the same way they did
    // unflipped.
    if (flipHorizontal) ctx.scale(-1, 1);
    ctx.drawImage(sprite.canvas, -jointX * s, -jointY * s, sprite.displayWidth, sprite.displayHeight);
    ctx.restore();
  }

  drawFullBody(ctx, orientation, originPos) {
    if (!this.scaledPartsReady) this.initScaledAssets();
    if (!this.scaledParts.body && !this.scaledParts.leftboot) { this.drawBoot(ctx); return; }

    const cfg = this.bodyPartsConfig;
    const s = this.bodyScale;
    const cosO = Math.cos(orientation);
    const sinO = Math.sin(orientation);
    const inMaze = this.mode === "maze";

    // In the maze there's no continuous "walking" flag (movement is
    // discrete tile hops, throttled in move()) — walkTime only ever
    // advances when a hop actually happens there, so this reflects
    // whatever phase it's currently at. mazeRecentlyMoved additionally
    // requires that hop to have been recent, so legs/head settle back
    // to neutral if he's just standing still rather than freezing
    // mid-stride forever.
    const mazeRecentlyMoved = inMaze && (Date.now() - this.lastMoveTime) < this.mazeMoveIdleThreshold;
    const walkAngle = (mazeRecentlyMoved || (this.onSurface && this.isWalking)) ? Math.sin(this.walkTime) * 0.6 : 0;

    // sin(walkTime)^2 is 0 exactly when walkAngle itself is 0 (legs
    // neutral, one passing through vertical — body at its highest) and
    // 1 exactly when walkAngle is at its own extreme (legs maximally
    // scissored apart — body at its lowest), naturally oscillating at
    // TWICE walkAngle's frequency, matching that this happens once per
    // EACH leg's neutral-to-spread swing, not once per full stride.
    // Applied along (-sinO, cosO) — the character's own local "down"
    // direction (toward whatever surface they're standing on) after
    // the orientation rotation, not always world-+Y, since "down" can
    // point any direction on a curved planet.
    const walkBobT = (mazeRecentlyMoved || (this.onSurface && this.isWalking)) ? Math.sin(this.walkTime) ** 2 : 0;
    const walkBobAmount = walkBobT * this.walkBobStrength;
    originPos = new Vector2(
      originPos.x + -sinO * walkBobAmount,
      originPos.y + cosO * walkBobAmount
    );

    const dirSign = this.facingDirection < 0 ? -1 : 1;

    let leftBootAngle = walkAngle;
    let rightBootAngle = -walkAngle;
    let leftArmAngle, rightArmAngle;
    let rightArmFlipped = false;

    if (inMaze) {
      // No mouse/aim concept in the maze — both arms just sway
      // together, tied to the same hop-driven walk phase as the legs.
      const swayAngle = walkAngle * this.armSwingScale;
      leftArmAngle = swayAngle;
      rightArmAngle = swayAngle;
    } else {
      // Always compute the aim angle (even while idle) so aimShoulderPos/
      // aimWorldAngle stay accurate to the current aim target for
      // shootFireball() — but only actually use it for the arm's visual
      // angle when the mouse isn't idle, OR the player is actively
      // pulling (in which case the arm must stay visually locked to the
      // pull target regardless of idle mouse state — see
      // computeLeftArmAimAngle above). Otherwise, while idle, both arms
      // sway together instead: in sync with the walk cycle if walking, or
      // a slow gentle idle sway if just standing still.
      const aimAngle = this.computeLeftArmAimAngle(orientation, dirSign, originPos);
      if (this.mouseIdle && !this.pullTarget) {
        const swayAngle = (this.onSurface && this.isWalking)
          ? walkAngle * this.armSwingScale
          : Math.sin(Date.now() * 0.0015) * 0.15;
        leftArmAngle = swayAngle;
        rightArmAngle = swayAngle;
      } else {
        leftArmAngle = aimAngle;
        rightArmAngle = walkAngle * this.armSwingScale;
      }
    }

    if (!inMaze && !this.onSurface) {
      // Simple in-flight pose: legs splayed, and the non-blaster
      // (right) arm raises up and slightly outward — angled, not
      // straight up — rather than just hanging at the side, which is
      // what happened before this: walkAngle (what normally drives its
      // swing) evaluates to 0 while airborne, so it had nothing to
      // move it. Reuses the same world-angle-then-convert approach the
      // aiming arm already uses (worldAngleToLocalRotation) with a
      // fixed "up and outward" target instead of the mouse/pull
      // target, so the direction stays correct regardless of current
      // body orientation or the left/right facing mirror.
      leftBootAngle = -0.7;
      rightBootAngle = 0.7;
      const raisedWorldAngle = -Math.PI / 2 - (Math.PI * 0.75) * dirSign; // "up," tilted 135° AWAY from the blaster-arm side — sign flipped and magnitude increased from the previous +45°-toward-blaster version, per feedback
      rightArmAngle = this.worldAngleToLocalRotation(raisedWorldAngle, orientation, dirSign);
      rightArmFlipped = true; // mirrors the sprite art so the thumb (baked into the artwork) points toward the body instead of away from it at this large a rotation
    }

    this.drawLimb(ctx, 'leftboot', cfg.leftBootX, cfg.leftBootY, cfg.leftBootJointX, cfg.leftBootJointY, leftBootAngle, orientation, originPos, cosO, sinO);
    this.drawLimb(ctx, 'leftarm', cfg.leftArmX, cfg.leftArmY, cfg.leftArmJointX, cfg.leftArmJointY, leftArmAngle, orientation, originPos, cosO, sinO);

    const bodySprite = this.scaledParts.body;
    if (bodySprite) {
      ctx.save();
      ctx.translate(originPos.x, originPos.y);
      ctx.rotate(orientation);
      ctx.drawImage(
        bodySprite.canvas,
        -bodySprite.displayWidth / 2,
        cfg.bodyY * s - bodySprite.displayHeight / 2,
        bodySprite.displayWidth,
        bodySprite.displayHeight
      );
      ctx.restore();
    }

    this.drawLimb(ctx, 'rightboot', cfg.rightBootX, cfg.rightBootY, cfg.rightBootJointX, cfg.rightBootJointY, rightBootAngle, orientation, originPos, cosO, sinO);
    this.drawLimb(ctx, 'rightarm', cfg.rightArmX, cfg.rightArmY, cfg.rightArmJointX, cfg.rightArmJointY, rightArmAngle, orientation, originPos, cosO, sinO, rightArmFlipped);

    const headSprite = this.scaledParts.head;
    if (headSprite) {
      ctx.save();
      const headWX = -cfg.headY * sinO;
      const headWY = cfg.headY * cosO;
      const headBob = (mazeRecentlyMoved || (this.onSurface && this.isWalking)) ? Math.sin(this.walkTime * 2) * 0.03 : 0;
      // Look toward the aim target (up if aiming up, down if aiming
      // down), same idea as the arm. Not applicable in the maze (no
      // aim concept there) or while the mouse is idle — both just stay
      // neutral, matching the arms swaying together instead of
      // tracking a stale aim point.
      const headLookTilt = (inMaze || this.mouseIdle) ? 0 : this.computeHeadLookTilt(orientation, dirSign);
      const headTilt = headBob + headLookTilt;
      ctx.translate(originPos.x + headWX * s, originPos.y + headWY * s);
      ctx.rotate(orientation + headTilt);
      const pivotY = headSprite.displayHeight * this.headPivotFraction;
      ctx.drawImage(
        headSprite.canvas,
        -headSprite.displayWidth / 2,
        -pivotY,
        headSprite.displayWidth,
        headSprite.displayHeight
      );
      ctx.restore();
    }
  }

  draw() {
    const ctx = state.ctx;
    let scale = 1;
    let glow = 0;

    if (this.isDying) {
      ctx.save();
      ctx.globalAlpha = this.deathAlpha;
      ctx.translate(this.pos.x, this.pos.y);
      ctx.rotate(this.deathRotation);
      ctx.scale(this.deathScale, this.deathScale);
      ctx.shadowColor = 'orange';
      ctx.shadowBlur = 30 * (this.deathAlpha * 0.5);
      this.drawBoot(ctx);
      ctx.shadowBlur = 0;
      ctx.restore();
      return;
    }

    if (this.isTeleporting) {
      scale = this.teleportScale;
      glow = this.teleportGlow;
    }

    // Invincibility flicker: applies to whichever mode is drawn below
    // (platform, maze, or planet). Balanced by the ctx.restore() calls
    // added at the platform branch's return and at the very end of this
    // function — each mode's own internal save/restore pairs nest
    // inside this one without interfering with it.
    ctx.save();
    if (this.isInvincible()) {
      const blink = Math.floor(Date.now() / 100) % 2 === 0;
      ctx.globalAlpha = blink ? 1 : 0.3;
    }

  // ----------------------------
   // PLATFORM MODE
   // ----------------------------
   if (this.mode === "platform") {
     const platformScale = 0.4;  // ← ADD: Match maze scale for small size
     ctx.save();
     ctx.translate(this.pos.x, this.pos.y);  // Use global pos
     ctx.scale(platformScale, platformScale);  // ← ADD: Scale down like maze
     if (this.platformVel.x < 0) ctx.scale(-1,1);
     this.drawBoot(ctx);
     ctx.restore();
     ctx.restore(); // matches the outer invincibility-flicker save above
     return;
   }

    // ----------------------------
    // MAZE MODE and PLANET MODE (full body) share the same drawing
    // pipeline. The only differences are how `orientation`/`visualPos`
    // are derived, and an extra uniform scale for the maze's smaller
    // size — the mirror math below (which reflects about the axis at
    // angle `orientation` through this.pos) reduces to a plain
    // left/right flip when orientation = 0, which is exactly the
    // "always face left or right, up/down never rotates him" behavior
    // wanted in the maze. facingDirection itself is only ever changed
    // by horizontal movement (see move()), so vertical-only movement
    // naturally keeps whichever way he was last facing.
    // ----------------------------
    let orientation;
    let visualPos;
    let modeScale = 1;

    if (this.mode === "maze") {
      orientation = 0; // always upright; no gravity/surface concept here
      visualPos = this.pos; // no ground-offset concept in the maze
      modeScale = this.mazeBodyScale;
    } else {
      let planet = this.onSurface ? this.currentPlanet : this.lastInfluencePlanet;
      let downDir = new Vector2(0, 1);
      if (planet) {
        if (planet.isRoundedRect) {
          const surface = planet.nearestSurfacePoint(this.pos.x, this.pos.y);
          downDir = surface.normal.clone().multiply(-1);
        } else {
          downDir = planet.pos.subtract(this.pos).normalize();
        }
      }
      const downAngle = Math.atan2(downDir.y, downDir.x);
      orientation = downAngle - Math.PI / 2;

      // Shift the visual draw origin outward (away from the planet) so
      // the boots' soles rest on the surface instead of this.pos —
      // which marks roughly the belt — sinking into it. This only
      // affects drawing; the physics position (this.pos) is untouched.
      const outwardDir = downDir.multiply(-1);
      visualPos = this.pos.clone().add(outwardDir.multiply(this.groundOffset * this.bodyScale));
    }

    ctx.save();
    if (this.isTeleporting) {
      ctx.shadowColor='yellow';
      ctx.shadowBlur=40*glow;
    }

    // Mirror the whole rig about the character's own local vertical
    // axis (the line through this.pos at angle `orientation`) when
    // facing left, and apply the teleport pulse (`scale`) and the maze
    // size reduction (`modeScale`) the same way. Doing this as
    // translate→rotate→scale→rotate-back→translate-back reflects/scales
    // everything drawn afterward around that axis, regardless of where
    // on the planet the character currently is — a plain ctx.scale(-1,1)
    // would mirror around the canvas' raw x-axis instead, which isn't
    // what we want here. Using a transform for the pulse/mode-scale
    // (rather than temporarily inflating bodyScale, as before) keeps
    // the pre-scaled sprite cache valid — it never needs to be
    // regenerated mid-animation or per-mode.
    const dirSign = this.facingDirection < 0 ? -1 : 1;
    const totalScale = scale * modeScale;
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(orientation);
    ctx.scale(dirSign * totalScale, totalScale);
    ctx.rotate(-orientation);
    ctx.translate(-this.pos.x, -this.pos.y);

    this.drawFullBody(ctx, orientation, visualPos);
    ctx.shadowBlur=0;
    ctx.restore();
    ctx.restore(); // matches the outer invincibility-flicker save above
  }
}