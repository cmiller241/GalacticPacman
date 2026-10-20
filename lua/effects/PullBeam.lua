-- lua/effects/PullBeam.lua
--
-- Port of js/effects/PullBeam.js
-- Draws the light-blue pull beam while the player is actively pulling
-- toward a planet, all of it additive light:
--   * the beam itself (one quad through a shader): a hot white core, a
--     cyan body of rippling plasma, flaring a little wider toward the
--     target, with bright bands of energy streaming back down it toward
--     Bob — it reads as pulling;
--   * two strands twisting round it as a helix, pinned at both ends, and
--     a flickering lightning arc;
--   * sparks drifting back down the beam;
--   * a flare at the blaster's muzzle;
--   * on the target: a splash of light where the beam meets its surface,
--     its outline, and (round targets) rotating brackets plus rings
--     closing in on it.
-- Animated in game time (state.timeScale), so V.A.T.S. slow-mo slows it.

local state = require("lua.state")

----------------------------------------------------------------------
-- Tunables
----------------------------------------------------------------------

local COLOR = { 120/255, 210/255, 255/255 }
local COLOR_HOT = { 215/255, 246/255, 255/255 }

local BEAM_HALF_WIDTH = 22        -- world units, at the target end (the shader's quad)
local BEAM_START_FRACTION = 0.3   -- how wide it is at the muzzle, as a fraction of that

local OUTLINE_GLOW_WIDTH = 9
local OUTLINE_CORE_WIDTH = 3
local OUTLINE_PADDING   = 8

local HELIX_AMPLITUDE = 11        -- world units, at the beam's middle
local HELIX_WAVELENGTH = 90       -- world units per twist
local HELIX_SPEED = 9             -- radians per second
local HELIX_SAMPLE_SPACING = 6

local BOLT_INTERVAL = 0.06        -- seconds between lightning re-shapes
local BOLT_SEGMENT = 18           -- world units per jag
local BOLT_JITTER = 9             -- world units, at the beam's middle

local SPARKS_PER_100_UNITS = 5    -- per second, per 100 units of beam
local SPARK_SPEED = 260           -- world units per second, back toward Bob
local SPARK_LIFE = 0.6            -- seconds

local RING_PERIOD = 0.7           -- seconds for each closing-in ring
local RING_START_GAP = 46         -- how far outside the outline a ring starts

----------------------------------------------------------------------
-- Resources
----------------------------------------------------------------------

local beamShader = nil
local function getBeamShader()
  if beamShader then return beamShader end
  beamShader = love.graphics.newShader([[
    extern number time;
    extern number len;         // beam length, world units
    extern number halfWidth;   // the quad's half-width, world units
    extern number startFrac;   // the beam's width at the muzzle, as a fraction of that
    extern number pulse;       // 0..1 breathing
    extern vec3 color;
    extern vec3 hot;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                 mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }
    float fbm(vec2 p) {
      float v = 0.0;
      float a = 0.5;
      for (int k = 0; k < 3; k++) {
        v += a * noise(p);
        p = p * 2.07 + vec2(3.1, 7.7);
        a *= 0.5;
      }
      return v;
    }

    // uv.x: 0 at the muzzle .. 1 at the target; uv.y across the beam.
    vec4 effect(vec4 vcolor, Image tex, vec2 uv, vec2 screen) {
      float s = uv.x * len;                      // world units from the muzzle
      float v = uv.y * 2.0 - 1.0;
      float d = v * halfWidth;                   // world units from the axis
      // Wobbling a little, and flaring wider toward the target.
      d += (noise(vec2(s * 0.03 + time * 3.0, 1.7)) - 0.5) * 3.0;
      float spread = halfWidth * mix(startFrac, 1.0, smoothstep(0.0, 1.0, uv.x));
      float a = d / spread;                      // -1..1 across the beam, here

      float core = exp(-d * d / 2.2);
      float inner = exp(-a * a * 6.0);
      float outer = exp(-a * a * 2.0) * (1.0 - smoothstep(0.75, 1.0, abs(a)));

      // Plasma, and bands of energy, both streaming back toward the muzzle.
      float n = fbm(vec2(s * 0.018 + time * 2.2, a * 1.8));
      float band = pow(0.5 + 0.5 * sin(s * 0.09 + time * 16.0), 5.0);

      float ends = smoothstep(0.0, min(0.2, 14.0 / max(len, 1.0)), uv.x);

      vec3 rgb = color * outer * (0.3 + 0.7 * n) * (0.8 + 0.3 * pulse)
               + color * inner * (0.4 + 0.8 * band)
               + hot * core * (0.85 + 0.15 * pulse);
      return vec4(rgb * ends, 1.0);
    }
  ]])
  return beamShader
