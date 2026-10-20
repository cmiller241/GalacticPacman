-- lua/world/Mirror.lua
--
-- A freestanding mirror pane: a framed rectangle that pivots in place
-- around its own center, cranked by whichever Crank object(s) in
-- Tiled name it via their own "Mirror" custom property (see
-- Crank.lua/TiledTerrain.lua's crankSpawns and main.lua's own spawn
-- wiring). Angle convention, both in Tiled's "Angle" custom property
-- and here, is plain degrees/radians in this engine's own
-- love.graphics.rotate sense (clockwise, since y grows downward): 0 =
-- horizontal, 90 = vertical.
--
-- Point-placement, same convention as Sphere/Spikey — the object's own
-- x/y IS the mirror's own pivot, no raycasting onto terrain below it
-- (a mirror can just as easily hang in open space as sit on the
-- ground).

local state = require("lua.state")
local Vector2 = require("lua.vector2")

local Mirror = {}
Mirror.__index = Mirror

local MIRROR_LENGTH = 90
local MIRROR_THICKNESS = 10
local SWING_SPEED = 0.12 -- radians per baseline (60fps) tick

local FRAME_INSET = 2.5        -- how much frame shows round the glass
local CAP_LENGTH = 7           -- the brass caps on each end
local HUB_RADIUS = 6.5         -- the pivot hub in the middle

local COLOR_OUTLINE = { 0.07, 0.07, 0.09 }
local COLOR_FRAME_LIGHT = { 0.62, 0.64, 0.68 }  -- the frame, lit along its top...
local COLOR_FRAME_DARK = { 0.24, 0.25, 0.28 }   -- ...and shadowed along its bottom
local COLOR_CAP = { 0.78, 0.6, 0.28 }           -- brass
local COLOR_CAP_LIGHT = { 1.0, 0.88, 0.55 }

local GLINT_PERIOD = 3.2       -- seconds between glints sweeping along the glass
local GLINT_SECONDS = 0.7      -- how long one takes to cross

-- The glass: silvered, reflecting a sky — paler toward whichever of its
-- faces is turned up, so cranking it round visibly shifts its
-- reflection — with faint diagonal streaks fixed in it, a bright
-- highlight just inside its top edge, and a glint sweeping along it now
-- and then.
--
-- uv.x runs along the glass, uv.y across it.
local glassShader = nil
local function getGlassShader()
  if glassShader then return glassShader end
  glassShader = love.graphics.newShader([[
    extern number len;        // world units
    extern number thick;      // world units
    extern number upness;     // -1..1: how far its top face is turned to point up
    extern number glintAt;    // world units along it, or far off it when there's none

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      float s = uv.x * len;
      float v = uv.y * 2.0 - 1.0;   // -1 (top face) .. 1

      // The sky it reflects: bright toward whichever way faces up.
      float sky = 0.5 - 0.5 * v * upness;
      vec3 c = mix(vec3(0.32, 0.46, 0.62), vec3(0.86, 0.94, 1.0), sky);
      c = mix(c, vec3(0.6, 0.72, 0.84), 0.25);

      // Streaks fixed in the glass, on the diagonal.
      float diag = s + v * thick * 0.9;
      float streak = smoothstep(0.75, 1.0, sin(diag * 0.16)) * 0.18
                   + smoothstep(0.9, 1.0, sin(diag * 0.37 + 1.3)) * 0.1;
      c += vec3(streak);

      // The bright line just inside the top edge, and darker at the bottom.
      c += vec3(0.5) * exp(-pow((v + 0.62) / 0.12, 2.0));
      c *= mix(1.0, 0.72, smoothstep(0.2, 1.0, v));

      // The sweeping glint, slanted like the streaks.
      float g = exp(-pow((diag - glintAt) / 3.5, 2.0));
      c += vec3(1.0, 0.98, 0.9) * g * 0.9;

      return vec4(c, 1.0) * color;
    }
  ]])
  return glassShader
end

local pixelImage = nil
local function getPixel()
  if pixelImage then return pixelImage end
  local data = love.image.newImageData(1, 1)
  data:setPixel(0, 0, 1, 1, 1, 1)
  pixelImage = love.graphics.newImage(data)
  return pixelImage
end

-- The frame's face: lit along the top, shadowed along the bottom.
local frameMesh = nil
local function getFrameMesh()
  if frameMesh then return frameMesh end
  local hl, ht = MIRROR_LENGTH / 2, MIRROR_THICKNESS / 2
  local l, d = COLOR_FRAME_LIGHT, COLOR_FRAME_DARK
  frameMesh = love.graphics.newMesh({
    { -hl, -ht, 0, 0, l[1], l[2], l[3], 1 },
    {  hl, -ht, 0, 0, l[1], l[2], l[3], 1 },
    {  hl,  ht, 0, 0, d[1], d[2], d[3], 1 },
    { -hl,  ht, 0, 0, d[1], d[2], d[3], 1 },
  }, "fan", "static")
  return frameMesh
end

