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
        this.color = '#8B4513'; // Dark (but not too dark) brown
        this.points = this.generatePoints();
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
        this.vel = this.vel.multiply(DRAG); // Add drag to prevent excessive speedup
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
        ctx.beginPath();
        ctx.moveTo(this.points[0].x, this.points[0].y);
        for (let i = 1; i < this.points.length; i++) {
            ctx.lineTo(this.points[i].x, this.points[i].y);
        }
        ctx.closePath();
        ctx.fillStyle = this.color;
        ctx.fill();
        ctx.strokeStyle = 'black'; // Outline
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
    }
}