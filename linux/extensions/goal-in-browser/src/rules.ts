import { LIST_INFO } from './lists-info.js';
import type { Settings } from './settings.js';
import { TRACKING_PARAMS } from './tracking-params.js';

/**
 * Chrome picks the rule with the highest priority. At equal priority it prefers block, then upgradeScheme, then redirect
 * (chrome.declarativeNetRequest reference, "Rule evaluation").
 * allowAllRequests sits above every blocking, redirect and upgrade rule, so an allowlisted page is left alone.
 * Chrome applies a modifyHeaders rule only when it outranks every matching allow rule, so header rules sit above
 * allowAllRequests and Sec-GPC and Referrer-Policy still apply on allowlisted sites.
 */
export const PRIORITY = { blocking: 1, redirect: 1, upgrade: 1, customBlock: 2, siteAllow: 3, headers: 4 } as const;

/** Each dynamic rule belongs to one feature, so the status report can say which feature failed. */
export type Feature =
  | 'https'
  | 'custom'
  | 'allowlist'
  | 'pings'
  | 'thirdPartyScripts'
  | 'thirdPartyFrames'
  | 'trackingParams'
  | 'gpc'
  | 'referrer';

export interface DynamicEntry {
  feature: Feature;
  rule: chrome.declarativeNetRequest.Rule;
}

export interface StaticRuleset {
  id: string;
  rules: number;
  setting: 'adList' | 'trackerList' | 'fingerprintList';
}

/** Every bundled static ruleset, in the order they are enabled. Counts come from the build. */
export const STATIC_RULESETS: readonly StaticRuleset[] = [
  { id: 'trackers', rules: LIST_INFO.trackerRules, setting: 'trackerList' },
  { id: 'fingerprinting', rules: LIST_INFO.fingerprintRules, setting: 'fingerprintList' },
  ...LIST_INFO.adRulesets.map((set) => ({ id: set.id, rules: set.rules, setting: 'adList' as const })),
];

/**
 * Upgrades only http URLs whose host is a dotted name ending in a letter-led label, such as example.com.
 * IPv4 addresses, IPv6 literals ("[...]"), and single-label names (printer, nas) stay on http. Most local devices
 * serve no https, so upgrading them would break them.
 */
const UPGRADE_REGEX = '^http://[^/?#:\\[]*\\.[a-z]';

/** Every resource type a header rule must name. The main frame is excluded by default, so it is listed explicitly. */
const HEADER_RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other',
] as const;

/** Rules that Chrome counts as unsafe. They need host access and have their own limit. */
export const UNSAFE_ACTIONS: ReadonlySet<string> = new Set(['redirect', 'modifyHeaders']);

export interface StaticPlan {
  /** Rulesets to switch on now. */
  enable: string[];
  /** Rulesets of ours that are on and must go off. */
  disable: string[];
  /** Rulesets that should be on once the change applies (already on, or newly enabled). */
  included: string[];
  /** Wanted rulesets that do not fit in the budget. */
  skipped: string[];
}

/**
 * Chooses which static rulesets to enable. `available` is what Chrome reports as still free, and `enabled` is what is
 * on now. Rulesets that are already on are kept. Others are added while they fit. `reserved` is a fallback for
 * Chrome versions that count the rules already on against the same budget.
 */
export function planStaticRulesets(
  settings: Pick<Settings, 'protectionEnabled' | 'adList' | 'trackerList' | 'fingerprintList'>,
  available: number,
  enabled: readonly string[],
  reserved = 0,
): StaticPlan {
  const wanted = STATIC_RULESETS.filter((set) => settings.protectionEnabled && settings[set.setting]);
  let budget = available - reserved;
  const included: string[] = [];
  const skipped: string[] = [];
  for (const set of wanted) {
    if (enabled.includes(set.id)) {
      included.push(set.id);
    } else if (set.rules <= budget) {
      budget -= set.rules;
      included.push(set.id);
    } else {
      skipped.push(set.id);
    }
  }
  return {
    enable: included.filter((id) => !enabled.includes(id)),
    disable: STATIC_RULESETS.map((set) => set.id).filter((id) => enabled.includes(id) && !included.includes(id)),
    included,
    skipped,
  };
}

