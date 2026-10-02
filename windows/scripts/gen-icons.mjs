#!/usr/bin/env node
/**
 * ScreenPlay icon generator — zero dependencies.
 *
 * Produces (into windows/src-tauri/icons/):
 *   icon.png       1024x1024
 *   128x128.png     128x128
 *   32x32.png        32x32
 *   icon.ico       single 256x256 PNG-compressed entry
 *
 * Why hand-rolled: DESIGN §10 forbids new toolchain dependencies, and `sharp` /
 * `canvas` are native modules we cannot rely on in this build environment. PNG
 * is just `signature + IHDR + IDAT(deflate) + IEND` with a CRC32 per chunk, and
 * a Vista-era `.ico` is a 6-byte header, one 16-byte directory entry and the raw
 * PNG bytes — so `node:zlib` is genuinely all we need.
 *
 * Artwork: a dark rounded square with a bright lowercase-free "S" glyph. The S
 * is a stroked path made of two circular arcs (a classic S skeleton), rasterised
 * with a signed-distance function so it stays crisp at 32px and smooth at 1024px.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ICON_DIR = join(HERE, '..', 'src-tauri', 'icons');

// ---------------------------------------------------------------------------
// PNG primitives
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/** Encode straight-alpha RGBA bytes as an 8-bit truecolour+alpha PNG. */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    raw[at] = 0; // filter type 0 (None) — simplest and lossless
    rgba.copy(raw, at + 1, y * stride, y * stride + stride);
  }

  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// .ico container (one PNG-compressed entry, 256x256)
// ---------------------------------------------------------------------------

function encodeIco(png, width, height) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // image count

  const entry = Buffer.alloc(16);
  entry[0] = width >= 256 ? 0 : width; // 0 means 256
  entry[1] = height >= 256 ? 0 : height;
  entry[2] = 0; // palette size
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8); // payload size
  entry.writeUInt32LE(6 + 16, 12); // payload offset

  return Buffer.concat([header, entry, png]);
}

// ---------------------------------------------------------------------------
// Artwork
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;

/**
 * "S" skeleton: two bowl arcs, the lower one rotated 180° about the glyph
 * centre. Angle convention matches the pixel grid (y grows downward), so
 * `theta = -90°` is "up". Each arc is swept by *decreasing* theta.
 *
 *   upper arc: centre (0.5, 0.32)  from -40° down to -270°
 *      -> starts upper-right, over the top, down the left, into the centre
 *   lower arc: centre (0.5, 0.68)  from 140° down to  -90°
 *      -> starts lower-left, under the bottom, up the right, into the centre
 *
 * The bowls are ellipses (rx > ry) because two equal circles produce an S that
 * is far too narrow — the letter form wants a width:height near 0.72, not 0.59.
 */
const ARCS = [
  { cx: 0.5, cy: 0.32, rx: 0.27, ry: 0.2, a0: -40 * DEG, a1: -270 * DEG },
  { cx: 0.5, cy: 0.68, rx: 0.27, ry: 0.2, a0: 140 * DEG, a1: -90 * DEG },
];

const HALF_THICKNESS = 0.056; // in glyph-unit space
const GLYPH_BOX = 0.6; // glyph occupies this fraction of the icon edge

function inDecreasingSweep(angle, a0, a1) {
  const twoPi = Math.PI * 2;
  const total = a0 - a1;
  let travelled = a0 - angle;
  travelled = ((travelled % twoPi) + twoPi) % twoPi;
  return travelled <= total + 1e-9;
}

/** Parametric angle of a point on the ellipse (the conformal-ish mapping). */
function ellipseAngle(qx, qy, rx, ry) {
  return Math.atan2(qy / ry, qx / rx);
}

/**
 * First-order distance from (qx, qy) to the ellipse of radii (rx, ry) centred
 * at the origin. Exact on both axes, and the error is a few percent at 45°,
 * which is invisible on a 69px-wide stroke.
 */
function ellipseDistance(qx, qy, rx, ry) {
  const rho = Math.hypot(qx / rx, qy / ry); // 1.0 on the ellipse
  if (rho < 1e-9) return -Math.min(rx, ry);
  const len = Math.hypot(qx, qy);
  const radiusAlongNormal = 1 / Math.hypot(qx / len / rx, qy / len / ry);
  return (rho - 1) * radiusAlongNormal;
}

