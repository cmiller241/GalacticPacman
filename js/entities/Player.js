// js/entities/Player.js
import { Entity } from './Entity.js';
import { state } from '../state.js';
import {
  GRAVITY_STRENGTH,
  GROUND_POUND_GRAV_MULTIPLIER,
  GROUND_POUND_PUSH_STRENGTH,
  JUMP_STRENGTH,
  MOVE_SPEED,
  PLAYER_LINEAR_SPEED,
  PLAYER_RADIUS,
  SURFACE_TOLERANCE,
  DRAG
} from '../constants.js';
import { Vector2 } from '../vector2.js';
import {
  createDeathParticles,
  createParticles,
  angleDiff
} from '../utils.js';
import { Particle } from './Particle.js';
import { BeamPlanetoid } from '../world/BeamPlanetoid.js';
import { MazeInterior } from '../interiors/MazeInterior.js';

export class Player extends Entity {
  constructor(x, y) {
    super();
    this.pos = new Vector2(x, y);
    this.vel = new Vector2(0, 0);
    this.radius = PLAYER_RADIUS;
    this.onSurface = false;
    this.onGround = false;
    this.currentPlanet = null;
    this.currentInterior = null;
    this.lastInfluencePlanet = null;
    this.angle = 0;
    this.facingDirection = 1;
    this.isGroundPounding = false;
    this.mode = "space";
    this.mazeCol = 14;
    this.mazeRow = 15;
    this.mazeDir = new Vector2(1, 0);
    this.platformPos = null;
    this.platformVel = new Vector2(0, 0);
    this.lastMoveTime = 0;
    this.lastEnterPressTime = 0;
    this.isTeleporting = false;
    this.teleportTargetMode = null;
    this.teleportStartTime = 0;
    this.teleportDuration = 900;
    this.teleportScale = 1;
    this.teleportGlow = 0;
    this.isDying = false;
    this.deathStartTime = 0;
    this.deathDuration = 1200;
    this.deathScale = 1;
    this.deathRotation = 0;
    this.deathAlpha = 1;
    this.teleportRenderPos = null;

    // === ASTRONAUT PROPERTIES ===
    this.scale = 0.075;           // ← Lowered from 0.38 (roughly 1/5th size)
    this.time = 0;
    this.isJumping = false;
    this.jumpProgress = 0;

    this.images = {
      body: new Image(), head: new Image(),
      leftarm: new Image(), rightarm: new Image(),
      leftboot: new Image(), rightboot: new Image()
    };

    const srcs = {
      body: 'img/body.png', head: 'img/head.png',
      leftarm: 'img/leftarm.png', rightarm: 'img/rightarm.png',
      leftboot: 'img/leftboot.png', rightboot: 'img/rightboot.png'
    };

    let loaded = 0;
    Object.keys(this.images).forEach(k => {
      this.images[k].src = srcs[k];
      this.images[k].onload = () => { if (++loaded === 6) console.log("✅ Astronaut assets loaded"); };
    });

    this.config = {
      bodyY: 115, headY: -400,
      leftArmX: 136, leftArmY: 9, leftArmJointX: 73, leftArmJointY: 199,
      rightArmX: -186, rightArmY: -14, rightArmJointX: 119, rightArmJointY: 40,
      leftBootX: 111, leftBootY: 241, leftBootJointX: 83, leftBootJointY: 15,
      rightBootX: -142, rightBootY: 241, rightBootJointX: 77, rightBootJointY: 15
    };
  }

  // All other methods are unchanged (startTeleport, move, jump, update, draw, etc.)
  // Copy the rest exactly from the previous full version I gave you.

  startTeleport(targetMode, targetPos = null) {
    this.isTeleporting = true;
    this.teleportTargetMode = targetMode;
    this.teleportStartTime = Date.now();
    this.teleportScale = 1;
    this.teleportGlow = 0;
    this.teleportRenderPos = this.pos.clone();

    if (targetMode === "space") {
      this.vel = new Vector2(0, 0);
      this.onSurface = false;
    }

    if (targetPos && targetMode === "platform") {
      this.platformPos = targetPos.clone();
    }
  }

