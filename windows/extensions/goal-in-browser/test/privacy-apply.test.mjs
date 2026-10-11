import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { planPrivacy, privacyTargets } from '../dist/privacy.js';
import { applyAll } from '../dist/apply.js';
import { DEFAULT_SETTINGS, PRESETS, sanitizeSettings } from '../dist/settings.js';
import { TRACKING_PARAMS } from '../dist/tracking-params.js';
import { installFakeChrome, uninstallFakeChrome } from './helpers/fake-chrome.mjs';

const settingsWith = (patch) => sanitizeSettings({ ...DEFAULT_SETTINGS, ...patch });
const statusOf = (report, id) => report.find((item) => item.id === id);

beforeEach(() => uninstallFakeChrome());

test('planPrivacy never clears a setting this extension did not set', () => {
  assert.deepEqual(planPrivacy({}, [], {}), []);
  assert.deepEqual(planPrivacy({ doNotTrackEnabled: false }, [], {}).map((a) => a.op), ['set'], 'a wanted value is set, not cleared');
});

test('planPrivacy clears only managed settings that are no longer wanted', () => {
  assert.deepEqual(planPrivacy({}, ['thirdPartyCookiesAllowed'], {}), [{ key: 'thirdPartyCookiesAllowed', op: 'clear' }]);
});

test('planPrivacy never overwrites a setting another party controls, and says why', () => {
  const plan = planPrivacy({ thirdPartyCookiesAllowed: false }, [], { thirdPartyCookiesAllowed: 'controlled_by_other_extensions' });
  assert.deepEqual(plan, [{ key: 'thirdPartyCookiesAllowed', op: 'skip', reason: 'controlled_by_other_extensions' }]);
});

test('planPrivacy skips a managed setting that is now locked instead of clearing it', () => {
  const plan = planPrivacy({}, ['webRTCIPHandlingPolicy'], { webRTCIPHandlingPolicy: 'not_controllable' });
  assert.deepEqual(plan, [{ key: 'webRTCIPHandlingPolicy', op: 'skip', reason: 'not_controllable' }]);
});

test('planPrivacy sets settings that are controllable by this extension', () => {
  const plan = planPrivacy({ webRTCIPHandlingPolicy: 'disable_non_proxied_udp' }, [], { webRTCIPHandlingPolicy: 'controllable_by_this_extension' });
  assert.deepEqual(plan, [{ key: 'webRTCIPHandlingPolicy', op: 'set', value: 'disable_non_proxied_udp' }]);
});

test('Standard asks for the cookie, WebRTC, Privacy Sandbox, auditing, error-page and notification settings and nothing else', () => {
  assert.deepEqual(privacyTargets(settingsWith({})), {
    thirdPartyCookiesAllowed: false,
    webRTCIPHandlingPolicy: 'default_public_interface_only',
    topicsEnabled: false,
    fledgeEnabled: false,
    adMeasurementEnabled: false,
    hyperlinkAuditingEnabled: false,
    alternateErrorPagesEnabled: false,
    notifications: 'block',
  });
});

test('privacyTargets is empty when protection is off', () => {
  assert.deepEqual(privacyTargets(settingsWith({ protectionEnabled: false, doNotTrack: true, locationPermission: 'block' })), {});
});

test('Strict adds the service toggles, and the native referrer setting only for "none"', () => {
  const strict = privacyTargets(settingsWith(PRESETS.strict));
  assert.equal(strict.networkPredictionEnabled, false);
  assert.equal(strict.searchSuggestEnabled, false);
  assert.equal(strict.translationServiceEnabled, false);
  assert.equal('referrersEnabled' in strict, false, 'origin-only is a header rule, not the native setting');
  assert.equal(privacyTargets(settingsWith({ referrerPolicy: 'none' })).referrersEnabled, false);
});

test('privacyTargets requests DNT and permission blocks only when chosen', () => {
  const targets = privacyTargets(settingsWith({ doNotTrack: true, locationPermission: 'block', notificationPermission: 'ask', webRtcPolicy: 'default' }));
  assert.equal(targets.doNotTrackEnabled, true);
  assert.equal(targets.location, 'block');
  assert.equal(targets.notifications, undefined);
  assert.equal(targets.webRTCIPHandlingPolicy, undefined, 'the Chrome default WebRTC policy is never written');
});

