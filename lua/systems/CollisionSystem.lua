-- lua/systems/CollisionSystem.lua
--
-- Full port of js/systems/CollisionSystem.js.
-- SkyDome landing uses the grass deck (nearestSurfacePoint) and does not
-- require arcPositionForWorldPoint unless the planet actually provides it.

local state = require("lua.state")
local constants = require("lua.constants")
local Vector2 = require("lua.vector2")

local CollisionSystem = {}
CollisionSystem.__index = CollisionSystem

function CollisionSystem.new()
  return setmetatable({}, CollisionSystem)
end

function CollisionSystem:distanceToPlanetSurface(pos, planet)
  if planet.isRoundedRect then
    return planet:distanceToSurface(pos.x, pos.y)
  end
  return pos:subtract(planet.pos):length() - planet.radius
end

function CollisionSystem:handleImmovableCollisions(immovables, movables)
  for _, im in ipairs(immovables) do
    for _, mv in ipairs(movables) do
      if not mv.isImmovable then
        local normal, targetPos
        local domeContact = nil

        if im.isRoundedRect then
          local topY = im.pos.y - im.halfHeight
          local usingDome = type(im.nearestDomeSurfacePoint) == "function" and mv.pos.y < topY
          local usingBase = (not usingDome) and type(im.nearestBaseSurfacePoint) == "function" and mv.pos.y > topY
          local surface
          if usingDome then
            surface = im:nearestDomeSurfacePoint(mv.pos.x, mv.pos.y)
          elseif usingBase then
            surface = im:nearestBaseSurfacePoint(mv.pos.x, mv.pos.y)
          else
            surface = im:nearestSurfacePoint(mv.pos.x, mv.pos.y)
          end

          if surface.distance < mv.radius then
            normal = surface.normal
            targetPos = surface.point:clone():add(normal:clone():multiply(mv.radius))
            if usingDome then domeContact = surface.point end
          end
        else
          local offset = mv.pos:subtract(im.pos)
          local dist = offset:length()
          local minDist = im.radius + mv.radius
          if dist < minDist and dist > 0 then
            normal = offset:normalize()
            targetPos = im.pos:clone():add(normal:multiply(minDist))
          end
        end

        if normal and targetPos then
          mv.pos = targetPos
          local dot = mv.vel:dot(normal)
          mv.vel = mv.vel:subtract(normal:multiply(2 * dot))

          if domeContact and type(im.triggerShieldImpact) == "function" then
            local intensity = math.min(1, mv.radius / 60)
            im:triggerShieldImpact(domeContact.x, domeContact.y, intensity)
          end
        end
      end
    end
  end
end

function CollisionSystem:handlePlayerFireBarCollisions(player, fireBars)
  for _, bar in ipairs(fireBars) do
    local blockDist = player.pos:subtract(bar.pos):length()
    if blockDist <= bar.blockRadius + player.radius + constants.SURFACE_TOLERANCE then
      player:startDeath()
      return
    end
    for _, f in ipairs(bar:getFireballPositions()) do
      local dx = player.pos.x - f.x
      local dy = player.pos.y - f.y
      local dist = math.sqrt(dx * dx + dy * dy)
      if dist <= f.radius + player.radius + constants.SURFACE_TOLERANCE then
        player:startDeath()
        return
      end
    end
  end
end

