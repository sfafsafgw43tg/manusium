/**
 * packages/core/src/profiles.ts
 *
 * Profile system. Every profile has:
 *   profiles/<id>/engine/        own Chromium partition: cookies, cache,
 *                                localStorage, IndexedDB, service workers
 *   profiles/<id>/downloads/     own download folder
 *   profiles/<id>/bookmarks.enc  bookmarks  (AES-256-GCM, keyring DEK)
 *   profiles/<id>/history.enc    history    (only if enabled for the profile)
 *   profiles/<id>/session.enc    saved tabs/session
 *   profiles/<id>/engine.vault   only for encrypted profiles while locked
 *
 * Profile METADATA (name, kind, privacy level, proxy rules without passwords,
 * sandbox options...) lives in config/profiles.json via VersionedStore, which
 * backs up before each change. Proxy credentials go to SecretStore - never JSON.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { DataLayout } from './paths';
import { VersionedStore } from './config';
import { copyDir, ensureDir, secureDeleteDir, atomicWriteFile } from './fsutil';
import { ProtectionConfig, ProtectionLevel } from './privacy';
import { browserEngineFor, DEFAULT_CHROMIUM_RUNTIME_VERSION, type BrowserEngine } from './inkbrowser';
import { packDir, unpackTo, isCachePath } from './archive';
import {
  KdfParams, DEFAULT_KDF, decryptWithKey, decryptWithPassword, deriveKey, encryptWithKey, encryptWithPassword,
  wipe,
} from './crypto';
import { generateMnemonic, isValidMnemonic, normalizeMnemonic } from './mnemonic';
import type { SecretStoreApi } from './secretstore';
import { SEARCH_ENGINES, type SearchEngine } from './settings';
import { FingerprintConfig, generateFingerprint, realFingerprint, sanitizeFingerprint } from './fingerprint';
import { PROXY_TYPES, ProxyCheckResult, ProxyType, chromiumRules, isValidHost } from './proxy';
import { ANDROID_VERSIONS, IOS_VERSIONS, MOBILE_DEVICES, MobileDeviceId, MobileEmulationConfig } from './mobile';
import { DEFAULT_ENGINE_PRIVACY, sanitizeEnginePrivacy, type EnginePrivacySettings } from './engine-privacy';

/**
 * antidetect = default profile type: behaves like a normal Chrome for every
 * site, with its own consistent fingerprint (OS, UA, WebGL, hardware ...).
 * The other kinds are privacy presets (see privacy.ts).
 */
export const PROFILE_KINDS = ['antidetect', 'phone', 'personal', 'work', 'private', 'testing', 'temporary', 'tor', 'custom'] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];

export interface NetworkConfig {
  /** system = use Windows proxy settings, direct = no proxy, proxy = rules below. */
  mode: 'system' | 'direct' | 'proxy';
  /** Chromium proxy rules, e.g. "socks5://127.0.0.1:1080" or "http=proxy:8080;https=proxy:8080". No credentials here. */
  proxyRules?: string;
  proxyBypass?: string;
  /** true when a username/password is stored in SecretStore under "proxy:<id>". */
  hasProxyCredentials?: boolean;
  /**
   * Proxy lockdown (default on when mode = "proxy"): the profile may only
   * reach the internet through its proxy. Requests Chromium would send
   * directly - because the proxy is down, a rule does not cover the scheme, or
   * a bypass rule matched - are cancelled instead of leaking to the real
   * connection.
   */
  lockdown?: boolean;
  /**
   * Structured proxy (set by the proxy editor). When present, proxyRules is
   * derived from it; credentials are in SecretStore ("proxy:<id>").
   */
  proxy?: ProfileProxy;
}

export interface ProfileProxy {
  type: ProxyType;
  host: string;
  port: number;
  changeIpUrl: string;
  /** Display name of the proxy (optional). */
  name: string;
  /** Id of the saved proxy it came from ('' = entered in this profile). */
  savedId: string;
}

/** Usage statistics shown in the profile list. */
export interface ProfileStats {
  launches: number;
  lastLaunchAt: string;
  /** Total seconds the profile was open. */
  worktimeSec: number;
}

/** Engine version used for new fingerprints; set by the app from process.versions.chrome. */
let engineFullVersion = '140.0.0.0';
export function setEngineVersion(full: string): void {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(full)) engineFullVersion = full;
}
export function engineVersion(): { full: string; major: number } {
  return { full: engineFullVersion, major: Number(engineFullVersion.split('.')[0]) };
}

/**
 * Every ordinary browser profile gets one newly generated, then stored,
 * coherent fingerprint. Tor remains untouched: changing Tor Browser's common
 * fingerprint would make its user easier to distinguish from the crowd.
 */
export function fingerprintFor(kind: ProfileKind, seed?: string): FingerprintConfig {
  const { full, major } = engineVersion();
  return kind !== 'tor' ? generateFingerprint({ engineMajor: major, engineFullVersion: full, seed }) : realFingerprint(major);
}

/**
 * Per-profile DNS. Each profile runs in its own browser process, so it can use
 * its own resolver configuration. 'inherit' = app-wide setting.
 */
export interface DnsConfig {
  mode: 'inherit' | 'system' | 'doh';
  /** DoH endpoint (https://...). Only used when mode = 'doh'. */
  dohTemplate: string;
}

export interface SandboxConfig {
  /** none = normal Chromium renderer sandbox only; restricted = extra permission lockdown; windows-sandbox = run in Windows Sandbox VM; isolated-vm = run in isolated untraceable Linux VM. */
  mode: 'none' | 'restricted' | 'windows-sandbox' | 'isolated-vm';
  clipboard: 'allow' | 'write-only' | 'block';
  camera: boolean;
  microphone: boolean;
  /** WebUSB / WebHID / Web Serial / Web Bluetooth. */
  externalDevices: boolean;
  /** Share the user's Downloads folder into Windows Sandbox (read-write). Default false: sandbox-only folder. */
  shareDownloads: boolean;
}

export interface AudioConfig {
  muted: boolean;
  /** 0..100 default volume for new tabs of this profile. */
  volume: number;
  /** Preferred output device id (HTMLMediaElement.setSinkId), '' = system default. */
  outputDeviceId: string;
}

/** Host capture inputs selected by label; device ids are origin-salted. */
export interface MediaCaptureConfig {
  cameraLabel: string;
  microphoneLabel: string;
}

/** Download destination policy. Paths are local metadata and remain profile-scoped. */
export interface DownloadConfig {
  /** Open the native Windows Save As picker for every file. */
  askWhereToSave: boolean;
  /** Automatic destination when askWhereToSave is off. Empty = this profile's Downloads folder. */
  defaultDirectory: string;
  /** Last folder accepted in Save As, used only to seed this profile's next picker. */
  lastDirectory: string;
}

