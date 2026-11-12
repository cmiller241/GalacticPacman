-- lua/interiors/ShipInterior.lua
--
-- The inside of Bob's spaceship (see lua/levels/Spaceship.lua): a round
-- room with three flat floors stacked inside the hull. Unlike the maze
-- and the pinball table he isn't a ball in here: he walks and jumps on
-- his feet. The floors are one-way: he jumps up through the one above
-- him, and Down drops him through the one he's on.
--
--   top floor      the console: the interact button takes the controls,
--                  and then the arrow keys or the left stick fly the ship
--                  (the interact button again lets go)
--   middle floor   the Bible, hovering in a beam of light over its
--                  pedestal (lua/effects/BibleShrine.lua), and mail crates
--   bottom floor   the beam pad: the beam there takes him back outside
--
-- Everything here is in the ship's own frame: (0, 0) is its middle, x to
-- the right, y down. The ship never turns, so a point in here is just the
-- ship's position plus that offset; he moves with it as it flies.
--
-- While he's in here this replaces his gravity and planet collision (see
-- main.lua's updatePlayer, which calls :updateBall every frame), and the
-- camera frames the whole ship (see :cameraView and Camera.lua).

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local constants = require("lua.constants")
local InteractPrompt = require("lua.ui.InteractPrompt")
local BibleShrine = require("lua.effects.BibleShrine")
local Conversation = require("lua.ui.Conversation")

local ShipInterior = {}
ShipInterior.__index = ShipInterior
-- (The gamepad stick's up/down count too while he's in here: Down drops
-- through a floor, and both fly the ship. See GamePadInput.lua.)
ShipInterior.fourWayInput = true

----------------------------------------------------------------------
-- Tunables
----------------------------------------------------------------------

-- The hull: its outside (what he walks round, outside) and the room
-- inside it. World units.
ShipInterior.HULL_RADIUS = 445
local INNER_RADIUS = 400
local HULL_RADIUS = ShipInterior.HULL_RADIUS

-- Each floor's top, top floor first (y in the ship's frame). Far enough
-- apart for him to stand under the next one up, close enough for one
-- jump to clear it (JUMP_SPEED and GRAVITY give about 200 units).
local FLOORS = { -90, 80, 250 }
local TOP_FLOOR, BOTTOM_FLOOR = 1, #FLOORS
local FLOOR_THICKNESS = 16

local GRAVITY = 0.45
local JUMP_SPEED = 13.5
local MAX_FALL_SPEED = 16

-- The console (top floor), and where he stands to fly.
local CONSOLE_X = 230
local CONSOLE_REACH = 110        -- how close (in x) he has to be to use it
local PILOT_STAND_X = CONSOLE_X - 90
-- The Bible's pedestal (middle floor).
local SHRINE_X = 30
local BIBLE_REACH = 80           -- how close (in x) he has to be to look at it

-- What happens when he looks at the Bible (see lua/ui/Conversation.lua).
local BIBLE_SCRIPT = {
  { text = "Bob stands near the strange book, wondering if he should read it." },
  { choice = "Should he read it?", options = {
    { label = "Read it", beats = {
      { text = '"But God shows His love for us in that while we were still sinners, Christ died for us." (Romans 5:8)' },
    } },
    { label = "Don't read it" },
  } },
}
-- The beam pad (bottom floor): where the beam in puts him, and where the
-- beam out stands.
ShipInterior.PAD_X = -170

-- Flying: speed added per tick at full stick, the top speed, and how much
-- speed it keeps per tick with nothing held (a gentle coast to a stop).
local THRUST = 0.14
local MAX_SPEED = 13
local COAST = 0.985
local STICK_DEADZONE = 0.2

-- What the camera frames: the whole ship plus a margin; flying, this many
-- ship-widths, so there's space to see it moving through.
local CAMERA_MARGIN = 70
local FLYING_VIEW = 2.4

-- Where leaving puts him: on the hull, a little round from the top (the
-- outside beam is right on top).
ShipInterior.EXIT_ANGLE = -math.pi / 2 + 0.3