-- Solid axis-aligned walls (TiledTerrain's WallShape) — plain circle-vs-
-- rectangle push-out, blocking the player from every side, unlike the
-- one-way "stand on top of me" TerrainShape surfaces above. Runs every
-- frame regardless of onSurface, since a wall should stop the player
-- whether they're walking into it or jumping into it.
function CollisionSystem:handlePlayerWallCollisions(player, walls)
  if not walls then return end

  -- Vertical CAPSULE instead of a bare circle: player.pos still anchors
  -- the BOTTOM circle exactly as before (every other system — ground
  -- distance, water, enemies — keeps treating that the same way), and
  -- segTopY is how much further UP the capsule's center segment
  -- extends, derived from Player.lua's own headReach (how tall he
  -- actually looks, helmet included) minus this circle's own radius,
  -- since the top circle already contributes that much reach on its
  -- own. Without this, a plain circle centered near his feet never
  -- reached anywhere close to his actual head height, so a low ceiling
  -- tile could visibly clip through his helmet without ever registering
  -- a collision. headReach<=player.radius collapses segTopY back to
  -- player.pos.y, i.e. exactly the old single-circle behavior.
  -- Zeroed out while morphed into a ball (see Player.lua's own
  -- isBall/drawBallMode) — a ball is drawn as a plain circle with
  -- nothing reaching up past its own radius, so the capsule collapses
  -- back to an ordinary circle there, matching what's actually drawn.
  --
  -- ALSO zeroed out while on a wall-climb shape (TiledTerrain's
  -- ceilingLeft/ceilingRight/wall-face/ceiling loop-de-loop geometry —
  -- see planet.isWallClimb). This capsule's "head" always extends in
  -- WORLD-SPACE UP (segTopY below is a plain Y offset), regardless of
  -- which way the player is actually oriented — fine on ordinary
  -- ground, where up really is up, but while climbing a wall or
  -- running upside-down along a ceiling, the player's own true "up"
  -- (away from the surface) is sideways or inverted. Right at a
  -- ceilingRight/ceilingLeft tile's own seam into the flat ceiling
  -- run, that fixed world-up extension pokes straight into the very
  -- ceiling tile being walked onto, registering a bogus collision that
  -- blocked the transition outright — confirmed against a real
  -- screenshot showing the (non-rotating) capsule sitting inside the
  -- wall there. There's no equivalent "low ceiling bonks your upright
  -- head" scenario during a wall-climb traversal anyway, so — same as
  -- ball mode — this just collapses back to a plain circle rather than
  -- attempting to rotate the capsule to match the surface (a much
  -- larger change to the box-distance math below, which currently
  -- relies on the capsule staying purely vertical).
  local onWallClimb = player.onSurface and player.currentPlanet and player.currentPlanet.isWallClimb
  local headReach = (not player.isBall and not onWallClimb) and (player.headReach or 0) or 0
  local segBottomY = player.pos.y
  local segTopY = player.pos.y - math.max(0, headReach - player.radius)

  for _, wall in ipairs(walls) do
    local boxMinX, boxMaxX = wall.pos.x - wall.halfWidth, wall.pos.x + wall.halfWidth
    local boxMinY, boxMaxY = wall.pos.y - wall.halfHeight, wall.pos.y + wall.halfHeight

    -- Nearest point ON THE CAPSULE'S OWN CENTER SEGMENT to the wall's
    -- center, then the nearest point ON THE WALL to THAT — exact for a
    -- vertical segment against an axis-aligned box, since the segment's
    -- X never varies along its length (the two clamps reduce to the
    -- ordinary single-point circle case whenever segTopY == segBottomY).
    local segY = math.max(segTopY, math.min(wall.pos.y, segBottomY))
    local closestX = math.max(boxMinX, math.min(player.pos.x, boxMaxX))
    local closestY = math.max(boxMinY, math.min(segY, boxMaxY))
    local dx, dy = player.pos.x - closestX, segY - closestY
    local distSq = dx * dx + dy * dy

    if distSq < player.radius * player.radius then
      local dist = math.sqrt(distSq)
      local normal, penetration

      if dist > 1e-6 then
        normal = Vector2.new(dx / dist, dy / dist)
        penetration = player.radius - dist
      else
        -- Capsule's center segment passes exactly inside the rectangle
        -- (only reachable by tunneling through in one big step) — push
        -- out along whichever axis has the smaller overlap, the
        -- standard AABB-resolution fallback for a zero-distance closest
        -- point, just measured against the capsule's own full vertical
        -- extent (segTopY-radius .. segBottomY+radius) instead of a
        -- single Y value.
        local overlapX = (wall.halfWidth + player.radius) - math.abs(player.pos.x - wall.pos.x)
        local overlapY = math.min(segBottomY + player.radius, boxMaxY) - math.max(segTopY - player.radius, boxMinY)
        if overlapX < overlapY then
          normal = Vector2.new(player.pos.x >= wall.pos.x and 1 or -1, 0)
          penetration = overlapX
        else
          normal = Vector2.new(0, player.pos.y >= wall.pos.y and 1 or -1)
          penetration = overlapY
        end
      end

      player.pos:add(normal:multiply(penetration))
      local intoWall = player.vel:dot(normal)
      if intoWall < 0 then
        player.vel = player.vel:subtract(normal:multiply(intoWall))
      end

      -- Wall-jump contact: only for a genuine SIDE face (normal mostly
      -- horizontal), not landing on top of a low wall block (normal
      -- mostly vertical) — a wall jump only makes sense pushed against a
      -- vertical surface. Reset every frame by main.lua before this pass
      -- runs, so it only ever reflects contact from THIS frame, never a
      -- wall the player has since drifted away from.
      if math.abs(normal.x) > math.abs(normal.y) then
        player.touchingWall = wall
        player.wallContactNormal = normal:clone()
      end

      -- If this push moved the player while they're walking a TerrainShape
      -- (arc-length position), resync surfaceArcPos to the corrected
      -- position — otherwise the arc position keeps advancing every frame
      -- the player walks into the wall while their actual pos stays
      -- clamped at it, and walking back away only starts moving again
      -- once that gap has been walked off first.
      if player.onSurface and player.currentPlanet
         and type(player.currentPlanet.arcPositionForWorldPoint) == "function" then
        player.surfaceArcPos = player.currentPlanet:arcPositionForWorldPoint(player.pos.x, player.pos.y)
      end
    end
  end
