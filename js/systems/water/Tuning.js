// js/systems/water/Tuning.js
//
// All of the water system's tunable numbers and colors: the simulation,
// spraying, portals, steam, lava, and the look of water and lava.
// Part of the water system: see js/systems/WaterSystem.js.

// ---------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------

const CELL = 16;
const STEP_SECONDS = 1 / 60;
const MAX_STEPS_PER_FRAME = 3;
const SPREAD = 0.25;
// Sideways passes each step: water falls a cell a step, but spreads this
// many times a step — so what lands (under a waterfall, say) runs out
// across the floor and finds its level quickly, like water, instead of
// heaping up and oozing outward like gel. (Falling stays a cell a step.)
const SPREAD_PASSES = 4;
const MIN_SPREAD = 0.02;
const EVAPORATE_PER_SECOND = 0.006;
const DRY = 0.002;

const SPRAY_PER_SECOND = 240;
const SPRAY_SPEED = 10, SPRAY_SPEED_RANGE = 3;
const SPRAY_SPREAD = 0.08;
const DROPLET_VOLUME = 0.1 / 3;
const DROPLET_SECONDS = 3;
const MAX_DROPLETS = 1200;
const HITS_POOL = 0.5;

const PORTAL_FLOW_PER_SECOND = 12;
const PORTAL_JET_VOLUME = 0.25;
const OCEAN_LEVEL_RATE = 0.6;
const OCEAN_LEVEL_SLACK = 0.5;
const PORTAL_JET_SPEED = 4, PORTAL_JET_SPEED_RANGE = 2;
const PORTAL_JET_SPREAD = 0.15;

const WATER_CAP = 1500;
const SPUTTER_FRACTION = 0.15;

const OCEAN_SEGMENTS = 72;
const OCEAN_MAX_SEGMENTS = 720;

const SPLASH_BITS = 4;
const SPLASH_SECONDS = 0.35;

const WATERFALL_SPLASH_PER_SECOND = 220;
const WATERFALL_SPLASH_MIN_FALL = 24;
const WATERFALL_SPLASH = {
  coneAngle: Math.PI * 0.6,
  speedScale: 0.35,
  lifeScale: 0.6,
  radiusScale: 0.35,
  lightMin: 0.7,
};

const QUENCH_AT = 0.25;
const BOIL_ON_HIT = 0.6;
const BOIL_PER_SECOND = 1.2;
const HOT_SECONDS = 2.5;
const BOIL_REACH_CELLS = 3;
const STEAM_BURST = 50;
const STEAM_PER_SECOND = 22;
const STEAM_SECONDS = 5;
const STEAM_RISE = 1.1;
const STEAM_START_DEPTH = 12;
const STEAM_SIZE = 2;
const STEAM_GROWTH = 14;
const STEAM_ALPHA = 0.32;
const COLOR_STEAM = [0.92, 0.95, 1.00];

// Lava (see "Lava meeting water" below): a second liquid on the same
// grids, moving by the same rules as the water — falling, running down
// slopes, spreading out along what it's resting on, filling pits — but
// thick and slow. (One object, as in the Lua, where a file's limited to
// 200 locals.)
const LAVA_TUNING = {
  STEP_EVERY: 4,        // it moves one step for every this many of the water's
  SPREAD: 0.2,          // (water: SPREAD)
  SPREAD_PASSES: 1,     // (water: SPREAD_PASSES — lava oozes out rather than racing to level)
  MIN_SPREAD: 0.35,     // thinner than this it stays put, so it lies in a thick layer instead of filming out
  RIPPLE: 0.4,          // its surface moves this much as much as water's
  TOUCH: 0.05,          // this much lava, or water, in a cell counts as touching the other (see obsidian)
  BOIL: 0.4,            // cells' worth of water boiled off at once when they meet
  PORTAL_FLOW: 4,       // cells' worth a second one portal takes in (water: PORTAL_FLOW_PER_SECOND)
  TILE_CELLS: 4,        // cells across a Tiled tile (64 world units) — obsidian forms a tile at a time
  // Its look (see getLavaShader) — the same churning plasma as Lava.js's.
  COLOR_DEEP: [0.45, 0.05, 0.02],
  COLOR_MID: [0.85, 0.28, 0.03],
  COLOR_HOT: [1.0, 0.65, 0.15],
  GLOW_BAND: 22,        // world units under the surface it's hottest over
  PLASMA_SCALE: 0.05,
  PLASMA_DETAIL: 2.6,
  EVOLVE_SPEED: 0.18,
  SCROLL_SPEED: 0.06,
  POUR_SPEED: 1.2,      // how fast the pattern runs down a falling stream
  // Embers off its surface (as Lava.js's): chance a frame for each cell of surface
  EMBER_CHANCE: 0.05,   // (less over a thin layer: see updateLavaEmbers)
  EMBER_RISE_MIN: 0.6, EMBER_RISE_MAX: 1.4,
  EMBER_DRIFT: 0.35,
  EMBER_LIFE_MIN: 0.9, EMBER_LIFE_MAX: 1.8, // seconds
  EMBER_RADIUS_MIN: 1.2, EMBER_RADIUS_MAX: 2.6,
};

