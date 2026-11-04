-- lua/entities/player/Targeting.lua
--
-- Player methods for the pull beam, target lock, and firing fireballs and
-- ice bolts. Copied onto Player by lua/entities/Player.lua.

local state = require("lua.state")
local constants = require("lua.constants")
local TargetLock = require("lua.systems.TargetLock")

local Player = {}

------------------------------------------------------------------
-- Pull target
------------------------------------------------------------------

function Player:trySelectPullTarget(explicitTarget)
  if self.mode ~= "space" or self.isBall or self.isTeleporting or self.isDying then return end
  if self:isCannonRiding() then return end

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
  -- Curling into a ball drops any pull in progress outright, rather
  -- than leaving it silently paused mid-flight — a ball has no pull
  -- beam at all (see this session's own "no pull beam while a ball"
  -- request), so there's nothing for a stale pullTarget to resume once
  -- he un-morphs either.
  if self.isBall then self.pullTarget = nil; return end
  -- Same reasoning, for mid-teleport (Beam.lua) instead of ball mode —
  -- he's frozen in place either way, so a pull target left over from
  -- right before interacting with a beam shouldn't resume once he
  -- arrives somewhere else entirely.
  if self.isTeleporting or self.isDying then self.pullTarget = nil; return end

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

-- World position of the blaster's own muzzle — the hole at the end of his
-- arm — given where the arm is currently aimed (self.aimShoulderPos/
-- aimWorldAngle, set whenever he is drawn). Everything that comes out of
-- the blaster starts here: fireballs (shootFireball, just below) and the
-- pull beam (lua/effects/PullBeam.lua). Falls back to his own position
-- before he has ever been drawn.
function Player:getMuzzlePosition()
  -- Exact muzzle pixel within leftarm.png (602x256) — NOT the old
  -- fixed-distance-along-the-aim-angle approximation (blasterMuzzleLength),
  -- which only ever put the origin somewhere along the right ray, not
  -- necessarily where the blaster's own muzzle actually is once the arm's
  -- real rotation/scale/mirroring are accounted for.
  local MUZZLE_PX_X, MUZZLE_PX_Y = 530, 120

  local originX, originY
  if self.aimShoulderPos then
    local cfg = self.bodyPartsConfig
    local s = self.bodyScale
    local dirSign = self.facingDirection < 0 and -1 or 1
    local aimWorldAngle = self.aimWorldAngle or 0

    -- Raw offset (world units) from the arm's own joint pivot
    -- (leftArmJointX/Y — the pixel drawLimb lands exactly on the
    -- shoulder attach point) to the target muzzle pixel, still in the
    -- image's own unrotated local space.
    local vx = (MUZZLE_PX_X - cfg.leftArmJointX) * s
    local vy = (MUZZLE_PX_Y - cfg.leftArmJointY) * s

    local worldVX, worldVY
    if dirSign > 0 then
      -- Facing right (unmirrored): drawLimb's own rotate(orientation+
      -- localAngle) is exactly aimWorldAngle in world space (see
      -- computeLeftArmAimAngle/worldAngleToLocalRotation — the two
      -- cancel out cleanly for this case), so this local offset just
      -- rotates by aimWorldAngle directly.
      local c, sn = math.cos(aimWorldAngle), math.sin(aimWorldAngle)
      worldVX = vx * c - vy * sn
      worldVY = vx * sn + vy * c
    else
      -- Facing left: the whole rig is additionally mirrored by
      -- Player:drawRig's own outer scale(dirSign,1) (reflecting about
      -- the line through self.pos at angle `orientation`), which does
      -- NOT commute with the arm's own extra rotate(localAngle) the
      -- naive way. Working through the actual composed transform (same
      -- identity worldAngleToLocalRotation's own dirSign<0 branch is
      -- built on) reduces it to: flip this local offset horizontally,
      -- then rotate by (aimWorldAngle - pi) — not aimWorldAngle itself.
      local rot = aimWorldAngle - math.pi
      local c, sn = math.cos(rot), math.sin(rot)
      local fx, fy = -vx, vy
      worldVX = fx * c - fy * sn
      worldVY = fx * sn + fy * c
    end

    -- aimShoulderPos was worked out when he was last drawn. Shots are
    -- fired during the update, after he's moved since then, so carry
    -- the shoulder along by that same move — otherwise shots leave from
    -- where the muzzle was a frame ago, behind it when he's moving.
    local sx, sy = self.aimShoulderPos.x, self.aimShoulderPos.y
    if self.aimAnchorPos then
      sx = sx + (self.pos.x - self.aimAnchorPos.x)
      sy = sy + (self.pos.y - self.aimAnchorPos.y)
    end

    originX = sx + worldVX
    originY = sy + worldVY
  else
    originX = self.pos.x
    originY = self.pos.y
  end

  return originX, originY
