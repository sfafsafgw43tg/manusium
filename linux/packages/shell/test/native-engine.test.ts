import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { nativeEngineArgs } from '../src/native-engine';

describe('native engine process contract', () => {
  const profile = path.resolve('/tmp/octo-native-test-profile');

  it('builds isolated Chromium arguments with a DevTools endpoint', () => {
    expect(nativeEngineArgs('chromium', { profileDir: profile, debugPort: 9229, headless: true, url: 'about:blank' })).toEqual([
      `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', '--headless=new',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9229', '--remote-allow-origins=http://127.0.0.1:9229', 'about:blank',
    ]);
  });

  it('builds isolated Gecko arguments without a shell command string', () => {
    expect(nativeEngineArgs('firefox', { profileDir: profile, debugPort: 9230, headless: true, url: 'about:blank' })).toEqual([
      '-profile', profile, '-no-remote', '--headless', '--remote-debugging-port', '9230', 'about:blank',
    ]);
  });

  it('uses real app-like launch flags when App window mode is enabled', () => {
    expect(nativeEngineArgs('chromium', { profileDir: profile, appMode: true, url: 'https://example.test' })).toContain('--app=https://example.test');
    expect(nativeEngineArgs('firefox', { profileDir: profile, appMode: true, url: 'https://example.test' })).toContain('--kiosk');
    expect(nativeEngineArgs('firefox', { profileDir: profile, appMode: true, url: 'https://example.test' })).toContain('https://example.test');
    expect(nativeEngineArgs('chromium', { profileDir: profile, appMode: true, url: 'https://example.test' })).not.toContain('https://example.test');
  });

  it('rejects relative profile directories and invalid ports', () => {
    expect(() => nativeEngineArgs('chromium', { profileDir: 'relative/profile' })).toThrow(/absolute/);
    expect(() => nativeEngineArgs('chromium', { profileDir: profile, debugPort: 0 })).toThrow(/debug port/);
  });

  it('does not allow callers to widen or replace the controlled debug endpoint', () => {
    expect(() => nativeEngineArgs('chromium', { profileDir: profile, debugPort: 9229, extraArgs: ['--remote-debugging-address=0.0.0.0'] })).toThrow(/controlled/);
    expect(() => nativeEngineArgs('firefox', { profileDir: profile, debugPort: 9230, extraArgs: ['--remote-debugging-port=1'] })).toThrow(/controlled/);
  });
});