export interface Profile {
  id: string;
  name: string;
  kind: ProfileKind;
  /** Accent colour for the profile badge (#rrggbb). */
  color: string;
  createdAt: string;
  updatedAt: string;
  /** Set when the profile is moved to the local Trash. Its browser data stays intact until permanently erased. */
  trashedAt?: string;
  /** Set when the profile is moved to the user-visible Archive. Archived data remains recoverable. */
  archivedAt?: string;
  protection: ProtectionConfig;
  network: NetworkConfig;
  dns: DnsConfig;
  /** Browser engine that runs the profile. Missing means electron (profiles saved before InkBrowser). */
  engine?: BrowserEngine;
  /** Exact catalog version for native Chromium profiles; absent means the catalog default. */
  chromiumRuntime?: string;
  sandbox: SandboxConfig;
  audio: AudioConfig;
  /** Actual host inputs preferred by getUserMedia in this isolated profile. */
  mediaCapture: MediaCaptureConfig;
  /** Per-profile download picker and destination preferences. */
  downloads: DownloadConfig;
  /** Optional Android/iOS handset viewport, touch and browser identity. */
  mobile: MobileEmulationConfig;
  /** Start the optional vStudio Web companion automatically with this profile. */
  vstudioWebOnLaunch: boolean;
  /** Enabled built-in modules / add-ons (ids from addons.ts). */
  addons: string[];
  /** Encrypt engine data at rest with a profile password (vault). */
  encrypted: boolean;
  /** Delete all engine data when the last window of this profile closes. */
  deleteOnClose: boolean;
  /** Store browsing history for this profile. */
  keepHistory: boolean;
  /** Offer the app-owned encrypted login vault for this isolated profile. */
  savePasswords: boolean;
  /** Restore previous session on open. */
  restoreSession: boolean;
  /** Home / start page. */
  homePage: string;
  /** Window chrome colour scheme of this profile: dark grey or white. */
  theme: ProfileTheme;
  /** Visual browser-shell style only; profile pages run on embedded Electron/Chromium. */
  browserShell: BrowserShell;
  /** Search engine for words typed into the address bar. Optional; defaults to app settings. */
  searchEngine?: SearchEngine;
  /** Use the familiar Chrome-style tabs and address bar instead of the OctoBrowser layout. */
  baseChromeLook: boolean;
  /** Keep the selected engine’s ordinary identity and page APIs; no app-owned signal overrides. */
  ordinaryBrowser: boolean;
  /** Present the browser as an app-like window with reduced browser chrome. */
  appMode: boolean;
  /** Normalize pasted address-bar text without changing ordinary typing. */
  smartPaste: boolean;
  /** Browser fingerprint (antidetect). */
  fingerprint: FingerprintConfig;
  /** Native engine settings actually applied by the selected runtime. */
  enginePrivacy: EnginePrivacySettings;
  /** Organisation (profile list). */
  tags: string[];
  folder: string;
  /** Absolute directory containing this profile's engine and encrypted data. Empty uses the app data folder. */
  profileDirectory?: string;
  /** Stable manual position in the launcher list; lower values appear first. */
  sortOrder: number;
  status: string;
  notes: string;
  /** Pages opened on every start (in addition to a restored session). */
  startPages: string[];
  /** Last proxy check (exit IP, country, timezone) - drives "auto" timezone/language/geo. */
  proxyCheck?: ProxyCheckResult;
  stats: ProfileStats;
}

/** Chrome colour scheme of a profile window (no effect on rendered pages). */
export type ProfileTheme = 'dark' | 'light';
/** Trusted shell styles offered by the profile creator, not external engines. */
export type BrowserShell = 'octo' | 'chrome' | 'chromium' | 'firefox' | 'safari';

const THEMES: ProfileTheme[] = ['dark', 'light'];
const BROWSER_SHELLS: BrowserShell[] = ['octo', 'chrome', 'chromium', 'firefox', 'safari'];

export function isBrowserShell(value: unknown): value is BrowserShell {
  return typeof value === 'string' && BROWSER_SHELLS.includes(value as BrowserShell);
}

export function isProfileTheme(value: unknown): value is ProfileTheme {
  return typeof value === 'string' && (THEMES as string[]).includes(value);
}

/**
 * Settings of a private-browsing session: a temporary profile that keeps
 * nothing and is deleted when its last window closes. It is the "temporary"
 * kind with the privacy-relevant switches spelled out, so the promise made in
 * the UI (no history, no cookies kept, no data left behind) is explicit and
 * testable. Nothing here is randomised - every private session gets the same
 * settings; only the name carries the start time.
 */
export function privateBrowsingPatch(): Partial<Omit<Profile, 'id' | 'createdAt' | 'updatedAt' | 'kind'>> {
  return {
    deleteOnClose: true,
    keepHistory: false,
    restoreSession: false,
    protection: { level: 'strict', overrides: { clearOnExit: true, blockThirdPartyCookies: true, stripTrackingParams: true } },
  };
}

