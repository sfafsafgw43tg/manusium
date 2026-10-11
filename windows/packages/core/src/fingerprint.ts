/**
 * packages/core/src/fingerprint.ts
 *
 * Per-profile browser fingerprint (antidetect profiles).
 *
 * Every profile gets ONE consistent, stored fingerprint: operating system,
 * user agent (+ matching User-Agent Client Hints), WebGL vendor/renderer,
 * CPU cores, memory, screen, timezone, languages, geolocation, media devices
 * and the noise modes for Canvas / WebGL / Audio / ClientRects / fonts / battery / speech.
 *
 * Rules that keep a generated fingerprint realistic:
 *   - the Chrome MAJOR version always equals the real engine version
 *     (a different version would contradict the JS/CSS features the page sees);
 *   - the GPU list is filtered by OS (no Apple M2 on Windows, no D3D11 on macOS);
 *   - CPU / memory values are drawn from what real devices of that OS report
 *     (navigator.deviceMemory is capped at 8 by Chrome itself);
 *   - noise is SEEDED per profile: the same profile returns the same Canvas /
 *     WebGL / Audio hash on every visit, different profiles differ.
 *
 * Pure module (no Electron) - fully unit-tested.
 */
import * as crypto from 'node:crypto';
import { isIP } from 'node:net';
import { chromiumUserAgent } from './user-agent';
import { BRAND_VERSION_MAP, browserIdentityFor, chromiumIdentityUserAgent, identityMappingStale, type BrowserIdentity, isFirefoxIdentity } from './browser-identity';
export { chromiumUserAgent } from './user-agent';

export const FP_OSES = ['windows11', 'windows10', 'macos', 'linux'] as const;
export const FINGERPRINT_SCHEMA_VERSION = 1 as const;
export type FingerprintOs = (typeof FP_OSES)[number];

export type WebRtcMode = 'off' | 'real' | 'disable-udp' | 'altered' | 'manual' | 'substitute' | 'forward' | 'disable';
export type NoiseMode = 'off' | 'real' | 'noise';
export type AutoManual = 'auto' | 'manual' | 'ip-match' | 'lang-match';
export type RealManual = 'real' | 'manual' | 'custom';
export type TriState = 'default' | 'enable' | 'close';

export const CHROME_VERSIONS = [
  '155', '154', '153', '152', '151', '150', '149', '148', '147', '146', '145', '144', '143', '142', '141', '140',
  '139', '138', '137', '136', '135', '134', '133', '132', '131', '130', '129', '128', '127', '126', '125', '124',
  '123', '122', '121', '120', '119', '118', '117', '116', '115',
] as const;

export class FingerprintValidationError extends Error {
  constructor(readonly field: string, message: string) { super(`${field}: ${message}`); this.name = 'FingerprintValidationError'; }
}

export interface FingerprintConfig {
  /** Version of the validated persisted fingerprint shape. */
  schemaVersion?: typeof FINGERPRINT_SCHEMA_VERSION;
  /** User-visible one-time migration notices, never runtime controls. */
  migrationWarnings?: string[];
  /** Master switch. Off = the engine reports its real values (plain Chromium). */
  enabled: boolean;
  /** Web-visible browser engine identity; shell styling is unrelated. */
  browserIdentity?: BrowserIdentity;
  os: FingerprintOs;
  userAgent: string;
  /** Full Chrome version reported in UA Client Hints (major == engine major). */
  uaFullVersion: string;
  /** UA-CH platformVersion (e.g. Windows 11 => "15.0.0"). */
  platformVersion: string;
  /** Human-readable release selected in the profile editor (for example, Windows 11 24H2). */
  osVersion?: string;
  /** Selected browser major version (e.g. "140", "150"). */
  browserVersion?: string;
  webrtc: { mode: WebRtcMode; publicIp: string };
  canvas: NoiseMode;
  webgl: NoiseMode;
  webglInfo: { mode: RealManual; vendor: string; renderer: string };
  webgpu: 'off' | 'real' | 'webgl-based' | 'disable';
  clientRects: 'real' | 'noise';
  timezone: { mode: 'auto' | 'manual' | 'real' | 'ip-match'; value: string };
  language: { mode: 'auto' | 'manual' | 'real' | 'ip-match' | 'lang-match'; value: string };
  geolocation: { mode: 'auto' | 'manual' | 'block' | 'ask' | 'allow' | 'disable' | 'ip-match'; latitude: number; longitude: number; accuracy: number };
  cpu: { mode: RealManual; cores: number };
  memory: { mode: RealManual; gb: number };
  screen: { mode: 'real' | 'manual' | 'custom' | 'random'; width: number; height: number };
  windowSize?: { mode: 'default' | 'custom'; width: number; height: number };
  fonts: 'real' | 'noise' | 'custom';
  fontList?: string[];
  audio: 'real' | 'noise';
  speechVoices?: 'real' | 'noise';
  mediaDevices: { mode: RealManual | 'noise'; audioInputs: number; audioOutputs: number; videoInputs: number };
  ports: { mode: 'real' | 'protect' | 'enable' | 'close'; list: string };
  doNotTrack: boolean | 'default' | 'enable' | 'close';
  battery?: 'real' | 'noise';
  deviceName?: { mode: 'real' | 'custom'; value: string };
  macAddress?: { mode: 'real' | 'custom'; value: string };
  hardwareAcceleration?: 'default' | 'enable' | 'close';
  videoSpoofing?: 'enable' | 'disable';
  /** Hex seed for all deterministic noise of this profile. */
  seed: string;
  /** 'persistent' = stays same every run; 'per-run' = generates new seed every launch. */
  seedMode?: 'persistent' | 'per-run';
}

export interface ConfigPreview {
  sessionId: string;
  canvasHash: string;
  webglHash: string;
  audioHash: string;
  clientRectsHash: string;
  webgpuStatus: string;
  fontSample: string;
}

/**
 * Compute the deterministic local fingerprint signal hashes from seed and noise settings.
 */
export function computeConfigPreview(fp: {
  seed?: string;
  canvas?: NoiseMode;
  webgl?: NoiseMode;
  webglInfo?: { vendor?: string; renderer?: string; mode?: string };
  audio?: 'real' | 'noise';
  speechVoices?: 'real' | 'noise';
  clientRects?: 'real' | 'noise';
  webgpu?: 'off' | 'real' | 'webgl-based' | 'disable';
  fonts?: 'real' | 'noise' | 'custom';
  fontList?: string[];
  battery?: 'real' | 'noise';
  deviceName?: { mode?: string; value?: string };
  macAddress?: { mode?: string; value?: string };
}): ConfigPreview {
  const seed = fp.seed || '0000000000000000';
  const sha = (input: string) => crypto.createHash('sha256').update(input).digest('hex');

  const sessionId = `sig-${sha(`${seed}:session`).slice(0, 16)}`;

  // This function never touches a browser context. These are requested
  // configuration values, not measurements or proof of application.
  const canvasHash = 'not measured';
  const webglHash = 'not measured';
  const audioHash = 'not measured';
  const clientRectsHash = 'not measured';
  const webgpuStatus = 'not measured';
  const count = fp.fontList?.length ?? 0;
  const fontSample = count ? `${count} configured fonts; runtime not measured` : 'runtime not measured';

  return {
    sessionId,
    canvasHash,
    webglHash,
    audioHash,
    clientRectsHash,
    webgpuStatus,
    fontSample,
  };
}

// ------------------------------------------------------------------ font presets --

