/** packages/core/test/crypto.test.ts - AES-256-GCM + Argon2id wrappers. */
import { describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import {
  DecryptionError, decryptWithKey, decryptWithPassword, encryptWithKey, encryptWithPassword, generateKey,
  isAcceptablePassword, parsePasswordHeader, verifyEd25519, wipe,
} from '../src';
import { FAST_KDF } from './helpers';

describe('key encryption (AES-256-GCM)', () => {
  it('round-trips and uses a fresh nonce each time', () => {
    const key = generateKey();
    const a = encryptWithKey(key, Buffer.from('hello'));
    const b = encryptWithKey(key, Buffer.from('hello'));
    expect(a.equals(b)).toBe(false);
    expect(decryptWithKey(key, a).toString()).toBe('hello');
  });

  it('rejects tampering, wrong key and wrong context', () => {
    const key = generateKey();
    const blob = encryptWithKey(key, Buffer.from('secret data'), 'ctx-a');
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 1;
    expect(() => decryptWithKey(key, tampered, 'ctx-a')).toThrow(DecryptionError);
    expect(() => decryptWithKey(generateKey(), blob, 'ctx-a')).toThrow(DecryptionError);
    expect(() => decryptWithKey(key, blob, 'ctx-b')).toThrow(DecryptionError);
  });

  it('wipe zeroes buffers', () => {
    const k = generateKey();
    wipe(k);
    expect(k.every((b) => b === 0)).toBe(true);
  });
});

describe('password encryption (Argon2id)', () => {
  it('decrypts with the correct password', async () => {
    const blob = await encryptWithPassword('Correct horse 42!', Buffer.from('profile'), { kdf: FAST_KDF });
    expect((await decryptWithPassword('Correct horse 42!', blob)).toString()).toBe('profile');
  });

  it('rejects a wrong password', async () => {
    const blob = await encryptWithPassword('Correct horse 42!', Buffer.from('profile'), { kdf: FAST_KDF });
    await expect(decryptWithPassword('wrong password!!', blob)).rejects.toBeInstanceOf(DecryptionError);
  });

  it('stores random salt and KDF params in the header, never the password', async () => {
    const a = await encryptWithPassword('Pässwörd żółw 1', Buffer.from('x'), { kdf: FAST_KDF });
    const b = await encryptWithPassword('Pässwörd żółw 1', Buffer.from('x'), { kdf: FAST_KDF });
    expect(parsePasswordHeader(a).salt.equals(parsePasswordHeader(b).salt)).toBe(false);
    expect(parsePasswordHeader(a).kdf).toEqual(FAST_KDF);
    expect(a.includes(Buffer.from('Pässwörd'))).toBe(false);
  });

  it('refuses absurd KDF parameters from a crafted file (DoS protection)', async () => {
    const blob = await encryptWithPassword('Correct horse 42!', Buffer.from('x'), { kdf: FAST_KDF });
    blob.writeUInt32BE(64 * 1024 * 1024, 6); // 64 GiB memory
    await expect(decryptWithPassword('Correct horse 42!', blob)).rejects.toBeInstanceOf(DecryptionError);
  });

  it('password policy', () => {
    expect(isAcceptablePassword('short')).toBe(false);
    expect(isAcceptablePassword('Długie hasło 2024!')).toBe(true);
  });
});

describe('Ed25519 verification', () => {
  it('accepts valid and rejects modified data', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const data = Buffer.from('{"schema":1}');
    const sig = crypto.sign(null, data, privateKey);
    expect(verifyEd25519(pem, data, sig)).toBe(true);
    expect(verifyEd25519(pem, Buffer.from('{"schema":2}'), sig)).toBe(false);
  });
});
