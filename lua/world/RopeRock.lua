-- lua/world/RopeRock.lua
--
-- A rock slab hanging from a rope — placed in Tiled as two rectangle
-- objects (see TiledTerrain's ropeSpawns/rockSpawns, paired up in main.lua):
--   Rope  hangs from the top of its rectangle; custom property:
--           holds  (object, or its id) the Rock it holds — required
--   Rock  hangs where it's placed; custom property:
--           solid  (bool) true (the default): solid like a wall tile, and
--                  Bob can stand on top; false: just scenery
--
-- The rock is solid on every side like a wall tile (it's in the level's
-- walls — so fireballs go off against it, Ooombas turn at it, portals
-- stick to it), with a walkable top (a moving surface — see
-- TiledTerrain.newMovingSurface) for Bob to stand on if he can get up
-- there.
--
-- Hanging, it's still — until Bob jumps into it or shoots it: then it
-- rocks back and forth on the rope, away from the hit, the swing slowly
-- dying away. (It stays level as it swings, like a hanging platform —
-- only the rope tilts — so it stays a solid block he can stand on and
-- ride.)
--
-- Shoot the rope itself and it burns where it's hit, briefly, then it's
-- gone — and the rock drops, falling with the dome's gravity until it
-- lands on a ledge, a wall, another rock, or the dome's floor. Bob can
-- Recall it (see lua/systems/Recall.lua — it's one of state.recallables):
-- it rewinds back the way it moved, and carries on from there after.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local TiledTerrain = require("lua.world.TiledTerrain")
local Flame = require("lua.effects.Flame")

local RopeRock = {}
RopeRock.__index = RopeRock

----------------------------------------------------------------------
-- Tunables
----------------------------------------------------------------------

local ROPE_HIT_REACH = 10         -- world units from the rope a fireball's middle can pass and still set it alight
local BURN_TICKS = 60             -- how long the rope burns where it was hit before it's gone (60fps ticks)
local SWING_GRAVITY = 0.4         -- world units/tick^2 — what sets how fast it rocks
local SWING_DAMPING = 0.985       -- per tick: how much of its swing it keeps (lower dies away sooner)
local BUMP_SPEED = 0.025          -- radians/tick of swing Bob jumping into it gives it
local SHOT_SPEED = 0.022          -- ...and a fireball hitting it
local MAX_SWING_DEGREES = 70      -- never swings further than this either side
local FALL_GRAVITY = 0.6          -- world units/tick^2 (unless the dome has its own gravityStrength)
local MAX_FALL_SPEED = 22         -- world units/tick
local COLOR_ROPE = { 0.55, 0.40, 0.22 }
local COLOR_ROPE_DARK = { 0.30, 0.20, 0.10 }
local COLOR_ROPE_CHAR = { 0.12, 0.08, 0.06 } -- round where it's burning
local COLOR_ROCK_TOP = { 0.60, 0.58, 0.55 }  -- the stone's lighter mottling...
local COLOR_ROCK_SPOT = { 0.34, 0.32, 0.31 } -- ...and its darker
local COLOR_ROCK_EDGE = { 0.14, 0.13, 0.13 } -- its rim
local ROCK_CORNER = 8

----------------------------------------------------------------------

-- rope, rock: their spawns (world space — see TiledTerrain). level: the
-- Tiled level it's in (its walls and shapes — what it's solid among and
-- lands on). dome: whose gravity it falls with and floor it lands on, and
-- jump strength its top shares, like the level's own ledges.
function RopeRock.new(rope, rock, level, dome)
  local self = setmetatable({}, RopeRock)
  self.level = level
  self.dome = dome
  self.gravity = (dome and dome.gravityStrength) or FALL_GRAVITY
  self.top = { x = rope.x + rope.width / 2, y = rope.y }   -- where the rope hangs from
  self.ropeLength = math.max(1, rope.height)
  self.angle, self.angVel = 0, 0                            -- the rope's swing (+ = out to the right)

  -- The rock — pos/vel/halfWidth/halfHeight/radius like a wall tile
  -- (it IS one of the level's walls, and Recall moves it by pos/vel).
  self.halfWidth, self.halfHeight = rock.width / 2, rock.height / 2
  self.pos = Vector2.new(rock.x + self.halfWidth, rock.y + self.halfHeight)
  self.vel = Vector2.new(0, 0)
  self.radius = math.sqrt(self.halfWidth ^ 2 + self.halfHeight ^ 2)
  -- Its middle, from the end of the rope (as placed).
  self.offX = self.pos.x - self.top.x
  self.offY = self.pos.y - (self.top.y + self.ropeLength)
  self.hanging = true
  self.solid = rock.solid
  -- Varies its stone's pattern (and its flame's churn) from the next
  -- rock's — from where it was placed, so it's the same every time.
  -- (Kept small: the shaders' noise loses precision far from zero.)
  self.seed = (rock.x * 0.0137 + rock.y * 0.0291) % 7.3

  if self.solid then
    self.wall = { pos = self.pos, halfWidth = self.halfWidth, halfHeight = self.halfHeight, radius = self.radius, isWall = true }
    table.insert(level.walls, self.wall)
    self.surface = TiledTerrain.newMovingSurface(0, 0, 1, 0)
    self.surface.jumpStrength = dome and dome.jumpStrength
    table.insert(state.planetoids, self.surface)
  end
  self:placeSurface()
  return self
end

-- For Recall (see lua/systems/Recall.lua): whether a point's on the rock.
function RopeRock:containsPoint(x, y)
  return math.abs(x - self.pos.x) <= self.halfWidth and math.abs(y - self.pos.y) <= self.halfHeight
end

function RopeRock:placeSurface()
  if not self.surface then return end
  local topY = self.pos.y - self.halfHeight
  self.surface:moveTo(self.pos.x - self.halfWidth, topY, self.pos.x + self.halfWidth, topY)
end

-- The end of the rope, at the current swing.
function RopeRock:ropeEnd()
  return self.top.x + math.sin(self.angle) * self.ropeLength, self.top.y + math.cos(self.angle) * self.ropeLength
end

----------------------------------------------------------------------
-- The rope burning
----------------------------------------------------------------------

-- Distance from (x, y) to the rope, and how far along it (0 = top, 1 = end).
function RopeRock:distanceToRope(x, y)
  local ex, ey = self:ropeEnd()
  local dx, dy = ex - self.top.x, ey - self.top.y
  local t = math.max(0, math.min(1, ((x - self.top.x) * dx + (y - self.top.y) * dy) / (dx * dx + dy * dy)))
  local px, py = self.top.x + dx * t, self.top.y + dy * t
  return math.sqrt((x - px) ^ 2 + (y - py) ^ 2), t
end

-- A fireball's path this frame, in a few steps (it's fast, the rope's thin
-- and the rock's not much thicker): calls hit(t, x, y, f) for the first
-- point along it for which `test` says yes.
local function alongFireballs(ts, test)
  for _, f in ipairs(state.fireballs or {}) do
    for k = 0, 4 do
      local x = f.pos.x + f.vel.x * ts * k / 4
      local y = f.pos.y + f.vel.y * ts * k / 4
      if test(f, x, y) then return f end
    end
  end
  return nil
end

-- Any fireball crossing the rope sets it alight there; any about to go
-- off against the hanging rock sets it rocking, its way.
function RopeRock:checkFireballs(ts)
  if not self.burn and not self.burnedAway then
    local hitT = nil
    alongFireballs(ts, function(f, x, y)
      local d, t = self:distanceToRope(x, y)
      if d <= ROPE_HIT_REACH + (f.radius or 0) then hitT = t; return true end
      return false
    end)
    if hitT then self.burn = { at = hitT, ticks = BURN_TICKS } end
  end
  if self.hanging and self.solid then
    local f = alongFireballs(ts, function(f, x, y)
      local r = f.radius or 0
      return math.abs(x - self.pos.x) <= self.halfWidth + r and math.abs(y - self.pos.y) <= self.halfHeight + r
    end)
    if f then self:push((f.vel.x >= 0 and 1 or -1) * SHOT_SPEED) end
  end
end

-- Where it's burning, as a fraction along the rope (nil if it isn't) —
-- second value always nil (see TileGlow, which lights each flame).
function RopeRock:flameFronts()
  if not self.burn then return nil end
  return self.burn.at, nil
end

function RopeRock:flamePoint(t)
  local ex, ey = self:ropeEnd()
  return self.top.x + (ex - self.top.x) * t, self.top.y + (ey - self.top.y) * t
end

function RopeRock:updateBurn(ts)
  if not self.burn then return end
  self.burn.ticks = self.burn.ticks - ts
  if self.burn.ticks <= 0 then
    -- Burned through: the rope's gone, and the rock with it.
    self.burn = nil
    self.burnedAway = true
    if self.hanging then
      self.hanging = false
      self.vel.x, self.vel.y = 0, 0
    end
  end
end

----------------------------------------------------------------------
-- Rocking
----------------------------------------------------------------------

-- A shove to its swing (radians/tick, + = to the right).
function RopeRock:push(speed)
  self.angVel = self.angVel + speed
end

-- Bob jumping into it from the side or underneath (just touching it,
-- having not been a moment ago — not standing on its top) sets it
-- rocking away from him.
function RopeRock:checkBump()
  local player = state.player
  if not (player and self.solid) then return end
  local onTop = player.onSurface and player.currentPlanet == self.surface
  local dx = player.pos.x - self.pos.x
  local nearX = math.max(0, math.abs(dx) - self.halfWidth)
  local nearY = math.max(0, math.abs(player.pos.y - self.pos.y) - self.halfHeight)
  local touching = not onTop and nearX * nearX + nearY * nearY <= (player.radius + 3) ^ 2
  if touching and not self.bobTouching then
    self:push((dx <= 0 and 1 or -1) * BUMP_SPEED)
  end
  self.bobTouching = touching
end

function RopeRock:updateSwing(ts)
  local steps = math.max(1, math.ceil(ts))
  local dt = ts / steps
  local omega2 = SWING_GRAVITY / self.ropeLength
  for _ = 1, steps do
    self.angVel = (self.angVel - omega2 * math.sin(self.angle) * dt) * SWING_DAMPING ^ dt
    self.angle = self.angle + self.angVel * dt
  end
  local limit = math.rad(MAX_SWING_DEGREES)
  if math.abs(self.angle) > limit then
    self.angle = limit * (self.angle > 0 and 1 or -1)
    self.angVel = 0
  end
  -- The rock hangs off the end of the rope, level.
  local ex, ey = self:ropeEnd()
  self.pos.x, self.pos.y = ex + self.offX, ey + self.offY
end

----------------------------------------------------------------------
-- Falling
----------------------------------------------------------------------

-- The highest thing below the rock's bottom edge that it reaches moving
-- from prevBottom down to newBottom: a ledge (any of the level's walkable
-- surfaces), the top of a wall (another rock included), or the dome's own
-- floor. Nil if nothing.
function RopeRock:floorBetween(prevBottom, newBottom)
  local best = nil
  local deck = self.dome and self.dome.trueSurfaceY and self.dome:trueSurfaceY()
  if deck and deck >= prevBottom - 0.01 and deck <= newBottom + 0.01 then best = deck end
  local xs = { self.pos.x - self.halfWidth + 4, self.pos.x, self.pos.x + self.halfWidth - 4 }
  for _, shape in ipairs(self.level.shapes or {}) do
    if shape.findLandingCrossing then
      for _, x in ipairs(xs) do
        local hit = shape:findLandingCrossing(x, prevBottom, x, newBottom + 0.01)
        if hit and hit.point.y >= prevBottom - 0.01 and hit.point.y <= newBottom + 0.01 then
          if not best or hit.point.y < best then best = hit.point.y end
        end
      end
    end
  end
  for _, w in ipairs(self.level.walls or {}) do
    if w ~= self.wall and w.isWall then
      local wTop = w.pos.y - w.halfHeight
      if math.abs(w.pos.x - self.pos.x) < w.halfWidth + self.halfWidth - 2
          and wTop >= prevBottom - 0.01 and wTop <= newBottom + 0.01 then
        if not best or wTop < best then best = wTop end
      end
    end
  end
  return best
end

function RopeRock:updateFall(ts)
  self.vel.y = math.min(MAX_FALL_SPEED, self.vel.y + self.gravity * ts)
  local prevBottom = self.pos.y + self.halfHeight
  local newBottom = prevBottom + self.vel.y * ts
  local floor = self.vel.y >= 0 and self:floorBetween(prevBottom, newBottom)
  if floor then
    newBottom = floor
    self.vel.y = 0
  end
  self.vel.x = 0
  self.pos.y = newBottom - self.halfHeight
end

----------------------------------------------------------------------

-- Call once a frame, before the player moves (so he's carried along).
function RopeRock:update(ts)
  self:checkFireballs(ts)
  self:updateBurn(ts)

  if self.recalling then
    -- Being rewound (see Recall.lua) moves it itself.
    self.wasRecalling = true
  else
    if self.wasRecalling and self.hanging then
      -- Back from a rewind on its rope: carry on swinging from wherever it
      -- was left (as near as the rope allows), at rest.
      self.angle = math.atan2(self.pos.x - self.offX - self.top.x, self.pos.y - self.offY - self.top.y)
      self.angVel = 0
    end
    self.wasRecalling = false
    if self.hanging then
      self:checkBump()
      self:updateSwing(ts)
    else
      self:updateFall(ts)
    end
  end
  self:placeSurface()
end

----------------------------------------------------------------------
-- Drawing
----------------------------------------------------------------------

-- Both the rope and the rock are drawn as one quad each through a
-- shader (below), in their own local space — so the rope's twist and
-- the rock's texture move with them as they swing and fall, rather than
-- sliding about underneath.

local NOISE_GLSL = [[
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  vec2 hash2(vec2 p) {
    return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
  }
  // Gradient noise, 0..1 — not value noise, whose slope goes flat along
  // every grid line, which shows up as squares once it's lit as bumps.
  float grad(vec2 i, vec2 f) { return dot(hash2(i) * 2.0 - 1.0, f); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float n = mix(mix(grad(i, f), grad(i + vec2(1.0, 0.0), f - vec2(1.0, 0.0)), u.x),
                  mix(grad(i + vec2(0.0, 1.0), f - vec2(0.0, 1.0)), grad(i + vec2(1.0, 1.0), f - vec2(1.0, 1.0)), u.x), u.y);
    return n * 0.7 + 0.5;
  }
  // (Each octave turned, so their grids don't line up either.)
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int k = 0; k < 4; k++) {
      v += a * noise(p);
      p = mat2(1.6, 1.2, -1.2, 1.6) * p + vec2(1.7, 9.2);
      a *= 0.5;
    }
    return v;
  }
]]

