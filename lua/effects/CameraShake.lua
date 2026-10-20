-- lua/effects/CameraShake.lua
--
-- Screen shake: the whole view jolting about chaotically for a moment —
-- big hits, like Bob crashing into a planet off a cannon shot (see
-- lua/world/Cannon.lua). Mostly side to side, some up and down, dying
-- away over its duration.
--
-- Only ever moves what's DRAWN (see main.lua's love.draw wrapper, which
-- offsets the camera for the draw and puts it back after): the real
-- camera, and everything that reads it — streaming, culling, aiming —
-- never shakes. The HUD and minimap, drawn in screen space, stay still.
--
-- Runs on real time, not game time: it's a jolt to the eye, and
-- V.A.T.S. slow-mo shouldn't drag it out.

local CameraShake = {}

local active = nil   -- { start, duration, strength, seed }

-- strength: how far it can throw the view, in screen pixels at its
-- start. duration: seconds until it's died away. A weaker shake than
-- one already going doesn't replace it.
function CameraShake.start(strength, duration)
  local now = love.timer.getTime()
  if active then
    local left = 1 - (now - active.start) / active.duration
    if left > 0 and active.strength * left * left >= strength then return end
  end
  active = { start = now, duration = duration, strength = strength, seed = math.random() * 100 }
end

-- This moment's offset, in screen pixels (0, 0 when nothing's shaking).
function CameraShake.offset()
  if not active then return 0, 0 end
  local now = love.timer.getTime()
  local t = (now - active.start) / active.duration
  if t >= 1 then
    active = nil
    return 0, 0
  end
  local fade = (1 - t) * (1 - t)
  local e, s = now - active.start, active.seed
  -- Sines at frequencies that never line up, plus a little noise: it
  -- jerks about rather than swinging back and forth evenly.
  local x = math.sin(e * 61 + s) * 0.55 + math.sin(e * 97 + s * 1.7) * 0.3 + (math.random() - 0.5) * 0.3
  local y = math.sin(e * 73 + s * 2.3) * 0.55 + math.sin(e * 113 + s * 0.6) * 0.3 + (math.random() - 0.5) * 0.3
  return x * active.strength * fade, y * active.strength * fade * 0.55
end

return CameraShake
