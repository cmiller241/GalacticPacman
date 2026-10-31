-- lua/systems/Breakage.lua
--
-- Things breaking apart: an asteroid that hits a planetoid or is shot,
-- and a prism cluster shot to pieces — the bang, the debris, and what
-- they leave behind (smaller asteroids, rubinium, asteroidium). Used by
-- main.lua's asteroid collisions and by lua/systems/Projectiles.lua.

local state = require("lua.state")
local Vector2 = require("lua.vector2")
local Particle = require("lua.entities.Particle")
local Explosion = require("lua.entities.Explosion")
local Asteroid = require("lua.entities.Asteroid")
local ElementPiece = require("lua.entities.ElementPiece")

local Breakage = {}

-- Plain debris burst — port of js/utils.js's createParticles: `count`
-- of Particle.lua's default small yellow particles thrown out in every
-- direction.
function Breakage.spawnDebrisParticles(pos, count)
  for _ = 1, count do
    local angle = math.random() * math.pi * 2
    local speed = math.random() * 4 + 2
    table.insert(state.particles, Particle.new(pos, Vector2.new(math.cos(angle) * speed, math.sin(angle) * speed)))
  end
end

-- What happens when a cluster of prisms takes its last shot (see
-- Prism.DESTROY_HITS): every prism of it goes up in an explosion and is
-- gone for good, and RUBINIUM_PER_CLUSTER pieces of rubinium (see
-- lua/entities/ElementPiece.lua) are thrown out of the wreck — each from
-- somewhere along one of the prisms, out the way that prism pointed —
-- and then make their own way to him.
--
-- prism: any one prism of the cluster.
local RUBINIUM_PER_CLUSTER = 6
function Breakage.breakPrismCluster(prism)
  local cluster = prism.group.prisms

  local gone = {}
  for _, p in ipairs(cluster) do
    gone[p] = true
    local x, y = p:pointAlong(0.5)
    table.insert(state.explosions, Explosion.new(x, y))
  end
  for i = #state.prisms, 1, -1 do
    if gone[state.prisms[i]] then table.remove(state.prisms, i) end
  end

  local midX, midY = cluster[1]:pointAlong(0.5)
  Breakage.spawnDebrisParticles(Vector2.new(midX, midY), 60)
  if state.audioManager then state.audioManager:playBang("large", Vector2.new(midX, midY)) end

  for _ = 1, RUBINIUM_PER_CLUSTER do
    local from = cluster[math.random(#cluster)]
    local x, y, dirX, dirY = from:pointAlong(0.2 + math.random() * 0.7)
    table.insert(state.elementPieces, ElementPiece.new("rubinium", x, y, dirX, dirY))
  end
end

-- Port of js/game.js's breakAsteroid — what happens to an asteroid
-- that's hit a planetoid or been shot: it's gone in a bang and a burst
-- of debris, and unless it was already small (radius under 15) it
-- leaves 2 smaller asteroids behind (3 if it was a big one, radius over
-- 30), each half its radius, flung apart.
--
-- One too small to leave any pieces (radius under ASTEROID_SPLIT_MIN_RADIUS)
-- just bursts.
--
-- Asteroidium (see lua/entities/ElementPiece.lua), only when it was
-- SHOT: a too-small one always leaves some; a bigger one has an
-- ASTEROIDIUM_CHANCE chance of leaving some INSTEAD of breaking into
-- smaller asteroids. How many is part size, part luck — see
-- asteroidiumCountFor. (The title screen's autopilot earns it too; what
-- it collected is thrown away when the game starts — see
-- TitleScreen.lua's own beginGame.)
--
-- planet: the planetoid it hit, or nil if it was shot. One deliberate
-- difference from the JS, for a round planetoid only: the pieces are
-- thrown AWAY from its surface, off the planetoid's own velocity. The
-- original threw them in any direction off the asteroid's own inbound
-- velocity, which sent about half of them straight back into the
-- planetoid to break again the very next frame.
local ASTEROID_SPLIT_MIN_RADIUS = 15
local ASTEROIDIUM_CHANCE = 0.3
-- The radius at which an asteroid gives the most it can (anything
-- bigger gives the same) — about the biggest the field generates.
local ASTEROIDIUM_FULL_RADIUS = 45

-- How many pieces a shot asteroid of this radius leaves: a random number
-- in a range that climbs with its size — 1 to 2 for the smallest, 2 to 4
-- for a middling one, 3 to 6 for the biggest.
local function asteroidiumCountFor(radius)
  local size = (radius - ASTEROID_SPLIT_MIN_RADIUS) / (ASTEROIDIUM_FULL_RADIUS - ASTEROID_SPLIT_MIN_RADIUS)
  size = math.max(0, math.min(1, size))
  return math.random(1 + math.floor(size * 2), 2 + math.floor(size * 4 + 0.5))
end

function Breakage.breakAsteroid(ast, planet)
  for i = #state.asteroids, 1, -1 do
    if state.asteroids[i] == ast then
      table.remove(state.asteroids, i)
      break
    end
  end

  if state.audioManager then
    local size = (ast.radius > 30 and "large") or (ast.radius > 20 and "medium") or "small"
    state.audioManager:playBang(size, ast.pos)
  end
  Breakage.spawnDebrisParticles(ast.pos, 150)
  local tooSmallToSplit = ast.radius < ASTEROID_SPLIT_MIN_RADIUS
  if not planet and (tooSmallToSplit or math.random() < ASTEROIDIUM_CHANCE) then
    for _ = 1, asteroidiumCountFor(ast.radius) do
      local angle = math.random() * math.pi * 2
      -- Starting a little way out from its middle, more for a bigger one.
      local out = math.random() * ast.radius * 0.6
      table.insert(state.elementPieces, ElementPiece.new("asteroidium",
        ast.pos.x + math.cos(angle) * out, ast.pos.y + math.sin(angle) * out, math.cos(angle), math.sin(angle)))
    end
    return
  end
  if tooSmallToSplit then return end

  local awayAngle, baseVel = nil, ast.vel
  if planet and planet.radius and not planet.isRoundedRect then
    awayAngle = math.atan2(ast.pos.y - planet.pos.y, ast.pos.x - planet.pos.x)
    baseVel = planet.vel or ast.vel
  end

  local pieceCount = ast.radius > 30 and 3 or 2
  for _ = 1, pieceCount do
    local piece = Asteroid.new(ast.pos.x, ast.pos.y, ast.radius / 2)
    local angle = awayAngle and (awayAngle + (math.random() - 0.5) * math.pi * 0.8) or (math.random() * math.pi * 2)
    local speed = 2 + math.random() * 3
    piece.vel = Vector2.new(baseVel.x + math.cos(angle) * speed, baseVel.y + math.sin(angle) * speed)
    piece.angle = math.random() * math.pi * 2
    piece.angularSpeed = (math.random() * 2 - 1) * 0.1
    -- A title-screen asteroid's pieces stay title-screen asteroids (see
    -- TitleScreen.lua's own updateTitleAsteroids): same idea, a drift
    -- relative to the belt's orbit, worked out from the velocity each
    -- piece was just given.
    if ast.titleDrift then
      piece.titleDrift = {
        x = piece.vel.x - (ast.vel.x - ast.titleDrift.x),
        y = piece.vel.y - (ast.vel.y - ast.titleDrift.y),
      }
    end
    table.insert(state.asteroids, piece)
  end
  Breakage.spawnDebrisParticles(ast.pos, 10)
end

return Breakage
