/**
 * apps/octobrowser/src/main/window.ts
 *
 * One browser window of a profile: a BaseWindow containing
 *   - the chrome UI (WebContentsView, local file, trusted preload), and
 *   - one WebContentsView per tab (web content, sandboxed, untrusted preload).
 * The chrome UI reports the free content rectangle; tabs are positioned
 * into it (two tabs side by side in split view). Panels are docked, so they
 * never overlap web content.
 */
import { BaseWindow, Menu, WebContentsView, WebContents, clipboard, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NORMALIZED_HARDWARE } from '@octo/core';
import { trustWebContents } from '@octo/shell/ipc';
import { SAFE_WEB_PREFERENCES, assertSafeWebPreferences } from '@octo/shell/security-policy';
import { profilePartition } from '@octo/shell/profile-partition';

import { FINGERPRINT_PROBE_SCRIPT, type FingerprintProbeSnapshot } from './fingerprint-probe';
import { FingerprintTestSiteId, FINGERPRINT_TEST_SITES } from '../shared/fingerprint-test-sites';
import { tabContents } from '@octo/shell/hardening';
import { iconPath, THEME } from '@octo/shell/windows-ui';
import { commandFor, Command } from '../shared/shortcuts';
import type { PageConfig } from '../preload/page-shim';
import type { ProfileRuntime } from './runtime';


assertSafeWebPreferences({ ...SAFE_WEB_PREFERENCES, webviewTag: false });
export interface Rect { x: number; y: number; width: number; height: number }

export interface TabState {
  id: number;
  title: string;
  url: string;
  favicon: string;
  loading: boolean;
  audible: boolean;
  muted: boolean;
  volume: number;
  pinned: boolean;
  group: string;
  sleeping: boolean;
  blocked: number;
  canBack: boolean;
  canForward: boolean;
  security: 'https' | 'http' | 'internal' | 'other';
  crashed: boolean;
  zoom: number;
  redirectBlocked?: string;
}

const DARK_CSS = `html{filter:invert(.9) hue-rotate(180deg)!important;background:#fff!important}
img,video,picture,canvas,iframe,svg image,[style*="background-image"]{filter:invert(1) hue-rotate(180deg)!important}`;

/** Familiar base-Chrome profiles use Google unless the user supplied another home page. */
const GOOGLE_HOME = 'https://www.google.com/';

let nextTabId = 1;

class Tab {
  readonly id = nextTabId++;
  view: WebContentsView | null = null;
  title = '';
  owner: BrowserWindowController;
  url: string;
  favicon = '';
  loading = false;
  audible = false;
  muted = false;
  volume: number;
  pinned = false;
  group = '';
  blocked = 0;
  crashed = false;
  lastActive = Date.now();
  lastUserInput = 0;
  redirectBlocked?: string;
  darkCssKey?: string;

  constructor(owner: BrowserWindowController, url: string, volume: number) {
    this.owner = owner;
    this.url = url;
    this.volume = volume;
  }

  /**
   * Live WebContents of the tab or null. NOTE: once a WebContents is destroyed
   * (page called window.close(), renderer torn down, window closing) Electron
   * returns `undefined` from view.webContents - never dereference it directly.
   */
  get wc(): WebContents | null {
    const wc = this.view?.webContents as WebContents | undefined;
    return wc && !wc.isDestroyed() ? wc : null;
  }

  get sleeping(): boolean {
    return this.view === null;
  }
}

export class BrowserWindowController {
  readonly win: BaseWindow;
  readonly chrome: WebContentsView;
  /** Chrome WebContents id, captured at creation (view.webContents is undefined after destruction). */
  readonly chromeId: number;
  private tabs: Tab[] = [];
  // A close request can be delivered twice while Chromium is dispatching its
  // destroyed event. Keep the operation idempotent until the controller dies;
  // tab IDs are monotonic and are never reused.
  private closingTabIds = new Set<number>();
  private activeId = 0;
  private splitId = 0;
  private content: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private overlay = false;
  private fullscreenHtml = false;
  private popupOpen = false;
  /**
   * The trusted chrome is deliberately allowed to occupy the Windows overlay
   * row. Its tab strip reserves the window-control area itself, so Chrome and
   * Chromium do not acquire a second, empty strip above their tabs.
   */
  private readonly titleOverlayHeight = 0;
  /** Resolves once the trusted browser chrome has loaded (false = load failure). */
  private readonly chromeReady: Promise<boolean>;
  /** Set once the user confirmed closing (the close event is intercepted first). */
  private closeConfirmed = false;
  private closedStack: Array<{ url: string; title: string }> = [];
  private sleepTimer: NodeJS.Timeout;

  constructor(private readonly rt: ProfileRuntime, initialUrls: string[], allowEmpty = false) {
    const p = rt.profile;
    // A phone profile retains a focused portrait window while each page is
    // independently emulated as the selected handset (viewport, touch and UA).
    // The compact trusted mobile chrome below avoids presenting that window as
    // a squeezed desktop browser.
    const phone = rt.mobile;
    const chromeFamily = p.browserShell === 'chrome' || p.browserShell === 'chromium' || p.baseChromeLook;
    const baseChromeFrame = process.platform === 'win32';
    const frameColor = p.theme === 'light' ? (chromeFamily ? '#dedede' : '#ededed') : (chromeFamily ? '#29292f' : '#181818');
    this.win = new BaseWindow({
      width: phone ? Math.max(420, Math.min(1100, phone.width + 42)) : 1280,
      height: phone ? Math.max(620, Math.min(1300, phone.height + 210)) : 820,
      minWidth: phone ? 360 : 720,
      minHeight: phone ? 560 : 480,
      show: false,
      backgroundColor: frameColor,
      // The trusted renderer owns the integrated title bar and its controls.
      // Native overlay buttons would sit over the tab strip and page chrome.
      ...(baseChromeFrame ? {
        titleBarStyle: 'hidden' as const,
        titleBarOverlay: false,
      } : {}),
      title: `${p.name} — Octo.su`,
      // Running profile windows use the classic Octo mark with a small profile
      // badge, so they are distinguishable from the launcher in taskbars/docks.
      icon: fs.existsSync(path.join(rt.distDir, 'assets', 'profile-running.png'))
        ? path.join(rt.distDir, 'assets', 'profile-running.png') : iconPath(rt.distDir),
      autoHideMenuBar: true,
    });
    const graphicsBlocked = rt.settings.load().privacyRuntime?.graphicsExposure === 'block';
    this.chrome = new WebContentsView({
      webPreferences: {
        ...SAFE_WEB_PREFERENCES,
        webgl: !graphicsBlocked,
        preload: path.join(rt.distDir, 'preload-chrome.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
        partition: 'octo-ui', // in-memory UI session, separate from the profile's web session
      },
    });
    this.chromeId = this.chrome.webContents.id;
    // Match the native overlay during renderer startup; otherwise Chrome mode
    // briefly exposes a differently coloured empty strip above its controls.
    this.chrome.setBackgroundColor(frameColor);
    trustWebContents(this.chrome.webContents);
    this.win.contentView.addChildView(this.chrome);
    // Do not make opening the native window depend on a renderer event. On
    // Windows a very fast local load can complete before an event listener is
    // attached, leaving a fully running profile with no visible window.
    this.win.show();
    this.win.focus();
    this.chromeReady = this.chrome.webContents.loadFile(path.join(rt.distDir, 'renderer', 'browser.html')).then(
      () => {
        try { this.chrome.setBackgroundColor('#00000000'); } catch {}
        if (!this.win.isDestroyed()) this.pushState();
        return true;
      },
      (err: unknown) => {
        this.rt.logger.error('window.chrome-load-failed', { error: String((err as Error)?.message ?? err) });
        return false;
      },
    );
    this.chrome.webContents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      const cmd = commandFor({ key: input.key, control: input.control, shift: input.shift, alt: input.alt, meta: input.meta });
      if (cmd && cmd !== 'focus-address' && cmd !== 'find') {
        e.preventDefault();
        this.command(cmd);
      }
    });

