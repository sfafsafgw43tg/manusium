import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkLayout,
  loadManifest,
  walkTree,
  // @ts-expect-error - plain ESM tool without type declarations
} from '../../../tools/inkbrowser/verify-layout.mjs';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const verifier = path.join(repoRoot, 'tools', 'inkbrowser', 'verify-layout.mjs');
const manifest = loadManifest();
const VERSION = '154.0.8037.97';
const runtime: string[] = manifest.runtime.required;

type LayoutResult = { layout: string | null; errors: string[]; warnings: string[] };
const check = (entries: string[]): LayoutResult => checkLayout(entries, manifest) as LayoutResult;

/** Two-level tree of image-1: launcher in Application\, runtime in Application\<version>\. */
function installedTree(extra: string[] = []): string[] {
  return [
    'Application/inkbrowser-chrome.exe',
    'Application/chrome_proxy.exe',
    'Application/chrome.VisualElementsManifest.xml',
    `Application/${VERSION}/`,
    ...runtime.map((file) => `Application/${VERSION}/${file}`),
    `Application/${VERSION}/${VERSION}.manifest`,
    ...extra,
  ];
}

/** Flat portable tree: everything in one folder. */
function flatTree(extra: string[] = []): string[] {
  return ['inkbrowser-chrome.exe', ...runtime, ...extra];
}

/** What an Electron distribution looks like (image-2). */
const ELECTRON_TREE = [
  'electron.exe',
  'ffmpeg.dll',
  'LICENSE',
  'LICENSES.chromium.html',
  'version',
  'snapshot_blob.bin',
  'resources/app.asar',
  'resources/default_app.asar',
  'chrome_100_percent.pak',
  'resources.pak',
  'icudtl.dat',
  'package.json',
  'package-lock.json',
  'node_modules/',
  'node_modules/left-pad/index.js',
];

describe('checkLayout', () => {
  it('accepts the two-level installed layout of image-1', () => {
    const result = check(installedTree());
    expect(result.layout).toBe('installed');
    expect(result.errors).toEqual([]);
  });

  it('accepts the flat portable layout', () => {
    const result = check(flatTree());
    expect(result.layout).toBe('flat');
    expect(result.errors).toEqual([]);
  });

  it('rejects the Electron distribution (image-2) with every Electron marker', () => {
    const result = check(ELECTRON_TREE);
    expect(result.layout).toBeNull();
    const text = result.errors.join('\n');
    expect(text).toContain('forbidden file: electron.exe');
    expect(text).toContain('forbidden file type (Electron/ASAR application bundle): resources/app.asar');
    expect(text).toContain('forbidden file: package.json');
    expect(text).toContain('forbidden file: package-lock.json');
    expect(text).toContain('forbidden directory: node_modules');
    expect(result.errors.filter((e) => e.startsWith('forbidden directory'))).toHaveLength(1);
  });

  it('rejects a missing runtime file in the version folder', () => {
    const tree = installedTree().filter((entry) => !entry.endsWith('/chrome.dll'));
    const result = check(tree);
    expect(result.layout).toBeNull();
    expect(result.errors).toContain(`missing runtime file: Application\\${VERSION}\\chrome.dll`);
  });

  it('rejects the upstream launcher name, which must be renamed', () => {
    const result = check(installedTree(['Application/chrome.exe']));
    expect(result.errors).toContain('upstream launcher name, rename to inkbrowser-chrome.exe: Application/chrome.exe');
  });

  it('rejects two version folders in one portable tree', () => {
    const result = check(installedTree(['Application/142.0.7444.273/chrome.dll']));
    expect(result.errors.some((e) => e.startsWith('expected one version folder'))).toBe(true);
  });

  it('rejects Google service binaries when their GN feature should be off', () => {
    const result = check(installedTree([`Application/${VERSION}/gaia1_0.dll`]));
    expect(result.errors.some((e) => e.includes('Google service binary present') && e.includes('gaia1_0.dll'))).toBe(true);
  });

  it('compares names case-insensitively and accepts Windows backslash paths', () => {
    const tree = [
      'Application\\InkBrowser-Chrome.exe',
      `Application\\${VERSION}\\`,
      ...runtime.map((file) => `Application\\${VERSION}\\${file.replace('/', '\\')}`),
    ];
    const result = check(tree);
    expect(result.layout).toBe('installed');
    expect(result.errors).toEqual([]);
  });

  it('warns, but does not fail, on an unexpected file beside the launcher', () => {
    const result = check(installedTree(['Application/notes.txt']));
    expect(result.layout).toBe('installed');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toContain('unexpected file in Application\\: notes.txt');
  });

  it('reports a tree that has neither layout', () => {
    const result = check(['readme.txt']);
    expect(result.layout).toBeNull();
    expect(result.errors.some((e) => e.startsWith('launcher not found'))).toBe(true);
  });
});

