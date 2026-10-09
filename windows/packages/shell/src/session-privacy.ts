/**
 * packages/shell/src/session-privacy.ts
 *
 * Applies a profile's privacy settings to its Electron Session:
 *   - proxy (system / direct / fixed rules),
 *   - HTTPS-Only (upgrade + interstitial fallback),
 *   - ad/tracker blocking, tracking-parameter stripping, bounce unwrapping,
 *   - third-party cookie stripping, Referer trimming, Sec-GPC,
 *   - permission policy (camera, mic, geolocation, notifications, clipboard,
 *     USB/HID/Serial/Bluetooth...),
 *   - downloads into the profile folder with dangerous-file confirmation,
 *   - certificate capture for the security panel,
 *   - traffic counters (bytes, requests, active connections, domains).
 *
 * Electron allows only ONE listener per webRequest event and session, so all
 * logic lives in the handlers below. Nothing about page CONTENT is recorded;
 * domains are kept in memory only and are cleared when the profile closes.
 */
import { Session, WebContents, DownloadItem } from 'electron';
import * as path from 'node:path';
import { getDomain, getHostname } from 'tldts';
import { safeDownloadFilename, safeDownloadSource } from './downloads';
import {
  Logger, Profile, PrivacySettings, effectiveSettings, isDangerousFile, stripTrackingParams, unwrapBounce,
} from '@octo/core';
import type { AdblockService } from './adblock';

export interface CertInfo {
  host: string;
  subject: string;
  issuer: string;
  validFrom: number;
  validTo: number;
  fingerprint: string;
  verified: boolean;
}

export class TrafficCounters {
  bytesIn = 0;
  bytesOut = 0;
  requests = 0;
  readonly active = new Set<number>();
  /** host -> request count (memory only). */
  readonly domains = new Map<string, number>();
  blocked = { ads: 0, trackers: 0, scripts: 0 };
  httpsUpgrades = 0;
  paramsStripped = 0;
  thirdPartyCookiesBlocked = 0;
  /** Requests cancelled because they would have left outside the proxy. */
  leaksBlocked = 0;

  reset(): void {
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.requests = 0;
    this.active.clear();
    this.domains.clear();
    this.blocked = { ads: 0, trackers: 0, scripts: 0 };
    this.httpsUpgrades = 0;
    this.paramsStripped = 0;
    this.thirdPartyCookiesBlocked = 0;
    this.leaksBlocked = 0;
  }
}

export type PermissionKind =
  | 'camera' | 'microphone' | 'media' | 'geolocation' | 'notifications' | 'clipboard-read' | 'display-capture'
  | 'devices' | 'openExternal' | 'pointerLock' | 'storage-access' | 'other';

export interface PrivacyHooks {
  logger: Logger;
  adblock: AdblockService | null;
  /** Ask the user (UI prompt). Must resolve to true only on explicit consent. */
  askPermission(wc: WebContents | null, kind: PermissionKind, origin: string): Promise<boolean>;
  confirmDangerousDownload(wc: WebContents | null, fileName: string): Promise<boolean>;
  /** Resolve the final native Windows path. Null means the user cancelled the picker. */
  chooseDownloadPath?(wc: WebContents | null, suggestedFileName: string): Promise<string | null>;
  chooseDownloadDestination?(wc: WebContents | null, suggestedFileName: string): {
    savePath?: string;
    saveDialogOptions?: Electron.SaveDialogOptions;
  };
  onDownloadUpdate?(info: DownloadInfo): void;
  /** Release and acknowledge any trusted-UI preview before website capture is allowed. */
  onMediaRequest?(wc: WebContents | null): Promise<void> | void;
  /** HTTPS upgrade of a top-level page failed: show interstitial. */
  onHttpsFailed?(wc: WebContents, originalUrl: string): void;
  /** Called when a request was blocked (for the per-tab counter). */
  onBlocked?(wc: WebContents | null, category: 'ads' | 'trackers'): void;
  /** Local byte accounting callback. Header-delimited downloads are counted; chunked bodies may not expose a size. */
  onTrafficDelta?(bytesIn: number, bytesOut: number): void;
  /** Optional local quota gate, checked before a new network request starts. */
  isTrafficAllowed?(): boolean;
  /** Offline mode: cancel every network request. */
  isOffline?(): boolean;
}

export type DownloadState = 'choosing-location' | 'downloading' | 'paused' | 'scanning' | 'completed' | 'cancelled' | 'failed';

