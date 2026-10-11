/**
 * packages/core/src/updater.ts
 *
 * Update logic shared by both apps.
 *
 * When to check:
 *   - on the first launch of a calendar day,
 *   - on every third launch,
 *   - when the user clicks "Check for updates",
 *   - optionally periodically in the background (setting, default off).
 *
 * What is sent: only an HTTP GET for the manifest with the User-Agent
 * "Octo.su/<version> (win32; x64; stable)". No history, no ids,
 * no cookies (requests use a dedicated cookie-less session).
 *
 * Integrity chain (fail closed at every step):
 *   1. latest.json is downloaded ONLY from the official GitHub Releases URL;
 *   2. its Ed25519 signature (latest.json.sig) is verified with the public key
 *      compiled into the app;
 *   3. every file URL must point to the official release download path;
 *   4. the downloaded installer's SHA-256 must equal the signed manifest value;
 *   5. on Windows the installer's Authenticode signature is verified as well
 *      (see packages/shell/src/authenticode.ts) when the release is code-signed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { OFFICIAL_RELEASES_BASE, AppId } from './appinfo';
import { verifyEd25519 } from './crypto';
import { ensureDir } from './fsutil';

export type Severity = 'security' | 'recommended' | 'optional';

export interface UpdateFile {
  platform: 'win32';
  arch: 'x64' | 'arm64';
  name: string;
  url: string;
  sha256: string;
  size: number;
}

export interface AppRelease {
  version: string;
  severity: Severity;
  changelog: { en: string; pl: string };
  /** Components touched by the update, e.g. ["app","engine","filters"]. */
  components: string[];
  requiresRestart: boolean;
  files: UpdateFile[];
}

export interface UpdateManifest {
  schema: 1;
  channel: 'stable' | 'beta';
  publishedAt: string;
  apps: Partial<Record<AppId, AppRelease>>;
}

export interface UpdateState {
  schema: 1;
  launchCount: number;
  lastCheckDay?: string;
  lastCheckAt?: string;
  lastResult?: 'up-to-date' | 'available' | 'error' | 'not-configured';
  postponedUntil?: string;
  skippedVersion?: string;
}

export interface UpdateSettings {
  autoCheck: boolean;
  backgroundCheck: boolean;
  channel: 'stable' | 'beta';
}

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = { autoCheck: true, backgroundCheck: false, channel: 'stable' };

/** Local calendar day (YYYY-MM-DD) - "first launch of the day" is local time. */
export function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export type CheckReason = 'first-launch-today' | 'every-third-launch' | null;

/**
 * Register a launch and decide whether to check for updates now.
 * Returns the new state (caller persists it) and the reason (null = no check).
 */
export function onLaunch(state: UpdateState, now: Date, settings: UpdateSettings): { state: UpdateState; reason: CheckReason } {
  const next: UpdateState = { ...state, launchCount: (state.launchCount || 0) + 1 };
  if (!settings.autoCheck) return { state: next, reason: null };
  if (next.postponedUntil && new Date(next.postponedUntil) > now) return { state: next, reason: null };
  if (next.lastCheckDay !== localDay(now)) return { state: next, reason: 'first-launch-today' };
  if (next.launchCount % 3 === 0) return { state: next, reason: 'every-third-launch' };
  return { state: next, reason: null };
}

/** Record that a check happened. */
export function markChecked(state: UpdateState, now: Date, result: UpdateState['lastResult']): UpdateState {
  return { ...state, lastCheckDay: localDay(now), lastCheckAt: now.toISOString(), lastResult: result };
}

/**
 * Command-line arguments for the OctoSuite (Inno Setup) installer when it is
 * started by the in-app updater or rollback:
 *   /SILENT              progress window only - no wizard pages (the user already
 *                        confirmed the update in the app)
 *   /SUPPRESSMSGBOXES    no message boxes (defaults are used)
 *   /NORESTART           never restart Windows
 *   /CLOSEAPPLICATIONS   close remaining OctoSuite processes via Restart Manager
 *   /LANG=en|pl          installer language = app language
 *   /RELAUNCH=<app id>   start this app again after installation (see [Run] in octosuite.iss)
 *   /LOG=<file>          Inno Setup log (paths only, no secrets)
 * Returned as an argv array: child_process quotes each element, so paths with
 * spaces or Polish characters are passed intact.
 */