describe('layout manifest', () => {
  it('names the launcher inkbrowser-chrome.exe and keeps the required runtime list complete', () => {
    expect(manifest.launcher).toBe('inkbrowser-chrome.exe');
    expect(runtime).toEqual(expect.arrayContaining(['chrome.dll', 'resources.pak', 'icudtl.dat', 'locales/en-US.pak']));
  });

  it('never lists a forbidden Electron file as required, nor a runtime file as forbidden', () => {
    const forbidden = new Set([...manifest.forbiddenFiles, ...manifest.upstreamLauncherNames].map((n: string) => n.toLowerCase()));
    for (const file of runtime) expect(forbidden.has(file.toLowerCase())).toBe(false);
    expect(manifest.forbiddenFiles).toEqual(expect.arrayContaining(['electron.exe', 'node.dll', 'package.json', 'package-lock.json']));
    expect(manifest.forbiddenPatterns).toContain('*.asar');
    expect(manifest.forbiddenDirectories).toContain('node_modules');
  });
});

describe('walkTree and the command line', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'inkbrowser-layout-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(tree: string[]) {
    for (const entry of tree) {
      const abs = path.join(root, ...entry.split('/'));
      if (entry.endsWith('/')) {
        mkdirSync(abs, { recursive: true });
      } else {
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, '');
      }
    }
  }

  function cli(dir: string, extra: string[] = []) {
    return spawnSync(process.execPath, [verifier, dir, ...extra], { encoding: 'utf8', timeout: 60_000 });
  }

  it('leaves out WidevineCdm, MEIPreload, and PrivacySandboxAttestationsPreloaded from the tree', () => {
    expect([...manifest.excludedComponents].sort()).toEqual(['MEIPreload', 'PrivacySandboxAttestationsPreloaded', 'WidevineCdm']);
    for (const name of manifest.excludedComponents) {
      expect(manifest.runtime.required).not.toContain(name);
      expect(manifest.runtime.optional).not.toContain(name);
    }
  });

  it('walkTree lists nested files with forward slashes and folders with a trailing slash', () => {
    write(['Application/inkbrowser-chrome.exe', `Application/${VERSION}/locales/en-US.pak`]);
    const entries = walkTree(root);
    expect(entries).toEqual(expect.arrayContaining([
      'Application/',
      'Application/inkbrowser-chrome.exe',
      `Application/${VERSION}/`,
      `Application/${VERSION}/locales/en-US.pak`,
    ]));
  });

  it('exits 0 for a valid installed tree on disk', () => {
    write(installedTree());
    const result = cli(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('layout: installed');
    expect(result.stdout).toContain('PASS');
  });

  it('exits 1 and lists the problems for an Electron tree on disk', () => {
    write(ELECTRON_TREE);
    const result = cli(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('forbidden file: electron.exe');
  });

  it('prints machine-readable output with --json', () => {
    write(flatTree());
    const result = cli(root, ['--json']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.layout).toBe('flat');
  });

  it('exits 2 for a missing directory and for no argument', () => {
    expect(cli(path.join(root, 'missing')).status).toBe(2);
    expect(spawnSync(process.execPath, [verifier], { encoding: 'utf8' }).status).toBe(2);
  });
});

