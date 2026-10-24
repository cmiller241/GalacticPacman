// js/entities/world/Asteroid.js
import { Entity } from '../Entity.js';
import { state } from '../../state.js';
import { DRAG, PLANET_SPEED } from '../../constants.js';
import { Vector2 } from '../../vector2.js';
import { Sprite, Texture } from 'pixi.js';

export class Asteroid extends Entity {
  constructor(x, y, radius) {
    super();
    this.pos = new Vector2(x, y);
    this.radius = radius;
    this.mass = radius * radius;
    let direction = new Vector2(Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
    this.vel = direction.multiply(PLANET_SPEED);
    this.angularSpeed = (Math.random() * 2 - 1) * 0.05;
    this.angle = Math.random() * Math.PI * 2;
    this.color = '#A85417'; // ~10% brighter again on top of the previous '#994C15'
    this.points = this.generatePoints();

    // --- Generate interior points once for stable facets ---
    this.interiorPoints = [];
    const numInterior = 2 + Math.floor(Math.random() * 2); // 2-3 points
    for (let i = 0; i < numInterior; i++) {
      this.interiorPoints.push(new Vector2(
        (Math.random() - 0.5) * this.radius * 1.2,
        (Math.random() - 0.5) * this.radius * 1.2
      ));
    }
  }

  generatePoints() {
    const numSides = 6 + Math.floor(Math.random() * 6); // 6-11 sides
    const points = [];
    const angleStep = 2 * Math.PI / numSides;
    for (let i = 0; i < numSides; i++) {
      const a = i * angleStep + (Math.random() - 0.5) * angleStep * 0.5;
      const r = this.radius * (0.7 + Math.random() * 0.6);
      points.push(new Vector2(Math.cos(a) * r, Math.sin(a) * r));
    }
    return points;
  }

  update() {
    // Math.pow rather than a plain multiply for drag: DRAG is an
    // exponential per-frame decay rate, so scaling it correctly by
    // state.timeScale means raising it to that power, not multiplying
    // it — otherwise the asteroid's velocity would decay at its normal,
    // un-slowed rate even while its visible movement is slowed down,
    // and it wouldn't actually resume at the same velocity once V.A.T.S.
    // ends (see Player.js's applyPullForce for the fuller version of
    // this same reasoning, applied to gravity/pull acceleration).
    this.vel = this.vel.multiply(Math.pow(DRAG, state.timeScale));
    this.pos.add(this.vel.clone().multiply(state.timeScale));
    this.angle += this.angularSpeed * state.timeScale;

    // Bounce off walls
    if (this.pos.x - this.radius < 0) { this.pos.x = this.radius; this.vel.x = -this.vel.x; }
    if (this.pos.x + this.radius > state.sceneWidth) { this.pos.x = state.sceneWidth - this.radius; this.vel.x = -this.vel.x; }
    if (this.pos.y - this.radius < 0) { this.pos.y = this.radius; this.vel.y = -this.vel.y; }
    if (this.pos.y + this.radius > state.sceneHeight) { this.pos.y = state.sceneHeight - this.radius; this.vel.y = -this.vel.y; }
  }

  draw() {
    const ctx = state.ctx;
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.angle);

    const lightDir = new Vector2(-0.7, -0.7).normalize();
    const baseR = parseInt(this.color.substr(1, 2), 16);
    const baseG = parseInt(this.color.substr(3, 2), 16);
    const baseB = parseInt(this.color.substr(5, 2), 16);

    // --- Draw triangles along perimeter edges + interior points ---
    for (let i = 0; i < this.points.length; i++) {
      const j = (i + 1) % this.points.length;
      const p1 = this.points[i].clone();
      const p2 = this.points[j].clone();

      // Connect each interior point to the edge
      this.interiorPoints.forEach(ip => {
        this.fillTriangle(ctx, p1, p2, ip, baseR, baseG, baseB, lightDir);
      });

      // Optional subdivision along the edge itself for extra micro-facets
      const mid = p1.clone().add(p2).multiply(0.5);
      this.fillTriangle(ctx, p1, mid, p2, baseR, baseG, baseB, lightDir);
    }

    // --- Outline ---
    ctx.beginPath();
    ctx.moveTo(this.points[0].x, this.points[0].y);
    for (let i = 1; i < this.points.length; i++) {
      ctx.lineTo(this.points[i].x, this.points[i].y);
    }
    ctx.closePath();
    ctx.strokeStyle = '#3A1C08';
    ctx.lineWidth = 2;
    ctx.stroke();

    // --- Subtle inner shadow ---
    const shadowGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, this.radius);
    shadowGrad.addColorStop(0, 'rgba(0,0,0,0)');
    shadowGrad.addColorStop(0.7, 'rgba(0,0,0,0.15)');
    shadowGrad.addColorStop(1, 'rgba(0,0,0,0.3)');
    ctx.fillStyle = shadowGrad;

