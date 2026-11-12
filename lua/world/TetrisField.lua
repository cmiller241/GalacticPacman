-- lua/world/TetrisField.lua
--
-- The Tetris planet's game (see lua/levels/TetrisPlanet.lua): Tetris
-- shapes fall in at the round planet one at a time and stick where they
-- land on it (or on blocks already stuck to it). Stuck blocks turn with
-- the planet, which the player turns a column at a time from its control
-- panel (Left and Right; the jump button turns the falling shape — see
-- lua/interiors/ControlRoom.lua, which this is the game of). That's how
-- he picks where the next shape lands.
--
-- The grid wraps round the planet, the way a Tiled map wraps round the
-- dirt planet (see CrackedPlanetoid.fromTiledMap): COLUMNS columns all
-- the way round, and rings stacked outward from the surface, ring 0
-- sitting on it, each RING_HEIGHT thick. Every ring has the same number
-- of columns, so a shape keeps its shape whatever ring it lands on; a
-- block is one column of one ring, a curved slice of the ring
-- (narrower the deeper it is), so stuck shapes hug the planet.
--
-- The planet is split into four colored quadrants, QUADRANT_COLUMNS
-- columns each (turning with it). A quadrant's row — every column of
-- one ring, within that quadrant — filled up clears, Tetris-style: it
-- flashes and fades out with a chime, and the blocks above it in that
-- quadrant drop down a ring.
--
-- Shapes come in from one direction for a while (LANE_TIME seconds),
-- each from somewhere within LANE_SPREAD either side of it (so they all
-- land on the same part of the planet), then the direction swings round
-- to another part. A shape falls straight in toward
-- the planet's middle, one ring at a time, lined up with the grid's
-- columns. While it's far out it's drawn flat, an ordinary Tetris shape;
-- it bends steadily as it comes in, to match the rings it's landing in.
-- A faint ghost shows where it'll land.
--
-- Landing isn't sticking: a shape that can't fall any further waits
-- LOCK_DELAY seconds (pulsing) before it sticks. Turn the planet or the
-- shape in that time so it can fall again, and it carries on falling.
--
-- Letting go of the controls ends the game: every block bursts apart
-- (see :shatter) and the board's wiped, so taking them again starts over.
--
-- The planet's turn is kept two ways: self.turns, the whole columns it's
-- been turned (what landing and fitting go by), and self.angle, where
-- it's drawn, easing after it.

local state = require("lua.state")
local CameraShake = require("lua.effects.CameraShake")

local TetrisField = {}
TetrisField.__index = TetrisField

----------------------------------------------------------------------
-- Tunables
----------------------------------------------------------------------

-- The grid: columns round the planet, and each ring's thickness.
-- (The planet's radius over a ring's thickness sets how much wider each
-- ring's blocks are than the ring's below: about 8.6% a ring here. The
-- columns are about as many as make a ring-0 block as wide as it's tall,
-- rounded to split evenly into the four quadrants.)
TetrisField.COLUMNS = 72
TetrisField.RING_HEIGHT = 36
local COLUMNS, RING_HEIGHT = TetrisField.COLUMNS, TetrisField.RING_HEIGHT
local SECTOR = math.pi * 2 / COLUMNS
-- The quadrants: how many columns each, and their colors (in order
-- clockwise from column 0).
local QUADRANT_COLUMNS = COLUMNS / 4
local QUADRANT_COLORS = {
  { 0.98, 0.42, 0.52 }, -- rose
  { 0.99, 0.78, 0.30 }, -- amber
  { 0.30, 0.86, 0.74 }, -- teal
  { 0.42, 0.62, 0.99 }, -- sky blue
}
local QUADRANT_TINT = 0.38      -- how strongly each quadrant's color shows over the planet
local CLEAR_TIME = 0.45         -- seconds a cleared row takes to flash and fade
-- The game ending (see :shatter): each block breaks into SHARDS x SHARDS
-- chunks that fly out from the planet (world units a second), tumble
-- (radians a second), slow a little (speed kept a second) and fade.
local SHARDS = 2
local SHARD_SPEED_MIN, SHARD_SPEED_RANGE = 160, 340
local SHARD_SPIN = 7
local SHARD_DRAG = 0.55
local SHARD_LIFE_MIN, SHARD_LIFE_RANGE = 0.9, 0.7
local SHATTER_SHAKE_STRENGTH, SHATTER_SHAKE_SECONDS = 22, 0.5
-- The ring a new shape appears in (its bottom row), and how far out from
-- the surface that reaches with the shape's own height (for the camera).
local SPAWN_RING = 14
TetrisField.SPAWN_DISTANCE = (SPAWN_RING + 4) * RING_HEIGHT
local STEP_TIME = 0.3           -- seconds a shape takes to fall one ring
local SPAWN_DELAY = 0.6         -- seconds between one shape sticking and the next appearing
-- How long a landed shape waits before it sticks (the grace to move it).
local LOCK_DELAY = 0.5
-- The direction shapes come in from: how far either side of it each may
-- come from, how long (seconds at the controls) before it swings round,
-- and at least how far it swings (clear of the last part of the planet).
local LANE_SPREAD = math.rad(45)
local LANE_TIME = 30
local MIN_LANE_CHANGE = math.rad(90)
-- Turning the planet: holding Left or Right turns it a column, then
-- after REPEAT_DELAY seconds another every REPEAT_RATE seconds. Each
-- turn eases into place (fraction of the way per tick).
local REPEAT_DELAY = 0.2
local REPEAT_RATE = 0.06
local TURN_EASE = 0.35
-- How many rings above where it'll land a shape starts to bend (about
-- where it appears), bending steadily from there all the way in.
local BEND_RINGS = 13
-- Drawing: slices along each block's curve, its dark border's
-- thickness, and how deep the light band along its outer edge and the
-- shadow along its inner edge are (world units).
local SLICES = 4
local BORDER = 3
local LIGHT_BAND = 6
local SHADE_BAND = 5
local GHOST_ALPHA = 0.22
-- How fast a landed shape pulses while it waits to stick, and how far
-- toward white it goes.
local LOCK_PULSE_SPEED = 18
local LOCK_PULSE_WHITE = 0.35

