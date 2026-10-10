/**
 * packages/core/src/privacy.ts
 *
 * Tracking & fingerprinting protection presets.
 *
 * Design rules:
 *  - NOTHING is randomised per launch or per site. Random, inconsistent values
 *    make a browser MORE unique and look like spoofing. Instead, the Strict
 *    preset BLOCKS read-back of high-entropy APIs (Canvas, WebGL) or reports a
 *    fixed, common, normalised value (e.g. hardwareConcurrency), identical for
 *    every user of that preset - the same approach as Firefox resistFingerprinting.
 *  - Every profile has one consistent, predictable configuration.
 *  - The Tor level never runs Tor inside this engine: it launches the official
 *    Tor Browser, which is the only configuration the Tor Project supports.
 */

/**
 * normal   = behaves like a regular Chrome (every site works; antidetect profiles),
 * standard = tracker/ad blocking + HTTPS-Only,
 * strict   = maximal protection (may break sites),
 * tor      = opened in the official Tor Browser.
 */
export type ProtectionLevel = 'normal' | 'standard' | 'strict' | 'tor';
export const PROTECTION_LEVELS: readonly ProtectionLevel[] = ['normal', 'standard', 'strict', 'tor'];

export interface PrivacySettings {
  level: ProtectionLevel;
  /** Network filter lists (EasyList etc.) for ads. */
  blockAds: boolean;
  /** Network filter lists (EasyPrivacy etc.) for trackers. */
  blockTrackers: boolean;
  /** Upgrade every http:// request to https://, show an interstitial if it fails. */
  httpsOnly: boolean;
  /** Strip Cookie / Set-Cookie on third-party requests. */
  blockThirdPartyCookies: boolean;
  /** Remove utm_*, fbclid, gclid ... from URLs (ClearURLs-style rules). */
  stripTrackingParams: boolean;
  /** Unwrap known redirect wrappers (e.g. l.facebook.com/l.php?u=...). */
  blockBounceTracking: boolean;
  /** Chromium WebRTC IP handling policy. */
  webrtc: 'default' | 'default_public_interface_only' | 'disable_non_proxied_udp';
  /** Canvas: allow, or block pixel read-back (toDataURL/getImageData return blank). */
  canvas: 'allow' | 'block-readback';
  /** WebGL on/off. */
  webgl: 'allow' | 'disabled';
  /** Hardware-revealing APIs: allow real values or report fixed common values / remove. */
  hardwareApis: 'allow' | 'normalize';
  /** Require a user gesture before media can autoplay. */
  blockAutoplay: boolean;
  /** Delete cookies, cache, storage when the profile window closes. */
  clearOnExit: boolean;
  /** Extra confirmation before executable / script downloads. */
  warnDangerousDownloads: boolean;
  /** Block pop-ups not caused by a user click. */
  blockPopups: boolean;
  /** Trim cross-origin Referer to the origin only. */
  trimReferrer: boolean;
  /** Send Sec-GPC: 1 (Global Privacy Control). Same for all profiles of a preset. */
  globalPrivacyControl: boolean;
  /** Geolocation permission policy. */
  geolocation: 'ask' | 'block';
  /** Notifications permission policy. */
  notifications: 'ask' | 'block';
  /** Ask before a page redirects the top frame to another site without a click. */
  confirmCrossSiteRedirects: boolean;
}

const STANDARD: PrivacySettings = {
  level: 'standard',
  blockAds: true,
  blockTrackers: true,
  httpsOnly: true,
  blockThirdPartyCookies: true,
  stripTrackingParams: true,
  blockBounceTracking: false,
  webrtc: 'default_public_interface_only',
  canvas: 'allow',
  webgl: 'allow',
  hardwareApis: 'allow',
  blockAutoplay: true,
  clearOnExit: false,
  warnDangerousDownloads: true,
  blockPopups: true,
  trimReferrer: false,
  globalPrivacyControl: true,
  geolocation: 'ask',
  notifications: 'ask',
  confirmCrossSiteRedirects: false,
};

/**
 * Normal: nothing that could make a site behave differently than in Chrome.
 * No HTTPS-Only interstitials, no cookie stripping, no request rewriting, no
 * Sec-GPC header (Chrome does not send it) - fingerprint protection for these
 * profiles comes from the per-profile fingerprint (fingerprint.ts), not from
 * blocking APIs.
 */
const NORMAL: PrivacySettings = {
  level: 'normal',
  blockAds: false,
  blockTrackers: false,
  httpsOnly: false,
  blockThirdPartyCookies: false,
  stripTrackingParams: false,
  blockBounceTracking: false,
  webrtc: 'default_public_interface_only',
  canvas: 'allow',
  webgl: 'allow',
  hardwareApis: 'allow',
  blockAutoplay: false,
  clearOnExit: false,
  warnDangerousDownloads: true,
  blockPopups: true,
  trimReferrer: false,
  globalPrivacyControl: false,
  geolocation: 'ask',
  notifications: 'ask',
  confirmCrossSiteRedirects: false,
};

const STRICT: PrivacySettings = {
  ...STANDARD,
  level: 'strict',
  blockBounceTracking: true,
  webrtc: 'disable_non_proxied_udp',
  canvas: 'block-readback',
  webgl: 'disabled',
  hardwareApis: 'normalize',
  clearOnExit: true,
  trimReferrer: true,
  geolocation: 'block',
  notifications: 'block',
  confirmCrossSiteRedirects: true,
};

/**
 * Tor level: the engine settings below apply only to the (unused) Chromium
 * session. The profile is actually opened in the official Tor Browser.
 */
const TOR: PrivacySettings = { ...STRICT, level: 'tor' };

