/**
 * packages/shell/src/prepare.ts
 *
 * Must run BEFORE app.whenReady(). Decides where Chromium stores its data:
 *
 *   - First run (no bootstrap.json): Chromium uses a throw-away temp folder
 *     while the first-run wizard asks for the language and the data folder.
 *     After the wizard the app relaunches itself.
 *   - Normal run: Chromium's userData/sessionData = <data folder>\engine,
 *     crash dumps = <data folder>\logs\crashes. Nothing is written to
 *     %APPDATA% except bootstrap.json.
 *   - Windows Sandbox session (--ephemeral-data-dir): data lives inside the
 *     disposable sandbox, bootstrap.json is never written.
 */
import { app } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { APPS, AppId, AppInfo, BootstrapState, BootstrapStore, DataLayout, isLang } from '@octo/core';
import { toSafeChromiumSwitches } from './security-policy';

export interface PreparedApp {
  info: AppInfo;
  store: BootstrapStore;
  state: BootstrapState | null;
  layout: DataLayout | null;
  /** Folder containing the built UI (dist/). */
  distDir: string;
  portable: boolean;
  /** Running as a disposable Windows Sandbox session. */
  ephemeral: boolean;
  firstRunTempDir?: string;
  installDir: string;
}

/** Read "--name=value" from argv. */
export function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

export function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * Bootstrap file location for an app (portable mode = next to the exe).
 *
 * The product was renamed to Octo.su. A machine that still carries the file
 * under the previous name keeps using it, so an upgrade does not silently
 * lose the language and the data folder the user chose.
 */
export function bootstrapFileFor(info: AppInfo, portable: boolean): string {
  const exeDir = path.dirname(app.getPath('exe'));
  if (portable) return path.join(exeDir, `${info.id}.bootstrap.json`);
  const current = path.join(app.getPath('appData'), info.bootstrapDirName, 'bootstrap.json');
  if (fs.existsSync(current) || !info.legacyBootstrapDirName) return current;
  const legacy = path.join(app.getPath('appData'), info.legacyBootstrapDirName, 'bootstrap.json');
  return fs.existsSync(legacy) ? legacy : current;
}

export interface PrepareOptions {
  /** Use a different Chromium userData folder (per-profile browser processes). */
  engineDirFor?: (layout: DataLayout) => string;
  /** Extra Chromium switches decided per process (e.g. WebRTC policy of the profile). */
  extraSwitches?: (layout: DataLayout) => Array<[string, string?]>;
}

