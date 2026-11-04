-- lua/debug/Profiler.lua
--
-- F3: an on-screen table of how long each step of love.update and
-- love.draw takes (see the Profiler.start/stop pairs in main.lua).
--
-- Each row shows a step's average and worst time over the last half
-- second, in milliseconds, plus a bar against the 60fps budget (16.7 ms).
-- Rows are indented when a step is timed inside another one. Times are
-- CPU time: drawing calls only queue work for the graphics card, so a
-- draw step that's cheap here can still be slow on the GPU. The gap
-- between the frame time at the top and update + draw is the rest of the
-- frame: waiting for the graphics card and the screen (vsync).
--
-- Two more lines under the frame time:
--   Draw calls: how many batches went to the graphics card, and how often
--     the shader or canvas changed in between. These, more than the CPU
--     times, show what the graphics card is being asked to do.
--   Memory: the Lua heap, how much garbage each frame makes on average
--     (what the garbage collector later has to clean up: the cause of
--     stutters that show in the worst column), and texture memory.
--
-- Off, every call returns straight away.

local Profiler = {}

local WINDOW_SECONDS = 0.5   -- how often the shown numbers refresh
local BUDGET_MS = 1000 / 60  -- a full bar: one 60fps frame
local BAR_WIDTH = 120
local ROW_HEIGHT = 18
local PANEL_WIDTH = 410

local enabled = false

