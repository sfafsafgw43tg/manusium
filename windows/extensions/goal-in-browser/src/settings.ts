import { normalizeHost } from './hosts.js';

export type WebRtcPolicy = 'default' | 'default_public_interface_only' | 'disable_non_proxied_udp';
/**
 * default: Chrome's own referrer behaviour. origin: Referrer-Policy strict-origin for pages that set none
 * (needs site access). none: Chrome's referrers setting turned off, so no Referer header at all (may break sites).
 */
export type ReferrerChoice = 'default' | 'origin' | 'none';
export type PermissionSetting = 'ask' | 'block';

/** Switches a preset can change. Each one maps to one Chrome setting or one declarative rule (see the README). */
export const FEATURE_FLAGS = [
  'adList',
  'trackerList',
  'fingerprintList',
  'httpsUpgrade',
  'blockPings',
  'blockThirdPartyScripts',
  'blockThirdPartyFrames',
  'stripTrackingParams',
  'blockThirdPartyCookies',
  'clearOnStart',
  'doNotTrack',
  'globalPrivacyControl',
  'privacySandboxOff',
  'hyperlinkAuditingOff',
  'errorSuggestionsOff',
  'searchSuggestionsOff',
  'translationOff',
  'networkPredictionOff',
] as const;

export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

/** The settings a preset sets. */
export interface Features extends Record<FeatureFlag, boolean> {
  referrerPolicy: ReferrerChoice;
  webRtcPolicy: WebRtcPolicy;
}

export interface Settings extends Features {
  /** Master switch. Off means no rule and no managed Chrome setting is active. */
  protectionEnabled: boolean;
  locationPermission: PermissionSetting;
  notificationPermission: PermissionSetting;
  /** Shows the number of matched requests for the current tab on the toolbar icon. */
  showBadgeCount: boolean;
  /** Sites where blocking, the HTTPS upgrade and tracking-link cleanup are switched off. */
  allowlist: string[];
  /** Extra domains to block on other sites. Never blocks a page the user opens directly. */
  customBlocklist: string[];
}

/** Caps keep the dynamic rule count far below Chrome's limit for dynamic rules. */
export const LIMITS = { allowlist: 1000, customBlocklist: 2000 } as const;

const STANDARD: Features = {
  adList: true,
  trackerList: true,
  fingerprintList: true,
  httpsUpgrade: true,
  blockPings: true,
  blockThirdPartyScripts: false,
  blockThirdPartyFrames: false,
  stripTrackingParams: false,
  blockThirdPartyCookies: true,
  clearOnStart: false,
  doNotTrack: false,
  globalPrivacyControl: false,
  privacySandboxOff: true,
  hyperlinkAuditingOff: true,
  errorSuggestionsOff: true,
  searchSuggestionsOff: false,
  translationOff: false,
  networkPredictionOff: false,
  referrerPolicy: 'default',
  webRtcPolicy: 'default_public_interface_only',
};

const STRICT: Features = {
  ...STANDARD,
  stripTrackingParams: true,
  globalPrivacyControl: true,
  searchSuggestionsOff: true,
  translationOff: true,
  networkPredictionOff: true,
  referrerPolicy: 'origin',
};

const ULTRA: Features = {
  ...STRICT,
  blockThirdPartyScripts: true,
  blockThirdPartyFrames: true,
  clearOnStart: true,
  webRtcPolicy: 'disable_non_proxied_udp',
};

export const PRESET_IDS = ['standard', 'strict', 'ultra'] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export const PRESETS: Readonly<Record<PresetId, Readonly<Features>>> = {
  standard: STANDARD,
  strict: STRICT,
  ultra: ULTRA,
};

export const PRESET_LABELS: Readonly<Record<PresetId, string>> = {
  standard: 'Standard',
  strict: 'Strict',
  ultra: 'Ultra',
};

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  protectionEnabled: true,
  ...STANDARD,
  locationPermission: 'ask',
  notificationPermission: 'block',
  showBadgeCount: true,
  allowlist: [],
  customBlocklist: [],
});

const FEATURE_KEYS: readonly (keyof Features)[] = [...FEATURE_FLAGS, 'referrerPolicy', 'webRtcPolicy'];
const REFERRER_CHOICES: readonly ReferrerChoice[] = ['default', 'origin', 'none'];
const WEBRTC_POLICIES: readonly WebRtcPolicy[] = ['default', 'default_public_interface_only', 'disable_non_proxied_udp'];
const PERMISSION_SETTINGS: readonly PermissionSetting[] = ['ask', 'block'];

/** Applies a preset to the feature settings. Protection, permissions, lists and the badge are left as they are. */
export function applyPreset(settings: Settings, id: PresetId): Settings {
  return { ...settings, ...PRESETS[id] };
}

/** The preset whose features match exactly, or "custom" once any one of them differs. */
export function presetOf(settings: Settings): PresetId | 'custom' {
  const match = PRESET_IDS.find((id) => FEATURE_KEYS.every((key) => settings[key] === PRESETS[id][key]));
  return match ?? 'custom';
}

/**
 * True when a selected feature needs the optional all-sites permission. Header and redirect rules are only
 * added with it. Access is kept while any such feature is selected, even when protection is switched off.
 */
export function needsSiteAccess(
  settings: Pick<Settings, 'globalPrivacyControl' | 'stripTrackingParams' | 'referrerPolicy'>,
): boolean {
  return settings.globalPrivacyControl || settings.stripTrackingParams || settings.referrerPolicy === 'origin';
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function choice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value as string) ? (value as T) : fallback;
}

/** Hostnames only: invalid entries are dropped, duplicates removed, sorted, and capped. */
export function cleanHosts(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return [];
  const hosts = value.flatMap((entry) => (typeof entry === 'string' ? (normalizeHost(entry) ?? []) : []));
  return [...new Set(hosts)].sort().slice(0, cap);
}

/** Accepts anything that was stored or sent and returns valid settings. Unknown keys are dropped. */
export function sanitizeSettings(raw: unknown): Settings {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  const features = Object.fromEntries(FEATURE_FLAGS.map((key) => [key, flag(input[key], d[key])])) as Record<
    FeatureFlag,
    boolean
  >;
  return {
    ...features,
    protectionEnabled: flag(input.protectionEnabled, d.protectionEnabled),
    referrerPolicy: choice(input.referrerPolicy, REFERRER_CHOICES, d.referrerPolicy),
    webRtcPolicy: choice(input.webRtcPolicy, WEBRTC_POLICIES, d.webRtcPolicy),
    locationPermission: choice(input.locationPermission, PERMISSION_SETTINGS, d.locationPermission),
    notificationPermission: choice(input.notificationPermission, PERMISSION_SETTINGS, d.notificationPermission),
    showBadgeCount: flag(input.showBadgeCount, d.showBadgeCount),
    allowlist: cleanHosts(input.allowlist, LIMITS.allowlist),
    customBlocklist: cleanHosts(input.customBlocklist, LIMITS.customBlocklist),
  };
}