-- x, y: world position of the mirror's own pivot. angleDegrees: its
-- starting angle (Tiled's own "Angle" custom property) — 0 =
-- horizontal, 90 = vertical.
function Mirror.new(x, y, angleDegrees)
  local self = setmetatable({}, Mirror)

  self.pos = Vector2.new(x, y)
  local angle = math.rad(angleDegrees or 0)
  self.angle = angle
  self.targetAngle = angle

  -- Exposed so CollisionSystem:handleFireballMirrorCollisions can test
  -- against this mirror's own rotated extent without reaching into
  -- this file's local constants.
  self.halfLength = MIRROR_LENGTH / 2
  self.halfThickness = MIRROR_THICKNESS / 2

  -- So neighbouring mirrors don't glint in step.
  self.glintOffset = math.random() * GLINT_PERIOD

  return self
end

-- Called by Crank.lua on each interact press — bumps the mirror's
-- target angle by stepRadians (the exact same step the crank's own
-- handle turns), eased into place over the following frames (see
-- :update) rather than snapping.
function Mirror:crank(stepRadians)
  self.targetAngle = self.targetAngle + stepRadians
end

function Mirror:update()
  local timeScale = state.timeScale or 1
  if self.angle < self.targetAngle then
    self.angle = math.min(self.targetAngle, self.angle + SWING_SPEED * timeScale)
  elseif self.angle > self.targetAngle then
    self.angle = math.max(self.targetAngle, self.angle - SWING_SPEED * timeScale)
  end
end

-- Drawn in its own rotated space: a steel frame with brass end caps,
-- the silvered glass inset in it (see getGlassShader), and a bolted hub
-- over its pivot, turning with it.
function Mirror:draw()
  local hl, ht = MIRROR_LENGTH / 2, MIRROR_THICKNESS / 2
  love.graphics.push("all")
  love.graphics.translate(self.pos.x, self.pos.y)
  love.graphics.rotate(self.angle)
  love.graphics.setLineStyle("smooth")

  -- Frame.
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.rectangle("fill", -hl - 1.5, -ht - 1.5, MIRROR_LENGTH + 3, MIRROR_THICKNESS + 3, 3, 3)
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(getFrameMesh())

  -- Glass.
  local glassLen = MIRROR_LENGTH - (CAP_LENGTH + FRAME_INSET) * 2
  local glassThick = MIRROR_THICKNESS - FRAME_INSET * 2
  local now = love.timer.getTime() + self.glintOffset
  local glintT = (now % GLINT_PERIOD) / GLINT_SECONDS   -- 0..1 while it's crossing
  local glintAt = glintT <= 1 and (-15 + glintT * (glassLen + 30)) or -1000
  local s = getGlassShader()
  s:send("len", glassLen)
  s:send("thick", glassThick)
  -- Its top face's normal is (sin, -cos) of its angle: how much that
  -- points up the screen.
  s:send("upness", math.cos(self.angle))
  s:send("glintAt", glintAt)
  love.graphics.setShader(s)
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(getPixel(), -glassLen / 2, -glassThick / 2, 0, glassLen, glassThick)
  love.graphics.setShader()
  love.graphics.setColor(COLOR_OUTLINE[1], COLOR_OUTLINE[2], COLOR_OUTLINE[3], 0.6)
  love.graphics.setLineWidth(1)
  love.graphics.rectangle("line", -glassLen / 2, -glassThick / 2, glassLen, glassThick)

  -- Brass end caps.
  for side = -1, 1, 2 do
    local cx = side > 0 and (hl - CAP_LENGTH) or -hl
    love.graphics.setColor(COLOR_CAP)
    love.graphics.rectangle("fill", cx, -ht, CAP_LENGTH, MIRROR_THICKNESS, 2, 2)
    love.graphics.setColor(COLOR_CAP_LIGHT)
    love.graphics.rectangle("fill", cx + 1, -ht + 1, CAP_LENGTH - 2, 2)
    love.graphics.setColor(COLOR_OUTLINE[1], COLOR_OUTLINE[2], COLOR_OUTLINE[3], 0.7)
    love.graphics.rectangle("line", cx, -ht, CAP_LENGTH, MIRROR_THICKNESS, 2, 2)
  end

  -- Pivot hub: a bolt, its slot turning with the mirror.
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.circle("fill", 0, 0, HUB_RADIUS + 1.5)
  love.graphics.setColor(COLOR_FRAME_DARK)
  love.graphics.circle("fill", 0, 0, HUB_RADIUS)
  love.graphics.setColor(COLOR_FRAME_LIGHT)
  love.graphics.circle("fill", -0.8, -0.8, HUB_RADIUS * 0.7)
  love.graphics.setColor(COLOR_OUTLINE)
  love.graphics.setLineWidth(1.6)
  love.graphics.line(-HUB_RADIUS * 0.5, 0, HUB_RADIUS * 0.5, 0)

  love.graphics.pop()

  -- The glint's sparkle, travelling along with it — in world space, so the
  -- star stands upright however the mirror's turned.
  if glintT <= 1 then
    local k = math.sin(glintT * math.pi)
    local along = glintAt - glassLen / 2
    local c, sn = math.cos(self.angle), math.sin(self.angle)
    local x, y = self.pos.x + c * along, self.pos.y + sn * along
    love.graphics.push("all")
    love.graphics.setBlendMode("add")
    love.graphics.setLineStyle("smooth")
    love.graphics.setColor(1, 1, 0.92, 0.7 * k)
    love.graphics.setLineWidth(1.5)
    local r = 9 * k
    love.graphics.line(x - r, y, x + r, y)
    love.graphics.line(x, y - r, x, y + r)
    love.graphics.setColor(1, 1, 0.92, 0.35 * k)
    love.graphics.circle("fill", x, y, 3 * k)
    love.graphics.pop()
  end
end

return Mirror
