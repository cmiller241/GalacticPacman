// js/entities/world/Coin.js
import { Entity } from '../Entity.js';
import { state } from '../../state.js';
import { COIN_RADIUS, COIN_ORBIT_OFFSET } from '../../constants.js';
import { Vector2 } from '../../vector2.js';
import { Container, Sprite, Texture } from 'pixi.js';

// Shared across EVERY coin — COIN_RADIUS is a fixed global constant
// (not varied per-planet or per-coin), so every coin's body/highlight
// are pixel-for-pixel identical; only position and rotation differ per
// instance. Baked once here rather than as live per-instance Graphics
// objects, which is what this file originally used and turned out to
// be the actual cause of a real, measured framerate drop once coins
// were added — confirmed directly against Pixi's own performance
// documentation ("Using 100s of graphics complex objects can be slow,
// in this instance use sprites (you can create a texture)"), not just
// assumed: with potentially thousands of coins alive at once across a
// full 3x3 cell neighborhood, two live Graphics objects EACH is
// precisely the "hundreds of Graphics" case that guidance warns about.
// A shared, pre-baked texture + cheap Sprite per instance is the
// officially-recommended fix, and what every other entity in this
// migration already does — this was the one file that deviated from
// that pattern, not a new technique introduced here.
let coinBodyTexture = null;
function getCoinBodyTexture() {
  if (coinBodyTexture) return coinBodyTexture;
  const rx = COIN_RADIUS * 0.65;
  const ry = COIN_RADIUS;
  const strokeWidth = 2;
  const pad = strokeWidth; // margin so the rim stroke doesn't get clipped at the canvas edge
  const canvas = document.createElement('canvas');
  canvas.width = (rx + pad) * 2;
  canvas.height = (ry + pad) * 2;
  const ctx = canvas.getContext('2d');
  ctx.translate(rx + pad, ry + pad);
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd700'; // gold
  ctx.fill();
  ctx.strokeStyle = 'rgba(184,134,11,0.8)'; // darker gold rim
  ctx.lineWidth = strokeWidth;
  ctx.stroke();
  coinBodyTexture = Texture.from(canvas);
  return coinBodyTexture;
}

let coinHighlightTexture = null;
function getCoinHighlightTexture() {
  if (coinHighlightTexture) return coinHighlightTexture;
  const r = COIN_RADIUS * 0.4;
  const canvas = document.createElement('canvas');
  canvas.width = r * 2;
  canvas.height = r * 2;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.fill();
  coinHighlightTexture = Texture.from(canvas);
  return coinHighlightTexture;
}

export class Coin extends Entity {
  constructor(planet) {
    super();
    this.planet = planet;
    this.angularSpeed = (Math.random() - 0.5) * 0.04;
    this.angle = 0;
    this.radius = COIN_RADIUS;
    this.orbitRadius = planet.radius + COIN_ORBIT_OFFSET;

    // Rounded-rect planets don't have a single "angle" — they use the
    // same arc-length perimeter-walk parameterization the player uses
    // to walk their surface, just always drifting (never player-
    // controlled) and pushed further out (COIN_ORBIT_OFFSET instead of
    // PLAYER_RADIUS).
    this.orbitOffset = COIN_ORBIT_OFFSET;
    this.arcPos = planet.isRoundedRect ? Math.random() * planet.getPerimeter() : 0;
    this.arcSpeed = (Math.random() - 0.5) * 2; // px/frame, comparable visual speed to the circular case

    // Elliptical, vertically-long dimensions for the new Pixi rendering
    // below (see createPixiSprite) — classic Mario-coin proportions
    // (narrower than tall), rather than draw()'s own plain circle.
    // Deliberately separate from this.radius, which stays exactly as
    // it was and keeps driving draw()'s own untouched Canvas2D
    // fallback, plus the actual pickup-collision radius elsewhere
    // (CollisionSystem.js's own handleCoinCollisions) — this is a
    // purely visual change, not a hitbox change.
    this.radiusX = this.radius * 0.65;
    this.radiusY = this.radius;

    this.updatePosition();
  }

