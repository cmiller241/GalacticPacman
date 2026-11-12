-- lua/interiors/ControlRoom.lua
--
-- The inside of a game planet (the Tetris planet, the Zuma planet — see
-- lua/levels/): a small room in the planet's middle, with the beam pad
-- on the left and a control panel on the right. He walks and hops about
-- on his feet, as in the spaceship.
--
-- The interact button at the panel takes the controls and starts the
-- planet's game; from then on Left and Right steer it and the jump
-- button is the game's own action. The interact button again lets go,
-- which ends the game; taking the controls again starts a new one.
--
-- The game itself is handed in (see lua/world/TetrisField.lua and
-- lua/world/ZumaField.lua). It provides:
--   game:start()                       he's taken the controls
--   game:update(dt, ts, playing, steer) every frame (steer: -1, 0 or 1)
--   game:onJump()                      the jump button, at the controls
--   game:stop()                        he's let go (or left) mid-game
--   game.finished                      set when the game's over on its own
--                                      (he's let go of the controls for it)
--   game:cameraReach()                 how far out to frame, at the controls
--   game.angle                         how far the planet's turned (the
--                                      panel's screen shows it)
--   game:draw()                        world space, under the room
--   game:drawHud(playing)              screen space, with the HUD
--
-- The room stays upright while the planet turns round it. Everything
-- here is in the planet's frame, unturned: (0, 0) is its middle, x to
-- the right, y down.
--
-- While he's in here this replaces his gravity and planet collision (see
-- main.lua's updatePlayer, which calls :updateBall every frame), and the
-- camera frames the room, or the whole game while he's at the controls
-- (see :cameraView and Camera.lua).

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local constants = require("lua.constants")
local InteractPrompt = require("lua.ui.InteractPrompt")

local ControlRoom = {}
ControlRoom.__index = ControlRoom

----------------------------------------------------------------------
-- Tunables
----------------------------------------------------------------------

-- The room: its sides, ceiling and floor.
local ROOM_HALF_WIDTH = 140
local ROOM_TOP = -105
local FLOOR_Y = 100

local GRAVITY = 0.45
local JUMP_SPEED = 9
local MAX_FALL_SPEED = 16

-- The panel, and how close (in x) he has to be to use it.
local PANEL_X = 82
local PANEL_REACH = 60
-- The beam pad: where the beam in puts him, and where the beam out stands.
ControlRoom.PAD_X = -82
local PAD_X = ControlRoom.PAD_X
-- Where leaving puts him: on the planet's surface, a little round from
-- the top (clear of the beam in).
ControlRoom.EXIT_ANGLE = -math.pi / 2 + 0.3

-- The camera: how much room it leaves round the planet inside, and
-- round the game at the controls.
local CAMERA_MARGIN = 120
local FIELD_MARGIN = 80

local COLOR_ROOM = { 0.10, 0.07, 0.16, 1 }
local COLOR_RIM = { 0.70, 0.62, 0.86, 1 }
local COLOR_OUTLINE = { 0.04, 0.04, 0.08, 1 }
local COLOR_FLOOR = { 0.42, 0.40, 0.56, 1 }
local COLOR_FLOOR_EDGE = { 0.80, 0.78, 0.92, 1 }
local COLOR_PANEL = { 0.36, 0.34, 0.50, 1 }
local COLOR_PANEL_TOP = { 0.54, 0.52, 0.70, 1 }
local COLOR_PAD = { 0.60, 0.58, 0.74, 1 }

----------------------------------------------------------------------
-- Building
----------------------------------------------------------------------

-- planet: the round Planetoid it's inside. game: its game (see above).
-- accent: an {r, g, b} for the panel's screen and the pad's glow (the
-- planet's beam color, say).
function ControlRoom.new(planet, game, accent)
  local self = setmetatable({}, ControlRoom)
  self.planet = planet
  self.game = game
  self.accent = accent or { 0.95, 0.55, 0.85 }
  self.lx, self.ly = PAD_X, FLOOR_Y
  self.vx, self.vy = 0, 0
  self.onFloor = true
  self.controlling = false
  -- Set by the planet's builder: the beam out (one of state.beams, shown
  -- only while he's in here).
  self.beam = nil
  return self
end

function ControlRoom:hasPlayer()
  local player = state.player
  return player ~= nil and player.inInterior == self
end

function ControlRoom:toWorld(lx, ly)
  return self.planet.pos.x + lx, self.planet.pos.y + ly
end

-- Where the beam out stands, in world space: on the floor, at the pad.
function ControlRoom:padPosition()
  return Vector2.new(self:toWorld(PAD_X, FLOOR_Y))
end

function ControlRoom:getPortalPosition()
  return self:padPosition()
end

-- Where leaving puts him: on the surface at EXIT_ANGLE, in world space.
function ControlRoom:exitPosition()
  local a, p = ControlRoom.EXIT_ANGLE, self.planet
  return Vector2.new(p.pos.x + math.cos(a) * p.radius, p.pos.y + math.sin(a) * p.radius)
end

----------------------------------------------------------------------
-- Going in and out
----------------------------------------------------------------------

-- The beam in has put him here (or he's respawned here): on the floor,
-- at the pad.
function ControlRoom:onEnter(player)
  if player.isBall then player:forceStandMode() end
  player.inInterior = self
  player.onSurface = true
  player.currentPlanet, player.lastInfluencePlanet = nil, nil
  player.isGroundPounding = false
  player.vel.x, player.vel.y = 0, 0
  self.lx, self.ly = PAD_X, FLOOR_Y - player.radius
  self.vx, self.vy = 0, 0
  self.onFloor = true
  self.controlling = false
  self:placePlayer(player)
end

-- The beam out has put him outside: just above the surface, a little
-- round from the top, falling onto it the ordinary way.
function ControlRoom:arriveOutside(player)
  player.inInterior = nil
  self.controlling = false
  local a, p = ControlRoom.EXIT_ANGLE, self.planet
  local dist = p.radius + player.radius + 2
  player.pos.x, player.pos.y = p.pos.x + math.cos(a) * dist, p.pos.y + math.sin(a) * dist
  player.prevPos = player.pos:clone()
  player.onSurface = false
  player.currentPlanet = nil
  player.lastInfluencePlanet = p
  player.vel.x, player.vel.y = 0, 0
  player.isWalking = false
end

function ControlRoom:placePlayer(player)
  player.pos.x, player.pos.y = self:toWorld(self.lx, self.ly)
  player.prevPos = player.pos:clone()
end

function ControlRoom:atPanel()
  return self.onFloor and math.abs(self.lx - PANEL_X) <= PANEL_REACH
end

-- The interact button (see WorldObjects.interact): lets go of the
-- controls (ending the game), takes them at the panel (starting one), or
-- uses the beam out at the pad.
function ControlRoom:tryInteract(player)
  if player.isTeleporting then return end
  if self.controlling then
    self.controlling = false
    self.game:stop()
    return
  end
  if self:atPanel() then
    self.controlling = true
    self.vx = 0
    player.facingDirection = 1
    player.isWalking = false
    self.game:start()
    return
  end
  local beam = self.beam
  if beam and beam:isShown() and beam:isPlayerNear(player) then
    beam:tryInteract(player)
  end
end

-- The jump button: at the controls, the game's own action; otherwise a
-- hop, standing on the floor.
function ControlRoom:triggerJumpAction(player)
  if self.controlling then
    self.game:onJump()
    return
  end
  if player.isTeleporting or not self.onFloor then return end
  self.vy = -JUMP_SPEED
  self.onFloor = false
  if state.audioManager then state.audioManager:playJumpSmall() end
end

-- What the camera shows: the planet, or (at the controls) the planet and
-- the whole game round it.
function ControlRoom:cameraView(screenW, screenH)
  local reach = self.controlling
    and (self.game:cameraReach() + FIELD_MARGIN)
    or (self.planet.radius + CAMERA_MARGIN)
  return self.planet.pos.x, self.planet.pos.y, math.min(screenW, screenH) / (2 * reach)
end

----------------------------------------------------------------------
-- Every frame
----------------------------------------------------------------------

-- (Called by the planet's own update, whether he's in here or not: the
-- game keeps running its animations, and plays while he's at the
-- controls.)
function ControlRoom:updateGame()
  -- (Gone without letting go — teleported away, say: that ends the game too.)
  if self.controlling and not self:hasPlayer() then
    self.controlling = false
    self.game:stop()
  end
  local ts = state.timeScale or 1
  local steer = 0
  if self.controlling then
    local keys = state.keys
    steer = (keys["ArrowRight"] and 1 or 0) - (keys["ArrowLeft"] and 1 or 0)
  end
  self.game:update(ts / 60, ts, self.controlling, steer)
  -- (Over on its own — the Zuma train reaching the planet, say: he lets go.)
  if self.game.finished then
    self.game.finished = false
    self.controlling = false
  end
end

-- Called every frame he's in here, in place of gravity and collision.
function ControlRoom:updateBall(player, ts)
  if player.isTeleporting or self.controlling then
    self.vx = 0
    player.isWalking = false
    player.vel.x, player.vel.y = 0, 0
    self:placePlayer(player)
    return
  end

  local keys = state.keys
  local r = player.radius
  local dir = (keys["ArrowRight"] and 1 or 0) - (keys["ArrowLeft"] and 1 or 0)
  local speed = constants.PLAYER_LINEAR_SPEED * (state.gamepadRunHeld and player.runSpeedMultiplier or 1)
  self.vx = dir * speed
  if dir ~= 0 then player.facingDirection = dir end

  if not self.onFloor then
    self.vy = math.min(self.vy + GRAVITY * ts, MAX_FALL_SPEED)
    self.ly = self.ly + self.vy * ts
    if self.ly + r >= FLOOR_Y then
      self.ly = FLOOR_Y - r
      self.vy = 0
      self.onFloor = true
    end
    -- His head against the ceiling.
    local headTop = ROOM_TOP + 6
    if self.ly - player.headReach < headTop then
      self.ly = headTop + player.headReach
      self.vy = math.max(self.vy, 0)
    end
  else
    self.ly = FLOOR_Y - r
  end

  local half = ROOM_HALF_WIDTH - r * 0.7
  self.lx = math.max(-half, math.min(half, self.lx + self.vx * ts))

  local walking = self.onFloor and dir ~= 0
  player.onSurface = self.onFloor
  player.isWalking = walking
  if walking then
    player.walkTime = player.walkTime + (math.abs(self.vx * ts) / player.strideLength) * math.pi * 2
  end
  player.vel.x, player.vel.y = self.vx, self.vy
  self:placePlayer(player)
end

----------------------------------------------------------------------
-- Drawing
----------------------------------------------------------------------

-- On the screen, with the HUD (see main.lua's love.draw): whatever the
-- game shows there.
function ControlRoom:drawHud()
  if self:hasPlayer() then self.game:drawHud(self.controlling) end
end

-- The panel: a small desk with a screen showing which way the planet's
-- turned (a blinking ring while nobody's at it).
function ControlRoom:drawPanel(cx, cy, t)
  local x, floorY = cx + PANEL_X, cy + FLOOR_Y
  local desk = { x - 34, floorY, x + 40, floorY, x + 40, floorY - 50, x - 22, floorY - 64 }
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.setLineWidth(7)
  love.graphics.polygon("line", desk)
  love.graphics.setColor(COLOR_PANEL)
  love.graphics.polygon("fill", desk)
  love.graphics.setColor(COLOR_PANEL_TOP)
  love.graphics.polygon("fill", x - 22, floorY - 64, x + 40, floorY - 50, x + 40, floorY - 43, x - 25, floorY - 55)

  -- The screen, on a stalk.
  local sx, sy, sw, sh = x - 10, floorY - 112, 48, 36
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.setLineWidth(5)
  love.graphics.line(x + 14, sy + sh + 4, x + 8, floorY - 60)
  love.graphics.rectangle("fill", sx - 4, sy - 4, sw + 8, sh + 8, 5, 5)
  love.graphics.setColor(0.10, 0.04, 0.10, 1)
  love.graphics.rectangle("fill", sx, sy, sw, sh, 3, 3)
  local mx, my = sx + sw / 2, sy + sh / 2
  local accent = self.accent
  love.graphics.setColor(accent[1], accent[2], accent[3], 1)
  love.graphics.setLineWidth(3)
  if self.controlling then
    -- A ring turning with the planet, and a mark on it.
    local a = self.game.angle
    love.graphics.circle("line", mx, my, 11)
    love.graphics.circle("fill", mx + math.cos(a - math.pi / 2) * 11, my + math.sin(a - math.pi / 2) * 11, 4)
  else
    local blink = (math.sin(t * 3) + 1) / 2
    love.graphics.setColor(accent[1], accent[2], accent[3], 0.3 + 0.6 * blink)
    love.graphics.circle("line", mx, my, 11)
  end
  -- Two lights on the desk: Left and Right.
  local keys = state.keys
  for k = 0, 1 do
    local on = self.controlling and keys[k == 0 and "ArrowLeft" or "ArrowRight"]
    love.graphics.setColor(1, 0.75, 0.3, on and 1 or 0.35)
    love.graphics.circle("fill", x - 6 + k * 24, floorY - 48 + k * 4, 5)
  end
end

function ControlRoom:drawPad(cx, cy)
  local x, y = cx + PAD_X, cy + FLOOR_Y
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.ellipse("fill", x, y - 2, 46, 11)
  love.graphics.setColor(COLOR_PAD)
  love.graphics.ellipse("fill", x, y - 4, 41, 8)
  local accent = self.accent
  love.graphics.setColor(accent[1], accent[2], accent[3], 0.6)
  love.graphics.ellipse("fill", x, y - 5, 22, 4)
end

-- The game (always: what's on the planet shows from outside too), then
-- the room over the planet's middle while he's in.
function ControlRoom:draw()
  self.game:draw()
  if not self:hasPlayer() then return end

  local cx, cy = self.planet.pos.x, self.planet.pos.y
  local t = love.timer.getTime()
  local x0, y0 = cx - ROOM_HALF_WIDTH, cy + ROOM_TOP
  local w, h = ROOM_HALF_WIDTH * 2, FLOOR_Y - ROOM_TOP + 14

  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.rectangle("fill", x0 - 10, y0 - 10, w + 20, h + 20, 22, 22)
  love.graphics.setColor(COLOR_RIM)
  love.graphics.rectangle("fill", x0 - 6, y0 - 6, w + 12, h + 12, 19, 19)
  love.graphics.setColor(COLOR_ROOM)
  love.graphics.rectangle("fill", x0, y0, w, h, 14, 14)
  -- Faint wall panels.
  love.graphics.setColor(1, 1, 1, 0.04)
  love.graphics.setLineWidth(2)
  for y = ROOM_TOP + 35, FLOOR_Y - 20, 35 do
    love.graphics.line(x0 + 8, cy + y, x0 + w - 8, cy + y)
  end
  -- The floor.
  love.graphics.setColor(COLOR_FLOOR)
  love.graphics.rectangle("fill", x0, cy + FLOOR_Y, w, 14, 0, 0)
  love.graphics.setColor(COLOR_FLOOR_EDGE)
  love.graphics.setLineWidth(3)
  love.graphics.line(x0, cy + FLOOR_Y + 1, x0 + w, cy + FLOOR_Y + 1)

  self:drawPanel(cx, cy, t)
  self:drawPad(cx, cy)

  local player = state.player
  if player.isTeleporting then return end
  if self.controlling then
    InteractPrompt.draw(cx + PANEL_X, cy + ROOM_TOP - 4, "stop")
  elseif self:atPanel() then
    InteractPrompt.draw(cx + PANEL_X, cy + ROOM_TOP - 4, "play")
  end
end

return ControlRoom
