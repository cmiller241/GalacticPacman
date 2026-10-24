// js/entities/Player.js
//
// The astronaut: physics / movement / landing / pull, the full-body
// rig (body, head, arms, boots), planet-surface orientation and walk
// cycle, aiming, wall jumps, swimming, the morph ball, Beam.js
// teleports (with a brief post-arrival invincibility flicker), death
// and respawn.

import love from '../love/index.js';
import lua from '../love/lua.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import constants from '../constants.js';
import DustPuff from '../effects/DustPuff.js';
import Splash from '../effects/Splash.js';
import GroundPoundBurst from '../effects/GroundPoundBurst.js';
import SilhouetteGlow from '../effects/SilhouetteGlow.js';
import TargetLock from '../systems/TargetLock.js';
import WaterSystem from '../systems/WaterSystem.js';
import PortalGun from '../systems/PortalGun.js';
import WallContactPulse from './WallContactPulse.js';
import Fireball from './Fireball.js';
import Explosion from './Explosion.js';

// How long, once the door-opening intro ends (state.introLocked flips
// false), the rigid intro pose (arms/head — see drawFullBody's own
// poseBlend) takes to ease back into whatever the normal pose would
// be, rather than snapping there in one frame.
const INTRO_POSE_TRANSITION_SECONDS = 0.6;
const BLASTER_IN_USE_LINGER = 0.6; // seconds after a shot his blaster arm stays aimed (see isUsingBlaster)

// Ground pound (see Player.update's own ground-pound bookkeeping, and
// GROUND_POUND_POSE / Player.getGroundPoundSeatDrop further down).
const GROUND_POUND_SETTLE_TICKS = 7;  // baseline (60fps) ticks the pose takes to sink down into its seated position at the start of a pound
const GROUND_POUND_IMPACT_TICKS = 14; // ticks he stays sat on the ground after landing one, before standing back up
const GROUND_POUND_SEAT_ADJUST = 0;   // world units added to the computed seat drop (positive = lower still) — fine-tuning only

// Coyote time and jump buffering (see Player.pressJump) — the two little
// graces most platformers give a jump press that's a moment off:
//   COYOTE_FRAMES       how long after walking/falling off an edge he can
//                       still jump as if he were on it (60fps ticks)
//   JUMP_BUFFER_FRAMES  how long a press in mid-air is held, waiting: land
//                       in that time and he jumps the moment he touches
//                       down; otherwise it becomes the ground pound (so the
//                       pound starts this much later than the press)
//   COYOTE_MAX_DRIFT    how far (world units) he can have got from where he
//                       left the surface and still coyote-jump off it —
//                       past this (a portal, say) it's long gone
const COYOTE_FRAMES = 6;
const JUMP_BUFFER_FRAMES = 6;
const COYOTE_MAX_DRIFT = 140;

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

// Water bubbles: spawn just outside the player's own body, on whichever
// side currently faces AWAY from the water planet's center, then travel
// further outward along that same radial line, with a lazy angular
// wobble, until reaching the water's own outer radius. Polar coordinates
// (angle + r, relative to the water planet's center) because "outward
// toward the surface" is a radial motion here — a player on the far side
// of the core sees bubbles correctly head the opposite screen direction.
const BUBBLE_SPAWN_CHANCE = 0.35; // per baseline (60fps) frame, while under BUBBLE_MAX_COUNT and submerged
const BUBBLE_MAX_COUNT = 10;

// Morph ball (ArrowDown to curl up, ArrowUp to stand back up — see
// InputHandlers.js/GamePadInput.js's own calls into
// enterBallMode/exitBallMode, and Player.drawBallMode for how it's
// actually drawn). BALL_RADIUS_MULTIPLIER is deliberately the ONE
// number behind both the drawn ball's own radius and his shorter
// collision boundary — the ball's visible silhouette should always
// exactly match where its actual collision is.
const BALL_RADIUS_MULTIPLIER = 0.792; // 0.5 * 1.2 * 1.2 * 1.1
const BALL_SPEED_MULTIPLIER = 2.1;    // 1.25 * 1.2 * 1.4

// Curl-into-a-ball transition: two authored keyframes (see
// BALL_MORPH_FRAME_1/2 near drawBallMorphPose) played in order on the
// way in, reversed on the way out. this.isBall (and therefore
// this.radius/ground speed) only flips at the very END of whichever
// direction is playing — see Player.updateBallMorph.
const BALL_MORPH_SEGMENT_TICKS = 8; // baseline (60fps) ticks each of the two keyframe blends takes

// Teleport (Beam.js's own tryInteract) — a freeze-then-snap, not a
// fade/cutscene: TELEPORT_OUT_TICKS is the pause before he vanishes
// from the origin beam, with Player.getTeleportPulse's own scale/glow
// blip playing out over it (ONLY this half gets the blip).
// TELEPORT_IN_TICKS is the visually plain "arriving" pause right after
// landing at the destination. Both in baseline (60fps) ticks.
const TELEPORT_OUT_TICKS = 30;
const TELEPORT_IN_TICKS = 30;

// Brief post-arrival invincibility, so an enemy sitting near the beam
// entrance can't get a free kill the instant he arrives somewhere new.
// 120 ticks = 2s at 60fps.
const INVINCIBLE_TICKS = 120;
const INVINCIBLE_FLICKER_INTERVAL = 0.1; // seconds per blink phase

// Death (Player.startDeath/updateDeath/respawn): how long he stays
// gone — hidden and frozen where he died, his death burst playing out —
// before reappearing at state.respawnPoint. Baseline (60fps) ticks.
const DEATH_TICKS = 50;

const BUBBLE_HEAD_GAP = 1.4;         // spawn distance from center, as a multiple of this.radius — clears his helmet instead of sitting on it
const BUBBLE_FADE_DISTANCE = 20;     // world units of travel, just before reaching the water's own radius, that a bubble fades out over
const BUBBLE_RISE_SPEED_MIN = 0.5;   // world units per baseline frame, radially outward
const BUBBLE_RISE_SPEED_MAX = 1.1;
const BUBBLE_WOBBLE_FREQ_MIN = 0.01; // radians per baseline frame the angular wobble oscillates at
const BUBBLE_WOBBLE_FREQ_MAX = 0.03;
const BUBBLE_WOBBLE_AMPLITUDE = 0.1; // radians of angular sway at full swing
const BUBBLE_RADIUS_MIN = 2.5;
const BUBBLE_RADIUS_MAX = 6;
const BUBBLE_COLOR = [0.85, 0.97, 1.0];

function newBubble(centerX, centerY, angle, startR, targetR) {
  return {
    centerX,
    centerY,
    baseAngle: angle,
    r: startR,
    targetR,
    wobblePhase: Math.random() * Math.PI * 2,
    wobbleFreq: BUBBLE_WOBBLE_FREQ_MIN + Math.random() * (BUBBLE_WOBBLE_FREQ_MAX - BUBBLE_WOBBLE_FREQ_MIN),
    riseSpeed: BUBBLE_RISE_SPEED_MIN + Math.random() * (BUBBLE_RISE_SPEED_MAX - BUBBLE_RISE_SPEED_MIN),
    radius: BUBBLE_RADIUS_MIN + Math.random() * (BUBBLE_RADIUS_MAX - BUBBLE_RADIUS_MIN),
  };
}

// Down/Triangle only ENTER/EXIT ball mode on a clean press. Flip to
// false to turn the ball off.
const BALL_MODE_ENABLED = true;

class Player {
  static new(x, y) {
    return new Player(x, y);
  }

