-- svg_demo/main.lua
--
-- The astronaut, drawn straight from img/astronaut.svg — no PNGs, no
-- pre-rendered art: the SVG file is read, parsed and drawn as vector
-- shapes every frame by svg.lua. Each body part in the file is its own
-- Inkscape group (Head, Body, Left Arm, Right Arm, Left Boot, Right
-- Boot), so each can be moved on its own: they idle-animate here to
-- show it.
--
-- Each part is also shaded as if it were made of something — fur,
-- metal, rubber, rock, cloth, glass — with the planetoids' own sun
-- shading at its heart (see materials.lua for the materials, and for
-- what everything's made of to begin with).
--
-- Run it from the game's folder with:   love svg_demo
-- (Or drop any other .svg file onto the window to draw that instead.)
--
-- Keys:
--   M              the whole suit's material: fur, metal, rubber, rock, cloth
--   Shift + 1..9   just that part's material
--   1 .. 9         show/hide each part
--   S              the shading on/off (the flat original)
--   L              the light: from the upper left, or following the mouse
--   Up / Down      shading intensity (hold)
--   Right / Left   reflected highlight stronger / weaker (hold)
--   . / ,          its width (hold)
--   Space          animation on/off
--   B              the dark background panel on/off
--   O              outlines (strokes) on/off
--   + / -          zoom in / out (hold)   (or the mouse wheel)
--   drag           pan      R  reset the view

local SVG = require("svg")
local Materials = require("materials")

local doc, parts, background
local hidden = {}
local isPart = {}         -- the body parts (see load), each shaded on its own
local partLeaves = {}     -- each part's shapes, in drawing order
local partOverride = {}   -- a part's own material, if Shift+number's given it one
local suitMaterial = Materials.DEFAULT
local animate = true
local time = 0
local zoom, panX, panY = 1, 0, 0
local dragging = nil
local status = ""

-- How each part moves, by its label (lower case). pivot: where on its
-- bounding box it turns round (0..1 across, 0..1 down). Each returns
-- (offsetX, offsetY, angle) at time t, in the drawing's own units.
local MOTIONS = {
  ["head"] = { pivot = { 0.5, 1 }, fn = function(t) return 0, math.sin(t * 2) * 1.2, math.sin(t * 1.3) * 0.07 end },
  ["body"] = { pivot = { 0.5, 0.5 }, fn = function(t) return 0, math.sin(t * 2) * 1.2, 0 end },
  ["left arm"] = { pivot = { 0, 0.6 }, fn = function(t) return 0, math.sin(t * 2) * 1.2, math.sin(t * 2.2) * 0.1 end },
  ["right arm"] = { pivot = { 0.5, 0 }, fn = function(t) return 0, math.sin(t * 2) * 1.2, math.sin(t * 2.2 + 1) * 0.18 end },
  ["left boot"] = { pivot = { 0.5, 1 }, fn = function(t) return 0, -math.max(0, math.sin(t * 3)) * 2.2, 0 end },
  ["right boot"] = { pivot = { 0.5, 1 }, fn = function(t) return 0, -math.max(0, -math.sin(t * 3)) * 2.2, 0 end },
}

----------------------------------------------------------------------
-- Shading
----------------------------------------------------------------------

local shadingOn = true
-- Live tuning on top of each material's own numbers (multipliers, except
-- intensity: 0 the flat colours .. 1 the full look).
local TUNE = { intensity = 1, rimStrength = 1, rimWidth = 1 }
local TUNING = {
  { key = "up", down = "down", field = "intensity", rate = 0.6, min = 0, max = 1 },
  { key = "right", down = "left", field = "rimStrength", rate = 1.0, min = 0, max = 4 },
  { key = ".", down = ",", field = "rimWidth", rate = 1.0, min = 0.2, max = 4 },
}
-- Where the light comes from: the upper left, like the sun — or (L)
-- wherever the mouse is.
local DEFAULT_LIGHT = { -0.6, -0.8 }
local lightFollowsMouse = false
local lightDir = { DEFAULT_LIGHT[1], DEFAULT_LIGHT[2] }
local drawnCenter = nil -- the astronaut's middle on screen, last frame (for the light following the mouse)

-- A part's material: its own (Shift+number), or the defaults'.
local function materialOfPart(part)
  if partOverride[part] then return partOverride[part] end
  local own = part.label and Materials.PARTS[part.label:lower()]
  return own or suitMaterial
end