/** Local "YYYY-MM-DD HH:MM" stamp for the private-browsing profile name. */
export function privateBrowsingStamp(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export interface ProfilesDoc {
  schema: 1;
  profiles: Profile[];
  lastUsedId?: string;
  /** One-time migration marker for the password-saving default. */
  passwordDefaultsVersion?: number;
  /** One-time migration marker for classic website media permission prompts. */
  mediaPermissionDefaultsVersion?: number;
  /** One-time migration marker for the legacy profile security baseline. */
  securityDefaultsVersion?: number;
}

const COLORS: Record<ProfileKind, string> = {
  antidetect: '#2196f3',
  phone: '#14b8a6',
  personal: '#7c5cff',
  work: '#3b82f6',
  private: '#a855f7',
  testing: '#f59e0b',
  temporary: '#64748b',
  tor: '#7e4798',
  custom: '#22c55e',
};

export const DEFAULT_ADDONS = ['adblock', 'clearurls', 'https-only', 'audio-mixer'];

/**
 * Regular browser profiles offer the encrypted login vault out of the box.
 * Private/temporary/Tor identities keep their non-persistence promise and can
 * still be enabled explicitly by the user.
 */
export function defaultPasswordSaving(kind: ProfileKind): boolean {
  return kind !== 'private' && kind !== 'temporary' && kind !== 'tor';
}

/**
 * Regular profiles let Chromium ask per origin when a site requests camera or
 * microphone, matching a classic browser. Privacy-focused identities remain
 * deny-by-default and can still be enabled explicitly in profile settings.
 */
export function defaultWebsiteMediaPrompts(kind: ProfileKind): boolean {
  return kind !== 'private' && kind !== 'temporary' && kind !== 'tor';
}

/** Build a profile with sensible defaults for its kind. */
export function defaultProfile(kind: ProfileKind, name: string, id = newProfileId(), seed?: string): Profile {
  const now = new Date().toISOString();
  const level: ProtectionLevel = kind === 'antidetect' || kind === 'phone' ? 'normal' : kind === 'tor' ? 'tor' : kind === 'private' || kind === 'temporary' ? 'strict' : 'standard';
  const anti = kind === 'antidetect';
  // New embedded-browser profiles open with the full Chrome-style window chrome;
  // Tor remains an external browser and does not inherit an embedded shell.
  const browserShell: BrowserShell = kind === 'tor' ? 'octo' : 'chrome';
  return {
    id,
    name,
    kind,
    chromiumRuntime: DEFAULT_CHROMIUM_RUNTIME_VERSION,
    color: COLORS[kind],
    createdAt: now,
    updatedAt: now,
    protection: { level },
    network: { mode: 'system' },
    dns: { mode: 'inherit', dohTemplate: '' },
    sandbox: {
      mode: kind === 'testing' || kind === 'private' ? 'restricted' : 'none',
      clipboard: kind === 'private' || kind === 'temporary' ? 'write-only' : 'allow',
      // This controls whether Chromium may show the normal per-site prompt; it
      // is not an origin grant. Regular profiles therefore behave like classic
      // browsers while privacy-focused identities stay explicitly opt-in.
      camera: defaultWebsiteMediaPrompts(kind),
      microphone: defaultWebsiteMediaPrompts(kind),
      externalDevices: false,
      shareDownloads: false,
    },
    audio: { muted: false, volume: 100, outputDeviceId: '' },
    mediaCapture: { cameraLabel: '', microphoneLabel: '' },
    // Native Save As is the safe default. Each profile remembers only its own
    // last/default destination, so opening another profile cannot redirect it.
    downloads: { askWhereToSave: true, defaultDirectory: '', lastDirectory: '' },
    // A Phone profile is ready to use as a virtual Android browser immediately;
    // its editor can switch this to any iOS or Android preset.
    mobile: kind === 'phone' ? { device: 'pixel-8', orientation: 'portrait' } : { device: 'none', orientation: 'portrait' },
    vstudioWebOnLaunch: false,
    addons: kind === 'tor' ? [] : anti ? ['audio-mixer'] : [...DEFAULT_ADDONS],
    encrypted: false,
    deleteOnClose: kind === 'temporary',
    keepHistory: anti || kind === 'personal' || kind === 'work',
    // The app-owned encrypted vault is ready in every regular browser shell.
    // Non-persistent/private identities remain off unless explicitly enabled.
    savePasswords: defaultPasswordSaving(kind),
    restoreSession: anti || kind === 'personal' || kind === 'work',
    homePage: 'octo://newtab',
    theme: 'dark',
    browserShell,
    baseChromeLook: browserShell === 'chrome',
    ordinaryBrowser: kind !== 'antidetect' && kind !== 'phone',
    appMode: false,
    smartPaste: true,
    fingerprint: fingerprintFor(kind, seed),
    enginePrivacy: structuredClone(DEFAULT_ENGINE_PRIVACY),
    tags: [],
    folder: '',
    sortOrder: 0,
    status: '',
    notes: '',
    startPages: [],
    stats: { launches: 0, lastLaunchAt: '', worktimeSec: 0 },
  };
}

function sanitizeProxy(v: unknown): ProfileProxy | undefined {
  const p = v as Partial<ProfileProxy> | undefined;
  if (!p || typeof p !== 'object') return undefined;
  if (!PROXY_TYPES.includes(p.type as ProxyType) || typeof p.host !== 'string' || !isValidHost(p.host)) return undefined;
  const port = Number(p.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  const cip = typeof p.changeIpUrl === 'string' && /^https?:\/\/\S{3,2000}$/.test(p.changeIpUrl) ? p.changeIpUrl : '';
  return {
    type: p.type as ProxyType, host: p.host.toLowerCase(), port, changeIpUrl: cip,
    name: typeof p.name === 'string' ? p.name.slice(0, 64) : '',
    savedId: typeof p.savedId === 'string' && /^[a-z0-9-]{0,64}$/.test(p.savedId) ? p.savedId : '',
  };
}

function sanitizeMobile(v: unknown): MobileEmulationConfig {
  const m = v as Partial<MobileEmulationConfig> | undefined;
  const found = MOBILE_DEVICES.find((d) => d.id === m?.device);
  const device = found ? found.id as MobileDeviceId : 'none';
  const osVersion = found?.os === 'android'
    ? (ANDROID_VERSIONS.includes(m?.osVersion as typeof ANDROID_VERSIONS[number]) ? m!.osVersion as typeof ANDROID_VERSIONS[number] : undefined)
    : found?.os === 'ios'
      ? (IOS_VERSIONS.includes(m?.osVersion as typeof IOS_VERSIONS[number]) ? m!.osVersion as typeof IOS_VERSIONS[number] : undefined)
      : undefined;
  return { device, orientation: m?.orientation === 'landscape' ? 'landscape' : 'portrait', ...(osVersion ? { osVersion } : {}) };
}

function sanitizeCheck(v: unknown): ProxyCheckResult | undefined {
  const c = v as Partial<ProxyCheckResult> | undefined;
  if (!c || typeof c !== 'object' || typeof c.at !== 'string') return undefined;
  const s = (x: unknown, n: number) => (typeof x === 'string' ? x.slice(0, n) : undefined);
  const f = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
  return {
    ok: !!c.ok, at: c.at.slice(0, 40), ip: s(c.ip, 45), country: s(c.country, 64), countryCode: s(c.countryCode, 2), region: s(c.region, 64),
    city: s(c.city, 64), timezone: s(c.timezone, 64), latitude: f(c.latitude), longitude: f(c.longitude), latencyMs: f(c.latencyMs), error: s(c.error, 200),
  };
}

const START_PAGE = /^(https?:\/\/|octo:\/\/)\S{1,2040}$/i;

export function newProfileId(): string {
  return `p-${crypto.randomBytes(6).toString('hex')}`;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Validate and sanitise one profile (defensive: files may be edited or damaged). */
export function sanitizeProfile(input: unknown): Profile {
  const p = input as Partial<Profile>;
  if (!p || typeof p !== 'object') throw new Error('Profile must be an object');
  if (typeof p.id !== 'string' || !/^[a-z0-9-]{3,64}$/.test(p.id)) throw new Error('Invalid profile id');
  if (!PROFILE_KINDS.includes(p.kind as ProfileKind)) throw new Error('Invalid profile kind');
  // Deterministic base (seeded by the id): a profile without a stored fingerprint
  // gets the same generated one on every load instead of a new one each time.
  const base = defaultProfile(p.kind as ProfileKind, 'x', p.id, crypto.createHash('sha256').update(p.id).digest('hex').slice(0, 16));
  const name = typeof p.name === 'string' ? p.name.trim().slice(0, 64) : '';
  if (!name) throw new Error('Profile name required');
  const level = p.protection?.level;
  // Profiles saved before browserShell existed retain their previous Chrome
  // switch exactly: true becomes the Chrome shell, false becomes Octo.
  const browserShell: BrowserShell = isBrowserShell(p.browserShell)
    ? p.browserShell
    : p.baseChromeLook === true ? 'chrome' : 'octo';
  const out: Profile = {
    ...base,
    ...p,
    id: p.id,
    name,
    color: typeof p.color === 'string' && HEX_COLOR.test(p.color) ? p.color : base.color,
    protection: {
      level: level === 'normal' || level === 'standard' || level === 'strict' || level === 'tor' ? level : base.protection.level,
      overrides: p.kind === 'tor' ? undefined : p.protection?.overrides,
    },
    network: { ...base.network, ...(p.network ?? {}) },
    dns: { ...base.dns, ...(p.dns ?? {}) },
    engine: browserEngineFor(p.engine),
    chromiumRuntime: typeof p.chromiumRuntime === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(p.chromiumRuntime) ? p.chromiumRuntime : undefined,
    sandbox: { ...base.sandbox, ...(p.sandbox ?? {}) },
    audio: { ...base.audio, ...(p.audio ?? {}) },
    mediaCapture: {
      cameraLabel: typeof p.mediaCapture?.cameraLabel === 'string' ? p.mediaCapture.cameraLabel.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 160) : '',
      microphoneLabel: typeof p.mediaCapture?.microphoneLabel === 'string' ? p.mediaCapture.microphoneLabel.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 160) : '',
    },
    downloads: {
      askWhereToSave: typeof p.downloads?.askWhereToSave === 'boolean' ? p.downloads.askWhereToSave : true,
      defaultDirectory: typeof p.downloads?.defaultDirectory === 'string' ? p.downloads.defaultDirectory.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 1024) : '',
      lastDirectory: typeof p.downloads?.lastDirectory === 'string' ? p.downloads.lastDirectory.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 1024) : '',
    },
    mobile: sanitizeMobile(p.mobile),
    vstudioWebOnLaunch: typeof p.vstudioWebOnLaunch === 'boolean' ? p.vstudioWebOnLaunch : false,
    addons: Array.isArray(p.addons) ? p.addons.filter((a) => typeof a === 'string').slice(0, 32) : base.addons,
    savePasswords: typeof p.savePasswords === 'boolean' ? p.savePasswords : base.savePasswords,
    theme: isProfileTheme(p.theme) ? p.theme : base.theme,
    browserShell,
    searchEngine: typeof p.searchEngine === 'string' && Object.keys(SEARCH_ENGINES).includes(p.searchEngine) ? (p.searchEngine as SearchEngine) : undefined,
    baseChromeLook: browserShell === 'chrome' || browserShell === 'chromium',
    ordinaryBrowser: typeof p.ordinaryBrowser === 'boolean' ? p.ordinaryBrowser : base.ordinaryBrowser,
    appMode: typeof p.appMode === 'boolean' ? p.appMode : base.appMode,
    smartPaste: typeof p.smartPaste === 'boolean' ? p.smartPaste : base.smartPaste,
    fingerprint: sanitizeFingerprint(p.fingerprint, base.fingerprint),
    enginePrivacy: sanitizeEnginePrivacy(p.enginePrivacy),
    tags: Array.isArray(p.tags) ? [...new Set(p.tags.filter((x) => typeof x === 'string').map((x) => x.trim().slice(0, 32)).filter(Boolean))].slice(0, 20) : [],
    folder: typeof p.folder === 'string' ? p.folder.trim().slice(0, 48) : '',
    profileDirectory: typeof p.profileDirectory === 'string' && path.isAbsolute(p.profileDirectory)
      ? path.resolve(p.profileDirectory).slice(0, 2048)
      : undefined,
    sortOrder: Number.isSafeInteger(p.sortOrder) && Number(p.sortOrder) >= 0 ? Number(p.sortOrder) : 0,
    status: typeof p.status === 'string' ? p.status.trim().slice(0, 32) : '',
    notes: typeof p.notes === 'string' ? p.notes.slice(0, 4000) : '',
    startPages: Array.isArray(p.startPages) ? p.startPages.filter((u) => typeof u === 'string' && START_PAGE.test(u.trim())).map((u) => u.trim()).slice(0, 10) : [],
    proxyCheck: sanitizeCheck(p.proxyCheck),
    stats: {
      launches: Math.max(0, Math.round(Number(p.stats?.launches) || 0)),
      lastLaunchAt: typeof p.stats?.lastLaunchAt === 'string' ? p.stats.lastLaunchAt.slice(0, 40) : '',
      worktimeSec: Math.max(0, Math.round(Number(p.stats?.worktimeSec) || 0)),
    },
  };
  out.network.proxy = sanitizeProxy(p.network?.proxy);
  if (out.network.proxy) {
    out.network.proxyRules = chromiumRules(out.network.proxy);
    if (out.network.mode !== 'proxy') out.network.proxy = undefined;
  }
  out.audio.volume = Math.max(0, Math.min(100, Math.round(Number(out.audio.volume) || 0)));
  if (!['system', 'direct', 'proxy'].includes(out.network.mode)) out.network.mode = 'system';
  // Lockdown is opt-out: a proxy profile is fail-closed unless disabled on purpose.
  out.network.lockdown = out.network.mode === 'proxy' ? p.network?.lockdown !== false : false;
  if (!['inherit', 'system', 'doh'].includes(out.dns.mode)) out.dns.mode = 'inherit';
  if (!isProfileTheme(out.theme)) out.theme = base.theme;
  if (out.dns.dohTemplate && !/^https:\/\/[^\s]+$/.test(out.dns.dohTemplate)) out.dns.dohTemplate = '';
  if (out.dns.mode === 'doh' && !out.dns.dohTemplate) out.dns.mode = 'inherit';
  // A saved concrete input is itself the user's opt-in to that device class;
  // sites still need a separate per-origin permission grant. Migrate profiles
  // saved before the media selector enabled these flags automatically, or the
  // trusted preview works while every website request is denied immediately.
  if (out.mediaCapture.cameraLabel) out.sandbox.camera = true;
  if (out.mediaCapture.microphoneLabel) out.sandbox.microphone = true;
  if (out.network.proxyRules && /[a-z]+:\/\/[^/\s]*:[^/\s]*@/i.test(out.network.proxyRules)) {
    // Credentials embedded in proxy rules are refused - they belong in SecretStore.
    throw new Error('Proxy rules must not contain credentials');
  }
  if (out.kind === 'tor') {
    out.addons = []; // Tor profile: no extra add-ons (they increase uniqueness)
    out.protection = { level: 'tor' };
  }
  return out;
}

