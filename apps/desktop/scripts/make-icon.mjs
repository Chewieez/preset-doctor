// Draws the app icon (a rounded teal square with a white cross) and writes PNG and ICO files.
// No image libraries: shapes are signed-distance functions, anti-aliased by supersampling.
// Run with `npm run icon -w apps/desktop`; the outputs are committed.
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..');

const TOP = [0x16, 0xa5, 0x90];
const BOTTOM = [0x0a, 0x6b, 0x5e];
const SAMPLES = 4;

/** Signed distance from (px, py) to a rounded box centred at 0 with half-size (bx, by). */
function roundedBox(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r;
  const qy = Math.abs(py) - by + r;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

function render(size) {
  const rgba = new Uint8Array(size * size * 4);
  const tile = 0.46; // half-size of the square, in units of the icon size
  const arm = { long: 0.27, short: 0.085, r: 0.04 };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let tileCover = 0;
      let crossCover = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const u = (x + (sx + 0.5) / SAMPLES) / size - 0.5;
          const v = (y + (sy + 0.5) / SAMPLES) / size - 0.5;
          if (roundedBox(u, v, tile, tile, 0.2) <= 0) tileCover++;
          const h = roundedBox(u, v, arm.long, arm.short, arm.r);
          const w = roundedBox(u, v, arm.short, arm.long, arm.r);
          if (Math.min(h, w) <= 0) crossCover++;
        }
      }
      const n = SAMPLES * SAMPLES;
      const a = tileCover / n;
      const c = crossCover / n;
      const t = y / (size - 1);
      const i = (y * size + x) * 4;
      for (let k = 0; k < 3; k++) {
        const bg = TOP[k] + (BOTTOM[k] - TOP[k]) * t;
        // The cross sits inside the tile, so blend it over the tile colour.
        rgba[i + k] = Math.round(a > 0 ? bg + (255 - bg) * (c / a) : 0);
      }
      rgba[i + 3] = Math.round(a * 255);
    }
  }
  return rgba;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

function png(size) {
  const rgba = render(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO with PNG-compressed images (supported since Windows Vista). */
function ico(sizes) {
  const images = sizes.map((s) => ({ size: s, data: png(s) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const img of images) {
    const e = Buffer.alloc(16);
    e[0] = img.size >= 256 ? 0 : img.size;
    e[1] = img.size >= 256 ? 0 : img.size;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(img.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

function write(rel, data) {
  const path = join(app, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  console.log(`wrote ${rel} (${data.length} bytes)`);
}

write('build/icon.png', png(512));
write('build/icon.ico', ico([16, 24, 32, 48, 64, 128, 256]));
write('resources/icon.png', png(256));
write('src/renderer/public/icon.png', png(128));
// The web version (apps/web) shows the same icon.
write('../web/public/icon.png', png(128));