export const WINDOWS_FONTS = [
  'Arial', 'Arial Black', 'Calibri', 'Cambria', 'Cambria Math', 'Candara', 'Century Gothic',
  'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Ebrima', 'Franklin Gothic Medium',
  'Gabriola', 'Gadugi', 'Georgia', 'Impact', 'Ink Free', 'Javanese Text', 'Leelawadee UI',
  'Lucida Console', 'Lucida Sans Unicode', 'Malgun Gothic', 'Marlett', 'Microsoft Himalaya',
  'Microsoft JhengHei', 'Microsoft New Tai Lue', 'Microsoft PhagsPa', 'Microsoft Sans Serif',
  'Microsoft Tai Le', 'Microsoft YaHei', 'Microsoft Yi Baiti', 'MingLiU-ExtB', 'Mongolian Baiti',
  'MS Gothic', 'MS PGothic', 'MS UI Gothic', 'MV Boli', 'Myanmar Text', 'Nirmala UI',
  'Palatino Linotype', 'Segoe Print', 'Segoe Script', 'Segoe UI', 'Segoe UI Emoji',
  'Segoe UI Historic', 'Segoe UI Symbol', 'SimSun', 'Sitka Text', 'Sylfaen', 'Symbol',
  'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Webdings', 'Wingdings', 'Yu Gothic',
];

export const MACOS_FONTS = [
  'American Typewriter', 'Andale Mono', 'Apple Chancery', 'Apple Color Emoji', 'Apple SD Gothic Neo',
  'Arial', 'Arial Black', 'Arial Narrow', 'Arial Rounded MT Bold', 'Athelas', 'Avenir', 'Avenir Next',
  'Baskerville', 'Big Caslon', 'Bodoni 72', 'Bradley Hand', 'Brush Script MT', 'Chalkboard',
  'Chalkduster', 'Charter', 'Cochin', 'Comic Sans MS', 'Copperplate', 'Courier', 'Courier New',
  'Didot', 'DIN Alternate', 'DIN Condensed', 'Futura', 'Geneva', 'Georgia', 'Gill Sans',
  'Helvetica', 'Helvetica Neue', 'Herculanum', 'Hoefler Text', 'Impact', 'Iowan Old Style',
  'Lucida Grande', 'Luminari', 'Marion', 'Marker Felt', 'Menlo', 'Monaco', 'Noteworthy',
  'Optima', 'Palatino', 'Papyrus', 'Phosphate', 'PingFang SC', 'Plantagenet Cherokee',
  'PT Sans', 'PT Serif', 'San Francisco', 'Savoye LET', 'Seravek', 'SignPainter', 'Skia',
  'Snell Roundhand', 'Tahoma', 'Times', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Zapfino',
];

export const LINUX_FONTS = [
  'Bitstream Vera Sans', 'Cantarell', 'DejaVu Sans', 'DejaVu Sans Mono', 'DejaVu Serif',
  'Droid Sans', 'FreeMono', 'FreeSans', 'FreeSerif', 'Liberation Mono', 'Liberation Sans',
  'Liberation Serif', 'Nimbus Roman No9 L', 'Nimbus Sans L', 'Noto Color Emoji', 'Noto Mono',
  'Noto Sans', 'Noto Serif', 'Open Sans', 'Roboto', 'Ubuntu', 'Ubuntu Condensed', 'Ubuntu Mono',
];

export const ANDROID_FONTS = [
  'Roboto', 'Noto Sans', 'Noto Serif', 'Droid Sans', 'Droid Serif', 'Roboto Mono', 'Noto Color Emoji',
];

export const IOS_FONTS = [
  'San Francisco', 'Helvetica', 'Helvetica Neue', 'Arial', 'Courier New', 'Georgia', 'Times New Roman',
  'Trebuchet MS', 'Verdana', 'Apple Color Emoji', 'Avenir', 'Avenir Next', 'Gill Sans', 'Optima', 'Palatino',
];

export function fontPresets(os: FingerprintOs): string[] {
  switch (os) {
    case 'macos': return [...MACOS_FONTS];
    case 'linux': return [...LINUX_FONTS];
    default: return [...WINDOWS_FONTS];
  }
}

export function randomizeFonts(os: FingerprintOs, seed: string): string[] {
  const all = fontPresets(os);
  const rnd = prng(seed);
  // Pick ~75-90% of fonts deterministically
  return all.filter(() => rnd() > 0.18);
}

// ------------------------------------------------------------------ identifiers --

export function generateMacAddress(seed?: string): string {
  const rnd = seed ? prng(seed) : () => Math.random();
  const hex = () => Math.floor(rnd() * 256).toString(16).padStart(2, '0').toUpperCase();
  const firstByte = ((Math.floor(rnd() * 256) & 0xfe) | 0x02).toString(16).padStart(2, '0').toUpperCase();
  return `${firstByte}:${hex()}:${hex()}:${hex()}:${hex()}:${hex()}`;
}

export function generateDeviceName(os: FingerprintOs, seed?: string): string {
  const rnd = seed ? prng(seed) : () => Math.random();
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let randStr = '';
  for (let i = 0; i < 7; i++) randStr += chars[Math.floor(rnd() * chars.length)];
  if (os === 'macos') return `MacBook-Pro-${randStr.slice(0, 4)}`;
  if (os === 'linux') return `desktop-${randStr.toLowerCase().slice(0, 6)}`;
  return `DESKTOP-${randStr}`;
}

// ------------------------------------------------------------------ data --

export interface GpuPreset { vendor: string; renderer: string; weight: number; tier: 'low' | 'mid' | 'high' }

const D3D = (brand: string, name: string, id: string) =>
  `ANGLE (${brand}, ${name} (0x0000${id}) Direct3D11 vs_5_0 ps_5_0, D3D11)`;

const WIN_GPUS: GpuPreset[] = [
  { vendor: 'Google Inc. (Intel)', renderer: D3D('Intel', 'Intel(R) UHD Graphics 620', '5917'), weight: 8, tier: 'low' },
  { vendor: 'Google Inc. (Intel)', renderer: D3D('Intel', 'Intel(R) UHD Graphics 630', '3E92'), weight: 8, tier: 'low' },
  { vendor: 'Google Inc. (Intel)', renderer: D3D('Intel', 'Intel(R) Iris(R) Xe Graphics', '9A49'), weight: 10, tier: 'mid' },
  { vendor: 'Google Inc. (Intel)', renderer: D3D('Intel', 'Intel(R) UHD Graphics 770', '4680'), weight: 4, tier: 'mid' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: D3D('NVIDIA', 'NVIDIA GeForce GTX 1050 Ti', '1C82'), weight: 5, tier: 'low' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: D3D('NVIDIA', 'NVIDIA GeForce GTX 1060 6GB', '1C03'), weight: 6, tier: 'mid' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: D3D('NVIDIA', 'NVIDIA GeForce GTX 1650', '1F82'), weight: 8, tier: 'mid' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: D3D('NVIDIA', 'NVIDIA GeForce GTX 1660 SUPER', '21C4'), weight: 6, tier: 'mid' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: D3D('NVIDIA', 'NVIDIA GeForce RTX 2060', '1F08'), weight: 5, tier: 'high' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: D3D('NVIDIA', 'NVIDIA GeForce RTX 3060', '2504'), weight: 8, tier: 'high' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: D3D('NVIDIA', 'NVIDIA GeForce RTX 3060 Ti', '2489'), weight: 4, tier: 'high' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: D3D('NVIDIA', 'NVIDIA GeForce RTX 3070', '2484'), weight: 4, tier: 'high' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: D3D('NVIDIA', 'NVIDIA GeForce RTX 4060', '2882'), weight: 5, tier: 'high' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: D3D('NVIDIA', 'NVIDIA GeForce RTX 4070', '2786'), weight: 3, tier: 'high' },
  { vendor: 'Google Inc. (AMD)', renderer: D3D('AMD', 'AMD Radeon(TM) Graphics', '1638'), weight: 5, tier: 'low' },
  { vendor: 'Google Inc. (AMD)', renderer: D3D('AMD', 'AMD Radeon RX 580 Series', '67DF'), weight: 4, tier: 'mid' },
  { vendor: 'Google Inc. (AMD)', renderer: D3D('AMD', 'AMD Radeon RX 6600', '73FF'), weight: 3, tier: 'high' },
  { vendor: 'Google Inc. (AMD)', renderer: D3D('AMD', 'AMD Radeon RX 6700 XT', '73DF'), weight: 2, tier: 'high' },
];