function validateDoc(value: unknown): ProfilesDoc {
  const v = value as Partial<ProfilesDoc>;
  if (!v || v.schema !== 1 || !Array.isArray(v.profiles)) throw new Error('Invalid profiles document');
  const seen = new Set<string>();
  const profiles = v.profiles.map((raw, index) => {
    const p = sanitizeProfile(raw);
    // Older profile documents had no order field. Preserve their file order
    // once, then all subsequent reorders use explicit numeric positions.
    return raw && typeof raw === 'object' && 'sortOrder' in raw
      ? p
      : { ...p, sortOrder: index };
  }).filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  return {
    schema: 1,
    profiles,
    lastUsedId: typeof v.lastUsedId === 'string' ? v.lastUsedId : undefined,
    passwordDefaultsVersion: Number.isInteger(v.passwordDefaultsVersion) ? Number(v.passwordDefaultsVersion) : 0,
    mediaPermissionDefaultsVersion: Number.isInteger(v.mediaPermissionDefaultsVersion) ? Number(v.mediaPermissionDefaultsVersion) : 0,
    securityDefaultsVersion: Number.isInteger(v.securityDefaultsVersion) ? Number(v.securityDefaultsVersion) : 0,
  };
}

export interface ProfileInput {
  name: string;
  kind: ProfileKind;
  patch?: Partial<Omit<Profile, 'id' | 'createdAt' | 'updatedAt' | 'kind'>>;
}

const EXPORT_CONTEXT = 'octosuite-profile-export-v1';
/** Encrypted whole-suite backup (all profiles in one file) - see exportBundle. */
const BUNDLE_CONTEXT = 'octosuite-suite-backup-v1';
const VAULT_CONTEXT = 'octosuite-profile-vault-v1';

/** Marker file left by scripts\\restore-profile.bat when the profile entry is missing. */
export const RESTORED_ENTRY_FILE = 'restored-entry.json';

export class ProfileManager {
  readonly store: VersionedStore<ProfilesDoc>;

