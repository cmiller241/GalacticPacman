-- lua/world/Lava.lua
--
-- One tile's worth of lava, drawn on its own — now just the effect
-- played over a tile of lava turning to obsidian and back (see
-- WaterSystem.lua's "Lava meeting water: obsidian"; the lava itself is a
-- liquid there, flowing like the water). A square tile (Lava.new), or
-- with Lava.newOnRing one tile of a Tiled map wrapped round a planet (see
-- CrackedPlanetoid.fromTiledMap): a curved slice of a ring, its surface
-- following the ring round and its embers rising away from the planet's
-- center.
-- Rendered as one quad with a GLSL shader, rather than the sheet's own
-- flat red tile art (skipped entirely when baking TiledTerrain's static
-- canvas — see the `role == "lava"` skip there) — the shader punches a
-- transparent hole above an animated sinusoidal surface line near the
-- top of the tile, so what's actually "lava" is only the area below
-- that wavy line.
--
-- Each tile is its own independent instance (no multi-tile merging —
-- unnecessary, since the wave's phase is driven by absolute WORLD X,
-- not a 0..1 fraction local to one draw call: two adjacent tiles each
-- computing sin(worldX * frequency + time) naturally line up at their
-- shared edge regardless of being separate draws).
--
-- Small embers spawn along that same surface line and drift upward —
-- same lightweight hand-rolled particle approach FireBar.lua's own
-- FireEmber already uses, rather than love.graphics.newParticleSystem,
-- for consistency with how every other fire-ish effect in this project
-- is built.

local state = require("lua.state")
local Vector2 = require("lua.vector2")

local Lava = {}
Lava.__index = Lava

----------------------------------------------------------------------
-- Tunables
----------------------------------------------------------------------

local WAVE_AMPLITUDE  = 4    -- world units, how far the surface bobs up/down
local WAVE_FREQUENCY  = 0.05 -- radians per world unit along X — higher means more ripples per tile
local WAVE_SPEED      = 1.4  -- radians per baseline (60fps) frame's worth of sharedTime advance
local WAVE_BASE_Y     = 16   -- world units down from the tile's own top edge where the surface sits at rest (~10 source px * TILE_SCALE)
local EDGE_SOFTNESS   = 2.5  -- world units of blur across the transparent/opaque boundary, so it doesn't look pixel-stepped
local GLOW_BAND       = 22   -- world units below the surface line the hot glow fades out over
local COLOR_DEEP      = { 0.45, 0.05, 0.02 } -- deep red, the coolest/darkest crust
local COLOR_MID       = { 0.85, 0.28, 0.03 } -- glowing orange, the body's main tone
local COLOR_HOT       = { 1.0, 0.65, 0.15 }  -- bright yellow-white, the hottest specks/surface

-- Plasma-style mottled texture over the lava's body — same fbm-noise
-- recipe as Sun.lua's own plasma shader (see the GLSL below), scaled
-- way down for a 64-unit tile instead of a whole sun. Driven by
-- absolute WORLD position (like the wave above), not tile-local
-- coordinates, so the mottling is continuous across adjacent tiles too.
local PLASMA_SCALE       = 0.05  -- spatial frequency of the coarse noise layer, per world unit
local PLASMA_DETAIL_SCALE = 2.6  -- how much finer the second (speckle) noise layer is than the coarse one
-- Both noticeably faster than Sun.lua's own 0.05/-0.12 (same sharedTime
-- units) — a sun should read as stately and slow; a puddle of lava
-- should read as actively roiling, on a much smaller/faster time scale.
local PLASMA_EVOLVE_SPEED = 0.18 -- how fast the pattern churns in place, per sharedTime unit
local PLASMA_SCROLL_SPEED = 0.06 -- horizontal drift on top of the churn, per sharedTime unit

