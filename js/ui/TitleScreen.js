// js/ui/TitleScreen.js
//
// The startup screen shown before gameplay: the astronaut standing on a
// planetoid out in the asteroid belt, the belt drifting by around him,
// with a "PRESS [button] TO START" prompt overlaid. Pressing start fades
// to black, puts him back behind the Space Shelter's door, and fades in
// on the ordinary opening.
//
// This is the REAL player and the REAL world: the game simulates normally
// underneath, state.titleScreen just gates what shouldn't happen yet.
// Meanwhile an autopilot plays Bob, collecting coins (walking, running
// or rolling), hopping/pull-beaming between planetoids, shooting
// asteroids, and staying clear of fire bars.

import love from '../love/index.js';
import lua from '../love/lua.js';
import state from '../state.js';
import worldGen from '../setup/WorldGen.js';
import Asteroid from '../entities/Asteroid.js';
import Ooomba from '../entities/Ooomba.js';
import MetalGradient from '../effects/MetalGradient.js';

const TitleScreen = {};
const rnd = () => lua.random();
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const FADE_OUT_SECONDS = 0.5;
const FADE_IN_SECONDS = 0.8;

const STAND_SEARCH_RADIUS = 1500;

const PROMPT_FONT_SIZE = 40;
const PROMPT_ICON_HEIGHT = 48;
const PROMPT_ICON_GAP = 14;
const PROMPT_Y_FRACTION = 0.84;
const PROMPT_PULSE_SPEED = 2.6;
const PROMPT_PILL_ALPHA = 0.55;
const PROMPT_PILL_PAD_X = 36, PROMPT_PILL_PAD_Y = 18;

const LOGO_WIDTH_FRACTION = 0.6;
const LOGO_TOP_FRACTION = 0.06;
const LOGO_METALLIC = true;
const LOGO_METAL_OPACITY = 0.2;

const TITLE_VOLUME = 0.5;
const GAME_VOLUME = 1;

// "title" (waiting for start) -> "fadeOut" -> "fadeIn" -> null (gone).
let phase = null;
let phaseTimer = 0;
let fadeAlpha = 0;

let promptFont = null;
function getPromptFont() {
  if (!promptFont) promptFont = love.graphics.newFont(PROMPT_FONT_SIZE);
  return promptFont;
}

function usingGamepad() {
  const gamepadTime = state.lastGamepadInputTime;
  if (gamepadTime == null) return false;
  return gamepadTime > Math.max(state.lastMouseMoveTime ?? 0, state.lastKeyboardMouseInputTime ?? 0);
}

// ---------------------------------------------------------------------
// Fire bars: Bob must never touch one, so the autopilot looks ahead.
// ---------------------------------------------------------------------

const FIREBAR_CLEARANCE = 45;
const FIREBAR_STAND_HORIZON = 150;
const FIREBAR_TARGET_HORIZON = 360;
const FIREBAR_AIR_HORIZON = 45;
const FIREBAR_FLEE_COOLDOWN = 0.6;
const FIREBAR_PULL_FLIGHT_TICKS = 60;
const PLAYER_REACH_ON_PLANET = 60;

function fireBarReach(bar) {
  return Math.max(bar.blockRadius ?? 0, (bar.barLength ?? 0) + (bar.fireballRadius ?? 0));
}

function closestApproach(px, py, vx, vy, bar, horizon) {
  const dx = px - bar.pos.x, dy = py - bar.pos.y;
  const speedSq = vx * vx + vy * vy;
  let t = 0;
  if (speedSq > 1e-9) t = Math.max(0, Math.min(horizon, -(dx * vx + dy * vy) / speedSq));
  const cx = dx + vx * t, cy = dy + vy * t;
  return Math.sqrt(cx * cx + cy * cy);
}

function fireBarThreatensPlanet(p, horizon) {
  const vx = p.vel ? p.vel.x : 0, vy = p.vel ? p.vel.y : 0;
  for (const bar of (state.fireBars ?? [])) {
    const limit = fireBarReach(bar) + (p.radius ?? 0) + PLAYER_REACH_ON_PLANET + FIREBAR_CLEARANCE;
    if (closestApproach(p.pos.x, p.pos.y, vx, vy, bar, horizon) < limit) return true;
  }
  return false;
}

function fireBarThreatensPlayer(player, horizon) {
  for (const bar of (state.fireBars ?? [])) {
    const limit = fireBarReach(bar) + player.radius + FIREBAR_CLEARANCE;
    if (closestApproach(player.pos.x, player.pos.y, player.vel.x, player.vel.y, bar, horizon) < limit) return true;
  }
  return false;
}

function fireBarBlocksPath(ax, ay, bx, by, playerRadius) {
  const abx = bx - ax, aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  for (const bar of (state.fireBars ?? [])) {
    let t = 0;
    if (lenSq > 1e-9) t = Math.max(0, Math.min(1, ((bar.pos.x - ax) * abx + (bar.pos.y - ay) * aby) / lenSq));
    const cx = ax + abx * t - bar.pos.x, cy = ay + aby * t - bar.pos.y;
    const limit = fireBarReach(bar) + playerRadius + FIREBAR_CLEARANCE * 0.5;
    if (cx * cx + cy * cy < limit * limit) return true;
  }
  return false;
}