end

local pixelImage = nil
local function getPixel()
  if pixelImage then return pixelImage end
  local data = love.image.newImageData(1, 1)
  data:setPixel(0, 0, 1, 1, 1, 1)
  pixelImage = love.graphics.newImage(data)
  return pixelImage
end

-- A soft round glow, fading smoothly to nothing at its edge.
local GLOW_SIZE = 64
local glowImage = nil
local function getGlow()
  if glowImage then return glowImage end
  local data = love.image.newImageData(GLOW_SIZE, GLOW_SIZE)
  local half = GLOW_SIZE / 2
  data:mapPixel(function(x, y)
    local d = math.sqrt((x + 0.5 - half) ^ 2 + (y + 0.5 - half) ^ 2) / half
    local v = math.max(0, 1 - d)
    return 1, 1, 1, v * v
  end)
  glowImage = love.graphics.newImage(data)
  glowImage:setFilter("linear", "linear")
  return glowImage
end

local function drawGlow(x, y, diameter, r, g, b, a)
  local img = getGlow()
  love.graphics.setColor(r, g, b, a)
  love.graphics.draw(img, x, y, 0, diameter / GLOW_SIZE, diameter / GLOW_SIZE, GLOW_SIZE / 2, GLOW_SIZE / 2)
end

----------------------------------------------------------------------
-- State carried between frames (only while a pull is going on)
----------------------------------------------------------------------

local time = 0
local bolt = nil      -- { timer, offsets = { {u, off}, ... } }
local sparks = {}     -- { u, off, life }
local sparkBudget = 0

local function reset()
  bolt = nil
  sparks = {}
  sparkBudget = 0
end

-- Strokes `points` (a flat x1, y1, x2, y2, ... list) twice: a wide faint
-- glow, then a thin bright core.
local function strokeGlowing(points, glowWidth, coreWidth, glowA, coreA)
  if #points < 4 then return end
  love.graphics.setLineWidth(glowWidth)
  love.graphics.setColor(COLOR[1], COLOR[2], COLOR[3], glowA)
  love.graphics.line(points)
  love.graphics.setLineWidth(coreWidth)
  love.graphics.setColor(COLOR_HOT[1], COLOR_HOT[2], COLOR_HOT[3], coreA)
  love.graphics.line(points)
end

-- How far along the beam (0..1) fades the strands/bolt in and out, so
-- they're pinned at both ends.
local function envelope(u)
  return math.sin(math.pi * u)
end

