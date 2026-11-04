// js/entities/player/Targeting.js
//
// Player methods for the pull beam, target lock, and firing fireballs and
// ice bolts. Copied onto Player by js/entities/Player.js. (A port of
// lua/entities/player/Targeting.lua.)

import love from '../../love/index.js';
import state from '../../state.js';
import constants from '../../constants.js';
import TargetLock from '../../systems/TargetLock.js';
import Fireball from '../Fireball.js';
import IceBolt from '../IceBolt.js';

const ICE_FIRE_COOLDOWN = 0.25; // (seconds — see shootIceBolt)

class Targeting {
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

  // The ice blaster (see WeaponModes.js's 'ice' mode): the same as
  // shootFireball, but an ice bolt (see js/entities/IceBolt.js), a little
  // slower to fire.
  shootIceBolt() {
    if (this.mode !== 'space' && this.mode !== 'platform') return;
    if (this.isBall || this.isTeleporting || this.isDying) return;
    if (this.isCannonRiding()) return;
    if (state.vatsActive) return;

    const now = love.timer.getTime();
    if (now - (this.lastShotTime ?? 0) < ICE_FIRE_COOLDOWN) return;
    this.lastShotTime = now;

    const angle = (this.aimWorldAngle ?? 0) + (this.blasterAngleOffset ?? 0);
    const [originX, originY] = this.getMuzzlePosition();
    state.iceBolts = state.iceBolts ?? [];
    state.iceBolts.push(IceBolt.new(originX, originY, angle));
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
}

export default Targeting;
