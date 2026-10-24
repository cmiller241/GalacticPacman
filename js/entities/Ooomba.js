// js/entities/Ooomba.js
//
// A simple ground-patrol enemy: walks back and forth along a TiledTerrain
// TerrainShape's own arc-length path, turning around at either end
// instead of falling off. Uses the Ooomba sprite sheet (img/Ooomba.png:
// 3 frames of 800x950 — standing, walk-forward-A, walk-forward-B),
// cycled standing/walk-A/standing/walk-B.
//
// Walking along arc length rather than a flat X range is what gets slope
// climbing for free: TerrainShape.worldPointAtArcPosition already handles
// both flat and 45-degree segments (and pushes the sprite straight up
// from the surface, same upright convention the player itself uses),
// and TerrainShape.getArcSpeedMultiplier already slows walking on slopes.
//
// A hazard: touching one kills the player, unless he lands on it from
// above, which squashes it flat instead (see startSquash/updateSquash
// and CollisionSystem.handlePlayerOoombaCollisions). A fireball kills it
// outright (see main.js's own fireball pass).

import love from '../love/index.js';
import lua from '../love/lua.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import DustPuff from '../effects/DustPuff.js';
import PortalGun from '../systems/PortalGun.js';

// The walk order (standing, walk-A, standing, walk-B) as sheet frame
// indices. Loops — not a true ping-pong reverse.
const FRAME_SEQUENCE = [0, 1, 0, 2];

// Purely a visual nudge (the sprite's feet sit slightly above this.pos
// otherwise) — doesn't touch this.pos itself.
const DRAW_Y_OFFSET = 3;

// Circle used for player/fireball contact — a bit under halfWidth, so
// hits need real overlap with the body, not the sprite's empty corners.
const HIT_RADIUS = 36;

// Stomp tuning (see updateSquash). All in world units / baseline
// (60fps) ticks.
const SQUASH_FALL_SPEED = 4.5;  // the player's own fall is capped to this while he's pressing one flat, so the squash is slow enough to actually see
const SQUASH_SOLO_SPEED = 9;    // how fast it finishes collapsing by itself if he's no longer pressing down on it
const SQUASH_DONE_HEIGHT = 6;   // squashed "to nothing" once it's this thin
const SQUASH_MAX_BULGE = 0.4;   // extra width (fraction) it spreads out to as it flattens

// Baked once, shared by every Ooomba instance.
let frameQuads = null;
let sheetFrameW = null, sheetFrameH = null;

function ensureFrameQuads(img) {
  if (frameQuads) return;
  const [fullW, fullH] = img.getDimensions();
  sheetFrameW = fullW / 3;
  sheetFrameH = fullH;
  frameQuads = [];
  for (let i = 0; i <= 2; i++) {
    frameQuads[i] = love.graphics.newQuad(i * sheetFrameW, 0, sheetFrameW, sheetFrameH, fullW, fullH);
  }
}

// Flying, after coming out of a portal: gravity pulls it the same way it
// pulls Bob in the air, it turns upright as it falls, and it lands on
// (and starts patrolling) whatever floor it comes down on. Walls and
// ceilings just stop it. One that never lands (flung off into space) is
// given up on after a while (this.lost — main.js removes it).
const AIRBORNE_GIVE_UP_TICKS = 60 * 20;
const AIR_UPRIGHT_RATE = 0.12; // fraction of the way back to upright it turns each frame
const LANDING_SLACK = 2;

// Which way is "up" where it is: away from whatever gravity has hold of it.
function upAgainstGravity(o) {
  const planet = o.lastInfluencePlanet;
  if (!planet) return new Vector2(0, -1);
  if (planet.isRoundedRect) {
    if (planet.forceUprightJump || planet.isSkyDome) return new Vector2(0, -1);
    return planet.nearestSurfacePoint(o.pos.x, o.pos.y).normal.clone();
  }
  return o.pos.subtract(planet.pos).normalize();
}

class Ooomba {
  static new(homeShape, startArcPos, options) {
    return new Ooomba(homeShape, startArcPos, options);
  }

