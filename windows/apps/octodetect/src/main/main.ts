/**
 * apps/octodetect/src/main/main.ts - entry point of OctoDetect.su.
 *
 * Single-process app: first run / unlock handled by startApp -> main window.
 * Audits run in hidden windows with in-memory sessions or in the
 * user's default browser via a local one-time probe page.
 */
import { app, BrowserWindow, dialog, Menu, powerMonitor, shell, Tray } from 'electron';
import { SAFE_WEB_PREFERENCES, assertSafeWebPreferences } from '@octo/shell/security-policy';
import * as path from 'node:path';
import { APPS, DICTS, SUITE_VERSION, isLang, Lang } from '@octo/core';
import { hasFlag, prepareApp, relaunchArgsWithout, resetPreparedApp } from '@octo/shell/prepare';
import { startApp, AppContext } from '@octo/shell/context';
import { hardenApp } from '@octo/shell/hardening';
import { handle, setTrustedRoot, trustWebContents } from '@octo/shell/ipc';
import { iconPath, THEME } from '@octo/shell/windows-ui';
import { UpdateManager } from '@octo/shell/update-manager';
import { runMasterPasswordUnlock } from '@octo/shell/unlock';
import { findTorBrowser, launchDetached } from '@octo/shell/winutil';
import { Auditor, AuditTarget } from './auditor';
import { runCliVerifyIfRequested } from '@octo/shell/cli-verify';


assertSafeWebPreferences({ ...SAFE_WEB_PREFERENCES, webviewTag: false });
const distDir = __dirname;
setTrustedRoot(distDir);
// Headless release verification for scripts (exits immediately, touches no user data).
const verifyMode = runCliVerifyIfRequested('octodetect');
const factoryReset = !verifyMode && hasFlag('factory-reset');
const prep = verifyMode ? { state: null, layout: null } as unknown as ReturnType<typeof prepareApp> : prepareApp('octodetect', distDir);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let appQuitting = false;
let closePromptOpen = false;

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function ensureTray(ctx: AppContext): void {
  if (tray || process.platform !== 'win32') return;
  tray = new Tray(iconPath(distDir));
  tray.setToolTip('OctoDetect.su');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: ctx.t('appBackground.show'), click: showMainWindow },
    { type: 'separator' },
    { label: ctx.t('appBackground.quit'), click: () => { appQuitting = true; app.quit(); } },
  ]));
  tray.on('click', showMainWindow);
}

function quitApp(): void {
  appQuitting = true;
  tray?.destroy();
  tray = null;
  app.quit();
}

async function decideMainClose(ctx: AppContext, win: BrowserWindow): Promise<void> {
  if (closePromptOpen || appQuitting) return;
  const action = ctx.settings.load().ui.closeAction;
  if (action === 'background') { ensureTray(ctx); win.hide(); return; }
  if (action === 'quit') { quitApp(); return; }
  closePromptOpen = true;
  try {
    const result = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: [ctx.t('appBackground.background'), ctx.t('appBackground.close'), ctx.t('common.cancel')],
      defaultId: 0,
      cancelId: 2,
      checkboxLabel: ctx.t('appBackground.remember'),
      checkboxChecked: false,
      message: ctx.t('appBackground.title'),
      detail: ctx.t('appBackground.desc'),
    });
    const choice = result.response === 0 ? 'background' : result.response === 1 ? 'quit' : 'ask';
    if (result.checkboxChecked && choice !== 'ask') ctx.settings.update((s) => { s.ui.closeAction = choice; });
    if (choice === 'background') { ensureTray(ctx); win.hide(); }
    else if (choice === 'quit') quitApp();
  } finally {
    closePromptOpen = false;
  }
}