end

function CollisionSystem:handleElasticCollisions(entities1, entities2, radiusProp1, radiusProp2, massProp1, massProp2)
  entities2 = entities2 or entities1
  radiusProp1 = radiusProp1 or "radius"
  radiusProp2 = radiusProp2 or "radius"
  massProp1 = massProp1 or "mass"
  massProp2 = massProp2 or "mass"
  local sameArray = (entities1 == entities2)

  local maxRadius = 0
  for _, e in ipairs(entities1) do
    local r = e[radiusProp1]
    if r and r > maxRadius then maxRadius = r end
  end
  if not sameArray then
    for _, e in ipairs(entities2) do
      local r = e[radiusProp2]
      if r and r > maxRadius then maxRadius = r end
    end
  end
  local gridSize = math.max(maxRadius * 2, 50)

  local grid = {}
  for j, e in ipairs(entities2) do
    local col = math.floor(e.pos.x / gridSize)
    local row = math.floor(e.pos.y / gridSize)
    local key = col .. "," .. row
    local bucket = grid[key]
    if not bucket then
      bucket = {}
      grid[key] = bucket
    end
    table.insert(bucket, j)
  end

  for i, p1 in ipairs(entities1) do
    local col = math.floor(p1.pos.x / gridSize)
    local row = math.floor(p1.pos.y / gridSize)

    for dRow = -1, 1 do
      for dCol = -1, 1 do
        local bucket = grid[(col + dCol) .. "," .. (row + dRow)]
        if bucket then
          for _, j in ipairs(bucket) do
            if not (sameArray and j <= i) then
              local p2 = entities2[j]
              if not (p1.isImmovable or p2.isImmovable) then
                local offset = p1.pos:subtract(p2.pos)
                local distSq = offset:lengthSq()
                local sumR = p1[radiusProp1] + p2[radiusProp2]
                local sumRSq = sumR * sumR
                if distSq < sumRSq and distSq > 0 then
                  local dist = math.sqrt(distSq)
                  local overlap = sumR - dist
                  local normal = offset:normalize()
                  local tangent = Vector2.new(-normal.y, normal.x)
                  local m1, m2 = p1[massProp1], p2[massProp2]
                  local totalMass = m1 + m2
                  local sep1 = overlap * (m2 / totalMass)
                  local sep2 = overlap * (m1 / totalMass)
                  p1.pos:add(normal:multiply(sep1))
                  p2.pos:add(normal:multiply(-sep2))
                  local v1, v2 = p1.vel:clone(), p2.vel:clone()
                  local v1n, v2n = normal:dot(v1), normal:dot(v2)
                  local v1t, v2t = tangent:dot(v1), tangent:dot(v2)
                  local new_v1n = (v1n * (m1 - m2) + 2 * m2 * v2n) / totalMass
                  local new_v2n = (v2n * (m2 - m1) + 2 * m1 * v1n) / totalMass
                  p1.vel = normal:multiply(new_v1n):add(tangent:multiply(v1t))
                  p2.vel = normal:multiply(new_v2n):add(tangent:multiply(v2t))
                end
              end
            end
          end
        end
      end
    end
  end
