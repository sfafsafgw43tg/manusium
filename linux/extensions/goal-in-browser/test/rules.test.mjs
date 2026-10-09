import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDynamicRules, planStaticRulesets, PRIORITY, STATIC_RULESETS, UNSAFE_ACTIONS } from '../dist/rules.js';
import { DEFAULT_SETTINGS, PRESETS, sanitizeSettings } from '../dist/settings.js';
import { TRACKING_PARAMS } from '../dist/tracking-params.js';
import { LIST_INFO } from '../dist/lists-info.js';

const settingsWith = (patch) => sanitizeSettings({ ...DEFAULT_SETTINGS, ...patch });
const rulesOf = (entries, feature) => entries.filter((entry) => entry.feature === feature).map((entry) => entry.rule);
/** Matches the way the extension's own regular expressions are written: case-insensitive for the upgrade rule. */
const upgradeMatches = (url) => new RegExp(rulesOf(buildDynamicRules(settingsWith({}), { siteAccess: false }), 'https')[0].condition.regexFilter, 'i').test(url);

test('protection off produces no dynamic rules, and no static ruleset may stay on', () => {
  assert.deepEqual(buildDynamicRules(settingsWith({ protectionEnabled: false, globalPrivacyControl: true }), { siteAccess: true }), []);
  const plan = planStaticRulesets(settingsWith({ protectionEnabled: false }), 300000, ['trackers', 'ads-1']);
  assert.deepEqual(plan.enable, []);
  assert.deepEqual(plan.disable, ['trackers', 'ads-1']);
});

test('defaults produce one HTTPS upgrade rule at the upgrade priority, plus ping blocking', () => {
  const entries = buildDynamicRules(settingsWith({}), { siteAccess: false });
  assert.deepEqual(entries.map((entry) => entry.feature), ['https', 'pings']);
  const [upgrade] = rulesOf(entries, 'https');
  assert.equal(upgrade.action.type, 'upgradeScheme');
  assert.equal(upgrade.priority, PRIORITY.upgrade);
  assert.deepEqual(upgrade.condition.resourceTypes, ['main_frame', 'sub_frame']);
  assert.deepEqual(upgrade.condition.excludedRequestDomains, ['localhost']);
});

test('the HTTPS upgrade rule upgrades dotted names and leaves IP addresses, IPv6 literals and single-label names alone', () => {
  for (const url of ['http://example.com/', 'http://EXAMPLE.com/a', 'http://sub.site.org/?x=1', 'http://nas.local/']) {
    assert.equal(upgradeMatches(url), true, url);
  }
  for (const url of ['http://192.168.0.1/', 'http://10.0.0.1:8080/', 'http://[2001:db8::1]/', 'http://printer/', 'https://example.com/']) {
    assert.equal(upgradeMatches(url), false, url);
  }
});

test('the HTTPS upgrade rule can be switched off on its own', () => {
  const features = buildDynamicRules(settingsWith({ httpsUpgrade: false }), { siteAccess: false }).map((entry) => entry.feature);
  assert.deepEqual(features, ['pings']);
});

test('rule IDs are unique, start at 1, and cover every rule the settings ask for', () => {
  const entries = buildDynamicRules(settingsWith({ ...PRESETS.ultra, allowlist: ['bank.example'], customBlocklist: ['ads.example.net'] }), { siteAccess: true });
  const ids = entries.map((entry) => entry.rule.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, ids.map((_, index) => index + 1));
  assert.deepEqual(
    [...new Set(entries.map((entry) => entry.feature))].sort(),
    ['allowlist', 'custom', 'gpc', 'https', 'pings', 'referrer', 'thirdPartyFrames', 'thirdPartyScripts', 'trackingParams'].sort(),
  );
});

test('allowlisted hosts get allow-all rules limited to the main frame', () => {
  const [rule] = rulesOf(buildDynamicRules(settingsWith({ allowlist: ['bank.example'] }), { siteAccess: false }), 'allowlist');
  assert.equal(rule.action.type, 'allowAllRequests');
  assert.equal(rule.priority, PRIORITY.siteAllow);
  assert.deepEqual(rule.condition.requestDomains, ['bank.example']);
  assert.deepEqual(rule.condition.resourceTypes, ['main_frame']);
});

test('custom domains block subresources only and never the page the user opens', () => {
  const [rule] = rulesOf(buildDynamicRules(settingsWith({ customBlocklist: ['ads.example.net'] }), { siteAccess: false }), 'custom');
  assert.equal(rule.action.type, 'block');
  assert.equal(rule.condition.urlFilter, '||ads.example.net^');
  assert.deepEqual(rule.condition.excludedResourceTypes, ['main_frame']);
});

