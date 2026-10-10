/**
 * packages/core/src/crypto.ts
 *
 * All cryptography in OctoSuite goes through this module.
 *
 *  - NO custom algorithms: AES-256-GCM comes from Node's OpenSSL binding
 *    (node:crypto), Argon2id comes from `hash-wasm` (MIT, WASM build of the
 *    reference implementation).
 *  - Random 96-bit nonce per encryption, random 128-bit salt per password
 *    derivation (crypto.randomBytes = OS CSPRNG, BCryptGenRandom on Windows).
 *  - The master password is never stored; only data encrypted with a key
 *    derived from it.
 *  - Buffers holding keys are zeroed after use (`wipe`). JavaScript strings
 *    cannot be wiped (documented limitation).
 *
 * Binary formats (all integers big-endian):
 *
 *   Key-encrypted blob ("OCTK"):
 *     magic[4]="OCTK" | ver[1]=1 | nonce[12] | tag[16] | ciphertext[...]
 *     AAD = magic|ver  (+ optional caller-provided context string)
 *
 *   Password-encrypted blob ("OCTP"):
 *     magic[4]="OCTP" | ver[1]=1 | kdf[1]=1(argon2id) | memKiB[4] | iter[4] |
 *     par[1] | salt[16] | nonce[12] | tag[16] | ciphertext[...]
 *     AAD = everything before nonce (+ optional context string)
 */
import * as crypto from 'node:crypto';
import { argon2id } from 'hash-wasm';

export const KEY_BYTES = 32; // AES-256
const NONCE_BYTES = 12; // GCM standard nonce
const TAG_BYTES = 16;
const SALT_BYTES = 16;

const MAGIC_KEY = Buffer.from('OCTK', 'ascii');
const MAGIC_PWD = Buffer.from('OCTP', 'ascii');
const VERSION = 1;
const KDF_ARGON2ID = 1;

export interface KdfParams {
  /** Memory cost in KiB. */
  memoryKiB: number;
  /** Iterations (time cost). */
  iterations: number;
  /** Degree of parallelism. */
  parallelism: number;
}

/**
 * Default Argon2id parameters: 64 MiB, 3 passes, 1 lane. Above OWASP's
 * minimum recommendation (19 MiB / t=2) and ~0.3-0.8 s on a typical desktop.
 */
export const DEFAULT_KDF: KdfParams = { memoryKiB: 64 * 1024, iterations: 3, parallelism: 1 };

/** Upper bounds accepted when DEcrypting, so a crafted file cannot DoS us. */
const MAX_KDF: KdfParams = { memoryKiB: 1024 * 1024, iterations: 20, parallelism: 8 };
const MIN_KDF: KdfParams = { memoryKiB: 8 * 1024, iterations: 1, parallelism: 1 };

/** Thrown when decryption fails. Deliberately does not say WHY (password vs corruption). */
export class DecryptionError extends Error {
  constructor(message = 'Decryption failed: wrong password or damaged data') {
    super(message);
    this.name = 'DecryptionError';
  }
}

/** Overwrite a buffer with zeros. Safe to call with undefined. */
export function wipe(buf: Uint8Array | undefined | null): void {
  if (buf) buf.fill(0);
}

/** Cryptographically secure random bytes. */
export function randomBytes(n: number): Buffer {
  return crypto.randomBytes(n);
}

/** Generate a fresh random 256-bit data-encryption key. */
export function generateKey(): Buffer {
  return crypto.randomBytes(KEY_BYTES);
}

/** Constant-time buffer comparison. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function checkKdfBounds(p: KdfParams): void {
  const ok =
    Number.isInteger(p.memoryKiB) && Number.isInteger(p.iterations) && Number.isInteger(p.parallelism) &&
    p.memoryKiB >= MIN_KDF.memoryKiB && p.memoryKiB <= MAX_KDF.memoryKiB &&
    p.iterations >= MIN_KDF.iterations && p.iterations <= MAX_KDF.iterations &&
    p.parallelism >= MIN_KDF.parallelism && p.parallelism <= MAX_KDF.parallelism;
  if (!ok) throw new DecryptionError('Unsupported or unsafe KDF parameters');
}

/**
 * Derive a 256-bit key from a password with Argon2id.
 * The caller is responsible for wiping the returned buffer.
 */
export async function deriveKey(password: string, salt: Uint8Array, params: KdfParams = DEFAULT_KDF): Promise<Buffer> {
  if (typeof password !== 'string' || password.length === 0) throw new Error('Password must not be empty');
  if (salt.length < SALT_BYTES) throw new Error('Salt too short');
  checkKdfBounds(params);
  const pwBytes = Buffer.from(password.normalize('NFKC'), 'utf8');
  try {
    const out = await argon2id({
      password: pwBytes,
      salt,
      parallelism: params.parallelism,
      iterations: params.iterations,
      memorySize: params.memoryKiB,
      hashLength: KEY_BYTES,
      outputType: 'binary',
    });
    return Buffer.from(out);
  } finally {
    wipe(pwBytes);
  }
}

function aad(header: Buffer, context?: string): Buffer {
  return context ? Buffer.concat([header, Buffer.from(context, 'utf8')]) : header;
}

