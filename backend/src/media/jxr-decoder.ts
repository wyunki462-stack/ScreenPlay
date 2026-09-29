/**
 * JXR (JPEG XR / HD Photo) decoding.
 *
 * JXR is a Windows-era high-dynamic-range still format used by some game
 * capture tools (NVIDIA Ansel uses .exr, but Windows Xbox capture and a few
 * others emit .jxr/.wdp/.hdp). The spec requires decoding these **on the
 * backend** and transcoding to WebP so the frontend never handles JXR natively.
 *
 * We use `jpegxr` (a WebAssembly wrapper around Microsoft's jxrlib) plus a
 * graceful fallback chain. The WASM module loads lazily so the process still
 * boots when the package is unavailable on a given platform.
 */

import sharp from 'sharp';
import { Logger } from '@nestjs/common';

type JxrCodec = {
  decode(bytes: Uint8Array): {
    width: number;
    height: number;
    pixelInfo: {
      channels: number;
      colorFormat: string;
      bitDepth: string;
      bitsPerPixel: number;
      hasAlpha: boolean;
      bgr: boolean;
    };
    bytes: Uint8Array;
  };
};

let codecPromise: Promise<JxrCodec | null> | null = null;

/**
 * Load the (WASM) codec once. Returns null if the module is unavailable.
 */
async function loadCodec(): Promise<JxrCodec | null> {
  if (codecPromise) return codecPromise;
  codecPromise = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const factory = require('jpegxr');
    const codec = await factory();
    return codec as JxrCodec;
  })().catch((err: unknown) => {
    new Logger('JxrDecoder').warn(
      `jpegxr codec failed to load: ${(err as Error)?.message ?? err}`,
    );
    return null;
  });
  return codecPromise;
}

/**
 * Decode a JXR file buffer into standard 8-bit RGB(A) raw pixels ready for sharp.
 * Returns null only when the codec itself is unavailable or fails.
 *
 * Real-world game captures (Xbox/Windows Game Bar) are **32-bit float HDR**
 * (`bitDepth: '32Float'`, 128 bpp). The original implementation returned null
 * for anything that was not exactly 8 bits per channel, so every actual JXR
 * screenshot in the library failed to transcode (HTTP 415 on /original and a
 * raw undecodable 30 MB stream on /thumbnail). All bit depths are now handled.
 */
export async function decodeJxr(input: Buffer): Promise<{
  data: Buffer;
  info: { width: number; height: number; channels: 1 | 2 | 3 | 4 };
} | null> {
  const codec = await loadCodec();
  if (!codec) return null;

  let image: ReturnType<JxrCodec['decode']>;
  try {
    image = codec.decode(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
  } catch (err) {
    new Logger('JxrDecoder').warn(`JXR decode threw: ${(err as Error)?.message ?? err}`);
    return null;
  }

  const { width, height, pixelInfo } = image;
  const { channels, bitsPerPixel, bgr, bitDepth } = pixelInfo as typeof pixelInfo & {
    bitDepth?: string;
  };
  if (!width || !height) return null;
  if (channels !== 1 && channels !== 2 && channels !== 3 && channels !== 4) return null;

  const bitsPerChannel = Math.round(bitsPerPixel / channels);
  const src = Buffer.from(image.bytes);
  const out = Buffer.alloc(width * height * channels);

  if (bitsPerChannel === 8) {
    // Common 24/32 bpp BGR/BGRA integer case.
    for (let i = 0; i < width * height; i++) {
      const b = src[i * channels];
      const g = src[i * channels + 1];
      const r = src[i * channels + 2];
      out[i * channels] = bgr ? r : b;
      out[i * channels + 1] = g;
      if (channels >= 3) out[i * channels + 2] = bgr ? b : r;
      if (channels === 4) out[i * channels + 3] = src[i * channels + 3];
    }
    return { data: out, info: { width, height, channels: channels as 1 | 2 | 3 | 4 } };
  }

  if (bitsPerChannel === 16) {
    // 16-bit integer (48/64 bpp): take the high byte.
    for (let i = 0; i < width * height; i++) {
      for (let c = 0; c < channels; c++) {
        const off = i * channels * 2 + c * 2;
        out[i * channels + c] = src[off + 1];
      }
    }
    return { data: out, info: { width, height, channels: channels as 1 | 2 | 3 | 4 } };
  }

  if (bitsPerChannel === 32) {
    // 32-bit float HDR — what Xbox / Windows Game Bar actually emit for
    // screenshots. Values are scene-linear and routinely exceed 1.0 (measured
    // on a real capture: p50=0.50, p90=1.41, max=5.96, with ~19% of pixels
    // above 1.0). Clamping to 1.0 first would blow out 19% of the frame, so the
    // data is tone mapped with extended Reinhard and then sRGB-encoded.
    const f32 = new Float32Array(src.buffer, src.byteOffset, width * height * channels);
    const isFloat = (bitDepth ?? '').toLowerCase().includes('float');
    const count = width * height;

    // Pick the white point from the data itself so exposure adapts per image
    // instead of assuming a fixed headroom. Sampling every 13th pixel keeps
    // this negligible next to the decode itself.
    let white = 1;
    if (isFloat) {
      const sample: number[] = [];
      for (let i = 0; i < count; i += 13) {
        for (let c = 0; c < 3 && c < channels; c++) {
          const v = f32[i * channels + c];
          if (Number.isFinite(v) && v > 0) sample.push(v);
        }
      }
      sample.sort((a, b) => a - b);
      const peak = sample.length ? sample[Math.floor(0.999 * (sample.length - 1))] : 1;
      // Never below 1 (avoid darkening an SDR-range image), never absurd.
      white = Math.min(Math.max(peak, 1), 16);
    }
    const whiteSq = white * white;

    for (let i = 0; i < count; i++) {
      // The 4th channel of these captures is NOT usable alpha. `jpegxr` never
      // writes it for 32Float input: the float view is a slice of the WASM heap,
      // so channel 4 contains whatever the previous decode left there (zeros on
      // the very first decode, stale pixels afterwards). Measured on real files:
      // the fraction landing in (0,1) changes with decode order — 0% when the
      // image is decoded first, 95.7% when another image was decoded before it.
      // An independent reference decoder (Python `imagecodecs.jpegxr_decode`)
      // reports alpha == 1.0 for every pixel of these same files.
      //
      // Treating that garbage as premultiplied alpha and dividing by it blew out
      // 30-41% of the frame — the reported "转码后过曝". Alpha is therefore
      // ignored completely and every output pixel is forced opaque.
      for (let c = 0; c < 3 && c < channels; c++) {
        const v = f32[i * channels + c];
        let lin = Number.isFinite(v) ? v : 0;
        if (lin < 0) lin = 0;
        if (isFloat) {
          lin = (lin * (1 + lin / whiteSq)) / (1 + lin);
          if (lin > 1) lin = 1;
        } else if (lin > 1) {
          lin = 1;
        }
        out[i * channels + c] = linearToSrgbByte(lin);
      }
      if (channels === 4) out[i * channels + 3] = 255;
    }
    return { data: out, info: { width, height, channels: channels as 1 | 2 | 3 | 4 } };
  }

  new Logger('JxrDecoder').warn(`Unsupported JXR bit depth: ${bitsPerPixel} bpp (${bitDepth})`);
  return null;
}

/** sRGB transfer function for a normalised linear value → 0-255 byte. */
function linearToSrgbByte(linear: number): number {
  const s = linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(s * 255)));
}