export interface DownloadInfo {
  id: string;
  profileId: string;
  fileName: string;
  /** Final path only. It stays empty until the destination has been accepted. */
  savePath: string;
  /** Display-safe source: no credentials, query parameters, or fragment. */
  url: string;
  state: DownloadState;
  received: number;
  total: number;
  speedBytesPerSecond: number;
  etaSeconds: number | null;
  canResume: boolean;
  dangerous: boolean;
  startedAt: string;
  error?: string;
}

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i;
/** Loopback / unspecified addresses of THIS machine. */
function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '::1' || h === '0.0.0.0' || h === '::';
}

function isThirdParty(requestUrl: string, firstPartyUrl: string | undefined): boolean {
  if (!firstPartyUrl) return false;
  const a = getDomain(requestUrl) ?? getHostname(requestUrl);
  const b = getDomain(firstPartyUrl) ?? getHostname(firstPartyUrl);
  return !!a && !!b && a !== b;
}

function setHeader(headers: Record<string, string | string[]>, name: string, value: string | null): void {
  for (const k of Object.keys(headers)) if (k.toLowerCase() === name.toLowerCase()) delete headers[k];
  if (value !== null) headers[name] = value;
}

export class ProfileSessionController {
  readonly counters = new TrafficCounters();
  readonly certs = new Map<string, CertInfo>();
  readonly downloads = new Map<string, {
    item: DownloadItem; info: DownloadInfo; sourceUrl: string; locationVersion: number;
    lastSampleAt: number; lastSampleBytes: number; acceptPath?: (selected: string) => Promise<void>;
  }>();
  /** Hosts the user allowed over plain HTTP for this run (never persisted). */
  private readonly httpAllowed = new Set<string>();
  /** webContents id -> original http URL that was upgraded for the top frame. */
  private readonly upgradedTop = new Map<number, string>();
  /** In-memory permission decisions for this run: origin|kind -> granted. */
  private readonly grants = new Map<string, boolean>();

  originPermissionState(origin: string, kind: PermissionKind): 'allow' | 'block' | 'ask' {
    const pol = this.policy(kind);
    if (pol === 'deny') return 'block';
    if (pol === 'allow') return 'allow';
    const g = this.grants.get(`${origin}|${kind}`);
    if (g === true) return 'allow';
    if (g === false) return 'block';
    return 'ask';
  }

  setOriginPermission(origin: string, kind: PermissionKind, state: 'allow' | 'block' | 'ask'): void {
    const key = `${origin}|${kind}`;
    if (state === 'ask') this.grants.delete(key);
    else this.grants.set(key, state === 'allow');
  }

  clearOriginPermissions(origin: string): void {
    for (const key of [...this.grants.keys()]) if (key.startsWith(`${origin}|`)) this.grants.delete(key);
  }
  /** Coalesce concurrent same-origin prompts so one page action yields one bar. */
  private readonly permissionPrompts = new Map<string, Promise<boolean>>();
  private settings: PrivacySettings;
  private downloadSeq = 0;
  /** Proxy rules replacing profile.network.proxyRules (local SOCKS bridge). */
  private proxyOverride: string | null = null;
  /** Kill switch: while on, every network request of this profile is cancelled. */
  private killSwitch = false;
  /** Cache of "does this origin really go through the proxy?" answers. */
  private readonly proxyRoute = new Map<string, boolean>();
  /** Identity headers are scoped to this profile session and never persisted. */
  private identityUserAgent: string | null = null;
  private identityAcceptLanguages = '';

  constructor(
    readonly ses: Session,
    private profile: Profile,
    private readonly downloadsDir: string,
    private readonly hooks: PrivacyHooks,
  ) {
    this.settings = effectiveSettings(profile.protection);
  }

  get privacy(): PrivacySettings {
    return this.settings;
  }

  get currentProfile(): Profile {
    return this.profile;
  }

  /**
   * Apply the profile route before any startup network lookup. In particular,
   * exit-IP locale resolution must never run through the host route first.
   */
  async prepareNetwork(): Promise<void> {
    await this.applyProxy();
    await this.ses.closeAllConnections();
  }

