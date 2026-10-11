/**
 * apps/octodetect/src/main/auditor.ts
 *
 * Runs audits and stores reports.
 *
 * Targets:
 *   baseline  - plain Chromium engine without protections (reference point);
 *   standard  - OctoBrowser "Standard" preset (same session controller + page shim as OctoBrowser);
 *   strict    - OctoBrowser "Strict" preset;
 *   external  - any browser: the probe page is opened in the default browser.
 *
 * In-app audits run in a hidden window inside a fresh IN-MEMORY session (no
 * persistence, destroyed afterwards). Reports are stored ENCRYPTED with the
 * app data key (AES-256-GCM) and are never sent anywhere; exporting is an
 * explicit user action.
 */
import { BrowserWindow, app, session, shell } from 'electron';
import * as dns from 'node:dns';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AuditReport, EnvironmentData, NORMALIZED_HARDWARE, Profile, buildReport, decryptWithKey, defaultProfile, detectVpnAdapters,
  effectiveSettings, encryptWithKey, ensureDir, fileStamp, parseTrace, validateProbe, atomicWriteFile, renderHtmlReport,
} from '@octo/core';
import { AppContext } from '@octo/shell/context';
import { acceptLanguages, cleanUserAgent } from '@octo/shell/prepare';
import { ProfileSessionController } from '@octo/shell/session-privacy';
import { tabContents } from '@octo/shell/hardening';
import { windowsSandboxAvailable } from '@octo/shell/winutil';
import { SAFE_WEB_PREFERENCES, assertSafeWebPreferences } from '@octo/shell/security-policy';
import { ProbeServer } from './probe-server';


assertSafeWebPreferences({ ...SAFE_WEB_PREFERENCES, webviewTag: false });
export type AuditTarget = 'baseline' | 'standard' | 'strict' | 'external';

export interface StoredReport extends AuditReport {
  id: string;
  target: AuditTarget;
}

const REPORT_CONTEXT = 'octodetect-report-v1';

export class Auditor {
  private readonly server: ProbeServer;
  private running: { cancel: () => void } | null = null;
  private seq = 0;

  constructor(private readonly ctx: AppContext) {
    this.server = new ProbeServer(path.join(ctx.prep.distDir, 'probe'), ctx.logger);
    ensureDir(ctx.layout.reports);
  }

  stop(): void {
    this.running?.cancel();
    this.server.stop();
  }

  cancel(): void {
    this.running?.cancel();
    this.running = null;
  }

  // ------------------------------------------------------------ environment

  private async environment(target: AuditTarget, profile: Profile | null): Promise<EnvironmentData> {
    const set = this.ctx.settings.load();
    const ses = session.fromPartition(`od-env-${Date.now()}`); // in-memory
    let proxy = 'DIRECT';
    try { proxy = await ses.resolveProxy('https://example.com/'); } catch { /* ignore */ }
    const proxyActive = proxy !== 'DIRECT';
    let publicIp: string | undefined;
    if (set.network.publicIpLookup && !set.offline) {
      try {
        const r = await ses.fetch('https://1.1.1.1/cdn-cgi/trace', { cache: 'no-store', credentials: 'omit' } as RequestInit);
        if (r.ok) publicIp = parseTrace(await r.text()).ip;
      } catch (err) {
        this.ctx.logger.warn('audit.ip-lookup-failed', { error: String(err) });
      }
    }
    const s = profile ? effectiveSettings(profile.protection) : null;
    return {
      publicIp,
      publicIpConsent: set.network.publicIpLookup,
      dnsServers: dns.getServers(),
      dohActive: target !== 'external' && set.network.dns.mode === 'doh',
      proxyActive,
      proxyDescription: proxyActive ? proxy : undefined,
      vpnAdapters: detectVpnAdapters(os.networkInterfaces()),
      torActive: /:(9050|9150)\b/.test(proxy),
      thirdPartyCookies: target === 'external' ? 'unknown' : s?.blockThirdPartyCookies ? 'blocked' : 'allowed',
      windowsSandbox: windowsSandboxAvailable(),
      profileIsolated: target === 'external' ? null : true,
      profileName: target,
      webrtcPolicy: s?.webrtc ?? (target === 'baseline' ? 'default' : undefined),
      httpsOnly: s ? s.httpsOnly : undefined,
    };
  }

  // ------------------------------------------------------------ run

