import { describe, expect, it } from 'vitest';
import { BRAND_VERSION_MAP, chromiumIdentityUserAgent } from '../src/browser-identity';
import { defaultProfile, sanitizeFingerprint } from '../src';

describe('browser identity choices', () => {
  it('maps Chromium identities without emitting Gecko or WebKit', () => {
    for (const identity of ['chrome', 'chromium', 'edge', 'brave', 'opera', 'vivaldi'] as const) {
      const ua = chromiumIdentityUserAgent(identity, 'windows11', 140);
      expect(ua).toContain('Chrome/140.0.0.0');
      expect(ua).not.toMatch(/Firefox|AppleWebKit\/605|Safari\/604/);
    }
  });
  it('returns null for unmapped majors instead of inventing a version', () => {
    expect(BRAND_VERSION_MAP.opera(999)).toBeNull();
    expect(() => chromiumIdentityUserAgent('opera', 'windows11', 999)).toThrow(/Unsupported/);
  });
  it('migrates missing identity and rejects Safari and Samsung on desktop', () => {
    const base = defaultProfile('antidetect', 'identity-test').fingerprint;
    expect(sanitizeFingerprint({}, base).browserIdentity).toBe('chrome');
    expect(() => sanitizeFingerprint({ browserIdentity: 'safari' }, base)).toThrow(/browserIdentity/);
    expect(() => sanitizeFingerprint({ browserIdentity: 'samsung-internet' }, base)).toThrow(/Android/);
  });
});