test('applying the defaults sets the Chrome settings and enables both curated and every ads ruleset', async () => {
  const { log } = installFakeChrome();
  const result = await applyAll(settingsWith({}), [], false);
  assert.deepEqual(log.enableCalls[0].enable, ['trackers', 'fingerprinting', 'ads-1', 'ads-2', 'ads-3', 'ads-4', 'ads-5', 'ads-6', 'ads-7', 'ads-8']);
  assert.deepEqual(log.dynamicCalls[0].added.map((rule) => rule.action.type), ['upgradeScheme', 'block'], 'the HTTPS upgrade and ping blocking');
  assert.deepEqual(log.set, [
    ['thirdPartyCookiesAllowed', false],
    ['webRTCIPHandlingPolicy', 'default_public_interface_only'],
    ['topicsEnabled', false],
    ['fledgeEnabled', false],
    ['adMeasurementEnabled', false],
    ['hyperlinkAuditingEnabled', false],
    ['alternateErrorPagesEnabled', false],
  ]);
  assert.deepEqual(log.contentCalls, [['notifications', '<all_urls>', 'block']]);
  assert.equal(log.badge, true);
  assert.deepEqual(result.managed, ['thirdPartyCookiesAllowed', 'webRTCIPHandlingPolicy', 'topicsEnabled', 'fledgeEnabled', 'adMeasurementEnabled', 'hyperlinkAuditingEnabled', 'alternateErrorPagesEnabled', 'notifications']);
  assert.equal(statusOf(result.report, 'cookies').state, 'on');
  assert.equal(statusOf(result.report, 'sandbox').state, 'on');
  assert.equal(statusOf(result.report, 'ads').state, 'on');
  assert.equal(statusOf(result.report, 'trackers').state, 'on');
  assert.equal(statusOf(result.report, 'gpc').state, 'off');
  assert.equal(statusOf(result.report, 'referrer').state, 'off');
});

test('turning protection off clears only what this extension set and touches nothing else', async () => {
  const { log } = installFakeChrome({ enabled: ['trackers', 'fingerprinting', 'ads-1'], dynamic: [{ id: 5, priority: 1, action: { type: 'block' }, condition: {} }] });
  const result = await applyAll(settingsWith({ protectionEnabled: false }), ['thirdPartyCookiesAllowed'], false);
  assert.deepEqual(log.enableCalls[0], { enable: [], disable: ['trackers', 'fingerprinting', 'ads-1'] });
  assert.deepEqual(log.dynamicCalls[0].removed, [5]);
  assert.deepEqual(log.dynamicCalls[0].added, []);
  assert.deepEqual(log.cleared, ['thirdPartyCookiesAllowed']);
  assert.deepEqual(log.set, []);
  assert.deepEqual(log.contentCalls, []);
  assert.deepEqual(result.managed, []);
  assert.equal(log.badge, false);
});

test('a setting another extension controls is reported as skipped and is not overwritten', async () => {
  const { log } = installFakeChrome({ levels: { thirdPartyCookiesAllowed: 'controlled_by_other_extensions' } });
  const result = await applyAll(settingsWith({}), [], false);
  assert.equal(log.set.some(([name]) => name === 'thirdPartyCookiesAllowed'), false);
  const cookies = statusOf(result.report, 'cookies');
  assert.equal(cookies.state, 'skipped');
  assert.match(cookies.detail, /another extension/);
  assert.equal(result.managed.includes('thirdPartyCookiesAllowed'), false);
});

test('a failed Chrome setting is reported on its own line and is not recorded as managed', async () => {
  const { log } = installFakeChrome();
  globalThis.chrome.privacy.websites.thirdPartyCookiesAllowed.set = (_details, callback) => {
    globalThis.chrome.runtime.lastError = { message: 'Setting rejected' };
    callback();
    globalThis.chrome.runtime.lastError = undefined;
  };
  const result = await applyAll(settingsWith({}), [], false);
  const cookies = statusOf(result.report, 'cookies');
  assert.equal(cookies.state, 'error');
  assert.match(cookies.detail, /Setting rejected/);
  assert.equal(result.managed.includes('thirdPartyCookiesAllowed'), false);
  assert.equal(statusOf(result.report, 'sandbox').state, 'on', 'other settings still apply');
  assert.ok(log.set.length > 0);
});