    ctx.beginPath();
    ctx.moveTo(this.points[0].x, this.points[0].y);
    for (let i = 1; i < this.points.length; i++) {
      ctx.lineTo(this.points[i].x, this.points[i].y);
    }
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  // --- Helper to fill a triangle with shading ---
  fillTriangle(ctx, v0, v1, v2, baseR, baseG, baseB, lightDir) {
    const edge = v2.subtract(v1);
    const perp = new Vector2(edge.y, -edge.x);
    const normal = perp.lengthSq() > 0 ? perp.normalize() : new Vector2(0, 1);
    const dot = lightDir.dot(normal);

    const edgeDistance = (v1.length() + v2.length()) / (2 * this.radius);
    let brightness = 0.3 + Math.max(0, dot) * 0.7;
    brightness = brightness * (1 - 0.4 * edgeDistance) + 0.2;

    const cr = Math.min(255, Math.max(0, Math.floor(baseR * brightness)));
    const cg = Math.min(255, Math.max(0, Math.floor(baseG * brightness)));
    const cb = Math.min(255, Math.max(0, Math.floor(baseB * brightness)));

    ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
    ctx.beginPath();
    ctx.moveTo(v0.x, v0.y);
    ctx.lineTo(v1.x, v1.y);
    ctx.lineTo(v2.x, v2.y);
    ctx.closePath();
    ctx.fill();
  }

  // ----------------------------
  // PIXI RENDERING (asteroids — see js/render/PixiStage.js for the
  // full migration context, and Planetoid.js's own
  // createPixiSprites/updatePixiSprites for the same overall pattern
  // applied there first). draw()/fillTriangle() above are completely
  // untouched.
  // ----------------------------
  // Unlike Planetoid.js, there's no existing offscreen bake to wrap —
  // draw() redraws live every frame. But this.points/interiorPoints/
  // color are all generated once in the constructor and never change
  // after that, so there's nothing gained by redrawing live here
  // either; this bakes the identical visual ONCE into a fresh offscreen
  // canvas — reusing fillTriangle() directly, since it already takes
  // ctx as a parameter rather than assuming state.ctx — and wraps that
  // as a Pixi texture, positioned/rotated per frame via sprite
  // properties instead of redrawn every frame.
  createPixiSprite(asteroidLayer) {
    if (this.pixiSprite) return;

    // Baked at a resolution higher than "zoom=1" needs, same reasoning
    // and same resMultiplier source as Player.js's own
    // initScaledAssets — so zooming in doesn't upscale a low-res bake.
    const resMultiplier = Math.max(1, state.zoomMax || 2.5);
    // Half-extent covers the max possible vertex distance
    // (generatePoints' own radius * up-to-1.3 multiplier) plus a
    // couple of pixels of margin for the 2px outline stroke.
    const halfExtent = this.radius * 1.4;
    const size = halfExtent * 2;
    const bakeSize = Math.max(1, Math.round(size * resMultiplier));

    const canvas = document.createElement('canvas');
    canvas.width = bakeSize;
    canvas.height = bakeSize;
    const bctx = canvas.getContext('2d');
    bctx.scale(resMultiplier, resMultiplier);
    bctx.translate(halfExtent, halfExtent); // this.points' own local origin (0,0) lands at canvas center

    const lightDir = new Vector2(-0.7, -0.7).normalize();
    const baseR = parseInt(this.color.substr(1, 2), 16);
    const baseG = parseInt(this.color.substr(3, 2), 16);
    const baseB = parseInt(this.color.substr(5, 2), 16);

    for (let i = 0; i < this.points.length; i++) {
      const j = (i + 1) % this.points.length;
      const p1 = this.points[i].clone();
      const p2 = this.points[j].clone();
      this.interiorPoints.forEach(ip => {
        this.fillTriangle(bctx, p1, p2, ip, baseR, baseG, baseB, lightDir);
      });
      const mid = p1.clone().add(p2).multiply(0.5);
      this.fillTriangle(bctx, p1, mid, p2, baseR, baseG, baseB, lightDir);
    }

    bctx.beginPath();
    bctx.moveTo(this.points[0].x, this.points[0].y);
    for (let i = 1; i < this.points.length; i++) bctx.lineTo(this.points[i].x, this.points[i].y);
    bctx.closePath();
    bctx.strokeStyle = '#3A1C08';
    bctx.lineWidth = 2;
    bctx.stroke();

    const shadowGrad = bctx.createRadialGradient(0, 0, 0, 0, 0, this.radius);
    shadowGrad.addColorStop(0, 'rgba(0,0,0,0)');
    shadowGrad.addColorStop(0.7, 'rgba(0,0,0,0.15)');
    shadowGrad.addColorStop(1, 'rgba(0,0,0,0.3)');
    bctx.fillStyle = shadowGrad;
    bctx.beginPath();
    bctx.moveTo(this.points[0].x, this.points[0].y);
    for (let i = 1; i < this.points.length; i++) bctx.lineTo(this.points[i].x, this.points[i].y);
    bctx.closePath();
    bctx.fill();

    const sprite = new Sprite(Texture.from(canvas));
    sprite.anchor.set(0.5, 0.5); // canvas center = this.points' own local origin, same point this.pos represents
    sprite.width = size;
    sprite.height = size;
    asteroidLayer.addChild(sprite);
    this.pixiSprite = sprite;
  }

  // Called every frame in place of draw() once migrated.
  updatePixiSprite(asteroidLayer) {
    if (!this.pixiSprite) {
      this.createPixiSprite(asteroidLayer);
      if (!this.pixiSprite) return;
    }
    this.pixiSprite.position.set(this.pos.x, this.pos.y);
    this.pixiSprite.rotation = this.angle;
  }
}