  /** Install all handlers. Call once per session. */
  async install(userAgent: string | null, acceptLanguages: string): Promise<void> {
    this.ses.setSpellCheckerEnabled(false); // spellchecker would download dictionaries from Google
    this.updateIdentity(userAgent, acceptLanguages);
    await this.applyProxy();
    this.installWebRequest();
    this.installPermissions();
    this.installDownloads();
    this.installCertificateCapture();
  }

  /** Apply updated UA and language headers for new requests/targets. */
  updateIdentity(userAgent: string | null, acceptLanguages: string): void {
    this.identityUserAgent = typeof userAgent === 'string' && userAgent.trim() ? userAgent.trim() : null;
    this.identityAcceptLanguages = typeof acceptLanguages === 'string' ? acceptLanguages.trim() : '';
    try { this.ses.setUserAgent(this.identityUserAgent ?? undefined as never); } catch { /* test doubles / older Electron */ }
  }

  /** Route the profile through different rules (e.g. the local auth bridge); null = profile rules. */
  async setProxyOverride(rules: string | null): Promise<void> {
    this.proxyOverride = rules;
    this.proxyRoute.clear();
    await this.applyProxy();
    await this.ses.closeAllConnections();
  }

  /**
   * Cut every connection of this profile (dead man's switch). Existing sockets
   * are closed as well, so nothing keeps streaming after the switch is thrown.
   */
  async setKillSwitch(on: boolean): Promise<void> {
    if (this.killSwitch === on) return;
    this.killSwitch = on;
    this.proxyRoute.clear();
    if (on) await this.ses.closeAllConnections();
    this.hooks.logger.info('profile.kill-switch', { profile: this.profile.id, on });
  }

  get killSwitchOn(): boolean {
    return this.killSwitch;
  }

  /** Is this profile fail-closed behind its proxy? */
  get lockdown(): boolean {
    return this.profile.network.mode === 'proxy' && this.profile.network.lockdown !== false;
  }

  /** Re-apply after the profile was edited. */
  async update(profile: Profile): Promise<void> {
    const proxyChanged = JSON.stringify(profile.network) !== JSON.stringify(this.profile.network);
    this.profile = profile;
    this.settings = effectiveSettings(profile.protection);
    this.grants.clear();
    if (proxyChanged) {
      this.proxyRoute.clear();
      await this.applyProxy();
      await this.ses.closeAllConnections();
    }
  }

  private async applyProxy(): Promise<void> {
    const n = this.profile.network;
    if (n.mode === 'proxy' && (this.proxyOverride || n.proxyRules)) {
      // Under lockdown nothing is bypassed unless the user typed a bypass list
      // themselves: even loopback and plain-IP requests take the proxy, so the
      // real address is never used by accident.
      const bypass = n.proxyBypass || (this.lockdown ? '<-loopback>' : '<local>');
      await this.ses.setProxy({ mode: 'fixed_servers', proxyRules: this.proxyOverride || n.proxyRules!, proxyBypassRules: bypass });
    } else if (n.mode === 'direct') {
      await this.ses.setProxy({ mode: 'direct' });
    } else {
      await this.ses.setProxy({ mode: 'system' });
    }
    this.hooks.logger.info('profile.proxy', { profile: this.profile.id, mode: n.mode });
  }

  /** Describe the proxy that would be used for a URL ("DIRECT", "PROXY host:port", "SOCKS5 ..."). */
  async resolveProxy(url = 'https://example.com/'): Promise<string> {
    try {
      return await this.ses.resolveProxy(url);
    } catch {
      return 'UNKNOWN';
    }
  }

  allowHttpFor(host: string): void {
    this.httpAllowed.add(host.toLowerCase());
  }

  // ------------------------------------------------------------ webRequest

