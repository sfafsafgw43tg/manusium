import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// The staging script is plain Node (.mjs) at the repository root.
// @ts-expect-error - plain ESM tool without type declarations
import { runStageCli, stageBase } from '../../../tools/inkbrowser/stage.mjs';

const root = path.resolve(__dirname, '..', '..', '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'tools', 'inkbrowser', 'layout-manifest.json'), 'utf8'));
const CHROMIUM = '154.0.8037.97';

function write(base: string, rel: string, content = 'x'): void {
  const file = path.join(base, ...rel.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Every file listed under the upstream build output, using the manifest's required names. */
function buildOutput(base: string): void {
  write(base, 'chrome.exe', 'launcher');
  write(base, 'chrome_proxy.exe', 'proxy');
  write(base, 'chrome.VisualElementsManifest.xml', '<Visual/>');
  for (const name of manifest.runtime.required) write(base, name);
  write(base, 'locales/fr.pak');
  // Components that InkBrowser leaves out.
  write(base, 'WidevineCdm/manifest.json', '{}');
  write(base, 'WidevineCdm/_platform_specific/win_x64/widevinecdm.dll');
  write(base, 'MEIPreload/manifest.json', '{}');
  write(base, 'MEIPreload/preloaded_data.pb');
  write(base, 'PrivacySandboxAttestationsPreloaded/attestations.dat');
  // Build products that a shipped tree never needs.
  write(base, 'chrome.pdb');
  write(base, 'chrome.map');
  write(base, 'chrome_elf.lib');
}

function listTree(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const rel = prefix ? `${prefix}/${name}` : name;
    return statSync(path.join(dir, name)).isDirectory() ? listTree(path.join(dir, name), rel) : [rel];
  });
}

describe('InkBrowser staging', () => {
  let work: string;
  let from: string;
  let to: string;

  beforeEach(() => {
    work = mkdtempSync(path.join(tmpdir(), 'inkbrowser-stage-'));
    from = path.join(work, 'out');
    to = path.join(work, 'staging', 'InkBrowser');
    mkdirSync(from, { recursive: true });
    buildOutput(from);
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('produces the two-level layout of image-4 with the launcher renamed', () => {
    const result = stageBase({ from, to, chromium: CHROMIUM });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(to, 'Application', 'inkbrowser-chrome.exe'))).toBe(true);
    expect(existsSync(path.join(to, 'Application', 'chrome_proxy.exe'))).toBe(true);
    expect(existsSync(path.join(to, 'Application', 'chrome.VisualElementsManifest.xml'))).toBe(true);
    expect(existsSync(path.join(to, 'Application', 'chrome.exe'))).toBe(false);
    expect(existsSync(path.join(to, 'Application', CHROMIUM, 'chrome.dll'))).toBe(true);
    expect(existsSync(path.join(to, 'Application', CHROMIUM, 'locales', 'en-US.pak'))).toBe(true);
    expect(existsSync(path.join(to, 'Application', CHROMIUM, 'locales', 'fr.pak'))).toBe(true);
  });

  it('leaves out WidevineCdm, MEIPreload, and PrivacySandboxAttestationsPreloaded', () => {
    const result = stageBase({ from, to, chromium: CHROMIUM });
    const staged = listTree(to).join('\n');
    expect(staged).not.toMatch(/widevine|meipreload|privacysandbox/i);
    expect(result.excluded).toEqual(expect.arrayContaining([
      'WidevineCdm/manifest.json',
      'MEIPreload/manifest.json',
      'PrivacySandboxAttestationsPreloaded/attestations.dat',
    ]));
  });

  it('leaves out build-only products', () => {
    stageBase({ from, to, chromium: CHROMIUM });
    const staged = listTree(to);
    expect(staged.some((rel) => /\.(pdb|map|lib|exp|ilk|obj)$/i.test(rel))).toBe(false);
  });

  it('refuses a destination that is not empty', () => {
    mkdirSync(to, { recursive: true });
    write(to, 'keep.txt');
    const result = stageBase({ from, to, chromium: CHROMIUM });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/destination is not empty/);
  });

  it('refuses a build output without chrome.exe or a required runtime file', () => {
    rmSync(path.join(from, 'chrome.exe'));
    expect(stageBase({ from, to, chromium: CHROMIUM }).errors.join('\n')).toMatch(/chrome\.exe is missing/);
    write(from, 'chrome.exe');
    rmSync(path.join(from, 'resources.pak'));
    expect(stageBase({ from, to: path.join(work, 'second'), chromium: CHROMIUM }).errors.join('\n')).toMatch(/required runtime file missing.*resources\.pak/);
  });

  it('checks the Chromium and product versions and the source folder', () => {
    expect(stageBase({ from, to, chromium: '154.0' }).errors.join('\n')).toMatch(/--chromium must be/);
    expect(stageBase({ from, to, chromium: CHROMIUM, product: 'one' }).errors.join('\n')).toMatch(/--product must be/);
    expect(stageBase({ from: path.join(work, 'missing'), to, chromium: CHROMIUM }).errors.join('\n')).toMatch(/build output folder not found/);
  });

  it('the command line returns 0 for a valid stage and 2 for a usage error', () => {
    const quiet = () => undefined;
    expect(runStageCli(['--from', from, '--to', to, '--chromium', CHROMIUM], quiet, quiet)).toBe(0);
    expect(runStageCli(['--from', from, '--chromium', CHROMIUM], quiet, quiet)).toBe(2);
  });
});