  constructor(homeShape, startArcPos, options = {}) {
    this.homeShape = homeShape;

    // Draw size in world units — NOT a true radius (the source art is
    // 800x950, not square); halfWidth insets the turn-around bounds near
    // either end of the shape's own path, halfHeight is the push-out
    // distance worldPointAtArcPosition uses to place the sprite's feet on
    // the surface.
    this.drawHeight = options.drawHeight ?? 90;
    this.drawWidth = options.drawWidth ?? (this.drawHeight * 800 / 950);
    this.halfWidth = this.drawWidth / 2;
    this.halfHeight = this.drawHeight / 2;
    // Not named plain `radius`: utils.boundingRadius (target-lock outline,
    // on-screen checks) prefers that field over halfWidth/halfHeight, and
    // this is a contact circle, not the sprite's bounds. Scaled with the
    // sprite.
    this.hitRadius = HIT_RADIUS * (this.drawHeight / 90);

    // Which way is "up" for it right now — straight up the screen on
    // Tiled terrain, straight out from the center on a round planetoid.
    this.up = new Vector2(0, -1);

    // See startSquash/updateSquash. squashHeight is how tall the sprite
    // is currently drawn — drawHeight normally, shrinking toward 0 while
    // being stomped. squashPressed is whether the player was still
    // pressing it down on the most recent updateSquash.
    this.isSquashing = false;
    this.squashHeight = this.drawHeight;
    this.squashPressed = false;

    this.speed = options.speed ?? 1.4;         // arc-length units per frame — deliberately a bit slower than the player's own walk speed
    this.direction = options.direction ?? -1;  // -1 = toward arc position 0, 1 = toward the far end; the art faces left by default, so -1 needs no flip

    // Only really used once it's gone through a portal and is flying (see
    // updateAirborne); while walking it's just this frame's step.
    this.vel = new Vector2(0, 0);

    this.surfaceArcPos = startArcPos ?? 0;
    const startSurface = homeShape.worldPointAtArcPosition(this.surfaceArcPos, this.halfHeight);
    this.pos = startSurface.point;
    if (!homeShape.forceUprightJump) this.up = startSurface.normal.clone();

    this.walkCyclePhase = 0;
    this.walkCycleSpeed = 0.12; // how fast the 4-step stand/walk cycle advances

    // Footstep-dust timing — same distance-driven "just planted"
    // detection Player.js's own spawnWalkDust uses: walkTime advances by
    // actual arc-length distance covered this frame, and a footfall is
    // the moment sin(walkTime)^2 crosses back above 0.85.
    this.walkTime = 0;
    this.lastWalkBobT = 0;
    this.strideLength = 90;
  }

  // An Ooomba that patrols a round planetoid, walking laps of it instead
  // of back and forth along a strip of terrain. The planetoid is
  // presented to it as the same kind of arc-length path a TerrainShape
  // is (getPerimeter/worldPointAtArcPosition), one that loops (isLoop).
  //
  // planet: any round planetoid (needs pos + radius). startAngle: where on
  // it to start, radians, same convention as Player.angle.
  static newOnPlanet(planet, startAngle, options) {
    const o = new Ooomba(Ooomba.planetPath(planet), lua.mod(startAngle ?? 0, 2 * Math.PI) * planet.radius, options ?? {});
    o.planet = planet;
    return o;
  }

  // A round planet's circumference as a walkable loop, in the same shape
  // as a TerrainShape path.
  static planetPath(planet) {
    return {
      planet,
      isLoop: true,
      getPerimeter() {
        return 2 * Math.PI * planet.radius;
      },
      worldPointAtArcPosition(arcPos, offset) {
        const angle = arcPos / planet.radius;
        const normal = new Vector2(Math.cos(angle), Math.sin(angle));
        return {
          point: new Vector2(planet.pos.x + normal.x * (planet.radius + offset), planet.pos.y + normal.y * (planet.radius + offset)),
          normal,
        };
      },
    };
  }

  // Velocity of whatever it's standing on — a belt planetoid is moving
  // the whole time; terrain isn't. Returns [vx, vy].
  groundVelocity() {
    const planet = this.planet;
    if (planet && planet.vel) return [planet.vel.x, planet.vel.y];
    return [0, 0];
  }