  constructor(x, y) {
    this.pos = new Vector2(x, y);
    this.prevPos = new Vector2(x, y);
    this.vel = new Vector2(0, 0);
    this.sizeMultiplier = 1;
    this.radius = constants.PLAYER_RADIUS * this.sizeMultiplier;
    // Snapshot of the normal (non-ball) radius — enterBallMode/exitBallMode
    // toggle this.radius between this and baseRadius*BALL_RADIUS_MULTIPLIER.
    this.baseRadius = this.radius;
    this.isBall = false;
    this.ballRollAngle = 0;
    // Set by the pinball planet's own entry beam (see
    // js/interiors/PinballInterior.js onEnter) to the PinballInterior
    // instance he's currently inside, null otherwise. main.js checks this
    // to swap out normal gravity/collision for PinballInterior.updateBall,
    // and the input handlers route the jump button to
    // PinballInterior.triggerJumpAction instead of an ordinary jump.
    this.inPinball = null;
    // null | "toBall" | "toHuman" — see enterBallMode/exitBallMode/
    // updateBallMorph. morphElapsed is in baseline (60fps) ticks.
    this.morphState = null;
    this.morphElapsed = 0;

    // Beam.js teleport (see startTeleport/updateTeleport below):
    // isTeleporting is the one guard every other system checks.
    this.isTeleporting = false;
    this.teleportState = null;
    this.teleportTimer = 0;
    this.teleportOrigin = null;
    this.teleportDestination = null;

    // Post-arrival invincibility — ticks remaining.
    this.invincibleTimer = 0;

    // See startDeath/updateDeath/respawn.
    this.isDying = false;
    this.deathTimer = 0;

    // Coyote time / jump buffering — see COYOTE_FRAMES and pressJump.
    this.coyoteTimer = 0;
    this.coyotePlanet = null;
    this.coyotePos = null;
    this.jumpBufferTimer = 0;

    this.onSurface = false;
    this.currentPlanet = null;
    this.lastInfluencePlanet = null;
    this.angle = 0;
    this.surfaceArcPos = 0;
    this.facingDirection = 1;
    this.isGroundPounding = false;
    this.mode = 'space';

    // Water planets never set onSurface — the player sinks straight
    // through instead of landing — so this.submergedIn, recomputed fresh
    // every frame in update(), is the only way to know "currently inside
    // one of these" for water drag and the swim stroke in jump().
    // waterDrag is much stronger than ordinary airborne DRAG — that's
    // what makes sinking read as pushing through water. swimStrength is
    // the outward-from-center impulse each jump press adds while submerged.
    this.submergedIn = null;
    this.waterDrag = 0.90;
    // Terminal sink speed is roughly grav / (1-drag) ≈ 3.5 units/frame —
    // swimStrength needs to clear that by a wide margin per stroke.
    this.swimStrength = 16;
    this.waterWalkSpeedMultiplier = 0.4; // walking the hard core at the bottom is still walking underwater

    // One-shot arm-wave played over swimStrokeDuration frames after each
    // swim stroke (see jump()).
    this.swimStrokeTimer = 0;
    this.swimStrokeDuration = 18;

    // Ground-pound visuals. groundPoundPoseTime: ticks spent in the
    // current pound, for easing the pose down into place.
    // groundPoundImpactTimer: ticks left of the "sat on the ground" beat
    // after landing one. wasGroundPounding: last frame's isGroundPounding.
    this.groundPoundPoseTime = 0;
    this.groundPoundImpactTimer = 0;
    this.wasGroundPounding = false;

    this.bubbles = [];

    this.isWalking = false;
    this.walkTime = 0;
    this.strideLength = 90;
    this.lastWalkBobT = 0;
    this.walkBobStrength = 3;

    // Scales the ground-speed-carried horizontal jump velocity (see
    // move()'s own groundMoveSpeedX and jump()'s use of it). 1.0 would be
    // an exact carry; less is "jump friction".
    this.jumpMomentumCarryScale = 0.3;
    this.runSpeedMultiplier = 1.8;
    // Running jumps clearly higher than standing ones without being too
    // high once the dome's jumpStrength applies on every tile.
    this.runJumpMultiplier = 1.2;
    this.airControlAccel = 0.3;
    // Also the hard ceiling jump()'s own momentum carry clamps to, pinned
    // to the player's own max ground running speed — a jump carries and
    // lets you maintain your ground speed in the air, it doesn't add to it.
    this.airControlMaxSpeed = constants.PLAYER_LINEAR_SPEED * this.runSpeedMultiplier;
    this.edgeFallCarryFraction = 0.35;
    // How hard the player peels off a wall-climb shape (see
    // TiledTerrain.js's buildRampClimbShape) when they stop actively
    // climbing — applied along the current segment's own normal.
    this.wallClimbDetachPush = constants.PLAYER_LINEAR_SPEED * 0.6;
    // Which way (1 = the shape's "forward"/climbing direction, -1 = the
    // reverse) the player was last moving while on a wall-climb shape's
    // wall face or ceiling — see move()'s onClimbZone handling. null
    // whenever not currently on either.
    this.wallClimbDir = null;
    // Which PLANET (TerrainShape) wallClimbDir was recorded against — its
    // sign is only meaningful relative to THAT shape's own
    // controlsReversed convention.
    this.wallClimbDirPlanet = null;

    // Wall jump: which wall (if any) was touched THIS FRAME, set fresh
    // every frame by CollisionSystem.handlePlayerWallCollisions.
    // wallJumpUpwardRatio is the vertical leg of an (1, ratio) launch
    // vector before normalizing — 2 puts about 89% of launch speed into
    // the upward component while still kicking off the wall.
    this.touchingWall = null;
    this.wallContactNormal = null;
    this.wallJumpUpwardRatio = 2;

    // Wall slide: while airborne, touching a wall, and holding the
    // direction key INTO it, fall speed is capped to this.
    this.wallSlideMaxFallSpeed = 2.5;
    this.isWallSliding = false;

    // Wall jump input lock: for wallJumpLockFrames after a wall jump,
    // input back toward the wall just kicked off is ignored — otherwise
    // air control immediately cancels the kick. wallJumpLockBlockedDir is
    // which direction (-1/1) is currently locked out; null when none.
    this.wallJumpLockFrames = 12;
    this.wallJumpLockTimer = 0;
    this.wallJumpLockBlockedDir = null;

    // Time values are in SECONDS (love.timer.getTime())
    this.mouseIdle = true;
    this.mouseIdleThreshold = 2.0;         // seconds
    this.mouseWheelSuppressDuration = 0.2; // seconds

    this.pullTarget = null;
    this.lockedTarget = null;
    this.pullAccel = 0.85;
    this.pullMaxSpeed = 18;
    this.pullTangentialDamping = 0.12;

    // Visual rig
    this.bodyScale = 0.1 * this.sizeMultiplier;
    this.groundOffset = 250;
    this.armSwingScale = 0.5;
    this.maxAimFromForward = (90 + 5) * Math.PI / 180;
    this.headLookScale = 0.6;
    this.headPivotFraction = 0.9;
    this.blasterMuzzleLength = 300;
    this.blasterAngleOffset = -5 * Math.PI / 180;

    this.bodyPartsConfig = {
      bodyY: 115,
      headY: -150,
      leftArmX: 136, leftArmY: 9, leftArmJointX: 73, leftArmJointY: 199,
      rightArmX: -186, rightArmY: -14, rightArmJointX: 119, rightArmJointY: 40,
      leftBootX: 111, leftBootY: 241, leftBootJointX: 83, leftBootJointY: 15,
      rightBootX: -142, rightBootY: 241, rightBootJointX: 77, rightBootJointY: 15,
    };

    // How far above this.pos (world units) the very TOP of his visual
    // helmet sits — derived from the numbers drawFullBody uses to place
    // the head, so it stays correct if the rig's proportions change.
    // CollisionSystem's handlePlayerWallCollisions uses this to give the
    // player a vertical CAPSULE against walls/ceilings instead of a
    // single circle centered near his feet.
    const headImg = state.characterImages && state.characterImages.head;
    let headH = 0;
    if (headImg) headH = headImg.getHeight();
    // -10: trims the capsule a little shorter than the helmet's own
    // visual top edge, so it doesn't clip ceilings that look clear.
    this.headReach = (this.groundOffset + Math.abs(this.bodyPartsConfig.headY)) * this.bodyScale
      + headH * this.bodyScale * this.headPivotFraction
      - 10;

    // Aim cache
    this.aimShoulderPos = null;
    this.aimWorldAngle = 0;
    this.aimRelativeAngle = 0;
    this.aimAnchorPos = null;
  }

  // ----------------------------------------------------------------
  // Morph ball
  // ----------------------------------------------------------------

  // Whether he's riding a cannon: loaded in one, or fired from one and
  // still on the way (see js/world/Cannon.js). He can't do anything at
  // all then — it's purely a ride.
  isCannonRiding() {
    return this.inCannon != null || this.cannonFlight != null;
  }

  // Starts the curl-in ANIMATION — this.isBall itself doesn't flip until
  // updateBallMorph finishes playing it. Ignored mid-transition, while
  // already a ball, or while talking to an NPC.
  enterBallMode() {
    if (!BALL_MODE_ENABLED) return;
    if (this.isBall || this.morphState || state.dialogueActive || this.isTeleporting || this.isDying) return;
    if (this.isCannonRiding()) return;
    if (state.vatsActive) return; // in V.A.T.S. he only picks a target and pulls to it
    this.morphState = 'toBall';
    this.morphElapsed = 0;
    // Curling up mid ground pound calls the pound off (a ball doesn't
    // pound) — he just falls as a ball.
    this.isGroundPounding = false;
  }

  // Instantly becomes a ball — no curl-in animation, no guards — for
  // the one case where he should already BE a ball the moment he
  // arrives: the pinball planet's own entry beam (PinballInterior.onEnter).
  forceBallMode() {
    this.isBall = true;
    this.radius = this.baseRadius * BALL_RADIUS_MULTIPLIER;
    this.morphState = null;
    this.morphElapsed = 0;
  }