-- The seven shapes: their blocks (across, down) and colors.
local SHAPES = {
  { cells = { { 0, 0 }, { 1, 0 }, { 2, 0 }, { 3, 0 } }, color = { 0.30, 0.85, 0.95 } }, -- I
  { cells = { { 0, 0 }, { 1, 0 }, { 0, 1 }, { 1, 1 } }, color = { 0.98, 0.85, 0.25 } }, -- O
  { cells = { { 0, 0 }, { 1, 0 }, { 2, 0 }, { 1, 1 } }, color = { 0.70, 0.40, 0.90 } }, -- T
  { cells = { { 1, 0 }, { 2, 0 }, { 0, 1 }, { 1, 1 } }, color = { 0.45, 0.85, 0.35 } }, -- S
  { cells = { { 0, 0 }, { 1, 0 }, { 1, 1 }, { 2, 1 } }, color = { 0.95, 0.35, 0.35 } }, -- Z
  { cells = { { 0, 0 }, { 0, 1 }, { 1, 1 }, { 2, 1 } }, color = { 0.30, 0.50, 0.95 } }, -- J
  { cells = { { 2, 0 }, { 0, 1 }, { 1, 1 }, { 2, 1 } }, color = { 0.98, 0.60, 0.20 } }, -- L
}

local COLOR_BORDER = { 0.04, 0.04, 0.08 }

----------------------------------------------------------------------
-- Building
----------------------------------------------------------------------

-- planet: the round Planetoid it's on.
function TetrisField.new(planet)
  return setmetatable({
    planet = planet,
    turns = 0,       -- whole columns the planet's been turned (clockwise)
    angle = 0,       -- where it's drawn turned to (radians), easing after turns
    heldSteer = 0,   -- which way Left/Right was held last frame, and when it repeats
    repeatTimer = 0,
    blocks = {},     -- stuck blocks: blocks[ring][column] = color (columns 0 to COLUMNS-1)
    stuckMesh = nil, -- every stuck block, drawn in the planet's frame (see :rebuildStuckMesh)
    piece = nil,     -- the shape falling in
    spawnTimer = 0,
    lane = math.random() * math.pi * 2, -- the direction shapes come in from
    laneTimer = LANE_TIME,
    full = false,    -- no room for the next shape (game over, later)
    shards = {},     -- chunks of a shattered game, flying apart (see :shatter)
    clearing = nil,  -- rows clearing now: { rows = { [quadrant] = { ring = true } }, blocks = { {ring, column, color} }, timer }
  }, TetrisField)
end

----------------------------------------------------------------------
-- The grid
----------------------------------------------------------------------

-- Whether a block of the grid is taken: below ring 0 is the planet.
function TetrisField:isSolid(ring, column)
  if ring < 0 then return true end
  local row = self.blocks[ring]
  return row ~= nil and row[column % COLUMNS] ~= nil
end

-- The planet's column under a shape's left edge. worldColumn: which
-- column of the world it's lined up with (column 0 starts at angle 0,
-- straight out to the right, and the count goes clockwise); turns: how
-- far the planet's turned (as it is, by default).
function TetrisField:columnAt(worldColumn, turns)
  return worldColumn - (turns or self.turns)
end

-- Whether the shape fits with its bottom-left block at (ring, column).
function TetrisField:fits(piece, ring, column)
  for _, c in ipairs(piece.cells) do
    if self:isSolid(ring + c[2], column + c[1]) then return false end
  end
  return true
end

