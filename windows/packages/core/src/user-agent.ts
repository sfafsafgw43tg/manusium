/**
 * Chromium-compatible user agent shared by the profile editor and runtime.
 * Keep this file free of Node imports: renderer code uses it directly.
 * The Chrome product token is retained for web compatibility; shell styling
 * does not change the underlying engine or turn this into Google Chrome.
 */
export type UserAgentOs = 'windows11' | 'windows10' | 'macos' | 'linux' | 'android';

/**
 * The selected shell changes trusted browser chrome, not the rendering engine.
 * Always expose an engine-coherent Chromium UA: claiming native Firefox Gecko
 * or Safari WebKit while Chromium-only APIs remain observable is a severe and
 * easily detected identity leak. Chromium itself uses the Chrome product token
 * for compatibility, including unbranded builds.
 */
export function chromiumUserAgent(os: UserAgentOs, major: number): string {
  if (!Number.isInteger(major) || major < 1 || major > 999) {
    throw new RangeError('Chromium major version must be an integer from 1 through 999');
  }
  const platform = os === 'macos' ? 'Macintosh; Intel Mac OS X 10_15_7' :
    os === 'linux' ? 'X11; Linux x86_64' :
    os === 'android' ? 'Linux; Android 10; K' :
    'Windows NT 10.0; Win64; x64';
  if (os === 'android') {
    return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`;
  }
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