const MAC_GPUS: GpuPreset[] = [
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)', weight: 10, tier: 'mid' },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)', weight: 5, tier: 'high' },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)', weight: 8, tier: 'mid' },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)', weight: 3, tier: 'high' },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)', weight: 6, tier: 'mid' },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)', weight: 3, tier: 'high' },
  { vendor: 'Google Inc. (Intel Inc.)', renderer: 'ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics OpenGL Engine, OpenGL 4.1)', weight: 3, tier: 'low' },
];

const LINUX_GPUS: GpuPreset[] = [
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)', weight: 6, tier: 'low' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) Xe Graphics (TGL GT2), OpenGL 4.6)', weight: 5, tier: 'mid' },
  { vendor: 'Google Inc. (NVIDIA Corporation)', renderer: 'ANGLE (NVIDIA Corporation, NVIDIA GeForce GTX 1660 SUPER/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 535.183.01)', weight: 4, tier: 'mid' },
  { vendor: 'Google Inc. (NVIDIA Corporation)', renderer: 'ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3060/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 550.107.02)', weight: 4, tier: 'high' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 (radeonsi, navy_flounder, LLVM 15.0.7, DRM 3.54, 6.5.0-35-generic), OpenGL 4.6)', weight: 3, tier: 'high' },
];

export function gpuPresets(os: FingerprintOs): GpuPreset[] {
  return os === 'macos' ? MAC_GPUS : os === 'linux' ? LINUX_GPUS : WIN_GPUS;
}

/** Common screen resolutions per OS (CSS pixels), weighted by real-world share. */
const SCREENS: Record<'win' | 'mac' | 'linux', Array<[number, number, number]>> = {
  win: [[1920, 1080, 30], [1366, 768, 10], [1536, 864, 12], [2560, 1440, 9], [1440, 900, 5], [1600, 900, 5], [1280, 720, 3], [1280, 1024, 2], [1680, 1050, 3], [1920, 1200, 3]],
  mac: [[1440, 900, 12], [1512, 982, 10], [1728, 1117, 6], [1680, 1050, 5], [1470, 956, 8], [2560, 1440, 4], [1920, 1080, 4]],
  linux: [[1920, 1080, 20], [1366, 768, 6], [2560, 1440, 5], [1600, 900, 3], [1920, 1200, 3]],
};

export function screenPresets(os: FingerprintOs): Array<[number, number]> {
  return SCREENS[osFamily(os)].map(([w, h]) => [w, h]);
}

export const CPU_CHOICES = [2, 4, 6, 8, 10, 12, 16, 20, 24, 32] as const;
/** navigator.deviceMemory: Chrome reports at most 8 (bucketed 0.25 ... 8). */
export const MEMORY_CHOICES = [1, 2, 4, 8] as const;

export const DEFAULT_PROTECTED_PORTS = '3389,5900,5800,7070,6568,5938,63333,5901,5902,5903,5950,5931,5939,6039,5944,6040,5279,2112';

/** Country (ISO 3166-1 alpha-2) -> primary UI language tag. Used for "auto" language from the proxy IP. */
export const COUNTRY_LANG: Record<string, string> = {
  PL: 'pl-PL', US: 'en-US', GB: 'en-GB', IE: 'en-IE', CA: 'en-CA', AU: 'en-AU', NZ: 'en-NZ', DE: 'de-DE', AT: 'de-AT', CH: 'de-CH',
  FR: 'fr-FR', BE: 'fr-BE', ES: 'es-ES', MX: 'es-MX', AR: 'es-AR', CO: 'es-CO', CL: 'es-CL', IT: 'it-IT', PT: 'pt-PT', BR: 'pt-BR',
  NL: 'nl-NL', SE: 'sv-SE', NO: 'nb-NO', DK: 'da-DK', FI: 'fi-FI', CZ: 'cs-CZ', SK: 'sk-SK', HU: 'hu-HU', RO: 'ro-RO', BG: 'bg-BG',
  GR: 'el-GR', TR: 'tr-TR', UA: 'uk-UA', RU: 'ru-RU', BY: 'ru-RU', KZ: 'ru-RU', LT: 'lt-LT', LV: 'lv-LV', EE: 'et-EE', HR: 'hr-HR',
  RS: 'sr-RS', SI: 'sl-SI', JP: 'ja-JP', KR: 'ko-KR', CN: 'zh-CN', TW: 'zh-TW', HK: 'zh-HK', IN: 'en-IN', ID: 'id-ID', TH: 'th-TH',
  VN: 'vi-VN', PH: 'en-PH', MY: 'ms-MY', SG: 'en-SG', IL: 'he-IL', SA: 'ar-SA', AE: 'ar-AE', EG: 'ar-EG', ZA: 'en-ZA', NG: 'en-NG',
};

/** Languages offered in the UI (manual language). */
export const LANGUAGE_CHOICES: string[] = [...new Set(['en-US', 'en-GB', ...Object.values(COUNTRY_LANG)])];

/** Accept-Language / navigator.languages for a primary tag, the way Chrome builds it. */
export function languageList(primary: string): string[] {
  const tag = /^[a-z]{2,3}(-[A-Z]{2})?$/.test(primary) ? primary : 'en-US';
  const base = tag.split('-')[0];
  const out = [tag];
  if (base !== tag) out.push(base);
  if (base !== 'en') out.push('en-US', 'en');
  return [...new Set(out)];
}

export function acceptLanguageHeader(primary: string): string {
  return languageList(primary).map((l, i) => (i === 0 ? l : `${l};q=${Math.max(0.1, 1 - i * 0.1).toFixed(1)}`)).join(',');
}

// ------------------------------------------------------------- helpers --

function osFamily(os: FingerprintOs): 'win' | 'mac' | 'linux' {
  return os === 'macos' ? 'mac' : os === 'linux' ? 'linux' : 'win';
}