    // Closing is intercepted: the chrome shows a minimal "closing" overlay first,
    // so the session, cookies and storage can be flushed instead of being cut.
    this.win.on('close', (e) => {
      if (this.closeConfirmed) return;
      if (!rt.settings.load().ui.confirmOnQuit) return; // setting off: close straight away
      if (!this.chromeWc) return; // UI gone: nothing can confirm - close now
      e.preventDefault();
      this.chromeWc.send('ui:close-request', {
        tabs: this.tabs.length,
        restoreSession: rt.profile.restoreSession && !rt.profile.deleteOnClose,
        closeCountdown: rt.settings.load().ui.closeCountdown,
      });
    });
    this.win.on('resize', () => this.layoutViews());
    this.win.on('enter-full-screen', () => this.pushState());
    this.win.on('leave-full-screen', () => { this.fullscreenHtml = false; this.pushState(); this.layoutViews(); });
    this.win.on('focus', () => rt.onWindowFocus(this));
    this.win.on('closed', () => {
      clearInterval(this.sleepTimer);
      try { rt.onWindowClosed(this, this.snapshotTabs()); } catch (err) { rt.logger.warn('window.closed-handler', { err: String(err) }); }
      const tabs = this.tabs;
      this.tabs = [];
      for (const t of tabs) this.destroyView(t);
    });

