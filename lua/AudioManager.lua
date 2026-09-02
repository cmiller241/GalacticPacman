-- lua/AudioManager.lua
--
-- Direct translation of js/AudioManager.js. LÖVE's audio model is
-- genuinely different from HTML5 Audio, but happens to map onto this
-- specific file very cleanly:
--
--   love.audio.newSource(path, "static") is the equivalent of `new
--   Audio(path)` — "static" specifically means the whole file gets
--   decoded into memory once, up front, which is exactly right for
--   short sound effects (as opposed to "stream", meant for music).
--
--   Source:clone() is the real, documented LÖVE solution to the exact
--   problem the original's own cloneNode(true) pattern exists for:
--   playing overlapping copies of the same short sound without one
--   playback cutting another off. Confirmed against LÖVE's own
--   community docs/forums before writing this, not assumed — a
--   plain source re-triggered while already playing just restarts in
--   place; clone() is specifically for this.
--
--   There's no separate "preload"/.load() step here — newSource()
--   with "static" already decodes fully, synchronously, before the
--   call even returns. By the time the constructor finishes, every
--   sound is already fully loaded — nothing left to trigger.
--
--   JS's `.play().catch(e => console.log(...))` doesn't have a
--   direct equivalent — Source:play() returns true/false rather than
--   a Promise that can reject, and the original's failure case
--   (browser autoplay restrictions) is a browser-specific concern
--   that doesn't apply to a native LÖVE build in the first place.
--   Kept a lightweight check anyway, purely so a genuinely missing/
--   corrupt sound file fails loudly instead of silently.

local state = require("lua.state")

local AudioManager = {}
AudioManager.__index = AudioManager

function AudioManager.new()
  local self = setmetatable({}, AudioManager)
  self.eatDotIndex = 0  -- moved from state, same as the original's own comment

  self.eatDotAudio0 = love.audio.newSource('sounds/eat_dot_0.wav', 'static')
  self.eatDotAudio1 = love.audio.newSource('sounds/eat_dot_1.wav', 'static')
  self.deathAudio = love.audio.newSource('sounds/death_0.wav', 'static')
  self.jumpAudio = love.audio.newSource('sounds/jump.wav', 'static')
  self.jumpSmallAudio = love.audio.newSource('sounds/jumpsmall.wav', 'static')
  self.bangLarge = love.audio.newSource('sounds/bangLarge.wav', 'static')
  self.bangMedium = love.audio.newSource('sounds/bangMedium.wav', 'static')
  self.bangSmall = love.audio.newSource('sounds/bangSmall.wav', 'static')
  self.goombaStompAudio = love.audio.newSource('sounds/mario-goomba-stomp.mp3', 'static')
  self.fireballAudio = love.audio.newSource('sounds/mario-fireball.mp3', 'static')

  local allSources = {
    self.eatDotAudio0, self.eatDotAudio1, self.deathAudio, self.jumpAudio,
    self.jumpSmallAudio, self.bangLarge, self.bangMedium, self.bangSmall,
    self.goombaStompAudio, self.fireballAudio
  }
  for _, source in ipairs(allSources) do
    source:setVolume(0.5)
  end

  return self
end

-- Shared helper for the simple "clone this source, play it" methods
-- below — every one of playEatDot/playDeath/playJump/etc. is this
-- exact pattern, just with a different source, so this avoids
-- repeating the clone+play+failure-check five times over.
local function cloneAndPlay(source)
  local instance = source:clone()
  local started = instance:play()
  if not started then
    print("Audio play failed for a cloned source")
  end
  return instance
end

function AudioManager:playEatDot()
  local source = self.eatDotIndex == 0 and self.eatDotAudio0 or self.eatDotAudio1
  self.eatDotIndex = 1 - self.eatDotIndex  -- toggles between 0 and 1, same as the original
  cloneAndPlay(source)
end

function AudioManager:playDeath()
  cloneAndPlay(self.deathAudio)
end

function AudioManager:playJump()
  cloneAndPlay(self.jumpAudio)
end

function AudioManager:playJumpSmall()
  cloneAndPlay(self.jumpSmallAudio)
end

function AudioManager:playGoombaStomp()
  cloneAndPlay(self.goombaStompAudio)
end

function AudioManager:playFireball()
  cloneAndPlay(self.fireballAudio)
end

function AudioManager:playBang(size, position)
  local audioSource
  if size == 'large' then
    audioSource = self.bangLarge
  elseif size == 'medium' then
    audioSource = self.bangMedium
  elseif size == 'small' then
    audioSource = self.bangSmall
  else
    return
  end

  -- state.player.pos:subtract(position) returns a NEW Vector2 (does
  -- not mutate state.player.pos) — confirmed directly by
  -- vector2.lua's own test suite. If subtract() had been ported as a
  -- mutating method instead, this single line would silently corrupt
  -- the player's own position every time a bang sound played.
  local dist = state.player.pos:subtract(position):length()
  local vol = 0.5 * math.max(0, 1 - dist / 800)  -- fades out over 800 units, same as the original
  if vol <= 0 then return end

  local instance = audioSource:clone()
  instance:setVolume(vol)
  local started = instance:play()
  if not started then
    print("Audio play failed for playBang")
  end
end

-- Optional: reset method, same purpose as the original — call from
-- initGame() on restart, once that exists.
function AudioManager:reset()
  self.eatDotIndex = 0
end

return AudioManager