/** Deterministic PRNG (mulberry32) so a seed reproduces the same fingerprint in tests. */
export function prng(seed: string): () => number {
  let a = parseInt(crypto.createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weighted<T>(rnd: () => number, items: Array<{ item: T; weight: number }>): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rnd() * total;
  for (const i of items) {
    r -= i.weight;
    if (r <= 0) return i.item;
  }
  return items[items.length - 1].item;
}

export function userAgentFor(os: FingerprintOs, major: number): string {
  return chromiumUserAgent(os, major);
}

function identityBrands(identity: BrowserIdentity, major: number, full?: string): Array<{ brand: string; version: string }> {
  const list = brandList(major, full);
  const replacement: Record<string, string> = {
    edge: 'Microsoft Edge', opera: 'Opera', vivaldi: 'Vivaldi', 'samsung-internet': 'Samsung Internet',
  };
  const product = replacement[identity];
  if (!product) return list;
  return list.map((brand) => brand.brand === 'Google Chrome' ? { ...brand, brand: product } : brand);
}

/** Parse the Chrome major version out of a UA string (0 if not Chrome-like). */
export function uaMajor(ua: string): number {
  const m = /Chrome\/(\d+)\./.exec(ua);
  return m ? Number(m[1]) : 0;
}

/** OS implied by a user-agent string (for validation of manual user agents). */
export function osFromUserAgent(ua: string): 'win' | 'mac' | 'linux' | 'other' {
  if (/Windows NT/.test(ua)) return 'win';
  if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
  if (/X11; Linux|Linux x86_64/.test(ua) && !/Android/.test(ua)) return 'linux';
  return 'other';
}

function platformVersionFor(os: FingerprintOs, rnd: () => number): string {
  switch (os) {
    case 'windows11': return rnd() < 0.55 ? '15.0.0' : '19.0.0';
    case 'windows10': return '10.0.0';
    case 'macos': return ['13.6.7', '14.6.1', '14.7.0', '15.3.2', '15.5.0'][Math.floor(rnd() * 5)];
    default: return ['6.5.0', '6.8.0', '6.11.0'][Math.floor(rnd() * 3)];
  }
}

/** Chrome's GREASE brand for a major version (same algorithm as Chromium's user_agent_utils). */
export function greaseBrand(major: number): { brand: string; version: string } {
  const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
  const versions = ['8', '99', '24'];
  return { brand: `Not${chars[major % chars.length]}A${chars[(major + 1) % chars.length]}Brand`, version: versions[major % versions.length] };
}

/** navigator.userAgentData.brands in Chrome's order for that major version. */
export function brandList(major: number, fullVersion?: string): Array<{ brand: string; version: string }> {
  const g = greaseBrand(major);
  const v = fullVersion ?? String(major);
  const grease = { brand: g.brand, version: fullVersion ? `${g.version}.0.0.0` : g.version };
  const chromium = { brand: 'Chromium', version: v };
  const chrome = { brand: 'Google Chrome', version: v };
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const order = orders[major % 6];
  const out: Array<{ brand: string; version: string }> = [];
  out[order[0]] = grease;
  out[order[1]] = chromium;
  out[order[2]] = chrome;
  return out;
}

export function secChUa(list: Array<{ brand: string; version: string }>): string {
  return list.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
}

export function navigatorPlatform(os: FingerprintOs): string {
  return os === 'macos' ? 'MacIntel' : os === 'linux' ? 'Linux x86_64' : 'Win32';
}

/** UA-CH platform name ("Windows" / "macOS" / "Linux"). */
export function chPlatform(os: FingerprintOs): string {
  return os === 'macos' ? 'macOS' : os === 'linux' ? 'Linux' : 'Windows';
}

export function newSeed(): string {
  return crypto.randomBytes(8).toString('hex');
}

function defaultCores(os: FingerprintOs, tier: GpuPreset['tier'], rnd: () => number): number {
  if (os === 'macos') return tier === 'high' ? (rnd() < 0.5 ? 10 : 12) : 8;
  const pool = tier === 'low' ? [4, 4, 8] : tier === 'mid' ? [4, 6, 8, 8, 12] : [8, 12, 12, 16, 16, 20];
  return pool[Math.floor(rnd() * pool.length)];
}

// ------------------------------------------------------------ generate --

export interface GenerateOptions {
  os?: FingerprintOs;
  /** Chrome major version of the engine (process.versions.chrome). */
  engineMajor: number;
  /** Full engine version (e.g. "150.0.7312.58"); used for UA-CH full versions. */
  engineFullVersion?: string;
  seed?: string;
}

/**
 * Generate a complete, internally consistent fingerprint. Deterministic for a
 * given seed + options (unit tests), random otherwise.
 */
export function generateFingerprint(opts: GenerateOptions): FingerprintConfig {
  const seed = opts.seed ?? newSeed();
  const rnd = prng(seed);
  const os: FingerprintOs = opts.os ?? weighted(rnd, [
    { item: 'windows11' as FingerprintOs, weight: 45 }, { item: 'windows10' as FingerprintOs, weight: 35 },
    { item: 'macos' as FingerprintOs, weight: 17 }, { item: 'linux' as FingerprintOs, weight: 3 },
  ]);
  const major = opts.engineMajor > 0 ? opts.engineMajor : 140;
  const full = opts.engineFullVersion && opts.engineFullVersion.startsWith(`${major}.`) ? opts.engineFullVersion : `${major}.0.${6800 + Math.floor(rnd() * 900)}.${Math.floor(rnd() * 200)}`;
  const gpu = weighted(rnd, gpuPresets(os).map((g) => ({ item: g, weight: g.weight })));
  const [sw, sh] = weighted(rnd, SCREENS[osFamily(os)].map(([w, h, wt]) => ({ item: [w, h] as [number, number], weight: wt })));
  const cores = defaultCores(os, gpu.tier, rnd);
  const memory = os === 'macos' || gpu.tier !== 'low' ? 8 : rnd() < 0.5 ? 4 : 8;
  const fonts = randomizeFonts(os, seed);
  const mac = generateMacAddress(seed);
  const devName = generateDeviceName(os, seed);

  return {
    schemaVersion: FINGERPRINT_SCHEMA_VERSION,
    enabled: true,
    os,
    browserIdentity: 'chrome',
    userAgent: userAgentFor(os, major),
    uaFullVersion: full,
    platformVersion: platformVersionFor(os, rnd),
    osVersion: os === 'windows11' ? 'win11-24h2' : os === 'windows10' ? 'win10-22h2' : os === 'macos' ? 'mac15' : 'ubuntu24',
    browserVersion: String(major),
    webrtc: { mode: 'altered', publicIp: '' },
    canvas: 'noise',
    webgl: 'noise',
    webglInfo: { mode: 'manual', vendor: gpu.vendor, renderer: gpu.renderer },
    webgpu: 'off',
    clientRects: 'noise',
    timezone: { mode: 'auto', value: '' },
    language: { mode: 'auto', value: '' },
    geolocation: { mode: 'auto', latitude: 0, longitude: 0, accuracy: 10 },
    cpu: { mode: 'manual', cores },
    memory: { mode: 'manual', gb: memory },
    screen: { mode: 'manual', width: sw, height: sh },
    windowSize: { mode: 'default', width: sw, height: sh },
    fonts: 'noise',
    fontList: fonts,
    audio: 'noise',
    speechVoices: 'noise',
    mediaDevices: { mode: 'manual', audioInputs: 1, audioOutputs: 1, videoInputs: os === 'macos' || rnd() < 0.5 ? 1 : 0 },
    ports: { mode: 'protect', list: DEFAULT_PROTECTED_PORTS },
    doNotTrack: false,
    battery: 'noise',
    deviceName: { mode: 'custom', value: devName },
    macAddress: { mode: 'custom', value: mac },
    hardwareAcceleration: 'default',
    videoSpoofing: 'enable',
    seed,
    seedMode: 'persistent',
  };
}

/** Fingerprint of a profile that behaves exactly like the engine (antidetect off). */
export function realFingerprint(engineMajor: number): FingerprintConfig {
  const fp = generateFingerprint({ engineMajor, os: 'windows10', seed: 'real' });
  return {
    ...fp,
    enabled: false,
    webrtc: { mode: 'real', publicIp: '' },
    canvas: 'real', webgl: 'real', webglInfo: { mode: 'real', vendor: '', renderer: '' }, clientRects: 'real',
    webgpu: 'real',
    timezone: { mode: 'real', value: '' }, language: { mode: 'real', value: '' },
    geolocation: { mode: 'auto', latitude: 0, longitude: 0, accuracy: 10 },
    cpu: { mode: 'real', cores: 8 }, memory: { mode: 'real', gb: 8 }, screen: { mode: 'real', width: 1920, height: 1080 },
    fonts: 'real', audio: 'real', speechVoices: 'real', mediaDevices: { mode: 'real', audioInputs: 1, audioOutputs: 1, videoInputs: 1 },
    ports: { mode: 'real', list: DEFAULT_PROTECTED_PORTS },
    battery: 'real',
    deviceName: { mode: 'real', value: '' },
    macAddress: { mode: 'real', value: '' },
    hardwareAcceleration: 'default',
    videoSpoofing: 'disable',
  };
}

// ------------------------------------------------------------ sanitize --

const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
const num = (v: unknown, min: number, max: number, d: number, integer = false) => {
  if (v === undefined) return d;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) {
    throw new Error(`Fingerprint number must be a finite ${integer ? 'integer' : 'number'} in range ${min}..${max}`);
  }
  return v;
};
const plainObject = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};
const validTimezone = (value: string): boolean => {
  if (!value) return true;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; } catch { return false; }
};
const validLanguage = (value: string): boolean => {
  if (!value) return true;
  try { return Intl.getCanonicalLocales(value).length === 1; } catch { return false; }
};
const str = (v: unknown, max: number, d = '') => (typeof v === 'string' ? v.replace(/[\r\n\0]/g, '').slice(0, max) : d);