const COLOR_SHALLOW = [0.30, 0.66, 1.00];
const COLOR_DEEP = [0.08, 0.26, 0.62];
const DEEP_AT = 140;
const ALPHA_SHALLOW = 0.50, ALPHA_DEEP = 0.82;
const COLOR_SURFACE = [0.82, 0.94, 1.00];
const SURFACE_LINE = 8;
const SURFACE_FEATHER = 2.5;
const STREAM_REACH_CELLS = 8;
const LIP_THICKNESS = 6;
const SURFACE_SLICES = 4;
const SURFACE_GLOW = 16;
const COLOR_CAUSTIC = [0.75, 0.92, 1.00];
const CAUSTIC_SCALE = 34;
const CAUSTIC_GROW_FROM_DEPTH = 60;
const CAUSTIC_GROW_POWER = 0.5;
const CAUSTIC_MAX_GROWTH = 5;
const SPHERE_COLOR_SHALLOW = [0.30, 0.66, 0.85];
const SPHERE_COLOR_DEEP = [0.05, 0.24, 0.52];
const SPHERE_COLOR_SHADE = [0.02, 0.05, 0.20];
const SPHERE_SHADE_STRENGTH = 0.9;
const SPHERE_COLOR_RIM = [0.55, 0.88, 0.98];
const SPHERE_RIM_STRENGTH = 0.5;
const SPHERE_COLOR_REFLECTED = [0.20, 0.38, 0.60];
const SPHERE_REFLECTED_STRENGTH = 0.8;
const CORE_OVERLAY_FROM_DEPTH = 20;
const CORE_OVERLAY_FULL_DEPTH = 400;
const CORE_OVERLAY_MAX = 0.85;
const CAUSTIC_BULGE = 1.0;
const CAUSTIC_SPEED = 0.6;
const CAUSTIC_STRENGTH = 0.3;
const COLOR_DROPLET = [0.70, 0.88, 1.00, 0.95];

export { CELL, STEP_SECONDS, MAX_STEPS_PER_FRAME, SPREAD, SPREAD_PASSES, MIN_SPREAD, EVAPORATE_PER_SECOND, DRY, SPRAY_PER_SECOND, SPRAY_SPEED, SPRAY_SPEED_RANGE, SPRAY_SPREAD, DROPLET_VOLUME, DROPLET_SECONDS, MAX_DROPLETS, HITS_POOL, PORTAL_FLOW_PER_SECOND, PORTAL_JET_VOLUME, OCEAN_LEVEL_RATE, OCEAN_LEVEL_SLACK, PORTAL_JET_SPEED, PORTAL_JET_SPEED_RANGE, PORTAL_JET_SPREAD, WATER_CAP, SPUTTER_FRACTION, OCEAN_SEGMENTS, OCEAN_MAX_SEGMENTS, SPLASH_BITS, SPLASH_SECONDS, WATERFALL_SPLASH_PER_SECOND, WATERFALL_SPLASH_MIN_FALL, WATERFALL_SPLASH, QUENCH_AT, BOIL_ON_HIT, BOIL_PER_SECOND, HOT_SECONDS, BOIL_REACH_CELLS, STEAM_BURST, STEAM_PER_SECOND, STEAM_SECONDS, STEAM_RISE, STEAM_START_DEPTH, STEAM_SIZE, STEAM_GROWTH, STEAM_ALPHA, COLOR_STEAM, LAVA_TUNING, COLOR_SHALLOW, COLOR_DEEP, DEEP_AT, ALPHA_SHALLOW, ALPHA_DEEP, COLOR_SURFACE, SURFACE_LINE, SURFACE_FEATHER, STREAM_REACH_CELLS, LIP_THICKNESS, SURFACE_SLICES, SURFACE_GLOW, COLOR_CAUSTIC, CAUSTIC_SCALE, CAUSTIC_GROW_FROM_DEPTH, CAUSTIC_GROW_POWER, CAUSTIC_MAX_GROWTH, SPHERE_COLOR_SHALLOW, SPHERE_COLOR_DEEP, SPHERE_COLOR_SHADE, SPHERE_SHADE_STRENGTH, SPHERE_COLOR_RIM, SPHERE_RIM_STRENGTH, SPHERE_COLOR_REFLECTED, SPHERE_REFLECTED_STRENGTH, CORE_OVERLAY_FROM_DEPTH, CORE_OVERLAY_FULL_DEPTH, CORE_OVERLAY_MAX, CAUSTIC_BULGE, CAUSTIC_SPEED, CAUSTIC_STRENGTH, COLOR_DROPLET };
