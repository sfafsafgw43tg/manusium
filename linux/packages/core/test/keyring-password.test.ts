/**
 * packages/core/test/keyring-password.test.ts
 *
 * Master-password mode of the keyring (hasło główne):
 *   - the wrapped key is the only thing on disk, never the password;
 *   - a wrong password never unlocks anything;
 *   - switching between DPAPI and password mode keeps the SAME data key, so all
 *     encrypted data stays readable;
 *   - lock() wipes the in-memory key.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DecryptionError, Keyring, SecretStore, encryptWithKey } from '../src';
import { fakeProtector, tmpDir, FAST_KDF } from './helpers';

const PW = 'Zażółć gęślą jaźń 123';

function keyring(file: string): Keyring {
  return new Keyring(file, fakeProtector(), FAST_KDF);
}

describe('Keyring - master password', () => {
  it('creates a password-mode keyring and never writes the password', async () => {
    const f = path.join(tmpDir(), 'keyring.bin');
    const k = keyring(f);
    await k.create({ password: PW });
    expect(k.mode()).toBe('password');
    expect(k.requiresPassword()).toBe(true);
    const raw = fs.readFileSync(f);
    expect(raw.toString('utf8')).not.toContain(PW);
    expect(raw.toString('utf8')).not.toContain(Buffer.from(k.getKey()).toString('base64'));
    k.lock();
  });

  it('unlocks only with the correct password', async () => {
    const f = path.join(tmpDir(), 'keyring.bin');
    const k = keyring(f);
    await k.create({ password: PW });
    const dek = Buffer.from(k.getKey());
    k.lock();
    expect(k.isUnlocked()).toBe(false);
    await expect(k.unlock('zle-haslo-123')).rejects.toBeInstanceOf(DecryptionError);
    expect(k.isUnlocked()).toBe(false); // a failed attempt leaves nothing open
    await expect(k.unlock()).rejects.toBeInstanceOf(DecryptionError); // no password at all
    await k.unlock(PW);
    expect(k.getKey().equals(dek)).toBe(true);
  });

  it('a wrong password does not damage the keyring file', async () => {
    const f = path.join(tmpDir(), 'keyring.bin');
    const k = keyring(f);
    await k.create({ password: PW });
    const before = fs.readFileSync(f);
    await expect(k.unlock('nieprawidlowe')).rejects.toBeInstanceOf(DecryptionError);
    expect(fs.readFileSync(f).equals(before)).toBe(true);
    await k.unlock(PW); // still opens afterwards
    expect(k.isUnlocked()).toBe(true);
  });

  it('changing the password keeps the same data key, so data stays readable', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'keyring.bin');
    const k = keyring(f);
    await k.create({ password: PW });
    const secrets = new SecretStore(path.join(dir, 'secrets.bin'), k);
    secrets.set('proxy:p-1', 'tajne-haslo-proxy');

    await k.setPassword(PW, 'Nowe hasło główne 456');
    expect(k.mode()).toBe('password');
    expect(k.isUnlocked()).toBe(true);
    expect(secrets.get('proxy:p-1')).toBe('tajne-haslo-proxy'); // same DEK

    // ...and after a full restart with the NEW password
    const k2 = keyring(f);
    await k2.unlock('Nowe hasło główne 456');
    expect(new SecretStore(path.join(dir, 'secrets.bin'), k2).get('proxy:p-1')).toBe('tajne-haslo-proxy');
  });

  it('rejects changing the password with a wrong current one', async () => {
    const dir = tmpDir();
    const k = keyring(path.join(dir, 'keyring.bin'));
    await k.create({ password: PW });
    await expect(k.setPassword('zle', 'Inne hasło 789')).rejects.toBeInstanceOf(DecryptionError);
    expect(k.mode()).toBe('password');
  });

  it('removing the password falls back to DPAPI with the same data key', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'keyring.bin');
    const k = keyring(f);
    await k.create({ password: PW });
    const secrets = new SecretStore(path.join(dir, 'secrets.bin'), k);
    secrets.set('proxy:p-2', 'wartosc');
    const dek = Buffer.from(k.getKey());

    await k.removePassword(PW);
    expect(k.mode()).toBe('os');
    expect(k.requiresPassword()).toBe(false);
    expect(k.getKey().equals(dek)).toBe(true);

    const k2 = keyring(f);
    await k2.unlock(); // no password needed any more
    expect(new SecretStore(path.join(dir, 'secrets.bin'), k2).get('proxy:p-2')).toBe('wartosc');
  });

  it('a DPAPI keyring can be upgraded to a master password without losing data', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'keyring.bin');
    const k = keyring(f);
    await k.create(); // DPAPI mode
    const secrets = new SecretStore(path.join(dir, 'secrets.bin'), k);
    secrets.set('proxy:p-3', 'abc');
    await k.setPassword(null, PW);
    expect(k.mode()).toBe('password');
    const k2 = keyring(f);
    await k2.unlock(PW);
    expect(new SecretStore(path.join(dir, 'secrets.bin'), k2).get('proxy:p-3')).toBe('abc');
  });

  it('resetToNewKey can create a password-mode keyring after a failure', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'keyring.bin');
    const broken = new Keyring(f, fakeProtector(true, false), FAST_KDF);
    await broken.create();
    const other = new Keyring(f, fakeProtector(true, false), FAST_KDF); // another Windows account
    await expect(other.unlock()).rejects.toBeInstanceOf(DecryptionError);
    await other.resetToNewKey(path.join(dir, 'backups'), { password: PW });
    expect(other.mode()).toBe('password');
    const again = new Keyring(f, fakeProtector(), FAST_KDF);
    await again.unlock(PW);
    expect(again.isUnlocked()).toBe(true);
  });
});
