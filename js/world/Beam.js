// js/world/Beam.js
//
// A planted teleporter: a glowing particle beam shooting out from a
// fixed anchor point, interactable the same way Lever.js/RobotButler.js/
// Fisherman.js are (Enter / gamepad Circle, while standing close enough
// — see tryInteract/isPlayerNear) — pressing it sends the player to
// another Beam (see getPortalPosition), paired up as a simple two-way
// link by whichever code spawns them (see main.js's home<->belt pair).
//
// A steady, ambient particle stream drifts from the base toward the tip;
// the teleport moment itself gets its feedback from
// Player.getTeleportPulse's scale/glow blip instead.
//
// The beam's own glow fades smoothly from the planted base to nothing
// at the tip, drawn as many short segments of linearly decreasing alpha
// (see drawFadingLine below).

import love from '../love/index.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import InteractPrompt from '../ui/InteractPrompt.js';

// How many short slivers drawFadingLine splits the beam's length into —
// fine enough that the alpha step between adjacent slivers reads as a
// smooth gradient.
const GRADIENT_SEGMENTS = 24;

const TOOLTIP_GAP_ABOVE = 26;

// Draws a straight line from (x1,y1) to (x2,y2) as GRADIENT_SEGMENTS
// short slivers, alpha stepping from baseAlpha (at x1,y1) down to
// (almost) 0 at (x2,y2).
function drawFadingLine(x1, y1, x2, y2, width, r, g, b, baseAlpha) {
  love.graphics.setLineWidth(width);
  for (let i = 1; i <= GRADIENT_SEGMENTS; i++) {
    const t0 = (i - 1) / GRADIENT_SEGMENTS;
    const t1 = i / GRADIENT_SEGMENTS;
    // Alpha at the SEGMENT'S OWN midpoint.
    const midT = (t0 + t1) / 2;
    love.graphics.setColor(r, g, b, baseAlpha * (1 - midT));
    love.graphics.line(
      x1 + (x2 - x1) * t0, y1 + (y2 - y1) * t0,
      x1 + (x2 - x1) * t1, y1 + (y2 - y1) * t1);
  }
}

class Beam {
  // x, y: the beam's own planted/anchor point (already resting on a
  // surface). angle: which way it shoots (0 = +x/right, increasing
  // clockwise) — away from whatever surface it's planted on. color:
  // [r,g,b] 0-1, used for both the beam's own glow and its particle
  // streams; defaults to Beam.DEFAULT_COLOR.
  static new(x, y, angle, color) {
    return new Beam(x, y, angle, color);
  }

  constructor(x, y, angle, color) {
    this.pos = new Vector2(x, y);
    this.angle = angle ?? -Math.PI / 2;
    this.color = color ?? Beam.DEFAULT_COLOR;

    // Which OTHER Beam this one sends the player to — null until
    // whatever spawns a pair of these wires them together (see main.js).
    this.destination = null;

    this.beamParticles = [];

    this.interactRadius = 120;
    this.playerNearby = false;
  }

  // The far tip of the beam (not the planted base).
  getPortalPosition() {
    return new Vector2(
      this.pos.x + Math.cos(this.angle) * Beam.LENGTH,
      this.pos.y + Math.sin(this.angle) * Beam.LENGTH);
  }

  isPlayerNear(player) {
    if (!player) return false;
    const dx = player.pos.x - this.pos.x, dy = player.pos.y - this.pos.y;
    return (dx * dx + dy * dy) <= this.interactRadius * this.interactRadius;
  }

  // Called from InputHandlers.js (Enter) and GamePadInput.js (Circle).
  tryInteract(player) {
    if (!this.destination) return;
    if (!this.isPlayerNear(player)) return;
    if (player.isTeleporting) return;
    player.startTeleport(this, this.destination);
  }

  update() {
    const ts = state.timeScale ?? 1;
    this.playerNearby = this.isPlayerNear(state.player);

    // Ambient beam particles: small motes spawned at the planted base,
    // drifting toward the tip with a little sideways scatter, fading out
    // as their own life runs down.
    if (Math.random() < 0.6) {
      const dirX = Math.cos(this.angle), dirY = Math.sin(this.angle);
      const sideX = -dirY, sideY = dirX;
      const sideAmt = (Math.random() - 0.5) * 1.5;
      const speed = 2 + Math.random() * 2;
      this.beamParticles.push({
        pos: new Vector2(this.pos.x, this.pos.y),
        vel: new Vector2(dirX * speed + sideX * sideAmt, dirY * speed + sideY * sideAmt),
        life: 50,
        maxLife: 50,
      });
    }

    for (let i = this.beamParticles.length - 1; i >= 0; i--) {
      const p = this.beamParticles[i];
      p.pos.addScaled(p.vel, ts);
      p.life -= ts;
      if (p.life <= 0) this.beamParticles.splice(i, 1);
    }
  }

  // A few progressively wider, dimmer additive passes under a bright
  // core stroke, each faded base-to-tip.
  draw() {
    const dirX = Math.cos(this.angle), dirY = Math.sin(this.angle);
    const startX = this.pos.x, startY = this.pos.y;
    const endX = startX + dirX * Beam.LENGTH, endY = startY + dirY * Beam.LENGTH;
    const [r, g, b] = this.color;

    love.graphics.setBlendMode('add');
    for (let i = 3; i >= 1; i--) {
      drawFadingLine(startX, startY, endX, endY, Beam.WIDTH + i * 10, r, g, b, 0.10 * i);
    }
    drawFadingLine(startX, startY, endX, endY, Beam.WIDTH, r, g, b, 0.9);
    drawFadingLine(startX, startY, endX, endY, 4, 1, 1, 1, 0.8);

    for (const p of this.beamParticles) {
      const alpha = p.life / p.maxLife;
      love.graphics.setColor(1, 1, 1, alpha);
      love.graphics.circle('fill', p.pos.x, p.pos.y, Beam.PARTICLE_RADIUS);
    }

    love.graphics.setBlendMode('alpha');
    love.graphics.setLineWidth(1);
    love.graphics.setColor(1, 1, 1, 1);
  }

  // World-space "you can interact with this" hint. Not shown while
  // curled into a ball, mid-teleport, or with no destination wired up.
  drawTooltip() {
    if (!this.playerNearby) return;
    if (!this.destination) return;
    if (state.player && (state.player.isBall || state.player.isTeleporting)) return;

    // Anchored above whichever of the planted base / portal tip sits
    // higher on screen.
    const portal = this.getPortalPosition();
    const topX = (portal.y < this.pos.y) ? portal.x : this.pos.x;
    const topY = Math.min(this.pos.y, portal.y);
    InteractPrompt.draw(topX, topY - TOOLTIP_GAP_ABOVE);
  }
}

Beam.LENGTH = 140;
Beam.WIDTH = 14;
Beam.PARTICLE_RADIUS = 3;
Beam.DEFAULT_COLOR = [0.65, 0.25, 1.0]; // violet

export default Beam;
