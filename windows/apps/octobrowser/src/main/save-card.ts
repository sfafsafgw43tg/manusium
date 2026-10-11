/**
 * apps/octobrowser/src/main/save-card.ts
 *
 * The "Save login?" card as its own small always-on-top window.
 *
 * It used to be an overlay drawn inside the browser window. That forced the
 * whole trusted chrome above the page (otherwise the card was covered by the
 * web view), and every click then landed in the chrome - the "site stopped
 * responding" report. A separate window has none of those problems: the page
 * keeps its size, its focus and every click, the card floats above the browser
 * like a real Chrome bubble, and touching the browser dismisses it.
 *
 * The window is deliberately passive: it opens with showInactive() so typing in
 * the page is never interrupted, and losing focus means "not now" - the same as
 * Chrome dismissing its bubble.
 */
import { BaseWindow, ipcMain, screen, WebContentsView } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { trustWebContents } from '@octo/shell/ipc';

export interface SaveCardRequest {
  origin: string;
  username: string;
  password: string;
  /** True when this replaces a stored password instead of adding a new one. */
  update: boolean;
  /** Window the card belongs to; it is placed next to it and dies with it. */
  parent: BaseWindow | null;
  distDir: string;
}

export interface SaveCardAnswer {
  action: 'save' | 'later' | 'never';
  username: string;
  password: string;
}

const CARD_WIDTH = 372;
const CARD_HEIGHT = 322;
/** Below the toolbar, the way Chrome places its bubble. */
const CARD_TOP_OFFSET = 92;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Where the card goes: top-right of the parent window, inside the work area. */
function cardBounds(parent: BaseWindow | null): Electron.Rectangle {
  const alive = parent && !parent.isDestroyed();
  const area = alive ? screen.getDisplayMatching(parent!.getBounds()).workArea : screen.getPrimaryDisplay().workArea;
  const bounds = alive ? parent!.getBounds() : area;
  const x = clamp(bounds.x + bounds.width - CARD_WIDTH - 16, area.x + 8, area.x + area.width - CARD_WIDTH - 8);
  const y = clamp(bounds.y + CARD_TOP_OFFSET, area.y + 8, area.y + area.height - CARD_HEIGHT - 8);
  return { x: Math.round(x), y: Math.round(y), width: CARD_WIDTH, height: CARD_HEIGHT };
}

/**
 * Show the card and resolve once the user answered, dismissed it or the timeout
 * expired. Never throws: a card that cannot open means "later", so the page is
 * not left waiting on a question nobody can see.
 */
export function openSaveCard(request: SaveCardRequest, timeoutMs = 300_000): Promise<SaveCardAnswer> {
  const later = (): SaveCardAnswer => ({ action: 'later', username: request.username, password: request.password });
  const file = path.join(request.distDir, 'renderer', 'save-card.html');
  if (!fs.existsSync(file)) return Promise.resolve(later());
  return new Promise<SaveCardAnswer>((resolve) => {
    let settled = false;
    const win = new BaseWindow({
      ...cardBounds(request.parent),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: true,
      title: 'Octo.su',
    });
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(request.distDir, 'preload-chrome.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
        partition: 'octo-ui',
      },
    });
    trustWebContents(view.webContents);
    win.contentView.addChildView(view);
    const paint = () => view.setBounds({ x: 0, y: 0, width: CARD_WIDTH, height: CARD_HEIGHT });
    paint();
    win.on('resize', paint);

    // Every trusted-UI answer arrives on the chrome preload's ui: namespace. The
    // channel is per-card and the handler only accepts that card's own frame, so
    // a tab cannot answer (or forge) a save question.
    const cardId = view.webContents.id;
    const answerChannel = `ui:save-card-${cardId}`;
    const finish = (answer: SaveCardAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ipcMain.removeHandler(answerChannel); } catch { /* already gone */ }
      try { if (!win.isDestroyed()) win.close(); } catch { /* already closing */ }
      resolve(answer);
    };
    ipcMain.removeHandler(answerChannel);
    ipcMain.handle(answerChannel, (e, payload: Partial<SaveCardAnswer> | undefined) => {
      if (e.sender.id !== cardId) return false;
      const action = payload?.action === 'save' ? 'save' : payload?.action === 'never' ? 'never' : 'later';
      finish({
        action,
        username: String(payload?.username ?? request.username),
        password: String(payload?.password ?? request.password),
      });
      return true;
    });
    const timer = setTimeout(later, timeoutMs);

    win.on('closed', () => finish(later()));
    // Chrome behaves the same way: the bubble belongs to the window it appeared
    // over, and touching that window dismisses it instead of blocking the page.
    win.on('blur', () => finish(later()));
    if (request.parent && !request.parent.isDestroyed()) {
      request.parent.on('focus', () => finish(later()));
      request.parent.once('closed', () => finish(later()));
    }

    view.webContents.loadFile(file).then(() => {
      if (settled || win.isDestroyed()) return;
      view.webContents.send('ui:save-card', {
        origin: request.origin,
        username: request.username,
        password: request.password,
        update: request.update,
        channel: answerChannel,
      });
      // showInactive: the page keeps the keyboard, exactly like Chrome's bubble.
      win.showInactive();
    }, () => finish(later()));
  });
}