function fireBarBlocksPullTo(player, p) {
  const vx = p.vel ? p.vel.x : 0, vy = p.vel ? p.vel.y : 0;
  return fireBarBlocksPath(player.pos.x, player.pos.y, p.pos.x, p.pos.y, player.radius)
    || fireBarBlocksPath(player.pos.x, player.pos.y,
      p.pos.x + vx * FIREBAR_PULL_FLIGHT_TICKS, p.pos.y + vy * FIREBAR_PULL_FLIGHT_TICKS, player.radius);
}

// Stands the player on top of a belt planetoid (the biggest near the
// middle of the belt ring on his side of the sun).
function standPlayerInBelt() {
  const player = state.player;
  const [sunX, sunY] = worldGen.sunPos();
  const [inner, outer] = worldGen.beltRadii();

  let dirX = player.pos.x - sunX, dirY = player.pos.y - sunY;
  let dirLen = Math.sqrt(dirX * dirX + dirY * dirY);
  if (dirLen < 1) { dirX = 1; dirY = 0; dirLen = 1; }
  const beltX = sunX + (dirX / dirLen) * (inner + outer) / 2;
  const beltY = sunY + (dirY / dirLen) * (inner + outer) / 2;

  const cell = worldGen.cellCoordFor(beltX, beltY);
  worldGen.generateStartingNeighborhood(cell.col, cell.row);

  let best = null;
  for (const p of state.planetoids) {
    if (p.isBeltPlanetoid && p.radius && !fireBarThreatensPlanet(p, FIREBAR_TARGET_HORIZON)) {
      const dx = p.pos.x - beltX, dy = p.pos.y - beltY;
      if (dx * dx + dy * dy <= STAND_SEARCH_RADIUS * STAND_SEARCH_RADIUS) {
        if (!best || p.radius > best.radius) best = p;
      }
    }
  }
  if (!best) return;

  player.angle = -Math.PI / 2;
  player.pos.x = best.pos.x;
  player.pos.y = best.pos.y - (best.radius + player.radius);
  player.prevPos = player.pos.clone();
  player.vel.x = 0; player.vel.y = 0;
  player.onSurface = true;
  player.currentPlanet = best;
  player.lastInfluencePlanet = best;
}

// ---------------------------------------------------------------------
// Autopilot
// ---------------------------------------------------------------------

const COLLECT_STYLE_WEIGHTS = { walk: 45, run: 20, ball: 35 };

const PAUSE_SECONDS = [0.2, 0.5];
const COIN_CHASE_SECONDS = 5.0;
const BALL_LAPS = 2;
const HOP_MAX_GAP = 190;
const HOP_ALIGN_TOLERANCE = 0.1;
const HOP_ALIGN_TIMEOUT = 3.0;
const PULL_SCREEN_INSET = 70;
const PULL_TIMEOUT = 6.0;
const FAR_PULL_CHANCE = 0.6;

const TITLE_ASTEROID_COUNT = 10;
const ASTEROID_SPAWN_SECONDS = [0.4, 1.0];
const ASTEROID_RADIUS = [18, 40];
const ASTEROID_DRIFT_SPEED = [0.9, 1.9];
const ASTEROID_SPAWN_MARGIN = 70;
const ASTEROID_KEEP_MARGIN = 700;
const ASTEROID_SPAWN_CLEARANCE = 30;

const TITLE_OOOMBA_COUNT = 0; // (switched off — set to 2 or so to have them again)
const OOOMBA_MIN_PLANET_RADIUS = 55;
const OOOMBA_SPAWN_SECONDS = 1.0;
const OOOMBA_OFFSCREEN_MARGIN = 80;
const OOOMBA_SPAWN_REACH = 650;
const OOOMBA_KEEP_MARGIN = 1100;

const SHOOT_RANGE = [110, 620];
const SHOOT_SCREEN_INSET = 40;
const SHOOT_PATH_CLEARANCE = 16;
const SHOOT_AIM_SECONDS = 0.3;
const SHOOT_INTERVAL_SECONDS = 0.2;
const SHOOT_GIVE_UP_SECONDS = 3.0;
const SHOOT_REST_SECONDS = 1.0;
const FIREBALL_SPEED = 14; // must match Fireball.js's FIREBALL_SPEED

const DRIFT_RESCUE_SECONDS = 2.6;
const LOST_SECONDS = 9.0;
const LEASH_BEYOND_BELT = 900;

const AUTOPILOT_MAX_DT = 0.05;

const auto = {
  action: 'pause', // "pause" | "collect" | "hopAlign" | "shoot"
  timer: 0,
  run: false,
  collectPlanet: null,
  style: 'walk',
  coin: null,
  coinDir: 1,
  coinTime: 0,
  target: null,
  failedHops: new Set(),
  ballDir: 1,
  ballAngle: 0,
  lastAngle: null,
  airTime: 0,
  pullTime: 0,
  asteroid: null,
  shootTime: 0,
  fireTimer: 0,
  shootRest: 0,
  ignoredAsteroids: new WeakSet(),
  spawnTimer: 0,
  ooombaPlanets: new Set(),
  ooombaSpawnTimer: 0,
  fleeCooldown: 0,
};
let autoKeys = {};

const randomBetween = (range) => range[0] + rnd() * (range[1] - range[0]);

function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function pause() {
  auto.action = 'pause';
  auto.timer = randomBetween(PAUSE_SECONDS);
}