end

-- Smallest t in [0,1] along the segment a->b where a circle of radius r
-- centered at (cx,cy) is first entered (a<->b parametrized as
-- a + t*(b-a)), or nil if the segment never comes within r of the
-- circle at all. Standard ray/segment-vs-circle intersection (solve
-- |a + t*(b-a) - center| = r for t, keep the smaller root); falls back
-- to a direct endpoint-inside check for the (rare, discriminant<0 but
-- an endpoint still qualifies) case where the segment barely grazes
-- the circle right at one of its own ends rather than truly crossing
-- it. Used below so a fast-moving player (pull beam especially, or any
-- large enough single-frame movement/timeScale combination) is stopped
-- exactly at a spikey planetoid's own boundary, not wherever this
-- frame's full, uninterrupted movement would otherwise have carried
-- them — a same-frame endpoint-only check can't do that: it only ever
-- sees "did I END UP close enough," which a big enough single-frame
-- jump can skip right over.
local function sweptCircleEntryT(ax, ay, bx, by, cx, cy, r)
  local dx, dy = bx - ax, by - ay
  local fx, fy = ax - cx, ay - cy
  local a = dx * dx + dy * dy
  if a < 1e-9 then
    return (fx * fx + fy * fy <= r * r) and 0 or nil
  end
  local b = 2 * (fx * dx + fy * dy)
  local c = fx * fx + fy * fy - r * r
  local disc = b * b - 4 * a * c
  if disc < 0 then
    if fx * fx + fy * fy <= r * r then return 0 end
    local gx, gy = bx - cx, by - cy
    if gx * gx + gy * gy <= r * r then return 1 end
    return nil
  end
  local sq = math.sqrt(disc)
  local t1, t2 = (-b - sq) / (2 * a), (-b + sq) / (2 * a)
  if t1 > 1 or t2 < 0 then return nil end
  local tEnter = math.max(0, t1)

  -- If the segment STARTS already on/inside the boundary (c <= 0) while
  -- moving OUTWARD from here (b >= 0, i.e. distance-to-center is
  -- increasing for the rest of the segment), this isn't a genuine new
  -- penetration to resolve — it's the far more common "already resting
  -- right at the boundary, now moving away" case, and t1 collapses to
  -- 0 here (the starting point) purely because that's where the
  -- infinite line touches the circle, not because anything is actually
  -- being entered. Reporting a collision here clamps the player straight
  -- back to their PREVIOUS position every single frame, silently
  -- canceling their own escape movement — confirmed bug: jumping (or
  -- pull-beaming) off a Spikey while resting exactly on its boundary
  -- kept snapping the player right back in place, reading as "stuck in
  -- a perpetual jump." Only an already-touching start moving INWARD
  -- (b < 0) is a real, ongoing collision.
  if tEnter <= 0 and c <= 1e-6 and b >= 0 then
    return nil
  end

  return tEnter
