// js/systems/AISystem.js
export class AISystem {
  updateEnemies(enemies, planetoids) {
    enemies.forEach(e => e.update(planetoids));
  }

  updateInteriorGhosts(interior) {
    if (interior && interior.ghosts) {
      interior.ghosts.forEach(g => g.update());
    }
  }
}