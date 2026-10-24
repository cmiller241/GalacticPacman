-- lua/ui/Minimap.lua
--
-- Screen-space overview of the world round the player: a window
-- VIEW_CELLS cells across, always centred on him (so he's always in its
-- middle, and it scrolls under him as he goes) — not the whole world,
-- which is far too big to show at once (see worldGen.GRID_SIZE). The
-- grid lines are the world's own cell boundaries, scrolling with it;
-- anything outside the window's simply cut off at its frame.
-- Belt marker is a static thick circular annulus around the sun,
-- not a box and not live planetoid positions.

local state = require("lua.state")

local Minimap = {}
Minimap.__index = Minimap

function Minimap.new()
  local self = setmetatable({}, Minimap)

  self.size = 240
  self.sizeFraction = 0.20
  self.margin = 20

  self.backgroundColor = { 6/255, 14/255, 24/255, 0.72 }
  self.gridColor       = { 80/255, 200/255, 255/255, 0.18 }
  self.borderColor     = { 100/255, 220/255, 255/255, 0.85 }
  self.cornerColor     = { 140/255, 230/255, 255/255, 1 }
  self.labelColor      = { 150/255, 230/255, 255/255, 0.85 }

  self.playerColor     = { 1, 1, 1, 1 }
  self.playerGlowColor = { 1, 1, 1, 0.35 }
  self.playerRadius    = 5

  self.specialColor     = { 1, 210/255, 63/255, 1 }
  self.specialGlowColor = { 1, 210/255, 63/255, 0.5 }
  self.specialRadius    = 3

  -- Cannon planets, and the routes between them — each cannon's route
  -- in the next of these colours.
  self.cannonColor     = { 0.45, 0.9, 1, 1 }
  self.cannonGlowColor = { 0.45, 0.9, 1, 0.45 }
  self.cannonRouteColors = {
    { 1, 0.6, 0.9, 0.5 },
    { 0.55, 1, 0.6, 0.5 },
    { 1, 0.85, 0.4, 0.5 },
  }

  self.sunColor     = { 1, 0.75, 0.2, 1 }
  self.sunGlowColor = { 1, 0.55, 0.1, 0.45 }

  self.beltDotColor = { 1, 77/255, 77/255, 0.78 }
  self.beltDotCount = 600
  self._beltDots = nil

  self.edgeColor = { 100/255, 220/255, 255/255, 0.5 } -- the world's own outer edge, when it's in view

  -- How many cells across the window shows, centred on the player.
  self.viewCells = 10
  -- (Set each draw: the window's top-left corner in the world, and how
  -- many world units it spans — see worldToMapPoint.)
  self.viewX, self.viewY, self.viewSpan = 0, 0, 1

  return self
end

function Minimap:refreshSize()
  local w = love.graphics.getWidth()
  self.size = math.max(120, math.floor(w * (self.sizeFraction or 0.25)))
end

function Minimap:getSpecialPlanets()
  local list = {}
  if state.mazePlanet then table.insert(list, state.mazePlanet) end
  if state.platformPlanet then table.insert(list, state.platformPlanet) end
  if state.skyDomePlanet then table.insert(list, state.skyDomePlanet) end
  if state.waterPlanet then table.insert(list, state.waterPlanet) end
  if state.waterPlanet2 then table.insert(list, state.waterPlanet2) end
  return list
end

-- Where a world point lands on the minimap, within the window round the
-- player (see draw) — which may be off the minimap altogether, if it's
-- outside the window.
function Minimap:worldToMapPoint(worldX, worldY, x0, y0)
  return {
    x = x0 + (worldX - self.viewX) / self.viewSpan * self.size,
    y = y0 + (worldY - self.viewY) / self.viewSpan * self.size,
  }
end

-- A world distance, in minimap pixels.
function Minimap:worldToMapLength(worldLength)
  return worldLength / self.viewSpan * self.size
end

