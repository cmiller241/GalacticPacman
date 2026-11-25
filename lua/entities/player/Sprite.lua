-- lua/entities/player/Sprite.lua
--
-- Bob drawn from sprite sheets made from img/astronaut2.svg: posed and
-- normal-mapped by tools/arm-animator.html, exported by
-- tools/bob-sprite-export.html (which also measured the numbers in DATA
-- below — re-export and paste them in whenever the drawing changes).
--
--   img/bob-sprite.png         his body, no arms: walk frames 1-6 (legs,
--                              buckle and bob), standing (frame 7), then
--                              in the air, legs wide (frame 8)
--   img/bob-sprite_normal.png  their normal maps
--   img/bob-arms.png           his arms as they hang standing: "Right Arm"
--                              (in front of him), "Left Arm" (behind him)
--                              and "Left Arm - Blaster" (in the left arm's
--   img/bob-arms_normal.png    place, while he aims), and their normal maps
--
-- Every frame and every arm sits in the same frame box, so they line up
-- as they are. The arms are turned round their shoulders: swinging as he
-- walks, the right one forward as the left leg goes forward and back,
-- the left one the other way. Mega Man rules: he only has the blaster arm
-- out while he's aiming or shooting (see Rendering.lua's drawSprite).
--
-- His pupils aren't in the pictures: they're drawn here, looking where
-- he's aiming (the way the arm animator's follow the mouse).
--
-- Lit by the sun from the normal maps, the same lighting the Ooombas get
-- (see Ooomba.lua's sunLightingShader, and the arm animator's defaults).

local state = require("lua.state")

local Sprite = {}

-- From tools/bob-sprite-export.html (pixels, in one frame).
local DATA = {
  frameW = 247, frameH = 321,
  walkFrames = 6, standFrame = 7, airFrame = 8,
  centerX = 89.3,               -- the middle of his body, across
  soleY = 306, topY = 6,        -- his soles, and the top of his antenna (standing)
  -- How far all of him has dropped in each frame (his legs angled), so
  -- the arms and pupils go down with him.
  drop = { 5.7, 3.7, 0.5, 0.5, 3.7, 5.7, 0, 0 },
  rightShoulder = { x = 46.3, y = 178.6 },   -- what each arm turns round
  leftShoulder = { x = 126.1, y = 176.4 },
  blasterShoulder = { x = 128.2, y = 180.9 },
  muzzle = { x = 235.6, y = 160.7 },         -- where the blaster's shots come out
  -- His pupils, standing: where, their size, and how far they can move
  -- (to the edge of the eye).
  eyes = {
    { x = 85.5, y = 114.5, rx = 3.5, ry = 5.9, travelX = 13.5, travelY = 21.1 },
    { x = 107, y = 108.4, rx = 2.9, ry = 5.7, travelX = 11.3, travelY = 19.8 },
  },
  irisColor = { 0, 0, 0 },
}
Sprite.DATA = DATA

-- How tall he's drawn, soles to the top of his antenna (world units).
Sprite.HEIGHT = 150
Sprite.SCALE = Sprite.HEIGHT / (DATA.soleY - DATA.topY)
-- The posable rig (Rendering.lua's wall slide, ground pound, curling into
-- a ball) is built in the old rig's units, where standing he's 134.95
-- world units tall: drawn this much bigger, to match.
Sprite.RIG_SCALE = Sprite.HEIGHT / 134.95

