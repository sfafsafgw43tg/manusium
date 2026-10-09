import { attempt, invoke } from './chrome-call.js';
import { LIST_INFO } from './lists-info.js';
import { PRIVACY_KEYS, planPrivacy, privacyTargets, type PrivacyAction, type PrivacyKey } from './privacy.js';
import {
  buildDynamicRules,
  planStaticRulesets,
  STATIC_RULESETS,
  UNSAFE_ACTIONS,
  type DynamicEntry,
  type Feature,
  type StaticPlan,
} from './rules.js';
import type { Settings } from './settings.js';

export type ItemState = 'on' | 'partial' | 'off' | 'skipped' | 'error';

/** One line of the status report. It is stored locally and shown in the popup and in Settings. */
export interface StatusItem {
  id: string;
  label: string;
  state: ItemState;
  detail: string;
}

export interface ApplyResult {
  /** Privacy keys this extension still owns and must clear later. */
  managed: PrivacyKey[];
  report: StatusItem[];
}

interface Handler {
  read?: () => Promise<string>;
  set: (value: boolean | string) => Promise<void>;
  clear: () => Promise<void>;
}

function settingHandler(pick: () => chrome.types.ChromeSetting<boolean | string>): Handler {
  return {
    read: async () => (await invoke<{ levelOfControl: string }>((done) => pick().get({}, done))).levelOfControl,
    set: (value) => invoke<void>((done) => pick().set({ value, scope: 'regular' }, () => done())),
    clear: () => invoke<void>((done) => pick().clear({ scope: 'regular' }, () => done())),
  };
}

/** The content settings this extension sets only ever block for every site, so set() takes no value. */
const BLOCK_LOCATION: Handler = {
  set: () =>
    invoke<void>((done) => chrome.contentSettings.location.set({ primaryPattern: '<all_urls>', setting: 'block' }, () => done())),
  clear: () => invoke<void>((done) => chrome.contentSettings.location.clear({}, () => done())),
};

const BLOCK_NOTIFICATIONS: Handler = {
  set: () =>
    invoke<void>((done) =>
      chrome.contentSettings.notifications.set({ primaryPattern: '<all_urls>', setting: 'block' }, () => done()),
    ),
  clear: () => invoke<void>((done) => chrome.contentSettings.notifications.clear({}, () => done())),
};

const HANDLERS: Record<PrivacyKey, Handler> = {
  thirdPartyCookiesAllowed: settingHandler(() => chrome.privacy.websites.thirdPartyCookiesAllowed),
  webRTCIPHandlingPolicy: settingHandler(() => chrome.privacy.network.webRTCIPHandlingPolicy),
  doNotTrackEnabled: settingHandler(() => chrome.privacy.websites.doNotTrackEnabled),
  referrersEnabled: settingHandler(() => chrome.privacy.websites.referrersEnabled),
  topicsEnabled: settingHandler(() => chrome.privacy.websites.topicsEnabled),
  fledgeEnabled: settingHandler(() => chrome.privacy.websites.fledgeEnabled),
  adMeasurementEnabled: settingHandler(() => chrome.privacy.websites.adMeasurementEnabled),
  hyperlinkAuditingEnabled: settingHandler(() => chrome.privacy.websites.hyperlinkAuditingEnabled),
  networkPredictionEnabled: settingHandler(() => chrome.privacy.network.networkPredictionEnabled),
  alternateErrorPagesEnabled: settingHandler(() => chrome.privacy.services.alternateErrorPagesEnabled),
  searchSuggestEnabled: settingHandler(() => chrome.privacy.services.searchSuggestEnabled),
  translationServiceEnabled: settingHandler(() => chrome.privacy.services.translationServiceEnabled),
  location: BLOCK_LOCATION,
  notifications: BLOCK_NOTIFICATIONS,
};

const LEVEL_TEXT: Readonly<Record<string, string>> = {
  controlled_by_other_extensions: 'another extension controls this setting',
  not_controllable: 'Chrome or a policy controls this setting',
};

