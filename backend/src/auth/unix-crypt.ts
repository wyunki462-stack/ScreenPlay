/**
 * crypt(3) verification for NAS system accounts — implemented in pure JS.
 *
 * The app runs inside an Alpine container as an unprivileged user, so it cannot
 * call PAM or crypt(3) itself, and the image has no C++ toolchain to build a
 * native binding. What it *can* do is read the host user database if it is
 * mounted in (see docker-compose.yml) and verify the hash here.
 *
 * Debian/Ubuntu NAS systems write `ENCRYPT_METHOD SHA512` (verified on this
 * host), i.e. `$6$`. SHA-256 (`$5$`) and MD5 (`$1$`) are supported too so older
 * entries keep working. yescrypt (`$y$`) is detected and reported rather than
 * silently failing — it cannot be verified without the yescrypt primitive.
 *
 * Algorithm: Ulrich Drepper's "Unix crypt using SHA-256 and SHA-512" spec.
 */
import { createHash } from 'node:crypto';

const B64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Emit `n` base64 chars, least-significant 6 bits first (glibc b64_from_24bit). */
function b64From24Bit(b2: number, b1: number, b0: number, n: number, out: string[]): void {
  let w = (b2 << 16) | (b1 << 8) | b0;
  for (let i = 0; i < n; i++) {
    out.push(B64[w & 0x3f]);
    w >>>= 6;
  }
}

type DigestName = 'sha512' | 'sha256' | 'md5';

function digest(name: DigestName, parts: Buffer[]): Buffer {
  const h = createHash(name);
  for (const p of parts) h.update(p);
  return h.digest();
}

/**
 * Iterated digest as specified by Drepper. `sha512`/`sha256` share the layout
 * (only the digest length and the final byte-order table differ); MD5 uses the
 * simpler MD5-crypt construction.
 */
function sha2Crypt(
  name: 'sha512' | 'sha256',
  password: Buffer,
  salt: Buffer,
  rounds: number,
): Buffer {
  const digestLen = name === 'sha512' ? 64 : 32;
  const keyLen = password.length;

  // B = H(password + salt + password)
  let B = digest(name, [password, salt, password]);

  // A = H(password + salt + B-for-each-key-block + per-bit(B|password))
  const parts: Buffer[] = [password, salt];
  for (let cnt = keyLen; cnt > digestLen; cnt -= digestLen) parts.push(B);
  parts.push(B.subarray(0, cnt_rem(keyLen, digestLen)));
  for (let cnt = keyLen; cnt > 0; cnt >>>= 1) {
    if (cnt & 1) parts.push(B);
    else parts.push(password);
  }
  let A = digest(name, parts);

  // DP = H(password repeated keyLen times) -> p_bytes of exactly keyLen bytes
  const dpParts: Buffer[] = [];
  for (let i = 0; i < keyLen; i++) dpParts.push(password);
  const DP = digest(name, dpParts);
  const pBytes = repeatToLength(DP, keyLen);

  // DS = H(salt repeated (16 + A[0]) times) -> s_bytes of exactly saltLen bytes
  const dsParts: Buffer[] = [];
  for (let i = 0; i < 16 + A[0]; i++) dsParts.push(salt);
  const DS = digest(name, dsParts);
  const sBytes = repeatToLength(DS, salt.length);

  // The expensive mixing loop.
  for (let cnt = 0; cnt < rounds; cnt++) {
    const round: Buffer[] = [];
    if (cnt & 1) round.push(pBytes);
    else round.push(A);
    if (cnt % 3) round.push(sBytes);
    if (cnt % 7) round.push(pBytes);
    if (cnt & 1) round.push(A);
    else round.push(pBytes);
    A = digest(name, round);
  }
  return A;
}

/** Bytes the spec appends in the "alternate sum" step; mirrors the C loop. */
function cnt_rem(keyLen: number, digestLen: number): number {
  let cnt = keyLen;
  while (cnt > digestLen) cnt -= digestLen;
  return cnt < 0 ? 0 : cnt;
}

/** Repeat `src` until `len` bytes are produced (spec's p_bytes / s_bytes). */
function repeatToLength(src: Buffer, len: number): Buffer {
  if (len <= 0) return Buffer.alloc(0);
  const out = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const n = Math.min(src.length, len - off);
    src.copy(out, off, 0, n);
    off += n;
  }
  return out;
}

/** The SHA-512/SHA-256 output byte ordering from the spec. */
const SHA2_ORDER: readonly (readonly [number, number, number])[] = [
  [0, 21, 42], [22, 43, 1], [44, 2, 23], [3, 24, 45], [25, 46, 4],
  [47, 5, 26], [6, 27, 48], [28, 49, 7], [50, 8, 29], [9, 30, 51],
  [31, 52, 10], [53, 11, 32], [12, 33, 54], [34, 55, 13], [56, 14, 35],
  [15, 36, 57], [37, 58, 16], [59, 17, 38], [18, 39, 60], [40, 61, 19],
  [62, 20, 41],
];

