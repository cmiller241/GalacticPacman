// js/levels/Expressway.js
//
// The galactic expressway (see js/world/Cannon.js): a loop of track all
// the way round the sun, with rails at every corner, loop-the-loops, a
// corkscrew, pinball pockets of bumpers and an asteroid gauntlet; two
// entry cannons merging onto it, and exits off it (flippers) down to
// landmarks. Random planetoids and asteroids are kept out of a lane down
// every straight and round every rail and bumper (state.clearLanes).
// Called from js/levels/World.js, after every landmark it has to route
// round already exists. (Port of lua/levels/Expressway.lua.)

import state from '../state.js';
import Vector2 from '../vector2.js';
import Planetoid from '../world/Planetoid.js';
import Cannon from '../world/Cannon.js';
import worldGen from '../setup/WorldGen.js';

const rad = (d) => d * Math.PI / 180;

const Expressway = {};

// -> { planet, cannon } for the north entry (used by main.js's
// START_AT = 'expressway').
Expressway.build = function () {
  const ENTRY_PLANET_INSET = 6500;
  const ENTRY_PLANET_RADIUS = 250;
  const CLEAR_LANE_HALF_WIDTH = 500;
  const RAIL_CLEARANCE = 250;
  const [sunX, sunY] = worldGen.sunPos();

  // The ring's corners, clockwise from the top: [degrees round the sun
  // (-90 straight up), distance from the sun].
  const OUTLINE = [
    [-90, 30000], [-62, 34500], [-38, 27500], [-55, 20500], [-6, 22000],
    [10, 33000], [38, 28500], [64, 36000], [92, 31000], [80, 41000],
    [122, 42500], [148, 33000], [172, 26000], [200, 30500], [190, 38500],
    [224, 40000], [248, 32000], [232, 24500], [256, 21500],
  ];
  const corners = OUTLINE.map(([deg, dist]) => {
    const a = rad(deg);
    return [sunX + Math.cos(a) * dist, sunY + Math.sin(a) * dist];
  });
  // (1-based corner numbers, as in the Lua: C(n) = corners[n - 1].
  // Corner n is reached by the straight from corner n-1.)
  const C = (n) => corners[n - 1];
  C(6).loops = 1;
  C(11).loops = 2;
  C(12).gauntlet = true;
  const CORKSCREW_LOOPS = 5;
  C(9).loops = CORKSCREW_LOOPS;
  C(9).loopRadius = 380;
  C(9).loopGap = 300;
  C(9).loopsFirst = true;
  C(9).fling = true;

  // Pinball pockets: bumpers in a zigzag either side of a straight.
  const POCKETS = [
    { from: 2, at: 0.5, count: 5, spacing: 700, spread: 400 },
    { from: 4, at: 0.45, count: 3, spacing: 800, spread: 350 },
    { from: 7, at: 0.5, count: 5, spacing: 700, spread: 400 },
    { from: 13, at: 0.5, count: 7, spacing: 650, spread: 380 },
    { from: 15, at: 0.3, count: 3, spacing: 800, spread: 450 },
    { from: 16, at: 0.55, count: 5, spacing: 700, spread: 420 },
  ];
  // (The south entry's straight, noted before the bumpers renumber things.)
  const southLegA = C(10), southLegB = C(11);

  // (Inserted last straight first, so earlier corner numbers stay put.)
  POCKETS.sort((p, q) => q.from - p.from);
  for (const spec of POCKETS) {
    const a = C(spec.from), b = C(spec.from + 1);
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    const ux = dx / len, uy = dy / len;
    const nx = -uy, ny = ux;
    const mx = a[0] + dx * spec.at, my = a[1] + dy * spec.at;
    for (let k = spec.count - 1; k >= 0; k--) {
      const along = (k - (spec.count - 1) / 2) * spec.spacing;
      const side = (k % 2 === 0) ? spec.spread : -spec.spread;
      // (Lua's table.insert(corners, from + 1, ...) — 0-based index `from`.)
      corners.splice(spec.from, 0,
        Object.assign([mx + ux * along + nx * side, my + uy * along + ny * side], { bumper: true }));
    }
  }

  const expressway = Cannon.newTrack(corners);
  state.expressway = expressway;
  state.cannons = [expressway];

  // The entries: a planet inside the ring, ENTRY_PLANET_INSET in from the
  // middle of a straight, its cannon merging onto it. -> [planet, cannon]
  const entryPlanets = new Set();
  const makeEntry = (a, b, mountAngle) => {
    const midX = (a[0] + b[0]) / 2, midY = (a[1] + b[1]) / 2;
    let inX = sunX - midX, inY = sunY - midY;
    const inLen = Math.sqrt(inX * inX + inY * inY);
    inX /= inLen; inY /= inLen;
    const planet = Planetoid.new(midX + inX * ENTRY_PLANET_INSET, midY + inY * ENTRY_PLANET_INSET,
      ENTRY_PLANET_RADIUS, [0.5, 0.56, 0.68, 1]);
    planet.isImmovable = true;
    planet.isPermanent = true;
    planet.vel = Vector2.new(0, 0);
    state.planetoids.push(planet);
    entryPlanets.add(planet);
    const cannon = Cannon.new(planet, mountAngle ?? Math.atan2(-inY, -inX), null, [],
      Cannon.trackMergeAt(expressway, midX, midY));
    state.cannons.push(cannon);
    return [planet, cannon];
  };
  const [entryPlanet, entryCannon] = makeEntry(corners[0], corners[1], -Math.PI / 2);
  state.expresswayEntryPlanet = entryPlanet;
  const [southPlanet] = makeEntry(southLegA, southLegB);
  state.expresswaySouthEntryPlanet = southPlanet;

  // The exits (see Cannon.newExit): one to each landmark, leaving from
  // whichever straight gets there shortest with nothing in the way.
  const EXIT_CURVE_RADIUS = 700;
  const EXIT_APPROACH = 2600;
  const EXIT_CLEARANCE = 1600;
  const EXIT_END_MARGIN = 1300;
  const EXIT_LANDMARK_CLEARANCE = 500;
  const EXIT_MAX_TURN = rad(110);
  const EXIT_SAMPLE_STEP = 600;
  const EXIT_TARGETS = [
    { planet: state.beltLandingPlanet },
    { planet: state.roundedRectPlanet, along: -0.3 },
    { planet: state.pinballPlanet, along: 0.3 },
  ];
  const [, beltOuterR] = worldGen.beltRadii();
  const pointSegDist = (x, y, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lenSq)) : 0;
    return Math.sqrt((x - ax - dx * t) ** 2 + (y - ay - dy * t) ** 2);
  };
  const segSegDist = (a, b, c, d) => {
    const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
    if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return 0;
    return Math.min(pointSegDist(a[0], a[1], c[0], c[1], d[0], d[1]), pointSegDist(b[0], b[1], c[0], c[1], d[0], d[1]),
      pointSegDist(c[0], c[1], a[0], a[1], b[0], b[1]), pointSegDist(d[0], d[1], a[0], a[1], b[0], b[1]));
  };
  // How near segment a-b comes to landmark p's outline.
  const segClearance = (p, a, b) => {
    const len = Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
    if (!p.halfWidth) return pointSegDist(p.pos.x, p.pos.y, a[0], a[1], b[0], b[1]) - (p.radius ?? 0);
    const top = p.isSkyDome ? (p.domeRadiusY ?? p.halfWidth) : p.halfHeight;
    let best = Infinity;
    const n = Math.max(1, Math.ceil(len / 100));
    for (let k = 0; k <= n; k++) {
      const u = k / n;
      const x = a[0] + (b[0] - a[0]) * u, y = a[1] + (b[1] - a[1]) * u;
      const ox = Math.max(0, Math.abs(x - p.pos.x) - p.halfWidth);
      const dy = y - p.pos.y;
      const oy = dy < 0 ? Math.max(0, -dy - top) : Math.max(0, dy - p.halfHeight);
      best = Math.min(best, Math.sqrt(ox * ox + oy * oy));
    }
    return best;
  };
  // -> [clear, whatBlocks]
  const exitIsClear = (points, fromI, target) => {
    for (let k = 0; k < points.length - 1; k++) {
      let a = points[k];
      const b = points[k + 1];
      if (k === 0) {
        const len = Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
        const u = Math.min(1, EXIT_CLEARANCE / len);
        a = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
      }
      for (let i = 0; i < expressway.pieces.length; i++) {
        const pc = expressway.pieces[i];
        if (pc.kind === 'line' && i !== fromI && segSegDist(a, b, pc.from, pc.to) < EXIT_CLEARANCE) return [false, 'the expressway itself'];
      }
      for (const rail of expressway.rails) {
        if (pointSegDist(rail.cx, rail.cy, a[0], a[1], b[0], b[1]) < rail.radius + EXIT_CLEARANCE) return [false, 'the expressway itself'];
      }
      for (const bp of expressway.bumpers) {
        if (pointSegDist(bp.x, bp.y, a[0], a[1], b[0], b[1]) < bp.radius + EXIT_CLEARANCE) return [false, 'the expressway itself'];
      }
      if (pointSegDist(sunX, sunY, a[0], a[1], b[0], b[1]) < beltOuterR + 200) return [false, 'the belt'];
      for (const p of state.planetoids) {
        if ((p !== target || k < points.length - 2) && !entryPlanets.has(p) && p.pos
            && segClearance(p, a, b) < EXIT_LANDMARK_CLEARANCE) {
          return [false, `a landmark at (${Math.round(p.pos.x)}, ${Math.round(p.pos.y)})`];
        }
      }
    }
    return [true, null];
  };
  state.expresswayExits = [];
  for (const spec of EXIT_TARGETS) {
    const target = spec.planet;
    if (!target) continue;
    let tail;
    if (target.isRoundedRect) {
      const landX = target.pos.x + (spec.along ?? 0) * target.halfWidth;
      const landY = target.pos.y - target.halfHeight;
      tail = [Object.assign([landX, landY - EXIT_APPROACH], { radius: EXIT_CURVE_RADIUS }), [landX, landY]];
    } else {
      tail = [[target.pos.x, target.pos.y]];
    }
    const aimX = tail[0][0], aimY = tail[0][1];
    let best = null, nearestBlocker = null;
    expressway.pieces.forEach((pc, i) => {
      if (pc.kind !== 'line' || pc.gauntlet) return;
      const dx = pc.dir[0], dy = pc.dir[1];
      const len = Math.sqrt((pc.to[0] - pc.from[0]) ** 2 + (pc.to[1] - pc.from[1]) ** 2);
      for (let s = EXIT_END_MARGIN; s <= len - EXIT_END_MARGIN; s += EXIT_SAMPLE_STEP) {
        const qx = pc.from[0] + dx * s, qy = pc.from[1] + dy * s;
        const points = [[qx, qy], ...tail];
        const length = Math.sqrt((aimX - qx) ** 2 + (aimY - qy) ** 2);
        const ox = (aimX - qx) / length, oy = (aimY - qy) / length;
        const tooSharp = Math.acos(Math.max(-1, Math.min(1, ox * dx + oy * dy))) > EXIT_MAX_TURN;
        const fromBelow = target.isRoundedRect && oy < -0.3;
        if (!tooSharp && !fromBelow && (!best || length < best.length)) {
          const [clear, blocker] = exitIsClear(points, i, target);
          if (clear) best = { piece: i, points, length };
          else if (!nearestBlocker || length < nearestBlocker.length) nearestBlocker = { length, what: blocker };
        }
      }
    });
    if (best) {
      const exit = Cannon.newExit(expressway, best.piece, best.points, target);
      state.cannons.push(exit);
      state.expresswayExits.push(exit);
    } else {
      console.log(`Expressway: no clear way off the expressway to the landmark at (${Math.round(target.pos.x)}, ${Math.round(target.pos.y)}) — no exit made for it (in the way: ${nearestBlocker ? nearestBlocker.what : 'no straight lines up with it'}).`);
    }
  }

  // Clear lanes down every straight of every route, and round every
  // rail and bumper.
  state.clearLanes = [];
  const isOurs = new Set(entryPlanets);
  const segmentsOf = (cannon) => {
    const route = cannon.points, segs = [];
    for (let i = 0; i < route.length - 1; i++) segs.push([route[i], route[i + 1]]);
    if (cannon.closed) segs.push([route[route.length - 1], route[0]]);
    return segs;
  };
  for (const cannon of state.cannons) {
    if (cannon.ledge) isOurs.add(cannon.ledge);
    for (const s of segmentsOf(cannon)) {
      state.clearLanes.push([s[0][0], s[0][1], s[1][0], s[1][1], CLEAR_LANE_HALF_WIDTH]);
    }
    cannon.clearCircles = [];
    for (const rail of cannon.rails) cannon.clearCircles.push([rail.cx, rail.cy, rail.radius]);
    for (const b of cannon.bumpers) cannon.clearCircles.push([b.x, b.y, b.radius]);
    for (const c of cannon.clearCircles) state.clearLanes.push([c[0], c[1], c[0], c[1], c[2] + RAIL_CLEARANCE]);
  }

  // Sanity check: each route against the sun/belt and every landmark.
  const nearestOnRoute = (cannon, x, y) => {
    let best = Infinity;
    for (const s of segmentsOf(cannon)) {
      const ax = s[0][0], ay = s[0][1], bx = s[1][0], by = s[1][1];
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
      best = Math.min(best, Math.sqrt((x - (ax + dx * t)) ** 2 + (y - (ay + dy * t)) ** 2));
    }
    for (const c of cannon.clearCircles) {
      const d = Math.sqrt((x - c[0]) ** 2 + (y - c[1]) ** 2) - (c[2] + RAIL_CLEARANCE);
      best = Math.min(best, Math.max(0, d));
    }
    return best;
  };
  const [, beltOuter] = worldGen.beltRadii();
  state.cannons.forEach((cannon, idx) => {
    if (cannon.isExit) return;
    const name = cannon.isTrack ? 'the expressway' : `cannon ${idx + 1}`;
    if (nearestOnRoute(cannon, sunX, sunY) < beltOuter + CLEAR_LANE_HALF_WIDTH) {
      console.log(`Expressway: ${name} passes through the asteroid belt or the sun — move one of its corners.`);
    }
    for (const p of state.planetoids) {
      if (isOurs.has(p)) continue;
      const reach = (p.radius ?? Math.max(p.halfWidth ?? 0, p.halfHeight ?? 0)) + CLEAR_LANE_HALF_WIDTH;
      if (nearestOnRoute(cannon, p.pos.x, p.pos.y) < reach) {
        console.log(`Expressway: ${name} passes close to a landmark at (${Math.round(p.pos.x)}, ${Math.round(p.pos.y)}).`);
      }
    }
  });

  return { planet: entryPlanet, cannon: entryCannon };
};

export default Expressway;
