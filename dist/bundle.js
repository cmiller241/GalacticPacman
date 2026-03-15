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
  score: 0,
  level: 1,
  gameOver: false,
  levelComplete: false,
  stars: [],
  keys: {},
  eatDotIndex: 0,
  lastAlphaUpdate: 0,
  lastFrameTime: 0,
  fps: 0
};

// js/constants.js
var GRAVITY_STRENGTH = 0.35;
var GROUND_POUND_GRAV_MULTIPLIER = 3;
var GROUND_POUND_PUSH_STRENGTH = 0.05;
var JUMP_STRENGTH = 9;
var MOVE_SPEED = 0.05;
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
  lengthSq() {
    return this.x * this.x + this.y * this.y;
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

// js/world/Planetoid.js
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
    this.interiorType = null;
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

// js/world/SpikeyPlanetoid.js
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

// js/world/BeamPlanetoid.js
var BeamPlanetoid = class extends Planetoid {
  constructor(x, y, radius, color, beamColor) {
    super(x, y, radius, color);
    this.beamColor = beamColor;
    this.beamAngle = -Math.PI / 2;
    this.beamLength = 140;
    this.beamWidth = 14;
    this.beamParticles = [];
    this.portalParticles = [];
    this.interior = null;
  }
  getBeamStart() {
    return new Vector2(
      this.pos.x + Math.cos(this.beamAngle) * this.radius,
      this.pos.y + Math.sin(this.beamAngle) * this.radius
    );
  }
  getBeamEnd(start) {
    return new Vector2(
      start.x + Math.cos(this.beamAngle) * this.beamLength,
      start.y + Math.sin(this.beamAngle) * this.beamLength
    );
  }
  getPortalPosition() {
    if (this.interior) {
      return this.interior.getPortalPosition();
    }
    throw new Error("No interior set for BeamPlanetoid");
  }
  spawnPortalParticles(pos) {
    if (Math.random() < 0.5) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1 + Math.random() * 2;
      const vel = new Vector2(
        Math.cos(angle) * speed,
        Math.sin(angle) * speed
      );
      this.portalParticles.push(
        new PortalParticle(pos, vel, 40, this.beamColor)
      );
    }
  }
  spawnBeamParticles(start) {
    if (Math.random() < 0.6) {
      const beamDir = new Vector2(
        Math.cos(this.beamAngle),
        Math.sin(this.beamAngle)
      );
      const side = new Vector2(-beamDir.y, beamDir.x).multiply((Math.random() - 0.5) * 1.5);
      const speed = 2 + Math.random() * 2;
      const vel = beamDir.multiply(speed).add(side);
      this.beamParticles.push(
        new BeamParticle(start, vel, 50, this.beamColor)
      );
    }
  }
  drawBeam(start, end) {
    const ctx = state.ctx;
    const gradient = ctx.createLinearGradient(
      start.x,
      start.y,
      end.x,
      end.y
    );
    gradient.addColorStop(0, this.beamColor);
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.save();
    ctx.shadowColor = this.beamColor;
    ctx.shadowBlur = 60;
    ctx.strokeStyle = gradient;
    ctx.lineWidth = this.beamWidth;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.shadowBlur = 20;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(start.x - 8, start.y);
    ctx.lineTo(end.x - 8, end.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(start.x + 8, start.y);
    ctx.lineTo(end.x + 8, end.y);
    ctx.stroke();
    ctx.restore();
  }
  updateParticles() {
    for (let i = this.beamParticles.length - 1; i >= 0; i--) {
      const p = this.beamParticles[i];
      p.update();
      p.draw();
      if (p.life <= 0) {
        this.beamParticles.splice(i, 1);
      }
    }
    for (let i = this.portalParticles.length - 1; i >= 0; i--) {
      const p = this.portalParticles[i];
      p.update();
      p.draw();
      if (p.life <= 0) {
        this.portalParticles.splice(i, 1);
      }
    }
  }
  drawInterior() {
    if (this.interior) {
      this.interior.draw();
    }
  }
  draw() {
    super.draw();
    this.drawInterior();
    const start = this.getBeamStart();
    const end = this.getBeamEnd(start);
    const portal = this.getPortalPosition();
    this.spawnBeamParticles(start);
    this.spawnPortalParticles(portal);
    this.drawBeam(start, end);
    this.updateParticles();
  }
};
var BeamParticle = class {
  constructor(pos, vel, life = 40, color = "rgba(255,0,255,1)") {
    this.pos = pos.clone();
    this.vel = vel;
    this.life = life;
    this.maxLife = life;
    this.color = color;
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
    ctx.fillStyle = this.color.replace("1)", `${alpha})`);
    ctx.fill();
  }
};
var PortalParticle = class {
  constructor(pos, vel, life = 35, color = "rgba(255,0,255,1)") {
    this.pos = pos.clone();
    this.vel = vel;
    this.life = life;
    this.maxLife = life;
    this.color = color;
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
    ctx.fillStyle = this.color.replace("1)", `${alpha})`);
    ctx.fill();
  }
};

// js/interiors/Interior.js
var Interior = class {
  constructor(planetoid) {
    this.planetoid = planetoid;
  }
  draw() {
    throw new Error("draw() must be implemented in subclass");
  }
  getPortalPosition() {
    throw new Error("getPortalPosition() must be implemented in subclass");
  }
};

// js/interiors/MazeInterior.js
var MazeInterior = class extends Interior {
  constructor(planetoid) {
    super(planetoid);
    this.cols = 28;
    this.rows = 29;
    this.tileSize = 12;
    this.exitColLeft = 13;
    this.exitColRight = 14;
    this.exitRow = 13;
    this.layout = [
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
      "#.####.## ###  ### ##.####.#",
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
    this.walls = [];
    this.dots = [];
    this.powerPellets = [];
    this.ghosts = [];
    this.offscreen = null;
    this.initializeWallsAndDots();
    this.createOffscreen();
  }
  initializeWallsAndDots() {
    for (let row = 0; row < this.rows; row++) {
      let rowStr = this.layout[row];
      if (rowStr.length < this.cols) {
        const padTotal = this.cols - rowStr.length;
        const padLeft = Math.floor(padTotal / 2);
        const padRight = Math.ceil(padTotal / 2);
        rowStr = " ".repeat(padLeft) + rowStr + " ".repeat(padRight);
      }
      this.walls[row] = [];
      for (let col = 0; col < this.cols; col++) {
        const char = rowStr[col] || " ";
        this.walls[row][col] = char === "#" || char === "-";
        if (char === ".") {
          this.dots.push({ x: col, y: row });
        }
      }
    }
  }
  createOffscreen() {
    const width = this.cols * this.tileSize;
    const height = this.rows * this.tileSize;
    this.offscreen = document.createElement("canvas");
    this.offscreen.width = width;
    this.offscreen.height = height;
    const offCtx = this.offscreen.getContext("2d");
    offCtx.fillStyle = "#cc00cc";
    offCtx.strokeStyle = "#330033";
    offCtx.lineWidth = 4;
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        if (this.walls[row][col]) {
          offCtx.fillRect(
            col * this.tileSize,
            row * this.tileSize,
            this.tileSize,
            this.tileSize
          );
        }
      }
    }
  }
  draw() {
    const ctx = state.ctx;
    const offsetX = this.planetoid.pos.x - this.cols * this.tileSize / 2;
    const offsetY = this.planetoid.pos.y - this.rows * this.tileSize / 2;
    ctx.save();
    ctx.globalAlpha = 0.5;
    if (this.offscreen) {
      ctx.drawImage(
        this.offscreen,
        offsetX,
        offsetY
      );
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#FFFFFF";
    for (let dot of this.dots) {
      const x = offsetX + dot.x * this.tileSize + this.tileSize / 2;
      const y = offsetY + dot.y * this.tileSize + this.tileSize / 2;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#FFFF00";
    for (let pp of this.powerPellets) {
      const x = offsetX + pp.x * this.tileSize + this.tileSize / 2;
      const y = offsetY + pp.y * this.tileSize + this.tileSize / 2;
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fill();
    }
    const portalX = offsetX + (this.exitColLeft + 0.5) * this.tileSize + this.tileSize / 2;
    const portalY = offsetY + this.exitRow * this.tileSize + this.tileSize / 2;
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
    this.ghosts.forEach((g) => g.draw());
    ctx.restore();
  }
  getPortalPosition() {
    const offsetX = this.planetoid.pos.x - this.cols * this.tileSize / 2;
    const offsetY = this.planetoid.pos.y - this.rows * this.tileSize / 2;
    const portalX = offsetX + (this.exitColLeft + 0.5) * this.tileSize + this.tileSize / 2;
    const portalY = offsetY + this.exitRow * this.tileSize + this.tileSize / 2;
    return new Vector2(portalX, portalY);
  }
  getRandomOpenPos() {
    const opens = [];
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        if (!this.walls[row][col]) {
          opens.push({ col, row });
        }
      }
    }
    return opens[Math.floor(Math.random() * opens.length)];
  }
  getRandomPelletPos() {
    const pellets = [...this.dots, ...this.powerPellets];
    if (pellets.length === 0) return this.getRandomOpenPos();
    const p = pellets[Math.floor(Math.random() * pellets.length)];
    return { col: p.x, row: p.y };
  }
};