  // Whether touching it right now counts as landing on it from above:
  // airborne, moving down toward the ground it stands on, with his feet
  // no lower than its middle. "Down" and "above" are along this.up.
  isStompedBy(player) {
    if (player.onSurface) return false;
    const up = this.up;
    const [groundVelX, groundVelY] = this.groundVelocity();
    const sinking = -((player.vel.x - groundVelX) * up.x + (player.vel.y - groundVelY) * up.y);
    const feetAboveCenter = (player.pos.x - this.pos.x) * up.x + (player.pos.y - this.pos.y) * up.y - player.radius;
    return sinking > 0 && feetAboveCenter >= 0;
  }

  startSquash() {
    this.isSquashing = true;
  }

  // Called every frame while isSquashing. The sprite's own top edge is
  // pinned to the player's feet for as long as he's still above it, so
  // it flattens exactly in step with him sinking down onto it — and his
  // fall is slowed to SQUASH_FALL_SPEED so that takes long enough to
  // see. If he's no longer pressing down, it finishes collapsing on its
  // own. Returns true once it's flat.
  updateSquash(player) {
    const timeScale = state.timeScale ?? 1;
    const up = this.up;
    const relX = player.pos.x - this.pos.x, relY = player.pos.y - this.pos.y;
    const feetHeight = relX * up.x + relY * up.y + this.halfHeight - player.radius;
    const sideways = relX * -up.y + relY * up.x;
    const [groundVelX, groundVelY] = this.groundVelocity();
    const sinking = -((player.vel.x - groundVelX) * up.x + (player.vel.y - groundVelY) * up.y);

    const above = !player.isDying && Math.abs(sideways) <= this.halfWidth + player.radius;
    const descending = above && !player.onSurface && sinking > 0;

    if (above) {
      this.squashHeight = Math.max(0, Math.min(this.squashHeight, feetHeight));
    }
    if (descending) {
      if (sinking > SQUASH_FALL_SPEED) {
        const excess = sinking - SQUASH_FALL_SPEED;
        player.vel.x += up.x * excess;
        player.vel.y += up.y * excess;
      }
    } else {
      this.squashHeight = Math.max(0, this.squashHeight - SQUASH_SOLO_SPEED * timeScale);
    }
    this.squashPressed = above;

    return this.squashHeight <= SQUASH_DONE_HEIGHT;
  }

  update() {
    // Stops dead the moment it's stepped on.
    if (this.isSquashing) return;

    const timeScale = state.timeScale ?? 1;

    // Going through a portal, then flying out of it until it lands (see
    // js/systems/PortalGun.js and updateAirborne).
    if (this.portalTransit) {
      if (PortalGun.updateOoombaTrip(this, timeScale)) {
        this.airborne = true;
        this.airTime = 0;
      }
      return;
    }
    if (this.airborne) {
      this.updateAirborne(timeScale);
      return;
    }

    // Something else steering it (see js/world/MissileOutpost.js's
    // gunner): sets which way it walks, how fast (0: standing still) and
    // its walk animation, each frame, before it moves.
    if (this.brain) this.brain(this);

    const prevX = this.pos.x, prevY = this.pos.y;
    const shape = this.homeShape;
    const perimeter = shape.getPerimeter();

    let speedMultiplier = 1;
    if (typeof shape.getArcSpeedMultiplier === 'function') {
      speedMultiplier = shape.getArcSpeedMultiplier(this.surfaceArcPos, this.direction);
    }

    // Turn-around bounds are inset by this.halfWidth so the Ooomba's own
    // body stays fully on the shape's own footprint when it turns.
    const prevArcPos = this.surfaceArcPos;
    const desiredArcPos = this.surfaceArcPos + this.direction * this.speed * speedMultiplier * timeScale;
    // Measured before any wrap below, so a lap boundary doesn't read as
    // one enormous step.
    let actualDs = desiredArcPos - prevArcPos;
    if (shape.isLoop || (shape.isRoundedRect && !shape.isOpenPath && !shape.isSkyDome)) {
      // A round planetoid — or a rounded-rect one it's landed on after a
      // portal — has no ends to turn around at: it just keeps walking laps.
      this.surfaceArcPos = lua.mod(desiredArcPos, perimeter);
    } else if (desiredArcPos < this.halfWidth || desiredArcPos > perimeter - this.halfWidth) {
      this.direction = -this.direction; // reached the end — turn around instead of falling off
      actualDs = 0;
    } else {
      this.surfaceArcPos = desiredArcPos;
    }

    let surface = shape.worldPointAtArcPosition(this.surfaceArcPos, this.halfHeight);
    // A closed gate in the way turns it around, same as the end of a ledge.
    if (actualDs !== 0 && this.gateBlocks(prevX, prevY, surface.point.x, surface.point.y)) {
      this.surfaceArcPos = prevArcPos;
      this.direction = -this.direction;
      actualDs = 0;
      surface = shape.worldPointAtArcPosition(this.surfaceArcPos, this.halfHeight);
    }
    this.pos = surface.point;
    if (!shape.forceUprightJump) this.up = surface.normal.clone();

    this.walkCyclePhase += this.walkCycleSpeed * timeScale;

    // Actual distance covered THIS frame, not the attempted step above —
    // 0 on the very frame he turns around at an end.
    this.walkTime += (Math.abs(actualDs) / this.strideLength) * Math.PI * 2;
    const bobT = Math.sin(this.walkTime) ** 2;
    const justPlanted = bobT > 0.85 && this.lastWalkBobT <= 0.85;
    this.lastWalkBobT = bobT;
    if (justPlanted) {
      // shape.forceUprightJump means "down" is always straight down here.
      const downDir = shape.forceUprightJump ? new Vector2(0, 1) : surface.normal.clone().multiply(-1);
      const feetPos = this.pos.clone().add(downDir.clone().multiply(this.halfHeight));
      const sideDir = new Vector2(-downDir.y, downDir.x);
      DustPuff.spawn(feetPos, downDir, sideDir, 2 + Math.floor(Math.random() * 2), 2.5, 0.2, 0.6);
    }

    // Walking onto a floor portal drops it in.
    if (timeScale > 0) {
      this.vel = new Vector2((this.pos.x - prevX) / timeScale, (this.pos.y - prevY) / timeScale);
    }
    PortalGun.tryEnterOoomba(this, true);
  }