function sha2Encode(name: 'sha512' | 'sha256', A: Buffer): string {
  const out: string[] = [];
  if (name === 'sha512') {
    for (const [a, b, c] of SHA2_ORDER) b64From24Bit(A[a], A[b], A[c], 4, out);
    b64From24Bit(0, 0, A[63], 2, out);
  } else {
    // SHA-256 has a shorter, differently ordered table (10 groups of 4 + 3).
    const order256: readonly (readonly [number, number, number])[] = [
      [0, 10, 20], [21, 1, 11], [12, 22, 2], [3, 13, 23], [24, 4, 14],
      [15, 25, 5], [6, 16, 26], [27, 7, 17], [18, 28, 8], [9, 19, 29],
    ];
    for (const [a, b, c] of order256) b64From24Bit(A[a], A[b], A[c], 4, out);
    b64From24Bit(0, A[31], A[30], 3, out);
  }
  return out.join('');
}

interface ParsedHash {
  scheme: '$1$' | '$5$' | '$6$' | '$y$' | string;
  salt: Buffer;
  saltText: string;
  rounds: number;
}

/** Split `$id$[rounds=N$]salt$hash` into its parts. */
export function parseCryptHash(hash: string): ParsedHash | null {
  if (!hash.startsWith('$')) return null;
  const parts = hash.split('$');
  const scheme = `$${parts[1]}$`;
  let idx = 2;
  let rounds = 5000;
  if (parts[idx]?.startsWith('rounds=')) {
    const n = Number.parseInt(parts[idx].slice('rounds='.length), 10);
    if (Number.isFinite(n)) rounds = Math.min(Math.max(n, 1000), 999999999);
    idx++;
  }
  const saltText = parts[idx] ?? '';
  const maxSalt = scheme === '$1$' ? 8 : 16;
  return {
    scheme,
    salt: Buffer.from(saltText.slice(0, maxSalt), 'utf8'),
    saltText: saltText.slice(0, maxSalt),
    rounds: scheme === '$1$' ? 1000 : rounds,
  };
}

/** MD5-crypt (`$1$`) — older entries only. */
function md5Crypt(password: Buffer, salt: Buffer): Buffer {
  const magic = Buffer.from('$1$');
  const mix = (parts: Buffer[]) => digest('md5', parts);
  let ctx = mix([password, magic, salt]);

  const alt = digest('md5', [password, salt, password]);
  const parts: Buffer[] = [password, magic, salt];
  for (let cnt = password.length; cnt > 0; cnt -= 16) parts.push(alt.subarray(0, Math.min(16, cnt)));
  for (let cnt = password.length; cnt > 0; cnt >>= 1) {
    parts.push(cnt & 1 ? Buffer.from([0]) : password.subarray(0, 1));
  }
  ctx = mix(parts);

  for (let i = 0; i < 1000; i++) {
    const p: Buffer[] = [];
    p.push(i & 1 ? password : ctx);
    if (i % 3) p.push(salt);
    if (i % 7) p.push(password);
    p.push(i & 1 ? ctx : password);
    ctx = mix(p);
  }
  return ctx;
}

function md5Encode(ctx: Buffer): string {
  const out: string[] = [];
  const triples: readonly (readonly [number, number, number])[] = [
    [0, 6, 12], [1, 7, 13], [2, 8, 14], [3, 9, 15], [4, 10, 5],
  ];
  for (const [a, b, c] of triples) b64From24Bit(ctx[a], ctx[b], ctx[c], 4, out);
  b64From24Bit(0, 0, ctx[11], 2, out);
  return out.join('');
}

/**
 * Verify `password` against a crypt(3) `hash`.
 *
 * Returns `true`/`false` for a supported hash, or `null` when the scheme cannot
 * be checked here (yescrypt, or a malformed entry) so callers can report an
 * actionable reason instead of "wrong password".
 */
export function verifyUnixCrypt(password: string, hash: string): boolean | null {
  const parsed = parseCryptHash(hash);
  if (!parsed) return null;
  const pw = Buffer.from(password, 'utf8');

  let encoded: string;
  switch (parsed.scheme) {
    case '$6$':
      encoded = sha2Encode('sha512', sha2Crypt('sha512', pw, parsed.salt, parsed.rounds));
      break;
    case '$5$':
      encoded = sha2Encode('sha256', sha2Crypt('sha256', pw, parsed.salt, parsed.rounds));
      break;
    case '$1$':
      encoded = md5Encode(md5Crypt(pw, parsed.salt));
      break;
    default:
      // $y$ (yescrypt) and friends: no pure-JS primitive available.
      return null;
  }

  const expected = hash.split('$').slice(-1)[0];
  // Constant-time-ish compare; timing here is not a practical oracle for an
  // offline NAS login, but avoid short-circuiting on the first difference.
  if (expected.length !== encoded.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ encoded.charCodeAt(i);
  return diff === 0;
}

/** Rebuild the full hash string for a supported scheme (used by tests). */
export function buildCryptHash(password: string, hash: string): string | null {
  const parsed = parseCryptHash(hash);
  if (!parsed) return null;
  const pw = Buffer.from(password, 'utf8');
  switch (parsed.scheme) {
    case '$6$':
      return `$6$${parsed.rounds !== 5000 ? `rounds=${parsed.rounds}$` : ''}${parsed.saltText}$${sha2Encode('sha512', sha2Crypt('sha512', pw, parsed.salt, parsed.rounds))}`;
    case '$5$':
      return `$5$${parsed.rounds !== 5000 ? `rounds=${parsed.rounds}$` : ''}${parsed.saltText}$${sha2Encode('sha256', sha2Crypt('sha256', pw, parsed.salt, parsed.rounds))}`;
    case '$1$':
      return `$1$${parsed.saltText}$${md5Encode(md5Crypt(pw, parsed.salt))}`;
    default:
      return null;
  }
}