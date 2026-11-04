// js/entities/player/Movement.js
//
// Player methods for moving: gravity, jumping (with coyote time and jump
// buffering), the ground pound, walking/running on surfaces and in the
// air, and the dust and wall-jump effects that go with them. Copied onto
// Player by js/entities/Player.js. (A port of lua/entities/player/Movement.lua.)

import state from '../../state.js';
import Vector2 from '../../vector2.js';
import constants from '../../constants.js';
import DustPuff from '../../effects/DustPuff.js';
import WaterSystem from '../../systems/WaterSystem.js';
import WallContactPulse from '../WallContactPulse.js';

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

// Ball mode's speed, relative to his walking speed (see enterBallMode).
const BALL_SPEED_MULTIPLIER = 2.1;    // 1.25 * 1.2 * 1.4
// On ice (see move): how much of the gap between his speed and what the
// keys ask for closes each frame — small, so he slides.
const ICE_GRIP = 0.035;

// Walking off the end of an open path (a TiledTerrain run of ground, or
// one of its curve paths — see TiledTerrain.js) at arc position
// desiredArcPos: does another one carry on from right there, the same
// way he's going? Either starting there, or passing through — the path
// over a hump runs on down the wall below it, so the path up that wall
// ends partway along it. It has to be heading the way he's travelling,
// and the key he's holding has to keep him going that way along it (a
// curve path can read the keys the other way round — controlsReversed).
// -> [it, where on it he'd now be (the leftover distance carried on)],
// or [null, null]. Port of the same function in lua/entities/Player.lua.
const PATH_JOIN_DISTANCE = 6; // world units: how close it must pass to where this one ends
function findPathContinuation(planet, desiredArcPos) {
  const perimeter = planet.getPerimeter();
  const forward = desiredArcPos > perimeter;
  const edgeArc = forward ? perimeter : 0;
  const edge = planet.worldPointAtArcPosition(edgeArc, 0).point;
  const seg = planet.segmentAtArcPosition ? planet.segmentAtArcPosition(edgeArc) : null;
  if (!seg) return [null, null];
  const dir = forward ? 1 : -1;
  const travelX = seg.tangent.x * dir, travelY = seg.tangent.y * dir;
  const keySign = dir * ((planet.isWallClimb && planet.controlsReversed) ? -1 : 1);
  const leftover = forward ? (desiredArcPos - perimeter) : -desiredArcPos;
  let best = null, bestArc = null, bestD = PATH_JOIN_DISTANCE;
  for (const other of state.planetoids) {
    if (other === planet || !other.isOpenPath || !other.arcPositionForWorldPoint || !other.segmentAtArcPosition) continue;
    const len = other.getPerimeter();
    const a = other.arcPositionForWorldPoint(edge.x, edge.y);
    const p = other.worldPointAtArcPosition(a, 0).point;
    const d = Math.sqrt((p.x - edge.x) ** 2 + (p.y - edge.y) ** 2);
    const oseg = d < bestD ? other.segmentAtArcPosition(a) : null;
    if (!oseg) continue;
    const along = oseg.tangent.x * travelX + oseg.tangent.y * travelY;
    const sigma = along > 0 ? 1 : -1;
    const wanted = keySign * ((other.isWallClimb && other.controlsReversed) ? -1 : 1);
    if (Math.abs(along) > 0.5 && sigma === wanted) {
      const arc = Math.max(0, Math.min(len, a + sigma * leftover));
      // (Not one that just ends here too, the same way: nowhere to go on it.)
      if ((sigma > 0 && a < len - 1) || (sigma < 0 && a > 1)) {
        best = other; bestArc = arc; bestD = d;
      }
    }
  }
  return [best, bestArc];
}

