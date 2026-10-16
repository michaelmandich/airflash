'use strict';

// Rasterizes the AirFlash mark into the PNGs each platform needs.
// Pure Node (zlib), so no image tooling required. Run: npm run icons

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const BOLT = [[286, 72], [132, 292], [236, 292], [210, 440], [380, 208], [272, 208]]; // in a 512 box
const C1 = [0x2f, 0xd4, 0xff];
const C2 = [0x7c, 0x6c, 0xff];

function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inRoundRect(x, y, x0, y0, w, h, r) {
  if (x < x0 || y < y0 || x > x0 + w || y > y0 + h) return false;
  const cx = Math.min(Math.max(x, x0 + r), x0 + w - r);
  const cy = Math.min(Math.max(y, y0 + r), y0 + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/**
 * @param size   output px
 * @param inset  fraction of padding around the tile (macOS-style icons have some)
 * @param radius corner radius as a fraction of the tile (0 = square, iOS masks it itself)
 * @param mode   'color' | 'template' (black bolt only, for the macOS menu bar)
 */
function render(size, { inset = 0, radius = 116 / 512, mode = 'color', boltScale = 1 } = {}) {
  const SS = 4;
  const px = Buffer.alloc(size * size * 4);
  const tile = size * (1 - inset * 2);
  const off = size * inset;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          // bolt coordinates in the 512 box, scaled around the centre
          const bx = ((fx - off) / tile) * 512;
          const by = ((fy - off) / tile) * 512;
          const cx = 256 + (bx - 256) / boltScale;
          const cy = 256 + (by - 256) / boltScale;
          const onBolt = inPolygon(cx, cy, BOLT);
          if (mode === 'template') {
            if (onBolt) a += 1;
            continue;
          }
          if (!inRoundRect(fx, fy, off, off, tile, tile, tile * radius)) continue;
          a += 1;
          if (onBolt) { r += 255; g += 255; b += 255; continue; }
          const t = Math.min(1, Math.max(0, ((fx - off) + (fy - off)) / (2 * tile)));
          r += C1[0] + (C2[0] - C1[0]) * t;
          g += C1[1] + (C2[1] - C1[1]) * t;
          b += C1[2] + (C2[2] - C1[2]) * t;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      if (a) {
        px[i] = mode === 'template' ? 0 : Math.round(r / a);
        px[i + 1] = mode === 'template' ? 0 : Math.round(g / a);
        px[i + 2] = mode === 'template' ? 0 : Math.round(b / a);
      }
      px[i + 3] = Math.round((a / n) * 255);
    }
  }
  return encodePng(size, size, px);
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outputs = [
  ['src/web/icons/icon-192.png', 192, {}],
  ['src/web/icons/icon-512.png', 512, {}],
  ['src/web/icons/apple-touch-icon.png', 180, { radius: 0 }],
  ['build/icon.png', 1024, { inset: 0.09 }],
  ['src/desktop/assets/tray.png', 32, { radius: 0.24 }],
  ['src/desktop/assets/trayTemplate.png', 16, { mode: 'template', boltScale: 1.25 }],
  ['src/desktop/assets/trayTemplate@2x.png', 32, { mode: 'template', boltScale: 1.25 }],
];

for (const [rel, size, opts] of outputs) {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, render(size, opts));
  console.log(`wrote ${rel} (${size}px)`);
}
