-- ClipRecorder.lua
--
-- Press P to start recording a trailer clip, P again to stop.
--
-- How it works ("frame dumping"):
--   * Every frame the game draws is grabbed exactly as rendered
--     (love.graphics.captureScreenshot) and piped straight into ffmpeg.
--     Nothing is screen-recorded, so there are no dropped frames or blur.
--   * While recording, the game runs on a fixed clock: every update is
--     exactly 1/60 s, and love.timer.getTime() is replaced by a clock that
--     also moves exactly 1/60 s per frame. If capturing makes the game run
--     slower than real time, the video still plays back at perfect speed.
--   * Two files land in <project>/clips/:
--       clip_<date>_master.mkv  - lossless, native window size. Keep this
--                                 for editing/joining clips later.
--       clip_<date>_upload.mp4  - made in the background after you stop:
--                                 cropped to 16:9, scaled up by a whole
--                                 number (nearest-neighbor, so pixels stay
--                                 crisp) to as close to 4K as possible,
--                                 H.264 high quality. Upload this one to
--                                 YouTube / Facebook.
--
-- Needs ffmpeg on the PATH (winget install Gyan.FFmpeg). No audio is
-- recorded; trailers get their music/sound added in the edit.

local ffi = require("ffi")

local M = {}

local FPS = 60
local FRAME_DT = 1 / FPS
local TARGET_HEIGHT = 2160 -- upload version aims for 4K

local isWindows = love.system.getOS() == "Windows"

pcall(ffi.cdef, [[
  typedef struct FILE FILE;
  size_t fwrite(const void *ptr, size_t size, size_t count, FILE *stream);
]])
if isWindows then
  pcall(ffi.cdef, [[
    FILE *_popen(const char *command, const char *mode);
    int _pclose(FILE *stream);
  ]])
else
  pcall(ffi.cdef, [[
    FILE *popen(const char *command, const char *mode);
    int pclose(FILE *stream);
  ]])
end

local function cpopen(cmd)
  if isWindows then return ffi.C._popen(cmd, "wb") end
  return ffi.C.popen(cmd, "w")
end

local function cpclose(f)
  if isWindows then return ffi.C._pclose(f) end
  return ffi.C.pclose(f)
end

-- ---------------------------------------------------------------------
-- Recording state
-- ---------------------------------------------------------------------
local recording = false
local pipe = nil
local width, height = 0, 0
local frameCount = 0
local masterPath, uploadPath = nil, nil
local baseTitle = nil

-- ---------------------------------------------------------------------
-- Fixed clock. Outside recording, getTime() is the real clock minus an
-- offset (0 until the first recording). During recording it only moves
-- 1/60 s per frame. On stop, the offset absorbs the gap so the game's
-- clock carries on smoothly instead of jumping forward.
-- ---------------------------------------------------------------------
local realGetTime = love.timer.getTime
local clockOffset = 0
local virtualTime = 0

love.timer.getTime = function()
  if recording then return virtualTime end
  return realGetTime() - clockOffset
end

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
local ffmpegChecked, ffmpegFound = false, false
local function ffmpegAvailable()
  if not ffmpegChecked then
    ffmpegChecked = true
    local p = io.popen("ffmpeg -version 2>&1")
    if p then
      local out = p:read("*a") or ""
      p:close()
      ffmpegFound = out:find("ffmpeg version", 1, true) ~= nil
    end
  end
  return ffmpegFound
end

local function nativePath(path)
  if isWindows then return (path:gsub("/", "\\")) end
  return path
end

-- <project>/clips when running from the project folder (love .),
-- otherwise LÖVE's save directory.
local function clipsDir()
  local base
  local source = love.filesystem.getSource()
  if not love.filesystem.isFused() and love.filesystem.getRealDirectory("main.lua") == source then
    base = source
  else
    base = love.filesystem.getSaveDirectory()
  end
  local dir = nativePath(base .. "/clips")
  if isWindows then
    os.execute('if not exist "' .. dir .. '" mkdir "' .. dir .. '"')
  else
    os.execute('mkdir -p "' .. dir .. '"')
  end
  return dir
end

local function setTitleSuffix(suffix)
  baseTitle = baseTitle or love.window.getTitle()
  love.window.setTitle(suffix and (baseTitle .. "  -  " .. suffix) or baseTitle)
end

local function even(n) return math.floor(n / 2) * 2 end

-- Crop to 16:9 (centered), then pick the biggest whole-number scale that
-- stays at or under 4K. Whole-number nearest-neighbor scaling keeps every
-- pixel-art pixel a crisp square; the hi-res art just gets bigger.
local function uploadFilter(w, h)
  local cw, ch = w, h
  if w / h > 16 / 9 then cw = h * 16 / 9 else ch = w * 9 / 16 end
  cw, ch = even(cw), even(ch)
  local scale = math.max(1, math.floor(TARGET_HEIGHT / ch))
  return string.format("crop=%d:%d,scale=%d:%d:flags=neighbor,format=yuv420p",
    cw, ch, cw * scale, ch * scale), cw * scale, ch * scale
