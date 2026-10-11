#!/usr/bin/env node
/**
 * Verify the Windows Chromium runtime that will be bundled for normal users.
 * This is intentionally a verifier only: it never installs Visual Studio,
 * fetches source, or accepts a Chrome for Testing/repackaged runtime.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.env.INKBROWSER_CHROMIUM_VERSION ?? '155.0.8059.39';
const runtimeRoot = path.join(root, 'resources', 'engines', 'chromium', version);
const executable = path.join(runtimeRoot, 'inkbrowser-chrome.exe');
const manifestPath = path.join(runtimeRoot, 'runtime.json');

function fail(message) {
  console.error(`[verify-prebuilt-chromium] ${message}`);
  process.exitCode = 1;
}
function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

if (process.platform !== 'win32') {
  fail('This verifier is for the Windows release package. Run it on the Windows build machine.');
} else if (!fs.existsSync(executable) || !fs.existsSync(manifestPath)) {
  fail(`Missing bundled runtime at ${path.relative(root, runtimeRoot)}. Run the developer/CI source-build workflow before packaging.`);
} else {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const actual = digest(executable);
    if (manifest.schema !== 'octo.engine-manifest.v1' || manifest.kind !== 'chromium') throw new Error('runtime manifest schema/kind is invalid');
    if (manifest.version !== version || manifest.executable !== 'inkbrowser-chrome.exe') throw new Error(`runtime manifest is not pinned to Chromium ${version}`);
    if (!Array.isArray(manifest.platforms) || !manifest.platforms.includes('win32-x64')) throw new Error('runtime manifest does not support win32-x64');
    if (manifest.distribution !== 'source-built' || manifest.modified !== true) throw new Error('runtime is not marked as a modified source-built Chromium runtime');
    if (!/^[a-f0-9]{64}$/i.test(String(manifest.sha256)) || actual.toLowerCase() !== String(manifest.sha256).toLowerCase()) throw new Error('runtime executable SHA-256 does not match runtime.json');
    console.log(`[verify-prebuilt-chromium] verified ${path.relative(root, executable)} (${actual})`);
  } catch (error) {
    fail(String(error?.message ?? error));
  }
}