function createMainWindow(ctx: AppContext): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: 'OctoDetect.su',
    backgroundColor: THEME.octodetect.bg,
    icon: iconPath(distDir),
    autoHideMenuBar: true,
    webPreferences: {
        ...SAFE_WEB_PREFERENCES,
      preload: path.join(distDir, 'preload-detect.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  trustWebContents(win.webContents);
  win.on('close', (event) => {
    if (appQuitting) return;
    event.preventDefault();
    void decideMainClose(ctx, win);
  });
  win.once('ready-to-show', () => win.show());
  void win.loadFile(path.join(distDir, 'renderer', 'detect.html'));
  win.on('closed', () => { mainWindow = null; });
  ctx.logger.info('window.main-created');
  return win;
}

function registerIpc(ctx: AppContext, auditor: Auditor, updates: UpdateManager): void {
  const L = ctx.logger;
  const send = (ch: string, payload: unknown) => mainWindow?.webContents.send(ch, payload);
  handle('od:init', L, () => ({
    lang: ctx.lang, dicts: DICTS, version: SUITE_VERSION, dataDir: ctx.layout.root, settings: ctx.settings.load(),
    update: updates.getStatus(), logMode: L.getMode(),
    torBrowser: !!findTorBrowser(ctx.settings.load().tor.torBrowserPath),
    keyringMode: ctx.keyring.mode(),
    keyringRequiresPassword: ctx.keyring.requiresPassword(),
    secretBackend: ctx.secretBackend(),
    credmanAvailable: ctx.credmanAvailable(),
  }));
  handle('od:audit', L, async (_e, target: AuditTarget) => {
    if (!['baseline', 'standard', 'strict', 'external'].includes(target)) throw new Error('invalid target');
    return auditor.run(target, (stage) => send('od:progress', stage));
  });
  handle('od:audit-cancel', L, () => { auditor.cancel(); return true; });
  handle('od:reports', L, () => auditor.list());
  handle('od:report', L, (_e, id: string) => auditor.load(String(id)));
  handle('od:report-delete', L, (_e, id: string) => { auditor.remove(String(id)); return true; });
  handle('od:report-export', L, async (e, id: string, format: 'json' | 'html') => {
    const fmt = format === 'html' ? 'html' : 'json';
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const r = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath('documents'), `OctoDetect-${String(id).replace(/[^\w-]/g, '_')}.${fmt}`),
      filters: [{ name: fmt.toUpperCase(), extensions: [fmt] }],
    });
    if (r.canceled || !r.filePath) return false;
    auditor.exportTo(String(id), r.filePath, fmt);
    L.info('report.exported', { format: fmt });
    return true;
  });
  handle('od:settings', L, (_e, patch: { publicIpLookup?: boolean; offline?: boolean; autoCheck?: boolean; backgroundCheck?: boolean; autoLockMinutes?: number }) => {
    const s = ctx.settings.update((st) => {
      if (typeof patch.publicIpLookup === 'boolean') st.network.publicIpLookup = patch.publicIpLookup;
      if (typeof patch.offline === 'boolean') {
        st.offline = patch.offline;
        st.offlineMode = patch.offline ? 'practical' : 'online';
      }
      if (typeof patch.autoCheck === 'boolean') st.updates.autoCheck = patch.autoCheck;
      if (typeof patch.backgroundCheck === 'boolean') st.updates.backgroundCheck = patch.backgroundCheck;
      if (typeof patch.autoLockMinutes === 'number') st.security.autoLockMinutes = patch.autoLockMinutes;
    });
    updates.configureBackground();
    return s;
  });
  handle('od:master-password', L, async (_e, action: 'set' | 'remove', current: string, next: string, repeat: string) => {
    const keyring = ctx.keyring;
    if (action === 'set') {
      const words = typeof next === 'string' ? next.trim().split(/\s+/).filter(Boolean) : [];
      if (words.length < 4 || words.length > 8) throw new Error('sec.lockPhraseInvalid');
      if (next !== repeat) throw new Error('firstRun.err.passwordMismatch');
      await keyring.setPassword(keyring.requiresPassword() ? String(current ?? '') : null, next);
      L.info('keyring.password-set');
    } else {
      if (!keyring.requiresPassword()) return true;
      await keyring.removePassword(String(current ?? ''));
      L.info('keyring.password-removed');
    }
    return true;
  });
  handle('od:lock', L, async () => {
    // Encrypted reports are re-locked by locking the local key; the app then
    // asks for the master password again (with a DPAPI key this is a no-op).
    if (!ctx.keyring.requiresPassword()) return false;
    ctx.keyring.lock();
    L.info('keyring.locked', { reason: 'manual' });
    const ok = await runMasterPasswordUnlock({
      distDir: ctx.prep.distDir,
      appId: 'octodetect',
      productName: ctx.prep.info.productName,
      lang: ctx.lang,
      layout: ctx.layout,
      keyring: ctx.keyring,
      logger: L,
    });
    if (!ok) app.quit();
    return true;
  });
  handle('od:set-language', L, (_e, lang: Lang) => {
    if (!isLang(lang)) throw new Error('invalid language');
    if (!ctx.prep.ephemeral) ctx.prep.store.setLanguage(lang);
    return true;
  });
  handle('od:relaunch', L, () => {
    const relaunchArgs = !app.isPackaged && process.argv.length > 1
      ? { args: process.argv.slice(1) }
      : undefined;
    app.relaunch(relaunchArgs);
    app.quit();
    return true;
  });
  handle('od:factory-reset', L, () => {
    if (ctx.prep.ephemeral) throw new Error(ctx.t('settings.resetUnavailable'));
    auditor.cancel();
    setTimeout(() => {
      app.relaunch({ args: [...process.argv.slice(1), '--factory-reset'] });
      app.quit();
    }, 120);
    return true;
  });
  handle('od:open-folder', L, (_e, which: 'data' | 'logs' | 'reports') => {
    const map = { data: ctx.layout.root, logs: ctx.layout.logs, reports: ctx.layout.reports };
    void shell.openPath(map[which] ?? ctx.layout.root);
    return true;
  });
  handle('od:logs-clear', L, () => L.clear());
  handle('od:log-mode', L, (_e, mode: 'off' | 'standard' | 'diagnostic') => {
    L.setMode(mode === 'off' || mode === 'diagnostic' ? mode : 'standard');
    ctx.settings.update((s) => { s.logs.mode = L.getMode(); });
    if (L.getMode() === 'off') L.clear();
    return L.getMode();
  });
  handle('od:update-check', L, () => updates.check());
  handle('od:update-download', L, () => updates.download());
  handle('od:update-install', L, async () => {
    const st = updates.getStatus();
    if (!st.readyToInstall) throw new Error('installer missing');
    await updates.install(path.join(ctx.layout.updater, 'downloads', path.basename(st.readyToInstall)));
    return true;
  });
  handle('od:update-postpone', L, () => { updates.postpone(24); return true; });
  handle('od:update-rollback', L, (_e, v: string) => updates.rollback(String(v)));
  handle('od:open-browser', L, () => {
    // Launch Octo.su if installed next to OctoDetect.
    const exe = path.join(path.dirname(app.getPath('exe')), '..', 'OctoBrowser', 'Octo.su.exe');
    try { launchDetached(exe); return true; } catch { return false; }
  });
  updates.onStatus((s) => send('od:update-status', s));
}


