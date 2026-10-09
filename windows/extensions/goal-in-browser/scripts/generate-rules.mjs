// Turns the curated source lists (rules/sources/*.txt) into declarativeNetRequest rulesets (rules/*.json),
// and the pinned upstream hosts file into ads and malware rulesets. Every rule ID is unique across all rulesets.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** Chrome rejects more than this many rules in one ruleset comfortably below its documented limits. */
export const ADS_RULESET_LIMIT = 10000;
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:xn--[a-z0-9-]{1,59}|[a-z]{2,63})$/;
const PATH = /^\/[a-z0-9._~/-]*$/;
const HOSTS_NAME = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)+$/;
const IPV4 = /^\d+(?:\.\d+){3}$/;

/** A blocking rule for subresources. The main frame is excluded so a listed site can still be opened directly. */
function blockRule(id, urlFilter) {
  return { id, priority: 1, action: { type: 'block' }, condition: { urlFilter, excludedResourceTypes: ['main_frame'] } };
}

/** Parses one curated source list. Throws with the file name and line number on the first invalid entry. */
export function parseSource(text, name, firstId = 1) {
  const rules = [];
  const seen = new Set();
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const slash = line.indexOf('/');
    const host = slash === -1 ? line : line.slice(0, slash);
    const urlPath = slash === -1 ? '' : line.slice(slash);
    if (!HOSTNAME.test(host) || (urlPath && !PATH.test(urlPath))) {
      throw new Error(`${name}.txt line ${index + 1}: invalid entry "${raw.trim()}"`);
    }
    const key = `${host}${urlPath}`;
    if (seen.has(key)) return;
    seen.add(key);
    // "||host^" blocks the domain and its subdomains. A path entry needs no separator.
    const urlFilter = urlPath ? `||${host}${urlPath}` : `||${host}^`;
    rules.push(blockRule(firstId + rules.length, urlFilter));
  });
  return rules;
}

/**
 * Parses the hosts-file format ("0.0.0.0 domain"). Returns sorted unique domains and the number of lines ignored:
 * comments, loopback and IP-address entries, localhost names, and anything that is not a plain domain.
 */
export function parseHosts(text) {
  const domains = new Set();
  let ignored = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const fields = line.split(/\s+/);
    if (fields.length !== 2 || (fields[0] !== '0.0.0.0' && fields[0] !== '127.0.0.1')) {
      ignored++;
      continue;
    }
    const host = fields[1].toLowerCase();
    if (IPV4.test(host) || host === 'localhost' || host.endsWith('.localdomain') || !HOSTS_NAME.test(host)) {
      ignored++;
      continue;
    }
    domains.add(host);
  }
  return { domains: [...domains].sort(), ignored };
}

/** Splits domains into rulesets of at most ADS_RULESET_LIMIT rules. IDs continue from firstId. */
export function adsRulesets(domains, firstId) {
  const sets = [];
  let next = firstId;
  for (let start = 0, number = 1; start < domains.length; start += ADS_RULESET_LIMIT, number++) {
    const slice = domains.slice(start, start + ADS_RULESET_LIMIT);
    const rules = slice.map((domain, index) => blockRule(next + index, `||${domain}^`));
    next += slice.length;
    sets.push({ id: `ads-${number}`, rules });
  }
  return sets;
}

/** Writes rules/trackers.json and rules/fingerprinting.json from their sources. Returns the sizes and the next free ID. */
export function generate(root = ROOT) {
  const read = (name) => readFileSync(path.join(root, 'rules', 'sources', `${name}.txt`), 'utf8');
  const trackers = parseSource(read('trackers'), 'trackers', 1);
  const fingerprinting = parseSource(read('fingerprinting'), 'fingerprinting', trackers.length + 1);
  for (const [name, rules] of [['trackers', trackers], ['fingerprinting', fingerprinting]]) {
    writeFileSync(path.join(root, 'rules', `${name}.json`), `${JSON.stringify(rules, null, 2)}\n`);
  }
  return {
    trackers: trackers.length,
    fingerprinting: fingerprinting.length,
    nextId: trackers.length + fingerprinting.length + 1,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  console.log(generate());
}
