-- lua/effects/DustPuff.lua
--
-- Shared dusty tan/beige particle-puff spawner. Originally lived as a
-- private helper inside Player.lua (footstep dust while walking,
-- and the bigger burst on a wall-jump kick-off) — pulled out here once a
-- second entity (RobotButler.lua) needed the exact same "kick up dust
-- while walking" look, so the color/radius/drag/growRate tuning only
-- needs to live in one place regardless of who's walking.

local state = require("lua.state")
local Particle = require("lua.entities.Particle")

local DustPuff = {}

-- h in degrees [0,360), s/l in [0,1] -> r,g,b in [0,1]. LÖVE has no CSS
-- color parsing (unlike the original's `hsl(...)` fillStyle string), so
-- the same random-hue-in-a-dusty-tan-range trick needs converting by
-- hand to feed Particle.color's plain {r,g,b} table.
local function hslToRgb(h, s, l)
  if s == 0 then return l, l, l end
  local function hueToRgb(p, q, t)
    if t < 0 then t = t + 1 end
    if t > 1 then t = t - 1 end
    if t < 1 / 6 then return p + (q - p) * 6 * t end
    if t < 1 / 2 then return q end
    if t < 2 / 3 then return p + (q - p) * (2 / 3 - t) * 6 end
    return p
  end
  local q = l < 0.5 and (l * (1 + s)) or (l + s - l * s)
  local p = 2 * l - q
  local hNorm = h / 360
  return hueToRgb(p, q, hNorm + 1 / 3), hueToRgb(p, q, hNorm), hueToRgb(p, q, hNorm - 1 / 3)
end

-- Three overlapping sub-circles per particle instead of one plain
-- circle — a fused clover-shaped blob (think three coins pressed
-- together), not a uniform dot. Spaced evenly around the center
-- (120 degrees apart) at a small, consistent distance so they always
-- fuse into one clumped shape rather than sometimes drifting apart into
-- three separate dots — the only per-puff randomness is an overall
-- rotation (baseAngle) plus a little jitter, so a "bunch of them" reads
-- as the same recognizable shape rotated differently, not a different
-- shape each time. Positions/sizes are FRACTIONS of the particle's own
-- radius (see Particle.lua's own blobs comment), generated once per
-- particle and reused every frame, so the cluster stays fused to itself
-- as the particle drifts and grows rather than reshuffling frame to frame.
local function randomBlobs()
  local baseAngle = math.random() * math.pi * 2
  local blobs = {}
  for i = 0, 2 do
    table.insert(blobs, {
      angle = baseAngle + i * (2 * math.pi / 3) + (math.random() - 0.5) * 0.4,
      distFrac = 0.26 + math.random() * 0.12,
      radiusFrac = 0.62 + math.random() * 0.28,
    })
  end
  return blobs
end

-- Spawns one puff of `count` particles, all starting at the same point
-- and scattering outward from there. Parameters:
--
--   pos             Vector2 — world-space spawn point for every particle
--                   in this puff (e.g. a character's feet, or the exact
--                   spot a wall-jump kicked off from).
--
--   intoSurfaceDir  Vector2, unit length — points INTO whatever surface
--                   is being kicked off of: straight down (0,1) for an
--                   ordinary footstep, or the wall's own inward normal
--                   for a wall-jump kick. Particles drift AWAY from this
--                   (i.e. along its negation) — out of the surface and
--                   into open space, not through it.
--
--   sideDir         Vector2, unit length, perpendicular to
--                   intoSurfaceDir — the "along the surface" direction
--                   used to scatter particles sideways (e.g. along the
--                   ground for a footstep) instead of every particle
--                   flying dead straight away from the surface.
--
--   count           How many particles this one call spawns.
--
--   sideSpreadScale How far particles can scatter sideways, in world
--                   units/60fps-tick — each particle's own sideways
--                   speed is randomized between -sideSpreadScale/2 and
--                   +sideSpreadScale/2 along sideDir. Bigger = a wider
--                   spray; smaller = a tighter column.
--
--   driftMin,       The range each particle's OUTWARD (away from the
--   driftMax        surface) drift speed is randomized within, in world
--                   units/60fps-tick. Together with sideSpreadScale,
--                   this shapes the puff: a gentle footstep uses a small
--                   range (a soft drift up), a wall-jump kick uses a
--                   bigger one (a sharper burst outward).
function DustPuff.spawn(pos, intoSurfaceDir, sideDir, count, sideSpreadScale, driftMin, driftMax)
  for _ = 1, count do
    local sideSpread = (math.random() - 0.5) * sideSpreadScale
    local driftSpeed = driftMin + math.random() * (driftMax - driftMin)
    local vel = sideDir:clone():multiply(sideSpread):add(intoSurfaceDir:clone():multiply(-driftSpeed))

    local particle = Particle.new(pos, vel, 22 + math.random() * 14)
    particle.color = { hslToRgb(35 + math.random() * 15, (30 + math.random() * 15) / 100, (55 + math.random() * 15) / 100) } -- dusty tan/beige
    particle.radius = 2 + math.random() * 1.5
    particle.drag = 0.9      -- slows down rather than drifting at constant speed forever, like real dust settling
    particle.growRate = 0.06 -- gently expands over its life, like a puff dispersing rather than staying a fixed-size dot
    particle.blobs = randomBlobs()
    table.insert(state.particles, particle)
  end
end

return DustPuff