-- Turning to obsidian (a ring tile water's got to — see :harden) and
-- back (a fireball melting it — see :melt). Over HARDEN_SECONDS the
-- surface rises flat to the tile's top, the body darkens to glassy
-- black with glowing cracks hanging on longest, then fades out over the
-- obsidian block baked underneath. Melting plays it backwards.
local HARDEN_SECONDS = 1.2
local MELT_SECONDS   = 0.8
local COLOR_OBSIDIAN       = { 0.075, 0.055, 0.11 } -- (matching img/obsidian.png)
local COLOR_OBSIDIAN_SHEEN = { 0.30, 0.22, 0.45 }

local EMBER_SPAWN_CHANCE    = 0.35 -- per tile, per baseline frame
local EMBER_RISE_SPEED_MIN  = 0.6
local EMBER_RISE_SPEED_MAX  = 1.4
local EMBER_DRIFT           = 0.35
local EMBER_LIFE_MIN        = 0.9  -- seconds
local EMBER_LIFE_MAX        = 1.8  -- seconds
local EMBER_RADIUS_MIN      = 1.2
local EMBER_RADIUS_MAX      = 2.6

----------------------------------------------------------------------
-- Embers (decorative only)
----------------------------------------------------------------------

-- (ux, uy): which way is up for it — straight up the screen on a flat
-- level (the default), away from the planet's center on a ring.
local function newEmber(x, y, ux, uy)
  ux, uy = ux or 0, uy or -1
  local speed = EMBER_RISE_SPEED_MIN + math.random() * (EMBER_RISE_SPEED_MAX - EMBER_RISE_SPEED_MIN)
  local lifeSeconds = EMBER_LIFE_MIN + math.random() * (EMBER_LIFE_MAX - EMBER_LIFE_MIN)
  local drift = (math.random() * 2 - 1) * EMBER_DRIFT
  return {
    x = x, y = y,
    vx = -uy * drift + ux * speed,
    vy = ux * drift + uy * speed,
    life = 1,
    decayPerSecond = 1 / lifeSeconds,
    radius = EMBER_RADIUS_MIN + math.random() * (EMBER_RADIUS_MAX - EMBER_RADIUS_MIN),
  }
end

----------------------------------------------------------------------
-- Shader — one compiled instance, shared by every Lava tile
----------------------------------------------------------------------

-- Uses screen_coords (converted back to a position local to this
-- tile), NOT texture_coords — same technique Sun.lua's own plasma
-- shader already uses for its plain love.graphics.circle("fill", ...)
-- draw. texture_coords on an untextured primitive fill turned out to
-- be unreliable here (the whole tile rendered fully transparent
-- instead of mostly-opaque-with-a-wavy-top), where screen_coords is
-- proven to work in this codebase already.
local lavaShader = nil
local function getLavaShader()
  if lavaShader then return lavaShader end
  lavaShader = love.graphics.newShader([[
    extern vec2 originScreen; // this tile's own top-left corner, in SCREEN pixels, this frame
    extern number zoom;
    extern number time;
    extern number worldX0;     // this tile's own top-left corner, in WORLD units (drives the wave's phase and the noise below)
    extern number worldY0;
    extern number waveAmplitude;
    extern number waveFrequency;
    extern number waveSpeed;
    extern number waveBaseY;
    extern number edgeSoftness;
    extern number glowBand;
    extern number plasmaScale;
    extern number detailScale;
    extern number evolveSpeed;
    extern number scrollSpeed;
    extern vec3 colorDeep;
    extern vec3 colorMid;
    extern vec3 colorHot;
    extern number waveFrequency2; // the second, smaller ripple's frequency
    // Ring mode (polar = 1, see Lava.newOnRing): the tile is a slice of
    // a ring round a planet, so "along the surface" is the angle round
    // it and "down" is in toward its center.
    extern number polar;
    extern vec2 centerScreen;  // the planet's center, in SCREEN pixels, this frame
    extern number rotation;    // how far the planet has turned (radians)
    extern number ringOuter;   // the ring's outside radius: the tile's top edge
    // Turning to obsidian: cool 0 (lava) .. 1 (obsidian); overlayAlpha
    // fades the whole thing out at the end, over the baked block.
    extern number cool;
    extern number overlayAlpha;
    extern vec3 colorObsidian;
    extern vec3 colorObsidianSheen;

    // Cheap scramble hash (Dave Hoskins-style) — good enough for visual
    // noise, not meant to be cryptographic. Same recipe as Sun.lua's
    // own plasma shader.
    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    // Standard bilinear value noise, smoothed with a Hermite curve so
    // the grid it's sampled from doesn't show through as hard facets.
    float valueNoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      float a = hash(i);
      float b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0));
      float d = hash(i + vec2(1.0, 1.0));
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }

    // Fractal Brownian motion — a few octaves of the noise above,
    // each finer and dimmer than the last, summed into a mottled,
    // multi-scale texture instead of a single smooth blob.
    float fbm(vec2 p) {
      float value = 0.0;
      float amp = 0.5;
      for (int i = 0; i < 4; i++) {
        value += amp * valueNoise(p);
        p *= 2.02;
        amp *= 0.55;
      }
      return value;
    }

    vec4 effect(vec4 color, Image tex, vec2 texture_coords, vec2 screen_coords) {
      float localY;    // how far below the tile's top edge, in world units
      float alongX;    // how far along the surface, in world units (drives the wave)
      vec2 noisePos;   // where it is, for the mottling below
      if (polar > 0.5) {
        vec2 d = (screen_coords - centerScreen) / zoom;
        float c = cos(rotation);
        float s = sin(rotation);
        vec2 f = vec2(d.x * c + d.y * s, -d.x * s + d.y * c); // (in the planet's own, unturned frame)
        localY = ringOuter - length(f);
        alongX = atan(f.y, f.x) * ringOuter;
        noisePos = f;
      } else {
        vec2 localWorld = (screen_coords - originScreen) / zoom; // position within this tile, in world units, (0,0) at its top-left corner
        localY = localWorld.y;
        alongX = worldX0 + localWorld.x;
        noisePos = vec2(alongX, worldY0 + localWorld.y);
      }

      float wave = sin(alongX * waveFrequency + time * waveSpeed) * waveAmplitude
                 + sin(alongX * waveFrequency2 - time * waveSpeed * 1.7) * waveAmplitude * 0.35;
      float surfaceY = waveBaseY + wave;

      // Above the line (localY < surfaceY): fully transparent. Below
      // it: opaque lava, blended smoothly across edgeSoftness instead
      // of a hard pixel-stepped boundary.
      float alpha = smoothstep(surfaceY - edgeSoftness, surfaceY + edgeSoftness, localY);

      // Plasma-style mottling — driven by absolute world position (not
      // tile-local coordinates), so it stays continuous across
      // adjacent tiles the same way the wave itself does. A coarse
      // churning layer plus a finer speckle layer on top, same
      // two-pass technique Sun.lua's own plasma shader uses.
      vec2 gp = noisePos * plasmaScale + vec2(time * scrollSpeed, -time * evolveSpeed);
      float grain = fbm(gp);
      float speck = fbm(gp * detailScale + 5.2);
      float v = clamp(grain * 0.7 + speck * 0.3, 0.0, 1.0);

      // Biased hotter the closer a pixel sits to the wave surface (the
      // glowing "skin"), cooler/crustier further into the body — same
      // role glowBand played before, now folded into the noise value
      // itself instead of a separate flat gradient.
      float depthBelowSurface = localY - surfaceY;
      float glowBias = clamp(1.0 - depthBelowSurface / glowBand, 0.0, 1.0);
      v = clamp(v * 0.55 + glowBias * 0.6, 0.0, 1.0);

      vec3 lavaColor = mix(colorDeep, colorMid, smoothstep(0.25, 0.55, v));
      lavaColor = mix(lavaColor, colorHot, smoothstep(0.6, 0.9, v));

      // Cooling to obsidian: the body goes dark first, glassy where the
      // coarse noise is high; thin cracks (the fine noise's ridges) keep
      // glowing a while longer, then go dark too.
      float bodyHeat = 1.0 - smoothstep(0.0, 0.55, cool);
      float crackHeat = 1.0 - smoothstep(0.3, 0.95, cool);
      float crack = smoothstep(0.80, 0.96, 1.0 - abs(speck * 2.0 - 1.0));
      vec3 rock = mix(colorObsidian, colorObsidianSheen, grain * grain * 0.8);
      vec3 col = mix(rock, lavaColor, bodyHeat);
      col = mix(col, mix(colorMid, colorHot, crackHeat), crack * crackHeat * (1.0 - bodyHeat));

      return vec4(col, alpha * overlayAlpha) * color;
    }
  ]])
  -- (The settings that never change: sent once here, not on every draw.)
  lavaShader:send("waveSpeed", WAVE_SPEED)
  lavaShader:send("colorObsidian", COLOR_OBSIDIAN)
  lavaShader:send("colorObsidianSheen", COLOR_OBSIDIAN_SHEEN)
  lavaShader:send("edgeSoftness", EDGE_SOFTNESS)
  lavaShader:send("glowBand", GLOW_BAND)
  lavaShader:send("plasmaScale", PLASMA_SCALE)
  lavaShader:send("detailScale", PLASMA_DETAIL_SCALE)
  lavaShader:send("evolveSpeed", PLASMA_EVOLVE_SPEED)
  lavaShader:send("scrollSpeed", PLASMA_SCROLL_SPEED)
  lavaShader:send("colorDeep", COLOR_DEEP)
  lavaShader:send("colorMid", COLOR_MID)
  lavaShader:send("colorHot", COLOR_HOT)
  return lavaShader