-- The rope: strands twisting round it, so they cross it on the diagonal
-- (each one shaded as a little cylinder, with dark grooves between),
-- fine fibres running along them, and the whole rope shaded round.
-- Charred where it's burning, glowing at the char's edges.
--
-- uv.x runs along it from the top (where it's tied) to the rock; uv.y
-- across.
local ROPE_DRAW_WIDTH = 8    -- world units (its hit reach is ROPE_HIT_REACH)
local ROPE_PITCH = 9         -- world units along it from one strand to the next
local CHAR_HALF = 14         -- world units of char either side of the flame

local ropeShader = nil
local function getRopeShader()
  if ropeShader then return ropeShader end
  ropeShader = love.graphics.newShader(NOISE_GLSL .. [[
    extern number len;
    extern number width;
    extern number pitch;
    extern number burnAt;     // world units along it, or < 0 if it isn't burning
    extern number charHalf;
    extern number time;
    extern vec3 ropeColor;
    extern vec3 darkColor;
    extern vec3 charColor;

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      float s = uv.x * len;
      float v = uv.y * 2.0 - 1.0;            // -1..1 across
      float y = v * width * 0.5;

      // The strands, slanting across it.
      float along = s + y * 1.3;
      float phase = fract(along / pitch);
      float strand = sin(phase * 3.14159);   // 0 in a groove .. 1 mid-strand
      float roundness = sqrt(max(0.0, 1.0 - v * v));
      float fibre = noise(vec2(along * 0.8, (s - y * 0.8) * 0.12));

      float light = (0.35 + 0.65 * strand) * (0.5 + 0.5 * roundness);
      vec3 c = ropeColor * light * (0.85 + 0.3 * fibre);
      c += vec3(1.0, 0.9, 0.7) * pow(strand, 8.0) * smoothstep(0.4, -0.6, v) * 0.18;  // a sheen up one side
      c = mix(c, darkColor, smoothstep(0.72, 1.0, abs(v)) * 0.8);                       // its edges

      if (burnAt >= 0.0) {
        float k = 1.0 - smoothstep(charHalf - 4.0, charHalf, abs(s - burnAt));
        c = mix(c, charColor * (0.6 + 0.6 * strand), k);
        float ember = k * (1.0 - k) * 4.0 * (0.6 + 0.4 * sin(time * 17.0 + s * 0.7));
        c += vec3(1.0, 0.35, 0.05) * ember * strand;
      }

      float a = 1.0 - smoothstep(0.88, 1.0, abs(v));
      return vec4(c, a) * color;
    }
  ]])
  return ropeShader