async function readLevels(): Promise<Partial<Record<PrivacyKey, string>>> {
  const levels: Partial<Record<PrivacyKey, string>> = {};
  for (const key of PRIVACY_KEYS) {
    const read = HANDLERS[key].read;
    if (!read) continue;
    try {
      levels[key] = await read();
    } catch {
      // Unreadable is treated as controllable. A real failure shows up in the set or clear call.
    }
  }
  return levels;
}

function runAction(action: Exclude<PrivacyAction, { op: 'skip' }>): Promise<void> {
  const handler = HANDLERS[action.key];
  return action.op === 'set' ? handler.set(action.value) : handler.clear();
}

interface PrivacyOutcome {
  managed: PrivacyKey[];
  outcome: Map<PrivacyKey, string>;
}

async function applyPrivacy(settings: Settings, previouslyManaged: readonly PrivacyKey[]): Promise<PrivacyOutcome> {
  const actions = planPrivacy(privacyTargets(settings), previouslyManaged, await readLevels());
  const outcome = new Map<PrivacyKey, string>();
  for (const action of actions) {
    if (action.op === 'skip') {
      outcome.set(action.key, `skipped:${action.reason}`);
      continue;
    }
    const error = await attempt(() => runAction(action));
    outcome.set(action.key, error ? `error:${error}` : action.op === 'set' ? 'set' : 'cleared');
  }
  // Ownership is kept for a setting this extension set, and for any failed change to a setting it already owned,
  // so the next run can still clear it. A setting that is now locked by someone else is released.
  const managed = actions.flatMap((action) => {
    if (action.op === 'skip') return [];
    const result = outcome.get(action.key) ?? '';
    const failed = result.startsWith('error:');
    if (action.op === 'set') return result === 'set' || (failed && previouslyManaged.includes(action.key)) ? [action.key] : [];
    return failed ? [action.key] : [];
  });
  return { managed, outcome };
}

interface StaticOutcome {
  error: string | null;
  /** Rulesets of this extension that are on after the update. */
  included: string[];
  skipped: string[];
}

function setEnabledRulesets(plan: StaticPlan): Promise<void> {
  if (plan.enable.length === 0 && plan.disable.length === 0) return Promise.resolve();
  return invoke<void>((done) =>
    chrome.declarativeNetRequest.updateEnabledRulesets(
      { enableRulesetIds: plan.enable, disableRulesetIds: plan.disable },
      () => done(),
    ),
  );
}

/**
 * Enables the static rulesets that fit. The first attempt assumes Chrome's reported capacity is free. If Chrome
 * refuses, the second attempt also reserves the rules already on. A rejected update changes nothing.
 */
async function applyStatic(settings: Settings): Promise<StaticOutcome> {
  try {
    const enabled = await invoke<string[]>((done) => chrome.declarativeNetRequest.getEnabledRulesets(done));
    const available = await invoke<number>((done) => chrome.declarativeNetRequest.getAvailableStaticRuleCount(done));
    const first = planStaticRulesets(settings, available, enabled);
    const error = await attempt(() => setEnabledRulesets(first));
    if (!error) return { error: null, included: first.included, skipped: first.skipped };
    const reserved = enabled.reduce((sum, id) => sum + (STATIC_RULESETS.find((set) => set.id === id)?.rules ?? 0), 0);
    if (reserved > 0) {
      const second = planStaticRulesets(settings, available, enabled, reserved);
      if (!(await attempt(() => setEnabledRulesets(second)))) {
        return { error: null, included: second.included, skipped: second.skipped };
      }
    }
    const ours = enabled.filter((id) => STATIC_RULESETS.some((set) => set.id === id));
    return { error, included: ours, skipped: first.skipped };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), included: [], skipped: [] };
  }
}