local function drawPullIndicator()
  local player = state.player
  if not player or not player.pullTarget or player.mode ~= "space" then
    reset()
    return
  end

  local target = player.pullTarget
  local dt = (state.timeScale or 1) / 60
  time = time + dt
  local pulse = (math.sin(time * 6) + 1) / 2   -- ~0..1 breathing

  -- Out of the blaster's own muzzle (the hole at the end of his arm),
  -- same as a fireball — it used to start back at his shoulder.
  local originX, originY = player:getMuzzlePosition()
  local dx = target.pos.x - originX
  local dy = target.pos.y - originY
  local toCenter = math.sqrt(dx * dx + dy * dy)
  if toCenter < 1e-3 then return end
  local dirX, dirY = dx / toCenter, dy / toCenter
  local perpX, perpY = -dirY, dirX

  -- The beam stops where it meets the target's surface (roughly, for a
  -- rounded rect: its shorter half-extent), not its centre.
  local surfaceInset = target.isRoundedRect
    and math.min(target.halfWidth or target.radius, target.halfHeight or target.radius)
    or target.radius
  local len = math.max(8, toCenter - surfaceInset)
  local endX, endY = originX + dirX * len, originY + dirY * len
  local function at(u, off)
    local s = u * len
    return originX + dirX * s + perpX * off, originY + dirY * s + perpY * off
  end

  love.graphics.push("all")
  love.graphics.setBlendMode("add")
  love.graphics.setLineStyle("smooth")
  love.graphics.setLineJoin("bevel")

  -- The beam.
  local shader = getBeamShader()
  shader:send("time", time)
  shader:send("len", len)
  shader:send("halfWidth", BEAM_HALF_WIDTH)
  shader:send("startFrac", BEAM_START_FRACTION)
  shader:send("pulse", pulse)
  shader:send("color", COLOR)
  shader:send("hot", COLOR_HOT)
  love.graphics.setShader(shader)
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(getPixel(), originX - perpX * BEAM_HALF_WIDTH, originY - perpY * BEAM_HALF_WIDTH,
    math.atan2(dirY, dirX), len, BEAM_HALF_WIDTH * 2)
  love.graphics.setShader()

  -- Helix strands, half a twist apart, pinned at both ends.
  local samples = math.max(2, math.floor(len / HELIX_SAMPLE_SPACING))
  for strand = 0, 1 do
    local points = {}
    for i = 0, samples do
      local u = i / samples
      local phase = (u * len) / HELIX_WAVELENGTH * math.pi * 2 + time * HELIX_SPEED + strand * math.pi
      local x, y = at(u, math.sin(phase) * HELIX_AMPLITUDE * envelope(u))
      points[#points + 1] = x
      points[#points + 1] = y
    end
    strokeGlowing(points, 5, 1.5, 0.12 + 0.08 * pulse, 0.55 + 0.3 * pulse)
  end

  -- Lightning: a jagged arc down the beam, re-shaped every few frames.
  if not bolt or bolt.timer <= 0 then
    local jags = math.max(2, math.floor(len / BOLT_SEGMENT))
    local offsets = {}
    for i = 0, jags do
      local u = i / jags
      offsets[#offsets + 1] = { u, (math.random() * 2 - 1) * BOLT_JITTER * envelope(u) }
    end
    bolt = { timer = BOLT_INTERVAL, offsets = offsets }
  end
  bolt.timer = bolt.timer - dt
  local boltPoints = {}
  for _, o in ipairs(bolt.offsets) do
    local x, y = at(o[1], o[2])
    boltPoints[#boltPoints + 1] = x
    boltPoints[#boltPoints + 1] = y
  end
  strokeGlowing(boltPoints, 4, 1.2, 0.15, 0.4 + 0.4 * math.random())

  -- Sparks, drifting back down the beam toward Bob.
  sparkBudget = sparkBudget + SPARKS_PER_100_UNITS * (len / 100) * dt
  while sparkBudget >= 1 do
    sparkBudget = sparkBudget - 1
    local u = 0.15 + math.random() * 0.85
    sparks[#sparks + 1] = { u = u, off = (math.random() * 2 - 1) * BEAM_HALF_WIDTH * 0.5 * u, life = 1 }
  end
  for i = #sparks, 1, -1 do
    local sp = sparks[i]
    sp.u = sp.u - SPARK_SPEED * dt / len
    sp.off = sp.off * (1 - 1.5 * dt)
    sp.life = sp.life - dt / SPARK_LIFE
    if sp.life <= 0 or sp.u <= 0 then
      table.remove(sparks, i)
    else
      local x, y = at(sp.u, sp.off)
      drawGlow(x, y, 16, COLOR[1], COLOR[2], COLOR[3], 0.7 * sp.life)
      love.graphics.setColor(COLOR_HOT[1], COLOR_HOT[2], COLOR_HOT[3], sp.life)
      love.graphics.circle("fill", x, y, 1.8)
    end
  end

  -- Muzzle flare: a glow and a turning four-point star.
  drawGlow(originX, originY, 44 + 10 * pulse, COLOR[1], COLOR[2], COLOR[3], 0.85)
  drawGlow(originX, originY, 16, COLOR_HOT[1], COLOR_HOT[2], COLOR_HOT[3], 1)
  local starA = time * 2.5
  local starR = 11 + 3 * pulse
  love.graphics.setLineWidth(1.5)
  love.graphics.setColor(COLOR_HOT[1], COLOR_HOT[2], COLOR_HOT[3], 0.7)
  for k = 0, 1 do
    local a = starA + k * math.pi / 2
    local cx, cy = math.cos(a) * starR, math.sin(a) * starR
    love.graphics.line(originX - cx, originY - cy, originX + cx, originY + cy)
  end

  -- Where it meets the target: a splash of light.
  drawGlow(endX, endY, 80 + 16 * pulse, COLOR[1], COLOR[2], COLOR[3], 0.75)
  drawGlow(endX, endY, 26, COLOR_HOT[1], COLOR_HOT[2], COLOR_HOT[3], 1)

  -- Outline around the target
  if target.isRoundedRect then
    -- A true rotated rounded-rect outline, matching the target's own
    -- actual silhouette (halfWidth/halfHeight/cornerRadius/
    -- rotationAngle — RoundedRectPlanetoid.lua's own fields; SkyDome/
    -- JumpPlatform are also isRoundedRect but isPullExempt, so they
    -- never actually reach here) — not the plain circle this used to
    -- fall back to. Each half-extent AND the corner radius all get the
    -- same OUTLINE_PADDING added, so the outline sits evenly outset
    -- from the real edge all the way around rather than just being a
    -- bigger rectangle with the original (now disproportionately
    -- tight) corners.
    local hw = (target.halfWidth or target.radius) + OUTLINE_PADDING
    local hh = (target.halfHeight or target.radius) + OUTLINE_PADDING
    local cr = (target.cornerRadius or 0) + OUTLINE_PADDING

    love.graphics.push()
    love.graphics.translate(target.pos.x, target.pos.y)
    love.graphics.rotate(target.rotationAngle or 0)

    love.graphics.setLineWidth(OUTLINE_GLOW_WIDTH)
    love.graphics.setColor(COLOR[1], COLOR[2], COLOR[3], 0.3 * (0.4 + pulse * 0.4))
    love.graphics.rectangle("line", -hw, -hh, hw * 2, hh * 2, cr, cr)

    love.graphics.setLineWidth(OUTLINE_CORE_WIDTH)
    love.graphics.setColor(COLOR[1], COLOR[2], COLOR[3], 0.7 + pulse * 0.3)
    love.graphics.rectangle("line", -hw, -hh, hw * 2, hh * 2, cr, cr)

    love.graphics.pop()
  else
    local tx, ty = target.pos.x, target.pos.y
    local ringR = target.radius + OUTLINE_PADDING

    love.graphics.setLineWidth(OUTLINE_GLOW_WIDTH)
    love.graphics.setColor(COLOR[1], COLOR[2], COLOR[3], 0.3 * (0.4 + pulse * 0.4))
    love.graphics.circle("line", tx, ty, ringR)
    love.graphics.setLineWidth(OUTLINE_CORE_WIDTH)
    love.graphics.setColor(COLOR[1], COLOR[2], COLOR[3], 0.7 + pulse * 0.3)
    love.graphics.circle("line", tx, ty, ringR)

    -- Three brackets turning round it, just outside the outline.
    local bracketR = ringR + 10
    local spin = time * 1.6
    love.graphics.setLineWidth(3)
    love.graphics.setColor(COLOR_HOT[1], COLOR_HOT[2], COLOR_HOT[3], 0.55 + 0.3 * pulse)
    for k = 0, 2 do
      local a = spin + k * math.pi * 2 / 3
      love.graphics.arc("line", "open", tx, ty, bracketR, a, a + 0.55, 12)
    end

    -- Rings closing in on it — being reeled in.
    love.graphics.setLineWidth(2)
    for k = 0, 1 do
      local phase = (time / RING_PERIOD + k * 0.5) % 1
      local r = ringR + RING_START_GAP * (1 - phase)
      love.graphics.setColor(COLOR[1], COLOR[2], COLOR[3], 0.45 * math.sin(math.pi * phase))
      love.graphics.circle("line", tx, ty, r)
    end
  end

  love.graphics.pop()
end

return {
  draw = drawPullIndicator,
}
