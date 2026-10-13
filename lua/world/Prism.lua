-- lua/world/Prism.lua
--
-- A tall crystal prism (img/mining.png, state.miningTexture — and
-- state.miningDamagedTextures, the same prism more and more broken, as
-- its cluster is shot) sticking out of a planetoid. Purely scenery: no collision of its own, he walks
-- straight past in front of it.
--
-- Its foot is SUNK below the planetoid's surface and the whole thing is
-- drawn BEFORE the planetoid (see main.lua's love.draw), so the
-- planetoid's own body covers the bottom of it and it reads as planted
-- in the ground rather than balanced on top.
--
-- Prisms differ in how much of them shows, never in scale: the image is
-- always drawn at the same size, and a shorter prism is simply the same
-- image with more of its BOTTOM cut off (the pointed top is always
-- whole).

local state = require("lua.state")

local Prism = {}
Prism.__index = Prism

Prism.FULL_HEIGHT = 236   -- world units the whole image would stand, top to bottom (its width follows from the image's own proportions)
Prism.MIN_SINK = 23       -- at least this much of it is below the surface, hidden behind the planetoid (less for a scaled-down prism, in proportion)
Prism.SINK_MARGIN = 4     -- how far inside the planetoid's edge the foot's corners are kept

-- The two ends of the red its faces are painted in (see faceColors):
-- a face turned squarely toward the sun, and one turned squarely away.
Prism.LIT_COLOR = { 1.0, 0.30, 0.26 }
Prism.SHADOW_COLOR = { 0.42, 0.0, 0.04 }

-- A gradient along the part of it that shows, on top of that: darkest
-- where it comes out of the ground, lightening up to its own untouched
-- color at the tip.
Prism.BASE_BRIGHTNESS = 0.45 -- how bright it is right at the surface (1: no darkening at all)

-- What makes it read as glass rather than painted stone (all done in
-- the shader — see getFaceShader). Each of the three lights is brighter
-- on a face the more that face is turned toward the sun.
Prism.FACE_OPACITY = 0.8          -- how solid the flat of a face is (1: not see-through at all). The outlines and the lights below stay solid.
Prism.OUTLINE_BRIGHTNESS = 0.3    -- the outlines: this fraction of the face color they border, rather than black (0: black)
Prism.GLINT_COLOR = { 1.0, 0.82, 0.8 } -- the color of all three lights
Prism.RIM_STRENGTH = 0.45         -- light gathered along every edge of a face, fading toward its middle
Prism.RIM_WIDTH = 3.0             -- how far in from an edge that reaches (each +1 roughly doubles it)
Prism.SHEEN_STRENGTH = 0.3        -- slanted bands of reflection crossing the faces
Prism.SHEEN_SPACING = 1.9         -- prism-widths from one pair of bands to the next
Prism.SHEEN_SLANT = 0.55          -- how steeply the bands cross (0: straight along the prism)
Prism.CORE_STRENGTH = 0.22        -- a soft glow down the middle of each prism's width, as if lit from inside

-- How many shots it takes before every prism of a cluster is drawn as
-- each of the broken pictures in img/mining.png, in order (the second
-- picture in the file, then the third) — and stays that way.
Prism.DAMAGE_HITS = { 2, 4 }
-- And how many before the whole cluster shatters (see Prism:hit, and
-- main.lua's own breakPrismCluster for what happens then).
Prism.DESTROY_HITS = 6

-- Being shot (see Prism:hit). Every prism of the cluster lights up
-- together: a quick FLASH toward HIT_COLOR, over a slower GLOW — the
-- glass brightening from its edges and middle, and a soft halo of light
-- round the whole prism — that then fades away.
Prism.HIT_COLOR = { 1.0, 0.86, 0.8 }
Prism.HIT_FLASH_SECONDS = 0.16   -- how long the flash takes to fade
Prism.HIT_FLASH_STRENGTH = 0.8   -- how far toward HIT_COLOR it goes at the instant of the hit (1: all the way)
Prism.HIT_GLOW_SECONDS = 1.2     -- how long the glow takes to fade
Prism.HIT_GLOW_STRENGTH = 0.7    -- how much the glass itself brightens
Prism.HIT_HALO_STRENGTH = 0.6    -- how bright the halo round it is
Prism.HIT_HALO_REACH = 0.3       -- how far out from the prism's edge the halo reaches before it's gone, in prism-widths
Prism.HIT_SHIMMER = 0.18         -- how much the glow flickers while it fades (0: a steady fade)

-- The prism's actual shape, measured off img/mining.png — it doesn't
-- fill the image it's in: there's empty space down both sides, and its
-- top is a point with empty space either side of that. x as a fraction
-- of the image's width, y of its height (0,0 is the top left corner).
local SHAPE_LEFT_X = 0.019      -- its left side
local SHAPE_RIGHT_X = 0.976     -- its right side
local SHAPE_APEX_X = 0.519      -- the very tip
local SHAPE_APEX_Y = 0.018
local SHAPE_SHOULDER_Y = 0.175  -- where the straight sides end and the point begins

-- What a shot can actually hit, from the same shape.
local BODY_WIDTH_FRACTION = SHAPE_RIGHT_X - SHAPE_LEFT_X
local TIP_HEIGHT_FRACTION = SHAPE_SHOULDER_Y - SHAPE_APEX_Y

-- Prisms grow in CLUSTERS (see Prism.cluster): one tall prism standing
-- straight out of the surface, a few shorter ones nestled against it,
-- and a few shorter still against those. Each range is { least, most }.
--   count           how many prisms the ring has, shared between the
--                   two sides of the tall one
--   heightFraction  its height, as a fraction of the prism it's nestled
--                   against (the tall one for the first ring, one of the
--                   first ring's for the second). It's that prism
--                   SCALED DOWN by this much, width and all — not the
--                   same width cut shorter, which looked stubby.
--   distance        how far round the surface from the tall prism it
--                   stands, in world units
--   lean            degrees it leans away from the tall prism — measured
--                   against the tall prism's own direction, not against
--                   the ground where it stands
Prism.CLUSTER_CENTER_LENGTH = { 161, 199 } -- world units of the tall prism showing above the surface
Prism.CLUSTER_RINGS = {
  { count = { 2, 3 }, heightFraction = { 0.5, 0.75 }, distance = { 21, 33 }, lean = { 6, 13 } },
  { count = { 2, 4 }, heightFraction = { 0.5, 0.75 }, distance = { 38, 54 }, lean = { 13, 22 } },
}
-- How far a cluster may land from the middle of its own share of the
-- planetoid (see Prism.scatterClusters), as a fraction of that share.
Prism.CLUSTER_PLACEMENT_JITTER = 0.25

-- How deep the foot has to go for both of its corners to stay hidden
-- inside the planetoid: a prism standing straight needs little, a
-- leaning one swings a corner back up toward the surface and needs more.
-- Worked out in the frame where the planetoid's center is the origin and
-- the prism leaves the surface at (radius, 0).
local function sinkDepthFor(radius, halfWidth, tilt, minSink)
  local cosT, sinT = math.cos(tilt), math.sin(tilt)
  local limit = radius - Prism.SINK_MARGIN
  local sink = minSink
  while sink < radius do
    local footX, footY = radius - sink * cosT, -sink * sinT
    local hidden = true
    for side = -1, 1, 2 do
      local cx, cy = footX - side * halfWidth * sinT, footY + side * halfWidth * cosT
      if cx * cx + cy * cy > limit * limit then hidden = false end
    end
    if hidden then break end
    sink = sink + 2
  end
  return sink
end

-- planet: the planetoid it stands on. angle: where round it (radians,
-- same convention as the player's own angle — -pi/2 is the top).
--
-- options (all optional):
--   tilt    radians it leans away from standing straight out of the
--           surface (positive leans clockwise). 0 by default.
--   length  world units of it showing above the surface. As much as the
--           image allows by default, and never more than that.
--   size    how big the whole prism is drawn, width and all, as a
--           fraction of the ordinary size. 1 by default.
function Prism.new(planet, angle, options)
  options = options or {}
  local self = setmetatable({}, Prism)
  self.planet = planet
  self.angle = angle or -math.pi / 2
  self.tilt = options.tilt or 0
  -- Where along it its bands of sheen fall (see getFaceShader) — taken
  -- from where it stands, so each prism's are somewhere different.
  self.sheenShift = (self.angle * 7.31) % 1

  local img = state.miningTexture
  local imgW, imgH = img:getDimensions()
  self.size = options.size or 1
  local fullHeight = Prism.FULL_HEIGHT * self.size
  self.scale = fullHeight / imgH
  local sink = sinkDepthFor(planet.radius, imgW * self.scale / 2, self.tilt, Prism.MIN_SINK * self.size)
  self.length = math.min(options.length or fullHeight, fullHeight - sink)

  -- The top of the image, down as far as the sunken foot — the rest of
  -- the bottom is left off. lengthPx is where the surface crosses it.
  self.lengthPx = self.length / self.scale
  self.quad = love.graphics.newQuad(0, 0, imgW, (self.length + sink) / self.scale, imgW, imgH)

  -- The same piece with empty space added round its sides and top, for
  -- the halo to spread into when it's hit (see Prism:draw).
  self.haloPadPx = imgW * Prism.HIT_HALO_REACH
  self.haloQuad = love.graphics.newQuad(-self.haloPadPx, -self.haloPadPx,
    imgW + self.haloPadPx * 2, (self.length + sink) / self.scale + self.haloPadPx, imgW, imgH)

  -- For Prism:containsPoint.
  self.halfWidth = imgW * self.scale * BODY_WIDTH_FRACTION / 2
  self.tipHeight = math.min(fullHeight * TIP_HEIGHT_FRACTION, self.length)

  -- What lights up together when any one of them is shot. A prism made
  -- on its own is a group of one; Prism.cluster puts all of its prisms
  -- in the same one. hitAge: seconds since it was last hit, nil if it
  -- isn't lit at the moment. hits: how many times it's been hit in all.
  self.group = { prisms = { self }, hitAge = nil, hits = 0 }

  return self
end

local function randomIn(range)
  return range[1] + math.random() * (range[2] - range[1])
end

-- One cluster of prisms round `planet`, its tall middle prism standing
-- at `angle` — see Prism.CLUSTER_RINGS. Returned in drawing order: the
-- tall one first, then each ring out from it, so the shorter prisms
-- sit in front of the taller ones they're nestled against.
function Prism.cluster(planet, angle)
  local center = Prism.new(planet, angle, { length = randomIn(Prism.CLUSTER_CENTER_LENGTH) })
  local prisms = { center }

  -- The prisms of the ring before, per side (-1, 1) — what the next
  -- ring's own are measured against.
  local inner = { [-1] = { center }, [1] = { center } }
  for _, ring in ipairs(Prism.CLUSTER_RINGS) do
    local placed = { [-1] = {}, [1] = {} }
    local side = math.random() < 0.5 and -1 or 1
    for _ = 1, math.random(ring.count[1], ring.count[2]) do
      local neighbors = inner[side]
      local neighbor = neighbors[math.random(#neighbors)]
      local offset = randomIn(ring.distance) / planet.radius -- round the surface, as an angle
      local fraction = randomIn(ring.heightFraction)
      local prism = Prism.new(planet, angle + side * offset, {
        -- Standing straight out of the ground there would already turn
        -- it `offset` away from the tall prism, so that much is taken
        -- back out to leave just the lean.
        tilt = side * (math.rad(randomIn(ring.lean)) - offset),
        length = neighbor.length * fraction,
        size = neighbor.size * fraction,
      })
      prism.group = center.group
      table.insert(prisms, prism)
      table.insert(placed[side], prism)
      side = -side -- alternating, so both sides of the tall one get some
    end
    for s = -1, 1, 2 do
      if #placed[s] > 0 then inner[s] = placed[s] end
    end
  end
  center.group.prisms = prisms
  return prisms
end

-- `count` clusters spread round `planet`: it's cut into `count` equal
-- shares with one cluster near the middle of each, so they neither pile
-- up nor leave a wide bare stretch. Where the first share starts is
-- random. Returns every prism of every cluster, in drawing order.
function Prism.scatterClusters(planet, count)
  local prisms = {}
  local share = math.pi * 2 / count
  local start = math.random() * math.pi * 2
  for i = 1, count do
    local jitter = (math.random() * 2 - 1) * Prism.CLUSTER_PLACEMENT_JITTER
    for _, prism in ipairs(Prism.cluster(planet, start + (i - 0.5 + jitter) * share)) do
      table.insert(prisms, prism)
    end
  end
  return prisms
end

-- How far it can reach from the planetoid's center — for viewport culling.
function Prism:reach()
  return self.planet.radius + Prism.FULL_HEIGHT
end

-- Where it leaves the surface, and the way it's turned (the rotation
-- its image is drawn at: 0 is pointing straight up the screen) — right
-- now: self.angle is its place on the planetoid, and a planetoid that
-- turns (rotationAngle — see CrystalPlanet.lua) carries it round.
function Prism:placement()
  local planet = self.planet
  local angle = self.angle + (planet.rotationAngle or 0)
  return planet.pos.x + math.cos(angle) * planet.radius,
    planet.pos.y + math.sin(angle) * planet.radius,
    angle + math.pi / 2 + self.tilt
end

-- Whether the world point x, y is inside the part of it that shows
-- above the ground — or within `margin` of it (a fireball's radius).
-- Its shape is taken as a straight-sided bar narrowing to a point over
-- its tip.
function Prism:containsPoint(x, y, margin)
  margin = margin or 0
  local baseX, baseY, rotation = self:placement()
  local dx, dy = x - baseX, y - baseY
  local cosR, sinR = math.cos(rotation), math.sin(rotation)
  local across = dx * cosR + dy * sinR -- toward the prism's own right
  local along = dx * sinR - dy * cosR  -- from the ground toward its tip
  if along < 0 or along > self.length + margin then return false end
  local halfWidth = self.halfWidth
  local fromTip = self.length - along
  if fromTip < self.tipHeight then
    halfWidth = halfWidth * math.max(0, fromTip) / self.tipHeight
  end
  return math.abs(across) <= halfWidth + margin
end

-- The first of `prisms` the point is inside (see containsPoint), or nil.
function Prism.findAt(prisms, x, y, margin)
  for _, prism in ipairs(prisms) do
    if prism:containsPoint(x, y, margin) then return prism end
  end
  return nil
end

-- It's been shot: its whole cluster flashes and glows (see
-- Prism.HIT_COLOR and the values after it). Hitting one that's still
-- glowing just starts it over. Enough hits also break the cluster
-- further (see Prism.DAMAGE_HITS).
--
-- Returns true if that was the hit that shatters the cluster
-- (Prism.DESTROY_HITS) — the caller takes it from there.
function Prism:hit()
  local group = self.group
  group.hitAge = 0
  group.hits = group.hits + 1
  return group.hits >= Prism.DESTROY_HITS
end

-- The world point `fraction` of the way from where it leaves the
-- ground (0) to its tip (1), and the unit direction it points in.
function Prism:pointAlong(fraction)
  local baseX, baseY, rotation = self:placement()
  local dirX, dirY = math.sin(rotation), -math.cos(rotation)
  return baseX + dirX * self.length * fraction, baseY + dirY * self.length * fraction, dirX, dirY
end

-- How broken its cluster is: 0 whole, then 1 for each entry of
-- Prism.DAMAGE_HITS it has been hit enough for.
function Prism:damageStage()
  local stage = 0
  for i, hits in ipairs(Prism.DAMAGE_HITS) do
    if self.group.hits >= hits then stage = i end
  end
  return stage
end

-- dt: seconds. Call for every prism each frame; a cluster's glow is
-- shared, and only its first prism moves it along.
function Prism:update(dt)
  local group = self.group
  if group.prisms[1] ~= self or not group.hitAge then return end
  group.hitAge = group.hitAge + dt
  if group.hitAge >= math.max(Prism.HIT_FLASH_SECONDS, Prism.HIT_GLOW_SECONDS) then
    group.hitAge = nil
  end
end

-- How strongly it's flashing and glowing right now, each 0..1.
function Prism:hitLight()
  local age = self.group.hitAge
  if not age then return 0, 0 end
  local flash = math.max(0, 1 - age / Prism.HIT_FLASH_SECONDS)
  local fade = math.max(0, 1 - age / Prism.HIT_GLOW_SECONDS)
  local shimmer = 1 - Prism.HIT_SHIMMER * (0.5 + 0.5 * math.sin(age * 38 + self.sheenShift * 6.28))
  return flash, fade * fade * shimmer
end

-- The halo round a prism that's been hit: light that ADDS to whatever
-- is behind it, brightest against the prism's edge and fading to
-- nothing HIT_HALO_REACH out from it.
--
-- "Out from it" is measured from the prism's real outline — its two
-- straight sides and the two slopes of its point (see SHAPE_LEFT_X and
-- the values after it) — worked out in the shader as the distance from
-- each pixel to that five-cornered shape. Not from the image: the image
-- is a rectangle with the prism inside it, and a halo taken from a
-- blurred copy of it came out as a rectangle too, with nothing of the
-- point left. (The shape is taken to carry on down forever; its foot is
-- behind the planetoid anyway.)
--
-- Drawn on a piece of the image with empty space added round it (see
-- haloQuad) so there's room for it — uv simply runs on past 0..1 there.
-- p is the pixel in prism-widths, so distances are in those too.
local haloShader = nil
local function getHaloShader()
  if haloShader then return haloShader end
  haloShader = love.graphics.newShader([[
    extern vec3 haloColor;
    extern float strength;
    extern float reach;      // prism-widths
    extern float aspect;     // the image's height / width
    extern float leftX;
    extern float rightX;
    extern float apexX;
    extern float apexY;
    extern float shoulderY;

    // Distance from p to the segment a-b.
    float toSegment(vec2 p, vec2 a, vec2 b) {
      vec2 ab = b - a;
      float t = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0);
      return length(p - a - ab * t);
    }

    // Which side of the line a->b the point is on (positive: its left).
    float side(vec2 p, vec2 a, vec2 b) {
      return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    }

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec2 p = vec2(uv.x, uv.y * aspect);
      float far = 1000.0;
      vec2 bottomLeft = vec2(leftX, far);
      vec2 shoulderLeft = vec2(leftX, shoulderY * aspect);
      vec2 apex = vec2(apexX, apexY * aspect);
      vec2 shoulderRight = vec2(rightX, shoulderY * aspect);
      vec2 bottomRight = vec2(rightX, far);

      float d = min(min(toSegment(p, bottomLeft, shoulderLeft), toSegment(p, shoulderLeft, apex)),
                    min(toSegment(p, apex, shoulderRight), toSegment(p, shoulderRight, bottomRight)));
      // Inside it (the same side of all four edges, going round): no distance at all.
      if (side(p, bottomLeft, shoulderLeft) > 0.0 && side(p, shoulderLeft, apex) > 0.0
          && side(p, apex, shoulderRight) > 0.0 && side(p, shoulderRight, bottomRight) > 0.0) {
        d = 0.0;
      }

      float fade = 1.0 - clamp(d / reach, 0.0, 1.0);
      return vec4(haloColor, fade * fade * strength) * color;
    }
  ]])
  return haloShader
end

-- Sun shading. img/mining.png is painted as a key, not in its final
-- colors: the faces on the prism's LEFT side are pure blue (0,0,255),
-- the ones on its RIGHT pure red (255,0,0), outlined in black. The
-- shader repaints both sides red, each in its own shade — given per
-- prism, per frame, from which of the two sides is turned toward the
-- sun (see faceColors below). Pixels are sorted by how blue vs. how red
-- they are, so the soft edge between two faces blends between the two
-- shades. The black outlines (neither) become a dark shade of the face
-- they border.
--
-- It also applies the base-to-tip gradient (see
-- Prism.BASE_BRIGHTNESS). surfaceV is how far down the image (0 top, 1
-- bottom) this prism meets the ground — it differs per prism, since a
-- shorter one has more of the image's bottom cut off — so the gradient
-- always runs the full visible length, whatever that is.
--
-- And the glass (see Prism.FACE_OPACITY and the values after it):
--   rim    A heavily blurred copy of the image (a small mipmap of it,
--          via Texel's bias) is solid in the middle of a face and thins
--          out near any outline or the prism's own silhouette — so
--          "how thin" is "how close to an edge", and that's where the
--          rim light goes.
--   sheen  A wide band and a thin one, slanted across the prism and
--          repeating along it. sheenShift slides them along, so no two
--          prisms have theirs in the same place.
--   core   Brightest on the prism's center line, gone by its sides.
-- The flat of a face is slightly see-through; wherever one of those
-- lights or an outline falls, it's solid again.
--
-- And being shot (see Prism.HIT_COLOR and the values after it): hitGlow
-- brightens the glass, most along its edges and down its middle;
-- hitFlash then pushes the whole thing toward hitColor.
local faceShader = nil
local function getFaceShader()
  if faceShader then return faceShader end
  faceShader = love.graphics.newShader([[
    extern vec3 leftColor;
    extern vec3 rightColor;
    extern float leftLit;        // 0..1: how squarely each side faces the sun
    extern float rightLit;
    extern float surfaceV;
    extern float baseBrightness;
    extern float faceOpacity;
    extern float outlineBrightness;
    extern vec3 glintColor;
    extern float rimStrength;
    extern float rimWidth;
    extern float sheenStrength;
    extern float sheenSpacing;
    extern float sheenSlant;
    extern float sheenShift;
    extern float coreStrength;
    extern float aspect;         // the image's height / width
    extern vec3 hitColor;
    extern float hitFlash;       // 0..1, already scaled by its strength
    extern float hitGlow;

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec4 texel = Texel(tex, uv);
      float leftness = texel.b / max(texel.b + texel.r, 0.0001);
      vec3 face = mix(rightColor, leftColor, leftness);
      float lit = mix(rightLit, leftLit, leftness);
      float ink = max(texel.b, texel.r); // 0 on the outlines

      float up = clamp(1.0 - uv.y / surfaceV, 0.0, 1.0); // 0 at the ground, 1 at the tip
      float brightness = mix(baseBrightness, 1.0, up);
      vec3 body = face * brightness;

      vec4 soft = Texel(tex, uv, rimWidth);
      float rim = smoothstep(0.0, 0.6, 1.0 - max(soft.b, soft.r) * soft.a);

      float along = fract((uv.x + uv.y * aspect * sheenSlant) / sheenSpacing + sheenShift);
      float sheen = smoothstep(0.0, 0.03, along) * (1.0 - smoothstep(0.12, 0.15, along))
        + 0.6 * smoothstep(0.20, 0.215, along) * (1.0 - smoothstep(0.235, 0.25, along));

      float core = 1.0 - smoothstep(0.0, 0.5, abs(uv.x - 0.5));

      float glint = (rim * rimStrength + sheen * sheenStrength + core * coreStrength)
        * (0.35 + 0.65 * lit) * brightness;

      vec3 rgb = body * mix(outlineBrightness, 1.0, ink) + glintColor * glint * mix(0.4, 1.0, ink);
      float opacity = mix(faceOpacity, 1.0, clamp(glint * 1.5 + (1.0 - ink), 0.0, 1.0));

      rgb += hitColor * hitGlow * (0.25 + 0.6 * rim + 0.4 * core);
      rgb = mix(rgb, hitColor, hitFlash);
      opacity = mix(opacity, 1.0, max(hitFlash, hitGlow * 0.6));
      return vec4(rgb, texel.a * opacity) * color;
    }
  ]])
  return faceShader
end

-- The colors for the left and right faces of a prism whose own "right"
-- (the image's +x, once it's turned into place) points along
-- rightX, rightY, standing at x, y. A side turned squarely at the sun
-- gets Prism.LIT_COLOR, one turned squarely away Prism.SHADOW_COLOR,
-- and anything between is a blend — so a prism pointing straight at
-- the sun, or straight away from it, has both sides the same middle
-- shade. Also returns those two blend amounts themselves (0 fully in
-- shadow, 1 fully lit), left then right.
local function faceColors(x, y, rightX, rightY)
  local facing = 0 -- 1: the right side faces the sun dead on; -1: the left side does
  local sun = state.sun
  if sun and sun.pos then
    local dx, dy = sun.pos.x - x, sun.pos.y - y
    local dist = math.sqrt(dx * dx + dy * dy)
    if dist > 0 then facing = (dx * rightX + dy * rightY) / dist end
  end
  local lit, shadow = Prism.LIT_COLOR, Prism.SHADOW_COLOR
  local function shade(t) -- t: 0 fully in shadow, 1 fully lit
    return {
      shadow[1] + (lit[1] - shadow[1]) * t,
      shadow[2] + (lit[2] - shadow[2]) * t,
      shadow[3] + (lit[3] - shadow[3]) * t,
    }
  end
  local leftLit, rightLit = 0.5 - 0.5 * facing, 0.5 + 0.5 * facing
  return shade(leftLit), shade(rightLit), leftLit, rightLit
end

function Prism:draw()
  -- Every picture is the same size, so everything worked out from the
  -- whole one (the quads, the scale) fits the others.
  local img = state.miningDamagedTextures[self:damageStage()] or state.miningTexture
  if not img then return end
  local x, y, rotation = self:placement()
  local flash, glow = self:hitLight()

  -- The halo first, so the prism itself is drawn over the middle of it.
  if glow > 0 then
    local halo = getHaloShader()
    halo:send("haloColor", Prism.HIT_COLOR)
    halo:send("strength", glow * Prism.HIT_HALO_STRENGTH)
    halo:send("reach", Prism.HIT_HALO_REACH)
    halo:send("aspect", img:getHeight() / img:getWidth())
    halo:send("leftX", SHAPE_LEFT_X)
    halo:send("rightX", SHAPE_RIGHT_X)
    halo:send("apexX", SHAPE_APEX_X)
    halo:send("apexY", SHAPE_APEX_Y)
    halo:send("shoulderY", SHAPE_SHOULDER_Y)
    love.graphics.setColor(1, 1, 1, 1)
    love.graphics.setBlendMode("add", "alphamultiply")
    love.graphics.setShader(halo)
    love.graphics.draw(img, self.haloQuad, x, y, rotation, self.scale, self.scale,
      img:getWidth() / 2 + self.haloPadPx, self.lengthPx + self.haloPadPx)
    love.graphics.setShader()
    love.graphics.setBlendMode("alpha")
  end

  local shader = getFaceShader()
  local leftColor, rightColor, leftLit, rightLit = faceColors(x, y, math.cos(rotation), math.sin(rotation))
  shader:send("leftColor", leftColor)
  shader:send("rightColor", rightColor)
  shader:send("leftLit", leftLit)
  shader:send("hitColor", Prism.HIT_COLOR)
  shader:send("hitFlash", flash * Prism.HIT_FLASH_STRENGTH)
  shader:send("hitGlow", glow * Prism.HIT_GLOW_STRENGTH)
  shader:send("rightLit", rightLit)
  shader:send("surfaceV", self.lengthPx / img:getHeight())
  shader:send("baseBrightness", Prism.BASE_BRIGHTNESS)
  shader:send("faceOpacity", Prism.FACE_OPACITY)
  shader:send("outlineBrightness", Prism.OUTLINE_BRIGHTNESS)
  shader:send("glintColor", Prism.GLINT_COLOR)
  shader:send("rimStrength", Prism.RIM_STRENGTH)
  shader:send("rimWidth", Prism.RIM_WIDTH)
  shader:send("sheenStrength", Prism.SHEEN_STRENGTH)
  shader:send("sheenSpacing", Prism.SHEEN_SPACING)
  shader:send("sheenSlant", Prism.SHEEN_SLANT)
  shader:send("sheenShift", self.sheenShift)
  shader:send("coreStrength", Prism.CORE_STRENGTH)
  shader:send("aspect", img:getHeight() / img:getWidth())

  -- Origin on the image's own center line, at the point where it meets
  -- the surface — so it's placed exactly on the surface and leans about
  -- that same point.
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.setShader(shader)
  love.graphics.draw(img, self.quad, x, y, rotation, self.scale, self.scale, img:getWidth() / 2, self.lengthPx)
  love.graphics.setShader()
end

return Prism
