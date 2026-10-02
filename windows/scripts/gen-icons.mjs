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
 * Artwork: the ScreenPlay brand mark the web app shows in its top-left corner — a
 * rounded square filled with a violet→cyan diagonal gradient carrying the white
 * lucide `Gamepad2` glyph. The vector source of truth is web/public/favicon.svg
 * (the splash window inlines the same markup); `assertBrandSvg()` re-reads both
 * files and refuses to rasterise anything that has drifted, so all three platforms
 * cannot end up with three different logos.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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
// Artwork — the ScreenPlay brand mark
// ---------------------------------------------------------------------------
//
// One geometry, three consumers:
//   * web/public/favicon.svg                 (vector truth, served by the web app)
//   * windows/src-tauri/splash/index.html     (same markup, inlined)
//   * this file                               (rasters for the Windows shell icons)
//
// Everything below is expressed in the canonical box (the SVG's `viewBox 0 0 36 36`),
// so a single scale factor turns it into pixels, and `assertBrandSvg()` can compare
// the committed SVG/splash against these constants literally.
//
// The mark is the tile the web app shows in its top-left corner: a rounded square
// filled with a violet→cyan diagonal gradient, carrying the white lucide `Gamepad2`
// glyph at the size and weight web/src/App.tsx uses (h-9 tile, h-5 icon, stroke 2).

const BOX = 36; // canonical box edge = the SVG viewBox
const CORNER_RADIUS = 8; // rounded-lg on a 36px tile, as in web/src/App.tsx
const GLYPH_SCALE = 20 / 36; // h-5 lucide icon inside an h-9 tile
const GLYPH_OFFSET = (BOX - 24 * GLYPH_SCALE) / 2; // centred → 11.33333
const GLYPH_TRANSFORM = 'translate(11.33333 11.33333) scale(0.555556)';
const GLYPH_STROKE = 2; // lucide stroke-width, in the icon's own 24-unit box
/** Half the stroke, in box units. */
const STROKE_HALF = (GLYPH_STROKE / 2) * GLYPH_SCALE;
/** from-violet-600 (#7c3aed) → to-cyan-500 (#06b6d4), i.e. Tailwind `bg-gradient-to-br`. */
const GRAD_TOP = [124, 58, 237];
const GRAD_BOTTOM = [6, 182, 212];
const GLYPH_COLOR = [255, 255, 255];

/** lucide `Gamepad2` v0.427.0 (ISC) — the exact geometry the web app renders. */
const GAMEPAD_LINES = [
  'x1="6" y1="11" x2="10" y2="11"',
  'x1="8" y1="9" x2="8" y2="13"',
  'x1="15" y1="12" x2="15.01" y2="12"',
  'x1="18" y1="10" x2="18.01" y2="10"',
];
const GAMEPAD_PATH =
  'M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16'
  + 'a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586'
  + 'L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258'
  + '-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z';

const WEB_SVG = join(HERE, '..', '..', 'web', 'public', 'favicon.svg');
const SPLASH_HTML = join(HERE, '..', 'src-tauri', 'splash', 'index.html');

// --- a minimal SVG path flattener — only the commands Gamepad2 uses ----------

const PATH_TOKEN_RE = /([MmLlHhVvCcAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;

function tokenizePath(d) {
  const out = [];
  let m;
  PATH_TOKEN_RE.lastIndex = 0;
  while ((m = PATH_TOKEN_RE.exec(d)) !== null) out.push(m[1] ?? Number(m[2]));
  return out;
}

/** Endpoint-parameterised elliptical arc → points (excluding the start point). */
function arcPoints(x0, y0, rx, ry, phiDeg, largeArc, sweep, x1, y1) {
  if (rx === 0 || ry === 0) return [[x1, y1]];
  const phi = (phiDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx2 = (x0 - x1) / 2;
  const dy2 = (y0 - y1) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  let co = den === 0 ? 0 : Math.sqrt(Math.max(0, num / den));
  if (largeArc === sweep) co = -co;
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x0 + x1) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y0 + y1) / 2;
  const angleOf = (ux, uy, vx, vy) => {
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const a = Math.acos(Math.max(-1, Math.min(1, len === 0 ? 1 : (ux * vx + uy * vy) / len)));
    return ux * vy - uy * vx < 0 ? -a : a;
  };
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const theta0 = angleOf(1, 0, ux, uy);
  let dTheta = angleOf(ux, uy, vx, vy);
  if (!sweep && dTheta > 0) dTheta -= Math.PI * 2;
  if (sweep && dTheta < 0) dTheta += Math.PI * 2;
  const steps = Math.max(6, Math.ceil(Math.abs(dTheta) / (Math.PI / 12)));
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const th = theta0 + dTheta * (i / steps);
    pts.push([
      cosPhi * rx * Math.cos(th) - sinPhi * ry * Math.sin(th) + cx,
      sinPhi * rx * Math.cos(th) + cosPhi * ry * Math.sin(th) + cy,
    ]);
  }
  pts[pts.length - 1] = [x1, y1]; // land exactly on the endpoint
  return pts;
}