end

-- The rock: hewn stone. A slightly lumpy outline, mottled colour and
-- fine grit, a bumpy surface lit from the upper left, bevelled edges
-- (lit along the top and left, shadowed along the bottom and right), a
-- network of cracks, and a dark rim.
--
-- Quad space: world units from the rock's middle, with `pad` to spare
-- round it for the antialiased edge.
local ROCK_PAD = 3
local ROCK_BEVEL = 7         -- world units its edges are rounded over

local rockShader = nil
local function getRockShader()
  if rockShader then return rockShader end
  rockShader = love.graphics.newShader(NOISE_GLSL .. [[
    extern vec2 halfSize;
    extern number corner;
    extern number pad;
    extern number bevel;
    extern number seed;
    extern vec3 darkColor;
    extern vec3 lightColor;
    extern vec3 rimColor;

    float sdRect(vec2 p) {
      vec2 q = abs(p) - halfSize + corner;
      return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - corner;
    }

    // How near the nearest crack — the edges between Voronoi cells.
    float crackDist(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      float d1 = 8.0;
      float d2 = 8.0;
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec2 g = vec2(float(x), float(y));
          vec2 o = hash2(i + g + seed);
          float d = length(g + o - f);
          if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
        }
      }
      return d2 - d1;
    }

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec2 p = (uv * 2.0 - 1.0) * (halfSize + pad);

      float d = sdRect(p) + (noise(p * 0.09 + seed) - 0.5) * 2.5;   // a little lumpy
      float aa = max(fwidth(d), 0.001);
      float alpha = 1.0 - smoothstep(-aa, aa, d);
      if (alpha <= 0.0) return vec4(0.0);

      // Its colour: mottled, with fine grit.
      float n = fbm(p * 0.045 + seed);
      float grit = noise(p * 0.35 - seed);
      vec3 base = mix(darkColor, lightColor, n) * (0.88 + 0.24 * grit);

      // Its surface: bumps from noise, and the edges bevelled over.
      float h0 = fbm(p * 0.11 + seed * 1.3);
      float hx = fbm((p + vec2(1.0, 0.0)) * 0.11 + seed * 1.3);
      float hy = fbm((p + vec2(0.0, 1.0)) * 0.11 + seed * 1.3);
      vec2 bump = vec2(hx - h0, hy - h0) * 5.0;
      vec2 grad = vec2(sdRect(p + vec2(0.5, 0.0)) - sdRect(p - vec2(0.5, 0.0)),
                       sdRect(p + vec2(0.0, 0.5)) - sdRect(p - vec2(0.0, 0.5)));
      grad /= max(length(grad), 1e-4);
      float edge = 1.0 - smoothstep(0.0, bevel, -d);
      vec2 nxy = grad * edge * 0.95 - bump;
      float nl = length(nxy);
      if (nl > 0.95) nxy *= 0.95 / nl;
      vec3 N = vec3(nxy, sqrt(1.0 - dot(nxy, nxy)));
      vec3 L = normalize(vec3(-0.45, -0.75, 0.7));
      float light = 0.4 + 0.8 * max(dot(N, L), 0.0);
      vec3 c = base * light;

      // Cracks: dark, with a faint lit lip on one side.
      // (Only some of the cell edges crack — the rest fade out.)
      float cd = crackDist(p * 0.024 + seed * 0.1);
      float mask = smoothstep(0.42, 0.6, noise(p * 0.03 + seed * 2.0)) * smoothstep(1.0, 6.0, -d);
      float crack = (1.0 - smoothstep(0.01, 0.04, cd)) * mask;
      float lip = (smoothstep(0.04, 0.07, cd) - smoothstep(0.07, 0.12, cd)) * mask;
      c *= 1.0 - crack * 0.65;
      c += vec3(0.06) * lip * max(dot(N, L), 0.0);

      // A little darker toward the bottom, and the dark rim.
      c *= mix(1.0, 0.82, smoothstep(-halfSize.y, halfSize.y, p.y));
      c = mix(c, rimColor, smoothstep(-2.5, -0.5, d));
      return vec4(c, alpha) * color;
    }
  ]])
  return rockShader
