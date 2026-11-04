-- lua/world/tiled/Baking.lua
--
-- Baking the map's tile layers into one image, with depth shading and
-- shadows between layers.
-- Part of the Tiled level loader: see lua/world/TiledTerrain.lua.

local Tiles = require("lua.world.tiled.Tiles")
local TILE_SCALE = Tiles.TILE_SCALE
local TILE_WORLD_SIZE = Tiles.TILE_WORLD_SIZE
local DEFAULT_TILESET_COLUMNS = Tiles.DEFAULT_TILESET_COLUMNS
local findTileset = Tiles.findTileset
local classifyGid = Tiles.classifyGid
local getTileQuadForLocalIndex = Tiles.getTileQuadForLocalIndex

-- Functions it adds to TiledTerrain (copied on in lua/world/TiledTerrain.lua).
local TiledTerrain = {}

----------------------------------------------------------------------
-- Depth shading — layers named Back and Middle set behind Front
----------------------------------------------------------------------
--
-- Baked once, into the level's one canvas, back to front: a soft shadow
-- of the layer in front cast onto each layer behind it — Middle's onto
-- Back, then Front's onto both (offset down and a little sideways,
-- blurred). Shadows are made at 1/SHADOW_DOWNSCALE size — they're blurred
-- anyway — and the canvas only ever multiplied, so it costs no more
-- memory than the plain bake did. And each layer darkening toward the
-- bottom of the map (see GROUND_SHADE_ROWS).
local SHADOWED_LAYERS = { back = true, middle = true } -- (by name, any capitals)
local SHADOW_STRENGTH = 0.5        -- how dark the shadow of a layer in front is, at its darkest
local SHADOW_OFFSET_X = 14         -- world units: the shadow lands this far right...
local SHADOW_OFFSET_Y = 30         -- ...and this far down from what casts it
-- (The same offset Bob's and the Ooombas' shadows use, so every shadow
-- falls the same way — see lua/effects/CharacterShadows.lua.)
TiledTerrain.SHADOW_OFFSET_X, TiledTerrain.SHADOW_OFFSET_Y = SHADOW_OFFSET_X, SHADOW_OFFSET_Y
local SHADOW_BLUR = 3              -- blur passes (at the shadow's reduced size)
local SHADOW_DOWNSCALE = 8
-- Each layer's tiles darkening toward the bottom of the map, over its
-- bottom this-many rows (by name, any capitals; any other: none) — darkest
-- (GROUND_SHADE_DARKNESS) right at the bottom edge, none at the top of
-- those rows. The further back the layer, the higher it reaches.
local GROUND_SHADE_ROWS = { front = 1, middle = 3, back = 5 }
local GROUND_SHADE_DARKNESS = 0.5  -- how much darker it gets at the very bottom (0 = none, 1 = black)

-- Draws tiles darkened by how near the bottom of the map they are (see
-- GROUND_SHADE_ROWS) — by their own pixels' height, so it's only ever the
-- tiles' own art that darkens, never what shows through their clear parts.
local groundShadeShader = nil
local function getGroundShadeShader()
  if groundShadeShader then return groundShadeShader end
  groundShadeShader = love.graphics.newShader([[
    varying float canvasY;
    #ifdef VERTEX
    vec4 position(mat4 transform_projection, vec4 vertex_position) {
      canvasY = (TransformMatrix * vertex_position).y;
      return transform_projection * vertex_position;
    }
    #endif
    #ifdef PIXEL
    extern number bottomY;   // the map's bottom edge, canvas pixels
    extern number fadeHeight; // how far up from it the darkening reaches
    extern number darkness;
    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec4 c = Texel(tex, uv) * color;
      float t = clamp((bottomY - canvasY) / fadeHeight, 0.0, 1.0); // 0 at the bottom, 1 at the top of the fade
      c.rgb *= 1.0 - darkness * (1.0 - t);
      return c;
    }
    #endif
  ]])
  return groundShadeShader
end

local blurShader = nil
local function getBlurShader()
  if blurShader then return blurShader end
  blurShader = love.graphics.newShader([[
    extern vec2 stepUV; // one texel along the blur's direction
    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec4 sum = Texel(tex, uv) * 0.2270270;
      sum += (Texel(tex, uv + stepUV * 1.3846154) + Texel(tex, uv - stepUV * 1.3846154)) * 0.3162162;
      sum += (Texel(tex, uv + stepUV * 3.2307692) + Texel(tex, uv - stepUV * 3.2307692)) * 0.0702703;
      return sum * color;
    }
  ]])
  return blurShader
end

