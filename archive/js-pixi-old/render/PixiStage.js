// js/render/PixiStage.js
//
// ----------------------------
// WHY THIS IS A SEPARATE CANVAS, NOT #gameCanvas ITSELF
// ----------------------------
// A <canvas> element can only ever have ONE rendering context type for
// its entire lifetime — once .getContext('2d') has been called on it
// (which #gameCanvas already has, extensively: HUD text, the V.A.T.S.
// overlay, lock outline, aim indicator, minimap, game-over screens),
// handing that same element to Pixi would try to get a WebGL context
// on it, which browsers refuse once 2D has already claimed it. That
// wouldn't just fail to render Pixi content — it would silently break
// every one of those still-Canvas2D systems too, none of which are
// part of this migration phase. So Pixi gets its own, brand new canvas
// instead, inserted into the DOM and positioned to exactly match
// #gameCanvas at runtime (see initPixiStage below for why this is done
// by copying #gameCanvas's own computed position/size in JS, rather
// than assuming anything about css/styles.css).
//
// ----------------------------
// WHY IT'S BEHIND #gameCanvas, NOT IN FRONT
// ----------------------------
// #gameCanvas still hosts the HUD and every overlay effect (V.A.T.S.
// darkening, the lock outline, the aim indicator, the minimap) — all
// of that needs to stay visually on top of the game world. The new
// Pixi canvas (planetoids, player once ported, starfield) sits behind
// it. This also happens to be exactly correct for V.A.T.S.'s own
// darkening effect specifically: it's meant to dim the world below it,
// which is now provided by this Pixi layer instead of same-canvas
// content the way it used to be — no change needed there at all.
//
// ----------------------------
// WHY app.init() IS WRAPPED IN A REGULAR ASYNC FUNCTION, NOT AWAITED
// AT THE TOP LEVEL OF THIS MODULE
// ----------------------------
// Verified directly against the actual build command (`npx esbuild
// js/game.js --bundle --outfile=dist/bundle.js`, no --format flag):
// esbuild's default output format with no format specified is a plain
// synchronous IIFE, `(() => { ... })();` — and esbuild hard-errors
// ("Top-level await is currently not supported with the 'iife' output
// format") the moment any top-level await appears anywhere in the
// bundle. Rather than requiring a build-command change you'd need to
// remember every time, initPixiStage() below is a regular async
// function — perfectly fine to await INSIDE, just not at module top
// level — called once from game.js and its returned promise handled
// there.
import { Application, Container, Sprite, TilingSprite, Texture } from 'pixi.js';
import { state } from '../state.js';

let app = null;
let worldContainer = null; // camera/zoom container — position/scale updated every frame in updatePixiStage, mirroring state.ctx's own scale+translate exactly
let starfieldSprite = null;
let planetoidLayer = null; // all planetoid Containers (see Planetoid.js's own createPixiSprites) live here, as children
let asteroidLayer = null; // all asteroid Sprites (see Asteroid.js's own createPixiSprite) live here
let playerLayer = null; // the player's own mirrorContainer (see Player.js's own createPixiRig) lives here
let coinLayer = null; // all coin Containers (see Coin.js's own createPixiSprite) live here
let pullBeamLayer = null; // the pull-beam overlay's own Graphics objects (see PullBeam.js's own ensurePixiObjects) live here
let fireballLayer = null; // all fireball glow/trail/spark sprites (see Fireball.js's own createPixiSprite) live here
let explosionLayer = null; // all explosion ring/flash sprites (see Explosion.js's own createPixiSprite) live here
let domeForegroundLayer = null; // SkyDomePlanetoid's own "near glass" foreground pass (see its own updateForegroundGlassPixi) lives here — the highest zIndex of all, see its own setup comment for why

