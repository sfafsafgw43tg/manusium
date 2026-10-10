#!/usr/bin/env node
/**
 * Build and stage a modified Chromium checkout for InkBrowser.
 *
 * This script deliberately does not download Chrome for Testing and never
 * renames a vendor binary. It checks out the pinned Chromium source tag,
 * applies the project-owned branding overlay, builds chrome with GN/Ninja,
 * and stages the resulting executable and runtime files in the same flat
 * directory consumed by the native runtime integration.
 *
 * Run on a Windows x64 build machine with Visual Studio 2022, Python,
 * depot_tools, GN and Ninja available. A full checkout/build normally needs
 * well over 100 GB of disk and several hours.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versionDefault = '155.0.8059.39';
const targetDefault = 'win32-x64';
const overlay = path.join(root, 'tools', 'inkbrowser', 'source', 'BRANDING');
const gnArgs = path.join(root, 'tools', 'inkbrowser', 'gn', 'release.gn');
const iconFile = path.join(root, 'branding', 'inkbrowser-chrome', 'icon.ico');

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback;
}
function flag(name) { return process.argv.includes(name); }
function fail(message) { throw new Error(`[build-chromium-source] ${message}`); }
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function sha256Text(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function run(command, args, cwd, label = command) {
  console.log(`[build-chromium-source] ${label}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    windowsHide: false,
  });
  if (result.error) fail(`${label} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} failed with exit code ${result.status ?? 'unknown'}`);
}
function runCapture(command, args, cwd, label = command) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true });
  if (result.error || result.status !== 0) fail(`${label} failed: ${(result.stderr || result.stdout || result.error?.message || '').trim()}`);
  return result.stdout.trim();
}
function copyTree(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(source, destination, { recursive: true, dereference: false });
}
function chromiumVersion(source) {
  const versionFile = path.join(source, 'chrome', 'VERSION');
  if (!fs.existsSync(versionFile)) fail(`Chromium source is missing ${versionFile}`);
  const values = Object.fromEntries(fs.readFileSync(versionFile, 'utf8').split(/\r?\n/).map((line) => line.split('=')).filter(([key, value]) => key && value));
  return [values.MAJOR, values.MINOR, values.BUILD, values.PATCH].join('.');
}
function ensureTool(tool) {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  try { runCapture(locator, [tool], process.cwd(), `checking ${tool}`); } catch { fail(`${tool} was not found on PATH; install depot_tools/Visual Studio prerequisites first`); }
}
function sourceCheckout(source, version, skipSync) {
  const parent = path.dirname(source);
  fs.mkdirSync(parent, { recursive: true });
  const versionFile = path.join(source, 'chrome', 'VERSION');
  const sourceGit = path.join(source, '.git');
  const parentGclient = path.join(parent, '.gclient');
  const hasChromiumCheckout = fs.existsSync(versionFile) && fs.existsSync(sourceGit);
  const parentIsGclientCheckout = fs.existsSync(parentGclient);
  if (!hasChromiumCheckout) {
    if (parentIsGclientCheckout) {
      // `fetch chromium` is only valid in an empty parent directory. A
      // previous interrupted fetch leaves a .gclient file behind, and the
      // official tool requires gclient sync to resume that checkout.
      run('gclient', ['sync', '--with_branch_heads', '--with_tags'], parent, 'resuming Chromium source checkout');
    } else {
      const parentEntries = fs.existsSync(parent)
        ? fs.readdirSync(parent).filter((entry) => entry !== '.DS_Store')
        : [];
      if (parentEntries.length > 0) fail(`source checkout is incomplete at ${source}; remove or repair the existing directory, then retry`);
      run('fetch', ['--nohooks', 'chromium'], parent, 'fetching Chromium source');
    }
  }
  if (!fs.existsSync(versionFile)) fail(`Chromium source checkout is incomplete: ${source} is missing chrome/VERSION; run gclient sync and retry`);
  const actual = chromiumVersion(source);
  if (actual !== version) {
    run('git', ['checkout', '--detach', `refs/tags/${version}`], source, `checking out Chromium ${version}`);
  } else {
    run('git', ['status', '--short'], source, 'checking source tree status');
  }
  const checkedOut = chromiumVersion(source);
  if (checkedOut !== version) fail(`source VERSION is ${checkedOut}, expected ${version}`);
  if (!skipSync) {
    run('gclient', ['sync', '--with_branch_heads', '--with_tags'], parent, 'synchronizing Chromium dependencies');
    run('gclient', ['runhooks'], parent, 'running Chromium hooks');
  }
  return runCapture('git', ['rev-parse', 'HEAD'], source, 'recording Chromium source revision');
}
function applyOverlay(source, version) {
  const destination = path.join(source, 'chrome', 'app', 'theme', 'chromium', 'BRANDING');
  if (!fs.existsSync(overlay)) fail(`project branding overlay is missing: ${overlay}`);
  if (!fs.existsSync(path.dirname(destination))) fail(`Chromium branding directory is missing at ${path.dirname(destination)}; the pinned source layout changed`);
  fs.copyFileSync(overlay, destination);
  const marker = {
    product: 'InkBrowser',
    chromiumVersion: version,
    overlay: 'tools/inkbrowser/source/BRANDING',
    overlaySha256: sha256(overlay),
  };
  fs.writeFileSync(path.join(source, 'inkbrowser-source-build.json'), `${JSON.stringify(marker, null, 2)}\n`);
  return marker;
}
function build(source, outBuild, skipBuild) {
  fs.mkdirSync(outBuild, { recursive: true });
  fs.copyFileSync(gnArgs, path.join(outBuild, 'args.gn'));
  if (skipBuild) return;
  run('gn', ['gen', outBuild, '--fail-on-unused-args'], source, 'generating GN files');
  run('autoninja', ['-C', outBuild, 'chrome'], source, 'building Chromium chrome target');
}
function stage(source, buildDir, outDir, version, revision, marker, outBuild) {
  const builtExe = path.join(buildDir, 'chrome.exe');
  if (!fs.existsSync(builtExe)) fail(`source build output is missing ${builtExe}; do not stage an archive or vendor binary`);
  const staged = `${outDir}.partial-${process.pid}`;
  fs.rmSync(staged, { recursive: true, force: true });
  copyTree(buildDir, staged);
  const launcher = path.join(staged, 'inkbrowser-chrome.exe');
  fs.renameSync(path.join(staged, 'chrome.exe'), launcher);
  if (!fs.existsSync(iconFile)) fail(`InkBrowser icon is missing: ${iconFile}`);
  fs.copyFileSync(iconFile, path.join(staged, 'inkbrowser-chrome.ico'));
  const rcedit = arg('--rcedit');
  if (rcedit) {
    run(rcedit, [launcher, '--set-icon', iconFile, '--set-version-string', 'ProductName', 'InkBrowser', '--set-version-string', 'FileDescription', 'InkBrowser Chromium'], root, 'embedding InkBrowser icon and name');
  } else {
    console.warn('[build-chromium-source] --rcedit not supplied; icon is staged beside the executable and Chromium branding comes from the source overlay');
  }
  const manifest = {
    schema: 'octo.engine-manifest.v1',
    kind: 'chromium',
    distribution: 'source-built',
    modified: true,
    product: 'InkBrowser',
    version,
    executable: 'inkbrowser-chrome.exe',
    platforms: ['win32-x64'],
    protocol: 'cdp',
    capabilities: ['window', 'tabs', 'navigation', 'crash-recovery'],
    branding: { product: 'InkBrowser', executableIcon: 'inkbrowser-chrome.ico', iconSource: 'branding/inkbrowser-chrome/icon.ico' },
    sha256: sha256(launcher),
    source: {
      repository: 'https://chromium.googlesource.com/chromium/src.git',
      tag: `refs/tags/${version}`,
      revision,
      overlay: marker,
      gnArgs: 'tools/inkbrowser/gn/release.gn',
      gnArgsSha256: sha256(gnArgs),
      buildOutput: path.relative(root, outBuild).replaceAll(path.sep, '/'),
      license: 'Chromium BSD-3-Clause and included third-party notices; retain all upstream notices.',
    },
  };
  fs.writeFileSync(path.join(staged, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(staged, 'NOTICE.chromium.txt'), `InkBrowser source-built Chromium ${version}\nChromium revision: ${revision}\nSource tag: refs/tags/${version}\nBranding overlay SHA-256: ${marker.overlaySha256}\nThis runtime was built from Chromium source; it is not Chrome for Testing and was not made by renaming a vendor executable.\nRetain the Chromium and third-party license notices included in this directory.\n`);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  fs.renameSync(staged, outDir);
  console.log(`[build-chromium-source] staged source-built InkBrowser Chromium at ${outDir}`);
}
function main() {
  if (process.platform !== 'win32') fail('this workflow targets Windows x64; run it on the Windows build machine, not the Linux sandbox');
  const target = arg('--target', targetDefault);
  if (target !== targetDefault) fail(`unsupported target ${target}; only ${targetDefault} is implemented by this source-build workflow`);
  const version = arg('--version', versionDefault);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) fail(`invalid Chromium version: ${version}`);
  ensureTool('git');
  ensureTool('fetch');
  ensureTool('gclient');
  ensureTool('gn');
  ensureTool('autoninja');
  const source = path.resolve(arg('--source', path.join('C:\\src', 'chromium', 'src')));
  const outBuild = path.resolve(arg('--out-build', path.join(source, 'out', 'InkBrowser')));
  const outDir = path.resolve(arg('--out', path.join(root, 'resources', 'engines', 'chromium', version)));
  const revision = sourceCheckout(source, version, flag('--skip-sync'));
  const marker = applyOverlay(source, version);
  build(source, outBuild, flag('--skip-build'));
  stage(source, outBuild, outDir, version, revision, marker, outBuild);
}
try { main(); } catch (error) { console.error(String(error?.stack ?? error?.message ?? error)); process.exitCode = 1; }
