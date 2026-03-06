export const state = {
    canvas: null,
    ctx: null,
    sceneWidth: 0,
    sceneHeight: 0,
    player: null,
    planetoids: [],  // Includes regular, spikey, and maze planets
    asteroids: [],
    enemies: [],  // Ghosts
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
    lastAlphaUpdate: 0,  // If needed globally

    lastFrameTime: 0,
    fps: 0
    // Add any other runtime state here as needed
};