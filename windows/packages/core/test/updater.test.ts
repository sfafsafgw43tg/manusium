/** packages/core/test/updater.test.ts - schedule (daily / every 3rd launch), manifest signature, SHA-256 download. */
import { describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_UPDATE_SETTINGS, OFFICIAL_RELEASES_BASE, UpdateClient, UpdateState, compareVersions, markChecked, onLaunch,
  selectUpdate, verifyAndParseManifest,
} from '../src';
import { tmpDir } from './helpers';

describe('update schedule', () => {
  it('checks on first launch of the day and on every third launch', () => {
    let st: UpdateState = { schema: 1, launchCount: 0 };
    const day1 = new Date(2026, 8, 25, 9, 0);
    let r = onLaunch(st, day1, DEFAULT_UPDATE_SETTINGS);
    expect(r.reason).toBe('first-launch-today');
    st = markChecked(r.state, day1, 'up-to-date');
    r = onLaunch(st, day1, DEFAULT_UPDATE_SETTINGS); // launch 2
    expect(r.reason).toBeNull();
    st = r.state;
    r = onLaunch(st, day1, DEFAULT_UPDATE_SETTINGS); // launch 3
    expect(r.reason).toBe('every-third-launch');
    st = markChecked(r.state, day1, 'up-to-date');
    r = onLaunch(st, new Date(2026, 8, 26, 8, 0), DEFAULT_UPDATE_SETTINGS);
    expect(r.reason).toBe('first-launch-today');
  });

  it('respects disabled auto-check and postponement', () => {
    const now = new Date(2026, 8, 25);
    expect(onLaunch({ schema: 1, launchCount: 2 }, now, { ...DEFAULT_UPDATE_SETTINGS, autoCheck: false }).reason).toBeNull();
    const later = new Date(now.getTime() + 86400000).toISOString();
    expect(onLaunch({ schema: 1, launchCount: 2, postponedUntil: later }, now, DEFAULT_UPDATE_SETTINGS).reason).toBeNull();
  });

  it('compares versions', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
  });
});

function signedManifest(payload: string | Buffer, sha: string, size: number, url?: string) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const manifest = {
    schema: 1, channel: 'stable', publishedAt: '2026-09-25T00:00:00Z',
    apps: {
      octobrowser: {
        version: '0.2.0', severity: 'security', changelog: { en: 'Fixes', pl: 'Poprawki' }, components: ['app'], requiresRestart: true,
        files: [{ platform: 'win32', arch: 'x64', name: 'OctoSuite-Setup-0.2.0.exe', url: url ?? `${OFFICIAL_RELEASES_BASE}/download/v0.2.0/OctoSuite-Setup-0.2.0.exe`, sha256: sha, size }],
      },
    },
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  return { bytes, sig: crypto.sign(null, bytes, privateKey).toString('base64'), pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), payload };
}

describe('manifest verification', () => {
  const sha = crypto.createHash('sha256').update('installer').digest('hex');

  it('accepts a correctly signed manifest and selects the update', () => {
    const m = signedManifest('installer', sha, 9);
    const parsed = verifyAndParseManifest(m.bytes, m.sig, m.pem);
    const sel = selectUpdate(parsed, 'octobrowser', '0.1.0', 'x64');
    expect(sel.available).toBe(true);
    expect(sel.release?.severity).toBe('security');
    expect(selectUpdate(parsed, 'octobrowser', '0.1.0', 'x64', '0.2.0').available).toBe(false);
  });

  it('blocks tampered manifests, missing keys and non-official URLs', () => {
    const m = signedManifest('installer', sha, 9);
    const tampered = Buffer.from(m.bytes.toString().replace('0.2.0', '9.9.9'));
    expect(() => verifyAndParseManifest(tampered, m.sig, m.pem)).toThrow(/INVALID/);
    expect(() => verifyAndParseManifest(m.bytes, m.sig, '')).toThrow(/not configured/);
    const evil = signedManifest('installer', sha, 9, 'https://evil-mirror.example/OctoSuite.exe');
    expect(() => verifyAndParseManifest(evil.bytes, evil.sig, evil.pem)).toThrow(/non-official/);
  });

  it('download verifies SHA-256 and deletes damaged files', async () => {
    const body = Buffer.from('installer');
    const fakeFetch = async () => ({
      ok: true, status: 200,
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
      text: async () => '',
      body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(body)); c.close(); } }),
    });
    const dir = tmpDir();
    const client = new UpdateClient(fakeFetch, 'Octo.su/0.1.0 (win32; x64; stable)', 'x');
    const good = { platform: 'win32' as const, arch: 'x64' as const, name: 'a.exe', url: 'u', sha256: sha, size: body.length };
    const out = await client.download(good, dir);
    expect(fs.readFileSync(out, 'utf8')).toBe('installer');
    const bad = { ...good, name: 'b.exe', sha256: '0'.repeat(64) };
    await expect(client.download(bad, dir)).rejects.toThrow(/mismatch/);
    expect(fs.existsSync(path.join(dir, 'b.exe'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'b.exe.partial'))).toBe(false);
  });
});