/** Validate a stored/received fingerprint; anything invalid falls back to `base`. */
export function sanitizeFingerprint(input: unknown, base: FingerprintConfig): FingerprintConfig {
  if (!plainObject(input)) {
    if (input == null) input = {};
    else throw new Error('Fingerprint configuration must be a plain object');
  }
  const raw = input as Record<string, unknown>;
  if (JSON.stringify(raw).length > 256_000) throw new Error('Fingerprint configuration is too large');
  const known = new Set(['schemaVersion','browserIdentity','migrationWarnings','enabled','os','userAgent','uaFullVersion','platformVersion','osVersion','browserVersion','webrtc','canvas','webgl','webglInfo','webgpu','clientRects','timezone','language','geolocation','cpu','memory','screen','windowSize','fonts','fontList','audio','speechVoices','mediaDevices','ports','doNotTrack','battery','deviceName','macAddress','hardwareAcceleration','videoSpoofing','seed','seedMode','launchArgs']);
  for (const key of Object.keys(raw)) if (!known.has(key)) throw new Error(`Unknown fingerprint setting: ${key}`);
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) throw new Error('Unsupported fingerprint schema version');
  // launchArgs is intentionally recognized only so legacy data can be discarded.
  // It is never copied into the validated result or passed to a launcher.
  const v = raw as Partial<FingerprintConfig>;
  const legacyGeoPermission = v.geolocation?.mode === 'allow';
  const os = oneOf(v.os, FP_OSES, base.os);
  const identity = v.browserIdentity === undefined ? (base.browserIdentity ?? 'chrome') : browserIdentityFor(v.browserIdentity);
  if (!identity) throw new FingerprintValidationError('browserIdentity', 'unknown browser identity');
  if (identity === 'samsung-internet') throw new FingerprintValidationError('browserIdentity', 'samsung-internet requires an Android fingerprint');
  const ua = str(v.userAgent, 512, base.userAgent).trim() || base.userAgent;
  const tz = str(v.timezone?.value, 64);

  // Normalize webrtc mode
  let webrtcMode = v.webrtc?.mode as WebRtcMode;
  if (webrtcMode === 'substitute') webrtcMode = 'altered';
  else if (webrtcMode === 'forward') webrtcMode = 'disable-udp';
  else if (webrtcMode === 'disable') webrtcMode = 'off';
  const finalRtcMode = oneOf(webrtcMode, ['off', 'real', 'disable-udp', 'altered', 'manual'] as const, base.webrtc.mode);

  // Normalize webgpu
  let webgpuMode = v.webgpu;
  if (webgpuMode === 'disable') webgpuMode = 'off';
  const finalGpuMode = oneOf(webgpuMode, ['off', 'real', 'webgl-based'] as const, base.webgpu);

  // Font list
  if (Array.isArray(v.fontList) && v.fontList.length > 256) throw new Error('Font list contains too many entries');
  const fontList = Array.isArray(v.fontList) ? v.fontList.map((f) => {
    if (typeof f !== 'string' || f.length > 64) throw new Error('Invalid font name');
    return f;
  }).filter(Boolean) : (base.fontList ?? fontPresets(os));
  if (fontList.join('').length > 16_384) throw new Error('Font list is too large');

  return {
    schemaVersion: FINGERPRINT_SCHEMA_VERSION,
    ...(legacyGeoPermission ? { migrationWarnings: ['fp.warn.geoPermissionMigrated'] } : (base.migrationWarnings ? { migrationWarnings: [...base.migrationWarnings] } : {})),
    enabled: typeof v.enabled === 'boolean' ? v.enabled : base.enabled,
    browserIdentity: identity,
    os,
    userAgent: ua,
    uaFullVersion: /^\d+\.\d+\.\d+\.\d+$/.test(str(v.uaFullVersion, 32)) ? str(v.uaFullVersion, 32) : base.uaFullVersion,
    platformVersion: /^\d+\.\d+\.\d+$/.test(str(v.platformVersion, 32)) ? str(v.platformVersion, 32) : base.platformVersion,
    osVersion: v.osVersion === undefined ? base.osVersion : (str(v.osVersion, 64) || base.osVersion),
    browserVersion: v.browserVersion === undefined ? base.browserVersion : (str(v.browserVersion, 16) || base.browserVersion),
    webrtc: {
      mode: finalRtcMode,
      publicIp: (() => { const ip = str(v.webrtc?.publicIp, 45); if (ip && isIP(ip) === 0) throw new Error('Invalid WebRTC IP address'); return ip || base.webrtc.publicIp; })(),
    },
    canvas: oneOf(v.canvas, ['off', 'real', 'noise'] as const, base.canvas),
    webgl: oneOf(v.webgl, ['off', 'real', 'noise'] as const, base.webgl),
    webglInfo: {
      mode: oneOf(v.webglInfo?.mode, ['real', 'manual', 'custom'] as const, base.webglInfo.mode),
      vendor: str(v.webglInfo?.vendor, 128, base.webglInfo.vendor),
      renderer: str(v.webglInfo?.renderer, 256, base.webglInfo.renderer),
    },
    webgpu: finalGpuMode,
    clientRects: oneOf(v.clientRects, ['real', 'noise'] as const, base.clientRects),
    timezone: {
      mode: oneOf(v.timezone?.mode, ['auto', 'manual', 'real', 'ip-match'] as const, base.timezone.mode),
      value: (() => { if (tz && !validTimezone(tz)) throw new Error('Invalid time zone'); return v.timezone?.value === undefined ? base.timezone.value : tz; })(),
    },
    language: {
      mode: oneOf(v.language?.mode, ['auto', 'manual', 'real', 'ip-match', 'lang-match'] as const, base.language.mode),
      value: (() => { const language = str(v.language?.value, 32); if (language && !validLanguage(language)) throw new Error('Invalid language tag'); return v.language?.value === undefined ? base.language.value : language; })(),
    },
    geolocation: {
      mode: v.geolocation?.mode === 'allow' ? 'ask' : oneOf(v.geolocation?.mode, ['auto', 'manual', 'block', 'ask', 'disable', 'ip-match'] as const, base.geolocation.mode),
      latitude: num(v.geolocation?.latitude, -90, 90, base.geolocation.latitude),
      longitude: num(v.geolocation?.longitude, -180, 180, base.geolocation.longitude),
      accuracy: num(v.geolocation?.accuracy, 1, 100000, base.geolocation.accuracy),
    },
    cpu: { mode: oneOf(v.cpu?.mode, ['real', 'manual', 'custom'] as const, base.cpu.mode), cores: num(v.cpu?.cores, 1, 64, base.cpu.cores, true) },
    memory: { mode: oneOf(v.memory?.mode, ['real', 'manual', 'custom'] as const, base.memory.mode), gb: (() => { if (v.memory?.gb === undefined) return base.memory.gb; if (typeof v.memory.gb !== 'number' || !Number.isFinite(v.memory.gb) || !(MEMORY_CHOICES as readonly number[]).includes(v.memory.gb)) throw new Error('Invalid memory value'); return v.memory.gb; })() },
    screen: {
      mode: oneOf(v.screen?.mode, ['real', 'manual', 'custom', 'random'] as const, base.screen.mode),
      width: num(v.screen?.width, 640, 7680, base.screen.width, true),
      height: num(v.screen?.height, 480, 4320, base.screen.height, true),
    },
    ...(v.windowSize ? {
      windowSize: {
        mode: oneOf(v.windowSize?.mode, ['default', 'custom'] as const, 'default'),
        width: Math.round(num(v.windowSize?.width, 640, 7680, base.screen.width)),
        height: Math.round(num(v.windowSize?.height, 480, 4320, base.screen.height)),
      },
    } : base.windowSize ? { windowSize: { ...base.windowSize } } : {}),
    fonts: oneOf(v.fonts, ['real', 'noise', 'custom'] as const, base.fonts),
    fontList,
    audio: oneOf(v.audio, ['real', 'noise'] as const, base.audio),
    speechVoices: oneOf(v.speechVoices, ['real', 'noise'] as const, base.speechVoices ?? 'noise'),
    mediaDevices: {
      mode: oneOf(v.mediaDevices?.mode, ['real', 'manual', 'custom', 'noise'] as const, base.mediaDevices.mode),
      audioInputs: num(v.mediaDevices?.audioInputs, 0, 9, 1, true),
      audioOutputs: num(v.mediaDevices?.audioOutputs, 0, 9, 1, true),
      videoInputs: num(v.mediaDevices?.videoInputs, 0, 9, 1, true),
    },
    ports: {
      mode: oneOf(v.ports?.mode, ['real', 'protect', 'enable', 'close'] as const, base.ports.mode),
      list: v.ports?.list === undefined ? base.ports.list : (/^[\d,\s]*$/.test(str(v.ports?.list, 1024)) ? str(v.ports?.list, 1024).replace(/\s+/g, '') : base.ports.list),
    },
    doNotTrack: (typeof v.doNotTrack === 'boolean' || v.doNotTrack === 'default' || v.doNotTrack === 'enable' || v.doNotTrack === 'close') ? v.doNotTrack : base.doNotTrack,
    battery: oneOf(v.battery, ['real', 'noise'] as const, base.battery ?? 'noise'),
    deviceName: {
      mode: oneOf(v.deviceName?.mode, ['real', 'custom'] as const, base.deviceName?.mode ?? 'custom'),
      value: str(v.deviceName?.value, 64, base.deviceName?.value ?? generateDeviceName(os)),
    },
    macAddress: {
      mode: oneOf(v.macAddress?.mode, ['real', 'custom'] as const, base.macAddress?.mode ?? 'custom'),
      value: /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/.test(str(v.macAddress?.value, 20)) ? str(v.macAddress?.value, 20).toUpperCase() : (base.macAddress?.value ?? generateMacAddress()),
    },
    hardwareAcceleration: oneOf(v.hardwareAcceleration, ['default', 'enable', 'close'] as const, base.hardwareAcceleration ?? 'default'),
    videoSpoofing: oneOf(v.videoSpoofing, ['enable', 'disable'] as const, base.videoSpoofing ?? 'enable'),
    seed: /^[0-9a-f]{4,64}$/.test(str(v.seed, 64)) ? str(v.seed, 64) : base.seed,
    seedMode: oneOf(v.seedMode, ['persistent', 'per-run'] as const, base.seedMode ?? 'persistent'),
  };
}

