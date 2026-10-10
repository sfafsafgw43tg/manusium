/** packages/core/test/keyring.test.ts - DEK wrapping (DPAPI) and secret store. */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DecryptionError, Keyring, SecretStore } from '../src';
import { fakeProtector, tmpDir, FAST_KDF } from './helpers';

describe('Keyring', () => {
  it('unlocks with no user interaction at all and survives a restart', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'keyring.bin');
    const k1 = new Keyring(f, fakeProtector());
    await k1.create();
    const key = Buffer.from(k1.getKey());
    const k2 = new Keyring(f, fakeProtector());
    await k2.unlock();
    expect(k2.getKey().equals(key)).toBe(true);
  });

  it('never writes the key in the clear and never asks for a password', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'keyring.bin');
    const k = new Keyring(f, fakeProtector());
    await k.create();
    const key = Buffer.from(k.getKey());
    expect(fs.readFileSync(f).includes(key)).toBe(false);
    k.lock();
    expect(() => k.getKey()).toThrow();
    await k.unlock(); // no argument exists - there is no master password any more
    expect(k.getKey().equals(key)).toBe(true);
  });

  it('a keyring Windows can no longer decrypt is quarantined and replaced, not a dead end', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'keyring.bin');
    const k = new Keyring(f, fakeProtector());
    await k.create();
    const old = Buffer.from(k.getKey());

    // Another Windows account / restored machine: DPAPI refuses the blob.
    const broken = new Keyring(f, fakeProtector(true, false));
    await expect(broken.unlock()).rejects.toBeInstanceOf(DecryptionError);

    const quarantine = path.join(dir, 'backups');
    const moved = await broken.resetToNewKey(quarantine);
    expect(moved).toBeTruthy();
    expect(fs.existsSync(moved!)).toBe(true);           // the old file is kept for a later attempt
    expect(path.dirname(moved!)).toBe(quarantine);
    expect(broken.isUnlocked()).toBe(true);             // the app can carry on right away
    expect(broken.getKey().equals(old)).toBe(false);    // with a brand new key
  });

  it('a damaged password-mode keyring is quarantined, not a dead end', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'keyring.bin');
    fs.writeFileSync(f, Buffer.concat([
      Buffer.from('OCKR1\n', 'ascii'),
      Buffer.from(JSON.stringify({ schema: 1, mode: 'password', pwdBlob: 'AAAA', createdAt: '', changedAt: '' }), 'utf8'),
    ]));
    const k = new Keyring(f, fakeProtector());
    expect(k.mode()).toBe('password');
    await expect(k.unlock('cokolwiek')).rejects.toBeInstanceOf(DecryptionError);
    await k.resetToNewKey(path.join(dir, 'backups'));
    expect(k.mode()).toBe('os');
    expect(k.isUnlocked()).toBe(true);
  });

  it('refuses to create a keyring with a too-short master password', async () => {
    const k = new Keyring(path.join(tmpDir(), 'k.bin'), fakeProtector(), FAST_KDF);
    await expect(k.create({ password: 'kr0tkie' })).rejects.toThrow();
  });

  it('refuses to create a keyring when DPAPI is unavailable', async () => {
    const k = new Keyring(path.join(tmpDir(), 'k.bin'), fakeProtector(false));
    await expect(k.create()).rejects.toThrow();
  });
});

describe('SecretStore', () => {
  it('stores secrets encrypted only', async () => {
    const dir = tmpDir();
    const k = new Keyring(path.join(dir, 'keyring.bin'), fakeProtector());
    await k.create();
    const s = new SecretStore(path.join(dir, 'secrets.bin'), k);
    s.set('proxy:p-1', JSON.stringify({ username: 'jan', password: 'Tajne!' }));
    s.set('proxy:p-2', 'x');
    expect(fs.readFileSync(path.join(dir, 'secrets.bin')).toString('latin1')).not.toContain('Tajne');
    expect(JSON.parse(s.get('proxy:p-1')!).password).toBe('Tajne!');
    s.deletePrefix('proxy:p-1');
    expect(s.has('proxy:p-1')).toBe(false);
    expect(s.has('proxy:p-2')).toBe(true);
  });
});
