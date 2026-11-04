// js/debug/Profiler.js
//
// F3: an on-screen table of how long each step of love.update and
// love.draw takes (see the Profiler.start/stop pairs in main.js). A port
// of lua/debug/Profiler.lua.
//
// Each row shows a step's average and worst time over the last half
// second, in milliseconds, plus a bar against the 60fps budget (16.7 ms).
// Rows are indented when a step is timed inside another one. Times are
// CPU time: drawing calls only queue work for the graphics card, so a
// draw step that's cheap here can still be slow on the GPU. The gap
// between the frame time at the top and update + draw is the rest of the
// frame: waiting for the graphics card and the screen (vsync).
//
// Two more lines under the frame time:
//   Draw calls: how many batches went to the graphics card (the whole of
//     the previous frame, this panel included). The browser's shim
//     doesn't count shader or canvas switches.
//   Memory: the JavaScript heap and how much garbage each frame makes on
//     average (what the garbage collector later has to clean up: the
//     cause of stutters that show in the worst column). Only Chrome
//     reports the heap; elsewhere this line says so.
//
// Off, every call returns straight away.

import love from '../love/index.js';

const WINDOW_SECONDS = 0.5;  // how often the shown numbers refresh
const BUDGET_MS = 1000 / 60; // a full bar: one 60fps frame
const BAR_WIDTH = 120;
const ROW_HEIGHT = 18;
const PANEL_WIDTH = 410;

let enabled = false;

// Steps in the order they were first timed (see the Lua version for fields).
let steps = [];
let byName = new Map();
let depth = 0;

let windowStart = null;
let windowFrames = 0;
let frameStart = null;
let frameWindowSum = 0, frameWindowMax = 0;
let shownFrameAvg = 0, shownFrameMax = 0, shownFps = 0;

// Draw calls and garbage, summed over the window, then shown as averages.
let drawCallWindow = 0, garbageWindow = 0;
let shownDrawCalls = 0, shownGarbageKb = 0, shownHeapMb = 0;
let lastHeap = null;
const heapBytes = () => (typeof performance !== 'undefined' && performance.memory
  ? performance.memory.usedJSHeapSize : null);

let font = null;

const Profiler = {};

Profiler.isEnabled = () => enabled;

Profiler.toggle = function () {
  enabled = !enabled;
  // Fresh numbers each time it's shown.
  steps = []; byName = new Map(); depth = 0;
  windowStart = null; windowFrames = 0; frameStart = null;
  frameWindowSum = 0; frameWindowMax = 0;
  shownFrameAvg = 0; shownFrameMax = 0; shownFps = 0;
  drawCallWindow = 0; garbageWindow = 0;
  shownDrawCalls = 0; shownGarbageKb = 0; shownHeapMb = 0;
  lastHeap = null;
};

Profiler.start = function (name) {
  if (!enabled) return;
  let s = byName.get(name);
  if (!s) {
    s = { name, depth, started: null, frameTotal: 0, windowSum: 0, windowMax: 0, shownAvg: 0, shownMax: 0 };
    byName.set(name, s);
    steps.push(s);
  }
  depth++;
  s.started = love.timer.getTime();
};

Profiler.stop = function (name) {
  if (!enabled) return;
  const s = byName.get(name);
  if (!s || s.started === null) return;
  s.frameTotal += love.timer.getTime() - s.started;
  s.started = null;
  depth--;
};

