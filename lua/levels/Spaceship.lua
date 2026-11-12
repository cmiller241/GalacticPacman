-- lua/levels/Spaceship.lua
--
-- Bob's spaceship: a round metal mail ship, styled like a postmark (a
-- blue steel hull with the route printed in a ring round a big window,
-- and a mailbox flag on top). Outside, it's a round planet like any
-- other: he can land on it and walk all the way round. The beam on its
-- top takes him inside (see lua/interiors/ShipInterior.lua, drawn
-- automatically for any planetoid with an .interior), where he walks
-- about on his feet, and the console flies it. A second beam inside, on
-- the bottom floor, takes him back out.
--
-- The hull is drawn by a metal shader (lua/effects/ShipHull.lua), and the
-- engine burns with the same fire as Bob's fireballs: the shader flame
-- (lua/effects/Flame.lua), a heat glow, fire puffs cooling into smoke,
-- and sparks (see lua/entities/Fireball.lua).
--
-- It drifts like any loose planetoid (so rocks that hit it shove it a
-- little), but on its own it coasts to a stop: only flying moves it far.
-- Both beams ride along with it.
--
-- Parked to the left of the fisherman's planet.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local Planetoid = require("lua.world.Planetoid")
local Beam = require("lua.world.Beam")
local ShipInterior = require("lua.interiors.ShipInterior")
local ShipHull = require("lua.effects.ShipHull")
local Flame = require("lua.effects.Flame")
local Fireball = require("lua.entities.Fireball")

local Spaceship = {}

-- From the fisherman's planet's left edge.
local OFFSET_X, OFFSET_Y = -1500, -300
-- Heavier than a rock its size, so rocks bump off it rather than it off them.
local MASS_MULTIPLIER = 4
-- With nobody flying it: how much of its speed it keeps per tick.
local PARKED_COAST = 0.96
local BEAM_COLOR = { 1.00, 0.78, 0.30 } -- mail-truck yellow

-- The engine. Its nozzle sticks out of the hull on the side away from
-- the way it's being pushed (NOZZLE_LENGTH past the hull's edge), and
-- its fire comes out of the nozzle's mouth.
local NOZZLE_LENGTH = 34
-- How fast the engine's fire grows and dies down (fraction of the way to
-- full or out, per tick).
local ENGINE_SPOOL = 0.12
-- The flame (see Flame.draw): its ball's radius and tail length (in ball
-- radii) at no thrust and the extra at full thrust.
local FLAME_RADIUS, FLAME_RADIUS_FULL = 20, 20
local FLAME_STRETCH, FLAME_STRETCH_FULL = 2.2, 2.4
local FLAME_SEED = 7.3
-- The exhaust: fire puffs (fire at first, cooling into smoke) and sparks
-- thrown out of the nozzle, as with a fireball's trail (see Fireball.lua).
local PUFFS_PER_TICK = 3
local PUFF_LIFE_MIN, PUFF_LIFE_RANGE = 16, 14
local PUFF_SPEED = 8              -- out of the nozzle, at full thrust
local PUFF_DRAG = 0.95            -- speed kept per tick
local PUFF_FIRE_FRACTION = 0.4    -- the first part of a puff's life it's fire; smoke after
local PUFF_GROWTH = 1.8           -- how much bigger a puff gets over its life
local SPARK_CHANCE = 0.7          -- per tick, at full thrust
local SPARK_LIFE_MIN, SPARK_LIFE_RANGE = 10, 10

local COLOR_OUTLINE = { 0.04, 0.04, 0.08, 1 }
local COLOR_HULL = { 0.42, 0.55, 0.85 } -- the steel's blue tint
local COLOR_PAPER = { 0.96, 0.94, 0.88, 0.92 }
local COLOR_GLASS = { 0.55, 0.84, 0.98, 1 }
local COLOR_GLASS_DEEP = { 0.30, 0.55, 0.80, 1 }
local COLOR_FRAME = { 0.62, 0.66, 0.74, 1 }
local COLOR_FRAME_LIGHT = { 0.92, 0.94, 0.98, 1 }
local COLOR_FLAG = { 0.89, 0.23, 0.23, 1 }
local COLOR_POLE = { 0.70, 0.74, 0.84, 1 }
local COLOR_NOZZLE = { 0.48, 0.52, 0.60, 1 }
local COLOR_NOZZLE_LIGHT = { 0.82, 0.86, 0.92, 1 }
local RING_TEXT = "BOB'S DELIVERY  *  ROUTE 7  *  ASTEROID BELT  *  "
local RING_TEXT_HEIGHT = 34 -- world units