function isPlainPlanetoid(p) {
  return p.radius && !p.isRoundedRect && !p.isWaterPlanet && !p.isPullExempt;
}

function isSafeTarget(p) {
  return isPlainPlanetoid(p) && !auto.ooombaPlanets.has(p)
    && !fireBarThreatensPlanet(p, FIREBAR_TARGET_HORIZON);
}

// Map planetoid -> how many coins orbit it.
function countCoinsByPlanet() {
  const counts = new Map();
  for (const coin of (state.coins ?? [])) counts.set(coin.planet, (counts.get(coin.planet) ?? 0) + 1);
  return counts;
}

function nearestPlanetoid(player, filter) {
  let best = null, bestDistSq = Infinity;
  for (const p of state.planetoids) {
    if (isSafeTarget(p) && (!filter || filter(p))) {
      const dx = p.pos.x - player.pos.x, dy = p.pos.y - player.pos.y;
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq) { best = p; bestDistSq = distSq; }
    }
  }
  return best;
}

function pickHopTarget(player, coinCounts) {
  const home = player.currentPlanet;
  let best = null, bestGap = Infinity;
  for (const p of state.planetoids) {
    if (p !== home && coinCounts.has(p) && isSafeTarget(p) && !auto.failedHops.has(p)) {
      const dx = p.pos.x - home.pos.x, dy = p.pos.y - home.pos.y;
      const gap = Math.sqrt(dx * dx + dy * dy) - p.radius - home.radius;
      if (gap > 0 && gap <= HOP_MAX_GAP && gap < bestGap) { best = p; bestGap = gap; }
    }
  }
  return best;
}

function isOnScreen(p) {
  const cam = state.camera, zoom = state.zoom ?? 1;
  if (!cam) return false;
  const sx = (p.pos.x - cam.x) * zoom, sy = (p.pos.y - cam.y) * zoom;
  return sx >= PULL_SCREEN_INSET && sx <= love.graphics.getWidth() - PULL_SCREEN_INSET
    && sy >= PULL_SCREEN_INSET && sy <= love.graphics.getHeight() - PULL_SCREEN_INSET;
}

function pickFarPullTarget(player, coinCounts) {
  const home = player.currentPlanet;
  let best = null, bestDistSq = 0;
  for (const p of state.planetoids) {
    if (p !== home && coinCounts.has(p) && isSafeTarget(p) && isOnScreen(p)) {
      const dx = p.pos.x - home.pos.x, dy = p.pos.y - home.pos.y;
      const distSq = dx * dx + dy * dy;
      const gap = Math.sqrt(distSq) - p.radius - home.radius;
      if (gap > HOP_MAX_GAP && distSq > bestDistSq) { best = p; bestDistSq = distSq; }
    }
  }
  return best;
}

function pickPullTarget(player, coinCounts) {
  const hasCoins = (p) => p !== player.currentPlanet && coinCounts.has(p);
  return nearestPlanetoid(player, (p) => hasCoins(p) && isOnScreen(p))
    ?? nearestPlanetoid(player, hasCoins);
}

function startPull(player, target) {
  if (fireBarBlocksPullTo(player, target)) return false;
  player.trySelectPullTarget(target);
  if (player.pullTarget !== target) return false;
  player.lockedTarget = target;
  player.lockAimLeadX = null; player.lockAimLeadY = null;
  auto.pullTime = 0;
  return true;
}

function pickEscape(player, exclude) {
  const coinCounts = countCoinsByPlanet();
  let best = null, bestScore = Infinity;
  for (const p of state.planetoids) {
    if (p !== player.currentPlanet && p !== exclude && isSafeTarget(p) && !fireBarBlocksPullTo(player, p)) {
      const dx = p.pos.x - player.pos.x, dy = p.pos.y - player.pos.y;
      const score = Math.sqrt(dx * dx + dy * dy) - (coinCounts.has(p) ? 150 : 0);
      if (score < bestScore) { best = p; bestScore = score; }
    }
  }
  return best;
}

// -> [vx, vy]
function beltOrbitVelocity(x, y) {
  const [sunX, sunY] = worldGen.sunPos();
  const dx = x - sunX, dy = y - sunY;
  const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
  return [(-dy / dist) * worldGen.BELT_ORBIT_SPEED, (dx / dist) * worldGen.BELT_ORBIT_SPEED];
}