test('pings and CSP reports are blocked by resource type, with no host access needed', () => {
  const [rule] = rulesOf(buildDynamicRules(settingsWith({ blockPings: true }), { siteAccess: false }), 'pings');
  assert.equal(rule.action.type, 'block');
  assert.deepEqual(rule.condition.resourceTypes, ['ping', 'csp_report']);
  assert.equal('domainType' in rule.condition, false);
});

test('third-party script and frame blocking only match requests from another site', () => {
  const entries = buildDynamicRules(settingsWith({ blockThirdPartyScripts: true, blockThirdPartyFrames: true }), { siteAccess: false });
  const [scripts] = rulesOf(entries, 'thirdPartyScripts');
  const [frames] = rulesOf(entries, 'thirdPartyFrames');
  assert.deepEqual(scripts.condition, { resourceTypes: ['script'], domainType: 'thirdParty' });
  assert.deepEqual(frames.condition, { resourceTypes: ['sub_frame'], domainType: 'thirdParty' });
  assert.equal(scripts.action.type, 'block');
});

/** Matches a urlFilter the way these tests need it: "*" is any run of characters, everything else is literal. */
function urlFilterMatches(filter, url) {
  const pattern = filter.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${pattern}$`).test(url);
}

test('tracking-parameter cleanup needs site access, and then removes the listed names on page navigations only', () => {
  const withoutAccess = buildDynamicRules(settingsWith({ stripTrackingParams: true }), { siteAccess: false });
  assert.equal(rulesOf(withoutAccess, 'trackingParams').length, 0, 'no redirect rule without site access');
  const rules = rulesOf(buildDynamicRules(settingsWith({ stripTrackingParams: true }), { siteAccess: true }), 'trackingParams');
  assert.equal(rules.length, TRACKING_PARAMS.length * 2, 'one rule for each name after "?" and after "&"');
  for (const rule of rules) {
    assert.equal(rule.action.type, 'redirect');
    assert.equal(rule.priority, PRIORITY.redirect);
    assert.deepEqual(rule.action.redirect.transform.queryTransform.removeParams, [...TRACKING_PARAMS]);
    assert.deepEqual(rule.condition.resourceTypes, ['main_frame']);
    assert.equal(rule.condition.isUrlFilterCaseSensitive, true);
    assert.equal('regexFilter' in rule.condition, false, 'no regular expression, so the 2 KB compiled limit does not apply');
  }
  const matches = (url) => rules.some((rule) => urlFilterMatches(rule.condition.urlFilter, url));
  for (const url of ['https://a.example/?utm_source=x', 'https://a.example/?q=1&fbclid=abc', 'https://a.example/?gclid=1', 'https://a.example/?a=1&utm_content=2']) {
    assert.equal(matches(url), true, url);
  }
  for (const url of ['https://a.example/?UTM_SOURCE=x', 'https://a.example/?my_utm_source=1', 'https://a.example/?utm_sourcex=1', 'https://a.example/?q=utm_source', 'https://a.example/path/utm_source=1']) {
    assert.equal(matches(url), false, url);
  }
});

test('every tracking name is in the removal list, and no name is listed twice', () => {
  assert.equal(new Set(TRACKING_PARAMS).size, TRACKING_PARAMS.length);
  for (const name of TRACKING_PARAMS) assert.match(name, /^[a-z_]+$/, name);
});

test('the Sec-GPC rule needs both the setting and site access, and sends only Sec-GPC: 1', () => {
  assert.equal(rulesOf(buildDynamicRules(settingsWith({ globalPrivacyControl: true }), { siteAccess: false }), 'gpc').length, 0);
  assert.equal(rulesOf(buildDynamicRules(settingsWith({}), { siteAccess: true }), 'gpc').length, 0);
  const [rule] = rulesOf(buildDynamicRules(settingsWith({ globalPrivacyControl: true }), { siteAccess: true }), 'gpc');
  assert.equal(rule.action.type, 'modifyHeaders');
  assert.deepEqual(rule.action.requestHeaders, [{ header: 'Sec-GPC', operation: 'set', value: '1' }]);
  assert.equal(rule.action.responseHeaders, undefined);
  assert.equal(rule.priority, PRIORITY.headers);
  assert.ok(rule.condition.resourceTypes.includes('main_frame'));
  assert.ok(rule.condition.resourceTypes.includes('webtransport'));
});

test('the referrer limit sets Referrer-Policy only where the page sends none, and needs site access', () => {
  assert.equal(rulesOf(buildDynamicRules(settingsWith({ referrerPolicy: 'origin' }), { siteAccess: false }), 'referrer').length, 0);
  assert.equal(rulesOf(buildDynamicRules(settingsWith({ referrerPolicy: 'none' }), { siteAccess: true }), 'referrer').length, 0, 'the native setting is not a header rule');
  const [rule] = rulesOf(buildDynamicRules(settingsWith({ referrerPolicy: 'origin' }), { siteAccess: true }), 'referrer');
  assert.deepEqual(rule.action.responseHeaders, [{ header: 'Referrer-Policy', operation: 'set', value: 'strict-origin' }]);
  assert.deepEqual(rule.condition.excludedResponseHeaders, [{ header: 'Referrer-Policy' }]);
});

test('only redirect and modifyHeaders count as unsafe, and those are the only features that can fail on their own', () => {
  assert.deepEqual([...UNSAFE_ACTIONS].sort(), ['modifyHeaders', 'redirect']);
  const entries = buildDynamicRules(settingsWith({ ...PRESETS.strict }), { siteAccess: true });
  for (const entry of entries) {
    const unsafe = UNSAFE_ACTIONS.has(entry.rule.action.type);
    assert.equal(unsafe, ['trackingParams', 'gpc', 'referrer'].includes(entry.feature), entry.feature);
  }
});

test('planStaticRulesets enables the wanted rulesets that fit and reports the rest', () => {
  const plan = planStaticRulesets(settingsWith({}), 300000, []);
  assert.deepEqual(plan.enable, ['trackers', 'fingerprinting', ...LIST_INFO.adRulesets.map((set) => set.id)]);
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(plan.disable, []);
});

test('planStaticRulesets keeps rulesets that are already on without spending budget on them', () => {
  const plan = planStaticRulesets(settingsWith({}), 45, ['trackers', 'fingerprinting']);
  assert.deepEqual(plan.enable, []);
  assert.deepEqual(plan.included, ['trackers', 'fingerprinting']);
  assert.deepEqual(plan.skipped, LIST_INFO.adRulesets.map((set) => set.id));
});

test('when capacity is short, ads rulesets are enabled while they fit, so a smaller later one can still fit', () => {
  const plan = planStaticRulesets(settingsWith({}), 25000, []);
  // 25000 free: trackers (42) and fingerprinting (3), then ads-1 and ads-2 (10000 each). ads-3 to ads-7 do not fit
  // in the 4955 left. ads-8 (2525) does.
  assert.deepEqual(plan.enable, ['trackers', 'fingerprinting', 'ads-1', 'ads-2', 'ads-8']);
  assert.deepEqual(plan.skipped, ['ads-3', 'ads-4', 'ads-5', 'ads-6', 'ads-7']);
});

test('the reserve for rules already on is subtracted from the budget on a retry', () => {
  // 10042 free: trackers (already on) + fingerprinting (3) leave 10039, enough for ads-1 (10000).
  const withoutReserve = planStaticRulesets(settingsWith({}), 10042, ['trackers']);
  assert.ok(withoutReserve.included.includes('ads-1'));
  // Reserving the 42 rules already on leaves 10000 minus 3, which is not enough for ads-1.
  const withReserve = planStaticRulesets(settingsWith({}), 10042, ['trackers'], 42);
  assert.equal(withReserve.included.includes('ads-1'), false);
  assert.ok(withReserve.included.includes('trackers'), 'a ruleset already on is kept');
});

test('turning the ads list off disables only the ads rulesets and keeps the others', () => {
  const plan = planStaticRulesets(settingsWith({ adList: false }), 300000, ['trackers', 'fingerprinting', 'ads-1']);
  assert.deepEqual(plan.disable, ['ads-1']);
  assert.deepEqual(plan.enable, []);
  assert.deepEqual(plan.included, ['trackers', 'fingerprinting']);
});

test('the bundled static rulesets are in the expected order and carry the build counts', () => {
  assert.deepEqual(STATIC_RULESETS.map((set) => set.id), ['trackers', 'fingerprinting', ...LIST_INFO.adRulesets.map((set) => set.id)]);
  assert.equal(LIST_INFO.adRulesets.reduce((sum, set) => sum + set.rules, 0), LIST_INFO.adDomains);
  assert.equal(LIST_INFO.adDomains, 72525);
  assert.equal(LIST_INFO.trackerRules, 42);
  assert.equal(LIST_INFO.fingerprintRules, 3);
});
