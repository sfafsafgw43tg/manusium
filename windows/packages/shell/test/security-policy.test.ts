import { describe, expect, it } from 'vitest';
import { assertSafeWebPreferences, SAFE_WEB_PREFERENCES, toSafeChromiumSwitches } from '../src/security-policy';
import { profilePartition } from '../src/profile-partition';

describe('Electron security policy', () => {
  it('rejects weakened webPreferences', () => {
    expect(() => assertSafeWebPreferences({ ...SAFE_WEB_PREFERENCES, sandbox: false })).toThrow(/sandbox/);
    expect(() => assertSafeWebPreferences({ ...SAFE_WEB_PREFERENCES, nodeIntegration: true })).toThrow(/nodeIntegration/);
    expect(() => assertSafeWebPreferences({ ...SAFE_WEB_PREFERENCES, enableRemoteModule: true })).toThrow();
    expect(() => assertSafeWebPreferences({ ...SAFE_WEB_PREFERENCES, webviewTag: true })).toThrow();
  });

  it('rejects unsafe Chromium switches before app.commandLine or spawn', () => {
    for (const name of ['--no-sandbox', '--disable-web-security', '--ignore-certificate-errors', '--remote-debugging-port', '--load-extension', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--enable-unsafe-webgpu']) {
      expect(() => toSafeChromiumSwitches([[name]])).toThrow(/unsafe Chromium switch/);
    }
    expect(toSafeChromiumSwitches([['lang', 'en-US']])).toEqual([['lang', 'en-US']]);
  });
});

it('creates distinct persistent partitions and rejects unsafe ids', () => {
  expect(profilePartition('alpha-profile')).toBe('persist:octo-profile-alpha-profile');
  expect(profilePartition('beta-profile')).not.toBe(profilePartition('alpha-profile'));
  expect(() => profilePartition('../default')).toThrow();
});
