// Draws the extension icons (a ring and dot on a purple rounded square) as PNG files with no dependencies.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SIZES = [16, 32, 48, 128];
const PURPLE = [90, 62, 200];
const WHITE = [255, 255, 255];

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** Soft edge: 1 inside, 0 outside, with a one-pixel ramp. */
const edge = (distance, width) => Math.min(1, Math.max(0, (0 - distance) / width + 0.5));

function pixel(u, v, px) {
  const radius = 0.5;
  const dx = Math.max(Math.abs(u) - (1 - radius), 0);
  const dy = Math.max(Math.abs(v) - (1 - radius), 0);
  const corner = Math.hypot(dx, dy) - radius;
  const alpha = edge(corner, px);
  if (alpha === 0) return [0, 0, 0, 0];
  const r = Math.hypot(u, v);
  const ring = Math.min(edge(Math.abs(r - 0.56) - 0.14, px), 1);
  const dot = edge(r - 0.2, px);
  const mark = Math.max(ring, dot);
  return [...PURPLE.map((c, i) => Math.round(c + (WHITE[i] - c) * mark)), Math.round(alpha * 255)];
}

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * 2 - 1;
      const v = ((y + 0.5) / size) * 2 - 1;
      const [r, g, b, a] = pixel(u, v, 2 / size);
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(path.join(ROOT, 'icons'), { recursive: true });
for (const size of SIZES) {
  writeFileSync(path.join(ROOT, 'icons', `icon-${size}.png`), png(size));
}
console.log(`wrote icons: ${SIZES.join(', ')} px`);