  private installWebRequest(): void {
    const wr = this.ses.webRequest;

    wr.onBeforeRequest((details, cb) => {
      const s = this.settings;
      const url = details.url;
      if (!/^(https?|wss?):/i.test(url)) return cb({}); // internal / data / blob / devtools
      if (this.killSwitch || this.hooks.isOffline?.() || this.hooks.isTrafficAllowed?.() === false) return cb({ cancel: true });
      let host = '';
      let parsed: URL;
      try { parsed = new URL(url); host = parsed.hostname.toLowerCase(); } catch { return cb({ cancel: true }); }

      // 0. Proxy lockdown: refuse anything Chromium would send outside the proxy.
      if (this.lockdown) {
        const key = `${parsed.protocol}//${host}:${parsed.port}`;
        const known = this.proxyRoute.get(key);
        if (known === false) { this.counters.leaksBlocked++; return cb({ cancel: true }); }
        if (known === undefined) {
          // First request to this origin: ask Chromium which proxy it resolves
          // to and cancel when the answer is DIRECT. The answer is cached, so
          // this costs one resolve per origin, not per request.
          void this.ses.resolveProxy(url).then((route) => {
            const proxied = !/^DIRECT/i.test(String(route || 'DIRECT').trim());
            this.proxyRoute.set(key, proxied);
            if (!proxied) {
              this.counters.leaksBlocked++;
              this.hooks.logger.warn('profile.proxy-leak-blocked', { profile: this.profile.id, host });
            }
            cb(proxied ? {} : { cancel: true });
          }, () => { this.counters.leaksBlocked++; cb({ cancel: true }); });
          return;
        }
      }

      // 1. HTTPS-Only upgrade
      if (s.httpsOnly && /^(http|ws):/i.test(url) && !LOCAL_HOST.test(host) && !host.endsWith('.onion') && !this.httpAllowed.has(host)) {
        const upgraded = url.replace(/^http:/i, 'https:').replace(/^ws:/i, 'wss:');
        this.counters.httpsUpgrades++;
        if (details.resourceType === 'mainFrame' && details.webContentsId !== undefined) this.upgradedTop.set(details.webContentsId, url);
        return cb({ redirectURL: upgraded });
      }

      // 2. URL cleaning for top-level navigations
      if (details.resourceType === 'mainFrame') {
        if (s.blockBounceTracking) {
          const target = unwrapBounce(url);
          if (target) {
            this.counters.paramsStripped++;
            return cb({ redirectURL: target });
          }
        }
        if (s.stripTrackingParams && this.profile.addons.includes('clearurls')) {
          const clean = stripTrackingParams(url);
          if (clean !== url) {
            this.counters.paramsStripped++;
            return cb({ redirectURL: clean });
          }
        }
      }

      // 3. Ad / tracker blocking
      if (this.hooks.adblock && this.profile.addons.includes('adblock') && (s.blockAds || s.blockTrackers)) {
        const m = this.hooks.adblock.match(details, { ads: s.blockAds, trackers: s.blockTrackers });
        if (m.category) {
          this.counters.blocked[m.category]++;
          if (details.resourceType === 'script') this.counters.blocked.scripts++;
          this.hooks.onBlocked?.(details.webContents ?? null, m.category);
          return cb(m.redirect ? { redirectURL: m.redirect } : { cancel: true });
        }
      }

      // 4. Accounting (memory only)
      this.counters.requests++;
      this.counters.active.add(details.id);
      this.counters.domains.set(host, (this.counters.domains.get(host) ?? 0) + 1);
      if (details.uploadData) {
        let bytesOut = 0;
        for (const part of details.uploadData) bytesOut += part.bytes?.length ?? 0;
        this.counters.bytesOut += bytesOut;
        if (bytesOut) this.hooks.onTrafficDelta?.(0, bytesOut);
      }
      cb({});
    });

    wr.onBeforeSendHeaders((details, cb) => {
      const s = this.settings;
      const headers = { ...details.requestHeaders } as Record<string, string>;
      if (this.identityUserAgent) setHeader(headers, 'User-Agent', this.identityUserAgent);
      if (this.identityAcceptLanguages) setHeader(headers, 'Accept-Language', this.identityAcceptLanguages);
      const topUrl = details.webContents?.getURL();
      const third = details.resourceType !== 'mainFrame' && isThirdParty(details.url, topUrl);
      if (s.blockThirdPartyCookies && third && Object.keys(headers).some((k) => k.toLowerCase() === 'cookie')) {
        setHeader(headers, 'Cookie', null);
        this.counters.thirdPartyCookiesBlocked++;
      }
      if (s.trimReferrer) {
        const ref = Object.entries(headers).find(([k]) => k.toLowerCase() === 'referer')?.[1];
        if (ref && isThirdParty(details.url, ref)) {
          try { setHeader(headers, 'Referer', `${new URL(ref).origin}/`); } catch { setHeader(headers, 'Referer', null); }
        }
      }
      if (s.globalPrivacyControl) setHeader(headers, 'Sec-GPC', '1');
      cb({ requestHeaders: headers });
    });

    wr.onHeadersReceived((details, cb) => {
      const s = this.settings;
      const headers = details.responseHeaders ? { ...details.responseHeaders } : undefined;
      if (headers) {
        const len = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-length')?.[1]?.[0];
        if (len && /^\d+$/.test(len)) {
          const bytesIn = Number(len);
          this.counters.bytesIn += bytesIn;
          this.hooks.onTrafficDelta?.(bytesIn, 0);
        }
        const topUrl = details.webContents?.getURL();
        if (s.blockThirdPartyCookies && details.resourceType !== 'mainFrame' && isThirdParty(details.url, topUrl)) {
          for (const k of Object.keys(headers)) {
            if (k.toLowerCase() === 'set-cookie') {
              delete headers[k];
              this.counters.thirdPartyCookiesBlocked++;
            }
          }
        }
      }
      cb({ responseHeaders: headers });
    });

    wr.onCompleted((details) => {
      this.counters.active.delete(details.id);
      if (details.resourceType === 'mainFrame' && details.webContentsId !== undefined) this.upgradedTop.delete(details.webContentsId);
    });

    wr.onErrorOccurred((details) => {
      this.counters.active.delete(details.id);
      if (details.resourceType !== 'mainFrame' || details.webContentsId === undefined) return;
      const original = this.upgradedTop.get(details.webContentsId);
      this.upgradedTop.delete(details.webContentsId);
      if (original && details.webContents && details.error !== 'net::ERR_ABORTED') {
        this.hooks.onHttpsFailed?.(details.webContents, original);
      }
    });
  }