describe('gn/release.gn', () => {
  const gn = readFileSync(path.join(repoRoot, 'tools', 'inkbrowser', 'gn', 'release.gn'), 'utf8');
  const setting = (name: string) => {
    const match = gn.match(new RegExp(`^${name}\\s*=\\s*(.+?)\\s*(#.*)?$`, 'm'));
    return match ? match[1].trim() : undefined;
  };

  it('keeps the Google-service and telemetry switches off, as verified upstream', () => {
    expect(setting('google_api_key')).toBe('""');
    expect(setting('google_default_client_id')).toBe('""');
    expect(setting('google_default_client_secret')).toBe('""');
    expect(setting('use_official_google_api_keys')).toBe('false');
    expect(setting('safe_browsing_mode')).toBe('0');
    expect(setting('enable_reporting')).toBe('false');
    expect(setting('enable_remoting')).toBe('false');
    expect(setting('enable_mdns')).toBe('false');
    expect(setting('enable_service_discovery')).toBe('false');
  });

  it('builds an optimised 64-bit Windows release with the Chromium branding path unchanged', () => {
    expect(setting('target_cpu')).toBe('"x64"');
    expect(setting('is_debug')).toBe('false');
    expect(setting('is_official_build')).toBe('true');
    expect(setting('is_chrome_branded')).toBe('false');
    expect(setting('branding_path_component')).toBeUndefined();
  });

  it('turns Widevine off, as blueprint decision 9 now requires', () => {
    expect(setting('enable_widevine')).toBe('false');
  });

  it('uses only argument names from the upstream flag files (no invented names)', () => {
    const names = [...gn.matchAll(/^([a-z_0-9]+)\s*=/gm)].map((m) => m[1]);
    const known = new Set([
      'is_official_build', 'is_debug', 'target_cpu', 'is_clang', 'is_component_build', 'use_sysroot',
      'enable_rust', 'enable_swiftshader', 'dcheck_always_on', 'symbol_level', 'blink_symbol_level',
      'v8_symbol_level', 'treat_warnings_as_errors', 'exclude_unwind_tables', 'clang_use_chrome_plugins',
      'disable_fieldtrial_testing_config', 'use_unofficial_version_number', 'chrome_pgo_phase',
      'v8_drumbrake_bounds_checks', 'is_chrome_branded', 'proprietary_codecs', 'ffmpeg_branding',
      'enable_mse_mpeg2ts_stream_parser', 'enable_widevine', 'google_api_key', 'google_default_client_id',
      'google_default_client_secret', 'use_official_google_api_keys', 'safe_browsing_mode', 'enable_reporting',
      'enable_remoting', 'enable_mdns', 'enable_service_discovery', 'enable_hangout_services_extension',
    ]);
    expect(names.length).toBeGreaterThan(30);
    expect(names.filter((name) => !known.has(name))).toEqual([]);
  });
});

describe('docs/inkbrowser/BLUEPRINT.md', () => {
  const blueprint = readFileSync(path.join(repoRoot, 'docs', 'inkbrowser', 'BLUEPRINT.md'), 'utf8');

  it('opens with the image distinction: image-1 CORRECT, image-2 INCORRECT', () => {
    const head = blueprint.split('\n').slice(0, 20).join('\n');
    const order = ['image-1', 'CORRECT', 'image-2', 'INCORRECT'].map((word) => head.indexOf(word));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("states this round's mapping: image-4 CORRECT, image-3 INCORRECT", () => {
    const head = blueprint.split('\n').slice(0, 20).join('\n');
    expect(head).toMatch(/image-4: CORRECT/);
    expect(head).toMatch(/image-3: INCORRECT/);
  });

  it('names the portable zip as InkBrowser-<version>-<platform>-x64-portable.zip', () => {
    expect(blueprint).toContain('InkBrowser-<version>-<platform>-x64-portable.zip');
  });

  it('uses the verified Visual Elements manifest name, not the one from the request', () => {
    expect(blueprint).toContain('chrome.VisualElementsManifest.xml');
  });
});
