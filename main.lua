-- main.lua

local state = require("lua.state")
local constants = require("lua.constants")
local Vector2 = require("lua.vector2")
local Planetoid = require("lua.world.Planetoid")
local Player = require("lua.entities.Player")
local Asteroid = require("lua.entities.Asteroid")
local GravitySystem = require("lua.systems.GravitySystem")
local CollisionSystem = require("lua.systems.CollisionSystem")
local Starfield = require("lua.world.Starfield")
local Sun = require("lua.world.Sun")
local PullBeam = require("lua.effects.PullBeam")
local assetLoading = require("lua.setup.assetLoading")
local inputHandlers = require("lua.setup.inputHandlers")
local gamepadInput = require("lua.setup.gamepadInput")
local Coin = require("lua.entities.Coin")

local collisionSystem

local ZOOM_MIN = 0.1
local ZOOM_MAX = 2.5
local ZOOM_STEP_PER_FRAME = 0.02
local VATS_TIME_SCALE = 0.05
local VATS_EASE_RATE = 0.12
local VATS_EASE_SNAP_THRESHOLD = 0.005

local function spawnTestCoins()
  state.coins = {}
  for _, planet in ipairs(state.planetoids) do
    local count = 4 + math.floor(math.random() * 4)  -- 4–7 coins per planet
    for i = 1, count do
      table.insert(state.coins, Coin.new(planet))
    end
  end
end

local function spawnTestPlanetoids()
  state.planetoids = {
    Planetoid.new(1500, 1500, 180, { 0.75, 0.78, 0.85, 1 }),
    Planetoid.new(2600, 1100, 100, { 0.95, 0.45, 0.40, 1 }),
    Planetoid.new(2400, 2200, 130, { 0.45, 0.85, 0.50, 1 }),
    Planetoid.new(900,  2300,  90, { 0.95, 0.85, 0.40, 1 }),
  }
  for _, p in ipairs(state.planetoids) do
    p:createRingCanvas()
  end
end

local function spawnTestAsteroids()
  state.asteroids = {}
  for i = 1, 14 do
    local r = 16 + math.random() * 38
    local x = math.random() * state.sceneWidth
    local y = math.random() * state.sceneHeight
    table.insert(state.asteroids, Asteroid.new(x, y, r))
  end
end

function love.load()
  love.window.setTitle("Asteroid Bob")

  state.sceneWidth = 3500
  state.sceneHeight = 3500
  state.zoom = 1
  state.zoomMax = ZOOM_MAX
  state.zoomMin = ZOOM_MIN
  state.zoomTarget = nil
  state.timeScale = 1
  state.timeScaleTarget = 1
  state.vatsActive = false
  state.vatsAutoEnterOnLock = true
  state.vatsTimeScale = VATS_TIME_SCALE
  state.score = 0
  state.level = 1
  state.fireballs = {}

  assetLoading.loadAssets()
  inputHandlers.attachInputHandlers()

  collisionSystem = CollisionSystem.new()
  state.starfield = Starfield.new()

  spawnTestPlanetoids()
  spawnTestAsteroids()
  spawnTestCoins()

  state.sun = Sun.new(state.sceneWidth / 2, state.sceneHeight / 2, 480)
  state.gravitySystem = GravitySystem.new(state.planetoids)

  local startPlanet = state.planetoids[1]
  local surfaceDist = startPlanet.radius + constants.PLAYER_RADIUS
  state.player = Player.new(startPlanet.pos.x, startPlanet.pos.y - surfaceDist)
  state.player.onSurface = true
  state.player.currentPlanet = startPlanet
  state.player.lastInfluencePlanet = startPlanet
  state.player.angle = math.atan2(state.player.pos.y - startPlanet.pos.y, state.player.pos.x - startPlanet.pos.x)
end

local function updatePlanetoidsPhysics()
  for _, p in ipairs(state.planetoids) do
    if p.isImmovable then
      p.vel.x, p.vel.y = 0, 0
    else
      p.pos:add(p.vel:clone():multiply(state.timeScale))
      if p.pos.x - p.radius < 0 then p.pos.x = p.radius; p.vel.x = -p.vel.x end
      if p.pos.x + p.radius > state.sceneWidth then p.pos.x = state.sceneWidth - p.radius; p.vel.x = -p.vel.x end
      if p.pos.y - p.radius < 0 then p.pos.y = p.radius; p.vel.y = -p.vel.y end
      if p.pos.y + p.radius > state.sceneHeight then p.pos.y = state.sceneHeight - p.radius; p.vel.y = -p.vel.y end
    end
  end
end

