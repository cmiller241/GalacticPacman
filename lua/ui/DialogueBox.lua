-- lua/ui/DialogueBox.lua
--
-- Shared textbox rendering/pagination for every NPC-style dialogue in
-- the game (RobotButler.lua, Fisherman.lua, Sign.lua) — previously
-- three separate copies of the exact same box layout math, font, and
-- word-wrap/pagination logic. Each caller still owns its OWN dialogue
-- STATE (dialogueActive, dialoguePages/dialoguePageIndex, any
-- message-list/script bookkeeping, timers, etc.) and its own
-- tryInteract/update logic — this module only knows how to lay out and
-- draw a screen-space textbox and how to paginate a string to fit one,
-- not anything about who's talking or what's said.

local state = require("lua.state")

local DialogueBox = {}

-- Source textbox.png is 1410x227 — used here just for its own aspect
-- ratio, not a hardcoded literal, so this keeps working if that image
-- is ever swapped for a different size.
local TEXTBOX_SOURCE_W, TEXTBOX_SOURCE_H = 1410, 227
local TEXTBOX_WIDTH_MARGIN = 20  -- screen px of clearance kept on either side of the window
local TEXTBOX_BOTTOM_MARGIN = 20 -- screen px kept between the box's own bottom edge and the window's
local TEXTBOX_TEXT_PAD_X = 60    -- inset from the box's own edges before text is allowed to start/wrap
local TEXTBOX_TEXT_PAD_Y = 33    -- inset from the box's own TOP/BOTTOM edge (text is top-aligned; the same margin is kept clear at the bottom for pagination and the "more text" indicator)
local TEXTBOX_SHADOW_OFFSET = 2  -- px the drop shadow sits down-and-right of the actual text

-- "More text" indicator: a small filled triangle in the box's own
-- bottom-right corner — the classic RPG "there's more, press a
-- button" corner marker. Shown whenever the caller's own
-- draw(pageText, hasMore) passes hasMore = true.
local DIALOGUE_MORE_SIZE = 16
local DIALOGUE_MORE_MARGIN = 18

-- Built lazily, once, and shared by every caller. love.graphics.setFont
-- is reset back to whatever it was right after printing (see
-- DialogueBox.draw), so this never leaks into the HUD text/minimap
-- drawn elsewhere with the default font.
local dialogueFont = nil
function DialogueBox.getFont()
  if not dialogueFont then
    dialogueFont = love.graphics.newFont(30)
  end
  return dialogueFont
end

