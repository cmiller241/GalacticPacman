// js/player.js
import { state } from './state.js';
import {
    GRAVITY_STRENGTH,
    GROUND_POUND_GRAV_MULTIPLIER,
    GROUND_POUND_PUSH_STRENGTH,
    JUMP_STRENGTH,
    MOVE_SPEED,
    PLAYER_LINEAR_SPEED,
    PLAYER_RADIUS,
    SURFACE_TOLERANCE,
    DRAG,
    MAZE_TILE_SIZE,
    MAZE_EXIT_ROW,
    MAZE_EXIT_COL_LEFT,
    MAZE_EXIT_COL_RIGHT,
    PLATFORM_TILE,
    platformTiles
} from './constants.js';
import { Vector2 } from './vector2.js';
import {
    playDeath,
    playJump,
    createDeathParticles,
    createParticles,
    isWall,
    startTeleportFromMaze,
    updatePlayerMazePosition,
    enterMazeMode,
    exitMazeMode
} from './utils.js';
import { Particle } from './particle.js';

export class Player {
    constructor(x, y) {
        this.pos = new Vector2(x, y);
        this.vel = new Vector2(0, 0);
        this.radius = PLAYER_RADIUS;
        this.onSurface = false;
        this.onGround = false;
        this.currentPlanet = null;
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
            playDeath();
        }
    }

    findDominantPlanet(planets) {
        let closest = null, minDist = Infinity;
        for (const planet of planets) {
            const dist = this.pos.subtract(planet.pos).length();
            if (dist < planet.influenceRadius && dist < minDist) {
                minDist = dist; closest = planet;
            }
        }
        return closest;
    }

    applyGravity(planets) {
        if (this.onSurface) return;
        let planet = this.findDominantPlanet(planets);
        if (!planet && this.lastInfluencePlanet) planet = this.lastInfluencePlanet;
        if (planet) {
            this.lastInfluencePlanet = planet;
            const direction = planet.pos.subtract(this.pos).normalize();
            let grav = GRAVITY_STRENGTH;
            if (this.isGroundPounding) grav *= GROUND_POUND_GRAV_MULTIPLIER;
            this.vel.add(direction.multiply(grav));
        }
    }

    checkCollision(planets) {
        for (const planet of planets.filter(p => p.isSpikey)) {
            const dist = this.pos.subtract(planet.pos).length();
            if (dist <= planet.radius + this.radius + SURFACE_TOLERANCE) {
                this.startDeath();
                return;
            }
        }

        if (this.onSurface) return;

        for (const planet of planets.filter(p => !p.isSpikey)) {
            const offset = this.pos.subtract(planet.pos);
            const dist = offset.length();
            const surfaceDist = planet.radius + this.radius;
            if (dist <= surfaceDist + SURFACE_TOLERANCE) {
                const normal = offset.normalize();
                this.pos = planet.pos.clone().add(normal.multiply(surfaceDist));
                this.onSurface = true;
                this.currentPlanet = planet;
                this.lastInfluencePlanet = planet;
                const impactVel = this.vel.clone();
                this.vel.x = 0; this.vel.y = 0;
                this.angle = Math.atan2(this.pos.y - planet.pos.y, this.pos.x - planet.pos.x);
                if (this.isGroundPounding) {
                    this.isGroundPounding = false;
                    const pushDir = normal.multiply(-1);
                    planet.vel.add(pushDir.multiply(impactVel.length() * GROUND_POUND_PUSH_STRENGTH));
                    createParticles(this.pos, 20);
                }
                return;
            }
        }

        this.onSurface = false;
        this.currentPlanet = null;
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
                if (dy === -1 && this.mazeRow === MAZE_EXIT_ROW &&
                    (this.mazeCol === MAZE_EXIT_COL_LEFT || this.mazeCol === MAZE_EXIT_COL_RIGHT)) {
                    startTeleportFromMaze();
                    return;
                }
                if (!isWall(newCol, newRow)) {
                    this.mazeCol = newCol;
                    this.mazeRow = newRow;
                    this.mazeDir = new Vector2(dx || this.mazeDir.x, dy || this.mazeDir.y).normalize();
                    this.lastMoveTime = now;
                    updatePlayerMazePosition();
                }
            }
            return;
        }

        // ----------------------------
        // PLATFORM MODE
        // ----------------------------
        if (this.mode === "platform") {
            const tileSize = PLATFORM_TILE;

            if (keys['ArrowLeft']) this.platformVel.x = -MOVE_SPEED * 60;
            else if (keys['ArrowRight']) this.platformVel.x = MOVE_SPEED * 60;
            else this.platformVel.x = 0;

            let tileX = Math.floor(this.platformPos.x / tileSize);
            let tileY = Math.floor(this.platformPos.y / tileSize);

            const onLadder = platformTiles[tileY] && platformTiles[tileY][tileX] === 'H';
            if (onLadder) {
                if (keys['ArrowUp']) this.platformVel.y = -MOVE_SPEED * 60;
                else if (keys['ArrowDown']) this.platformVel.y = MOVE_SPEED * 60;
                else this.platformVel.y = 0;
            } else if (!this.onGround) {
                this.platformVel.y += GRAVITY_STRENGTH;
            }

            this.platformPos.add(this.platformVel);

            tileX = Math.floor(this.platformPos.x / tileSize);
            tileY = Math.floor(this.platformPos.y / tileSize);

            if (platformTiles[tileY] && platformTiles[tileY][tileX] === '#') {
                if (this.platformVel.x > 0) this.platformPos.x = tileX * tileSize - PLAYER_RADIUS;
                if (this.platformVel.x < 0) this.platformPos.x = (tileX + 1) * tileSize + PLAYER_RADIUS;
                this.platformVel.x = 0;
            }

            const belowTile = platformTiles[tileY + 1]?.[tileX];
            this.onGround = belowTile === '#' || onLadder;
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
                this.platformVel.y = -JUMP_STRENGTH;
                this.onGround = false;
                playJump();
            }
            return;
        }

        if (this.onSurface && this.currentPlanet) {
            const direction = this.pos.subtract(this.currentPlanet.pos).normalize();
            this.vel = direction.multiply(JUMP_STRENGTH);
            this.onSurface = false;
            this.currentPlanet = null;
            playJump();
        }
    }

    tryGroundPound() {
        if (this.isGroundPounding) return;
        let planet = this.findDominantPlanet(state.planetoids) || this.lastInfluencePlanet;
        if (planet) {
            const outwardDir = this.pos.subtract(planet.pos).normalize();
            const radialVel = this.vel.dot(outwardDir);
            if (radialVel > 0) this.isGroundPounding = true;
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

                enterMazeMode();

                // if (this.teleportTargetMode === "maze") {
                //     console.log("PacMan is entering Maze Mode()");
                //     enterMazeMode();
                // } else if (this.teleportTargetMode === "platform") {
                //     this.mode = "platform";
                //     this.platformVel = new Vector2(0,0);
                //     const tileX = Math.floor(this.platformPos.x / PLATFORM_TILE);
                //     const tileY = Math.floor(this.platformPos.y / PLATFORM_TILE);
                //     const belowTile = platformTiles[tileY + 1]?.[tileX];
                //     this.onGround = belowTile === '#' || belowTile === 'H';
                // } else {
                //     this.mode = "space";
                // }

                this.teleportTargetMode = null;
                return;
            }

            const pulse = Math.sin(t * Math.PI);
            this.teleportScale = 1 + pulse * 1.2;
            this.teleportGlow = pulse;

            if (Math.random() < 0.6) {
                const beamDir = new Vector2(
                    Math.cos(state.mazePlanet?.beamAngle || 0),
                    Math.sin(state.mazePlanet?.beamAngle || 0)
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
            ctx.save();
            ctx.translate(this.platformPos.x, this.platformPos.y);
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