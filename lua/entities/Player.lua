-- lua/entities/Player.lua
--
-- Scoped port of js/entities/Player.js focusing on:
--   - Existing physics / movement / landing / pull
--   - Full-body astronaut rig (body, head, arms, boots)
--   - Planet-surface orientation + walk cycle
--   - Basic left-arm aim toward mouse / pull target
--   - SkyDome pull/aim/walk toward grass deck (trueSurfaceY)
--
-- Not yet ported (deliberately): maze/platform modes, death/teleport
-- animations, Pixi path, invincibility flicker, etc.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local constants = require("lua.constants")
local Particle = require("lua.entities.Particle")

local Player = {}
Player.__index = Player

function Player.new(x, y)
  local self = setmetatable({}, Player)

  self.pos = Vector2.new(x, y)
  self.prevPos = Vector2.new(x, y)
  self.vel = Vector2.new(0, 0)
  self.sizeMultiplier = 1
  self.radius = constants.PLAYER_RADIUS * self.sizeMultiplier

  self.onSurface = false
  self.currentPlanet = nil
  self.lastInfluencePlanet = nil
  self.angle = 0
  self.surfaceArcPos = 0
  self.facingDirection = 1
  self.isGroundPounding = false
  self.mode = "space"

  self.isWalking = false
  self.walkTime = 0
  self.strideLength = 90
  self.lastWalkBobT = 0
  self.walkBobStrength = 3

  self.jumpHorizontalCarry = 0.6
  self.runSpeedMultiplier = 1.8
  self.runJumpMultiplier = 1.3
  self.airControlAccel = 0.3
  self.airControlMaxSpeed = 4
  self.edgeFallCarryFraction = 0.35

  -- Wall jump: which wall (if any) was touched THIS FRAME, set fresh
  -- every frame by CollisionSystem:handlePlayerWallCollisions — never
  -- stale. wallJumpUpwardRatio shapes the launch direction (1 = pure up,
  -- 0 = pure sideways-away-from-wall); 0.85 reads as "mostly up, kicked
  -- noticeably sideways," not a shallow skim off the wall.
  self.touchingWall = nil
  self.wallContactNormal = nil
  self.wallJumpUpwardRatio = 0.85

  -- Wall slide: while airborne, touching a wall, and holding the
  -- direction key INTO it, fall speed is capped to this (much slower
  -- than a normal fall) — see Player:update. Letting go of the direction
  -- key resumes a normal fall even while still touching the wall.
  -- isWallSliding is set fresh each frame in Player:update() and drives
  -- drawFullBody's dedicated wall-slide pose (see drawWallSlidePose).
  self.wallSlideMaxFallSpeed = 2.5
  self.isWallSliding = false

  -- Wall jump input lock: for wallJumpLockFrames (~60fps-frame units,
  -- scaled by state.timeScale like everything else) after a wall jump,
  -- input back toward the wall just kicked off is ignored — otherwise
  -- air control immediately starts canceling the kick if that direction
  -- is still held, and the jump never actually goes anywhere. Direction
  -- AWAY from the wall (and neutral) are never blocked, so committing to
  -- a longer leap works immediately. wallJumpLockBlockedDir is which
  -- ArrowLeft/ArrowRight direction (-1/1) is currently locked out; nil
  -- when no lock is active.
  self.wallJumpLockFrames = 12
  self.wallJumpLockTimer = 0
  self.wallJumpLockBlockedDir = nil

  -- Time values are in SECONDS (love.timer.getTime()), matching inputHandlers.lua
  self.mouseIdle = true
  self.mouseIdleThreshold = 2.0          -- seconds
  self.mouseWheelSuppressDuration = 0.2  -- seconds

  self.pullTarget = nil
  self.lockedTarget = nil
  self.pullAccel = 0.85
  self.pullMaxSpeed = 18
  self.pullTangentialDamping = 0.12

  -- Visual rig
  self.bodyScale = 0.1 * self.sizeMultiplier
  self.groundOffset = 250
  self.armSwingScale = 0.5
  self.maxAimFromForward = (90 + 5) * math.pi / 180
  self.headLookScale = 0.6
  self.headPivotFraction = 0.9
  self.blasterMuzzleLength = 300
  self.blasterAngleOffset = -5 * math.pi / 180

  self.bodyPartsConfig = {
    bodyY = 115,
    headY = -150,
    leftArmX = 136, leftArmY = 9, leftArmJointX = 73, leftArmJointY = 199,
    rightArmX = -186, rightArmY = -14, rightArmJointX = 119, rightArmJointY = 40,
    leftBootX = 111, leftBootY = 241, leftBootJointX = 83, leftBootJointY = 15,
    rightBootX = -142, rightBootY = 241, rightBootJointX = 77, rightBootJointY = 15
  }

  -- Aim cache
  self.aimShoulderPos = nil
  self.aimWorldAngle = 0
  self.aimRelativeAngle = 0
  self.aimAnchorPos = nil

  return self
