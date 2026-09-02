-- lua/world/Lava.lua
--
-- One hazardous lava tile (see TiledTerrain.lua's buildLavaTiles).
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

local function newEmber(x, y)
  local speed = EMBER_RISE_SPEED_MIN + math.random() * (EMBER_RISE_SPEED_MAX - EMBER_RISE_SPEED_MIN)
  local lifeSeconds = EMBER_LIFE_MIN + math.random() * (EMBER_LIFE_MAX - EMBER_LIFE_MIN)
  return {
    x = x, y = y,
    vx = (math.random() * 2 - 1) * EMBER_DRIFT,
    vy = -speed,
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
      vec2 localWorld = (screen_coords - originScreen) / zoom; // position within this tile, in world units, (0,0) at its top-left corner
      float localY = localWorld.y;
      float worldX = worldX0 + localWorld.x;
      float worldY = worldY0 + localWorld.y;

      float wave = sin(worldX * waveFrequency + time * waveSpeed) * waveAmplitude
                 + sin(worldX * waveFrequency * 2.3 - time * waveSpeed * 1.7) * waveAmplitude * 0.35;
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
      vec2 gp = vec2(worldX, worldY) * plasmaScale + vec2(time * scrollSpeed, -time * evolveSpeed);
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

      return vec4(lavaColor, alpha) * color;
    }
  ]])
  return lavaShader
end

----------------------------------------------------------------------
-- Shared wave clock — ONE value read by every Lava tile's shader, not
-- a per-instance one. An earlier version gave each tile its own
-- self.time, seeded with a random starting offset so unrelated strips
-- elsewhere on the map wouldn't wave in lockstep — but after switching
-- to one instance per individual tile (see TiledTerrain.lua's
-- buildLavaTiles), that same per-instance randomness meant every pair
-- of ADJACENT tiles had a different random phase baked in too, so the
-- wave visibly jumped at every tile edge even though worldX itself was
-- genuinely continuous across them. A single shared clock removes that
-- — worldX (see the shader above) is what gives each tile a distinct
-- but continuous phase now, not time.
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

function Lava:update()
  local timeScale = state.timeScale or 1

  if math.random() < EMBER_SPAWN_CHANCE * timeScale then
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

function Lava:draw()
  local shader = getLavaShader()
  local zoom = state.zoom or 1
  local cam = state.camera or { x = 0, y = 0 }

  love.graphics.setShader(shader)
  shader:send("originScreen", { (self.x0 - cam.x) * zoom, (self.y0 - cam.y) * zoom })
  shader:send("zoom", zoom)
  shader:send("time", sharedTime)
  shader:send("worldX0", self.x0)
  shader:send("worldY0", self.y0)
  shader:send("waveAmplitude", WAVE_AMPLITUDE)
  shader:send("waveFrequency", WAVE_FREQUENCY)
  shader:send("waveSpeed", WAVE_SPEED)
  shader:send("waveBaseY", WAVE_BASE_Y)
  shader:send("edgeSoftness", EDGE_SOFTNESS)
  shader:send("glowBand", GLOW_BAND)
  shader:send("plasmaScale", PLASMA_SCALE)
  shader:send("detailScale", PLASMA_DETAIL_SCALE)
  shader:send("evolveSpeed", PLASMA_EVOLVE_SPEED)
  shader:send("scrollSpeed", PLASMA_SCROLL_SPEED)
  shader:send("colorDeep", COLOR_DEEP)
  shader:send("colorMid", COLOR_MID)
  shader:send("colorHot", COLOR_HOT)

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.rectangle("fill", self.x0, self.y0, self.size, self.size)
  love.graphics.setShader()

  for _, e in ipairs(self.embers) do
    local a = math.max(0, e.life)
    love.graphics.setColor(1, 0.35 + 0.5 * a, 0.05 + 0.25 * a, a)
    love.graphics.circle("fill", e.x, e.y, e.radius)
  end
  love.graphics.setColor(1, 1, 1, 1)
end

return Lava