-- Colors.
local COLOR_ROOM = { 0.09, 0.08, 0.17, 1 }
local COLOR_PANEL_LINE = { 1, 1, 1, 0.035 }
local COLOR_FLOOR = { 0.42, 0.45, 0.56, 1 }
local COLOR_FLOOR_EDGE = { 0.78, 0.82, 0.92, 1 }
local COLOR_FLOOR_SHADOW = { 0, 0, 0, 0.35 }
local COLOR_OUTLINE = { 0.04, 0.04, 0.08, 1 }
local COLOR_WINDOW = { 0.05, 0.10, 0.22, 1 }
local COLOR_WINDOW_RIM = { 0.70, 0.74, 0.84, 1 }
local COLOR_CONSOLE = { 0.36, 0.39, 0.50, 1 }
local COLOR_CONSOLE_TOP = { 0.52, 0.56, 0.68, 1 }
local COLOR_SCREEN = { 0.25, 0.85, 0.45, 1 }
local COLOR_CRATE = { 0.79, 0.54, 0.29, 1 }
local COLOR_TAPE = { 0.93, 0.83, 0.55, 1 }
local COLOR_PAD = { 0.60, 0.64, 0.74, 1 }

-- Half the room's width at height y (in the ship's frame).
local function halfWidthAt(y)
  return math.sqrt(math.max(0, INNER_RADIUS * INNER_RADIUS - y * y))
end

----------------------------------------------------------------------
-- Building
----------------------------------------------------------------------

