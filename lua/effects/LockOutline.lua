-- lua/effects/LockOutline.lua
--
-- Port of js/effects/LockOutline.js
-- Draws a pulsing yellow ring around state.player.lockedTarget.

local state = require("lua.state")

local OUTLINE_R, OUTLINE_G, OUTLINE_B = 255 / 255, 220 / 255, 40 / 255
local OUTLINE_GLOW_WIDTH = 9
local OUTLINE_CORE_WIDTH = 3
local OUTLINE_PADDING = 8 -- how far outside the target's own silhouette the outline sits, matching PullBeam.lua's own convention

local LockOutline = {}

-- Deliberately simpler/single-layer rather than mirroring PullBeam.lua's
-- full pulsing multi-layer glow — the two need to read as clearly
-- DIFFERENT things when both are visible at once (locking onto
-- something, then pulling it, is an expected combined state), not
-- blend into a single ambiguous glow around the same object.
--
-- Shape: always a plain circle, same "circle-ish" simplification
-- PullBeam.lua's own target outline already uses for isRoundedRect
-- targets (a true rotated rounded rect, like the original's ctx.roundRect
-- version, isn't implemented there either) — keeping both outlines
-- circle-based is what keeps them visually consistent with each other
-- rather than one being rounded-rect-shaped and the other not.
-- Shared by draw() below (the actual L1/R1 hard lock) and
-- VatsCursor.lua's own hover ring (the right-stick cursor, while in
-- V.A.T.S., pointing at a planet without necessarily having locked it
-- yet) — both want the exact same "this is a valid target" visual, just
-- driven by a different target each.
function LockOutline.drawRingAround(target)
  -- Gentle pulse, same technique PullBeam.lua uses, but a slower/subtler
  -- one — this needs to read as "steady, holding a lock," not "actively
  -- channeling energy" the way the pull beam's own faster pulse does.
  -- love.timer.getTime() is SECONDS; the original's Date.now()*0.003 is
  -- ms, so *0.003 per ms becomes *3 per second here.
  local pulse = (math.sin(love.timer.getTime() * 3) + 1) / 2

  local radius = (target.halfWidth or target.radius or 0) + OUTLINE_PADDING

  -- ctx.globalAlpha multiplied against a fillStyle that already has its
  -- own alpha baked in (0.35 for the glow, 1 for the core) — replicated
  -- here as a straight alpha product, same convention PullBeam.lua's
  -- own two-layer outline already uses.
  love.graphics.setLineWidth(OUTLINE_GLOW_WIDTH)
  love.graphics.setColor(OUTLINE_R, OUTLINE_G, OUTLINE_B, 0.35 * (0.35 + pulse * 0.25))
  love.graphics.circle("line", target.pos.x, target.pos.y, radius)

  love.graphics.setLineWidth(OUTLINE_CORE_WIDTH)
  love.graphics.setColor(OUTLINE_R, OUTLINE_G, OUTLINE_B, 0.8 + pulse * 0.2)
  love.graphics.circle("line", target.pos.x, target.pos.y, radius)

  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.setLineWidth(1)
end

function LockOutline.draw()
  local player = state.player
  if not player or not player.lockedTarget or player.mode ~= "space" then return end
  LockOutline.drawRingAround(player.lockedTarget)
end

return LockOutline