function updateTitleOoombas(dt) {
  const player = state.player;
  if (!player) return;
  state.ooombas = state.ooombas ?? [];

  const viewW = state.visibleWidth ?? love.graphics.getWidth();
  const viewH = state.visibleHeight ?? love.graphics.getHeight();
  const cornerDist = Math.sqrt(viewW * viewW + viewH * viewH) / 2;

  const alivePlanets = new Set(state.planetoids);

  let count = 0;
  auto.ooombaPlanets = new Set();
  for (let i = state.ooombas.length - 1; i >= 0; i--) {
    const o = state.ooombas[i];
    if (o.titleOoomba) {
      const dx = o.pos.x - player.pos.x, dy = o.pos.y - player.pos.y;
      const keepDist = cornerDist + OOOMBA_KEEP_MARGIN;
      if (!alivePlanets.has(o.planet) || dx * dx + dy * dy > keepDist * keepDist) state.ooombas.splice(i, 1);
      else count += 1;
    }
  }
  for (const o of state.ooombas) if (o.planet) auto.ooombaPlanets.add(o.planet);

  auto.ooombaSpawnTimer -= dt;
  if (count >= TITLE_OOOMBA_COUNT || auto.ooombaSpawnTimer > 0) return;
  auto.ooombaSpawnTimer = OOOMBA_SPAWN_SECONDS;

  const cam = state.camera;
  if (!cam) return;
  const candidates = [];
  for (const p of state.planetoids) {
    if (p.isBeltPlanetoid && p.radius >= OOOMBA_MIN_PLANET_RADIUS && !auto.ooombaPlanets.has(p)
        && p !== player.currentPlanet && p !== player.pullTarget && p !== auto.target) {
      const margin = p.radius + OOOMBA_OFFSCREEN_MARGIN;
      const offScreen = p.pos.x < cam.x - margin || p.pos.x > cam.x + viewW + margin
        || p.pos.y < cam.y - margin || p.pos.y > cam.y + viewH + margin;
      const dx = p.pos.x - player.pos.x, dy = p.pos.y - player.pos.y;
      const reach = cornerDist + OOOMBA_SPAWN_REACH;
      if (offScreen && dx * dx + dy * dy <= reach * reach) candidates.push(p);
    }
  }
  if (candidates.length === 0) return;

  const planet = pick(candidates);
  const ooomba = Ooomba.newOnPlanet(planet, rnd() * Math.PI * 2, { direction: rnd() < 0.5 ? -1 : 1 });
  ooomba.titleOoomba = true;
  state.ooombas.push(ooomba);
  auto.ooombaPlanets.add(planet);
}

function updateTitleAsteroids(dt) {
  const player = state.player;
  if (!player || !state.asteroids) return;

  const viewW = state.visibleWidth ?? love.graphics.getWidth();
  const viewH = state.visibleHeight ?? love.graphics.getHeight();
  const keepDist = Math.sqrt(viewW * viewW + viewH * viewH) / 2 + ASTEROID_KEEP_MARGIN;

  let alive = 0;
  for (let i = state.asteroids.length - 1; i >= 0; i--) {
    const a = state.asteroids[i];
    if (!a.titleDrift) continue;
    const dx = a.pos.x - player.pos.x, dy = a.pos.y - player.pos.y;
    if (dx * dx + dy * dy > keepDist * keepDist) {
      state.asteroids.splice(i, 1);
    } else {
      alive += 1;
      const [ox, oy] = beltOrbitVelocity(a.pos.x, a.pos.y);
      const driftSpeed = Math.sqrt(a.titleDrift.x ** 2 + a.titleDrift.y ** 2);
      if (driftSpeed > ASTEROID_DRIFT_SPEED[1]) {
        const keep = 0.985 ** (dt * 60);
        a.titleDrift.x *= keep; a.titleDrift.y *= keep;
      }
      a.vel.x = ox + a.titleDrift.x; a.vel.y = oy + a.titleDrift.y;
    }
  }

  auto.spawnTimer -= dt;
  if (alive >= TITLE_ASTEROID_COUNT || auto.spawnTimer > 0) return;
  auto.spawnTimer = randomBetween(ASTEROID_SPAWN_SECONDS);

  const radius = randomBetween(ASTEROID_RADIUS);
  for (let attempt = 0; attempt < 8; attempt++) {
    const halfW = viewW / 2 + ASTEROID_SPAWN_MARGIN, halfH = viewH / 2 + ASTEROID_SPAWN_MARGIN;
    let ox, oy;
    if (rnd() < viewW / (viewW + viewH)) {
      ox = (rnd() * 2 - 1) * halfW; oy = (rnd() < 0.5 ? -1 : 1) * halfH;
    } else {
      ox = (rnd() < 0.5 ? -1 : 1) * halfW; oy = (rnd() * 2 - 1) * halfH;
    }
    const angle = Math.atan2(oy, ox);
    const x = player.pos.x + ox, y = player.pos.y + oy;

    let clear = true;
    for (const p of state.planetoids) {
      if (p.radius) {
        const dx = p.pos.x - x, dy = p.pos.y - y;
        const minDist = p.radius + radius + ASTEROID_SPAWN_CLEARANCE;
        if (dx * dx + dy * dy < minDist * minDist) { clear = false; break; }
      }
    }

    if (clear) {
      const asteroid = Asteroid.new(x, y, radius);
      const heading = angle + Math.PI + (rnd() - 0.5) * 1.0;
      const speed = randomBetween(ASTEROID_DRIFT_SPEED);
      asteroid.titleDrift = { x: Math.cos(heading) * speed, y: Math.sin(heading) * speed };
      state.asteroids.push(asteroid);
      return;
    }
  }
}

// -> [x, y] where to aim to hit a moving asteroid.
function interceptPoint(player, asteroid) {
  const rx = asteroid.pos.x - player.pos.x, ry = asteroid.pos.y - player.pos.y;
  const vx = asteroid.vel.x, vy = asteroid.vel.y;
  const a = vx * vx + vy * vy - FIREBALL_SPEED * FIREBALL_SPEED;
  const b = 2 * (rx * vx + ry * vy);
  const c = rx * rx + ry * ry;
  let t = 0;
  const disc = b * b - 4 * a * c;
  if (a < 0 && disc >= 0) t = Math.max(0, (-b - Math.sqrt(disc)) / (2 * a));
  return [asteroid.pos.x + vx * t, asteroid.pos.y + vy * t];
}