/** Replaces every dynamic rule. This extension owns all of them, so the whole set is swapped at once. */
async function replaceDynamicRules(entries: DynamicEntry[]): Promise<string | null> {
  return attempt(async () => {
    const existing = await invoke<chrome.declarativeNetRequest.Rule[]>((done) =>
      chrome.declarativeNetRequest.getDynamicRules(done),
    );
    await invoke<void>((done) =>
      chrome.declarativeNetRequest.updateDynamicRules(
        { removeRuleIds: existing.map((rule) => rule.id), addRules: entries.map((entry) => entry.rule) },
        () => done(),
      ),
    );
  });
}

interface DynamicOutcome {
  error: string | null;
  failed: Set<Feature>;
}

async function applyDynamic(entries: DynamicEntry[]): Promise<DynamicOutcome> {
  const error = await replaceDynamicRules(entries);
  if (!error) return { error: null, failed: new Set() };
  const everything = new Set(entries.map((entry) => entry.feature));
  const safe = entries.filter((entry) => !UNSAFE_ACTIONS.has(entry.rule.action.type));
  if (safe.length === entries.length) return { error, failed: everything };
  // Chrome rejects the whole update when one rule is invalid. Retry with the safe rules so blocking still applies.
  if (await replaceDynamicRules(safe)) return { error, failed: everything };
  return { error, failed: new Set(entries.filter((entry) => UNSAFE_ACTIONS.has(entry.rule.action.type)).map((entry) => entry.feature)) };
}

interface Context {
  settings: Settings;
  siteAccess: boolean;
  statics: StaticOutcome;
  dynamic: DynamicOutcome;
  privacy: Map<PrivacyKey, string>;
  badgeError: string | null;
}

const NOT_ENABLED = "Not enabled. The browser's shared static rule limit is full, often because other extensions use it.";
const ACCESS_HINT = 'Needs access to all sites, which is not granted. Turn the option off and on in Settings to ask again.';

const off = (id: string, label: string): StatusItem => ({ id, label, state: 'off', detail: 'Off' });
const fail = (id: string, label: string, detail: string): StatusItem => ({ id, label, state: 'error', detail });
const fmt = (count: number): string => count.toLocaleString('en-US');

function curatedItem(ctx: Context, id: string, label: string, setting: 'trackerList' | 'fingerprintList', text: string): StatusItem {
  if (!ctx.settings.protectionEnabled || !ctx.settings[setting]) return off(id, label);
  if (ctx.statics.error) return fail(id, label, ctx.statics.error);
  return ctx.statics.included.includes(id)
    ? { id, label, state: 'on', detail: text }
    : fail(id, label, NOT_ENABLED);
}

function adsItem(ctx: Context): StatusItem {
  const id = 'ads';
  const label = 'Ads and malware domains';
  if (!ctx.settings.protectionEnabled || !ctx.settings.adList) return off(id, label);
  if (ctx.statics.error) return fail(id, label, ctx.statics.error);
  const sets = LIST_INFO.adRulesets;
  const got = sets.filter((set) => ctx.statics.included.includes(set.id));
  const summary = `${fmt(LIST_INFO.adDomains)} domains in ${sets.length} rulesets (${LIST_INFO.upstream.repo}, ${LIST_INFO.upstream.license})`;
  if (got.length === sets.length) return { id, label, state: 'on', detail: summary };
  const gotDomains = got.reduce((sum, set) => sum + set.rules, 0);
  if (got.length > 0) {
    return {
      id,
      label,
      state: 'partial',
      detail: `${fmt(gotDomains)} of ${fmt(LIST_INFO.adDomains)} domains are on. ${NOT_ENABLED}`,
    };
  }
  return fail(id, label, NOT_ENABLED);
}

function ruleItem(ctx: Context, id: string, label: string, feature: Feature, active: boolean, text: string): StatusItem {
  if (!active) return off(id, label);
  if (ctx.dynamic.failed.has(feature)) return fail(id, label, ctx.dynamic.error ?? 'Chrome rejected the rule update.');
  return { id, label, state: 'on', detail: text };
}

