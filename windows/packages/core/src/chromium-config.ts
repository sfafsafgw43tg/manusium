/**
 * Configuration contract for a standalone Chromium profile.
 *
 * This is deliberately a data contract, not a claim that stock Chromium
 * applies every field. The native launcher currently consumes only the
 * separately documented engine-privacy settings. Keeping this object strict
 * prevents malformed or internally contradictory values from reaching a
 * future source-level implementation.
 */
export interface ChromiumUaChMetadata {
  brands: Array<{ brand: string; version: string }>;
  fullVersion: string;
  platform: 'Windows' | 'Linux' | 'macOS' | 'Android' | 'Chrome OS';
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
}

export interface ChromiumDeviceMetrics {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export interface NativeChromiumConfig {
  userAgent: string;
  uaCh: ChromiumUaChMetadata;
  platform: string;
  languages: string[];
  timezone: string;
  deviceMetrics: ChromiumDeviceMetrics;
  hardwareConcurrency: number;
  touch: boolean;
}

export const DEFAULT_NATIVE_CHROMIUM_CONFIG: NativeChromiumConfig = Object.freeze({
  userAgent: '',
  uaCh: {
    brands: [], fullVersion: '', platform: 'Windows', platformVersion: '',
    architecture: '', model: '', mobile: false,
  },
  platform: 'Win32',
  languages: ['en-US', 'en'],
  timezone: 'UTC',
  deviceMetrics: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  hardwareConcurrency: 4,
  touch: false,
}) as NativeChromiumConfig;

const LANGUAGE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const TIMEZONE = /^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/;
const PLATFORM = /^(?:Win(?:32|64)|Linux(?: armv8l| aarch64)?|MacIntel|MacPPC|Android|CrOS [^\u0000-\u001f]{1,64})$/;
const BRAND = /^[^\u0000-\u001f]{1,80}$/;
const VERSION = /^\d+(?:\.\d+){0,3}$/;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : fallback;
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

/** Normalize untrusted profile data to a coherent native Chromium contract. */
export function sanitizeNativeChromiumConfig(value: unknown, fallback = DEFAULT_NATIVE_CHROMIUM_CONFIG): NativeChromiumConfig {
  const root = record(value);
  const uaCh = record(root.uaCh);
  const metrics = record(root.deviceMetrics);
  const languages = Array.isArray(root.languages)
    ? [...new Set(root.languages.filter((v): v is string => typeof v === 'string' && LANGUAGE.test(v)).map((v) => v.slice(0, 32)))].slice(0, 8)
    : fallback.languages;
  const brands = Array.isArray(uaCh.brands)
    ? uaCh.brands.filter((v) => {
      const b = record(v);
      return typeof b.brand === 'string' && BRAND.test(b.brand) && typeof b.version === 'string' && VERSION.test(b.version);
    }).slice(0, 8).map((v) => ({ brand: String(record(v).brand), version: String(record(v).version) }))
    : fallback.uaCh.brands;
  const timezone = typeof root.timezone === 'string' && TIMEZONE.test(root.timezone) ? root.timezone.slice(0, 128) : fallback.timezone;
  const platform = typeof root.platform === 'string' && PLATFORM.test(root.platform) ? root.platform : fallback.platform;
  return {
    userAgent: typeof root.userAgent === 'string' ? root.userAgent.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 512) : fallback.userAgent,
    uaCh: {
      brands,
      fullVersion: typeof uaCh.fullVersion === 'string' && VERSION.test(uaCh.fullVersion) ? uaCh.fullVersion : fallback.uaCh.fullVersion,
      platform: ['Windows', 'Linux', 'macOS', 'Android', 'Chrome OS'].includes(String(uaCh.platform)) ? uaCh.platform as ChromiumUaChMetadata['platform'] : fallback.uaCh.platform,
      platformVersion: typeof uaCh.platformVersion === 'string' && VERSION.test(uaCh.platformVersion) ? uaCh.platformVersion : fallback.uaCh.platformVersion,
      architecture: typeof uaCh.architecture === 'string' ? uaCh.architecture.replace(/[\u0000-\u001f]/g, '').slice(0, 32) : fallback.uaCh.architecture,
      model: typeof uaCh.model === 'string' ? uaCh.model.replace(/[\u0000-\u001f]/g, '').slice(0, 64) : fallback.uaCh.model,
      mobile: uaCh.mobile === true,
    },
    platform,
    languages: languages.length ? languages : fallback.languages,
    timezone,
    deviceMetrics: {
      width: boundedInteger(metrics.width, 320, 16_384, fallback.deviceMetrics.width),
      height: boundedInteger(metrics.height, 240, 16_384, fallback.deviceMetrics.height),
      deviceScaleFactor: boundedNumber(metrics.deviceScaleFactor, 0.5, 8, fallback.deviceMetrics.deviceScaleFactor),
    },
    hardwareConcurrency: boundedInteger(root.hardwareConcurrency, 1, 64, fallback.hardwareConcurrency),
    touch: root.touch === true,
  };
}

/** Throw when a caller wants strict validation instead of normalization. */
export function validateNativeChromiumConfig(config: NativeChromiumConfig): void {
  const normalized = sanitizeNativeChromiumConfig(config);
  if (JSON.stringify(normalized) !== JSON.stringify(config)) throw new Error('Invalid or inconsistent native Chromium configuration');
  if (config.uaCh.mobile && !config.touch) throw new Error('Mobile UA-CH requires touch support');
}
