(() => {
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
  var JUMP_STRENGTH = 10;
  var MOVE_SPEED = 0.5;
  var PLAYER_LINEAR_SPEED = 5;
  var PLAYER_RADIUS = 30;
  var ENEMY_RADIUS = 20;
  var COIN_RADIUS = 5;
  var COIN_ORBIT_OFFSET = 18;
  var INFLUENCE_PADDING = 200;
  var SURFACE_TOLERANCE = 4;
  var DRAG = 0.995;
  var PLANET_SPEED = 1;
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
  var Planetoid = class _Planetoid {
    // How far the glow extends past the planet's edge, and how strong it
    // is. These used to be set live via ctx.shadowBlur every frame; now
    // they're only used once, at bake time, in createOffscreen(). If the
    // glow ever looks clipped/square at the edges, increase SHADOW_PADDING.
    static SHADOW_BLUR = 25;
    static SHADOW_PADDING = 40;
    static SHADOW_COLOR = "rgba(173,216,230,0.3)";
    // ----------------------------
    // SUN-RELATIVE SHADING (perf note)
    // ----------------------------
    // The sun is assumed fixed at the center of the level (sceneWidth/2,
    // sceneHeight/2) — not shown yet, per the plan.
    //
    // Rather than recomputing a gradient per planet per frame (real cost,
    // 60+ times a frame), a SINGLE overlay circle is baked ONCE, shared
    // by every planet instance, with its highlight pointing "up" by
    // convention. Each frame, draw() just rotates and blits that shared
    // overlay per planet — a rotate+drawImage is cheap, comparable to the
    // existing ring-canvas blit, not a shadowBlur/gradient-rebuild cost.
    static SUN_OVERLAY_DIAMETER = 200;
    // reference bake size; scaled per-planet at draw time (soft gradients upscale fine, unlike sharp sprites)
    static SUN_MIN_ALPHA = 0.25;
    // shading strength for planets farthest from the sun
    static SUN_MAX_ALPHA = 0.9;
    // shading strength for planets closest to the sun
    static SUN_MAX_DARKNESS = 0.5;
    // overall (non-directional) dimming applied to the farthest planets — 0 = none, 1 = fully black. Grows linearly with distance; planets at the sun get none.
    static sunOverlayCanvas = null;
    // built lazily, shared across all instances
    static getSunOverlayCanvas() {
      if (_Planetoid.sunOverlayCanvas) return _Planetoid.sunOverlayCanvas;
      const d = _Planetoid.SUN_OVERLAY_DIAMETER;
      const r = d / 2;
      const canvas = document.createElement("canvas");
      canvas.width = d;
      canvas.height = d;
      const ctx = canvas.getContext("2d");
      const offset = -r * 0.5;
      const grad = ctx.createRadialGradient(r, r + offset, 0, r, r + offset, r * 1.5);
      grad.addColorStop(0, "white");
      grad.addColorStop(1, "black");
      ctx.beginPath();
      ctx.arc(r, r, r, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      _Planetoid.sunOverlayCanvas = canvas;
      return canvas;
    }
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
      this.offscreenPadding = 0;
      this.ringCanvas = null;
      this.interiorType = null;
    }
    createOffscreen() {
      const bodyCanvas = document.createElement("canvas");
      bodyCanvas.width = this.radius * 2;
      bodyCanvas.height = this.radius * 2;
      const bodyCtx = bodyCanvas.getContext("2d");
      bodyCtx.save();
      bodyCtx.beginPath();
      bodyCtx.arc(this.radius, this.radius, this.radius, 0, Math.PI * 2);
      bodyCtx.clip();
      const tiles = 2.5;
      const texSize = this.radius * 2 * tiles;
      const texOffset = this.radius * tiles;
      bodyCtx.drawImage(state.planetTexture, this.radius - texOffset, this.radius - texOffset, texSize, texSize);
      bodyCtx.restore();
      bodyCtx.save();
      bodyCtx.globalCompositeOperation = "multiply";
      bodyCtx.beginPath();
      bodyCtx.arc(this.radius, this.radius, this.radius, 0, Math.PI * 2);
      bodyCtx.fillStyle = this.color;
      bodyCtx.fill();
      bodyCtx.globalCompositeOperation = "source-over";
      bodyCtx.restore();
      const padding = _Planetoid.SHADOW_PADDING;
      this.offscreenPadding = padding;
      this.offscreen = document.createElement("canvas");
      this.offscreen.width = this.radius * 2 + padding * 2;
      this.offscreen.height = this.radius * 2 + padding * 2;
      const finalCtx = this.offscreen.getContext("2d");
      finalCtx.shadowColor = _Planetoid.SHADOW_COLOR;
      finalCtx.shadowBlur = _Planetoid.SHADOW_BLUR;
      finalCtx.shadowOffsetX = 0;
      finalCtx.shadowOffsetY = 0;
      finalCtx.drawImage(bodyCanvas, padding, padding);
      this.ringCanvas = document.createElement("canvas");
      this.ringCanvas.width = this.influenceRadius * 2;
      this.ringCanvas.height = this.influenceRadius * 2;
      const ringCtx = this.ringCanvas.getContext("2d");
      ringCtx.strokeStyle = "rgba(173,216,230,1)";
      ringCtx.lineWidth = 3;
      ringCtx.setLineDash([10, 5]);
      ringCtx.beginPath();
      ringCtx.arc(this.influenceRadius, this.influenceRadius, this.influenceRadius, 0, Math.PI * 2);
      ringCtx.stroke();
    }
    draw() {
      const ctx = state.ctx;
      const now = Date.now();
      if (now - this.lastAlphaUpdate > 500) {
        const dist = this.pos.subtract(state.player.pos).length();
        this.cachedAlpha = Math.max(0.01, 0.3 - dist / 1e3 * 0.65);
        this.lastAlphaUpdate = now;
      }
      if (this.ringCanvas) {
        ctx.save();
        ctx.globalAlpha = this.cachedAlpha;
        ctx.drawImage(this.ringCanvas, this.pos.x - this.influenceRadius, this.pos.y - this.influenceRadius);
        ctx.restore();
      } else {
        ctx.save();
        ctx.strokeStyle = `rgba(173,216,230,${this.cachedAlpha})`;
        ctx.lineWidth = 3;
        ctx.setLineDash([10, 5]);
        ctx.beginPath();
        ctx.arc(this.pos.x, this.pos.y, this.influenceRadius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      if (this.offscreen) {
        const padding = this.offscreenPadding;
        ctx.drawImage(this.offscreen, this.pos.x - this.radius - padding, this.pos.y - this.radius - padding);
      } else {
        ctx.save();
        ctx.shadowColor = _Planetoid.SHADOW_COLOR;
        ctx.shadowBlur = _Planetoid.SHADOW_BLUR;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
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
        ctx.restore();
      }
      const sunX = state.sceneWidth / 2;
      const sunY = state.sceneHeight / 2;
      const toSunX = sunX - this.pos.x;
      const toSunY = sunY - this.pos.y;
      const distToSun = Math.sqrt(toSunX * toSunX + toSunY * toSunY);
      const angleToSun = Math.atan2(toSunY, toSunX);
      const overlayRotation = angleToSun + Math.PI / 2;
      const maxDist = Math.sqrt(state.sceneWidth * state.sceneWidth + state.sceneHeight * state.sceneHeight) / 2;
      const distT = Math.min(distToSun / maxDist, 1);
      const overlayAlpha = _Planetoid.SUN_MIN_ALPHA + distT * (_Planetoid.SUN_MAX_ALPHA - _Planetoid.SUN_MIN_ALPHA);
      ctx.save();
      ctx.globalCompositeOperation = "multiply";
      ctx.globalAlpha = overlayAlpha;
      ctx.translate(this.pos.x, this.pos.y);
      ctx.rotate(overlayRotation);
      const overlay = _Planetoid.getSunOverlayCanvas();
      const d = this.radius * 2;
      ctx.drawImage(overlay, -this.radius, -this.radius, d, d);
      ctx.restore();
      const overallDarkness = _Planetoid.SUN_MAX_DARKNESS * distT;
      if (overallDarkness > 0) {
        ctx.save();
        ctx.globalCompositeOperation = "multiply";
        ctx.globalAlpha = overallDarkness;
        ctx.fillStyle = "#000000";
        ctx.beginPath();
        ctx.arc(this.pos.x, this.pos.y, this.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  };

  // js/world/RoundedRectPlanetoid.js
  var RoundedRectPlanetoid = class {
    constructor(x, y, halfWidth, halfHeight, cornerRadius, color) {
      this.pos = new Vector2(x, y);
      this.halfWidth = halfWidth;
      this.halfHeight = halfHeight;
      this.cornerRadius = Math.min(cornerRadius, halfWidth, halfHeight);
      this.color = color;
      this.radius = Math.sqrt(halfWidth * halfWidth + halfHeight * halfHeight);
      this.mass = 2 * halfWidth * (2 * halfHeight);
      this.influenceRadius = this.radius + INFLUENCE_PADDING;
      let direction = new Vector2(Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      this.vel = direction.multiply(PLANET_SPEED);
      this.rotationAngle = Math.random() * Math.PI * 2;
      this.rotationSpeed = 6e-4;
      this.isSpikey = false;
      this.isRoundedRect = true;
      this.offscreen = null;
      this.offscreenPadding = 0;
      this.ringCanvas = null;
      this.interiorType = null;
      this.cachedAlpha = 0.3;
      this.lastAlphaUpdate = 0;
      this._segments = this.buildSegments();
    }
    worldToLocal(worldX, worldY) {
      const dx = worldX - this.pos.x;
      const dy = worldY - this.pos.y;
      const c = Math.cos(-this.rotationAngle), s = Math.sin(-this.rotationAngle);
      return { x: dx * c - dy * s, y: dx * s + dy * c };
    }
    localDirToWorld(lx, ly) {
      const c = Math.cos(this.rotationAngle), s = Math.sin(this.rotationAngle);
      return new Vector2(lx * c - ly * s, lx * s + ly * c);
    }
    localPointToWorld(lx, ly) {
      const w = this.localDirToWorld(lx, ly);
      w.x += this.pos.x;
      w.y += this.pos.y;
      return w;
    }
    // Returns { point: Vector2 (world), normal: Vector2 (world, unit,
    // outward), distance: number >= 0 } for the nearest boundary point to
    // the given WORLD point.
    nearestSurfacePoint(worldX, worldY) {
      const local = this.worldToLocal(worldX, worldY);
      const coreHW = this.halfWidth - this.cornerRadius;
      const coreHH = this.halfHeight - this.cornerRadius;
      const cr = this.cornerRadius;
      const cx = Math.max(-coreHW, Math.min(coreHW, local.x));
      const cy = Math.max(-coreHH, Math.min(coreHH, local.y));
      let dx = local.x - cx, dy = local.y - cy;
      let len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-6) {
        const distV = coreHW - Math.abs(local.x), distH = coreHH - Math.abs(local.y);
        if (distV < distH) {
          dx = local.x >= 0 ? 1 : -1;
          dy = 0;
        } else {
          dx = 0;
          dy = local.y >= 0 ? 1 : -1;
        }
        len = 1;
      }
      dx /= len;
      dy /= len;
      const sx = cx + dx * cr, sy = cy + dy * cr;
      const distance = Math.sqrt((local.x - sx) ** 2 + (local.y - sy) ** 2);
      return {
        point: this.localPointToWorld(sx, sy),
        normal: this.localDirToWorld(dx, dy),
        distance
      };
    }
    distanceToSurface(worldX, worldY) {
      return this.nearestSurfacePoint(worldX, worldY).distance;
    }
    // Standard rounded-box point-containment test: clamp to the core
    // (unrounded) rect, then check whether the leftover offset falls
    // within the corner radius — correctly covers flat-edge regions,
    // corner regions, and fully-interior points with one formula, same
    // spirit as nearestSurfacePoint above. Used for right-click "pull
    // star" target selection (see Player.trySelectPullTarget).
    containsPoint(worldX, worldY) {
      const local = this.worldToLocal(worldX, worldY);
      const coreHW = this.halfWidth - this.cornerRadius;
      const coreHH = this.halfHeight - this.cornerRadius;
      const cr = this.cornerRadius;
      const cx = Math.max(-coreHW, Math.min(coreHW, local.x));
      const cy = Math.max(-coreHH, Math.min(coreHH, local.y));
      const dx = local.x - cx, dy = local.y - cy;
      return dx * dx + dy * dy <= cr * cr;
    }
    // Segment order (clockwise from the right edge's midpoint): right
    // edge -> BR corner -> bottom edge -> BL corner -> left edge -> TL
    // corner -> top edge -> TR corner -> (back to start). Each corner's
    // startAngle is chosen so consecutive segments meet exactly, with
    // continuous position/tangent/normal across every seam.
    buildSegments() {
      const coreHW = this.halfWidth - this.cornerRadius;
      const coreHH = this.halfHeight - this.cornerRadius;
      const hw = this.halfWidth, hh = this.halfHeight, cr = this.cornerRadius;
      return [
        { type: "edge", length: 2 * coreHH, start: { x: hw, y: -coreHH }, dir: { x: 0, y: 1 }, normal: { x: 1, y: 0 } },
        { type: "corner", length: Math.PI / 2 * cr, center: { x: coreHW, y: coreHH }, startAngle: 0 },
        { type: "edge", length: 2 * coreHW, start: { x: coreHW, y: hh }, dir: { x: -1, y: 0 }, normal: { x: 0, y: 1 } },
        { type: "corner", length: Math.PI / 2 * cr, center: { x: -coreHW, y: coreHH }, startAngle: Math.PI / 2 },
        { type: "edge", length: 2 * coreHH, start: { x: -hw, y: coreHH }, dir: { x: 0, y: -1 }, normal: { x: -1, y: 0 } },
        { type: "corner", length: Math.PI / 2 * cr, center: { x: -coreHW, y: -coreHH }, startAngle: Math.PI },
        { type: "edge", length: 2 * coreHW, start: { x: -coreHW, y: -hh }, dir: { x: 1, y: 0 }, normal: { x: 0, y: -1 } },
        { type: "corner", length: Math.PI / 2 * cr, center: { x: coreHW, y: -coreHH }, startAngle: 3 * Math.PI / 2 }
      ];
    }
    getPerimeter() {
      let t = 0;
      for (const seg of this._segments) t += seg.length;
      return t;
    }
    // Given arc-length s (wraps), returns local { point:{x,y},
    // tangent:{x,y} (unit, direction of increasing s), normal:{x,y} (unit,
    // outward) }.
    pointAtLocalArcPosition(s) {
      const perimeter = this.getPerimeter();
      let remaining = (s % perimeter + perimeter) % perimeter;
      for (const seg2 of this._segments) {
        if (remaining <= seg2.length) {
          if (seg2.type === "edge") {
            return {
              point: { x: seg2.start.x + seg2.dir.x * remaining, y: seg2.start.y + seg2.dir.y * remaining },
              tangent: seg2.dir,
              normal: seg2.normal
            };
          }
          const angle = seg2.startAngle + remaining / this.cornerRadius;
          const c = Math.cos(angle), s2 = Math.sin(angle);
          return {
            point: { x: seg2.center.x + this.cornerRadius * c, y: seg2.center.y + this.cornerRadius * s2 },
            tangent: { x: -s2, y: c },
            normal: { x: c, y: s2 }
          };
        }
        remaining -= seg2.length;
      }
      const seg = this._segments[0];
      return { point: seg.start, tangent: seg.dir, normal: seg.normal };
    }
    // Inverse: given a LOCAL point already on/near the boundary, returns
    // the arc-length s that produced it. Used when the player lands, to
    // initialize their walk position from wherever they touched down.
    arcPositionForLocalPoint(lx, ly) {
      const coreHW = this.halfWidth - this.cornerRadius;
      const coreHH = this.halfHeight - this.cornerRadius;
      const cr = this.cornerRadius;
      const cumRightEdge = 2 * coreHH;
      const cumBR = cumRightEdge + Math.PI / 2 * cr;
      const cumBottomEdge = cumBR + 2 * coreHW;
      const cumBL = cumBottomEdge + Math.PI / 2 * cr;
      const cumLeftEdge = cumBL + 2 * coreHH;
      const cumTL = cumLeftEdge + Math.PI / 2 * cr;
      const cumTopEdge = cumTL + 2 * coreHW;
      const norm = (a) => (a % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      if (lx >= coreHW && ly >= coreHH) return cumRightEdge + norm(Math.atan2(ly - coreHH, lx - coreHW)) * cr;
      if (lx <= -coreHW && ly >= coreHH) return cumBottomEdge + (norm(Math.atan2(ly - coreHH, lx + coreHW)) - Math.PI / 2) * cr;
      if (lx <= -coreHW && ly <= -coreHH) return cumLeftEdge + (norm(Math.atan2(ly + coreHH, lx + coreHW)) - Math.PI) * cr;
      if (lx >= coreHW && ly <= -coreHH) return cumTopEdge + (norm(Math.atan2(ly + coreHH, lx - coreHW)) - 3 * Math.PI / 2) * cr;
      if (lx > coreHW) return ly + coreHH;
      if (ly > coreHH) return cumBR + (coreHW - lx);
      if (lx < -coreHW) return cumBL + (coreHH - ly);
      if (ly < -coreHH) return cumTL + (lx + coreHW);
      const distR = coreHW - lx, distL = lx + coreHW, distB = coreHH - ly, distT = ly + coreHH;
      const minH = Math.min(distR, distL), minV = Math.min(distB, distT);
      if (minH < minV) return distR < distL ? ly + coreHH : cumBL + (coreHH - ly);
      return distB < distT ? cumBR + (coreHW - lx) : cumTL + (lx + coreHW);
    }
    arcPositionForWorldPoint(worldX, worldY) {
      const local = this.worldToLocal(worldX, worldY);
      return this.arcPositionForLocalPoint(local.x, local.y);
    }
    // World-space wrapper: returns { point: Vector2 (world, pushed
    // outward by pushDistance), normal: Vector2 (world, unit) }. Player
    // uses pushDistance=PLAYER_RADIUS, Coin uses pushDistance=
    // COIN_ORBIT_OFFSET — same parameterization, different offset.
    worldPointAtArcPosition(s, pushDistance = 0) {
      const local = this.pointAtLocalArcPosition(s);
      const normal = this.localDirToWorld(local.normal.x, local.normal.y);
      const surfacePoint = this.localPointToWorld(local.point.x, local.point.y);
      const point = pushDistance !== 0 ? surfacePoint.add(normal.clone().multiply(pushDistance)) : surfacePoint;
      return { point, normal };
    }
    // Same recipe as Planetoid.js: bake texture+color tint once, then
    // bake the glow once onto a padded canvas, then bake the dashed
    // influence ring once. Uses ctx.roundRect() instead of a circular
    // arc. Reuses Planetoid's static shadow constants + shared sun-
    // overlay sprite for visual consistency without extending that
    // (circle-specific) class.
    createOffscreen() {
      const w = this.halfWidth * 2, h = this.halfHeight * 2;
      const bodyCanvas = document.createElement("canvas");
      bodyCanvas.width = w;
      bodyCanvas.height = h;
      const bodyCtx = bodyCanvas.getContext("2d");
      bodyCtx.save();
      bodyCtx.beginPath();
      bodyCtx.roundRect(0, 0, w, h, this.cornerRadius);
      bodyCtx.clip();
      const tiles = 2.5;
      const texSize = Math.max(w, h) * tiles;
      bodyCtx.drawImage(state.planetTexture, w / 2 - texSize / 2, h / 2 - texSize / 2, texSize, texSize);
      bodyCtx.restore();
      bodyCtx.save();
      bodyCtx.globalCompositeOperation = "multiply";
      bodyCtx.beginPath();
      bodyCtx.roundRect(0, 0, w, h, this.cornerRadius);
      bodyCtx.fillStyle = this.color;
      bodyCtx.fill();
      bodyCtx.globalCompositeOperation = "source-over";
      bodyCtx.restore();
      const padding = Planetoid.SHADOW_PADDING;
      this.offscreenPadding = padding;
      this.offscreen = document.createElement("canvas");
      this.offscreen.width = w + padding * 2;
      this.offscreen.height = h + padding * 2;
      const finalCtx = this.offscreen.getContext("2d");
      finalCtx.shadowColor = Planetoid.SHADOW_COLOR;
      finalCtx.shadowBlur = Planetoid.SHADOW_BLUR;
      finalCtx.drawImage(bodyCanvas, padding, padding);
      const ringPad = this.influenceRadius - this.radius;
      this.ringCanvas = document.createElement("canvas");
      this.ringCanvas.width = w + ringPad * 2;
      this.ringCanvas.height = h + ringPad * 2;
      const ringCtx = this.ringCanvas.getContext("2d");
      ringCtx.strokeStyle = "rgba(173,216,230,1)";
      ringCtx.lineWidth = 3;
      ringCtx.setLineDash([10, 5]);
      ringCtx.beginPath();
      ringCtx.roundRect(0, 0, w + ringPad * 2, h + ringPad * 2, this.cornerRadius + ringPad);
      ringCtx.stroke();
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
      ctx.translate(this.pos.x, this.pos.y);
      ctx.rotate(this.rotationAngle);
      if (this.ringCanvas) {
        ctx.save();
        ctx.globalAlpha = this.cachedAlpha;
        ctx.drawImage(this.ringCanvas, -this.ringCanvas.width / 2, -this.ringCanvas.height / 2);
        ctx.restore();
      }
      if (this.offscreen) {
        ctx.drawImage(this.offscreen, -this.offscreen.width / 2, -this.offscreen.height / 2);
      }
      const sunX = state.sceneWidth / 2, sunY = state.sceneHeight / 2;
      const toSunX = sunX - this.pos.x, toSunY = sunY - this.pos.y;
      const distToSun = Math.sqrt(toSunX * toSunX + toSunY * toSunY);
      const worldAngleToSun = Math.atan2(toSunY, toSunX);
      const localAngle = worldAngleToSun - this.rotationAngle;
      const hx = Math.cos(localAngle), hy = Math.sin(localAngle);
      const maxDist = Math.sqrt(state.sceneWidth ** 2 + state.sceneHeight ** 2) / 2;
      const distT = Math.min(distToSun / maxDist, 1);
      const overlayAlpha = Planetoid.SUN_MIN_ALPHA + distT * (Planetoid.SUN_MAX_ALPHA - Planetoid.SUN_MIN_ALPHA);
      const extent = Math.max(this.halfWidth, this.halfHeight) * 1.3;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(-this.halfWidth, -this.halfHeight, this.halfWidth * 2, this.halfHeight * 2, this.cornerRadius);
      ctx.clip();
      ctx.globalCompositeOperation = "multiply";
      ctx.globalAlpha = overlayAlpha;
      const grad = ctx.createLinearGradient(-hx * extent, -hy * extent, hx * extent, hy * extent);
      grad.addColorStop(0, "black");
      grad.addColorStop(1, "white");
      ctx.fillStyle = grad;
      ctx.fillRect(-this.halfWidth, -this.halfHeight, this.halfWidth * 2, this.halfHeight * 2);
      ctx.restore();
      const overallDarkness = Planetoid.SUN_MAX_DARKNESS * distT;
      if (overallDarkness > 0) {
        ctx.save();
        ctx.globalCompositeOperation = "multiply";
        ctx.globalAlpha = overallDarkness;
        ctx.fillStyle = "#000000";
        ctx.beginPath();
        ctx.roundRect(-this.halfWidth, -this.halfHeight, this.halfWidth * 2, this.halfHeight * 2, this.cornerRadius);
        ctx.fill();
        ctx.restore();
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
      this.color = "#A85417";
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
    });
  }
  function angleDiff(a, b) {
    let diff = (a - b + Math.PI) % (2 * Math.PI);
    if (diff < 0) diff += 2 * Math.PI;
    return Math.abs(diff - Math.PI);
  }

  // js/entities/world/Fireball.js
  var FIREBALL_SPEED = 14;
  var FIREBALL_LIFE = 70;
  var TRAIL_SPAWN_CHANCE = 0.9;
  var TRAIL_PARTICLE_LIFE_MIN = 14;
  var TRAIL_PARTICLE_LIFE_RANGE = 12;
  var OFFSCREEN_MARGIN = 400;
  var fireballSprite = null;
  function getFireballSprite() {
    if (fireballSprite) return fireballSprite;
    const size = 14;
    const core = 8;
    const padding = 24;
    const canvas = document.createElement("canvas");
    canvas.width = (size + padding) * 2;
    canvas.height = (size + padding) * 2;
    const ctx = canvas.getContext("2d");
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    ctx.shadowBlur = 20;
    ctx.shadowColor = "#ff4400";
    ctx.fillStyle = "#ffaa00";
    ctx.beginPath();
    ctx.arc(cx, cy, size, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 12;
    ctx.shadowColor = "#ffee00";
    ctx.fillStyle = "#ffff88";
    ctx.beginPath();
    ctx.arc(cx, cy, core, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fill();
    fireballSprite = canvas;
    return canvas;
  }
  var Fireball = class extends Entity {
    constructor(x, y, angle) {
      super();
      this.pos = new Vector2(x, y);
      this.vel = new Vector2(Math.cos(angle), Math.sin(angle)).multiply(FIREBALL_SPEED);
      this.life = FIREBALL_LIFE;
      this.trail = [];
      this.radius = 8;
    }
    get isDead() {
      return this.life <= 0;
    }
    update() {
      this.pos.add(this.vel);
      this.life--;
      if (Math.random() < TRAIL_SPAWN_CHANCE) {
        const spread = 10;
        const maxLife = TRAIL_PARTICLE_LIFE_MIN + Math.random() * TRAIL_PARTICLE_LIFE_RANGE;
        this.trail.push({
          x: this.pos.x + (Math.random() - 0.5) * spread,
          y: this.pos.y + (Math.random() - 0.5) * spread * 0.8,
          life: maxLife,
          maxLife,
          size: 3 + Math.random() * 6
        });
      }
      for (let i = this.trail.length - 1; i >= 0; i--) {
        this.trail[i].life--;
        if (this.trail[i].life <= 0) this.trail.splice(i, 1);
      }
      if (this.pos.x < -OFFSCREEN_MARGIN || this.pos.x > state.sceneWidth + OFFSCREEN_MARGIN || this.pos.y < -OFFSCREEN_MARGIN || this.pos.y > state.sceneHeight + OFFSCREEN_MARGIN) {
        this.life = 0;
      }
    }
    draw() {
      const ctx = state.ctx;
      for (const t of this.trail) {
        const a = t.life / t.maxLife;
        const ts = t.size * a;
        ctx.globalAlpha = a * 0.85;
        ctx.fillStyle = "#ff5500";
        ctx.beginPath();
        ctx.arc(t.x, t.y, ts * 1.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ffcc44";
        ctx.beginPath();
        ctx.arc(t.x, t.y, ts * 0.75, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      const sprite = getFireballSprite();
      ctx.drawImage(sprite, this.pos.x - sprite.width / 2, this.pos.y - sprite.height / 2);
    }
  };

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
      this.surfaceArcPos = 0;
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
      this.bootNaturalWidth = 232;
      this.bootNaturalHeight = 312;
      this.bootScale = 0.1;
      this.bodyScale = 0.1;
      this.bodyPartsConfig = {
        bodyY: 115,
        headY: -150,
        //-400,
        leftArmX: 136,
        leftArmY: 9,
        leftArmJointX: 73,
        leftArmJointY: 199,
        rightArmX: -186,
        rightArmY: -14,
        rightArmJointX: 119,
        rightArmJointY: 40,
        leftBootX: 111,
        leftBootY: 241,
        leftBootJointX: 83,
        leftBootJointY: 15,
        rightBootX: -142,
        rightBootY: 241,
        rightBootJointX: 77,
        rightBootJointY: 15
      };
      this.walkTime = 0;
      this.isWalking = false;
      this.strideLength = 90;
      this.armSwingScale = 0.5;
      this.groundOffset = 250;
      this.maxAimFromForward = (90 + 5) * Math.PI / 180;
      this.aimShoulderPos = null;
      this.aimWorldAngle = 0;
      this.aimRelativeAngle = 0;
      this.headLookScale = 0.6;
      this.headPivotFraction = 0.9;
      this.blasterMuzzleLength = 300;
      this.blasterAngleOffset = -5 * Math.PI / 180;
      this.fireCooldown = 150;
      this.lastShotTime = 0;
      this.pullTarget = null;
      this.pullAccel = 0.6;
      this.pullMaxSpeed = 9;
      this.mouseIdleThreshold = 2e3;
      this.mouseIdle = true;
      this.mazeBodyScale = 0.1;
      this.mazeMoveIdleThreshold = 300;
      this.invincibleDuration = 2e3;
      this.invincibleUntil = 0;
      this.scaledPartsReady = false;
      this.scaledParts = {};
      this.scaledBootCanvas = null;
    }
    invalidateScaledAssets() {
      this.scaledPartsReady = false;
      this.scaledParts = {};
      this.scaledBootCanvas = null;
    }
    // Bakes img at `scale` (its correct world-space size, i.e. size at
    // zoom=1) but rasterizes it internally at `scale * resolutionMultiplier`
    // pixels, so it stays crisp when the caller later draws it larger
    // (zoomed in) via the canvas' own scale transform. Returns both the
    // baked canvas and the world-space size it should actually be drawn
    // at, since those now differ.
    makeScaledSprite(img, scale, resolutionMultiplier = 1) {
      const displayWidth = Math.max(1, img.naturalWidth * scale);
      const displayHeight = Math.max(1, img.naturalHeight * scale);
      const bakeWidth = Math.max(1, Math.round(displayWidth * resolutionMultiplier));
      const bakeHeight = Math.max(1, Math.round(displayHeight * resolutionMultiplier));
      const canvas = document.createElement("canvas");
      canvas.width = bakeWidth;
      canvas.height = bakeHeight;
      canvas.getContext("2d").drawImage(img, 0, 0, bakeWidth, bakeHeight);
      return { canvas, displayWidth, displayHeight };
    }
    initScaledAssets() {
      const images = state.characterImages;
      const resMultiplier = Math.max(1, state.zoomMax || 2.5);
      if (images) {
        for (const key of ["body", "head", "leftarm", "rightarm", "leftboot", "rightboot"]) {
          const img = images[key];
          if (img && img.complete && img.naturalWidth > 0) {
            this.scaledParts[key] = this.makeScaledSprite(img, this.bodyScale, resMultiplier);
          }
        }
      }
      if (state.bootImage && state.bootImage.complete && state.bootImage.naturalWidth > 0) {
        this.scaledBootCanvas = this.makeScaledSprite(state.bootImage, this.bootScale, resMultiplier);
      }
      this.scaledPartsReady = true;
    }
    // ----------------------------
    // BLASTER (LEFT ARM) AIMING
    // ----------------------------
    // Computes the local rotation to feed into drawLimb for the left arm
    // so that — after accounting for the character's current orientation
    // on the planet and the left/right mirror flip — the arm visually
    // points at the mouse cursor in world space, clamped so it can swing
    // up to just past straight up/down but never point behind him.
    //
    // Two things make this trickier than a plain "aim at target" formula:
    //  1. "Forward" itself flips to the opposite world angle when the rig
    //     is mirrored (facing left) — see the mirror comment in draw().
    //  2. Because that mirror is a REFLECTION (not a rotation), a local
    //     rotation applied before it doesn't just get negated — it gets
    //     reflected. So converting "desired world angle" back into the
    //     local rotation parameter needs different math on each side.
    computeLeftArmAimAngle(orientation, dirSign, originPos) {
      const cfg = this.bodyPartsConfig;
      const s = this.bodyScale;
      const cosO = Math.cos(orientation);
      const sinO = Math.sin(orientation);
      const offsetX = cfg.leftArmX * dirSign;
      const offsetY = cfg.leftArmY;
      const wx = offsetX * cosO - offsetY * sinO;
      const wy = offsetX * sinO + offsetY * cosO;
      const shoulderX = originPos.x + wx * s;
      const shoulderY = originPos.y + wy * s;
      const cam = state.camera || { x: 0, y: 0 };
      const zoom = state.zoom || 1;
      const mouse = state.mouse || { x: shoulderX, y: shoulderY };
      const mouseWorldX = mouse.x / zoom + cam.x;
      const mouseWorldY = mouse.y / zoom + cam.y;
      const targetAngle = Math.atan2(mouseWorldY - shoulderY, mouseWorldX - shoulderX);
      const forwardAngle = dirSign > 0 ? orientation : orientation + Math.PI;
      let relative = Math.atan2(
        Math.sin(targetAngle - forwardAngle),
        Math.cos(targetAngle - forwardAngle)
      );
      relative = Math.max(-this.maxAimFromForward, Math.min(this.maxAimFromForward, relative));
      const clampedTargetAngle = forwardAngle + relative;
      this.aimShoulderPos = new Vector2(shoulderX, shoulderY);
      this.aimWorldAngle = clampedTargetAngle;
      this.aimRelativeAngle = relative;
      return this.worldAngleToLocalRotation(clampedTargetAngle, orientation, dirSign);
    }
    // Converts a desired WORLD-space angle into the local rotation
    // parameter drawLimb (or a head/other part's own ctx.rotate) expects,
    // accounting for the left/right mirror. Because that mirror is a
    // REFLECTION (not a rotation), this isn't just a sign flip — see the
    // comment on computeLeftArmAimAngle above for why.
    worldAngleToLocalRotation(desiredWorldAngle, orientation, dirSign) {
      if (dirSign > 0) {
        return desiredWorldAngle - orientation;
      }
      return orientation + Math.PI - desiredWorldAngle;
    }
    // ----------------------------
    // HEAD LOOK TILT
    // ----------------------------
    // Tilts the head partway toward the same clamped aim target the
    // blaster arm uses (computeLeftArmAimAngle, called earlier this frame
    // — this reads its cached aimRelativeAngle rather than recomputing
    // anything), scaled down by headLookScale so it reads as a natural
    // glance up/down rather than a full arm-like swing. headLookScale of
    // 1.0 would exactly match the arm's aim angle; lower values glance
    // less. Returns 0 (straight ahead) when aimRelativeAngle hasn't been
    // set yet.
    computeHeadLookTilt(orientation, dirSign) {
      const forwardAngle = dirSign > 0 ? orientation : orientation + Math.PI;
      const desiredWorldAngle = forwardAngle + this.headLookScale * this.aimRelativeAngle;
      return this.worldAngleToLocalRotation(desiredWorldAngle, orientation, dirSign);
    }
    // ----------------------------
    // FIRING
    // ----------------------------
    // Spawns a Fireball from the blaster's muzzle tip, using this frame's
    // cached aim (see computeLeftArmAimAngle). Only fires while in
    // "space" mode (the main planet-surface/flight gameplay), respects a
    // cooldown, and does nothing while dying/teleporting or before the
    // first aim has been computed.
    shootFireball() {
      if (this.mode !== "space" || this.isDying || this.isTeleporting) return;
      if (!this.aimShoulderPos) return;
      const now = Date.now();
      if (now - this.lastShotTime < this.fireCooldown) return;
      this.lastShotTime = now;
      const angle = this.aimWorldAngle + this.blasterAngleOffset;
      const muzzleDist = this.blasterMuzzleLength * this.bodyScale;
      const tipX = this.aimShoulderPos.x + Math.cos(angle) * muzzleDist;
      const tipY = this.aimShoulderPos.y + Math.sin(angle) * muzzleDist;
      state.fireballs.push(new Fireball(tipX, tipY, angle));
      if (state.audioManager && typeof state.audioManager.playShoot === "function") {
        state.audioManager.playShoot();
      }
    }
    // ----------------------------
    // PULL TARGET (right-click "pull star")
    // ----------------------------
    // Converts the current mouse position to world space (same approach
    // computeLeftArmAimAngle already uses) and checks it against every
    // planetoid — circular ones via a plain distance-to-center check,
    // the rounded-rect one via its own containsPoint(), since it isn't
    // truly circular. On a hit: sets pullTarget, and if currently
    // grounded, launches off the current planet with a real jump-strength
    // kick so the pull can actually take hold immediately (see below for
    // why that launch matters, not just a bare onSurface flip).
    trySelectPullTarget() {
      if (this.mode !== "space" || this.isDying || this.isTeleporting) return;
      const cam = state.camera || { x: 0, y: 0 };
      const zoom = state.zoom || 1;
      const mouse = state.mouse || { x: this.pos.x, y: this.pos.y };
      const worldX = mouse.x / zoom + cam.x;
      const worldY = mouse.y / zoom + cam.y;
      let best = null;
      let bestDistSq = Infinity;
      for (const planet of state.planetoids) {
        let hit;
        if (planet.isRoundedRect) {
          hit = typeof planet.containsPoint === "function" && planet.containsPoint(worldX, worldY);
        } else {
          const dx = worldX - planet.pos.x;
          const dy = worldY - planet.pos.y;
          hit = dx * dx + dy * dy <= planet.radius * planet.radius;
        }
        if (!hit) continue;
        const distSq = (worldX - planet.pos.x) ** 2 + (worldY - planet.pos.y) ** 2;
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          best = planet;
        }
      }
      if (best) {
        if (this.onSurface && this.currentPlanet) {
          const launchDir = this.pos.subtract(this.currentPlanet.pos).normalize();
          this.vel = launchDir.multiply(JUMP_STRENGTH);
        }
        this.pullTarget = best;
        this.onSurface = false;
        this.currentPlanet = null;
      }
    }
    clearPullTarget() {
      this.pullTarget = null;
    }
    // Called from gameLoop INSTEAD OF normal gravity while pullTarget is
    // set (see the comment on pullTarget in the constructor for why).
    // Constant acceleration toward the target's current center — not
    // distance-scaled like gravity — so it reads as a deliberate pull
    // rather than a weak ambient force, with a speed cap so it can't
    // build unbounded velocity if held a long time.
    applyPullForce() {
      if (this.onSurface) {
        this.pullTarget = null;
        return;
      }
      if (!this.pullTarget) return;
      if (!state.planetoids.includes(this.pullTarget)) {
        this.pullTarget = null;
        return;
      }
      const dx = this.pullTarget.pos.x - this.pos.x;
      const dy = this.pullTarget.pos.y - this.pos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1e-6) return;
      this.vel.x += dx / dist * this.pullAccel;
      this.vel.y += dy / dist * this.pullAccel;
      const speed = this.vel.length();
      if (speed > this.pullMaxSpeed) {
        this.vel = this.vel.multiply(this.pullMaxSpeed / speed);
      }
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
      this.vel = new Vector2(0, 0);
      this.onSurface = false;
      if (targetPos && targetMode === "platform") {
        this.platformPos = targetPos.clone();
      }
    }
    // ----------------------------
    // INVINCIBILITY
    // ----------------------------
    isInvincible() {
      return Date.now() < this.invincibleUntil;
    }
    // ----------------------------
    // DEATH
    // ----------------------------
    startDeath() {
      if (this.isInvincible()) return;
      if (!this.isDying) {
        this.isDying = true;
        this.deathStartTime = Date.now();
        this.deathScale = 1;
        this.deathRotation = 0;
        this.deathAlpha = 1;
        createDeathParticles(this.pos, 400);
        state.audioManager.playDeath();
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
    updateMazePosition() {
      const interior = this.currentInterior;
      const planet = this.currentPlanet;
      if (!interior || !planet) {
        console.warn("updatePlayerMazePosition: missing interior or planet");
        return;
      }
      const offsetX = planet.pos.x - interior.cols * interior.tileSize / 2;
      const offsetY = planet.pos.y - interior.rows * interior.tileSize / 2;
      this.pos.x = offsetX + this.mazeCol * interior.tileSize + interior.tileSize / 2;
      this.pos.y = offsetY + this.mazeRow * interior.tileSize + interior.tileSize / 2;
    }
    enterMazeMode() {
      const interior = this.currentPlanet?.interior;
      if (!interior) {
        console.error("Cannot enter maze: no planet or interior");
        return;
      }
      this.mode = "maze";
      this.currentInterior = interior;
      this.onSurface = false;
      this.mazeCol = interior.exitColLeft;
      this.mazeRow = interior.exitRow;
      this.mazeDir = new Vector2(1, 0);
      this.lastMoveTime = Date.now();
      this.updateMazePosition();
      this.invincibleUntil = Date.now() + this.invincibleDuration;
    }
    exitMazeMode() {
      this.mode = "space";
      this.currentInterior = null;
      if (this.currentPlanet) {
        const surfaceDist = this.currentPlanet.radius + PLAYER_RADIUS;
        this.pos.x = this.currentPlanet.pos.x + Math.cos(this.currentPlanet.beamAngle) * surfaceDist;
        this.pos.y = this.currentPlanet.pos.y + Math.sin(this.currentPlanet.beamAngle) * surfaceDist;
        this.angle = this.currentPlanet.beamAngle;
        this.onSurface = true;
        this.lastInfluencePlanet = this.currentPlanet;
      }
      this.invincibleUntil = Date.now() + this.invincibleDuration;
    }
    updatePlatformPosition() {
      const interior = this.currentInterior;
      const planet = this.currentPlanet;
      if (!interior || !planet) {
        console.warn("updatePlayerPlatformPosition: missing interior or planet");
        return;
      }
      const offsetX = planet.pos.x - interior.cols * interior.tileSize / 2;
      const offsetY = planet.pos.y - interior.rows * interior.tileSize / 2;
      this.pos.x = offsetX + this.platformPos.x;
      this.pos.y = offsetY + this.platformPos.y;
    }
    enterPlatformMode() {
      const interior = this.currentPlanet?.interior;
      if (!interior) {
        console.error("Cannot enter platform: no planet or interior");
        return;
      }
      this.mode = "platform";
      this.currentInterior = interior;
      this.onSurface = false;
      this.platformPos = new Vector2(
        (interior.exitColLeft + 0.5) * interior.tileSize,
        (interior.exitRow + 0.5) * interior.tileSize
      );
      this.platformVel = new Vector2(0, 0);
      const tileX = Math.floor(this.platformPos.x / interior.tileSize);
      const tileY = Math.floor(this.platformPos.y / interior.tileSize);
      const belowTile = interior.tiles[tileY + 1]?.[tileX];
      this.onGround = belowTile === "#" || belowTile === "H";
      this.updatePlatformPosition();
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
            this.startTeleport("space");
            return;
          }
          if (!this.currentInterior.walls[newRow]?.[newCol]) {
            this.mazeCol = newCol;
            this.mazeRow = newRow;
            this.mazeDir = new Vector2(dx || this.mazeDir.x, dy || this.mazeDir.y).normalize();
            if (dx !== 0) this.facingDirection = dx > 0 ? 1 : -1;
            this.walkTime += this.currentInterior.tileSize / this.strideLength * Math.PI * 2;
            this.lastMoveTime = now;
            this.updateMazePosition();
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
        this.updatePlatformPosition();
        return;
      }
      if (this.onSurface && this.currentPlanet && this.currentPlanet.isRoundedRect) {
        const planet = this.currentPlanet;
        this.isWalking = false;
        let ds = 0;
        if (keys["ArrowLeft"]) {
          ds = -PLAYER_LINEAR_SPEED;
          this.facingDirection = -1;
          this.isWalking = true;
        }
        if (keys["ArrowRight"]) {
          ds = PLAYER_LINEAR_SPEED;
          this.facingDirection = 1;
          this.isWalking = true;
        }
        this.surfaceArcPos += ds;
        const worldSurface = planet.worldPointAtArcPosition(this.surfaceArcPos, PLAYER_RADIUS);
        this.pos = worldSurface.point;
        if (this.isWalking) {
          this.walkTime += Math.abs(ds) / this.strideLength * Math.PI * 2;
        }
      } else if (this.onSurface && this.currentPlanet) {
        const surfaceDist = this.currentPlanet.radius + this.radius;
        const angularSpeed = PLAYER_LINEAR_SPEED / surfaceDist;
        this.isWalking = false;
        const prevAngle = this.angle;
        if (keys["ArrowLeft"]) {
          this.angle -= angularSpeed;
          this.facingDirection = -1;
          this.isWalking = true;
        }
        if (keys["ArrowRight"]) {
          this.angle += angularSpeed;
          this.facingDirection = 1;
          this.isWalking = true;
        }
        this.pos.x = this.currentPlanet.pos.x + Math.cos(this.angle) * surfaceDist;
        this.pos.y = this.currentPlanet.pos.y + Math.sin(this.angle) * surfaceDist;
        if (this.isWalking) {
          const distanceMoved = Math.abs(this.angle - prevAngle) * surfaceDist;
          this.walkTime += distanceMoved / this.strideLength * Math.PI * 2;
        }
      }
    }
    jump() {
      if (this.mode === "platform") {
        if (this.onGround) {
          this.platformVel.y = -JUMP_STRENGTH * 0.5;
          this.onGround = false;
          state.audioManager.playJump();
        }
        return;
      }
      if (this.onSurface && this.currentPlanet) {
        const direction = this.pos.subtract(this.currentPlanet.pos).normalize();
        this.vel = direction.multiply(JUMP_STRENGTH);
        this.onSurface = false;
        this.currentPlanet = null;
        state.audioManager.playJump();
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
    checkMazeDots() {
      if (this.mode != "maze") return;
      const interior = this.currentInterior;
      for (let i = interior.dots.length - 1; i >= 0; i--) {
        const d = interior.dots[i];
        if (d.x === this.mazeCol && d.y === this.mazeRow) {
          state.audioManager.playEatDot();
          interior.dots.splice(i, 1);
          state.score += 10;
        }
      }
      for (let i = interior.powerPellets.length - 1; i >= 0; i--) {
        const p = interior.powerPellets[i];
        if (p.x === this.mazeCol && p.y === this.mazeRow) {
          state.audioManager.playEatDot();
          interior.powerPellets.splice(i, 1);
          state.score += 50;
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
        if (t >= 1) state.gameOver = true;
        return;
      }
      if (this.isTeleporting) {
        const elapsed = Date.now() - this.teleportStartTime;
        const t = elapsed / this.teleportDuration;
        if (t >= 1) {
          this.isTeleporting = false;
          if (this.teleportTargetMode === "maze") {
            this.enterMazeMode();
          } else if (this.teleportTargetMode === "platform") {
            this.enterPlatformMode();
          } else {
            this.exitMazeMode();
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
      this.updateOrientationAndFacing();
    }
    // ----------------------------
    // MOUSE-DRIVEN FACING
    // ----------------------------
    // While the mouse is actively being used, the character faces
    // whichever side of him it's currently on — even if that's opposite
    // his direction of travel (a fun little "moonwalk" when aiming
    // backward while moving forward, left in on purpose). Once the mouse
    // has been idle for a while, facing just reverts to whatever move()
    // already set from arrow-key input.
    //
    // Also updates this.mouseIdle, which drawFullBody uses to decide
    // whether the arms should track the aim or sway together instead.
    //
    // Only meaningful in "space" mode (the full-body rig); a no-op
    // otherwise. Deliberately recomputes its own local `orientation`
    // rather than touching/reading anything shared with draw() — cheap
    // trig, and keeps the two computations independent so there's no risk
    // of them drifting out of sync during early-return frames (death,
    // teleport) where update() doesn't reach this point.
    updateOrientationAndFacing() {
      if (this.mode !== "space") return;
      const lastMove = state.lastMouseMoveTime || 0;
      this.mouseIdle = Date.now() - lastMove > this.mouseIdleThreshold;
      if (this.mouseIdle) return;
      let planet = this.onSurface ? this.currentPlanet : this.lastInfluencePlanet;
      let downDir = new Vector2(0, 1);
      if (planet) {
        if (planet.isRoundedRect) {
          const surface = planet.nearestSurfacePoint(this.pos.x, this.pos.y);
          downDir = surface.normal.clone().multiply(-1);
        } else {
          downDir = planet.pos.subtract(this.pos).normalize();
        }
      }
      const downAngle = Math.atan2(downDir.y, downDir.x);
      const orientation = downAngle - Math.PI / 2;
      const cam = state.camera || { x: 0, y: 0 };
      const zoom = state.zoom || 1;
      const mouse = state.mouse || { x: this.pos.x, y: this.pos.y };
      const mouseWorldX = mouse.x / zoom + cam.x;
      const mouseWorldY = mouse.y / zoom + cam.y;
      const tangentX = Math.cos(orientation);
      const tangentY = Math.sin(orientation);
      const toMouseX = mouseWorldX - this.pos.x;
      const toMouseY = mouseWorldY - this.pos.y;
      const projection = toMouseX * tangentX + toMouseY * tangentY;
      this.facingDirection = projection >= 0 ? 1 : -1;
    }
    // ----------------------------
    // BOOT DRAW HELPER (platform / death modes)
    // ----------------------------
    drawBoot(ctx) {
      const sprite = this.scaledBootCanvas;
      if (!sprite) return;
      ctx.drawImage(
        sprite.canvas,
        -sprite.displayWidth / 2,
        -sprite.displayHeight / 2,
        sprite.displayWidth,
        sprite.displayHeight
      );
    }
    // ----------------------------
    // FULL BODY DRAW HELPERS (planet-surface/space mode AND maze mode)
    // Ported from the standalone astronaut prototype: each limb has a
    // fixed offset from the rig's origin (rotated by `orientation`, the
    // same "up is away from the planet" angle already computed by the
    // caller) plus a "joint" pivot within its own image so it swings from
    // the right spot. `originPos` is passed in explicitly (rather than
    // always using this.pos) so the caller can offset the whole rig
    // outward from the planet without touching the physics position.
    //
    // Draws from the pre-scaled sprite cache (see initScaledAssets) rather
    // than resampling the source images every frame. cosO/sinO are passed
    // in from drawFullBody so they're computed once per frame, not once
    // per limb. Each sprite's displayWidth/Height (its correct world-space
    // size) is passed explicitly to drawImage, since the underlying cached
    // canvas is baked at a higher resolution than that (see
    // initScaledAssets) so zooming in stays crisp.
    // ----------------------------
    drawLimb(ctx, partKey, offsetX, offsetY, jointX, jointY, angle, orientation, originPos, cosO, sinO) {
      const sprite = this.scaledParts[partKey];
      if (!sprite) return;
      const s = this.bodyScale;
      ctx.save();
      const wx = offsetX * cosO - offsetY * sinO;
      const wy = offsetX * sinO + offsetY * cosO;
      ctx.translate(originPos.x + wx * s, originPos.y + wy * s);
      ctx.rotate(orientation + angle);
      ctx.drawImage(sprite.canvas, -jointX * s, -jointY * s, sprite.displayWidth, sprite.displayHeight);
      ctx.restore();
    }
    drawFullBody(ctx, orientation, originPos) {
      if (!this.scaledPartsReady) this.initScaledAssets();
      if (!this.scaledParts.body && !this.scaledParts.leftboot) {
        this.drawBoot(ctx);
        return;
      }
      const cfg = this.bodyPartsConfig;
      const s = this.bodyScale;
      const cosO = Math.cos(orientation);
      const sinO = Math.sin(orientation);
      const inMaze = this.mode === "maze";
      const mazeRecentlyMoved = inMaze && Date.now() - this.lastMoveTime < this.mazeMoveIdleThreshold;
      const walkAngle = mazeRecentlyMoved || this.onSurface && this.isWalking ? Math.sin(this.walkTime) * 0.6 : 0;
      const dirSign = this.facingDirection < 0 ? -1 : 1;
      let leftBootAngle = walkAngle;
      let rightBootAngle = -walkAngle;
      let leftArmAngle, rightArmAngle;
      if (inMaze) {
        const swayAngle = walkAngle * this.armSwingScale;
        leftArmAngle = swayAngle;
        rightArmAngle = swayAngle;
      } else {
        const aimAngle = this.computeLeftArmAimAngle(orientation, dirSign, originPos);
        if (this.mouseIdle) {
          const swayAngle = this.onSurface && this.isWalking ? walkAngle * this.armSwingScale : Math.sin(Date.now() * 15e-4) * 0.15;
          leftArmAngle = swayAngle;
          rightArmAngle = swayAngle;
        } else {
          leftArmAngle = aimAngle;
          rightArmAngle = walkAngle * this.armSwingScale;
        }
      }
      if (!inMaze && !this.onSurface) {
        leftBootAngle = -0.7;
        rightBootAngle = 0.7;
      }
      this.drawLimb(ctx, "leftboot", cfg.leftBootX, cfg.leftBootY, cfg.leftBootJointX, cfg.leftBootJointY, leftBootAngle, orientation, originPos, cosO, sinO);
      this.drawLimb(ctx, "leftarm", cfg.leftArmX, cfg.leftArmY, cfg.leftArmJointX, cfg.leftArmJointY, leftArmAngle, orientation, originPos, cosO, sinO);
      const bodySprite = this.scaledParts.body;
      if (bodySprite) {
        ctx.save();
        ctx.translate(originPos.x, originPos.y);
        ctx.rotate(orientation);
        ctx.drawImage(
          bodySprite.canvas,
          -bodySprite.displayWidth / 2,
          cfg.bodyY * s - bodySprite.displayHeight / 2,
          bodySprite.displayWidth,
          bodySprite.displayHeight
        );
        ctx.restore();
      }
      this.drawLimb(ctx, "rightboot", cfg.rightBootX, cfg.rightBootY, cfg.rightBootJointX, cfg.rightBootJointY, rightBootAngle, orientation, originPos, cosO, sinO);
      this.drawLimb(ctx, "rightarm", cfg.rightArmX, cfg.rightArmY, cfg.rightArmJointX, cfg.rightArmJointY, rightArmAngle, orientation, originPos, cosO, sinO);
      const headSprite = this.scaledParts.head;
      if (headSprite) {
        ctx.save();
        const headWX = -cfg.headY * sinO;
        const headWY = cfg.headY * cosO;
        const headBob = mazeRecentlyMoved || this.onSurface && this.isWalking ? Math.sin(this.walkTime * 2) * 0.03 : 0;
        const headLookTilt = inMaze || this.mouseIdle ? 0 : this.computeHeadLookTilt(orientation, dirSign);
        const headTilt = headBob + headLookTilt;
        ctx.translate(originPos.x + headWX * s, originPos.y + headWY * s);
        ctx.rotate(orientation + headTilt);
        const pivotY = headSprite.displayHeight * this.headPivotFraction;
        ctx.drawImage(
          headSprite.canvas,
          -headSprite.displayWidth / 2,
          -pivotY,
          headSprite.displayWidth,
          headSprite.displayHeight
        );
        ctx.restore();
      }
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
        this.drawBoot(ctx);
        ctx.shadowBlur = 0;
        ctx.restore();
        return;
      }
      if (this.isTeleporting) {
        scale = this.teleportScale;
        glow = this.teleportGlow;
      }
      ctx.save();
      if (this.isInvincible()) {
        const blink = Math.floor(Date.now() / 100) % 2 === 0;
        ctx.globalAlpha = blink ? 1 : 0.3;
      }
      if (this.mode === "platform") {
        const platformScale = 0.4;
        ctx.save();
        ctx.translate(this.pos.x, this.pos.y);
        ctx.scale(platformScale, platformScale);
        if (this.platformVel.x < 0) ctx.scale(-1, 1);
        this.drawBoot(ctx);
        ctx.restore();
        ctx.restore();
        return;
      }
      let orientation;
      let visualPos;
      let modeScale = 1;
      if (this.mode === "maze") {
        orientation = 0;
        visualPos = this.pos;
        modeScale = this.mazeBodyScale;
      } else {
        let planet = this.onSurface ? this.currentPlanet : this.lastInfluencePlanet;
        let downDir = new Vector2(0, 1);
        if (planet) {
          if (planet.isRoundedRect) {
            const surface = planet.nearestSurfacePoint(this.pos.x, this.pos.y);
            downDir = surface.normal.clone().multiply(-1);
          } else {
            downDir = planet.pos.subtract(this.pos).normalize();
          }
        }
        const downAngle = Math.atan2(downDir.y, downDir.x);
        orientation = downAngle - Math.PI / 2;
        const outwardDir = downDir.multiply(-1);
        visualPos = this.pos.clone().add(outwardDir.multiply(this.groundOffset * this.bodyScale));
      }
      ctx.save();
      if (this.isTeleporting) {
        ctx.shadowColor = "yellow";
        ctx.shadowBlur = 40 * glow;
      }
      const dirSign = this.facingDirection < 0 ? -1 : 1;
      const totalScale = scale * modeScale;
      ctx.translate(this.pos.x, this.pos.y);
      ctx.rotate(orientation);
      ctx.scale(dirSign * totalScale, totalScale);
      ctx.rotate(-orientation);
      ctx.translate(-this.pos.x, -this.pos.y);
      this.drawFullBody(ctx, orientation, visualPos);
      ctx.shadowBlur = 0;
      ctx.restore();
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
      this.orbitOffset = COIN_ORBIT_OFFSET;
      this.arcPos = planet.isRoundedRect ? Math.random() * planet.getPerimeter() : 0;
      this.arcSpeed = (Math.random() - 0.5) * 2;
      this.updatePosition();
    }
    updatePosition() {
      if (this.planet.isRoundedRect) {
        const world = this.planet.worldPointAtArcPosition(this.arcPos, this.orbitOffset);
        this.pos.x = world.point.x;
        this.pos.y = world.point.y;
      } else {
        this.pos.x = this.planet.pos.x + Math.cos(this.angle) * this.orbitRadius;
        this.pos.y = this.planet.pos.y + Math.sin(this.angle) * this.orbitRadius;
      }
    }
    update() {
      if (this.planet.isRoundedRect) {
        this.arcPos += this.arcSpeed;
      } else {
        this.angle += this.angularSpeed;
      }
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

  // js/entities/world/Explosion.js
  var EXPLOSION_DURATION = 400;
  var RING_MAX_RADIUS = 70;
  var FLASH_RADIUS = 30;
  var FLASH_FRACTION = 0.3;
  var PARTICLE_COUNT = 420;
  var Explosion = class extends Entity {
    constructor(x, y) {
      super();
      this.pos = new Vector2(x, y);
      this.startTime = Date.now();
      this.duration = EXPLOSION_DURATION;
      createDeathParticles(this.pos.clone(), PARTICLE_COUNT);
    }
    get isDead() {
      return Date.now() - this.startTime >= this.duration;
    }
    update() {
    }
    draw() {
      const ctx = state.ctx;
      const t = Math.min((Date.now() - this.startTime) / this.duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      ctx.save();
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = "#ffcc66";
      ctx.lineWidth = 4 * (1 - t) + 1;
      ctx.beginPath();
      ctx.arc(this.pos.x, this.pos.y, eased * RING_MAX_RADIUS, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      const flashT = Math.min(t / FLASH_FRACTION, 1);
      if (flashT < 1) {
        ctx.save();
        ctx.globalAlpha = 1 - flashT;
        const grad = ctx.createRadialGradient(this.pos.x, this.pos.y, 0, this.pos.x, this.pos.y, FLASH_RADIUS);
        grad.addColorStop(0, "rgba(255,255,220,1)");
        grad.addColorStop(0.4, "rgba(255,180,60,0.8)");
        grad.addColorStop(1, "rgba(255,100,20,0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(this.pos.x, this.pos.y, FLASH_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
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
        let dir;
        if (dominant.isRoundedRect) {
          const surface = dominant.nearestSurfacePoint(entity.pos.x, entity.pos.y);
          dir = surface.distance > 1e-6 ? new Vector2(surface.point.x - entity.pos.x, surface.point.y - entity.pos.y).normalize() : surface.normal.clone().multiply(-1);
        } else {
          dir = dominant.pos.subtract(entity.pos).normalize();
        }
        let grav = entity.GRAVITY_STRENGTH || 0.35;
        if (entity.isGroundPounding) grav *= entity.GROUND_POUND_GRAV_MULTIPLIER || 3;
        entity.vel.add(dir.multiply(grav));
      }
    }
    // For rect planets, "distance" is measured to the nearest SURFACE
    // point (not the center) — otherwise gravity range/direction near a
    // wide, non-circular shape would feel wrong (e.g. pulling toward the
    // center from far off to the side instead of straight down). Compared
    // against a plain circle's center-distance when picking the closest
    // candidate across mixed planet types — not perfectly apples-to-
    // apples, but both represent "how close/urgent this planet's gravity
    // is" in their own natural terms, and it's a reasonable simplification
    // given how large this feature already is.
    findDominantPlanet(pos) {
      let closest = null;
      let minDist = Infinity;
      for (const planet of this.planetoids) {
        let dist, withinRange;
        if (planet.isRoundedRect) {
          dist = planet.distanceToSurface(pos.x, pos.y);
          withinRange = dist < INFLUENCE_PADDING;
        } else {
          dist = pos.subtract(planet.pos).length();
          withinRange = dist < planet.influenceRadius;
        }
        if (withinRange && dist < minDist) {
          minDist = dist;
          closest = planet;
        }
      }
      return closest;
    }
  };

  // js/systems/CollisionSystem.js
  var CollisionSystem = class {
    // Shared helper: distance from a circle (pos, radius) to a planet's
    // true surface — nearestSurfacePoint for rect planets, plain
    // center-distance-minus-radius for circular ones. Used everywhere a
    // planet might be either shape, so each collision method doesn't need
    // its own copy of this branch.
    distanceToPlanetSurface(pos, planet) {
      if (planet.isRoundedRect) {
        return planet.distanceToSurface(pos.x, pos.y);
      }
      return pos.subtract(planet.pos).length() - planet.radius;
    }
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
        if (planet.isRoundedRect) {
          const surface = planet.nearestSurfacePoint(player.pos.x, player.pos.y);
          if (surface.distance <= PLAYER_RADIUS + SURFACE_TOLERANCE) {
            player.pos = surface.point.clone().add(surface.normal.clone().multiply(PLAYER_RADIUS));
            player.onSurface = true;
            player.currentPlanet = planet;
            player.lastInfluencePlanet = planet;
            player.surfaceArcPos = planet.arcPositionForWorldPoint(player.pos.x, player.pos.y);
            const impactVel = player.vel.clone();
            player.vel = new Vector2(0, 0);
            if (player.isGroundPounding) {
              player.isGroundPounding = false;
              const pushDir = surface.normal.clone().multiply(-1);
              planet.vel.add(pushDir.multiply(impactVel.length() * GROUND_POUND_PUSH_STRENGTH));
              createParticles(player.pos, 20);
            }
            return;
          }
          continue;
        }
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
          state.audioManager.playEatDot();
          coins.splice(i, 1);
          state.score++;
        }
      }
    }
    handlePlanetAsteroidCollisions(planetoids, asteroids) {
      const toBreak = /* @__PURE__ */ new Set();
      for (let p of planetoids) {
        for (let a of asteroids) {
          const dist = this.distanceToPlanetSurface(a.pos, p);
          if (dist < a.radius) {
            toBreak.add(a);
          }
        }
      }
      return toBreak;
    }
    // Checks every fireball against every asteroid, then every planetoid.
    // Each fireball can only register a single hit per frame (whichever
    // it's found to overlap first) — once it's hit something, it's spent
    // and doesn't get checked against further targets.
    //
    // Returns:
    //   hitFireballs     — Set of fireballs that hit something this frame
    //                       (caller should remove these from state.fireballs)
    //   toBreakAsteroids — Set of asteroids to break (pass to the
    //                       existing breakAsteroid() in game.js, same as
    //                       planet-asteroid collisions already do)
    //   planetHits       — array of { fireball, planet } pairs, for the
    //                       caller to apply a push impulse + spawn an
    //                       explosion at each impact
    handleFireballCollisions(fireballs, planetoids, asteroids) {
      const hitFireballs = /* @__PURE__ */ new Set();
      const toBreakAsteroids = /* @__PURE__ */ new Set();
      const planetHits = [];
      for (const f of fireballs) {
        let hit = false;
        for (const a of asteroids) {
          const dist = f.pos.subtract(a.pos).length();
          if (dist < f.radius + a.radius) {
            hitFireballs.add(f);
            toBreakAsteroids.add(a);
            hit = true;
            break;
          }
        }
        if (hit) continue;
        for (const p of planetoids) {
          const dist = this.distanceToPlanetSurface(f.pos, p);
          if (dist < f.radius) {
            hitFireballs.add(f);
            planetHits.push({ fireball: f, planet: p });
            break;
          }
        }
      }
      return { hitFireballs, toBreakAsteroids, planetHits };
    }
    // Maze ghosts track grid coordinates (mazeCol/mazeRow), same as the
    // player does while in the maze — so this is a tile match, not a
    // distance check. Any death this triggers goes through
    // player.startDeath(), which already handles the invincibility
    // window on its own, so no special-casing is needed here.
    handlePlayerMazeGhostCollisions(player, ghosts) {
      if (!ghosts) return;
      for (const g of ghosts) {
        if (player.mazeCol === g.mazeCol && player.mazeRow === g.mazeRow) {
          player.startDeath();
          return;
        }
      }
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

  // js/AudioManager.js
  var AudioManager = class {
    constructor() {
      this.eatDotIndex = 0;
      this.eatDotAudio0 = new Audio("sounds/eat_dot_0.wav");
      this.eatDotAudio1 = new Audio("sounds/eat_dot_1.wav");
      this.deathAudio = new Audio("sounds/death_0.wav");
      this.jumpAudio = new Audio("sounds/jump.wav");
      this.jumpSmallAudio = new Audio("sounds/jumpsmall.wav");
      this.bangLarge = new Audio("sounds/bangLarge.wav");
      this.bangMedium = new Audio("sounds/bangMedium.wav");
      this.bangSmall = new Audio("sounds/bangSmall.wav");
      [this.eatDotAudio0, this.eatDotAudio1, this.deathAudio, this.jumpAudio, this.jumpSmallAudio, this.bangLarge, this.bangMedium, this.bangSmall].forEach((audio) => {
        audio.volume = 0.5;
        audio.preload = "auto";
        audio.load();
      });
    }
    playEatDot() {
      const source = this.eatDotIndex === 0 ? this.eatDotAudio0 : this.eatDotAudio1;
      this.eatDotIndex = 1 - this.eatDotIndex;
      const audio = source.cloneNode(true);
      audio.play().catch((e) => console.log("Audio play failed:", e));
    }
    playDeath() {
      const audio = this.deathAudio.cloneNode(true);
      audio.play().catch((e) => console.log("Audio play failed:", e));
    }
    playJump() {
      const audio = this.jumpAudio.cloneNode(true);
      audio.play().catch((e) => console.log("Audio play failed:", e));
    }
    playJumpSmall() {
      const audio = this.jumpSmallAudio.cloneNode(true);
      audio.play().catch((e) => console.log("Audio play failed:", e));
    }
    playBang(size, position) {
      let audioSource;
      if (size === "large") audioSource = this.bangLarge;
      else if (size === "medium") audioSource = this.bangMedium;
      else if (size === "small") audioSource = this.bangSmall;
      else return;
      const dist = state.player.pos.subtract(position).length();
      let vol = 0.5 * Math.max(0, 1 - dist / 800);
      if (vol <= 0) return;
      const audio = audioSource.cloneNode(true);
      audio.volume = vol;
      audio.play().catch((e) => console.log("Audio play failed:", e));
    }
    // Optional: Reset method if needed for game restarts (e.g., call from initGame)
    reset() {
      this.eatDotIndex = 0;
    }
  };

  // js/ui/MiniMap.js
  var Minimap = class {
    constructor() {
      this.size = 240;
      this.margin = 20;
      this.backgroundColor = "rgba(6, 14, 24, 0.72)";
      this.gridColor = "rgba(80, 200, 255, 0.18)";
      this.borderColor = "rgba(100, 220, 255, 0.85)";
      this.cornerColor = "rgba(140, 230, 255, 1)";
      this.labelColor = "rgba(150, 230, 255, 0.85)";
      this.playerColor = "#ffffff";
      this.playerGlowColor = "rgba(255,255,255,0.35)";
      this.playerRadius = 5;
      this.specialColor = "#ffd23f";
      this.specialGlowColor = "rgba(255,210,63,0.5)";
      this.specialRadius = 3;
    }
    // Which planetoids get plotted as the yellow "special" dots. Reads
    // directly from state each call (rather than being passed in) to
    // match how every other system in this codebase already works.
    // Add state.rectPlanet here too if you want the rounded-rect planet
    // included on the map as well.
    getSpecialPlanets() {
      return [state.mazePlanet, state.platformPlanet].filter(Boolean);
    }
    worldToMapPoint(worldX, worldY, x0, y0) {
      return {
        x: x0 + worldX / state.sceneWidth * this.size,
        y: y0 + worldY / state.sceneHeight * this.size
      };
    }
    drawGlowDot(ctx, x, y, radius, dotColor, glowColor) {
      ctx.beginPath();
      ctx.fillStyle = glowColor;
      ctx.arc(x, y, radius * 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = dotColor;
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    draw() {
      if (!state.player || !state.sceneWidth || !state.sceneHeight || !state.canvas) return;
      const ctx = state.ctx;
      const gridSize = state.gridSize || 20;
      const x0 = state.canvas.width - this.margin - this.size;
      const y0 = state.canvas.height - this.margin - this.size;
      ctx.save();
      ctx.fillStyle = this.backgroundColor;
      ctx.fillRect(x0, y0, this.size, this.size);
      ctx.strokeStyle = this.gridColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= gridSize; i++) {
        const gx = x0 + i / gridSize * this.size;
        ctx.moveTo(gx, y0);
        ctx.lineTo(gx, y0 + this.size);
        const gy = y0 + i / gridSize * this.size;
        ctx.moveTo(x0, gy);
        ctx.lineTo(x0 + this.size, gy);
      }
      ctx.stroke();
      for (const planet of this.getSpecialPlanets()) {
        const p = this.worldToMapPoint(planet.pos.x, planet.pos.y, x0, y0);
        this.drawGlowDot(ctx, p.x, p.y, this.specialRadius, this.specialColor, this.specialGlowColor);
      }
      {
        const p = this.worldToMapPoint(state.player.pos.x, state.player.pos.y, x0, y0);
        this.drawGlowDot(ctx, p.x, p.y, this.playerRadius, this.playerColor, this.playerGlowColor);
      }
      ctx.strokeStyle = this.borderColor;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x0, y0, this.size, this.size);
      const bracket = Math.min(20, this.size * 0.12);
      ctx.strokeStyle = this.cornerColor;
      ctx.lineWidth = 2;
      const corners = [
        [x0, y0, 1, 1],
        [x0 + this.size, y0, -1, 1],
        [x0, y0 + this.size, 1, -1],
        [x0 + this.size, y0 + this.size, -1, -1]
      ];
      for (const [cx, cy, dx, dy] of corners) {
        ctx.beginPath();
        ctx.moveTo(cx, cy + bracket * dy);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx + bracket * dx, cy);
        ctx.stroke();
      }
      ctx.fillStyle = this.labelColor;
      ctx.font = "12px monospace";
      ctx.textAlign = "left";
      ctx.fillText("SECTOR MAP", x0 + 8, y0 - 8);
      ctx.restore();
    }
  };

  // js/effects/PullBeam.js
  var BEAM_COLOR = "rgba(120, 210, 255, 1)";
  var BEAM_GLOW_COLOR = "rgba(120, 210, 255, 0.35)";
  var BEAM_GLOW_WIDTH = 13;
  var BEAM_CORE_WIDTH = 4;
  var OUTLINE_COLOR = "rgba(120, 210, 255, 0.9)";
  var OUTLINE_GLOW_COLOR = "rgba(120, 210, 255, 0.3)";
  var OUTLINE_GLOW_WIDTH = 9;
  var OUTLINE_CORE_WIDTH = 3;
  var OUTLINE_PADDING = 8;
  var WAVE_COLOR = "rgba(215, 246, 255, 1)";
  var WAVE_GLOW_COLOR = "rgba(215, 246, 255, 0.4)";
  var WAVE_GLOW_WIDTH = 4;
  var WAVE_CORE_WIDTH = 1.5;
  var WAVE_AMPLITUDE = 5;
  var WAVE_FREQUENCY = 0.05;
  var WAVE_FREQUENCY_2 = 0.065;
  var WAVE_SPEED = 0.012;
  var WAVE_SAMPLE_SPACING = 8;
  function buildWavePoints(originX, originY, dirX, dirY, perpX, perpY, beamLength, frequency, phaseOffset, now) {
    const points = [];
    const numSamples = Math.max(2, Math.floor(beamLength / WAVE_SAMPLE_SPACING));
    for (let i = 0; i <= numSamples; i++) {
      const s = i / numSamples * beamLength;
      const wave = WAVE_AMPLITUDE * Math.sin(s * frequency - now * WAVE_SPEED + phaseOffset);
      points.push({
        x: originX + dirX * s + perpX * wave,
        y: originY + dirY * s + perpY * wave
      });
    }
    return points;
  }
  function strokePolyline(ctx, points) {
    if (points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
  }
  function drawPullIndicator() {
    const player = state.player;
    if (!player || !player.pullTarget || player.mode !== "space") return;
    const target = player.pullTarget;
    const ctx = state.ctx;
    const pulse = (Math.sin(Date.now() * 6e-3) + 1) / 2;
    const now = Date.now();
    ctx.save();
    const originX = player.aimShoulderPos ? player.aimShoulderPos.x : player.pos.x;
    const originY = player.aimShoulderPos ? player.aimShoulderPos.y : player.pos.y;
    const dx = target.pos.x - originX;
    const dy = target.pos.y - originY;
    const beamLength = Math.sqrt(dx * dx + dy * dy);
    ctx.beginPath();
    ctx.moveTo(originX, originY);
    ctx.lineTo(target.pos.x, target.pos.y);
    ctx.globalAlpha = 0.4 + pulse * 0.3;
    ctx.strokeStyle = BEAM_GLOW_COLOR;
    ctx.lineWidth = BEAM_GLOW_WIDTH;
    ctx.stroke();
    ctx.globalAlpha = 0.7 + pulse * 0.3;
    ctx.strokeStyle = BEAM_COLOR;
    ctx.lineWidth = BEAM_CORE_WIDTH;
    ctx.stroke();
    if (beamLength > 1e-3) {
      const dirX = dx / beamLength, dirY = dy / beamLength;
      const perpX = -dirY, perpY = dirX;
      const strand1 = buildWavePoints(originX, originY, dirX, dirY, perpX, perpY, beamLength, WAVE_FREQUENCY, 0, now);
      const strand2 = buildWavePoints(originX, originY, dirX, dirY, perpX, perpY, beamLength, WAVE_FREQUENCY_2, Math.PI, now);
      ctx.globalAlpha = 0.3 + pulse * 0.25;
      ctx.strokeStyle = WAVE_GLOW_COLOR;
      ctx.lineWidth = WAVE_GLOW_WIDTH;
      strokePolyline(ctx, strand1);
      strokePolyline(ctx, strand2);
      ctx.globalAlpha = 0.6 + pulse * 0.3;
      ctx.strokeStyle = WAVE_COLOR;
      ctx.lineWidth = WAVE_CORE_WIDTH;
      strokePolyline(ctx, strand1);
      strokePolyline(ctx, strand2);
    }
    if (target.isRoundedRect) {
      ctx.save();
      ctx.translate(target.pos.x, target.pos.y);
      ctx.rotate(target.rotationAngle);
      const w = target.halfWidth + OUTLINE_PADDING;
      const h = target.halfHeight + OUTLINE_PADDING;
      ctx.beginPath();
      ctx.roundRect(-w, -h, w * 2, h * 2, target.cornerRadius + OUTLINE_PADDING);
      ctx.globalAlpha = 0.4 + pulse * 0.4;
      ctx.strokeStyle = OUTLINE_GLOW_COLOR;
      ctx.lineWidth = OUTLINE_GLOW_WIDTH;
      ctx.stroke();
      ctx.globalAlpha = 0.7 + pulse * 0.3;
      ctx.strokeStyle = OUTLINE_COLOR;
      ctx.lineWidth = OUTLINE_CORE_WIDTH;
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(target.pos.x, target.pos.y, target.radius + OUTLINE_PADDING, 0, Math.PI * 2);
      ctx.globalAlpha = 0.4 + pulse * 0.4;
      ctx.strokeStyle = OUTLINE_GLOW_COLOR;
      ctx.lineWidth = OUTLINE_GLOW_WIDTH;
      ctx.stroke();
      ctx.globalAlpha = 0.7 + pulse * 0.3;
      ctx.strokeStyle = OUTLINE_COLOR;
      ctx.lineWidth = OUTLINE_CORE_WIDTH;
      ctx.stroke();
    }
    ctx.restore();
  }

  // js/game.js
  state.canvas = document.getElementById("gameCanvas");
  state.ctx = state.canvas.getContext("2d");
  state.canvas.width = window.innerWidth;
  state.canvas.height = window.innerHeight;
  var CELL_SIZE = 3e3;
  var GRID_SIZE = 20;
  var CENTER_CELL = { col: 10, row: 10 };
  var CELL_CHECK_INTERVAL = 15;
  state.sceneWidth = CELL_SIZE * GRID_SIZE;
  state.sceneHeight = CELL_SIZE * GRID_SIZE;
  state.gridSize = GRID_SIZE;
  var PLANETOIDS_PER_CELL = 10;
  var SPIKEY_PER_CELL = 10;
  var ASTEROIDS_PER_CELL = 20;
  var MAX_ENEMIES_PER_CELL = 5;
  var CHARACTER_IMAGE_SOURCES = {
    body: "img/body.png",
    head: "img/head.png",
    leftarm: "img/leftarm.png",
    rightarm: "img/rightarm.png",
    leftboot: "img/leftboot.png",
    rightboot: "img/rightboot.png"
  };
  state.characterImages = {};
  var assetsLoaded = 0;
  var ASSETS_TO_LOAD = 1 + Object.keys(CHARACTER_IMAGE_SOURCES).length;
  function onAssetLoaded() {
    assetsLoaded++;
    if (assetsLoaded === ASSETS_TO_LOAD) {
      initGame();
      gameLoop();
    }
  }
  state.planetTexture = new Image();
  state.planetTexture.src = "img/planet_texture_2.jpg";
  state.planetTexture.onload = onAssetLoaded;
  Object.entries(CHARACTER_IMAGE_SOURCES).forEach(([key, src]) => {
    const img = new Image();
    img.src = src;
    img.onload = onAssetLoaded;
    state.characterImages[key] = img;
  });
  state.bootImage = state.characterImages.leftboot;
  state.audioManager = new AudioManager();
  initResizeListener();
  state.mouse = { x: state.canvas.width / 2, y: state.canvas.height / 2 };
  state.lastMouseMoveTime = Date.now();
  state.canvas.addEventListener("mousemove", (e) => {
    const rect = state.canvas.getBoundingClientRect();
    state.mouse.x = e.clientX - rect.left;
    state.mouse.y = e.clientY - rect.top;
    state.lastMouseMoveTime = Date.now();
  });
  state.mouseDown = false;
  state.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  state.canvas.addEventListener("mousedown", (e) => {
    if (e.button === 0) {
      state.mouseDown = true;
      if (state.player) state.player.shootFireball();
    } else if (e.button === 2) {
      if (state.player) state.player.trySelectPullTarget();
    }
  });
  window.addEventListener("mouseup", (e) => {
    if (e.button === 0) {
      state.mouseDown = false;
    } else if (e.button === 2) {
      if (state.player) state.player.clearPullTarget();
    }
  });
  state.fireballs = [];
  state.explosions = [];
  state.zoom = 1;
  var ZOOM_MIN = 0.5;
  var ZOOM_MAX = 2.5;
  state.zoomMax = ZOOM_MAX;
  var ZOOM_STEP_PER_FRAME = 0.02;
  state.zoomTarget = null;
  state.preMazeZoom = state.zoom;
  var previousPlayerMode = null;
  var ZOOM_EASE_RATE = 0.06;
  var ZOOM_EASE_SNAP_THRESHOLD = 0.01;
  var FIREBALL_PLANET_PUSH_STRENGTH = 0.05;
  var STAR_TILE_SIZE = 2e3;
  state.starTileSize = STAR_TILE_SIZE;
  state.starCanvas = document.createElement("canvas");
  state.starCanvas.width = STAR_TILE_SIZE;
  state.starCanvas.height = STAR_TILE_SIZE;
  {
    const starCtx = state.starCanvas.getContext("2d");
    starCtx.fillStyle = "white";
    for (let i = 0; i < STAR_COUNT; i++) {
      const x = Math.random() * STAR_TILE_SIZE;
      const y = Math.random() * STAR_TILE_SIZE;
      const size = Math.random() * 2 + 1;
      starCtx.beginPath();
      starCtx.arc(x, y, size, 0, Math.PI * 2);
      starCtx.fill();
    }
  }
  var gravitySystem;
  var collisionSystem = new CollisionSystem();
  var aiSystem = new AISystem();
  var minimap = new Minimap();
  var cellCheckCounter = 0;
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
  function cellCoordFor(worldX, worldY) {
    return {
      col: Math.floor(worldX / CELL_SIZE),
      row: Math.floor(worldY / CELL_SIZE)
    };
  }
  function cellKey(col, row) {
    return `${col},${row}`;
  }
  function generateRegularPlanetoidsInCell(col, row) {
    const originX = col * CELL_SIZE;
    const originY = row * CELL_SIZE;
    const regularPlanetoids = [];
    for (let i = 0; i < PLANETOIDS_PER_CELL; i++) {
      const radius = 30 + Math.random() * 40;
      const x = originX + radius + Math.random() * (CELL_SIZE - 2 * radius);
      const y = originY + radius + Math.random() * (CELL_SIZE - 2 * radius);
      const color = planetColors[Math.floor(Math.random() * planetColors.length)];
      const p = new Planetoid(x, y, radius, color);
      p.createOffscreen();
      state.planetoids.push(p);
      regularPlanetoids.push(p);
    }
    return regularPlanetoids;
  }
  function generateHazardsAndExtrasInCell(col, row, regularPlanetoids, avoidPos = null, avoidRadius = 0) {
    const originX = col * CELL_SIZE;
    const originY = row * CELL_SIZE;
    const MAX_REROLLS = 20;
    const avoidRadiusSq = avoidRadius * avoidRadius;
    const isSafe = (x, y) => !avoidPos || (x - avoidPos.x) ** 2 + (y - avoidPos.y) ** 2 >= avoidRadiusSq;
    for (let i = 0; i < SPIKEY_PER_CELL; i++) {
      const radius = 25 + Math.random() * 15;
      let x, y, attempts = 0;
      do {
        x = originX + radius + Math.random() * (CELL_SIZE - 2 * radius);
        y = originY + radius + Math.random() * (CELL_SIZE - 2 * radius);
        attempts++;
      } while (!isSafe(x, y) && attempts < MAX_REROLLS);
      const p = new SpikeyPlanetoid(x, y, radius);
      p.createOffscreen();
      state.planetoids.push(p);
    }
    for (let i = 0; i < ASTEROIDS_PER_CELL; i++) {
      const radius = 20 + Math.random() * 25;
      let x, y, attempts = 0;
      do {
        x = originX + radius + Math.random() * (CELL_SIZE - 2 * radius);
        y = originY + radius + Math.random() * (CELL_SIZE - 2 * radius);
        attempts++;
      } while (!isSafe(x, y) && attempts < MAX_REROLLS);
      state.asteroids.push(new Asteroid(x, y, radius));
    }
    regularPlanetoids.forEach((planet) => {
      const numCoins = 4 + Math.floor(planet.radius / 10);
      for (let i = 0; i < numCoins; i++) {
        const coin = new Coin(planet);
        coin.angle = i / numCoins * Math.PI * 2 + Math.random() * 0.2;
        state.coins.push(coin);
      }
    });
    const safePlanetsForEnemies = avoidPos ? regularPlanetoids.filter((p) => isSafe(p.pos.x, p.pos.y)) : regularPlanetoids;
    const numEnemies = Math.min(MAX_ENEMIES_PER_CELL, safePlanetsForEnemies.length);
    for (let i = 0; i < numEnemies; i++) {
      const planet = safePlanetsForEnemies[Math.floor(Math.random() * safePlanetsForEnemies.length)];
      const color = enemyColors[i % enemyColors.length];
      state.enemies.push(new SpaceGhost(planet, color));
    }
  }
  function generateCell(col, row) {
    const key = cellKey(col, row);
    if (state.activeCells.has(key)) return [];
    state.activeCells.add(key);
    const regularPlanetoids = generateRegularPlanetoidsInCell(col, row);
    generateHazardsAndExtrasInCell(col, row, regularPlanetoids);
    return regularPlanetoids;
  }
  function cullDistantObjects(activeCellKeys) {
    for (let i = state.planetoids.length - 1; i >= 0; i--) {
      const p = state.planetoids[i];
      if (p.isPermanent) continue;
      const { col, row } = cellCoordFor(p.pos.x, p.pos.y);
      if (!activeCellKeys.has(cellKey(col, row))) {
        state.planetoids.splice(i, 1);
      }
    }
    const survivingPlanetoids = new Set(state.planetoids);
    state.asteroids = state.asteroids.filter((a) => {
      const { col, row } = cellCoordFor(a.pos.x, a.pos.y);
      return activeCellKeys.has(cellKey(col, row));
    });
    state.coins = state.coins.filter((c) => {
      if (!c.planet || !survivingPlanetoids.has(c.planet)) return false;
      const { col, row } = cellCoordFor(c.planet.pos.x, c.planet.pos.y);
      return activeCellKeys.has(cellKey(col, row));
    });
    state.enemies = state.enemies.filter((e) => {
      if (e.onSurface && e.planet) {
        if (!survivingPlanetoids.has(e.planet)) return false;
        const { col: col2, row: row2 } = cellCoordFor(e.planet.pos.x, e.planet.pos.y);
        return activeCellKeys.has(cellKey(col2, row2));
      }
      const { col, row } = cellCoordFor(e.pos.x, e.pos.y);
      return activeCellKeys.has(cellKey(col, row));
    });
  }
  function updateActiveCells() {
    const playerCell = cellCoordFor(state.player.pos.x, state.player.pos.y);
    const activeCellKeys = /* @__PURE__ */ new Set();
    for (let dRow = -1; dRow <= 1; dRow++) {
      for (let dCol = -1; dCol <= 1; dCol++) {
        const col = playerCell.col + dCol;
        const row = playerCell.row + dRow;
        if (col < 0 || col >= GRID_SIZE || row < 0 || row >= GRID_SIZE) continue;
        const key = cellKey(col, row);
        activeCellKeys.add(key);
        generateCell(col, row);
      }
    }
    for (const key of Array.from(state.activeCells)) {
      if (!activeCellKeys.has(key)) {
        state.activeCells.delete(key);
      }
    }
    cullDistantObjects(activeCellKeys);
  }
  function initGame() {
    state.planetoids = [];
    state.asteroids = [];
    state.coins = [];
    state.enemies = [];
    state.activeCells = /* @__PURE__ */ new Set();
    const centerOriginX = CENTER_CELL.col * CELL_SIZE;
    const centerOriginY = CENTER_CELL.row * CELL_SIZE;
    state.mazePlanet = new BeamPlanetoid(centerOriginX + CELL_SIZE * 0.55, centerOriginY + CELL_SIZE * 0.45, 250, "#8A2BE2", "rgba(255,0,255,1)");
    state.mazePlanet.interior = new MazeInterior(state.mazePlanet);
    state.mazePlanet.isPermanent = true;
    state.planetoids.push(state.mazePlanet);
    state.platformPlanet = new BeamPlanetoid(centerOriginX + CELL_SIZE * 0.3, centerOriginY + CELL_SIZE * 0.6, 250, "#55aa55", "rgba(57,255,20,1)");
    state.platformPlanet.interior = new PlatformInterior(state.platformPlanet);
    state.platformPlanet.isPermanent = true;
    state.planetoids.push(state.platformPlanet);
    state.rectPlanet = new RoundedRectPlanetoid(
      centerOriginX + CELL_SIZE * 0.75,
      centerOriginY + CELL_SIZE * 0.7,
      150,
      90,
      35,
      "#cc8844"
    );
    state.rectPlanet.isPermanent = true;
    state.planetoids.push(state.rectPlanet);
    state.mazePlanet.createOffscreen();
    state.platformPlanet.createOffscreen();
    state.rectPlanet.createOffscreen();
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
    state.activeCells.add(cellKey(CENTER_CELL.col, CENTER_CELL.row));
    const centerRegulars = generateRegularPlanetoidsInCell(CENTER_CELL.col, CENTER_CELL.row);
    const startingPlanet = centerRegulars[Math.floor(Math.random() * centerRegulars.length)];
    const surfaceDist = startingPlanet.radius + PLAYER_RADIUS;
    state.player = new Player(startingPlanet.pos.x, startingPlanet.pos.y - surfaceDist);
    state.player.onSurface = true;
    state.player.currentPlanet = startingPlanet;
    state.player.lastInfluencePlanet = startingPlanet;
    state.player.angle = Math.atan2(state.player.pos.y - startingPlanet.pos.y, state.player.pos.x - startingPlanet.pos.x);
    state.player.mode = "space";
    const SAFE_SPAWN_RADIUS = 400;
    generateHazardsAndExtrasInCell(CENTER_CELL.col, CENTER_CELL.row, centerRegulars, state.player.pos, SAFE_SPAWN_RADIUS);
    updateActiveCells();
    state.particles = [];
    state.fireballs = [];
    state.explosions = [];
    state.gameOver = false;
    state.levelComplete = false;
    state.audioManager.reset();
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
      if (p.isRoundedRect) {
        p.rotationAngle += p.rotationSpeed;
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
    state.audioManager.playBang(size, ast.pos);
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
    if (state.player.mode == "maze") state.player.updateMazePosition();
    updateAsteroids();
    let toBreak = collisionSystem.handlePlanetAsteroidCollisions(state.planetoids, state.asteroids);
    collisionSystem.handleElasticCollisions(state.planetoids);
    collisionSystem.handleElasticCollisions(state.asteroids);
    for (let a of toBreak) {
      breakAsteroid(a);
    }
    if (!state.player.isDying) {
      state.player.move(state.keys);
      if (state.player.mode != "maze") {
        if (state.player.pullTarget) {
          state.player.applyPullForce();
        } else {
          gravitySystem.applyTo(state.player);
        }
      }
      state.player.update();
      if (state.player.mode != "maze") collisionSystem.handlePlayerPlanetCollisions(state.player);
      if (state.mouseDown) state.player.shootFireball();
    } else {
      state.player.update();
    }
    aiSystem.updateEnemies(state.enemies, state.planetoids);
    if (state.player.mode === "maze" && state.player.currentPlanet?.interior) {
      aiSystem.updateInteriorGhosts(state.player.currentPlanet.interior);
      collisionSystem.handlePlayerMazeGhostCollisions(state.player, state.player.currentPlanet.interior.ghosts);
    }
    if (state.player.mode === "platform" && state.platformPlanet?.interior?.blobs) {
      state.platformPlanet.interior.blobs.forEach((b) => b.update());
    }
    state.coins.forEach((c) => c.update());
    state.fireballs.forEach((f) => f.update());
    const fireballResults = collisionSystem.handleFireballCollisions(state.fireballs, state.planetoids, state.asteroids);
    for (const a of fireballResults.toBreakAsteroids) {
      breakAsteroid(a);
      state.explosions.push(new Explosion(a.pos.x, a.pos.y));
    }
    for (const hit of fireballResults.planetHits) {
      const speed = hit.fireball.vel.length();
      const pushDir = hit.fireball.vel.clone().normalize();
      hit.planet.vel.add(pushDir.multiply(speed * FIREBALL_PLANET_PUSH_STRENGTH));
      state.explosions.push(new Explosion(hit.fireball.pos.x, hit.fireball.pos.y));
    }
    state.fireballs = state.fireballs.filter((f) => !f.isDead && !fireballResults.hitFireballs.has(f));
    state.explosions.forEach((e) => e.update());
    state.explosions = state.explosions.filter((e) => !e.isDead);
    state.particles.forEach((p) => p.update());
    state.particles = state.particles.filter((p) => p.life > 0);
    collisionSystem.handleCoinCollisions(state.player, state.coins);
    collisionSystem.handlePlayerAsteroidCollisions(state.player, state.asteroids);
    collisionSystem.handlePlayerEnemyCollisions(state.player, state.enemies);
    if (state.player.mode === "maze" && state.player.currentPlanet?.interior) {
      state.player.checkMazeDots();
    }
    cellCheckCounter++;
    if (cellCheckCounter >= CELL_CHECK_INTERVAL) {
      cellCheckCounter = 0;
      updateActiveCells();
    }
    if (state.player.mode === "maze" && previousPlayerMode !== "maze") {
      state.preMazeZoom = state.zoom;
      state.zoomTarget = ZOOM_MAX;
    } else if (previousPlayerMode === "maze" && state.player.mode !== "maze") {
      state.zoomTarget = state.preMazeZoom;
    }
    previousPlayerMode = state.player.mode;
    if (state.keys["+"] || state.keys["="]) {
      state.zoom = Math.min(ZOOM_MAX, state.zoom + ZOOM_STEP_PER_FRAME);
      state.zoomTarget = null;
    }
    if (state.keys["-"] || state.keys["_"]) {
      state.zoom = Math.max(ZOOM_MIN, state.zoom - ZOOM_STEP_PER_FRAME);
      state.zoomTarget = null;
    }
    if (state.zoomTarget !== null) {
      const diff = state.zoomTarget - state.zoom;
      if (Math.abs(diff) < ZOOM_EASE_SNAP_THRESHOLD) {
        state.zoom = state.zoomTarget;
        state.zoomTarget = null;
      } else {
        state.zoom += diff * ZOOM_EASE_RATE;
      }
    }
    const zoom = state.zoom;
    const visibleWidth = state.canvas.width / zoom;
    const visibleHeight = state.canvas.height / zoom;
    const camera = new Vector2();
    camera.x = state.player.pos.x - visibleWidth / 2;
    camera.y = state.player.pos.y - visibleHeight / 2;
    const maxCameraX = state.sceneWidth - visibleWidth;
    const maxCameraY = state.sceneHeight - visibleHeight;
    camera.x = maxCameraX > 0 ? Math.min(Math.max(camera.x, 0), maxCameraX) : maxCameraX / 2;
    camera.y = maxCameraY > 0 ? Math.min(Math.max(camera.y, 0), maxCameraY) : maxCameraY / 2;
    state.camera = camera;
    state.ctx.save();
    state.ctx.scale(zoom, zoom);
    state.ctx.translate(-camera.x, -camera.y);
    {
      const ts = state.starTileSize;
      const startX = Math.floor(camera.x / ts) * ts;
      const startY = Math.floor(camera.y / ts) * ts;
      const endX = camera.x + visibleWidth;
      const endY = camera.y + visibleHeight;
      for (let ty = startY; ty < endY; ty += ts) {
        for (let tx = startX; tx < endX; tx += ts) {
          state.ctx.drawImage(state.starCanvas, tx, ty);
        }
      }
    }
    state.planetoids.forEach((p) => p.draw());
    state.asteroids.forEach((a) => a.draw());
    state.player.draw();
    drawPullIndicator();
    state.enemies.forEach((e) => e.draw());
    state.coins.forEach((c) => c.draw());
    state.fireballs.forEach((f) => f.draw());
    state.particles.forEach((p) => p.draw());
    state.explosions.forEach((e) => e.draw());
    state.ctx.restore();
    state.ctx.fillStyle = "white";
    state.ctx.font = "24px Arial";
    state.ctx.textAlign = "left";
    state.ctx.fillText(`Level ${state.level} - Score: ${state.score}`, 20, 40);
    state.ctx.fillText(`FPS: ${state.fps.toFixed(1)}`, 20, 70);
    state.ctx.fillText(`Zoom: ${state.zoom.toFixed(1)}x (+/-)`, 20, 100);
    const playerCell = cellCoordFor(state.player.pos.x, state.player.pos.y);
    state.ctx.fillText(`Cell: (${playerCell.col}, ${playerCell.row})`, 20, 130);
    minimap.draw();
    requestAnimationFrame(gameLoop);
  }
})();
