-- lua/entities/player/Movement.lua
--
-- Player methods for moving: gravity, jumping (with coyote time and jump
-- buffering), the ground pound, walking/running on surfaces and in the
-- air, and the dust and wall-jump effects that go with them. Copied onto
-- Player by lua/entities/Player.lua.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local constants = require("lua.constants")
local DustPuff = require("lua.effects.DustPuff")
local WaterSystem = require("lua.systems.WaterSystem")

local Player = {}

-- Coyote time and jump buffering (see Player:pressJump) — the two little
-- graces most platformers give a jump press that's a moment off:
--   COYOTE_FRAMES       how long after walking/falling off an edge he can
--                       still jump as if he were on it (60fps ticks)
--   JUMP_BUFFER_FRAMES  how long a press in mid-air is held, waiting: land
--                       in that time and he jumps the moment he touches
--                       down; otherwise it becomes the ground pound (so the
--                       pound starts this much later than the press)
--   COYOTE_MAX_DRIFT    how far (world units) he can have got from where he
--                       left the surface and still coyote-jump off it —
--                       past this (a portal, say) it's long gone
local COYOTE_FRAMES = 6
local JUMP_BUFFER_FRAMES = 6
local COYOTE_MAX_DRIFT = 140

-- Ball mode's speed, relative to his walking speed (see enterBallMode).
local BALL_SPEED_MULTIPLIER  = 2.1  -- 1.25 * 1.2 * 1.4 — bumped 20%, then another 40% faster
-- On ice (see Player:move): how much of the gap between his speed and
-- what the keys ask for closes each frame — small, so he slides.
local ICE_GRIP = 0.035

------------------------------------------------------------------
-- Physics / movement
------------------------------------------------------------------

function Player:applyGravity()
  if self.onSurface then return end
  -- Prefer shared GravitySystem (handles SkyDome deck gravity correctly)
  if state.gravitySystem then
    state.gravitySystem:applyTo(self)
    return
  end

  local planet = nil
  if state.gravitySystem and state.gravitySystem.findDominantPlanet then
    planet = state.gravitySystem:findDominantPlanet(self.pos)
  end
  if not planet and self.lastInfluencePlanet then planet = self.lastInfluencePlanet end
  if planet then
    self.lastInfluencePlanet = planet
    local direction = planet:gravityDirAt(self.pos.x, self.pos.y)
    local grav = constants.GRAVITY_STRENGTH
    if self.isGroundPounding then grav = grav * constants.GROUND_POUND_GRAV_MULTIPLIER end
    self.vel:add(direction:multiply(grav))
  end
end

-- "Down" direction used purely for the character rig's visual rotation
-- (drawing and idle-facing orientation) — NOT for physics/gravity, which
-- still follows the real surface normal. forceUprightJump surfaces
-- (TiledTerrain) keep the astronaut standing straight up regardless of
-- which way a 45-degree segment's normal points, the same way Mario
-- doesn't tilt to match a slope's angle. Without this override, the rig
-- would snap between upright and tilted every time the player crossed a
-- short slope segment, which reads as a glitch rather than motion.
function Player:visualDownDirection(planet)
  -- Held while going through a portal, and eased back after coming out
  -- (see lua/systems/PortalGun.lua).
  if self.portalDown then return self.portalDown:clone() end
  if not planet then return Vector2.new(0, 1) end
  -- Running along a cracked planet's wall (see CrackedPlanetoid:walkPlayer):
  -- feet to the wall.
  if self.onSurface and self.climbNormal and self.climbPlanet == planet then
    return Vector2.new(-self.climbNormal.x, -self.climbNormal.y)
  end
  -- Anywhere else: feet opposite the planet's own "up" (see
  -- lua/world/PlanetSurface.lua).
  return planet:upAt(self.pos.x, self.pos.y):multiply(-1)
end

function Player:getOutwardLaunchDirection()
  if not self.currentPlanet then return Vector2.new(0, -1) end
  -- Running along a cracked planet's wall: straight off the wall.
  if self.climbNormal and self.climbPlanet == self.currentPlanet then
    return Vector2.new(self.climbNormal.x, self.climbNormal.y)
  end
  -- Anywhere else: the planet's own "up" (see lua/world/PlanetSurface.lua)
  -- — straight out from a round planet, off a rounded rectangle's face,
  -- and straight up off the dome's deck and Tiled ground, slopes
  -- included (a 45-degree slope's normal points diagonally, but jumping
  -- off one still launches straight up).
  --
  -- (It doesn't tilt with a held direction key: jump()'s groundMoveSpeedX
  -- carry already handles sideways speed, and the two together would
  -- launch a walking jump at ~3x walking speed.)
  return self.currentPlanet:upAt(self.pos.x, self.pos.y)
end