/** Parse a comma separated port list into numbers (1..65535). */
export function parsePorts(list: string): number[] {
  return [...new Set(list.split(',').map((p) => Number(p.trim())).filter((p) => Number.isInteger(p) && p > 0 && p < 65536))];
}

// ------------------------------------------------------------ resolve --

/** Geo facts about the exit IP (from a proxy check), used for "auto" values. */
export interface GeoInfo {
  ip?: string;
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  timezone?: string;
  latitude?: number;
  longitude?: number;
}

/**
 * Values actually applied when the profile runs. "auto" is resolved from the
 * exit IP (proxy check) and falls back to the machine's real values when no
 * geo information is available.
 */
export interface EnabledResolvedFingerprint {
  kind: 'enabled';
  enabled: true;
  browserIdentity?: BrowserIdentity;
  identityUnsupported?: boolean;
  os: FingerprintOs;
  userAgent: string;
  major: number;
  platform: string;
  chPlatform: string;
  platformVersion: string;
  brands: Array<{ brand: string; version: string }>;
  fullVersionList: Array<{ brand: string; version: string }>;
  uaFullVersion: string;
  architecture: string;
  bitness: string;
  timezone: string | null;
  languages: string[] | null;
  acceptLanguage: string | null;
  geolocation: { latitude: number; longitude: number; accuracy: number } | null;
  geoBlocked: boolean;
  webrtcPolicy: 'default' | 'default_public_interface_only' | 'disable_non_proxied_udp';
  webrtcMode: WebRtcMode;
  webrtcIp: string;
  canvas: NoiseMode;
  webgl: NoiseMode;
  webglVendor: string | null;
  webglRenderer: string | null;
  webgpu: 'off' | 'real' | 'webgl-based' | 'disable';
  clientRects: 'real' | 'noise';
  cores: number | null;
  memory: number | null;
  screen: { width: number; height: number; availWidth: number; availHeight: number } | null;
  windowSize?: { width: number; height: number } | null;
  fonts: 'real' | 'noise' | 'custom';
  fontList?: string[];
  audio: 'real' | 'noise';
  speechVoices: 'real' | 'noise';
  mediaDevices: { audioInputs: number; audioOutputs: number; videoInputs: number } | null;
  protectedPorts: number[];
  doNotTrack: boolean;
  battery: 'real' | 'noise';
  deviceName: string | null;
  macAddress: string | null;
  hardwareAcceleration: 'default' | 'enable' | 'close';
  videoSpoofing: boolean;
  seed: string;
}

export interface DisabledResolvedFingerprint {
  kind: 'disabled';
  enabled: false;
}

export type ResolvedFingerprint = EnabledResolvedFingerprint | DisabledResolvedFingerprint;

