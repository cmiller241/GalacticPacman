// js/interiors/PlatformInterior.js
import { Interior } from './Interior.js';
import { state } from '../state.js';
import { Vector2 } from '../vector2.js';
import { Sprite, Texture, Graphics, BlurFilter } from 'pixi.js';

// Shared — the 8 swirl particles are always the same small green dot,
// only their position (recomputed live from Date.now() every frame,
// not a spawn/death lifecycle the way BeamPlanetoid's own particles
// are) ever changes.
let swirlTexture = null;
function getSwirlTexture() {
  if (swirlTexture) return swirlTexture;
  const r = 2;
  const canvas = document.createElement('canvas');
  canvas.width = r * 2;
  canvas.height = r * 2;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fillStyle = '#baff9a';
  ctx.fill();
  swirlTexture = Texture.from(canvas);
  return swirlTexture;
}

export class PlatformInterior extends Interior {
  constructor(planetoid) {
    super(planetoid);
    this.cols = 28;
    this.rows = 29;
    this.tileSize = 12;
    this.exitColLeft = 24;
    this.exitColRight = 25;
    this.exitRow = 25;
    this.tiles = [
      "............................",
      "..........#######...........",
      "..........H.................",
      "..........H.................",
      "..........H.................",
      "..........H.................",
      "...######################...",
      ".............H.......H......",
      ".............H.......H......",
      ".............H.......H......",
      ".............H.......H......",
      "..########################..",
      ".......H........H...........",
      ".......H........H...........",
      ".......H....................",
      ".......H....................",
      "..########################..",
      "...........H........H.......",
      "...........H........H.......",
      "...........H........H.......",
      "...........H........H.......",
      "..########################..",
      ".....H......................",
      ".....H......................",
      ".....H......................",
      ".....H......................",
      "############################",
      "............................",
      "............................"
    ];
    this.offscreen = null;
    this.createOffscreen();
    this.blobs=[];
  }

