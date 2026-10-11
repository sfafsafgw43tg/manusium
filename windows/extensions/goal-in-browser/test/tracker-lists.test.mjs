import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generate, parseSource } from '../scripts/generate-rules.mjs';

const readRules = (name) => JSON.parse(readFileSync(new URL(`../rules/${name}.json`, import.meta.url), 'utf8'));
const readSource = (name) => readFileSync(new URL(`../rules/sources/${name}.txt`, import.meta.url), 'utf8');

/**
 * A model of how the bundled rules match, not Chrome's matcher. It covers only what the lists use:
 * the "||host^" and "||host/path" forms and excludedResourceTypes. Used to check the list content.
 */
function blockedByModel(rules, url, resourceType) {
  const target = new URL(url);
  return rules.some((rule) => {
    if ((rule.condition.excludedResourceTypes ?? []).includes(resourceType)) return false;
    const filter = rule.condition.urlFilter;
    const body = filter.slice(2);
    const cut = body.search(/[\^/]/);
    const domain = body.slice(0, cut);
    const rest = body.slice(cut);
    const onDomain = target.hostname === domain || target.hostname.endsWith(`.${domain}`);
    if (!onDomain) return false;
    if (rest === '^') return true;
    return target.pathname.startsWith(rest);
  });
}

test('parseSource turns domains and host/path entries into block rules with main frame excluded', () => {
  const rules = parseSource('# comment\n\nexample.com\nexample.net/tr/\n', 'test');
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0], { id: 1, priority: 1, action: { type: 'block' }, condition: { urlFilter: '||example.com^', excludedResourceTypes: ['main_frame'] } });
  assert.equal(rules[1].condition.urlFilter, '||example.net/tr/');
});

test('parseSource drops duplicates and inline comments', () => {
  const rules = parseSource('a.example.com # note\na.example.com\n', 'test');
  assert.equal(rules.length, 1);
  assert.equal(rules[0].condition.urlFilter, '||a.example.com^');
});

test('parseSource rejects invalid entries and names the file and line', () => {
  for (const bad of ['bad host.com', 'localhost', '1.2.3.4', 'exa mple.com/x', 'example.com/UPPER', 'münchen.de']) {
    assert.throws(() => parseSource(`ok.example.com\n${bad}\n`, 'trackers'), /trackers\.txt line 2/, bad);
  }
});

test('the committed rule files match their sources exactly', () => {
  // Same first IDs as generate(): trackers from 1, fingerprinting after them, so every rule ID is unique.
  const trackers = parseSource(readSource('trackers'), 'trackers', 1);
  const fingerprinting = parseSource(readSource('fingerprinting'), 'fingerprinting', trackers.length + 1);
  assert.deepEqual(readRules('trackers'), trackers, 'trackers.json is stale; run npm run build');
  assert.deepEqual(readRules('fingerprinting'), fingerprinting, 'fingerprinting.json is stale; run npm run build');
});

test('the generator writes both rulesets and reports their sizes', () => {
  const sizes = generate(fileURLToPath(new URL('..', import.meta.url)));
  assert.equal(sizes.trackers, readRules('trackers').length);
  assert.equal(sizes.fingerprinting, readRules('fingerprinting').length);
});

test('every source entry becomes a rule', () => {
  for (const name of ['trackers', 'fingerprinting']) {
    const entries = readSource(name).split(/\r?\n/).map((line) => line.replace(/#.*$/, '').trim()).filter(Boolean);
    assert.equal(readRules(name).length, new Set(entries).size, name);
  }
});

test('tracker rules block known tracker requests in subresources', () => {
  const rules = readRules('trackers');
  const blocked = [
    'https://www.google-analytics.com/analytics.js',
    'https://www.googletagmanager.com/gtm.js?id=GTM-1',
    'https://static.hotjar.com/c/hotjar-1.js',
    'https://connect.facebook.net/en_US/fbevents.js',
    'https://www.facebook.com/tr/?id=1&ev=PageView',
    'https://ad.doubleclick.net/ddm/activity/',
  ];
  for (const url of blocked) assert.equal(blockedByModel(rules, url, 'script'), true, url);
});

test('tracker rules leave ordinary sites and look-alike domains alone', () => {
  const rules = readRules('trackers');
  const allowed = [
    'https://example.com/',
    'https://www.facebook.com/profile.php',
    'https://notgoogle-analytics.com/analytics.js',
    'https://google-analytics.com.example.org/x.js',
  ];
  for (const url of allowed) assert.equal(blockedByModel(rules, url, 'script'), false, url);
});

test('tracker rules never block a page the user opens directly', () => {
  assert.equal(blockedByModel(readRules('trackers'), 'https://doubleclick.net/', 'main_frame'), false);
});

test('fingerprinting rules block the listed script hosts', () => {
  const rules = readRules('fingerprinting');
  assert.equal(blockedByModel(rules, 'https://fpjs.io/v3/agent.js', 'script'), true);
  assert.equal(blockedByModel(rules, 'https://openfpcdn.io/fp.js', 'script'), true);
  assert.equal(blockedByModel(rules, 'https://example.com/fp.js', 'script'), false);
});