/** A rule feature that needs the all-sites permission. Without it, the feature is reported as skipped. */
function accessItem(ctx: Context, id: string, label: string, feature: Feature, active: boolean, text: string): StatusItem {
  if (!active) return off(id, label);
  if (!ctx.siteAccess) return { id, label, state: 'skipped', detail: ACCESS_HINT };
  return ruleItem(ctx, id, label, feature, active, text);
}

const resultsOf = (keys: readonly PrivacyKey[], ctx: Context): Array<{ key: PrivacyKey; result: string }> =>
  keys.map((key) => ({ key, result: ctx.privacy.get(key) ?? '' }));

/** One status line for one or more Chrome settings. The worst result wins: error, then skipped, then on. */
function privacyItem(ctx: Context, id: string, label: string, keys: readonly PrivacyKey[], wanted: boolean, text: string): StatusItem {
  if (!wanted) return off(id, label);
  const results = resultsOf(keys, ctx);
  const errored = results.find((item) => item.result.startsWith('error:'));
  if (errored) return fail(id, label, errored.result.slice('error:'.length));
  const skipped = results.find((item) => item.result.startsWith('skipped:'));
  if (skipped) {
    const level = skipped.result.slice('skipped:'.length);
    return { id, label, state: 'skipped', detail: `Not changed: ${LEVEL_TEXT[level] ?? level}` };
  }
  if (results.every((item) => item.result === 'set')) return { id, label, state: 'on', detail: text };
  return fail(id, label, 'This setting was not applied.');
}