  constructor(
    private readonly layout: DataLayout,
    private readonly secrets?: SecretStoreApi,
    private readonly kdf: KdfParams = DEFAULT_KDF,
  ) {
    this.store = new VersionedStore<ProfilesDoc>(path.join(layout.config, 'profiles.json'), {
      backupDir: path.join(layout.backups, 'config'),
      defaults: () => ({ schema: 1, profiles: [], passwordDefaultsVersion: 1, mediaPermissionDefaultsVersion: 1, securityDefaultsVersion: 1 }),
      validate: validateDoc,
      maxBackups: 30,
    });
    // Existing installations stored `false` because saving was previously
    // opt-in. Promote regular profiles exactly once; after this marker is set,
    // a user's later opt-out is preserved.
    const doc = this.store.load();
    if ((doc.passwordDefaultsVersion ?? 0) < 1) {
      this.store.update((current) => {
        for (const profile of current.profiles) {
          if (defaultPasswordSaving(profile.kind)) profile.savePasswords = true;
        }
        current.passwordDefaultsVersion = 1;
      });
    }
    // Older installations silently denied every website media request at the
    // profile policy layer, before a familiar origin permission prompt could
    // appear. Promote regular profiles once; a later user opt-out is retained.
    if ((doc.mediaPermissionDefaultsVersion ?? 0) < 1) {
      this.store.update((current) => {
        for (const profile of current.profiles) {
          if (!defaultWebsiteMediaPrompts(profile.kind)) continue;
          profile.sandbox.camera = true;
          profile.sandbox.microphone = true;
        }
        current.mediaPermissionDefaultsVersion = 1;
      });
    }
    // Profiles created before the security baseline existed may have been
    // permissive by default. Upgrade only privacy-sensitive profile classes
    // and proxy transport; regular profiles keep their chosen level.
    if ((doc.securityDefaultsVersion ?? 0) < 1) {
      this.store.update((current) => {
        for (const profile of current.profiles) {
          if (profile.network.mode === 'proxy') profile.network.lockdown = true;
          if (profile.kind === 'private' || profile.kind === 'temporary') {
            profile.protection = { level: 'strict', overrides: { clearOnExit: true, blockThirdPartyCookies: true, stripTrackingParams: true } };
            profile.deleteOnClose = true;
            profile.keepHistory = false;
            profile.restoreSession = false;
            profile.sandbox.clipboard = 'write-only';
            profile.sandbox.externalDevices = false;
            profile.sandbox.shareDownloads = false;
          }
          if (profile.kind === 'tor') profile.protection = { level: 'tor' };
        }
        current.securityDefaultsVersion = 1;
      });
    }
    this.syncProfileDirectories();
  }

  private syncProfileDirectories(): void {
    for (const p of this.store.load().profiles) this.layout.setProfileDirectory(p.id, p.profileDirectory);
  }

  private bindProfile(p: Profile): Profile {
    this.layout.setProfileDirectory(p.id, p.profileDirectory);
    return p;
  }

  /** Create the default profile set on first run (Personal, Work, Private, Testing, Temporary, Tor). */
  ensureDefaults(names: Record<ProfileKind, string>, kinds: ProfileKind[] = ['personal', 'work', 'private', 'testing', 'temporary', 'tor']): void {
    const doc = this.store.load();
    if (doc.profiles.length > 0) return;
    const profiles = kinds.map((k) => defaultProfile(k, names[k]));
    this.store.save({ schema: 1, profiles, lastUsedId: profiles[0].id, passwordDefaultsVersion: 1, mediaPermissionDefaultsVersion: 1, securityDefaultsVersion: 1 });
    for (const p of profiles) this.ensureDirs(p.id);
  }

  private ensureDirs(id: string): void {
    ensureDir(this.layout.profileEngineDir(id));
    ensureDir(this.layout.profileDownloadsDir(id));
  }

  /** Active profiles only. Trashed and archived profiles are intentionally unavailable to launch. */
  list(): Profile[] {
    this.syncProfileDirectories();
    return this.store.load().profiles.filter((p) => !p.trashedAt && !p.archivedAt).map((p) => this.bindProfile(p));
  }

  /** Archived profiles remain visible in Settings and retain their browser data. */
  listArchived(): Profile[] {
    this.syncProfileDirectories();
    return this.store.load().profiles.filter((p) => !p.trashedAt && !!p.archivedAt).map((p) => this.bindProfile(p));
  }

  /** Local Trash contents; profile settings and browser data are retained. */
  listTrash(): Profile[] {
    this.syncProfileDirectories();
    return this.store.load().profiles.filter((p) => !!p.trashedAt).map((p) => this.bindProfile(p));
  }

  get(id: string): Profile {
    const p = this.list().find((x) => x.id === id);
    if (!p) throw new Error(`Profile not found: ${id}`);
    return p;
  }

  private getAny(id: string): Profile {
    this.syncProfileDirectories();
    const p = this.store.load().profiles.find((x) => x.id === id);
    if (!p) throw new Error(`Profile not found: ${id}`);
    return this.bindProfile(p);
  }

  lastUsed(): Profile | undefined {
    const doc = this.store.load();
    return doc.profiles.find((p) => p.id === doc.lastUsedId && !p.trashedAt && !p.archivedAt) ?? doc.profiles.find((p) => !p.trashedAt && !p.archivedAt);
  }

  setLastUsed(id: string): void {
    this.get(id);
    this.store.update((d) => { d.lastUsedId = id; });
  }

  create(input: ProfileInput): Profile {
    const base = defaultProfile(input.kind, input.name);
    const patch = input.patch ?? {};
    const legacyShell = !('browserShell' in patch) && 'baseChromeLook' in patch
      ? (patch.baseChromeLook === true ? 'chrome' : 'octo')
      : undefined;
    const current = this.store.load().profiles;
    const requestedOrder = Number.isSafeInteger(patch.sortOrder) && Number(patch.sortOrder) >= 0 ? Number(patch.sortOrder) : current.length;
    const p = sanitizeProfile({ ...base, ...patch, sortOrder: requestedOrder, ...(legacyShell ? { browserShell: legacyShell } : {}), id: base.id, kind: input.kind, name: input.name });
    this.store.update((d) => { d.profiles.push(p); });
    this.bindProfile(p);
    this.ensureDirs(p.id);
    return p;
  }

  /** Reorder an arbitrary visible subset while keeping hidden/filter-excluded profiles stable. */
  reorder(orderedIds: string[]): Profile[] {
    const ids = [...new Set(orderedIds.map(String))];
    const current = this.list();
    const currentById = new Map(current.map((p) => [p.id, p]));
    if (ids.some((id) => !currentById.has(id))) throw new Error('Cannot reorder an unknown profile');
    const selected = ids.map((id) => currentById.get(id)!);
    const selectedSet = new Set(ids);
    const base = [...current].sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
    const first = base.findIndex((p) => selectedSet.has(p.id));
    if (first < 0) return current;
    const merged = [...base];
    for (let i = merged.length - 1; i >= 0; i--) if (selectedSet.has(merged[i].id)) merged.splice(i, 1);
    merged.splice(first, 0, ...selected);
    const byId = new Map(merged.map((p, index) => [p.id, index]));
    this.store.update((d) => {
      for (const p of d.profiles) {
        const next = byId.get(p.id);
        if (next !== undefined) p.sortOrder = next;
      }
    });
    return this.list();
  }

  update(id: string, patch: Partial<Omit<Profile, 'id' | 'createdAt' | 'kind'>>): Profile {
    let updated: Profile | undefined;
    this.store.update((d) => {
      const i = d.profiles.findIndex((p) => p.id === id);
      if (i < 0) throw new Error(`Profile not found: ${id}`);
      const cur = d.profiles[i];
      const legacyShell = !('browserShell' in patch) && 'baseChromeLook' in patch
        ? (patch.baseChromeLook === true ? 'chrome' : 'octo')
        : undefined;
      updated = sanitizeProfile({
        ...cur,
        ...patch,
        ...(legacyShell ? { browserShell: legacyShell } : {}),
        id: cur.id,
        kind: cur.kind,
        createdAt: cur.createdAt,
        updatedAt: new Date().toISOString(),
        network: { ...cur.network, ...(patch.network ?? {}) },
        dns: { ...cur.dns, ...(patch.dns ?? {}) },
        sandbox: { ...cur.sandbox, ...(patch.sandbox ?? {}) },
        audio: { ...cur.audio, ...(patch.audio ?? {}) },
        mobile: { ...cur.mobile, ...(patch.mobile ?? {}) },
        protection: patch.protection ?? cur.protection,
        fingerprint: patch.fingerprint ?? cur.fingerprint,
        stats: { ...cur.stats, ...(patch.stats ?? {}) },
      });
      d.profiles[i] = updated;
    });
    this.bindProfile(updated!);
    return updated!;
  }

