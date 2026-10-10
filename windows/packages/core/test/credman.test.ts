/**
 * packages/core/test/credman.test.ts
 *
 * Windows Credential Manager backend:
 *   - the PowerShell helper is generated with the right Win32 API surface;
 *   - requests/responses are JSON, so no secret ever appears on a command line;
 *   - write / read / delete / prefix-delete work through an in-memory fake vault;
 *   - the router only uses the vault when it is available.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CREDMAN_MAX_BYTES, CREDMAN_SCRIPT, CredManStore, CredManSecretStore, SecretRouter, SecretStore, type CredRequest,
} from '../src';
import { Keyring } from '../src';
import { fakeProtector, tmpDir } from './helpers';

/** In-memory stand-in for the Windows vault, driven by the generated script. */
function fakeVault(): { runner: (script: string, input: string) => string; store: Map<string, string> } {
  const store = new Map<string, string>();
  const runner = (script: string, input: string): string => {
    // Sanity checks on the generated helper (it must use the documented APIs).
    expect(script).toContain('CredWriteW');
    expect(script).toContain('CredReadW');
    expect(script).toContain('CredDeleteW');
    expect(script).toContain('advapi32.dll');
    const req = JSON.parse(input.split('\n').pop()!) as CredRequest;
    if (req.op === 'write') {
      store.set(req.name, Buffer.from(req.secretB64!, 'base64').toString('utf8'));
      return '{"ok":true}';
    }
    if (req.op === 'read') {
      const v = store.get(req.name);
      return v === undefined
        ? '{"ok":true,"exists":false}'
        : `{"ok":true,"exists":true,"secretB64":"${Buffer.from(v, 'utf8').toString('base64')}"}`;
    }
    store.delete(req.name);
    return '{"ok":true}';
  };
  return { runner, store };
}

describe('CredManStore', () => {
  it('namespaces credentials under the app prefix', () => {
    const { runner } = fakeVault();
    const c = new CredManStore({ prefix: 'OctoSuite/Octo.su', runner, available: () => true });
    expect(c.fullName('proxy:p-1')).toBe('OctoSuite/Octo.su/proxy:p-1');
    expect(c.name).toBe('Windows Credential Manager');
  });

  it('writes, reads and deletes a secret without ever putting it on a command line', () => {
    const { runner, store } = fakeVault();
    const c = new CredManStore({ prefix: 'OctoSuite/Octo.su', runner, available: () => true });
    c.write('proxy:p-1', 'TajneHaslo123');
    expect(store.get('OctoSuite/Octo.su/proxy:p-1')).toBe('TajneHaslo123');
    expect(c.read('proxy:p-1')).toBe('TajneHaslo123');
    expect(c.has('proxy:p-1')).toBe(true);
    c.delete('proxy:p-1');
    expect(c.read('proxy:p-1')).toBeNull();
  });

  it('refuses secrets larger than the Windows credential limit', () => {
    const { runner } = fakeVault();
    const c = new CredManStore({ prefix: 'p', runner, available: () => true });
    expect(() => c.write('big', 'x'.repeat(CREDMAN_MAX_BYTES + 1))).toThrow();
  });

  it('reports unavailable systems instead of silently failing', () => {
    const c = new CredManStore({ prefix: 'p', runner: () => '{"ok":true}', available: () => false });
    expect(c.available()).toBe(false);
    expect(() => c.write('a', 'b')).toThrow();
  });
});

describe('CredManSecretStore', () => {
  it('keeps only names in the index, never the secret', () => {
    const dir = tmpDir();
    const { runner } = fakeVault();
    const credman = new CredManStore({ prefix: 'OctoSuite/OctoDetect.su', runner, available: () => true });
    const s = new CredManSecretStore(path.join(dir, 'credman-index.json'), credman);
    s.set('proxy:p-1', 'Tajne!');
    s.set('proxy:p-2', 'Inne!');
    const index = fs.readFileSync(path.join(dir, 'credman-index.json'), 'utf8');
    expect(index).not.toContain('Tajne');
    expect(index).toContain('proxy:p-1');
    expect(s.ids()).toEqual(['proxy:p-1', 'proxy:p-2']);
    expect(s.get('proxy:p-1')).toBe('Tajne!');
    s.deletePrefix('proxy:p-1');
    expect(s.has('proxy:p-1')).toBe(false);
    expect(s.has('proxy:p-2')).toBe(true);
    expect(s.backend()).toBe('credman');
  });

  it('a damaged index does not lose access to the vault', () => {
    const dir = tmpDir();
    const { runner } = fakeVault();
    const credman = new CredManStore({ prefix: 'p', runner, available: () => true });
    const index = path.join(dir, 'credman-index.json');
    const s = new CredManSecretStore(index, credman);
    s.set('proxy:p-9', 'wartosc');
    fs.writeFileSync(index, '{ uszkodzony json');
    expect(s.ids()).toEqual([]);
    expect(s.get('proxy:p-9')).toBe('wartosc'); // the vault still answers
  });
});

describe('SecretRouter', () => {
  it('follows the selected backend and falls back to local when Credential Manager is unavailable', async () => {
    const dir = tmpDir();
    const keyring = new Keyring(path.join(dir, 'keyring.bin'), fakeProtector());
    await keyring.create();
    const local = new SecretStore(path.join(dir, 'secrets.bin'), keyring);
    const { runner } = fakeVault();
    const credman = new CredManSecretStore(path.join(dir, 'credman-index.json'),
      new CredManStore({ prefix: 'p', runner, available: () => true }));

    let mode: 'local' | 'credman' = 'local';
    let usable = true;
    const router = new SecretRouter(local, credman, () => mode, () => usable);

    router.set('proxy:p-1', ' lokalne');
    expect(router.backend()).toBe('local');
    expect(local.get('proxy:p-1')).toBe(' lokalne');

    mode = 'credman';
    router.set('proxy:p-1', 'w-menedzerze');
    expect(router.backend()).toBe('credman');
    expect(credman.get('proxy:p-1')).toBe('w-menedzerze');
    expect(local.get('proxy:p-1')).toBe(' lokalne'); // the local copy is untouched

    usable = false; // e.g. Windows without the vault
    expect(router.backend()).toBe('local');
    expect(router.get('proxy:p-1')).toBe(' lokalne');
  });
});