  updatePosition() {
    if (this.planet.isRoundedRect) {
      const world = this.planet.worldPointAtArcPosition(this.arcPos, this.orbitOffset);
      this.pos.x = world.point.x;
      this.pos.y = world.point.y;
    } else {
      this.pos.x = this.planet.pos.x + Math.cos(this.angle) * this.orbitRadius;
      this.pos.y = this.planet.pos.y + Math.sin(this.angle) * this.orbitRadius;
    }
  }

  update() {
    if (this.planet.isRoundedRect) {
      this.arcPos += this.arcSpeed * state.timeScale;
    } else {
      this.angle += this.angularSpeed * state.timeScale;
    }
    this.updatePosition();
  }

  draw() {
    const ctx = state.ctx;
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, this.radius, 0, Math.PI * 2);
    ctx.fillStyle = 'gold';
    ctx.fill();
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(Date.now() * 0.01);
    ctx.beginPath();
    ctx.arc(-this.radius*0.4, -this.radius*0.4, this.radius*0.4, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fill();
    ctx.restore();
  }

  // Lazily builds the coin's Pixi representation — a body Sprite and a
  // highlight Sprite, both wrapping the shared textures above, rather
  // than either being its own live Graphics object (see this file's
  // own header comment on why that was the actual performance bug).
  // draw()'s own rotating highlight worked by rotating the CANVAS'S
  // LOCAL COORDINATE SYSTEM around the coin's center, not by moving
  // the highlight's own position; the Pixi equivalent of that isn't a
  // redraw at all, it's a Container (highlightPivot below) whose own
  // .rotation gets set every frame in updatePixiSprite — the same
  // "rotate the local space, not the shape" idea, just expressed as a
  // transform instead of a redraw, so there's nothing to rebuild every
  // frame for either sprite, only two numbers (position, rotation) to
  // update on the whole coin each frame.
  createPixiSprite(coinLayer) {
    if (this.pixiContainer) return;

    const container = new Container();

    const body = new Sprite(getCoinBodyTexture());
    body.anchor.set(0.5, 0.5);

    const highlightPivot = new Container();
    const highlight = new Sprite(getCoinHighlightTexture());
    highlight.anchor.set(0.5, 0.5);
    // The highlight texture itself is a plain, centered circle with no
    // offset baked in — this reproduces the same off-center placement
    // (-radiusY*0.4, -radiusY*0.4) the original Graphics version baked
    // directly into its own circle() call, applied here as the
    // sprite's own position within its rotating parent instead.
    highlight.position.set(-this.radiusY * 0.4, -this.radiusY * 0.4);
    highlightPivot.addChild(highlight);

    container.addChild(body, highlightPivot);
    coinLayer.addChild(container);

    this.pixiContainer = container;
    this.pixiHighlightPivot = highlightPivot;
  }

  // Called every frame in place of draw() once migrated.
  updatePixiSprite(coinLayer) {
    if (!this.pixiContainer) this.createPixiSprite(coinLayer);

    this.pixiContainer.position.set(this.pos.x, this.pos.y);
    this.pixiHighlightPivot.rotation = Date.now() * 0.01;
  }

  // Called from PixiStage.js's own sync function when this coin is
  // removed (picked up, or its planet was culled/despawned — see
  // CollisionSystem.js's own handleCoinCollisions and worldGen.js's
  // own cullDistantObjects). No texture:true here — both sprites wrap
  // the SHARED textures above (every coin's body/highlight are
  // pixel-for-pixel identical), so only the sprite/container instances
  // themselves get destroyed; destroying the shared texture itself
  // would break every other still-alive coin's own rendering.
  destroyPixiSprite() {
    if (this.pixiContainer) {
      this.pixiContainer.destroy({ children: true });
      this.pixiContainer = null;
      this.pixiHighlightPivot = null;
    }
  }
}