-- Bakes the tile layers into one canvas (see the comment above). Lava
-- tiles are skipped: the lava (WaterSystem.lua's liquid) is drawn over
-- it (and it flows away from where it started) — the sheet's own flat
-- red tile art would show wherever it's run off from, as if still lava.
local function bakeLayers(tileLayers, tilesets, tileProps, width, height, img)
  local function drawLayerTiles(l, scale, ox, oy)
    for row = 0, height - 1 do
      for col = 0, width - 1 do
        local gid = l.data[row * width + col + 1]
        if gid ~= 0 and classifyGid(tileProps, gid) ~= "lava" then
          local ts = findTileset(tilesets, gid)
          if ts then
            local quad = getTileQuadForLocalIndex(img, gid - ts.firstgid, ts.columns or DEFAULT_TILESET_COLUMNS)
            love.graphics.draw(img, quad, ox + col * TILE_WORLD_SIZE * scale, oy + row * TILE_WORLD_SIZE * scale,
              0, TILE_SCALE * scale, TILE_SCALE * scale)
          end
        end
      end
    end
  end


  -- A soft shadow of `casters` (layers in front) multiplied over everything
  -- baked so far. Made small: white, with the casters' silhouettes laid
  -- over it in black at SHADOW_STRENGTH (offset), blurred, then stretched
  -- back up over the canvas.
  local sw = math.ceil(width * TILE_WORLD_SIZE / SHADOW_DOWNSCALE)
  local sh = math.ceil(height * TILE_WORLD_SIZE / SHADOW_DOWNSCALE)
  local shadowA, shadowB = nil, nil
  local function castShadow(casters, onto)
    shadowA = shadowA or love.graphics.newCanvas(sw, sh)
    shadowB = shadowB or love.graphics.newCanvas(sw, sh)
    shadowA:setFilter("linear", "linear")
    shadowB:setFilter("linear", "linear")
    love.graphics.setCanvas(shadowA)
    love.graphics.clear(1, 1, 1, 1)
    love.graphics.setColor(0, 0, 0, SHADOW_STRENGTH)
    local s = 1 / SHADOW_DOWNSCALE
    for _, l in ipairs(casters) do
      drawLayerTiles(l, s, SHADOW_OFFSET_X * s, SHADOW_OFFSET_Y * s)
    end
    local blur = getBlurShader()
    love.graphics.setColor(1, 1, 1, 1)
    love.graphics.setShader(blur)
    for _ = 1, SHADOW_BLUR do
      love.graphics.setCanvas(shadowB)
      blur:send("stepUV", { 1 / sw, 0 })
      love.graphics.draw(shadowA)
      love.graphics.setCanvas(shadowA)
      blur:send("stepUV", { 0, 1 / sh })
      love.graphics.draw(shadowB)
    end
    love.graphics.setShader()
    love.graphics.setCanvas(onto)
    love.graphics.setBlendMode("multiply", "premultiplied")
    love.graphics.draw(shadowA, 0, 0, 0, SHADOW_DOWNSCALE, SHADOW_DOWNSCALE)
    love.graphics.setBlendMode("alpha")
  end

  local canvas = love.graphics.newCanvas(width * TILE_WORLD_SIZE, height * TILE_WORLD_SIZE)
  love.graphics.push("all")
  love.graphics.origin()
  love.graphics.setCanvas(canvas)
  love.graphics.clear(0, 0, 0, 0)
  for i, l in ipairs(tileLayers) do
    love.graphics.setColor(1, 1, 1, 1)
    local shadeRows = GROUND_SHADE_ROWS[string.lower(l.name or "")]
    if shadeRows and shadeRows > 0 then
      local shade = getGroundShadeShader()
      shade:send("bottomY", height * TILE_WORLD_SIZE)
      shade:send("fadeHeight", shadeRows * TILE_WORLD_SIZE)
      shade:send("darkness", GROUND_SHADE_DARKNESS)
      love.graphics.setShader(shade)
    end
    drawLayerTiles(l, 1, 0, 0)
    love.graphics.setShader()
    if SHADOWED_LAYERS[string.lower(l.name or "")] then
      -- The shadow of the next layer in front (only the next: one further
      -- forward casts its own over this one too, when that one's done).
      local nextLayer = tileLayers[i + 1]
      if nextLayer then castShadow({ nextLayer }, canvas) end
    end
  end
  love.graphics.pop()
  love.graphics.setColor(1, 1, 1, 1)
  if shadowA then shadowA:release(); shadowB:release() end
  return canvas
end

return {
  bakeLayers = bakeLayers,
  api = TiledTerrain,
}