-- The offscreen image each batch of a part's shapes is drawn into
-- before it's shaded — one, reused, the size of the window.
local partCanvas = nil
local function getPartCanvas()
  local w, h = love.graphics.getDimensions()
  if not partCanvas or partCanvas:getWidth() ~= w or partCanvas:getHeight() ~= h then
    partCanvas = love.graphics.newCanvas(w, h, { msaa = 8 })
  end
  return partCanvas
end
local quad = love.graphics.newQuad(0, 0, 1, 1, 1, 1)

----------------------------------------------------------------------
-- Loading
----------------------------------------------------------------------

local function readFile(path)
  local f = io.open(path, "rb")
  if not f then return nil end
  local text = f:read("*a")
  f:close()
  return text
end

local function load(text, name)
  local t0 = love.timer.getTime()
  local ok, result = pcall(SVG.parse, text)
  if not ok then
    status = "Couldn't read " .. name .. ": " .. tostring(result)
    return
  end
  doc = result
  hidden = {}
  partOverride = {}
  -- The body parts: the labelled groups that are just inside the layer
  -- (or right inside the drawing, if there's no layer).
  parts, background = {}, nil
  local function collect(node)
    for _, c in ipairs(node.children) do
      if c.kind == "group" and c.label and c.label:lower():find("layer") then
        collect(c)
      elseif c.kind == "group" and c.label then
        parts[#parts + 1] = c
      elseif c.kind == "shape" and c.label and c.label:lower() == "background" then
        background = c
      end
    end
  end
  collect(doc.root)
  isPart, partLeaves = {}, {}
  for _, p in ipairs(parts) do
    isPart[p] = true
    local leaves = {}
    local function flatten(n)
      if n.kind == "shape" then leaves[#leaves + 1] = n else for _, c in ipairs(n.children) do flatten(c) end end
    end
    flatten(p)
    partLeaves[p] = leaves
  end
  zoom, panX, panY = 1, 0, 0
  status = string.format("%s: %d shapes, %d parts — parsed in %.0f ms", name, doc.shapeCount, #parts,
    (love.timer.getTime() - t0) * 1000)
end

function love.load()
  love.graphics.setBackgroundColor(0.08, 0.09, 0.13)
  -- img/astronaut.svg, in the game's folder next to this one — read
  -- with plain file access, since LÖVE's own only sees this folder.
  local base = love.filesystem.getSource()
  local text = readFile(base .. "/../img/astronaut.svg") or love.filesystem.read("astronaut.svg")
  if text then
    load(text, "img/astronaut.svg")
  else
    status = "Couldn't find img/astronaut.svg — drop an .svg file onto the window."
  end
end

function love.filedropped(file)
  file:open("r")
  local text = file:read()
  file:close()
  load(text, file:getFilename():match("[^/\\]+$"))
end

----------------------------------------------------------------------
-- Updating
----------------------------------------------------------------------

-- Zooming with the keyboard: + and - (on the main keys or the number
-- pad), held down for as long as you like.
local ZOOM_KEYS_IN = { "=", "+", "kp+" }
local ZOOM_KEYS_OUT = { "-", "kp-" }
local ZOOM_RATE = 1.4

function love.update(dt)
  if animate then time = time + dt end
  if love.keyboard.isDown(unpack(ZOOM_KEYS_IN)) then zoom = zoom * math.exp(ZOOM_RATE * dt) end
  if love.keyboard.isDown(unpack(ZOOM_KEYS_OUT)) then zoom = zoom * math.exp(-ZOOM_RATE * dt) end
  zoom = math.max(0.2, math.min(12, zoom))
  for _, t in ipairs(TUNING) do
    local change = 0
    if love.keyboard.isDown(t.key) then change = change + t.rate * dt end
    if love.keyboard.isDown(t.down) then change = change - t.rate * dt end
    TUNE[t.field] = math.max(t.min, math.min(t.max, TUNE[t.field] + change))
  end
  if lightFollowsMouse and drawnCenter then
    local mx, my = love.mouse.getPosition()
    local dx, dy = mx - drawnCenter[1], my - drawnCenter[2]
    local len = math.sqrt(dx * dx + dy * dy)
    if len > 1 then lightDir = { dx / len, dy / len } end
  end
end

----------------------------------------------------------------------
-- Drawing
----------------------------------------------------------------------

local drawNode

-- A part, shaded: its shapes taken in drawing order, a run of them made
-- of the same material at a time — each run drawn into the offscreen
-- image, then back onto the screen through the material's shading. The
-- part's "sphere" (what the light's worked out against) is its whole
-- bounding box, whatever each run's made of.
local function drawShaded(node)
  local b = node.bbox
  local cx, cy = (b[1] + b[3]) / 2, (b[2] + b[4]) / 2
  local sx, sy = love.graphics.transformPoint(cx, cy)
  local ax, ay = love.graphics.transformPoint(b[3], cy)
  local bx, by = love.graphics.transformPoint(cx, b[4])
  local rx = math.max(1, math.sqrt((ax - sx) ^ 2 + (ay - sy) ^ 2))
  local ry = math.max(1, math.sqrt((bx - sx) ^ 2 + (by - sy) ^ 2))
  local rmin = math.min(rx, ry)
  local angle = math.atan2(ay - sy, ax - sx)
  -- (Its screen bounding box, with room for hair and rims round it —
  -- only that much of the image is run through the shader.)
  local x0, y0, x1, y1 = math.huge, math.huge, -math.huge, -math.huge
  for _, corner in ipairs({ { b[1], b[2] }, { b[3], b[2] }, { b[3], b[4] }, { b[1], b[4] } }) do
    local px, py = love.graphics.transformPoint(corner[1], corner[2])
    x0, y0, x1, y1 = math.min(x0, px), math.min(y0, py), math.max(x1, px), math.max(y1, py)
  end
  local margin = rmin * 0.6 + 6

  local canvas = getPartCanvas()
  local cw, ch = canvas:getDimensions()
  x0, y0 = math.max(0, math.floor(x0 - margin)), math.max(0, math.floor(y0 - margin))
  x1, y1 = math.min(cw, math.ceil(x1 + margin)), math.min(ch, math.ceil(y1 + margin))
  if x1 <= x0 or y1 <= y0 then return end
  quad:setViewport(x0, y0, x1 - x0, y1 - y0, cw, ch)

  local partMat = materialOfPart(node)
  local leaves = partLeaves[node] or {}
  local i = 1
  while i <= #leaves do
    -- The next run of shapes made of the same thing.
    local mat = Materials.forShape(leaves[i].label, partMat)
    local j = i
    while j + 1 <= #leaves and Materials.forShape(leaves[j + 1].label, partMat) == mat do j = j + 1 end

    local previous = love.graphics.getCanvas()
    love.graphics.setCanvas({ canvas, stencil = true })
    love.graphics.clear(0, 0, 0, 0)
    for k = i, j do SVG.drawNode(leaves[k], hidden) end
    love.graphics.setCanvas(previous)

    local shader = Materials.getShader()
    love.graphics.push("all")
    love.graphics.origin()
    love.graphics.setShader(shader)
    local c, s = math.cos(-angle), math.sin(-angle)
    shader:send("lightDir", { c * lightDir[1] - s * lightDir[2], s * lightDir[1] + c * lightDir[2] })
    shader:send("lightScreen", lightDir)
    shader:send("center", { sx, sy })
    shader:send("radii", { rx, ry })
    shader:send("angle", angle)
    shader:send("canvasSize", { cw, ch })
    Materials.send(mat, TUNE, rmin)
    love.graphics.setBlendMode("alpha", "premultiplied")
    love.graphics.setColor(1, 1, 1, 1)
    love.graphics.draw(canvas, quad, x0, y0)
    love.graphics.pop()
    i = j + 1
  end
end

-- Draws a node, moving it first if it's a part with a motion — and, if
-- it's a part and the shading's on, through its materials.
drawNode = function(node)
  if hidden[node] then return end
  local motion = node.kind == "group" and node.label and MOTIONS[node.label:lower()]
  if motion and node.bbox then
    local b = node.bbox
    local px = b[1] + (b[3] - b[1]) * motion.pivot[1]
    local py = b[2] + (b[4] - b[2]) * motion.pivot[2]
    local ox, oy, a = motion.fn(time)
    love.graphics.push()
    love.graphics.translate(px + ox, py + oy)
    love.graphics.rotate(a)
    love.graphics.translate(-px, -py)
  end
  if shadingOn and isPart[node] and node.bbox then
    drawShaded(node)
  elseif node.kind == "group" then
    for _, c in ipairs(node.children) do drawNode(c) end
  else
    SVG.drawNode(node, hidden)
  end
  if motion and node.bbox then love.graphics.pop() end
end

function love.draw()
  local w, h = love.graphics.getDimensions()
  if doc and doc.root.bbox then
    -- Fitted to the window (with room round it), then the user's own
    -- zoom and pan.
    local b = doc.root.bbox
    local bw, bh = b[3] - b[1], b[4] - b[2]
    local fit = math.min((w - 120) / bw, (h - 200) / bh)
    love.graphics.push("all")
    love.graphics.translate(w / 2 + panX, h / 2 + 10 + panY)
    love.graphics.scale(fit * zoom)
    love.graphics.translate(-(b[1] + bw / 2), -(b[2] + bh / 2))
    love.graphics.setLineStyle("smooth")
    love.graphics.setLineJoin("bevel")
    drawNode(doc.root)
    drawnCenter = { love.graphics.transformPoint(b[1] + bw / 2, b[2] + bh / 2) }
    love.graphics.pop()
  end

  -- What's what.
  love.graphics.setColor(1, 1, 1, 0.9)
  love.graphics.print(status, 16, 14)
  if parts then
    local x = 16
    for i, p in ipairs(parts) do
      local label = string.format("%d %s (%s)", i, p.label, materialOfPart(p))
      love.graphics.setColor(1, 1, 1, hidden[p] and 0.3 or 0.85)
      love.graphics.print(label, x, 36)
      x = x + love.graphics.getFont():getWidth(label) + 16
    end
  end
  love.graphics.setColor(1, 1, 1, 0.55)
  love.graphics.print(string.format("M: suit material — %s   Shift+number: one part's material   S: shading %s   L: light %s",
    suitMaterial, shadingOn and "on" or "off", lightFollowsMouse and "follows the mouse" or "from the upper left"),
    16, h - 66)
  love.graphics.print(string.format(
    "Up/Down: shading intensity %.2f   Right/Left: reflected highlight x%.2f   . / ,: its width x%.2f",
    TUNE.intensity, TUNE.rimStrength, TUNE.rimWidth), 16, h - 46)
  love.graphics.print("Space: animate " .. (animate and "on" or "off") ..
    "   1-9: show/hide parts   B: background   O: outlines   + / -: zoom   drag: pan   R: reset", 16, h - 26)
  love.graphics.setColor(1, 1, 1, 1)
end

----------------------------------------------------------------------
-- Input
----------------------------------------------------------------------

-- Every shape's stroke, saved when hidden (O), so they can come back.
local savedStrokes = nil
local function toggleStrokes()
  if not doc then return end
  local function walk(n, fn)
    if n.kind == "shape" then fn(n) else for _, c in ipairs(n.children) do walk(c, fn) end end
  end
  if savedStrokes then
    walk(doc.root, function(s) s.stroke = savedStrokes[s] end)
    savedStrokes = nil
  else
    savedStrokes = {}
    walk(doc.root, function(s) savedStrokes[s] = s.stroke; s.stroke = nil end)
  end
end

-- The material after `name` in Materials.CYCLE.
local function nextMaterial(name)
  for i, m in ipairs(Materials.CYCLE) do
    if m == name then return Materials.CYCLE[i % #Materials.CYCLE + 1] end
  end
  return Materials.CYCLE[1]
end

function love.keypressed(key)
  local shift = love.keyboard.isDown("lshift", "rshift")
  if key == "escape" then love.event.quit()
  elseif key == "space" then animate = not animate
  elseif key == "r" then zoom, panX, panY = 1, 0, 0
  elseif key == "b" and background then hidden[background] = not hidden[background] or nil
  elseif key == "o" then toggleStrokes()
  elseif key == "s" then shadingOn = not shadingOn
  elseif key == "m" then
    suitMaterial = nextMaterial(suitMaterial)
    partOverride = {}
  elseif key == "l" then
    lightFollowsMouse = not lightFollowsMouse
    if not lightFollowsMouse then lightDir = { DEFAULT_LIGHT[1], DEFAULT_LIGHT[2] } end
  else
    -- (Shift+1 types "!" on most layouts, so the number's read from the
    -- key's own name — "1" — not the character.)
    local n = tonumber(key) or tonumber(key:match("^kp(%d)$") or "")
    if n and parts and parts[n] then
      if shift then
        partOverride[parts[n]] = nextMaterial(materialOfPart(parts[n]))
      else
        hidden[parts[n]] = not hidden[parts[n]] or nil
      end
    end
  end
end

function love.wheelmoved(_, dy)
  zoom = math.max(0.2, math.min(12, zoom * (1.15 ^ dy)))
end

function love.mousepressed(x, y, button)
  if button == 1 then dragging = { x = x, y = y, panX = panX, panY = panY } end
end

function love.mousereleased(_, _, button)
  if button == 1 then dragging = nil end
end

function love.mousemoved(x, y)
  if dragging then panX, panY = dragging.panX + (x - dragging.x), dragging.panY + (y - dragging.y) end
end