-- Steps in the order they were first timed, each:
--   name, depth (how many steps it's nested in),
--   started (time it started, while running), frameTotal (this frame's seconds),
--   windowSum, windowMax (seconds, this window), shownAvg, shownMax (ms, last window)
local steps = {}
local byName = {}
local depth = 0

local windowStart = nil
local windowFrames = 0
local frameStart = nil
local frameWindowSum, frameWindowMax = 0, 0
local shownFrameAvg, shownFrameMax, shownFps = 0, 0, 0

-- Graphics stats (sampled in Profiler.draw, before the panel's own
-- drawing) and Lua garbage, summed over the window, then shown as averages.
local frameStats = nil
local statWindow = { drawcalls = 0, shaderswitches = 0, canvasswitches = 0, garbageKb = 0 }
local shownStats = { drawcalls = 0, shaderswitches = 0, canvasswitches = 0, garbageKb = 0, heapKb = 0, textureMb = 0 }
local lastHeapKb = nil

local function resetStats()
  frameStats, lastHeapKb = nil, nil
  for k in pairs(statWindow) do statWindow[k] = 0 end
  for k in pairs(shownStats) do shownStats[k] = 0 end
end

local font = nil

function Profiler.isEnabled() return enabled end

function Profiler.toggle()
  enabled = not enabled
  -- Fresh numbers each time it's shown.
  steps, byName, depth = {}, {}, 0
  windowStart, windowFrames, frameStart = nil, 0, nil
  frameWindowSum, frameWindowMax = 0, 0
  shownFrameAvg, shownFrameMax, shownFps = 0, 0, 0
  resetStats()
end

function Profiler.start(name)
  if not enabled then return end
  local s = byName[name]
  if not s then
    s = { name = name, depth = depth, frameTotal = 0, windowSum = 0, windowMax = 0, shownAvg = 0, shownMax = 0,
          garbage = 0, garbageWindow = 0, shownGarbage = 0 }
    byName[name] = s
    steps[#steps + 1] = s
  end
  depth = depth + 1
  s.heapAtStart = collectgarbage("count")
  s.started = love.timer.getTime()
end

function Profiler.stop(name)
  if not enabled then return end
  local s = byName[name]
  if not (s and s.started) then return end
  s.frameTotal = s.frameTotal + (love.timer.getTime() - s.started)
  s.started = nil
  -- (A collection during the step makes this negative: counted as 0.)
  local grew = collectgarbage("count") - s.heapAtStart
  if grew > 0 then s.garbage = s.garbage + grew end
  depth = depth - 1
end

-- Called once at the very end of each frame: folds this frame's times into
-- the window, and every WINDOW_SECONDS turns the window into the numbers
-- shown.
function Profiler.endFrame()
  if not enabled then return end
  local now = love.timer.getTime()
  windowStart = windowStart or now
  if frameStart then
    local frame = now - frameStart
    frameWindowSum = frameWindowSum + frame
    if frame > frameWindowMax then frameWindowMax = frame end
  end
  frameStart = now
  windowFrames = windowFrames + 1

  -- Garbage: what the heap grew by since last frame. A collection in
  -- between shrinks it instead, so those frames are left out (a slight
  -- undercount).
  local heapKb = collectgarbage("count")
  if lastHeapKb and heapKb > lastHeapKb then
    statWindow.garbageKb = statWindow.garbageKb + (heapKb - lastHeapKb)
  end
  lastHeapKb = heapKb
  if frameStats then
    statWindow.drawcalls = statWindow.drawcalls + frameStats.drawcalls
    statWindow.shaderswitches = statWindow.shaderswitches + frameStats.shaderswitches
    statWindow.canvasswitches = statWindow.canvasswitches + frameStats.canvasswitches
  end

  for _, s in ipairs(steps) do
    s.windowSum = s.windowSum + s.frameTotal
    if s.frameTotal > s.windowMax then s.windowMax = s.frameTotal end
    s.frameTotal = 0
    s.garbageWindow = s.garbageWindow + s.garbage
    s.garbage = 0
  end

  local elapsed = now - windowStart
  if elapsed >= WINDOW_SECONDS then
    for _, s in ipairs(steps) do
      s.shownAvg = s.windowSum / windowFrames * 1000
      s.shownMax = s.windowMax * 1000
      s.windowSum, s.windowMax = 0, 0
      s.shownGarbage = s.garbageWindow / windowFrames
      s.garbageWindow = 0
    end
    local timedFrames = math.max(1, windowFrames - 1)
    shownFrameAvg = frameWindowSum / timedFrames * 1000
    shownFrameMax = frameWindowMax * 1000
    shownFps = windowFrames / elapsed
    for k, v in pairs(statWindow) do
      shownStats[k] = v / windowFrames
      statWindow[k] = 0
    end
    shownStats.heapKb = heapKb
    shownStats.textureMb = frameStats and frameStats.texturememory / (1024 * 1024) or 0
    frameWindowSum, frameWindowMax = 0, 0
    windowFrames = 0
    windowStart = now
  end
end

-- The last window's numbers as text (for printing from a test run).
local function drawCallsLine()
  return string.format("Draw calls %.0f   shader switches %.0f   canvas switches %.0f",
    shownStats.drawcalls, shownStats.shaderswitches, shownStats.canvasswitches)
end

local function memoryLine()
  return string.format("Lua %.1f MB, garbage %.0f KB/frame   textures %.0f MB",
    shownStats.heapKb / 1024, shownStats.garbageKb, shownStats.textureMb)
end

function Profiler.report()
  local lines = {
    string.format("frame %.2f ms (worst %.2f) %.0f fps", shownFrameAvg, shownFrameMax, shownFps),
    drawCallsLine(), memoryLine(),
  }
  for _, s in ipairs(steps) do
    lines[#lines + 1] = string.format("%-24s %6.2f %6.2f %7.1f KB", string.rep("  ", s.depth) .. s.name, s.shownAvg, s.shownMax, s.shownGarbage)
  end
  return table.concat(lines, "\n")
end

local function barColor(ms)
  local t = ms / BUDGET_MS
  if t < 0.25 then return 0.35, 0.85, 0.45 end -- green
  if t < 0.6 then return 0.95, 0.80, 0.30 end  -- amber
  return 0.95, 0.35, 0.30                      -- red
end

-- Screen space, top-right corner.
function Profiler.draw()
  if not enabled then return end
  -- This frame's graphics work so far: everything but this panel.
  frameStats = love.graphics.getStats(frameStats)
  font = font or love.graphics.newFont(13)
  local prevFont = love.graphics.getFont()
  love.graphics.setFont(font)

  local x = love.graphics.getWidth() - PANEL_WIDTH - 20
  local y = 20
  local height = (#steps + 5) * ROW_HEIGHT + 16
  love.graphics.setColor(0, 0, 0, 0.72)
  love.graphics.rectangle("fill", x, y, PANEL_WIDTH, height, 6, 6)

  local tx, ty = x + 10, y + 8
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.print(string.format("Frame %.2f ms (worst %.2f)   %.0f fps", shownFrameAvg, shownFrameMax, shownFps), tx, ty)
  ty = ty + ROW_HEIGHT
  love.graphics.print(drawCallsLine(), tx, ty)
  ty = ty + ROW_HEIGHT
  love.graphics.print(memoryLine(), tx, ty)
  ty = ty + ROW_HEIGHT
  love.graphics.setColor(0.7, 0.7, 0.7, 1)
  love.graphics.print("step                  avg ms   worst", tx, ty)
  ty = ty + ROW_HEIGHT

  local barX = x + PANEL_WIDTH - BAR_WIDTH - 10
  for _, s in ipairs(steps) do
    love.graphics.setColor(1, 1, 1, 1)
    love.graphics.print(string.rep("  ", s.depth) .. s.name, tx, ty)
    love.graphics.print(string.format("%6.2f  %6.2f", s.shownAvg, s.shownMax), tx + 140, ty)
    local r, g, b = barColor(s.shownAvg)
    love.graphics.setColor(1, 1, 1, 0.12)
    love.graphics.rectangle("fill", barX, ty + 3, BAR_WIDTH, ROW_HEIGHT - 8)
    love.graphics.setColor(r, g, b, 0.9)
    love.graphics.rectangle("fill", barX, ty + 3, math.min(1, s.shownAvg / BUDGET_MS) * BAR_WIDTH, ROW_HEIGHT - 8)
    ty = ty + ROW_HEIGHT
  end

  love.graphics.setColor(0.7, 0.7, 0.7, 1)
  love.graphics.print("F3 to hide.  Bars: share of a 60fps frame.", tx, ty)
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.setFont(prevFont)
end

return Profiler