  startDeath() {
    if (!this.isDying) {
      this.isDying = true;
      this.deathStartTime = Date.now();
      this.deathScale = 1;
      this.deathRotation = 0;
      this.deathAlpha = 1;
      createDeathParticles(this.pos, 400);
      state.audioManager.playDeath();
    }
  }

  applyGravity() {
    if (this.onSurface) return;
    let planet = state.gravitySystem.findDominantPlanet(this.pos);
    if (!planet && this.lastInfluencePlanet) planet = this.lastInfluencePlanet;
    if (planet) {
      this.lastInfluencePlanet = planet;
      const direction = planet.pos.subtract(this.pos).normalize();
      let grav = GRAVITY_STRENGTH;
      if (this.isGroundPounding) grav *= GROUND_POUND_GRAV_MULTIPLIER;
      this.vel.add(direction.multiply(grav));
    }
  }

  isSolidTile(x, y) {
    const interior = this.currentInterior;
    if (!interior) return false;
    const tileX = Math.floor(x / interior.tileSize);
    const tileY = Math.floor(y / interior.tileSize);
    return interior.tiles[tileY]?.[tileX] === '#';
  }

  updateMazePosition() {
    const interior = this.currentInterior;
    const planet = this.currentPlanet;
    if (!interior || !planet) return;

    const offsetX = planet.pos.x - (interior.cols * interior.tileSize / 2);
    const offsetY = planet.pos.y - (interior.rows * interior.tileSize / 2);

    this.pos.x = offsetX + this.mazeCol * interior.tileSize + interior.tileSize / 2;
    this.pos.y = offsetY + this.mazeRow * interior.tileSize + interior.tileSize / 2;
  }

  updatePlatformPosition() {
    if (this.isTeleporting) return;
    const interior = this.currentInterior;
    const planet = this.currentPlanet;
    if (!interior || !planet) return;

    const offsetX = planet.pos.x - (interior.cols * interior.tileSize / 2);
    const offsetY = planet.pos.y - (interior.rows * interior.tileSize / 2);

    this.pos.x = offsetX + this.platformPos.x;
    this.pos.y = offsetY + this.platformPos.y;
  }

  enterInterior(targetMode) {
    const interior = this.currentPlanet?.interior;
    if (!interior) return;
    this.mode = targetMode;
    this.currentInterior = interior;
    this.onSurface = false;

    if (targetMode === "maze") {
      this.mazeCol = interior.exitColLeft;
      this.mazeRow = interior.exitRow;
      this.mazeDir = new Vector2(1, 0);
      this.lastMoveTime = Date.now();
      this.updateMazePosition();
    } else if (targetMode === "platform") {
      this.platformPos = new Vector2(
        (interior.exitColLeft + 0.5) * interior.tileSize,
        (interior.exitRow + 0.5) * interior.tileSize
      );
      this.platformVel = new Vector2(0, 0);
      const tileX = Math.floor(this.platformPos.x / interior.tileSize);
      const tileY = Math.floor(this.platformPos.y / interior.tileSize);
      const belowTile = interior.tiles[tileY + 1]?.[tileX];
      this.onGround = belowTile === "#" || belowTile === "H";
      this.updatePlatformPosition();
    }
  }

  exitInterior() {
    this.mode = "space";
    this.currentInterior = null;
    if (this.currentPlanet) {
      const surfaceDist = this.currentPlanet.radius + PLAYER_RADIUS;
      this.pos.x = this.currentPlanet.pos.x + Math.cos(this.currentPlanet.beamAngle) * surfaceDist;
      this.pos.y = this.currentPlanet.pos.y + Math.sin(this.currentPlanet.beamAngle) * surfaceDist;
      this.angle = this.currentPlanet.beamAngle;
      this.onSurface = true;
      this.lastInfluencePlanet = this.currentPlanet;
    }
  }

