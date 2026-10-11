import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { discoverEngineRuntime, EngineRunnerError, ENGINE_MANIFEST_SCHEMA } from '../src/engine-runtime';

function runtimeRoot(kind: 'chromium' | 'gecko', executable: string): { root: string; exe: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-engine-runtime-'));
  const versionRoot = path.join(root, '1.0.0');
  fs.mkdirSync(versionRoot, { recursive: true });
  const exe = path.join(versionRoot, executable);
  fs.writeFileSync(exe, 'test executable');
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
  fs.writeFileSync(path.join(versionRoot, 'runtime.json'), JSON.stringify({
    schema: ENGINE_MANIFEST_SCHEMA,
    kind,
    version: '1.0.0',
    executable,
    protocol: kind === 'chromium' ? 'cdp' : 'juggler',
    platforms: ['linux-x64'],
    capabilities: ['window', 'tabs', 'navigation', 'crash-recovery'],
    sha256,
  }));
  return { root, exe };
}

describe('packaged engine runtime discovery', () => {
  it('discovers the newest manifest runtime and keeps the executable inside it', () => {
    const { root, exe } = runtimeRoot('chromium', 'inkbrowser-chrome');
    const found = discoverEngineRuntime('chromium', {
      resourcesPath: '/does-not-exist',
      env: { OCTO_CHROMIUM_RUNTIME: root },
      platform: 'linux',
      arch: 'x64',
    });
    expect(found.executablePath).toBe(exe);
    expect(found.manifest.protocol).toBe('cdp');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects a manifest whose executable escapes the runtime directory', () => {
    const { root } = runtimeRoot('chromium', '../outside');
    expect(() => discoverEngineRuntime('chromium', {
      resourcesPath: '/does-not-exist',
      env: { OCTO_CHROMIUM_RUNTIME: root },
      platform: 'linux',
      arch: 'x64',
    })).toThrowError(EngineRunnerError);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports a missing packaged runtime instead of falling back silently', () => {
    expect(() => discoverEngineRuntime('gecko', {
      resourcesPath: '/does-not-exist',
      env: { OCTO_GECKO_RUNTIME: '/does-not-exist/gecko' },
      platform: 'linux',
      arch: 'x64',
    })).toThrow(/No packaged gecko runtime found/);
  });

  it('rejects a packaged executable whose recorded checksum is wrong', () => {
    const { root, exe } = runtimeRoot('chromium', 'inkbrowser-chrome');
    const manifestPath = path.join(root, '1.0.0', 'runtime.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.sha256 = '0'.repeat(64);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => discoverEngineRuntime('chromium', {
      resourcesPath: '/does-not-exist', env: { OCTO_CHROMIUM_RUNTIME: root }, platform: 'linux', arch: 'x64',
    })).toThrow(/checksum mismatch/i);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects Windows Chromium unless the manifest identifies a modified source build', () => {
    const { root } = runtimeRoot('chromium', 'inkbrowser-chrome.exe');
    expect(() => discoverEngineRuntime('chromium', {
      resourcesPath: '/does-not-exist', env: { OCTO_CHROMIUM_RUNTIME: root }, platform: 'win32', arch: 'x64',
    })).toThrow(/not source-built/i);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('accepts a hashed Windows source-built Chromium manifest', () => {
    const { root, exe } = runtimeRoot('chromium', 'inkbrowser-chrome.exe');
    const manifestPath = path.join(root, '1.0.0', 'runtime.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.distribution = 'source-built';
    manifest.modified = true;
    manifest.platforms = ['win32-x64'];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const found = discoverEngineRuntime('chromium', {
      resourcesPath: '/does-not-exist', env: { OCTO_CHROMIUM_RUNTIME: root }, platform: 'win32', arch: 'x64',
    });
    expect(found.executablePath).toBe(exe);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