  /** Duplicate settings (and optionally cookies/storage) into a new profile. */
  duplicate(id: string, newName: string, includeData = false): Profile {
    const src = this.get(id);
    if (includeData && src.encrypted && fs.existsSync(this.layout.profileVaultFile(id))) {
      throw new Error('Unlock the encrypted profile before duplicating its data');
    }
    const copy = this.create({
      name: newName,
      kind: src.kind,
      patch: {
        ...structuredClone(src), name: newName, network: { ...src.network, hasProxyCredentials: false },
        // A copy must not share the fingerprint (that would link both profiles): new seed, same OS.
        fingerprint: src.fingerprint.enabled
          ? { ...generateFingerprint({ engineMajor: engineVersion().major, engineFullVersion: engineVersion().full, os: src.fingerprint.os }), timezone: src.fingerprint.timezone, language: src.fingerprint.language, geolocation: src.fingerprint.geolocation, webrtc: src.fingerprint.webrtc }
          : src.fingerprint,
        stats: { launches: 0, lastLaunchAt: '', worktimeSec: 0 },
      },
    });
    if (includeData) {
      copyDir(this.layout.profileEngineDir(id), this.layout.profileEngineDir(copy.id), isCachePath);
    }
    return copy;
  }

  /** Move a profile into the local Trash without touching its browser data or secrets. */
  trash(id: string): void {
    this.get(id);
    this.store.update((d) => {
      const p = d.profiles.find((x) => x.id === id);
      if (!p) throw new Error(`Profile not found: ${id}`);
      p.trashedAt = new Date().toISOString();
      delete p.archivedAt;
      p.updatedAt = p.trashedAt;
      if (d.lastUsedId === id) d.lastUsedId = d.profiles.find((x) => !x.trashedAt && !x.archivedAt)?.id;
    });
  }

  /** Move a closed profile to the recoverable Archive without touching its data. */
  archive(id: string): void {
    this.get(id);
    this.store.update((d) => {
      const p = d.profiles.find((x) => x.id === id);
      if (!p) throw new Error(`Profile not found: ${id}`);
      p.archivedAt = new Date().toISOString();
      p.updatedAt = p.archivedAt;
      if (d.lastUsedId === id) d.lastUsedId = d.profiles.find((x) => !x.trashedAt && !x.archivedAt)?.id;
    });
  }

  /** Restore an archived profile to the normal Profiles list. */
  unarchive(id: string): Profile {
    this.getAny(id);
    let restored: Profile | undefined;
    this.store.update((d) => {
      const p = d.profiles.find((x) => x.id === id);
      if (!p) throw new Error(`Profile not found: ${id}`);
      delete p.archivedAt;
      p.updatedAt = new Date().toISOString();
      restored = p;
    });
    return this.bindProfile(restored!);
  }

  /** Restore a profile from the local Trash. */
  restore(id: string): Profile {
    this.getAny(id);
    let restored: Profile | undefined;
    this.store.update((d) => {
      const p = d.profiles.find((x) => x.id === id);
      if (!p || !p.trashedAt) throw new Error(`Profile is not in Trash: ${id}`);
      delete p.trashedAt;
      p.updatedAt = new Date().toISOString();
      restored = sanitizeProfile(p);
      d.profiles[d.profiles.indexOf(p)] = restored;
    });
    return restored!;
  }

  /** Permanently erase a profile, its files and its locally encrypted secrets. */
  remove(id: string): void {
    this.getAny(id);
    this.store.update((d) => {
      d.profiles = d.profiles.filter((p) => p.id !== id);
      if (d.lastUsedId === id) d.lastUsedId = d.profiles.find((p) => !p.trashedAt)?.id;
    });
    secureDeleteDir(this.layout.profileDir(id));
    this.secrets?.deletePrefix(`proxy:${id}`);
  }

  /** Permanently erase every profile currently in the local Trash. */
  emptyTrash(): number {
    const ids = this.listTrash().map((p) => p.id);
    for (const id of ids) this.remove(id);
    return ids.length;
  }

  /** Wipe cookies, cache, storage, history, session - keep settings and bookmarks (and vault password). */
  reset(id: string, opts: { keepBookmarks?: boolean } = { keepBookmarks: true }): void {
    this.get(id);
    secureDeleteDir(this.layout.profileEngineDir(id));
    fs.rmSync(this.layout.profileVaultFile(id), { force: true });
    for (const f of ['history', 'session'] as const) fs.rmSync(this.layout.profileDataFile(id, f), { force: true });
    if (!opts.keepBookmarks) fs.rmSync(this.layout.profileDataFile(id, 'bookmarks'), { force: true });
    this.ensureDirs(id);
  }

