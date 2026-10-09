import { describe, expect, it } from 'vitest';
import { CHROMIUM_CATALOG, DEFAULT_CHROMIUM_VERSION, catalogForPlatform, catalogEntry, validateCatalog } from '../src/runtime-catalog';
import { FIREFOX_CATALOG, geckoCatalogEntry } from '../src/gecko-runtime';

describe('Chromium runtime catalog', () => {
  it('has one supported default per platform and a current Stable choice', () => {
    validateCatalog();
    expect(DEFAULT_CHROMIUM_VERSION).toBe('155.0.8059.39');
    expect(catalogForPlatform('linux', 'x64').find((e) => e.default)?.channel).toBe('stable');
    expect(catalogForPlatform('win32', 'x64').find((e) => e.default)?.channel).toBe('stable');
    expect(CHROMIUM_CATALOG.some((e) => e.channel === 'beta' && e.support === 'supported')).toBe(true);
  });
  it('does not allow installing the retired compatibility entry', () => {
    const retired = catalogEntry('140.0.7339.207', 'linux', 'x64');
    expect(retired.support).toBe('retired');
  });
  it('rejects a catalog entry with an unpinned source or invalid checksum', () => {
    expect(() => validateCatalog([{ ...CHROMIUM_CATALOG[0], source: 'https://example.invalid/latest', archiveSha256: 'bad' }])).toThrow(/invalid catalog entry/i);
  });
  it('pins official Mozilla Gecko archives for Linux and Windows', () => {
    expect(FIREFOX_CATALOG[0].source).toContain('ftp.mozilla.org/pub/firefox/releases/140.0');
    expect(FIREFOX_CATALOG[0].archiveSha512).toMatch(/^[a-f0-9]{128}$/);
    expect(geckoCatalogEntry('140.0', 'linux', 'x64').executable).toBe('inkbrowser-firefox');
    expect(geckoCatalogEntry('140.0', 'win32', 'x64').executable).toBe('inkbrowser-firefox.exe');
    expect(geckoCatalogEntry('140.0', 'win32', 'x64').format).toBe('msi');
  });
});
