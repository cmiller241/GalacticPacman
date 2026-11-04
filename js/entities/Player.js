// js/entities/Player.js
//
// The astronaut. This file has his state (the constructor), the per-frame
// update, ball mode, teleporting, invincibility, bubbles, death and
// respawn. The rest of his methods are in js/entities/player/:
//   Movement.js   gravity, jumping, ground pound, walking
//   Rendering.js  drawing the rig, poses, ball and effects
//   Targeting.js  pull beam, target lock, firing
// and are copied onto Player at the bottom of this file. (A port of
// lua/entities/Player.lua, split the same way.)

import love from '../love/index.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import constants from '../constants.js';
import Splash from '../effects/Splash.js';
import Bubbles from '../effects/Bubbles.js';
import GroundPoundBurst from '../effects/GroundPoundBurst.js';
import WaterSystem from '../systems/WaterSystem.js';
import Explosion from './Explosion.js';
import Tuning from './player/Tuning.js';
import Movement from './player/Movement.js';
import Rendering from './player/Rendering.js';
import Targeting from './player/Targeting.js';

const { BALL_MORPH_SEGMENT_TICKS, TELEPORT_OUT_TICKS, TELEPORT_IN_TICKS } = Tuning;

// Ground pound (see update's ground-pound bookkeeping).
const GROUND_POUND_IMPACT_TICKS = 14; // ticks he stays sat on the ground after landing one, before standing back up

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
// InputHandlers.js/GamePadInput.js's calls into enterBallMode/
// exitBallMode). The one number behind both the drawn ball's radius and
// his collision radius as a ball, so the two always match.
const BALL_RADIUS_MULTIPLIER = 0.792; // 0.5 * 1.2 * 1.2 * 1.1

// Brief invincibility after arriving through a beam or respawning, so an
// enemy near where he appears can't get a free kill. Baseline (60fps)
// ticks: 120 = 2s. (The flicker rate is in Rendering.js.)
const INVINCIBLE_TICKS = 120;

// Death (Player.startDeath/updateDeath/respawn): how long he stays
// gone — hidden and frozen where he died, his death burst playing out —
// before reappearing at state.respawnPoint. Baseline (60fps) ticks.
const DEATH_TICKS = 50;

const BUBBLE_HEAD_GAP = 1.4;         // spawn distance from center, as a multiple of this.radius — clears his helmet instead of sitting on it
// Sizes and rise speeds for his bubbles; the rest of their look and
// motion lives in js/effects/Bubbles.js.
const BUBBLES = {
  radiusMin: 2,   // world units, before they swell on the way up
  radiusMax: 5.5,
  riseMin: 0.5,   // world units per baseline frame, radially outward
  riseMax: 1.1,
};

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
    if (state.audioManager) state.audioManager.playMorphBall();
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
    // No room to stand up (in a ball tunnel — see CrackedPlanetoid.standingRoomAt).
    const planet = this.currentPlanet ?? this.lastInfluencePlanet;
    if (planet && planet.standingRoomAt && !planet.standingRoomAt(this)) return;
    // (Or in one of the sky dome's — see TiledTerrain.js's Level.standingRoomAt.)
    for (const level of state.tiledLevels ?? []) {
      if (level.standingRoomAt && !level.standingRoomAt(this)) return;
    }
    this.morphState = 'toHuman';
    this.morphElapsed = 0;
    if (state.audioManager) state.audioManager.playMorphUnball();
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
  // at (used for getTransporterState's shimmer color).
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
      Bubbles.spawn(this.bubbles, water.pos.x, water.pos.y, angle, spawnR, water.radius, BUBBLES);
    }

    Bubbles.update(this.bubbles, timeScale);
  }

  // Drawn separately from the rest of the player (see main.js's own call
  // site, right after the water planet's second draw pass) so bubbles
  // stay visible on top of the translucent water fill.
  drawBubbles() {
    Bubbles.draw(this.bubbles ?? []);
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

// The methods kept in js/entities/player/ (see the top of this file).
for (const part of [Movement, Rendering, Targeting]) {
  for (const name of Object.getOwnPropertyNames(part.prototype)) {
    if (name === 'constructor') continue;
    if (Object.prototype.hasOwnProperty.call(Player.prototype, name)) throw new Error(`Player.${name} is defined twice`);
    Object.defineProperty(Player.prototype, name, Object.getOwnPropertyDescriptor(part.prototype, name));
  }
}

export default Player;
