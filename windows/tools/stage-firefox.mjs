#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv.find((arg) => arg.startsWith('--target='))?.slice('--target='.length) ?? `${process.platform}-${process.arch}`;
const out = path.resolve(root, process.argv.find((arg) => arg.startsWith('--out='))?.slice('--out='.length) ?? 'resources/engines/gecko/140.0');
const entries = {
  'linux-x64': {
    version: '140.0', format: 'tar.xz', executable: 'inkbrowser-firefox', sourceExecutable: 'firefox',
    source: 'https://ftp.mozilla.org/pub/firefox/releases/140.0/linux-x86_64/en-US/firefox-140.0.tar.xz',
    archiveSha512: '481bb473c1c8279626e25d7253ee1735ca42e6898a5a664b21f1189d2779c2ecb555536eb46bcb2ac88066c286e831e17b23b877d7cd2d3b650083198c6dedc6',
  },
  'win32-x64': {
    version: '140.0', format: 'msi', executable: 'inkbrowser-firefox.exe', sourceExecutable: 'firefox.exe',
    source: 'https://ftp.mozilla.org/pub/firefox/releases/140.0/win64/en-US/Firefox%20Setup%20140.0.msi',
    archiveSha512: 'cf9f2be17a44e87f5ba03f32d6f25be42555df471e3f1fef17c907a6b9292545c7af1f88a1b1d0bce937a530ecab91d6c28fdb6d22a4a9b3a0f68336accf86a2',
  },
};
const entry = entries[target];
if (!entry) { console.error(`[stage-firefox] unsupported target ${target}; supported: ${Object.keys(entries).join(', ')}`); process.exit(2); }
const license = 'MPL-2.0 with additional binary components and Mozilla trademark restrictions; preserve upstream notices.';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-firefox-stage-'));
const archive = path.join(temp, entry.format === 'msi' ? 'firefox.msi' : 'firefox.tar.xz');
const digest = (file) => crypto.createHash('sha512').update(fs.readFileSync(file)).digest('hex');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const mirrors = [entry.source, entry.source.replace('https://ftp.mozilla.org/pub/', 'https://download-installer.cdn.mozilla.net/pub/')];
function downloadVerified() {
  const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const errors = [];
  for (const url of mirrors) {
    try {
      fs.rmSync(archive, { force: true });
      console.log(`[stage-firefox] downloading ${url}`);
      execFileSync(curl, ['-fL', '--retry', '3', '--retry-delay', '2', '--connect-timeout', '20', url, '-o', archive], { stdio: 'inherit' });
      const actual = digest(archive);
      if (actual === entry.archiveSha512) return url;
      errors.push(`${url}: checksum ${actual}`);
      fs.rmSync(archive, { force: true });
    } catch (error) {
      errors.push(`${url}: ${String(error?.message ?? error)}`);
      fs.rmSync(archive, { force: true });
    }
  }
  throw new Error(`all Firefox mirrors failed (expected ${entry.archiveSha512}): ${errors.join(' | ')}`);
}
const reuseExisting = process.argv.includes('--reuse-existing');
if (reuseExisting) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'runtime.json'), 'utf8'));
    const executablePath = path.join(out, entry.executable);
    if (manifest.schema === 'octo.engine-manifest.v1' && manifest.kind === 'gecko' && manifest.version === entry.version
      && manifest.platforms?.includes(target) && manifest.executable === entry.executable && fs.existsSync(executablePath)
      && manifest.sha256 === sha256(executablePath)) {
      console.log(`[stage-firefox] reusing verified ${entry.version} (${target}) at ${out}`);
      process.exit(0);
    }
  } catch { /* incomplete output: perform a fresh verified stage */ }
}
try {
  const acquiredFrom = downloadVerified();
  const unpacked = path.join(temp, 'unpacked'); fs.mkdirSync(unpacked);
  let sourceRoot;
  if (entry.format === 'tar.xz') {
    const listing = execFileSync('tar', ['-tJf', archive], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    if (listing.some((item) => item.replace(/\\/g, '/').startsWith('/') || item.replace(/\\/g, '/').split('/').includes('..'))) throw new Error('Unsafe archive path');
    execFileSync('tar', ['-xJf', archive, '-C', unpacked], { stdio: 'inherit' });
    sourceRoot = path.join(unpacked, 'firefox');
  } else {
    if (process.platform !== 'win32') throw new Error('Windows Firefox MSI staging must run on Windows');
    const targetDir = path.join(unpacked, 'Firefox');
    execFileSync('msiexec.exe', ['/a', archive, '/qn', `TARGETDIR=${targetDir}`], { stdio: 'inherit' });
    sourceRoot = fs.existsSync(path.join(targetDir, 'core')) ? path.join(targetDir, 'core') : targetDir;
  }
  const sourceExecutable = path.join(sourceRoot, entry.sourceExecutable);
  if (!fs.existsSync(sourceExecutable)) throw new Error(`Firefox executable missing: ${sourceExecutable}`);
  const staged = `${out}.partial-${process.pid}`;
  fs.rmSync(staged, { recursive: true, force: true }); fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.cpSync(sourceRoot, staged, { recursive: true });
  const sourceStagedExecutable = path.join(staged, entry.sourceExecutable);
  const executablePath = path.join(staged, entry.executable);
  if (process.platform !== 'win32') {
    // Mozilla's small launcher derives its companion name from argv[0]. Keep it
    // under its upstream name and expose the requested branded entry point as a
    // deterministic wrapper to firefox-bin.
    fs.writeFileSync(executablePath, '#!/bin/sh\nset -eu\nHERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$HERE/firefox-bin" "$@"\n', { mode: 0o755 });
  } else if (sourceStagedExecutable !== executablePath) {
    fs.renameSync(sourceStagedExecutable, executablePath);
  }
  if (process.platform !== 'win32') fs.chmodSync(executablePath, 0o755);
  fs.writeFileSync(path.join(staged, 'runtime.json'), `${JSON.stringify({ schema: 'octo.engine-manifest.v1', kind: 'gecko', protocol: 'juggler', version: entry.version, executable: entry.executable, platforms: [target], capabilities: ['window', 'tabs', 'navigation', 'storage', 'crash-recovery'], sha256: sha256(executablePath), executableSha256: sha256(executablePath), source: { url: acquiredFrom, mirrors, archiveSha512: entry.archiveSha512, license } }, null, 2)}\n`);
  fs.writeFileSync(path.join(staged, 'NOTICE.firefox.txt'), `Firefox ${entry.version} from Mozilla.org.\nSource: ${acquiredFrom}\nMirrors: ${mirrors.join(', ')}\nArchive SHA-512: ${entry.archiveSha512}\n${license}\n`);
  fs.rmSync(out, { recursive: true, force: true }); fs.renameSync(staged, out);
  console.log(`[stage-firefox] staged ${entry.version} (${target}) at ${out}`);
} finally { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