/** Auto-lock: with a master password the local key is locked after idle time. */
function startAutoLock(ctx: AppContext): void {
  powerMonitor.on('lock-screen', () => {
    if (ctx.keyring.requiresPassword()) {
      ctx.keyring.lock();
      ctx.logger.info('keyring.locked', { reason: 'autolock' });
    }
  });
  setInterval(() => {
    const mins = ctx.settings.load().security.autoLockMinutes;
    if (mins > 0 && ctx.keyring.requiresPassword() && powerMonitor.getSystemIdleTime() >= mins * 60) {
      ctx.keyring.lock();
      ctx.logger.info('keyring.locked', { reason: 'autolock' });
      void runMasterPasswordUnlock({
        distDir: ctx.prep.distDir,
        appId: 'octodetect',
        productName: ctx.prep.info.productName,
        lang: ctx.lang,
        layout: ctx.layout,
        keyring: ctx.keyring,
        logger: ctx.logger,
      }).then((ok) => { if (!ok) app.quit(); });
    }
  }, 30_000).unref?.();
}

if (verifyMode) {
  // app.exit() was already called by runCliVerifyIfRequested - nothing else to do.
} else if (process.platform !== 'win32' || process.arch !== 'x64') {
  app.whenReady().then(() => {
    dialog.showErrorBox('Unsupported system', 'OctoDetect.su requires Windows 10 or 11 on an x86-64 computer.');
    app.exit(2);
  });
} else if (factoryReset) {
  try { resetPreparedApp(prep); } catch (err) { console.error('OctoDetect factory reset failed:', err); }
  app.whenReady().then(() => { app.relaunch({ args: relaunchArgsWithout('factory-reset') }); app.exit(0); });
} else if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  app.whenReady().then(async () => {
    const ctx = await startApp(prep);
    if (!ctx) { app.quit(); return; }
    hardenApp(ctx.logger);
    ctx.layout.ensure(['reports']);
    const auditor = new Auditor(ctx);
    const updates = new UpdateManager(APPS.octodetect, ctx.layout, ctx.settings, ctx.logger, ctx.lang);
    registerIpc(ctx, auditor, updates);
    updates.onAppLaunch();
    startAutoLock(ctx);
    // Build and reveal the real window directly; there is no artificial
    // minimum splash duration in front of an otherwise ready renderer.
    mainWindow = createMainWindow(ctx);
    app.on('before-quit', () => { appQuitting = true; tray?.destroy(); tray = null; auditor.stop(); });
    app.on('window-all-closed', () => app.quit());
  }).catch((err) => {
    const message = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err);
    console.error(message);
    try { dialog.showErrorBox('OctoDetect.su could not start', `${message}\n\nDiagnostic logs are in %LOCALAPPDATA%\\OctoSuite\\logs.`); } catch { /* no display */ }
    app.exit(1);
  });
}
