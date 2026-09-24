-- lua/entities/Fish.lua
--
-- Small ambient wildlife for WaterPlanet.lua's water body — a solid,
-- orange "ichthys" (the classic two-arc "Jesus fish" outline, here
-- filled rather than just an outline) that wanders freely inside the
-- water sphere and occasionally emits an air bubble, using the same
-- radial (angle + distance-from-water-center) bubble motion
-- Player.lua's own swimming already uses — see that file's own
-- newBubble/updateBubbles/drawBubbles for the precedent this mirrors.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local Splash = require("lua.effects.Splash")

local Fish = {}
Fish.__index = Fish

----------------------------------------------------------------------
-- Tunables
----------------------------------------------------------------------
local FISH_LENGTH = 68   -- nose-to-tail-tip, world units
local FISH_COLOR  = { 1.0, 0.45, 0.05 }

local SWIM_SPEED_MIN = 1.4  -- world units per baseline (60fps) frame
local SWIM_SPEED_MAX = 2.4
local TURN_RATE = 0.05      -- radians per baseline frame the heading eases toward its target — keeps turns smooth instead of snapping to face the target instantly

-- Kept away from both the water's own true edge and its solid core (see
-- WaterPlanet.lua) — wandering right up to either would mean clipping
-- through the seabed or swimming out past the wavy shoreline.
local WANDER_RADIUS_MARGIN = 40
local WANDER_CORE_MARGIN   = 50
local DEFAULT_CORE_FRACTION = 1 / 8 -- matches WaterPlanet.lua's own CORE_FRACTION, used only if no core instance is passed in

-- A long fallback, not the primary way a fish retargets — arriving at
-- the current target (see :trySwimUpdate's own distance check) is meant
-- to drive that almost all the time. Left short, this fires well before
-- a fish crosses the pool's ~750-unit-wide swim band at any reasonable
-- speed, constantly redirecting it mid-swim — in practice that kept
-- every fish's real excursions tiny, reading as "stuck in a small patch
-- near where it spawned" rather than actually crossing the pool. This
-- is now only meant to catch a target that's gone stale for some other
-- reason, not to pace ordinary wandering.
local RETARGET_MIN_SECONDS = 14
local RETARGET_MAX_SECONDS = 22

-- Much rarer than the player's own bubble chance (0.35 per frame while
-- submerged) — this is ambient background detail meant to trickle, not
-- a focal effect.
local BUBBLE_SPAWN_CHANCE     = 0.03
local BUBBLE_MAX_COUNT        = 3
local BUBBLE_FADE_DISTANCE    = 20
local BUBBLE_RISE_SPEED_MIN   = 0.4
local BUBBLE_RISE_SPEED_MAX   = 0.9
local BUBBLE_WOBBLE_FREQ_MIN  = 0.01
local BUBBLE_WOBBLE_FREQ_MAX  = 0.03
local BUBBLE_WOBBLE_AMPLITUDE = 0.1
local BUBBLE_RADIUS_MIN       = 1.5
local BUBBLE_RADIUS_MAX       = 3.5
local BUBBLE_COLOR            = { 0.85, 0.97, 1.0 }

-- Occasional leaps out of the water and back in — a real ballistic arc
-- (outward + sideways launch velocity, pulled back by a hand-rolled
-- radial "gravity" toward the water's own center every frame while
-- airborne), NOT a canned animation, so it naturally rises, curves, and
-- comes back down.
--
-- DECIDING to jump and actually LAUNCHING are deliberately two separate
-- steps (see self.headingToJump / Fish:decideToJump / Fish:trySwimUpdate)
-- rather than one check that fires wherever the fish happens to already
-- be: an earlier version rolled the jump right there, wherever a fish
-- happened to be while merely "somewhat near" the surface — which
-- launched from well short of the water's TRUE edge more often than
-- not, so the splash fired before the fish ever reached the shoreline,
-- and the arc (tuned assuming a launch right at the surface) usually
-- never even cleared the true edge at all. Now, deciding to jump just
-- picks a shoreline point (radius = swimBandRadii()'s own maxR) as the
-- fish's next target and lets its ordinary steering carry it there;
-- the leap only actually launches once it truly arrives — so the exit
-- splash and the launch position are always genuinely at the shore,
-- matching how Player.lua's own water crossing already looks.
--
-- The water's own gravityRadius (radius + constants.INFLUENCE_PADDING,
-- see Planetoid.lua) is the hard ceiling on how high that arc is ever
-- allowed to reach — jumping any higher would carry the fish outside
-- the one place its "gravity" pulling it back even makes sense.
-- JUMP_OUTWARD_SPEED_MIN is tuned so even the WEAKEST launch, from
-- maxR, clears the true surface by a solid margin (maxR + minApex ≈
-- 920 + 83 ≈ 1003, well past the 960 true edge); JUMP_OUTWARD_SPEED_MAX
-- keeps the highest possible apex comfortably under the influence gap;
-- JUMP_MAX_APEX_FRAC below is a defensive hard clamp on top of both,
-- not a substitute for either.
local JUMP_GRAVITY             = 0.6   -- world units/frame^2 (baseline 60fps) pulling back toward water.pos while airborne
local JUMP_OUTWARD_SPEED_MIN   = 10
local JUMP_OUTWARD_SPEED_MAX   = 14    -- apex height at max ≈ 14^2/(2*0.6) ≈ 163 units above the launch point
local JUMP_TANGENT_SPEED_MIN   = 2     -- sideways drift during the leap, so it arcs forward instead of straight up and down
local JUMP_TANGENT_SPEED_MAX   = 5
-- Fraction of the gap between the water's surface and its own
-- influenceRadius that a jump is ever allowed to reach — a hard safety
-- clamp (see Fish:updateJump), independent of the launch-speed tuning
-- above, so a change to one doesn't silently let the other slip past
-- the influence ring.
local JUMP_MAX_APEX_FRAC       = 0.75