  isAtPortal() {
    const interior = this.currentInterior;
    if (!interior) return false;

    const portalCenter = new Vector2(
      (interior.exitColLeft + 1) * interior.tileSize,
      (interior.exitRow + 0.5) * interior.tileSize
    );

    if (this.mode === "maze") {
      return this.mazeRow === interior.exitRow &&
             (this.mazeCol === interior.exitColLeft || this.mazeCol === interior.exitColRight);
    } else if (this.mode === "platform") {
      return this.platformPos.subtract(portalCenter).length() < interior.tileSize * 0.8;
    }
    return false;
  }

  move(keys) {
    if (this.isTeleporting) return;
    const now = Date.now();

    if ((this.mode === "maze" || this.mode === "platform") && keys['Enter'] && now - this.lastEnterPressTime > 300) {
      this.lastEnterPressTime = now;
      if (this.isAtPortal()) {
        this.startTeleport("space");
        return;
      }
    }

    if (this.mode === "space" && keys['Enter'] && now - this.lastEnterPressTime > 300) {
      this.lastEnterPressTime = now;
      if (this.onSurface && this.currentPlanet instanceof BeamPlanetoid) {
        const diff = angleDiff(this.angle, this.currentPlanet.beamAngle);
        if (diff < Math.PI / 5) {
          const interiorType = this.currentPlanet.interior instanceof MazeInterior ? "maze" : "platform";
          this.startTeleport(interiorType);
          return;
        }
      }
    }

    if (this.mode === "maze") {
      if (now - this.lastMoveTime < 110) return;
      let dx = 0, dy = 0;
      if (keys['ArrowLeft']) dx = -1;
      if (keys['ArrowRight']) dx = 1;
      if (keys['ArrowUp']) dy = -1;
      if (keys['ArrowDown']) dy = 1;
      if (dx !== 0 || dy !== 0) {
        const newCol = this.mazeCol + dx;
        const newRow = this.mazeRow + dy;
        if (!this.currentInterior.walls[newRow]?.[newCol]) {
          this.mazeCol = newCol;
          this.mazeRow = newRow;
          this.mazeDir = new Vector2(dx || this.mazeDir.x, dy || this.mazeDir.y).normalize();
          this.lastMoveTime = now;
          this.updateMazePosition();
        }
      }
      return;
    }

    if (this.mode === "platform") {
      if (keys['ArrowLeft']) {
        this.platformVel.x = -MOVE_SPEED * 60;
        this.facingDirection = -1;
      } else if (keys['ArrowRight']) {
        this.platformVel.x = MOVE_SPEED * 60;
        this.facingDirection = 1;
      } else {
        this.platformVel.x = 0;
      }

      const interior = this.currentInterior;
      const tileSize = interior.tileSize;
      const tiles = interior.tiles;
      const centerX = this.platformPos.x;
      const centerY = this.platformPos.y;
      const halfWidth = this.radius * 0.4;
      const halfHeight = this.radius * 0.4;
      const tileX = Math.floor(centerX / tileSize);
      const tileY = Math.floor(centerY / tileSize);
      const onLadder = tiles[tileY]?.[tileX] === 'H';
      const footTileY = Math.floor((centerY + halfHeight) / tileSize);
      const ladderBelow = tiles[footTileY + 1]?.[tileX] === 'H';

      if (this.onGround && keys['ArrowDown'] && ladderBelow) {
        this.onGround = false;
        this.platformVel.y = MOVE_SPEED * 60;
      }

      if (onLadder) {
        if (keys['ArrowUp']) this.platformVel.y = -MOVE_SPEED * 60;
        else if (keys['ArrowDown']) this.platformVel.y = MOVE_SPEED * 60;
        else this.platformVel.y = 0;
      } else if (!this.onGround) {
        this.platformVel.y += GRAVITY_STRENGTH;
      }

      let newX = this.platformPos.x + this.platformVel.x;
      const left = newX - halfWidth;
      const right = newX + halfWidth;
      const midY = this.platformPos.y;

      if (this.platformVel.x < 0 && (this.isSolidTile(left, this.platformPos.y - halfHeight + 0.1) || this.isSolidTile(left, midY))) {
        newX = (Math.floor(left / tileSize) + 1) * tileSize + halfWidth;
        this.platformVel.x = 0;
      } else if (this.platformVel.x > 0 && (this.isSolidTile(right, this.platformPos.y - halfHeight + 0.1) || this.isSolidTile(right, midY))) {
        newX = Math.floor(right / tileSize) * tileSize - halfWidth;
        this.platformVel.x = 0;
      }
      this.platformPos.x = newX;

      let newY = this.platformPos.y + this.platformVel.y;
      const leftFoot = this.platformPos.x - halfWidth + 0.1;
      const rightFoot = this.platformPos.x + halfWidth - 0.1;
      const newBottom = newY + halfHeight;
      const newTop = newY - halfHeight;

      this.onGround = false;

      if (this.platformVel.y < 0 && !onLadder) {
        if (this.isSolidTile(leftFoot, newTop) || this.isSolidTile(rightFoot, newTop)) {
          newY = (Math.floor(newTop / tileSize) + 1) * tileSize + halfHeight;
          this.platformVel.y = 0;
        }
      } else if (this.platformVel.y >= 0) {
        const wantsDrop = keys['ArrowDown'] && ladderBelow;
        if (!wantsDrop && (this.isSolidTile(leftFoot, newBottom) || this.isSolidTile(rightFoot, newBottom))) {
          newY = Math.floor(newBottom / tileSize) * tileSize - halfHeight;
          this.platformVel.y = 0;
          this.onGround = true;
        }
        if (wantsDrop) {
          this.platformVel.y = MOVE_SPEED * 60;
        }
      }

      this.platformPos.y = newY;

      if (this.platformPos.y > interior.rows * tileSize + 100) {
        this.platformPos.y = 0;
        this.platformVel.y = 0;
      }

      this.updatePlatformPosition();
      return;
    }

    if (this.onSurface && this.currentPlanet) {
      const surfaceDist = this.currentPlanet.radius + this.radius;
      const angularSpeed = PLAYER_LINEAR_SPEED / surfaceDist;

      if (keys['ArrowLeft']) {
        this.angle -= angularSpeed;
        this.facingDirection = -1;
      }
      if (keys['ArrowRight']) {
        this.angle += angularSpeed;
        this.facingDirection = 1;
      }
      this.pos.x = this.currentPlanet.pos.x + Math.cos(this.angle) * surfaceDist;
      this.pos.y = this.currentPlanet.pos.y + Math.sin(this.angle) * surfaceDist;
    }
  }