  /** Wipe engine data of temporary / delete-on-close profiles (called at start and on close). */
  /**
   * Re-add profile entries restored by scripts\restore-profile.bat.
   *
   * The script never edits profiles.json itself (the app is the only writer).
   * When it restores the data folder of a profile whose entry no longer exists,
   * it leaves the archived entry (no secrets - proxy passwords live in
   * secrets.bin) in profiles/<id>/restored-entry.json. Here that entry is
   * validated with the same sanitiser as profiles.json and added back.
   * Invalid or conflicting files are renamed to *.rejected and never trusted.
   *
   * @returns the adopted profiles (and ids whose entry was rejected)
   */
  adoptRestoredEntries(): { adopted: Profile[]; rejected: string[] } {
    const adopted: Profile[] = [];
    const rejected: string[] = [];
    let dirs: string[];
    try {
      dirs = fs.readdirSync(this.layout.profiles, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return { adopted, rejected }; // no profiles folder yet
    }
    const known = new Set(this.list().map((p) => p.id));
    for (const dir of dirs) {
      if (!/^[a-z0-9-]{3,64}$/.test(dir)) continue;
      const file = path.join(this.layout.profiles, dir, RESTORED_ENTRY_FILE);
      if (!fs.existsSync(file)) continue;
      try {
        const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
        if (raw.length > 256 * 1024) throw new Error('entry too large');
        const entry = sanitizeProfile(JSON.parse(raw));
        if (entry.id !== dir) throw new Error('entry id does not match its folder');
        if (!known.has(entry.id)) {
          // Keep the encryption flag consistent with what is actually on disk.
          const fixed: Profile = { ...entry, encrypted: fs.existsSync(this.vaultMetaFile(entry.id)), updatedAt: new Date().toISOString() };
          this.store.update((d) => { d.profiles.push(fixed); });
          known.add(fixed.id);
          this.ensureDirs(fixed.id);
          adopted.push(fixed);
        }
        fs.rmSync(file, { force: true }); // entry exists now (or already existed)
      } catch {
        rejected.push(dir);
        try { fs.renameSync(file, `${file}.rejected`); } catch { /* leave it; it is ignored next time only if renamed */ }
      }
    }
    return { adopted, rejected };
  }

  cleanupEphemeral(id?: string): string[] {
    const cleaned: string[] = [];
    for (const p of this.list()) {
      if (id && p.id !== id) continue;
      if (p.deleteOnClose || p.kind === 'temporary') {
        secureDeleteDir(this.layout.profileEngineDir(p.id));
        fs.rmSync(this.layout.profileDataFile(p.id, 'history'), { force: true });
        fs.rmSync(this.layout.profileDataFile(p.id, 'session'), { force: true });
        this.ensureDirs(p.id);
        cleaned.push(p.id);
      }
    }
    return cleaned;
  }

  // ---------------------------------------------------------------- vault --
  //
  // Encrypted profiles ("vault"): while the profile is CLOSED its engine data
  // (cookies, localStorage, IndexedDB... - caches are discarded) exists only as
  // profiles/<id>/engine.vault, encrypted with AES-256-GCM under a key derived
  // with Argon2id from the profile's 12-word passphrase (BIP-39, 128 bits of
  // entropy - see mnemonic.ts). vault.json holds only the salt, KDF parameters
  // and an encrypted check value (to reject a wrong phrase before touching
  // data); the phrase itself is never stored anywhere. While the profile is
  // OPEN the derived key is kept in memory (Buffer, wiped on seal) so auto-lock
  // can re-seal without asking for the phrase again.
  //
  // The same phrase is the recovery code: with the 12 words and a copy of
  // profiles/<id> (or an export) the profile can be opened on another computer.

  private vaultMetaFile(id: string): string {
    return path.join(this.layout.profileDir(id), 'vault.json');
  }

  hasVault(id: string): boolean {
    return fs.existsSync(this.vaultMetaFile(id));
  }

  /** true = sealed (engine data is only in encrypted form on disk). */
  isVaultLocked(id: string): boolean {
    return fs.existsSync(this.layout.profileVaultFile(id));
  }

  /**
   * Enable encryption for a profile with an existing 12-word passphrase.
   * Returns the derived key (caller holds & wipes it).
   */
  async initVault(id: string, passphrase: string): Promise<Buffer> {
    this.get(id);
    const phrase = normalizeMnemonic(passphrase);
    if (!isValidMnemonic(phrase)) throw new Error('A valid 12-word passphrase is required');
    const salt = crypto.randomBytes(16);
    const key = await deriveKey(phrase, salt, this.kdf);
    const check = encryptWithKey(key, Buffer.from('octo-vault-check', 'utf8'), `${VAULT_CONTEXT}:check:${id}`);
    atomicWriteFile(this.vaultMetaFile(id), JSON.stringify({
      schema: 1, salt: salt.toString('base64'), kdf: this.kdf, check: check.toString('base64'),
    }));
    this.update(id, { encrypted: true });
    return key;
  }

  /**
   * Turn on encryption with a freshly generated passphrase. The phrase is
   * returned ONCE - it is the only way to open the profile later, and nothing
   * in OctoSuite keeps a copy of it.
   */
  async createVault(id: string): Promise<{ passphrase: string; key: Buffer }> {
    const passphrase = generateMnemonic();
    const key = await this.initVault(id, passphrase);
    return { passphrase, key };
  }

  /** Derive the vault key from the 12-word phrase and verify it. Throws DecryptionError on a wrong phrase. */
  async deriveVaultKey(id: string, passphrase: string): Promise<Buffer> {
    const meta = JSON.parse(fs.readFileSync(this.vaultMetaFile(id), 'utf8')) as { schema: 1; salt: string; kdf: KdfParams; check: string };
    const key = await deriveKey(normalizeMnemonic(passphrase), Buffer.from(meta.salt, 'base64'), meta.kdf);
    try {
      decryptWithKey(key, Buffer.from(meta.check, 'base64'), `${VAULT_CONTEXT}:check:${id}`);
    } catch (err) {
      wipe(key);
      throw err;
    }
    return key;
  }

  /** Decrypt the sealed engine data (if sealed). The key must come from deriveVaultKey/initVault. */
  openVault(id: string, key: Buffer): void {
    const vault = this.layout.profileVaultFile(id);
    if (!fs.existsSync(vault)) return; // not sealed (new vault or recovered after crash)
    const plain = decryptWithKey(key, fs.readFileSync(vault), `${VAULT_CONTEXT}:${id}`);
    try {
      const engine = this.layout.profileEngineDir(id);
      secureDeleteDir(engine);
      unpackTo(plain, engine);
    } finally {
      wipe(plain);
    }
    fs.rmSync(vault, { force: true });
  }

  /**
   * Seal: pack engine data (without caches), encrypt, then securely delete the
   * plain folder. All windows of the profile MUST be closed first.
   */
  sealVault(id: string, key: Buffer): void {
    if (!this.hasVault(id)) throw new Error('Profile has no vault');
    const engine = this.layout.profileEngineDir(id);
    const plain = packDir(engine);
    try {
      atomicWriteFile(this.layout.profileVaultFile(id), encryptWithKey(key, plain, `${VAULT_CONTEXT}:${id}`));
    } finally {
      wipe(plain);
    }
    secureDeleteDir(engine);
    ensureDir(engine);
  }

  /** Encrypted profile whose engine data is currently in plain form (e.g. after a crash). */
  needsResealing(id: string): boolean {
    const p = this.get(id);
    if (!p.encrypted || !this.hasVault(id) || this.isVaultLocked(id)) return false;
    const engine = this.layout.profileEngineDir(id);
    return fs.existsSync(engine) && fs.readdirSync(engine).length > 0;
  }

  /** Disable encryption: requires the vault to be open (plain data present). */
  removeVault(id: string): void {
    if (this.isVaultLocked(id)) throw new Error('Unlock the profile first');
    fs.rmSync(this.vaultMetaFile(id), { force: true });
    this.update(id, { encrypted: false });
  }

  // --------------------------------------------------------- export/import --

  /**
   * Export a profile. Exports are ALWAYS encrypted with the same kind of
   * 12-word passphrase used by profile vaults; there is no plain-text export.
   * Secrets (proxy credentials) are never exported.
   */
  async exportEncrypted(id: string, passphrase: string, outFile: string, includeData = true): Promise<void> {
    if (!isValidMnemonic(passphrase)) throw new Error('A valid 12-word passphrase is required');
    const p = this.get(id);
    if (includeData && this.isVaultLocked(id)) throw new Error('Unlock the profile before exporting its data');
    const staging = path.join(this.layout.temp, `export-${crypto.randomBytes(6).toString('hex')}`);
    ensureDir(staging);
    try {
      const meta = { ...p, network: { ...p.network, hasProxyCredentials: false } };
      fs.writeFileSync(path.join(staging, 'profile.json'), JSON.stringify({ format: 'octobrowser-profile', version: 1, profile: meta }));
      if (includeData) copyDir(this.layout.profileEngineDir(id), path.join(staging, 'engine'), isCachePath);
      const plain = packDir(staging, () => false);
      try {
        const blob = await encryptWithPassword(normalizeMnemonic(passphrase), plain, { kdf: this.kdf, context: EXPORT_CONTEXT });
        atomicWriteFile(outFile, blob);
      } finally {
        wipe(plain);
      }
    } finally {
      secureDeleteDir(staging);
    }
  }

  /**
   * Export SEVERAL profiles into one encrypted file - the file that moves a
   * whole Octo.su installation to another computer.
   *
   * Same rules as a single-profile export, deliberately: one file, one 12-word
   * passphrase, AES-256-GCM, and nothing is written unencrypted. Proxy
   * credentials stay on the source machine (they live in SecretStore, not in
   * the profile), everything else that a profile owns travels with it.
   */
  async exportBundle(ids: string[], passphrase: string, outFile: string, includeData = true): Promise<{ profiles: number; bytes: number }> {
    if (!isValidMnemonic(passphrase)) throw new Error('A valid 12-word passphrase is required');
    const wanted = [...new Set(ids.map((id) => String(id)))];
    if (!wanted.length) throw new Error('Choose at least one profile to back up');
    const profiles = wanted.map((id) => this.get(id));
    if (includeData) {
      const locked = profiles.filter((p) => this.isVaultLocked(p.id));
      if (locked.length) throw new Error('Unlock the profile before exporting its data');
    }
    const staging = path.join(this.layout.temp, `bundle-${crypto.randomBytes(6).toString('hex')}`);
    ensureDir(staging);
    try {
      const manifestProfiles: Array<{ id: string; name: string; kind: ProfileKind; encrypted: boolean; hasData: boolean }> = [];
      for (const [index, profile] of profiles.entries()) {
        // The folder name is positional, never taken from the profile name, so
        // an odd name can not produce a strange path inside the archive.
        const dir = path.join(staging, 'profiles', String(index).padStart(3, '0'));
        ensureDir(dir);
        const meta = { ...profile, network: { ...profile.network, hasProxyCredentials: false } };
        fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ format: 'octobrowser-profile', version: 1, profile: meta }));
        const hasData = includeData;
        if (includeData) copyDir(this.layout.profileEngineDir(profile.id), path.join(dir, 'engine'), isCachePath);
        manifestProfiles.push({ id: profile.id, name: profile.name, kind: profile.kind, encrypted: profile.encrypted, hasData });
      }
      fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({
        format: 'octobrowser-backup',
        version: 1,
        createdAt: new Date().toISOString(),
        profiles: manifestProfiles,
      }));
      const plain = packDir(staging, () => false);
      try {
        const blob = await encryptWithPassword(normalizeMnemonic(passphrase), plain, { kdf: this.kdf, context: BUNDLE_CONTEXT });
        atomicWriteFile(outFile, blob);
        return { profiles: profiles.length, bytes: blob.length };
      } finally {
        wipe(plain);
      }
    } finally {
      secureDeleteDir(staging);
    }
  }

  /**
   * Read a bundle's manifest without importing anything, so the UI can show
   * what is inside before the user commits to it.
   */
  async inspectBundle(file: string, passphrase: string): Promise<{ profiles: Array<{ name: string; kind: ProfileKind; hasData: boolean }>; createdAt: string }> {
    const plain = await decryptWithPassword(normalizeMnemonic(passphrase), fs.readFileSync(file), BUNDLE_CONTEXT);
    const staging = path.join(this.layout.temp, `inspect-${crypto.randomBytes(6).toString('hex')}`);
    try {
      unpackTo(plain, staging);
      const manifest = JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'), 'utf8')) as { format: string; version: number; createdAt: string; profiles: Array<{ name: string; kind: ProfileKind; hasData: boolean }> };
      if (manifest.format !== 'octobrowser-backup' || manifest.version !== 1) throw new Error('Not an Octo.su backup file');
      return { profiles: manifest.profiles, createdAt: manifest.createdAt };
    } finally {
      wipe(plain);
      secureDeleteDir(staging);
    }
  }

  /**
   * Import a whole backup. Every profile becomes a NEW profile on this
   * computer: nothing existing is replaced, and the same file can be imported
   * twice without losing the first copy.
   */
  async importBundle(file: string, passphrase: string): Promise<Profile[]> {
    const plain = await decryptWithPassword(normalizeMnemonic(passphrase), fs.readFileSync(file), BUNDLE_CONTEXT);
    const staging = path.join(this.layout.temp, `bundle-in-${crypto.randomBytes(6).toString('hex')}`);
    try {
      unpackTo(plain, staging);
      const manifest = JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'), 'utf8')) as { format: string; version: number; profiles: Array<{ name: string; kind: ProfileKind }> };
      if (manifest.format !== 'octobrowser-backup' || manifest.version !== 1) throw new Error('Not an Octo.su backup file');
      const created: Profile[] = [];
      for (const [index, entry] of manifest.profiles.entries()) {
        const dir = path.join(staging, 'profiles', String(index).padStart(3, '0'));
        const doc = JSON.parse(fs.readFileSync(path.join(dir, 'profile.json'), 'utf8')) as { format: string; version: number; profile: Profile };
        if (doc.format !== 'octobrowser-profile' || doc.version !== 1) throw new Error('Backup entry is not an Octo.su profile');
        const src = sanitizeProfile(doc.profile);
        const profile = this.create({ name: entry.name || src.name, kind: entry.kind ?? src.kind, patch: { ...src, encrypted: false } });
        const engineSrc = path.join(dir, 'engine');
        if (fs.existsSync(engineSrc)) copyDir(engineSrc, this.layout.profileEngineDir(profile.id));
        created.push(profile);
      }
      if (!created.length) throw new Error('The backup contains no profiles');
      return created;
    } finally {
      wipe(plain);
      secureDeleteDir(staging);
    }
  }

  /**
   * Import an encrypted export as a NEW profile (new id, never overwrites).
   * This is also the "recover my profile on another computer" path: the export
   * plus its 12 words are everything that is needed.
   */
  async importEncrypted(file: string, passphrase: string): Promise<Profile> {
    const plain = await decryptWithPassword(normalizeMnemonic(passphrase), fs.readFileSync(file), EXPORT_CONTEXT);
    const staging = path.join(this.layout.temp, `import-${crypto.randomBytes(6).toString('hex')}`);
    try {
      unpackTo(plain, staging);
      const doc = JSON.parse(fs.readFileSync(path.join(staging, 'profile.json'), 'utf8')) as { format: string; version: number; profile: Profile };
      if (doc.format !== 'octobrowser-profile' || doc.version !== 1) throw new Error('Not an OctoBrowser profile export');
      const src = sanitizeProfile(doc.profile);
      const created = this.create({ name: `${src.name}`, kind: src.kind, patch: { ...src, encrypted: false } });
      const engineSrc = path.join(staging, 'engine');
      if (fs.existsSync(engineSrc)) copyDir(engineSrc, this.layout.profileEngineDir(created.id));
      return created;
    } finally {
      wipe(plain);
      secureDeleteDir(staging);
    }
  }
}

