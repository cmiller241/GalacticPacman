-- lua/vector2.lua
--
-- Direct translation of js/vector2.js, method for method. Lua has no
-- `class`/`new` keywords — this uses the standard idiom instead: a
-- table (Vector2) holding shared methods, a metatable on each
-- instance whose __index points back at that table so `v:add(...)`
-- finds Vector2.add, and a `.new()` function in place of a
-- constructor.
--
-- Deliberately kept as an exact behavioral match to the original,
-- including the asymmetry that matters most here: add() and
-- normalize() MUTATE self and return self (chainable, in place,
-- exactly like the JS), while subtract() and multiply() return a
-- BRAND NEW Vector2 and leave the original untouched — exactly like
-- the JS, and NOT the same behavior as add(). Ported game code that
-- relies on this distinction (e.g. patterns like
-- `vel:clone():multiply(dt)` expecting a fresh vector, or
-- `pos:add(vel)` expecting pos itself to change) will only work
-- correctly if this asymmetry is preserved exactly as it is in the
-- original — so it is, deliberately, not "cleaned up" into a
-- consistent style.

local Vector2 = {}
Vector2.__index = Vector2

function Vector2.new(x, y)
  local self = setmetatable({}, Vector2)
  self.x = x or 0
  self.y = y or 0
  return self
end

-- Mutates self, returns self — matches: add(v) { this.x += v.x; this.y += v.y; return this; }
function Vector2:add(v)
  self.x = self.x + v.x
  self.y = self.y + v.y
  return self
end

-- Not present in the JS version. Mutates self, returns self — equivalent
-- to `self:add(v:clone():multiply(s))` but without allocating the two
-- throwaway Vector2 tables that chain would create. Added specifically
-- for hot per-frame loops that run once per entity, per frame, across
-- potentially hundreds of entities (planetoid/asteroid/fireball/particle
-- position integration: `pos:addScaled(vel, timeScale)` in place of
-- `pos:add(vel:clone():multiply(timeScale))`) — see main.lua's
-- updatePlanetoidsPhysics for the original pattern this replaces.
function Vector2:addScaled(v, s)
  self.x = self.x + v.x * s
  self.y = self.y + v.y * s
  return self
end

-- Not present in the JS version. Mutates self, returns self — equivalent
-- to `self = self:multiply(s)` but without allocating a new Vector2 and
-- reassigning the field that held it. Same hot-loop motivation as
-- addScaled above (e.g. drag: `vel:scale(drag ^ ts)` in place of
-- `vel = vel:multiply(drag ^ ts)`).
function Vector2:scale(s)
  self.x = self.x * s
  self.y = self.y * s
  return self
end

-- Returns a NEW Vector2, does NOT mutate self — matches: subtract(v) { return new Vector2(this.x - v.x, this.y - v.y); }
function Vector2:subtract(v)
  return Vector2.new(self.x - v.x, self.y - v.y)
end

-- Returns a NEW Vector2, does NOT mutate self — matches: multiply(s) { return new Vector2(this.x * s, this.y * s); }
function Vector2:multiply(s)
  return Vector2.new(self.x * s, self.y * s)
end

function Vector2:length()
  return math.sqrt(self.x * self.x + self.y * self.y)
end

function Vector2:lengthSq()
  return self.x * self.x + self.y * self.y
end

-- Mutates self, returns self — matches: normalize() { const len = this.length(); if (len > 0) { this.x /= len; this.y /= len; } return this; }
function Vector2:normalize()
  local len = self:length()
  if len > 0 then
    self.x = self.x / len
    self.y = self.y / len
  end
  return self
end

function Vector2:clone()
  return Vector2.new(self.x, self.y)
end

function Vector2:dot(v)
  return self.x * v.x + self.y * v.y
end

-- Not present in the JS version, added here as a plain Lua
-- convenience since it costs nothing and doesn't change any existing
-- behavior: operator overloading via metamethods, so `a + b` works
-- as sugar for a NON-mutating add (mirroring subtract/multiply's own
-- non-mutating style, not add()'s mutating one, since an operator
-- silently mutating an operand would be a surprising footgun).
Vector2.__add = function(a, b) return Vector2.new(a.x + b.x, a.y + b.y) end
Vector2.__sub = function(a, b) return Vector2.new(a.x - b.x, a.y - b.y) end
Vector2.__mul = function(a, s) return Vector2.new(a.x * s, a.y * s) end
Vector2.__tostring = function(v) return "Vector2(" .. v.x .. ", " .. v.y .. ")" end

return Vector2