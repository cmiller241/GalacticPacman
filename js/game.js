// js/game.js
import { state } from './state.js';
import {
    DRAG,
    PLANET_SPEED,
    PLAYER_RADIUS,
    COIN_RADIUS,
    ENEMY_RADIUS,
    STAR_COUNT,
    planetColors,
    enemyColors
} from './constants.js';
import { Vector2 } from './vector2.js';
import { Planetoid, SpikeyPlanetoid, MazePlanetoid } from './planetoid.js';
import { Asteroid } from './asteroid.js';
import { Player } from './player.js';
import { Enemy } from './enemy.js';
import { Coin } from './coin.js';
import { MazeGhost } from './mazeghost.js';
import { initAudio, playDeath, playEatDot, initResizeListener, buildMazeData, getRandomPelletMazePos, getRandomOpenMazePos, checkMazeDots, createParticles, startTeleportToMaze, updatePlayerMazePosition, playBang } from './utils.js';

// Setup canvas and ctx
state.canvas = document.getElementById('gameCanvas');
state.ctx = state.canvas.getContext('2d');
// Set initial canvas size
state.canvas.width = window.innerWidth;
state.canvas.height = window.innerHeight;
state.sceneWidth = state.canvas.width * 2;
state.sceneHeight = state.canvas.height * 2;

// Load planet texture
state.planetTexture = new Image();
state.planetTexture.src = "img/planet_texture_2.jpg";
state.planetTexture.onload = () => {
    initGame();
    gameLoop();
};

// Init audio and resize
initAudio();
initResizeListener();

// Generate initial stars
state.stars = [];
for (let i = 0; i < STAR_COUNT; i++) {
    state.stars.push({
        x: Math.random() * state.sceneWidth,
        y: Math.random() * state.sceneHeight,
        size: Math.random() * 2 + 1
    });
}

// Event listeners
window.addEventListener('keydown', (e) => {
    state.keys[e.key] = true;
    if (e.key === ' ') {
        if (state.player.onSurface && !state.player.inMaze) state.player.jump();
        else if (!state.player.inMaze) state.player.tryGroundPound();
    }
    if (e.key === 'ArrowDown' && !state.player.inMaze) {
        if (state.player.onSurface && state.player.currentPlanet === state.mazePlanet) {
            const diff = Math.abs(((state.player.angle - state.mazePlanet.beamAngle + Math.PI) % (2 * Math.PI)) - Math.PI);
            if (diff < Math.PI / 5) {
                startTeleportToMaze();
            }
        }
    }
    if (e.key === 'Enter') {
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
window.addEventListener('keyup', (e) => { state.keys[e.key] = false; });

function initGame() {
    state.starCanvas = document.createElement('canvas');
    state.starCanvas.width = state.sceneWidth;
    state.starCanvas.height = state.sceneHeight;
    const starCtx = state.starCanvas.getContext('2d');
    starCtx.fillStyle='white';
    state.stars.forEach(star => {
        starCtx.beginPath();
        starCtx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
        starCtx.fill();
    });

    state.planetoids = [];
    // Create regular planetoids
    for (let i = 0; i < 44; i++) {
        const radius = 30 + Math.random() * 40; // 30-70
        const x = radius + Math.random() * (state.sceneWidth - 2 * radius);
        const y = radius + Math.random() * (state.sceneHeight - 2 * radius);
        const color = planetColors[Math.floor(Math.random() * planetColors.length)];
        state.planetoids.push(new Planetoid(x, y, radius, color));
    }
    // Create spikey planetoids
    for (let i = 0; i < 16; i++) {
        const radius = 25 + Math.random() * 15; // 25-40
        const x = radius + Math.random() * (state.sceneWidth - 2 * radius);
        const y = radius + Math.random() * (state.sceneHeight - 2 * radius);
        state.planetoids.push(new SpikeyPlanetoid(x, y, radius));
    }
    // === SPECIAL MAZE PLANET ===
    buildMazeData();
    state.mazePlanet = new MazePlanetoid(state.sceneWidth * 0.55, state.sceneHeight * 0.45, 250);
    state.planetoids.push(state.mazePlanet);
    // Initialize two miniature maze ghosts at random open positions
    let pos1 = getRandomPelletMazePos();
    let pos2 = getRandomPelletMazePos();
    while (pos2.col === pos1.col && pos2.row === pos1.row) {
        pos2 = getRandomPelletMazePos();
    }
    state.mazeGhosts = [
        new MazeGhost(pos1.col, pos1.row, 'red'),
        new MazeGhost(pos2.col, pos2.row, 'pink')
    ];
    state.asteroids = [];
    for (let i = 0; i < 24; i++) {
        const radius = 20 + Math.random() * 25; // 20-45
        const x = radius + Math.random() * (state.sceneWidth - 2 * radius);
        const y = radius + Math.random() * (state.sceneHeight - 2 * radius);
        state.asteroids.push(new Asteroid(x, y, radius));
    }
    const regularPlanets = state.planetoids.filter(p => !p.isSpikey && p !== state.mazePlanet);
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
    // Ensure asteroids not too close to player
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
            coin.angle = (i / numCoins) * Math.PI * 2 + Math.random() * 0.2;
            state.coins.push(coin);
        }
    });
    state.planetoids.forEach(p => p.createOffscreen());
    state.particles = [];
    state.gameOver = false;
    state.levelComplete = false;
    state.inMaze = false;
    state.eatDotIndex = 0; // Reset sound index on restart
}

