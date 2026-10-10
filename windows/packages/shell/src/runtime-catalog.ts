import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ENGINE_MANIFEST_SCHEMA, type EngineCapability, type EngineManifest } from './engine-runtime';

export type RuntimeChannel = 'stable' | 'beta';
export type RuntimeSupport = 'supported' | 'retired';
export interface ChromiumCatalogEntry {
  version: string; channel: RuntimeChannel; support: RuntimeSupport; default?: boolean;
  platform: 'linux-x64' | 'win32-x64'; source: string; archiveSha256: string;
  executable: string; manifest: Pick<EngineManifest, 'schema' | 'kind' | 'protocol' | 'capabilities'>;
  retirementReason?: string;
}

// Updated by the release-maintenance workflow from Chrome for Testing metadata.
// Every URL and checksum is pinned; installation never resolves "latest".
export const CHROMIUM_CATALOG: readonly ChromiumCatalogEntry[] = [
  { version: '155.0.8059.39', channel: 'stable', support: 'supported', default: true, platform: 'linux-x64', source: 'https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.39/linux64/chrome-linux64.zip', archiveSha256: '55672d1f392fd3e7b7a08621b6e804e6bcb39d40cf155504abb74b3a021ea8ea', executable: 'inkbrowser-chrome', manifest: { schema: ENGINE_MANIFEST_SCHEMA, kind: 'chromium', protocol: 'cdp', capabilities: ['window', 'tabs', 'navigation', 'crash-recovery'] } },
  { version: '155.0.8059.39', channel: 'stable', support: 'supported', default: true, platform: 'win32-x64', source: 'https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.39/win64/chrome-win64.zip', archiveSha256: '59ab2a6e99bde9c0bc180414988394f9f5355a0d3764c704151ee8ecea235c7e', executable: 'inkbrowser-chrome.exe', manifest: { schema: ENGINE_MANIFEST_SCHEMA, kind: 'chromium', protocol: 'cdp', capabilities: ['window', 'tabs', 'navigation', 'crash-recovery'] } },
  { version: '156.0.8078.12', channel: 'beta', support: 'supported', platform: 'linux-x64', source: 'https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.12/linux64/chrome-linux64.zip', archiveSha256: 'e83a1cd8ea29a20b43748ee1e7ea414e091429b7d4869ee29aec08c13583111c', executable: 'inkbrowser-chrome', manifest: { schema: ENGINE_MANIFEST_SCHEMA, kind: 'chromium', protocol: 'cdp', capabilities: ['window', 'tabs', 'navigation', 'crash-recovery'] } },
  { version: '156.0.8078.12', channel: 'beta', support: 'supported', platform: 'win32-x64', source: 'https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.12/win64/chrome-win64.zip', archiveSha256: '3afa11a86d390f83dc108c218a8fde04d68f2a9c4fd4cd010db0f2cde4837e5c', executable: 'inkbrowser-chrome.exe', manifest: { schema: ENGINE_MANIFEST_SCHEMA, kind: 'chromium', protocol: 'cdp', capabilities: ['window', 'tabs', 'navigation', 'crash-recovery'] } },
  { version: '140.0.7339.207', channel: 'stable', support: 'retired', platform: 'linux-x64', source: 'https://storage.googleapis.com/chrome-for-testing-public/140.0.7339.207/linux64/chrome-linux64.zip', archiveSha256: 'ba5e4c245945118a2b462749bec08ed6797b67559de5f49ab20186177d3b9ec7', executable: 'inkbrowser-chrome', manifest: { schema: ENGINE_MANIFEST_SCHEMA, kind: 'chromium', protocol: 'cdp', capabilities: ['window', 'tabs', 'navigation', 'crash-recovery'] }, retirementReason: 'Security support ended; retained only for compatibility migration.' },
] as const;

export const DEFAULT_CHROMIUM_VERSION = CHROMIUM_CATALOG.find((e) => e.default && e.support === 'supported')!.version;
export function catalogForPlatform(platform = process.platform, arch = process.arch): ChromiumCatalogEntry[] {
  const key = `${platform}-${arch}` as ChromiumCatalogEntry['platform'];
  return CHROMIUM_CATALOG.filter((e) => e.platform === key);
}
export function catalogEntry(version: string, platform = process.platform, arch = process.arch): ChromiumCatalogEntry {
  const entry = catalogForPlatform(platform, arch).find((e) => e.version === version);
  if (!entry) throw new Error(`No catalog entry for Chromium ${version} on ${platform}-${arch}`);
  return entry;
}
export function validateCatalog(entries = CHROMIUM_CATALOG): void {
  const platforms = [...new Set(entries.map((e) => e.platform))];
  for (const platform of platforms) if (entries.filter((e) => e.platform === platform && e.default && e.support === 'supported').length !== 1) throw new Error(`Chromium catalog must have exactly one supported default for ${platform}`);
  for (const e of entries) {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(e.version) || !/^https:\/\//.test(e.source) || !/^[a-f0-9]{64}$/.test(e.archiveSha256)) throw new Error(`Invalid catalog entry ${e.version}`);
    if (e.manifest.schema !== ENGINE_MANIFEST_SCHEMA || e.manifest.kind !== 'chromium' || e.manifest.protocol !== 'cdp') throw new Error(`Invalid manifest metadata for ${e.version}`);
  }
}