end

function CollisionSystem:handlePlayerPlanetCollisions(player)
  if player.onSurface then return end

  if player.pullTarget then
    if self:tryLandOnPlanet(player, player.pullTarget) then
      player.pullTarget = nil
    end
    return
  end

  for _, planet in ipairs(state.planetoids) do
    if self:tryLandOnPlanet(player, planet) then return end
  end

  player.onSurface = false
  player.currentPlanet = nil
end

-- Spikey (lua/world/Spikey.lua) is deliberately NOT a planet anymore —
-- no gravity, no onSurface landing, no orbital walking around it, not
-- even pull-targetable (it isn't in state.planetoids at all, so
-- TargetLock/GravitySystem never see it in the first place). It's just
-- a solid, impassable obstacle: touching it from any angle stops the
-- player right at its boundary and sets touchingWall/wallContactNormal
-- exactly like an ordinary TiledTerrain wall does, so the EXISTING
-- wall-jump code in Player:jump() is what actually lets him "jump off
-- of it" — no separate escape mechanism needed. Falling/jumping onto
-- the TOP of one reads as briefly resting there (gravity from whatever
-- else is dominant keeps pushing him back against this same solid
-- boundary each frame) rather than a real landed stance — there's
-- nothing here setting onSurface, so he never gets an orbit-walk
-- surface to move along, matching "impassable object, not a planet."
function CollisionSystem:handlePlayerSpikeyCollisions(player, spikeys)
  if not spikeys then return end

  -- Swept, not just a same-frame endpoint check: player.prevPos (set at
  -- the top of Player:update(), before that frame's own movement — see
  -- its own comment there) lets this measure the whole PATH traveled
  -- this frame against each Spikey's own solid boundary, catching
  -- contact regardless of approach angle (falling onto one, jumping
  -- sideways into one, pull-beaming past one) or speed — a same-frame
  -- endpoint-only check can miss a fast enough single-frame movement
  -- entirely.
  local prevPos = player.prevPos or player.pos
  for _, spikey in ipairs(spikeys) do
    local r = spikey.radius + player.radius + constants.SURFACE_TOLERANCE
    local t = sweptCircleEntryT(prevPos.x, prevPos.y, player.pos.x, player.pos.y, spikey.pos.x, spikey.pos.y, r)
    if t then
      player.pos.x = prevPos.x + (player.pos.x - prevPos.x) * t
      player.pos.y = prevPos.y + (player.pos.y - prevPos.y) * t

      local nx, ny = player.pos.x - spikey.pos.x, player.pos.y - spikey.pos.y
      local ndist = math.sqrt(nx * nx + ny * ny)
      local normal = ndist > 1e-6 and Vector2.new(nx / ndist, ny / ndist) or Vector2.new(0, -1)

      -- Cancel the velocity component still driving INTO the spikey
      -- (same idea the ordinary wall push-out uses) so gravity from
      -- whatever else is dominant can keep him settled against it
      -- (resting on top, sliding along a side, etc.) without
      -- re-tunneling in on the next frame.
      local into = player.vel:dot(normal)
      if into < 0 then
        player.vel = player.vel:subtract(normal:multiply(into))
      end

      -- Same fields CollisionSystem:handlePlayerWallCollisions sets on
      -- real wall contact — this alone is what makes Player:jump()'s
      -- existing wall-jump branch fire off of a Spikey too, with no
      -- separate "jump off a spikey" code needed.
      player.touchingWall = spikey
      player.wallContactNormal = normal

      -- Still lethal contact — startDeath() is currently an empty stub
      -- (no death/respawn/damage system exists yet), so this is a
      -- no-op today, but it's exactly where a future life-gauge hit
      -- should hook in. Fires every frame contact continues (there's no
      -- "already hit this frame" debounce) — reasonable for a spike
      -- hazard's continuous contact damage, but worth deciding
      -- deliberately once a real damage system exists rather than
      -- inheriting this by accident.
      player:startDeath()
    end
  end
