/**
 * packages/shell/src/update-manager.ts
 *
 * Update orchestration for both apps (logic in @octo/core/updater):
 *   - schedule: first launch of the day, every 3rd launch, manual, optional background (6 h);
 *   - requests go through a dedicated in-memory session: no cookies, no cache,
 *     User-Agent "Octo.su/<ver> (win32; x64; stable)" only;
 *   - download -> SHA-256 check -> Authenticode check (when signed) ->
 *     backup of config -> keep the installer for rollback -> run installer.
 */
import { app, session, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import {
  AppInfo, AppSettings, DataLayout, Logger, UPDATE_PUBLIC_KEY_PEM, UpdateCheckResult, UpdateClient, UpdateState,
  VersionedStore, copyDir, ensureDir, fileStamp, markChecked, onLaunch, selectUpdate, FetchLike, compareVersions,
  appServicesOffline, installerArgs, Lang, versionFromInstallerName,
} from '@octo/core';
import { verifyAuthenticode } from './winutil';

export interface UpdateStatus {
  configured: boolean;
  current: string;
  latest: string | null;
  available: boolean;
  severity?: string;
  changelog?: { en: string; pl: string };
  components?: string[];
  requiresRestart?: boolean;
  lastCheckAt?: string;
  lastResult?: UpdateState['lastResult'];
  error?: string;
  downloading?: { done: number; total: number };
  readyToInstall?: string;
  rollbackAvailable: string[];
}

export class UpdateManager {
  private readonly state: VersionedStore<UpdateState>;
  private readonly client: UpdateClient;
  private status: UpdateStatus;
  private last: UpdateCheckResult | null = null;
  private timer: NodeJS.Timeout | null = null;
  private listeners: Array<(s: UpdateStatus) => void> = [];

  constructor(
    private readonly info: AppInfo,
    private readonly layout: DataLayout,
    private readonly settings: VersionedStore<AppSettings>,
    private readonly logger: Logger,
    /** App language - the installer is started in the same language. */
    private readonly lang: Lang = 'en',
  ) {
    this.state = new VersionedStore<UpdateState>(path.join(layout.config, 'update-state.json'), {
      backupDir: path.join(layout.backups, 'config'),
      defaults: () => ({ schema: 1, launchCount: 0 }),
      backupOnSave: false,
    });
    const ses = session.fromPartition('octo-updater'); // in-memory, isolated from all profiles
    ses.setUserAgent(this.userAgent());
    const fetchImpl: FetchLike = (url, init) => ses.fetch(url, { ...init, credentials: 'omit', cache: 'no-store' } as RequestInit) as ReturnType<FetchLike>;
    this.client = new UpdateClient(fetchImpl, this.userAgent(), UPDATE_PUBLIC_KEY_PEM);
    this.status = { configured: this.client.configured, current: app.getVersion(), latest: null, available: false, rollbackAvailable: this.rollbackVersions() };
  }

  private userAgent(): string {
    const ch = this.settings.load().updates.channel;
    return `${this.info.productName}/${app.getVersion()} (win32; ${process.arch}; ${ch})`;
  }

  onStatus(fn: (s: UpdateStatus) => void): void {
    this.listeners.push(fn);
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  private emit(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l(this.getStatus());
  }

  /** Call once at startup: registers the launch and checks if due. */
  onAppLaunch(): void {
    const s = this.settings.load();
    const r = onLaunch(this.state.load(), new Date(), s.updates);
    this.state.save(r.state);
    this.emit({ lastCheckAt: r.state.lastCheckAt, lastResult: r.state.lastResult });
    if (r.reason && !appServicesOffline(s)) {
      this.logger.info('update.scheduled-check', { reason: r.reason });
      void this.check();
    }
    this.configureBackground();
  }

  configureBackground(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const s = this.settings.load();
    if (!appServicesOffline(s) && s.updates.autoCheck && s.updates.backgroundCheck) {
      this.timer = setInterval(() => void this.check(), 6 * 3600 * 1000);
    }
  }

  async check(): Promise<UpdateStatus> {
    if (appServicesOffline(this.settings.load())) {
      this.logger.info('update.blocked-offline');
      return this.getStatus();
    }
    if (!this.client.configured) {
      this.state.save(markChecked(this.state.load(), new Date(), 'not-configured'));
      this.emit({ configured: false, lastResult: 'not-configured', error: undefined });
      return this.getStatus();
    }
    try {
      const manifest = await this.client.fetchManifest();
      const st = this.state.load();
      this.last = selectUpdate(manifest, this.info.id, app.getVersion(), process.arch, st.skippedVersion);
      const result = this.last.available ? 'available' : 'up-to-date';
      const saved = markChecked(st, new Date(), result);
      this.state.save(saved);
      this.logger.info('update.checked', { result, latest: this.last.latest });
      this.emit({
        latest: this.last.latest, available: this.last.available, severity: this.last.release?.severity,
        changelog: this.last.release?.changelog, components: this.last.release?.components,
        requiresRestart: this.last.release?.requiresRestart, lastCheckAt: saved.lastCheckAt, lastResult: result, error: undefined,
      });
    } catch (err) {
      this.state.save(markChecked(this.state.load(), new Date(), 'error'));
      this.logger.warn('update.check-failed', { message: (err as Error).message });
      this.emit({ lastResult: 'error', error: (err as Error).message });
    }
    return this.getStatus();
  }

  postpone(hours = 24): void {
    this.state.update((s) => { s.postponedUntil = new Date(Date.now() + hours * 3600 * 1000).toISOString(); });
  }

  skipVersion(v: string): void {
    this.state.update((s) => { s.skippedVersion = v; });
    this.emit({ available: false });
  }

  /** Download + verify. Returns the verified installer path. */
  async download(): Promise<string> {
    if (!this.last?.available || !this.last.file) throw new Error('No update available');
    const dir = path.join(this.layout.updater, 'downloads');
    const file = await this.client.download(this.last.file, dir, (done, total) => this.emit({ downloading: { done, total } }));
    const sig = await verifyAuthenticode(file);
    if (process.platform === 'win32' && sig.status !== 'Valid' && sig.status !== 'NotSigned') {
      fs.rmSync(file, { force: true });
      throw new Error(`Authenticode check failed: ${sig.status}`);
    }
    if (sig.status === 'NotSigned') this.logger.warn('update.not-codesigned (SHA-256 + Ed25519 manifest verified)');
    this.emit({ downloading: undefined, readyToInstall: path.basename(file) });
    return file;
  }

  /** Back up configuration before an update (restorable via repair.bat / Settings). */
  backupBeforeUpdate(): string {
    const dest = path.join(this.layout.backups, `pre-update-${app.getVersion()}-${fileStamp()}`);
    ensureDir(dest);
    copyDir(this.layout.config, path.join(dest, 'config'));
    this.logger.info('update.backup-created');
    return dest;
  }

  /** Keep the verified installer of each installed version for rollback (max 3). */
  private archiveInstaller(file: string, version: string): void {
    const dir = path.join(this.layout.updater, 'installed');
    ensureDir(dir);
    fs.copyFileSync(file, path.join(dir, `${version}.exe`));
    // Keep the 3 newest versions; files that are not installers are left alone.
    const kept = this.installedInstallers().sort((a, b) => compareVersions(b.version, a.version));
    for (const old of kept.slice(3)) fs.rmSync(path.join(dir, old.file), { force: true });
  }

  /** Installers kept for rollback: [{ file, version }], unrelated files ignored. */
  private installedInstallers(): Array<{ file: string; version: string }> {
    const dir = path.join(this.layout.updater, 'installed');
    if (!fs.existsSync(dir)) return [];
    const out: Array<{ file: string; version: string }> = [];
    const seen = new Set<string>();
    for (const file of fs.readdirSync(dir)) {
      const version = versionFromInstallerName(file);
      if (!version || seen.has(version)) continue;
      seen.add(version);
      out.push({ file, version });
    }
    return out;
  }

  rollbackVersions(): string[] {
    return this.installedInstallers()
      .map((x) => x.version)
      .filter((v) => compareVersions(v, app.getVersion()) < 0)
      .sort((a, b) => compareVersions(b, a));
  }

  /** Run the installer (after backup). The app quits so files can be replaced. */
  async install(file: string): Promise<void> {
    this.backupBeforeUpdate();
    if (this.last?.latest) this.archiveInstaller(file, this.last.latest);
    this.logger.info('update.install-start', { version: this.last?.latest });
    this.launchInstaller(file);
  }

  /**
   * Start the verified installer silently (progress window only) and quit so
   * files can be replaced. The installer restarts this app when it is done.
   */
  private launchInstaller(file: string): void {
    ensureDir(this.layout.logs);
    const logFile = path.join(this.layout.logs, `installer-${fileStamp()}.log`);
    const args = installerArgs({ lang: this.lang, relaunch: this.info.id, logFile });
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', (err) => this.logger.error('update.installer-spawn-failed', { error: String(err?.message ?? err) }));
    child.unref();
    app.quit();
  }

  /** Reinstall a previously installed (verified) version. */
  async rollback(version: string): Promise<void> {
    const dir = path.join(this.layout.updater, 'installed');
    const hit = this.installedInstallers().find((x) => x.version === version);
    if (!hit) throw new Error('Rollback installer not found');
    const full = path.join(dir, hit.file);
    const sig = await verifyAuthenticode(full);
    if (process.platform === 'win32' && sig.status !== 'Valid' && sig.status !== 'NotSigned') throw new Error(`Authenticode: ${sig.status}`);
    this.backupBeforeUpdate();
    this.logger.warn('update.rollback', { to: version });
    this.launchInstaller(full);
  }

  openReleasesPage(): void {
    void shell.openExternal(`https://github.com/${'chargehuobey/lvocto'}/releases`);
  }
}