  // ----------------------------------------------------------- permissions

  private mapPermission(permission: string, details: { mediaTypes?: string[]; mediaType?: string }): PermissionKind[] {
    switch (permission) {
      case 'camera':
      case 'videoCapture':
      case 'video-capture':
      case 'video':
        return ['camera'];
      case 'microphone':
      case 'audioCapture':
      case 'audio-capture':
      case 'audio':
        return ['microphone'];
      case 'media': {
        const kinds: PermissionKind[] = [];
        // Electron/Chromium versions have used video/audio as well as
        // video_capture/audio_capture here. Treating an unfamiliar camera-only
        // value as both kinds made camera access depend on microphone policy.
        const rawTypes = details.mediaTypes ?? (details.mediaType ? [details.mediaType] : []);
        const types = rawTypes.map((value) => String(value).toLowerCase());
        if (types.some((value) => value === 'video' || value === 'camera' || value.includes('video'))) kinds.push('camera');
        if (types.some((value) => value === 'audio' || value === 'microphone' || value.includes('audio'))) kinds.push('microphone');
        return kinds.length ? kinds : ['camera', 'microphone'];
      }
      case 'geolocation': return ['geolocation'];
      case 'notifications': return ['notifications'];
      case 'clipboard-read': return ['clipboard-read'];
      case 'display-capture': return ['display-capture'];
      case 'openExternal': return ['openExternal'];
      case 'pointerLock': return ['pointerLock'];
      case 'storage-access':
      case 'top-level-storage-access': return ['storage-access'];
      case 'hid': case 'serial': case 'usb': case 'bluetooth': return ['devices'];
      default: return ['other'];
    }
  }

  /** Static policy: 'deny' | 'allow' | 'ask'. */
  private policy(kind: PermissionKind): 'deny' | 'allow' | 'ask' {
    const s = this.settings;
    const sb = this.profile.sandbox;
    switch (kind) {
      case 'camera': return sb.camera ? 'ask' : 'deny';
      case 'microphone': return sb.microphone ? 'ask' : 'deny';
      case 'geolocation': return s.geolocation === 'block' ? 'deny' : 'ask';
      case 'notifications': return s.notifications === 'block' ? 'deny' : 'ask';
      case 'clipboard-read': return sb.clipboard === 'allow' ? 'ask' : 'deny';
      case 'devices': return sb.externalDevices ? 'ask' : 'deny';
      case 'display-capture': return sb.mode === 'restricted' ? 'deny' : 'ask';
      case 'openExternal': return 'ask';
      case 'pointerLock': return 'deny';
      // If third-party cookies are enabled this is ordinary browser behaviour;
      // asking for every embedded frame created repetitive bars. The strict
      // cookie policy still denies it silently.
      case 'storage-access': return 'deny';
      default: return 'deny';
    }
  }