end

function CollisionSystem:tryLandOnPlanet(player, planet)
  if planet.isRoundedRect then
    -- SkyDome: only land inside gravity window, while falling / neutral
    if planet.isSkyDome then
      if type(planet.isWithinGravityWindow) == "function"
         and not planet:isWithinGravityWindow(player.pos.x, player.pos.y) then
        return false
      end
      if player.vel.y < 0 then
        return false
      end
    end

    -- Open-path terrain (TiledTerrain ledges/hills) lands via a swept
    -- crossing test — was the player above the surface a moment ago, are
    -- they at/through it now, and are they actually over its span —
    -- instead of "is the player currently near any point on this shape."
    -- That's the same principle ordinary platformer tile collision uses,
    -- and it's what makes jumping through from underneath, and walking
    -- straight off the end, just work: neither is ever a valid crossing,
    -- so no special-cased timers or tuned distance tolerances are needed.
    local surface
    if planet.isOpenPath and type(planet.findLandingCrossing) == "function" then
      local prev = player.prevPos or player.pos
      surface = planet:findLandingCrossing(prev.x, prev.y, player.pos.x, player.pos.y)
      if not surface then return false end
    else
      surface = planet:nearestSurfacePoint(player.pos.x, player.pos.y)
    end

    if surface.distance <= player.radius + constants.SURFACE_TOLERANCE then
      -- For SkyDome, also require horizontally over the deck
      if planet.isSkyDome then
        local minX = planet.pos.x - planet.halfWidth
        local maxX = planet.pos.x + planet.halfWidth
        if player.pos.x < minX - player.radius or player.pos.x > maxX + player.radius then
          return false
        end
      end

      -- forceUprightJump surfaces (TiledTerrain) always rest the player
      -- straight up from the contact point, not along the segment's own
      -- (possibly diagonal) normal — matches the vertical push
      -- TerrainShape:worldPointAtArcPosition uses for walking, and the
      -- forced-upright rotation in Player:visualDownDirection. Landing
      -- with a normal-based push here while walking uses a vertical one
      -- would itself be a one-frame position jolt right at touchdown.
      local restOffset = planet.forceUprightJump
        and Vector2.new(0, -player.radius)
        or surface.normal:clone():multiply(player.radius)
      player.pos = surface.point:clone():add(restOffset)
      player.onSurface = true
      player.currentPlanet = planet
      player.lastInfluencePlanet = planet

      -- arcPosition only if the planet implements it (full rounded-rect).
      -- SkyDome may only expose a minimal stub or none at all.
      if type(planet.arcPositionForWorldPoint) == "function" then
        -- excludeWallFace=true: see TerrainShape:arcPositionForWorldPoint's
        -- own comment — landing should never resolve onto the wall face
        -- itself (findLandingCrossing already refused to land there; this
        -- keeps the arc-position lookup that follows in agreement with it).
        player.surfaceArcPos = planet:arcPositionForWorldPoint(player.pos.x, player.pos.y, true)
      elseif planet.isSkyDome then
        local minX = planet.pos.x - planet.halfWidth
        player.surfaceArcPos = player.pos.x - minX
      end

      local impactVel = player.vel:clone()
      player.vel = Vector2.new(0, 0)

      if player.isGroundPounding then
        player.isGroundPounding = false
        -- SkyDome is immovable — don't shove it
        if not planet.isImmovable then
          local pushDir = surface.normal:clone():multiply(-1)
          planet.vel:add(pushDir:multiply(impactVel:length() * constants.GROUND_POUND_PUSH_STRENGTH))
        end
      end
      return true
    end
    return false
  end

  -- Water planets (WaterPlanet.lua) are never solid ground — the player
  -- should sink straight through the surface into it instead of landing
  -- and sticking there like any other planet. Player:update() tracks
  -- self.submergedIn separately (checking plain distance-to-center
  -- against planet.radius) to apply water drag and enable the swim
  -- stroke in Player:jump(); gravity keeps pulling toward the center
  -- the whole time since GravitySystem:applyTo only ever stops for a
  -- planet once onSurface is true, which this deliberately never sets.
  if planet.isWaterPlanet then return false end

  local offset = player.pos:subtract(planet.pos)
  local dist = offset:length()
  local surfaceDist = planet.radius + player.radius
  if dist <= surfaceDist + constants.SURFACE_TOLERANCE then
    local normal = offset:normalize()
    player.pos = planet.pos:clone():add(normal:multiply(surfaceDist))
    player.onSurface = true
    player.currentPlanet = planet
    player.lastInfluencePlanet = planet
    local impactVel = player.vel:clone()
    player.vel = Vector2.new(0, 0)
    player.angle = math.atan2(player.pos.y - planet.pos.y, player.pos.x - planet.pos.x)
    if player.isGroundPounding then
      player.isGroundPounding = false
      if not planet.isImmovable then
        local pushDir = normal:multiply(-1)
        planet.vel:add(pushDir:multiply(impactVel:length() * constants.GROUND_POUND_PUSH_STRENGTH))
      end
    end
    return true
  end
  return false
