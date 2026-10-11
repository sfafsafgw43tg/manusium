// Builds the unpacked extension into dist/: verifies the pinned upstream list, generates the rulesets,
// compiles TypeScript, copies the assets, and writes a manifest that declares every ruleset.
import { cpSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adsRulesets, generate, parseHosts } from './generate-rules.mjs';
import { loadUpstream, PIN, ROOT } from './fetch-upstream.mjs';

const DIST = path.join(ROOT, 'dist');
const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

export async function build({ log = console.log } = {}) {
  const hosts = parseHosts((await loadUpstream({ log })).toString('utf8'));
  if (hosts.domains.length !== PIN.domains) {
    throw new Error(`the upstream hosts file has ${hosts.domains.length} domains, but the pin says ${PIN.domains}`);
  }
  const counts = generate(ROOT);
  const ads = adsRulesets(hosts.domains, counts.nextId);

  rmSync(DIST, { recursive: true, force: true });
  execFileSync(process.execPath, [tsc, '-p', path.join(ROOT, 'tsconfig.json')], { stdio: 'inherit' });

  // The manifest declares every ruleset. Ads rulesets start disabled; the service worker enables them by setting.
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  manifest.declarative_net_request.rule_resources.push(
    ...ads.map((set) => ({ id: set.id, enabled: false, path: `rules/${set.id}.json` })),
  );
  mkdirSync(path.join(DIST, 'rules'), { recursive: true });
  writeFileSync(path.join(DIST, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const file of ['popup.html', 'options.html', 'style.css']) copyFileSync(path.join(ROOT, 'src', file), path.join(DIST, file));
  for (const file of ['trackers.json', 'fingerprinting.json']) copyFileSync(path.join(ROOT, 'rules', file), path.join(DIST, 'rules', file));
  for (const set of ads) writeFileSync(path.join(DIST, 'rules', `${set.id}.json`), JSON.stringify(set.rules));
  cpSync(path.join(ROOT, 'icons'), path.join(DIST, 'icons'), { recursive: true });
  copyFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), path.join(DIST, 'THIRD_PARTY_NOTICES.md'));
  mkdirSync(path.join(DIST, 'third-party'), { recursive: true });
  copyFileSync(path.join(ROOT, 'rules', 'sources', 'stevenblack-LICENSE.txt'), path.join(DIST, 'third-party', 'stevenblack-hosts-LICENSE.txt'));

  // Read by the options page. Counts come from the generated rulesets, not from a typed-in number.
  const info = {
    adRulesets: ads.map((set) => ({ id: set.id, rules: set.rules.length })),
    adDomains: hosts.domains.length,
    trackerRules: counts.trackers,
    fingerprintRules: counts.fingerprinting,
    upstream: { name: PIN.name, repo: PIN.repo, commit: PIN.commit, license: PIN.license, homepage: PIN.homepage },
  };
  writeFileSync(path.join(DIST, 'lists-info.js'), `// Written by scripts/build.mjs. Do not edit.\nexport const LIST_INFO = ${JSON.stringify(info, null, 2)};\n`);

  const ids = [
    ...JSON.parse(readFileSync(path.join(DIST, 'rules', 'trackers.json'), 'utf8')),
    ...JSON.parse(readFileSync(path.join(DIST, 'rules', 'fingerprinting.json'), 'utf8')),
    ...ads.flatMap((set) => set.rules),
  ].map((rule) => rule.id);
  if (new Set(ids).size !== ids.length) throw new Error('rule IDs are not unique across the rulesets');
  log(`built dist: ads and malware ${hosts.domains.length} domains in ${ads.length} rulesets (${hosts.ignored} hosts lines ignored), trackers ${counts.trackers} rules, fingerprinting ${counts.fingerprinting} rules`);
  return info;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  build().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
