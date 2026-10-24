// js/systems/Raycast.js
import { state } from '../state.js';
import { Vector2 } from '../vector2.js';

// A circular bounding radius for any world object — exact for
// genuinely circular ones (planetoids, asteroids, goombas, all of
// which carry a real .radius), approximated by the CIRCUMSCRIBING
// circle (hypot(halfWidth, halfHeight)) for rounded-rect/dome-shaped
// planets (SkyDomePlanetoid, RoundedRectPlanetoid, BeamPlanetoid,
// JumpPlatform), which aren't truly circular. Shared by
// findNearestOccluder's viewport filter below and TargetLock.js's own
// candidate gathering, so both treat "how big is this thing" the same
// way. Worth flagging specifically for SkyDomePlanetoid: this only
// accounts for the flat platform body, NOT the much taller glass dome
// rising above it — the dome itself isn't currently factored in here.
export function getBoundingRadius(obj) {
  return obj.isRoundedRect ? Math.hypot(obj.halfWidth, obj.halfHeight) : obj.radius;
}

// True if an object's bounding circle (see getBoundingRadius above)
// overlaps the camera's current viewport (state.camera/visibleWidth/
// visibleHeight — set once per frame in game.js's gameLoop, right
// where the camera transform itself is established). A simple AABB
// overlap test, not exact pixel-level visibility, but cheap and
// sufficient for both its current uses: skipping raycast candidates
// the player can't see, and deciding whether a locked target has
// scrolled off-screen and should auto-release.
export function isInViewport(obj) {
  const radius = getBoundingRadius(obj);
  if (!radius) return false;
  const cam = state.camera || { x: 0, y: 0 };
  const vw = state.visibleWidth || 0;
  const vh = state.visibleHeight || 0;
  if (obj.pos.x + radius < cam.x || obj.pos.x - radius > cam.x + vw) return false;
  if (obj.pos.y + radius < cam.y || obj.pos.y - radius > cam.y + vh) return false;
  return true;
}

// Finds the nearest occluder (planetoid or asteroid) that a ray from
// (originX, originY) traveling at `angle` would hit, restricted to
// occluders currently visible within the viewport (see isInViewport
// above). Used for both the aim indicator (AimIndicator.js) and the
// gamepad L2 pull-target selection (gamepadInput.js), so both always
// agree on exactly what's being targeted — computed once here rather
// than each of those two re-deriving their own answer, which could
// otherwise silently disagree with each other.
export function findNearestOccluder(originX, originY, angle) {
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);

  let best = null;
  let bestDist = Infinity;

  const candidates = [...state.planetoids, ...state.asteroids];
  for (const obj of candidates) {
    const radius = getBoundingRadius(obj);
    if (!radius) continue;
    if (!isInViewport(obj)) continue;

    // Standard ray-vs-circle intersection: project the vector to the
    // circle's center onto the ray direction (tca) to find the point
    // on the ray LINE closest to the center, then get the
    // perpendicular distance from the center to that line (via dSq).
    // If that distance is within the radius, thc is the half-chord
    // length, and tca ± thc are the two intersection distances along
    // the ray — t0 (the nearer one) is preferred, but only if it's
    // actually ahead of the ray's origin (t0 >= 0); otherwise t1 (the
    // far intersection) is used instead, which happens when the
    // origin itself is already inside the circle.
    const toCenterX = obj.pos.x - originX;
    const toCenterY = obj.pos.y - originY;
    const tca = toCenterX * dirX + toCenterY * dirY;
    const dSq = (toCenterX * toCenterX + toCenterY * toCenterY) - tca * tca;
    const radiusSq = radius * radius;
    if (dSq > radiusSq) continue; // ray LINE misses the circle entirely

    const thc = Math.sqrt(radiusSq - dSq);
    const t0 = tca - thc;
    const t1 = tca + thc;
    const t = t0 >= 0 ? t0 : t1;
    if (t < 0) continue; // both intersections are behind the ray's origin — circle is entirely behind where we're aiming from

    if (t < bestDist) {
      bestDist = t;
      best = obj;
    }
  }

  if (!best) return { point: null, object: null };

  return {
    point: new Vector2(originX + dirX * bestDist, originY + dirY * bestDist),
    object: best
  };
}