end

function CollisionSystem:handlePlayerAsteroidCollisions(player, asteroids)
  if not asteroids then return end
  for _, a in ipairs(asteroids) do
    local dist = player.pos:subtract(a.pos):length()
    if dist <= player.radius + a.radius then
      if player.startDeath then
        player:startDeath()
      end
      return
    end
  end
end

function CollisionSystem:handlePlayerEnemyCollisions(player, enemies)
  for _, e in ipairs(enemies) do
    local dist = player.pos:subtract(e.pos):length()
    if dist <= player.radius + constants.ENEMY_RADIUS then
      player:startDeath()
      return
    end
  end
end

function CollisionSystem:handlePlayerGoombaCollisions(player, goombas)
  local stomped = {}
  for _, g in ipairs(goombas) do
    local dist = player.pos:subtract(g.pos):length()
    if dist <= player.radius + g.radius then
      local isStomp = (g.pos.y - player.pos.y) > g.radius * 0.3 and player.vel.y >= 0
      if isStomp then
        table.insert(stomped, g)
      else
        player:startDeath()
      end
    end
  end
  return stomped
end

function CollisionSystem:handleFireballGoombaCollisions(fireballs, goombas)
  local hitFireballs = {}
  local killedGoombas = {}

  for _, f in ipairs(fireballs) do
    for _, g in ipairs(goombas) do
      if not killedGoombas[g] then
        local dist = f.pos:subtract(g.pos):length()
        if dist < f.radius + g.radius then
          hitFireballs[f] = true
          killedGoombas[g] = true
          break
        end
      end
    end
  end

  return hitFireballs, killedGoombas
end

function CollisionSystem:handlePlayerBlobCollisions(player, blobs)
  for _, b in ipairs(blobs) do
    local dist = player.pos:subtract(b:getWorldPos()):length()
    if dist <= player.platformHalfExtent + b.radius then
      player:startDeath()
      return
    end
  end
end

function CollisionSystem:handleFireballBlobCollisions(fireballs, blobs)
  local hitFireballs = {}
  local killedBlobs = {}

  for _, f in ipairs(fireballs) do
    for _, b in ipairs(blobs) do
      if not killedBlobs[b] then
        local dist = f.pos:subtract(b:getWorldPos()):length()
        if dist < f.radius + b.radius then
          hitFireballs[f] = true
          killedBlobs[b] = true
          break
        end
      end
    end
  end

  return hitFireballs, killedBlobs
end

function CollisionSystem:handleCoinCollisions(player, coins)
  for i = #coins, 1, -1 do
    local c = coins[i]
    local dist = player.pos:subtract(c.pos):length()
    if dist <= player.radius + constants.COIN_RADIUS then
      if state.audioManager then state.audioManager:playEatDot() end
      table.remove(coins, i)
      state.score = state.score + 1
    end
  end
