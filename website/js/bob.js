// js/bob.js
//
// Bob, drawn with the exact same paperdoll rig/transform math AND the
// exact same anatomy numbers as lua/entities/Player.lua's own
// bodyPartsConfig + drawLimb/drawFullBody/drawRig — not paperdoll.html's
// placeholder DEFAULT_LAYERS (those were rough/guessed and sat the parts
// far too close together). Every offset/joint/pivot value below is
// copied verbatim from Player.lua, just carried in the SAME unscaled rig
// units and multiplied by this file's own SCALE in place of the game's
// bodyScale.

"use strict";

const Bob = (() => {
  // Verbatim from Player.lua's self.bodyPartsConfig (lines ~336-343),
  // plus each limb's src image pointed at website/img/ (a local copy of
  // the game's own img/, kept in sync manually). Draw order below
  // matches drawFullBody's own fixed call order (left boot+arm, body,
  // right boot+arm, head) — NOT a z-sort — since that's what gives the
  // "far" limbs their partial behind-the-body look, independent of
  // which way Bob is currently facing (see the dirSign mirror in
  // Rig.draw).
  // Left arm's offset pulled out as its own constant (not just inline
  // in PARTS) — the pull-beam aiming math below needs the exact same
  // shoulder-attach point drawPart uses for this limb.
  const LEFT_ARM_X = 136, LEFT_ARM_Y = 9;
  const LEFT_BOOT_Y = 241, LEFT_BOOT_JOINT_Y = 15;

  const PARTS = [
    { id: "leftboot", src: "img/leftboot.png", kind: "limb", x: 111, y: LEFT_BOOT_Y, jointX: 83, jointY: LEFT_BOOT_JOINT_Y },
    { id: "leftarm", src: "img/leftarm.png", kind: "limb", x: LEFT_ARM_X, y: LEFT_ARM_Y, jointX: 73, jointY: 199 },
    { id: "body", src: "img/body.png", kind: "body", y: 115 },
    { id: "rightboot", src: "img/rightboot.png", kind: "limb", x: -142, y: 241, jointX: 77, jointY: 15 },
    { id: "rightarm", src: "img/rightarm.png", kind: "limb", x: -186, y: -14, jointX: 119, jointY: 40 },
    { id: "head", src: "img/head.png", kind: "head", y: -150, pivotFraction: 0.9 },
  ];

  const images = {};
  function loadImages() {
    return Promise.all(
      PARTS.map((p) => new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve();
        img.onerror = () => resolve();
        images[p.id] = img;
        img.src = p.src;
      }))
    );
  }

  // Player.lua's own bodyScale is 0.1 (native-res PNGs, hundreds of px
  // tall, against a planet typically hundreds-to-thousands of units in
  // radius). Our hero planets are a lot smaller (r=65), so re-using 0.1
  // verbatim would make Bob comically oversized — SCALE instead targets
  // a standing-height-to-planet-radius ratio in the same spirit as
  // Player.lua's own headReach formula, worked out as:
  //   standingHeight = (groundOffset + |headY|)*SCALE + headH*SCALE*headPivotFraction
  // tuned up from an initial 1:2.5-ish ratio (which read as too small/
  // soft once downscaled that far) to roughly 2:3 against the planet.
  const SCALE = 0.04;
  const GROUND_OFFSET = 250; // Player.lua's self.groundOffset, same rig units as PARTS above
  const WALK_BOB_STRENGTH = 3; // Player.lua's self.walkBobStrength
  const WALK_SPEED = 90; // px/sec along the surface, hero-canvas units
  const STRIDE_RATE = 9;
  // Player.lua's own walkAngle/armSwingScale amplitudes (radians, not
  // degrees) — legs swing opposite each other, both arms sway TOGETHER
  // (Player.lua's mouseIdle sway pose, since the website has no
  // aiming/blaster arm to drive an alternating swing).
  const LEG_SWING = 0.6;
  const ARM_SWING = 0.6 * 0.5;
  const JUMP_DURATION = 0.55;
  const JUMP_ARC_HEIGHT = 50;

  // How far outward from pose.x/y (the literal surface point) a
  // GROUNDED humanoid pose's draw origin needs to sit so the boot
  // SOLE — not just its joint — lands exactly on the surface, instead
  // of sinking in. Player.lua doesn't need this as a separate number:
  // its self.pos already sits self.radius outward from the literal
  // planet edge (two circles resting against each other), and
  // groundOffset/bodyPartsConfig were authored together so the sole
  // lands at that already-offset self.pos. This site's surfacePoint()
  // has no "player radius" — pose.x/y IS the literal edge — so this
  // fills that same gap directly: at rest (baseAngle=0) a boot's sole
  // sits at origin.y + (LEFT_BOOT_Y + bootImageHeight - LEFT_BOOT_JOINT_Y)*SCALE,
  // so using exactly that as the origin's own outward lift cancels it
  // back to zero. Read from the actual loaded image (not a hardcoded
  // height) so it can't quietly drift out of sync with the asset.
  function groundedOriginLift() {
    const bootImg = images.leftboot;
    const bootH = bootImg && bootImg.naturalHeight ? bootImg.naturalHeight : 312;
    return (LEFT_BOOT_Y + bootH - LEFT_BOOT_JOINT_Y) * SCALE;
  }

  // When the target is 2+ planets away, Bob sometimes pull-beams
  // straight there instead of hopping planet to planet — see
  // lua/effects/PullBeam.lua (the beam's own look) and Player.lua's
  // `not self.onSurface` airborne pose + computeLeftArmAimAngle (how
  // he holds himself while pulling: same splayed-legs/raised-arm
  // airborne pose, left arm aimed at the target instead of neutral).
  const PULL_CHANCE = 0.4;
  const PULL_DURATION = 0.8;

  // Player.lua:worldAngleToLocalRotation, verbatim.
  function worldAngleToLocalRotation(desiredWorldAngle, orientation, dirSign) {
    return dirSign > 0 ? desiredWorldAngle - orientation : (orientation + Math.PI) - desiredWorldAngle;
  }

  // Blaster aim-at-mouse + right-click-to-fire — Player.lua's own
  // computeLeftArmAimAngle/maxAimFromForward/mouseIdleThreshold and
  // Player:shootFireball, simplified: only while fully "idle" (standing
  // still, not mid walk/jump/pull/ball — his arms are busy doing other
  // things during those on this site) does the left arm track the
  // cursor instead of hanging neutral. MAX_AIM_FROM_FORWARD matches the
  // game's own 95-degree cone; MOUSE_IDLE_MS matches its 2-second
  // mouseIdleThreshold (no recent mouse movement reverts to a neutral
  // arm instead of tracking a stale target). MUZZLE_LENGTH has no real
  // game equivalent (Player.lua derives its muzzle from the exact
  // blaster-arm sprite pixel) — just a short, plausible "gun barrel"
  // reach for where js/fireball.js's bolts actually spawn from.
  const MAX_AIM_FROM_FORWARD = (95 * Math.PI) / 180;
  const MOUSE_IDLE_MS = 2000;
  const MUZZLE_LENGTH = 14;

  // World-space shoulder attach point for the left (aiming) arm — the
  // ONE formula pullBeamInfo() and the mouse-aim pose below both need,
  // factored out so it isn't duplicated a third time.
  function leftShoulderPoint(originX, originY, orientation) {
    const cos = Math.cos(orientation), sin = Math.sin(orientation);
    const offX = LEFT_ARM_X * SCALE, offY = LEFT_ARM_Y * SCALE;
    return { x: originX + (offX * cos - offY * sin), y: originY + (offX * sin + offY * cos) };
  }

  // Idling too long curls him into a ball (same transformation Bob can
  // do in the actual game — see Player.lua's enterBallMode/isBall and
  // :drawBallMode) and rolls him once around the planet he's standing
  // on before standing back up. BALL_LINE_COLOR/BALL_CENTER_FILL_COLOR/
  // BALL_CENTER_RADIUS_FRACTION below are Player.lua's own ball-mode
  // constants, verbatim. BALL_RADIUS/BALL_SPIN_SPEED are this file's
  // own — there's no in-game equivalent to scale against since the
  // website has no real collision radius, just a size that reads well
  // against the rig's own standing height.
  const IDLE_BEFORE_BALL_SECONDS = 10;
  const BALL_RADIUS = 14;
  const BALL_SPIN_SPEED = 150; // px/sec along the surface — brisker than WALK_SPEED
  const BALL_LINE_COLOR = "#9c9b9b";
  const BALL_CENTER_FILL_COLOR = "#6ae7eb";
  const BALL_CENTER_RADIUS_FRACTION = 1 / 3;

  // Curl-in/stand-up transition — a direct port of Player.lua's own
  // BALL_MORPH_STANDING_POSE/FRAME_1/FRAME_2 + drawBallMorphTransition:
  // two authored keyframes the rig blends through (STANDING -> FRAME_1
  // -> FRAME_2 curling in, reversed standing back up), each segment
  // BALL_MORPH_SEGMENT_TICKS (8) baseline-60fps ticks — converted here
  // to seconds (8/60) since this file works in dt-seconds throughout.
  // It cuts directly from FRAME_2 to the actual rolling ball (and back)
  // with no cross-fade, same as the game.
  const BALL_MORPH_SEGMENT_DURATION = 8 / 60;

  const BALL_MORPH_STANDING_POSE = {
    leftBootX: 111, leftBootY: 241, leftBootAngle: 0,
    leftArmX: 136, leftArmY: 9, leftArmAngle: 0,
    bodyY: 115,
    rightBootX: -142, rightBootY: 241, rightBootAngle: 0,
    rightArmX: -186, rightArmY: -14, rightArmAngle: 0,
    headY: -150, headAngle: 0,
  };
  const BALL_MORPH_FRAME_1 = {
    leftBootX: 111, leftBootY: 241, leftBootAngle: 0,
    leftArmX: 143.01, leftArmY: 131.67, leftArmAngle: (40 * Math.PI) / 180,
    bodyY: 206.13,
    rightBootX: -142, rightBootY: 241, rightBootAngle: 0,
    rightArmX: -182.5, rightArmY: 98.16, rightArmAngle: (-31 * Math.PI) / 180,
    headY: 18.24, headAngle: 0,
  };
  const BALL_MORPH_FRAME_2 = {
    leftBootX: 111, leftBootY: 195.44, leftBootAngle: (32 * Math.PI) / 180,
    leftArmX: -130.37, leftArmY: 163.22, leftArmAngle: (40 * Math.PI) / 180,
    bodyY: 328.8,
    rightBootX: -134.99, rightBootY: 167.4, rightBootAngle: (-9 * Math.PI) / 180,
    rightArmX: -143.95, rightArmY: 213.82, rightArmAngle: (-43 * Math.PI) / 180,
    headY: 312.65, headAngle: (25 * Math.PI) / 180,
  };

  function lerpMorphPose(a, b, t) {
    const out = {};
    for (const key in a) out[key] = a[key] + (b[key] - a[key]) * t;
    return out;
  }

  // Player.lua:drawBallMorphTransition's own keyframe-pair selection,
  // verbatim — which two keyframes are being blended, and how far,
  // depends on both the direction (phase) and elapsed time.
  function computeMorphPose(b) {
    const seg = BALL_MORPH_SEGMENT_DURATION;
    const segT = Math.min(1, b.morphElapsed / seg);
    if (b.phase === "toBall") {
      if (b.morphElapsed < seg) return lerpMorphPose(BALL_MORPH_STANDING_POSE, BALL_MORPH_FRAME_1, segT);
      const t2 = Math.min(1, (b.morphElapsed - seg) / seg);
      return lerpMorphPose(BALL_MORPH_FRAME_1, BALL_MORPH_FRAME_2, t2);
    }
    // "toHuman" — same two keyframes, played in reverse.
    if (b.morphElapsed < seg) return lerpMorphPose(BALL_MORPH_FRAME_2, BALL_MORPH_FRAME_1, segT);
    const t2 = Math.min(1, (b.morphElapsed - seg) / seg);
    return lerpMorphPose(BALL_MORPH_FRAME_1, BALL_MORPH_STANDING_POSE, t2);
  }

  // orientation 0 == standing upright at the TOP of a circle, where the
  // outward normal is -y/up. Hand-verified against two cases: at the
  // top (angle=-PI/2) this gives 0 (upright, correct); at the right
  // side (angle=0) this gives PI/2 (rotated 90 deg to stand on the
  // side surface, correct).
  const REST_ANGLE = -Math.PI / 2;
  function orientationForAngle(angle) {
    return angle + Math.PI / 2;
  }

  // Direct port of paperdoll.html's attachPoint/drawLayerImage:
  // translate to origin + R(baseAngle)*(offsetX,offsetY)*scale, THEN
  // rotate the context — the offset itself always gets rotated by
  // baseAngle too (for every kind, including body/head), so a part's
  // placement swings correctly around Bob's own tilt rather than
  // staying pinned to world-up as he leans along a planet's curve.
  function drawPart(ctx, part, originX, originY, baseAngle, scale) {
    const img = images[part.id];
    if (!img || !img.complete || !img.naturalWidth) return;

    const offX = (part.x || 0) * scale;
    const offY = (part.y || 0) * scale;
    const cos = Math.cos(baseAngle);
    const sin = Math.sin(baseAngle);
    const worldX = originX + (offX * cos - offY * sin);
    const worldY = originY + (offX * sin + offY * cos);

    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;

    ctx.save();
    ctx.translate(worldX, worldY);

    if (part.kind === "head") {
      // Player.lua: love.graphics.draw(images.head, -headW*s/2, -pivotY, ...)
      // — X is always centered; only Y uses headPivotFraction.
      ctx.rotate(baseAngle + (part.angle || 0));
      const frac = part.pivotFraction != null ? part.pivotFraction : 0.5;
      ctx.drawImage(img, -w / 2, -h * frac, w, h);
    } else if (part.kind === "body") {
      ctx.rotate(baseAngle);
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
    } else {
      // limb: rotate by baseAngle+part.angle, optional horizontal
      // flip, draw anchored at its own joint point.
      ctx.rotate(baseAngle + (part.angle || 0));
      if (part.flip) ctx.scale(-1, 1);
      ctx.drawImage(img, -part.jointX * scale, -part.jointY * scale, w, h);
    }
    ctx.restore();
  }

  class Rig {
    constructor(planetDefs) {
      this.planets = planetDefs;
      this.planetIdx = 0;
      this.surfaceAngle = REST_ANGLE;
      this.mode = "idle"; // idle | running | jumping | pulling | ballSpin
      this.walkPhase = 0;
      this.hopQueue = [];
      this.facing = 1; // Player.lua's dirSign: +1 or -1, mirrors the whole rig
      this._pendingGoTo = null; // a goTo() received mid-pull, applied once it lands
      this._finalTargetIdx = 0; // where the current trip (if any) ultimately ends
      this._idleTimer = 0; // seconds spent continuously idle — see IDLE_BEFORE_BALL_SECONDS
      this._lastWalkBobT = 0; // Player.lua's self.lastWalkBobT — see _updateFootstepDust
      this.aimX = null; // hero-canvas logical coords, set each frame by js/main.js — see setAimTarget
      this.aimY = null;
      this.mouseIdle = true;

      this._run = null;
      this._jump = null;
      this._pull = null;
      this._ballSpin = null;
    }

    currentPlanetIndex() {
      return this.planetIdx;
    }

    // Head for targetIdx. While WALKING (idle, running, or the settle-
    // back-to-top leg) a new target takes over immediately — abandons
    // whatever leg is in progress and redirects right from his current
    // spot, not just once that leg finishes. Mid-JUMP or mid-PULL he
    // can't change course in the air/beam, so the request is remembered
    // and re-issued the moment he lands (see update()'s jump/pull
    // completion and _pendingGoTo).
    goTo(targetIdx) {
      if (targetIdx === this.planetIdx && this.mode === "idle") return;
      // Already on our way there (or already arrived and settling there)
      // — don't restart the leg from scratch for a redundant call.
      if (this.mode !== "idle" && targetIdx === this._finalTargetIdx) return;

      if (this.mode === "pulling") {
        this._pendingGoTo = targetIdx;
        return;
      }

      if (this.mode === "jumping") {
        this._finalTargetIdx = targetIdx;
        this.hopQueue = this._computeHopPath(targetIdx);
        return;
      }

      // 2+ planets away, starting fresh from a standstill — sometimes
      // skip the hop-by-hop walk/jump entirely and pull-beam straight
      // to the target instead.
      if (this.mode === "idle" && Math.abs(targetIdx - this.planetIdx) >= 2 && Math.random() < PULL_CHANCE) {
        this._finalTargetIdx = targetIdx;
        this._beginPull(targetIdx);
        return;
      }

      // Idle, or running/settling and redirecting mid-leg.
      this._finalTargetIdx = targetIdx;
      this.hopQueue = this._computeHopPath(targetIdx);
      this._beginNextLeg();
    }

    _computeHopPath(targetIdx) {
      const path = [];
      let i = this.planetIdx;
      while (i !== targetIdx) {
        i += targetIdx > i ? 1 : -1;
        path.push(i);
      }
      return path;
    }

    // Straight-line pull-beam flight from wherever he's currently
    // resting to the TOP of the target planet (same REST_ANGLE spot
    // he'd eventually settle at via the normal hop-by-hop path), fully
    // bypassing the hop queue.
    _beginPull(targetIdx) {
      const fromPlanet = this.planets[this.planetIdx];
      const toPlanet = this.planets[targetIdx];
      const fromPoint = surfacePoint(fromPlanet, this.surfaceAngle);
      const toPoint = surfacePoint(toPlanet, REST_ANGLE);
      this.facing = toPoint.x >= fromPoint.x ? 1 : -1;
      this.hopQueue = [];
      this.mode = "pulling";
      this._pull = { targetIdx, fromPoint, toPoint, t: 0 };
    }

    _beginNextLeg() {
      if (this.hopQueue.length === 0) {
        // Arrived — walk back to the top of this planet and stand
        // there, rather than leaving Bob stranded at whichever edge
        // he last jumped in on.
        if (Math.abs(shortestDelta(this.surfaceAngle, REST_ANGLE)) > 0.001) {
          this._beginSettle();
        } else {
          this.mode = "idle";
        }
        return;
      }
      const nextIdx = this.hopQueue[0];
      const onSamePlanet = nextIdx === this.planetIdx;
      if (onSamePlanet) {
        this.hopQueue.shift();
        this._beginNextLeg();
        return;
      }
      this._beginRunToEdge(nextIdx > this.planetIdx ? 1 : -1, nextIdx);
    }

    // Run from the current surfaceAngle to the near edge of the
    // current planet (facing the target), then jump across the gap.
    //
    // surfaceAngle isn't always a clean "top or edge" value when this
    // starts — goTo() now redirects mid-run, so this can begin from
    // ANYWHERE partway across the visible arc (e.g. reversing
    // direction). So the leg is built as up to two waypoints: first
    // (if not already there) the shortest way back to REST_ANGLE —
    // always safe since every reachable surfaceAngle here is already
    // within the visible top semicircle, at most a quarter turn from
    // REST_ANGLE — then a fixed FORCED-direction quarter turn from
    // there out to the edge. The quarter turn is always exactly
    // dir*PI/2 because REST_ANGLE sits precisely equidistant between
    // both edges, which is what keeps this leg on the visible arc
    // instead of ever risking the hidden underside.
    _beginRunToEdge(dir, nextIdx) {
      const waypoints = [];
      let from = this.surfaceAngle;
      const toTop = shortestDelta(from, REST_ANGLE);
      if (Math.abs(toTop) > 0.001) {
        from += toTop;
        waypoints.push(from);
      }
      waypoints.push(from + dir * (Math.PI / 2));

      this.mode = "running";
      this.facing = dir;
      this._run = { nextIdx, waypoints, wpIndex: 0 };
    }

    // Walk back to the resting spot (top of the current planet) via
    // the SHORTER way around, with no jump at the end — used once the
    // hop queue drains.
    _beginSettle() {
      const delta = shortestDelta(this.surfaceAngle, REST_ANGLE);
      const dir = delta >= 0 ? 1 : -1;
      this.mode = "running";
      this.facing = dir;
      this._run = { nextIdx: null, waypoints: [this.surfaceAngle + delta], wpIndex: 0 };
    }

    // Curl into a ball and roll once all the way around the current
    // planet, in a random direction, then pop back out standing —
    // triggered after IDLE_BEFORE_BALL_SECONDS of doing nothing (see
    // update()'s idle branch). Only ever starts from a standstill, so
    // this.surfaceAngle is always REST_ANGLE here already.
    _beginBallSpin() {
      const dir = Math.random() < 0.5 ? 1 : -1;
      this.mode = "ballSpin";
      this.facing = dir;
      this._ballSpin = {
        dir,
        startAngle: this.surfaceAngle,
        traveled: 0,
        rollAngle: 0,
        phase: "toBall", // toBall | spin | toHuman — see Player.lua's morphState
        morphElapsed: 0,
      };
    }

    // Port of Player.lua:spawnWalkDust — ties dust to actual FOOTSTEPS
    // (walkPhase's own bob crossing back above a high threshold, once
    // per planted leg) rather than a flat per-frame chance, so it reads
    // as real footfalls kicking up dust rather than a trailing spark.
    // Called identically from the walking AND ball-rolling branches of
    // update() (see those call sites) — same as the game, where
    // spawnWalkDust() doesn't care whether isBall is set, just whether
    // he's actively moving on a surface.
    _updateFootstepDust() {
      const bobT = Math.sin(this.walkPhase) ** 2;
      const justPlanted = bobT > 0.85 && this._lastWalkBobT <= 0.85;
      this._lastWalkBobT = bobT;
      if (!justPlanted) return;

      // "Down" is simply toward the planet's own center on our plain
      // circular planets — no slopes/terrain to special-case the way
      // Player.lua's visualDownDirection has to.
      const intoX = Math.cos(this.surfaceAngle), intoY = Math.sin(this.surfaceAngle);
      const sideX = -intoY, sideY = intoX;
      const feet = surfacePoint(this.planets[this.planetIdx], this.surfaceAngle);
      const puffCount = 2 + Math.floor(Math.random() * 2); // 2-3, DustPuff.lua's walking (non-running) baseline
      Dust.spawn(feet.x, feet.y, intoX, intoY, sideX, sideY, puffCount, 2.5, 0.2, 0.6);
    }

    _beginJump(nextIdx) {
      const from = this.planets[this.planetIdx];
      const to = this.planets[nextIdx];
      const dir = nextIdx > this.planetIdx ? 1 : -1;
      // Departure point is wherever the run leg actually landed
      // (should already be ~0 or ~-PI, but read the live value rather
      // than re-assuming the canonical constant). Arrival lands on the
      // FAR planet's near edge (facing back the way Bob came) — the
      // opposite side from where he departed — as a FRESH independent
      // angle on that planet, so the canonical -PI/0 convention is
      // exactly right there.
      const fromAngle = this.surfaceAngle;
      const toAngle = dir > 0 ? -Math.PI : 0;
      const fromPoint = surfacePoint(from, fromAngle);
      const toPoint = surfacePoint(to, toAngle);
      this.mode = "jumping";
      this._jump = {
        nextIdx,
        fromPoint,
        toPoint,
        fromOrientation: orientationForAngle(fromAngle),
        toOrientation: orientationForAngle(toAngle),
        t: 0,
      };
    }

    update(dt) {
      // Only the idle branch (bottom of this method) ever increments
      // this — any other mode running even one tick means he wasn't
      // continuously idle, so the clock restarts.
      if (this.mode !== "idle") this._idleTimer = 0;

      if (this.mode === "running") {
        const r = this._run;
        const planet = this.planets[this.planetIdx];
        const target = r.waypoints[r.wpIndex];
        const remaining = target - this.surfaceAngle;
        // Direction for THIS waypoint, not a fixed leg-wide value —
        // the optional "back to top" waypoint can run either way
        // depending on where the leg started (see _beginRunToEdge).
        // Facing tracks it live too, so a reversal mid-redirect turns
        // him around instead of having him walk backwards.
        const dirNow = remaining >= 0 ? 1 : -1;
        this.facing = dirNow;
        const step = (WALK_SPEED / planet.r) * dt * dirNow;
        this.walkPhase += dt * STRIDE_RATE;
        if (Math.abs(step) >= Math.abs(remaining)) {
          this.surfaceAngle = target;
          r.wpIndex++;
          if (r.wpIndex < r.waypoints.length) {
            // More waypoints on this same leg — keep going.
          } else if (r.nextIdx === null) {
            this.mode = "idle";
          } else {
            this._beginJump(r.nextIdx);
          }
        } else {
          this.surfaceAngle += step;
        }
        this._updateFootstepDust();
        return;
      }

      if (this.mode === "jumping") {
        const j = this._jump;
        j.t += dt / JUMP_DURATION;
        this.walkPhase += dt * STRIDE_RATE * 0.6;
        if (j.t >= 1) {
          this.planetIdx = j.nextIdx;
          this.surfaceAngle = j.toOrientation - Math.PI / 2; // back to local-angle terms
          this.hopQueue.shift();
          this.mode = "idle";
          this._beginNextLeg();
        }
        return;
      }

      if (this.mode === "pulling") {
        const p = this._pull;
        p.t += dt / PULL_DURATION;
        if (p.t >= 1) {
          this.planetIdx = p.targetIdx;
          this.surfaceAngle = REST_ANGLE;
          this.mode = "idle";
          const pending = this._pendingGoTo;
          this._pendingGoTo = null;
          if (pending !== null) this.goTo(pending);
        }
        return;
      }

      if (this.mode === "ballSpin") {
        const b = this._ballSpin;
        const planet = this.planets[this.planetIdx];

        if (b.phase === "toBall" || b.phase === "toHuman") {
          b.morphElapsed += dt;
          if (b.morphElapsed >= BALL_MORPH_SEGMENT_DURATION * 2) {
            if (b.phase === "toBall") {
              b.phase = "spin";
            } else {
              this.mode = "idle";
            }
          }
          return;
        }

        // phase === "spin" — rolling without slipping: the ball's own
        // spin (rollAngle) advances by distance-traveled/BALL_RADIUS,
        // same relationship as Player.lua's ballRollAngle += ds/self.
        // radius — distance traveled this tick is just BALL_SPIN_SPEED
        // *dt by construction (that's what angularStep below is built
        // from, via the planet's own radius).
        const angularStep = (BALL_SPIN_SPEED / planet.r) * dt * b.dir;
        this.surfaceAngle += angularStep;
        b.traveled += Math.abs(angularStep);
        b.rollAngle += (BALL_SPIN_SPEED * dt / BALL_RADIUS) * b.dir;
        if (b.traveled >= Math.PI * 2) {
          this.surfaceAngle = b.startAngle; // snap off any overshoot from the last discrete step
          b.phase = "toHuman";
          b.morphElapsed = 0;
        }
        // Player.lua's spawnWalkDust() is called identically whether
        // isBall or not — it's the same self.isWalking/walkTime-driven
        // footstep detection either way, just rolling instead of
        // striding. walkPhase isn't otherwise used while a ball (no
        // limb swing to drive), so it's free to reuse here as that
        // same cadence.
        this.walkPhase += dt * STRIDE_RATE;
        this._updateFootstepDust();
        return;
      }

      // idle: walk-cycle settles back to a neutral stand, and the
      // longer he stays here the closer he gets to curling into a ball.
      this.walkPhase += dt * 2;
      this._idleTimer += dt;
      if (this._idleTimer >= IDLE_BEFORE_BALL_SECONDS) {
        this._beginBallSpin();
      }
    }

    // Returns {x, y, orientation} in hero-canvas units.
    currentPose() {
      if (this.mode === "jumping") {
        const j = this._jump;
        const t = Math.min(j.t, 1);
        const x = lerp(j.fromPoint.x, j.toPoint.x, t);
        const yLinear = lerp(j.fromPoint.y, j.toPoint.y, t);
        const arc = Math.sin(t * Math.PI) * JUMP_ARC_HEIGHT;
        const orientation = lerpAngle(j.fromOrientation, j.toOrientation, t);
        return { x, y: yLinear - arc, orientation };
      }

      if (this.mode === "pulling") {
        const p = this._pull;
        const t = Math.min(p.t, 1);
        // Smoothstep — eases into and back out of the pull rather than
        // a constant-speed slide, closer to the "yanked, then settles"
        // feel of applyPullForce's own velocity-based pull.
        const eased = t * t * (3 - 2 * t);
        const x = lerp(p.fromPoint.x, p.toPoint.x, eased);
        const y = lerp(p.fromPoint.y, p.toPoint.y, eased);
        return { x, y, orientation: 0 }; // both ends are REST_ANGLE tops — stays upright throughout
      }

      const planet = this.planets[this.planetIdx];
      const p = surfacePoint(planet, this.surfaceAngle);
      return { x: p.x, y: p.y, orientation: orientationForAngle(this.surfaceAngle) };
    }

    // World-space shoulder attach point for the left (aiming) arm —
    // same point PullBeam.lua's own originX/Y (player.aimShoulderPos)
    // is, and where js/main.js anchors the pull-beam's drawn origin.
    // Returns null outside "pulling" mode.
    pullBeamInfo() {
      if (this.mode !== "pulling") return null;
      const pose = this.currentPose();
      const outwardX = Math.cos(pose.orientation - Math.PI / 2);
      const outwardY = Math.sin(pose.orientation - Math.PI / 2);
      const originX = pose.x + outwardX * GROUND_OFFSET * SCALE;
      const originY = pose.y + outwardY * GROUND_OFFSET * SCALE;
      const shoulder = leftShoulderPoint(originX, originY, pose.orientation);
      // PullBeam.lua draws to the TARGET'S CENTER (target.pos) and
      // outlines its full radius — not the surface point Bob himself
      // is flying to land on.
      const toPlanet = this.planets[this._pull.targetIdx];
      return {
        originX: shoulder.x,
        originY: shoulder.y,
        targetX: toPlanet.cx,
        targetY: toPlanet.cy,
        targetRadius: toPlanet.r,
      };
    }

    // Called every frame from js/main.js with the mouse's position in
    // hero-canvas logical coordinates (works even when the cursor is
    // outside the canvas's own bounds — atan2 doesn't care) and
    // whether it's been idle (Player.lua's own mouseIdleThreshold).
    setAimTarget(x, y, idle) {
      this.aimX = x;
      this.aimY = y;
      this.mouseIdle = idle;
    }

    // Player.lua:computeLeftArmAimAngle + the facing-flip half of
    // updateOrientationAndFacing, simplified to a direct point-at (see
    // this file's own MAX_AIM_FROM_FORWARD comment for why). Only valid
    // (and only called) while fully idle — returns the muzzle spawn
    // point/world angle js/main.js needs to fire a fireball, or null
    // when he can't currently aim/fire at all.
    _computeAim() {
      if (this.mode !== "idle" || this.aimX == null || this.mouseIdle) return null;

      const pose = this.currentPose();
      const outwardX = Math.cos(pose.orientation - Math.PI / 2);
      const outwardY = Math.sin(pose.orientation - Math.PI / 2);
      const originX = pose.x + outwardX * groundedOriginLift();
      const originY = pose.y + outwardY * groundedOriginLift();
      const shoulder = leftShoulderPoint(originX, originY, pose.orientation);

      const desiredWorldAngle = Math.atan2(this.aimY - shoulder.y, this.aimX - shoulder.x);

      // Which side of him the cursor is actually on decides facing —
      // the "natural"/unmirrored forward direction at this orientation
      // is (cos,sin)(orientation); whichever half-plane of that the
      // cursor falls in is which way he should face, independent of
      // whichever way he happened to be facing a moment ago.
      const toTargetX = this.aimX - shoulder.x, toTargetY = this.aimY - shoulder.y;
      const forwardDot = toTargetX * Math.cos(pose.orientation) + toTargetY * Math.sin(pose.orientation);
      const dirSign = forwardDot >= 0 ? 1 : -1;

      const forwardAngle = dirSign > 0 ? pose.orientation : pose.orientation + Math.PI;
      const relative = Math.max(-MAX_AIM_FROM_FORWARD, Math.min(MAX_AIM_FROM_FORWARD, shortestDelta(forwardAngle, desiredWorldAngle)));
      const clampedWorldAngle = forwardAngle + relative;
      const armAngle = worldAngleToLocalRotation(clampedWorldAngle, pose.orientation, dirSign);

      return {
        dirSign,
        armAngle,
        worldAngle: clampedWorldAngle,
        muzzleX: shoulder.x + Math.cos(clampedWorldAngle) * MUZZLE_LENGTH,
        muzzleY: shoulder.y + Math.sin(clampedWorldAngle) * MUZZLE_LENGTH,
      };
    }

    // Public entry point for js/main.js's click handler — returns
    // {x, y, angle} to spawn a fireball from/along, or null when he's
    // not currently able to fire (mid walk/jump/pull/ball, or no aim
    // target yet/mouse gone idle). Firing counts as "doing something,"
    // not idling — resets the ball-spin idle clock so he doesn't curl
    // up mid-firefight just because he hasn't walked anywhere.
    getBlasterMuzzle() {
      const aim = this._computeAim();
      if (!aim) return null;
      this._idleTimer = 0;
      return { x: aim.muzzleX, y: aim.muzzleY, angle: aim.worldAngle };
    }

    draw(ctx) {
      const pose = this.currentPose();

      if (this.mode === "ballSpin") {
        const b = this._ballSpin;
        if (b.phase === "spin") {
          this._drawBall(ctx, pose);
        } else {
          this._drawMorphPose(ctx, pose, computeMorphPose(b));
        }
        return;
      }

      const jumping = this.mode === "jumping";
      const pulling = this.mode === "pulling";
      const running = this.mode === "running";

      let angles, flips;
      if (jumping || pulling) {
        // Player.lua's drawFullBody airborne pose (the `not
        // self.onSurface` branch, which also covers an active pull —
        // applyPullForce only ever runs while airborne): legs snap to
        // a fixed splayed pose (not a walk-cycle) and the right arm
        // throws up into a raised world-space angle via
        // worldAngleToLocalRotation, mirrored. Ported as literally as
        // the formula allows — same constants, same dirSign-branching,
        // just JS instead of Lua.
        const dirSign = this.facing;
        const raisedWorldAngle = -Math.PI / 2 - Math.PI * 0.75 * dirSign;
        const rightArmAngle = dirSign > 0
          ? raisedWorldAngle - pose.orientation
          : (pose.orientation + Math.PI) - raisedWorldAngle;

        // While pulling, the left arm aims at the pull target instead
        // of hanging neutral — Player.lua's computeLeftArmAimAngle
        // does the equivalent (aiming at pullTarget via
        // getPullAnchor/aimRelativeAngle); this is the same idea
        // simplified to a direct point-at, since the website has no
        // separate aim-vs-facing distinction to track.
        let leftArmAngle = 0;
        if (pulling) {
          const info = this.pullBeamInfo();
          const worldAngleToTarget = Math.atan2(info.targetY - info.originY, info.targetX - info.originX);
          leftArmAngle = worldAngleToLocalRotation(worldAngleToTarget, pose.orientation, dirSign);
        }

        angles = { leftboot: -0.7, rightboot: 0.7, leftarm: leftArmAngle, rightarm: rightArmAngle };
        flips = { rightarm: true };
      } else {
        const swing = running ? Math.sin(this.walkPhase) : 0;
        const legSwing = swing * LEG_SWING;
        const armSwing = swing * ARM_SWING;
        // Player.lua's drawFullBody: left boot opposite right boot,
        // both arms swaying TOGETHER (see the idle-sway comment on
        // ARM_SWING).
        angles = { leftboot: legSwing, rightboot: -legSwing, leftarm: armSwing, rightarm: armSwing };
        flips = {};

        // Idle + a live, non-stale mouse target: track the cursor with
        // the left (blaster) arm and face whichever side it's actually
        // on, same as Player.lua's mouse-aim — see _computeAim.
        const aim = this._computeAim();
        if (aim) {
          angles.leftarm = aim.armAngle;
          this.facing = aim.dirSign;
        }
      }

      // Rig draw origin = the surface contact point, shifted OUTWARD
      // (away from the planet, toward the sky) — same as Player.lua's
      // visualPos (self.pos + outwardDir * groundOffset*bodyScale), not
      // the bare contact point itself. GROUNDED poses (walking/idle)
      // use groundedOriginLift() instead of the plain groundOffset*SCALE
      // so the boot SOLE lands on the surface (see that function's own
      // comment); jumping/pulling stays on the plain lift since he's
      // airborne there anyway — nothing about the splayed-leg pose
      // needs to calibrate against the ground.
      const outwardX = Math.cos(pose.orientation - Math.PI / 2);
      const outwardY = Math.sin(pose.orientation - Math.PI / 2);
      const liftUnits = (jumping || pulling) ? GROUND_OFFSET * SCALE : groundedOriginLift();
      let originX = pose.x + outwardX * liftUnits;
      let originY = pose.y + outwardY * liftUnits;

      // Footstep bob — sinks the whole rig toward the ground a little
      // at the midpoint of each stride (Player.lua's walkBobAmount),
      // applied along the rig's own local "down" (cos/sin of orientation,
      // not outward/up).
      const walkBobT = running ? Math.sin(this.walkPhase) ** 2 : 0;
      const bobAmount = walkBobT * WALK_BOB_STRENGTH;
      originX += -Math.sin(pose.orientation) * bobAmount * SCALE;
      originY += Math.cos(pose.orientation) * bobAmount * SCALE;

      // Facing mirror — Player.lua:drawRig wraps the whole rig in
      // translate(pos) -> rotate(orientation) -> scale(dirSign,1) ->
      // rotate(-orientation) -> translate(-pos), centered on the
      // SURFACE contact point (pose.x/y), not the shifted rig origin.
      ctx.save();
      ctx.translate(pose.x, pose.y);
      ctx.rotate(pose.orientation);
      ctx.scale(this.facing, 1);
      ctx.rotate(-pose.orientation);
      ctx.translate(-pose.x, -pose.y);

      for (const part of PARTS) {
        drawPart(ctx, { ...part, angle: angles[part.id] || 0, flip: flips[part.id] || false }, originX, originY, pose.orientation, SCALE);
      }
      ctx.restore();
    }

    // Port of Player.lua:drawBallMode — a plain filled circle, three
    // spoke lines 120deg apart, an outline, and a small center "eye"
    // circle, spun by orientation+rollAngle. Only ever drawn during the
    // "spin" phase — the curl-in/stand-up transition itself is
    // _drawMorphPose below, cutting directly to/from this with no
    // cross-fade, same as the game.
    _drawBall(ctx, pose) {
      const b = this._ballSpin;

      // Rests ON the surface the same way standing does — center
      // lifted above the contact point by its own radius, along the
      // same outward direction GROUND_OFFSET uses for standing.
      const outwardX = Math.cos(pose.orientation - Math.PI / 2);
      const outwardY = Math.sin(pose.orientation - Math.PI / 2);
      const cx = pose.x + outwardX * BALL_RADIUS;
      const cy = pose.y + outwardY * BALL_RADIUS;
      const r = BALL_RADIUS;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(pose.orientation + b.rollAngle);

      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = BALL_LINE_COLOR;
      ctx.lineWidth = Math.max(1, r * 0.12 - 1);
      for (let i = 0; i < 3; i++) {
        const a = i * (Math.PI * 2 / 3);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();

      const centerR = r * BALL_CENTER_RADIUS_FRACTION;
      ctx.fillStyle = BALL_CENTER_FILL_COLOR;
      ctx.beginPath();
      ctx.arc(0, 0, centerR, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = BALL_LINE_COLOR;
      ctx.beginPath();
      ctx.arc(0, 0, centerR, 0, Math.PI * 2);
      ctx.stroke();

      ctx.restore();
    }

    // Port of Player.lua:drawBallMorphTransition/drawBallMorphPose —
    // draws one blended curl-in/stand-up keyframe (see
    // computeMorphPose) with the humanoid rig's own drawPart, same
    // facing-mirror wrapper draw() itself uses, and the same fixed
    // left-boot/left-arm/body/right-boot/right-arm/head order.
    _drawMorphPose(ctx, pose, morphPose) {
      // Same grounded lift draw()'s own standing/walking path uses
      // (see groundedOriginLift) — he's curling in/standing back up in
      // place on the surface, not airborne, so the same "sole lands on
      // the ground" calibration applies here too.
      const outwardX = Math.cos(pose.orientation - Math.PI / 2);
      const outwardY = Math.sin(pose.orientation - Math.PI / 2);
      const liftUnits = groundedOriginLift();
      const originX = pose.x + outwardX * liftUnits;
      const originY = pose.y + outwardY * liftUnits;

      ctx.save();
      ctx.translate(pose.x, pose.y);
      ctx.rotate(pose.orientation);
      ctx.scale(this.facing, 1);
      ctx.rotate(-pose.orientation);
      ctx.translate(-pose.x, -pose.y);

      const parts = [
        { id: "leftboot", kind: "limb", x: morphPose.leftBootX, y: morphPose.leftBootY, jointX: 83, jointY: 15, angle: morphPose.leftBootAngle },
        { id: "leftarm", kind: "limb", x: morphPose.leftArmX, y: morphPose.leftArmY, jointX: 73, jointY: 199, angle: morphPose.leftArmAngle },
        { id: "body", kind: "body", y: morphPose.bodyY },
        { id: "rightboot", kind: "limb", x: morphPose.rightBootX, y: morphPose.rightBootY, jointX: 77, jointY: 15, angle: morphPose.rightBootAngle },
        { id: "rightarm", kind: "limb", x: morphPose.rightArmX, y: morphPose.rightArmY, jointX: 119, jointY: 40, angle: morphPose.rightArmAngle },
        { id: "head", kind: "head", y: morphPose.headY, pivotFraction: 0.9, angle: morphPose.headAngle },
      ];
      for (const part of parts) {
        drawPart(ctx, part, originX, originY, pose.orientation, SCALE);
      }
      ctx.restore();
    }
  }

  function surfacePoint(planet, angle) {
    return {
      x: planet.cx + Math.cos(angle) * planet.r,
      y: planet.cy + Math.sin(angle) * planet.r,
    };
  }

  function lerp(a, b, t) { return a + (b - a) * t; }
  // Rotates the SHORT way around, regardless of which raw numeric
  // representation a/b happen to use — so the jump's visual tilt
  // never takes an unintended long way round.
  function lerpAngle(a, b, t) { return a + shortestDelta(a, b) * t; }

  // Signed delta from `from` to `to`, wrapped to the shorter way
  // around the circle (range (-PI, PI]) — used only for the settle-
  // back-to-top leg, since the hop-to-hop running legs are always
  // explicit quarter-circle moves whose direction is already known.
  function shortestDelta(from, to) {
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  async function init() {
    await loadImages();
  }

  return { Rig, REST_ANGLE, init, MOUSE_IDLE_MS };
})();