/** AES-256-GCM encrypt with a raw 32-byte key. */
export function encryptWithKey(key: Uint8Array, plaintext: Uint8Array, context?: string): Buffer {
  if (key.length !== KEY_BYTES) throw new Error('Key must be 32 bytes');
  const header = Buffer.concat([MAGIC_KEY, Buffer.from([VERSION])]);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(header, context));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([header, nonce, tag, ct]);
}

/** AES-256-GCM decrypt a blob produced by encryptWithKey. */
export function decryptWithKey(key: Uint8Array, blob: Uint8Array, context?: string): Buffer {
  if (key.length !== KEY_BYTES) throw new Error('Key must be 32 bytes');
  const b = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const minLen = MAGIC_KEY.length + 1 + NONCE_BYTES + TAG_BYTES;
  if (b.length < minLen || !b.subarray(0, 4).equals(MAGIC_KEY) || b[4] !== VERSION) {
    throw new DecryptionError('Not an OctoSuite encrypted blob or unsupported version');
  }
  const header = b.subarray(0, 5);
  const nonce = b.subarray(5, 5 + NONCE_BYTES);
  const tag = b.subarray(5 + NONCE_BYTES, 5 + NONCE_BYTES + TAG_BYTES);
  const ct = b.subarray(5 + NONCE_BYTES + TAG_BYTES);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(Buffer.from(header), context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new DecryptionError();
  }
}

/** Encrypt data with a password (Argon2id -> AES-256-GCM). */
export async function encryptWithPassword(
  password: string,
  plaintext: Uint8Array,
  opts: { kdf?: KdfParams; context?: string } = {},
): Promise<Buffer> {
  const kdf = opts.kdf ?? DEFAULT_KDF;
  const salt = crypto.randomBytes(SALT_BYTES);
  const header = Buffer.alloc(4 + 1 + 1 + 4 + 4 + 1 + SALT_BYTES);
  let o = 0;
  MAGIC_PWD.copy(header, o); o += 4;
  header.writeUInt8(VERSION, o); o += 1;
  header.writeUInt8(KDF_ARGON2ID, o); o += 1;
  header.writeUInt32BE(kdf.memoryKiB, o); o += 4;
  header.writeUInt32BE(kdf.iterations, o); o += 4;
  header.writeUInt8(kdf.parallelism, o); o += 1;
  salt.copy(header, o);

  const key = await deriveKey(password, salt, kdf);
  try {
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(header, opts.context));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([header, nonce, cipher.getAuthTag(), ct]);
  } finally {
    wipe(key);
  }
}

/** Parse the header of a password blob (without decrypting). */
export function parsePasswordHeader(blob: Uint8Array): { kdf: KdfParams; salt: Buffer; headerLen: number } {
  const b = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const headerLen = 4 + 1 + 1 + 4 + 4 + 1 + SALT_BYTES;
  if (b.length < headerLen + NONCE_BYTES + TAG_BYTES || !b.subarray(0, 4).equals(MAGIC_PWD)) {
    throw new DecryptionError('Not an OctoSuite password-encrypted file');
  }
  if (b[4] !== VERSION || b[5] !== KDF_ARGON2ID) throw new DecryptionError('Unsupported file version');
  const kdf: KdfParams = {
    memoryKiB: b.readUInt32BE(6),
    iterations: b.readUInt32BE(10),
    parallelism: b.readUInt8(14),
  };
  checkKdfBounds(kdf);
  return { kdf, salt: Buffer.from(b.subarray(15, 15 + SALT_BYTES)), headerLen };
}

/** Decrypt a blob produced by encryptWithPassword. */
export async function decryptWithPassword(password: string, blob: Uint8Array, context?: string): Promise<Buffer> {
  const { kdf, salt, headerLen } = parsePasswordHeader(blob);
  const b = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const header = Buffer.from(b.subarray(0, headerLen));
  const nonce = b.subarray(headerLen, headerLen + NONCE_BYTES);
  const tag = b.subarray(headerLen + NONCE_BYTES, headerLen + NONCE_BYTES + TAG_BYTES);
  const ct = b.subarray(headerLen + NONCE_BYTES + TAG_BYTES);
  const key = await deriveKey(password, salt, kdf);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(header, context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new DecryptionError();
  } finally {
    wipe(key);
  }
}

/** Basic password strength check (length + character classes). Returns a 0-4 score. */
export function passwordStrength(pw: string): number {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 12) score++;
  if (pw.length >= 16) score++;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (classes >= 3) score++;
  if (classes === 4 && pw.length >= 12) score++;
  return Math.min(score, 4);
}

/** Minimum requirements for a master / export password. */
export function isAcceptablePassword(pw: string): boolean {
  return typeof pw === 'string' && pw.length >= 10 && passwordStrength(pw) >= 2;
}

/**
 * Verify an Ed25519 signature (used for update manifests).
 * `publicKeyPem` is an SPKI PEM string embedded in the application.
 */
export function verifyEd25519(publicKeyPem: string, data: Uint8Array, signature: Uint8Array): boolean {
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    return crypto.verify(null, data, key, signature);
  } catch {
    return false;
  }
}