end

------------------------------------------------------------------
-- Pull anchor (SkyDome → grass deck; others → center)
------------------------------------------------------------------

function Player:getPullAnchor(target)
  if not target then
    return self.pos.x, self.pos.y
  end
  if target.isSkyDome then
    if target.getPullAnchor then
      return target:getPullAnchor()
    end
    if target.trueSurfaceY then
      return target.pos.x, target:trueSurfaceY()
    end
  end
  return target.pos.x, target.pos.y
end

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
    local direction
    if planet.isRoundedRect and planet.nearestSurfacePoint then
      local surface = planet:nearestSurfacePoint(self.pos.x, self.pos.y)
      if surface.distance > 1e-6 then
        direction = Vector2.new(surface.point.x - self.pos.x, surface.point.y - self.pos.y):normalize()
      else
        direction = surface.normal:clone():multiply(-1)
      end
    else
      direction = planet.pos:subtract(self.pos):normalize()
    end
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
  if not planet then return Vector2.new(0, 1) end
  if planet.isRoundedRect then
    if planet.forceUprightJump then return Vector2.new(0, 1) end
    local surface = planet:nearestSurfacePoint(self.pos.x, self.pos.y)
    return surface.normal:clone():multiply(-1)
  end
  return planet.pos:subtract(self.pos):normalize()
end

