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
  createParticles
} from '../utils.js';
import { Particle } from './Particle.js';

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
    this.mouthAngle = 0;
    this.facingDirection = 1;
    this.isGroundPounding = false;
    this.mode = "space";
    this.mazeCol = 14;
    this.mazeRow = 15;
    this.mazeDir = new Vector2(1, 0);
    this.platformPos = null;
    this.platformVel = new Vector2(0,0);
    this.lastMoveTime = 0;
    this.isTeleporting = false;
    this.teleportTargetMode = null; // "maze", "platform", or "space"
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
  }

  // ----------------------------
  // TELEPORT HELPER
  // ----------------------------
  startTeleport(targetMode, targetPos = null) {
    this.isTeleporting = true;
    this.teleportTargetMode = targetMode;
    this.teleportStartTime = Date.now();
    this.teleportScale = 1;
    this.teleportGlow = 0;
    this.vel = new Vector2(0, 0);
    this.onSurface = false;

    if (targetPos && targetMode === "platform") {
      this.platformPos = targetPos.clone();
    }
  }

  // ----------------------------
  // DEATH
  // ----------------------------
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

  // Helper: Check if a point (x,y) is inside a solid tile ('#')
  isSolidTile(x, y) {
    const interior = this.currentInterior;
    if (!interior) return false;
    const tileX = Math.floor(x / interior.tileSize);
    const tileY = Math.floor(y / interior.tileSize);
    return interior.tiles[tileY]?.[tileX] === '#';  // Only '#' blocks; 'H' is climbable/passable
  }

  updateMazePosition() {
    const interior = this.currentInterior;
    const planet = this.currentPlanet;   // still points to the BeamPlanetoid
  
    if (!interior || !planet) {
      console.warn("updatePlayerMazePosition: missing interior or planet");
      return;
    }
  
    const offsetX = planet.pos.x - (interior.cols * interior.tileSize / 2);
    const offsetY = planet.pos.y - (interior.rows * interior.tileSize / 2);
  
    this.pos.x = offsetX + this.mazeCol * interior.tileSize + interior.tileSize / 2;
    this.pos.y = offsetY + this.mazeRow * interior.tileSize + interior.tileSize / 2;
  }

  enterMazeMode() {
    const interior = this.currentPlanet?.interior;
    if (!interior) {
      console.error("Cannot enter maze: no planet or interior");
      return;
    }
    this.mode = "maze";
    this.currentInterior = interior;
    this.onSurface = false;
    this.mazeCol = interior.exitColLeft;
    this.mazeRow = interior.exitRow;
  
    this.mazeDir = new Vector2(1, 0);
    this.lastMoveTime = Date.now();
  
    this.updateMazePosition();
  }

  exitMazeMode() {
    this.mode = "space";
    this.currentInterior = null;
    if (this.currentPlanet) { // Assuming set before entering, or set to mazePlanet
      const surfaceDist = this.currentPlanet.radius + PLAYER_RADIUS;
      this.pos.x = this.currentPlanet.pos.x + Math.cos(this.currentPlanet.beamAngle) * surfaceDist;
      this.pos.y = this.currentPlanet.pos.y + Math.sin(this.currentPlanet.beamAngle) * surfaceDist;
      this.angle = this.currentPlanet.beamAngle;
      this.onSurface = true;
      this.lastInfluencePlanet = this.currentPlanet;
    }
  }

  updatePlatformPosition() {
    const interior = this.currentInterior;
    const planet = this.currentPlanet;
  
    if (!interior || !planet) {
      console.warn("updatePlayerPlatformPosition: missing interior or planet");
      return;
    }
  
    const offsetX = planet.pos.x - (interior.cols * interior.tileSize / 2);
    const offsetY = planet.pos.y - (interior.rows * interior.tileSize / 2);
  
    this.pos.x = offsetX + this.platformPos.x;
    this.pos.y = offsetY + this.platformPos.y;
  }

  enterPlatformMode() {
    const interior = this.currentPlanet?.interior;
    if (!interior) {
      console.error("Cannot enter platform: no planet or interior");
      return;
    }
  
    this.mode = "platform";
    this.currentInterior = interior;
    this.onSurface = false; // Not on planetary surface anymore
  
    // Spawn player at the portal exit tile (centered)
    this.platformPos = new Vector2(
      (interior.exitColLeft + 0.5) * interior.tileSize,
      (interior.exitRow + 0.5) * interior.tileSize
    );
  
    this.platformVel = new Vector2(0, 0);
  
    // Check if on ground immediately below
    const tileX = Math.floor(this.platformPos.x / interior.tileSize);
    const tileY = Math.floor(this.platformPos.y / interior.tileSize);
    const belowTile = interior.tiles[tileY + 1]?.[tileX];
    this.onGround = belowTile === "#" || belowTile === "H";
  
    // Sync global position
    this.updatePlatformPosition();
  }

  move(keys) {
    // ----------------------------
    // MAZE MODE
    // ----------------------------
    if (this.mode=="maze") {
      const now = Date.now();
      if (now - this.lastMoveTime < 110) return;
      let dx = 0, dy = 0;
      if (keys['ArrowLeft']) dx = -1;
      if (keys['ArrowRight']) dx = 1;
      if (keys['ArrowUp']) dy = -1;
      if (keys['ArrowDown']) dy = 1;
      if (dx !== 0 || dy !== 0) {
        const newCol = this.mazeCol + dx;
        const newRow = this.mazeRow + dy;
        if (dy === -1 && this.mazeRow === this.currentInterior.exitRow &&
          (this.mazeCol === this.currentInterior.exitColLeft || this.mazeCol === this.currentInterior.exitColRight)) {
          this.startTeleport("space");
          return;
        }
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


    // ----------------------------
    // PLATFORM MODE
    // ----------------------------
    if (this.mode === "platform") {
      const interior = this.currentInterior;
      const tileSize = interior.tileSize;
      const tiles = interior.tiles;

      // Horizontal input
      if (keys['ArrowLeft']) this.platformVel.x = -MOVE_SPEED * 60;
      else if (keys['ArrowRight']) this.platformVel.x = MOVE_SPEED * 60;
      else this.platformVel.x = 0;

      // Vertical input/checks (ladders)
      const centerX = this.platformPos.x;
      const centerY = this.platformPos.y;
      const halfWidth = this.radius * 0.4;
      const halfHeight = this.radius * 0.4;
      const tileX = Math.floor(centerX / tileSize);
      const tileY = Math.floor(centerY / tileSize);
      const onLadder = tiles[tileY]?.[tileX] === 'H';
      const footTileY = Math.floor((centerY + halfHeight) / tileSize);
      const ladderBelow = tiles[footTileY + 1]?.[tileX] === 'H';

        // allow dropping through platform onto ladder
        if (this.onGround && keys['ArrowDown'] && ladderBelow) {
        this.onGround = false;
        this.platformVel.y = MOVE_SPEED * 60;
        }

        if (onLadder) {
        if (keys['ArrowUp']) this.platformVel.y = -MOVE_SPEED * 60;
        else if (keys['ArrowDown']) this.platformVel.y = MOVE_SPEED * 60;
        else this.platformVel.y = 0;
        }
        else if (!this.onGround) {
        this.platformVel.y += GRAVITY_STRENGTH;
        }

      // Separate horizontal/vertical movement for better collision
      // Horizontal first (unchanged)
      let newX = this.platformPos.x + this.platformVel.x;
      const left = newX - halfWidth;
      const right = newX + halfWidth;
      const midY = this.platformPos.y; // Use center for side checks

      if (this.platformVel.x < 0 && (this.isSolidTile(left, this.platformPos.y - halfHeight + 0.1) || this.isSolidTile(left, midY))) {
        newX = (Math.floor(left / tileSize) + 1) * tileSize + halfWidth;
        this.platformVel.x = 0;
      } else if (this.platformVel.x > 0 && (this.isSolidTile(right, this.platformPos.y - halfHeight + 0.1) || this.isSolidTile(right, midY))) {
        newX = Math.floor(right / tileSize) * tileSize - halfWidth;
        this.platformVel.x = 0;
      }
      this.platformPos.x = newX;

      // Vertical — ONE-WAY PLATFORMS (this is the fix!)
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
      } 
      else if (this.platformVel.y >= 0) {

        const wantsDrop = keys['ArrowDown'] && ladderBelow;

        if (!wantsDrop &&
            (this.isSolidTile(leftFoot, newBottom) || this.isSolidTile(rightFoot, newBottom))) {

            newY = Math.floor(newBottom / tileSize) * tileSize - halfHeight;
            this.platformVel.y = 0;
            this.onGround = true;
        }

        // allow dropping through platform if ladder below
        if (wantsDrop) {
            this.platformVel.y = MOVE_SPEED * 60;
        }
     }

      this.platformPos.y = newY;

      // Prevent falling offscreen (safety net)
      if (this.platformPos.y > interior.rows * tileSize + 100) {
        this.platformPos.y = 0;
        this.platformVel.y = 0;
        console.warn('Player fell offscreen - respawning');
      }

      this.updatePlatformPosition();  // Sync global pos
      return;
    }

    // ----------------------------
    // PLANET SURFACE
    // ----------------------------
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
    if (this.mode != "maze") return;
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
    // ----------------------------
    // DEATH
    // ----------------------------
    if (this.isDying) {
      const elapsed = Date.now() - this.deathStartTime;
      const t = Math.min(elapsed / this.deathDuration, 1);
      this.deathScale = 1 - (t*t*t);
      this.deathRotation += 0.2;
      this.deathAlpha = 1 - t;
      if (t >= 1) state.gameOver = true;
      return;
    }

    // ----------------------------
    // TELEPORT
    // ----------------------------
    if (this.isTeleporting) {
      const elapsed = Date.now() - this.teleportStartTime;
      const t = elapsed / this.teleportDuration;

      if (t >= 1) {
        this.isTeleporting = false;

        if (this.teleportTargetMode === "maze") {
          this.enterMazeMode();
        } else if (this.teleportTargetMode === "platform") {
          this.enterPlatformMode();
        } else {
          this.exitMazeMode(); // Assuming for "space"
        }

        this.teleportTargetMode = null;
        return;
      }

      const pulse = Math.sin(t * Math.PI);
      this.teleportScale = 1 + pulse * 1.2;
      this.teleportGlow = pulse;

      if (Math.random() < 0.6) {
        const beamDir = new Vector2(
          Math.cos(this.currentPlanet?.beamAngle || 0),
          Math.sin(this.currentPlanet?.beamAngle || 0)
        );
        const side = new Vector2(-beamDir.y, beamDir.x).multiply((Math.random()-0.5)*1.5);
        const speed = 2 + Math.random()*2;
        const vel = beamDir.multiply(speed).add(side);
        state.particles.push(new Particle(this.pos.clone(), vel));
      }
      return;
    }

    // ----------------------------
    // MAZE MODE
    // ----------------------------
    if (this.mode=="maze") {
      this.vel = new Vector2(0,0);
      this.mouthAngle = Math.sin(Date.now()*0.01)*(Math.PI/4);
      return;
    }

    // ----------------------------
    // PLANET MOVEMENT
    // ----------------------------
    if (!this.onSurface) {
      this.vel = this.vel.multiply(DRAG);
      this.pos.add(this.vel);

      if (this.pos.x - this.radius < 0) { this.pos.x = this.radius; this.vel.x = -this.vel.x; }
      if (this.pos.x + this.radius > state.sceneWidth) { this.pos.x = state.sceneWidth - this.radius; this.vel.x = -this.vel.x; }
      if (this.pos.y - this.radius < 0) { this.pos.y = this.radius; this.vel.y = -this.vel.y; }
      if (this.pos.y + this.radius > state.sceneHeight) { this.pos.y = state.sceneHeight - this.radius; this.vel.y = -this.vel.y; }
    }

    this.mouthAngle = Math.sin(Date.now() * 0.01) * (Math.PI / 4);
  }

  draw() {
    const ctx = state.ctx;
    let scale = 1;
    let glow = 0;

    if (this.isDying) {
      ctx.save();
      ctx.globalAlpha = this.deathAlpha;
      ctx.translate(this.pos.x, this.pos.y);
      ctx.rotate(this.deathRotation);
      ctx.scale(this.deathScale, this.deathScale);
      ctx.shadowColor = 'orange';
      ctx.shadowBlur = 30 * (this.deathAlpha * 0.5);
      const mouthAngle = 0;
      ctx.beginPath();
      ctx.arc(0,0,this.radius,mouthAngle/2,2*Math.PI-mouthAngle/2);
      ctx.lineTo(0,0);
      ctx.fillStyle = '#ff6600';
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.restore();
      return;
    }

    if (this.isTeleporting) {
      scale = this.teleportScale;
      glow = this.teleportGlow;
    }

  // ----------------------------
   // PLATFORM MODE
   // ----------------------------
   if (this.mode === "platform") {
     const platformScale = 0.4;  // ← ADD: Match maze scale for small size
     ctx.save();
     ctx.translate(this.pos.x, this.pos.y);  // Use global pos
     ctx.scale(platformScale, platformScale);  // ← ADD: Scale down like maze
     if (this.platformVel.x < 0) ctx.scale(-1,1);
     const mouthAngle = Math.sin(Date.now()*0.01)*(Math.PI/4);
     ctx.beginPath();
     ctx.arc(0,0,this.radius,mouthAngle/2,2*Math.PI-mouthAngle/2);
     ctx.lineTo(0,0);
     ctx.fillStyle = 'yellow';
     ctx.fill();
     ctx.restore();
     return;
   }

    // ----------------------------
    // MAZE MODE
    // ----------------------------
    if (this.mode=="maze") {
      const mazeScale = 0.4;
      ctx.save();
      ctx.translate(this.pos.x,this.pos.y);
      if (this.isTeleporting) {
        ctx.shadowColor='yellow';
        ctx.shadowBlur=40*glow;
      }
      const rot = Math.atan2(this.mazeDir.y,this.mazeDir.x);
      ctx.rotate(rot);
      ctx.scale(scale*mazeScale, scale*mazeScale);
      const mouthAngle = Math.sin(Date.now()*0.01)*(Math.PI/4);
      ctx.beginPath();
      ctx.arc(0,0,this.radius,mouthAngle/2,2*Math.PI-mouthAngle/2);
      ctx.lineTo(0,0);
      ctx.fillStyle='yellow';
      ctx.fill();
      ctx.shadowBlur=0;
      ctx.restore();
      return;
    }

    // ----------------------------
    // PLANET MODE
    // ----------------------------
    let planet = this.onSurface ? this.currentPlanet : this.lastInfluencePlanet;
    let downDir = new Vector2(0,1);
    if (planet) downDir = planet.pos.subtract(this.pos).normalize();
    const downAngle = Math.atan2(downDir.y, downDir.x);
    const rotation = downAngle - Math.PI/2;
    ctx.save();
    ctx.translate(this.pos.x,this.pos.y);
    ctx.rotate(rotation);
    if (this.facingDirection < 0) ctx.rotate(Math.PI);
    if (this.isTeleporting) {
      ctx.shadowColor='yellow';
      ctx.shadowBlur=40*glow;
    }
    ctx.scale(scale,scale);
    const mouthAngle = Math.sin(Date.now()*0.01)*(Math.PI/4);
    ctx.beginPath();
    ctx.arc(0,0,this.radius,mouthAngle/2,2*Math.PI-mouthAngle/2);
    ctx.lineTo(0,0);
    ctx.fillStyle='yellow';
    ctx.fill();
    ctx.shadowBlur=0;
    ctx.restore();
  }
}