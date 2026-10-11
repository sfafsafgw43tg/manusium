#!/usr/bin/env node
/**
 * Verify the Chromium runtime after Electron Builder has copied it into
 * release/octobrowser/win-unpacked/resources/engines.
 *
 * This validates packaging completeness and manifest integrity. It does not
 * claim that a binary can execute; execution is covered by the Windows native
 * packaged-runtime test.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.env.INKBROWSER_CHROMIUM_VERSION ?? '155.0.8059.39';
const suppliedRoot = process.argv.find((arg) => arg.startsWith('--root='))?.slice('--root='.length);
const packageRoot = path.resolve(suppliedRoot ?? path.join(repoRoot, 'release', 'octobrowser', 'win-unpacked'));
const runtimeRoot = path.join(packageRoot, 'resources', 'engines', 'chromium', version);
const manifestPath = path.join(runtimeRoot, 'runtime.json');
const executable = path.join(runtimeRoot, 'inkbrowser-chrome.exe');
const required = [
  'inkbrowser-chrome.exe',
  'chrome.dll',
  'chrome_elf.dll',
  'chrome_child.dll',
  'resources.pak',
  'chrome_100_percent.pak',
  'chrome_200_percent.pak',
  'icudtl.dat',
  'v8_context_snapshot.bin',
  'locales/en-US.pak',
];

function fail(message) {
  console.error(`[verify-packaged-chromium] ${message}`);
  process.exitCode = 1;
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function relative(file) {
  return path.relative(repoRoot, file) || file;
}

if (!fs.existsSync(packageRoot)) {
  fail(`packaged application directory is missing: ${relative(packageRoot)}; run the Windows packaging step first`);
} else if (!fs.existsSync(manifestPath)) {
  fail(`packaged Chromium manifest is missing: ${relative(manifestPath)}`);
} else {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.schema !== 'octo.engine-manifest.v1' || manifest.kind !== 'chromium') throw new Error('runtime manifest schema/kind is invalid');
    if (manifest.version !== version || manifest.executable !== 'inkbrowser-chrome.exe') throw new Error(`runtime manifest is not pinned to Chromium ${version}`);
    if (!Array.isArray(manifest.platforms) || !manifest.platforms.includes('win32-x64')) throw new Error('runtime manifest does not support win32-x64');
    if (manifest.distribution !== 'source-built' || manifest.modified !== true) throw new Error('runtime is not marked as a modified source-built Chromium runtime');
    for (const name of required) {
      const file = path.join(runtimeRoot, ...name.split('/'));
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`required packaged Chromium file is missing: ${name}`);
    }
    const actual = sha256(executable);
    if (!/^[a-f0-9]{64}$/i.test(String(manifest.sha256)) || actual.toLowerCase() !== String(manifest.sha256).toLowerCase()) {
      throw new Error('packaged Chromium executable SHA-256 does not match runtime.json');
    }
    console.log(`[verify-packaged-chromium] verified ${relative(runtimeRoot)} with ${required.length} required files (${actual})`);
  } catch (error) {
    fail(String(error?.message ?? error));
  }
}
