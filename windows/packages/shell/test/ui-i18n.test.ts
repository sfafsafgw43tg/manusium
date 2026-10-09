/**
 * packages/shell/test/ui-i18n.test.ts
 *
 * The trusted UIs build their labels from `t('...')` calls, many of them with a
 * dynamic tail (`t(\`level.${level}\`)`, `t(\`profile.kindTag.${kind}\`)`). A typo
 * in such a key shows up in the running app as the raw key string instead of a
 * label - exactly the kind of "broken text" that is easy to miss without a
 * Windows machine. This test reads the renderer sources and checks that
 *   - every literal key exists in BOTH dictionaries, and
 *   - every dynamic prefix has matching keys, including the concrete values the
 *     code can produce (profile kinds, protection levels, network modes, ...).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DICTS } from '@octo/core';

const repoRoot = path.resolve(__dirname, '..', '..', '..');

const SOURCES = [
  'apps/octobrowser/src/renderer/launcher.ts',
  'apps/octobrowser/src/renderer/browser.ts',
  'apps/octodetect/src/renderer/detect.ts',
  'packages/shell/renderer/firstrun.ts',
  'packages/shell/renderer/unlock.ts',
  'packages/shell/renderer/splash.ts',
  'packages/shell/renderer/keypanel.ts',
];

/** Dynamic keys the sources can produce, listed explicitly. */
const DYNAMIC: Array<[string, string[]]> = [
  ['profile.kind', ['personal', 'work', 'phone', 'private', 'testing', 'temporary', 'tor', 'custom']],
  ['profile.kindTag', ['personal', 'work', 'phone', 'private', 'testing', 'temporary', 'tor', 'custom']],
  ['profile.kindDesc', ['personal', 'work', 'phone', 'private', 'testing', 'temporary', 'tor', 'custom']],
  ['level', ['standard', 'strict', 'tor']],
  ['net.mode', ['system', 'direct', 'proxy']],
  ['iso.mode', ['none', 'restricted', 'windows-sandbox', 'isolated-vm']],
  ['iso.clipboard', ['allow', 'write-only', 'block']],
  ['webrtc', ['default', 'default_public_interface_only', 'disable_non_proxied_udp']],
  ['canvas', ['allow', 'block-readback']],
  ['webgl', ['allow', 'disabled']],
  ['hardware', ['allow', 'normalize']],
  ['fstatus', ['exposed', 'limited', 'blocked', 'unknown']],
  ['entropy', ['low', 'medium', 'high']],
  ['risk', ['low', 'medium', 'high', 'unknown']],
  ['leak', ['ok', 'warning', 'leak', 'unknown']],
  ['uniq', ['likely-common', 'possibly-unique', 'likely-unique', 'unknown']],
];

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('renderer labels', () => {
  const sources = SOURCES.map((rel) => ({ rel, code: read(rel) }));

  it('finds the sources', () => {
    expect(sources.length).toBe(SOURCES.length);
    for (const s of sources) expect(s.code.length, s.rel).toBeGreaterThan(400);
  });

  it('every literal t() key exists in Polish and English', () => {
    const missing: string[] = [];
    for (const { rel, code } of sources) {
      for (const m of code.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]{2,64})'/g)) {
        const key = m[1];
        if (!DICTS.en[key]) missing.push(`${rel}: en ${key}`);
        if (!DICTS.pl[key]) missing.push(`${rel}: pl ${key}`);
      }
    }
    expect(missing, `unknown i18n keys:\n${missing.join('\n')}`).toEqual([]);
  });

  it('every dynamic key the code can produce exists in Polish and English', () => {
    const missing: string[] = [];
    for (const [prefix, values] of DYNAMIC) {
      for (const v of values) {
        const key = `${prefix}.${v}`;
        if (!DICTS.en[key]) missing.push(`en ${key}`);
        if (!DICTS.pl[key]) missing.push(`pl ${key}`);
      }
    }
    expect(missing, `unknown dynamic i18n keys:\n${missing.join('\n')}`).toEqual([]);
  });

  it('no dynamic prefix is left without a single matching key', () => {
    const orphans: string[] = [];
    for (const { rel, code } of sources) {
      for (const m of code.matchAll(/\bt\(\s*`([a-zA-Z0-9_.]*)\$\{/g)) {
        const prefix = m[1];
        const hit = Object.keys(DICTS.en).some((k) => k.startsWith(prefix));
        if (!hit) orphans.push(`${rel}: ${prefix}`);
      }
    }
    expect(orphans, `prefixes without any dictionary entry:\n${orphans.join('\n')}`).toEqual([]);
  });
});