end

----------------------------------------------------------------------
-- Shared wave clock — ONE value read by every Lava tile's shader, not
-- a per-instance one. There's one instance per tile (see TiledTerrain's
-- buildLavaTiles), so a separate clock per tile would give neighboring
-- tiles different phases and the wave would jump at every tile edge.
-- worldX (see the shader above) is what gives each tile a distinct but
-- continuous phase.
--
-- Advanced explicitly once per frame via Lava.updateSharedClock()
-- (called from main.lua, alongside but separate from each instance's
-- own :update() below) rather than inside :update() itself — with N
-- lava tiles on screen, incrementing a shared value from inside a
-- function that runs once PER TILE would advance the clock N times as
-- fast as intended.
----------------------------------------------------------------------

local sharedTime = 0

function Lava.updateSharedClock()
  local timeScale = state.timeScale or 1
  -- Frame-normalized (not real-seconds) units, same as everything else
  -- in this game (see main.lua's own comment on state.timeScale) — so
  -- V.A.T.S. slows the wave down along with everything else.
  sharedTime = sharedTime + (1 / 60) * timeScale
end

----------------------------------------------------------------------
-- Public API
----------------------------------------------------------------------

-- x, y: world position of this tile's own top-left corner.
-- tileWorldSize: world units per tile (TiledTerrain.TILE_WORLD_SIZE).
function Lava.new(x, y, tileWorldSize)
  local self = setmetatable({}, Lava)

  self.x0 = x
  self.y0 = y
  self.size = tileWorldSize

  -- Bounding-circle center/radius, same convention every other
  -- drawable in this codebase exposes (see utils.isOnScreen).
  self.pos = Vector2.new(x + self.size / 2, y + self.size / 2)
  self.radius = self.size * 0.7071067811865476 -- half-diagonal of a square tile

  -- (Only lava on a planet turns to obsidian — see Lava.newOnRing — but
  -- these are read for every tile.)
  self.cool, self.coolDir, self.hardened = 0, 0, false

  self.embers = {}

  -- Immovable/permanent terrain-like hazard, not something to pull
  -- toward or hard-lock onto (see Player:trySelectPullTarget and
  -- lua/systems/TargetLock.lua, both of which already skip anything
  -- isPullExempt).
  self.isImmovable = true
  self.isPermanent = true
  self.isPullExempt = true

  return self
end

-- One tile of a Tiled map wrapped round a planet (see
-- CrackedPlanetoid.fromTiledMap): the slice of ring from radius rInner
-- to rOuter, angle a0 to a1, in the planet's own unturned frame. It
-- turns with the planet (planet.rotationAngle). filled: there's more
-- lava right on top of it, so it's lava all the way up — no surface,
-- no embers.
function Lava.newOnRing(planet, rInner, rOuter, a0, a1, filled)
  local self = setmetatable({}, Lava)
  self.planet = planet
  self.rInner, self.rOuter = rInner, rOuter
  self.a0, self.a1 = a0, a1
  self.filled = filled

  -- A whole number of waves round the ring, so the surface meets
  -- itself where the angle wraps round.
  self.waveFrequency = math.max(1, math.floor(rOuter * WAVE_FREQUENCY + 0.5)) / rOuter
  self.waveFrequency2 = math.max(1, math.floor(rOuter * WAVE_FREQUENCY * 2.3 + 0.5)) / rOuter

  local arc = (a1 - a0) * rOuter
  local height = rOuter - rInner
  self.radius = math.sqrt(arc * arc + height * height) / 2
  self.pos = Vector2.new(0, 0)
  self:placeOnRing()

  -- Obsidian (see :harden / :melt): cool runs 0 (lava) .. 1 (obsidian),
  -- coolDir is which way it's going (1 hardening, -1 melting, 0 neither).
  self.cool, self.coolDir, self.hardened = 0, 0, false

  self.embers = {}
  self.isImmovable = true
  self.isPermanent = true
  self.isPullExempt = true
  return self
end

-- Starts it cooling into obsidian. (WaterSystem.lua makes the solid
-- block under it — see "Lava meeting water: obsidian" there — and plays
-- this over it as it forms.)
function Lava:harden()
  self.hardened = true
  self.coolDir = 1
end

-- Starts it heating back up out of obsidian (a fireball's hit the block).
function Lava:melt()
  self.hardened = false
  self.coolDir = -1
end

-- All the way to obsidian: nothing of it left to draw (the block's drawn
-- on its own).
function Lava:isObsidian()
  return self.hardened and self.cool >= 1
end

-- A point in the planet's own frame, turned with the planet, in world space.
function Lava:ringToWorld(fx, fy)
  local p = self.planet
  local a = p.rotationAngle or 0
  local c, s = math.cos(a), math.sin(a)
  return p.pos.x + fx * c - fy * s, p.pos.y + fx * s + fy * c
end

-- Keeps pos (the bounding circle's center) on the tile as the planet turns.
function Lava:placeOnRing()
  local am = (self.a0 + self.a1) / 2
  local rm = (self.rInner + self.rOuter) / 2
  self.pos.x, self.pos.y = self:ringToWorld(math.cos(am) * rm, math.sin(am) * rm)
end

-- Where its glow sits (see TileGlow.lua), and how strong (0..1) — or
-- nil for none.
function Lava:glowPoint()
  if self.planet then
    if self.filled or self:isObsidian() then return nil end
    local am = (self.a0 + self.a1) / 2
    local r = self.rOuter - (self.rOuter - self.rInner) * 0.3
    local x, y = self:ringToWorld(math.cos(am) * r, math.sin(am) * r)
    return x, y, 1 - self.cool
  end
  if self:isObsidian() then return nil end
  return self.x0 + self.size / 2, self.y0 + self.size * 0.3, 1 - self.cool
end

function Lava:update()
  local timeScale = state.timeScale or 1

  if self.coolDir ~= 0 then
    local seconds = self.coolDir > 0 and HARDEN_SECONDS or MELT_SECONDS
    self.cool = math.max(0, math.min(1, self.cool + self.coolDir * timeScale / 60 / seconds))
    if (self.coolDir > 0 and self.cool >= 1) or (self.coolDir < 0 and self.cool <= 0) then self.coolDir = 0 end
  end
  local heat = (1 - self.cool) ^ 2 -- (fewer embers as it cools)

  if self.planet then
    self:placeOnRing()
    if not self.filled and math.random() < EMBER_SPAWN_CHANCE * heat * timeScale then
      local b = self.a0 + math.random() * (self.a1 - self.a0)
      local r = self.rOuter - WAVE_BASE_Y
      local ex, ey = self:ringToWorld(math.cos(b) * r, math.sin(b) * r)
      local up = b + (self.planet.rotationAngle or 0)
      table.insert(self.embers, newEmber(ex, ey, math.cos(up), math.sin(up)))
    end
  elseif math.random() < EMBER_SPAWN_CHANCE * heat * timeScale then
    local ex = self.x0 + math.random() * self.size
    local ey = self.y0 + WAVE_BASE_Y
    table.insert(self.embers, newEmber(ex, ey))
  end

  for i = #self.embers, 1, -1 do
    local e = self.embers[i]
    e.x = e.x + e.vx * timeScale
    e.y = e.y + e.vy * timeScale
    e.life = e.life - e.decayPerSecond * (timeScale / 60)
    if e.life <= 0 then
      table.remove(self.embers, i)
    end
  end
end

-- A ring tile's shape, as triangles in the planet's own frame — made
-- once, then drawn turned with the planet.
local RING_PIECE_LENGTH = 10 -- world units of arc per straight piece
function Lava:ringMesh()
  if self.mesh then return self.mesh end
  local a0, a1, rIn, rOut = self.a0, self.a1, self.rInner, self.rOuter
  local pieces = math.max(2, math.ceil((a1 - a0) * rOut / RING_PIECE_LENGTH))
  local vertices = {}
  local function add(r, a)
    vertices[#vertices + 1] = { math.cos(a) * r, math.sin(a) * r, 0, 0, 1, 1, 1, 1 }
  end
  for k = 0, pieces - 1 do
    local b0 = a0 + (a1 - a0) * k / pieces
    local b1 = a0 + (a1 - a0) * (k + 1) / pieces
    add(rOut, b0); add(rOut, b1); add(rIn, b1)
    add(rOut, b0); add(rIn, b1); add(rIn, b0)
  end
  self.mesh = love.graphics.newMesh(vertices, "triangles", "static")
  return self.mesh
end

function Lava:draw()
  if not self:isObsidian() then self:drawBody() end

  for _, e in ipairs(self.embers) do
    local a = math.max(0, e.life)
    love.graphics.setColor(1, 0.35 + 0.5 * a, 0.05 + 0.25 * a, a)
    love.graphics.circle("fill", e.x, e.y, e.radius)
  end
  love.graphics.setColor(1, 1, 1, 1)
end

function Lava:drawBody()
  local shader = getLavaShader()
  local zoom = state.zoom or 1
  local cam = state.camera or { x = 0, y = 0 }
  local cool = self.cool or 0

  love.graphics.setShader(shader)
  shader:send("zoom", zoom)
  shader:send("time", sharedTime)
  -- (Cooling, the surface settles flat and rises to the tile's top.)
  shader:send("waveAmplitude", WAVE_AMPLITUDE * (1 - cool))
  -- (A filled tile's surface is far above it, so it's lava all the way up.)
  shader:send("waveBaseY", self.filled and -1000 or (WAVE_BASE_Y * (1 - cool) - EDGE_SOFTNESS * 2 * cool))
  shader:send("cool", cool)
  -- (Hardening, it fades out at the very end over the baked block;
  -- melting, the block's already gone, so it stays solid throughout.)
  local fade = 0
  if self.hardened then
    local t = math.max(0, math.min(1, (cool - 0.8) / 0.2))
    fade = t * t * (3 - 2 * t)
  end
  shader:send("overlayAlpha", 1 - fade)

  love.graphics.setColor(1, 1, 1, 1)
  if self.planet then
    local p = self.planet
    local angle = p.rotationAngle or 0
    shader:send("polar", 1)
    shader:send("centerScreen", { (p.pos.x - cam.x) * zoom, (p.pos.y - cam.y) * zoom })
    shader:send("rotation", angle)
    shader:send("ringOuter", self.rOuter)
    shader:send("waveFrequency", self.waveFrequency)
    shader:send("waveFrequency2", self.waveFrequency2)
    love.graphics.draw(self:ringMesh(), p.pos.x, p.pos.y, angle)
  else
    shader:send("polar", 0)
    shader:send("originScreen", { (self.x0 - cam.x) * zoom, (self.y0 - cam.y) * zoom })
    shader:send("worldX0", self.x0)
    shader:send("worldY0", self.y0)
    shader:send("waveFrequency", WAVE_FREQUENCY)
    shader:send("waveFrequency2", WAVE_FREQUENCY * 2.3)
    love.graphics.rectangle("fill", self.x0, self.y0, self.size, self.size)
  end
  love.graphics.setShader()
end

return Lava
