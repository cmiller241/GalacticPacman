// js/state.js
var state = {
  canvas: null,
  ctx: null,
  sceneWidth: 0,
  sceneHeight: 0,
  player: null,
  planetoids: [],
  // Includes regular, spikey, and maze planets
  asteroids: [],
  enemies: [],
  // Ghosts
  coins: [],
  particles: [],
  mazeGhosts: [],
  mazeWalls: [],
  mazeDots: [],
  powerPellets: [],
  score: 0,
  level: 1,
  gameOver: false,
  levelComplete: false,
  inMaze: false,
  mazePlanet: null,
  stars: [],
  keys: {},
  eatDotIndex: 0,
  lastAlphaUpdate: 0,
  // If needed globally
  lastFrameTime: 0,
  fps: 0
  // Add any other runtime state here as needed
};

// js/constants.js
var GRAVITY_STRENGTH = 0.35;
var GROUND_POUND_GRAV_MULTIPLIER = 3;
var GROUND_POUND_PUSH_STRENGTH = 0.05;
var JUMP_STRENGTH = 9;
var PLAYER_LINEAR_SPEED = 4;
var PLAYER_RADIUS = 20;
var ENEMY_RADIUS = 20;
var COIN_RADIUS = 5;
var COIN_ORBIT_OFFSET = 18;
var INFLUENCE_PADDING = 140;
var SURFACE_TOLERANCE = 4;
var DRAG = 0.995;
var PLANET_SPEED = 0.8;
var ENEMY_JUMP_PROB = 5e-4;
var STAR_COUNT = 800;
var MAZE_TILE_SIZE = 12;
var MAZE_COLS = 28;
var MAZE_ROWS = 29;
var MAZE_EXIT_COL_LEFT = 13;
var MAZE_EXIT_COL_RIGHT = 14;
var MAZE_EXIT_ROW = 13;
var mazeLayout = [
  "     ##################     ",
  "     #.......##.......#     ",
  "     #.#####.##.#####.#     ",
  "     #.#####.##.#####.#     ",
  "######.#####.##.#####.######",
  "#..........................#",
  "#.####.##.########.##.####.#",
  "#.####.##.########.##.####.#",
  "#......##....##....##......#",
  "#.####.#####.##.#####.####.#",
  "#.####.#####.##.#####.####.#",
  "#.####.##          ##.####.#",
  "#......## ######## ##......#",
  "#.####.## #      # ##.####.#",
  "#.####.   #      #   .####.#",
  "#......## #      # ##......#",
  "#.####.## ###--### ##.####.#",
  "#.####.##          ##.####.#",
  "#.####.## ######## ##.####.#",
  "#.####.##.########.##.####.#",
  "#............##............#",
  "#.####.#####.##.#####.####.#",
  "#.####.#####.##.#####.####.#",
  "#.####.#####.##.#####.####.#",
  "#..........................#",
  "######.##.########.##.######",
  "     #.##.########.##.#     ",
  "     #................#     ",
  "     ##################     "
];
var enemyColors = ["red", "pink", "cyan", "orange"];
var planetColors = ["blue", "green", "purple", "orange", "yellow", "red", "cyan"];

// js/vector2.js
var Vector2 = class _Vector2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
  add(v) {
    this.x += v.x;
    this.y += v.y;
    return this;
  }
  subtract(v) {
    return new _Vector2(this.x - v.x, this.y - v.y);
  }
  multiply(s) {
    return new _Vector2(this.x * s, this.y * s);
  }
  length() {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }
  normalize() {
    const len = this.length();
    if (len > 0) {
      this.x /= len;
      this.y /= len;
    }
    return this;
  }
  clone() {
    return new _Vector2(this.x, this.y);
  }
  dot(v) {
    return this.x * v.x + this.y * v.y;
  }
};