-- The walk: frames 1 to 6 and back (the arm animator's ping-pong), once
-- every WALK_CYCLE_STRIDES strides (his walkTime goes round 2*pi each
-- stride: see Movement.lua). Higher is a slower walk.
local WALK_SEQUENCE = { 1, 2, 3, 4, 5, 6, 5, 4, 3, 2 }
local WALK_CYCLE_STRIDES = 2
-- In the air: the air frame (legs wide), and both arms up: his right one
-- (on his back side) up behind him, his left one up in front, this far
-- round from hanging (radians) on the way up, and higher on the way down,
-- easing between the two from rising at FALL_SPEED to falling at it
-- (world units a tick).
local AIR_ARM_RISING = 1.9
local AIR_ARM_FALLING = 2.6
local FALL_SPEED = 5
-- How far his arms swing either way as he walks (radians).
local ARM_SWING = 0.45
-- Standing idle, a subtle sway: his arms drifting either way this far
-- (radians), a little out of step with each other, and him breathing —
-- stretching up from his soles by this fraction of his height and back.
-- How fast each goes round (radians a second).
local IDLE_ARM_SWAY, IDLE_ARM_SPEED = 0.07, 1.6
local IDLE_BREATH, IDLE_BREATH_SPEED = 0.012, 2.1
-- How far his pupils follow where he's aiming: 1 = right to the edge of
-- the eye.
local EYE_FOLLOW = 0.5

-- The blaster arm's own direction as drawn, shoulder to muzzle (radians,
-- image space: y down).
Sprite.ARM_REST_ANGLE = math.atan2(DATA.muzzle.y - DATA.blasterShoulder.y, DATA.muzzle.x - DATA.blasterShoulder.x)

-- Kept soft on purpose: he's flat cartoon line art, and strong gloss and
-- rim light turned his white suit into grey chrome. (Was ambient 0.42,
-- diffuse 0.72, specular 0.55, shininess 36, rimLight 0.9.)
local LIGHTING = {
  shadingStrength = 0.7, -- how much of all this shows: 0 = the plain art, 1 = full lighting
  ambient = 0.62,        -- brightness with no sunlight on it at all
  diffuse = 0.45,        -- added where the surface faces the sun full on
  specular = 0.15,       -- the glossy highlight's strength...
  shininess = 20,        -- ...and tightness (higher: smaller, sharper)
  rimLight = 0.25,       -- the reflected light on the edge away from the sun (0: none)...
  rimWidth = 1.8,        -- ...and how tightly it hugs the edge (higher: thinner)
  sunElevation = 0.5,    -- how much the sun also lights him from the front (0: purely from the side)
}

-- His ink (the dark navy outline, belt and visor ring) isn't lit at all —
-- lit, it smeared grey on the sun side — and is drawn in this lighter
-- slate instead, since the navy vanished against the dark of space. A
-- pixel counts as ink when none of its channels is brighter than
-- INK_THRESHOLD and it's bluish (not black or grey); the darkest ink becomes INK_COLOR * INK_DARKEST, the
-- lightest INK_COLOR itself. INK_RECOLOR = false keeps the original navy.
local INK_RECOLOR = true
local INK_THRESHOLD = 0.36
local INK_COLOR = { 0.24, 0.30, 0.52 } -- #3D4D85
local INK_DARKEST = 0.6

local images = nil
local bodyQuads, armQuads = nil, nil
local RIGHT_ARM, LEFT_ARM, BLASTER_ARM = 1, 2, 3

-- The sheets, loaded the first time they're needed (nil if they're missing).
local function getImages()
  if images ~= nil then return images or nil end
  local ok, result = pcall(function()
    local function load(path)
      local img = love.graphics.newImage(path, { mipmaps = true })
      img:setFilter("linear", "linear")
      img:setMipmapFilter("linear")
      return img
    end
    return {
      body = load("img/bob-sprite.png"),
      bodyNormal = load("img/bob-sprite_normal.png"),
      arms = load("img/bob-arms.png"),
      armsNormal = load("img/bob-arms_normal.png"),
    }
  end)
  images = ok and result or false
  if not ok then print("Sprite.lua: couldn't load Bob's sprite sheets (" .. tostring(result) .. ") - drawing the old rig instead.") end
  return images or nil
end

local function makeQuads(img, count)
  local list = {}
  local sw, sh = img:getDimensions()
  for i = 1, count do
    list[i] = love.graphics.newQuad((i - 1) * DATA.frameW, 0, DATA.frameW, DATA.frameH, sw, sh)
  end
  return list
end

function Sprite.available()
  return getImages() ~= nil
end

