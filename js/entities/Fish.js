// js/entities/Fish.js
//
// Small ambient wildlife for WaterPlanet.js's water body — a solid,
// orange "ichthys" (the classic two-arc "Jesus fish" outline, here
// filled rather than just an outline) that wanders freely inside the
// water sphere and occasionally emits an air bubble, using the same
// radial (angle + distance-from-water-center) bubble motion Player.js's
// own swimming already uses.

import love from '../love/index.js';
import lua from '../love/lua.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import Splash from '../effects/Splash.js';

// ---------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------
const FISH_LENGTH = 68; // nose-to-tail-tip, world units
const FISH_COLOR = [1.0, 0.45, 0.05];

const SWIM_SPEED_MIN = 1.4; // world units per baseline (60fps) frame
const SWIM_SPEED_MAX = 2.4;
const TURN_RATE = 0.05;     // radians per baseline frame the heading eases toward its target — keeps turns smooth instead of snapping to face the target instantly

// Kept away from both the water's own true edge and its solid core (see
// WaterPlanet.js) — wandering right up to either would mean clipping
// through the seabed or swimming out past the wavy shoreline.
const WANDER_RADIUS_MARGIN = 40;
const WANDER_CORE_MARGIN = 50;
const DEFAULT_CORE_FRACTION = 1 / 8; // matches WaterPlanet.js's own CORE_FRACTION, used only if no core instance is passed in

// A long fallback, not the primary way a fish retargets — arriving at
// the current target is meant to drive that almost all the time. Left
// short, this kept redirecting fish mid-swim, so they never crossed the
// pool; it's only meant to catch a target that's gone stale.
const RETARGET_MIN_SECONDS = 14;
const RETARGET_MAX_SECONDS = 22;

// Much rarer than the player's own bubble chance — ambient detail meant
// to trickle, not a focal effect.
const BUBBLE_SPAWN_CHANCE = 0.03;
const BUBBLE_MAX_COUNT = 3;
const BUBBLE_FADE_DISTANCE = 20;
const BUBBLE_RISE_SPEED_MIN = 0.4;
const BUBBLE_RISE_SPEED_MAX = 0.9;
const BUBBLE_WOBBLE_FREQ_MIN = 0.01;
const BUBBLE_WOBBLE_FREQ_MAX = 0.03;
const BUBBLE_WOBBLE_AMPLITUDE = 0.1;
const BUBBLE_RADIUS_MIN = 1.5;
const BUBBLE_RADIUS_MAX = 3.5;
const BUBBLE_COLOR = [0.85, 0.97, 1.0];

// Occasional leaps out of the water and back in — a real ballistic arc
// (outward + sideways launch velocity, pulled back by a hand-rolled
// radial "gravity" toward the water's own center every frame while
// airborne), NOT a canned animation.
//
// DECIDING to jump and actually LAUNCHING are deliberately two separate
// steps (see this.headingToJump / decideToJump / trySwimUpdate): deciding
// picks a shoreline point as the fish's next target and lets its
// ordinary steering carry it there; the leap only launches once it truly
// arrives — so the exit splash and the launch position are always
// genuinely at the shore.
//
// The water's own gravityRadius (radius + constants.INFLUENCE_PADDING)
// is the hard ceiling on how high that arc is ever allowed to reach.
// JUMP_OUTWARD_SPEED_MIN is tuned so even the WEAKEST launch clears the
// true surface by a solid margin; JUMP_OUTWARD_SPEED_MAX keeps the
// highest possible apex comfortably under the influence gap;
// JUMP_MAX_APEX_FRAC is a defensive hard clamp on top of both.
const JUMP_GRAVITY = 0.6;           // world units/frame^2 (baseline 60fps) pulling back toward water.pos while airborne
const JUMP_OUTWARD_SPEED_MIN = 10;
const JUMP_OUTWARD_SPEED_MAX = 14;  // apex height at max ≈ 14^2/(2*0.6) ≈ 163 units above the launch point
const JUMP_TANGENT_SPEED_MIN = 2;   // sideways drift during the leap, so it arcs forward instead of straight up and down
const JUMP_TANGENT_SPEED_MAX = 5;
// Fraction of the gap between the water's surface and its own
// influenceRadius that a jump is ever allowed to reach.
const JUMP_MAX_APEX_FRAC = 0.75;