export function prepareApp(appId: AppId, distDir: string, opts: PrepareOptions = {}): PreparedApp {
  const info = APPS[appId];
  app.setName(info.productName);
  if (process.platform === 'win32') app.setAppUserModelId(info.appUserModelId);


  const exeDir = path.dirname(app.getPath('exe'));
  const portable = fs.existsSync(path.join(exeDir, 'portable.flag'));
  const store = new BootstrapStore(bootstrapFileFor(info, portable));

  let isVmMode = hasFlag('disable-gpu') || hasFlag('vm-mode') || hasFlag('virtualbox-mode') || process.env.OCTO_VM_MODE === '1';
  let isGraphicsBlocked = false;

  {
    try {
      const bFile = bootstrapFileFor(info, portable);
      if (fs.existsSync(bFile)) {
        const raw = JSON.parse(fs.readFileSync(bFile, 'utf8'));
        if (raw?.dataDir) {
          const setFile = path.join(raw.dataDir, 'config', 'settings.json');
          if (fs.existsSync(setFile)) {
            const setObj = JSON.parse(fs.readFileSync(setFile, 'utf8'));
            isGraphicsBlocked = setObj?.privacyRuntime?.graphicsExposure === 'block';
            if (setObj?.ui?.virtualBoxMode === true || setObj?.ui?.vmMode === true || setObj?.ui?.vmFriendlyMode === true) {
              isVmMode = true;
            }
          }
        }
      }
    } catch {}
  }

  if (isVmMode || isGraphicsBlocked) {
    if (isVmMode) process.env.OCTO_VM_MODE = '1';
    try { app.disableHardwareAcceleration(); } catch {}
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-gpu-compositing');
    app.commandLine.appendSwitch('in-process-gpu');
    if (isVmMode) {
      app.commandLine.appendSwitch('disable-software-rasterizer');
      app.commandLine.appendSwitch('disable-gpu-rasterization');
    }
  }

  // Force the Chromium sandbox for EVERY renderer (UI and web pages).
  app.enableSandbox();

  // Enable WebGPU when not running in software VM mode
  if (!isVmMode) {
    // WebGPU remains native when graphics exposure is native. Never enable
    // unsafe WebGPU or bypass Chromium's GPU blocklist.
  }

  // Privacy-related Chromium switches (no background pings/reporting).
  app.commandLine.appendSwitch('no-pings'); // disable <a ping> hyperlink auditing
  app.commandLine.appendSwitch('disable-domain-reliability');
  app.commandLine.appendSwitch('disable-background-networking');
  const disabledFeatures = ['MediaRouter', 'DialMediaRouteProvider', 'OptimizationHints', 'AutofillServerCommunication', 'Translate', 'InterestFeedContentSuggestions'];
  if (isGraphicsBlocked) disabledFeatures.push('WebGPU');
  app.commandLine.appendSwitch('disable-features', disabledFeatures.join(','));

  let state: BootstrapState | null;
  const ephemeralDir = argValue('ephemeral-data-dir');
  if (ephemeralDir && path.isAbsolute(ephemeralDir)) {
    const lang = argValue('lang-choice');
    state = {
      schema: 1,
      language: isLang(lang) ? lang : 'en',
      baseDir: ephemeralDir,
      dataDir: path.join(ephemeralDir, info.dataSubdir),
      firstRunAt: new Date().toISOString(),
    };
  } else {
    state = store.read();
  }

  let layout: DataLayout | null = null;
  let firstRunTempDir: string | undefined;
  if (state) {
    layout = new DataLayout(state.dataDir);
    layout.ensure(appId === 'octodetect' ? ['reports'] : ['downloads']);
    const engineDir = opts.engineDirFor ? opts.engineDirFor(layout) : layout.engine;
    fs.mkdirSync(engineDir, { recursive: true });
    app.setPath('userData', engineDir);
    app.setPath('sessionData', engineDir);
    for (const [sw, val] of toSafeChromiumSwitches(opts.extraSwitches?.(layout) ?? [])) {
      if (val === undefined) app.commandLine.appendSwitch(sw);
      else app.commandLine.appendSwitch(sw, val);
    }
    app.setPath('crashDumps', path.join(layout.logs, 'crashes'));
    // navigator.language / Accept-Language follow the chosen UI language (fixed, never random).
    app.commandLine.appendSwitch('lang', state.language === 'pl' ? 'pl-PL' : 'en-US');
  } else {
    firstRunTempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${info.id}-firstrun-`));
    app.setPath('userData', firstRunTempDir);
    app.setPath('sessionData', firstRunTempDir);
  }

  return {
    info,
    store,
    state,
    layout,
    distDir,
    portable,
    ephemeral: !!ephemeralDir,
    firstRunTempDir,
    installDir: exeDir,
  };
}

/**
 * Delete all selected data for an app and its tiny AppData bootstrap pointer.
 * Called only during a fresh --factory-reset relaunch, before windows and
 * Chromium sessions are created. The next launch therefore opens first-run.
 */
export function resetPreparedApp(prep: PreparedApp): void {
  if (prep.ephemeral) throw new Error('Cannot reset a disposable sandbox session');
  const dataDir = prep.state?.dataDir;
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  fs.rmSync(prep.store.path, { force: true, maxRetries: 3, retryDelay: 100 });
  // The per-app AppData directory contains only bootstrap.json. Remove it when
  // empty without touching the sibling application’s bootstrap directory.
  try { fs.rmdirSync(path.dirname(prep.store.path)); } catch { /* not empty / portable app */ }
}

/** Remove one internal relaunch flag while retaining Electron's app arguments. */
export function relaunchArgsWithout(flag: string): string[] {
  return process.argv.slice(1).filter((arg) => arg !== `--${flag}`);
}

/** Accept-Language header matching the UI language. Same for all users of a language. */
export function acceptLanguages(lang: 'en' | 'pl'): string {
  // Plain ordered list: Chromium generates the q-weights of the header itself.
  return lang === 'pl' ? 'pl-PL,pl,en-US,en' : 'en-US,en';
}

/**
 * Chromium user agent without "Electron/x" and app tokens, so pages see a
 * regular Chrome-on-Windows UA (reduces uniqueness; no device impersonation -
 * the engine IS Chromium, and version/OS are real).
 */
export function cleanUserAgent(ua: string): string {
  if (!ua) return '';
  return ua
    .replace(/\s?Electron\/[\d.]+/gi, '')
    .replace(/\s?(OctoBrowser(\.su)?|OctoDetect(\.su)?|Octo\.su|OB\.su|OD\.su|octosuite|octobrowser|octodetect)\/[\w.-]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
