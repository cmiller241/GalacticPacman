-- svg_demo/svg.lua
--
-- A small SVG renderer for LÖVE: enough of SVG to draw an Inkscape
-- drawing like img/astronaut.svg straight from the file —
--
--   elements   <g>, <path>, <rect> (rounded corners too), <ellipse>,
--              <circle>, <line>, <polyline>, <polygon>; <image> and
--              anything with display:none are skipped
--   paths      M L H V C S Q T A Z, absolute and relative
--   transforms translate, scale, rotate, matrix, skewX, skewY — on
--              shapes and on groups, nested
--   paint      fill and stroke: #rgb, #rrggbb, a few names, none, and
--              url(#…) linear gradients (stops inherited through
--              xlink:href, userSpaceOnUse or objectBoundingBox units,
--              gradientTransform); fill-opacity, stroke-opacity, opacity
--
-- How it draws: each shape is turned into outlines (curves and arcs cut
-- into short straight pieces), once, when the file's loaded. A fill is
-- then drawn with the stencil buffer — a fan of triangles from each
-- outline's first point counts how many times each pixel's wound round
-- (up for triangles going one way, down for the other), and the fill
-- colour (or gradient, via a small shader) is laid over every pixel
-- whose count isn't zero: SVG's own "nonzero" fill rule, so concave
-- shapes, holes and overlaps all come out right with no triangulating.
-- Strokes are drawn as lines over the fill.
--
-- Usage:
--   local SVG = require("svg")
--   local doc = SVG.parse(text)
--   SVG.draw(doc)              -- in the document's own units
-- doc.root is the tree of nodes: { kind = "group", children, label, id,
-- bbox } and { kind = "shape", … }; draw any node with SVG.drawNode.
-- Needs a stencil buffer on whatever's being drawn to (the window has
-- one by default).

local SVG = {}

----------------------------------------------------------------------
-- XML
----------------------------------------------------------------------