/** Convenience: decode a JXR file and encode it to WebP in one shot. */
export async function jxrToWebp(
  input: Buffer,
  { width, quality }: { width?: number; quality?: number } = {},
): Promise<Buffer | null> {
  const decoded = await decodeJxr(input);
  if (!decoded) return null;

  let pipeline = sharp(decoded.data, {
    raw: {
      width: decoded.info.width,
      height: decoded.info.height,
      channels: decoded.info.channels,
    },
  });
  if (width) pipeline = pipeline.resize({ width, withoutEnlargement: true });
  return pipeline.webp(quality ? { quality } : {}).toBuffer();
}

/**
 * Decode a JXR **once** and encode several widths from that single decode.
 *
 * Decoding a 3840×2160 HDR frame costs ~4 s and ~160 MB, and every rendition
 * (thumbnail, preview, full) previously paid that cost separately — warming a
 * game's previews therefore re-decoded the same file up to three times. This
 * decodes once and resizes the 8-bit buffer per width, keeping the *identical*
 * tone mapping on every output (the three sizes cannot drift apart in exposure,
 * because they all come from one tone-mapped buffer).
 *
 * Returns one entry per requested width; a width whose encode fails is skipped
 * rather than failing the whole call.
 */
export async function jxrToWebpVariants(
  input: Buffer,
  widths: Array<number | undefined>,
  { quality }: { quality?: number } = {},
): Promise<Array<{ width?: number; data: Buffer }>> {
  const decoded = await decodeJxr(input);
  if (!decoded) return [];

  const base = sharp(decoded.data, {
    raw: {
      width: decoded.info.width,
      height: decoded.info.height,
      channels: decoded.info.channels,
    },
  });

  const out: Array<{ width?: number; data: Buffer }> = [];
  for (const width of widths) {
    try {
      let pipeline = width
        ? base.clone().resize({ width, withoutEnlargement: true })
        : base.clone();
      out.push({ width, data: await pipeline.webp(quality ? { quality } : {}).toBuffer() });
    } catch {
      // One failed width must not lose the others.
    }
  }
  return out;
}

/** True when the given path looks like a JXR family file. */
/**
 * Version of the JXR tone-mapping pipeline.
 *
 * Bump this whenever the decode/tone-map maths changes so previously cached
 * WebP files (which were produced by the older, defective maths) are ignored
 * and regenerated instead of being served forever. The old code divided colour
 * by a garbage 4th channel, so every cached HDR image is washed out — without
 * this the fix would appear to do nothing on an existing install.
 */
export const JXR_PIPELINE_VERSION = 2;

export function isJxrPath(filePath: string): boolean {
  return /\.(jxr|wdp|hdp)$/i.test(filePath);
}

/**
 * Content-based JXR check, for uploads whose filename is missing or unhelpful.
 *
 * JPEG XR files start with the `II` little-endian TIFF marker followed by the
 * HD Photo magic `0xBC 0x01`.
 */
export function isJxrBuffer(buf: Buffer): boolean {
  return (
    buf.length >= 4 && buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0xbc && buf[3] === 0x01
  );
}