  createOffscreen() {
    const width = this.cols * this.tileSize;
    const height = this.rows * this.tileSize;
    this.offscreen = document.createElement('canvas');
    this.offscreen.width = width;
    this.offscreen.height = height;
    const offCtx = this.offscreen.getContext('2d');
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const tile = this.tiles[row][col];
        const x = col * this.tileSize;
        const y = row * this.tileSize;
        // PLATFORM BLOCK
        if (tile === "#") {
          offCtx.fillStyle = "#6b3f1d";
          offCtx.fillRect(x, y, this.tileSize, this.tileSize);
          offCtx.strokeStyle = "#3b200f";
          offCtx.strokeRect(x, y, this.tileSize, this.tileSize);
          // highlight strip
          offCtx.fillStyle = "rgba(255,255,255,0.15)";
          offCtx.fillRect(x, y, this.tileSize, 6);
        }
        // LADDER
        if (tile === "H") {
          const centerX = x + this.tileSize / 2;
          const railOffset = 3;
          const leftRail = centerX - railOffset;
          const rightRail = centerX + railOffset;
          offCtx.strokeStyle = "#d8c38f";
          offCtx.lineWidth = 2;
          // vertical rails
          offCtx.beginPath();
          offCtx.moveTo(leftRail, y);
          offCtx.lineTo(leftRail, y + this.tileSize);
          offCtx.moveTo(rightRail, y);
          offCtx.lineTo(rightRail, y + this.tileSize);
          offCtx.stroke();
          // ladder rungs
          for (let r = 3; r < this.tileSize; r += 4) {
            offCtx.beginPath();
            offCtx.moveTo(leftRail, y + r);
            offCtx.lineTo(rightRail, y + r);
            offCtx.stroke();
          }
        }
      }
    }
  }

  // ----------------------------
  // PIXI RENDERING (PlatformInterior — the semi-transparent exterior/
  // space-view overlay drawn ON the platform planet from outside, NOT
  // the walkable interior-mode rendering itself, which lives
  // elsewhere). Deliberately scoped to NOT include
  // blobs.forEach(blob => blob.draw()) — BlobMonster's own rendering
  // wasn't available to port against this session, so blobs stay
  // unrendered here, same as it already was (draw() itself is dead
  // code in the actual game now, same as everywhere else in this
  // migration).
  //
  // The portal's glow used a live BlurFilter here rather than the
  // GPU-native RenderTexture bake technique the planet BODY needed —
  // deliberately: that technique existed specifically to avoid paying
  // a blur cost 50+ times per cell activation, and none of that
  // applies here. There is exactly one PlatformInterior, permanently,
  // and its portal's own radius pulses continuously, so nothing about
  // it could be baked once anyway. A persistent .filters array on a
  // live Graphics object, redrawn every frame, is Pixi's own ordinary
  // way of doing a live blur — no manual renderer.render() call
  // needed at all, Pixi applies it automatically as part of its
  // normal render pass.
  // ----------------------------
  createPixiSprites(layer) {
    if (this.pixiWallSprite) return;

    this.pixiWallSprite = new Sprite(Texture.from(this.offscreen));
    this.pixiWallSprite.anchor.set(0, 0); // top-left, matching the original's own drawImage(img, offsetX, offsetY) semantics
    this.pixiWallSprite.alpha = 0.6;
    layer.addChild(this.pixiWallSprite);

    // Blurred backdrop behind a sharp foreground copy — same two-
    // layer technique already established for Explosion's flash and
    // the planet body's own glow, reproducing shadowBlur's actual
    // behavior (a blurred COPY behind the sharp original, not the
    // sharp original itself blurred). BlurFilter's own strength isn't
    // a verified 1:1 match for shadowBlur's pixel value — same
    // reasoned-estimate caveat as the planet body's own glow (roughly
    // half the original shadowBlur=20).
    this.pixiPortalGlow = new Graphics();
    this.pixiPortalGlow.filters = [new BlurFilter({ strength: 10, quality: 4 })];
    layer.addChild(this.pixiPortalGlow);

    this.pixiPortalCore = new Graphics();
    layer.addChild(this.pixiPortalCore);

    // 8 persistent sprites, always present for this interior's whole
    // lifetime — unlike BeamPlanetoid's own particles, these have no
    // spawn/death lifecycle at all; draw() itself recomputes all 8
    // positions fresh from Date.now() every single call, so there's
    // nothing to pool or track, just 8 sprites whose position gets
    // updated every frame.
    this.pixiSwirlSprites = [];
    for (let i = 0; i < 8; i++) {
      const s = new Sprite(getSwirlTexture());
      s.anchor.set(0.5, 0.5);
      // Additive blending — the direct equivalent of draw()'s own
      // ctx.globalCompositeOperation = "lighter", applied ONLY to
      // these swirl sprites (not the portal glow/core above), same
      // scope the original's own composite-operation change had.
      s.blendMode = 'add';
      layer.addChild(s);
      this.pixiSwirlSprites.push(s);
    }
  }

  // Called every frame in place of draw() once migrated.
  updatePixiSprites(layer) {
    if (!this.pixiWallSprite) this.createPixiSprites(layer);
    if (!this.pixiWallSprite) return;

    const offsetX = this.planetoid.pos.x - (this.cols * this.tileSize / 2);
    const offsetY = this.planetoid.pos.y - (this.rows * this.tileSize / 2);
    this.pixiWallSprite.position.set(offsetX, offsetY);

    const portal = this.getPortalPosition();
    const time = Date.now() * 0.004;
    const pulse = (Math.sin(Date.now() * 0.006) + 1) / 2;
    const portalRadius = 8 + pulse * 3;
    const portalAlpha = 0.7 + pulse * 0.3;

    this.pixiPortalGlow.clear();
    this.pixiPortalGlow.circle(portal.x, portal.y, portalRadius).fill({ color: 0x39ff14, alpha: portalAlpha });
    this.pixiPortalCore.clear();
    this.pixiPortalCore.circle(portal.x, portal.y, portalRadius).fill({ color: 0x39ff14, alpha: portalAlpha });

    const swirlCount = this.pixiSwirlSprites.length;
    for (let i = 0; i < swirlCount; i++) {
      const angle = time + (i / swirlCount) * Math.PI * 2;
      const radius = 12 + Math.sin(time * 2 + i) * 3;
      this.pixiSwirlSprites[i].position.set(
        portal.x + Math.cos(angle) * radius,
        portal.y + Math.sin(angle) * radius
      );
    }
  }

  // NOTE: not currently wired to anything — platformPlanet is
  // isPermanent, so this can never actually run in the current game
  // (same situation as BeamPlanetoid's own destroyPixiSprite).
  // Implemented anyway for correctness rather than leaving a silent
  // gap.
  destroyPixiSprite() {
    this.pixiWallSprite?.destroy({ texture: true, textureSource: true }); // unique to this one interior
    this.pixiWallSprite = null;
    this.pixiPortalGlow?.destroy();
    this.pixiPortalGlow = null;
    this.pixiPortalCore?.destroy();
    this.pixiPortalCore = null;
    if (this.pixiSwirlSprites) {
      for (const s of this.pixiSwirlSprites) s.destroy();
      this.pixiSwirlSprites = null;
    }
  }

  draw() {
    const ctx = state.ctx;
    const offsetX = this.planetoid.pos.x - (this.cols * this.tileSize / 2);
    const offsetY = this.planetoid.pos.y - (this.rows * this.tileSize / 2);
    ctx.save();
    ctx.globalAlpha = 0.6;
    if (this.offscreen) {
      ctx.drawImage(this.offscreen, offsetX, offsetY);
    }
    ctx.globalAlpha = 1;
    // ===== PLATFORM PORTAL =====
    const portal = this.getPortalPosition();
    const time = Date.now() * 0.004;
    const pulse = (Math.sin(Date.now() * 0.006) + 1) / 2;
    ctx.save();
    // glow
    ctx.shadowColor = "#39ff14";
    ctx.shadowBlur = 20;
    // core portal
    ctx.beginPath();
    ctx.arc(portal.x, portal.y, 8 + pulse * 3, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(57,255,20,${0.7 + pulse * 0.3})`;
    ctx.fill();
    ctx.globalCompositeOperation = "lighter";
    // swirl particles
    const swirlCount = 8;
    for (let i = 0; i < swirlCount; i++) {
      const angle = time + (i / swirlCount) * Math.PI * 2;
      const radius = 12 + Math.sin(time * 2 + i) * 3;
      const x = portal.x + Math.cos(angle) * radius;
      const y = portal.y + Math.sin(angle) * radius;
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fillStyle = "#baff9a";
      ctx.fill();
    }

    // Draw Blob Monsters
    this.blobs.forEach(blob => blob.draw());

    ctx.restore();
    ctx.restore();
  }

  getPortalPosition() {
    const offsetX = this.planetoid.pos.x - (this.cols * this.tileSize / 2);
    const offsetY = this.planetoid.pos.y - (this.rows * this.tileSize / 2);
    const portalX = offsetX + (this.exitColLeft + 0.5) * this.tileSize + this.tileSize / 2;
    const portalY = offsetY + this.exitRow * this.tileSize + this.tileSize / 2;
    return new Vector2(portalX, portalY);
  }
}