export function presetFor(level: ProtectionLevel): PrivacySettings {
  switch (level) {
    case 'normal': return { ...NORMAL };
    case 'standard': return { ...STANDARD };
    case 'strict': return { ...STRICT };
    case 'tor': return { ...TOR };
    default: throw new Error(`Unknown protection level: ${String(level)}`);
  }
}

export interface ProtectionConfig {
  level: ProtectionLevel;
  /** User overrides on top of the preset (not allowed for Tor). */
  overrides?: Partial<Omit<PrivacySettings, 'level'>>;
}

/** Effective settings = preset + overrides (overrides ignored for Tor). */
export function effectiveSettings(cfg: ProtectionConfig): PrivacySettings {
  const base = presetFor(cfg.level);
  if (cfg.level === 'tor' || !cfg.overrides) return base;
  const out: PrivacySettings = { ...base };
  for (const [k, v] of Object.entries(cfg.overrides)) {
    if (k in base && k !== 'level' && v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}

export interface ConsistencyIssue {
  /** i18n key. */
  key: string;
  severity: 'info' | 'warn';
}

/**
 * Checks for combinations that weaken protection or make the profile stand out.
 * Used by the privacy panel and OctoDetect's report.
 */
export function checkConsistency(s: PrivacySettings, ctx: { extensionsCount?: number; proxyActive?: boolean } = {}): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  if (s.level === 'strict') {
    if (s.webrtc === 'default') issues.push({ key: 'consistency.strictWebrtc', severity: 'warn' });
    if (s.canvas === 'allow' || s.webgl === 'allow') issues.push({ key: 'consistency.strictFingerprint', severity: 'warn' });
  }
  if (s.level !== 'normal') {
    if (!s.httpsOnly) issues.push({ key: 'consistency.noHttpsOnly', severity: 'warn' });
    if (!s.blockTrackers) issues.push({ key: 'consistency.noTrackerBlocking', severity: 'warn' });
  }
  if (s.level !== 'normal' && ctx.proxyActive && s.webrtc !== 'disable_non_proxied_udp') issues.push({ key: 'consistency.proxyWebrtc', severity: 'warn' });
  if (s.level === 'tor' && (ctx.extensionsCount ?? 0) > 0) issues.push({ key: 'consistency.torExtensions', severity: 'warn' });
  if ((ctx.extensionsCount ?? 0) > 5) issues.push({ key: 'consistency.manyExtensions', severity: 'info' });
  return issues;
}

/** Common, fixed values reported when hardwareApis = 'normalize'. Never random. */
export const NORMALIZED_HARDWARE = Object.freeze({
  hardwareConcurrency: 4,
  deviceMemory: 8,
  maxTouchPoints: 0,
});

/** Query parameters removed when stripTrackingParams is on (subset of ClearURLs global rules). */
export const TRACKING_PARAMS: readonly string[] = Object.freeze([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'utm_name',
  'utm_reader', 'utm_referrer', 'utm_social', 'utm_social-type', 'utm_brand',
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'yclid', 'twclid', 'ttclid',
  'igshid', 'mc_cid', 'mc_eid', '_hsenc', '_hsmi', 'mkt_tok', 'oly_anon_id', 'oly_enc_id',
  'vero_id', 'vero_conv', '__s', 's_cid', 'wickedid', 'rb_clickid', 'ref_src', 'ref_url', 'srsltid',
]);

/** Remove tracking parameters. Returns the same string if nothing changed. */
export function stripTrackingParams(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return url;
  let changed = false;
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.includes(key.toLowerCase())) {
      u.searchParams.delete(key);
      changed = true;
    }
  }
  return changed ? u.toString() : url;
}

/** Known redirect wrappers: host -> query parameter holding the real target. */
const REDIRECT_WRAPPERS: Record<string, string[]> = {
  'l.facebook.com': ['u'],
  'lm.facebook.com': ['u'],
  'l.instagram.com': ['u'],
  'out.reddit.com': ['url'],
  'www.google.com': ['url', 'q'], // only for /url
  'href.li': [],
  'away.vk.com': ['to'],
  'steamcommunity.com': ['url'], // only for /linkfilter/
  'www.youtube.com': ['q'], // only for /redirect
};

/** If url is a known bounce/redirect wrapper, return the real destination. */
export function unwrapBounce(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const params = REDIRECT_WRAPPERS[u.hostname];
  if (!params) return null;
  if (u.hostname === 'www.google.com' && u.pathname !== '/url') return null;
  if (u.hostname === 'steamcommunity.com' && !u.pathname.startsWith('/linkfilter')) return null;
  if (u.hostname === 'www.youtube.com' && u.pathname !== '/redirect') return null;
  if (u.hostname === 'href.li') {
    const target = u.href.slice(u.origin.length + 2); // href.li/?https://...
    return /^https?:\/\//.test(target) ? target : null;
  }
  for (const p of params) {
    const v = u.searchParams.get(p);
    if (v && /^https?:\/\//i.test(v)) return v;
  }
  return null;
}

/** File extensions treated as potentially dangerous downloads on Windows. */
export const DANGEROUS_EXTENSIONS: readonly string[] = Object.freeze([
  'exe', 'msi', 'msix', 'appx', 'bat', 'cmd', 'com', 'scr', 'pif', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse',
  'wsf', 'wsh', 'hta', 'cpl', 'dll', 'lnk', 'reg', 'jar', 'iso', 'img', 'vhd', 'vhdx', 'chm', 'appref-ms',
]);

export function isDangerousFile(name: string): boolean {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return DANGEROUS_EXTENSIONS.includes(ext);
}
