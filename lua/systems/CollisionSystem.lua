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

function CollisionSystem:handlePlayerPlanetCollisions(player)
  for _, planet in ipairs(state.planetoids) do
    if planet.isSpikey then
      local dist = player.pos:subtract(planet.pos):length()
      if dist <= planet.radius + player.radius + constants.SURFACE_TOLERANCE then
        player:startDeath()
        return
      end
    end
  end

  if player.onSurface then return end

  if player.pullTarget then
    if not player.pullTarget.isSpikey and self:tryLandOnPlanet(player, player.pullTarget) then
      player.pullTarget = nil
    end
    return
  end

  for _, planet in ipairs(state.planetoids) do
    if not planet.isSpikey then
      if self:tryLandOnPlanet(player, planet) then return end
    end
  end

  player.onSurface = false
  player.currentPlanet = nil
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

      player.pos = surface.point:clone():add(surface.normal:clone():multiply(player.radius))
      player.onSurface = true
      player.currentPlanet = planet
      player.lastInfluencePlanet = planet

      -- arcPosition only if the planet implements it (full rounded-rect).
      -- SkyDome may only expose a minimal stub or none at all.
      if type(planet.arcPositionForWorldPoint) == "function" then
        player.surfaceArcPos = planet:arcPositionForWorldPoint(player.pos.x, player.pos.y)
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