export class Vector2 {
    constructor(x = 0, y = 0) { this.x = x; this.y = y; }
    add(v) { this.x += v.x; this.y += v.y; return this; }
    subtract(v) { return new Vector2(this.x - v.x, this.y - v.y); }
    multiply(s) { return new Vector2(this.x * s, this.y * s); }
    length() { return Math.sqrt(this.x * this.x + this.y * this.y); }
    lengthSq() { return this.x * this.x + this.y * this.y; }
    normalize() { const len = this.length(); if (len > 0) { this.x /= len; this.y /= len; } return this; }
    clone() { return new Vector2(this.x, this.y); }
    dot(v) { return this.x * v.x + this.y * v.y; }
}

// Distance between two points, without allocating a temporary Vector2
// (these run thousands of times per step; garbage there causes hitches).
export function distance(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}
