/**
 * apps/octobrowser/src/main/runtime.ts
 *
 * The per-profile browser PROCESS. Started by the profile manager with
 * --profile-process=<id>. Chromium's userData for this process is
 * profiles/<id>/engine, so cookies, cache, localStorage, IndexedDB, service
 * workers, HSTS state etc. are physically separated per profile, and the
 * process can be closed to seal an encrypted profile or wipe a temporary one.
 *
 * The data key arrives from the manager over the private fd-3 pipe; this
 * process never sees the master password.
 */
import { app, dialog, ipcMain, protocol, session, shell, WebContents, net, IpcMainInvokeEvent, screen } from 'electron';
import type { Session } from 'electron';
import * as crypto from 'node:crypto';
import * as dns from 'node:dns';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ADDONS, AppSettings, Bookmark, PasswordStore, passwordOrigin, generateStrongPassword, SEARCH_ENGINES, SearchEngine, DICTS, DataLayout, Lang, Logger, Profile, ProfileData, ProfileManager, SecretStore,
  VersionedStore, checkConsistency, createSettingsStore, detectVpnAdapters, dohTemplate, assessDns, parseTrace, t as translate,
  SUITE_VERSION, searchEngineQueryUrl, wipe, ResolvedFingerprint, resolveFingerprint, needsBridge, checkExitIp,
  ProxyCheckResult, GeoInfo, ImportedCookie, MAX_COOKIES, MobileEmulation,
} from '@octo/core';
import { ProxyBridge } from '@octo/shell/proxy-bridge';
import { buildFingerprintAuditReport } from './fingerprint-audit';
import { openSaveCard } from './save-card';
import type { FingerprintProbeSnapshot } from './fingerprint-probe';
import { FINGERPRINT_TEST_SITES, type FingerprintTestSiteId } from '../shared/fingerprint-test-sites';
import { AdblockService } from '@octo/shell/adblock';
import { type MessageChannel, Message, openChildChannel } from '@octo/shell/channel';
import { handle } from '@octo/shell/ipc';
import { acceptLanguages, cleanUserAgent } from '@octo/shell/prepare';
import { PermissionKind, ProfileSessionController, DownloadInfo } from '@octo/shell/session-privacy';
import { safeDownloadFilename, uniqueDownloadPath } from '@octo/shell/downloads';
import { profilePartition, ephemeralPartition } from '@octo/shell/profile-partition';
import { UpdateStatus } from '@octo/shell/update-manager';
import { BrowserWindowController, Rect } from './window';
import { bundledExtension, bundledExtensionPath, BundledExtension } from './extensions';
import { SHORTCUT_HELP } from '../shared/shortcuts';

type Pending = { resolve: (ok: boolean) => void; timer: NodeJS.Timeout };

export class ProfileRuntime {
  profile: Profile;
  readonly layout: DataLayout;
  readonly logger: Logger;
  readonly settings: VersionedStore<AppSettings>;
  controller!: ProfileSessionController;
  private data!: ProfileData;
  private secrets!: SecretStore;
  private dek: Buffer | null = null;
  private readonly windows = new Map<number, BrowserWindowController>(); // chrome wc id -> window
  private lastFocused: BrowserWindowController | null = null;
  private adblock: AdblockService;
  private updateStatus: UpdateStatus | null = null;
  private downloads = new Map<string, DownloadInfo>();
  private pending = new Map<string, Pending>();
  /**
   * Credentials already offered to the user, with the time of the question.
   * A login form can offer the same pair on click, on submit and again on
   * unload (and the page after a redirect can offer it once more); asking
   * twice for one login is not how a password manager behaves.
   */
  private offeredPasswords = new Map<string, number>();
  private mediaReleaseAcks = new Map<string, (released: boolean) => void>();
  private seq = 0;
  private publicIp: { ip?: string; at?: number; error?: string } = {};
  private quitting = false;
  /** Fingerprint applied in this run (resolved at start from profile + proxy geo). */
  fp!: ResolvedFingerprint;
  /** Optional Android/iOS device identity applied to every tab in this run. */
  mobile: MobileEmulation | null = null;
  /** Saved website logins of this profile (see packages/core/src/passwords.ts). */
  passwords!: PasswordStore;
  private bridge: ProxyBridge | null = null;
  /** Manager-owned quota for the saved proxy currently assigned to this profile. */
  private proxyQuota: { id: string; limitBytes: number; usedBytes: number } | null = null;
  private pendingProxyUsage = 0;
  /** Immutable for this launch. Ephemeral sessions never use a persist: partition. */
  private sessionPartition = '';
  /** Add-on id → extension id, scoped to this profile process's session. */
  private profileSession(): Session {
    return session.fromPartition(this.sessionPartition);
  }
  /** Exact partition shared by every profile tab and its octo:// protocol session. */
  sessionPartitionName(): string {
    return this.sessionPartition;
  }
  private readonly loadedExtensions = new Map<string, { extensionId: string; extension: BundledExtension }>();

  constructor(
    readonly distDir: string,
    readonly dataDir: string,
    readonly lang: Lang,
    private readonly profileId: string,
    private readonly channel: MessageChannel,
  ) {
    this.layout = new DataLayout(dataDir);
    this.logger = new Logger(this.layout.logs, 'octobrowser-profiles');
    this.settings = createSettingsStore(this.layout);
    const persistence = this.settings.load().privacyRuntime.sessionPersistence;
    this.sessionPartition = persistence === 'ephemeral' ? ephemeralPartition() : profilePartition(profileId);
    this.profile = new ProfileManager(this.layout).get(profileId);
    this.adblock = new AdblockService(this.layout.filters, path.join(distDir, 'assets', 'baseline-filters.txt'), this.logger);
  }

  t(key: string, params?: Record<string, string | number>): string {
    return translate(this.lang, key, params);
  }