function buildReport(ctx: Context): StatusItem[] {
  const s = ctx.settings;
  const on = s.protectionEnabled;
  const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;
  const badgeWanted = on && s.showBadgeCount;
  const referrer =
    s.referrerPolicy === 'origin'
      ? accessItem(ctx, 'referrer', 'Referrer policy', 'referrer', on, 'Origin only (strict-origin) for pages that set no policy of their own')
      : privacyItem(ctx, 'referrer', 'Referrer policy', ['referrersEnabled'], on && s.referrerPolicy === 'none', 'Referrer headers are turned off (may break sites)');

  return [
    on
      ? { id: 'protection', label: 'Protection', state: 'on', detail: 'Rules and Chrome settings are active' }
      : { id: 'protection', label: 'Protection', state: 'off', detail: 'Off. Settings this extension changed are being reverted' },
    adsItem(ctx),
    curatedItem(ctx, 'trackers', 'Tracker domains', 'trackerList', `${count(LIST_INFO.trackerRules, 'curated rule')}, shipped with this extension`),
    curatedItem(ctx, 'fingerprinting', 'Fingerprinting scripts', 'fingerprintList', `${count(LIST_INFO.fingerprintRules, 'curated rule')}, shipped with this extension`),
    ruleItem(ctx, 'https', 'HTTPS upgrade', 'https', on && s.httpsUpgrade, 'http:// pages load over https://. IP addresses and localhost are not upgraded'),
    ruleItem(ctx, 'pings', 'Ping and CSP-report blocking', 'pings', on && s.blockPings, 'Blocks link pings and CSP violation reports'),
    ruleItem(ctx, 'thirdScripts', 'Third-party scripts', 'thirdPartyScripts', on && s.blockThirdPartyScripts, 'Blocks scripts from other sites. Many sites break; use the allowlist'),
    ruleItem(ctx, 'thirdFrames', 'Third-party frames', 'thirdPartyFrames', on && s.blockThirdPartyFrames, 'Blocks embedded frames from other sites'),
    accessItem(ctx, 'params', 'Tracking-link cleanup', 'trackingParams', on && s.stripTrackingParams, 'Removes click and campaign identifiers from page addresses'),
    ruleItem(ctx, 'allowlist', 'Site allowlist', 'allowlist', on && s.allowlist.length > 0, `${count(s.allowlist.length, 'site')} excluded from blocking, the HTTPS upgrade and tracking-link cleanup`),
    ruleItem(ctx, 'custom', 'Custom blocked domains', 'custom', on && s.customBlocklist.length > 0, `${count(s.customBlocklist.length, 'domain')} blocked on other sites`),
    accessItem(ctx, 'gpc', 'Global Privacy Control header', 'gpc', on && s.globalPrivacyControl, 'Sends Sec-GPC: 1 (header only; sites must choose to honour it)'),
    referrer,
    privacyItem(ctx, 'dnt', 'Do Not Track header', ['doNotTrackEnabled'], on && s.doNotTrack, 'Sends DNT: 1 (many sites ignore it)'),
    privacyItem(ctx, 'cookies', 'Third-party cookies', ['thirdPartyCookiesAllowed'], on && s.blockThirdPartyCookies, 'Blocked (sites with exceptions may still get them)'),
    privacyItem(ctx, 'webrtc', 'WebRTC IP handling', ['webRTCIPHandlingPolicy'], on && s.webRtcPolicy !== 'default', `Policy: ${s.webRtcPolicy}`),
    privacyItem(ctx, 'sandbox', 'Privacy Sandbox ad APIs', ['topicsEnabled', 'fledgeEnabled', 'adMeasurementEnabled'], on && s.privacySandboxOff, 'Topics, Protected Audience and ad measurement are off'),
    privacyItem(ctx, 'hyperlinks', 'Hyperlink auditing', ['hyperlinkAuditingEnabled'], on && s.hyperlinkAuditingOff, 'Link ping requests are off'),
    privacyItem(ctx, 'errorpages', 'Error-page web suggestions', ['alternateErrorPagesEnabled'], on && s.errorSuggestionsOff, 'Error pages do not call Google web services'),
    privacyItem(ctx, 'search', 'Search suggestions', ['searchSuggestEnabled'], on && s.searchSuggestionsOff, 'Typing in the address bar is not sent for suggestions'),
    privacyItem(ctx, 'translate', 'Translation service', ['translationServiceEnabled'], on && s.translationOff, 'Pages are not sent to the translation service'),
    privacyItem(ctx, 'prediction', 'Network prediction', ['networkPredictionEnabled'], on && s.networkPredictionOff, 'Chrome does not pre-connect to predicted sites'),
    privacyItem(ctx, 'location', 'Location permission', ['location'], on && s.locationPermission === 'block', 'Blocked for all sites (per-site exceptions unverified, see README)'),
    privacyItem(ctx, 'notifications', 'Notification permission', ['notifications'], on && s.notificationPermission === 'block', 'Blocked for all sites (per-site exceptions unverified, see README)'),
    on && s.clearOnStart
      ? { id: 'clear', label: 'Clear site data at start', state: 'on', detail: 'Runs when the browser starts: cookies and site data for normal websites are removed. Installed web apps are not included' }
      : off('clear', 'Clear site data at start'),
    !badgeWanted
      ? off('badge', 'Toolbar count')
      : ctx.badgeError
        ? fail('badge', 'Toolbar count', ctx.badgeError)
        : { id: 'badge', label: 'Toolbar count', state: 'on', detail: 'Shows how many requests were matched on the current tab' },
  ];
}

/**
 * Pushes settings into Chrome: static rulesets, dynamic rules, privacy settings, and the toolbar badge.
 * Each part reports its own error, so a failure in one part does not hide the others.
 */
export async function applyAll(settings: Settings, previouslyManaged: readonly PrivacyKey[], siteAccess: boolean): Promise<ApplyResult> {
  const statics = await applyStatic(settings);
  const dynamic = await applyDynamic(buildDynamicRules(settings, { siteAccess }));
  const privacy = await applyPrivacy(settings, previouslyManaged);
  const badgeError = await attempt(() =>
    invoke<void>((done) =>
      chrome.declarativeNetRequest.setExtensionActionOptions(
        { displayActionCountAsBadgeText: settings.protectionEnabled && settings.showBadgeCount },
        () => done(),
      ),
    ),
  );
  const report = buildReport({ settings, siteAccess, statics, dynamic, privacy: privacy.outcome, badgeError });
  return { managed: privacy.managed, report };
}