// Cross-pool jumps — a fish deliberately leaping from its own water
// body toward a DIFFERENT one it can actually reach. Needs to launch
// much harder than an ordinary jump. A hard enough launch only needs to
// reach as far as the DESTINATION pool's own influence ring, because
// that ring overlaps the origin's own, and gravity hands off to the
// destination's pull once the fish coasts into it (see
// findDominantWaterInfluence).
const JUMP_CROSS_OUTWARD_SPEED_MIN = 22;
const JUMP_CROSS_OUTWARD_SPEED_MAX = 30;
const JUMP_CROSS_TANGENT_SPEED_MIN = 3;
const JUMP_CROSS_TANGENT_SPEED_MAX = 6;
const JUMP_CROSS_MAX_APEX_FRAC = 0.95;
// How far outward from ITS OWN water's edge a cross-pool launch is
// allowed to travel before the safety clamp in updateJump catches it —
// a flat bonus, so every pool, big or small, gets the same outward
// travel room (the radius-proportional formula gave small pools far
// less real reach than large ones). Generous headroom above the real
// apex of a max-speed launch (30^2/1.2 = 750), so the clamp rarely
// fires and the gravity simulation decides whether a launch makes it.
const JUMP_CROSS_REACH_BONUS = 900;
// A visible "running start" for a cross-pool attempt.
const JUMP_CROSS_APPROACH_SPEED_MULT = 1.6;
// Even when another pool IS in reach, a fish doesn't always go for it.
const JUMP_CROSS_ATTEMPT_CHANCE = 0.5;
// Chance PER SECOND, while swimming and off cooldown, that a fish
// decides to head for the shore to leap (~20 real seconds on average).
const JUMP_DECIDE_CHANCE_PER_SECOND = 0.05;
const JUMP_COOLDOWN_SECONDS = 10; // minimum time between leaps for a single fish, counted from launch
// Full angular width (radians) the shore point in decideToJump is
// randomized across, centered on the fish's own current angle from the
// water's center — keeps the swim-to-shore leg short and local.
const JUMP_SHORE_ANGLE_SPREAD = Math.PI / 2;
// Hard cap on how long a fish may stay "heading to the shore to jump"
// before it gives up and goes back to ordinary wandering.
const JUMP_SHORE_TIMEOUT_SECONDS = 15;

// The classic ichthys silhouette in local UNIT space — nose at (1, 0),
// pointing along local +x. Split into two pieces at the waist so draw()
// can swing the tail piece back and forth around that pivot for a real
// tail-beat wiggle.
const TAIL_PIVOT_X = -0.62; // where the two pieces meet, matches the waist points below

const HEAD_SHAPE = [
  1.00, 0.00, // nose
  0.55, 0.30,
  0.05, 0.32,
  -0.45, 0.20,
  TAIL_PIVOT_X, 0.07, // waist, upper
  TAIL_PIVOT_X, -0.07, // waist, lower
  -0.45, -0.20,
  0.05, -0.32,
  0.55, -0.30,
];

// Waist-to-tail-tip points, relative to TAIL_PIVOT_X.
const TAIL_SHAPE = [
  0.00, 0.07, // waist, upper
  -0.38, 0.42, // upper tail tip
  -0.16, 0.00, // tail notch
  -0.38, -0.42, // lower tail tip
  0.00, -0.07, // waist, lower
];

const WIGGLE_AMPLITUDE = 0.45; // radians the tail swings each way from center
// Radians/baseline-frame the wiggle phase advances per unit of speed —
// a faster swimmer beats its tail faster.
const WIGGLE_SPEED_PER_UNIT_SPEED = 0.13;

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

// Shortest-path angle interpolation — turns `current` toward `target` by
// at most `maxDelta` radians, going whichever way is closer.
function turnToward(current, target, maxDelta) {
  let diff = lua.mod(target - current + Math.PI, Math.PI * 2) - Math.PI;
  if (diff > maxDelta) diff = maxDelta;
  if (diff < -maxDelta) diff = -maxDelta;
  return current + diff;
}

