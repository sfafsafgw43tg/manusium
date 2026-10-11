import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..', '..', '..');
const verifier = path.join(root, 'tools', 'verify-packaged-chromium.mjs');
const version = '155.0.8059.39';
const required = [
  'inkbrowser-chrome.exe', 'chrome.dll', 'chrome_elf.dll', 'chrome_child.dll',
  'resources.pak', 'chrome_100_percent.pak', 'chrome_200_percent.pak',
  'icudtl.dat', 'v8_context_snapshot.bin', 'locales/en-US.pak',
];

function fixture() {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inkbrowser-packaged-'));
  const runtime = path.join(packageRoot, 'resources', 'engines', 'chromium', version);
  for (const name of required) {
    const file = path.join(runtime, ...name.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, name === 'inkbrowser-chrome.exe' ? 'fixture-not-an-executable' : 'runtime-file');
  }
  const exe = path.join(runtime, 'inkbrowser-chrome.exe');
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
  fs.writeFileSync(path.join(runtime, 'runtime.json'), JSON.stringify({
    schema: 'octo.engine-manifest.v1', kind: 'chromium', version,
    executable: 'inkbrowser-chrome.exe', platforms: ['win32-x64'],
    distribution: 'source-built', modified: true, sha256,
  }));
  return { packageRoot, runtime };
}

function run(packageRoot: string) {
  return spawnSync(process.execPath, [verifier, `--root=${packageRoot}`], { encoding: 'utf8' });
}

describe('packaged Chromium verifier', () => {
  it('rejects a missing runtime before packaging', () => {
    const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inkbrowser-empty-'));
    const result = run(packageRoot);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('packaged Chromium manifest is missing');
  });

  it('rejects an invalid executable checksum', () => {
    const { packageRoot, runtime } = fixture();
    const manifestPath = path.join(runtime, 'runtime.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { sha256: string };
    manifest.sha256 = '0'.repeat(64);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = run(packageRoot);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('SHA-256 does not match');
  });

  it('accepts a complete manifest layout without claiming executable launch', () => {
    const { packageRoot } = fixture();
    const result = run(packageRoot);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('verified');
  });
});