end

function Player:shootFireball()
  if self.mode ~= "space" and self.mode ~= "platform" then return end
  if self.isBall or self.isTeleporting or self.isDying then return end
  if self:isCannonRiding() then return end
  if state.vatsActive then return end -- in V.A.T.S. he only picks a target and pulls to it (see main.lua's own V.A.T.S. rules)

  local now = love.timer.getTime()
  self.lastShotTime = self.lastShotTime or 0
  self.fireCooldown = self.fireCooldown or 0.15
  if now - self.lastShotTime < self.fireCooldown then return end
  self.lastShotTime = now

  local angle = self.aimWorldAngle or 0
  if self.blasterAngleOffset then
    angle = angle + self.blasterAngleOffset
  end

  local originX, originY = self:getMuzzlePosition()

  state.fireballs = state.fireballs or {}
  local Fireball = require("lua.entities.Fireball")
  table.insert(state.fireballs, Fireball.new(originX, originY, angle))
end

-- The ice blaster (see WeaponModes.lua's "ice" mode): the same as
-- shootFireball, but an ice bolt (see lua/entities/IceBolt.lua), a
-- little slower to fire.
local ICE_FIRE_COOLDOWN = 0.25
function Player:shootIceBolt()
  if self.mode ~= "space" and self.mode ~= "platform" then return end
  if self.isBall or self.isTeleporting or self.isDying then return end
  if self:isCannonRiding() then return end
  if state.vatsActive then return end

  local now = love.timer.getTime()
  if now - (self.lastShotTime or 0) < ICE_FIRE_COOLDOWN then return end
  self.lastShotTime = now

  local angle = (self.aimWorldAngle or 0) + (self.blasterAngleOffset or 0)
  local originX, originY = self:getMuzzlePosition()
  state.iceBolts = state.iceBolts or {}
  local IceBolt = require("lua.entities.IceBolt")
  table.insert(state.iceBolts, IceBolt.new(originX, originY, angle))
end

-- ----------------------------
-- HARD LOCK (gamepad R1 = next/clockwise, L1 = previous/counter-
-- clockwise, Circle = release) — see GamePadInput.lua for the button
-- wiring and lua/systems/TargetLock.lua for the actual candidate-
-- gathering/sorting logic.
-- ----------------------------
-- Both cycle from wherever the blaster is currently aimed
-- (self.aimWorldAngle — kept accurate every frame regardless of
-- source, so this works whether there's no lock yet, starting from
-- whatever the normal aim system currently has it pointed at, or an
-- existing lock, since aimWorldAngle already equals the angle to the
-- current lockedTarget by the time either of these runs again). The
-- two are mirror images of each other, so in the common case a single
-- R1 press followed by a single L1 press (or vice versa) lands back on
-- whatever was locked before, reading as a genuine undo.
function Player:tryLockTargetNext()
  if self.mode ~= "space" or self.isDying or self.isTeleporting or self.isBall then return end
  local originPos = self.aimShoulderPos or self.pos
  local referenceAngle = self.aimWorldAngle or 0
  self.lockedTarget = TargetLock.selectNextLockTarget(self.lockedTarget, referenceAngle, originPos)
end

function Player:tryLockTargetPrevious()
  if self.mode ~= "space" or self.isDying or self.isTeleporting or self.isBall then return end
  local originPos = self.aimShoulderPos or self.pos
  local referenceAngle = self.aimWorldAngle or 0
  self.lockedTarget = TargetLock.selectPreviousLockTarget(self.lockedTarget, referenceAngle, originPos)
end

function Player:clearLockTarget()
  self.lockedTarget = nil
end

return Player