  async run(target: AuditTarget, onProgress: (stage: string) => void): Promise<StoredReport> {
    if (this.running) throw new Error(this.ctx.t('audit.alreadyRunning'));
    this.ctx.logger.info('audit.start', { target });
    const profile = target === 'standard' || target === 'strict' ? { ...defaultProfile('testing', target), protection: { level: target } } as Profile : null;
    onProgress('probe');
    const probe = await this.server.createProbe(this.ctx.lang, target === 'external' ? 10 * 60_000 : 45_000);
    let win: BrowserWindow | null = null;
    this.running = { cancel: () => { probe.cancel(); win?.destroy(); } };
    try {
      if (target === 'external') {
        await shell.openExternal(probe.url);
      } else {
        win = await this.hiddenWindow(profile);
        void win.loadURL(probe.url);
      }
      const raw = await probe.result;
      const data = validateProbe(raw);
      if (target !== 'external') data.rendererSandboxed = true; // our windows always run with sandbox: true
      onProgress('environment');
      const env = await this.environment(target, profile);
      onProgress('report');
      const report: StoredReport = { ...buildReport(data, env), id: `${fileStamp()}-${target}`, target };
      this.save(report);
      this.ctx.logger.info('audit.done', { target, risk: report.risk, score: report.score });
      return report;
    } catch (err) {
      const msg = (err as Error).message;
      this.ctx.logger.warn('audit.failed', { target, error: msg });
      if (msg === 'cancelled') throw new Error(this.ctx.t('audit.cancelled'));
      if (msg === 'timeout') throw new Error(this.ctx.t('audit.timeout'));
      throw err;
    } finally {
      win?.destroy();
      this.running = null;
    }
  }

  private async hiddenWindow(profile: Profile | null): Promise<BrowserWindow> {
    const ses = session.fromPartition(`od-audit-${Date.now()}-${++this.seq}`); // no "persist:" => in-memory
    const s = profile ? effectiveSettings(profile.protection) : null;
    const lang = acceptLanguages(this.ctx.lang);
    if (profile) {
      const ctl = new ProfileSessionController(ses, profile, path.join(this.ctx.layout.temp, 'audit-downloads'), {
        logger: this.ctx.logger,
        adblock: null,
        askPermission: async () => false, // audits never grant permissions
        confirmDangerousDownload: async () => false,
      });
      await ctl.install(cleanUserAgent(app.userAgentFallback), lang);
    } else {
      ses.setUserAgent(cleanUserAgent(app.userAgentFallback), lang);
      ses.setSpellCheckerEnabled(false);
    }
    const cfg = s ? { canvas: s.canvas, hw: s.hardwareApis, hwValues: { hardwareConcurrency: NORMALIZED_HARDWARE.hardwareConcurrency, deviceMemory: NORMALIZED_HARDWARE.deviceMemory }, volume: 0, sinkId: '' } : null;
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: {
        ...SAFE_WEB_PREFERENCES,
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webgl: s ? s.webgl === 'allow' : true,
        spellcheck: false,
        backgroundThrottling: false,
        // The SAME page shim OctoBrowser uses for tabs (built from apps/octobrowser/src/preload/tab.ts).
        preload: cfg ? path.join(this.ctx.prep.distDir, 'preload-shim.js') : undefined,
        additionalArguments: cfg ? [`--octo-cfg=${Buffer.from(JSON.stringify(cfg)).toString('base64')}`] : [],
      },
    });
    const wcId = win.webContents.id;
    tabContents.add(wcId);
    win.webContents.setAudioMuted(true);
    win.webContents.setWebRTCIPHandlingPolicy((s?.webrtc ?? 'default') as 'default');
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => tabContents.delete(wcId));
    return win;
  }

  // ------------------------------------------------------------ storage (encrypted)

  private file(id: string): string {
    if (!/^[0-9A-Za-z_-]{6,80}$/.test(id)) throw new Error('invalid report id');
    return path.join(this.ctx.layout.reports, `${id}.odr`);
  }

  save(r: StoredReport): void {
    const blob = encryptWithKey(this.ctx.keyring.getKey(), Buffer.from(JSON.stringify(r), 'utf8'), REPORT_CONTEXT);
    atomicWriteFile(this.file(r.id), blob);
  }

  list(): Array<Pick<StoredReport, 'id' | 'target' | 'generatedAt' | 'risk' | 'score'>> {
    const out: Array<Pick<StoredReport, 'id' | 'target' | 'generatedAt' | 'risk' | 'score'>> = [];
    for (const f of fs.readdirSync(this.ctx.layout.reports).filter((x) => x.endsWith('.odr')).sort().reverse()) {
      try {
        const r = this.load(f.slice(0, -4));
        out.push({ id: r.id, target: r.target, generatedAt: r.generatedAt, risk: r.risk, score: r.score });
      } catch (err) {
        this.ctx.logger.warn('report.unreadable', { file: f, error: String(err) });
      }
    }
    return out;
  }

  load(id: string): StoredReport {
    const blob = fs.readFileSync(this.file(id));
    return JSON.parse(decryptWithKey(this.ctx.keyring.getKey(), blob, REPORT_CONTEXT).toString('utf8')) as StoredReport;
  }

  remove(id: string): void {
    fs.rmSync(this.file(id), { force: true });
  }

  /** Export as plain JSON or a self-contained HTML file (explicit user action, local file only). */
  exportTo(id: string, file: string, format: 'json' | 'html'): void {
    const r = this.load(id);
    if (format === 'json') {
      atomicWriteFile(file, JSON.stringify(r, null, 2));
      return;
    }
    atomicWriteFile(file, renderHtmlReport(r, (k, p) => this.ctx.t(k, p)));
  }
}

// renderHtmlReport lives in @octo/core (report-html.ts) so it can be unit-tested without Electron.
export { renderHtmlReport };
