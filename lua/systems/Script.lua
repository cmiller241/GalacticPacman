-- lua/systems/Script.lua
--
-- A small, generic "beat sequence" for scripted NPC conversations that
-- need to do more than just show text — each beat is one line of
-- dialogue, optionally paired with a camera action (see
-- CameraDirector.lua) that starts the instant that beat becomes
-- current. Pressing the interact button again advances to the next
-- beat; advancing past the last one finishes the script.
--
-- Deliberately NOT a parsed textual language — "script" here just means
-- a plain Lua table of beats (see RobotButler.lua's own intro script for
-- a real example), which is both simpler to write/edit than an actual
-- parser and gets Lua's own syntax/editor tooling for free. Shape of one
-- beat:
--   { text = "...", camera = { {x=, y=, zoom=, duration=}, ... } }
-- camera is optional, and handed straight to CameraDirector.run — a
-- single-waypoint list is an ordinary "ease to this view," more than one
-- chains them into a slow pan/tour.
--
-- This object only tracks WHICH beat is current; it doesn't know how to
-- display one or how to actually move the camera — that's the caller's
-- job (RobotButler.lua's own :showScriptBeat), kept separate so this
-- stays reusable by any future NPC that wants the same kind of
-- multi-beat scripted conversation.

local Script = {}
Script.__index = Script

function Script.new(beats)
  return setmetatable({
    beats = beats or {},
    index = 0,
    active = false,
  }, Script)
end

-- Starts the script and returns beat 1 (nil if it has none).
function Script:start()
  self.index = 1
  self.active = #self.beats > 0
  return self.beats[self.index]
end

function Script:currentBeat()
  return self.beats[self.index]
end

-- Advances to the next beat and returns it — or nil once advanced past
-- the last one, at which point the script also stops being active.
function Script:advance()
  if not self.active then return nil end
  if self.index >= #self.beats then
    self.active = false
    return nil
  end
  self.index = self.index + 1
  return self.beats[self.index]
end

function Script:isActive()
  return self.active
end

return Script
