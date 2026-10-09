import { describe, expect, it } from 'vitest';
import { defaultSettings, searchEngineQueryUrl, validateSettings } from '../src/settings';

describe('settings validation', () => {
  it('rejects non-plain settings and strictly validates numbers and booleans', () => {
    expect(() => validateSettings(null)).toThrow();
    const value = { ...defaultSettings(), security: { autoLockMinutes: null }, network: { publicIpLookup: 'false', autoRefresh: 1 } };
    const result = validateSettings(value);
    expect(result.security.autoLockMinutes).toBe(15);
    expect(result.network.publicIpLookup).toBe(false);
    expect(result.network.autoRefresh).toBe(false);
  });
  it('validates DoH without spreading untrusted keys and preserves the base', () => {
    const value = { ...defaultSettings(), network: { dns: { mode: 'doh', provider: 'custom', customTemplate: 'https://user:pass@example.test/dns' } } };
    const result = validateSettings(value);
    expect(result.network.dns.customTemplate).toBe('');
    expect(Object.prototype.hasOwnProperty.call(result.network.dns, '__proto__')).toBe(false);
  });
  it('validates graphics exposure, session persistence, and Windows isolation fail-closed', () => {
    const result = validateSettings({ ...defaultSettings(), privacyRuntime: {
      graphicsExposure: 'unexpected', sessionPersistence: 'unexpected', windowsIsolation: 'unexpected',
    } });
    expect(result.privacyRuntime).toEqual({ graphicsExposure: 'native', sessionPersistence: 'persistent', windowsIsolation: 'none' });
    const enabled = validateSettings({ ...defaultSettings(), privacyRuntime: {
      graphicsExposure: 'block', sessionPersistence: 'ephemeral', windowsIsolation: 'sandbox-no-vgpu',
    } });
    expect(enabled.privacyRuntime).toEqual({ graphicsExposure: 'block', sessionPersistence: 'ephemeral', windowsIsolation: 'sandbox-no-vgpu' });
  });
  it('uses the canonical search IDs and encodes queries', () => {
    expect(searchEngineQueryUrl('searx', 'a b&c')).toContain('a%20b%26c');
    expect(validateSettings({ ...defaultSettings(), network: { searchEngine: 'searxng' } }).network.searchEngine).toBe('searx');
  });
});