  // Starts the stand-back-up animation, played in REVERSE.
  exitBallMode() {
    if (!this.isBall || this.morphState || state.dialogueActive || this.isTeleporting || this.isDying) return;
    if (state.vatsActive) return;
    if (this.inPinball) return; // he's the pinball until he drains
    if (this.isCannonRiding()) return; // curled up for the whole ride
    this.morphState = 'toHuman';
    this.morphElapsed = 0;
  }

  // Advances whichever transition (if any) is currently playing, and
  // flips the functional isBall/radius state the instant it completes.
  updateBallMorph(ts) {
    if (!this.morphState) return;
    this.morphElapsed += ts;
    if (this.morphElapsed >= BALL_MORPH_SEGMENT_TICKS * 2) {
      if (this.morphState === 'toBall') {
        this.isBall = true;
        this.radius = this.baseRadius * BALL_RADIUS_MULTIPLIER;
      } else {
        this.isBall = false;
        this.radius = this.baseRadius;
      }
      this.morphState = null;
      this.morphElapsed = 0;
    }
  }

  // ----------------------------------------------------------------
  // Teleport (Beam.js)
  // ----------------------------------------------------------------

  // Starts the teleport sequence toward another Beam's own planted base —
  // called from Beam.tryInteract. origin: the beam he's actually standing
  // at (used only for getTeleportPulse's own glow color).
  startTeleport(origin, destination) {
    if (this.isTeleporting || this.isDying || this.morphState || state.dialogueActive) return;
    if (this.isCannonRiding()) return;
    if (!destination) return;
    this.isTeleporting = true;
    this.teleportState = 'out';
    this.teleportTimer = TELEPORT_OUT_TICKS;
    this.teleportOrigin = origin;
    this.teleportDestination = destination;
    this.vel.x = 0;
    this.vel.y = 0;
  }

  // Advances the freeze-then-snap sequence. The position swap happens
  // the instant the "out" pause reaches zero: he lands at the
  // destination beam's own PLANTED BASE, offset outward by his own
  // radius along the beam's facing direction, then onSurface/
  // currentPlanet/touchingWall are cleared so gravity/landing re-acquire
  // fresh from the new position next frame, and the post-arrival
  // invincibility window starts. A short "in" pause follows before
  // isTeleporting clears and normal input resumes.
  updateTeleport(ts) {
    if (!this.teleportState) return;
    this.teleportTimer -= ts;
    if (this.teleportTimer > 0) return;

    if (this.teleportState === 'out') {
      const destination = this.teleportDestination;
      if (destination) {
        const dirX = Math.cos(destination.angle), dirY = Math.sin(destination.angle);
        this.pos.x = destination.pos.x + dirX * this.radius;
        this.pos.y = destination.pos.y + dirY * this.radius;
        // Also re-anchor prevPos to the SAME spot, so this frame doesn't
        // look like one huge sweep from the origin beam to here to the
        // swept collision checks.
        this.prevPos = this.pos.clone();
      }
      this.onSurface = false;
      this.currentPlanet = null;
      this.touchingWall = null;
      this.wallContactNormal = null;
      this.invincibleTimer = INVINCIBLE_TICKS;
      this.teleportState = 'in';
      this.teleportTimer = TELEPORT_IN_TICKS;
      // Optional extension point for a destination that needs to do more
      // than just "stand him here" — e.g. the pinball planet's own entry
      // beam, whose destination.onArrive curls him into a ball.
      if (destination && destination.onArrive) destination.onArrive(this);
    } else {
      this.isTeleporting = false;
      this.teleportState = null;
      this.teleportOrigin = null;
      this.teleportDestination = null;
    }
  }

  // Checked by startDeath and by draw for the flicker itself.
  isInvincible() {
    return this.invincibleTimer > 0;
  }

  // ----------------------------------------------------------------
  // Pull anchor (SkyDome → grass deck; others → center). Returns [x, y].
  // ----------------------------------------------------------------

  getPullAnchor(target) {
    if (!target) return [this.pos.x, this.pos.y];
    if (target.isSkyDome) {
      if (target.getPullAnchor) return target.getPullAnchor();
      if (target.trueSurfaceY) return [target.pos.x, target.trueSurfaceY()];
    }
    return [target.pos.x, target.pos.y];
  }

  // ----------------------------------------------------------------
  // Physics / movement
  // ----------------------------------------------------------------

  applyGravity() {
    if (this.onSurface) return;
    // Prefer shared GravitySystem (handles SkyDome deck gravity correctly)
    if (state.gravitySystem) {
      state.gravitySystem.applyTo(this);
      return;
    }

    let planet = null;
    if (!planet && this.lastInfluencePlanet) planet = this.lastInfluencePlanet;
    if (planet) {
      this.lastInfluencePlanet = planet;
      let direction;
      if (planet.isRoundedRect && planet.nearestSurfacePoint) {
        const surface = planet.nearestSurfacePoint(this.pos.x, this.pos.y);
        if (surface.distance > 1e-6) {
          direction = new Vector2(surface.point.x - this.pos.x, surface.point.y - this.pos.y).normalize();
        } else {
          direction = surface.normal.clone().multiply(-1);
        }
      } else {
        direction = planet.pos.subtract(this.pos).normalize();
      }
      let grav = constants.GRAVITY_STRENGTH;
      if (this.isGroundPounding) grav *= constants.GROUND_POUND_GRAV_MULTIPLIER;
      this.vel.add(direction.multiply(grav));
    }
  }

  // "Down" direction used purely for the character rig's visual rotation
  // — NOT for physics/gravity. forceUprightJump surfaces (TiledTerrain)
  // keep the astronaut standing straight up regardless of which way a
  // 45-degree segment's normal points, the same way Mario doesn't tilt
  // to match a slope.
  visualDownDirection(planet) {
    // Held while going through a portal, and eased back after coming out
    // (see js/systems/PortalGun.js).
    if (this.portalDown) return this.portalDown.clone();
    if (!planet) return new Vector2(0, 1);
    if (planet.isRoundedRect) {
      if (planet.forceUprightJump) return new Vector2(0, 1);
      const surface = planet.nearestSurfacePoint(this.pos.x, this.pos.y);
      return surface.normal.clone().multiply(-1);
    }
    return planet.pos.subtract(this.pos).normalize();
  }

  getOutwardLaunchDirection() {
    if (!this.currentPlanet) return new Vector2(0, -1);
    if (this.currentPlanet.isRoundedRect) {
      const surface = this.currentPlanet.nearestSurfacePoint(this.pos.x, this.pos.y);
      let direction = surface.normal;
      // forceUprightJump (e.g. TiledTerrain's sloped segments) overrides
      // whatever this surface's own local normal is — jumping off a slope
      // still launches straight up.
      if (this.currentPlanet.forceUprightJump) direction = new Vector2(0, -1);
      return direction;
    }
    return this.pos.subtract(this.currentPlanet.pos).normalize();
  }

