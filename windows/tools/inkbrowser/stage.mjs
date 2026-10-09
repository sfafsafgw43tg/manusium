// tools/inkbrowser/stage.mjs
//
// Turns a Chromium Windows build output (for example out\Release) into the
// InkBrowser base of docs/inkbrowser/BLUEPRINT.md section 9.1:
//
//   <to>\Application\inkbrowser-chrome.exe              the launcher (renamed from chrome.exe)
//   <to>\Application\chrome_proxy.exe            kept beside the launcher, as upstream does
//   <to>\Application\chrome.VisualElementsManifest.xml
//   <to>\Application\<chromium version>\...      the runtime
//
// The three components in layout-manifest.json (excludedComponents) are left out,
// build-only files (symbols, import libraries) are left out, and the result is
// checked by verify-layout.mjs. The launcher icon is embedded with rcedit, which
// runs on Windows only.
//
//   node tools/inkbrowser/stage.mjs --from out\Release --to build\inkbrowser --chromium 154.0.8037.97 [--product 1.0.0.0] [--rcedit tools\rcedit-x64.exe]
//
// Exit 0: staged and valid. Exit 1: staged but the layout check failed. Exit 2: usage or I/O error.
// It runs on the build machine only. Nothing it writes depends on Node at runtime.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkLayout, loadManifest, walkTree } from './verify-layout.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ICON_PATH = path.resolve(HERE, '..', '..', 'branding', 'inkbrowser-chrome', 'icon.ico');

/** Upstream launcher files. They are renamed or kept beside the launcher, never copied into the version folder. */
const LAUNCHER_FILES = { 'chrome.exe': 'inkbrowser-chrome.exe', 'chrome_proxy.exe': 'chrome_proxy.exe', 'chrome.visualelementsmanifest.xml': 'chrome.VisualElementsManifest.xml' };
/** Build products that a shipped tree never needs. */
const BUILD_ONLY = /\.(pdb|map|lib|exp|ilk|obj)$/i;

const VERSION = /^\d+\.\d+\.\d+\.\d+$/;

function isDirEmpty(dir) {
  return !fs.existsSync(dir) || fs.readdirSync(dir).length === 0;
}

/**
 * Stages one base. Returns { ok, errors, warnings, layout, files, bytes, excluded, launcher }.
 * Nothing is written when the inputs are wrong, so a failed run leaves no half-built tree.
 */
export function stageBase({ from, to, chromium, product = '1.0.0.0', rcedit = '', icon = ICON_PATH, manifest = loadManifest() }) {
  const errors = [];
  const warnings = [];
  if (!VERSION.test(chromium ?? '')) errors.push('--chromium must be a four-part Chromium version, for example 154.0.8037.97');
  if (!VERSION.test(product ?? '')) errors.push('--product must be a four-part version, for example 1.0.0.0');
  if (!from || !fs.existsSync(from) || !fs.statSync(from).isDirectory()) errors.push(`build output folder not found: ${from ?? ''}`);
  if (!to) errors.push('--to is required');
  else if (!isDirEmpty(to)) errors.push(`destination is not empty, choose a new folder: ${to}`);
  if (errors.length) return { ok: false, errors, warnings, layout: null, files: 0, bytes: 0, excluded: [], launcher: '' };

  const entries = walkTree(from);
  const files = entries.filter((entry) => !entry.endsWith('/'));
  const byLower = new Map(files.map((rel) => [rel.toLowerCase(), rel]));
  if (!byLower.has('chrome.exe')) errors.push('chrome.exe is missing from the build output');
  for (const name of manifest.runtime.required) {
    if (!byLower.has(name.toLowerCase())) errors.push(`required runtime file missing from the build output: ${name}`);
  }
  if (errors.length) return { ok: false, errors, warnings, layout: null, files: 0, bytes: 0, excluded: [], launcher: '' };

  const excluded = new Set(manifest.excludedComponents.map((name) => name.toLowerCase()));
  const appDir = path.join(to, manifest.installed.launcherDir);
  const versionDir = path.join(appDir, chromium);
  const skipped = [];
  let copied = 0;
  let bytes = 0;

  for (const rel of files) {
    const segments = rel.split('/');
    const base = segments[segments.length - 1];
    if (segments.some((segment) => excluded.has(segment.toLowerCase())) || excluded.has(base.toLowerCase())) {
      skipped.push(rel);
      continue;
    }
    if (BUILD_ONLY.test(base)) {
      skipped.push(rel);
      continue;
    }
    const launcherName = segments.length === 1 ? LAUNCHER_FILES[base.toLowerCase()] : undefined;
    const destination = launcherName ? path.join(appDir, launcherName) : path.join(versionDir, ...segments);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(from, ...segments), destination);
    copied += 1;
    bytes += fs.statSync(destination).size;
  }

  const launcher = path.join(appDir, manifest.launcher);
  if (rcedit) {
    if (process.platform !== 'win32') {
      warnings.push('the launcher icon was not embedded: rcedit runs on Windows only');
    } else {
      const run = spawnSync(rcedit, [
        launcher, '--set-icon', icon,
        '--set-version-string', 'ProductName', 'InkBrowser',
        '--set-version-string', 'FileDescription', 'InkBrowser',
        '--set-version-string', 'OriginalFilename', manifest.launcher,
        '--set-file-version', chromium,
        '--set-product-version', product,
      ], { windowsHide: true, encoding: 'utf8' });
      if (run.status !== 0) errors.push(`rcedit failed: ${(run.stderr || run.stdout || '').trim()}`);
    }
  } else {
    warnings.push('the launcher icon was not embedded: pass --rcedit <rcedit-x64.exe> on Windows');
  }

  const check = checkLayout(walkTree(to), manifest);
  return {
    ok: errors.length === 0 && check.errors.length === 0,
    errors: [...errors, ...check.errors],
    warnings: [...warnings, ...check.warnings],
    layout: check.layout,
    files: copied,
    bytes,
    excluded: skipped,
    launcher,
  };
}

export function runStageCli(argv, out = (text) => process.stdout.write(text), err = (text) => process.stderr.write(text)) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index === -1 ? '' : argv[index + 1] ?? '';
  };
  const from = value('--from');
  const to = value('--to');
  const chromium = value('--chromium');
  if (!from || !to || !chromium) {
    err('usage: node tools/inkbrowser/stage.mjs --from <build output> --to <new folder> --chromium <x.x.x.x> [--product <x.x.x.x>] [--rcedit <rcedit-x64.exe>]\n');
    return 2;
  }
  const result = stageBase({ from, to, chromium, product: value('--product') || '1.0.0.0', rcedit: value('--rcedit') });
  for (const warning of result.warnings) out(`warning: ${warning}\n`);
  if (!result.ok) {
    for (const error of result.errors) err(`error: ${error}\n`);
    const inputProblem = result.layout === null && result.files === 0;
    return inputProblem ? 2 : 1;
  }
  out(`staged ${result.files} files (${(result.bytes / 1048576).toFixed(1)} MiB) into ${to}\n`);
  out(`layout: ${result.layout}; launcher: ${result.launcher}\n`);
  out(`left out: ${result.excluded.length} build or excluded files\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runStageCli(process.argv.slice(2));
}
