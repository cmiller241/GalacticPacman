-- lua/effects/CharacterShadows.lua
--
-- Bob and the Ooombas casting soft shadows onto the Tiled level's tiles —
-- only onto tiles, never onto the open background where there are none.
-- Off to the same side as the shadows the level's layers cast onto each
-- other (see TiledTerrain's SHADOW_OFFSET_X), but never down below their
-- feet (see OFFSET_Y).
--
-- Each frame (see main.lua, which calls these where the level is drawn):
--   * CharacterShadows.prepare: Bob and the Ooombas drawn again, shifted
--     by OFFSET_X/Y, into a screen-sized canvas — just their shapes.
--   * CharacterShadows.drawOnto(level): the level's own baked canvas
--     drawn over itself through a shader that, at each of its pixels,
--     shows black where those shapes are (softened a little) — times how
--     much tile is there (the canvas's own alpha), so open background,
--     where it's clear, gets none.
-- Drawn right after the level and before the characters themselves, so
-- they stand on top of their own shadows.

local state = require("lua.state")
local TiledTerrain = require("lua.world.TiledTerrain")

local CharacterShadows = {}

----------------------------------------------------------------------
-- Tunables
----------------------------------------------------------------------

local STRENGTH = 0.22   -- how dark a shadow is, at its darkest
local SOFTNESS = 5      -- world units its edge is softened over
-- Where the shadow lands, from the character: to the side, the same way
-- the level's own shadows go (see TiledTerrain's SHADOW_OFFSET_X), but
-- not down like theirs — a shadow under his feet would read as him
-- floating off the ledge he's standing on, so it's lifted a little
-- instead, enough that even its softened edge stays above his feet.
local OFFSET_X = TiledTerrain.SHADOW_OFFSET_X
local OFFSET_Y = -SOFTNESS

----------------------------------------------------------------------

local casters = nil      -- the screen-sized canvas the shapes are drawn into
local anyCaster = false  -- whether anything was drawn into it this frame

local shader = nil
local function getShader()
  if shader then return shader end
  shader = love.graphics.newShader([[
    extern Image casters;     // the shapes, screen-sized
    extern vec2 castersSize;  // its size, in pixels
    extern number softPx;     // how far round to soften, in pixels
    extern number strength;
    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      float tile = Texel(tex, uv).a;  // how much tile is here
      if (tile <= 0.0) return vec4(0.0);
      vec2 p = screen / castersSize;
      vec2 r = vec2(softPx) / castersSize;
      float a = Texel(casters, p).a * 0.2;
      a += (Texel(casters, p + vec2(r.x, 0.0)).a + Texel(casters, p - vec2(r.x, 0.0)).a
          + Texel(casters, p + vec2(0.0, r.y)).a + Texel(casters, p - vec2(0.0, r.y)).a) * 0.125;
      a += (Texel(casters, p + r * 0.7).a + Texel(casters, p - r * 0.7).a
          + Texel(casters, p + vec2(r.x, -r.y) * 0.7).a + Texel(casters, p - vec2(r.x, -r.y) * 0.7).a) * 0.075;
      return vec4(0.0, 0.0, 0.0, a * tile * strength);
    }
  ]])
  return shader
end

-- Draws this frame's casters' shapes. Call in world space (inside the
-- camera transform), before drawOnto.
function CharacterShadows.prepare()
  anyCaster = false
  local player = state.player
  local drawPlayer = player and not player.isDying and not player.portalTransit and not player.inPinball
  local hasOoombas = state.ooombas and #state.ooombas > 0
  if not (drawPlayer or hasOoombas) then return end

  -- (The size of whatever's being drawn to: the screen, or a canvas.)
  local target = love.graphics.getCanvas()
  local w, h
  if target then w, h = target:getDimensions() else w, h = love.graphics.getDimensions() end
  if not casters or casters:getWidth() ~= w or casters:getHeight() ~= h then
    if casters then casters:release() end
    casters = love.graphics.newCanvas(w, h)
  end

  love.graphics.push("all")
  love.graphics.setCanvas(casters)
  love.graphics.clear(0, 0, 0, 0)
  love.graphics.translate(OFFSET_X, OFFSET_Y)
  love.graphics.setColor(1, 1, 1, 1)
  if drawPlayer then
    player:drawRig()
    anyCaster = true
  end
  if hasOoombas then
    for _, o in ipairs(state.ooombas) do
      if not o.portalTransit then
        o:draw()
        anyCaster = true
      end
    end
  end
  love.graphics.pop()
end

-- The shadows on `level`'s tiles. Call right after drawing the level.
function CharacterShadows.drawOnto(level)
  if not (anyCaster and casters and level.canvas) then return end
  local s = getShader()
  local pw, ph = casters:getPixelDimensions()
  s:send("casters", casters)
  s:send("castersSize", { pw, ph })
  s:send("softPx", SOFTNESS * (state.zoom or 1) * casters:getDPIScale())
  s:send("strength", STRENGTH)
  love.graphics.setShader(s)
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(level.canvas, level.anchorX, level.anchorY)
  love.graphics.setShader()
end

return CharacterShadows
