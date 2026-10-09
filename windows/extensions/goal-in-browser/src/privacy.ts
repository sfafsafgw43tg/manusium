import type { Settings } from './settings.js';

/**
 * Chrome settings this extension may change. Each one is read, set and cleared only by this extension,
 * and only when this extension set it. Names follow chrome.privacy and chrome.contentSettings.
 */
export const PRIVACY_KEYS = [
  'thirdPartyCookiesAllowed',
  'webRTCIPHandlingPolicy',
  'doNotTrackEnabled',
  'referrersEnabled',
  'topicsEnabled',
  'fledgeEnabled',
  'adMeasurementEnabled',
  'hyperlinkAuditingEnabled',
  'networkPredictionEnabled',
  'alternateErrorPagesEnabled',
  'searchSuggestEnabled',
  'translationServiceEnabled',
  'location',
  'notifications',
] as const;

export type PrivacyKey = (typeof PRIVACY_KEYS)[number];

export function isPrivacyKey(value: unknown): value is PrivacyKey {
  return (PRIVACY_KEYS as readonly unknown[]).includes(value);
}

/** The values this extension wants right now. Absent keys are left at Chrome's default. */
export type PrivacyTargets = Partial<Record<PrivacyKey, boolean | string>>;

/**
 * Some of these settings may only be turned off by an extension (Topics, Protected Audience and ad measurement),
 * so they are only ever set to false. Chrome's default comes back when the extension clears them.
 */
export function privacyTargets(settings: Settings): PrivacyTargets {
  if (!settings.protectionEnabled) return {};
  const targets: PrivacyTargets = {};
  if (settings.blockThirdPartyCookies) targets.thirdPartyCookiesAllowed = false;
  if (settings.webRtcPolicy !== 'default') targets.webRTCIPHandlingPolicy = settings.webRtcPolicy;
  if (settings.doNotTrack) targets.doNotTrackEnabled = true;
  if (settings.referrerPolicy === 'none') targets.referrersEnabled = false;
  if (settings.privacySandboxOff) {
    targets.topicsEnabled = false;
    targets.fledgeEnabled = false;
    targets.adMeasurementEnabled = false;
  }
  if (settings.hyperlinkAuditingOff) targets.hyperlinkAuditingEnabled = false;
  if (settings.networkPredictionOff) targets.networkPredictionEnabled = false;
  if (settings.errorSuggestionsOff) targets.alternateErrorPagesEnabled = false;
  if (settings.searchSuggestionsOff) targets.searchSuggestEnabled = false;
  if (settings.translationOff) targets.translationServiceEnabled = false;
  if (settings.locationPermission === 'block') targets.location = 'block';
  if (settings.notificationPermission === 'block') targets.notifications = 'block';
  return targets;
}

export type PrivacyAction =
  | { key: PrivacyKey; op: 'set'; value: boolean | string }
  | { key: PrivacyKey; op: 'clear' }
  | { key: PrivacyKey; op: 'skip'; reason: string };

/** levelOfControl values that mean another party controls the setting. This extension must not overwrite them. */
const LOCKED = new Set<string>(['not_controllable', 'controlled_by_other_extensions']);

/**
 * Decides what to do with each privacy setting. Pure, so it can be tested without Chrome.
 * - Wanted and not locked: set it.
 * - Not wanted but previously set by this extension: clear it (unless locked).
 * - Locked: skip it and report why. Never overwrite a setting someone else controls.
 * - Never wanted and never managed: no action. The extension does not touch what it did not set.
 */
export function planPrivacy(
  targets: PrivacyTargets,
  managed: readonly PrivacyKey[],
  levels: Partial<Record<PrivacyKey, string>>,
): PrivacyAction[] {
  const actions: PrivacyAction[] = [];
  for (const key of PRIVACY_KEYS) {
    const wanted = targets[key];
    if (wanted === undefined && !managed.includes(key)) continue;
    const level = levels[key];
    if (level !== undefined && LOCKED.has(level)) {
      actions.push({ key, op: 'skip', reason: level });
    } else if (wanted === undefined) {
      actions.push({ key, op: 'clear' });
    } else {
      actions.push({ key, op: 'set', value: wanted });
    }
  }
  return actions;
}
