// tiled/gen-pinball-curves.js
//
// Generates the pinball curve REFERENCE sheet (run: node tiled/gen-pinball-curves.js):
//   img/pinball-curves.png        32px tiles, transparent, only the surface pixels drawn
//   img/pinball-curves-guide.png  same sheet at 4x with grid, solid-side tint and tile ids
//   lua/world/PinballCurveTiles.lua  tile id -> exact curve geometry (the source of truth
//                                    for collision; the art is drawn to match it, never read back)
//
// A drawn pixel is the OUTERMOST SOLID pixel of the surface. Tile ids are
// row-major, 0-based — the same local id Tiled assigns — so the sheet's
// layout must not be rearranged without regenerating the Lua table.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const T = 32;
const COLS = 16, ROWS = 62;
const W = COLS * T, H = ROWS * T;

// tx/ty/tw/th in tiles.
const BLOCKS = [
  { kind: "hole", r: 4, tx: 0, ty: 0 }, { kind: "disc", r: 4, tx: 8, ty: 0 },
  { kind: "hole", r: 3, tx: 0, ty: 8 }, { kind: "disc", r: 3, tx: 6, ty: 8 },
  { kind: "hole", r: 1, tx: 12, ty: 8 }, { kind: "disc", r: 1, tx: 14, ty: 8 },
  { kind: "diamond", tx: 12, ty: 10, tw: 2, th: 4 }, // steep, 1:2
  { kind: "diamond", tx: 14, ty: 10, tw: 2, th: 2 }, // 45 degrees
  { kind: "solid", tx: 14, ty: 12, tw: 1, th: 1 },
  { kind: "hole", r: 2, tx: 0, ty: 14 }, { kind: "disc", r: 2, tx: 4, ty: 14 },
  { kind: "diamond", tx: 8, ty: 14, tw: 4, th: 2 },  // gentle, 2:1
  // Appended below the original 18 rows so existing tile ids never change.
  { kind: "hole", r: 6, tx: 0, ty: 18 }, { kind: "disc", r: 6, tx: 0, ty: 30 },
  { kind: "hole", r: 5, tx: 0, ty: 42 }, { kind: "disc", r: 5, tx: 0, ty: 52 },
];
for (const b of BLOCKS) if (b.r) { b.tw = b.th = b.r * 2; }

function isSolid(b, x, y) { // block-local pixel
  const cx = b.tw * T / 2, cy = b.th * T / 2;
  const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
  if (b.kind === "solid") return true;
  if (b.kind === "diamond") return Math.abs(dx) / cx + Math.abs(dy) / cy < 1;
  const inside = Math.hypot(dx, dy) < b.r * T;
  return b.kind === "disc" ? inside : !inside;
}

const solid = new Uint8Array(W * H);
const edge = new Uint8Array(W * H);
const tiles = {}; // id -> geometry

for (const b of BLOCKS) {
  const bw = b.tw * T, bh = b.th * T, ox = b.tx * T, oy = b.ty * T;
  const at = (x, y) => (x < 0 || y < 0 || x >= bw || y >= bh) ? null : isSolid(b, x, y);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    if (!at(x, y)) continue;
    const i = (oy + y) * W + ox + x;
    solid[i] = 1;
    if (at(x - 1, y) === false || at(x + 1, y) === false || at(x, y - 1) === false || at(x, y + 1) === false) edge[i] = 1;
  }
  for (let j = 0; j < b.th; j++) for (let k = 0; k < b.tw; k++) {
    let n = 0;
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) n += solid[(oy + j * T + y) * W + ox + k * T + x];
    if (n === 0) continue;
    const id = (b.ty + j) * COLS + b.tx + k;
    if (n === T * T) { tiles[id] = `{ kind = "solid" }`; continue; }
    // Geometry is tile-local source pixels and may extend past the tile's
    // own box — the loader clips it to [0,32]x[0,32].
    const cx = bw / 2 - k * T, cy = bh / 2 - j * T;
    if (b.kind === "diamond") {
      const sx = k < b.tw / 2 ? -1 : 1, sy = j < b.th / 2 ? -1 : 1;
      const nl = Math.hypot(sx / bw, sy / bh);
      tiles[id] = `{ kind = "line", x1 = ${cx + sx * bw / 2}, y1 = ${cy}, x2 = ${cx}, y2 = ${cy + sy * bh / 2}, ` +
        `nx = ${(sx / bw / nl).toFixed(6)}, ny = ${(sy / bh / nl).toFixed(6)} }`;
    } else {
      tiles[id] = `{ kind = "arc", cx = ${cx}, cy = ${cy}, r = ${b.r * T}, solid = "${b.kind === "disc" ? "inside" : "outside"}" }`;
    }
  }
}