function Player:jump()
  -- Locked out entirely while curling into/out of a ball (self.morphState
  -- — see enterBallMode/exitBallMode/updateBallMorph) OR while talking
  -- to an NPC (state.dialogueActive — see main.lua, computed fresh each
  -- frame from every NPC's own dialogueActive) — a single guard here
  -- covers every input source (keyboard Space, gamepad Cross) that
  -- calls this, rather than needing the same check patched into each
  -- one separately. isTeleporting (Beam.lua) gets the same treatment —
  -- same reasoning, frozen-in-place for a moment rather than mid-action.
  if self.morphState or state.dialogueActive or self.isTeleporting or self.isDying then return end
  if state.vatsActive then return end -- in V.A.T.S. he only picks a target and pulls to it (see main.lua's own V.A.T.S. rules)
  if self.inCannon then return end -- loaded in a cannon: it decides when he leaves (see lua/world/Cannon.lua)

  -- Requires actually MOVING at run speed, not just holding the run
  -- button (state.gamepadRunHeld) while standing still — self.groundMoveSpeedX
  -- (set each frame in move(), see its own comment) is 0 whenever no
  -- direction key is held, so holding Square in place doesn't give the
  -- jump-height boost of an actual running jump.
  local isRunningAndMoving = state.gamepadRunHeld and (self.groundMoveSpeedX or 0) ~= 0
  local jumpBoost = isRunningAndMoving and self.runJumpMultiplier or 1

  -- Coyote time: just off an edge, he still jumps off the surface he
  -- left (see canCoyoteJump) — launched exactly as if he'd still been on
  -- it, so it's that surface the launch direction and strength come from.
  local coyote = not (self.onSurface and self.currentPlanet) and self:canCoyoteJump()
  if coyote then
    self.currentPlanet = self.coyotePlanet
  end
  -- Any jump spends the grace, and anything waiting on a buffered press.
  self.coyoteTimer = 0
  self.jumpBufferTimer = 0

  if (self.onSurface or coyote) and self.currentPlanet then
    local direction = self:getOutwardLaunchDirection()
    -- Per-planet override (e.g. SkyDomePlanetoid's own stronger
    -- jumpStrength, compensating for its heavier gravityStrength — see
    -- that file's own comment) takes priority over the global default.
    -- Still scaled by jumpBoost — running SHOULD jump higher, not just
    -- farther — but see runJumpMultiplier's own comment for why that
    -- multiplier itself came back down once jumpStrength was raised.
    local jumpStrength = self.currentPlanet.jumpStrength or constants.JUMP_STRENGTH
    self.vel = direction:multiply(jumpStrength * jumpBoost)
    -- Carries current ground speed into the jump (see move()'s own
    -- self.groundMoveSpeedX) — conventional platformer behavior: a
    -- running jump launches you forward as well as up, instead of
    -- discarding all horizontal momentum the instant you leave the
    -- ground. 0 whenever no direction key was held, so a standing jump
    -- is unaffected. Clamped to airControlMaxSpeed (see that field's
    -- own comment) — this is ADDED to whatever vel.x already has, so
    -- without a ceiling here specifically, rapid repeat jumps (bunny-
    -- hopping) could stack this every single time and compound into an
    -- ever-increasing "leapfrog" instead of settling at one running
    -- jump's own natural speed.
    if self.currentPlanet.isCrackedPlanet then
      -- (On a cracked planet — see CrackedPlanetoid.lua — the carry goes
      -- round the planet, the way he was walking, not along the screen.)
      local carry = (self.groundMoveSpeedX or 0) * self.jumpMomentumCarryScale
      carry = math.max(-self.airControlMaxSpeed, math.min(self.airControlMaxSpeed, carry))
      self.vel:add(Vector2.new(-direction.y, direction.x):multiply(carry))
    else
      local carriedVelX = self.vel.x + (self.groundMoveSpeedX or 0) * self.jumpMomentumCarryScale
      self.vel.x = math.max(-self.airControlMaxSpeed, math.min(self.airControlMaxSpeed, carriedVelX))
    end
    self.onSurface = false
    self.currentPlanet = nil
    self.climbNormal, self.climbPlanet, self.climbDir = nil, nil, nil -- (off whatever wall he was running)
    if state.audioManager then state.audioManager:playJump() end
  elseif (not self.onSurface) and self.touchingWall and not self.isBall then
    -- Wall jump: kicks away from whichever wall was touched THIS FRAME
    -- (self.wallContactNormal, set fresh each frame by
    -- CollisionSystem:handlePlayerWallCollisions — never stale, since it's
    -- reset to nil every frame before wall collisions are re-checked).
    -- Mostly-up with a horizontal kick away from the wall, same overall
    -- launch strength as a normal jump so it feels consistent. Clearing
    -- touchingWall afterward means chaining wall jumps requires actually
    -- drifting back into a wall in between — pressing toward the wall you
    -- just left (or the opposite one) and re-touching it — rather than
    -- letting the same single contact be spent over and over in place.
    -- self.lastInfluencePlanet (not currentPlanet — that's already nil
    -- while airborne) is the same "whichever surface actually applies
    -- right now" lookup used elsewhere for airborne gravity/orientation;
    -- using its jumpStrength here matches an ordinary jump's launch
    -- speed on this level; the plain global default would leave wall
    -- jumps weaker than ground jumps on levels (like the dome) with a
    -- stronger override.
    local jumpStrength = (self.lastInfluencePlanet and self.lastInfluencePlanet.jumpStrength) or constants.JUMP_STRENGTH
    local direction = Vector2.new(self.wallContactNormal.x, -self.wallJumpUpwardRatio):normalize()
    self.vel = direction:multiply(jumpStrength * jumpBoost)

    -- Turn to face away from the wall (the kick direction), matching
    -- whichever way he's actually launching — and lock BOTH that facing
    -- and horizontal input back toward this wall for the same
    -- wallJumpLockFrames window, so the same "just kicked off, don't
    -- immediately reverse" beat applies to how he looks as well as how
    -- he moves. Without also locking facing, updateOrientationAndFacing's
    -- own mouse-aim logic could flip him back around the very next frame
    -- regardless of the movement lock, since it's driven by cursor
    -- position, not input direction.
    local awayDir = self.wallContactNormal.x > 0 and 1 or -1
    self.facingDirection = awayDir
    self.wallJumpLockBlockedDir = -awayDir
    self.wallJumpLockTimer = self.wallJumpLockFrames

    self:spawnWallJumpEffects()

    self.touchingWall = nil
    self.wallContactNormal = nil
    if state.audioManager then state.audioManager:playJump() end
  elseif self.submergedIn then
    -- Swim stroke: an outward-from-center impulse ADDED to (not
    -- replacing) current velocity, so repeated presses build against
    -- the water's own strong drag instead of resetting momentum each
    -- time — reads as paddling rather than a series of identical
    -- little hops. Deliberately no onSurface/touchingWall-style gate
    -- and no cooldown of its own: this can fire on every single press
    -- while submerged, which is what makes it feel like swimming rather
    -- than a single limited jump. Enough consecutive strokes carry the
    -- player back out past the surface entirely — CollisionSystem never
    -- treats a water planet as solid, so crossing back out just resumes
    -- ordinary falling/gravity toward whatever's dominant next.
    local planet = self.submergedIn
    local away = self.pos:subtract(planet.pos)
    local dist = away:length()
    local dir = dist > 1 and away:normalize() or Vector2.new(0, -1)
    self.vel:add(dir:multiply(self.swimStrength))
    self.swimStrokeTimer = self.swimStrokeDuration
    if state.audioManager then state.audioManager:playJump() end
  end
end

-- Jump pressed in mid-air (the input handlers only call this when
-- there's nothing to jump off and nothing to swim in): slam straight
-- down. Works at ANY point in the air — on the way up from a jump, on
-- the way back down, or after simply walking off a ledge.
--
-- The one requirement is that something is actually pulling on
-- him: a pound is just heavier gravity (GROUND_POUND_GRAV_MULTIPLIER)
-- until he lands, so out in open space with no planet in range it would
-- do nothing except leave him stuck in the pose.
function Player:tryGroundPound()
  if self.isGroundPounding or self.isDying or self.onSurface then return end
  if state.vatsActive then return end -- in V.A.T.S. he only picks a target and pulls to it (see main.lua's own V.A.T.S. rules)
  -- Not as a ball, or while curling into/out of one — the pound is his
  -- own move, on his feet.
  if self.isBall or self.morphState then return end
  -- Not in water either — there, jump is how he swims (see :jump). That
  -- includes being only partway in, near a pool's surface: his feet in
  -- the water count too (see WaterSystem.wetAt).
  if self.submergedIn then return end
  local down = self:visualDownDirection(self.lastInfluencePlanet)
  if WaterSystem.wetAt(self.pos.x + down.x * self.radius, self.pos.y + down.y * self.radius) then return end
  if not state.gravitySystem or not state.gravitySystem:findDominantPlanet(self.pos) then return end
  self.isGroundPounding = true
end

-- The jump button (Space / Cross — see InputHandlers.lua and
-- GamePadInput.lua). On something to jump off (the ground, a wall, water)
-- it's an ordinary jump, as it always was. Otherwise, two graces:
--   * coyote time — a moment after walking or falling off an edge, it's
--     still a jump off that edge (see canCoyoteJump);
--   * jump buffering — any other press in mid-air is held for
--     JUMP_BUFFER_FRAMES: land (or touch a wall, or hit water) in that
--     time and it's a jump the moment he does; if not, it's the ground
--     pound mid-air presses have always been (see updateJumpGraces).
function Player:pressJump()
  if self:isCannonRiding() then return end
  if self.onSurface or self.touchingWall or self.submergedIn or self:canCoyoteJump() then
    self:jump()
  else
    self.jumpBufferTimer = JUMP_BUFFER_FRAMES
  end
end

-- Whether he's still within coyote time of the surface he last stood on:
-- not long off it, not far from where he left it, and he left it by
-- walking or falling off — not by jumping (jump spends it), being
-- pulled away by the beam, curling up, a teleport, or a pound.
function Player:canCoyoteJump()
  if self.coyoteTimer <= 0 or not self.coyotePlanet or not self.coyotePos then return false end
  if self.onSurface or self.pullTarget or self.isBall or self.morphState then return false end
  if self.inCannon or self.cannonFlight then return false end
  if self.isTeleporting or self.isGroundPounding or self.portalTransit then return false end
  local dx, dy = self.pos.x - self.coyotePos.x, self.pos.y - self.coyotePos.y
  return dx * dx + dy * dy <= COYOTE_MAX_DRIFT * COYOTE_MAX_DRIFT
end

-- Once a tick (see Player:update): keeps the coyote surface fresh while
-- he's standing on one and counts it down once he isn't, and settles a
-- buffered press — a jump if he's now got something to jump off, the
-- ground pound once it's waited out in mid-air.
function Player:updateJumpGraces(ts)
  if self.onSurface and self.currentPlanet then
    self.coyotePlanet = self.currentPlanet
    self.coyotePos = self.pos:clone()
    self.coyoteTimer = COYOTE_FRAMES
  elseif self.coyoteTimer > 0 then
    self.coyoteTimer = math.max(0, self.coyoteTimer - ts)
  end

  if self.jumpBufferTimer > 0 then
    if self.onSurface or self.touchingWall or self.submergedIn then
      -- (Spent either way — if something's blocking the jump right now
      -- (dialogue, V.A.T.S., curling up), it shouldn't go off later.)
      self.jumpBufferTimer = 0
      self:jump()
    else
      self.jumpBufferTimer = math.max(0, self.jumpBufferTimer - ts)
      if self.jumpBufferTimer <= 0 then
        self:tryGroundPound()
      end
    end
  end
end

-- Spawns an occasional dust puff at the player's feet while actively
-- walking on a surface — a gentle scatter-and-drift-up, as opposed to
-- spawnWallJumpEffects' bigger outward burst. Called from all three
-- on-surface walking branches in move() (SkyDome/TiledTerrain
-- flat-or-arc walking, and circular-planet walking), since dust should
-- kick up regardless of which underlying walking system currently
-- applies.
function Player:spawnWalkDust()
  if not self.currentPlanet then return end

  -- Ties dust to actual FOOTSTEPS rather than a flat per-frame chance —
  -- the walk-bob (see drawFullBody) is exactly 0 when a leg passes
  -- through vertical and peaks at 1 right when it's most scissored,
  -- about to plant. Detecting the moment it crosses back above a high
  -- threshold catches that "just planted" instant, once per actual
  -- footfall (twice per full walkTime cycle, one per leg).
  local bobT = math.sin(self.walkTime) ^ 2
  local justPlanted = bobT > 0.85 and self.lastWalkBobT <= 0.85
  self.lastWalkBobT = bobT
  if not justPlanted then return end

  -- Same "down" derivation used for the character rig's own visual
  -- orientation (see visualDownDirection) — including its forceUprightJump
  -- override, so on a TiledTerrain slope dust spawns at the astronaut's
  -- actual (always-upright) visual feet, not off to the side along the
  -- slope's true normal.
  local downDir = self:visualDownDirection(self.currentPlanet)
  local feetPos = self.pos:clone():add(downDir:clone():multiply(self.radius * 0.9))
  local sideDir = Vector2.new(-downDir.y, downDir.x) -- perpendicular to "down" — scatters dust sideways along the surface

  -- A small CLUSTER per footstep (2-3 particles, 4-6 while running) —
  -- reads as an actual puff kicking up rather than a trailing spark.
  -- Running already triggers this MORE OFTEN for free too, since
  -- walkTime (and therefore footstep timing) advances by actual distance
  -- covered per frame, which running increases directly — this only adds
  -- the extra per-footstep volume on top of that.
  local running = state.gamepadRunHeld
  local puffCount = (running and 4 or 2) + math.floor(math.random() * (running and 3 or 2))
  DustPuff.spawn(feetPos, downDir, sideDir, puffCount, 2.5, 0.2, 0.6)
end

-- Visual feedback for a wall-jump kick-off: a dust burst (roughly double
-- spawnWalkDust's walking baseline, bursting outward from the wall
-- instead of gently drifting up) plus a small, subtle expanding contact
-- ring (WallContactPulse — same "expanding fading ring" idea
-- Explosion.lua uses, just much smaller/quicker/more subdued, with no
-- core flash or fiery particle burst since the dust already covers that
-- role here). Called from Player:jump's wall-jump branch, BEFORE
-- self.pos/self.wallContactNormal change for the kick, so both land
-- exactly at the contact point.
function Player:spawnWallJumpEffects()
  local normal = self.wallContactNormal
  local sideDir = Vector2.new(-normal.y, normal.x)
  local intoWallDir = normal:clone():multiply(-1)

  local puffCount = 4 + math.floor(math.random() * 3) -- ~double spawnWalkDust's 2-3 walking baseline
  DustPuff.spawn(self.pos, intoWallDir, sideDir, puffCount, 3.5, 0.6, 1.2)

  if state.wallContactPulses then
    local WallContactPulse = require("lua.entities.WallContactPulse")
    table.insert(state.wallContactPulses, WallContactPulse.new(self.pos.x, self.pos.y))
  end
end

-- Walking off the end of an open path (a TiledTerrain run of ground, or
-- one of its curve paths — see TiledTerrain.lua) at arc position
-- desiredArcPos: does another one carry on from right there, the same
-- way he's going? Either starting there, or passing through — the path
-- over a hump runs on down the wall below it, so the path up that wall
-- ends partway along it. It has to be heading the way he's travelling,
-- and the key he's holding has to keep him going that way along it (a
-- curve path can read the keys the other way round — controlsReversed).
-- Returns it, and where on it he'd now be (the leftover distance carried
-- on), or nil.
local PATH_JOIN_DISTANCE = 6 -- world units: how close it must pass to where this one ends
local function findPathContinuation(planet, desiredArcPos)
  local perimeter = planet:getPerimeter()
  local forward = desiredArcPos > perimeter
  local edgeArc = forward and perimeter or 0
  local edge = planet:worldPointAtArcPosition(edgeArc, 0).point
  local seg = planet.segmentAtArcPosition and planet:segmentAtArcPosition(edgeArc)
  if not seg then return nil end
  local dir = forward and 1 or -1
  local travelX, travelY = seg.tangent.x * dir, seg.tangent.y * dir
  local keySign = dir * ((planet.isWallClimb and planet.controlsReversed) and -1 or 1)
  local leftover = forward and (desiredArcPos - perimeter) or -desiredArcPos
  local best, bestArc, bestD = nil, nil, PATH_JOIN_DISTANCE
  for _, other in ipairs(state.planetoids) do
    if other ~= planet and other.isOpenPath and other.arcPositionForWorldPoint and other.segmentAtArcPosition then
      local len = other:getPerimeter()
      local a = other:arcPositionForWorldPoint(edge.x, edge.y)
      local p = other:worldPointAtArcPosition(a, 0).point
      local d = math.sqrt((p.x - edge.x) ^ 2 + (p.y - edge.y) ^ 2)
      local oseg = d < bestD and other:segmentAtArcPosition(a)
      if oseg then
        local along = oseg.tangent.x * travelX + oseg.tangent.y * travelY
        local sigma = along > 0 and 1 or -1
        local wanted = keySign * ((other.isWallClimb and other.controlsReversed) and -1 or 1)
        if math.abs(along) > 0.5 and sigma == wanted then
          local arc = math.max(0, math.min(len, a + sigma * leftover))
          -- (Not one that just ends here too, the same way: nowhere to go on it.)
          if (sigma > 0 and a < len - 1) or (sigma < 0 and a > 1) then
            best, bestArc, bestD = other, arc, d
          end
        end
      end
    end
  end
  return best, bestArc
end

function Player:move(keys)
  -- Locked out while curling into/out of a ball (self.morphState — see
  -- enterBallMode/exitBallMode/updateBallMorph) OR while talking to an
  -- NPC (state.dialogueActive — see main.lua): treating `keys` as empty
  -- for the rest of this call means every ArrowLeft/ArrowRight check
  -- below naturally falls through to "no input," so he can't walk
  -- anywhere, while everything else this function still does
  -- (gravity-airborne handling, wall-climb bookkeeping, arc-position
  -- resync, etc.) keeps running exactly as normal rather than being
  -- skipped wholesale. isTeleporting (Beam.lua) gets the same treatment.
  if self.morphState or state.dialogueActive or self.isTeleporting or self.isDying then keys = {} end
  -- Sat on the ground for a beat after a ground pound lands (see
  -- GROUND_POUND_IMPACT_TICKS) — no walking off mid-impact. Jumping is
  -- still allowed, and ends the beat.
  -- (wasGroundPounding covers the one frame between touching down and
  -- Player:update starting that timer.)
  if self.groundPoundImpactTimer > 0 or (self.wasGroundPounding and self.onSurface) then keys = {} end

  -- Fired by a plunger (see lua/world/Plunger.lua): for a while he's
  -- driven on its way, faster than he can run, easing back to normal —
  -- unless he pushes back the other way, which ends it.
  local boost = self.launchBoost
  if boost then
    boost.time = boost.time - state.timeScale
    boost.mult = 1 + (boost.mult0 - 1) * math.max(0, boost.time / boost.time0)
    if boost.time <= 0 or keys[boost.dir > 0 and "ArrowLeft" or "ArrowRight"] or self.isDying then
      self.launchBoost, boost = nil, nil
    end
  end

  if self.onSurface and self.currentPlanet and self.currentPlanet.isRoundedRect then
    local planet = self.currentPlanet
    self.isWalking = false
    local ds = 0
    local rawSpeed = constants.PLAYER_LINEAR_SPEED * (state.gamepadRunHeld and self.runSpeedMultiplier or 1)
      * (self.isBall and BALL_SPEED_MULTIPLIER or 1)
    if boost then
      rawSpeed = rawSpeed * boost.mult
      keys = { [boost.dir > 0 and "ArrowRight" or "ArrowLeft"] = true }
    end
    local speed = rawSpeed * state.timeScale

    -- Unscaled (no state.timeScale) current ground speed+direction —
    -- Player:jump() carries this into the jump's own vel.x, same
    -- convention as every other platformer (a running jump launches you
    -- forward, not just straight up). Kept separate from ds/speed above
    -- specifically because self.vel gets state.timeScale applied again,
    -- on its own, during airborne integration — folding an
    -- already-timeScale'd value in here would double-apply it.
    self.groundMoveSpeedX = 0

    if keys["ArrowLeft"] then ds = -speed; self.facingDirection = -1; self.isWalking = true; self.groundMoveSpeedX = -rawSpeed end
    if keys["ArrowRight"] then ds = speed; self.facingDirection = 1; self.isWalking = true; self.groundMoveSpeedX = rawSpeed end

    -- On ice (an ice block's top — see WaterSystem.lua's "Ice" — or an
    -- ice tile of a dirt planet), his footing's slippery: his speed only
    -- eases toward what the keys ask for, so he slides on when he lets
    -- go and takes a moment to get going or turn round, the way ice is
    -- in most platformers. Anywhere else his speed is just what the keys
    -- say, as always (kept in iceSlide, so stepping onto ice carries it).
    local onIce = planet.isIce or (planet.iceUnder and planet:iceUnder(self))
    if onIce then
      local grip = math.min(1, ICE_GRIP * state.timeScale)
      self.iceSlide = (self.iceSlide or 0) + (ds - (self.iceSlide or 0)) * grip
      if math.abs(self.iceSlide) < 0.02 then self.iceSlide = 0 end
      ds = self.iceSlide
      self.groundMoveSpeedX = state.timeScale > 0 and ds / state.timeScale or 0
    else
      self.iceSlide = ds
    end

    if planet.walkPlayer then
      -- Planets that walk him themselves (CrackedPlanetoid.lua: steps,
      -- walls and drops in its dirt).
      planet:walkPlayer(self, ds)
    elseif planet.isSkyDome then
      local coreHalfWidth = planet.halfWidth - (planet.cornerRadius or 0)
      local minX = planet.pos.x - coreHalfWidth
      local maxX = planet.pos.x + coreHalfWidth
      local desiredX = self.pos.x + ds

      if desiredX < minX or desiredX > maxX then
        self.onSurface = false
        self.currentPlanet = nil
        self.vel = Vector2.new(ds * self.edgeFallCarryFraction, 0)
      else
        local topY = planet.trueSurfaceY and planet:trueSurfaceY() or (planet.pos.y - planet.halfHeight)
        self.pos = Vector2.new(desiredX, topY - self.radius)
      end
    else
      -- rampLeft's wall sits on the opposite side from rampRight's, so
      -- its arc-length-increasing direction is physically leftward
      -- instead of rightward (see buildRampClimbShape's own comment on
      -- controlsReversed) — flip ds here, once, before anything below
      -- reads it, so "climbing" always lines up with the key that
      -- visually walks the player into the ramp.
      if planet.isWallClimb and planet.controlsReversed then ds = -ds end

      -- Wall-climb shapes (see TiledTerrain.lua's buildRampClimbShape)
      -- detach the player if they STOP or REVERSE direction on the
      -- actual wall face OR the ceiling (isWallFace / isCeiling — see
      -- that file's own comments on each) — Sonic-loop style: nothing
      -- but committed momentum holds you to either, so easing off or
      -- changing your mind peels you off instead of leaving you glued
      -- in place. Not the curve leading into the wall, not the slope
      -- leading out of it, and not an ordinary flat ledge — turning
      -- around or standing still there is perfectly normal footing,
      -- same as any other ramp in the game. (No resting on the wall
      -- face either: it's just as sheer standing still as moving, so
      -- both zones share the same rule.)
      --
      -- self.wallClimbDir resets to nil once off BOTH zones, so entering
      -- either fresh always accepts whichever direction you arrive with
      -- as the baseline — but NOT when crossing from one into the
      -- other, since arc-length direction is one continuous thing
      -- across the whole climb; a commitment made on the wall still
      -- counts once you're over onto the ceiling. It ALSO resets on a
      -- planet swap (self.wallClimbDirPlanet — see that field's own
      -- comment): a fall off the end of one wall-climb shape can land
      -- the player on a DIFFERENT one mid-ceiling, and that shape may
      -- read the same held key with the opposite sign.
      local currentSeg = planet.isWallClimb and planet:segmentAtArcPosition(self.surfaceArcPos) or nil
      local onClimbZone = currentSeg ~= nil and (currentSeg.isWallFace or currentSeg.isCeiling)
      if planet ~= self.wallClimbDirPlanet then
        self.wallClimbDir = nil
        self.wallClimbDirPlanet = planet
      end

      local shouldDetach = false
      if onClimbZone then
        -- Requires the run button (state.gamepadRunHeld — Square on a
        -- PS5 pad), the same flag that already gates the run-speed
        -- multiplier on `speed` above: an ordinary walking pace isn't
        -- committed enough to hold either zone, matching stopping and
        -- reversing as things that peel the player off. Ball mode is
        -- ALWAYS treated as "running" for this specific check — a ball
        -- rolling with enough commitment to not stop or reverse (ds==0/
        -- direction-reversal detachment below still applies exactly the
        -- same either way) can cling to a wall or ceiling without also
        -- needing the run button held down.
        if ds == 0 or not (state.gamepadRunHeld or self.isBall) then
          shouldDetach = true
        else
          local dirSign = ds > 0 and 1 or -1
          if self.wallClimbDir and self.wallClimbDir ~= dirSign then
            shouldDetach = true
          else
            self.wallClimbDir = dirSign
          end
        end
      else
        self.wallClimbDir = nil
      end

      if shouldDetach then
        self.onSurface = false
        self.currentPlanet = nil
        self.vel = currentSeg.normal:multiply(self.wallClimbDetachPush)
      else
        -- Optional per-surface speed scaling (e.g. TiledTerrain slowing
        -- the player down climbing a 45-degree slope, speeding up
        -- descending one) — looked up at the CURRENT arc position,
        -- before stepping, since the segment the player is standing on
        -- right now is what should govern this step's speed. ds itself
        -- (still its pre-multiplied, direction-only value here) tells
        -- the surface which way along the segment this step is heading,
        -- which is what separates uphill from downhill. Duck-typed:
        -- surfaces without this method (every existing one) behave
        -- exactly as before.
        if type(planet.getArcSpeedMultiplier) == "function" then
          local slopeMul = planet:getArcSpeedMultiplier(self.surfaceArcPos, ds)
          -- Fired from a plunger (see self.launchBoost), climbing doesn't
          -- slow him: the boost only wears off over time.
          if self.launchBoost and slopeMul < 1 then slopeMul = 1 end
          ds = ds * slopeMul
        end
        -- Nor round the inside of a curve: ds is a distance along the
        -- ground, and on a curve that bends up into a wall his center
        -- (inside it) only covers part of that. Fired from a plunger, the
        -- step's stretched so he really moves the full distance.
        if self.launchBoost and ds ~= 0 and planet.isOpenPath then
          local len = planet:getPerimeter()
          local target = math.max(0, math.min(len, self.surfaceArcPos + ds))
          local p = planet:worldPointAtArcPosition(target, self.radius).point
          local moved = math.sqrt((p.x - self.pos.x) ^ 2 + (p.y - self.pos.y) ^ 2)
          local wanted = math.abs(target - self.surfaceArcPos)
          if moved > 1e-3 and moved < wanted then
            ds = ds * math.min(2, wanted / moved)
          end
        end

        local desiredArcPos = self.surfaceArcPos + ds

        -- isOpenPath surfaces (e.g. TiledTerrain — a hill has two ends, not
        -- a closed loop like RoundedRectPlanetoid) fall off the end instead
        -- of wrapping around, same "carry momentum into a fall" pattern
        -- SkyDome's own edge-of-deck check above already uses.
        -- Off the end of this one, but straight onto the start of the
        -- next (see findPathContinuation): carries on along that one, at
        -- any speed — instead of a moment in the air between the two,
        -- which at a plunger's launch speed sent him flying off over a
        -- hump in a ball tunnel.
        local nextPlanet, nextArcPos
        if planet.isOpenPath and (desiredArcPos < 0 or desiredArcPos > planet:getPerimeter()) then
          nextPlanet, nextArcPos = findPathContinuation(planet, desiredArcPos)
        end
        if nextPlanet then
          self.currentPlanet = nextPlanet
          self.surfaceArcPos = nextArcPos
          self.pos = nextPlanet:worldPointAtArcPosition(nextArcPos, self.radius).point
        elseif planet.isOpenPath and (desiredArcPos < 0 or desiredArcPos > planet:getPerimeter()) then
          -- Snap to the exact edge vertex before falling, rather than
          -- leaving self.pos wherever last frame's walk step landed (which
          -- can be up to one whole step short of the true end). Landing
          -- back on this same shape is decided purely by geometry from here
          -- on (CollisionSystem's swept crossing test) — starting exactly
          -- at the edge is what lets that test exclude a re-land on the
          -- very next frame instead of only after several more steps'
          -- worth of horizontal drift.
          local edgeArcPos = desiredArcPos < 0 and 0 or planet:getPerimeter()
          self.pos = planet:worldPointAtArcPosition(edgeArcPos, self.radius).point
          self.onSurface = false
          self.currentPlanet = nil
          -- Carried along the path's ACTUAL tangent at the edge, not
          -- assumed purely horizontal — ds is an arc-length rate, and
          -- "forward along the path" only equals "rightward in world
          -- space" for a shape whose tangent never really turns (an
          -- ordinary hill). A wall-climb shape's ceiling stretch runs
          -- backwards in world-x relative to its own ground/wall
          -- portions (same ds sign throughout, opposite dx) — carrying
          -- with plain (ds, 0) sent the player skidding back the way
          -- they came instead of on through, missing the neighboring
          -- shape they were supposed to fall onto and catch.
          local edgeSeg = planet.segmentAtArcPosition and planet:segmentAtArcPosition(edgeArcPos)
          local carryDir = edgeSeg and edgeSeg.tangent or Vector2.new(1, 0)
          -- (Fired from a plunger — self.launchBoost — he keeps ALL of it,
          -- and flies off like a cannonball, instead of dropping off near
          -- the edge the way walking off one does.)
          local carry = self.launchBoost and 1 or self.edgeFallCarryFraction
          self.vel = carryDir:multiply(ds * carry)
        else
          self.surfaceArcPos = desiredArcPos
          local worldSurface = planet:worldPointAtArcPosition(self.surfaceArcPos, self.radius)
          self.pos = worldSurface.point
        end
      end
    end

    if self.isWalking then
      self.walkTime = self.walkTime + (math.abs(ds) / self.strideLength) * math.pi * 2
      self:spawnWalkDust()
      -- Rolling-without-slipping: a wheel of radius r moving a signed
      -- distance ds rotates by exactly ds/r radians — ds is already the
      -- true signed world-unit displacement attempted this frame, so
      -- this is the physically correct spin rate, not just a stylized
      -- approximation. Wrapped via math.fmod every frame (same
      -- precaution Sun.lua's own unbounded-time bug taught — see that
      -- file's PLASMA_TIME_WRAP) so this angle never grows large enough
      -- to lose precision over a long play session.
      if self.isBall then
        self.ballRollAngle = math.fmod(self.ballRollAngle + ds / self.radius, math.pi * 2)
      end
    end

  elseif self.onSurface and self.currentPlanet then
    local surfaceDist = self.currentPlanet.radius + self.radius
    -- Walking the hard core at the bottom of a water planet (see
    -- WaterPlanet.lua) is still walking underwater — self.submergedIn
    -- stays true even once landed there (it's a plain distance-to-the-
    -- water-body's-own-center check, unrelated to onSurface/currentPlanet),
    -- so the same water resistance that slows swimming above also
    -- slows walking down here.
    local speedMul = (state.gamepadRunHeld and self.runSpeedMultiplier or 1) * (self.submergedIn and self.waterWalkSpeedMultiplier or 1)
      * (self.isBall and BALL_SPEED_MULTIPLIER or 1)
    local speed = constants.PLAYER_LINEAR_SPEED * speedMul * state.timeScale
    local angularSpeed = speed / surfaceDist

    self.isWalking = false
    local prevAngle = self.angle

    if keys["ArrowLeft"] then
      self.angle = self.angle - angularSpeed
      self.facingDirection = -1
      self.isWalking = true
    end
    if keys["ArrowRight"] then
      self.angle = self.angle + angularSpeed
      self.facingDirection = 1
      self.isWalking = true
    end
    self.pos.x = self.currentPlanet.pos.x + math.cos(self.angle) * surfaceDist
    self.pos.y = self.currentPlanet.pos.y + math.sin(self.angle) * surfaceDist

    if self.isWalking then
      local signedDistanceMoved = (self.angle - prevAngle) * surfaceDist
      self.walkTime = self.walkTime + (math.abs(signedDistanceMoved) / self.strideLength) * math.pi * 2
      self:spawnWalkDust()
      if self.isBall then
        self.ballRollAngle = math.fmod(self.ballRollAngle + signedDistanceMoved / self.radius, math.pi * 2)
      end
    end

  elseif (not self.onSurface) and self.lastInfluencePlanet
      and (self.lastInfluencePlanet.isSkyDome or self.lastInfluencePlanet.forceUprightJump or self.submergedIn
        or self.lastInfluencePlanet.isCrackedPlanet) then
    -- Ordinary circular planets deliberately don't get this fixed
    -- screen-space left/right air control at all — "sideways" isn't a
    -- well-defined direction on a sphere you could be approaching from
    -- any angle. SkyDome / forceUprightJump surfaces are the exception,
    -- reading fine with a plain fixed left/right.
    local lockedDir = self.wallJumpLockTimer > 0 and self.wallJumpLockBlockedDir or nil

    if self.submergedIn or self.lastInfluencePlanet.isCrackedPlanet then
      -- (A cracked planet — see CrackedPlanetoid.lua — gets this too: he
      -- stands upright to its center, so left and right in the air go
      -- round it, the same as walking, so he can jump up a ledge in its
      -- dirt and steer onto it.)
      --
      -- Orbits around the water body's own center instead of a fixed
      -- screen-space direction — same idea Player:move's own
      -- onSurface-on-a-round-planet branch above already uses for
      -- walking the seabed (ArrowRight always increases self.angle,
      -- i.e. always the SAME rotational sense regardless of where on
      -- the circle you currently are), just applied as a velocity nudge
      -- along the current TANGENT instead of directly setting position,
      -- since swimming is still physics-driven (gravity + drag), unlike
      -- walking's fixed-radius arc.
      --
      -- Deliberately decomposes vel into tangential + radial components
      -- and only ever touches the tangential one here — getting FARTHER
      -- from the water's center is NOT something ArrowLeft/ArrowRight
      -- can do at all, on purpose (a fixed screen-space nudge could
      -- carry a player near the water's left/right side straight out
      -- past the shore). The radial component — gravity pulling in, and
      -- Player:jump's own swim-stroke impulse pushing straight out — is
      -- preserved untouched, so that stays the only way to actually
      -- move toward or away from the center.
      local water = self.submergedIn or self.lastInfluencePlanet
      local radial = self.pos:subtract(water.pos)
      if radial:length() <= 0.01 then
        radial = Vector2.new(0, -1)
      elseif water.upAt then
        -- A planet's own "up" (a cracked planet's depends on its gravity
        -- mode); a pool of sprayed water has none, so straight out.
        radial = water:upAt(self.pos.x, self.pos.y)
      else
        radial:normalize()
      end
      local tangent = Vector2.new(-radial.y, radial.x)

      local tangentSpeed = self.vel:dot(tangent)
      local radialSpeed = self.vel:dot(radial)

      -- Same accel-toward-a-cap-without-fighting-existing-momentum
      -- shape the screen-space version below uses, just applied to the
      -- tangential speed instead of vel.x directly.
      -- Scaled by state.timeScale like every other per-frame rate (see
      -- the airborne branch below for why that matters).
      local swimAccel = self.airControlAccel * state.timeScale
      if keys["ArrowLeft"] and lockedDir ~= -1 then
        tangentSpeed = math.min(tangentSpeed, math.max(tangentSpeed - swimAccel, -self.airControlMaxSpeed))
        self.facingDirection = -1
      end
      if keys["ArrowRight"] and lockedDir ~= 1 then
        tangentSpeed = math.max(tangentSpeed, math.min(tangentSpeed + swimAccel, self.airControlMaxSpeed))
        self.facingDirection = 1
      end

      self.vel = tangent:multiply(tangentSpeed):add(radial:multiply(radialSpeed))
    else
      -- Nudges vel.x toward (and up to) airControlMaxSpeed in the held
      -- direction — but never REDUCES it if momentum carried from a
      -- running jump (see jump()'s own groundMoveSpeedX carry) already
      -- exceeds that cap. A plain clamp would snap a running jump's
      -- faster vel.x straight down to the cap (the run direction is
      -- still held going into the jump), which reads as sudden air
      -- friction. The outer math.min/math.max keeps the accelerated
      -- value only when it doesn't walk speed back DOWN toward the cap
      -- from above.
      --
      -- The cap itself follows the run button, same as ground speed
      -- does: walking speed without it, running speed with it, so
      -- holding a direction through a walking jump doesn't speed him up
      -- past walking speed. Because of the never-reduces rule above,
      -- letting go of run partway through a running jump keeps the
      -- speed he already has rather than braking him.
      --
      -- The acceleration is scaled by state.timeScale like every other
      -- per-frame rate, so air control is the same at any frame rate.
      local airMaxSpeed = constants.PLAYER_LINEAR_SPEED * (state.gamepadRunHeld and self.runSpeedMultiplier or 1)
      local airAccel = self.airControlAccel * state.timeScale
      if keys["ArrowLeft"] and lockedDir ~= -1 then
        self.vel.x = math.min(self.vel.x, math.max(self.vel.x - airAccel, -airMaxSpeed))
        self.facingDirection = -1
      end
      if keys["ArrowRight"] and lockedDir ~= 1 then
        self.vel.x = math.max(self.vel.x, math.min(self.vel.x + airAccel, airMaxSpeed))
        self.facingDirection = 1
      end
    end
  end
end

return Player