// js/interiors/PlatformInterior.js
var PlatformInterior = class extends Interior {
  constructor(planetoid) {
    super(planetoid);
    this.cols = 28;
    this.rows = 29;
    this.tileSize = 12;
    this.exitColLeft = 24;
    this.exitColRight = 25;
    this.exitRow = 25;
    this.tiles = [
      "............................",
      "..........#######...........",
      "..........H.................",
      "..........H.................",
      "..........H.................",
      "..........H.................",
      "...######################...",
      ".............H.......H......",
      ".............H.......H......",
      ".............H.......H......",
      ".............H.......H......",
      "..########################..",
      ".......H........H...........",
      ".......H........H...........",
      ".......H....................",
      ".......H....................",
      "..########################..",
      "...........H........H.......",
      "...........H........H.......",
      "...........H........H.......",
      "...........H........H.......",
      "..########################..",
      ".....H......................",
      ".....H......................",
      ".....H......................",
      ".....H......................",
      "############################",
      "............................",
      "............................"
    ];
    this.offscreen = null;
    this.createOffscreen();
    this.blobs = [];
  }
  createOffscreen() {
    const width = this.cols * this.tileSize;
    const height = this.rows * this.tileSize;
    this.offscreen = document.createElement("canvas");
    this.offscreen.width = width;
    this.offscreen.height = height;
    const offCtx = this.offscreen.getContext("2d");
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const tile = this.tiles[row][col];
        const x = col * this.tileSize;
        const y = row * this.tileSize;
        if (tile === "#") {
          offCtx.fillStyle = "#6b3f1d";
          offCtx.fillRect(x, y, this.tileSize, this.tileSize);
          offCtx.strokeStyle = "#3b200f";
          offCtx.strokeRect(x, y, this.tileSize, this.tileSize);
          offCtx.fillStyle = "rgba(255,255,255,0.15)";
          offCtx.fillRect(x, y, this.tileSize, 6);
        }
        if (tile === "H") {
          const centerX = x + this.tileSize / 2;
          const railOffset = 3;
          const leftRail = centerX - railOffset;
          const rightRail = centerX + railOffset;
          offCtx.strokeStyle = "#d8c38f";
          offCtx.lineWidth = 2;
          offCtx.beginPath();
          offCtx.moveTo(leftRail, y);
          offCtx.lineTo(leftRail, y + this.tileSize);
          offCtx.moveTo(rightRail, y);
          offCtx.lineTo(rightRail, y + this.tileSize);
          offCtx.stroke();
          for (let r = 3; r < this.tileSize; r += 4) {
            offCtx.beginPath();
            offCtx.moveTo(leftRail, y + r);
            offCtx.lineTo(rightRail, y + r);
            offCtx.stroke();
          }
        }
      }
    }
  }
  draw() {
    const ctx = state.ctx;
    const offsetX = this.planetoid.pos.x - this.cols * this.tileSize / 2;
    const offsetY = this.planetoid.pos.y - this.rows * this.tileSize / 2;
    ctx.save();
    ctx.globalAlpha = 0.6;
    if (this.offscreen) {
      ctx.drawImage(this.offscreen, offsetX, offsetY);
    }
    ctx.globalAlpha = 1;
    const portal = this.getPortalPosition();
    const time = Date.now() * 4e-3;
    const pulse = (Math.sin(Date.now() * 6e-3) + 1) / 2;
    ctx.save();
    ctx.shadowColor = "#39ff14";
    ctx.shadowBlur = 20;
    ctx.beginPath();
    ctx.arc(portal.x, portal.y, 8 + pulse * 3, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(57,255,20,${0.7 + pulse * 0.3})`;
    ctx.fill();
    ctx.globalCompositeOperation = "lighter";
    const swirlCount = 8;
    for (let i = 0; i < swirlCount; i++) {
      const angle = time + i / swirlCount * Math.PI * 2;
      const radius = 12 + Math.sin(time * 2 + i) * 3;
      const x = portal.x + Math.cos(angle) * radius;
      const y = portal.y + Math.sin(angle) * radius;
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fillStyle = "#baff9a";
      ctx.fill();
    }
    this.blobs.forEach((blob) => blob.draw());
    ctx.restore();
    ctx.restore();
  }
  getPortalPosition() {
    const offsetX = this.planetoid.pos.x - this.cols * this.tileSize / 2;
    const offsetY = this.planetoid.pos.y - this.rows * this.tileSize / 2;
    const portalX = offsetX + (this.exitColLeft + 0.5) * this.tileSize + this.tileSize / 2;
    const portalY = offsetY + this.exitRow * this.tileSize + this.tileSize / 2;
    return new Vector2(portalX, portalY);
  }
};

// js/entities/Entity.js
var Entity = class {
  constructor() {
    this.pos = new Vector2(0, 0);
    this.vel = new Vector2(0, 0);
    this.radius = 0;
    this.mass = 0;
  }
  update() {
  }
  draw() {
  }
};

// js/entities/world/Asteroid.js
var Asteroid = class extends Entity {
  constructor(x, y, radius) {
    super();
    this.pos = new Vector2(x, y);
    this.radius = radius;
    this.mass = radius * radius;
    let direction = new Vector2(Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
    this.vel = direction.multiply(PLANET_SPEED);
    this.angularSpeed = (Math.random() * 2 - 1) * 0.05;
    this.angle = Math.random() * Math.PI * 2;
    this.color = "#8B4513";
    this.points = this.generatePoints();
    this.interiorPoints = [];
    const numInterior = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < numInterior; i++) {
      this.interiorPoints.push(new Vector2(
        (Math.random() - 0.5) * this.radius * 1.2,
        (Math.random() - 0.5) * this.radius * 1.2
      ));
    }
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
    const lightDir = new Vector2(-0.7, -0.7).normalize();
    const baseR = parseInt(this.color.substr(1, 2), 16);
    const baseG = parseInt(this.color.substr(3, 2), 16);
    const baseB = parseInt(this.color.substr(5, 2), 16);
    for (let i = 0; i < this.points.length; i++) {
      const j = (i + 1) % this.points.length;
      const p1 = this.points[i].clone();
      const p2 = this.points[j].clone();
      this.interiorPoints.forEach((ip) => {
        this.fillTriangle(ctx, p1, p2, ip, baseR, baseG, baseB, lightDir);
      });
      const mid = p1.clone().add(p2).multiply(0.5);
      this.fillTriangle(ctx, p1, mid, p2, baseR, baseG, baseB, lightDir);
    }
    ctx.beginPath();
    ctx.moveTo(this.points[0].x, this.points[0].y);
    for (let i = 1; i < this.points.length; i++) {
      ctx.lineTo(this.points[i].x, this.points[i].y);
    }
    ctx.closePath();
    ctx.strokeStyle = "#3A1C08";
    ctx.lineWidth = 2;
    ctx.stroke();
    const shadowGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, this.radius);
    shadowGrad.addColorStop(0, "rgba(0,0,0,0)");
    shadowGrad.addColorStop(0.7, "rgba(0,0,0,0.15)");
    shadowGrad.addColorStop(1, "rgba(0,0,0,0.3)");
    ctx.fillStyle = shadowGrad;
    ctx.beginPath();
    ctx.moveTo(this.points[0].x, this.points[0].y);
    for (let i = 1; i < this.points.length; i++) {
      ctx.lineTo(this.points[i].x, this.points[i].y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  // --- Helper to fill a triangle with shading ---
  fillTriangle(ctx, v0, v1, v2, baseR, baseG, baseB, lightDir) {
    const edge = v2.subtract(v1);
    const perp = new Vector2(edge.y, -edge.x);
    const normal = perp.lengthSq() > 0 ? perp.normalize() : new Vector2(0, 1);
    const dot = lightDir.dot(normal);
    const edgeDistance = (v1.length() + v2.length()) / (2 * this.radius);
    let brightness = 0.3 + Math.max(0, dot) * 0.7;
    brightness = brightness * (1 - 0.4 * edgeDistance) + 0.2;
    const cr = Math.min(255, Math.max(0, Math.floor(baseR * brightness)));
    const cg = Math.min(255, Math.max(0, Math.floor(baseG * brightness)));
    const cb = Math.min(255, Math.max(0, Math.floor(baseB * brightness)));
    ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
    ctx.beginPath();
    ctx.moveTo(v0.x, v0.y);
    ctx.lineTo(v1.x, v1.y);
    ctx.lineTo(v2.x, v2.y);
    ctx.closePath();
    ctx.fill();
  }
};

// js/entities/Particle.js
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
function updatePlayerMazePosition() {
  const interior = state.player.currentInterior;
  const planet = state.player.currentPlanet;
  if (!interior || !planet) {
    console.warn("updatePlayerMazePosition: missing interior or planet");
    return;
  }
  const offsetX = planet.pos.x - interior.cols * interior.tileSize / 2;
  const offsetY = planet.pos.y - interior.rows * interior.tileSize / 2;
  state.player.pos.x = offsetX + state.player.mazeCol * interior.tileSize + interior.tileSize / 2;
  state.player.pos.y = offsetY + state.player.mazeRow * interior.tileSize + interior.tileSize / 2;
}
function enterMazeMode() {
  const interior = state.player.currentPlanet?.interior;
  if (!interior) {
    console.error("Cannot enter maze: no planet or interior");
    return;
  }
  state.player.mode = "maze";
  state.player.currentInterior = interior;
  state.player.onSurface = false;
  state.player.mazeCol = interior.exitColLeft;
  state.player.mazeRow = interior.exitRow;
  state.player.mazeDir = new Vector2(1, 0);
  state.player.lastMoveTime = Date.now();
  updatePlayerMazePosition();
}
function enterPlatformMode() {
  const interior = state.player.currentPlanet?.interior;
  if (!interior) {
    console.error("Cannot enter platform: no planet or interior");
    return;
  }
  state.player.mode = "platform";
  state.player.currentInterior = interior;
  state.player.onSurface = false;
  state.player.platformPos = new Vector2(
    (interior.exitColLeft + 0.5) * interior.tileSize,
    (interior.exitRow + 0.5) * interior.tileSize
  );
  state.player.platformVel = new Vector2(0, 0);
  const tileX = Math.floor(state.player.platformPos.x / interior.tileSize);
  const tileY = Math.floor(state.player.platformPos.y / interior.tileSize);
  const belowTile = interior.tiles[tileY + 1]?.[tileX];
  state.player.onGround = belowTile === "#" || belowTile === "H";
  updatePlayerPlatformPosition();
}
function updatePlayerPlatformPosition() {
  const interior = state.player.currentInterior;
  const planet = state.player.currentPlanet;
  if (!interior || !planet) {
    console.warn("updatePlayerPlatformPosition: missing interior or planet");
    return;
  }
  const offsetX = planet.pos.x - interior.cols * interior.tileSize / 2;
  const offsetY = planet.pos.y - interior.rows * interior.tileSize / 2;
  state.player.pos.x = offsetX + state.player.platformPos.x;
  state.player.pos.y = offsetY + state.player.platformPos.y;
}
function startTeleportFromMaze() {
  state.player.startTeleport("space");
  state.player.vel = new Vector2(0, 0);
  state.player.onSurface = false;
}
function exitMazeMode() {
  state.player.mode = "space";
  state.player.currentInterior = null;
  if (state.player.currentPlanet) {
    const surfaceDist = state.player.currentPlanet.radius + PLAYER_RADIUS;
    state.player.pos.x = state.player.currentPlanet.pos.x + Math.cos(state.player.currentPlanet.beamAngle) * surfaceDist;
    state.player.pos.y = state.player.currentPlanet.pos.y + Math.sin(state.player.currentPlanet.beamAngle) * surfaceDist;
    state.player.angle = state.player.currentPlanet.beamAngle;
    state.player.onSurface = true;
    state.player.lastInfluencePlanet = state.player.currentPlanet;
  }
}
function checkMazeDots() {
  if (state.player.mode != "maze") return;
  const interior = state.player.currentInterior;
  for (let i = interior.dots.length - 1; i >= 0; i--) {
    const d = interior.dots[i];
    if (d.x === state.player.mazeCol && d.y === state.player.mazeRow) {
      playEatDot();
      interior.dots.splice(i, 1);
      state.score += 10;
    }
  }
  for (let i = interior.powerPellets.length - 1; i >= 0; i--) {
    const p = interior.powerPellets[i];
    if (p.x === state.player.mazeCol && p.y === state.player.mazeRow) {
      playEatDot();
      interior.powerPellets.splice(i, 1);
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
function angleDiff(a, b) {
  let diff = (a - b + Math.PI) % (2 * Math.PI);
  if (diff < 0) diff += 2 * Math.PI;
  return Math.abs(diff - Math.PI);
}

// js/entities/Player.js
var Player = class extends Entity {
  constructor(x, y) {
    super();
    this.pos = new Vector2(x, y);
    this.vel = new Vector2(0, 0);
    this.radius = PLAYER_RADIUS;
    this.onSurface = false;
    this.onGround = false;
    this.currentPlanet = null;
    this.currentInterior = null;
    this.lastInfluencePlanet = null;
    this.angle = 0;
    this.mouthAngle = 0;
    this.facingDirection = 1;
    this.isGroundPounding = false;
    this.mode = "space";
    this.mazeCol = 14;
    this.mazeRow = 15;
    this.mazeDir = new Vector2(1, 0);
    this.platformPos = null;
    this.platformVel = new Vector2(0, 0);
    this.lastMoveTime = 0;
    this.isTeleporting = false;
    this.teleportTargetMode = null;
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
  // ----------------------------
  // TELEPORT HELPER
  // ----------------------------
  startTeleport(targetMode, targetPos = null) {
    this.isTeleporting = true;
    this.teleportTargetMode = targetMode;
    this.teleportStartTime = Date.now();
    this.teleportScale = 1;
    this.teleportGlow = 0;
    if (targetPos && targetMode === "platform") {
      this.platformPos = targetPos.clone();
    }
  }
  // ----------------------------
  // DEATH
  // ----------------------------
  startDeath() {
    if (!this.isDying) {
      this.isDying = true;
      this.deathStartTime = Date.now();
      this.deathScale = 1;
      this.deathRotation = 0;
      this.deathAlpha = 1;
      createDeathParticles(this.pos, 400);
      playDeath();
    }
  }
  applyGravity() {
    if (this.onSurface) return;
    let planet = state.gravitySystem.findDominantPlanet(this.pos);
    if (!planet && this.lastInfluencePlanet) planet = this.lastInfluencePlanet;
    if (planet) {
      this.lastInfluencePlanet = planet;
      const direction = planet.pos.subtract(this.pos).normalize();
      let grav = GRAVITY_STRENGTH;
      if (this.isGroundPounding) grav *= GROUND_POUND_GRAV_MULTIPLIER;
      this.vel.add(direction.multiply(grav));
    }
  }
  // Helper: Check if a point (x,y) is inside a solid tile ('#')
  isSolidTile(x, y) {
    const interior = this.currentInterior;
    if (!interior) return false;
    const tileX = Math.floor(x / interior.tileSize);
    const tileY = Math.floor(y / interior.tileSize);
    return interior.tiles[tileY]?.[tileX] === "#";
  }
  move(keys) {
    if (this.mode == "maze") {
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
        if (dy === -1 && this.mazeRow === this.currentInterior.exitRow && (this.mazeCol === this.currentInterior.exitColLeft || this.mazeCol === this.currentInterior.exitColRight)) {
          startTeleportFromMaze();
          return;
        }
        if (!this.currentInterior.walls[newRow]?.[newCol]) {
          this.mazeCol = newCol;
          this.mazeRow = newRow;
          this.mazeDir = new Vector2(dx || this.mazeDir.x, dy || this.mazeDir.y).normalize();
          this.lastMoveTime = now;
          updatePlayerMazePosition();
        }
      }
      return;
    }
    if (this.mode === "platform") {
      const interior = this.currentInterior;
      const tileSize = interior.tileSize;
      const tiles = interior.tiles;
      if (keys["ArrowLeft"]) this.platformVel.x = -MOVE_SPEED * 60;
      else if (keys["ArrowRight"]) this.platformVel.x = MOVE_SPEED * 60;
      else this.platformVel.x = 0;
      const centerX = this.platformPos.x;
      const centerY = this.platformPos.y;
      const halfWidth = this.radius * 0.4;
      const halfHeight = this.radius * 0.4;
      const tileX = Math.floor(centerX / tileSize);
      const tileY = Math.floor(centerY / tileSize);
      const onLadder = tiles[tileY]?.[tileX] === "H";
      const footTileY = Math.floor((centerY + halfHeight) / tileSize);
      const ladderBelow = tiles[footTileY + 1]?.[tileX] === "H";
      if (this.onGround && keys["ArrowDown"] && ladderBelow) {
        this.onGround = false;
        this.platformVel.y = MOVE_SPEED * 60;
      }
      if (onLadder) {
        if (keys["ArrowUp"]) this.platformVel.y = -MOVE_SPEED * 60;
        else if (keys["ArrowDown"]) this.platformVel.y = MOVE_SPEED * 60;
        else this.platformVel.y = 0;
      } else if (!this.onGround) {
        this.platformVel.y += GRAVITY_STRENGTH;
      }
      let newX = this.platformPos.x + this.platformVel.x;
      const left = newX - halfWidth;
      const right = newX + halfWidth;
      const midY = this.platformPos.y;
      if (this.platformVel.x < 0 && (this.isSolidTile(left, this.platformPos.y - halfHeight + 0.1) || this.isSolidTile(left, midY))) {
        newX = (Math.floor(left / tileSize) + 1) * tileSize + halfWidth;
        this.platformVel.x = 0;
      } else if (this.platformVel.x > 0 && (this.isSolidTile(right, this.platformPos.y - halfHeight + 0.1) || this.isSolidTile(right, midY))) {
        newX = Math.floor(right / tileSize) * tileSize - halfWidth;
        this.platformVel.x = 0;
      }
      this.platformPos.x = newX;
      let newY = this.platformPos.y + this.platformVel.y;
      const leftFoot = this.platformPos.x - halfWidth + 0.1;
      const rightFoot = this.platformPos.x + halfWidth - 0.1;
      const newBottom = newY + halfHeight;
      const newTop = newY - halfHeight;
      this.onGround = false;
      if (this.platformVel.y < 0 && !onLadder) {
        if (this.isSolidTile(leftFoot, newTop) || this.isSolidTile(rightFoot, newTop)) {
          newY = (Math.floor(newTop / tileSize) + 1) * tileSize + halfHeight;
          this.platformVel.y = 0;
        }
      } else if (this.platformVel.y >= 0) {
        const wantsDrop = keys["ArrowDown"] && ladderBelow;
        if (!wantsDrop && (this.isSolidTile(leftFoot, newBottom) || this.isSolidTile(rightFoot, newBottom))) {
          newY = Math.floor(newBottom / tileSize) * tileSize - halfHeight;
          this.platformVel.y = 0;
          this.onGround = true;
        }
        if (wantsDrop) {
          this.platformVel.y = MOVE_SPEED * 60;
        }
      }
      this.platformPos.y = newY;
      if (this.platformPos.y > interior.rows * tileSize + 100) {
        this.platformPos.y = 0;
        this.platformVel.y = 0;
        console.warn("Player fell offscreen - respawning");
      }
      updatePlayerPlatformPosition();
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
    if (this.mode === "platform") {
      if (this.onGround) {
        this.platformVel.y = -JUMP_STRENGTH * 0.5;
        this.onGround = false;
        playJump();
      }
      return;
    }
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
    let planet = state.gravitySystem.findDominantPlanet(this.pos) || this.lastInfluencePlanet;
    if (planet) {
      const outwardDir = this.pos.subtract(planet.pos).normalize();
      const radialVel = this.vel.dot(outwardDir);
      if (radialVel > 0) this.isGroundPounding = true;
    }
  }
  update() {
    if (this.isDying) {
      const elapsed = Date.now() - this.deathStartTime;
      const t = Math.min(elapsed / this.deathDuration, 1);
      this.deathScale = 1 - t * t * t;
      this.deathRotation += 0.2;
      this.deathAlpha = 1 - t;
      if (t >= 1) state.gameOver = true;
      return;
    }
    if (this.isTeleporting) {
      const elapsed = Date.now() - this.teleportStartTime;
      const t = elapsed / this.teleportDuration;
      if (t >= 1) {
        this.isTeleporting = false;
        if (this.teleportTargetMode === "maze") {
          enterMazeMode();
        } else if (this.teleportTargetMode === "platform") {
          enterPlatformMode();
        } else {
          exitMazeMode();
        }
        this.teleportTargetMode = null;
        return;
      }
      const pulse = Math.sin(t * Math.PI);
      this.teleportScale = 1 + pulse * 1.2;
      this.teleportGlow = pulse;
      if (Math.random() < 0.6) {
        const beamDir = new Vector2(
          Math.cos(this.currentPlanet?.beamAngle || 0),
          Math.sin(this.currentPlanet?.beamAngle || 0)
        );
        const side = new Vector2(-beamDir.y, beamDir.x).multiply((Math.random() - 0.5) * 1.5);
        const speed = 2 + Math.random() * 2;
        const vel = beamDir.multiply(speed).add(side);
        state.particles.push(new Particle(this.pos.clone(), vel));
      }
      return;
    }
    if (this.mode == "maze") {
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
    if (this.mode === "platform") {
      const platformScale = 0.4;
      ctx.save();
      ctx.translate(this.pos.x, this.pos.y);
      ctx.scale(platformScale, platformScale);
      if (this.platformVel.x < 0) ctx.scale(-1, 1);
      const mouthAngle2 = Math.sin(Date.now() * 0.01) * (Math.PI / 4);
      ctx.beginPath();
      ctx.arc(0, 0, this.radius, mouthAngle2 / 2, 2 * Math.PI - mouthAngle2 / 2);
      ctx.lineTo(0, 0);
      ctx.fillStyle = "yellow";
      ctx.fill();
      ctx.restore();
      return;
    }
    if (this.mode == "maze") {
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
      ctx.arc(0, 0, this.radius, mouthAngle2 / 2, 2 * Math.PI - mouthAngle2 / 2);
      ctx.lineTo(0, 0);
      ctx.fillStyle = "yellow";
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.restore();
      return;
    }
    let planet = this.onSurface ? this.currentPlanet : this.lastInfluencePlanet;
    let downDir = new Vector2(0, 1);
    if (planet) downDir = planet.pos.subtract(this.pos).normalize();
    const downAngle = Math.atan2(downDir.y, downDir.x);
    const rotation = downAngle - Math.PI / 2;
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(rotation);
    if (this.facingDirection < 0) ctx.rotate(Math.PI);
    if (this.isTeleporting) {
      ctx.shadowColor = "yellow";
      ctx.shadowBlur = 40 * glow;
    }
    ctx.scale(scale, scale);
    const mouthAngle = Math.sin(Date.now() * 0.01) * (Math.PI / 4);
    ctx.beginPath();
    ctx.arc(0, 0, this.radius, mouthAngle / 2, 2 * Math.PI - mouthAngle / 2);
    ctx.lineTo(0, 0);
    ctx.fillStyle = "yellow";
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();
  }
};

// js/entities/world/SpaceGhost.js
var SpaceGhost = class extends Entity {
  constructor(planet, color) {
    super();
    this.planet = planet;
    this.angularSpeed = (Math.random() > 0.5 ? 1 : -1) * 0.02;
    this.angle = Math.random() * Math.PI * 2;
    this.radius = ENEMY_RADIUS;
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
  update() {
    this.wavePhase += 0.15;
    if (this.onSurface) {
      this.angle += this.angularSpeed;
      this.updatePosition();
      if (Math.random() < ENEMY_JUMP_PROB) {
        for (const p of state.planetoids) {
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
      let dominant = this.findDominantPlanet();
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
  findDominantPlanet() {
    let closest = null;
    let minDist = Infinity;
    for (const planet of state.planetoids) {
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

// js/entities/world/Coin.js
var Coin = class extends Entity {
  constructor(planet) {
    super();
    this.planet = planet;
    this.angularSpeed = (Math.random() - 0.5) * 0.04;
    this.angle = 0;
    this.radius = COIN_RADIUS;
    this.orbitRadius = planet.radius + COIN_ORBIT_OFFSET;
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

// js/entities/interior/BlobMonster.js
var BlobMonster = class {
  constructor(interior, startPos, color = "#ff4400") {
    this.interior = interior;
    this.pos = startPos.clone();
    this.vel = new Vector2(0, 0);
    this.color = color;
    this.radius = 11;
    this.dir = Math.random() > 0.5 ? 1 : -1;
    this.speed = 1.9;
    this.onGround = false;
    this.wasOnGround = false;
    this.onLadder = false;
    this.dropping = false;
  }
  isSolid(x, y) {
    const ts = this.interior.tileSize;
    const col = Math.floor(x / ts);
    const row = Math.floor(y / ts);
    return this.interior.tiles[row]?.[col] === "#";
  }
  isLadder(x, y) {
    const ts = this.interior.tileSize;
    const col = Math.floor(x / ts);
    const row = Math.floor(y / ts);
    return this.interior.tiles[row]?.[col] === "H";
  }
  update() {
    const ts = this.interior.tileSize;
    if (!this.dropping) {
      this.vel.x = this.dir * this.speed;
    } else {
      this.vel.x = 0;
    }
    let newX = this.pos.x + this.vel.x;
    const left = newX - this.radius;
    const right = newX + this.radius;
    const midY = this.pos.y;
    if (!this.dropping) {
      if (this.vel.x < 0 && (this.isSolid(left, midY - this.radius + 2) || this.isSolid(left, midY))) {
        newX = Math.floor(left / ts) * ts + ts + this.radius;
        this.dir *= -1;
        this.vel.x = 0;
      } else if (this.vel.x > 0 && (this.isSolid(right, midY - this.radius + 2) || this.isSolid(right, midY))) {
        newX = Math.floor(right / ts) * ts - this.radius;
        this.dir *= -1;
        this.vel.x = 0;
      }
    }
    this.pos.x = newX;
    this.vel.y += GRAVITY_STRENGTH;
    let newY = this.pos.y + this.vel.y;
    const leftFoot = this.pos.x - this.radius + 3;
    const rightFoot = this.pos.x + this.radius - 3;
    const newBottom = newY + this.radius;
    const newTop = newY - this.radius;
    this.wasOnGround = this.onGround;
    this.onGround = false;
    const footRow = Math.floor((this.pos.y + this.radius) / ts);
    const newFootRow = Math.floor(newBottom / ts);
    if (this.vel.y >= 0) {
      const hittingPlatform = this.isSolid(leftFoot, newBottom) || this.isSolid(rightFoot, newBottom);
      const ignoringDropPlatform = this.dropping && newFootRow === this.dropRow;
      if (!ignoringDropPlatform && hittingPlatform) {
        newY = Math.floor(newBottom / ts) * ts - this.radius;
        this.vel.y = 0;
        this.onGround = true;
        this.dropping = false;
        this.dropRow = null;
      }
    } else if (this.vel.y < 0) {
      if (this.isSolid(leftFoot, newTop) || this.isSolid(rightFoot, newTop)) {
        newY = Math.floor(newTop / ts + 1) * ts + this.radius;
        this.vel.y = 0;
      }
    }
    this.pos.y = newY;
    if (this.onGround && !this.wasOnGround) {
      this.dir *= -1;
      this.checkedLadder = false;
    }
    const tileX = Math.floor(this.pos.x / ts);
    const currentFootRow = Math.floor((this.pos.y + this.radius) / ts);
    const tileHere = this.interior.tiles[currentFootRow]?.[tileX];
    const tileBelow = this.interior.tiles[currentFootRow + 1]?.[tileX];
    const ladderBelowPlatform = tileHere === "#" && tileBelow === "H";
    const tileCenterX = tileX * ts + ts / 2;
    const crossingLadderColumn = this.dir > 0 && this.pos.x >= tileCenterX && !this.checkedLadder || this.dir < 0 && this.pos.x <= tileCenterX && !this.checkedLadder;
    if (this.onGround && ladderBelowPlatform && crossingLadderColumn) {
      this.checkedLadder = true;
      if (Math.random() < 0.7) {
        this.dropping = true;
        this.dropRow = currentFootRow;
        this.vel.y = 3.5;
        this.pos.x = tileCenterX;
        this.vel.x = 0;
      }
    }
    if (Math.abs(this.pos.x - tileCenterX) > ts / 2) {
      this.checkedLadder = false;
    }
    if (this.pos.y > this.interior.rows * ts + 50) {
      this.pos.y = ts * 1.5;
      this.pos.x = ts * (10 + Math.random() * 8);
      this.vel.y = 0;
      this.dir = Math.random() > 0.5 ? 1 : -1;
      this.dropping = false;
      this.dropRow = null;
      this.checkedLadder = false;
    }
  }
  draw() {
    const ctx = state.ctx;
    const offsetX = this.interior.planetoid.pos.x - this.interior.cols * this.interior.tileSize / 2;
    const offsetY = this.interior.planetoid.pos.y - this.interior.rows * this.interior.tileSize / 2;
    ctx.save();
    ctx.translate(offsetX + this.pos.x, offsetY + this.pos.y);
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.beginPath();
    ctx.arc(-4, -5, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
};

// js/entities/interior/MazeGhost.js
var MazeGhost = class {
  constructor(interior, col, row, color) {
    this.interior = interior;
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
      if (testCol < 0) testCol = this.interior.cols - 1;
      if (testCol >= this.interior.cols) testCol = 0;
      let testRow = this.mazeRow + d.y;
      const isReverse = d.x === -this.dir.x && d.y === -this.dir.y;
      if (!this.interior.walls[testRow]?.[testCol] && !isReverse) {
        possible.push(d.clone());
      }
    }
    if (possible.length === 0) {
      for (let d of dirs) {
        let testCol = this.mazeCol + d.x;
        if (testCol < 0) testCol = this.interior.cols - 1;
        if (testCol >= this.interior.cols) testCol = 0;
        let testRow = this.mazeRow + d.y;
        if (!this.interior.walls[testRow]?.[testCol]) {
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
    if (newCol < 0) newCol = this.interior.cols - 1;
    if (newCol >= this.interior.cols) newCol = 0;
    this.mazeCol = newCol;
    this.mazeRow = newRow;
  }
  draw() {
    const ctx = state.ctx;
    const offsetX = this.interior.planetoid.pos.x - this.interior.cols * this.interior.tileSize / 2;
    const offsetY = this.interior.planetoid.pos.y - this.interior.rows * this.interior.tileSize / 2;
    const x = offsetX + this.mazeCol * this.interior.tileSize + this.interior.tileSize / 2;
    const y = offsetY + this.mazeRow * this.interior.tileSize + this.interior.tileSize / 2;
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

// js/systems/GravitySystem.js
var GravitySystem = class {
  constructor(planetoids) {
    this.planetoids = planetoids;
  }
  applyTo(entity) {
    if (entity.onSurface) return;
    const dominant = this.findDominantPlanet(entity.pos);
    if (dominant) {
      entity.lastInfluencePlanet = dominant;
      const dir = dominant.pos.subtract(entity.pos).normalize();
      let grav = entity.GRAVITY_STRENGTH || 0.35;
      if (entity.isGroundPounding) grav *= entity.GROUND_POUND_GRAV_MULTIPLIER || 3;
      entity.vel.add(dir.multiply(grav));
    }
  }
  findDominantPlanet(pos) {
    let closest = null;
    let minDist = Infinity;
    for (const planet of this.planetoids) {
      const dist = pos.subtract(planet.pos).length();
      if (dist < planet.influenceRadius && dist < minDist) {
        minDist = dist;
        closest = planet;
      }
    }
    return closest;
  }
};

// js/systems/CollisionSystem.js
var CollisionSystem = class {
  handleElasticCollisions(entities1, entities2 = entities1, radiusProp1 = "radius", radiusProp2 = "radius", massProp1 = "mass", massProp2 = "mass") {
    for (let i = 0; i < entities1.length; i++) {
      for (let j = entities1 === entities2 ? i + 1 : 0; j < entities2.length; j++) {
        const p1 = entities1[i];
        const p2 = entities2[j];
        const offset = p1.pos.subtract(p2.pos);
        const distSq = offset.lengthSq();
        const sumR = p1[radiusProp1] + p2[radiusProp2];
        const sumRSq = sumR * sumR;
        if (distSq < sumRSq) {
          const dist = Math.sqrt(distSq);
          const overlap = sumR - dist;
          const normal = offset.normalize();
          const tangent = new Vector2(-normal.y, normal.x);
          const m1 = p1[massProp1], m2 = p2[massProp2], totalMass = m1 + m2;
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
  }
  handlePlayerPlanetCollisions(player) {
    for (const planet of state.planetoids.filter((p) => p.isSpikey)) {
      const dist = player.pos.subtract(planet.pos).length();
      if (dist <= planet.radius + PLAYER_RADIUS + SURFACE_TOLERANCE) {
        player.startDeath();
        return;
      }
    }
    if (player.onSurface) return;
    for (const planet of state.planetoids.filter((p) => !p.isSpikey)) {
      const offset = player.pos.subtract(planet.pos);
      const dist = offset.length();
      const surfaceDist = planet.radius + PLAYER_RADIUS;
      if (dist <= surfaceDist + SURFACE_TOLERANCE) {
        const normal = offset.normalize();
        player.pos = planet.pos.clone().add(normal.multiply(surfaceDist));
        player.onSurface = true;
        player.currentPlanet = planet;
        player.lastInfluencePlanet = planet;
        const impactVel = player.vel.clone();
        player.vel = new Vector2(0, 0);
        player.angle = Math.atan2(player.pos.y - planet.pos.y, player.pos.x - planet.pos.x);
        if (player.isGroundPounding) {
          player.isGroundPounding = false;
          const pushDir = normal.multiply(-1);
          planet.vel.add(pushDir.multiply(impactVel.length() * GROUND_POUND_PUSH_STRENGTH));
          createParticles(player.pos, 20);
        }
        return;
      }
    }
    player.onSurface = false;
    player.currentPlanet = null;
  }
  handlePlayerAsteroidCollisions(player, asteroids) {
    for (const a of asteroids) {
      const dist = player.pos.subtract(a.pos).length();
      if (dist <= PLAYER_RADIUS + a.radius) {
        player.startDeath();
        return;
      }
    }
  }
  handlePlayerEnemyCollisions(player, enemies) {
    for (const e of enemies) {
      const dist = player.pos.subtract(e.pos).length();
      if (dist <= PLAYER_RADIUS + ENEMY_RADIUS) {
        player.startDeath();
        return;
      }
    }
  }
  handleCoinCollisions(player, coins) {
    for (let i = coins.length - 1; i >= 0; i--) {
      const c = coins[i];
      const dist = player.pos.subtract(c.pos).length();
      if (dist <= PLAYER_RADIUS + COIN_RADIUS) {
        playEatDot();
        coins.splice(i, 1);
        state.score++;
      }
    }
  }
  handlePlanetAsteroidCollisions(planetoids, asteroids) {
    const toBreak = /* @__PURE__ */ new Set();
    for (let p of planetoids) {
      for (let a of asteroids) {
        const dist = p.pos.subtract(a.pos).length();
        if (dist < p.radius + a.radius) {
          toBreak.add(a);
        }
      }
    }
    return toBreak;
  }
};

// js/systems/AISystem.js
var AISystem = class {
  updateEnemies(enemies, planetoids) {
    enemies.forEach((e) => e.update(planetoids));
  }
  updateInteriorGhosts(interior) {
    if (interior && interior.ghosts) {
      interior.ghosts.forEach((g) => g.update());
    }
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
var gravitySystem;
var collisionSystem = new CollisionSystem();
var aiSystem = new AISystem();
window.addEventListener("keydown", (e) => {
  state.keys[e.key] = true;
  if (e.key === " ") {
    if (state.player.onSurface && state.player.mode != "maze") state.player.jump();
    else if (state.player.mode != "maze") state.player.tryGroundPound();
  }
  if (e.key === "ArrowDown" && state.player.mode != "maze") {
    if (state.player.onSurface && state.player.currentPlanet instanceof BeamPlanetoid) {
      const diff = angleDiff(state.player.angle, state.player.currentPlanet.beamAngle);
      if (diff < Math.PI / 5) {
        state.player.startTeleport(state.player.currentPlanet.interior instanceof MazeInterior ? "maze" : "platform");
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
  state.mazePlanet = new BeamPlanetoid(state.sceneWidth * 0.55, state.sceneHeight * 0.45, 250, "#8A2BE2", "rgba(255,0,255,1)");
  state.mazePlanet.interior = new MazeInterior(state.mazePlanet);
  state.planetoids.push(state.mazePlanet);
  state.platformPlanet = new BeamPlanetoid(state.sceneWidth * 0.3, state.sceneHeight * 0.6, 250, "#55aa55", "rgba(57,255,20,1)");
  state.platformPlanet.interior = new PlatformInterior(state.platformPlanet);
  state.planetoids.push(state.platformPlanet);
  const interior = state.platformPlanet.interior;
  const tile = interior.tileSize;
  interior.blobs = [
    new BlobMonster(
      interior,
      new Vector2(15 * tile + tile / 2, 1 * tile - 15),
      // centered on top platform
      "#ff6600"
      // bright orange blob
    ),
    new BlobMonster(
      interior,
      new Vector2(13 * tile + tile / 2, 1 * tile - 15),
      // centered on top platform
      "#ff6600"
      // bright orange blob
    )
  ];
  let pos1 = state.mazePlanet.interior.getRandomPelletPos();
  let pos2 = state.mazePlanet.interior.getRandomPelletPos();
  while (pos2.col === pos1.col && pos2.row === pos1.row) {
    pos2 = state.mazePlanet.interior.getRandomPelletMazePos();
  }
  state.mazePlanet.interior.ghosts = [
    new MazeGhost(state.mazePlanet.interior, pos1.col, pos1.row, "red"),
    new MazeGhost(state.mazePlanet.interior, pos2.col, pos2.row, "pink")
  ];
  state.asteroids = [];
  for (let i = 0; i < 24; i++) {
    const radius = 20 + Math.random() * 25;
    const x = radius + Math.random() * (state.sceneWidth - 2 * radius);
    const y = radius + Math.random() * (state.sceneHeight - 2 * radius);
    state.asteroids.push(new Asteroid(x, y, radius));
  }
  const regularPlanets = state.planetoids.filter((p) => !p.isSpikey && p !== state.mazePlanet && p !== state.platformPlanet);
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
    state.enemies.push(new SpaceGhost(selectedPlanet, color));
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
  state.player.mode = "space";
  state.eatDotIndex = 0;
  gravitySystem = new GravitySystem(state.planetoids);
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
  if (state.player.mode == "maze") updatePlayerMazePosition();
  updateAsteroids();
  let toBreak = collisionSystem.handlePlanetAsteroidCollisions(state.planetoids, state.asteroids);
  collisionSystem.handleElasticCollisions(state.planetoids);
  collisionSystem.handleElasticCollisions(state.asteroids);
  for (let a of toBreak) {
    breakAsteroid(a);
  }
  if (!state.player.isDying) {
    state.player.move(state.keys);
    if (state.player.mode != "maze") gravitySystem.applyTo(state.player);
    state.player.update();
    if (state.player.mode != "maze") collisionSystem.handlePlayerPlanetCollisions(state.player);
  } else {
    state.player.update();
  }
  aiSystem.updateEnemies(state.enemies, state.planetoids);
  if (state.player.mode === "maze" && state.player.currentPlanet?.interior) {
    aiSystem.updateInteriorGhosts(state.player.currentPlanet.interior);
  }
  if (state.player.mode === "platform" && state.platformPlanet?.interior?.blobs) {
    state.platformPlanet.interior.blobs.forEach((b) => b.update());
  }
  state.coins.forEach((c) => c.update());
  state.particles.forEach((p) => p.update());
  state.particles = state.particles.filter((p) => p.life > 0);
  collisionSystem.handleCoinCollisions(state.player, state.coins);
  collisionSystem.handlePlayerAsteroidCollisions(state.player, state.asteroids);
  collisionSystem.handlePlayerEnemyCollisions(state.player, state.enemies);
  if (state.player.mode === "maze" && state.player.currentPlanet?.interior) {
    checkMazeDots();
  }
  if (state.coins.length === 0 && state.player.mode != "maze") {
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