function distanceToArc(px, py, arc) {
  const qx = px - arc.cx;
  const qy = py - arc.cy;
  const angle = ellipseAngle(qx, qy, arc.rx, arc.ry);

  if (inDecreasingSweep(angle, arc.a0, arc.a1)) {
    return Math.abs(ellipseDistance(qx, qy, arc.rx, arc.ry));
  }

  // Outside the sweep: the nearest point is one of the two round caps.
  const e0x = arc.cx + arc.rx * Math.cos(arc.a0);
  const e0y = arc.cy + arc.ry * Math.sin(arc.a0);
  const e1x = arc.cx + arc.rx * Math.cos(arc.a1);
  const e1y = arc.cy + arc.ry * Math.sin(arc.a1);
  return Math.min(Math.hypot(px - e0x, py - e0y), Math.hypot(px - e1x, py - e1y));
}

/** Distance to the nearest S centreline, in glyph-unit space. */
function glyphDistance(u, v) {
  return Math.min(distanceToArc(u, v, ARCS[0]), distanceToArc(u, v, ARCS[1]));
}

/** Signed distance to an axis-aligned rounded square (negative = inside). */
function roundedSquareDistance(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - (halfW - radius);
  const qy = Math.abs(py - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius;
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Palette.
const BG_TOP = [27, 33, 45];
const BG_BOTTOM = [9, 11, 16];
const GLYPH_TOP = [124, 188, 255];
const GLYPH_BOTTOM = [61, 126, 255];

/** Render one icon at `size` px into a straight-alpha RGBA buffer. */
function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);

  const half = size / 2;
  const radius = 0.22 * size;
  const side = GLYPH_BOX * size;
  const gx0 = (size - side) / 2;
  const gy0 = (size - side) / 2;
  const unitPerPixel = 1 / side; // one screen pixel, expressed in glyph units
  // Small rasters lose the counter-form first, so thicken the stroke slightly
  // below 64px to keep the S readable in a 16px taskbar slot.
  const halfThickness = HALF_THICKNESS * (size <= 32 ? 1.35 : size <= 64 ? 1.18 : 1);

  const SUB = 3; // 3x3 supersampling
  const subWeight = 1 / (SUB * SUB);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let accR = 0;
      let accG = 0;
      let accB = 0;
      let accA = 0;

      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const px = x + (sx + 0.5) / SUB;
          const py = y + (sy + 0.5) / SUB;

          // --- background ---
          const bgD = roundedSquareDistance(px, py, half, half, half, half, radius);
          const bgA = clamp01(0.5 - bgD);

          // --- glyph ---
          const u = (px - gx0) / side;
          const v = (py - gy0) / side;
          const glyphA = clamp01(
            0.5 + (halfThickness - glyphDistance(u, v)) / unitPerPixel,
          );

          // --- colours ---
          const t = py / size;
          const bgR = BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t;
          const bgG = BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t;
          const bgB = BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t;
          const glR = GLYPH_TOP[0] + (GLYPH_BOTTOM[0] - GLYPH_TOP[0]) * t;
          const glG = GLYPH_TOP[1] + (GLYPH_BOTTOM[1] - GLYPH_TOP[1]) * t;
          const glB = GLYPH_TOP[2] + (GLYPH_BOTTOM[2] - GLYPH_TOP[2]) * t;

          // Composite glyph over background (premultiplied).
          const a = glyphA + bgA * (1 - glyphA);
          const k = bgA * (1 - glyphA);
          accR += glR * glyphA + bgR * k;
          accG += glG * glyphA + bgG * k;
          accB += glB * glyphA + bgB * k;
          accA += a;
        }
      }

      accR *= subWeight;
      accG *= subWeight;
      accB *= subWeight;
      accA *= subWeight;

      const at = (y * size + x) * 4;
      if (accA <= 0.0001) {
        rgba[at] = 0;
        rgba[at + 1] = 0;
        rgba[at + 2] = 0;
        rgba[at + 3] = 0;
      } else {
        // Un-premultiply back to straight alpha for PNG.
        rgba[at] = Math.round(clamp01(accR / accA / 255) * 255);
        rgba[at + 1] = Math.round(clamp01(accG / accA / 255) * 255);
        rgba[at + 2] = Math.round(clamp01(accB / accA / 255) * 255);
        rgba[at + 3] = Math.round(clamp01(accA) * 255);
      }
    }
  }

  return rgba;
}

// ---------------------------------------------------------------------------
// Self-verification (no external decoder needed)
// ---------------------------------------------------------------------------

