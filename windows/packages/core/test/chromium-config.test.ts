import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NATIVE_CHROMIUM_CONFIG,
  sanitizeNativeChromiumConfig,
  validateNativeChromiumConfig,
} from '../src/chromium-config';

describe('native Chromium configuration contract', () => {
  it('normalizes malformed profile data without accepting unsafe values', () => {
    const value = sanitizeNativeChromiumConfig({
      userAgent: ' InkBrowser\u0000 QA ',
      platform: 'Win32',
      languages: ['en-US', 'en-US', 'not valid!'],
      timezone: 'Europe/Warsaw',
      hardwareConcurrency: 999,
      deviceMetrics: { width: 1, height: 1080, deviceScaleFactor: 2 },
      uaCh: { mobile: false, fullVersion: '155.0.0.0', brands: [{ brand: 'Chromium', version: '155' }] },
    });
    expect(value.userAgent).toBe('InkBrowser QA');
    expect(value.languages).toEqual(['en-US']);
    expect(value.hardwareConcurrency).toBe(DEFAULT_NATIVE_CHROMIUM_CONFIG.hardwareConcurrency);
    expect(value.deviceMetrics.width).toBe(DEFAULT_NATIVE_CHROMIUM_CONFIG.deviceMetrics.width);
    expect(value.timezone).toBe('Europe/Warsaw');
  });

  it('accepts a coherent desktop configuration', () => {
    const value = sanitizeNativeChromiumConfig({
      ...DEFAULT_NATIVE_CHROMIUM_CONFIG,
      userAgent: 'Mozilla/5.0 InkBrowser QA',
      timezone: 'UTC',
    });
    expect(() => validateNativeChromiumConfig(value)).not.toThrow();
  });

  it('requires touch support for a mobile UA-CH configuration', () => {
    const value = sanitizeNativeChromiumConfig({
      ...DEFAULT_NATIVE_CHROMIUM_CONFIG,
      uaCh: { ...DEFAULT_NATIVE_CHROMIUM_CONFIG.uaCh, mobile: true },
      touch: false,
    });
    expect(() => validateNativeChromiumConfig(value)).toThrow(/touch/i);
  });
});