// Shared, solid-white circle texture for planetoids' own flat distance-
// darkening layer (see Planetoid.js draw()'s "Overall distance
// darkening" pass, currently a plain ctx.fillStyle='#000000' circle
// drawn fresh every frame). Pixi sprites tint cheaply on the GPU, so a
// single shared white circle — tinted to black per-planet via
// sprite.tint — covers every planet's darkness layer without needing
// its own per-planet baked canvas the way the glow/ring layers already
// have. Built once, lazily, the first time a planetoid asks for it.
let darknessTexture = null;
export function getDarknessTexture() {
  if (darknessTexture) return darknessTexture;
  const size = 256; // arbitrary reference resolution — this gets scaled per-planet at draw time, and a flat white fill has no fine detail to lose from upscaling, same reasoning as Planetoid's own sun-overlay bake
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  darknessTexture = Texture.from(canvas);
  return darknessTexture;
}

// Called once from game.js, before the game loop starts. Returns a
// promise — game.js awaits it inside its own async startup function,
// for the same top-level-await reason explained above.
export async function initPixiStage() {
  const existingCanvas = state.canvas; // #gameCanvas — never modified, only read from, for positioning

  app = new Application();
  await app.init({
    width: existingCanvas.width,
    height: existingCanvas.height,
    backgroundAlpha: 0, // transparent — #gameCanvas's own background (and anything drawn on it) must show through where nothing here covers it
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
    preference: 'webgl', // per PixiJS's own docs, WebGPU is feature-complete but browser inconsistencies make WebGL the recommended choice for production; autoDetectRenderer would still fall back to WebGL automatically if webgpu were requested and unavailable
    autoStart: false, // critical: Application auto-starts its own internal render loop by default (TickerPlugin) — left on, that's a SECOND, independent requestAnimationFrame loop competing with the existing game loop's own, both trying to render the same frame. Disabled here so the only render call is the explicit app.render() at the end of updatePixiStage below, driven by the existing single game loop — avoids wasted duplicate rendering (working directly against the performance goal of this migration) and avoids worldContainer's camera/zoom transform potentially being read one frame stale by an independently-timed second loop.
  });

  // Match #gameCanvas's own real, current on-screen position and size
  // exactly, read directly from its computed styles rather than
  // assumed from css/styles.css (which this migration doesn't have
  // visibility into) — robust to whatever that file actually contains,
  // including if it changes later.
  const rect = existingCanvas.getBoundingClientRect();
  const computed = window.getComputedStyle(existingCanvas);
  app.canvas.style.position = computed.position === 'static' ? 'absolute' : computed.position;
  app.canvas.style.left = `${rect.left + window.scrollX}px`;
  app.canvas.style.top = `${rect.top + window.scrollY}px`;
  app.canvas.style.width = computed.width;
  app.canvas.style.height = computed.height;
  // One below #gameCanvas's own stacking position, so it always renders
  // behind it regardless of either canvas's default stacking order.
  const existingZ = parseInt(computed.zIndex, 10);
  app.canvas.style.zIndex = String((Number.isFinite(existingZ) ? existingZ : 0) - 1);
  app.canvas.style.pointerEvents = 'none'; // all input handling stays exactly as it already is, targeting #gameCanvas — this layer is visual only

  existingCanvas.parentNode.insertBefore(app.canvas, existingCanvas);

  worldContainer = new Container();
  app.stage.addChild(worldContainer);

  // Explicit, deterministic z-order via zIndex, rather than relying
  // solely on addChildAt's implicit array-insertion-order placement
  // below — Pixi's own docs specifically warn addChildAt "may not work
  // nicely" once zIndex sorting is involved anywhere in the tree, and
  // this is the documented, recommended pattern for controlling render
  // order deliberately rather than by insertion-order side effect.
  app.stage.sortableChildren = true;
  worldContainer.zIndex = 1;

  planetoidLayer = new Container();
  planetoidLayer.zIndex = 0;
  worldContainer.addChild(planetoidLayer);

  // Between planetoidLayer and playerLayer, matching the original
  // Canvas2D draw order exactly: state.planetoids.forEach(...) ran
  // before state.asteroids.forEach(...), which ran before
  // state.player.draw(). Explicit zIndex here too, same reasoning as
  // app.stage's own fix above — worldContainer.sortableChildren is set
  // right after this block so these three zIndex values actually take
  // effect, rather than being silently ignored the way they would be
  // without it.
  asteroidLayer = new Container();
  asteroidLayer.zIndex = 1;
  worldContainer.addChild(asteroidLayer);

  playerLayer = new Container();
  playerLayer.zIndex = 2;
  worldContainer.addChild(playerLayer);

  // After playerLayer, matching the original Canvas2D draw order:
  // state.player.draw() ran, then drawPullIndicator() (and the other
  // overlay effects right after it — those stay Canvas2D for now,
  // only the pull beam itself has been ported).
  pullBeamLayer = new Container();
  pullBeamLayer.zIndex = 3;
  worldContainer.addChild(pullBeamLayer);

  // After pullBeamLayer, matching the original Canvas2D draw order:
  // drawPullIndicator() (and the other overlay effects) ran before
  // state.coins.forEach(c => c.draw()).
  coinLayer = new Container();
  coinLayer.zIndex = 4;
  worldContainer.addChild(coinLayer);

  // After coinLayer, matching the original Canvas2D draw order:
  // state.coins.forEach(c => c.draw()) ran before
  // state.fireballs.forEach(f => f.draw()).
  fireballLayer = new Container();
  fireballLayer.zIndex = 5;
  worldContainer.addChild(fireballLayer);

  // After fireballLayer, matching the original Canvas2D draw order:
  // state.fireballs.forEach(f => f.draw()) ran before
  // state.explosions.forEach(e => e.draw()) — explosions drew last of
  // everything currently in this migration's scope.
  explosionLayer = new Container();
  explosionLayer.zIndex = 6;
  worldContainer.addChild(explosionLayer);

  // After explosionLayer — the highest zIndex of all. SkyDomePlanetoid's
  // own "near glass" foreground pass (its own updateForegroundGlassPixi)
  // needs to render on top of literally everything that could be
  // standing inside the dome — player, coins, fireballs, explosions,
  // the pull beam — matching the original Canvas2D
  // drawForegroundGlass()'s own explicit "must run AFTER the player and
  // everything else" requirement. In the old Canvas2D model, THAT was
  // expressed by call order alone (later draw calls render on top); in
  // Pixi, z-order is what actually determines this, not when
  // updateForegroundGlassPixi happens to be called relative to the
  // player's own update — an earlier version of this reused
  // planetoidLayer for this pass, which sits BEHIND playerLayer (zIndex
  // 2), causing the player to incorrectly render in FRONT of the glass
  // that's meant to be between the camera and everything inside the
  // dome, including the player themselves.
  domeForegroundLayer = new Container();
  domeForegroundLayer.zIndex = 7;
  worldContainer.addChild(domeForegroundLayer);

  worldContainer.sortableChildren = true;

  // Starfield: the existing state.starCanvas is already a small,
  // pre-baked tile (see game.js's own STARFIELD comment for why it's a
  // tile and not one world-sized canvas) repeated across the visible
  // viewport every frame via a CPU loop of ctx.drawImage calls.
  // TilingSprite is Pixi's own purpose-built primitive for exactly
  // this — the same repeat, done on the GPU in a single draw call
  // instead of a CPU loop — so this wraps that SAME existing canvas as
  // a texture rather than re-generating the stars separately; the
  // random star positions/sizes stay byte-for-byte whatever game.js
  // already baked.
  // addressMode: 'repeat' — every Pixi texture defaults to
  // addressMode:'clamp-to-edge' (TextureStyle.defaultOptions,
  // confirmed directly against Pixi's real source, not assumed),
  // which without this would clamp this TilingSprite's own
  // out-of-[0,1]-range UV coordinates to the star tile's own edge
  // pixel instead of actually wrapping/repeating it. Discovered while
  // debugging SkyDomePlanetoid's own hex grid overlay, where the same
  // missing setting was far more visually obvious (dense hexagon
  // lines smearing into stretched bands) than it is here — a sparse,
  // mostly-dark star tile clamped to its own edge still reads as
  // roughly "stars on a dark background" even without genuine tiling,
  // which is exactly why this went unnoticed until now.
  const starTexture = Texture.from(state.starCanvas);
  starTexture.source.addressMode = 'repeat';
  starfieldSprite = new TilingSprite({ texture: starTexture, width: 100, height: 100 }); // width/height corrected every frame in updatePixiStage to match whatever's actually visible
  starfieldSprite.zIndex = 0; // behind worldContainer (zIndex 1) — see the explicit-zIndex comment above for why this isn't addChildAt(starfieldSprite, 0) instead
  // Added directly to app.stage, NOT worldContainer — TilingSprite has
  // its own tilePosition property specifically for scrolling a tiled
  // texture, which updatePixiStage drives directly from the camera
  // instead of relying on worldContainer's transform for this one
  // sprite; see updatePixiStage's own comment on tilePosition for why.
  app.stage.addChild(starfieldSprite);

  return app;
}