function Player:getOutwardLaunchDirection()
  if not self.currentPlanet then return Vector2.new(0, -1) end
  if self.currentPlanet.isRoundedRect then
    local surface = self.currentPlanet:nearestSurfacePoint(self.pos.x, self.pos.y)
    local direction = surface.normal
    -- forceUprightJump (e.g. TiledTerrain's sloped segments) overrides
    -- whatever this surface's own local normal is — a 45-degree slope's
    -- normal points diagonally, but jumping off one should still launch
    -- straight up, same as a flat SkyDome deck already does (there, it's
    -- straight up only because a flat deck's own normal already equals
    -- (0,-1) — this makes the same result explicit for surfaces whose
    -- normal isn't vertical).
    if self.currentPlanet.forceUprightJump then
      direction = Vector2.new(0, -1)
    end
    if self.currentPlanet.isSkyDome or self.currentPlanet.forceUprightJump then
      local horizontalInput = 0
      if state.keys["ArrowLeft"] then horizontalInput = -1 end
      if state.keys["ArrowRight"] then horizontalInput = 1 end
      if horizontalInput ~= 0 then
        direction = Vector2.new(
          direction.x + horizontalInput * self.jumpHorizontalCarry,
          direction.y
        ):normalize()
      end
    end
    return direction
  end
  return self.pos:subtract(self.currentPlanet.pos):normalize()
end

function Player:jump()
  local jumpBoost = state.gamepadRunHeld and self.runJumpMultiplier or 1
  if self.onSurface and self.currentPlanet then
    local direction = self:getOutwardLaunchDirection()
    self.vel = direction:multiply(constants.JUMP_STRENGTH * jumpBoost)
    self.onSurface = false
    self.currentPlanet = nil
    if state.audioManager then state.audioManager:playJump() end
  elseif (not self.onSurface) and self.touchingWall then
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
    local direction = Vector2.new(self.wallContactNormal.x, -self.wallJumpUpwardRatio):normalize()
    self.vel = direction:multiply(constants.JUMP_STRENGTH * jumpBoost)

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
  end
end

function Player:tryGroundPound()
  if self.isGroundPounding then return end
  local planet = nil
  if state.gravitySystem then
    planet = state.gravitySystem:findDominantPlanet(self.pos)
  end
  planet = planet or self.lastInfluencePlanet
  if planet then
    local outwardDir
    if planet.isRoundedRect and planet.nearestSurfacePoint then
      local surface = planet:nearestSurfacePoint(self.pos.x, self.pos.y)
      outwardDir = surface.normal
    else
      outwardDir = self.pos:subtract(planet.pos):normalize()
    end
    local radialVel = self.vel:dot(outwardDir)
    if radialVel > 0 then self.isGroundPounding = true end
  end
end

-- h in degrees [0,360), s/l in [0,1] -> r,g,b in [0,1]. LÖVE has no CSS
-- color parsing (unlike the original's `hsl(...)` fillStyle string), so
-- the same random-hue-in-a-dusty-tan-range trick needs converting by
-- hand to feed Particle.color's plain {r,g,b} table.
local function hslToRgb(h, s, l)
  if s == 0 then return l, l, l end
  local function hueToRgb(p, q, t)
    if t < 0 then t = t + 1 end
    if t > 1 then t = t - 1 end
    if t < 1 / 6 then return p + (q - p) * 6 * t end
    if t < 1 / 2 then return q end
    if t < 2 / 3 then return p + (q - p) * (2 / 3 - t) * 6 end
    return p
  end
  local q = l < 0.5 and (l * (1 + s)) or (l + s - l * s)
  local p = 2 * l - q
  local hNorm = h / 360
  return hueToRgb(p, q, hNorm + 1 / 3), hueToRgb(p, q, hNorm), hueToRgb(p, q, hNorm - 1 / 3)
end

-- Shared dust-puff spawner: `count` particles at `pos`, scattered along
-- `sideDir` and drifting AWAY from `intoSurfaceDir` (the direction
-- pointing INTO whatever surface the dust is kicking off of — "down" for
-- a footstep, "into the wall" for a wall-jump kick) at a random speed
-- between driftMin/driftMax. Shared by spawnWalkDust and
-- spawnWallJumpEffects so the dusty tan/beige look (color, radius, drag,
-- growRate) only needs tuning in one place.
local function spawnDustPuff(pos, intoSurfaceDir, sideDir, count, sideSpreadScale, driftMin, driftMax)
  for _ = 1, count do
    local sideSpread = (math.random() - 0.5) * sideSpreadScale
    local driftSpeed = driftMin + math.random() * (driftMax - driftMin)
    local vel = sideDir:clone():multiply(sideSpread):add(intoSurfaceDir:clone():multiply(-driftSpeed))

    local particle = Particle.new(pos, vel, 22 + math.random() * 14)
    particle.color = { hslToRgb(35 + math.random() * 15, (30 + math.random() * 15) / 100, (55 + math.random() * 15) / 100) } -- dusty tan/beige
    particle.radius = 2 + math.random() * 1.5
    particle.drag = 0.9      -- slows down rather than drifting at constant speed forever, like real dust settling
    particle.growRate = 0.06 -- gently expands over its life, like a puff dispersing rather than staying a fixed-size dot
    table.insert(state.particles, particle)
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
  spawnDustPuff(feetPos, downDir, sideDir, puffCount, 2.5, 0.2, 0.6)
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
  spawnDustPuff(self.pos, intoWallDir, sideDir, puffCount, 3.5, 0.6, 1.2)

  if state.wallContactPulses then
    local WallContactPulse = require("lua.entities.WallContactPulse")
    table.insert(state.wallContactPulses, WallContactPulse.new(self.pos.x, self.pos.y))
  end
end

function Player:move(keys)
  if self.onSurface and self.currentPlanet and self.currentPlanet.isRoundedRect then
    local planet = self.currentPlanet
    self.isWalking = false
    local ds = 0
    local speed = constants.PLAYER_LINEAR_SPEED * (state.gamepadRunHeld and self.runSpeedMultiplier or 1) * state.timeScale

    if keys["ArrowLeft"] then ds = -speed; self.facingDirection = -1; self.isWalking = true end
    if keys["ArrowRight"] then ds = speed; self.facingDirection = 1; self.isWalking = true end

    if planet.isSkyDome then
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
      -- Optional per-surface speed scaling (e.g. TiledTerrain slowing the
      -- player down climbing a 45-degree slope, speeding up descending
      -- one) — looked up at the CURRENT arc position, before stepping,
      -- since the segment the player is standing on right now is what
      -- should govern this step's speed. ds itself (still its
      -- pre-multiplied, direction-only value here) tells the surface
      -- which way along the segment this step is heading, which is what
      -- separates uphill from downhill. Duck-typed: surfaces without this
      -- method (every existing one) behave exactly as before.
      if type(planet.getArcSpeedMultiplier) == "function" then
        ds = ds * planet:getArcSpeedMultiplier(self.surfaceArcPos, ds)
      end

      local desiredArcPos = self.surfaceArcPos + ds

      -- isOpenPath surfaces (e.g. TiledTerrain — a hill has two ends, not
      -- a closed loop like RoundedRectPlanetoid) fall off the end instead
      -- of wrapping around, same "carry momentum into a fall" pattern
      -- SkyDome's own edge-of-deck check above already uses.
      if planet.isOpenPath and (desiredArcPos < 0 or desiredArcPos > planet:getPerimeter()) then
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
        self.vel = Vector2.new(ds * self.edgeFallCarryFraction, 0)
      else
        self.surfaceArcPos = desiredArcPos
        local worldSurface = planet:worldPointAtArcPosition(self.surfaceArcPos, self.radius)
        self.pos = worldSurface.point
      end
    end

    if self.isWalking then
      self.walkTime = self.walkTime + (math.abs(ds) / self.strideLength) * math.pi * 2
      self:spawnWalkDust()
    end

  elseif self.onSurface and self.currentPlanet then
    local surfaceDist = self.currentPlanet.radius + self.radius
    local speed = constants.PLAYER_LINEAR_SPEED * (state.gamepadRunHeld and self.runSpeedMultiplier or 1) * state.timeScale
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
      local distanceMoved = math.abs(self.angle - prevAngle) * surfaceDist
      self.walkTime = self.walkTime + (distanceMoved / self.strideLength) * math.pi * 2
      self:spawnWalkDust()
    end

  elseif (not self.onSurface) and self.lastInfluencePlanet
      and (self.lastInfluencePlanet.isSkyDome or self.lastInfluencePlanet.forceUprightJump) then
    local lockedDir = self.wallJumpLockTimer > 0 and self.wallJumpLockBlockedDir or nil
    if keys["ArrowLeft"] and lockedDir ~= -1 then
      self.vel.x = math.max(self.vel.x - self.airControlAccel, -self.airControlMaxSpeed)
      self.facingDirection = -1
    end
    if keys["ArrowRight"] and lockedDir ~= 1 then
      self.vel.x = math.min(self.vel.x + self.airControlAccel, self.airControlMaxSpeed)
      self.facingDirection = 1
    end
  end
end

function Player:update()
  -- Captured before this frame's own movement, so CollisionSystem can
  -- compare "where was I a moment ago" against "where am I now" — a
  -- swept crossing test against open-path terrain, the same principle
  -- ordinary platformer tile collision uses instead of a plain distance
  -- check. See TerrainShape:findLandingCrossing.
  self.prevPos = self.pos:clone()

  if self.wallJumpLockTimer > 0 then
    self.wallJumpLockTimer = self.wallJumpLockTimer - state.timeScale
    if self.wallJumpLockTimer <= 0 then
      self.wallJumpLockBlockedDir = nil
    end
  end

  -- isWallSliding drives drawFullBody's dedicated wall-slide pose (see
  -- drawWallSlidePose) — reset false unconditionally, every frame,
  -- BEFORE the onSurface check below, not inside it: landing on a ledge
  -- or the ground mid-slide sets onSurface true, which would otherwise
  -- skip the whole airborne block below (reset included) and leave this
  -- stuck true forever, still rendering the wall-slide pose while
  -- standing on solid ground.
  self.isWallSliding = false

  if not self.onSurface then
    -- Wall slide: touchingWall/wallContactNormal reflect contact as of
    -- the END of last frame's collision pass (CollisionSystem resets and
    -- rechecks them once per frame in main.lua) — one frame behind, same
    -- as onSurface/currentPlanet already are by the same mechanism, and
    -- not something a player can perceive. Only caps a fall that's
    -- already faster than the slide speed, and only while the direction
    -- key into that wall is actively held — letting go resumes a normal
    -- fall immediately even while still touching it.
    --
    -- Facing is forced AWAY from the wall for the whole slide (not just
    -- at the kick-off, which already did this) to match how that pose
    -- was authored, and so there's no sudden snap-turn the instant he
    -- jumps off — he's already facing that way throughout.
    if self.touchingWall and self.wallContactNormal and self.vel.y > self.wallSlideMaxFallSpeed then
      local towardWallDir = self.wallContactNormal.x > 0 and -1 or 1
      local holdingIntoWall = (towardWallDir == -1 and state.keys["ArrowLeft"])
        or (towardWallDir == 1 and state.keys["ArrowRight"])
      if holdingIntoWall then
        self.vel.y = self.wallSlideMaxFallSpeed
        self.isWallSliding = true
        self.facingDirection = -towardWallDir
      end
    end

    self.vel = self.vel:multiply(constants.DRAG ^ state.timeScale)
    self.pos:add(self.vel:clone():multiply(state.timeScale))

    if self.pos.x - self.radius < 0 then self.pos.x = self.radius; self.vel.x = -self.vel.x end
    if self.pos.x + self.radius > state.sceneWidth then self.pos.x = state.sceneWidth - self.radius; self.vel.x = -self.vel.x end
    if self.pos.y - self.radius < 0 then self.pos.y = self.radius; self.vel.y = -self.vel.y end
    if self.pos.y + self.radius > state.sceneHeight then self.pos.y = state.sceneHeight - self.radius; self.vel.y = -self.vel.y end
  end

  self:updateOrientationAndFacing()