function safeGeoInfo(geo: GeoInfo | undefined): GeoInfo | undefined {
  if (!plainObject(geo)) return undefined;
  const raw = geo as Record<string, unknown>;
  const out: GeoInfo = {};
  if (raw.ip === undefined || (typeof raw.ip === 'string' && isIP(raw.ip) !== 0)) out.ip = typeof raw.ip === 'string' ? raw.ip : undefined;
  if (raw.countryCode === undefined || (typeof raw.countryCode === 'string' && /^[A-Za-z]{2}$/.test(raw.countryCode))) out.countryCode = typeof raw.countryCode === 'string' ? raw.countryCode : undefined;
  if (raw.timezone === undefined || (typeof raw.timezone === 'string' && validTimezone(raw.timezone))) out.timezone = typeof raw.timezone === 'string' ? raw.timezone : undefined;
  if (raw.latitude === undefined || (typeof raw.latitude === 'number' && Number.isFinite(raw.latitude) && raw.latitude >= -90 && raw.latitude <= 90)) out.latitude = typeof raw.latitude === 'number' ? raw.latitude : undefined;
  if (raw.longitude === undefined || (typeof raw.longitude === 'number' && Number.isFinite(raw.longitude) && raw.longitude >= -180 && raw.longitude <= 180)) out.longitude = typeof raw.longitude === 'number' ? raw.longitude : undefined;
  return out;
}

export function resolveFingerprint(fp: FingerprintConfig, geoInput: GeoInfo | undefined, fallbackLang: string): ResolvedFingerprint {
  if (!fp.enabled) return { kind: 'disabled', enabled: false };
  const geo = safeGeoInfo(geoInput);
  const major = uaMajor(fp.userAgent) || Number(fp.uaFullVersion.split('.')[0]) || 140;
  const full = fp.uaFullVersion.startsWith(`${major}.`) ? fp.uaFullVersion : `${major}.0.0.0`;
  const identity = fp.browserIdentity ?? 'chrome';
  if (isFirefoxIdentity(identity)) return { kind: 'enabled', enabled: true, identityUnsupported: true, browserIdentity: identity, os: fp.os, userAgent: fp.userAgent, major, platform: navigatorPlatform(fp.os), chPlatform: chPlatform(fp.os), platformVersion: fp.platformVersion, brands: identityBrands(identity, major), fullVersionList: identityBrands(identity, major, full), uaFullVersion: full, architecture: 'x86', bitness: '64', timezone: null, languages: null, acceptLanguage: null, geolocation: null, geoBlocked: false, webrtcPolicy: 'default_public_interface_only', webrtcMode: 'real', webrtcIp: '', canvas: 'real', webgl: 'real', webglVendor: null, webglRenderer: null, webgpu: 'real', clientRects: 'real', cores: null, memory: null, screen: null, windowSize: null, fonts: 'real', fontList: [], audio: 'real', speechVoices: 'real', mediaDevices: null, protectedPorts: [], doNotTrack: false, battery: 'real', deviceName: null, macAddress: null, hardwareAcceleration: 'default', videoSpoofing: false, seed: fp.seed };
  const identityUnsupported = identity !== 'chrome' && identity !== 'chromium' && identity !== 'edge' && identity !== 'brave' && (identityMappingStale(identity, major) || BRAND_VERSION_MAP[identity](major) === null);
  const identityUa = identityUnsupported ? chromiumUserAgent(fp.os, major) : chromiumIdentityUserAgent(identity, fp.os, major);
  const on = true;
  const tz = !on || fp.timezone.mode === 'real' ? null : (fp.timezone.mode === 'manual' ? fp.timezone.value || null : geo?.timezone || null);
  let lang: string | null = null;
  if (on && (fp.language.mode === 'manual' || fp.language.mode === 'lang-match') && fp.language.value) lang = fp.language.value;
  else if (on && (fp.language.mode === 'auto' || fp.language.mode === 'ip-match')) lang = (geo?.countryCode && COUNTRY_LANG[geo.countryCode.toUpperCase()]) || fallbackLang;
  let geoPos: EnabledResolvedFingerprint['geolocation'] = null;
  if (on && fp.geolocation.mode === 'manual') geoPos = { latitude: fp.geolocation.latitude, longitude: fp.geolocation.longitude, accuracy: fp.geolocation.accuracy };
  else if (on && (fp.geolocation.mode === 'auto' || fp.geolocation.mode === 'ip-match') && typeof geo?.latitude === 'number' && typeof geo?.longitude === 'number') {
    geoPos = { latitude: geo.latitude, longitude: geo.longitude, accuracy: fp.geolocation.accuracy || 10 };
  }
  let webrtcMode: WebRtcMode = on ? fp.webrtc.mode : 'real';
  if (webrtcMode === 'substitute') webrtcMode = 'altered';
  if (webrtcMode === 'forward') webrtcMode = 'disable-udp';
  if (webrtcMode === 'disable') webrtcMode = 'off';

  const webrtcPolicy = webrtcMode === 'real' ? 'default_public_interface_only' : 'disable_non_proxied_udp';
  const osKey = osFamily(fp.os);
  const screen = on && (fp.screen.mode === 'manual' || fp.screen.mode === 'custom' || fp.screen.mode === 'random')
    ? { width: fp.screen.width, height: fp.screen.height, availWidth: fp.screen.width, availHeight: fp.screen.height - (osKey === 'win' ? 40 : osKey === 'mac' ? 25 : 27) }
    : null;
  const viewport = on && (fp.windowSize?.mode === 'custom' || screen)
    ? (fp.windowSize?.mode === 'custom' ? { width: fp.windowSize.width, height: fp.windowSize.height } : { width: screen!.width, height: screen!.height })
    : null;
  const configuredGpu = (fp.webglInfo.mode === 'manual' || fp.webglInfo.mode === 'custom') && fp.webglInfo.vendor && fp.webglInfo.renderer
    ? { vendor: fp.webglInfo.vendor, renderer: fp.webglInfo.renderer }
    : null;
  // Older profiles may have noise enabled with WebGL info still set to Real.
  // Select one coherent OS-compatible GPU from the profile seed rather than
  // allowing the page to fall through to the host adapter.
  const noiseGpu = fp.webgl === 'noise' && !configuredGpu
    ? gpuPresets(fp.os)[Math.floor(prng(`${fp.seed}:webgl` )() * gpuPresets(fp.os).length)]
    : null;
  const exposedGpu = on && fp.webgl !== 'off' ? (configuredGpu ?? noiseGpu) : null;
  const isAppleSilicon = fp.os === 'macos' && /Apple M\d/.test(fp.webglInfo.renderer);
  const portsActive = on && (fp.ports.mode === 'protect' || fp.ports.mode === 'enable');
  const dntActive = on && (fp.doNotTrack === true || fp.doNotTrack === 'enable');

  return {
    kind: 'enabled',
    enabled: true,
    os: fp.os,
    browserIdentity: identity,
    identityUnsupported,
    userAgent: identityUa,
    major,
    platform: navigatorPlatform(fp.os),
    chPlatform: chPlatform(fp.os),
    platformVersion: fp.platformVersion,
    brands: brandList(major),
    fullVersionList: brandList(major, full),
    uaFullVersion: full,
    architecture: isAppleSilicon ? 'arm' : 'x86',
    bitness: '64',
    timezone: tz,
    languages: lang ? languageList(lang) : null,
    acceptLanguage: lang ? acceptLanguageHeader(lang) : null,
    geolocation: geoPos,
    geoBlocked: on && (fp.geolocation.mode === 'block' || fp.geolocation.mode === 'disable'),
    webrtcPolicy,
    webrtcMode,
    webrtcIp: webrtcMode === 'manual' ? fp.webrtc.publicIp : webrtcMode === 'altered' ? geo?.ip ?? '' : '',
    canvas: on ? fp.canvas : 'real',
    webgl: on ? fp.webgl : 'real',
    webglVendor: exposedGpu?.vendor ?? null,
    webglRenderer: exposedGpu?.renderer ?? null,
    // WebGPU can reveal the same adapter even when WebGL is disabled. Treat
    // WebGL=off as a graphics-exposure off switch so the page shim cannot
    // re-expose the host adapter through navigator.gpu.
    webgpu: on ? (fp.webgl === 'off' ? 'off' : fp.webgpu) : 'real',
    clientRects: on ? fp.clientRects : 'real',
    cores: on && (fp.cpu.mode === 'manual' || fp.cpu.mode === 'custom') ? fp.cpu.cores : null,
    memory: on && (fp.memory.mode === 'manual' || fp.memory.mode === 'custom') ? Math.min(8, fp.memory.gb) : null,
    screen,
    windowSize: viewport,
    fonts: on ? fp.fonts : 'real',
    fontList: on && fp.fonts === 'custom' ? (fp.fontList ?? fontPresets(fp.os)) : (fp.fontList ?? fontPresets(fp.os)),
    audio: on ? fp.audio : 'real',
    speechVoices: on ? (fp.speechVoices ?? 'noise') : 'real',
    mediaDevices: on && (fp.mediaDevices.mode === 'manual' || fp.mediaDevices.mode === 'custom' || fp.mediaDevices.mode === 'noise') ? { audioInputs: fp.mediaDevices.audioInputs, audioOutputs: fp.mediaDevices.audioOutputs, videoInputs: fp.mediaDevices.videoInputs } : null,
    protectedPorts: portsActive ? parsePorts(fp.ports.list) : [],
    doNotTrack: dntActive,
    battery: on ? (fp.battery ?? 'noise') : 'real',
    deviceName: on && fp.deviceName?.mode === 'custom' ? fp.deviceName.value : null,
    macAddress: on && fp.macAddress?.mode === 'custom' ? fp.macAddress.value : null,
    hardwareAcceleration: on ? (fp.hardwareAcceleration ?? 'default') : 'default',
    videoSpoofing: on && fp.videoSpoofing !== 'disable',
    seed: fp.seed,
  } as EnabledResolvedFingerprint;
}