function love.update(dt)
  if dt > 0 then
    state.fps = (state.fps or 0) * 0.9 + (1 / dt) * 0.1
  end

  gamepadInput.pollGamepad(dt)

  state.timeScaleTarget = state.vatsActive and VATS_TIME_SCALE or 1
  local timeScaleDiff = state.timeScaleTarget - state.timeScale
  if math.abs(timeScaleDiff) < VATS_EASE_SNAP_THRESHOLD then
    state.timeScale = state.timeScaleTarget
  else
    state.timeScale = state.timeScale + timeScaleDiff * VATS_EASE_RATE
  end

  updatePlanetoidsPhysics()

  if state.asteroids then
    for _, a in ipairs(state.asteroids) do
      a:update()
    end
  end

  if state.coins then
    for _, c in ipairs(state.coins) do
      c:update()
    end
  end

  state.player:move(state.keys)

  if state.player.pullTarget then
    state.player:applyPullForce()
  else
    state.gravitySystem:applyTo(state.player)
  end

  state.player:update()

  -- Core collisions
  collisionSystem:handlePlayerPlanetCollisions(state.player)
  collisionSystem:handleElasticCollisions(state.planetoids)

  -- Asteroid collisions (matches JS flow)
  if state.asteroids and #state.asteroids > 0 then
    collisionSystem:handlePlayerAsteroidCollisions(state.player, state.asteroids)
    collisionSystem:handleElasticCollisions(state.asteroids)

    local toBreak = collisionSystem:handlePlanetAsteroidCollisions(state.planetoids, state.asteroids)
    if next(toBreak) then
      for i = #state.asteroids, 1, -1 do
        if toBreak[state.asteroids[i]] then
          table.remove(state.asteroids, i)
        end
      end
    end
  end

  if state.coins then
    collisionSystem:handleCoinCollisions(state.player, state.coins)
  end

    -- Fireballs
  if state.fireballs then
    for i = #state.fireballs, 1, -1 do
      local f = state.fireballs[i]
      f:update()
      if f:isDead() then
        table.remove(state.fireballs, i)
      end
    end

    -- Optional: collide with asteroids / planets
    if #state.fireballs > 0 and state.asteroids then
      local hitFireballs, toBreakAsteroids = collisionSystem:handleFireballCollisions(
        state.fireballs, state.planetoids, state.asteroids
      )
      -- remove hit fireballs
      for i = #state.fireballs, 1, -1 do
        if hitFireballs[state.fireballs[i]] then
          table.remove(state.fireballs, i)
        end
      end
      -- break asteroids
      if next(toBreakAsteroids) then
        for i = #state.asteroids, 1, -1 do
          if toBreakAsteroids[state.asteroids[i]] then
            table.remove(state.asteroids, i)
          end
        end
      end
    end
  end

  if state.sun then
    state.sun:update(dt)
  end

  if state.keys['+'] or state.keys['='] then
    state.zoom = math.min(ZOOM_MAX, state.zoom + ZOOM_STEP_PER_FRAME)
    state.zoomTarget = nil
  end
  if state.keys['-'] or state.keys['_'] then
    state.zoom = math.max(ZOOM_MIN, state.zoom - ZOOM_STEP_PER_FRAME)
    state.zoomTarget = nil
  end

  local zoom = state.zoom
  local visibleWidth = love.graphics.getWidth() / zoom
  local visibleHeight = love.graphics.getHeight() / zoom
  local camera = { x = state.player.pos.x - visibleWidth / 2, y = state.player.pos.y - visibleHeight / 2 }
  local maxCameraX = state.sceneWidth - visibleWidth
  local maxCameraY = state.sceneHeight - visibleHeight
  camera.x = maxCameraX > 0 and math.min(math.max(camera.x, 0), maxCameraX) or maxCameraX / 2
  camera.y = maxCameraY > 0 and math.min(math.max(camera.y, 0), maxCameraY) or maxCameraY / 2
  state.camera = camera
  state.visibleWidth = visibleWidth
  state.visibleHeight = visibleHeight
end

function love.draw()
  state.starfield:draw(state.camera, state.visibleWidth, state.visibleHeight)

  love.graphics.push()
  love.graphics.scale(state.zoom, state.zoom)
  love.graphics.translate(-state.camera.x, -state.camera.y)

  if state.sun then
    state.sun:draw()
  end

  if state.asteroids then
    for _, a in ipairs(state.asteroids) do
      a:draw()
    end
  end

  if state.fireballs then
    for _, f in ipairs(state.fireballs) do
      f:draw()
    end
  end

  for _, p in ipairs(state.planetoids) do
    p:draw()
  end

  if state.coins then
    for _, c in ipairs(state.coins) do
      c:draw()
    end
  end
  
  state.player:draw()
  PullBeam.draw()

  love.graphics.pop()

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.print(string.format("Level %d - Score: %d", state.level, state.score), 20, 20)
  love.graphics.print(string.format("FPS: %.1f", state.fps or 0), 20, 40)
  love.graphics.print(string.format("Zoom: %.1fx (+/-)", state.zoom), 20, 60)
  love.graphics.print("Right-click a planet to pull toward it, Space to jump", 20, 90)
end