// js/planetoid.js
var Planetoid = class {
  constructor(x, y, radius, color) {
    this.pos = new Vector2(x, y);
    this.radius = radius;
    this.mass = radius * radius;
    this.influenceRadius = radius + INFLUENCE_PADDING;
    this.color = color;
    let direction = new Vector2(Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
    this.vel = direction.multiply(PLANET_SPEED);
    this.cachedAlpha = 0.3;
    this.lastAlphaUpdate = 0;
    this.isSpikey = false;
    this.offscreen = null;
  }
  createOffscreen() {
    this.offscreen = document.createElement("canvas");
    this.offscreen.width = this.radius * 2;
    this.offscreen.height = this.radius * 2;
    const offCtx = this.offscreen.getContext("2d");
    offCtx.save();
    offCtx.beginPath();
    offCtx.arc(this.radius, this.radius, this.radius, 0, Math.PI * 2);
    offCtx.clip();
    const tiles = 2.5;
    const texSize = this.radius * 2 * tiles;
    const texOffset = this.radius * tiles;
    offCtx.drawImage(state.planetTexture, this.radius - texOffset, this.radius - texOffset, texSize, texSize);
    offCtx.restore();
    offCtx.save();
    offCtx.globalCompositeOperation = "multiply";
    offCtx.beginPath();
    offCtx.arc(this.radius, this.radius, this.radius, 0, Math.PI * 2);
    offCtx.fillStyle = this.color;
    offCtx.fill();
    offCtx.globalCompositeOperation = "source-over";
    offCtx.restore();
    offCtx.save();
    offCtx.globalCompositeOperation = "multiply";
    const offsetX = -this.radius * 0.5;
    const offsetY = -this.radius * 0.5;
    const lightGradient = offCtx.createRadialGradient(
      this.radius + offsetX,
      this.radius + offsetY,
      0,
      this.radius + offsetX,
      this.radius + offsetY,
      this.radius * 1.5
    );
    lightGradient.addColorStop(0, "white");
    lightGradient.addColorStop(1, "black");
    offCtx.beginPath();
    offCtx.arc(this.radius, this.radius, this.radius, 0, Math.PI * 2);
    offCtx.fillStyle = lightGradient;
    offCtx.fill();
    offCtx.globalCompositeOperation = "source-over";
    offCtx.restore();
  }
  draw() {
    const ctx = state.ctx;
    const now = Date.now();
    if (now - this.lastAlphaUpdate > 500) {
      const dist = this.pos.subtract(state.player.pos).length();
      this.cachedAlpha = Math.max(0.01, 0.3 - dist / 1e3 * 0.65);
      this.lastAlphaUpdate = now;
    }
    ctx.save();
    ctx.strokeStyle = `rgba(173,216,230,${this.cachedAlpha})`;
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 5]);
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, this.influenceRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.shadowColor = "rgba(173,216,230,0.3)";
    ctx.shadowBlur = 25;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    if (this.offscreen) {
      ctx.drawImage(this.offscreen, this.pos.x - this.radius, this.pos.y - this.radius);
    } else {
      const offsetX = -this.radius * 0.5;
      const offsetY = -this.radius * 0.5;
      const gradient = ctx.createRadialGradient(
        this.pos.x + offsetX,
        this.pos.y + offsetY,
        0,
        this.pos.x + offsetX,
        this.pos.y + offsetY,
        this.radius * 1.5
      );
      gradient.addColorStop(0, this.color);
      gradient.addColorStop(1, "black");
      ctx.beginPath();
      ctx.arc(this.pos.x, this.pos.y, this.radius, 0, Math.PI * 2);
      ctx.fillStyle = gradient;
      ctx.fill();
    }
    ctx.restore();
  }
};
var SpikeyPlanetoid = class extends Planetoid {
  constructor(x, y, radius) {
    super(x, y, radius, "gray");
    this.isSpikey = true;
    this.spikeHeight = 8;
    this.spikeSpacing = 6;
    this.padding = this.spikeHeight;
    this.spikeRotation = 0;
    this.spikeRotationSpeed = 0.02;
  }
  createOffscreen() {
    const padding = this.padding;
    this.offscreen = document.createElement("canvas");
    this.offscreen.width = 2 * (this.radius + padding);
    this.offscreen.height = 2 * (this.radius + padding);
    const offCtx = this.offscreen.getContext("2d");
    const cx = this.radius + padding;
    const cy = this.radius + padding;
    offCtx.beginPath();
    offCtx.arc(cx, cy, this.radius, 0, Math.PI * 2);
    offCtx.fillStyle = this.color;
    offCtx.fill();
    offCtx.save();
    offCtx.globalCompositeOperation = "multiply";
    const offsetX = -this.radius * 0.5;
    const offsetY = -this.radius * 0.5;
    const lightGradient = offCtx.createRadialGradient(
      cx + offsetX,
      cy + offsetY,
      0,
      cx + offsetX,
      cy + offsetY,
      this.radius * 1.5
    );
    lightGradient.addColorStop(0, "white");
    lightGradient.addColorStop(1, "black");
    offCtx.beginPath();
    offCtx.arc(cx, cy, this.radius, 0, Math.PI * 2);
    offCtx.fillStyle = lightGradient;
    offCtx.fill();
    offCtx.globalCompositeOperation = "source-over";
    offCtx.restore();
  }
  drawSpikes(ctx) {
    const numSpikes = Math.floor(2 * Math.PI * this.radius / this.spikeSpacing);
    const angleStep = 2 * Math.PI / numSpikes;
    const halfBaseAngle = angleStep / 2;
    for (let i = 0; i < numSpikes; i++) {
      const angle = i * angleStep;
      const leftAngle = angle - halfBaseAngle;
      const rightAngle = angle + halfBaseAngle;
      const baseLeftX = Math.cos(leftAngle) * this.radius;
      const baseLeftY = Math.sin(leftAngle) * this.radius;
      const baseRightX = Math.cos(rightAngle) * this.radius;
      const baseRightY = Math.sin(rightAngle) * this.radius;
      const tipX = Math.cos(angle) * (this.radius + this.spikeHeight);
      const tipY = Math.sin(angle) * (this.radius + this.spikeHeight);
      ctx.beginPath();
      ctx.moveTo(baseLeftX, baseLeftY);
      ctx.lineTo(tipX, tipY);
      ctx.lineTo(baseRightX, baseRightY);
      ctx.closePath();
      ctx.fillStyle = "darkgray";
      ctx.fill();
    }
  }
  draw() {
    const ctx = state.ctx;
    const now = Date.now();
    if (now - this.lastAlphaUpdate > 500) {
      const dist = this.pos.subtract(state.player.pos).length();
      this.cachedAlpha = Math.max(0.01, 0.3 - dist / 1e3 * 0.65);
      this.lastAlphaUpdate = now;
    }
    ctx.save();
    ctx.strokeStyle = `rgba(173,216,230,${this.cachedAlpha})`;
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 5]);
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, this.influenceRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.shadowColor = "rgba(173,216,230,0.3)";
    ctx.shadowBlur = 25;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    if (this.offscreen) {
      ctx.drawImage(
        this.offscreen,
        this.pos.x - (this.radius + this.padding),
        this.pos.y - (this.radius + this.padding)
      );
    } else {
      ctx.beginPath();
      ctx.arc(this.pos.x, this.pos.y, this.radius, 0, Math.PI * 2);
      ctx.fillStyle = this.color;
      ctx.fill();
    }
    ctx.restore();
    this.spikeRotation += this.spikeRotationSpeed;
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.spikeRotation);
    this.drawSpikes(ctx);
    ctx.restore();
  }
};
var MazePlanetoid = class extends Planetoid {
  constructor(x, y, radius) {
    super(x, y, radius, "#8A2BE2");
    this.beamAngle = -Math.PI / 2;
    this.beamLength = 140;
    this.beamWidth = 14;
    this.beamParticles = [];
    this.portalParticles = [];
    this.mazeOffscreen = null;
    this.createMazeOffscreen();
  }
  createMazeOffscreen() {
    const mazeWidth = MAZE_COLS * MAZE_TILE_SIZE;
    const mazeHeight = MAZE_ROWS * MAZE_TILE_SIZE;
    this.mazeOffscreen = document.createElement("canvas");
    this.mazeOffscreen.width = mazeWidth;
    this.mazeOffscreen.height = mazeHeight;
    const offCtx = this.mazeOffscreen.getContext("2d");
    offCtx.fillStyle = "#cc00cc";
    offCtx.strokeStyle = "#330033";
    offCtx.lineWidth = 4;
    for (let row = 0; row < MAZE_ROWS; row++) {
      for (let col = 0; col < MAZE_COLS; col++) {
        if (state.mazeWalls[row][col]) {
          offCtx.fillRect(col * MAZE_TILE_SIZE, row * MAZE_TILE_SIZE, MAZE_TILE_SIZE, MAZE_TILE_SIZE);
        }
      }
    }
  }
  draw() {
    const ctx = state.ctx;
    super.draw();
    const offsetX = this.pos.x - MAZE_COLS * MAZE_TILE_SIZE / 2;
    const offsetY = this.pos.y - MAZE_ROWS * MAZE_TILE_SIZE / 2;
    ctx.save();
    ctx.globalAlpha = 0.5;
    if (this.mazeOffscreen) {
      ctx.drawImage(this.mazeOffscreen, offsetX, offsetY);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#FFFFFF";
    for (let dot of state.mazeDots) {
      const x = offsetX + dot.x * MAZE_TILE_SIZE + MAZE_TILE_SIZE / 2;
      const y = offsetY + dot.y * MAZE_TILE_SIZE + MAZE_TILE_SIZE / 2;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#FFFF00";
    for (let pp of state.powerPellets) {
      const x = offsetX + pp.x * MAZE_TILE_SIZE + MAZE_TILE_SIZE / 2;
      const y = offsetY + pp.y * MAZE_TILE_SIZE + MAZE_TILE_SIZE / 2;
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fill();
    }
    const portalX = offsetX + (MAZE_EXIT_COL_LEFT + 0.5) * MAZE_TILE_SIZE + MAZE_TILE_SIZE / 2;
    const portalY = offsetY + MAZE_EXIT_ROW * MAZE_TILE_SIZE + MAZE_TILE_SIZE / 2;
    const pulse = (Math.sin(Date.now() * 6e-3) + 1) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(portalX, portalY, 10 + pulse * 4, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 0, 255, ${0.7 + pulse * 0.3})`;
    ctx.fill();
    ctx.strokeStyle = "#ffaaff";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
    state.mazeGhosts.forEach((g) => g.draw());
    ctx.restore();
    if (Math.random() < 0.5) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1 + Math.random() * 2;
      const vel = new Vector2(Math.cos(angle) * speed, Math.sin(angle) * speed);
      const spawnPos = new Vector2(portalX, portalY);
      this.portalParticles.push(new PortalParticle(spawnPos, vel, 40));
    }
    const beamStartX = this.pos.x + Math.cos(this.beamAngle) * this.radius;
    const beamStartY = this.pos.y + Math.sin(this.beamAngle) * this.radius;
    const beamEndX = beamStartX + Math.cos(this.beamAngle) * this.beamLength;
    const beamEndY = beamStartY + Math.sin(this.beamAngle) * this.beamLength;
    if (Math.random() < 0.6) {
      const beamDir = new Vector2(Math.cos(this.beamAngle), Math.sin(this.beamAngle));
      const side = new Vector2(-beamDir.y, beamDir.x).multiply((Math.random() - 0.5) * 1.5);
      const speed = 2 + Math.random() * 2;
      const vel = beamDir.multiply(speed).add(side);
      const spawnPos = new Vector2(beamStartX, beamStartY);
      this.beamParticles.push(new BeamParticle(spawnPos, vel, 50));
    }
    const gradient = ctx.createLinearGradient(beamStartX, beamStartY, beamEndX, beamEndY);
    gradient.addColorStop(0, "rgba(255, 0, 255, 1)");
    gradient.addColorStop(1, "rgba(255, 0, 255, 0)");
    ctx.save();
    ctx.shadowColor = "#FF00FF";
    ctx.shadowBlur = 60;
    ctx.strokeStyle = gradient;
    ctx.lineWidth = this.beamWidth;
    ctx.beginPath();
    ctx.moveTo(beamStartX, beamStartY);
    ctx.lineTo(beamEndX, beamEndY);
    ctx.stroke();
    ctx.shadowBlur = 20;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(beamStartX - 8, beamStartY);
    ctx.lineTo(beamEndX - 8, beamEndY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(beamStartX + 8, beamStartY);
    ctx.lineTo(beamEndX + 8, beamEndY);
    ctx.stroke();
    ctx.restore();
    for (let i = this.beamParticles.length - 1; i >= 0; i--) {
      const p = this.beamParticles[i];
      p.update();
      p.draw();
      if (p.life <= 0) this.beamParticles.splice(i, 1);
    }
    for (let i = this.portalParticles.length - 1; i >= 0; i--) {
      const p = this.portalParticles[i];
      p.update();
      p.draw();
      if (p.life <= 0) this.portalParticles.splice(i, 1);
    }
  }
};
var BeamParticle = class {
  constructor(pos, vel, life = 40) {
    this.pos = pos.clone();
    this.vel = vel;
    this.life = life;
    this.maxLife = life;
  }
  update() {
    this.pos.add(this.vel);
    this.life--;
  }
  draw() {
    const ctx = state.ctx;
    if (this.life <= 0) return;
    const alpha = this.life / this.maxLife;
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 0, 255, ${alpha})`;
    ctx.fill();
  }
};
var PortalParticle = class {
  constructor(pos, vel, life = 35) {
    this.pos = pos.clone();
    this.vel = vel;
    this.life = life;
    this.maxLife = life;
  }
  update() {
    this.pos.add(this.vel);
    this.life--;
  }
  draw() {
    const ctx = state.ctx;
    if (this.life <= 0) return;
    const alpha = this.life / this.maxLife;
    const size = 3 * alpha;
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, size, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 0, 255, ${alpha})`;
    ctx.fill();
  }
};

// js/asteroid.js
var Asteroid = class {
  constructor(x, y, radius) {
    this.pos = new Vector2(x, y);
    this.radius = radius;
    this.mass = radius * radius;
    let direction = new Vector2(Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
    this.vel = direction.multiply(PLANET_SPEED);
    this.angularSpeed = (Math.random() * 2 - 1) * 0.05;
    this.angle = Math.random() * Math.PI * 2;
    this.color = "#8B4513";
    this.points = this.generatePoints();
  }
  generatePoints() {
    const numSides = 6 + Math.floor(Math.random() * 6);
    const points = [];
    const angleStep = 2 * Math.PI / numSides;
    for (let i = 0; i < numSides; i++) {
      const a = i * angleStep + (Math.random() - 0.5) * angleStep * 0.5;
      const r = this.radius * (0.7 + Math.random() * 0.6);
      points.push(new Vector2(Math.cos(a) * r, Math.sin(a) * r));
    }
    return points;
  }
  update() {
    this.vel = this.vel.multiply(DRAG);
    this.pos.add(this.vel);
    this.angle += this.angularSpeed;
    if (this.pos.x - this.radius < 0) {
      this.pos.x = this.radius;
      this.vel.x = -this.vel.x;
    }
    if (this.pos.x + this.radius > state.sceneWidth) {
      this.pos.x = state.sceneWidth - this.radius;
      this.vel.x = -this.vel.x;
    }
    if (this.pos.y - this.radius < 0) {
      this.pos.y = this.radius;
      this.vel.y = -this.vel.y;
    }
    if (this.pos.y + this.radius > state.sceneHeight) {
      this.pos.y = state.sceneHeight - this.radius;
      this.vel.y = -this.vel.y;
    }
  }
  draw() {
    const ctx = state.ctx;
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.angle);
    ctx.beginPath();
    ctx.moveTo(this.points[0].x, this.points[0].y);
    for (let i = 1; i < this.points.length; i++) {
      ctx.lineTo(this.points[i].x, this.points[i].y);
    }
    ctx.closePath();
    ctx.fillStyle = this.color;
    ctx.fill();
    ctx.strokeStyle = "black";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }
};

// js/particle.js
var Particle = class {
  constructor(pos, vel, life = 40) {
    this.pos = pos.clone();
    this.vel = vel;
    this.life = life;
  }
  update() {
    this.pos.add(this.vel);
    this.life--;
  }
  draw() {
    const ctx = state.ctx;
    if (this.life <= 0) return;
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, 2, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 255, 0, ${this.life / 40})`;
    ctx.fill();
  }
};

// js/utils.js
var eatDotAudio0;
var eatDotAudio1;
var deathAudio;
var jumpAudio;
var jumpSmallAudio;
var bangLarge;
var bangMedium;
var bangSmall;
function initAudio() {
  eatDotAudio0 = new Audio("sounds/eat_dot_0.wav");
  eatDotAudio1 = new Audio("sounds/eat_dot_1.wav");
  deathAudio = new Audio("sounds/death_0.wav");
  jumpAudio = new Audio("sounds/jump.wav");
  jumpSmallAudio = new Audio("sounds/jumpsmall.wav");
  bangLarge = new Audio("sounds/bangLarge.wav");
  bangMedium = new Audio("sounds/bangMedium.wav");
  bangSmall = new Audio("sounds/bangSmall.wav");
  [eatDotAudio0, eatDotAudio1, deathAudio, jumpAudio, jumpSmallAudio, bangLarge, bangMedium, bangSmall].forEach((audio) => {
    audio.volume = 0.5;
    audio.preload = "auto";
    audio.load();
  });
}
function playEatDot() {
  const source = state.eatDotIndex === 0 ? eatDotAudio0 : eatDotAudio1;
  state.eatDotIndex = 1 - state.eatDotIndex;
  const audio = source.cloneNode(true);
  audio.play().catch((e) => console.log("Audio play failed:", e));
}
function playDeath() {
  const audio = deathAudio.cloneNode(true);
  audio.play().catch((e) => console.log("Audio play failed:", e));
}
function playJump() {
  const audio = jumpAudio.cloneNode(true);
  audio.play().catch((e) => console.log("Audio play failed:", e));
}
function playBang(size, position) {
  let audioSource;
  if (size === "large") audioSource = bangLarge;
  else if (size === "medium") audioSource = bangMedium;
  else if (size === "small") audioSource = bangSmall;
  else return;
  const dist = state.player.pos.subtract(position).length();
  let vol = 0.5 * Math.max(0, 1 - dist / 800);
  if (vol <= 0) return;
  const audio = audioSource.cloneNode(true);
  audio.volume = vol;
  audio.play().catch((e) => console.log("Audio play failed:", e));
}
function getRandomPelletMazePos() {
  const pellets = state.mazeDots.concat(state.powerPellets);
  const p = pellets[Math.floor(Math.random() * pellets.length)];
  return { col: p.x, row: p.y };
}
function buildMazeData() {
  state.mazeWalls = Array.from({ length: MAZE_ROWS }, () => Array(MAZE_COLS).fill(false));
  state.mazeDots = [];
  state.powerPellets = [];
  for (let row = 0; row < MAZE_ROWS; row++) {
    for (let col = 0; col < MAZE_COLS; col++) {
      const ch = mazeLayout[row][col];
      if (ch === "#") state.mazeWalls[row][col] = true;
      if (ch === "." || ch === "o") {
        const dot = { x: col, y: row };
        if (ch === "o") state.powerPellets.push(dot);
        else state.mazeDots.push(dot);
      }
    }
  }
}
function isWall(col, row) {
  if (row < 0 || row >= MAZE_ROWS) return true;
  if (col < 0) col = MAZE_COLS - 1;
  if (col >= MAZE_COLS) col = 0;
  return state.mazeWalls[row][col];
}
function updatePlayerMazePosition() {
  const offsetX = state.mazePlanet.pos.x - MAZE_COLS * MAZE_TILE_SIZE / 2;
  const offsetY = state.mazePlanet.pos.y - MAZE_ROWS * MAZE_TILE_SIZE / 2;
  state.player.pos.x = offsetX + state.player.mazeCol * MAZE_TILE_SIZE + MAZE_TILE_SIZE / 2;
  state.player.pos.y = offsetY + state.player.mazeRow * MAZE_TILE_SIZE + MAZE_TILE_SIZE / 2;
}
function enterMazeMode() {
  state.inMaze = true;
  state.player.inMaze = true;
  state.player.onSurface = false;
  state.player.currentPlanet = null;
  state.player.mazeCol = 14;
  state.player.mazeRow = 15;
  state.player.mazeDir = new Vector2(1, 0);
  state.player.lastMoveTime = Date.now();
  updatePlayerMazePosition();
}
function startTeleportToMaze() {
  state.player.isTeleporting = true;
  state.player.teleportStartTime = Date.now();
  state.player.vel = new Vector2(0, 0);
  state.player.onSurface = false;
}
function startTeleportFromMaze() {
  state.player.isTeleporting = true;
  state.player.teleportStartTime = Date.now();
  state.player.vel = new Vector2(0, 0);
  state.player.onSurface = false;
}
function exitMazeMode() {
  state.inMaze = false;
  state.player.inMaze = false;
  if (state.mazePlanet) {
    const surfaceDist = state.mazePlanet.radius + PLAYER_RADIUS;
    state.player.pos.x = state.mazePlanet.pos.x + Math.cos(state.mazePlanet.beamAngle) * surfaceDist;
    state.player.pos.y = state.mazePlanet.pos.y + Math.sin(state.mazePlanet.beamAngle) * surfaceDist;
    state.player.angle = state.mazePlanet.beamAngle;
    state.player.onSurface = true;
    state.player.currentPlanet = state.mazePlanet;
    state.player.lastInfluencePlanet = state.mazePlanet;
  }
}
function checkMazeDots() {
  if (!state.inMaze) return;
  for (let i = state.mazeDots.length - 1; i >= 0; i--) {
    const d = state.mazeDots[i];
    if (d.x === state.player.mazeCol && d.y === state.player.mazeRow) {
      playEatDot();
      state.mazeDots.splice(i, 1);
      state.score += 10;
    }
  }
  for (let i = state.powerPellets.length - 1; i >= 0; i--) {
    const p = state.powerPellets[i];
    if (p.x === state.player.mazeCol && p.y === state.player.mazeRow) {
      playEatDot();
      state.powerPellets.splice(i, 1);
      state.score += 50;
    }
  }
}
function createParticles(atPos, count) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = Math.random() * 4 + 2;
    const vel = new Vector2(Math.cos(angle) * speed, Math.sin(angle) * speed);
    state.particles.push(new Particle(atPos, vel));
  }
}
function createDeathParticles(atPos, count = 30) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = Math.random() * 6 + 3;
    const vel = new Vector2(Math.cos(angle) * speed, Math.sin(angle) * speed);
    const particle = new Particle(atPos, vel);
    particle.color = `hsl(${Math.random() * 60 + 20}, 100%, 50%)`;
    state.particles.push(particle);
  }
}
function initResizeListener() {
  window.addEventListener("resize", () => {
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

// js/player.js
var Player = class {
  constructor(x, y) {
    this.pos = new Vector2(x, y);
    this.vel = new Vector2(0, 0);
    this.radius = PLAYER_RADIUS;
    this.onSurface = false;
    this.currentPlanet = null;
    this.lastInfluencePlanet = null;
    this.angle = 0;
    this.mouthAngle = 0;
    this.facingDirection = 1;
    this.isGroundPounding = false;
    this.inMaze = false;
    this.mazeCol = 14;
    this.mazeRow = 15;
    this.mazeDir = new Vector2(1, 0);
    this.lastMoveTime = 0;
    this.isTeleporting = false;
    this.teleportStartTime = 0;
    this.teleportDuration = 900;
    this.teleportScale = 1;
    this.teleportGlow = 0;
    this.isDying = false;
    this.deathStartTime = 0;
    this.deathDuration = 1200;
    this.deathScale = 1;
    this.deathRotation = 0;
    this.deathAlpha = 1;
  }
  startDeath() {
    if (this.isDying == false) {
      this.isDying = true;
      this.deathStartTime = Date.now();
      this.deathScale = 1;
      this.deathRotation = 0;
      this.deathAlpha = 1;
      createDeathParticles(this.pos, 400);
      playDeath();
    }
  }
  findDominantPlanet(planets) {
    let closest = null, minDist = Infinity;
    for (const planet of planets) {
      const dist = this.pos.subtract(planet.pos).length();
      if (dist < planet.influenceRadius && dist < minDist) {
        minDist = dist;
        closest = planet;
      }
    }
    return closest;
  }
  applyGravity(planets) {
    if (this.onSurface) return;
    let planet = this.findDominantPlanet(planets);
    if (!planet && this.lastInfluencePlanet) planet = this.lastInfluencePlanet;
    if (planet) {
      this.lastInfluencePlanet = planet;
      const direction = planet.pos.subtract(this.pos).normalize();
      let grav = GRAVITY_STRENGTH;
      if (this.isGroundPounding) grav *= GROUND_POUND_GRAV_MULTIPLIER;
      this.vel.add(direction.multiply(grav));
    }
  }
  checkCollision(planets) {
    for (const planet of planets.filter((p) => p.isSpikey)) {
      const dist = this.pos.subtract(planet.pos).length();
      if (dist <= planet.radius + this.radius + SURFACE_TOLERANCE) {
        this.startDeath();
        return;
      }
    }
    if (this.onSurface) return;
    for (const planet of planets.filter((p) => !p.isSpikey)) {
      const offset = this.pos.subtract(planet.pos);
      const dist = offset.length();
      const surfaceDist = planet.radius + this.radius;
      if (dist <= surfaceDist + SURFACE_TOLERANCE) {
        const normal = offset.normalize();
        this.pos = planet.pos.clone().add(normal.multiply(surfaceDist));
        this.onSurface = true;
        this.currentPlanet = planet;
        this.lastInfluencePlanet = planet;
        const impactVel = this.vel.clone();
        this.vel.x = 0;
        this.vel.y = 0;
        this.angle = Math.atan2(this.pos.y - planet.pos.y, this.pos.x - planet.pos.x);
        if (this.isGroundPounding) {
          this.isGroundPounding = false;
          const pushDir = normal.multiply(-1);
          planet.vel.add(pushDir.multiply(impactVel.length() * GROUND_POUND_PUSH_STRENGTH));
          createParticles(this.pos, 20);
        }
        return;
      }
    }
    this.onSurface = false;
    this.currentPlanet = null;
  }
  move(keys) {
    if (this.inMaze) {
      const now = Date.now();
      if (now - this.lastMoveTime < 110) return;
      let dx = 0, dy = 0;
      if (keys["ArrowLeft"]) dx = -1;
      if (keys["ArrowRight"]) dx = 1;
      if (keys["ArrowUp"]) dy = -1;
      if (keys["ArrowDown"]) dy = 1;
      if (dx !== 0 || dy !== 0) {
        const newCol = this.mazeCol + dx;
        const newRow = this.mazeRow + dy;
        if (dy === -1 && this.mazeRow === MAZE_EXIT_ROW && (this.mazeCol === MAZE_EXIT_COL_LEFT || this.mazeCol === MAZE_EXIT_COL_RIGHT)) {
          startTeleportFromMaze();
          return;
        }
        if (!isWall(newCol, newRow)) {
          this.mazeCol = newCol;
          this.mazeRow = newRow;
          this.mazeDir = new Vector2(dx || this.mazeDir.x, dy || this.mazeDir.y).normalize();
          this.lastMoveTime = now;
          updatePlayerMazePosition();
        }
      }
      return;
    }
    if (this.onSurface && this.currentPlanet) {
      const surfaceDist = this.currentPlanet.radius + this.radius;
      const angularSpeed = PLAYER_LINEAR_SPEED / surfaceDist;
      if (keys["ArrowLeft"]) {
        this.angle -= angularSpeed;
        this.facingDirection = -1;
      }
      if (keys["ArrowRight"]) {
        this.angle += angularSpeed;
        this.facingDirection = 1;
      }
      this.pos.x = this.currentPlanet.pos.x + Math.cos(this.angle) * surfaceDist;
      this.pos.y = this.currentPlanet.pos.y + Math.sin(this.angle) * surfaceDist;
    }
  }
  jump() {
    if (this.onSurface && this.currentPlanet) {
      const direction = this.pos.subtract(this.currentPlanet.pos).normalize();
      this.vel = direction.multiply(JUMP_STRENGTH);
      this.onSurface = false;
      this.currentPlanet = null;
      playJump();
    }
  }
  tryGroundPound() {
    if (this.isGroundPounding) return;
    let planet = this.findDominantPlanet(state.planetoids) || this.lastInfluencePlanet;
    if (planet) {
      const outwardDir = this.pos.subtract(planet.pos).normalize();
      const radialVel = this.vel.dot(outwardDir);
      if (radialVel > 0) {
        this.isGroundPounding = true;
      }
    }
  }
  update() {
    if (this.isDying) {
      const elapsed = Date.now() - this.deathStartTime;
      const t = Math.min(elapsed / this.deathDuration, 1);
      this.deathScale = 1 - t * t * t;
      this.deathRotation += 0.2;
      this.deathAlpha = 1 - t;
      if (t >= 1) {
        state.gameOver = true;
      }
      return;
    }
    if (this.isTeleporting) {
      const elapsed = Date.now() - this.teleportStartTime;
      const t = elapsed / this.teleportDuration;
      if (t >= 1) {
        this.isTeleporting = false;
        if (this.inMaze) {
          exitMazeMode();
        } else {
          enterMazeMode();
        }
        return;
      }
      const pulse = Math.sin(t * Math.PI);
      this.teleportScale = 1 + pulse * 1.2;
      this.teleportGlow = pulse;
      if (Math.random() < 0.6) {
        const beamDir = new Vector2(
          Math.cos(state.mazePlanet.beamAngle),
          Math.sin(state.mazePlanet.beamAngle)
        );
        const side = new Vector2(
          -beamDir.y,
          beamDir.x
        ).multiply((Math.random() - 0.5) * 1.5);
        const speed = 2 + Math.random() * 2;
        const vel = beamDir.multiply(speed).add(side);
        state.particles.push(new Particle(this.pos.clone(), vel));
      }
      return;
    }
    if (this.inMaze) {
      this.vel = new Vector2(0, 0);
      this.mouthAngle = Math.sin(Date.now() * 0.01) * (Math.PI / 4);
      return;
    }
    if (!this.onSurface) {
      this.vel = this.vel.multiply(DRAG);
      this.pos.add(this.vel);
      if (this.pos.x - this.radius < 0) {
        this.pos.x = this.radius;
        this.vel.x = -this.vel.x;
      }
      if (this.pos.x + this.radius > state.sceneWidth) {
        this.pos.x = state.sceneWidth - this.radius;
        this.vel.x = -this.vel.x;
      }
      if (this.pos.y - this.radius < 0) {
        this.pos.y = this.radius;
        this.vel.y = -this.vel.y;
      }
      if (this.pos.y + this.radius > state.sceneHeight) {
        this.pos.y = state.sceneHeight - this.radius;
        this.vel.y = -this.vel.y;
      }
    }
    this.mouthAngle = Math.sin(Date.now() * 0.01) * (Math.PI / 4);
  }
  draw() {
    const ctx = state.ctx;
    let scale = 1;
    let glow = 0;
    let rotationOffset = 0;
    if (this.isDying) {
      ctx.save();
      ctx.globalAlpha = this.deathAlpha;
      ctx.translate(this.pos.x, this.pos.y);
      ctx.rotate(this.deathRotation);
      ctx.scale(this.deathScale, this.deathScale);
      ctx.shadowColor = "orange";
      ctx.shadowBlur = 30 * (this.deathAlpha * 0.5);
      const mouthAngle2 = 0;
      ctx.beginPath();
      ctx.arc(0, 0, this.radius, mouthAngle2 / 2, 2 * Math.PI - mouthAngle2 / 2);
      ctx.lineTo(0, 0);
      ctx.fillStyle = "#ff6600";
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.restore();
      return;
    }
    if (this.isTeleporting) {
      scale = this.teleportScale;
      glow = this.teleportGlow;
    }
    if (this.inMaze) {
      const mazeScale = 0.4;
      ctx.save();
      ctx.translate(this.pos.x, this.pos.y);
      if (this.isTeleporting) {
        ctx.shadowColor = "yellow";
        ctx.shadowBlur = 40 * glow;
      }
      const rot = Math.atan2(this.mazeDir.y, this.mazeDir.x);
      ctx.rotate(rot);
      ctx.scale(scale * mazeScale, scale * mazeScale);
      const mouthAngle2 = Math.sin(Date.now() * 0.01) * (Math.PI / 4);
      ctx.beginPath();
      ctx.arc(
        0,
        0,
        this.radius,
        mouthAngle2 / 2,
        2 * Math.PI - mouthAngle2 / 2
      );
      ctx.lineTo(0, 0);
      ctx.fillStyle = "yellow";
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.restore();
      return;
    }
    let planet = this.onSurface ? this.currentPlanet : this.lastInfluencePlanet;
    let downDir = new Vector2(0, 1);
    if (planet) {
      downDir = planet.pos.subtract(this.pos).normalize();
    }
    const downAngle = Math.atan2(downDir.y, downDir.x);
    const rotation = downAngle - Math.PI / 2;
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(rotation);
    if (this.facingDirection < 0) {
      ctx.rotate(Math.PI);
    }
    if (this.isTeleporting) {
      ctx.shadowColor = "yellow";
      ctx.shadowBlur = 40 * glow;
    }
    ctx.scale(scale, scale);
    const mouthAngle = Math.sin(Date.now() * 0.01) * (Math.PI / 4);
    ctx.beginPath();
    ctx.arc(
      0,
      0,
      this.radius,
      mouthAngle / 2,
      2 * Math.PI - mouthAngle / 2
    );
    ctx.lineTo(0, 0);
    ctx.fillStyle = "yellow";
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();
  }
};

// js/enemy.js
var Enemy = class {
  constructor(planet, color) {
    this.planet = planet;
    this.angularSpeed = (Math.random() > 0.5 ? 1 : -1) * 0.02;
    this.angle = Math.random() * Math.PI * 2;
    this.radius = ENEMY_RADIUS;
    this.pos = new Vector2();
    this.onSurface = true;
    this.color = color;
    this.lastInfluencePlanet = planet;
    this.wavePhase = Math.random() * Math.PI * 2;
    this.updatePosition();
  }
  updatePosition() {
    const surfaceDist = this.planet.radius + this.radius;
    this.pos.x = this.planet.pos.x + Math.cos(this.angle) * surfaceDist;
    this.pos.y = this.planet.pos.y + Math.sin(this.angle) * surfaceDist;
  }
  update(planets) {
    this.wavePhase += 0.15;
    if (this.onSurface) {
      this.angle += this.angularSpeed;
      this.updatePosition();
      if (Math.random() < ENEMY_JUMP_PROB) {
        for (const p of planets) {
          if (p !== this.planet && !p.isSpikey) {
            const dist = this.pos.subtract(p.pos).length();
            if (dist < p.influenceRadius) {
              const direction = this.pos.subtract(this.planet.pos).normalize();
              this.vel = direction.multiply(JUMP_STRENGTH);
              this.onSurface = false;
              this.planet = p;
              break;
            }
          }
        }
      }
    }
    if (!this.onSurface) {
      if (!this.vel) this.vel = new Vector2();
      let dominant = this.findDominantPlanet(planets);
      if (dominant) {
        this.lastInfluencePlanet = dominant;
        const dir = dominant.pos.subtract(this.pos).normalize();
        this.vel.add(dir.multiply(GRAVITY_STRENGTH));
      }
      this.vel = this.vel.multiply(DRAG);
      this.pos.add(this.vel);
      if (this.pos.x - this.radius < 0) {
        this.pos.x = this.radius;
        this.vel.x = -this.vel.x;
      }
      if (this.pos.x + this.radius > state.sceneWidth) {
        this.pos.x = state.sceneWidth - this.radius;
        this.vel.x = -this.vel.x;
      }
      if (this.pos.y - this.radius < 0) {
        this.pos.y = this.radius;
        this.vel.y = -this.vel.y;
      }
      if (this.pos.y + this.radius > state.sceneHeight) {
        this.pos.y = state.sceneHeight - this.radius;
        this.vel.y = -this.vel.y;
      }
      if (dominant) {
        const offset = this.pos.subtract(dominant.pos);
        const dist = offset.length();
        if (dist <= dominant.radius + this.radius + SURFACE_TOLERANCE) {
          if (!dominant.isSpikey) {
            const normal = offset.normalize();
            this.pos = dominant.pos.clone().add(
              normal.multiply(dominant.radius + this.radius)
            );
            this.onSurface = true;
            this.angle = Math.atan2(
              this.pos.y - dominant.pos.y,
              this.pos.x - dominant.pos.x
            );
            this.planet = dominant;
            this.vel = new Vector2();
          } else {
            const normal = offset.normalize();
            const dot = this.vel.dot(normal);
            this.vel.subtract(normal.multiply(2 * dot));
            this.pos.add(
              normal.multiply(
                dominant.radius + this.radius + SURFACE_TOLERANCE - dist
              )
            );
          }
        }
      }
    }
  }
  findDominantPlanet(planets) {
    let closest = null;
    let minDist = Infinity;
    for (const planet of planets) {
      const dist = this.pos.subtract(planet.pos).length();
      if (dist < planet.influenceRadius && dist < minDist) {
        minDist = dist;
        closest = planet;
      }
    }
    return closest;
  }
  draw() {
    const ctx = state.ctx;
    let planet = this.onSurface ? this.planet : this.lastInfluencePlanet;
    let downDir = new Vector2(0, 1);
    if (planet) {
      downDir = planet.pos.subtract(this.pos).normalize();
    }
    const downAngle = Math.atan2(downDir.y, downDir.x);
    const rotation = downAngle - Math.PI / 2;
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(rotation);
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(0, 0, this.radius, Math.PI, 0, false);
    const spikeCount = 4;
    const width = this.radius * 2.1;
    const step = width / spikeCount;
    for (let i = 0; i < spikeCount; i++) {
      const left = this.radius - i * step;
      const right = this.radius - (i + 1) * step;
      const mid = (left + right) / 2;
      const wave = Math.sin(this.wavePhase + i) * (this.radius * 0.2);
      ctx.lineTo(left, this.radius);
      ctx.lineTo(mid, this.radius + this.radius * 0.25 + wave);
      ctx.lineTo(right, this.radius);
    }
    ctx.closePath();
    ctx.fill();
    let pupilOffsetX = 0;
    let pupilOffsetY = 0;
    const pupilMove = this.radius * 0.12;
    if (this.onSurface) {
      if (this.angularSpeed > 0) {
        pupilOffsetX = pupilMove;
      } else {
        pupilOffsetX = -pupilMove;
      }
    } else if (this.vel) {
      if (Math.abs(this.vel.x) > Math.abs(this.vel.y)) {
        pupilOffsetX = this.vel.x > 0 ? pupilMove : -pupilMove;
      } else {
        pupilOffsetY = this.vel.y > 0 ? pupilMove : -pupilMove;
      }
    }
    ctx.fillStyle = "white";
    const leftEyeX = -this.radius / 3;
    const rightEyeX = this.radius / 3;
    const eyeY = -this.radius / 3;
    const eyeRadius = this.radius / 4;
    ctx.beginPath();
    ctx.arc(leftEyeX, eyeY, eyeRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(rightEyeX, eyeY, eyeRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "black";
    const pupilRadius = this.radius / 8;
    ctx.beginPath();
    ctx.arc(leftEyeX + pupilOffsetX, eyeY + pupilOffsetY, pupilRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(rightEyeX + pupilOffsetX, eyeY + pupilOffsetY, pupilRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
};

// js/coin.js
var Coin = class {
  constructor(planet) {
    this.planet = planet;
    this.angularSpeed = (Math.random() - 0.5) * 0.04;
    this.angle = 0;
    this.radius = COIN_RADIUS;
    this.orbitRadius = planet.radius + COIN_ORBIT_OFFSET;
    this.pos = new Vector2();
    this.updatePosition();
  }
  updatePosition() {
    this.pos.x = this.planet.pos.x + Math.cos(this.angle) * this.orbitRadius;
    this.pos.y = this.planet.pos.y + Math.sin(this.angle) * this.orbitRadius;
  }
  update() {
    this.angle += this.angularSpeed;
    this.updatePosition();
  }
  draw() {
    const ctx = state.ctx;
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, this.radius, 0, Math.PI * 2);
    ctx.fillStyle = "gold";
    ctx.fill();
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(Date.now() * 0.01);
    ctx.beginPath();
    ctx.arc(-this.radius * 0.4, -this.radius * 0.4, this.radius * 0.4, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.fill();
    ctx.restore();
  }
};

// js/mazeghost.js
var MazeGhost = class {
  constructor(col, row, color) {
    this.mazeCol = col;
    this.mazeRow = row;
    this.color = color;
    this.radius = 10;
    this.dir = new Vector2(1, 0);
    this.lastMoveTime = Date.now();
  }
  update() {
    const now = Date.now();
    if (now - this.lastMoveTime < 110) return;
    this.lastMoveTime = now;
    const dirs = [
      new Vector2(1, 0),
      // right
      new Vector2(0, 1),
      // down
      new Vector2(-1, 0),
      // left
      new Vector2(0, -1)
      // up
    ];
    let possible = [];
    for (let d of dirs) {
      let testCol = this.mazeCol + d.x;
      if (testCol < 0) testCol = MAZE_COLS - 1;
      if (testCol >= MAZE_COLS) testCol = 0;
      let testRow = this.mazeRow + d.y;
      const isReverse = d.x === -this.dir.x && d.y === -this.dir.y;
      if (!isWall(testCol, testRow) && !isReverse) {
        possible.push(d.clone());
      }
    }
    if (possible.length === 0) {
      for (let d of dirs) {
        let testCol = this.mazeCol + d.x;
        if (testCol < 0) testCol = MAZE_COLS - 1;
        if (testCol >= MAZE_COLS) testCol = 0;
        let testRow = this.mazeRow + d.y;
        if (!isWall(testCol, testRow)) {
          possible.push(d.clone());
        }
      }
    }
    const straightOpen = possible.some((d) => d.x === this.dir.x && d.y === this.dir.y);
    if (straightOpen && Math.random() < 0.8) {
    } else {
      this.dir = possible[Math.floor(Math.random() * possible.length)];
    }
    let newCol = this.mazeCol + this.dir.x;
    let newRow = this.mazeRow + this.dir.y;
    if (newCol < 0) newCol = MAZE_COLS - 1;
    if (newCol >= MAZE_COLS) newCol = 0;
    this.mazeCol = newCol;
    this.mazeRow = newRow;
  }
  draw() {
    const ctx = state.ctx;
    const offsetX = state.mazePlanet.pos.x - MAZE_COLS * MAZE_TILE_SIZE / 2;
    const offsetY = state.mazePlanet.pos.y - MAZE_ROWS * MAZE_TILE_SIZE / 2;
    const x = offsetX + this.mazeCol * MAZE_TILE_SIZE + MAZE_TILE_SIZE / 2;
    const y = offsetY + this.mazeRow * MAZE_TILE_SIZE + MAZE_TILE_SIZE / 2;
    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(0, 0, this.radius, Math.PI, 0, false);
    ctx.lineTo(this.radius, this.radius);
    ctx.lineTo(this.radius / 3, this.radius / 2);
    ctx.lineTo(-this.radius / 3, this.radius / 2);
    ctx.lineTo(-this.radius, this.radius);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "white";
    ctx.beginPath();
    ctx.arc(-this.radius / 3, -this.radius / 3, this.radius / 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(this.radius / 3, -this.radius / 3, this.radius / 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "black";
    ctx.beginPath();
    ctx.arc(-this.radius / 3, -this.radius / 3, this.radius / 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(this.radius / 3, -this.radius / 3, this.radius / 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();
  }
};

// js/game.js
state.canvas = document.getElementById("gameCanvas");
state.ctx = state.canvas.getContext("2d");
state.canvas.width = window.innerWidth;
state.canvas.height = window.innerHeight;
state.sceneWidth = state.canvas.width * 2;
state.sceneHeight = state.canvas.height * 2;
state.planetTexture = new Image();
state.planetTexture.src = "img/planet_texture_2.jpg";
state.planetTexture.onload = () => {
  initGame();
  gameLoop();
};
initAudio();
initResizeListener();
state.stars = [];
for (let i = 0; i < STAR_COUNT; i++) {
  state.stars.push({
    x: Math.random() * state.sceneWidth,
    y: Math.random() * state.sceneHeight,
    size: Math.random() * 2 + 1
  });
}
window.addEventListener("keydown", (e) => {
  state.keys[e.key] = true;
  if (e.key === " ") {
    if (state.player.onSurface && !state.player.inMaze) state.player.jump();
    else if (!state.player.inMaze) state.player.tryGroundPound();
  }
  if (e.key === "ArrowDown" && !state.player.inMaze) {
    if (state.player.onSurface && state.player.currentPlanet === state.mazePlanet) {
      const diff = Math.abs((state.player.angle - state.mazePlanet.beamAngle + Math.PI) % (2 * Math.PI) - Math.PI);
      if (diff < Math.PI / 5) {
        startTeleportToMaze();
      }
    }
  }
  if (e.key === "Enter") {
    if (state.gameOver) {
      state.score = 0;
      state.level = 1;
      initGame();
    } else if (state.levelComplete) {
      state.level++;
      initGame();
      state.levelComplete = false;
    }
  }
});
window.addEventListener("keyup", (e) => {
  state.keys[e.key] = false;
});
function initGame() {
  state.starCanvas = document.createElement("canvas");
  state.starCanvas.width = state.sceneWidth;
  state.starCanvas.height = state.sceneHeight;
  const starCtx = state.starCanvas.getContext("2d");
  starCtx.fillStyle = "white";
  state.stars.forEach((star) => {
    starCtx.beginPath();
    starCtx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
    starCtx.fill();
  });
  state.planetoids = [];
  for (let i = 0; i < 44; i++) {
    const radius = 30 + Math.random() * 40;
    const x = radius + Math.random() * (state.sceneWidth - 2 * radius);
    const y = radius + Math.random() * (state.sceneHeight - 2 * radius);
    const color = planetColors[Math.floor(Math.random() * planetColors.length)];
    state.planetoids.push(new Planetoid(x, y, radius, color));
  }
  for (let i = 0; i < 16; i++) {
    const radius = 25 + Math.random() * 15;
    const x = radius + Math.random() * (state.sceneWidth - 2 * radius);
    const y = radius + Math.random() * (state.sceneHeight - 2 * radius);
    state.planetoids.push(new SpikeyPlanetoid(x, y, radius));
  }
  buildMazeData();
  state.mazePlanet = new MazePlanetoid(state.sceneWidth * 0.55, state.sceneHeight * 0.45, 250);
  state.planetoids.push(state.mazePlanet);
  let pos1 = getRandomPelletMazePos();
  let pos2 = getRandomPelletMazePos();
  while (pos2.col === pos1.col && pos2.row === pos1.row) {
    pos2 = getRandomPelletMazePos();
  }
  state.mazeGhosts = [
    new MazeGhost(pos1.col, pos1.row, "red"),
    new MazeGhost(pos2.col, pos2.row, "pink")
  ];
  state.asteroids = [];
  for (let i = 0; i < 24; i++) {
    const radius = 20 + Math.random() * 25;
    const x = radius + Math.random() * (state.sceneWidth - 2 * radius);
    const y = radius + Math.random() * (state.sceneHeight - 2 * radius);
    state.asteroids.push(new Asteroid(x, y, radius));
  }
  const regularPlanets = state.planetoids.filter((p) => !p.isSpikey && p !== state.mazePlanet);
  const startingPlanet = regularPlanets[Math.floor(Math.random() * regularPlanets.length)];
  const surfaceDist = startingPlanet.radius + PLAYER_RADIUS;
  state.player = new Player(startingPlanet.pos.x, startingPlanet.pos.y - surfaceDist);
  state.player.onSurface = true;
  state.player.currentPlanet = startingPlanet;
  state.player.lastInfluencePlanet = startingPlanet;
  state.player.angle = Math.atan2(state.player.pos.y - startingPlanet.pos.y, state.player.pos.x - startingPlanet.pos.x);
  state.enemies = [];
  const numEnemies = (2 + state.level) * 2;
  for (let i = 0; i < numEnemies; i++) {
    let planetIndex = Math.floor(Math.random() * regularPlanets.length);
    let selectedPlanet = regularPlanets[planetIndex];
    while (selectedPlanet === startingPlanet) {
      planetIndex = Math.floor(Math.random() * regularPlanets.length);
      selectedPlanet = regularPlanets[planetIndex];
    }
    const color = enemyColors[i % enemyColors.length];
    state.enemies.push(new Enemy(selectedPlanet, color));
  }
  for (let a of state.asteroids) {
    let dist = a.pos.subtract(state.player.pos).length();
    while (dist < 200) {
      a.pos.x = a.radius + Math.random() * (state.sceneWidth - 2 * a.radius);
      a.pos.y = a.radius + Math.random() * (state.sceneHeight - 2 * a.radius);
      dist = a.pos.subtract(state.player.pos).length();
    }
  }
  state.coins = [];
  regularPlanets.forEach((planet) => {
    const numCoins = 4 + Math.floor(planet.radius / 10);
    for (let i = 0; i < numCoins; i++) {
      const coin = new Coin(planet);
      coin.angle = i / numCoins * Math.PI * 2 + Math.random() * 0.2;
      state.coins.push(coin);
    }
  });
  state.planetoids.forEach((p) => p.createOffscreen());
  state.particles = [];
  state.gameOver = false;
  state.levelComplete = false;
  state.inMaze = false;
  state.eatDotIndex = 0;
}
function updatePlanetoids() {
  for (const p of state.planetoids) {
    p.pos.add(p.vel);
    if (p.pos.x - p.radius < 0) {
      p.pos.x = p.radius;
      p.vel.x = -p.vel.x;
    }
    if (p.pos.x + p.radius > state.sceneWidth) {
      p.pos.x = state.sceneWidth - p.radius;
      p.vel.x = -p.vel.x;
    }
    if (p.pos.y - p.radius < 0) {
      p.pos.y = p.radius;
      p.vel.y = -p.vel.y;
    }
    if (p.pos.y + p.radius > state.sceneHeight) {
      p.pos.y = state.sceneHeight - p.radius;
      p.vel.y = -p.vel.y;
    }
  }
}
function updateAsteroids() {
  for (const a of state.asteroids) {
    a.update();
  }
}
function handleCollisions() {
  for (let i = 0; i < state.planetoids.length; i++) {
    for (let j = i + 1; j < state.planetoids.length; j++) {
      const p1 = state.planetoids[i], p2 = state.planetoids[j];
      const offset = p1.pos.subtract(p2.pos);
      const distSq = offset.x * offset.x + offset.y * offset.y;
      const sumR = p1.radius + p2.radius;
      const sumRSq = sumR * sumR;
      if (distSq < sumRSq) {
        const dist = Math.sqrt(distSq);
        const overlap = sumR - dist;
        const normal = offset.normalize();
        const tangent = new Vector2(-normal.y, normal.x);
        const m1 = p1.mass, m2 = p2.mass, totalMass = m1 + m2;
        const sep1 = overlap * (m2 / totalMass), sep2 = overlap * (m1 / totalMass);
        p1.pos.add(normal.multiply(sep1));
        p2.pos.add(normal.multiply(-sep2));
        const v1 = p1.vel.clone(), v2 = p2.vel.clone();
        const v1n = normal.dot(v1), v2n = normal.dot(v2);
        const v1t = tangent.dot(v1), v2t = tangent.dot(v2);
        const new_v1n = (v1n * (m1 - m2) + 2 * m2 * v2n) / totalMass;
        const new_v2n = (v2n * (m2 - m1) + 2 * m1 * v1n) / totalMass;
        p1.vel = normal.multiply(new_v1n).add(tangent.multiply(v1t));
        p2.vel = normal.multiply(new_v2n).add(tangent.multiply(v2t));
      }
    }
  }
  for (let i = 0; i < state.asteroids.length; i++) {
    for (let j = i + 1; j < state.asteroids.length; j++) {
      const p1 = state.asteroids[i], p2 = state.asteroids[j];
      const offset = p1.pos.subtract(p2.pos);
      const distSq = offset.x * offset.x + offset.y * offset.y;
      const sumR = p1.radius + p2.radius;
      const sumRSq = sumR * sumR;
      if (distSq < sumRSq) {
        const dist = Math.sqrt(distSq);
        const overlap = sumR - dist;
        const normal = offset.normalize();
        const tangent = new Vector2(-normal.y, normal.x);
        const m1 = p1.mass, m2 = p2.mass, totalMass = m1 + m2;
        const sep1 = overlap * (m2 / totalMass), sep2 = overlap * (m1 / totalMass);
        p1.pos.add(normal.multiply(sep1));
        p2.pos.add(normal.multiply(-sep2));
        const v1 = p1.vel.clone(), v2 = p2.vel.clone();
        const v1n = normal.dot(v1), v2n = normal.dot(v2);
        const v1t = tangent.dot(v1), v2t = tangent.dot(v2);
        const new_v1n = (v1n * (m1 - m2) + 2 * m2 * v2n) / totalMass;
        const new_v2n = (v2n * (m2 - m1) + 2 * m1 * v1n) / totalMass;
        p1.vel = normal.multiply(new_v1n).add(tangent.multiply(v1t));
        p2.vel = normal.multiply(new_v2n).add(tangent.multiply(v2t));
      }
    }
  }
  let toBreak = /* @__PURE__ */ new Set();
  for (let p of state.planetoids) {
    for (let a of state.asteroids) {
      const offset = p.pos.subtract(a.pos);
      const distSq = offset.x * offset.x + offset.y * offset.y;
      const sumR = p.radius + a.radius;
      const sumRSq = sumR * sumR;
      if (distSq < sumRSq) {
        const dist = Math.sqrt(distSq);
        const overlap = sumR - dist;
        const normal = offset.normalize();
        const tangent = new Vector2(-normal.y, normal.x);
        const m1 = p.mass, m2 = a.mass, totalMass = m1 + m2;
        const sep1 = overlap * (m2 / totalMass), sep2 = overlap * (m1 / totalMass);
        p.pos.add(normal.multiply(sep1));
        a.pos.add(normal.multiply(-sep2));
        const v1 = p.vel.clone(), v2 = a.vel.clone();
        const v1n = normal.dot(v1), v2n = normal.dot(v2);
        const v1t = tangent.dot(v1), v2t = tangent.dot(v2);
        const new_v1n = (v1n * (m1 - m2) + 2 * m2 * v2n) / totalMass;
        const new_v2n = (v2n * (m2 - m1) + 2 * m1 * v1n) / totalMass;
        p.vel = normal.multiply(new_v1n).add(tangent.multiply(v1t));
        a.vel = normal.multiply(new_v2n).add(tangent.multiply(v2t));
        toBreak.add(a);
      }
    }
  }
  for (let a of toBreak) {
    breakAsteroid(a);
  }
}
function breakAsteroid(ast) {
  const index = state.asteroids.indexOf(ast);
  if (index > -1) {
    state.asteroids.splice(index, 1);
  }
  let size;
  if (ast.radius > 30) size = "large";
  else if (ast.radius > 20) size = "medium";
  else size = "small";
  playBang(size, ast.pos);
  createParticles(ast.pos, 150);
  if (ast.radius < 15) return;
  const numSmall = ast.radius > 30 ? 3 : 2;
  for (let i = 0; i < numSmall; i++) {
    const smallR = ast.radius / 2;
    const small = new Asteroid(ast.pos.x, ast.pos.y, smallR);
    const randVel = new Vector2(Math.random() * 2 - 1, Math.random() * 2 - 1).normalize().multiply(2 + Math.random() * 3);
    small.vel = ast.vel.clone().add(randVel);
    small.angle = Math.random() * Math.PI * 2;
    small.angularSpeed = (Math.random() * 2 - 1) * 0.1;
    state.asteroids.push(small);
  }
  createParticles(ast.pos, 10);
}
function checkCoinCollisions() {
  for (let i = state.coins.length - 1; i >= 0; i--) {
    const coin = state.coins[i];
    const dist = state.player.pos.subtract(coin.pos).length();
    if (dist <= PLAYER_RADIUS + COIN_RADIUS) {
      playEatDot();
      state.coins.splice(i, 1);
      state.score++;
    }
  }
}
function checkPlayerEnemyCollisions() {
  for (const enemy of state.enemies) {
    const dist = state.player.pos.subtract(enemy.pos).length();
    if (dist <= PLAYER_RADIUS + ENEMY_RADIUS) {
      state.player.startDeath();
      return;
    }
  }
}
function checkPlayerAsteroidCollisions() {
  for (const a of state.asteroids) {
    const dist = state.player.pos.subtract(a.pos).length();
    if (dist <= PLAYER_RADIUS + a.radius) {
      state.player.startDeath();
      return;
    }
  }
}
function gameLoop(timestamp) {
  if (state.lastFrameTime) {
    const delta = timestamp - state.lastFrameTime;
    let instant = 1e3 / delta;
    state.fps = state.fps * 0.9 + instant * 0.1;
  }
  state.lastFrameTime = timestamp;
  state.ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
  if (state.gameOver) {
    state.ctx.fillStyle = "white";
    state.ctx.font = "48px Arial";
    state.ctx.textAlign = "center";
    state.ctx.fillText("Game Over", state.canvas.width / 2, state.canvas.height / 2 - 20);
    state.ctx.font = "32px Arial";
    state.ctx.fillText(`Final Score: ${state.score}`, state.canvas.width / 2, state.canvas.height / 2 + 30);
    state.ctx.font = "24px Arial";
    state.ctx.fillText("Press Enter to Restart", state.canvas.width / 2, state.canvas.height / 2 + 70);
    state.player.isDying = "false";
    requestAnimationFrame(gameLoop);
    return;
  } else if (state.levelComplete) {
    state.ctx.fillStyle = "white";
    state.ctx.font = "48px Arial";
    state.ctx.textAlign = "center";
    state.ctx.fillText("You beat the level!", state.canvas.width / 2, state.canvas.height / 2 - 20);
    state.ctx.font = "32px Arial";
    state.ctx.fillText(`Score: ${state.score}`, state.canvas.width / 2, state.canvas.height / 2 + 30);
    state.ctx.font = "24px Arial";
    state.ctx.fillText("Press Enter to start next level", state.canvas.width / 2, state.canvas.height / 2 + 70);
    requestAnimationFrame(gameLoop);
    return;
  }
  updatePlanetoids();
  if (state.inMaze) updatePlayerMazePosition();
  updateAsteroids();
  handleCollisions();
  if (!state.player.isDying) {
    state.player.move(state.keys);
    if (!state.player.inMaze) state.player.applyGravity(state.planetoids);
    state.player.update();
    if (!state.player.inMaze) state.player.checkCollision(state.planetoids);
  } else {
    state.player.update();
  }
  state.enemies.forEach((e) => e.update(state.planetoids));
  state.mazeGhosts.forEach((g) => g.update());
  state.coins.forEach((c) => c.update());
  state.particles.forEach((p) => p.update());
  state.particles = state.particles.filter((p) => p.life > 0);
  checkCoinCollisions();
  checkPlayerEnemyCollisions();
  checkPlayerAsteroidCollisions();
  checkMazeDots();
  if (state.inMaze) {
    for (let i = 0; i < state.mazeGhosts.length; i++) {
      const g = state.mazeGhosts[i];
      if (g.mazeCol === state.player.mazeCol && g.mazeRow === state.player.mazeRow) {
        state.player.startDeath();
        break;
      }
    }
  }
  if (state.coins.length === 0 && !state.player.inMaze) {
    state.levelComplete = true;
  }
  const camera = new Vector2();
  camera.x = state.player.pos.x - state.canvas.width / 2;
  camera.y = state.player.pos.y - state.canvas.height / 2;
  if (camera.x < 0) camera.x = 0;
  if (camera.y < 0) camera.y = 0;
  if (camera.x > state.sceneWidth - state.canvas.width) camera.x = state.sceneWidth - state.canvas.width;
  if (camera.y > state.sceneHeight - state.canvas.height) camera.y = state.sceneHeight - state.canvas.height;
  state.ctx.save();
  state.ctx.translate(-camera.x, -camera.y);
  state.ctx.drawImage(state.starCanvas, 0, 0);
  state.planetoids.forEach((p) => p.draw());
  state.asteroids.forEach((a) => a.draw());
  state.player.draw();
  state.enemies.forEach((e) => e.draw());
  state.coins.forEach((c) => c.draw());
  state.particles.forEach((p) => p.draw());
  state.ctx.restore();
  state.ctx.fillStyle = "white";
  state.ctx.font = "24px Arial";
  state.ctx.textAlign = "left";
  state.ctx.fillText(`Level ${state.level} - Score: ${state.score}`, 20, 40);
  state.ctx.fillText(`FPS: ${state.fps.toFixed(1)}`, 20, 70);
  requestAnimationFrame(gameLoop);
}