// Called once at the very end of each frame: folds this frame's times into
// the window, and every WINDOW_SECONDS turns the window into the numbers shown.
Profiler.endFrame = function () {
  if (!enabled) return;
  const now = love.timer.getTime();
  if (windowStart === null) windowStart = now;
  if (frameStart !== null) {
    const frame = now - frameStart;
    frameWindowSum += frame;
    if (frame > frameWindowMax) frameWindowMax = frame;
  }
  frameStart = now;
  windowFrames++;

  // Garbage: what the heap grew by since last frame. A collection in
  // between shrinks it instead, so those frames are left out (a slight
  // undercount).
  const heap = heapBytes();
  if (heap !== null && lastHeap !== null && heap > lastHeap) garbageWindow += heap - lastHeap;
  lastHeap = heap;
  drawCallWindow += love.graphics.getStats().drawcalls;

  for (const s of steps) {
    s.windowSum += s.frameTotal;
    if (s.frameTotal > s.windowMax) s.windowMax = s.frameTotal;
    s.frameTotal = 0;
  }

  const elapsed = now - windowStart;
  if (elapsed >= WINDOW_SECONDS) {
    for (const s of steps) {
      s.shownAvg = s.windowSum / windowFrames * 1000;
      s.shownMax = s.windowMax * 1000;
      s.windowSum = 0; s.windowMax = 0;
    }
    const timedFrames = Math.max(1, windowFrames - 1);
    shownFrameAvg = frameWindowSum / timedFrames * 1000;
    shownFrameMax = frameWindowMax * 1000;
    shownFps = windowFrames / elapsed;
    shownDrawCalls = drawCallWindow / windowFrames;
    shownGarbageKb = garbageWindow / windowFrames / 1024;
    shownHeapMb = heap === null ? 0 : heap / (1024 * 1024);
    drawCallWindow = 0; garbageWindow = 0;
    frameWindowSum = 0; frameWindowMax = 0;
    windowFrames = 0;
    windowStart = now;
  }
};

function barColor(ms) {
  const t = ms / BUDGET_MS;
  if (t < 0.25) return [0.35, 0.85, 0.45]; // green
  if (t < 0.6) return [0.95, 0.80, 0.30];  // amber
  return [0.95, 0.35, 0.30];               // red
}

const fixed = (n) => n.toFixed(2).padStart(6, ' ');

const drawCallsLine = () => `Draw calls ${shownDrawCalls.toFixed(0)}`;
const memoryLine = () => (lastHeap === null
  ? 'Memory: not reported by this browser'
  : `JS ${shownHeapMb.toFixed(1)} MB, garbage ${shownGarbageKb.toFixed(0)} KB/frame`);

// Screen space, top-right corner.
Profiler.draw = function () {
  if (!enabled) return;
  const g = love.graphics;
  font = font ?? g.newFont(13);
  const prevFont = g.getFont();
  g.setFont(font);

  const x = g.getWidth() - PANEL_WIDTH - 20;
  const y = 20;
  const height = (steps.length + 5) * ROW_HEIGHT + 16;
  g.setColor(0, 0, 0, 0.72);
  g.rectangle('fill', x, y, PANEL_WIDTH, height, 6, 6);

  const tx = x + 10;
  let ty = y + 8;
  g.setColor(1, 1, 1, 1);
  g.print(`Frame ${shownFrameAvg.toFixed(2)} ms (worst ${shownFrameMax.toFixed(2)})   ${shownFps.toFixed(0)} fps`, tx, ty);
  ty += ROW_HEIGHT;
  g.print(drawCallsLine(), tx, ty);
  ty += ROW_HEIGHT;
  g.print(memoryLine(), tx, ty);
  ty += ROW_HEIGHT;
  g.setColor(0.7, 0.7, 0.7, 1);
  g.print('step                  avg ms   worst', tx, ty);
  ty += ROW_HEIGHT;

  const barX = x + PANEL_WIDTH - BAR_WIDTH - 10;
  for (const s of steps) {
    g.setColor(1, 1, 1, 1);
    g.print('  '.repeat(s.depth) + s.name, tx, ty);
    g.print(`${fixed(s.shownAvg)}  ${fixed(s.shownMax)}`, tx + 140, ty);
    const [r, gr, b] = barColor(s.shownAvg);
    g.setColor(1, 1, 1, 0.12);
    g.rectangle('fill', barX, ty + 3, BAR_WIDTH, ROW_HEIGHT - 8);
    g.setColor(r, gr, b, 0.9);
    g.rectangle('fill', barX, ty + 3, Math.min(1, s.shownAvg / BUDGET_MS) * BAR_WIDTH, ROW_HEIGHT - 8);
    ty += ROW_HEIGHT;
  }

  g.setColor(0.7, 0.7, 0.7, 1);
  g.print('F3 to hide.  Bars: share of a 60fps frame.', tx, ty);
  g.setColor(1, 1, 1, 1);
  g.setFont(prevFont);
};

export default Profiler;
