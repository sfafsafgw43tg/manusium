import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADS_RULESET_LIMIT, adsRulesets, parseHosts } from '../scripts/generate-rules.mjs';
import { CACHE_FILE, gitBlobId, PIN, verifyUpstream } from '../scripts/fetch-upstream.mjs';
import { LIST_INFO } from '../dist/lists-info.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = path.join(ROOT, 'dist');

test('parseHosts keeps domain entries from 0.0.0.0 and 127.0.0.1 lines, lowercased, unique and sorted', () => {
  const { domains, ignored } = parseHosts('# comment\n0.0.0.0 Ads.Example.com\n127.0.0.1 ads.example.com # dup\n0.0.0.0 a.example.net\n');
  assert.deepEqual(domains, ['a.example.net', 'ads.example.com']);
  assert.equal(ignored, 0);
});

test('parseHosts ignores IP addresses, localhost names, IPv6 lines and malformed lines, and counts them', () => {
  const text = '0.0.0.0 0.0.0.0\n0.0.0.0 localhost\n0.0.0.0 broadcasthost.localdomain\n::1 localhost\n0.0.0.0 bad_host\n0.0.0.0 ok.example.com\n';
  const { domains, ignored } = parseHosts(text);
  assert.deepEqual(domains, ['ok.example.com']);
  assert.equal(ignored, 5);
});

test('adsRulesets splits domains into rulesets of at most the limit, with IDs that continue from firstId', () => {
  const domains = Array.from({ length: ADS_RULESET_LIMIT * 2 + 5 }, (_, i) => `d${i}.example.com`);
  const sets = adsRulesets(domains, 100);
  assert.deepEqual(sets.map((set) => set.id), ['ads-1', 'ads-2', 'ads-3']);
  assert.deepEqual(sets.map((set) => set.rules.length), [ADS_RULESET_LIMIT, ADS_RULESET_LIMIT, 5]);
  const ids = sets.flatMap((set) => set.rules.map((rule) => rule.id));
  assert.equal(ids[0], 100);
  assert.equal(ids.at(-1), 100 + domains.length - 1);
  assert.equal(new Set(ids).size, ids.length);
});

test('an ads rule is a plain domain block that spares the main frame', () => {
  const [set] = adsRulesets(['ads.example.com'], 1);
  assert.deepEqual(set.rules[0], {
    id: 1,
    priority: 1,
    action: { type: 'block' },
    condition: { urlFilter: '||ads.example.com^', excludedResourceTypes: ['main_frame'] },
  });
});

test('the pin records the same domain count the build reports, and an MIT licence', () => {
  assert.equal(PIN.domains, LIST_INFO.adDomains);
  assert.equal(PIN.license, 'MIT');
  assert.match(PIN.commit, /^[0-9a-f]{40}$/);
  assert.match(PIN.blobSha, /^[0-9a-f]{40}$/);
  assert.match(PIN.sha256, /^[0-9a-f]{64}$/);
});

test('the git object ID helper matches git itself', () => {
  assert.equal(gitBlobId(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
});

test('the cached upstream file, when present, passes verification and parses to the pinned count', { skip: existsSync(CACHE_FILE) ? false : 'no cached copy; the build downloads it' }, () => {
  const bytes = verifyUpstream(readFileSync(CACHE_FILE));
  assert.equal(parseHosts(bytes.toString('utf8')).domains.length, PIN.domains);
});

test('verification rejects a file that differs from the pin', () => {
  assert.throws(() => verifyUpstream(Buffer.from('0.0.0.0 ads.example.com\n')), /blob id/);
});

test('the built manifest declares every ruleset; only the curated lists start enabled', () => {
  const manifest = JSON.parse(readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
  const resources = manifest.declarative_net_request.rule_resources;
  assert.deepEqual(resources.map((resource) => resource.id), ['trackers', 'fingerprinting', ...LIST_INFO.adRulesets.map((set) => set.id)]);
  for (const resource of resources) {
    assert.equal(existsSync(path.join(DIST, resource.path)), true, resource.path);
    assert.equal(resource.enabled, resource.id === 'trackers' || resource.id === 'fingerprinting', resource.id);
  }
});

test('the built rulesets hold exactly the counts in lists-info, and every rule ID is unique across all of them', () => {
  const ids = [];
  const check = (name, expected) => {
    const rules = JSON.parse(readFileSync(path.join(DIST, 'rules', `${name}.json`), 'utf8'));
    assert.equal(rules.length, expected, name);
    assert.ok(rules.length <= ADS_RULESET_LIMIT, `${name} is within the per-ruleset limit`);
    ids.push(...rules.map((rule) => rule.id));
  };
  check('trackers', LIST_INFO.trackerRules);
  check('fingerprinting', LIST_INFO.fingerprintRules);
  for (const set of LIST_INFO.adRulesets) check(set.id, set.rules);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(LIST_INFO.adRulesets.reduce((sum, set) => sum + set.rules, 0), LIST_INFO.adDomains);
});

test('the licence text ships with the build and is the MIT licence', () => {
  const text = readFileSync(path.join(DIST, 'third-party', 'stevenblack-hosts-LICENSE.txt'), 'utf8');
  assert.match(text, /The MIT License \(MIT\)/);
  assert.match(text, /Steven Black/);
});