end

local COLOR_TAGS = "-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv"

-- ---------------------------------------------------------------------
-- Public API
-- ---------------------------------------------------------------------
function M.isRecording() return recording end

function M.start()
  if recording then return end
  if not ffmpegAvailable() then
    print("[ClipRecorder] ffmpeg was not found on the PATH. Install it (winget install Gyan.FFmpeg), then restart the game.")
    setTitleSuffix("can't record: ffmpeg not installed")
    return
  end

  width, height = love.graphics.getPixelDimensions()
  local stamp = os.date("clip_%Y-%m-%d_%H-%M-%S")
  local dir = clipsDir()
  masterPath = dir .. (isWindows and "\\" or "/") .. stamp .. "_master.mkv"
  uploadPath = dir .. (isWindows and "\\" or "/") .. stamp .. "_upload.mp4"

  -- Raw RGBA frames in, lossless H.264 (4:4:4, full color detail) out.
  -- "ultrafast" keeps encoding from slowing the game down much.
  local cmd = string.format(
    'ffmpeg -hide_banner -loglevel error -y -f rawvideo -pix_fmt rgba -s %dx%d -framerate %d -i - '
    .. '-vf "crop=%d:%d:0:0,scale=out_color_matrix=bt709:out_range=tv,format=yuv444p" '
    .. '-c:v libx264 -preset ultrafast -qp 0 %s "%s"',
    width, height, FPS, even(width), even(height), COLOR_TAGS, masterPath)

  pipe = cpopen(cmd)
  if pipe == nil then
    print("[ClipRecorder] Couldn't start ffmpeg.")
    return
  end

  virtualTime = realGetTime() - clockOffset
  frameCount = 0
  recording = true
  print("[ClipRecorder] Recording " .. width .. "x" .. height .. " -> " .. masterPath)
  setTitleSuffix("REC")
end

function M.stop(reason)
  if not recording then return end
  recording = false
  clockOffset = realGetTime() - virtualTime

  -- Waits for ffmpeg to finish writing the master file.
  cpclose(pipe)
  pipe = nil

  local seconds = frameCount / FPS
  print(string.format("[ClipRecorder] Stopped%s. %d frames (%.1f s) saved to %s",
    reason and (" (" .. reason .. ")") or "", frameCount, seconds, masterPath))

  if frameCount == 0 then
    setTitleSuffix(nil)
    return
  end

  -- Upload version, encoded in the background at low priority so the
  -- game keeps running. "slow" + CRF 14 = very high quality; YouTube and
  -- Facebook re-compress anyway, so a clean, sharp source matters most.
  -- Written to "<name>.part" first and renamed only once finished, so a
  -- half-made file never looks like a finished clip.
  local vf, outW, outH = uploadFilter(even(width), even(height))
  local partPath = uploadPath .. ".part"
  local cmd = string.format(
    'ffmpeg -hide_banner -loglevel error -nostdin -y -i "%s" -vf "%s" '
    .. '-c:v libx264 -preset slow -crf 14 -profile:v high -pix_fmt yuv420p %s '
    .. '-movflags +faststart -f mp4 "%s"',
    masterPath, vf, COLOR_TAGS, partPath)
  if isWindows then
    -- Its own minimized console window, so it keeps going even if the
    -- game is closed straight after (a shared console would kill it).
    os.execute(string.format('start "Encoding clip" /min /low cmd /c "%s && move /y "%s" "%s" >nul"',
      cmd, partPath, uploadPath))
  else
    os.execute(string.format('(nice %s && mv "%s" "%s") &', cmd, partPath, uploadPath))
  end
  print(string.format("[ClipRecorder] Making %dx%d upload version in the background -> %s",
    outW, outH, uploadPath))
  setTitleSuffix(string.format("saved %.1f s clip", seconds))
end

function M.toggle()
  if recording then M.stop() else M.start() end
end

-- Fixed timestep while recording. Call from love.update before the
-- frame's own update runs.
function M.frameDt(dt)
  if not recording then return dt end
  virtualTime = virtualTime + FRAME_DT
  return FRAME_DT
end

-- Queue a grab of this frame. Call at the very end of love.draw; LÖVE
-- hands over the finished frame once it's presented.
function M.captureFrame()
  if not recording then return end
  love.graphics.captureScreenshot(function(img)
    if not recording then img:release() return end
    if img:getWidth() ~= width or img:getHeight() ~= height then
      img:release()
      M.stop("window was resized")
      return
    end
    local size = img:getSize()
    local written = ffi.C.fwrite(img:getFFIPointer(), 1, size, pipe)
    img:release()
    if written < size then
      M.stop("ffmpeg stopped accepting frames")
      return
    end
    frameCount = frameCount + 1
    if frameCount % FPS == 0 then
      setTitleSuffix(string.format("REC %d s", frameCount / FPS))
    end
  end)
end

-- Quitting mid-recording still saves the clip.
function M.shutdown()
  if recording then M.stop("game closed") end
end

return M