test('the privacy signal is reported as skipped until site access is granted, and no permission is requested', async () => {
  const { log } = installFakeChrome();
  const result = await applyAll(settingsWith({ globalPrivacyControl: true }), [], false);
  assert.equal(log.dynamicCalls[0].added.some((rule) => rule.action.type === 'modifyHeaders'), false);
  assert.equal(statusOf(result.report, 'gpc').state, 'skipped');
  assert.match(statusOf(result.report, 'gpc').detail, /access to all sites/);
  assert.deepEqual(log.permissionRequests, [], 'the extension never asks for permission itself');
});

test('with site access, the Sec-GPC rule is added and reported on', async () => {
  const { log } = installFakeChrome();
  const result = await applyAll(settingsWith({ globalPrivacyControl: true }), [], true);
  const header = log.dynamicCalls[0].added.find((rule) => rule.action.type === 'modifyHeaders');
  assert.ok(header, 'modifyHeaders rule present');
  assert.equal(header.priority, 4);
  assert.equal(statusOf(result.report, 'gpc').state, 'on');
});

test('Strict with site access adds the tracking-link and referrer rules; without it, both are skipped', async () => {
  const withAccess = installFakeChrome();
  const on = await applyAll(settingsWith(PRESETS.strict), [], true);
  const types = withAccess.log.dynamicCalls[0].added.map((rule) => rule.action.type);
  assert.deepEqual([...new Set(types)].sort(), ['block', 'modifyHeaders', 'redirect', 'upgradeScheme']);
  assert.equal(types.filter((type) => type === 'redirect').length, TRACKING_PARAMS.length * 2, 'tracking-link cleanup: one rule per name and separator');
  assert.equal(types.filter((type) => type === 'modifyHeaders').length, 2, 'Sec-GPC and the referrer limit');
  assert.equal(statusOf(on.report, 'params').state, 'on');
  assert.equal(statusOf(on.report, 'referrer').state, 'on');
  uninstallFakeChrome();

  installFakeChrome();
  const off = await applyAll(settingsWith(PRESETS.strict), [], false);
  assert.equal(statusOf(off.report, 'params').state, 'skipped');
  assert.equal(statusOf(off.report, 'referrer').state, 'skipped');
  assert.equal(statusOf(off.report, 'search').state, 'on', 'features that need no access still apply');
});

test('an allowlist and custom list become rules, every rule ID is unique, and the report counts them', async () => {
  const { log } = installFakeChrome({ dynamic: [{ id: 1 }] });
  const result = await applyAll(settingsWith({ allowlist: ['bank.example.org'], customBlocklist: ['ads.example.net'], globalPrivacyControl: true }), [], true);
  assert.deepEqual(log.dynamicCalls[0].removed, [1]);
  assert.deepEqual(log.dynamicCalls[0].added.map((rule) => rule.action.type), ['upgradeScheme', 'block', 'allowAllRequests', 'block', 'modifyHeaders']);
  const ids = log.dynamicCalls[0].added.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(statusOf(result.report, 'allowlist').detail, '1 site excluded from blocking, the HTTPS upgrade and tracking-link cleanup');
  assert.equal(statusOf(result.report, 'custom').detail, '1 domain blocked on other sites');
});

test('a rejected dynamic update is reported on each feature line, and the Chrome settings still apply', async () => {
  const { log } = installFakeChrome({ failDynamicWhen: (rules) => rules.some((rule) => rule.action.type === 'block') });
  const result = await applyAll(settingsWith({ customBlocklist: ['ads.example.net'] }), [], false);
  assert.equal(statusOf(result.report, 'custom').state, 'error');
  assert.match(statusOf(result.report, 'custom').detail, /rule limit reached/);
  assert.equal(statusOf(result.report, 'https').state, 'error');
  assert.equal(statusOf(result.report, 'cookies').state, 'on');
  assert.equal(log.set.length > 0, true);
});