-- Cross-pool jumps — a fish deliberately leaping from its own water
-- body toward a DIFFERENT one it can actually reach, rather than an
-- ordinary "hop out and splash back into the same pool" jump. Needs to
-- launch much harder than an ordinary jump: the gap between the two
-- WaterPlanets (see main.lua's own placement of the second one) is
-- farther than JUMP_OUTWARD_SPEED_MAX's own apex can reach.
--
-- The two pools are actually far enough apart now that this alone isn't
-- what makes crossing possible — see Fish:findDominantWaterInfluence's
-- own comment for the other half: a hard enough launch only needs to
-- reach as far as the DESTINATION pool's own influence ring (radius +
-- constants.INFLUENCE_PADDING), not its true water, because that ring
-- overlaps the origin's own, and gravity hands off to the destination's
-- pull once the fish coasts into it. JUMP_CROSS_MAX_APEX_FRAC is a
-- higher fraction of the influence gap than the ordinary
-- JUMP_MAX_APEX_FRAC specifically so the safety clamp doesn't cap a
-- boosted jump's reach before it gets far enough for that hand-off to
-- ever kick in.
-- Bumped up a bit from an earlier, more marginal range now that there
-- are several pools at a range of distances/sizes to reach — extra
-- headroom beyond the bare minimum needed, on top of (not instead of)
-- the aim-precision fix in startJump, since real launches still carry
-- some random tangential drift no aim fix removes.
local JUMP_CROSS_OUTWARD_SPEED_MIN = 22
local JUMP_CROSS_OUTWARD_SPEED_MAX = 30
local JUMP_CROSS_TANGENT_SPEED_MIN = 3
local JUMP_CROSS_TANGENT_SPEED_MAX = 6
local JUMP_CROSS_MAX_APEX_FRAC     = 0.95
-- How far outward from ITS OWN water's edge a cross-pool launch is
-- allowed to travel (measured from the origin's own center, added on
-- top of its radius) before the safety clamp in :updateJump catches it
-- — used in place of the ordinary radius-proportional formula
-- (gravSource.radius + (influenceRadius-radius)*frac) specifically
-- while still arcing from the ORIGIN's gravity, not yet handed off to
-- the destination. That ordinary formula multiplies INFLUENCE_PADDING
-- (a flat, size-independent 200-unit constant shared by every
-- Planetoid's gravity ring, see constants.lua) by a fraction — which
-- means the allowance came out as roughly "the origin's own radius plus
-- ~190," so a SMALL origin pool got clamped back far short of a
-- distant target even under a full-power launch, while a large origin
-- pool had huge headroom, regardless of how hard either one actually
-- launched (they use the identical JUMP_CROSS_OUTWARD_SPEED range).
-- That was the root cause of small-pool fish essentially never
-- reaching a far, larger pool while the reverse worked easily. This
-- flat bonus instead gives every pool, big or small, the same outward
-- travel room — generous headroom above the real ballistic apex-extra
-- a max-speed launch can reach (JUMP_CROSS_OUTWARD_SPEED_MAX^2 /
-- (2*JUMP_GRAVITY) = 30^2/1.2 = 750), so the clamp rarely fires at all
-- and the actual gravity simulation (not this safety net) is what
-- determines whether a given launch makes it.
local JUMP_CROSS_REACH_BONUS       = 900
-- Multiplies the fish's ordinary swim speed while it's making its final
-- approach to shore specifically FOR a cross-pool attempt — a visible
-- "running start," building up momentum before the leap itself, not
-- just a harder launch out of nowhere.
local JUMP_CROSS_APPROACH_SPEED_MULT = 1.6
-- Even when another pool IS in reach, a fish doesn't always go for it —
-- otherwise every single jump decision would turn into a cross-pool
-- attempt and the ordinary "hop in place" jump would basically stop
-- happening. Rolled once per decision, not per second.
local JUMP_CROSS_ATTEMPT_CHANCE = 0.5
-- Chance PER SECOND, while swimming and off cooldown, that a fish
-- decides to head for the shore to leap — see Fish:decideToJump. Not
-- tied to current position at all (that's the whole point of the
-- two-step redesign above), so ~0.05/sec (average ~20 real seconds
-- between decisions) reads as "sometimes" without needing to be timed
-- against how long a fish happens to dwell anywhere in particular.
local JUMP_DECIDE_CHANCE_PER_SECOND = 0.05
local JUMP_COOLDOWN_SECONDS    = 10    -- minimum time between leaps for a single fish, counted from launch
-- Full angular width (radians) the shore point in :decideToJump is
-- randomized across, centered on the fish's own current angle from the
-- water's center — keeps the swim-to-shore leg short and local. Pi/2 =
-- the chosen point can land up to 45 degrees either side of straight
-- "outward from here," never clear across the pool.
local JUMP_SHORE_ANGLE_SPREAD = math.pi / 2
-- Hard cap on how long a fish is allowed to stay in the "heading to the
-- shore to jump" state before it's forced to give up and go back to
-- ordinary wandering — see Fish:trySwimUpdate's own use of this. A
-- short local swim (JUMP_SHORE_ANGLE_SPREAD keeps it that way) should
-- only ever take a few seconds at ordinary swim speed; this is
-- generous headroom above that, not a normal-case timer — its entire
-- purpose is making sure this state can never persist indefinitely,
-- regardless of what might otherwise prevent a clean arrival.
local JUMP_SHORE_TIMEOUT_SECONDS = 15

-- The classic ichthys silhouette in local UNIT space — nose at (1, 0),
-- pointing along local +x (so love.graphics.rotate(heading) alone
-- orients it correctly). Split into two pieces at the waist rather than
-- one rigid polygon, specifically so :draw() can swing the tail piece
-- back and forth around that pivot for a real tail-beat wiggle instead
-- of rocking the whole fish as one stiff unit. Neither piece is baked
-- into a Mesh — only a handful of these are ever on screen, so two
-- plain polygon() calls a frame is cheap enough not to need that.
local TAIL_PIVOT_X = -0.62 -- where the two pieces meet, matches the waist points below

local HEAD_SHAPE = {
   1.00,  0.00, -- nose
   0.55,  0.30,
   0.05,  0.32,
  -0.45,  0.20,
  TAIL_PIVOT_X,  0.07, -- waist, upper
  TAIL_PIVOT_X, -0.07, -- waist, lower
  -0.45, -0.20,
   0.05, -0.32,
   0.55, -0.30,
}

-- Same waist-to-tail-tip points FISH_SHAPE used to have, but expressed
-- relative to TAIL_PIVOT_X (i.e. that subtracted out of every x) so
-- rotating this piece around the pivot in :draw() sweeps it correctly
-- instead of orbiting some other point.
local TAIL_SHAPE = {
   0.00,  0.07, -- waist, upper
  -0.38,  0.42, -- upper tail tip
  -0.16,  0.00, -- tail notch
  -0.38, -0.42, -- lower tail tip
   0.00, -0.07, -- waist, lower
}

local WIGGLE_AMPLITUDE = 0.45 -- radians the tail swings each way from center
-- Radians/baseline-frame the wiggle phase advances per unit of SWIM_SPEED
-- — multiplied by the fish's own actual speed in :draw(), so a faster
-- swimmer beats its tail faster, the same way a real fish does, rather
-- than every fish wiggling at an identical fixed rate regardless of how
-- fast it's actually moving.
local WIGGLE_SPEED_PER_UNIT_SPEED = 0.13

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

-- Shortest-path angle interpolation — turns `current` toward `target` by
-- at most `maxDelta` radians, going whichever way (clockwise or counter)
-- is closer, rather than always increasing. Lua's `%` is floor-modulo
-- (always same sign as the divisor), so `(diff + pi) % (2*pi) - pi`
-- reliably wraps the raw angle difference into (-pi, pi] regardless of
-- which side `current`/`target` started on — same convention
-- TargetLock.lua's own angle math relies on.
local function turnToward(current, target, maxDelta)
  local diff = (target - current + math.pi) % (math.pi * 2) - math.pi
  if diff > maxDelta then diff = maxDelta end
  if diff < -maxDelta then diff = -maxDelta end
  return current + diff
end

-- water: the WaterPlanet shell instance (state.waterPlanet) this fish
-- swims inside of. core (optional): its solid seabed instance
-- (state.waterCore) — used to know exactly how big a no-go zone to
-- leave around the center; falls back to DEFAULT_CORE_FRACTION if
-- omitted.
function Fish.new(water, core)
  local self = setmetatable({}, Fish)
  self.water = water
  self.core = core

  self.heading = math.random() * math.pi * 2
  self.speed = SWIM_SPEED_MIN + math.random() * (SWIM_SPEED_MAX - SWIM_SPEED_MIN)
  self.bubbles = {}
  self.wigglePhase = math.random() * math.pi * 2 -- staggered so a school doesn't all beat their tails in lockstep

  -- "swim" (normal wandering, see :trySwimUpdate) or "jump" (airborne
  -- ballistic arc, see :updateJump) — see :update's own dispatch.
  self.mode = "swim"
  -- True once a fish has decided to leap and is steering toward its
  -- chosen shoreline point — see Fish:decideToJump.
  self.headingToJump = false
  -- Real seconds spent in that state so far — see
  -- JUMP_SHORE_TIMEOUT_SECONDS's own comment for why this is capped.
  self.headingToJumpElapsed = 0
  -- True while headingToJump/mode=="jump" specifically means "aiming
  -- for a different WaterPlanet," not an ordinary in-place hop — set by
  -- decideToJump, read by :trySwimUpdate (approach speed boost) and
  -- startJump (launch speed/apex-clamp boost).
  self.jumpingToOtherPool = false
  -- Unit vector toward the current cross-pool target's center, set by
  -- decideToJump and read by startJump — see that method's own comment.
  self.crossTargetDir = nil
  -- Which JUMP_MAX_APEX_FRAC-equivalent the current jump's safety clamp
  -- uses — ordinary or the higher JUMP_CROSS_MAX_APEX_FRAC, set at
  -- launch (see startJump) since headingToJump/jumpingToOtherPool are
  -- both already cleared by the time :updateJump needs to read this.
  self.jumpApexFrac = JUMP_MAX_APEX_FRAC
  -- True once an in-progress jump has genuinely broken the water's
  -- surface at least once — see startJump/updateJump's own comments.
  self.hasClearedSurface = false
  -- Staggered per-fish so a whole school doesn't become jump-eligible on
  -- the exact same frame.
  self.jumpCooldown = math.random() * JUMP_COOLDOWN_SECONDS

  -- Spawns already inside the swimmable band (not at the water's own
  -- center, which sits on the solid core) — pickNewTarget both sets
  -- self.targetPos AND resets retargetTimer, but self.pos itself still
  -- needs setting once up front here.
  local minR, maxR = self:swimBandRadii()
  local spawnAngle = math.random() * math.pi * 2
  -- Same uniform-AREA sampling as :pickNewTarget (see that function's
  -- own comment) — otherwise every fish would start out biased toward
  -- the inner edge before its first real target ever gets picked.
  local spawnR = math.sqrt(minR * minR + math.random() * (maxR * maxR - minR * minR))
  self.pos = Vector2.new(
    water.pos.x + math.cos(spawnAngle) * spawnR,
    water.pos.y + math.sin(spawnAngle) * spawnR
  )
  self:pickNewTarget()

  return self
end

function Fish:swimBandRadii()
  local coreR = (self.core and self.core.radius or self.water.radius * DEFAULT_CORE_FRACTION) + WANDER_CORE_MARGIN
  local maxR = math.max(coreR + 1, self.water.radius - WANDER_RADIUS_MARGIN)
  return coreR, maxR
end

function Fish:pickNewTarget()
  local minR, maxR = self:swimBandRadii()
  local angle = math.random() * math.pi * 2
  -- Uniform across the annulus's own AREA, not its radius — sampling r
  -- itself uniformly clusters targets toward the inner edge, since equal
  -- radial steps near the outer edge cover far more actual area
  -- (circumference scales with r). Same r^2-uniform trick
  -- WorldGen.lua's spawnDriftingBeltPlanetoid already uses for the same
  -- reason. Without this, fish picked targets mostly close to the core
  -- and rarely explored the outer two-thirds of the pool — most of its
  -- actual surface area.
  local r = math.sqrt(minR * minR + math.random() * (maxR * maxR - minR * minR))
  self.targetPos = Vector2.new(self.water.pos.x + math.cos(angle) * r, self.water.pos.y + math.sin(angle) * r)
  self.retargetTimer = RETARGET_MIN_SECONDS + math.random() * (RETARGET_MAX_SECONDS - RETARGET_MIN_SECONDS)
end

function Fish:updateBubbles(ts)
  -- Only SPAWNS new ones while actually swimming — existing bubbles
  -- still rise/fade normally below regardless of mode, but a fish
  -- mid-leap through open air shouldn't start a fresh trail.
  if self.mode == "swim" and #self.bubbles < BUBBLE_MAX_COUNT and math.random() < BUBBLE_SPAWN_CHANCE * ts then
    local water = self.water
    local away = self.pos:subtract(water.pos)
    local dist = away:length()
    local angle = dist > 1 and math.atan2(away.y, away.x) or (math.random() * math.pi * 2)

    local spawnR = dist + FISH_LENGTH * 0.5
    local targetR = water.radius
    if spawnR < targetR then
      table.insert(self.bubbles, newBubble(water.pos.x, water.pos.y, angle, spawnR, targetR))
    end
  end

  for i = #self.bubbles, 1, -1 do
    local b = self.bubbles[i]
    b.r = b.r + b.riseSpeed * ts
    b.wobblePhase = b.wobblePhase + b.wobbleFreq * ts
    if b.r >= b.targetR then
      table.remove(self.bubbles, i)
    end
  end
end

function Fish:update()
  local ts = state.timeScale or 1
  self.jumpCooldown = math.max(0, self.jumpCooldown - ts / 60)
  self.wigglePhase = self.wigglePhase + WIGGLE_SPEED_PER_UNIT_SPEED * self.speed * ts

  if self.mode == "jump" then
    self:updateJump(ts)
  else
    self:trySwimUpdate(ts)
  end

  self:updateBubbles(ts)
end

function Fish:trySwimUpdate(ts)
  local water = self.water

  if self.headingToJump then
    -- Committed to reaching the shore to leap — skips the ordinary
    -- retarget-timeout/arrival handling entirely below so nothing can
    -- redirect it to a different target mid-approach.
    self.headingToJumpElapsed = self.headingToJumpElapsed + ts / 60

    -- "Arrived" is checked as ACTUAL RADIAL DISTANCE FROM THE WATER'S
    -- CENTER reaching the shore, not Euclidean distance to the one
    -- exact (x,y) point :decideToJump picked. That point only ever
    -- existed to give the steering something concrete to aim at — a
    -- fish approaching it at anything but a head-on angle would
    -- overshoot or graze past outside FISH_LENGTH of it, and since nothing
    -- else advances the state, it just kept re-steering toward that
    -- same point indefinitely without ever entering the small arrival
    -- window. Radial distance can't have that problem: it only ever
    -- increases as the fish genuinely approaches the edge, so it
    -- reliably crosses the threshold the moment it's actually there,
    -- regardless of the exact angle it arrives from.
    local distFromCenter = self.pos:subtract(water.pos):length()
    local _, shoreR = self:swimBandRadii()
    if distFromCenter >= shoreR - 5 then
      self.headingToJump = false
      self:startJump(self.pos:subtract(water.pos))
      return
    elseif self.headingToJumpElapsed > JUMP_SHORE_TIMEOUT_SECONDS then
      -- Hard safety net — this state must not be able to persist
      -- indefinitely no matter what. Setting jumpCooldown here (an
      -- earlier version didn't) is what actually matters: without it,
      -- jumpCooldown was already <= 0 (that's what allowed deciding to
      -- jump in the first place), so a timed-out attempt would leave a
      -- fish immediately eligible to decide again on the very next
      -- frame — repeating this same failed attempt forever, which is
      -- what "the timeout" actually looked like in practice.
      self.headingToJump = false
      self.jumpCooldown = JUMP_COOLDOWN_SECONDS
      self:pickNewTarget()
    end
  else
    self.retargetTimer = self.retargetTimer - ts / 60
    if self.retargetTimer <= 0 or self.pos:subtract(self.targetPos):length() < FISH_LENGTH then
      self:pickNewTarget()
    end

    if self.jumpCooldown <= 0 and math.random() < JUMP_DECIDE_CHANCE_PER_SECOND * (ts / 60) then
      self:decideToJump()
    end
  end

  local toTarget = self.targetPos:subtract(self.pos)
  if toTarget:length() > 0.01 then
    local desiredHeading = math.atan2(toTarget.y, toTarget.x)
    self.heading = turnToward(self.heading, desiredHeading, TURN_RATE * ts)
  end

  -- A visible "running start" while making the final approach for a
  -- cross-pool attempt specifically — self.speed itself stays untouched
  -- (it's this fish's fixed identity, read elsewhere too, e.g. the
  -- wiggle rate), this only scales the actual distance covered THIS
  -- frame.
  local approachSpeed = self.speed
  if self.headingToJump and self.jumpingToOtherPool then
    approachSpeed = approachSpeed * JUMP_CROSS_APPROACH_SPEED_MULT
  end
  self.pos.x = self.pos.x + math.cos(self.heading) * approachSpeed * ts
  self.pos.y = self.pos.y + math.sin(self.heading) * approachSpeed * ts

  -- Defensive clamp back into a swim band — ALWAYS enforced, including
  -- while headingToJump (an earlier version skipped it then, reasoning
  -- that the shore target already sits at the boundary so there was
  -- nothing to correct — but the steering can still overshoot a single
  -- point target at a shallow angle, same as any other target, and with
  -- no clamp at all in that state there was nothing stopping an
  -- overshooting fish from sailing out into open space and slowly
  -- looping back, which read as "speeds off, loops around, does it
  -- again." While headingToJump the ceiling is widened to just inside
  -- the water's TRUE edge (rather than the ordinary, more conservative
  -- maxR) so it can still actually reach the shore to launch from.
  local minR, maxR = self:swimBandRadii()
  if self.headingToJump then
    maxR = water.radius - 5
  end
  local offset = self.pos:subtract(water.pos)
  local dist = offset:length()
  if dist > maxR then
    self.pos = water.pos:clone():add(offset:normalize():scale(maxR))
  elseif dist < minR and dist > 0.01 then
    self.pos = water.pos:clone():add(offset:normalize():scale(minR))
  end
end

-- Marks this fish as heading for the shore to leap — see the
-- JUMP_DECIDE_CHANCE_PER_SECOND comment above for why this is a
-- separate step from actually launching. Picks a point right at the
-- swim band's own outer wall (swimBandRadii()'s maxR) as the new
-- target; ordinary steering (in :trySwimUpdate) carries it there like
-- any other target, and arriving is what actually triggers the launch.
--
-- Two cases for WHICH angle gets picked:
--   - Attempting a cross-pool jump (self.jumpingToOtherPool, see the
--     search below): aimed straight at the other water body's own
--     center direction, so the shore point is the one closest to it.
--   - Ordinary in-place hop: chosen NEAR the fish's own current
--     angular position (see JUMP_SHORE_ANGLE_SPREAD), not fully random
--     around the whole pool — an earlier version picked a completely
--     random angle, which meant a fish deciding to jump on one side of
--     the pool could end up assigned a shore point clear on the
--     opposite side, forcing a long beeline across the entire diameter
--     before it could ever launch. That read as the fish suddenly
--     "speeding to the other side" rather than a natural short swim out
--     to the nearest bit of shore.
function Fish:decideToJump()
  local water = self.water
  local _, maxR = self:swimBandRadii()

  -- Look for another water body a BOOSTED (JUMP_CROSS_*) launch could
  -- actually reach from here. "Reach" only needs to get as far as the
  -- OTHER body's own influence ring, not all the way to its actual
  -- water — see Fish:findDominantWaterInfluence's own comment: once a
  -- leaping fish coasts into a different pool's ring, THAT pool's own
  -- gravity takes over and pulls it the rest of the way in, so the
  -- origin launch only has to bridge the gap between its own reach and
  -- the destination's ring, not the destination's true surface.
  --
  -- Picks UNIFORMLY AT RANDOM among every reachable body, not always the
  -- single nearest one — an earlier version always took the nearest,
  -- which reads fine with just two pools but silently starves any
  -- target that isn't the closest once there are several: the three
  -- small pools added later all sit clustered right next to each other,
  -- so from inside that cluster the nearest reachable body is nearly
  -- always ANOTHER small pool, and the far larger pool loses that
  -- distance comparison every single time even when perfectly in reach.
  -- That one-directional bias — not a real reach limit — is what made
  -- fish drain into the small-pool cluster and never climb back out.
  local crossCandidates = {}
  if state.planetoids then
    -- Same flat, size-independent allowance :updateJump's safety clamp
    -- uses — see JUMP_CROSS_REACH_BONUS's own comment for why this
    -- can't be the old radius-proportional formula (it silently gave
    -- small origin pools far less real reach than large ones).
    local crossCeiling = water.radius + JUMP_CROSS_REACH_BONUS
    for _, p in ipairs(state.planetoids) do
      if p.isWaterPlanet and p ~= water then
        local centerDist = water.pos:subtract(p.pos):length()
        local neededReach = centerDist - p.influenceRadius
        if neededReach <= crossCeiling then
          table.insert(crossCandidates, p)
        end
      end
    end
  end
  local crossTarget = #crossCandidates > 0 and crossCandidates[math.random(#crossCandidates)] or nil

  local angle
  -- Even when a crossable pool exists, only go for it sometimes (see
  -- JUMP_CROSS_ATTEMPT_CHANCE's own comment) — otherwise ordinary
  -- in-place jumps would basically stop happening whenever one's in
  -- range.
  self.jumpingToOtherPool = crossTarget ~= nil and math.random() < JUMP_CROSS_ATTEMPT_CHANCE
  if self.jumpingToOtherPool then
    angle = math.atan2(crossTarget.pos.y - water.pos.y, crossTarget.pos.x - water.pos.x)
    -- Stored precisely (rather than re-derived from wherever the fish
    -- actually ends up crossing the shore threshold) so the LAUNCH
    -- velocity is always aimed dead-on at the destination — see
    -- startJump's own comment on why this specifically matters more for
    -- a smaller origin pool than a larger one.
    self.crossTargetDir = Vector2.new(math.cos(angle), math.sin(angle))
  else
    -- Chosen NEAR the fish's own current angular position, not fully
    -- random around the whole pool — an earlier version picked a
    -- completely random angle, which meant a fish deciding to jump on
    -- one side of the pool could end up assigned a shore point clear on
    -- the opposite side, forcing a long beeline across the entire
    -- diameter before it could ever launch. That read as the fish
    -- suddenly "speeding to the other side" rather than a natural short
    -- swim out to the nearest bit of shore.
    local currentAngle = math.atan2(self.pos.y - water.pos.y, self.pos.x - water.pos.x)
    angle = currentAngle + (math.random() - 0.5) * JUMP_SHORE_ANGLE_SPREAD
  end

  self.targetPos = Vector2.new(water.pos.x + math.cos(angle) * maxR, water.pos.y + math.sin(angle) * maxR)
  self.headingToJump = true
  self.headingToJumpElapsed = 0
end

-- offset: the fish's CURRENT position minus the water's center (i.e.
-- self.pos:subtract(water.pos)) — passed in rather than recomputed
-- since :trySwimUpdate already has it fresh.
function Fish:startJump(offset)
  -- For a cross-pool attempt, launches along the EXACT stored direction
  -- toward the destination (set in decideToJump) rather than
  -- `offset`'s own direction (from water's center to wherever the fish
  -- actually happened to be standing when it crossed the shore
  -- threshold). Those two can differ by a few degrees — the radial
  -- arrival check (see :trySwimUpdate) only guarantees the right
  -- DISTANCE from center, not the right ANGLE, and a smaller origin
  -- pool gives the fish less swim distance to finish turning toward the
  -- target before crossing that threshold. A few degrees of error ate
  -- directly into the already-thin reach margin, which is what made
  -- crossings FROM the smaller pool land short far more often than
  -- crossings from the larger one. An ordinary in-place hop has no
  -- fixed destination to aim at, so it still just uses offset's own
  -- direction.
  local outDir = (self.jumpingToOtherPool and self.crossTargetDir) or offset:clone():normalize()

  -- Sideways component follows whichever perpendicular is closer to the
  -- fish's CURRENT heading, so the leap continues roughly the direction
  -- it was already swimming instead of picking an arbitrary side.
  local tangent = Vector2.new(-outDir.y, outDir.x)
  local headingVec = Vector2.new(math.cos(self.heading), math.sin(self.heading))
  if tangent:dot(headingVec) < 0 then
    tangent = tangent:multiply(-1)
  end

  -- Boosted launch (much harder, faster) for a cross-pool attempt — see
  -- JUMP_CROSS_OUTWARD_SPEED_MIN's own comment for why an ordinary
  -- jump's speed range can't reach another WaterPlanet at all.
  local outMin, outMax, tanMin, tanMax = JUMP_OUTWARD_SPEED_MIN, JUMP_OUTWARD_SPEED_MAX, JUMP_TANGENT_SPEED_MIN, JUMP_TANGENT_SPEED_MAX
  if self.jumpingToOtherPool then
    outMin, outMax, tanMin, tanMax = JUMP_CROSS_OUTWARD_SPEED_MIN, JUMP_CROSS_OUTWARD_SPEED_MAX, JUMP_CROSS_TANGENT_SPEED_MIN, JUMP_CROSS_TANGENT_SPEED_MAX
  end
  local outSpeed = outMin + math.random() * (outMax - outMin)
  local tanSpeed = tanMin + math.random() * (tanMax - tanMin)
  self.vel = outDir:multiply(outSpeed):add(tangent:multiply(tanSpeed))

  self.mode = "jump"
  self.jumpCooldown = JUMP_COOLDOWN_SECONDS + math.random() * JUMP_COOLDOWN_SECONDS
  -- Which safety-clamp fraction :updateJump uses for THIS jump — see
  -- JUMP_CROSS_MAX_APEX_FRAC's own comment for why a cross-pool attempt
  -- needs a higher ceiling than an ordinary jump's, independent of how
  -- hard it launches.
  self.jumpApexFrac = self.jumpingToOtherPool and JUMP_CROSS_MAX_APEX_FRAC or JUMP_MAX_APEX_FRAC
  -- Launches from maxR (self:swimBandRadii()'s own outer wall), which
  -- is DELIBERATELY inside the water's true radius (see
  -- WANDER_RADIUS_MARGIN) — so dist stays below water.radius for the
  -- first several frames while still legitimately rising. Landing
  -- (:updateJump below) needs to know the fish has genuinely broken the
  -- surface at least once before "dist back under water.radius" means
  -- anything, rather than firing on that same still-rising first frame.
  self.hasClearedSurface = false

  Splash.spawn(self.pos, outDir)