class Fish {
  // water: the WaterPlanet shell instance this fish swims inside of.
  // core (optional): its solid seabed instance — used to know exactly how
  // big a no-go zone to leave around the center.
  static new(water, core) {
    return new Fish(water, core);
  }

  constructor(water, core) {
    this.water = water;
    this.core = core;

    this.heading = Math.random() * Math.PI * 2;
    this.speed = SWIM_SPEED_MIN + Math.random() * (SWIM_SPEED_MAX - SWIM_SPEED_MIN);
    this.bubbles = [];
    this.wigglePhase = Math.random() * Math.PI * 2; // staggered so a school doesn't all beat their tails in lockstep

    // "swim" (normal wandering, see trySwimUpdate) or "jump" (airborne
    // ballistic arc, see updateJump).
    this.mode = 'swim';
    // True once a fish has decided to leap and is steering toward its
    // chosen shoreline point — see decideToJump.
    this.headingToJump = false;
    // Real seconds spent in that state so far.
    this.headingToJumpElapsed = 0;
    // True while headingToJump/mode=="jump" specifically means "aiming
    // for a different WaterPlanet," not an ordinary in-place hop.
    this.jumpingToOtherPool = false;
    // Unit vector toward the current cross-pool target's center.
    this.crossTargetDir = null;
    // Which apex fraction the current jump's safety clamp uses, set at launch.
    this.jumpApexFrac = JUMP_MAX_APEX_FRAC;
    // True once an in-progress jump has genuinely broken the water's
    // surface at least once.
    this.hasClearedSurface = false;
    // Staggered per-fish so a whole school doesn't become jump-eligible
    // on the exact same frame.
    this.jumpCooldown = Math.random() * JUMP_COOLDOWN_SECONDS;

    // Spawns already inside the swimmable band, uniform over its AREA.
    const [minR, maxR] = this.swimBandRadii();
    const spawnAngle = Math.random() * Math.PI * 2;
    const spawnR = Math.sqrt(minR * minR + Math.random() * (maxR * maxR - minR * minR));
    this.pos = new Vector2(
      water.pos.x + Math.cos(spawnAngle) * spawnR,
      water.pos.y + Math.sin(spawnAngle) * spawnR,
    );
    this.pickNewTarget();
  }

  // Returns [coreR, maxR].
  swimBandRadii() {
    const coreR = ((this.core ? this.core.radius : null) ?? this.water.radius * DEFAULT_CORE_FRACTION) + WANDER_CORE_MARGIN;
    const maxR = Math.max(coreR + 1, this.water.radius - WANDER_RADIUS_MARGIN);
    return [coreR, maxR];
  }

  pickNewTarget() {
    const [minR, maxR] = this.swimBandRadii();
    const angle = Math.random() * Math.PI * 2;
    // Uniform across the annulus's own AREA, not its radius — sampling r
    // itself uniformly clusters targets toward the inner edge.
    const r = Math.sqrt(minR * minR + Math.random() * (maxR * maxR - minR * minR));
    this.targetPos = new Vector2(this.water.pos.x + Math.cos(angle) * r, this.water.pos.y + Math.sin(angle) * r);
    this.retargetTimer = RETARGET_MIN_SECONDS + Math.random() * (RETARGET_MAX_SECONDS - RETARGET_MIN_SECONDS);
  }

