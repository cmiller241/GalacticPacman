// js/utils.js
import { state } from './state.js';
import { mazeLayout, MAZE_ROWS, MAZE_COLS, MAZE_TILE_SIZE, PLAYER_RADIUS, STAR_COUNT } from './constants.js';
import { Vector2 } from './vector2.js';
import { Particle } from './particle.js';

// Audio objects (initialized in initAudio)
let eatDotAudio0, eatDotAudio1, deathAudio, jumpAudio, jumpSmallAudio, bangLarge, bangMedium, bangSmall;

export function initAudio() {
    eatDotAudio0 = new Audio('sounds/eat_dot_0.wav');
    eatDotAudio1 = new Audio('sounds/eat_dot_1.wav');
    deathAudio = new Audio('sounds/death_0.wav');
    jumpAudio = new Audio('sounds/jump.wav');
    jumpSmallAudio = new Audio('sounds/jumpsmall.wav');
    bangLarge = new Audio('sounds/bangLarge.wav');
    bangMedium = new Audio('sounds/bangMedium.wav');
    bangSmall = new Audio('sounds/bangSmall.wav');
    [eatDotAudio0, eatDotAudio1, deathAudio, jumpAudio, jumpSmallAudio, bangLarge, bangMedium, bangSmall].forEach(audio => {
        audio.volume = 0.5;
        audio.preload = 'auto';
        audio.load();
    });
}

export function playEatDot() {
    const source = state.eatDotIndex === 0 ? eatDotAudio0 : eatDotAudio1;
    state.eatDotIndex = 1 - state.eatDotIndex; // Toggle between 0 and 1
    const audio = source.cloneNode(true);
    audio.play().catch(e => console.log('Audio play failed:', e));
}

export function playDeath() {
    const audio = deathAudio.cloneNode(true);
    audio.play().catch(e => console.log('Audio play failed:', e));
}

export function playJump() {
    const audio = jumpAudio.cloneNode(true);
    audio.play().catch(e => console.log('Audio play failed:', e));
}

export function playJumpSmall() {
    const audio = jumpSmallAudio.cloneNode(true);
    audio.play().catch(e => console.log('Audio play failed:', e));
}

export function playBang(size, position) {
    let audioSource;
    if (size === 'large') audioSource = bangLarge;
    else if (size === 'medium') audioSource = bangMedium;
    else if (size === 'small') audioSource = bangSmall;
    else return;

    const dist = state.player.pos.subtract(position).length();
    let vol = 0.5 * Math.max(0, 1 - dist / 800); // Fade out over 800 units distance
    if (vol <= 0) return;

    const audio = audioSource.cloneNode(true);
    audio.volume = vol;
    audio.play().catch(e => console.log('Audio play failed:', e));
}

// Maze helpers
export function getRandomOpenMazePos() {
    const opens = [];
    for (let row = 0; row < MAZE_ROWS; row++) {
        for (let col = 0; col < MAZE_COLS; col++) {
            if (!isWall(col, row)) {
                opens.push({ col, row });
            }
        }
    }
    return opens[Math.floor(Math.random() * opens.length)];
}

export function getRandomPelletMazePos() {
    const pellets = state.mazeDots.concat(state.powerPellets);
    const p = pellets[Math.floor(Math.random() * pellets.length)];
    return { col: p.x, row: p.y };
}

export function buildMazeData() {
    state.mazeWalls = Array.from({length: MAZE_ROWS}, () => Array(MAZE_COLS).fill(false));
    state.mazeDots = [];
    state.powerPellets = [];
    for (let row = 0; row < MAZE_ROWS; row++) {
        for (let col = 0; col < MAZE_COLS; col++) {
            const ch = mazeLayout[row][col];
            if (ch === '#') state.mazeWalls[row][col] = true;
            if (ch === '.' || ch === 'o') {
                const dot = {x: col, y: row};
                if (ch === 'o') state.powerPellets.push(dot);
                else state.mazeDots.push(dot);
            }
        }
    }
}

export function isWall(col, row) {
    if (row < 0 || row >= MAZE_ROWS) return true;
    if (col < 0) col = MAZE_COLS - 1;
    if (col >= MAZE_COLS) col = 0;
    return state.mazeWalls[row][col];
}

export function updatePlayerMazePosition() {
    const offsetX = state.mazePlanet.pos.x - (MAZE_COLS * MAZE_TILE_SIZE / 2);
    const offsetY = state.mazePlanet.pos.y - (MAZE_ROWS * MAZE_TILE_SIZE / 2);
    state.player.pos.x = offsetX + state.player.mazeCol * MAZE_TILE_SIZE + MAZE_TILE_SIZE / 2;
    state.player.pos.y = offsetY + state.player.mazeRow * MAZE_TILE_SIZE + MAZE_TILE_SIZE / 2;
}

export function enterMazeMode() {
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

export function startTeleportToMaze() {
    state.player.isTeleporting = true;
    state.player.teleportStartTime = Date.now();
    state.player.vel = new Vector2(0, 0);
    state.player.onSurface = false; // freeze motion
}

export function startTeleportFromMaze() {
    state.player.isTeleporting = true;
    state.player.teleportStartTime = Date.now();
    state.player.vel = new Vector2(0, 0);
    state.player.onSurface = false;
}

export function exitMazeMode() {
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

export function checkMazeDots() {
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

export function createParticles(atPos, count) {
    for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = Math.random() * 4 + 2;
        const vel = new Vector2(Math.cos(angle) * speed, Math.sin(angle) * speed);
        state.particles.push(new Particle(atPos, vel));
    }
}

export function createDeathParticles(atPos, count = 30) {
    for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = Math.random() * 6 + 3;
        const vel = new Vector2(Math.cos(angle) * speed, Math.sin(angle) * speed);
        const particle = new Particle(atPos, vel);
        particle.color = `hsl(${Math.random() * 60 + 20}, 100%, 50%)`; // Fiery oranges/yellows
        state.particles.push(particle);
    }
}

// Resize listener
export function initResizeListener() {
    window.addEventListener('resize', () => {
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