/**
 * packages/shell/test/ui-html-i18n-attrs.test.ts
 *
 * Every `data-i18n*` attribute used in the HTML pages must be one that
 * applyI18n() actually handles. A typo (`data-i18n-placeholder` instead of
 * `data-i18n-ph`) left the setup and unlock password fields as empty,
 * unlabeled boxes.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '..', '..', '..');
const DIRS = ['packages/shell/renderer', 'apps/octobrowser/src/renderer', 'apps/octobrowser/src/internal', 'apps/octodetect/src/renderer'];

describe('HTML translation attributes', () => {
  const client = fs.readFileSync(path.join(root, 'packages/shell/renderer/i18n-client.ts'), 'utf8');
  const supported = new Set([...client.matchAll(/\[(data-i18n[a-z-]*)\]/g)].map((m) => m[1]));

  it('finds the supported attributes in i18n-client', () => {
    expect([...supported]).toEqual(expect.arrayContaining(['data-i18n', 'data-i18n-ph', 'data-i18n-title']));
  });

  it('uses only supported data-i18n attributes', () => {
    const bad: string[] = [];
    for (const d of DIRS) {
      for (const f of fs.readdirSync(path.join(root, d)).filter((x) => x.endsWith('.html'))) {
        const html = fs.readFileSync(path.join(root, d, f), 'utf8');
        for (const m of html.matchAll(/\s(data-i18n[a-z-]*)=/g)) if (!supported.has(m[1])) bad.push(`${d}/${f}: ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