function updatePlanetoids() {
    for (const p of state.planetoids) {
        p.pos.add(p.vel);
        if (p.pos.x - p.radius < 0) { p.pos.x = p.radius; p.vel.x = -p.vel.x; }
        if (p.pos.x + p.radius > state.sceneWidth) { p.pos.x = state.sceneWidth - p.radius; p.vel.x = -p.vel.x; }
        if (p.pos.y - p.radius < 0) { p.pos.y = p.radius; p.vel.y = -p.vel.y; }
        if (p.pos.y + p.radius > state.sceneHeight) { p.pos.y = state.sceneHeight - p.radius; p.vel.y = -p.vel.y; }
    }
}

function updateAsteroids() {
    for (const a of state.asteroids) {
        a.update();
    }
}

function handleCollisions() {
    // Planet-planet collisions
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
                const normal = offset.normalize(); // This still uses sqrt internally, but only when colliding
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
    // Asteroid-asteroid collisions
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
                const normal = offset.normalize(); // This still uses sqrt internally, but only when colliding
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
    // Planet-asteroid collisions
    let toBreak = new Set();
    for (let p of state.planetoids) {
        for (let a of state.asteroids) {
            const offset = p.pos.subtract(a.pos);
            const distSq = offset.x * offset.x + offset.y * offset.y;
            const sumR = p.radius + a.radius;
            const sumRSq = sumR * sumR;
            if (distSq < sumRSq) {
                const dist = Math.sqrt(distSq);
                const overlap = sumR - dist;
                const normal = offset.normalize(); // This still uses sqrt internally, but only when colliding
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
    // Break asteroids after all collisions
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
    if (ast.radius > 30) size = 'large';
    else if (ast.radius > 20) size = 'medium';
    else size = 'small';
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
        const delta = timestamp - state.lastFrameTime; // ms since last frame
        let instant = 1000 / delta;

        state.fps = state.fps * 0.9 + instant * 0.1;
    }
    state.lastFrameTime = timestamp;

    state.ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
    if (state.gameOver) {
        state.ctx.fillStyle = 'white';
        state.ctx.font = '48px Arial';
        state.ctx.textAlign = 'center';
        state.ctx.fillText('Game Over', state.canvas.width / 2, state.canvas.height / 2 - 20);
        state.ctx.font = '32px Arial';
        state.ctx.fillText(`Final Score: ${state.score}`, state.canvas.width / 2, state.canvas.height / 2 + 30);
        state.ctx.font = '24px Arial';
        state.ctx.fillText('Press Enter to Restart', state.canvas.width / 2, state.canvas.height / 2 + 70);
        state.player.isDying = 'false';
        requestAnimationFrame(gameLoop);
        return;
    } else if (state.levelComplete) {
        state.ctx.fillStyle = 'white';
        state.ctx.font = '48px Arial';
        state.ctx.textAlign = 'center';
        state.ctx.fillText('You beat the level!', state.canvas.width / 2, state.canvas.height / 2 - 20);
        state.ctx.font = '32px Arial';
        state.ctx.fillText(`Score: ${state.score}`, state.canvas.width / 2, state.canvas.height / 2 + 30);
        state.ctx.font = '24px Arial';
        state.ctx.fillText('Press Enter to start next level', state.canvas.width / 2, state.canvas.height / 2 + 70);
        requestAnimationFrame(gameLoop);
        return;
    }

    updatePlanetoids();
    if (state.inMaze) updatePlayerMazePosition();
    updateAsteroids();
    handleCollisions();

    // Only do normal player logic when NOT dying
    if (!state.player.isDying) {
        state.player.move(state.keys);
        if (!state.player.inMaze) state.player.applyGravity(state.planetoids);
        state.player.update();
        if (!state.player.inMaze) state.player.checkCollision(state.planetoids);
    } else {
        state.player.update();           // Run death animation
    }

    state.enemies.forEach(e => e.update(state.planetoids));
    state.mazeGhosts.forEach(g => g.update());
    state.coins.forEach(c => c.update());
    state.particles.forEach(p => p.update());
    state.particles = state.particles.filter(p => p.life > 0);
    checkCoinCollisions(); checkPlayerEnemyCollisions(); checkPlayerAsteroidCollisions();
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
    // Camera follows player
    const camera = new Vector2();
    camera.x = state.player.pos.x - state.canvas.width / 2;
    camera.y = state.player.pos.y - state.canvas.height / 2;
    // Clamp camera to scene bounds
    if (camera.x < 0) camera.x = 0;
    if (camera.y < 0) camera.y = 0;
    if (camera.x > state.sceneWidth - state.canvas.width) camera.x = state.sceneWidth - state.canvas.width;
    if (camera.y > state.sceneHeight - state.canvas.height) camera.y = state.sceneHeight - state.canvas.height;
    state.ctx.save();
    state.ctx.translate(-camera.x, -camera.y);
    state.ctx.drawImage(state.starCanvas, 0, 0);

    state.planetoids.forEach(p => p.draw());
    state.asteroids.forEach(a => a.draw());
    state.player.draw();
    state.enemies.forEach(e => e.draw());
    state.coins.forEach(c => c.draw());
    state.particles.forEach(p => p.draw());
    state.ctx.restore();
    // HUD
    state.ctx.fillStyle = 'white';
    state.ctx.font = '24px Arial';
    state.ctx.textAlign = 'left';
    state.ctx.fillText(`Level ${state.level} - Score: ${state.score}`, 20, 40);
    state.ctx.fillText(`FPS: ${state.fps.toFixed(1)}`, 20, 70);
    requestAnimationFrame(gameLoop);
}