-- A minimal XML reader: elements, their attributes and children (text
-- content, comments, the <?xml ?> line and the like are ignored).
local function parseXML(text)
  text = text:gsub("<!%-%-.-%-%->", "")
  local root = { name = "#document", attrs = {}, children = {} }
  local stack = { root }
  local pos = 1
  while true do
    local s, e, closing, name, attrText, selfClosing = text:find("<(/?)([%w:_%-%.]+)(.-)(/?)>", pos)
    if not s then break end
    pos = e + 1
    if closing == "/" then
      if #stack > 1 then table.remove(stack) end
    else
      local node = { name = name, attrs = {}, children = {} }
      for k, v in attrText:gmatch("([%w:_%-%.]+)%s*=%s*\"([^\"]*)\"") do node.attrs[k] = v end
      for k, v in attrText:gmatch("([%w:_%-%.]+)%s*=%s*'([^']*)'") do node.attrs[k] = v end
      local parent = stack[#stack]
      parent.children[#parent.children + 1] = node
      if selfClosing ~= "/" then stack[#stack + 1] = node end
    end
  end
  return root
end

----------------------------------------------------------------------
-- Matrices: { a, b, c, d, e, f } — x' = a x + c y + e, y' = b x + d y + f
----------------------------------------------------------------------

local IDENTITY = { 1, 0, 0, 1, 0, 0 }

-- m1 * m2: m2 applied first, then m1.
local function mul(m1, m2)
  return {
    m1[1] * m2[1] + m1[3] * m2[2], m1[2] * m2[1] + m1[4] * m2[2],
    m1[1] * m2[3] + m1[3] * m2[4], m1[2] * m2[3] + m1[4] * m2[4],
    m1[1] * m2[5] + m1[3] * m2[6] + m1[5], m1[2] * m2[5] + m1[4] * m2[6] + m1[6],
  }
end

local function apply(m, x, y)
  return m[1] * x + m[3] * y + m[5], m[2] * x + m[4] * y + m[6]
end

local function inverse(m)
  local det = m[1] * m[4] - m[2] * m[3]
  if math.abs(det) < 1e-12 then return IDENTITY end
  local a, b, c, d = m[4] / det, -m[2] / det, -m[3] / det, m[1] / det
  return { a, b, c, d, -(a * m[5] + c * m[6]), -(b * m[5] + d * m[6]) }
end

-- Every number in a string (as SVG writes them: "1.5", "-.5", "2e-3",
-- run together like "1-2.5.5").
local function numbersIn(s)
  local list = {}
  local i = 1
  while i <= #s do
    local a, b = s:find("^[%-%+]?%d*%.?%d+[eE][%-%+]?%d+", i)
    if not a then a, b = s:find("^[%-%+]?%d*%.?%d+", i) end
    if not a then a, b = s:find("^[%-%+]?%d+%.?", i) end
    if a then
      list[#list + 1] = tonumber(s:sub(a, b))
      i = b + 1
    else
      i = i + 1
    end
  end
  return list
end

local function parseTransform(s)
  local m = IDENTITY
  if not s then return m end
  for kind, args in s:gmatch("(%a+)%s*%(([^%)]*)%)") do
    local v = numbersIn(args)
    local t = IDENTITY
    if kind == "matrix" then
      t = { v[1], v[2], v[3], v[4], v[5], v[6] }
    elseif kind == "translate" then
      t = { 1, 0, 0, 1, v[1] or 0, v[2] or 0 }
    elseif kind == "scale" then
      t = { v[1] or 1, 0, 0, v[2] or v[1] or 1, 0, 0 }
    elseif kind == "rotate" then
      local a = math.rad(v[1] or 0)
      local c, sn = math.cos(a), math.sin(a)
      t = { c, sn, -sn, c, 0, 0 }
      if v[2] then
        t = mul({ 1, 0, 0, 1, v[2], v[3] or 0 }, mul(t, { 1, 0, 0, 1, -v[2], -(v[3] or 0) }))
      end
    elseif kind == "skewX" then
      t = { 1, 0, math.tan(math.rad(v[1] or 0)), 1, 0, 0 }
    elseif kind == "skewY" then
      t = { 1, math.tan(math.rad(v[1] or 0)), 0, 1, 0, 0 }
    end
    m = mul(m, t)
  end
  return m
end

----------------------------------------------------------------------
-- Styles and colours
----------------------------------------------------------------------

local NAMED = {
  black = { 0, 0, 0 }, white = { 1, 1, 1 }, red = { 1, 0, 0 }, green = { 0, 0.5, 0 },
  blue = { 0, 0, 1 }, yellow = { 1, 1, 0 }, gray = { 0.5, 0.5, 0.5 }, grey = { 0.5, 0.5, 0.5 },
}

local function parseColor(s)
  if not s then return nil end
  s = s:gsub("%s", "")
  if s == "none" or s == "" then return nil end
  local hex = s:match("^#(%x+)$")
  if hex then
    if #hex == 3 then
      return { tonumber(hex:sub(1, 1), 16) / 15, tonumber(hex:sub(2, 2), 16) / 15, tonumber(hex:sub(3, 3), 16) / 15 }
    elseif #hex >= 6 then
      return { tonumber(hex:sub(1, 2), 16) / 255, tonumber(hex:sub(3, 4), 16) / 255, tonumber(hex:sub(5, 6), 16) / 255 }
    end
  end
  local r, g, b = s:match("^rgb%((%d+),(%d+),(%d+)%)$")
  if r then return { tonumber(r) / 255, tonumber(g) / 255, tonumber(b) / 255 } end
  return NAMED[s:lower()]
end

-- An element's style: its presentation attributes, overridden by its
-- style="" declarations.
local STYLE_KEYS = { "fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "opacity", "display",
  "stop-color", "stop-opacity", "fill-rule", "visibility" }
local function styleOf(node)
  local st = {}
  for _, k in ipairs(STYLE_KEYS) do st[k] = node.attrs[k] end
  for k, v in (node.attrs.style or ""):gmatch("([%w%-]+)%s*:%s*([^;]+)") do st[k] = v:match("^%s*(.-)%s*$") end
  return st
end

-- (Properties a shape takes from its groups unless it sets its own.)
local INHERITED = { "fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "fill-rule", "visibility" }

----------------------------------------------------------------------
-- Gradients
----------------------------------------------------------------------

local function collectIds(node, ids)
  if node.attrs.id then ids[node.attrs.id] = node end
  for _, c in ipairs(node.children) do collectIds(c, ids) end
end

local function parseOffset(s)
  if not s then return 0 end
  local pct = s:match("^%s*([%d%.]+)%%")
  if pct then return tonumber(pct) / 100 end
  return tonumber(s) or 0
end

-- A linearGradient's full description, following xlink:href for
-- whatever it doesn't set itself (the stops, usually).
local function resolveGradient(ids, id)
  local chain, node, seen = {}, ids[id], {}
  while node and not seen[node] do
    seen[node] = true
    chain[#chain + 1] = node
    local href = node.attrs["xlink:href"] or node.attrs.href
    node = href and ids[href:sub(2)] or nil
  end
  if #chain == 0 or chain[1].name ~= "linearGradient" then return nil end
  local function attr(k)
    for _, n in ipairs(chain) do if n.attrs[k] then return n.attrs[k] end end
  end
  local stops = {}
  for _, n in ipairs(chain) do
    if #stops == 0 then
      for _, s in ipairs(n.children) do
        if s.name == "stop" then
          local st = styleOf(s)
          local c = parseColor(st["stop-color"]) or { 0, 0, 0 }
          stops[#stops + 1] = { offset = parseOffset(s.attrs.offset), color = { c[1], c[2], c[3], tonumber(st["stop-opacity"] or 1) or 1 } }
        end
      end
    end
  end
  if #stops == 0 then return nil end
  local function coord(k, default)
    local v = attr(k)
    if not v then return default end
    local pct = v:match("^([%-%d%.]+)%%$")
    if pct then return tonumber(pct) / 100 end
    return tonumber(v) or default
  end
  return {
    kind = "linear",
    units = attr("gradientUnits") or "objectBoundingBox",
    x1 = coord("x1", 0), y1 = coord("y1", 0), x2 = coord("x2", 1), y2 = coord("y2", 0),
    transform = parseTransform(attr("gradientTransform")),
    stops = stops,
  }
end

----------------------------------------------------------------------
-- Geometry: every shape as outlines (lists of points, in its own
-- coordinates), closed or open
----------------------------------------------------------------------

local function bezierSteps(len) return math.max(12, math.min(240, math.ceil(len * 7))) end

local function cubic(out, x0, y0, x1, y1, x2, y2, x3, y3)
  local len = math.sqrt((x1 - x0) ^ 2 + (y1 - y0) ^ 2) + math.sqrt((x2 - x1) ^ 2 + (y2 - y1) ^ 2)
    + math.sqrt((x3 - x2) ^ 2 + (y3 - y2) ^ 2)
  local n = bezierSteps(len)
  for i = 1, n do
    local t = i / n
    local u = 1 - t
    out[#out + 1] = u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3
    out[#out + 1] = u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3
  end
end

local function quadratic(out, x0, y0, x1, y1, x2, y2)
  local len = math.sqrt((x1 - x0) ^ 2 + (y1 - y0) ^ 2) + math.sqrt((x2 - x1) ^ 2 + (y2 - y1) ^ 2)
  local n = bezierSteps(len)
  for i = 1, n do
    local t = i / n
    local u = 1 - t
    out[#out + 1] = u * u * x0 + 2 * u * t * x1 + t * t * x2
    out[#out + 1] = u * u * y0 + 2 * u * t * y1 + t * t * y2
  end
end

-- An elliptical arc from (x1, y1) to (x2, y2) — SVG's own endpoint form,
-- turned into its centre form (see the SVG spec's implementation notes).
local function arc(out, x1, y1, rx, ry, phiDeg, largeArc, sweep, x2, y2)
  if x1 == x2 and y1 == y2 then return end
  rx, ry = math.abs(rx), math.abs(ry)
  if rx == 0 or ry == 0 then
    out[#out + 1], out[#out + 2] = x2, y2
    return
  end
  local phi = math.rad(phiDeg)
  local cp, sp = math.cos(phi), math.sin(phi)
  local dx, dy = (x1 - x2) / 2, (y1 - y2) / 2
  local x1p, y1p = cp * dx + sp * dy, -sp * dx + cp * dy
  local lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if lambda > 1 then
    local k = math.sqrt(lambda)
    rx, ry = rx * k, ry * k
  end
  local num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  local den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  local coef = math.sqrt(math.max(0, num / den))
  if (largeArc ~= 0) == (sweep ~= 0) then coef = -coef end
  local cxp, cyp = coef * rx * y1p / ry, -coef * ry * x1p / rx
  local cx = cp * cxp - sp * cyp + (x1 + x2) / 2
  local cy = sp * cxp + cp * cyp + (y1 + y2) / 2
  local function angle(ux, uy, vx, vy)
    local a = math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    return a
  end
  local theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  local dtheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if sweep == 0 and dtheta > 0 then dtheta = dtheta - 2 * math.pi end
  if sweep ~= 0 and dtheta < 0 then dtheta = dtheta + 2 * math.pi end
  local n = math.max(8, math.ceil(math.abs(dtheta) / (math.pi / 180) * math.min(1.5, math.max(rx, ry) / 12 + 0.3)))
  for i = 1, n do
    local t = theta1 + dtheta * i / n
    local ex, ey = rx * math.cos(t), ry * math.sin(t)
    out[#out + 1] = cp * ex - sp * ey + cx
    out[#out + 1] = sp * ex + cp * ey + cy
  end
end

-- A path's d="" as outlines.
local function tokenizePath(d)
  local tokens = {}
  local i, n = 1, #d
  while i <= n do
    local ch = d:sub(i, i)
    if ch:match("[MmLlHhVvCcSsQqTtAaZz]") then
      tokens[#tokens + 1] = ch
      i = i + 1
    elseif ch:match("[%d%.%-%+]") then
      local a, b = d:find("^[%-%+]?%d*%.?%d+[eE][%-%+]?%d+", i)
      if not a then a, b = d:find("^[%-%+]?%d*%.?%d+", i) end
      if not a then a, b = d:find("^[%-%+]?%d+%.?", i) end
      if a then
        tokens[#tokens + 1] = tonumber(d:sub(a, b))
        i = b + 1
      else
        i = i + 1
      end
    else
      i = i + 1
    end
  end
  return tokens
end

local function pathOutlines(d)
  local tokens = tokenizePath(d)
  local outlines = {}
  local cur = nil
  local x, y, startX, startY = 0, 0, 0, 0
  local lastCtrlX, lastCtrlY, lastCmd = nil, nil, nil
  local i = 1
  local cmd = nil
  local function num()
    local v = tokens[i]
    i = i + 1
    return type(v) == "number" and v or 0
  end
  local function newOutline()
    cur = { points = { x, y }, closed = false }
    outlines[#outlines + 1] = cur
  end
  while i <= #tokens do
    if type(tokens[i]) == "string" then
      cmd = tokens[i]
      i = i + 1
    elseif not cmd then
      i = i + 1
      goto continue
    end
    do
      local rel = cmd == cmd:lower()
      local C = cmd:upper()
      local ox, oy = rel and x or 0, rel and y or 0
      if C == "Z" then
        if cur then cur.closed = true end
        x, y = startX, startY
        cur = nil
        lastCmd = "Z"
        -- (A command letter has to follow.)
        cmd = nil
      elseif C == "M" then
        x, y = ox + num(), oy + num()
        startX, startY = x, y
        newOutline()
        -- (Further pairs after a move are lines.)
        cmd = rel and "l" or "L"
        lastCmd = "M"
      else
        if not cur then newOutline() end
        local pts = cur.points
        if C == "L" then
          x, y = ox + num(), oy + num()
          pts[#pts + 1], pts[#pts + 2] = x, y
        elseif C == "H" then
          x = (rel and x or 0) + num()
          pts[#pts + 1], pts[#pts + 2] = x, y
        elseif C == "V" then
          y = (rel and y or 0) + num()
          pts[#pts + 1], pts[#pts + 2] = x, y
        elseif C == "C" then
          local x1, y1, x2, y2 = ox + num(), oy + num(), ox + num(), oy + num()
          local x3, y3 = ox + num(), oy + num()
          cubic(pts, x, y, x1, y1, x2, y2, x3, y3)
          lastCtrlX, lastCtrlY = x2, y2
          x, y = x3, y3
        elseif C == "S" then
          local x1, y1 = x, y
          if lastCmd == "C" or lastCmd == "S" then x1, y1 = 2 * x - lastCtrlX, 2 * y - lastCtrlY end
          local x2, y2, x3, y3 = ox + num(), oy + num(), ox + num(), oy + num()
          cubic(pts, x, y, x1, y1, x2, y2, x3, y3)
          lastCtrlX, lastCtrlY = x2, y2
          x, y = x3, y3
        elseif C == "Q" then
          local x1, y1, x2, y2 = ox + num(), oy + num(), ox + num(), oy + num()
          quadratic(pts, x, y, x1, y1, x2, y2)
          lastCtrlX, lastCtrlY = x1, y1
          x, y = x2, y2
        elseif C == "T" then
          local x1, y1 = x, y
          if lastCmd == "Q" or lastCmd == "T" then x1, y1 = 2 * x - lastCtrlX, 2 * y - lastCtrlY end
          local x2, y2 = ox + num(), oy + num()
          quadratic(pts, x, y, x1, y1, x2, y2)
          lastCtrlX, lastCtrlY = x1, y1
          x, y = x2, y2
        elseif C == "A" then
          local rx, ry, rot, large, sweep = num(), num(), num(), num(), num()
          local x2, y2 = ox + num(), oy + num()
          arc(pts, x, y, rx, ry, rot, large, sweep, x2, y2)
          x, y = x2, y2
        end
        lastCmd = C
      end
    end
    ::continue::
  end
  return outlines
end

local function ellipseOutline(cx, cy, rx, ry)
  local pts = {}
  local n = math.max(64, math.min(720, math.ceil((rx + ry) * 14)))
  for i = 0, n - 1 do
    local a = i / n * math.pi * 2
    pts[#pts + 1] = cx + math.cos(a) * rx
    pts[#pts + 1] = cy + math.sin(a) * ry
  end
  return { points = pts, closed = true }
end

local function rectOutline(x, y, w, h, rx, ry)
  if not rx and not ry then rx, ry = 0, 0 end
  rx = rx or ry
  ry = ry or rx
  rx, ry = math.min(rx, w / 2), math.min(ry, h / 2)
  if rx <= 0 or ry <= 0 then
    return { points = { x, y, x + w, y, x + w, y + h, x, y + h }, closed = true }
  end
  local d = string.format(
    "M %f %f H %f A %f %f 0 0 1 %f %f V %f A %f %f 0 0 1 %f %f H %f A %f %f 0 0 1 %f %f V %f A %f %f 0 0 1 %f %f Z",
    x + rx, y, x + w - rx, rx, ry, x + w, y + ry, y + h - ry, rx, ry, x + w - rx, y + h,
    x + rx, rx, ry, x, y + h - ry, y + ry, rx, ry, x + rx, y)
  return pathOutlines(d)[1]
end

local function outlinesOf(node)
  local a = node.attrs
  local function n(k, default) return tonumber(a[k]) or default end
  if node.name == "path" then
    return pathOutlines(a.d or "")
  elseif node.name == "rect" then
    return { rectOutline(n("x", 0), n("y", 0), n("width", 0), n("height", 0), tonumber(a.rx), tonumber(a.ry)) }
  elseif node.name == "ellipse" then
    return { ellipseOutline(n("cx", 0), n("cy", 0), n("rx", 0), n("ry", 0)) }
  elseif node.name == "circle" then
    return { ellipseOutline(n("cx", 0), n("cy", 0), n("r", 0), n("r", 0)) }
  elseif node.name == "line" then
    return { { points = { n("x1", 0), n("y1", 0), n("x2", 0), n("y2", 0) }, closed = false } }
  elseif node.name == "polyline" or node.name == "polygon" then
    return { { points = numbersIn(a.points or ""), closed = node.name == "polygon" } }
  end
  return {}
end

----------------------------------------------------------------------
-- Building the drawable tree
----------------------------------------------------------------------

local function meshOf(tris)
  if #tris == 0 then return nil end
  return love.graphics.newMesh(tris, "triangles", "static")
end

-- A shape, ready to draw: its outlines moved into document coordinates
-- (by `ctm`), split into fill triangles, and its paint.
local function buildShape(node, ctm, style, ids)
  local outlines = outlinesOf(node)
  if #outlines == 0 then return nil end
  local shape = { kind = "shape", id = node.attrs.id, label = node.attrs["inkscape:label"] }
  local opacity = tonumber(style.opacity or 1) or 1

  -- Its outlines in document coordinates, its bounding boxes (local and
  -- document), and the fan of triangles for its fill.
  local docOutlines = {}
  local lminX, lminY, lmaxX, lmaxY = math.huge, math.huge, -math.huge, -math.huge
  local minX, minY, maxX, maxY = math.huge, math.huge, -math.huge, -math.huge
  local pos, neg = {}, {}
  for _, o in ipairs(outlines) do
    local pts = {}
    for k = 1, #o.points - 1, 2 do
      local lx, ly = o.points[k], o.points[k + 1]
      lminX, lminY, lmaxX, lmaxY = math.min(lminX, lx), math.min(lminY, ly), math.max(lmaxX, lx), math.max(lmaxY, ly)
      local dx, dy = apply(ctm, lx, ly)
      pts[#pts + 1], pts[#pts + 2] = dx, dy
      minX, minY, maxX, maxY = math.min(minX, dx), math.min(minY, dy), math.max(maxX, dx), math.max(maxY, dy)
    end
    docOutlines[#docOutlines + 1] = { points = pts, closed = o.closed }
    -- (Every outline counts as closed for filling, as in SVG.)
    local x0, y0 = pts[1], pts[2]
    for k = 3, #pts - 3, 2 do
      local x1, y1, x2, y2 = pts[k], pts[k + 1], pts[k + 2], pts[k + 3]
      local cross = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0)
      local list = cross >= 0 and pos or neg
      list[#list + 1] = { x0, y0, 0, 0, 1, 1, 1, 1 }
      list[#list + 1] = { x1, y1, 0, 0, 1, 1, 1, 1 }
      list[#list + 1] = { x2, y2, 0, 0, 1, 1, 1, 1 }
    end
  end
  if minX == math.huge then return nil end
  shape.bbox = { minX, minY, maxX, maxY }

  -- Fill.
  local fill = style.fill
  if fill == nil then fill = "#000000" end -- (SVG's default fill)
  local fillOpacity = (tonumber(style["fill-opacity"] or 1) or 1) * opacity
  local url = fill and fill:match("url%(#([^%)]+)%)")
  if url then
    local g = resolveGradient(ids, url)
    if g then
      -- (From document coordinates to the gradient's own: back through
      -- the shape's transform, then — in bounding-box units — from its
      -- box to the unit square, then back through gradientTransform.)
      local toLocal = inverse(ctm)
      local m
      if g.units == "userSpaceOnUse" then
        m = mul(inverse(g.transform), toLocal)
      else
        local box = { lmaxX - lminX, 0, 0, lmaxY - lminY, lminX, lminY }
        m = mul(inverse(g.transform), mul(inverse(box), toLocal))
      end
      shape.fill = { kind = "gradient", gradient = g, toGradient = m, opacity = fillOpacity }
    else
      -- (A swatch or anything else it can't use: the first stop's
      -- colour, or nothing.)
      shape.fill = nil
    end
  else
    local c = parseColor(fill)
    if c then shape.fill = { kind = "solid", color = { c[1], c[2], c[3], fillOpacity } } end
  end
  if shape.fill then
    shape.posMesh, shape.negMesh = meshOf(pos), meshOf(neg)
    -- (What the fill colour's laid over the stencil with: its bounding
    -- box, as a mesh — a mesh's points reach the gradient shader exactly
    -- as given, in document coordinates, where a rectangle's would have
    -- been moved by the current transform first.)
    local x0, y0, x1, y1 = minX - 1, minY - 1, maxX + 1, maxY + 1
    shape.coverMesh = love.graphics.newMesh({
      { x0, y0, 0, 0, 1, 1, 1, 1 }, { x1, y0, 0, 0, 1, 1, 1, 1 },
      { x1, y1, 0, 0, 1, 1, 1, 1 }, { x0, y1, 0, 0, 1, 1, 1, 1 },
    }, "fan", "static")
  end

  -- Stroke.
  local strokeColor = parseColor(style.stroke)
  local strokeOpacity = (tonumber(style["stroke-opacity"] or 1) or 1) * opacity
  if strokeColor and strokeOpacity > 0 then
    local width = tonumber((style["stroke-width"] or "1"):match("[%d%.]+")) or 1
    -- (Scaled by however much its transform scales things.)
    width = width * math.sqrt(math.abs(ctm[1] * ctm[4] - ctm[2] * ctm[3]))
    shape.stroke = { color = { strokeColor[1], strokeColor[2], strokeColor[3], strokeOpacity }, width = width }
    shape.outlines = docOutlines
  end
  return shape
end

local function build(node, ctm, inherited, ids)
  local style = styleOf(node)
  if style.display == "none" or style.visibility == "hidden" then return nil end
  for _, k in ipairs(INHERITED) do
    if style[k] == nil then style[k] = inherited[k] end
  end
  ctm = mul(ctm, parseTransform(node.attrs.transform))
  local name = node.name
  if name == "svg" or name == "g" or name == "#document" then
    local group = { kind = "group", id = node.attrs.id, label = node.attrs["inkscape:label"], children = {} }
    local passOn = {}
    for _, k in ipairs(INHERITED) do passOn[k] = style[k] end
    -- (A group's own opacity is passed on to what's in it — an
    -- approximation: real SVG fades the group as a whole.)
    local groupOpacity = (tonumber(style.opacity or 1) or 1) * (inherited.opacityScale or 1)
    passOn.opacityScale = groupOpacity
    for _, child in ipairs(node.children) do
      if child.name ~= "defs" and child.name ~= "sodipodi:namedview" then
        local built = build(child, ctm, passOn, ids)
        if built then group.children[#group.children + 1] = built end
      end
    end
    -- Its bounding box: everything in it.
    local minX, minY, maxX, maxY = math.huge, math.huge, -math.huge, -math.huge
    for _, c in ipairs(group.children) do
      if c.bbox then
        minX, minY = math.min(minX, c.bbox[1]), math.min(minY, c.bbox[2])
        maxX, maxY = math.max(maxX, c.bbox[3]), math.max(maxY, c.bbox[4])
      end
    end
    if minX ~= math.huge then group.bbox = { minX, minY, maxX, maxY } end
    return group
  elseif name == "path" or name == "rect" or name == "ellipse" or name == "circle"
      or name == "line" or name == "polyline" or name == "polygon" then
    local s = styleOf(node)
    for _, k in ipairs(INHERITED) do if s[k] == nil then s[k] = inherited[k] end end
    s.opacity = (tonumber(s.opacity or 1) or 1) * (inherited.opacityScale or 1)
    return buildShape(node, ctm, s, ids)
  end
  return nil
end

----------------------------------------------------------------------
-- Drawing
----------------------------------------------------------------------

local MAX_STOPS = 8
local gradientShader = nil
local function getGradientShader()
  if gradientShader then return gradientShader end
  gradientShader = love.graphics.newShader([[
    varying vec2 docPos;
    #ifdef VERTEX
    vec4 position(mat4 transform_projection, vec4 vertex_position) {
      docPos = vertex_position.xy;
      return transform_projection * vertex_position;
    }
    #endif
    #ifdef PIXEL
    uniform mat3 toGradient;
    uniform vec2 p1;
    uniform vec2 p2;
    uniform int stopCount;
    uniform float offsets[8];
    uniform vec4 colors[8];
    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec3 g = toGradient * vec3(docPos, 1.0);
      vec2 d = p2 - p1;
      float t = clamp(dot(g.xy - p1, d) / max(dot(d, d), 1e-9), 0.0, 1.0);
      vec4 c = colors[0];
      for (int i = 1; i < 8; i++) {
        if (i >= stopCount) break;
        if (t >= offsets[i - 1]) {
          float k = clamp((t - offsets[i - 1]) / max(offsets[i] - offsets[i - 1], 1e-5), 0.0, 1.0);
          c = mix(colors[i - 1], colors[i], k);
        }
      }
      return c * color;
    }
    #endif
  ]])
  return gradientShader
end

local function drawFill(shape)
  local f = shape.fill
  if not f or not (shape.posMesh or shape.negMesh) then return end
  -- Count how many times each pixel's wound round...
  love.graphics.stencil(function()
    if shape.posMesh then love.graphics.draw(shape.posMesh) end
  end, "incrementwrap", 1, false)
  if shape.negMesh then
    love.graphics.stencil(function() love.graphics.draw(shape.negMesh) end, "decrementwrap", 1, true)
  end
  -- ...and paint every pixel whose count isn't zero.
  love.graphics.setStencilTest("notequal", 0)
  local b = shape.bbox
  if f.kind == "solid" then
    love.graphics.setColor(f.color)
    love.graphics.draw(shape.coverMesh)
  else
    local shader = getGradientShader()
    local g = f.gradient
    local m = f.toGradient
    love.graphics.setShader(shader)
    shader:send("toGradient", "row", { { m[1], m[3], m[5] }, { m[2], m[4], m[6] }, { 0, 0, 1 } })
    shader:send("p1", { g.x1, g.y1 })
    shader:send("p2", { g.x2, g.y2 })
    local n = math.min(#g.stops, MAX_STOPS)
    shader:send("stopCount", n)
    local offsets, colors = {}, {}
    for k = 1, n do
      offsets[k] = g.stops[k].offset
      colors[k] = g.stops[k].color
    end
    shader:send("offsets", unpack(offsets))
    shader:send("colors", unpack(colors))
    love.graphics.setColor(1, 1, 1, f.opacity)
    love.graphics.draw(shape.coverMesh)
    love.graphics.setShader()
  end
  love.graphics.setStencilTest()
end

local function drawStroke(shape)
  local s = shape.stroke
  if not s then return end
  love.graphics.setColor(s.color)
  love.graphics.setLineWidth(s.width)
  for _, o in ipairs(shape.outlines) do
    local pts = o.points
    if #pts >= 4 then
      if o.closed then
        local closed = { unpack(pts) }
        closed[#closed + 1], closed[#closed + 2] = pts[1], pts[2]
        love.graphics.line(closed)
      else
        love.graphics.line(pts)
      end
    end
  end
end

function SVG.drawNode(node, hidden)
  if hidden and hidden[node] then return end
  if node.kind == "group" then
    for _, c in ipairs(node.children) do SVG.drawNode(c, hidden) end
  else
    drawFill(node)
    drawStroke(node)
  end
end

-- Draws the whole document, in its own units (its viewBox's), with
-- whatever transform's current. hidden: an optional set of nodes to
-- skip.
function SVG.draw(doc, hidden)
  love.graphics.push("all")
  love.graphics.setLineStyle("smooth")
  love.graphics.setLineJoin("bevel")
  SVG.drawNode(doc.root, hidden)
  love.graphics.pop()
end

----------------------------------------------------------------------
-- Loading
----------------------------------------------------------------------

function SVG.parse(text)
  local xml = parseXML(text)
  local svgNode
  for _, c in ipairs(xml.children) do if c.name == "svg" then svgNode = c end end
  assert(svgNode, "no <svg> element found")
  local ids = {}
  collectIds(svgNode, ids)
  local vb = numbersIn(svgNode.attrs.viewBox or "")
  local doc = {
    viewBox = #vb == 4 and vb or { 0, 0, tonumber(svgNode.attrs.width) or 100, tonumber(svgNode.attrs.height) or 100 },
  }
  doc.root = build(svgNode, IDENTITY, {}, ids)
  -- (How many shapes it's made of — for showing off.)
  local count = 0
  local function countShapes(n)
    if n.kind == "shape" then count = count + 1 else for _, c in ipairs(n.children) do countShapes(c) end end
  end
  countShapes(doc.root)
  doc.shapeCount = count
  return doc
end

-- Finds the groups with an Inkscape label (layers, body parts…),
-- top-down, as a list.
function SVG.labelledGroups(doc)
  local list = {}
  local function walk(n)
    if n.kind == "group" then
      if n.label then list[#list + 1] = n end
      for _, c in ipairs(n.children) do walk(c) end
    end
  end
  walk(doc.root)
  return list
end

return SVG