  jump() {
    // Locked out entirely while curling into/out of a ball, while
    // talking to an NPC, mid-teleport or dying — a single guard here
    // covers every input source that calls this.
    if (this.morphState || state.dialogueActive || this.isTeleporting || this.isDying) return;
    if (state.vatsActive) return; // in V.A.T.S. he only picks a target and pulls to it
    if (this.inCannon) return; // loaded in a cannon: it decides when he leaves (see js/world/Cannon.js)

    // Requires actually MOVING at run speed, not just holding the run
    // button while standing still — groundMoveSpeedX is 0 whenever no
    // direction key is held.
    const isRunningAndMoving = state.gamepadRunHeld && (this.groundMoveSpeedX ?? 0) !== 0;
    const jumpBoost = isRunningAndMoving ? this.runJumpMultiplier : 1;

    // Coyote time: just off an edge, he still jumps off the surface he
    // left (see canCoyoteJump) — launched exactly as if he'd still been
    // on it.
    const coyote = !(this.onSurface && this.currentPlanet) && this.canCoyoteJump();
    if (coyote) this.currentPlanet = this.coyotePlanet;
    // Any jump spends the grace, and anything waiting on a buffered press.
    this.coyoteTimer = 0;
    this.jumpBufferTimer = 0;

    if ((this.onSurface || coyote) && this.currentPlanet) {
      const direction = this.getOutwardLaunchDirection();
      // Per-planet override (e.g. SkyDomePlanetoid's own stronger
      // jumpStrength, compensating for its heavier gravityStrength)
      // takes priority over the global default.
      const jumpStrength = this.currentPlanet.jumpStrength ?? constants.JUMP_STRENGTH;
      this.vel = direction.multiply(jumpStrength * jumpBoost);
      // Carries current ground speed into the jump — a running jump
      // launches you forward as well as up. Clamped to airControlMaxSpeed
      // so rapid repeat jumps can't compound into an ever-faster leapfrog.
      const carriedVelX = this.vel.x + (this.groundMoveSpeedX ?? 0) * this.jumpMomentumCarryScale;
      this.vel.x = Math.max(-this.airControlMaxSpeed, Math.min(this.airControlMaxSpeed, carriedVelX));
      this.onSurface = false;
      this.currentPlanet = null;
      if (state.audioManager) state.audioManager.playJump();
    } else if (!this.onSurface && this.touchingWall && !this.isBall) {
      // Wall jump: kicks away from whichever wall was touched THIS FRAME.
      // Mostly-up with a horizontal kick away from the wall, same launch
      // strength as a normal jump on this level. Clearing touchingWall
      // afterward means chaining wall jumps requires actually drifting
      // back into a wall in between.
      const jumpStrength = (this.lastInfluencePlanet && this.lastInfluencePlanet.jumpStrength) ?? constants.JUMP_STRENGTH;
      const direction = new Vector2(this.wallContactNormal.x, -this.wallJumpUpwardRatio).normalize();
      this.vel = direction.multiply(jumpStrength * jumpBoost);

      // Turn to face away from the wall (the kick direction), and lock
      // BOTH that facing and horizontal input back toward this wall for
      // wallJumpLockFrames — otherwise mouse-aim facing could flip him
      // back around the very next frame.
      const awayDir = this.wallContactNormal.x > 0 ? 1 : -1;
      this.facingDirection = awayDir;
      this.wallJumpLockBlockedDir = -awayDir;
      this.wallJumpLockTimer = this.wallJumpLockFrames;

      this.spawnWallJumpEffects();

      this.touchingWall = null;
      this.wallContactNormal = null;
      if (state.audioManager) state.audioManager.playJump();
    } else if (this.submergedIn) {
      // Swim stroke: an outward-from-center impulse ADDED to (not
      // replacing) current velocity, so repeated presses build against
      // the water's own strong drag — paddling rather than identical
      // little hops. No cooldown: this can fire on every press while
      // submerged. Enough strokes carry the player back out past the
      // surface entirely.
      const planet = this.submergedIn;
      const away = this.pos.subtract(planet.pos);
      const dist = away.length();
      const dir = dist > 1 ? away.normalize() : new Vector2(0, -1);
      this.vel.add(dir.multiply(this.swimStrength));
      this.swimStrokeTimer = this.swimStrokeDuration;
      if (state.audioManager) state.audioManager.playJump();
    }
  }

  // Jump pressed in mid-air (and not buffered into a landing): slam
  // straight down. Works at ANY point in the air — on the way up, on the
  // way back down, or after simply walking off a ledge. The one
  // requirement is that something is actually pulling on him: a pound is
  // just heavier gravity until he lands.
  tryGroundPound() {
    if (this.isGroundPounding || this.isDying || this.onSurface) return;
    if (state.vatsActive) return;
    // Not as a ball, or while curling into/out of one.
    if (this.isBall || this.morphState) return;
    // Not in water either — there, jump is how he swims. That includes
    // being only partway in (his feet in the water count too).
    if (this.submergedIn) return;
    const down = this.visualDownDirection(this.lastInfluencePlanet);
    if (WaterSystem.wetAt(this.pos.x + down.x * this.radius, this.pos.y + down.y * this.radius)) return;
    if (!state.gravitySystem || !state.gravitySystem.findDominantPlanet(this.pos)) return;
    this.isGroundPounding = true;
  }

  // The jump button (Space / Cross). On something to jump off (the
  // ground, a wall, water) it's an ordinary jump. Otherwise, two graces:
  //   * coyote time — a moment after walking or falling off an edge, it's
  //     still a jump off that edge (see canCoyoteJump);
  //   * jump buffering — any other press in mid-air is held for
  //     JUMP_BUFFER_FRAMES: land in that time and it's a jump the moment
  //     he does; if not, it's the ground pound (see updateJumpGraces).
  pressJump() {
    if (this.isCannonRiding()) return;
    if (this.onSurface || this.touchingWall || this.submergedIn || this.canCoyoteJump()) {
      this.jump();
    } else {
      this.jumpBufferTimer = JUMP_BUFFER_FRAMES;
    }
  }

  // Whether he's still within coyote time of the surface he last stood
  // on: not long off it, not far from where he left it, and he left it
  // by walking or falling off — not by jumping, being pulled away by the
  // beam, curling up, a teleport, or a pound.
  canCoyoteJump() {
    if (this.coyoteTimer <= 0 || !this.coyotePlanet || !this.coyotePos) return false;
    if (this.onSurface || this.pullTarget || this.isBall || this.morphState) return false;
    if (this.inCannon || this.cannonFlight) return false;
    if (this.isTeleporting || this.isGroundPounding || this.portalTransit) return false;
    const dx = this.pos.x - this.coyotePos.x, dy = this.pos.y - this.coyotePos.y;
    return dx * dx + dy * dy <= COYOTE_MAX_DRIFT * COYOTE_MAX_DRIFT;
  }

  // Once a tick (see update): keeps the coyote surface fresh while he's
  // standing on one and counts it down once he isn't, and settles a
  // buffered press — a jump if he's now got something to jump off, the
  // ground pound once it's waited out in mid-air.
  updateJumpGraces(ts) {
    if (this.onSurface && this.currentPlanet) {
      this.coyotePlanet = this.currentPlanet;
      this.coyotePos = this.pos.clone();
      this.coyoteTimer = COYOTE_FRAMES;
    } else if (this.coyoteTimer > 0) {
      this.coyoteTimer = Math.max(0, this.coyoteTimer - ts);
    }

    if (this.jumpBufferTimer > 0) {
      if (this.onSurface || this.touchingWall || this.submergedIn) {
        // (Spent either way — if something's blocking the jump right now,
        // it shouldn't go off later.)
        this.jumpBufferTimer = 0;
        this.jump();
      } else {
        this.jumpBufferTimer = Math.max(0, this.jumpBufferTimer - ts);
        if (this.jumpBufferTimer <= 0) this.tryGroundPound();
      }
    }
  }

  // Spawns a dust puff at the player's feet on each footstep while
  // walking on a surface.
  spawnWalkDust() {
    if (!this.currentPlanet) return;

    // Ties dust to actual FOOTSTEPS — the walk-bob is 0 when a leg
    // passes through vertical and peaks at 1 right when it's about to
    // plant; catching the moment it crosses back above a high threshold
    // is that "just planted" instant, once per footfall.
    const bobT = Math.sin(this.walkTime) ** 2;
    const justPlanted = bobT > 0.85 && this.lastWalkBobT <= 0.85;
    this.lastWalkBobT = bobT;
    if (!justPlanted) return;

    // Same "down" as the rig's own visual orientation, so on a slope dust
    // spawns at his actual (always-upright) visual feet.
    const downDir = this.visualDownDirection(this.currentPlanet);
    const feetPos = this.pos.clone().add(downDir.clone().multiply(this.radius * 0.9));
    const sideDir = new Vector2(-downDir.y, downDir.x); // scatters dust sideways along the surface

    // A small CLUSTER per footstep (2-3 particles, 4-6 while running).
    const running = state.gamepadRunHeld;
    const puffCount = (running ? 4 : 2) + Math.floor(Math.random() * (running ? 3 : 2));
    DustPuff.spawn(feetPos, downDir, sideDir, puffCount, 2.5, 0.2, 0.6);
  }

  // Visual feedback for a wall-jump kick-off: a dust burst outward from
  // the wall plus a small expanding contact ring (WallContactPulse).
  // Called BEFORE this.pos/this.wallContactNormal change for the kick,
  // so both land exactly at the contact point.
  spawnWallJumpEffects() {
    const normal = this.wallContactNormal;
    const sideDir = new Vector2(-normal.y, normal.x);
    const intoWallDir = normal.clone().multiply(-1);

    const puffCount = 4 + Math.floor(Math.random() * 3);
    DustPuff.spawn(this.pos, intoWallDir, sideDir, puffCount, 3.5, 0.6, 1.2);

    if (state.wallContactPulses) {
      state.wallContactPulses.push(WallContactPulse.new(this.pos.x, this.pos.y));
    }
  }