function Spaceship.build()
  local x, y
  local rect = state.roundedRectPlanet
  if rect then
    x, y = rect.pos.x - rect.halfWidth + OFFSET_X, rect.pos.y + OFFSET_Y
  else
    x, y = state.sceneWidth / 2 + 4000, state.sceneHeight / 2
  end
  local ship = Planetoid.new(x, y, ShipInterior.HULL_RADIUS, COLOR_HULL)
  ship.isSpaceship = true
  ship.isPermanent = true
  ship.vel.x, ship.vel.y = 0, 0
  ship.mass = ship.mass * MASS_MULTIPLIER
  -- Which way it's being pushed while flying (see ShipInterior:fly).
  ship.thrustX, ship.thrustY = 0, 0
  -- The engine: how hard it's burning (0 to 1, easing after the thrust),
  -- which way its fire points (away from the ship), its fire's clock (in
  -- game seconds), and its exhaust.
  ship.enginePower = 0
  ship.exhaustX, ship.exhaustY = 0, 1
  ship.flameTime = 0
  ship.puffs, ship.sparks = {}, {}
  ship.interior = ShipInterior.new(ship)
  ship.draw = Spaceship.draw
  ship.update = Spaceship.update
  table.insert(state.planetoids, ship)
  state.spaceship = ship
  return ship
end