end

------------------------------------------------------------------
-- Facing / orientation
------------------------------------------------------------------

function Player:updateOrientationAndFacing()
  if self.mode ~= "space" then return end

  local lastMove = state.lastMouseMoveTime or 0
  local lastWheel = state.lastWheelTime or 0
  local now = love.timer.getTime()

  local recentlyScrolled = (now - lastWheel) < self.mouseWheelSuppressDuration
  self.mouseIdle = not self.lockedTarget
    and not state.gamepadAimActive
    and (recentlyScrolled or (now - lastMove) > self.mouseIdleThreshold)

  if self.mouseIdle then return end

  local planet = self.onSurface and self.currentPlanet or self.lastInfluencePlanet
  local downDir = self:visualDownDirection(planet)
  local downAngle = math.atan2(downDir.y, downDir.x)
  local orientation = downAngle - math.pi / 2
  local tangentX = math.cos(orientation)
  local tangentY = math.sin(orientation)

  local toTargetX, toTargetY
  if self.lockedTarget then
    toTargetX = self.lockedTarget.pos.x - self.pos.x
    toTargetY = self.lockedTarget.pos.y - self.pos.y
  elseif state.gamepadAimActive then
    toTargetX = state.gamepadAimX or 0
    toTargetY = state.gamepadAimY or 0
  else
    local cam = state.camera or { x = 0, y = 0 }
    local zoom = state.zoom or 1
    local mouse = state.mouse or { x = self.pos.x, y = self.pos.y }
    local mouseWorldX = mouse.x / zoom + cam.x
    local mouseWorldY = mouse.y / zoom + cam.y
    toTargetX = mouseWorldX - self.pos.x
    toTargetY = mouseWorldY - self.pos.y
  end

  -- Wall-jump facing lock and wall-sliding both force facing away from
  -- the wall on their own (see Player:jump and Player:update) — this
  -- mouse-driven reassignment is skipped while either is active, or it
  -- could flip him back around mid-slide/mid-lock just from moving the
  -- cursor, regardless of what direction is actually held.
  if self.wallJumpLockTimer <= 0 and not self.isWallSliding then
    local projection = toTargetX * tangentX + toTargetY * tangentY
    self.facingDirection = projection >= 0 and 1 or -1
  end
