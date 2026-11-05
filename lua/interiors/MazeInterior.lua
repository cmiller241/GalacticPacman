-- lua/interiors/MazeInterior.lua
--
-- The maze inside the maze planet (see lua/levels/MazePlanet.lua): six
-- square maze areas, joined the way a cube's faces are. Like the pinball
-- table (lua/interiors/PinballInterior.lua), he plays it as a ball: the
-- planet's entry beam drops him in the middle of the front face
-- (:onEnter), and the exit portal in the middle of the back face puts him
-- back on the planet's top (:exitBall). While he's in here the camera
-- frames the face he's on, whole (see :cameraView and Camera.lua).
--
-- Rolling: along the middle of the corridors, one tile at a time, until a
-- wall stops him. A direction held (or pressed a little early, or just
-- late) is taken at the next opening that way; the way he came is taken
-- at once.
--
-- The cube: every face has one opening in the middle of each edge. Rolling
-- out of one, the cube turns over to the face on the other side of that
-- edge (the old face narrowing and darkening as it turns away, the new
-- one widening and brightening as it comes round, him carried along on the
-- edge between them), turned the way it would be on a real cube that had
-- rolled over: so rolling right four times
-- brings him back round, and going up over the top shows the back face
-- upside down. Each face's layout is written out the right way up as it
-- sits in this net (up is up on the front, left and right faces):
--
--          top
--   left  front  right  back
--         bottom
--
-- The openings are all in the middle of their edges, so they meet whichever
-- way a face has turned.
--
-- The dots are picked up as he rolls over them; clearing every one, on
-- every face, scores CLEAR_BONUS and puts them all back. Scoring goes to
-- state.score (the HUD's).
--
-- The planet never moves or turns: everything here is plain world space,
-- centered on the planet.

local state = require("lua.state")
local Vector2 = require("lua.vector2")

local MazeInterior = {}
MazeInterior.__index = MazeInterior
-- (The gamepad stick's up/down roll him too while he's in here: see
-- GamePadInput.lua.)
MazeInterior.fourWayInput = true

----------------------------------------------------------------------
-- The faces
----------------------------------------------------------------------
--
--   #  wall          .  dot            o  big dot
--   S  the start     E  the exit       (space)  open, no dot
--
-- n is the face's outward direction, r and d which ways its layout's right
-- and down point (x right, y down, z toward you, looking at the front).
-- Each one checked: openings only in the middle of each edge, every open
-- tile reachable, no dead ends, no open 2x2 blocks outside the exit's
-- chamber.
local FACES = {
  front = { n = { 0, 0, 1 }, r = { 1, 0, 0 }, d = { 0, 1, 0 }, layout = {
    "######.######",
    "#o.........o#",
    "#.###.#.###.#",
    "#.###.#.###.#",
    "#...........#",
    "#.#.##.##.#.#",
    "..#...S...#..",
    "#.#.##.##.#.#",
    "#...........#",
    "#.###.#.###.#",
    "#.###.#.###.#",
    "#o.........o#",
    "######.######",
  } },
  right = { n = { 1, 0, 0 }, r = { 0, 0, -1 }, d = { 0, 1, 0 }, layout = {
    "######.######",
    "#o..#...#..o#",
    "#.#.#.#.#.#.#",
    "#.#...#...#.#",
    "#.###.#.###.#",
    "#...........#",
    "..##.#.#.##..",
    "#...........#",
    "#.###.#.###.#",
    "#.#...#...#.#",
    "#.#.#.#.#.#.#",
    "#o..#...#..o#",
    "######.######",
  } },
  back = { n = { 0, 0, -1 }, r = { -1, 0, 0 }, d = { 0, 1, 0 }, layout = {
    "######.######",
    "#.....o.....#",
    "#.##.###.##.#",
    "#.#.......#.#",
    "#.#.##.##.#.#",
    "#...#...#...#",
    "..#.#.E.#.#..",
    "#...#...#...#",
    "#.#.##.##.#.#",
    "#.#.......#.#",
    "#.##.###.##.#",
    "#.....o.....#",
    "######.######",
  } },
  left = { n = { -1, 0, 0 }, r = { 0, 0, 1 }, d = { 0, 1, 0 }, layout = {
    "######.######",
    "#o..#...#..o#",
    "#.#.#.#.#.#.#",
    "#.#.......#.#",
    "#.###.#.###.#",
    "#.....#.....#",
    "..###...###..",
    "#.....#.....#",
    "#.###.#.###.#",
    "#.#.......#.#",
    "#.#.#.#.#.#.#",
    "#o..#...#..o#",
    "######.######",
  } },
  top = { n = { 0, -1, 0 }, r = { 1, 0, 0 }, d = { 0, 0, 1 }, layout = {
    "######.######",
    "#o.........o#",
    "#.##.###.##.#",
    "#.#...#...#.#",
    "#.#.#.#.#.#.#",
    "#...#...#...#",
    "..#.##.##.#..",
    "#...#...#...#",
    "#.#.#.#.#.#.#",
    "#.#...#...#.#",
    "#.##.###.##.#",
    "#o.........o#",
    "######.######",
  } },
  bottom = { n = { 0, 1, 0 }, r = { 1, 0, 0 }, d = { 0, 0, -1 }, layout = {
    "######.######",
    "#o.........o#",
    "#.#.#.#.#.#.#",
    "#.#.#.#.#.#.#",
    "#...#...#...#",
    "###.#.#.#.###",
    "......#......",
    "###.#.#.#.###",
    "#...#...#...#",
    "#.#.#.#.#.#.#",
    "#.#.#.#.#.#.#",
    "#o.........o#",
    "######.######",
  } },
}
local FACE_NAMES = { "front", "right", "back", "left", "top", "bottom" }

----------------------------------------------------------------------
-- Tunables
----------------------------------------------------------------------

-- Tiles across a face, and world units per tile. The ball is about 48
-- across, so a corridor (one tile, plus the walls' inset on both sides)
-- is roughly twice that.
MazeInterior.SIZE = 13
MazeInterior.TILE = 72
local N, TILE = MazeInterior.SIZE, MazeInterior.TILE
local MID = (N + 1) / 2         -- the middle tile (where the edge openings are)
local FACE_WIDTH = N * TILE
local WALL_INSET = 8            -- how far a wall's edge sits back from its tile's edge
local ROLL_SPEED = 6.5          -- world units per tick
-- A turn asked for just after he's rolled past an opening still takes it
-- (he's put back on the tile's middle), up to this far past.
local TURN_GRACE = TILE * 0.25
local SCROLL_TICKS = 42         -- the cube turning over to the next face
-- How dark a face gets, turned all the way away (0 = no shading, 1 = black).
local TURN_SHADE = 0.8
-- How far away the viewer is, in face widths: nearer makes the turning
-- cube's perspective stronger.
local TURN_VIEW_DISTANCE = 3
-- Slices each turning face is bent in (more: smoother perspective).
local TURN_STRIPS = 24
-- How bright the light along the cube's near edge gets, halfway through a turn.
local TURN_EDGE_LIGHT = 0.5
local HALF = FACE_WIDTH / 2
local EYE = TURN_VIEW_DISTANCE * FACE_WIDTH -- the viewer, from the cube's middle

-- The cube mid-turn, seen from in front: a point on the face he's leaving
-- (leaving true) or on the next one, `a` from that face's middle along the
-- way he's going, with the cube turned an angle with cosine c and sine s
-- (0 to a quarter turn). Returns how far along that is on screen from the
-- planet's middle, and how much bigger or smaller (perspective) things
-- there look: 1 on the front, more nearer the viewer, less further off.
local function turnedPoint(a, c, s, leaving)
  local x, z
  if leaving then
    x, z = a * c - HALF * s, a * s + HALF * c
  else
    x, z = HALF * c + a * s, HALF * s - a * c
  end
  local k = (EYE - HALF) / (EYE - z)
  return x * k, k
end
local DOT_POINTS = 10
local BIG_DOT_POINTS = 50
local CLEAR_BONUS = 1000
-- Room left round the face when the camera frames it (world units).
local CAMERA_MARGIN = 40

MazeInterior.COLOR_WALL = { 0.08, 0.10, 0.30, 1 }
local COLOR_FLOOR = { 0.03, 0.03, 0.09, 1 }
local COLOR_WALL = MazeInterior.COLOR_WALL
local COLOR_WALL_EDGE = { 0.38, 0.62, 1.00, 1 }
local COLOR_WALL_GLOW = { 0.38, 0.62, 1.00, 0.22 }
local EDGE_WIDTH = 4
local GLOW_WIDTH = 14
local COLOR_DOT = { 1.00, 0.92, 0.70, 1 }
local DOT_RADIUS = 6
local BIG_DOT_RADIUS = 14
local COLOR_EXIT = { 0.95, 0.35, 0.95 }
local EXIT_RADIUS = 26
local POPUP_TICKS = 50

-- Directions by arrow key, in the order they're checked when several are held.
local DIRECTIONS = {
  { key = "ArrowUp", dx = 0, dy = -1 },
  { key = "ArrowDown", dx = 0, dy = 1 },
  { key = "ArrowLeft", dx = -1, dy = 0 },
  { key = "ArrowRight", dx = 1, dy = 0 },
}

local function dot3(a, b) return a[1] * b[1] + a[2] * b[2] + a[3] * b[3] end
local function neg3(a) return { -a[1], -a[2], -a[3] } end

-- How a face (its own right r and down d) is turned on screen, when the
-- screen's right and down point `right` and `down` on the cube: xx, yx is
-- where the face's right ends up on screen, xy, yy its down.
local function turning(face, right, down)
  return {
    xx = dot3(face.r, right), xy = dot3(face.d, right),
    yx = dot3(face.r, down), yy = dot3(face.d, down),
  }
end

----------------------------------------------------------------------
-- Building
----------------------------------------------------------------------

-- Every wall of a face as one mesh, in the face's own frame (centered on
-- 0, 0, unturned), built once: each wall tile filled (set back WALL_INSET
-- from any side that faces a corridor, and with that much cut off any
-- corner that only touches a corridor diagonally), with a glowing edge
-- along everything facing a corridor.
local function buildWallMesh(isWall)
  local vertices = {}
  local function quad(x0, y0, x1, y1, c)
    local function v(x, y) vertices[#vertices + 1] = { x, y, 0, 0, c[1], c[2], c[3], c[4] } end
    v(x0, y0); v(x1, y0); v(x1, y1)
    v(x0, y0); v(x1, y1); v(x0, y1)
  end
  -- A straight edge from (x0, y0) to (x1, y1) (level or upright), as a
  -- band `width` across.
  local function band(x0, y0, x1, y1, width, c)
    local h = width / 2
    if y0 == y1 then
      quad(math.min(x0, x1) - h, y0 - h, math.max(x0, x1) + h, y0 + h, c)
    else
      quad(x0 - h, math.min(y0, y1) - h, x0 + h, math.max(y0, y1) + h, c)
    end
  end

  local fills, cuts, edges = {}, {}, {}
  local I = WALL_INSET
  for row = 1, N do
    for col = 1, N do
      if isWall(col, row) then
        local x0, y0 = (col - 1) * TILE - FACE_WIDTH / 2, (row - 1) * TILE - FACE_WIDTH / 2
        local x1, y1 = x0 + TILE, y0 + TILE
        local up, down = not isWall(col, row - 1), not isWall(col, row + 1)
        local left, right = not isWall(col - 1, row), not isWall(col + 1, row)
        local fx0, fy0 = left and x0 + I or x0, up and y0 + I or y0
        local fx1, fy1 = right and x1 - I or x1, down and y1 - I or y1
        fills[#fills + 1] = { fx0, fy0, fx1, fy1 }
        if up then edges[#edges + 1] = { fx0, fy0, fx1, fy0 } end
        if down then edges[#edges + 1] = { fx0, fy1, fx1, fy1 } end
        if left then edges[#edges + 1] = { fx0, fy0, fx0, fy1 } end
        if right then edges[#edges + 1] = { fx1, fy0, fx1, fy1 } end
        -- Inside corners: walls on both sides, a corridor only diagonally.
        for _, d in ipairs({ { -1, -1 }, { 1, -1 }, { -1, 1 }, { 1, 1 } }) do
          local dx, dy = d[1], d[2]
          if isWall(col + dx, row) and isWall(col, row + dy) and not isWall(col + dx, row + dy) then
            local cx, cy = dx < 0 and x0 or x1, dy < 0 and y0 or y1
            local ix, iy = cx - dx * I, cy - dy * I
            cuts[#cuts + 1] = { math.min(cx, ix), math.min(cy, iy), math.max(cx, ix), math.max(cy, iy) }
            edges[#edges + 1] = { ix, iy, cx, iy }
            edges[#edges + 1] = { ix, iy, ix, cy }
          end
        end
      end
    end
  end
  for _, f in ipairs(fills) do quad(f[1], f[2], f[3], f[4], COLOR_WALL) end
  for _, f in ipairs(cuts) do quad(f[1], f[2], f[3], f[4], COLOR_FLOOR) end
  for _, e in ipairs(edges) do band(e[1], e[2], e[3], e[4], GLOW_WIDTH, COLOR_WALL_GLOW) end
  for _, e in ipairs(edges) do band(e[1], e[2], e[3], e[4], EDGE_WIDTH, COLOR_WALL_EDGE) end
  return love.graphics.newMesh(vertices, "triangles", "static")
end

function MazeInterior.new(planetoid)
  local self = setmetatable({}, MazeInterior)
  self.planetoid = planetoid
  self.faces = {}
  for _, name in ipairs(FACE_NAMES) do
    local def = FACES[name]
    local face = { name = name, n = def.n, r = def.r, d = def.d, walls = {}, dotKinds = {} }
    for row = 1, N do
      face.walls[row], face.dotKinds[row] = {}, {}
      for col = 1, N do
        local ch = def.layout[row]:sub(col, col)
        face.walls[row][col] = ch == "#"
        if ch == "." then face.dotKinds[row][col] = "dot" end
        if ch == "o" then face.dotKinds[row][col] = "big" end
        if ch == "S" then self.startFace, self.startCol, self.startRow = name, col, row end
        if ch == "E" then self.exitFace, self.exitCol, self.exitRow = name, col, row end
      end
    end
    -- (Off the face counts as wall for the mesh: the openings' walls end there.)
    face.mesh = buildWallMesh(function(col, row)
      if col < 1 or col > N or row < 1 or row > N then return true end
      return face.walls[row][col]
    end)
    self.faces[name] = face
  end
  self:resetDots()
  self.popups = {}
  self:resetView()
  return self
end

function MazeInterior:resetDots()
  self.dotsLeft = 0
  for _, name in ipairs(FACE_NAMES) do
    local face = self.faces[name]
    face.dots = {}
    for row = 1, N do
      face.dots[row] = {}
      for col = 1, N do
        face.dots[row][col] = face.dotKinds[row][col]
        if face.dots[row][col] then self.dotsLeft = self.dotsLeft + 1 end
      end
    end
  end
end

----------------------------------------------------------------------
-- The view: which face is showing, turned which way
----------------------------------------------------------------------
--
-- viewRight / viewDown: which ways (on the cube) the screen's right and
-- down point. A face's tiles are worked with as VIEW tiles: as it's shown,
-- right way up on screen, (1, 1) top-left. faceTile converts to the face's
-- own.

function MazeInterior:resetView()
  self:setView(self.startFace, { 1, 0, 0 }, { 0, 1, 0 })
end

function MazeInterior:setView(faceName, right, down)
  self.face = self.faces[faceName]
  self.viewRight, self.viewDown = right, down
  self.m = turning(self.face, right, down)
end

-- View tile -> the face's own tile.
function MazeInterior:faceTile(col, row)
  local m = self.m
  local u, v = col - MID, row - MID
  return MID + m.xx * u + m.yx * v, MID + m.xy * u + m.yy * v
end

-- Whether view tile (col, row) is a wall. Off the face is wall, except
-- straight out of an edge opening (the next face's opening is there).
function MazeInterior:isWall(col, row)
  if col < 1 or col > N or row < 1 or row > N then
    return not ((col == MID and (row == 0 or row == N + 1)) or (row == MID and (col == 0 or col == N + 1)))
  end
  local fc, fr = self:faceTile(col, row)
  return self.face.walls[fr][fc]
end

-- The middle of view tile (col, row), in world space.
function MazeInterior:tileCenter(col, row)
  local p = self.planetoid
  return p.pos.x + (col - MID) * TILE, p.pos.y + (row - MID) * TILE
end

----------------------------------------------------------------------
-- Going in and out
----------------------------------------------------------------------

-- Where the beam drops him: the start tile (on the front face, which is
-- the one showing whenever he isn't inside).
function MazeInterior:getPortalPosition()
  return Vector2.new(self:tileCenter(self.startCol, self.startRow))
end

function MazeInterior:onEnter(player)
  player:forceBallMode()
  player.inInterior = self
  player.onSurface = false
  -- (No planet under him: he's drawn the right way up, not turned to
  -- whichever face of the planet is nearest.)
  player.currentPlanet, player.lastInfluencePlanet = nil, nil
  player.vel.x, player.vel.y = 0, 0
  self:resetView()
  self.scroll = nil
  self.col, self.row = self.startCol, self.startRow
  player.pos.x, player.pos.y = self:tileCenter(self.col, self.row)
  player.prevPos = player.pos:clone()
  -- Rolling nowhere until he picks a way.
  self.dirX, self.dirY = 0, 0
  self.wantX, self.wantY = 0, 0
end

-- The exit: he stands back up on top of the planet, beside the entry
-- beam (self.exitPosition, set by MazePlanet.lua), or at the top-middle.
-- The planet shows its front face again.
function MazeInterior:exitBall(player)
  player.inInterior = nil
  player.vel.x, player.vel.y = 0, 0
  if player.isBall then player:exitBallMode() end
  self.scroll = nil
  self:resetView()
  local p = self.planetoid
  local exitX = self.exitPosition and self.exitPosition.x or p.pos.x
  player.pos.x, player.pos.y = exitX, p.pos.y - p.halfHeight - player.radius - 2
  player.prevPos = player.pos:clone()
end

-- (The jump button does nothing in here.)
function MazeInterior:triggerJumpAction() end

-- What the camera shows while he's in here (see Camera.lua): the face,
-- whole. Returns the middle to look at and the zoom.
function MazeInterior:cameraView(screenW, screenH)
  local p = self.planetoid
  return p.pos.x, p.pos.y, math.min(screenW, screenH) / (FACE_WIDTH + 2 * CAMERA_MARGIN)
end

----------------------------------------------------------------------
-- Rolling
----------------------------------------------------------------------

function MazeInterior:canGo(dx, dy)
  return (dx ~= 0 or dy ~= 0) and not self:isWall(self.col + dx, self.row + dy)
end

-- Called every frame he's in here, in place of gravity and collision.
function MazeInterior:updateBall(player, ts)
  self:updatePopups(ts)
  if self.scroll then
    self:updateScroll(player, ts)
    return
  end

  for _, d in ipairs(DIRECTIONS) do
    if state.keys[d.key] then self.wantX, self.wantY = d.dx, d.dy; break end
  end

  -- Back the way he came: at once.
  if self.wantX == -self.dirX and self.wantY == -self.dirY and (self.dirX ~= 0 or self.dirY ~= 0) then
    self.dirX, self.dirY = self.wantX, self.wantY
    self.col, self.row = self.col - self.dirX, self.row - self.dirY
  end

  -- A turn a moment late: just past the middle of the tile he's leaving.
  local turningNow = (self.wantX ~= 0 or self.wantY ~= 0) and self.wantX ~= self.dirX and self.wantY ~= self.dirY
  if turningNow and (self.dirX ~= 0 or self.dirY ~= 0) and self:canGo(self.wantX, self.wantY) then
    local cx, cy = self:tileCenter(self.col, self.row)
    if math.abs(player.pos.x - cx) + math.abs(player.pos.y - cy) <= TURN_GRACE then
      player.pos.x, player.pos.y = cx, cy
      self.dirX, self.dirY = self.wantX, self.wantY
    end
  end

  local x0, y0 = player.pos.x, player.pos.y
  local left = ROLL_SPEED * ts
  local guard = 0
  while left > 0 and guard < 8 do
    guard = guard + 1
    if self.dirX == 0 and self.dirY == 0 then
      -- Standing still on a tile's middle: off as soon as there's a way.
      if self:canGo(self.wantX, self.wantY) then
        self.dirX, self.dirY = self.wantX, self.wantY
      else
        break
      end
    end
    -- Out of an edge opening: over to the next face.
    local nextCol, nextRow = self.col + self.dirX, self.row + self.dirY
    if nextCol < 1 or nextCol > N or nextRow < 1 or nextRow > N then
      self:startScroll(player)
      break
    end
    -- Toward the middle of the next tile along.
    local tx, ty = self:tileCenter(nextCol, nextRow)
    local dist = math.abs(tx - player.pos.x) + math.abs(ty - player.pos.y)
    if dist > left then
      player.pos.x, player.pos.y = player.pos.x + self.dirX * left, player.pos.y + self.dirY * left
      left = 0
    else
      player.pos.x, player.pos.y = tx, ty
      left = left - dist
      self.col, self.row = nextCol, nextRow
      if self:arriveAt(player) then return end
      -- At a tile's middle: turn the way he wants if he can, else carry
      -- on, else stop against the wall.
      if (self.wantX ~= self.dirX or self.wantY ~= self.dirY) and self:canGo(self.wantX, self.wantY) then
        self.dirX, self.dirY = self.wantX, self.wantY
      elseif not self:canGo(self.dirX, self.dirY) then
        self.dirX, self.dirY = 0, 0
      end
    end
  end
  self:rolled(player, x0, y0, ts, math.abs(player.pos.x - x0) + math.abs(player.pos.y - y0))
end

-- After moving him from (x0, y0) this frame, `rolledBy` along the ground:
-- turns the ball (right and down one way, left and up the other), and
-- sets his velocity.
function MazeInterior:rolled(player, x0, y0, ts, rolledBy)
  local dx, dy = player.pos.x - x0, player.pos.y - y0
  local sign = (self.dirX + self.dirY) >= 0 and 1 or -1
  player.ballRollAngle = (player.ballRollAngle + sign * rolledBy / player.radius) % (2 * math.pi)
  local t = math.max(ts, 1e-6)
  player.vel.x, player.vel.y = dx / t, dy / t
  player.prevPos = player.pos:clone()
end

-- He's rolled out of an edge opening: the face beyond it starts scrolling
-- in. Which face that is, and which way it's turned, is the cube rolling
-- over that edge: the face that was off to that side comes round to face
-- him, and the one he was on goes round to the other side.
function MazeInterior:startScroll(player)
  local n = self.face.n
  local right, down = self.viewRight, self.viewDown
  local newN
  if self.dirX == 1 then newN, right = right, neg3(n)
  elseif self.dirX == -1 then newN, right = neg3(right), n
  elseif self.dirY == 1 then newN, down = down, neg3(n)
  else newN, down = neg3(down), n end
  local nextName
  for _, name in ipairs(FACE_NAMES) do
    if dot3(self.faces[name].n, newN) > 0.5 then nextName = name end
  end
  local nextFace = self.faces[nextName]
  self.scroll = {
    t = 0,
    dirX = self.dirX, dirY = self.dirY,
    fromFace = self.face, fromM = self.m,
    toName = nextName, toRight = right, toDown = down, toM = turning(nextFace, right, down),
    -- Where he rolls from: this face's edge tile.
    fromX = player.pos.x, fromY = player.pos.y,
  }
end

-- Mid-turn (see turnedPoint): he rides the edge between the two faces as
-- it sweeps across, rolling from this face's edge tile onto the next
-- face's (each where it is on its face, turned and in perspective).
function MazeInterior:updateScroll(player, ts)
  local s = self.scroll
  local t0 = s.t
  s.t = math.min(1, s.t + ts / SCROLL_TICKS)
  local c, sn = self:turnCosSin()
  local fromAlong = turnedPoint(HALF - TILE / 2, c, sn, true)
  local toAlong = turnedPoint(-HALF + TILE / 2, c, sn, false)
  -- From the middle of the planet, along the way he's going.
  local along = fromAlong + (toAlong - fromAlong) * self:scrollAmount()
  local p = self.planetoid
  local x0, y0 = player.pos.x, player.pos.y
  if s.dirX ~= 0 then
    player.pos.x, player.pos.y = p.pos.x + s.dirX * along, s.fromY
  else
    player.pos.x, player.pos.y = s.fromX, p.pos.y + s.dirY * along
  end
  -- (The ball turns only with the tile he really rolls, not the slide.)
  self:rolled(player, x0, y0, ts, TILE * (s.t - t0))
  if s.t >= 1 then
    self:setView(s.toName, s.toRight, s.toDown)
    self.scroll = nil
    -- On the next face's edge tile, still rolling the same way.
    if s.dirX == 1 then self.col = 1 elseif s.dirX == -1 then self.col = N end
    if s.dirY == 1 then self.row = 1 elseif s.dirY == -1 then self.row = N end
    player.pos.x, player.pos.y = self:tileCenter(self.col, self.row)
    player.prevPos = player.pos:clone()
    self:arriveAt(player)
  end
end

-- How far the turn has gone (0 to 1), eased in and out.
function MazeInterior:scrollAmount()
  local t = self.scroll.t
  return t * t * (3 - 2 * t)
end

-- The cosine and sine of how far the cube has turned (a quarter turn in
-- all): also how squarely the face he's leaving, and the next one, face
-- the viewer.
function MazeInterior:turnCosSin()
  local a = math.pi / 2 * self:scrollAmount()
  return math.cos(a), math.sin(a)
end

-- While the cube turns, the planet's own (flat, square) body isn't drawn:
-- the turning cube is, sticking out past it at its nearest edge (see
-- main.lua's drawTerrain).
function MazeInterior:hidesPlanet()
  return self.scroll ~= nil
end

-- Reached the middle of a tile: picks up its dot, or leaves by the exit.
-- Returns true when he's left.
function MazeInterior:arriveAt(player)
  local face = self.face
  local fc, fr = self:faceTile(self.col, self.row)
  if face.name == self.exitFace and fc == self.exitCol and fr == self.exitRow then
    self:exitBall(player)
    return true
  end
  local kind = face.dots[fr][fc]
  if kind then
    face.dots[fr][fc] = nil
    self.dotsLeft = self.dotsLeft - 1
    local points = kind == "big" and BIG_DOT_POINTS or DOT_POINTS
    self:score(points, player.pos.x, player.pos.y, kind == "big")
    if state.audioManager then state.audioManager:playEatDot() end
    if self.dotsLeft == 0 then
      self:score(CLEAR_BONUS, player.pos.x, player.pos.y - TILE, true)
      self:resetDots()
      -- (Not the one he's on.)
      if face.dots[fr][fc] then face.dots[fr][fc] = nil; self.dotsLeft = self.dotsLeft - 1 end
    end
  end
  return false
end

-- Adds to the HUD's score; `shown` puts up a little "+points".
function MazeInterior:score(points, x, y, shown)
  state.score = (state.score or 0) + points
  if shown then
    self.popups[#self.popups + 1] = { text = "+" .. points, x = x, y = y, ticks = POPUP_TICKS }
  end
end

function MazeInterior:updatePopups(ts)
  for i = #self.popups, 1, -1 do
    local p = self.popups[i]
    p.ticks = p.ticks - ts
    if p.ticks <= 0 then table.remove(self.popups, i) end
  end
end

----------------------------------------------------------------------
-- Drawing (on the planet's face, every frame it's on screen)
----------------------------------------------------------------------

-- One face, turned as m says (see turning), its middle at (cx, cy).
function MazeInterior:drawFace(face, m, cx, cy, t)
  love.graphics.push()
  love.graphics.translate(cx, cy)
  love.graphics.rotate(math.atan2(m.yx, m.xx))
  love.graphics.setColor(COLOR_FLOOR)
  love.graphics.rectangle("fill", -FACE_WIDTH / 2, -FACE_WIDTH / 2, FACE_WIDTH, FACE_WIDTH)
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(face.mesh)

  love.graphics.setColor(COLOR_DOT)
  local bigR = BIG_DOT_RADIUS * (0.85 + 0.15 * math.sin(t * 6))
  for row = 1, N do
    for col = 1, N do
      local kind = face.dots[row][col]
      if kind then
        love.graphics.circle("fill", (col - MID) * TILE, (row - MID) * TILE, kind == "big" and bigR or DOT_RADIUS)
      end
    end
  end

  -- The exit: a pulsing ring with a swirl of light inside.
  if face.name == self.exitFace then
    local ex, ey = (self.exitCol - MID) * TILE, (self.exitRow - MID) * TILE
    local pulse = (math.sin(t * 4) + 1) / 2
    love.graphics.setColor(COLOR_EXIT[1], COLOR_EXIT[2], COLOR_EXIT[3], 0.25 + 0.2 * pulse)
    love.graphics.circle("fill", ex, ey, EXIT_RADIUS + 10 + pulse * 6)
    love.graphics.setColor(COLOR_EXIT[1], COLOR_EXIT[2], COLOR_EXIT[3], 0.9)
    love.graphics.setLineWidth(4)
    love.graphics.circle("line", ex, ey, EXIT_RADIUS + pulse * 4)
    for k = 0, 2 do
      local a = t * 3 + k * 2 * math.pi / 3
      love.graphics.arc("line", "open", ex, ey, EXIT_RADIUS * 0.6, a, a + 1.2)
    end
    love.graphics.setLineWidth(1)
  end
  love.graphics.pop()
end

-- The two faces of a turn, drawn into pictures once (at its start), for
-- drawing bent into perspective (see drawTurningFace). Two canvases, made
-- the first time and kept.
local turnCanvases = nil
function MazeInterior:paintTurnFaces(t)
  local s = self.scroll
  if not turnCanvases then
    turnCanvases = { love.graphics.newCanvas(FACE_WIDTH, FACE_WIDTH), love.graphics.newCanvas(FACE_WIDTH, FACE_WIDTH) }
    for _, c in ipairs(turnCanvases) do c:setFilter("linear", "linear") end
  end
  love.graphics.push("all")
  love.graphics.origin()
  for i, f in ipairs({ { s.fromFace, s.fromM }, { self.faces[s.toName], s.toM } }) do
    love.graphics.setCanvas(turnCanvases[i])
    love.graphics.clear(0, 0, 0, 0)
    self:drawFace(f[1], f[2], HALF, HALF, t)
  end
  love.graphics.pop()
  s.painted = true
end

-- One face mid-turn (see turnedPoint), as a strip of TURN_STRIPS slices
-- across the way he's going, each bent into place: narrower and further
-- off at the far side, nearer and bigger at the near edge, and darkened as
-- far as it's turned away. `leaving`: the face he's leaving (else the
-- next one).
local turnMeshes, turnVertices = {}, {}
function MazeInterior:drawTurningFace(index, leaving, c, sn)
  local s, p = self.scroll, self.planetoid
  local dir = s.dirX ~= 0 and s.dirX or s.dirY
  local facing = leaving and c or sn
  local b = 1 - (1 - facing) * TURN_SHADE
  local verts = turnVertices[index] or {}
  turnVertices[index] = verts
  for i = 0, TURN_STRIPS do
    local a = -HALF + FACE_WIDTH * i / TURN_STRIPS
    local along, k = turnedPoint(a, c, sn, leaving)
    -- Where that slice is in the face's picture, the way he's going.
    local tex = (dir * a + HALF) / FACE_WIDTH
    local v1, v2 = verts[2 * i + 1] or {}, verts[2 * i + 2] or {}
    verts[2 * i + 1], verts[2 * i + 2] = v1, v2
    if s.dirX ~= 0 then
      local x = p.pos.x + dir * along
      v1[1], v1[2], v1[3], v1[4] = x, p.pos.y - HALF * k, tex, 0
      v2[1], v2[2], v2[3], v2[4] = x, p.pos.y + HALF * k, tex, 1
    else
      local y = p.pos.y + dir * along
      v1[1], v1[2], v1[3], v1[4] = p.pos.x - HALF * k, y, 0, tex
      v2[1], v2[2], v2[3], v2[4] = p.pos.x + HALF * k, y, 1, tex
    end
    v1[5], v1[6], v1[7], v1[8] = b, b, b, 1
    v2[5], v2[6], v2[7], v2[8] = b, b, b, 1
  end
  local mesh = turnMeshes[index]
  if not mesh then
    mesh = love.graphics.newMesh(#verts, "strip", "stream")
    turnMeshes[index] = mesh
  end
  mesh:setVertices(verts)
  mesh:setTexture(turnCanvases[index])
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(mesh)
end

-- The cube's near edge mid-turn (where the two faces meet): a faint line
-- of light along it, brightest halfway through.
function MazeInterior:drawTurnEdge(c, sn)
  local s, p = self.scroll, self.planetoid
  local along, k = turnedPoint(HALF, c, sn, true)
  local glow = TURN_EDGE_LIGHT * 2 * c * sn -- (sin of twice the angle: 0 at the ends, 1 halfway)
  if glow < 0.01 then return end
  love.graphics.setColor(COLOR_WALL_EDGE[1], COLOR_WALL_EDGE[2], COLOR_WALL_EDGE[3], glow)
  love.graphics.setLineWidth(3)
  if s.dirX ~= 0 then
    local x = p.pos.x + s.dirX * along
    love.graphics.line(x, p.pos.y - HALF * k, x, p.pos.y + HALF * k)
  else
    local y = p.pos.y + s.dirY * along
    love.graphics.line(p.pos.x - HALF * k, y, p.pos.x + HALF * k, y)
  end
  love.graphics.setLineWidth(1)
end

function MazeInterior:draw()
  local p = self.planetoid
  local t = love.timer.getTime()
  local s = self.scroll
  if s then
    -- The cube mid-turn: the face he's leaving turning away, the next one
    -- coming round (see turnedPoint), in place of the planet's own body.
    if not s.painted then self:paintTurnFaces(t) end
    local c, sn = self:turnCosSin()
    self:drawTurningFace(1, true, c, sn)
    self:drawTurningFace(2, false, c, sn)
    self:drawTurnEdge(c, sn)
  else
    -- The planet's whole face in the walls' blue first: its own body is
    -- shaded by the sun (nearly black on the side away from it), and the
    -- border round the maze should match the walls instead.
    love.graphics.setColor(COLOR_WALL)
    love.graphics.rectangle("fill", p.pos.x - p.halfWidth, p.pos.y - p.halfHeight,
      p.halfWidth * 2, p.halfHeight * 2, p.cornerRadius, p.cornerRadius)
    self:drawFace(self.face, self.m, p.pos.x, p.pos.y, t)
  end

  for _, pop in ipairs(self.popups) do
    local fade = math.min(1, pop.ticks / (POPUP_TICKS * 0.4))
    love.graphics.setColor(1, 1, 0.6, fade)
    love.graphics.print(pop.text, pop.x - 12, pop.y - 30 - (POPUP_TICKS - pop.ticks) * 0.6)
  end
  love.graphics.setColor(1, 1, 1, 1)
end

return MazeInterior
