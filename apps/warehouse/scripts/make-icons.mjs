// Writes the PWA icons (public/icon-*.png) with no image dependencies: a
// green square with a white maize cob, drawn as pixels and encoded as PNG.
// Run: npm run icons
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const GREEN = [11, 93, 30];
const WHITE = [255, 255, 255];
const GOLD = [245, 196, 0];

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, pixel) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) row.set(pixel(x / size, y / size), 1 + x * 3);
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A cob: an ellipse of gold kernels in a white husk, inside `scale` of the icon. */
function cob(scale) {
  return (u, v) => {
    const x = (u - 0.5) / scale;
    const y = (v - 0.5) / scale;
    const husk = (x / 0.3) ** 2 + (y / 0.44) ** 2 <= 1;
    const kernels = (x / 0.2) ** 2 + (y / 0.36) ** 2 <= 1;
    if (kernels) {
      const kx = Math.abs((((x + 1) * 14) % 1) - 0.5);
      const ky = Math.abs((((y + 1) * 16) % 1) - 0.5);
      return kx < 0.38 && ky < 0.38 ? GOLD : WHITE;
    }
    return husk ? WHITE : GREEN;
  };
}

writeFileSync('public/icon-192.png', png(192, cob(1)));
writeFileSync('public/icon-512.png', png(512, cob(1)));
// Maskable: the shape stays inside the 80% safe zone.
writeFileSync('public/icon-maskable-512.png', png(512, cob(0.75)));
console.log('icons written');