// Called every frame from game.js's gameLoop, AFTER camera/zoom have
// already been computed for this frame (mirrors exactly where the
// existing state.ctx.scale/translate call happens) — reuses that same
// state.camera/state.zoom rather than recomputing anything.
export function updatePixiStage() {
  if (!app) return; // hasn't finished initializing yet — first frame or two, harmless no-op

  const zoom = state.zoom;
  const camera = state.camera;

  // Mirrors ctx.scale(zoom, zoom); ctx.translate(-camera.x, -camera.y)
  // exactly: a world-space point (wx, wy) needs to land on screen at
  // ((wx - camera.x) * zoom, (wy - camera.y) * zoom). Pixi's own
  // Container transform applies as screenPos = position + local*scale,
  // so matching that requires scale = zoom and
  // position = -camera * zoom (not just -camera) — worked out
  // explicitly here since getting the position term wrong by a factor
  // of zoom is an easy, easy-to-miss mistake.
  worldContainer.scale.set(zoom);
  worldContainer.position.set(-camera.x * zoom, -camera.y * zoom);

  // Starfield sizing/scroll. Sized to the full CSS pixel dimensions of
  // Pixi's own canvas (app.screen), not the world-space visible
  // width/height state.visibleWidth/Height already tracks — a
  // TilingSprite's width/height define its own SCREEN-space footprint
  // directly; it isn't a child of worldContainer, so it isn't affected
  // by worldContainer's own zoom scale the way a plain sprite would be.
  starfieldSprite.width = app.screen.width;
  starfieldSprite.height = app.screen.height;
  // tilePosition scrolls the tile pattern in SCREEN pixels — camera is
  // in WORLD units, so this needs the same *zoom multiply as
  // worldContainer's own position above, for the star pattern to track
  // the camera at the correct on-screen speed as zoom changes.
  starfieldSprite.tilePosition.set(-camera.x * zoom, -camera.y * zoom);
  // Stars themselves should visually scale with zoom too (zooming in
  // makes them look bigger, same as everything else in the world) —
  // TilingSprite has its own separate tileScale for this, independent
  // of the sprite's own width/height above.
  starfieldSprite.tileScale.set(zoom);

  app.render();
}