function verifyPng(buf, expectW, expectH) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== signature[i]) throw new Error('bad PNG signature');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let sawIHDR = false;
  let sawIEND = false;
  let chunks = 0;

  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const dataEnd = offset + 8 + length;
    if (dataEnd + 4 > buf.length) throw new Error(`truncated chunk ${type}`);

    const expectedCrc = buf.readUInt32BE(dataEnd);
    const actualCrc = crc32(buf.subarray(offset + 4, dataEnd));
    if (expectedCrc !== actualCrc) throw new Error(`CRC mismatch in ${type}`);

    if (type === 'IHDR') {
      sawIHDR = true;
      width = buf.readUInt32BE(offset + 8);
      height = buf.readUInt32BE(offset + 12);
    }
    if (type === 'IEND') sawIEND = true;

    chunks++;
    offset = dataEnd + 4;
  }

  if (!sawIHDR) throw new Error('missing IHDR');
  if (!sawIEND) throw new Error('missing IEND');
  if (offset !== buf.length) throw new Error('trailing bytes after IEND');
  if (width !== expectW || height !== expectH) {
    throw new Error(`size mismatch: ${width}x${height} != ${expectW}x${expectH}`);
  }
  return { width, height, chunks };
}

function verifyIco(buf, expectPayloadSize) {
  if (buf.readUInt16LE(0) !== 0) throw new Error('bad ICO reserved field');
  if (buf.readUInt16LE(2) !== 1) throw new Error('bad ICO type');
  const count = buf.readUInt16LE(4);
  if (count !== 1) throw new Error(`expected 1 ICO image, got ${count}`);

  const w = buf[6] === 0 ? 256 : buf[6];
  const h = buf[7] === 0 ? 256 : buf[7];
  const payloadSize = buf.readUInt32LE(14);
  const payloadOffset = buf.readUInt32LE(18);
  if (payloadOffset !== 22) throw new Error('bad ICO payload offset');
  if (payloadSize !== expectPayloadSize) throw new Error('bad ICO payload size');
  if (buf.length !== payloadOffset + payloadSize) throw new Error('bad ICO total size');

  // The embedded payload must itself be a valid PNG.
  verifyPng(buf.subarray(payloadOffset), w, h);
  return { width: w, height: h, payloadSize };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const targets = [
  { name: 'icon.png', size: 1024 },
  { name: '128x128.png', size: 128 },
  { name: '32x32.png', size: 32 },
];

mkdirSync(ICON_DIR, { recursive: true });

const summary = [];
for (const { name, size } of targets) {
  const rgba = renderIcon(size);
  const png = encodePng(size, size, rgba);
  const info = verifyPng(png, size, size);
  const path = join(ICON_DIR, name);
  writeFileSync(path, png);
  summary.push({ name, bytes: png.length, detail: `${info.width}x${info.height}, ${info.chunks} chunks` });
  console.log(`  ${name.padEnd(12)} ${String(size + 'x' + size).padEnd(11)} ${kb(png.length).padStart(10)}  CRC+IHDR ok`);
}

// .ico ships a 256x256 PNG entry (Windows scales down for every other slot).
const icoPng = encodePng(256, 256, renderIcon(256));
const ico = encodeIco(icoPng, 256, 256);
const icoInfo = verifyIco(ico, icoPng.length);
const icoPath = join(ICON_DIR, 'icon.ico');
writeFileSync(icoPath, ico);
summary.push({ name: 'icon.ico', bytes: ico.length, detail: `${icoInfo.width}x${icoInfo.height} PNG entry` });
console.log(`  ${'icon.ico'.padEnd(12)} ${String('256x256').padEnd(11)} ${kb(ico.length).padStart(10)}  ICO+PNG ok`);

// Re-read from disk so the check covers what was actually written, not the
// in-memory buffers.
console.log('\nRe-reading from disk:');
for (const { name } of [...targets, { name: 'icon.ico' }]) {
  const path = join(ICON_DIR, name);
  const onDisk = readFileSync(path);
  if (name.endsWith('.ico')) {
    verifyIco(onDisk, onDisk.length - 22);
  } else {
    const size = Number(name === 'icon.png' ? 1024 : name.split('x')[0]);
    verifyPng(onDisk, size, size);
  }
  console.log(`  ${name.padEnd(12)} ${kb(onDisk.length).padStart(10)}  ok`);
}

console.log(`\nWrote ${summary.length} files to ${ICON_DIR}`);