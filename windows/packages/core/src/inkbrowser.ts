/**
 * InkBrowser: the standalone Chromium base OctoBrowser can start as a second
 * browser engine. These are pure rules. The app finds the executable and starts
 * the process (apps/octobrowser/src/main/inkbrowser.ts). See docs/inkbrowser/BLUEPRINT.md.
 */

export const BROWSER_ENGINES = ['inkbrowser', 'firefox', 'electron'] as const;
export type BrowserEngine = (typeof BROWSER_ENGINES)[number];
/** Profiles saved before the engine choice existed, and any unknown value, stay on Electron. */
export function browserEngineFor(value: unknown): BrowserEngine {
  return value === 'inkbrowser' || value === 'firefox' ? value : 'electron';
}

/**
 * Chrome/Chromium is the default for new profiles. Electron remains available as a
 * lightweight compatibility option for profiles that need the legacy embedded path.
 */
export const NEW_PROFILE_ENGINE: BrowserEngine = 'inkbrowser';
export const DEFAULT_CHROMIUM_RUNTIME_VERSION = '155.0.8059.39';

/** The launcher file of the native Chromium base. */
export const INKBROWSER_EXECUTABLE = 'inkbrowser-chrome.exe';

/** Install folder under %LOCALAPPDATA%: InkBrowser\Application\inkbrowser-chrome.exe */
export const INKBROWSER_INSTALL_DIR = 'InkBrowser';

export function isWebAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Chromium command line for one profile: its own data folder, no first-run pages,
 * and the home page only when it is an ordinary web address. OctoBrowser's own
 * pages (octo://...) are never passed to InkBrowser.
 */
export function inkbrowserLaunchArgs(profileDir: string, homePage = ''): string[] {
  if (!/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(profileDir)) throw new Error('InkBrowser profile folder must be an absolute path');
  const args = [`--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check'];
  if (isWebAddress(homePage)) args.push(homePage);
  return args;
}

/** A setting that InkBrowser cannot apply. The launch is refused rather than run without it. */
export type InkBrowserBlock =
  | 'kill-switch' | 'firefox-identity' | 'fingerprint' | 'protection'
  | 'proxy' | 'dns' | 'sandbox' | 'isolation';

export interface InkBrowserFacts {
  kind: string;
  /** Fingerprint spoofing is on for this profile. */
  fingerprintEnabled: boolean;
  protectionLevel: string;
  protectionOverrides: Record<string, unknown>;
  networkMode: string;
  dnsMode: string;
  sandboxMode: string;
  firefoxIdentity: boolean;
  /** The global Windows isolation setting (sandbox-no-vgpu) is on. */
  windowsIsolation: boolean;
  killSwitchOn: boolean;
}

/**
 * Settings that stop an InkBrowser launch, because InkBrowser does not apply them:
 * the kill switch, a Firefox identity, fingerprint spoofing, any protection level other
 * than Normal (or any protection override), a proxy or non-system network mode, DNS over
 * HTTPS, a sandbox mode, and Windows isolation. An empty list means the profile may run.
 */
export function inkbrowserBlocks(facts: InkBrowserFacts): InkBrowserBlock[] {
  const out: InkBrowserBlock[] = [];
  if (facts.killSwitchOn) out.push('kill-switch');
  if (facts.firefoxIdentity) out.push('firefox-identity');
  if (facts.fingerprintEnabled) out.push('fingerprint');
  const overridden = Object.values(facts.protectionOverrides).some((value) => value === true);
  if (facts.kind === 'private' || facts.kind === 'temporary' || facts.protectionLevel !== 'normal' || overridden) out.push('protection');
  if (facts.networkMode !== 'system') out.push('proxy');
  if (facts.dnsMode === 'doh') out.push('dns');
  if (facts.sandboxMode !== 'none') out.push('sandbox');
  if (facts.windowsIsolation) out.push('isolation');
  return out;
}
