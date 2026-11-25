// js/systems/AISystem.js
export class AISystem {
  updateEnemies(enemies, planetoids) {
    enemies.forEach(e => e.update(planetoids));
  }
}