/**
 * Password hashing for the single owner. Hashes are PHC strings, the format `R2_PASSWORD_HASH`
 * accepts: `$scrypt$ln=15,r=8,p=1$<salt>$<hash>` (what R2 creates) or
 * `$argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>` (accepted for verification).
 *
 * Only `node:crypto` is imported so the hashing CLI can run under Node's type stripping.
 */
import { argon2, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const MAX_MEMORY_BYTES = 256 * 1024 * 1024;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

export interface ScryptCost {
  /** log2 of the CPU/memory cost N. */
  ln: number;
  r: number;
  p: number;
}

export const DEFAULT_SCRYPT_COST: ScryptCost = { ln: 15, r: 8, p: 1 };

const b64 = (buf: Buffer): string => buf.toString('base64').replace(/=+$/, '');

function derive(password: string, salt: Buffer, cost: ScryptCost, keyBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      keyBytes,
      { N: 2 ** cost.ln, r: cost.r, p: cost.p, maxmem: MAX_MEMORY_BYTES },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

export async function hashPassword(password: string, cost: ScryptCost = DEFAULT_SCRYPT_COST): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, cost, KEY_BYTES);
  return `$scrypt$ln=${cost.ln},r=${cost.r},p=${cost.p}$${b64(salt)}$${b64(key)}`;
}

function params(segment: string | undefined): Map<string, number> | undefined {
  if (segment === undefined) return undefined;
  const out = new Map<string, number>();
  for (const pair of segment.split(',')) {
    const [key, value] = pair.split('=');
    if (key === undefined || value === undefined || !/^\d{1,9}$/.test(value)) return undefined;
    out.set(key, Number(value));
  }
  return out;
}

const inRange = (n: number | undefined, min: number, max: number): n is number =>
  n !== undefined && Number.isInteger(n) && n >= min && n <= max;

function deriveArgon2(password: string, salt: Buffer, m: number, t: number, p: number, bytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      { message: password.normalize('NFKC'), nonce: salt, parallelism: p, tagLength: bytes, memory: m, passes: t },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/**
 * True only when `password` matches `phc`. A malformed hash, or one with costs outside a
 * sane range, is simply false: verification never throws on stored data.
 */
export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  try {
    const parts = phc.split('$');
    const algorithm = parts[1];
    const salt = Buffer.from(parts[parts.length - 2] ?? '', 'base64');
    const expected = Buffer.from(parts[parts.length - 1] ?? '', 'base64');
    if (parts[0] !== '' || salt.length < 8 || salt.length > 64 || expected.length < 16 || expected.length > 64) return false;

    let actual: Buffer;
    if (algorithm === 'scrypt' && parts.length === 5) {
      const q = params(parts[2]);
      const ln = q?.get('ln');
      const r = q?.get('r');
      const p = q?.get('p');
      if (!inRange(ln, 10, 20) || !inRange(r, 1, 16) || !inRange(p, 1, 8)) return false;
      if (128 * 2 ** ln * r > MAX_MEMORY_BYTES) return false;
      actual = await derive(password, salt, { ln, r, p }, expected.length);
    } else if (algorithm === 'argon2id' && parts.length === 6) {
      const q = params(parts[3]);
      const m = q?.get('m');
      const t = q?.get('t');
      const p = q?.get('p');
      if (!inRange(m, 8, 262144) || !inRange(t, 1, 10) || !inRange(p, 1, 8) || m < 8 * p) return false;
      actual = await deriveArgon2(password, salt, m, t, p, expected.length);
    } else {
      return false;
    }
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
