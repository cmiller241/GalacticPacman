// js/systems/BeltOrbitSystem.js

import state from '../state.js';
import worldGen from '../setup/WorldGen.js';

const RESTORE = 0.012;
const TANGENT_KEEP = 0.02;

function apply(planetoids) {
  if (!planetoids) return;

  const [sunX, sunY] = worldGen.sunPos();
  const dt = state.timeScale ?? 1;
  const orbitSpeed = worldGen.BELT_ORBIT_SPEED ?? 2.7;

  for (const p of planetoids) {
    if (p.isBeltPlanetoid && !p.isImmovable && !p.recalling && p.vel && p.pos) {
      const dx = p.pos.x - sunX;
      const dy = p.pos.y - sunY;
      let dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1) dist = 1;

      const nx = dx / dist, ny = dy / dist;
      const tx = -ny, ty = nx;

      const targetR = p.beltOrbitRadius ?? dist;
      const radialErr = targetR - dist;

      p.vel.x += nx * radialErr * RESTORE * dt;
      p.vel.y += ny * radialErr * RESTORE * dt;

      const tangSpeed = p.vel.x * tx + p.vel.y * ty;
      if (tangSpeed < orbitSpeed) {
        const boost = (orbitSpeed - tangSpeed) * TANGENT_KEEP * dt;
        p.vel.x += tx * boost;
        p.vel.y += ty * boost;
      }
    }
  }
}

export default { apply };
