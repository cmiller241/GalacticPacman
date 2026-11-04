-- lua/ui/WeaponBar.lua
--
-- The blaster selector in the lower-left: one white-outlined rounded box
-- per mode (see lua/systems/WeaponModes.lua), side by side, each with its
-- own icon. The mode in use is drawn bigger and fully bright; the others
-- are smaller and dimmed. Boxes grow and shrink smoothly on a switch.
--
-- Icons are drawn with shapes, not images, in a 100x100 box centered on
-- (0, 0), then scaled to the box's size on screen. Colors match each
-- weapon's own effects in the game.

local state = require("lua.state")
local WeaponModes = require("lua.systems.WeaponModes")

local WeaponBar = {}

local MARGIN = 20          -- from the screen's left and bottom edges
local BOX_SIZE = 100        -- unselected box, in screen pixels
local SELECTED_SCALE = 1.3 -- the mode in use is this much bigger
local GAP = 8              -- between boxes
local CORNER = 0.2         -- corner radius, as a fraction of box size
local EASE = 0.25          -- how quickly boxes grow/shrink each frame
local DIM = 0.5            -- brightness of unselected boxes and icons

local scales = {} -- current animated scale per mode

-- Icons are dimmed by darkening their colors, not by fading them:
-- fading would let their overlapping layers show through each other.
local dim = 1
local function col(r, g, b, a)
  love.graphics.setColor(r * dim, g * dim, b * dim, a or 1)
end

-- ---------------------------------------------------------------------
-- Icons. Each draws into a 100x100 box centered on (0, 0), using col()
-- for its colors.
-- ---------------------------------------------------------------------
local function teardrop(tipX, tipY, cx, cy, r)
  -- A circle plus the triangle from `tip` to the circle's two tangent
  -- points: a flame or comet shape.
  local dx, dy = cx - tipX, cy - tipY
  local d = math.sqrt(dx * dx + dy * dy)
  local ux, uy = dx / d, dy / d
  local alpha = math.acos(r / d)
  local base = math.atan2(-uy, -ux) -- from the center back toward the tip
  local p1x, p1y = cx + math.cos(base + alpha) * r, cy + math.sin(base + alpha) * r
  local p2x, p2y = cx + math.cos(base - alpha) * r, cy + math.sin(base - alpha) * r
  love.graphics.polygon("fill", tipX, tipY, p1x, p1y, p2x, p2y)
  love.graphics.circle("fill", cx, cy, r, 40)
end

local ICONS = {}

-- A fireball streaking down-right, with a hot core.
function ICONS.fireball()
  col(1.0, 0.32, 0.08)
  teardrop(-32, -32, 8, 8, 21)
  col(1.0, 0.62, 0.15)
  teardrop(-18, -18, 10, 10, 14)
  col(1.0, 0.92, 0.55)
  love.graphics.circle("fill", 12, 12, 7, 24)
end

-- A horseshoe magnet pulling a small rock toward it.
function ICONS.pullbeam()
  local cy, r = 14, 17
  love.graphics.setLineWidth(12)
  love.graphics.setLineStyle("smooth")
  col(0.47, 0.82, 1.0)
  love.graphics.arc("line", "open", 0, cy, r, 0, math.pi, 32)
  love.graphics.line(-r, cy, -r, -4)
  love.graphics.line(r, cy, r, -4)
  -- Bright pole tips.
  col(0.84, 0.96, 1.0)
  love.graphics.rectangle("fill", -r - 6, -14, 12, 10)
  love.graphics.rectangle("fill", r - 6, -14, 12, 10)
  -- The rock above, and motion lines toward the magnet.
  col(0.75, 0.72, 0.68)
  love.graphics.circle("fill", 0, -32, 8, 20)
  col(0.84, 0.96, 1.0, 0.8)
  love.graphics.setLineWidth(3)
  love.graphics.line(-6, -20, -6, -13)
  love.graphics.line(6, -20, 6, -13)
end

-- A water drop with a shine.
function ICONS.water()
  col(0.30, 0.66, 1.0)
  teardrop(0, -34, 0, 8, 22)
  col(0.85, 0.95, 1.0)
  love.graphics.ellipse("fill", -9, 6, 4, 8, 16)
end