-- Which frame of the body he's in right now, how far his right and left
-- arms are turned from hanging (positive: the hand goes back), and how
-- much he's breathing in (see Sprite.draw). Walking, the arms swing
-- opposite ways: the right one back as his right leg goes forward.
-- Standing, they sway a little. upSpeed: how fast he's going up (negative:
-- coming down), for his arms in the air — and his eyes, which look up on
-- the way up and down on the way down: in the air, a fifth result, how
-- far up (-1) or down (1) they look (nil on the ground).
function Sprite.pose(player, upSpeed)
  if not player.onSurface then
    local falling = math.max(0, math.min(1, (FALL_SPEED - (upSpeed or 0)) / (2 * FALL_SPEED)))
    falling = falling * falling * (3 - 2 * falling)
    local raise = AIR_ARM_RISING + (AIR_ARM_FALLING - AIR_ARM_RISING) * falling
    return DATA.airFrame, raise, -raise, 0, 2 * falling - 1
  end
  if not player.isWalking then
    local t = love.timer.getTime()
    return DATA.standFrame,
      IDLE_ARM_SWAY * math.sin(t * IDLE_ARM_SPEED),
      IDLE_ARM_SWAY * math.sin(t * IDLE_ARM_SPEED + 1.3),
      IDLE_BREATH * math.sin(t * IDLE_BREATH_SPEED)
  end
  local phase = (player.walkTime / (2 * math.pi * WALK_CYCLE_STRIDES)) % 1
  -- How far along frames 1 to 6 he is, 0 to 1 and back.
  local along = 1 - math.abs(1 - 2 * phase)
  local swing = ARM_SWING * math.cos(math.pi * along)
  return WALK_SEQUENCE[math.floor(phase * #WALK_SEQUENCE) + 1], swing, -swing, 0
end

local shader = nil
local function getShader()
  if shader then return shader end
  shader = love.graphics.newShader([[
    extern Image normalMap;
    extern vec3 lightDir;   // toward the sun, in the image's own frame (x right, y up, z toward the viewer)
    extern float ambient;
    extern float diffuse;
    extern float specular;
    extern float shininess;
    extern float rimLight;
    extern float rimWidth;
    extern float shadingStrength;
    extern float inkRecolor;
    extern float inkThreshold;
    extern vec3 inkColor;
    extern float inkDarkest;

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec4 texel = Texel(tex, uv) * color;
      // Ink: recolored and left unlit (see INK_RECOLOR).
      float brightest = max(texel.r, max(texel.g, texel.b));
      // (Navy only: blue well above red, so the rig head's black pupils
      // and the blaster's grey barrel are left alone.)
      if (inkRecolor > 0.5 && brightest < inkThreshold && texel.b - texel.r > 0.08) {
        float k = brightest / inkThreshold;
        return vec4(inkColor * (inkDarkest + (1.0 - inkDarkest) * k), texel.a);
      }
      vec4 nt = Texel(normalMap, uv);
      if (nt.a < 0.01) return texel;
      vec3 n = normalize(nt.rgb * 2.0 - 1.0);
      float facing = max(dot(n, lightDir), 0.0);
      vec3 halfway = normalize(lightDir + vec3(0.0, 0.0, 1.0));
      float shine = pow(max(dot(n, halfway), 0.0), shininess) * specular;

      // Reflected light round the edge away from the sun.
      float edge = pow(1.0 - clamp(n.z, 0.0, 1.0), rimWidth);
      float away = 0.0;
      if (length(n.xy) > 1e-4 && length(lightDir.xy) > 1e-4) {
        away = max(dot(normalize(n.xy), -normalize(lightDir.xy)), 0.0);
      }
      float rim = edge * away * rimLight;

      vec3 lit = texel.rgb * (ambient + diffuse * facing)
        + mix(texel.rgb, vec3(1.0), 0.35) * rim
        + vec3(1.0, 0.98, 0.92) * shine * texel.a;
      vec3 rgb = mix(texel.rgb, lit, shadingStrength);
      return vec4(min(rgb, vec3(1.0)), texel.a);
    }
  ]])
  for _, name in ipairs({ "ambient", "diffuse", "specular", "shininess", "rimLight", "rimWidth", "shadingStrength" }) do
    shader:send(name, LIGHTING[name])
  end
  shader:send("inkRecolor", INK_RECOLOR and 1 or 0)
  shader:send("inkThreshold", INK_THRESHOLD)
  shader:send("inkColor", INK_COLOR)
  shader:send("inkDarkest", INK_DARKEST)
  return shader
end

-- Turns the lighting on for the next image drawn, if nothing else has a
-- shader on (the silhouette glow, the shadows and the portals draw him
-- under shaders of their own, which this mustn't replace). The image is
-- drawn turned `rotation`, mirrored if `flipped`, and then (inside that)
-- turned `extra` more, and mirrored again if `flippedAgain`: the sun's
-- direction is taken back through all of that into the image's own
-- frame. Returns whether it turned it on. (Also lights the posable rig's
-- parts: see Rendering.lua's drawRigImage.)
local function light(x, y, normalMap, rotation, flipped, extra, flippedAgain)
  if love.graphics.getShader() ~= nil then return false end
  local toSunX = (state.sceneWidth or 0) / 2 - x
  local toSunY = (state.sceneHeight or 0) / 2 - y
  local dist = math.sqrt(toSunX * toSunX + toSunY * toSunY)
  if dist < 1 then return false end
  toSunX, toSunY = toSunX / dist, toSunY / dist
  local c, s = math.cos(-rotation), math.sin(-rotation)
  local lx, ly = c * toSunX - s * toSunY, s * toSunX + c * toSunY
  if flipped then lx = -lx end
  c, s = math.cos(-extra), math.sin(-extra)
  lx, ly = c * lx - s * ly, s * lx + c * ly
  if flippedAgain then lx = -lx end
  ly = -ly -- (the map's y is up)
  local lz = LIGHTING.sunElevation
  local len = math.sqrt(lx * lx + ly * ly + lz * lz)
  local sh = getShader()
  sh:send("normalMap", normalMap)
  sh:send("lightDir", { lx / len, ly / len, lz / len })
  love.graphics.setShader(sh)
  return true
end
Sprite.light = light

-- The same, for an image about to be drawn (unturned, unmirrored) under
-- whatever transform is set right now: how it's turned and mirrored is
-- read from the transform itself. (The posable rig's parts: see
-- Rendering.lua's drawRigImage.) (x, y): where it is in the world.
function Sprite.lightHere(x, y, normalMap)
  if love.graphics.getShader() ~= nil then return false end
  local toSunX = (state.sceneWidth or 0) / 2 - x
  local toSunY = (state.sceneHeight or 0) / 2 - y
  local dist = math.sqrt(toSunX * toSunX + toSunY * toSunY)
  if dist < 1 then return false end
  -- Where the image's own x and y axes point on screen (the camera only
  -- moves and zooms, so that's the way they point in the world too).
  local ox, oy = love.graphics.transformPoint(0, 0)
  local ax, ay = love.graphics.transformPoint(1, 0)
  local bx, by = love.graphics.transformPoint(0, 1)
  ax, ay, bx, by = ax - ox, ay - oy, bx - ox, by - oy
  local det = ax * by - bx * ay
  if math.abs(det) < 1e-12 then return false end
  -- The sun's direction in those axes.
  local lx = (by * toSunX - bx * toSunY) / det
  local ly = (-ay * toSunX + ax * toSunY) / det
  local flat = math.sqrt(lx * lx + ly * ly)
  if flat < 1e-9 then return false end
  lx, ly = lx / flat, -ly / flat -- (the map's y is up)
  local lz = LIGHTING.sunElevation
  local len = math.sqrt(1 + lz * lz)
  local sh = getShader()
  sh:send("normalMap", normalMap)
  sh:send("lightDir", { lx / len, ly / len, lz / len })
  love.graphics.setShader(sh)
  return true
end

-- Where a point of the frame (px, py) is in the world, with him standing
-- with his soles at (feetX, feetY), turned `rotation`, facing dirSign.
function Sprite.toWorld(px, py, feetX, feetY, rotation, dirSign)
  local lx = (px - DATA.centerX) * Sprite.SCALE * dirSign
  local ly = (py - DATA.soleY) * Sprite.SCALE
  local c, s = math.cos(rotation), math.sin(rotation)
  return feetX + lx * c - ly * s, feetY + lx * s + ly * c
end

-- Where the blaster arm's shoulder is in the world, in body frame `frame`.
function Sprite.blasterShoulder(frame, feetX, feetY, rotation, dirSign)
  local sh = DATA.blasterShoulder
  return Sprite.toWorld(sh.x, sh.y + DATA.drop[frame], feetX, feetY, rotation, dirSign)
end

-- Where the blaster's muzzle is, from its shoulder, with the arm turned
-- armAngle (world units).
function Sprite.muzzleOffset(rotation, dirSign, armAngle)
  local dx, dy = DATA.muzzle.x - DATA.blasterShoulder.x, DATA.muzzle.y - DATA.blasterShoulder.y
  local c, s = math.cos(armAngle), math.sin(armAngle)
  dx, dy = dx * c - dy * s, dx * s + dy * c
  dx, dy = dx * Sprite.SCALE * dirSign, dy * Sprite.SCALE
  c, s = math.cos(rotation), math.sin(rotation)
  return dx * c - dy * s, dx * s + dy * c
end

-- One arm (RIGHT_ARM, LEFT_ARM or BLASTER_ARM), turned `angle` round its
-- shoulder, in body frame `frame`. (Inside Sprite.draw's transform.)
local function drawArm(imgs, which, shoulder, angle, frame, feetX, feetY, rotation, flipped)
  love.graphics.push()
  love.graphics.translate(shoulder.x - DATA.centerX, shoulder.y + DATA.drop[frame] - DATA.soleY)
  love.graphics.rotate(angle)
  local lit = light(feetX, feetY, imgs.armsNormal, rotation, flipped, angle)
  love.graphics.draw(imgs.arms, armQuads[which], 0, 0, 0, 1, 1, shoulder.x, shoulder.y)
  if lit then love.graphics.setShader() end
  love.graphics.pop()
end

-- Draws him: soles at (feetX, feetY), turned `rotation` (0 = upright),
-- facing dirSign (1 right, -1 left), in body frame `frame`, his arms
-- turned rightAngle and leftAngle (see Sprite.pose). blasterAngle: nil for
-- his ordinary left arm, or the blaster arm in its place, turned that far
-- round its shoulder (0 = as drawn). (lookX, lookY): which way his pupils
-- look, in the picture's own frame (x forward, y down), up to a unit
-- vector (0, 0: straight ahead). breath: how much taller he's drawn,
-- stretched up from his soles (a fraction: see Sprite.pose).
function Sprite.draw(feetX, feetY, rotation, dirSign, frame, rightAngle, leftAngle, blasterAngle, lookX, lookY, breath)
  local imgs = getImages()
  if not imgs then return end
  bodyQuads = bodyQuads or makeQuads(imgs.body, DATA.airFrame)
  armQuads = armQuads or makeQuads(imgs.arms, 3)
  local flipped = dirSign < 0

  love.graphics.push()
  love.graphics.translate(feetX, feetY)
  love.graphics.rotate(rotation)
  love.graphics.scale(Sprite.SCALE * dirSign, Sprite.SCALE * (1 + (breath or 0)))
  love.graphics.setColor(1, 1, 1, 1)

  -- Behind him: his left arm, or the blaster arm in its place.
  if blasterAngle then
    drawArm(imgs, BLASTER_ARM, DATA.blasterShoulder, blasterAngle, frame, feetX, feetY, rotation, flipped)
  else
    drawArm(imgs, LEFT_ARM, DATA.leftShoulder, leftAngle, frame, feetX, feetY, rotation, flipped)
  end

  local lit = light(feetX, feetY, imgs.bodyNormal, rotation, flipped, 0)
  love.graphics.draw(imgs.body, bodyQuads[frame], 0, 0, 0, 1, 1, DATA.centerX, DATA.soleY)
  if lit then love.graphics.setShader() end

  -- His pupils, looking where he's aiming.
  love.graphics.setColor(DATA.irisColor[1], DATA.irisColor[2], DATA.irisColor[3], 1)
  for _, e in ipairs(DATA.eyes) do
    love.graphics.ellipse("fill",
      e.x - DATA.centerX + lookX * e.travelX * EYE_FOLLOW,
      e.y + DATA.drop[frame] - DATA.soleY + lookY * e.travelY * EYE_FOLLOW,
      e.rx, e.ry)
  end
  love.graphics.setColor(1, 1, 1, 1)

  -- In front of him: his right arm.
  drawArm(imgs, RIGHT_ARM, DATA.rightShoulder, rightAngle, frame, feetX, feetY, rotation, flipped)

  love.graphics.pop()
end

return Sprite
