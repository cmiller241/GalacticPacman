-- DIAGNOSTIC main.lua — temporary, not part of the real game.
--
-- Run this by TEMPORARILY replacing your real main.lua with this file
-- (rename or back up the real one first), launch the game, and
-- describe/screenshot what each labeled circle actually shows. Then
-- restore your real main.lua — this file has no other purpose.

local texture = nil

function love.load()
  love.window.setTitle("DIAGNOSTIC - circle rendering")
  local ok, result = pcall(function() return love.graphics.newImage("img/planet_texture_2.jpg") end)
  if ok then
    texture = result
  else
    print("Could not load img/planet_texture_2.jpg: " .. tostring(result))
  end
end

local function drawLabel(text, cx, topY)
  love.graphics.setColor(1, 1, 1, 1)
  local w = love.graphics.getFont() and love.graphics.getFont():getWidth(text) or (#text * 7)
  love.graphics.print(text, cx - w/2, topY)
end

function love.draw()
  love.graphics.clear(0.1, 0.1, 0.15)
  local r = 80
  local ROW1_Y = 190
  local ROW2_Y = 420
  local LABEL_GAP = 40

  -- ============================================================
  -- ROW 1: A, B, C, D, E, F, G — x spacing of 220px, radius 80
  -- ============================================================
  local ax, bx, cx_, dx, ex, fx, gx = 110, 330, 550, 770, 990, 1210, 1430

  drawLabel("A: plain circle()", ax, ROW1_Y - r - LABEL_GAP)
  love.graphics.setColor(0.3, 0.8, 1.0, 1)
  love.graphics.circle("fill", ax, ROW1_Y, r)
  love.graphics.setColor(1, 1, 1, 1)

  drawLabel("B: raw texture()", bx, ROW1_Y - r - LABEL_GAP)
  if texture then
    local tw, th = texture:getDimensions()
    love.graphics.draw(texture, bx, ROW1_Y, 0, (r*2)/tw, (r*2)/th, tw/2, th/2)
  end

  drawLabel("C: masked solid color", cx_, ROW1_Y - r - LABEL_GAP)
  do
    local content = love.graphics.newCanvas(r*2, r*2)
    love.graphics.setCanvas(content)
    love.graphics.clear(0,0,0,0)
    love.graphics.setBlendMode("alpha")
    love.graphics.setColor(0.8, 0.3, 0.3, 1)
    love.graphics.rectangle("fill", 0, 0, r*2, r*2)
    love.graphics.setCanvas()

    local mask = love.graphics.newCanvas(r*2, r*2)
    love.graphics.setCanvas(mask)
    love.graphics.clear(0,0,0,0)
    love.graphics.setBlendMode("alpha")
    love.graphics.setColor(1,1,1,1)
    love.graphics.circle("fill", r, r, r)
    love.graphics.setCanvas()

    love.graphics.setCanvas(content)
    love.graphics.setBlendMode("multiply", "premultiplied")
    love.graphics.setColor(1,1,1,1)
    love.graphics.draw(mask, 0, 0)
    love.graphics.setBlendMode("alpha")
    love.graphics.setCanvas()

    love.graphics.setBlendMode("alpha", "premultiplied")
    love.graphics.setColor(1,1,1,1)
    love.graphics.draw(content, cx_ - r, ROW1_Y - r)
    love.graphics.setBlendMode("alpha")
  end

  drawLabel("D: real draw()", dx, ROW1_Y - r - LABEL_GAP)
  local state = require("lua.state")
  local Vector2 = require("lua.vector2")
  local Planetoid = require("lua.world.Planetoid")
  state.sceneWidth = 2000
  state.sceneHeight = 2000
  state.player = { pos = Vector2.new(0,0) }
  state.planetTexture = texture
  if not love.diagnosticPlanet then
    love.diagnosticPlanet = Planetoid.new(dx, ROW1_Y, r, {0.3, 0.8, 0.4, 1})
    love.diagnosticPlanet:createRingCanvas()
  end
  love.diagnosticPlanet:draw()

  drawLabel("E: stencil (direct)", ex, ROW1_Y - r - LABEL_GAP)
  if texture then
    local tw, th = texture:getDimensions()
    love.graphics.stencil(function()
      love.graphics.circle("fill", ex, ROW1_Y, r)
    end, "replace", 1)
    love.graphics.setStencilTest("greater", 0)
    love.graphics.setColor(0.3, 0.8, 0.4, 1)
    love.graphics.draw(texture, ex, ROW1_Y, 0, (r*2*2.5)/tw, (r*2*2.5)/th, tw/2, th/2)
    love.graphics.setStencilTest()
    love.graphics.setColor(1,1,1,1)
  end

  drawLabel("F: stencil (via canvas)", fx, ROW1_Y - r - LABEL_GAP)
  if texture then
    local tw, th = texture:getDimensions()
    local testCanvas = love.graphics.newCanvas(r*2, r*2)
    love.graphics.setCanvas({ testCanvas, stencil = true })
    love.graphics.clear(0,0,0,0)
    love.graphics.setBlendMode("alpha")
    love.graphics.stencil(function()
      love.graphics.circle("fill", r, r, r)
    end, "replace", 1)
    love.graphics.setStencilTest("greater", 0)
    love.graphics.setColor(0.3, 0.8, 0.4, 1)
    love.graphics.draw(texture, r, r, 0, (r*2*2.5)/tw, (r*2*2.5)/th, tw/2, th/2)
    love.graphics.setStencilTest()
    love.graphics.setColor(1,1,1,1)
    love.graphics.setCanvas()
    love.graphics.draw(testCanvas, fx - r, ROW1_Y - r)
  end

  drawLabel("G: glow-then-stencil", gx, ROW1_Y - r - LABEL_GAP)
  if texture then
    local tw, th = texture:getDimensions()
    local padding = 40
    local gSize = r*2 + padding*2
    local gcx, gcy = r + padding, r + padding

    local gCanvas = love.graphics.newCanvas(gSize, gSize)
    love.graphics.setCanvas({ gCanvas, stencil = true })
    love.graphics.clear(0,0,0,0)
    love.graphics.setBlendMode("alpha")
    for i = 8, 1, -1 do
      local t = i / 8
      local glowR = r + padding * t
      love.graphics.setColor(173/255, 216/255, 230/255, 0.3 * (1-t) * 0.9)
      love.graphics.circle("fill", gcx, gcy, glowR)
    end
    love.graphics.stencil(function()
      love.graphics.circle("fill", gcx, gcy, r)
    end, "replace", 1)
    love.graphics.setStencilTest("greater", 0)
    love.graphics.setColor(0.3, 0.8, 0.4, 1)
    love.graphics.draw(texture, gcx, gcy, 0, (r*2*2.5)/tw, (r*2*2.5)/th, tw/2, th/2)
    love.graphics.setStencilTest()
    love.graphics.setColor(1,1,1,1)
    love.graphics.setCanvas()
    love.graphics.draw(gCanvas, gx - gSize/2, ROW1_Y - gSize/2)
  end

  -- ============================================================
  -- ROW 2: D2, D3, H1, H2 — x spacing of 260px
  -- ============================================================
  local d2x, d3x, ix = 150, 410, 670

  drawLabel("D2: sun AT planet", d2x, ROW2_Y - r - LABEL_GAP)
  local savedSceneW, savedSceneH = state.sceneWidth, state.sceneHeight
  state.sceneWidth = d2x * 2
  state.sceneHeight = ROW2_Y * 2
  if not love.diagnosticPlanet2 then
    love.diagnosticPlanet2 = Planetoid.new(d2x, ROW2_Y, r, {0.3, 0.8, 0.4, 1})
    love.diagnosticPlanet2:createRingCanvas()
  end
  love.diagnosticPlanet2:draw()
  state.sceneWidth, state.sceneHeight = savedSceneW, savedSceneH

  drawLabel("D3: no sun-shading call", d3x, ROW2_Y - r - LABEL_GAP)
  if not love.diagnosticPlanet3 then
    love.diagnosticPlanet3 = Planetoid.new(d3x, ROW2_Y, r, {0.3, 0.8, 0.4, 1})
    love.diagnosticPlanet3:createRingCanvas()
  end
  love.diagnosticPlanet3:ensureBodyCanvas()
  love.graphics.setBlendMode("alpha")
  if love.diagnosticPlanet3.ringCanvas then
    love.graphics.setColor(1, 1, 1, 1)
    love.graphics.draw(love.diagnosticPlanet3.ringCanvas, d3x - love.diagnosticPlanet3.influenceRadius, ROW2_Y - love.diagnosticPlanet3.influenceRadius)
  end
  if love.diagnosticPlanet3.bodyCanvas then
    local pad = love.diagnosticPlanet3.bodyCanvasPadding
    love.graphics.setColor(1, 1, 1, 1)
    love.graphics.draw(love.diagnosticPlanet3.bodyCanvas, d3x - r - pad, ROW2_Y - r - pad)
  end
  love.graphics.setColor(1,1,1,1)

  -- ---- I: the REAL drawSunShading() method, called directly on top
  -- of a body built the exact same way D3's already-proven-working
  -- one was — no experimental blend-mode combinations here at all,
  -- just the actual method LÖVE has already validated as legal
  -- (multiply+premultiplied is the only combination LÖVE allows for
  -- multiply blending in the first place, confirmed by the crash the
  -- earlier H2 test caused). This isolates whether drawSunShading()
  -- ITSELF has a bug independent of blend-mode choice, without any
  -- risk of hitting another invalid LÖVE call. ----
  drawLabel("I: body + real drawSunShading()", ix, ROW2_Y - r - LABEL_GAP)
  if not love.diagnosticPlanetI then
    love.diagnosticPlanetI = Planetoid.new(ix, ROW2_Y, r, {0.3, 0.8, 0.4, 1})
    love.diagnosticPlanetI:createRingCanvas()
  end
  love.diagnosticPlanetI:ensureBodyCanvas()
  love.graphics.setBlendMode("alpha")
  if love.diagnosticPlanetI.bodyCanvas then
    local pad = love.diagnosticPlanetI.bodyCanvasPadding
    love.graphics.setColor(1, 1, 1, 1)
    love.graphics.draw(love.diagnosticPlanetI.bodyCanvas, ix - r - pad, ROW2_Y - r - pad)
  end
  love.diagnosticPlanetI:drawSunShading()

  -- ---- J: the RAW sun-overlay canvas, on its own, displayed with
  -- plain "alpha" blend (safe - no risk of the multiply/premultiplied
  -- validation error) - no rotation, no scaling, no multiply blend,
  -- none of drawSunShading's own logic at all. This shows EXACTLY
  -- what getSunOverlayCanvas() itself contains: if J is a clean
  -- circular gradient (white center fading to black edges, clipped to
  -- a circle), the overlay canvas itself is correctly built and the
  -- bug is in HOW drawSunShading displays/positions it. If J is
  -- itself an unclipped black rectangle, the bug is inside
  -- getSunOverlayCanvas's own stencil clip specifically. ----
  local jx = 1190
  drawLabel("J: raw overlay canvas alone", jx, ROW2_Y - r - LABEL_GAP)
  local rawOverlay = Planetoid._getSunOverlayCanvasForDiagnostics()
  if rawOverlay then
    local ow, oh = rawOverlay:getDimensions()
    love.graphics.setBlendMode("alpha")
    love.graphics.setColor(1, 1, 1, 1)
    love.graphics.draw(rawOverlay, jx - ow/2, ROW2_Y - oh/2)
  end

  -- ============================================================
  -- TEXT BLOCK — fixed positions, one line each, no overlaps
  -- ============================================================
  love.graphics.setColor(1,1,1,1)
  local ty = ROW2_Y + r + 60
  local function line(text)
    love.graphics.print(text, 20, ty)
    ty = ty + 22
  end
  line("A: clean cyan circle expected.  B: raw square texture expected (no clip here).")
  line("C: circular RED shape expected (started as a red RECTANGLE - if still square, masking is broken).")
  line("D: the real planet as currently rendered.")
  line("E/F/G: same stencil technique in different structures - all should look like a clean tinted/textured circle.")
  line("D2: real draw() with the sun repositioned at the planet (should remove almost all shading darkening).")
  line("D3: body+ring ONLY - drawSunShading() is never called at all here.")
  line("I: body (same as D3) + the REAL drawSunShading() method called directly - isolates that method specifically.")
  line("J: the RAW overlay canvas alone, plain alpha blend, no rotation/scaling/multiply at all - isolates the canvas itself.")
  ty = ty + 10
  love.graphics.setColor(1, 1, 0, 1)
  line("Planetoid.lua VERSION: " .. tostring(Planetoid.VERSION) .. "  (should read 'plain-alpha-fix-2')")
  love.graphics.setColor(1,1,1,1)
end