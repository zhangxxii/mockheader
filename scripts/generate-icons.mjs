import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const OUTPUT_DIR = new URL("../public/icons/", import.meta.url);
const SIZES = [16, 32, 48, 128];
const VARIANTS = [
  {
    fileName: (size) => `icon-${size}.png`,
    colors: {
      dark: [27, 31, 33, 255],
      accent: [32, 201, 151, 255],
      text: [231, 236, 234, 255],
    },
  },
  {
    fileName: (size) => `icon-disabled-${size}.png`,
    colors: {
      dark: [39, 43, 45, 255],
      accent: [105, 114, 118, 255],
      text: [174, 181, 184, 255],
    },
  },
];

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function insideRoundedRect(x, y, min, max, radius) {
  const nearestX = Math.max(min + radius, Math.min(x, max - radius));
  const nearestY = Math.max(min + radius, Math.min(y, max - radius));
  const dx = x - nearestX;
  const dy = y - nearestY;
  return dx * dx + dy * dy <= radius * radius;
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const projection = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared));
  return Math.hypot(px - (x1 + projection * dx), py - (y1 + projection * dy));
}

function createIcon(size, colors) {
  const scale = size / 128;
  const pixels = Buffer.alloc(size * size * 4);

  const paint = (x, y, color) => {
    const index = (y * size + x) * 4;
    pixels.set(color, index);
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = (x + 0.5) / scale;
      const py = (y + 0.5) / scale;
      const inOuter = insideRoundedRect(px, py, 5, 123, 25);
      if (!inOuter) continue;

      const inInner = insideRoundedRect(px, py, 15, 113, 17);
      paint(x, y, inInner ? colors.dark : colors.accent);

      const onH =
        distanceToSegment(px, py, 34, 37, 34, 91) <= 5.5 ||
        distanceToSegment(px, py, 94, 37, 94, 91) <= 5.5 ||
        distanceToSegment(px, py, 34, 64, 94, 64) <= 5.5;
      if (onH) paint(x, y, colors.text);

      if (Math.hypot(px - 34, py - 37) <= 7 || Math.hypot(px - 94, py - 91) <= 7) {
        paint(x, y, colors.accent);
      }
    }
  }

  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND"),
  ]);
}

mkdirSync(OUTPUT_DIR, { recursive: true });
for (const variant of VARIANTS) {
  for (const size of SIZES) {
    writeFileSync(
      new URL(variant.fileName(size), OUTPUT_DIR),
      createIcon(size, variant.colors),
    );
  }
}