end

-- A 1x1 white pixel: the quad the shaders are drawn on.
local pixelImage = nil
local function getPixel()
  if pixelImage then return pixelImage end
  local data = love.image.newImageData(1, 1)
  data:setPixel(0, 0, 1, 1, 1, 1)
  pixelImage = love.graphics.newImage(data)
  return pixelImage
end

function RopeRock:drawRope()
  local ex, ey = self:ropeEnd()
  local dx, dy = ex - self.top.x, ey - self.top.y
  local len = math.sqrt(dx * dx + dy * dy)
  if len < 1 then return end
  local dirX, dirY = dx / len, dy / len
  local perpX, perpY = -dirY, dirX

  local s = getRopeShader()
  s:send("len", len)
  s:send("width", ROPE_DRAW_WIDTH)
  s:send("pitch", ROPE_PITCH)
  s:send("burnAt", self.burn and self.burn.at * len or -1)
  s:send("charHalf", CHAR_HALF)
  s:send("time", love.timer.getTime())
  s:send("ropeColor", COLOR_ROPE)
  s:send("darkColor", COLOR_ROPE_DARK)
  s:send("charColor", COLOR_ROPE_CHAR)
  love.graphics.setShader(s)
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(getPixel(), self.top.x - perpX * ROPE_DRAW_WIDTH / 2, self.top.y - perpY * ROPE_DRAW_WIDTH / 2,
    math.atan2(dirY, dirX), len, ROPE_DRAW_WIDTH)
  love.graphics.setShader()

  -- The flame itself, rising off it (see lua/effects/Flame.lua).
  if self.burn then
    local fx, fy = self:flamePoint(self.burn.at)
    local t = love.timer.getTime()
    Flame.draw(fx, fy - 4, 7 * (1 + 0.08 * math.sin(t * 31)), math.pi / 2, 1.8, t, self.seed)
  end
end

function RopeRock:drawRock()
  local s = getRockShader()
  s:send("halfSize", { self.halfWidth, self.halfHeight })
  s:send("corner", math.min(ROCK_CORNER, self.halfWidth, self.halfHeight))
  s:send("pad", ROCK_PAD)
  s:send("bevel", ROCK_BEVEL)
  s:send("seed", self.seed)
  s:send("darkColor", COLOR_ROCK_SPOT)
  s:send("lightColor", COLOR_ROCK_TOP)
  s:send("rimColor", COLOR_ROCK_EDGE)
  love.graphics.setShader(s)
  love.graphics.setColor(1, 1, 1, 1)
  local w, h = (self.halfWidth + ROCK_PAD) * 2, (self.halfHeight + ROCK_PAD) * 2
  love.graphics.draw(getPixel(), self.pos.x - w / 2, self.pos.y - h / 2, 0, w, h)
  love.graphics.setShader()
end

function RopeRock:draw()
  love.graphics.push("all")
  if not self.burnedAway then self:drawRope() end
  self:drawRock()
  love.graphics.pop()
end

return RopeRock