// Where his ARM has to point for the fireball to pass through (tx, ty).
const MUZZLE_PX_X = 530, MUZZLE_PX_Y = 120;
function aimPointFor(player, tx, ty) {
  const shoulder = player.aimShoulderPos;
  if (!shoulder) return [tx, ty];
  const cfg = player.bodyPartsConfig, scale = player.bodyScale;
  const vx = (MUZZLE_PX_X - cfg.leftArmJointX) * scale;
  const vy = (MUZZLE_PX_Y - cfg.leftArmJointY) * scale * (player.facingDirection < 0 ? -1 : 1);
  const angleOffset = player.blasterAngleOffset ?? 0;

  let aim = Math.atan2(ty - shoulder.y, tx - shoulder.x);
  for (let k = 0; k < 3; k++) {
    const c = Math.cos(aim), s = Math.sin(aim);
    const muzzleX = shoulder.x + vx * c - vy * s;
    const muzzleY = shoulder.y + vx * s + vy * c;
    aim = Math.atan2(ty - muzzleY, tx - muzzleX) - angleOffset;
  }

  const dist = Math.sqrt((tx - shoulder.x) ** 2 + (ty - shoulder.y) ** 2);
  return [shoulder.x + Math.cos(aim) * dist, shoulder.y + Math.sin(aim) * dist];
}

function hasClearShot(player, asteroid) {
  const dx = asteroid.pos.x - player.pos.x, dy = asteroid.pos.y - player.pos.y;
  const distSq = dx * dx + dy * dy;
  if (distSq < SHOOT_RANGE[0] * SHOOT_RANGE[0] || distSq > SHOOT_RANGE[1] * SHOOT_RANGE[1]) return false;

  const cam = state.camera, zoom = state.zoom ?? 1;
  if (!cam) return false;
  const sx = (asteroid.pos.x - cam.x) * zoom, sy = (asteroid.pos.y - cam.y) * zoom;
  if (sx < SHOOT_SCREEN_INSET || sx > love.graphics.getWidth() - SHOOT_SCREEN_INSET
      || sy < SHOOT_SCREEN_INSET || sy > love.graphics.getHeight() - SHOOT_SCREEN_INSET) return false;

  const ax = player.pos.x, ay = player.pos.y;
  const [bx, by] = interceptPoint(player, asteroid);
  const abx = bx - ax, aby = by - ay;
  const abLenSq = abx * abx + aby * aby;
  if (abLenSq < 1) return false;

  for (const p of state.planetoids) {
    if (!p.radius) continue;
    let t = ((p.pos.x - ax) * abx + (p.pos.y - ay) * aby) / abLenSq;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + abx * t - p.pos.x, cy = ay + aby * t - p.pos.y;
    const block = p.radius + SHOOT_PATH_CLEARANCE;
    if (cx * cx + cy * cy < block * block) return false;
  }
  return true;
}

function pickShootTarget(player) {
  let best = null, bestDistSq = Infinity;
  for (const a of (state.asteroids ?? [])) {
    if (auto.ignoredAsteroids.has(a)) continue;
    const dx = a.pos.x - player.pos.x, dy = a.pos.y - player.pos.y;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq && hasClearShot(player, a)) { best = a; bestDistSq = distSq; }
  }
  return best;
}

function endShoot(player) {
  player.lockedTarget = null;
  player.lockAimLeadX = null; player.lockAimLeadY = null;
  auto.asteroid = null;
  auto.shootRest = SHOOT_REST_SECONDS;
  pause();
}

function updateShoot(player, dt) {
  const asteroid = auto.asteroid;
  if (!(state.asteroids ?? []).includes(asteroid)) {
    endShoot(player);
    return;
  }

  auto.shootTime += dt;
  if (auto.shootTime > SHOOT_GIVE_UP_SECONDS || !hasClearShot(player, asteroid)) {
    auto.ignoredAsteroids.add(asteroid);
    endShoot(player);
    return;
  }

  const [ix, iy] = interceptPoint(player, asteroid);
  const [aimX, aimY] = aimPointFor(player, ix, iy);
  player.lockedTarget = asteroid;
  player.lockAimLeadX = aimX - asteroid.pos.x;
  player.lockAimLeadY = aimY - asteroid.pos.y;

  auto.fireTimer -= dt;
  if (auto.shootTime >= SHOOT_AIM_SECONDS && auto.fireTimer <= 0) {
    player.shootFireball();
    const dist = Math.sqrt((ix - player.pos.x) ** 2 + (iy - player.pos.y) ** 2);
    auto.fireTimer = dist / FIREBALL_SPEED / 60 + SHOOT_INTERVAL_SECONDS;
  }
}

function pickCollectStyle() {
  let total = 0;
  for (const w of Object.values(COLLECT_STYLE_WEIGHTS)) total += w;
  let roll = rnd() * total;
  for (const name of ['walk', 'run', 'ball']) {
    if (roll < COLLECT_STYLE_WEIGHTS[name]) return name;
    roll -= COLLECT_STYLE_WEIGHTS[name];
  }
  return 'walk';
}

function holdDirection(dir) {
  autoKeys[dir < 0 ? 'ArrowLeft' : 'ArrowRight'] = true;
}

