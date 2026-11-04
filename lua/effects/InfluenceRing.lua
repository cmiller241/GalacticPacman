-- lua/effects/InfluenceRing.lua
--
-- Port of js/world/Planetoid.js's dashed influence-radius ring (see that
-- file's own ringCanvas/createRingCanvas) — a visual debug aid showing
-- how far a planetoid's gravity actually reaches, toggled with 'R' (see
-- InputHandlers.lua).
--
-- Each ring's dashes are built once into a mesh (short chords round the
-- circle, LINE_WIDTH thick) and drawn in one call, turned by the march
-- angle. Drawing every dash as its own line cost several milliseconds a
-- frame in the busy belt.

local InfluenceRing = {}

local DASH_LENGTH = 10
local GAP_LENGTH = 5
local LINE_WIDTH = 3
local COLOR = { 173 / 255, 216 / 255, 230 / 255 }
-- Marching ants: how fast the dashes travel round the ring (world units
-- per second, along the line — so big and small rings march at the same
-- visible pace). Positive goes clockwise on screen; 0 stands still.
local MARCH_SPEED = 20

-- Meshes by radius (to the nearest quarter unit). Belt planetoids come
-- and go with their own radii, so the cache is emptied once it's big.
local MAX_CACHED = 400
local meshes, cachedCount = {}, 0

local function ringMesh(radius, segmentCount, angleStep, dashAngle)
  local key = math.floor(radius * 4 + 0.5)
  local mesh = meshes[key]
  if mesh then return mesh end
  if cachedCount >= MAX_CACHED then
    for _, m in pairs(meshes) do m:release() end
    meshes, cachedCount = {}, 0
  end
  local half = LINE_WIDTH / 2
  local verts = {}
  for i = 0, segmentCount - 1 do
    local a0 = i * angleStep
    local a1 = a0 + dashAngle
    local x0, y0 = math.cos(a0) * radius, math.sin(a0) * radius
    local x1, y1 = math.cos(a1) * radius, math.sin(a1) * radius
    local dx, dy = x1 - x0, y1 - y0
    local len = math.sqrt(dx * dx + dy * dy)
    local nx, ny = -dy / len * half, dx / len * half
    local n = #verts
    verts[n + 1] = { x0 + nx, y0 + ny }
    verts[n + 2] = { x1 + nx, y1 + ny }
    verts[n + 3] = { x1 - nx, y1 - ny }
    verts[n + 4] = { x0 + nx, y0 + ny }
    verts[n + 5] = { x1 - nx, y1 - ny }
    verts[n + 6] = { x0 - nx, y0 - ny }
  end
  mesh = love.graphics.newMesh(verts, "triangles", "static")
  meshes[key] = mesh
  cachedCount = cachedCount + 1
  return mesh
end

-- alpha: how strongly to draw it — decided by the caller (see the ring
-- pass in main.lua's love.draw) from how much this body's gravity
-- matters to the player right now, rather than drawing every ring on
-- screen at full strength.
function InfluenceRing.draw(x, y, radius, alpha)
  if radius <= 0 or alpha <= 0 then return end

  local period = DASH_LENGTH + GAP_LENGTH
  local circumference = 2 * math.pi * radius
  -- Whole number of dash+gap periods around the circle, so the pattern
  -- joins up cleanly instead of leaving one oddly-sized dash where it
  -- wraps back to the start.
  local segmentCount = math.max(1, math.floor(circumference / period))
  local angleStep = (2 * math.pi) / segmentCount
  local dashAngle = angleStep * (DASH_LENGTH / period)
  -- How far the pattern has marched round by now (one period's worth of
  -- travel moves it on by exactly one dash+gap, so it loops seamlessly).
  local march = ((love.timer.getTime() * MARCH_SPEED) % period) / period * angleStep

  love.graphics.setColor(COLOR[1], COLOR[2], COLOR[3], alpha)
  love.graphics.draw(ringMesh(radius, segmentCount, angleStep, dashAngle), x, y, march)
  love.graphics.setColor(1, 1, 1, 1)
end

return InfluenceRing