-- The box's own screen-space rect. Callers need this exact same rect
-- BOTH to paginate text correctly before the box is ever drawn AND to
-- actually draw it later — computed fresh each call (cheap) rather
-- than cached, so a window resize or the minimap appearing/disappearing
-- between calls can't leave the two out of sync.
function DialogueBox.computeBoxRect()
  local screenW, screenH = love.graphics.getWidth(), love.graphics.getHeight()

  -- 20px clearance from the window on either side — at this project's
  -- own default 1280-wide window that's already close to the "about 95%
  -- of window width" ballpark; sized off the fixed margin rather than a
  -- flat percentage so it stays a consistent, deliberate gap at any
  -- window size instead of drifting wider on a bigger window.
  --
  -- Left-anchored at that same margin, but the RIGHT edge yields to the
  -- minimap (lua/ui/MiniMap.lua) when one exists, stopping short of its
  -- own left edge (plus the same margin again) instead of running the
  -- full window width and disappearing behind it. refreshSize() is
  -- called here (not just trusted from minimap's own last :draw()) so
  -- this is correct even the very first frame dialogue shows, not one
  -- frame stale after a resize.
  local rightEdge = screenW - TEXTBOX_WIDTH_MARGIN
  if state.minimap then
    state.minimap:refreshSize()
    local mapLeftEdge = screenW - state.minimap.size - state.minimap.margin
    rightEdge = math.min(rightEdge, mapLeftEdge - TEXTBOX_WIDTH_MARGIN)
  end

  local boxX = TEXTBOX_WIDTH_MARGIN
  local boxW = rightEdge - boxX
  local boxH = boxW * (TEXTBOX_SOURCE_H / TEXTBOX_SOURCE_W)
  local boxY = screenH - TEXTBOX_BOTTOM_MARGIN - boxH
  return boxX, boxY, boxW, boxH
end

-- Inline button icons: a button name between double asterisks —
-- "Hold **R2** to fire" — is drawn as that button's own icon instead of
-- as text. Names are whatever state.buttonIcons is keyed by (see
-- assetLoading.lua), matched case-insensitively. A name that isn't a
-- known button is left exactly as typed, asterisks included, so a typo
-- shows up as one instead of silently vanishing.
local ICON_HEIGHT = 36 -- screen px tall every icon is drawn, whatever its source size — about the full height of a line of text. A clean 3x for the 12px pixel-art ones; a high-res one (the Circle button) is scaled down to match. (Was 24, about the capital height.)
local ICON_PAD = 3   -- screen px kept clear on either side of an icon

local function iconFor(name)
  local icons = state.buttonIcons
  return icons and icons[name:upper()] or nil
end

-- Breaks one whitespace-free word into drawable pieces — { text = ... }
-- or { icon = ... }, each with its own width — returning the list and
-- the word's total width. Punctuation attached to a marker
-- ("**R2**,") just becomes a text piece next to the icon.
local function parseWord(word, font)
  local pieces, width = {}, 0
  local function addText(s)
    if s == "" then return end
    local w = font:getWidth(s)
    table.insert(pieces, { text = s, width = w })
    width = width + w
  end

  local pos = 1
  while true do
    local startAt, endAt, name = word:find("%*%*(%w+)%*%*", pos)
    local icon = name and iconFor(name)
    if not startAt then break end
    if icon then
      addText(word:sub(pos, startAt - 1))
      local w = icon:getWidth() * (ICON_HEIGHT / icon:getHeight()) + ICON_PAD * 2
      table.insert(pieces, { icon = icon, width = w })
      width = width + w
    else
      addText(word:sub(pos, endAt))
    end
    pos = endAt + 1
  end
  addText(word:sub(pos))

  return pieces, width
end

-- Word-wraps `text` to `limit` pixels, icon widths included. Returns a
-- list of lines, each { raw = <that line's own source text, markers
-- intact>, words = { { pieces = ..., width = ... }, ... } }. Explicit
-- "\n"s are kept as line breaks. This is the ONE wrapping routine both
-- paginate and draw use, so page breaks always match what's rendered.
local function layoutLines(text, limit)
  local font = DialogueBox.getFont()
  local spaceW = font:getWidth(" ")
  local lines = {}

  for paragraph in ((text or "") .. "\n"):gmatch("(.-)\n") do
    local line = { raw = "", words = {} }
    local lineW = 0
    for word in paragraph:gmatch("%S+") do
      local pieces, wordW = parseWord(word, font)
      if #line.words > 0 and lineW + spaceW + wordW > limit then
        table.insert(lines, line)
        line = { raw = "", words = {} }
        lineW = 0
      end
      if #line.words > 0 then
        line.raw = line.raw .. " "
        lineW = lineW + spaceW
      end
      line.raw = line.raw .. word
      lineW = lineW + wordW
      table.insert(line.words, { pieces = pieces, width = wordW })
    end
    table.insert(lines, line)
  end

  return lines, spaceW
end

-- Splits `text` into however many PAGES actually fit a box of the
-- given size, each already wrapped to the box's own text width (see
-- layoutLines — the same routine DialogueBox.draw lays text out with,
-- so the page breaks are guaranteed to match what actually renders).
function DialogueBox.paginate(text, boxW, boxH)
  local font = DialogueBox.getFont()
  local textLimit = boxW - TEXTBOX_TEXT_PAD_X * 2
  local wrappedLines = {}
  for _, line in ipairs(layoutLines(text, textLimit)) do
    table.insert(wrappedLines, line.raw)
  end

  local lineHeight = font:getHeight()
  local availableHeight = boxH - TEXTBOX_TEXT_PAD_Y * 2
  local linesPerPage = math.max(1, math.floor(availableHeight / lineHeight))

  local pages = {}
  for i = 1, #wrappedLines, linesPerPage do
    local pageLines = {}
    for j = i, math.min(i + linesPerPage - 1, #wrappedLines) do
      table.insert(pageLines, wrappedLines[j])
    end
    table.insert(pages, table.concat(pageLines, "\n"))
  end
  if #pages == 0 then pages = { "" } end
  return pages
end

-- Convenience: paginates against the box's CURRENT rect, so callers
-- that just want pages for some text don't need to call
-- computeBoxRect themselves first.
function DialogueBox.paginateForBox(text)
  local _, _, boxW, boxH = DialogueBox.computeBoxRect()
  return DialogueBox.paginate(text, boxW, boxH)
end

-- Draws the box art, pageText (white, with a small dark drop shadow —
-- plain black text read poorly against the box's own dark interior),
-- and — only when hasMore is true — the "more text" corner indicator.
-- Call AFTER the camera transform is popped (see main.lua's love.draw,
-- alongside the minimap/HUD/VatsCursor reticle), so it stays fixed
-- relative to the WINDOW rather than the world underneath it, matching
-- how a dialogue box behaves in basically every game that has one.
function DialogueBox.draw(pageText, hasMore)
  local img = state.textboxTexture
  if not img then return end

  local boxX, boxY, boxW, boxH = DialogueBox.computeBoxRect()

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(img, boxX, boxY, 0, boxW / TEXTBOX_SOURCE_W, boxH / TEXTBOX_SOURCE_H)

  local prevFont = love.graphics.getFont()
  love.graphics.setFont(DialogueBox.getFont())

  local textX = boxX + TEXTBOX_TEXT_PAD_X
  local textY = boxY + TEXTBOX_TEXT_PAD_Y
  local textLimit = boxW - TEXTBOX_TEXT_PAD_X * 2

  -- Laid out word by word rather than one printf, so a **BUTTON**
  -- marker can be drawn as its icon in the middle of a line (see
  -- layoutLines/parseWord).
  local font = DialogueBox.getFont()
  local lineHeight = font:getHeight()
  local lines, spaceW = layoutLines(pageText, textLimit)
  for lineIndex, line in ipairs(lines) do
    local x = textX
    local y = textY + (lineIndex - 1) * lineHeight
    for _, word in ipairs(line.words) do
      for _, piece in ipairs(word.pieces) do
        if piece.icon then
          love.graphics.setColor(1, 1, 1, 1)
          love.graphics.draw(piece.icon,
            math.floor(x + ICON_PAD), math.floor(y + (lineHeight - ICON_HEIGHT) / 2),
            0, ICON_HEIGHT / piece.icon:getHeight(), ICON_HEIGHT / piece.icon:getHeight())
        else
          love.graphics.setColor(0, 0, 0, 0.65)
          love.graphics.print(piece.text, x + TEXTBOX_SHADOW_OFFSET, y + TEXTBOX_SHADOW_OFFSET)
          love.graphics.setColor(1, 1, 1, 1)
          love.graphics.print(piece.text, x, y)
        end
        x = x + piece.width
      end
      x = x + spaceW
    end
  end

  love.graphics.setFont(prevFont)

  if hasMore then
    local bob = math.sin(love.timer.getTime() * 4) * 3
    local tx = boxX + boxW - DIALOGUE_MORE_MARGIN
    local ty = boxY + boxH - DIALOGUE_MORE_MARGIN + bob
    love.graphics.setColor(1, 1, 1, 0.9)
    love.graphics.polygon("fill", tx, ty - DIALOGUE_MORE_SIZE, tx, ty, tx - DIALOGUE_MORE_SIZE, ty)
    love.graphics.setColor(1, 1, 1, 1)
  end
end

return DialogueBox
