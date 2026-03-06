// js/planetoid.js
import { state } from './state.js';
import { 
    INFLUENCE_PADDING, 
    SURFACE_TOLERANCE, 
    PLANET_SPEED,
    MAZE_COLS,
    MAZE_ROWS,
    MAZE_TILE_SIZE,
    MAZE_EXIT_COL_LEFT,
    MAZE_EXIT_COL_RIGHT,
    MAZE_EXIT_ROW
} from './constants.js';
import { Vector2 } from './vector2.js';

export class Planetoid {
    constructor(x, y, radius, color) {
        this.pos = new Vector2(x, y);
        this.radius = radius;
        this.mass = radius * radius;
        this.influenceRadius = radius + INFLUENCE_PADDING;
        this.color = color;
        let direction = new Vector2(Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
        this.vel = direction.multiply(PLANET_SPEED);
        this.cachedAlpha = 0.3;
        this.lastAlphaUpdate = 0;
        this.isSpikey = false;
        this.offscreen = null;
    }

    createOffscreen() {
        this.offscreen = document.createElement('canvas');
        this.offscreen.width = this.radius * 2;
        this.offscreen.height = this.radius * 2;
        const offCtx = this.offscreen.getContext('2d');

        offCtx.save();
        offCtx.beginPath();
        offCtx.arc(this.radius, this.radius, this.radius, 0, Math.PI * 2);
        offCtx.clip();
        const tiles = 2.5;
        const texSize = this.radius * 2 * tiles;
        const texOffset = this.radius * tiles;
        offCtx.drawImage(state.planetTexture, this.radius - texOffset, this.radius - texOffset, texSize, texSize);
        offCtx.restore();

        offCtx.save();
        offCtx.globalCompositeOperation = 'multiply';
        offCtx.beginPath();
        offCtx.arc(this.radius, this.radius, this.radius, 0, Math.PI * 2);
        offCtx.fillStyle = this.color;
        offCtx.fill();
        offCtx.globalCompositeOperation = 'source-over';
        offCtx.restore();

        offCtx.save();
        offCtx.globalCompositeOperation = 'multiply';
        const offsetX = -this.radius * 0.5;
        const offsetY = -this.radius * 0.5;
        const lightGradient = offCtx.createRadialGradient(
            this.radius + offsetX, this.radius + offsetY, 0,
            this.radius + offsetX, this.radius + offsetY, this.radius * 1.5
        );
        lightGradient.addColorStop(0, 'white');
        lightGradient.addColorStop(1, 'black');
        offCtx.beginPath();
        offCtx.arc(this.radius, this.radius, this.radius, 0, Math.PI * 2);
        offCtx.fillStyle = lightGradient;
        offCtx.fill();
        offCtx.globalCompositeOperation = 'source-over';
        offCtx.restore();
    }

    draw() {
        const ctx = state.ctx;

        const now = Date.now();
        if (now - this.lastAlphaUpdate > 500) {
            const dist = this.pos.subtract(state.player.pos).length();
            this.cachedAlpha = Math.max(0.01, 0.3 - (dist / 1000) * 0.65);
            this.lastAlphaUpdate = now;
        }

        // Batch stroke-related settings for influence radius
        ctx.save();
        ctx.strokeStyle = `rgba(173,216,230,${this.cachedAlpha})`;
        ctx.lineWidth = 3;
        ctx.setLineDash([10, 5]);
        ctx.beginPath();
        ctx.arc(this.pos.x, this.pos.y, this.influenceRadius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        // Batch shadow settings for planet body (applied once before draw, reset after)
        ctx.save();
        ctx.shadowColor = 'rgba(173,216,230,0.3)';
        ctx.shadowBlur = 25;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;

        if (this.offscreen) {
            ctx.drawImage(this.offscreen, this.pos.x - this.radius, this.pos.y - this.radius);
        } else {
            // Fallback: Create gradient only if needed (rare after init)
            const offsetX = -this.radius * 0.5;
            const offsetY = -this.radius * 0.5;
            const gradient = ctx.createRadialGradient(
                this.pos.x + offsetX, this.pos.y + offsetY, 0,
                this.pos.x + offsetX, this.pos.y + offsetY, this.radius * 1.5
            );
            gradient.addColorStop(0, this.color);
            gradient.addColorStop(1, 'black');
            ctx.beginPath();
            ctx.arc(this.pos.x, this.pos.y, this.radius, 0, Math.PI * 2);
            ctx.fillStyle = gradient;
            ctx.fill();
        }

        ctx.restore(); // Reset shadow after draw
    }
}

export class SpikeyPlanetoid extends Planetoid {
    constructor(x, y, radius) {
        super(x, y, radius, 'gray');
        this.isSpikey = true;
        this.spikeHeight = 8;
        this.spikeSpacing = 6;
        this.padding = this.spikeHeight;

        this.spikeRotation = 0;
        this.spikeRotationSpeed = 0.02;
    }

    createOffscreen() {
        const padding = this.padding;
        this.offscreen = document.createElement('canvas');
        this.offscreen.width = 2 * (this.radius + padding);
        this.offscreen.height = 2 * (this.radius + padding);

        const offCtx = this.offscreen.getContext('2d');
        const cx = this.radius + padding;
        const cy = this.radius + padding;

        // Planet body
        offCtx.beginPath();
        offCtx.arc(cx, cy, this.radius, 0, Math.PI * 2);
        offCtx.fillStyle = this.color;
        offCtx.fill();

        // Lighting gradient
        offCtx.save();
        offCtx.globalCompositeOperation = 'multiply';

        const offsetX = -this.radius * 0.5;
        const offsetY = -this.radius * 0.5;

        const lightGradient = offCtx.createRadialGradient(
            cx + offsetX, cy + offsetY, 0,
            cx + offsetX, cy + offsetY, this.radius * 1.5
        );

        lightGradient.addColorStop(0, 'white');
        lightGradient.addColorStop(1, 'black');

        offCtx.beginPath();
        offCtx.arc(cx, cy, this.radius, 0, Math.PI * 2);
        offCtx.fillStyle = lightGradient;
        offCtx.fill();

        offCtx.globalCompositeOperation = 'source-over';
        offCtx.restore();
    }

    drawSpikes(ctx) {
        const numSpikes = Math.floor(2 * Math.PI * this.radius / this.spikeSpacing);
        const angleStep = 2 * Math.PI / numSpikes;
        const halfBaseAngle = angleStep / 2;

        for (let i = 0; i < numSpikes; i++) {
            const angle = i * angleStep;

            const leftAngle = angle - halfBaseAngle;
            const rightAngle = angle + halfBaseAngle;

            const baseLeftX = Math.cos(leftAngle) * this.radius;
            const baseLeftY = Math.sin(leftAngle) * this.radius;

            const baseRightX = Math.cos(rightAngle) * this.radius;
            const baseRightY = Math.sin(rightAngle) * this.radius;

            const tipX = Math.cos(angle) * (this.radius + this.spikeHeight);
            const tipY = Math.sin(angle) * (this.radius + this.spikeHeight);

            ctx.beginPath();
            ctx.moveTo(baseLeftX, baseLeftY);
            ctx.lineTo(tipX, tipY);
            ctx.lineTo(baseRightX, baseRightY);
            ctx.closePath();
            ctx.fillStyle = 'darkgray';
            ctx.fill();
        }
    }

    draw() {
        const ctx = state.ctx;

        const now = Date.now();
        if (now - this.lastAlphaUpdate > 500) {
            const dist = this.pos.subtract(state.player.pos).length();
            this.cachedAlpha = Math.max(0.01, 0.3 - (dist / 1000) * 0.65);
            this.lastAlphaUpdate = now;
        }

        // Influence radius
        ctx.save();
        ctx.strokeStyle = `rgba(173,216,230,${this.cachedAlpha})`;
        ctx.lineWidth = 3;
        ctx.setLineDash([10, 5]);
        ctx.beginPath();
        ctx.arc(this.pos.x, this.pos.y, this.influenceRadius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        // Planet body
        ctx.save();
        ctx.shadowColor = 'rgba(173,216,230,0.3)';
        ctx.shadowBlur = 25;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;

        if (this.offscreen) {
            ctx.drawImage(
                this.offscreen,
                this.pos.x - (this.radius + this.padding),
                this.pos.y - (this.radius + this.padding)
            );
        } else {
            ctx.beginPath();
            ctx.arc(this.pos.x, this.pos.y, this.radius, 0, Math.PI * 2);
            ctx.fillStyle = this.color;
            ctx.fill();
        }

        ctx.restore();

        // Rotate spikes
        this.spikeRotation += this.spikeRotationSpeed;

        ctx.save();
        ctx.translate(this.pos.x, this.pos.y);
        ctx.rotate(this.spikeRotation);

        this.drawSpikes(ctx);

        ctx.restore();
    }
}

export class MazePlanetoid extends Planetoid {
    constructor(x, y, radius) {
        super(x, y, radius, '#8A2BE2');
        this.beamAngle = -Math.PI / 2;
        this.beamLength = 140;
        this.beamWidth = 14;
        this.beamParticles = [];
        this.portalParticles = [];
        this.mazeOffscreen = null; // New: Offscreen for static maze walls
        this.createMazeOffscreen();
    }

    createMazeOffscreen() {
        // Pre-render static maze walls to an offscreen canvas
        const mazeWidth = MAZE_COLS * MAZE_TILE_SIZE;
        const mazeHeight = MAZE_ROWS * MAZE_TILE_SIZE;
        this.mazeOffscreen = document.createElement('canvas');
        this.mazeOffscreen.width = mazeWidth;
        this.mazeOffscreen.height = mazeHeight;
        const offCtx = this.mazeOffscreen.getContext('2d');

        offCtx.fillStyle = '#cc00cc';
        offCtx.strokeStyle = '#330033';
        offCtx.lineWidth = 4;

        for (let row = 0; row < MAZE_ROWS; row++) {
            for (let col = 0; col < MAZE_COLS; col++) {
                if (state.mazeWalls[row][col]) {
                    offCtx.fillRect(col * MAZE_TILE_SIZE, row * MAZE_TILE_SIZE, MAZE_TILE_SIZE, MAZE_TILE_SIZE);
                }
            }
        }
    }

    draw() {
        const ctx = state.ctx;

        super.draw();

        // === DRAW CLASSIC PAC-MAN MAZE OVERLAY ===
        const offsetX = this.pos.x - (MAZE_COLS * MAZE_TILE_SIZE / 2);
        const offsetY = this.pos.y - (MAZE_ROWS * MAZE_TILE_SIZE / 2);

        ctx.save();
        ctx.globalAlpha = 0.5;

        // Draw pre-rendered maze walls
        if (this.mazeOffscreen) {
            ctx.drawImage(this.mazeOffscreen, offsetX, offsetY);
        }

        ctx.globalAlpha = 1.0;

        // Dots (dynamic, redraw each frame)
        ctx.fillStyle = '#FFFFFF';
        for (let dot of state.mazeDots) {
            const x = offsetX + dot.x * MAZE_TILE_SIZE + MAZE_TILE_SIZE / 2;
            const y = offsetY + dot.y * MAZE_TILE_SIZE + MAZE_TILE_SIZE / 2;
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fill();
        }

        // Power pellets (dynamic, redraw each frame)
        ctx.fillStyle = '#FFFF00';
        for (let pp of state.powerPellets) {
            const x = offsetX + pp.x * MAZE_TILE_SIZE + MAZE_TILE_SIZE / 2;
            const y = offsetY + pp.y * MAZE_TILE_SIZE + MAZE_TILE_SIZE / 2;
            ctx.beginPath();
            ctx.arc(x, y, 8, 0, Math.PI * 2);
            ctx.fill();
        }

        // Exit Portal
        const portalX = offsetX + (MAZE_EXIT_COL_LEFT + 0.5) * MAZE_TILE_SIZE + MAZE_TILE_SIZE / 2;
        const portalY = offsetY + MAZE_EXIT_ROW * MAZE_TILE_SIZE + MAZE_TILE_SIZE / 2;
        const pulse = (Math.sin(Date.now() * 0.006) + 1) / 2;

        ctx.save(); // Batch portal styles
        ctx.beginPath();
        ctx.arc(portalX, portalY, 10 + pulse * 4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 0, 255, ${0.7 + pulse * 0.3})`;
        ctx.fill();
        ctx.strokeStyle = '#ffaaff';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.restore();

        state.mazeGhosts.forEach(g => g.draw());
        ctx.restore();

        // Beam & Particles logic (unchanged)
        if (Math.random() < 0.5) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 1 + Math.random() * 2;
            const vel = new Vector2(Math.cos(angle) * speed, Math.sin(angle) * speed);
            const spawnPos = new Vector2(portalX, portalY);
            this.portalParticles.push(new PortalParticle(spawnPos, vel, 40));
        }

        const beamStartX = this.pos.x + Math.cos(this.beamAngle) * this.radius;
        const beamStartY = this.pos.y + Math.sin(this.beamAngle) * this.radius;
        const beamEndX = beamStartX + Math.cos(this.beamAngle) * this.beamLength;
        const beamEndY = beamStartY + Math.sin(this.beamAngle) * this.beamLength;

        if (Math.random() < 0.6) {
            const beamDir = new Vector2(Math.cos(this.beamAngle), Math.sin(this.beamAngle));
            const side = new Vector2(-beamDir.y, beamDir.x).multiply((Math.random() - 0.5) * 1.5);
            const speed = 2 + Math.random() * 2;
            const vel = beamDir.multiply(speed).add(side);
            const spawnPos = new Vector2(beamStartX, beamStartY);
            this.beamParticles.push(new BeamParticle(spawnPos, vel, 50));
        }

        // Batch beam gradient and shadow for all beam lines
        const gradient = ctx.createLinearGradient(beamStartX, beamStartY, beamEndX, beamEndY);
        gradient.addColorStop(0, 'rgba(255, 0, 255, 1)');
        gradient.addColorStop(1, 'rgba(255, 0, 255, 0)');

        ctx.save();
        ctx.shadowColor = '#FF00FF';
        ctx.shadowBlur = 60;
        ctx.strokeStyle = gradient;
        ctx.lineWidth = this.beamWidth;
        ctx.beginPath();
        ctx.moveTo(beamStartX, beamStartY);
        ctx.lineTo(beamEndX, beamEndY);
        ctx.stroke();

        ctx.shadowBlur = 20;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(beamStartX - 8, beamStartY);
        ctx.lineTo(beamEndX - 8, beamEndY);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(beamStartX + 8, beamStartY);
        ctx.lineTo(beamEndX + 8, beamEndY);
        ctx.stroke();
        ctx.restore();

        // Update & Draw Beam Particles
        for (let i = this.beamParticles.length - 1; i >= 0; i--) {
            const p = this.beamParticles[i];
            p.update();
            p.draw();
            if (p.life <= 0) this.beamParticles.splice(i, 1);
        }

        // Update & Draw Portal Particles
        for (let i = this.portalParticles.length - 1; i >= 0; i--) {
            const p = this.portalParticles[i];
            p.update();
            p.draw();
            if (p.life <= 0) this.portalParticles.splice(i, 1);
        }
    }
}

export class BeamParticle {
    constructor(pos, vel, life = 40) {
        this.pos = pos.clone();
        this.vel = vel;
        this.life = life;
        this.maxLife = life;
    }
    update() { this.pos.add(this.vel); this.life--; }
    draw() {
        const ctx = state.ctx;
        if (this.life <= 0) return;
        const alpha = this.life / this.maxLife;
        ctx.beginPath();
        ctx.arc(this.pos.x, this.pos.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 0, 255, ${alpha})`;
        ctx.fill();
    }
}

export class PortalParticle {
    constructor(pos, vel, life = 35) {
        this.pos = pos.clone();
        this.vel = vel;
        this.life = life;
        this.maxLife = life;
    }
    update() { this.pos.add(this.vel); this.life--; }
    draw() {
        const ctx = state.ctx;
        if (this.life <= 0) return;
        const alpha = this.life / this.maxLife;
        const size = 3 * alpha;
        ctx.beginPath();
        ctx.arc(this.pos.x, this.pos.y, size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 0, 255, ${alpha})`;
        ctx.fill();
    }
}