  jump() {
    if (this.mode === "platform") {
      if (this.onGround) {
        this.platformVel.y = -JUMP_STRENGTH * 0.5;
        this.onGround = false;
        this.isJumping = true;
        this.jumpProgress = 0;
        state.audioManager.playJump();
      }
      return;
    }

    if (this.onSurface && this.currentPlanet) {
      const direction = this.pos.subtract(this.currentPlanet.pos).normalize();
      this.vel = direction.multiply(JUMP_STRENGTH);
      this.onSurface = false;
      this.currentPlanet = null;
      state.audioManager.playJump();
    }
  }

  tryGroundPound() {
    if (this.isGroundPounding) return;
    let planet = state.gravitySystem.findDominantPlanet(this.pos) || this.lastInfluencePlanet;
    if (planet) {
      const outwardDir = this.pos.subtract(planet.pos).normalize();
      const radialVel = this.vel.dot(outwardDir);
      if (radialVel > 0) this.isGroundPounding = true;
    }
  }

  checkMazeDots() {
    if (this.mode !== "maze") return;
    const interior = this.currentInterior;
    for (let i = interior.dots.length - 1; i >= 0; i--) {
      const d = interior.dots[i];
      if (d.x === this.mazeCol && d.y === this.mazeRow) {
        state.audioManager.playEatDot();
        interior.dots.splice(i, 1);
        state.score += 10;
      }
    }
    for (let i = interior.powerPellets.length - 1; i >= 0; i--) {
      const p = interior.powerPellets[i];
      if (p.x === this.mazeCol && p.y === this.mazeRow) {
        state.audioManager.playEatDot();
        interior.powerPellets.splice(i, 1);
        state.score += 50;
      }
    }
  }