  updateBubbles(ts) {
    // Only SPAWNS new ones while actually swimming.
    if (this.mode === 'swim' && this.bubbles.length < BUBBLE_MAX_COUNT && Math.random() < BUBBLE_SPAWN_CHANCE * ts) {
      const water = this.water;
      const away = this.pos.subtract(water.pos);
      const dist = away.length();
      const angle = dist > 1 ? Math.atan2(away.y, away.x) : (Math.random() * Math.PI * 2);

      const spawnR = dist + FISH_LENGTH * 0.5;
      const targetR = water.radius;
      if (spawnR < targetR) {
        this.bubbles.push(newBubble(water.pos.x, water.pos.y, angle, spawnR, targetR));
      }
    }

    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      b.r += b.riseSpeed * ts;
      b.wobblePhase += b.wobbleFreq * ts;
      if (b.r >= b.targetR) this.bubbles.splice(i, 1);
    }
  }

  update() {
    const ts = state.timeScale ?? 1;
    this.jumpCooldown = Math.max(0, this.jumpCooldown - ts / 60);
    this.wigglePhase += WIGGLE_SPEED_PER_UNIT_SPEED * this.speed * ts;

    if (this.mode === 'jump') this.updateJump(ts);
    else this.trySwimUpdate(ts);

    this.updateBubbles(ts);
  }

  trySwimUpdate(ts) {
    const water = this.water;

    if (this.headingToJump) {
      // Committed to reaching the shore to leap — nothing redirects it
      // mid-approach.
      this.headingToJumpElapsed += ts / 60;

      // "Arrived" is RADIAL distance from the water's center reaching the
      // shore, not distance to the exact point decideToJump picked — a
      // fish approaching at an angle could graze past that point forever.
      const distFromCenter = this.pos.subtract(water.pos).length();
      const [, shoreR] = this.swimBandRadii();
      if (distFromCenter >= shoreR - 5) {
        this.headingToJump = false;
        this.startJump(this.pos.subtract(water.pos));
        return;
      } else if (this.headingToJumpElapsed > JUMP_SHORE_TIMEOUT_SECONDS) {
        // Hard safety net. Setting jumpCooldown here matters: without it
        // a timed-out fish would decide to jump again the very next frame.
        this.headingToJump = false;
        this.jumpCooldown = JUMP_COOLDOWN_SECONDS;
        this.pickNewTarget();
      }
    } else {
      this.retargetTimer -= ts / 60;
      if (this.retargetTimer <= 0 || this.pos.subtract(this.targetPos).length() < FISH_LENGTH) {
        this.pickNewTarget();
      }

      if (this.jumpCooldown <= 0 && Math.random() < JUMP_DECIDE_CHANCE_PER_SECOND * (ts / 60)) {
        this.decideToJump();
      }
    }

    const toTarget = this.targetPos.subtract(this.pos);
    if (toTarget.length() > 0.01) {
      const desiredHeading = Math.atan2(toTarget.y, toTarget.x);
      this.heading = turnToward(this.heading, desiredHeading, TURN_RATE * ts);
    }

    // A visible "running start" while making the final approach for a
    // cross-pool attempt — only scales this frame's distance.
    let approachSpeed = this.speed;
    if (this.headingToJump && this.jumpingToOtherPool) approachSpeed *= JUMP_CROSS_APPROACH_SPEED_MULT;
    this.pos.x += Math.cos(this.heading) * approachSpeed * ts;
    this.pos.y += Math.sin(this.heading) * approachSpeed * ts;

    // Defensive clamp back into a swim band — ALWAYS enforced, including
    // while headingToJump (where the ceiling is widened to just inside
    // the water's TRUE edge so it can still reach the shore to launch).
    let [minR, maxR] = this.swimBandRadii();
    if (this.headingToJump) maxR = water.radius - 5;
    const offset = this.pos.subtract(water.pos);
    const dist = offset.length();
    if (dist > maxR) {
      this.pos = water.pos.clone().add(offset.normalize().scale(maxR));
    } else if (dist < minR && dist > 0.01) {
      this.pos = water.pos.clone().add(offset.normalize().scale(minR));
    }
  }

  // Marks this fish as heading for the shore to leap. Picks a point at
  // the swim band's own outer wall as the new target; ordinary steering
  // carries it there and arriving triggers the launch.
  //
  // Two cases for WHICH angle gets picked:
  //   - A cross-pool jump: aimed straight at the other water body's center.
  //   - An ordinary hop: NEAR the fish's own current angular position
  //     (see JUMP_SHORE_ANGLE_SPREAD), so it's a short swim to the
  //     nearest bit of shore, not a beeline across the whole pool.
  decideToJump() {
    const water = this.water;
    const [, maxR] = this.swimBandRadii();

    // Another water body a boosted launch could reach. "Reach" only
    // needs to get as far as the OTHER body's influence ring (gravity
    // hands over from there). Picked UNIFORMLY AT RANDOM among every
    // reachable body, not always the nearest — always-nearest drained
    // fish into the cluster of small pools and they never climbed back out.
    const crossCandidates = [];
    if (state.planetoids) {
      const crossCeiling = water.radius + JUMP_CROSS_REACH_BONUS;
      for (const p of state.planetoids) {
        if (p.isWaterPlanet && p !== water) {
          const centerDist = water.pos.subtract(p.pos).length();
          const neededReach = centerDist - p.influenceRadius;
          if (neededReach <= crossCeiling) crossCandidates.push(p);
        }
      }
    }
    const crossTarget = crossCandidates.length > 0
      ? crossCandidates[Math.floor(Math.random() * crossCandidates.length)] : null;

    let angle;
    this.jumpingToOtherPool = crossTarget !== null && Math.random() < JUMP_CROSS_ATTEMPT_CHANCE;
    if (this.jumpingToOtherPool) {
      angle = Math.atan2(crossTarget.pos.y - water.pos.y, crossTarget.pos.x - water.pos.x);
      // Stored precisely so the LAUNCH velocity is always aimed dead-on
      // at the destination (see startJump).
      this.crossTargetDir = new Vector2(Math.cos(angle), Math.sin(angle));
    } else {
      const currentAngle = Math.atan2(this.pos.y - water.pos.y, this.pos.x - water.pos.x);
      angle = currentAngle + (Math.random() - 0.5) * JUMP_SHORE_ANGLE_SPREAD;
    }

    this.targetPos = new Vector2(water.pos.x + Math.cos(angle) * maxR, water.pos.y + Math.sin(angle) * maxR);
    this.headingToJump = true;
    this.headingToJumpElapsed = 0;
  }

  // offset: the fish's CURRENT position minus the water's center.
  startJump(offset) {
    // For a cross-pool attempt, launches along the EXACT stored direction
    // toward the destination rather than offset's own direction — a few
    // degrees of error ate into the reach margin, especially from small
    // pools.
    const outDir = (this.jumpingToOtherPool && this.crossTargetDir) || offset.clone().normalize();

    // Sideways component follows whichever perpendicular is closer to
    // the fish's CURRENT heading, so the leap continues roughly the
    // direction it was already swimming.
    let tangent = new Vector2(-outDir.y, outDir.x);
    const headingVec = new Vector2(Math.cos(this.heading), Math.sin(this.heading));
    if (tangent.dot(headingVec) < 0) tangent = tangent.multiply(-1);

    // Boosted launch for a cross-pool attempt.
    let outMin = JUMP_OUTWARD_SPEED_MIN, outMax = JUMP_OUTWARD_SPEED_MAX;
    let tanMin = JUMP_TANGENT_SPEED_MIN, tanMax = JUMP_TANGENT_SPEED_MAX;
    if (this.jumpingToOtherPool) {
      outMin = JUMP_CROSS_OUTWARD_SPEED_MIN; outMax = JUMP_CROSS_OUTWARD_SPEED_MAX;
      tanMin = JUMP_CROSS_TANGENT_SPEED_MIN; tanMax = JUMP_CROSS_TANGENT_SPEED_MAX;
    }
    const outSpeed = outMin + Math.random() * (outMax - outMin);
    const tanSpeed = tanMin + Math.random() * (tanMax - tanMin);
    this.vel = outDir.multiply(outSpeed).add(tangent.multiply(tanSpeed));

    this.mode = 'jump';
    this.jumpCooldown = JUMP_COOLDOWN_SECONDS + Math.random() * JUMP_COOLDOWN_SECONDS;
    this.jumpApexFrac = this.jumpingToOtherPool ? JUMP_CROSS_MAX_APEX_FRAC : JUMP_MAX_APEX_FRAC;
    // Launches from inside the water's true radius, so "back under the
    // surface" only means landing once it has genuinely broken it.
    this.hasClearedSurface = false;

    Splash.spawn(this.pos, outDir);
  }

  // Which water body's gravity is actually pulling on a leaping fish
  // RIGHT NOW — its own launch origin by default, handing off to a
  // DIFFERENT water body once the fish enters that body's own influence
  // ring, preferring whichever in-range body is closest. Mirrors
  // GravitySystem.findDominantPlanet's own nearest-in-range-wins rule.
  // This is what makes a long cross-pool jump possible: the two rings
  // overlap even when the surfaces are far apart.
  findDominantWaterInfluence() {
    let best = this.water;
    let bestDist = this.pos.subtract(this.water.pos).length();
    let bestInRange = bestDist <= this.water.influenceRadius;

    if (state.planetoids) {
      for (const p of state.planetoids) {
        if (p.isWaterPlanet && p !== this.water) {
          const d = this.pos.subtract(p.pos).length();
          if (d <= p.influenceRadius && (!bestInRange || d < bestDist)) {
            best = p; bestDist = d; bestInRange = true;
          }
        }
      }
    }

    return best;
  }

  updateJump(ts) {
    const water = this.water; // still the ORIGIN, for the "landed back home" check further down

    // Hand-rolled radial gravity toward whichever water body is dominant.
    let gravSource = this.findDominantWaterInfluence();
    let offset = this.pos.subtract(gravSource.pos);
    let dist = offset.length();
    let dirOut = dist > 0.01 ? offset.clone().normalize() : new Vector2(0, -1);
    this.vel.addScaled(dirOut, -JUMP_GRAVITY * ts);
    this.pos.addScaled(this.vel, ts);

    // Hard safety clamp, recomputed from the position the fish just moved
    // to and whichever body is dominant NOW.
    gravSource = this.findDominantWaterInfluence();
    offset = this.pos.subtract(gravSource.pos);
    dist = offset.length();
    let maxApex;
    if (this.jumpingToOtherPool && gravSource === this.water) {
      // Still arcing from the ORIGIN's own gravity — the flat allowance.
      maxApex = gravSource.radius + JUMP_CROSS_REACH_BONUS;
    } else {
      maxApex = gravSource.radius + (gravSource.influenceRadius - gravSource.radius) * this.jumpApexFrac;
    }
    if (dist > maxApex) {
      dirOut = offset.clone().normalize();
      this.pos = gravSource.pos.clone().add(dirOut.multiply(maxApex));
      const outwardSpeed = this.vel.dot(dirOut);
      if (outwardSpeed > 0) this.vel = this.vel.subtract(dirOut.multiply(outwardSpeed));
      dist = maxApex;
    }

    // Orients along the direction of travel while airborne.
    if (this.vel.length() > 0.01) this.heading = Math.atan2(this.vel.y, this.vel.x);

    // Relative to the ORIGIN specifically: "did it come back down into
    // the pool it launched from".
    const originOffset = this.pos.subtract(water.pos);
    const originDist = originOffset.length();

    if (originDist > water.radius) this.hasClearedSurface = true;

    if (this.hasClearedSurface && originDist <= water.radius) {
      this.land(originOffset);
      return;
    }

    // Landing in a DIFFERENT nearby water body instead.
    if (state.planetoids) {
      for (const p of state.planetoids) {
        if (p.isWaterPlanet && p !== water) {
          const otherOffset = this.pos.subtract(p.pos);
          if (otherOffset.length() <= p.radius) {
            this.water = p;
            this.core = p.core;
            this.land(otherOffset);
            return;
          }
        }
      }
    }
  }

  // offset: the fish's position minus the center of the water body it
  // actually landed in.
  land(offset) {
    const splashDir = offset.length() > 0.01 ? offset.clone().normalize() : new Vector2(0, -1);
    Splash.spawn(this.pos, splashDir);
    this.mode = 'swim';
    this.pickNewTarget();
  }

  draw() {
    love.graphics.push();
    love.graphics.translate(this.pos.x, this.pos.y);
    love.graphics.rotate(this.heading);
    love.graphics.scale(FISH_LENGTH / 2, FISH_LENGTH / 2);
    love.graphics.setColor(FISH_COLOR);
    love.graphics.polygon('fill', HEAD_SHAPE);

    // Tail swings around the waist pivot, independent of the body's
    // own rotation above — an actual tail-beat.
    love.graphics.push();
    love.graphics.translate(TAIL_PIVOT_X, 0);
    love.graphics.rotate(Math.sin(this.wigglePhase) * WIGGLE_AMPLITUDE);
    love.graphics.polygon('fill', TAIL_SHAPE);
    love.graphics.pop();

    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.pop();
  }

  // Drawn separately from draw() (see main.js's own call site, right
  // after the water planet's second draw pass) so bubbles stay visible on
  // top of the translucent water fill.
  drawBubbles() {
    for (const b of this.bubbles) {
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
}

export default Fish;