function digest(file: string): string { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function safeExtract(zip: string, temp: string): void {
  const listingText = process.platform === 'win32'
    ? execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      '& { param($archive); Add-Type -AssemblyName System.IO.Compression.FileSystem; $z = [IO.Compression.ZipFile]::OpenRead($archive); try { $z.Entries | ForEach-Object { $_.FullName } } finally { $z.Dispose() } }',
      zip,
    ], { encoding: 'utf8' })
    : execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' });
  const listing = listingText.split(/\r?\n/).filter(Boolean);
  for (const item of listing) { const clean = item.replace(/\\/g, '/'); if (clean.startsWith('/') || clean.split('/').includes('..')) throw new Error(`Unsafe archive path: ${item}`); }
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      '& { param($archive, $target); $ErrorActionPreference = "Stop"; Expand-Archive -LiteralPath $archive -DestinationPath $target -Force }',
      zip, temp,
    ]);
  } else {
    execFileSync('unzip', ['-q', '-o', zip, '-d', temp]);
  }
}
export interface InstalledRuntime { entry: ChromiumCatalogEntry; rootDir: string; executablePath: string; installed: boolean; }
export function listInstalled(root: string, platform = process.platform, arch = process.arch): InstalledRuntime[] {
  return catalogForPlatform(platform, arch).map((entry) => { const rootDir = path.join(root, entry.version); const manifestPath = path.join(rootDir, 'runtime.json'); let installed = false; try { const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); const sourceBuilt = platform !== 'win32' || m.distribution === 'source-built'; installed = sourceBuilt && m.version === entry.version && m.sha256 === digest(path.join(rootDir, entry.executable)) && fs.existsSync(path.join(rootDir, entry.executable)); } catch { /* not installed or incomplete */ } return { entry, rootDir, executablePath: path.join(rootDir, entry.executable), installed }; });
}
export function installChromium(entry: ChromiumCatalogEntry, root: string, fetch = true): InstalledRuntime {
  if (entry.support === 'retired') throw new Error(`Cannot install retired Chromium ${entry.version}`);
  if (entry.platform === 'win32-x64') throw new Error('Windows Chromium must be built from the pinned source checkout; Chrome for Testing archives are not accepted. Run npm run build:chromium:windows on Windows.');
  fs.mkdirSync(root, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-runtime-')); const archive = path.join(temp, 'runtime.zip'); const unpacked = path.join(temp, 'unpacked');
  try {
    if (fetch) {
      const downloader = process.platform === 'win32' ? 'curl.exe' : 'curl';
      const mirrors = [entry.source, entry.source.replace('https://storage.googleapis.com/', 'https://commondatastorage.googleapis.com/')];
      const errors: string[] = [];
      let acquired = false;
      for (const url of mirrors) {
        try {
          fs.rmSync(archive, { force: true });
          execFileSync(downloader, ['-fL', '--retry', '3', '--retry-delay', '2', '--connect-timeout', '20', url, '-o', archive], { stdio: 'inherit' });
          if (digest(archive) === entry.archiveSha256) { acquired = true; break; }
          errors.push(`${url}: checksum mismatch`);
        } catch (error) { errors.push(`${url}: ${String(error instanceof Error ? error.message : error)}`); }
      }
      if (!acquired) throw new Error(`all Chromium mirrors failed for ${entry.version}: ${errors.join(' | ')}`);
    }
    if (digest(archive) !== entry.archiveSha256) throw new Error(`Archive checksum mismatch for ${entry.version}`);
    safeExtract(archive, unpacked);
    const sourceRoot = path.join(unpacked, entry.platform.startsWith('win') ? 'chrome-win64' : 'chrome-linux64');
    const exeSource = path.join(sourceRoot, entry.platform.startsWith('win') ? 'chrome.exe' : 'chrome');
    if (!fs.existsSync(exeSource)) throw new Error(`Runtime executable missing for ${entry.version}`);
    const finalRoot = path.join(root, entry.version); const staged = `${finalRoot}.partial-${process.pid}`;
    fs.rmSync(staged, { recursive: true, force: true }); fs.cpSync(sourceRoot, staged, { recursive: true });
    const executablePath = path.join(staged, entry.executable); fs.renameSync(exeSource.replace(sourceRoot, staged), executablePath);
    if (!entry.platform.startsWith('win')) fs.chmodSync(executablePath, 0o755);
    const manifest = { ...entry.manifest, version: entry.version, executable: entry.executable, platforms: [entry.platform], capabilities: entry.manifest.capabilities as EngineCapability[], sha256: digest(executablePath), source: { url: entry.source, archiveSha256: entry.archiveSha256, license: 'Chrome for Testing distribution; preserve ABOUT and upstream notices.' } };
    fs.writeFileSync(path.join(staged, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`); fs.writeFileSync(path.join(staged, 'NOTICE.chromium.txt'), `Chromium ${entry.version} (${entry.channel}) from Chrome for Testing.\nSource: ${entry.source}\nArchive SHA-256: ${entry.archiveSha256}\n`);
    fs.rmSync(finalRoot, { recursive: true, force: true }); fs.renameSync(staged, finalRoot);
    return { entry, rootDir: finalRoot, executablePath: path.join(finalRoot, entry.executable), installed: true };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
export function removeChromium(entry: ChromiumCatalogEntry, root: string, inUse: boolean): void { if (inUse) throw new Error(`Chromium ${entry.version} is in use`); fs.rmSync(path.join(root, entry.version), { recursive: true, force: false }); }
validateCatalog();
