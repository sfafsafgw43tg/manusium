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
import { spawn, spawnSync } from 'node:child_process';
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
function displayArg(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:=+-]+$/.test(text) ? text : JSON.stringify(text);
}
function displayCommand(command, args, cwd) {
  return `${displayArg(command)} ${args.map(displayArg).join(' ')} (cwd=${displayArg(cwd)})`;
}
function quoteCmdArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=+-]+$/.test(text)) return text;
  return `"${text.replaceAll('"', '\\"')}"`;
}
function resolveWindowsCommand(command) {
  if (process.platform !== 'win32' || path.isAbsolute(command) || /[\\/]/.test(command)) return command;
  const located = spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true });
  if (located.status === 0 && located.stdout.trim()) return located.stdout.trim().split(/\r?\n/)[0];
  return command;
}
function prepareLaunch(command, args) {
  if (process.platform !== 'win32') return { file: command, args, display: displayCommand(command, args, process.cwd()) };
  const resolved = resolveWindowsCommand(command);
  if (!/\.(?:bat|cmd)$/i.test(resolved)) return { file: resolved, args, display: displayCommand(resolved, args, process.cwd()) };
  const commandLine = [quoteCmdArg(resolved), ...args.map(quoteCmdArg)].join(' ');
  const launchArgs = ['/d', '/s', '/c', `"${commandLine}"`];
  return { file: process.env.ComSpec || 'cmd.exe', args: launchArgs, display: displayCommand(process.env.ComSpec || 'cmd.exe', launchArgs, process.cwd()) };
}
function run(command, args, cwd, label = command) {
  console.log(`[build-chromium-source] ${label}`);
  const launch = prepareLaunch(command, args);
  console.log(`[build-chromium-source] exec: ${displayCommand(launch.file, launch.args, cwd)}`);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(launch.file, launch.args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: false,
    });
    let lastOutput = Date.now();
    const forward = (chunk) => {
      lastOutput = Date.now();
      process.stdout.write(chunk);
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    const heartbeat = setInterval(() => {
      if (Date.now() - lastOutput >= 10000) {
        const elapsed = Math.floor((Date.now() - started) / 1000);
        console.log(`[build-chromium-source] still active: ${label} (${elapsed}s; waiting for Git/network output)`);
        lastOutput = Date.now();
      }
    }, 10000);
    child.once('error', (error) => {
      clearInterval(heartbeat);
      reject(new Error(`${label} failed: ${error.message}`));
    });
    child.once('close', (code) => {
      clearInterval(heartbeat);
      console.log(`[build-chromium-source] exit: ${displayCommand(launch.file, launch.args, cwd)} -> ${code ?? 'unknown'}`);
      if (code !== 0) reject(new Error(`${label} failed with exit code ${code ?? 'unknown'}`));
      else resolve();
    });
  });
}
function runCapture(command, args, cwd, label = command) {
  const launch = prepareLaunch(command, args);
  console.log(`[build-chromium-source] probe: ${displayCommand(launch.file, launch.args, cwd)}`);
  const result = spawnSync(launch.file, launch.args, { cwd, encoding: 'utf8', shell: false, windowsHide: true });
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
async function sourceCheckout(source, version, skipSync) {
  const parent = path.dirname(source);
  fs.mkdirSync(parent, { recursive: true });
  // install.bat bootstraps depot_tools before this script runs. Prevent the
  // wrapper from silently self-updating again at the start of every fetch;
  // that is the source of the apparent pause at "Updating depot_tools...".
  // Do not preserve an inherited DEPOT_TOOLS_UPDATE=1 (or another value) from
  // a developer shell: this build must use the depot_tools already bootstrapped
  // by install.bat and must not silently start a second self-update.
  process.env.DEPOT_TOOLS_UPDATE = '0';
  console.log('[build-chromium-source] using the bootstrapped depot_tools; automatic self-update disabled');
  const versionFile = path.join(source, 'chrome', 'VERSION');
  const sourceGit = path.join(source, '.git');
  const parentGclient = path.join(parent, '.gclient');
  await run('git', ['config', '--global', 'depot-tools.allowGlobalGitConfig', 'false'], parent, 'suppressing depot_tools global Git recommendation');
  const jobs = String(Math.max(2, Math.min(12, os.cpus().length)));
  // Keep the base command compatible with older depot_tools shipped on clean
  // Windows machines. Long-form options vary between depot_tools revisions.
  const syncArgs = ['sync', '-n', '-v', `-j${jobs}`];
  console.log('[build-chromium-source] using compatible gclient sync flags: -n -v -j' + jobs);
  const hasChromiumCheckout = fs.existsSync(versionFile) && fs.existsSync(sourceGit);
  let parentEntries = fs.existsSync(parent)
    ? fs.readdirSync(parent).filter((entry) => entry !== '.DS_Store')
    : [];
  // install.bat is allowed to repair the exact partial layout left by an
  // interrupted depot_tools fetch. Never remove an arbitrary non-empty folder:
  // require only gclient metadata and known temporary Chromium checkout names.
  const isKnownPartial = !hasChromiumCheckout && parentEntries.length > 0 &&
    parentEntries.includes('.gclient') && parentEntries.every((entry) =>
      entry === '.gclient' || entry === '.gclient_entries' || entry === '.cipd' ||
      entry === 'src' || entry.startsWith('gclient_src_'));
  if (isKnownPartial && process.env.OCTO_NO_AUTO_REPAIR !== '1') {
    console.warn('[build-chromium-source] removing the recognized incomplete Chromium checkout and restarting shallow');
    fs.rmSync(parent, { recursive: true, force: true });
    fs.mkdirSync(parent, { recursive: true });
    parentEntries = [];
  }
  const parentIsGclientCheckout = fs.existsSync(parentGclient);
  if (!hasChromiumCheckout) {
    if (parentIsGclientCheckout) {
      // `fetch chromium` is only valid in an empty parent directory. A
      // previous interrupted fetch leaves a .gclient file behind, and the
      // official tool requires gclient sync to resume that checkout.
       await run('gclient', syncArgs, parent, 'resuming Chromium source checkout (no history, parallel)');
    } else {
      if (parentEntries.length > 0) fail(`source checkout is incomplete at ${source}; remove or repair the existing directory, then retry`);
      await run('fetch', ['--nohooks', '--no-history', 'chromium'], parent, 'fetching Chromium source (no history)');
    }
  }
  if (!fs.existsSync(versionFile)) fail(`Chromium source checkout is incomplete: ${source} is missing chrome/VERSION; run gclient sync and retry`);
  const actual = chromiumVersion(source);
  if (actual !== version) {
    const tag = `refs/tags/${version}`;
    const pinnedCommit = runCapture('git', ['rev-list', '-n', '1', tag], source, `resolving Chromium tag ${tag}`).trim();
    if (!/^[0-9a-f]{40}$/i.test(pinnedCommit)) fail(`Chromium tag ${tag} did not resolve to a commit`);
    await run('git', ['checkout', '--detach', pinnedCommit], source, `checking out Chromium ${version} (${pinnedCommit})`);
  } else {
    await run('git', ['status', '--short'], source, 'checking source tree status');
  }
  const checkedOut = chromiumVersion(source);
  if (checkedOut !== version) fail(`source VERSION is ${checkedOut}, expected ${version}`);
  if (!skipSync) {
    console.log('[build-chromium-source] phase: synchronizing Chromium dependencies');
    await run('gclient', syncArgs, parent, 'synchronizing Chromium dependencies (no history, parallel)');
    console.log('[build-chromium-source] phase: installing Chromium build hooks and tools');
    await run('gclient', ['runhooks'], parent, 'running Chromium hooks');
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
async function build(source, outBuild, skipBuild) {
  fs.mkdirSync(outBuild, { recursive: true });
  fs.copyFileSync(gnArgs, path.join(outBuild, 'args.gn'));
  if (skipBuild) return;
  await run('gn', ['gen', outBuild, '--fail-on-unused-args'], source, 'generating GN files');
  await run('autoninja', ['-C', outBuild, 'chrome'], source, 'building Chromium chrome target');
}
async function stage(source, buildDir, outDir, version, revision, marker, outBuild) {
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
    await run(rcedit, [launcher, '--set-icon', iconFile, '--set-version-string', 'ProductName', 'InkBrowser', '--set-version-string', 'FileDescription', 'InkBrowser Chromium'], root, 'embedding InkBrowser icon and name');
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
async function main() {
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
  const revision = await sourceCheckout(source, version, flag('--skip-sync'));
  const marker = applyOverlay(source, version);
  await build(source, outBuild, flag('--skip-build'));
  await stage(source, outBuild, outDir, version, revision, marker, outBuild);
}
main().catch((error) => { console.error(String(error?.stack ?? error?.message ?? error)); process.exitCode = 1; });
