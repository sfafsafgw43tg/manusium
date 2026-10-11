/** packages/core/test/privacy.test.ts - presets are deterministic, consistent and never random. */
import { describe, expect, it } from 'vitest';
import { checkConsistency, effectiveSettings, isDangerousFile, presetFor, stripTrackingParams, unwrapBounce } from '../src';

describe('privacy presets', () => {
  it('are deterministic (no randomisation between calls/launches)', () => {
    for (const lvl of ['standard', 'strict', 'tor'] as const) {
      expect(presetFor(lvl)).toEqual(presetFor(lvl));
    }
  });

  it('strict is stronger than standard', () => {
    const s = presetFor('standard');
    const x = presetFor('strict');
    expect(s.httpsOnly && x.httpsOnly).toBe(true);
    expect(x.webrtc).toBe('disable_non_proxied_udp');
    expect(x.canvas).toBe('block-readback');
    expect(x.webgl).toBe('disabled');
    expect(x.clearOnExit).toBe(true);
    expect(checkConsistency(x)).toEqual([]);
  });

  it('Tor ignores overrides', () => {
    expect(effectiveSettings({ level: 'tor', overrides: { webgl: 'allow' } }).webgl).toBe('disabled');
    expect(effectiveSettings({ level: 'standard', overrides: { webgl: 'disabled' } }).webgl).toBe('disabled');
  });

  it('flags inconsistent combinations', () => {
    const s = effectiveSettings({ level: 'strict', overrides: { webrtc: 'default' } });
    expect(checkConsistency(s).map((i) => i.key)).toContain('consistency.strictWebrtc');
    expect(checkConsistency(presetFor('standard'), { proxyActive: true }).map((i) => i.key)).toContain('consistency.proxyWebrtc');
  });

  it('strips tracking parameters and unwraps bounce redirects', () => {
    expect(stripTrackingParams('https://a.pl/x?utm_source=n&id=5&fbclid=abc')).toBe('https://a.pl/x?id=5');
    expect(stripTrackingParams('https://a.pl/x?id=5')).toBe('https://a.pl/x?id=5');
    expect(unwrapBounce('https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.org%2F&h=x')).toBe('https://example.org/');
    expect(unwrapBounce('https://www.google.com/search?q=https://x')).toBeNull();
  });

  it('recognises dangerous downloads', () => {
    expect(isDangerousFile('setup.EXE')).toBe(true);
    expect(isDangerousFile('raport.pdf')).toBe(false);
  });
});