/**
 * Every dynamic rule this extension owns, as a pure function of the settings. Empty when protection is off.
 * siteAccess says whether the optional all-sites permission is granted. Header and redirect rules need it.
 * Rule IDs run from 1 to n. The applier removes all existing dynamic rules first, so IDs never collide.
 */
export function buildDynamicRules(settings: Settings, options: { siteAccess: boolean }): DynamicEntry[] {
  if (!settings.protectionEnabled) return [];
  const pending: Array<{ feature: Feature; rule: Omit<chrome.declarativeNetRequest.Rule, 'id'> }> = [];
  const add = (feature: Feature, rule: Omit<chrome.declarativeNetRequest.Rule, 'id'>): void => {
    pending.push({ feature, rule });
  };

  if (settings.httpsUpgrade) {
    add('https', {
      priority: PRIORITY.upgrade,
      action: { type: 'upgradeScheme' },
      condition: {
        regexFilter: UPGRADE_REGEX,
        isUrlFilterCaseSensitive: false,
        resourceTypes: ['main_frame', 'sub_frame'],
        excludedRequestDomains: ['localhost'],
      },
    });
  }
  for (const host of settings.customBlocklist) {
    add('custom', {
      priority: PRIORITY.customBlock,
      action: { type: 'block' },
      condition: { urlFilter: `||${host}^`, excludedResourceTypes: ['main_frame'] },
    });
  }
  for (const host of settings.allowlist) {
    // Main frame only: an embedded copy of an allowlisted site on another page stays subject to the lists.
    add('allowlist', {
      priority: PRIORITY.siteAllow,
      action: { type: 'allowAllRequests' },
      condition: { requestDomains: [host], resourceTypes: ['main_frame'] },
    });
  }
  if (settings.blockPings) {
    add('pings', {
      priority: PRIORITY.blocking,
      action: { type: 'block' },
      condition: { resourceTypes: ['ping', 'csp_report'] },
    });
  }
  if (settings.blockThirdPartyScripts) {
    add('thirdPartyScripts', {
      priority: PRIORITY.blocking,
      action: { type: 'block' },
      condition: { resourceTypes: ['script'], domainType: 'thirdParty' },
    });
  }
  if (settings.blockThirdPartyFrames) {
    add('thirdPartyFrames', {
      priority: PRIORITY.blocking,
      action: { type: 'block' },
      condition: { resourceTypes: ['sub_frame'], domainType: 'thirdParty' },
    });
  }
  if (options.siteAccess && settings.stripTrackingParams) {
    // One plain urlFilter per name and separator. A single regex listing every name would exceed Chrome's 2 KB limit
    // for compiled regular expressions, and Chrome then rejects the whole dynamic update. Every rule removes the whole
    // list, so a URL with several tracking parameters is rewritten in one redirect.
    const transform = { queryTransform: { removeParams: [...TRACKING_PARAMS] } };
    for (const name of TRACKING_PARAMS) {
      for (const separator of ['?', '&'] as const) {
        add('trackingParams', {
          priority: PRIORITY.redirect,
          action: { type: 'redirect', redirect: { transform } },
          condition: {
            urlFilter: `*${separator}${name}=*`,
            isUrlFilterCaseSensitive: true,
            resourceTypes: ['main_frame'],
            requestMethods: ['get'],
          },
        });
      }
    }
  }
  if (options.siteAccess && settings.globalPrivacyControl) {
    add('gpc', {
      priority: PRIORITY.headers,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Sec-GPC', operation: 'set', value: '1' }] },
      condition: { urlFilter: '|http', resourceTypes: [...HEADER_RESOURCE_TYPES] },
    });
  }
  if (options.siteAccess && settings.referrerPolicy === 'origin') {
    // Only where the page sends no policy of its own. A page's own Referrer-Policy header is left alone.
    add('referrer', {
      priority: PRIORITY.headers,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [{ header: 'Referrer-Policy', operation: 'set', value: 'strict-origin' }],
      },
      condition: {
        urlFilter: '|http',
        resourceTypes: ['main_frame', 'sub_frame'],
        excludedResponseHeaders: [{ header: 'Referrer-Policy' }],
      },
    });
  }
  return pending.map(({ feature, rule }, index) => ({ feature, rule: { id: index + 1, ...rule } }));
}
