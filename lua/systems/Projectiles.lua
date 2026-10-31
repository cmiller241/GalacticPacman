-- lua/systems/Projectiles.lua
--
-- The blasters' shots in flight: fireballs (see lua/entities/Fireball.lua)
-- and ice bolts (lua/entities/IceBolt.lua) — moving them, passing them
-- through portals, and everything they can hit. Called once a frame from
-- love.update, after the planetoids, the player and the water have moved.
--
-- Fireballs are checked against each kind of target in turn (water, ice
-- cubes, mirrors, prisms, asteroids and planets, ball tunnels, walls,
-- levers, Ooombas); a fireball that hits something is gone before the
-- next check sees it. The order matters: mirrors go first, and a fireball
-- a mirror just turned is left alone by the destructive checks this frame.

local state = require("lua.state")
local Explosion = require("lua.entities.Explosion")
local IceBolt = require("lua.entities.IceBolt")
local Prism = require("lua.world.Prism")
local PortalGun = require("lua.systems.PortalGun")
local WaterSystem = require("lua.systems.WaterSystem")
local Breakage = require("lua.systems.Breakage")

local Projectiles = {}

-- Removes, back to front, every item of `list` that `test` picks (test
-- may also act on the ones it picks — they're visited back to front).
local function removeWhere(list, test)
  for i = #list, 1, -1 do
    if test(list[i]) then table.remove(list, i) end
  end
end

-- A shot going off at (x, y): its explosion and its bang.
local function explodeAt(x, y)
  table.insert(state.explosions, Explosion.new(x, y))
  if state.audioManager then state.audioManager:playFireball() end
end

-- ---------------------------------------------------------------------
-- Fireballs
-- ---------------------------------------------------------------------

-- Into water: it goes out in a burst of steam, boiling some of the water
-- off (see WaterSystem.quenchFireball).
local function hitWater(fireballs)
  removeWhere(fireballs, WaterSystem.quenchFireball)
end

-- Into a frozen Ooomba's ice cube: the ice melts into a splash of water
-- and steam, and the Ooomba walks on, unharmed (see WaterSystem.fireHitsIce).
-- (The level's ice blocks are walls: hitWalls melts those.)
local function hitIceCubes(fireballs)
  removeWhere(fireballs, function(f)
    if not WaterSystem.fireHitsIce(f) then return false end
    table.insert(state.explosions, Explosion.new(f.pos.x, f.pos.y))
    return true
  end)
end

-- Prisms (see lua/world/Prism.lua): a fireball that reaches one goes off
-- against it, and the whole cluster lights up — and, on its last hit,
-- shatters into rubinium (see Breakage.breakPrismCluster). Checked before
-- the planetoids, since every prism is standing on one.
local function hitPrisms(fireballs, reflected)
  if not state.prisms then return end
  removeWhere(fireballs, function(f)
    local prism = not reflected[f] and Prism.findAt(state.prisms, f.pos.x, f.pos.y, f.radius)
    if not prism then return false end
    local shattered = prism:hit()
    explodeAt(f.pos.x, f.pos.y)
    if shattered then Breakage.breakPrismCluster(prism) end
    return true
  end)
end

-- Asteroids and planetoids. A shot asteroid breaks apart the same way one
-- that hits a planetoid does (see Breakage.breakAsteroid). A planetoid
-- hit: an obsidian or ice block's walkable top melts the block (see
-- WaterSystem.fireHitsWall); a breakable planet (see
-- lua/world/CrackedPlanetoid.lua) loses bricks.
local function hitAsteroidsAndPlanets(fireballs, reflected, collisionSystem, planetoids)
  if not state.asteroids then return end
  local hitFireballs, toBreakAsteroids, planetHits = collisionSystem:handleFireballCollisions(
    fireballs, planetoids, state.asteroids)
  for a in pairs(toBreakAsteroids) do
    explodeAt(a.pos.x, a.pos.y)
    Breakage.breakAsteroid(a, nil)
  end
  for _, hit in ipairs(planetHits) do
    if not reflected[hit.fireball] then
      local f = hit.fireball
      explodeAt(f.pos.x, f.pos.y)
      if hit.planet.blockWall then WaterSystem.fireHitsWall(hit.planet.blockWall) end
      if hit.planet.takeHit then hit.planet:takeHit(f.pos.x, f.pos.y, f.vel.x, f.vel.y) end
    end
  end
  removeWhere(fireballs, function(f) return hitFireballs[f] and not reflected[f] end)
end

-- Into a ball-tunnel piece (see TiledTerrain.lua's Level:tunnelSolidAt).
local function hitTunnels(fireballs)
  if not state.tiledLevels then return end
  removeWhere(fireballs, function(f)
    for _, level in ipairs(state.tiledLevels) do
      if level:tunnelSolidAt(f.pos.x, f.pos.y) then
        explodeAt(f.pos.x, f.pos.y)
        return true
      end
    end
    return false
  end)
end

-- WALL tiles (not Gates — see handleFireballWallCollisions): a fireball
-- explodes against one like it does against a planet. An obsidian block
-- starts melting back into lava; an ice block melts into water.
local function hitWalls(fireballs, reflected, collisionSystem)
  if not state.tiledLevels or #fireballs == 0 then return end
  local hitWall = {}
  for _, level in ipairs(state.tiledLevels) do
    for f, wall in pairs(collisionSystem:handleFireballWallCollisions(fireballs, level.walls)) do
      hitWall[f] = wall
    end
  end
  removeWhere(fireballs, function(f)
    if not hitWall[f] or reflected[f] then return false end
    WaterSystem.fireHitsWall(hitWall[f])
    explodeAt(f.pos.x, f.pos.y)
    return true
  end)
end

-- Levers: a fireball hitting one engages it (see Lever:engage) and goes
-- off, like against a wall.
local function hitLevers(fireballs, reflected, collisionSystem)
  if not state.levers or #fireballs == 0 then return end
  local hitLever = collisionSystem:handleFireballLeverCollisions(fireballs, state.levers)
  removeWhere(fireballs, function(f)
    if not hitLever[f] or reflected[f] then return false end
    explodeAt(f.pos.x, f.pos.y)
    return true
  end)
end

-- Ooombas: a fireball kills one outright — it's gone in an explosion,
-- and the fireball is spent.
local function hitOoombas(fireballs, collisionSystem)
  if not state.ooombas or #state.ooombas == 0 or #fireballs == 0 then return end
  local hitFireballs, killed = collisionSystem:handleFireballOoombaCollisions(fireballs, state.ooombas)
  removeWhere(state.ooombas, function(o)
    if not killed[o] then return false end
    explodeAt(o.pos.x, o.pos.y)
    return true
  end)
  removeWhere(fireballs, function(f) return hitFireballs[f] end)
end

local function updateFireballs(collisionSystem, planetoids)
  local fireballs = state.fireballs
  if not fireballs then return end

  removeWhere(fireballs, function(f)
    f:update()
    return f:isDead()
  end)
  -- Through a portal, before anything below can see one hit the portal's
  -- own surface (see PortalGun.passFireballs).
  PortalGun.passFireballs(fireballs, state.timeScale)

  hitWater(fireballs)
  hitIceCubes(fireballs)
  if #fireballs == 0 then return end

  -- Mirrors get first look: a reflected fireball just had its velocity and
  -- position turned, not destroyed, and it's only a few pixels off the
  -- mirror's face — so it's left out of every destructive check below
  -- this frame.
  local reflected = state.mirrors and collisionSystem:handleFireballMirrorCollisions(fireballs, state.mirrors) or {}

  hitPrisms(fireballs, reflected)
  hitAsteroidsAndPlanets(fireballs, reflected, collisionSystem, planetoids)
  hitTunnels(fireballs)
  hitWalls(fireballs, reflected, collisionSystem)
  hitLevers(fireballs, reflected, collisionSystem)
  hitOoombas(fireballs, collisionSystem)
end

-- ---------------------------------------------------------------------
-- Ice bolts
-- ---------------------------------------------------------------------

-- Whether ice bolt b has hit something: water it reaches freezes into an
-- ice block and lava turns to water (and so to obsidian) — see
-- WaterSystem.iceBoltHit; an Ooomba is frozen in an ice cube; anything
-- else solid, it shatters on.
local function iceBoltHits(b, collisionSystem, planetoids)
  if WaterSystem.iceBoltHit(b) then return true end
  for _, o in ipairs(state.ooombas or {}) do
    if not o.frozen and not o.isSquashing and not o.portalTransit then
      local dx, dy = b.pos.x - o.pos.x, b.pos.y - o.pos.y
      local r = b.radius + o.hitRadius * 1.3
      if dx * dx + dy * dy < r * r then
        WaterSystem.encaseOoomba(o)
        return true
      end
    end
  end
  local hit = false
  for _, level in ipairs(state.tiledLevels or {}) do
    if next(collisionSystem:handleFireballWallCollisions({ b }, level.walls)) then hit = true end
  end
  if hit then return true end
  return collisionSystem:handleFireballCollisions({ b }, planetoids, {})[b] or false
end

local function updateIceBolts(collisionSystem, planetoids)
  local bolts = state.iceBolts
  if not bolts or #bolts == 0 then return end
  removeWhere(bolts, function(b)
    b:update()
    return b:isDead()
  end)
  PortalGun.passFireballs(bolts, state.timeScale)
  removeWhere(bolts, function(b)
    if not iceBoltHits(b, collisionSystem, planetoids) then return false end
    IceBolt.burst(b.pos.x, b.pos.y, 12)
    return true
  end)
end

-- planetoids: the ones worth colliding with this frame (main.lua leaves
-- off-screen belt planetoids out).
function Projectiles.update(collisionSystem, planetoids)
  updateFireballs(collisionSystem, planetoids)
  updateIceBolts(collisionSystem, planetoids)
end

return Projectiles