function collectCoins(player, dt) {
  const planet = player.currentPlanet;

  let stillThere = false;
  let nearest = null, nearestOff = Infinity;
  for (const coin of state.coins) {
    if (coin.planet !== planet) continue;
    if (coin === auto.coin) stillThere = true;
    const off = Math.abs(wrapAngle(coin.angle - player.angle));
    if (off < nearestOff) { nearest = coin; nearestOff = off; }
  }

  auto.coinTime += dt;
  if (!stillThere || auto.coinTime > COIN_CHASE_SECONDS) {
    auto.coin = nearest;
    auto.coinTime = 0;
    if (nearest) auto.coinDir = wrapAngle(nearest.angle - player.angle) >= 0 ? 1 : -1;
  }
  if (!auto.coin) return;

  if (auto.style === 'ball' && !player.isBall && !player.morphState) player.enterBallMode();
  auto.run = auto.style === 'run';
  holdDirection(auto.coinDir);
}

function decide(player) {
  const coinCounts = countCoinsByPlanet();
  const here = player.currentPlanet;
  auto.run = false;

  if (coinCounts.has(here)) {
    if (auto.collectPlanet !== here) {
      auto.collectPlanet = here;
      auto.style = pickCollectStyle();
      auto.failedHops = new Set();
      auto.ballAngle = 0;
      if (auto.style === 'ball') {
        let nearestOff = null;
        for (const coin of state.coins) {
          if (coin.planet === here) {
            const off = wrapAngle(coin.angle - player.angle);
            if (nearestOff == null || Math.abs(off) < Math.abs(nearestOff)) nearestOff = off;
          }
        }
        auto.ballDir = (nearestOff ?? 1) >= 0 ? 1 : -1;
      }
    }
    auto.action = 'collect';
    auto.coin = null;
    return;
  }

  if (player.isBall || player.morphState) {
    player.exitBallMode();
    return;
  }

  const hopTarget = pickHopTarget(player, coinCounts);
  if (hopTarget && rnd() < FAR_PULL_CHANCE) {
    const farTarget = pickFarPullTarget(player, coinCounts);
    if (farTarget && startPull(player, farTarget)) {
      pause();
      return;
    }
  }
  if (hopTarget) {
    auto.action = 'hopAlign';
    auto.timer = HOP_ALIGN_TIMEOUT;
    auto.target = hopTarget;
    return;
  }

  const pullTarget = pickPullTarget(player, coinCounts);
  if (pullTarget && startPull(player, pullTarget)) {
    pause();
    return;
  }

  pause();
}

function updateAutopilot(dt) {
  const player = state.player;
  autoKeys = {};
  if (!player || player.isDying || player.isTeleporting) return;

  const [sunX, sunY] = worldGen.sunPos();
  const [inner, outer] = worldGen.beltRadii();
  const fromSun = Math.sqrt((player.pos.x - sunX) ** 2 + (player.pos.y - sunY) ** 2);
  if (fromSun < inner - LEASH_BEYOND_BELT || fromSun > outer + LEASH_BEYOND_BELT) {
    player.pullTarget = null; player.lockedTarget = null;
    standPlayerInBelt();
  }

  auto.fleeCooldown = Math.max(0, auto.fleeCooldown - dt);

  if (!player.onSurface) {
    auto.airTime += dt;
    auto.run = false;

    if (auto.fleeCooldown <= 0 && !player.isBall && !player.morphState
        && fireBarThreatensPlayer(player, FIREBAR_AIR_HORIZON)) {
      const escape = pickEscape(player, player.pullTarget);
      if (escape && startPull(player, escape)) auto.fleeCooldown = FIREBAR_FLEE_COOLDOWN;
    }
    if (auto.asteroid) {
      player.lockedTarget = null;
      player.lockAimLeadX = null; player.lockAimLeadY = null;
      auto.asteroid = null;
      auto.action = 'pause';
    }
    if (player.pullTarget) {
      auto.pullTime += dt;
      if (auto.pullTime > PULL_TIMEOUT) {
        player.clearPullTarget();
        player.lockedTarget = null;
      }
    } else if (auto.airTime > LOST_SECONDS) {
      player.lockedTarget = null;
      standPlayerInBelt();
      auto.airTime = 0;
    } else if (auto.airTime > DRIFT_RESCUE_SECONDS && !player.isBall && !player.morphState) {
      const coinCounts = countCoinsByPlanet();
      const rescue = nearestPlanetoid(player, (p) => coinCounts.has(p)) ?? nearestPlanetoid(player);
      if (rescue) startPull(player, rescue);
    }
    return;
  }

  if (auto.airTime > 0) {
    auto.airTime = 0;
    player.lockedTarget = null;
    if (auto.target && player.currentPlanet !== auto.target) auto.failedHops.add(auto.target);
    auto.target = null;
    pause();
  }
  if (!player.currentPlanet || !isPlainPlanetoid(player.currentPlanet)) return;

  if (fireBarThreatensPlanet(player.currentPlanet, FIREBAR_STAND_HORIZON)) {
    auto.run = false;
    if (auto.asteroid) {
      player.lockAimLeadX = null; player.lockAimLeadY = null;
      auto.asteroid = null;
    }
    auto.target = null;
    if (player.isBall || player.morphState) {
      player.exitBallMode();
      return;
    }
    const escape = pickEscape(player);
    if (escape && startPull(player, escape)) {
      auto.fleeCooldown = FIREBAR_FLEE_COOLDOWN;
      pause();
      return;
    }
    if (auto.action === 'shoot') pause();
  }

  if (auto.ooombaPlanets.has(player.currentPlanet)) {
    auto.run = false;
    if (auto.asteroid) {
      player.lockAimLeadX = null; player.lockAimLeadY = null;
      auto.asteroid = null;
    }
    auto.target = null;
    if (player.isBall || player.morphState) {
      player.exitBallMode();
      return;
    }
    const coinCounts = countCoinsByPlanet();
    const escape = nearestPlanetoid(player, (p) => p !== player.currentPlanet && coinCounts.has(p))
      ?? nearestPlanetoid(player, (p) => p !== player.currentPlanet);
    if (!(escape && startPull(player, escape))) player.jump();
    pause();
    return;
  }

  auto.shootRest = Math.max(0, auto.shootRest - dt);
  if (auto.action === 'shoot') {
    auto.run = false;
    updateShoot(player, dt);
    return;
  }
  if (auto.shootRest <= 0 && !player.isBall && !player.morphState) {
    const asteroid = pickShootTarget(player);
    if (asteroid) {
      auto.action = 'shoot';
      auto.asteroid = asteroid;
      auto.shootTime = 0;
      auto.fireTimer = 0;
      auto.target = null;
      auto.run = false;
      return;
    }
  }

  auto.timer -= dt;

  if (player.isBall && auto.lastAngle != null && auto.collectPlanet === player.currentPlanet) {
    auto.ballAngle += Math.abs(wrapAngle(player.angle - auto.lastAngle));
  }
  auto.lastAngle = player.angle;

  if (auto.action === 'collect' && auto.style === 'ball' && auto.ballAngle < BALL_LAPS * 2 * Math.PI) {
    if (!player.isBall && !player.morphState) player.enterBallMode();
    auto.run = false;
    holdDirection(auto.ballDir);
  } else if (auto.action === 'collect') {
    collectCoins(player, dt);
    if (!auto.coin) pause();
  } else if (auto.action === 'hopAlign') {
    const home = player.currentPlanet, target = auto.target;
    const wanted = Math.atan2(target.pos.y - home.pos.y, target.pos.x - home.pos.x);
    const off = wrapAngle(wanted - player.angle);
    if (Math.abs(off) <= HOP_ALIGN_TOLERANCE || auto.timer <= 0) {
      player.jump();
      pause();
    } else {
      holdDirection(off > 0 ? 1 : -1);
    }
  } else if (auto.timer <= 0) {
    decide(player);
  }
}