  update() {
    if (this.isDying) {
      const elapsed = Date.now() - this.deathStartTime;
      const t = Math.min(elapsed / this.deathDuration, 1);
      this.deathScale = 1 - (t * t * t);
      this.deathRotation += 0.2;
      this.deathAlpha = 1 - t;
      if (t >= 1) state.gameOver = true;
      return;
    }

    if (this.isTeleporting) {
      const elapsed = Date.now() - this.teleportStartTime;
      const t = Math.min(elapsed / this.teleportDuration, 1);
      if (!this.teleportRenderPos) this.teleportRenderPos = this.pos.clone();

      const pulse = Math.sin(t * Math.PI);
      this.teleportScale = 1 + pulse * 1.2;
      this.teleportGlow = pulse;

      if (Math.random() < 0.6 && this.currentPlanet) {
        const beamDir = new Vector2(Math.cos(this.currentPlanet.beamAngle), Math.sin(this.currentPlanet.beamAngle));
        const side = new Vector2(-beamDir.y, beamDir.x).multiply((Math.random() - 0.5) * 1.5);
        const vel = beamDir.multiply(2 + Math.random() * 2).add(side);
        state.particles.push(new Particle(this.teleportRenderPos.clone(), vel));
      }

      if (t >= 1) {
        this.isTeleporting = false;
        if (this.teleportTargetMode === "space") this.exitInterior();
        else if (this.teleportTargetMode === "maze") this.enterInterior("maze");
        else if (this.teleportTargetMode === "platform") this.enterInterior("platform");
        this.teleportRenderPos = null;
        this.teleportTargetMode = null;
      }
      return;
    }

    if (this.mode === "maze") {
      this.vel = new Vector2(0, 0);
      this.checkMazeDots();
      return;
    }

    if (this.mode === "platform") {
      const wasOnGround = this.onGround;
      if (this.onGround && !wasOnGround) {
        this.isJumping = false;
        this.jumpProgress = 0;
      }
      if (this.isJumping) {
        this.jumpProgress = Math.min(1, this.jumpProgress + 0.045);
      }
      const moving = Math.abs(this.platformVel.x) > 20;
      if (moving && this.onGround) this.time += 0.14;
    }

    if (!this.onSurface) {
      this.vel = this.vel.multiply(DRAG);
      this.pos.add(this.vel);

      if (this.pos.x - this.radius < 0) { this.pos.x = this.radius; this.vel.x = -this.vel.x; }
      if (this.pos.x + this.radius > state.sceneWidth) { this.pos.x = state.sceneWidth - this.radius; this.vel.x = -this.vel.x; }
      if (this.pos.y - this.radius < 0) { this.pos.y = this.radius; this.vel.y = -this.vel.y; }
      if (this.pos.y + this.radius > state.sceneHeight) { this.pos.y = state.sceneHeight - this.radius; this.vel.y = -this.vel.y; }
    }
  }

  drawPart(ctx, img, baseX, baseY, jointX, jointY, angle = 0) {
    ctx.save();
    ctx.translate(baseX, baseY);
    ctx.rotate(angle);
    ctx.drawImage(img, -jointX * this.scale, -jointY * this.scale, img.width * this.scale, img.height * this.scale);
    ctx.restore();
  }