// Planetoids currently represented as Pixi sprites, tracked separately
// from state.planetoids itself so a planetoid REMOVED from that array
// (pruned by the world's cell-streaming system as the player moves
// between regions, or destroyed some other way) can be detected —
// simply iterating state.planetoids each frame, as the original
// per-frame update loop did, only ever CREATES/UPDATES sprites; it has
// no way to notice one that's gone and needs tearing down. Left alone,
// that planetoid's Pixi Container just sits there forever at wherever
// it last was — visible, un-updated, with no actual game object behind
// it anymore, exactly the "planets that don't really exist" bug this
// fixes.
const trackedPlanetoids = new Set();

// Called once per frame from game.js in place of the old bare
// state.planetoids.forEach loop — does that same create/update work,
// PLUS the cleanup pass above that loop never had.
export function syncPlanetoidSprites(planetoids) {
  const currentSet = new Set(planetoids);

  for (const p of trackedPlanetoids) {
    if (currentSet.has(p)) continue;
    if (typeof p.destroyPixiSprite === 'function') {
      // RoundedRectPlanetoid/SkyDomePlanetoid both implement their own
      // destroyPixiSprite() — genuinely different internal sprite
      // structure than circular Planetoid (different property names on
      // pixiSprites, and for SkyDomePlanetoid specifically, entirely
      // separate dome/metal-base/grass sprites layered on top), so
      // cleanup needs to go through each subclass's own method rather
      // than the generic destructuring below, which only ever matched
      // circular Planetoid's own particular shape.
      p.destroyPixiSprite();
    } else if (p.pixiSprites) {
      const { ring, body, sunOverlay, darkness } = p.pixiSprites;
      // ring/body wrap this planetoid's OWN unique baked canvases
      // (this.ringCanvas/this.offscreen) — nothing else references
      // them, so destroying the texture (and its GPU-side source) too
      // is correct here, not just the sprite, or that texture memory
      // would leak every time a planetoid gets pruned.
      //
      // Optional chaining (?.) on all four as a defensive guard — this
      // block is reached via the p.pixiSprites truthiness check above,
      // and normally that guarantees all four properties exist too
      // (see createPixiSprites' own atomic assignment: they're only
      // ever set together, as one complete object, never partially).
      // Added after a real crash here (destroy() called on undefined)
      // whose exact root cause wasn't fully pinned down — this doesn't
      // explain what produced that inconsistent state, only prevents
      // it from crashing the game if it happens again.
      ring?.destroy({ texture: true, textureSource: true });
      body?.destroy({ texture: true, textureSource: true });
      // sunOverlay/darkness use SHARED textures (Planetoid's own
      // getSunOverlayCanvas, and getDarknessTexture above) — every
      // other still-alive planetoid uses these same texture objects,
      // so only the sprite gets destroyed here, deliberately leaving
      // texture/textureSource at their default false — destroying
      // those would break every other planet's shading/darkening the
      // moment any single one gets pruned.
      sunOverlay?.destroy();
      darkness?.destroy();
      // No separate container.destroy() here anymore — these four are
      // now added directly to planetoidLayer (see Planetoid.js's own
      // createPixiSprites for why the old per-planetoid wrapper
      // Container was removed), and each sprite's own destroy() above
      // already removes itself from planetoidLayer's children
      // automatically — confirmed directly against Pixi's actual
      // source (Container.destroy() calls this.removeFromParent()
      // internally), not assumed.
      p.pixiSprites = null;
    }
    trackedPlanetoids.delete(p);
  }

  for (const p of planetoids) {
    // isRoundedRect planetoids (RoundedRectPlanetoid, SkyDomePlanetoid)
    // used to be explicitly skipped here — out of scope for earlier
    // phases of this migration. Both now have their own working
    // createPixiSprites/updatePixiSprites (called polymorphically via
    // the same p.updatePixiSprites(planetoidLayer) call below, same as
    // every other planetoid type), so there's no reason to exclude
    // them anymore.
    p.updatePixiSprites(planetoidLayer);
    // Only tracked once pixiSprites is actually, verifiably built —
    // updatePixiSprites can legitimately no-op for a frame or several
    // (waiting on the renderer or this.ringCanvas — see
    // createPixiSprites' own early-return guards in Planetoid.js), and
    // this used to add p to trackedPlanetoids regardless, meaning a
    // planetoid could end up "tracked" without ever having a real
    // pixiSprites object — inconsistent bookkeeping worth fixing on
    // its own, whether or not it's what actually caused the crash
    // above.
    if (p.pixiSprites) trackedPlanetoids.add(p);
  }
}