// The direction keys the autopilot is "holding" this frame — main.js
// passes this to Player.move in place of the real keys.
TitleScreen.getKeys = () => autoKeys;

// Call once, at the end of love.load. fadeIn: open on black (coming back
// from the pause menu's EXIT TO TITLE).
TitleScreen.enter = function (fadeIn) {
  state.titleScreen = true;
  phase = fadeIn ? 'fadeIn' : 'title';
  phaseTimer = 0;
  fadeAlpha = fadeIn ? 1 : 0;
  auto.action = 'pause'; auto.timer = 1.0; auto.airTime = 0; auto.pullTime = 0;
  auto.run = false; auto.target = null;
  auto.collectPlanet = null; auto.coin = null; auto.coinTime = 0; auto.failedHops = new Set();
  auto.ballAngle = 0; auto.lastAngle = null;
  auto.asteroid = null; auto.shootRest = 0; auto.spawnTimer = 0;
  auto.ooombaPlanets = new Set(); auto.ooombaSpawnTimer = 0;
  auto.fleeCooldown = 0;
  autoKeys = {};
  love.audio.setVolume(TITLE_VOLUME);
  standPlayerInBelt();
};

// The start button. Only does anything while the title is waiting for it.
TitleScreen.requestStart = function () {
  if (phase !== 'title') return;
  phase = 'fadeOut';
  phaseTimer = 0;
};

// The cut itself, made while the screen is fully black.
function beginGame() {
  const player = state.player;
  player.pullTarget = null;
  player.lockedTarget = null;
  player.lockAimLeadX = null; player.lockAimLeadY = null;
  state.gamepadRunHeld = false;
  const ooombas = state.ooombas ?? [];
  for (let i = ooombas.length - 1; i >= 0; i--) {
    if (ooombas[i].titleOoomba) ooombas.splice(i, 1);
  }
  autoKeys = {};
  player.respawn();
  player.invincibleTimer = 0;

  state.zoom = 1;
  state.zoomTarget = null;
  state.score = 0;
  for (const name of Object.keys(state.elements ?? {})) state.elements[name] = 0;
  state.elementPieces = [];
  love.audio.setVolume(GAME_VOLUME);

  state.camera = {
    x: player.pos.x - (state.visibleWidth ?? 0) / 2,
    y: player.pos.y - (state.visibleHeight ?? 0) / 2,
  };
  worldGen.updateActiveCells();

  state.titleScreen = false;
}