  drawAstronaut(ctx, drawPos) {
    const s = this.scale;
    const cx = drawPos.x;
    const cy = drawPos.y;

    const walkAngle = (Math.abs(this.platformVel?.x || 0) > 20 && this.onGround) ? Math.sin(this.time) * 0.6 : 0;

    let leftBootAngle = walkAngle;
    let rightBootAngle = -walkAngle;
    let rightArmAngle = Math.sin(this.time) * 0.45 * 0.7;

    if (this.isJumping) {
      leftBootAngle = -0.70;
      rightBootAngle = 0.70;
      rightArmAngle = 2.27 * this.jumpProgress;
    }

    this.drawPart(ctx, this.images.leftboot,
      cx + this.config.leftBootX * s,
      cy + this.config.leftBootY * s,
      this.config.leftBootJointX, this.config.leftBootJointY, leftBootAngle);

    this.drawPart(ctx, this.images.leftarm,
      cx + this.config.leftArmX * s,
      cy + this.config.leftArmY * s,
      this.config.leftArmJointX, this.config.leftArmJointY, 0);

    const bodyX = cx - this.images.body.width * s / 2;
    const bodyY = cy - this.images.body.height * s / 2 + this.config.bodyY * s;
    ctx.drawImage(this.images.body, bodyX, bodyY, this.images.body.width * s, this.images.body.height * s);

    this.drawPart(ctx, this.images.rightboot,
      cx + this.config.rightBootX * s,
      cy + this.config.rightBootY * s,
      this.config.rightBootJointX, this.config.rightBootJointY, rightBootAngle);

    this.drawPart(ctx, this.images.rightarm,
      cx + this.config.rightArmX * s,
      cy + this.config.rightArmY * s,
      this.config.rightArmJointX, this.config.rightArmJointY, rightArmAngle);

    const headTilt = (this.platformVel?.x || 0) * 0.0008;
    ctx.save();
    ctx.translate(cx, cy + this.config.headY * s);
    ctx.rotate(headTilt);
    ctx.drawImage(this.images.head,
      -this.images.head.width * s / 2,
      -this.images.head.height * s / 2,
      this.images.head.width * s,
      this.images.head.height * s);
    ctx.restore();
  }

  draw() {
    const ctx = state.ctx;

    if (this.isDying) {
      ctx.save();
      ctx.globalAlpha = this.deathAlpha;
      const drawPos = this.isTeleporting ? this.teleportRenderPos : this.pos;
      ctx.translate(drawPos.x, drawPos.y);
      ctx.rotate(this.deathRotation);
      ctx.scale(this.deathScale, this.deathScale);
      ctx.shadowColor = 'orange';
      ctx.shadowBlur = 30 * (this.deathAlpha * 0.5);
      ctx.beginPath();
      ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
      ctx.fillStyle = '#ff6600';
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.restore();
      return;
    }

    let scale = 1;
    let glow = 0;
    if (this.isTeleporting) {
      scale = this.teleportScale;
      glow = this.teleportGlow;
    }

    const drawPos = this.isTeleporting ? this.teleportRenderPos : this.pos;

    if (this.mode === "platform" || this.mode === "space") {
      ctx.save();
      ctx.translate(drawPos.x, drawPos.y);

      if (this.facingDirection < 0) ctx.scale(-1, 1);
      if (this.isTeleporting) {
        ctx.shadowColor = 'yellow';
        ctx.shadowBlur = 40 * glow;
      }

      this.drawAstronaut(ctx, drawPos);

      ctx.shadowBlur = 0;
      ctx.restore();
    } else if (this.mode === "maze") {
      ctx.save();
      ctx.translate(drawPos.x, drawPos.y);
      if (this.isTeleporting) {
        ctx.shadowColor = 'yellow';
        ctx.shadowBlur = 40 * glow;
      }
      const rot = Math.atan2(this.mazeDir.y, this.mazeDir.x);
      ctx.rotate(rot);
      ctx.scale(scale * 0.4, scale * 0.4);
      ctx.beginPath();
      ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
      ctx.fillStyle = 'yellow';
      ctx.fill();
      ctx.restore();
    }
  }
}