  // Whether stepping from (fromX, fromY) to (x, y) walks it into a closed
  // Gate (see js/world/Gate.js): its body would overlap the gate's bar
  // there, and the step is toward it. (Only toward, so one a gate closed
  // on top of can still walk out.) A gate raised clear above its head
  // lets it through.
  gateBlocks(fromX, fromY, x, y) {
    for (const gate of state.gates ?? []) {
      if (gate.halfHeight > 1
        && Math.abs(x - gate.pos.x) < this.halfWidth * 0.8 + gate.halfWidth
        && Math.abs(y - gate.pos.y) < this.halfHeight + gate.halfHeight
        && Math.abs(x - gate.pos.x) < Math.abs(fromX - gate.pos.x)) {
        return true;
      }
    }
    return false;
  }

  updateAirborne(ts) {
    this.airTime += ts;
    if (this.airTime > AIRBORNE_GIVE_UP_TICKS) {
      this.lost = true;
      return;
    }

    if (state.gravitySystem) state.gravitySystem.applyTo(this);
    this.pos = new Vector2(this.pos.x + this.vel.x * ts, this.pos.y + this.vel.y * ts);

    let a = Math.atan2(this.up.y, this.up.x);
    const want = upAgainstGravity(this);
    const diff = lua.mod(Math.atan2(want.y, want.x) - a + Math.PI, 2 * Math.PI) - Math.PI;
    a += diff * Math.min(1, AIR_UPRIGHT_RATE * ts);
    this.up = new Vector2(Math.cos(a), Math.sin(a));

    if (PortalGun.tryEnterOoomba(this, false)) return;
    this.tryLand(ts);
  }

