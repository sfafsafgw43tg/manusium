import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

/** Pinned official Mozilla Firefox runtime artifacts. */
export interface GeckoCatalogEntry {
  version: string;
  platform: 'linux-x64' | 'win32-x64';
  source: string;
  archiveSha512: string;
  executable: string;
  sourceExecutable: string;
  license: string;
  format: 'tar.xz' | 'msi';
}

export interface InstalledGeckoRuntime {
  entry: GeckoCatalogEntry;
  rootDir: string;
  executablePath: string;
  installed: boolean;
}

const LICENSE = 'MPL-2.0 with additional binary components and Mozilla trademark restrictions; preserve upstream notices.';

export const FIREFOX_CATALOG: readonly GeckoCatalogEntry[] = [
  {
    version: '140.0', platform: 'linux-x64',
    source: 'https://ftp.mozilla.org/pub/firefox/releases/140.0/linux-x86_64/en-US/firefox-140.0.tar.xz',
    archiveSha512: '481bb473c1c8279626e25d7253ee1735ca42e6898a5a664b21f1189d2779c2ecb555536eb46bcb2ac88066c286e831e17b23b877d7cd2d3b650083198c6dedc6',
    executable: 'inkbrowser-firefox', sourceExecutable: 'firefox', license: LICENSE, format: 'tar.xz',
  },
  {
    version: '140.0', platform: 'win32-x64',
    source: 'https://ftp.mozilla.org/pub/firefox/releases/140.0/win64/en-US/Firefox%20Setup%20140.0.msi',
    archiveSha512: 'cf9f2be17a44e87f5ba03f32d6f25be42555df471e3f1fef17c907a6b9292545c7af1f88a1b1d0bce937a530ecab91d6c28fdb6d22a4a9b3a0f68336accf86a2',
    executable: 'inkbrowser-firefox.exe', sourceExecutable: 'firefox.exe', license: LICENSE, format: 'msi',
  },
] as const;

function sha512(file: string): string { return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('hex'); }
function sha256(file: string): string { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function safeTarList(archive: string): void {
  const listing = execFileSync('tar', ['-tJf', archive], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  for (const item of listing) {
    const clean = item.replace(/\\/g, '/');
    if (clean.startsWith('/') || clean.split('/').includes('..')) throw new Error(`Unsafe Firefox archive path: ${item}`);
  }
}

export function geckoCatalogEntry(version = FIREFOX_CATALOG[0].version, platform = process.platform, arch = process.arch): GeckoCatalogEntry {
  const key = `${platform}-${arch}`;
  const entry = FIREFOX_CATALOG.find((candidate) => candidate.version === version && candidate.platform === key);
  if (!entry) throw new Error(`No Firefox runtime catalog entry for ${version} on ${key}`);
  return entry;
}

export function listInstalledGecko(root: string, platform = process.platform, arch = process.arch): InstalledGeckoRuntime[] {
  return FIREFOX_CATALOG.filter((entry) => entry.platform === `${platform}-${arch}`).map((entry) => {
    const rootDir = path.join(root, entry.version);
    const executablePath = path.join(rootDir, entry.executable);
    let installed = false;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'runtime.json'), 'utf8')) as { version?: string; executableSha256?: string; sha256?: string; platforms?: string[] };
      installed = manifest.version === entry.version
        && (manifest.platforms ?? []).includes(entry.platform)
        && fs.existsSync(executablePath)
        && (manifest.executableSha256 ?? manifest.sha256) === sha256(executablePath);
    } catch { /* incomplete runtime */ }
    return { entry, rootDir, executablePath, installed };
  });
}