// Same tracked-set pattern as trackedPlanetoids/syncPlanetoidSprites
// above, for asteroids — arguably MORE important here, since breaking
// an asteroid (fireball or planet impact) is a frequent, core
// gameplay event, not just an occasional world-streaming prune the way
// it is for planetoids.
const trackedAsteroids = new Set();

export function syncAsteroidSprites(asteroids) {
  const currentSet = new Set(asteroids);

  for (const a of trackedAsteroids) {
    if (currentSet.has(a)) continue;
    if (a.pixiSprite) {
      // Unlike Planetoid's ring/body vs. sunOverlay/darkness split,
      // there's no shared-texture concern here at all — the baked
      // canvas this sprite wraps is entirely unique to this one
      // asteroid (see Asteroid.js's own createPixiSprite), so a single
      // full destroy is correct and sufficient.
      a.pixiSprite.destroy({ texture: true, textureSource: true });
      a.pixiSprite = null;
    }
    trackedAsteroids.delete(a);
  }

  for (const a of asteroids) {
    a.updatePixiSprite(asteroidLayer);
    trackedAsteroids.add(a);
  }
}

// Same tracked-set pattern once more, for coins. Matters on the same
// order as fireballs (not just an occasional world-streaming prune the
// way it is for planetoids/asteroids) — a coin disappears the instant
// it's picked up (CollisionSystem.js's own handleCoinCollisions splices
// it out of state.coins directly), and there are typically many of
// them alive across a full 3x3 cell neighborhood at once.
const trackedCoins = new Set();

