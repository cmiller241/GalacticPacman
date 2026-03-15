// js/utils.js
import { state } from './state.js';
import { STAR_COUNT, PLAYER_RADIUS } from './constants.js';
import { Vector2 } from './vector2.js';
import { Particle } from './entities/Particle.js';

export function checkMazeDots() {
  if (state.player.mode != "maze") return;
  const interior = state.player.currentInterior;
  for (let i = interior.dots.length - 1; i >= 0; i--) {
    const d = interior.dots[i];
    if (d.x === state.player.mazeCol && d.y === state.player.mazeRow) {
      state.audioManager.playEatDot();
      interior.dots.splice(i, 1);
      state.score += 10;
    }
  }
  for (let i = interior.powerPellets.length - 1; i >= 0; i--) {
    const p = interior.powerPellets[i];
    if (p.x === state.player.mazeCol && p.y === state.player.mazeRow) {
      state.audioManager.playEatDot();
      interior.powerPellets.splice(i, 1);
      state.score += 50;
    }
  }
}

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
    particle.color = `hsl(${Math.random() * 60 + 20}, 100%, 50%)`; // Fiery oranges/yellows
    state.particles.push(particle);
  }
}

// Resize listener
export function initResizeListener() {
  window.addEventListener('resize', () => {
    state.canvas.width = window.innerWidth;
    state.canvas.height = window.innerHeight;
    state.sceneWidth = state.canvas.width * 2;
    state.sceneHeight = state.canvas.height * 2;
    state.stars.length = 0;
    for (let i = 0; i < STAR_COUNT; i++) {
      state.stars.push({
        x: Math.random() * state.sceneWidth,
        y: Math.random() * state.sceneHeight,
        size: Math.random() * 2 + 1
      });
    }
  });
}

export function angleDiff(a, b) {
  let diff = (a - b + Math.PI) % (2 * Math.PI);
  if (diff < 0) diff += 2 * Math.PI; // ensure positive
  return Math.abs(diff - Math.PI);   // now in [0, PI]
}