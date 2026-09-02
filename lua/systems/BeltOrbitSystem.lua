-- lua/systems/BeltOrbitSystem.lua

local state = require("lua.state")
local worldGen = require("lua.setup.worldGen")

local RESTORE = 0.012
local TANGENT_KEEP = 0.02

local function apply(planetoids)
  if not planetoids then return end

  local sunX, sunY = worldGen.sunPos()
  local dt = state.timeScale or 1
  local orbitSpeed = worldGen.BELT_ORBIT_SPEED or 2.7

  for _, p in ipairs(planetoids) do
    if p.isBeltPlanetoid and not p.isImmovable and p.vel and p.pos then
      local dx = p.pos.x - sunX
      local dy = p.pos.y - sunY
      local dist = math.sqrt(dx * dx + dy * dy)
      if dist < 1 then dist = 1 end

      local nx, ny = dx / dist, dy / dist
      local tx, ty = -ny, nx

      local targetR = p.beltOrbitRadius or dist
      local radialErr = targetR - dist

      p.vel.x = p.vel.x + nx * radialErr * RESTORE * dt
      p.vel.y = p.vel.y + ny * radialErr * RESTORE * dt

      local tangSpeed = p.vel.x * tx + p.vel.y * ty
      if tangSpeed < orbitSpeed then
        local boost = (orbitSpeed - tangSpeed) * TANGENT_KEEP * dt
        p.vel.x = p.vel.x + tx * boost
        p.vel.y = p.vel.y + ty * boost
      end
    end
  end
end

return { apply = apply }