import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPreset,
  DEFAULT_SETTINGS,
  FEATURE_FLAGS,
  LIMITS,
  needsSiteAccess,
  PRESET_IDS,
  PRESETS,
  presetOf,
  sanitizeSettings,
} from '../dist/settings.js';

test('defaults are frozen, keep protection on, and use the Standard preset', () => {
  assert.equal(Object.isFrozen(DEFAULT_SETTINGS), true);
  assert.equal(DEFAULT_SETTINGS.protectionEnabled, true);
  assert.equal(presetOf(DEFAULT_SETTINGS), 'standard');
  assert.equal(DEFAULT_SETTINGS.blockThirdPartyCookies, true);
  assert.equal(DEFAULT_SETTINGS.blockThirdPartyScripts, false, 'breaking options start off');
  assert.equal(DEFAULT_SETTINGS.globalPrivacyControl, false, 'GPC needs site access, so it starts off');
});

test('each preset is a superset of the one below it, so moving up never turns a protection off', () => {
  for (const key of FEATURE_FLAGS) {
    if (PRESETS.standard[key]) assert.equal(PRESETS.strict[key], true, `strict keeps ${key}`);
    if (PRESETS.strict[key]) assert.equal(PRESETS.ultra[key], true, `ultra keeps ${key}`);
  }
  assert.equal(PRESETS.standard.referrerPolicy, 'default');
  assert.equal(PRESETS.strict.referrerPolicy, 'origin');
  assert.equal(PRESETS.ultra.webRtcPolicy, 'disable_non_proxied_udp');
});

test('third-party blocking, clear-on-start and the strongest WebRTC policy are Ultra only', () => {
  for (const key of ['blockThirdPartyScripts', 'blockThirdPartyFrames', 'clearOnStart']) {
    assert.equal(PRESETS.standard[key], false, `standard ${key}`);
    assert.equal(PRESETS.strict[key], false, `strict ${key}`);
    assert.equal(PRESETS.ultra[key], true, `ultra ${key}`);
  }
  assert.equal(PRESETS.strict.webRtcPolicy, 'default_public_interface_only');
});

test('applying a preset sets its features and keeps the user lists, permissions and protection switch', () => {
  const current = sanitizeSettings({ protectionEnabled: false, allowlist: ['bank.example'], locationPermission: 'block', showBadgeCount: false });
  for (const id of PRESET_IDS) {
    const applied = applyPreset(current, id);
    assert.equal(presetOf(applied), id, id);
    assert.equal(applied.protectionEnabled, false, `${id} keeps the protection switch`);
    assert.deepEqual(applied.allowlist, ['bank.example']);
    assert.equal(applied.locationPermission, 'block');
    assert.equal(applied.showBadgeCount, false);
  }
});

test('changing any single feature makes the settings custom', () => {
  assert.equal(presetOf(sanitizeSettings({ ...DEFAULT_SETTINGS, adList: false })), 'custom');
  assert.equal(presetOf(sanitizeSettings({ ...DEFAULT_SETTINGS, referrerPolicy: 'none' })), 'custom');
});

test('needsSiteAccess is true only for the presets that use header or redirect rules', () => {
  assert.equal(needsSiteAccess(PRESETS.standard), false);
  assert.equal(needsSiteAccess(PRESETS.strict), true);
  assert.equal(needsSiteAccess(PRESETS.ultra), true);
  assert.equal(needsSiteAccess({ globalPrivacyControl: false, stripTrackingParams: false, referrerPolicy: 'none' }), false, 'the native referrer setting needs no access');
});

test('sanitizeSettings falls back to defaults for missing or invalid values and drops unknown keys', () => {
  const clean = sanitizeSettings({ adList: 'yes', referrerPolicy: 'everything', webRtcPolicy: 'x', notificationPermission: 'allow', alien: 1 });
  assert.equal(clean.adList, DEFAULT_SETTINGS.adList);
  assert.equal(clean.referrerPolicy, 'default');
  assert.equal(clean.webRtcPolicy, DEFAULT_SETTINGS.webRtcPolicy);
  assert.equal(clean.notificationPermission, 'block');
  assert.equal('alien' in clean, false);
});

test('sanitizeSettings treats null, arrays and scalars as empty input', () => {
  for (const input of [null, undefined, [], 7, 'settings']) {
    assert.deepEqual(sanitizeSettings(input), sanitizeSettings({}));
  }
});

test('host lists are cleaned, unique, sorted and capped', () => {
  const clean = sanitizeSettings({ allowlist: ['B.example.com', 'a.example.com', 'b.example.com', 'bad host', 42, 'localhost'] });
  assert.deepEqual(clean.allowlist, ['a.example.com', 'b.example.com']);
  const many = Array.from({ length: LIMITS.allowlist + 25 }, (_, i) => `site${i}.example.com`);
  assert.equal(sanitizeSettings({ allowlist: many }).allowlist.length, LIMITS.allowlist);
});

test('the custom blocklist is capped separately', () => {
  const many = Array.from({ length: LIMITS.customBlocklist + 5 }, (_, i) => `ads${i}.example.net`);
  assert.equal(sanitizeSettings({ customBlocklist: many }).customBlocklist.length, LIMITS.customBlocklist);
});