end

function CollisionSystem:handlePlanetAsteroidCollisions(planetoids, asteroids)
  local toBreak = {}
  if not asteroids then return toBreak end

  for _, p in ipairs(planetoids) do
    for _, a in ipairs(asteroids) do
      -- Skipped for the sky dome: its own nearestSurfacePoint is a
      -- crude, UNBOUNDED flat-line distance (abs(worldY - topY), no X
      -- clamping applied to the distance itself, only to the returned
      -- point) — not the dome's actual curved silhouette. Used as-is
      -- here, it could flag an asteroid far off to either side of the
      -- dome (well outside its halfWidth) as "touching the surface"
      -- just for being at the right height. The dome/base-specific
      -- checks below already correctly cover both halves of its real
      -- shape, so it doesn't need this generic fallback at all.
      if not p.isSkyDome then
        local dist = self:distanceToPlanetSurface(a.pos, p)
        if dist < a.radius then
          toBreak[a] = true
        end
      end

      if type(p.nearestDomeSurfacePoint) == "function" then
        local topY = p.pos.y - (p.halfHeight or 0)
        if a.pos.y < topY then
          local domeSurface = p:nearestDomeSurfacePoint(a.pos.x, a.pos.y)
          if domeSurface.distance < a.radius then
            toBreak[a] = true
            if type(p.triggerShieldImpact) == "function" then
              local intensity = math.min(1, a.radius / 45)
              p:triggerShieldImpact(domeSurface.point.x, domeSurface.point.y, intensity)
            end
          end
        end
      end

      if type(p.nearestBaseSurfacePoint) == "function" then
        local topY = p.pos.y - (p.halfHeight or 0)
        if a.pos.y > topY then
          local baseSurface = p:nearestBaseSurfacePoint(a.pos.x, a.pos.y)
          if baseSurface.distance < a.radius then
            toBreak[a] = true
          end
        end
      end
    end
  end

  return toBreak
end

function CollisionSystem:handleFireballCollisions(fireballs, planetoids, asteroids)
  local hitFireballs = {}
  local toBreakAsteroids = {}
  local planetHits = {}

  for _, f in ipairs(fireballs) do
    local hit = false

    for _, a in ipairs(asteroids) do
      local dist = f.pos:subtract(a.pos):length()
      if dist < f.radius + a.radius then
        hitFireballs[f] = true
        toBreakAsteroids[a] = true
        hit = true
        break
      end
    end

    if not hit then
      for _, p in ipairs(planetoids) do
        local skipRest = false
        if p.isSkyDome then
          local topY = p.pos.y - (p.halfHeight or 0)
          if f.pos.y >= topY then
            skipRest = true
          else
            if type(p.nearestDomeSurfacePoint) == "function" then
              local domeSurface = p:nearestDomeSurfacePoint(f.pos.x, f.pos.y)
              if domeSurface.distance < f.radius then
                hitFireballs[f] = true
                table.insert(planetHits, { fireball = f, planet = p })
                if type(p.triggerShieldImpact) == "function" then
                  local intensity = math.min(1, f.radius / 45)
                  p:triggerShieldImpact(domeSurface.point.x, domeSurface.point.y, intensity)
                end
              end
              skipRest = true
            end
          end
        end
        if not skipRest then
          local dist = self:distanceToPlanetSurface(f.pos, p)
          if dist < f.radius then
            hitFireballs[f] = true
            table.insert(planetHits, { fireball = f, planet = p })
            break
          end
        end
      end
    end
  end

  return hitFireballs, toBreakAsteroids, planetHits
end

function CollisionSystem:handlePlayerMazeGhostCollisions(player, ghosts)
  if not ghosts then return end
  for _, g in ipairs(ghosts) do
    if player.mazeCol == g.mazeCol and player.mazeRow == g.mazeRow then
      player:startDeath()
      return
    end
  end
end

return CollisionSystem