end

-- Which water body's gravity is actually pulling on a leaping fish RIGHT
-- NOW — defaults to self.water (its own launch origin), but hands off to
-- a DIFFERENT water body once the fish enters that body's own influence
-- ring (radius + constants.INFLUENCE_PADDING), preferring whichever
-- in-range body is closest if more than one ring contains it. Mirrors
-- GravitySystem:findDominantPlanet's own nearest-in-range-wins rule.
--
-- This is what actually makes a long cross-pool jump (see
-- JUMP_CROSS_MAX_APEX_FRAC's own comment) physically possible once the
-- two pools are far enough apart that neither one's own ring alone
-- reaches the other's shore: the origin's ring and the destination's
-- ring can still overlap even when their SURFACES are far apart (a
-- ring's own radius, not just the pool's), so a fish launched hard
-- enough to coast into that overlap gets handed off to the
-- destination's own gravity partway through the arc, which pulls it the
-- rest of the way in — never leaving EITHER ring at any point, just
-- crossing from one to the other. If the two rings don't overlap at
-- all, this can't help — there's a genuine gravity-free gap no launch
-- speed can cross without leaving both rings at once.
function Fish:findDominantWaterInfluence()
  local best = self.water
  local bestDist = self.pos:subtract(self.water.pos):length()
  local bestInRange = bestDist <= self.water.influenceRadius

  if state.planetoids then
    for _, p in ipairs(state.planetoids) do
      if p.isWaterPlanet and p ~= self.water then
        local d = self.pos:subtract(p.pos):length()
        if d <= p.influenceRadius and (not bestInRange or d < bestDist) then
          best, bestDist, bestInRange = p, d, true
        end
      end
    end
  end

  return best
end

function Fish:updateJump(ts)
  local water = self.water -- still the ORIGIN, for the "landed back home" check further down — gravity/clamp below use whichever body is actually dominant this frame instead

  -- Hand-rolled radial gravity, the same "pull toward the dominant
  -- planet's center" shape GravitySystem:applyTo uses everywhere else
  -- in this game — implemented locally here rather than routed through
  -- that shared system, since a leaping fish isn't a real physics body
  -- (no landing/collision, no state.planetoids membership needed for
  -- this brief, purely cosmetic arc). Pulls toward findDominantWaterInfluence's
  -- result, NOT always self.water — see that method's own comment.
  local gravSource = self:findDominantWaterInfluence()
  local offset = self.pos:subtract(gravSource.pos)
  local dist = offset:length()
  local dirOut = dist > 0.01 and offset:clone():normalize() or Vector2.new(0, -1)
  self.vel:addScaled(dirOut, -JUMP_GRAVITY * ts)
  self.pos:addScaled(self.vel, ts)

  -- Hard safety clamp — see JUMP_MAX_APEX_FRAC's own comment up top
  -- (self.jumpApexFrac is that, or the higher JUMP_CROSS_MAX_APEX_FRAC
  -- for a cross-pool attempt — set once at launch, see startJump).
  -- Recomputed from the position the fish actually just moved to (not
  -- the launch one) AND from whichever body is dominant NOW (gravity
  -- may have just handed off above), so it catches an overshoot
  -- regardless of how or where it happened.
  gravSource = self:findDominantWaterInfluence()
  offset = self.pos:subtract(gravSource.pos)
  dist = offset:length()
  local maxApex
  if self.jumpingToOtherPool and gravSource == self.water then
    -- Still arcing from the ORIGIN's own gravity, not yet handed off to
    -- the destination pool — see JUMP_CROSS_REACH_BONUS's own comment
    -- for why this uses a flat, size-independent allowance instead of
    -- the ordinary formula below. Once gravity DOES hand off (gravSource
    -- is no longer self.water), the fish is coasting into the
    -- destination's own pull and the ordinary formula (relative to that
    -- destination) is the right one again — it's now landing in a real
    -- pool, not still trying to cross open space.
    maxApex = gravSource.radius + JUMP_CROSS_REACH_BONUS
  else
    maxApex = gravSource.radius + (gravSource.influenceRadius - gravSource.radius) * self.jumpApexFrac
  end
  if dist > maxApex then
    dirOut = offset:clone():normalize()
    self.pos = gravSource.pos:clone():add(dirOut:multiply(maxApex))
    local outwardSpeed = self.vel:dot(dirOut)
    if outwardSpeed > 0 then
      self.vel = self.vel:subtract(dirOut:multiply(outwardSpeed))
    end
    dist = maxApex
  end

  -- Orients along the direction of travel while airborne — reads as a
  -- real leap (nose tipping up on the way out, arcing over, nose down
  -- coming back in) instead of holding whatever heading it had at
  -- takeoff the whole time.
  if self.vel:length() > 0.01 then
    self.heading = math.atan2(self.vel.y, self.vel.x)
  end

  -- Recomputed relative to the ORIGIN specifically (offset/dist above
  -- are relative to gravSource, which may have already handed off to a
  -- DIFFERENT body by this point) — this check is specifically "did the
  -- fish come back down into the pool it launched from," so it needs
  -- the origin's own numbers regardless of which gravity well is
  -- currently pulling on it.
  local originOffset = self.pos:subtract(water.pos)
  local originDist = originOffset:length()

  if originDist > water.radius then
    self.hasClearedSurface = true
  end

  -- Only counts as landing back in the ORIGIN pool once it has
  -- GENUINELY broken the surface at least once (see startJump's own
  -- comment on hasClearedSurface) — otherwise originDist <=
  -- water.radius was already true at launch (maxR sits inside the true
  -- edge on purpose) and this fired on literally the first airborne
  -- frame, before the fish had gone anywhere near the edge, let alone
  -- above it. That was the actual bug behind the splash appearing well
  -- inside the water with no visible leap.
  if self.hasClearedSurface and originDist <= water.radius then
    self:land(originOffset)
    return
  end

  -- Landing in a DIFFERENT nearby water body instead — checked every
  -- frame regardless of hasClearedSurface, since flying into water that
  -- isn't the one just launched from is never the "already inside at
  -- launch" false-positive that guard exists for. This is what lets a
  -- fish actually cross from one WaterPlanet to another when they're
  -- close enough for a jump arc to reach — see main.lua's own comment
  -- on the second WaterPlanet.new() call for the distance this was
  -- tuned against.
  if state.planetoids then
    for _, p in ipairs(state.planetoids) do
      if p.isWaterPlanet and p ~= water then
        local otherOffset = self.pos:subtract(p.pos)
        if otherOffset:length() <= p.radius then
          self.water = p
          self.core = p.core
          self:land(otherOffset)
          return
        end
      end
    end
  end