  tryLand(ts) {
    const feetX = this.pos.x - this.up.x * this.halfHeight;
    const feetY = this.pos.y - this.up.y * this.halfHeight;
    const gravityUp = upAgainstGravity(this);
    const speed = Math.sqrt(this.vel.x * this.vel.x + this.vel.y * this.vel.y);
    const reach = speed * ts + LANDING_SLACK;

    for (const p of state.planetoids ?? []) {
      if (!p.isWaterPlanet) {
        const cx = p.pos.x, cy = p.pos.y;
        const bound = p.isSkyDome ? Math.max(p.domeRadiusX ?? 0, p.halfWidth ?? 0)
          : ((p.halfWidth ? Math.sqrt(p.halfWidth ** 2 + p.halfHeight ** 2) : null) ?? p.radius ?? 0);
        if ((feetX - cx) ** 2 + (feetY - cy) ** 2 <= (bound + reach + this.drawHeight) ** 2) {
          const [dist, sx, sy, nx, ny] = PortalGun.surfaceOf(p, feetX, feetY);
          const into = this.vel.x * nx + this.vel.y * ny;
          // One-way ledges only from their walkable side.
          const onWalkableSide = !p.isOpenPath || (feetX - sx) * nx + (feetY - sy) * ny > -reach;
          if (dist <= reach && into < 0 && onWalkableSide) {
            if (nx * gravityUp.x + ny * gravityUp.y > 0.5) {
              this.landOn(p, sx, sy);
              return;
            }
            // A wall or ceiling: it stops against it and keeps falling.
            this.vel = new Vector2(this.vel.x - nx * into, this.vel.y - ny * into);
          }
        }
      }
    }

    for (const level of state.tiledLevels ?? []) {
      for (const w of level.walls ?? []) {
        if (w.isWall || (w.isGate && w.halfHeight > 1)) { // (closed gates too)
          const [dist, sx, sy, nx, ny] = PortalGun.wallSurfaceOf(w, this.pos.x, this.pos.y);
          const body = Math.min(this.halfWidth, this.halfHeight);
          if (dist < body) {
            // Pushed back out, and stopped going into it.
            this.pos = new Vector2(sx + nx * body, sy + ny * body);
            const into = this.vel.x * nx + this.vel.y * ny;
            if (into < 0) this.vel = new Vector2(this.vel.x - nx * into, this.vel.y - ny * into);
          }
        }
      }
    }
  }

  landOn(p, x, y) {
    let shape, arc;
    if (p.isRoundedRect || p.isSkyDome) {
      shape = p;
      arc = p.arcPositionForWorldPoint(x, y);
      this.planet = null;
    } else {
      shape = Ooomba.planetPath(p);
      arc = lua.mod(Math.atan2(y - p.pos.y, x - p.pos.x), 2 * Math.PI) * p.radius;
      this.planet = p;
    }
    const perimeter = shape.getPerimeter();
    if (!shape.isLoop && !(shape.isRoundedRect && !shape.isOpenPath && !shape.isSkyDome)) {
      arc = Math.max(this.halfWidth, Math.min(perimeter - this.halfWidth, arc));
    }
    this.homeShape = shape;
    this.surfaceArcPos = arc;
    this.airborne = false;
    this.vel = new Vector2(0, 0);
    const surface = shape.worldPointAtArcPosition(arc, this.halfHeight);
    this.pos = surface.point;
    this.up = shape.forceUprightJump ? new Vector2(0, -1) : surface.normal.clone();
  }

  draw() {
    const img = state.oombaTexture;
    if (!img) return;
    ensureFrameQuads(img);

    const seqIndex = lua.mod(Math.floor(this.walkCyclePhase), FRAME_SEQUENCE.length);
    const frame = FRAME_SEQUENCE[seqIndex];
    const quad = frameQuads[frame];

    // Sprite faces LEFT by default — moving right needs a horizontal
    // flip, via a negative scaleX with the origin at the frame's center.
    let scaleX = this.drawWidth / sheetFrameW;
    if (this.direction > 0) scaleX = -scaleX;
    let scaleY = this.drawHeight / sheetFrameH;

    // Anchored at the sprite's own bottom-center (its feet) rather than
    // its center, so a squash flattens it DOWN onto the ground instead of
    // shrinking toward its middle.
    const squash = this.squashHeight / this.drawHeight;
    scaleX *= (1 + SQUASH_MAX_BULGE * (1 - squash));
    scaleY *= squash;

    // Feet toward the ground, head along this.up.
    const up = this.up;
    const feetDist = this.halfHeight + DRAW_Y_OFFSET;
    const rotation = Math.atan2(up.y, up.x) + Math.PI / 2;

    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.draw(img, quad, this.pos.x - up.x * feetDist, this.pos.y - up.y * feetDist, rotation,
      scaleX, scaleY, sheetFrameW / 2, sheetFrameH);
  }
}

export default Ooomba;