  /** Ask once per origin/permission while parallel requests are awaiting the same user decision. */
  private askPermissionOnce(wc: WebContents | null, kind: PermissionKind, origin: string): Promise<boolean> {
    const key = `${origin}|${kind}`;
    const existing = this.permissionPrompts.get(key);
    if (existing) return existing;

    let pending!: Promise<boolean>;
    pending = Promise.resolve()
      .then(() => this.hooks.askPermission(wc, kind, origin))
      .then((granted) => {
        this.grants.set(key, granted);
        return granted;
      })
      .finally(() => {
        if (this.permissionPrompts.get(key) === pending) this.permissionPrompts.delete(key);
      });
    this.permissionPrompts.set(key, pending);
    return pending;
  }

  private installPermissions(): void {
    this.ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      if (permission === 'fullscreen' || permission === 'speaker-selection') return callback(false);
      // Common site Copy buttons use navigator.clipboard.writeText(). Chromium
      // reports that trusted user-gesture write as clipboard-sanitized-write.
      // Reads remain separately permission-gated; writes follow the profile's
      // explicit clipboard policy and do not expose clipboard contents.
      if (permission === 'clipboard-sanitized-write') return callback(this.profile.sandbox.clipboard !== 'block');
      const kinds = this.mapPermission(permission, details as { mediaTypes?: string[]; mediaType?: string });
      const mediaRequest = kinds.some((kind) => kind === 'camera' || kind === 'microphone');
      let origin = '';
      try { origin = new URL(details.requestingUrl ?? wc.getURL()).origin; } catch { /* keep empty */ }
      (async () => {
        // Chromium must not receive the permission callback until the trusted
        // drawer has stopped and acknowledged its DirectShow tracks. Sending a
        // fire-and-forget renderer event raced getUserMedia on exclusive phone
        // and virtual-camera drivers.
        if (mediaRequest) await this.hooks.onMediaRequest?.(wc);
        // Chromium presents one familiar decision when a call asks for both
        // video and audio. Keep separate grants internally, but avoid forcing
        // the user through two custom-looking prompts for one getUserMedia().
        const undecided = kinds.filter((kind) => this.policy(kind) === 'ask' && !this.grants.has(`${origin}|${kind}`));
        if (undecided.includes('camera') && undecided.includes('microphone')) {
          const ok = await this.askPermissionOnce(wc, 'media', origin);
          this.grants.set(`${origin}|camera`, ok);
          this.grants.set(`${origin}|microphone`, ok);
          if (!ok) return false;
        }
        for (const k of kinds) {
          const pol = this.policy(k);
          if (pol === 'deny') return false;
          if (pol === 'ask') {
            const key = `${origin}|${k}`;
            if (this.grants.has(key)) {
              if (!this.grants.get(key)) return false;
              continue;
            }
            const ok = await this.askPermissionOnce(wc, k, origin);
            if (!ok) return false;
          }
        }
        return true;
      })()
        .then((ok) => {
          this.hooks.logger.info('permission', { permission, granted: ok, profile: this.profile.id });
          callback(ok);
        })
        .catch(() => callback(false));
    });

    this.ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
      if (permission === 'fullscreen' || permission === 'speaker-selection') return true;
      if (permission === 'clipboard-sanitized-write') return this.profile.sandbox.clipboard !== 'block';
      const kinds = this.mapPermission(permission, { mediaTypes: (details as { mediaType?: string }).mediaType ? [(details as { mediaType?: string }).mediaType!] : undefined });
      // Electron can call the check handler before the request handler. An
      // undecided "ask" permission must be allowed to continue to the request
      // handler; returning false here denied website cameras permanently even
      // though Octo's own preview worked. Explicit denials remain denied.
      return kinds.every((k) => {
        const policy = this.policy(k);
        return policy === 'allow' || (policy === 'ask' && this.grants.get(`${requestingOrigin}|${k}`) !== false);
      });
    });

    // WebUSB / WebHID / Web Serial / Bluetooth device pickers.
    // Imported profile data can never grant hardware-device access. Only a future
    // trusted, origin-scoped user decision may do so.
    this.ses.setDevicePermissionHandler(() => false);
    const denyPicker = (e: Electron.Event, _d: unknown, cb: (id: string) => void) => {
      if (!this.profile.sandbox.externalDevices) {
        e.preventDefault();
        cb('');
      }
    };
    this.ses.on('select-hid-device', (e, d, cb) => denyPicker(e, d, cb as (id: string) => void));
    this.ses.on('select-serial-port', (e, _ports, _wc, cb) => denyPicker(e, null, cb));
    this.ses.on('select-usb-device', (e, d, cb) => denyPicker(e, d, cb as (id: string) => void));
  }

  // ------------------------------------------------------------- downloads

  private installDownloads(): void {
    this.ses.on('will-download', (_e, item, wc) => {
      const suggestedName = safeDownloadFilename(item.getFilename());
      let dangerous = isDangerousFile(suggestedName);
      // Pause synchronously, before opening an asynchronous native picker. No
      // destination is assigned and no bytes are written if that picker is
      // cancelled; in particular there is no fallback into Downloads.
      item.pause();
      const info: DownloadInfo = {
        id: `d${++this.downloadSeq}`,
        profileId: this.profile.id,
        fileName: suggestedName,
        savePath: '',
        url: safeDownloadSource(item.getURL()),
        state: 'choosing-location',
        received: 0,
        total: Math.max(0, item.getTotalBytes()),
        speedBytesPerSecond: 0,
        etaSeconds: null,
        canResume: item.canResume(),
        dangerous,
        startedAt: new Date().toISOString(),
      };
      const record = {
        item, info, sourceUrl: item.getURL(), locationVersion: 0,
        lastSampleAt: Date.now(), lastSampleBytes: 0,
        acceptPath: undefined as ((selected: string) => Promise<void>) | undefined,
      };
      this.downloads.set(info.id, record);
      let gated: DownloadState | null = 'choosing-location';
      const emit = () => this.hooks.onDownloadUpdate?.({ ...info });
      const cancel = () => {
        gated = 'cancelled';
        info.state = 'cancelled';
        info.speedBytesPerSecond = 0;
        info.etaSeconds = null;
        emit();
        item.cancel();
      };
      item.on('updated', (_ev, state) => {
        const currentPath = item.getSavePath();
        if (currentPath && (!info.savePath || info.savePath !== currentPath)) {
          info.savePath = currentPath;
          info.fileName = path.basename(currentPath);
          dangerous = isDangerousFile(info.fileName);
          info.dangerous = dangerous;
          if (gated === 'choosing-location') {
            void continueAfterLocation();
          }
        }
        const now = Date.now();
        const received = Math.max(0, item.getReceivedBytes());
        const elapsed = now - record.lastSampleAt;
        if (elapsed >= 250) {
          info.speedBytesPerSecond = Math.max(0, Math.round((received - record.lastSampleBytes) * 1000 / elapsed));
          record.lastSampleAt = now;
          record.lastSampleBytes = received;
        }
        info.received = received;
        info.total = Math.max(0, item.getTotalBytes());
        info.canResume = item.canResume();
        info.etaSeconds = info.total > received && info.speedBytesPerSecond > 0
          ? Math.ceil((info.total - received) / info.speedBytesPerSecond) : null;
        if (gated) info.state = gated;
        else if (item.isPaused()) info.state = 'paused';
        else info.state = state === 'interrupted' ? 'failed' : 'downloading';
        emit();
      });
      item.once('done', (_ev, state) => {
        const finalPath = item.getSavePath();
        if (finalPath && (!info.savePath || info.savePath !== finalPath)) {
          info.savePath = finalPath;
          info.fileName = path.basename(finalPath);
        }
        info.received = Math.max(0, item.getReceivedBytes());
        info.canResume = item.canResume();
        info.speedBytesPerSecond = 0;
        info.etaSeconds = null;
        if (info.state !== 'cancelled' && info.state !== 'failed') {
          info.state = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'failed';
          if (info.state === 'failed') info.error = String(state);
        }
        this.hooks.logger.info('download.done', { profile: this.profile.id, state: info.state, dangerous });
        emit();
      });
      const continueAfterLocation = async (): Promise<void> => {
        if (dangerous && this.settings.warnDangerousDownloads) {
          gated = 'scanning';
          info.state = 'scanning';
          emit();
          const ok = await this.hooks.confirmDangerousDownload(wc ?? null, info.fileName).catch(() => false);
          if (!ok) { cancel(); return; }
        }
        gated = null;
        info.state = 'downloading';
        emit();
        if (item.isPaused()) item.resume();
      };
      record.acceptPath = async (selected: string) => {
        info.savePath = selected;
        info.fileName = path.basename(selected);
        dangerous = isDangerousFile(info.fileName);
        info.dangerous = dangerous;
        item.setSavePath(selected);
        await continueAfterLocation();
      };
      emit();
      if (this.hooks.chooseDownloadDestination) {
        try {
          const dest = this.hooks.chooseDownloadDestination(wc ?? null, suggestedName);
          if (dest.savePath) {
            item.setSavePath(dest.savePath);
            info.savePath = dest.savePath;
            info.fileName = path.basename(dest.savePath);
            dangerous = isDangerousFile(info.fileName);
            info.dangerous = dangerous;
            void continueAfterLocation();
            return;
          }
          if (dest.saveDialogOptions) {
            item.setSaveDialogOptions(dest.saveDialogOptions);
            return;
          }
        } catch (error: unknown) {
          gated = 'failed';
          info.state = 'failed';
          info.error = String((error as Error)?.message ?? error).slice(0, 240);
          emit();
          item.cancel();
          return;
        }
      }
      if (!this.hooks.chooseDownloadPath) {
        info.error = 'No download destination policy is installed';
        info.state = 'failed';
        gated = 'failed';
        emit();
        item.cancel();
        return;
      }
      const locationVersion = ++record.locationVersion;
      this.hooks.chooseDownloadPath(wc ?? null, suggestedName).then(async (selected) => {
        if (locationVersion !== record.locationVersion) return;
        if (!selected) { cancel(); return; }
        await record.acceptPath?.(selected);
      }).catch((error: unknown) => {
        if (locationVersion !== record.locationVersion) return;
        gated = 'failed';
        info.state = 'failed';
        info.error = String((error as Error)?.message ?? error).slice(0, 240);
        emit();
        item.cancel();
      });
    });
  }

  controlDownload(id: string, action: 'pause' | 'resume' | 'cancel'): void {
    const d = this.downloads.get(id);
    if (!d) return;
    if (action === 'pause' && d.info.state === 'downloading') d.item.pause();
    else if (action === 'resume' && d.item.canResume()) d.item.resume();
    else if (action === 'cancel' && !['completed', 'cancelled'].includes(d.info.state)) d.item.cancel();
  }

  /** Source is intentionally main-process-only; UI receives only safeDownloadSource(). */
  retryDownloadUrl(id: string): string {
    const d = this.downloads.get(id);
    return d && (d.info.state === 'failed' || d.info.state === 'cancelled') ? d.sourceUrl : '';
  }

  /** Change a pre-transfer destination. Once bytes exist the caller must retry instead. */
  changeDownloadPath(id: string, selected: string): boolean {
    const d = this.downloads.get(id);
    if (!d || d.info.received > 0 || !['choosing-location', 'scanning'].includes(d.info.state) || !selected) return false;
    d.locationVersion++;
    d.item.pause();
    if (d.info.state === 'scanning') {
      d.item.setSavePath(selected);
      d.info.savePath = selected;
      d.info.fileName = path.basename(selected);
      d.info.dangerous = isDangerousFile(d.info.fileName);
      this.hooks.onDownloadUpdate?.({ ...d.info });
    } else {
      void d.acceptPath?.(selected);
    }
    return true;
  }

  // ----------------------------------------------------------- certificates

  private installCertificateCapture(): void {
    this.ses.setCertificateVerifyProc((req, cb) => {
      const c = req.certificate;
      this.certs.set(req.hostname, {
        host: req.hostname,
        subject: c.subjectName,
        issuer: c.issuerName,
        validFrom: c.validStart,
        validTo: c.validExpiry,
        fingerprint: c.fingerprint,
        verified: req.errorCode === 0,
      });
      cb(-3); // -3 = use Chromium's own verification result (we never weaken it)
    });
  }

  // ------------------------------------------------------------- lifecycle

  /** Clear cookies, storage and caches (clear-on-exit / manual "Clear data"). */
  async clearData(): Promise<void> {
    await this.ses.clearStorageData();
    await this.ses.clearCache();
    await this.ses.clearAuthCache();
    await this.ses.clearHostResolverCache();
    this.hooks.logger.info('profile.cleared', { profile: this.profile.id });
  }

  /** Called when the last window of the profile closes. */
  async onProfileClosed(): Promise<void> {
    this.counters.reset();
    this.certs.clear();
    this.httpAllowed.clear();
    this.grants.clear();
    if (this.settings.clearOnExit || this.profile.deleteOnClose) await this.clearData();
  }
}
