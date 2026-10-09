/**
 * packages/core/test/release-verify.test.ts
 * Offline release verification used by the maintenance scripts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { OFFICIAL_RELEASES_BASE, VERIFY_CODES, verifyRelease } from '@octo/core';

let dir: string;
let pub: string;
let priv: crypto.KeyObject;
const installerBytes = crypto.randomBytes(4096);

function writeManifest(sha: string, signWith = priv): string {
  const release = {
    version: '9.9.9', severity: 'security', changelog: { en: 'x', pl: 'x' }, components: ['app'], requiresRestart: true,
    files: [{ platform: 'win32', arch: 'x64', name: 'OctoSuite-Setup-9.9.9.exe', url: `${OFFICIAL_RELEASES_BASE}/download/v9.9.9/OctoSuite-Setup-9.9.9.exe`, sha256: sha, size: installerBytes.length }],
  };
  const bytes = Buffer.from(JSON.stringify({ schema: 1, channel: 'stable', publishedAt: new Date().toISOString(), apps: { octobrowser: release, octodetect: release } }));
  const file = path.join(dir, 'latest.json');
  fs.writeFileSync(file, bytes);
  fs.writeFileSync(`${file}.sig`, crypto.sign(null, bytes, signWith).toString('base64'));
  return file;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-rv-'));
  const kp = crypto.generateKeyPairSync('ed25519');
  priv = kp.privateKey;
  pub = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  fs.writeFileSync(path.join(dir, 'OctoSuite-Setup-9.9.9.exe'), installerBytes);
});

describe('verifyRelease', () => {
  const sha = () => crypto.createHash('sha256').update(installerBytes).digest('hex');

  it('accepts a correctly signed manifest and matching installer', () => {
    const m = writeManifest(sha());
    const r = verifyRelease(m, path.join(dir, 'OctoSuite-Setup-9.9.9.exe'), 'octobrowser', pub);
    expect(r).toMatchObject({ ok: true, code: VERIFY_CODES.ok, version: '9.9.9', installer: { match: true } });
  });

  it('fails closed without a public key', () => {
    const m = writeManifest(sha());
    expect(verifyRelease(m, undefined, 'octodetect', '').code).toBe(VERIFY_CODES.notConfigured);
  });

  it('rejects a manifest signed with another key', () => {
    const other = crypto.generateKeyPairSync('ed25519').privateKey;
    const m = writeManifest(sha(), other);
    expect(verifyRelease(m, undefined, 'octodetect', pub).code).toBe(VERIFY_CODES.badSignature);
  });

  it('rejects a tampered manifest', () => {
    const m = writeManifest(sha());
    const txt = fs.readFileSync(m, 'utf8').replace('9.9.9', '9.9.8');
    fs.writeFileSync(m, txt);
    expect(verifyRelease(m, undefined, 'octodetect', pub).code).toBe(VERIFY_CODES.badSignature);
  });

  it('detects an installer whose hash does not match', () => {
    const m = writeManifest('0'.repeat(64));
    const r = verifyRelease(m, path.join(dir, 'OctoSuite-Setup-9.9.9.exe'), 'octobrowser', pub);
    expect(r.code).toBe(VERIFY_CODES.hashMismatch);
    expect(r.ok).toBe(false);
  });

  it('reports missing files as I/O errors', () => {
    expect(verifyRelease(path.join(dir, 'nope.json'), undefined, 'octobrowser', pub).code).toBe(VERIFY_CODES.ioError);
  });
});
