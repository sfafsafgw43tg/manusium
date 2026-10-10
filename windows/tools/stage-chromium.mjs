// Stage a pinned compatibility Chromium runtime for non-Windows development only.
// Windows releases must use build-chromium-source.mjs and a source-built binary.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CHROMIUM_VERSION = '155.0.8059.39';
const ARTIFACTS = {
  'win32-x64': { platform: 'win64', archive: 'chrome-win64.zip', sha256: '59ab2a6e99bde9c0bc180414988394f9f5355a0d3764c704151ee8ecea235c7e', executable: 'inkbrowser-chrome.exe' },
  'linux-x64': { platform: 'linux64', archive: 'chrome-linux64.zip', sha256: '55672d1f392fd3e7b7a08621b6e804e6bcb39d40cf155504abb74b3a021ea8ea', executable: 'inkbrowser-chrome' },
};
const capabilities = ['window', 'tabs', 'navigation', 'crash-recovery'];
function arg(name, fallback = '') { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1] ?? fallback; }
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function fail(message) { throw new Error(`[stage-chromium] ${message}`); }
function downloadVerified(urls, destination, expected) {
  const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const errors = [];
  for (const url of urls) {
    try {
      fs.rmSync(destination, { force: true });
      console.log(`[stage-chromium] downloading ${url}`);
      execFileSync(curl, ['-fL', '--retry', '3', '--retry-delay', '2', '--connect-timeout', '20', url, '-o', destination], { stdio: 'inherit' });
      const actual = sha256(destination);
      if (actual === expected) return url;
      errors.push(`${url}: checksum ${actual}`);
      fs.rmSync(destination, { force: true });
    } catch (error) {
      errors.push(`${url}: ${String(error?.message ?? error)}`);
      fs.rmSync(destination, { force: true });
    }
  }
  fail(`all Chromium mirrors failed for ${path.basename(destination)} (expected ${expected}): ${errors.join(' | ')}`);
}
function extractZip(zip, destination) {
  if (process.platform === 'win32') {
    // Stock Windows does not guarantee an unzip.exe installation.
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      '& { param($archive, $target); $ErrorActionPreference = "Stop"; Expand-Archive -LiteralPath $archive -DestinationPath $target -Force }',
      zip, destination,
    ], { stdio: 'inherit' });
    return;
  }
  execFileSync('unzip', ['-q', '-o', zip, '-d', destination], { stdio: 'inherit' });
}
function stage(target, outDir) {
  if (target === 'win32-x64') fail('Windows Chromium must be built from the pinned source checkout; Chrome for Testing archives are not accepted. Run npm run build:chromium:windows on Windows.');
  const artifact = ARTIFACTS[target];
  if (!artifact) fail(`unsupported target ${target}; supported targets: ${Object.keys(ARTIFACTS).join(', ')}`);
  const url = `https://storage.googleapis.com/chrome-for-testing-public/${CHROMIUM_VERSION}/${artifact.platform}/${artifact.archive}`;
  const mirrors = [url, `https://commondatastorage.googleapis.com/chrome-for-testing-public/${CHROMIUM_VERSION}/${artifact.platform}/${artifact.archive}`];
  const cache = path.join(arg('--cache', path.join(os.homedir(), '.cache', 'octosuite')), artifact.archive.replace('.zip', `-${CHROMIUM_VERSION}.zip`));
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  let acquiredFrom = url;
  if (fs.existsSync(cache) && sha256(cache) === artifact.sha256) {
    console.log(`[stage-chromium] using verified cache ${cache}`);
  } else {
    acquiredFrom = downloadVerified(mirrors, cache, artifact.sha256);
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-chromium-'));
  try {
    extractZip(cache, temp);
    const extracted = path.join(temp, artifact.archive.replace('.zip', ''));
    if (!fs.existsSync(extracted)) fail(`archive did not contain expected directory ${artifact.archive.replace('.zip', '')}`);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.cpSync(extracted, outDir, { recursive: true });
    const sourceExe = path.join(outDir, target === 'win32-x64' ? 'chrome.exe' : 'chrome');
    const exe = path.join(outDir, artifact.executable);
    if (!fs.existsSync(sourceExe)) fail(`runtime executable missing: ${sourceExe}`);
    if (sourceExe !== exe) fs.renameSync(sourceExe, exe);
    if (target !== 'win32-x64') fs.chmodSync(exe, 0o755);
    const manifest = {
      schema: 'octo.engine-manifest.v1', kind: 'chromium', version: CHROMIUM_VERSION,
      executable: artifact.executable, protocol: 'cdp', platforms: [target], capabilities,
      sha256: sha256(exe), source: { url: acquiredFrom, mirrors, archiveSha256: artifact.sha256, license: 'Chrome for Testing distribution; retain ABOUT and upstream notices.' },
    };
    fs.writeFileSync(path.join(outDir, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(path.join(outDir, 'NOTICE.chromium.txt'), `Chromium ${CHROMIUM_VERSION} acquired from Chrome for Testing.\nSource: ${acquiredFrom}\nMirrors: ${mirrors.join(', ')}\nArchive SHA-256: ${artifact.sha256}\nSee ABOUT and the upstream Chromium licensing notices included in this runtime.\n`);
    console.log(`[stage-chromium] staged ${CHROMIUM_VERSION} ${target} at ${outDir}`);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
const target = arg('--target', process.platform === 'win32' ? 'win32-x64' : 'linux-x64');
const out = arg('--out', path.join(root, 'resources', 'engines', 'chromium', CHROMIUM_VERSION));
try { stage(target, path.resolve(out)); } catch (error) { console.error(String(error?.message ?? error)); process.exitCode = 1; }