class Movement {
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
      const direction = planet.gravityDirAt(this.pos.x, this.pos.y);
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
    // Running along a cracked planet's wall (see CrackedPlanetoid.walkPlayer):
    // feet to the wall.
    if (this.onSurface && this.climbNormal && this.climbPlanet === planet) {
      return new Vector2(-this.climbNormal.x, -this.climbNormal.y);
    }
    // Anywhere else: feet opposite the planet's own "up" (see
    // js/world/PlanetSurface.js).
    return planet.upAt(this.pos.x, this.pos.y).multiply(-1);
  }

  getOutwardLaunchDirection() {
    if (!this.currentPlanet) return new Vector2(0, -1);
    // Running along a cracked planet's wall: straight off the wall.
    if (this.climbNormal && this.climbPlanet === this.currentPlanet) {
      return new Vector2(this.climbNormal.x, this.climbNormal.y);
    }
    // Anywhere else: the planet's own "up" (see js/world/PlanetSurface.js)
    // — straight out from a round planet, off a rounded rectangle's face,
    // and straight up off the dome's deck and Tiled ground, slopes
    // included.
    return this.currentPlanet.upAt(this.pos.x, this.pos.y);
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
      if (this.currentPlanet.isCrackedPlanet) {
        // (On a cracked planet — see CrackedPlanetoid.js — the carry goes
        // round the planet, the way he was walking, not along the screen.)
        let carry = (this.groundMoveSpeedX ?? 0) * this.jumpMomentumCarryScale;
        carry = Math.max(-this.airControlMaxSpeed, Math.min(this.airControlMaxSpeed, carry));
        this.vel.add(new Vector2(-direction.y, direction.x).multiply(carry));
      } else {
        const carriedVelX = this.vel.x + (this.groundMoveSpeedX ?? 0) * this.jumpMomentumCarryScale;
        this.vel.x = Math.max(-this.airControlMaxSpeed, Math.min(this.airControlMaxSpeed, carriedVelX));
      }
      this.onSurface = false;
      this.currentPlanet = null;
      this.climbNormal = null; this.climbPlanet = null; this.climbDir = null; // (off whatever wall he was running)
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

    // Fired by a plunger (see js/world/Plunger.js): for a while he's
    // driven on its way, faster than he can run, easing back to normal —
    // unless he pushes back the other way, which ends it.
    let boost = this.launchBoost;
    if (boost) {
      boost.time -= state.timeScale;
      boost.mult = 1 + (boost.mult0 - 1) * Math.max(0, boost.time / boost.time0);
      if (boost.time <= 0 || keys[boost.dir > 0 ? 'ArrowLeft' : 'ArrowRight'] || this.isDying) {
        this.launchBoost = null; boost = null;
      }
    }

    if (this.onSurface && this.currentPlanet && this.currentPlanet.isRoundedRect) {
      const planet = this.currentPlanet;
      this.isWalking = false;
      let ds = 0;
      let rawSpeed = constants.PLAYER_LINEAR_SPEED * (state.gamepadRunHeld ? this.runSpeedMultiplier : 1)
        * (this.isBall ? BALL_SPEED_MULTIPLIER : 1);
      if (boost) {
        rawSpeed *= boost.mult;
        keys = { [boost.dir > 0 ? 'ArrowRight' : 'ArrowLeft']: true };
      }
      const speed = rawSpeed * state.timeScale;

      // Unscaled (no state.timeScale) current ground speed+direction —
      // jump() carries this into the jump's own vel.x. Kept separate from
      // ds/speed because vel gets timeScale applied again on its own.
      this.groundMoveSpeedX = 0;

      if (keys['ArrowLeft']) { ds = -speed; this.facingDirection = -1; this.isWalking = true; this.groundMoveSpeedX = -rawSpeed; }
      if (keys['ArrowRight']) { ds = speed; this.facingDirection = 1; this.isWalking = true; this.groundMoveSpeedX = rawSpeed; }

      // On ice (an ice block's top — see WaterSystem.js's "Ice" — or an
      // ice tile of a dirt planet), his footing's slippery: his speed only
      // eases toward what the keys ask for, so he slides on when he lets
      // go and takes a moment to get going or turn round, the way ice is
      // in most platformers. Anywhere else his speed is just what the keys
      // say, as always (kept in iceSlide, so stepping onto ice carries it).
      const onIce = planet.isIce || (planet.iceUnder && planet.iceUnder(this));
      if (onIce) {
        const grip = Math.min(1, ICE_GRIP * state.timeScale);
        this.iceSlide = (this.iceSlide ?? 0) + (ds - (this.iceSlide ?? 0)) * grip;
        if (Math.abs(this.iceSlide) < 0.02) this.iceSlide = 0;
        ds = this.iceSlide;
        this.groundMoveSpeedX = state.timeScale > 0 ? ds / state.timeScale : 0;
      } else {
        this.iceSlide = ds;
      }

      if (planet.walkPlayer) {
        // Planets that walk him themselves (CrackedPlanetoid.js: steps,
        // walls and drops in its dirt).
        planet.walkPlayer(this, ds);
      } else if (planet.isSkyDome) {
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
            let slopeMul = planet.getArcSpeedMultiplier(this.surfaceArcPos, ds);
            // Fired from a plunger (see this.launchBoost), climbing doesn't
            // slow him: the boost only wears off over time.
            if (this.launchBoost && slopeMul < 1) slopeMul = 1;
            ds *= slopeMul;
          }
          // Nor round the inside of a curve: ds is a distance along the
          // ground, and on a curve that bends up into a wall his center
          // (inside it) only covers part of that. Fired from a plunger, the
          // step's stretched so he really moves the full distance.
          if (this.launchBoost && ds !== 0 && planet.isOpenPath) {
            const len = planet.getPerimeter();
            const target = Math.max(0, Math.min(len, this.surfaceArcPos + ds));
            const p = planet.worldPointAtArcPosition(target, this.radius).point;
            const moved = Math.sqrt((p.x - this.pos.x) ** 2 + (p.y - this.pos.y) ** 2);
            const wanted = Math.abs(target - this.surfaceArcPos);
            if (moved > 1e-3 && moved < wanted) ds *= Math.min(2, wanted / moved);
          }

          const desiredArcPos = this.surfaceArcPos + ds;

          // isOpenPath surfaces (a hill has two ends, not a closed loop)
          // fall off the end instead of wrapping around — unless another
          // path carries on from right there, the same way he's going (see
          // findPathContinuation): then he carries on along that one, at
          // any speed, instead of a moment in the air between the two,
          // which at a plunger's launch speed sent him flying off over a
          // hump in a ball tunnel.
          let nextPlanet = null, nextArcPos = null;
          if (planet.isOpenPath && (desiredArcPos < 0 || desiredArcPos > planet.getPerimeter())) {
            [nextPlanet, nextArcPos] = findPathContinuation(planet, desiredArcPos);
          }
          if (nextPlanet) {
            this.currentPlanet = nextPlanet;
            this.surfaceArcPos = nextArcPos;
            this.pos = nextPlanet.worldPointAtArcPosition(nextArcPos, this.radius).point;
          } else if (planet.isOpenPath && (desiredArcPos < 0 || desiredArcPos > planet.getPerimeter())) {
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
            // (Fired from a plunger — this.launchBoost — he keeps ALL of it,
            // and flies off like a cannonball, instead of dropping off near
            // the edge the way walking off one does.)
            const carry = this.launchBoost ? 1 : this.edgeFallCarryFraction;
            this.vel = carryDir.multiply(ds * carry);
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
      && (this.lastInfluencePlanet.isSkyDome || this.lastInfluencePlanet.forceUprightJump || this.submergedIn
        || this.lastInfluencePlanet.isCrackedPlanet)) {
      // Ordinary circular planets deliberately don't get fixed
      // screen-space left/right air control — "sideways" isn't
      // well-defined on a sphere. SkyDome / forceUprightJump surfaces are
      // the exception.
      const lockedDir = this.wallJumpLockTimer > 0 ? this.wallJumpLockBlockedDir : null;

      if (this.submergedIn || this.lastInfluencePlanet.isCrackedPlanet) {
        // (A cracked planet — see CrackedPlanetoid.js — gets this too: he
        // stands upright to its center, so left and right in the air go
        // round it, the same as walking, so he can jump up a ledge in its
        // dirt and steer onto it.)
        //
        // Orbits around the water body's own center — a velocity nudge
        // along the current TANGENT. Only the tangential component is
        // touched; getting farther from the center is NOT something
        // left/right can do (it could carry players out past the shore).
        // Gravity and the swim stroke stay the only radial movers.
        const water = this.submergedIn ?? this.lastInfluencePlanet;
        let radial = this.pos.subtract(water.pos);
        // A planet's own "up" (a cracked planet's depends on its gravity
        // mode); a pool of sprayed water has none, so straight out.
        if (radial.length() <= 0.01) radial = new Vector2(0, -1);
        else if (water.upAt) radial = water.upAt(this.pos.x, this.pos.y);
        else radial.normalize();
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
}

export default Movement;