  /**
   * Electron's embedded Chromium can still draw its own full-width credential
   * infobar when these preferences are enabled. Octo.su owns the save/fill
   * flow and encrypted per-profile vault, so keep Chromium's competing manager
   * disabled and present exactly one themed trusted-shell prompt.
   */
  private disableNativePasswordManager(): void {
    const dir = this.layout.profileEngineDir(this.profile.id);
    const file = path.join(dir, 'Preferences');
    let prefs: Record<string, unknown> = {};
    try {
      const raw = fs.readFileSync(file, 'utf8');
      if (raw.length <= 4 * 1024 * 1024) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) prefs = parsed as Record<string, unknown>;
      }
    } catch { /* a first run has no Preferences file yet */ }
    const profile = prefs.profile && typeof prefs.profile === 'object' && !Array.isArray(prefs.profile)
      ? prefs.profile as Record<string, unknown>
      : {};
    prefs.credentials_enable_service = false;
    profile.password_manager_enabled = false;
    prefs.profile = profile;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(prefs));
      fs.renameSync(temp, file);
    } catch {
      // The browser remains usable if its Chromium preferences cannot be saved.
    }
  }

  // ---------------------------------------------------------------- start

  async start(key: Buffer, quota?: { id: string; limitBytes: number; usedBytes: number }): Promise<void> {
    this.dek = key;
    this.setProxyQuota(quota);
    const keyHolder = { getKey: () => { if (!this.dek) throw new Error('locked'); return this.dek; } };
    this.data = new ProfileData(this.layout, this.profile.id, keyHolder.getKey);
    this.secrets = new SecretStore(path.join(this.layout.config, 'secrets.bin'), keyHolder);
    // Electron ships no Chromium password manager UI, so the profile switch
    // "Save passwords" is kept by the app itself: metadata in config/passwords.json,
    // the password only in this profile's encrypted secret store.
    this.passwords = new PasswordStore(this.layout, this.secrets);
    const s = this.settings.load();
    this.logger.setMode(s.logs.mode);

    // DNS for this profile (own process => own resolver config).
    const profDoh = this.profile.dns.mode === 'doh' ? this.profile.dns.dohTemplate : this.profile.dns.mode === 'system' ? null : dohTemplate(s);
    if (profDoh) app.configureHostResolver({ secureDnsMode: 'secure', secureDnsServers: [profDoh] });

    this.adblock.init();
    this.disableNativePasswordManager();
    const ses = this.profileSession();
    this.registerInternalProtocol(ses);
    this.controller = new ProfileSessionController(ses, this.profile, this.layout.profileDownloadsDir(this.profile.id), {
      logger: this.logger,
      adblock: this.adblock,
      askPermission: (wc, kind, origin) => this.askPermission(wc, kind, origin),
      confirmDangerousDownload: (wc, name) => this.ask(wc, 'ui:confirm-download', { fileName: name }),
      chooseDownloadDestination: (wc, suggestedName) => this.chooseDownloadDestination(wc, suggestedName),
      chooseDownloadPath: (wc, suggestedName) => this.chooseDownloadPath(wc, suggestedName),
      onDownloadUpdate: (d) => {
        this.downloads.set(d.id, d);
        if (d.savePath) {
          const dir = this.validDownloadDirectory(path.dirname(d.savePath));
          if (dir && dir !== this.profile.downloads.lastDirectory) {
            this.profile = { ...this.profile, downloads: { ...this.profile.downloads, lastDirectory: dir } };
            this.requestProfileUpdate({ downloads: this.profile.downloads });
          }
        }
        for (const w of this.windows.values()) w.send('ui:download', d);
      },
      onMediaRequest: (wc) => this.releaseTrustedMediaPreview(wc),
      onHttpsFailed: (wc, url) => { void wc.loadURL(`octo://https-only?url=${encodeURIComponent(url)}`); },
      onBlocked: (wc) => { for (const w of this.windows.values()) w.countBlocked(wc); },
      onTrafficDelta: (bytesIn, bytesOut) => this.recordProxyTraffic(bytesIn, bytesOut),
      isTrafficAllowed: () => this.canUseProxyTraffic(),
      isOffline: () => this.settings.load().offline,
    });
    // Proxy with credentials Chromium cannot use (SOCKS auth) -> local bridge.
    await this.startProxyBridge();
    // Route the session before the first exit-IP lookup. Without this ordering,
    // a non-bridged HTTP proxy could briefly resolve locale through the host IP.
    await this.controller.prepareNetwork();
    // Resolve the saved profile identity only after the profile route is active.
    // Auto locale/timezone/geolocation values therefore use the profile's exit IP.
    const geo = await this.geoForFingerprint();
    this.fp = this.profile.ordinaryBrowser
      ? { kind: 'disabled', enabled: false }
      : resolveFingerprint(this.profile.fingerprint, geo, this.lang);
    this.mobile = null;
    await this.controller.install(this.fp.enabled ? this.fp.userAgent : null, this.fp.enabled ? (this.fp.acceptLanguage ?? '') : '');

    // Bundled extensions are loaded only for profiles that explicitly enabled
    // them. Their extension storage therefore stays inside this profile's own
    // Chromium user-data directory rather than the manager or another profile.
    await this.syncBundledExtensions(ses);
    this.logger.info('fingerprint.resolution', { profile: this.profile.id, enabled: this.fp.enabled, mobile: 'none', os: this.fp.enabled ? this.fp.os : 'native' });

    // Proxy authentication from the encrypted secret store only.
    app.on('login', (e, _wc, _details, authInfo, cb) => {
      if (!authInfo.isProxy) return;
      const raw = this.secrets.get(`proxy:${this.profile.id}`);
      if (!raw) return;
      e.preventDefault();
      try {
        const { username, password } = JSON.parse(raw) as { username: string; password: string };
        cb(username, password);
      } catch {
        cb();
      }
    });

    // Cookies imported in the launcher while the profile was closed.
    await this.applyQueuedCookies();

    this.registerIpc();
    this.channel.onMessage((m) => void this.onManagerMessage(m));

    // Restore previous session or open the home page.
    let urls: string[] = [];
    if (this.profile.restoreSession && !this.profile.deleteOnClose) {
      try {
        const saved = this.data.session.load();
        urls = saved?.tabs.map((t) => t.url).slice(0, 50) ?? [];
      } catch (err) {
        this.logger.warn('session.restore-failed', err);
      }
    }
    // Start pages of the profile (also what a Dolphin Anty import brings over)
    // are opened on every start, in addition to any restored session. They used
    // to be stored and then never opened, so an imported profile came up empty.
    const startPages = (this.profile.startPages ?? [])
      .filter((url) => /^(https?|octo):\/\//i.test(url))
      .filter((url) => !urls.includes(url))
      .slice(0, 20);
    if (!urls.length && this.profile.homePage) urls.push(this.profile.homePage);
    urls.push(...startPages);
    const initialWindow = this.openWindow(urls);
    // A profile is ready only once a visible browser window has loaded its
    // trusted chrome. This keeps the launcher from showing STOP for a hidden
    // or failed-to-load profile window.
    await initialWindow.whenChromeReady();
    this.logger.info('profile.started', { profile: this.profile.id, kind: this.profile.kind, level: this.profile.protection.level, sandbox: this.profile.sandbox.mode });
    this.channel.send({ t: 'ready' });

    app.on('before-quit', (e) => {
      if (this.quitting) return;
      e.preventDefault();
      this.quitting = true;
      void this.shutdown().finally(() => app.exit(0));
    });
  }

  /** Close every window without confirmation and exit the profile process. */
  quitProfile(): void {
    setTimeout(() => { this.logger.warn('profile.quit-deadline'); app.exit(0); }, 8000).unref();
    for (const w of [...this.windows.values()]) {
      try { w.confirmClose(false); } catch (err) { this.logger.warn('profile.quit-window', err); }
    }
    setTimeout(() => app.quit(), 300);
  }

  /** Hook for every tab WebContents (fingerprint emulation is attached here). */
  onTabCreated(wc: WebContents): void {
    // Normal profile pages are never attached to CDP for identity purposes.
  }

  /** Apply a manager-authoritative saved-proxy quota; direct profile proxies are never metered here. */
  private setProxyQuota(quota: unknown): void {
    const q = quota as Partial<{ id: string; limitBytes: number; usedBytes: number }> | undefined;
    const savedId = this.profile.network.proxy?.savedId ?? '';
    if (!q || q.id !== savedId || typeof q.limitBytes !== 'number' || typeof q.usedBytes !== 'number' || q.limitBytes < 0 || q.usedBytes < 0) {
      this.proxyQuota = null;
      this.pendingProxyUsage = 0;
      return;
    }
    this.proxyQuota = { id: q.id, limitBytes: Math.floor(q.limitBytes), usedBytes: Math.floor(q.usedBytes) };
  }

  private canUseProxyTraffic(): boolean {
    return !this.proxyQuota || this.proxyQuota.limitBytes === 0 || this.proxyQuota.usedBytes < this.proxyQuota.limitBytes;
  }

  /** Batch byte deltas to the manager: no URL, domain, page, or payload data leaves the profile. */
  private recordProxyTraffic(bytesIn: number, bytesOut: number): void {
    if (!this.proxyQuota) return;
    const delta = Math.max(0, Math.floor(bytesIn)) + Math.max(0, Math.floor(bytesOut));
    if (!delta) return;
    this.proxyQuota.usedBytes = Math.min(Number.MAX_SAFE_INTEGER, this.proxyQuota.usedBytes + delta);
    this.pendingProxyUsage = Math.min(Number.MAX_SAFE_INTEGER, this.pendingProxyUsage + delta);
    // Sending at roughly 1 MiB keeps persisted usage useful without making a
    // config write for every image/request. The final remainder is flushed on shutdown.
    if (this.pendingProxyUsage >= 1024 * 1024) this.flushProxyUsage();
  }

  private flushProxyUsage(): void {
    if (!this.proxyQuota || !this.pendingProxyUsage) return;
    const bytes = this.pendingProxyUsage;
    this.pendingProxyUsage = 0;
    this.channel.send({ t: 'proxy-usage', id: this.profile.id, proxyId: this.proxyQuota.id, bytes });
  }

  /** Start the local SOCKS5 bridge when the profile proxy needs authentication Chromium lacks. */
  private async startProxyBridge(): Promise<void> {
    const n = this.profile.network;
    const px = n.proxy;
    if (n.mode !== 'proxy' || !px) {
      if (this.bridge) { await this.bridge.stop(); this.bridge = null; await this.controller.setProxyOverride(null); }
      return;
    }
    let creds = { username: '', password: '' };
    try { const raw = this.secrets.get(`proxy:${this.profile.id}`); if (raw) creds = { ...creds, ...(JSON.parse(raw) as typeof creds) }; } catch { /* none */ }
    const upstream = { type: px.type, host: px.host, port: px.port, ...creds };
    const bridged = needsBridge(upstream);
    if (!bridged && this.bridge) { await this.bridge.stop(); this.bridge = null; await this.controller.setProxyOverride(null); return; }
    if (!bridged) return;
    if (this.bridge) this.bridge.setUpstream(upstream as never);
    else {
      this.bridge = new ProxyBridge(upstream as never);
      await this.bridge.start();
    }
    await this.controller.setProxyOverride(this.bridge.rules);
    this.logger.info('proxy.bridge-started', { profile: this.profile.id, type: px.type });
  }

  /** Exit IP check through THIS profile's (proxied) session. */
  async checkProxy(): Promise<ProxyCheckResult> {
    const ses = this.profileSession();
    const r = await checkExitIp((url, init) => ses.fetch(url, { cache: 'no-store', credentials: 'omit', signal: init?.signal } as RequestInit) as never);
    this.channel.send({ t: 'proxy-checked', id: this.profile.id, result: r });
    return r;
  }

  /** Re-resolve identity after the profile or its proxy changes. */
  private async refreshIdentity(): Promise<void> {
    const geo = await this.geoForFingerprint();
    this.fp = this.profile.ordinaryBrowser
      ? { kind: 'disabled', enabled: false }
      : resolveFingerprint(this.profile.fingerprint, geo, this.lang);
    this.mobile = null;
    this.controller.updateIdentity(this.fp.enabled ? this.fp.userAgent : null, this.fp.enabled ? (this.fp.acceptLanguage ?? '') : '');
  }

  /** Geo facts for "auto" fingerprint values: fresh exit check, else the last stored one. */
  private async geoForFingerprint(): Promise<GeoInfo | undefined> {
    const f = this.profile.fingerprint;
    if (!f.enabled) return undefined;
    const usesAuto = f.timezone.mode === 'auto' || f.language.mode === 'auto' || f.geolocation.mode === 'auto' || f.webrtc.mode === 'altered';
    if (!usesAuto) return undefined;
    // "Based on IP" must inspect the actual exit even in system/direct mode.
    // Falling back to the Windows locale is what made a Polish IP open Google
    // in Romanian on hosts whose regional settings happened to be Romanian.
    const r = await this.checkProxy().catch(() => undefined);
    const g = r?.ok ? r : this.profile.proxyCheck?.ok ? this.profile.proxyCheck : undefined;
    if (!r?.ok) this.logger.warn('fingerprint.proxy-check-failed', { error: r?.error });
    return g;
  }

  private async shutdown(): Promise<void> {
    this.flushProxyUsage();
    const ephemeral = this.settings.load().privacyRuntime.sessionPersistence === 'ephemeral';
    if (!ephemeral) try {
      const active = await this.profileSession().cookies.get({});
      if (active && active.length > 0) {
        this.secrets.set(`active-cookies:${this.profile.id}`, JSON.stringify(active));
      }
    } catch { /* ignore */ }
    try {
      await this.controller.onProfileClosed();
      await this.profileSession().cookies.flushStore();
      this.profileSession().flushStorageData();
      if (ephemeral) await this.controller.clearData();
    } catch (err) {
      this.logger.warn('profile.shutdown', err);
    }
    try { await this.bridge?.stop(); } catch { /* ignore */ }
    wipe(this.dek);
    this.dek = null;
    this.logger.info('profile.stopped', { profile: this.profile.id });
  }

  openWindow(urls: string[] = [], allowEmpty = false): BrowserWindowController {
    const w = new BrowserWindowController(this, urls, allowEmpty);
    this.windows.set(w.chromeId, w);
    this.lastFocused = w;
    return w;
  }

  /** Create a destination first, then transfer the live native page view. */
  detachTab(source: BrowserWindowController, id: number, rawPoint?: unknown): void {
    const point = rawPoint && typeof rawPoint === 'object' ? rawPoint as Record<string, unknown> : {};
    const screenX = Number(point.screenX);
    const screenY = Number(point.screenY);
    const offsetX = Number(point.offsetX);
    const target = this.openWindow([], true);

    if (Number.isFinite(screenX) && Number.isFinite(screenY)) {
      try {
        const cursor = { x: Math.round(screenX), y: Math.round(screenY) };
        const work = screen.getDisplayNearestPoint(cursor).workArea;
        const bounds = target.win.getBounds();
        const desiredX = cursor.x - (Number.isFinite(offsetX) ? Math.round(offsetX) : 100);
        const desiredY = cursor.y - 16;
        const x = Math.max(work.x, Math.min(desiredX, work.x + Math.max(0, work.width - bounds.width)));
        const y = Math.max(work.y, Math.min(desiredY, work.y + Math.max(0, work.height - bounds.height)));
        target.win.setPosition(Math.round(x), Math.round(y));
      } catch (err) {
        this.logger.warn('tab.detach-position-failed', { error: String((err as Error)?.message ?? err) });
      }
    }

    if (!source.detachTabTo(id, target)) {
      this.logger.warn('tab.detach-cancelled', { tab: id });
      target.confirmClose(false);
    }
  }

  onWindowFocus(w: BrowserWindowController): void {
    this.lastFocused = w;
  }

  onWindowClosed(w: BrowserWindowController, tabs: Array<{ url: string; title: string; pinned: boolean; group?: string }>): void {
    this.windows.delete(w.chromeId);
    if (this.lastFocused === w) this.lastFocused = [...this.windows.values()][0] ?? null;
    if (this.windows.size === 0) {
      if (this.profile.restoreSession && !this.profile.deleteOnClose && this.dek) {
        try { this.data.session.save({ savedAt: new Date().toISOString(), tabs, activeIndex: 0 }); } catch (err) { this.logger.warn('session.save-failed', err); }
      }
      app.quit();
    }
  }

  private windowFor(e: IpcMainInvokeEvent): BrowserWindowController {
    const w = this.windows.get(e.sender.id);
    if (!w) throw new Error('unknown window');
    return w;
  }

  private windowOfTab(wc: WebContents | null): BrowserWindowController | null {
    if (!wc) return this.lastFocused;
    for (const w of this.windows.values()) if (w.ownsTabContents(wc.id)) return w;
    return this.lastFocused;
  }

  // --------------------------------------------------------- helpers used by windows

  normalizeInput(input: string): string {
    const s = input.trim();
    if (!s) return this.profile.homePage;
    // Never accept arbitrary chrome-extension:// navigation from pages or
    // typed text. Only an id returned by this process's Session.loadExtension
    // is allowed, which lets the Add-ons panel open its declared local page.
    if (this.isLoadedExtensionUrl(s)) return s;
    if (/^(https?|octo):/i.test(s)) return s;
    if (s === 'about:blank') return s;
    if (/^(localhost|(\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\])(:\d+)?(\/.*)?$/i.test(s)) return `http://${s}`;
    if (!/\s/.test(s) && /^[^/?#]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(s)) return `https://${s}`;
    const engine = this.profile.searchEngine || this.settings.load().network.searchEngine;
    return searchEngineQueryUrl(engine, s);
  }

  recordHistory(url: string, title: string): void {
    if (!this.profile.keepHistory || this.profile.deleteOnClose || !/^https?:/.test(url) || !this.dek) return;
    try {
      this.data.addHistory({ url, title: title.slice(0, 300), visitedAt: new Date().toISOString() });
    } catch (err) {
      this.logger.warn('history.write-failed', err);
    }
  }

  addBookmark(url: string, title: string): void {
    if (!/^https?:/.test(url)) return;
    this.data.bookmarks.update((list) => {
      if (!list.some((b) => b.url === url)) list.unshift({ id: `${Date.now().toString(36)}${this.seq++}`, title: title || url, url, createdAt: new Date().toISOString() });
    });
  }

  toggleProfileMute(): void {
    this.requestProfileUpdate({ audio: { ...this.profile.audio, muted: !this.profile.audio.muted } });
    this.profile = { ...this.profile, audio: { ...this.profile.audio, muted: !this.profile.audio.muted } };
    for (const w of this.windows.values()) w.applyProfileAudio();
  }

  openLauncher(): void {
    this.channel.send({ t: 'open-launcher' });
  }

  private requestProfileUpdate(patch: Partial<Profile>): void {
    this.channel.send({ t: 'update-profile', id: this.profile.id, patch });
  }

  private validDownloadDirectory(candidate: string): string {
    const clean = String(candidate ?? '').trim();
    if (!clean || !path.isAbsolute(clean)) return '';
    try {
      if (!fs.statSync(clean).isDirectory()) return '';
      fs.accessSync(clean, fs.constants.W_OK);
      return clean;
    } catch { return ''; }
  }

  /** Native Windows destination flow, scoped strictly to this profile. */
  private chooseDownloadDestination(wc: WebContents | null, suggested: string): {
    savePath?: string;
    saveDialogOptions?: Electron.SaveDialogOptions;
  } {
    const fileName = safeDownloadFilename(suggested);
    const fallback = this.layout.profileDownloadsDir(this.profile.id);
    fs.mkdirSync(fallback, { recursive: true });
    const prefs = this.profile.downloads;
    const sandboxBlocksHostFolder = this.profile.sandbox.mode === 'windows-sandbox'
      && !this.profile.sandbox.shareDownloads && Boolean(prefs.defaultDirectory);
    if (sandboxBlocksHostFolder && !prefs.askWhereToSave) {
      throw new Error(this.t('dl.sandboxFolderUnavailable'));
    }
    if (!prefs.askWhereToSave) {
      const configured = this.validDownloadDirectory(prefs.defaultDirectory);
      if (prefs.defaultDirectory && !configured) throw new Error(this.t('dl.invalidLocation'));
      return { savePath: uniqueDownloadPath(configured || fallback, fileName) };
    }
    const directory = this.validDownloadDirectory(prefs.lastDirectory)
      || this.validDownloadDirectory(prefs.defaultDirectory) || fallback;
    return {
      saveDialogOptions: {
        title: this.t('dl.chooseLocation'),
        defaultPath: path.join(directory, fileName),
        buttonLabel: this.t('dl.saveHere'),
        properties: ['showOverwriteConfirmation', 'createDirectory'],
      },
    };
  }

  /** Native Windows destination flow, scoped strictly to this profile. */
  private async chooseDownloadPath(wc: WebContents | null, suggested: string): Promise<string | null> {
    const fileName = safeDownloadFilename(suggested);
    const fallback = this.layout.profileDownloadsDir(this.profile.id);
    fs.mkdirSync(fallback, { recursive: true });
    const prefs = this.profile.downloads;
    const sandboxBlocksHostFolder = this.profile.sandbox.mode === 'windows-sandbox'
      && !this.profile.sandbox.shareDownloads && Boolean(prefs.defaultDirectory);
    if (sandboxBlocksHostFolder && !prefs.askWhereToSave) {
      throw new Error(this.t('dl.sandboxFolderUnavailable'));
    }
    if (!prefs.askWhereToSave) {
      const configured = this.validDownloadDirectory(prefs.defaultDirectory);
      if (prefs.defaultDirectory && !configured) throw new Error(this.t('dl.invalidLocation'));
      return uniqueDownloadPath(configured || fallback, fileName);
    }
    let directory = this.validDownloadDirectory(prefs.lastDirectory)
      || this.validDownloadDirectory(prefs.defaultDirectory) || fallback;
    const owner = this.windowOfTab(wc)?.win;
    // Native Windows catches overwrite collisions. The validation loop rejects
    // device names, trailing dots/spaces, and path-shaped server suggestions
    // rather than silently saving under a different name.
    for (;;) {
      const options: Electron.SaveDialogOptions = {
        title: this.t('dl.chooseLocation'), defaultPath: path.join(directory, fileName),
        buttonLabel: this.t('dl.saveHere'), properties: ['showOverwriteConfirmation', 'createDirectory'],
      };
      const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return null;
      const selectedName = path.basename(result.filePath);
      const selectedDirectory = this.validDownloadDirectory(path.dirname(result.filePath));
      if (!selectedDirectory || safeDownloadFilename(selectedName) !== selectedName) {
        const messageOptions: Electron.MessageBoxOptions = {
          type: 'warning', title: this.t('dl.invalidLocationTitle'), message: this.t('dl.invalidLocation'),
          buttons: [this.t('common.close')], noLink: true,
        };
        if (owner) await dialog.showMessageBox(owner, messageOptions); else await dialog.showMessageBox(messageOptions);
        directory = selectedDirectory || directory;
        continue;
      }
      this.profile = { ...this.profile, downloads: { ...prefs, lastDirectory: selectedDirectory } };
      this.requestProfileUpdate({ downloads: this.profile.downloads });
      return result.filePath;
    }
  }

  /** Wait until the trusted drawer has synchronously stopped every local track. */
  private async releaseTrustedMediaPreview(wc: WebContents | null): Promise<void> {
    const window = this.windowOfTab(wc);
    if (!window) return;
    const token = `media-${Date.now().toString(36)}-${(++this.seq).toString(36)}`;
    const released = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { this.mediaReleaseAcks.delete(token); resolve(false); }, 1_500);
      this.mediaReleaseAcks.set(token, (wasActive) => { clearTimeout(timer); this.mediaReleaseAcks.delete(token); resolve(wasActive); });
      window.send('ui:release-media-preview', token);
    });
    // Only a stream that actually held a driver handle needs release grace.
    // Ordinary website requests no longer pay an unconditional camera delay.
    if (released) await new Promise((resolve) => setTimeout(resolve, 120));
  }

  /** Only catalogue entries that have a reviewed extension bundle participate. */
  private bundledExtensionIds(addons = this.profile.addons): string[] {
    return addons.filter((id) => !!bundledExtension(id));
  }

  private hasSameBundledExtensions(a: string[], b: string[]): boolean {
    return this.bundledExtensionIds(a).sort().join('|') === this.bundledExtensionIds(b).sort().join('|');
  }

  /** Load/unload bundled extensions to exactly match this profile's enabled add-ons. */
  private async syncBundledExtensions(ses: Session): Promise<void> {
    const wanted = new Set(this.bundledExtensionIds());
    for (const [addonId, loaded] of this.loadedExtensions) {
      if (wanted.has(addonId)) continue;
      try { ses.removeExtension(loaded.extensionId); } catch (err) { this.logger.warn('addon.extension-unload-failed', { addonId, error: String(err) }); }
      this.loadedExtensions.delete(addonId);
      this.logger.info('addon.extension-unloaded', { addonId, profile: this.profile.id });
    }
    for (const addonId of wanted) {
      if (this.loadedExtensions.has(addonId)) continue;
      const extension = bundledExtension(addonId);
      if (!extension) continue;
      const extensionPath = bundledExtensionPath(extension, this.distDir, app.isPackaged, process.resourcesPath);
      if (!fs.existsSync(path.join(extensionPath, 'manifest.json'))) {
        throw new Error(this.t('addons.packageUnavailable'));
      }
      try {
        const loaded = await ses.loadExtension(extensionPath);
        this.loadedExtensions.set(addonId, { extensionId: loaded.id, extension });
        this.logger.info('addon.extension-loaded', { addonId, extensionId: loaded.id, profile: this.profile.id });
      } catch (err) {
        this.logger.error('addon.extension-load-failed', { addonId, error: String(err) });
        throw new Error(this.t('addons.loadFailed'));
      }
    }
  }

  /** A loaded extension is reachable only by its generated session-local id. */
  private isLoadedExtensionUrl(input: string): boolean {
    try {
      const u = new URL(input);
      return u.protocol === 'chrome-extension:' && [...this.loadedExtensions.values()].some((loaded) => loaded.extensionId === u.host);
    } catch {
      return false;
    }
  }

  /** Open a reviewed extension's declared local workspace in an ordinary profile tab. */
  private openBundledExtension(addonId: string): void {
    const loaded = this.loadedExtensions.get(addonId);
    if (!loaded) throw new Error(this.t('addons.packageUnavailable'));
    const url = `chrome-extension://${loaded.extensionId}/${loaded.extension.entryPage}`;
    (this.lastFocused ?? this.openWindow()).newTab(url);
  }

  /** State shared by all windows of this profile (profile badge, status icons). */
  sharedState() {
    const s = this.controller.privacy;
    const set = this.settings.load();
    const issues = checkConsistency(s, { extensionsCount: this.profile.addons.length, proxyActive: this.profile.network.mode === 'proxy' });
    return {
      profile: {
        id: this.profile.id, name: this.profile.name, kind: this.profile.kind, color: this.profile.color,
        level: this.profile.protection.level, encrypted: this.profile.encrypted, sandbox: this.profile.sandbox.mode,
        network: this.profile.network.mode, deleteOnClose: this.profile.deleteOnClose, audio: this.profile.audio, addons: this.profile.addons,
        theme: this.profile.theme, browserShell: this.profile.browserShell, baseChromeLook: this.profile.baseChromeLook, appMode: this.profile.appMode, smartPaste: this.profile.smartPaste,
        mobile: Boolean(this.mobile),
      },
      protection: issues.some((i) => i.severity === 'warn') ? 'attention' : 'active',
      verticalTabs: set.ui.verticalTabs,
      showBookmarksBar: set.ui.showBookmarksBar,
      confirmOnQuit: set.ui.confirmOnQuit,
      closeCountdown: set.ui.closeCountdown,
      openLinksInBackground: set.ui.openLinksInBackground,
      animations: set.ui.animations,
      virtualBoxMode: set.ui.virtualBoxMode,
      hideDirectoryPaths: set.ui.hideDirectoryPaths,
      offline: set.offline,
      update: this.updateStatus,
    };
  }

  private pushAll(): void {
    for (const w of this.windows.values()) w.pushState();
  }

  // ------------------------------------------------------------- prompts

  /** Show a question in the chrome UI of the window owning `wc` and wait for the answer (default: deny after 60 s). */
  private ask(wc: WebContents | null, channel: string, payload: Record<string, unknown>, timeoutMs = 60_000): Promise<boolean> {
    const w = this.windowOfTab(wc);
    if (!w) return Promise.resolve(false);
    const id = `q${++this.seq}`;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(false); }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      const tabId = wc ? w.tabByContents(wc.id) : undefined;
      if (tabId !== undefined) w.activate(tabId);
      // The tab travels with the question: prompts that belong to one tab
      // (a save-password card) are dismissed when that tab is left, and the
      // chrome UI uses it to keep the prompt on the page it came from.
      w.send(channel, { ...payload, reqId: id, tabId });
    });
  }

  /** True the first time this exact login is offered, false for a repeat. */
  private firstPasswordOffer(origin: string, username: string, password: string): boolean {
    const now = Date.now();
    for (const [key, at] of this.offeredPasswords) {
      if (now - at > 300_000) this.offeredPasswords.delete(key);
    }
    const key = `${origin}\u0000${username}\u0000${password}`;
    if (this.offeredPasswords.has(key)) return false;
    this.offeredPasswords.set(key, now);
    return true;
  }

  private askPermission(wc: WebContents | null, kind: PermissionKind, origin: string): Promise<boolean> {
    if (kind === 'geolocation' && this.fp?.enabled && this.fp.geoBlocked) return Promise.resolve(false);
    return this.ask(wc, 'ui:permission', { kind, origin });
  }

  // ------------------------------------------------------------- traffic

  private async lookupPublicIp(force = false): Promise<void> {
    const s = this.settings.load();
    if (!s.network.publicIpLookup || s.offline) { this.publicIp = {}; return; }
    if (!force && this.publicIp.at && Date.now() - this.publicIp.at < 60_000) return;
    try {
      // Goes through THIS profile's session => shows the IP websites see (proxy aware).
      const res = await this.profileSession().fetch('https://1.1.1.1/cdn-cgi/trace', { credentials: 'omit', cache: 'no-store' } as RequestInit);
      this.publicIp = { ip: parseTrace(await res.text()).ip, at: Date.now() };
    } catch (err) {
      this.publicIp = { error: (err as Error).message, at: Date.now() };
    }
  }

  async trafficSnapshot(w: BrowserWindowController, force: boolean) {
    await this.lookupPublicIp(force);
    const c = this.controller.counters;
    const s = this.controller.privacy;
    const set = this.settings.load();
    const vpn = detectVpnAdapters(os.networkInterfaces());
    const proxy = await this.controller.resolveProxy();
    const proxyActive = proxy !== 'DIRECT' && proxy !== 'UNKNOWN';
    const dohActive = this.profile.dns.mode === 'doh' || (this.profile.dns.mode === 'inherit' && !!dohTemplate(set));
    const servers = dns.getServers();
    const wc = w.activeTabContents();
    let host = '';
    try { host = wc ? new URL(wc.getURL()).hostname : ''; } catch { /* ignore */ }
    const cert = host ? this.controller.certs.get(host) : undefined;
    const domains = [...c.domains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
    return {
      at: Date.now(),
      publicIp: this.publicIp.ip ?? null,
      publicIpError: this.publicIp.error ?? null,
      publicIpConsent: set.network.publicIpLookup,
      vpn: vpn.length ? vpn : null,
      proxy: {
        active: proxyActive, value: proxy, mode: this.profile.network.mode,
        lockdown: this.controller.lockdown, killSwitch: this.controller.killSwitchOn,
        leaksBlocked: c.leaksBlocked,
      },
      proxyQuota: this.proxyQuota ? { usedBytes: this.proxyQuota.usedBytes, limitBytes: this.proxyQuota.limitBytes } : null,
      tor: false,
      dns: { servers, doh: dohActive, dohTemplate: this.profile.dns.mode === 'doh' ? this.profile.dns.dohTemplate : dohTemplate(set), leak: assessDns({ dnsServers: servers, vpnDetected: vpn.length > 0, proxyActive, dohActive }) },
      webrtc: { policy: s.webrtc, status: s.webrtc === 'disable_non_proxied_udp' ? 'ok' : s.webrtc === 'default_public_interface_only' ? 'limited' : 'exposed' },
      bytesIn: c.bytesIn,
      bytesOut: c.bytesOut,
      requests: c.requests,
      active: c.active.size,
      domains,
      blocked: { ...c.blocked },
      httpsUpgrades: c.httpsUpgrades,
      paramsStripped: c.paramsStripped,
      thirdPartyCookiesBlocked: c.thirdPartyCookiesBlocked,
      https: wc ? (wc.getURL().startsWith('https:') ? 'https' : wc.getURL().startsWith('http:') ? 'http' : 'internal') : 'internal',
      cert: cert ?? null,
      filtersUpdatedAt: this.adblock.updatedAt ?? null,
      autoRefresh: set.network.autoRefresh,
    };
  }

  // ------------------------------------------------------ internal pages

  private registerInternalProtocol(ses: Electron.Session): void {
    const root = path.join(this.distDir, 'internal');
    ses.protocol.handle('octo', (req) => {
      const u = new URL(req.url);
      const page = u.hostname || 'newtab';
      const map: Record<string, string> = { newtab: 'newtab.html', error: 'error.html', 'https-only': 'https-only.html' };
      let file: string;
      if (map[page] && (u.pathname === '/' || u.pathname === '')) file = map[page];
      else file = path.basename(u.pathname); // assets: newtab.js, internal.css ...
      const full = path.join(root, file);
      if (!full.startsWith(root) || !fs.existsSync(full)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(full).toString());
    });
  }

  private isInternalSender(e: IpcMainInvokeEvent): boolean {
    return (e.senderFrame?.url ?? '').startsWith('octo://');
  }

  private registerIpc(): void {
    const L = this.logger;
    ipcMain.removeAllListeners('octo:get-tab-config');
    ipcMain.on('octo:get-tab-config', (e) => {
      try {
        const win = this.windowOfTab(e.sender);
        e.returnValue = win?.tabConfigForContents(e.sender.id) ?? null;
      } catch {
        e.returnValue = null;
      }
    });
    // ---- internal octo:// pages (untrusted renderer => strict validation, minimal data) ----
    const internal = (ch: string, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) => {
      ipcMain.removeHandler(ch);
      ipcMain.handle(ch, async (e, ...a) => {
        if (!this.isInternalSender(e)) return null;
        try { return await fn(e, ...a); } catch { return null; }
      });
    };
    // ---- password capture / autofill for ordinary pages ----
    // Only a tab of this profile may talk to this surface, and it may only ask
    // about the origin it is actually showing.
    const page = (ch: string, fn: (origin: string, wc: WebContents, payload: Record<string, unknown>) => unknown) => {
      ipcMain.removeHandler(ch);
      ipcMain.handle(ch, async (e, payload: Record<string, unknown>) => {
        try {
          if (!this.windowOfTab(e.sender)) return null;
          const origin = passwordOrigin(e.senderFrame?.url ?? e.sender.getURL());
          if (!origin) return null;
          return await fn(origin, e.sender, (payload ?? {}) as Record<string, unknown>);
        } catch { return null; }
      });
    };
    page('page:password-query', (origin) => {
      if (!this.profile.savePasswords) return [];
      return this.passwords.getAccounts(this.profile.id, origin);
    });
    page('page:password-generate', () => {
      return { password: generateStrongPassword(18) };
    });
    page('page:password-fill', (origin, _wc, payload) => {
      if (!this.profile.savePasswords) return null;
      const id = typeof payload.id === 'string' ? payload.id : undefined;
      const username = typeof payload.username === 'string' ? payload.username : undefined;
      let match: { entry: { id: string; username: string }; password: string } | null = null;
      if (id) {
        match = this.passwords.getById(this.profile.id, id);
      } else if (username) {
        match = this.passwords.getByUsername(this.profile.id, origin, username);
      } else {
        match = this.passwords.matches(this.profile.id, origin)[0] ?? null;
      }
      if (!match) return null;
      this.passwords.markUsed(match.entry.id);
      return { username: match.entry.username, password: match.password };
    });
    page('page:password-offer', async (origin, wc, payload) => {
      const username = String(payload.username ?? '').slice(0, 256);
      const password = String(payload.password ?? '').slice(0, 4096);
      if (!password) return null;
      if (!this.profile.savePasswords || this.passwords.isBlocked(this.profile.id, origin)) return null;
      const existing = this.passwords.matches(this.profile.id, origin).find((item) => item.entry.username === username);
      if (existing && existing.password === password) return null;
      if (!this.firstPasswordOffer(origin, username, password)) return null;
      // The question is asked in its own floating window: the page keeps its
      // size, its focus and every click while the card waits, and touching the
      // browser window dismisses the card the way Chrome's bubble does.
      const answer = await openSaveCard({
        origin, username, password, update: !!existing,
        parent: this.windowOfTab(wc)?.win ?? null,
        distDir: this.distDir,
      });
      if (answer.action === 'never') this.passwords.block(this.profile.id, origin);
      if (answer.action !== 'save') return null;
      const finalUser = answer.username || username;
      const finalPass = answer.password || password;
      if (this.passwords.isBlocked(this.profile.id, origin)) return null;
      this.passwords.save({ profileId: this.profile.id, origin, username: finalUser, password: finalPass });
      this.logger.info('password.saved', { profile: this.profile.id, origin });
      return true;
    });
    internal('internal:strings', () => ({ lang: this.lang, dict: DICTS[this.lang] }));
    // The new-tab page deliberately exposes no profile/network dashboard. It
    // needs only the selected theme, which also keeps this untrusted surface tiny.
    internal('internal:status', () => ({ profile: { theme: this.profile.theme } }));
    internal('internal:navigate', (e, input) => {
      const w = this.windowOfTab(e.sender);
      w?.navigate(String(input));
      return true;
    });
    internal('internal:allow-http', (e, url) => {
      try {
        const u = new URL(String(url));
        if (u.protocol !== 'http:') return false;
        this.controller.allowHttpFor(u.hostname);
        void e.sender.loadURL(u.toString());
        return true;
      } catch { return false; }
    });

    // ---- trusted chrome UI ----
    handle('ui:init', L, () => ({
      lang: this.lang, dicts: DICTS, version: SUITE_VERSION, shortcuts: SHORTCUT_HELP, addons: ADDONS,
      theme: this.profile.theme, browserShell: this.profile.browserShell, baseChromeLook: this.profile.baseChromeLook, appMode: this.profile.appMode, smartPaste: this.profile.smartPaste,
      mobile: Boolean(this.mobile),
    }));
    handle('ui:ready', L, (e) => { this.windowFor(e).pushState(); return true; });
    /** The chrome overlay answered the close request: save & flush, then really close. */
    handle('ui:close-ok', L, (e, force?: boolean) => { this.windowFor(e).confirmClose(force === true); return true; });
    // Route the Chrome-style menu's Exit through the same native close path as
    // the title-bar X, so the visible graceful-close confirmation is retained.
    handle('ui:close-window', L, (e) => { this.windowFor(e).close(); return true; });
    handle('ui:window-action', L, (e, action: 'minimize' | 'toggle-maximize' | 'toggle-fullscreen') => {
      const controller = this.windowFor(e);
      if (action === 'minimize') controller.win.minimize();
      else if (action === 'toggle-maximize') controller.win.isMaximized() ? controller.win.unmaximize() : controller.win.maximize();
      else controller.win.setFullScreen(!controller.win.isFullScreen());
      return { maximized: controller.win.isMaximized(), fullscreen: controller.win.isFullScreen() };
    });
    handle('ui:layout', L, (e, rect: Rect, overlay: boolean) => {
      const r = { x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)) };
      this.windowFor(e).setLayout(r, !!overlay);
      return true;
    });
    handle('ui:popup', L, (e, open: boolean) => {
      this.windowFor(e).setPopup(open === true);
      return true;
    });
    handle('ui:navigate', L, (e, input: string) => { this.windowFor(e).navigate(String(input).slice(0, 8192)); return true; });
    handle('ui:new-tab', L, (e, url?: string, background?: boolean) => {
      const w = this.windowFor(e);
      return w.newTab(typeof url === 'string' && url ? url : w.defaultNewTabUrl(), { active: background !== true });
    });
    handle('ui:new-window', L, () => { this.openWindow(); return true; });
    handle('ui:tab', L, (e, id: number, action: string, arg?: unknown) => { this.windowFor(e).tabAction(Number(id), String(action), arg); return true; });
    handle('ui:command', L, (e, cmd: string) => { this.windowFor(e).command(cmd as never); return true; });
    handle('ui:find', L, (e, text: string, opts: { forward?: boolean; findNext?: boolean }) => { this.windowFor(e).find_(String(text ?? ''), opts ?? {}); return true; });
    handle('ui:answer', L, (_e, reqId: string, allow: boolean) => {
      const p = this.pending.get(String(reqId));
      if (p) { clearTimeout(p.timer); this.pending.delete(String(reqId)); p.resolve(allow === true); }
      return true;
    });
    handle('ui:media-preview-released', L, (_e, token: string, released: boolean) => {
      this.mediaReleaseAcks.get(String(token))?.(released === true);
      return true;
    });
    handle('ui:traffic', L, (e, force: boolean) => this.trafficSnapshot(this.windowFor(e), !!force));
    handle('ui:privacy', L, () => ({
      settings: this.controller.privacy,
      issues: checkConsistency(this.controller.privacy, { extensionsCount: this.profile.addons.length, proxyActive: this.profile.network.mode === 'proxy' }),
      profile: this.sharedState().profile,
    }));
    handle('ui:set-level', L, async (_e, level: string) => {
      if (this.profile.kind === 'tor' || !['normal', 'standard', 'strict'].includes(level)) throw new Error('invalid level');
      // Apply locally FIRST: the renderer re-opens the panel as soon as this
      // call resolves, so waiting for the manager round-trip would show the
      // previous level's values ("Standard and Strict look the same").
      this.profile = { ...this.profile, protection: { level: level as 'normal' | 'standard' | 'strict' } };
      await this.controller.update(this.profile);
      this.pushAll();
      this.requestProfileUpdate({ protection: { level: level as 'normal' | 'standard' | 'strict' } });
      return true;
    });
    handle('ui:addon', L, async (_e, id: string, on: boolean) => {
      const addon = ADDONS.find((a) => a.id === id);
      if (!addon || addon.kind === 'external-app') throw new Error('unknown add-on');
      const previous = this.profile;
      const set = new Set(previous.addons);
      if (on) set.add(id); else set.delete(id);
      this.profile = { ...previous, addons: [...set] };
      try {
        await this.syncBundledExtensions(this.profileSession());
      } catch (err) {
        this.profile = previous;
        throw err;
      }
      this.requestProfileUpdate({ addons: this.profile.addons });
      this.pushAll();
      return true;
    });
    handle('ui:open-addon', L, (_e, id: string) => {
      this.openBundledExtension(String(id));
      return true;
    });
    handle('ui:audio', L, (_e, patch: { muted?: boolean; volume?: number; outputDeviceId?: string }) => {
      const audio = { ...this.profile.audio };
      if (typeof patch.muted === 'boolean') audio.muted = patch.muted;
      if (typeof patch.volume === 'number') audio.volume = Math.max(0, Math.min(100, Math.round(patch.volume)));
      if (typeof patch.outputDeviceId === 'string') audio.outputDeviceId = patch.outputDeviceId.slice(0, 256);
      this.profile = { ...this.profile, audio };
      for (const w of this.windows.values()) w.applyProfileAudio();
      this.requestProfileUpdate({ audio });
      return true;
    });
    handle('ui:downloads', L, () => [...this.downloads.values()].reverse());
    handle('ui:download-folder-pick', L, async (e) => {
      const current = this.validDownloadDirectory(this.profile.downloads.defaultDirectory)
        || this.layout.profileDownloadsDir(this.profile.id);
      const options: Electron.OpenDialogOptions = {
        title: this.t('dl.chooseDefaultFolder'), defaultPath: current, properties: ['openDirectory', 'createDirectory'],
      };
      const result = await dialog.showOpenDialog(this.windowFor(e).win, options);
      return result.canceled ? null : result.filePaths[0] ?? null;
    });
    handle('ui:download-action', L, async (e, id: string, action: 'pause' | 'resume' | 'cancel' | 'show' | 'open' | 'open-folder' | 'retry' | 'change-location') => {
      const d = this.downloads.get(id);
      if (action === 'open-folder') {
        const directory = d?.savePath ? path.dirname(d.savePath)
          : this.validDownloadDirectory(this.profile.downloads.lastDirectory)
          || this.validDownloadDirectory(this.profile.downloads.defaultDirectory)
          || this.layout.profileDownloadsDir(this.profile.id);
        void shell.openPath(directory);
        return true;
      }
      if (!d) return false;
      if (action === 'show' && d.savePath) shell.showItemInFolder(d.savePath);
      else if (action === 'open' && d.state === 'completed' && d.savePath) void shell.openPath(d.savePath);
      else if (action === 'retry') {
        const source = this.controller.retryDownloadUrl(id);
        if (!source) return false;
        this.windowFor(e).activeTabContents()?.downloadURL(source);
      } else if (action === 'change-location') {
        if (d.received > 0) return false;
        const selected = await this.chooseDownloadPath(this.windowFor(e).activeTabContents(), d.fileName);
        if (!selected) return false;
        return this.controller.changeDownloadPath(id, selected);
      } else if (action === 'pause' || action === 'resume' || action === 'cancel') {
        this.controller.controlDownload(id, action);
      }
      return true;
    });
    handle('ui:bookmarks', L, () => this.data.bookmarks.load());
    handle('ui:bookmark-remove', L, (_e, id: string) => { this.data.bookmarks.update((l) => l.filter((b: Bookmark) => b.id !== id)); return true; });
    handle('ui:bookmark-add', L, (_e, url: string, title: string) => { this.addBookmark(String(url), String(title ?? '')); return true; });
    handle('ui:history', L, (_e, q: string) => {
      const needle = String(q ?? '').toLowerCase();
      return this.data.history.load().filter((h) => !needle || h.url.toLowerCase().includes(needle) || h.title.toLowerCase().includes(needle)).slice(0, 200);
    });
    handle('ui:history-clear', L, () => { this.data.history.save([]); return true; });
    handle('ui:clear-data', L, async () => { await this.controller.clearData(); return true; });
    handle('ui:updates-check', L, () => { this.channel.send({ t: 'check-updates' }); return true; });
    handle('ui:open-launcher', L, () => { this.openLauncher(); return true; });
    handle('ui:open-detect', L, () => { this.channel.send({ t: 'launch-detect' }); return true; });
    handle('ui:vstudio-web', L, (_e, label: string) => {
      this.channel.send({ t: 'start-vstudio-web', id: this.profile.id, label: String(label ?? '').trim().slice(0, 64) });
      return true;
    });
    handle('ui:private-browse', L, () => { this.channel.send({ t: 'private-browse', id: this.profile.id }); return true; });
    handle('ui:settings-set', L, (_e, patch: {

      verticalTabs?: boolean; showBookmarksBar?: boolean; hideDirectoryPaths?: boolean; virtualBoxMode?: boolean; autoRefresh?: boolean; offline?: boolean;

      openLinksInBackground?: boolean; animations?: boolean; confirmOnQuit?: boolean; closeCountdown?: boolean; sleepTabsAfterMin?: number; searchEngine?: SearchEngine;
    }) => {
      this.channel.send({ t: 'update-settings', patch });
      return true;
    });
    // ---- the window's own Settings page ----
    handle('ui:settings-get', L, () => {
      const set = this.settings.load();
      const p = this.profile;
      return {
        app: {
          verticalTabs: set.ui.verticalTabs, showBookmarksBar: set.ui.showBookmarksBar, openLinksInBackground: set.ui.openLinksInBackground, animations: set.ui.animations,
          confirmOnQuit: set.ui.confirmOnQuit, closeCountdown: set.ui.closeCountdown, sleepTabsAfterMin: set.ui.sleepTabsAfterMin,

          hideDirectoryPaths: set.ui.hideDirectoryPaths, virtualBoxMode: set.ui.virtualBoxMode,

          searchEngine: set.network.searchEngine, searchEngines: Object.keys(SEARCH_ENGINES), autoRefresh: set.network.autoRefresh, offline: set.offline,
        },
        profile: {
          name: p.name, theme: p.theme, browserShell: p.browserShell, appMode: p.appMode, smartPaste: p.smartPaste, homePage: p.homePage, searchEngine: p.searchEngine || '',
          savePasswords: p.savePasswords, keepHistory: p.keepHistory, restoreSession: p.restoreSession, level: p.protection.level,
          mediaCapture: p.mediaCapture, downloads: p.downloads,
          cameraAllowed: p.sandbox.camera, microphoneAllowed: p.sandbox.microphone,
          sandboxDownloadsShared: p.sandbox.mode !== 'windows-sandbox' || p.sandbox.shareDownloads,
        },
      };
    });
    handle('ui:profile-set', L, async (_e, patch: { savePasswords?: boolean; keepHistory?: boolean; restoreSession?: boolean; homePage?: string; searchEngine?: string; theme?: 'dark' | 'light'; mediaCapture?: Profile['mediaCapture']; downloads?: Partial<Profile['downloads']>; cameraAllowed?: boolean; microphoneAllowed?: boolean }) => {
      const allowed: Partial<Profile> = {};
      if (typeof patch?.savePasswords === 'boolean') allowed.savePasswords = patch.savePasswords;
      if (typeof patch?.keepHistory === 'boolean') allowed.keepHistory = patch.keepHistory;
      if (typeof patch?.restoreSession === 'boolean') allowed.restoreSession = patch.restoreSession;
      if (typeof patch?.homePage === 'string') allowed.homePage = patch.homePage.trim().slice(0, 2048) || 'octo://newtab';
      if (patch?.searchEngine !== undefined) allowed.searchEngine = patch.searchEngine && Object.keys(SEARCH_ENGINES).includes(patch.searchEngine) ? (patch.searchEngine as SearchEngine) : undefined;
      if (patch?.theme === 'dark' || patch?.theme === 'light') allowed.theme = patch.theme;
      if (patch?.downloads && typeof patch.downloads === 'object') {
        const cleanDirectory = (value: unknown) => String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 1024);
        allowed.downloads = {
          ...this.profile.downloads,
          ...(typeof patch.downloads.askWhereToSave === 'boolean' ? { askWhereToSave: patch.downloads.askWhereToSave } : {}),
          ...(typeof patch.downloads.defaultDirectory === 'string' ? { defaultDirectory: cleanDirectory(patch.downloads.defaultDirectory) } : {}),
        };
      }
      if (typeof patch?.cameraAllowed === 'boolean' || typeof patch?.microphoneAllowed === 'boolean') {
        allowed.sandbox = {
          ...this.profile.sandbox,
          ...(typeof patch.cameraAllowed === 'boolean' ? { camera: patch.cameraAllowed } : {}),
          ...(typeof patch.microphoneAllowed === 'boolean' ? { microphone: patch.microphoneAllowed } : {}),
        };
      }
      if (patch?.mediaCapture && typeof patch.mediaCapture === 'object') {
        const clean = (value: unknown) => String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 160);
        allowed.mediaCapture = { cameraLabel: clean(patch.mediaCapture.cameraLabel), microphoneLabel: clean(patch.mediaCapture.microphoneLabel) };
        // Choosing a concrete endpoint in the media panel is an explicit user
        // decision to let websites request that class of device. Previously
        // the preview worked in Octo chrome while the profile sandbox still
        // denied the same camera to every site, making the selector deceptive.
        allowed.sandbox = {
          ...this.profile.sandbox,
          ...(allowed.mediaCapture.cameraLabel ? { camera: true } : {}),
          ...(allowed.mediaCapture.microphoneLabel ? { microphone: true } : {}),
        };
      }
      if (!Object.keys(allowed).length) return false;
      this.profile = { ...this.profile, ...allowed };
      // Permission checks run inside the session controller. Update that policy
      // before reloading tabs; otherwise the first post-selection request can
      // still be rejected using the old camera/microphone flags.
      await this.controller.update(this.profile);
      this.requestProfileUpdate(allowed);
      this.pushAll();
      if (allowed.mediaCapture) {
        for (const w of this.windows.values()) {
          w.send('ui:toast', { key: 'media.selectionApplied' });
          w.applyMediaCaptureSelection();
        }
      }
      return true;
    });
    // ---- saved logins of this profile ----
    handle('ui:passwords', L, () => this.passwords.list(this.profile.id).filter((entry) => !entry.blocked));
    handle('ui:password-reveal', L, (_e, id: string) => this.passwords.reveal(String(id)));
    handle('ui:password-remove', L, (_e, id: string) => { this.passwords.remove(String(id)); return true; });
    handle('ui:password-never', L, (_e, requestedOrigin: string) => {
      // The trusted prompt carries the origin that created it. Do not derive it
      // from whichever tab happens to be active when the user clicks Never.
      const origin = passwordOrigin(String(requestedOrigin ?? ''));
      if (origin) this.passwords.block(this.profile.id, origin);
      return true;
    });
    handle('ui:password-add', L, (_e, input: { origin?: string; username?: string; password?: string }) => {
      this.passwords.save({ profileId: this.profile.id, origin: String(input?.origin ?? ''), username: String(input?.username ?? ''), password: String(input?.password ?? '') });
      return true;
    });
    handle('ui:page-info', L, async (e) => {
      const w = this.windowFor(e);
      const wc = w.activeTabContents();
      const url = wc?.getURL() ?? '';
      let origin = '';
      let host = '';
      try { const u = new URL(url); origin = u.origin; host = u.hostname; } catch { /* ignore */ }
      const secure = url.startsWith('https:');
      let cookies = 0;
      if (url.startsWith('http')) {
        try { cookies = (await this.profileSession().cookies.get({ url })).length; } catch { cookies = 0; }
      }
      const kinds = ['geolocation', 'camera', 'microphone', 'notifications', 'clipboard-read', 'devices', 'openExternal'] as const;
      const permissions = Object.fromEntries(kinds.map((k) => [k, this.controller.originPermissionState(origin, k)]));
      return { url, origin, host, secure, cookies, permissions, usageLabel: cookies ? `${cookies}` : '0' };
    });
    handle('ui:clear-origin-data', L, async (e) => {
      const w = this.windowFor(e);
      const wc = w.activeTabContents();
      const url = wc?.getURL() ?? '';
      let origin = '';
      try { origin = new URL(url).origin; } catch { return false; }
      await this.profileSession().clearStorageData({ origin, storages: ['cookies', 'localstorage', 'indexdb', 'shadercache', 'serviceworkers', 'cachestorage'] });
      this.controller.clearOriginPermissions(origin);
      return true;
    });
    handle('ui:reset-origin-permissions', L, (e) => {
      const wc = this.windowFor(e).activeTabContents();
      try { this.controller.clearOriginPermissions(new URL(wc?.getURL() ?? '').origin); } catch { /* ignore */ }
      return true;
    });
    handle('ui:set-origin-permission', L, (e, kind: string, state: string) => {
      const wc = this.windowFor(e).activeTabContents();
      let origin = '';
      try { origin = new URL(wc?.getURL() ?? '').origin; } catch { return false; }
      if (!['geolocation', 'camera', 'microphone', 'notifications', 'clipboard-read', 'devices', 'openExternal'].includes(kind)) return false;
      if (!['allow', 'block', 'ask'].includes(state)) return false;
      this.controller.setOriginPermission(origin, kind as 'geolocation', state as 'allow' | 'block' | 'ask');
      return true;
    });
    handle('ui:translate-page', L, async (e, targetLang: string) => this.windowFor(e).translateActivePage(String(targetLang || 'en')));
    handle('ui:translate-restore', L, async (e) => this.windowFor(e).restoreActivePageTranslation());
  }

  // ------------------------------------------------------------- cookies

  private async applyQueuedCookies(): Promise<void> {
    let list: ImportedCookie[] = [];
    try { list = JSON.parse(this.secrets.get(`cookies:${this.profile.id}`) ?? '[]') as ImportedCookie[]; } catch { list = []; }
    if (!Array.isArray(list) || !list.length) return;
    const r = await this.setCookies(list);
    this.channel.send({ t: 'cookies-imported', fromQueue: true, ...r });
  }

  private async setCookies(list: ImportedCookie[]): Promise<{ ok: number; failed: number }> {
    const ses = this.profileSession();
    let ok = 0;
    let failed = 0;
    for (const c of list.slice(0, MAX_COOKIES)) {
      if (!c || typeof c.url !== 'string' || typeof c.name !== 'string') { failed++; continue; }
      try {
        await ses.cookies.set({
          url: c.url, name: c.name, value: String(c.value ?? ''), domain: c.domain, path: c.path, secure: !!c.secure,
          httpOnly: !!c.httpOnly, expirationDate: c.expirationDate, sameSite: c.sameSite,
        });
        ok++;
      } catch (err) {
        failed++;
        if (failed <= 3) this.logger.warn('cookies.set-failed', { name: c.name, err: String((err as Error)?.message ?? err) });
      }
    }
    try { await ses.cookies.flushStore(); } catch { /* ignore */ }
    return { ok, failed };
  }

  // ------------------------------------------------------------- manager messages

  private async onManagerMessage(m: Message): Promise<void> {
    switch (m.t) {
      case 'profile-updated': {
        const p = m.profile as Profile;
        if (!p || p.id !== this.profile.id) return;
        const levelChanged = p.protection.level !== this.profile.protection.level;
        const proxyChanged = JSON.stringify(p.network) !== JSON.stringify(this.profile.network);
        const extensionsChanged = !this.hasSameBundledExtensions(p.addons, this.profile.addons);
        const baseChromeEnabled = p.baseChromeLook && !this.profile.baseChromeLook;
        const identityChanged = p.browserShell !== this.profile.browserShell;
        const fingerprintChanged = JSON.stringify(p.fingerprint) !== JSON.stringify(this.profile.fingerprint);
        this.profile = p;
        await this.controller.update(p);
        if (extensionsChanged) {
          try { await this.syncBundledExtensions(this.profileSession()); }
          catch (err) { this.logger.error('addon.extension-sync-failed', { error: String(err) }); }
        }
        if (baseChromeEnabled) for (const w of this.windows.values()) w.applyBaseChromeHome();
        if (proxyChanged) {
          this.setProxyQuota(m.proxyQuota);
          await this.startProxyBridge();
        }
        if (identityChanged || fingerprintChanged || proxyChanged) {
          await this.refreshIdentity();
        }
        for (const w of this.windows.values()) w.applyProfileAudio();
        this.pushAll();
        if (levelChanged) for (const w of this.windows.values()) w.send('ui:toast', { key: 'toast.levelChangedReload' });
        if (identityChanged || fingerprintChanged) for (const w of this.windows.values()) w.send('ui:toast', { key: 'toast.identityChangedReload' });
        break;
      }
      case 'proxy-quota':
        this.setProxyQuota(m.quota);
        break;
      case 'kill-switch':
        // Dead man's switch thrown in the launcher (e.g. while Android runs).
        await this.controller.setKillSwitch(m.on === true);
        this.pushAll();
        break;
      case 'import-cookies': {
        const r = await this.setCookies(Array.isArray(m.cookies) ? (m.cookies as ImportedCookie[]) : []);
        this.channel.send({ t: 'cookies-imported', fromQueue: false, ...r });
        for (const w of this.windows.values()) w.send('ui:toast', { key: 'cookies.imported', params: { n: String(r.ok) } });
        break;
      }
      case 'get-cookies': {
        try {
          const raw = await this.profileSession().cookies.get({});
          this.channel.send({ t: 'profile-cookies', requestId: m.requestId, cookies: raw });
        } catch {
          this.channel.send({ t: 'profile-cookies', requestId: m.requestId, cookies: [] });
        }
        break;
      }
      case 'settings-updated':
        this.settings.invalidate();
        this.pushAll();
        break;
      case 'update-status':
        this.updateStatus = m.status as UpdateStatus;
        this.pushAll();
        break;
      case 'filters-updated':
        this.adblock.init();
        break;
      case 'focus':
        (this.lastFocused ?? [...this.windows.values()][0])?.focus();
        break;
      case 'open-fingerprint-test-sites': {
        const requestId = String(m.requestId ?? '');
        const raw = Array.isArray(m.sites) ? m.sites : [];
        const sites = [...new Set(raw.filter((site): site is FingerprintTestSiteId =>
          typeof site === 'string' && Object.prototype.hasOwnProperty.call(FINGERPRINT_TEST_SITES, site)))];
        try {
          if (!requestId || !sites.length) throw new Error('Choose at least one supported fingerprint test site.');
          (this.lastFocused ?? [...this.windows.values()][0] ?? this.openWindow()).openFingerprintTestSites(sites);
          this.channel.send({ t: 'fingerprint-tests-opened', id: this.profile.id, requestId, ok: true, sites });
        } catch (error) {
          this.channel.send({ t: 'fingerprint-tests-opened', id: this.profile.id, requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        break;
      }
      case 'fingerprint-audit': {
        const requestId = String(m.requestId ?? '');
        try {
          if (!requestId) throw new Error('Fingerprint audit request is missing an id.');
          const win = this.lastFocused ?? [...this.windows.values()][0];
          if (!win) throw new Error('No browser window is open for this profile.');
          const observed = await win.probeActivePage();
          const report = buildFingerprintAuditReport({
            profile: this.profile,
            configured: this.profile.fingerprint,
            applied: this.fp,
            mobile: this.mobile,
            observed: observed as FingerprintProbeSnapshot,
          });
          this.channel.send({ t: 'fingerprint-audit-result', id: this.profile.id, requestId, ok: true, report });
        } catch (error) {
          this.channel.send({ t: 'fingerprint-audit-result', id: this.profile.id, requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        break;
      }
      case 'open-url':
        if (typeof m.url === 'string') (this.lastFocused ?? this.openWindow()).newTab(m.url);
        break;
      case 'quit':
        // Closed from the launcher (STOP / close button / API): skip the
        // "confirm close" overlay, save the session, flush and exit. A hard
        // deadline guarantees the process really ends even if a page hangs.
        this.quitProfile();
        break;
      default:
        break;
    }
  }
}

/** Entry point for --profile-process=<id>. */
export function runProfileProcess(distDir: string, dataDir: string, lang: Lang, profileId: string): void {
  protocol.registerSchemesAsPrivileged([{ scheme: 'octo', privileges: { standard: true, secure: true } }]);
  let channel: MessageChannel;
  try {
    channel = openChildChannel(); // private Node IPC channel from the manager
  } catch {
    app.exit(3); // not started by the manager
    return;
  }
  // Exactly one process per profile (Chromium also locks the userData folder).
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
    return;
  }
  let started = false;
  const timeout = setTimeout(() => { if (!started) app.exit(2); }, 20_000); // no key from the manager => exit
  channel.onMessage((m) => {
    if (m.t !== 'init' || started || typeof m.key !== 'string') return;
    started = true;
    clearTimeout(timeout);
    const key = Buffer.from(m.key, 'base64');
    const quota = m.proxyQuota as { id: string; limitBytes: number; usedBytes: number } | undefined;
    void app.whenReady().then(async () => {
      const rt = new ProfileRuntime(distDir, dataDir, lang, profileId, channel);
      try {
        await rt.start(key, quota);
      } catch (err) {
        rt.logger.error('profile.start-failed', err);
        dialog.showErrorBox('Octo.su', translate(lang, 'err.profileStart', { message: (err as Error).message }));
        app.exit(1);
      }
    });
  });
  // Only now is the init listener in place. The manager waits for this
  // acknowledgement before it transmits the one-shot profile data key.
  channel.send({ t: 'channel-ready' });
  app.on('window-all-closed', () => app.quit());
  // Never show Electron's modal "Uncaught exception" box in a profile: it blocks
  // the window from closing. Log it and keep the browser running instead.
  process.on('uncaughtException', (err) => {
    try { new Logger(new DataLayout(dataDir).logs, 'octobrowser-profiles').error('profile.uncaught', err); } catch { /* ignore */ }
  });
  process.on('unhandledRejection', (err) => {
    try { new Logger(new DataLayout(dataDir).logs, 'octobrowser-profiles').warn('profile.unhandled-rejection', err); } catch { /* ignore */ }
  });
}