// ---- PNG ----
const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc(buf) { let c = -1; for (const v of buf) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, "ascii"); data.copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function writePng(file, w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]));
}

const root = path.join(__dirname, "..");

// Curves only.
const sheet = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) if (edge[i]) sheet.set([255, 0, 255, 255], i * 4);
writePng(path.join(root, "img", "pinball-curves.png"), W, H, sheet);

// True-size underlay for drawing over: curve plus solid-side tint, no grid or ids.
const underlay = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  if (edge[i]) underlay.set([255, 220, 40, 255], i * 4);
  else if (solid[i]) underlay.set([78, 84, 120, 255], i * 4);
}
writePng(path.join(root, "img", "pinball-curves-guide-1x.png"), W, H, underlay);

// Guide.
const S = 4, GW = W * S, GH = H * S;
const guide = Buffer.alloc(GW * GH * 4);
const put = (x, y, c) => { if (x >= 0 && y >= 0 && x < GW && y < GH) guide.set(c, (y * GW + x) * 4); };
for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
  const i = (y / S | 0) * W + (x / S | 0);
  let c = edge[i] ? [255, 220, 40, 255] : solid[i] ? [78, 84, 120, 255] : [22, 22, 28, 255];
  if (x % (T * S) === 0 || y % (T * S) === 0) c = [120, 120, 130, 255];
  put(x, y, c);
}
const FONT = ["111101101101111", "010110010010111", "111001111100111", "111001111001111", "101101111001001",
  "111100111001111", "111100111101111", "111001001001001", "111101111101111", "111101111001111"];
for (let id = 0; id < COLS * ROWS; id++) {
  const x0 = (id % COLS) * T * S + 6, y0 = (id / COLS | 0) * T * S + 6;
  String(id).split("").forEach((d, n) => {
    for (let p = 0; p < 15; p++) if (FONT[d][p] === "1")
      for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++)
        put(x0 + n * 8 + (p % 3) * 2 + a, y0 + (p / 3 | 0) * 2 + b, [235, 235, 240, 255]);
  });
}
writePng(path.join(root, "img", "pinball-curves-guide.png"), GW, GH, guide);

// Lua table.
const ids = Object.keys(tiles).map(Number).sort((a, b) => a - b);
fs.writeFileSync(path.join(root, "lua", "world", "PinballCurveTiles.lua"),
`-- lua/world/PinballCurveTiles.lua
--
-- GENERATED by tiled/gen-pinball-curves.js — do not edit by hand.
--
-- Exact collision geometry for every tile of img/pinball-curves.png,
-- keyed by Tiled's own 0-based local tile id (row-major, ${COLS} columns).
-- Coordinates are tile-local SOURCE pixels (+y down) and may extend past
-- the tile's own 32x32 box; clip to it.
--   arc:   circle center/radius; solid = "inside" (convex) or "outside" (concave)
--   line:  infinite line through (x1,y1)-(x2,y2); (nx,ny) points into open air
--   solid: the whole tile
-- Ids missing from this table are empty.

return {
  tileSize = ${T},
  columns = ${COLS},
  tiles = {
${ids.map(id => `    [${id}] = ${tiles[id]},`).join("\n")}
  },
}
`);
console.log(`${ids.length} non-empty tiles, ${ids.filter(id => !tiles[id].includes("solid\" }")).length} with a curve`);