function Minimap:drawGlowDot(x, y, radius, color, glowColor)
  love.graphics.setColor(glowColor)
  love.graphics.circle("fill", x, y, radius * 2.2)
  love.graphics.setColor(color)
  love.graphics.circle("fill", x, y, radius)
end

function Minimap:ensureBeltDots()
  if self._beltDots then return end

  local worldGen = require("lua.setup.WorldGen")
  local cellSize = worldGen.CELL_SIZE or 3000
  local rMin = (worldGen.BELT_INNER_CELLS or 2) * cellSize
  local rMax = (worldGen.BELT_OUTER_CELLS or 3) * cellSize
  local sunX, sunY = worldGen.sunPos()

  local dots = {}
  local rng = love.math.newRandomGenerator(20260821)
  local n = self.beltDotCount or 220

  for _ = 1, n do
    local ang = rng:random() * math.pi * 2
    -- Uniform in annulus area: r = sqrt(u * (R2^2 - R1^2) + R1^2)
    local u = rng:random()
    local r = math.sqrt(u * (rMax * rMax - rMin * rMin) + rMin * rMin)
    table.insert(dots, {
      x = sunX + math.cos(ang) * r,
      y = sunY + math.sin(ang) * r,
    })
  end

  self._beltDots = dots
end

function Minimap:draw()
  self:refreshSize()
  self:ensureBeltDots()

  local winW = love.graphics.getWidth()
  local winH = love.graphics.getHeight()
  local x0 = winW - self.size - self.margin
  local y0 = winH - self.size - self.margin

  -- The window: viewCells cells across, centred on the player.
  local worldGen = require("lua.setup.WorldGen")
  local cellSize = worldGen.CELL_SIZE or 3000
  self.viewSpan = cellSize * self.viewCells
  local cx, cy = (state.sceneWidth or 0) / 2, (state.sceneHeight or 0) / 2
  if state.player and state.player.pos then cx, cy = state.player.pos.x, state.player.pos.y end
  self.viewX, self.viewY = cx - self.viewSpan / 2, cy - self.viewSpan / 2

  love.graphics.setColor(self.backgroundColor)
  love.graphics.rectangle("fill", x0, y0, self.size, self.size)

  -- Everything in the world is cut off at the minimap's own frame.
  love.graphics.push("all")
  love.graphics.setScissor(x0, y0, self.size, self.size)

  -- The world's own cell boundaries, scrolling with it.
  love.graphics.setColor(self.gridColor)
  love.graphics.setLineWidth(1)
  for col = math.ceil(self.viewX / cellSize), math.floor((self.viewX + self.viewSpan) / cellSize) do
    local m = self:worldToMapPoint(col * cellSize, 0, x0, y0)
    love.graphics.line(m.x, y0, m.x, y0 + self.size)
  end
  for row = math.ceil(self.viewY / cellSize), math.floor((self.viewY + self.viewSpan) / cellSize) do
    local m = self:worldToMapPoint(0, row * cellSize, x0, y0)
    love.graphics.line(x0, m.y, x0 + self.size, m.y)
  end

  -- The world's outer edge, if he's near enough for it to be in view.
  if state.sceneWidth and state.sceneWidth > 0 then
    local a = self:worldToMapPoint(0, 0, x0, y0)
    local b = self:worldToMapPoint(state.sceneWidth, state.sceneHeight, x0, y0)
    love.graphics.setColor(self.edgeColor)
    love.graphics.setLineWidth(2)
    love.graphics.rectangle("line", a.x, a.y, b.x - a.x, b.y - a.y)
  end

  love.graphics.setColor(self.beltDotColor)
  for _, d in ipairs(self._beltDots) do
    local m = self:worldToMapPoint(d.x, d.y, x0, y0)
    love.graphics.circle("fill", m.x, m.y, 1.15)
  end

  if state.sun and state.sun.pos then
    local sunMap = self:worldToMapPoint(state.sun.pos.x, state.sun.pos.y, x0, y0)
    local sunR = 6
    if state.sun.radius then
      sunR = math.max(4, self:worldToMapLength(state.sun.radius))
      sunR = math.min(sunR, self.size * 0.08)
    end
    self:drawGlowDot(sunMap.x, sunMap.y, sunR, self.sunColor, self.sunGlowColor)
  end

  for _, planet in ipairs(self:getSpecialPlanets()) do
    if planet and planet.pos then
      local p = self:worldToMapPoint(planet.pos.x, planet.pos.y, x0, y0)
      self:drawGlowDot(p.x, p.y, self.specialRadius, self.specialColor, self.specialGlowColor)
    end
  end

  -- Every cannon's route (see lua/world/Cannon.lua): a faint dashed line
  -- in its own colour, bending at each of its corners, with its loops as
  -- little rings and its bumpers as little red dots — and every cannon's
  -- own planet as a dot.
  for n, cannon in ipairs(state.cannons or {}) do
    local route = cannon.points
    love.graphics.setColor(self.cannonRouteColors[(n - 1) % #self.cannonRouteColors + 1])
    love.graphics.setLineWidth(1)
    local dash = 4
    -- (A closed track's last corner joins back up with its first.)
    for i = 1, cannon.closed and #route or #route - 1 do
      local nextPoint = route[i % #route + 1]
      local p = self:worldToMapPoint(route[i][1], route[i][2], x0, y0)
      local q = self:worldToMapPoint(nextPoint[1], nextPoint[2], x0, y0)
      local dx, dy = q.x - p.x, q.y - p.y
      local len = math.sqrt(dx * dx + dy * dy)
      if len > 0 then
        for d = 0, len - dash, dash * 2 do
          love.graphics.line(p.x + dx / len * d, p.y + dy / len * d,
            p.x + dx / len * (d + dash), p.y + dy / len * (d + dash))
        end
      end
    end
    for _, rail in ipairs(cannon.rails) do
      if (rail.loops or 0) > 0 then
        local c = self:worldToMapPoint(rail.cx, rail.cy, x0, y0)
        local r = math.max(2.5, self:worldToMapLength(rail.radius))
        love.graphics.setColor(self.cannonColor)
        love.graphics.circle("line", c.x, c.y, r)
      end
    end
    for _, b in ipairs(cannon.bumpers) do
      local m = self:worldToMapPoint(b.x, b.y, x0, y0)
      love.graphics.setColor(1, 0.3, 0.35, 1)
      love.graphics.circle("fill", m.x, m.y, 2)
    end
  end
  for _, cannon in ipairs(state.cannons or {}) do
    if cannon.planet then
      local a = self:worldToMapPoint(cannon.planet.pos.x, cannon.planet.pos.y, x0, y0)
      self:drawGlowDot(a.x, a.y, self.specialRadius, self.cannonColor, self.cannonGlowColor)
    end
  end

  if state.player and state.player.pos then
    local playerMap = self:worldToMapPoint(state.player.pos.x, state.player.pos.y, x0, y0)
    self:drawGlowDot(playerMap.x, playerMap.y, self.playerRadius, self.playerColor, self.playerGlowColor)
  end

  love.graphics.pop()

  love.graphics.setColor(self.borderColor)
  love.graphics.setLineWidth(1.5)
  love.graphics.rectangle("line", x0, y0, self.size, self.size)

  local bracket = math.min(20, self.size * 0.12)
  love.graphics.setColor(self.cornerColor)
  love.graphics.setLineWidth(2)

  local corners = {
    { x0, y0, 1, 1 },
    { x0 + self.size, y0, -1, 1 },
    { x0, y0 + self.size, 1, -1 },
    { x0 + self.size, y0 + self.size, -1, -1 },
  }
  for _, c in ipairs(corners) do
    local cx, cy, dx, dy = c[1], c[2], c[3], c[4]
    love.graphics.line(cx, cy + bracket * dy, cx, cy)
    love.graphics.line(cx, cy, cx + bracket * dx, cy)
  end

  love.graphics.setColor(self.labelColor)
  love.graphics.print("SECTOR MAP", x0 + 8, y0 - 18)

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.setLineWidth(1)
end

return Minimap