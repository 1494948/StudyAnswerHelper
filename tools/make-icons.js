'use strict';
/* 零依赖图标生成：手写 PNG 编码器 + ICO 封装（内嵌 PNG，Vista+ 支持）
   图标含义：蓝色圆角方块 + 白色根号 √（数学老师） */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------- PNG ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;       /* bit depth */
  ihdr[9] = 6;       /* color type: RGBA */
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;   /* filter: none */
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- 形状 ---------- */
function insideRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}
function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = px - (ax + t * vx);
  const dy = py - (ay + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
}

const BG = [26, 95, 180];        /* #1a5fb4 */
const FG = [255, 255, 255];

/* 根号形状（相对坐标），线宽比例 */
const STROKES = [
  [0.295, 0.565, 0.405, 0.720],
  [0.405, 0.720, 0.665, 0.290],
  [0.640, 0.290, 0.800, 0.290]
];

function renderIcon(size) {
  const SS = 3;                       /* 3×3 超采样抗锯齿 */
  const rgba = Buffer.alloc(size * size * 4);
  const r = size * 0.22;              /* 圆角半径 */
  const pad = size * 0.035;
  const x0 = pad, y0 = pad, x1 = size - pad, y1 = size - pad;
  const lw = size * 0.085;            /* 线宽 */
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgHits = 0;
      let fgHits = 0;
      let total = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          total++;
          if (!insideRoundRect(x, y, x0, y0, x1, y1, r)) continue;
          bgHits++;
          let near = 1e9;
          for (const s of STROKES) {
            const d = segDist(x, y, s[0] * size, s[1] * size, s[2] * size, s[3] * size);
            if (d < near) near = d;
          }
          if (near <= lw / 2) fgHits++;
        }
      }
      const idx = (py * size + px) * 4;
      if (bgHits === 0) {
        rgba[idx] = 0; rgba[idx + 1] = 0; rgba[idx + 2] = 0; rgba[idx + 3] = 0;
        continue;
      }
      const fgRatio = fgHits / bgHits;
      rgba[idx] = Math.round(BG[0] * (1 - fgRatio) + FG[0] * fgRatio);
      rgba[idx + 1] = Math.round(BG[1] * (1 - fgRatio) + FG[1] * fgRatio);
      rgba[idx + 2] = Math.round(BG[2] * (1 - fgRatio) + FG[2] * fgRatio);
      rgba[idx + 3] = Math.round(255 * (bgHits / total));
    }
  }
  return encodePNG(size, size, rgba);
}

/* ---------- ICO ---------- */
function encodeICO(pngs) {
  const n = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(n, 4);
  const dir = Buffer.alloc(16 * n);
  let offset = 6 + 16 * n;
  pngs.forEach((p, i) => {
    const o = i * 16;
    dir[o] = p.size >= 256 ? 0 : p.size;
    dir[o + 1] = p.size >= 256 ? 0 : p.size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(p.buf.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += p.buf.length;
  });
  return Buffer.concat([header, dir].concat(pngs.map((p) => p.buf)));
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });

const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];
const iconPngs = ICON_SIZES.map((s) => ({ size: s, buf: renderIcon(s) }));

fs.writeFileSync(path.join(outDir, 'icon.png'), renderIcon(256));
fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeICO(iconPngs));

const trayPngs = [16, 20, 24, 32].map((s) => ({ size: s, buf: renderIcon(s) }));
fs.writeFileSync(path.join(outDir, 'tray.ico'), encodeICO(trayPngs));
fs.writeFileSync(path.join(outDir, 'tray.png'), renderIcon(32));

console.log('图标已生成：assets/icon.png assets/icon.ico assets/tray.ico');