  move(keys) {
    // Locked out while curling into/out of a ball, talking to an NPC,
    // teleporting or dying: treating `keys` as empty means every
    // ArrowLeft/ArrowRight check below falls through to "no input," while
    // everything else this function does keeps running as normal.
    if (this.morphState || state.dialogueActive || this.isTeleporting || this.isDying) keys = {};
    // Sat on the ground for a beat after a ground pound lands — no
    // walking off mid-impact. (wasGroundPounding covers the one frame
    // between touching down and update starting that timer.)
    if (this.groundPoundImpactTimer > 0 || (this.wasGroundPounding && this.onSurface)) keys = {};

    if (this.onSurface && this.currentPlanet && this.currentPlanet.isRoundedRect) {
      const planet = this.currentPlanet;
      this.isWalking = false;
      let ds = 0;
      const rawSpeed = constants.PLAYER_LINEAR_SPEED * (state.gamepadRunHeld ? this.runSpeedMultiplier : 1)
        * (this.isBall ? BALL_SPEED_MULTIPLIER : 1);
      const speed = rawSpeed * state.timeScale;

      // Unscaled (no state.timeScale) current ground speed+direction —
      // jump() carries this into the jump's own vel.x. Kept separate from
      // ds/speed because vel gets timeScale applied again on its own.
      this.groundMoveSpeedX = 0;

      if (keys['ArrowLeft']) { ds = -speed; this.facingDirection = -1; this.isWalking = true; this.groundMoveSpeedX = -rawSpeed; }
      if (keys['ArrowRight']) { ds = speed; this.facingDirection = 1; this.isWalking = true; this.groundMoveSpeedX = rawSpeed; }

      if (planet.isSkyDome) {
        const coreHalfWidth = planet.halfWidth - (planet.cornerRadius ?? 0);
        const minX = planet.pos.x - coreHalfWidth;
        const maxX = planet.pos.x + coreHalfWidth;
        const desiredX = this.pos.x + ds;

        if (desiredX < minX || desiredX > maxX) {
          this.onSurface = false;
          this.currentPlanet = null;
          this.vel = new Vector2(ds * this.edgeFallCarryFraction, 0);
        } else {
          const topY = planet.trueSurfaceY ? planet.trueSurfaceY() : (planet.pos.y - planet.halfHeight);
          this.pos = new Vector2(desiredX, topY - this.radius);
        }
      } else {
        // rampLeft's wall sits on the opposite side from rampRight's, so
        // its arc-length-increasing direction is physically leftward —
        // flip ds once so "climbing" always lines up with the key that
        // visually walks the player into the ramp.
        if (planet.isWallClimb && planet.controlsReversed) ds = -ds;

        // Wall-climb shapes detach the player if they STOP or REVERSE
        // direction on the wall face OR the ceiling — Sonic-loop style:
        // nothing but committed momentum holds you to either. Not the
        // curve leading in, the slope leading out, or flat ledges.
        //
        // wallClimbDir resets once off BOTH zones, but NOT when crossing
        // from one into the other (one continuous commitment). It ALSO
        // resets on a planet swap — another shape may read the same held
        // key with the opposite sign.
        const currentSeg = planet.isWallClimb ? planet.segmentAtArcPosition(this.surfaceArcPos) : null;
        const onClimbZone = currentSeg != null && (currentSeg.isWallFace || currentSeg.isCeiling);
        if (planet !== this.wallClimbDirPlanet) {
          this.wallClimbDir = null;
          this.wallClimbDirPlanet = planet;
        }

        let shouldDetach = false;
        if (onClimbZone) {
          // Requires the run button — an ordinary walking pace isn't
          // committed enough to hold either zone. Ball mode is ALWAYS
          // treated as "running" for this check.
          if (ds === 0 || !(state.gamepadRunHeld || this.isBall)) {
            shouldDetach = true;
          } else {
            const dirSign = ds > 0 ? 1 : -1;
            if (this.wallClimbDir != null && this.wallClimbDir !== dirSign) shouldDetach = true;
            else this.wallClimbDir = dirSign;
          }
        } else {
          this.wallClimbDir = null;
        }

        if (shouldDetach) {
          this.onSurface = false;
          this.currentPlanet = null;
          this.vel = currentSeg.normal.multiply(this.wallClimbDetachPush);
        } else {
          // Optional per-surface speed scaling (e.g. TiledTerrain slowing
          // the player down climbing a 45-degree slope, speeding up
          // descending one), looked up at the CURRENT arc position.
          if (typeof planet.getArcSpeedMultiplier === 'function') {
            ds *= planet.getArcSpeedMultiplier(this.surfaceArcPos, ds);
          }

          const desiredArcPos = this.surfaceArcPos + ds;

          // isOpenPath surfaces (a hill has two ends, not a closed loop)
          // fall off the end instead of wrapping around.
          if (planet.isOpenPath && (desiredArcPos < 0 || desiredArcPos > planet.getPerimeter())) {
            // Snap to the exact edge vertex before falling, so the swept
            // landing test can exclude a re-land on the very next frame.
            const edgeArcPos = desiredArcPos < 0 ? 0 : planet.getPerimeter();
            this.pos = planet.worldPointAtArcPosition(edgeArcPos, this.radius).point;
            this.onSurface = false;
            this.currentPlanet = null;
            // Carried along the path's ACTUAL tangent at the edge, not
            // assumed purely horizontal — a wall-climb shape's ceiling
            // stretch runs backwards in world-x.
            const edgeSeg = planet.segmentAtArcPosition ? planet.segmentAtArcPosition(edgeArcPos) : null;
            const carryDir = edgeSeg ? edgeSeg.tangent : new Vector2(1, 0);
            this.vel = carryDir.multiply(ds * this.edgeFallCarryFraction);
          } else {
            this.surfaceArcPos = desiredArcPos;
            const worldSurface = planet.worldPointAtArcPosition(this.surfaceArcPos, this.radius);
            this.pos = worldSurface.point;
          }
        }
      }

      if (this.isWalking) {
        this.walkTime += (Math.abs(ds) / this.strideLength) * Math.PI * 2;
        this.spawnWalkDust();
        // Rolling-without-slipping: a wheel of radius r moving a signed
        // distance ds rotates by exactly ds/r radians. Wrapped every
        // frame so this angle never loses precision over a long session.
        if (this.isBall) {
          this.ballRollAngle = (this.ballRollAngle + ds / this.radius) % (Math.PI * 2);
        }
      }
    } else if (this.onSurface && this.currentPlanet) {
      const surfaceDist = this.currentPlanet.radius + this.radius;
      // Walking the hard core at the bottom of a water planet is still
      // walking underwater — the same water resistance applies.
      const speedMul = (state.gamepadRunHeld ? this.runSpeedMultiplier : 1) * (this.submergedIn ? this.waterWalkSpeedMultiplier : 1)
        * (this.isBall ? BALL_SPEED_MULTIPLIER : 1);
      const speed = constants.PLAYER_LINEAR_SPEED * speedMul * state.timeScale;
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

      if (this.isWalking) {
        const signedDistanceMoved = (this.angle - prevAngle) * surfaceDist;
        this.walkTime += (Math.abs(signedDistanceMoved) / this.strideLength) * Math.PI * 2;
        this.spawnWalkDust();
        if (this.isBall) {
          this.ballRollAngle = (this.ballRollAngle + signedDistanceMoved / this.radius) % (Math.PI * 2);
        }
      }
    } else if (!this.onSurface && this.lastInfluencePlanet
      && (this.lastInfluencePlanet.isSkyDome || this.lastInfluencePlanet.forceUprightJump || this.submergedIn)) {
      // Ordinary circular planets deliberately don't get fixed
      // screen-space left/right air control — "sideways" isn't
      // well-defined on a sphere. SkyDome / forceUprightJump surfaces are
      // the exception.
      const lockedDir = this.wallJumpLockTimer > 0 ? this.wallJumpLockBlockedDir : null;

      if (this.submergedIn) {
        // Orbits around the water body's own center — a velocity nudge
        // along the current TANGENT. Only the tangential component is
        // touched; getting farther from the center is NOT something
        // left/right can do (that used to carry players out past the
        // shore). Gravity and the swim stroke stay the only radial movers.
        const water = this.submergedIn;
        let radial = this.pos.subtract(water.pos);
        if (radial.length() > 0.01) radial.normalize();
        else radial = new Vector2(0, -1);
        const tangent = new Vector2(-radial.y, radial.x);

        let tangentSpeed = this.vel.dot(tangent);
        const radialSpeed = this.vel.dot(radial);

        const swimAccel = this.airControlAccel * state.timeScale;
        if (keys['ArrowLeft'] && lockedDir !== -1) {
          tangentSpeed = Math.min(tangentSpeed, Math.max(tangentSpeed - swimAccel, -this.airControlMaxSpeed));
          this.facingDirection = -1;
        }
        if (keys['ArrowRight'] && lockedDir !== 1) {
          tangentSpeed = Math.max(tangentSpeed, Math.min(tangentSpeed + swimAccel, this.airControlMaxSpeed));
          this.facingDirection = 1;
        }

        this.vel = tangent.multiply(tangentSpeed).add(radial.multiply(radialSpeed));
      } else {
        // Nudges vel.x toward (and up to) the air cap in the held
        // direction — but never REDUCES it if momentum carried from a
        // running jump already exceeds that cap (that read as sudden air
        // friction killing the jump's distance). The cap follows the run
        // button, same as ground speed. Acceleration is scaled by
        // timeScale so air control doesn't depend on frame rate.
        const airMaxSpeed = constants.PLAYER_LINEAR_SPEED * (state.gamepadRunHeld ? this.runSpeedMultiplier : 1);
        const airAccel = this.airControlAccel * state.timeScale;
        if (keys['ArrowLeft'] && lockedDir !== -1) {
          this.vel.x = Math.min(this.vel.x, Math.max(this.vel.x - airAccel, -airMaxSpeed));
          this.facingDirection = -1;
        }
        if (keys['ArrowRight'] && lockedDir !== 1) {
          this.vel.x = Math.max(this.vel.x, Math.min(this.vel.x + airAccel, airMaxSpeed));
          this.facingDirection = 1;
        }
      }
    }
  }