/** Flatten a path into subpaths, in the icon's own 24-unit box. */
function flattenPath(d) {
  const t = tokenizePath(d);
  const subs = [];
  let cur = [];
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let i = 0;
  let lastCmd = null;
  const flush = () => {
    if (cur.length > 1) subs.push(cur);
    cur = [];
  };

  while (i < t.length) {
    let cmd = t[i];
    if (typeof cmd !== 'string') {
      // Repeated coordinate sets continue the previous command (`M`/`m` repeat as
      // `L`/`l`), exactly as the SVG spec says — lucide's Gamepad2 path relies on
      // this for its final cubic segment.
      cmd = lastCmd;
      if (cmd === null) throw new Error('gen-icons: numeric path data with no preceding command');
      if (cmd === 'M') cmd = 'L';
      else if (cmd === 'm') cmd = 'l';
    } else {
      i++;
      lastCmd = cmd;
    }
    const rel = cmd >= 'a';
    const C = cmd.toUpperCase();

    if (C === 'M') {
      flush();
      x = rel ? x + t[i] : t[i];
      y = rel ? y + t[i + 1] : t[i + 1];
      i += 2;
      sx = x;
      sy = y;
      cur = [[x, y]];
    } else if (C === 'H' || C === 'V' || C === 'L') {
      if (C === 'H') {
        x = rel ? x + t[i] : t[i];
        i += 1;
      } else if (C === 'V') {
        y = rel ? y + t[i] : t[i];
        i += 1;
      } else {
        x = rel ? x + t[i] : t[i];
        y = rel ? y + t[i + 1] : t[i + 1];
        i += 2;
      }
      cur.push([x, y]);
    } else if (C === 'C') {
      const q1x = rel ? x + t[i] : t[i];
      const q1y = rel ? y + t[i + 1] : t[i + 1];
      const q2x = rel ? x + t[i + 2] : t[i + 2];
      const q2y = rel ? y + t[i + 3] : t[i + 3];
      const ex = rel ? x + t[i + 4] : t[i + 4];
      const ey = rel ? y + t[i + 5] : t[i + 5];
      i += 6;
      for (let s = 1; s <= 12; s++) {
        const u = s / 12;
        const v = 1 - u;
        const a = v * v * v;
        const b = 3 * v * v * u;
        const c = 3 * v * u * u;
        const e = u * u * u;
        cur.push([a * x + b * q1x + c * q2x + e * ex, a * y + b * q1y + c * q2y + e * ey]);
      }
      x = ex;
      y = ey;
    } else if (C === 'A') {
      const ex = rel ? x + t[i + 5] : t[i + 5];
      const ey = rel ? y + t[i + 6] : t[i + 6];
      for (const p of arcPoints(x, y, t[i], t[i + 1], t[i + 2], t[i + 3], t[i + 4], ex, ey)) {
        cur.push(p);
      }
      i += 7;
      x = ex;
      y = ey;
    } else if (C === 'Z') {
      cur.push([sx, sy]);
      flush();
      x = sx;
      y = sy;
      lastCmd = null; // `Z` takes no coordinates, so nothing may repeat it
    } else {
      throw new Error(`gen-icons: unsupported path command "${cmd}"`);
    }
  }
  flush();
  return subs;
}

/** The glyph centreline as segments in BOX units, with per-segment bounds. */
const GLYPH_SEGMENTS = (() => {
  const subpaths = [
    ...GAMEPAD_LINES.map((attrs) => {
      const n = [...attrs.matchAll(/(?:x1|y1|x2|y2)="([\d.]+)"/g)].map((m) => Number(m[1]));
      return [[n[0], n[1]], [n[2], n[3]]];
    }),
    ...flattenPath(GAMEPAD_PATH),
  ];
  const segs = [];
  for (const sub of subpaths) {
    for (let i = 1; i < sub.length; i++) {
      const ax = GLYPH_OFFSET + GLYPH_SCALE * sub[i - 1][0];
      const ay = GLYPH_OFFSET + GLYPH_SCALE * sub[i - 1][1];
      const bx = GLYPH_OFFSET + GLYPH_SCALE * sub[i][0];
      const by = GLYPH_OFFSET + GLYPH_SCALE * sub[i][1];
      segs.push({
        ax,
        ay,
        bx,
        by,
        minx: Math.min(ax, bx),
        miny: Math.min(ay, by),
        maxx: Math.max(ax, bx),
        maxy: Math.max(ay, by),
      });
    }
  }
  return segs;
})();

/**
 * Distance from (x, y) to the glyph centreline, in BOX units. Round caps and joins
 * fall out of "distance to the nearest segment" for free, which is exactly how
 * lucide renders (`stroke-linecap/linejoin: round`).
 */