function ShipInterior.new(ship)
  local self = setmetatable({}, ShipInterior)
  self.ship = ship
  self.lx, self.ly = ShipInterior.PAD_X, FLOORS[BOTTOM_FLOOR]
  self.vx, self.vy = 0, 0
  self.floor = BOTTOM_FLOOR
  self.piloting = false
  -- The Bible's conversation, and whether it's showing (what
  -- WorldObjects.anyDialogueActive checks, to freeze him while it is).
  self.bible = Conversation.new(BIBLE_SCRIPT)
  self.dialogueActive = false
  -- Set by Spaceship.lua: the beam out (it's one of state.beams, shown
  -- only while he's in here).
  self.beam = nil
  return self
end

-- Whether he's in here right now.
function ShipInterior:hasPlayer()
  local player = state.player
  return player ~= nil and player.inInterior == self
end

-- A point in the ship's frame, in world space.
function ShipInterior:toWorld(lx, ly)
  return self.ship.pos.x + lx, self.ship.pos.y + ly
end

-- Where the beam out stands, in world space: on the bottom floor, at the pad.
function ShipInterior:padPosition()
  return Vector2.new(self:toWorld(ShipInterior.PAD_X, FLOORS[BOTTOM_FLOOR]))
end

-- Where the beam in (and a respawn into the ship) puts him.
function ShipInterior:getPortalPosition()
  return self:padPosition()
end

-- Where leaving puts him: on the hull at EXIT_ANGLE, in world space.
function ShipInterior:exitPosition()
  local a = ShipInterior.EXIT_ANGLE
  local s = self.ship
  return Vector2.new(s.pos.x + math.cos(a) * s.radius, s.pos.y + math.sin(a) * s.radius)
end

----------------------------------------------------------------------
-- Going in and out
----------------------------------------------------------------------

-- The beam in has put him here (or he's respawned here): standing on the
-- bottom floor, at the pad.
function ShipInterior:onEnter(player)
  if player.isBall then player:forceStandMode() end
  player.inInterior = self
  -- (On a floor, upright: no planet under him, so he's drawn the right
  -- way up.)
  player.onSurface = true
  player.currentPlanet, player.lastInfluencePlanet = nil, nil
  player.isGroundPounding = false
  player.vel.x, player.vel.y = 0, 0
  self.lx, self.ly = ShipInterior.PAD_X, FLOORS[BOTTOM_FLOOR] - player.radius
  self.vx, self.vy = 0, 0
  self.floor = BOTTOM_FLOOR
  self.dropThrough = nil
  self.downWasHeld = true -- (a Down held coming in doesn't drop him straight through)
  self.piloting = false
  self.bible:stop()
  self.dialogueActive = false
  self:placePlayer(player)
end

-- The beam out has put him outside: on the hull, a little round from the
-- top, falling onto it the ordinary way.
function ShipInterior:arriveOutside(player)
  player.inInterior = nil
  self.piloting = false
  self.ship.thrustX, self.ship.thrustY = 0, 0
  local a = ShipInterior.EXIT_ANGLE
  local s = self.ship
  local dist = s.radius + player.radius + 2
  player.pos.x, player.pos.y = s.pos.x + math.cos(a) * dist, s.pos.y + math.sin(a) * dist
  player.prevPos = player.pos:clone()
  player.onSurface = false
  player.currentPlanet = nil
  player.lastInfluencePlanet = s
  -- (Moving with the ship, so he isn't left behind if it's still coasting.)
  player.vel.x, player.vel.y = s.vel.x, s.vel.y
  player.isWalking = false
end

-- Puts him (in world space) where he is in the ship's frame.
function ShipInterior:placePlayer(player)
  player.pos.x, player.pos.y = self:toWorld(self.lx, self.ly)
  player.prevPos = player.pos:clone()
end

-- Whether he's standing close enough to the console to use it.
function ShipInterior:atConsole()
  return self.floor == TOP_FLOOR and math.abs(self.lx - CONSOLE_X) <= CONSOLE_REACH
end

-- Whether he's standing close enough to the Bible to look at it.
function ShipInterior:atBible()
  return self.floor == 2 and math.abs(self.lx - SHRINE_X) <= BIBLE_REACH
end

-- The interact button (see WorldObjects.interact): lets go of the
-- controls if he's flying, takes them if he's at the console, or uses
-- the beam out if he's at it.
function ShipInterior:tryInteract(player)
  if player.isTeleporting then return end
  -- (Talking: on through the Bible's conversation.)
  if self.bible:isActive() then
    self.bible:press()
    self.dialogueActive = self.bible:isActive()
    return
  end
  if self.piloting then
    self.piloting = false
    self.ship.thrustX, self.ship.thrustY = 0, 0
    return
  end
  if self:atConsole() then
    self.piloting = true
    self.lx = PILOT_STAND_X
    self.vx = 0
    player.facingDirection = 1
    player.isWalking = false
    return
  end
  if self:atBible() then
    self.bible:start()
    self.dialogueActive = true
    self.vx = 0
    player.isWalking = false
    player.facingDirection = self.lx < SHRINE_X and 1 or -1
    return
  end
  local beam = self.beam
  if beam and beam:isShown() and beam:isPlayerNear(player) then
    beam:tryInteract(player)
  end
end

-- The jump button: a jump, standing on a floor (not while flying).
function ShipInterior:triggerJumpAction(player)
  if self.piloting or self.dialogueActive or player.isTeleporting or not self.floor then return end
  self.vy = -JUMP_SPEED
  self.floor = nil
  if state.audioManager then state.audioManager:playJump() end
end

-- What the camera shows while he's in here (see Camera.lua): the ship,
-- whole, or (flying) a wider view round it. Returns the middle to look at
-- and the zoom.
function ShipInterior:cameraView(screenW, screenH)
  local size = self.piloting and (2 * HULL_RADIUS * FLYING_VIEW) or (2 * (HULL_RADIUS + CAMERA_MARGIN))
  return self.ship.pos.x, self.ship.pos.y, math.min(screenW, screenH) / size
end

----------------------------------------------------------------------
-- Walking, jumping, flying
----------------------------------------------------------------------

-- Called every frame he's in here, in place of gravity and collision.
function ShipInterior:updateBall(player, ts)
  -- (Being beamed in or out: held still where he is, moving with the ship.)
  if player.isTeleporting then
    self:placePlayer(player)
    return
  end
  if self.piloting then
    self:fly(ts)
    player.isWalking = false
    player.onSurface = true
    player.vel.x, player.vel.y = 0, 0
    self:placePlayer(player)
    return
  end
  self.ship.thrustX, self.ship.thrustY = 0, 0

  -- (Standing still while the Bible's talking. A Down held through it
  -- doesn't drop him through the floor afterward.)
  if self.dialogueActive then
    self.vx = 0
    self.downWasHeld = true
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

  -- Down (pressed, not held from before): drops through the floor he's
  -- on, unless it's the bottom one.
  local downHeld = keys["ArrowDown"] and true or false
  if downHeld and not self.downWasHeld and self.floor and self.floor ~= BOTTOM_FLOOR then
    self.dropThrough = self.floor
    self.floor = nil
    self.vy = 1
  end
  self.downWasHeld = downHeld

  if self.floor then
    self.ly = FLOORS[self.floor] - r
  else
    local prevFeet = self.ly + r
    self.vy = math.min(self.vy + GRAVITY * ts, MAX_FALL_SPEED)
    self.ly = self.ly + self.vy * ts
    local feet = self.ly + r
    -- Lands on the first floor his feet came down through (never the one
    -- he's dropping through).
    if self.vy > 0 then
      for i, fy in ipairs(FLOORS) do
        if i ~= self.dropThrough and prevFeet <= fy and feet >= fy then
          self.ly = fy - r
          self.floor = i
          self.vy = 0
          self.dropThrough = nil
          break
        end
      end
    end
    -- (Once he's clear below the floor he dropped through, it's solid again.)
    if self.dropThrough and prevFeet > FLOORS[self.dropThrough] then self.dropThrough = nil end
    -- His head against the top of the hull.
    local headTop = -INNER_RADIUS + 12
    if self.ly - player.headReach < headTop then
      self.ly = headTop + player.headReach
      self.vy = math.max(self.vy, 0)
    end
  end

  -- The hull's curved wall, at both his feet and his head.
  local half = math.min(halfWidthAt(self.ly + r), halfWidthAt(self.ly - player.headReach)) - r * 0.7
  self.lx = math.max(-half, math.min(half, self.lx + self.vx * ts))

  -- What his drawing goes by (see Rendering.lua): standing or in the air,
  -- walking or not.
  local walking = self.floor ~= nil and dir ~= 0
  player.onSurface = self.floor ~= nil
  player.isWalking = walking
  if walking then
    player.walkTime = player.walkTime + (math.abs(self.vx * ts) / player.strideLength) * math.pi * 2
  end
  player.vel.x, player.vel.y = self.vx, self.vy
  self:placePlayer(player)
end

-- Flying: the arrow keys, or the left stick (how far it's pushed sets how
-- hard), push the ship that way; with nothing held it coasts to a stop.
function ShipInterior:fly(ts)
  local ship = self.ship
  local ax, ay = state.gamepadMoveX or 0, state.gamepadMoveY or 0
  if ax * ax + ay * ay < STICK_DEADZONE * STICK_DEADZONE then
    local keys = state.keys
    ax = (keys["ArrowRight"] and 1 or 0) - (keys["ArrowLeft"] and 1 or 0)
    ay = (keys["ArrowDown"] and 1 or 0) - (keys["ArrowUp"] and 1 or 0)
  end
  local len = math.sqrt(ax * ax + ay * ay)
  if len > 1 then ax, ay = ax / len, ay / len end
  ship.thrustX, ship.thrustY = ax, ay

  if ax ~= 0 or ay ~= 0 then
    ship.vel.x = ship.vel.x + ax * THRUST * ts
    ship.vel.y = ship.vel.y + ay * THRUST * ts
    local speed = math.sqrt(ship.vel.x ^ 2 + ship.vel.y ^ 2)
    if speed > MAX_SPEED then
      ship.vel.x, ship.vel.y = ship.vel.x / speed * MAX_SPEED, ship.vel.y / speed * MAX_SPEED
    end
  else
    local keep = COAST ^ ts
    ship.vel.x, ship.vel.y = ship.vel.x * keep, ship.vel.y * keep
  end
end

-- An arrow while the Bible's asking something (see
-- WorldObjects.moveChoice): moves the cursor.
function ShipInterior:moveChoice(dir)
  if self.bible:isActive() then self.bible:move(dir) end
end

-- The Bible's textbox, with the HUD (see WorldObjects.drawDialogues).
function ShipInterior:drawDialogue()
  if self.bible:isActive() then self.bible:draw() end
end

----------------------------------------------------------------------
-- Drawing (over the hull, while he's in here)
----------------------------------------------------------------------

-- A round window in the hull's wall at (x, y), looking out at the stars.
local function drawWindow(x, y, radius, t)
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.circle("fill", x, y, radius + 9)
  love.graphics.setColor(COLOR_WINDOW_RIM)
  love.graphics.circle("fill", x, y, radius + 6)
  love.graphics.setColor(COLOR_WINDOW)
  love.graphics.circle("fill", x, y, radius)
  -- A few stars, twinkling.
  for k = 1, 7 do
    local a, d = k * 2.4, radius * (0.2 + 0.7 * ((k * 0.37) % 1))
    local twinkle = 0.5 + 0.5 * math.sin(t * 2 + k)
    love.graphics.setColor(1, 1, 1, 0.4 + 0.5 * twinkle)
    love.graphics.circle("fill", x + math.cos(a) * d, y + math.sin(a) * d, 1.5 + (k % 2))
  end
  love.graphics.setColor(1, 1, 1, 0.25)
  love.graphics.setLineWidth(4)
  love.graphics.arc("line", "open", x, y, radius * 0.72, math.pi * 1.1, math.pi * 1.45)
end

-- One floor, its top at y (the ship's frame), across the whole room.
local function drawFloor(cx, cy, y)
  local top, bottom = halfWidthAt(y), halfWidthAt(y + FLOOR_THICKNESS)
  love.graphics.setColor(COLOR_FLOOR_SHADOW)
  local shadowBottom = halfWidthAt(y + FLOOR_THICKNESS + 10)
  love.graphics.polygon("fill",
    cx - bottom, cy + y + FLOOR_THICKNESS, cx + bottom, cy + y + FLOOR_THICKNESS,
    cx + shadowBottom, cy + y + FLOOR_THICKNESS + 10, cx - shadowBottom, cy + y + FLOOR_THICKNESS + 10)
  love.graphics.setColor(COLOR_FLOOR)
  love.graphics.polygon("fill",
    cx - top, cy + y, cx + top, cy + y,
    cx + bottom, cy + y + FLOOR_THICKNESS, cx - bottom, cy + y + FLOOR_THICKNESS)
  love.graphics.setColor(COLOR_FLOOR_EDGE)
  love.graphics.setLineWidth(3)
  love.graphics.line(cx - top, cy + y + 1, cx + top, cy + y + 1)
  -- Rivets along its side.
  love.graphics.setColor(0.30, 0.32, 0.42, 1)
  local step = 60
  for x = -math.floor(bottom / step) * step + step / 2, bottom - step / 2, step do
    love.graphics.circle("fill", cx + x, cy + y + FLOOR_THICKNESS * 0.6, 2.5)
  end
end

-- A mail crate standing on the floor at (x, floorY), w wide, h tall.
local function drawCrate(x, floorY, w, h)
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.rectangle("fill", x - w / 2 - 3, floorY - h - 3, w + 6, h + 3, 4, 4)
  love.graphics.setColor(COLOR_CRATE)
  love.graphics.rectangle("fill", x - w / 2, floorY - h, w, h, 3, 3)
  love.graphics.setColor(COLOR_TAPE)
  love.graphics.rectangle("fill", x - 5, floorY - h, 10, h)
  love.graphics.setColor(0, 0, 0, 0.15)
  love.graphics.rectangle("fill", x - w / 2, floorY - 8, w, 8)
end

-- The console at the cockpit end of the top floor: a desk with a screen
-- (a heading arrow while he's flying, a slow blink while it isn't).
function ShipInterior:drawConsole(cx, cy, t)
  local x, floorY = cx + CONSOLE_X, cy + FLOORS[TOP_FLOOR]
  -- The desk, leaning back toward the wall.
  local desk = { x - 60, floorY, x + 70, floorY, x + 70, floorY - 70, x - 40, floorY - 92 }
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.setLineWidth(8)
  love.graphics.polygon("line", desk)
  love.graphics.setColor(COLOR_CONSOLE)
  love.graphics.polygon("fill", desk)
  love.graphics.setColor(COLOR_CONSOLE_TOP)
  love.graphics.polygon("fill", x - 40, floorY - 92, x + 70, floorY - 70, x + 70, floorY - 60, x - 44, floorY - 80)

  -- The screen.
  local sx, sy, sw, sh = x - 18, floorY - 150, 74, 50
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.rectangle("fill", sx - 5, sy - 5, sw + 10, sh + 10, 6, 6)
  love.graphics.setColor(0.04, 0.12, 0.07, 1)
  love.graphics.rectangle("fill", sx, sy, sw, sh, 4, 4)
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.setLineWidth(6)
  love.graphics.line(x + 18, sy + sh + 5, x + 10, floorY - 88)
  local mx, my = sx + sw / 2, sy + sh / 2
  love.graphics.setColor(COLOR_SCREEN)
  local ship = self.ship
  if self.piloting then
    -- The way it's being pushed (or a dot, coasting).
    local tx, ty = ship.thrustX or 0, ship.thrustY or 0
    if tx ~= 0 or ty ~= 0 then
      local a = math.atan2(ty, tx)
      local c, s = math.cos(a), math.sin(a)
      love.graphics.setLineWidth(4)
      love.graphics.line(mx - c * 14, my - s * 14, mx + c * 14, my + s * 14)
      love.graphics.polygon("fill",
        mx + c * 20, my + s * 20,
        mx + c * 8 - s * 8, my + s * 8 + c * 8,
        mx + c * 8 + s * 8, my + s * 8 - c * 8)
    else
      love.graphics.circle("fill", mx, my, 5)
    end
  else
    local blink = (math.sin(t * 3) + 1) / 2
    love.graphics.setColor(COLOR_SCREEN[1], COLOR_SCREEN[2], COLOR_SCREEN[3], 0.35 + 0.5 * blink)
    love.graphics.rectangle("fill", sx + 10, sy + 12, sw - 20, 6, 2, 2)
    love.graphics.rectangle("fill", sx + 10, sy + 26, (sw - 20) * 0.6, 6, 2, 2)
  end
  -- Little lights along the desk.
  for k = 0, 2 do
    local on = math.floor(t * 2 + k) % 3 == 0
    local c = ({ { 1, 0.35, 0.3 }, { 1, 0.85, 0.3 }, { 0.4, 0.8, 1 } })[k + 1]
    love.graphics.setColor(c[1], c[2], c[3], on and 1 or 0.35)
    love.graphics.circle("fill", x - 20 + k * 26, floorY - 72 + k * 5, 5)
  end
end

-- The beam pad on the bottom floor (the beam itself is drawn as one of
-- state.beams).
local function drawPad(cx, cy)
  local x, y = cx + ShipInterior.PAD_X, cy + FLOORS[BOTTOM_FLOOR]
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.ellipse("fill", x, y - 2, 62, 14)
  love.graphics.setColor(COLOR_PAD)
  love.graphics.ellipse("fill", x, y - 4, 56, 10)
  love.graphics.setColor(1, 0.85, 0.4, 0.6)
  love.graphics.ellipse("fill", x, y - 5, 30, 5)
end

function ShipInterior:draw()
  if not self:hasPlayer() then return end
  local cx, cy = self.ship.pos.x, self.ship.pos.y
  local t = love.timer.getTime()

  -- The room.
  love.graphics.setColor(COLOR_ROOM)
  love.graphics.circle("fill", cx, cy, INNER_RADIUS)
  -- Wall panels: faint lines across it.
  love.graphics.setColor(COLOR_PANEL_LINE)
  love.graphics.setLineWidth(2)
  for y = -INNER_RADIUS + 40, INNER_RADIUS - 40, 40 do
    local half = halfWidthAt(y)
    love.graphics.line(cx - half, cy + y, cx + half, cy + y)
  end

  -- Windows: one by the console, one on each side lower down.
  drawWindow(cx + 250, cy - 215, 42, t)
  drawWindow(cx - 290, cy - 10, 34, t)
  drawWindow(cx + 300, cy + 160, 30, t)

  for _, y in ipairs(FLOORS) do drawFloor(cx, cy, y) end

  -- Scenery: mail crates on the middle floor.
  local middleY = cy + FLOORS[2]
  drawCrate(cx - 250, middleY, 60, 46)
  drawCrate(cx - 186, middleY, 48, 34)
  drawCrate(cx - 222, middleY - 46, 44, 32)

  -- The Bible, its beam reaching up to the floor above.
  BibleShrine.draw(cx + SHRINE_X, middleY, cy + FLOORS[TOP_FLOOR] + FLOOR_THICKNESS, t)

  self:drawConsole(cx, cy, t)
  drawPad(cx, cy)

  -- The button prompts: at the console to take the controls, and over
  -- him while flying to let go.
  local player = state.player
  if player.isTeleporting then return end
  if self.piloting then
    InteractPrompt.draw(player.pos.x, player.pos.y - player.headReach - 30, "stop flying")
  elseif self:atConsole() then
    InteractPrompt.draw(cx + CONSOLE_X, cy + FLOORS[TOP_FLOOR] - 175, "fly")
  elseif self:atBible() and not self.dialogueActive then
    InteractPrompt.draw(cx + SHRINE_X, cy + FLOORS[2] - 140, "look")
  end
end

return ShipInterior