// Call every frame from love.update, before the player/camera update.
TitleScreen.update = function (dt) {
  if (state.titleScreen) {
    updateTitleOoombas(Math.min(dt, AUTOPILOT_MAX_DT));
    updateTitleAsteroids(Math.min(dt, AUTOPILOT_MAX_DT));
    updateAutopilot(Math.min(dt, AUTOPILOT_MAX_DT));
    state.gamepadRunHeld = auto.run && Object.keys(autoKeys).length > 0;
  }

  if (!phase || phase === 'title') return;

  phaseTimer += dt;
  if (phase === 'fadeOut') {
    fadeAlpha = Math.min(1, phaseTimer / FADE_OUT_SECONDS);
    if (phaseTimer >= FADE_OUT_SECONDS) {
      beginGame();
      phase = 'fadeIn';
      phaseTimer = 0;
      fadeAlpha = 1;
    }
  } else if (phase === 'fadeIn') {
    fadeAlpha = Math.max(0, 1 - phaseTimer / FADE_IN_SECONDS);
    if (phaseTimer >= FADE_IN_SECONDS) {
      phase = state.titleScreen ? 'title' : null;
      fadeAlpha = 0;
    }
  }
};

// The logo, with a chrome gradient multiplied over it (see MetalGradient.js).
let logoMetalShader = null;
function getLogoMetal() {
  if (logoMetalShader) return logoMetalShader;
  logoMetalShader = love.graphics.newShader(`
    extern Image gradient;
    extern float opacity;
    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      vec4 texel = Texel(tex, uv);
      vec3 metal = mix(vec3(1.0), Texel(gradient, vec2(0.5, uv.y)).rgb, opacity);
      return vec4(texel.rgb * metal, texel.a) * color;
    }
  `);
  logoMetalShader.send('gradient', MetalGradient.getImage());
  logoMetalShader.send('opacity', LOGO_METAL_OPACITY);
  return logoMetalShader;
}

function drawLogo() {
  const g = love.graphics;
  const logo = state.titleLogoTexture;
  if (!logo) return;
  const screenW = g.getWidth(), screenH = g.getHeight();
  const scale = Math.min(1, screenW * LOGO_WIDTH_FRACTION / logo.getWidth());
  g.setColor(1, 1, 1, 1);
  if (LOGO_METALLIC) g.setShader(getLogoMetal());
  g.draw(logo, Math.floor((screenW - logo.getWidth() * scale) / 2), Math.floor(screenH * LOGO_TOP_FRACTION), 0, scale, scale);
  if (LOGO_METALLIC) g.setShader();
}

function drawPrompt() {
  const g = love.graphics;
  const font = getPromptFont();
  const icons = state.buttonIcons;
  const icon = icons ? (usingGamepad() ? icons.CROSS : icons.ENTER) : null;

  let before = 'PRESS';
  const after = 'TO START';
  if (!icon) before = usingGamepad() ? 'PRESS X' : 'PRESS ENTER';

  const beforeW = font.getWidth(before), afterW = font.getWidth(after);
  let iconScale = 1, iconW = 0;
  if (icon) {
    iconScale = PROMPT_ICON_HEIGHT / icon.getHeight();
    iconW = icon.getWidth() * iconScale;
  }
  const middleW = icon ? (PROMPT_ICON_GAP + iconW + PROMPT_ICON_GAP) : font.getWidth(' ');
  const totalW = beforeW + middleW + afterW;

  const screenW = g.getWidth(), screenH = g.getHeight();
  const x = Math.floor((screenW - totalW) / 2);
  const centerY = Math.floor(screenH * PROMPT_Y_FRACTION);
  const textY = Math.floor(centerY - font.getHeight() / 2);

  const pillH = Math.max(font.getHeight(), PROMPT_ICON_HEIGHT) + PROMPT_PILL_PAD_Y * 2;
  const pillX = x - PROMPT_PILL_PAD_X, pillW = totalW + PROMPT_PILL_PAD_X * 2;
  g.setColor(0, 0, 0, PROMPT_PILL_ALPHA);
  g.rectangle('fill', pillX, centerY - pillH / 2, pillW, pillH, pillH / 2, pillH / 2);
  g.setColor(1, 1, 1, 0.35);
  g.setLineWidth(2);
  g.rectangle('line', pillX, centerY - pillH / 2, pillW, pillH, pillH / 2, pillH / 2);
  g.setLineWidth(1);

  const alpha = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(love.timer.getTime() * PROMPT_PULSE_SPEED));

  const prevFont = g.getFont();
  g.setFont(font);

  const text = (s, tx) => {
    g.setColor(0, 0, 0, 0.7 * alpha);
    g.print(s, tx + 3, textY + 3);
    g.setColor(1, 1, 1, alpha);
    g.print(s, tx, textY);
  };

  text(before, x);
  if (icon) {
    g.setColor(1, 1, 1, alpha);
    g.draw(icon, Math.floor(x + beforeW + PROMPT_ICON_GAP), Math.floor(centerY - PROMPT_ICON_HEIGHT / 2),
      0, iconScale, iconScale);
  }
  text(after, x + beforeW + middleW);

  g.setFont(prevFont);
  g.setColor(1, 1, 1, 1);
}

// Call last in love.draw, in screen space.
TitleScreen.draw = function () {
  const g = love.graphics;
  if (state.titleScreen) {
    drawLogo();
    drawPrompt();
  }
  if (fadeAlpha > 0) {
    g.setColor(0, 0, 0, fadeAlpha);
    g.rectangle('fill', 0, 0, g.getWidth(), g.getHeight());
    g.setColor(1, 1, 1, 1);
  }
};

export default TitleScreen;
