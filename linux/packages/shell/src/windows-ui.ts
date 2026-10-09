/**
 * packages/shell/src/windows-ui.ts
 *
 * Small helper windows shared by both apps: splash screen and the first-run
 * wizard. Both are sandboxed, context-isolated and load local files only.
 */
import { app, BrowserWindow, dialog, nativeTheme } from 'electron';
import * as path from 'node:path';
import { trustWebContents } from './ipc';
import { SAFE_WEB_PREFERENCES, assertSafeWebPreferences } from './security-policy';
import type { AppId } from '@octo/core';


assertSafeWebPreferences({ ...SAFE_WEB_PREFERENCES, webviewTag: false });
export const THEME = {
  octobrowser: { bg: '#1b1b1d', accent: '#2d8cf0' },
  octodetect: { bg: '#1b1b1d', accent: '#2d8cf0' },
} as const;

export function iconPath(distDir: string): string {
  return path.join(distDir, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon-256.png');
}

export function createUtilityWindow(distDir: string, appId: AppId, page: string, opts: { width: number; height: number; frame?: boolean; resizable?: boolean; transparent?: boolean; query?: Record<string, string> }): BrowserWindow {
  nativeTheme.themeSource = 'dark';
  const transparent = opts.transparent === true;
  const win = new BrowserWindow({
    width: opts.width,
    height: opts.height,
    // Size is the page area (title bar excluded), so the layout is identical at every DPI scale.
    useContentSize: true,
    frame: opts.frame ?? true,
    resizable: opts.resizable ?? false,
    transparent,
    hasShadow: transparent,
    show: false,
    backgroundColor: transparent ? '#00000000' : THEME[appId].bg,
    icon: iconPath(distDir),
    autoHideMenuBar: true,
    title: appId === 'octobrowser' ? 'Octo.su' : 'OctoDetect.su',
    webPreferences: {
        ...SAFE_WEB_PREFERENCES,
      preload: path.join(distDir, 'preload-setup.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  trustWebContents(win.webContents);
  const file = path.join(distDir, 'shared', page);
  let loadFailed = false;
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = a deliberate navigation cancellation
    loadFailed = true;
    console.error(`Octo utility page failed to load (${code} ${description}): ${url || file}`);
  });
  // Never reveal Electron's initial about:blank renderer. Show the utility
  // only after its actual local page has loaded and contains the expected UI.
  void win.loadFile(file, { query: { app: appId, ...(opts.query ?? {}) } }).then(async () => {
    if (win.isDestroyed()) return;
    const hasPage = await win.webContents.executeJavaScript(
      `Boolean(document.body && document.body.children.length && document.querySelector('.setup, .unlock, .splash'))`,
      true,
    ).catch(() => false);
    if (loadFailed || !hasPage) throw new Error(`The packaged interface did not render: ${file}`);
    win.show();
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    if (!win.isDestroyed()) {
      win.show();
      try { dialog.showErrorBox('Octo.su interface could not load', `${message}\n\nRepair or reinstall OctoSuite.`); } catch { /* Windows shell unavailable */ }
    }
  });
  return win;
}

/** Frameless splash screen shown while the app initialises. */
export function showSplash(distDir: string, appId: AppId, version: string): BrowserWindow {
  // A tiny transparent gutter lets the CSS surface have genuinely rounded, soft
  // corners on Windows instead of merely drawing a border inside a rectangle.
  return createUtilityWindow(distDir, appId, 'splash.html', { width: 420, height: 280, frame: false, transparent: true, query: { v: version } });
}