end

------------------------------------------------------------------
-- Aim helpers
------------------------------------------------------------------

function Player:worldAngleToLocalRotation(desiredWorldAngle, orientation, dirSign)
  if dirSign > 0 then
    return desiredWorldAngle - orientation
  end
  return (orientation + math.pi) - desiredWorldAngle
end

function Player:computeLeftArmAimAngle(orientation, dirSign, originPos)
  local cfg = self.bodyPartsConfig
  local s = self.bodyScale
  local cosO = math.cos(orientation)
  local sinO = math.sin(orientation)

  local offsetX = cfg.leftArmX * dirSign
  local offsetY = cfg.leftArmY
  local wx = offsetX * cosO - offsetY * sinO
  local wy = offsetX * sinO + offsetY * cosO
  local shoulderX = originPos.x + wx * s
  local shoulderY = originPos.y + wy * s

  local forwardAngle = dirSign > 0 and orientation or (orientation + math.pi)

  local targetWorldX, targetWorldY
  if self.lockedTarget then
    targetWorldX = self.lockedTarget.pos.x
    targetWorldY = self.lockedTarget.pos.y
  elseif self.pullTarget then
    targetWorldX, targetWorldY = self:getPullAnchor(self.pullTarget)
  elseif state.gamepadAimActive then
    targetWorldX = shoulderX + (state.gamepadAimX or 0) * 1000
    targetWorldY = shoulderY + (state.gamepadAimY or 0) * 1000
  else
    local cam = state.camera or { x = 0, y = 0 }
    local zoom = state.zoom or 1
    local mouse = state.mouse or { x = shoulderX, y = shoulderY }
    targetWorldX = mouse.x / zoom + cam.x
    targetWorldY = mouse.y / zoom + cam.y
  end

  local targetAngle = math.atan2(targetWorldY - shoulderY, targetWorldX - shoulderX)
  local relative = math.atan2(
    math.sin(targetAngle - forwardAngle),
    math.cos(targetAngle - forwardAngle)
  )

  if not self.lockedTarget then
    relative = math.max(-self.maxAimFromForward, math.min(self.maxAimFromForward, relative))
  end

  local clampedTargetAngle = forwardAngle + relative
  self.aimShoulderPos = Vector2.new(shoulderX, shoulderY)
  self.aimWorldAngle = clampedTargetAngle
  self.aimRelativeAngle = relative
  self.aimAnchorPos = self.pos:clone()

  return self:worldAngleToLocalRotation(clampedTargetAngle, orientation, dirSign)
