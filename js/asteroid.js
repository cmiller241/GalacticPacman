// js/asteroid.js
import { state } from './state.js';
import { DRAG, PLANET_SPEED } from './constants.js';
import { Vector2 } from './vector2.js';

export class Asteroid {
    constructor(x, y, radius) {
        this.pos = new Vector2(x, y);
        this.radius = radius;
        this.mass = radius * radius;
        let direction = new Vector2(Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
        this.vel = direction.multiply(PLANET_SPEED);
        this.angularSpeed = (Math.random() * 2 - 1) * 0.05;
        this.angle = Math.random() * Math.PI * 2;
        this.color = '#8B4513'; // Dark brown
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
        this.vel = this.vel.multiply(DRAG);
        this.pos.add(this.vel);
        this.angle += this.angularSpeed;

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
}