-- Whether the shape fits where it is (both the ring it's in and the one
-- it's sliding down from), its left edge over world column worldColumn,
-- with the planet turned `turns` (as it is, by default).
function TetrisField:fitsHere(piece, worldColumn, turns)
  local column = self:columnAt(worldColumn, turns)
  return self:fits(piece, piece.ring, column) and self:fits(piece, piece.prevRing, column)
end

-- The ring the shape would land in, falling straight down from where it
-- is, and the planet's column under it.
function TetrisField:landingRing(piece)
  local column = self:columnAt(piece.worldColumn)
  local ring = piece.ring
  while ring > 0 and self:fits(piece, ring - 1, column) do ring = ring - 1 end
  return ring, column
end

----------------------------------------------------------------------
-- Shapes
----------------------------------------------------------------------

-- A random shape, turned a random number of quarters: its blocks as
-- (column, ring) from its bottom-left (ring 0 its bottom row), how many
-- columns wide it is, and its color.
local function randomShape()
  local shape = SHAPES[math.random(#SHAPES)]
  local cells = {}
  for k, c in ipairs(shape.cells) do cells[k] = { c[1], c[2] } end
  for _ = 1, math.random(0, 3) do
    for _, c in ipairs(cells) do c[1], c[2] = -c[2], c[1] end
  end
  local minI, maxI, maxJ = math.huge, -math.huge, -math.huge
  for _, c in ipairs(cells) do
    minI, maxI, maxJ = math.min(minI, c[1]), math.max(maxI, c[1]), math.max(maxJ, c[2])
  end
  -- (Down the screen is in toward the planet: the shape's bottom row is
  -- ring 0 of it.)
  for _, c in ipairs(cells) do c[1], c[2] = c[1] - minI, maxJ - c[2] end
  return cells, maxI - minI + 1, shape.color
end

-- Swings the direction shapes come in from round to a new one, at least
-- MIN_LANE_CHANGE from the old.
function TetrisField:newLane()
  local old = self.lane
  local lane
  repeat
    lane = math.random() * math.pi * 2
    local apart = math.abs((lane - old + math.pi) % (2 * math.pi) - math.pi)
  until apart >= MIN_LANE_CHANGE
  self.lane = lane
  self.laneTimer = LANE_TIME
end

-- Sends in the next shape, from somewhere within LANE_SPREAD of the
-- direction they're coming in from, lined up with the grid's columns.
function TetrisField:spawn()
  local side = self.lane + (math.random() * 2 - 1) * LANE_SPREAD
  local upcoming = self:peekNext()
  self.nextShape = nil -- (a new one's made the next time it's looked at)
  local cells, width, color = upcoming.cells, upcoming.width, upcoming.color
  local piece = {
    cells = cells, width = width, color = color,
    worldColumn = math.floor(side / SECTOR - width / 2 + 0.5), -- see :columnAt
    ring = SPAWN_RING, prevRing = SPAWN_RING,
    stepTimer = 0,
    landed = false,  -- can't fall further: waiting LOCK_DELAY to stick
    lockTimer = 0,
  }
  if not self:fitsHere(piece, piece.worldColumn) then
    self.full = true
    return
  end
  self.piece = piece
end

-- Sticks the shape where it's landed.
function TetrisField:lock(piece)
  local column = self:columnAt(piece.worldColumn)
  for _, c in ipairs(piece.cells) do
    local ring = piece.ring + c[2]
    self.blocks[ring] = self.blocks[ring] or {}
    self.blocks[ring][(column + c[1]) % COLUMNS] = piece.color
    if ring >= SPAWN_RING - 1 then self.full = true end
  end
  self.piece = nil
  self.spawnTimer = SPAWN_DELAY
  local audio = state.audioManager
  if audio then audio:playGoombaStomp() end -- (a solid thunk)
  self:findClears(piece, column)
  self:rebuildStuckMesh()
end

-- Whether every column of a quadrant is filled in a ring.
function TetrisField:quadrantRowFull(ring, quadrant)
  local row = self.blocks[ring]
  if not row then return false end
  for c = quadrant * QUADRANT_COLUMNS, (quadrant + 1) * QUADRANT_COLUMNS - 1 do
    if row[c] == nil then return false end
  end
  return true
end

-- After a shape sticks: any quadrant row it filled starts clearing. Its
-- blocks come out of the grid now (to flash and fade, see :draw), and
-- the blocks above drop once they've gone (see :finishClear).
function TetrisField:findClears(piece, column)
  local rows, count = {}, 0
  for _, c in ipairs(piece.cells) do
    local ring = piece.ring + c[2]
    local quadrant = math.floor(((column + c[1]) % COLUMNS) / QUADRANT_COLUMNS)
    rows[quadrant] = rows[quadrant] or {}
    if not rows[quadrant][ring] and self:quadrantRowFull(ring, quadrant) then
      rows[quadrant][ring] = true
      count = count + 1
    end
  end
  if count == 0 then return end

  local fading = {}
  for quadrant, rings in pairs(rows) do
    for ring in pairs(rings) do
      for c = quadrant * QUADRANT_COLUMNS, (quadrant + 1) * QUADRANT_COLUMNS - 1 do
        table.insert(fading, { ring = ring, column = c, color = self.blocks[ring][c] })
        self.blocks[ring][c] = nil
      end
    end
  end
  self.clearing = { rows = rows, blocks = fading, timer = 0 }
  local audio = state.audioManager
  if audio then audio:playTetrisClear(count) end
end

-- The cleared rows have faded: in each quadrant that cleared, every block
-- above a cleared row drops a ring for each cleared row beneath it.
function TetrisField:finishClear()
  local rows = self.clearing.rows
  self.clearing = nil
  local top = 0
  for ring in pairs(self.blocks) do top = math.max(top, ring) end
  for quadrant, rings in pairs(rows) do
    for c = quadrant * QUADRANT_COLUMNS, (quadrant + 1) * QUADRANT_COLUMNS - 1 do
      local drop = 0
      for ring = 0, top do
        if rings[ring] then
          drop = drop + 1
        elseif drop > 0 then
          local row = self.blocks[ring]
          local color = row and row[c]
          if color ~= nil then
            row[c] = nil
            self.blocks[ring - drop] = self.blocks[ring - drop] or {}
            self.blocks[ring - drop][c] = color
          end
        end
      end
    end
  end
  self:rebuildStuckMesh()
end

-- Left or Right at the controls: turns the planet a column (dir 1
-- clockwise), unless that would swing a stuck block into the falling
-- shape. Returns whether it turned.
function TetrisField:turnPlanet(dir)
  local turns = self.turns + dir
  local piece = self.piece
  if piece and not self:fitsHere(piece, piece.worldColumn, turns) then return false end
  self.turns = turns
  return true
end

-- The jump button at the controls: turns the falling shape a quarter
-- turn clockwise (as seen with the planet below it), about its middle.
-- If it won't fit turned, it tries a column either way, then a ring
-- further out; if none fits, it stays as it was. Returns whether it turned.
function TetrisField:rotatePiece()
  local piece = self.piece
  if not piece then return false end
  -- (Across and out, turned: what was out goes across, what was across
  -- goes in. Then back to its bottom-left at 0, 0.)
  local cells = {}
  local minU, minV, maxU = math.huge, math.huge, -math.huge
  for k, c in ipairs(piece.cells) do
    local u, v = c[2], -c[1]
    cells[k] = { u, v }
    minU, minV, maxU = math.min(minU, u), math.min(minV, v), math.max(maxU, u)
  end
  for _, c in ipairs(cells) do c[1], c[2] = c[1] - minU, c[2] - minV end
  local width = maxU - minU + 1
  -- (Its middle stays where it was, to the nearest column.)
  local worldColumn = piece.worldColumn + math.floor((piece.width - width) / 2 + 0.5)

  local turned = { cells = cells }
  for _, kick in ipairs({ { 0, 0 }, { -1, 0 }, { 1, 0 }, { 0, 1 } }) do
    turned.ring, turned.prevRing = piece.ring + kick[2], piece.prevRing + kick[2]
    if self:fitsHere(turned, worldColumn + kick[1]) then
      piece.cells, piece.width = cells, width
      piece.worldColumn = worldColumn + kick[1]
      piece.ring, piece.prevRing = turned.ring, turned.prevRing
      return true
    end
  end
  return false
end

-- The game's over (he's let go of the controls): every block — stuck,
-- clearing or falling — breaks into chunks that fly apart, with a bang,
-- and the board's wiped for a fresh start.
function TetrisField:shatter()
  local planet = self.planet
  local cx, cy, radius = planet.pos.x, planet.pos.y, planet.radius
  local count = 0
  -- One block: column u, ring v (fractions allowed), the planet's middle
  -- at angle a0 for column 0.
  local function burst(a0, u, v, color)
    local a = a0 + (u + 0.5) * SECTOR
    local r = radius + (v + 0.5) * RING_HEIGHT
    local width, height = r * SECTOR, RING_HEIGHT
    local ox, oy = math.cos(a), math.sin(a)   -- out from the planet
    local tx, ty = -oy, ox                      -- across
    for i = 0, SHARDS - 1 do
      for j = 0, SHARDS - 1 do
        local across = ((i + 0.5) / SHARDS - 0.5) * width
        local out = ((j + 0.5) / SHARDS - 0.5) * height
        local speed = SHARD_SPEED_MIN + math.random() * SHARD_SPEED_RANGE
        local spread = (math.random() * 2 - 1) * 0.6
        local life = SHARD_LIFE_MIN + math.random() * SHARD_LIFE_RANGE
        table.insert(self.shards, {
          x = cx + ox * (r + out) + tx * across, y = cy + oy * (r + out) + ty * across,
          vx = (ox + tx * spread) * speed, vy = (oy + ty * spread) * speed,
          angle = a + math.pi / 2, spin = (math.random() * 2 - 1) * SHARD_SPIN,
          w = width / SHARDS, h = height / SHARDS,
          color = color, life = life, maxLife = life,
        })
      end
    end
    count = count + 1
  end

  for ring, row in pairs(self.blocks) do
    for column, color in pairs(row) do burst(self.angle, column, ring, color) end
  end
  if self.clearing then
    for _, b in ipairs(self.clearing.blocks) do burst(self.angle, b.column, b.ring, b.color) end
  end
  local piece = self.piece
  if piece then
    local t = math.min(1, piece.stepTimer / STEP_TIME)
    local ringNow = piece.prevRing + (piece.ring - piece.prevRing) * t
    for _, c in ipairs(piece.cells) do burst(piece.worldColumn * SECTOR, c[1], ringNow + c[2], piece.color) end
  end

  -- A fresh board (the planet stays turned the way it is).
  self.blocks = {}
  self.piece, self.nextShape, self.clearing = nil, nil, nil
  self.spawnTimer = 0
  self.full = false
  self:newLane()
  self:rebuildStuckMesh()

  if count > 0 then
    CameraShake.start(SHATTER_SHAKE_STRENGTH, SHATTER_SHAKE_SECONDS)
    local audio = state.audioManager
    if audio and state.player then audio:playBang("large", state.player.pos) end
  end
end

-- The chunks of a shattered game: flying, tumbling, slowing and fading.
function TetrisField:updateShards(dt)
  local shards = self.shards
  if #shards == 0 then return end
  local keep = SHARD_DRAG ^ dt
  for i = #shards, 1, -1 do
    local s = shards[i]
    s.x, s.y = s.x + s.vx * dt, s.y + s.vy * dt
    s.vx, s.vy = s.vx * keep, s.vy * keep
    s.angle = s.angle + s.spin * dt
    s.life = s.life - dt
    if s.life <= 0 then table.remove(shards, i) end
  end
end

----------------------------------------------------------------------
-- Every frame
----------------------------------------------------------------------

-- Left/Right held (dir: -1, 0 or 1): a column turn as it's pressed, then
-- more while it's held, after a moment.
function TetrisField:steer(dir, dt)
  if dir == 0 then
    self.heldSteer = 0
    return
  end
  if dir ~= self.heldSteer then
    self.heldSteer = dir
    self.repeatTimer = REPEAT_DELAY
    self:turnPlanet(dir)
    return
  end
  self.repeatTimer = self.repeatTimer - dt
  while self.repeatTimer <= 0 do
    self.repeatTimer = self.repeatTimer + REPEAT_RATE
    self:turnPlanet(dir)
  end
end

-- steer: -1, 0 or 1 (Left, nothing, Right held). Shapes only fall, and
-- the planet only turns, while `playing` (someone's at the controls);
-- its drawn turn always eases after its last whole-column turn.
function TetrisField:update(dt, ts, playing, steer)
  self:updateShards(dt)
  if playing then self:steer(steer or 0, dt) else self.heldSteer = 0 end
  local target = self.turns * SECTOR
  self.angle = self.angle + (target - self.angle) * math.min(1, TURN_EASE * ts)
  if math.abs(target - self.angle) < 0.0001 then self.angle = target end

  if not playing or self.full then return end

  self.laneTimer = self.laneTimer - dt
  if self.laneTimer <= 0 then self:newLane() end

  -- (Rows clearing: nothing new comes in till they've gone.)
  if self.clearing then
    self.clearing.timer = self.clearing.timer + dt
    if self.clearing.timer >= CLEAR_TIME then self:finishClear() end
    return
  end

  local piece = self.piece
  if not piece then
    self.spawnTimer = self.spawnTimer - dt
    if self.spawnTimer <= 0 then self:spawn() end
    return
  end

  local column = self:columnAt(piece.worldColumn)
  if piece.landed then
    if self:fits(piece, piece.ring - 1, column) then
      -- (Moved off its landing in time: it carries on falling.)
      piece.landed = false
      piece.stepTimer = 0
    else
      piece.lockTimer = piece.lockTimer + dt
      if piece.lockTimer >= LOCK_DELAY then self:lock(piece) end
      return
    end
  end

  piece.stepTimer = piece.stepTimer + dt
  while piece.stepTimer >= STEP_TIME do
    piece.stepTimer = piece.stepTimer - STEP_TIME
    piece.prevRing = piece.ring
    if self:fits(piece, piece.ring - 1, column) then
      piece.ring = piece.ring - 1
    else
      piece.landed = true
      piece.lockTimer = 0
      piece.stepTimer = 0
      return
    end
  end
end

----------------------------------------------------------------------
-- Drawing
----------------------------------------------------------------------

-- Triangles go into a list of mesh vertices: { x, y, u, v, r, g, b, a }.
local function addQuad(verts, x1, y1, x2, y2, x3, y3, x4, y4, r, g, b, a)
  local n = #verts
  verts[n + 1] = { x1, y1, 0, 0, r, g, b, a }
  verts[n + 2] = { x2, y2, 0, 0, r, g, b, a }
  verts[n + 3] = { x3, y3, 0, 0, r, g, b, a }
  verts[n + 4] = { x1, y1, 0, 0, r, g, b, a }
  verts[n + 5] = { x3, y3, 0, 0, r, g, b, a }
  verts[n + 6] = { x4, y4, 0, 0, r, g, b, a }
end

-- One band of a block: the part from u0 to u1 (across, in columns) and
-- v0 to v1 (out, in rings), placed by `place` (u, v -> x, y), in slices
-- along its curve.
local function addBand(verts, place, u0, u1, v0, v1, r, g, b, a)
  local px, py, qx, qy = place(u0, v0)
  qx, qy = place(u0, v1)
  for s = 1, SLICES do
    local u = u0 + (u1 - u0) * s / SLICES
    local nx, ny = place(u, v0)
    local mx, my = place(u, v1)
    addQuad(verts, px, py, nx, ny, mx, my, qx, qy, r, g, b, a)
    px, py, qx, qy = nx, ny, mx, my
  end
end

-- One block (column u0 to u0+1, ring v0 to v0+1, in `place`'s terms):
-- a dark border, the color, a light band along its outer edge and a
-- shadow along its inner edge. du, dv: one world unit across and out,
-- in those terms (near enough), for the border and bands.
local function addBlock(verts, place, u0, v0, color, alpha, du, dv)
  local r, g, b = color[1], color[2], color[3]
  local bu, bv = BORDER * du, BORDER * dv
  addBand(verts, place, u0, u0 + 1, v0, v0 + 1, COLOR_BORDER[1], COLOR_BORDER[2], COLOR_BORDER[3], alpha)
  local ua, ub, va, vb = u0 + bu, u0 + 1 - bu, v0 + bv, v0 + 1 - bv
  addBand(verts, place, ua, ub, va, vb, r, g, b, alpha)
  addBand(verts, place, ua, ub, vb - LIGHT_BAND * dv, vb,
    r + (1 - r) * 0.4, g + (1 - g) * 0.4, b + (1 - b) * 0.4, alpha)
  addBand(verts, place, ua, ub, va, va + SHADE_BAND * dv, r * 0.68, g * 0.68, b * 0.68, alpha)
end

-- Draws mesh vertices, through a mesh kept in holder[field] and grown as needed.
local function drawVertices(holder, field, verts)
  local n = #verts
  if n == 0 then return end
  local mesh = holder[field]
  if not mesh or mesh:getVertexCount() < n then
    mesh = love.graphics.newMesh(math.max(n, 1200), "triangles", "dynamic")
    holder[field] = mesh
  end
  mesh:setVertices(verts)
  mesh:setDrawRange(1, n)
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(mesh)
end

-- Every stuck block, in the planet's own frame (its middle at 0, 0,
-- unturned): rebuilt only when one sticks, and drawn turned with the
-- planet.
function TetrisField:rebuildStuckMesh()
  local radius = self.planet.radius
  local function place(u, v)
    local a, r = u * SECTOR, radius + v * RING_HEIGHT
    return math.cos(a) * r, math.sin(a) * r
  end
  local verts = {}
  for ring, row in pairs(self.blocks) do
    local du = 1 / ((radius + (ring + 0.5) * RING_HEIGHT) * SECTOR)
    for column, color in pairs(row) do
      addBlock(verts, place, column, ring, color, 1, du, 1 / RING_HEIGHT)
    end
  end
  -- (The mesh itself is made the next time it's drawn.)
  self.stuckVerts = verts
  self.stuckMesh = nil
end

-- The four quadrants, turning with the planet: each tinted its color,
-- with a bright band of it round its stretch of the surface and a line
-- between one quadrant and the next.
local function drawQuadrants(planet, angle)
  local x, y, r = planet.pos.x, planet.pos.y, planet.radius
  local span = QUADRANT_COLUMNS * SECTOR
  for q = 0, 3 do
    local a0 = angle + q * span
    local color = QUADRANT_COLORS[q + 1]
    love.graphics.setColor(color[1], color[2], color[3], QUADRANT_TINT)
    love.graphics.arc("fill", "pie", x, y, r, a0, a0 + span, 24)
    love.graphics.setColor(color[1], color[2], color[3], 0.9)
    love.graphics.setLineWidth(8)
    love.graphics.arc("line", "open", x, y, r - 5, a0 + 0.01, a0 + span - 0.01, 24)
    love.graphics.setColor(1, 1, 1, 0.45)
    love.graphics.setLineWidth(3)
    love.graphics.line(x, y, x + math.cos(a0) * r, y + math.sin(a0) * r)
  end
end

-- Marks round the planet's edge, one per column, turning with it: the
-- grid the shapes land on, and its turn.
local function drawColumnMarks(planet, angle)
  local r = planet.radius
  love.graphics.setLineWidth(3)
  for k = 0, COLUMNS - 1 do
    local a = angle + k * SECTOR
    local c, s = math.cos(a), math.sin(a)
    love.graphics.setColor(1, 1, 1, k % 3 == 0 and 0.22 or 0.10)
    love.graphics.line(planet.pos.x + c * (r - 16), planet.pos.y + s * (r - 16), planet.pos.x + c * (r - 3), planet.pos.y + s * (r - 3))
  end
end

-- The column marks, the stuck blocks, and the shape falling in (with a
-- ghost where it'll land). World space.
function TetrisField:draw()
  local planet = self.planet
  local cx, cy, radius = planet.pos.x, planet.pos.y, planet.radius
  drawQuadrants(planet, self.angle)
  drawColumnMarks(planet, self.angle)

  if self.stuckVerts and #self.stuckVerts > 0 then
    if not self.stuckMesh then
      self.stuckMesh = love.graphics.newMesh(self.stuckVerts, "triangles", "static")
    end
    love.graphics.push()
    love.graphics.translate(cx, cy)
    love.graphics.rotate(self.angle)
    love.graphics.setColor(1, 1, 1, 1)
    love.graphics.draw(self.stuckMesh)
    love.graphics.pop()
  end

  -- Rows clearing: flashing white, then fading out.
  local clearing = self.clearing
  if clearing then
    local t = math.min(1, clearing.timer / CLEAR_TIME)
    local white, alpha = 0.8 * (1 - t), 1 - t * t
    local function placeTurned(u, v)
      local a, r = self.angle + u * SECTOR, radius + v * RING_HEIGHT
      return cx + math.cos(a) * r, cy + math.sin(a) * r
    end
    local verts = {}
    for _, b in ipairs(clearing.blocks) do
      local c = b.color
      local color = { c[1] + (1 - c[1]) * white, c[2] + (1 - c[2]) * white, c[3] + (1 - c[3]) * white }
      addBlock(verts, placeTurned, b.column, b.ring, color, alpha,
        1 / ((radius + (b.ring + 0.5) * RING_HEIGHT) * SECTOR), 1 / RING_HEIGHT)
    end
    drawVertices(self, "clearMesh", verts)
  end

  -- A shattered game's chunks: each a small square of its block's color
  -- (a dark edge round it), tumbling, fading out at the end of its life.
  if #self.shards > 0 then
    local verts = {}
    for _, s in ipairs(self.shards) do
      local alpha = math.min(1, s.life / (s.maxLife * 0.5))
      local c, sn = math.cos(s.angle), math.sin(s.angle)
      for layer = 1, 2 do
        local hw, hh = s.w / 2, s.h / 2
        local r, g, b = COLOR_BORDER[1], COLOR_BORDER[2], COLOR_BORDER[3]
        if layer == 2 then hw, hh, r, g, b = hw - 2, hh - 2, s.color[1], s.color[2], s.color[3] end
        local ax, ay = c * hw, sn * hw
        local bx, by = -sn * hh, c * hh
        addQuad(verts,
          s.x - ax - bx, s.y - ay - by, s.x + ax - bx, s.y + ay - by,
          s.x + ax + bx, s.y + ay + by, s.x - ax + bx, s.y - ay + by,
          r, g, b, alpha)
      end
    end
    drawVertices(self, "shardMesh", verts)
  end

  local piece = self.piece
  if not piece then return end
  local verts = {}

  -- The ghost: where it'll land, in the grid as the planet is drawn.
  local landRing, column = self:landingRing(piece)
  local snapped = self.angle + column * SECTOR
  local function placeCurved(u, v)
    local a, r = snapped + u * SECTOR, radius + v * RING_HEIGHT
    return cx + math.cos(a) * r, cy + math.sin(a) * r
  end
  local dv = 1 / RING_HEIGHT
  if not piece.landed then
    for _, c in ipairs(piece.cells) do
      local ring = landRing + c[2]
      addBlock(verts, placeCurved, c[1], ring, piece.color, GHOST_ALPHA,
        1 / ((radius + (ring + 0.5) * RING_HEIGHT) * SECTOR), dv)
    end
  end

  -- The shape itself: slid smoothly from the ring it was last in to the
  -- one it's in, and bent by how near it is to where it'll land — flat
  -- (an ordinary Tetris shape, its blocks as wide as they'll be at the
  -- surface) far out, curved like the rings close in. Landed, it pulses
  -- toward white while it waits to stick.
  local t = math.min(1, piece.stepTimer / STEP_TIME)
  local ringNow = piece.prevRing + (piece.ring - piece.prevRing) * t
  local bend = 1 - math.min(1, math.max(0, (ringNow - landRing) / BEND_RINGS))
  local theta = piece.worldColumn * SECTOR
  local mid = theta + piece.width / 2 * SECTOR
  local ox, oy = math.cos(mid), math.sin(mid)  -- out from the planet, at the shape's middle
  local tx, ty = -oy, ox                         -- across, the way the columns count
  local flatWidth = (radius + 0.5 * RING_HEIGHT) * SECTOR
  local function placeShape(u, v)
    local ring = ringNow + v
    local a, r = theta + u * SECTOR, radius + ring * RING_HEIGHT
    local curvedX, curvedY = cx + math.cos(a) * r, cy + math.sin(a) * r
    local across = (u - piece.width / 2) * flatWidth
    local flatX = cx + ox * r + tx * across
    local flatY = cy + oy * r + ty * across
    return flatX + (curvedX - flatX) * bend, flatY + (curvedY - flatY) * bend
  end
  local color = piece.color
  if piece.landed then
    local w = LOCK_PULSE_WHITE * (0.5 + 0.5 * math.sin(piece.lockTimer * LOCK_PULSE_SPEED))
    color = { color[1] + (1 - color[1]) * w, color[2] + (1 - color[2]) * w, color[3] + (1 - color[3]) * w }
  end
  for _, c in ipairs(piece.cells) do
    addBlock(verts, placeShape, c[1], c[2], color, 1, 1 / flatWidth, dv)
  end

  drawVertices(self, "pieceMesh", verts)
end

-- The shape that'll come in after the one falling now (made the first
-- time it's asked for): { cells, width, color }.
function TetrisField:peekNext()
  if not self.nextShape then
    local cells, width, color = randomShape()
    self.nextShape = { cells = cells, width = width, color = color }
  end
  return self.nextShape
end

-- The next-shape box: its size and margin from the screen's corner, and
-- the size of a block in it (screen pixels).
local NEXT_BOX = 150
local NEXT_MARGIN = 20
local NEXT_BLOCK = 26
local nextFont = nil

-- The next shape, flat and the way round it'll come in, in a box at the
-- top right of the screen (see :drawHud). Screen space.
function TetrisField:drawNext()
  local shape = self:peekNext()
  local x0, y0 = love.graphics.getWidth() - NEXT_MARGIN - NEXT_BOX, NEXT_MARGIN

  love.graphics.setColor(0.04, 0.03, 0.08, 0.7)
  love.graphics.rectangle("fill", x0, y0, NEXT_BOX, NEXT_BOX, 12, 12)
  love.graphics.setColor(1, 1, 1, 0.3)
  love.graphics.setLineWidth(2)
  love.graphics.rectangle("line", x0, y0, NEXT_BOX, NEXT_BOX, 12, 12)

  nextFont = nextFont or love.graphics.newFont(18)
  local prevFont = love.graphics.getFont()
  love.graphics.setFont(nextFont)
  love.graphics.setColor(1, 1, 1, 0.85)
  love.graphics.printf("NEXT", x0, y0 + 10, NEXT_BOX, "center")
  love.graphics.setFont(prevFont)

  -- Centered in the space under the label, its bottom row at the bottom
  -- (the side that'll face the planet).
  local height = 0
  for _, c in ipairs(shape.cells) do height = math.max(height, c[2] + 1) end
  local s = NEXT_BLOCK
  local midX, midY = x0 + NEXT_BOX / 2, y0 + 36 + (NEXT_BOX - 36) / 2
  local left, bottom = midX - shape.width * s / 2, midY + height * s / 2
  local function place(u, v) return left + u * s, bottom - v * s end
  local verts = {}
  for _, c in ipairs(shape.cells) do
    addBlock(verts, place, c[1], c[2], shape.color, 1, 1 / s, 1 / s)
  end
  drawVertices(self, "nextMesh", verts)
  love.graphics.setColor(1, 1, 1, 1)
end

----------------------------------------------------------------------
-- As the control room's game (see lua/interiors/ControlRoom.lua)
----------------------------------------------------------------------

-- (Nothing to set up: shapes start falling as soon as he's at the controls.)
function TetrisField:start() end

-- The jump button at the controls: turns the falling shape.
function TetrisField:onJump() self:rotatePiece() end

-- He's let go: the game's over, its blocks burst apart.
function TetrisField:stop() self:shatter() end

-- How far out the camera frames, at the controls: everything falling in.
function TetrisField:cameraReach()
  return self.planet.radius + TetrisField.SPAWN_DISTANCE
end

-- With the HUD: the next shape, while he's at the controls.
function TetrisField:drawHud(playing)
  if playing then self:drawNext() end
end

return TetrisField