export function installerArgs(opts: { lang: 'en' | 'pl'; relaunch?: AppId; logFile?: string }): string[] {
  const lang = opts.lang === 'pl' ? 'pl' : 'en';
  const args = ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', `/LANG=${lang}`];
  if (opts.relaunch) {
    if (opts.relaunch !== 'octobrowser' && opts.relaunch !== 'octodetect') throw new Error('invalid app id');
    args.push(`/RELAUNCH=${opts.relaunch}`);
  }
  if (opts.logFile) {
    if (/["\r\n]/.test(opts.logFile)) throw new Error('invalid log path');
    args.push(`/LOG=${opts.logFile}`);
  }
  return args;
}

/**
 * Version of an installer kept for rollback in <data>/updater/installed.
 * Accepts "<version>.exe" (in-app updater) and "OctoSuite-Setup-<version>.exe"
 * (older update.bat copies). Anything else returns null and is ignored -
 * unrelated files must never break updating or rollback.
 */
export function versionFromInstallerName(fileName: string): string | null {
  const m = /^(?:OctoSuite-Setup-)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.exe$/i.exec(fileName);
  if (!m) return null;
  try { compareVersions(m[1], '0.0.0'); return m[1]; } catch { return null; }
}

/** Semantic version compare (major.minor.patch[-pre]). Returns -1, 0, 1. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
    if (!m) throw new Error(`Invalid version: ${v}`);
    return { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.n[i] !== pb.n[i]) return pa.n[i] < pb.n[i] ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1; // release > pre-release
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

/** Validate manifest structure and that all URLs are official. Throws on problems. */
export function validateManifest(obj: unknown): UpdateManifest {
  const m = obj as UpdateManifest;
  if (!m || m.schema !== 1 || typeof m.apps !== 'object' || m.apps === null) throw new Error('Invalid manifest');
  const officialPrefix = `${OFFICIAL_RELEASES_BASE}/download/`;
  for (const [id, rel] of Object.entries(m.apps)) {
    if (id !== 'octobrowser' && id !== 'octodetect') throw new Error(`Unknown app in manifest: ${id}`);
    if (!rel) continue;
    compareVersions(rel.version, '0.0.0'); // throws when invalid
    if (!['security', 'recommended', 'optional'].includes(rel.severity)) throw new Error('Invalid severity');
    if (!Array.isArray(rel.files) || rel.files.length === 0) throw new Error('Manifest has no files');
    for (const f of rel.files) {
      if (!f.url.startsWith(officialPrefix)) throw new Error(`Refusing non-official download URL: ${f.url}`);
      if (!SHA256_RE.test(f.sha256)) throw new Error('Invalid SHA-256 in manifest');
      if (!/^[\w.-]+$/.test(f.name)) throw new Error('Invalid file name in manifest');
      if (!Number.isInteger(f.size) || f.size <= 0 || f.size > 2 * 1024 ** 3) throw new Error('Invalid file size');
    }
  }
  return m;
}

/** Verify signature and parse. `manifestBytes` must be the exact downloaded bytes. */
export function verifyAndParseManifest(manifestBytes: Uint8Array, signatureB64: string, publicKeyPem: string): UpdateManifest {
  if (!publicKeyPem) throw new Error('Update signing key not configured');
  const sig = Buffer.from(signatureB64.trim(), 'base64');
  if (sig.length !== 64 || !verifyEd25519(publicKeyPem, manifestBytes, sig)) {
    throw new Error('Update manifest signature is INVALID - update blocked');
  }
  return validateManifest(JSON.parse(Buffer.from(manifestBytes).toString('utf8')));
}

export interface UpdateCheckResult {
  current: string;
  latest: string | null;
  available: boolean;
  release?: AppRelease;
  file?: UpdateFile;
}

export function selectUpdate(m: UpdateManifest, app: AppId, current: string, arch: string, skipped?: string): UpdateCheckResult {
  const rel = m.apps[app];
  if (!rel) return { current, latest: null, available: false };
  const file = rel.files.find((f) => f.platform === 'win32' && f.arch === arch);
  const newer = compareVersions(rel.version, current) > 0;
  const available = newer && !!file && rel.version !== skipped;
  return { current, latest: rel.version, available, release: rel, file };
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: 'follow' }) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  body?: ReadableStream<Uint8Array> | null;
}>;

export class UpdateClient {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly userAgent: string,
    private readonly publicKeyPem: string,
    private readonly base = OFFICIAL_RELEASES_BASE,
  ) {}

  get configured(): boolean {
    return !!this.publicKeyPem;
  }

  private headers(): Record<string, string> {
    // Minimal request: UA carries only app/version/os/arch/channel.
    return { 'User-Agent': this.userAgent, Accept: 'application/octet-stream' };
  }

  async fetchManifest(signal?: AbortSignal): Promise<UpdateManifest> {
    if (!this.configured) throw new Error('Update signing key not configured');
    const [mRes, sRes] = await Promise.all([
      this.fetchImpl(`${this.base}/latest/download/latest.json`, { headers: this.headers(), signal, redirect: 'follow' }),
      this.fetchImpl(`${this.base}/latest/download/latest.json.sig`, { headers: this.headers(), signal, redirect: 'follow' }),
    ]);
    if (!mRes.ok || !sRes.ok) throw new Error(`Update server returned HTTP ${mRes.status}/${sRes.status}`);
    const bytes = new Uint8Array(await mRes.arrayBuffer());
    if (bytes.length > 256 * 1024) throw new Error('Manifest too large');
    return verifyAndParseManifest(bytes, await sRes.text(), this.publicKeyPem);
  }

  /**
   * Download a file to destDir. Writes to <name>.partial, verifies SHA-256 and
   * size, then renames. A damaged/incomplete file is deleted and never run.
   */
  async download(file: UpdateFile, destDir: string, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<string> {
    ensureDir(destDir);
    const final = path.join(destDir, file.name);
    const partial = `${final}.partial`;
    fs.rmSync(partial, { force: true });
    const res = await this.fetchImpl(file.url, { headers: this.headers(), signal, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
    const hash = crypto.createHash('sha256');
    const out = fs.openSync(partial, 'w');
    let done = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        done += value.byteLength;
        if (done > file.size) throw new Error('Download larger than announced - aborted');
        hash.update(value);
        fs.writeSync(out, value);
        onProgress?.(done, file.size);
      }
    } catch (err) {
      fs.closeSync(out);
      fs.rmSync(partial, { force: true });
      throw err;
    }
    fs.closeSync(out);
    const digest = hash.digest('hex');
    if (done !== file.size || digest !== file.sha256) {
      fs.rmSync(partial, { force: true });
      throw new Error('SHA-256 / size mismatch - downloaded file rejected');
    }
    fs.renameSync(partial, final);
    return final;
  }
}