-- A six-armed snowflake.
function ICONS.ice()
  love.graphics.setLineStyle("smooth")
  col(0.78, 0.93, 1.0)
  local arm, branchAt, branchLen = 32, 18, 10
  for i = 0, 5 do
    local ang = i * math.pi / 3 - math.pi / 2
    local cx, cy = math.cos(ang), math.sin(ang)
    love.graphics.setLineWidth(6)
    love.graphics.line(0, 0, cx * arm, cy * arm)
    love.graphics.setLineWidth(4)
    local bx, by = cx * branchAt, cy * branchAt
    for _, side in ipairs({ -1, 1 }) do
      local bang = ang + side * 0.8
      love.graphics.line(bx, by, bx + math.cos(bang) * branchLen, by + math.sin(bang) * branchLen)
    end
  end
  col(0.92, 0.99, 1.0)
  love.graphics.circle("fill", 0, 0, 6, 6)
end

-- A red portal and a blue portal side by side.
function ICONS.portal()
  local function ring(x, core, glow)
    col(glow[1], glow[2], glow[3], 0.3)
    love.graphics.ellipse("fill", x, 0, 11, 28, 32)
    col(core[1], core[2], core[3])
    love.graphics.setLineWidth(6)
    love.graphics.ellipse("line", x, 0, 11, 28, 32)
  end
  ring(-14, { 1.0, 0.30, 0.22 }, { 1.0, 0.45, 0.25 })
  ring(14, { 0.20, 0.55, 1.0 }, { 0.35, 0.70, 1.0 })
end

-- A rewind arrow running counterclockwise round a clock face.
function ICONS.recall()
  local r = 26
  local a0, a1 = -math.pi * 0.30, math.pi * 1.20 -- arrow tip at a0
  col(1.0, 0.86, 0.25)
  love.graphics.setLineWidth(7)
  love.graphics.setLineStyle("smooth")
  love.graphics.arc("line", "open", 0, 0, r, a0, a1, 40)
  -- Arrowhead on the arc's end, pointing counterclockwise (decreasing
  -- angle on screen).
  local px, py = math.cos(a0) * r, math.sin(a0) * r
  local tx, ty = math.sin(a0), -math.cos(a0)  -- counterclockwise tangent
  local rx, ry = math.cos(a0), math.sin(a0)   -- outward
  love.graphics.polygon("fill",
    px + tx * 14, py + ty * 14,
    px + rx * 11, py + ry * 11,
    px - rx * 11, py - ry * 11)
  -- Clock hands.
  love.graphics.setLineWidth(5)
  love.graphics.line(0, 0, 0, -14)
  love.graphics.line(0, 0, 10, 5)
  love.graphics.circle("fill", 0, 0, 4, 12)
end

-- ---------------------------------------------------------------------
-- Drawing
-- ---------------------------------------------------------------------
function WeaponBar.draw()
  local current = state.weaponMode or "fireball"
  local screenH = love.graphics.getHeight()
  local bottom = screenH - MARGIN
  local x = MARGIN

  love.graphics.push("all")
  for _, mode in ipairs(WeaponModes.ORDER) do
    local selected = mode == current
    local target = selected and SELECTED_SCALE or 1
    local s = scales[mode] or target
    s = s + (target - s) * EASE
    if math.abs(target - s) < 0.002 then s = target end
    scales[mode] = s

    -- How far along this box is toward "selected", 0..1, for brightness.
    local t = (s - 1) / (SELECTED_SCALE - 1)
    dim = DIM + (1 - DIM) * t
    local size = BOX_SIZE * s
    local y = bottom - size
    local corner = size * CORNER

    -- Box: dark backing, white outline.
    love.graphics.setColor(0, 0, 0, 0.45 + 0.15 * t)
    love.graphics.rectangle("fill", x, y, size, size, corner, corner)
    col(1, 1, 1)
    love.graphics.setLineWidth(2 + t)
    love.graphics.setLineStyle("smooth")
    love.graphics.rectangle("line", x, y, size, size, corner, corner)

    -- Icon, scaled from its 100x100 design box to fit inside with padding.
    love.graphics.push()
    love.graphics.translate(x + size / 2, y + size / 2)
    local k = size / 100 * 0.82
    love.graphics.scale(k, k)
    ICONS[mode]()
    love.graphics.pop()

    x = x + size + GAP
  end
  love.graphics.pop()
end

return WeaponBar