test('a rejected Sec-GPC rule does not disable the other dynamic rules', async () => {
  const { log } = installFakeChrome({ failDynamicWhen: (rules) => rules.some((rule) => rule.action.type === 'modifyHeaders') });
  const result = await applyAll(settingsWith({ allowlist: ['bank.example.org'], globalPrivacyControl: true }), [], true);
  assert.deepEqual(log.dynamicCalls[1].added.map((rule) => rule.action.type), ['upgradeScheme', 'allowAllRequests', 'block'], 'the retry keeps the safe rules');
  assert.equal(statusOf(result.report, 'gpc').state, 'error');
  assert.match(statusOf(result.report, 'gpc').detail, /rule limit reached/);
  assert.equal(statusOf(result.report, 'https').state, 'on');
  assert.equal(statusOf(result.report, 'allowlist').state, 'on');
});

test('when capacity is short, the ads lists are partly on, and the report says how many domains', async () => {
  installFakeChrome({ available: 25000 });
  const result = await applyAll(settingsWith({}), [], false);
  const ads = statusOf(result.report, 'ads');
  assert.equal(ads.state, 'partial');
  assert.match(ads.detail, /^22,525 of 72,525 domains are on\./, 'the small last ruleset also fits');
  assert.equal(statusOf(result.report, 'trackers').state, 'on');
});

test('when no ads ruleset fits, the ads line says it is not enabled and the curated lists still apply', async () => {
  installFakeChrome({ available: 100 });
  const result = await applyAll(settingsWith({}), [], false);
  assert.equal(statusOf(result.report, 'ads').state, 'error');
  assert.match(statusOf(result.report, 'ads').detail, /Not enabled/);
  assert.equal(statusOf(result.report, 'trackers').state, 'on');
  assert.equal(statusOf(result.report, 'fingerprinting').state, 'on');
});

test('a refused static update is retried with the rules already on reserved, and then succeeds', async () => {
  const { log } = installFakeChrome({ enabled: ['trackers'], failEnableCalls: 1 });
  const result = await applyAll(settingsWith({}), [], false);
  assert.equal(log.enableCalls.length, 2);
  assert.deepEqual(log.enableCalls[1].enable, ['fingerprinting', 'ads-1', 'ads-2', 'ads-3', 'ads-4', 'ads-5', 'ads-6', 'ads-7', 'ads-8']);
  assert.equal(statusOf(result.report, 'ads').state, 'on');
  assert.equal(statusOf(result.report, 'trackers').state, 'on');
});

test('when Chrome refuses both static attempts, the error is shown and nothing claims success', async () => {
  const { log } = installFakeChrome({ enabled: ['trackers'], failEnableCalls: 2 });
  const result = await applyAll(settingsWith({}), [], false);
  assert.equal(log.enableCalls.length, 2);
  assert.equal(statusOf(result.report, 'ads').state, 'error');
  assert.match(statusOf(result.report, 'ads').detail, /Static rule limit reached/);
  assert.equal(statusOf(result.report, 'trackers').state, 'error');
});

test('the toolbar count is off when the option is off', async () => {
  const { log } = installFakeChrome();
  const result = await applyAll(settingsWith({ showBadgeCount: false }), [], false);
  assert.equal(log.badge, false);
  assert.equal(statusOf(result.report, 'badge').state, 'off');
});

test('clear-on-start is reported as a start-time action and is not applied now', async () => {
  const { log } = installFakeChrome();
  const result = await applyAll(settingsWith(PRESETS.ultra), [], true);
  assert.equal(statusOf(result.report, 'clear').state, 'on');
  assert.deepEqual(log.browsingDataCalls, [], 'the extension clears data only at browser start');
  assert.equal(statusOf(result.report, 'thirdScripts').state, 'on');
  assert.equal(log.dynamicCalls[0].added.some((rule) => rule.action.type === 'redirect'), true, 'Ultra includes tracking-link cleanup, which is allowed with access');
});
