// js/vector2.js
//
// Note the deliberate asymmetry: add(), addScaled(), scale() and
// normalize() MUTATE this vector and return it (chainable, in place),
// while subtract() and multiply() return a BRAND NEW Vector2 and leave
// the original untouched. Game code relies on this distinction
// (`vel.clone().multiply(dt)` for a fresh vector, `pos.add(vel)` to move
// pos itself), so it's kept exactly as it is.

class Vector2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static new(x, y) {
    return new Vector2(x, y);
  }

  // Mutates this, returns this.
  add(v) {
    this.x += v.x;
    this.y += v.y;
    return this;
  }

  // Mutates this, returns this — `this.add(v.clone().multiply(s))`
  // without the two throwaway vectors. Used in hot per-frame loops
  // (position integration: `pos.addScaled(vel, timeScale)`).
  addScaled(v, s) {
    this.x += v.x * s;
    this.y += v.y * s;
    return this;
  }

  // Mutates this, returns this (e.g. drag: `vel.scale(drag ** ts)`).
  scale(s) {
    this.x *= s;
    this.y *= s;
    return this;
  }

  // Returns a NEW Vector2.
  subtract(v) {
    return new Vector2(this.x - v.x, this.y - v.y);
  }

  // Returns a NEW Vector2.
  multiply(s) {
    return new Vector2(this.x * s, this.y * s);
  }

  length() {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }

  lengthSq() {
    return this.x * this.x + this.y * this.y;
  }

  // Mutates this, returns this.
  normalize() {
    const len = this.length();
    if (len > 0) {
      this.x /= len;
      this.y /= len;
    }
    return this;
  }

  clone() {
    return new Vector2(this.x, this.y);
  }

  dot(v) {
    return this.x * v.x + this.y * v.y;
  }

  // Non-mutating stand-ins for the Lua version's a + b, a - b, a * s operators.
  plus(v) { return new Vector2(this.x + v.x, this.y + v.y); }
  minus(v) { return new Vector2(this.x - v.x, this.y - v.y); }
  times(s) { return new Vector2(this.x * s, this.y * s); }

  toString() {
    return `Vector2(${this.x}, ${this.y})`;
  }
}

export default Vector2;