export function installFirefoxRuntime(entry: GeckoCatalogEntry, root: string, fetch = true): InstalledGeckoRuntime {
  if (entry.platform !== `${process.platform}-${process.arch}`) throw new Error(`Firefox runtime ${entry.version} is not supported on ${process.platform}-${process.arch}`);
  fs.mkdirSync(root, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-firefox-runtime-'));
  const archive = path.join(temp, entry.format === 'msi' ? 'firefox.msi' : 'firefox.tar.xz');
  const unpacked = path.join(temp, 'unpacked');
  try {
    if (fetch) {
      const downloader = process.platform === 'win32' ? 'curl.exe' : 'curl';
      const mirrors = [entry.source, entry.source.replace('https://ftp.mozilla.org/pub/', 'https://download-installer.cdn.mozilla.net/pub/')];
      const errors: string[] = [];
      let acquired = false;
      for (const url of mirrors) {
        try {
          fs.rmSync(archive, { force: true });
          execFileSync(downloader, ['-fL', '--retry', '3', '--retry-delay', '2', '--connect-timeout', '20', url, '-o', archive], { stdio: 'inherit' });
          if (sha512(archive) === entry.archiveSha512) { acquired = true; break; }
          errors.push(`${url}: checksum mismatch`);
        } catch (error) { errors.push(`${url}: ${String(error instanceof Error ? error.message : error)}`); }
      }
      if (!acquired) throw new Error(`all Firefox mirrors failed: ${errors.join(' | ')}`);
    }
    if (sha512(archive) !== entry.archiveSha512) throw new Error(`Firefox archive SHA-512 mismatch for ${entry.version}`);
    fs.mkdirSync(unpacked, { recursive: true });
    if (entry.format === 'tar.xz') {
      safeTarList(archive);
      execFileSync('tar', ['-xJf', archive, '-C', unpacked], { stdio: 'inherit' });
      const sourceRoot = path.join(unpacked, 'firefox');
      const sourceExecutable = path.join(sourceRoot, entry.sourceExecutable);
      if (!fs.existsSync(sourceExecutable)) throw new Error(`Firefox executable missing from ${entry.version} archive`);
      return finalizeFirefoxRuntime(entry, root, sourceRoot, sourceExecutable);
    }
    if (process.platform !== 'win32') throw new Error('Firefox MSI extraction is supported only on Windows');
    const target = path.join(unpacked, 'Firefox');
    const install = spawnSync('msiexec.exe', ['/a', archive, '/qn', '/norestart', `TARGETDIR=${target}`], { stdio: 'inherit' });
    if (install.error) throw install.error;
    if (![0, 3010].includes(install.status ?? -1)) throw new Error(`msiexec administrative extraction failed with exit code ${install.status}`);
    const sourceRoot = fs.existsSync(path.join(target, 'core')) ? path.join(target, 'core') : target;
    const sourceExecutable = path.join(sourceRoot, entry.sourceExecutable);
    if (!fs.existsSync(sourceExecutable)) throw new Error(`Firefox executable missing from extracted MSI: ${sourceExecutable}`);
    return finalizeFirefoxRuntime(entry, root, sourceRoot, sourceExecutable);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

function finalizeFirefoxRuntime(entry: GeckoCatalogEntry, root: string, sourceRoot: string, sourceExecutable: string): InstalledGeckoRuntime {
  const finalRoot = path.join(root, entry.version);
  const staged = `${finalRoot}.partial-${process.pid}`;
  fs.rmSync(staged, { recursive: true, force: true });
  fs.cpSync(sourceRoot, staged, { recursive: true });
  const sourceStagedExecutable = path.join(staged, entry.sourceExecutable);
  const executablePath = path.join(staged, entry.executable);
  if (process.platform !== 'win32') {
    fs.writeFileSync(executablePath, '#!/bin/sh\nset -eu\nHERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$HERE/firefox-bin" "$@"\n', { mode: 0o755 });
  } else if (sourceStagedExecutable !== executablePath) {
    // Keep Mozilla's original firefox.exe because its launcher resolves the
    // companion firefox-bin.exe and adjacent resources by the upstream name.
    fs.copyFileSync(sourceStagedExecutable, executablePath);
  }
  if (process.platform !== 'win32') fs.chmodSync(executablePath, 0o755);
  fs.writeFileSync(path.join(staged, 'runtime.json'), `${JSON.stringify({ schema: 'octo.engine-manifest.v1', kind: 'gecko', protocol: 'juggler', version: entry.version, executable: entry.executable, platforms: [entry.platform], capabilities: ['window', 'tabs', 'navigation', 'storage', 'crash-recovery'], sha256: sha256(executablePath), executableSha256: sha256(executablePath), source: { url: entry.source, archiveSha512: entry.archiveSha512, license: entry.license } }, null, 2)}\n`);
  fs.writeFileSync(path.join(staged, 'NOTICE.firefox.txt'), `Firefox ${entry.version} from Mozilla.org.\nSource: ${entry.source}\nArchive SHA-512: ${entry.archiveSha512}\n${entry.license}\n`);
  fs.rmSync(finalRoot, { recursive: true, force: true });
  fs.renameSync(staged, finalRoot);
  return { entry, rootDir: finalRoot, executablePath: path.join(finalRoot, entry.executable), installed: true };
}

export function discoverFirefoxRuntime(resourcesPath: string, userRuntimeRoot: string, version = FIREFOX_CATALOG[0].version): string | null {
  const roots = [path.join(resourcesPath, 'engines', 'gecko'), userRuntimeRoot];
  for (const root of roots) {
    for (const runtime of listInstalledGecko(root)) {
      if (runtime.entry.version !== version || !runtime.installed) continue;
      return runtime.executablePath;
    }
  }
  return null;
}