-- The two beams: one on top of the hull, in (shown while he's outside),
-- and one on the bottom floor inside, out (shown while he's in). Both are
-- kept where they belong as the ship moves (see placeBeams).
function Spaceship.addBeams(ship)
  local interior = ship.interior
  local inBeam = Beam.new(0, 0, -math.pi / 2, BEAM_COLOR)
  inBeam.destination = {
    pos = Vector2.new(0, 0),
    angle = -math.pi / 2,
    onArrive = function(player) interior:onEnter(player) end,
  }
  inBeam.showWhen = function() return not interior:hasPlayer() end

  local outBeam = Beam.new(0, 0, -math.pi / 2, BEAM_COLOR)
  outBeam.destination = {
    pos = Vector2.new(0, 0),
    angle = ShipInterior.EXIT_ANGLE,
    onArrive = function(player) interior:arriveOutside(player) end,
  }
  outBeam.showWhen = function() return interior:hasPlayer() end
  outBeam.fade = 0 -- (hidden from the start, not fading out)
  -- The inside is a small room: he has to be at the pad, not just on its floor.
  outBeam.interactRadius = 90

  ship.inBeam, ship.outBeam = inBeam, outBeam
  interior.beam = outBeam
  Spaceship.placeBeams(ship)
  table.insert(state.beams, inBeam)
  table.insert(state.beams, outBeam)
end

-- Puts both beams (and where each sends him) where they belong on the
-- ship as it is now. Their drifting motes move with them.
function Spaceship.placeBeams(ship)
  local inBeam, outBeam = ship.inBeam, ship.outBeam
  if not inBeam then return end
  local top = Vector2.new(ship.pos.x, ship.pos.y - ship.radius)
  local pad = ship.interior:padPosition()
  for _, pair in ipairs({ { inBeam, top }, { outBeam, pad } }) do
    local beam, at = pair[1], pair[2]
    local dx, dy = at.x - beam.pos.x, at.y - beam.pos.y
    beam.pos.x, beam.pos.y = at.x, at.y
    for _, p in ipairs(beam.beamParticles) do
      p.pos.x, p.pos.y = p.pos.x + dx, p.pos.y + dy
    end
  end
  local inDest, outDest = inBeam.destination.pos, outBeam.destination.pos
  inDest.x, inDest.y = pad.x, pad.y
  local exit = ship.interior:exitPosition()
  outDest.x, outDest.y = exit.x, exit.y
end

-- Where the engine's fire comes out: the nozzle's mouth, in world space.
local function nozzleMouth(ship)
  local d = ship.radius + NOZZLE_LENGTH - 8
  return ship.pos.x + ship.exhaustX * d, ship.pos.y + ship.exhaustY * d
end

-- The engine, every tick: it burns as hard as the ship's being pushed
-- (easing up and down), and throws out fire puffs and sparks while it
-- does. The puffs and sparks already out keep going, slowing, till they
-- die out — left behind in space as the ship flies on.
local function updateEngine(ship, ts)
  local tx, ty = ship.thrustX or 0, ship.thrustY or 0
  local push = math.sqrt(tx * tx + ty * ty)
  if push > 0.05 then ship.exhaustX, ship.exhaustY = -tx / push, -ty / push end
  ship.enginePower = ship.enginePower + (push - ship.enginePower) * math.min(1, ENGINE_SPOOL * ts)
  if ship.enginePower < 0.01 then ship.enginePower = 0 end
  ship.flameTime = ship.flameTime + ts / 60

  local power = ship.enginePower
  if power > 0.05 then
    local mx, my = nozzleMouth(ship)
    local dx, dy = ship.exhaustX, ship.exhaustY
    local sx, sy = -dy, dx
    for _ = 1, PUFFS_PER_TICK do
      if math.random() < power * ts then
        local spread = (math.random() - 0.5) * 50 * power
        local speed = PUFF_SPEED * power * (0.6 + 0.6 * math.random())
        local side = (math.random() - 0.5) * 1.2
        local maxLife = PUFF_LIFE_MIN + math.random() * PUFF_LIFE_RANGE
        table.insert(ship.puffs, {
          x = mx + sx * spread, y = my + sy * spread,
          vx = ship.vel.x + dx * speed + sx * side, vy = ship.vel.y + dy * speed + sy * side,
          life = maxLife, maxLife = maxLife,
          size = (10 + 10 * math.random()) * (0.6 + 0.4 * power),
        })
      end
    end
    if math.random() < SPARK_CHANCE * power * ts then
      local a = math.atan2(dy, dx) + (math.random() - 0.5) * 1.0
      local speed = (8 + 8 * math.random()) * power
      local maxLife = SPARK_LIFE_MIN + math.random() * SPARK_LIFE_RANGE
      table.insert(ship.sparks, {
        x = mx, y = my,
        vx = ship.vel.x + math.cos(a) * speed, vy = ship.vel.y + math.sin(a) * speed,
        life = maxLife, maxLife = maxLife,
      })
    end
  end

  local keep = PUFF_DRAG ^ ts
  for i = #ship.puffs, 1, -1 do
    local p = ship.puffs[i]
    p.x, p.y = p.x + p.vx * ts, p.y + p.vy * ts
    p.vx, p.vy = p.vx * keep, p.vy * keep
    p.life = p.life - ts
    if p.life <= 0 then table.remove(ship.puffs, i) end
  end
  for i = #ship.sparks, 1, -1 do
    local s = ship.sparks[i]
    s.x, s.y = s.x + s.vx * ts, s.y + s.vy * ts
    s.life = s.life - ts
    if s.life <= 0 then table.remove(ship.sparks, i) end
  end
end

-- Every frame, before the player moves (see main.lua's updateWorld): with
-- nobody flying it, it coasts to a stop; the engine burns (or dies down);
-- and the beams keep up with it.
function Spaceship.update(ship)
  local ts = state.timeScale or 1
  local interior = ship.interior
  -- (He can leave without letting go of the controls — teleported away,
  -- say. Then nobody's flying it.)
  if interior.piloting and not interior:hasPlayer() then
    interior.piloting = false
  end
  if not interior.piloting then
    ship.thrustX, ship.thrustY = 0, 0
    local keep = PARKED_COAST ^ ts
    ship.vel.x, ship.vel.y = ship.vel.x * keep, ship.vel.y * keep
  end
  updateEngine(ship, ts)
  Spaceship.placeBeams(ship)
end

----------------------------------------------------------------------
-- Drawing the outside
----------------------------------------------------------------------

-- The exhaust and the engine's fire, the way a fireball's drawn (see
-- Fireball:draw): smoke, fire puffs, sparks, a heat glow, and the shader
-- flame at the nozzle's mouth with its tail streaming out behind.
local function drawExhaust(ship)
  local drawGlow, fireColor = Fireball.drawGlow, Fireball.fireColor
  love.graphics.push("all")

  for _, p in ipairs(ship.puffs) do
    local life = p.life / p.maxLife
    if life < PUFF_FIRE_FRACTION + 0.1 then
      local k = math.min(1, life / PUFF_FIRE_FRACTION)
      local size = p.size * (1 + PUFF_GROWTH * (1 - life))
      love.graphics.setColor(0.32, 0.3, 0.3, 0.3 * k)
      drawGlow(p.x, p.y, size * 2.6)
    end
  end

  love.graphics.setBlendMode("add")
  for _, p in ipairs(ship.puffs) do
    local life = p.life / p.maxLife
    if life > PUFF_FIRE_FRACTION then
      local heat = (life - PUFF_FIRE_FRACTION) / (1 - PUFF_FIRE_FRACTION)
      local size = p.size * (1 + PUFF_GROWTH * (1 - life))
      local r, g, b = fireColor(heat)
      love.graphics.setColor(r, g, b, 0.6 * heat)
      drawGlow(p.x, p.y, size * 2.8)
    end
  end

  love.graphics.setLineWidth(2.5)
  for _, s in ipairs(ship.sparks) do
    local a = s.life / s.maxLife
    local r, g, b = fireColor(0.4 + 0.6 * a)
    love.graphics.setColor(r, g, b, a)
    love.graphics.line(s.x, s.y, s.x - (s.vx - ship.vel.x) * 2.5, s.y - (s.vy - ship.vel.y) * 2.5)
  end

  local power = ship.enginePower
  if power > 0.03 then
    local mx, my = nozzleMouth(ship)
    local flicker = math.sin(ship.flameTime * 20)
    local radius = (FLAME_RADIUS + FLAME_RADIUS_FULL * power) * (1 + flicker * 0.05)
    love.graphics.setColor(1, 0.45, 0.1, (0.45 + 0.1 * flicker) * math.min(1, power * 2))
    drawGlow(mx, my, radius * 7)
    love.graphics.pop()
    -- (Heading into the ship, so its tail streams out away from it.)
    Flame.draw(mx, my, radius, math.atan2(-ship.exhaustY, -ship.exhaustX),
      FLAME_STRETCH + FLAME_STRETCH_FULL * power, ship.flameTime, FLAME_SEED)
  else
    love.graphics.pop()
  end
end

-- The nozzle, out of the hull where the fire comes from: a steel bell
-- widening toward its mouth.
local function drawNozzle(ship)
  if ship.enginePower <= 0.03 then return end
  local dx, dy = ship.exhaustX, ship.exhaustY
  local sx, sy = -dy, dx
  local R = ship.radius
  local bx, by = ship.pos.x + dx * (R - 12), ship.pos.y + dy * (R - 12)
  local L = NOZZLE_LENGTH + 12
  local function bell(inset, color)
    love.graphics.setColor(color)
    love.graphics.polygon("fill",
      bx + sx * (44 - inset), by + sy * (44 - inset),
      bx + dx * (L - inset * 0.5) + sx * (64 - inset), by + dy * (L - inset * 0.5) + sy * (64 - inset),
      bx + dx * (L - inset * 0.5) - sx * (64 - inset), by + dy * (L - inset * 0.5) - sy * (64 - inset),
      bx - sx * (44 - inset), by - sy * (44 - inset))
  end
  bell(-6, COLOR_OUTLINE)
  bell(0, COLOR_NOZZLE)
  -- A bright streak down one side of the bell: polished metal.
  love.graphics.setColor(COLOR_NOZZLE_LIGHT)
  love.graphics.polygon("fill",
    bx + sx * 30, by + sy * 30, bx + dx * L + sx * 48, by + dy * L + sy * 48,
    bx + dx * L + sx * 36, by + dy * L + sy * 36, bx + sx * 20, by + sy * 20)
  -- Its glowing mouth.
  love.graphics.setColor(1, 0.6, 0.2, math.min(1, ship.enginePower * 2))
  love.graphics.setLineWidth(6)
  love.graphics.line(bx + dx * L + sx * 58, by + dy * L + sy * 58, bx + dx * L - sx * 58, by + dy * L - sy * 58)
end

-- `text` set round a circle of `radius` about (x, y), each letter upright
-- to the circle, starting at the top and going clockwise.
local function drawRingText(text, x, y, radius, height)
  local font = love.graphics.getFont()
  local scale = height / font:getHeight()
  local count = #text
  for i = 1, count do
    local ch = text:sub(i, i)
    if ch ~= " " then
      local a = -math.pi / 2 + (i - 1) / count * 2 * math.pi
      love.graphics.push()
      love.graphics.translate(x + math.cos(a) * radius, y + math.sin(a) * radius)
      love.graphics.rotate(a + math.pi / 2)
      love.graphics.scale(scale, scale)
      love.graphics.print(ch, -font:getWidth(ch) / 2, -font:getHeight() / 2)
      love.graphics.pop()
    end
  end
end

-- The mailbox flag, up on its pole, a little left of the top.
local function drawFlag(x, y, R, t)
  local fa = -math.pi / 2 - 0.42
  local c, s = math.cos(fa), math.sin(fa)
  local poleBaseX, poleBaseY = x + c * (R - 10), y + s * (R - 10)
  local poleTopX, poleTopY = x + c * (R + 95), y + s * (R + 95)
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.setLineWidth(14)
  love.graphics.line(poleBaseX, poleBaseY, poleTopX, poleTopY)
  love.graphics.setColor(COLOR_POLE)
  love.graphics.setLineWidth(7)
  love.graphics.line(poleBaseX, poleBaseY, poleTopX, poleTopY)
  -- (The flag sticks out to the right of the pole, the way it's leaning.)
  local wave = math.sin(t * 3) * 4
  local fx, fy = -s, c -- along the hull, clockwise
  local flag = {
    poleTopX, poleTopY,
    poleTopX + fx * 70 + c * wave, poleTopY + fy * 70 + s * wave,
    poleTopX + fx * 70 - c * 36 + c * wave, poleTopY + fy * 70 - s * 36 + s * wave,
    poleTopX - c * 36, poleTopY - s * 36,
  }
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.setLineWidth(8)
  love.graphics.polygon("line", flag)
  love.graphics.setColor(COLOR_FLAG)
  love.graphics.polygon("fill", flag)
end

-- The big window: glass in a steel frame, deeper blue toward the bottom,
-- with a shine across its top.
local function drawWindow(x, y, R)
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.circle("fill", x, y, R * 0.53)
  love.graphics.setColor(COLOR_FRAME)
  love.graphics.circle("fill", x, y, R * 0.515)
  love.graphics.setColor(COLOR_FRAME_LIGHT)
  love.graphics.setLineWidth(5)
  love.graphics.arc("line", "open", x, y, R * 0.505, math.pi * 1.0, math.pi * 1.6)
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.circle("fill", x, y, R * 0.475)
  love.graphics.setColor(COLOR_GLASS_DEEP)
  love.graphics.circle("fill", x, y, R * 0.465)
  love.graphics.setColor(COLOR_GLASS)
  love.graphics.circle("fill", x - R * 0.04, y - R * 0.06, R * 0.41)
  love.graphics.setColor(1, 1, 1, 0.6)
  love.graphics.setLineWidth(10)
  love.graphics.arc("line", "open", x, y, R * 0.36, math.pi * 1.1, math.pi * 1.4)
  love.graphics.setColor(1, 1, 1, 0.35)
  love.graphics.setLineWidth(5)
  love.graphics.arc("line", "open", x, y, R * 0.29, math.pi * 1.15, math.pi * 1.3)
end

function Spaceship.draw(ship)
  local x, y, R = ship.pos.x, ship.pos.y, ship.radius
  local t = love.timer.getTime()

  drawExhaust(ship)
  drawNozzle(ship)
  drawFlag(x, y, R, t)

  -- The hull: metal (see lua/effects/ShipHull.lua), inside a dark outline.
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.circle("fill", x, y, R + 7)
  ShipHull.draw(x, y, R, COLOR_HULL)

  -- The postmark, painted on: two rings with the route between them.
  love.graphics.setColor(COLOR_PAPER)
  love.graphics.setLineWidth(6)
  love.graphics.circle("line", x, y, R * 0.80)
  love.graphics.circle("line", x, y, R * 0.56)
  drawRingText(RING_TEXT, x, y, R * 0.68, RING_TEXT_HEIGHT)

  drawWindow(x, y, R)
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.setLineWidth(1)
end

return Spaceship
