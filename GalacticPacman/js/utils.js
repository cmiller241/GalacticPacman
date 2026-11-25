// js/utils.js
import { state } from './state.js';
import { PLAYER_RADIUS } from './constants.js';
import { Vector2 } from './vector2.js';
import { Particle } from './entities/Particle.js';


export function createParticles(atPos, count) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = Math.random() * 4 + 2;
    const vel = new Vector2(Math.cos(angle) * speed, Math.sin(angle) * speed);
    state.particles.push(new Particle(atPos, vel));
  }
}

export function createDeathParticles(atPos, count = 30) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = Math.random() * 6 + 3;
    const vel = new Vector2(Math.cos(angle) * speed, Math.sin(angle) * speed);
    const particle = new Particle(atPos, vel);
    particle.color = `hsl(${Math.random() * 50 + 75}, 100%, ${Math.random() * 25 + 45}%)`; // Lime and yellow-green, like the blob
    state.particles.push(particle);
  }
}