end

-- offset: the fish's position minus whichever water body it actually
-- landed in (self.water — already updated by the caller if this was a
-- cross-pool landing, see updateJump above) own center.
function Fish:land(offset)
  local splashDir = offset:length() > 0.01 and offset:clone():normalize() or Vector2.new(0, -1)
  Splash.spawn(self.pos, splashDir)
  self.mode = "swim"
  self:pickNewTarget()
end

function Fish:draw()
  love.graphics.push()
  love.graphics.translate(self.pos.x, self.pos.y)
  love.graphics.rotate(self.heading)
  love.graphics.scale(FISH_LENGTH / 2, FISH_LENGTH / 2)
  love.graphics.setColor(FISH_COLOR)
  love.graphics.polygon("fill", HEAD_SHAPE)

  -- Tail swings around the waist pivot, independent of the head/body's
  -- own rotation above — that's what makes this read as an actual
  -- tail-beat (head goes roughly straight, tail sweeps side to side)
  -- instead of the whole fish rocking as one rigid unit.
  love.graphics.push()
  love.graphics.translate(TAIL_PIVOT_X, 0)
  love.graphics.rotate(math.sin(self.wigglePhase) * WIGGLE_AMPLITUDE)
  love.graphics.polygon("fill", TAIL_SHAPE)
  love.graphics.pop()

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.pop()
end

-- Drawn separately from :draw() (see main.lua's own call site, right
-- after the water planet's second draw pass) so bubbles stay visible on
-- top of the translucent water fill instead of getting muddied
-- underneath it — same reasoning as Player:drawBubbles.
function Fish:drawBubbles()
  for _, b in ipairs(self.bubbles) do
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

return Fish