/** Problems that would make a fingerprint look inconsistent (shown in the editor). */
export function fingerprintWarnings(fp: FingerprintConfig, engineMajor: number): string[] {
  const out: string[] = [];
  if (!fp.enabled) return out;
  const uaOs = osFromUserAgent(fp.userAgent);
  const fam = osFamily(fp.os);
  if (uaOs !== 'other' && uaOs !== fam) out.push('fp.warn.uaOs');
  if (!/Chrome\/\d+\./.test(fp.userAgent) || /Firefox\/|Version\/\d+.*Safari\//.test(fp.userAgent)) out.push('fp.warn.engineUa');
  if (engineMajor && uaMajor(fp.userAgent) && Math.abs(uaMajor(fp.userAgent) - engineMajor) > 2) out.push('fp.warn.uaVersion');
  if (fp.webglInfo.mode === 'manual' || fp.webglInfo.mode === 'custom') {
    const isApple = fp.webglInfo.renderer.includes('Apple M');
    const isD3D = fp.webglInfo.renderer.includes('Direct3D');
    if (isApple && fp.os !== 'macos') out.push('fp.warn.gpuOs');
    if (isD3D && fp.os === 'macos') out.push('fp.warn.gpuOs');
  }
  if (fp.os === 'macos' && (fp.cpu.mode === 'manual' || fp.cpu.mode === 'custom') && fp.cpu.cores < 8) out.push('fp.warn.macCores');
  if (fp.webgpu === 'real' || fp.webgpu === 'webgl-based') out.push('fp.warn.webgpu');
  if (fp.webglInfo.mode === 'real') out.push('fp.warn.webglReal');
  if (fp.fonts === 'real') out.push('fp.warn.fontsReal');
  return out;
}

export interface FingerprintConsistencyIssue {
  code: string;
  field: string;
  severity: 'error' | 'warn';
  message: string;
}

export interface FingerprintConsistencyReport {
  valid: boolean;
  issues: FingerprintConsistencyIssue[];
}

/**
 * Startup consistency validator: checks for impossible combinations (e.g. Apple GPU
 * on Windows, D3D on macOS, UA OS vs platform contradiction, version desync) before
 * profile execution.
 */
export function validateProfileFingerprintConsistency(fp: FingerprintConfig, engineMajor = 140): FingerprintConsistencyReport {
  const issues: FingerprintConsistencyIssue[] = [];
  if (!fp.enabled) {
    return { valid: true, issues: [] };
  }

  const uaFam = osFromUserAgent(fp.userAgent);
  const osFam = osFamily(fp.os);
  if (uaFam !== 'other' && uaFam !== osFam) {
    issues.push({
      code: 'UA_OS_MISMATCH',
      field: 'userAgent',
      severity: 'error',
      message: `User-Agent OS (${uaFam}) contradicts selected OS platform (${osFam}).`,
    });
  }

  const uaMaj = uaMajor(fp.userAgent);
  if (uaMaj && fp.uaFullVersion && !fp.uaFullVersion.startsWith(`${uaMaj}.`)) {
    issues.push({
      code: 'VERSION_MISMATCH',
      field: 'uaFullVersion',
      severity: 'error',
      message: `User-Agent major version (${uaMaj}) does not match Client Hints full version (${fp.uaFullVersion}).`,
    });
  }

  if (fp.webglInfo.mode === 'manual' || fp.webglInfo.mode === 'custom') {
    const isAppleGpu = /Apple\s*M\d/i.test(fp.webglInfo.renderer);
    const isDirect3D = /Direct3D|vs_\d|ps_\d/i.test(fp.webglInfo.renderer);
    const isMesa = /Mesa|radeonsi|nouveau/i.test(fp.webglInfo.renderer);

    if (isAppleGpu && fp.os !== 'macos') {
      issues.push({
        code: 'GPU_OS_MISMATCH',
        field: 'webglInfo',
        severity: 'error',
        message: 'Apple Silicon GPU renderer cannot run on non-macOS platforms.',
      });
    }
    if (isDirect3D && fp.os === 'macos') {
      issues.push({
        code: 'GPU_OS_MISMATCH',
        field: 'webglInfo',
        severity: 'error',
        message: 'Direct3D ANGLE backend is impossible on macOS (Metal / OpenGL only).',
      });
    }
    if (isMesa && osFam === 'win') {
      issues.push({
        code: 'GPU_OS_MISMATCH',
        field: 'webglInfo',
        severity: 'warn',
        message: 'Mesa Linux graphics stack selected on Windows platform.',
      });
    }
  }

  if (fp.screen.mode === 'manual' || fp.screen.mode === 'custom') {
    if (fp.screen.width < 640 || fp.screen.height < 480) {
      issues.push({
        code: 'INVALID_SCREEN_BOUNDS',
        field: 'screen',
        severity: 'error',
        message: `Screen dimensions (${fp.screen.width}x${fp.screen.height}) are below minimal desktop limits.`,
      });
    }
  }

  if (fp.cpu.mode === 'manual' || fp.cpu.mode === 'custom') {
    if (fp.cpu.cores < 1 || fp.cpu.cores > 128) {
      issues.push({
        code: 'INVALID_CPU_CORES',
        field: 'cpu',
        severity: 'error',
        message: `CPU cores (${fp.cpu.cores}) are outside reasonable hardware range.`,
      });
    }
  }

  const hasErrors = issues.some((i) => i.severity === 'error');
  return {
    valid: !hasErrors,
    issues,
  };
}
