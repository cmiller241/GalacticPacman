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

-- Background music, by name. Each file is a seamless loop exported from
-- the composer (composer/README.md), and "stream" means LÖVE reads it
-- from disk as it plays instead of decoding the whole song up front.
-- volume: the track's loudness at full fade-in.
local MUSIC = {
  skyDome = { path = 'sounds/music/let-all-exalt-navarre-hyperdrive-loop.ogg', volume = 0.45 },
  belt    = { path = 'sounds/music/wake-awake-2-battle-march-loop.ogg', volume = 0.45 },
}
local MUSIC_FADE_SECONDS = 1.5   -- how long a fade in/out takes
local MUSIC_SWITCH_DELAY = 0.75  -- a new choice has to hold this long before the music changes

-- The water blaster's hiss (see AudioManager:updateSpray): a seamless loop.
local SPRAY_PATH = 'sounds/water-spray.wav'
local SPRAY_VOLUME = 0.35          -- while spraying
local SPRAY_SPUTTER_VOLUME = 0.12  -- at the water cap, when it only dribbles
local SPRAY_SPUTTER_PITCH = 0.85
local SPRAY_FADE_IN = 0.05         -- seconds to full volume
local SPRAY_FADE_OUT = 0.18        -- seconds to silence after letting go

function AudioManager.new()
  local self = setmetatable({}, AudioManager)
  self.eatDotIndex = 0  -- moved from state, same as the original's own comment

  self.music = {}
  for name, info in pairs(MUSIC) do
    local source = love.audio.newSource(info.path, 'stream')
    source:setLooping(true)
    source:setVolume(0)
    self.music[name] = { source = source, volume = info.volume, level = 0 }
  end
  self.musicWanted = nil       -- the track that should be playing (nil = none)
  self.musicPending = nil      -- a different track asked for, not yet held long enough
  self.musicPendingTime = 0

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
  self.groundPoundAudio = love.audio.newSource('sounds/groundpound.wav', 'static')
  -- Curling into a ball and back (made by tools/gen-morph-sounds.mjs).
  self.morphBallAudio = love.audio.newSource('sounds/morph-ball.wav', 'static')
  self.morphUnballAudio = love.audio.newSource('sounds/morph-unball.wav', 'static')

  self.sprayAudio = love.audio.newSource(SPRAY_PATH, 'static')
  self.sprayAudio:setLooping(true)
  self.sprayAudio:setVolume(0)
  self.sprayLevel = 0  -- current loudness, eased toward the target

  local allSources = {
    self.eatDotAudio0, self.eatDotAudio1, self.deathAudio, self.jumpAudio,
    self.jumpSmallAudio, self.bangLarge, self.bangMedium, self.bangSmall,
    self.goombaStompAudio, self.fireballAudio, self.groundPoundAudio,
    self.morphBallAudio, self.morphUnballAudio
  }
  for _, source in ipairs(allSources) do
    source:setVolume(0.5)
  end

  -- Played 30% faster than recorded. LÖVE can only speed a sound up by
  -- raising its pitch along with it (there's no tempo-only control), so
  -- it also sounds about four and a half semitones higher.
  self.groundPoundAudio:setPitch(1.3)

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

-- Curling into a ball, and standing back up (Player:enterBallMode /
-- exitBallMode).
function AudioManager:playMorphBall()
  cloneAndPlay(self.morphBallAudio)
end

function AudioManager:playMorphUnball()
  cloneAndPlay(self.morphUnballAudio)
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

-- The slam of a ground pound landing (see Player.lua's own ground-pound
-- bookkeeping in Player:update).
function AudioManager:playGroundPound()
  cloneAndPlay(self.groundPoundAudio)
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

-- Call every frame with the name of the music that should be playing
-- (a key of MUSIC above, or nil for none). Tracks fade in and out
-- rather than cutting, and a change only happens once it's been asked
-- for steadily for MUSIC_SWITCH_DELAY, so brushing past something
-- doesn't flick the music off and on.
function AudioManager:updateMusic(name, dt)
  if name == self.musicWanted then
    self.musicPending, self.musicPendingTime = nil, 0
  else
    if name ~= self.musicPending then
      self.musicPending, self.musicPendingTime = name, 0
    end
    self.musicPendingTime = self.musicPendingTime + dt
    if self.musicPendingTime >= MUSIC_SWITCH_DELAY then
      self.musicWanted = name
      self.musicPending, self.musicPendingTime = nil, 0
    end
  end

  local step = dt / MUSIC_FADE_SECONDS
  for trackName, m in pairs(self.music) do
    local target = (trackName == self.musicWanted) and 1 or 0
    if m.level < target then
      m.level = math.min(target, m.level + step)
    elseif m.level > target then
      m.level = math.max(target, m.level - step)
    end
    local playing = m.source:isPlaying()
    if target == 1 and not playing then
      m.source:play()
    elseif target == 0 and not playing then
      -- Already stopped (e.g. the pause menu's EXIT TO TITLE stops
      -- every sound) — nothing left to fade.
      m.level = 0
    end
    if m.level > 0 then
      m.source:setVolume(m.volume * m.level)
    elseif playing then
      m.source:stop()  -- fully faded out: next time it starts from the top
    end
  end
end

-- Call every frame: the water blaster's hiss, looping while Bob sprays
-- (see WaterSystem.isSpraying) and fading out when he stops. sputtering:
-- he's at the water cap, so it's only a dribble — quieter and lower.
function AudioManager:updateSpray(spraying, sputtering, dt)
  local target = 0
  if spraying then target = sputtering and SPRAY_SPUTTER_VOLUME or SPRAY_VOLUME end
  if self.sprayLevel < target then
    self.sprayLevel = math.min(target, self.sprayLevel + SPRAY_VOLUME * dt / SPRAY_FADE_IN)
  elseif self.sprayLevel > target then
    self.sprayLevel = math.max(target, self.sprayLevel - SPRAY_VOLUME * dt / SPRAY_FADE_OUT)
  end
  local source = self.sprayAudio
  if self.sprayLevel > 0 then
    source:setVolume(self.sprayLevel)
    source:setPitch(sputtering and SPRAY_SPUTTER_PITCH or 1)
    if not source:isPlaying() then source:play() end
  elseif source:isPlaying() then
    source:stop()
  end
end

-- Optional: reset method, same purpose as the original — call from
-- initGame() on restart, once that exists.
function AudioManager:reset()
  self.eatDotIndex = 0
end

return AudioManager