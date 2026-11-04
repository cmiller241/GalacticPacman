-- lua/systems/water/Effects.lua
--
-- Splashes and steam: spawning them, hot spots boiling water off, and
-- drawing the steam.
-- Part of the water system: see lua/systems/WaterSystem.lua.

local state = require("lua.state")
local Tuning = require("lua.systems.water.Tuning")
local SPLASH_BITS = Tuning.SPLASH_BITS
local SPLASH_SECONDS = Tuning.SPLASH_SECONDS
local BOIL_PER_SECOND = Tuning.BOIL_PER_SECOND
local HOT_SECONDS = Tuning.HOT_SECONDS
local STEAM_PER_SECOND = Tuning.STEAM_PER_SECOND
local STEAM_SECONDS = Tuning.STEAM_SECONDS
local STEAM_RISE = Tuning.STEAM_RISE
local STEAM_START_DEPTH = Tuning.STEAM_START_DEPTH
local STEAM_SIZE = Tuning.STEAM_SIZE
local STEAM_GROWTH = Tuning.STEAM_GROWTH
local STEAM_ALPHA = Tuning.STEAM_ALPHA
local COLOR_STEAM = Tuning.COLOR_STEAM
local Shared = require("lua.systems.water.Shared")
local shared = Shared.shared
local Scratch = Shared.Scratch
local Oceans = require("lua.systems.water.Oceans")
local depthOf = Oceans.depthOf
local surfaceDistance = Oceans.surfaceDistance
local LevelGrid = require("lua.systems.water.LevelGrid")
local boilGrid = LevelGrid.boilGrid
local PlanetGrids = require("lua.systems.water.PlanetGrids")
local boilPlanetGrid = PlanetGrids.boilPlanetGrid

-- (lava: lava splashing, drawn hot instead of watery.)
local function spawnSplash(x, y, upX, upY, lava)
  for _ = 1, SPLASH_BITS do
    local a = math.atan2(upY, upX) + (math.random() * 2 - 1) * 1.1
    local speed = 1.5 + math.random() * 2.5
    table.insert(shared.splashes, {
      x = x, y = y, vx = math.cos(a) * speed, vy = math.sin(a) * speed,
      gx = -upX * 0.3, gy = -upY * 0.3,
      life = SPLASH_SECONDS, size = 1 + math.random() * 1.5, lava = lava,
    })
  end
end

----------------------------------------------------------------------
-- Fireballs and steam
----------------------------------------------------------------------

-- A puff of steam off the surface at (x, y), rising away from the water
-- (up: which way that is), within `spread` radians of it. It starts a
-- little below the surface, so it's seen coming up out of the water.
local function spawnSteam(x, y, upX, upY, spread)
  local a = math.atan2(upY, upX) + (math.random() * 2 - 1) * (spread or 0.6)
  local speed = STEAM_RISE * (0.5 + math.random())
  local life = STEAM_SECONDS * (0.7 + math.random() * 0.6)
  local depth = STEAM_START_DEPTH * (0.3 + math.random() * 0.7)
  x, y = x - upX * depth, y - upY * depth
  shared.steam[#shared.steam + 1] = {
    x = x + (math.random() * 2 - 1) * 6, y = y + (math.random() * 2 - 1) * 3,
    vx = math.cos(a) * speed, vy = math.sin(a) * speed, life = life, maxLife = life,
  }
end

-- Hot spots boiling water off (and steaming), tailing off as they cool;
-- the steam rising and fading.
local function updateSteam(dt)
  local ts = state.timeScale or 1
  local gameDt = ts / 60 -- (timeScale is in 60fps ticks)

  for i = #shared.hotSpots, 1, -1 do
    local h = shared.hotSpots[i]
    local heat = h.life / HOT_SECONDS
    local amount = BOIL_PER_SECOND * heat * gameDt
    local sx, sy, upX, upY
    local o = h.planet and shared.oceans[h.planet]
    if h.planet then
      if o then
        o.volume = math.max(0, o.volume - amount)
        local depth = depthOf(h.planet, o.volume)
        -- The water's surface near the spot (spread a little round it;
        -- the spot moves with the planetoid, and sinks as it boils off).
        local qx = h.planet.pos.x + h.ox + (math.random() * 2 - 1) * 20
        local qy = h.planet.pos.y + h.oy + (math.random() * 2 - 1) * 20
        local d
        d, upX, upY = surfaceDistance(h.planet, qx, qy)
        sx, sy = qx + upX * (depth - d), qy + upY * (depth - d)
      end
    elseif h.pg then
      sx, sy, upX, upY = boilPlanetGrid(h.pg, h.c, h.r, amount)
    elseif shared.grid then
      sx, sy = boilGrid(h.c, h.r, amount)
      upX, upY = 0, -1
    end
    h.steamBudget = h.steamBudget + STEAM_PER_SECOND * heat * gameDt
    while h.steamBudget >= 1 do
      h.steamBudget = h.steamBudget - 1
      if sx then spawnSteam(sx, sy, upX, upY, 0.4) end
    end
    h.life = h.life - gameDt
    if h.life <= 0 or not sx then table.remove(shared.hotSpots, i) end
  end

  local gone
  for i = #shared.steam, 1, -1 do
    local s = shared.steam[i]
    s.life = s.life - gameDt
    if s.life <= 0 then
      gone = gone or {}
      gone[s] = true
    else
      s.vx = s.vx + (math.random() - 0.5) * 0.06 * ts -- (drifting a little)
      s.x, s.y = s.x + s.vx * ts, s.y + s.vy * ts
    end
  end
  if gone then Scratch.removeMarked(shared.steam, gone) end
end

local function drawSteam()
  for _, s in ipairs(shared.steam) do
    local t = 1 - s.life / s.maxLife
    local alpha = STEAM_ALPHA * (1 - t) * math.min(1, 0.5 + t * 6) -- (seen from the start, still under the water)
    love.graphics.setColor(COLOR_STEAM[1], COLOR_STEAM[2], COLOR_STEAM[3], alpha)
    love.graphics.circle("fill", s.x, s.y, STEAM_SIZE + STEAM_GROWTH * t)
  end
  love.graphics.setColor(1, 1, 1, 1)
end

return {
  spawnSplash = spawnSplash,
  spawnSteam = spawnSteam,
  updateSteam = updateSteam,
  drawSteam = drawSteam,
}