  updateBubbles() {
    const timeScale = state.timeScale ?? 1;
    this.bubbles = this.bubbles ?? [];

    if (this.submergedIn && this.bubbles.length < BUBBLE_MAX_COUNT && Math.random() < BUBBLE_SPAWN_CHANCE * timeScale) {
      const water = this.submergedIn;
      const away = this.pos.subtract(water.pos);
      const dist = away.length();
      const angle = dist > 1 ? Math.atan2(away.y, away.x) : (Math.random() * Math.PI * 2);

      // Spawned past the player's OWN position along this same radial
      // line — that keeps it "above his head" on any side of the core.
      const spawnR = dist + this.radius * BUBBLE_HEAD_GAP;
      const targetR = water.radius;
      if (spawnR < targetR) {
        this.bubbles.push(newBubble(water.pos.x, water.pos.y, angle, spawnR, targetR));
      }
    }

    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      b.r += b.riseSpeed * timeScale;
      b.wobblePhase += b.wobbleFreq * timeScale;
      if (b.r >= b.targetR) this.bubbles.splice(i, 1);
    }
  }

  // Drawn separately from the rest of the player (see main.js's own call
  // site, right after the water planet's second draw pass) so bubbles
  // stay visible on top of the translucent water fill.
  drawBubbles() {
    for (const b of this.bubbles ?? []) {
      const angle = b.baseAngle + Math.sin(b.wobblePhase) * BUBBLE_WOBBLE_AMPLITUDE;
      const bx = b.centerX + Math.cos(angle) * b.r;
      const by = b.centerY + Math.sin(angle) * b.r;

      const fadeStart = b.targetR - BUBBLE_FADE_DISTANCE;
      let fade = 1;
      if (b.r > fadeStart) fade = 1 - (b.r - fadeStart) / BUBBLE_FADE_DISTANCE;

      love.graphics.setColor(BUBBLE_COLOR[0], BUBBLE_COLOR[1], BUBBLE_COLOR[2], 0.5 * fade);
      love.graphics.circle('fill', bx, by, b.radius);
      love.graphics.setColor(1, 1, 1, 0.75 * fade);
      love.graphics.circle('line', bx, by, b.radius);
    }
    love.graphics.setColor(1, 1, 1, 1);
  }

  update() {
    // Captured before this frame's own movement, so CollisionSystem can
    // do a swept crossing test against open-path terrain.
    this.prevPos = this.pos.clone();

    // Frozen in place for the whole death pause.
    if (this.isDying) {
      this.updateDeath(state.timeScale);
      return;
    }

    this.updateBallMorph(state.timeScale);
    this.updateTeleport(state.timeScale);
    this.updateJumpGraces(state.timeScale);

    if (this.invincibleTimer > 0) {
      this.invincibleTimer = Math.max(0, this.invincibleTimer - state.timeScale);
    }

    if (this.swimStrokeTimer > 0) {
      this.swimStrokeTimer = Math.max(0, this.swimStrokeTimer - state.timeScale);
    }

    // Ground pound: time the pose, and catch the landing. isGroundPounding
    // is cleared by the collision pass the moment he touches down, so "it
    // was true last time and now it isn't, and he's standing on
    // something" is the landing — as opposed to a pound that ended some
    // other way (bouncing off an Ooomba, dropping into water).
    if (this.isGroundPounding && !this.onSurface) {
      this.groundPoundPoseTime += state.timeScale;
    }
    if (this.wasGroundPounding && !this.isGroundPounding && this.onSurface) {
      this.groundPoundImpactTimer = GROUND_POUND_IMPACT_TICKS;
      const down = this.visualDownDirection(this.currentPlanet);
      GroundPoundBurst.spawn(
        this.pos.x + down.x * this.radius, this.pos.y + down.y * this.radius,
        new Vector2(-down.x, -down.y));
      if (state.audioManager) state.audioManager.playGroundPound();
    } else if (this.groundPoundImpactTimer > 0) {
      this.groundPoundImpactTimer = this.onSurface ? Math.max(0, this.groundPoundImpactTimer - state.timeScale) : 0;
    }
    if (!this.isGroundPounding && this.groundPoundImpactTimer <= 0) {
      this.groundPoundPoseTime = 0;
    }
    this.wasGroundPounding = this.isGroundPounding;

    // Recomputed fresh every frame, regardless of onSurface — a water
    // planet never sets onSurface.
    const wasSubmergedIn = this.submergedIn;
    this.submergedIn = null;
    if (state.planetoids) {
      for (const p of state.planetoids) {
        if (p.isWaterPlanet && this.pos.subtract(p.pos).length() < p.radius) {
          this.submergedIn = p;
          break;
        }
      }
    }
    // ...or in a pool of sprayed water (see js/systems/WaterSystem.js).
    if (!this.submergedIn && !this.inPinball) {
      this.submergedIn = WaterSystem.submergedAt(this) ?? null;
    }

    // Splash the instant submergedIn actually flips (either direction).
    if (this.submergedIn !== wasSubmergedIn) {
      const water = this.submergedIn ?? wasSubmergedIn;
      Splash.spawn(this.pos, this.pos.subtract(water.pos).normalize());
    }

    // isGroundPounding only ever gets cleared by actually LANDING, which
    // water never does — a pound started in the frame a swim stroke
    // carries him just past the surface would otherwise triple his
    // gravity near the water. Pounding in open water means nothing
    // anyway, so clear it whenever submerged.
    if (this.submergedIn) this.isGroundPounding = false;

    this.updateBubbles();

    // Marks the moment the shelter door reaches fully open
    // (state.spaceShelter.playerInFront flips true) so drawFullBody can
    // ease the rigid intro pose back to normal over
    // INTRO_POSE_TRANSITION_SECONDS. wasPlayerInFront starts undefined so
    // the very first call just establishes a baseline.
    const playerInFront = (state.spaceShelter && state.spaceShelter.playerInFront) || false;
    if (this.wasPlayerInFront === undefined) this.wasPlayerInFront = playerInFront;
    if (!this.wasPlayerInFront && playerInFront) {
      this.introPoseBlendStart = love.timer.getTime();
    }
    this.wasPlayerInFront = playerInFront;

    if (this.wallJumpLockTimer > 0) {
      this.wallJumpLockTimer -= state.timeScale;
      if (this.wallJumpLockTimer <= 0) this.wallJumpLockBlockedDir = null;
    }

    // isWallSliding drives drawFullBody's dedicated wall-slide pose —
    // reset false every frame BEFORE the onSurface check below, or a
    // landing mid-slide would leave it stuck true.
    this.isWallSliding = false;

    // Not while on a pinball table: PinballInterior.updateBall already
    // moved him this frame, with its own collision.
    if (!this.onSurface && !this.inPinball) {
      // Wall slide: only caps a fall that's already faster than the slide
      // speed, and only while the direction key into that wall is held.
      // Facing is forced AWAY from the wall for the whole slide.
      if (this.touchingWall && this.wallContactNormal && this.vel.y > this.wallSlideMaxFallSpeed && !this.isBall) {
        const towardWallDir = this.wallContactNormal.x > 0 ? -1 : 1;
        const holdingIntoWall = (towardWallDir === -1 && state.keys['ArrowLeft'])
          || (towardWallDir === 1 && state.keys['ArrowRight']);
        if (holdingIntoWall) {
          this.vel.y = this.wallSlideMaxFallSpeed;
          this.isWallSliding = true;
          this.facingDirection = -towardWallDir;
        }
      }

      // Water's own much stronger drag is what makes sinking read as
      // pushing through resistance. (None at all on a cannon shot: it
      // flies dead straight at full speed — see Cannon.updateFlight.)
      let dragFactor = this.submergedIn ? this.waterDrag : constants.DRAG;
      if (this.cannonFlight) dragFactor = 1;
      this.vel.scale(dragFactor ** state.timeScale);
      this.pos.addScaled(this.vel, state.timeScale);

      if (this.pos.x - this.radius < 0) { this.pos.x = this.radius; this.vel.x = -this.vel.x; }
      if (this.pos.x + this.radius > state.sceneWidth) { this.pos.x = state.sceneWidth - this.radius; this.vel.x = -this.vel.x; }
      if (this.pos.y - this.radius < 0) { this.pos.y = this.radius; this.vel.y = -this.vel.y; }
      if (this.pos.y + this.radius > state.sceneHeight) { this.pos.y = state.sceneHeight - this.radius; this.vel.y = -this.vel.y; }
    }

    this.updateOrientationAndFacing();
  }

  // ----------------------------------------------------------------
  // Facing / orientation
  // ----------------------------------------------------------------

  updateOrientationAndFacing() {
    if (this.mode !== 'space') return;

    // Locked facing right for the door-opening intro (not on the title
    // screen, which has him running around on autopilot).
    if (state.introLocked && !state.titleScreen) {
      this.facingDirection = 1;
      return;
    }

    const lastMove = state.lastMouseMoveTime ?? 0;
    const lastWheel = state.lastWheelTime ?? 0;
    const now = love.timer.getTime();

    // The title screen ignores the mouse outright (always "idle").
    const recentlyScrolled = (now - lastWheel) < this.mouseWheelSuppressDuration;
    this.mouseIdle = !this.lockedTarget
      && !state.gamepadAimActive
      && (state.titleScreen || recentlyScrolled || (now - lastMove) > this.mouseIdleThreshold);

    if (this.mouseIdle) return;

    const planet = (this.onSurface && this.currentPlanet) || this.lastInfluencePlanet;
    const downDir = this.visualDownDirection(planet);
    const downAngle = Math.atan2(downDir.y, downDir.x);
    const orientation = downAngle - Math.PI / 2;
    const tangentX = Math.cos(orientation);
    const tangentY = Math.sin(orientation);

    let toTargetX, toTargetY;
    if (this.lockedTarget) {
      toTargetX = this.lockedTarget.pos.x - this.pos.x;
      toTargetY = this.lockedTarget.pos.y - this.pos.y;
    } else if (state.gamepadAimActive) {
      toTargetX = state.gamepadAimX ?? 0;
      toTargetY = state.gamepadAimY ?? 0;
    } else {
      const cam = state.camera ?? { x: 0, y: 0 };
      const zoom = state.zoom ?? 1;
      const mouse = state.mouse ?? { x: this.pos.x, y: this.pos.y };
      const mouseWorldX = mouse.x / zoom + cam.x;
      const mouseWorldY = mouse.y / zoom + cam.y;
      toTargetX = mouseWorldX - this.pos.x;
      toTargetY = mouseWorldY - this.pos.y;
    }

    // Wall-jump facing lock and wall-sliding both force facing away from
    // the wall on their own — skipped while either is active.
    if (this.wallJumpLockTimer <= 0 && !this.isWallSliding) {
      const projection = toTargetX * tangentX + toTargetY * tangentY;
      this.facingDirection = projection >= 0 ? 1 : -1;
    }
  }

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
    if (state.gamepadFireHeld || (state.mouseDown && (state.weaponMode ?? 'blaster') === 'blaster')) return true;
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

  // Scale/glow "blip" pulse during a Beam.js teleport: pulse = sin(t*pi),
  // scale = 1 + pulse*1.2, glow intensity = pulse. ONLY plays over the
  // "out" half (departing) — the arrival gets the invincibility flicker
  // instead. Returns [scale, glow] — [1, 0] whenever he isn't departing.
  getTeleportPulse() {
    if (this.teleportState !== 'out') return [1, 0];
    const elapsed = TELEPORT_OUT_TICKS - this.teleportTimer;
    const t = (TELEPORT_OUT_TICKS > 0) ? Math.max(0, Math.min(1, elapsed / TELEPORT_OUT_TICKS)) : 1;
    const pulse = Math.sin(t * Math.PI);
    return [1 + pulse * 1.2, pulse];
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

    const [scale, pulseGlow] = this.getTeleportPulse();

    // Outer glow hugging his own real silhouette (SilhouetteGlow.js)
    // whenever he's close enough to a beam to interact with it, tinted
    // to match THAT beam's own color, fading with distance and boosted
    // during the departure pulse. The mask drawFn applies the SAME scale
    // transform the real draw below uses, so the glow follows his body
    // ballooning up through the pulse.
    const [nearbyBeam, proximity] = this.getNearbyBeam();
    if (nearbyBeam) {
      SilhouetteGlow.draw(
        this.pos.x, this.pos.y,
        this.radius * 4 * scale, 14,
        nearbyBeam.color, 0.8 * proximity * (1 + pulseGlow * 0.6),
        () => {
          if (scale === 1) {
            this.drawRig();
            return;
          }
          love.graphics.push();
          love.graphics.translate(this.pos.x, this.pos.y);
          love.graphics.scale(scale, scale);
          love.graphics.translate(-this.pos.x, -this.pos.y);
          this.drawRig();
          love.graphics.pop();
        });
    }

    // Post-arrival invincibility flicker — a hard on/off blink (skip
    // drawing him entirely on the "off" beat): drawRig sets its own
    // opaque colors, so an alpha around the whole call would just get
    // overwritten. Real-time rate, not slowed by V.A.T.S.
    if (this.isInvincible()) {
      const phase = Math.floor(love.timer.getTime() / INVINCIBLE_FLICKER_INTERVAL) % 2;
      if (phase !== 0) return;
    }

    // Sun shading on every piece of the rig — see getBodyShadingShader.
    const shadingShader = this.applyBodyShading();

    if (scale === 1) {
      this.drawRig();
    } else {
      love.graphics.push();
      love.graphics.translate(this.pos.x, this.pos.y);
      love.graphics.scale(scale, scale);
      love.graphics.translate(-this.pos.x, -this.pos.y);
      this.drawRig();
      love.graphics.pop();
    }

    if (shadingShader) love.graphics.setShader();
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

  // ----------------------------------------------------------------
  // Pull target
  // ----------------------------------------------------------------

  trySelectPullTarget(explicitTarget) {
    if (this.mode !== 'space' || this.isBall || this.isTeleporting || this.isDying) return;
    if (this.isCannonRiding()) return;

    let best = null;
    if (explicitTarget) {
      for (const p of state.planetoids) {
        if (p === explicitTarget && !explicitTarget.isPullExempt) {
          best = explicitTarget;
          break;
        }
      }
    } else {
      const cam = state.camera ?? { x: 0, y: 0 };
      const zoom = state.zoom ?? 1;
      const mouse = state.mouse ?? { x: this.pos.x, y: this.pos.y };
      const worldX = mouse.x / zoom + cam.x;
      const worldY = mouse.y / zoom + cam.y;

      let bestDistSq = Infinity;
      for (const planet of state.planetoids) {
        if (!planet.isPullExempt) {
          let hit = false;
          if (planet.containsPoint) {
            hit = planet.containsPoint(worldX, worldY);
          } else {
            const dx = worldX - planet.pos.x;
            const dy = worldY - planet.pos.y;
            hit = (dx * dx + dy * dy) <= (planet.radius ?? 0) * (planet.radius ?? 0);
          }

          if (hit) {
            const [ax, ay] = this.getPullAnchor(planet);
            const adx = worldX - ax;
            const ady = worldY - ay;
            const distSq = adx * adx + ady * ady;
            if (distSq < bestDistSq) {
              bestDistSq = distSq;
              best = planet;
            }
          }
        }
      }
    }

    if (best) {
      if (this.onSurface && this.currentPlanet) {
        const launchDir = this.getOutwardLaunchDirection();
        this.vel = launchDir.multiply(constants.JUMP_STRENGTH);
      }
      this.pullTarget = best;
      this.onSurface = false;
      this.currentPlanet = null;
      state.vatsActive = false;
    }
  }

  clearPullTarget() {
    this.pullTarget = null;
  }

  applyPullForce() {
    if (this.onSurface) { this.pullTarget = null; return; }
    if (!this.pullTarget) return;
    // Curling into a ball drops any pull in progress outright — a ball
    // has no pull beam at all.
    if (this.isBall) { this.pullTarget = null; return; }
    // Same for mid-teleport or dying.
    if (this.isTeleporting || this.isDying) { this.pullTarget = null; return; }

    if (!state.planetoids.includes(this.pullTarget)) {
      this.pullTarget = null;
      return;
    }

    const [tx, ty] = this.getPullAnchor(this.pullTarget);
    const dx = tx - this.pos.x;
    const dy = ty - this.pos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1e-6) return;

    const dirX = dx / dist, dirY = dy / dist;

    const radialSpeed = this.vel.x * dirX + this.vel.y * dirY;
    const tangentX = this.vel.x - radialSpeed * dirX;
    const tangentY = this.vel.y - radialSpeed * dirY;
    const tangentRetention = (1 - this.pullTangentialDamping) ** state.timeScale;
    this.vel.x -= tangentX * (1 - tangentRetention);
    this.vel.y -= tangentY * (1 - tangentRetention);

    this.vel.x += dirX * this.pullAccel * state.timeScale;
    this.vel.y += dirY * this.pullAccel * state.timeScale;

    const speed = this.vel.length();
    if (speed > this.pullMaxSpeed) {
      this.vel = this.vel.multiply(this.pullMaxSpeed / speed);
    }
  }

  // World position of the blaster's own muzzle — the hole at the end of
  // his arm — given where the arm is currently aimed (aimShoulderPos/
  // aimWorldAngle, set whenever he is drawn). Fireballs and the pull beam
  // both start here. Falls back to his own position before he has ever
  // been drawn. Returns [x, y].
  getMuzzlePosition() {
    // Exact muzzle pixel within leftarm.png (602x256).
    const MUZZLE_PX_X = 530, MUZZLE_PX_Y = 120;

    let originX, originY;
    if (this.aimShoulderPos) {
      const cfg = this.bodyPartsConfig;
      const s = this.bodyScale;
      const dirSign = this.facingDirection < 0 ? -1 : 1;
      const aimWorldAngle = this.aimWorldAngle ?? 0;

      // Raw offset (world units) from the arm's own joint pivot to the
      // muzzle pixel, still in the image's own unrotated local space.
      const vx = (MUZZLE_PX_X - cfg.leftArmJointX) * s;
      const vy = (MUZZLE_PX_Y - cfg.leftArmJointY) * s;

      let worldVX, worldVY;
      if (dirSign > 0) {
        // Facing right (unmirrored): the arm's world rotation is exactly
        // aimWorldAngle.
        const c = Math.cos(aimWorldAngle), sn = Math.sin(aimWorldAngle);
        worldVX = vx * c - vy * sn;
        worldVY = vx * sn + vy * c;
      } else {
        // Facing left: the whole rig is additionally mirrored by
        // drawRig's outer scale(dirSign,1); the composed transform
        // reduces to flipping this local offset horizontally, then
        // rotating by (aimWorldAngle - pi).
        const rot = aimWorldAngle - Math.PI;
        const c = Math.cos(rot), sn = Math.sin(rot);
        const fx = -vx, fy = vy;
        worldVX = fx * c - fy * sn;
        worldVY = fx * sn + fy * c;
      }

      originX = this.aimShoulderPos.x + worldVX;
      originY = this.aimShoulderPos.y + worldVY;
    } else {
      originX = this.pos.x;
      originY = this.pos.y;
    }

    return [originX, originY];
  }

  shootFireball() {
    if (this.mode !== 'space' && this.mode !== 'platform') return;
    if (this.isBall || this.isTeleporting || this.isDying) return;
    if (this.isCannonRiding()) return;
    if (state.vatsActive) return;

    const now = love.timer.getTime();
    this.lastShotTime = this.lastShotTime ?? 0;
    this.fireCooldown = this.fireCooldown ?? 0.15;
    if (now - this.lastShotTime < this.fireCooldown) return;
    this.lastShotTime = now;

    let angle = this.aimWorldAngle ?? 0;
    if (this.blasterAngleOffset) angle += this.blasterAngleOffset;

    const [originX, originY] = this.getMuzzlePosition();

    state.fireballs = state.fireballs ?? [];
    state.fireballs.push(Fireball.new(originX, originY, angle));
  }

  // ----------------------------
  // HARD LOCK (gamepad R1 = next/clockwise, L1 = previous/counter-
  // clockwise, Circle = release) — see GamePadInput.js for the button
  // wiring and js/systems/TargetLock.js for the candidate logic.
  // Both cycle from wherever the blaster is currently aimed, and are
  // mirror images of each other, so R1 then L1 reads as a genuine undo.
  // ----------------------------
  tryLockTargetNext() {
    if (this.mode !== 'space' || this.isDying || this.isTeleporting || this.isBall) return;
    const originPos = this.aimShoulderPos ?? this.pos;
    const referenceAngle = this.aimWorldAngle ?? 0;
    this.lockedTarget = TargetLock.selectNextLockTarget(this.lockedTarget, referenceAngle, originPos);
  }

  tryLockTargetPrevious() {
    if (this.mode !== 'space' || this.isDying || this.isTeleporting || this.isBall) return;
    const originPos = this.aimShoulderPos ?? this.pos;
    const referenceAngle = this.aimWorldAngle ?? 0;
    this.lockedTarget = TargetLock.selectPreviousLockTarget(this.lockedTarget, referenceAngle, originPos);
  }

  clearLockTarget() {
    this.lockedTarget = null;
  }

  // Lethal contact (Spikey, FireBar, Ooomba — CollisionSystem.js calls
  // this every frame contact continues; the isDying check makes that a
  // single death). Ignored while invincible or mid-teleport. He vanishes
  // in a burst right where he was hit, stays gone for DEATH_TICKS, then
  // reappears at state.respawnPoint (see respawn).
  startDeath() {
    if (this.isDying || this.isTeleporting || this.isInvincible()) return;

    this.isDying = true;
    this.deathTimer = DEATH_TICKS;
    // Decided now, from where he actually died. null (no DeathZone here)
    // falls back to state.respawnPoint.
    this.deathZoneRespawn = null;
    for (const zone of state.deathZones ?? []) {
      if (this.pos.x >= zone.x && this.pos.x <= zone.x + zone.width
        && this.pos.y >= zone.y && this.pos.y <= zone.y + zone.height) {
        this.deathZoneRespawn = { x: zone.respawnX, y: zone.respawnY };
        break;
      }
    }
    this.vel.x = 0;
    this.vel.y = 0;
    this.pullTarget = null;
    this.lockedTarget = null;

    state.explosions = state.explosions ?? [];
    state.explosions.push(Explosion.new(this.pos.x, this.pos.y));
    if (state.audioManager) state.audioManager.playDeath();
  }

  updateDeath(ts) {
    this.deathTimer -= ts;
    if (this.deathTimer <= 0) this.respawn();
  }

  // Puts him back at state.respawnPoint (the Space Shelter's doorway) —
  // or, if he died inside a Tiled "DeathZone", at that zone's own
  // respawn point — standing, with everything transient about wherever
  // he died cleared, and the same brief invincibility a beam arrival gets.
  respawn() {
    const point = this.deathZoneRespawn ?? state.respawnPoint;
    this.deathZoneRespawn = null;
    // Any trip through a portal is called off, and so is being in or
    // fired from a cannon.
    this.portalTransit = null;
    this.portalDown = null;
    this.inCannon = null;
    this.cannonFlight = null;
    if (point) {
      this.pos.x = point.x;
      this.pos.y = point.y;
      if (point.planet) {
        this.onSurface = true;
        this.currentPlanet = point.planet;
        this.lastInfluencePlanet = point.planet;
        // On a round planet his place on it IS this angle (from its
        // centre). Flat surfaces (the dome's deck) don't use it.
        if (point.planet.isRoundedRect) {
          this.angle = -Math.PI / 2;
        } else {
          this.angle = Math.atan2(point.y - point.planet.pos.y, point.x - point.planet.pos.x);
        }
      } else {
        // A DeathZone's own respawn point names no surface — he's left
        // airborne there and lands through the ordinary collision pass.
        this.onSurface = false;
        this.currentPlanet = null;
      }
    }
    // Without this, this frame's swept collision checks would see a
    // single-frame "travel" all the way from where he died to here.
    this.prevPos = this.pos.clone();
    this.vel.x = 0;
    this.vel.y = 0;

    this.isBall = false;
    this.radius = this.baseRadius;
    this.morphState = null;
    this.morphElapsed = 0;
    this.isGroundPounding = false;
    this.wasGroundPounding = false;
    this.groundPoundImpactTimer = 0;
    this.groundPoundPoseTime = 0;
    this.isWallSliding = false;
    this.touchingWall = null;
    this.wallContactNormal = null;
    this.wallClimbDir = null;
    this.wallClimbDirPlanet = null;
    this.wallJumpLockTimer = 0;
    this.wallJumpLockBlockedDir = null;
    // Cleared directly so dying underwater doesn't play a "left the
    // water" splash at the shelter.
    this.submergedIn = null;
    this.bubbles = [];

    this.isDying = false;
    this.deathTimer = 0;
    this.invincibleTimer = INVINCIBLE_TICKS;

    // A respawn point can name a pinball table (point.pinball, a
    // PinballInterior) to put him straight onto its plunger as a ball.
    this.inPinball = null;
    if (point && point.pinball) point.pinball.onEnter(this);
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

export default Player;