// ------------------------------------------------------ per-profile data --

export interface Bookmark { id: string; title: string; url: string; folder?: string; createdAt: string }
export interface HistoryEntry { url: string; title: string; visitedAt: string }
export interface SavedTab { url: string; title: string; pinned: boolean; group?: string }
export interface SavedSession { savedAt: string; tabs: SavedTab[]; activeIndex: number }

/**
 * Encrypted per-profile data (bookmarks, history, session). Uses the keyring
 * DEK, so the files are unreadable without the local key (see keyring.ts).
 */
export class ProfileData {
  readonly bookmarks: VersionedStore<Bookmark[]>;
  readonly history: VersionedStore<HistoryEntry[]>;
  readonly session: VersionedStore<SavedSession | null>;

  constructor(layout: DataLayout, id: string, keyProvider: () => Buffer) {
    const backupDir = path.join(layout.profileDir(id), 'backups');
    const mk = <T>(name: 'bookmarks' | 'history' | 'session', defaults: () => T, max: number, backupOnSave: boolean) =>
      new VersionedStore<T>(layout.profileDataFile(id, name), {
        backupDir, defaults, keyProvider, context: `octosuite-${name}:${id}`, maxBackups: max, backupOnSave,
      });
    this.bookmarks = mk<Bookmark[]>('bookmarks', () => [], 10, true);
    this.history = mk<HistoryEntry[]>('history', () => [], 2, false);
    this.session = mk<SavedSession | null>('session', () => null, 3, false);
  }

  addHistory(entry: HistoryEntry, max = 5000): void {
    this.history.update((h) => {
      h.unshift(entry);
      if (h.length > max) h.length = max;
    });
  }
}