export function syncCoinSprites(coins) {
  const currentSet = new Set(coins);

  for (const c of trackedCoins) {
    if (currentSet.has(c)) continue;
    // destroyPixiSprite() (Coin.js's own method) — its own comment
    // explains why a coin has nothing shared with any other coin to
    // worry about, unlike Fireball/Explosion's own cleanup.
    c.destroyPixiSprite();
    trackedCoins.delete(c);
  }

  for (const c of coins) {
    c.updatePixiSprite(coinLayer);
    trackedCoins.add(c);
  }
}

// Same tracked-set pattern again, for fireballs — matters most of all
// three ported so far, given how short-lived and numerous fireballs
// are: every fireball that hits something or simply expires needs its
// sprites torn down promptly, or the "ghost" sprite problem this whole
// pattern exists to fix would compound quickly here in particular.
const trackedFireballs = new Set();

export function syncFireballSprites(fireballs) {
  const currentSet = new Set(fireballs);

  for (const f of trackedFireballs) {
    if (currentSet.has(f)) continue;
    // destroyPixiSprite() (Fireball.js's own method, not a bare
    // .destroy() call here) — a fireball manages several sprites at
    // once (the main glow, plus a pooled sprite per trail/spark
    // particle), all sharing textures with every OTHER fireball rather
    // than owning anything unique, so the cleanup itself needs to stay
    // local to Fireball.js, where that texture-sharing is already
    // understood, rather than duplicated here.
    f.destroyPixiSprite();
    trackedFireballs.delete(f);
  }

  for (const f of fireballs) {
    f.updatePixiSprite(fireballLayer);
    trackedFireballs.add(f);
  }
}

// Same tracked-set pattern once more, for explosions. state.explosions
// already gets filtered by its own isDead check (game.js:
// state.explosions = state.explosions.filter(e => !e.isDead)) BEFORE
// this runs each frame, so a just-expired explosion's Pixi objects get
// torn down the same frame it dies, not a frame later.
const trackedExplosions = new Set();

export function syncExplosionSprites(explosions) {
  const currentSet = new Set(explosions);

  for (const e of trackedExplosions) {
    if (currentSet.has(e)) continue;
    // destroyPixiSprite() (Explosion.js's own method) — manages two
    // separate Pixi objects (the ring Graphics and the flash Sprite,
    // the latter sharing its texture with every other explosion), same
    // reasoning as Fireball's own destroyPixiSprite above for why this
    // stays local to Explosion.js rather than duplicated here.
    e.destroyPixiSprite();
    trackedExplosions.delete(e);
  }

  for (const e of explosions) {
    e.updatePixiSprite(explosionLayer);
    trackedExplosions.add(e);
  }
}

export function getPlayerLayer() {
  return playerLayer;
}

export function getPullBeamLayer() {
  return pullBeamLayer;
}

export function getPlanetoidLayer() {
  return planetoidLayer;
}

export function getDomeForegroundLayer() {
  return domeForegroundLayer;
}

// Needed by anything baking its own visuals to a RenderTexture on the
// GPU (see Planetoid.js's own createGpuBodyTexture, which replaced its
// old Canvas2D createOffscreen() bake — that used to be the actual
// cause of the multi-planetoid-generation performance spike, since
// shadowBlur is a genuinely slow, CPU-bound Canvas2D operation; the GPU
// equivalent needs a real renderer.render({container, target}) call to
// bake a Container down to a texture, which only the renderer itself
// (not a Container or Sprite) exposes).
export function getRenderer() {
  return app ? app.renderer : null;
}