function glyphDistance(x, y) {
  let best = Infinity;
  for (const s of GLYPH_SEGMENTS) {
    const dx = x < s.minx ? s.minx - x : x > s.maxx ? x - s.maxx : 0;
    const dy = y < s.miny ? s.miny - y : y > s.maxy ? y - s.maxy : 0;
    if (dx * dx + dy * dy >= best * best) continue; // bbox reject
    const vx = s.bx - s.ax;
    const vy = s.by - s.ay;
    const wx = x - s.ax;
    const wy = y - s.ay;
    const len2 = vx * vx + vy * vy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0;
    const qx = wx - t * vx;
    const qy = wy - t * vy;
    const d = Math.sqrt(qx * qx + qy * qy);
    if (d < best) best = d;
  }
  return best;
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Signed distance to an axis-aligned rounded square (negative = inside). */
function roundedSquareDistance(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - (halfW - radius);
  const qy = Math.abs(py - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius;
}

const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Render one icon at `size` px into a straight-alpha RGBA buffer. */
function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);

  const unitsPerPixel = BOX / size;
  const aa = unitsPerPixel; // one screen pixel, expressed in box units
  const half = BOX / 2;
  // Small rasters lose the glyph's counter-forms first, so thicken the stroke
  // slightly below 64px to keep the gamepad readable in a 16px taskbar slot.
  const strokeHalf = STROKE_HALF * (size <= 32 ? 1.35 : size <= 64 ? 1.18 : 1);

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
          const px = (x + (sx + 0.5) / SUB) * unitsPerPixel;
          const py = (y + (sy + 0.5) / SUB) * unitsPerPixel;

          // --- background tile ---
          const bgD = roundedSquareDistance(px, py, half, half, half, half, CORNER_RADIUS);
          const bgA = clamp01(0.5 - bgD / aa);

          // --- glyph ---
          const glyphA = clamp01(0.5 + (strokeHalf - glyphDistance(px, py)) / aa);

          // --- colours ---
          const t = (px + py) / (2 * BOX); // `bg-gradient-to-br`
          const bg = mix(GRAD_TOP, GRAD_BOTTOM, t);

          // Composite glyph over background (premultiplied).
          const a = glyphA + bgA * (1 - glyphA);
          const k = bgA * (1 - glyphA);
          accR += GLYPH_COLOR[0] * glyphA + bg[0] * k;
          accG += GLYPH_COLOR[1] * glyphA + bg[1] * k;
          accB += GLYPH_COLOR[2] * glyphA + bg[2] * k;
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

/**
 * The committed SVG and the splash copy are the same artwork the web app draws, and
 * the rasters above must be that artwork too. Compare them literally — a silent
 * divergence here would mean three different logos on three platforms.
 */
function assertBrandSvg() {
  const expect = [
    '<rect x="0" y="0" width="36" height="36" rx="8"',
    `stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" transform="${GLYPH_TRANSFORM}"`,
    ...GAMEPAD_LINES.map((attrs) => `<line ${attrs} />`),
    `d="${GAMEPAD_PATH}"`,
    '#7c3aed',
    '#06b6d4',
  ];
  const files = [
    ['web/public/favicon.svg', WEB_SVG],
    ['src-tauri/splash/index.html', SPLASH_HTML],
  ];
  for (const [label, file] of files) {
    if (!existsSync(file)) throw new Error(`gen-icons: 缺少品牌图标文件 ${file}`);
    const txt = readFileSync(file, 'utf8');
    for (const needle of expect) {
      if (!txt.includes(needle)) {
        throw new Error(
          `gen-icons: ${label} 与 gen-icons.mjs 的品牌几何不一致，缺少：${needle}\n`
          + '          改动图标必须同时更新 web/public/favicon.svg、src-tauri/splash/index.html 与 gen-icons.mjs。',
        );
      }
    }
  }
  return files.map(([label]) => label);
}

/** Terminal-only preview, because this build host has no image viewer. */
function asciiPreview() {
  const cols = 44;
  const rows = 22;
  const lines = [];
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      const x = ((c + 0.5) / cols) * BOX;
      const y = ((r + 0.5) / rows) * BOX;
      const onTile = roundedSquareDistance(x, y, BOX / 2, BOX / 2, BOX / 2, BOX / 2, CORNER_RADIUS) <= 0;
      const onGlyph = glyphDistance(x, y) <= STROKE_HALF * 1.6;
      line += onGlyph ? '#' : onTile ? '.' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
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

// Refuse to draw anything the vector source no longer matches: three platforms,
// one mark. (Also prints the geometry the rasters are built from.)
const brandFiles = assertBrandSvg();
console.log(`Brand geometry ok — canonical web/public/favicon.svg, mirrored by: ${brandFiles.join(', ')}`);
console.log(asciiPreview());
console.log('');

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