    const urls = initialUrls.length ? initialUrls : allowEmpty ? [] : [this.defaultNewTabUrl()];
    for (const u of urls) this.newTab(u, { active: true });
    this.layoutViews();
    this.sleepTimer = setInterval(() => this.sleepIdleTabs(), 60_000);
  }

  /** The initial profile window is usable only after its local chrome loads. */
  async whenChromeReady(): Promise<void> {
    if (!await this.chromeReady) throw new Error('browser chrome could not be loaded');
    if (this.win.isDestroyed()) throw new Error('browser window closed while opening');
    // Reassert foreground visibility after the chrome load. This covers Windows
    // window-manager races during a second Electron process startup.
    this.win.show();
    this.win.focus();
    if (!this.win.isVisible()) throw new Error('browser window could not be shown');
  }

  // ------------------------------------------------------------ tab basics

  /** Chrome UI WebContents, or null once destroyed (window closing). */
  private get chromeWc(): WebContents | null {
    const wc = this.chrome.webContents as WebContents | undefined;
    return wc && !wc.isDestroyed() ? wc : null;
  }

  /** Detach and close a tab's view safely (idempotent, never throws). */
  private destroyView(t: Tab): void {
    const view = t.view;
    if (!view) return;
    const wc = t.wc;
    t.view = null; // first: the 'destroyed' listener must see this as intentional
    try { if (!this.win.isDestroyed()) this.win.contentView.removeChildView(view); } catch { /* already detached */ }
    try { wc?.close(); } catch { /* already gone */ }
  }

  /** A tab's WebContents died on its own (window.close() from the page, etc.). */
  private onTabContentsDestroyed(t: Tab, view: WebContentsView): void {
    if (t.view !== view) return; // intentional close/sleep - already handled
    t.view = null;
    if (this.win.isDestroyed()) return;
    try { this.win.contentView.removeChildView(view); } catch { /* ignore */ }
    if (this.tabs.includes(t)) this.closeTab(t.id);
  }

  private get active(): Tab | undefined {
    return this.tabs.find((t) => t.id === this.activeId);
  }

  private find(id: number): Tab | undefined {
    return this.tabs.find((t) => t.id === id);
  }

  /** WebContents ids of all live tabs (used to route internal-page IPC). */
  ownsTabContents(wcId: number): boolean {
    return this.tabs.some((t) => t.wc?.id === wcId);
  }

  tabByContents(wcId: number): number | undefined {
    return this.tabs.find((t) => t.wc?.id === wcId)?.id;
  }

  tabConfigForContents(wcId: number): PageConfig | null {
    const tab = this.tabs.find((t) => t.wc?.id === wcId);
    return tab ? this.tabConfig(tab) : null;
  }

  tabConfig(t: Tab): PageConfig {
    const s = this.rt.controller.privacy;
    const resolved = this.rt.fp?.enabled ? this.rt.fp : null;
    const seed = resolved ? Number.parseInt(resolved.seed.slice(0, 8), 16) >>> 0 : 0;
    return {
      canvas: s.canvas === 'block-readback' ? 'block-readback' : 'allow',
      hw: resolved?.cores || resolved?.memory ? 'allow' : 'allow',
      hwValues: { hardwareConcurrency: resolved?.cores ?? NORMALIZED_HARDWARE.hardwareConcurrency, deviceMemory: resolved?.memory ?? NORMALIZED_HARDWARE.deviceMemory },
      volume: t.volume / 100,
      sinkId: this.rt.profile.audio.outputDeviceId,
      cameraLabel: this.rt.profile.mediaCapture.cameraLabel,
      microphoneLabel: this.rt.profile.mediaCapture.microphoneLabel,
      fp: resolved ? {
        platform: resolved.platform,
        brands: resolved.brands,
        fullVersionList: resolved.fullVersionList,
        uaFullVersion: resolved.uaFullVersion,
        chPlatform: resolved.chPlatform,
        platformVersion: resolved.platformVersion,
        architecture: resolved.architecture,
        bitness: resolved.bitness,
        languages: resolved.languages,
        cores: resolved.cores,
        memory: resolved.memory,
        screen: resolved.screen,
        windowSize: resolved.windowSize,
        deviceScaleFactor: 1,
        webglVendor: resolved.webglVendor,
        webglRenderer: resolved.webglRenderer,
        canvas: resolved.canvas,
        webgl: resolved.webgl,
        audio: resolved.audio,
        speechVoices: resolved.speechVoices,
        clientRects: resolved.clientRects,
        fonts: resolved.fonts,
        fontList: resolved.fontList,
        webgpu: resolved.webgpu,
        webrtcMode: resolved.webrtcMode,
        webrtcIp: resolved.webrtcIp,
        mediaDevices: resolved.mediaDevices,
        geolocation: resolved.geolocation ? { mode: 'allow', latitude: resolved.geolocation.latitude, longitude: resolved.geolocation.longitude } : null,
        doNotTrack: resolved.doNotTrack,
        battery: resolved.battery,
        deviceName: resolved.deviceName,
        macAddress: resolved.macAddress,
        videoSpoofing: resolved.videoSpoofing,
        mobile: false,
        model: '',
        formFactor: 'Desktop',
        seed,
      } : null,
    };
  }

  private tabConfigArg(t: Tab): string {
    const cfg = this.tabConfig(t);
    return `--octo-cfg=${Buffer.from(JSON.stringify(cfg), 'utf8').toString('base64')}`;
  }

  private createView(t: Tab, adopt?: WebContents): void {
    const s = this.rt.controller.privacy;
    const graphicsBlocked = this.rt.settings.load().privacyRuntime?.graphicsExposure === 'block';
    const partition = typeof this.rt.sessionPartitionName === 'function'
      ? this.rt.sessionPartitionName() : profilePartition(this.rt.profile.id);
    const view = adopt ? new WebContentsView({ webContents: adopt } as Electron.WebContentsViewConstructorOptions) : new WebContentsView({
      webPreferences: {
        ...SAFE_WEB_PREFERENCES,
        preload: path.join(this.rt.distDir, 'preload-tab.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false, // run the privacy preload in iframes too
        webviewTag: false,
        // `webgl: false` blocks the API; it does not impersonate another GPU.
        webgl: !graphicsBlocked && s.webgl === 'allow',
        plugins: true, // built-in PDF viewer
        spellcheck: false,
        safeDialogs: true,
        autoplayPolicy: s.blockAutoplay ? 'document-user-activation-required' : 'no-user-gesture-required',
        additionalArguments: [this.tabConfigArg(t)],
        partition,
      },
    });
    view.setBackgroundColor('#ffffff');
    t.view = view;
    const wc = view.webContents;
    const wcId = wc.id;
    tabContents.add(wcId);
    wc.once('destroyed', () => {
      tabContents.delete(wcId);
      // Deferred: Electron is still inside the destroy sequence here.
      setImmediate(() => t.owner.onTabContentsDestroyed(t, view));
    });
    this.rt.onTabCreated?.(wc);
    // Under proxy lockdown WebRTC may never open a UDP path around the proxy,
    // whatever the fingerprint or the global setting say.
    const lockedDown = this.rt.profile.network.mode === 'proxy' && this.rt.profile.network.lockdown !== false;
    wc.setWebRTCIPHandlingPolicy(lockedDown ? 'disable_non_proxied_udp' : this.rt.fp?.enabled ? this.rt.fp.webrtcPolicy : s.webrtc);
    wc.setAudioMuted(t.muted || this.rt.profile.audio.muted);
    this.wireTab(t, wc);
    this.win.contentView.addChildView(view);
  }

  private wireTab(t: Tab, wc: WebContents): void {
    // A live WebContentsView can move between browser windows. Every callback
    // resolves its current owner at event time so detachment never leaves page
    // events targeting a closed source window.
    const owner = () => t.owner;
    const update = () => owner().pushTab(t);
    wc.on('did-start-loading', () => { t.loading = true; update(); });
    wc.on('did-stop-loading', () => { t.loading = false; update(); });
    wc.on('page-title-updated', (_e, title) => { t.title = title; update(); });
    wc.on('page-favicon-updated', (_e, favs) => { t.favicon = favs.find((f) => /^(https:|data:image\/)/.test(f)) ?? ''; update(); });
    wc.on('did-navigate', (_e, url) => {
      t.url = url;
      t.crashed = false;
      t.redirectBlocked = undefined;
      update();
      this.rt.recordHistory(url, t.title);
    });
    wc.on('did-navigate-in-page', (_e, url, isMain) => { if (isMain) { t.url = url; update(); } });
    wc.on('audio-state-changed', (e) => { t.audible = e.audible; update(); });
    wc.on('input-event', (_e, input) => {
      if (input.type === 'mouseDown' || input.type === 'keyDown' || input.type === 'gestureTap') t.lastUserInput = Date.now();
    });
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      t.lastUserInput = Date.now();
      const cmd = commandFor({ key: input.key, control: input.control, shift: input.shift, alt: input.alt, meta: input.meta });
      if (cmd) {
        e.preventDefault();
        owner().command(cmd);
      }
    });
    wc.on('dom-ready', () => {
      if (this.rt.profile.addons.includes('dark-pages') && /^https?:/.test(wc.getURL())) {
        void wc.insertCSS(DARK_CSS, { cssOrigin: 'user' }).then((key) => { t.darkCssKey = key; });
      }
      owner().sendAudio(t);
    });
    // Block automatic cross-site top-level redirects without user interaction (Strict).
    wc.on('will-navigate', (e) => {
      if (!this.rt.controller.privacy.confirmCrossSiteRedirects) return;
      const from = wc.getURL();
      const to = e.url;
      if (!/^https?:/.test(from) || !/^https?:/.test(to)) return;
      if (Date.now() - t.lastUserInput < 1500) return;
      const site = (u: string) => { try { return new URL(u).hostname.split('.').slice(-2).join('.'); } catch { return u; } };
      if (site(from) !== site(to)) {
        e.preventDefault();
        t.redirectBlocked = to;
        update();
        this.rt.logger.info('redirect.blocked', { profile: this.rt.profile.id });
      }
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (!isMain || code === -3 /* ABORTED */) return;
      void wc.loadURL(`octo://error?code=${code}&desc=${encodeURIComponent(desc)}&url=${encodeURIComponent(url)}`);
    });
    wc.on('render-process-gone', () => { t.crashed = true; update(); });
    wc.on('enter-html-full-screen', () => { const w = owner(); w.fullscreenHtml = true; w.win.setFullScreen(true); w.pushState(); w.layoutViews(); });
    wc.on('leave-html-full-screen', () => { const w = owner(); w.fullscreenHtml = false; w.win.setFullScreen(false); w.pushState(); w.layoutViews(); });
    wc.on('found-in-page', (_e, r) => owner().send('ui:found', { active: r.activeMatchOrdinal, total: r.matches }));
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (!/^(https?|octo):/.test(url)) return { action: 'deny' };
      // Pop-ups become tabs (no opener relationship => less cross-window tracking).
      if (disposition === 'new-window' && this.rt.controller.privacy.blockPopups && Date.now() - t.lastUserInput > 1500) {
        this.rt.logger.info('popup.blocked', { profile: this.rt.profile.id });
        owner().send('ui:toast', { key: 'toast.popupBlocked' });
        return { action: 'deny' };
      }
      // Normal / standard profiles: real pop-ups with window.opener, exactly like a
      // regular browser (OAuth "Sign in with Google", 3-D Secure payments, SSO...).
      // Strict / Tor profiles: the pop-up opens as an unrelated tab (no opener).
      const level = this.rt.profile.protection?.level;
      const keepOpener = (level === 'normal' || level === 'standard') && disposition !== 'background-tab' && /^https?:/.test(url);
      if (keepOpener) {
        return {
          action: 'allow',
          createWindow: (options: Electron.BrowserWindowConstructorOptions & { webContents?: WebContents }) => {
            const child = options.webContents;
            if (!child) throw new Error('no child webContents');
            tabContents.add(child.id); // before its first navigation is checked by hardening
            return owner().adoptTab(child, url, t.id);
          },
        };
      }
      owner().newTab(url, { active: disposition !== 'background-tab', after: t.id });
      return { action: 'deny' };
    });
    wc.on('context-menu', (_e, params) => owner().contextMenu(t, params));
  }

  newTab(url: string, opts: { active?: boolean; after?: number; pinned?: boolean; group?: string; sleeping?: boolean; title?: string } = {}): number {
    const t = new Tab(this, url, this.rt.profile.audio.volume);
    t.pinned = !!opts.pinned;
    t.group = opts.group ?? '';
    t.title = opts.title ?? '';
    const idx = opts.after ? this.tabs.findIndex((x) => x.id === opts.after) + 1 : this.tabs.length;
    this.tabs.splice(idx > 0 ? idx : this.tabs.length, 0, t);
    if (!opts.sleeping) {
      this.createView(t);
      void t.wc?.loadURL(this.rt.normalizeInput(url)).catch(() => undefined);
    }
    if (opts.active !== false) this.activate(t.id);
    else { this.layoutViews(); this.pushState(); }
    return t.id;
  }

  /** Adopt a WebContents created by the page (window.open with opener) as a new active tab. */
  private adoptTab(child: WebContents, url: string, after: number): WebContents {
    const t = new Tab(this, url, this.rt.profile.audio.volume);
    const idx = this.tabs.findIndex((x) => x.id === after) + 1;
    this.tabs.splice(idx > 0 ? idx : this.tabs.length, 0, t);
    this.createView(t, child);
    this.activate(t.id);
    return child;
  }

  activate(id: number): void {
    const t = this.find(id);
    if (!t) return;
    this.activeId = id;
    this.popupOpen = false;
    t.lastActive = Date.now();
    if (t.sleeping) {
      this.createView(t);
      void t.wc?.loadURL(t.url).catch(() => undefined);
    }
    this.bringActiveTabsToFront();
    this.layoutViews();
    this.pushState();
    if (!this.overlay) t.wc?.focus();
  }

  closeTab(id: number): void {
    if (this.closingTabIds.has(id)) return;
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    this.closingTabIds.add(id);
    const [t] = this.tabs.splice(i, 1);
    if (/^https?:/.test(t.url)) this.closedStack.push({ url: t.url, title: t.title });
    if (this.closedStack.length > 25) this.closedStack.shift();
    this.destroyView(t);
    if (this.splitId === id) this.splitId = 0;
    if (this.tabs.length === 0) {
      if (!this.win.isDestroyed()) this.win.close();
      return;
    }
    if (this.activeId === id) this.activate(this.tabs[Math.min(i, this.tabs.length - 1)].id);
    else { this.bringActiveTabsToFront(); this.layoutViews(); this.pushState(); }
  }

  /** Tabs in the order the strip shows them: pinned first, then the rest. */
  private visibleTabs(): Tab[] {
    return [...this.tabs.filter((x) => x.pinned), ...this.tabs.filter((x) => !x.pinned)];
  }

  /**
   * Close a batch of tabs for the tab context menu. When the active tab is among
   * them, the kept tab is selected first, so the batch never wakes a sleeping
   * neighbour only to close it again.
   */
  private closeTabsKeeping(keep: Tab, victims: Tab[]): void {
    if (victims.length === 0) return;
    if (victims.some((x) => x.id === this.activeId)) this.activate(keep.id);
    for (const x of victims) this.closeTab(x.id);
  }

  /**
   * Move a live tab into another controller without destroying or reloading its
   * WebContents. The page, navigation history, form state, audio and profile
   * session therefore remain intact across a deliberate tear-off.
   */
  detachTabTo(id: number, target: BrowserWindowController): boolean {
    if (target === this || this.win.isDestroyed() || target.win.isDestroyed()) return false;
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return false;
    const tab = this.tabs[index];
    const view = tab.view;
    // A destroyed page may race pointer-up. Do not hand Electron an invalid
    // native view; the renderer will already have cancelled the drag on crash.
    if (view && !tab.wc) return false;

    if (view) {
      try {
        this.win.contentView.removeChildView(view);
        target.win.contentView.addChildView(view);
      } catch (err) {
        try { this.win.contentView.addChildView(view); } catch { /* source is closing */ }
        this.rt.logger.warn('tab.detach-view-failed', { error: String((err as Error)?.message ?? err) });
        return false;
      }
    }

    this.tabs.splice(index, 1);
    tab.owner = target;
    target.tabs.push(tab);
    target.activeId = tab.id;
    target.splitId = 0;
    tab.lastActive = Date.now();
    if (tab.sleeping) {
      target.createView(tab);
      void tab.wc?.loadURL(this.rt.normalizeInput(tab.url)).catch(() => undefined);
    }

    if (this.splitId === id || this.activeId === id) this.splitId = 0;
    if (this.tabs.length === 0) {
      // The destination is registered before this point, so closing an emptied
      // source cannot terminate the profile process or destroy the moved view.
      this.closeConfirmed = true;
      this.activeId = 0;
      this.win.close();
    } else {
      if (this.activeId === id) this.activeId = this.tabs[Math.min(index, this.tabs.length - 1)].id;
      this.layoutViews();
      this.pushState();
    }

    target.layoutViews();
    target.bringActiveTabsToFront();
    target.pushState();
    target.win.show();
    target.win.focus();
    if (!target.overlay) tab.wc?.focus();
    return true;
  }

  private sleepIdleTabs(): void {
    const minutes = this.rt.settings.load().ui.sleepTabsAfterMin;
    if (!minutes) return;
    const limit = Date.now() - minutes * 60_000;
    for (const t of this.tabs) {
      if (t.sleeping || t.id === this.activeId || t.id === this.splitId || t.pinned || t.audible) continue;
      if (t.lastActive < limit) {
        this.destroyView(t);
        this.pushTab(t);
      }
    }
  }

  // ---------------------------------------------------------------- layout

  setLayout(rect: Rect, overlay: boolean): void {
    this.content = rect;
    this.overlay = overlay;
    this.layoutViews();
  }

  setPopup(open: boolean): void {
    if (this.win.isDestroyed()) return;
    this.popupOpen = open;
    if (open) {
      try { this.chrome.setBackgroundColor('#00000000'); } catch {}
      try { this.win.contentView.addChildView(this.chrome); } catch {}
    } else {
      this.bringActiveTabsToFront();
    }
  }

  private bringActiveTabsToFront(): void {
    if (this.win.isDestroyed() || this.popupOpen) return;
    const activeTab = this.tabs.find((t) => t.id === this.activeId);
    if (activeTab?.view) {
      try { this.win.contentView.addChildView(activeTab.view); } catch {}
    }
    if (this.splitId) {
      const splitTab = this.tabs.find((t) => t.id === this.splitId);
      if (splitTab?.view) {
        try { this.win.contentView.addChildView(splitTab.view); } catch {}
      }
    }
  }

  private layoutViews(): void {
    if (this.win.isDestroyed()) return;
    const b = this.win.getContentBounds();
    // In Chrome-family mode the WebContentsView intentionally extends into the
    // title-bar overlay. The renderer reserves the control area on its tab row;
    // offsetting it here used to create a blank native strip and make tabs look
    // hidden behind the open page.
    const chromeTop = this.fullscreenHtml ? 0 : this.titleOverlayHeight;
    this.chrome.setBounds({ x: 0, y: chromeTop, width: b.width, height: Math.max(0, b.height - chromeTop) });
    const area: Rect = this.fullscreenHtml
      ? { x: 0, y: 0, width: b.width, height: b.height }
      : { ...this.content, y: this.content.y + chromeTop };
    const hidden = { x: 0, y: 0, width: 0, height: 0 };
    for (const t of this.tabs) {
      if (!t.view) continue;
      let r = hidden;
      if (!this.overlay || this.fullscreenHtml) {
        if (t.id === this.activeId) r = this.splitId && !this.fullscreenHtml ? { ...area, width: Math.floor(area.width / 2) - 2 } : area;
        else if (t.id === this.splitId && !this.fullscreenHtml) {
          const half = Math.floor(area.width / 2);
          r = { x: area.x + half + 2, y: area.y, width: area.width - half - 2, height: area.height };
        }
      }
      t.view.setBounds(r);
      t.view.setVisible(r.width > 0);
    }
    if (this.popupOpen) {
      try { this.win.contentView.addChildView(this.chrome); } catch { /* chrome stays on top of the live page */ }
    }
  }

  // ----------------------------------------------------------------- state

  private tabState(t: Tab): TabState {
    const wc = t.wc;
    const url = t.url;
    return {
      id: t.id,
      title: t.title || url,
      url,
      favicon: t.favicon,
      loading: t.loading,
      audible: t.audible,
      muted: t.muted,
      volume: t.volume,
      pinned: t.pinned,
      group: t.group,
      sleeping: t.sleeping,
      blocked: t.blocked,
      canBack: !!wc?.navigationHistory.canGoBack(),
      canForward: !!wc?.navigationHistory.canGoForward(),
      security: url.startsWith('https:') ? 'https' : url.startsWith('http:') ? 'http' : url.startsWith('octo:') ? 'internal' : 'other',
      crashed: t.crashed,
      zoom: wc ? Math.round(wc.getZoomFactor() * 100) : 100,
      redirectBlocked: t.redirectBlocked,
    };
  }

  state() {
    const ordered = [...this.tabs.filter((t) => t.pinned), ...this.tabs.filter((t) => !t.pinned)];
    return {
      tabs: ordered.map((t) => this.tabState(t)),
      activeId: this.activeId,
      splitId: this.splitId,
      fullscreen: this.fullscreenHtml,
      closedCount: this.closedStack.length,
    };
  }

  pushState(): void {
    this.chromeWc?.send('ui:state', { ...this.state(), ...this.rt.sharedState() });
  }

  private pushTab(t: Tab): void {
    this.chromeWc?.send('ui:tab', this.tabState(t));
  }

  send(channel: string, payload: unknown): void {
    this.chromeWc?.send(channel, payload);
  }

  countBlocked(wc: WebContents | null): void {
    if (!wc) return;
    const t = this.tabs.find((x) => x.wc?.id === wc.id);
    if (t) {
      t.blocked++;
      if (t.id === this.activeId && t.blocked % 5 === 1) this.pushTab(t);
    }
  }

  /** The chrome asked to close: let the runtime flush and save, then really close. */
  confirmClose(force: boolean): void {
    this.closeConfirmed = true;
    if (force) this.rt.logger.info('window.force-closed', { tabs: this.tabs.length });
    this.win.close();
  }

  snapshotTabs(): Array<{ url: string; title: string; pinned: boolean; group?: string }> {
    return this.tabs.filter((t) => /^(https?|octo):/.test(t.url)).map((t) => ({ url: t.url, title: t.title, pinned: t.pinned, group: t.group || undefined }));
  }

  activeTabContents(): WebContents | null {
    return this.active?.wc ?? null;
  }

  liveTabContents(): WebContents[] {
    return this.tabs.map((tab) => tab.wc).filter((wc): wc is WebContents => !!wc);
  }


  async probeActivePage(): Promise<FingerprintProbeSnapshot> {
    const wc = this.active?.wc;
    if (!wc) throw new Error('The selected profile has no live page to inspect.');
    return await wc.executeJavaScript(FINGERPRINT_PROBE_SCRIPT, true) as FingerprintProbeSnapshot;
  }

  /** Open only the fixed first-party test destinations; existing test tabs are reused. */
  openFingerprintTestSites(ids: FingerprintTestSiteId[]): void {
    ids.forEach((id, index) => {
      const url = FINGERPRINT_TEST_SITES[id].url;
      const origin = new URL(url).origin;
      let tab = this.tabs.find((candidate) => {
        try { return new URL(candidate.url).origin === origin; } catch { return false; }
      });
      if (!tab) {
        this.newTab(url, { active: index === 0 });
        return;
      }
      if (tab.url !== url && tab.wc) void tab.wc.loadURL(url).catch(() => undefined);
      if (index === 0) this.activate(tab.id);
    });
  }

  /**
   * Capture routing is installed before a page's scripts run. Reload website
   * tabs immediately after the user changes the selected endpoint so their
   * next getUserMedia call cannot keep using the previous/default device.
   */
  applyMediaCaptureSelection(): void {
    for (const tab of this.tabs) {
      if (!tab.view || !/^https?:/i.test(tab.url)) continue;
      tab.wc?.reload();
    }
  }

  /** Default page for initial windows and Ctrl+T. A user-entered home page wins. */
  defaultNewTabUrl(): string {
    const p = this.rt.profile;
    if ((p.browserShell === 'chrome' || (p.baseChromeLook && p.browserShell !== 'chromium')) && p.homePage === 'octo://newtab') {
      // Google can retain an old UI locale in site state. An explicit `hl`
      // keeps the built-in Chrome-style start page aligned with the resolved
      // exit-IP/profile language as well as Accept-Language.
      const lang = this.rt.fp?.enabled !== false ? this.rt.fp?.languages?.[0]?.split('-')[0]?.toLowerCase() : undefined;
      return lang && /^[a-z]{2,3}$/.test(lang) ? `${GOOGLE_HOME}?hl=${encodeURIComponent(lang)}` : GOOGLE_HOME;
    }
    return p.homePage;
  }

  /** Switch any untouched built-in new tabs to the selected base-Chrome page. */
  applyBaseChromeHome(): void {
    const url = this.defaultNewTabUrl();
    for (const t of this.tabs) {
      if (t.url !== 'octo://newtab') continue; // never replace a user-opened page
      t.url = url;
      if (t.view) void t.wc?.loadURL(url);
      this.pushTab(t);
    }
  }

  // -------------------------------------------------------------- actions

  navigate(input: string): void {
    const t = this.active;
    if (!t) return;
    const url = this.rt.normalizeInput(input);
    if (t.sleeping) this.createView(t);
    const wc = t.wc;
    if (!wc) return;
    void wc.loadURL(url);
    wc.focus();
  }

  tabAction(id: number, action: string, arg?: unknown): void {
    const t = this.find(id);
    if (!t) return;
    const wc = t.wc;
    switch (action) {
      case 'activate': this.activate(id); break;
      case 'close': this.closeTab(id); break;
      case 'detach': this.rt.detachTab(this, id, arg); break;
      case 'pin': t.pinned = !t.pinned; this.pushState(); break;
      case 'mute':
        t.muted = !t.muted;
        wc?.setAudioMuted(t.muted || this.rt.profile.audio.muted);
        this.pushTab(t);
        break;
      case 'volume':
        t.volume = Math.max(0, Math.min(100, Math.round(Number(arg) || 0)));
        this.sendAudio(t);
        this.pushTab(t);
        break;
      case 'group': t.group = String(arg ?? '').slice(0, 32); this.pushState(); break;
      case 'duplicate': this.newTab(t.url, { after: t.id }); break;
      case 'reload': wc?.reload(); break;
      case 'sleep':
        if (id !== this.activeId && t.view) {
          this.destroyView(t);
          this.pushState();
        }
        break;
      case 'split': this.splitId = this.splitId === id || id === this.activeId ? 0 : id; if (this.find(this.splitId)?.sleeping) this.activate(this.activeId); this.layoutViews(); this.pushState(); break;
      case 'allow-redirect':
        if (t.redirectBlocked && wc) { const to = t.redirectBlocked; t.redirectBlocked = undefined; t.lastUserInput = Date.now(); void wc.loadURL(to); }
        break;
      case 'dismiss-redirect': t.redirectBlocked = undefined; this.pushTab(t); break;
      case 'new-right': {
        // A pinned tab's right-hand neighbour is the first unpinned slot, which
        // is not necessarily the element after it in insertion order.
        const fresh = this.newTab(this.defaultNewTabUrl(), { after: t.pinned ? undefined : t.id });
        if (t.pinned) this.tabAction(fresh, 'move', this.tabs.filter((x) => x.pinned).length);
        this.send('ui:focus-address', null);
        break;
      }
      case 'close-others': this.closeTabsKeeping(t, this.visibleTabs().filter((x) => x.id !== t.id && !x.pinned)); break;
      case 'close-right': {
        const list = this.visibleTabs();
        const at = list.findIndex((x) => x.id === t.id);
        this.closeTabsKeeping(t, list.slice(at + 1).filter((x) => !x.pinned));
        break;
      }
      case 'close-duplicates': this.closeTabsKeeping(t, this.tabs.filter((x) => x.id !== t.id && !x.pinned && x.url === t.url)); break;
      case 'bookmark-all': {
        const pages = this.visibleTabs().filter((x) => /^https?:/.test(x.url));
        for (const x of pages) this.rt.addBookmark(x.url, x.title);
        this.send('ui:toast', { key: 'toast.bookmarkedAll', params: { count: pages.length } });
        break;
      }
      case 'move': {
        // Renderer indices follow the visible order (pinned tabs first), which
        // can differ from insertion history after a pin toggle.
        const ordered = [...this.tabs.filter((tab) => tab.pinned), ...this.tabs.filter((tab) => !tab.pinned)];
        const pinnedCount = ordered.filter((tab) => tab.pinned).length;
        const min = t.pinned ? 0 : pinnedCount;
        const max = t.pinned ? Math.max(0, pinnedCount - 1) : ordered.length - 1;
        const requested = Number(arg);
        if (!Number.isFinite(requested)) break;
        const to = Math.max(min, Math.min(max, Math.round(requested)));
        const from = ordered.indexOf(t);
        ordered.splice(from, 1);
        ordered.splice(to, 0, t);
        this.tabs = ordered;
        this.pushState();
        break;
      }
      default: break;
    }
  }

  private sendAudio(t: Tab): void {
    t.wc?.send('octo:audio', t.volume / 100, this.rt.profile.audio.outputDeviceId);
  }

  /** Re-apply profile-level audio (mute all / output device). */
  applyProfileAudio(): void {
    for (const t of this.tabs) {
      t.wc?.setAudioMuted(t.muted || this.rt.profile.audio.muted);
      this.sendAudio(t);
    }
    this.pushState();
  }

  command(cmd: Command): void {
    const t = this.active;
    const wc = t?.wc;
    if (cmd.startsWith('tab-')) {
      const n = Number(cmd.slice(4));
      const list = this.state().tabs;
      const target = n === 9 ? list[list.length - 1] : list[n - 1];
      if (target) this.activate(target.id);
      return;
    }
    switch (cmd) {
      case 'new-tab': this.newTab(this.defaultNewTabUrl()); this.send('ui:focus-address', null); break;
      case 'close-tab': if (t) this.closeTab(t.id); break;
      case 'reopen-tab': { const c = this.closedStack.pop(); if (c) this.newTab(c.url); break; }
      case 'next-tab': case 'prev-tab': {
        const list = this.state().tabs;
        const i = list.findIndex((x) => x.id === this.activeId);
        const next = list[(i + (cmd === 'next-tab' ? 1 : -1) + list.length) % list.length];
        if (next) this.activate(next.id);
        break;
      }
      case 'reload': wc?.reload(); break;
      case 'stop': wc?.stop(); break;
      case 'hard-reload': wc?.reloadIgnoringCache(); break;
      case 'back': if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break;
      case 'forward': if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break;
      case 'fullscreen': this.win.setFullScreen(!this.win.isFullScreen()); break;
      case 'mute-tab': if (t) this.tabAction(t.id, 'mute'); break;
      case 'mute-profile': this.rt.toggleProfileMute(); break;
      case 'volume-up': case 'volume-down': if (t) this.tabAction(t.id, 'volume', t.volume + (cmd === 'volume-up' ? 10 : -10)); break;
      case 'split': if (t) { const other = this.tabs.find((x) => x.id !== t.id && !x.sleeping) ?? this.tabs.find((x) => x.id !== t.id); if (other) this.tabAction(other.id, 'split'); } break;
      case 'pip':
        void wc?.executeJavaScript(`(() => { const v = [...document.querySelectorAll('video')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]; if (!v) return false; if (document.pictureInPictureElement) { document.exitPictureInPicture(); } else { v.requestPictureInPicture(); } return true; })()`, true).catch(() => undefined);
        break;
      case 'zoom-in': if (wc) { wc.setZoomFactor(Math.min(3, wc.getZoomFactor() + 0.1)); this.pushTab(t!); } break;
      case 'zoom-out': if (wc) { wc.setZoomFactor(Math.max(0.3, wc.getZoomFactor() - 0.1)); this.pushTab(t!); } break;
      case 'zoom-reset': if (wc) { wc.setZoomFactor(1); this.pushTab(t!); } break;
      case 'devtools': wc?.toggleDevTools(); break;
      case 'print': wc?.print(); break;
      case 'bookmark': if (t) this.rt.addBookmark(t.url, t.title); this.send('ui:toast', { key: 'toast.bookmarked' }); break;
      case 'switch-profile': this.rt.openLauncher(); break;
      default: this.send('ui:command', cmd); // panels, find, focus-address, search-tabs: handled by the UI
    }
  }

  find_(text: string, opts: { forward?: boolean; findNext?: boolean } = {}): void {
    const wc = this.active?.wc;
    if (!wc) return;
    if (!text) wc.stopFindInPage('clearSelection');
    else wc.findInPage(text, { forward: opts.forward ?? true, findNext: opts.findNext ?? false });
  }

  private contextMenu(t: Tab, p: Electron.ContextMenuParams): void {
    const T = (k: string) => this.rt.t(k);
    const wc = t.wc;
    if (!wc) return;
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (p.linkURL && /^https?:/.test(p.linkURL)) {
      items.push({ label: T('ctx.openLinkNewTab'), click: () => this.newTab(p.linkURL, { active: false, after: t.id }) });
      items.push({ label: T('ctx.copyLink'), click: () => clipboard.writeText(p.linkURL) });
      items.push({ type: 'separator' });
    }
    if (p.hasImageContents && /^https?:/.test(p.srcURL)) {
      items.push({ label: T('ctx.openImageNewTab'), click: () => this.newTab(p.srcURL, { active: false, after: t.id }) });
      items.push({ label: T('ctx.saveImage'), click: () => wc.downloadURL(p.srcURL) });
      items.push({ type: 'separator' });
    }
    if (p.selectionText) {
      items.push({ label: T('ctx.copy'), role: 'copy' });
      items.push({ label: T('ctx.searchSelection'), click: () => this.newTab(p.selectionText.slice(0, 200), { after: t.id }) });
    }
    if (p.isEditable) {
      const clipboardAllowed = this.rt.profile.sandbox.clipboard === 'allow';
      // Smart Paste is available for every profile. It inserts clipboard text
      // directly into the focused field after normalising non-breaking spaces
      // and Windows line endings, without granting the page any clipboard API.
      const smartPaste: Electron.MenuItemConstructorOptions = {
        label: T('ctx.smartPaste'),
        enabled: true,
        click: () => {
          void clipboard.readText().then((raw) => {
            const text = raw.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n');
            if (!text || wc.isDestroyed()) return;
            // Let the isolated preload type the normalized text in short
            // word-sized chunks. This keeps framework input events, masking
            // widgets, and password fields behaving like keyboard entry.
            try { wc.send('octo:smart-paste-to-focused', text); }
            catch { /* nothing left to try: the tab is going away */ }
          }).catch(() => undefined);
        },
      };
      if (this.rt.profile.baseChromeLook) {
        // Full familiar Chrome-style edit menu in base Chrome mode.
        items.push(
          { label: T('ctx.undo'), role: 'undo' },
          { label: T('ctx.redo'), role: 'redo' },
          { type: 'separator' },
          { label: T('ctx.cut'), role: 'cut' },
          { label: T('ctx.copy'), role: 'copy' },
          { label: T('ctx.paste'), role: 'paste', enabled: clipboardAllowed },
          smartPaste,
          { label: T('ctx.pastePlain'), role: 'pasteAndMatchStyle', enabled: clipboardAllowed },
          { type: 'separator' },
          { label: T('ctx.selectAll'), role: 'selectAll' },
        );
      } else {
        items.push(
          { label: T('ctx.cut'), role: 'cut' },
          { label: T('ctx.paste'), role: 'paste', enabled: clipboardAllowed },
          smartPaste,
        );
      }
    }
    if (items.length) items.push({ type: 'separator' });
    items.push(
      { label: T('ctx.back'), enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: T('ctx.forward'), enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: T('ctx.reload'), click: () => wc.reload() },
      { label: T('ctx.pip'), click: () => this.command('pip') },
      { type: 'separator' },
      { label: T('ctx.inspect'), click: () => wc.inspectElement(p.x, p.y) },
    );
    if (/^https?:/.test(t.url)) items.push({ label: T('ctx.openExternal'), click: () => void shell.openExternal(t.url) });
    Menu.buildFromTemplate(items).popup();
  }

  async translateActivePage(targetLang: string): Promise<{ ok: boolean; detected?: string; error?: string }> {
    const wc = this.activeTabContents();
    if (!wc) return { ok: false, error: 'no-page' };
    const lang = /^[a-z]{2}(?:-[A-Z]{2})?$/.test(targetLang) ? targetLang : 'en';
    const harvest = await wc.executeJavaScript(`(() => {
      const skip = new Set(['SCRIPT','STYLE','NOSCRIPT','TEXTAREA','INPUT','CODE','PRE','SVG']);
      const texts = [];
      const walk = (n) => {
        if (!n) return;
        if (n.nodeType === 1) {
          if (skip.has(n.tagName) || n.isContentEditable) return;
          for (const c of n.childNodes) walk(c);
        } else if (n.nodeType === 3) {
          const t = n.nodeValue || '';
          if (t.trim().length > 1) texts.push(t);
        }
      };
      walk(document.body);
      return { lang: document.documentElement.lang || '', texts: texts.slice(0, 280) };
    })()`, true) as { lang: string; texts: string[] };
    const unique = [...new Set(harvest.texts.map((s) => s.slice(0, 450)))].slice(0, 160);
    const map = new Map<string, string>();
    let detected = (harvest.lang || '').slice(0, 8);
    const chunkSize = 12;
    for (let i = 0; i < unique.length; i += chunkSize) {
      const chunk = unique.slice(i, i + chunkSize);
      const q = chunk.join('\n');
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(lang)}&dt=t&q=${encodeURIComponent(q)}`;
      try {
        const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (!res.ok) continue;
        const json = await res.json() as unknown;
        const parts = Array.isArray(json) ? json[0] : null;
        if (Array.isArray(json) && typeof json[2] === 'string' && !detected) detected = json[2];
        const translated = Array.isArray(parts) ? parts.map((p) => (Array.isArray(p) ? String(p[0] ?? '') : '')).join('') : '';
        const lines = translated.split('\n');
        chunk.forEach((src, idx) => { if (lines[idx]) map.set(src, lines[idx]); });
      } catch {
        return { ok: false, error: 'translate-failed' };
      }
    }
    const payload = JSON.stringify([...map.entries()]);
    await wc.executeJavaScript(`(() => {
      const map = new Map(${payload});
      if (!window.__octoOrigText) window.__octoOrigText = [];
      const skip = new Set(['SCRIPT','STYLE','NOSCRIPT','TEXTAREA','INPUT','CODE','PRE','SVG']);
      const walk = (n) => {
        if (!n) return;
        if (n.nodeType === 1) {
          if (skip.has(n.tagName) || n.isContentEditable) return;
          for (const c of n.childNodes) walk(c);
        } else if (n.nodeType === 3) {
          const t = n.nodeValue || '';
          const next = map.get(t) || map.get(t.slice(0, 450));
          if (next && next !== t) {
            window.__octoOrigText.push([n, t]);
            n.nodeValue = next;
          }
        }
      };
      walk(document.body);
      document.documentElement.lang = ${JSON.stringify(lang)};
      const root = document.documentElement;
      root.animate([{ opacity: .72 }, { opacity: 1 }], { duration: 280, easing: 'ease-out' });
      return true;
    })()`, true);
    return { ok: true, detected };
  }

  async restoreActivePageTranslation(): Promise<boolean> {
    const wc = this.activeTabContents();
    if (!wc) return false;
    await wc.executeJavaScript(`(() => {
      const list = window.__octoOrigText;
      if (!Array.isArray(list)) return false;
      for (const [n, t] of list) { try { if (n) n.nodeValue = t; } catch {} }
      window.__octoOrigText = [];
      return true;
    })()`, true);
    return true;
  }

  focus(): void {
    if (this.win.isMinimized()) this.win.restore();
    // A profile may have been hidden by the OS while its launcher stayed
    // foreground. Showing before focusing makes the manager's Focus action
    // recover the real browser window rather than a hidden native window.
    this.win.show();
    this.win.focus();
  }

  close(): void {
    if (!this.win.isDestroyed()) this.win.close();
  }
}