end

function Player:computeHeadLookTilt(orientation, dirSign)
  local forwardAngle = dirSign > 0 and orientation or (orientation + math.pi)
  local desiredWorldAngle = forwardAngle + self.headLookScale * (self.aimRelativeAngle or 0)
  return self:worldAngleToLocalRotation(desiredWorldAngle, orientation, dirSign)
end

------------------------------------------------------------------
-- Drawing
------------------------------------------------------------------

function Player:drawLimb(img, offsetX, offsetY, jointX, jointY, angle, orientation, originPos, cosO, sinO, flipHorizontal)
  if not img then return end
  local s = self.bodyScale

  local wx = offsetX * cosO - offsetY * sinO
  local wy = offsetX * sinO + offsetY * cosO

  love.graphics.push()
  love.graphics.translate(originPos.x + wx * s, originPos.y + wy * s)
  love.graphics.rotate(orientation + angle)
  if flipHorizontal then
    love.graphics.scale(-1, 1)
  end
  love.graphics.draw(img, -jointX * s, -jointY * s, 0, s, s)
  love.graphics.pop()
end

-- Wall-slide pose, authored with paperdoll.html against the actual
-- bodyPartsConfig/drawLimb numbers, so these plug in directly with no
-- unit conversion. Authored facing RIGHT with the wall on the left —
-- i.e. facing AWAY from the wall, back braced against it — which is
-- exactly what Player:update() now forces facingDirection to do for the
-- whole slide, not just the kick-off, so this needs no extra mirroring.
-- jointX/jointY are omitted here (unchanged from bodyPartsConfig — the
-- pose only moves/rotates parts, it doesn't relocate their pivots).
local WALL_SLIDE_POSE = {
  leftBootX = 41.64,    leftBootY = 313.37, leftBootAngle = 34 * math.pi / 180,
  leftArmAngle = 49 * math.pi / 180,
  rightBootX = -138.98, rightBootY = 204.81, rightBootAngle = 0,
  rightArmAngle = 166 * math.pi / 180,
  headY = -125.87, headAngle = 13 * math.pi / 180,
}

-- A fixed pose — no walk-bob, no aim-follow, no airborne-raised-arm
-- logic, unlike drawFullBody's normal branch. Also its own z-order: the
-- right arm (reaching back across/over the head in this pose) is drawn
-- AFTER the head instead of before, per how it was authored.
function Player:drawWallSlidePose(orientation, originPos)
  local images = state.characterImages
  if not images then return end

  local cfg = self.bodyPartsConfig
  local pose = WALL_SLIDE_POSE
  local s = self.bodyScale
  local cosO = math.cos(orientation)
  local sinO = math.sin(orientation)

  self:drawLimb(images.leftboot, pose.leftBootX, pose.leftBootY, cfg.leftBootJointX, cfg.leftBootJointY, pose.leftBootAngle, orientation, originPos, cosO, sinO)
  self:drawLimb(images.leftarm, cfg.leftArmX, cfg.leftArmY, cfg.leftArmJointX, cfg.leftArmJointY, pose.leftArmAngle, orientation, originPos, cosO, sinO)

  if images.body then
    local bodyW, bodyH = images.body:getDimensions()
    love.graphics.push()
    love.graphics.translate(originPos.x, originPos.y)
    love.graphics.rotate(orientation)
    love.graphics.draw(images.body, -bodyW * s / 2, cfg.bodyY * s - bodyH * s / 2, 0, s, s)
    love.graphics.pop()
  end

  self:drawLimb(images.rightboot, pose.rightBootX, pose.rightBootY, cfg.rightBootJointX, cfg.rightBootJointY, pose.rightBootAngle, orientation, originPos, cosO, sinO)

  if images.head then
    local headW, headH = images.head:getDimensions()
    local headWX = -pose.headY * sinO
    local headWY = pose.headY * cosO
    local pivotY = headH * s * self.headPivotFraction
    love.graphics.push()
    love.graphics.translate(originPos.x + headWX * s, originPos.y + headWY * s)
    love.graphics.rotate(orientation + pose.headAngle)
    love.graphics.draw(images.head, -headW * s / 2, -pivotY, 0, s, s)
    love.graphics.pop()
  end

  self:drawLimb(images.rightarm, cfg.rightArmX, cfg.rightArmY, cfg.rightArmJointX, cfg.rightArmJointY, pose.rightArmAngle, orientation, originPos, cosO, sinO)
end

function Player:drawFullBody(orientation, originPos)
  local images = state.characterImages
  if not images then return end

  if self.isWallSliding then
    self:drawWallSlidePose(orientation, originPos)
    return
  end

  local cfg = self.bodyPartsConfig
  local s = self.bodyScale
  local cosO = math.cos(orientation)
  local sinO = math.sin(orientation)

  local walkAngle = (self.onSurface and self.isWalking) and (math.sin(self.walkTime) * 0.6) or 0
  local walkBobT = (self.onSurface and self.isWalking) and (math.sin(self.walkTime) ^ 2) or 0
  local walkBobAmount = walkBobT * self.walkBobStrength
  originPos = Vector2.new(
    originPos.x + -sinO * walkBobAmount,
    originPos.y + cosO * walkBobAmount
  )

  local dirSign = self.facingDirection < 0 and -1 or 1

  local leftBootAngle = walkAngle
  local rightBootAngle = -walkAngle
  local leftArmAngle, rightArmAngle
  local rightArmFlipped = false

  local aimAngle = self:computeLeftArmAimAngle(orientation, dirSign, originPos)
  if self.mouseIdle and not self.pullTarget then
    local swayAngle = (self.onSurface and self.isWalking)
      and (walkAngle * self.armSwingScale)
      or (math.sin(love.timer.getTime() * 1.5) * 0.15)
    leftArmAngle = swayAngle
    rightArmAngle = swayAngle
  else
    leftArmAngle = aimAngle
    rightArmAngle = walkAngle * self.armSwingScale
  end

  if not self.onSurface then
    leftBootAngle = -0.7
    rightBootAngle = 0.7
    local raisedWorldAngle = -math.pi / 2 - (math.pi * 0.75) * dirSign
    rightArmAngle = self:worldAngleToLocalRotation(raisedWorldAngle, orientation, dirSign)
    rightArmFlipped = true
  end

  self:drawLimb(images.leftboot, cfg.leftBootX, cfg.leftBootY, cfg.leftBootJointX, cfg.leftBootJointY, leftBootAngle, orientation, originPos, cosO, sinO)
  self:drawLimb(images.leftarm, cfg.leftArmX, cfg.leftArmY, cfg.leftArmJointX, cfg.leftArmJointY, leftArmAngle, orientation, originPos, cosO, sinO)

  if images.body then
    local bodyW, bodyH = images.body:getDimensions()
    love.graphics.push()
    love.graphics.translate(originPos.x, originPos.y)
    love.graphics.rotate(orientation)
    love.graphics.draw(images.body, -bodyW * s / 2, cfg.bodyY * s - bodyH * s / 2, 0, s, s)
    love.graphics.pop()
  end

  self:drawLimb(images.rightboot, cfg.rightBootX, cfg.rightBootY, cfg.rightBootJointX, cfg.rightBootJointY, rightBootAngle, orientation, originPos, cosO, sinO)
  self:drawLimb(images.rightarm, cfg.rightArmX, cfg.rightArmY, cfg.rightArmJointX, cfg.rightArmJointY, rightArmAngle, orientation, originPos, cosO, sinO, rightArmFlipped)

  if images.head then
    local headW, headH = images.head:getDimensions()
    local headWX = -cfg.headY * sinO
    local headWY = cfg.headY * cosO
    local headBob = (self.onSurface and self.isWalking) and (math.sin(self.walkTime * 2) * 0.03) or 0
    local headLookTilt = self.mouseIdle and 0 or self:computeHeadLookTilt(orientation, dirSign)
    local headTilt = headBob + headLookTilt
    local pivotY = headH * s * self.headPivotFraction

    love.graphics.push()
    love.graphics.translate(originPos.x + headWX * s, originPos.y + headWY * s)
    love.graphics.rotate(orientation + headTilt)
    love.graphics.draw(images.head, -headW * s / 2, -pivotY, 0, s, s)
    love.graphics.pop()
  end
end

function Player:draw()
  local planet = self.onSurface and self.currentPlanet or self.lastInfluencePlanet
  local downDir = self:visualDownDirection(planet)
  local downAngle = math.atan2(downDir.y, downDir.x)
  local orientation = downAngle - math.pi / 2

  local outwardDir = downDir:multiply(-1)
  local visualPos = self.pos:clone():add(outwardDir:multiply(self.groundOffset * self.bodyScale))

  local dirSign = self.facingDirection < 0 and -1 or 1

  love.graphics.push()
  love.graphics.translate(self.pos.x, self.pos.y)
  love.graphics.rotate(orientation)
  love.graphics.scale(dirSign, 1)
  love.graphics.rotate(-orientation)
  love.graphics.translate(-self.pos.x, -self.pos.y)

  self:drawFullBody(orientation, visualPos)

  love.graphics.pop()
end

------------------------------------------------------------------
-- Pull target
------------------------------------------------------------------

function Player:trySelectPullTarget(explicitTarget)
  if self.mode ~= "space" then return end

  local best = nil
  if explicitTarget then
    for _, p in ipairs(state.planetoids) do
      if p == explicitTarget and not explicitTarget.isPullExempt then
        best = explicitTarget
        break
      end
    end
  else
    local cam = state.camera or { x = 0, y = 0 }
    local zoom = state.zoom or 1
    local mouse = state.mouse or { x = self.pos.x, y = self.pos.y }
    local worldX = mouse.x / zoom + cam.x
    local worldY = mouse.y / zoom + cam.y

    local bestDistSq = math.huge
    for _, planet in ipairs(state.planetoids) do
      if not planet.isPullExempt then
        local hit = false
        if planet.containsPoint then
          hit = planet:containsPoint(worldX, worldY)
        else
          local dx = worldX - planet.pos.x
          local dy = worldY - planet.pos.y
          hit = (dx * dx + dy * dy) <= (planet.radius or 0) * (planet.radius or 0)
        end

        if hit then
          local ax, ay = self:getPullAnchor(planet)
          local adx = worldX - ax
          local ady = worldY - ay
          local distSq = adx * adx + ady * ady
          if distSq < bestDistSq then
            bestDistSq = distSq
            best = planet
          end
        end
      end
    end
  end

  if best then
    if self.onSurface and self.currentPlanet then
      local launchDir = self:getOutwardLaunchDirection()
      self.vel = launchDir:multiply(constants.JUMP_STRENGTH)
    end
    self.pullTarget = best
    self.onSurface = false
    self.currentPlanet = nil
    state.vatsActive = false
  end
end

function Player:clearPullTarget()
  self.pullTarget = nil
end

function Player:applyPullForce()
  if self.onSurface then self.pullTarget = nil; return end
  if not self.pullTarget then return end

  local stillActive = false
  for _, p in ipairs(state.planetoids) do
    if p == self.pullTarget then stillActive = true; break end
  end
  if not stillActive then
    self.pullTarget = nil
    return
  end

  local tx, ty = self:getPullAnchor(self.pullTarget)
  local dx = tx - self.pos.x
  local dy = ty - self.pos.y
  local dist = math.sqrt(dx * dx + dy * dy)
  if dist < 1e-6 then return end

  local dirX, dirY = dx / dist, dy / dist

  local radialSpeed = self.vel.x * dirX + self.vel.y * dirY
  local tangentX = self.vel.x - radialSpeed * dirX
  local tangentY = self.vel.y - radialSpeed * dirY
  local tangentRetention = (1 - self.pullTangentialDamping) ^ state.timeScale
  self.vel.x = self.vel.x - tangentX * (1 - tangentRetention)
  self.vel.y = self.vel.y - tangentY * (1 - tangentRetention)

  self.vel.x = self.vel.x + dirX * self.pullAccel * state.timeScale
  self.vel.y = self.vel.y + dirY * self.pullAccel * state.timeScale

  local speed = self.vel:length()
  if speed > self.pullMaxSpeed then
    self.vel = self.vel:multiply(self.pullMaxSpeed / speed)
  end
end

function Player:shootFireball()
  if self.mode ~= "space" and self.mode ~= "platform" then return end

  local now = love.timer.getTime()
  self.lastShotTime = self.lastShotTime or 0
  self.fireCooldown = self.fireCooldown or 0.15
  if now - self.lastShotTime < self.fireCooldown then return end
  self.lastShotTime = now

  local angle = self.aimWorldAngle or 0
  if self.blasterAngleOffset then
    angle = angle + self.blasterAngleOffset
  end

  local originX, originY
  if self.aimShoulderPos then
    local muzzleDist = (self.blasterMuzzleLength or 300) * (self.bodyScale or 0.1)
    originX = self.aimShoulderPos.x + math.cos(angle) * muzzleDist
    originY = self.aimShoulderPos.y + math.sin(angle) * muzzleDist
  else
    originX = self.pos.x
    originY = self.pos.y
  end

  state.fireballs = state.fireballs or {}
  local Fireball = require("lua.entities.Fireball")
  table.insert(state.fireballs, Fireball.new(originX, originY, angle))
end

function Player:tryLockTargetNext() end
function Player:tryLockTargetPrevious() end
function Player:clearLockTarget()
  self.lockedTarget = nil
end

return Player