export type IdentityOs = 'windows11' | 'windows10' | 'macos' | 'linux' | 'android';
export type ChromiumIdentity = 'chrome' | 'chromium' | 'edge' | 'brave' | 'opera' | 'vivaldi' | 'samsung-internet';
export type FirefoxIdentity = 'firefox' | 'firefox-esr';
export type BrowserIdentity = ChromiumIdentity | FirefoxIdentity;

/** Last checked 2026-10-06 against Chromium 155 brand/version metadata. */
export const LAST_VERIFIED_CHROMIUM_MAJOR = 155;

export function identityMappingStale(identity: ChromiumIdentity, chromiumMajor: number): boolean {
  return ['opera', 'vivaldi', 'samsung-internet'].includes(identity) && chromiumMajor > LAST_VERIFIED_CHROMIUM_MAJOR;
}

export const CHROMIUM_IDENTITIES: readonly ChromiumIdentity[] = ['chrome', 'chromium', 'edge', 'brave', 'opera', 'vivaldi', 'samsung-internet'];
export const FIREFOX_IDENTITIES: readonly FirefoxIdentity[] = ['firefox', 'firefox-esr'];
export const BROWSER_IDENTITIES: readonly BrowserIdentity[] = [...CHROMIUM_IDENTITIES, ...FIREFOX_IDENTITIES];

/** Versions are mappings, not guesses. null means that this engine major is unsupported. */
export const BRAND_VERSION_MAP: Record<ChromiumIdentity, (chromiumMajor: number) => string | null> = {
  chrome: (major) => Number.isInteger(major) && major >= 1 && major <= 999 ? String(major) : null,
  chromium: (major) => Number.isInteger(major) && major >= 1 && major <= 999 ? String(major) : null,
  brave: (major) => Number.isInteger(major) && major >= 115 && major <= 155 ? String(major) : null,
  edge: (major) => Number.isInteger(major) && major >= 115 && major <= 155 ? String(major) : null,
  opera: (major) => Number.isInteger(major) && major >= 115 && major <= 155 ? String(major - 18) : null,
  vivaldi: (major) => Number.isInteger(major) && major >= 115 && major <= 155 ? String(major - 2) : null,
  'samsung-internet': (major) => Number.isInteger(major) && major >= 115 && major <= 155 ? String(major - 30) : null,
};

export function isFirefoxIdentity(identity: BrowserIdentity): identity is FirefoxIdentity {
  return identity === 'firefox' || identity === 'firefox-esr';
}

export function isChromiumIdentity(identity: BrowserIdentity): identity is ChromiumIdentity {
  return CHROMIUM_IDENTITIES.includes(identity as ChromiumIdentity);
}

export function browserIdentityFor(value: unknown): BrowserIdentity | null {
  return typeof value === 'string' && BROWSER_IDENTITIES.includes(value as BrowserIdentity) ? value as BrowserIdentity : null;
}

export function identityPlatform(identity: ChromiumIdentity, os: IdentityOs): { token: string; mobile: boolean } {
  const mobile = identity === 'samsung-internet';
  if (mobile && os !== 'android') throw new Error('browserIdentity.samsung-internet requires Android');
  const token = os === 'macos' ? 'Macintosh; Intel Mac OS X 10_15_7'
    : os === 'linux' ? 'X11; Linux x86_64'
      : os === 'android' ? 'Linux; Android 10; K'
        : 'Windows NT 10.0; Win64; x64';
  return { token, mobile };
}

export function chromiumIdentityUserAgent(identity: ChromiumIdentity, os: IdentityOs, chromiumMajor: number): string {
  if (!Number.isInteger(chromiumMajor) || chromiumMajor < 1 || chromiumMajor > 999) throw new RangeError('Chromium major version must be an integer from 1 through 999');
  const mapped = BRAND_VERSION_MAP[identity](chromiumMajor);
  if (!mapped) throw new Error(`Unsupported browserIdentity/${identity} for Chromium ${chromiumMajor}`);
  const platform = identityPlatform(identity, os);
  const token = identity === 'edge' ? ` Edg/${mapped}.0.0.0` : identity === 'opera' ? ` OPR/${mapped}.0.0.0` : identity === 'vivaldi' ? ` Vivaldi/${mapped}.0.0.0` : '';
  const mobile = platform.mobile ? ' Mobile' : '';
  return `Mozilla/5.0 (${platform.token}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumMajor}.0.0.0${token}${mobile} Safari/537.36`;
}
